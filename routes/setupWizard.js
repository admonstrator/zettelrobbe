'use strict';

/**
 * The first-run setup wizard and its API. remoteSetupGuard in routes/index.js
 * keeps these paths to local callers while setup is open.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   GET   /setup                          Application setup page
 *   GET   /api/setup/presets              Get AI provider presets for initial setup
 *   POST  /api/setup/mfa/setup            Start setup MFA provisioning
 *   POST  /api/setup/mfa/confirm          Confirm setup MFA code
 *   POST  /api/setup/paperless/test       Test Paperless-ngx connectivity and permissions during setup
 *   POST  /api/setup/paperless/metadata   Fetch Paperless-ngx counts and tags for setup wizard
 *   POST  /api/setup/ai/test              Test AI provider credentials during setup
 *   POST  /api/setup/ai/models            Discover available AI models during setup
 *   POST  /api/setup/ocr/test             Test OCR provider connectivity during setup
 *   POST  /api/setup/ocr/models           Discover available OCR models during setup
 *   POST  /api/setup/quickstart/detect    Auto-detect API flavor and classify models from a single base URL during setup
 *   POST  /api/setup/complete             Finalize initial setup, persist env config, and trigger restart
 */

const express = require('express');
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const configFile = require('../config/config.js');
const settingsService = require('../services/settingsService');
const crypto = require('crypto');
const {
  validateApiUrl,
  stripTrailingSlashes,
} = require('../services/serviceUtils');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { hasValidSession } = require('../middleware/authGate');
const { clearSessionCookie } = require('../services/sessionCookie');
const {
  MFA_CHALLENGE_COOKIE,
  MFA_SETUP_COOKIE,
  SETUP_MFA_CHALLENGE_TTL_MS,
  setupMfaChallenges,
  cleanupExpiredSetupMfaChallenges,
  generateBase32Secret,
  buildOtpAuthUri,
  verifyTotpToken,
} = require('../services/mfaService');
const { hasAnyUser, isInitialSetupOpen } = require('../services/userPresence');
const restartService = require('../services/restartService');
const {
  sanitizeConfigForBootstrap,
} = require('../services/bootstrapConfigSanitizer');
const {
  resolveOcrApiKeyForProvider,
  validateAiConnectionForSetup,
  validateOcrConnectionForSetup,
  discoverAiModelsForSetup,
  discoverOcrModelsForSetup,
  detectQuickstartForSetup,
} = require('../services/connectionChecks');
const {
  getAnthropicFormOptions,
  loadAiProviderPresets,
} = require('../services/aiFormOptions');
const router = express.Router();

function normalizeSetupBaseUrl(url) {
  return stripTrailingSlashes(String(url || '').trim()).replace(/\/api$/, '');
}

function parseBooleanInput(value, defaultValue = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return defaultValue;
}

function getSetupUrlValidationOptions() {
  return {
    allowPrivateIPs: true,
    allowLocalhost: parseBooleanInput(
      process.env.PAPERLESS_AI_SETUP_ALLOW_LOCALHOST,
      false
    ),
  };
}

function normalizeTagListInput(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getDefaultScanInterval() {
  return process.env.SCAN_INTERVAL || '*/30 * * * *';
}

async function ensureSetupOpenOrRespond(
  res,
  error = 'Initial setup is already complete.'
) {
  const setupOpen = await isInitialSetupOpen();
  if (!setupOpen) {
    res.status(403).json({
      success: false,
      error,
    });
    return false;
  }

  return true;
}

function toEnvPreviewLines(config) {
  const previewKeys = [
    'PAPERLESS_API_URL',
    'PAPERLESS_API_TOKEN',
    'PAPERLESS_USERNAME',
    'PROCESS_PREDEFINED_DOCUMENTS',
    'TAGS',
    'IGNORE_TAGS',
    'ADD_AI_PROCESSED_TAG',
    'AI_PROCESSED_TAG_NAME',
    'REMOVE_INBOX_TAGS_AFTER_PROCESSING',
    'DISABLE_AUTOMATIC_PROCESSING',
    'SCAN_INTERVAL',
    'AI_PROVIDER',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OLLAMA_API_URL',
    'OLLAMA_API_KEY',
    'OLLAMA_MODEL',
    'CUSTOM_BASE_URL',
    'CUSTOM_API_KEY',
    'CUSTOM_MODEL',
    'AZURE_ENDPOINT',
    'AZURE_API_KEY',
    'AZURE_DEPLOYMENT_NAME',
    'AZURE_API_VERSION',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_API_URL',
    'ANTHROPIC_MODEL',
    'MISTRAL_OCR_ENABLED',
    'OCR_PROVIDER',
    'OCR_API_URL',
    'OCR_API_KEY',
    'MISTRAL_API_KEY',
    'MISTRAL_OCR_MODEL',
    'OCR_PDF_RENDER_ENABLED',
    'OCR_PDF_RENDER_MAX_PAGES',
    'OCR_PDF_RENDER_DPI',
    'OCR_AUTO_PROCESS_ENABLED',
    'OCR_AUTO_PROCESS_INTERVAL',
    'OCR_AUTO_PROCESS_BATCH_SIZE',
    'OCR_AUTO_ANALYZE',
  ];

  return previewKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(config, key))
    .map((key) => `${key}=${config[key] == null ? '' : config[key]}`)
    .join('\n');
}

