// Multi-page PDF OCR via poppler rendering: every rendered page is sent to
// the local vision model and the page texts are joined with blank lines.

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

const PAGE_IMAGES = {
  one: Buffer.from('page-1-image').toString('base64'),
  two: Buffer.from('page-2-image').toString('base64'),
  three: Buffer.from('page-3-image').toString('base64'),
};

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

function loadServiceWithMocks() {
  delete require.cache[configModulePath];
  delete require.cache[paperlessServiceModulePath];
  delete require.cache[popplerServiceModulePath];
  delete require.cache[documentModelModulePath];
  delete require.cache[aiServiceFactoryModulePath];
  delete require.cache[axiosModulePath];
  delete require.cache[mistralOcrServiceModulePath];

  const state = {
    calls: [],
    renderCalls: [],
    thumbnailCalls: 0,
    responsesByImage: {
      [PAGE_IMAGES.one]: 'Page one',
      [PAGE_IMAGES.two]: 'Page two',
      [PAGE_IMAGES.three]: 'Page three',
    },
  };

  const configMock = {
    mistralOcr: {
      enabled: 'yes',
      provider: 'ollama',
      apiUrl: '',
      apiKey: '',
      model: 'gemma3:12b',
      pdfRenderEnabled: 'yes',
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

  const popplerServiceMock = {
    isAvailable: async () => true,
    renderPdfToImages: async (pdfBuffer, options) => {
      state.renderCalls.push({ bufferLength: pdfBuffer.length, options });
      return {
        pages: [
          { base64: PAGE_IMAGES.one, mimeType: 'image/png', pageNumber: 1 },
          { base64: PAGE_IMAGES.two, mimeType: 'image/png', pageNumber: 2 },
          { base64: PAGE_IMAGES.three, mimeType: 'image/png', pageNumber: 3 },
        ],
        totalPages: 3,
        truncated: false,
      };
    },
  };

  const axiosMock = {
    post: async (url, body) => {
      state.calls.push({ url, body });
      const text = state.responsesByImage[extractImageBase64(body)] || '';
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
    exports: popplerServiceMock,
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

async function main() {
  const { service, state } = loadServiceWithMocks();

  const pdfBase64 = Buffer.from('pdf-binary-content').toString('base64');
  const progressCalls = [];

  const text = await service.performOcr(pdfBase64, 'application/pdf', 42, {
    onPageProgress: (pageNumber, pageCount) =>
      progressCalls.push([pageNumber, pageCount]),
  });

  assert.strictEqual(
    text,
    'Page one\n\nPage two\n\nPage three',
    'Expected page texts joined with blank lines'
  );

  assert.strictEqual(
    state.renderCalls.length,
    1,
    'Expected exactly one render call'
  );
  assert.deepStrictEqual(
    state.renderCalls[0].options,
    { maxPages: 10, dpi: 150 },
    'Expected configured maxPages and dpi to reach the renderer'
  );
  assert.strictEqual(
    state.renderCalls[0].bufferLength,
    Buffer.from('pdf-binary-content').length,
    'Expected the raw PDF bytes to reach the renderer'
  );

  assert.strictEqual(
    state.calls.length,
    3,
    'Expected one OCR request per rendered page'
  );
  for (const call of state.calls) {
    assert.strictEqual(
      call.url,
      'http://localhost:11434/api/chat',
      'Expected Ollama chat endpoint'
    );
    assert.strictEqual(
      call.body.messages[0].images.length,
      1,
      'Expected one image per request'
    );
  }

  assert.strictEqual(
    state.thumbnailCalls,
    0,
    'Expected no thumbnail fallback on the render path'
  );

  assert.deepStrictEqual(
    progressCalls,
    [
      [1, 3],
      [2, 3],
      [3, 3],
    ],
    'Expected per-page progress callbacks'
  );
}

main()
  .then(() => {
    console.log(
      '[PASS] Multi-page PDF OCR renders pages via poppler and joins page texts'
    );
  })
  .catch((error) => {
    console.error(
      '[FAIL] OCR PDF render multipage test failed:',
      error.message
    );
    process.exitCode = 1;
  });
