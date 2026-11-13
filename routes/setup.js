const express = require('express');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const configFile = require('../config/config.js');
const changelog = require('../config/changelog.js');
const { isAuthenticated } = require('./auth.js');
const {
  protectApiRoute,
  isAuthenticatedCaller,
} = require('../middleware/authGate');
const mistralOcrService = require('../services/mistralOcrService');
const skipRuleService = require('../services/skipRuleService');
const scanHealthService = require('../services/scanHealthService');
const updateCheckService = require('../services/updateCheckService');
const dashboardStatsService = require('../services/dashboardStatsService');
const duplicateMergeService = require('../services/duplicateMergeService');
const entityNameMatcher = require('../services/entityNameMatcher');
const entityMatchAiService = require('../services/entityMatchAiService');
const tagSimplifyService = require('../services/tagSimplifyService');
const { normalizeDocumentIdList } = require('../services/documentIdList');
const {
  buildScannerHealthSnapshot,
} = require('../services/scannerHealthSnapshot');
const { BOOT_IDENTITY } = require('../services/bootIdentity');
const router = express.Router();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: System health check endpoint
 *     description: |
 *       Reports database connectivity **and** whether the document scanner is
 *       actually able to work. Used by the Docker healthcheck and monitoring.
 *
 *       `status` is `healthy` when the database is reachable and the scanner is
 *       operational, `degraded` when automatic processing is enabled but the
 *       scan loop is not armed or has failed `failureThreshold` runs in a row
 *       (for example because Paperless-ngx is unreachable), and `database_error`
 *       when the local database cannot be queried.
 *
 *       A `degraded` state answers with HTTP 503 unless `HEALTHCHECK_STRICT=no`
 *       is configured, in which case the details are reported with HTTP 200.
 *       When automatic processing is switched off via
 *       `DISABLE_AUTOMATIC_PROCESSING=yes`, a missing scan loop is expected and
 *       never reported as degraded.
 *
 *       Without authentication the response carries only `status`,
 *       `database`, `bootId` and `startedAt`, with the same HTTP status codes.
 *       `message`, `scanner` and `paperless` hold raw error messages with
 *       internal host names and ports, so they are returned only with a
 *       session (cookie or bearer token) or the `x-api-key` header.
 *
 *       `bootId` is a random id the process draws when it starts. A client
 *       that waits for a restart polls until it sees an id other than the one
 *       it had before; the old process answers healthy until it exits.
 *     tags:
 *       - System
 *     responses:
 *       200:
 *         description: System is healthy and operational
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   description: Status indicating an error
 *                   example: "error"
 *                 message:
 *                   type: string
 *                   description: Error message details
 *                   example: "Internal server error"
 *       503:
 *         description: |
 *           Service unavailable — either the database check failed
 *           (`database_error`) or the scanner is degraded (`degraded`).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
router.get('/health', async (req, res) => {
  try {
    try {
      await documentModel.isDocumentProcessed(1);
    } catch {
      return res.status(503).json({
        status: 'database_error',
        message: 'Database check failed',
        ...BOOT_IDENTITY,
      });
    }

    const snapshot = buildScannerHealthSnapshot();
    const degraded = snapshot.scanner.degraded;
    const status = degraded ? 'degraded' : 'healthy';

    // /health is public for container healthchecks and uptime monitors, which
    // only need the status and the HTTP code. The scanner and Paperless-ngx
    // details carry raw error messages ("connect ECONNREFUSED 172.18.0.2:8000")
    // and the schedule, so only an authenticated caller gets them.
    if (!isAuthenticatedCaller(req)) {
      const summary = { status, database: 'ok', ...BOOT_IDENTITY };
      if (degraded && scanHealthService.strictHealthEnabled) {
        return res.status(503).json(summary);
      }
      return res.json(summary);
    }

    const payload = {
      status,
      database: 'ok',
      ...BOOT_IDENTITY,
      ...snapshot,
    };

    if (degraded) {
      payload.message = snapshot.scanner.armed
        ? `Document scan failed ${snapshot.scanner.consecutiveFailures} time(s) in a row: ${snapshot.scanner.lastError || 'unknown error'}`
        : 'Document scan scheduler is not armed';

      if (scanHealthService.strictHealthEnabled) {
        return res.status(503).json(payload);
      }
    }

    res.json(payload);
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({
      status: 'error',
      message: isAuthenticatedCaller(req)
        ? error.message
        : 'Health check failed',
    });
  }
});

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
 * /ignored:
 *   get:
 *     summary: Permanently ignored documents page
 *     tags:
 *       - Navigation
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Ignored queue page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       500:
 *         description: Server error
 */