async function validatePaperlessConnectionForSetup(
  paperlessUrl,
  paperlessToken
) {
  const normalizedUrl = normalizeSetupBaseUrl(paperlessUrl);
  if (!normalizedUrl || !paperlessToken) {
    return {
      success: false,
      stage: 'input',
      message: 'Paperless API URL and API token are required.',
    };
  }

  const isReachable = await setupService.validatePaperlessConfig(
    normalizedUrl,
    paperlessToken
  );
  if (!isReachable) {
    return {
      success: false,
      stage: 'reachability',
      message:
        'Paperless-ngx could not be reached with the provided URL and token.',
    };
  }

  const permissionResult = await setupService.validateApiPermissions(
    normalizedUrl,
    paperlessToken
  );
  if (!permissionResult.success) {
    return {
      success: false,
      stage: 'permissions',
      message:
        permissionResult.message ||
        'Paperless-ngx API permissions are insufficient.',
    };
  }

  return {
    success: true,
    stage: 'ok',
    message: 'Paperless-ngx connection and permissions are valid.',
  };
}

/**
 * @swagger
 * /setup:
 *   get:
 *     summary: Application setup page
 *     description: |
 *       Renders the application setup page for initial configuration.
 *
 *       This page allows configuring the connection to Paperless-ngx, AI services,
 *       and other application settings. It loads existing configuration if available
 *       and redirects to dashboard if setup is already complete.
 *
 *       The setup page is the entry point for new installations and guides users through
 *       the process of connecting to Paperless-ngx, configuring AI providers, and setting up
 *       admin credentials.
 *     tags:
 *       - Navigation
 *       - Setup
 *       - System
 *     responses:
 *       200:
 *         description: Setup page rendered successfully (only while no administrator account exists)
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the application setup page
 *       302:
 *         description: >
 *           Redirects away from the wizard once an administrator account
 *           exists - to /settings for a signed-in request, otherwise to /login.
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
router.get('/setup', async (req, res) => {
  try {
    // SECURITY: the wizard creates the administrator account and rewrites the
    // Paperless-ngx connection without asking for credentials, so it must never
    // be reachable once an account exists — not even with a broken
    // configuration. A signed-in operator gets the settings page, everyone else
    // gets the login form.
    if (await hasAnyUser()) {
      return res.redirect(hasValidSession(req) ? '/settings' : '/login');
    }

    // SECURITY: Check setup state first to detect degraded conditions
    const setupState = await setupService.getSetupState();

    // If system is in degraded state (config exists but database corrupted),
    // refuse to render setup page with embedded config
    if (setupState === 'degraded') {
      console.warn(
        '[SECURITY] Attempting to access /setup in degraded state (corrupted database)'
      );
      return res
        .status(500)
        .render('setup-error', {
          title: 'System Configuration Error',
          errorMessage:
            'The system configuration exists but the database is inaccessible or corrupted. This is an administrative error state. Please check system logs and database integrity.',
          supportText:
            'This may occur if: (1) the database file was deleted or corrupted, (2) file permissions changed, or (3) the database is locked. Restart the application after verifying database and permissions.',
        })
        .catch(() => {
          // Fallback if setup-error template doesn't exist
          res
            .status(500)
            .send(
              '<h1>System Configuration Error</h1><p>Database is inaccessible. Please contact your administrator.</p>'
            );
        });
    }

    // Check both configuration and users
    const [isEnvConfigured, users] = await Promise.all([
      setupService.isConfigured(),
      documentModel.getUsers(),
    ]);
    const aiProviderPresets = await loadAiProviderPresets();

    // The wizard's settings with their defaults, and the saved configuration
    // on top when there is one.
    const config = settingsService.pageConfig(
      'wizard',
      process.env,
      isEnvConfigured ? await setupService.loadConfig() : null,
      configFile.PAPERLESS_AI_VERSION
    );

    // Debug output
    console.log('Current config TAGS:', config.TAGS);
    console.log('Current config IGNORE_TAGS:', config.IGNORE_TAGS);
    console.log('Current config PROMPT_TAGS:', config.PROMPT_TAGS);

    // Check if system is fully configured
    const hasUsers = Array.isArray(users) && users.length > 0;
    const isFullyConfigured = isEnvConfigured && hasUsers;

    // Generate appropriate success message
    let successMessage;
    if (isEnvConfigured && !hasUsers) {
      successMessage =
        'Environment is configured, but no users exist. Please create at least one user.';
    } else if (isEnvConfigured) {
      successMessage =
        'The application is already configured. You can update the configuration below.';
    }

    // If everything is configured and we have users, redirect to dashboard
    // BUT only after we've loaded all the config
    if (isFullyConfigured) {
      return res.redirect('/dashboard');
    }

    // SECURITY: Sanitize config before passing to template (remove secrets from bootstrap)
    const sanitizedConfig = sanitizeConfigForBootstrap(config);

    // Render setup page with sanitized config and appropriate message
    res.render('setup', {
      config: sanitizedConfig,
      success: successMessage,
      aiProviderPresets,
      anthropicOptions: getAnthropicFormOptions(),
      defaults: {
        scanInterval: getDefaultScanInterval(),
      },
    });
  } catch (error) {
    console.error('Setup route error:', error);
    const aiProviderPresets = await loadAiProviderPresets();
    res.status(500).render('setup', {
      config: {},
      error: 'An error occurred while loading the setup page.',
      aiProviderPresets,
      anthropicOptions: getAnthropicFormOptions(),
      defaults: {
        scanInterval: getDefaultScanInterval(),
      },
    });
  }
});

/**
 * @swagger
 * /api/setup/presets:
 *   get:
 *     summary: Get AI provider presets for initial setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: Preset list loaded successfully
 */
