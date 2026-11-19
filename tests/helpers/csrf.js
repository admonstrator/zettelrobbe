'use strict';

/**
 * CSRF headers for a test that drives a running server with a session token.
 *
 * server.js protects every POST/PUT/PATCH/DELETE with double-submit CSRF
 * unless the caller sends the API key. A request with a session token
 * therefore needs the token GET /api/csrf-token hands out plus the cookie it
 * sets, both bound to that session token. Requests with the API key, and GET
 * requests, need neither.
 */

const axios = require('axios');

const CSRF_COOKIE = 'psai.x-csrf-token';

/**
 * @param {string} baseUrl the server, e.g. http://localhost:3000
 * @param {Record<string, string>} authHeaders the caller's own auth headers
 * @returns {Promise<Record<string, string>>} headers to merge into a request
 */
async function csrfHeaders(baseUrl, authHeaders) {
  const response = await axios.get(`${baseUrl}/api/csrf-token`, {
    headers: authHeaders,
    validateStatus: () => true,
    maxRedirects: 0,
  });
  // The CSRF middleware already issues a cookie for every request and the
  // route issues another one with the token it returns; like a browser, the
  // last Set-Cookie wins.
  const cookie = (response.headers['set-cookie'] || [])
    .map((entry) => entry.split(';')[0])
    .filter((entry) => entry.startsWith(`${CSRF_COOKIE}=`))
    .pop();
  const token = response.data && response.data.csrfToken;
  if (response.status !== 200 || !cookie || !token) {
    throw new Error(
      `GET /api/csrf-token did not hand out a token (HTTP ${response.status})`
    );
  }
  return { 'x-csrf-token': token, Cookie: cookie };
}

/** True when a request with these auth headers must carry CSRF headers. */
function needsCsrf(method, authHeaders) {
  return (
    !['get', 'head', 'options'].includes(String(method).toLowerCase()) &&
    !(authHeaders && authHeaders['x-api-key'])
  );
}

module.exports = { csrfHeaders, needsCsrf };
