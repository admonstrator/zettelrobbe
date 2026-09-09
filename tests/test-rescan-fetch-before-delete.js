/**
 * Test: a rescan must resolve the document before it deletes anything
 *
 * rescanDocumentsByIds() used to call deleteDocumentsIdList() first and fetch
 * afterwards. deleteDocumentsIdList() also clears original_documents, which
 * holds the only copy of a document's pre-AI title, tags and correspondent —
 * the record "restore original" restores from. So a rescan started while
 * Paperless-ngx was restarting destroyed that snapshot for every selected
 * document, could not queue a single one, and the single-document endpoint
 * still answered 200 "queued for reprocessing".
 *
 * Covers:
 * 1. An unresolvable document leaves history_documents and original_documents
 *    untouched
 * 2. ... and answers 404 instead of a success the user cannot act on
 * 3. A resolvable document still clears both rows and answers 200
 */

'use strict';

const assert = require('assert');
const { mountRouter } = require('./helpers/mount-router');

const DOCUMENT_ID = 4242;
const API_KEY = 'test-api-key';

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

async function postRescan(base, id) {
  const response = await fetch(`${base}/api/history/${id}/rescan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const harness = await mountRouter({
    user: { username: 'router-harness' },
    stub: ({ paperlessService }) => {
      // The queue is drained fire-and-forget after the response. Refusing
      // permission makes processDocument() return before it would reach an AI
      // provider, so the test stays offline and the queue does not spin.
      paperlessService.getPermissionOfDocument = async () => false;
      paperlessService.listDocumentTypesNames = async () => [];
    },
  });

  try {
    const { documentModel, paperlessService, base } = harness;

    const seedRows = async () => {
      await documentModel.addToHistory(
        DOCUMENT_ID,
        [1, 2],
        'AI title',
        'AI correspondent'
      );
      await documentModel.saveOriginalData(
        DOCUMENT_ID,
        [1, 2],
        7,
        'Original title before AI',
        null,
        'en'
      );
    };

    await seedRows();

    // Sanity check: the rows the fix has to protect really are there.
    assert.ok(
      await documentModel.getHistoryByDocumentId(DOCUMENT_ID),
      'seeding the history row failed'
    );
    assert.ok(
      await documentModel.getOriginalData(DOCUMENT_ID),
      'seeding the original_documents row failed'
    );

    await test('Unresolvable document: local records survive and the answer is 404', async () => {
      paperlessService.getDocument = async () => null;

      const { status, body } = await postRescan(base, DOCUMENT_ID);

      assert.strictEqual(status, 404, 'expected HTTP 404');
      assert.strictEqual(body.success, false, 'expected success: false');
      assert.ok(
        typeof body.error === 'string' && body.error.length > 0,
        'expected an error message'
      );

      assert.ok(
        await documentModel.getHistoryByDocumentId(DOCUMENT_ID),
        'history_documents row must survive a rescan that resolved nothing'
      );
      assert.ok(
        await documentModel.getOriginalData(DOCUMENT_ID),
        'original_documents row must survive — it is the only pre-AI snapshot'
      );
    });

    await test('Paperless-ngx error while resolving: local records still survive', async () => {
      paperlessService.getDocument = async () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:8000');
        error.code = 'ECONNREFUSED';
        throw error;
      };

      const { status, body } = await postRescan(base, DOCUMENT_ID);

      assert.strictEqual(status, 404, 'expected HTTP 404');
      assert.strictEqual(body.success, false, 'expected success: false');
      assert.ok(
        await documentModel.getOriginalData(DOCUMENT_ID),
        'original_documents row must survive a failed lookup'
      );
    });

    await test('Resolvable document: records are cleared and the answer is 200', async () => {
      paperlessService.getDocument = async (id) => ({
        id: Number(id),
        title: 'Invoice 4242',
        tags: [],
        correspondent: null,
      });

      const { status, body } = await postRescan(base, DOCUMENT_ID);

      assert.strictEqual(status, 200, 'expected HTTP 200');
      assert.strictEqual(body.success, true, 'expected success: true');

      assert.strictEqual(
        await documentModel.getHistoryByDocumentId(DOCUMENT_ID),
        undefined,
        'history_documents row should be gone after a queued rescan'
      );
      assert.strictEqual(
        await documentModel.getOriginalData(DOCUMENT_ID),
        undefined,
        'original_documents row should be gone after a queued rescan'
      );
    });
  } finally {
    await harness.close();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌  rescan-fetch-before-delete test crashed');
  console.error(error);
  process.exit(1);
});
