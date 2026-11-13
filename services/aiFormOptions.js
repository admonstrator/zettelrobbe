'use strict';

/**
 * What the AI provider forms offer without a request: the provider presets
 * (config/ai-provider-presets.json, or the built-in list) and the Claude
 * models and effort levels. Shared by the setup wizard, the settings page and
 * GET /api/settings/ai/presets. Moved verbatim from routes/setup.js.
 *
 * Exports: getAnthropicFormOptions, loadAiProviderPresets.
 */

const fs = require('fs').promises;
const path = require('path');
const {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_SUGGESTED_MODELS,
  ANTHROPIC_EFFORT_LEVELS,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
} = require('./anthropicSupport');

const DEFAULT_AI_PROVIDER_PRESETS = [
  {
    id: 'openai-default',
    label: 'OpenAI',
    provider: 'openai',
    apiUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    tokenPlaceholder: 'sk-...',
  },
  {
    id: 'lmstudio-local',
    label: 'LM Studio (OpenAI compatible)',
    provider: 'custom',
    apiUrl: 'http://127.0.0.1:1234/v1',
    model: 'qwen2.5-7b-instruct',
    tokenPlaceholder: 'lm-studio-token',
  },
  {
    id: 'ollama-local',
    label: 'Ollama',
    provider: 'ollama',
    apiUrl: 'http://localhost:11434',
    model: 'llama3.2',
    tokenPlaceholder: '',
  },
  {
    id: 'ionos-openai-compatible',
    label: 'IONOS (OpenAI compatible)',
    provider: 'custom',
    apiUrl: 'https://openai.inference.de-txl.ionos.com/v1',
    model: 'meta-llama/llama-3.3-70b-instruct',
    tokenPlaceholder: 'ionos-api-key',
  },
  {
    // No URL: the SDK knows api.anthropic.com, and ANTHROPIC_API_URL is only
    // for a proxy in front of it.
    id: 'anthropic-default',
    label: 'Anthropic (Claude)',
    provider: 'anthropic',
    apiUrl: '',
    model: ANTHROPIC_DEFAULT_MODEL,
    tokenPlaceholder: 'sk-ant-...',
  },
];

/* What the setup wizard and the settings page need to offer the Claude
   models and effort levels without a request: the same constants the
   provider itself runs with. */
function getAnthropicFormOptions() {
  return {
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    suggestedModels: ANTHROPIC_SUGGESTED_MODELS.map((entry) => ({
      id: entry.id,
      label: entry.label,
    })),
    effortLevels: ANTHROPIC_EFFORT_LEVELS.slice(),
    defaultMaxTokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
  };
}

async function loadAiProviderPresets() {
  const presetsPath = path.join(
    process.cwd(),
    'config',
    'ai-provider-presets.json'
  );

  try {
    const raw = await fs.readFile(presetsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const source = Array.isArray(parsed) ? parsed : parsed?.presets;

    if (!Array.isArray(source) || source.length === 0) {
      return DEFAULT_AI_PROVIDER_PRESETS;
    }

    return source
      .map((item, index) => ({
        id: String(item.id || `preset-${index + 1}`),
        label: String(item.label || item.name || `Preset ${index + 1}`),
        provider: String(item.provider || 'custom'),
        apiUrl: String(item.apiUrl || item.baseUrl || ''),
        model: String(item.model || ''),
        tokenPlaceholder: String(
          item.tokenPlaceholder || item.apiKeyPlaceholder || ''
        ),
      }))
      .filter((item) =>
        ['openai', 'ollama', 'custom', 'azure', 'anthropic'].includes(
          item.provider
        )
      );
  } catch (error) {
    console.warn(
      '[WARN] Could not load AI provider presets from config/ai-provider-presets.json:',
      error.message
    );
    return DEFAULT_AI_PROVIDER_PRESETS;
  }
}

module.exports = { getAnthropicFormOptions, loadAiProviderPresets };
