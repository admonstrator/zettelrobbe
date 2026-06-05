const assert = require('assert');

const configModulePath = require.resolve('../config/config');
const paperlessServiceModulePath = require.resolve('../services/paperlessService');
const documentModelModulePath = require.resolve('../models/document');
const aiServiceFactoryModulePath = require.resolve('../services/aiServiceFactory');
const axiosModulePath = require.resolve('axios');
const mistralOcrServiceModulePath = require.resolve('../services/mistralOcrService');

function loadServiceWithMocks() {
  delete require.cache[configModulePath];
  delete require.cache[paperlessServiceModulePath];
  delete require.cache[documentModelModulePath];
  delete require.cache[aiServiceFactoryModulePath];
  delete require.cache[axiosModulePath];
  delete require.cache[mistralOcrServiceModulePath];

  const state = {
    calls: []
  };

  const configMock = {
    mistralOcr: {
      enabled: 'yes',
      provider: 'ollama',
      apiUrl: 'http://localhost:1234/v1',
      apiKey: '',
      model: 'gemma-3-vision'
    },
    ollama: {
      apiUrl: 'http://localhost:11434'
    },
    limitFunctions: {
      activateTagging: 'yes',
      activateTitle: 'yes',
      activateDocumentType: 'yes',
      activateCorrespondents: 'yes'
    }
  };

  const paperlessServiceMock = {
    getThumbnailImage: async () => Buffer.from('thumbnail-image-binary')
  };

  const axiosMock = {
    post: async (url, body) => {
      state.calls.push({ url, body });
      return {
        data: {
          choices: [
            {
              message: {
                content: 'Extracted OCR text from LM Studio'
              }
            }
          ]
        }
      };
    }
  };

  require.cache[configModulePath] = {
    id: configModulePath,
    filename: configModulePath,
    loaded: true,
    exports: configMock
  };

  require.cache[paperlessServiceModulePath] = {
    id: paperlessServiceModulePath,
    filename: paperlessServiceModulePath,
    loaded: true,
    exports: paperlessServiceMock
  };

  require.cache[documentModelModulePath] = {
    id: documentModelModulePath,
    filename: documentModelModulePath,
    loaded: true,
    exports: {}
  };

  require.cache[aiServiceFactoryModulePath] = {
    id: aiServiceFactoryModulePath,
    filename: aiServiceFactoryModulePath,
    loaded: true,
    exports: { getService: () => ({}) }
  };

  require.cache[axiosModulePath] = {
    id: axiosModulePath,
    filename: axiosModulePath,
    loaded: true,
    exports: axiosMock
  };

  const service = require('../services/mistralOcrService');
  return { service, state };
}

async function main() {
  const { service, state } = loadServiceWithMocks();

  const text = await service.performOcr('cGRmLWJhc2U2NA==', 'application/pdf', 77);

  assert.strictEqual(text, 'Extracted OCR text from LM Studio', 'Expected OCR text from LM Studio response');
  assert.strictEqual(state.calls.length, 1, 'Expected one LM Studio API call');

  const [call] = state.calls;
  assert.strictEqual(call.url, 'http://localhost:1234/v1/chat/completions', 'Expected OpenAI-compatible endpoint');
  assert.strictEqual(call.body.model, 'gemma-3-vision', 'Expected OCR model from config');
  assert.ok(Array.isArray(call.body.messages), 'Expected messages array for OpenAI-compatible payload');
  assert.ok(Array.isArray(call.body.messages[0].content), 'Expected multimodal content array');
  assert.strictEqual(call.body.messages[0].content[0].type, 'text', 'Expected text prompt part');
  assert.strictEqual(call.body.messages[0].content[1].type, 'image_url', 'Expected image URL prompt part');
}

main()
  .then(() => {
    console.log('[PASS] LM Studio OpenAI-compatible OCR endpoint is used when OCR_API_URL ends with /v1');
  })
  .catch((error) => {
    console.error('[FAIL] LM Studio compatibility OCR test failed:', error.message);
    process.exitCode = 1;
  });
