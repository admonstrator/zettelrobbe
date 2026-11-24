/**
 * Test: unlocking a password-protected PDF through Paperless-ngx
 *
 * pdfUnlockService checks passwords locally and hands only the one that opens
 * the file to Paperless-ngx, which stores the unlocked file as a new version.
 * Afterwards the document leaves the OCR queue and the failed list, and its
 * follow-up (services/unlockFollowUpService.js, replaced here) processes it
 * once Paperless-ngx has stored that version. These tests pin that order and
 * every outcome on the way, with Paperless-ngx, the database, pdfinfo and the
 * follow-up replaced.
 *
 * Covers:
 * 1. A typed password that opens the file reaches Paperless-ngx, the document
 *    is released and counts as just unlocked, and its follow-up starts with
 *    the versions read before the removal
 * 2. The stored list is tried when no password is typed
 * 3. A password that does not open the file never reaches Paperless-ngx
 * 4. Paperless-ngx before 3.0 is refused before any download
 * 5. A file that no longer needs a password is released without a request
 *    and processed right away
 * 6. Paperless-ngx refusing the password is reported, nothing is released
 * 7. No password and no stored list: nothing is downloaded
 * 8. A document OCR is reading right now is left alone
 * 9. The list run works through every locked queue item
 * 10. Automatic processing off: no follow-up, and the message says so
 * 11. A document whose follow-up still waits is not unlocked a second time
 * 12. Versions that cannot be read do not stop the unlock
 * 13. paperlessService.removePassword(): the request and its error mapping
 * 14. paperlessService.getDocumentVersionIds(): the request and the answer
 */

'use strict';

const assert = require('assert');

const configPath = require.resolve('../config/config.js');
const documentModelPath = require.resolve('../models/document.js');
const paperlessServicePath = require.resolve('../services/paperlessService.js');
const pdfPasswordServicePath =
  require.resolve('../services/pdfPasswordService');
const mistralOcrServicePath = require.resolve('../services/mistralOcrService');
const pdfUnlockServicePath = require.resolve('../services/pdfUnlockService');
const unlockFollowUpServicePath =
  require.resolve('../services/unlockFollowUpService');

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

function inject(modulePath, exportsObject) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsObject,
  };
}

const FILE = Buffer.from('%PDF-1.7 locked');

/**
 * Loads pdfUnlockService with every collaborator replaced.
 *
 * @param {object} [options]
 * @param {string} [options.stored] PDF_PASSWORDS as stored
 * @param {string|null} [options.opensWith] the password that opens the file
 * @param {boolean} [options.locked] whether the file needs a password at all
 * @param {string|null} [options.version] the Paperless-ngx version
 * @param {Error|null} [options.removeError] what removePassword throws
 * @param {boolean} [options.ocrBusy] OCR is reading the document
 * @param {boolean} [options.automaticOff] DISABLE_AUTOMATIC_PROCESSING=yes
 * @param {number[]} [options.waiting] documents whose follow-up still waits
 * @param {number[]|null} [options.versions] the version ids Paperless-ngx lists
 * @param {Error|null} [options.versionsError] what reading them throws
 */
