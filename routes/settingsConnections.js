'use strict';

/**
 * Connection tests and model discovery of the settings page: AI, OCR, single
 * sign-on (OIDC) and Quickstart detection, plus the AI provider presets.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   POST  /api/settings/ai/test             Test AI provider connectivity from the settings page
 *   POST  /api/settings/ocr/test            Test OCR provider connectivity from the settings page
 *   POST  /api/settings/oidc/test           Test a single sign-on provider from the settings page
 *   POST  /api/settings/ai/models
 *   GET   /api/settings/ai/presets
 *   POST  /api/settings/ocr/models          Discover available OCR models from the settings page
 *   POST  /api/settings/quickstart/detect   Auto-detect API flavor and classify models from a single base URL
 */

const express = require('express');
const { isAuthenticated } = require('./auth.js');
const oidcService = require('../services/oidcService');
const { isConfiguredAnthropicHost } = require('../services/anthropicSupport');
const {
  resolveOcrApiKeyForProvider,
  validateAiConnectionForSetup,
  validateOcrConnectionForSetup,
  discoverAiModelsForSetup,
  discoverOcrModelsForSetup,
  detectQuickstartForSetup,
} = require('../services/connectionChecks');
const { loadAiProviderPresets } = require('../services/aiFormOptions');
const router = express.Router();

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

module.exports = router;
