const express = require('express');
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const AIServiceFactory = require('../services/aiServiceFactory');
const configFile = require('../config/config.js');
const aiProviderRules = require('../services/aiProviderRules');
const settingsService = require('../services/settingsService');
const changelog = require('../config/changelog.js');
const dashboardWidgets = require('../config/dashboardWidgets.js');
const crypto = require('crypto');
const {
  validateApiUrl,
  stripTrailingSlashes,
  toNameList,
} = require('../services/serviceUtils');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { isAuthenticated } = require('./auth.js');
const {
  protectApiRoute,
  hasValidSession,
  isAuthenticatedCaller,
  getAuthenticatedSettingsUsername,
} = require('../middleware/authGate');
const {
  MFA_CHALLENGE_COOKIE,
  MFA_SETUP_COOKIE,
  SETUP_MFA_CHALLENGE_TTL_MS,
  setupMfaChallenges,
  cleanupExpiredSetupMfaChallenges,
  generateBase32Secret,
  buildOtpAuthUri,
  verifyTotpToken,
  consumeTotpToken,
  isMfaEnabledForUser,
} = require('../services/mfaService');
const { shouldUseSecureCookies } = require('../services/sessionCookie');
const { hasAnyUser, isInitialSetupOpen } = require('../services/userPresence');
const mistralOcrService = require('../services/mistralOcrService');
const skipRuleService = require('../services/skipRuleService');
const restartService = require('../services/restartService');
const scanHealthService = require('../services/scanHealthService');
const updateCheckService = require('../services/updateCheckService');
const dashboardStatsService = require('../services/dashboardStatsService');
const duplicateMergeService = require('../services/duplicateMergeService');
const entityNameMatcher = require('../services/entityNameMatcher');
const entityMatchAiService = require('../services/entityMatchAiService');
const tagSimplifyService = require('../services/tagSimplifyService');
const oidcService = require('../services/oidcService');
const {
  sanitizeConfigForBootstrap,
} = require('../services/bootstrapConfigSanitizer');
const { isConfiguredAnthropicHost } = require('../services/anthropicSupport');
const config = require('../config/config.js');
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
const { normalizeDocumentIdList } = require('../services/documentIdList');
const {
  buildScannerHealthSnapshot,
} = require('../services/scannerHealthSnapshot');
const { BOOT_IDENTITY } = require('../services/bootIdentity');
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

// Settings pages leave secret inputs empty to mean "keep the configured
// value", so requests from there may carry an empty token even though the
// endpoint requires auth. Fall back to the stored key for the provider.
function resolveStoredAiToken(aiProvider) {
  const provider = String(aiProvider || '')
    .trim()
    .toLowerCase();
  if (provider === 'ollama') return process.env.OLLAMA_API_KEY || '';
  if (provider === 'custom') return process.env.CUSTOM_API_KEY || '';
  if (provider === 'openai') return process.env.OPENAI_API_KEY || '';
  if (provider === 'azure') return process.env.AZURE_API_KEY || '';
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
  return '';
}

function resolveSettingsAiToken(aiProvider, token, apiUrl) {
  const normalizedToken = String(token || '').trim();
  if (normalizedToken) return normalizedToken;
  // The saved Claude key only goes to a Claude endpoint already configured.
  const provider = String(aiProvider || '')
    .trim()
    .toLowerCase();
  if (provider === 'anthropic' && !isConfiguredAnthropicHost(apiUrl)) {
    return '';
  }
  return resolveStoredAiToken(aiProvider);
}

/* Quickstart detection on the settings page talks to the AI server that is
   already configured, so an empty key field means "use the stored one" rather
   than "no key" — the same rule the AI and OCR fields on that page follow. A
   saved key is never echoed back into the password input, so only this side
   can tell the two apart. Setup has no stored configuration to fall back on
   and therefore does not use this.

   Two conditions, both necessary. The key belongs to the configured provider,
   so it is resolved through resolveStoredAiToken() rather than by trying one
   variable after another — a stale CUSTOM_API_KEY left over from a provider
   switch must not be sent to an Ollama host. And it is only substituted when
   the request targets that provider's own server: the settings page keeps
   saved secrets out of the DOM on purpose, and an endpoint that forwards one
   to any URL the caller names would hand it back out again. Typed keys are
   always honoured, whatever the target. */
function resolveSettingsQuickstartApiKey(baseUrl, apiKey) {
  const normalizedApiKey = String(apiKey || '').trim();
  if (normalizedApiKey) {
    return normalizedApiKey;
  }

  const provider = String(process.env.AI_PROVIDER || '')
    .trim()
    .toLowerCase();
  const configuredUrl =
    provider === 'ollama'
      ? process.env.OLLAMA_API_URL
      : provider === 'custom'
        ? process.env.CUSTOM_BASE_URL
        : '';

  return isSameQuickstartHost(baseUrl, configuredUrl)
    ? resolveStoredAiToken(provider)
    : '';
}

/* The origin (scheme, host and port) of a URL, or null. */
function urlOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

/* The client secret for the single sign-on test. A typed secret is always
   used. An empty field means "the stored one", but only for the provider it
   was stored for: the page never shows the saved secret, and a test endpoint
   that sent it to any issuer the caller names would hand it out again. */
function resolveOidcTestClientSecret(issuerUrl, clientSecret) {
  const typed = String(clientSecret || '').trim();
  if (typed) return typed;

  const requested = urlOrigin(oidcService.normalizeIssuerUrl(issuerUrl));
  const configured = urlOrigin(
    oidcService.normalizeIssuerUrl(process.env.OIDC_ISSUER_URL)
  );
  return requested && configured && requested === configured
    ? String(process.env.OIDC_CLIENT_SECRET || '')
    : '';
}

/* Compares the detection target with the configured AI server. The Quickstart
   field is written by hand and normalizeBaseUrls() strips /v1 and trailing
   slashes, so "http://host:1234/v1/" and "http://host:1234" are the same
   server; anything that does not parse is not. */
function isSameQuickstartHost(requestedUrl, configuredUrl) {
  const normalize = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);
      return `${parsed.protocol}//${parsed.host}`.toLowerCase();
    } catch {
      return null;
    }
  };

  const requested = normalize(requestedUrl);
  const configured = normalize(configuredUrl);
  return Boolean(requested && configured && requested === configured);
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
 * /api/settings/ai/test:
 *   post:
 *     summary: Test AI provider connectivity from the settings page
 *     tags:
 *       - Settings
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
 *               - aiProvider
 *             properties:
 *               aiProvider:
 *                 type: string
 *                 enum: [openai, ollama, custom, azure, anthropic]
 *               apiUrl:
 *                 type: string
 *                 description: Not needed for anthropic unless a proxy sits in front of api.anthropic.com
 *               token:
 *                 type: string
 *                 description: Omit or leave empty to use the stored key of the selected provider
 *               model:
 *                 type: string
 *                 description: For anthropic, checked with a models lookup that spends no tokens
 *               setupValidationTimeoutMs:
 *                 type: integer
 *     responses:
 *       200:
 *         description: AI connectivity result returned
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/api/settings/ai/test',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const validation = await validateAiConnectionForSetup({
        aiProvider: req.body?.aiProvider,
        apiUrl: req.body?.apiUrl,
        token: resolveSettingsAiToken(
          req.body?.aiProvider,
          req.body?.token,
          req.body?.apiUrl
        ),
        model: req.body?.model,
        azureApiVersion: req.body?.azureApiVersion,
        setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
      });

      return res.json(validation);
    } catch (error) {
      console.error('[ERROR] POST /api/settings/ai/test:', error);
      return res.status(500).json({
        success: false,
        error: 'Could not test AI connection.',
      });
    }
  }
);

