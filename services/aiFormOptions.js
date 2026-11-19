'use strict';

/**
 * What the AI provider forms offer without a request: the one provider list
 * (config/ai-provider-presets.json, or the built-in list) and the Claude
 * models and effort levels. Shared by the setup wizard, the settings page and
 * GET /api/settings/ai/presets.
 *
 * Exports: getAnthropicFormOptions, loadAiProviderPresets,
 * matchProviderChoice.
 */

const fs = require('fs').promises;
const path = require('path');
const {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_SUGGESTED_MODELS,
  ANTHROPIC_EFFORT_LEVELS,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
} = require('./anthropicSupport');
const { stripTrailingSlashes } = require('./serviceUtils');

/**
 * The one list the provider field offers. Every entry is a provider id plus
 * what to fill in for it; several entries can share the custom provider and
 * tell apart by their address. The list ends with OTHER_CHOICE, the custom
 * provider with nothing filled in.
 */
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
    // No URL: the SDK knows api.anthropic.com, and ANTHROPIC_API_URL is only
    // for a proxy in front of it.
    id: 'anthropic-default',
    label: 'Anthropic (Claude)',
    provider: 'anthropic',
    apiUrl: '',
    model: ANTHROPIC_DEFAULT_MODEL,
    tokenPlaceholder: 'sk-ant-...',
  },
  {
    id: 'azure-default',
    label: 'Azure OpenAI',
    provider: 'azure',
    apiUrl: '',
    model: '',
    tokenPlaceholder: '',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    provider: 'custom',
    apiUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    tokenPlaceholder: 'Mistral API key',
  },
  {
    id: 'ionos-openai-compatible',
    label: 'IONOS (GDPR compliant)',
    provider: 'custom',
    apiUrl: 'https://openai.inference.de-txl.ionos.com/v1',
    model: 'meta-llama/llama-3.3-70b-instruct',
    tokenPlaceholder: 'ionos-api-key',
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
    id: 'lmstudio-local',
    label: 'LM Studio',
    provider: 'custom',
    apiUrl: 'http://127.0.0.1:1234/v1',
    model: 'qwen2.5-7b-instruct',
    tokenPlaceholder: 'lm-studio-token',
  },
];

/** The custom provider with nothing filled in; always the last entry. */
const OTHER_CHOICE = Object.freeze({
  id: 'custom',
  label: 'Other OpenAI-compatible server',
  provider: 'custom',
  apiUrl: '',
  model: '',
  tokenPlaceholder: '',
});

const PROVIDER_VALUES = ['openai', 'ollama', 'custom', 'azure', 'anthropic'];

/**
 * A list a person can always choose every provider from: a file that leaves
 * a provider out gets the built-in entry for it, and a custom entry without
 * an address gives way to OTHER_CHOICE at the end.
 *
 * @param {Array<{id: string, provider: string, apiUrl: string}>} list
 */
function completeChoices(list) {
  const named = list.filter(
    (entry) => !(entry.provider === 'custom' && !entry.apiUrl)
  );
  const missing = DEFAULT_AI_PROVIDER_PRESETS.filter(
    (entry) =>
      entry.provider !== 'custom' &&
      !named.some((choice) => choice.provider === entry.provider)
  );
  return [...named, ...missing, { ...OTHER_CHOICE }];
}

/**
 * The entry a configuration stands for: the one of its provider, and for the
 * custom provider the one with its address, else OTHER_CHOICE.
 *
 * @param {Array<{id: string, provider: string, apiUrl: string}>} choices
 * @param {unknown} provider
 * @param {unknown} apiUrl
 */
function matchProviderChoice(choices, provider, apiUrl) {
  const id = String(provider || '')
    .trim()
    .toLowerCase();
  if (id !== 'custom') {
    return choices.find((entry) => entry.provider === id) || null;
  }
  const url = stripTrailingSlashes(String(apiUrl || '').trim());
  return (
    (url &&
      choices.find(
        (entry) =>
          entry.provider === 'custom' &&
          entry.apiUrl &&
          stripTrailingSlashes(entry.apiUrl) === url
      )) ||
    choices.find((entry) => entry.id === OTHER_CHOICE.id) ||
    null
  );
}

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
      return completeChoices(DEFAULT_AI_PROVIDER_PRESETS);
    }

    const presets = source
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
      .filter((item) => PROVIDER_VALUES.includes(item.provider));
    return completeChoices(presets);
  } catch (error) {
    console.warn(
      '[WARN] Could not load AI provider presets from config/ai-provider-presets.json:',
      error.message
    );
    return completeChoices(DEFAULT_AI_PROVIDER_PRESETS);
  }
}

module.exports = {
  getAnthropicFormOptions,
  loadAiProviderPresets,
  matchProviderChoice,
};
