'use strict';

/**
 * OCR right after the run that queued a document (OCR_RUN_RIGHT_AWAY).
 *
 * Without the setting a document the scan or the webhook sends to the OCR
 * queue waits for the OCR cron (or for "Process All Pending"), up to two
 * intervals after it arrived. With it, the queue is read as soon as the run
 * that queued the document is over: the scan when its whole run ends (so OCR
 * never competes with it for the model), the webhook queue after the
 * document's own pipeline call. The drain reads every pending document, batch
 * after batch, and a run that ends while a drain or a scan is going on gets
 * one more drain when that is over.
 *
 * The scan, the webhook queue, the document pipeline and the OCR drain run
 * for real on top of the fakes; OCR itself (mistralOcrService) and
 * Paperless-ngx are replaced through the require cache.
 *
 * Covers: off by default (catalogue, config, a scan that queues), OCR off,
 * DISABLE_AUTOMATIC_PROCESSING=yes (nothing read, no trigger held), the
 * trigger after a scan run and after a webhook document or rescan, a
 * webhook document queued during a scan, coalescing (triggers during a drain
 * make one more drain), a drain over several batches, an item that stays
 * pending or fails is tried once, an unusable Paperless-ngx stops the drain,
 * and the cron keeps its one batch per tick.
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
  duplicateReviewJobService:
    require.resolve('../services/duplicateReviewJobService'),
  duplicateMergeService: require.resolve('../services/duplicateMergeService'),
  scanHealthService: require.resolve('../services/scanHealthService'),
  dashboardStatsService: require.resolve('../services/dashboardStatsService'),
  setupService: require.resolve('../services/setupService'),
  thumbnailCache: require.resolve('../services/thumbnailCache'),
};
const OCR_AUTO = path.join(ROOT, 'services', 'ocrAutoProcessService.js');
const SCAN_SERVICE = path.join(ROOT, 'services', 'scanService.js');
const WEBHOOK_QUEUE = path.join(ROOT, 'services', 'webhookQueueService.js');
const underTest = [
  path.join(ROOT, 'services', 'documentPipeline.js'),
  OCR_AUTO,
  SCAN_SERVICE,
  WEBHOOK_QUEUE,
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

const TEXT = 'Invoice for the phone line, September. '.repeat(4);
const SHORT = 'x';
const ANALYSIS = { document: { title: 'Phone bill' } };
const REACHABLE = { reachable: true, authorized: true, error: null };
const DOWN = { reachable: false, authorized: false, error: 'ECONNREFUSED' };

/** A document of the fake Paperless-ngx; short text goes to OCR. */
const doc = (id, content = SHORT) => ({ id, title: `Scan ${id}`, content });

/**
 * Fresh fakes for one scenario, and the real services on top of them.
 *
 * @param {object} scenario
 */
