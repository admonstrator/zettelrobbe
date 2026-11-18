'use strict';

/**
 * OCR before the first AI analysis sends a document through OCR at most once,
 * and the analysis afterwards reads the new text exactly once.
 *
 * The OCR queue cannot remember this on its own: a row is deleted when its
 * work is done (text written back and analysed), when someone removes it on
 * the OCR page, and when an unlock releases it. ocr_queue_history, written in
 * the same transaction as every queue insert, keeps the fact that a document
 * was sent; the pipeline asks it through wasEverQueuedForOcr().
 *
 * Runs against a real database in a temporary directory, with the real
 * document pipeline and the real OCR queue run (processQueueItem); only
 * Paperless-ngx, the OCR provider and the AI service are doubles. Each walk
 * prints what happens to one document over three scans in mode `all`, with
 * the OCR queue worked in between the way the OCR page or the automatic run
 * works it.
 *
 * Covers: the queue history itself (insert, refused insert, removal, forget,
 * forgetDocument), the migration that starts it from the rows already in the
 * queue, the config getters, and the cases of the at-most-once rule: AI after
 * OCR, OCR only, a refused write-back, a failed OCR run, a row removed before
 * it ran, no automatic processing, OCR by hand before, a reset of the
 * processed records, an unlocked PDF, and `tagged`.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MODEL_PATH = path.join(ROOT, 'models', 'document.js');

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

const ORIGINAL_TEXT =
  'lnvo1ce Nr 4?11 tel3phone Iine Sept. garbled scan text '.repeat(3);
const OCR_TEXT = 'Invoice No. 4711 for the phone line, September 2026. '.repeat(
  3
);
const OCR_TAG = { id: 5, name: 'Needs-OCR' };

/** Logs off while fn runs; the walks print their own lines. */
async function quietly(fn) {
  const saved = {};
  for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
    saved[method] = console[method];
    console[method] = () => {};
  }
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/* ── The migration, in a database of its own ───────────────────────────── */

/**
 * A database at schema 17 with two queue rows, opened by the model: the
 * migration has to start the history from them. Child processes, because
 * the model opens its database once per process.
 */
