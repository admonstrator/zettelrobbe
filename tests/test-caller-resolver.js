'use strict';

/**
 * middleware/caller.js is the one place that decides who is calling. The
 * guards built on it are characterized over HTTP by
 * test-auth-guard-characterization; this test covers the resolver itself:
 *
 *   1. resolveCaller() returns each kind, and ignores the API key on request;
 *   2. the API key is compared with crypto.timingSafeEqual, and a key of
 *      another length is a plain mismatch (no exception);
 *   3. callerRateLimitKey() keys the API key and a session, nothing else;
 *   4. the guards keep their function names (the route table and the guard
 *      coverage test identify them by name) and their declared policies;
 *   5. nothing in routes/, middleware/ or server.js reads the token, compares
 *      the API key or verifies a session token on its own (PENDING_FILES
 *      aside, see there).
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { mountRouter } = require('./helpers/mount-router');

/**
 * Files that still carry their own copy because another change owns them in
 * the same wave (the rate limiters and the server.js limiter and CSRF hooks).
 * They switch to hasValidApiKey / readSessionToken / callerRateLimitKey from
 * middleware/caller.js when the waves are merged; then this set is emptied.
 */
const PENDING_FILES = new Set();

const SECRET = 'caller-resolver-secret';
const API_KEY = 'caller-resolver-api-key';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

/** A minimal request: cookies as cookie-parser leaves them, headers lower-case. */
function request({ cookies = {}, headers = {} } = {}) {
  return /** @type {any} */ ({ cookies, headers });
}

