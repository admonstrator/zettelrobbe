'use strict';

/**
 * The authentication gate lets a short list of paths through without a
 * session. It used to match them as plain prefixes, so any path that merely
 * started with "/login", "/setup" or "/health" (a future "/login-history",
 * "/setup-export", "/healthz") would have been public without anyone
 * deciding so. isPublicPath() matches whole path segments instead.
 *
 *   1. every path that is public today still is
 *   2. look-alike paths are not
 *   3. through the mounted router: a look-alike path is sent to /login, the
 *      real public paths are not
 */

const assert = require('assert');
const { mountRouter } = require('./helpers/mount-router');

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

const STILL_PUBLIC = [
  '/health',
  '/login',
  '/login/',
  '/logout',
  '/setup',
  '/setup/',
  '/api/setup',
  '/api/setup/presets',
  '/api/setup/complete',
  '/api/setup/mfa/setup',
  '/api/setup/paperless/test',
  '/auth/oidc',
  '/auth/oidc/login',
  '/auth/oidc/callback',
];

const NOT_PUBLIC = [
  '/',
  '/dashboard',
  '/settings',
  '/healthz',
  '/health-report',
  '/login-history',
  '/loginx',
  '/logouts',
  '/setupfoo',
  '/setup-export',
  '/api/setupx',
  '/api/setup-backdoor',
  '/auth/oidcx',
  '/auth',
  '/api/settings',
];

async function main() {
  // The router loads models/document.js, which opens data/documents.db in the
  // current directory, so mount first and require the gate afterwards.
  const h = await mountRouter({ configured: true });

  try {
    const { PUBLIC_ROUTES, isPublicPath } = require('../middleware/authGate');

    await test('the list of public routes is unchanged', () => {
      assert.deepStrictEqual(
        [...PUBLIC_ROUTES],
        ['/health', '/login', '/logout', '/setup', '/api/setup', '/auth/oidc']
      );
    });

    await test('every path that was public stays public', () => {
      for (const path of STILL_PUBLIC) {
        assert.strictEqual(isPublicPath(path), true, `${path} is public`);
      }
    });

    await test('look-alike paths are not public', () => {
      for (const path of NOT_PUBLIC) {
        assert.strictEqual(isPublicPath(path), false, `${path} is not public`);
      }
    });

    await test('empty input is not public', () => {
      assert.strictEqual(isPublicPath(''), false);
      assert.strictEqual(isPublicPath(undefined), false);
    });

    await test('a look-alike path without a session goes to /login', async () => {
      for (const path of ['/setup-export', '/login-history', '/healthz']) {
        const res = await fetch(h.base + path, { redirect: 'manual' });
        assert.strictEqual(res.status, 302, `${path} answers 302`);
        assert.strictEqual(
          res.headers.get('location'),
          '/login',
          `${path} redirects to /login`
        );
      }
    });

    await test('real public paths are not sent to /login', async () => {
      for (const path of ['/login', '/setup', '/api/setup/presets']) {
        const res = await fetch(h.base + path, { redirect: 'manual' });
        assert.notStrictEqual(
          res.headers.get('location'),
          '/login',
          `${path} is reachable without a session (status ${res.status})`
        );
      }
    });
  } finally {
    await h.close();
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