// Page: About / Support Information
router.get('/about', protectApiRoute, async (req, res) => {
  try {
    const formatUptime = (totalSeconds) => {
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;

      const parts = [];
      if (days > 0) parts.push(`${days}d`);
      if (hours > 0) parts.push(`${hours}h`);
      if (minutes > 0) parts.push(`${minutes}m`);
      parts.push(`${seconds}s`);
      return parts.join(' ');
    };

    const supportInfo = {
      appVersion: configFile.PAPERLESS_AI_VERSION || 'unknown',
      commitSha: process.env.PAPERLESS_AI_COMMIT_SHA || 'unknown',
      paperlessNgxVersion: process.env.PAPERLESS_NGX_VERSION || 'unknown',
      nodeVersion: process.version,
      platform: `${process.platform} (${process.arch})`,
      nodeEnv: process.env.NODE_ENV || 'production',
      aiProvider: configFile.aiProvider || process.env.AI_PROVIDER || 'openai',
      ocrEnabled: configFile.mistralOcr?.enabled === 'yes',
      serverTimeUtc: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      uptime: formatUptime(Math.floor(process.uptime())),
      paperlessApiUrl: configFile.paperless?.apiUrl || 'unknown',
      ollamaApiUrl: configFile.ollama?.apiUrl || 'unknown',
      ollamaModel: configFile.ollama?.model || 'unknown',
      customBaseUrl: configFile.custom?.apiUrl || 'unknown',
      customModel: configFile.custom?.model || 'unknown',
      azureEndpoint: configFile.azure?.endpoint || 'unknown',
      azureDeploymentName: configFile.azure?.deploymentName || 'unknown',
      azureApiVersion: configFile.azure?.apiVersion || 'unknown',
      anthropicModel: configFile.anthropic?.model || 'unknown',
      // Empty means api.anthropic.com, which is worth saying in a bug report.
      anthropicApiUrl: configFile.anthropic?.apiUrl || 'default',
      ocrProvider: configFile.mistralOcr?.provider || 'mistral',
      mistralOcrModel: configFile.mistralOcr?.model || 'unknown',
      scanInterval: configFile.scanInterval || 'unknown',
      tokenLimit: String(configFile.tokenLimit || 'unknown'),
      responseTokens: String(configFile.responseTokens || 'unknown'),
      trustProxy: String(configFile.trustProxy),
      useExistingData: configFile.useExistingData || 'no',
      restrictToExistingTags: configFile.restrictToExistingTags || 'no',
      restrictToExistingCorrespondents:
        configFile.restrictToExistingCorrespondents || 'no',
      restrictToExistingDocumentTypes:
        configFile.restrictToExistingDocumentTypes || 'no',
      paperlessTokenSet: Boolean(configFile.paperless?.apiToken),
      openAiKeySet: Boolean(configFile.openai?.apiKey),
      customKeySet: Boolean(configFile.custom?.apiKey),
      azureKeySet: Boolean(configFile.azure?.apiKey),
      anthropicKeySet: Boolean(configFile.anthropic?.apiKey),
      mistralKeySet: Boolean(configFile.mistralOcr?.apiKey),
      apiKeySet: Boolean(configFile.getApiKey && configFile.getApiKey()),
    };

    return res.render('about', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
      supportInfo,
    });
  } catch (error) {
    console.error('[ERROR] About page:', error);
    return res.status(500).render('about', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
      supportInfo: {
        appVersion: configFile.PAPERLESS_AI_VERSION || 'unknown',
        commitSha: process.env.PAPERLESS_AI_COMMIT_SHA || 'unknown',
        paperlessNgxVersion: process.env.PAPERLESS_NGX_VERSION || 'unknown',
        nodeVersion: process.version,
        platform: `${process.platform} (${process.arch})`,
        nodeEnv: process.env.NODE_ENV || 'production',
        aiProvider:
          configFile.aiProvider || process.env.AI_PROVIDER || 'openai',
        ocrEnabled: configFile.mistralOcr?.enabled === 'yes',
        serverTimeUtc: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        uptime: 'unavailable',
        paperlessApiUrl: configFile.paperless?.apiUrl || 'unknown',
        ollamaApiUrl: configFile.ollama?.apiUrl || 'unknown',
        ollamaModel: configFile.ollama?.model || 'unknown',
        customBaseUrl: configFile.custom?.apiUrl || 'unknown',
        customModel: configFile.custom?.model || 'unknown',
        azureEndpoint: configFile.azure?.endpoint || 'unknown',
        azureDeploymentName: configFile.azure?.deploymentName || 'unknown',
        azureApiVersion: configFile.azure?.apiVersion || 'unknown',
        anthropicModel: configFile.anthropic?.model || 'unknown',
        anthropicApiUrl: configFile.anthropic?.apiUrl || 'default',
        ocrProvider: configFile.mistralOcr?.provider || 'mistral',
        mistralOcrModel: configFile.mistralOcr?.model || 'unknown',
        scanInterval: configFile.scanInterval || 'unknown',
        tokenLimit: String(configFile.tokenLimit || 'unknown'),
        responseTokens: String(configFile.responseTokens || 'unknown'),
        trustProxy: String(configFile.trustProxy),
        useExistingData: configFile.useExistingData || 'no',
        restrictToExistingTags: configFile.restrictToExistingTags || 'no',
        restrictToExistingCorrespondents:
          configFile.restrictToExistingCorrespondents || 'no',
        restrictToExistingDocumentTypes:
          configFile.restrictToExistingDocumentTypes || 'no',
        paperlessTokenSet: Boolean(configFile.paperless?.apiToken),
        openAiKeySet: Boolean(configFile.openai?.apiKey),
        customKeySet: Boolean(configFile.custom?.apiKey),
        azureKeySet: Boolean(configFile.azure?.apiKey),
        anthropicKeySet: Boolean(configFile.anthropic?.apiKey),
        mistralKeySet: Boolean(configFile.mistralOcr?.apiKey),
        apiKeySet: Boolean(configFile.getApiKey && configFile.getApiKey()),
      },
    });
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

// ── Tidy up support: the few /api/duplicates and /api/simplify routes the ───
// Tidy up page (/tidy-up, routes/tidyUp.js) calls besides its own /api/tidy-up/*.
// Everything here runs on request only; nothing is scheduled and nothing
// touches the scan loop.

/** Who to record as the author of a merge or an undo. */
function duplicatesPerformedBy(req) {
  return req.user?.username || (req.user?.apiKey ? 'api-key' : null);
}

/** Maps a refusal from the merge service onto its HTTP status. */
function respondDuplicatesError(res, route, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  console.error(`[ERROR] ${route}:`, error?.message || error);
  return res.status(status).json({
    success: false,
    error: error?.message || 'Unexpected error',
  });
}

/** Reads an optional `kind` query parameter; throws the route's own 400. */
function readDuplicatesKind(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const kind = String(value);
  if (!entityNameMatcher.KIND_LIST.includes(kind)) {
    const error = new Error(`Unknown entity kind: ${kind}`);
    error.status = 400;
    throw error;
  }
  return kind;
}

/**
 * @swagger
 * /duplicates:
 *   get:
 *     summary: Former Duplicates page, now part of Tidy up
 *     description: |
 *       The Duplicates page was replaced by Tidy up (`/tidy-up`); this path
 *       redirects there permanently so bookmarks keep working.
 *     tags:
 *       - Navigation
 *       - Duplicates
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       301:
 *         description: Moved permanently to /tidy-up
 *       401:
 *         description: Not authenticated
 */
router.get('/duplicates', protectApiRoute, (req, res) =>
  res.redirect(301, '/tidy-up')
);

/**
 * @swagger
 * /api/duplicates/ai-review/memory:
 *   delete:
 *     summary: Forget every remembered verdict of the AI judge
 *     description: |
 *       The judge remembers what it decided about a pair of names for
 *       DUPLICATES_AI_VERDICT_MEMORY_DAYS, so the next review only asks about
 *       what is new. This empties that memory, which makes the next review ask
 *       about everything again — the thing to do after the model changed or
 *       after a verdict turned out to be wrong.
 *
 *       Local only: nothing in Paperless-ngx is touched, and no merge is
 *       undone or repeated.
 *     tags:
 *       - Duplicates
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: The memory is empty
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
 *                     removed:
 *                       type: integer
 *                       description: verdicts that were forgotten
 *                 message:
 *                   type: string
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.delete(
  '/api/duplicates/ai-review/memory',
  isAuthenticated,
  async (req, res) => {
    try {
      // The judge owns the memory and clears its own in-process caches with
      // it; without that method the table is the whole memory there is.
      const answer =
        typeof entityMatchAiService.forgetVerdicts === 'function'
          ? await entityMatchAiService.forgetVerdicts()
          : await documentModel.clearAiPairVerdicts();
      const removed =
        answer && typeof answer === 'object'
          ? Number(answer.removed) || 0
          : Number(answer) || 0;
      return res.json({
        success: true,
        data: { removed },
        message:
          removed > 0
            ? `${removed} remembered verdict(s) forgotten.`
            : 'There was nothing to forget.',
      });
    } catch (error) {
      return respondDuplicatesError(
        res,
        'DELETE /api/duplicates/ai-review/memory',
        error
      );
    }
  }
);

/**
 * @swagger
 * /api/duplicates/dismissals:
 *   get:
 *     summary: List the pairs marked as "not a duplicate"
 *     tags:
 *       - Duplicates
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: kind
 *         schema:
 *           type: string
 *           enum: [tags, correspondents]
 *     responses:
 *       200:
 *         description: Dismissed pairs, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/EntityMergeDismissal'
 *       400:
 *         description: Unknown kind
 *       401:
 *         description: Not authenticated
 */
router.get('/api/duplicates/dismissals', isAuthenticated, async (req, res) => {
  try {
    const kind = readDuplicatesKind(req.query.kind);
    const data = await documentModel.listEntityMergeDismissals(kind);
    return res.json({ success: true, data });
  } catch (error) {
    return respondDuplicatesError(res, 'GET /api/duplicates/dismissals', error);
  }
});

/**
 * @swagger
 * /api/duplicates/dismissals/{id}:
 *   delete:
 *     summary: Restore a pair marked as "not a duplicate"
 *     description: The pair is offered by the scan again from the next run on.
 *     tags:
 *       - Duplicates
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
 *         description: Pair restored
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
 *         description: Invalid id
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Unknown pair
 */
router.delete(
  '/api/duplicates/dismissals/:id',
  isAuthenticated,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid dismissal id' });
      }
      const removed = await documentModel.removeEntityMergeDismissal(id);
      if (!removed) {
        return res
          .status(404)
          .json({ success: false, error: `Dismissal ${id} does not exist` });
      }
      return res.json({
        success: true,
        message: 'The pair is offered again from the next scan on.',
      });
    } catch (error) {
      return respondDuplicatesError(
        res,
        'DELETE /api/duplicates/dismissals/:id',
        error
      );
    }
  }
);

