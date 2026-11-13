'use strict';

/**
 * Pins what happens to one document on each of the three ways into the
 * analysis: the scheduled scan, a webhook delivery and a rescan asked for by
 * hand. The scan used to carry its own processDocument() in server.js, the
 * webhook and the rescan another one in services/webhookQueueService.js; the
 * two drifted apart. Each scenario below lists, in order, every call the path
 * makes to the database, Paperless-ngx, the skip rules, the OCR queue and the
 * AI service, and what the path hands back. The lists are the behaviour each
 * caller had before the two were merged, so the merge cannot change it.
 *
 * Runs offline: every collaborator is replaced through the require cache.
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const modulePaths = {
  config: require.resolve('../config/config'),
  documentModel: require.resolve('../models/document'),
  paperlessService: require.resolve('../services/paperlessService'),
  setupService: require.resolve('../services/setupService'),
  aiServiceFactory: require.resolve('../services/aiServiceFactory'),
  mistralOcrService: require.resolve('../services/mistralOcrService'),
  skipRuleService: require.resolve('../services/skipRuleService'),
  documentProcessingService:
    require.resolve('../services/documentProcessingService'),
  thumbnailCache: require.resolve('../services/thumbnailCache'),
  externalApiService: require.resolve('../services/externalApiService'),
};
const underTest = [
  require.resolve('../services/webhookQueueService'),
  path.join(ROOT, 'services', 'documentPipeline.js'),
];

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  [FAIL] ${name}: ${error.message}`);
  }
}

function inject(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

const DOC = { id: 7, title: 'Scan 0007' };
const TEXT = 'Invoice for the phone line, September. '.repeat(4);
const ANALYSIS = { document: { title: 'Phone bill' } };

/** A long string reads as its length, so the lists stay short. */
function show(value) {
  return JSON.stringify(value, (key, inner) =>
    typeof inner === 'string' && inner.length > 40
      ? `<${inner.length} chars>`
      : inner
  );
}

/**
 * Fresh fakes for one scenario.
 *
 * @param {object} scenario
 */
function makeWorld(scenario) {
  const s = {
    processed: false,
    processedOnRecheck: false,
    failed: false,
    ignored: false,
    editable: true,
    content: TEXT,
    skipMatch: null,
    ocrEnabled: false,
    ocrQueueAccepts: true,
    ocrQueueItem: null,
    activeOcr: false,
    analyses: [ANALYSIS],
    externalApi: false,
    minContentLength: 10,
    ...scenario,
  };
  const calls = [];
  const record =
    (name, result) =>
    async (...args) => {
      calls.push(`${name}(${args.map(show).join(', ')})`);
      return typeof result === 'function' ? result(...args) : result;
    };

  let processedChecks = 0;
  let analysisIndex = 0;

  const fakes = {
    config: {
      minContentLength: s.minContentLength,
      restrictToExistingTags: 'no',
      restrictToExistingCorrespondents: 'yes',
      externalApiConfig: { enabled: s.externalApi ? 'yes' : 'no' },
    },
    documentModel: {
      isDocumentProcessed: record('isDocumentProcessed', () => {
        processedChecks += 1;
        return processedChecks > 1 ? s.processedOnRecheck : s.processed;
      }),
      isDocumentIgnored: record('isDocumentIgnored', () => s.ignored),
      isDocumentFailed: record('isDocumentFailed', () => s.failed),
      setProcessingStatus: record('setProcessingStatus'),
      clearProcessingStatusByDocumentId: record(
        'clearProcessingStatusByDocumentId'
      ),
      addToOcrQueue: record('addToOcrQueue', () => s.ocrQueueAccepts),
      getOcrQueueItem: record('getOcrQueueItem', () => s.ocrQueueItem),
      addFailedDocument: record('addFailedDocument'),
      getOcrQueueDocumentIds: record('getOcrQueueDocumentIds', []),
      deleteDocumentsIdList: record('deleteDocumentsIdList'),
    },
    paperlessService: {
      getPermissionOfDocument: record(
        'getPermissionOfDocument',
        () => s.editable
      ),
      getDocumentContent: record('getDocumentContent', () => s.content),
      getDocument: record('getDocument', (id) => ({
        id,
        title: DOC.title,
        page_count: 2,
      })),
      getTags: record('getTags', [{ id: 1, name: 'Tax' }]),
      listCorrespondentsNames: record('listCorrespondentsNames', [
        { id: 2, name: 'Bank' },
      ]),
      listDocumentTypesNames: record('listDocumentTypesNames', [
        { id: 3, name: 'Invoice' },
      ]),
    },
    setupService: { isConfigured: record('isConfigured', true) },
    aiServiceFactory: {
      getService: () => ({
        analyzeDocument: record('analyzeDocument', () => {
          const next =
            s.analyses[Math.min(analysisIndex, s.analyses.length - 1)];
          analysisIndex += 1;
          return next;
        }),
      }),
    },
    mistralOcrService: {
      isEnabled: () => s.ocrEnabled,
      isDocumentActivelyProcessing: () => s.activeOcr,
    },
    skipRuleService: { apply: record('skipRules.apply', () => s.skipMatch) },
    documentProcessingService: {
      buildUpdateData: record('buildUpdateData', { title: 'Phone bill' }),
      saveDocumentChanges: record('saveDocumentChanges'),
    },
    thumbnailCache: { removeThumbnailCacheForDocumentIds: async () => {} },
    externalApiService: {
      fetchData: record('externalApi.fetchData', { rate: 1.1 }),
    },
  };

  for (const key of Object.keys(modulePaths)) {
    delete require.cache[modulePaths[key]];
    inject(modulePaths[key], fakes[key]);
  }
  for (const modulePath of underTest) {
    delete require.cache[modulePath];
  }

  return { calls, s };
}