/**
 * @swagger
 * /api/settings/ocr/test:
 *   post:
 *     summary: Test OCR provider connectivity from the settings page
 *     description: |
 *       Runs one OCR request on a generated test image. For `anthropic` the
 *       key is the OCR key when one is given or stored for Claude OCR, and
 *       otherwise the Anthropic AI provider's key (`anthropicApiKey`, then
 *       the stored ANTHROPIC_API_KEY).
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled:
 *                 type: string
 *                 enum: ["yes", "no"]
 *               provider:
 *                 type: string
 *                 enum: [mistral, custom, ollama, anthropic]
 *               apiUrl:
 *                 type: string
 *                 description: Ignored for mistral. For anthropic an optional proxy URL; empty uses the Anthropic AI provider's URL, then api.anthropic.com
 *               apiKey:
 *                 type: string
 *                 description: Omit or leave empty to use the stored key
 *               model:
 *                 type: string
 *                 description: For anthropic, a Claude model; anything else falls back to the AI model
 *               setupOcrValidationTimeoutMs:
 *                 type: integer
 *               anthropicApiKey:
 *                 type: string
 *                 description: Anthropic AI key typed but not saved yet; Claude OCR falls back to it
 *               anthropicApiUrl:
 *                 type: string
 *                 description: Anthropic AI proxy URL typed but not saved yet
 *               anthropicModel:
 *                 type: string
 *                 description: Anthropic AI model typed but not saved yet
 *     responses:
 *       200:
 *         description: OCR connectivity result returned
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/api/settings/ocr/test',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const validation = await validateOcrConnectionForSetup({
        enabled: req.body?.enabled,
        provider: req.body?.provider,
        apiUrl: req.body?.apiUrl,
        apiKey: resolveOcrApiKeyForProvider(
          req.body?.provider,
          req.body?.apiKey,
          req.body?.apiUrl || req.body?.anthropicApiUrl
        ),
        model: req.body?.model,
        setupOcrValidationTimeoutMs:
          req.body?.setupOcrValidationTimeoutMs ??
          req.body?.setupValidationTimeoutMs,
        // A key typed into the Anthropic AI fields but not saved yet; the
        // stored one comes from the environment.
        anthropicApiKey: req.body?.anthropicApiKey,
        anthropicApiUrl: req.body?.anthropicApiUrl,
        anthropicModel: req.body?.anthropicModel,
      });

      return res.json(validation);
    } catch (error) {
      console.error('[ERROR] POST /api/settings/ocr/test:', error);
      return res.status(500).json({
        success: false,
        error: 'Could not test OCR connection.',
      });
    }
  }
);

/**
 * @swagger
 * /api/settings/oidc/test:
 *   post:
 *     summary: Test a single sign-on provider from the settings page
 *     description: |
 *       Reads the provider's discovery document, picks the token endpoint auth
 *       method the login would use, and checks the client credentials by
 *       redeeming an authorization code that cannot exist: the provider
 *       answers invalid_client for wrong credentials and invalid_grant for
 *       right ones. Nobody is signed in and nothing is saved.
 *
 *       An empty `clientSecret` uses the stored OIDC_CLIENT_SECRET, but only
 *       when the issuer has the same origin (scheme, host, port) as the
 *       configured OIDC_ISSUER_URL; for any other issuer the test runs
 *       without a secret. Private network addresses are allowed, since
 *       identity providers usually run next to the application.
 *     tags:
 *       - Settings
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
 *               - issuerUrl
 *               - clientId
 *             properties:
 *               issuerUrl:
 *                 type: string
 *                 description: Issuer URL (http or https); a pasted discovery URL is accepted
 *                 example: "https://auth.example.com/application/o/zettelrobbe/"
 *               clientId:
 *                 type: string
 *                 example: "zettelrobbe"
 *               clientSecret:
 *                 type: string
 *                 description: Omit or leave empty to use the stored secret (same issuer origin only)
 *                 example: ""
 *               tokenAuthMethod:
 *                 type: string
 *                 description: Empty picks the method automatically
 *                 enum: ["", "client_secret_basic", "client_secret_post", "none"]
 *                 example: ""
 *     responses:
 *       200:
 *         description: |
 *           Test result. success is false (still HTTP 200) when the provider
 *           could not be reached, sent no usable discovery document, or refused
 *           the client credentials; error then says which.
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       example: true
 *                     data:
 *                       type: object
 *                       properties:
 *                         issuer:
 *                           type: string
 *                           description: The issuer the provider advertises
 *                           example: "https://auth.example.com/application/o/zettelrobbe/"
 *                         tokenAuthMethods:
 *                           type: array
 *                           description: Token endpoint auth methods the provider advertises (empty when it lists none)
 *                           items:
 *                             type: string
 *                           example: ["client_secret_basic", "client_secret_post"]
 *                         chosenAuthMethod:
 *                           type: string
 *                           description: The method a login would use
 *                           example: "client_secret_basic"
 *                         pkce:
 *                           type: boolean
 *                           description: Whether the provider advertises PKCE with S256
 *                           example: true
 *                     message:
 *                       type: string
 *                       example: "The provider answered and accepted the client."
 *                 - $ref: '#/components/schemas/Error'
 *       400:
 *         description: Invalid input (issuer not an http(s) URL, empty client ID, unknown auth method, or a method that needs a secret without one)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       302:
 *         description: Not signed in; redirected to /login like every other route behind the authentication guard
 */
