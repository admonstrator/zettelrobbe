/**
 * Quickstart Endpoint Protection Integration Test
 *
 * Validates:
 * 1. Unauthenticated requests to /api/settings/quickstart/detect are rejected
 * 2. /api/setup/quickstart/detect is closed once initial setup is complete
 *
 * Environment:
 * - BASE_URL (optional, default: http://localhost:3000)
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function apiRequest(method, routePath, body, headers = {}) {
  return axios({
    method,
    url: `${BASE_URL}${routePath}`,
    data: body,
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    },
    validateStatus: () => true,
    maxRedirects: 0
  });
}

function isRejectedAsUnauthenticated(response) {
  if (response.status === 302 && String(response.headers.location || '') === '/login') {
    return true;
  }

  return response.status === 401 || response.status === 403;
}

async function runTests() {
  console.log('\n==========================================');
  console.log('Quickstart Endpoint Protection Integration Test');
  console.log('==========================================');
  console.log(`BASE_URL: ${BASE_URL}`);

  const unauthSettingsDetect = await apiRequest('post', '/api/settings/quickstart/detect', {
    baseUrl: 'http://192.0.2.1:11434'
  });
  if (!isRejectedAsUnauthenticated(unauthSettingsDetect)) {
    throw new Error(`Expected unauthenticated /api/settings/quickstart/detect to be rejected, got HTTP ${unauthSettingsDetect.status}`);
  }
  console.log('[OK] Unauthenticated /api/settings/quickstart/detect request is rejected');

  // On a configured instance the setup-scoped endpoint must be closed (403).
  // On an unconfigured instance it is open by design, so a non-403 answer is
  // only acceptable when setup is still available.
  const setupDetect = await apiRequest('post', '/api/setup/quickstart/detect', {
    baseUrl: 'http://192.0.2.1:11434'
  });
  const setupPage = await apiRequest('get', '/setup');
  const setupIsOpen = setupPage.status === 200;

  if (!setupIsOpen && setupDetect.status !== 403) {
    throw new Error(`Expected /api/setup/quickstart/detect to be closed (403) on a configured instance, got HTTP ${setupDetect.status}`);
  }
  console.log(
    setupIsOpen
      ? '[OK] /api/setup/quickstart/detect is reachable while setup is open (expected)'
      : '[OK] /api/setup/quickstart/detect is closed on a configured instance'
  );

  console.log('[RESULT] Quickstart endpoint protection test passed');
}

if (require.main === module) {
  runTests().catch((error) => {
    console.error('[FAIL]', error.message);
    process.exit(1);
  });
}
