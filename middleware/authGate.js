// @ts-check
'use strict';

/**
 * The guards in front of every page and API route, and the small checks that
 * routes the guards let through use to find out who is calling.
 *
 * remoteSetupGuard and authGate are pathless: routes/index.js applies them
 * with router.use(), so they run for every request that reaches that router,
 * including the server.js routes mounted after it.
 *
 * Who is calling is decided in one place, resolveCaller() in
 * middleware/caller.js. Each guard below is that answer plus a declared
 * policy (POLICIES): which callers it accepts and how it refuses the rest.
 *
 *   guard            API key  session  refusal
 *   authGate         yes      yes      redirect /login, clears a bad cookie
 *   isAuthenticated  yes      yes      redirect /login, clears a bad cookie
 *   protectApiRoute  no       yes      JSON 401 / 403, cookie kept
 *
 * Without a JWT secret the redirect guards answer 500 text and the JSON guard
 * 500 JSON; an accepted API key needs no secret.
 */

const setupService = require('../services/setupService.js');
const { admit, resolveCaller } = require('./caller');
const { hasAnyUser, isInitialSetupOpen } = require('../services/userPresence');

/**
 * The declared policies of the guards (see the table above).
 *
 * @type {Readonly<Record<'page' | 'sessionApi', import('./caller').CallerPolicy>>}
 */
const POLICIES = Object.freeze({
  /** A page or API route: the API key or a session; else to /login. */
  page: Object.freeze({
    acceptApiKey: true,
    refuse: 'redirect',
    clearInvalidSession: true,
  }),
  /** A session only, never the API key; refused with JSON. */
  sessionApi: Object.freeze({
    acceptApiKey: false,
    refuse: 'json',
    clearInvalidSession: false,
  }),
});

/**
 * Routes that don't require authentication. /auth/oidc is served by
 * routes/oidc.js, mounted ahead of this router; it is listed so the sign-in
 * callback stays reachable whatever the mount order.
 *
 * Each entry covers itself and everything below it (see isPublicPath()).
 */
const PUBLIC_ROUTES = Object.freeze([
  '/health',
  '/login',
  '/logout',
  '/setup',
  '/api/setup',
  '/auth/oidc',
]);

/**
 * True when the path is one of PUBLIC_ROUTES or lies below one of them.
 * Matches whole path segments: /setup and /setup/step are public, /setupfoo
 * and /login-history are not.
 *
 * @param {string} requestPath - req.path
 * @returns {boolean}
 */
function isPublicPath(requestPath) {
  const value = String(requestPath || '');
  return PUBLIC_ROUTES.some(
    (route) => value === route || value.startsWith(`${route}/`)
  );
}

/**
 * Returns true if the incoming request originates from localhost.
 * Uses req.socket.remoteAddress (direct TCP connection IP) rather than
 * req.ip to remain resistant to X-Forwarded-For spoofing even when
 * trust proxy is enabled.
 *
 * @param {{ socket?: { remoteAddress?: string|null } }} req
 * @returns {boolean}
 */
function isLocalRequest(req) {
  const remoteAddr = req.socket?.remoteAddress;
  if (!remoteAddr) {
    return false;
  }

  return (
    remoteAddr === '127.0.0.1' ||
    remoteAddr === '::1' ||
    remoteAddr === '::ffff:127.0.0.1'
  );
}

