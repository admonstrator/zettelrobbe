'use strict';

/**
 * The history page and its API: the processed documents, their details,
 * restore and rescan, the tag cache clear of the page, and the validation
 * against Paperless-ngx.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   GET   /history                     Document history page
 *   GET   /api/history/load-progress   Get processed document history
 *   GET   /api/history
 *   POST  /api/history/clear-cache     Reset all processed documents
 *   GET   /api/history/:id/detail      Get detailed history entry data
 *   POST  /api/history/:id/restore     Restore document to pre-AI state
 *   POST  /api/history/:id/rescan      Reset one document for reprocessing
 *   POST  /api/history/rescan          Rescan (reprocess) multiple documents by ID
 *   GET   /api/history/validate        Validate history entries against Paperless-ngx (Server-Sent Events)
 */

const express = require('express');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const configFile = require('../config/config.js');
const { isAuthenticated } = require('./auth.js');
const { cacheClearLimiter } = require('../middleware/rateLimiters');
const webhookQueueService = require('../services/webhookQueueService');
const router = express.Router();

/**
 * @swagger
 * /history:
 *   get:
 *     summary: Document history page
 *     description: |
 *       Renders the document history page with filtering options.
 *       This page displays a list of all documents that have been processed by Zettelrobbe,
 *       showing the changes made to the documents through AI processing.
 *
 *       The page includes filtering capabilities by correspondent, tag, and free text search,
 *       allowing users to easily find specific documents or categories of processed documents.
 *       Each entry includes links to the original document in Paperless-ngx.
 *     tags:
 *       - History
 *       - Navigation
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: History page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the history page with filtering controls and document list
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/history', isAuthenticated, async (req, res) => {
  try {
    // Don't preload data - let the frontend load it with progress tracking
    // This allows the page to render immediately
    res.render('history', {
      version: configFile.PAPERLESS_AI_VERSION,
      filters: {
        allTags: [], // Will be loaded by JavaScript via /api/history/load-progress
        allCorrespondents: [], // Will be populated when DataTable loads
      },
    });
  } catch (error) {
    console.error('[ERROR] loading history page:', error);
    res.status(500).send('Error loading history page');
  }
});

/**
 * @swagger
 * /api/history:
 *   get:
 *     summary: Get processed document history
 *     description: |
 *       Returns a paginated list of documents that have been processed by Zettelrobbe.
 *       Supports filtering by tag, correspondent, and search term.
 *       Designed for integration with DataTables jQuery plugin.
 *
 *       This endpoint provides comprehensive information about each processed document,
 *       including its metadata before and after AI processing, allowing users to track
 *       changes made by the system.
 *     tags:
 *       - History
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: draw
 *         schema:
 *           type: integer
 *         description: Draw counter for DataTables (prevents XSS)
 *         example: 1
 *       - in: query
 *         name: start
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Starting record index for pagination
 *         example: 0
 *       - in: query
 *         name: length
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of records to return per page
 *         example: 10
 *       - in: query
 *         name: search[value]
 *         schema:
 *           type: string
 *         description: Global search term (searches title, correspondent and tags)
 *         example: "invoice"
 *       - in: query
 *         name: tag
 *         schema:
 *           type: string
 *         description: Filter by tag ID
 *         example: "5"
 *       - in: query
 *         name: correspondent
 *         schema:
 *           type: string
 *         description: Filter by correspondent name
 *         example: "Acme Corp"
 *       - in: query
 *         name: order[0][column]
 *         schema:
 *           type: integer
 *         description: Index of column to sort by (0=document_id, 1=title, etc.)
 *         example: 1
 *       - in: query
 *         name: order[0][dir]
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *         description: Sort direction (ascending or descending)
 *         example: "desc"
 *     responses:
 *       200:
 *         description: Document history returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 draw:
 *                   type: integer
 *                   description: Echo of the draw parameter
 *                   example: 1
 *                 recordsTotal:
 *                   type: integer
 *                   description: Total number of records in the database
 *                   example: 100
 *                 recordsFiltered:
 *                   type: integer
 *                   description: Number of records after filtering
 *                   example: 20
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       document_id:
 *                         type: integer
 *                         description: Document ID
 *                         example: 123
 *                       title:
 *                         type: string
 *                         description: Document title
 *                         example: "Invoice #12345"
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                         description: Date and time when the processing occurred
 *                         example: "2023-07-15T14:30:45Z"
 *                       tags:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: integer
 *                               example: 5
 *                             name:
 *                               type: string
 *                               example: "Invoice"
 *                             color:
 *                               type: string
 *                               example: "#FF5733"
 *                       correspondent:
 *                         type: string
 *                         description: Document correspondent name
 *                         example: "Acme Corp"
 *                       link:
 *                         type: string
 *                         description: Link to the document in Paperless-ngx
 *                         example: "http://paperless.example.com/documents/123/"
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error loading history data"
 */
