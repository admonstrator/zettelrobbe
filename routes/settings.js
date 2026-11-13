'use strict';

/**
 * The settings page and its save, plus the settings that are neither a
 * connection test nor MFA: the API key, the public Paperless-ngx URL, the
 * .env export, the runtime override reset and the API key regeneration.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   POST  /api/settings/reset-local-overrides   Reset local runtime overrides
 *   POST  /api/key-regenerate                   Regenerate API key
 *   GET   /settings                             Get dashboard statistics payload
 *   GET   /api/settings/api-key                 Get current application API key
 *   GET   /api/settings/paperless-public-url
 *   POST  /settings                             Update application settings
 *   GET   /api/settings/env-file                Export the running configuration as a .env file
 */

const express = require('express');
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const configFile = require('../config/config.js');
const aiProviderRules = require('../services/aiProviderRules');
const settingsCatalog = require('../services/settingsCatalog');
const settingsService = require('../services/settingsService');
const { RESTART_REQUIRED_KEYS } = require('../config/restartRequiredKeys');
const changelog = require('../config/changelog.js');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { isAuthenticated } = require('./auth.js');
const { getAuthenticatedSettingsUsername } = require('../middleware/authGate');
const { cacheClearLimiter } = require('../middleware/rateLimiters');
const { isMfaEnabledForUser } = require('../services/mfaService');
const restartService = require('../services/restartService');
const oidcService = require('../services/oidcService');
const {
  getAnthropicFormOptions,
  loadAiProviderPresets,
} = require('../services/aiFormOptions');
const { BOOT_IDENTITY } = require('../services/bootIdentity');
const router = express.Router();

/**
 * @swagger
 * /api/settings/reset-local-overrides:
 *   post:
 *     summary: Reset local runtime overrides
 *     description: |
 *       Removes local runtime override values so injected environment variables are used after restart.
 *       This operation is restricted to interactive user sessions and requires the current account password.
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *                 description: Current password of the signed-in settings user
 *     responses:
 *       200:
 *         description: Override reset completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 hadOverrides:
 *                   type: boolean
 *                 restart:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Validation error
 *       401:
 *         description: Invalid password
 *       403:
 *         description: Forbidden - interactive session required
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */

router.post(
  '/api/settings/reset-local-overrides',
  isAuthenticated,
  cacheClearLimiter,
  express.json(),
  async (req, res) => {
    try {
      const username = getAuthenticatedSettingsUsername(req);
      if (!username) {
        return res.status(403).json({
          success: false,
          error: 'Reset local overrides requires a signed-in user session.',
        });
      }

      const currentPassword = String(req.body?.currentPassword || '').trim();
      if (!currentPassword) {
        return res.status(400).json({
          success: false,
          error: 'Current password is required.',
        });
      }

      const user = await documentModel.getUser(username);
      if (!user || !user.password) {
        return res.status(404).json({
          success: false,
          error: 'User not found.',
        });
      }

      const validPassword = await bcrypt.compare(
        currentPassword,
        user.password
      );
      if (!validPassword) {
        return res.status(401).json({
          success: false,
          error: 'Current password is invalid.',
        });
      }

      const hadOverrides = await setupService.clearRuntimeOverrides();

      res.json({
        success: true,
        hadOverrides,
        restart: true,
        message: hadOverrides
          ? 'Local runtime overrides have been removed. Restarting service to apply injected environment values.'
          : 'No local runtime overrides were found. Restarting service to reload injected environment values.',
      });

      restartService.requestRestart();
    } catch (error) {
      console.error('[ERROR] resetting local runtime overrides:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to reset local runtime overrides',
      });
    }
  }
);

/**
 * @swagger
 * /api/key-regenerate:
 *   post:
 *     summary: Regenerate API key
 *     description: |
 *       Generates a new random API key for the application and updates the .env file.
 *       The previous API key will be invalidated immediately after generation.
 *
 *       This API key can be used for programmatic access to the API endpoints
 *       by sending it in the `x-api-key` header of subsequent requests.
 *
 *       **Security Notice**: This operation invalidates any existing API key.
 *       All systems using the previous key will need to be updated.
 *     tags:
 *       - System
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: API key regenerated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Indicates whether regeneration succeeded
 *                   example: true
 *                 newKey:
 *                   type: string
 *                   description: The newly generated API key
 *                   example: "3f7a8d6e2c1b5a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5"
 *       401:
 *         description: Unauthorized - JWT authentication required
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
 *                   example: "Error regenerating API key"
 */