(async () => {
  // The harness points cwd at a throwaway database before the guards (and the
  // models they load) are required.
  const harness = await mountRouter({
    env: { JWT_SECRET: SECRET, API_KEY, PAPERLESS_AI_API_KEY: '' },
  });
  const caller = require('../middleware/caller');
  const authGate = require('../middleware/authGate');
  const auth = require('../routes/auth');

  const session = jwt.sign({ id: 7, username: 'ada', typ: 'session' }, SECRET, {
    expiresIn: '1h',
  });
  const challenge = jwt.sign(
    { id: 7, username: 'ada', challengeType: 'mfa-login' },
    SECRET,
    { expiresIn: '5m' }
  );

  // ── 1. kinds ────────────────────────────────────────────────────────────────
  test('the API key resolves to apiKey', () => {
    const result = caller.resolveCaller(
      request({ headers: { 'x-api-key': API_KEY } })
    );
    assert.deepStrictEqual(result, { kind: 'apiKey' });
  });

  test('a session token resolves to session with its payload', () => {
    const result = caller.resolveCaller(request({ cookies: { jwt: session } }));
    assert.strictEqual(result.kind, 'session');
    assert.strictEqual(result.user.username, 'ada');
    assert.strictEqual(result.user.typ, 'session');
  });

  test('no token resolves to none', () => {
    assert.deepStrictEqual(caller.resolveCaller(request()), { kind: 'none' });
  });

  test('an MFA challenge token resolves to invalid', () => {
    const result = caller.resolveCaller(
      request({ headers: { authorization: `Bearer ${challenge}` } })
    );
    assert.deepStrictEqual(result, { kind: 'invalid' });
  });

  test('a missing JWT secret resolves to misconfigured', () => {
    process.env.JWT_SECRET = '';
    try {
      const result = caller.resolveCaller(
        request({ cookies: { jwt: session } })
      );
      assert.deepStrictEqual(result, { kind: 'misconfigured' });
    } finally {
      process.env.JWT_SECRET = SECRET;
    }
  });

  test('apiKey: false looks at the session only', () => {
    const result = caller.resolveCaller(
      request({ headers: { 'x-api-key': API_KEY }, cookies: { jwt: session } }),
      { apiKey: false }
    );
    assert.strictEqual(result.kind, 'session');
    assert.deepStrictEqual(
      caller.resolveCaller(request({ headers: { 'x-api-key': API_KEY } }), {
        apiKey: false,
      }),
      { kind: 'none' }
    );
  });

  // ── 2. constant-time API key comparison ─────────────────────────────────────
  test('the API key is compared with crypto.timingSafeEqual', () => {
    const original = crypto.timingSafeEqual;
    let calls = 0;
    crypto.timingSafeEqual = (a, b) => {
      calls += 1;
      return original(a, b);
    };
    try {
      assert.strictEqual(caller.apiKeyMatches(API_KEY, API_KEY), true);
      assert.strictEqual(
        caller.apiKeyMatches(API_KEY.replace(/.$/, 'X'), API_KEY),
        false
      );
      assert.strictEqual(
        calls,
        2,
        'equal-length keys go through timingSafeEqual'
      );
    } finally {
      crypto.timingSafeEqual = original;
    }
  });

  test('keys of another length, empty or missing never match and never throw', () => {
    assert.strictEqual(caller.apiKeyMatches(`${API_KEY}x`, API_KEY), false);
    assert.strictEqual(caller.apiKeyMatches('short', API_KEY), false);
    assert.strictEqual(caller.apiKeyMatches('', API_KEY), false);
    assert.strictEqual(caller.apiKeyMatches(undefined, API_KEY), false);
    assert.strictEqual(caller.apiKeyMatches(['a', 'b'], API_KEY), false);
    assert.strictEqual(caller.apiKeyMatches('anything', ''), false);
    assert.strictEqual(caller.apiKeyMatches('', ''), false);
  });

  test('a multi-byte key compares by its bytes', () => {
    assert.strictEqual(caller.apiKeyMatches('schlüssel', 'schlüssel'), true);
    assert.strictEqual(caller.apiKeyMatches('schlussel', 'schlüssel'), false);
  });

  // ── 3. rate-limit key ───────────────────────────────────────────────────────
  test('callerRateLimitKey keys the API key and the session user', () => {
    assert.strictEqual(
      caller.callerRateLimitKey(request({ headers: { 'x-api-key': API_KEY } })),
      `api-key:${API_KEY}`
    );
    assert.strictEqual(
      caller.callerRateLimitKey(request({ cookies: { jwt: session } })),
      'user:7'
    );
    const usernameOnly = jwt.sign({ username: 'ada', typ: 'session' }, SECRET);
    assert.strictEqual(
      caller.callerRateLimitKey(request({ cookies: { jwt: usernameOnly } })),
      'user:ada'
    );
  });

  test('callerRateLimitKey leaves everyone else to the IP', () => {
    assert.strictEqual(caller.callerRateLimitKey(request()), null);
    assert.strictEqual(
      caller.callerRateLimitKey(
        request({
          headers: { 'x-api-key': 'wrong', authorization: 'Bearer x' },
        })
      ),
      null
    );
    // A token that opens no session does not identify a caller either.
    assert.strictEqual(
      caller.callerRateLimitKey(request({ cookies: { jwt: challenge } })),
      null
    );
  });

  // ── 4. names and policies ───────────────────────────────────────────────────
  test('the guards keep their function names', () => {
    assert.strictEqual(authGate.authGate.name, 'authGate');
    assert.strictEqual(authGate.remoteSetupGuard.name, 'remoteSetupGuard');
    assert.strictEqual(authGate.protectApiRoute.name, 'protectApiRoute');
    assert.strictEqual(authGate.isAuthenticated.name, 'isAuthenticated');
    assert.strictEqual(auth.isAuthenticated, authGate.isAuthenticated);
    assert.strictEqual(auth.verifySessionToken, caller.verifySessionToken);
    assert.strictEqual(auth.SESSION_TOKEN_TYPE, 'session');
    assert.strictEqual(auth.authenticateJWT, undefined);
  });

  test('the declared policies', () => {
    assert.deepStrictEqual(authGate.POLICIES, {
      page: {
        acceptApiKey: true,
        refuse: 'redirect',
        clearInvalidSession: true,
      },
      sessionApi: {
        acceptApiKey: false,
        refuse: 'json',
        clearInvalidSession: false,
      },
    });
    assert.ok(Object.isFrozen(authGate.POLICIES.page));
    assert.ok(Object.isFrozen(authGate.POLICIES.sessionApi));
  });

  // ── 5. no second copy ───────────────────────────────────────────────────────
  test('no second copy of token reading, API-key comparison or session verification', () => {
    const root = path.join(__dirname, '..');
    const files = ['server.js'];
    for (const dir of ['routes', 'middleware']) {
      for (const name of fs.readdirSync(path.join(root, dir))) {
        if (
          name.endsWith('.js') &&
          `${dir}/${name}` !== 'middleware/caller.js'
        ) {
          files.push(`${dir}/${name}`);
        }
      }
    }
    const copies = [
      [/authorization\?\.split\(/, 'reads the bearer token'],
      [/cookies\??\.jwt\b/, 'reads the session cookie'],
      [/===\s*currentApiKey|currentApiKey\s*===/, 'compares the API key'],
      [/typ\s*!==\s*SESSION_TOKEN_TYPE/, 'verifies a session token'],
    ];
    const found = [];
    for (const file of files) {
      if (PENDING_FILES.has(file)) {
        continue;
      }
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      for (const [pattern, what] of copies) {
        if (pattern.test(source)) {
          found.push(`${file} ${what}`);
        }
      }
    }
    assert.deepStrictEqual(found, [], 'only middleware/caller.js may do this');
  });

  await harness.close();

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error('❌  Fatal error:', error);
  process.exit(1);
});
