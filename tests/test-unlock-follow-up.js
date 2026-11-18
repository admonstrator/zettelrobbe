/**
 * Test: an unlocked PDF is processed as soon as Paperless-ngx has stored the
 * unlocked version
 *
 * Paperless-ngx answers the password removal before the unlocked file is a
 * version of the document. services/unlockFollowUpService.js waits for the
 * new version with a bounded poll and then hands the document to the webhook
 * queue as source 'unlock'. These tests run the real follow-up, the real
 * unlock service, the real webhook queue and the real pipeline; Paperless-ngx,
 * the database, pdfinfo, OCR, the skip rules and the AI service are doubles,
 * and the clock is a fake one, so nothing sleeps for real.
 *
 * Covers:
 * 1. The analysis starts at the first look after the new version appears,
 *    never before, and reads the new text; the unlock answer does not wait
 * 2. The wait runs out: no analysis, no error, the claim is given back and
 *    the next scan may take the document
 * 3. Paperless-ngx unreachable for a while: the looks are repeated
 * 4. DISABLE_AUTOMATIC_PROCESSING=yes: no follow-up at all
 * 5. One follow-up per document
 * 6. "Unlock all": the documents are analysed one after the other, and a
 *    slow one does not hold the others back
 * 7. The OCR run that met the locked file and unlocked it ends before the
 *    follow-up analyses the document
 * 8. The protections of a new document: skip rules, ignored list,
 *    OCR_BEFORE_AI, too little text goes to the OCR queue
 * 9. A scan holding the document: the follow-up waits for it, and a document
 *    the scan analysed is not analysed again
 * 10. No version list: the file itself is asked
 * 11. A document deleted in Paperless-ngx meanwhile ends the follow-up
 * 12. The 'unlock' caller profile has the switches of a webhook delivery
 */

'use strict';

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
  pdfPasswordService: require.resolve('../services/pdfPasswordService'),
};
const underTest = [
  require.resolve('../services/unlockFollowUpService'),
  require.resolve('../services/pdfUnlockService'),
  require.resolve('../services/webhookQueueService'),
  path.join(ROOT, 'services', 'documentPipeline.js'),
];

const { parsePasswordList } = require('../services/pdfPasswordService');
const { OCR_BEFORE_AI_REASON } = require('../services/ocrBeforeAi');

let passed = 0;
let failed = 0;
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

