/**
 * Test: AI review service contract
 *
 * Contract placeholder from the round-3 contract commit. It pins the
 * vocabulary and the helpers the route and the page build against; the
 * backend agent replaces this file with the full suite (prompt, batching,
 * parsing, validation of returned names, titles as context) and keeps these
 * cases green.
 */

'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

process.env.DUPLICATES_AI_REVIEW = 'yes';
process.env.AI_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'test';
const service = require('../services/entityMatchAiService');

test('The contract exports exist', () => {
  assert.deepStrictEqual(service.AI_VERDICT_LIST, [
    'same',
    'different',
    'unsure',
  ]);
  assert.deepStrictEqual(service.GROUP_SOURCES, {
    SCAN: 'scan',
    AI_CANDIDATE: 'ai-candidate',
  });
  assert.strictEqual(typeof service.reviewPairs, 'function');
  assert.strictEqual(typeof service.reviewScan, 'function');
  assert.strictEqual(typeof service.isEnabled, 'function');
});

test('The setting and the provider decide whether the review is offered', () => {
  assert.strictEqual(service.isEnabled(), true);
  assert.strictEqual(service.batchSize(), 25);
  assert.strictEqual(service.candidateFloor(), 0.6);
});

test('aggregateVerdict: any different wins, all same is same, else unsure', () => {
  const same = { verdict: 'same', reason: 'same company' };
  const different = { verdict: 'different', reason: 'other bank' };
  const unsure = { verdict: 'unsure', reason: 'not enough context' };
  assert.deepStrictEqual(service.aggregateVerdict([same, same]), same);
  assert.deepStrictEqual(
    service.aggregateVerdict([same, different]),
    different
  );
  assert.deepStrictEqual(service.aggregateVerdict([same, unsure]), unsure);
  assert.deepStrictEqual(service.aggregateVerdict([]), {
    verdict: 'unsure',
    reason: '',
  });
  assert.deepStrictEqual(service.aggregateVerdict([null, same]), same);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