function load({
  stored = '',
  opensWith = 'right',
  locked = true,
  version = '3.4.2',
  removeError = null,
  ocrBusy = false,
  automaticOff = false,
  waiting = [],
  versions = [70],
  versionsError = null,
} = {}) {
  const state = {
    downloads: [],
    removed: [],
    tried: [],
    releasedFromQueue: [],
    historyForgotten: [],
    failedReset: [],
    scheduled: [],
    versionReads: [],
    order: [],
  };

  for (const modulePath of [
    configPath,
    documentModelPath,
    paperlessServicePath,
    pdfPasswordServicePath,
    mistralOcrServicePath,
    pdfUnlockServicePath,
    unlockFollowUpServicePath,
  ]) {
    delete require.cache[modulePath];
  }

  const realPasswordService = require('../services/pdfPasswordService');
  delete require.cache[pdfPasswordServicePath];

  inject(configPath, { mistralOcr: { pdfPasswords: stored } });
  inject(documentModelPath, {
    removeFromOcrQueue: async (id) => {
      state.releasedFromQueue.push(id);
      state.order.push('release');
      return true;
    },
    forgetOcrQueueHistory: async (id) => {
      state.historyForgotten.push(id);
      return true;
    },
    resetFailedDocument: async (id) => {
      state.failedReset.push(id);
      return true;
    },
    getPasswordProtectedOcrItems: async () => [
      { document_id: 11, title: 'Payslip May' },
      { document_id: 12, title: 'Payslip June' },
    ],
  });
  inject(paperlessServicePath, {
    getPasswordRemovalSupport: async () => ({
      supported: version === null || Number.parseInt(version, 10) >= 3,
      version,
    }),
    downloadOriginalFile: async (id) => {
      state.downloads.push(id);
      return { buffer: FILE, mimeType: 'application/pdf' };
    },
    removePassword: async (id, password) => {
      if (removeError) throw removeError;
      state.removed.push({ id, password });
      state.order.push('remove');
    },
    getDocumentVersionIds: async (id) => {
      state.versionReads.push(id);
      state.order.push('versions');
      if (versionsError) throw versionsError;
      return versions;
    },
  });
  inject(pdfPasswordServicePath, {
    parsePasswordList: realPasswordService.parsePasswordList,
    needsPassword: async () => locked,
    findPassword: async (_buffer, candidates) => {
      state.tried.push([...candidates]);
      return candidates.includes(opensWith) ? opensWith : null;
    },
  });
  inject(mistralOcrServicePath, {
    isDocumentActivelyProcessing: () => ocrBusy,
  });
  inject(unlockFollowUpServicePath, {
    isAutomaticProcessingOff: () => automaticOff,
    isWaiting: (id) => waiting.includes(id),
    schedule: (id, options) => {
      state.scheduled.push({ id, ...options });
      state.order.push('schedule');
      return automaticOff ? 'automatic_processing_off' : 'scheduled';
    },
  });

  const service = require('../services/pdfUnlockService');
  return { service, state };
}