router.post(
  '/api/settings/oidc/test',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const issuerUrl = oidcService.normalizeIssuerUrl(req.body?.issuerUrl);
      const clientId = String(req.body?.clientId || '').trim();
      const tokenAuthMethod = String(req.body?.tokenAuthMethod || '')
        .trim()
        .toLowerCase();

      if (!oidcService.isAbsoluteHttpUrl(issuerUrl)) {
        return res.status(400).json({
          success: false,
          error: 'The issuer URL must start with https:// or http://.',
        });
      }
      if (!clientId) {
        return res
          .status(400)
          .json({ success: false, error: 'The client ID is missing.' });
      }
      if (
        tokenAuthMethod &&
        !oidcService.TOKEN_AUTH_METHODS.includes(tokenAuthMethod)
      ) {
        return res.status(400).json({
          success: false,
          error: `Unknown token endpoint auth method. Use one of: ${oidcService.TOKEN_AUTH_METHODS.join(', ')}, or leave it empty.`,
        });
      }

      const clientSecret = resolveOidcTestClientSecret(
        issuerUrl,
        req.body?.clientSecret
      );
      if (
        !clientSecret &&
        ['client_secret_basic', 'client_secret_post'].includes(tokenAuthMethod)
      ) {
        return res.status(400).json({
          success: false,
          error: `${tokenAuthMethod} needs a client secret. Enter it, or choose another auth method.`,
        });
      }

      let data;
      try {
        data = await oidcService.testConnection({
          issuerUrl,
          clientId,
          clientSecret,
          tokenAuthMethod,
        });
      } catch (error) {
        console.warn(
          '[WARN] POST /api/settings/oidc/test failed:',
          error.message
        );
        return res.json({ success: false, error: error.message });
      }

      return res.json({
        success: true,
        data,
        message: 'The provider answered and accepted the client.',
      });
    } catch (error) {
      console.error('[ERROR] POST /api/settings/oidc/test:', error);
      return res.status(500).json({
        success: false,
        error: 'Could not test single sign-on.',
      });
    }
  }
);

router.post(
  '/api/settings/ai/models',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const result = await discoverAiModelsForSetup({
        aiProvider: req.body?.aiProvider,
        apiUrl: req.body?.apiUrl,
        token: resolveSettingsAiToken(
          req.body?.aiProvider,
          req.body?.token,
          req.body?.apiUrl
        ),
        setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
      });

      return res.json(result);
    } catch (error) {
      console.error('[ERROR] POST /api/settings/ai/models:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Could not discover AI models.',
      });
    }
  }
);

router.get('/api/settings/ai/presets', isAuthenticated, async (_req, res) => {
  try {
    const presets = await loadAiProviderPresets();
    return res.json({
      success: true,
      presets,
    });
  } catch (error) {
    console.error('[ERROR] GET /api/settings/ai/presets:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not load AI provider presets.',
    });
  }
});

