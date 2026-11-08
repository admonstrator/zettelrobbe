'use strict';

/**
 * services/modelFailure.js against the failures the code base really has.
 *
 * Cases:
 *  1. Every message the judge, the Simplify service, the job and the provider
 *     services throw or log for a failed request is classified, and each one
 *     is checked to still be in the source it comes from, so a reworded
 *     message fails here instead of silently falling to "unknown"
 *  2. Transport errors by code and status: real axios errors, real OpenAI and
 *     Anthropic SDK errors, and the tags the provider services put on them
 *  3. A tagged error wins over its message and its status; stop reasons;
 *     Paperless-ngx wins over a 502
 *  4. unusableAnswerKind(): thinking exactly when the request produced
 *     reasoning and no answer (or stopped at its cap with nothing written)
 *  5. requestFailure() and collapseFailures()
 *  6. Thinking detection end to end against fake-ollama and fake-openai:
 *     the services report the reasoning, the judge records `thinking`, and a
 *     model that wrote prose instead is `unreadable`
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const REPO_ROOT = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-model-failure-'));
fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
process.chdir(tmpDir);

const { createFakeOllama } = require('./helpers/fake-ollama');
const { createFakeOpenAI } = require('./helpers/fake-openai');
const { createFakeAnthropic } = require('./helpers/fake-anthropic');

let passed = 0;
let failed = 0;
const quiet = console.log;

async function test(name, fn) {
  try {
    await fn();
    quiet(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed += 1;
  }
}

/** A port nothing listens on: bound once, then closed again. */
async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const source = (file) =>
  fs.readFileSync(path.join(REPO_ROOT, 'services', file), 'utf8');