router.get('/api/setup/presets', async (_req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const presets = await loadAiProviderPresets();
    return res.json({
      success: true,
      presets,
    });
  } catch (error) {
    console.error('[ERROR] GET /api/setup/presets:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not load AI provider presets.',
    });
  }
});

/**
 * @swagger
 * /api/setup/mfa/setup:
 *   post:
 *     summary: Start setup MFA provisioning
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: MFA provisioning data generated
 */
router.post('/api/setup/mfa/setup', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    cleanupExpiredSetupMfaChallenges();

    const username = String(req.body?.username || '').trim();
    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Username is required for MFA setup.',
      });
    }

    const secret = generateBase32Secret();
    const otpauthUri = buildOtpAuthUri(secret, username);
    const qrDataUrl = await QRCode.toDataURL(otpauthUri, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: { dark: '#0f172a', light: '#ffffff' },
    });

    const challengeId = crypto.randomBytes(24).toString('hex');
    setupMfaChallenges.set(challengeId, {
      username,
      secret,
      verified: false,
      createdAt: Date.now(),
    });

    return res.json({
      success: true,
      challengeId,
      secret,
      otpauthUri,
      qrDataUrl,
      expiresInSeconds: Math.floor(SETUP_MFA_CHALLENGE_TTL_MS / 1000),
    });
  } catch (error) {
    console.error('[ERROR] POST /api/setup/mfa/setup:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to initialize MFA setup.',
    });
  }
});

/**
 * @swagger
 * /api/setup/mfa/confirm:
 *   post:
 *     summary: Confirm setup MFA code
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: MFA code validated
 */