/**
 * @swagger
 * /api/history/load-progress:
 *   get:
 *     summary: Load history data with progress updates (Server-Sent Events)
 *     description: |
 *       Preloads history and tag data with real-time progress updates via SSE.
 *       This endpoint should be called before displaying the history table to warm up the cache.
 *       Requires authentication via JWT token or API key.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Loading in progress (SSE stream)
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: |
 *                 data: {"type":"progress","percentage":10,"message":"Loading history entries..."}
 *
 *                 data: {"type":"complete","message":"Loaded 150 documents with 25 tags","count":150}
 *       401:
 *         description: Unauthorized - authentication required
 */
router.get('/api/history/load-progress', isAuthenticated, async (req, res) => {
  try {
    // Check if force reload is requested (bypass cache)
    const forceReload = req.query.force === 'true';

    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Helper function to send and flush immediately
    const sendProgress = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush(); // Force immediate send
    };

    // Step 1: Start
    sendProgress({
      type: 'progress',
      percentage: 0,
      step: 1,
      totalSteps: 3,
      message: forceReload
        ? 'Force reloading filters...'
        : 'Connecting to database...',
    });

    // Small delay to ensure first message is received
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Step 2: Load filter data only (not all documents)
    sendProgress({
      type: 'progress',
      percentage: 10,
      step: 1,
      totalSteps: 2,
      message: forceReload
        ? 'Force loading tags from Paperless...'
        : 'Loading tags from Paperless...',
    });

    // Load tags from centralized cache
    const allTags = await paperlessService.getTags();

    sendProgress({
      type: 'progress',
      percentage: 50,
      step: 1,
      totalSteps: 2,
      message: `Loaded ${allTags.length} tags`,
      details: { tags: allTags.length },
    });

    // Step 3: Load correspondents from DB (fast query)
    sendProgress({
      type: 'progress',
      percentage: 70,
      step: 2,
      totalSteps: 2,
      message: 'Loading correspondents...',
    });

    const allCorrespondents = await documentModel.getDistinctCorrespondents();
    const docCount = await documentModel.getHistoryDocumentsCount();

    // Step 4: Complete with filter data
    sendProgress({
      type: 'complete',
      message: `Ready: ${docCount} documents with ${allTags.length} tags`,
      count: docCount,
      details: { documents: docCount, tags: allTags.length },
      filters: {
        tags: allTags,
        correspondents: allCorrespondents,
      },
    });

    res.end();
  } catch (error) {
    console.error('[ERROR] loading history with progress:', error);
    if (res.headersSent) {
      const errorData = `data: ${JSON.stringify({ type: 'error', message: 'Error loading history' })}\n\n`;
      res.write(errorData);
      if (res.flush) res.flush();
    } else {
      res.status(500).json({ error: 'Error loading history' });
    }
    res.end();
  }
});

// No local tag cache needed - using centralized cache in paperlessService

