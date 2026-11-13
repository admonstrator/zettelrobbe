/**
 * Test: a rescan leaves a document alone while it waits for OCR
 *
 * rescanDocumentsByIds() deleted a document's processed, history and
 * original rows and answered "queued for reprocessing". The pipeline then
 * skipped the document because it waits in the OCR queue (pending or
 * processing) or sits inside an OCR run: the local data was gone and nothing
 * happened. Such a document is now neither deleted nor queued; it comes back
 * in `waitingForOcr`, and the routes say so.
 *
 * The hold applies only while OCR is switched on. With OCR off nothing works
 * the queue, and the rescan goes ahead as for any other document.
 *
 * Covers:
 * 1. A pending row: kept, not fetched, reported as waiting
 * 2. A processing row and a running OCR job: the same
 * 3. OCR switched off: the pending row does not hold the rescan back
 * 4. POST /api/history/:id/rescan answers 200 with waitingForOcr and a message
 * 5. POST /api/history/rescan lists the waiting ids next to queued/notFound
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

const API_KEY = 'test-api-key';
const WAITING_ID = 6101;
const OTHER_ID = 6102;

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

async function post(base, url, body) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const fetched = [];
  const harness = await mountRouter({
    user: { username: 'router-harness' },
    stub: ({ paperlessService }) => {
      // The queue drains fire-and-forget after the call. Refusing permission
      // makes processDocument() return before it would reach an AI provider.
      paperlessService.getPermissionOfDocument = async () => false;
      paperlessService.listDocumentTypesNames = async () => [];
      paperlessService.getDocument = async (id) => {
        fetched.push(Number(id));
        return { id: Number(id), title: `Doc ${id}`, tags: [] };
      };
    },
  });

  const webhookQueueService = require(
    path.join(REPO_ROOT, 'services', 'webhookQueueService.js')
  );
  const mistralOcrService = require(
    path.join(REPO_ROOT, 'services', 'mistralOcrService.js')
  );

  try {
    const { documentModel, base } = harness;

    const seed = async (id) => {
      await documentModel.addToHistory(id, [1], 'AI title', 'AI corr');
      await documentModel.saveOriginalData(
        id,
        [1],
        7,
        'Original title',
        null,
        'en'
      );
    };
    const hasRows = async (id) =>
      Boolean(await documentModel.getHistoryByDocumentId(id)) &&
      Boolean(await documentModel.getOriginalData(id));
    const reset = async (ocrRowStatus) => {
      fetched.length = 0;
      await seed(WAITING_ID);
      await seed(OTHER_ID);
      await documentModel.removeFromOcrQueue(WAITING_ID);
      if (ocrRowStatus) {
        await documentModel.addToOcrQueue(WAITING_ID, 'Doc', 'short_content');
        if (ocrRowStatus !== 'pending') {
          await documentModel.updateOcrQueueStatus(WAITING_ID, ocrRowStatus);
        }
      }
    };

    await test('a pending OCR row holds the rescan: rows kept, nothing fetched', async () => {
      process.env.MISTRAL_OCR_ENABLED = 'yes';
      await reset('pending');

      const result = await webhookQueueService.rescanDocumentsByIds([
        WAITING_ID,
        OTHER_ID,
      ]);

      assert.deepStrictEqual(result, {
        queued: 1,
        notFound: [],
        waitingForOcr: [WAITING_ID],
      });
      assert.ok(await hasRows(WAITING_ID), 'the waiting document keeps rows');
      assert.ok(!(await hasRows(OTHER_ID)), 'the other one is reset');
      assert.ok(!fetched.includes(WAITING_ID), 'no Paperless call for it');
    });

    await test('a processing OCR row and a running OCR job hold it too', async () => {
      process.env.MISTRAL_OCR_ENABLED = 'yes';
      await reset('processing');
      const processing = await webhookQueueService.rescanDocumentsByIds([
        WAITING_ID,
      ]);
      assert.deepStrictEqual(processing.waitingForOcr, [WAITING_ID]);
      assert.strictEqual(processing.queued, 0);
      assert.ok(await hasRows(WAITING_ID));

      await reset(null);
      mistralOcrService.activeDocumentIds.add(WAITING_ID);
      try {
        const active = await webhookQueueService.rescanDocumentsByIds([
          WAITING_ID,
        ]);
        assert.deepStrictEqual(active.waitingForOcr, [WAITING_ID]);
        assert.ok(await hasRows(WAITING_ID));
      } finally {
        mistralOcrService.activeDocumentIds.delete(WAITING_ID);
      }
    });

    await test('a done or failed OCR row does not hold it', async () => {
      process.env.MISTRAL_OCR_ENABLED = 'yes';
      for (const status of ['done', 'failed']) {
        await reset(status);
        const result = await webhookQueueService.rescanDocumentsByIds([
          WAITING_ID,
        ]);
        assert.deepStrictEqual(
          result,
          { queued: 1, notFound: [], waitingForOcr: [] },
          status
        );
      }
    });

    await test('with OCR switched off a pending row does not hold the rescan', async () => {
      process.env.MISTRAL_OCR_ENABLED = 'no';
      await reset('pending');

      const result = await webhookQueueService.rescanDocumentsByIds([
        WAITING_ID,
      ]);

      assert.deepStrictEqual(result, {
        queued: 1,
        notFound: [],
        waitingForOcr: [],
      });
      assert.ok(!(await hasRows(WAITING_ID)), 'rows are cleared as usual');
    });

    await test('POST /api/history/:id/rescan says the document waits for OCR', async () => {
      process.env.MISTRAL_OCR_ENABLED = 'yes';
      await reset('pending');

      const { status, body } = await post(
        base,
        `/api/history/${WAITING_ID}/rescan`
      );

      assert.strictEqual(status, 200);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.waitingForOcr, true);
      assert.match(body.message, /waiting for OCR/);
      assert.ok(await hasRows(WAITING_ID));

      const other = await post(base, `/api/history/${OTHER_ID}/rescan`);
      assert.deepStrictEqual(other, {
        status: 200,
        body: { success: true, message: 'Document queued for reprocessing.' },
      });
    });

    await test('POST /api/history/rescan lists the waiting ids', async () => {
      process.env.MISTRAL_OCR_ENABLED = 'yes';
      await reset('pending');

      const { status, body } = await post(base, '/api/history/rescan', {
        ids: [WAITING_ID, OTHER_ID],
      });

      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body, {
        success: true,
        queued: 1,
        notFound: [],
        waitingForOcr: [WAITING_ID],
      });
    });
  } finally {
    delete process.env.MISTRAL_OCR_ENABLED;
    await harness.close();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌  rescan-waiting-for-ocr test crashed');
  console.error(error);
  process.exit(1);
});
