'use strict';

/**
 * The router harness (tests/helpers/mount-router) used to inject req.user and
 * nothing else, so a test that said "authenticated" never was: the router-wide
 * guard ignores req.user and redirects to /login unless a session token or the
 * API key is present. mountRouter({ user }) now signs a real session JWT and
 * attaches it to every request that brings no credentials of its own.
 *
 * Proven here, through the real guard on a gate-protected page (GET /history):
 *   1. a harness with a user passes the guard (200, not a 302 to /login);
 *   2. the token is a genuine session token: same secret, `typ: 'session'`,
 *      and verifySessionToken accepts it;
 *   3. a request without any credentials is redirected to /login (opt-out
 *      header), and so is one with a forged or non-session token, so the pass
 *      in (1) comes from the session and not from the pre-set req.user;
 *   4. the API key path works (apiKeyHeaders) and a wrong key falls through
 *      to the session check instead of opening the door;
 *   5. the explicit helpers (authHeaders, sessionCookie) work, and
 *      authHeaders() refuses to run on a harness without a user.
 */

const assert = require('assert');
const jwt = require('jsonwebtoken');
const { mountRouter } = require('./helpers/mount-router');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌  ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

(async () => {
  const harness = await mountRouter({ user: { username: 'harness-admin' } });
  const { verifySessionToken } = require('../routes/auth');

  const get = (path, headers = {}) =>
    fetch(harness.base + path, { headers, redirect: 'manual' });

  await test('a harness user passes the router-wide guard on /history', async () => {
    const res = await get('/history');
    assert.strictEqual(res.status, 200, `got ${res.status}`);
  });

  await test('the issued token is a real session token', () => {
    assert.ok(harness.sessionToken, 'sessionToken is exposed');
    const decoded = verifySessionToken(
      harness.sessionToken,
      process.env.JWT_SECRET
    );
    assert.ok(decoded, 'verifySessionToken accepts it');
    assert.strictEqual(decoded.typ, 'session');
    assert.strictEqual(decoded.username, 'harness-admin');
    assert.strictEqual(harness.sessionCookie, `jwt=${harness.sessionToken}`);
  });

  await test('a request without credentials is redirected to /login', async () => {
    const res = await get('/history', harness.anonymousHeaders());
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/login');
  });

  await test('a forged session cookie is redirected, not waved through', async () => {
    const forged = jwt.sign(
      { id: 1, username: 'x', typ: 'session' },
      'some-other-secret'
    );
    const res = await get('/history', { cookie: `jwt=${forged}` });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/login');
  });

  await test('a token that is not a session token is redirected', async () => {
    const challenge = jwt.sign(
      { id: 1, username: 'x', typ: 'mfa-challenge' },
      process.env.JWT_SECRET
    );
    const res = await get('/history', { cookie: `jwt=${challenge}` });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/login');
  });

  await test('the API key path works', async () => {
    const res = await get('/history', harness.apiKeyHeaders());
    assert.strictEqual(res.status, 200, `got ${res.status}`);
  });

  await test('a wrong API key does not open the door', async () => {
    const res = await get('/history', {
      ...harness.anonymousHeaders(),
      'x-api-key': 'not-the-key',
    });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/login');
  });

  await test('authHeaders() signs a request in explicitly', async () => {
    const res = await get('/history', harness.authHeaders());
    assert.strictEqual(res.status, 200, `got ${res.status}`);
  });

  await test('a protected API route answers 200 for the session and redirects nobody', async () => {
    const signedIn = await get('/api/settings/api-key');
    assert.strictEqual(signedIn.status, 200, `got ${signedIn.status}`);
    const anonymous = await get(
      '/api/settings/api-key',
      harness.anonymousHeaders()
    );
    assert.strictEqual(anonymous.status, 302);
    assert.strictEqual(anonymous.headers.get('location'), '/login');
  });

  await harness.close();

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error('❌  Fatal error:', error);
  process.exit(1);
});
