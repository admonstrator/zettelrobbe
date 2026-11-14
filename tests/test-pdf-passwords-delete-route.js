/**
 * Test: DELETE /api/settings/pdf-passwords
 *
 * Saving the settings only ever adds PDF passwords to the stored list (see
 * test-pdf-password-service.js); this route is the one way to remove them.
 * The handler is called directly with the real settings and catalogue
 * services; only setupService.saveConfig() is replaced, so nothing is written.
 *
 * Covers:
 * 1. The stored list is emptied through the normal save, the rest of the
 *    settings unchanged, and the count of deleted passwords is answered
 * 2. A key set by the environment is refused with 409 and nothing is saved
 * 3. The route carries its own guard
 */

'use strict';

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

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function main() {
  const previousCwd = process.cwd();
  const previousSnapshot = global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__;
  const previousPasswords = process.env.PDF_PASSWORDS;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-pdf-pw-route-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  // models/document.js opens data/documents.db relative to process.cwd() at
  // require time; the router pulls it in.
  process.chdir(tmpDir);
  // Nothing counts as set by the environment unless a test says so.
  global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = {};

  const setupService = require('../services/setupService');
  const router = require('../routes/settings');
  const layer = router.stack.find(
    (l) => l.route?.path === '/api/settings/pdf-passwords'
  );
  const saved = [];
  const originalSaveConfig = setupService.saveConfig;
  setupService.saveConfig = async (values, options) => {
    saved.push({ values, options });
  };

  try {
    await test('the route exists as DELETE behind isAuthenticated', () => {
      assert.ok(layer, 'route registered');
      assert.deepStrictEqual(Object.keys(layer.route.methods), ['delete']);
      assert.strictEqual(layer.route.stack[0].name, 'isAuthenticated');
    });

    const handler = layer.route.stack.at(-1).handle;

    await test('the stored passwords are deleted and counted', async () => {
      process.env.PDF_PASSWORDS = '["a","b","c"]';
      saved.length = 0;
      const res = fakeResponse();
      await handler({}, res);
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, {
        success: true,
        data: { deleted: 3 },
        message: 'All 3 PDF passwords deleted.',
      });
      assert.strictEqual(saved.length, 1);
      assert.strictEqual(saved[0].values.PDF_PASSWORDS, '');
      assert.strictEqual(saved[0].options.skipValidation, true);
      // The rest of the settings is written as it is in effect.
      assert.ok('SCAN_INTERVAL' in saved[0].values);
    });

    await test('one password and none are worded as such', async () => {
      process.env.PDF_PASSWORDS = '["only"]';
      const one = fakeResponse();
      await handler({}, one);
      assert.strictEqual(
        one.body.message,
        'The stored PDF password was deleted.'
      );
      process.env.PDF_PASSWORDS = '';
      const none = fakeResponse();
      await handler({}, none);
      assert.strictEqual(none.body.data.deleted, 0);
      assert.strictEqual(none.body.message, 'No PDF passwords were stored.');
    });

    await test('a list set by the environment is refused', async () => {
      process.env.PDF_PASSWORDS = '["pinned"]';
      global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = {
        PDF_PASSWORDS: '["pinned"]',
      };
      saved.length = 0;
      const res = fakeResponse();
      await handler({}, res);
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.success, false);
      assert.match(res.body.error, /PDF_PASSWORDS/);
      assert.deepStrictEqual(saved, []);
    });
  } finally {
    setupService.saveConfig = originalSaveConfig;
    global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = previousSnapshot;
    if (previousPasswords === undefined) delete process.env.PDF_PASSWORDS;
    else process.env.PDF_PASSWORDS = previousPasswords;
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
