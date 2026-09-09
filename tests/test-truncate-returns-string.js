/**
 * Test: truncateToTokenLimit() returns a string, and refuses a broken budget
 *
 * Two defects met in this one function:
 *
 * 1. tiktoken's decode() returns the raw UTF-8 bytes as a Uint8Array, not a
 *    string. A comment in the source claimed otherwise, so the bytes went
 *    straight into the chat message and were serialised as
 *    {"0":82,"1":101,...}. OpenAI and Azure answer that with
 *    "400 Invalid type for messages[1].content", so with a lowered TOKEN_LIMIT
 *    — normal for 8k/16k models — every document long enough to be truncated
 *    failed.
 *
 * 2. A non-finite budget produced an empty string instead of an error:
 *    `tokens.length <= NaN` is false, `tokens.slice(0, NaN)` is empty, and on
 *    the estimation path `text.substring(0, NaN)` is ''. The model then
 *    received no document text at all and invented its metadata.
 *
 * Covers:
 * 1. A truncated OpenAI-model text comes back as a real, shorter, non-empty
 *    string
 * 2. A cut multi-byte character leaves no trailing U+FFFD
 * 3. Text below the budget is returned unchanged (both paths)
 * 4. A non-OpenAI model name takes the character-estimate path and also
 *    returns a string
 * 5. An unusable maxTokens throws instead of silently emptying the document
 */

'use strict';

const assert = require('assert');

const {
  truncateToTokenLimit,
  calculateTokens,
} = require('../services/serviceUtils');

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

const OPENAI_MODEL = 'gpt-4o';
const NON_OPENAI_MODEL = 'llama3.1:8b';
const REPLACEMENT_CHARACTER = '�';

(async () => {
  await test('a truncated OpenAI text is a string, not a Uint8Array', async () => {
    const input = 'word '.repeat(5000);
    const result = await truncateToTokenLimit(input, 50, OPENAI_MODEL);

    assert.strictEqual(
      typeof result,
      'string',
      `Expected a string, got ${Object.prototype.toString.call(result)}`
    );
    assert.ok(result.length > 0, 'Truncated text must not be empty');
    assert.ok(
      result.length < input.length,
      'Truncated text must be shorter than the input'
    );
    assert.ok(
      !/^\{"0":/.test(JSON.stringify(result)),
      'Serialised result must not look like a byte map'
    );

    // The budget is what the provider was promised, so it has to hold.
    const resultTokens = await calculateTokens(result, OPENAI_MODEL);
    assert.ok(
      resultTokens <= 50,
      `Truncated text must fit the budget, used ${resultTokens} of 50 tokens`
    );
  });

  await test('a cut multi-byte character leaves no trailing U+FFFD', async () => {
    // Every one of these emoji is three tokens wide for gpt-4o, so a budget
    // that is not a multiple of three cuts one in half.
    const input = '🧾'.repeat(200);
    const result = await truncateToTokenLimit(input, 50, OPENAI_MODEL);

    assert.strictEqual(typeof result, 'string', 'Expected a string');
    assert.ok(
      !result.endsWith(REPLACEMENT_CHARACTER),
      'A half-decoded character must be stripped from the end'
    );
    assert.ok(result.length > 0, 'Truncated text must not be empty');
  });

  await test('text below the budget is returned unchanged', async () => {
    const short = 'A short invoice from the electricity supplier.';

    const openaiResult = await truncateToTokenLimit(short, 4000, OPENAI_MODEL);
    assert.strictEqual(
      openaiResult,
      short,
      'The tiktoken path must return the input untouched'
    );

    const estimateResult = await truncateToTokenLimit(
      short,
      4000,
      NON_OPENAI_MODEL
    );
    assert.strictEqual(
      estimateResult,
      short,
      'The estimation path must return the input untouched'
    );
  });

  await test('a non-OpenAI model takes the estimation path and returns a string', async () => {
    const input = 'word '.repeat(5000);
    const result = await truncateToTokenLimit(input, 50, NON_OPENAI_MODEL);

    assert.strictEqual(typeof result, 'string', 'Expected a string');
    assert.ok(result.length > 0, 'Truncated text must not be empty');
    assert.ok(
      result.length < input.length,
      'Truncated text must be shorter than the input'
    );
    // The estimation path budgets four characters per token.
    assert.ok(
      result.length <= 50 * 4,
      `Estimated truncation must respect the budget, got ${result.length} characters`
    );
  });

  await test('an unusable maxTokens throws instead of emptying the document', async () => {
    const input = 'word '.repeat(5000);
    const expected =
      'truncateToTokenLimit: maxTokens must be a positive finite number';

    for (const badBudget of [
      NaN,
      0,
      -1,
      Infinity,
      -Infinity,
      undefined,
      null,
      '4000',
    ]) {
      await assert.rejects(
        () => truncateToTokenLimit(input, badBudget, OPENAI_MODEL),
        (error) => {
          assert.strictEqual(
            error.message,
            expected,
            `Wrong error for budget ${String(badBudget)}: ${error.message}`
          );
          return true;
        },
        `Budget ${String(badBudget)} must be rejected`
      );

      // The estimation path used to answer '' for exactly the same input.
      await assert.rejects(
        () => truncateToTokenLimit(input, badBudget, NON_OPENAI_MODEL),
        (error) => error.message === expected,
        `Budget ${String(badBudget)} must be rejected on the estimation path too`
      );
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
