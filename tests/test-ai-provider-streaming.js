'use strict';

/**
 * The four provider services stream what the model writes.
 *
 * The evidence this exists for: a hosted Qwen model spent 103 seconds and the
 * whole 3200-token cap on one request, then threw "the answer hit a token
 * limit" and dropped everything it had produced. Nobody saw a word of it while
 * it ran, and nothing of it survived the throw.
 *
 * So: a caller that hands in an onProgress handler gets the answer streamed,
 * reported as it grows, with the model's thinking marked as thinking and kept
 * out of the text — and a request that is cut off or stopped throws an error
 * that carries the text that did arrive.
 *
 * The providers talk to real HTTP servers here (tests/helpers/fake-openai.js
 * and tests/helpers/fake-ollama.js) because the parts worth testing are the
 * parts a stub cannot have: server-sent events off a socket, NDJSON lines
 * split across reads, and a connection that closes when the caller stops
 * caring.
 *
 * Cases:
 *   1. a streamed answer is the same answer as a plain one, all four providers
 *   2. no handler, no stream: the body is what it always was
 *   3. a handler makes OpenAI and the custom provider ask for the usage chunk
 *   4. Azure asks for it only where the API version takes it
 *   5. the handler sees the answer grow and hears done exactly once, last
 *   6. a <think> block in the content toggles thinking and stays out of the text
 *   7. reasoning_content deltas toggle thinking and stay out of the text
 *   8. Ollama's thinking field is thinking, not answer
 *   9. at most one report per hundred milliseconds, plus the final one
 *  10. the usage chunk decides the token count
 *  11. without one the count is an estimate, and says so
 *  12. a streamed answer that hits the limit throws with what it managed
 *  13. a plain answer that hits the limit carries its prefix too
 *  14. an unclosed <think> at the cut is stripped from the partial text
 *  15. Ollama reports the limit the way the others do, streamed and plain
 *  16. an abort mid-stream is an AbortError, and the server sees it
 *  17. Ollama stops reading the moment the signal aborts
 *  18. an abort without a handler is an AbortError too
 *  19. reasoning: false sends the switch each API understands
 *  20. reasoning: true switches thinking on, without the soft switch
 *  21. reasoning: null leaves every body as it was
 *  22. the Qwen soft switch is only for a Qwen model
 */

const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const OpenAI = require('openai');

const { createFakeOpenAI } = require('./helpers/fake-openai');
const { createFakeOllama } = require('./helpers/fake-ollama');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed += 1;
  }
}

/**
 * Runs a body with the provider services' error logging swallowed. Half of
 * these cases are failures on purpose, and their stack traces would bury the
 * results.
 */
async function quiet(fn) {
  const real = {
    error: console.error,
    warn: console.warn,
    debug: console.debug,
  };
  console.error = () => {};
  console.warn = () => {};
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.error = real.error;
    console.warn = real.warn;
    console.debug = real.debug;
  }
}

