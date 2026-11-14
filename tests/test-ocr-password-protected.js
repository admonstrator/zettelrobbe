/**
 * Test: the OCR run stops at a password-protected PDF
 *
 * No OCR provider can read an encrypted PDF, and sending it anyway buys a
 * paid call for an error. processQueueItem() therefore checks the file after
 * the download and, before any provider is called, either unlocks it with a
 * stored password, waits for a version Paperless-ngx is still storing, or
 * marks the queue item as password protected so the OCR page offers the
 * unlock.
 *
 * Covers:
 * 1. Locked, no stored passwords: no provider call, the row is marked
 *    password protected and the failure reason says so
 * 2. Locked, a stored password fits: unlocked, no provider call, no failure
 * 3. Locked, no stored password fits: marked password protected
 * 4. Locked although unlocked moments ago: the row goes back to pending
 * 5. Not locked: the provider is called as before
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
const pdfPasswordServiceModulePath =
  require.resolve('../services/pdfPasswordService');
const pdfUnlockServiceModulePath =
  require.resolve('../services/pdfUnlockService');
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
 * @param {object} options
 * @param {boolean} options.locked whether the downloaded PDF needs a password
 * @param {string[]} [options.stored] the stored passwords
 * @param {string} [options.unlockOutcome] what pdfUnlockService.unlock answers
 * @param {boolean} [options.recentlyUnlocked]
 */
async function runQueueItem({
  locked,
  stored = [],
  unlockOutcome = 'no_match',
  recentlyUnlocked = false,
}) {
  for (const modulePath of [
    configModulePath,
    paperlessServiceModulePath,
    documentModelModulePath,
    aiServiceFactoryModulePath,
    pdfPasswordServiceModulePath,
    pdfUnlockServiceModulePath,
    mistralOcrServiceModulePath,
    axiosModulePath,
  ]) {
    delete require.cache[modulePath];
  }

  const state = {
    queueStatuses: [],
    marked: [],
    failedRecords: [],
    unlockCalls: [],
    ocrCalls: 0,
    progress: [],
  };

  injectModule(paperlessServiceModulePath, {
    initialize() {},
    client: {
      patch: async () => ({ status: 200 }),
      get: async () => {
        throw new Error('network disabled');
      },
    },
  });
  injectModule(documentModelModulePath, {
    getOcrQueueItem: async () => ({ document_id: 5, title: 'Payslip' }),
    updateOcrQueueStatus: async (documentId, status) => {
      state.queueStatuses.push(status);
      return true;
    },
    markOcrQueuePasswordProtected: async (documentId) => {
      state.marked.push(documentId);
      return true;
    },
    addFailedDocument: async (documentId, title, reason, source) => {
      state.failedRecords.push({ reason, source });
      return true;
    },
    resetFailedDocument: async () => true,
    removeFromOcrQueue: async () => true,
  });
  injectModule(aiServiceFactoryModulePath, {
    getService: () => ({
      analyzeDocument: async () => {
        throw new Error('AI analysis must not run in this test');
      },
    }),
  });
  const axiosMock = {
    post: async () => {
      throw new Error('no provider call expected');
    },
    get: async () => {
      throw new Error('network disabled');
    },
  };
  axiosMock.create = () => axiosMock;
  injectModule(axiosModulePath, axiosMock);
  injectModule(pdfPasswordServiceModulePath, {
    needsPassword: async () => locked,
  });
  injectModule(pdfUnlockServiceModulePath, {
    wasRecentlyUnlocked: () => recentlyUnlocked,
    storedPasswords: () => stored,
    unlock: async (documentId, options) => {
      state.unlockCalls.push({ documentId, options });
      return { documentId, outcome: unlockOutcome, message: unlockOutcome };
    },
  });

  const mistralOcrService = require('../services/mistralOcrService');
  mistralOcrService.downloadDocumentAsBase64 = async () => ({
    base64: Buffer.from('%PDF-1.7 encrypted').toString('base64'),
    mimeType: 'application/pdf',
  });
  mistralOcrService.performOcr = async () => {
    state.ocrCalls += 1;
    return 'Recognised text of the document';
  };
  mistralOcrService.writeBackContent = async () => true;

  let result = null;
  let thrown = null;
  try {
    result = await mistralOcrService.processQueueItem(5, {
      autoAnalyze: false,
      progressCallback: (step, message) =>
        state.progress.push({ step, message }),
    });
  } catch (error) {
    thrown = error;
  }
  return { state, result, thrown };
}

async function run() {
  await test('a locked PDF without stored passwords is marked, not sent', async () => {
    const { state, thrown } = await runQueueItem({ locked: true });
    assert.ok(thrown, 'the run fails');
    assert.strictEqual(thrown.code, 'password_protected');
    assert.strictEqual(state.ocrCalls, 0, 'no provider call');
    assert.deepStrictEqual(state.marked, [5]);
    assert.deepStrictEqual(state.failedRecords, [
      { reason: 'password_protected', source: 'ocr' },
    ]);
    assert.deepStrictEqual(state.unlockCalls, []);
    assert.ok(state.progress.some((p) => p.step === 'unlock'));
  });

  await test('a stored password that fits unlocks the document', async () => {
    const { state, result, thrown } = await runQueueItem({
      locked: true,
      stored: ['right'],
      unlockOutcome: 'unlocked',
    });
    assert.strictEqual(thrown, null);
    assert.strictEqual(result.unlocked, true);
    assert.strictEqual(state.ocrCalls, 0);
    assert.deepStrictEqual(state.marked, []);
    assert.deepStrictEqual(state.failedRecords, []);
    assert.strictEqual(state.unlockCalls.length, 1);
    assert.strictEqual(state.unlockCalls[0].options.fromOcrRun, true);
    assert.ok(Buffer.isBuffer(state.unlockCalls[0].options.file));
  });

  await test('no stored password fits: the row is marked', async () => {
    const { state, thrown } = await runQueueItem({
      locked: true,
      stored: ['a', 'b'],
      unlockOutcome: 'no_match',
    });
    assert.strictEqual(thrown.code, 'password_protected');
    assert.strictEqual(state.ocrCalls, 0);
    assert.deepStrictEqual(state.marked, [5]);
  });

  await test('a version still being stored makes the row wait', async () => {
    const { state, result, thrown } = await runQueueItem({
      locked: true,
      stored: ['right'],
      recentlyUnlocked: true,
    });
    assert.strictEqual(thrown, null);
    assert.strictEqual(result.waiting, true);
    assert.strictEqual(state.queueStatuses.at(-1), 'pending');
    assert.deepStrictEqual(state.unlockCalls, [], 'not unlocked a second time');
    assert.deepStrictEqual(state.failedRecords, []);
    assert.strictEqual(state.ocrCalls, 0);
  });

  await test('an open PDF goes to the provider as before', async () => {
    const { state, thrown } = await runQueueItem({ locked: false });
    assert.strictEqual(thrown, null);
    assert.strictEqual(state.ocrCalls, 1);
    assert.deepStrictEqual(state.marked, []);
    assert.ok(state.queueStatuses.includes('done'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
