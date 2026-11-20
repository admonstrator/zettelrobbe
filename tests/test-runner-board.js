/**
 * Test: the Task runner board on the dashboard
 *
 * Covers:
 * 1. services/activityService.js: what a lane holds, what reaches "Ready",
 *    and that bad input never throws
 * 2. The OCR queue is read oldest first, and the OCR cron's next run is known
 *    (a real database and a real node-cron task, in a child process)
 * 3. The browser helpers in public/js/modules/runner-board.js
 * 4. The wiring: every caller reports to the lanes, the status endpoint
 *    carries `activity`, the card carries the board and the clock
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

  const board = await import(
    path.join(ROOT, 'public', 'js', 'modules', 'runner-board.js')
  );
  const { describeBoard, describeStep, formatElapsed, WAITING_SHOWN } = board;
  const now = new Date(2026, 10, 20, 14, 0, 0).getTime();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

  await test('Steps read as words; the OCR page is named', () => {
    assert.strictEqual(describeStep('ai'), 'Asking the AI');
    assert.strictEqual(describeStep('writeback'), 'Writing back');
    assert.strictEqual(describeStep('ocr'), 'Reading');
    assert.strictEqual(describeStep('ocr', '3/7'), 'Reading page 3/7');
    assert.strictEqual(describeStep('something'), 'Working');
  });

  await test('Elapsed time reads like a stopwatch', () => {
    assert.strictEqual(formatElapsed(14_000), '0:14');
    assert.strictEqual(formatElapsed(725_000), '12:05');
    assert.strictEqual(formatElapsed(3_729_000), '1:02:09');
    assert.strictEqual(formatElapsed(-5), '0:00');
  });

  await test('An empty or missing payload gives an empty board, OCR off', () => {
    for (const data of [{}, null, undefined, { activity: {} }]) {
      const view = describeBoard(data, { now });
      assert.deepStrictEqual(view.analysis.active, []);
      assert.deepStrictEqual(view.analysis.waiting.tickets, []);
      assert.strictEqual(view.ocr.off, true);
      assert.strictEqual(view.nextOcrRun, null);
      assert.strictEqual(view.ticking, false);
    }
  });

  await test('In progress: number, step and stopwatch; the board ticks', () => {
    const view = describeBoard(
      {
        activity: {
          analysis: {
            active: [
              {
                documentId: 123,
                title: 'Invoice',
                step: 'ai',
                startedAt: iso(-14_000),
              },
            ],
          },
          ocr: {
            enabled: true,
            active: [
              {
                documentId: 98,
                title: 'Lease',
                step: 'ocr',
                detail: '3/7',
                startedAt: iso(-161_000),
              },
            ],
          },
        },
      },
      { now }
    );
    assert.deepStrictEqual(
      [
        view.analysis.active[0].number,
        view.analysis.active[0].step,
        view.analysis.active[0].elapsed,
      ],
      ['#123', 'Asking the AI', '0:14']
    );
    assert.deepStrictEqual(
      [
        view.ocr.active[0].number,
        view.ocr.active[0].step,
        view.ocr.active[0].elapsed,
      ],
      ['#98', 'Reading page 3/7', '2:41']
    );
    assert.strictEqual(view.ticking, true);
  });

  await test('Waiting shows the first few tickets and counts the rest', () => {
    const waiting = Array.from({ length: 8 }, (_, i) => ({
      documentId: 100 + i,
      title: `Scan ${i}`,
    }));
    const view = describeBoard(
      { activity: { ocr: { enabled: true, waiting, waitingCount: 28 } } },
      { now }
    );
    assert.strictEqual(view.ocr.waiting.tickets.length, WAITING_SHOWN);
    assert.strictEqual(view.ocr.waiting.tickets[0].number, '#100');
    assert.strictEqual(view.ocr.waiting.more, 28 - WAITING_SHOWN);
  });

  await test('The OCR waiting note says why nothing moves', () => {
    const queue = { waiting: [{ documentId: 5 }], waitingCount: 1 };
    const forScan = describeBoard(
      { activity: { ocr: { enabled: true, ...queue, waitingForScan: true } } },
      { now }
    );
    assert.strictEqual(forScan.ocr.note, 'Starts when the scan is done');

    const scheduled = describeBoard(
      {
        activity: {
          ocr: { enabled: true, ...queue, nextRunAt: iso(15 * 60_000) },
        },
      },
      { now }
    );
    assert.strictEqual(scheduled.ocr.note, 'Next run 14:15');

    const byHand = describeBoard(
      { activity: { ocr: { enabled: true, ...queue } } },
      { now }
    );
    assert.strictEqual(byHand.ocr.note, 'Waits to be started');

    const reading = describeBoard(
      { activity: { ocr: { enabled: true, ...queue, running: true } } },
      { now }
    );
    assert.strictEqual(reading.ocr.note, '');
  });

  await test('The analysis lane says where the scan is in its list', () => {
    const view = describeBoard(
      { activity: { analysis: { scan: { checked: 120, total: 2300 } } } },
      { now }
    );
    assert.strictEqual(view.analysis.note, 'Scan checks 120 of 2300');
  });

  await test('Next OCR run: clock time and countdown, "Reading now", or nothing', () => {
    const next = describeBoard(
      { activity: { ocr: { enabled: true, nextRunAt: iso(15 * 60_000) } } },
      { now }
    );
    assert.strictEqual(next.nextOcrRun, '14:15 · in 15m 00s');
    assert.strictEqual(next.ticking, true);

    const running = describeBoard(
      {
        activity: {
          ocr: { enabled: true, running: true, nextRunAt: iso(60_000) },
        },
      },
      { now }
    );
    assert.strictEqual(running.nextOcrRun, 'Reading now');

    const unarmed = describeBoard(
      { activity: { ocr: { enabled: true, nextRunAt: null } } },
      { now }
    );
    assert.strictEqual(unarmed.nextOcrRun, null);

    const off = describeBoard(
      { activity: { ocr: { enabled: false, nextRunAt: iso(60_000) } } },
      { now }
    );
    assert.strictEqual(off.nextOcrRun, null);
  });

  await test('Ready shows the last three, OCR off shows none', () => {
    const ready = [1, 2, 3, 4, 5].map((documentId) => ({ documentId }));
    const view = describeBoard(
      {
        activity: {
          analysis: { ready },
          ocr: { enabled: false, ready },
        },
      },
      { now }
    );
    assert.deepStrictEqual(
      view.analysis.ready.map((t) => t.number),
      ['#1', '#2', '#3']
    );
    assert.deepStrictEqual(view.ocr.ready, []);
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

  await test('The Task runner card carries both lanes, three columns and the next OCR run', () => {
    const card = read('views', 'partials', 'widgets', 'task-runner.ejs');
    assert.ok(card.includes('id="runnerBoard"'));
    assert.ok(card.includes("['analysis', 'Analysis'], ['ocr', 'OCR']"));
    for (const hook of [
      'data-lane-waiting',
      'data-lane-active',
      'data-lane-ready',
    ]) {
      assert.ok(card.includes(hook), hook);
    }
    for (const label of ['Waiting', 'In progress', 'Ready']) {
      assert.ok(card.includes(`<span>${label}</span>`), label);
    }
    assert.ok(card.includes('id="ocrNextRunRow"'));
    assert.ok(card.includes('id="ocrNextRun"'));
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
