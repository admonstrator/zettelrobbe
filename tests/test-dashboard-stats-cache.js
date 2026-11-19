/**
 * Test: dashboard statistics cache
 *
 * /api/dashboard/stats rebuilt its whole payload per request — two uncached
 * Paperless-ngx round trips plus a dozen SQLite queries, one of which read
 * every openai_metrics row into memory. The dashboard polls that endpoint, and
 * every open tab polls it separately, so the cost grew with the number of
 * viewers while the numbers only change when a document is processed.
 *
 * Covers:
 * 1. The payload keeps its shape and is built from the aggregate query
 * 2. Concurrent readers share one build
 * 3. A fresh cache is served without rebuilding, an expired one is not
 * 4. invalidate() forces the next reader to rebuild, and survives a build that
 *    is already running
 * 5. A failed rebuild keeps the last good payload and backs off — including on
 *    a cold start, and including a build that never answers at all
 * 6. The endpoint is a thin read of the cache, and no Paperless-ngx client is
 *    built without a request timeout
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readRouteSources } = require('./helpers/route-sources');
const Module = require('module');

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

// ──────────────────────────────────────────────────────────────────────────────
// Load the service with both collaborators replaced — no test may reach the
// network or the database
// ──────────────────────────────────────────────────────────────────────────────

const counts = {
  tagCount: 0,
  correspondentCount: 0,
  effectiveDocumentCount: 0,
  metricsSummary: 0,
};

/* Flipped by the outage test. The fakes mirror the real helpers: without
   `strict` a failed lookup is reported as 0, with it the caller gets the
   error — which is the whole difference between a dashboard that says "not
   loaded" and one that confidently says "no documents". */
let paperlessDown = false;

function fakeCount(value) {
  return async ({ strict = false } = {}) => {
    if (!paperlessDown) return value;
    if (strict) throw new Error('Paperless-ngx unreachable');
    return 0;
  };
}

const fakePaperlessService = {
  getTagCount: async (options) => {
    counts.tagCount += 1;
    return fakeCount(12)(options);
  },
  getCorrespondentCount: async (options) => {
    counts.correspondentCount += 1;
    return fakeCount(5)(options);
  },
  getEffectiveDocumentCount: async (options) => {
    counts.effectiveDocumentCount += 1;
    return fakeCount(100)(options);
  },
};

const fakeDocumentModel = {
  getProcessedDocumentsCount: async () => 80,
  getOcrQueueCount: async () => 4,
  getOcrFailedCount: async () => 1,
  getFailedProcessingCount: async () => 3,
  getMetricsSummary: async () => {
    counts.metricsSummary += 1;
    return {
      averagePromptTokens: 10,
      averageCompletionTokens: 4,
      averageTotalTokens: 14,
      tokensOverall: 1400,
    };
  },
  // Reading every metrics row to average it in JavaScript is the cost this
  // change removes; using it again should fail loudly.
  getMetrics: async () => {
    throw new Error('getMetrics() must not be used to build the dashboard');
  },
  getProcessingTimeStats: async () => [{ hour: '09', count: 2 }],
  getTokenDistribution: async () => [{ range: '0-1k', count: 2 }],
  getDocumentTypeStats: async () => [{ type: 'Invoice', count: 2 }],
  getTokenTrend: async () => [
    { day: '2026-08-13', documents: '2', totalTokens: '30' },
  ],
  getRecentHistoryDocuments: async () => [
    { documentId: '7', title: '', correspondent: '', createdAt: 'now' },
  ],
  getLanguageDistribution: async () => [{ language: '', count: '3' }],
  getCurrentProcessingStatus: async () => ({ processedToday: '6' }),
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './paperlessService') return fakePaperlessService;
  if (request === '../models/document') return fakeDocumentModel;
  return originalLoad(request, parent, isMain);
};

const dashboardStatsService = require('../services/dashboardStatsService');
const config = require('../config/config');

Module._load = originalLoad;

const originalStatsCacheTTL = config.statsCacheTTL;

function reset() {
  Object.keys(counts).forEach((key) => {
    counts[key] = 0;
  });
  dashboardStatsService.reset();
  restoreBuild();
  paperlessDown = false;
  config.statsCacheTTL = originalStatsCacheTTL;
}

// buildStats lives on the prototype, so deleting the own property restores it.
function stubBuild(fn) {
  dashboardStatsService.buildStats = fn;
}

function restoreBuild() {
  delete dashboardStatsService.buildStats;
}

/* The build deadline is unref'd, so in production it can never be the reason a
   process stays up. A test that stubs a build which never answers has nothing
   else holding the loop open, and node would exit before the deadline fires —
   silently ending the run mid-file. This keeps it open for that one test. */
