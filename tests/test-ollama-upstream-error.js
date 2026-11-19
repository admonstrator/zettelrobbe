/**
 * Surface the upstream cause of Ollama 5xx responses and retry once.
 *
 * Field report: Ollama answered HTTP 500 { error: 'Post
 * "http://127.0.0.1:49496/v1/completions": EOF' } — its own inference
 * backend closed the connection on a large document. analyzeDocument only
 * reported "Request failed with status code 500", hiding both the fact that
 * the failure was upstream of Ollama and any hint about which limit bit.
 *
 * Covers:
 * 1. The upstream error body reaches analysis.error / the log
 * 2. A transient 5xx is retried once; a success on the second attempt wins
 * 3. A persistent 5xx fails with the upstream detail preserved
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

const UPSTREAM_ERROR = 'Post "http://127.0.0.1:49496/v1/completions": EOF';

/** An Ollama that answers like the field report: 500 carrying its backend error. */
function ollamWithResponses(responses) {
  const attempts = [];
  return {
    attempts,
    post: async () => {
      const response = responses.shift();
      attempts.push(response);
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function successResponse() {
  return {
    data: {
      done_reason: 'stop',
      response: JSON.stringify({
        title: 'T',
        correspondent: null,
        tags: ['a'],
        document_type: 'd',
        document_date: '2026-01-01',
        language: 'de',
      }),
      eval_count: 20,
      prompt_eval_count: 30,
    },
  };
}

function serverError(body) {
  const error = new Error(`Request failed with status code 500`);
  error.code = 'ERR_BAD_RESPONSE';
  error.response = { status: 500, data: body };
  return error;
}

(async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClient = ollamaService.client;

  try {
    // Shorten retries in tests
    const originalSetTimeout = setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 1);

    await test('The upstream error body reaches analysis.error', async () => {
      ollamaService.client = ollamWithResponses([
        serverError({ error: UPSTREAM_ERROR }),
        serverError({ error: UPSTREAM_ERROR }),
      ]);

      const analysis = await ollamaService.analyzeDocument(
        'short content',
        [],
        [],
        [],
        370
      );

      assert.match(
        analysis.error,
        /v1\/completions.*EOF/s,
        'the operator must see WHICH backend call failed'
      );
      assert.strictEqual(
        analysis.errorCode,
        'ERR_BAD_RESPONSE',
        'the axios code stays available for classification'
      );
    });

    await test('A transient 5xx is retried once', async () => {
      const ollama = ollamWithResponses([
        serverError({ error: UPSTREAM_ERROR }),
        successResponse(),
      ]);
      ollamaService.client = ollama;

      const analysis = await ollamaService.analyzeDocument(
        'short content',
        [],
        [],
        [],
        371
      );

      assert.strictEqual(
        ollama.attempts.length,
        2,
        'exactly one retry after the failed attempt'
      );
      assert.strictEqual(
        analysis.error,
        undefined,
        'the retry succeeded and the answer is used'
      );
      assert.deepStrictEqual(analysis.document.tags, ['a']);
    });

    await test('A persistent 5xx fails with the upstream detail kept', async () => {
      const ollama = ollamWithResponses([
        serverError({ error: UPSTREAM_ERROR }),
        serverError({ error: UPSTREAM_ERROR }),
      ]);
      ollamaService.client = ollama;

      const analysis = await ollamaService.analyzeDocument(
        'short content',
        [],
        [],
        [],
        372
      );

      assert.strictEqual(ollama.attempts.length, 2, 'one retry, then give up');
      assert.match(analysis.error, /v1\/completions.*EOF/s);
      assert.strictEqual(analysis.errorCode, 'ERR_BAD_RESPONSE');
    });

    await test('Client errors (4xx) are not retried', async () => {
      const notFound = new Error('Request failed with status code 404');
      notFound.code = 'ERR_BAD_REQUEST';
      notFound.response = { status: 404, data: { error: 'model not found' } };
      const ollama = ollamWithResponses([notFound]);
      ollamaService.client = ollama;

      const analysis = await ollamaService.analyzeDocument(
        'short content',
        [],
        [],
        [],
        373
      );

      assert.strictEqual(
        ollama.attempts.length,
        1,
        'a 404 will never succeed on retry'
      );
      assert.match(analysis.error, /model not found/);
    });
  } finally {
    global.setTimeout = originalSetTimeout;
    ollamaService.client = originalClient;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
