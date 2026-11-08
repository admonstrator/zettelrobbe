'use strict';

/**
 * Test: tidy-up-endpoints
 *
 * The /api/tidy-up/* routes (routes/tidyUp.js) over HTTP, with the real run
 * service, the real merge service and the real judge against a fake
 * Paperless-ngx and a fake model (tests/helpers/tidy-up-archive.js).
 *
 * Covers:
 *  1. no API route answers without authentication
 *  2. before any run: current is 204, the suggestions are empty
 *  3. POST /runs answers 202 with a TidyUpRun; a bad body is a 400, an
 *     action that is not wired up a 501, a second start a 409 with the run
 *  4. /runs/:id/events streams snapshots and ends after the last one; a
 *     stop ends the run as stopped and keeps the suggestions
 *  5. /runs/current and /runs/:id read the run; an unknown id is a 404
 *  6. accepting a merge performs it in Paperless-ngx, answers done with an
 *     undoId; /recent lists it; undoing the batch reverts it
 *  7. declining stores the pair as "not a duplicate"
 *  8. decide refuses an unknown id and an unknown decision
 *  9. /duplicates and /simplify answer 301 to /tidy-up
 * 10. the page locals: model, splits, counts, last run
 */

const assert = require('assert');
const path = require('path');
const {
  mountArchive,
  modelAnswer,
  TAGS,
} = require('./helpers/tidy-up-archive');
const { REPO_ROOT } = require('./helpers/mount-router');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed += 1;
  }
}

const API_KEY = 'test-api-key';
const RUN_KEYS = [
  'id',
  'status',
  'headline',
  'options',
  'steps',
  'progress',
  'model',
  'failure',
  'partialFailures',
  'summary',
  'startedAt',
  'finishedAt',
];

const pairId = (kind, a, b) =>
  `merge:${kind}:${Math.min(a, b)}-${Math.max(a, b)}`;