/**
 * @swagger
 * /api/duplicates/log/{id}/undo:
 *   post:
 *     summary: Undo a logged merge
 *     description: |
 *       Re-creates every source the merge deleted — a same-named object that
 *       exists again is adopted instead — and hands back the documents that
 *       still carry the target. Documents that were changed since the merge
 *       are counted as skipped and left alone. The re-created objects get new
 *       ids in Paperless-ngx.
 *
 *       The answer carries `success: false` with status 200 when at least one
 *       source could not be restored.
 *     tags:
 *       - Duplicates
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: id of the merge log entry
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Undo finished (completely or partially)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/EntityMergeUndoResult'
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid id
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Unknown merge
 *       409:
 *         description: Already undone, or a document scan is running
 *       502:
 *         description: Paperless-ngx could not be reached
 */
router.post(
  '/api/duplicates/log/:id/undo',
  isAuthenticated,
  async (req, res) => {
    try {
      const mergeId = parseInt(req.params.id, 10);
      if (!Number.isInteger(mergeId) || mergeId <= 0) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid merge id' });
      }

      const data = await duplicateMergeService.undo(mergeId, {
        performedBy: duplicatesPerformedBy(req),
      });
      const restored = data.sources.filter(
        (source) => source.restoredId != null
      ).length;
      const documents = data.sources.reduce(
        (sum, source) => sum + source.documentsRestored,
        0
      );
      const message =
        data.status === 'undone'
          ? `${restored} entr${restored === 1 ? 'y' : 'ies'} restored, ${documents} document(s) moved back.`
          : `Only ${restored} of ${data.sources.length} entries could be restored. The rest is listed with its reason.`;

      return res.json({
        success: data.status !== 'undo_failed',
        data,
        message,
      });
    } catch (error) {
      return respondDuplicatesError(
        res,
        'POST /api/duplicates/log/:id/undo',
        error
      );
    }
  }
);