/**
 * @swagger
 * /api/settings/ocr/models:
 *   post:
 *     summary: Discover available OCR models from the settings page
 *     description: |
 *       Returns every discovered model that is not embedding-only. Vision
 *       support is detected from the model name, which recognizes families
 *       such as llava or pixtral and misses OCR-capable models with
 *       unremarkable names, so it ranks the list instead of filtering it:
 *       `visionModels` and `suggestedModel` are hints for the UI, not a
 *       restriction on what may be selected.
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               provider:
 *                 type: string
 *                 enum: [mistral, custom, ollama, anthropic]
 *               apiUrl:
 *                 type: string
 *               apiKey:
 *                 type: string
 *                 description: Omit or leave empty to use the stored OCR_API_KEY / MISTRAL_API_KEY (for anthropic, the stored Claude OCR key, then the Anthropic AI key)
 *               setupOcrValidationTimeoutMs:
 *                 type: integer
 *               anthropicApiKey:
 *                 type: string
 *                 description: Anthropic AI key typed but not saved yet; used by anthropic when no OCR key is set
 *               anthropicApiUrl:
 *                 type: string
 *                 description: Anthropic AI proxy URL typed but not saved yet
 *               anthropicModel:
 *                 type: string
 *                 description: Anthropic AI model; anthropic returns it as suggestedModel
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
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/api/settings/ocr/models',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const result = await discoverOcrModelsForSetup({
        provider: req.body?.provider,
        apiUrl: req.body?.apiUrl,
        apiKey: resolveOcrApiKeyForProvider(
          req.body?.provider,
          req.body?.apiKey,
          req.body?.apiUrl || req.body?.anthropicApiUrl
        ),
        anthropicApiKey: req.body?.anthropicApiKey,
        anthropicApiUrl: req.body?.anthropicApiUrl,
        anthropicModel: req.body?.anthropicModel,
        setupOcrValidationTimeoutMs:
          req.body?.setupOcrValidationTimeoutMs ??
          req.body?.setupValidationTimeoutMs,
      });

      return res.json(result);
    } catch (error) {
      console.error('[ERROR] POST /api/settings/ocr/models:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Could not discover OCR models.',
      });
    }
  }
);

/**
 * @swagger
 * /api/settings/quickstart/detect:
 *   post:
 *     summary: Auto-detect API flavor and classify models from a single base URL
 *     tags:
 *       - Settings
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
 *               - baseUrl
 *             properties:
 *               baseUrl:
 *                 type: string
 *                 example: http://192.168.1.5:1234
 *               apiKey:
 *                 type: string
 *                 description: Omit or leave empty to use the stored CUSTOM_API_KEY / OLLAMA_API_KEY
 *               setupValidationTimeoutMs:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Detection result with classified models and suggestions
 *       400:
 *         description: Detection failed (unreachable URL, blocked URL, or no compatible API)
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/api/settings/quickstart/detect',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const result = await detectQuickstartForSetup({
        baseUrl: req.body?.baseUrl,
        // An empty field means the stored key, not no key: the settings page
        // never renders a saved secret back into the input. Only for the
        // configured AI server, though — see the resolver.
        apiKey: resolveSettingsQuickstartApiKey(
          req.body?.baseUrl,
          req.body?.apiKey
        ),
        setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
      });

      return res.json(result);
    } catch (error) {
      console.error('[ERROR] POST /api/settings/quickstart/detect:', error);
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
    res.clearCookie('jwt');
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

/**
 * @swagger
 * /manual/preview/{id}:
 *   get:
 *     summary: Document preview
 *     description: |
 *       Fetches and returns the content of a specific document from Paperless-ngx
 *       for preview in the manual document review interface.
 *
 *       This endpoint retrieves document details including content, title, ID, and tags,
 *       allowing users to view the document text before applying changes or processing
 *       it with AI tools. The document content is retrieved directly from Paperless-ngx
 *       using the system's configured API credentials.
 *     tags:
 *       - Documents
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
 *         description: The document ID from Paperless-ngx
 *         example: 123
 *     responses:
 *       200:
 *         description: Document content retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 content:
 *                   type: string
 *                   description: The document content
 *                   example: "Invoice from ACME Corp. Amount: $1,234.56"
 *                 title:
 *                   type: string
 *                   description: The document title
 *                   example: "ACME Corp Invoice #12345"
 *                 id:
 *                   type: integer
 *                   description: The document ID
 *                   example: 123
 *                 tags:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array of tag names assigned to the document
 *                   example: ["Invoice", "ACME Corp", "2023"]
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       404:
 *         description: Document not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error or Paperless connection error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/manual/preview/:id', isAuthenticated, async (req, res) => {
  try {
    const documentId = req.params.id;

    // Validate documentId to prevent path traversal and SSRF
    if (!/^\d+$/.test(documentId)) {
      return res.status(400).json({ error: 'Invalid document ID' });
    }

    console.log('Fetching content for document:', documentId);

    const response = await fetch(
      `${configFile.paperless.apiUrl}/api/documents/${documentId}/`,
      {
        headers: {
          Authorization: `Token ${process.env.PAPERLESS_API_TOKEN}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch document content: ${response.status} ${response.statusText}`
      );
    }

    const document = await response.json();
    //map the tags to their names
    document.tags = await Promise.all(
      document.tags.map(async (tag) => {
        const tagName = await paperlessService.getTagTextFromId(tag);
        return tagName;
      })
    );
    console.log('Document Data:', document);
    res.json({
      content: document.content,
      title: document.title,
      id: document.id,
      tags: document.tags,
    });
  } catch (error) {
    console.error('Content fetch error:', error);
    res
      .status(500)
      .json({ error: `Error fetching document content: ${error.message}` });
  }
});

/**
 * @swagger
 * /manual:
 *   get:
 *     summary: Document review page
 *     description: |
 *       Renders the manual document review page that allows users to browse,
 *       view and manually process documents from Paperless-ngx.
 *
 *       This interface enables users to review documents, view their content, and
 *       manage tags, correspondents, and document metadata without AI assistance.
 *       Users can apply manual changes to documents based on their own judgment,
 *       which is particularly useful for correction or verification of AI-processed documents.
 *     tags:
 *       - Navigation
 *       - Documents
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Manual document review page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the manual document review interface
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
router.get('/manual', isAuthenticated, async (req, res) => {
  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  res.render('manual', {
    title: 'Document Review',
    error: null,
    success: null,
    version,
    paperlessUrl: process.env.PAPERLESS_API_URL,
    paperlessToken: process.env.PAPERLESS_API_TOKEN,
    config: {},
  });
});

/**
 * @swagger
 * /manual/tags:
 *   get:
 *     summary: Get all tags
 *     description: |
 *       Retrieves all tags from Paperless-ngx for use in the manual document review interface.
 *
 *       This endpoint returns a complete list of all available tags that can be applied to documents,
 *       including their IDs, names, and colors. The tags are retrieved directly from Paperless-ngx
 *       and used for tag selection in the UI when manually updating document metadata.
 *     tags:
 *       - Documents
 *       - API
 *       - Metadata
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Tags retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Tag'
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error or Paperless connection error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/manual/tags', isAuthenticated, async (req, res) => {
  const getTags = await paperlessService.getTags();
  res.json(getTags);
});

/**
 * @swagger
 * /manual/documents:
 *   get:
 *     summary: Get all documents
 *     description: |
 *       Retrieves all documents from Paperless-ngx for display in the manual document review interface.
 *
 *       This endpoint returns a list of all available documents that can be manually reviewed,
 *       including their basic metadata such as ID, title, and creation date. The documents are
 *       retrieved directly from Paperless-ngx and presented in the UI for selection and processing.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Documents retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Document'
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error or Paperless connection error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/manual/documents', isAuthenticated, async (req, res) => {
  const getDocuments = await paperlessService.getDocuments();
  res.json(getDocuments);
});

/**
 * @swagger
 * /api/correspondentsCount:
 *   get:
 *     summary: Get count of correspondents
 *     description: |
 *       Retrieves the list of correspondents with their document counts.
 *       This endpoint returns all correspondents in the system along with
 *       the number of documents associated with each correspondent.
 *     tags:
 *       - API
 *       - Metadata
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of correspondents with document counts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                     description: ID of the correspondent
 *                     example: 1
 *                   name:
 *                     type: string
 *                     description: Name of the correspondent
 *                     example: "ACME Corp"
 *                   count:
 *                     type: integer
 *                     description: Number of documents associated with this correspondent
 *                     example: 5
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Invalid or expired token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/api/correspondentsCount', isAuthenticated, async (req, res) => {
  const correspondents = await paperlessService.listCorrespondentsNames();
  res.json(correspondents);
});

/**
 * @swagger
 * /api/tagsCount:
 *   get:
 *     summary: Get count of tags
 *     description: |
 *       Retrieves the list of tags with their document counts.
 *       This endpoint returns all tags in the system along with
 *       the number of documents associated with each tag.
 *     tags:
 *       - API
 *       - Metadata
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of tags with document counts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                     description: ID of the tag
 *                     example: 1
 *                   name:
 *                     type: string
 *                     description: Name of the tag
 *                     example: "Invoice"
 *                   count:
 *                     type: integer
 *                     description: Number of documents associated with this tag
 *                     example: 12
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Invalid or expired token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/api/tagsCount', isAuthenticated, async (req, res) => {
  const tags = await paperlessService.listTagNames();
  res.json(tags);
});

/**
 * @swagger
 * /dashboard:
 *   get:
 *     summary: Main dashboard page
 *     description: |
 *       Renders the main dashboard page of the application with summary statistics and visualizations.
 *       The dashboard provides an overview of processed documents, system metrics, and important statistics
 *       about document processing including tag counts, correspondent counts, and token usage.
 *
 *       The page displays visualizations for document processing status, token distribution,
 *       processing time statistics, and document type categorization to help administrators
 *       understand system performance and document processing patterns.
 *     tags:
 *       - Navigation
 *       - System
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Dashboard page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the dashboard page
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
router.get('/dashboard', isAuthenticated, async (req, res) => {
  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  let paperlessUrl = '';

  try {
    paperlessUrl = await paperlessService.getPublicBaseUrl();
  } catch (error) {
    console.warn(
      '[WARN] Could not resolve Paperless public URL for dashboard links:',
      error.message
    );
  }

  res.render('dashboard', {
    paperless_data: {
      tagCount: 0,
      correspondentCount: 0,
      documentCount: 0,
      processedDocumentCount: 0,
      ocrNeededCount: 0,
      failedCount: 0,
      queueBacklog: 0,
      processingEfficiencyRate: 0,
      failedRate: 0,
      processedToday: 0,
      processingTimeStats: [],
      tokenDistribution: [],
      documentTypes: [],
      tokenTrend: [],
      recentActivity: [],
      languageDistribution: [],
    },
    openai_data: {
      averagePromptTokens: 0,
      averageCompletionTokens: 0,
      averageTotalTokens: 0,
      tokensOverall: 0,
    },
    version,
    paperlessUrl,
    // The cards the view loops over. Which widgets ship, in which order and how
    // wide, is the registry's business — the view only renders what it is given.
    dashboardWidgets,
  });
});

// The payload itself is assembled in dashboardStatsService and cached there:
// this endpoint is polled by every open dashboard, and rebuilding it per
// request meant two Paperless-ngx round trips plus a dozen queries each time.
router.get('/api/dashboard/stats', isAuthenticated, async (req, res) => {
  try {
    const { payload, cachedAt } = await dashboardStatsService.getStats();
    res.json({ ...payload, cachedAt });
  } catch (error) {
    console.error('[ERROR] loading dashboard stats:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to load dashboard stats' });
  }
});

/**
 * @swagger
 * /api/settings/mfa/status:
 *   get:
 *     summary: Get MFA status for current user
 *     description: Returns whether TOTP MFA is enabled for the authenticated settings user.
 *     tags:
 *       - Settings
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: MFA status loaded successfully
 *       403:
 *         description: Forbidden - unsupported authentication context
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.get('/api/settings/mfa/status', isAuthenticated, async (req, res) => {
  try {
    const username = getAuthenticatedSettingsUsername(req);
    if (!username) {
      return res.status(403).json({
        success: false,
        error: 'MFA settings require a signed-in user session.',
      });
    }

    const user = await documentModel.getUser(username);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    return res.json({
      success: true,
      enabled: isMfaEnabledForUser(user),
      username: user.username,
    });
  } catch (error) {
    console.error('[ERROR] GET /api/settings/mfa/status:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to load MFA status.' });
  }
});

/**
 * @swagger
 * /api/settings/mfa/setup:
 *   post:
 *     summary: Start MFA setup and return provisioning data
 *     description: Validates current password and creates a temporary TOTP setup challenge including local QR image data.
 *     tags:
 *       - Settings
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: MFA setup challenge created
 *       400:
 *         description: Validation error
 *       401:
 *         description: Invalid current password
 *       403:
 *         description: Forbidden
 *       500:
 *         description: Server error
 */
