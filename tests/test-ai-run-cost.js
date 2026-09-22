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

  raw.close();
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
