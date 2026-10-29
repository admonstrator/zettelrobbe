'use strict';

/**
 * Anthropic in the setup wizard, the settings page and their validation.
 *
 * The provider itself is tested elsewhere (test-anthropic-provider.js); this
 * file holds the configuration path together: which configuration counts as
 * complete, how a key and a model are proved without spending tokens, how the
 * model list falls back when the live one cannot be had, what the settings
 * save stores and refuses, and what the two pages render.
 *
 * Claude OCR gets the most attention because its credentials are borrowed.
 * Its key is the OCR key or, failing that, the Anthropic AI key, and the OCR
 * fields are shared with Mistral and the local providers. A Mistral key or an
 * auto-detected Ollama URL left in OCR_API_KEY / OCR_API_URL would win over
 * the Anthropic settings at runtime and end in a 401 or a request to the
 * wrong host, so the save route clears both when the provider crosses to or
 * from Claude unless something new was typed.
 *
 * Nothing here reaches api.anthropic.com: the SDK talks to a small fake
 * server on 127.0.0.1 (allowed through PAPERLESS_AI_SETUP_ALLOW_LOCALHOST,
 * which is exactly the switch the SSRF rules read), and the OCR round trip is
 * a stub of mistralOcrService.runAnthropicOcr().
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');
const {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_SUGGESTED_MODELS,
  ANTHROPIC_EFFORT_LEVELS,
} = require('../services/anthropicSupport');
const {
  sanitizeConfigForBootstrap,
} = require('../services/bootstrapConfigSanitizer');

const API_KEY = 'test-api-key';
const GOOD_KEY = 'sk-ant-good-key';
const AI_KEY = 'sk-ant-ai-provider-key';
const STALE_MISTRAL_KEY = 'mistral-key-left-behind';
const SUGGESTED_IDS = ANTHROPIC_SUGGESTED_MODELS.map((entry) => entry.id);
const LIVE_MODELS = ['claude-live-one', 'claude-live-two', ...SUGGESTED_IDS];

// server.js sets these on res.locals for every page; the harness does not run
// server.js, so the shell partials would throw on the first missing one.
const SHELL_LOCALS = {
  theme: 'light',
  csrfToken: 'test-csrf',
  appVersion: 'test',
  appCommitSha: 'test',
  appPaperlessNgxVersion: 'test',
  appNodeVersion: 'test',
  appPlatform: 'test',
  appNodeEnv: 'test',
  appAiProvider: 'anthropic',
  appOcrProvider: 'anthropic',
  appServerTimeUtc: 'test',
  appServerTimezone: 'test',
  appPaperlessApiUrl: 'test',
  appOllamaApiUrl: 'test',
  appOllamaModel: 'test',
  appCustomBaseUrl: 'test',
  appCustomModel: 'test',
  appAzureEndpoint: 'test',
  appAzureDeploymentName: 'test',
  appAzureApiVersion: 'test',
  appAnthropicModel: 'test',
  appAnthropicApiUrl: 'default',
  appMistralOcrModel: 'test',
  appScanInterval: 'test',
  appTokenLimit: 'test',
  appResponseTokens: 'test',
  appTrustProxy: 'test',
  appUseExistingData: 'no',
  appRestrictTags: 'no',
  appRestrictCorrespondents: 'no',
  appRestrictDocumentTypes: 'no',
  appDateFormat: 'DD.MM.YYYY',
  appOcrEnabled: false,
  appPaperlessTokenSet: false,
  appOpenAiKeySet: false,
  appCustomKeySet: false,
  appAzureKeySet: false,
  appAnthropicKeySet: true,
  appMistralKeySet: false,
  appApiKeySet: false,
};

// Every key a test below sets; reset before each scenario so one save does
// not leak into the next (the stubbed saveConfig writes onto process.env).
const SCENARIO_KEYS = [
  'AI_PROVIDER',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_API_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_EFFORT',
  'ANTHROPIC_MAX_TOKENS',
  'ANTHROPIC_STRUCTURED_OUTPUT',
  'ANTHROPIC_PROMPT_CACHING',
  'MISTRAL_OCR_ENABLED',
  'OCR_PROVIDER',
  'OCR_API_KEY',
  'OCR_API_URL',
  'MISTRAL_API_KEY',
  'MISTRAL_OCR_MODEL',
  'PAPERLESS_AI_SETUP_ALLOW_LOCALHOST',
];

function setScenario(values) {
  SCENARIO_KEYS.forEach((key) => delete process.env[key]);
  Object.entries(values).forEach(([key, value]) => {
    process.env[key] = String(value);
  });
}

let passed = 0;
let failed = 0;

// A successful POST /settings or /api/setup/complete schedules
// process.exit(0) five seconds later.
const realExit = process.exit.bind(process);
process.exit = () => {};

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed++;
  }
}

function sliceBetween(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start !== -1, `Could not find ${from}`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `Could not delimit the block starting at ${from}`);
  return source.slice(start, end);
}

/* The two Models endpoints the configuration path uses, answered the way the
   Claude API answers them: 401 for an unknown key, 404 for an unknown model,
   and a single page for the list. */
