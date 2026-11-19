'use strict';

/**
 * Connection checks and model discovery for the AI and OCR providers, shared
 * by the setup wizard (routes/setupWizard.js, /api/setup/*) and the
 * connection tests of the settings page (routes/settingsConnections.js,
 * /api/settings/{ai,ocr,quickstart}/*). Moved verbatim from routes/setup.js.
 *
 * Exports: resolveOcrApiKey, resolveOcrApiKeyForProvider,
 * validateAiConnectionForSetup, validateOcrConnectionForSetup,
 * discoverAiModelsForSetup, discoverOcrModelsForSetup,
 * detectQuickstartForSetup.
 */

const setupService = require('./setupService.js');
const quickstartService = require('./quickstartService');
const {
  ANTHROPIC_DEFAULT_MODEL,
  isConfiguredAnthropicHost,
} = require('./anthropicSupport');

/* The key may be typed into the form, saved from an earlier save, or
   injected through the environment. Only this side can see the last two, which
   is why neither page refuses an empty field on its own. */
function resolveOcrApiKey(apiKey) {
  const normalizedApiKey = String(apiKey || '').trim();
  return (
    normalizedApiKey ||
    process.env.OCR_API_KEY ||
    process.env.MISTRAL_API_KEY ||
    ''
  );
}

/* resolveOcrApiKey() for a request that names its OCR provider. Claude OCR
   must never receive a stored Mistral key: MISTRAL_API_KEY never belongs to
   it, and OCR_API_KEY only when Claude is the OCR provider it was saved for.
   An empty answer is fine — setupService falls back to the Anthropic AI key.
   `apiUrl` is where the request goes; the stored key is withheld from any
   host that is not already configured for Claude. */
function resolveOcrApiKeyForProvider(provider, apiKey, apiUrl = '') {
  const normalizedProvider = String(provider || '')
    .trim()
    .toLowerCase();
  if (normalizedProvider !== 'anthropic') {
    return resolveOcrApiKey(apiKey);
  }

  const normalizedApiKey = String(apiKey || '').trim();
  if (normalizedApiKey) {
    return normalizedApiKey;
  }

  const storedProvider = String(process.env.OCR_PROVIDER || '')
    .trim()
    .toLowerCase();
  return storedProvider === 'anthropic' && isConfiguredAnthropicHost(apiUrl)
    ? process.env.OCR_API_KEY || ''
    : '';
}