router.post('/api/key-regenerate', isAuthenticated, async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const dotenv = require('dotenv');
    const crypto = require('crypto');
    const envPath = path.join(__dirname, '../data/', '.env');
    const legacyMode =
      String(process.env.CONFIG_SOURCE_MODE || 'runtime-first')
        .trim()
        .toLowerCase() === 'legacy';
    let envConfig = {};
    if (legacyMode && fs.existsSync(envPath)) {
      envConfig = dotenv.parse(fs.readFileSync(envPath));
    }

    // Generate a new API token
    const apiKey = crypto.randomBytes(32).toString('hex');
    envConfig.API_KEY = apiKey;

    if (legacyMode) {
      // Persist to legacy .env only in legacy mode
      const envContent = Object.entries(envConfig)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      fs.writeFileSync(envPath, envContent);
    }

    // Set runtime value for current process
    process.env.API_KEY = apiKey;
    await setupService.saveRuntimeOverrides({
      ...(await setupService.loadRuntimeOverrides()),
      API_KEY: apiKey,
    });

    // Return response
    res.json({ success: true, newKey: apiKey });
  } catch (error) {
    console.error('API key regeneration error:', error);
    res.status(500).json({ error: 'Error regenerating API key' });
  }
});

/**
 * @swagger
 * /api/dashboard/stats:
 *   get:
 *     summary: Get dashboard statistics payload
 *     description: |
 *       Returns all aggregate counters and chart datasets required by the dashboard UI.
 *
 *       The payload is served from an in-memory cache instead of being rebuilt per
 *       request. It is refreshed in the background (once a minute, plus after every
 *       scan run) and expires after STATS_CACHE_TTL_SECONDS (default 60). The scan
 *       loop invalidates it for every document it processes, so figures follow
 *       processing without polling Paperless-ngx on every request.
 *     tags:
 *       - System
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Dashboard statistics returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 cachedAt:
 *                   type: integer
 *                   format: int64
 *                   description: >-
 *                     Epoch milliseconds at which the returned payload was assembled.
 *                     0 when the assembly time is unknown.
 *                 paperless_data:
 *                   type: object
 *                   description: Aggregate counters and chart datasets.
 *                 openai_data:
 *                   type: object
 *                   description: Token averages and the overall token total.
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /settings:
 *   get:
 *     summary: Application settings page
 *     description: |
 *       Renders the application settings page where users can modify configuration
 *       after initial setup.
 *
 *       This page allows administrators to update connections to Paperless-ngx,
 *       AI provider settings, processing parameters, feature toggles, and custom fields.
 *       The interface provides validation for connection settings and displays the current
 *       configuration values.
 *
 *       Changes made on this page require application restart to take full effect.
 *     tags:
 *       - Navigation
 *       - Setup
 *       - System
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Settings page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the application settings page
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
router.get('/settings', isAuthenticated, async (req, res) => {
  const isConfigured = await setupService.isConfigured();
  // An incomplete configuration now always lands here rather than reopening the
  // setup wizard, so say why - not only in the PAPERLESS_AI_INITIAL_SETUP case.
  const showErrorCheckSettings = !isConfigured;
  const config = settingsService.pageConfig(
    'page',
    process.env,
    isConfigured ? await setupService.loadConfig() : null,
    configFile.PAPERLESS_AI_VERSION
  );

  // Debug-output
  console.log('Current config TAGS:', config.TAGS);
  console.log('Current config IGNORE_TAGS:', config.IGNORE_TAGS);
  console.log('Current config PROMPT_TAGS:', config.PROMPT_TAGS);

  // The keys the container pins. Their fields render locked; the value
  // shown is the one in effect. The AI options are listed too, since not
  // every one of them has a slot in the config object above.
  const lockedEnvKeys = [
    ...new Set([
      ...Object.keys(config),
      ...aiProviderRules.AI_OPTIONS.map((option) => option.key),
    ]),
  ].filter((key) => configFile.isProtectedRuntimeEnvKey(key));

  const configuredSecrets = {};
  settingsCatalog.secretKeys().forEach((key) => {
    configuredSecrets[key] = Boolean(config[key]);
    config[key] = '';
  });

  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  const aiProviderPresets = await loadAiProviderPresets();
  let mfaSettings = {
    available: false,
    username: '',
    enabled: false,
  };

  const settingsUsername = getAuthenticatedSettingsUsername(req);
  if (settingsUsername) {
    try {
      const settingsUser = await documentModel.getUser(settingsUsername);
      if (settingsUser) {
        mfaSettings = {
          available: true,
          username: settingsUser.username,
          enabled: isMfaEnabledForUser(settingsUser),
        };
      }
    } catch (mfaContextError) {
      console.error(
        '[WARN] Failed to resolve MFA settings context:',
        mfaContextError
      );
    }
  }

  res.render('settings', {
    version,
    config,
    configuredSecrets,
    lockedEnvKeys,
    // The process's boot id; the page compares /health against it to tell
    // the restarted server from the one it saved to.
    bootId: BOOT_IDENTITY.bootId,
    aiProviderPresets,
    anthropicOptions: getAnthropicFormOptions(),
    // The AI option catalogue (labels, plain-language help, basic/advanced
    // level, which providers show each) and the keys whose change ends in a
    // restart. Both come from their single source so the view holds no list
    // of its own.
    aiOptions: aiProviderRules.AI_OPTIONS,
    aiProviders: aiProviderRules.PROVIDERS,
    restartRequiredKeys: Array.from(RESTART_REQUIRED_KEYS),
    mfaSettings,
    // Single sign-on: the callback URL as this request sees it (what to
    // register at the provider when OIDC_REDIRECT_URI is empty), and what the
    // running configuration lacks. enabled is the switch, not whether the
    // button is offered: that also needs errors to be empty.
    oidcDetectedRedirectUri: oidcService.deriveRedirectUri(req),
    oidcStatus: {
      enabled: oidcService.getSettings().enabled,
      errors: oidcService.getConfigErrors(),
    },
    changelogReleases: changelog.releases,
    // No banner for the normal case: "already configured" was shown on every
    // visit to a configured instance, i.e. always, and said nothing.
    success: undefined,
    settingsError: showErrorCheckSettings
      ? 'Please check your settings. Something is not working correctly.'
      : undefined,
  });
});

/**
 * @swagger
 * /api/settings/api-key:
 *   get:
 *     summary: Get current application API key
 *     description: |
 *       Returns the currently active application API key for authenticated users.
 *       The key is intentionally fetched on-demand and is not embedded in server-rendered HTML.
 *     tags:
 *       - System
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current API key returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 configured:
 *                   type: boolean
 *                   description: Indicates whether an API key is currently configured
 *                   example: true
 *                 apiKey:
 *                   type: string
 *                   nullable: true
 *                   description: Current API key value when configured
 *                   example: "3f7a8d6e2c1b5a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5"
 *       401:
 *         description: Unauthorized - authentication required
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
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
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
 *                   example: "Failed to load API key"
 */
