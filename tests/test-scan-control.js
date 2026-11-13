'use strict';

/**
 * services/scanControl.js replaced the globals server.js used to publish
 * (__paperlessAiScanControl, __paperlessAiTriggerScanNow,
 * __paperlessAiRequestScanStop).
 *
 *   1. before server.js registers, the levers report "not available" and the
 *      routes answer 503 as they always did
 *   2. once registered, the routes start and stop through the registered
 *      functions and report the shared state
 *   3. the state object is one object for the life of the process
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

const API_KEY = 'scan-control-test-key';
const NOT_AVAILABLE =
  'Scan control is not available yet. Please try again in a moment.';

async function main() {
  const h = await mountRouter({ env: { API_KEY } });
  const scanControl = require('../services/scanControl');
  const post = (path) =>
    fetch(h.base + path, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
    });

  try {
    await test('nothing registered: idle state, levers unavailable', async () => {
      scanControl.reset();
      assert.deepStrictEqual(scanControl.getState(), {
        running: false,
        stopRequested: false,
        source: null,
        startedAt: null,
        stopRequestedAt: null,
      });
      assert.strictEqual(scanControl.isRunning(), false);
      assert.strictEqual(scanControl.canTriggerScan(), false);
      assert.strictEqual(scanControl.canRequestStop(), false);
      await assert.rejects(() => scanControl.triggerScanNow('test'));
      assert.throws(() => scanControl.requestScanStop());
    });

    await test('nothing registered: POST /api/scan/now answers 503', async () => {
      scanControl.reset();
      const res = await post('/api/scan/now');
      assert.strictEqual(res.status, 503);
      assert.deepStrictEqual(await res.json(), {
        success: false,
        error: NOT_AVAILABLE,
      });
    });

    await test('nothing registered: POST /api/scan/stop answers 503', async () => {
      scanControl.reset();
      const res = await post('/api/scan/stop');
      assert.strictEqual(res.status, 503);
      assert.deepStrictEqual(await res.json(), {
        success: false,
        error: NOT_AVAILABLE,
      });
    });

    await test('registered: /api/scan/now starts through the trigger', async () => {
      scanControl.reset();
      const sources = [];
      scanControl.register({
        triggerScanNow: async (source) => {
          sources.push(source);
          return {
            started: true,
            running: true,
            stopRequested: false,
            message: 'Scan started.',
          };
        },
        requestScanStop: () => false,
      });

      const res = await post('/api/scan/now');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), {
        success: true,
        started: true,
        running: true,
        stopRequested: false,
        message: 'Scan started.',
      });
      assert.deepStrictEqual(sources, ['api-manual']);
    });

    await test('registered: /api/scan/stop reports the shared state', async () => {
      scanControl.reset();
      const state = scanControl.getState();
      scanControl.register({
        triggerScanNow: async () => ({
          started: false,
          running: true,
          message: 'Scan is already running.',
        }),
        // Mirrors requestScanStop() in services/scanService.js.
        requestScanStop: () => {
          if (!state.running) return false;
          state.stopRequested = true;
          return true;
        },
      });

      let res = await post('/api/scan/stop');
      assert.deepStrictEqual(await res.json(), {
        success: true,
        running: false,
        stopRequested: false,
        message: 'No active scan to stop.',
      });

      state.running = true;
      res = await post('/api/scan/stop');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), {
        success: true,
        running: true,
        stopRequested: true,
        message:
          'Stop requested. The current document will finish before scan stops.',
      });
      assert.strictEqual(scanControl.isRunning(), true);
    });

    await test('/api/processing-status reads the same state', async () => {
      const state = scanControl.getState();
      state.running = true;
      state.stopRequested = true;
      const res = await fetch(h.base + '/api/processing-status', {
        headers: { 'x-api-key': API_KEY },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.isScanning, true);
      assert.strictEqual(body.stopRequested, true);
      assert.strictEqual(body.scanner.running, true);
    });

    await test('reset keeps the state object and clears the levers', () => {
      const before = scanControl.getState();
      before.running = true;
      scanControl.reset();
      assert.strictEqual(scanControl.getState(), before);
      assert.strictEqual(before.running, false);
      assert.strictEqual(scanControl.canTriggerScan(), false);
    });
  } finally {
    scanControl.reset();
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