async function validateAiConnectionForSetup({
  aiProvider,
  apiUrl,
  token,
  model,
  azureApiVersion,
  setupValidationTimeoutMs,
}) {
  return setupService.withTemporaryValidationTimeout(
    setupValidationTimeoutMs,
    async () => {
      const provider = String(aiProvider || '')
        .trim()
        .toLowerCase();
      const normalizedApiUrl = String(apiUrl || '').trim();
      const normalizedToken = String(token || '').trim();
      const normalizedModel = String(model || '').trim();

      if (
        !provider ||
        !['openai', 'ollama', 'custom', 'azure', 'anthropic'].includes(provider)
      ) {
        return {
          success: false,
          message: 'A valid AI provider is required.',
        };
      }

      if (provider === 'openai') {
        if (!normalizedToken) {
          return {
            success: false,
            message: 'An API token is required for OpenAI.',
          };
        }

        const valid = await setupService.validateOpenAIConfig(normalizedToken);
        return {
          success: valid,
          message: valid
            ? 'OpenAI credentials are valid.'
            : 'OpenAI test failed. Check token and network access.',
        };
      }

      if (provider === 'ollama') {
        if (!normalizedModel) {
          return {
            success: false,
            message: 'Model is required for Ollama.',
          };
        }

        const detection = await setupService.detectAiApiUrlForSetup({
          provider,
          apiUrl: normalizedApiUrl,
          apiKey: normalizedToken,
        });
        const resolvedApiUrl = String(
          detection?.resolvedApiUrl || normalizedApiUrl || ''
        ).trim();

        const valid =
          detection?.mode === 'openai'
            ? await setupService.validateCustomConfig(
                resolvedApiUrl,
                normalizedToken,
                normalizedModel
              )
            : await setupService.validateOllamaConfig(
                resolvedApiUrl,
                normalizedModel,
                normalizedToken
              );

        return {
          success: valid,
          resolvedApiUrl,
          message: valid
            ? 'Ollama connection is valid.'
            : 'Ollama test failed. Check URL and model.',
        };
      }

      if (provider === 'azure') {
        if (!normalizedApiUrl || !normalizedToken || !normalizedModel) {
          return {
            success: false,
            message:
              'Endpoint, token, and deployment/model are required for Azure.',
          };
        }

        const valid = await setupService.validateAzureConfig(
          normalizedToken,
          normalizedApiUrl,
          normalizedModel,
          azureApiVersion || '2023-05-15'
        );

        return {
          success: valid,
          message: valid
            ? 'Azure connection is valid.'
            : 'Azure test failed. Check endpoint, token, deployment, and API version.',
        };
      }

      if (provider === 'anthropic') {
        if (!normalizedToken) {
          return {
            success: false,
            message: 'An API key is required for Anthropic.',
          };
        }

        // The URL stays optional: empty means api.anthropic.com.
        const valid = await setupService.validateAnthropicConfig(
          normalizedToken,
          normalizedModel || ANTHROPIC_DEFAULT_MODEL,
          normalizedApiUrl
        );

        return {
          success: valid,
          message: valid
            ? 'Anthropic API key and model are valid.'
            : 'Anthropic test failed. Check the API key, the model and, if set, the proxy URL.',
        };
      }

      if (!normalizedApiUrl || !normalizedModel) {
        return {
          success: false,
          message: 'API URL and model are required for custom providers.',
        };
      }

      const detection = await setupService.detectAiApiUrlForSetup({
        provider,
        apiUrl: normalizedApiUrl,
        apiKey: normalizedToken,
      });
      const resolvedApiUrl = String(
        detection?.resolvedApiUrl || normalizedApiUrl
      ).trim();
      const valid =
        detection?.mode === 'ollama'
          ? await setupService.validateOllamaConfig(
              resolvedApiUrl,
              normalizedModel,
              normalizedToken
            )
          : await setupService.validateCustomConfig(
              resolvedApiUrl,
              normalizedToken,
              normalizedModel
            );

      return {
        success: valid,
        resolvedApiUrl,
        message: valid
          ? 'Custom provider connection is valid.'
          : 'Custom provider test failed. Check URL, optional token, and model.',
      };
    }
  );
}

async function validateOcrConnectionForSetup({
  enabled,
  provider,
  apiUrl,
  apiKey,
  model,
  setupOcrValidationTimeoutMs,
  anthropicApiKey,
  anthropicApiUrl,
  anthropicModel,
}) {
  return setupService.withTemporaryValidationTimeout(
    setupOcrValidationTimeoutMs,
    async () => {
      // Correctly handles both boolean (true/false) and string ('yes'/'no') values.
      // Using a truthy check on a string would misinterpret 'no' as enabled.
      const normalizedEnabled =
        enabled === true ||
        String(enabled ?? '')
          .trim()
          .toLowerCase() === 'yes'
          ? 'yes'
          : 'no';
      if (normalizedEnabled !== 'yes') {
        return {
          success: true,
          message: 'OCR fallback is disabled.',
        };
      }

      const normalizedProviderInput = String(provider || 'mistral')
        .trim()
        .toLowerCase();
      const normalizedProvider =
        normalizedProviderInput === 'custom'
          ? 'ollama'
          : normalizedProviderInput;
      const detection = await setupService.detectOcrApiUrlForSetup({
        provider: normalizedProvider,
        apiUrl: String(apiUrl || '').trim(),
        apiKey: String(apiKey || '').trim(),
      });
      const resolvedApiUrl = String(
        detection?.resolvedApiUrl || apiUrl || ''
      ).trim();

      const valid = await setupService.validateOcrConfig({
        enabled: normalizedEnabled,
        provider: normalizedProvider,
        apiUrl: resolvedApiUrl,
        apiKey: String(apiKey || '').trim(),
        // Claude OCR picks its own model when this one is not a Claude model
        // (see setupService.resolveAnthropicOcrModel), so the Mistral default
        // must not be filled in for it.
        model:
          String(model || '').trim() ||
          (normalizedProvider === 'anthropic' ? '' : 'mistral-ocr-latest'),
        // The Anthropic AI provider's key, URL and model, which Claude OCR
        // falls back to; the environment covers them when they are saved.
        anthropicApiKey,
        anthropicApiUrl,
        anthropicModel,
      });

      return {
        success: valid,
        resolvedApiUrl,
        message: valid
          ? 'OCR connection is valid.'
          : 'OCR connection test failed. Check OCR provider, OCR API URL, API key and model.',
      };
    }
  );
}

