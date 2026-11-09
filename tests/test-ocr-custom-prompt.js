const assert = require('assert');

const configModulePath = require.resolve('../config/config');
const paperlessServiceModulePath =
  require.resolve('../services/paperlessService');
const documentModelModulePath = require.resolve('../models/document');
const aiServiceFactoryModulePath =
  require.resolve('../services/aiServiceFactory');
const axiosModulePath = require.resolve('axios');
const mistralOcrServiceModulePath =
  require.resolve('../services/mistralOcrService');

// The wording the service had before OCR_PROMPT existed. Instances that never
// set the new key must keep sending it, otherwise an upgrade silently changes
// what every OCR prompt says.
const BUILT_IN_INSTRUCTION =
  'Perform OCR on this image. Return only the extracted text in plain text. Do not add explanations.';

const CUSTOM_INSTRUCTION =
  'Extract every visible text exactly as written. Keep tables. Mark unreadable stretches with [unleserlich].';

function loadServiceWithMocks({ apiUrl, ocrPrompt }) {
  delete require.cache[configModulePath];
  delete require.cache[paperlessServiceModulePath];
  delete require.cache[documentModelModulePath];
  delete require.cache[aiServiceFactoryModulePath];
  delete require.cache[axiosModulePath];
  delete require.cache[mistralOcrServiceModulePath];

  const state = {
    calls: [],
  };

  const mistralOcr = {
    enabled: 'yes',
    provider: 'ollama',
    apiUrl,
    apiKey: '',
    model: 'gemma-3-vision',
  };
  if (ocrPrompt !== undefined) {
    mistralOcr.prompt = ocrPrompt;
  }

  const configMock = {
    mistralOcr,
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
    getThumbnailImage: async () => Buffer.from('thumbnail-image-binary'),
  };

  const documentModelMock = {
    update: async () => true,
  };

  const aiServiceMock = {
    analyzeDocumentContent: async () => ({
      tags: [1],
      title: 'Title',
      documentType: 'Invoice',
      correspondents: [1],
    }),
  };

  // One response shape that satisfies both the OpenAI-compatible reader
  // (choices[0].message.content) and the Ollama reader (message.content).
  const axiosMock = {
    post: async (url, body) => {
      state.calls.push({ url, body });
      return {
        data: {
          choices: [
            {
              message: {
                content: 'Extracted OCR text',
              },
            },
          ],
          message: {
            content: 'Extracted OCR text',
          },
        },
      };
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

  require.cache[documentModelModulePath] = {
    id: documentModelModulePath,
    filename: documentModelModulePath,
    loaded: true,
    exports: documentModelMock,
  };

  require.cache[aiServiceFactoryModulePath] = {
    id: aiServiceFactoryModulePath,
    filename: aiServiceFactoryModulePath,
    loaded: true,
    exports: {
      getAiService: () => aiServiceMock,
    },
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
  const openAiTarget = 'http://localhost:1234/v1';
  const ollamaTarget = 'http://localhost:11434';

  // 1. OpenAI-compatible provider without OCR_PROMPT keeps the built-in text.
  const plain = loadServiceWithMocks({ apiUrl: openAiTarget });
  await plain.service.performOcr('cGRmLWJhc2U2NA==', 'application/pdf', 42);
  assert.strictEqual(
    plain.state.calls.length,
    1,
    'Expected one chat completion request'
  );
  const [plainCall] = plain.state.calls;
  assert.strictEqual(plainCall.url, `${openAiTarget}/chat/completions`);
  assert.strictEqual(
    plainCall.body.messages[0].content[0].text,
    BUILT_IN_INSTRUCTION,
    'Expected the built-in instruction when OCR_PROMPT is not set'
  );

  // 2. OCR_PROMPT replaces it verbatim, so operators control what the vision
  //    model is asked to do with their documents.
  const custom = loadServiceWithMocks({
    apiUrl: openAiTarget,
    ocrPrompt: CUSTOM_INSTRUCTION,
  });
  await custom.service.performOcr('cGRmLWJhc2U2NA==', 'application/pdf', 42);
  const [customCall] = custom.state.calls;
  assert.strictEqual(
    customCall.body.messages[0].content[0].text,
    CUSTOM_INSTRUCTION,
    'Expected the configured OCR instruction in the chat completion request'
  );

  // 3. Ollama's native chat payload carries the same override.
  const ollamaPlain = loadServiceWithMocks({ apiUrl: '' });
  await ollamaPlain.service.performOcr(
    'cGRmLWJhc2U2NA==',
    'application/pdf',
    43
  );
  const [ollamaPlainCall] = ollamaPlain.state.calls;
  assert.strictEqual(ollamaPlainCall.url, `${ollamaTarget}/api/chat`);
  assert.strictEqual(
    ollamaPlainCall.body.messages[0].content,
    BUILT_IN_INSTRUCTION,
    'Expected the built-in instruction for Ollama when OCR_PROMPT is not set'
  );

  const ollamaCustom = loadServiceWithMocks({
    apiUrl: '',
    ocrPrompt: CUSTOM_INSTRUCTION,
  });
  await ollamaCustom.service.performOcr(
    'cGRmLWJhc2U2NA==',
    'application/pdf',
    43
  );
  const [ollamaCustomCall] = ollamaCustom.state.calls;
  assert.strictEqual(ollamaCustomCall.url, `${ollamaTarget}/api/chat`);
  assert.strictEqual(
    ollamaCustomCall.body.messages[0].content,
    CUSTOM_INSTRUCTION,
    'Expected the configured OCR instruction for Ollama'
  );

  // 4. A whitespace-only instruction counts as unset: an empty prompt would
  //    crowd out the instruction that makes the model return text at all.
  const blank = loadServiceWithMocks({
    apiUrl: openAiTarget,
    ocrPrompt: '   ',
  });
  await blank.service.performOcr('cGRmLWJhc2U2NA==', 'application/pdf', 44);
  assert.strictEqual(
    blank.state.calls[0].body.messages[0].content[0].text,
    BUILT_IN_INSTRUCTION,
    'Expected an empty OCR_PROMPT to fall back to the built-in instruction'
  );

  console.log('✓ custom OCR prompt test passed');
}

main().catch((error) => {
  console.error('✗ custom OCR prompt test failed:', error.message);
  process.exit(1);
});