/** Runs fn with the console quiet; the warnings are expected. */
async function quietly(fn) {
  const saved = { warn: console.warn, log: console.log };
  console.warn = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

async function run() {
  await test('a typed password that opens the file unlocks the document', async () => {
    const { service, state } = load();
    const result = await service.unlock(7, { password: 'right' });
    assert.strictEqual(result.outcome, 'unlocked');
    assert.deepStrictEqual(state.downloads, [7]);
    assert.deepStrictEqual(state.tried, [['right']]);
    assert.deepStrictEqual(state.removed, [{ id: 7, password: 'right' }]);
    assert.deepStrictEqual(state.releasedFromQueue, [7]);
    // No provider read the locked file: OCR before AI may send it once more.
    assert.deepStrictEqual(state.historyForgotten, [7]);
    assert.deepStrictEqual(state.failedReset, [7]);
    assert.strictEqual(service.wasRecentlyUnlocked(7), true);
    assert.strictEqual(service.wasRecentlyUnlocked(8), false);
    // The versions are read before the removal, the follow-up starts after
    // the release, and the message no longer promises the next scan.
    assert.deepStrictEqual(state.order, [
      'versions',
      'remove',
      'release',
      'schedule',
    ]);
    assert.deepStrictEqual(state.scheduled, [{ id: 7, versionsBefore: [70] }]);
    assert.match(
      result.message,
      /analysed as soon as Paperless-ngx has stored the unlocked version/
    );
    assert.doesNotMatch(result.message, /next scan/);
  });

  await test('without a typed password the stored list is tried', async () => {
    const { service, state } = load({ stored: '["a","right","c"]' });
    const result = await service.unlock(7);
    assert.strictEqual(result.outcome, 'unlocked');
    assert.deepStrictEqual(state.tried, [['a', 'right', 'c']]);
    assert.deepStrictEqual(state.removed, [{ id: 7, password: 'right' }]);
  });

  await test('a password that does not open the file stays here', async () => {
    const { service, state } = load({ stored: '["a","b"]' });
    const typed = await service.unlock(7, { password: 'wrong' });
    assert.strictEqual(typed.outcome, 'no_match');
    const listed = await service.unlock(7);
    assert.strictEqual(listed.outcome, 'no_match');
    assert.match(listed.message, /2 stored/);
    assert.deepStrictEqual(state.removed, []);
    assert.deepStrictEqual(state.releasedFromQueue, []);
    assert.deepStrictEqual(state.historyForgotten, []);
  });

  await test('Paperless-ngx before 3.0 is refused before any download', async () => {
    const { service, state } = load({ version: '2.20.15' });
    const result = await service.unlock(7, { password: 'right' });
    assert.strictEqual(result.outcome, 'unsupported');
    assert.match(result.message, /2\.20\.15/);
    assert.deepStrictEqual(state.downloads, []);
    assert.deepStrictEqual(state.removed, []);
  });

  await test('a file that no longer needs a password is released', async () => {
    const { service, state } = load({ locked: false });
    const result = await service.unlock(7, { password: 'whatever' });
    assert.strictEqual(result.outcome, 'not_locked');
    assert.deepStrictEqual(state.removed, []);
    assert.deepStrictEqual(state.releasedFromQueue, [7]);
    assert.deepStrictEqual(state.failedReset, [7]);
    // The file it serves already opens: nothing to wait for.
    assert.deepStrictEqual(state.versionReads, []);
    assert.deepStrictEqual(state.scheduled, [{ id: 7, versionStored: true }]);
    assert.match(result.message, /analysed right away/);
    assert.doesNotMatch(result.message, /next scan/);
  });

  await test('Paperless-ngx refusing the password is reported', async () => {
    const error = new Error('Paperless-ngx could not decrypt the document');
    error.code = 'rejected';
    const { service, state } = load({ removeError: error });
    const result = await service.unlock(7, { password: 'right' });
    assert.strictEqual(result.outcome, 'rejected');
    assert.deepStrictEqual(state.releasedFromQueue, []);
    assert.strictEqual(service.wasRecentlyUnlocked(7), false);
    assert.deepStrictEqual(state.scheduled, [], 'no follow-up');
  });

  await test('no password and no stored list: nothing is downloaded', async () => {
    const { service, state } = load({ stored: '' });
    const result = await service.unlock(7);
    assert.strictEqual(result.outcome, 'no_passwords');
    assert.deepStrictEqual(state.downloads, []);
  });

  await test('a document OCR is reading is left alone', async () => {
    const { service, state } = load({ ocrBusy: true });
    const result = await service.unlock(7, { password: 'right' });
    assert.strictEqual(result.outcome, 'busy');
    assert.deepStrictEqual(state.downloads, []);
    // The OCR run itself may unlock with the file it already holds.
    const fromRun = await service.unlock(7, {
      password: 'right',
      file: FILE,
      fromOcrRun: true,
    });
    assert.strictEqual(fromRun.outcome, 'unlocked');
    assert.deepStrictEqual(state.downloads, []);
  });

  await test('the list run works through every locked item', async () => {
    const { service, state } = load({ stored: '["right"]' });
    const seen = [];
    const summary = await service.unlockAllLocked((item, index, total) =>
      seen.push([item.documentId, item.title, item.outcome, index, total])
    );
    assert.deepStrictEqual(summary, { total: 2, unlocked: 2, stillLocked: 0 });
    assert.deepStrictEqual(seen, [
      [11, 'Payslip May', 'unlocked', 0, 2],
      [12, 'Payslip June', 'unlocked', 1, 2],
    ]);
    assert.deepStrictEqual(
      state.removed.map((r) => r.id),
      [11, 12]
    );
    assert.deepStrictEqual(
      state.scheduled.map((entry) => entry.id),
      [11, 12]
    );
  });

  await test('automatic processing off: no follow-up, a scan by hand', async () => {
    const { service, state } = load({ automaticOff: true });
    const unlocked = await service.unlock(7, { password: 'right' });
    assert.strictEqual(unlocked.outcome, 'unlocked');
    assert.deepStrictEqual(state.versionReads, [], 'nothing to compare with');
    assert.deepStrictEqual(state.releasedFromQueue, [7]);
    assert.match(unlocked.message, /Automatic processing is off/);
    assert.match(unlocked.message, /scan you start by hand/);

    const open = load({ automaticOff: true, locked: false });
    const notLocked = await open.service.unlock(8, { password: 'right' });
    assert.strictEqual(notLocked.outcome, 'not_locked');
    assert.match(notLocked.message, /scan you start by hand/);
  });

  await test('a document whose follow-up still waits is not unlocked twice', async () => {
    const { service, state } = load({ waiting: [7] });
    const result = await service.unlock(7, { password: 'right' });
    assert.strictEqual(result.outcome, 'busy');
    assert.match(result.message, /still storing the unlocked version/);
    assert.deepStrictEqual(state.downloads, []);
    assert.deepStrictEqual(state.removed, []);
    assert.deepStrictEqual(state.scheduled, []);
  });

  await test('versions that cannot be read do not stop the unlock', async () => {
    const { service, state } = load({
      versionsError: new Error('socket hang up'),
    });
    const result = await quietly(() =>
      service.unlock(7, { password: 'right' })
    );
    assert.strictEqual(result.outcome, 'unlocked');
    assert.deepStrictEqual(state.removed, [{ id: 7, password: 'right' }]);
    // The follow-up asks the file itself instead.
    assert.deepStrictEqual(state.scheduled, [{ id: 7, versionsBefore: null }]);
  });

  await test('removePassword() asks for a new version and maps refusals', async () => {
    for (const modulePath of [configPath, paperlessServicePath]) {
      delete require.cache[modulePath];
    }
    const paperlessService = require('../services/paperlessService.js');
    const posts = [];
    let status = null;
    paperlessService.initialize = () => {};
    paperlessService.client = {
      post: async (url, body) => {
        posts.push({ url, body });
        if (status) {
          const error = new Error(`HTTP ${status}`);
          error.response = { status };
          throw error;
        }
        return { data: { result: 'OK' } };
      },
    };
    await paperlessService.removePassword(42, 'pw');
    assert.deepStrictEqual(posts, [
      {
        url: '/documents/remove_password/',
        body: {
          documents: [42],
          password: 'pw',
          update_document: true,
          include_metadata: true,
        },
      },
    ]);
    for (const [code, expected] of [
      [404, 'unsupported'],
      [403, 'forbidden'],
      [400, 'rejected'],
      [502, undefined],
    ]) {
      status = code;
      await assert.rejects(paperlessService.removePassword(42, 'pw'), (e) => {
        assert.strictEqual(e.code, expected);
        assert.ok(!String(e.message).includes('pw'), 'no password in errors');
        return true;
      });
    }
    delete require.cache[paperlessServicePath];
    delete require.cache[configPath];
  });

  await test('getDocumentVersionIds() reads the version list of one document', async () => {
    for (const modulePath of [configPath, paperlessServicePath]) {
      delete require.cache[modulePath];
    }
    const paperlessService = require('../services/paperlessService.js');
    const gets = [];
    let data = {
      id: 42,
      versions: [
        { id: 57, added: '2026-11-18T10:00:00Z', is_root: false },
        { id: 42, added: '2026-11-01T08:00:00Z', is_root: true },
      ],
    };
    paperlessService.initialize = () => {};
    paperlessService.client = {
      get: async (url, options) => {
        gets.push({ url, options });
        return { data };
      },
    };
    assert.deepStrictEqual(
      await paperlessService.getDocumentVersionIds(42),
      [57, 42]
    );
    assert.deepStrictEqual(gets, [
      { url: '/documents/42/', options: { params: { fields: 'id,versions' } } },
    ]);
    // An answer without a version list: nothing to compare with.
    data = { id: 42 };
    assert.strictEqual(await paperlessService.getDocumentVersionIds(42), null);
    delete require.cache[paperlessServicePath];
    delete require.cache[configPath];
  });

  await test('the version decides whether passwords can be removed', async () => {
    delete require.cache[paperlessServicePath];
    const paperlessService = require('../services/paperlessService.js');
    paperlessService.initialize = () => {};
    let header = '3.4.2';
    paperlessService.client = {
      get: async () => ({ headers: { 'x-version': header } }),
    };
    assert.deepStrictEqual(await paperlessService.getPasswordRemovalSupport(), {
      supported: true,
      version: '3.4.2',
    });
    paperlessService._serverVersion = null;
    header = '2.20.15';
    assert.deepStrictEqual(await paperlessService.getPasswordRemovalSupport(), {
      supported: false,
      version: '2.20.15',
    });
    delete require.cache[paperlessServicePath];
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