/**
 * @swagger
 * /api/duplicates/ai-review/estimate:
 *   get:
 *     summary: What the next AI review would cost, before it starts
 *     description: |
 *       Answers the question the page asks before it spends anything: how
 *       many requests, how many tokens, how long. Nothing here asks a model
 *       and nothing scans — the page calls this again on every move of a
 *       lever, so it may only read what is already there.
 *
 *       A scan is a walk over every tag and every correspondent of the
 *       archive, so this never starts one. It answers from the scan the merge
 *       service still holds for these options, and when there is none it
 *       answers `needsScan: true` with `items: 0` and `basis: "guess"` — the
 *       page then says "scan first, then I can tell you" instead of showing a
 *       number nobody measured.
 *
 *       `basis` says where the numbers come from: `run` a finished review of
 *       this archive, `model` what the judge measured about this model,
 *       `guess` neither. `requests` is the judging pass alone; `extra` names
 *       what comes on top — the requests a semantic sweep would add, and the
 *       entities whose documents would be read for excerpts, which are reads
 *       of Paperless-ngx rather than model requests.
 *
 *       `items` counts the pairs of the scan's groups that the model would be
 *       asked about. A review that also asks about the candidate band asks
 *       about more: the band needs the entity list, and reading it is exactly
 *       the cost this endpoint exists to avoid.
 *     tags:
 *       - Duplicates
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: kind
 *         schema:
 *           type: string
 *           enum: [tags, correspondents, all]
 *         description: What the review would look at; `all` by default
 *       - in: query
 *         name: threshold
 *         schema:
 *           type: number
 *           minimum: 0
 *           maximum: 1
 *         description: The sensitivity the scan was made with
 *       - in: query
 *         name: sweep
 *         schema:
 *           type: integer
 *           enum: [0, 1]
 *         description: The semantic sweep is on
 *       - in: query
 *         name: excerpts
 *         schema:
 *           type: integer
 *           enum: [0, 1]
 *         description: Document excerpts are read as evidence
 *     responses:
 *       200:
 *         description: What the review would cost
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   allOf:
 *                     - $ref: '#/components/schemas/AiRunEstimate'
 *                     - type: object
 *                       properties:
 *                         model:
 *                           type: string
 *                           nullable: true
 *                         thinking:
 *                           type: boolean
 *                         groups:
 *                           type: integer
 *                           description: scan groups the review would judge
 *                         pairs:
 *                           type: integer
 *                           description: |
 *                             every pair of those groups — what the model is
 *                             asked about plus what a spelling rule settled
 *                         needsScan:
 *                           type: boolean
 *                           description: no cached scan answers for these options
 *                         extra:
 *                           type: object
 *                           properties:
 *                             sweepRequests:
 *                               type: integer
 *                             excerptReads:
 *                               type: integer
 *       400:
 *         description: Unknown kind, or a threshold outside [0, 1]
 *       401:
 *         description: Not authenticated
 *       503:
 *         description: |
 *           The AI review is switched off (DUPLICATES_AI_REVIEW), or no AI
 *           provider is configured; the message names which of the two
 *       500:
 *         description: Server error
 */