/* The model-discovery answer for Anthropic. The list is never empty — it
   falls back to the suggested models — so the message has to say which list
   the picker now shows, or a refused key would look like a working one. */
function describeAnthropicModelDiscovery(discovery, apiUrl) {
  return {
    success: true,
    models: discovery.models,
    live: discovery.live,
    resolvedApiUrl: apiUrl,
    message: discovery.live
      ? `Discovered ${discovery.models.length} model(s).`
      : `Could not load the live model list (${discovery.error}). Showing the suggested Claude models instead.`,
  };
}

async function discoverAiModelsForSetup({
  aiProvider,
  apiUrl,
  token,
  setupValidationTimeoutMs,
}) {
  return setupService.withTemporaryValidationTimeout(
    setupValidationTimeoutMs,
    async () => {
      const provider = String(aiProvider || '')
        .trim()
        .toLowerCase();
      const normalizedApiUrl = String(apiUrl || '').trim();
      const normalizedToken = String(token || '').trim();

      if (provider === 'anthropic') {
        return describeAnthropicModelDiscovery(
          await setupService.discoverAnthropicModels({
            apiKey: normalizedToken,
            apiUrl: normalizedApiUrl,
          }),
          normalizedApiUrl
        );
      }

      // For local providers, classify models via quickstart detection so
      // embedding-only models are excluded from the AI model dropdown.
      if (['custom', 'ollama'].includes(provider) && normalizedApiUrl) {
        try {
          const classification = await quickstartService.detectAndClassify({
            baseUrl: normalizedApiUrl,
            apiKey: normalizedToken,
          });

          if (classification.textModels.length > 0) {
            const excludedCount =
              classification.models.length - classification.textModels.length;
            return {
              success: true,
              models: classification.textModels,
              resolvedApiUrl: classification.resolvedAiApiUrl,
              message:
                excludedCount > 0
                  ? `Discovered ${classification.textModels.length} model(s) (${excludedCount} embedding-only model(s) excluded).`
                  : `Discovered ${classification.textModels.length} model(s).`,
            };
          }
        } catch {
          // Classification probe failed; fall through to the legacy unfiltered
          // discovery below so existing setups keep working.
        }
      }

      const detection = await setupService.detectAiApiUrlForSetup({
        provider,
        apiUrl: normalizedApiUrl,
        apiKey: normalizedToken,
      });
      const resolvedApiUrl = String(
        detection?.resolvedApiUrl || normalizedApiUrl || ''
      ).trim();

      const models = await setupService.discoverAiModels({
        provider,
        apiUrl: resolvedApiUrl,
        apiKey: normalizedToken,
      });

      return {
        success: true,
        models,
        resolvedApiUrl,
        message:
          models.length > 0
            ? `Discovered ${models.length} model(s).`
            : 'No models discovered for this provider.',
      };
    }
  );
}

