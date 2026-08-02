const assert = require('assert');

/**
 * Unit tests for paperlessService.searchDocuments mode=id exact lookup.
 * No live Paperless instance required — the HTTP client is mocked.
 */
async function run() {
  const paperlessService = require('../services/paperlessService');
  const originalClient = paperlessService.client;
  const originalConsoleError = console.error;

  try {
    const calls = [];
    const errorLogs = [];
    console.error = (...args) => {
      errorLogs.push(args.map(String).join(' '));
    };

    paperlessService.client = {
      get: async (url) => {
        calls.push(url);
        if (url === '/documents/1431/') {
          return {
            data: {
              id: 1431,
              title: 'Exact ID Document',
              tags: [1],
              correspondent: 9,
              created: '2024-01-15T00:00:00Z'
            }
          };
        }
        if (url === '/documents/40404/') {
          const error = new Error('Not Found');
          error.response = { status: 404 };
          throw error;
        }
        if (url === '/documents/50001/') {
          const error = new Error('Server Error');
          error.response = { status: 500 };
          throw error;
        }
        throw new Error(`Unexpected URL in mock: ${url}`);
      }
    };

    // Exact hit
    calls.length = 0;
    const found = await paperlessService.searchDocuments('1431', 100, 'id');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].id, 1431);
    assert.strictEqual(found[0].title, 'Exact ID Document');
    assert.deepStrictEqual(calls, ['/documents/1431/']);

    // Missing document (404 is quiet)
    calls.length = 0;
    errorLogs.length = 0;
    const missing = await paperlessService.searchDocuments('40404', 100, 'id');
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual(calls, ['/documents/40404/']);
    assert.strictEqual(errorLogs.length, 0, '404 must not log an error');

    // Non-404 HTTP failure: log and return [] without throwing
    calls.length = 0;
    errorLogs.length = 0;
    const serverError = await paperlessService.searchDocuments('50001', 100, 'id');
    assert.deepStrictEqual(serverError, []);
    assert.deepStrictEqual(calls, ['/documents/50001/']);
    assert.ok(
      errorLogs.some((line) => line.includes('50001')),
      'non-404 failures should be logged'
    );

    // Reject non-integer / non-positive / malformed input without calling Paperless
    calls.length = 0;
    const invalidInputs = ['14a', '0', '', '01431', '-1', '12.3', '+1431'];
    for (const input of invalidInputs) {
      // eslint-disable-next-line no-await-in-loop
      const result = await paperlessService.searchDocuments(input, 100, 'id');
      assert.deepStrictEqual(result, [], `expected empty results for invalid id input: ${JSON.stringify(input)}`);
    }
    assert.deepStrictEqual(calls, [], 'invalid id inputs must not hit Paperless');

    // Leading/trailing whitespace is trimmed before validation (still a valid ID)
    calls.length = 0;
    const trimmed = await paperlessService.searchDocuments(' 1431 ', 100, 'id');
    assert.strictEqual(trimmed.length, 1);
    assert.strictEqual(trimmed[0].id, 1431);
    assert.deepStrictEqual(calls, ['/documents/1431/']);

    console.log('PASS test-search-documents-exact-id');
  } finally {
    console.error = originalConsoleError;
    paperlessService.client = originalClient;
  }
}

run().catch((error) => {
  console.error('FAIL test-search-documents-exact-id');
  console.error(error);
  process.exit(1);
});