router.post(
  '/api/settings/mfa/setup',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const username = getAuthenticatedSettingsUsername(req);
      if (!username) {
        return res.status(403).json({
          success: false,
          error: 'MFA settings require a signed-in user session.',
        });
      }

      const currentPassword = String(req.body?.currentPassword || '').trim();
      if (!currentPassword) {
        return res
          .status(400)
          .json({ success: false, error: 'Current password is required.' });
      }

      const user = await documentModel.getUser(username);
      if (!user || !user.password) {
        return res
          .status(404)
          .json({ success: false, error: 'User not found.' });
      }

      const validPassword = await bcrypt.compare(
        currentPassword,
        user.password
      );
      if (!validPassword) {
        return res
          .status(401)
          .json({ success: false, error: 'Current password is invalid.' });
      }

      const jwtSecret = config.getJwtSecret();
      if (!jwtSecret) {
        return res.status(500).json({
          success: false,
          error: 'Server misconfiguration: JWT secret missing.',
        });
      }

      const secret = generateBase32Secret(32);
      const setupToken = jwt.sign(
        {
          username: user.username,
          secret,
          setupType: 'mfa-setup',
        },
        jwtSecret,
        { expiresIn: '10m' }
      );

      res.cookie(MFA_SETUP_COOKIE, setupToken, {
        httpOnly: true,
        secure: shouldUseSecureCookies(req),
        sameSite: 'lax',
        path: '/',
      });

      return res.json({
        success: true,
        secret,
        otpauthUri: buildOtpAuthUri(secret, user.username),
        qrDataUrl: await QRCode.toDataURL(
          buildOtpAuthUri(secret, user.username),
          {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 220,
            color: {
              dark: '#0f172a',
              light: '#ffffff',
            },
          }
        ),
        expiresInSeconds: 600,
      });
    } catch (error) {
      console.error('[ERROR] POST /api/settings/mfa/setup:', error);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to start MFA setup.' });
    }
  }
);

/**
 * @swagger
 * /api/settings/mfa/enable:
 *   post:
 *     summary: Enable MFA after validating TOTP code
 *     description: Validates current password and setup token, verifies TOTP code, then enables MFA.
 *     tags:
 *       - Settings
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: MFA enabled successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Invalid credentials or token
 *       403:
 *         description: Forbidden
 *       500:
 *         description: Server error
 */
router.post(
  '/api/settings/mfa/enable',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const username = getAuthenticatedSettingsUsername(req);
      if (!username) {
        return res.status(403).json({
          success: false,
          error: 'MFA settings require a signed-in user session.',
        });
      }

      const currentPassword = String(req.body?.currentPassword || '').trim();
      const token = String(req.body?.token || '').trim();
      if (!currentPassword || !token) {
        return res.status(400).json({
          success: false,
          error: 'Current password and authentication code are required.',
        });
      }

      const user = await documentModel.getUser(username);
      if (!user || !user.password) {
        return res
          .status(404)
          .json({ success: false, error: 'User not found.' });
      }

      const validPassword = await bcrypt.compare(
        currentPassword,
        user.password
      );
      if (!validPassword) {
        return res
          .status(401)
          .json({ success: false, error: 'Current password is invalid.' });
      }

      const setupToken = req.cookies[MFA_SETUP_COOKIE];
      if (!setupToken) {
        return res.status(401).json({
          success: false,
          error: 'No active MFA setup challenge found. Start setup again.',
        });
      }

      const jwtSecret = config.getJwtSecret();
      if (!jwtSecret) {
        return res.status(500).json({
          success: false,
          error: 'Server misconfiguration: JWT secret missing.',
        });
      }

      let payload;
      try {
        payload = jwt.verify(setupToken, jwtSecret);
        if (
          payload.setupType !== 'mfa-setup' ||
          payload.username !== username
        ) {
          throw new Error('Invalid setup payload');
        }
      } catch {
        res.clearCookie(MFA_SETUP_COOKIE);
        return res.status(401).json({
          success: false,
          error: 'MFA setup session expired. Start setup again.',
        });
      }

      if (!consumeTotpToken(username, payload.secret, token)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid authentication code.' });
      }

      const updated = await documentModel.setUserMfaSettings(
        username,
        true,
        payload.secret
      );
      if (!updated) {
        return res
          .status(500)
          .json({ success: false, error: 'Failed to enable MFA for user.' });
      }

      res.clearCookie(MFA_SETUP_COOKIE);
      return res.json({ success: true, message: 'MFA has been enabled.' });
    } catch (error) {
      console.error('[ERROR] POST /api/settings/mfa/enable:', error);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to enable MFA.' });
    }
  }
);

