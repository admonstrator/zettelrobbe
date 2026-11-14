'use strict';

/**
 * The failed and ignored queues: their pages and APIs.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   GET   /failed                            OCR queue page
 *   GET   /ignored                           Permanently failed queue page
 *   GET   /api/failed/queue                  Get OCR queue statistics
 *   POST  /api/failed/reset/:documentId      Get permanently failed document queue
 *   POST  /api/failed/reset-all
 *   GET   /api/ignored/queue                 Reset permanently failed document
 *   POST  /api/ignored/add                   Add one or more documents to the ignored list
 *   GET   /api/ignored/suggest/:documentId   Propose skip rules built from one document
 *   POST  /api/ignored/skip                  Skip one document and store rules for documents like it
 *   DELETE/api/ignored/:documentId
 *   POST  /api/ignored/clear-all
 *   POST  /api/failed/ignore/:documentId
 */

const express = require('express');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const configFile = require('../config/config.js');
const { isAuthenticated } = require('./auth.js');
const { protectApiRoute } = require('../middleware/authGate');
const skipRuleService = require('../services/skipRuleService');
const { normalizeDocumentIdList } = require('../services/documentIdList');
const router = express.Router();

/**
 * @swagger
 * /ocr:
 *   get:
 *     summary: OCR queue page
 *     tags:
 *       - Navigation
 *       - OCR
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: OCR page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       500:
 *         description: Server error
 */

