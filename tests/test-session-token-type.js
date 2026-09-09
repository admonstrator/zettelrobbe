'use strict';

/**
 * Regression test for the MFA bypass: every JWT the application signs used to
 * verify against the same secret, so the short-lived token handed out between
 * the password step and the TOTP step was accepted by every guard as a full
 * session. A password alone therefore opened GET /api/settings/api-key and
 * GET /api/settings/env-file, which return every secret in clear text.
 *
 * A session token now carries an explicit `typ: 'session'` claim and all four
 * guards demand it:
 *   - authenticateJWT and isAuthenticated (routes/auth.js)
 *   - the global router.use guard and protectApiRoute (routes/setup.js)
 *
 * Covered here:
 *   1. Route level: an MFA challenge token and a legacy (pre-fix) token are
 *      rejected on a protected page and a protected API route, as cookie and
 *      as bearer header; a session token is accepted.
 *   2. Middleware level: authenticateJWT / isAuthenticated called directly,
 *      because the router guard rejects first and the two would otherwise
 *      never see a bad token.
 *   3. POST /login actually stamps the claim on the token it issues.
 *   4. The MFA challenge verifier still refuses a session token, so the fix
 *      cannot be turned around and used the other way.
 */

const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { mountRouter } = require('./helpers/mount-router');

const PASSWORD = 'correct-horse-battery';
const PROTECTED_PATHS = ['/api/settings/api-key', '/dashboard'];

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

function makeRes() {
  const seen = { status: null, body: null, redirect: null, cleared: [] };
  const res = {
    status(code) {
      seen.status = code;
      return res;
    },
    json(body) {
      seen.body = body;
      return res;
    },
    send(body) {
      seen.body = body;
      return res;
    },
    redirect(location) {
      seen.redirect = location;
      return res;
    },
    clearCookie(name) {
      seen.cleared.push(name);
      return res;
    },
  };
  return { res, seen };
}

function runGuard(guard, token) {
  const req = { cookies: token ? { jwt: token } : {}, headers: {} };
  const { res, seen } = makeRes();
  let nextCalls = 0;
  guard(req, res, () => {
    nextCalls++;
  });
  return { req, seen, nextCalls };
}

function setCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

function sessionCookieValue(response) {
  for (const cookie of setCookies(response)) {
    const match = /^jwt=([^;]*)/.exec(cookie);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

(async () => {
  const harness = await mountRouter({});
  // The guards are what is under test, not the markup: the real templates need
  // res.locals that only server.js sets, so every view renders as its name.
  harness.app.engine('ejs', (filePath, _options, callback) =>
    callback(null, `view:${path.basename(filePath, '.ejs')}`)
  );

  const secret = process.env.JWT_SECRET;
  await harness.documentModel.addUser('admin', await bcrypt.hash(PASSWORD, 4));

  const tokens = {
    'MFA challenge token': jwt.sign(
      { id: 1, username: 'admin', challengeType: 'mfa-login' },
      secret,
      { expiresIn: '5m' }
    ),
    'legacy token without a type claim': jwt.sign(
      { id: 1, username: 'admin' },
      secret,
      { expiresIn: '24h' }
    ),
  };
  const sessionToken = jwt.sign(
    { id: 1, username: 'admin', typ: 'session' },
    secret,
    { expiresIn: '24h' }
  );

  const request = (routePath, token, transport) =>
    fetch(harness.base + routePath, {
      headers: token
        ? transport === 'bearer'
          ? { Authorization: `Bearer ${token}` }
          : { Cookie: `jwt=${token}` }
        : {},
      redirect: 'manual',
    });

  // ── 1. Route level ────────────────────────────────────────────────────────
  for (const [label, token] of Object.entries(tokens)) {
    for (const routePath of PROTECTED_PATHS) {
      for (const transport of ['bearer', 'cookie']) {
        await test(`${routePath} rejects a ${label} (${transport})`, async () => {
          const res = await request(routePath, token, transport);
          assert.ok(
            res.status === 401 || res.status === 302,
            `expected 401 or 302, got ${res.status}`
          );
          if (res.status === 302) {
            assert.strictEqual(res.headers.get('location'), '/login');
          }
        });
      }
    }
  }

  for (const routePath of PROTECTED_PATHS) {
    for (const transport of ['bearer', 'cookie']) {
      await test(`${routePath} accepts a session token (${transport})`, async () => {
        const res = await request(routePath, sessionToken, transport);
        assert.strictEqual(res.status, 200);
      });
    }
  }

  await test('a protected route still rejects a request with no token', async () => {
    const res = await request('/api/settings/api-key', null);
    assert.ok(
      res.status === 401 || res.status === 302,
      `expected 401 or 302, got ${res.status}`
    );
  });

  // ── 2. Middleware level ───────────────────────────────────────────────────
  const { authenticateJWT, isAuthenticated } = require('../routes/auth.js');

  for (const [label, token] of Object.entries(tokens)) {
    await test(`authenticateJWT rejects a ${label}`, async () => {
      const { seen, nextCalls } = runGuard(authenticateJWT, token);
      assert.strictEqual(nextCalls, 0, 'next() must not run');
      assert.strictEqual(seen.status, 403);
      assert.deepStrictEqual(seen.body, {
        message: 'Invalid or expired token',
      });
    });

    await test(`isAuthenticated rejects a ${label}`, async () => {
      const { seen, nextCalls } = runGuard(isAuthenticated, token);
      assert.strictEqual(nextCalls, 0, 'next() must not run');
      assert.strictEqual(seen.redirect, '/login');
      assert.ok(
        seen.cleared.includes('jwt'),
        'the stale cookie must be cleared'
      );
    });
  }

  await test('authenticateJWT accepts a session token', async () => {
    const { req, nextCalls } = runGuard(authenticateJWT, sessionToken);
    assert.strictEqual(nextCalls, 1);
    assert.strictEqual(req.user.username, 'admin');
  });

  await test('isAuthenticated accepts a session token', async () => {
    const { req, nextCalls } = runGuard(isAuthenticated, sessionToken);
    assert.strictEqual(nextCalls, 1);
    assert.strictEqual(req.user.username, 'admin');
  });

  // ── 3. POST /login stamps the claim ───────────────────────────────────────
  await test("POST /login issues a token with typ 'session'", async () => {
    const res = await fetch(harness.base + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: PASSWORD }),
      redirect: 'manual',
    });

    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/dashboard');

    const issued = sessionCookieValue(res);
    assert.ok(issued, 'login must set a jwt cookie');

    const payload = jwt.verify(issued, secret);
    assert.strictEqual(payload.typ, 'session');
    assert.strictEqual(payload.username, 'admin');
    assert.ok(payload.id, 'the user id must survive');

    const accepted = await request('/api/settings/api-key', issued, 'cookie');
    assert.strictEqual(
      accepted.status,
      200,
      'the issued token must open a session'
    );
  });

  // ── 4. The MFA challenge verifier refuses a session token ─────────────────
  await test('a session token is not accepted as an MFA challenge', async () => {
    const res = await fetch(harness.base + '/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `mfa_challenge=${sessionToken}`,
      },
      body: new URLSearchParams({ mfaStep: '1', mfaToken: '123456' }),
      redirect: 'manual',
    });

    assert.notStrictEqual(res.status, 302, 'it must not complete a sign-in');
    assert.strictEqual(
      sessionCookieValue(res),
      null,
      'no session may be issued'
    );
  });

  await harness.close();

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error('❌  Fatal error:', error);
  process.exit(1);
});