/**
 * SECURITY GUARD: Blocks remote access to setup endpoints while the
 * initial setup is still pending (CWE-306 / GHSA-v4jq-65q5-wgjp).
 *
 * Rules (evaluated in order):
 *  1. Non-setup paths pass through unconditionally.
 *  2. Once setup is complete, the guard is lifted unconditionally.
 *  3. ALLOW_REMOTE_SETUP=yes grants explicit opt-in for remote access.
 *  4. Requests from localhost are always allowed.
 *  5. All other remote requests receive HTTP 403.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
async function remoteSetupGuard(req, res, next) {
  const isSetupPath =
    req.path === '/setup' ||
    req.path.startsWith('/setup/') ||
    req.path.startsWith('/api/setup');

  if (!isSetupPath) {
    return next();
  }

  try {
    const setupOpen = await isInitialSetupOpen();
    if (!setupOpen) {
      // Setup already complete — no restriction needed
      return next();
    }
  } catch {
    // Fail-open here: let the next middleware handle setup-state errors
    return next();
  }

  if (process.env.ALLOW_REMOTE_SETUP === 'yes') {
    return next();
  }

  if (isLocalRequest(req)) {
    return next();
  }

  // Remote client on an open fresh instance — block
  const isApiPath = req.path.startsWith('/api/setup');
  if (isApiPath) {
    res.status(403).json({
      success: false,
      error:
        'Remote access to the setup API is disabled. ' +
        'Set ALLOW_REMOTE_SETUP=yes to enable it, or complete setup from localhost.',
    });
    return;
  }

  res
    .status(403)
    .type('text/html')
    .send(
      '<html><head><title>Setup Restricted</title></head><body>' +
        '<h1>403 – Remote Setup Access Denied</h1>' +
        '<p>Initial setup is only accessible from localhost by default.</p>' +
        '<p>Set <code>ALLOW_REMOTE_SETUP=yes</code> to enable remote access, ' +
        'or connect from the machine running zettelrobbe.</p>' +
        '</body></html>'
    );
}

/**
 * Combined middleware to check authentication and setup. Public paths pass;
 * everything else needs the API key or a session token, and is sent to the
 * wizard or the settings page while the configuration is incomplete.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
async function authGate(req, res, next) {
  if (isPublicPath(req.path)) {
    return next();
  }

  if (!admit(req, res, POLICIES.page)) {
    return;
  }

  // Setup check
  try {
    const isConfigured = await setupService.isConfigured();

    if (!isConfigured) {
      // The wizard is only for an empty instance. Once an administrator
      // exists, an incomplete configuration is an administration job, so send
      // the signed-in user to /settings instead of to the closed wizard —
      // PAPERLESS_AI_INITIAL_SETUP=yes has always done exactly that.
      const hasUsers = await hasAnyUser();

      if (hasUsers || process.env.PAPERLESS_AI_INITIAL_SETUP === 'yes') {
        if (!req.path.startsWith('/settings')) {
          return res.redirect('/settings');
        }
      } else if (!req.path.startsWith('/setup')) {
        return res.redirect('/setup');
      }
    }
  } catch (error) {
    console.error('Error checking setup configuration:', error);
    res.status(500).send('Internal Server Error');
    return;
  }

  next();
}

/**
 * Route guard: the API key or a session; anyone else is sent to /login (the
 * page policy). Re-exported by routes/auth.js, where routes import it from.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function isAuthenticated(req, res, next) {
  if (admit(req, res, POLICIES.page)) {
    next();
  }
}

/**
 * Protected route middleware for API endpoints: a session token only (no API
 * key), answered with JSON 401/403 instead of a redirect.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function protectApiRoute(req, res, next) {
  if (admit(req, res, POLICIES.sessionApi)) {
    next();
  }
}

/**
 * True when the request carries a usable session token. For public routes such
 * as /setup, which run before any guard has looked at the request and therefore
 * never see req.user.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function hasValidSession(req) {
  return resolveCaller(req, { apiKey: false }).kind === 'session';
}

/**
 * True when a public route is called with a usable session or the API key.
 * Like hasValidSession(), for routes the authentication guard lets through.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isAuthenticatedCaller(req) {
  const { kind } = resolveCaller(req);
  return kind === 'apiKey' || kind === 'session';
}

/**
 * The username of the signed-in person, or null for an API-key caller or a
 * request without a user.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getAuthenticatedSettingsUsername(req) {
  /** @type {any} */
  const user = /** @type {any} */ (req).user;
  if (!user || user.apiKey) {
    return null;
  }

  if (typeof user.username === 'string' && user.username.trim()) {
    return user.username.trim();
  }

  return null;
}

module.exports = {
  PUBLIC_ROUTES,
  isPublicPath,
  isLocalRequest,
  remoteSetupGuard,
  authGate,
  isAuthenticated,
  protectApiRoute,
  POLICIES,
  hasValidSession,
  isAuthenticatedCaller,
  getAuthenticatedSettingsUsername,
};
