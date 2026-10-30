'use strict';

/**
 * A reasoning model on Mistral's API answers in content chunks, not a string.
 *
 * The evidence this exists for: zai-glm-5-3-flash on api.mistral.ai sent
 * `content: [{ type: 'thinking', … }, { type: 'text', text: '{…}' }]`, the
 * custom provider read only a string content, found none, and every document
 * failed with "Invalid API response structure". The same model streams its
 * thoughts as a chunk list in delta.content and its answer as plain strings.
 *
 * And the model thinks at full effort unless told otherwise; Mistral takes
 * reasoning_effort for it, so CUSTOM_REASONING_EFFORT sends one.
 *
 * Cases:
 *   1. splitChatContent separates text chunks from thinking chunks
 *   2. extractChatMessageContent reads the text chunks and nothing else
 *   3. an answer that only thought falls back to JSON in the thinking
 *   4. a plain generateText answer in chunks is the text alone
 *   5. a streamed one reports thinking and keeps it out of the text
 *   6. analyzeDocument parses an answer in chunks
 *   7. CUSTOM_REASONING_EFFORT goes out with the analysis
 *   8. generateText sends it too, and 'low' when the caller wants no thinking
 *   9. without it nothing new is sent
 *  10. Mistral's API never gets chat_template_kwargs: it answers 422 for it,
 *      which broke every reasoning: false call (Duplicates, Simplify)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OpenAI = require('openai');

const { createFakeOpenAI } = require('./helpers/fake-openai');

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

/** Runs a body with the services' chatter swallowed. */
async function quiet(fn) {
  const saved = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const ANSWER = {
  title: 'Stadtwerke invoice September',
  correspondent: 'Stadtwerke Musterstadt GmbH',
  tags: ['Invoice', 'Electricity'],
  document_type: 'Invoice',
  document_date: '2026-09-03',
  language: 'de',
  custom_fields: {},
};
const ANSWER_JSON = JSON.stringify(ANSWER);
const USAGE = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
const DOCUMENT_ID = 7;

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-mistral-'));
  process.chdir(tempRoot);
  // The analysis caches a thumbnail first; with one in place it never asks
  // Paperless-ngx for it.
  fs.mkdirSync(path.join(tempRoot, 'data', 'thumb-cache'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(tempRoot, 'data', 'thumb-cache', `${DOCUMENT_ID}.png`),
    'png'
  );

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://127.0.0.1:9';
  process.env.PAPERLESS_API_TOKEN = 'test-token';
  process.env.AI_PROVIDER = 'custom';
  process.env.SYSTEM_PROMPT = 'Analyse the document and answer in JSON.';
  process.env.CUSTOM_FIELDS = JSON.stringify({ custom_fields: [] });
  process.env.USE_PROMPT_TAGS = 'no';
  delete process.env.CUSTOM_REASONING_EFFORT;

  const config = require('../config/config');
  const customService = require('../services/customService');
  const {
    splitChatContent,
    extractChatMessageContent,
  } = require('../services/serviceUtils');

  const fake = await createFakeOpenAI();
  customService.client = new OpenAI({
    apiKey: 'test',
    baseURL: fake.baseURL,
    maxRetries: 0,
    timeout: 15000,
  });

  const defaults = {
    model: config.custom.model,
    reasoningEffort: config.custom.reasoningEffort,
  };
  config.custom.model = 'zai-glm-5-3-flash';

  function useScript(script) {
    fake.reset();
    fake.setScript(script);
  }

  const analyze = () =>
    quiet(() =>
      customService.analyzeDocument(
        'Stadtwerke Musterstadt GmbH, invoice 4711 of 03.09.2026',
        [],
        [],
        [],
        DOCUMENT_ID
      )
    );

  try {
    await test('splitChatContent separates text chunks from thinking chunks', async () => {
      assert.deepStrictEqual(splitChatContent('plain'), {
        text: 'plain',
        reasoning: '',
      });
      assert.deepStrictEqual(
        splitChatContent([
          { type: 'thinking', thinking: [{ type: 'text', text: 'Hm, ' }] },
          { type: 'thinking', thinking: 'an invoice.' },
          { type: 'text', text: '{"a":' },
          '1}',
        ]),
        { text: '{"a":1}', reasoning: 'Hm, an invoice.' }
      );
      assert.deepStrictEqual(splitChatContent(null), {
        text: '',
        reasoning: '',
      });
      assert.deepStrictEqual(splitChatContent([{ type: 'image_url' }]), {
        text: '',
        reasoning: '',
      });
    });

    await test('extractChatMessageContent reads the text chunks and nothing else', async () => {
      const text = extractChatMessageContent({
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: [{ type: 'text', text: 'Maybe {"title":"wrong"}' }],
          },
          { type: 'text', text: ` ${ANSWER_JSON} ` },
        ],
      });
      assert.strictEqual(text, ANSWER_JSON);
    });

    await test('an answer that only thought falls back to JSON in the thinking', async () => {
      const text = await quiet(() =>
        extractChatMessageContent({
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: [{ type: 'text', text: `So: ${ANSWER_JSON}` }],
            },
          ],
        })
      );
      assert.strictEqual(text, ANSWER_JSON);
    });

    await test('a plain generateText answer in chunks is the text alone', async () => {
      useScript({
        chunks: [
          { thinking: 'The user wants JSON.' },
          { content: '{"ok":true}' },
        ],
        usage: USAGE,
      });
      const answer = await quiet(() => customService.generateText('hello'));
      assert.strictEqual(answer, '{"ok":true}');
      assert.notStrictEqual(fake.last().body.stream, true);
    });

    await test('a streamed one reports thinking and keeps it out of the text', async () => {
      useScript({
        chunks: [
          { thinking: 'The user ' },
          { thinking: 'wants JSON.' },
          { content: '{"ok":' },
          { content: 'true}' },
        ],
        usage: USAGE,
      });
      const updates = [];
      const answer = await quiet(() =>
        customService.generateText('hello', {
          onProgress: (update) => updates.push(update),
        })
      );
      assert.strictEqual(answer, '{"ok":true}');
      assert.ok(fake.last().body.stream, 'the request was streamed');
      const last = updates[updates.length - 1];
      assert.strictEqual(last.done, true);
      assert.strictEqual(last.text, '{"ok":true}');
      assert.ok(
        last.thinkingTokens > 0,
        `thinking was counted (${last.thinkingTokens})`
      );
      assert.ok(
        updates.every((update) => !update.text.includes('wants JSON')),
        'no report showed the thinking as text'
      );
    });

    await test('analyzeDocument parses an answer in chunks', async () => {
      useScript({
        chunks: [
          { thinking: 'An electricity invoice.' },
          { content: ANSWER_JSON },
        ],
        usage: USAGE,
      });
      const result = await analyze();
      assert.strictEqual(result.error, undefined, result.error);
      assert.strictEqual(result.document.title, ANSWER.title);
      assert.deepStrictEqual(result.document.tags, ANSWER.tags);
    });

    await test('CUSTOM_REASONING_EFFORT goes out with the analysis', async () => {
      config.custom.reasoningEffort = 'high';
      useScript({ chunks: [{ content: ANSWER_JSON }], usage: USAGE });
      const result = await analyze();
      assert.strictEqual(result.error, undefined, result.error);
      assert.strictEqual(fake.last().body.reasoning_effort, 'high');
    });

    await test("generateText sends it too, and 'low' when the caller wants no thinking", async () => {
      config.custom.reasoningEffort = 'max';
      useScript({ chunks: [{ content: 'ok' }], usage: USAGE });
      await quiet(() => customService.generateText('hello'));
      assert.strictEqual(fake.last().body.reasoning_effort, 'max');
      await quiet(() =>
        customService.generateText('hello', { reasoning: true })
      );
      assert.strictEqual(fake.last().body.reasoning_effort, 'max');
      await quiet(() =>
        customService.generateText('hello', { reasoning: false })
      );
      assert.strictEqual(fake.last().body.reasoning_effort, 'low');
    });

    await test('without it nothing new is sent', async () => {
      config.custom.reasoningEffort = '';
      useScript({ chunks: [{ content: ANSWER_JSON }], usage: USAGE });
      await analyze();
      assert.strictEqual('reasoning_effort' in fake.last().body, false);
      await quiet(() => customService.generateText('hello'));
      assert.strictEqual('reasoning_effort' in fake.last().body, false);
      await quiet(() =>
        customService.generateText('hello', { reasoning: false })
      );
      assert.strictEqual('reasoning_effort' in fake.last().body, false);
    });

    await test("Mistral's API never gets chat_template_kwargs", async () => {
      const fakeClient = customService.client;
      // Addressed to api.mistral.ai, delivered to the fake.
      customService.client = new OpenAI({
        apiKey: 'test',
        baseURL: 'https://api.mistral.ai/v1',
        maxRetries: 0,
        timeout: 15000,
        fetch: (url, init) =>
          fetch(
            String(url).replace('https://api.mistral.ai/v1', fake.baseURL),
            init
          ),
      });
      try {
        config.custom.reasoningEffort = 'high';
        useScript({ chunks: [{ content: 'ok' }], usage: USAGE });
        await quiet(() =>
          customService.generateText('hello', { reasoning: false })
        );
        assert.strictEqual('chat_template_kwargs' in fake.last().body, false);
        assert.strictEqual(fake.last().body.reasoning_effort, 'low');
      } finally {
        customService.client = fakeClient;
      }
      // Every other endpoint still gets it.
      await quiet(() =>
        customService.generateText('hello', { reasoning: false })
      );
      assert.deepStrictEqual(fake.last().body.chat_template_kwargs, {
        enable_thinking: false,
      });
    });
  } finally {
    config.custom.model = defaults.model;
    config.custom.reasoningEffort = defaults.reasoningEffort;
    customService.client = null;
    await fake.close();
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
