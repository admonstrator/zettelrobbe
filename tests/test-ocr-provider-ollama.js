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
      apiUrl: '',
      apiKey: '',
      model: 'gemma3:12b'
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
      return { data: { message: { content: 'Extracted OCR text' } } };
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

  const text = await service.performOcr('cGRmLWJhc2U2NA==', 'application/pdf', 42);

  assert.strictEqual(text, 'Extracted OCR text', 'Expected OCR text from Ollama response');
  assert.strictEqual(state.calls.length, 1, 'Expected one Ollama API call');

  const [call] = state.calls;
  assert.strictEqual(call.url, 'http://localhost:11434/api/chat', 'Expected Ollama chat endpoint');
  assert.strictEqual(call.body.model, 'gemma3:12b', 'Expected OCR model from config');
  assert.strictEqual(call.body.stream, false, 'Expected non-streaming OCR request');
  assert.ok(Array.isArray(call.body.messages), 'Expected chat messages payload');
  assert.ok(Array.isArray(call.body.messages[0].images), 'Expected image payload for OCR');
  assert.strictEqual(call.body.messages[0].images.length, 1, 'Expected exactly one image in OCR payload');
}

main()
  .then(() => {
    console.log('[PASS] Ollama OCR provider supports local model OCR with thumbnail fallback');
  })
  .catch((error) => {
    console.error('[FAIL] OCR provider ollama test failed:', error.message);
    process.exitCode = 1;
  });
