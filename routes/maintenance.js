'use strict';

/**
 * Maintenance actions of the settings page: the tag and thumbnail caches, the
 * reconciliation of the history with Paperless-ngx, and the reset of
 * processing records.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   POST  /api/settings/clear-tag-cache         Manually clear the centralized tag cache
 *   GET   /api/settings/thumbnail-cache         Get thumbnail cache statistics
 *   POST  /api/settings/thumbnail-cache/clear   Clear thumbnail cache
 *   POST  /api/settings/reconcile-history       Manually trigger history reconciliation (Server-Sent Events)
 *   POST  /api/reset-all-documents
 *   POST  /api/reset-documents                  Reset specific documents
 */

const express = require('express');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const { isAuthenticated } = require('./auth.js');
const { cacheClearLimiter } = require('../middleware/rateLimiters');
const {
  getThumbnailCacheStats,
  clearThumbnailCache,
  removeThumbnailCacheForDocumentIds,
} = require('../services/thumbnailCache');
const reconciliationService = require('../services/reconciliationService');
const router = express.Router();

/**
 * The message the manual reconciliation stream shows for a pass that deleted
 * nothing on purpose.
 *
 * reconcileAllDocuments() vetoes a run whenever the Paperless-ngx answer could
 * be a failure rather than a smaller archive, and returns a `reason` saying
 * which veto fired. They mean very different things to the person who pressed
 * the button — "wait for the scan" and "your token was rejected" are not the
 * same news — so each gets its own sentence instead of the single
 * already-in-progress line this endpoint used to show for all of them.
 *
 * @param {string|undefined} reason - the `reason` from reconcileAllDocuments()
 * @returns {string}
 */
function reconciliationSkipMessage(reason) {
  switch (reason) {
    case 'already_running':
    case 'scan_in_progress':
      return 'Reconciliation skipped: a scan or reconciliation is already in progress.';
    case 'paperless_unavailable':
    case 'connection_check_failed':
      return 'Paperless-ngx is not reachable or the token was rejected; nothing was changed.';
    case 'document_list_incomplete':
      return 'Paperless-ngx returned an incomplete document list; nothing was changed.';
    case 'empty_document_list':
    case 'all_tracked_documents_stale':
      return 'Paperless-ngx reported no matching documents; refusing to delete local records. Check the connection and the API token.';
    default:
      return `Reconciliation skipped (${reason || 'unknown reason'}).`;
  }
}

/**
 * @swagger
 * /api/settings/clear-tag-cache:
 *   post:
 *     summary: Manually clear the centralized tag cache
 *     description: Forces the tag cache to refresh on next access. Useful after external tag modifications.
 *     tags:
 *       - Settings
 *     security:
 *       - ApiKeyAuth: []
 *       - BearerAuth: []
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
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized - authentication required
 *       429:
 *         description: Too many requests - rate limit exceeded (max 10 requests per 15 minutes)
 *       500:
 *         description: Server error
 */
router.post(
  '/api/settings/clear-tag-cache',
  isAuthenticated,
  cacheClearLimiter,
  async (req, res) => {
    try {
      paperlessService.clearTagCache();
      console.log('[INFO] Tag cache cleared manually by user');
      res.json({
        success: true,
        message:
          'Tag cache cleared successfully. Cache will refresh on next use.',
      });
    } catch (error) {
      console.error('[ERROR] clearing tag cache:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to clear tag cache',
      });
    }
  }
);

/**
 * @swagger
 * /api/settings/thumbnail-cache:
 *   get:
 *     summary: Get thumbnail cache statistics
 *     description: Returns current thumbnail cache count and total size from local cache storage.
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Thumbnail cache stats retrieved successfully
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
 *                     fileCount:
 *                       type: integer
 *                     totalBytes:
 *                       type: integer
 *                     totalSizeHuman:
 *                       type: string
 *       500:
 *         description: Server error
 */
router.get(
  '/api/settings/thumbnail-cache',
  isAuthenticated,
  async (req, res) => {
    try {
      const stats = await getThumbnailCacheStats();
      return res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      console.error('[ERROR] reading thumbnail cache stats:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to read thumbnail cache stats',
      });
    }
  }
);

/**
 * @swagger
 * /api/settings/thumbnail-cache/clear:
 *   post:
 *     summary: Clear thumbnail cache
 *     description: Deletes all cached thumbnail PNG files from local cache storage and returns cleanup stats.
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Thumbnail cache cleared successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 removedFiles:
 *                   type: integer
 *                 freedBytes:
 *                   type: integer
 *                 freedSizeHuman:
 *                   type: string
 *                 remaining:
 *                   type: object
 *                   properties:
 *                     fileCount:
 *                       type: integer
 *                     totalBytes:
 *                       type: integer
 *                     totalSizeHuman:
 *                       type: string
 *       429:
 *         description: Too many requests - rate limit exceeded
 *       500:
 *         description: Server error
 */