router.get(
  '/api/duplicates/ai-review/estimate',
  isAuthenticated,
  async (req, res) => {
    try {
      const kind = String(req.query.kind || duplicateMergeService.KIND_ALL);
      const knownKinds = [
        duplicateMergeService.KIND_ALL,
        ...entityNameMatcher.KIND_LIST,
      ];
      if (!knownKinds.includes(kind)) {
        return res
          .status(400)
          .json({ success: false, error: `Unknown entity kind: ${kind}` });
      }
      const rawThreshold = req.query.threshold;
      const threshold =
        rawThreshold === undefined || rawThreshold === ''
          ? entityNameMatcher.DEFAULT_THRESHOLD
          : Number(rawThreshold);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        return res.status(400).json({
          success: false,
          error: 'threshold must be a number between 0 and 1',
        });
      }

      const refusal = aiReviewRefusal();
      if (refusal) {
        return res.status(503).json({ success: false, error: refusal });
      }

      const data = await entityMatchAiService.estimateReview({
        kind,
        threshold,
        sweep: readQueryFlag(req.query.sweep, false),
        excerpts: readQueryFlag(req.query.excerpts, true),
      });
      return res.json({ success: true, data });
    } catch (error) {
      return respondDuplicatesError(
        res,
        'GET /api/duplicates/ai-review/estimate',
        error
      );
    }
  }
);