/**
 * @swagger
 * /api/settings/mfa/verify:
 *   post:
 *     summary: Verify a TOTP code for an already enabled MFA setup
 *     description: Validates an entered TOTP code against the stored user MFA secret.
 *     tags:
 *       - Settings
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: TOTP code validated successfully
 *       400:
 *         description: Validation error
 *       403:
 *         description: Forbidden
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.post(
  '/api/settings/mfa/verify',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const username = getAuthenticatedSettingsUsername(req);
      if (!username) {
        return res.status(403).json({
          success: false,
          error: 'MFA settings require a signed-in user session.',
        });
      }

      const token = String(req.body?.token || '').trim();
      if (!token) {
        return res
          .status(400)
          .json({ success: false, error: 'Authentication code is required.' });
      }

      const user = await documentModel.getUser(username);
      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: 'User not found.' });
      }

      if (!isMfaEnabledForUser(user) || !user.mfa_secret) {
        return res
          .status(400)
          .json({ success: false, error: 'MFA is not enabled for this user.' });
      }

      const validCode = verifyTotpToken(user.mfa_secret, token);
      if (!validCode) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid authentication code.' });
      }

      return res.json({
        success: true,
        message: 'Authentication code is valid.',
      });
    } catch (error) {
      console.error('[ERROR] POST /api/settings/mfa/verify:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to verify authentication code.',
      });
    }
  }
);

/**
 * @swagger
 * /api/settings/mfa/disable:
 *   post:
 *     summary: Disable MFA for current user
 *     description: Validates current password and a valid TOTP code, then disables MFA for the user.
 *     tags:
 *       - Settings
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: MFA disabled successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: Forbidden
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.post(
  '/api/settings/mfa/disable',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const username = getAuthenticatedSettingsUsername(req);
      if (!username) {
        return res.status(403).json({
          success: false,
          error: 'MFA settings require a signed-in user session.',
        });
      }

      const currentPassword = String(req.body?.currentPassword || '').trim();
      const token = String(req.body?.token || '').trim();
      if (!currentPassword || !token) {
        return res.status(400).json({
          success: false,
          error: 'Current password and authentication code are required.',
        });
      }

      const user = await documentModel.getUser(username);
      if (!user || !user.password) {
        return res
          .status(404)
          .json({ success: false, error: 'User not found.' });
      }

      const validPassword = await bcrypt.compare(
        currentPassword,
        user.password
      );
      if (!validPassword) {
        return res
          .status(401)
          .json({ success: false, error: 'Current password is invalid.' });
      }

      if (!isMfaEnabledForUser(user) || !user.mfa_secret) {
        return res
          .status(400)
          .json({ success: false, error: 'MFA is not enabled for this user.' });
      }

      if (!consumeTotpToken(username, user.mfa_secret, token)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid authentication code.' });
      }

      const updated = await documentModel.setUserMfaSettings(
        username,
        false,
        null
      );
      if (!updated) {
        return res
          .status(500)
          .json({ success: false, error: 'Failed to disable MFA for user.' });
      }

      res.clearCookie(MFA_SETUP_COOKIE);
      return res.json({ success: true, message: 'MFA has been disabled.' });
    } catch (error) {
      console.error('[ERROR] POST /api/settings/mfa/disable:', error);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to disable MFA.' });
    }
  }
);

/**
 * @swagger
 * /api/settings/paperless-public-url:
 *   get:
 *     summary: Detect Paperless public URL
 *     description: Detects and returns the public base URL used for document links.
 *     tags:
 *       - Settings
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Public URL resolved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 publicUrl:
 *                   type: string
 *                 source:
 *                   type: string
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /manual/analyze:
 *   post:
 *     summary: Analyze document content manually
 *     description: |
 *       Analyzes document content using the configured AI provider and returns structured metadata.
 *       This endpoint processes the document text to extract relevant information such as tags,
 *       correspondent, and document type based on content analysis.
 *
 *       The analysis is performed using the AI provider configured in the application settings.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: The document text content to analyze
 *                 example: "Invoice from Acme Corp. Total amount: $125.00, Due date: 2023-08-15"
 *               existingTags:
 *                 type: array
 *                 description: List of existing tags in the system to help with tag matching
 *                 items:
 *                   type: string
 *                 example: ["Invoice", "Finance", "Acme Corp"]
 *               id:
 *                 type: string
 *                 description: Optional document ID for tracking metrics
 *                 example: "doc_123"
 *     responses:
 *       200:
 *         description: Document analysis results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 correspondent:
 *                   type: string
 *                   description: Detected correspondent name
 *                   example: "Acme Corp"
 *                 title:
 *                   type: string
 *                   description: Suggested document title
 *                   example: "Acme Corp Invoice - August 2023"
 *                 tags:
 *                   type: array
 *                   description: Suggested tags for the document
 *                   items:
 *                     type: string
 *                   example: ["Invoice", "Finance"]
 *                 documentType:
 *                   type: string
 *                   description: Detected document type
 *                   example: "Invoice"
 *                 metrics:
 *                   type: object
 *                   description: Token usage metrics (when using OpenAI)
 *                   properties:
 *                     promptTokens:
 *                       type: number
 *                       example: 350
 *                     completionTokens:
 *                       type: number
 *                       example: 120
 *                     totalTokens:
 *                       type: number
 *                       example: 470
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error or AI provider not configured
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post(
  '/manual/analyze',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const { content, id } = req.body;
      const existingCorrespondentList = toNameList(
        await paperlessService.listCorrespondentsNames()
      );
      const existingTagsList = toNameList(
        await paperlessService.listTagNames()
      );
      const existingDocumentTypesList = toNameList(
        await paperlessService.listDocumentTypesNames()
      );

      if (!content || typeof content !== 'string') {
        console.log('Invalid content received:', content);
        return res
          .status(400)
          .json({ error: 'Valid content string is required' });
      }

      if (!aiProviderRules.PROVIDER_IDS.includes(process.env.AI_PROVIDER)) {
        return res.status(500).json({ error: 'AI provider not configured' });
      }

      // Through the factory, which owns the provider service like every scan
      // does. Every provider's tokens are recorded the same way.
      const analyzeDocument =
        await AIServiceFactory.getService().analyzeDocument(
          content,
          existingTagsList,
          existingCorrespondentList,
          existingDocumentTypesList,
          id || []
        );
      if (analyzeDocument.metrics && id) {
        await documentModel.addOpenAIMetrics(
          id,
          analyzeDocument.metrics.promptTokens,
          analyzeDocument.metrics.completionTokens,
          analyzeDocument.metrics.totalTokens
        );
      }
      return res.json(analyzeDocument);
    } catch (error) {
      console.error('Analysis error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

/**
 * @swagger
 * /manual/updateDocument:
 *   post:
 *     summary: Update document metadata in Paperless-ngx
 *     description: |
 *       Updates document metadata such as tags, correspondent and title in the Paperless-ngx system.
 *       This endpoint handles the translation between tag names and IDs, and manages the creation of
 *       new tags or correspondents if they don't exist in the system.
 *
 *       The endpoint also removes any unused tags from the document to keep the metadata clean.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
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
 *                 type: number
 *                 description: ID of the document to update in Paperless-ngx
 *                 example: 123
 *               tags:
 *                 type: array
 *                 description: List of tags to apply (can be tag IDs or names)
 *                 items:
 *                   oneOf:
 *                     - type: number
 *                     - type: string
 *                 example: ["Invoice", 42, "Finance"]
 *               correspondent:
 *                 type: string
 *                 description: Correspondent name to assign to the document
 *                 example: "Acme Corp"
 *               title:
 *                 type: string
 *                 description: New title for the document
 *                 example: "Acme Corp Invoice - August 2023"
 *     responses:
 *       200:
 *         description: Document successfully updated
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
 *                   example: "Document updated successfully"
 *       400:
 *         description: Invalid request parameters or tag processing errors
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["Failed to create tag: Invalid tag name"]
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post(
  '/manual/updateDocument',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      var { documentId, tags, correspondent, title } = req.body;
      const options = {
        restrictToExistingTags: config.restrictToExistingTags === 'yes',
        restrictToExistingCorrespondents:
          config.restrictToExistingCorrespondents === 'yes',
        restrictToExistingDocumentTypes:
          config.restrictToExistingDocumentTypes === 'yes',
      };

      console.log('TITLE: ', title);
      // Convert all tags to names if they are IDs
      tags = await Promise.all(
        tags.map(async (tag) => {
          console.log('Processing tag:', tag);
          if (!isNaN(tag)) {
            const tagName = await paperlessService.getTagTextFromId(
              Number(tag)
            );
            console.log('Converted tag ID:', tag, 'to name:', tagName);
            return tagName;
          }
          return tag;
        })
      );

      // Filter out any null or undefined tags
      tags = tags.filter((tag) => tag != null);

      // Process new tags to get their IDs
      const { tagIds, errors } = await paperlessService.processTags(
        tags,
        options
      );
      if (errors.length > 0) {
        return res.status(400).json({ errors });
      }

      // Process correspondent if provided
      const correspondentData = correspondent
        ? await paperlessService.getOrCreateCorrespondent(
            correspondent,
            options
          )
        : null;

      await paperlessService.removeUnusedTagsFromDocument(documentId, tagIds);

      // Then update with new tags (this will only add new ones since we already removed unused ones)
      const updateData = {
        tags: tagIds,
        correspondent: correspondentData ? correspondentData.id : null,
        title: title ? title : null,
      };

      if (
        updateData.tags === null &&
        updateData.correspondent === null &&
        updateData.title === null
      ) {
        return res.status(400).json({ error: 'No changes provided' });
      }
      const updateDocument = await paperlessService.updateDocument(
        documentId,
        updateData
      );

      // Mark document as processed
      await documentModel.addProcessedDocument(documentId, updateData.title);
      dashboardStatsService.invalidate();

      res.json(updateDocument);
    } catch (error) {
      console.error('Update error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

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

router.get('/dashboard/doc/:id', isAuthenticated, async (req, res) => {
  const docId = req.params.id;
  if (!docId) {
    return res.status(400).json({ error: 'Document ID is required' });
  }
  try {
    const paperlessPublicUrl = await paperlessService.getPublicBaseUrl();
    if (!paperlessPublicUrl) {
      return res
        .status(500)
        .json({ error: 'Paperless public URL is not configured' });
    }

    const redirectUrl = `${paperlessPublicUrl}/documents/${docId}/details`;
    console.log('Redirecting to Paperless-ngx URL:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: 'Failed to fetch document' });
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

/* Dashboard storage format v1.
   ---------------------------
   The dashboard sends back the boards the user arranged:

     {
       version: 1,
       active: 'default',
       dashboards: [
         {
           slug: 'default',
           name: 'Dashboard',
           widgets: [{ id: 'task-runner', span: 12, rows: 0, hidden: false }]
         }
       ]
     }

   This blob goes straight into users.dashboard_layout, so the validator below
   is the only thing between a hostile payload and the database. It rejects
   whole configurations rather than repairing them: a payload it cannot vouch
   for is a bug or an attack, and storing the salvageable half of either is
   worse than a 400.

   Widget and dashboard ids are deliberately not checked against a list. The
   dashboard adds and renames cards, and a stale server-side list would silently
   drop a card's placement; the shape, the spans and the counts are what has to
   be trustworthy. Anything the browser no longer knows is ignored when the
   layout is applied.

   Two conventions run through the whole format:

   - Absent means "use the defaults". No stored config, an empty dashboards
     list, and a dashboard without widgets all say the same thing: render the
     cards the way the server shipped them, in registry order.
   - active is a pointer, not data. A slug that no longer resolves — a deleted
     board, a stale client — falls back to the first dashboard instead of
     failing the write. The arrangement is the valuable part, and landing on
     board one beats losing it to a 400 over a name. */
