/**
 * Test: a reset on the Failed page puts failed OCR queue rows back
 *
 * The Failed page promises that a reset makes a document eligible again.
 * Its own resets (one document, all documents) therefore send the failed OCR
 * queue row back to pending, except for password-protected PDFs, which only
 * fail again until they are unlocked. resetFailedDocument itself must not
 * touch the OCR queue: the success paths (finished OCR run, unlock, ignore)
 * call it to clear the entry.
 *
 * Runs against a real database in a temporary directory.
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-failed-requeue-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  // models/document.js opens data/documents.db relative to process.cwd() at
  // require time, so the chdir has to happen before the first require.
  process.chdir(tmpDir);

  const documentModel = require('../models/document');

  async function queueFailed(id, title) {
    await documentModel.addToOcrQueue(id, title, 'short_content');
    await documentModel.updateOcrQueueStatus(id, 'failed', 'kept text');
    await documentModel.addFailedDocument(id, title, 'ocr_failed', 'ocr');
  }

  try {
    await test('requeue puts a failed row back to pending and keeps its text', async () => {
      await queueFailed(1, 'Invoice');
      assert.strictEqual(
        await documentModel.requeueFailedOcrQueueItems([1]),
        1
      );
      const item = await documentModel.getOcrQueueItem(1);
      assert.strictEqual(item.status, 'pending');
      assert.strictEqual(item.processed_at, null);
      assert.strictEqual(item.ocr_text, 'kept text');
    });

    await test('requeue leaves password-protected, done, pending and processing rows', async () => {
      await queueFailed(2, 'Payslip');
      await documentModel.markOcrQueuePasswordProtected(2);
      await documentModel.addToOcrQueue(3, 'Done', 'manual');
      await documentModel.updateOcrQueueStatus(3, 'done');
      await documentModel.addToOcrQueue(4, 'Pending', 'manual');
      await documentModel.addToOcrQueue(5, 'Processing', 'manual');
      await documentModel.updateOcrQueueStatus(5, 'processing');

      assert.strictEqual(
        await documentModel.requeueFailedOcrQueueItems([2, 3, 4, 5]),
        0
      );
      const statuses = {};
      for (const id of [2, 3, 4, 5]) {
        statuses[id] = (await documentModel.getOcrQueueItem(id)).status;
      }
      assert.deepStrictEqual(statuses, {
        2: 'failed',
        3: 'done',
        4: 'pending',
        5: 'processing',
      });
    });

    await test('requeue ignores documents without a row and invalid IDs', async () => {
      assert.strictEqual(
        await documentModel.requeueFailedOcrQueueItems([999]),
        0
      );
      assert.strictEqual(
        await documentModel.requeueFailedOcrQueueItems(['x', -1, 0, null]),
        0
      );
      assert.strictEqual(await documentModel.requeueFailedOcrQueueItems([]), 0);
      assert.strictEqual(
        await documentModel.requeueFailedOcrQueueItems(undefined),
        0
      );
    });

    await test('resetFailedDocument alone does not touch the OCR queue', async () => {
      await queueFailed(10, 'Finished elsewhere');
      assert.strictEqual(await documentModel.resetFailedDocument(10), true);
      assert.strictEqual(await documentModel.isDocumentFailed(10), false);
      assert.strictEqual(
        (await documentModel.getOcrQueueItem(10)).status,
        'failed'
      );
    });

    await test('resetAllFailedDocuments requeues failed OCR rows of the failed list only', async () => {
      // Earlier cases left their documents on the failed list.
      await documentModel.resetFailedDocument(1);
      await documentModel.resetFailedDocument(2);

      await queueFailed(20, 'Reset me');
      await queueFailed(21, 'Locked');
      await documentModel.markOcrQueuePasswordProtected(21);
      // A document on the failed list that never went through OCR.
      await documentModel.addFailedDocument(22, 'AI only', 'ai_failed', 'ai');
      // A failed OCR row that is not on the failed list stays as it is.
      await documentModel.addToOcrQueue(23, 'Not listed', 'manual');
      await documentModel.updateOcrQueueStatus(23, 'failed');

      const result = await documentModel.resetAllFailedDocuments();
      assert.strictEqual(result.count, 3);
      assert.strictEqual(result.requeued, 1);
      assert.strictEqual(
        (await documentModel.getOcrQueueItem(20)).status,
        'pending'
      );
      assert.strictEqual(
        (await documentModel.getOcrQueueItem(21)).status,
        'failed'
      );
      assert.ok(!(await documentModel.getOcrQueueItem(22)));
      assert.strictEqual(
        (await documentModel.getOcrQueueItem(23)).status,
        'failed'
      );

      assert.deepStrictEqual(await documentModel.resetAllFailedDocuments(), {
        count: 0,
        requeued: 0,
      });
    });
  } finally {
    try {
      await documentModel.closeDatabase();
    } catch {
      // Ignore close failures.
    }
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