/**
 * Why the estimate may not be answered, or null when it may.
 *
 * The page hides its model-backed buttons when the feature is off, so this
 * is the belt rather than the braces — but it has to name which of the two it
 * is, because "switch it on" and "configure a provider" are different things
 * to do.
 *
 * @returns {string|null}
 */
function aiReviewRefusal() {
  // The same reading the judge uses: `Boolean('no')` is true, which is the
  // trap this spelling exists to avoid.
  const on =
    configFile.duplicatesAiReview === true ||
    String(configFile.duplicatesAiReview ?? '')
      .trim()
      .toLowerCase() === 'yes';
  if (!on) {
    return 'The AI review is switched off (DUPLICATES_AI_REVIEW)';
  }
  if (!configFile.aiProvider) {
    return 'No AI provider is configured';
  }
  return null;
}

/**
 * Reads a `0`/`1` query flag the estimate endpoint uses for its
 * switches. Absent is the default the caller names, not `false`: an estimate
 * that quietly turned the excerpts off would promise a cheaper run than the
 * one the button starts.
 *
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function readQueryFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

// ── Simplify tags: the vocabulary the Tidy up page edits ────────────────────

/** Entries one dimension of the vocabulary may hold. */
const MAX_VOCABULARY_ENTRIES = 200;

/** A vocabulary name is a name; Paperless-ngx stops well before this. */
const MAX_VOCABULARY_NAME_LENGTH = 128;

/** The route's own 400, worded like the ones of the Duplicates block. */
function simplifyBadRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * Reads one dimension of a TagVocabularyRequest: a list of names, trimmed,
 * blanks dropped. Anything that is not a list of short strings is the route's
 * own 400 rather than something the service has to guess about.
 *
 * @param {unknown} value
 * @param {string} field  the name the refusal quotes
 * @returns {string[]}
 */
function readVocabularyNames(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw simplifyBadRequest(`${field} must be an array of names`);
  }
  if (value.length > MAX_VOCABULARY_ENTRIES) {
    throw simplifyBadRequest(
      `${field} must not hold more than ${MAX_VOCABULARY_ENTRIES} names`
    );
  }
  const names = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw simplifyBadRequest(`every entry of ${field} must be a string`);
    }
    const name = entry.trim();
    if (name.length > MAX_VOCABULARY_NAME_LENGTH) {
      throw simplifyBadRequest(
        `every name of ${field} must be at most ${MAX_VOCABULARY_NAME_LENGTH} characters`
      );
    }
    if (name !== '') names.push(name);
  }
  return names;
}

