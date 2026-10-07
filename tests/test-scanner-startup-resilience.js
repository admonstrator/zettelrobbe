/**
 * Test: scanner startup resilience (issue #272)
 *
 * Regression guard for the failure mode where a single Paperless-ngx
 * connection error at container start left the app running forever without a
 * scan scheduler, while /health still reported "healthy".
 *
 * Covers:
 * 1. ScanHealthService state machine (armed / degraded / failure counting)
 * 2. paperlessService.checkConnection() error classification
 * 3. server.js arms the scan cron independently of the Paperless preflight
 * 4. /health reports and reacts to the degraded state
 */

'use strict';

// Set before requiring config-backed modules: config is evaluated on first require.
process.env.HEALTH_SCAN_FAILURE_THRESHOLD = '3';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  ScanHealthService,
  RUN_STATUS,
} = require('../services/scanHealthService');
const paperlessService = require('../services/paperlessService');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

// Async tests are queued and run sequentially at the end: they patch the shared
// paperlessService singleton and must not overlap.
const asyncTests = [];

function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

async function runAsyncTests() {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      console.log(`✅  ${name}`);
      passed++;
    } catch (error) {
      console.error(`❌  ${name}`);
      console.error(`    ${error.message}`);
      failed++;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. ScanHealthService
// ──────────────────────────────────────────────────────────────────────────────

test('A scanner without an armed scheduler counts as degraded', () => {
  const health = new ScanHealthService();
  assert.strictEqual(
    health.isDegraded(),
    true,
    'No scheduler means the app cannot process documents — this is the #272 failure mode'
  );
});

test('Disabled automatic processing is never degraded', () => {
  const health = new ScanHealthService();
  health.markAutomaticProcessingDisabled();

  assert.strictEqual(health.isDegraded(), false);
  assert.strictEqual(health.getState().automaticProcessingEnabled, false);
});

test('Arming the scheduler clears the degraded state', () => {
  const health = new ScanHealthService();
  health.markArmed('*/30 * * * *');

  const state = health.getState();
  assert.strictEqual(state.armed, true);
  assert.strictEqual(state.scanInterval, '*/30 * * * *');
  assert.strictEqual(health.isDegraded(), false);
});

test('Degraded only after the configured number of consecutive failures', () => {
  const health = new ScanHealthService();
  health.markArmed('*/30 * * * *');
  assert.strictEqual(health.failureThreshold, 3);

  health.recordRunResult({
    status: RUN_STATUS.PAPERLESS_UNREACHABLE,
    error: 'connect ECONNREFUSED 172.18.0.2:8000',
  });
  assert.strictEqual(health.isDegraded(), false, 'One failure is transient');

  health.recordRunResult({ status: RUN_STATUS.PAPERLESS_UNREACHABLE });
  assert.strictEqual(health.isDegraded(), false, 'Two failures are transient');

  health.recordRunResult({ status: RUN_STATUS.PAPERLESS_UNREACHABLE });
  assert.strictEqual(
    health.isDegraded(),
    true,
    'Third consecutive failure crosses the threshold'
  );
  assert.strictEqual(health.getState().consecutiveFailures, 3);
});

test('A successful run resets the failure counter', () => {
  const health = new ScanHealthService();
  health.markArmed('*/30 * * * *');
  health.recordRunResult({ status: RUN_STATUS.ERROR, error: 'boom' });
  health.recordRunResult({ status: RUN_STATUS.ERROR, error: 'boom' });
  health.recordRunResult({ status: RUN_STATUS.ERROR, error: 'boom' });
  assert.strictEqual(health.isDegraded(), true);

  health.recordRunResult({ status: RUN_STATUS.OK });

  const state = health.getState();
  assert.strictEqual(state.consecutiveFailures, 0);
  assert.strictEqual(state.lastError, null);
  assert.ok(state.lastSuccessfulRunAt, 'Successful run must be timestamped');
  assert.strictEqual(health.isDegraded(), false);
});

test('Connectivity keeps "reachable" and "authorized" apart', () => {
  const health = new ScanHealthService();

  health.recordConnectivity({
    reachable: true,
    authorized: false,
    status: 403,
    error: 'Request failed with status code 403',
  });

  const rejected = health.getState().paperless;
  assert.strictEqual(
    rejected.reachable,
    true,
    'The host answered — reporting this as "not reachable" sends users hunting the wrong problem'
  );
  assert.strictEqual(rejected.authorized, false);
  assert.strictEqual(
    rejected.usable,
    false,
    'A rejected token still makes Paperless unusable for the scan loop'
  );
  assert.strictEqual(rejected.status, 403);

  health.recordConnectivity({
    reachable: true,
    authorized: true,
    status: 200,
    error: null,
  });

  const working = health.getState().paperless;
  assert.strictEqual(working.reachable, true);
  assert.strictEqual(working.authorized, true);
  assert.strictEqual(working.usable, true);
});

test('An outage is reported as unreachable and unusable', () => {
  const health = new ScanHealthService();
  health.recordConnectivity({
    reachable: false,
    authorized: false,
    status: null,
    error: 'connect ECONNREFUSED 172.18.0.2:8000',
  });

  const state = health.getState().paperless;
  assert.strictEqual(state.reachable, false);
  assert.strictEqual(state.usable, false);
  assert.ok(state.lastCheckedAt, 'Every probe must be timestamped');
});

test('clearConnectivity() resets to "never probed"', () => {
  const health = new ScanHealthService();
  health.recordConnectivity({ reachable: false, authorized: false });

  health.clearConnectivity();

  const state = health.getState().paperless;
  assert.strictEqual(
    state.usable,
    null,
    'An unconfigured setup must not look like an outage'
  );
  assert.strictEqual(state.reachable, null);
  assert.strictEqual(state.lastCheckedAt, null);
});

test('Connectivity alone never changes the failure counter', () => {
  const health = new ScanHealthService();
  health.markArmed('*/30 * * * *');

  for (let i = 0; i < 5; i++) {
    health.recordConnectivity({ reachable: false, authorized: false });
  }

  assert.strictEqual(
    health.getState().consecutiveFailures,
    0,
    'The passive probe must not push /health into 503 on its own'
  );
  assert.strictEqual(health.isDegraded(), false);
});

test('getState() returns a copy that cannot mutate internal state', () => {
  const health = new ScanHealthService();
  const state = health.getState();

  state.armed = true;
  state.paperless.reachable = true;

  assert.strictEqual(health.getState().armed, false);
  assert.strictEqual(health.getState().paperless.reachable, null);
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. paperlessService.checkConnection()
// ──────────────────────────────────────────────────────────────────────────────

async function withStubbedClient(clientStub, fn) {
  const originalInitialize = paperlessService.initialize;
  const originalClient = paperlessService.client;

  // Keep initialize() from replacing the stub with a real axios instance.
  paperlessService.initialize = () => {};
  paperlessService.client = clientStub;

  try {
    return await fn();
  } finally {
    paperlessService.initialize = originalInitialize;
    paperlessService.client = originalClient;
  }
}

function makeAxiosError(message, status) {
  const error = new Error(message);
  if (status !== undefined) {
    error.response = { status };
  }
  return error;
}

testAsync('checkConnection() reports a refused connection', async () => {
  const result = await withStubbedClient(
    {
      get: async () => {
        throw makeAxiosError('connect ECONNREFUSED 172.18.0.2:8000');
      },
    },
    () => paperlessService.checkConnection()
  );

  assert.strictEqual(result.reachable, false);
  assert.strictEqual(result.authorized, false);
  assert.strictEqual(result.status, null);
  assert.match(result.error, /ECONNREFUSED/);
});

testAsync('checkConnection() separates reachable from authorized', async () => {
  const result = await withStubbedClient(
    {
      get: async () => {
        throw makeAxiosError('Request failed with status code 403', 403);
      },
    },
    () => paperlessService.checkConnection()
  );

  assert.strictEqual(result.reachable, true, 'The host answered');
  assert.strictEqual(result.authorized, false, 'The token was rejected');
  assert.strictEqual(result.status, 403);
});

testAsync('checkConnection() reports a working connection', async () => {
  const result = await withStubbedClient(
    { get: async () => ({ status: 200, data: { results: [] } }) },
    () => paperlessService.checkConnection()
  );

  assert.deepStrictEqual(result, {
    reachable: true,
    authorized: true,
    status: 200,
    error: null,
  });
});

testAsync('checkConnection() never throws without a client', async () => {
  const result = await withStubbedClient(null, () =>
    paperlessService.checkConnection()
  );

  assert.strictEqual(result.reachable, false);
  assert.strictEqual(result.authorized, false);
  assert.match(result.error, /not configured/i);
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. server.js scheduler wiring
// ──────────────────────────────────────────────────────────────────────────────

const serverSource = fs.readFileSync(
  path.join(process.cwd(), 'server.js'),
  'utf8'
);

test('The Paperless preflight no longer aborts scanning', () => {
  assert.ok(
    !serverSource.includes('Abort scanning'),
    'A failed user-ID lookup must not stop the scheduler from being armed (issue #272)'
  );
});

test('The scan cron is armed before the initial scan is attempted', () => {
  const cronIndex = serverSource.indexOf('cron.schedule(config.scanInterval');
  const initialScanIndex = serverSource.indexOf(
    'runInitialScanWhenReachable().catch('
  );

  assert.ok(cronIndex > -1, 'Expected the scan cron to be scheduled');
  assert.ok(initialScanIndex > -1, 'Expected the initial scan to be started');
  assert.ok(
    cronIndex < initialScanIndex,
    'The scheduler must be armed before Paperless-ngx is contacted'
  );
});

test('The initial scan runs through the guarded scan function', () => {
  assert.ok(
    serverSource.includes("scanDocuments('initial')"),
    'The initial scan must share the concurrency guard and health reporting'
  );
  assert.ok(
    !/\bscanInitial\s*\(/.test(serverSource),
    'The unguarded scanInitial() duplicate must be gone'
  );
});

test('Every scan run probes Paperless-ngx explicitly', () => {
  assert.ok(
    serverSource.includes('paperlessService.checkConnection()'),
    'Read helpers swallow transport errors, so the scan must probe connectivity itself'
  );
});

test('RECONCILIATION_ENABLED=no actually disables reconciliation', () => {
  assert.ok(
    serverSource.includes("config.reconciliationEnabled === 'yes'"),
    'parseEnvBoolean returns the string "no", which is truthy — compare explicitly'
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. /health reporting
// ──────────────────────────────────────────────────────────────────────────────

const setupRouteSource = fs.readFileSync(
  path.join(process.cwd(), 'routes', 'setup.js'),
  'utf8'
);

test('/health reports the scanner state', () => {
  assert.ok(
    setupRouteSource.includes('buildScannerHealthSnapshot()'),
    'Expected /health to include the scanner snapshot'
  );
  assert.ok(
    setupRouteSource.includes("degraded ? 'degraded' : 'healthy'"),
    'Expected /health to expose a degraded status'
  );
});

test('/health answers 503 while degraded unless strict mode is off', () => {
  assert.ok(
    setupRouteSource.includes('scanHealthService.strictHealthEnabled'),
    'Expected HEALTHCHECK_STRICT to gate the 503 response'
  );
  assert.ok(
    /if \(scanHealthService\.strictHealthEnabled\) \{\s*return res\.status\(503\)/.test(
      setupRouteSource
    ),
    'Expected a 503 response for the degraded state in strict mode'
  );
});

// ──────────────────────────────────────────────────────────────────────────────

runAsyncTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
});