router.get('/api/settings/api-key', isAuthenticated, async (req, res) => {
  try {
    const apiKey = configFile.getApiKey
      ? configFile.getApiKey()
      : process.env.API_KEY || process.env.PAPERLESS_AI_API_KEY || '';
    return res.json({
      success: true,
      configured: Boolean(apiKey),
      apiKey: apiKey || null,
    });
  } catch (error) {
    console.error('[ERROR] GET /api/settings/api-key:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to load API key' });
  }
});

router.get(
  '/api/settings/paperless-public-url',
  isAuthenticated,
  async (req, res) => {
    try {
      const details = await paperlessService.getPublicBaseUrlDetails({
        forceRefresh: true,
      });
      return res.json({
        success: true,
        publicUrl: details.url,
        source: details.source,
      });
    } catch (error) {
      console.error('[ERROR] GET /api/settings/paperless-public-url:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to detect Paperless public URL',
      });
    }
  }
);

/**
 * @swagger
 * /settings:
 *   post:
 *     summary: Update application settings
 *     description: |
 *       Updates the configuration settings of the Zettelrobbe application after initial setup.
 *       This endpoint allows administrators to modify connections to Paperless-ngx,
 *       AI provider settings, processing parameters, and feature toggles.
 *
 *       Changes made through this endpoint are applied immediately and affect all future
 *       document processing operations.
 *     tags:
 *       - System
 *       - Setup
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paperlessUrl:
 *                 type: string
 *                 description: URL of the Paperless-ngx instance
 *                 example: "https://paperless.example.com"
 *               paperlessToken:
 *                 type: string
 *                 description: API token for Paperless-ngx access
 *                 example: "abc123def456"
 *               paperlessUsername:
 *                 type: string
 *                 description: Username for Paperless-ngx (alternative to token authentication)
 *                 example: "admin"
 *               aiProvider:
 *                 type: string
 *                 description: Selected AI provider for document analysis
 *                 enum: ["openai", "ollama", "custom", "azure", "anthropic"]
 *                 example: "openai"
 *               openaiKey:
 *                 type: string
 *                 description: API key for OpenAI (required when aiProvider is 'openai')
 *                 example: "sk-abc123def456"
 *               openaiModel:
 *                 type: string
 *                 description: OpenAI model to use for analysis
 *                 example: "gpt-4"
 *               ollamaUrl:
 *                 type: string
 *                 description: URL for Ollama API (required when aiProvider is 'ollama')
 *                 example: "http://localhost:11434"
 *               ollamaApiKey:
 *                 type: string
 *                 description: Optional bearer token for Ollama endpoints that require authentication (leave empty to keep the configured value)
 *                 example: "ollama-abc123"
 *               ollamaModel:
 *                 type: string
 *                 description: Ollama model to use for analysis
 *                 example: "llama2"
 *               customApiKey:
 *                 type: string
 *                 description: API key for custom LLM provider
 *                 example: "api-key-123"
 *               customBaseUrl:
 *                 type: string
 *                 description: Base URL for custom LLM provider
 *                 example: "https://api.customllm.com"
 *               customModel:
 *                 type: string
 *                 description: Model name for custom LLM provider
 *                 example: "custom-model"
 *               anthropicApiKey:
 *                 type: string
 *                 description: API key for Anthropic (required when aiProvider is 'anthropic' and none is stored; leave empty to keep the configured value). Saved only with aiProvider 'anthropic'; the anthropic* fields below likewise.
 *                 example: "sk-ant-api03-abc123"
 *               anthropicModel:
 *                 type: string
 *                 description: Claude model for analysis; empty keeps the configured one
 *                 example: "claude-sonnet-5-5"
 *               anthropicEffort:
 *                 type: string
 *                 description: Effort level; empty leaves it to the model. Rejected with 400 when it is not one of the listed levels.
 *                 enum: ["", "low", "medium", "high", "xhigh", "max"]
 *                 example: ""
 *               anthropicMaxTokens:
 *                 type: integer
 *                 minimum: 1
 *                 description: Completion cap per request, thinking included. Rejected with 400 when it is not a positive whole number; empty keeps the configured value.
 *                 example: 16000
 *               anthropicStructuredOutput:
 *                 type: string
 *                 description: Constrain the analysis answer to a JSON schema (yes/no)
 *                 enum: ["yes", "no"]
 *                 example: "yes"
 *               anthropicPromptCaching:
 *                 type: string
 *                 description: Mark the system prompt cacheable (yes/no)
 *                 enum: ["yes", "no"]
 *                 example: "yes"
 *               anthropicApiUrl:
 *                 type: string
 *                 description: Only for a proxy; empty uses api.anthropic.com
 *                 example: ""
 *               scanInterval:
 *                 type: number
 *                 description: Interval in minutes for scanning new documents
 *                 example: 15
 *               reconciliationEnabled:
 *                 type: string
 *                 description: Enable automatic history reconciliation (yes/no)
 *                 example: "yes"
 *               reconciliationInterval:
 *                 type: string
 *                 description: Cron expression for the reconciliation schedule
 *                 example: "0 * * * *"
 *               systemPrompt:
 *                 type: string
 *                 description: Custom system prompt for document analysis
 *                 example: "Extract key information from the following document..."
 *               showTags:
 *                 type: boolean
 *                 description: Whether to show tags in the UI
 *                 example: true
 *               tokenLimit:
 *                 type: integer
 *                 description: The maximum number of tokens th AI can handle
 *                 example: 128000
 *               responseTokens:
 *                 type: integer
 *                 minimum: 1
 *                 description: Tokens a provider may spend on its answer. Reserved in the context window and sent as the generation limit (num_predict for Ollama, max_tokens elsewhere). Rejected with 400 when it is not a positive whole number.
 *                 example: 1000
 *               aiTemperatureAnalysis:
 *                 type: number
 *                 description: Temperature for analysis/classification calls (range 0.0-2.0)
 *                 example: 0.3
 *               aiTemperatureGeneration:
 *                 type: number
 *                 description: Temperature for generation calls (range 0.0-2.0)
 *                 example: 0.7
 *               tags:
 *                 type: string
 *                 description: Comma-separated list of tags to use for filtering
 *                 example: "Invoice,Receipt,Contract"
 *               removeInboxTagsAfterProcessing:
 *                 type: string
 *                 enum: ["yes", "no"]
 *                 description: Take every tag Paperless-ngx marks as inbox tag off a document once its analysis was written back (yes/no). Default no.
 *                 example: "yes"
 *               removeTags:
 *                 type: string
 *                 description: Comma-separated tag names taken off a document after a successful analysis, matched case-insensitively, whatever the analysis proposed. Default empty.
 *                 example: "todo,scan"
 *               aiProcessedTag:
 *                 type: boolean
 *                 description: Whether to add a tag for AI-processed documents
 *                 example: true
 *               aiTagName:
 *                 type: string
 *                 description: Tag name to use for AI-processed documents
 *                 example: "AI-Processed"
 *               usePromptTags:
 *                 type: boolean
 *                 description: Whether to use tags in prompts
 *                 example: true
 *               promptTags:
 *                 type: string
 *                 description: Comma-separated list of tags to use in prompts
 *                 example: "Invoice,Receipt"
 *               useExistingData:
 *                 type: boolean
 *                 description: Whether to use existing data from a previous setup
 *                 example: false
 *               activateTagging:
 *                 type: boolean
 *                 description: Enable AI-based tag suggestions
 *                 example: true
 *               activateCorrespondents:
 *                 type: boolean
 *                 description: Enable AI-based correspondent suggestions
 *                 example: true
 *               activateDocumentType:
 *                 type: boolean
 *                 description: Enable AI-based document type suggestions
 *                 example: true
 *               activateTitle:
 *                 type: boolean
 *                 description: Enable AI-based title suggestions
 *                 example: true
 *               activateCustomFields:
 *                 type: boolean
 *                 description: Enable AI-based custom field extraction
 *                 example: false
 *               customFields:
 *                 type: string
 *                 description: JSON string defining custom fields to extract
 *                 example: '{"invoice_number":{"type":"string"},"total_amount":{"type":"number"}}'
 *               disableAutomaticProcessing:
 *                 type: boolean
 *                 description: Disable automatic document processing
 *                 example: false
 *               duplicatesAiReview:
 *                 type: string
 *                 enum: ["yes", "no"]
 *                 description: Offer the AI review on the Duplicates page (yes/no). Default yes. Scanning and merging work without it.
 *                 example: "yes"
 *               duplicatesAiModel:
 *                 type: string
 *                 description: Model of the configured provider used only for judging duplicates. Empty means the provider's configured model.
 *                 example: ""
 *               duplicatesAiReviewBatchSize:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 100
 *                 description: Name pairs per model request (1-100, default 25). Out-of-range values are clamped, a non-numeric value keeps the current setting.
 *                 example: 25
 *               duplicatesAiCandidateFloor:
 *                 type: number
 *                 minimum: 0.5
 *                 maximum: 0.95
 *                 description: Lowest matcher score a pair needs to be shown to the model (0.50-0.95, default 0.6). Out-of-range values are clamped, a non-numeric value keeps the current setting.
 *                 example: 0.6
 *               duplicatesAiExcerpts:
 *                 type: string
 *                 enum: ["yes", "no"]
 *                 description: Send document excerpts for pairs the matcher linked by spelling alone (yes/no). Default yes.
 *                 example: "yes"
 *               duplicatesAiExcerptChars:
 *                 type: integer
 *                 minimum: 50
 *                 maximum: 500
 *                 description: Excerpt length in characters (50-500, default 300). Out-of-range values are clamped, a non-numeric value keeps the current setting.
 *                 example: 300
 *               duplicatesAiExcerptDocuments:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *                 description: Documents sampled per tag or correspondent for those excerpts (1-5, default 2). Out-of-range values are clamped, a non-numeric value keeps the current setting.
 *                 example: 2
 *               duplicatesAiTokenBudget:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 10000000
 *                 description: The most one AI review may spend across all its requests, prompt and completion (0-10000000, default 200000). When it is reached the review stops itself and keeps the verdicts it has; 0 means no limit. Out-of-range values are clamped, a non-numeric value keeps the current setting.
 *                 example: 200000
 *               duplicatesAiIdleStopSeconds:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 3600
 *                 description: A running review that no page has been watching for this many seconds stops itself, so a closed tab cannot leave the model running (0-3600, default 60). 0 means never. Out-of-range values are clamped, a non-numeric value keeps the current setting.
 *                 example: 60
 *               duplicatesAiThinking:
 *                 type: string
 *                 enum: ["yes", "no"]
 *                 description: Let the judge reason before it answers (yes/no). Default no; a reasoning model otherwise spends the whole answer budget on its thoughts before the first verdict.
 *                 example: "no"
 *               duplicatesAiRequestSeconds:
 *                 type: integer
 *                 minimum: 5
 *                 maximum: 300
 *                 description: How long one model request should take (5-300 seconds, default 30). The judge measures the model on a small first request and then sizes every later one to fit. Out-of-range values are clamped, a non-numeric value keeps the current setting.
 *                 example: 30
 *               duplicatesAiConcurrency:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 8
 *                 description: >-
 *                   Model requests the judge keeps in flight at once (0-8, default 0).
 *                   0 lets the judge choose: one for Ollama, three for a hosted
 *                   endpoint. Wall time divides by it, tokens do not. Out-of-range
 *                   values are clamped, a non-numeric value keeps the current setting.
 *                 example: 0
 *               duplicatesAiVerdictMemoryDays:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 365
 *                 description: How long a verdict about a pair of names is remembered (0-365 days, default 90). A pair the model judged is not asked again while both names are unchanged; 0 switches the memory off. Out-of-range values are clamped, a non-numeric value keeps the current setting.
 *                 example: 90
 *               duplicatesGuardNewNames:
 *                 type: string
 *                 enum: ["yes", "no"]
 *                 description: Reuse an existing tag or correspondent when document analysis proposes the same name in another spelling (yes/no). Default yes; the mapping is listed on the Duplicates page.
 *                 example: "yes"
 *               duplicatesAiSweepNames:
 *                 type: integer
 *                 minimum: 50
 *                 maximum: 1000
 *                 description: How many names the model sees per request when the semantic sweep looks at the whole list (50-1000, default 300). Out-of-range values are clamped, a non-numeric value keeps the current setting.
 *                 example: 300
 *               simplifyTagsPerRequest:
 *                 type: integer
 *                 minimum: 10
 *                 maximum: 200
 *                 description: How many tag names one model request of "Simplify tags" decomposes into a document type and topic tags (10-200, default 50). Out-of-range values are clamped, a non-numeric value keeps the current setting.
 *                 example: 50
 *               simplifyVocabularySize:
 *                 type: integer
 *                 minimum: 5
 *                 maximum: 100
 *                 description: How many entries the vocabulary proposed from the tag names should aim at, types and topics together (5-100, default 25). Out-of-range values are clamped, a non-numeric value keeps the current setting.
 *                 example: 25
 *               ocrProvider:
 *                 type: string
 *                 description: OCR fallback provider. For anthropic (Claude OCR) an empty ocrApiKey uses the Anthropic AI key, and ocrApiUrl is an optional proxy URL; a key or URL stored for another provider is cleared when switching to it.
 *                 enum: ["mistral", "custom", "ollama", "anthropic"]
 *                 example: "mistral"
 *               ocrAutoProcessEnabled:
 *                 type: string
 *                 description: Process queued OCR documents automatically (yes/no)
 *                 example: "no"
 *               ocrAutoProcessInterval:
 *                 type: string
 *                 description: Cron expression for the automatic OCR queue schedule
 *                 example: "0,15,30,45 * * * *"
 *               ocrAutoProcessBatchSize:
 *                 type: integer
 *                 description: Maximum queued documents handled per automatic OCR run (1-100)
 *                 example: 10
 *               ocrAutoAnalyze:
 *                 type: string
 *                 description: Run AI analysis directly after automatic OCR (yes/no)
 *                 example: "yes"
 *               dateFormat:
 *                 type: string
 *                 description: How every date in the web interface is rendered
 *                 enum: ["DD.MM.YYYY", "YYYY-MM-DD"]
 *                 example: "DD.MM.YYYY"
 *               oidcEnabled:
 *                 type: string
 *                 description: |
 *                   Single sign-on switch (OIDC_ENABLED). Every oidc* field is optional; one the body
 *                   leaves out keeps the stored value. When single sign-on ends up switched on, the save
 *                   is refused with 400 unless the issuer URL is an http(s) URL, the client ID is set,
 *                   the admin e-mail is valid, the redirect URI is empty or an absolute http(s) URL, and
 *                   the auth method, button icon and colours are valid. Values injected by the container
 *                   are never overwritten.
 *                 enum: ["yes", "no"]
 *                 example: "no"
 *               oidcIssuerUrl:
 *                 type: string
 *                 description: Issuer URL of the OpenID Connect provider (OIDC_ISSUER_URL); a pasted discovery URL is accepted
 *                 example: "https://auth.example.com/application/o/zettelrobbe/"
 *               oidcClientId:
 *                 type: string
 *                 description: Client ID registered at the provider (OIDC_CLIENT_ID)
 *                 example: "zettelrobbe"
 *               oidcClientSecret:
 *                 type: string
 *                 description: Client secret (OIDC_CLIENT_SECRET); leave empty to keep the stored one
 *                 example: ""
 *               oidcAdminEmail:
 *                 type: string
 *                 description: E-mail address of the identity that signs in as the administrator (OIDC_ADMIN_EMAIL)
 *                 example: "admin@example.com"
 *               oidcRedirectUri:
 *                 type: string
 *                 description: Callback URL registered at the provider (OIDC_REDIRECT_URI); empty derives it from the request
 *                 example: ""
 *               oidcScopes:
 *                 type: string
 *                 description: Space-separated scopes (OIDC_SCOPES); openid is always added
 *                 example: "openid profile email"
 *               oidcEmailClaim:
 *                 type: string
 *                 description: Claim that carries the e-mail address (OIDC_EMAIL_CLAIM)
 *                 example: "email"
 *               oidcAllowUnverifiedEmail:
 *                 type: string
 *                 description: Accept an e-mail address the provider marks unverified (OIDC_ALLOW_UNVERIFIED_EMAIL)
 *                 enum: ["yes", "no"]
 *                 example: "no"
 *               oidcTokenAuthMethod:
 *                 type: string
 *                 description: Token endpoint auth method (OIDC_TOKEN_AUTH_METHOD); empty picks it automatically
 *                 enum: ["", "client_secret_basic", "client_secret_post", "none"]
 *                 example: ""
 *               oidcButtonText:
 *                 type: string
 *                 maxLength: 60
 *                 description: Label of the login button (OIDC_BUTTON_TEXT); longer text is cut to 60 characters
 *                 example: "Sign in with Authentik"
 *               oidcButtonIcon:
 *                 type: string
 *                 description: Login button icon (OIDC_BUTTON_ICON); empty for the built-in icon, "none", an https URL or a path on this server
 *                 example: ""
 *               oidcButtonColor:
 *                 type: string
 *                 description: Login button background (OIDC_BUTTON_COLOR); hex, colour name, rgb() or hsl()
 *                 example: "#fd4b2d"
 *               oidcButtonTextColor:
 *                 type: string
 *                 description: Login button text colour (OIDC_BUTTON_TEXT_COLOR)
 *                 example: "#ffffff"
 *     responses:
 *       200:
 *         description: |
 *           Settings saved. Most values apply at once. When a saved value is
 *           one the process only reads at boot (the port, a cron schedule, the
 *           Paperless-ngx connection, ...), `restart` is true, `restartKeys`
 *           names those keys and the process exits five seconds later so the
 *           container restarts it. Poll `GET /health` until its `bootId`
 *           changes to know the new process is up.
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
 *                   example: "Settings saved. The changes are in effect."
 *                 restart:
 *                   type: boolean
 *                   description: Whether the server restarts to apply the save
 *                   example: false
 *                 restartKeys:
 *                   type: array
 *                   description: The changed keys that need the restart; empty when restart is false
 *                   items:
 *                     type: string
 *                   example: []
 *       400:
 *         description: |
 *           Invalid configuration parameters, or a custom field added or changed in
 *           this request whose name Paperless-ngx already has with another data type.
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
 *                   example: 'Custom field "Notes" exists in Paperless-ngx with the type "string", not "longtext". Remove it and add it again with the type Paperless-ngx has, or use another name.'
 *       500:
 *         description: Server error while updating settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: ["error"]
 *                   example: "error"
 *                 message:
 *                   type: string
 *                   example: "Failed to update settings: Database error"
 */
