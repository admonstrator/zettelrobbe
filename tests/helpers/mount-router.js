'use strict';

/**
 * Test harness that mounts the route layer (routes/tidyUp.js, then
 * routes/index.js with its feature routers) on an Express app backed by a
 * throwaway SQLite database, with every Paperless-ngx network call stubbed.
 *
 * Why this exists: the route modules read process.cwd() and process.env at
 * require time (models/document.js opens data/documents.db relative to cwd,
 * config/config.js snapshots the environment), so a test that wants real
 * routes must set both up before the first require. This helper does that
 * once, in the right order, and hands back the mounted app plus the loaded
 * singletons so a test can stub or inspect them.
 *
 * Usage:
 *   const { mountRouter } = require('./helpers/mount-router');
 *   const h = await mountRouter({ env: { API_KEY: 'k' } });
 *   const res = await fetch(h.base + '/api/history', { headers: { 'x-api-key': 'k' } });
 *   await h.close();
 *
 * Nothing here talks to the network: paperlessService.client is replaced by a
 * stub that rejects, and the commonly used high-level methods return empty
 * results unless the test overrides them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Request header that makes the harness skip its automatic sign-in for one request. */
const ANONYMOUS_HEADER = 'x-harness-anonymous';

/** What server.js's locals middleware sets for the page shell (theme, footer, about dialog). */
const SHELL_LOCALS = {
  theme: 'light',
  appVersion: 'test',
  appCommitSha: 'unknown',
  appPaperlessNgxVersion: 'unknown',
  appAiProvider: 'openai',
  appOcrEnabled: false,
  appOcrProvider: 'mistral',
  appNodeEnv: 'test',
  appNodeVersion: process.version,
  appPlatform: `${process.platform} (${process.arch})`,
  appServerTimeUtc: '2000-01-01T00:00:00.000Z',
  appServerTimezone: 'UTC',
  appDateFormat: 'DD.MM.YYYY',
  appPaperlessApiUrl: 'unknown',
  appOllamaApiUrl: 'unknown',
  appOllamaModel: 'unknown',
  appCustomBaseUrl: 'unknown',
  appCustomModel: 'unknown',
  appAzureEndpoint: 'unknown',
  appAzureDeploymentName: 'unknown',
  appAzureApiVersion: 'unknown',
  appAnthropicModel: 'unknown',
  appAnthropicApiUrl: 'default',
  appMistralOcrModel: 'unknown',
  appScanInterval: 'unknown',
  appTokenLimit: 'unknown',
  appResponseTokens: 'unknown',
  appTrustProxy: 'false',
  appUseExistingData: 'no',
  appRestrictTags: 'no',
  appRestrictCorrespondents: 'no',
  appRestrictDocumentTypes: 'no',
  appPaperlessTokenSet: false,
  appOpenAiKeySet: false,
  appCustomKeySet: false,
  appAzureKeySet: false,
  appAnthropicKeySet: false,
  appMistralKeySet: false,
  appApiKeySet: false,
  loginCookieSecurityWarning: null,
};

const DEFAULT_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-jwt-secret-for-router-harness',
  API_KEY: 'test-api-key',
  PAPERLESS_API_URL: 'http://127.0.0.1:9/api',
  PAPERLESS_API_TOKEN: 'test-paperless-token',
  AI_PROVIDER: 'openai',
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_MODEL: 'gpt-4o-mini',
  DISABLE_AUTOMATIC_PROCESSING: 'yes',
  OCR_AUTO_PROCESS_ENABLED: 'no',
  RECONCILIATION_ENABLED: 'no',
  CONFIG_SOURCE_MODE: 'runtime-first',
};