async function test(name, fn) {
  const before = unhandled.length;
  try {
    await fn();
    assert.strictEqual(unhandled.length, before, 'no unhandled rejection');
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

const LOCKED = Buffer.from('%PDF-1.7 locked');
const OPEN = Buffer.from('%PDF-1.7 open');
const TEXT = 'Payslip for November, net amount and tax class. '.repeat(3);
const ANALYSIS = { document: { title: 'Payslip November' } };

/**
 * A clock whose time moves only when a timer fires, in time order.
 */
function makeClock() {
  const timers = [];
  const clock = {
    t: 0,
    now: () => clock.t,
    sleep: (ms) =>
      new Promise((resolve) => {
        timers.push({ at: clock.t + ms, resolve });
      }),
    /** When the earliest timer fires; Infinity when none is set. */
    nextAt: () =>
      timers.length ? Math.min(...timers.map((timer) => timer.at)) : Infinity,
    /** Fires the earliest timer; false when none is set. */
    advance() {
      if (!timers.length) return false;
      timers.sort((a, b) => a.at - b.at);
      const timer = timers.shift();
      clock.t = Math.max(clock.t, timer.at);
      timer.resolve();
      return true;
    },
  };
  return clock;
}

async function flush() {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Fresh doubles and freshly loaded real modules for one scenario.
 *
 * @param {object} [scenario]
 */
function makeWorld(scenario = {}) {
  const s = {
    // How long after the password removal Paperless-ngx has stored the
    // unlocked version, per document, in fake milliseconds (0 when not
    // given); Infinity means never.
    storedAfter: {},
    versionList: true,
    versionErrors: [],
    contentAfter: TEXT,
    ocrEnabled: false,
    ocrBeforeAi: 'off',
    automaticOff: false,
    ignored: [],
    processed: [],
    skipMatch: [],
    activeOcrUntil: {},
    deletedAt: {},
    lockedItems: [],
    ...scenario,
  };
  const clock = makeClock();
  const log = { log: [], info: [], warn: [], error: [] };
  const w = {
    s,
    clock,
    log,
    looks: [],
    downloads: [],
    analyses: [],
    saved: [],
    statuses: [],
    queued: [],
    skipChecks: [],
    removed: [],
    active: 0,
    maxActive: 0,
  };

  const removedAt = {};
  const stored = (id) =>
    id in removedAt && clock.now() >= removedAt[id] + (s.storedAfter[id] ?? 0);
  const status404 = () => {
    const error = new Error('Request failed with status code 404');
    error.response = { status: 404 };
    return error;
  };

  const fakes = {
    config: {
      minContentLength: 10,
      restrictToExistingTags: 'no',
      restrictToExistingCorrespondents: 'no',
      externalApiConfig: { enabled: 'no' },
      get disableAutomaticProcessing() {
        return s.automaticOff ? 'yes' : 'no';
      },
      mistralOcr: {
        pdfPasswords: '["right"]',
        get ocrBeforeAi() {
          return s.ocrBeforeAi;
        },
        ocrBeforeAiTag: 'needs-ocr',
      },
    },
    documentModel: {
      isDocumentProcessed: async (id) => s.processed.includes(id),
      isDocumentIgnored: async (id) => s.ignored.includes(id),
      isDocumentFailed: async () => false,
      setProcessingStatus: async (id, _title, status) => {
        w.statuses.push([id, status]);
      },
      getOcrQueueItem: async () => null,
      addToOcrQueue: async (id, _title, reason) => {
        w.queued.push([id, reason]);
        return true;
      },
      wasEverQueuedForOcr: async () => false,
      addFailedDocument: async () => true,
      removeFromOcrQueue: async () => true,
      forgetOcrQueueHistory: async () => true,
      resetFailedDocument: async () => true,
      getPasswordProtectedOcrItems: async () =>
        s.lockedItems.map((id) => ({
          document_id: id,
          title: `Payslip ${id}`,
        })),
      deleteDocumentsIdList: async () => true,
    },
    paperlessService: {
      getPasswordRemovalSupport: async () => ({
        supported: true,
        version: '3.5.1',
      }),
      downloadOriginalFile: async (id) => {
        w.downloads.push([id, clock.now()]);
        return {
          buffer: stored(id) ? OPEN : LOCKED,
          mimeType: 'application/pdf',
        };
      },
      removePassword: async (id) => {
        w.removed.push([id, clock.now()]);
        removedAt[id] = clock.now();
      },
      getDocumentVersionIds: async (id) => {
        w.looks.push([id, clock.now()]);
        if (clock.now() >= (s.deletedAt[id] ?? Infinity)) throw status404();
        if (s.versionErrors.length) throw new Error(s.versionErrors.shift());
        if (!s.versionList) return null;
        return stored(id) ? [id + 1000, id] : [id];
      },
      getDocument: async (id) => {
        if (clock.now() >= (s.deletedAt[id] ?? Infinity)) throw status404();
        return { id, title: `Payslip ${id}`, tags: [] };
      },
      getDocumentContent: async (id) => (stored(id) ? s.contentAfter : ''),
      getPermissionOfDocument: async () => true,
      getTags: async () => [],
      listCorrespondentsNames: async () => [],
      listDocumentTypesNames: async () => [],
    },
    setupService: { isConfigured: async () => true },
    aiServiceFactory: {
      getService: () => ({
        analyzeDocument: async (content, _tags, _corr, _types, id) => {
          w.active += 1;
          w.maxActive = Math.max(w.maxActive, w.active);
          w.analyses.push({ id, at: clock.now(), content });
          // Room for a second analysis to start, if anything allowed one.
          await new Promise((resolve) => setImmediate(resolve));
          await new Promise((resolve) => setImmediate(resolve));
          w.active -= 1;
          return ANALYSIS;
        },
      }),
    },
    mistralOcrService: {
      isEnabled: () => s.ocrEnabled,
      isDocumentActivelyProcessing: (id) =>
        clock.now() < (s.activeOcrUntil[id] ?? -1),
    },
    skipRuleService: {
      apply: async (doc) => {
        w.skipChecks.push(doc.id);
        return s.skipMatch.includes(doc.id);
      },
    },
    documentProcessingService: {
      buildUpdateData: async () => ({ title: 'Payslip November' }),
      saveDocumentChanges: async (id) => {
        w.saved.push(id);
      },
    },
    thumbnailCache: { removeThumbnailCacheForDocumentIds: async () => {} },
    externalApiService: { fetchData: async () => null },
    pdfPasswordService: {
      parsePasswordList,
      needsPassword: async (buffer) => buffer.equals(LOCKED),
      findPassword: async (_buffer, candidates) =>
        candidates.includes('right') ? 'right' : null,
    },
  };

  for (const key of Object.keys(modulePaths)) {
    delete require.cache[modulePaths[key]];
    inject(modulePaths[key], fakes[key]);
  }
  for (const modulePath of underTest) {
    delete require.cache[modulePath];
  }

  w.followUps = require('../services/unlockFollowUpService');
  w.followUps.clock = clock;
  w.unlock = require('../services/pdfUnlockService');
  w.queue = require('../services/webhookQueueService');
  w.pipeline = require('../services/documentPipeline');

  /** Fires the timers set for `time` or earlier, in order. */
  w.runUntil = async (time) => {
    await flush();
    while (clock.nextAt() <= time) {
      clock.advance();
      await flush();
    }
  };

  /** Runs everything until nothing is left to do, firing timers in order. */
  w.settle = async () => {
    for (let step = 0; step < 5000; step += 1) {
      await flush();
      if (w.queue.isProcessing || w.queue.getQueueLength() > 0) continue;
      if (w.followUps.waitingDocumentIds().length === 0) {
        await w.followUps.whenIdle();
        await flush();
        if (!w.queue.isProcessing && w.queue.getQueueLength() === 0) return;
        continue;
      }
      if (!clock.advance()) {
        throw new Error('follow-ups wait, but no timer is set');
      }
    }
    throw new Error('did not settle');
  };

  return w;
}

/** Runs fn with the console captured into w.log. */
async function quietly(w, fn) {
  const saved = {};
  for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
    saved[method] = console[method];
  }
  console.log = (...args) => w.log.log.push(args.join(' '));
  console.debug = () => {};
  console.info = (...args) => w.log.info.push(args.join(' '));
  console.warn = (...args) => w.log.warn.push(args.join(' '));
  console.error = (...args) => w.log.error.push(args.join(' '));
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const lookTimes = (w, id) =>
  w.looks.filter(([doc]) => doc === id).map(([, at]) => at);

async function main() {
  console.log('Waiting for the unlocked version');

  await test('the analysis starts after the new version appears, not before', async () => {
    const w = makeWorld({ storedAfter: { 7: 12000 } });
    await quietly(w, async () => {
      const answer = await w.unlock.unlock(7, { password: 'right' });
      // The answer does not wait: nothing was looked at or analysed yet.
      assert.strictEqual(answer.outcome, 'unlocked');
      assert.match(answer.message, /as soon as Paperless-ngx has stored/);
      assert.strictEqual(w.analyses.length, 0);
      assert.deepStrictEqual(w.followUps.waitingDocumentIds(), [7]);
      // While it waits, nobody else gets the document.
      assert.strictEqual(w.pipeline.claim(7), false);
      await w.settle();
    });
    // Versions read once before the removal (t=0), then 5 s, 10 s, 20 s.
    assert.deepStrictEqual(lookTimes(w, 7), [0, 5000, 10000, 20000]);
    assert.deepStrictEqual(w.analyses, [{ id: 7, at: 20000, content: TEXT }]);
    assert.ok(
      w.analyses.every((a) => a.at >= 12000),
      'never before'
    );
    assert.deepStrictEqual(w.saved, [7]);
    assert.deepStrictEqual(w.statuses.at(-1), [7, 'complete']);
    assert.strictEqual(w.pipeline.inFlight.size, 0, 'claim given back');
  });

  await test('the wait runs out: no analysis, no error, the scan may take it', async () => {
    const w = makeWorld({ storedAfter: { 7: Infinity } });
    await quietly(w, async () => {
      await w.unlock.unlock(7, { password: 'right' });
      await w.settle();
    });
    assert.deepStrictEqual(w.analyses, []);
    assert.deepStrictEqual(w.followUps.waitingDocumentIds(), []);
    assert.strictEqual(w.pipeline.inFlight.size, 0, 'claim given back');
    const looks = lookTimes(w, 7);
    assert.ok(looks.at(-1) >= 15 * 60 * 1000, `last look ${looks.at(-1)}`);
    assert.ok(looks.at(-1) < 16 * 60 * 1000, `last look ${looks.at(-1)}`);
    // The pauses grow and stop growing at one minute.
    const pauses = looks.slice(2).map((at, i) => at - looks[i + 1]);
    assert.deepStrictEqual(
      pauses.slice(0, 6),
      [5000, 10000, 15000, 30000, 60000, 60000]
    );
    assert.ok(w.log.warn.some((line) => /next scan processes it/.test(line)));
    assert.deepStrictEqual(w.log.error, []);
    // Afterwards the scan claims it like any other document.
    assert.strictEqual(w.pipeline.claim(7), true);
  });

  await test('Paperless-ngx unreachable for a while: the looks are repeated', async () => {
    const w = makeWorld({
      storedAfter: { 7: 0 },
      versionErrors: [],
    });
    await quietly(w, async () => {
      await w.unlock.unlock(7, { password: 'right' });
      w.s.versionErrors.push('connect ECONNREFUSED', 'socket hang up');
      await w.settle();
    });
    assert.deepStrictEqual(lookTimes(w, 7), [0, 5000, 10000, 20000]);
    assert.deepStrictEqual(
      w.analyses.map((a) => [a.id, a.at]),
      [[7, 20000]]
    );
    assert.strictEqual(
      w.log.warn.filter((line) => /trying again/.test(line)).length,
      2
    );
  });

  console.log('Automatic processing off');

  await test('DISABLE_AUTOMATIC_PROCESSING=yes: no follow-up starts', async () => {
    const w = makeWorld({ automaticOff: true, storedAfter: { 7: 0 } });
    await quietly(w, async () => {
      const answer = await w.unlock.unlock(7, { password: 'right' });
      assert.strictEqual(answer.outcome, 'unlocked');
      assert.match(answer.message, /scan you start by hand/);
      assert.strictEqual(
        w.followUps.schedule(8, { versionStored: true }),
        'automatic_processing_off'
      );
      await w.settle();
    });
    assert.deepStrictEqual(w.followUps.waitingDocumentIds(), []);
    assert.deepStrictEqual(w.looks, [], 'no version read at all');
    assert.deepStrictEqual(w.analyses, []);
    assert.strictEqual(w.pipeline.inFlight.size, 0);
  });

  console.log('One follow-up per document');

  await test('a second unlock or schedule does not add a second follow-up', async () => {
    const w = makeWorld({ storedAfter: { 7: 7000 } });
    await quietly(w, async () => {
      await w.unlock.unlock(7, { password: 'right' });
      const again = await w.unlock.unlock(7, { password: 'right' });
      assert.strictEqual(again.outcome, 'busy');
      assert.match(again.message, /still storing the unlocked version/);
      assert.strictEqual(
        w.followUps.schedule(7, { versionsBefore: [7] }),
        'already_waiting'
      );
      await w.settle();
    });
    assert.strictEqual(w.removed.length, 1, 'removed once');
    assert.deepStrictEqual(
      w.analyses.map((a) => a.id),
      [7]
    );
  });

  console.log('Unlock all');

  await test('unlock all: analysed one after the other, in order', async () => {
    const w = makeWorld({
      lockedItems: [11, 12, 13],
      storedAfter: { 11: 3000, 12: 3000, 13: 3000 },
    });
    await quietly(w, async () => {
      const lines = [];
      const summary = await w.unlock.unlockAllLocked((item) =>
        lines.push(item.message)
      );
      // The run reports at once and promises no scan.
      assert.deepStrictEqual(summary, {
        total: 3,
        unlocked: 3,
        stillLocked: 0,
      });
      assert.strictEqual(w.analyses.length, 0);
      assert.ok(lines.every((line) => /as soon as Paperless-ngx/.test(line)));
      await w.settle();
    });
    assert.deepStrictEqual(
      w.analyses.map((a) => [a.id, a.at]),
      [
        [11, 5000],
        [12, 5000],
        [13, 5000],
      ]
    );
    assert.strictEqual(w.maxActive, 1, 'never two analyses at once');
    assert.deepStrictEqual(w.saved, [11, 12, 13]);
  });

  await test('unlock all: a slow document does not hold the others back', async () => {
    const w = makeWorld({
      lockedItems: [11, 12, 13],
      storedAfter: { 11: Infinity, 12: 3000, 13: 8000 },
    });
    await quietly(w, async () => {
      await w.unlock.unlockAllLocked();
      await w.settle();
    });
    assert.deepStrictEqual(
      w.analyses.map((a) => [a.id, a.at]),
      [
        [12, 5000],
        [13, 10000],
      ]
    );
    assert.ok(
      w.log.warn.some((line) => /Document 11: .*15 minutes/.test(line))
    );
  });

  console.log('The OCR run that unlocked it');

  await test('the OCR run ends before the follow-up takes the document', async () => {
    const w = makeWorld({
      storedAfter: { 7: 3000 },
      activeOcrUntil: { 7: 12000 },
    });
    await quietly(w, async () => {
      // As processQueueItem() calls it: with the file it downloaded.
      const answer = await w.unlock.unlock(7, {
        file: LOCKED,
        fromOcrRun: true,
      });
      assert.strictEqual(answer.outcome, 'unlocked');
      assert.strictEqual(w.downloads.length, 0, 'the run’s own file is used');
      await w.settle();
    });
    // Looks at 5 s and 10 s find the OCR run still on the document and do
    // not even ask Paperless-ngx; the analysis waits for the run to end.
    assert.deepStrictEqual(lookTimes(w, 7), [0, 20000]);
    assert.deepStrictEqual(
      w.analyses.map((a) => [a.id, a.at]),
      [[7, 20000]]
    );
  });

  console.log('The protections of a new document');

  await test('skip rules apply', async () => {
    const w = makeWorld({ storedAfter: { 7: 0 }, skipMatch: [7] });
    await quietly(w, async () => {
      await w.unlock.unlock(7, { password: 'right' });
      await w.settle();
    });
    assert.deepStrictEqual(w.skipChecks, [7]);
    assert.deepStrictEqual(w.analyses, []);
  });

  await test('the ignored list applies', async () => {
    const w = makeWorld({ storedAfter: { 7: 0 }, ignored: [7] });
    await quietly(w, async () => {
      await w.unlock.unlock(7, { password: 'right' });
      await w.settle();
    });
    assert.deepStrictEqual(w.skipChecks, []);
    assert.deepStrictEqual(w.analyses, []);
  });

  await test('OCR_BEFORE_AI sends the unlocked file to OCR first', async () => {
    const w = makeWorld({
      storedAfter: { 7: 0 },
      ocrEnabled: true,
      ocrBeforeAi: 'all',
    });
    await quietly(w, async () => {
      await w.unlock.unlock(7, { password: 'right' });
      await w.settle();
    });
    assert.deepStrictEqual(w.skipChecks, [7], 'skip rules first');
    assert.deepStrictEqual(w.queued, [[7, OCR_BEFORE_AI_REASON]]);
    assert.deepStrictEqual(w.analyses, []);
  });

  await test('too little text: the OCR queue, this time with a file that opens', async () => {
    const w = makeWorld({
      storedAfter: { 7: 0 },
      ocrEnabled: true,
      contentAfter: '',
    });
    await quietly(w, async () => {
      await w.unlock.unlock(7, { password: 'right' });
      await w.settle();
    });
    assert.deepStrictEqual(w.queued, [[7, 'short_content_lt_10']]);
    assert.deepStrictEqual(w.analyses, []);
  });

  console.log('A scan on the same document');

  await test('a scan holding the document: the follow-up waits for it', async () => {
    const w = makeWorld({ storedAfter: { 7: 0 } });
    await quietly(w, async () => {
      // A scan passing by holds the document when the unlock finishes.
      assert.strictEqual(w.pipeline.claim(7), true);
      await w.unlock.unlock(7, { password: 'right' });
      await w.runUntil(5000); // the look at 5 s: still held
      w.pipeline.release(7);
      await w.settle();
    });
    assert.deepStrictEqual(
      w.analyses.map((a) => [a.id, a.at]),
      [[7, 10000]]
    );
  });

  await test('a document the scan analysed is not analysed again', async () => {
    const w = makeWorld({ storedAfter: { 7: 0 } });
    await quietly(w, async () => {
      assert.strictEqual(w.pipeline.claim(7), true);
      await w.unlock.unlock(7, { password: 'right' });
      await w.runUntil(5000);
      // The scan finished it and wrote it back.
      w.s.processed.push(7);
      w.pipeline.release(7);
      await w.settle();
    });
    assert.deepStrictEqual(w.analyses, []);
    assert.ok(
      w.log.log.some((line) => /7 already in processed_documents/.test(line))
    );
  });

  console.log('Other signs and endings');

  await test('no version list: the file itself is asked', async () => {
    const w = makeWorld({ storedAfter: { 7: 7000 }, versionList: false });
    await quietly(w, async () => {
      await w.unlock.unlock(7, { password: 'right' });
      await w.settle();
    });
    // One download to find the password, then one per look.
    assert.deepStrictEqual(
      w.downloads.map(([, at]) => at),
      [0, 5000, 10000]
    );
    assert.deepStrictEqual(
      w.analyses.map((a) => [a.id, a.at]),
      [[7, 10000]]
    );
  });

  await test('a document deleted in Paperless-ngx meanwhile ends the follow-up', async () => {
    const w = makeWorld({
      storedAfter: { 7: Infinity },
      deletedAt: { 7: 8000 },
    });
    await quietly(w, async () => {
      await w.unlock.unlock(7, { password: 'right' });
      await w.settle();
    });
    assert.deepStrictEqual(lookTimes(w, 7), [0, 5000, 10000]);
    assert.deepStrictEqual(w.analyses, []);
    assert.strictEqual(w.pipeline.inFlight.size, 0);
    assert.ok(w.log.info.some((line) => /no longer exists/.test(line)));
  });

  console.log('Caller profile');

  await test("the 'unlock' profile has the switches of a webhook delivery", () => {
    const w = makeWorld();
    const profiles = w.pipeline.CALLER_PROFILES;
    assert.deepStrictEqual({ ...profiles.unlock }, { ...profiles.webhook });
    assert.strictEqual(profiles.unlock.applySkipRules, true);
    assert.strictEqual(profiles.unlock.checkIgnoredList, true);
    assert.strictEqual(profiles.unlock.applyOcrBeforeAi, true);
    assert.strictEqual(profiles.unlock.trackRetries, false);
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
