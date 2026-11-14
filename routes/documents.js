'use strict';

/**
 * Document lookups for the chat page and the thumbnail proxy.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   GET   /api/chat/documents   Search documents for omnibox selectors
 *   GET   /thumb/:documentId    Get document thumbnail
 */

const express = require('express');
const paperlessService = require('../services/paperlessService.js');
const documentsService = require('../services/documentsService.js');
const fs = require('fs').promises;
const { isAuthenticated } = require('./auth.js');
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('../services/thumbnailCachePaths');
const router = express.Router();

// Compatibility endpoint for omnibox document search used by Manual/OCR views.
/**
 * @swagger
 * /api/chat/documents:
 *   get:
 *     summary: Search documents for omnibox selectors
 *     description: Searches Paperless-ngx documents for Manual/OCR document selectors.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Search query. For mode=id this must be a positive integer document ID.
 *       - in: query
 *         name: mode
 *         schema:
 *           type: string
 *           enum: [all, title, tags, correspondent, id]
 *           default: all
 *         description: Search mode (id uses exact Paperless document ID lookup).
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 200
 *           default: 100
 *         description: Maximum number of documents returned.
 *     responses:
 *       200:
 *         description: Matching documents loaded successfully
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
 *                     documents:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           title:
 *                             type: string
 *                           created:
 *                             type: string
 *                             nullable: true
 *                           correspondent:
 *                             type: string
 *                           tags:
 *                             type: array
 *                             description: Resolved tag names for the document.
 *                             items:
 *                               type: string
 *       500:
 *         description: Server error
 */
router.get('/api/chat/documents', isAuthenticated, async (req, res) => {
  try {
    // Keep original casing for Paperless-ngx search; server-side search via query.
    const query = String(req.query?.q || '').trim();
    const requestedLimit = Number.parseInt(
      String(req.query?.limit || '100'),
      10
    );
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 100;
    const validModes = ['all', 'title', 'tags', 'correspondent', 'id'];
    const mode = validModes.includes(req.query?.mode) ? req.query.mode : 'all';

    const { documents, tagNames, correspondentNames } =
      await documentsService.getDocumentsWithMetadata(limit, query, mode);

    const normalizedDocuments = (Array.isArray(documents) ? documents : []).map(
      (doc) => {
        // Number(null) is 0, so an id check without the lower bound would treat
        // documents without a correspondent as a valid lookup.
        const correspondentId = Number(doc?.correspondent);
        const correspondentName =
          Number.isInteger(correspondentId) && correspondentId > 0
            ? correspondentNames?.[correspondentId] || ''
            : '';

        const resolvedTags = (Array.isArray(doc?.tags) ? doc.tags : [])
          .map((id) => tagNames?.[id])
          .filter(Boolean);

        return {
          id: doc?.id,
          title: doc?.title || '',
          created: doc?.created || doc?.created_date || doc?.added || null,
          correspondent: correspondentName,
          tags: resolvedTags,
        };
      }
    );

    return res.json({
      success: true,
      data: {
        documents: normalizedDocuments.slice(0, limit),
      },
    });
  } catch (error) {
    console.error('[ERROR] GET /api/chat/documents:', error);
    return res.status(500).json({
      success: false,
      error: 'Error loading chat documents',
    });
  }
});

/**
 * @swagger
 * /thumb/{documentId}:
 *   get:
 *     summary: Get document thumbnail
 *     description: |
 *       Retrieves the thumbnail image for a specific document from the Paperless-ngx system.
 *       This endpoint proxies the request to the Paperless-ngx API and returns the thumbnail
 *       image for display in the UI.
 *
 *       The thumbnail is returned as an image file in the format provided by Paperless-ngx,
 *       typically JPEG or PNG.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID of the document to retrieve thumbnail for
 *         example: 123
 *     responses:
 *       200:
 *         description: Thumbnail retrieved successfully
 *         content:
 *           image/*:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Document or thumbnail not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Thumbnail not found"
 *       500:
 *         description: Server error or Paperless-ngx connection failure
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/thumb/:documentId', isAuthenticated, async (req, res) => {
  const documentId = req.params.documentId;

  // Validate documentId to prevent path traversal
  if (!/^\d+$/.test(documentId)) {
    return res.status(400).send('Invalid document ID');
  }

  const cachePath = getThumbnailCachePath(documentId);

  try {
    try {
      await fs.access(cachePath);
      console.log('Serving cached thumbnail');

      res.setHeader('Content-Type', 'image/png');
      return res.sendFile(cachePath);
    } catch (cacheError) {
      if (cacheError.code !== 'ENOENT') {
        console.warn(
          `[WARN] Failed to access thumbnail cache file ${cachePath}:`,
          cacheError.message
        );
      }

      console.log('Thumbnail not cached, fetching from Paperless');

      const thumbnailData = await paperlessService.getThumbnailImage(
        req.params.documentId
      );

      if (!thumbnailData) {
        return res.status(404).send('Thumbnail not found');
      }

      await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
      await fs.writeFile(cachePath, thumbnailData);

      res.setHeader('Content-Type', 'image/png');
      return res.send(thumbnailData);
    }
  } catch (error) {
    console.error('[ERROR] while fetching thumbnail:', error);
    return res.status(500).send('Failed to load thumbnail');
  }
});

module.exports = router;
