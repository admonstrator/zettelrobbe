/**
 * Test: an empty OCR result must never be written back to Paperless-ngx
 *
 * processQueueItem() PATCHes its OCR text into the Paperless-ngx `content`
 * field, which already holds whatever Paperless-ngx extracted itself. A page
 * without recognisable text, or a degraded provider, produced "" — and the
 * app wrote that empty string over the existing text, with no copy anywhere to
 * restore it from. Nothing to write is a failed run, not a successful one.
 *
 * The same applies one level down: a local vision model that stopped at its
 * token limit returns a page cut off mid-sentence. OpenAI-compatible servers
 * report that as finish_reason "length", Ollama as done_reason "length"; either
 * way the fragment must not become the document's text.
 *
 * Covers:
 * 1. An empty OCR result does not reach Paperless-ngx (no PATCH, no write-back)
 * 2. ... and the queue item ends up 'failed' with a reason that says why
 * 3. A whitespace-only result is treated the same way
 * 4. A truncated OpenAI-compatible response is an error, not page text
 * 5. A truncated Ollama response is an error, not page text
 */

'use strict';

const assert = require('assert');

const axiosModulePath = require.resolve('axios');
const configModulePath = require.resolve('../config/config');
const paperlessServiceModulePath =
  require.resolve('../services/paperlessService');
const documentModelModulePath = require.resolve('../models/document');
const aiServiceFactoryModulePath =
  require.resolve('../services/aiServiceFactory');
const mistralOcrServiceModulePath =
  require.resolve('../services/mistralOcrService');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

function injectModule(modulePath, exportsObject) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsObject,
  };
}

/**
 * Loads mistralOcrService with every collaborator replaced, so nothing touches
 * the network, the database or the real Paperless-ngx client.
 */
function loadOcrServiceWithMocks() {
  delete require.cache[configModulePath];
  delete require.cache[paperlessServiceModulePath];
  delete require.cache[documentModelModulePath];
  delete require.cache[aiServiceFactoryModulePath];
  delete require.cache[mistralOcrServiceModulePath];
  delete require.cache[axiosModulePath];

  const state = {
    patchCalls: [],
    queueStatuses: [],
    failedRecords: [],
    progress: [],
    removedFromQueue: [],
    axiosPosts: [],
    axiosResponse: null,
  };

  const paperlessServiceMock = {
    initialize() {},
    client: {
      patch: async (url, payload) => {
        state.patchCalls.push({ url, payload });
        return { status: 200 };
      },
      get: async () => {
        throw new Error('network disabled in OCR guard test');
      },
    },
  };

  const documentModelMock = {
    getOcrQueueItem: async () => ({ document_id: 1952, title: 'Scan 1952' }),
    updateOcrQueueStatus: async (documentId, status, text, wroteBack) => {
      state.queueStatuses.push({ documentId, status, text, wroteBack });
      return true;
    },
    addFailedDocument: async (documentId, title, reason, source) => {
      state.failedRecords.push({ documentId, title, reason, source });
      return true;
    },
    resetFailedDocument: async () => true,
    removeFromOcrQueue: async (documentId) => {
      state.removedFromQueue.push(documentId);
      return true;
    },
  };

  const axiosMock = {
    post: async (url, body, options) => {
      state.axiosPosts.push({ url, body, options });
      if (typeof state.axiosResponse === 'function') {
        return state.axiosResponse(url);
      }
      return state.axiosResponse;
    },
    get: async () => {
      throw new Error('network disabled in OCR guard test');
    },
    create: () => axiosMock,
  };

  injectModule(paperlessServiceModulePath, paperlessServiceMock);
  injectModule(documentModelModulePath, documentModelMock);
  injectModule(aiServiceFactoryModulePath, {
    getService: () => ({
      analyzeDocument: async () => {
        throw new Error('AI analysis must not run in this test');
      },
    }),
  });
  injectModule(axiosModulePath, axiosMock);

  const mistralOcrService = require('../services/mistralOcrService');
  return { mistralOcrService, state };
}

/**
 * Runs processQueueItem() with a stubbed provider result and returns what the
 * pipeline did with it.
 */
async function runQueueItemWithOcrResult(ocrResult) {
  const { mistralOcrService, state } = loadOcrServiceWithMocks();

  mistralOcrService.downloadDocumentAsBase64 = async () => ({
    base64: 'QUJD',
    mimeType: 'application/pdf',
  });
  mistralOcrService.performOcr = async () => ocrResult;

  let writeBackCalled = false;
  const realWriteBack =
    mistralOcrService.writeBackContent.bind(mistralOcrService);
  mistralOcrService.writeBackContent = async (...args) => {
    writeBackCalled = true;
    return realWriteBack(...args);
  };

  let thrown = null;
  try {
    await mistralOcrService.processQueueItem(1952, {
      autoAnalyze: false,
      progressCallback: (step, message) =>
        state.progress.push({ step, message }),
    });
  } catch (error) {
    thrown = error;
  }

  return { state, thrown, writeBackCalled };
}

