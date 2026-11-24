/**
 * Test: the OCR address detection leaves an address the environment sets alone
 *
 * For a local OCR server mistralOcrService tries the configured address with
 * and without /v1 and keeps the one that answers. It then wrote that address
 * to process.env.OCR_API_URL and to the stored settings, also when
 * docker-compose sets OCR_API_URL: the value from the environment no longer
 * applied until the next start, and a stored copy waited to apply once the
 * line was gone. Every other writer leaves a key the environment sets alone
 * (config.isProtectedRuntimeEnvKey).
 *
 * The service runs with its database, Paperless-ngx and settings store
 * replaced; the server probe answers from a table.
 *
 * Covers:
 * 1. OCR_API_URL set by the environment: the detected address is used for
 *    the requests, process.env, config and the stored settings keep their
 *    values, and one line says that the environment decides
 * 2. OCR_API_URL not set by the environment: the detected address is saved
 *    and applies, as before
 */

'use strict';

const assert = require('assert');

const CONFIGURED = 'http://ocr.test:11434';
const DETECTED = 'http://ocr.test:11434/v1';

// Present at start, as docker-compose sets it. config.js takes its snapshot
// of the environment when it loads; this one is set before that.
process.env.OCR_PROVIDER = 'ollama';
process.env.OCR_API_URL = CONFIGURED;
global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = { OCR_API_URL: CONFIGURED };

function inject(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

const saved = [];
inject(require.resolve('../models/document'), {});
inject(require.resolve('../services/paperlessService'), {
  initialize() {},
});
inject(require.resolve('../services/setupService'), {
  loadConfig: async () => ({ SCAN_INTERVAL: '*/30 * * * *' }),
  saveRuntimeOverrides: async (values) => {
    saved.push(values);
  },
});

const config = require('../config/config');
const mistralOcrService = require('../services/mistralOcrService');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed += 1;
  }
}

/** Detection with a server that answers only on /v1; returns the address and the log. */
async function detect() {
  mistralOcrService.detectedLocalApiBase = null;
  mistralOcrService.detectedLocalApiMode = null;
  mistralOcrService.probeLocalOcrCandidate = async (base) => base === DETECTED;
  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    const base = await mistralOcrService.resolveLocalOcrApiBase();
    return { base, lines };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

(async () => {
  try {
    await test('set by the environment: used, not written anywhere, one line says so', async () => {
      assert.strictEqual(config.isProtectedRuntimeEnvKey('OCR_API_URL'), true);
      saved.length = 0;
      const { base, lines } = await detect();
      assert.strictEqual(base, DETECTED, 'the requests use what answers');
      assert.strictEqual(mistralOcrService.detectedLocalApiMode, 'openai');
      assert.strictEqual(process.env.OCR_API_URL, CONFIGURED);
      assert.strictEqual(config.mistralOcr.apiUrl, CONFIGURED);
      assert.deepStrictEqual(saved, [], 'nothing stored');
      assert.deepStrictEqual(lines, [
        `[OCR] The OCR API answers at ${DETECTED}. OCR_API_URL is set by the environment, which decides, so the address is not saved.`,
      ]);
    });

    await test('not set by the environment: the detected address is saved and applies', async () => {
      delete global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__.OCR_API_URL;
      assert.strictEqual(config.isProtectedRuntimeEnvKey('OCR_API_URL'), false);
      process.env.OCR_API_URL = CONFIGURED;
      saved.length = 0;
      const { base, lines } = await detect();
      assert.strictEqual(base, DETECTED);
      assert.strictEqual(process.env.OCR_API_URL, DETECTED);
      assert.deepStrictEqual(saved, [
        { SCAN_INTERVAL: '*/30 * * * *', OCR_API_URL: DETECTED },
      ]);
      assert.ok(
        lines.includes(`[OCR] Auto-detected OCR API URL saved: ${DETECTED}`),
        lines.join(' | ')
      );
    });
  } finally {
    delete process.env.OCR_API_URL;
    delete process.env.OCR_PROVIDER;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