router.post('/api/setup/mfa/confirm', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    cleanupExpiredSetupMfaChallenges();

    const challengeId = String(req.body?.challengeId || '').trim();
    const token = String(req.body?.token || '').trim();

    if (!challengeId || !token) {
      return res.status(400).json({
        success: false,
        error: 'Challenge ID and authentication code are required.',
      });
    }

    const challenge = setupMfaChallenges.get(challengeId);
    if (!challenge) {
      return res.status(400).json({
        success: false,
        error: 'MFA setup session expired. Start setup again.',
      });
    }

    if (!verifyTotpToken(challenge.secret, token)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid authentication code. Please try again.',
      });
    }

    challenge.verified = true;
    challenge.verifiedAt = Date.now();

    return res.json({
      success: true,
      message: 'MFA code validated.',
    });
  } catch (error) {
    console.error('[ERROR] POST /api/setup/mfa/confirm:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to validate MFA code.',
    });
  }
});

/**
 * @swagger
 * /api/setup/paperless/test:
 *   post:
 *     summary: Test Paperless-ngx connectivity and permissions during setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: Connectivity result returned
 */
router.post('/api/setup/paperless/test', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const paperlessUrl = String(req.body?.paperlessUrl || '').trim();
    const paperlessToken = String(req.body?.paperlessToken || '').trim();
    const validation = await validatePaperlessConnectionForSetup(
      paperlessUrl,
      paperlessToken
    );

    return res.json(validation);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/paperless/test:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not test Paperless-ngx connection.',
    });
  }
});

/**
 * @swagger
 * /api/setup/paperless/metadata:
 *   post:
 *     summary: Fetch Paperless-ngx counts and tags for setup wizard
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: Metadata loaded successfully
 */
router.post(
  '/api/setup/paperless/metadata',
  express.json(),
  async (req, res) => {
    try {
      if (!(await ensureSetupOpenOrRespond(res))) {
        return;
      }

      const paperlessUrl = String(req.body?.paperlessUrl || '').trim();
      const paperlessToken = String(req.body?.paperlessToken || '').trim();
      const normalizedUrl = normalizeSetupBaseUrl(paperlessUrl);

      if (!normalizedUrl || !paperlessToken) {
        return res.status(400).json({
          success: false,
          error: 'Paperless API URL and API token are required.',
        });
      }

      const urlValidation = await validateApiUrl(
        normalizedUrl,
        getSetupUrlValidationOptions()
      );
      if (!urlValidation.valid) {
        return res.status(400).json({
          success: false,
          error: `Invalid Paperless API URL: ${urlValidation.error}`,
        });
      }

      const initialized = await paperlessService.initializeWithCredentials(
        normalizedUrl,
        paperlessToken
      );
      if (!initialized) {
        return res.status(400).json({
          success: false,
          error: 'Failed to initialize Paperless-ngx client.',
        });
      }

      const [documentCount, correspondentCount, tagCount, tags] =
        await Promise.all([
          paperlessService.getDocumentCount(),
          paperlessService.getCorrespondentCount(),
          paperlessService.getTagCount(),
          paperlessService.getTags(),
        ]);

      const tagNames = Array.from(
        new Set(
          (Array.isArray(tags) ? tags : [])
            .map((tag) => String(tag?.name || '').trim())
            .filter(Boolean)
        )
      ).sort((a, b) => a.localeCompare(b));

      return res.json({
        success: true,
        metadata: {
          documents: Number(documentCount || 0),
          correspondents: Number(correspondentCount || 0),
          tags: Number(tagCount || 0),
        },
        tagNames,
      });
    } catch (error) {
      console.error('[ERROR] POST /api/setup/paperless/metadata:', error);
      return res.status(500).json({
        success: false,
        error: 'Could not load Paperless metadata.',
      });
    }
  }
);

/**
 * @swagger
 * /api/setup/ai/test:
 *   post:
 *     summary: Test AI provider credentials during setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: AI connectivity result returned
 */
router.post('/api/setup/ai/test', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const validation = await validateAiConnectionForSetup({
      aiProvider: req.body?.aiProvider,
      apiUrl: req.body?.apiUrl,
      token: req.body?.token,
      model: req.body?.model,
      azureApiVersion: req.body?.azureApiVersion,
      setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
    });

    return res.json(validation);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ai/test:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not test AI connection.',
    });
  }
});

/**
 * @swagger
 * /api/setup/ai/models:
 *   post:
 *     summary: Discover available AI models during setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: AI model list returned
 */
