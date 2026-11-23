const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

async function run() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'paperless-failed-reset-all-')
  );

  try {
    process.chdir(tempRoot);

    const documentModel = require('../models/document');

    await documentModel.addFailedDocument(101, 'Doc A', 'ocr_failed', 'ocr');
    await documentModel.addFailedDocument(
      202,
      'Doc B',
      'ai_failed_after_ocr',
      'ai'
    );
    await documentModel.addFailedDocument(
      303,
      'Doc C',
      'insufficient_content_lt_10',
      'ai'
    );

    await documentModel.setProcessingStatus(101, 'Doc A', 'failed');
    await documentModel.setProcessingStatus(202, 'Doc B', 'failed');
    await documentModel.setProcessingStatus(999, 'Unrelated', 'failed');

    const first = await documentModel.resetAllFailedDocuments();
    assert.strictEqual(
      first.count,
      3,
      'should reset all entries currently in failed queue'
    );
    assert.strictEqual(
      first.requeued,
      0,
      'no OCR queue rows exist, so nothing is requeued'
    );

    const afterFirstReset = await documentModel.getFailedDocumentsPaginated({
      search: '',
      limit: 25,
      offset: 0,
    });
    assert.strictEqual(
      afterFirstReset.total,
      0,
      'failed queue should be empty after reset all'
    );

    const processing101 =
      await documentModel.getProcessingStatusByDocumentId(101);
    const processing202 =
      await documentModel.getProcessingStatusByDocumentId(202);
    const processing999 =
      await documentModel.getProcessingStatusByDocumentId(999);

    assert.strictEqual(
      processing101,
      null,
      'processing status for reset documents should be cleared'
    );
    assert.strictEqual(
      processing202,
      null,
      'processing status for reset documents should be cleared'
    );
    assert.ok(
      processing999,
      'unrelated processing status should remain untouched'
    );

    const second = await documentModel.resetAllFailedDocuments();
    assert.strictEqual(
      second.count,
      0,
      'second reset should be idempotent when queue is already empty'
    );
    assert.strictEqual(second.requeued, 0, 'second reset requeues nothing');

    console.log('PASS test-failed-reset-all');
  } finally {
    process.chdir(originalCwd);

    try {
      const documentModel = require('../models/document');
      await documentModel.closeDatabase();
    } catch {
      // Ignore close failures from partially initialized test state.
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('FAIL test-failed-reset-all');
  console.error(error);
  process.exit(1);
});