async function discoverOcrModelsForSetup({
  provider,
  apiUrl,
  apiKey,
  setupOcrValidationTimeoutMs,
  anthropicApiKey,
  anthropicApiUrl,
  anthropicModel,
}) {
  return setupService.withTemporaryValidationTimeout(
    setupOcrValidationTimeoutMs,
    async () => {
      const normalizedProvider = String(provider || 'mistral')
        .trim()
        .toLowerCase();
      const normalizedApiUrl = String(apiUrl || '').trim();
      const normalizedApiKey = String(apiKey || '').trim();

      // Claude OCR lists the same models as the AI provider, reached with the
      // OCR key or the AI key, and preselects the model OCR would run with.
      if (normalizedProvider === 'anthropic') {
        const connection = setupService.resolveAnthropicOcrConnection({
          apiKey: normalizedApiKey,
          apiUrl: normalizedApiUrl,
          anthropicApiKey,
          anthropicApiUrl,
        });
        return {
          ...describeAnthropicModelDiscovery(
            await setupService.discoverAnthropicModels(connection),
            normalizedApiUrl
          ),
          suggestedModel: setupService.resolveAnthropicOcrModel(
            '',
            anthropicModel
          ),
        };
      }

      // For local providers, classify models via quickstart detection so
      // embedding-only models are excluded from the OCR dropdown
      // (metadata-first via LM Studio /api/v0/models or Ollama /api/show,
      // heuristics otherwise).
      //
      // Vision detection is a name heuristic, so it must rank the list rather
      // than cut it: it recognizes llava, pixtral or *-vl and misses every
      // OCR-capable model with an unremarkable name — gpt-4o among them. This
      // used to return the vision subset as soon as it was non-empty, which on
      // a router serving dozens of models hid nearly all of them. Vision hits
      // are reported separately so the UI can recommend them.
      if (
        ['custom', 'ollama'].includes(normalizedProvider) &&
        normalizedApiUrl
      ) {
        try {
          const classification = await quickstartService.detectAndClassify({
            baseUrl: normalizedApiUrl,
            apiKey: normalizedApiKey,
          });

          const models = classification.textModels;
          const visionModels = classification.visionModels;
          const excludedCount = classification.models.length - models.length;
          const details = [
            visionModels.length > 0
              ? `${visionModels.length} with detected vision support`
              : null,
            excludedCount > 0
              ? `${excludedCount} embedding-only model(s) excluded`
              : null,
          ].filter(Boolean);

          return {
            success: true,
            models,
            visionModels,
            suggestedModel: classification.suggestedOcrModel || null,
            resolvedApiUrl: classification.resolvedOcrApiUrl,
            message:
              models.length > 0
                ? `Discovered ${models.length} OCR model(s)${
                    details.length > 0 ? ` (${details.join(', ')})` : ''
                  }.`
                : 'No OCR models discovered for this provider.',
          };
        } catch {
          // Classification probe failed; fall through to the legacy unfiltered
          // discovery below so existing setups keep working.
        }
      }

      const detection = await setupService.detectOcrApiUrlForSetup({
        provider: normalizedProvider,
        apiUrl: normalizedApiUrl,
        apiKey: normalizedApiKey,
      });
      const resolvedApiUrl = String(
        detection?.resolvedApiUrl || normalizedApiUrl
      ).trim();

      const models = await setupService.discoverOcrModels({
        provider: normalizedProvider,
        apiUrl: resolvedApiUrl,
        apiKey: normalizedApiKey,
      });

      return {
        success: true,
        models,
        resolvedApiUrl,
        message:
          models.length > 0
            ? `Discovered ${models.length} OCR model(s).`
            : 'No OCR models discovered for this provider.',
      };
    }
  );
}

async function detectQuickstartForSetup({
  baseUrl,
  apiKey,
  setupValidationTimeoutMs,
}) {
  return setupService.withTemporaryValidationTimeout(
    setupValidationTimeoutMs,
    async () => {
      const detection = await quickstartService.detectAndClassify({
        baseUrl: String(baseUrl || '').trim(),
        apiKey: String(apiKey || '').trim(),
      });

      return {
        success: true,
        detection,
        message: quickstartService.buildDetectionSummaryMessage(detection),
      };
    }
  );
}

module.exports = {
  resolveOcrApiKey,
  resolveOcrApiKeyForProvider,
  validateAiConnectionForSetup,
  validateOcrConnectionForSetup,
  discoverAiModelsForSetup,
  discoverOcrModelsForSetup,
  detectQuickstartForSetup,
};