async function main() {
  const fakeOllama = await createFakeOllama();
  const fakeOpenAI = await createFakeOpenAI();
  const fakeAnthropic = await createFakeAnthropic({});
  const deadPort = await closedPort();

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    PAPERLESS_API_URL: 'http://127.0.0.1:9/api',
    PAPERLESS_API_TOKEN: 'test-token',
    AI_PROVIDER: 'ollama',
    OLLAMA_API_URL: fakeOllama.url,
    OLLAMA_MODEL: 'qwen3:8b',
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'fake-model',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    ANTHROPIC_API_URL: fakeAnthropic.url,
    DISABLE_AUTOMATIC_PROCESSING: 'yes',
    CONFIG_SOURCE_MODE: 'runtime-first',
  });

  const failure = require('../services/modelFailure');
  const { FAILURE_KINDS, classifyFailure } = failure;
  const axios = require('axios');
  const OpenAI = require('openai');
  const ollamaService = require('../services/ollamaService');
  const openaiService = require('../services/openaiService');
  const anthropicService = require('../services/anthropicService');
  const { createAnthropicClient } = require('../services/anthropicSupport');
  const judge = require('../services/entityMatchAiService');
  const matcher = require('../services/entityNameMatcher');
  const AIServiceFactory = require('../services/aiServiceFactory');

  // The provider services log every failure on the console; this test reads
  // the errors, not the log.
  const realError = console.error;
  const realDebug = console.debug;
  const realWarn = console.warn;
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = (...args) => {
    if (String(args[0]).startsWith('❌') || String(args[0]).startsWith('    '))
      realError(...args);
  };

  ollamaService.apiUrl = fakeOllama.url;
  ollamaService.model = 'qwen3:8b';

  try {
    await test('Every message the services throw is classified, and is still in its source', () => {
      // [message, kind, file it comes from (null: a provider SDK or Node)]
      const table = [
        // the answer parsers of the judge and the Simplify service
        ['the model answered nothing', 'unreadable', 'entityMatchAiService.js'],
        [
          'the answer contained no JSON array',
          'unreadable',
          'entityMatchAiService.js',
        ],
        [
          'the answer was not a JSON array',
          'unreadable',
          'entityMatchAiService.js',
        ],
        [
          'the answer contained no JSON object',
          'unreadable',
          'tagSimplifyService.js',
        ],
        [
          'the answer was not a JSON object',
          'unreadable',
          'tagSimplifyService.js',
        ],
        ['the answer could not be read', 'unreadable', 'tagSimplifyService.js'],
        [
          'The model proposed no vocabulary to order the tags by',
          'unreadable',
          'tagSimplifyService.js',
        ],
        ['Unexpected token I in JSON at position 0', 'unreadable', null],
        // the providers' empty answers
        ['Invalid response from Ollama API', 'unreadable', 'ollamaService.js'],
        [
          'Invalid API response structure: the answer carried no text',
          'unreadable',
          'openaiCompatibleService.js',
        ],
        // cut-offs: the cap was spent before an answer came out
        [
          'the answer was cut off with nothing usable in it',
          'thinking',
          'tagSimplifyService.js',
        ],
        [
          judge.SINGLE_PAIR_TRUNCATION_REASON,
          'thinking',
          'entityMatchAiService.js',
        ],
        [
          "The model's answers do not fit the token limit even for 4 pair(s). Switch thinking off for the judge (DUPLICATES_AI_THINKING) or raise TOKEN_LIMIT.",
          'thinking',
          null,
        ],
        [
          'OpenAI stopped generating after 700 tokens because the answer hit a token limit. Raise Response Tokens.',
          'thinking',
          null,
        ],
        // configuration: the provider cannot be asked at all
        ['No AI provider is configured', 'rejected', 'entityMatchAiService.js'],
        [
          'The AI provider is not configured (API key or endpoint missing)',
          'rejected',
          'entityMatchAiService.js',
        ],
        [
          'The AI provider is not configured',
          'rejected',
          'tagSimplifyService.js',
        ],
        [
          'Anthropic client not initialized - missing API key',
          'rejected',
          'anthropicService.js',
        ],
        ['OpenAI client not initialized - missing API key', 'rejected', null],
        // what the providers and Node say on the wire
        ['socket hang up', 'unreachable', null],
        ['Connection error.', 'unreachable', null],
        ['Request timed out.', 'unreachable', null],
        ['timeout of 30000ms exceeded', 'unreachable', null],
        ['getaddrinfo ENOTFOUND ollama', 'unreachable', null],
        ['connect ECONNREFUSED 172.18.0.4:11434', 'unreachable', null],
        ['401 Incorrect API key provided: sk-…', 'rejected', null],
        [
          '429 You exceeded your current quota, please check your plan and billing details.',
          'rejected',
          null,
        ],
        [
          "404 model 'qwen3:8b' not found, try pulling it first",
          'rejected',
          null,
        ],
        // Paperless-ngx, stops and budgets
        [
          'Paperless-ngx could not be reached while reading the tags',
          'paperless',
          'tagSimplifyService.js',
          'Paperless-ngx could not be reached while',
        ],
        [
          'Stopped while waiting for the document scan',
          'stopped',
          'duplicateReviewJobService.js',
        ],
        [
          'The request was aborted before the answer was complete.',
          'stopped',
          'aiGenerateOptions.js',
        ],
        ['The run stopped at its token budget of 5000 tokens.', 'budget', null],
        // nothing a person could act on more specifically than "try again"
        [
          'An AI review is already running',
          'unknown',
          'duplicateReviewJobService.js',
        ],
        [
          'The AI review is switched off (DUPLICATES_AI_REVIEW)',
          'unknown',
          null,
        ],
        ['Anthropic declined to answer (category: cyber).', 'unknown', null],
      ];
      for (const [message, kind, file, literal] of table) {
        assert.strictEqual(
          classifyFailure(new Error(message)).kind,
          kind,
          message
        );
        assert.strictEqual(
          classifyFailure(message).kind,
          kind,
          `${message} (string)`
        );
        if (file) {
          // The literal (up to its first placeholder) is still what the
          // service says; a rewording has to come through here.
          const said = literal || message.split(':')[0].split(' (')[0];
          assert.ok(
            source(file).includes(said),
            `${file} no longer says "${said}"`
          );
        }
      }
    });

    await test('Real axios errors are classified by their code and status', async () => {
      const refused = await axios
        .post(`http://127.0.0.1:${deadPort}/api/generate`, {})
        .catch((error) => error);
      assert.strictEqual(refused.code, 'ECONNREFUSED');
      assert.strictEqual(failure.transportKind(refused), 'unreachable');
      assert.strictEqual(classifyFailure(refused).kind, 'unreachable');

      for (const [status, kind] of [
        [401, 'rejected'],
        [403, 'rejected'],
        [404, 'rejected'],
        [429, 'rejected'],
        [500, 'unreachable'],
        [503, 'unreachable'],
      ]) {
        fakeOllama.setScript({ status, error: { error: 'nope' } });
        const error = await axios
          .post(`${fakeOllama.url}/api/generate`, { model: 'x' })
          .catch((e) => e);
        assert.strictEqual(error.response.status, status);
        const classified = classifyFailure(error);
        assert.strictEqual(classified.kind, kind, `axios ${status}`);
        assert.strictEqual(classified.status, status);
      }
      // A code with no status, as undici reports a dead connection.
      assert.strictEqual(
        failure.transportKind({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
        'unreachable'
      );
      assert.strictEqual(failure.transportKind(new Error('x')), null);
      assert.strictEqual(failure.transportKind(null), null);
    });

    await test('Real OpenAI SDK errors are classified by their status and name', async () => {
      const client = new OpenAI({
        apiKey: 'test',
        baseURL: fakeOpenAI.baseURL,
        maxRetries: 0,
      });
      for (const [status, kind, body] of [
        [
          401,
          'rejected',
          {
            error: {
              message: 'Incorrect API key provided',
              code: 'invalid_api_key',
            },
          },
        ],
        [
          429,
          'rejected',
          {
            error: {
              message: 'You exceeded your current quota',
              code: 'insufficient_quota',
            },
          },
        ],
        [404, 'rejected', { error: { message: 'The model does not exist' } }],
        [503, 'unreachable', { error: { message: 'overloaded' } }],
      ]) {
        fakeOpenAI.setScript({ status, error: body });
        const error = await client.chat.completions
          .create({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })
          .catch((e) => e);
        assert.strictEqual(error.status, status);
        assert.strictEqual(classifyFailure(error).kind, kind, `SDK ${status}`);
      }
      const dead = new OpenAI({
        apiKey: 'test',
        baseURL: `http://127.0.0.1:${deadPort}/v1`,
        maxRetries: 0,
      });
      const connection = await dead.chat.completions
        .create({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })
        .catch((e) => e);
      assert.strictEqual(connection.constructor.name, 'APIConnectionError');
      assert.strictEqual(failure.transportKind(connection), 'unreachable');
    });

    await test('The provider services tag what they throw', async () => {
      // Ollama: a dead host and a refused request.
      ollamaService.apiUrl = `http://127.0.0.1:${deadPort}`;
      const down = await ollamaService.generateText('hi').catch((e) => e);
      assert.strictEqual(down.failureKind, 'unreachable');
      ollamaService.apiUrl = fakeOllama.url;
      fakeOllama.setScript({
        status: 404,
        error: { error: "model 'qwen3:8b' not found" },
      });
      const missing = await ollamaService.generateText('hi').catch((e) => e);
      assert.strictEqual(missing.failureKind, 'rejected');

      // OpenAI: the service's own client, pointed at the fake.
      const realClient = openaiService.client;
      openaiService.client = new OpenAI({
        apiKey: 'test',
        baseURL: fakeOpenAI.baseURL,
        maxRetries: 0,
      });
      try {
        fakeOpenAI.setScript({
          status: 401,
          error: { error: { message: 'Incorrect API key provided' } },
        });
        const rejected = await openaiService.generateText('hi').catch((e) => e);
        assert.strictEqual(rejected.failureKind, 'rejected');
      } finally {
        openaiService.client = realClient;
      }

      // Anthropic: its SDK against the fake, which answers with an error body.
      fakeAnthropic.setScript({
        status: 401,
        error: {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        },
      });
      anthropicService.client = createAnthropicClient({
        apiKey: 'sk-ant-test',
        apiUrl: fakeAnthropic.url,
      });
      const anthropic = await anthropicService
        .generateText('hi')
        .catch((e) => e);
      anthropicService.client = null;
      assert.strictEqual(anthropic.status, 401, anthropic.stack);
      assert.strictEqual(anthropic.failureKind, 'rejected');

      // A tag the transport put on is never overwritten by a later one.
      const tagged = failure.tagFailure(
        Object.assign(new Error('x'), { status: 401 }),
        'thinking'
      );
      assert.strictEqual(
        failure.tagTransportFailure(tagged).failureKind,
        'thinking'
      );
      assert.strictEqual(failure.tagTransportFailure(null), null);
    });

    await test('A tag wins over message and status; stop reasons; Paperless-ngx over a 502', () => {
      const tagged = failure.tagFailure(
        Object.assign(new Error('401 the answer contained no JSON array'), {
          status: 401,
        }),
        FAILURE_KINDS.THINKING
      );
      assert.strictEqual(classifyFailure(tagged).kind, 'thinking');
      assert.strictEqual(
        classifyFailure({ message: 'x', failureKind: 'not-a-kind' }).kind,
        'unknown',
        'an unknown tag is ignored'
      );
      assert.strictEqual(
        classifyFailure('x', { stopReason: 'token-budget' }).kind,
        'budget'
      );
      assert.strictEqual(
        classifyFailure('x', { stopReason: 'user' }).kind,
        'stopped'
      );
      assert.strictEqual(
        classifyFailure('x', { stopReason: 'idle' }).kind,
        'stopped'
      );
      const aborted = Object.assign(new Error('This operation was aborted'), {
        name: 'AbortError',
      });
      assert.strictEqual(classifyFailure(aborted).kind, 'stopped');
      const paperless = Object.assign(
        new Error(
          'Paperless-ngx could not be reached while reading the tags: socket hang up'
        ),
        { status: 502 }
      );
      assert.strictEqual(classifyFailure(paperless).kind, 'paperless');
      const withContext = classifyFailure(new Error('boom'), {
        model: 'qwen3:8b',
        endpoint: 'http://ollama:11434',
      });
      assert.deepStrictEqual(withContext, {
        kind: 'unknown',
        message: 'boom',
        model: 'qwen3:8b',
        endpoint: 'http://ollama:11434',
        status: null,
      });
      assert.strictEqual(classifyFailure(undefined).kind, 'unknown');
    });

    await test('unusableAnswerKind: thinking exactly when there was reasoning and no answer', () => {
      const k = failure.unusableAnswerKind;
      // [answer, usage, truncated, kind]
      const table = [
        ['', { reasoningTokens: 890 }, false, 'thinking'],
        ['', { reasoningChars: 4000, answerChars: 0 }, false, 'thinking'],
        ['<think>Let me weigh the pairs', null, false, 'thinking'],
        ['<think>done</think>\n', null, false, 'thinking'],
        ['', null, true, 'thinking'],
        ['', { completionTokens: 1000 }, true, 'thinking'],
        ['', null, false, 'unreadable'],
        ['', { completionTokens: 0, reasoningTokens: 0 }, false, 'unreadable'],
        [
          'I am afraid I cannot help with that.',
          { reasoningTokens: 300 },
          false,
          'unreadable',
        ],
        [
          '<think>hm</think>Sure, here you go: same, same.',
          null,
          false,
          'unreadable',
        ],
        ['Here are the verdicts: first pair is', null, true, 'unreadable'],
      ];
      for (const [answer, usage, truncated, kind] of table) {
        assert.strictEqual(
          k(answer, usage, { truncated }),
          kind,
          JSON.stringify([answer, usage, truncated])
        );
      }
      assert.strictEqual(k(undefined, undefined), 'unreadable');
    });

    await test('requestFailure records one request, collapseFailures one notice per kind', () => {
      const one = failure.requestFailure(
        new Error('the model answered nothing'),
        {
          kind: 'thinking',
          model: 'qwen3:8b',
          pairsAffected: 9,
          index: 3,
          total: 6,
        }
      );
      assert.deepStrictEqual(one, {
        kind: 'thinking',
        message: 'the model answered nothing',
        model: 'qwen3:8b',
        endpoint: null,
        status: null,
        pairsAffected: 9,
        request: { index: 3, total: 6 },
      });
      const transport = failure.requestFailure(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        { tagsAffected: 50, index: 0, total: null }
      );
      assert.strictEqual(transport.kind, 'unreachable');
      assert.deepStrictEqual(transport.request, { index: null, total: null });
      assert.strictEqual('pairsAffected' in transport, false);

      const collapsed = failure.collapseFailures([
        one,
        transport,
        { ...one, message: 'later', pairsAffected: 4 },
        { kind: 'nonsense', message: 'odd' },
        null,
      ]);
      assert.deepStrictEqual(
        collapsed.map((f) => [
          f.kind,
          f.requests,
          f.pairsAffected,
          f.tagsAffected,
          f.message,
        ]),
        [
          ['thinking', 2, 13, undefined, 'the model answered nothing'],
          ['unreachable', 1, undefined, 50, 'socket hang up'],
          ['unknown', 1, undefined, undefined, 'odd'],
        ]
      );
      assert.deepStrictEqual(failure.collapseFailures(undefined), []);
      // Collapsing twice changes nothing: `requests` carries over.
      assert.deepStrictEqual(failure.collapseFailures(collapsed), collapsed);
    });

    // ------------------------------------------------------ thinking, for real

    const THOUGHT =
      'The user wants verdicts. Rechnung 0 and Rechnungen 0 look like ';

    await test('Ollama: a thinking-only answer is reported as reasoning, streamed or not', async () => {
      fakeOllama.setScript({
        chunks: [{ thinking: THOUGHT }, { thinking: 'a plural, so same…' }],
        evalCount: 1000,
        promptEvalCount: 900,
        doneReason: 'stop',
      });
      const plain = await ollamaService.generateText('judge').catch((e) => e);
      assert.ok(plain instanceof Error);
      assert.strictEqual(plain.message, 'Invalid response from Ollama API');
      assert.strictEqual(plain.failureKind, 'thinking');

      const streamed = await ollamaService.generateText('judge', {
        onProgress: () => {},
      });
      assert.strictEqual(streamed, '');
      const usage = ollamaService.lastGenerateTextUsage;
      assert.strictEqual(usage.completionTokens, 1000);
      assert.strictEqual(usage.answerChars, 0);
      assert.ok(usage.reasoningChars > 50, 'the thinking is counted');
      assert.strictEqual(
        failure.unusableAnswerKind(streamed, usage),
        'thinking'
      );

      // An inline <think> block and nothing after it, without streaming.
      fakeOllama.setScript({
        chunks: [{ response: `<think>${THOUGHT}</think>\n` }],
        evalCount: 800,
        promptEvalCount: 900,
      });
      const inline = await ollamaService.generateText('judge');
      assert.strictEqual(inline, '');
      assert.ok(ollamaService.lastGenerateTextUsage.reasoningChars > 50);
      assert.strictEqual(
        failure.unusableAnswerKind(inline, ollamaService.lastGenerateTextUsage),
        'thinking'
      );

      // A model that answers without thinking reports no reasoning at all.
      fakeOllama.setScript({
        chunks: [{ response: 'I cannot do that.' }],
        evalCount: 5,
        promptEvalCount: 900,
      });
      await ollamaService.generateText('judge', { onProgress: () => {} });
      assert.strictEqual(ollamaService.lastGenerateTextUsage.reasoningChars, 0);
    });

    await test('OpenAI-compatible: reasoning only, cut off or not, is thinking', async () => {
      const realClient = openaiService.client;
      openaiService.client = new OpenAI({
        apiKey: 'test',
        baseURL: fakeOpenAI.baseURL,
        maxRetries: 0,
      });
      try {
        // Streamed and stopped at the cap with only reasoning_content.
        fakeOpenAI.setScript({
          chunks: [{ reasoning: THOUGHT }, { reasoning: 'still thinking' }],
          finishReason: 'length',
          usage: {
            prompt_tokens: 900,
            completion_tokens: 1000,
            total_tokens: 1900,
          },
        });
        const cut = await openaiService
          .generateText('judge', { onProgress: () => {}, maxTokens: 1000 })
          .catch((e) => e);
        assert.strictEqual(cut.code, 'ai_response_truncated');
        assert.strictEqual(
          failure.unusableAnswerKind(
            cut.partialText,
            openaiService.lastGenerateTextUsage,
            {
              truncated: true,
            }
          ),
          'thinking'
        );
        // Not streamed, finished, and only a <think> block in the content.
        fakeOpenAI.setScript({
          chunks: [{ content: `<think>${THOUGHT}</think>` }],
          finishReason: 'stop',
        });
        const empty = await openaiService.generateText('judge').catch((e) => e);
        assert.match(empty.message, /carried no text/);
        assert.strictEqual(empty.failureKind, 'thinking');
        assert.strictEqual(classifyFailure(empty).kind, 'thinking');
      } finally {
        openaiService.client = realClient;
      }
    });

    /** Two tag pairs for the judge. */
    function pairs() {
      const entity = (id, name) => ({ id, name, documentCount: 2 });
      return [
        [1, 'Rechnung 0', 2, 'Rechnungen 0'],
        [3, 'Vertrag 1', 4, 'Vertraege 1'],
      ].map(([idA, a, idB, b]) => ({
        key: matcher.pairKey('tags', idA, idB),
        a: entity(idA, a),
        b: entity(idB, b),
      }));
    }

    await test('The judge records thinking when the model only thought, unreadable when it wrote prose', async () => {
      const realGetService = AIServiceFactory.getService;
      AIServiceFactory.getService = () => ollamaService;
      try {
        // Watched (streamed): the stream reports the reasoning.
        judge.resetCalibration();
        fakeOllama.setScript({
          chunks: [{ thinking: THOUGHT }],
          evalCount: 1000,
          promptEvalCount: 900,
        });
        const tracker = judge._reviewTracker({ onProgress: () => {} });
        const watched = await judge.reviewPairs(pairs(), {
          kind: 'tags',
          tracker,
        });
        assert.strictEqual(fakeOllama.last().body.stream, true);
        assert.strictEqual(watched.usage.failedRequests, 1);
        assert.deepStrictEqual(
          watched.usage.failures.map((f) => [f.kind, f.pairsAffected, f.model]),
          [['thinking', 2, 'qwen3:8b']]
        );
        const verdict = watched.verdicts.get(pairs()[0].key);
        assert.strictEqual(verdict.verdict, 'unsure');
        assert.strictEqual(verdict.failureKind, 'thinking');
        assert.match(verdict.reason, /spent its answer on reasoning/);

        // Unwatched (plain request): Ollama's empty answer is tagged.
        judge.resetCalibration();
        const plain = await judge.reviewPairs(pairs(), { kind: 'tags' });
        assert.strictEqual(fakeOllama.last().body.stream, false);
        assert.strictEqual(plain.usage.failures[0].kind, 'thinking');
        assert.strictEqual(
          plain.usage.failures[0].message,
          'Invalid response from Ollama API'
        );

        // Prose, no thinking: the model answered, just not in the form.
        judge.resetCalibration();
        fakeOllama.setScript({
          chunks: [{ response: 'Both look the same to me.' }],
          evalCount: 8,
          promptEvalCount: 900,
        });
        const prose = await judge.reviewPairs(pairs(), {
          kind: 'tags',
          tracker: judge._reviewTracker({ onProgress: () => {} }),
        });
        assert.strictEqual(prose.usage.failures[0].kind, 'unreadable');
        assert.match(prose.usage.failures[0].message, /no JSON array/);
        assert.strictEqual(
          prose.verdicts.get(pairs()[0].key).reason,
          "The model's answer could not be read; decide this one yourself."
        );
      } finally {
        AIServiceFactory.getService = realGetService;
      }
    });
  } finally {
    console.error = realError;
    console.debug = realDebug;
    console.warn = realWarn;
    console.log = quiet;
    await fakeOllama.close();
    await fakeOpenAI.close();
    await fakeAnthropic.close();
  }

  quiet(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
