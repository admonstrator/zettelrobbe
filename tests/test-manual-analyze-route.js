/**
 * Test: POST /manual/analyze in routes/setup.js
 *
 * The route used to switch on AI_PROVIDER over the provider singletons, and
 * the five branches had drifted apart: only OpenAI and Anthropic recorded
 * token metrics, OpenAI read `metrics.promptTokens` unguarded (so a failed
 * analysis answered 500 with a TypeError instead of the failure record), and
 * every branch passed `id || []` — a nonsense id that the thumbnail cache
 * rejects. Since every provider has the same analyzeDocument() signature and
 * result (docs/llm-service-refactoring.md, step 6), the route goes
 * through AIServiceFactory.getService() like the scan loop does.
 *
 * The router runs for real on a throwaway database (tests/helpers/mount-router);
 * only each provider's analyzeDocument() and the metrics store are replaced.
 *
 * Covers:
 *  1. Every provider is reached through the factory with the name lists and
 *     the id as sent, and its result is answered unchanged
 *  2. Every provider's metrics are recorded against the id
 *  3. No id: analyzeDocument() gets undefined, nothing is recorded
 *  4. A failed analysis (metrics: null) answers 200 with the failure record
 *  5. Invalid content is a 400 and reaches no provider
 *  6. A provider that throws is a 500 with its message
 */

'use strict';

const assert = require('assert');
const path = require('path');

const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

const API_KEY = 'test-api-key';
const PROVIDERS = ['openai', 'ollama', 'custom', 'azure', 'anthropic'];
const SERVICE_FILES = {
  openai: 'openaiService.js',
  ollama: 'ollamaService.js',
  custom: 'customService.js',
  azure: 'azureService.js',
  anthropic: 'anthropicService.js',
};

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

function successFor(provider) {
  return {
    document: {
      tags: ['Invoice'],
      correspondent: `Acme via ${provider}`,
      title: 'Acme invoice',
      document_type: 'Invoice',
      document_date: '2026-01-01',
      language: 'en',
      custom_fields: {},
    },
    metrics: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    truncated: false,
  };
}

const FAILURE = {
  document: { tags: [], correspondent: null },
  metrics: null,
  error: 'Invalid JSON response from API',
  errorCode: undefined,
};

async function main() {
  const harness = await mountRouter({
    stub: ({ paperlessService }) => {
      paperlessService.listCorrespondentsNames = async () => [
        { id: 1, name: 'Acme' },
      ];
      paperlessService.listTagNames = async () => [{ id: 2, name: 'Invoice' }];
      paperlessService.listDocumentTypesNames = async () => [
        { id: 3, name: 'Bill' },
      ];
    },
  });

  const config = require(path.join(REPO_ROOT, 'config', 'config.js'));
  const services = {};
  for (const provider of PROVIDERS) {
    services[provider] = require(
      path.join(REPO_ROOT, 'services', SERVICE_FILES[provider])
    );
  }

  const recordedMetrics = [];
  harness.documentModel.addOpenAIMetrics = async (...args) => {
    recordedMetrics.push(args);
  };

  const calls = [];
  /** Points the app at one provider and decides what it answers. */
  function useProvider(provider, answer) {
    config.aiProvider = provider;
    process.env.AI_PROVIDER = provider;
    calls.length = 0;
    recordedMetrics.length = 0;
    for (const name of PROVIDERS) {
      services[name].analyzeDocument = async (...args) => {
        calls.push({ provider: name, args });
        if (answer instanceof Error) throw answer;
        return answer;
      };
    }
  }

  const analyze = async (body) => {
    const response = await fetch(harness.base + '/manual/analyze', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    for (const provider of PROVIDERS) {
      await test(`${provider}: reached through the factory, answered unchanged, metrics recorded`, async () => {
        const result = successFor(provider);
        useProvider(provider, result);

        const response = await analyze({ content: 'Invoice text', id: '42' });

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(response.body, result);
        assert.deepStrictEqual(
          calls.map((call) => call.provider),
          [provider]
        );
        assert.deepStrictEqual(calls[0].args, [
          'Invoice text',
          ['Invoice'],
          ['Acme'],
          ['Bill'],
          '42',
        ]);
        assert.deepStrictEqual(recordedMetrics, [['42', 10, 5, 15]]);
      });
    }

    await test('without an id the provider gets undefined and nothing is recorded', async () => {
      for (const provider of PROVIDERS) {
        useProvider(provider, successFor(provider));
        const response = await analyze({ content: 'Invoice text' });
        assert.strictEqual(response.status, 200, provider);
        assert.strictEqual(calls.length, 1, provider);
        assert.strictEqual(calls[0].args.length, 5, provider);
        assert.strictEqual(calls[0].args[4], undefined, provider);
        assert.deepStrictEqual(recordedMetrics, [], provider);
      }
    });

    await test('a failed analysis answers 200 with the failure record', async () => {
      for (const provider of PROVIDERS) {
        useProvider(provider, FAILURE);
        const response = await analyze({ content: 'Invoice text', id: '42' });
        assert.strictEqual(response.status, 200, provider);
        assert.deepStrictEqual(
          response.body,
          {
            document: { tags: [], correspondent: null },
            metrics: null,
            error: 'Invalid JSON response from API',
          },
          provider
        );
        assert.deepStrictEqual(recordedMetrics, [], provider);
      }
    });

    await test('invalid content is a 400 and reaches no provider', async () => {
      useProvider('openai', successFor('openai'));
      for (const content of [undefined, '', 42]) {
        const response = await analyze({ content, id: '42' });
        assert.strictEqual(response.status, 400, String(content));
        assert.deepStrictEqual(response.body, {
          error: 'Valid content string is required',
        });
      }
      assert.strictEqual(calls.length, 0);
    });

    await test('a provider that throws is a 500 with its message', async () => {
      useProvider('azure', new Error('provider exploded'));
      const response = await analyze({ content: 'Invoice text', id: '42' });
      assert.strictEqual(response.status, 500);
      assert.deepStrictEqual(response.body, { error: 'provider exploded' });
      assert.deepStrictEqual(recordedMetrics, []);
    });
  } finally {
    await harness.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