router.post('/settings', isAuthenticated, express.json(), async (req, res) => {
  try {
    const body = req.body;
    // The values in effect: what the form's empty fields fall back to.
    const current = settingsService.currentSettings(process.env);

    // OCR provider and key come first. Saving deliberately runs no live OCR
    // test; the "Test OCR Connection" button (/api/settings/ocr/test) does.
    const ocr = settingsService.resolveOcrSettings(body, current);
    if (ocr.error) {
      return res.status(400).json({ error: ocr.error });
    }

    // A custom field Paperless-ngx already has under another type is refused
    // when it is new here, and only warned about when it was configured.
    const customFields = settingsService.parseCustomFields(body.customFields);
    if (customFields.parseError) {
      console.error('Error processing custom fields:', customFields.parseError);
    }
    const conflictCheck = settingsService.checkCustomFieldConflicts(
      await paperlessService.findCustomFieldTypeConflicts(customFields.fields),
      current.CUSTOM_FIELDS
    );
    conflictCheck.warnings.forEach((warning) => console.warn(warning));
    if (conflictCheck.error) {
      return res
        .status(400)
        .json({ success: false, error: conflictCheck.error });
    }

    // A new Paperless-ngx URL or a typed token is tested before it is saved.
    const paperless = settingsService.resolvePaperlessConnection(body, current);
    if (
      paperless.needsValidation &&
      !(await setupService.validatePaperlessConfig(
        paperless.url,
        paperless.token
      ))
    ) {
      return res.status(400).json({
        error: 'Paperless-ngx connection failed. Please check URL and Token.',
      });
    }

    // Everything else: the AI provider (required fields only, no live test),
    // every simple field, custom fields, OCR and single sign-on.
    const result = settingsService.buildSettingsUpdate(body, current, {
      ocr,
      paperless,
      customFields: customFields.fields,
    });
    result.warnings.forEach((warning) => console.warn(warning));
    if (result.error) {
      return res.status(400).json(result.error);
    }
    const updates = result.updates;

    if (!configFile.getApiKey()) {
      console.log('Generating new API key');
      updates.API_KEY = crypto.randomBytes(64).toString('hex');
    }

    // Compared before saveConfig() writes the values onto process.env. Only a
    // changed key that something reads once at boot ends in a restart.
    const { merged, changedKeys, restartKeys } = settingsService.planSave(
      current,
      updates
    );

    // The values are validated above (and Paperless reachability when its
    // settings changed); saveConfig's own validateConfig would live-test
    // Paperless and the AI provider on every save.
    await setupService.saveConfig(merged, { skipValidation: true });

    // The tag cache keeps its lifetime once it has read it.
    if (changedKeys.includes('TAG_CACHE_TTL_SECONDS')) {
      paperlessService._cacheTTL = null;
    }
    try {
      for (const field of customFields.fields) {
        await paperlessService.createCustomFieldSafely(
          field.value,
          field.data_type,
          field.currency
        );
      }
    } catch (error) {
      console.log('[ERROR] Error creating custom fields:', error);
    }

    const restart = restartKeys.length > 0;
    res.json({
      success: true,
      message: restart
        ? 'Settings saved. The server restarts to apply them.'
        : 'Settings saved. The changes are in effect.',
      restart,
      restartKeys,
    });

    if (restart) {
      console.log(
        `[INFO] Settings saved; restarting for ${restartKeys.join(', ')}.`
      );
      restartService.requestRestart();
    }
  } catch (error) {
    console.error('Settings update error:', error);
    res.status(500).json({
      error: 'An error occurred: ' + error.message,
    });
  }
});

/**
 * @swagger
 * /api/settings/env-file:
 *   get:
 *     summary: Export the running configuration as a .env file
 *     description: >
 *       Returns the instance's configuration as .env lines, grouped by topic
 *       and covering only variables that are actually set. Intended for moving
 *       an instance or pinning its settings into docker-compose. The body
 *       contains API tokens and keys in clear text; JWT_SECRET is deliberately
 *       excluded, since a fresh instance generates its own.
 *     tags:
 *       - System
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: The configuration as .env text
 *       401:
 *         description: Not authenticated
 */
router.get('/api/settings/env-file', isAuthenticated, async (req, res) => {
  try {
    const { env, count } = settingsService.buildEnvExport();
    return res.json({
      success: true,
      data: { env, count, generatedAt: new Date().toISOString() },
    });
  } catch (error) {
    console.error('[ERROR] GET /api/settings/env-file:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to build the configuration' });
  }
});

module.exports = router;