const DASHBOARD_WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DASHBOARD_MAX_WIDGETS = 50;
const DASHBOARD_MIN_SPAN = 3;
const DASHBOARD_GRID_COLUMNS = 12;
const DASHBOARD_MIN_ROWS = 3;
const DASHBOARD_MAX_ROWS = 24;
const DASHBOARD_CONFIG_VERSION = 1;
const DASHBOARD_MAX_BOARDS = 10;
const DASHBOARD_MAX_NAME_LENGTH = 60;
const DASHBOARD_DEFAULT_SLUG = 'default';

/* Nothing stored: a valid v1 config that asks for the defaults. */
function emptyDashboardConfig() {
  return {
    version: DASHBOARD_CONFIG_VERSION,
    active: DASHBOARD_DEFAULT_SLUG,
    dashboards: [],
  };
}

/* One board's cards, cleaned. Returns null — not a partial list — as soon as
   anything is off, so a single bad card takes the whole write down with it. */
function normalizeDashboardWidgets(input) {
  if (!Array.isArray(input)) {
    return null;
  }
  if (input.length > DASHBOARD_MAX_WIDGETS) {
    return null;
  }

  const seen = new Set();
  const widgets = [];
  for (const entry of input) {
    const id = String(entry?.id || '').trim();
    if (!DASHBOARD_WIDGET_ID.test(id) || seen.has(id)) {
      return null;
    }
    seen.add(id);

    // span and rows are parsed rather than compared: they are read off DOM
    // datasets in the browser, where everything is a string.
    const span = Number.parseInt(entry?.span, 10);
    if (
      !Number.isInteger(span) ||
      span < DASHBOARD_MIN_SPAN ||
      span > DASHBOARD_GRID_COLUMNS
    ) {
      return null;
    }

    // Tile rows. 0 means "as tall as the content needs", which is the default
    // and the only value outside the 3..24 range a card may carry.
    const rows = Number.parseInt(entry?.rows, 10) || 0;
    if (
      rows !== 0 &&
      (rows < DASHBOARD_MIN_ROWS || rows > DASHBOARD_MAX_ROWS)
    ) {
      return null;
    }

    // hidden is a toggle, not data: absent, null or anything falsy means the
    // card is shown. Nothing to reject here, so nothing does.
    widgets.push({ id, span, rows, hidden: Boolean(entry?.hidden) });
  }

  return widgets;
}

/* "Give me the defaults back" arrives in two shapes: no boards at all, or the
   single board the reset button empties. Both clear the stored config. More
   than one board is left alone — an empty board among several is a named view
   that happens to show the default cards, and dropping its name would be the
   opposite of what the user asked for. */
function isDashboardResetRequest(input) {
  if (!input || !Array.isArray(input.dashboards)) {
    return false;
  }
  if (input.dashboards.length === 0) {
    return true;
  }
  return (
    input.dashboards.length === 1 &&
    Array.isArray(input.dashboards[0]?.widgets) &&
    input.dashboards[0].widgets.length === 0
  );
}

function normalizeDashboardConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  // Strict: version is written by our own code, never typed into a form, so a
  // string '1' is a bug worth surfacing rather than a value worth coercing.
  if (input.version !== DASHBOARD_CONFIG_VERSION) {
    return null;
  }
  if (!Array.isArray(input.dashboards)) {
    return null;
  }
  if (
    input.dashboards.length < 1 ||
    input.dashboards.length > DASHBOARD_MAX_BOARDS
  ) {
    return null;
  }

  const slugs = new Set();
  const dashboards = [];
  for (const entry of input.dashboards) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }

    // Slugs are ids, so they answer to the widget-id rules: lowercase, no
    // markup, short enough to live in a URL.
    const slug = String(entry.slug || '').trim();
    if (!DASHBOARD_WIDGET_ID.test(slug) || slugs.has(slug)) {
      return null;
    }
    slugs.add(slug);

    // The name is what the user typed, so it is trimmed first and then has to
    // still say something. It is escaped where it is rendered, not here.
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name.length < 1 || name.length > DASHBOARD_MAX_NAME_LENGTH) {
      return null;
    }

    // A board without widgets is the default arrangement under a name, so a
    // missing list is the same as an empty one. A non-array is not.
    const widgets = normalizeDashboardWidgets(
      entry.widgets === undefined || entry.widgets === null ? [] : entry.widgets
    );
    if (!widgets) {
      return null;
    }

    dashboards.push({ slug, name, widgets });
  }

  const requested = String(input.active || '').trim();
  const active = slugs.has(requested) ? requested : dashboards[0].slug;

  return { version: DASHBOARD_CONFIG_VERSION, active, dashboards };
}

/**
 * @swagger
 * /api/dashboard/layout:
 *   get:
 *     summary: Read the authenticated user's dashboard configuration
 *     description: >
 *       Returns the stored configuration in storage format v1: the named
 *       dashboards the user arranged, each with its widgets in display order,
 *       and the slug of the active one. An empty dashboards list means nothing
 *       has been customised and every board renders in its default order — the
 *       same answer a user without a stored configuration gets.
 *     tags:
 *       - Dashboard
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: The stored configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     version:
 *                       type: integer
 *                       example: 1
 *                     active:
 *                       type: string
 *                       description: Slug of the dashboard currently shown
 *                       example: "default"
 *                     dashboards:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           slug:
 *                             type: string
 *                             example: "default"
 *                           name:
 *                             type: string
 *                             example: "Dashboard"
 *                           widgets:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 id:
 *                                   type: string
 *                                   example: "task-runner"
 *                                 span:
 *                                   type: integer
 *                                   description: Width in grid columns, 3 to 12
 *                                   example: 12
 *                                 rows:
 *                                   type: integer
 *                                   description: Height in tile rows, 3 to 24, or 0 for as tall as the content
 *                                   example: 0
 *                                 hidden:
 *                                   type: boolean
 *                                   example: false
 *       401:
 *         description: Not authenticated
 */
router.get('/api/dashboard/layout', isAuthenticated, async (req, res) => {
  try {
    const username = req.user && req.user.username;
    if (!username) {
      return res.json({ success: true, data: emptyDashboardConfig() });
    }

    const stored = await documentModel.getDashboardLayout(username);
    // What was stored was validated on the way in, so it is handed back as it
    // is. Only the shape is checked: this is an unreleased feature, and a blob
    // in an older shape is a development leftover that should quietly fall back
    // to the defaults rather than reach the browser.
    const dashboardConfig =
      stored &&
      stored.version === DASHBOARD_CONFIG_VERSION &&
      Array.isArray(stored.dashboards)
        ? stored
        : emptyDashboardConfig();

    return res.json({ success: true, data: dashboardConfig });
  } catch (error) {
    console.error('[ERROR] GET /api/dashboard/layout:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to load dashboard layout' });
  }
});

/**
 * @swagger
 * /api/dashboard/layout:
 *   put:
 *     summary: Store or reset the authenticated user's dashboard configuration
 *     description: >
 *       Takes a complete configuration in storage format v1 and replaces the
 *       stored one; there is no partial update. Up to 10 dashboards, each with
 *       a slug, a name of 1 to 60 characters and up to 50 widgets in display
 *       order. Widget spans are 3 to 12 grid columns; rows are 3 to 24 tile
 *       rows, or 0 for a card that is as tall as its content. A dashboard
 *       without widgets shows the default arrangement under its own name.
 *
 *       Two payloads reset instead of storing: an empty dashboards array, and a
 *       single dashboard whose widgets array is empty. Both clear the stored
 *       configuration, so every board returns to its default order. Emptying
 *       one board out of several does not reset — that board simply shows the
 *       defaults and keeps its name.
 *
 *       If active names a dashboard that is not in the payload it is replaced
 *       with the first dashboard's slug rather than rejecting the write.
 *     tags:
 *       - Dashboard
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               version:
 *                 type: integer
 *                 enum: [1]
 *                 example: 1
 *               active:
 *                 type: string
 *                 description: Slug of the dashboard to show
 *                 example: "default"
 *               dashboards:
 *                 type: array
 *                 maxItems: 10
 *                 items:
 *                   type: object
 *                   required:
 *                     - slug
 *                     - name
 *                   properties:
 *                     slug:
 *                       type: string
 *                       pattern: "^[a-z0-9][a-z0-9-]{0,39}$"
 *                       example: "default"
 *                     name:
 *                       type: string
 *                       minLength: 1
 *                       maxLength: 60
 *                       example: "Dashboard"
 *                     widgets:
 *                       type: array
 *                       maxItems: 50
 *                       items:
 *                         type: object
 *                         required:
 *                           - id
 *                           - span
 *                         properties:
 *                           id:
 *                             type: string
 *                             pattern: "^[a-z0-9][a-z0-9-]{0,39}$"
 *                             example: "task-runner"
 *                           span:
 *                             type: integer
 *                             minimum: 3
 *                             maximum: 12
 *                             example: 12
 *                           rows:
 *                             type: integer
 *                             description: 3 to 24 tile rows, or 0 for as tall as the content
 *                             example: 0
 *                           hidden:
 *                             type: boolean
 *                             default: false
 *     responses:
 *       200:
 *         description: Configuration stored or reset
 *       400:
 *         description: Malformed configuration
 *       401:
 *         description: Not authenticated
 */
router.put(
  '/api/dashboard/layout',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const username = req.user && req.user.username;
      if (!username) {
        return res.json({ success: true, message: 'No user to store against' });
      }

      // Nothing arranged is not stored as "an empty arrangement": the row is
      // cleared, so the dashboard falls back to the registry order.
      if (isDashboardResetRequest(req.body)) {
        await documentModel.setDashboardLayout(username, null);
        return res.json({
          success: true,
          data: emptyDashboardConfig(),
          message: 'Dashboard layout reset',
        });
      }

      const dashboardConfig = normalizeDashboardConfig(req.body);
      if (!dashboardConfig) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid dashboard layout' });
      }

      await documentModel.setDashboardLayout(username, dashboardConfig);
      return res.json({
        success: true,
        data: dashboardConfig,
        message: 'Dashboard layout saved',
      });
    } catch (error) {
      console.error('[ERROR] PUT /api/dashboard/layout:', error);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to save dashboard layout' });
    }
  }
);

module.exports = router;