function assertRefusedEmptyResult({ state, thrown, writeBackCalled }, label) {
  assert.ok(thrown, `${label}: processQueueItem must fail`);
  assert.strictEqual(
    thrown.message,
    'OCR returned no text; refusing to overwrite document content',
    `${label}: unexpected error message`
  );
  assert.strictEqual(
    writeBackCalled,
    false,
    `${label}: writeBackContent must not be called`
  );
  assert.strictEqual(
    state.patchCalls.length,
    0,
    `${label}: no PATCH may reach Paperless-ngx`
  );
  assert.ok(
    state.queueStatuses.some((entry) => entry.status === 'failed'),
    `${label}: the queue item must end up 'failed'`
  );
  assert.ok(
    !state.queueStatuses.some((entry) => entry.status === 'done'),
    `${label}: the queue item must never be marked 'done'`
  );
  assert.strictEqual(
    state.removedFromQueue.length,
    0,
    `${label}: the queue row must be kept for a retry`
  );
  assert.ok(
    state.failedRecords.some((entry) => entry.source === 'ocr'),
    `${label}: the document must be recorded as an OCR failure`
  );
  assert.ok(
    state.progress.some(
      (entry) =>
        entry.step === 'error' &&
        String(entry.message).includes('refusing to overwrite')
    ),
    `${label}: the refusal must be emitted through the progress callback`
  );
}

async function main() {
  await test('Empty OCR result never reaches Paperless-ngx', async () => {
    assertRefusedEmptyResult(await runQueueItemWithOcrResult(''), 'empty');
  });

  await test('Whitespace-only OCR result never reaches Paperless-ngx', async () => {
    assertRefusedEmptyResult(
      await runQueueItemWithOcrResult('   \n\t  \n '),
      'whitespace'
    );
  });

  await test('Real OCR text is still written back', async () => {
    const { mistralOcrService, state } = loadOcrServiceWithMocks();
    mistralOcrService.downloadDocumentAsBase64 = async () => ({
      base64: 'QUJD',
      mimeType: 'application/pdf',
    });
    mistralOcrService.performOcr = async () => 'Invoice total 42.00 EUR';

    const result = await mistralOcrService.processQueueItem(1952, {
      autoAnalyze: false,
    });

    assert.strictEqual(result.wroteBack, true, 'expected a successful PATCH');
    assert.strictEqual(
      state.patchCalls.length,
      1,
      'expected exactly one PATCH'
    );
    assert.strictEqual(
      state.patchCalls[0].payload.content,
      'Invoice total 42.00 EUR',
      'expected the OCR text in the PATCH body'
    );
    assert.ok(
      state.queueStatuses.some((entry) => entry.status === 'done'),
      'expected the queue item to be marked done'
    );
  });

  await test('Truncated OpenAI-compatible response is an error, not page text', async () => {
    const { mistralOcrService, state } = loadOcrServiceWithMocks();
    mistralOcrService.resolveLocalOcrApiBase = async () => 'http://ocr.test/v1';
    mistralOcrService.detectedLocalApiMode = 'openai';
    state.axiosResponse = () => ({
      data: {
        choices: [
          {
            finish_reason: 'length',
            message: { content: 'Invoice total 42.0' },
          },
        ],
      },
    });

    await assert.rejects(
      () => mistralOcrService._performLocalOcrOnImage('QUJD', 'image/png'),
      /cut off at the token limit/,
      'a truncated page must not be returned as text'
    );
  });

  await test('Truncated Ollama response is an error, not page text', async () => {
    const { mistralOcrService, state } = loadOcrServiceWithMocks();
    mistralOcrService.resolveLocalOcrApiBase = async () =>
      'http://ocr.test:11434';
    mistralOcrService.detectedLocalApiMode = 'ollama';
    state.axiosResponse = () => ({
      data: {
        done_reason: 'length',
        message: { content: 'Invoice total 42.0' },
      },
    });

    await assert.rejects(
      () => mistralOcrService._performLocalOcrOnImage('QUJD', 'image/png'),
      /cut off at the token limit/,
      'a truncated page must not be returned as text'
    );
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌  ocr-empty-result-guard test crashed');
  console.error(error);
  process.exit(1);
});
