/**
 * Test: addToOcrQueue() must refuse a processed document and report honestly
 *
 * Issue #322: the scheduled scan and the OCR drain raced. processQueueItem()
 * set the queue row to done, ran the AI analysis, and then deleted the row.
 * A scan that had started its Paperless-ngx calls in the meantime came back
 * with "content too short", found no row any more, inserted a fresh pending
 * one — and bought a second paid OCR run for a document that was already
 * finished.
 *
 * The fix gives addToOcrQueue() an options.skipIfProcessed flag that refuses
 * the document inside the same statement that would insert it, so no window
 * exists between the check and the write. The same statement also makes the
 * return value honest: true only when a pending row exists because of this
 * call. The scan logs "queued for Mistral OCR" on that value, so a false
 * positive there is a lie in the operator's log.
 *
 * Covers:
 * 1. Processed document + skipIfProcessed -> refused, no row is created
 * 2. Processed document + a manual request -> still queued (the user asked)
 * 3. Unprocessed document -> queued as pending
 * 4. Existing done row + automatic reason -> refused, row stays done
 * 5. Existing done row + manual reason -> pending again, ocr_text cleared
 * 6. Existing processing row -> refused, row untouched
 * 7. Existing failed row -> pending again
 * 8. Existing pending row -> still true (the row was moved to the front)
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

async function main() {
  const previousCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-ocr-requeue-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  // models/document.js opens data/documents.db relative to process.cwd() at
  // require time, so the chdir has to happen before the first require.
  process.chdir(tmpDir);

  const documentModel = require('../models/document');

  const status = async (documentId) => {
    const item = await documentModel.getOcrQueueItem(documentId);
    return item ? item.status : null;
  };

  try {
    await test('Processed document with skipIfProcessed is refused and no row appears', async () => {
      await documentModel.addProcessedDocument(101, 'Already analysed');

      const added = await documentModel.addToOcrQueue(
        101,
        'Already analysed',
        'short_content_lt_1000000',
        { skipIfProcessed: true }
      );

      assert.strictEqual(added, false, 'expected the call to be refused');
      assert.strictEqual(
        await documentModel.getOcrQueueItem(101),
        undefined,
        'a processed document must not get a queue row'
      );
    });

    await test('Processed document queued manually is still accepted', async () => {
      const added = await documentModel.addToOcrQueue(
        101,
        'Already analysed',
        'manual'
      );

      assert.strictEqual(added, true, 'a manual request must not be refused');
      assert.strictEqual(
        await status(101),
        'pending',
        'the manual request must leave a pending row'
      );
    });

    await test('Unprocessed document is queued as pending', async () => {
      const added = await documentModel.addToOcrQueue(
        202,
        'Scanned receipt',
        'short_content_lt_1000000',
        { skipIfProcessed: true }
      );

      assert.strictEqual(added, true, 'expected the document to be queued');
      assert.strictEqual(
        await status(202),
        'pending',
        'expected status pending'
      );
    });

    await test('Done row met by an automatic reason is refused and stays done', async () => {
      await documentModel.updateOcrQueueStatus(202, 'done', 'extracted text');
      assert.strictEqual(await status(202), 'done', 'test setup failed');

      const added = await documentModel.addToOcrQueue(
        202,
        'Scanned receipt',
        'short_content_lt_1000000',
        { skipIfProcessed: true }
      );

      assert.strictEqual(
        added,
        false,
        'a finished row is not a queueing, so the scan must not be told it was'
      );
      assert.strictEqual(await status(202), 'done', 'the row must stay done');

      const item = await documentModel.getOcrQueueItem(202);
      assert.strictEqual(
        item.ocr_text,
        'extracted text',
        'the stored OCR text must survive a refused call'
      );
    });

    await test('Done row met by a manual reason is queued again with a cleared text', async () => {
      const added = await documentModel.addToOcrQueue(
        202,
        'Scanned receipt',
        'manual'
      );

      assert.strictEqual(added, true, 'a manual re-run must be accepted');

      const item = await documentModel.getOcrQueueItem(202);
      assert.strictEqual(item.status, 'pending', 'expected status pending');
      assert.strictEqual(
        item.ocr_text,
        null,
        'the old OCR text must be cleared so the page does not show a stale result'
      );
      assert.strictEqual(item.reason, 'manual', 'expected the manual reason');
    });

    await test('Processing row is refused and left untouched', async () => {
      await documentModel.updateOcrQueueStatus(202, 'processing');
      assert.strictEqual(await status(202), 'processing', 'test setup failed');

      const automatic = await documentModel.addToOcrQueue(
        202,
        'Renamed while running',
        'short_content_lt_1000000',
        { skipIfProcessed: true }
      );
      const manual = await documentModel.addToOcrQueue(
        202,
        'Renamed while running',
        'manual'
      );

      assert.strictEqual(automatic, false, 'automatic call must be refused');
      assert.strictEqual(manual, false, 'manual call must be refused as well');

      const item = await documentModel.getOcrQueueItem(202);
      assert.strictEqual(
        item.status,
        'processing',
        'the row must stay processing'
      );
      assert.strictEqual(
        item.title,
        'Scanned receipt',
        'a refused call must not rewrite the row'
      );
    });

    await test('Failed row is moved back to pending', async () => {
      await documentModel.updateOcrQueueStatus(202, 'failed');
      assert.strictEqual(await status(202), 'failed', 'test setup failed');

      const added = await documentModel.addToOcrQueue(
        202,
        'Scanned receipt',
        'ai_failed_unknown',
        { skipIfProcessed: true }
      );

      assert.strictEqual(added, true, 'a failed row is retried');
      assert.strictEqual(
        await status(202),
        'pending',
        'expected status pending'
      );
    });

    await test('Pending row stays pending and still reports true', async () => {
      const added = await documentModel.addToOcrQueue(
        202,
        'Scanned receipt',
        'ai_failed_unknown',
        { skipIfProcessed: true }
      );

      assert.strictEqual(
        added,
        true,
        'the row is pending because of this call, so true is honest'
      );
      assert.strictEqual(
        await status(202),
        'pending',
        'expected status pending'
      );
    });

    await test('A document processed after it was queued is still refused', async () => {
      // The exact race from the issue: the OCR run finished and deleted the
      // queue row while the scan was busy with its Paperless-ngx calls.
      await documentModel.addProcessedDocument(303, 'Finished during the scan');
      await documentModel.removeFromOcrQueue(303);

      const added = await documentModel.addToOcrQueue(
        303,
        'Finished during the scan',
        'short_content_lt_1000000',
        { skipIfProcessed: true }
      );

      assert.strictEqual(added, false, 'the second OCR run must not be bought');
      assert.strictEqual(
        await documentModel.getOcrQueueItem(303),
        undefined,
        'no row may be inserted for a document that is already processed'
      );
    });

    await test('Without the option a processed document is queued as before', async () => {
      const added = await documentModel.addToOcrQueue(
        303,
        'Finished during the scan',
        'short_content_lt_1000000'
      );

      assert.strictEqual(
        added,
        true,
        'callers that did not opt in keep the old behaviour'
      );
      assert.strictEqual(
        await status(303),
        'pending',
        'expected status pending'
      );
    });
  } finally {
    try {
      await documentModel.closeDatabase();
    } catch {
      // A half-initialised database has nothing to close.
    }
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌  ocr-queue-requeue-guard test crashed');
  console.error(error);
  process.exit(1);
});
