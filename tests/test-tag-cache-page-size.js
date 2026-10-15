/**
 * Test: tag cache refresh page size
 *
 * refreshTagCache() walked /tags/ without asking for a page size, so it got
 * Paperless-ngx's default of 25. An instance with 1331 tags therefore spent 54
 * sequential round trips — 42 seconds — rebuilding a cache that every tag
 * lookup in the app waits on. The dashboard statistics are one of those
 * callers: getEffectiveDocumentCount() resolves the configured TAGS through the
 * cache, so a dashboard opened during the startup scan joined that refresh and
 * the browser gave up at its own 15s deadline.
 *
 * Covers:
 * 1. The first request asks for a page size far above the server default
 * 2. Following pages are taken from the `next` link, which carries it forward
 * 3. Every tag ends up in the cache, whatever the paging
 */

'use strict';

const assert = require('assert');
const paperlessService = require('../services/paperlessService');

let passed = 0;
let failed = 0;

async function test(name, fn) {
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

const BASE_URL = 'http://paperless.test/api';

/**
 * A Paperless-ngx that honours page_size the way DRF does: it clamps to its own
 * maximum instead of rejecting, and builds `next` from the request URL so the
 * parameter survives into every following page.
 */
function createTagServer({ tagCount, maxPageSize = 100000 }) {
  const requests = [];

  return {
    requests,
    defaults: { baseURL: BASE_URL },
    get: async (url, options = {}) => {
      // Merge axios-style params into the query string, as axios itself would.
      const merged = new URL(url, BASE_URL);
      if (options.params) {
        for (const [key, value] of Object.entries(options.params)) {
          merged.searchParams.set(key, String(value));
        }
      }
      requests.push(merged.pathname + merged.search);
      const parsed = merged;
      const requested = Number(parsed.searchParams.get('page_size')) || 25;
      const pageSize = Math.min(requested, maxPageSize);
      const page = Number(parsed.searchParams.get('page')) || 1;

      const start = (page - 1) * pageSize;
      const results = [];
      for (let i = start; i < Math.min(start + pageSize, tagCount); i += 1) {
        results.push({ id: i + 1, name: `tag-${i + 1}` });
      }

      const hasNext = start + pageSize < tagCount;
      const nextParams = new URLSearchParams(parsed.searchParams);
      nextParams.set('page', String(page + 1));

      return {
        data: {
          results,
          next: hasNext ? `${BASE_URL}/tags/?${nextParams.toString()}` : null,
        },
      };
    },
  };
}

(async () => {
  const originalClient = paperlessService.client;

  try {
    await test('The tag cache is not rebuilt 25 tags at a time', async () => {
      const server = createTagServer({ tagCount: 1331 });
      paperlessService.client = server;
      paperlessService.tags._clear();
      paperlessService.tags.cache_last_fetch_time = 0;

      await paperlessService.refreshTagCache();

      assert.strictEqual(
        paperlessService.tags.element_list.length,
        1331,
        'Every tag has to reach the cache'
      );
      // 1331 tags at the old default of 25 meant 54 requests.
      assert.ok(
        server.requests.length <= 3,
        `A few thousand tags must not cost a round trip each — took ${server.requests.length} requests`
      );

      const first = new URL(server.requests[0], BASE_URL);
      assert.ok(
        Number(first.searchParams.get('page_size')) >= 100,
        'The first request has to ask for a page size, or the server pages at 25'
      );
    });

    await test('The page size carries into every following page', async () => {
      const server = createTagServer({ tagCount: 1331 });
      paperlessService.client = server;
      paperlessService.tags._clear();
      paperlessService.tags.cache_last_fetch_time = 0;

      await paperlessService.refreshTagCache();

      const sizes = server.requests.map((url) =>
        Number(new URL(url, BASE_URL).searchParams.get('page_size'))
      );
      assert.ok(
        sizes.every((size) => size === sizes[0]),
        `Every page has to keep the size the first one asked for, got ${sizes.join(', ')}`
      );
    });

    await test('A server that clamps the page size is still paged through', async () => {
      // Nothing may depend on getting the size it asked for: DRF answers with
      // its own maximum and says so only through the shorter result list.
      const server = createTagServer({ tagCount: 1331, maxPageSize: 100 });
      paperlessService.client = server;
      paperlessService.tags._clear();
      paperlessService.tags.cache_last_fetch_time = 0;

      await paperlessService.refreshTagCache();

      assert.strictEqual(
        paperlessService.tags.element_list.length,
        1331,
        'A clamped page size must not lose tags'
      );
      assert.strictEqual(server.requests.length, 14, '1331 tags at 100 a page');
    });
  } finally {
    paperlessService.client = originalClient;
    paperlessService.tags._clear();
    paperlessService.tags.cache_last_fetch_time = 0;
    paperlessService.tags.cache_last_fetch_time = 0;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
