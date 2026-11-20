'use strict';

/**
 * The external API data (EXTERNAL_API_*), from the user's endpoint to the
 * prompt of every provider.
 *
 * Two things were wrong and neither showed on the page:
 *
 * - With Ollama the prompt carried "[object Promise]" instead of the data:
 *   ollamaService._buildPrompt() called the async validator without awaiting
 *   it, while analyzeDocument() awaited the same validator and threw its
 *   result away.
 * - EXTERNAL_API_TRANSFORM was never applied: config exposes the value as
 *   `transformationTemplate`, the service read `transform`, so the whole
 *   answer always went into the prompt.
 *
 * Runs offline against real HTTP servers on 127.0.0.1: a fake endpoint that
 * stands in for the user's API, and the fakes of Ollama, an OpenAI-compatible
 * server and the Claude API from tests/helpers. A scan runs for real on top
 * of faked Paperless-ngx and database modules, with the real AI service
 * factory, so what is counted is what the user's endpoint sees and what is
 * read is what each provider receives.
 *
 * The SSRF guard refuses loopback addresses on purpose, and that is pinned by
 * tests/test-external-api-ssrf-block.js. Here the guard runs with loopback
 * allowed, because the fake endpoint has to live on 127.0.0.1.
 *
 * Cases:
 *   1. EXTERNAL_API_TRANSFORM picks a part of the answer: dots, [n], a top-level list
 *   2. a value the path finds that is false or a number still reaches the prompt
 *   3. a path that matches nothing, an empty value, JavaScript and a path of
 *      more than ten steps give the whole answer
 *   4. __proto__, constructor and prototype never resolve, own key or not
 *   5. a 500, a timeout and a closed port give null after one request each
 *   6. a scan over three documents calls the endpoint once and every
 *      provider (openai, azure, custom, ollama, anthropic) puts the same
 *      block into each of the three prompts; Ollama's carries no "[object Promise]"
 *   7. a scan against a failing endpoint calls it once and analyses all
 *      three documents without the data
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createFakeOllama } = require('./helpers/fake-ollama');
const { createFakeOpenAI } = require('./helpers/fake-openai');
const { createFakeAnthropic } = require('./helpers/fake-anthropic');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  [FAIL] ${name}: ${error.message}`);
  }
}

/** Runs a body with the services' chatter swallowed; warnings are kept. */
async function quiet(fn) {
  const real = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  const warnings = [];
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  console.warn = (...args) => warnings.push(args.join(' '));
  console.error = (...args) => warnings.push(args.join(' '));
  try {
    const value = await fn();
    return { value, warnings };
  } finally {
    Object.assign(console, real);
  }
}

