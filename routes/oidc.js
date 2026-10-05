const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const documentModel = require('../models/document');
const oidcService = require('../services/oidcService');
const { SESSION_TOKEN_TYPE } = require('./auth');

// Holds state, nonce and PKCE verifier between the redirect to the provider
// and the callback. Signed like the MFA challenge, with its own type claim so
// it can never pass for a session and a session can never pass for it.
const OIDC_TRANSACTION_COOKIE = 'zr_oidc_tx';
const OIDC_TRANSACTION_TYPE = 'oidc-login';
const OIDC_TRANSACTION_TTL_SECONDS = 10 * 60;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function shouldUseSecureCookies(req) {
  const mode = config.getCookieSecureMode();
  if (mode === 'always') return true;
  if (mode === 'never') return false;

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return Boolean(req.secure || forwardedProto === 'https');
}

function renderLoginError(res, status, error) {
  return res.status(status).render('login', {
    error,
    mfaRequired: false,
    username: '',
    sso: oidcService.getLoginButton(),
  });
}

// Same budget as the password form: both start a sign-in.
const oidcLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    renderLoginError(
      res,
      429,
      'Too many login attempts. Please wait a few minutes and try again.'
    ),
});

/**
 * @swagger
 * /auth/oidc/login:
 *   get:
 *     summary: Start single sign-on with the configured OpenID Connect provider
 *     description: |
 *       Redirects the browser to the identity provider's authorization endpoint
 *       (authorization code flow with PKCE, state and nonce). Only available when
 *       OIDC_ENABLED=yes and OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_ADMIN_EMAIL
 *       are set.
 *     tags:
 *       - Authentication
 *     responses:
 *       302:
 *         description: Redirect to the identity provider
 *       404:
 *         description: Single sign-on is not enabled
 *       502:
 *         description: The identity provider could not be reached; the login page is rendered with an error
 */
router.get('/auth/oidc/login', oidcLimiter, async (req, res) => {
  if (!oidcService.isEnabled()) {
    return res.status(404).send('Single sign-on is not enabled');
  }

  const jwtSecret = config.getJwtSecret();
  if (!jwtSecret) {
    return res.status(500).send('Server misconfiguration: JWT secret missing');
  }

  try {
    const { url, transaction } = await oidcService.startLogin(req);
    const transactionToken = jwt.sign(
      { challengeType: OIDC_TRANSACTION_TYPE, ...transaction },
      jwtSecret,
      { expiresIn: OIDC_TRANSACTION_TTL_SECONDS }
    );
    // SameSite=Lax: the provider sends the browser back with a top-level GET,
    // which carries Lax cookies.
    res.cookie(OIDC_TRANSACTION_COOKIE, transactionToken, {
      httpOnly: true,
      secure: shouldUseSecureCookies(req),
      sameSite: 'lax',
      path: '/',
      maxAge: OIDC_TRANSACTION_TTL_SECONDS * 1000,
    });
    return res.redirect(url);
  } catch (error) {
    console.error('[ERROR] OIDC login could not start:', error.message);
    return renderLoginError(
      res,
      502,
      'Single sign-on is unavailable: the identity provider could not be reached. Check OIDC_ISSUER_URL.'
    );
  }
});

/**
 * @swagger
 * /auth/oidc/callback:
 *   get:
 *     summary: Complete single sign-on
 *     description: |
 *       Redirect target registered with the identity provider. Exchanges the
 *       authorization code, validates the ID token and signs in as the
 *       administrator account when the identity's e-mail address equals
 *       OIDC_ADMIN_EMAIL. Sets the session cookie.
 *     tags:
 *       - Authentication
 *     parameters:
 *       - in: query
 *         name: code
 *         schema:
 *           type: string
 *         description: Authorization code issued by the provider
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: State value echoed back by the provider
 *     responses:
 *       302:
 *         description: Signed in, redirected to the dashboard
 *         headers:
 *           Set-Cookie:
 *             schema:
 *               type: string
 *               description: HTTP-only cookie containing the session JWT
 *       400:
 *         description: Missing or expired sign-in transaction, or the provider reported an error
 *       403:
 *         description: The identity's e-mail address does not match OIDC_ADMIN_EMAIL
 *       404:
 *         description: Single sign-on is not enabled
 */
router.get('/auth/oidc/callback', oidcLimiter, async (req, res) => {
  if (!oidcService.isEnabled()) {
    return res.status(404).send('Single sign-on is not enabled');
  }

  const jwtSecret = config.getJwtSecret();
  if (!jwtSecret) {
    return res.status(500).send('Server misconfiguration: JWT secret missing');
  }

  const transactionToken = req.cookies?.[OIDC_TRANSACTION_COOKIE];
  res.clearCookie(OIDC_TRANSACTION_COOKIE, { path: '/' });

  let transaction;
  try {
    transaction = jwt.verify(transactionToken || '', jwtSecret);
    if (transaction.challengeType !== OIDC_TRANSACTION_TYPE) {
      throw new Error('Invalid transaction type');
    }
  } catch {
    return renderLoginError(
      res,
      400,
      'Your single sign-on session expired. Please try again.'
    );
  }

  const query = new URLSearchParams(req.originalUrl.split('?')[1] || '');

  let claims;
  try {
    claims = await oidcService.completeLogin(query, transaction);
  } catch (error) {
    console.error('[ERROR] OIDC callback failed:', error.message);
    return renderLoginError(
      res,
      400,
      'Single sign-on failed. Please try again or sign in with your password.'
    );
  }

  try {
    const users = await documentModel.getUsers();
    const { user, error, email } = oidcService.authorize(claims, users);

    if (!user) {
      console.warn(
        '[FAILED LOGIN] OIDC sign-in refused for %s: %s',
        email || '(no e-mail claim)',
        error
      );
      return renderLoginError(res, 403, error);
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        typ: SESSION_TOKEN_TYPE,
      },
      jwtSecret,
      { expiresIn: '24h' }
    );
    res.cookie('jwt', token, {
      httpOnly: true,
      secure: shouldUseSecureCookies(req),
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });

    console.log('[LOGIN] OIDC sign-in for user:', user.username);
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('[ERROR] OIDC sign-in error:', error);
    return renderLoginError(res, 500, 'An error occurred during login');
  }
});

module.exports = router;
module.exports.OIDC_TRANSACTION_COOKIE = OIDC_TRANSACTION_COOKIE;
