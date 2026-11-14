/**
 * Setup Protected Endpoint Integration Test
 *
 * Validates:
 * 1. Unauthenticated requests to protected setup endpoints are rejected
 * 2. Authenticated requests can pass middleware checks
 *
 * Environment:
 * - BASE_URL (optional, default: http://localhost:3000)
 * - JWT_TOKEN (optional, recommended for non-destructive authenticated checks)
 * - API_KEY or PAPERLESS_AI_API_KEY (optional)
 * - ALLOW_KEY_REGENERATE_TEST=true (optional; enables authenticated key regeneration call)
 */

const axios = require('axios');
const { csrfHeaders, needsCsrf } = require('./helpers/csrf');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const JWT_TOKEN = process.env.JWT_TOKEN || null;
const API_KEY = process.env.API_KEY || process.env.PAPERLESS_AI_API_KEY || null;
const ALLOW_KEY_REGENERATE_TEST =
  String(process.env.ALLOW_KEY_REGENERATE_TEST || '')
    .trim()
    .toLowerCase() === 'true';

function authHeaders(prefer = 'jwt') {
  if (prefer === 'jwt' && JWT_TOKEN) {
    return { Authorization: `Bearer ${JWT_TOKEN}` };
  }

  if (API_KEY) {
    return { 'x-api-key': API_KEY };
  }

  if (JWT_TOKEN) {
    return { Authorization: `Bearer ${JWT_TOKEN}` };
  }

  return {};
}

async function apiRequest(method, routePath, body, headers = {}) {
  const hasAuth = Boolean(headers['x-api-key'] || headers.Authorization);
  const csrf =
    hasAuth && needsCsrf(method, headers)
      ? await csrfHeaders(BASE_URL, headers)
      : {};
  return axios({
    method,
    url: `${BASE_URL}${routePath}`,
    data: body,
    headers: {
      ...headers,
      ...csrf,
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
    maxRedirects: 0,
  });
}

function isRejectedAsUnauthenticated(response) {
  if (
    response.status === 302 &&
    String(response.headers.location || '') === '/login'
  ) {
    return true;
  }

  if (response.status === 401 || response.status === 403) {
    return true;
  }

  return false;
}

async function runTests() {
  console.log('\n==========================================');
  console.log('Setup Protected Endpoint Integration Test');
  console.log('==========================================');
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(
    `Auth available: ${JWT_TOKEN ? 'JWT' : API_KEY ? 'API key' : 'none'}`
  );

  const unauthKeyRegen = await apiRequest('post', '/api/key-regenerate', {});
  if (!isRejectedAsUnauthenticated(unauthKeyRegen)) {
    throw new Error(
      `Expected unauthenticated /api/key-regenerate to be rejected, got HTTP ${unauthKeyRegen.status}`
    );
  }
  console.log('[OK] Unauthenticated /api/key-regenerate request is rejected');

  const unauthWebhook = await apiRequest('post', '/api/webhook/document', {});
  if (!isRejectedAsUnauthenticated(unauthWebhook)) {
    throw new Error(
      `Expected unauthenticated /api/webhook/document to be rejected, got HTTP ${unauthWebhook.status}`
    );
  }
  console.log('[OK] Unauthenticated /api/webhook/document request is rejected');

  const availableAuthHeaders = authHeaders('jwt');
  const hasAuth = Boolean(Object.keys(availableAuthHeaders).length > 0);
  if (!hasAuth) {
    console.log(
      '[SKIP] No JWT_TOKEN or API_KEY/PAPERLESS_AI_API_KEY provided; skipping authenticated checks'
    );
    console.log(
      '[RESULT] Setup endpoint auth protection test passed (unauthenticated checks only)'
    );
    return;
  }

  const authWebhook = await apiRequest(
    'post',
    '/api/webhook/document',
    {},
    availableAuthHeaders
  );
  if (isRejectedAsUnauthenticated(authWebhook)) {
    throw new Error(
      `Expected authenticated /api/webhook/document to pass auth gate, got HTTP ${authWebhook.status}`
    );
  }
  if (authWebhook.status !== 400) {
    throw new Error(
      `Expected authenticated empty webhook body to return HTTP 400, got ${authWebhook.status}`
    );
  }
  console.log('[OK] Authenticated /api/webhook/document passes auth gate');

  if (JWT_TOKEN && ALLOW_KEY_REGENERATE_TEST) {
    const authKeyRegen = await apiRequest(
      'post',
      '/api/key-regenerate',
      {},
      authHeaders('jwt')
    );
    if (isRejectedAsUnauthenticated(authKeyRegen)) {
      throw new Error(
        `Expected authenticated /api/key-regenerate to pass auth gate, got HTTP ${authKeyRegen.status}`
      );
    }
    if (
      authKeyRegen.status !== 200 ||
      authKeyRegen.data?.success !== true ||
      typeof authKeyRegen.data?.newKey !== 'string'
    ) {
      throw new Error(
        `Expected authenticated /api/key-regenerate to succeed, got HTTP ${authKeyRegen.status}`
      );
    }
    console.log(
      '[OK] Authenticated /api/key-regenerate succeeds (destructive check enabled)'
    );
  } else {
    console.log(
      '[SKIP] Authenticated /api/key-regenerate success check skipped (set JWT_TOKEN + ALLOW_KEY_REGENERATE_TEST=true to enable)'
    );
  }

  console.log('[RESULT] Setup endpoint auth protection test passed');
}

if (require.main === module) {
  runTests().catch((error) => {
    console.error('[FAIL]', error.message);
    process.exit(1);
  });
}