function migrationFromSchema17() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-ocr-history-mig-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const run = (code) => {
    const result = spawnSync(process.execPath, ['-e', code], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, LOG_LEVEL: 'error' },
    });
    if (result.status !== 0) {
      throw new Error(`child failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  };

  // A complete database, then turned back into schema 17 with queue rows.
  run(`require(${JSON.stringify(MODEL_PATH)});`);
  run(`
    const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const db = new Database('data/documents.db');
    db.exec('DROP TABLE ocr_queue_history');
    db.pragma('user_version = 17');
    db.prepare("INSERT INTO ocr_queue (document_id, title, reason, status) VALUES (21, 'Done by hand', 'manual', 'done')").run();
    db.prepare("INSERT INTO ocr_queue (document_id, title, reason, status) VALUES (22, 'Failed', 'short_content_lt_10', 'failed')").run();
    db.close();
  `);
  const out = run(`
    (async () => {
      const model = require(${JSON.stringify(MODEL_PATH)});
      const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const answers = {
        21: await model.wasEverQueuedForOcr(21),
        22: await model.wasEverQueuedForOcr(22),
        23: await model.wasEverQueuedForOcr(23),
      };
      await model.removeFromOcrQueue(21);
      answers.afterRemoval21 = await model.wasEverQueuedForOcr(21);
      const db = new Database('data/documents.db', { readonly: true });
      const rows = db.prepare('SELECT document_id, first_reason FROM ocr_queue_history ORDER BY document_id').all();
      const version = db.pragma('user_version', { simple: true });
      process.stdout.write('RESULT' + JSON.stringify({ answers, rows, version }));
    })();
  `);
  fs.rmSync(dir, { recursive: true, force: true });
  return JSON.parse(out.slice(out.indexOf('RESULT') + 'RESULT'.length));
}

/* ── The walks: real database, real pipeline, real OCR queue run ───────── */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-ocr-before-ai-'));
fs.mkdirSync(path.join(tmpDir, 'data'));
// models/document.js opens data/documents.db relative to the working
// directory when it is first required.
process.chdir(tmpDir);

for (const key of Object.keys(process.env)) {
  if (/^(OCR_|MISTRAL_OCR_|MIN_CONTENT_LENGTH|EXTERNAL_API_)/.test(key)) {
    delete process.env[key];
  }
}
process.env.MISTRAL_OCR_ENABLED = 'yes';
process.env.OCR_BEFORE_AI = 'all';

/** What the doubles saw, per document. */
const world = {
  /** @type {Map<number, { id: number, title: string, tags: number[], content: string }>} */
  docs: new Map(),
  /** @type {Map<number, number>} */
  ocrRuns: new Map(),
  /** @type {Map<number, string[]>} */
  analysed: new Map(),
  writeBackAccepted: true,
  ocrFails: false,
  /** @type {Set<number>} documents a skip rule matches */
  skipped: new Set(),
};

const count = (map, id) => map.get(id) || 0;

inject(require.resolve('../services/paperlessService'), {
  initialize: () => {},
  getPermissionOfDocument: async () => true,
  getDocumentContent: async (id) => world.docs.get(id).content,
  getDocument: async (id) => {
    const doc = world.docs.get(id);
    return { id, title: doc.title, tags: doc.tags };
  },
  getTags: async () => [{ id: 1, name: 'Tax' }, OCR_TAG],
});
inject(require.resolve('../services/aiServiceFactory'), {
  getService: () => ({
    analyzeDocument: async (content, _tags, _corr, _types, id) => {
      world.analysed.set(id, [...(world.analysed.get(id) || []), content]);
      return { document: { title: 'Analysed' } };
    },
  }),
});
inject(require.resolve('../services/skipRuleService'), {
  apply: async (doc) => (world.skipped.has(doc.id) ? { reason: 'rule' } : null),
});
inject(require.resolve('../services/documentProcessingService'), {
  buildUpdateData: async () => ({}),
  saveDocumentChanges: async () => {},
});

// Loaded with the console off: the configuration summary and the migration
// lines would drown the walks.
const silenced = {};
for (const method of ['log', 'info', 'debug', 'warn']) {
  silenced[method] = console[method];
  console[method] = () => {};
}
const config = require('../config/config');
const documentModel = require('../models/document');
const documentPipeline = require('../services/documentPipeline');
const mistralOcrService = require('../services/mistralOcrService');
const pdfUnlockService = require('../services/pdfUnlockService');
Object.assign(console, silenced);

// The OCR provider and the write-back. Not a PDF, so no password check runs.
mistralOcrService.downloadDocumentAsBase64 = async () => ({
  base64: Buffer.from('scanned image').toString('base64'),
  mimeType: 'image/png',
});
mistralOcrService.performOcr = async (_base64, _mime, id) => {
  world.ocrRuns.set(id, count(world.ocrRuns, id) + 1);
  if (world.ocrFails) throw new Error('provider unreachable');
  return OCR_TEXT;
};
mistralOcrService.writeBackContent = async (id, text) => {
  if (!world.writeBackAccepted) return false;
  world.docs.get(id).content = text;
  return true;
};
// The analysis after OCR: the same AI double, and the processed record the
// real write-back leaves behind.
mistralOcrService._runAiAnalysis = async (id, text) => {
  world.analysed.set(id, [...(world.analysed.get(id) || []), text]);
  await documentModel.addProcessedDocument(id, 'Analysed');
  return { document: { title: 'Analysed' } };
};

let nextId = 100;
function newDocument({ tags = [1] } = {}) {
  nextId += 1;
  const doc = {
    id: nextId,
    title: `Scan ${nextId}`,
    tags,
    content: ORIGINAL_TEXT,
  };
  world.docs.set(doc.id, doc);
  return doc;
}

/**
 * One scan over one document, with the write-back the scan loop does.
 * Says what the scan did with it.
 */
async function scan(doc) {
  const before = {
    processed: await documentModel.isDocumentProcessed(doc.id),
    failed: await documentModel.isDocumentFailed(doc.id),
    row: (await documentModel.getOcrQueueItem(doc.id))?.status || null,
  };
  if (!documentPipeline.claim(doc.id)) return 'busy';
  try {
    const result = await quietly(() =>
      documentPipeline.processDocument(
        { id: doc.id, title: doc.title, tags: doc.tags },
        ['Tax'],
        [],
        [],
        { source: 'scan' }
      )
    );
    if (result) {
      await quietly(() =>
        documentModel.addProcessedDocument(doc.id, 'Analysed')
      );
      return 'analysed';
    }
    if (before.processed) return 'already done';
    if (before.failed) return 'failed list';
    if (before.row === 'pending') return 'waits for OCR';
    const row = (await documentModel.getOcrQueueItem(doc.id))?.status;
    if (row === 'pending') return 'sent to OCR';
    return world.skipped.has(doc.id) ? 'skip rule' : 'not analysed';
  } catch (error) {
    return `failed: ${error.message}`;
  } finally {
    documentPipeline.release(doc.id);
  }
}

/** The OCR queue worked once: "Process All Pending", or the automatic run. */
async function workOcrQueue({ autoAnalyze }) {
  const pending = await documentModel.getOcrQueue('pending');
  for (const item of pending) {
    await quietly(() =>
      mistralOcrService
        .processQueueItem(item.document_id, { autoAnalyze })
        .catch(() => {})
    );
  }
}

/** One line on where the document stands. */
async function where(doc) {
  const item = await documentModel.getOcrQueueItem(doc.id);
  const row = item
    ? `${item.status} (${item.reason}${item.wrote_back === 0 ? ', text not accepted by Paperless-ngx' : ''})`
    : 'none';
  const texts = (world.analysed.get(doc.id) || []).map((text) =>
    text === OCR_TEXT ? 'OCR text' : 'original text'
  );
  return [
    `queue row: ${row}`,
    `processed: ${(await documentModel.isDocumentProcessed(doc.id)) ? 'yes' : 'no'}`,
    `failed list: ${(await documentModel.isDocumentFailed(doc.id)) ? 'yes' : 'no'}`,
    `OCR runs: ${count(world.ocrRuns, doc.id)}`,
    `analyses: ${texts.length ? texts.join(', ') : 'none'}`,
  ].join(' | ');
}

/** Runs the steps of one walk and prints each with the state after it. */
async function walk(title, doc, steps) {
  console.log(
    `\n  Walk: ${title} (document ${doc.id}, OCR_BEFORE_AI=${config.mistralOcr.ocrBeforeAi})`
  );
  for (const [label, step] of steps) {
    const said = await quietly(step);
    console.log(
      `    ${label.padEnd(30)} ${String(said || '').padEnd(14)} ${await where(doc)}`
    );
  }
}

const scanStep = (n, doc) => [`scan ${n}`, () => scan(doc)];

async function main() {
  console.log('Migration');

  await test('the history starts from the rows in the queue', async () => {
    const result = migrationFromSchema17();
    assert.strictEqual(result.version >= 18, true, `version ${result.version}`);
    assert.deepStrictEqual(result.rows, [
      { document_id: 21, first_reason: 'manual' },
      { document_id: 22, first_reason: 'short_content_lt_10' },
    ]);
    assert.strictEqual(result.answers[21], true);
    assert.strictEqual(result.answers[22], true);
    assert.strictEqual(result.answers[23], false);
    assert.strictEqual(result.answers.afterRemoval21, true);
  });

  console.log('Config');

  await test('the getters read live and fall back to off and needs-ocr', () => {
    const saved = {
      mode: process.env.OCR_BEFORE_AI,
      tag: process.env.OCR_BEFORE_AI_TAG,
    };
    try {
      process.env.OCR_BEFORE_AI = ' Tagged ';
      assert.strictEqual(config.mistralOcr.ocrBeforeAi, 'tagged');
      process.env.OCR_BEFORE_AI = 'ALL';
      assert.strictEqual(config.mistralOcr.ocrBeforeAi, 'all');
      process.env.OCR_BEFORE_AI = 'sometimes';
      assert.strictEqual(config.mistralOcr.ocrBeforeAi, 'off');
      delete process.env.OCR_BEFORE_AI;
      assert.strictEqual(config.mistralOcr.ocrBeforeAi, 'off');
      process.env.OCR_BEFORE_AI_TAG = '  Scan-Me ';
      assert.strictEqual(config.mistralOcr.ocrBeforeAiTag, 'Scan-Me');
      delete process.env.OCR_BEFORE_AI_TAG;
      assert.strictEqual(config.mistralOcr.ocrBeforeAiTag, 'needs-ocr');
    } finally {
      process.env.OCR_BEFORE_AI = saved.mode;
      if (saved.tag === undefined) delete process.env.OCR_BEFORE_AI_TAG;
      else process.env.OCR_BEFORE_AI_TAG = saved.tag;
    }
  });

  console.log('Queue history');

  await test('every queue insert is remembered with its first reason', async () => {
    await quietly(async () => {
      assert.strictEqual(await documentModel.wasEverQueuedForOcr(1), false);
      assert.strictEqual(
        await documentModel.addToOcrQueue(1, 'One', 'ocr_before_ai', {
          skipIfProcessed: true,
        }),
        true
      );
      await documentModel.updateOcrQueueStatus(1, 'failed');
      assert.strictEqual(
        await documentModel.addToOcrQueue(1, 'One', 'manual'),
        true
      );
      await documentModel.removeFromOcrQueue(1);
      assert.strictEqual(await documentModel.getOcrQueueItem(1), undefined);
      assert.strictEqual(await documentModel.wasEverQueuedForOcr(1), true);
    });
  });

  await test('a refused insert is not remembered', async () => {
    await quietly(async () => {
      await documentModel.addProcessedDocument(2, 'Two');
      assert.strictEqual(
        await documentModel.addToOcrQueue(2, 'Two', 'ocr_before_ai', {
          skipIfProcessed: true,
        }),
        false
      );
      assert.strictEqual(await documentModel.wasEverQueuedForOcr(2), false);
    });
  });

  await test('forgetting the history, and forgetting a deleted document', async () => {
    await quietly(async () => {
      await documentModel.addToOcrQueue(3, 'Three', 'manual');
      await documentModel.removeFromOcrQueue(3);
      assert.strictEqual(await documentModel.forgetOcrQueueHistory(3), true);
      assert.strictEqual(await documentModel.wasEverQueuedForOcr(3), false);

      await documentModel.addToOcrQueue(4, 'Four', 'manual');
      documentModel.forgetDocument(4);
      assert.strictEqual(await documentModel.wasEverQueuedForOcr(4), false);
    });
  });

  console.log('Three scans in mode all');

  await test('automatic OCR with AI after OCR: one OCR run, one analysis of the OCR text', async () => {
    const doc = newDocument();
    await walk('OCR queue worked with AI analysis after OCR', doc, [
      scanStep(1, doc),
      [
        'OCR queue run (AI after OCR)',
        () => workOcrQueue({ autoAnalyze: true }),
      ],
      scanStep(2, doc),
      scanStep(3, doc),
    ]);
    assert.strictEqual(count(world.ocrRuns, doc.id), 1);
    assert.deepStrictEqual(world.analysed.get(doc.id), [OCR_TEXT]);
    assert.strictEqual(await documentModel.getOcrQueueItem(doc.id), undefined);
    assert.strictEqual(await documentModel.isDocumentProcessed(doc.id), true);

    // "Reset all": the processed records go, the queue row went with the
    // finished run. The scan analyses again, but OCR is not bought twice.
    await walk('after resetting all processed records', doc, [
      ['reset all processed', () => documentModel.deleteAllDocuments()],
      scanStep(4, doc),
    ]);
    assert.strictEqual(count(world.ocrRuns, doc.id), 1);
    assert.deepStrictEqual(world.analysed.get(doc.id), [OCR_TEXT, OCR_TEXT]);
  });

  await test('OCR only: the next scan analyses the new text, once', async () => {
    const doc = newDocument();
    await walk('OCR queue worked without AI after OCR', doc, [
      scanStep(1, doc),
      ['OCR queue run (OCR only)', () => workOcrQueue({ autoAnalyze: false })],
      scanStep(2, doc),
      scanStep(3, doc),
    ]);
    assert.strictEqual(count(world.ocrRuns, doc.id), 1);
    assert.deepStrictEqual(world.analysed.get(doc.id), [OCR_TEXT]);
  });

  await test('Paperless-ngx refuses the OCR text: the scan analyses the stored text', async () => {
    const doc = newDocument();
    world.writeBackAccepted = false;
    try {
      await walk('write-back refused, no AI after OCR', doc, [
        scanStep(1, doc),
        [
          'OCR queue run (OCR only)',
          () => workOcrQueue({ autoAnalyze: false }),
        ],
        scanStep(2, doc),
        scanStep(3, doc),
      ]);
    } finally {
      world.writeBackAccepted = true;
    }
    assert.strictEqual(count(world.ocrRuns, doc.id), 1);
    assert.deepStrictEqual(world.analysed.get(doc.id), [OCR_TEXT]);
    assert.strictEqual(
      doc.content,
      ORIGINAL_TEXT,
      'Paperless-ngx kept its text'
    );
  });

  await test('a failed OCR run is not queued again; after a reset the old text is analysed', async () => {
    const doc = newDocument();
    world.ocrFails = true;
    try {
      await walk('OCR run fails', doc, [
        scanStep(1, doc),
        ['OCR queue run (fails)', () => workOcrQueue({ autoAnalyze: true })],
        scanStep(2, doc),
        [
          'failed list reset by hand',
          () => documentModel.resetFailedDocument(doc.id),
        ],
        scanStep(3, doc),
      ]);
    } finally {
      world.ocrFails = false;
    }
    assert.strictEqual(count(world.ocrRuns, doc.id), 1);
    assert.deepStrictEqual(world.analysed.get(doc.id), [ORIGINAL_TEXT]);
  });

  await test('removed from the queue before it ran: analysed, never queued again', async () => {
    const doc = newDocument();
    await walk('queue row removed on the OCR page', doc, [
      scanStep(1, doc),
      [
        'removed from the OCR queue',
        () => documentModel.removeFromOcrQueue(doc.id),
      ],
      scanStep(2, doc),
      scanStep(3, doc),
    ]);
    assert.strictEqual(count(world.ocrRuns, doc.id), 0);
    assert.deepStrictEqual(world.analysed.get(doc.id), [ORIGINAL_TEXT]);
  });

  await test('without automatic OCR processing the document waits until someone starts it', async () => {
    const doc = newDocument();
    await walk('nobody works the OCR queue', doc, [
      scanStep(1, doc),
      scanStep(2, doc),
      scanStep(3, doc),
      [
        'Process All Pending (OCR page)',
        () => workOcrQueue({ autoAnalyze: true }),
      ],
    ]);
    assert.strictEqual(count(world.ocrRuns, doc.id), 1);
    assert.deepStrictEqual(world.analysed.get(doc.id), [OCR_TEXT]);
  });

  await test('a document sent to OCR by hand before is not sent again', async () => {
    const doc = newDocument();
    await walk('OCR by hand first', doc, [
      [
        'sent to OCR by hand',
        () => documentModel.addToOcrQueue(doc.id, doc.title, 'manual'),
      ],
      ['OCR queue run (OCR only)', () => workOcrQueue({ autoAnalyze: false })],
      scanStep(1, doc),
      scanStep(2, doc),
    ]);
    assert.strictEqual(count(world.ocrRuns, doc.id), 1);
    assert.deepStrictEqual(world.analysed.get(doc.id), [OCR_TEXT]);
  });

  await test('an unlocked PDF may go through OCR first once more', async () => {
    const doc = newDocument();
    await walk('password-protected PDF unlocked', doc, [
      scanStep(1, doc),
      [
        'unlocked and released',
        () => quietly(() => pdfUnlockService._release(doc.id)),
      ],
      scanStep(2, doc),
    ]);
    const item = await documentModel.getOcrQueueItem(doc.id);
    assert.strictEqual(item?.status, 'pending');
    assert.strictEqual(item?.reason, 'ocr_before_ai');
  });

  await test('a skip rule wins: neither a queue row nor an analysis', async () => {
    const doc = newDocument();
    world.skipped.add(doc.id);
    await walk('matched by a skip rule', doc, [scanStep(1, doc)]);
    assert.strictEqual(await documentModel.wasEverQueuedForOcr(doc.id), false);
    assert.strictEqual(world.analysed.get(doc.id), undefined);
  });

  console.log('Tagged');

  await test('tagged: only the document with the tag goes to OCR first', async () => {
    process.env.OCR_BEFORE_AI = 'tagged';
    process.env.OCR_BEFORE_AI_TAG = 'needs-ocr';
    try {
      const tagged = newDocument({ tags: [1, OCR_TAG.id] });
      const plain = newDocument({ tags: [1] });
      await walk('carries the OCR tag', tagged, [
        scanStep(1, tagged),
        [
          'OCR queue run (AI after OCR)',
          () => workOcrQueue({ autoAnalyze: true }),
        ],
        scanStep(2, tagged),
      ]);
      await walk('without the OCR tag', plain, [scanStep(1, plain)]);
      assert.strictEqual(count(world.ocrRuns, tagged.id), 1);
      assert.deepStrictEqual(world.analysed.get(tagged.id), [OCR_TEXT]);
      assert.strictEqual(count(world.ocrRuns, plain.id), 0);
      assert.deepStrictEqual(world.analysed.get(plain.id), [ORIGINAL_TEXT]);
    } finally {
      process.env.OCR_BEFORE_AI = 'all';
      delete process.env.OCR_BEFORE_AI_TAG;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((error) => {
    console.error(error);
    failed += 1;
  })
  .finally(() => {
    process.chdir(ROOT);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(failed > 0 ? 1 : 0);
  });
