const assert = require('assert');

const setupServiceModulePath = require.resolve('../services/setupService');
const axiosModulePath = require.resolve('axios');

function loadSetupServiceWithAxiosMock(axiosMock) {
  delete require.cache[setupServiceModulePath];
  delete require.cache[axiosModulePath];

  require.cache[axiosModulePath] = {
    id: axiosModulePath,
    filename: axiosModulePath,
    loaded: true,
    exports: axiosMock
  };

  return require('../services/setupService');
}

async function testOpenAiCompatibleLocalOcrValidation() {
  const state = { modelCalls: [], ocrCalls: [] };

  const setupService = loadSetupServiceWithAxiosMock({
    get: async (url) => {
      state.modelCalls.push(url);
      return { status: 200, data: { data: [{ id: 'gemma-vision' }] } };
    },
    post: async (url) => {
      state.ocrCalls.push(url);
      return {
        data: {
          choices: [
            {
              message: {
                content: 'OCR-TEST-182730173401'
              }
            }
          ]
        }
      };
    }
  });

  const valid = await setupService.validateOcrConfig({
    enabled: 'yes',
    provider: 'ollama',
    apiUrl: 'http://10.10.10.10:1234/v1',
    apiKey: '',
    model: 'gemma-vision'
  });

  assert.strictEqual(valid, true, 'Expected OpenAI-compatible OCR validation to pass');
  assert.strictEqual(state.modelCalls.length, 1, 'Expected exactly one model probe request');
  assert.strictEqual(state.modelCalls[0], 'http://10.10.10.10:1234/v1/models', 'Expected /v1/models probe for OpenAI-compatible endpoint');
  assert.strictEqual(state.ocrCalls.length, 1, 'Expected one OCR request for content validation');
  assert.strictEqual(state.ocrCalls[0], 'http://10.10.10.10:1234/v1/chat/completions', 'Expected OpenAI-compatible OCR endpoint');
}

async function testOllamaLocalOcrValidation() {
  const state = { modelCalls: [], ocrCalls: [] };

  const setupService = loadSetupServiceWithAxiosMock({
    get: async (url) => {
      state.modelCalls.push(url);
      return { status: 200, data: { models: [] } };
    },
    post: async (url) => {
      state.ocrCalls.push(url);
      return {
        data: {
          message: {
            content: 'OCR TEST 182730173401'
          }
        }
      };
    }
  });

  const valid = await setupService.validateOcrConfig({
    enabled: 'yes',
    provider: 'ollama',
    apiUrl: 'http://10.10.10.11:11434',
    model: 'gemma'
  });

  assert.strictEqual(valid, true, 'Expected Ollama OCR validation to pass');
  assert.strictEqual(state.modelCalls[0], 'http://10.10.10.11:11434/api/tags', 'Expected /api/tags probe for Ollama endpoint');
  assert.strictEqual(state.ocrCalls[0], 'http://10.10.10.11:11434/api/chat', 'Expected /api/chat OCR endpoint for Ollama-style APIs');
}

async function testOpenAiCompatibleBase64Fallback() {
  const state = { postBodies: [] };

  const setupService = loadSetupServiceWithAxiosMock({
    get: async () => ({ status: 200, data: { data: [{ id: 'gemma-vision' }] } }),
    post: async (_url, body) => {
      state.postBodies.push(body);

      if (state.postBodies.length === 1) {
        const error = new Error("'url' field must be a base64 encoded image");
        error.response = {
          data: {
            error: {
              message: "'url' field must be a base64 encoded image"
            }
          }
        };
        throw error;
      }

      return {
        data: {
          choices: [
            {
              message: {
                content: 'OCR-TEST-182730173401'
              }
            }
          ]
        }
      };
    }
  });

  const valid = await setupService.validateOcrConfig({
    enabled: 'yes',
    provider: 'ollama',
    apiUrl: 'http://10.10.10.12:1234/v1',
    apiKey: '',
    model: 'gemma-vision'
  });

  assert.strictEqual(valid, true, 'Expected OpenAI-compatible OCR validation to pass with base64 fallback');
  assert.strictEqual(state.postBodies.length, 2, 'Expected retry with alternate image payload');

  const firstUrl = String(state.postBodies[0]?.messages?.[0]?.content?.[1]?.image_url?.url || '');
  const secondUrl = String(state.postBodies[1]?.messages?.[0]?.content?.[1]?.image_url?.url || '');

  assert.ok(firstUrl.startsWith('data:image/'), 'Expected first attempt to use a data URL');
  assert.ok(!secondUrl.startsWith('data:image/'), 'Expected fallback attempt to use raw base64 only');
}

async function main() {
  await testOpenAiCompatibleLocalOcrValidation();
  await testOllamaLocalOcrValidation();
  await testOpenAiCompatibleBase64Fallback();
}

main()
  .then(() => {
    console.log('[PASS] setupService OCR validation supports both OpenAI-compatible /v1 and Ollama /api endpoints');
  })
  .catch((error) => {
    console.error('[FAIL] setupService OCR validation test failed:', error.message);
    process.exitCode = 1;
  });
