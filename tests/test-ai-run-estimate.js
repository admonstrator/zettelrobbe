/**
 * Test: ai-run-estimate
 *
 * services/aiRunEstimate.js answers the one question both review pages ask
 * before they spend anything: how many requests, how many tokens, how long.
 * It is pure arithmetic over numbers the caller gathered, so it is testable
 * without a database, a provider or Paperless-ngx — and worth testing,
 * because a page that promises "about six minutes" and then runs fourteen
 * teaches people to stop reading the estimate.
 *
 * Covers:
 *  1. requests follow from items and batch size, and the last request counts
 *  2. a finished run beats a model measurement beats the constants, and
 *     `basis` says which one answered
 *  3. a run of one request is not averaged over
 *  4. lanes divide the seconds, never the tokens
 *  5. the thinking surcharge is per request and only when thinking is on
 *  6. nonsense in (zero items, no batch size) leaves the shape intact
 */

const assert = require('assert');
const {
  estimateRun,
  perRequest,
  GUESS_TOKENS_PER_SECOND,
  MIN_REQUESTS_FOR_AVERAGE,
} = require('../services/aiRunEstimate');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

test('The number of requests counts the last, shorter one', () => {
  assert.strictEqual(estimateRun({ items: 1145, batchSize: 50 }).requests, 23);
  assert.strictEqual(estimateRun({ items: 100, batchSize: 50 }).requests, 2);
  assert.strictEqual(estimateRun({ items: 1, batchSize: 50 }).requests, 1);
  assert.strictEqual(estimateRun({ items: 0, batchSize: 50 }).requests, 0);
});

test('Without a measurement it says so, and still answers', () => {
  const guess = estimateRun({ items: 200, batchSize: 50 });
  assert.strictEqual(guess.basis, 'guess');
  assert.strictEqual(guess.measuredAt, null);
  assert.ok(guess.tokens.total > 0, 'a guess is still a number');
  assert.strictEqual(
    guess.tokens.total,
    guess.tokens.prompt + guess.tokens.completion + guess.tokens.thinking,
    'the parts have to add up to the total'
  );
  assert.strictEqual(guess.tokens.thinking, 0, 'no thinking was asked for');
});

test("The model's own measurement is used before the constants", () => {
  const measured = estimateRun({
    items: 100,
    batchSize: 50,
    calibration: {
      tokensPerPair: 40,
      tokensPerSecond: 20,
      thinkingPerRequest: 1000,
      measuredAt: '2026-09-20 10:00:00',
    },
    thinking: true,
  });
  assert.strictEqual(measured.basis, 'model');
  assert.strictEqual(measured.measuredAt, '2026-09-20 10:00:00');
  // 40 per item × 50 items × 2 requests
  assert.strictEqual(measured.tokens.completion, 4000);
  // the surcharge is per request, not per item
  assert.strictEqual(measured.tokens.thinking, 2000);
  // (2000 answer + 1000 thinking) / 20 per second = 150 s per request
  assert.strictEqual(measured.seconds, 300);
});

test('A finished run of the task beats the model measurement', () => {
  const lastRun = {
    requests: 10,
    items: 500,
    promptTokens: 20000,
    completionTokens: 30000,
    thinkingTokens: 50000,
    seconds: 300,
    finishedAt: '2026-09-21 14:09:00',
  };
  const estimate = estimateRun({
    items: 100,
    batchSize: 50,
    lastRun,
    calibration: { tokensPerPair: 40, tokensPerSecond: 20 },
    thinking: true,
  });
  assert.strictEqual(estimate.basis, 'run');
  assert.strictEqual(estimate.measuredAt, '2026-09-21 14:09:00');
  // 2000 prompt per request × 2
  assert.strictEqual(estimate.tokens.prompt, 4000);
  // the model measurement still sizes the answer: it is per item, and the
  // run's average is per request of a possibly different size
  assert.strictEqual(estimate.tokens.completion, 4000);
  // 5000 thinking per request × 2, from the run
  assert.strictEqual(estimate.tokens.thinking, 10000);
  // 30 s per request from the run, not from tokens per second
  assert.strictEqual(estimate.seconds, 60);
});

test('A run of one request is a warm-up, not a measurement', () => {
  assert.strictEqual(MIN_REQUESTS_FOR_AVERAGE, 2);
  assert.strictEqual(perRequest({ requests: 1, promptTokens: 9000 }), null);
  const estimate = estimateRun({
    items: 100,
    batchSize: 50,
    lastRun: { requests: 1, promptTokens: 9000, seconds: 90 },
  });
  assert.strictEqual(estimate.basis, 'guess');
});

test('Lanes shorten the run without making it cheaper', () => {
  const one = estimateRun({ items: 300, batchSize: 50, lanes: 1 });
  const three = estimateRun({ items: 300, batchSize: 50, lanes: 3 });
  assert.strictEqual(one.tokens.total, three.tokens.total);
  assert.strictEqual(three.seconds, Math.round(one.seconds / 3));
  assert.strictEqual(three.lanes, 3);
});

test('Without thinking there is no surcharge, with it there is', () => {
  const options = {
    items: 100,
    batchSize: 50,
    calibration: { thinkingPerRequest: 1200, tokensPerPair: 10 },
  };
  assert.strictEqual(estimateRun(options).tokens.thinking, 0);
  assert.strictEqual(
    estimateRun({ ...options, thinking: true }).tokens.thinking,
    2400
  );
});

test('Nothing in, a whole shape out', () => {
  const empty = estimateRun();
  assert.strictEqual(empty.items, 0);
  assert.strictEqual(empty.requests, 0);
  assert.strictEqual(empty.batchSize, 1);
  assert.strictEqual(empty.lanes, 1);
  assert.strictEqual(empty.tokens.total, 0);
  assert.strictEqual(empty.seconds, 0);
  assert.strictEqual(empty.basis, 'guess');
  assert.ok(
    GUESS_TOKENS_PER_SECOND > 0,
    'the fallback speed has to be a speed'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