async function quietly(fn) {
  const saved = {};
  const errors = [];
  for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
    saved[method] = console[method];
    console[method] = () => {};
  }
  console.error = (...args) => {
    const error = args.find((arg) => arg instanceof Error);
    if (error) errors.push(error.message);
  };
  try {
    return { value: await fn(), errors };
  } finally {
    Object.assign(console, saved);
  }
}

// ── Drivers: how each caller reaches processDocument() ──────────────────────

/**
 * The scheduled scan: processDocument() as the scan loop calls it, `runs`
 * times in a row on the same document (the retry cap only shows over several
 * scans). Each run reports null, the analysis, or the error it threw.
 */
async function runScan(scenario, { runs = 1, ocrQueuedDocumentIds } = {}) {
  const { calls, s } = makeWorld(scenario);
  const documentPipeline = require('../services/documentPipeline');
  const outcomes = [];
  await quietly(async () => {
    for (let run = 0; run < runs; run += 1) {
      try {
        const result = await documentPipeline.processDocument(
          DOC,
          ['Tax'],
          ['Bank'],
          ['Invoice'],
          {
            source: 'scan',
            minContentLength: s.minContentLength,
            ocrQueuedDocumentIds: ocrQueuedDocumentIds || new Set(),
          }
        );
        outcomes.push(result ? `analysis ${show(result.analysis)}` : 'null');
      } catch (error) {
        outcomes.push(`throw ${error.message}`);
      }
    }
  });
  return { calls, outcomes };
}

/**
 * The webhook (applySkipRules true) or the rescan by hand (false): one queue
 * pass, the way the routes start it. A failure is caught and logged by the
 * queue; it shows here as the error that was logged.
 */
async function runQueue(scenario, { applySkipRules, customPrompt } = {}) {
  const { calls } = makeWorld(scenario);
  const webhookQueueService = require('../services/webhookQueueService');
  webhookQueueService.enqueue({ ...DOC }, { applySkipRules });
  const { errors } = await quietly(() =>
    webhookQueueService.processQueue(customPrompt)
  );
  return { calls, outcomes: errors.map((message) => `throw ${message}`) };
}

const runWebhook = (scenario, options = {}) =>
  runQueue(scenario, { ...options, applySkipRules: true });
const runRescan = (scenario, options = {}) =>
  runQueue(scenario, { ...options, applySkipRules: false });

// ── Expected call lists ─────────────────────────────────────────────────────

/* The queue reads the three entity lists once per pass before the first
   document; the scan loop does that outside processDocument(). */
const QUEUE_START = [
  'isConfigured()',
  'getTags()',
  'listCorrespondentsNames()',
  'listDocumentTypesNames()',
];
const FETCH = [
  'getPermissionOfDocument(7)',
  'getDocumentContent(7)',
  'getDocument(7)',
];
const PROCESSING = 'setProcessingStatus(7, "Scan 0007", "processing")';
const SKIP_RULES =
  'skipRules.apply({"id":7,"title":"Scan 0007","page_count":2}, "<156 chars>")';
/* The scan used to stop after the document id. The two trailing arguments
   are the services' defaults in effect: no custom prompt, and options whose
   restrict flags no AI service reads (they read config). */