/** Collects every progress update a call reports. */
function recorder() {
  const updates = [];
  return {
    updates,
    onProgress: (update) => updates.push(update),
    last: () => updates[updates.length - 1],
  };
}

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-ai-stream-'));
  process.chdir(tempRoot);

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://127.0.0.1:9';
  process.env.PAPERLESS_API_TOKEN = 'test-token';
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'test';
  process.env.OPENAI_MODEL = 'fake-model';
  process.env.AZURE_DEPLOYMENT_NAME = 'fake-deployment';

  const config = require('../config/config');
  const openaiService = require('../services/openaiService');
  const customService = require('../services/customService');
  const azureService = require('../services/azureService');
  const ollamaService = require('../services/ollamaService');
  const { PROGRESS_THROTTLE_MS } = require('../services/aiGenerateOptions');

  const fakeOpenAI = await createFakeOpenAI();
  const fakeOllama = await createFakeOllama();

  /** An SDK client pointed at the fake; no retries, so a failure is one call. */
  const sdkClient = () =>
    new OpenAI({
      apiKey: 'test',
      baseURL: fakeOpenAI.baseURL,
      maxRetries: 0,
      timeout: 15000,
    });

  openaiService.client = sdkClient();
  customService.client = sdkClient();
  azureService.client = sdkClient();
  ollamaService.apiUrl = fakeOllama.url;
  ollamaService.model = 'fake-ollama-model';

  const defaults = {
    customModel: config.custom.model,
    azureApiVersion: config.azure.apiVersion,
    ollamaThink: config.ollama.think,
  };
  config.custom.model = 'qwen3-32b-instruct';
  config.azure.apiVersion = '2023-05-15';

  /** The three services that speak to an OpenAI-compatible endpoint. */
  const sdkServices = {
    openai: openaiService,
    custom: customService,
    azure: azureService,
  };

  /** Points both fakes at a fresh script and forgets the old requests. */
  function useScript(openaiScript, ollamaScript) {
    fakeOpenAI.reset();
    fakeOpenAI.setScript(openaiScript || {});
    fakeOllama.reset();
    fakeOllama.setScript(ollamaScript || {});
  }

  try {
    // ------------------------------------------------------------- the answer

    await test('A streamed answer is the same answer as a plain one, in all four providers', async () => {
      const openaiScript = {
        chunks: [
          { content: 'Yes, ' },
          { content: '<think>weighing the names</think>' },
          { content: 'the same entity' },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
      };
      const ollamaScript = {
        chunks: [
          { response: 'Yes, ' },
          { response: '<think>weighing the names</think>' },
          { response: 'the same entity' },
        ],
        evalCount: 12,
        promptEvalCount: 40,
      };
      useScript(openaiScript, ollamaScript);

      for (const [name, service] of Object.entries(sdkServices)) {
        const plain = await service.generateText('judge this');
        const streamed = await service.generateText('judge this', {
          onProgress: () => {},
        });
        assert.strictEqual(plain, 'Yes, the same entity', `${name}: plain`);
        assert.strictEqual(
          streamed,
          plain,
          `${name}: the stream assembles the same answer`
        );
      }

      const plainOllama = await ollamaService.generateText('judge this');
      const streamedOllama = await ollamaService.generateText('judge this', {
        onProgress: () => {},
      });
      assert.strictEqual(plainOllama, 'Yes, the same entity');
      assert.strictEqual(streamedOllama, plainOllama);
    });

    await test('Without a progress handler nothing streams', async () => {
      useScript(
        { chunks: [{ content: 'ok' }] },
        { chunks: [{ response: 'ok' }] }
      );

      for (const [name, service] of Object.entries(sdkServices)) {
        fakeOpenAI.reset();
        await service.generateText('hello');
        const body = fakeOpenAI.last().body;
        assert.strictEqual(
          'stream' in body,
          false,
          `${name}: no stream key at all`
        );
        assert.strictEqual('stream_options' in body, false, name);
      }

      fakeOllama.reset();
      await ollamaService.generateText('hello');
      assert.strictEqual(
        fakeOllama.last().body.stream,
        false,
        'Ollama sent the stream: false it always sent'
      );
    });

    await test('A handler makes OpenAI and the custom provider ask for the usage chunk', async () => {
      useScript({ chunks: [{ content: 'ok' }] });
      for (const name of ['openai', 'custom']) {
        fakeOpenAI.reset();
        await sdkServices[name].generateText('hello', {
          onProgress: () => {},
        });
        const body = fakeOpenAI.last().body;
        assert.strictEqual(body.stream, true, name);
        assert.deepStrictEqual(
          body.stream_options,
          { include_usage: true },
          `${name}: include_usage buys the exact count`
        );
      }
    });

    await test('Azure asks for the usage chunk only where the API version takes it', async () => {
      useScript({ chunks: [{ content: 'ok' }] });

      config.azure.apiVersion = '2023-05-15';
      fakeOpenAI.reset();
      await azureService.generateText('hello', { onProgress: () => {} });
      assert.strictEqual(fakeOpenAI.last().body.stream, true);
      assert.strictEqual(
        'stream_options' in fakeOpenAI.last().body,
        false,
        'an old API version would answer 400 instead of streaming'
      );

      config.azure.apiVersion = '2024-10-21';
      fakeOpenAI.reset();
      await azureService.generateText('hello', { onProgress: () => {} });
      assert.deepStrictEqual(fakeOpenAI.last().body.stream_options, {
        include_usage: true,
      });
      config.azure.apiVersion = '2023-05-15';
    });

    // ------------------------------------------------------------- reporting

    await test('The handler sees the answer grow and hears done exactly once, last', async () => {
      useScript({
        chunks: [
          { content: 'Rechnung', delayMs: 130 },
          { content: ' und', delayMs: 130 },
          { content: ' Rechnungen', delayMs: 130 },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
      });
      const seen = recorder();

      const answer = await openaiService.generateText('hello', {
        onProgress: seen.onProgress,
      });

      assert.strictEqual(answer, 'Rechnung und Rechnungen');
      assert.ok(
        seen.updates.length >= 3,
        `expected several reports, got ${seen.updates.length}`
      );
      assert.strictEqual(
        seen.updates.filter((update) => update.done).length,
        1,
        'done fires exactly once'
      );
      assert.strictEqual(seen.last().done, true, 'and it is the last one');
      assert.strictEqual(seen.last().text, answer);

      for (let index = 1; index < seen.updates.length; index += 1) {
        assert.ok(
          seen.updates[index].text.startsWith(seen.updates[index - 1].text),
          `report ${index} grew out of the one before it`
        );
      }
      for (const update of seen.updates) {
        assert.strictEqual(
          typeof update.completionTokens,
          'number',
          'never null once the first delta arrived'
        );
      }
    });

    await test('A think block in the content toggles thinking and stays out of the text', async () => {
      useScript({
        chunks: [
          { content: 'Answer: ', delayMs: 130 },
          { content: '<think>the names differ only in case', delayMs: 130 },
          { content: ' so they are one</think>', delayMs: 130 },
          { content: 'same', delayMs: 130 },
        ],
      });
      const seen = recorder();

      const answer = await openaiService.generateText('hello', {
        onProgress: seen.onProgress,
      });

      assert.strictEqual(answer, 'Answer: same');
      assert.ok(
        seen.updates.some((update) => update.thinking),
        'thinking was reported while the block was open'
      );
      assert.strictEqual(
        seen.last().thinking,
        false,
        'and it was over by the time the answer was'
      );
      for (const update of seen.updates) {
        assert.ok(
          !update.text.includes('<think>') && !update.text.includes('names'),
          'no report ever carried the reasoning'
        );
      }
    });

    await test('reasoning_content deltas toggle thinking and stay out of the text', async () => {
      useScript({
        chunks: [
          { reasoning: 'both look like invoices', delayMs: 130 },
          { reasoning: ' so probably one', delayMs: 130 },
          { content: '[{"id":"tags:1-2"', delayMs: 130 },
          { content: ',"verdict":"same"}]', delayMs: 130 },
        ],
      });
      const seen = recorder();

      const answer = await customService.generateText('hello', {
        onProgress: seen.onProgress,
      });

      assert.strictEqual(answer, '[{"id":"tags:1-2","verdict":"same"}]');
      assert.strictEqual(
        seen.updates[0].thinking,
        true,
        'the first report was thinking, with no answer yet'
      );
      assert.strictEqual(seen.updates[0].text, '');
      assert.strictEqual(seen.last().thinking, false);
      for (const update of seen.updates) {
        assert.ok(
          !update.text.includes('invoices'),
          'the reasoning never reached the text'
        );
      }
    });

    await test("Ollama's thinking field is thinking, not answer", async () => {
      useScript(undefined, {
        chunks: [
          { thinking: 'the two spellings match', delayMs: 130 },
          { response: 'same', delayMs: 130, split: true },
          { response: ' entity', delayMs: 130 },
        ],
        evalCount: 8,
      });
      const seen = recorder();

      const answer = await ollamaService.generateText('hello', {
        onProgress: seen.onProgress,
      });

      assert.strictEqual(answer, 'same entity');
      assert.strictEqual(seen.updates[0].thinking, true);
      assert.strictEqual(seen.updates[0].text, '');
      assert.strictEqual(seen.last().thinking, false);
      assert.strictEqual(seen.last().text, 'same entity');
    });

    await test('At most one report per hundred milliseconds, plus the final one', async () => {
      const chunks = [];
      for (let index = 0; index < 24; index += 1) {
        chunks.push({ content: `${index} ` });
      }
      useScript({ chunks });
      const seen = recorder();

      await openaiService.generateText('hello', {
        onProgress: seen.onProgress,
      });

      const intermediate = seen.updates.filter((update) => !update.done);
      assert.ok(
        intermediate.length <= 3,
        `24 chunks in no time gave ${intermediate.length} reports, not one per ${PROGRESS_THROTTLE_MS}ms`
      );
      assert.strictEqual(seen.last().done, true);
    });

    // ---------------------------------------------------------------- tokens

    await test('The usage chunk decides the token count', async () => {
      useScript({
        chunks: [{ content: 'ok' }],
        usage: { prompt_tokens: 40, completion_tokens: 321, total_tokens: 361 },
      });
      const seen = recorder();

      await openaiService.generateText('hello', {
        onProgress: seen.onProgress,
      });

      assert.strictEqual(seen.last().completionTokens, 321);
      assert.deepStrictEqual(openaiService.lastGenerateTextUsage, {
        promptTokens: 40,
        completionTokens: 321,
        totalTokens: 361,
        reasoningTokens: null,
      });
    });

    await test('Without a usage chunk the count is an estimate, and says so', async () => {
      // Twelve characters of answer and twenty of reasoning: the estimate
      // counts what the budget was spent on, not only what came back.
      useScript({
        chunks: [
          { reasoning: 'twenty chars here!!!' },
          { content: 'twelve chars' },
        ],
        usage: null,
      });
      const seen = recorder();

      const answer = await customService.generateText('hello', {
        onProgress: seen.onProgress,
      });

      assert.strictEqual(answer, 'twelve chars');
      assert.strictEqual(seen.last().completionTokens, 8);
      assert.deepStrictEqual(customService.lastGenerateTextUsage, {
        promptTokens: null,
        completionTokens: 8,
        totalTokens: 8,
        estimated: true,
      });
    });

    // ------------------------------------------------------------- the cut-off

    await test('A streamed answer that hits the limit throws with what it managed', async () => {
      useScript({
        chunks: [
          { content: '[{"id":"tags:1-2","verdict":"same"},' },
          { content: '{"id":"tags:3-4","verdi' },
        ],
        finishReason: 'length',
        usage: { prompt_tokens: 3797, completion_tokens: 3200 },
      });
      const seen = recorder();

      await quiet(() =>
        assert.rejects(
          customService.generateText('hello', {
            onProgress: seen.onProgress,
          }),
          (error) => {
            assert.strictEqual(error.code, 'ai_response_truncated');
            assert.match(error.message, /hit a token limit/);
            assert.match(error.message, /after 3200 tokens/);
            assert.strictEqual(
              error.partialText,
              '[{"id":"tags:1-2","verdict":"same"},{"id":"tags:3-4","verdi'
            );
            return true;
          }
        )
      );

      assert.strictEqual(seen.last().done, true, 'done fired before the throw');
      assert.strictEqual(
        customService.lastGenerateTextUsage.completionTokens,
        3200,
        'and what it spent is still readable'
      );
    });

    await test('A plain answer that hits the limit carries its prefix too', async () => {
      useScript({
        chunks: [{ content: '<think>still weighing</think>half an ans' }],
        finishReason: 'length',
        usage: { prompt_tokens: 10, completion_tokens: 64 },
      });

      for (const [name, service] of Object.entries(sdkServices)) {
        fakeOpenAI.reset();
        await quiet(() =>
          assert.rejects(service.generateText('hello'), (error) => {
            assert.strictEqual(error.code, 'ai_response_truncated', name);
            assert.strictEqual(
              error.partialText,
              'half an ans',
              `${name}: the prefix without the reasoning`
            );
            return true;
          })
        );
      }
    });

    await test('An unclosed think block at the cut is stripped from the partial text', async () => {
      useScript({
        chunks: [
          { content: 'partial answer' },
          { content: '<think>and then it ran ou' },
        ],
        finishReason: 'length',
      });
      const seen = recorder();

      await quiet(() =>
        assert.rejects(
          openaiService.generateText('hello', {
            onProgress: seen.onProgress,
          }),
          (error) => {
            assert.strictEqual(error.partialText, 'partial answer');
            return true;
          }
        )
      );
      assert.strictEqual(seen.last().text, 'partial answer');
    });

    await test('Ollama reports the limit the way the others do, streamed and plain', async () => {
      useScript(undefined, {
        chunks: [{ response: 'half an ans' }],
        doneReason: 'length',
        evalCount: 12,
      });

      await quiet(() =>
        assert.rejects(
          ollamaService.generateText('hello', {
            maxTokens: 12,
            onProgress: () => {},
          }),
          (error) => {
            assert.strictEqual(error.code, 'ai_response_truncated');
            assert.strictEqual(error.partialText, 'half an ans');
            return true;
          }
        )
      );

      // An Ollama old enough not to send done_reason: the count reaching
      // num_predict is the signal, and the plain path reads it too.
      useScript(undefined, {
        chunks: [{ response: 'half an ans' }],
        doneReason: null,
        evalCount: 12,
      });
      await quiet(() =>
        assert.rejects(
          ollamaService.generateText('hello', { maxTokens: 12 }),
          (error) => {
            assert.strictEqual(error.code, 'ai_response_truncated');
            assert.strictEqual(error.partialText, 'half an ans');
            return true;
          }
        )
      );
    });

    // --------------------------------------------------------------- the stop

    await test('An abort mid-stream is an AbortError with what arrived, and the server sees it', async () => {
      useScript({
        chunks: [
          { content: 'first piece', delayMs: 40 },
          { content: ' second piece', delayMs: 300 },
          { content: ' third piece', delayMs: 300 },
        ],
      });
      const controller = new AbortController();
      const seen = recorder();

      await quiet(() =>
        assert.rejects(
          customService.generateText('hello', {
            signal: controller.signal,
            onProgress: (update) => {
              seen.onProgress(update);
              if (!update.done) controller.abort();
            },
          }),
          (error) => {
            assert.strictEqual(error.name, 'AbortError');
            assert.strictEqual(error.code, 'ai_request_aborted');
            assert.strictEqual(error.partialText, 'first piece');
            return true;
          }
        )
      );

      assert.strictEqual(seen.last().done, true, 'done fired before the throw');
      const request = await fakeOpenAI.last().whenClosed;
      assert.strictEqual(
        request.aborted,
        true,
        'the fake saw the connection go before it had finished writing'
      );
    });

    await test('Ollama stops reading the moment the signal aborts', async () => {
      useScript(undefined, {
        chunks: [
          { response: 'first piece', delayMs: 40 },
          { response: ' second piece', delayMs: 300 },
          { response: ' third piece', delayMs: 300 },
        ],
        evalCount: 9,
      });
      const controller = new AbortController();

      await quiet(() =>
        assert.rejects(
          ollamaService.generateText('hello', {
            signal: controller.signal,
            onProgress: (update) => {
              if (!update.done) controller.abort();
            },
          }),
          (error) => {
            assert.strictEqual(error.name, 'AbortError');
            assert.strictEqual(error.partialText, 'first piece');
            return true;
          }
        )
      );

      const request = await fakeOllama.last().whenClosed;
      assert.strictEqual(request.aborted, true);
    });

    await test('An abort without a handler is an AbortError too', async () => {
      useScript({ chunks: [{ content: 'never sent' }] });
      const controller = new AbortController();
      controller.abort();

      await quiet(() =>
        assert.rejects(
          openaiService.generateText('hello', { signal: controller.signal }),
          (error) => {
            assert.strictEqual(error.name, 'AbortError');
            assert.strictEqual(error.code, 'ai_request_aborted');
            assert.strictEqual(
              error.partialText,
              '',
              'nothing arrived, so nothing is kept'
            );
            return true;
          }
        )
      );
    });

    // ------------------------------------------------------------- the switch

    await test('reasoning: false sends the switch each API understands', async () => {
      useScript(
        { chunks: [{ content: 'ok' }] },
        { chunks: [{ response: 'ok' }] }
      );
      config.custom.model = 'qwen3-32b-instruct';
      config.ollama.think = true;

      fakeOpenAI.reset();
      await customService.generateText('judge this', { reasoning: false });
      const customBody = fakeOpenAI.last().body;
      assert.deepStrictEqual(customBody.chat_template_kwargs, {
        enable_thinking: false,
      });
      assert.strictEqual(
        customBody.messages[customBody.messages.length - 1].content,
        'judge this\n/no_think',
        'the soft switch is its own line at the end of the user message'
      );

      for (const name of ['openai', 'azure']) {
        fakeOpenAI.reset();
        await sdkServices[name].generateText('judge this', {
          reasoning: false,
        });
        const body = fakeOpenAI.last().body;
        assert.strictEqual(
          'chat_template_kwargs' in body,
          false,
          `${name}: that API has no such switch`
        );
        assert.strictEqual(
          body.messages[body.messages.length - 1].content,
          'judge this',
          `${name}: and no soft switch either`
        );
      }

      fakeOllama.reset();
      await ollamaService.generateText('judge this', { reasoning: false });
      assert.strictEqual(
        fakeOllama.last().body.think,
        false,
        'the caller overrules OLLAMA_THINK'
      );
    });

    await test('reasoning: true switches thinking on, without the soft switch', async () => {
      useScript(
        { chunks: [{ content: 'ok' }] },
        { chunks: [{ response: 'ok' }] }
      );
      config.custom.model = 'qwen3-32b-instruct';
      config.ollama.think = false;

      fakeOpenAI.reset();
      await customService.generateText('judge this', { reasoning: true });
      const body = fakeOpenAI.last().body;
      assert.deepStrictEqual(body.chat_template_kwargs, {
        enable_thinking: true,
      });
      assert.strictEqual(
        body.messages[body.messages.length - 1].content,
        'judge this',
        'nothing is appended when thinking is wanted'
      );

      fakeOllama.reset();
      await ollamaService.generateText('judge this', { reasoning: true });
      assert.strictEqual(fakeOllama.last().body.think, true);
    });

    await test('reasoning: null leaves every body as it was', async () => {
      useScript(
        { chunks: [{ content: 'ok' }] },
        { chunks: [{ response: 'ok' }] }
      );
      config.custom.model = 'qwen3-32b-instruct';

      fakeOpenAI.reset();
      await customService.generateText('judge this');
      const body = fakeOpenAI.last().body;
      assert.strictEqual('chat_template_kwargs' in body, false);
      assert.strictEqual(
        body.messages[body.messages.length - 1].content,
        'judge this'
      );

      config.ollama.think = true;
      fakeOllama.reset();
      await ollamaService.generateText('judge this');
      assert.strictEqual(
        'think' in fakeOllama.last().body,
        false,
        'OLLAMA_THINK=true still means the model thinks'
      );

      config.ollama.think = false;
      fakeOllama.reset();
      await ollamaService.generateText('judge this');
      assert.strictEqual(
        fakeOllama.last().body.think,
        false,
        'and OLLAMA_THINK unset still switches it off'
      );
    });

    await test('The Qwen soft switch is only for a Qwen model', async () => {
      useScript({ chunks: [{ content: 'ok' }] });
      config.custom.model = 'llama-3.3-70b-instruct';

      fakeOpenAI.reset();
      await customService.generateText('judge this', { reasoning: false });
      const body = fakeOpenAI.last().body;
      assert.deepStrictEqual(
        body.chat_template_kwargs,
        { enable_thinking: false },
        'the body key is for every OpenAI-compatible server'
      );
      assert.strictEqual(
        body.messages[body.messages.length - 1].content,
        'judge this',
        'the prompt line is a Qwen dialect, and stays out of other prompts'
      );
      config.custom.model = 'qwen3-32b-instruct';
    });
  } finally {
    config.custom.model = defaults.customModel;
    config.azure.apiVersion = defaults.azureApiVersion;
    config.ollama.think = defaults.ollamaThink;
    openaiService.client = null;
    customService.client = null;
    azureService.client = null;
    await fakeOpenAI.close();
    await fakeOllama.close();
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