function makeWorld(scenario = {}) {
  const s = {
    documents: [doc(7)],
    ocrEnabled: true,
    // undefined: the variable is not set at all
    runRightAway: 'yes',
    disableAutomaticProcessing: 'no',
    autoProcessEnabled: 'no',
    autoAnalyze: 'yes',
    batchSize: 10,
    // Answers of checkConnection, one per call; the last one repeats.
    connections: [REACHABLE],
    // processQueueItem waits for this promise when it is set.
    ocrGate: null,
    // Items processQueueItem leaves pending (waiting for an unlocked
    // version) or fails without moving them out of 'pending'.
    staysPending: [],
    ocrFails: [],
    ...scenario,
  };
  const calls = [];
  /** processQueueItem() calls: id, options, and whether a scan was running. */
  const ocrCalls = [];
  const queue = new Map();
  let probes = 0;
  const record =
    (name, result) =>
    async (...args) => {
      calls.push(name);
      return typeof result === 'function' ? result(...args) : result;
    };
  const byId = (id) => s.documents.find((item) => item.id === Number(id));

  const fakes = {
    config: {
      minContentLength: 10,
      scanInterval: '*/30 * * * *',
      restrictToExistingTags: 'no',
      restrictToExistingCorrespondents: 'no',
      externalApiConfig: { enabled: 'no' },
      disableAutomaticProcessing: s.disableAutomaticProcessing,
      mistralOcr: {
        enabled: s.ocrEnabled ? 'yes' : 'no',
        runRightAway: s.runRightAway,
        autoProcessEnabled: s.autoProcessEnabled,
        autoProcessBatchSize: s.batchSize,
        autoAnalyze: s.autoAnalyze,
        ocrBeforeAi: 'off',
      },
    },
    documentModel: {
      isDocumentProcessed: record('isDocumentProcessed', false),
      isDocumentIgnored: record('isDocumentIgnored', false),
      isDocumentFailed: record('isDocumentFailed', false),
      setProcessingStatus: record('setProcessingStatus'),
      addToOcrQueue: record('addToOcrQueue', (id, title, reason) => {
        queue.set(Number(id), {
          document_id: Number(id),
          title,
          reason,
          status: 'pending',
        });
        return true;
      }),
      getOcrQueueItem: record(
        'getOcrQueueItem',
        (id) => queue.get(Number(id)) || null
      ),
      getOcrQueue: record('getOcrQueue', (status) =>
        [...queue.values()]
          .filter((row) => !status || row.status === status)
          .map((row) => ({ ...row }))
      ),
      wasEverQueuedForOcr: record('wasEverQueuedForOcr', false),
      addFailedDocument: record('addFailedDocument'),
      deleteDocumentsIdList: record('deleteDocumentsIdList'),
    },
    paperlessService: {
      checkConnection: record('checkConnection', () => {
        const answer =
          s.connections[Math.min(probes, s.connections.length - 1)];
        probes += 1;
        return answer;
      }),
      getAllDocuments: record('getAllDocuments', () =>
        s.documents.map(({ id, title }) => ({ id, title }))
      ),
      getPermissionOfDocument: record('getPermissionOfDocument', true),
      getDocumentContent: record(
        'getDocumentContent',
        (id) => byId(id)?.content ?? TEXT
      ),
      getDocument: record('getDocument', (id) => ({
        id,
        title: byId(id)?.title || `Scan ${id}`,
      })),
      getTags: record('getTags', [{ id: 1, name: 'Tax' }]),
      listCorrespondentsNames: record('listCorrespondentsNames', []),
      listDocumentTypesNames: record('listDocumentTypesNames', []),
    },
    aiServiceFactory: {
      getService: () => ({
        analyzeDocument: record('analyzeDocument', ANALYSIS),
      }),
    },
    mistralOcrService: {
      isEnabled: () => s.ocrEnabled,
      isDocumentActivelyProcessing: () => false,
      processQueueItem: async (id, opts) => {
        ocrCalls.push({
          id: Number(id),
          opts,
          scanRunning: require('../services/scanControl').isRunning(),
        });
        calls.push(`processQueueItem(${id})`);
        if (s.ocrGate) await s.ocrGate;
        if (s.ocrFails.includes(Number(id))) {
          throw new Error('Local OCR failed: model not loaded');
        }
        if (s.staysPending.includes(Number(id))) {
          return { waiting: true };
        }
        const row = queue.get(Number(id));
        if (row) row.status = 'done';
        return { ocrText: 'text', wroteBack: true };
      },
    },
    skipRuleService: { apply: record('skipRules.apply', null) },
    documentProcessingService: {
      buildUpdateData: record('buildUpdateData', { title: 'Phone bill' }),
      saveDocumentChanges: record('saveDocumentChanges', async (id) => {
        if (s.onSave) await s.onSave(id);
      }),
    },
    externalApiService: { fetchData: record('externalApi.fetchData', null) },
    duplicateReviewJobService: { isRunning: () => false },
    duplicateMergeService: { isWriting: () => false },
    scanHealthService: {
      RUN_STATUS: {
        OK: 'ok',
        PAPERLESS_UNREACHABLE: 'paperless_unreachable',
        ERROR: 'error',
      },
      recordRunStart: () => {},
      recordConnectivity: () => {},
      recordRunResult: () => {},
    },
    dashboardStatsService: {
      invalidate: () => calls.push('dashboard.invalidate'),
      refresh: async () => {},
    },
    setupService: { isConfigured: record('isConfigured', true) },
    thumbnailCache: { removeThumbnailCacheForDocumentIds: async () => {} },
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

  return {
    s,
    calls,
    ocrCalls,
    queue,
    fakes,
    scanControl,
    ocr: require(OCR_AUTO),
    scan: require(SCAN_SERVICE),
    webhook: require(WEBHOOK_QUEUE),
    documentPipeline: require('../services/documentPipeline'),
    probes: () => probes,
  };
}

/** Puts pending rows into the fake OCR queue, as a run would have. */
function pending(world, ...ids) {
  ids.forEach((id) =>
    world.queue.set(id, {
      document_id: id,
      title: `Scan ${id}`,
      reason: 'manual',
      status: 'pending',
    })
  );
}

/** A promise the test resolves itself. */
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets detached work (a drain started at a run end) run until `done`. */
async function until(done, rounds = 500) {
  for (let i = 0; i < rounds && !done(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(done(), 'the detached work did not get there');
}

/** Until no drain runs and none is noted. */
function idle(world) {
  return until(() => !world.ocr.running && !world.ocr.waitingTrigger);
}

/**
 * Runs fn with the console captured. Every line is kept as "<level> <text>"
 * with the duration blanked.
 */
async function captured(fn) {
  const saved = {};
  const logs = [];
  for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    saved[level] = console[level];
    console[level] = (...args) => {
      logs.push(
        `${level} ${args
          .filter((arg) => typeof arg === 'string')
          .join(' ')
          .replace(/durationMs=\d+/, 'durationMs=N')}`
      );
    };
  }
  try {
    return { value: await fn(), logs };
  } finally {
    Object.assign(console, saved);
  }
}

/** The "[OCR] Auto-processing ..." lines of a log. */
const drainLines = (logs) =>
  logs
    .filter((line) => line.includes('[OCR] Auto-processing'))
    .map((line) => line.replace(/^\w+ /, ''));

async function main() {
  console.log('The setting');

  await test('off by default: the catalogue entry, the config getter and the page field', () => {
    const catalog = require('../services/settingsCatalog');
    const entry = catalog.getEntry('OCR_RUN_RIGHT_AWAY');
    assert.ok(entry, 'OCR_RUN_RIGHT_AWAY is in the catalogue');
    assert.strictEqual(entry.default, 'no');
    assert.strictEqual(entry.type, 'boolean');
    assert.strictEqual(entry.group, 'OCR fallback');
    assert.strictEqual(entry.field, 'ocrRunRightAway');
    assert.strictEqual(entry.restart, false, 'read at every run end');
    assert.strictEqual(entry.page, true);
    assert.strictEqual(entry.save, true);
    assert.deepStrictEqual(entry.parse(' Yes ', 'no'), { value: 'yes' });
    assert.deepStrictEqual(entry.parse('maybe', 'no'), {});

    const saved = process.env.OCR_RUN_RIGHT_AWAY;
    delete process.env.OCR_RUN_RIGHT_AWAY;
    delete require.cache[modulePaths.config];
    try {
      const config = require('../config/config');
      assert.strictEqual(config.mistralOcr.runRightAway, 'no');
      process.env.OCR_RUN_RIGHT_AWAY = 'yes';
      assert.strictEqual(
        config.mistralOcr.runRightAway,
        'yes',
        'read live, without a reload'
      );
    } finally {
      if (saved === undefined) delete process.env.OCR_RUN_RIGHT_AWAY;
      else process.env.OCR_RUN_RIGHT_AWAY = saved;
      delete require.cache[modulePaths.config];
    }
  });

  await test('the page: the switch is off by default, and the OCR before AI note follows it', async () => {
    const { renderSettingsPage } = require('./helpers/render-settings');
    const catalog = require('../services/settingsCatalog');
    const defaults = catalog.defaultsFromEnv({}, 'page');
    const shown = (html, id) => {
      const tag = html.match(new RegExp(`<[a-z]+ id="${id}"[^>]*>`));
      assert.ok(tag, `${id} is rendered`);
      return !/class="[^"]*\bhidden\b/.test(tag[0]);
    };

    const off = await renderSettingsPage();
    assert.match(
      off,
      /<input type="hidden" id="ocrRunRightAway" name="ocrRunRightAway" value="no">/
    );
    assert.match(off, /Read queued documents right away/);
    assert.match(
      off,
      /OCR reads a document as soon as the scan, webhook or rescan that queued it has finished\. The switch does nothing while OCR is off\./
    );

    const on = await renderSettingsPage({
      config: {
        ...defaults,
        MISTRAL_OCR_ENABLED: 'yes',
        OCR_BEFORE_AI: 'all',
        OCR_RUN_RIGHT_AWAY: 'yes',
      },
    });
    assert.match(
      on,
      /<input type="hidden" id="ocrRunRightAway" name="ocrRunRightAway" value="yes">/
    );
    assert.strictEqual(shown(on, 'ocrBeforeAiQueueRightAway'), true);
    assert.strictEqual(shown(on, 'ocrBeforeAiQueueManual'), false);
    assert.strictEqual(shown(on, 'ocrBeforeAiQueueAuto'), false);
    assert.match(
      on,
      /<div id="ocrBeforeAiQueueNote" class="zr-alert zr-alert--info /
    );

    const manual = await renderSettingsPage({
      config: { ...defaults, MISTRAL_OCR_ENABLED: 'yes', OCR_BEFORE_AI: 'all' },
    });
    assert.strictEqual(shown(manual, 'ocrBeforeAiQueueRightAway'), false);
    assert.strictEqual(shown(manual, 'ocrBeforeAiQueueManual'), true);
    assert.match(
      manual,
      /<div id="ocrBeforeAiQueueNote" class="zr-alert zr-alert--warn /
    );
  });

  await test('off by default: a scan that queues a document leaves it for the OCR cron', async () => {
    const world = makeWorld({ runRightAway: undefined });
    const { logs } = await captured(async () => {
      await world.scan.scanDocuments();
      await idle(world);
    });
    assert.ok(world.calls.includes('addToOcrQueue'), 'the scan queued it');
    assert.deepStrictEqual(world.ocrCalls, [], 'OCR did not read it');
    assert.strictEqual(world.queue.get(7).status, 'pending');
    assert.deepStrictEqual(drainLines(logs), []);
    assert.strictEqual(world.ocr.waitingTrigger, null);
  });

  await test('OCR off: the switch does nothing, also when asked directly', async () => {
    const world = makeWorld({ ocrEnabled: false });
    pending(world, 7);
    const { logs } = await captured(async () => {
      assert.strictEqual(world.ocr.afterRun('scan', 3), null);
      await world.scan.scanDocuments();
      await idle(world);
    });
    assert.deepStrictEqual(world.ocrCalls, []);
    assert.deepStrictEqual(drainLines(logs), []);
    assert.strictEqual(world.ocr.waitingTrigger, null);
    assert.strictEqual(
      world.queue.get(7).status,
      'pending',
      'a queue row from before stays where it is'
    );
  });

  await test('DISABLE_AUTOMATIC_PROCESSING=yes: nothing is read right away after a scan, a webhook or a rescan', async () => {
    const world = makeWorld({ disableAutomaticProcessing: 'yes' });
    pending(world, 42);
    const { logs } = await captured(async () => {
      assert.strictEqual(world.ocr.afterRun('scan', 3), null);
      assert.strictEqual(world.ocr.waitingTrigger, null, 'no trigger held');
      assert.strictEqual(world.ocr.isRightAwayEnabled(), false);
      await world.scan.scanDocuments();
      world.webhook.enqueue(
        { id: 7, title: 'Scan 7' },
        { applySkipRules: true }
      );
      world.webhook.enqueue(
        { id: 7, title: 'Scan 7' },
        { applySkipRules: false }
      );
      await world.webhook.processQueue();
      await idle(world);
    });
    assert.ok(world.calls.includes('addToOcrQueue'), 'the scan queued it');
    assert.deepStrictEqual(world.ocrCalls, [], 'OCR read nothing');
    assert.strictEqual(world.queue.get(7).status, 'pending');
    assert.strictEqual(world.queue.get(42).status, 'pending');
    assert.deepStrictEqual(drainLines(logs), []);
    assert.strictEqual(world.ocr.waitingTrigger, null);
    assert.strictEqual(world.ocr.running, false);
  });

  await test('DISABLE_AUTOMATIC_PROCESSING is read at call time: a held trigger is dropped', async () => {
    const ocrGate = gate();
    const world = makeWorld({ ocrGate: ocrGate.promise });
    pending(world, 7);
    await captured(async () => {
      const first = world.ocr.afterRun('scan', 1);
      await until(() => world.ocrCalls.length === 1);
      pending(world, 8);
      world.ocr.afterRun('webhook', 1);
      assert.strictEqual(world.ocr.waitingTrigger, 'webhook');
      world.fakes.config.disableAutomaticProcessing = 'yes';
      ocrGate.open();
      await first;
      await idle(world);
    });
    assert.deepStrictEqual(
      world.ocrCalls.map((call) => call.id),
      [7]
    );
    assert.strictEqual(world.queue.get(8).status, 'pending');
    assert.strictEqual(world.ocr.waitingTrigger, null);
  });

  console.log('After a scan run');

  await test('the document the scan queued is read once the scan has ended, and analysed', async () => {
    const world = makeWorld({ documents: [doc(7), doc(8, TEXT)] });
    const { logs } = await captured(async () => {
      await world.scan.scanDocuments();
      await idle(world);
    });
    assert.deepStrictEqual(world.ocrCalls, [
      { id: 7, opts: { autoAnalyze: true }, scanRunning: false },
    ]);
    // The drain starts after the scan wrote its last result back.
    const lastSave = world.calls.lastIndexOf('saveDocumentChanges');
    assert.ok(lastSave < world.calls.indexOf('processQueueItem(7)'));
    // The /ocr page reads the queue rows; the dashboard is told.
    assert.strictEqual(world.queue.get(7).status, 'done');
    const ocrRun = world.calls.indexOf('processQueueItem(7)');
    assert.ok(
      world.calls.indexOf('dashboard.invalidate', ocrRun) > ocrRun,
      'the dashboard cache is marked stale after the OCR run'
    );
    assert.deepStrictEqual(drainLines(logs), [
      '[OCR] Auto-processing started (trigger=scan, pending=1, batch=1, autoAnalyze=yes)',
      '[OCR] Auto-processing completed (trigger=scan, processed=1, failed=0, remaining=0, durationMs=N)',
    ]);
  });

  await test('OCR_AUTO_ANALYZE=no is passed on', async () => {
    const world = makeWorld({ autoAnalyze: 'no' });
    await captured(async () => {
      await world.scan.scanDocuments();
      await idle(world);
    });
    assert.deepStrictEqual(
      world.ocrCalls.map((call) => call.opts),
      [{ autoAnalyze: false }]
    );
  });

  await test('a scan that queues nothing starts no drain, and leaves hand-queued rows to the cron', async () => {
    const world = makeWorld({ documents: [doc(8, TEXT)] });
    pending(world, 42);
    const { logs } = await captured(async () => {
      await world.scan.scanDocuments();
      await idle(world);
    });
    assert.deepStrictEqual(world.ocrCalls, []);
    assert.deepStrictEqual(drainLines(logs), []);
  });

  console.log('After a webhook document');

  await test('read right after its own pipeline call; the webhook does not wait for OCR', async () => {
    const ocrGate = gate();
    const world = makeWorld({ documents: [doc(7)], ocrGate: ocrGate.promise });
    const { logs } = await captured(async () => {
      world.webhook.enqueue(
        { id: 7, title: 'Scan 7' },
        { applySkipRules: true }
      );
      await world.webhook.processQueue();
      // The pass is over while OCR still reads the document.
      await until(() => world.ocrCalls.length === 1);
      assert.strictEqual(world.ocr.running, true);
      ocrGate.open();
      await idle(world);
    });
    assert.deepStrictEqual(world.ocrCalls, [
      { id: 7, opts: { autoAnalyze: true }, scanRunning: false },
    ]);
    assert.ok(
      drainLines(logs).includes(
        '[OCR] Auto-processing started (trigger=webhook, pending=1, batch=1, autoAnalyze=yes)'
      ),
      logs.join('\n')
    );
  });

  await test('a rescan by hand names itself as the trigger', async () => {
    const world = makeWorld({ documents: [doc(7)] });
    const { logs } = await captured(async () => {
      world.webhook.enqueue(
        { id: 7, title: 'Scan 7' },
        { applySkipRules: false }
      );
      await world.webhook.processQueue();
      await idle(world);
    });
    assert.deepStrictEqual(
      world.ocrCalls.map((call) => call.id),
      [7]
    );
    assert.ok(
      drainLines(logs).some((line) => line.includes('(trigger=rescan,')),
      logs.join('\n')
    );
  });

  await test('a webhook document queued during a scan waits for the scan to end', async () => {
    const world = makeWorld({ documents: [doc(8, TEXT)] });
    let during = null;
    world.s.onSave = async (id) => {
      if (id !== 8) return;
      world.webhook.enqueue(
        { id: 7, title: 'Scan 7' },
        { applySkipRules: true }
      );
      world.s.documents.push(doc(7));
      await world.webhook.processQueue();
      // Let anything detached run before looking.
      await new Promise((resolve) => setImmediate(resolve));
      during = {
        queued: world.queue.get(7)?.status,
        ocrCalls: world.ocrCalls.length,
        waiting: world.ocr.waitingTrigger,
      };
    };
    const { logs } = await captured(async () => {
      await world.scan.scanDocuments();
      await idle(world);
    });
    assert.deepStrictEqual(
      during,
      { queued: 'pending', ocrCalls: 0, waiting: 'webhook' },
      'queued and noted, not read while the scan runs'
    );
    assert.deepStrictEqual(world.ocrCalls, [
      { id: 7, opts: { autoAnalyze: true }, scanRunning: false },
    ]);
    assert.strictEqual(
      drainLines(logs).filter((line) => line.includes(' started ')).length,
      1,
      'one drain'
    );
  });

  console.log('Coalescing');

  await test('triggers during a drain make it run once more when it ends, not once each', async () => {
    const ocrGate = gate();
    const world = makeWorld({
      ocrGate: ocrGate.promise,
      autoProcessEnabled: 'yes',
    });
    const drains = [];
    const drainQueue = world.ocr.drainQueue.bind(world.ocr);
    world.ocr.drainQueue = (logger, options) => {
      drains.push(options?.trigger || 'schedule');
      return drainQueue(logger, options);
    };
    pending(world, 7);
    const { logs } = await captured(async () => {
      // The OCR cron reads its one batch.
      const cronRun = world.ocr.drainQueue();
      await until(() => world.ocrCalls.length === 1);
      // Two runs queue documents meanwhile.
      pending(world, 8);
      assert.strictEqual(world.ocr.afterRun('webhook', 1), null);
      pending(world, 9);
      assert.strictEqual(world.ocr.afterRun('rescan', 1), null);
      assert.strictEqual(world.ocr.waitingTrigger, 'webhook');
      ocrGate.open();
      const result = await cronRun;
      assert.strictEqual(result.processed, 1, 'the cron run kept its batch');
      await idle(world);
    });
    assert.deepStrictEqual(drains, ['schedule', 'webhook']);
    assert.deepStrictEqual(
      world.ocrCalls.map((call) => call.id),
      [7, 8, 9],
      'each document once'
    );
    assert.deepStrictEqual(drainLines(logs).slice(-2), [
      '[OCR] Auto-processing started (trigger=webhook, pending=2, batch=2, autoAnalyze=yes)',
      '[OCR] Auto-processing completed (trigger=webhook, processed=2, failed=0, remaining=0, durationMs=N)',
    ]);
  });

  await test('a trigger during a drain right after a run: one more drain, which finds what is left', async () => {
    const ocrGate = gate();
    const world = makeWorld({ ocrGate: ocrGate.promise });
    const drains = [];
    const drainQueue = world.ocr.drainQueue.bind(world.ocr);
    world.ocr.drainQueue = (logger, options) => {
      drains.push(options?.trigger || 'schedule');
      return drainQueue(logger, options);
    };
    pending(world, 7);
    await captured(async () => {
      const first = world.ocr.afterRun('scan', 1);
      assert.ok(first, 'a drain started');
      await until(() => world.ocrCalls.length === 1);
      assert.strictEqual(world.ocr.afterRun('webhook', 1), null);
      ocrGate.open();
      await first;
      await idle(world);
    });
    assert.deepStrictEqual(drains, ['scan', 'webhook']);
    assert.deepStrictEqual(
      world.ocrCalls.map((call) => call.id),
      [7]
    );
    assert.strictEqual(world.ocr.waitingTrigger, null, 'nothing left noted');
  });

  await test('the cron does not start next to a drain right after a run', async () => {
    const ocrGate = gate();
    const world = makeWorld({
      ocrGate: ocrGate.promise,
      autoProcessEnabled: 'yes',
    });
    pending(world, 7);
    await captured(async () => {
      const first = world.ocr.afterRun('scan', 1);
      await until(() => world.ocrCalls.length === 1);
      const cron = await world.ocr.drainQueue();
      assert.strictEqual(cron.skipped, 'already_running');
      ocrGate.open();
      await first;
      await idle(world);
    });
    assert.deepStrictEqual(
      world.ocrCalls.map((call) => call.id),
      [7]
    );
  });

  console.log('The drain right after a run');

  await test('it empties the queue over several batches, probing Paperless-ngx before each', async () => {
    const world = makeWorld({ batchSize: 2 });
    pending(world, 1, 2, 3, 4, 5);
    let result;
    const { logs } = await captured(async () => {
      result = await world.ocr.afterRun('scan', 1);
    });
    assert.deepStrictEqual(
      world.ocrCalls.map((call) => call.id),
      [1, 2, 3, 4, 5]
    );
    assert.strictEqual(result.processed, 5);
    assert.strictEqual(result.remaining, 0);
    assert.strictEqual(world.probes(), 4, 'three batches and the empty read');
    assert.deepStrictEqual(drainLines(logs), [
      '[OCR] Auto-processing started (trigger=scan, pending=5, batch=2, autoAnalyze=yes)',
      '[OCR] Auto-processing continues (trigger=scan, pending=3, batch=2, autoAnalyze=yes)',
      '[OCR] Auto-processing continues (trigger=scan, pending=1, batch=1, autoAnalyze=yes)',
      '[OCR] Auto-processing completed (trigger=scan, processed=5, failed=0, remaining=0, durationMs=N)',
    ]);
  });

  await test('a document queued during the drain is read by it', async () => {
    const world = makeWorld({ batchSize: 1 });
    pending(world, 1);
    const process = world.fakes.mistralOcrService.processQueueItem;
    world.fakes.mistralOcrService.processQueueItem = async (id, opts) => {
      if (Number(id) === 1) pending(world, 2);
      return process(id, opts);
    };
    await captured(() => world.ocr.afterRun('webhook', 1));
    assert.deepStrictEqual(
      world.ocrCalls.map((call) => call.id),
      [1, 2]
    );
  });

  await test('an item that stays pending or fails is tried once', async () => {
    const world = makeWorld({ batchSize: 2, staysPending: [1], ocrFails: [2] });
    pending(world, 1, 2, 3);
    let result;
    await captured(async () => {
      result = await world.ocr.afterRun('scan', 1);
    });
    assert.deepStrictEqual(
      world.ocrCalls.map((call) => call.id),
      [1, 2, 3]
    );
    assert.strictEqual(result.processed, 2);
    assert.strictEqual(result.failed, 1);
  });

  await test('an unusable Paperless-ngx: nothing is read, or the drain stops before the next batch', async () => {
    const before = makeWorld({ connections: [DOWN] });
    pending(before, 1, 2);
    const skipped = await captured(() => before.ocr.afterRun('scan', 1));
    assert.strictEqual(skipped.value.skipped, 'paperless_unusable');
    assert.deepStrictEqual(before.ocrCalls, []);
    assert.ok(
      skipped.logs.some((line) =>
        line.includes(
          '[OCR] Auto-processing skipped (trigger=scan): Paperless-ngx is not usable (ECONNREFUSED).'
        )
      ),
      skipped.logs.join('\n')
    );

    const during = makeWorld({ batchSize: 1, connections: [REACHABLE, DOWN] });
    pending(during, 1, 2, 3);
    const stopped = await captured(() => during.ocr.afterRun('scan', 1));
    assert.deepStrictEqual(
      during.ocrCalls.map((call) => call.id),
      [1]
    );
    assert.strictEqual(stopped.value.processed, 1);
    assert.strictEqual(during.queue.get(2).status, 'pending');
    assert.ok(
      stopped.logs.some((line) =>
        line.includes('[OCR] Auto-processing stopped (trigger=scan)')
      ),
      stopped.logs.join('\n')
    );
  });

  await test('the cron keeps one batch per tick', async () => {
    const world = makeWorld({ batchSize: 2, autoProcessEnabled: 'yes' });
    pending(world, 1, 2, 3);
    const { value, logs } = await captured(() => world.ocr.drainQueue());
    assert.deepStrictEqual(
      world.ocrCalls.map((call) => call.id),
      [1, 2]
    );
    assert.strictEqual(value.remaining, 1);
    assert.ok(
      drainLines(logs).includes(
        '[OCR] Auto-processing started (trigger=schedule, pending=3, batch=2, autoAnalyze=yes)'
      ),
      logs.join('\n')
    );
  });

  await test('switched off while a run was noted: the note is dropped', async () => {
    const ocrGate = gate();
    const world = makeWorld({ ocrGate: ocrGate.promise });
    pending(world, 7);
    await captured(async () => {
      const first = world.ocr.afterRun('scan', 1);
      await until(() => world.ocrCalls.length === 1);
      pending(world, 8);
      world.ocr.afterRun('webhook', 1);
      world.fakes.config.mistralOcr.runRightAway = 'no';
      ocrGate.open();
      await first;
      await idle(world);
    });
    assert.deepStrictEqual(
      world.ocrCalls.map((call) => call.id),
      [7]
    );
    assert.strictEqual(world.queue.get(8).status, 'pending');
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