function startFakeAnthropic() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake');
    requests.push({
      method: req.method,
      path: url.pathname,
      headers: req.headers,
    });
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const error = (status, type, message) =>
      send(status, { type: 'error', error: { type, message } });

    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
      return error(401, 'authentication_error', 'invalid x-api-key');
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return send(200, {
        data: LIVE_MODELS.map((id) => ({
          type: 'model',
          id,
          display_name: id,
          created_at: '2026-01-01T00:00:00Z',
        })),
        has_more: false,
        first_id: LIVE_MODELS[0],
        last_id: LIVE_MODELS[LIVE_MODELS.length - 1],
      });
    }
    const match = url.pathname.match(/^\/v1\/models\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const id = decodeURIComponent(match[1]);
      if (!LIVE_MODELS.includes(id)) {
        return error(404, 'not_found_error', `model: ${id}`);
      }
      return send(200, {
        type: 'model',
        id,
        display_name: id,
        created_at: '2026-01-01T00:00:00Z',
      });
    }
    return error(404, 'not_found_error', 'no such route');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        requests,
        url: `http://127.0.0.1:${server.address().port}`,
      })
    );
  });
}

(async () => {
  const fake = await startFakeAnthropic();
  const savedConfigs = [];
  const harness = await mountRouter({
    env: { PAPERLESS_AI_SETUP_ALLOW_LOCALHOST: 'yes' },
    // No account exists in the temp database, so the setup wizard is open.
    stub: ({ setupService }) => {
      // The real saveConfig writes the merged configuration back onto
      // process.env and touches the data directory; the first half is what
      // later reads see.
      setupService.saveConfig = async (config) => {
        savedConfigs.push(config);
        Object.entries(config).forEach(([key, value]) => {
          process.env[key] = Array.isArray(value)
            ? value.join(',')
            : String(value);
        });
      };
    },
  });
  Object.assign(harness.app.locals, SHELL_LOCALS);
  const { setupService } = harness;

  // The very instance setupService requires lazily for the OCR round trip.
  const mistralOcrService = require(
    path.join(REPO_ROOT, 'services', 'mistralOcrService.js')
  );
  const ocrCalls = [];
  let ocrAnswer = () => setupService.getOcrValidationToken();
  mistralOcrService.runAnthropicOcr = async (params) => {
    ocrCalls.push(params);
    return ocrAnswer(params);
  };

  const request = (method, route, body) =>
    fetch(harness.base + route, {
      method,
      redirect: 'manual',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const lastSaved = () => savedConfigs[savedConfigs.length - 1];

  try {
    // ── hasRequiredConfiguration ────────────────────────────────────────────
    await test('hasRequiredConfiguration: anthropic needs a key and a model', async () => {
      const base = {
        PAPERLESS_API_URL: 'http://paperless',
        AI_PROVIDER: 'anthropic',
      };
      assert.strictEqual(
        setupService.hasRequiredConfiguration({
          ...base,
          ANTHROPIC_API_KEY: GOOD_KEY,
          ANTHROPIC_MODEL: ANTHROPIC_DEFAULT_MODEL,
        }),
        true
      );
      assert.strictEqual(
        setupService.hasRequiredConfiguration({
          ...base,
          ANTHROPIC_MODEL: ANTHROPIC_DEFAULT_MODEL,
        }),
        false,
        'no key is no configuration'
      );
      assert.strictEqual(
        setupService.hasRequiredConfiguration({
          ...base,
          ANTHROPIC_API_KEY: GOOD_KEY,
          ANTHROPIC_MODEL: '  ',
        }),
        false,
        'a blank model is no model'
      );
    });

    await test('an injected key alone is complete: the snapshot fills in the default model', async () => {
      setScenario({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: GOOD_KEY });
      const snapshot = setupService.getRuntimeConfigurationSnapshot();
      assert.strictEqual(snapshot.ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_MODEL);
      assert.strictEqual(snapshot.ANTHROPIC_API_KEY, GOOD_KEY);
    });

    // ── validateAnthropicConfig / validateConfig ────────────────────────────
    await test('validateAnthropicConfig proves key and model with a models lookup', async () => {
      setScenario({ PAPERLESS_AI_SETUP_ALLOW_LOCALHOST: 'yes' });
      fake.requests.length = 0;
      assert.strictEqual(
        await setupService.validateAnthropicConfig(
          GOOD_KEY,
          'claude-live-one',
          fake.url
        ),
        true
      );
      assert.deepStrictEqual(
        fake.requests.map((entry) => `${entry.method} ${entry.path}`),
        ['GET /v1/models/claude-live-one'],
        'one GET /v1/models/{id} and no Messages request, so no tokens are spent'
      );
      assert.strictEqual(
        await setupService.validateAnthropicConfig(
          'sk-ant-wrong',
          'claude-live-one',
          fake.url
        ),
        false,
        'a refused key fails'
      );
      assert.strictEqual(
        await setupService.validateAnthropicConfig(
          GOOD_KEY,
          'claude-unknown',
          fake.url
        ),
        false,
        'an unknown model fails'
      );
      assert.strictEqual(
        await setupService.validateAnthropicConfig(
          '',
          'claude-live-one',
          fake.url
        ),
        false,
        'no key fails without a request'
      );
    });

    await test('validateAnthropicConfig applies the SSRF rules to a proxy URL', async () => {
      setScenario({});
      fake.requests.length = 0;
      assert.strictEqual(
        await setupService.validateAnthropicConfig(
          GOOD_KEY,
          'claude-live-one',
          fake.url
        ),
        false,
        'localhost is refused unless PAPERLESS_AI_SETUP_ALLOW_LOCALHOST allows it'
      );
      assert.strictEqual(
        fake.requests.length,
        0,
        'the refused URL is never contacted'
      );
    });

    await test('validateConfig routes anthropic to validateAnthropicConfig', async () => {
      const originalPaperless = setupService.validatePaperlessConfig;
      const originalAnthropic = setupService.validateAnthropicConfig;
      const calls = [];
      setupService.validatePaperlessConfig = async () => true;
      setupService.validateAnthropicConfig = async (...args) => {
        calls.push(args);
        return args[0] === GOOD_KEY;
      };
      try {
        await setupService.validateConfig({
          PAPERLESS_API_URL: 'http://paperless',
          PAPERLESS_API_TOKEN: 't',
          AI_PROVIDER: 'anthropic',
          ANTHROPIC_API_KEY: GOOD_KEY,
          ANTHROPIC_API_URL: 'https://proxy.example',
        });
        assert.deepStrictEqual(calls[0], [
          GOOD_KEY,
          ANTHROPIC_DEFAULT_MODEL,
          'https://proxy.example',
        ]);
        await assert.rejects(
          setupService.validateConfig({
            PAPERLESS_API_URL: 'http://paperless',
            PAPERLESS_API_TOKEN: 't',
            AI_PROVIDER: 'anthropic',
            ANTHROPIC_API_KEY: 'sk-ant-wrong',
            ANTHROPIC_MODEL: 'claude-live-two',
          }),
          /Invalid Anthropic configuration/
        );
        assert.strictEqual(calls[1][1], 'claude-live-two');
      } finally {
        setupService.validatePaperlessConfig = originalPaperless;
        setupService.validateAnthropicConfig = originalAnthropic;
      }
    });

    // ── Model discovery ─────────────────────────────────────────────────────
    await test('model discovery returns the live list when the key works', async () => {
      setScenario({ PAPERLESS_AI_SETUP_ALLOW_LOCALHOST: 'yes' });
      const result = await setupService.discoverAnthropicModels({
        apiKey: GOOD_KEY,
        apiUrl: fake.url,
      });
      assert.strictEqual(result.live, true);
      assert.deepStrictEqual(result.models, LIVE_MODELS);
    });

    await test('model discovery falls back to the suggested models', async () => {
      setScenario({ PAPERLESS_AI_SETUP_ALLOW_LOCALHOST: 'yes' });
      const refused = await setupService.discoverAnthropicModels({
        apiKey: 'sk-ant-wrong',
        apiUrl: fake.url,
      });
      assert.strictEqual(refused.live, false);
      assert.deepStrictEqual(refused.models, SUGGESTED_IDS);
      assert.ok(refused.error, 'the reason travels with the fallback');

      const keyless = await setupService.discoverAnthropicModels({
        apiKey: '',
      });
      assert.strictEqual(keyless.live, false);
      assert.deepStrictEqual(keyless.models, SUGGESTED_IDS);

      setScenario({});
      const blocked = await setupService.discoverAnthropicModels({
        apiKey: GOOD_KEY,
        apiUrl: fake.url,
      });
      assert.strictEqual(
        blocked.live,
        false,
        'a URL the SSRF rules refuse is not contacted'
      );
      assert.match(blocked.error, /URL validation failed/);
    });

    await test('POST /api/settings/ai/models: stored key, then the fallback with a message', async () => {
      setScenario({
        PAPERLESS_AI_SETUP_ALLOW_LOCALHOST: 'yes',
        ANTHROPIC_API_KEY: GOOD_KEY,
        ANTHROPIC_API_URL: fake.url,
      });
      let response = await request('POST', '/api/settings/ai/models', {
        aiProvider: 'anthropic',
        apiUrl: fake.url,
        token: '',
      });
      let body = await response.json();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.live, true, 'an empty field uses the stored key');
      assert.deepStrictEqual(body.models, LIVE_MODELS);

      setScenario({ PAPERLESS_AI_SETUP_ALLOW_LOCALHOST: 'yes' });
      response = await request('POST', '/api/settings/ai/models', {
        aiProvider: 'anthropic',
        apiUrl: fake.url,
        token: 'sk-ant-wrong',
      });
      body = await response.json();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.live, false);
      assert.deepStrictEqual(body.models, SUGGESTED_IDS);
      assert.match(body.message, /suggested Claude models/);
    });

    await test('the stored Claude key never goes to a host that is not configured', async () => {
      // The fake answers on 127.0.0.1 and localhost alike; only the stored
      // URL names one of them, so the other counts as somebody else's host.
      const otherHost = fake.url.includes('127.0.0.1')
        ? fake.url.replace('127.0.0.1', 'localhost')
        : fake.url.replace('localhost', '127.0.0.1');
      setScenario({
        PAPERLESS_AI_SETUP_ALLOW_LOCALHOST: 'yes',
        ANTHROPIC_API_KEY: GOOD_KEY,
        ANTHROPIC_API_URL: fake.url,
        OCR_PROVIDER: 'anthropic',
        OCR_API_KEY: GOOD_KEY,
      });

      let response = await request('POST', '/api/settings/ai/models', {
        aiProvider: 'anthropic',
        apiUrl: otherHost,
        token: '',
      });
      let body = await response.json();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.live, false, 'AI: no stored key for a new host');

      response = await request('POST', '/api/settings/ocr/models', {
        provider: 'anthropic',
        apiUrl: otherHost,
        apiKey: '',
      });
      body = await response.json();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.live, false, 'OCR: no stored key for a new host');

      const connection = setupService.resolveAnthropicOcrConnection({
        anthropicApiUrl: otherHost,
      });
      assert.strictEqual(connection.apiKey, '');
      assert.strictEqual(
        setupService.resolveAnthropicOcrConnection({}).apiKey,
        GOOD_KEY,
        'the configured URL still gets the stored key'
      );
    });

    // ── validateOcrConfig for Claude OCR ────────────────────────────────────
    await test('validateOcrConfig(anthropic) runs one OCR round trip with the typed key', async () => {
      setScenario({ ANTHROPIC_API_KEY: AI_KEY });
      ocrCalls.length = 0;
      const valid = await setupService.validateOcrConfig({
        enabled: 'yes',
        provider: 'anthropic',
        apiKey: 'sk-ant-ocr-key',
        model: 'claude-sonnet-5-5',
      });
      assert.strictEqual(valid, true);
      assert.strictEqual(ocrCalls.length, 1);
      const call = ocrCalls[0];
      assert.strictEqual(
        call.apiKey,
        'sk-ant-ocr-key',
        'the OCR key wins over the AI key'
      );
      assert.strictEqual(call.model, 'claude-sonnet-5-5');
      assert.strictEqual(call.mimeType, 'image/png');
      assert.ok(
        !call.base64.startsWith('data:'),
        'plain base64, not a data URL'
      );
      assert.ok(Buffer.from(call.base64, 'base64').length > 0);
      assert.ok(call.timeoutMs > 0);
    });

    await test('validateOcrConfig(anthropic) falls back to the Anthropic AI key, URL and model', async () => {
      setScenario({
        ANTHROPIC_API_KEY: AI_KEY,
        PAPERLESS_AI_SETUP_ALLOW_LOCALHOST: 'yes',
      });
      ocrCalls.length = 0;
      assert.strictEqual(
        await setupService.validateOcrConfig({
          enabled: 'yes',
          provider: 'anthropic',
          apiKey: '',
          // The shared OCR model field still holds the Mistral default.
          model: 'mistral-ocr-latest',
          anthropicApiKey: 'sk-ant-typed-ai-key',
          anthropicApiUrl: fake.url,
          anthropicModel: 'claude-opus-5-5',
        }),
        true
      );
      assert.strictEqual(ocrCalls[0].apiKey, 'sk-ant-typed-ai-key');
      assert.strictEqual(ocrCalls[0].apiUrl, fake.url);
      assert.strictEqual(
        ocrCalls[0].model,
        'claude-opus-5-5',
        'a Mistral model is never sent to Claude'
      );

      ocrCalls.length = 0;
      assert.strictEqual(
        await setupService.validateOcrConfig({
          enabled: 'yes',
          provider: 'anthropic',
          apiKey: '',
          model: '',
        }),
        true
      );
      assert.strictEqual(
        ocrCalls[0].apiKey,
        AI_KEY,
        'the stored ANTHROPIC_API_KEY is the last fallback'
      );
      assert.strictEqual(ocrCalls[0].model, ANTHROPIC_DEFAULT_MODEL);
    });

    await test('validateOcrConfig(anthropic) fails without a key, on a wrong answer and on a blocked URL', async () => {
      setScenario({});
      ocrCalls.length = 0;
      assert.strictEqual(
        await setupService.validateOcrConfig({
          enabled: 'yes',
          provider: 'anthropic',
        }),
        false
      );
      assert.strictEqual(ocrCalls.length, 0, 'no key, no request');

      ocrAnswer = () => '';
      try {
        assert.strictEqual(
          await setupService.validateOcrConfig({
            enabled: 'yes',
            provider: 'anthropic',
            apiKey: 'sk-ant-ocr-key',
          }),
          false,
          'an empty transcript ("no text found") is no proof'
        );
      } finally {
        ocrAnswer = () => setupService.getOcrValidationToken();
      }

      ocrCalls.length = 0;
      assert.strictEqual(
        await setupService.validateOcrConfig({
          enabled: 'yes',
          provider: 'anthropic',
          apiKey: 'sk-ant-ocr-key',
          apiUrl: 'http://127.0.0.1:9',
        }),
        false,
        'a proxy URL goes through the SSRF rules'
      );
      assert.strictEqual(ocrCalls.length, 0);
    });

    await test('POST /api/settings/ocr/test never hands a stored Mistral key to Claude', async () => {
      setScenario({
        ANTHROPIC_API_KEY: AI_KEY,
        OCR_PROVIDER: 'mistral',
        OCR_API_KEY: STALE_MISTRAL_KEY,
        MISTRAL_API_KEY: STALE_MISTRAL_KEY,
      });
      ocrCalls.length = 0;
      const response = await request('POST', '/api/settings/ocr/test', {
        enabled: 'yes',
        provider: 'anthropic',
        apiKey: '',
        model: '',
      });
      const body = await response.json();
      assert.strictEqual(body.success, true, body.message);
      assert.strictEqual(ocrCalls[0].apiKey, AI_KEY);
    });

    // ── Bootstrap sanitizer ─────────────────────────────────────────────────
    await test('the setup bootstrap drops ANTHROPIC_API_KEY and keeps the rest', async () => {
      const sanitized = sanitizeConfigForBootstrap({
        ANTHROPIC_API_KEY: GOOD_KEY,
        ANTHROPIC_MODEL: 'claude-live-one',
        ANTHROPIC_API_URL: 'https://proxy.example',
      });
      assert.ok(!('ANTHROPIC_API_KEY' in sanitized));
      assert.strictEqual(sanitized.ANTHROPIC_MODEL, 'claude-live-one');
      assert.strictEqual(sanitized.ANTHROPIC_API_URL, 'https://proxy.example');
    });

    // ── The settings page ───────────────────────────────────────────────────
    await test('GET /settings renders the Anthropic option, block and Claude OCR option', async () => {
      setScenario({
        AI_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: GOOD_KEY,
        ANTHROPIC_MODEL: 'claude-sonnet-5-5',
        ANTHROPIC_EFFORT: 'high',
        ANTHROPIC_MAX_TOKENS: '24000',
        ANTHROPIC_STRUCTURED_OUTPUT: 'no',
        ANTHROPIC_PROMPT_CACHING: 'yes',
        MISTRAL_OCR_ENABLED: 'yes',
        OCR_PROVIDER: 'anthropic',
      });
      const response = await request('GET', '/settings');
      assert.strictEqual(response.status, 200);
      const html = await response.text();

      assert.ok(!html.includes(GOOD_KEY), 'the key never reaches the page');
      assert.match(
        html,
        /<option value="anthropic" selected>Anthropic \(Claude\)<\/option>/
      );
      assert.match(
        html,
        /<option value="anthropic" selected>Claude \(Anthropic\)<\/option>/
      );

      const block = sliceBetween(
        html,
        'id="anthropicSettings"',
        '<h4 class="zr-label">Model Parameters</h4>'
      );
      assert.ok(
        !block.slice(0, 80).includes('hidden'),
        'shown while anthropic is selected'
      );
      [
        'anthropicApiKey',
        'anthropicModel',
        'anthropicEffort',
        'anthropicMaxTokens',
        'anthropicStructuredOutput',
        'anthropicPromptCaching',
        'anthropicApiUrl',
      ].forEach((name) => {
        assert.ok(
          block.includes(`name="${name}"`),
          `${name} is part of the form`
        );
      });
      assert.match(block, /id="anthropicApiKey"[^>]*placeholder="Configured"/);
      assert.match(block, /<select id="anthropicModel" name="anthropicModel"/);
      assert.match(block, /<option value="claude-sonnet-5-5" selected>/);
      SUGGESTED_IDS.forEach((id) => {
        assert.match(
          block,
          new RegExp(`<option value="${id}" (selected)?>`),
          `${id} is offered`
        );
      });
      assert.ok(block.includes('id="fetchAnthropicModelsBtn"'));
      assert.match(block, /<option value="" >Model default<\/option>/);
      ANTHROPIC_EFFORT_LEVELS.forEach((level) => {
        assert.ok(
          block.includes(`<option value="${level}"`),
          `effort ${level} is offered`
        );
      });
      assert.match(block, /<option value="high" selected>/);
      assert.match(block, /name="anthropicMaxTokens" value="24000"/);
      assert.match(
        block,
        /id="anthropicStructuredOutput" name="anthropicStructuredOutput" value="no"/
      );
      assert.match(
        block,
        /id="anthropicPromptCaching" name="anthropicPromptCaching" value="yes"/
      );
      assert.ok(
        block.includes('Only for a proxy; leave empty for api.anthropic.com')
      );

      const hints =
        html.match(/<p class="zr-field__hint[^"]*" data-anthropic-hint>/g) ||
        [];
      assert.strictEqual(
        hints.length,
        2,
        'both temperature fields say Claude ignores them'
      );
      hints.forEach((hint) => assert.ok(!hint.includes('hidden')));

      assert.match(
        html,
        /id="ocrApiKeyAnthropicHint" class="zr-field__hint ">Restart required · Empty uses the Anthropic API key from the AI provider/
      );
      assert.ok(
        html.includes(
          `anthropic: {"defaultModel":"${ANTHROPIC_DEFAULT_MODEL}"`
        ),
        'the page script gets the Claude options'
      );
    });

    await test('GET /settings hides the Anthropic block for another provider', async () => {
      setScenario({ AI_PROVIDER: 'openai' });
      const html = await (await request('GET', '/settings')).text();
      assert.match(
        html,
        /id="anthropicSettings" class="zr-col zr-col--loose hidden"/
      );
      assert.match(
        html,
        /<option value="anthropic" >Anthropic \(Claude\)<\/option>/
      );
      assert.ok(
        html.includes(`<option value="${ANTHROPIC_DEFAULT_MODEL}" selected>`),
        'an unconfigured model field shows the model the provider would run'
      );
    });

    // ── POST /settings ──────────────────────────────────────────────────────
    const anthropicBody = (overrides = {}) => ({
      aiProvider: 'anthropic',
      anthropicApiKey: 'sk-ant-typed',
      anthropicModel: 'claude-opus-5-5',
      anthropicEffort: 'xhigh',
      anthropicMaxTokens: '32000',
      anthropicStructuredOutput: 'no',
      anthropicPromptCaching: 'yes',
      anthropicApiUrl: ' https://proxy.example ',
      ...overrides,
    });

    await test('POST /settings persists the ANTHROPIC_* keys', async () => {
      setScenario({ AI_PROVIDER: 'openai' });
      const before = savedConfigs.length;
      const response = await request('POST', '/settings', anthropicBody());
      const body = await response.json();
      assert.strictEqual(response.status, 200, JSON.stringify(body));
      assert.strictEqual(savedConfigs.length, before + 1);
      const saved = lastSaved();
      assert.strictEqual(saved.AI_PROVIDER, 'anthropic');
      assert.strictEqual(saved.ANTHROPIC_API_KEY, 'sk-ant-typed');
      assert.strictEqual(saved.ANTHROPIC_MODEL, 'claude-opus-5-5');
      assert.strictEqual(saved.ANTHROPIC_EFFORT, 'xhigh');
      assert.strictEqual(saved.ANTHROPIC_MAX_TOKENS, '32000');
      assert.strictEqual(saved.ANTHROPIC_STRUCTURED_OUTPUT, 'no');
      assert.strictEqual(saved.ANTHROPIC_PROMPT_CACHING, 'yes');
      assert.strictEqual(saved.ANTHROPIC_API_URL, 'https://proxy.example');
    });

    await test('POST /settings: an empty key keeps the stored one, an empty effort means model default', async () => {
      setScenario({
        AI_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: GOOD_KEY,
        ANTHROPIC_EFFORT: 'high',
      });
      const response = await request(
        'POST',
        '/settings',
        anthropicBody({
          anthropicApiKey: '',
          anthropicEffort: '',
          anthropicApiUrl: '',
        })
      );
      assert.strictEqual(response.status, 200);
      const saved = lastSaved();
      assert.strictEqual(saved.ANTHROPIC_API_KEY, GOOD_KEY);
      assert.strictEqual(saved.ANTHROPIC_EFFORT, '');
      assert.strictEqual(saved.ANTHROPIC_API_URL, '');
    });

    await test('POST /settings refuses a bad effort, bad max tokens, a bad URL and a missing key', async () => {
      setScenario({ AI_PROVIDER: 'openai' });
      const before = savedConfigs.length;
      const cases = [
        [
          anthropicBody({ anthropicEffort: 'extreme' }),
          /Invalid Anthropic effort/,
        ],
        [
          anthropicBody({ anthropicMaxTokens: '16k' }),
          /Invalid Anthropic max tokens/,
        ],
        [
          anthropicBody({ anthropicMaxTokens: '0' }),
          /Invalid Anthropic max tokens/,
        ],
        [
          anthropicBody({ anthropicApiUrl: 'ftp://proxy' }),
          /Invalid Anthropic API URL/,
        ],
        [
          anthropicBody({ anthropicApiKey: '' }),
          /Anthropic API key is required/,
        ],
      ];
      for (const [body, pattern] of cases) {
        const response = await request('POST', '/settings', body);
        const result = await response.json();
        assert.strictEqual(response.status, 400, JSON.stringify(body));
        assert.match(result.error, pattern);
      }
      assert.strictEqual(
        savedConfigs.length,
        before,
        'nothing is saved on a refusal'
      );
    });

    // ── Claude OCR: stale keys and URLs ─────────────────────────────────────
    await test('switching OCR to Claude clears the Mistral key and the leftover URL', async () => {
      setScenario({
        AI_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: AI_KEY,
        ANTHROPIC_MODEL: 'claude-sonnet-5-5',
        MISTRAL_OCR_ENABLED: 'yes',
        OCR_PROVIDER: 'custom',
        OCR_API_KEY: STALE_MISTRAL_KEY,
        MISTRAL_API_KEY: STALE_MISTRAL_KEY,
        OCR_API_URL: 'http://ollama.lan:11434',
        MISTRAL_OCR_MODEL: 'llava',
      });
      const response = await request('POST', '/settings', {
        mistralOcrEnabled: 'yes',
        ocrProvider: 'anthropic',
        ocrApiKey: '',
        // What the page still had in the field from the previous provider.
        ocrApiUrl: 'http://ollama.lan:11434',
        mistralOcrModel: 'llava',
      });
      assert.strictEqual(
        response.status,
        200,
        JSON.stringify(await response.json())
      );
      const saved = lastSaved();
      assert.strictEqual(saved.OCR_PROVIDER, 'anthropic');
      assert.strictEqual(
        saved.OCR_API_KEY,
        '',
        'Claude OCR now falls back to ANTHROPIC_API_KEY'
      );
      assert.strictEqual(
        saved.MISTRAL_API_KEY,
        STALE_MISTRAL_KEY,
        'the Mistral key stays where Mistral reads it'
      );
      assert.strictEqual(
        saved.OCR_API_URL,
        '',
        'an Ollama URL is no Claude proxy'
      );
      assert.strictEqual(
        saved.MISTRAL_OCR_MODEL,
        'claude-sonnet-5-5',
        'a non-Claude model becomes the AI model'
      );
    });

    await test('a key and a proxy typed for Claude OCR are kept, and never mirrored into MISTRAL_API_KEY', async () => {
      setScenario({
        AI_PROVIDER: 'openai',
        MISTRAL_OCR_ENABLED: 'yes',
        OCR_PROVIDER: 'mistral',
        OCR_API_KEY: STALE_MISTRAL_KEY,
        MISTRAL_API_KEY: STALE_MISTRAL_KEY,
      });
      const response = await request('POST', '/settings', {
        mistralOcrEnabled: 'yes',
        ocrProvider: 'anthropic',
        ocrApiKey: 'sk-ant-ocr-key',
        ocrApiUrl: 'https://claude-proxy.example',
        mistralOcrModel: ANTHROPIC_DEFAULT_MODEL,
      });
      assert.strictEqual(
        response.status,
        200,
        JSON.stringify(await response.json())
      );
      const saved = lastSaved();
      assert.strictEqual(saved.OCR_API_KEY, 'sk-ant-ocr-key');
      assert.strictEqual(saved.MISTRAL_API_KEY, STALE_MISTRAL_KEY);
      assert.strictEqual(saved.OCR_API_URL, 'https://claude-proxy.example');
      assert.strictEqual(saved.MISTRAL_OCR_MODEL, ANTHROPIC_DEFAULT_MODEL);
    });

    await test('staying on Claude keeps its stored OCR key; leaving it clears the key', async () => {
      setScenario({
        AI_PROVIDER: 'openai',
        MISTRAL_OCR_ENABLED: 'yes',
        OCR_PROVIDER: 'anthropic',
        OCR_API_KEY: 'sk-ant-ocr-key',
        MISTRAL_API_KEY: STALE_MISTRAL_KEY,
        OCR_API_URL: 'https://claude-proxy.example',
        MISTRAL_OCR_MODEL: ANTHROPIC_DEFAULT_MODEL,
      });
      let response = await request('POST', '/settings', {
        mistralOcrEnabled: 'yes',
        ocrProvider: 'anthropic',
        ocrApiKey: '',
        ocrApiUrl: 'https://claude-proxy.example',
        mistralOcrModel: ANTHROPIC_DEFAULT_MODEL,
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(lastSaved().OCR_API_KEY, 'sk-ant-ocr-key');
      assert.strictEqual(
        lastSaved().OCR_API_URL,
        'https://claude-proxy.example'
      );

      response = await request('POST', '/settings', {
        mistralOcrEnabled: 'yes',
        ocrProvider: 'mistral',
        ocrApiKey: '',
        mistralOcrModel: 'mistral-ocr-latest',
      });
      assert.strictEqual(
        response.status,
        200,
        JSON.stringify(await response.json())
      );
      const saved = lastSaved();
      assert.strictEqual(
        saved.OCR_API_KEY,
        '',
        'the Claude key must not reach Mistral'
      );
      assert.strictEqual(saved.MISTRAL_API_KEY, STALE_MISTRAL_KEY);
      assert.strictEqual(saved.OCR_API_URL, '');
    });

    await test('Claude OCR without any Anthropic key is refused', async () => {
      setScenario({ AI_PROVIDER: 'openai', OCR_PROVIDER: 'mistral' });
      const before = savedConfigs.length;
      const response = await request('POST', '/settings', {
        mistralOcrEnabled: 'yes',
        ocrProvider: 'anthropic',
        ocrApiKey: '',
        // Typed into the hidden Anthropic block, which is not saved for openai.
        anthropicApiKey: 'sk-ant-not-saved',
      });
      const body = await response.json();
      assert.strictEqual(response.status, 400);
      assert.match(body.error, /Claude OCR needs an Anthropic API key/);
      assert.strictEqual(savedConfigs.length, before);
    });

    // ── The setup wizard (last: completing it creates the account) ──────────
    await test('GET /setup renders the Claude OCR option, the preset and the Claude options', async () => {
      setScenario({
        AI_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: GOOD_KEY,
        ANTHROPIC_MODEL: 'claude-sonnet-5-5',
      });
      const response = await request('GET', '/setup');
      assert.strictEqual(response.status, 200);
      const html = await response.text();
      assert.ok(!html.includes(GOOD_KEY), 'the key never reaches the wizard');
      assert.ok(
        html.includes('<option value="anthropic" >Claude (Anthropic)</option>')
      );
      assert.ok(html.includes('id="ocrApiKeyAnthropicHint"'));
      assert.ok(html.includes('id="aiApiUrlHint"'));
      const bootstrap = JSON.parse(
        sliceBetween(html, 'window.__SETUP_BOOTSTRAP__ = ', ';\n').replace(
          'window.__SETUP_BOOTSTRAP__ = ',
          ''
        )
      );
      const preset = bootstrap.aiProviderPresets.find(
        (entry) => entry.provider === 'anthropic'
      );
      assert.ok(preset, 'the Anthropic preset is offered');
      assert.strictEqual(preset.label, 'Anthropic (Claude)');
      assert.strictEqual(preset.apiUrl, '');
      assert.strictEqual(preset.model, ANTHROPIC_DEFAULT_MODEL);
      assert.strictEqual(preset.tokenPlaceholder, 'sk-ant-...');
      assert.strictEqual(bootstrap.config.ANTHROPIC_MODEL, 'claude-sonnet-5-5');
      assert.ok(!('ANTHROPIC_API_KEY' in bootstrap.config));
      assert.deepStrictEqual(
        bootstrap.anthropic.suggestedModels.map((entry) => entry.id),
        SUGGESTED_IDS
      );
    });

    await test('POST /api/setup/complete writes the Anthropic keys and keeps Claude out of MISTRAL_API_KEY', async () => {
      setScenario({});
      const response = await fetch(harness.base + '/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminUsername: 'admin',
          adminPassword: 'long-enough-password',
          paperlessUrl: 'http://paperless.test',
          paperlessUsername: 'admin',
          paperlessToken: 'paperless-token',
          scanAllDocuments: true,
          aiProvider: 'anthropic',
          aiApiUrl: '',
          aiToken: GOOD_KEY,
          aiModel: 'claude-sonnet-5-5',
          mistralOcrEnabled: true,
          ocrProvider: 'anthropic',
          ocrApiUrl: '',
          ocrApiKey: '',
          mistralOcrModel: '',
          // The wizard reports these as already proved with these values.
          paperlessTestPassed: true,
          aiTestPassed: true,
          ocrTestPassed: true,
        }),
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200, JSON.stringify(body));
      const saved = lastSaved();
      assert.strictEqual(saved.AI_PROVIDER, 'anthropic');
      assert.strictEqual(saved.ANTHROPIC_API_KEY, GOOD_KEY);
      assert.strictEqual(saved.ANTHROPIC_MODEL, 'claude-sonnet-5-5');
      assert.ok(
        !('ANTHROPIC_API_URL' in saved),
        'no URL is written for api.anthropic.com'
      );
      assert.strictEqual(saved.OCR_PROVIDER, 'anthropic');
      assert.strictEqual(saved.OCR_API_KEY, '');
      assert.strictEqual(saved.MISTRAL_API_KEY, '');
      assert.strictEqual(saved.MISTRAL_OCR_MODEL, 'claude-sonnet-5-5');
      assert.ok(body.envPreview.includes('AI_PROVIDER=anthropic'));
      assert.ok(body.envPreview.includes('ANTHROPIC_MODEL=claude-sonnet-5-5'));
    });
  } finally {
    await harness.close();
    await new Promise((resolve) => fake.server.close(resolve));
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit = realExit;
  realExit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit = realExit;
  realExit(1);
});