/**
 * Creates the temp working directory, points cwd and env at it, loads the
 * application modules and mounts the router.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.env] - environment overrides applied before the modules load
 * @param {boolean} [options.configured=true] - what setupService.isConfigured() should report
 * @param {object|null} [options.user] - signs in as this user. A real session JWT (same secret and
 *   `typ: 'session'` claim a login issues) is attached to every request that carries no credentials
 *   of its own (no jwt cookie, no Authorization header, no x-api-key), so the router-wide guard and
 *   every route guard accept it exactly like a browser session. req.user is also pre-set for code
 *   that reads it before a guard ran. Pass null to let the router's own authentication decide
 *   (the default): requests are then anonymous unless the test sends credentials itself.
 * @param {(services: object) => void} [options.stub] - hook to override service methods before the router loads
 * @returns {Promise<{app, base, server, tmpDir, documentModel, paperlessService, setupService, router, routers: object[],
 *   sessionToken: string|null, sessionCookie: string|null,
 *   authHeaders: (extra?: Record<string, string>) => Record<string, string>,
 *   apiKeyHeaders: (extra?: Record<string, string>) => Record<string, string>,
 *   anonymousHeaders: (extra?: Record<string, string>) => Record<string, string>,
 *   close: () => Promise<void>}>}
 *   router is routes/index.js (the guards, then the feature routers nested in it); routers lists
 *   every router the harness mounted directly, in mount order. sessionToken / sessionCookie are
 *   null unless options.user was given; authHeaders() then throws, so a test cannot silently run
 *   anonymous when it meant to be signed in.
 */