/**
 * @swagger
 * /simplify:
 *   get:
 *     summary: Former Simplify tags page, now part of Tidy up
 *     description: |
 *       The Simplify tags page was replaced by Tidy up (`/tidy-up`), where
 *       splitting compound tags is one option of a run; this path redirects
 *       there permanently.
 *     tags:
 *       - Navigation
 *       - Simplify
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       301:
 *         description: Moved permanently to /tidy-up
 *       401:
 *         description: Not authenticated
 */
router.get('/simplify', protectApiRoute, (req, res) =>
  res.redirect(301, '/tidy-up')
);

/**
 * @swagger
 * /api/simplify/vocabulary:
 *   get:
 *     summary: The target vocabulary of document types and topic tags
 *     description: |
 *       The couple of dozen concepts the archive should end up with, in the
 *       order the user put them in. Local only: these are names, not objects
 *       in Paperless-ngx — an entry gets its `paperlessId` when a split first
 *       needs the object.
 *     tags:
 *       - Simplify
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: The stored vocabulary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/TagVocabulary'
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 *   put:
 *     summary: Replace the target vocabulary
 *     description: |
 *       Stores the vocabulary as the user edited it: names only, the order
 *       kept, blanks and repeats dropped. The ids a name already has in
 *       Paperless-ngx survive the save. A list that is not a list of at most
 *       200 names of at most 128 characters each is refused with 400.
 *     tags:
 *       - Simplify
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TagVocabularyRequest'
 *     responses:
 *       200:
 *         description: What was stored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/TagVocabulary'
 *                 message:
 *                   type: string
 *       400:
 *         description: A list is too long, or holds something that is not a name
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get('/api/simplify/vocabulary', isAuthenticated, async (req, res) => {
  try {
    const data = await tagSimplifyService.getVocabulary();
    return res.json({ success: true, data });
  } catch (error) {
    return respondDuplicatesError(res, 'GET /api/simplify/vocabulary', error);
  }
});

router.put('/api/simplify/vocabulary', isAuthenticated, async (req, res) => {
  try {
    const body = req.body || {};
    const types = readVocabularyNames(body.types, 'types');
    const topics = readVocabularyNames(body.topics, 'topics');
    const data = await tagSimplifyService.saveVocabulary({ types, topics });
    return res.json({
      success: true,
      data,
      message: `Vocabulary saved: ${data.types.length} document type(s), ${data.topics.length} topic(s).`,
    });
  } catch (error) {
    return respondDuplicatesError(res, 'PUT /api/simplify/vocabulary', error);
  }
});

/**
 * @swagger
 * /api/simplify/document-types:
 *   get:
 *     summary: The document types Paperless-ngx already has
 *     description: |
 *       What the "Document type" field of the vocabulary offers. Read-only and
 *       cached: the list is refreshed when it is empty, when it is older than
 *       TAG_CACHE_TTL_SECONDS or when `fresh` asks for it, and every write
 *       that creates or deletes a document type empties it, so a type a split
 *       just created is listed at once.
 *
 *       `inVocabulary` says which of them the saved vocabulary already holds;
 *       the page marks those rows and does not add them a second time.
 *     tags:
 *       - Simplify
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: fresh
 *         required: false
 *         description: 1, true or yes reads past the cache
 *         schema:
 *           type: string
 *           example: '1'
 *     responses:
 *       200:
 *         description: The document types, sorted by name
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
 *                     types:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TagVocabularyDocumentType'
 *                     total:
 *                       type: integer
 *                       example: 8
 *                     cachedAt:
 *                       type: string
 *                       nullable: true
 *                       format: date-time
 *                       description: When the cached list was built; null while nothing was read yet
 *       401:
 *         description: Not authenticated
 *       502:
 *         description: Paperless-ngx could not be reached
 */
