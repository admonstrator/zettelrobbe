'use strict';

/**
 * One OpenAI-compatible service for OpenAI, Azure and the custom provider
 * (services/openaiCompatibleService.js), with every request shaped by
 * resolveRules() in services/aiProviderRules.js.
 *
 * The service talks to tests/helpers/fake-openai.js through the real SDK and
 * builds its clients from the configuration, as in production: no client is
 * injected, so what is asserted is the request a configured installation
 * puts on the wire.
 *
 * Cases:
 *   1. the old module paths and the factory hand out the same instances
 *   2. gpt-4o-mini carries temperature, and max_tokens when a cap applies
 *   3. gpt-5-mini carries max_completion_tokens, reasoning_effort 'minimal'
 *      with reasoning off, and no temperature
 *   4. o3-mini on Azure goes to the deployment path with api-version and
 *      the api-key header, without temperature
 *   5. qwen3:8b on custom with reasoning off carries enable_thinking false
 *      and the /no_think line
 *   6. gpt-oss on custom carries reasoning_effort 'low'
 *   7. a model override changes the model field and the rules with it
 *   8. streamed and plain give the same text, on all three providers
 *   9. a changed key or URL reaches the next request without a restart
 *  10. the analysis: same prompt, same parse, same result shape; the
 *      temperature follows the rules and the configured value
 *  11. checkStatus keeps its shape on all three
 *  12. a provider that is not selected has no client
 */

