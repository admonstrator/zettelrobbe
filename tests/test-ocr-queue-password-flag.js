/**
 * Test: the password flag of an OCR queue row
 *
 * An OCR run that finds a PDF locked marks its row (migration 17,
 * ocr_queue.password_protected); the OCR page offers the unlock on these rows
 * and the list run works through them. Queueing the document again starts
 * over: the flag is cleared, and the next run decides afresh.
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-ocr-password-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  // models/document.js opens data/documents.db relative to process.cwd() at
  // require time, so the chdir has to happen before the first require.
  process.chdir(tmpDir);

  const documentModel = require('../models/document');

  try {
    await test('a marked row is failed and listed as password protected', async () => {
      await documentModel.addToOcrQueue(301, 'Payslip', 'short_content');
      await documentModel.addToOcrQueue(302, 'Receipt', 'short_content');
      assert.strictEqual(
        await documentModel.markOcrQueuePasswordProtected(301),
        true
      );
      const item = await documentModel.getOcrQueueItem(301);
      assert.strictEqual(item.status, 'failed');
      assert.strictEqual(item.password_protected, 1);
      assert.deepStrictEqual(
        await documentModel.getPasswordProtectedOcrItems(),
        [{ document_id: 301, title: 'Payslip' }]
      );
      const other = await documentModel.getOcrQueueItem(302);
      assert.strictEqual(other.password_protected, 0);
    });

    await test('queueing the document again clears the flag', async () => {
      assert.strictEqual(
        await documentModel.addToOcrQueue(301, 'Payslip', 'manual'),
        true
      );
      const item = await documentModel.getOcrQueueItem(301);
      assert.strictEqual(item.status, 'pending');
      assert.strictEqual(item.password_protected, 0);
      assert.deepStrictEqual(
        await documentModel.getPasswordProtectedOcrItems(),
        []
      );
    });

    await test('marking a document without a row changes nothing', async () => {
      assert.strictEqual(
        await documentModel.markOcrQueuePasswordProtected(999),
        false
      );
    });
  } finally {
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