function holdEventLoopOpen() {
  const handle = setInterval(() => {}, 10);
  return () => clearInterval(handle);
}

(async () => {
  try {
    // ──────────────────────────────────────────────────────────────────────────
    // 1. Payload
    // ──────────────────────────────────────────────────────────────────────────

    await test('The cached payload keeps the shape the dashboard expects', async () => {
      reset();
      const { payload, cachedAt } = await dashboardStatsService.getStats();

      assert.strictEqual(payload.success, true);
      assert.strictEqual(counts.metricsSummary, 1, 'One aggregate query only');
      assert.deepStrictEqual(payload.openai_data, {
        averagePromptTokens: 10,
        averageCompletionTokens: 4,
        averageTotalTokens: 14,
        tokensOverall: 1400,
      });

      const data = payload.paperless_data;
      assert.strictEqual(data.tagCount, 12);
      assert.strictEqual(data.correspondentCount, 5);
      assert.strictEqual(data.documentCount, 100);
      assert.strictEqual(data.processedDocumentCount, 80);
      assert.strictEqual(data.ocrNeededCount, 4);
      assert.strictEqual(data.failedCount, 4, 'OCR plus processing failures');
      assert.strictEqual(data.queueBacklog, 8);
      assert.strictEqual(data.processingEfficiencyRate, 95);
      assert.strictEqual(data.failedRate, 5);
      assert.strictEqual(data.processedToday, 6);

      assert.deepStrictEqual(data.tokenTrend, [
        { day: '2026-08-13', documents: 2, totalTokens: 30 },
      ]);
      assert.deepStrictEqual(data.recentActivity, [
        {
          documentId: 7,
          title: 'Untitled document',
          correspondent: 'Unknown correspondent',
          createdAt: 'now',
          language: 'Unknown',
        },
      ]);
      assert.deepStrictEqual(data.languageDistribution, [
        { language: 'Unknown', count: 3 },
      ]);

      assert.ok(cachedAt > 0, 'The response has to say how old the data is');
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 2. Single flight
    // ──────────────────────────────────────────────────────────────────────────

    await test('Concurrent readers share a single build', async () => {
      reset();
      const results = await Promise.all([
        dashboardStatsService.getStats(),
        dashboardStatsService.getStats(),
        dashboardStatsService.getStats(),
      ]);

      assert.strictEqual(
        counts.tagCount,
        1,
        'Three viewers must not mean three rounds of Paperless calls'
      );
      assert.strictEqual(counts.effectiveDocumentCount, 1);
      results.forEach((result) =>
        assert.strictEqual(result.payload.paperless_data.tagCount, 12)
      );
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 3. TTL
    // ──────────────────────────────────────────────────────────────────────────

    await test('A fresh cache is served without rebuilding', async () => {
      reset();
      const first = await dashboardStatsService.getStats();
      const second = await dashboardStatsService.getStats();

      assert.strictEqual(counts.tagCount, 1, 'Polling must not rebuild');
      assert.strictEqual(second.payload, first.payload, 'Same object served');
      assert.strictEqual(second.cachedAt, first.cachedAt);
    });

    await test('An expired cache is rebuilt, and the TTL comes from config', async () => {
      reset();
      config.statsCacheTTL = 30;
      assert.strictEqual(
        dashboardStatsService.ttlMs,
        30000,
        'STATS_CACHE_TTL_SECONDS has to be readable at runtime'
      );

      await dashboardStatsService.getStats();
      dashboardStatsService.cachedAt =
        Date.now() - dashboardStatsService.ttlMs - 1;
      await dashboardStatsService.getStats();

      assert.strictEqual(counts.tagCount, 2);
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 4. Invalidation
    // ──────────────────────────────────────────────────────────────────────────

    await test('invalidate() makes the next reader rebuild', async () => {
      reset();
      await dashboardStatsService.getStats();
      dashboardStatsService.invalidate();
      await dashboardStatsService.getStats();

      assert.strictEqual(
        counts.tagCount,
        2,
        'A processed document has to reach the dashboard before the TTL is up'
      );
    });

    await test('refresh() rebuilds even while the cache is fresh', async () => {
      reset();
      await dashboardStatsService.getStats();
      await dashboardStatsService.refresh();

      assert.strictEqual(counts.tagCount, 2);
    });

    // buildStats reads SQLite synchronously up front and then waits on two
    // Paperless-ngx round trips, so a document that finishes mid-build is not
    // in the numbers that build is about to return. These cover that window.

    await test('An invalidation during a build is not buried by it', async () => {
      reset();
      let builds = 0;
      const gates = [];
      stubBuild(async () => {
        builds += 1;
        await new Promise((resolve) => gates.push(resolve));
        return { success: true, build: builds };
      });

      const poll = dashboardStatsService.getStats();
      assert.strictEqual(gates.length, 1, 'A build is under way');

      // A document finishes while Paperless-ngx is still answering.
      dashboardStatsService.invalidate();
      gates.shift()();
      const served = await poll;

      assert.strictEqual(
        served.payload.build,
        1,
        'The reader that waited still gets numbers'
      );
      assert.ok(
        !dashboardStatsService.isFresh(),
        'Numbers assembled before the change must not be stamped fresh'
      );

      const next = dashboardStatsService.getStats();
      assert.strictEqual(gates.length, 1, 'The next reader rebuilds');
      gates.shift()();
      await next;
      assert.strictEqual(builds, 2);
    });

    await test('The end-of-scan refresh does not adopt a build that predates the last document', async () => {
      reset();
      let processed = 5;
      let builds = 0;
      const gates = [];
      stubBuild(async () => {
        builds += 1;
        const seen = processed;
        await new Promise((resolve) => gates.push(resolve));
        return {
          success: true,
          paperless_data: { processedDocumentCount: seen },
        };
      });

      // A dashboard poll starts a build while the scan is still running.
      const poll = dashboardStatsService.getStats();
      assert.strictEqual(gates.length, 1);

      // The last document lands, and the scan asks for a rebuild on its way out.
      processed = 6;
      dashboardStatsService.invalidate();
      const afterScan = dashboardStatsService.refresh();
      assert.strictEqual(
        builds,
        2,
        'refresh() has to start its own build, not join the outdated one'
      );

      gates.shift()();
      await poll;
      gates.shift()();
      await afterScan;

      const served = await dashboardStatsService.getStats();
      assert.strictEqual(
        served.payload.paperless_data.processedDocumentCount,
        6,
        'The dashboard has to end up showing the document the scan just finished'
      );
      assert.strictEqual(
        builds,
        2,
        'and without a third round of Paperless calls'
      );
    });

    await test('A slow build finishing last does not overwrite newer numbers', async () => {
      reset();
      let processed = 5;
      let builds = 0;
      const gates = [];
      stubBuild(async () => {
        builds += 1;
        const seen = processed;
        await new Promise((resolve) => gates.push(resolve));
        return {
          success: true,
          paperless_data: { processedDocumentCount: seen },
        };
      });

      const stale = dashboardStatsService.getStats();
      processed = 6;
      dashboardStatsService.invalidate();
      const current = dashboardStatsService.refresh();

      // The newer build wins the race; the older one lands afterwards.
      gates.pop()();
      await current;
      gates.pop()();
      await stale;

      assert.strictEqual(
        dashboardStatsService.cache.paperless_data.processedDocumentCount,
        6,
        'The later answer must not put the older picture back'
      );
      assert.ok(
        dashboardStatsService.isFresh(),
        'and the newer numbers stay fresh, so no third build is needed'
      );
      assert.strictEqual(builds, 2);
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 5. Failure handling
    // ──────────────────────────────────────────────────────────────────────────

    await test('A failed rebuild keeps the last good payload', async () => {
      reset();
      const good = await dashboardStatsService.getStats();

      let builds = 0;
      stubBuild(async () => {
        builds += 1;
        throw new Error('Paperless-ngx unreachable');
      });

      const afterFailure = await dashboardStatsService.refresh();
      assert.strictEqual(builds, 1);
      assert.strictEqual(
        afterFailure.payload,
        good.payload,
        'One hiccup must not blank the dashboard out'
      );
      assert.strictEqual(
        afterFailure.cachedAt,
        good.cachedAt,
        'The timestamp keeps pointing at the data that is actually shown'
      );
    });

    await test('A failed rebuild is not retried on every poll', async () => {
      reset();
      await dashboardStatsService.getStats();

      let builds = 0;
      stubBuild(async () => {
        builds += 1;
        throw new Error('Paperless-ngx unreachable');
      });

      dashboardStatsService.invalidate();
      await dashboardStatsService.getStats();
      await dashboardStatsService.getStats();
      await dashboardStatsService.getStats();
      assert.strictEqual(
        builds,
        1,
        'A down backend must not be hit once per dashboard poll'
      );

      // Once the backoff window is over the next reader tries again.
      dashboardStatsService.lastFailureAt =
        Date.now() - dashboardStatsService.FAILURE_RETRY_MS - 1;
      await dashboardStatsService.getStats();
      assert.strictEqual(builds, 2, 'A recovered backend has to be picked up');
    });

    await test('The very first build failing surfaces to the caller', async () => {
      reset();
      stubBuild(async () => {
        throw new Error('Paperless-ngx unreachable');
      });

      await assert.rejects(
        () => dashboardStatsService.getStats(),
        /unreachable/,
        'With nothing cached the endpoint has to answer 500, not fake zeroes'
      );
    });

    // A restart is the one moment where the cache is empty *and* Paperless-ngx
    // may not be answering yet, so the two cases below are exactly the ones the
    // dashboard hits after every restart.

    await test('A cold start against a down backend does not rebuild on every poll', async () => {
      reset();
      let builds = 0;
      stubBuild(async () => {
        builds += 1;
        throw new Error('Paperless-ngx unreachable');
      });

      // Nothing was ever cached — the case the backoff used to miss, because
      // isFresh() answers "not fresh" for an empty cache before it ever looks
      // at the failure timestamp.
      for (let poll = 0; poll < 3; poll += 1) {
        await assert.rejects(
          () => dashboardStatsService.getStats(),
          /unreachable/
        );
      }
      assert.strictEqual(
        builds,
        1,
        'A backend that is still coming up must not be hit once per poll'
      );

      // Once the window is over the next reader tries again.
      dashboardStatsService.lastFailureAt =
        Date.now() - dashboardStatsService.FAILURE_RETRY_MS - 1;
      await assert.rejects(
        () => dashboardStatsService.getStats(),
        /unreachable/
      );
      assert.strictEqual(builds, 2, 'A recovered backend has to be picked up');
    });

    await test('A build that never answers does not wedge the endpoint', async () => {
      reset();
      dashboardStatsService.buildTimeoutMs = 25;
      const release = holdEventLoopOpen();

      try {
        let builds = 0;
        // What a Paperless-ngx host still booting behind a proxy does: the
        // connection is accepted, the response never comes.
        stubBuild(() => {
          builds += 1;
          return new Promise(() => {});
        });

        await assert.rejects(
          () => dashboardStatsService.getStats(),
          /took longer than/,
          'A build that hangs has to give up instead of keeping readers waiting'
        );
        assert.strictEqual(
          dashboardStatsService.inFlight,
          null,
          'and it has to release the single-flight slot every later reader joins'
        );

        // The backend comes up. Nothing may still be pointing at the dead build.
        dashboardStatsService.buildTimeoutMs = 5000;
        dashboardStatsService.lastFailureAt = 0;
        restoreBuild();

        const recovered = await dashboardStatsService.getStats();
        assert.strictEqual(
          builds,
          1,
          'The hung build is not retried on its own'
        );
        assert.strictEqual(
          recovered.payload.paperless_data.tagCount,
          12,
          'and the endpoint answers again without a restart'
        );
      } finally {
        release();
      }
    });

    await test('An unreachable Paperless-ngx fails the build instead of caching zeroes', async () => {
      reset();
      paperlessDown = true;

      await assert.rejects(
        () => dashboardStatsService.getStats(),
        /unreachable/,
        'The counts have to be read strictly — a cached 0 is indistinguishable from an empty library'
      );
      assert.strictEqual(
        dashboardStatsService.cache,
        null,
        'and nothing may be cached, or the dashboard reports "no documents" for a whole TTL'
      );

      // The backend answers again and the real numbers land.
      paperlessDown = false;
      dashboardStatsService.lastFailureAt = 0;
      const recovered = await dashboardStatsService.getStats();
      assert.strictEqual(recovered.payload.paperless_data.documentCount, 100);
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 6. The endpoint only reads the cache
    // ──────────────────────────────────────────────────────────────────────────

    await test('The endpoint does not assemble statistics itself', () => {
      const routeSource = readRouteSources();
      const start = routeSource.indexOf("router.get('/api/dashboard/stats'");
      assert.ok(start > -1, 'The endpoint is missing');

      const handler = routeSource.slice(
        start,
        routeSource.indexOf('\n});', start)
      );
      assert.match(handler, /dashboardStatsService\.getStats\(\)/);
      assert.match(handler, /cachedAt/, 'The client needs the assembly time');
      assert.ok(
        !/documentModel\.|paperlessService\./.test(handler),
        'Rebuilding the payload per request is what this change removes'
      );
    });

    await test('No Paperless-ngx client is built without a request timeout', () => {
      const serviceSource = fs.readFileSync(
        path.join(__dirname, '..', 'services', 'paperlessService.js'),
        'utf8'
      );
      const clients = serviceSource.split('axios.create({').slice(1);
      assert.ok(clients.length >= 2, 'Both clients have to be found');

      clients.forEach((tail, index) => {
        // The two option objects are indented differently, so the close brace
        // is not a reliable marker. Both are far shorter than this budget.
        const options = tail.slice(0, 600);
        assert.match(
          options,
          /\btimeout:/,
          `Client ${index + 1} waits forever without one, and every reader of the statistics waits with it`
        );
      });
    });
  } finally {
    reset();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
