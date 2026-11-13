'use strict';

/**
 * services/sessionCookie.js issues the session cookie for the password
 * sign-in, the MFA step and single sign-on.
 *
 *   1. the Secure flag: COOKIE_SECURE_MODE always/never, and in auto mode a
 *      TLS connection or X-Forwarded-Proto: https from a proxy
 *   2. the cookie: name jwt, httpOnly, SameSite=Lax, path /, 24 hours, and a
 *      token the session guards accept
 *   3. clearing it
 *   4. the same policy without a request (the CSRF cookie at startup), and
 *      server.js keeping no copy of its own
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function makeReq({ secure = false, forwardedProto } = {}) {
  const headers = {};
  if (forwardedProto !== undefined) {
    headers['x-forwarded-proto'] = forwardedProto;
  }
  return { secure, headers };
}

function makeRes() {
  const seen = { cookies: [], cleared: [] };
  return {
    seen,
    cookie(name, value, options) {
      seen.cookies.push({ name, value, options });
      return this;
    },
    clearCookie(name, options) {
      seen.cleared.push({ name, options });
      return this;
    },
  };
}

async function main() {
  // config/config.js looks for data/ in the current directory.
  const previousCwd = process.cwd();
  const previousMode = process.env.COOKIE_SECURE_MODE;
  const previousNodeEnv = process.env.NODE_ENV;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-session-cookie-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  process.chdir(tmpDir);

  try {
    const jwt = require('jsonwebtoken');
    const {
      SESSION_COOKIE_NAME,
      SESSION_TTL_MS,
      isHttpsRequest,
      shouldUseSecureCookies,
      issueSessionCookie,
      clearSessionCookie,
    } = require('../services/sessionCookie');
    const { verifySessionToken } = require('../routes/auth');

    await test('auto: a plain HTTP request gets no Secure flag', () => {
      delete process.env.COOKIE_SECURE_MODE;
      assert.strictEqual(shouldUseSecureCookies(makeReq()), false);
      process.env.COOKIE_SECURE_MODE = 'auto';
      assert.strictEqual(shouldUseSecureCookies(makeReq()), false);
    });

    await test('auto: TLS on the connection sets Secure', () => {
      process.env.COOKIE_SECURE_MODE = 'auto';
      assert.strictEqual(
        shouldUseSecureCookies(makeReq({ secure: true })),
        true
      );
    });

    await test('auto: behind a proxy, the first X-Forwarded-Proto decides', () => {
      process.env.COOKIE_SECURE_MODE = 'auto';
      assert.strictEqual(
        shouldUseSecureCookies(makeReq({ forwardedProto: 'https' })),
        true
      );
      assert.strictEqual(
        shouldUseSecureCookies(makeReq({ forwardedProto: ' HTTPS , http' })),
        true
      );
      assert.strictEqual(
        shouldUseSecureCookies(makeReq({ forwardedProto: 'http, https' })),
        false
      );
      assert.strictEqual(
        shouldUseSecureCookies(makeReq({ forwardedProto: 'http' })),
        false
      );
    });

    await test('always and never override the request', () => {
      process.env.COOKIE_SECURE_MODE = 'always';
      assert.strictEqual(shouldUseSecureCookies(makeReq()), true);
      process.env.COOKIE_SECURE_MODE = 'never';
      assert.strictEqual(
        shouldUseSecureCookies(
          makeReq({ secure: true, forwardedProto: 'https' })
        ),
        false
      );
      process.env.COOKIE_SECURE_MODE = 'bogus';
      assert.strictEqual(
        shouldUseSecureCookies(makeReq({ forwardedProto: 'https' })),
        true,
        'an unknown mode falls back to auto'
      );
    });

    await test('without a request, auto means Secure in production only', () => {
      for (const mode of [undefined, 'auto', 'bogus']) {
        if (mode === undefined) {
          delete process.env.COOKIE_SECURE_MODE;
        } else {
          process.env.COOKIE_SECURE_MODE = mode;
        }
        process.env.NODE_ENV = 'production';
        assert.strictEqual(shouldUseSecureCookies(), true, `${mode}`);
        process.env.NODE_ENV = ' Production ';
        assert.strictEqual(
          shouldUseSecureCookies(),
          false,
          'NODE_ENV is compared as written, only its case is ignored'
        );
        process.env.NODE_ENV = 'PRODUCTION';
        assert.strictEqual(shouldUseSecureCookies(), true, `${mode}`);
        process.env.NODE_ENV = 'development';
        assert.strictEqual(shouldUseSecureCookies(), false, `${mode}`);
        delete process.env.NODE_ENV;
        assert.strictEqual(shouldUseSecureCookies(), false, `${mode}`);
      }
    });

    await test('without a request, always and never still decide', () => {
      process.env.NODE_ENV = 'development';
      process.env.COOKIE_SECURE_MODE = 'always';
      assert.strictEqual(shouldUseSecureCookies(), true);
      process.env.NODE_ENV = 'production';
      process.env.COOKIE_SECURE_MODE = ' NEVER ';
      assert.strictEqual(shouldUseSecureCookies(), false);
    });

    await test('isHttpsRequest reads TLS and the first forwarded protocol', () => {
      process.env.COOKIE_SECURE_MODE = 'never';
      assert.strictEqual(isHttpsRequest(makeReq({ secure: true })), true);
      assert.strictEqual(
        isHttpsRequest(makeReq({ forwardedProto: 'HTTPS, http' })),
        true,
        'the mode does not matter here'
      );
      assert.strictEqual(
        isHttpsRequest(makeReq({ forwardedProto: 'http, https' })),
        false
      );
      assert.strictEqual(isHttpsRequest(makeReq()), false);
    });

    await test('server.js keeps no cookie policy of its own', () => {
      const server = fs.readFileSync(
        path.join(__dirname, '..', 'server.js'),
        'utf8'
      );
      assert.ok(
        !/function (shouldUseSecureCookies|getCookieSecureMode|isHttpsRequest)\b/.test(
          server
        ),
        'server.js must use services/sessionCookie.js'
      );
      assert.ok(
        server.includes("require('./services/sessionCookie')"),
        'server.js must take the policy from services/sessionCookie.js'
      );
    });

    await test('the session cookie carries name, flags, lifetime and payload', () => {
      process.env.COOKIE_SECURE_MODE = 'auto';
      const secret = 'session-cookie-test-secret';
      const res = makeRes();
      const token = issueSessionCookie(
        makeReq({ forwardedProto: 'https' }),
        res,
        { id: 7, username: 'admin', password: 'never-in-the-token' },
        secret
      );

      assert.strictEqual(res.seen.cookies.length, 1);
      const [cookie] = res.seen.cookies;
      assert.strictEqual(cookie.name, 'jwt');
      assert.strictEqual(SESSION_COOKIE_NAME, 'jwt');
      assert.strictEqual(cookie.value, token);
      assert.deepStrictEqual(cookie.options, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000,
      });
      assert.strictEqual(SESSION_TTL_MS, 24 * 60 * 60 * 1000);

      const payload = jwt.verify(token, secret);
      assert.strictEqual(payload.id, 7);
      assert.strictEqual(payload.username, 'admin');
      assert.strictEqual(payload.typ, 'session');
      assert.strictEqual(payload.password, undefined);
      assert.strictEqual(payload.exp - payload.iat, 24 * 60 * 60);
      assert.ok(
        verifySessionToken(token, secret),
        'the session guards accept the token'
      );
    });

    await test('a plain HTTP sign-in gets a cookie without Secure', () => {
      process.env.COOKIE_SECURE_MODE = 'auto';
      const res = makeRes();
      issueSessionCookie(makeReq(), res, { id: 1, username: 'a' }, 's');
      assert.strictEqual(res.seen.cookies[0].options.secure, false);
    });

    await test('clearing removes the jwt cookie', () => {
      const res = makeRes();
      clearSessionCookie(res);
      assert.deepStrictEqual(
        res.seen.cleared.map((entry) => entry.name),
        ['jwt']
      );
    });
  } finally {
    if (previousMode === undefined) {
      delete process.env.COOKIE_SECURE_MODE;
    } else {
      process.env.COOKIE_SECURE_MODE = previousMode;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exitCode = 1;
});