const SCAN_ANALYZE =
  'analyzeDocument("<156 chars>", ["Tax"], ["Bank"], ["Invoice"], 7, null, {"restrictToExistingTags":false,"restrictToExistingCorrespondents":true})';
const queueAnalyze = (prompt = null, extra = '') =>
  `analyzeDocument("<156 chars>", ["Tax"], ["Bank"], ["Invoice"], 7, ${show(prompt)}, {"restrictToExistingTags":false,"restrictToExistingCorrespondents":true${extra}})`;
const QUEUE_WRITE_BACK = [
  'setProcessingStatus(7, "Scan 0007", "complete")',
  'buildUpdateData({"document":{"title":"Phone bill"}}, {"id":7,"title":"Scan 0007"})',
  'saveDocumentChanges(7, {"title":"Phone bill"}, {"document":{"title":"Phone bill"}}, {"id":7,"title":"Scan 0007","page_count":2})',
];
const failedWith = (reason) => [
  'setProcessingStatus(7, "Scan 0007", "failed")',
  `addFailedDocument(7, "Scan 0007", "${reason}", "ai")`,
];
const ANALYSIS_OUT = 'analysis {"document":{"title":"Phone bill"}}';

const OCR_ERROR = { error: 'Invalid JSON response from API' };
const PLAIN_ERROR = { error: 'Model refused', errorCode: 'ai_refused' };
const TIMEOUT_ERROR = { error: 'Request timed out' };
const TIMEOUT_TEXT =
  'AI response timeout reached. Please check provider availability and timeout settings. Original error: Request timed out';

