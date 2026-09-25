const assert = require('assert');

/**
 * Regression test for the omnibox metadata lookup.
 *
 * Resolving tag and correspondent names used to issue one detail request per
 * ID (GET /tags/{id}/, GET /correspondents/{id}/), which flooded Paperless-ngx
 * with hundreds of parallel requests per search and made it answer with 500s.
 * Names must now come from the shared tag cache and a single batched
 * correspondent request.
 */
async function run() {
  const paperlessService = require('../services/paperlessService');
  const documentsService = require('../services/documentsService');

  const originalClient = paperlessService.client;
  const originalTagCache = paperlessService.tagCache;
  const originalLastTagRefresh = paperlessService.lastTagRefresh;
  const originalCorrespondentCache = paperlessService.correspondentNameCache;
  const originalLastCorrespondentRefresh =
    paperlessService.lastCorrespondentRefresh;
  const originalSupportsIdIn = paperlessService._supportsCorrespondentIdIn;

  try {
    const calls = [];

    const makeClient = ({ honourIdIn = true } = {}) => ({
      get: async (url, options = {}) => {
        calls.push({ url, params: options.params || {} });

        // Matched by path, not by the whole string: the tag cache refresh asks
        // for a page size, and a mock that insists on a bare "/tags/" turns
        // that into a failure of this test rather than of the caller.
        const path = url.split('?')[0];

        if (path === '/tags/') {
          return {
            data: {
              results: [
                { id: 11, name: 'Invoice' },
                { id: 12, name: 'Contract' },
              ],
              next: null,
            },
          };
        }

        if (path === '/correspondents/') {
          const all = [
            { id: 21, name: 'Acme Corp' },
            { id: 22, name: 'City Council' },
            { id: 23, name: 'Unrelated Sender' },
          ];

          if (!honourIdIn) {
            // Mimics a Paperless-ngx build that silently ignores id__in.
            return { data: { results: all, next: null } };
          }

          const requested = new Set(
            String(options.params?.id__in || '')
              .split(',')
              .filter(Boolean)
              .map(Number)
          );
          return {
            data: {
              results: all.filter((entry) => requested.has(entry.id)),
              next: null,
            },
          };
        }

        throw new Error(`Unexpected URL in mock: ${url}`);
      },
    });

    const resetCaches = () => {
      paperlessService.tagCache = new Map();
      paperlessService.lastTagRefresh = 0;
      paperlessService.correspondentNameCache = new Map();
      paperlessService.lastCorrespondentRefresh = 0;
      paperlessService._supportsCorrespondentIdIn = null;
    };

    // ── Batched lookup ────────────────────────────────────────────────────
    resetCaches();
    paperlessService.client = makeClient();
    calls.length = 0;

    const tagNames = await documentsService.getTagNames([11, 12, 11, 12, 11]);
    const correspondentNames = await documentsService.getCorrespondentNames([
      21, 22, 21, 22,
    ]);

    assert.deepStrictEqual(tagNames, { 11: 'Invoice', 12: 'Contract' });
    assert.deepStrictEqual(correspondentNames, {
      21: 'Acme Corp',
      22: 'City Council',
    });

    assert.strictEqual(
      calls.filter((call) => /^\/tags\/\d+\//.test(call.url)).length,
      0,
      'tag names must not be resolved with per-ID detail requests'
    );
    assert.strictEqual(
      calls.filter((call) => /^\/correspondents\/\d+\//.test(call.url)).length,
      0,
      'correspondent names must not be resolved with per-ID detail requests'
    );
    assert.strictEqual(
      calls.filter((call) => call.url === '/correspondents/').length,
      1,
      'all correspondent names must come from a single batched request'
    );

    // ── Cached follow-up searches ─────────────────────────────────────────
    calls.length = 0;
    await documentsService.getTagNames([11, 12]);
    await documentsService.getCorrespondentNames([21, 22]);
    assert.strictEqual(
      calls.length,
      0,
      'a repeated lookup must be served from the caches'
    );

    // ── Documents without a correspondent ─────────────────────────────────
    calls.length = 0;
    const emptyNames = await documentsService.getCorrespondentNames([
      null,
      undefined,
      0,
      '',
    ]);
    assert.deepStrictEqual(
      emptyNames,
      {},
      'missing correspondents must not be looked up'
    );
    assert.strictEqual(
      calls.length,
      0,
      'Number(null) === 0 must not trigger a request for correspondent 0'
    );

    // ── Fallback when id__in is not supported ─────────────────────────────
    resetCaches();
    paperlessService.client = makeClient({ honourIdIn: false });
    calls.length = 0;

    const fallbackNames = await documentsService.getCorrespondentNames([
      21, 23,
    ]);
    assert.deepStrictEqual(fallbackNames, {
      21: 'Acme Corp',
      23: 'Unrelated Sender',
    });
    assert.strictEqual(
      paperlessService._supportsCorrespondentIdIn,
      false,
      'an ignored id__in filter must be detected'
    );
    assert.strictEqual(
      calls.filter((call) => /^\/correspondents\/\d+\//.test(call.url)).length,
      0,
      'the fallback must list correspondents instead of fetching them one by one'
    );

    // ── Unresolvable IDs must not be retried on every search ──────────────
    // Without negative caching this repeats the full listing per search.
    calls.length = 0;
    const unknownFirst = await documentsService.getCorrespondentNames([9999]);
    const callsAfterFirstMiss = calls.length;
    const unknownSecond = await documentsService.getCorrespondentNames([9999]);

    assert.deepStrictEqual(
      unknownFirst,
      {},
      'an unresolvable correspondent must not produce a placeholder name'
    );
    assert.deepStrictEqual(unknownSecond, {});
    assert.ok(
      callsAfterFirstMiss > 0,
      'the first lookup of an unknown ID should still hit Paperless'
    );
    assert.strictEqual(
      calls.length,
      callsAfterFirstMiss,
      'a repeated lookup of an unresolvable ID must be served from the cache'
    );

    // ── A failed lookup must not poison the cache ─────────────────────────
    resetCaches();
    paperlessService.client = {
      get: async (url) => {
        calls.push({ url, params: {} });
        throw new Error('Network unreachable');
      },
    };
    calls.length = 0;

    const duringOutage = await documentsService.getCorrespondentNames([21]);
    assert.deepStrictEqual(duringOutage, {});
    assert.strictEqual(
      paperlessService.correspondentNameCache.has(21),
      false,
      'a transient failure must not be cached as a permanent miss'
    );

    console.log('PASS test-document-metadata-batching');
  } finally {
    paperlessService.client = originalClient;
    paperlessService.tagCache = originalTagCache;
    paperlessService.lastTagRefresh = originalLastTagRefresh;
    paperlessService.correspondentNameCache = originalCorrespondentCache;
    paperlessService.lastCorrespondentRefresh =
      originalLastCorrespondentRefresh;
    paperlessService._supportsCorrespondentIdIn = originalSupportsIdIn;
  }
}

run().catch((error) => {
  console.error('FAIL test-document-metadata-batching');
  console.error(error);
  process.exit(1);
});
