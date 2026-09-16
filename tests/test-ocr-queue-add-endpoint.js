/**
 * Test: POST /api/ocr/queue/add must report what really happened
 *
 * Audit finding #18, part of issue #322: the endpoint counted every call to
 * addToOcrQueue() that touched a row as "added". A finished (done) row was
 * merely re-stamped by the old UPSERT, so the History row menu's "run OCR
 * again" answered "added to OCR queue" while the queue kept the finished row
 * and the drain never picked the document up again.
 *
 * With the honest return value a manual request really does re-queue a done
 * row (that is what the menu entry promises), while a document the OCR worker
 * is busy with is reported as skipped instead of added.
 *
 * Covers:
 * 1. A done row is queued again on a manual request and reports added: 1
 * 2. A document the worker is processing reports added: 0 / skipped: 1
 * 3. A bulk request counts each document by what happened to it
 * 4. An already processed document is still queued when the user asks for it
 */

'use strict';

const assert = require('assert');
const { mountRouter } = require('./helpers/mount-router');

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

async function postAdd(base, payload) {
  const response = await fetch(`${base}/api/ocr/queue/add`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const harness = await mountRouter({
    user: { username: 'router-harness' },
    stub: ({ paperlessService }) => {
      // Every id the test uses exists in Paperless-ngx; the route resolves the
      // document before it touches the queue.
      paperlessService.getDocument = async (id) => ({
        id: Number(id),
        title: `Document ${Number(id)}`,
      });
    },
  });

  try {
    const { documentModel, base } = harness;

    await test('A finished row is queued again and counted as added', async () => {
      await documentModel.addToOcrQueue(501, 'Scanned invoice', 'manual');
      await documentModel.updateOcrQueueStatus(501, 'done', 'old OCR text');
      assert.strictEqual(
        (await documentModel.getOcrQueueItem(501)).status,
        'done',
        'test setup failed'
      );

      const { status, body } = await postAdd(base, { documentId: 501 });

      assert.strictEqual(status, 200, 'expected HTTP 200');
      assert.strictEqual(body.success, true, 'expected success: true');
      assert.strictEqual(body.added, 1, 'expected added: 1');
      assert.strictEqual(body.skipped, 0, 'expected skipped: 0');
      assert.deepStrictEqual(body.missing, [], 'expected no missing ids');

      const item = await documentModel.getOcrQueueItem(501);
      assert.strictEqual(
        item.status,
        'pending',
        'the row must be pending again so the drain picks it up'
      );
      assert.strictEqual(
        item.ocr_text,
        null,
        'the stale OCR text must be gone before the new run'
      );
    });

    await test('A document the worker is processing is counted as skipped', async () => {
      await documentModel.addToOcrQueue(502, 'Busy document', 'manual');
      await documentModel.updateOcrQueueStatus(502, 'processing');

      const { status, body } = await postAdd(base, { documentId: 502 });

      assert.strictEqual(status, 200, 'expected HTTP 200');
      assert.strictEqual(body.success, false, 'nothing was queued');
      assert.strictEqual(body.added, 0, 'expected added: 0');
      assert.strictEqual(body.skipped, 1, 'expected skipped: 1');
      assert.deepStrictEqual(body.missing, [], 'expected no missing ids');
      assert.ok(
        typeof body.message === 'string' && body.message.length > 0,
        'expected a message the UI can show'
      );

      assert.strictEqual(
        (await documentModel.getOcrQueueItem(502)).status,
        'processing',
        'a running OCR job must not be disturbed'
      );
    });

    await test('A bulk request counts each document by what happened to it', async () => {
      await documentModel.addToOcrQueue(503, 'Finished document', 'manual');
      await documentModel.updateOcrQueueStatus(503, 'done', 'old OCR text');

      const { status, body } = await postAdd(base, {
        documentIds: [503, 502, 504],
      });

      assert.strictEqual(status, 200, 'expected HTTP 200');
      assert.strictEqual(body.success, true, 'expected success: true');
      assert.strictEqual(
        body.added,
        2,
        'the finished row and the unknown document are queued'
      );
      assert.strictEqual(
        body.skipped,
        1,
        'only the document being processed is skipped'
      );
      assert.deepStrictEqual(body.missing, [], 'expected no missing ids');
    });

    await test('An already processed document is still queued on request', async () => {
      await documentModel.addProcessedDocument(505, 'Analysed last night');

      const { status, body } = await postAdd(base, { documentId: 505 });

      assert.strictEqual(status, 200, 'expected HTTP 200');
      assert.strictEqual(body.success, true, 'expected success: true');
      assert.strictEqual(body.added, 1, 'a manual request is never refused');
      assert.strictEqual(
        (await documentModel.getOcrQueueItem(505)).status,
        'pending',
        'expected a pending row'
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
  console.error('❌  ocr-queue-add-endpoint test crashed');
  console.error(error);
  process.exit(1);
});
