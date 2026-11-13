/**
 * Scan Start/Stop/Restart Integration Test
 *
 * Validates:
 * 1. Manual scan can be started via API
 * 2. Active scan can be stopped gracefully via API
 * 3. A new scan can be started again after stop completes
 *
 * Environment:
 * - BASE_URL (optional, default: http://localhost:3000)
 * - JWT_TOKEN (optional if API_KEY provided)
 * - API_KEY or PAPERLESS_AI_API_KEY (optional if JWT_TOKEN provided)
 */

const axios = require('axios');
const { csrfHeaders, needsCsrf } = require('./helpers/csrf');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const JWT_TOKEN = process.env.JWT_TOKEN || null;
const API_KEY = process.env.API_KEY || process.env.PAPERLESS_AI_API_KEY || null;

const POLL_INTERVAL_MS = parseInt(
  process.env.SCAN_STOP_POLL_INTERVAL_MS || '500',
  10
);
const POLL_TIMEOUT_MS = parseInt(
  process.env.SCAN_STOP_TIMEOUT_MS || '120000',
  10
);

function authHeaders() {
  if (JWT_TOKEN) {
    return { Authorization: `Bearer ${JWT_TOKEN}` };
  }

  if (API_KEY) {
    return { 'x-api-key': API_KEY };
  }

  return {};
}

async function apiRequest(method, path, body) {
  const auth = authHeaders();
  const csrf = needsCsrf(method, auth) ? await csrfHeaders(BASE_URL, auth) : {};
  return axios({
    method,
    url: `${BASE_URL}${path}`,
    data: body,
    headers: {
      ...auth,
      ...csrf,
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
    maxRedirects: 0,
  });
}

async function waitForScanToBecomeIdle() {
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const statusRes = await apiRequest('get', '/api/processing-status');
    if (statusRes.status !== 200) {
      throw new Error(`processing-status returned HTTP ${statusRes.status}`);
    }

    const data = statusRes.data || {};
    const isScanning = Boolean(data.isScanning || data.currentlyProcessing);

    if (!isScanning) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`scan did not become idle within ${POLL_TIMEOUT_MS}ms`);
}

async function startScan() {
  const response = await apiRequest('post', '/api/scan/now', {});

  // When setup is incomplete the endpoint intentionally rejects scan start.
  if (
    response.status === 400 &&
    String(response.data?.error || '')
      .toLowerCase()
      .includes('setup not completed')
  ) {
    return { skipped: true, reason: 'setup not completed' };
  }

  if (response.status !== 200) {
    throw new Error(`scan start failed with HTTP ${response.status}`);
  }

  if (!response.data || response.data.success !== true) {
    throw new Error('scan start response did not contain success=true');
  }

  return { skipped: false, data: response.data };
}

async function stopScan() {
  const response = await apiRequest('post', '/api/scan/stop', {});

  if (response.status !== 200) {
    throw new Error(`scan stop failed with HTTP ${response.status}`);
  }

  if (!response.data || response.data.success !== true) {
    throw new Error('scan stop response did not contain success=true');
  }

  return response.data;
}

async function runTests() {
  console.log('\n========================================');
  console.log('Scan Start/Stop/Restart Integration Test');
  console.log('========================================');
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`Auth: ${JWT_TOKEN ? 'JWT' : API_KEY ? 'API key' : 'none'}`);

  const startResult = await startScan();
  if (startResult.skipped) {
    console.log(`[SKIP] ${startResult.reason}`);
    process.exit(0);
  }

  console.log(
    `[INFO] First start response: started=${Boolean(startResult.data.started)} running=${Boolean(startResult.data.running)}`
  );

  const stopResult = await stopScan();
  console.log(
    `[INFO] Stop response: running=${Boolean(stopResult.running)} stopRequested=${Boolean(stopResult.stopRequested)}`
  );

  await waitForScanToBecomeIdle();
  console.log('[OK] Scan became idle after stop request');

  const restartResult = await startScan();
  if (restartResult.skipped) {
    console.log(`[SKIP] ${restartResult.reason}`);
    process.exit(0);
  }

  console.log(
    `[INFO] Restart response: started=${Boolean(restartResult.data.started)} running=${Boolean(restartResult.data.running)}`
  );

  await stopScan();
  await waitForScanToBecomeIdle();
  console.log('[OK] Restarted scan could also be stopped and became idle');

  console.log('[RESULT] Scan start/stop/restart flow passed');
}

if (require.main === module) {
  runTests().catch((error) => {
    console.error('[FAIL]', error.message);
    process.exit(1);
  });
}
