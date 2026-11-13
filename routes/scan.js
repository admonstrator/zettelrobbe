'use strict';

/**
 * Scan control: start and stop a scan, the processing status, and the
 * Paperless-ngx webhook that queues a document.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   POST  /api/scan/now            Trigger immediate document scan
 *   POST  /api/scan/stop           Request graceful stop for active scan
 *   POST  /api/webhook/document    Webhook for document updates
 *   GET   /api/processing-status   Get document processing status
 */

const express = require('express');
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const { isAuthenticated } = require('./auth.js');
const scanControl = require('../services/scanControl');
const webhookQueueService = require('../services/webhookQueueService');
const {
  buildScannerHealthSnapshot,
} = require('../services/scannerHealthSnapshot');
const router = express.Router();

/**
 * @swagger
 * /api/scan/now:
 *   post:
 *     summary: Trigger immediate document scan
 *     description: |
 *       Initiates an immediate scan of documents in Paperless-ngx that haven't been processed yet.
 *       This endpoint can be used to manually trigger processing without waiting for the scheduled interval.
 *
 *       The scan will:
 *       - Connect to Paperless-ngx API
 *       - Fetch all unprocessed documents
 *       - Process each document with the configured AI service
 *       - Update documents in Paperless-ngx with generated metadata
 *
 *       The process respects the function limitations set in the configuration.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Scan trigger processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 started:
 *                   type: boolean
 *                 running:
 *                   type: boolean
 *                 stopRequested:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Setup has not been completed yet
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
 *                   example: "Setup not completed"
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
 *       503:
 *         description: Scan control not ready
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error during document scan"
 */
router.post('/api/scan/now', isAuthenticated, async (req, res) => {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      return res.status(400).json({
        success: false,
        error: 'Setup not completed',
      });
    }

    // No user-ID probe here on purpose: the scan runs with the configured API
    // token and never needs the numeric user ID. The guard that used to sit
    // here failed a scan with an unlogged 500 whenever PAPERLESS_USERNAME did
    // not match a name in /api/users/ (issue #305).
    if (!scanControl.canTriggerScan()) {
      return res.status(503).json({
        success: false,
        error:
          'Scan control is not available yet. Please try again in a moment.',
      });
    }

    const result = await scanControl.triggerScanNow('api-manual');
    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('[ERROR] /api/scan/now:', error);
    return res.status(500).json({
      success: false,
      error: 'Error during document scan trigger',
    });
  }
});

/**
 * @swagger
 * /api/scan/stop:
 *   post:
 *     summary: Request graceful stop for active scan
 *     description: |
 *       Requests a graceful stop of the currently running scan.
 *       The current document is allowed to finish processing before the scan exits.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Stop request processed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 running:
 *                   type: boolean
 *                 stopRequested:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized - authentication required
 */
router.post('/api/scan/stop', isAuthenticated, async (req, res) => {
  try {
    if (!scanControl.canRequestStop()) {
      return res.status(503).json({
        success: false,
        error:
          'Scan control is not available yet. Please try again in a moment.',
      });
    }

    const requested = scanControl.requestScanStop();
    const scanState = scanControl.getState();
    return res.json({
      success: true,
      running: Boolean(scanState.running),
      stopRequested: Boolean(scanState.stopRequested),
      message: requested
        ? 'Stop requested. The current document will finish before scan stops.'
        : 'No active scan to stop.',
    });
  } catch (error) {
    console.error('[ERROR] /api/scan/stop:', error);
    return res.status(500).json({
      success: false,
      error: 'Error while requesting scan stop',
    });
  }
});

