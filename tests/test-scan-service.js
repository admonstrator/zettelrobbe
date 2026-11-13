'use strict';

/**
 * Pins the scheduled scan end to end: the loop around processDocument() that
 * tests/test-document-pipeline-callers.js does not reach. One run probes
 * Paperless-ngx, reads the entity lists once, walks the
 * documents, writes each result back through documentProcessingService,
 * completes or fails the document, counts it, marks the dashboard cache stale,
 * honours a stop request between documents, and reports to the health
 * service. Each scenario lists every call in order, so swapping the write-back
 * and the "complete" mark, or breaking the catch, fails here.
 *
 * Runs offline: every collaborator is replaced through the require cache;
 * documentPipeline runs for real on top of the fakes.
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const modulePaths = {
  config: require.resolve('../config/config'),
  documentModel: require.resolve('../models/document'),
  paperlessService: require.resolve('../services/paperlessService'),
  aiServiceFactory: require.resolve('../services/aiServiceFactory'),
  mistralOcrService: require.resolve('../services/mistralOcrService'),
  skipRuleService: require.resolve('../services/skipRuleService'),
  documentProcessingService:
    require.resolve('../services/documentProcessingService'),
  externalApiService: require.resolve('../services/externalApiService'),
  ocrAutoProcessService: require.resolve('../services/ocrAutoProcessService'),
  duplicateReviewJobService:
    require.resolve('../services/duplicateReviewJobService'),
  duplicateMergeService: require.resolve('../services/duplicateMergeService'),
  scanHealthService: require.resolve('../services/scanHealthService'),
  dashboardStatsService: require.resolve('../services/dashboardStatsService'),
};
const SCAN_SERVICE = path.join(ROOT, 'services', 'scanService.js');
const underTest = [
  path.join(ROOT, 'services', 'documentPipeline.js'),
  SCAN_SERVICE,
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
const DOC_8 = { id: 8, title: 'Scan 0008' };
const TEXT = 'Invoice for the phone line, September. '.repeat(4);
const ANALYSIS = { document: { title: 'Phone bill' } };
const REACHABLE = { reachable: true, authorized: true, error: null };

/** A long string reads as its length, so the lists stay short. */
function show(value) {
  return JSON.stringify(value, (key, inner) =>
    typeof inner === 'string' && inner.length > 40
      ? `<${inner.length} chars>`
      : inner
  );
}

/**
 * services/scanService.js, loaded fresh on top of the fakes of the current
 * world.
 */
function loadScan() {
  delete require.cache[SCAN_SERVICE];
  return require(SCAN_SERVICE);
}

/**
 * Fresh fakes for one scenario.
 *
 * @param {object} scenario
 */
