const assert = require('assert');
const { resolvePaperlessConnection } = require('../services/settingsService');

/*
 * POST /settings keeps the stored Paperless-ngx URL when the form leaves the
 * field out (a field pinned by the environment is disabled and not
 * submitted), tests the connection only when the URL changes or a token is
 * typed, and writes the URL only when one was submitted.
 */
function main() {
  const current = {
    PAPERLESS_API_URL: 'http://paperless.local:8000/api',
    PAPERLESS_API_TOKEN: 'stored-token',
  };

  // URL omitted: the stored one, without /api, is the effective URL.
  const omitted = resolvePaperlessConnection({}, current);
  assert.strictEqual(omitted.url, 'http://paperless.local:8000');
  assert.strictEqual(omitted.token, 'stored-token');
  assert.strictEqual(omitted.needsValidation, false);
  assert.deepStrictEqual(omitted.updates, {});

  // Blank URL counts as omitted.
  const blank = resolvePaperlessConnection({ paperlessUrl: '   ' }, current);
  assert.strictEqual(blank.url, 'http://paperless.local:8000');
  assert.deepStrictEqual(blank.updates, {});

  // URL omitted but a token typed: validated against the stored URL.
  const tokenOnly = resolvePaperlessConnection(
    { paperlessToken: ' new-token ' },
    current
  );
  assert.strictEqual(tokenOnly.url, 'http://paperless.local:8000');
  assert.strictEqual(tokenOnly.token, 'new-token');
  assert.strictEqual(tokenOnly.needsValidation, true);
  assert.deepStrictEqual(tokenOnly.updates, {
    PAPERLESS_API_TOKEN: 'new-token',
  });

  // The same URL as stored: saved, but not tested again.
  const same = resolvePaperlessConnection(
    { paperlessUrl: 'http://paperless.local:8000' },
    current
  );
  assert.strictEqual(same.needsValidation, false);
  assert.deepStrictEqual(same.updates, {
    PAPERLESS_API_URL: 'http://paperless.local:8000',
  });

  // A new URL: tested with the stored token, then saved.
  const changed = resolvePaperlessConnection(
    { paperlessUrl: 'http://other:8000' },
    current
  );
  assert.strictEqual(changed.url, 'http://other:8000');
  assert.strictEqual(changed.token, 'stored-token');
  assert.strictEqual(changed.needsValidation, true);
  assert.deepStrictEqual(changed.updates, {
    PAPERLESS_API_URL: 'http://other:8000',
  });

  console.log(
    '[PASS] POST /settings keeps effective Paperless URL fallback for managed/omitted paperlessUrl input'
  );
}

try {
  main();
} catch (error) {
  console.error(
    '[FAIL] Settings paperless URL fallback regression failed:',
    error.message
  );
  process.exitCode = 1;
}
