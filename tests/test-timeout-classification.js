/**
 * What counts as a timeout, and how each analysis path reports one.
 *
 * isTimeoutError() decides whether an error is replaced by "AI response
 * timeout reached…" (scan loop, OCR queue, every provider's analysis). A
 * dropped connection ("socket hang up", ECONNRESET) used to count as one:
 * the operator then read "check your timeout settings" for a provider that
 * had closed the connection, and the original message was gone. A dropped
 * connection keeps its own message now; Ollama already retries it once.
 *
 * Covers:
 * 1. isTimeoutError() over codes and messages, dropped connections excluded
 * 2. Ollama normalises a timeout like the OpenAI-compatible providers (7e)
 * 3. Both keep the message of a dropped connection (7m)
 *
 * The plan: docs/llm-service-refactoring.md, Finding 7 rows e and m.
 */

'use strict';

const assert = require('assert');

process.env.AI_PROVIDER = 'ollama';
process.env.OLLAMA_API_URL = 'http://ollama.test';
process.env.OLLAMA_MODEL = 'test-model';
process.env.OPENAI_API_KEY = 'sk-test';
process.env.OPENAI_MODEL = 'gpt-4o-mini';
process.env.SYSTEM_PROMPT = 'Analyse the document.';
process.env.CUSTOM_FIELDS = JSON.stringify({ custom_fields: [] });
delete process.env.CONTENT_MAX_LENGTH;

const {
  isTimeoutError,
  buildTimeoutErrorMessage,
} = require('../services/serviceUtils');
const ollamaService = require('../services/ollamaService');
const openaiService = require('../services/openaiService');

const DOCUMENT_ID = 372;
const TIMEOUT_MESSAGE = buildTimeoutErrorMessage('AI');

let passed = 0;
let failed = 0;

/* The services log every step; only the verdicts are printed. */
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
  if (failure) {
    console.error(`❌  ${name}`);
    console.error(`    ${failure.message}`);
    failed++;
  } else {
    console.log(`✅  ${name}`);
    passed++;
  }
}

const withCode = (message, code) => Object.assign(new Error(message), { code });

/** An Ollama whose every request fails with `error`. */
function ollamaFailingWith(error) {
  ollamaService.client = {
    post: async () => {
      throw error;
    },
  };
}

/** An OpenAI whose every request fails with `error`. */
function openaiFailingWith(error) {
  openaiService.client = {
    chat: {
      completions: {
        create: async () => {
          throw error;
        },
      },
    },
  };
}

const analyze = (service) =>
  service.analyzeDocument('Rechnung', [], [], [], DOCUMENT_ID);

(async () => {
  const originalSetTimeout = global.setTimeout;
  const clients = {
    ollama: ollamaService.client,
    openai: openaiService.client,
  };
  // Ollama retries a dropped connection after a second; not here.
  global.setTimeout = (fn) => originalSetTimeout(fn, 1);

  try {
    /* --- 1. the classifier ----------------------------------------------- */

    for (const [label, input, expected] of [
      ['ETIMEDOUT', withCode('connect ETIMEDOUT', 'ETIMEDOUT'), true],
      ['ECONNABORTED', withCode('aborted', 'ECONNABORTED'), true],
      [
        'an AbortSignal timeout',
        withCode('The operation was aborted', 'ABORT_ERR'),
        true,
      ],
      ["axios' timeout message", 'timeout of 1800000ms exceeded', true],
      ['"timed out"', 'Request timed out.', true],
      ['"deadline exceeded"', 'context deadline exceeded', true],
      ['"socket hang up"', 'socket hang up', false],
      ['ECONNRESET', withCode('read ECONNRESET', 'ECONNRESET'), false],
      [
        'a dropped connection with a timeout-free message',
        withCode('socket hang up', 'ECONNRESET'),
        false,
      ],
      [
        'a refused connection',
        withCode('connect ECONNREFUSED', 'ECONNREFUSED'),
        false,
      ],
      ['an unrelated error', 'Invalid JSON response from API', false],
    ]) {
      await test(`isTimeoutError: ${label} is ${expected ? '' : 'not '}a timeout`, () => {
        assert.strictEqual(isTimeoutError(input), expected);
      });
    }

    /* --- 2. a timeout is reported the same way on both paths ------------- */

    await test('Ollama reports a timeout with the normalised message', async () => {
      ollamaFailingWith(
        withCode('timeout of 1800000ms exceeded', 'ECONNABORTED')
      );
      const analysis = await analyze(ollamaService);
      assert.strictEqual(analysis.error, TIMEOUT_MESSAGE);
      assert.strictEqual(analysis.errorCode, 'ECONNABORTED');
    });

    await test('OpenAI reports a timeout with the normalised message', async () => {
      openaiFailingWith(withCode('Request timed out.', 'ETIMEDOUT'));
      const analysis = await analyze(openaiService);
      assert.strictEqual(analysis.error, TIMEOUT_MESSAGE);
    });

    /* --- 3. a dropped connection keeps its message ----------------------- */

    await test('Ollama keeps the message of a dropped connection', async () => {
      ollamaFailingWith(withCode('socket hang up', 'ECONNRESET'));
      const analysis = await analyze(ollamaService);
      assert.match(analysis.error, /socket hang up/);
      assert.notStrictEqual(analysis.error, TIMEOUT_MESSAGE);
    });

    await test('OpenAI keeps the message of a dropped connection', async () => {
      openaiFailingWith(withCode('socket hang up', 'ECONNRESET'));
      const analysis = await analyze(openaiService);
      assert.strictEqual(analysis.error, 'socket hang up');
    });
  } finally {
    global.setTimeout = originalSetTimeout;
    ollamaService.client = clients.ollama;
    openaiService.client = clients.openai;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
