'use strict';

/**
 * The Claude API as an AI provider (services/anthropicService.js).
 *
 * The service talks to tests/helpers/fake-anthropic.js, a real HTTP server
 * that answers like the Messages API, through the real SDK: the parts worth
 * testing are the request the SDK puts on the wire, the server-sent events it
 * reads back and the connection it drops on an abort. ANTHROPIC_API_URL points
 * at the fake before config is loaded, so the client is the one initialize()
 * builds from config.
 *
 * Cases:
 *   1. the analysis request: top-level system, one user message with the
 *      document, max_tokens from ANTHROPIC_MAX_TOKENS, no sampling parameters
 *   2. thinking and effort per model (Haiku 5.5, Sonnet 5.5, Opus 5.5)
 *   3. structured output: the schema goes out when it is on and the model
 *      takes it, and not when it is off or the model does not
 *   4. prompt caching: a cacheable system block when on, a string when off
 *   5. the system prompt is byte-identical between two documents of a scan
 *   6. an answer that starts with a thinking block is read by type
 *   7. usage becomes metrics, with the cache counts and one debug line
 *   8. an answer cut off at max_tokens is ai_response_truncated
 *   9. a refusal is ai_refused and is not sent to the OCR queue
 *  10. a schema the API refuses is dropped once, and the analysis goes on
 *  11. USE_PROMPT_TAGS asks for the predefined-tags object, the schema follows
 *  12. the schema for a configuration with custom fields
 *  13. the prompt builder reproduces customService's system prompt byte for
 *      byte, in every branch it has
 *  14. generateText: plain and streamed give the same answer, done once,
 *      thinking reported as thinking and kept out of the text
 *  15. generateText: the usage the caller reads off the service
 *  16. generateText: model, maxTokens and systemPrompt are honoured,
 *      temperature is not sent
 *  17. generateText: a cut-off stream throws with what it managed
 *  18. generateText: a refusal is ai_refused with what arrived
 *  19. an abort mid-stream is an AbortError, and the server sees it
 *  20. an abort before the request is an AbortError too
 *  21. checkStatus: ok without spending tokens, clear errors otherwise
 *  22. the Claude token estimate, every other model unchanged
 *  23. the Duplicates review names the Anthropic model
 *  24. an analysis that times out reports the AI timeout
 *  25. without a key: the analysis fails softly, generateText throws
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OpenAI = require('openai');

const { createFakeAnthropic } = require('./helpers/fake-anthropic');
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

/**
 * Runs a body with the services' logging captured instead of printed: they
 * log every token calculation, and half of these cases fail on purpose.
 *
 * @returns {Promise<{result: unknown, lines: Array<{level: string, text: string}>}>}
 */
async function captured(fn) {
  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  const real = {};
  const lines = [];
  for (const level of levels) {
    real[level] = console[level];
    console[level] = (...args) =>
      lines.push({
        level,
        text: args
          .map((arg) => (typeof arg === 'string' ? arg : String(arg)))
          .join(' '),
      });
  }
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    for (const level of levels) console[level] = real[level];
  }
}

/** The result of fn, with its logging swallowed. */
async function quiet(fn) {
  return (await captured(fn)).result;
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

/** The text of a request's system field, whichever form it took. */
function systemText(body) {
  if (typeof body.system === 'string') return body.system;
  if (Array.isArray(body.system)) {
    return body.system.map((block) => block.text).join('');
  }
  return undefined;
}

/** Walks a JSON schema and calls visit on every object schema in it. */
function eachObjectSchema(schema, visit) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') visit(schema);
  for (const value of Object.values(schema)) {
    if (value && typeof value === 'object') eachObjectSchema(value, visit);
  }
}

const ANSWER = {
  title: 'Telekom invoice July',
  correspondent: 'Telekom Deutschland GmbH',
  tags: ['Invoice', 'Telephone'],
  document_type: 'Invoice',
  document_date: '2026-07-03',
  language: 'de',
  custom_fields: {},
};
const ANSWER_JSON = JSON.stringify(ANSWER);

const CUSTOM_FIELDS = JSON.stringify({
  custom_fields: [
    { value: 'Invoice number', data_type: 'string' },
    { value: 'Due date', data_type: 'date' },
    { value: 'Paid', data_type: 'boolean' },
  ],
});