async function mountRouter(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-router-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  for (const dir of ['config', 'public', 'views']) {
    fs.symlinkSync(path.join(REPO_ROOT, dir), path.join(tmpDir, dir), 'dir');
  }

  const previousCwd = process.cwd();
  process.chdir(tmpDir);
  Object.assign(process.env, DEFAULT_ENV, options.env || {});

  // Module cache: a second mountRouter() in the same process would otherwise
  // reuse the first temp database. Tests normally mount once per process.
  const express = require(path.join(REPO_ROOT, 'node_modules', 'express'));
  const cookieParser = require(
    path.join(REPO_ROOT, 'node_modules', 'cookie-parser')
  );
  const jwt = require(path.join(REPO_ROOT, 'node_modules', 'jsonwebtoken'));
  const { SESSION_TOKEN_TYPE } = require(
    path.join(REPO_ROOT, 'routes', 'auth.js')
  );

  const paperlessService = require(
    path.join(REPO_ROOT, 'services', 'paperlessService.js')
  );
  stubPaperless(paperlessService);

  const setupService = require(
    path.join(REPO_ROOT, 'services', 'setupService.js')
  );
  const configured = options.configured !== false;
  setupService.isConfigured = async () => configured;

  const documentModel = require(path.join(REPO_ROOT, 'models', 'document.js'));

  if (typeof options.stub === 'function') {
    options.stub({ paperlessService, setupService, documentModel });
  }

  const router = require(path.join(REPO_ROOT, 'routes', 'index.js'));
  const tidyUpRouter = require(path.join(REPO_ROOT, 'routes', 'tidyUp.js'));

  const app = express();
  app.set('query parser', 'extended'); // same as server.js
  app.set('view engine', 'ejs');
  app.set('views', path.join(REPO_ROOT, 'views'));
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  // server.js puts the shell's locals on every response; without them no real
  // page (GET /history, ...) renders in here. Fixed values, not the real
  // config: a page test cares that it renders, not what the footer says.
  app.use((_req, res, next) => {
    Object.assign(res.locals, SHELL_LOCALS);
    next();
  });

  // Same payload POST /login signs (id, username, typ), plus whatever else the
  // caller put on the user object, so a test can add claims.
  const signedInUser =
    options.user !== undefined && options.user !== null ? options.user : null;
  let sessionToken = null;
  if (signedInUser) {
    sessionToken = jwt.sign(
      { id: 1, ...signedInUser, typ: SESSION_TOKEN_TYPE },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    app.use((req, _res, next) => {
      const ownCredentials =
        req.cookies.jwt ||
        req.headers.authorization ||
        req.headers['x-api-key'];
      if (req.headers[ANONYMOUS_HEADER]) {
        // Explicit opt-out: this one request is anonymous although the harness
        // has a user. The router sees no credentials and no pre-set req.user.
        return next();
      }
      if (!ownCredentials) {
        req.cookies.jwt = sessionToken;
      }
      req.user = signedInUser;
      next();
    });
  }
  const routers = [tidyUpRouter, router];
  routers.forEach((r) => app.use(r));
  // Express recognises error middleware by its arity, so the fourth parameter must stay.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(500).json({ harnessCaughtError: String(err && err.message) });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const sessionCookie = sessionToken ? `jwt=${sessionToken}` : null;

  /** Request headers for a signed-in call; throws when mountRouter had no user. */
  function authHeaders(extra = {}) {
    if (!sessionCookie) {
      throw new Error(
        'authHeaders() needs mountRouter({ user }): no session was issued'
      );
    }
    return { cookie: sessionCookie, ...extra };
  }

  /** Request headers for one anonymous call on a harness that has a user. */
  function anonymousHeaders(extra = {}) {
    return { [ANONYMOUS_HEADER]: '1', ...extra };
  }

  /** Request headers that authenticate with the API key the harness runs with. */
  function apiKeyHeaders(extra = {}) {
    return { 'x-api-key': process.env.API_KEY, ...extra };
  }

  return {
    app,
    base,
    server,
    tmpDir,
    documentModel,
    paperlessService,
    setupService,
    router,
    routers,
    sessionToken,
    sessionCookie,
    authHeaders,
    apiKeyHeaders,
    anonymousHeaders,
    close,
  };
}

/**
 * Replaces every network-facing method of paperlessService with an inert
 * default. Tests override the ones they care about.
 */
function stubPaperless(paperlessService) {
  const rejectNetwork = async () => {
    throw new Error('network disabled in router harness');
  };
  paperlessService.client = {
    get: rejectNetwork,
    post: rejectNetwork,
    patch: rejectNetwork,
    put: rejectNetwork,
    delete: rejectNetwork,
  };
  paperlessService.getTags = async () => [];
  paperlessService.getDocument = async () => null;
  paperlessService.getAllDocuments = async () => [];
  paperlessService.getDocumentContent = async () => '';
  paperlessService.getThumbnailImage = async () => null;
  paperlessService.updateDocument = async () => null;
  paperlessService.checkConnection = async () => ({
    reachable: true,
    authorized: true,
  });
  paperlessService.listCorrespondentsNames = async () => [];
  paperlessService.listTagNames = async () => [];
  paperlessService.getPublicBaseUrl = async () => 'http://paperless.test';
  // Kind-neutral entity access behind the Duplicates page. These throw in the
  // real service when Paperless-ngx is unreachable, so the harness answers
  // "nothing there" instead — a test that wants data overrides them.
  paperlessService.listEntities = async () => [];
  paperlessService.getEntity = async () => null;
  paperlessService.findEntityByExactName = async () => null;
  paperlessService.createEntity = async () => null;
  paperlessService.updateEntity = async () => null;
  paperlessService.deleteEntity = async () => false;
  paperlessService.getDocumentIdsByEntity = async () => [];
  paperlessService.getDocumentsByIds = async () => [];
  paperlessService.bulkEditDocuments = async () => ({ edited: 0 });
  paperlessService.clearEntityCaches = () => {};
  // Context for the AI review. Inert here: the real ones answer [] on every
  // problem anyway, so a harness without documents says the same thing.
  paperlessService.getRecentDocumentTitlesByEntity = async () => [];
  paperlessService.getRecentDocumentExcerptsByEntity = async () => [];
  paperlessService.getEntityNeighbourhood = async () => [];
}

module.exports = { mountRouter, DEFAULT_ENV, REPO_ROOT, ANONYMOUS_HEADER };
