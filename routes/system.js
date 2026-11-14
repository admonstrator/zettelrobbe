'use strict';

/**
 * System information: health, the about page, the update check and the
 * changelog.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   GET   /health                    System health check endpoint
 *   GET   /about                     Permanently ignored documents page
 *   GET   /api/update-check          Report whether a newer release is available
 *   GET   /api/changelog/status      Check whether the What's New modal should be shown
 *   POST  /api/changelog/mark-seen   Mark the current changelog as seen for the authenticated user
 */

const express = require('express');
const documentModel = require('../models/document.js');
const configFile = require('../config/config.js');
const changelog = require('../config/changelog.js');
const { isAuthenticated } = require('./auth.js');
const {
  protectApiRoute,
  isAuthenticatedCaller,
} = require('../middleware/authGate');
const scanHealthService = require('../services/scanHealthService');
const updateCheckService = require('../services/updateCheckService');
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
