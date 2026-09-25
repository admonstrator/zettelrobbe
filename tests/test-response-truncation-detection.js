/**
 * Truncation detection on the OpenAI-compatible providers (issue #263).
 *
 * Ollama reports a generation it had to cut short as done_reason "length";
 * OpenAI, Azure and the custom endpoint call the same event finish_reason
 * "length". Neither was read anywhere in the codebase, so a cut-off answer
 * surfaced as "Invalid JSON response from API" a few lines later — and sent
 * the document to the OCR queue, which re-reads the PDF and re-runs the same
 * request against the same limit.
 */

const assert = require('assert');

process.env.AI_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'gpt-4';
process.env.SYSTEM_PROMPT = 'Analyse the document.';

const { assertCompletionNotTruncated } = require('../services/serviceUtils');

let failed = 0;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${label}: ${error.message}`);
  }
};

const COMPLETE_ANSWER = JSON.stringify({
  title: 'Telekom invoice July',
  correspondent: 'Telekom Deutschland GmbH',
  tags: ['invoice'],
  document_type: 'Rechnung',
  document_date: '2026-09-03',
  language: 'de',
});

function completion(finishReason, content = COMPLETE_ANSWER) {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 900, completion_tokens: 1000, total_tokens: 1900 },
  };
}

(async () => {
  console.log('\n=== Response truncation detection ===');

  /* --- the shared guard ------------------------------------------------- */

  await check('finish_reason "length" is rejected with a code', () => {
    assert.throws(
      () =>
        assertCompletionNotTruncated(completion('length'), 'OpenAI', 'Do X.'),
      (error) => {
        assert.strictEqual(error.code, 'ai_response_truncated');
        assert.match(error.message, /OpenAI/);
        assert.match(error.message, /1000 tokens/);
        assert.match(error.message, /Do X\./);
        return true;
      }
    );
  });

  await check('a natural stop passes through untouched', () => {
    assert.doesNotThrow(() =>
      assertCompletionNotTruncated(completion('stop'), 'OpenAI', 'Do X.')
    );
    // Providers that report nothing at all must not be treated as truncated.
    assert.doesNotThrow(() =>
      assertCompletionNotTruncated({ choices: [{}] }, 'OpenAI', 'Do X.')
    );
    assert.doesNotThrow(() =>
      assertCompletionNotTruncated(undefined, 'OpenAI', 'Do X.')
    );
  });

  await check('the message survives a provider that omits usage', () => {
    assert.throws(
      () =>
        assertCompletionNotTruncated(
          { choices: [{ finish_reason: 'length' }] },
          'Custom OpenAI',
          'Do X.'
        ),
      /Custom OpenAI stopped generating because/
    );
  });

  /* --- each provider actually consults it -------------------------------- */

  await check('every OpenAI-compatible analysis path calls the guard', () => {
    // Read from source rather than driven through a stub: the analysis path
    // caches a thumbnail first, which would drag Paperless-ngx into the test.
    const fs = require('fs');
    for (const name of ['openaiService', 'azureService', 'customService']) {
      const source = fs.readFileSync(`services/${name}.js`, 'utf8');
      assert.ok(
        source.includes('assertCompletionNotTruncated('),
        `${name}: the analysis path no longer consults the truncation guard`
      );
    }
  });

  await check('every analysis catch block carries the code onward', () => {
    // The scan loop reads analysis.errorCode; a service that throws the right
    // error but drops the code on the way out records a generic failure.
    const fs = require('fs');
    for (const name of [
      'openaiService',
      'azureService',
      'customService',
      'ollamaService',
    ]) {
      const source = fs.readFileSync(`services/${name}.js`, 'utf8');
      const guards = (source.match(/errorCode: error\.code/g) || []).length;
      const catches = (
        source.match(
          /document: \{ tags: \[\], correspondent: null \},\n\s*metrics: null,/g
        ) || []
      ).length;
      assert.strictEqual(
        guards,
        catches,
        `${name}: ${catches} analysis catch block(s) but ${guards} carry errorCode`
      );
    }
  });

  if (failed > 0) {
    console.error(`\n${failed} truncation detection case(s) failed`);
    process.exit(1);
  }
  console.log('\nAll truncation detection cases passed');
})();
