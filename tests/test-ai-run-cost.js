/**
 * Test: ai-run-cost
 *
 * What a model-backed run cost, written down and read back: the `ai_run_stats`
 * table of migration v15, and the request log the run meter shows while a job
 * is still going.
 *
 * Both exist for the same reason. A page that wants to say "this will cost
 * about six minutes" has to have watched a run that did, and a page that wants
 * to explain why a run is slow has to show the request that thought for 25,000
 * tokens and answered nothing. One number for a whole run hides exactly that.
 *
 * Covers:
 *  1. migration v15 creates the table and its index
 *  2. a saved run reads back in the shape the services use
 *  3. a stopped run is kept, and the newest run of a task wins
 *  4. a model narrows the lookup; a task without runs answers null
 *  5. only the newest runs per task are kept
 *  6. recordRequest puts the newest first, caps the log and keeps the shape
 *  7. a stopped run, a failed run and an apply: two rows and no third
 *  8. the four outcomes reach the request log, newest first, and add up
 *  9. GET /api/simplify/order/estimate reuses the rule pass and the levers
 * 10. GET /api/duplicates/ai-review/estimate says needsScan until one is
 *     cached, and answers from the cached scan after that
 * 11. both estimates refuse with 503, naming which of the two reasons it is
 * 12. a real order run over a fake Paperless-ngx and a fake provider writes
 *     down what it cost
 */

