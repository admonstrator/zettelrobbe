/**
 * Azure carries the configured temperature on both its paths.
 *
 * Step 6 decision 7a of the LLM service refactoring
 * (docs/llm-service-refactoring.md): analysis sends
 * config.aiTemperatureAnalysis (was a hardcoded 0.3) and generateText()
 * defaults to config.aiTemperatureGeneration (was a hardcoded 0.7). The rest
 * of the request — model, messages, max_tokens, the absence of
 * reasoning_effort on a plain deployment — is behaviour that OpenAI and
 * Azure share, so those stay pinned exactly as before and only the
 * temperature follows the config.
 *
 * Like the other provider wiring tests, this runs against the singleton
 * with a fake client — no network, no live Azure deployment.
 */

const assert = require('assert');

process.env.AI_PROVIDER = 'azure';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'gpt-4';
process.env.AZURE_API_KEY = 'test-key';
process.env.AZURE_ENDPOINT = 'https://example.invalid';
process.env.AZURE_DEPLOYMENT_NAME = 'test-deployment';
process.env.CUSTOM_BASE_URL = 'https://example.invalid/v1';
process.env.CUSTOM_API_KEY = 'test-key';
process.env.CUSTOM_MODEL = 'test-model';
// Deliberately different from the parseTemperature() defaults (0.3 / 0.7):
// a hardcoded value that passes here is not actually reading the config.
process.env.AI_TEMPERATURE_ANALYSIS = '0.2';
process.env.AI_TEMPERATURE_GENERATION = '1.1';
process.env.SYSTEM_PROMPT = 'Analyse the document.';
process.env.USE_PROMPT_TAGS = 'no';
process.env.RESPONSE_TOKENS = '1000';
delete process.env.CUSTOM_FIELDS;
delete process.env.CONTENT_MAX_LENGTH;
delete process.env.OLLAMA_API_KEY;

const config = require('../config/config');

let failed = 0;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${label}: ${error.message}`);
  }
};

const ANSWER = JSON.stringify({
  title: 'Telekom invoice July',
  correspondent: 'Telekom Deutschland GmbH',
  tags: ['invoice'],
  document_type: 'Rechnung',
  document_date: '2026-09-03',
  language: 'de',
});

function completion(content = ANSWER, finishReason = 'stop') {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
  };
}

/** Captures the request the SDK is handed; `request` is the mapping target. */
function fakeChatClient(requests, respond = async () => completion()) {
  return {
    chat: {
      completions: {
        create: async (request) => {
          requests.push(request);
          return respond(request);
        },
      },
    },
    models: { list: async () => ({ data: [] }) },
  };
}

(async () => {
  console.log('\n=== LLM Azure temperature wiring (Finding 7a, step 6) ===');

  await check('the config really carries the test values', () => {
    assert.strictEqual(config.aiTemperatureAnalysis, 0.2);
    assert.strictEqual(config.aiTemperatureGeneration, 1.1);
  });

  const azureService = require('../services/azureService');

  await check('analysis sends AI_TEMPERATURE_ANALYSIS, not 0.3', async () => {
    const requests = [];
    azureService.client = fakeChatClient(requests);
    const result = await azureService.analyzeDocument(
      'Invoice from Telekom.',
      [],
      [],
      [],
      'doc-1'
    );
    assert.strictEqual(result.error, undefined, result.error);
    assert.strictEqual(requests.length, 1, JSON.stringify(requests));
    const request = requests[0];
    assert.strictEqual(request.model, 'test-deployment');
    assert.strictEqual(request.temperature, 0.2);
    assert.deepStrictEqual(
      request.messages.map((m) => [m.role, typeof m.content]),
      [
        ['system', 'string'],
        ['user', 'string'],
      ],
      JSON.stringify(request.messages)
    );
  });

  await check(
    'generateText() defaults to AI_TEMPERATURE_GENERATION, not 0.7',
    async () => {
      const requests = [];
      azureService.client = fakeChatClient(requests, async () =>
        completion('The answer.')
      );
      const text = await azureService.generateText('hello');
      assert.strictEqual(text, 'The answer.');
      assert.strictEqual(requests.length, 1, JSON.stringify(requests));
      const request = requests[0];
      assert.strictEqual(request.model, 'test-deployment');
      assert.strictEqual(request.temperature, 1.1);
      assert.deepStrictEqual(request.messages, [
        { role: 'user', content: 'hello' },
      ]);
      assert.strictEqual(request.max_tokens, Number(config.responseTokens));
    }
  );

  await check('the options override still wins for one call', async () => {
    const requests = [];
    azureService.client = fakeChatClient(requests, async () =>
      completion('The answer.')
    );
    await azureService.generateText('hello', {
      systemPrompt: 'You summarise.',
      temperature: 0,
      maxTokens: 42,
    });
    assert.strictEqual(requests.length, 1, JSON.stringify(requests));
    const request = requests[0];
    assert.strictEqual(request.temperature, 0);
    assert.strictEqual(request.max_tokens, 42);
    assert.deepStrictEqual(
      request.messages.map((m) => m.role),
      ['system', 'user']
    );
  });

  await check(
    'no reasoning_effort on a plain deployment even when thinking was switched off',
    async () => {
      const requests = [];
      azureService.client = fakeChatClient(requests, async () =>
        completion('The answer.')
      );
      await azureService.generateText('hello', { reasoning: false });
      assert.strictEqual(requests.length, 1, JSON.stringify(requests));
      const request = requests[0];
      assert.ok(!('reasoning_effort' in request), JSON.stringify(request));
      assert.strictEqual(request.temperature, 1.1);
    }
  );

  if (failed > 0) {
    console.error(`\n${failed} Azure temperature wiring case(s) failed`);
    process.exit(1);
  }
  console.log('\nAll Azure temperature wiring cases passed');
})();