async function main() {
  console.log('Scheduled scan');

  await test('scan: an already processed document is left alone, quietly', async () => {
    const { calls, outcomes } = await runScan({ processed: true });
    assert.deepStrictEqual(calls, ['isDocumentProcessed(7)']);
    assert.deepStrictEqual(outcomes, ['null']);
  });

  await test('scan: a document waiting for OCR is not analysed', async () => {
    const queued = await runScan({}, { ocrQueuedDocumentIds: new Set([7]) });
    assert.deepStrictEqual(queued.calls, ['isDocumentProcessed(7)']);
    assert.deepStrictEqual(queued.outcomes, ['null']);
    const active = await runScan({ activeOcr: true });
    assert.deepStrictEqual(active.calls, ['isDocumentProcessed(7)']);
  });

  await test('scan: the ignored list is read before anything is written', async () => {
    const { calls, outcomes } = await runScan({ ignored: true });
    assert.deepStrictEqual(calls, [
      'isDocumentProcessed(7)',
      'isDocumentIgnored(7)',
    ]);
    assert.deepStrictEqual(outcomes, ['null']);
  });

  await test('scan: a permanently failed document waits for a reset', async () => {
    const { calls } = await runScan({ failed: true });
    assert.deepStrictEqual(calls, [
      'isDocumentProcessed(7)',
      'isDocumentIgnored(7)',
      'isDocumentFailed(7)',
    ]);
  });

  await test('scan: a document the user may not edit is skipped after the processing mark', async () => {
    const { calls, outcomes } = await runScan({ editable: false });
    assert.deepStrictEqual(calls, [
      'isDocumentProcessed(7)',
      'isDocumentIgnored(7)',
      'isDocumentFailed(7)',
      PROCESSING,
      'getPermissionOfDocument(7)',
    ]);
    assert.deepStrictEqual(outcomes, ['null']);
  });

  await test('scan: the skip rules come before the short-content OCR fallback', async () => {
    const { calls, outcomes } = await runScan({
      skipMatch: { reason: 'Page limit' },
      content: 'x',
      ocrEnabled: true,
    });
    assert.deepStrictEqual(calls, [
      'isDocumentProcessed(7)',
      'isDocumentIgnored(7)',
      'isDocumentFailed(7)',
      PROCESSING,
      ...FETCH,
      'skipRules.apply({"id":7,"title":"Scan 0007","page_count":2}, "x")',
    ]);
    assert.deepStrictEqual(outcomes, ['null']);
  });

  await test('scan: short content goes to OCR through the guarded insert', async () => {
    const { calls, outcomes } = await runScan({
      content: 'x',
      ocrEnabled: true,
    });
    assert.deepStrictEqual(calls.slice(8), [
      'isDocumentProcessed(7)',
      'addToOcrQueue(7, "Scan 0007", "short_content_lt_10", {"skipIfProcessed":true})',
    ]);
    assert.deepStrictEqual(outcomes, ['null']);
  });

  await test('scan: a refused OCR insert asks why', async () => {
    const { calls } = await runScan({
      content: 'x',
      ocrEnabled: true,
      ocrQueueAccepts: false,
      ocrQueueItem: { status: 'done' },
    });
    assert.deepStrictEqual(calls.slice(9), [
      'addToOcrQueue(7, "Scan 0007", "short_content_lt_10", {"skipIfProcessed":true})',
      'getOcrQueueItem(7)',
    ]);
  });

  await test('scan: a document processed while the scan ran is not queued for OCR', async () => {
    const { calls } = await runScan({
      content: 'x',
      ocrEnabled: true,
      processedOnRecheck: true,
    });
    assert.deepStrictEqual(calls.slice(8), ['isDocumentProcessed(7)']);
  });

  await test('scan: short content without OCR is a failure', async () => {
    const { calls, outcomes } = await runScan({ content: 'x' });
    assert.deepStrictEqual(
      calls.slice(8),
      failedWith('insufficient_content_lt_10')
    );
    assert.deepStrictEqual(outcomes, ['null']);
  });

  await test('scan: the minimum content length is the one the caller passes', async () => {
    const { calls } = await runScan({ minContentLength: 500 });
    assert.deepStrictEqual(
      calls.slice(8),
      failedWith('insufficient_content_lt_500')
    );
  });

  await test('scan: a good analysis is handed back without completing the document', async () => {
    const { calls, outcomes } = await runScan({});
    assert.deepStrictEqual(calls, [
      'isDocumentProcessed(7)',
      'isDocumentIgnored(7)',
      'isDocumentFailed(7)',
      PROCESSING,
      ...FETCH,
      SKIP_RULES,
      SCAN_ANALYZE,
    ]);
    assert.deepStrictEqual(outcomes, [ANALYSIS_OUT]);
  });

  await test('scan: content is cut at 50000 characters', async () => {
    const { calls } = await runScan({ content: 'y'.repeat(60000) });
    assert.ok(
      calls.at(-1).startsWith('analyzeDocument("<50000 chars>"'),
      calls.at(-1)
    );
  });

  await test('scan: external API data is not fetched', async () => {
    const { calls } = await runScan({ externalApi: true });
    assert.strictEqual(calls.at(-1), SCAN_ANALYZE);
  });

  await test('scan: an OCR-relevant AI error queues OCR and throws', async () => {
    const { calls, outcomes } = await runScan({
      ocrEnabled: true,
      analyses: [OCR_ERROR],
    });
    assert.deepStrictEqual(calls.slice(9), [
      'isDocumentProcessed(7)',
      'addToOcrQueue(7, "Scan 0007", "ai_invalid_json", {"skipIfProcessed":true})',
    ]);
    assert.deepStrictEqual(outcomes, [
      'throw [ERROR] Document analysis failed: Invalid JSON response from API',
    ]);
  });

  await test('scan: without OCR the service error code is the failure reason', async () => {
    const { calls, outcomes } = await runScan({ analyses: [PLAIN_ERROR] });
    assert.deepStrictEqual(calls.slice(9), failedWith('ai_refused'));
    assert.deepStrictEqual(outcomes, [
      'throw [ERROR] Document analysis failed: Model refused',
    ]);
    const generic = await runScan({ analyses: [OCR_ERROR] });
    assert.deepStrictEqual(
      generic.calls.slice(9),
      failedWith('ai_failed_ocr_disabled')
    );
  });

  await test('scan: OCR on but the error is not about the text', async () => {
    const { calls } = await runScan({
      ocrEnabled: true,
      analyses: [PLAIN_ERROR],
    });
    assert.deepStrictEqual(calls.slice(9), failedWith('ai_refused'));
    const generic = await runScan({
      ocrEnabled: true,
      analyses: [{ error: 'Model refused' }],
    });
    assert.deepStrictEqual(
      generic.calls.slice(9),
      failedWith('ai_failed_without_ocr_fallback')
    );
  });

  await test('scan: a timeout says so in the error', async () => {
    const { outcomes } = await runScan({ analyses: [TIMEOUT_ERROR] });
    assert.deepStrictEqual(outcomes, [
      `throw [ERROR] Document analysis failed: ${TIMEOUT_TEXT}`,
    ]);
  });

  await test('scan: three non-terminal failures stop the fourth attempt', async () => {
    const { calls, outcomes } = await runScan(
      { ocrEnabled: true, analyses: [OCR_ERROR] },
      { runs: 4 }
    );
    const error =
      'throw [ERROR] Document analysis failed: Invalid JSON response from API';
    assert.deepStrictEqual(outcomes, [error, error, error, 'null']);
    assert.deepStrictEqual(calls.slice(-2), [
      SKIP_RULES,
      'setProcessingStatus(7, "Scan 0007", "failed")',
    ]);
  });

  await test('scan: a success clears the retry count', async () => {
    const { outcomes } = await runScan(
      {
        ocrEnabled: true,
        analyses: [OCR_ERROR, OCR_ERROR, ANALYSIS, OCR_ERROR, OCR_ERROR],
      },
      { runs: 5 }
    );
    assert.strictEqual(outcomes[2], ANALYSIS_OUT);
    assert.ok(outcomes[4].startsWith('throw '), outcomes[4]);
  });

  console.log('Webhook');

  await test('webhook: an already processed document is left alone', async () => {
    const { calls, outcomes } = await runWebhook({ processed: true });
    assert.deepStrictEqual(calls, [...QUEUE_START, 'isDocumentProcessed(7)']);
    assert.deepStrictEqual(outcomes, []);
  });

  await test('webhook: a permanently failed document waits for a reset', async () => {
    const { calls } = await runWebhook({ failed: true });
    assert.deepStrictEqual(calls, [
      ...QUEUE_START,
      'isDocumentProcessed(7)',
      'isDocumentFailed(7)',
    ]);
  });

  await test('webhook: the ignored list is read after the fetch and clears the mark', async () => {
    const { calls } = await runWebhook({ ignored: true });
    assert.deepStrictEqual(calls, [
      ...QUEUE_START,
      'isDocumentProcessed(7)',
      'isDocumentFailed(7)',
      PROCESSING,
      ...FETCH,
      'isDocumentIgnored(7)',
      'clearProcessingStatusByDocumentId(7)',
    ]);
  });

  await test('webhook: a document waiting for OCR is not checked for it', async () => {
    const { calls } = await runWebhook({ activeOcr: true });
    assert.deepStrictEqual(calls.slice(-4), [
      queueAnalyze(),
      ...QUEUE_WRITE_BACK,
    ]);
  });

  await test('webhook: a document the user may not edit is skipped', async () => {
    const { calls } = await runWebhook({ editable: false });
    assert.deepStrictEqual(calls, [
      ...QUEUE_START,
      'isDocumentProcessed(7)',
      'isDocumentFailed(7)',
      PROCESSING,
      'getPermissionOfDocument(7)',
    ]);
  });

  await test('webhook: the skip rules come before the short-content OCR fallback', async () => {
    const { calls } = await runWebhook({
      skipMatch: { reason: 'Page limit' },
      content: 'x',
      ocrEnabled: true,
    });
    assert.deepStrictEqual(calls.slice(-2), [
      'isDocumentIgnored(7)',
      'skipRules.apply({"id":7,"title":"Scan 0007","page_count":2}, "x")',
    ]);
  });

  await test('webhook: short content goes to OCR through the plain insert', async () => {
    const { calls } = await runWebhook({ content: 'x', ocrEnabled: true });
    assert.deepStrictEqual(calls.slice(-1), [
      'addToOcrQueue(7, "Scan 0007", "short_content_lt_10")',
    ]);
    const refused = await runWebhook({
      content: 'x',
      ocrEnabled: true,
      ocrQueueAccepts: false,
    });
    assert.deepStrictEqual(refused.calls.slice(-1), [
      'addToOcrQueue(7, "Scan 0007", "short_content_lt_10")',
    ]);
  });

  await test('webhook: short content without OCR is a failure', async () => {
    const { calls } = await runWebhook({ content: 'x' });
    assert.deepStrictEqual(
      calls.slice(-2),
      failedWith('insufficient_content_lt_10')
    );
  });

  await test('webhook: the minimum content length is read from the settings', async () => {
    const { calls } = await runWebhook({ minContentLength: 500 });
    assert.deepStrictEqual(
      calls.slice(-2),
      failedWith('insufficient_content_lt_500')
    );
  });

  await test('webhook: a good analysis completes the document before the write-back', async () => {
    const { calls, outcomes } = await runWebhook({});
    assert.deepStrictEqual(calls, [
      ...QUEUE_START,
      'isDocumentProcessed(7)',
      'isDocumentFailed(7)',
      PROCESSING,
      ...FETCH,
      'isDocumentIgnored(7)',
      SKIP_RULES,
      queueAnalyze(),
      ...QUEUE_WRITE_BACK,
    ]);
    assert.deepStrictEqual(outcomes, []);
  });

  await test('webhook: content is cut at 50000 characters', async () => {
    const { calls } = await runWebhook({ content: 'y'.repeat(60000) });
    assert.ok(
      calls.at(-4).startsWith('analyzeDocument("<50000 chars>"'),
      calls.at(-4)
    );
  });

  await test('webhook: a custom prompt and external API data reach the AI', async () => {
    const { calls } = await runWebhook(
      { externalApi: true },
      { customPrompt: 'Only the title, please.' }
    );
    assert.deepStrictEqual(calls.slice(-5), [
      'externalApi.fetchData()',
      queueAnalyze(
        'Only the title, please.',
        ',"externalApiData":{"rate":1.1}'
      ),
      ...QUEUE_WRITE_BACK,
    ]);
  });

  await test('webhook: an OCR-relevant AI error queues OCR, logs and moves on', async () => {
    const { calls, outcomes } = await runWebhook({
      ocrEnabled: true,
      analyses: [OCR_ERROR],
    });
    assert.deepStrictEqual(calls.slice(-2), [
      queueAnalyze(),
      'addToOcrQueue(7, "Scan 0007", "ai_invalid_json")',
    ]);
    assert.deepStrictEqual(outcomes, [
      'throw [ERROR] Document analysis failed: Invalid JSON response from API',
    ]);
  });

  await test('webhook: the failure reason ignores the service error code', async () => {
    const { calls } = await runWebhook({ analyses: [PLAIN_ERROR] });
    assert.deepStrictEqual(
      calls.slice(-2),
      failedWith('ai_failed_ocr_disabled')
    );
    const withOcr = await runWebhook({
      ocrEnabled: true,
      analyses: [PLAIN_ERROR],
    });
    assert.deepStrictEqual(
      withOcr.calls.slice(-2),
      failedWith('ai_failed_without_ocr_fallback')
    );
  });

  await test('webhook: a timeout error is passed on unchanged', async () => {
    const { outcomes } = await runWebhook({ analyses: [TIMEOUT_ERROR] });
    assert.deepStrictEqual(outcomes, [
      'throw [ERROR] Document analysis failed: Request timed out',
    ]);
  });

  await test('webhook: no retry cap', async () => {
    for (let run = 0; run < 4; run += 1) {
      const { calls } = await runWebhook({
        ocrEnabled: true,
        analyses: [OCR_ERROR],
      });
      assert.strictEqual(calls.at(-2), queueAnalyze());
    }
  });

  console.log('Rescan by hand');

  await test('rescan: ignored list and skip rules do not apply', async () => {
    const { calls } = await runRescan({
      ignored: true,
      skipMatch: { reason: 'Page limit' },
    });
    assert.deepStrictEqual(calls, [
      ...QUEUE_START,
      'isDocumentProcessed(7)',
      'isDocumentFailed(7)',
      PROCESSING,
      ...FETCH,
      queueAnalyze(),
      ...QUEUE_WRITE_BACK,
    ]);
  });

  await test('rescan: short content goes to OCR through the plain insert', async () => {
    const { calls } = await runRescan({ content: 'x', ocrEnabled: true });
    assert.deepStrictEqual(calls.slice(-1), [
      'addToOcrQueue(7, "Scan 0007", "short_content_lt_10")',
    ]);
  });

  await test('rescan: an AI error without OCR is a failure with the generic reason', async () => {
    const { calls, outcomes } = await runRescan({ analyses: [PLAIN_ERROR] });
    assert.deepStrictEqual(
      calls.slice(-2),
      failedWith('ai_failed_ocr_disabled')
    );
    assert.deepStrictEqual(outcomes, [
      'throw [ERROR] Document analysis failed: Model refused',
    ]);
  });

  console.log('Shared');

  await test('an unknown caller is refused before anything is read', async () => {
    const { calls } = makeWorld({});
    const documentPipeline = require('../services/documentPipeline');
    await assert.rejects(
      documentPipeline.processDocument(DOC, [], [], [], { source: 'cron' }),
      /Unknown document pipeline source: cron/
    );
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(Object.keys(documentPipeline.CALLER_PROFILES), [
      'scan',
      'webhook',
      'rescan',
    ]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exitCode = 1;
});
