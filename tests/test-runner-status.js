/**
 * Test: the Task runner status line on the dashboard
 *
 * Covers:
 * 1. services/activityService.js: what a lane holds, what reaches "Ready",
 *    and that bad input never throws
 * 2. The OCR queue is read oldest first, and the OCR cron's next run is known
 *    (a real database and a real node-cron task, in a child process)
 * 3. The browser helpers in public/js/modules/runner-status.js
 * 4. The wiring: every caller reports to the lanes, the status endpoint
 *    carries `activity`, the card carries the status line and the clock
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

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

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

/** Runs code in a fresh process inside a temporary data directory. */
function inTempDir(code, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-runner-board-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error', ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  if (result.status !== 0) {
    throw new Error(`child failed: ${result.stderr || result.stdout}`);
  }
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

(async () => {
  // ────────────────────────────────────────────────────────────────────────
  // 1. The lanes
  // ────────────────────────────────────────────────────────────────────────

  const activity = require('../services/activityService');

  await test('A lane holds a document from start to finish, with its step', () => {
    activity.reset();
    activity.start('analysis', { id: 12, title: 'Invoice' });
    activity.step('analysis', 12, 'ai');
    let snap = activity.snapshot();
    assert.strictEqual(snap.analysis.active.length, 1);
    assert.strictEqual(snap.analysis.active[0].documentId, 12);
    assert.strictEqual(snap.analysis.active[0].title, 'Invoice');
    assert.strictEqual(snap.analysis.active[0].step, 'ai');

    activity.finish('analysis', 12, 'done');
    snap = activity.snapshot();
    assert.strictEqual(snap.analysis.active.length, 0);
    assert.deepStrictEqual(
      snap.analysis.ready.map((d) => d.documentId),
      [12]
    );
    assert.strictEqual(
      snap.ocr.active.length,
      0,
      'the other lane is untouched'
    );
  });

  await test('Only a finished document reaches Ready; failed and skipped just leave', () => {
    activity.reset();
    for (const [id, outcome] of [
      [1, 'failed'],
      [2, 'skipped'],
      [3, 'done'],
    ]) {
      activity.start('ocr', { id, title: `Doc ${id}` }, 'download');
      activity.finish('ocr', id, outcome);
    }
    const snap = activity.snapshot();
    assert.deepStrictEqual(
      snap.ocr.ready.map((d) => d.documentId),
      [3]
    );
    assert.strictEqual(snap.ocr.active.length, 0);
  });

  await test('A second finish (the safety net in release) changes nothing', () => {
    activity.reset();
    activity.start('analysis', { id: 7 });
    activity.finish('analysis', 7, 'done');
    activity.finish('analysis', 7, 'skipped');
    assert.deepStrictEqual(
      activity.snapshot().analysis.ready.map((d) => d.documentId),
      [7]
    );
  });

  await test('Ready keeps the newest few, newest first, without duplicates', () => {
    activity.reset();
    for (let id = 1; id <= activity.READY_LIMIT + 2; id++) {
      activity.start('analysis', { id });
      activity.finish('analysis', id, 'done');
    }
    activity.start('analysis', { id: 7 });
    activity.finish('analysis', 7, 'done');
    const ids = activity.snapshot().analysis.ready.map((d) => d.documentId);
    assert.strictEqual(ids.length, activity.READY_LIMIT);
    assert.strictEqual(ids[0], 7);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  await test('The OCR page reaches the lane as its detail', () => {
    activity.reset();
    activity.start('ocr', { id: 9, title: 'Lease' }, 'download');
    activity.step('ocr', 9, 'ocr', '3/7');
    const entry = activity.snapshot().ocr.active[0];
    assert.strictEqual(entry.step, 'ocr');
    assert.strictEqual(entry.detail, '3/7');
  });

  await test('Bad input is ignored, never thrown', () => {
    activity.reset();
    activity.start('nope', { id: 1 });
    activity.start('analysis', { id: 'x' });
    activity.start('analysis', null);
    activity.step('analysis', 99, 'ai');
    activity.step('analysis', 1, 'dance');
    activity.finish('ocr', -4, 'done');
    activity.scanProgress(Number.NaN);
    const snap = activity.snapshot();
    assert.strictEqual(snap.analysis.active.length, 0);
    assert.strictEqual(snap.scan, null);
  });

  await test('The scan reports where it is in its list, and clears it at the end', () => {
    activity.reset();
    activity.scanProgress(120, 2300);
    assert.deepStrictEqual(activity.snapshot().scan, {
      checked: 120,
      total: 2300,
    });
    activity.scanProgress(null);
    assert.strictEqual(activity.snapshot().scan, null);
  });

  await test('A snapshot is a copy', () => {
    activity.reset();
    activity.start('analysis', { id: 5 });
    const snap = activity.snapshot();
    snap.analysis.active[0].step = 'writeback';
    assert.strictEqual(activity.snapshot().analysis.active[0].step, 'checking');
    activity.reset();
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. Queue order and the OCR cron, against the real modules
  // ────────────────────────────────────────────────────────────────────────

  const modelPath = JSON.stringify(path.join(ROOT, 'models', 'document.js'));

  await test('A run reads the OCR queue oldest first; the OCR page lists it newest first', () => {
    const result = inTempDir(`
      (async () => {
        const model = require(${modelPath});
        const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
        const db = new Database('data/documents.db');
        const add = db.prepare("INSERT INTO ocr_queue (document_id, title, status, added_at) VALUES (?, ?, 'pending', ?)");
        add.run(30, 'Newest', '2026-11-20 10:00:00');
        add.run(10, 'Oldest', '2026-11-18 10:00:00');
        add.run(20, 'Middle', '2026-11-19 10:00:00');
        const oldest = (await model.getOcrQueue('pending', { oldestFirst: true })).map((r) => r.document_id);
        const newest = (await model.getOcrQueue('pending')).map((r) => r.document_id);
        console.log(JSON.stringify({ oldest, newest }));
        process.exit(0);
      })();
    `);
    assert.deepStrictEqual(result.oldest, [10, 20, 30]);
    assert.deepStrictEqual(result.newest, [30, 20, 10]);
  });

  await test('Both queue runs ask for the oldest first', () => {
    assert.ok(
      read('services', 'ocrAutoProcessService.js').includes(
        "getOcrQueue('pending', { oldestFirst: true })"
      ),
      'the OCR drain'
    );
    assert.ok(
      /getOcrQueue\('pending', \{\s*oldestFirst: true,?\s*\}\)/.test(
        read('routes', 'ocr.js')
      ),
      'Process all pending'
    );
  });

  const ocrAutoPath = JSON.stringify(
    path.join(ROOT, 'services', 'ocrAutoProcessService.js')
  );
  const cronPath = JSON.stringify(require.resolve('node-cron'));

  await test('The next OCR run comes from the armed cron task', () => {
    const result = inTempDir(
      `
      const service = require(${ocrAutoPath});
      const cron = require(${cronPath});
      const before = service.getNextRunAt();
      const task = cron.schedule('*/15 * * * *', () => {});
      service.markArmed(() => task.getNextRun());
      const armed = service.getNextRunAt();
      process.env.OCR_AUTO_PROCESS_ENABLED = 'no';
      const switchedOff = service.getNextRunAt();
      task.stop();
      console.log(JSON.stringify({ before, armed, switchedOff }));
      process.exit(0);
    `,
      {
        MISTRAL_OCR_ENABLED: 'yes',
        OCR_AUTO_PROCESS_ENABLED: 'yes',
        CONFIG_SOURCE_MODE: 'legacy',
      }
    );
    assert.strictEqual(result.before, null, 'not armed: no time');
    assert.ok(
      typeof result.armed === 'string' &&
        Date.parse(result.armed) > Date.now() - 1000,
      `armed: a future time, got ${result.armed}`
    );
    assert.strictEqual(result.switchedOff, null, 'switched off since: no time');
  });

  await test('server.js hands the OCR task to markArmed()', () => {
    const server = read('server.js');
    assert.ok(
      /const ocrTask = cron\.schedule\(ocrAutoProcessInterval/.test(server)
    );
    assert.ok(
      server.includes(
        'ocrAutoProcessService.markArmed(() => ocrTask.getNextRun())'
      )
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. Browser helpers
  // ────────────────────────────────────────────────────────────────────────

  const runnerModule = await import(
    path.join(ROOT, 'public', 'js', 'modules', 'runner-status.js')
  );
  const { describeRunner, describeStep } = runnerModule;
  const now = new Date(2026, 10, 20, 14, 0, 0).getTime();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

  await test('Steps read as plain words; the OCR page is named', () => {
    assert.strictEqual(describeStep('analysis', 'ai'), 'Classifying document');
    assert.strictEqual(
      describeStep('analysis', 'writeback'),
      'Writing back to Paperless-ngx'
    );
    assert.strictEqual(describeStep('ocr', 'ocr'), 'Reading with OCR');
    assert.strictEqual(
      describeStep('ocr', 'ocr', '3/7'),
      'Reading with OCR · page 3 of 7'
    );
    assert.strictEqual(describeStep('ocr', 'ai'), 'Classifying document');
    assert.strictEqual(describeStep('analysis', 'nope'), 'Processing document');
  });

  await test('Idle, or an empty payload, says so', () => {
    for (const data of [{}, null, undefined, { activity: {} }]) {
      const view = describeRunner(data, { now });
      assert.strictEqual(view.label, 'System idle');
      assert.strictEqual(view.documentId, null);
      assert.strictEqual(view.busy, false);
      assert.strictEqual(view.ocrWaiting, 0);
      assert.strictEqual(view.nextOcrRun, null);
    }
  });

  await test('A document in progress: its step, its title, its number', () => {
    const view = describeRunner(
      {
        isScanning: true,
        activity: {
          analysis: {
            active: [{ documentId: 123, title: 'Invoice', step: 'ai' }],
          },
        },
      },
      { now }
    );
    assert.deepStrictEqual(
      [view.label, view.detail, view.documentId, view.busy],
      ['Classifying document', 'Invoice', 123, true]
    );
  });

  await test('OCR reading a page shows the page', () => {
    const view = describeRunner(
      {
        activity: {
          ocr: {
            enabled: true,
            running: true,
            active: [
              { documentId: 98, title: 'Lease', step: 'ocr', detail: '3/7' },
            ],
          },
        },
      },
      { now }
    );
    assert.strictEqual(view.label, 'Reading with OCR · page 3 of 7');
    assert.strictEqual(view.detail, 'Lease');
    assert.strictEqual(view.documentId, 98);
  });

  await test('Analysis and OCR at once: the analysis leads, OCR is named', () => {
    const view = describeRunner(
      {
        activity: {
          analysis: {
            active: [{ documentId: 5, title: 'Letter', step: 'checking' }],
          },
          ocr: {
            enabled: true,
            active: [{ documentId: 98, title: 'Lease', step: 'ocr' }],
          },
        },
      },
      { now }
    );
    assert.strictEqual(view.label, 'Checking document');
    assert.strictEqual(view.detail, 'Letter · OCR busy with #98');
  });

  await test('Without a document: scanning with its position, or reading the OCR queue', () => {
    const scanning = describeRunner(
      {
        isScanning: true,
        activity: { analysis: { scan: { checked: 120, total: 2300 } } },
      },
      { now }
    );
    assert.strictEqual(scanning.label, 'Scanning');
    assert.strictEqual(scanning.detail, 'Checked 120 of 2300 documents');

    const ocrRun = describeRunner(
      { activity: { ocr: { enabled: true, running: true } } },
      { now }
    );
    assert.strictEqual(ocrRun.label, 'Reading the OCR queue');
    assert.strictEqual(ocrRun.busy, true);
  });

  await test('The old processing row still names the document', () => {
    const view = describeRunner(
      { currentlyProcessing: { documentId: 7, title: 'Old row' } },
      { now }
    );
    assert.deepStrictEqual(
      [view.label, view.detail, view.documentId],
      ['Processing document', 'Old row', 7]
    );
  });

  await test('Documents waiting for OCR are counted, only with OCR on', () => {
    assert.strictEqual(
      describeRunner(
        { activity: { ocr: { enabled: true, waitingCount: 28 } } },
        { now }
      ).ocrWaiting,
      28
    );
    assert.strictEqual(
      describeRunner(
        { activity: { ocr: { enabled: false, waitingCount: 28 } } },
        { now }
      ).ocrWaiting,
      0
    );
  });

  await test('Next OCR run: clock time and countdown, "Reading now", or nothing', () => {
    const next = describeRunner(
      { activity: { ocr: { enabled: true, nextRunAt: iso(15 * 60_000) } } },
      { now }
    );
    assert.strictEqual(next.nextOcrRun, '14:15 · in 15m 00s');
    assert.strictEqual(next.counting, true);

    const running = describeRunner(
      {
        activity: {
          ocr: { enabled: true, running: true, nextRunAt: iso(60_000) },
        },
      },
      { now }
    );
    assert.strictEqual(running.nextOcrRun, 'Reading now');
    assert.strictEqual(running.counting, false);

    for (const ocr of [
      { enabled: true, nextRunAt: null },
      { enabled: false, nextRunAt: iso(60_000) },
    ]) {
      assert.strictEqual(
        describeRunner({ activity: { ocr } }, { now }).nextOcrRun,
        null
      );
    }
  });

  await test('A long title is cut', () => {
    const view = describeRunner(
      {
        activity: {
          analysis: {
            active: [{ documentId: 1, title: 'x'.repeat(200), step: 'ai' }],
          },
        },
      },
      { now }
    );
    assert.ok(view.detail.length <= 91);
    assert.ok(view.detail.endsWith('…'));
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. Wiring
  // ────────────────────────────────────────────────────────────────────────

  await test('Every caller reports to its lane', () => {
    const pipeline = read('services', 'documentPipeline.js');
    assert.ok(
      pipeline.includes("activityService.start('analysis', doc, 'checking')")
    );
    assert.ok(
      pipeline.includes("activityService.step('analysis', doc.id, 'ai')")
    );
    assert.ok(
      pipeline.includes("activityService.step('analysis', doc.id, 'writeback')")
    );
    assert.ok(
      pipeline.includes(
        "activityService.finish('analysis', documentId, 'skipped')"
      ),
      'release() lets go of the document'
    );
    for (const file of ['scanService.js', 'webhookQueueService.js']) {
      const source = read('services', file);
      assert.ok(
        source.includes("activityService.finish('analysis', doc.id, 'done')"),
        file
      );
      assert.ok(
        source.includes("activityService.finish('analysis', doc.id, 'failed')"),
        file
      );
    }
    const ocr = read('services', 'mistralOcrService.js');
    assert.ok(/activityService\.start\(\s*'ocr'/.test(ocr), 'OCR start');
    assert.ok(
      ocr.includes(
        "activityService.finish('ocr', normalizedDocumentId, laneOutcome)"
      )
    );
  });

  await test('The status endpoint carries activity, and the spec describes it', () => {
    const route = read('routes', 'scan.js');
    assert.ok(route.includes('activity: await buildActivity()'));
    const spec = JSON.parse(read('OPENAPI', 'openapi.json'));
    assert.ok(spec.components.schemas.TaskRunnerActivity, 'schema');
    const props =
      spec.paths['/api/processing-status'].get.responses['200'].content[
        'application/json'
      ].schema.properties;
    assert.ok(props.activity, 'activity in the response');
  });

  await test('The Task runner card carries one status line, the clock and the OCR count', () => {
    const card = read('views', 'partials', 'widgets', 'task-runner.ejs');
    for (const id of [
      'runnerLabel',
      'runnerDetail',
      'currentDocId',
      'ocrWaitingRow',
      'ocrWaitingCount',
      'ocrNextRunRow',
      'ocrNextRun',
    ]) {
      assert.ok(card.includes(`id="${id}"`), `#${id} missing`);
    }
    assert.ok(!card.includes('runnerBoard'), 'no board any more');
    const status = read(
      'views',
      'partials',
      'widgets',
      'processing-status.ejs'
    );
    assert.ok(
      !status.includes('scanClock'),
      'the clock left Processing status'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
