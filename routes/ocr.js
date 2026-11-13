'use strict';

/**
 * The OCR queue: the page and its API (queue, add, remove, process, analyze,
 * text, stats).
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   GET   /ocr                              Redirect to Paperless document details
 *   GET   /api/ocr/queue                    About and support information page
 *   GET   /api/ocr/queue/ids                Get paginated OCR queue
 *   POST  /api/ocr/queue/add
 *   DELETE/api/ocr/queue/:documentId        Add document to OCR queue
 *   POST  /api/ocr/process/:documentId      Remove document from OCR queue
 *   POST  /api/ocr/process-all              Process one OCR queue item
 *   POST  /api/ocr/analyze/:documentId      Process all pending OCR queue items
 *   GET   /api/ocr/queue/:documentId/text   Analyze existing OCR text with AI
 *   GET   /api/ocr/stats                    Get OCR text for one queue item
 */

const express = require('express');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const configFile = require('../config/config.js');
const { isAuthenticated } = require('./auth.js');
const { protectApiRoute } = require('../middleware/authGate');
const mistralOcrService = require('../services/mistralOcrService');
const dashboardStatsService = require('../services/dashboardStatsService');
const { normalizeDocumentIdList } = require('../services/documentIdList');
const router = express.Router();

/**
 * @swagger
 * /dashboard/doc/{id}:
 *   get:
 *     summary: Redirect to Paperless document details
 *     tags:
 *       - Navigation
 *       - Documents
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       302:
 *         description: Redirect to Paperless document page
 *       400:
 *         description: Missing document ID
 *       500:
 *         description: Server error
 */

// ─── OCR Queue Routes ─────────────────────────────────────────────────────