/**
 * @swagger
 * /api/webhook/document:
 *   post:
 *     summary: Webhook for document updates
 *     description: |
 *       Processes incoming webhook notifications from Paperless-ngx about document
 *       changes, additions, or deletions. The webhook allows Zettelrobbe to respond
 *       to document changes in real-time.
 *
 *       When a new document is added or updated in Paperless-ngx, this endpoint can
 *       trigger automatic AI processing for metadata extraction.
 *     tags:
 *       - Documents
 *       - API
 *       - System
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - event_type
 *               - document_id
 *             properties:
 *               event_type:
 *                 type: string
 *                 description: Type of event that occurred
 *                 enum: ["added", "updated", "deleted"]
 *                 example: "added"
 *               document_id:
 *                 type: integer
 *                 description: ID of the affected document
 *                 example: 123
 *               document_info:
 *                 type: object
 *                 description: Additional information about the document (optional)
 *                 properties:
 *                   title:
 *                     type: string
 *                     example: "Invoice"
 *     responses:
 *       200:
 *         description: Webhook processed successfully
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
 *                   example: "Document event processed"
 *                 processing_queued:
 *                   type: boolean
 *                   description: Whether AI processing was queued for this document
 *                   example: true
 *       400:
 *         description: Invalid webhook payload
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
 *                   example: "Missing required fields: event_type, document_id"
 *       401:
 *         description: Unauthorized - invalid or missing API key
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Unauthorized: Invalid API key"
 *       500:
 *         description: Server error processing webhook
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/api/webhook/document', isAuthenticated, async (req, res) => {
  try {
    const { url, prompt } = req.body;
    if (!url) {
      return res.status(400).send('Missing document URL');
    }

    try {
      const documentId = webhookQueueService.extractDocumentId(url);
      const document = await paperlessService.getDocument(documentId);

      if (!document) {
        return res.status(404).send(`Document with ID ${documentId} not found`);
      }

      webhookQueueService.enqueue(document, { applySkipRules: true });
      if (prompt) {
        console.log('[DEBUG] Using custom prompt:', prompt);
        await webhookQueueService.processQueue(prompt);
      } else {
        await webhookQueueService.processQueue();
      }

      res.status(202).send({
        message: 'Document accepted for processing',
        documentId: documentId,
        queuePosition: webhookQueueService.getQueueLength(),
      });
    } catch (error) {
      console.error(
        '[ERROR] Failed to extract document ID or fetch document:',
        error
      );
      return res.status(200).send('Invalid document URL format');
    }
  } catch (error) {
    console.error('[ERROR] Error in webhook endpoint:', error);
    res.status(200).send('Internal server error');
  }
});

/**
 * @swagger
 * /api/processing-status:
 *   get:
 *     summary: Get document processing status
 *     description: |
 *       Returns the current status of document processing operations.
 *       This endpoint provides information about documents in the processing queue
 *       and the current processing state (active/idle).
 *
 *       The status information can be used by UIs to display progress indicators
 *       and provide real-time feedback about background processing operations.
 *     tags:
 *       - Documents
 *       - System
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Processing status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isProcessing:
 *                   type: boolean
 *                   description: Whether documents are currently being processed
 *                   example: true
 *                 isScanning:
 *                   type: boolean
 *                   description: Whether a scan loop is currently running
 *                   example: true
 *                 stopRequested:
 *                   type: boolean
 *                   description: Whether a graceful stop has been requested
 *                   example: false
 *                 scanner:
 *                   $ref: '#/components/schemas/ScannerHealth'
 *                 paperless:
 *                   $ref: '#/components/schemas/PaperlessHealth'
 *                 currentlyProcessing:
 *                   type: object
 *                   description: Details about the document currently being processed (if any)
 *                   properties:
 *                     documentId:
 *                       type: integer
 *                       description: Document ID
 *                       example: 123
 *                     title:
 *                       type: string
 *                       description: Document title
 *                       example: "Invoice #12345"
 *                     status:
 *                       type: string
 *                       description: Current processing status
 *                       example: "processing"
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
 *                   example: "Failed to fetch processing status"
 */
router.get('/api/processing-status', isAuthenticated, async (req, res) => {
  try {
    const status = await documentModel.getCurrentProcessingStatus();
    const scanState = scanControl.getState();
    res.json({
      ...status,
      isScanning: Boolean(scanState.running),
      stopRequested: Boolean(scanState.stopRequested),
      ...buildScannerHealthSnapshot(),
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch processing status' });
  }
});

module.exports = router;