const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

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
  const real = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    debug: console.debug,
  };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, real);
  }
}

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-oai-compat-'));
  process.chdir(tempRoot);
  // The analysis caches a thumbnail first; this one is already there.
  await fs.mkdir(path.join(tempRoot, 'data', 'thumb-cache'), {
    recursive: true,
  });
  await fs.writeFile(path.join(tempRoot, 'data', 'thumb-cache', '1.png'), '');

  const fake = await createFakeOpenAI();
  const otherFake = await createFakeOpenAI();

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    PAPERLESS_API_URL: 'http://127.0.0.1:9',
    PAPERLESS_API_TOKEN: 'test-token',
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-openai-test',
    OPENAI_MODEL: 'gpt-4o-mini',
    // The OpenAI SDK reads this when no baseURL is passed.
    OPENAI_BASE_URL: fake.baseURL,
    CUSTOM_BASE_URL: fake.baseURL,
    CUSTOM_API_KEY: 'sk-custom-test',
    CUSTOM_MODEL: 'qwen3:8b',
    AZURE_ENDPOINT: fake.url,
    AZURE_API_KEY: 'azure-test-key',
    AZURE_DEPLOYMENT_NAME: 'o3-mini',
    AZURE_API_VERSION: '2024-10-21',
    CUSTOM_FIELDS: JSON.stringify({ custom_fields: [] }),
    SYSTEM_PROMPT: 'Tag the document.',
    USE_PROMPT_TAGS: 'no',
    RESPONSE_TOKENS: '1000',
    TOKEN_LIMIT: '128000',
  });

  const config = require('../config/config');
  const openaiService = require('../services/openaiService');
  const azureService = require('../services/azureService');
  const customService = require('../services/customService');
  const AIServiceFactory = require('../services/aiServiceFactory');
  const {
    OpenAICompatibleService,
    forProvider,
  } = require('../services/openaiCompatibleService');

  /**
   * Sets a configuration value the way a save does: in process.env and in
   * the config object, so the test holds whether config reads env live or
   * keeps a snapshot.
   */
  const setConfig = (block, field, envKey, value) => {
    process.env[envKey] = value;
    try {
      if (block) config[block][field] = value;
      else config[field] = value;
    } catch {
      // A read-only live getter already sees the environment.
    }
  };
  const selectProvider = (id) =>
    setConfig(null, 'aiProvider', 'AI_PROVIDER', id);

  const defaults = {
    aiProvider: config.aiProvider,
    openaiModel: process.env.OPENAI_MODEL,
    customModel: config.custom.model,
    customKey: config.custom.apiKey,
    customUrl: config.custom.apiUrl,
  };

  /** One plain generateText() against the fake; returns the recorded call. */
  const call = async (service, options = {}, prompt = 'judge this') => {
    fake.reset();
    await quiet(() => service.generateText(prompt, options));
    return fake.last();
  };

  try {
    fake.setScript({
      chunks: [{ content: 'ok' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });

    await test('The old module paths and the factory hand out the same instances', async () => {
      assert.ok(openaiService instanceof OpenAICompatibleService);
      assert.ok(azureService instanceof OpenAICompatibleService);
      assert.ok(customService instanceof OpenAICompatibleService);
      assert.strictEqual(forProvider('openai'), openaiService);
      assert.strictEqual(forProvider('azure'), azureService);
      assert.strictEqual(forProvider('custom'), customService);
      for (const [id, service] of [
        ['openai', openaiService],
        ['azure', azureService],
        ['custom', customService],
        ['nonsense', openaiService],
      ]) {
        selectProvider(id);
        assert.strictEqual(AIServiceFactory.getService(), service, id);
      }
      selectProvider('ollama');
      assert.strictEqual(
        AIServiceFactory.getService(),
        require('../services/ollamaService')
      );
      selectProvider('anthropic');
      assert.strictEqual(
        AIServiceFactory.getService(),
        require('../services/anthropicService')
      );
      for (const service of [openaiService, azureService, customService]) {
        for (const method of [
          'initialize',
          'analyzeDocument',
          'generateText',
          'checkStatus',
          '_validateAndTruncateExternalApiData',
        ]) {
          assert.strictEqual(typeof service[method], 'function', method);
        }
      }
      assert.throws(() => forProvider('ollama'), /does not speak/);
    });

    await test('gpt-4o-mini carries temperature, and max_tokens when a cap applies', async () => {
      selectProvider('openai');
      let { body } = await call(openaiService, { maxTokens: 300 });
      assert.strictEqual(body.model, 'gpt-4o-mini');
      assert.strictEqual(body.temperature, config.aiTemperatureGeneration);
      assert.strictEqual(body.max_tokens, 300);
      assert.strictEqual('max_completion_tokens' in body, false);

      // OpenAI has never been sent a cap the caller did not ask for.
      ({ body } = await call(openaiService));
      assert.strictEqual('max_tokens' in body, false);
      assert.strictEqual(body.temperature, config.aiTemperatureGeneration);

      ({ body } = await call(openaiService, { temperature: 0 }));
      assert.strictEqual(body.temperature, 0, 'zero is a value');
    });

    await test('gpt-5-mini carries max_completion_tokens and minimal effort, no temperature', async () => {
      selectProvider('openai');
      const { body } = await call(openaiService, {
        model: 'gpt-5-mini',
        reasoning: false,
        maxTokens: 400,
        temperature: 0,
      });
      assert.strictEqual(body.model, 'gpt-5-mini');
      assert.strictEqual(body.max_completion_tokens, 400);
      assert.strictEqual('max_tokens' in body, false, 'max_tokens is a 400');
      assert.strictEqual(body.reasoning_effort, 'minimal');
      assert.strictEqual('temperature' in body, false);
      assert.strictEqual('chat_template_kwargs' in body, false);
    });

    await test('o3-mini on Azure goes to the deployment with api-version', async () => {
      selectProvider('azure');
      const record = await call(azureService, { reasoning: false });
      assert.strictEqual(
        record.path,
        '/openai/deployments/o3-mini/chat/completions'
      );
      assert.strictEqual(record.query['api-version'], '2024-10-21');
      assert.strictEqual(record.headers['api-key'], 'azure-test-key');
      assert.strictEqual(record.body.model, 'o3-mini');
      assert.strictEqual('temperature' in record.body, false);
      assert.strictEqual(
        record.body.max_completion_tokens,
        Number(config.responseTokens),
        'Azure caps at RESPONSE_TOKENS, under the name the model takes'
      );
      assert.strictEqual('max_tokens' in record.body, false);
      assert.strictEqual(record.body.reasoning_effort, 'low');

      const plain = await call(azureService, { model: 'gpt-4o-prod' });
      assert.strictEqual(
        plain.path,
        '/openai/deployments/gpt-4o-prod/chat/completions',
        'a model override addresses another deployment'
      );
      assert.strictEqual(
        plain.body.temperature,
        config.aiTemperatureGeneration,
        'the configured temperature, not a hard-coded 0.7'
      );
      assert.strictEqual(plain.body.max_tokens, Number(config.responseTokens));
    });

    await test('qwen3:8b on custom with reasoning off switches thinking off twice', async () => {
      selectProvider('custom');
      setConfig('custom', 'model', 'CUSTOM_MODEL', 'qwen3:8b');
      const { body, path: requestPath } = await call(customService, {
        reasoning: false,
      });
      assert.strictEqual(requestPath, '/v1/chat/completions');
      assert.strictEqual(body.model, 'qwen3:8b');
      assert.strictEqual(body.chat_template_kwargs.enable_thinking, false);
      assert.strictEqual(
        body.messages[body.messages.length - 1].content,
        'judge this\n/no_think'
      );
      assert.strictEqual('reasoning_effort' in body, false);
      assert.strictEqual(body.max_tokens, Number(config.responseTokens));
      assert.strictEqual(body.temperature, config.aiTemperatureGeneration);
    });

    await test('gpt-oss on custom carries reasoning_effort low', async () => {
      selectProvider('custom');
      const { body } = await call(customService, {
        model: 'openai/gpt-oss-20b',
        reasoning: false,
      });
      assert.strictEqual(body.reasoning_effort, 'low');
      assert.deepStrictEqual(body.chat_template_kwargs, {
        enable_thinking: false,
      });
      assert.strictEqual(
        body.messages[body.messages.length - 1].content,
        'judge this',
        'the soft switch is a Qwen dialect'
      );
    });

    await test('A model override changes the model field and the rules with it', async () => {
      selectProvider('openai');
      const plain = await call(openaiService, { reasoning: false });
      assert.strictEqual(plain.body.model, 'gpt-4o-mini');
      assert.strictEqual('reasoning_effort' in plain.body, false);
      const override = await call(openaiService, {
        model: 'o4-mini',
        reasoning: false,
      });
      assert.strictEqual(override.body.model, 'o4-mini');
      assert.strictEqual(override.body.reasoning_effort, 'low');
      assert.strictEqual('temperature' in override.body, false);
    });

    await test('Streamed and plain give the same text, on all three providers', async () => {
      fake.setScript({
        chunks: [
          { content: 'Yes, ' },
          { content: '<think>weighing it</think>' },
          { content: 'the same entity' },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
      });
      for (const [id, service] of [
        ['openai', openaiService],
        ['azure', azureService],
        ['custom', customService],
      ]) {
        selectProvider(id);
        const plain = await quiet(() => service.generateText('judge this'));
        const updates = [];
        const streamed = await quiet(() =>
          service.generateText('judge this', {
            onProgress: (update) => updates.push(update),
          })
        );
        assert.strictEqual(plain, 'Yes, the same entity', id);
        assert.strictEqual(streamed, plain, id);
        assert.strictEqual(fake.last().body.stream, true, id);
        assert.strictEqual(updates[updates.length - 1].done, true, id);
        assert.strictEqual(service.lastGenerateTextUsage.completionTokens, 6);
      }
      fake.setScript({
        chunks: [{ content: 'ok' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    });

    await test('A changed key or URL reaches the next request without a restart', async () => {
      selectProvider('custom');
      let record = await call(customService);
      assert.strictEqual(record.headers.authorization, 'Bearer sk-custom-test');

      setConfig('custom', 'apiKey', 'CUSTOM_API_KEY', 'sk-custom-rotated');
      record = await call(customService);
      assert.strictEqual(
        record.headers.authorization,
        'Bearer sk-custom-rotated'
      );

      otherFake.setScript({ chunks: [{ content: 'moved' }] });
      otherFake.reset();
      setConfig('custom', 'apiUrl', 'CUSTOM_BASE_URL', otherFake.baseURL);
      const answer = await quiet(() => customService.generateText('hello'));
      assert.strictEqual(answer, 'moved');
      assert.strictEqual(otherFake.requests.length, 1);

      // An assigned client wins until it is taken back.
      const assigned = customService.client;
      setConfig('custom', 'apiUrl', 'CUSTOM_BASE_URL', fake.baseURL);
      customService.client = assigned;
      otherFake.reset();
      await quiet(() => customService.generateText('hello'));
      assert.strictEqual(otherFake.requests.length, 1, 'assigned client used');
      customService.client = null;
      record = await call(customService);
      assert.ok(record, 'back on the configured endpoint');

      setConfig('custom', 'apiKey', 'CUSTOM_API_KEY', defaults.customKey);
    });

    await test('The analysis parses the same answer into the same shape', async () => {
      selectProvider('custom');
      setConfig('custom', 'model', 'CUSTOM_MODEL', 'qwen3:8b');
      const answer = {
        title: 'Invoice 42',
        correspondent: 'ACME',
        tags: ['Invoice'],
        document_type: 'Invoice',
        document_date: '2026-01-02',
        language: 'en',
      };
      // Reasoning, a fence and a sentence around the JSON: the tolerant
      // parse digs it out, as customService always did.
      fake.setScript({
        chunks: [
          {
            content: `<think>hm</think>Here it is:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\nDone.`,
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      });

      for (const [id, service] of [
        ['custom', customService],
        ['openai', openaiService],
        ['azure', azureService],
      ]) {
        selectProvider(id);
        fake.reset();
        const result = await quiet(() =>
          service.analyzeDocument(
            'Invoice 42 from ACME',
            ['Invoice'],
            [],
            [],
            1
          )
        );
        assert.deepStrictEqual(result.document, answer, id);
        assert.deepStrictEqual(
          result.metrics,
          { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
          id
        );
        assert.strictEqual(result.truncated, false, id);
        const { body } = fake.last();
        assert.strictEqual(body.messages[0].role, 'system', id);
        assert.match(body.messages[0].content, /Tag the document\./, id);
        assert.strictEqual(body.messages[1].content, 'Invoice 42 from ACME');
        assert.strictEqual('stream' in body, false, id);
        if (id === 'azure') {
          // o3-mini takes no temperature.
          assert.strictEqual('temperature' in body, false, id);
        } else {
          assert.strictEqual(body.temperature, config.aiTemperatureAnalysis);
        }
      }

      selectProvider('openai');
      process.env.OPENAI_MODEL = 'gpt-5-mini';
      fake.reset();
      await quiet(() =>
        openaiService.analyzeDocument('Invoice 42', [], [], [], 1)
      );
      assert.strictEqual(fake.last().body.model, 'gpt-5-mini');
      assert.strictEqual('temperature' in fake.last().body, false);
      process.env.OPENAI_MODEL = defaults.openaiModel;

      fake.setScript({
        chunks: [{ content: "I'm sorry, there is nothing to read." }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      });
      selectProvider('custom');
      const refusal = await quiet(() =>
        customService.analyzeDocument('x', [], [], [], 1)
      );
      assert.strictEqual(refusal.error, 'Insufficient content for AI analysis');

      fake.setScript({
        chunks: [{ content: 'ok' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    });

    await test('checkStatus keeps its shape on all three', async () => {
      selectProvider('openai');
      assert.deepStrictEqual(await quiet(() => openaiService.checkStatus()), {
        status: 'ok',
        model: 'gpt-4o-mini',
      });
      selectProvider('custom');
      assert.deepStrictEqual(await quiet(() => customService.checkStatus()), {
        status: 'ok',
        model: 'qwen3:8b',
      });
      selectProvider('azure');
      fake.reset();
      assert.deepStrictEqual(await quiet(() => azureService.checkStatus()), {
        status: 'ok',
        model: 'o3-mini',
      });
      assert.strictEqual(fake.last().path, '/openai/deployments/o3-mini');
      assert.strictEqual(fake.last().query['api-version'], '2024-10-21');
    });

    await test('A provider that is not selected has no client', async () => {
      selectProvider('anthropic');
      assert.strictEqual(openaiService.client, null);
      await assert.rejects(
        quiet(() => openaiService.generateText('hello')),
        /OpenAI client not initialized/
      );
      const status = await quiet(() => customService.checkStatus());
      assert.strictEqual(status.status, 'error');
      assert.match(status.error, /not initialized/);
      const result = await quiet(() =>
        azureService.analyzeDocument('x', [], [], [], 1)
      );
      assert.deepStrictEqual(result.document, {
        tags: [],
        correspondent: null,
      });
      assert.match(result.error, /AzureOpenAI client not initialized/);
    });
  } finally {
    selectProvider(defaults.aiProvider);
    setConfig('custom', 'model', 'CUSTOM_MODEL', defaults.customModel);
    setConfig('custom', 'apiUrl', 'CUSTOM_BASE_URL', defaults.customUrl);
    await fake.close();
    await otherFake.close();
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