const DOCUMENT_IDS = [7, 8, 9];

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-anthropic-'));
  process.chdir(tempRoot);
  // The analysis caches a thumbnail first; with one in place it never asks
  // Paperless-ngx for it.
  fs.mkdirSync(path.join(tempRoot, 'data', 'thumb-cache'), {
    recursive: true,
  });
  for (const id of DOCUMENT_IDS) {
    fs.writeFileSync(
      path.join(tempRoot, 'data', 'thumb-cache', `${id}.png`),
      'png'
    );
  }

  const fake = await createFakeAnthropic({});
  const fakeOpenAI = await createFakeOpenAI({
    chunks: [{ content: ANSWER_JSON }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://127.0.0.1:9';
  process.env.PAPERLESS_API_TOKEN = 'test-token';
  process.env.AI_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.ANTHROPIC_API_URL = fake.url;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_EFFORT;
  delete process.env.ANTHROPIC_MAX_TOKENS;
  delete process.env.DUPLICATES_AI_MODEL;
  process.env.SYSTEM_PROMPT = 'Analyse the document and answer in JSON.';
  process.env.CUSTOM_FIELDS = JSON.stringify({ custom_fields: [] });
  process.env.USE_PROMPT_TAGS = 'no';

  const config = require('../config/config');
  const anthropicService = require('../services/anthropicService');
  const customService = require('../services/customService');
  const {
    calculateTokens,
    truncateToTokenLimit,
    shouldQueueForOcrOnAiError,
    classifyOcrQueueReasonFromAiError,
    buildTimeoutErrorMessage,
  } = require('../services/serviceUtils');
  const { createAnthropicClient } = require('../services/anthropicSupport');
  const {
    buildAnalysisPrompt,
    analysisResponseSchema,
  } = require('../services/analysisPrompt');

  customService.client = new OpenAI({
    apiKey: 'test',
    baseURL: fakeOpenAI.baseURL,
    maxRetries: 0,
  });

  const defaults = {
    anthropic: { ...config.anthropic },
    useExistingData: config.useExistingData,
    restrictToExistingTags: config.restrictToExistingTags,
    restrictToExistingCorrespondents: config.restrictToExistingCorrespondents,
    systemPrompt: process.env.SYSTEM_PROMPT,
    customFields: process.env.CUSTOM_FIELDS,
  };

  /** Back to the configuration every case starts from. */
  function restore() {
    Object.assign(config.anthropic, defaults.anthropic);
    config.useExistingData = defaults.useExistingData;
    config.restrictToExistingTags = defaults.restrictToExistingTags;
    config.restrictToExistingCorrespondents =
      defaults.restrictToExistingCorrespondents;
    process.env.SYSTEM_PROMPT = defaults.systemPrompt;
    process.env.CUSTOM_FIELDS = defaults.customFields;
    process.env.USE_PROMPT_TAGS = 'no';
    anthropicService.rejectedSchemas.clear();
    fake.setApiKey(null);
  }

  /** Points the fake at a fresh script and forgets the old requests. */
  function useScript(script) {
    fake.reset();
    fake.setScript(script);
  }

  const analyze = (content = 'Invoice 4711 from Telekom', id = 7, ...rest) =>
    quiet(() =>
      anthropicService.analyzeDocument(
        content,
        ['Invoice', 'Telephone'],
        ['Telekom'],
        ['Invoice'],
        id,
        ...rest
      )
    );

  try {
    // ------------------------------------------------------------ the request

    await test('The analysis sends top-level system, one user message, max_tokens and no sampling parameters', async () => {
      restore();
      useScript({ chunks: [{ text: ANSWER_JSON }] });

      const result = await analyze('Invoice 4711 from Telekom');

      assert.strictEqual(result.error, undefined, result.error);
      const record = fake.last();
      const body = record.body;
      assert.strictEqual(record.path, '/v1/messages');
      assert.strictEqual(record.headers.authorization, 'Bearer sk-ant-test');
      assert.ok(record.headers['anthropic-version'], 'the SDK sends a version');
      assert.strictEqual(body.model, 'claude-haiku-5-5', 'the default model');
      assert.strictEqual(body.max_tokens, 16000, 'ANTHROPIC_MAX_TOKENS');
      assert.deepStrictEqual(body.messages, [
        { role: 'user', content: 'Invoice 4711 from Telekom' },
      ]);
      assert.match(systemText(body), /^Analyse the document/);
      assert.ok(
        !body.messages.some((message) => message.role === 'system'),
        'the system prompt is no message'
      );
      for (const key of ['temperature', 'top_p', 'top_k']) {
        assert.strictEqual(key in body, false, `no ${key}`);
      }
      assert.strictEqual(
        'thinking' in body,
        false,
        'no effort configured: the model decides'
      );

      config.anthropic.maxTokens = 32000;
      useScript({ chunks: [{ text: ANSWER_JSON }] });
      await analyze();
      assert.strictEqual(fake.last().body.max_tokens, 32000);
    });

    await test('Thinking and effort follow the model and ANTHROPIC_EFFORT', async () => {
      restore();
      useScript({ chunks: [{ text: ANSWER_JSON }] });

      config.anthropic.effort = 'high';
      await analyze();
      assert.deepStrictEqual(
        fake.last().body.output_config.effort,
        'high',
        'the analysis sends the configured effort'
      );
      assert.ok(
        fake.last().body.output_config.format,
        'merged with the schema, not replaced by it'
      );

      // reasoning: false asks each model for as little thinking as it allows.
      const expected = {
        'claude-haiku-5-5': {
          thinking: { type: 'disabled' },
          output_config: { effort: 'low' },
        },
        'claude-sonnet-5-5': {
          thinking: { type: 'between_tools' },
          output_config: { effort: 'low' },
        },
        // Always thinks; a low effort is the only lever.
        'claude-opus-5-5': { output_config: { effort: 'low' } },
      };
      for (const [model, fields] of Object.entries(expected)) {
        useScript({ chunks: [{ text: 'ok' }] });
        await quiet(() =>
          anthropicService.generateText('judge this', {
            model,
            reasoning: false,
          })
        );
        const body = fake.last().body;
        assert.strictEqual(body.model, model);
        assert.deepStrictEqual(body.thinking, fields.thinking, model);
        assert.deepStrictEqual(body.output_config, fields.output_config, model);
      }

      // reasoning: null sends only the configured effort.
      useScript({ chunks: [{ text: 'ok' }] });
      await quiet(() =>
        anthropicService.generateText('judge this', {
          model: 'claude-sonnet-5-5',
        })
      );
      assert.strictEqual('thinking' in fake.last().body, false);
      assert.deepStrictEqual(fake.last().body.output_config, {
        effort: 'high',
      });

      // reasoning: true asks for adaptive only where thinking is off by default.
      useScript({ chunks: [{ text: 'ok' }] });
      await quiet(() =>
        anthropicService.generateText('judge this', {
          model: 'claude-haiku-5-5',
          reasoning: true,
        })
      );
      assert.strictEqual('thinking' in fake.last().body, false);
    });

    await test('Structured output: the schema goes out when on and supported, not otherwise', async () => {
      restore();
      useScript({ chunks: [{ text: ANSWER_JSON }] });

      await analyze();
      const format = fake.last().body.output_config?.format;
      assert.ok(format, 'the schema went out');
      assert.strictEqual(format.type, 'json_schema');
      assert.deepStrictEqual(
        format.schema,
        analysisResponseSchema({ responseShape: 'full', customFields: [] })
      );

      config.anthropic.structuredOutput = 'no';
      useScript({ chunks: [{ text: ANSWER_JSON }] });
      const off = await analyze();
      assert.strictEqual(off.error, undefined, off.error);
      assert.strictEqual(
        'output_config' in fake.last().body,
        false,
        'switched off: no output_config at all'
      );

      // A model that does not take output_config.format would answer 400.
      config.anthropic.structuredOutput = 'yes';
      config.anthropic.model = 'claude-sonnet-4-6';
      useScript({ chunks: [{ text: '```json\n' + ANSWER_JSON + '\n```' }] });
      const older = await analyze();
      assert.strictEqual(older.error, undefined, older.error);
      assert.strictEqual(fake.last().body.model, 'claude-sonnet-4-6');
      assert.strictEqual(
        fake.last().body.output_config?.format,
        undefined,
        'no schema for a model without structured output'
      );
      assert.deepStrictEqual(
        older.document,
        ANSWER,
        'the fenced answer is still parsed the tolerant way'
      );
    });

    await test('Prompt caching: a cacheable system block when on, a plain string when off', async () => {
      restore();
      useScript({ chunks: [{ text: ANSWER_JSON }] });

      await analyze();
      const system = fake.last().body.system;
      assert.ok(Array.isArray(system), 'one block');
      assert.strictEqual(system.length, 1);
      assert.strictEqual(system[0].type, 'text');
      assert.deepStrictEqual(system[0].cache_control, { type: 'ephemeral' });

      useScript({ chunks: [{ text: 'ok' }] });
      await quiet(() =>
        anthropicService.generateText('hello', { systemPrompt: 'Be brief.' })
      );
      assert.deepStrictEqual(fake.last().body.system, [
        {
          type: 'text',
          text: 'Be brief.',
          cache_control: { type: 'ephemeral' },
        },
      ]);

      useScript({ chunks: [{ text: 'ok' }] });
      await quiet(() => anthropicService.generateText('hello'));
      assert.strictEqual(
        'system' in fake.last().body,
        false,
        'no system prompt, no system field'
      );

      config.anthropic.promptCaching = 'no';
      useScript({ chunks: [{ text: ANSWER_JSON }] });
      await analyze();
      assert.strictEqual(typeof fake.last().body.system, 'string');

      useScript({ chunks: [{ text: 'ok' }] });
      await quiet(() =>
        anthropicService.generateText('hello', { systemPrompt: 'Be brief.' })
      );
      assert.strictEqual(fake.last().body.system, 'Be brief.');
    });

    await test('The system prompt is byte-identical between two documents of one scan', async () => {
      restore();
      process.env.CUSTOM_FIELDS = CUSTOM_FIELDS;
      config.useExistingData = 'yes';
      config.restrictToExistingTags = 'no';
      config.restrictToExistingCorrespondents = 'no';
      useScript({ chunks: [{ text: ANSWER_JSON }] });

      await analyze('First document: an invoice from Telekom', 7);
      await analyze('Second document: a contract with the landlord', 8);

      const [first, second] = fake.messageRequests();
      assert.ok(first && second, 'two requests');
      assert.strictEqual(
        JSON.stringify(first.body.system),
        JSON.stringify(second.body.system),
        'same bytes, so the second request reads the cache'
      );
      assert.notStrictEqual(
        first.body.messages[0].content,
        second.body.messages[0].content
      );
      const text = systemText(first.body);
      assert.ok(!text.includes('Telekom invoice'), 'no document text in it');
      assert.ok(
        !/\b[78]\b/.test(text.replace(/\d{4}-\d{2}-\d{2}/g, '')),
        'no document id in it'
      );
      assert.ok(text.includes('Pre-existing tags: Invoice, Telephone'));
    });

    // -------------------------------------------------------------- the answer

    await test('An answer that starts with a thinking block is read by type', async () => {
      restore();
      useScript({
        chunks: [{ thinking: '' }, { text: ANSWER_JSON }],
      });

      const result = await analyze();

      assert.strictEqual(result.error, undefined, result.error);
      assert.deepStrictEqual(result.document, ANSWER);
      assert.strictEqual(result.truncated, false);
    });

    await test('Usage becomes metrics, cache counts included, with one debug line per request', async () => {
      restore();
      useScript({
        chunks: [{ text: ANSWER_JSON }],
        usage: {
          input_tokens: 120,
          output_tokens: 80,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 0,
        },
      });

      const { result, lines } = await captured(() =>
        anthropicService.analyzeDocument('Invoice 4711', [], [], [], 7)
      );

      assert.deepStrictEqual(result.metrics, {
        promptTokens: 1020,
        completionTokens: 80,
        totalTokens: 1100,
        reasoningTokens: null,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
      });
      const cacheLines = lines.filter((line) =>
        line.text.includes('Anthropic cache:')
      );
      assert.deepStrictEqual(
        cacheLines.map((line) => [line.level, line.text]),
        [['debug', '[DEBUG] Anthropic cache: read 900, write 0']]
      );
    });

    await test('An answer cut off at max_tokens is ai_response_truncated and names ANTHROPIC_MAX_TOKENS', async () => {
      restore();
      useScript({
        chunks: [{ text: '{"title":"Telekom inv' }],
        stopReason: 'max_tokens',
        usage: { output_tokens: 16000 },
      });

      const result = await analyze();

      assert.strictEqual(result.errorCode, 'ai_response_truncated');
      assert.match(result.error, /after 16000 tokens/);
      assert.match(result.error, /ANTHROPIC_MAX_TOKENS/);
      assert.strictEqual(result.metrics, null);
      assert.deepStrictEqual(result.document, {
        tags: [],
        correspondent: null,
      });
      assert.strictEqual(
        shouldQueueForOcrOnAiError(result.error),
        false,
        'OCR text would be cut off the same way'
      );
    });

    await test('A refusal is ai_refused and does not go to the OCR queue', async () => {
      restore();
      useScript({
        chunks: [],
        stopReason: 'refusal',
        stopDetails: { category: 'cyber', explanation: 'declined' },
      });

      const result = await analyze();

      assert.strictEqual(result.errorCode, 'ai_refused');
      assert.match(result.error, /declined to answer/);
      assert.match(result.error, /cyber/);
      assert.deepStrictEqual(result.document, {
        tags: [],
        correspondent: null,
      });
      assert.strictEqual(
        shouldQueueForOcrOnAiError(result.error),
        false,
        'OCR cannot fix a refusal'
      );
      assert.strictEqual(
        classifyOcrQueueReasonFromAiError(result.error),
        'ai_failed_unknown'
      );

      // The classifier is live: an unreadable answer from the same provider
      // does go to the OCR queue.
      useScript({ chunks: [{ text: 'no JSON in here' }] });
      const unreadable = await analyze();
      assert.strictEqual(unreadable.error, 'Invalid JSON response from API');
      assert.strictEqual(shouldQueueForOcrOnAiError(unreadable.error), true);
    });

    await test('A schema the API refuses is dropped once, and the analysis goes on without it', async () => {
      restore();
      useScript([
        { status: 400, error: undefined },
        { chunks: [{ text: ANSWER_JSON }] },
      ]);

      const { result, lines } = await captured(() =>
        anthropicService.analyzeDocument('Invoice', [], [], [], 7)
      );

      assert.strictEqual(result.error, undefined, result.error);
      assert.deepStrictEqual(result.document, ANSWER);
      const [refused, retried] = fake.messageRequests();
      assert.ok(refused.body.output_config.format, 'first with the schema');
      assert.strictEqual(
        retried.body.output_config,
        undefined,
        'then without it (no effort configured, so no output_config at all)'
      );
      assert.strictEqual(
        lines.filter((line) => line.text.includes('refused the analysis'))
          .length,
        1
      );

      useScript({ chunks: [{ text: ANSWER_JSON }] });
      await analyze();
      assert.strictEqual(fake.messageRequests().length, 1);
      assert.strictEqual(
        fake.last().body.output_config,
        undefined,
        'the next document does not try the refused schema again'
      );

      // The retry drops the schema and keeps the effort.
      anthropicService.rejectedSchemas.clear();
      config.anthropic.effort = 'medium';
      useScript([{ status: 400 }, { chunks: [{ text: ANSWER_JSON }] }]);
      await analyze();
      assert.deepStrictEqual(fake.messageRequests()[1].body.output_config, {
        effort: 'medium',
      });
      config.anthropic.effort = defaults.anthropic.effort;

      // A 400 that the retry does not fix surfaces as it is.
      anthropicService.rejectedSchemas.clear();
      useScript({ status: 400 });
      const broken = await analyze();
      assert.match(broken.error, /400/);
      assert.strictEqual(anthropicService.rejectedSchemas.size, 0);
    });

    await test('USE_PROMPT_TAGS asks for the predefined-tags object, and the schema follows', async () => {
      restore();
      process.env.USE_PROMPT_TAGS = 'yes';
      process.env.CUSTOM_FIELDS = CUSTOM_FIELDS;
      const answer = {
        title: 'Telekom invoice',
        correspondent: 'Telekom',
        tags: ['Invoice'],
        document_date: '2026-07-03',
        language: 'de',
      };
      useScript({ chunks: [{ text: JSON.stringify(answer) }] });

      const result = await analyze();

      assert.deepStrictEqual(result.document, answer);
      const body = fake.last().body;
      assert.ok(
        systemText(body).startsWith(
          '\n        Take these tags and try to match one or more'
        )
      );
      assert.deepStrictEqual(
        Object.keys(body.output_config.format.schema.properties),
        ['title', 'correspondent', 'tags', 'document_date', 'language'],
        'no document type and no custom fields in that prompt'
      );
    });

    await test('The schema for a configuration with custom fields', async () => {
      const prompt = buildAnalysisPrompt({
        systemPrompt: 'Analyse.',
        mustHavePrompt: config.mustHavePrompt,
        specialPromptPreDefinedTags: config.specialPromptPreDefinedTags,
        customFieldsJson: CUSTOM_FIELDS,
        useExistingData: 'no',
        restrictToExistingTags: 'no',
        restrictToExistingCorrespondents: 'no',
        usePromptTags: 'no',
      });
      assert.strictEqual(prompt.customFieldsError, null);
      assert.ok(
        prompt.systemPrompt.includes('"field_name": "Due date"'),
        'the template names the field'
      );

      const field = (name) => ({
        type: 'object',
        properties: {
          field_name: { type: 'string', const: name },
          value: { type: ['string', 'null'] },
        },
        required: ['field_name', 'value'],
        additionalProperties: false,
      });
      assert.deepStrictEqual(analysisResponseSchema(prompt), {
        type: 'object',
        properties: {
          title: { type: 'string' },
          correspondent: { type: ['string', 'null'] },
          tags: { type: 'array', items: { type: 'string' } },
          document_type: { type: ['string', 'null'] },
          document_date: { type: ['string', 'null'] },
          language: { type: 'string' },
          custom_fields: {
            type: 'object',
            properties: {
              0: field('Invoice number'),
              1: field('Due date'),
              2: field('Paid'),
            },
            required: ['0', '1', '2'],
            additionalProperties: false,
          },
        },
        required: [
          'title',
          'correspondent',
          'tags',
          'document_type',
          'document_date',
          'language',
          'custom_fields',
        ],
        additionalProperties: false,
      });

      // What the API demands of every object in it.
      eachObjectSchema(analysisResponseSchema(prompt), (object) => {
        assert.strictEqual(object.additionalProperties, false);
        assert.deepStrictEqual(
          object.required || [],
          Object.keys(object.properties)
        );
      });
      const serialized = JSON.stringify(analysisResponseSchema(prompt));
      for (const forbidden of [
        'minimum',
        'maximum',
        'minLength',
        'maxLength',
      ]) {
        assert.ok(!serialized.includes(forbidden), `no ${forbidden}`);
      }

      // An unreadable CUSTOM_FIELDS is reported, and the schema has no fields.
      const broken = buildAnalysisPrompt({
        systemPrompt: 'Analyse.',
        mustHavePrompt: config.mustHavePrompt,
        customFieldsJson: '{"oops":',
      });
      assert.ok(broken.customFieldsError instanceof Error);
      assert.deepStrictEqual(
        analysisResponseSchema(broken).properties.custom_fields,
        { type: 'object', properties: {}, additionalProperties: false }
      );
      const noList = buildAnalysisPrompt({
        systemPrompt: 'Analyse.',
        mustHavePrompt: config.mustHavePrompt,
        customFieldsJson: '{}',
      });
      assert.ok(noList.customFieldsError instanceof Error);
      assert.deepStrictEqual(noList.customFields, []);

      // The configured fields reach the request.
      restore();
      process.env.CUSTOM_FIELDS = CUSTOM_FIELDS;
      useScript({ chunks: [{ text: ANSWER_JSON }] });
      await analyze();
      assert.deepStrictEqual(
        Object.keys(
          fake.last().body.output_config.format.schema.properties.custom_fields
            .properties
        ),
        ['0', '1', '2']
      );
    });

    await test("The prompt builder reproduces customService's system prompt byte for byte", async () => {
      const scenarios = [
        { label: 'plain' },
        { label: 'custom fields', customFields: CUSTOM_FIELDS },
        {
          label: 'USE_EXISTING_DATA without restrictions',
          useExistingData: 'yes',
          customFields: CUSTOM_FIELDS,
        },
        {
          label: 'USE_EXISTING_DATA with a restriction (no pre-existing block)',
          useExistingData: 'yes',
          restrictToExistingTags: 'yes',
        },
        {
          label: 'restriction placeholders',
          systemPrompt:
            'Tags: %RESTRICTED_TAGS%; senders: %RESTRICTED_CORRESPONDENTS%; types: %RESTRICTED_DOCUMENT_TYPES%',
          restrictToExistingTags: 'yes',
        },
        {
          label: 'external API data',
          options: { externalApiData: { project: 'Alpha', budget: 1200 } },
        },
        { label: 'USE_PROMPT_TAGS', usePromptTags: 'yes' },
        {
          label: 'webhook prompt',
          customPrompt: 'Only find the sender.',
          customFields: CUSTOM_FIELDS,
          useExistingData: 'yes',
        },
        { label: 'SYSTEM_PROMPT not set', systemPrompt: null },
      ];

      for (const scenario of scenarios) {
        restore();
        config.useExistingData = scenario.useExistingData || 'no';
        config.restrictToExistingTags = scenario.restrictToExistingTags || 'no';
        config.restrictToExistingCorrespondents = 'no';
        if (scenario.systemPrompt === null) {
          delete process.env.SYSTEM_PROMPT;
        } else if (scenario.systemPrompt) {
          process.env.SYSTEM_PROMPT = scenario.systemPrompt;
        }
        process.env.CUSTOM_FIELDS =
          scenario.customFields || JSON.stringify({ custom_fields: [] });
        process.env.USE_PROMPT_TAGS = scenario.usePromptTags || 'no';
        const args = [
          'Invoice 4711 from Telekom',
          [{ id: 1, name: 'Invoice' }, 'Telephone'],
          ['Telekom', 'Landlord'],
          [{ id: 4, name: 'Invoice' }],
          9,
          scenario.customPrompt || null,
          scenario.options || {},
        ];

        fakeOpenAI.reset();
        useScript({ chunks: [{ text: ANSWER_JSON }] });
        const reference = await quiet(() =>
          customService.analyzeDocument(...args)
        );
        const ours = await quiet(() =>
          anthropicService.analyzeDocument(...args)
        );
        assert.strictEqual(
          reference.error,
          undefined,
          `${scenario.label}: ${reference.error}`
        );
        assert.strictEqual(
          ours.error,
          undefined,
          `${scenario.label}: ${ours.error}`
        );

        const expected = fakeOpenAI.last().body.messages[0];
        assert.strictEqual(expected.role, 'system');
        assert.strictEqual(
          systemText(fake.last().body),
          expected.content,
          `${scenario.label}: the same system prompt`
        );
      }
    });

    // ------------------------------------------------------------ generateText

    await test('generateText: plain and streamed give the same answer, done once, thinking kept out', async () => {
      restore();
      useScript({
        chunks: [
          { thinking: 'weighing the two names', delayMs: 130 },
          { text: 'Rechnung', delayMs: 130 },
          { text: ' und', delayMs: 130 },
          { text: ' Rechnungen', delayMs: 130 },
        ],
        usage: { input_tokens: 40, output_tokens: 33 },
      });

      const plain = await quiet(() => anthropicService.generateText('hello'));
      const seen = recorder();
      const streamed = await quiet(() =>
        anthropicService.generateText('hello', { onProgress: seen.onProgress })
      );

      assert.strictEqual(plain, 'Rechnung und Rechnungen');
      assert.strictEqual(streamed, plain);
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
      assert.strictEqual(seen.last().text, plain);
      assert.strictEqual(
        seen.updates[0].thinking,
        true,
        'the first report was the thinking'
      );
      assert.strictEqual(seen.updates[0].text, '');
      assert.strictEqual(seen.last().thinking, false);
      for (const update of seen.updates) {
        assert.ok(!update.text.includes('weighing'), 'thinking never in text');
      }
      for (let index = 1; index < seen.updates.length; index += 1) {
        assert.ok(
          seen.updates[index].text.startsWith(seen.updates[index - 1].text),
          `report ${index} grew out of the one before it`
        );
      }
      assert.strictEqual(
        seen.last().completionTokens,
        33,
        'the final message decides the count'
      );
    });

    await test('generateText: the usage the caller reads off the service', async () => {
      restore();
      useScript({
        chunks: [{ text: 'twelve chars' }],
        usage: {
          input_tokens: 30,
          output_tokens: 7,
          cache_read_input_tokens: 600,
          cache_creation_input_tokens: 50,
        },
      });

      const { lines } = await captured(() =>
        anthropicService.generateText('hello', { systemPrompt: 'Be brief.' })
      );

      assert.deepStrictEqual(anthropicService.lastGenerateTextUsage, {
        promptTokens: 680,
        completionTokens: 7,
        totalTokens: 687,
        reasoningTokens: null,
        finishReason: 'end_turn',
        answerChars: 12,
        reasoningChars: 0,
        cacheReadTokens: 600,
        cacheWriteTokens: 50,
      });
      assert.ok(
        lines.some(
          (line) =>
            line.level === 'debug' &&
            line.text === '[DEBUG] Anthropic cache: read 600, write 50'
        )
      );
    });

    await test('generateText: model, maxTokens and systemPrompt are honoured, temperature is not sent', async () => {
      restore();
      useScript({ chunks: [{ text: 'ok' }] });

      await quiet(() =>
        anthropicService.generateText('judge these', {
          model: 'claude-opus-5-5',
          maxTokens: 300,
          temperature: 0,
          systemPrompt: 'You are a judge.',
        })
      );

      const body = fake.last().body;
      assert.strictEqual(body.model, 'claude-opus-5-5');
      assert.strictEqual(body.max_tokens, 300);
      assert.strictEqual('temperature' in body, false);
      assert.strictEqual(systemText(body), 'You are a judge.');
      assert.deepStrictEqual(body.messages, [
        { role: 'user', content: 'judge these' },
      ]);

      useScript({ chunks: [{ text: 'ok' }] });
      await quiet(() =>
        anthropicService.generateText('judge these', { maxTokens: null })
      );
      assert.strictEqual(
        fake.last().body.max_tokens,
        16000,
        'without a cap of its own the call gets ANTHROPIC_MAX_TOKENS'
      );
    });

    await test('generateText: a cut-off stream throws with what it managed', async () => {
      restore();
      useScript({
        chunks: [
          { text: '[{"id":"tags:1-2","verdict":"same"},' },
          { text: '{"id":"tags:3-4","verdi' },
        ],
        stopReason: 'max_tokens',
        usage: { input_tokens: 3797, output_tokens: 3200 },
      });
      const seen = recorder();

      await quiet(() =>
        assert.rejects(
          anthropicService.generateText('hello', {
            maxTokens: 3200,
            onProgress: seen.onProgress,
          }),
          (error) => {
            assert.strictEqual(error.code, 'ai_response_truncated');
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
        seen.updates.filter((update) => update.done).length,
        1
      );
      assert.strictEqual(
        anthropicService.lastGenerateTextUsage.completionTokens,
        3200,
        'and what it spent is still readable'
      );

      // Without a handler the same error, with the same prefix.
      useScript({
        chunks: [{ text: 'half an ans' }],
        stopReason: 'max_tokens',
        usage: { output_tokens: 64 },
      });
      await quiet(() =>
        assert.rejects(anthropicService.generateText('hello'), (error) => {
          assert.strictEqual(error.code, 'ai_response_truncated');
          assert.strictEqual(error.partialText, 'half an ans');
          return true;
        })
      );
    });

    await test('generateText: a refusal is ai_refused with what arrived', async () => {
      restore();
      useScript({
        chunks: [{ text: 'I will not' }],
        stopReason: 'refusal',
        stopDetails: { category: 'bio' },
      });

      await quiet(() =>
        assert.rejects(anthropicService.generateText('hello'), (error) => {
          assert.strictEqual(error.code, 'ai_refused');
          assert.match(error.message, /bio/);
          assert.strictEqual(error.partialText, 'I will not');
          return true;
        })
      );
    });

    await test('An abort mid-stream is an AbortError with what arrived, and the server sees it', async () => {
      restore();
      useScript({
        chunks: [
          { text: 'first piece', delayMs: 40 },
          { text: ' second piece', delayMs: 300 },
          { text: ' third piece', delayMs: 300 },
        ],
      });
      const controller = new AbortController();
      const seen = recorder();

      await quiet(() =>
        assert.rejects(
          anthropicService.generateText('hello', {
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
      assert.strictEqual(
        seen.updates.filter((update) => update.done).length,
        1
      );
      const request = await fake.last().whenClosed;
      assert.strictEqual(
        request.aborted,
        true,
        'the fake saw the connection go before it had finished writing'
      );
    });

    await test('An abort before the request is an AbortError too', async () => {
      restore();
      useScript({ chunks: [{ text: 'never sent' }] });
      const controller = new AbortController();
      controller.abort();

      await quiet(() =>
        assert.rejects(
          anthropicService.generateText('hello', { signal: controller.signal }),
          (error) => {
            assert.strictEqual(error.name, 'AbortError');
            assert.strictEqual(error.code, 'ai_request_aborted');
            assert.strictEqual(error.partialText, '');
            return true;
          }
        )
      );
    });

    // ------------------------------------------------------------ checkStatus

    await test('checkStatus: ok without spending tokens, clear errors otherwise', async () => {
      restore();
      fake.reset();

      const ok = await quiet(() => anthropicService.checkStatus());
      assert.deepStrictEqual(ok, { status: 'ok', model: 'claude-haiku-5-5' });
      assert.deepStrictEqual(
        fake.requests.map((record) => `${record.method} ${record.path}`),
        ['GET /v1/models/claude-haiku-5-5'],
        'one models lookup, no message'
      );

      config.anthropic.model = 'claude-nonexistent-1';
      const missing = await quiet(() => anthropicService.checkStatus());
      assert.strictEqual(missing.status, 'error');
      assert.match(missing.error, /claude-nonexistent-1/);
      assert.match(missing.error, /not found/);

      config.anthropic.model = defaults.anthropic.model;
      fake.setApiKey('sk-ant-other');
      const rejected = await quiet(() => anthropicService.checkStatus());
      assert.strictEqual(rejected.status, 'error');
      assert.match(rejected.error, /key was rejected/);
      fake.setApiKey(null);
    });

    // ------------------------------------------------------------- the rest

    await test('The Claude token estimate is three characters a token; other models keep theirs', async () => {
      const text = 'x'.repeat(300);
      assert.strictEqual(
        await quiet(() => calculateTokens(text, 'claude-haiku-5-5')),
        100
      );
      assert.strictEqual(
        await quiet(() => calculateTokens(text, 'Claude-Opus-5-5')),
        100
      );
      assert.strictEqual(
        await quiet(() => calculateTokens(text, 'llama3.1:8b')),
        75,
        'every other estimated model stays at four characters a token'
      );

      const words = 'word '.repeat(200);
      const forClaude = await quiet(() =>
        truncateToTokenLimit(words, 50, 'claude-haiku-5-5')
      );
      assert.ok(forClaude.length <= 150, `cut to ${forClaude.length} chars`);
      assert.ok(forClaude.length >= 120, 'at a word boundary near the limit');
      assert.ok(!forClaude.endsWith(' '));
      const forLlama = await quiet(() =>
        truncateToTokenLimit(words, 50, 'llama3.1:8b')
      );
      assert.ok(forLlama.length > 150 && forLlama.length <= 200);
      assert.strictEqual(
        await quiet(() =>
          truncateToTokenLimit('short', 50, 'claude-haiku-5-5')
        ),
        'short'
      );
    });

    await test('The Duplicates review names the Anthropic model', async () => {
      restore();
      const entityMatchAiService = require('../services/entityMatchAiService');
      assert.strictEqual(config.aiProvider, 'anthropic');
      assert.strictEqual(entityMatchAiService.modelName(), 'claude-haiku-5-5');
    });

    await test('An analysis that times out reports the AI timeout', async () => {
      restore();
      useScript({ responseDelayMs: 600, chunks: [{ text: ANSWER_JSON }] });
      const client = anthropicService.client;
      anthropicService.client = createAnthropicClient({
        apiKey: 'sk-ant-test',
        apiUrl: fake.url,
        timeoutMs: 100,
      });
      // One attempt: the SDK retries a timeout twice by default.
      anthropicService.client.maxRetries = 0;
      try {
        const result = await analyze();
        assert.strictEqual(result.error, buildTimeoutErrorMessage('AI'));
        assert.deepStrictEqual(result.document, {
          tags: [],
          correspondent: null,
        });
      } finally {
        anthropicService.client = client;
      }
    });

    await test('Without a key the analysis fails softly and generateText throws', async () => {
      restore();
      const client = anthropicService.client;
      anthropicService.client = null;
      config.anthropic.apiKey = '';
      try {
        const result = await analyze();
        assert.match(result.error, /not initialized/);
        assert.deepStrictEqual(result.document, {
          tags: [],
          correspondent: null,
        });
        await quiet(() =>
          assert.rejects(
            anthropicService.generateText('hello'),
            /not initialized/
          )
        );
        const status = await quiet(() => anthropicService.checkStatus());
        assert.strictEqual(status.status, 'error');
      } finally {
        anthropicService.client = client;
        config.anthropic.apiKey = defaults.anthropic.apiKey;
      }
    });
  } finally {
    restore();
    await fake.close();
    await fakeOpenAI.close();
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
