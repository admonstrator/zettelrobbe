/**
 * Test: the manual page's routes (routes/manual.js)
 *
 * The handlers are called directly against a temporary database; the
 * Paperless-ngx client, the password probe and the OCR service are replaced,
 * so nothing leaves the process.
 *
 * Covers:
 * 1. The preview carries the metadata and Zettelrobbe's status, and a
 *    document without text is checked for a password (one with text is not)
 * 2. The file route passes PDFs inline and refuses types a frame cannot show
 * 3. The work lists: unknown lists are refused, local lists come from the
 *    database, "unprocessed" leaves out processed and ignored documents
 * 4. Delete removes the document in Paperless-ngx and every local record of
 *    it, answers 404 and 403 as such, and waits while OCR reads it
 * 5. Saving passes document type and date on, takes the document off the
 *    failed list and drops a finished OCR queue entry
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough, Writable } = require('stream');

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

function fakeResponse() {
  const res = new Writable({
    write(chunk, _encoding, callback) {
      res.chunks.push(chunk);
      callback();
    },
  });
  Object.assign(res, {
    chunks: [],
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    set(name, value) {
      if (typeof name === 'object') Object.assign(this.headers, name);
      else this.headers[name] = value;
      return this;
    },
  });
  return res;
}

function httpError(status) {
  const error = new Error(`HTTP ${status}`);
  error.response = { status };
  return error;
}

async function main() {
  const previousCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-manual-routes-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  // models/document.js opens data/documents.db relative to process.cwd() at
  // require time; the router pulls it in.
  process.chdir(tmpDir);

  const paperlessService = require('../services/paperlessService');
  const pdfPasswordService = require('../services/pdfPasswordService');
  const mistralOcrService = require('../services/mistralOcrService');
  const documentModel = require('../models/document');
  const router = require('../routes/manual');

  const handler = (method, routePath) => {
    const layer = router.stack.find(
      (l) => l.route?.path === routePath && l.route.methods[method]
    );
    assert.ok(layer, `${method.toUpperCase()} ${routePath} registered`);
    return layer.route.stack.at(-1).handle;
  };

  // The process ends with this test, so nothing is put back.
  const stub = (target, name, fn) => {
    target[name] = fn;
  };

  const calls = { downloads: 0, deleted: [], updates: [] };
  let documents = {};

  stub(paperlessService, 'getDocument', async (id) => {
    if (!documents[id]) throw httpError(404);
    return documents[id];
  });
  stub(paperlessService, 'getTagTextFromId', async (id) => `tag-${id}`);
  stub(paperlessService, 'getCorrespondentNameById', async (id) =>
    id ? { id, name: 'Stadtwerke' } : null
  );
  stub(paperlessService, 'getDocumentType', async (id) => ({
    id,
    name: 'Invoice',
  }));
  stub(
    paperlessService,
    'getPublicBaseUrl',
    async () => 'https://paperless.test'
  );
  stub(paperlessService, 'downloadOriginalFile', async () => {
    calls.downloads += 1;
    return { buffer: Buffer.from('%PDF-'), mimeType: 'application/pdf' };
  });
  stub(pdfPasswordService, 'needsPassword', async () => true);

  try {
    // --- preview ----------------------------------------------------------
    const preview = handler('get', '/manual/preview/:id');

    await test('the preview carries metadata, status and a link', async () => {
      documents = {
        7: {
          id: 7,
          title: 'Bill',
          content: 'Total 12.50',
          tags: [1, 2],
          correspondent: 3,
          document_type: 4,
          created: '2026-02-03',
          added: '2026-02-05T10:00:00Z',
          archive_serial_number: 42,
          original_file_name: 'scan.pdf',
          page_count: 2,
          mime_type: 'application/pdf',
          archived_file_name: 'scan.pdf',
        },
      };
      await documentModel.addProcessedDocument(7, 'Bill');
      const res = fakeResponse();
      await preview({ params: { id: '7' } }, res);
      assert.strictEqual(res.statusCode, 200);
      const body = res.body;
      assert.deepStrictEqual(body.tags, ['tag-1', 'tag-2']);
      assert.strictEqual(body.correspondent, 'Stadtwerke');
      assert.strictEqual(body.documentType, 'Invoice');
      assert.strictEqual(body.pageCount, 2);
      assert.strictEqual(body.archiveSerialNumber, 42);
      assert.strictEqual(body.hasArchive, true);
      assert.strictEqual(body.locked, false);
      assert.ok(body.status.processedAt, 'processed date');
      assert.strictEqual(
        body.paperlessLink,
        'https://paperless.test/documents/7/details'
      );
      assert.strictEqual(
        calls.downloads,
        0,
        'a document with text is not downloaded'
      );
    });

    await test('a document without text is checked for a password', async () => {
      documents = {
        8: {
          id: 8,
          title: 'Locked',
          content: '',
          tags: [],
          correspondent: null,
        },
      };
      const res = fakeResponse();
      await preview({ params: { id: '8' } }, res);
      assert.strictEqual(res.body.locked, true);
      assert.strictEqual(
        res.body.unlocking,
        false,
        'a locked document nobody unlocked asks for its password'
      );
      assert.strictEqual(res.body.correspondent, null);
      assert.strictEqual(res.body.documentType, null);
      assert.strictEqual(calls.downloads, 1);
    });

    await test('a document unlocked a moment ago says it is being stored', async () => {
      const pdfUnlockService = require('../services/pdfUnlockService');
      documents = {
        9: { id: 9, title: 'Unlocked', content: '', tags: [] },
      };
      pdfUnlockService._recentlyUnlocked.set(9, Date.now());
      try {
        const res = fakeResponse();
        await preview({ params: { id: '9' } }, res);
        assert.strictEqual(res.body.locked, true);
        assert.strictEqual(res.body.unlocking, true);
      } finally {
        pdfUnlockService._recentlyUnlocked.delete(9);
      }
    });

    await test('an unknown document is a 404, a bad id a 400', async () => {
      const missing = fakeResponse();
      await preview({ params: { id: '999' } }, missing);
      assert.strictEqual(missing.statusCode, 404);
      const bad = fakeResponse();
      await preview({ params: { id: '../x' } }, bad);
      assert.strictEqual(bad.statusCode, 400);
    });

    // --- file -------------------------------------------------------------
    const file = handler('get', '/manual/file/:id');

    await test('a PDF is passed through inline', async () => {
      const stream = new PassThrough();
      stub(paperlessService, 'getDocumentPreviewStream', async () => ({
        stream,
        mimeType: 'application/pdf',
        length: '5',
      }));
      const res = fakeResponse();
      const finished = new Promise((resolve) => res.on('finish', resolve));
      await file({ params: { id: '7' } }, res);
      stream.end('%PDF-');
      await finished;
      assert.strictEqual(res.headers['Content-Type'], 'application/pdf');
      assert.strictEqual(res.headers['Content-Disposition'], 'inline');
      assert.strictEqual(res.headers['X-Content-Type-Options'], 'nosniff');
      assert.strictEqual(Buffer.concat(res.chunks).toString(), '%PDF-');
    });

    await test('a type a frame cannot show is refused', async () => {
      const stream = new PassThrough();
      let destroyed = false;
      stream.on('close', () => {
        destroyed = true;
      });
      stub(paperlessService, 'getDocumentPreviewStream', async () => ({
        stream,
        mimeType: 'text/html',
        length: null,
      }));
      const res = fakeResponse();
      await file({ params: { id: '7' } }, res);
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(res.statusCode, 415);
      assert.ok(destroyed, 'the upstream stream is closed');
    });

    // --- worklist ---------------------------------------------------------
    const worklist = handler('get', '/manual/worklist');

    await test('an unknown list is refused', async () => {
      const res = fakeResponse();
      await worklist({ query: { list: 'everything' } }, res);
      assert.strictEqual(res.statusCode, 400);
    });

    await test('the failed list comes from the database', async () => {
      await documentModel.addFailedDocument(11, 'Broken', 'ai_failed');
      const res = fakeResponse();
      await worklist({ query: { list: 'failed' } }, res);
      assert.deepStrictEqual(res.body.data.documents, [
        { id: 11, title: 'Broken' },
      ]);
    });

    await test('"unprocessed" leaves out processed and ignored', async () => {
      stub(paperlessService, 'listRecentDocuments', async () => [
        { id: 7, title: 'Bill' },
        { id: 12, title: 'New' },
        { id: 13, title: 'Skipped' },
      ]);
      await documentModel.addIgnoredDocument(13, 'Skipped');
      const res = fakeResponse();
      await worklist({ query: { list: 'unprocessed' } }, res);
      assert.deepStrictEqual(res.body.data.documents, [
        { id: 12, title: 'New' },
      ]);
    });

    // --- delete -----------------------------------------------------------
    const remove = handler('delete', '/manual/document/:id');

    await test('delete removes the document and its local records', async () => {
      stub(paperlessService, 'deleteDocument', async (id) => {
        calls.deleted.push(id);
      });
      await documentModel.addToOcrQueue(7, 'Bill');
      await documentModel.addFailedDocument(7, 'Bill', 'ai_failed');
      const res = fakeResponse();
      await remove({ params: { id: '7' } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body.data, { documentId: 7 });
      assert.deepStrictEqual(calls.deleted, [7]);
      assert.deepStrictEqual(documentModel.getDocumentStatus(7), {
        processedAt: null,
        failedReason: null,
        ignored: false,
        ocrStatus: null,
        passwordProtected: false,
      });
    });

    await test('Paperless-ngx refusals keep their meaning', async () => {
      stub(paperlessService, 'deleteDocument', async () => {
        throw httpError(403);
      });
      const forbidden = fakeResponse();
      await remove({ params: { id: '11' } }, forbidden);
      assert.strictEqual(forbidden.statusCode, 403);
      assert.strictEqual(
        documentModel.getDocumentStatus(11).failedReason,
        'ai_failed',
        'nothing local is dropped when Paperless-ngx refused'
      );
      stub(paperlessService, 'deleteDocument', async () => {
        throw httpError(404);
      });
      const missing = fakeResponse();
      await remove({ params: { id: '11' } }, missing);
      assert.strictEqual(missing.statusCode, 404);
    });

    await test('a document OCR is reading is not deleted', async () => {
      stub(mistralOcrService, 'isDocumentActivelyProcessing', () => true);
      calls.deleted.length = 0;
      stub(paperlessService, 'deleteDocument', async (id) => {
        calls.deleted.push(id);
      });
      const res = fakeResponse();
      await remove({ params: { id: '11' } }, res);
      assert.strictEqual(res.statusCode, 409);
      assert.deepStrictEqual(calls.deleted, []);
      stub(mistralOcrService, 'isDocumentActivelyProcessing', () => false);
    });

    // --- save -------------------------------------------------------------
    const save = handler('post', '/manual/updateDocument');

    await test('saving passes type and date on and settles the lists', async () => {
      stub(paperlessService, 'processTags', async (names) => ({
        tagIds: names.map((_, i) => i + 1),
        errors: [],
      }));
      stub(paperlessService, 'getOrCreateCorrespondent', async (name) => ({
        id: 3,
        name,
      }));
      stub(paperlessService, 'getOrCreateDocumentType', async (name) => ({
        id: 4,
        name,
      }));
      stub(paperlessService, 'removeUnusedTagsFromDocument', async () => {});
      stub(paperlessService, 'updateDocument', async (id, data) => {
        calls.updates.push({ id, data });
        return { id };
      });
      await documentModel.addFailedDocument(20, 'Done', 'ai_failed');
      await documentModel.addToOcrQueue(20, 'Done');
      await documentModel.updateOcrQueueStatus(20, 'done');
      const res = fakeResponse();
      await save(
        {
          body: {
            documentId: 20,
            title: 'Done',
            tags: ['Bill'],
            correspondent: 'Stadtwerke',
            documentType: 'Invoice',
            created: '2026-02-03',
          },
        },
        res
      );
      assert.strictEqual(res.statusCode, 200);
      const sent = calls.updates.at(-1).data;
      assert.strictEqual(sent.document_type, 4);
      assert.strictEqual(sent.created, '2026-02-03');
      assert.strictEqual(sent.correspondent, 3);
      const status = documentModel.getDocumentStatus(20);
      assert.ok(status.processedAt, 'processed');
      assert.strictEqual(status.failedReason, null);
      assert.strictEqual(status.ocrStatus, null);
    });

    await test('a malformed date and a pending OCR entry are left alone', async () => {
      await documentModel.addToOcrQueue(21, 'Waiting');
      const res = fakeResponse();
      await save(
        { body: { documentId: 21, title: 'Waiting', created: '03.02.2026' } },
        res
      );
      assert.strictEqual(res.statusCode, 200);
      assert.ok(!('created' in calls.updates.at(-1).data));
      assert.strictEqual(
        documentModel.getDocumentStatus(21).ocrStatus,
        'pending'
      );
    });
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