router.get(
  '/api/simplify/document-types',
  isAuthenticated,
  async (req, res) => {
    try {
      const fresh = ['1', 'true', 'yes'].includes(
        String(req.query.fresh ?? '').toLowerCase()
      );
      const records = await paperlessService.listDocumentTypesCached({ fresh });
      const vocabulary = await tagSimplifyService.getVocabulary();
      // Names are case sensitive in Paperless-ngx, so "Rechnung" and
      // "rechnung" are two types and only one of them is in the vocabulary.
      const known = new Set(vocabulary.types.map((row) => String(row.name)));
      const types = records
        .map((record) => ({
          id: Number(record.id),
          name: String(record.name ?? ''),
          documentCount: Number(record.documentCount) || 0,
          inVocabulary: known.has(String(record.name ?? '')),
        }))
        .sort((a, b) => {
          const byName = a.name.localeCompare(b.name, undefined, {
            sensitivity: 'base',
          });
          // Two names that differ only in case compare equal; the id then
          // decides, so the same instance always answers in the same order.
          return byName !== 0 ? byName : a.id - b.id;
        });
      const filledAt = paperlessService.documentTypeCacheFilledAt();
      return res.json({
        success: true,
        data: {
          types,
          total: types.length,
          cachedAt: filledAt ? new Date(filledAt).toISOString() : null,
        },
      });
    } catch (error) {
      // paperlessService throws what axios threw, which carries no status of
      // its own; the page must be able to tell "unreachable" from "broken".
      const failure = Number.isInteger(error?.status)
        ? error
        : Object.assign(
            new Error(
              `Paperless-ngx could not be reached while listing the document types: ${
                error?.message || 'unknown error'
              }`
            ),
            { status: 502 }
          );
      return respondDuplicatesError(
        res,
        'GET /api/simplify/document-types',
        failure
      );
    }
  }
);

/**
 * @swagger
 * /api/update-check:
 *   get:
 *     summary: Report whether a newer release is available
 *     description: |
 *       Compares the running version against the latest GitHub release tag.
 *
 *       The lookup happens on the server and its result is cached for 24 hours,
 *       so browsers never contact GitHub themselves and a busy instance makes at
 *       most one outbound request per day. Set `UPDATE_CHECK_ENABLED=no` to turn
 *       the outbound call off; the endpoint then reports `enabled: false`.
 *     tags:
 *       - System
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Update status
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
 *                     enabled:
 *                       type: boolean
 *                     currentVersion:
 *                       type: string
 *                     latestVersion:
 *                       type: string
 *                       nullable: true
 *                     updateAvailable:
 *                       type: boolean
 *                     checkedAt:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *       401:
 *         description: Not authenticated
 */
router.get('/api/update-check', isAuthenticated, async (req, res) => {
  try {
    const status = await updateCheckService.getStatus();
    // The upstream error message is for the server log, not for the browser.
    const data = { ...status };
    delete data.error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('[ERROR] GET /api/update-check:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to check for updates' });
  }
});

/**
 * @swagger
 * /api/changelog/status:
 *   get:
 *     summary: Check whether the What's New modal should be shown
 *     description: Returns show=true when the authenticated user has not yet seen the current release changelog.
 *     tags:
 *       - Changelog
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Changelog status
 *       401:
 *         description: Not authenticated
 */
router.get('/api/changelog/status', isAuthenticated, async (req, res) => {
  try {
    if (req.user && req.user.apiKey) {
      return res.json({ show: false });
    }

    const username = req.user && req.user.username;
    if (!username) {
      return res.json({ show: false });
    }

    const lastSeen = await documentModel.getLastSeenChangelogVersion(username);
    const show = lastSeen !== changelog.version;

    return res.json({
      show,
      version: changelog.version,
      entries: show ? changelog.entries : [],
    });
  } catch (error) {
    console.error('[ERROR] GET /api/changelog/status:', error);
    return res
      .status(500)
      .json({ show: false, error: 'Failed to load changelog status' });
  }
});

/**
 * @swagger
 * /api/changelog/mark-seen:
 *   post:
 *     summary: Mark the current changelog as seen for the authenticated user
 *     tags:
 *       - Changelog
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Marked as seen
 *       401:
 *         description: Not authenticated
 */
router.post('/api/changelog/mark-seen', isAuthenticated, async (req, res) => {
  try {
    if (req.user && req.user.apiKey) {
      return res.json({ success: true });
    }

    const changelog = require('../config/changelog');
    const username = req.user && req.user.username;
    if (!username) {
      return res.json({ success: true });
    }

    await documentModel.setLastSeenChangelogVersion(
      username,
      changelog.version
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('[ERROR] POST /api/changelog/mark-seen:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to mark changelog as seen' });
  }
});

module.exports = router;