function inject(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

// ── The user's endpoint ─────────────────────────────────────────────────────

/*
 * Raw text, not JSON.stringify(): JSON.parse turns a "__proto__" key into an
 * own property, which is exactly what an answer from someone else's server
 * can contain.
 */
const RATES_BODY = `{
  "base": "EUR",
  "rates": [
    { "code": "USD", "value": 1.08 },
    { "code": "CHF", "value": 0 }
  ],
  "meta": { "source": "ECB", "holiday": false, "note": null },
  "__proto__": { "polluted": true }
}`;
const RATES = JSON.parse(RATES_BODY);

/** What a prompt carries when the whole answer goes in. */
const WHOLE_BLOCK = `Additional context from external API:\n${JSON.stringify(
  RATES,
  null,
  2
)}`;

async function createFakeEndpoint() {
  const hits = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const route = String(request.url || '').split('?')[0];
    hits.push(route);
    if (route === '/rates') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(RATES_BODY);
      return;
    }
    if (route === '/list') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify([{ name: 'first' }, { name: 'second' }]));
      return;
    }
    if (route === '/fail') {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'down for maintenance' }));
      return;
    }
    if (route === '/slow') {
      // Never answers; the client's timeout has to end it.
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: (route) => `http://127.0.0.1:${port}${route}`,
    hits,
    count: (route) => hits.filter((hit) => hit === route).length,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A port nothing listens on. */
async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ── Paperless-ngx and the database, faked ───────────────────────────────────

const DOCUMENTS = [
  { id: 101, title: 'Invoice 101' },
  { id: 102, title: 'Invoice 102' },
  { id: 103, title: 'Invoice 103' },
];
const TEXT = 'Invoice for the phone line, September, 39.95 EUR. '.repeat(3);

const ANSWER_JSON = JSON.stringify({
  title: 'Phone bill',
  correspondent: 'Telekom',
  tags: ['Invoice'],
  document_type: 'Invoice',
  document_date: '2026-09-03',
  language: 'en',
  custom_fields: {},
});

const saved = [];

const FAKES = {
  '../models/document': {
    isDocumentProcessed: async () => false,
    isDocumentIgnored: async () => false,
    isDocumentFailed: async () => false,
    setProcessingStatus: async () => {},
    addFailedDocument: async () => {},
    addToOcrQueue: async () => false,
    getOcrQueueItem: async () => null,
    getOcrQueueDocumentIds: async () => [],
  },
  '../services/paperlessService': {
    checkConnection: async () => ({
      reachable: true,
      authorized: true,
      error: null,
    }),
    getAllDocuments: async () => DOCUMENTS,
    getPermissionOfDocument: async () => true,
    getDocumentContent: async () => TEXT,
    getDocument: async (id) => ({ id, title: `Invoice ${id}`, page_count: 1 }),
    getTags: async () => [{ id: 1, name: 'Invoice' }],
    listCorrespondentsNames: async () => [{ id: 2, name: 'Telekom' }],
    listDocumentTypesNames: async () => [{ id: 3, name: 'Invoice' }],
    getThumbnailImage: async () => Buffer.from('png'),
  },
  '../services/mistralOcrService': {
    isEnabled: () => false,
    isDocumentActivelyProcessing: () => false,
  },
  '../services/skipRuleService': { apply: async () => null },
  '../services/documentProcessingService': {
    buildUpdateData: async () => ({ title: 'Phone bill' }),
    saveDocumentChanges: async (id, updateData, analysis) => {
      saved.push({ id, analysis });
    },
  },
  // The run end tells the OCR drain what it queued; nothing here queues.
  '../services/ocrAutoProcessService': { running: false, afterRun: () => null },
  '../services/duplicateReviewJobService': { isRunning: () => false },
  '../services/duplicateMergeService': { isWriting: () => false },
  '../services/scanHealthService': {
    RUN_STATUS: {
      OK: 'ok',
      PAPERLESS_UNREACHABLE: 'paperless_unreachable',
      ERROR: 'error',
    },
    recordRunStart: () => {},
    recordConnectivity: () => {},
    recordRunResult: () => {},
  },
  '../services/dashboardStatsService': {
    invalidate: () => {},
    refresh: async () => {},
  },
  '../services/setupService': { isConfigured: async () => true },
  '../services/thumbnailCache': {
    removeThumbnailCacheForDocumentIds: async () => {},
  },
};

/** Every string in a request body, joined: the prompt as the model reads it. */
function promptText(body) {
  const strings = [];
  const walk = (value) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(body);
  return strings.join('\n');
}

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-external-api-'));
  process.chdir(tempRoot);
  // Every provider caches a thumbnail before its analysis; with one in place
  // none of them asks Paperless-ngx.
  fs.mkdirSync(path.join(tempRoot, 'data', 'thumb-cache'), {
    recursive: true,
  });
  for (const doc of DOCUMENTS) {
    fs.writeFileSync(
      path.join(tempRoot, 'data', 'thumb-cache', `${doc.id}.png`),
      'png'
    );
  }

  const endpoint = await createFakeEndpoint();
  const ollama = await createFakeOllama({
    chunks: [{ response: ANSWER_JSON }],
  });
  const openai = await createFakeOpenAI({
    chunks: [{ content: ANSWER_JSON }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const anthropic = await createFakeAnthropic({
    chunks: [{ text: ANSWER_JSON }],
  });

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    PAPERLESS_API_URL: 'http://127.0.0.1:9',
    PAPERLESS_API_TOKEN: 'test-token',
    SYSTEM_PROMPT: 'Tag the document.',
    CUSTOM_FIELDS: JSON.stringify({ custom_fields: [] }),
    USE_PROMPT_TAGS: 'no',
    USE_EXISTING_DATA: 'no',
    RESPONSE_TOKENS: '1000',
    TOKEN_LIMIT: '128000',
    MIN_CONTENT_LENGTH: '10',
    AI_PROVIDER: 'ollama',
    OLLAMA_API_URL: ollama.url,
    OLLAMA_MODEL: 'llama3.2',
    OPENAI_API_KEY: 'sk-openai-test',
    OPENAI_MODEL: 'gpt-4o-mini',
    // The OpenAI SDK reads this when no baseURL is passed.
    OPENAI_BASE_URL: openai.baseURL,
    AZURE_ENDPOINT: openai.url,
    AZURE_API_KEY: 'azure-test-key',
    AZURE_DEPLOYMENT_NAME: 'gpt-4o-mini',
    AZURE_API_VERSION: '2024-10-21',
    CUSTOM_BASE_URL: openai.baseURL,
    CUSTOM_API_KEY: 'sk-custom-test',
    CUSTOM_MODEL: 'llama3.2',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    ANTHROPIC_API_URL: anthropic.url,
    EXTERNAL_API_ENABLED: 'yes',
    EXTERNAL_API_URL: endpoint.url('/rates'),
    EXTERNAL_API_METHOD: 'GET',
    EXTERNAL_API_HEADERS: '{}',
    EXTERNAL_API_BODY: '{}',
    EXTERNAL_API_TIMEOUT: '2000',
    EXTERNAL_API_TRANSFORM: '',
    EXTERNAL_API_ALLOW_PRIVATE_IPS: 'yes',
  });
  for (const key of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_EFFORT',
    'ANTHROPIC_MAX_TOKENS',
    'OLLAMA_THINK',
    'CONTENT_MAX_LENGTH',
    'PROCESS_PREDEFINED_DOCUMENTS',
  ]) {
    delete process.env[key];
  }

  for (const [request, exports] of Object.entries(FAKES)) {
    const resolved = require.resolve(request);
    delete require.cache[resolved];
    inject(resolved, exports);
  }

  // Loopback allowed for the fake endpoint; everything else the guard checks
  // still runs. externalApiService takes the function when it loads.
  const serviceUtils = require('../services/serviceUtils');
  const realValidateApiUrl = serviceUtils.validateApiUrl;
  serviceUtils.validateApiUrl = (url, options = {}) =>
    realValidateApiUrl(url, { ...options, allowLocalhost: true });

  const externalApiService = require('../services/externalApiService');
  const scanService = require('../services/scanService');

  /** fetchData() with a transform, quietly. */
  const fetchWith = async (transform, route = '/rates') => {
    process.env.EXTERNAL_API_URL = endpoint.url(route);
    process.env.EXTERNAL_API_TRANSFORM = transform;
    return quiet(() => externalApiService.fetchData());
  };

  try {
    console.log('\n=== External API data ===');

    // ── 1. the transform picks a part ──────────────────────────────────────

    await test('EXTERNAL_API_TRANSFORM picks a part of the answer', async () => {
      assert.strictEqual((await fetchWith('meta.source')).value, 'ECB');
      assert.deepStrictEqual((await fetchWith('rates[0]')).value, {
        code: 'USD',
        value: 1.08,
      });
      assert.strictEqual((await fetchWith('rates[0].code')).value, 'USD');
      assert.deepStrictEqual((await fetchWith('meta')).value, RATES.meta);
      assert.strictEqual(
        (await fetchWith('  rates[0].code  ')).value,
        'USD',
        'spaces around the path do not count'
      );
      assert.strictEqual(
        (await fetchWith('[1].name', '/list')).value,
        'second',
        'an answer that is a list starts with an index'
      );
    });

    // ── 2. falsy values the path finds ─────────────────────────────────────

    await test('a value the path finds that is false, 0 or a number reaches the prompt as text', async () => {
      assert.strictEqual((await fetchWith('meta.holiday')).value, 'false');
      assert.strictEqual((await fetchWith('rates[1].value')).value, '0');
      assert.strictEqual((await fetchWith('rates[0].value')).value, '1.08');
      assert.strictEqual(
        (await fetchWith('meta.note')).value,
        null,
        'a null the path finds adds nothing'
      );
    });

    // ── 3. no match, empty, code ───────────────────────────────────────────

    await test('a path that matches nothing gives the whole answer and says so in the log', async () => {
      for (const transform of [
        'rates[5].value',
        'meta.missing',
        'base.length.x',
        'rates.code',
      ]) {
        const { value, warnings } = await fetchWith(transform);
        assert.deepStrictEqual(value, RATES, transform);
        assert.ok(
          warnings.some((line) => line.includes('matches nothing')),
          `${transform}: ${warnings.join(' | ')}`
        );
      }
    });

    await test('an empty transform gives the whole answer without a warning', async () => {
      const { value, warnings } = await fetchWith('');
      assert.deepStrictEqual(value, RATES);
      assert.deepStrictEqual(warnings, []);
    });

    await test('JavaScript is not run: the old default and a return statement give the whole answer', async () => {
      const oldDefault =
        '// Function to transform API response\n// Return the data you want to include in the prompt\nfunction transform(data) {\n  return data;\n}';
      for (const transform of [
        oldDefault,
        'return data.base;',
        'data.rates.map(r => r.code)',
        'meta["source"]',
      ]) {
        const { value, warnings } = await fetchWith(transform);
        assert.deepStrictEqual(value, RATES, transform);
        assert.ok(
          warnings.some((line) => line.includes('not a path')),
          `${transform}: ${warnings.join(' | ')}`
        );
      }
    });

    // ── 4. prototype keys ──────────────────────────────────────────────────

    await test('__proto__, constructor and prototype never resolve', async () => {
      for (const transform of [
        '__proto__',
        '__proto__.polluted',
        'constructor',
        'constructor.prototype',
        'rates.constructor',
        'rates[0].__proto__',
        'meta.prototype',
        'meta.toString',
        'rates.length.constructor',
      ]) {
        const { value, warnings } = await fetchWith(transform);
        assert.deepStrictEqual(value, RATES, transform);
        assert.ok(
          warnings.some((line) => line.includes('matches nothing')),
          `${transform} is a path that resolves to nothing: ${warnings.join(' | ')}`
        );
      }
      assert.strictEqual({}.polluted, undefined, 'Object.prototype untouched');
    });

    await test('a path of more than ten steps gives the whole answer', async () => {
      const { value, warnings } = await fetchWith('a.b.c.d.e.f.g.h.i.j.k');
      assert.deepStrictEqual(value, RATES);
      assert.ok(warnings.some((line) => line.includes('more than 10 steps')));
    });

    // ── 5. a failing endpoint ──────────────────────────────────────────────

    await test('a 500, a timeout and a closed port give null after one request each', async () => {
      process.env.EXTERNAL_API_TRANSFORM = '';

      process.env.EXTERNAL_API_URL = endpoint.url('/fail');
      assert.strictEqual(
        (await quiet(() => externalApiService.fetchData())).value,
        null
      );
      assert.strictEqual(endpoint.count('/fail'), 1);

      process.env.EXTERNAL_API_URL = endpoint.url('/slow');
      process.env.EXTERNAL_API_TIMEOUT = '300';
      const started = Date.now();
      assert.strictEqual(
        (await quiet(() => externalApiService.fetchData())).value,
        null
      );
      assert.ok(Date.now() - started < 1500, 'the timeout ended the call');
      assert.strictEqual(endpoint.count('/slow'), 1);
      process.env.EXTERNAL_API_TIMEOUT = '2000';

      process.env.EXTERNAL_API_URL = `http://127.0.0.1:${await closedPort()}/rates`;
      assert.strictEqual(
        (await quiet(() => externalApiService.fetchData())).value,
        null
      );
    });

    // ── 6. one call per scan, the same block for every provider ────────────

    const providers = [
      {
        id: 'openai',
        prompts: () =>
          openai.requests
            .filter((record) => Array.isArray(record.body?.messages))
            .map((record) => promptText(record.body.messages)),
      },
      {
        id: 'azure',
        prompts: () =>
          openai.requests
            .filter((record) => Array.isArray(record.body?.messages))
            .map((record) => promptText(record.body.messages)),
      },
      {
        id: 'custom',
        prompts: () =>
          openai.requests
            .filter((record) => Array.isArray(record.body?.messages))
            .map((record) => promptText(record.body.messages)),
      },
      {
        id: 'ollama',
        prompts: () =>
          ollama.requests
            .filter((record) => record.path === '/api/generate')
            .map((record) => promptText(record.body)),
      },
      {
        id: 'anthropic',
        prompts: () =>
          anthropic
            .messageRequests()
            .map((record) =>
              promptText([record.body.system, record.body.messages])
            ),
      },
    ];

    /** One scan with AI_PROVIDER set; the fakes forget what came before. */
    const scanWith = async (providerId) => {
      process.env.AI_PROVIDER = providerId;
      ollama.reset();
      openai.reset();
      anthropic.reset();
      saved.length = 0;
      const before = endpoint.hits.length;
      await quiet(() => scanService.scanDocuments('scheduler'));
      return endpoint.hits.slice(before);
    };

    for (const provider of providers) {
      await test(`${provider.id}: one call per scan, the data in all three prompts`, async () => {
        process.env.EXTERNAL_API_URL = endpoint.url('/rates');
        process.env.EXTERNAL_API_TRANSFORM = '';

        const hits = await scanWith(provider.id);
        assert.deepStrictEqual(
          hits,
          ['/rates'],
          'one call for three documents'
        );
        assert.strictEqual(saved.length, 3, 'three documents written back');
        saved.forEach(({ analysis }) =>
          assert.strictEqual(analysis.error, undefined, analysis.error)
        );

        const prompts = provider.prompts();
        assert.strictEqual(prompts.length, 3, 'three analyses');
        prompts.forEach((prompt, index) => {
          assert.ok(
            !prompt.includes('[object Promise]'),
            `prompt ${index + 1} carries [object Promise]`
          );
          assert.ok(
            prompt.includes(WHOLE_BLOCK),
            `prompt ${index + 1} lacks the data:\n${prompt.slice(-600)}`
          );
        });
      });
    }

    await test('ollama: the transformed part is what the prompt carries', async () => {
      process.env.EXTERNAL_API_URL = endpoint.url('/rates');
      process.env.EXTERNAL_API_TRANSFORM = 'rates[0]';
      const hits = await scanWith('ollama');
      assert.deepStrictEqual(hits, ['/rates']);
      const block = `Additional context from external API:\n${JSON.stringify(
        RATES.rates[0],
        null,
        2
      )}`;
      for (const prompt of providers
        .find((provider) => provider.id === 'ollama')
        .prompts()) {
        assert.ok(prompt.includes(block), prompt.slice(-400));
        assert.ok(
          !prompt.includes('"ECB"'),
          'the rest of the answer stays out'
        );
      }
      process.env.EXTERNAL_API_TRANSFORM = '';
    });

    // ── 7. a failing endpoint does not stop the scan ───────────────────────

    await test('a failing endpoint is called once per scan and the analyses run without it', async () => {
      process.env.EXTERNAL_API_URL = endpoint.url('/fail');
      const hits = await scanWith('ollama');
      assert.deepStrictEqual(hits, ['/fail'], 'no retry per document');
      assert.strictEqual(saved.length, 3, 'all three written back');
      const prompts = providers
        .find((provider) => provider.id === 'ollama')
        .prompts();
      assert.strictEqual(prompts.length, 3);
      prompts.forEach((prompt) =>
        assert.ok(!prompt.includes('Additional context from external API'))
      );
    });
  } finally {
    serviceUtils.validateApiUrl = realValidateApiUrl;
    await endpoint.close();
    await ollama.close();
    await openai.close();
    await anthropic.close();
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[FAIL] External API data test crashed:', error);
  process.exitCode = 1;
});