router.get('/api/history', isAuthenticated, async (req, res) => {
  try {
    const draw = parseInt(req.query.draw);
    const start = parseInt(req.query.start) || 0;
    const length = parseInt(req.query.length) || 10;
    const search = req.query.search?.value || '';
    const tagFilter = req.query.tag || '';
    const correspondentFilter = req.query.correspondent || '';

    // Get sort parameters
    let sortColumn = 'created_at';
    let sortDir = 'desc';
    if (req.query.order && req.query.order[0]) {
      const order = req.query.order[0];
      sortColumn = req.query.columns[order.column].data;
      sortDir = order.dir;
    }

    // Use SQL-based pagination with filtering
    const docs = await documentModel.getHistoryPaginated({
      search,
      tagFilter,
      correspondentFilter,
      sortColumn,
      sortDir,
      limit: length,
      offset: start,
    });

    // Get total counts
    const totalCount = await documentModel.getHistoryDocumentsCount();
    const filteredCount = await documentModel.getHistoryCountFiltered({
      search,
      tagFilter,
      correspondentFilter,
    });

    // Get tags from centralized cache
    const allTags = await paperlessService.getTags();
    const tagMap = new Map(allTags.map((tag) => [tag.id, tag]));
    // Format documents with tag resolution
    const formattedDocs = docs.map((doc) => {
      const tagIds = doc.tags === '[]' ? [] : JSON.parse(doc.tags || '[]');
      const resolvedTags = tagIds
        .map((id) => tagMap.get(parseInt(id)))
        .filter(Boolean);
      resolvedTags.sort((a, b) => a.name.localeCompare(b.name));

      return {
        document_id: doc.document_id,
        title: doc.title || 'Modified: Invalid Date',
        created_at: doc.created_at,
        tags: resolvedTags,
        correspondent: doc.correspondent || 'Not assigned',
        link: `/dashboard/doc/${doc.document_id}`,
      };
    });

    res.json({
      draw: draw,
      recordsTotal: totalCount,
      recordsFiltered: filteredCount,
      data: formattedDocs,
    });
  } catch (error) {
    console.error('[ERROR] loading history data:', error);
    res.status(500).json({ error: 'Error loading history data' });
  }
});

/**
 * @swagger
 * /api/reset-all-documents:
 *   post:
 *     summary: Reset all processed documents
 *     description: |
 *       Deletes all processing records from the database, allowing documents to be processed again.
 *       This doesn't delete the actual documents from Paperless-ngx, only their processing status in Zettelrobbe.
 *
 *       This operation can be useful when changing AI models or prompts, as it allows reprocessing
 *       all documents with the updated configuration.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: All documents successfully reset
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error resetting documents"
 */
/**
 * @swagger
 * /api/history/clear-cache:
 *   post:
 *     summary: Clear tag cache
 *     description: Forces cache invalidation to load fresh filter data on next request
 *     tags:
 *       - History
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Cache cleared successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Cache cleared successfully"
 *       401:
 *         description: Unauthorized - authentication required
 *       500:
 *         description: Server error
 *       429:
 *         description: Too many requests - rate limit exceeded
 */
router.post(
  '/api/history/clear-cache',
  isAuthenticated,
  cacheClearLimiter,
  async (req, res) => {
    try {
      // Clear centralized tag cache
      paperlessService.clearTagCache();
      res.json({ success: true, message: 'Cache cleared successfully' });
    } catch (error) {
      console.error('[ERROR] clearing cache:', error);
      res.status(500).json({ error: 'Error clearing cache' });
    }
  }
);

/**
 * @swagger
 * /api/history/{id}/detail:
 *   get:
 *     summary: Get detailed history entry data
 *     description: Returns full stored AI output details and a live diff view against current Paperless metadata.
 *     tags:
 *       - History
 *       - API
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
 *       200:
 *         description: Detailed history data returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Invalid document ID
 *       404:
 *         description: No history entry found
 *       500:
 *         description: Server error
 */
