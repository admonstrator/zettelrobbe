/**
 * Test: the remote-access guard of the setup wizard (GHSA-v4jq-65q5-wgjp)
 *
 * Runs the real isLocalRequest() and remoteSetupGuard() of
 * middleware/authGate.js against mock request/response/next objects, with a
 * real (throwaway) database behind the "is the wizard still open" question:
 * the instance is open until the first administrator account exists. No
 * server is needed.
 *
 * Covers:
 *  1. isLocalRequest(): the three loopback spellings are local, everything
 *     else (private, public, mapped private, no socket, empty) is not
 *  2. A forged X-Forwarded-For or req.ip never makes a remote socket local
 *  3. Paths outside /setup and /api/setup are never blocked
 *  4. Open instance + remote socket: 403, JSON for /api/setup, HTML for /setup
 *  5. Open instance + loopback socket: allowed
 *  6. ALLOW_REMOTE_SETUP=yes is the only opt-in ("true" and "1" are not)
 *  7. An error while asking whether the wizard is open lets the request on
 *  8. Once an administrator exists the guard is lifted
 *
 * Usage:
 *   node tests/test-setup-remote-guard.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${error.stack || error.message}`);
    failed += 1;
  }
}

function makeReq({
  remoteAddress,
  path: requestPath = '/api/setup/complete',
  headers = {},
  ip,
} = {}) {
  return {
    socket: remoteAddress !== undefined ? { remoteAddress } : undefined,
    path: requestPath,
    headers,
    ip,
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    kind: null,
    contentType: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.kind = 'json';
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    send(body) {
      this.body = body;
      this.kind = 'html';
      return this;
    },
  };
}

/** Runs the real guard and reports what it did. */
async function runGuard(remoteSetupGuard, req) {
  const res = makeRes();
  let nextCalled = false;
  await remoteSetupGuard(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-remote-guard-'));
  process.chdir(tempRoot);

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://127.0.0.1:9';
  process.env.PAPERLESS_API_TOKEN = 'test-token';
  delete process.env.ALLOW_REMOTE_SETUP;

  const documentModel = require('../models/document');
  const {
    isLocalRequest,
    remoteSetupGuard,
  } = require('../middleware/authGate');

  try {
    // ── 1. isLocalRequest() ────────────────────────────────────────────────
    console.log('\n🧪 isLocalRequest() — IP classification');
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      await test(`${address} is local`, () => {
        assert.strictEqual(
          isLocalRequest(makeReq({ remoteAddress: address })),
          true
        );
      });
    }
    for (const [label, address] of [
      ['private RFC-1918 192.168.1.100', '192.168.1.100'],
      ['private 10.0.0.1', '10.0.0.1'],
      ['Docker bridge 172.17.0.1', '172.17.0.1'],
      ['IPv4-mapped Docker bridge ::ffff:172.17.0.1', '::ffff:172.17.0.1'],
      ['public 1.2.3.4', '1.2.3.4'],
      ['public IPv6 2001:db8::1', '2001:db8::1'],
      ['look-alike 127.0.0.2', '127.0.0.2'],
      ['look-alike 127.0.0.1.evil.example', '127.0.0.1.evil.example'],
      ['IPv6 localhost with a zone ::1%lo', '::1%lo'],
    ]) {
      await test(`${label} is remote`, () => {
        assert.strictEqual(
          isLocalRequest(makeReq({ remoteAddress: address })),
          false
        );
      });
    }
    await test('no socket is not local (fail-safe)', () => {
      assert.strictEqual(isLocalRequest({ socket: undefined }), false);
      assert.strictEqual(isLocalRequest({}), false);
    });
    await test('a null or empty remoteAddress is not local', () => {
      assert.strictEqual(
        isLocalRequest({ socket: { remoteAddress: null } }),
        false
      );
      assert.strictEqual(
        isLocalRequest({ socket: { remoteAddress: '' } }),
        false
      );
    });

    // ── 2. Forged proxy headers ────────────────────────────────────────────
    await test('X-Forwarded-For and req.ip cannot make a remote socket local', () => {
      const req = makeReq({
        remoteAddress: '203.0.113.9',
        headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
        ip: '127.0.0.1',
      });
      assert.strictEqual(isLocalRequest(req), false);
    });

    // ── Open instance: no administrator account yet ────────────────────────
    console.log('\n🧪 remoteSetupGuard() — instance still open');
    assert.strictEqual(
      (await documentModel.getUsers()).length,
      0,
      'precondition: no administrator account'
    );

    // ── 3. Paths outside the wizard ────────────────────────────────────────
    for (const requestPath of [
      '/dashboard',
      '/api/processing-status',
      '/settings',
      '/login',
      '/setupfoo',
      '/setup-guide',
      '/',
    ]) {
      await test(`${requestPath} passes for a remote caller`, async () => {
        const { res, nextCalled } = await runGuard(
          remoteSetupGuard,
          makeReq({ remoteAddress: '8.8.8.8', path: requestPath })
        );
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(res.statusCode, null);
      });
    }

    // ── 4. Remote socket on an open instance ───────────────────────────────
    for (const requestPath of [
      '/api/setup/complete',
      '/api/setup/paperless/test',
      '/api/setup/mfa/setup',
      '/api/setup',
      '/api/setupfoo',
    ]) {
      await test(`remote caller on ${requestPath} gets 403 JSON`, async () => {
        const { res, nextCalled } = await runGuard(
          remoteSetupGuard,
          makeReq({ remoteAddress: '8.8.8.8', path: requestPath })
        );
        assert.strictEqual(nextCalled, false, 'next() must not be called');
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(res.kind, 'json');
        assert.strictEqual(res.body.success, false);
        assert.match(res.body.error, /ALLOW_REMOTE_SETUP=yes/);
      });
    }
    for (const [label, address, requestPath] of [
      ['a public address', '8.8.8.8', '/setup'],
      ['the Docker bridge', '172.17.0.1', '/setup'],
      ['a private address', '10.0.0.1', '/setup/'],
      ['a mapped private address', '::ffff:192.168.1.5', '/setup/step'],
    ]) {
      await test(`${label} on ${requestPath} gets 403 HTML`, async () => {
        const { res, nextCalled } = await runGuard(
          remoteSetupGuard,
          makeReq({ remoteAddress: address, path: requestPath })
        );
        assert.strictEqual(nextCalled, false, 'next() must not be called');
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(res.kind, 'html');
        assert.strictEqual(res.contentType, 'text/html');
        assert.match(res.body, /Remote Setup Access Denied/);
      });
    }
    await test('a request without a socket is treated as remote', async () => {
      const { res, nextCalled } = await runGuard(remoteSetupGuard, {
        path: '/api/setup/complete',
        headers: {},
      });
      assert.strictEqual(nextCalled, false);
      assert.strictEqual(res.statusCode, 403);
    });
    await test('a forged X-Forwarded-For does not open the wizard to a remote socket', async () => {
      const { res, nextCalled } = await runGuard(
        remoteSetupGuard,
        makeReq({
          remoteAddress: '203.0.113.9',
          headers: { 'x-forwarded-for': '127.0.0.1' },
          ip: '127.0.0.1',
        })
      );
      assert.strictEqual(nextCalled, false);
      assert.strictEqual(res.statusCode, 403);
    });

    // ── 5. Loopback on an open instance ────────────────────────────────────
    for (const [address, requestPath] of [
      ['127.0.0.1', '/api/setup/complete'],
      ['::1', '/api/setup/presets'],
      ['::ffff:127.0.0.1', '/api/setup/mfa/setup'],
      ['127.0.0.1', '/setup'],
    ]) {
      await test(`${address} on ${requestPath} is allowed`, async () => {
        const { res, nextCalled } = await runGuard(
          remoteSetupGuard,
          makeReq({ remoteAddress: address, path: requestPath })
        );
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(res.statusCode, null);
      });
    }

    // ── 6. The opt-in ──────────────────────────────────────────────────────
    console.log('\n🧪 remoteSetupGuard() — ALLOW_REMOTE_SETUP');
    await test('ALLOW_REMOTE_SETUP=yes lets a remote caller through', async () => {
      process.env.ALLOW_REMOTE_SETUP = 'yes';
      try {
        const { res, nextCalled } = await runGuard(
          remoteSetupGuard,
          makeReq({ remoteAddress: '8.8.8.8' })
        );
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(res.statusCode, null);
      } finally {
        delete process.env.ALLOW_REMOTE_SETUP;
      }
    });
    for (const value of ['true', '1', 'YES', 'no', '']) {
      await test(`ALLOW_REMOTE_SETUP=${JSON.stringify(value)} is not an opt-in`, async () => {
        process.env.ALLOW_REMOTE_SETUP = value;
        try {
          const { res, nextCalled } = await runGuard(
            remoteSetupGuard,
            makeReq({ remoteAddress: '8.8.8.8' })
          );
          assert.strictEqual(nextCalled, false);
          assert.strictEqual(res.statusCode, 403);
        } finally {
          delete process.env.ALLOW_REMOTE_SETUP;
        }
      });
    }

    // ── 7. The wizard state cannot be read ─────────────────────────────────
    await test('an error while reading the user table lets the request on', async () => {
      const realGetUsers = documentModel.getUsers;
      documentModel.getUsers = async () => {
        throw new Error('database is locked');
      };
      try {
        const { res, nextCalled } = await runGuard(
          remoteSetupGuard,
          makeReq({ remoteAddress: '8.8.8.8' })
        );
        assert.strictEqual(
          nextCalled,
          true,
          'the guard hands the question to the next middleware'
        );
        assert.strictEqual(res.statusCode, null);
      } finally {
        documentModel.getUsers = realGetUsers;
      }
    });

    // ── 8. Setup complete ──────────────────────────────────────────────────
    console.log('\n🧪 remoteSetupGuard() — setup complete');
    await documentModel.addUser('admin', 'not-a-real-hash');
    assert.strictEqual(
      (await documentModel.getUsers()).length,
      1,
      'precondition: an administrator exists'
    );

    for (const requestPath of ['/api/setup/complete', '/setup']) {
      await test(`administrator present: a remote caller on ${requestPath} passes the guard`, async () => {
        const { res, nextCalled } = await runGuard(
          remoteSetupGuard,
          makeReq({ remoteAddress: '8.8.8.8', path: requestPath })
        );
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(res.statusCode, null);
      });
    }
  } finally {
    try {
      documentModel.closeDatabase();
    } catch {
      // Already closed.
    }
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n❌ Some tests FAILED.');
  } else {
    console.log('\n✅ All tests PASSED.');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