const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-run-cost-'));
  process.chdir(tempRoot);
  // Before anything loads config/config.js, which snapshots the environment
  // once: the router harness and the provider services below both read it.
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    JWT_SECRET: 'test-jwt-secret-for-run-cost',
    API_KEY: 'test-api-key',
    PAPERLESS_API_URL: 'http://127.0.0.1:9/api',
    PAPERLESS_API_TOKEN: 'test-paperless-token',
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'test-openai-key',
    OPENAI_MODEL: 'fake-model',
    DUPLICATES_AI_REVIEW: 'yes',
    DUPLICATES_AI_CONCURRENCY: '3',
    SIMPLIFY_TAGS_PER_REQUEST: '2',
    DISABLE_AUTOMATIC_PROCESSING: 'yes',
    OCR_AUTO_PROCESS_ENABLED: 'no',
    RECONCILIATION_ENABLED: 'no',
    CONFIG_SOURCE_MODE: 'runtime-first',
  });
  const documentModel = require('../models/document');
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(tempRoot, 'data', 'documents.db'), {
    readonly: true,
  });

  await test('Migration v15 creates ai_run_stats and its index', () => {
    const version = raw.pragma('user_version', { simple: true });
    assert.ok(version >= 15, `user_version is ${version}`);
    const columns = raw
      .prepare('PRAGMA table_info(ai_run_stats)')
      .all()
      .map((column) => column.name);
    for (const column of [
      'task',
      'model',
      'thinking',
      'status',
      'items',
      'items_by_rule',
      'requests',
      'failed_requests',
      'prompt_tokens',
      'completion_tokens',
      'thinking_tokens',
      'seconds',
      'finished_at',
    ]) {
      assert.ok(columns.includes(column), `ai_run_stats.${column} missing`);
    }
    const indexes = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);
    assert.ok(
      indexes.includes('idx_ai_run_stats_task'),
      'the lookup by task has no index'
    );
  });

  await test('A saved run reads back the way the services use it', async () => {
    await documentModel.saveAiRunStats({
      task: 'order',
      model: 'qwen3:30b',
      thinking: true,
      status: 'done',
      items: 1145,
      itemsByRule: 42,
      requests: 23,
      failedRequests: 1,
      promptTokens: 46000,
      completionTokens: 296000,
      thinkingTokens: 748000,
      seconds: 372.4,
    });
    const run = await documentModel.getLastAiRunStats('order');
    assert.ok(run, 'nothing came back');
    assert.strictEqual(run.task, 'order');
    assert.strictEqual(run.model, 'qwen3:30b');
    assert.strictEqual(run.thinking, true, 'thinking comes back as a boolean');
    assert.strictEqual(run.items, 1145);
    assert.strictEqual(run.itemsByRule, 42);
    assert.strictEqual(run.requests, 23);
    assert.strictEqual(run.failedRequests, 1);
    assert.strictEqual(run.promptTokens, 46000);
    assert.strictEqual(run.thinkingTokens, 748000);
    assert.ok(Math.abs(run.seconds - 372.4) < 0.01);
    assert.ok(run.finishedAt, 'a run without a time is not a measurement');
  });

  await test('A stopped run counts too, and the newest one wins', async () => {
    await documentModel.saveAiRunStats({
      task: 'order',
      model: 'qwen3:30b',
      status: 'stopped',
      items: 300,
      requests: 6,
      completionTokens: 60000,
      seconds: 90,
    });
    const run = await documentModel.getLastAiRunStats('order');
    assert.strictEqual(run.status, 'stopped');
    assert.strictEqual(run.requests, 6);
    const list = await documentModel.listAiRunStats('order', 5);
    assert.strictEqual(list.length, 2, 'both runs are kept');
    assert.strictEqual(list[0].status, 'stopped', 'newest first');
  });

  await test('A model narrows it, an unknown task answers null', async () => {
    await documentModel.saveAiRunStats({
      task: 'order',
      model: 'other-model',
      requests: 4,
      completionTokens: 1000,
    });
    const other = await documentModel.getLastAiRunStats('order', 'qwen3:30b');
    assert.strictEqual(
      other.model,
      'qwen3:30b',
      'the newest run of THAT model, not the newest run'
    );
    assert.strictEqual(await documentModel.getLastAiRunStats('review'), null);
    assert.strictEqual(await documentModel.getLastAiRunStats(''), null);
    assert.strictEqual(await documentModel.saveAiRunStats({ task: '' }), false);
  });

  await test('Only the newest runs of a task are kept', async () => {
    for (let index = 0; index < 55; index += 1) {
      await documentModel.saveAiRunStats({
        task: 'review',
        requests: index + 2,
        completionTokens: 100,
      });
    }
    const kept = raw
      .prepare(
        "SELECT COUNT(*) AS count FROM ai_run_stats WHERE task = 'review'"
      )
      .get().count;
    assert.strictEqual(kept, 50, `${kept} rows kept instead of 50`);
    const newest = await documentModel.getLastAiRunStats('review');
    assert.strictEqual(newest.requests, 56, 'the newest run survived');
    const orders = raw
      .prepare(
        "SELECT COUNT(*) AS count FROM ai_run_stats WHERE task = 'order'"
      )
      .get().count;
    assert.strictEqual(orders, 3, 'pruning one task never touches another');
  });

  await test('The request log keeps the newest and caps its length', () => {
    const jobs = require('../services/duplicateReviewJobService');
    const progress = { requestLog: [] };
    jobs.recordRequest(progress, {
      index: 1,
      items: 50,
      answers: 50,
      tokens: 61000,
      thinkingTokens: 38000,
      ms: 44000,
      outcome: 'answered',
    });
    jobs.recordRequest(progress, {
      index: 2,
      items: 50,
      answers: 0,
      tokens: 25000,
      thinkingTokens: 25000,
      ms: 112000,
      outcome: 'empty',
    });
    assert.strictEqual(progress.requestLog.length, 2);
    assert.strictEqual(progress.requestLog[0].index, 2, 'newest first');
    assert.strictEqual(progress.requestLog[0].outcome, 'empty');
    assert.strictEqual(progress.requestLog[1].tokens, 61000);

    // An outcome nobody defined is not carried into the page.
    jobs.recordRequest(progress, { index: 3, outcome: 'exploded' });
    assert.strictEqual(progress.requestLog[0].outcome, 'answered');
    assert.strictEqual(progress.requestLog[0].tokens, null);
    // What a request was about rides along, so the page can word its row;
    // a kind nobody defined is dropped rather than shown.
    assert.strictEqual(progress.requestLog[0].kind, null);
    jobs.recordRequest(progress, { index: 4, kind: 'names', items: 300 });
    assert.strictEqual(progress.requestLog[0].kind, 'names');
    jobs.recordRequest(progress, { index: 5, kind: 'sonnets', items: 1 });
    assert.strictEqual(progress.requestLog[0].kind, null);
    assert.ok(
      jobs.REQUEST_KINDS.has('pairs') && jobs.REQUEST_KINDS.has('tags')
    );
    assert.strictEqual(
      jobs.freshProgress(1).tally,
      null,
      'a fresh progress has no tally until the model answered'
    );

    for (let index = 4; index < 20; index += 1) {
      jobs.recordRequest(progress, { index, items: 50, outcome: 'answered' });
    }
    assert.strictEqual(
      progress.requestLog.length,
      jobs.REQUEST_LOG_LENGTH,
      'the log grew past its cap'
    );
    assert.strictEqual(progress.requestLog[0].index, 19);

    // A job that never had a log gets one rather than throwing.
    const fresh = {};
    jobs.recordRequest(fresh, { index: 1, outcome: 'answered' });
    assert.strictEqual(fresh.requestLog.length, 1);
    assert.deepStrictEqual(jobs.recordRequest(null, {}), []);
  });

  // ── What a run writes down when it ends ────────────────────────────────
  // The cases above are the table; these are the only thing that ever puts a
  // row in it. Every ending counts, because a run that was stopped after six
  // of twenty-three requests measured six requests.

  const jobs = require('../services/duplicateReviewJobService');

  /** Waits for a promise the runner resolves, so no case races its own job. */
  const latch = () => {
    let open;
    const waited = new Promise((resolve) => {
      open = resolve;
    });
    return { waited, open };
  };

  await test('A stopped run writes its row, tokens and all', async () => {
    jobs.reset();
    const recorded = latch();
    const release = latch();
    const job = jobs.start({ task: 'vocabulary' }, async (options, control) => {
      control.noteRun({
        items: 40,
        itemsByRule: 5,
        model: 'run-model',
        thinking: true,
      });
      control.recordRequest({
        items: 20,
        answers: 20,
        tokens: 900,
        thinkingTokens: 300,
        promptTokens: 100,
        ms: 12,
        outcome: 'answered',
      });
      recorded.open();
      await release.waited;
      throw new Error('stopped while the answer was on its way');
    });
    await recorded.waited;
    jobs.stop(job.id);
    release.open();
    await jobs.wait(job.id);

    assert.strictEqual(job.status, 'stopped');
    assert.strictEqual(job.progress.promptTokens, 100);
    assert.strictEqual(job.progress.completionTokens, 900);
    assert.strictEqual(job.progress.requestLog.length, 1);

    const run = await documentModel.getLastAiRunStats('vocabulary');
    assert.ok(run, 'a stopped run wrote no row');
    assert.strictEqual(run.status, 'stopped');
    assert.strictEqual(run.items, 40);
    assert.strictEqual(run.itemsByRule, 5);
    assert.strictEqual(run.requests, 1);
    assert.strictEqual(run.promptTokens, 100);
    assert.strictEqual(run.completionTokens, 900);
    assert.strictEqual(run.thinkingTokens, 300);
    assert.strictEqual(run.model, 'run-model');
    assert.strictEqual(run.thinking, true);
  });

  await test('A failed run is a measurement; an apply is not a run', async () => {
    jobs.reset();
    const failing = jobs.start({ task: 'splits' }, async (options, control) => {
      control.noteRun({ items: 12, model: 'run-model' });
      control.recordRequest({
        items: 12,
        answers: 0,
        promptTokens: 10,
        tokens: 40,
        ms: 3,
        outcome: 'failed',
      });
      throw new Error('the provider could not be reached');
    });
    await jobs.wait(failing.id);
    const run = await documentModel.getLastAiRunStats('splits');
    assert.strictEqual(run.status, 'failed');
    assert.strictEqual(run.requests, 1);
    assert.strictEqual(run.failedRequests, 1);
    assert.strictEqual(run.promptTokens, 10);
    // Never reported, so never invented.
    assert.strictEqual(run.thinkingTokens, null);

    jobs.reset();
    const applying = jobs.start({ task: 'apply' }, async () => ({ ok: true }));
    await jobs.wait(applying.id);
    assert.strictEqual(
      await documentModel.getLastAiRunStats('apply'),
      null,
      'applying writes tags, it never asks a model'
    );
  });

  await test('The four outcomes reach the log, newest first, and add up', async () => {
    jobs.reset();
    const job = jobs.start({ task: 'review' }, async (options, control) => {
      for (const outcome of ['answered', 'partial', 'empty', 'failed']) {
        control.recordRequest({
          items: 5,
          answers: outcome === 'answered' ? 5 : 0,
          promptTokens: 20,
          tokens: 100,
          thinkingTokens: 10,
          ms: 1,
          outcome,
        });
      }
      return {};
    });
    await jobs.wait(job.id);

    const log = job.progress.requestLog;
    assert.deepStrictEqual(
      log.map((row) => row.outcome),
      ['failed', 'empty', 'partial', 'answered']
    );
    assert.deepStrictEqual(
      log.map((row) => row.index),
      [4, 3, 2, 1],
      'a runner without a count of its own gets the run’s'
    );

    const run = await documentModel.getLastAiRunStats('review');
    assert.strictEqual(run.requests, 4);
    assert.strictEqual(run.failedRequests, 1);
    assert.strictEqual(run.promptTokens, 80);
    assert.strictEqual(run.completionTokens, 400);
    assert.strictEqual(run.thinkingTokens, 40);
    jobs.reset();
  });

  // ── The two estimates, over a fake Paperless-ngx ───────────────────────
  // Both are asked again on every move of a lever, so what is tested here is
  // as much what they do not do — no model request, no scan — as what they
  // answer.

  const { createFakePaperless } = require('./helpers/fake-paperless');
  const { createFakeOpenAI } = require('./helpers/fake-openai');
  const { mountRouter } = require('./helpers/mount-router');
  const OpenAI = require('openai');

  // Four tags the rule cannot settle (a name it cannot decompose, documents
  // to their name), one empty tag and the inbox tag, which it settles.
  const fakePaperless = createFakePaperless({
    tags: [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Bravo' },
      { id: 3, name: 'Charlie' },
      { id: 4, name: 'Delta' },
      { id: 5, name: 'Echo' },
      { id: 6, name: 'Posteingang', is_inbox_tag: true },
    ],
    documents: [
      { id: 101, tags: [1] },
      { id: 102, tags: [1] },
      { id: 103, tags: [1] },
      { id: 104, tags: [1, 2] },
      { id: 105, tags: [1, 2] },
      { id: 106, tags: [2] },
      { id: 107, tags: [2] },
      { id: 108, tags: [3] },
      { id: 109, tags: [3] },
      { id: 110, tags: [4] },
    ],
  });
  const fakeOpenAI = await createFakeOpenAI();

  const harness = await mountRouter({
    // The harness has a default model of its own, and the judge reads
    // OPENAI_MODEL off the environment at call time rather than off the
    // config snapshot.
    env: { OPENAI_MODEL: 'fake-model' },
    stub: (services) => {
      // The harness stubs the entity reads to "nothing there"; deleting its
      // own property uncovers the real method again, which then reads the
      // fake through the client below.
      delete services.paperlessService.listEntities;
      services.paperlessService.client = fakePaperless.client;
    },
  });
  const ask = (path) =>
    fetch(`${harness.base}${path}`, {
      headers: { 'x-api-key': 'test-api-key' },
    });
  const askJson = async (path) => {
    const response = await ask(path);
    return { status: response.status, body: await response.json() };
  };

  const config = require('../config/config');
  const tagSimplifyService = require('../services/tagSimplifyService');
  const duplicateMergeService = require('../services/duplicateMergeService');

  try {
    await tagSimplifyService.saveVocabulary({
      types: ['Rechnung'],
      topics: ['Strom'],
    });

    await test('The order estimate reuses the rule pass, and the levers bite', async () => {
      tagSimplifyService.forgetEstimateTags();
      const plain = await askJson('/api/simplify/order/estimate');
      assert.strictEqual(plain.status, 200);
      const data = plain.body.data;
      assert.strictEqual(data.tags, 6, 'every tag of the archive');
      assert.strictEqual(
        data.itemsByRule,
        2,
        'the empty tag and the inbox tag never reach the model'
      );
      assert.strictEqual(data.items, 4);
      assert.strictEqual(data.batchSize, 2, 'SIMPLIFY_TAGS_PER_REQUEST');
      assert.strictEqual(data.requests, 2);
      assert.strictEqual(data.lanes, 3, 'DUPLICATES_AI_CONCURRENCY');
      assert.strictEqual(data.model, 'fake-model');
      assert.strictEqual(
        data.tokens.total,
        data.tokens.prompt + data.tokens.completion + data.tokens.thinking
      );
      // Nothing of this model has ever been measured here.
      assert.strictEqual(data.basis, 'guess');
      assert.strictEqual(data.lastRun, null);
      // Charlie has two documents and Delta one; the default floor is three.
      assert.strictEqual(data.skippable.lowDocument, 2);
      assert.strictEqual(data.skippable.decided, 0);
      assert.ok(
        data.extra.vocabularyRequests > 0,
        'proposing a vocabulary is a pass of its own'
      );

      const kept = await askJson(
        '/api/simplify/order/estimate?keepVocabulary=1'
      );
      assert.strictEqual(kept.body.data.extra.vocabularyRequests, 0);

      const floored = await askJson(
        '/api/simplify/order/estimate?minDocuments=5'
      );
      assert.strictEqual(floored.body.data.items, 1, 'only Alpha is left');
      assert.strictEqual(floored.body.data.skippable.lowDocument, 3);
      assert.strictEqual(floored.body.data.requests, 1);

      // A decision on one of the four takes it out of the model pass.
      await documentModel.replaceTagSplitProposals([
        { tagId: 2, tagName: 'Bravo', action: 'keep', status: 'accepted' },
        { tagId: 3, tagName: 'Charlie', action: 'keep', status: 'open' },
      ]);
      const decided = await askJson(
        '/api/simplify/order/estimate?skipDecided=1'
      );
      assert.strictEqual(decided.body.data.skippable.decided, 1);
      assert.strictEqual(decided.body.data.items, 3);
      // The lever is a lever: without it nothing is left out.
      const undecided = await askJson('/api/simplify/order/estimate');
      assert.strictEqual(undecided.body.data.items, 4);
      assert.strictEqual(undecided.body.data.skippable.decided, 1);
      await documentModel.replaceTagSplitProposals([]);
    });

    await test('The review estimate scans for nothing, and says so', async () => {
      duplicateMergeService.invalidateScanCache();
      const before = await askJson(
        '/api/duplicates/ai-review/estimate?kind=tags'
      );
      assert.strictEqual(before.status, 200);
      assert.strictEqual(before.body.data.needsScan, true);
      assert.strictEqual(before.body.data.items, 0);
      assert.strictEqual(before.body.data.groups, 0);
      assert.strictEqual(before.body.data.basis, 'guess');
      assert.strictEqual(before.body.data.measuredAt, null);
      assert.deepStrictEqual(before.body.data.extra, {
        sweepRequests: 0,
        excerptReads: 0,
      });

      // Two spellings of one name, so the scan has a group to find and the
      // estimate has a pair to count.
      fakePaperless.state.tags.set(7, {
        id: 7,
        name: 'Kontoauszug',
        slug: 'kontoauszug',
        match: '',
        matching_algorithm: 0,
        is_insensitive: true,
        owner: null,
        user_can_change: true,
        is_inbox_tag: false,
        color: '#fff',
      });
      fakePaperless.state.tags.set(8, {
        id: 8,
        name: 'Kontoauszüge',
        slug: 'kontoauszuege',
        match: '',
        matching_algorithm: 0,
        is_insensitive: true,
        owner: null,
        user_can_change: true,
        is_inbox_tag: false,
        color: '#fff',
      });

      const scan = await duplicateMergeService.scan({
        kind: 'tags',
        threshold: 0.8,
        fresh: true,
      });
      assert.ok(scan.groups.length > 0, 'the fake archive has no duplicates');

      const after = await askJson(
        '/api/duplicates/ai-review/estimate?kind=tags&threshold=0.8'
      );
      assert.strictEqual(after.body.data.needsScan, false);
      assert.strictEqual(after.body.data.groups, scan.groups.length);
      assert.strictEqual(
        after.body.data.pairs,
        after.body.data.items + after.body.data.itemsByRule,
        'every pair of the groups is asked about or settled by a rule'
      );
      assert.ok(after.body.data.lanes >= 1);

      // A sweep is requests on top of the judging pass, and it is counted
      // apart from them.
      const swept = await askJson(
        '/api/duplicates/ai-review/estimate?kind=tags&threshold=0.8&sweep=1'
      );
      assert.ok(
        swept.body.data.extra.sweepRequests > 0,
        'a sweep over eight names costs at least one request'
      );
      assert.strictEqual(
        swept.body.data.requests,
        after.body.data.requests,
        'the sweep is extra, not part of the judging pass'
      );

      // Nothing here ever asked the model.
      assert.strictEqual(fakeOpenAI.requests.length, 0);
    });

    await test('Both estimates refuse politely, naming the reason', async () => {
      const review = config.duplicatesAiReview;
      const provider = config.aiProvider;
      try {
        config.duplicatesAiReview = 'no';
        const off = await askJson('/api/duplicates/ai-review/estimate');
        assert.strictEqual(off.status, 503);
        assert.strictEqual(off.body.success, false);
        assert.match(off.body.error, /DUPLICATES_AI_REVIEW/);
        // The Simplify page has no such switch, so it still answers.
        assert.strictEqual(
          (await ask('/api/simplify/order/estimate')).status,
          200
        );

        config.duplicatesAiReview = review;
        config.aiProvider = '';
        for (const path of [
          '/api/duplicates/ai-review/estimate',
          '/api/simplify/order/estimate',
        ]) {
          const answer = await askJson(path);
          assert.strictEqual(answer.status, 503, path);
          assert.match(answer.body.error, /No AI provider is configured/, path);
        }
      } finally {
        config.duplicatesAiReview = review;
        config.aiProvider = provider;
      }
    });

    await test('A real order run writes down what it cost', async () => {
      const openaiService = require('../services/openaiService');
      openaiService.client = new OpenAI({
        apiKey: 'test',
        baseURL: fakeOpenAI.baseURL,
        maxRetries: 0,
        timeout: 15000,
      });
      // Two tags per request (SIMPLIFY_TAGS_PER_REQUEST), and the fake
      // answers every request with the same well-formed pair of verdicts;
      // ids the request did not carry are dropped by the service, so what
      // comes back per request is what that request asked about.
      fakeOpenAI.reset();
      fakeOpenAI.setScript({
        chunks: [
          {
            content: JSON.stringify([
              { id: '1', action: 'keep', reason: 'as it is' },
              { id: '2', action: 'keep', reason: 'as it is' },
              { id: '3', action: 'keep', reason: 'as it is' },
              { id: '4', action: 'keep', reason: 'as it is' },
              { id: '7', action: 'keep', reason: 'as it is' },
              { id: '8', action: 'keep', reason: 'as it is' },
            ]),
          },
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 60,
          total_tokens: 180,
        },
      });

      jobs.reset();
      tagSimplifyService.forgetEstimateTags();
      const job = jobs.start(
        { task: 'order', vocabulary: 'keep' },
        (options, control) =>
          tagSimplifyService.proposeOrder({ vocabulary: 'keep' }, control)
      );
      const event = await jobs.wait(job.id);
      assert.strictEqual(
        event.type,
        'done',
        `the order run ended as ${job.status}: ${job.error || ''}`
      );

      const asked = fakeOpenAI.requests.length;
      assert.ok(asked > 0, 'the run never asked the model');
      assert.strictEqual(job.progress.requestLog.length, asked);
      for (const row of job.progress.requestLog) {
        assert.strictEqual(row.outcome, 'answered', JSON.stringify(row));
        assert.strictEqual(row.tokens, 60, 'the provider reported 60');
      }
      assert.strictEqual(job.progress.promptTokens, 120 * asked);
      assert.strictEqual(job.progress.completionTokens, 60 * asked);

      const run = await documentModel.getLastAiRunStats('order', 'fake-model');
      assert.ok(run, 'the order run wrote no row');
      assert.strictEqual(run.status, 'done');
      assert.strictEqual(run.requests, asked);
      assert.strictEqual(run.failedRequests, 0);
      assert.strictEqual(run.promptTokens, 120 * asked);
      assert.strictEqual(run.completionTokens, 60 * asked);
      // No provider reported reasoning, so nothing was written down for it.
      assert.strictEqual(run.thinkingTokens, null);
      assert.ok(run.items > 0, 'the run asked about nothing');

      // And now the estimate has a run of this very task to stand on.
      tagSimplifyService.forgetEstimateTags();
      const after = await askJson('/api/simplify/order/estimate');
      assert.strictEqual(after.body.data.basis, 'run');
      assert.ok(after.body.data.lastRun, 'the estimate forgot the run');
      assert.strictEqual(after.body.data.lastRun.status, 'done');
    });
  } finally {
    jobs.reset();
    await harness.close();
    await fakeOpenAI.close();
  }

  await test('A token nobody reported stays null, and is not a measured zero', async () => {
    await documentModel.saveAiRunStats({
      task: 'vocabulary',
      model: 'silent-model',
      requests: 3,
      promptTokens: null,
      completionTokens: 1200,
      thinkingTokens: null,
      seconds: 12,
    });
    const run = await documentModel.getLastAiRunStats('vocabulary');
    assert.strictEqual(
      run.promptTokens,
      null,
      'a provider that reports no prompt tokens must not look like a free one'
    );
    assert.strictEqual(run.thinkingTokens, null);
    assert.strictEqual(
      run.completionTokens,
      1200,
      'what was reported survives'
    );

    const jobs = require('../services/duplicateReviewJobService');
    const progress = { requestLog: [] };
    jobs.recordRequest(progress, {
      index: 1,
      items: 50,
      tokens: null,
      thinkingTokens: null,
      outcome: 'answered',
    });
    assert.strictEqual(progress.requestLog[0].tokens, null);
    assert.strictEqual(progress.requestLog[0].thinkingTokens, null);
    // Zero is still zero when somebody did report it.
    jobs.recordRequest(progress, { index: 2, tokens: 0, outcome: 'empty' });
    assert.strictEqual(progress.requestLog[0].tokens, 0);
  });

  await test('The run meter reads a running total of the reasoning', () => {
    const jobs = require('../services/duplicateReviewJobService');
    const service = Object.create(Object.getPrototypeOf(jobs));
    const job = {
      progress: { requestLog: [], promptTokens: null, completionTokens: null },
      subscribers: new Set(),
    };
    service._emit = () => {};
    service._noteRequest(job, {
      index: 1,
      items: 50,
      promptTokens: 2000,
      tokens: 12000,
      thinkingTokens: 7000,
      outcome: 'answered',
    });
    service._noteRequest(job, {
      index: 2,
      items: 50,
      promptTokens: 2000,
      tokens: 13000,
      thinkingTokens: 8000,
      outcome: 'answered',
    });
    assert.strictEqual(job.progress.promptTokens, 4000);
    assert.strictEqual(job.progress.completionTokens, 25000);
    assert.strictEqual(
      job.progress.thinkingTotal,
      15000,
      'the page draws its bar from this; per-request would collapse it'
    );
    // The per-request field keeps its own meaning: the request being answered.
    assert.notStrictEqual(
      job.progress.thinkingTotal,
      job.progress.thinkingTokens
    );
  });

  raw.close();
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