// Page: OCR Queue UI
router.get('/ocr', protectApiRoute, async (req, res) => {
  try {
    return res.render('ocr', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
      ocrEnabled: configFile.mistralOcr?.enabled === 'yes',
      // Same reading as ocrAutoProcessService.autoAnalyze, so the checkbox
      // starts where OCR_AUTO_ANALYZE stands and the button does what the
      // scheduled drain does. It used to start unchecked regardless, which
      // made the same queue behave differently depending on who ran it.
      ocrAutoAnalyze: configFile.mistralOcr?.autoAnalyze !== 'no',
    });
  } catch (error) {
    console.error('[ERROR] OCR page:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /about:
 *   get:
 *     summary: About and support information page
 *     tags:
 *       - Navigation
 *       - System
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: About page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       500:
 *         description: Server error
 */

// API: Get paginated queue
router.get('/api/ocr/queue', isAuthenticated, async (req, res) => {
  try {
    const start = parseInt(req.query.start || '0', 10);
    const length = parseInt(req.query.length || '25', 10);
    const search = req.query.search || '';
    const statusFilter = req.query.status || '';

    const { docs, total } = await documentModel.getOcrQueuePaginated({
      search,
      statusFilter,
      limit: length,
      offset: start,
    });

    const paperlessUrl = await paperlessService.getPublicBaseUrl();

    return res.json({
      success: true,
      data: docs,
      recordsTotal: total,
      recordsFiltered: total,
      paperlessUrl,
    });
  } catch (error) {
    console.error('[ERROR] GET /api/ocr/queue:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/ocr/queue:
 *   get:
 *     summary: Get paginated OCR queue
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: OCR queue returned successfully
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /api/ocr/queue/ids:
 *   get:
 *     summary: Get document IDs currently waiting in the OCR queue
 *     description: >-
 *       Returns the Paperless-ngx document IDs with status pending or processing.
 *       Used by the OCR view to hide already queued documents from search results.
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Queued document IDs returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     ids:
 *                       type: array
 *                       items:
 *                         type: integer
 *       500:
 *         description: Server error
 */

// API: Get all document IDs currently in the OCR queue
router.get('/api/ocr/queue/ids', isAuthenticated, async (req, res) => {
  try {
    const ids = await documentModel.getOcrQueueDocumentIds();
    return res.json({ success: true, data: { ids } });
  } catch (error) {
    console.error('[ERROR] GET /api/ocr/queue/ids:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Add one or more documents manually to the OCR queue
router.post('/api/ocr/queue/add', isAuthenticated, async (req, res) => {
  try {
    const rawInput = req.body.documentIds ?? req.body.documentId;
    if (rawInput === undefined || rawInput === null || rawInput === '') {
      return res
        .status(400)
        .json({ success: false, error: 'documentId is required' });
    }

    const documentIds = normalizeDocumentIdList(rawInput);
    if (!documentIds.length) {
      return res.status(400).json({
        success: false,
        error: 'documentId must be a positive integer',
      });
    }

    const single = documentIds.length === 1;
    let added = 0;
    const missing = [];

    for (const docIdNum of documentIds) {
      let doc;
      try {
        doc = await paperlessService.getDocument(docIdNum);
      } catch (error) {
        if (error.response?.status === 404) {
          doc = null;
        } else {
          throw error;
        }
      }

      if (!doc || !Number.isInteger(Number(doc.id))) {
        // One document that has since been deleted in Paperless-ngx must not
        // cost the rest of the selection its place in the queue.
        if (single) {
          return res.status(404).json({
            success: false,
            error: `Document ${docIdNum} was not found in Paperless-ngx`,
          });
        }
        missing.push(docIdNum);
        continue;
      }

      const title =
        typeof doc.title === 'string' && doc.title.trim()
          ? doc.title.trim()
          : `Document ${docIdNum}`;

      // A manual request re-queues a finished document on purpose — that is
      // what the "run OCR again" entry promises. addToOcrQueue() now answers
      // true only when a pending row exists because of this call, so the
      // counter below states what really happened instead of counting a row
      // the call merely touched.
      if (await documentModel.addToOcrQueue(docIdNum, title, 'manual')) {
        added += 1;
      }
    }

    const skipped = documentIds.length - added - missing.length;

    if (single && !added) {
      // Reached while the OCR worker holds the row; pending, failed and done
      // rows are all re-queued above. The counters stay in the answer so every
      // response of this route has the same shape.
      return res.json({
        success: false,
        added,
        skipped,
        missing,
        message: `Document ${documentIds[0]} is being processed by OCR right now and was not queued again`,
      });
    }

    return res.json({
      success: true,
      added,
      skipped,
      missing,
      message: single
        ? `Document ${documentIds[0]} added to OCR queue`
        : `${added} document(s) added to the OCR queue` +
          (skipped ? `, ${skipped} already being processed` : '') +
          (missing.length ? `, ${missing.length} not found` : ''),
    });
  } catch (error) {
    console.error('[ERROR] POST /api/ocr/queue/add:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/ocr/queue/add:
 *   post:
 *     summary: Add document to OCR queue
 *     description: >-
 *       Queues documents for OCR on explicit request. A document that has
 *       already been through OCR, and one that has already been analysed, is
 *       queued again, because the request itself is the user asking for a
 *       re-run; a completed queue row goes back to pending and its stored OCR
 *       text is cleared. Only a document the OCR worker is busy with is left
 *       alone. added counts the documents that really are pending afterwards,
 *       skipped the ones that were left alone, and missing lists the ids
 *       Paperless-ngx no longer has.
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: One of documentId or documentIds is required.
 *             properties:
 *               documentId:
 *                 type: integer
 *                 minimum: 1
 *                 description: A single document, as the row menu sends it.
 *               documentIds:
 *                 type: array
 *                 description: |
 *                   A selection, as the bulk menu sends it. Documents that are
 *                   being processed are counted as skipped and ones missing from
 *                   Paperless-ngx are listed, rather than failing the batch.
 *                 items:
 *                   type: integer
 *                   minimum: 1
 *     responses:
 *       200:
 *         description: >-
 *           Add operation result. success is false when a single document was
 *           not queued; the counters are present either way.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 added:
 *                   type: integer
 *                   description: Documents that are pending because of this request.
 *                 skipped:
 *                   type: integer
 *                   description: Documents the OCR worker is busy with.
 *                 missing:
 *                   type: array
 *                   description: Ids Paperless-ngx did not resolve.
 *                   items:
 *                     type: integer
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid payload
 *       404:
 *         description: Document not found in Paperless-ngx
 *       500:
 *         description: Server error
 */

// API: Remove a document from OCR queue
router.delete(
  '/api/ocr/queue/:documentId',
  isAuthenticated,
  async (req, res) => {
    try {
      const documentId = parseInt(req.params.documentId, 10);
      if (isNaN(documentId)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid document ID' });
      }
      const removed = await documentModel.removeFromOcrQueue(documentId);
      return res.json({
        success: removed,
        message: removed ? 'Removed from queue' : 'Not found in queue',
      });
    } catch (error) {
      console.error('[ERROR] DELETE /api/ocr/queue/:documentId:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/**
 * @swagger
 * /api/ocr/queue/{documentId}:
 *   delete:
 *     summary: Remove document from OCR queue
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Remove operation result
 *       400:
 *         description: Invalid document ID
 *       500:
 *         description: Server error
 */

// API: Process a single document with OCR fallback (SSE)
router.post(
  '/api/ocr/process/:documentId',
  isAuthenticated,
  async (req, res) => {
    const documentId = parseInt(req.params.documentId, 10);
    if (isNaN(documentId)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    const autoAnalyze =
      req.body?.autoAnalyze === true || req.body?.autoAnalyze === 'true';

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });

    const send = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush();
    };

    try {
      if (!mistralOcrService.isEnabled()) {
        send({
          step: 'error',
          message:
            'OCR fallback is not enabled. Set MISTRAL_OCR_ENABLED=yes in your .env file.',
        });
        return res.end();
      }

      await mistralOcrService.processQueueItem(documentId, {
        autoAnalyze,
        progressCallback: (step, message, data) => {
          send({ step, message, ...data });
        },
      });
      dashboardStatsService.invalidate();
    } catch (error) {
      send({ step: 'error', message: error.message });
    }

    res.end();
  }
);

/**
 * @swagger
 * /api/ocr/process/{documentId}:
 *   post:
 *     summary: Process one OCR queue item
 *     description: Starts OCR processing for one document and streams progress via SSE.
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: SSE stream started
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       400:
 *         description: Invalid document ID
 */

// API: Process all pending items in OCR queue (SSE)
router.post('/api/ocr/process-all', isAuthenticated, async (req, res) => {
  const autoAnalyze =
    req.body?.autoAnalyze === true || req.body?.autoAnalyze === 'true';

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  try {
    if (!mistralOcrService.isEnabled()) {
      send({
        step: 'error',
        message:
          'OCR fallback is not enabled. Set MISTRAL_OCR_ENABLED=yes in your .env file.',
      });
      return res.end();
    }

    const pendingItems = await documentModel.getOcrQueue('pending');
    const total = pendingItems.length;

    if (total === 0) {
      send({ step: 'done', message: 'No pending items in OCR queue.' });
      return res.end();
    }

    send({ step: 'start', message: `Processing ${total} document(s)…`, total });

    let completed = 0;
    let failed = 0;

    for (const item of pendingItems) {
      send({
        step: 'progress',
        message: `Processing document ${item.document_id} (${item.title})…`,
        documentId: item.document_id,
        completed,
        total,
      });

      try {
        await mistralOcrService.processQueueItem(item.document_id, {
          autoAnalyze,
          progressCallback: (step, message, data) => {
            send({
              step: `item_${step}`,
              message,
              documentId: item.document_id,
              ...data,
            });
          },
        });
        completed++;
        dashboardStatsService.invalidate();
      } catch (err) {
        failed++;
        send({
          step: 'item_error',
          message: `Document ${item.document_id} failed: ${err.message}`,
          documentId: item.document_id,
        });
      }
    }

    send({
      step: 'done',
      message: `Batch complete. ${completed} succeeded, ${failed} failed.`,
      completed,
      failed,
      total,
    });
  } catch (error) {
    send({ step: 'error', message: error.message });
  }

  res.end();
});

/**
 * @swagger
 * /api/ocr/process-all:
 *   post:
 *     summary: Process all pending OCR queue items
 *     description: Starts batch OCR processing and streams progress via SSE.
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: SSE stream started
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */

// API: Trigger AI-only analysis from existing OCR text (SSE)
router.post(
  '/api/ocr/analyze/:documentId',
  isAuthenticated,
  async (req, res) => {
    const documentId = parseInt(req.params.documentId, 10);
    if (isNaN(documentId)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });

    const send = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush();
    };

    try {
      const queueItem = await documentModel.getOcrQueueItem(documentId);
      if (!queueItem) {
        send({ step: 'error', message: 'Document not found in OCR queue.' });
        return res.end();
      }
      if (!queueItem.ocr_text || !String(queueItem.ocr_text).trim()) {
        send({
          step: 'error',
          message: 'No OCR text available yet. Run OCR first.',
        });
        return res.end();
      }

      await mistralOcrService.analyzeFromExistingOcrText(
        documentId,
        queueItem.ocr_text,
        (step, message, data) => {
          send({ step, message, ...data });
        }
      );
    } catch (error) {
      send({ step: 'error', message: error.message });
    }

    res.end();
  }
);

/**
 * @swagger
 * /api/ocr/analyze/{documentId}:
 *   post:
 *     summary: Analyze existing OCR text with AI
 *     description: Uses existing OCR text and streams analysis progress via SSE.
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: SSE stream started
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       400:
 *         description: Invalid document ID
 */

// API: Get OCR text for a queue item
router.get(
  '/api/ocr/queue/:documentId/text',
  isAuthenticated,
  async (req, res) => {
    try {
      const documentId = parseInt(req.params.documentId, 10);
      if (isNaN(documentId)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid document ID' });
      }

      const queueItem = await documentModel.getOcrQueueItem(documentId);
      if (!queueItem) {
        return res
          .status(404)
          .json({ success: false, error: 'Document not found in OCR queue' });
      }

      return res.json({
        success: true,
        documentId,
        title: queueItem.title || null,
        status: queueItem.status,
        reason: queueItem.reason,
        hasOcrText: !!(queueItem.ocr_text && String(queueItem.ocr_text).trim()),
        ocrText: queueItem.ocr_text || '',
      });
    } catch (error) {
      console.error('[ERROR] GET /api/ocr/queue/:documentId/text:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

/**
 * @swagger
 * /api/ocr/queue/{documentId}/text:
 *   get:
 *     summary: Get OCR text for one queue item
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: OCR text payload returned
 *       400:
 *         description: Invalid document ID
 *       404:
 *         description: Queue item not found
 *       500:
 *         description: Server error
 */

// API: Get OCR queue statistics
router.get('/api/ocr/stats', isAuthenticated, async (req, res) => {
  try {
    const [allItems, failedDocs, ignoredCount] = await Promise.all([
      documentModel.getOcrQueue(),
      documentModel.getFailedDocumentsPaginated({ limit: 1, offset: 0 }),
      documentModel.getIgnoredCount(),
    ]);
    const stats = {
      pending: allItems.filter((i) => i.status === 'pending').length,
      processing: allItems.filter((i) => i.status === 'processing').length,
      done: allItems.filter((i) => i.status === 'done').length,
      // Counted separately rather than folded into "done": these are the items
      // Paperless-ngx refused the content for, so this queue entry is the only
      // place their OCR text exists. Items completed before the wrote_back
      // column existed carry null and stay out of this count — their outcome
      // was never recorded.
      notWrittenBack: allItems.filter(
        (i) => i.status === 'done' && i.wrote_back === 0
      ).length,
      failed: allItems.filter((i) => i.status === 'failed').length,
      permanentlyFailed: failedDocs.total || 0,
      ignored: ignoredCount,
      total: allItems.length,
      ocrEnabled: mistralOcrService.isEnabled(),
    };
    return res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
