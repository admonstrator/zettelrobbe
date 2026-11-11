/**
 * Ollama's analysis answers the scan loop the way the OpenAI-compatible
 * providers do (openaiCompatibleService).
 *
 * Ollama keeps its own analysis path, so three outcomes drifted from the
 * other providers, each silent: the analysis "succeeded" or failed with a
 * message the OCR fallback does not know, and the document never reached
 * the OCR queue.
 *
 * Covers:
 * 1. A model that declines the document reports insufficient content (7c)
 * 2. An answer without a tag list or with an unusable correspondent is a
 *    failure, on the text and on the structured-output path (7k); an
 *    answer that found nothing is still a success, as on the other providers
 * 3. An empty payload fails with a message the OCR fallback recognises (7l)
 * 4. The sanitize path keeps every document field
 * 5. The answer is read like the other providers read it (7d): a <think>
 *    block or prose with braces around the JSON no longer breaks it, and
 *    Ollama's repair of unquoted keys stays as the fallback
 *
 * The plan: docs/llm-service-refactoring.md, Finding 7.
 */

'use strict';

const assert = require('assert');

process.env.AI_PROVIDER = 'ollama';
process.env.OLLAMA_API_URL = 'http://ollama.test';
process.env.OLLAMA_MODEL = 'test-model';
process.env.SYSTEM_PROMPT = 'Analyse the document.';
process.env.CUSTOM_FIELDS = JSON.stringify({ custom_fields: [] });
delete process.env.CONTENT_MAX_LENGTH;

const ollamaService = require('../services/ollamaService');
const {
  shouldQueueForOcrOnAiError,
  classifyOcrQueueReasonFromAiError,
} = require('../services/serviceUtils');

const DOCUMENT_ID = 371;

let passed = 0;
let failed = 0;

/* The service logs every step; only the verdicts are printed. */
async function test(name, fn) {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  console.log = console.warn = console.error = console.debug = () => {};
  let failure = null;
  try {
    await fn();
  } catch (error) {
    failure = error;
  } finally {
    Object.assign(console, original);
  }
  try {
    if (failure) throw failure;
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

/** An Ollama whose /api/generate answers with `data`. */
function answering(data) {
  ollamaService.client = { post: async () => ({ data }) };
}

/** A finished generation whose answer is `response` (text or object). */
function generation(response) {
  return {
    done_reason: 'stop',
    response,
    eval_count: 20,
    prompt_eval_count: 30,
  };
}

function analyze() {
  return ollamaService.analyzeDocument('Rechnung', [], [], [], DOCUMENT_ID);
}

/** The failure the scan loop sends to OCR, with the reason it records. */
function assertQueuedForOcr(analysis, reason) {
  assert.ok(analysis.error, 'the analysis reports an error');
  assert.ok(
    shouldQueueForOcrOnAiError(analysis.error),
    `"${analysis.error}" must reach the OCR fallback`
  );
  assert.strictEqual(classifyOcrQueueReasonFromAiError(analysis.error), reason);
}

(async () => {
  const originalClient = ollamaService.client;
  try {
    /* --- 7c: a refusal is insufficient content -------------------------- */

    await test('A refusal reports insufficient content, with its metrics', async () => {
      answering(generation("I'm sorry, I cannot analyse this document."));
      const analysis = await analyze();
      assert.strictEqual(
        analysis.error,
        'Insufficient content for AI analysis'
      );
      assertQueuedForOcr(analysis, 'ai_insufficient_content');
      assert.deepStrictEqual(analysis.metrics, {
        promptTokens: 30,
        completionTokens: 20,
        totalTokens: 50,
      });
      assert.strictEqual(analysis.truncated, false);
      assert.deepStrictEqual(analysis.document.tags, []);
      assert.strictEqual(analysis.document.correspondent, 'Unknown');
      assert.strictEqual(analysis.document.title, `Document ${DOCUMENT_ID}`);
    });

    await test('Prose that is no refusal stays an unreadable answer', async () => {
      answering(generation('Here is what I found: a phone bill.'));
      const analysis = await analyze();
      assert.match(analysis.error, /^Invalid JSON response from API/);
      assertQueuedForOcr(analysis, 'ai_invalid_json');
    });

    /* --- 7k: no tag list, no usable correspondent ----------------------- */

    for (const [label, response] of [
      [
        'text answer without tags',
        JSON.stringify({ title: 'T', correspondent: 'X' }),
      ],
      [
        'text answer with an object as correspondent',
        JSON.stringify({ tags: ['a'], correspondent: { name: 'X' } }),
      ],
      ['structured answer without tags', { title: 'T', correspondent: 'X' }],
      [
        'structured answer with tags as a string',
        { tags: 'invoice', correspondent: 'X' },
      ],
    ]) {
      await test(`A ${label} is a failure the OCR fallback takes`, async () => {
        answering(generation(response));
        const analysis = await analyze();
        assert.match(analysis.error, /could not determine assignable metadata/);
        assertQueuedForOcr(analysis, 'ai_invalid_response_structure');
        assert.strictEqual(analysis.metrics, null);
      });
    }

    await test('An answer that found nothing is still a success', async () => {
      answering(generation(JSON.stringify({ tags: [], correspondent: null })));
      const analysis = await analyze();
      assert.strictEqual(analysis.error, undefined);
      assert.deepStrictEqual(analysis.document.tags, []);
      assert.strictEqual(analysis.document.correspondent, null);
    });

    /* --- 7l: an empty payload ------------------------------------------- */

    await test('A response without data reaches the OCR fallback', async () => {
      answering(null);
      const analysis = await analyze();
      assertQueuedForOcr(analysis, 'ai_invalid_api_response_structure');
    });

    await test('A generation without an answer reaches the OCR fallback', async () => {
      answering({
        done_reason: 'stop',
        eval_count: 20,
        prompt_eval_count: 30,
      });
      const analysis = await analyze();
      assertQueuedForOcr(analysis, 'ai_invalid_api_response_structure');
    });

    /* --- 7d: read like the other providers, repaired like before -------- */

    for (const [label, response] of [
      [
        'a <think> block with braces before the JSON',
        '<think>The total {5 EUR} looks right.</think>' +
          '{"tags": ["a"], "correspondent": "X"}',
      ],
      [
        'prose with braces after the JSON',
        '{"tags": ["a"], "correspondent": "X"}\nNote: the {amount} is net.',
      ],
      ['a code fence', '```json\n{"tags": ["a"], "correspondent": "X"}\n```'],
      [
        'unquoted keys (the repair fallback)',
        '{tags: ["a"], correspondent: "X"}',
      ],
    ]) {
      await test(`An answer with ${label} is read`, async () => {
        answering(generation(response));
        const analysis = await analyze();
        assert.strictEqual(analysis.error, undefined);
        assert.deepStrictEqual(analysis.document.tags, ['a']);
        assert.strictEqual(analysis.document.correspondent, 'X');
      });
    }

    /* --- the sanitize path keeps every field ---------------------------- */

    await test('An answer repaired by sanitizing keeps type and custom fields', async () => {
      answering(
        generation(
          '{"tags": ["a"], "correspondent": "X", "document_type": "Rechnung",' +
            ' "custom_fields": {"0": {"field_name": "Amount", "value": "5"}},}'
        )
      );
      const analysis = await analyze();
      assert.strictEqual(analysis.error, undefined);
      assert.strictEqual(analysis.document.document_type, 'Rechnung');
      assert.deepStrictEqual(analysis.document.custom_fields, {
        0: { field_name: 'Amount', value: '5' },
      });
    });
  } finally {
    ollamaService.client = originalClient;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
