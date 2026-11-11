/**
 * The OpenAI-compatible OCR request carries its own completion cap.
 *
 * Without max_tokens the server's default decides, and mlx_vlm's is 2048: a
 * dense A4 page needs more, comes back with finish_reason "length", and the
 * truncation guard rightly discards it. OCR_MAX_TOKENS (default 4096) is sent
 * instead, and the "cut off" error names it as the setting to raise.
 */
const assert = require('assert');

const configModulePath = require.resolve('../config/config');
const paperlessServiceModulePath =
  require.resolve('../services/paperlessService');
const documentModelModulePath = require.resolve('../models/document');
const aiServiceFactoryModulePath =
  require.resolve('../services/aiServiceFactory');
const axiosModulePath = require.resolve('axios');
const ocrServiceModulePath = require.resolve('../services/mistralOcrService');

function stub(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadService({ maxTokens, finishReason = 'stop' } = {}) {
  for (const modulePath of [
    configModulePath,
    paperlessServiceModulePath,
    documentModelModulePath,
    aiServiceFactoryModulePath,
    axiosModulePath,
    ocrServiceModulePath,
  ]) {
    delete require.cache[modulePath];
  }

  const calls = [];
  const mistralOcr = {
    enabled: 'yes',
    provider: 'ollama',
    apiUrl: 'http://localhost:8000/v1',
    apiKey: '',
    model: 'mlx-community/GLM-OCR-bf16',
  };
  if (maxTokens !== undefined) {
    mistralOcr.maxTokens = maxTokens;
  }

  stub(configModulePath, {
    mistralOcr,
    ollama: { apiUrl: 'http://localhost:11434' },
    limitFunctions: {},
  });
  stub(paperlessServiceModulePath, {
    getThumbnailImage: async () => Buffer.from('thumbnail'),
  });
  stub(documentModelModulePath, {});
  stub(aiServiceFactoryModulePath, { getService: () => ({}) });
  stub(axiosModulePath, {
    post: async (url, body) => {
      calls.push({ url, body });
      return {
        data: {
          choices: [
            {
              finish_reason: finishReason,
              message: { content: 'Page text' },
            },
          ],
        },
      };
    },
  });

  return { service: require('../services/mistralOcrService'), calls };
}

async function ocrImage(service) {
  return service.performOcr('aW1hZ2U=', 'image/png', 611);
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('the request carries max_tokens 4096 by default', async () => {
  const { service, calls } = loadService();
  assert.strictEqual(await ocrImage(service), 'Page text');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'http://localhost:8000/v1/chat/completions');
  assert.strictEqual(calls[0].body.max_tokens, 4096);
});

test('OCR_MAX_TOKENS sets the cap', async () => {
  const { service, calls } = loadService({ maxTokens: 8192 });
  await ocrImage(service);
  assert.strictEqual(calls[0].body.max_tokens, 8192);
});

test('an unusable configured value falls back to 4096', async () => {
  for (const value of [null, 0, -5, Number.NaN, '8k']) {
    const { service, calls } = loadService({ maxTokens: value });
    await ocrImage(service);
    assert.strictEqual(
      calls[0].body.max_tokens,
      4096,
      `value ${String(value)}`
    );
  }
});

test('a truncated page names OCR_MAX_TOKENS in the error', async () => {
  const { service } = loadService({ finishReason: 'length' });
  await assert.rejects(
    () => service._performLocalOcrOnImage('aW1hZ2U=', 'image/png'),
    (error) => {
      assert.match(error.message, /cut off at the token limit/);
      assert.match(error.message, /OCR_MAX_TOKENS \(now 4096\)/);
      return true;
    }
  );
});

(async () => {
  let failed = 0;
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  ❌ ${name}: ${error.message}`);
    }
  }
  console.log(`${cases.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