router.post(
  '/api/settings/thumbnail-cache/clear',
  isAuthenticated,
  cacheClearLimiter,
  async (req, res) => {
    try {
      const cleanup = await clearThumbnailCache();
      const remaining = await getThumbnailCacheStats();

      return res.json({
        success: true,
        message: `Thumbnail cache cleared. Removed ${cleanup.removedFiles} files (${cleanup.freedSizeHuman}).`,
        removedFiles: cleanup.removedFiles,
        freedBytes: cleanup.freedBytes,
        freedSizeHuman: cleanup.freedSizeHuman,
        remaining,
      });
    } catch (error) {
      console.error('[ERROR] clearing thumbnail cache:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to clear thumbnail cache',
      });
    }
  }
);

/**
 * @swagger
 * /api/settings/reconcile-history:
 *   post:
 *     summary: Manually trigger history reconciliation (Server-Sent Events)
 *     description: |
 *       Triggers an immediate reconciliation pass that removes stale entries from the
 *       local AI database for documents that have been deleted in Paperless-ngx.
 *       Uses Server-Sent Events (SSE) to stream real-time progress.
 *       Returns a single result event with the number of removed entries.
 *
 *       A pass that refused to delete anything — a scan is running, Paperless-ngx
 *       is unreachable or unauthorized, the document list came back incomplete or
 *       empty — carries `skipped: true`, `removed: 0` and a `message` naming the
 *       reason. Nothing was changed in that case.
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Reconciliation result (SSE stream)
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: |
 *                 data: {"type":"complete","skipped":false,"removed":3,"durationMs":120,"message":"Removed 3 stale entries."}
 *                 data: {"type":"complete","skipped":true,"removed":0,"durationMs":8,"message":"Paperless-ngx is not reachable or the token was rejected; nothing was changed."}
 *       401:
 *         description: Unauthorized - authentication required
 *       500:
 *         description: Server error during reconciliation
 */
router.post(
  '/api/settings/reconcile-history',
  isAuthenticated,
  cacheClearLimiter,
  async (req, res) => {
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      res.write(
        `data: ${JSON.stringify({ type: 'progress', message: 'Starting reconciliation...' })}\n\n`
      );
      if (res.flush) res.flush();

      const result = await reconciliationService.reconcileAllDocuments();

      if (result && result.skipped) {
        res.write(
          `data: ${JSON.stringify({ type: 'complete', skipped: true, removed: 0, durationMs: result.durationMs || 0, message: reconciliationSkipMessage(result.reason) })}\n\n`
        );
      } else {
        const removed = result ? result.removed : 0;
        const durationMs = result ? result.durationMs : 0;
        res.write(
          `data: ${JSON.stringify({ type: 'complete', skipped: false, removed, durationMs, message: removed > 0 ? `Removed ${removed} stale entries.` : 'No stale entries found.' })}\n\n`
        );
      }

      if (res.flush) res.flush();
      res.end();
    } catch (error) {
      console.error('[ERROR] manual reconciliation:', error);
      try {
        res.write(
          `data: ${JSON.stringify({ type: 'error', error: 'Reconciliation failed. Check server logs.' })}\n\n`
        );
        if (res.flush) res.flush();
        res.end();
      } catch {
        /* client disconnected */
      }
    }
  }
);

router.post(
  '/api/reset-all-documents',
  isAuthenticated,
  cacheClearLimiter,
  async (req, res) => {
    try {
      await documentModel.deleteAllDocuments();
      res.json({ success: true });
    } catch (error) {
      console.error('[ERROR] resetting documents:', error);
      res.status(500).json({ error: 'Error resetting documents' });
    }
  }
);

/**
 * @swagger
 * /api/reset-documents:
 *   post:
 *     summary: Reset specific documents
 *     description: |
 *       Deletes processing records for specific documents, allowing them to be processed again.
 *       This doesn't delete the actual documents from Paperless-ngx, only their processing status in Zettelrobbe.
 *
 *       This operation is useful when you want to reprocess only selected documents after changes to
 *       the AI model, prompt, or document metadata configuration.
 *     tags:
 *       - Documents
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
 *             required:
 *               - ids
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Array of document IDs to reset
 *                 example: [123, 456, 789]
 *     responses:
 *       200:
 *         description: Documents successfully reset
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid request
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Invalid document IDs"
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
router.post(
  '/api/reset-documents',
  cacheClearLimiter,
  isAuthenticated,
  async (req, res) => {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids)) {
        return res.status(400).json({ error: 'Invalid document IDs' });
      }

      await documentModel.deleteDocumentsIdList(ids);
      await removeThumbnailCacheForDocumentIds(ids);
      res.json({ success: true });
    } catch (error) {
      console.error('[ERROR] resetting documents:', error);
      res.status(500).json({ error: 'Error resetting documents' });
    }
  }
);

module.exports = router;