router.post('/api/setup/ai/models', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const result = await discoverAiModelsForSetup({
      aiProvider: req.body?.aiProvider,
      apiUrl: req.body?.apiUrl,
      token: req.body?.token,
      setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
    });

    return res.json(result);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ai/models:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Could not discover AI models.',
    });
  }
});

/**
 * @swagger
 * /api/setup/ocr/test:
 *   post:
 *     summary: Test OCR provider connectivity during setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: OCR connectivity result returned
 */
router.post('/api/setup/ocr/test', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const validation = await validateOcrConnectionForSetup({
      enabled: req.body?.enabled,
      provider: req.body?.provider,
      apiUrl: req.body?.apiUrl,
      apiKey: req.body?.apiKey,
      model: req.body?.model,
      // The OCR helpers take setupOcrValidationTimeoutMs, which is also what
      // the wizard sends; passing it under the AI key dropped the configured
      // OCR timeout on the floor and fell back to the global default.
      setupOcrValidationTimeoutMs:
        req.body?.setupOcrValidationTimeoutMs ??
        req.body?.setupValidationTimeoutMs,
      anthropicApiKey: req.body?.anthropicApiKey,
      anthropicApiUrl: req.body?.anthropicApiUrl,
      anthropicModel: req.body?.anthropicModel,
    });

    return res.json(validation);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ocr/test:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not test OCR connection.',
    });
  }
});

/**
 * @swagger
 * /api/setup/ocr/models:
 *   post:
 *     summary: Discover available OCR models during setup
 *     description: |
 *       Returns every discovered model that is not embedding-only. Vision
 *       support is detected from the model name, which recognizes families
 *       such as llava or pixtral and misses OCR-capable models with
 *       unremarkable names, so it ranks the list instead of filtering it:
 *       `visionModels` and `suggestedModel` are hints for the UI, not a
 *       restriction on what may be selected.
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: OCR model list returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 models:
 *                   type: array
 *                   description: Every selectable OCR model (embedding-only models excluded)
 *                   items:
 *                     type: string
 *                 visionModels:
 *                   type: array
 *                   description: Subset of models whose name indicates vision support; absent for providers without model classification
 *                   items:
 *                     type: string
 *                 suggestedModel:
 *                   type: string
 *                   nullable: true
 *                   description: Recommended default; absent for providers without model classification
 *                 live:
 *                   type: boolean
 *                   description: anthropic only — false when the live list failed and the suggested Claude models are returned instead
 *                 resolvedApiUrl:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Model discovery failed
 */
router.post('/api/setup/ocr/models', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const result = await discoverOcrModelsForSetup({
      provider: req.body?.provider,
      apiUrl: req.body?.apiUrl,
      // The wizard used to take the field at face value, so an operator whose
      // key already sat in the environment was told to supply one.
      apiKey: resolveOcrApiKeyForProvider(
        req.body?.provider,
        req.body?.apiKey,
        req.body?.apiUrl || req.body?.anthropicApiUrl
      ),
      anthropicApiKey: req.body?.anthropicApiKey,
      anthropicApiUrl: req.body?.anthropicApiUrl,
      anthropicModel: req.body?.anthropicModel,
      // Same key mismatch as in /api/setup/ocr/test above: the discovery
      // helper takes setupOcrValidationTimeoutMs. It matters here because
      // classifying an Ollama catalogue costs one /api/show per model and
      // runs against a deadline derived from this timeout.
      setupOcrValidationTimeoutMs:
        req.body?.setupOcrValidationTimeoutMs ??
        req.body?.setupValidationTimeoutMs,
    });

    return res.json(result);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ocr/models:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Could not discover OCR models.',
    });
  }
});

/**
 * @swagger
 * /api/setup/quickstart/detect:
 *   post:
 *     summary: Auto-detect API flavor and classify models from a single base URL during setup
 *     tags:
 *       - Setup
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - baseUrl
 *             properties:
 *               baseUrl:
 *                 type: string
 *                 example: http://192.168.1.5:1234
 *               apiKey:
 *                 type: string
 *               setupValidationTimeoutMs:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Detection result with classified models and suggestions
 *       400:
 *         description: Detection failed (unreachable URL, blocked URL, or no compatible API)
 */
