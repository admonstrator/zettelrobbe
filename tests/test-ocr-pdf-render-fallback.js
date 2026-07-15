// PDF render fallback behavior: when poppler is unavailable, disabled, or
// rendering fails, local OCR must fall back to the first-page thumbnail
// (the pre-poppler behavior) instead of failing.

const assert = require('assert');

const configModulePath = require.resolve('../config/config');
const paperlessServiceModulePath =
  require.resolve('../services/paperlessService');
const popplerServiceModulePath = require.resolve('../services/popplerService');
const documentModelModulePath = require.resolve('../models/document');
const aiServiceFactoryModulePath =
  require.resolve('../services/aiServiceFactory');
const axiosModulePath = require.resolve('axios');
const mistralOcrServiceModulePath =
  require.resolve('../services/mistralOcrService');

const THUMBNAIL_BASE64 = Buffer.from('thumbnail-image-binary').toString(
  'base64'
);

function extractImageBase64(body) {
  if (Array.isArray(body?.messages?.[0]?.images)) {
    return body.messages[0].images[0];
  }
  const imagePart = (body?.messages?.[0]?.content || []).find(
    (part) => part.type === 'image_url'
  );
  const url = imagePart?.image_url?.url || '';
  return url.startsWith('data:') ? url.split(',')[1] : url;
}

function loadServiceWithMocks({ pdfRenderEnabled, popplerMock }) {
  delete require.cache[configModulePath];
  delete require.cache[paperlessServiceModulePath];
  delete require.cache[popplerServiceModulePath];
  delete require.cache[documentModelModulePath];
  delete require.cache[aiServiceFactoryModulePath];
  delete require.cache[axiosModulePath];
  delete require.cache[mistralOcrServiceModulePath];

  const state = {
    calls: [],
    thumbnailCalls: 0,
  };

  const configMock = {
    mistralOcr: {
      enabled: 'yes',
      provider: 'ollama',
      apiUrl: '',
      apiKey: '',
      model: 'gemma3:12b',
      pdfRenderEnabled,
      pdfRenderMaxPages: 10,
      pdfRenderDpi: 150,
    },
    ollama: {
      apiUrl: 'http://localhost:11434',
    },
    limitFunctions: {
      activateTagging: 'yes',
      activateTitle: 'yes',
      activateDocumentType: 'yes',
      activateCorrespondents: 'yes',
    },
  };

  const paperlessServiceMock = {
    getThumbnailImage: async () => {
      state.thumbnailCalls += 1;
      return Buffer.from('thumbnail-image-binary');
    },
  };

  const axiosMock = {
    post: async (url, body) => {
      state.calls.push({ url, body });
      const text =
        extractImageBase64(body) === THUMBNAIL_BASE64 ? 'Thumbnail text' : '';
      if (url.endsWith('/api/chat')) {
        return { data: { message: { content: text } } };
      }
      return { data: { choices: [{ message: { content: text } }] } };
    },
  };

  require.cache[configModulePath] = {
    id: configModulePath,
    filename: configModulePath,
    loaded: true,
    exports: configMock,
  };

  require.cache[paperlessServiceModulePath] = {
    id: paperlessServiceModulePath,
    filename: paperlessServiceModulePath,
    loaded: true,
    exports: paperlessServiceMock,
  };

  require.cache[popplerServiceModulePath] = {
    id: popplerServiceModulePath,
    filename: popplerServiceModulePath,
    loaded: true,
    exports: popplerMock,
  };

  require.cache[documentModelModulePath] = {
    id: documentModelModulePath,
    filename: documentModelModulePath,
    loaded: true,
    exports: {},
  };

  require.cache[aiServiceFactoryModulePath] = {
    id: aiServiceFactoryModulePath,
    filename: aiServiceFactoryModulePath,
    loaded: true,
    exports: { getService: () => ({}) },
  };

  require.cache[axiosModulePath] = {
    id: axiosModulePath,
    filename: axiosModulePath,
    loaded: true,
    exports: axiosMock,
  };

  const service = require('../services/mistralOcrService');
  return { service, state };
}

async function runScenario(
  name,
  { pdfRenderEnabled, popplerMock, expectRenderCalls }
) {
  const renderCalls = [];
  const instrumentedPopplerMock = {
    isAvailable: popplerMock.isAvailable,
    renderPdfToImages: async (...args) => {
      renderCalls.push(args);
      return popplerMock.renderPdfToImages(...args);
    },
  };

  const { service, state } = loadServiceWithMocks({
    pdfRenderEnabled,
    popplerMock: instrumentedPopplerMock,
  });

  const text = await service.performOcr(
    'cGRmLWJhc2U2NA==',
    'application/pdf',
    42
  );

  assert.strictEqual(
    text,
    'Thumbnail text',
    `[${name}] Expected thumbnail OCR text`
  );
  assert.strictEqual(
    state.thumbnailCalls,
    1,
    `[${name}] Expected exactly one thumbnail fetch`
  );
  assert.strictEqual(
    state.calls.length,
    1,
    `[${name}] Expected exactly one OCR request`
  );
  assert.strictEqual(
    renderCalls.length,
    expectRenderCalls,
    `[${name}] Unexpected number of render attempts`
  );

  console.log(`  ✓ ${name}`);
}

async function main() {
  await runScenario('poppler unavailable -> thumbnail fallback', {
    pdfRenderEnabled: 'yes',
    popplerMock: {
      isAvailable: async () => false,
      renderPdfToImages: async () => {
        throw new Error(
          'renderPdfToImages must not be called when unavailable'
        );
      },
    },
    expectRenderCalls: 0,
  });

  await runScenario('render disabled -> thumbnail fallback', {
    pdfRenderEnabled: 'no',
    popplerMock: {
      isAvailable: async () => true,
      renderPdfToImages: async () => {
        throw new Error('renderPdfToImages must not be called when disabled');
      },
    },
    expectRenderCalls: 0,
  });

  await runScenario('render failure -> thumbnail fallback', {
    pdfRenderEnabled: 'yes',
    popplerMock: {
      isAvailable: async () => true,
      renderPdfToImages: async () => {
        throw new Error('pdftoppm exited with code 1');
      },
    },
    expectRenderCalls: 1,
  });
}

main()
  .then(() => {
    console.log('[PASS] PDF render fallback keeps thumbnail OCR working');
  })
  .catch((error) => {
    console.error('[FAIL] OCR PDF render fallback test failed:', error.message);
    process.exitCode = 1;
  });