function makeWorld(scenario = {}) {
  const s = {
    documents: [DOC],
    connection: REACHABLE,
    listsFail: null,
    processed: false,
    processedOnRecheck: false,
    failed: false,
    ignored: false,
    editable: true,
    content: TEXT,
    skipMatch: null,
    ocrEnabled: false,
    ocrQueueAccepts: true,
    ocrQueueIds: [],
    activeOcr: false,
    analyses: [ANALYSIS],
    externalApi: false,
    minContentLength: 10,
    saveFails: null,
    onSave: null,
    ocrAutoRunning: false,
    reviewJobRunning: false,
    mergeWriting: false,
    ...scenario,
  };
  const calls = [];
  const note = (name, args) =>
    calls.push(`${name}(${args.map(show).join(', ')})`);
  const record =
    (name, result) =>
    async (...args) => {
      note(name, args);
      return typeof result === 'function' ? result(...args) : result;
    };
  const recordSync =
    (name, result) =>
    (...args) => {
      note(name, args);
      return typeof result === 'function' ? result(...args) : result;
    };

  const processedChecks = new Map();
  let analysisIndex = 0;
  const titleOf = (id) =>
    [DOC, DOC_8].find((doc) => doc.id === id)?.title || `Doc ${id}`;

  const fakes = {
    config: {
      minContentLength: s.minContentLength,
      scanInterval: '*/30 * * * *',
      restrictToExistingTags: 'no',
      restrictToExistingCorrespondents: 'yes',
      externalApiConfig: { enabled: s.externalApi ? 'yes' : 'no' },
    },
    documentModel: {
      isDocumentProcessed: record('isDocumentProcessed', (id) => {
        const seen = (processedChecks.get(id) || 0) + 1;
        processedChecks.set(id, seen);
        return seen > 1 ? s.processedOnRecheck : s.processed;
      }),
      isDocumentIgnored: record('isDocumentIgnored', () => s.ignored),
      isDocumentFailed: record('isDocumentFailed', () => s.failed),
      setProcessingStatus: record('setProcessingStatus'),
      addToOcrQueue: record('addToOcrQueue', () => s.ocrQueueAccepts),
      getOcrQueueItem: record('getOcrQueueItem', (id) =>
        s.ocrQueueIds.includes(id) ? { status: 'pending' } : null
      ),
      addFailedDocument: record('addFailedDocument'),
      getOcrQueueDocumentIds: record('getOcrQueueDocumentIds', () =>
        s.ocrQueueIds.map(String)
      ),
    },
    paperlessService: {
      checkConnection: record('checkConnection', () => s.connection),
      getAllDocuments: record('getAllDocuments', () => {
        if (s.listsFail) throw new Error(s.listsFail);
        return s.documents;
      }),
      getPermissionOfDocument: record(
        'getPermissionOfDocument',
        () => s.editable
      ),
      getDocumentContent: record('getDocumentContent', () => s.content),
      getDocument: record('getDocument', (id) => ({
        id,
        title: titleOf(id),
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
      saveDocumentChanges: record('saveDocumentChanges', (id) => {
        if (s.onSave) s.onSave(id);
        if (s.saveFails) throw new Error(s.saveFails);
      }),
    },
    externalApiService: {
      fetchData: record('externalApi.fetchData', { rate: 1.1 }),
    },
    ocrAutoProcessService: {
      get running() {
        return s.ocrAutoRunning;
      },
    },
    duplicateReviewJobService: { isRunning: () => s.reviewJobRunning },
    duplicateMergeService: { isWriting: () => s.mergeWriting },
    scanHealthService: {
      RUN_STATUS: {
        OK: 'ok',
        PAPERLESS_UNREACHABLE: 'paperless_unreachable',
        ERROR: 'error',
      },
      recordRunStart: recordSync('health.recordRunStart'),
      recordConnectivity: recordSync('health.recordConnectivity'),
      recordRunResult: recordSync('health.recordRunResult'),
    },
    dashboardStatsService: {
      invalidate: recordSync('dashboard.invalidate'),
      refresh: record('dashboard.refresh'),
    },
  };

  for (const key of Object.keys(modulePaths)) {
    delete require.cache[modulePaths[key]];
    inject(modulePaths[key], fakes[key]);
  }
  for (const modulePath of underTest) {
    delete require.cache[modulePath];
  }
  const scanControl = require('../services/scanControl');
  scanControl.reset();

  return { calls, s, fakes, scanControl };
}

/**
 * Runs fn with the console captured. Every line is kept as "<level> <text>",
 * with the run duration blanked so the summary line can be compared.
 */
async function captured(fn) {
  const saved = {};
  const logs = [];
  for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    saved[level] = console[level];
    console[level] = (...args) => {
      const text = args
        .filter((arg) => typeof arg === 'string')
        .join(' ')
        .replace(/durationMs=\d+/, 'durationMs=N');
      logs.push(`${level} ${text}`);
    };
  }
  try {
    return { value: await fn(), logs };
  } finally {
    Object.assign(console, saved);
  }
}

/**
 * One world, `runs` scans in a row (the retry cap only shows over several).
 *
 * @param {object} scenario
 * @param {{ runs?: number, source?: string, afterLoad?: Function, before?: Function }} [options]
 */
async function runScan(scenario, options = {}) {
  const world = makeWorld(scenario);
  const scan = loadScan();
  if (options.afterLoad) options.afterLoad(world);
  if (world.s.onSave === 'stop') {
    world.s.onSave = () => scan.requestScanStop();
  }
  if (options.before) options.before(world);
  const { logs } = await captured(async () => {
    for (let run = 0; run < (options.runs || 1); run += 1) {
      await scan.scanDocuments(options.source);
    }
  });
  const summaries = logs
    .filter((line) => line.startsWith('info Scan completed'))
    .map((line) => line.slice('info '.length));
  return { ...world, scan, logs, summaries };
}

/** Lets a detached scan finish. */
async function settle(scanControl) {
  for (let i = 0; i < 50 && scanControl.isRunning(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ── Expected call lists ─────────────────────────────────────────────────────

const runStart = (source = 'scheduler') => [
  `health.recordRunStart("${source}")`,
  'checkConnection()',
  `health.recordConnectivity(${show(REACHABLE)})`,
];
const LISTS = [
  'getTags()',
  'getAllDocuments()',
  'listCorrespondentsNames()',
  'listDocumentTypesNames()',
];
const RUN_OK = [
  'health.recordRunResult({"status":"ok"})',
  'dashboard.refresh()',
];
/* With OCR on, the pipeline asks the OCR queue about each document right
   after "already processed". */
const pipelineUpTo = (id, title, { ocr = false } = {}) => [
  `isDocumentProcessed(${id})`,
  ...(ocr ? [`getOcrQueueItem(${id})`] : []),
  `isDocumentIgnored(${id})`,
  `isDocumentFailed(${id})`,
  `setProcessingStatus(${id}, "${title}", "processing")`,
  `getPermissionOfDocument(${id})`,
  `getDocumentContent(${id})`,
  `getDocument(${id})`,
  `skipRules.apply({"id":${id},"title":"${title}","page_count":2}, "<156 chars>")`,
];
const analyze = (id, extra = '') =>
  `analyzeDocument("<156 chars>", ["Tax"], ["Bank"], ["Invoice"], ${id}, null, {"restrictToExistingTags":false,"restrictToExistingCorrespondents":true${extra}})`;
const writeBack = (id, title) => [
  `buildUpdateData({"document":{"title":"Phone bill"}}, {"id":${id},"title":"${title}"})`,
  `saveDocumentChanges(${id}, {"title":"Phone bill"}, {"document":{"title":"Phone bill"}}, {"id":${id},"title":"${title}","page_count":2})`,
];
const COMPLETE = [
  ...writeBack(7, 'Scan 0007'),
  'setProcessingStatus(7, "Scan 0007", "complete")',
  'dashboard.invalidate()',
];
const SCAN_FAILED = [
  'setProcessingStatus(7, "Scan 0007", "failed")',
  'dashboard.invalidate()',
];
const summary = (counts, extra = '') => {
  const c = {
    source: 'scheduler',
    total: 1,
    processed: 0,
    skipped: 0,
    failed: 0,
    stopRequested: false,
    ...counts,
  };
  return `Scan completed (source=${c.source}, total=${c.total}, processed=${c.processed}, skipped=${c.skipped}, failed=${c.failed}, stopRequested=${c.stopRequested}${extra}, durationMs=N)`;
};

const OCR_ERROR = { error: 'Invalid JSON response from API' };
const PLAIN_ERROR = { error: 'Model refused', errorCode: 'ai_refused' };

async function main() {
  console.log('Scan run');

  await test('a good analysis is written back, then completed, counted and the cache marked stale', async () => {
    const { calls, summaries, scanControl, logs } = await runScan({});
    assert.deepStrictEqual(calls, [
      ...runStart(),
      ...LISTS,
      ...pipelineUpTo(7, 'Scan 0007'),
      analyze(7),
      ...COMPLETE,
      ...RUN_OK,
    ]);
    assert.deepStrictEqual(summaries, [summary({ processed: 1 })]);
    assert.ok(logs.includes('info Scan started (source=scheduler)'), logs);
    assert.deepStrictEqual(scanControl.getState(), {
      running: false,
      stopRequested: false,
      source: null,
      startedAt: null,
      stopRequestedAt: null,
    });
  });

  await test('the scan state is set while the run is in progress', async () => {
    let during = null;
    const { scanControl } = await runScan(
      {},
      {
        source: 'api-manual',
        before: (world) => {
          world.s.onSave = () => {
            during = { ...world.scanControl.getState() };
          };
        },
      }
    );
    assert.strictEqual(during.running, true);
    assert.strictEqual(during.stopRequested, false);
    assert.strictEqual(during.source, 'api-manual');
    assert.ok(!Number.isNaN(Date.parse(during.startedAt)), during.startedAt);
    assert.strictEqual(scanControl.isRunning(), false);
  });

  await test('the analysis fails: the document is failed and counted, the run goes on', async () => {
    const { calls, summaries, logs } = await runScan({
      documents: [DOC, DOC_8],
      analyses: [PLAIN_ERROR, ANALYSIS],
    });
    assert.deepStrictEqual(calls, [
      ...runStart(),
      ...LISTS,
      ...pipelineUpTo(7, 'Scan 0007'),
      analyze(7),
      'setProcessingStatus(7, "Scan 0007", "failed")',
      'addFailedDocument(7, "Scan 0007", "ai_refused", "ai")',
      ...SCAN_FAILED,
      ...pipelineUpTo(8, 'Scan 0008'),
      analyze(8),
      ...writeBack(8, 'Scan 0008'),
      'setProcessingStatus(8, "Scan 0008", "complete")',
      'dashboard.invalidate()',
      ...RUN_OK,
    ]);
    assert.deepStrictEqual(summaries, [
      summary({ total: 2, processed: 1, failed: 1 }),
    ]);
    assert.ok(
      logs.includes(
        'error [ERROR] processing document 7: [ERROR] Document analysis failed: Model refused'
      ),
      logs
    );
  });

  await test('the write-back fails: the document is failed, never completed', async () => {
    const { calls, summaries, logs } = await runScan({
      saveFails: 'Paperless said no',
    });
    assert.deepStrictEqual(calls, [
      ...runStart(),
      ...LISTS,
      ...pipelineUpTo(7, 'Scan 0007'),
      analyze(7),
      ...writeBack(7, 'Scan 0007'),
      ...SCAN_FAILED,
      ...RUN_OK,
    ]);
    assert.deepStrictEqual(summaries, [summary({ failed: 1 })]);
    assert.ok(
      logs.includes('error [ERROR] processing document 7: Paperless said no'),
      logs
    );
  });

  await test('a stop request halts the run before the next document', async () => {
    const { calls, summaries, logs } = await runScan({
      documents: [DOC, DOC_8],
      onSave: 'stop',
    });
    assert.deepStrictEqual(calls, [
      ...runStart(),
      ...LISTS,
      ...pipelineUpTo(7, 'Scan 0007'),
      analyze(7),
      ...COMPLETE,
      ...RUN_OK,
    ]);
    assert.deepStrictEqual(summaries, [
      summary({ total: 2, processed: 1, stopRequested: true }),
    ]);
    assert.ok(
      logs.includes(
        'info Graceful stop requested. Halting scan before next document (source=scheduler)'
      ),
      logs
    );
  });

  await test('three non-terminal failures fail the document on the fourth run', async () => {
    const { calls, summaries } = await runScan(
      { ocrEnabled: true, analyses: [OCR_ERROR] },
      { runs: 4 }
    );
    const oneFailingRun = [
      ...runStart(),
      ...LISTS,
      ...pipelineUpTo(7, 'Scan 0007', { ocr: true }),
      analyze(7),
      'isDocumentProcessed(7)',
      'addToOcrQueue(7, "Scan 0007", "ai_invalid_json", {"skipIfProcessed":true})',
      ...SCAN_FAILED,
      ...RUN_OK,
    ];
    assert.deepStrictEqual(calls.slice(0, oneFailingRun.length), oneFailingRun);
    assert.deepStrictEqual(calls.slice(-4), [
      `skipRules.apply({"id":7,"title":"Scan 0007","page_count":2}, "<156 chars>")`,
      'setProcessingStatus(7, "Scan 0007", "failed")',
      ...RUN_OK,
    ]);
    assert.deepStrictEqual(summaries, [
      summary({ failed: 1 }),
      summary({ failed: 1 }),
      summary({ failed: 1 }),
      summary({ skipped: 1 }),
    ]);
  });

  await test('short content goes to OCR and counts as skipped', async () => {
    const { calls, summaries } = await runScan({
      content: 'x',
      ocrEnabled: true,
    });
    assert.deepStrictEqual(calls, [
      ...runStart(),
      ...LISTS,
      ...pipelineUpTo(7, 'Scan 0007', { ocr: true }).slice(0, -1),
      'skipRules.apply({"id":7,"title":"Scan 0007","page_count":2}, "x")',
      'isDocumentProcessed(7)',
      'addToOcrQueue(7, "Scan 0007", "short_content_lt_10", {"skipIfProcessed":true})',
      ...RUN_OK,
    ]);
    assert.deepStrictEqual(summaries, [summary({ skipped: 1 })]);
  });

  await test('a document in the OCR queue costs no Paperless call', async () => {
    const { calls, summaries } = await runScan({
      ocrEnabled: true,
      ocrQueueIds: [7],
    });
    assert.deepStrictEqual(calls, [
      ...runStart(),
      ...LISTS,
      'isDocumentProcessed(7)',
      'getOcrQueueItem(7)',
      ...RUN_OK,
    ]);
    assert.deepStrictEqual(summaries, [summary({ skipped: 1 })]);
  });

  await test('with OCR off a document in the OCR queue is analysed', async () => {
    const { calls, summaries } = await runScan({ ocrQueueIds: [7] });
    assert.deepStrictEqual(calls, [
      ...runStart(),
      ...LISTS,
      ...pipelineUpTo(7, 'Scan 0007'),
      analyze(7),
      ...COMPLETE,
      ...RUN_OK,
    ]);
    assert.deepStrictEqual(summaries, [summary({ processed: 1 })]);
  });

  await test('a skip rule match counts as skipped', async () => {
    const { calls, summaries } = await runScan({
      skipMatch: { reason: 'Page limit' },
    });
    assert.deepStrictEqual(calls, [
      ...runStart(),
      ...LISTS,
      ...pipelineUpTo(7, 'Scan 0007'),
      ...RUN_OK,
    ]);
    assert.deepStrictEqual(summaries, [summary({ skipped: 1 })]);
  });

  await test('external API data reaches the AI', async () => {
    const { calls } = await runScan({ externalApi: true });
    assert.deepStrictEqual(calls, [
      ...runStart(),
      ...LISTS,
      ...pipelineUpTo(7, 'Scan 0007'),
      'externalApi.fetchData()',
      analyze(7, ',"externalApiData":{"rate":1.1}'),
      ...COMPLETE,
      ...RUN_OK,
    ]);
  });

  await test('a saved minimum content length applies without a restart', async () => {
    const { calls, summaries } = await runScan(
      {},
      {
        afterLoad: (world) => {
          world.fakes.config.minContentLength = 500;
        },
      }
    );
    assert.deepStrictEqual(calls, [
      ...runStart(),
      ...LISTS,
      ...pipelineUpTo(7, 'Scan 0007'),
      'setProcessingStatus(7, "Scan 0007", "failed")',
      'addFailedDocument(7, "Scan 0007", "insufficient_content_lt_500", "ai")',
      ...RUN_OK,
    ]);
    assert.deepStrictEqual(summaries, [summary({ skipped: 1 })]);
  });

  console.log('Run guards');

  await test('a running scan refuses a second one', async () => {
    const { calls, summaries, logs } = await runScan(
      {},
      {
        before: (world) => {
          world.scanControl.getState().running = true;
        },
      }
    );
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(summaries, []);
    assert.deepStrictEqual(logs, [
      'info Scan request ignored because a task is already running',
    ]);
  });

  await test('OCR auto-processing, a Tidy up job or a merge write holds the scan off', async () => {
    const cases = [
      [
        { ocrAutoRunning: true },
        'info Scan request ignored because OCR auto-processing is currently running',
      ],
      [
        { reviewJobRunning: true, mergeWriting: true },
        'info Scan request ignored because a Duplicates or Simplify job is running; the next scheduled scan tries again',
      ],
      [
        { mergeWriting: true },
        'info Scan request ignored because a merge, undo or delete is being written; the next scheduled scan tries again',
      ],
    ];
    for (const [scenario, line] of cases) {
      const { calls, logs, scanControl } = await runScan(scenario);
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(logs, [line]);
      assert.strictEqual(scanControl.isRunning(), false);
    }
  });

  await test('Paperless-ngx unreachable or unauthorized aborts the run', async () => {
    const down = { reachable: false, authorized: false, error: 'ECONNREFUSED' };
    const unreachable = await runScan({ connection: down });
    assert.deepStrictEqual(unreachable.calls, [
      'health.recordRunStart("scheduler")',
      'checkConnection()',
      `health.recordConnectivity(${show(down)})`,
      'health.recordRunResult({"status":"paperless_unreachable","error":"ECONNREFUSED"})',
      'dashboard.refresh()',
    ]);
    assert.deepStrictEqual(unreachable.summaries, [
      summary({ total: 0 }, ', aborted=paperless_unreachable'),
    ]);
    assert.ok(
      unreachable.logs.includes(
        'error [ERROR] Scan aborted: Paperless-ngx is not usable (ECONNREFUSED). The scheduler stays armed and retries at the next interval (*/30 * * * *).'
      ),
      unreachable.logs
    );
    const unauthorized = await runScan({
      connection: { reachable: true, authorized: false, error: '401' },
    });
    assert.deepStrictEqual(unauthorized.summaries, [
      summary({ total: 0 }, ', aborted=paperless_unauthorized'),
    ]);
  });

  await test('an error outside a document fails the run, not a document', async () => {
    const { calls, summaries, logs, scanControl } = await runScan({
      listsFail: 'socket hang up',
    });
    assert.deepStrictEqual(calls, [
      ...runStart(),
      ...LISTS.slice(0, 4),
      'health.recordRunResult({"status":"error","error":"socket hang up"})',
      'dashboard.refresh()',
    ]);
    assert.deepStrictEqual(summaries, [
      summary({ total: 0 }, ', aborted=error'),
    ]);
    assert.ok(
      logs.includes('error [ERROR] during document scan: socket hang up'),
      logs
    );
    assert.strictEqual(scanControl.isRunning(), false);
  });

  console.log('Levers');

  await test('requestScanStop: only a running scan can be asked to stop', async () => {
    const world = makeWorld({});
    const scan = loadScan();
    assert.strictEqual(scan.requestScanStop(), false);
    assert.strictEqual(world.scanControl.getState().stopRequested, false);
    world.scanControl.getState().running = true;
    assert.strictEqual(scan.requestScanStop(), true);
    const state = world.scanControl.getState();
    assert.strictEqual(state.stopRequested, true);
    assert.ok(!Number.isNaN(Date.parse(state.stopRequestedAt)));
  });

  await test('triggerScanNow: starts a detached scan with its source', async () => {
    const world = makeWorld({});
    const scan = loadScan();
    const { value } = await captured(async () => {
      const result = await scan.triggerScanNow('api-manual');
      await settle(world.scanControl);
      return result;
    });
    assert.deepStrictEqual(value, {
      started: true,
      running: true,
      stopRequested: false,
      message: 'Scan started.',
    });
    assert.strictEqual(world.calls[0], 'health.recordRunStart("api-manual")');
    assert.strictEqual(world.calls.at(-1), 'dashboard.refresh()');
  });

  await test('triggerScanNow: says why nothing started', async () => {
    const cases = [
      [
        {},
        true,
        {
          started: false,
          running: true,
          stopRequested: false,
          message: 'Scan is already running.',
        },
      ],
      [
        { ocrAutoRunning: true },
        false,
        {
          started: false,
          running: false,
          message: 'OCR auto-processing is currently running.',
        },
      ],
      [
        { reviewJobRunning: true },
        false,
        {
          started: false,
          running: false,
          message:
            'A Duplicates or Simplify job is running. Try again when it has finished.',
        },
      ],
      [
        { mergeWriting: true },
        false,
        {
          started: false,
          running: false,
          message:
            'A merge, undo or delete is being written. Try again in a moment.',
        },
      ],
    ];
    for (const [scenario, running, expected] of cases) {
      const world = makeWorld(scenario);
      world.scanControl.getState().running = running;
      const scan = loadScan();
      assert.deepStrictEqual(await scan.triggerScanNow('api-manual'), expected);
      assert.deepStrictEqual(world.calls, []);
    }
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