router.get('/api/history/:id/detail', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.params.id, 10);
    if (isNaN(documentId)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    const [history, metrics, allTags] = await Promise.all([
      documentModel.getHistoryByDocumentId(documentId),
      documentModel.getMetricsByDocumentId(documentId),
      paperlessService.getTags(),
    ]);

    if (!history) {
      return res.status(404).json({
        success: false,
        error: 'No history entry found for this document',
      });
    }

    const tagMap = new Map(allTags.map((tag) => [tag.id, tag]));
    const historyTagIds = JSON.parse(history.tags || '[]').map((id) =>
      parseInt(id)
    );

    // Try to fetch live document for tag diff
    let liveTagIds = null;
    try {
      const liveDoc = await paperlessService.getDocument(documentId);
      liveTagIds = (liveDoc.tags || []).map((id) => parseInt(id));
    } catch (e) {
      console.warn(
        `[WARN] Could not fetch live document ${documentId} for diff:`,
        e.message
      );
    }

    // Build AI-set tag list with live diff status
    const aiTags = historyTagIds.map((id) => {
      const tag = tagMap.get(id);
      if (!tag)
        return { id, name: `Tag #${id}`, color: '#999999', status: 'unknown' };
      const status =
        liveTagIds === null
          ? 'unknown'
          : liveTagIds.includes(id)
            ? 'active'
            : 'removed';
      return { id: tag.id, name: tag.name, color: tag.color, status };
    });

    // Tags in Paperless that were NOT set by AI (added externally)
    const externalTags = liveTagIds
      ? liveTagIds
          .filter((id) => !historyTagIds.includes(id))
          .map((id) => {
            const tag = tagMap.get(id);
            return tag
              ? {
                  id: tag.id,
                  name: tag.name,
                  color: tag.color,
                  status: 'added_externally',
                }
              : null;
          })
          .filter(Boolean)
      : [];

    // Parse custom_fields safely
    let customFields = [];
    try {
      customFields = JSON.parse(history.custom_fields || '[]');
    } catch {
      customFields = [];
    }

    // Load original data for Restore feature
    const originalRow = await documentModel.getOriginalData(documentId);
    let originalData = null;
    if (originalRow) {
      originalData = {
        title: originalRow.title,
        correspondent: originalRow.correspondent,
        tags: JSON.parse(originalRow.tags || '[]'),
        documentType: originalRow.document_type ?? null,
        language: originalRow.language ?? null,
      };
    }

    res.json({
      success: true,
      document_id: documentId,
      history: {
        title: history.title,
        correspondent: history.correspondent,
        custom_fields: customFields,
        document_type_name: history.document_type_name ?? null,
        language: history.language ?? null,
        created_at: history.created_at,
      },
      tags: {
        aiSet: aiTags,
        external: externalTags,
        liveAvailable: liveTagIds !== null,
      },
      metrics: metrics
        ? {
            promptTokens: metrics.promptTokens,
            completionTokens: metrics.completionTokens,
            totalTokens: metrics.totalTokens,
          }
        : null,
      original: originalData,
      link: `/dashboard/doc/${documentId}`,
    });
  } catch (error) {
    console.error('[ERROR] /api/history/:id/detail:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/history/{id}/restore:
 *   post:
 *     summary: Restore document to pre-AI state
 *     description: Restores title, tags, correspondent and related metadata from saved original values.
 *     tags:
 *       - History
 *       - API
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
 *       200:
 *         description: Document restored successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid document ID
 *       404:
 *         description: Original data not found
 *       500:
 *         description: Server error
 */
router.post('/api/history/:id/restore', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.params.id, 10);
    if (isNaN(documentId)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    const originalRow = await documentModel.getOriginalData(documentId);
    if (!originalRow) {
      return res.status(404).json({
        success: false,
        error: 'No original data found for this document',
      });
    }

    // Parse and sanitise — SQLite stores IDs as TEXT which can come back
    // as float-strings (e.g. '593.0') if they were originally stored as
    // a JS number that went through JSON serialisation. Paperless-ngx
    // requires proper integers; parseInt handles both '593', '593.0' and 593.
    const rawCorrespondent = originalRow.correspondent;
    const rawDocType = originalRow.document_type;

    const original = {
      tags: JSON.parse(originalRow.tags || '[]')
        .map((id) => parseInt(id, 10))
        .filter((id) => !isNaN(id)),
      title: originalRow.title,
      correspondent:
        rawCorrespondent != null
          ? parseInt(rawCorrespondent, 10) || null
          : null,
      documentType:
        rawDocType != null ? parseInt(rawDocType, 10) || null : null,
      language: originalRow.language ?? null,
    };

    const result = await paperlessService.restoreDocument(documentId, original);
    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Failed to restore document in Paperless-ngx',
      });
    }

    res.json({
      success: true,
      message: 'Document restored to its original state.',
    });
  } catch (error) {
    console.error('[ERROR] /api/history/:id/restore:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/history/{id}/rescan:
 *   post:
 *     summary: Reset one document for reprocessing
 *     description: |
 *       Resolves the document in Paperless-ngx first and only then removes its
 *       local tracking records, so it is processed again in a subsequent scan.
 *       A document that cannot be resolved — deleted, or Paperless-ngx briefly
 *       unavailable — leaves every local record untouched and answers 404.
 *     tags:
 *       - History
 *       - API
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
 *       200:
 *         description: Document reset for rescanning
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid document ID
 *       404:
 *         description: Document could not be retrieved from Paperless-ngx; nothing was changed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *       500:
 *         description: Server error
 */
router.post('/api/history/:id/rescan', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.params.id, 10);
    if (isNaN(documentId)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    const { queued } = await webhookQueueService.rescanDocumentsByIds([
      documentId,
    ]);

    // Not queued means the document could not be resolved in Paperless-ngx.
    // Nothing was deleted in that case, so this is an honest 404 rather than
    // the success this endpoint used to report while the local snapshot was
    // already gone.
    if (queued === 0) {
      return res.status(404).json({
        success: false,
        error:
          'Document could not be retrieved from Paperless-ngx. Nothing was changed.',
      });
    }

    res.json({
      success: true,
      message: 'Document queued for reprocessing.',
    });
  } catch (error) {
    console.error('[ERROR] /api/history/:id/rescan:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/history/rescan:
 *   post:
 *     summary: Rescan (reprocess) multiple documents by ID
 *     description: |
 *       Forces reprocessing of the given documents regardless of the configured
 *       scan tag filters. The local processing record is cleared and each document
 *       is enqueued for direct AI processing, bypassing PROCESS_PREDEFINED_DOCUMENTS
 *       / TAGS scan-scope rules. Processing runs in the background.
 *     tags:
 *       - History
 *     security:
 *       - cookieAuth: []
 *       - apiKey: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ids
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Document IDs to reprocess
 *                 example: [42, 43, 44]
 *     responses:
 *       200:
 *         description: Documents enqueued for reprocessing
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 queued:
 *                   type: integer
 *                   example: 3
 *                 notFound:
 *                   type: array
 *                   items:
 *                     type: integer
 *                   example: []
 *       400:
 *         description: Invalid document IDs
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Server error
 */
router.post('/api/history/rescan', isAuthenticated, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document IDs' });
    }

    const { queued, notFound } =
      await webhookQueueService.rescanDocumentsByIds(ids);
    res.json({ success: true, queued, notFound });
  } catch (error) {
    console.error('[ERROR] /api/history/rescan:', error);
    res
      .status(500)
      .json({ success: false, error: 'Error queuing documents for rescan' });
  }
});

/**
 * @swagger
 * /api/history/validate:
 *   get:
 *     summary: Validate history entries against Paperless-ngx (Server-Sent Events)
 *     description: |
 *       Checks each history entry stored locally and verifies the corresponding document still exists in Paperless-ngx.
 *       Uses Server-Sent Events (SSE) to stream real-time progress updates.
 *       Processes documents in parallel batches (50 at a time) for faster validation.
 *       Returns progress updates and final list of missing documents.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Validation in progress (SSE stream)
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: |
 *                 data: {"type":"progress","current":50,"total":100,"missing":3,"percentage":50}
 *
 *                 data: {"type":"complete","missing":[{"document_id":123,"title":"Test Doc"}]}
 *       401:
 *         description: Unauthorized - authentication required
 *       500:
 *         description: Server error during validation
 */
router.get('/api/history/validate', isAuthenticated, async (req, res) => {
  try {
    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Get all history entries from local DB
    const allHistory = await documentModel.getAllHistory();
    const total = allHistory.length;

    // Send initial progress
    res.write(
      `data: ${JSON.stringify({ type: 'progress', current: 0, total, missing: 0 })}\n\n`
    );

    // Process documents in parallel batches for faster validation
    const missing = [];
    const BATCH_SIZE = 50; // Process 50 documents at a time
    let processed = 0;

    // Split into batches
    for (let i = 0; i < allHistory.length; i += BATCH_SIZE) {
      const batch = allHistory.slice(i, i + BATCH_SIZE);

      // Process batch in parallel
      const results = await Promise.allSettled(
        batch.map(async (h) => {
          try {
            await paperlessService.getDocument(h.document_id);
            return { success: true, doc: h };
          } catch {
            return { success: false, doc: h };
          }
        })
      );

      // Collect missing documents from this batch
      results.forEach((result) => {
        if (result.status === 'fulfilled' && !result.value.success) {
          missing.push({
            document_id: result.value.doc.document_id,
            title: result.value.doc.title || null,
          });
        }
      });

      processed += batch.length;

      // Send progress update after each batch
      res.write(
        `data: ${JSON.stringify({
          type: 'progress',
          current: processed,
          total,
          missing: missing.length,
          percentage: Math.round((processed / total) * 100),
        })}\n\n`
      );
    }

    // Send final result
    res.write(`data: ${JSON.stringify({ type: 'complete', missing })}\n\n`);
    res.end();
  } catch (error) {
    console.error('[ERROR] validating history:', error);
    res.write(
      `data: ${JSON.stringify({ type: 'error', error: 'Error validating history' })}\n\n`
    );
    res.end();
  }
});

module.exports = router;
