// Page failure policy on the PDF render path: a single failed page is
// skipped (no placeholder text), and only when every page fails does the
// OCR call reject. The thumbnail fallback must not kick in for per-page
// OCR failures — rendering itself succeeded.

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

function loadServiceWithMocks(responsesByImage) {
  delete require.cache[configModulePath];
  delete require.cache[paperlessServiceModulePath];
  delete require.cache[popplerServiceModulePath];
  delete require.cache[documentModelModulePath];
  delete require.cache[aiServiceFactoryModulePath];
  delete require.cache[axiosModulePath];
  delete require.cache[mistralOcrServiceModulePath];

  const state = {
    thumbnailCalls: 0,
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
    renderPdfToImages: async () => ({
      pages: [
        { base64: PAGE_IMAGES.one, mimeType: 'image/png', pageNumber: 1 },
        { base64: PAGE_IMAGES.two, mimeType: 'image/png', pageNumber: 2 },
        { base64: PAGE_IMAGES.three, mimeType: 'image/png', pageNumber: 3 },
      ],
      totalPages: 3,
      truncated: false,
    }),
  };

  const axiosMock = {
    post: async (url, body) => {
      const response = responsesByImage[extractImageBase64(body)];
      if (response instanceof Error) {
        throw response;
      }
      const text = response || '';
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
  // Scenario 1: one bad page is skipped, the rest survives.
  {
    const { service, state } = loadServiceWithMocks({
      [PAGE_IMAGES.one]: 'Page one',
      [PAGE_IMAGES.two]: new Error('simulated provider failure'),
      [PAGE_IMAGES.three]: 'Page three',
    });

    const text = await service.performOcr(
      'cGRmLWJhc2U2NA==',
      'application/pdf',
      42
    );

    assert.strictEqual(
      text,
      'Page one\n\nPage three',
      'Expected failed page to be skipped'
    );
    assert.strictEqual(
      state.thumbnailCalls,
      0,
      'Expected no thumbnail fallback for per-page OCR failures'
    );
    console.log('  ✓ single failed page is skipped');
  }

  // Scenario 2: when every page fails, the OCR call rejects.
  {
    const { service, state } = loadServiceWithMocks({
      [PAGE_IMAGES.one]: new Error('simulated provider failure'),
      [PAGE_IMAGES.two]: new Error('simulated provider failure'),
      [PAGE_IMAGES.three]: new Error('simulated provider failure'),
    });

    await assert.rejects(
      service.performOcr('cGRmLWJhc2U2NA==', 'application/pdf', 42),
      /simulated provider failure/,
      'Expected rejection when all pages fail'
    );
    assert.strictEqual(
      state.thumbnailCalls,
      0,
      'Expected no thumbnail fallback when all pages fail'
    );
    console.log('  ✓ all pages failing rejects the OCR call');
  }
}

main()
  .then(() => {
    console.log(
      '[PASS] PDF render page failure policy skips bad pages and rejects only on total failure'
    );
  })
  .catch((error) => {
    console.error(
      '[FAIL] OCR PDF render page failure test failed:',
      error.message
    );
    process.exitCode = 1;
  });
