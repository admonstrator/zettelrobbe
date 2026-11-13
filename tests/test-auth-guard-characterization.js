'use strict';

/**
 * Characterization of every way the app decides who is calling.
 *
 * Each guard and helper is driven over HTTP (a real Express response, so the
 * Set-Cookie headers are the ones a browser would see) with the same set of
 * credentials: none, the API key right and wrong, the API key unconfigured, a
 * session as cookie and as bearer header, tokens that must not open a session
 * (wrong secret, expired, MFA challenge and setup tokens, another `typ`) and
 * a missing JWT secret. The table below is what the code answers; a change to
 * any cell is a change of behaviour and has to be deliberate.
 *
 * Probes:
 *   isAuthenticated    the route guard routes import from routes/auth.js
 *                      (redirect to /login)
 *   protectApiRoute    middleware/authGate.js, session only (JSON 401/403)
 *   authGate:private   the router-wide guard on a path that is not public
 *   authGate:public    the router-wide guard on /health
 *   hasValidSession    middleware/authGate.js helper (true/false)
 *   isAuthenticatedCaller  middleware/authGate.js helper (true/false)
 *
 * Outcome notation: `pass <req.user>` (next() ran; the user without iat/exp),
 * `302 /login`, `<status> json <body>`, `<status> text <body>`, followed by
 * `+clear` when the response cleared the session cookie with exactly
 * CLEAR_HEADER. Any other Set-Cookie header is spelled out and fails.
 */

const assert = require('assert');
const jwt = require('jsonwebtoken');
const { mountRouter } = require('./helpers/mount-router');

/** The Set-Cookie header of res.clearCookie('jwt') in Express 5. */
const CLEAR_HEADER = 'jwt=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';

const SECRET = 'characterization-secret';
const API_KEY = 'characterization-api-key-0123456789';

const MISCONFIGURED_TEXT =
  '500 text Server misconfiguration: JWT secret missing';
const MISCONFIGURED_JSON =
  '500 json {"message":"Server misconfiguration: JWT secret missing"}';
const REQUIRED_JSON = '401 json {"message":"Authentication required"}';
const INVALID_JSON = '403 json {"message":"Invalid or expired token"}';
const API_KEY_USER = 'pass {"apiKey":true}';
const SESSION_USER = 'pass {"id":1,"username":"admin","typ":"session"}';
const NO_USER = 'pass none';
const TO_LOGIN = '302 /login';
const TO_LOGIN_CLEARED = '302 /login +clear';

const sign = (payload, options = { expiresIn: '1h' }, secret = SECRET) =>
  jwt.sign(payload, secret, options);

const tokens = {
  session: sign({ id: 1, username: 'admin', typ: 'session' }),
  wrongSecret: sign(
    { id: 1, username: 'admin', typ: 'session' },
    { expiresIn: '1h' },
    'some-other-secret'
  ),
  expired: sign(
    {
      id: 1,
      username: 'admin',
      typ: 'session',
      exp: Math.floor(Date.now() / 1000) - 60,
    },
    {}
  ),
  // What POST /login signs between the password and the TOTP step.
  mfaChallenge: sign(
    { id: 1, username: 'admin', challengeType: 'mfa-login' },
    { expiresIn: '5m' }
  ),
  // What POST /api/settings/mfa/setup signs for the enrolment step.
  mfaSetup: sign(
    { username: 'admin', secret: 'JBSWY3DPEHPK3PXP', setupType: 'mfa-setup' },
    { expiresIn: '10m' }
  ),
  otherType: sign({ id: 1, username: 'admin', typ: 'mfa-challenge' }),
};

const cookie = (token) => ({ cookie: `jwt=${token}` });
const bearer = (token) => ({ authorization: `Bearer ${token}` });

/**
 * One expected row. authGate on the public path /health passes every request
 * without looking at it, so that cell is the same in every row.
 */
function row(isAuth, protect, gatePrivate, session, caller) {
  return {
    isAuthenticated: isAuth,
    protectApiRoute: protect,
    'authGate:private': gatePrivate,
    'authGate:public': NO_USER,
    hasValidSession: session,
    isAuthenticatedCaller: caller,
  };
}

/** A token is present but does not open a session. */
const REFUSED_TOKEN = row(
  TO_LOGIN_CLEARED,
  INVALID_JSON,
  TO_LOGIN_CLEARED,
  false,
  false
);

/** No JWT secret: nothing but the API key can be checked. */
const MISCONFIGURED = row(
  MISCONFIGURED_TEXT,
  MISCONFIGURED_JSON,
  MISCONFIGURED_TEXT,
  false,
  false
);

