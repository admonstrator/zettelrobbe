'use strict';

/**
 * Contract test for services/duplicateReviewJobService.js: the one AI review
 * that runs as a job the page can watch and stop.
 *
 * The judge is stubbed; what is under test is the job's life cycle, the
 * events its subscribers get, the control object the judge receives, and the
 * two brakes (stop by the user or the judge, stop when nobody watches).
 *
 * Cases:
 *  1. start() returns a running job, current() is it, a second start is a 409
 *  2. progress events reach a subscriber, done carries the result, wait() and
 *     result() agree, the estimate appears once requests are answered
 *  3. stop() aborts the signal; a judge that returns a partial result ends the
 *     job as stopped with that result
 *  4. the judge's own stop(reason) ends the job as stopped with that reason
 *  5. a judge that throws after the abort ends as stopped without a result
 *  6. a judge that throws on its own ends as failed with the message
 *  7. the idle watch stops an unwatched job and leaves a watched one alone
 *  8. a subscriber of a finished job gets the final event at once
 *  9. the budget and the idle seconds come from the settings
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-review-job-'));
fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
process.chdir(tmpDir);
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  PAPERLESS_API_URL: 'http://127.0.0.1:9/api',
  PAPERLESS_API_TOKEN: 'test-token',
  AI_PROVIDER: 'openai',
  OPENAI_API_KEY: 'test-key',
  OPENAI_MODEL: 'test-model',
  DISABLE_AUTOMATIC_PROCESSING: 'yes',
  CONFIG_SOURCE_MODE: 'runtime-first',
  DUPLICATES_AI_TOKEN_BUDGET: '5000',
  DUPLICATES_AI_IDLE_STOP_SECONDS: '60',
});

const REPO_ROOT = path.resolve(__dirname, '..');
const jobs = require(
  path.join(REPO_ROOT, 'services', 'duplicateReviewJobService')
);
const judge = require(path.join(REPO_ROOT, 'services', 'entityMatchAiService'));

const realReviewScan = judge.reviewScan;
const quiet = console.log;
console.log = () => {};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  jobs.reset();
  try {
    await fn();
    quiet(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed += 1;
  } finally {
    judge.reviewScan = realReviewScan;
    jobs.reset();
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function result(extra = {}) {
  return {
    scannedAt: new Date().toISOString(),
    threshold: 0.95,
    totals: { tags: 0, correspondents: 0 },
    groups: [],
    dismissedPairs: 0,
    aiReview: { enabled: true, requests: 1, tokens: 120, ...extra },
  };
}

/** A judge that waits until told to finish, so the job can be looked at. */
function gate() {
  let release;
  const opened = new Promise((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

(async () => {
  await test('start() returns a running job and refuses a second one', async () => {
    const g = gate();
    judge.reviewScan = async () => {
      await g.opened;
      return result();
    };
    const job = jobs.start({ kind: 'tags', threshold: 0.9 });
    assert.strictEqual(job.status, 'running');
    assert.ok(job.id.length > 10);
    assert.strictEqual(jobs.current(), job);
    assert.strictEqual(jobs.get(job.id), job);
    assert.strictEqual(jobs.get('nope'), null);
    assert.strictEqual(jobs.isRunning(), true);

    const shape = jobs.toJSON(job);
    assert.deepStrictEqual(Object.keys(shape).sort(), [
      'error',
      'finishedAt',
      'hasResult',
      'id',
      'options',
      'progress',
      'startedAt',
      'status',
      'stopReason',
    ]);
    assert.deepStrictEqual(shape.options, { kind: 'tags', threshold: 0.9 });
    assert.strictEqual(shape.progress.phase, 'starting');
    assert.strictEqual(shape.progress.tokenBudget, 5000);
    assert.strictEqual(shape.progress.requestsDone, 0);
    assert.strictEqual(shape.progress.etaMs, null);
    assert.strictEqual(shape.hasResult, false);
    assert.strictEqual('controller' in shape, false);

    assert.throws(
      () => jobs.start({ kind: 'all' }),
      (error) => error.status === 409 && error.job.id === job.id
    );
    g.release();
    await jobs.wait(job.id);
    assert.strictEqual(jobs.isRunning(), false);
  });

  await test('a subscriber gets progress, then done with the result', async () => {
    let control = null;
    judge.reviewScan = async (options, given) => {
      control = given;
      given.onProgress({ phase: 'scanning', message: 'Scanning…' });
      given.onProgress({
        phase: 'judging',
        kind: 'tags',
        requestsPlanned: 4,
        pairsTotal: 40,
        estimatedTokens: 3000,
      });
      await sleep(12);
      given.onProgress({
        message: 'Asking the model, request 1 of 4',
        requestsDone: 1,
        pairsJudged: 10,
        tokens: 700,
      });
      return result({ requests: 4, tokens: 2800 });
    };
    const job = jobs.start({ kind: 'all' });
    const events = [];
    const unsubscribe = jobs.subscribe(job.id, (event) => events.push(event));
    const final = await jobs.wait(job.id);
    unsubscribe();

    assert.ok(control, 'the judge received a control object');
    assert.ok(control.signal instanceof AbortSignal);
    assert.strictEqual(control.tokenBudget, 5000);
    assert.strictEqual(typeof control.onProgress, 'function');
    assert.strictEqual(typeof control.stop, 'function');

    // The first event is the snapshot a late subscriber gets: the two
    // synchronous reports of the stub happened before subscribe().
    const types = events.map((event) => event.type);
    assert.deepStrictEqual(types, ['progress', 'progress', 'done']);
    const judging = events[0].job.progress;
    assert.strictEqual(judging.phase, 'judging');
    assert.strictEqual(judging.requestsPlanned, 4);
    assert.strictEqual(judging.pairsTotal, 40);
    assert.strictEqual(judging.etaMs, null, 'no estimate before an answer');
    const answered = events[1].job.progress;
    assert.strictEqual(answered.requestsDone, 1);
    assert.strictEqual(answered.tokens, 700);
    assert.ok(answered.etaMs > 0, 'an estimate once a request answered');
    assert.ok(answered.elapsedMs >= 10);
    assert.strictEqual(answered.phase, 'judging', 'a patch keeps the phase');

    assert.strictEqual(final.type, 'done');
    assert.strictEqual(final.job.status, 'done');
    assert.strictEqual(final.job.hasResult, true);
    assert.strictEqual(final.job.progress.etaMs, null);
    assert.strictEqual(final.data.aiReview.tokens, 2800);
    assert.strictEqual(events[2].data, final.data);
    assert.strictEqual(jobs.result(job.id), final.data);
    assert.strictEqual(jobs.current().status, 'done', 'retained after the end');
  });

  await test('stop() aborts the signal and keeps a partial result', async () => {
    judge.reviewScan = async (options, control) => {
      control.onProgress({ phase: 'judging', requestsPlanned: 3 });
      await new Promise((resolve) =>
        control.signal.addEventListener('abort', resolve, { once: true })
      );
      return result({ stopped: true, pairsNotJudged: 20 });
    };
    const job = jobs.start({ kind: 'tags' });
    const events = [];
    jobs.subscribe(job.id, (event) => events.push(event));
    await tick();
    const stopping = jobs.stop(job.id);
    assert.strictEqual(stopping.status, 'stopping');
    assert.strictEqual(stopping.stopReason, 'user');
    assert.strictEqual(job.controller.signal.aborted, true);
    assert.strictEqual(jobs.isRunning(), true, 'still winding down');
    assert.throws(
      () => jobs.start({}),
      (error) => error.status === 409
    );

    const final = await jobs.wait(job.id);
    assert.strictEqual(final.type, 'stopped');
    assert.strictEqual(final.job.status, 'stopped');
    assert.strictEqual(final.job.stopReason, 'user');
    assert.strictEqual(final.data.aiReview.stopped, true);
    assert.strictEqual(final.data.aiReview.stopReason, 'user');
    assert.strictEqual(final.data.aiReview.pairsNotJudged, 20);
    assert.ok(
      events.some(
        (event) =>
          event.type === 'progress' &&
          /Stopping/.test(event.job.progress.message)
      ),
      'the stop shows up as progress'
    );
    assert.strictEqual(
      jobs.stop(job.id),
      job,
      'stopping a finished job is a no-op'
    );
    assert.strictEqual(jobs.stop('nope'), null);
  });

  await test("the judge's own stop(reason) ends the job with that reason", async () => {
    judge.reviewScan = async (options, control) => {
      control.onProgress({ phase: 'judging', requestsDone: 2, tokens: 5200 });
      control.stop('token-budget');
      assert.strictEqual(control.signal.aborted, true);
      return result({ tokens: 5200 });
    };
    const job = jobs.start({ kind: 'tags' });
    const final = await jobs.wait(job.id);
    assert.strictEqual(final.type, 'stopped');
    assert.strictEqual(final.job.stopReason, 'token-budget');
    assert.strictEqual(final.data.aiReview.stopped, true);
    assert.strictEqual(final.data.aiReview.stopReason, 'token-budget');
  });

  await test('a judge that throws after the abort ends as stopped, without a result', async () => {
    judge.reviewScan = async (options, control) => {
      await new Promise((resolve) =>
        control.signal.addEventListener('abort', resolve, { once: true })
      );
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };
    const job = jobs.start({ kind: 'tags' });
    await tick();
    jobs.stop(job.id, 'idle');
    const final = await jobs.wait(job.id);
    assert.strictEqual(final.type, 'stopped');
    assert.strictEqual(final.job.stopReason, 'idle');
    assert.strictEqual(final.job.hasResult, false);
    assert.strictEqual(final.data, null);
    assert.strictEqual(final.job.error, null);
  });

  await test('a judge that fails on its own ends the job as failed', async () => {
    judge.reviewScan = async () => {
      const error = new Error('The AI review is switched off');
      error.status = 409;
      throw error;
    };
    const job = jobs.start({ kind: 'tags' });
    const final = await jobs.wait(job.id);
    assert.strictEqual(final.type, 'failed');
    assert.strictEqual(final.job.status, 'failed');
    assert.strictEqual(final.error, 'The AI review is switched off');
    assert.strictEqual(job.errorStatus, 409);
    assert.strictEqual(final.job.hasResult, false);
    assert.strictEqual(jobs.isRunning(), false);
  });

  await test('the idle watch stops an unwatched job and spares a watched one', async () => {
    judge.reviewScan = async (options, control) => {
      await new Promise((resolve) =>
        control.signal.addEventListener('abort', resolve, { once: true })
      );
      return result({ stopped: true });
    };
    const realIdle = jobs.idleStopSeconds;
    jobs.idleStopSeconds = () => 1;
    try {
      const job = jobs.start({ kind: 'tags' });
      const unsubscribe = jobs.subscribe(job.id, () => {});
      job.watchedMs = Date.now() - 5000;
      jobs._checkIdle();
      assert.strictEqual(
        job.status,
        'running',
        'a subscriber counts as watching'
      );

      unsubscribe();
      job.watchedMs = Date.now() - 5000;
      jobs.touch(job.id);
      jobs._checkIdle();
      assert.strictEqual(job.status, 'running', 'a touch counts as watching');

      job.watchedMs = Date.now() - 5000;
      jobs._checkIdle();
      assert.strictEqual(job.status, 'stopping');
      const final = await jobs.wait(job.id);
      assert.strictEqual(final.job.stopReason, 'idle');

      jobs.reset();
      jobs.idleStopSeconds = () => 0;
      const forever = jobs.start({ kind: 'tags' });
      forever.watchedMs = Date.now() - 999999;
      jobs._checkIdle();
      assert.strictEqual(forever.status, 'running', '0 means never');
      jobs.stop(forever.id);
      await jobs.wait(forever.id);
    } finally {
      jobs.idleStopSeconds = realIdle;
    }
  });

  await test('a subscriber of a finished job gets the final event at once', async () => {
    judge.reviewScan = async () => result({ tokens: 42 });
    const job = jobs.start({ kind: 'tags' });
    await jobs.wait(job.id);
    let got = null;
    const unsubscribe = jobs.subscribe(job.id, (event) => {
      got = event;
    });
    assert.strictEqual(got.type, 'done');
    assert.strictEqual(got.data.aiReview.tokens, 42);
    assert.strictEqual(typeof unsubscribe, 'function');
    assert.strictEqual(await jobs.wait('nope'), null);
    assert.strictEqual(typeof jobs.subscribe('nope', () => {}), 'function');
    jobs.reset();
    assert.strictEqual(jobs.current(), null);
  });

  await test('the budget and the idle seconds come from the settings', async () => {
    const config = require(path.join(REPO_ROOT, 'config', 'config'));
    assert.strictEqual(jobs.tokenBudget(), 5000);
    assert.strictEqual(jobs.idleStopSeconds(), 60);
    const budget = config.duplicatesAiTokenBudget;
    const idle = config.duplicatesAiIdleStopSeconds;
    try {
      config.duplicatesAiTokenBudget = 0;
      config.duplicatesAiIdleStopSeconds = 0;
      assert.strictEqual(jobs.tokenBudget(), null, '0 is no ceiling');
      assert.strictEqual(jobs.idleStopSeconds(), 0, '0 is never');
      config.duplicatesAiTokenBudget = NaN;
      config.duplicatesAiIdleStopSeconds = -3;
      assert.strictEqual(jobs.tokenBudget(), null);
      assert.strictEqual(jobs.idleStopSeconds(), 0);
      judge.reviewScan = async (options, control) => {
        assert.strictEqual(control.tokenBudget, null);
        return result();
      };
      const job = jobs.start({});
      const final = await jobs.wait(job.id);
      assert.strictEqual(final.job.progress.tokenBudget, null);
    } finally {
      config.duplicatesAiTokenBudget = budget;
      config.duplicatesAiIdleStopSeconds = idle;
    }
  });

  console.log = quiet;
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.log = quiet;
  console.error(error);
  process.exit(1);
});