router.post(
  '/api/setup/quickstart/detect',
  express.json(),
  async (req, res) => {
    try {
      if (!(await ensureSetupOpenOrRespond(res))) {
        return;
      }

      const result = await detectQuickstartForSetup({
        baseUrl: req.body?.baseUrl,
        apiKey: req.body?.apiKey,
        setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
      });

      return res.json(result);
    } catch (error) {
      console.error('[ERROR] POST /api/setup/quickstart/detect:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Quickstart detection failed.',
      });
    }
  }
);

/**
 * @swagger
 * /api/setup/complete:
 *   post:
 *     summary: Finalize initial setup, persist env config, and trigger restart
 *     description: >
 *       Validates the Paperless, AI and OCR connections before writing the
 *       configuration. The boolean body flags paperlessTestPassed, aiTestPassed
 *       and ocrTestPassed let a caller that has just verified a connection with
 *       these exact values skip the matching probe; anything not flagged is
 *       validated here. allowFailedPaperlessTest and allowFailedAiTest still
 *       accept a connection whose validation failed.
 *     tags:
 *       - Setup
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *             description: >
 *               The wizard's answers (administrator, Paperless-ngx connection,
 *               document scope, AI and OCR settings). Only the fields below are
 *               described individually.
 *             properties:
 *               processedTag:
 *                 type: string
 *                 description: >
 *                   Tag added after a document was analysed; empty turns the
 *                   tag off. It is also added to the excluded tags.
 *               removeInboxTagsAfterProcessing:
 *                 type: boolean
 *                 default: false
 *                 description: >
 *                   Take every Paperless-ngx inbox tag off a document once its
 *                   analysis was written. Saved as
 *                   REMOVE_INBOX_TAGS_AFTER_PROCESSING; an absent value saves
 *                   "no".
 *     responses:
 *       200:
 *         description: Setup completed successfully
 *       403:
 *         description: >
 *           An administrator account already exists. The wizard is closed for
 *           good on this instance; nothing is validated, written or replaced.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/api/setup/complete', express.json(), async (req, res) => {
  try {
    // Before any validation and long before saveConfig()/addUser(): completing
    // setup a second time would delete the existing administrator and repoint
    // the Paperless-ngx connection, unauthenticated.
    if (
      !(await ensureSetupOpenOrRespond(
        res,
        'An administrator account already exists. Sign in and use /settings instead.'
      ))
    ) {
      return;
    }

    cleanupExpiredSetupMfaChallenges();

    const adminUsername = String(req.body?.adminUsername || '').trim();
    const adminPassword = String(req.body?.adminPassword || '');
    const enableMfa = parseBooleanInput(req.body?.enableMfa, false);
    const mfaChallengeId = String(req.body?.mfaChallengeId || '').trim();

    const paperlessUrl = normalizeSetupBaseUrl(req.body?.paperlessUrl);
    const paperlessUsername = String(req.body?.paperlessUsername || '').trim();
    const paperlessToken = String(req.body?.paperlessToken || '').trim();

    const scanAllDocuments = parseBooleanInput(
      req.body?.scanAllDocuments,
      false
    );
    const includeTags = normalizeTagListInput(req.body?.includeTags);
    const includeTag = String(req.body?.includeTag || '').trim();
    const effectiveIncludeTags = Array.from(
      new Set([...includeTags, ...(includeTag ? [includeTag] : [])])
    );
    const excludeTags = normalizeTagListInput(req.body?.excludeTags);
    const processedTag = String(req.body?.processedTag || '').trim();
    const effectiveExcludeTags = Array.from(
      new Set([...excludeTags, ...(processedTag ? [processedTag] : [])])
    );
    // Absent in requests from older clients: those keep the inbox tags.
    const removeInboxTagsAfterProcessing = parseBooleanInput(
      req.body?.removeInboxTagsAfterProcessing,
      false
    );
    const automaticScanEnabled = parseBooleanInput(
      req.body?.automaticScanEnabled,
      true
    );
    const scanInterval =
      String(req.body?.scanInterval || getDefaultScanInterval()).trim() ||
      getDefaultScanInterval();

    const aiProvider = String(req.body?.aiProvider || '')
      .trim()
      .toLowerCase();
    const aiApiUrl = String(req.body?.aiApiUrl || '').trim();
    const aiToken = String(req.body?.aiToken || '').trim();
    const aiModel = String(req.body?.aiModel || '').trim();
    const aiAzureApiVersion =
      String(req.body?.aiAzureApiVersion || '2023-05-15').trim() ||
      '2023-05-15';
    const setupValidationTimeoutMs = setupService.normalizeValidationTimeoutMs(
      req.body?.setupValidationTimeoutMs,
      30000
    );
    const setupOcrValidationTimeoutMs =
      setupService.normalizeValidationTimeoutMs(
        req.body?.setupOcrValidationTimeoutMs ??
          req.body?.setupValidationTimeoutMs,
        30000
      );

    const allowFailedPaperlessTest = parseBooleanInput(
      req.body?.allowFailedPaperlessTest,
      false
    );
    const allowFailedAiTest = parseBooleanInput(
      req.body?.allowFailedAiTest,
      false
    );

    // The wizard reports which connections it already proved reachable with
    // exactly the values being submitted (it drops the flag as soon as one of
    // them is edited). Honouring that spares the user a second wait — and a
    // second billed AI call — for probes they just watched succeed. Anything
    // not reported as passing is still validated below.
    const paperlessTestPassed = parseBooleanInput(
      req.body?.paperlessTestPassed,
      false
    );
    const aiTestPassed = parseBooleanInput(req.body?.aiTestPassed, false);
    const ocrTestPassed = parseBooleanInput(req.body?.ocrTestPassed, false);
    const alreadyVerified = { success: true, message: 'Verified by setup.' };

    const mistralOcrEnabled = parseBooleanInput(
      req.body?.mistralOcrEnabled,
      false
    );
    const ocrProvider = String(req.body?.ocrProvider || 'mistral')
      .trim()
      .toLowerCase();
    const ocrApiUrlRaw = String(req.body?.ocrApiUrl || '').trim();
    // Mistral OCR has no URL field. For Claude OCR the field is an optional
    // proxy URL: empty falls back to the Anthropic AI provider's URL, and
    // that to api.anthropic.com. The wizard empties the field when Claude is
    // picked, so a value here was typed for it.
    const ocrApiUrl = ocrProvider === 'mistral' ? '' : ocrApiUrlRaw;
    const ocrApiKey = String(
      req.body?.ocrApiKey || req.body?.mistralApiKey || ''
    ).trim();
    const anthropicAiSelected = aiProvider === 'anthropic';
    const mistralOcrModel =
      ocrProvider === 'anthropic'
        ? setupService.resolveAnthropicOcrModel(
            req.body?.mistralOcrModel,
            anthropicAiSelected ? aiModel : ''
          )
        : String(req.body?.mistralOcrModel || 'mistral-ocr-latest').trim() ||
          'mistral-ocr-latest';

    if (!['mistral', 'custom', 'ollama', 'anthropic'].includes(ocrProvider)) {
      return res.status(400).json({
        success: false,
        error: 'A valid OCR provider is required.',
      });
    }

    if (mistralOcrEnabled && ocrProvider === 'mistral' && !ocrApiKey) {
      return res.status(400).json({
        success: false,
        error:
          'Mistral API key is required when OCR provider is set to mistral.',
      });
    }

    if (
      mistralOcrEnabled &&
      ocrProvider === 'anthropic' &&
      !ocrApiKey &&
      !(anthropicAiSelected && aiToken) &&
      !process.env.ANTHROPIC_API_KEY
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Claude OCR needs an Anthropic API key: enter one for OCR, or choose Anthropic as the AI provider.',
      });
    }

    if (!adminUsername || !adminPassword) {
      return res.status(400).json({
        success: false,
        error: 'Admin username and password are required.',
      });
    }

    if (adminPassword.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters long.',
      });
    }

    if (!paperlessUrl || !paperlessUsername || !paperlessToken) {
      return res.status(400).json({
        success: false,
        error: 'Paperless URL, username, and token are required.',
      });
    }

    if (!scanAllDocuments && effectiveIncludeTags.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          'Select at least one tag for scanned documents or enable scanning all documents.',
      });
    }

    if (
      !aiProvider ||
      !['openai', 'ollama', 'custom', 'azure', 'anthropic'].includes(aiProvider)
    ) {
      return res.status(400).json({
        success: false,
        error: 'A valid AI provider is required.',
      });
    }

    const paperlessValidation = paperlessTestPassed
      ? alreadyVerified
      : await validatePaperlessConnectionForSetup(paperlessUrl, paperlessToken);
    if (!paperlessValidation.success && !allowFailedPaperlessTest) {
      return res.status(400).json({
        success: false,
        error: paperlessValidation.message,
      });
    }

    const aiValidation = aiTestPassed
      ? alreadyVerified
      : await validateAiConnectionForSetup({
          aiProvider,
          apiUrl: aiApiUrl,
          token: aiToken,
          model: aiModel,
          azureApiVersion: aiAzureApiVersion,
          setupValidationTimeoutMs,
        });

    if (!aiValidation.success && !allowFailedAiTest) {
      return res.status(400).json({
        success: false,
        error: aiValidation.message,
      });
    }

    const ocrProviderForValidation =
      ocrProvider === 'custom' ? 'ollama' : ocrProvider;
    const ocrValidation = ocrTestPassed
      ? alreadyVerified
      : await validateOcrConnectionForSetup({
          enabled: mistralOcrEnabled ? 'yes' : 'no',
          provider: ocrProviderForValidation,
          apiUrl: ocrApiUrl,
          apiKey: ocrApiKey,
          model: mistralOcrModel,
          setupOcrValidationTimeoutMs,
          anthropicApiKey: anthropicAiSelected ? aiToken : '',
          anthropicApiUrl: anthropicAiSelected ? aiApiUrl : '',
          anthropicModel: anthropicAiSelected ? aiModel : '',
        });

    if (!ocrValidation.success) {
      return res.status(400).json({
        success: false,
        error: ocrValidation.message,
      });
    }

    const tagsForProcessing = scanAllDocuments ? [] : effectiveIncludeTags;
    const apiToken =
      process.env.API_KEY || crypto.randomBytes(64).toString('hex');
    const jwtToken =
      process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

    const finalConfig = settingsService.buildInitialSetupConfig({
      paperlessUrl,
      paperlessToken,
      paperlessUsername,
      aiProvider,
      aiApiUrl,
      aiToken,
      aiModel,
      aiAzureApiVersion,
      scanInterval,
      scanAllDocuments,
      tagsForProcessing,
      excludeTags: effectiveExcludeTags,
      processedTag,
      removeInboxTagsAfterProcessing,
      automaticScanEnabled,
      mistralOcrEnabled,
      ocrProvider,
      ocrApiUrl,
      ocrApiKey,
      mistralOcrModel,
      setupValidationTimeoutMs,
      setupOcrValidationTimeoutMs,
      apiKey: apiToken,
      jwtSecret: jwtToken,
    });

    let mfaSecretToPersist = null;
    if (enableMfa) {
      if (!mfaChallengeId) {
        return res.status(400).json({
          success: false,
          error: 'MFA setup is incomplete. Generate and confirm a code first.',
        });
      }

      const challenge = setupMfaChallenges.get(mfaChallengeId);
      if (!challenge || !challenge.verified) {
        return res.status(400).json({
          success: false,
          error: 'MFA setup is incomplete or expired. Please repeat MFA setup.',
        });
      }

      if (challenge.username !== adminUsername) {
        return res.status(400).json({
          success: false,
          error: 'MFA setup username does not match the admin username.',
        });
      }

      mfaSecretToPersist = challenge.secret;
    }

    await setupService.saveConfig(finalConfig, {
      skipValidation: allowFailedPaperlessTest || allowFailedAiTest,
    });

    const hashedPassword = await bcrypt.hash(adminPassword, 15);
    await documentModel.addUser(adminUsername, hashedPassword);

    if (enableMfa && mfaSecretToPersist) {
      await documentModel.setUserMfaSettings(
        adminUsername,
        true,
        mfaSecretToPersist
      );
      setupMfaChallenges.delete(mfaChallengeId);
    }

    const envPreview = toEnvPreviewLines(finalConfig);

    // Enforce a fresh login after setup completion.
    clearSessionCookie(res);
    res.clearCookie(MFA_CHALLENGE_COOKIE);
    res.clearCookie(MFA_SETUP_COOKIE);

    res.json({
      success: true,
      message: 'Initial setup completed successfully.',
      restart: true,
      redirectTo: '/login',
      envPreview,
    });

    restartService.requestRestart();
  } catch (error) {
    console.error('[ERROR] POST /api/setup/complete:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to complete setup: ' + error.message,
    });
  }
});

module.exports = router;