/**
 * One row per request. `env` is applied for the row only; `expect` maps each
 * probe to its outcome.
 */
const SCENARIOS = [
  {
    name: 'no credentials',
    headers: {},
    expect: row(TO_LOGIN, REQUIRED_JSON, TO_LOGIN, false, false),
  },
  {
    name: 'valid API key',
    headers: { 'x-api-key': API_KEY },
    expect: row(API_KEY_USER, REQUIRED_JSON, API_KEY_USER, false, true),
  },
  {
    name: 'valid API key from PAPERLESS_AI_API_KEY',
    env: { API_KEY: '', PAPERLESS_AI_API_KEY: API_KEY },
    headers: { 'x-api-key': API_KEY },
    expect: row(API_KEY_USER, REQUIRED_JSON, API_KEY_USER, false, true),
  },
  {
    name: 'wrong API key',
    headers: { 'x-api-key': 'not-the-key' },
    expect: row(TO_LOGIN, REQUIRED_JSON, TO_LOGIN, false, false),
  },
  {
    name: 'wrong API key of the same length',
    headers: { 'x-api-key': API_KEY.replace(/.$/, 'X') },
    expect: row(TO_LOGIN, REQUIRED_JSON, TO_LOGIN, false, false),
  },
  {
    name: 'API key longer than the configured one',
    headers: { 'x-api-key': `${API_KEY}0` },
    expect: row(TO_LOGIN, REQUIRED_JSON, TO_LOGIN, false, false),
  },
  {
    name: 'API key not configured, any header',
    env: { API_KEY: '' },
    headers: { 'x-api-key': 'anything' },
    expect: row(TO_LOGIN, REQUIRED_JSON, TO_LOGIN, false, false),
  },
  {
    name: 'API key not configured, empty header',
    env: { API_KEY: '' },
    headers: { 'x-api-key': '' },
    expect: row(TO_LOGIN, REQUIRED_JSON, TO_LOGIN, false, false),
  },
  {
    name: 'valid session cookie',
    headers: cookie(tokens.session),
    expect: row(SESSION_USER, SESSION_USER, SESSION_USER, true, true),
  },
  {
    name: 'valid session as bearer header',
    headers: bearer(tokens.session),
    expect: row(SESSION_USER, SESSION_USER, SESSION_USER, true, true),
  },
  {
    // The scheme is not checked: the second word of the header is the token.
    name: 'valid session under another Authorization scheme',
    headers: { authorization: `Basic ${tokens.session}` },
    expect: row(SESSION_USER, SESSION_USER, SESSION_USER, true, true),
  },
  {
    name: 'Authorization header without a scheme',
    headers: { authorization: tokens.session },
    expect: row(TO_LOGIN, REQUIRED_JSON, TO_LOGIN, false, false),
  },
  {
    name: 'token signed with the wrong secret',
    headers: cookie(tokens.wrongSecret),
    expect: REFUSED_TOKEN,
  },
  {
    name: 'expired token',
    headers: cookie(tokens.expired),
    expect: REFUSED_TOKEN,
  },
  {
    name: 'MFA login challenge token as cookie',
    headers: cookie(tokens.mfaChallenge),
    expect: REFUSED_TOKEN,
  },
  {
    // A bearer token is refused the same way, and the cookie is cleared too.
    name: 'MFA setup token as bearer header',
    headers: bearer(tokens.mfaSetup),
    expect: REFUSED_TOKEN,
  },
  {
    name: "token with typ 'mfa-challenge'",
    headers: cookie(tokens.otherType),
    expect: REFUSED_TOKEN,
  },
  {
    // The cookie wins over the header, even when only the header is valid.
    name: 'invalid cookie and a valid bearer header',
    headers: { ...cookie(tokens.wrongSecret), ...bearer(tokens.session) },
    expect: REFUSED_TOKEN,
  },
  {
    // The API key wins; only the session-only guard looks at the token.
    name: 'valid API key and an invalid cookie',
    headers: { 'x-api-key': API_KEY, ...cookie(tokens.wrongSecret) },
    expect: row(API_KEY_USER, INVALID_JSON, API_KEY_USER, false, true),
  },
  {
    name: 'no JWT secret, no credentials',
    env: { JWT_SECRET: '' },
    headers: {},
    expect: MISCONFIGURED,
  },
  {
    name: 'no JWT secret, valid session cookie',
    env: { JWT_SECRET: '' },
    headers: cookie(tokens.session),
    expect: MISCONFIGURED,
  },
  {
    // The API key is checked before the secret is needed.
    name: 'no JWT secret, valid API key',
    env: { JWT_SECRET: '' },
    headers: { 'x-api-key': API_KEY },
    expect: row(API_KEY_USER, MISCONFIGURED_JSON, API_KEY_USER, false, true),
  },
];