async function main() {
  const archive = await mountArchive();
  const { harness } = archive;
  const { jobs, runs } = archive.services;

  const call = async (method, url, body) => {
    const response = await fetch(harness.base + url, {
      method,
      redirect: 'manual',
      headers: {
        'x-api-key': API_KEY,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  };

  /** Reads an SSE stream to its end; calls onEvent for every snapshot. */
  const readEvents = async (url, onEvent = () => {}) => {
    const response = await fetch(harness.base + url, {
      headers: { 'x-api-key': API_KEY },
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('x-accel-buffering'), 'no');
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const decoder = new TextDecoder();
    const events = [];
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (!block.startsWith('data: ')) continue;
        const snapshot = JSON.parse(block.slice(6));
        events.push(snapshot);
        await onEvent(snapshot, events.length);
      }
    }
    return events;
  };

  const runToEnd = async (body) => {
    const started = await call('POST', '/api/tidy-up/runs', body);
    assert.strictEqual(started.status, 202, JSON.stringify(started.body));
    await jobs.wait(started.body.data.id);
    return started.body.data.id;
  };

  try {
    await test('No API route answers without authentication', async () => {
      for (const [method, url] of [
        ['POST', '/api/tidy-up/runs'],
        ['GET', '/api/tidy-up/runs/current'],
        ['GET', '/api/tidy-up/runs/x/events'],
        ['POST', '/api/tidy-up/runs/x/stop'],
        ['GET', '/api/tidy-up/suggestions'],
        ['POST', '/api/tidy-up/suggestions/decide'],
        ['POST', '/api/tidy-up/suggestions/undo'],
        ['GET', '/api/tidy-up/recent'],
      ]) {
        const response = await fetch(harness.base + url, {
          method,
          redirect: 'manual',
        });
        assert.strictEqual(response.status, 302, `${method} ${url}`);
        assert.strictEqual(response.headers.get('location'), '/login');
      }
    });

    await test('Before any run there is nothing to show', async () => {
      await archive.reset();
      const current = await call('GET', '/api/tidy-up/runs/current');
      assert.strictEqual(current.status, 204);
      const list = await call('GET', '/api/tidy-up/suggestions');
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.body.data.runId, null);
      assert.deepStrictEqual(list.body.data.suggestions, []);
      assert.strictEqual(list.body.data.summary.total, 0);
    });

    await test('POST /runs starts one run and refuses what it cannot do', async () => {
      await archive.reset();
      const bad = await call('POST', '/api/tidy-up/runs', {
        kind: 'documents',
      });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.body.success, false);
      const notYet = await call('POST', '/api/tidy-up/runs', {
        action: 'retry-larger',
      });
      assert.strictEqual(notYet.status, 501);
      assert.match(notYet.body.error, /settings/);

      archive.fakeOpenAI.setScript({
        chunks: [{ content: modelAnswer() }],
        chunkDelayMs: 1500,
      });
      const started = await call('POST', '/api/tidy-up/runs', {
        askModel: true,
      });
      assert.strictEqual(started.status, 202);
      assert.strictEqual(started.body.success, true);
      const run = started.body.data;
      for (const key of RUN_KEYS) assert.ok(key in run, `TidyUpRun.${key}`);
      assert.strictEqual(run.status, 'running');
      assert.deepStrictEqual(
        run.steps.map((step) => step.key),
        ['compare', 'evidence', 'judge', 'split', 'sort']
      );
      assert.strictEqual(
        run.steps[3].state,
        'skipped',
        'splits were not asked'
      );
      assert.deepStrictEqual(run.options, {
        askModel: true,
        suggestSplits: false,
        kind: 'all',
      });

      const again = await call('POST', '/api/tidy-up/runs', {});
      assert.strictEqual(again.status, 409);
      assert.strictEqual(again.body.data.id, run.id, 'the 409 names the run');

      // Follow the run; stop it once the first snapshot is in.
      let stopped = null;
      const events = await readEvents(
        `/api/tidy-up/runs/${run.id}/events`,
        async (snapshot, count) => {
          if (count === 1) {
            stopped = await call('POST', `/api/tidy-up/runs/${run.id}/stop`);
          }
        }
      );
      assert.ok(events.length >= 1, 'at least one snapshot');
      assert.strictEqual(stopped.status, 200);
      assert.ok(['stopping', 'stopped'].includes(stopped.body.data.status));
      const last = events[events.length - 1];
      assert.strictEqual(
        last.status,
        'stopped',
        'the stream ends with the stop'
      );
      assert.ok(last.summary.total > 0, 'the comparison is kept');
      for (const key of RUN_KEYS) assert.ok(key in last, `snapshot.${key}`);

      const current = await call('GET', '/api/tidy-up/runs/current');
      assert.strictEqual(current.status, 200);
      assert.strictEqual(current.body.data.id, run.id);
      assert.strictEqual(current.body.data.status, 'stopped');
      const one = await call('GET', `/api/tidy-up/runs/${run.id}`);
      assert.strictEqual(one.body.data.id, run.id);
      assert.strictEqual(
        (await call('GET', '/api/tidy-up/runs/nope')).status,
        404
      );
      // A finished run's stream says its last word at once and ends.
      const replay = await readEvents(`/api/tidy-up/runs/${run.id}/events`);
      assert.strictEqual(replay.length, 1);
      assert.strictEqual(replay[0].status, 'stopped');

      const list = await call('GET', '/api/tidy-up/suggestions');
      assert.strictEqual(list.body.data.runId, run.id);
      assert.ok(list.body.data.suggestions.length > 0);
    });

    await test('Accepting a merge performs it, recent lists it, undo reverts it', async () => {
      await archive.reset();
      await runToEnd({ askModel: false });
      const invoiceId = pairId('tags', TAGS.invoice, TAGS.invoices);

      const decided = await call('POST', '/api/tidy-up/suggestions/decide', {
        ids: [invoiceId],
        decision: 'accept',
      });
      assert.strictEqual(decided.status, 200, JSON.stringify(decided.body));
      const data = decided.body.data;
      assert.ok(data.batchId);
      const done = data.suggestions.find((s) => s.id === invoiceId);
      assert.strictEqual(done.status, 'done', done.outcome);
      assert.strictEqual(done.outcome, '1 document moved');
      assert.ok(done.undoId);
      assert.strictEqual(data.summary.done, 1);
      const tags = await archive.services.merges.listEntities('tags');
      assert.ok(!tags.some((tag) => tag.name === 'Invoices'), 'merged away');

      const recent = await call('GET', '/api/tidy-up/recent');
      assert.strictEqual(recent.status, 200);
      const row = recent.body.data[0];
      assert.strictEqual(row.id, done.undoId);
      assert.strictEqual(
        row.sentence,
        'Merged Invoices into invoice · 1 document moved'
      );
      assert.strictEqual(row.status, 'done');
      assert.strictEqual(row.canUndo, true);
      assert.ok(!Number.isNaN(Date.parse(row.when)), 'when is a date');

      const undone = await call('POST', '/api/tidy-up/suggestions/undo', {
        batchId: data.batchId,
      });
      assert.strictEqual(undone.status, 200, JSON.stringify(undone.body));
      assert.deepStrictEqual(undone.body.data.undone, [done.undoId]);
      assert.deepStrictEqual(undone.body.data.failed, []);
      assert.strictEqual(
        undone.body.data.suggestions.find((s) => s.id === invoiceId).status,
        'open'
      );
      const back = await archive.services.merges.listEntities('tags');
      assert.ok(
        back.some((tag) => tag.name === 'Invoices'),
        'restored'
      );
      const after = await call('GET', '/api/tidy-up/recent');
      assert.strictEqual(after.body.data[0].status, 'undone');
      assert.strictEqual(after.body.data[0].canUndo, false);

      const missing = await call('POST', '/api/tidy-up/suggestions/undo', {});
      assert.strictEqual(missing.status, 400);
    });

    await test('Declining stores the pair as not a duplicate', async () => {
      await archive.reset();
      await runToEnd({ askModel: false });
      const taxId = pairId('tags', TAGS.steuerberater, TAGS.steuerberatr);
      const declined = await call('POST', '/api/tidy-up/suggestions/decide', {
        ids: [taxId],
        decision: 'decline',
      });
      assert.strictEqual(declined.status, 200);
      assert.strictEqual(
        declined.body.data.suggestions.find((s) => s.id === taxId).status,
        'declined'
      );
      const dismissals = await call(
        'GET',
        '/api/duplicates/dismissals?kind=tags'
      );
      assert.ok(
        dismissals.body.data.some(
          (row) =>
            [row.idA, row.idB].sort().join('-') ===
            [TAGS.steuerberater, TAGS.steuerberatr].sort().join('-')
        ),
        'the pair is stored'
      );
    });

    await test('Decide refuses what it does not know', async () => {
      const unknown = await call('POST', '/api/tidy-up/suggestions/decide', {
        ids: ['merge:tags:998-999'],
        decision: 'accept',
      });
      assert.strictEqual(unknown.status, 404);
      const bad = await call('POST', '/api/tidy-up/suggestions/decide', {
        ids: [pairId('tags', TAGS.invoice, TAGS.invoices)],
        decision: 'maybe',
      });
      assert.strictEqual(bad.status, 400);
      const empty = await call('POST', '/api/tidy-up/suggestions/decide', {
        ids: [],
        decision: 'accept',
      });
      assert.strictEqual(empty.status, 400);
    });

    await test('/duplicates and /simplify move to /tidy-up', async () => {
      const jwt = require(path.join(REPO_ROOT, 'node_modules', 'jsonwebtoken'));
      const session = jwt.sign(
        { username: 'tester', typ: 'session' },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      );
      for (const url of ['/duplicates', '/simplify']) {
        const response = await fetch(harness.base + url, {
          redirect: 'manual',
          headers: { Cookie: `jwt=${session}` },
        });
        assert.strictEqual(response.status, 301, url);
        assert.strictEqual(response.headers.get('location'), '/tidy-up');
      }
    });

    await test('The page locals say what the start screen needs', async () => {
      await archive.reset();
      const before = await runs.pageLocals();
      assert.strictEqual(before.modelAvailable, true);
      assert.strictEqual(before.modelLabel, 'fake-model');
      assert.strictEqual(before.splitsAvailable, true);
      assert.deepStrictEqual(before.counts, { tags: 11, correspondents: 2 });

      await runToEnd({ askModel: false });
      await runs.decide({
        ids: [pairId('tags', TAGS.invoice, TAGS.invoices)],
        decision: 'accept',
      });
      const after = await runs.pageLocals();
      assert.ok(after.lastRun, 'a run happened');
      assert.strictEqual(after.lastRun.accepted, 1);
      assert.ok(!Number.isNaN(Date.parse(after.lastRun.when)));
      assert.strictEqual(after.counts.tags, 10, 'one tag was merged away');

      assert.strictEqual(runs.modelLabelOf('claude-haiku-4-5'), 'Claude Haiku');
      assert.strictEqual(runs.modelLabelOf('qwen3:8b'), 'qwen3:8b');
    });
  } finally {
    await archive.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('[FAIL] tidy-up-endpoints');
    process.exit(1);
  }
  console.log('[PASS] tidy-up-endpoints');
  process.exit(0);
}

main().catch((error) => {
  console.error('[FAIL] tidy-up-endpoints', error);
  process.exit(1);
});