// Page: Permanently Failed UI
router.get('/failed', protectApiRoute, async (req, res) => {
  try {
    return res.render('failed', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
    });
  } catch (error) {
    console.error('[ERROR] Failed page:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /failed:
 *   get:
 *     summary: Permanently failed queue page
 *     tags:
 *       - Navigation
 *       - OCR
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Failed queue page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       500:
 *         description: Server error
 */

// Page: Ignored Documents Queue
router.get('/ignored', protectApiRoute, async (req, res) => {
  try {
    return res.render('ignored', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
    });
  } catch (error) {
    console.error('[ERROR] Ignored page:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/ocr/stats:
 *   get:
 *     summary: Get OCR queue statistics
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: OCR statistics returned successfully
 *       500:
 *         description: Server error
 */

// API: Get paginated permanently failed documents queue
router.get('/api/failed/queue', isAuthenticated, async (req, res) => {
  try {
    const start = parseInt(req.query.start || '0', 10);
    const length = parseInt(req.query.length || '25', 10);
    const search = req.query.search || '';

    const { docs, total } = await documentModel.getFailedDocumentsPaginated({
      search,
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
    console.error('[ERROR] GET /api/failed/queue:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/failed/queue:
 *   get:
 *     summary: Get permanently failed document queue
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Failed queue returned successfully
 *       500:
 *         description: Server error
 */

// API: Reset terminal failure state for a document
router.post(
  '/api/failed/reset/:documentId',
  isAuthenticated,
  async (req, res) => {
    try {
      const documentId = parseInt(req.params.documentId, 10);
      if (isNaN(documentId)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid document ID' });
      }

      const reset = await documentModel.resetFailedDocument(documentId);
      await documentModel.clearProcessingStatusByDocumentId(documentId);

      return res.json({
        success: reset,
        message: reset
          ? `Document ${documentId} reset. It can be scanned again.`
          : `Document ${documentId} was not in failed queue.`,
      });
    } catch (error) {
      console.error('[ERROR] POST /api/failed/reset/:documentId:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// API: Reset terminal failure state for all documents in failed queue
router.post('/api/failed/reset-all', isAuthenticated, async (req, res) => {
  try {
    const count = await documentModel.resetAllFailedDocuments();

    return res.json({
      success: true,
      count,
      message:
        count > 0
          ? `${count} failed document${count === 1 ? '' : 's'} reset. They can be scanned again.`
          : 'No failed documents to reset.',
    });
  } catch (error) {
    console.error('[ERROR] POST /api/failed/reset-all:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/failed/reset/{documentId}:
 *   post:
 *     summary: Reset permanently failed document
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
 *         description: Reset operation result
 *       400:
 *         description: Invalid document ID
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /api/failed/reset-all:
 *   post:
 *     summary: Reset all permanently failed documents
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Reset operation result
 *       500:
 *         description: Server error
 */

// API: Get paginated ignored documents queue
router.get('/api/ignored/queue', isAuthenticated, async (req, res) => {
  try {
    const start = parseInt(req.query.start || '0', 10);
    const length = parseInt(req.query.length || '25', 10);
    const search = req.query.search || '';

    const { docs, total } = await documentModel.getIgnoredDocumentsPaginated({
      search,
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
    console.error('[ERROR] GET /api/ignored/queue:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/ignored/add:
 *   post:
 *     summary: Add one or more documents to the ignored list
 *     description: |
 *       Ignored documents are skipped by every future scan. Accepts a single
 *       id from the history row menu or a selection from its bulk menu; a
 *       document that was already ignored counts as skipped rather than an
 *       error.
 *     tags:
 *       - Documents
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
 *               documentIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *                   minimum: 1
 *               title:
 *                 type: string
 *                 description: Stored with a single document; ignored for a selection.
 *               reason:
 *                 type: string
 *                 default: manual
 *     responses:
 *       200:
 *         description: How many were added and how many were already ignored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 added:
 *                   type: integer
 *                 skipped:
 *                   type: integer
 *                 message:
 *                   type: string
 *       400:
 *         description: No usable document id in the payload
 */
// API: Add one or more documents to the ignored list
router.post('/api/ignored/add', isAuthenticated, async (req, res) => {
  try {
    const documentIds = normalizeDocumentIdList(
      req.body.documentIds ?? req.body.documentId
    );
    if (!documentIds.length) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    const title = req.body.title || '';
    const reason = req.body.reason || 'manual';

    let added = 0;
    for (const documentId of documentIds) {
      // The title belongs to one document, so it only travels when one was
      // asked for; a bulk call lets the model fall back to what it knows.
      const wasAdded = await documentModel.addIgnoredDocument(
        documentId,
        documentIds.length === 1 ? title : '',
        reason
      );
      if (wasAdded) added += 1;
    }

    // In the background: the fingerprint lets later copies of the same text
    // skip OCR and AI, and fetching it must not hold up the answer.
    skipRuleService.rememberFingerprints(documentIds);

    const skipped = documentIds.length - added;
    return res.json({
      success: true,
      added,
      skipped,
      message:
        documentIds.length === 1
          ? added
            ? `Document ${documentIds[0]} added to ignored list.`
            : `Document ${documentIds[0]} was already ignored.`
          : `${added} document(s) added to ignored list${skipped ? `, ${skipped} already ignored` : ''}.`,
    });
  } catch (error) {
    console.error('[ERROR] POST /api/ignored/add:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/ignored/suggest/{documentId}:
 *   get:
 *     summary: Propose skip rules built from one document
 *     description: |
 *       Reads the document from Paperless-ngx and proposes what skipping it by
 *       hand could also cover: copies with the same text, a part of its title
 *       or file name (with how many history entries contain it), and a page
 *       limit for long documents. Changes nothing.
 *     tags:
 *       - Documents
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 1
 *     responses:
 *       200:
 *         description: The document's facts and a proposal per rule
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
 *                     document:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         title:
 *                           type: string
 *                         fileName:
 *                           type: string
 *                         pageCount:
 *                           type: integer
 *                           nullable: true
 *                         correspondent:
 *                           type: string
 *                           nullable: true
 *                         characters:
 *                           type: integer
 *                     sameText:
 *                       type: object
 *                       properties:
 *                         available:
 *                           type: boolean
 *                           description: False when the text is too short to compare.
 *                         enabled:
 *                           type: boolean
 *                           description: IGNORE_REPEATED_CONTENT
 *                     title:
 *                       type: object
 *                       properties:
 *                         suggestions:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               pattern:
 *                                 type: string
 *                               historyMatches:
 *                                 type: integer
 *                         existing:
 *                           type: array
 *                           items:
 *                             type: string
 *                     pageLimit:
 *                       type: object
 *                       properties:
 *                         current:
 *                           type: integer
 *                         suggested:
 *                           type: integer
 *                           nullable: true
 *       400:
 *         description: Invalid document id
 *       404:
 *         description: Document not found in Paperless-ngx
 */
router.get(
  '/api/ignored/suggest/:documentId',
  isAuthenticated,
  async (req, res) => {
    try {
      const documentId = parseInt(req.params.documentId, 10);
      if (!Number.isInteger(documentId) || documentId < 1) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid document ID' });
      }
      const data = await skipRuleService.suggest(documentId);
      if (!data) {
        return res
          .status(404)
          .json({ success: false, error: `Document ${documentId} not found` });
      }
      return res.json({ success: true, data });
    } catch (error) {
      console.error('[ERROR] GET /api/ignored/suggest/:documentId:', error);
      return res.status(error?.response?.status === 404 ? 404 : 500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

/**
 * @swagger
 * /api/ignored/skip:
 *   post:
 *     summary: Skip one document and store rules for documents like it
 *     description: |
 *       Puts the document on the ignored list and, as chosen, keeps its text
 *       fingerprint (so copies are skipped), adds a title part to
 *       IGNORE_TITLE_PATTERNS and sets MAX_PAGE_COUNT. A value the container
 *       injects is not changed and is listed in notSaved.
 *     tags:
 *       - Documents
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - documentId
 *             properties:
 *               documentId:
 *                 type: integer
 *                 minimum: 1
 *               sameText:
 *                 type: boolean
 *                 default: true
 *               titlePattern:
 *                 type: string
 *                 nullable: true
 *               pageLimit:
 *                 type: integer
 *                 minimum: 1
 *                 nullable: true
 *     responses:
 *       200:
 *         description: The document is ignored and the rules are stored
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
 *                     rules:
 *                       type: array
 *                       items:
 *                         type: string
 *                     notSaved:
 *                       type: array
 *                       items:
 *                         type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid document id or page limit
 *       404:
 *         description: Document not found in Paperless-ngx
 */
router.post('/api/ignored/skip', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.body?.documentId, 10);
    if (!Number.isInteger(documentId) || documentId < 1) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }
    const rawLimit = req.body?.pageLimit;
    const pageLimit =
      rawLimit === undefined || rawLimit === null || rawLimit === ''
        ? null
        : Number(rawLimit);
    if (pageLimit !== null && !(Number.isInteger(pageLimit) && pageLimit > 0)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid page limit. Use a whole number of pages.',
      });
    }

    const data = await skipRuleService.skipDocument(documentId, {
      sameText: req.body?.sameText !== false,
      titlePattern:
        typeof req.body?.titlePattern === 'string'
          ? req.body.titlePattern
          : null,
      pageLimit,
    });
    const notSavedNote = data.notSaved.length
      ? ` Set by the container, not changed: ${data.notSaved.join(', ')}.`
      : '';
    return res.json({
      success: true,
      data,
      message: `Document ${documentId} skipped (${data.rules.join(', ')}).${notSavedNote}`,
    });
  } catch (error) {
    console.error('[ERROR] POST /api/ignored/skip:', error);
    const status =
      error?.status === 404 || error?.response?.status === 404 ? 404 : 500;
    return res.status(status).json({ success: false, error: error.message });
  }
});

// API: Remove a document from the ignored list (unignore)
router.delete('/api/ignored/:documentId', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.params.documentId, 10);
    if (isNaN(documentId)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    const removed = await documentModel.removeIgnoredDocument(documentId);
    return res.json({
      success: removed,
      message: removed
        ? `Document ${documentId} removed from ignored list. It will be processed again, even if a skip rule matches it.`
        : `Document ${documentId} was not in ignored list.`,
    });
  } catch (error) {
    console.error('[ERROR] DELETE /api/ignored/:documentId:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// API: Clear all ignored documents
router.post('/api/ignored/clear-all', isAuthenticated, async (req, res) => {
  try {
    const count = await documentModel.clearAllIgnoredDocuments();
    return res.json({
      success: true,
      count,
      message:
        count > 0
          ? `${count} ignored document${count === 1 ? '' : 's'} removed. They can be scanned again.`
          : 'No ignored documents to remove.',
    });
  } catch (error) {
    console.error('[ERROR] POST /api/ignored/clear-all:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// API: Move a failed document to the ignored list (atomic: add to ignored + remove from failed)
router.post(
  '/api/failed/ignore/:documentId',
  isAuthenticated,
  async (req, res) => {
    try {
      const documentId = parseInt(req.params.documentId, 10);
      if (isNaN(documentId)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid document ID' });
      }

      const failedDocs = await documentModel.getFailedDocumentsPaginated({
        search: String(documentId),
        limit: 1,
        offset: 0,
      });
      const failedDoc = failedDocs.docs.find(
        (d) => d.document_id === documentId
      );
      const title = failedDoc?.title || '';

      await documentModel.addIgnoredDocument(
        documentId,
        title,
        'failed_document'
      );
      await documentModel.resetFailedDocument(documentId);
      await documentModel.clearProcessingStatusByDocumentId(documentId);
      skipRuleService.rememberFingerprints([documentId]);

      return res.json({
        success: true,
        message: `Document ${documentId} moved to ignored list.`,
      });
    } catch (error) {
      console.error('[ERROR] POST /api/failed/ignore/:documentId:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

module.exports = router;