const PROBES = [
  'isAuthenticated',
  'protectApiRoute',
  'authGate:private',
  'authGate:public',
  'hasValidSession',
  'isAuthenticatedCaller',
];

const BASE_ENV = {
  JWT_SECRET: SECRET,
  API_KEY,
  PAPERLESS_AI_API_KEY: '',
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

function setCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/** Turns a probe response into the outcome notation of the table. */
async function describe(response) {
  const text = await response.text();
  const type = response.headers.get('content-type') || '';
  let outcome;
  if (response.status === 200 && text.startsWith('{"probe":')) {
    const { user } = JSON.parse(text);
    if (user === null) {
      outcome = 'pass none';
    } else {
      const { iat, exp, ...rest } = user;
      assert.ok(
        !rest.typ || (iat && exp),
        'a session user keeps its iat and exp claims'
      );
      outcome = `pass ${JSON.stringify(rest)}`;
    }
  } else if (response.status >= 300 && response.status < 400) {
    outcome = `${response.status} ${response.headers.get('location')}`;
  } else if (type.includes('application/json')) {
    outcome = `${response.status} json ${text}`;
  } else {
    outcome = `${response.status} text ${text}`;
  }

  const cookies = setCookies(response);
  if (cookies.length === 1 && cookies[0] === CLEAR_HEADER) {
    outcome += ' +clear';
  } else if (cookies.length > 0) {
    outcome += ` +set-cookie ${JSON.stringify(cookies)}`;
  }
  return outcome;
}

(async () => {
  const harness = await mountRouter({ env: BASE_ENV });
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const { isAuthenticated } = require('../routes/auth');
  const {
    authGate,
    protectApiRoute,
    hasValidSession,
    isAuthenticatedCaller,
  } = require('../middleware/authGate');

  const probe = (req, res) =>
    res.json({ probe: true, user: req.user === undefined ? null : req.user });

  // Route guards and helpers, without a router-wide guard in front.
  const direct = express();
  direct.use(cookieParser());
  direct.get('/isAuthenticated', isAuthenticated, probe);
  direct.get('/protectApiRoute', protectApiRoute, probe);
  direct.get('/helpers', (req, res) =>
    res.json({
      hasValidSession: hasValidSession(req),
      isAuthenticatedCaller: isAuthenticatedCaller(req),
    })
  );

  // The router-wide guard, applied pathless as routes/index.js does.
  const gated = express();
  gated.use(cookieParser());
  gated.use(authGate);
  gated.get('/private', probe);
  gated.get('/health', probe);

  const listen = (app) =>
    new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
  const directServer = await listen(direct);
  const gatedServer = await listen(gated);
  const directBase = `http://127.0.0.1:${directServer.address().port}`;
  const gatedBase = `http://127.0.0.1:${gatedServer.address().port}`;

  const get = (url, headers) => fetch(url, { headers, redirect: 'manual' });

  /** Observes every probe for one scenario. */
  async function observe(headers) {
    const observed = {};
    for (const name of ['isAuthenticated', 'protectApiRoute']) {
      observed[name] = await describe(
        await get(`${directBase}/${name}`, headers)
      );
    }
    observed['authGate:private'] = await describe(
      await get(`${gatedBase}/private`, headers)
    );
    observed['authGate:public'] = await describe(
      await get(`${gatedBase}/health`, headers)
    );
    const helpers = await (await get(`${directBase}/helpers`, headers)).json();
    observed.hasValidSession = helpers.hasValidSession;
    observed.isAuthenticatedCaller = helpers.isAuthenticatedCaller;
    return observed;
  }

  const printOnly = process.argv.includes('--print');
  const printed = [];

  for (const scenario of SCENARIOS) {
    const saved = {};
    for (const [key, value] of Object.entries(scenario.env || {})) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const observed = await observe(scenario.headers);
      if (printOnly) {
        printed.push({ name: scenario.name, observed });
        continue;
      }
      for (const probeName of PROBES) {
        await test(`${probeName}: ${scenario.name}`, () => {
          assert.deepStrictEqual(
            observed[probeName],
            scenario.expect[probeName]
          );
        });
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  if (printOnly) {
    console.log(JSON.stringify(printed, null, 2));
  }

  await new Promise((resolve) => directServer.close(resolve));
  await new Promise((resolve) => gatedServer.close(resolve));
  await harness.close();

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error('❌  Fatal error:', error);
  process.exit(1);
});
