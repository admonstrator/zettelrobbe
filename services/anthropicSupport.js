'use strict';

/**
 * Everything the app needs to know about the Anthropic Messages API before it
 * sends a request and after the answer arrives, kept in one place so the AI
 * provider (anthropicService) and the OCR provider (mistralOcrService) build
 * their requests and read their answers the same way.
 *
 * The Messages API is not an OpenAI dialect: the system prompt is its own
 * field, `max_tokens` is required, the answer is a list of typed blocks, usage
 * is called input/output tokens, and a model can decline with
 * `stop_reason: "refusal"`. The current models also reject sampling
 * parameters and differ in how — and whether — thinking can be switched off.
 * Those per-model rules live in `anthropicModelTraits()`; every request reads
 * them from there instead of matching model names on its own.
 *
 * Nothing here talks to the network except the client `createAnthropicClient`
 * returns.
 */

const Anthropic = require('@anthropic-ai/sdk');
const {
  assertCompletionNotTruncated,
  stripTrailingSlashes,
} = require('./serviceUtils');

/** The model a fresh installation starts with. */
const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-5-5';

/**
 * The models setup and settings offer before the live list from
 * `client.models.list()` arrives, cheapest first.
 */
const ANTHROPIC_SUGGESTED_MODELS = Object.freeze([
  Object.freeze({ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }),
  Object.freeze({ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }),
  Object.freeze({ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }),
]);

/** Every effort level the API knows, lowest first. */
const ANTHROPIC_EFFORT_LEVELS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** The completion cap used when nothing else is configured. */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;

/**
 * @typedef {object} AnthropicModelTraits
 * @property {'disabled'|'between_tools'|'omit'|null} thinkingOff
 *   How this model is asked not to think:
 *   - 'disabled': send `thinking: { type: 'disabled' }` (only at effort high
 *     or below, which is why a no-thinking request also sends effort 'low')
 *   - 'between_tools': send `thinking: { type: 'between_tools' }`, the lowest
 *     setting Claude Sonnet 5.5 has; it takes no other field
 *   - 'omit': the model only thinks when asked, so sending nothing is off
 *   - null: thinking is always on; a low effort is the only lever
 * @property {boolean} adaptive - accepts `thinking: { type: 'adaptive' }`
 * @property {ReadonlyArray<string>} effortLevels - the `output_config.effort`
 *   values this model accepts; empty when it rejects the field
 * @property {boolean} structuredOutput - accepts `output_config.format`
 * @property {number} minCacheTokens - the shortest prefix a `cache_control`
 *   marker caches; shorter ones silently do not
 */

const ALL_EFFORTS = ANTHROPIC_EFFORT_LEVELS;
const NO_XHIGH = Object.freeze(['low', 'medium', 'high', 'max']);
const BASIC_EFFORTS = Object.freeze(['low', 'medium', 'high']);
const NO_EFFORTS = Object.freeze([]);

/**
 * Model families, most specific first. The first pattern that matches wins.
 * A model newer than this table matches nothing and gets FUTURE_MODEL, which
 * is what every model released since Claude Opus 5.5 does.
 */
const MODEL_FAMILIES = [
  {
    pattern: /^claude-(?:fable|mythos)-/,
    traits: {
      thinkingOff: null,
      adaptive: true,
      effortLevels: ALL_EFFORTS,
      structuredOutput: true,
      minCacheTokens: 512,
    },
  },
  {
    pattern: /^claude-opus-5-5/,
    traits: {
      thinkingOff: null,
      adaptive: true,
      effortLevels: ALL_EFFORTS,
      structuredOutput: true,
      minCacheTokens: 512,
    },
  },
  {
    pattern: /^claude-sonnet-5-5/,
    traits: {
      thinkingOff: 'between_tools',
      adaptive: true,
      effortLevels: ALL_EFFORTS,
      structuredOutput: true,
      minCacheTokens: 512,
    },
  },
  {
    pattern: /^claude-haiku-5-5/,
    traits: {
      thinkingOff: 'disabled',
      adaptive: true,
      effortLevels: ALL_EFFORTS,
      structuredOutput: true,
      minCacheTokens: 512,
    },
  },
  {
    pattern: /^claude-opus-5(?:$|[^-.\d])/,
    traits: {
      thinkingOff: 'disabled',
      adaptive: true,
      effortLevels: ALL_EFFORTS,
      structuredOutput: true,
      minCacheTokens: 512,
    },
  },
  {
    pattern: /^claude-sonnet-5(?:$|[^-.\d])/,
    traits: {
      thinkingOff: 'disabled',
      adaptive: true,
      effortLevels: ALL_EFFORTS,
      structuredOutput: true,
      minCacheTokens: 1024,
    },
  },
  {
    pattern: /^claude-opus-4-8/,
    traits: {
      thinkingOff: 'omit',
      adaptive: true,
      effortLevels: ALL_EFFORTS,
      structuredOutput: true,
      minCacheTokens: 1024,
    },
  },
  {
    pattern: /^claude-opus-4-7/,
    traits: {
      thinkingOff: 'omit',
      adaptive: true,
      effortLevels: ALL_EFFORTS,
      structuredOutput: false,
      minCacheTokens: 2048,
    },
  },
  {
    pattern: /^claude-opus-4-6/,
    traits: {
      thinkingOff: 'omit',
      adaptive: true,
      effortLevels: NO_XHIGH,
      structuredOutput: false,
      minCacheTokens: 4096,
    },
  },
  {
    pattern: /^claude-sonnet-4-6/,
    traits: {
      thinkingOff: 'omit',
      adaptive: true,
      effortLevels: NO_XHIGH,
      structuredOutput: false,
      minCacheTokens: 1024,
    },
  },
  {
    pattern: /^claude-opus-4-5/,
    traits: {
      thinkingOff: 'omit',
      adaptive: false,
      effortLevels: BASIC_EFFORTS,
      structuredOutput: true,
      minCacheTokens: 4096,
    },
  },
  {
    pattern: /^claude-haiku-4-5/,
    traits: {
      thinkingOff: 'omit',
      adaptive: false,
      effortLevels: NO_EFFORTS,
      structuredOutput: true,
      minCacheTokens: 4096,
    },
  },
  {
    // Sonnet 4.5, Opus 4.1 and everything older: no adaptive thinking, no
    // effort, and thinking only with a budget this app never sends.
    pattern: /^claude-(?:sonnet-4|opus-4|3)/,
    traits: {
      thinkingOff: 'omit',
      adaptive: false,
      effortLevels: NO_EFFORTS,
      structuredOutput: false,
      minCacheTokens: 1024,
    },
  },
];

const FUTURE_MODEL = Object.freeze({
  thinkingOff: null,
  adaptive: true,
  effortLevels: ALL_EFFORTS,
  structuredOutput: true,
  minCacheTokens: 1024,
});

/**
 * The model name as the table reads it: trimmed and lower-cased.
 *
 * @param {unknown} model
 * @returns {string}
 */
function normalizeAnthropicModel(model) {
  return String(model ?? '')
    .trim()
    .toLowerCase();
}

/**
 * What a request to this model may and must contain. See AnthropicModelTraits.
 *
 * @param {unknown} model
 * @returns {AnthropicModelTraits}
 */
function anthropicModelTraits(model) {
  const name = normalizeAnthropicModel(model);
  const family = MODEL_FAMILIES.find((entry) => entry.pattern.test(name));
  return Object.freeze({ ...(family ? family.traits : FUTURE_MODEL) });
}

/**
 * A configured effort level, or null when it names none the API knows.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeAnthropicEffort(value) {
  const level = String(value ?? '')
    .trim()
    .toLowerCase();
  return ANTHROPIC_EFFORT_LEVELS.includes(level) ? level : null;
}

/**
 * The thinking-related fields of a Messages request, to spread into it.
 *
 * `reasoning` is the wish `generateText` callers express (see
 * reasoningEnabled() in aiGenerateOptions): false asks for as little thinking
 * as the model allows, true for thinking where the model only thinks when
 * asked, null for whatever the model does by default. `effort` is the
 * operator's ANTHROPIC_EFFORT; a no-thinking wish overrides it with 'low'.
 *
 * Never returns `temperature`: the current models reject it, and the
 * analysis prompt does not depend on it.
 *
 * @param {unknown} model
 * @param {{reasoning?: boolean|null, effort?: unknown}} [wish]
 * @returns {{thinking?: object, output_config?: {effort: string}}}
 */
function anthropicThinkingParams(model, wish = {}) {
  const traits = anthropicModelTraits(model);
  const reasoning = typeof wish.reasoning === 'boolean' ? wish.reasoning : null;
  const params = {};

  let effort = normalizeAnthropicEffort(wish.effort);
  if (reasoning === false) effort = 'low';

  if (reasoning === false) {
    if (traits.thinkingOff === 'disabled') {
      params.thinking = { type: 'disabled' };
    } else if (traits.thinkingOff === 'between_tools') {
      params.thinking = { type: 'between_tools' };
    }
  } else if (reasoning === true && traits.thinkingOff === 'omit') {
    if (traits.adaptive) params.thinking = { type: 'adaptive' };
  }

  if (effort && traits.effortLevels.includes(effort)) {
    params.output_config = { effort };
  }
  return params;
}

/**
 * The completion cap for one request: the caller's, else the configured one,
 * else ANTHROPIC_DEFAULT_MAX_TOKENS. Thinking counts toward it, so it is
 * never derived from RESPONSE_TOKENS alone, which is sized for a JSON answer
 * without any.
 *
 * @param {unknown} requested - a caller's cap, ignored unless a positive number
 * @param {unknown} configured - ANTHROPIC_MAX_TOKENS
 * @returns {number}
 */
function anthropicMaxTokens(requested, configured) {
  const pick = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : null;
  return (
    pick(requested) ?? pick(Number(configured)) ?? ANTHROPIC_DEFAULT_MAX_TOKENS
  );
}

/**
 * A client for the Claude API. `apiUrl` is only for a proxy in front of it;
 * empty means api.anthropic.com.
 *
 * @param {{apiKey: string, apiUrl?: string, timeoutMs?: number}} options
 * @returns {Anthropic}
 */
function createAnthropicClient({ apiKey, apiUrl = '', timeoutMs } = {}) {
  const clientOptions = {
    apiKey: null,
    defaultHeaders: { 'x-api-key': String(apiKey || '') },
  };
  const baseURL = stripTrailingSlashes(String(apiUrl || '').trim());
  if (baseURL) clientOptions.baseURL = baseURL;
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    clientOptions.timeout = timeoutMs;
  }
  return new Anthropic(clientOptions);
}

/** Where a client goes when no proxy URL is set. */
const ANTHROPIC_DEFAULT_ORIGIN = 'https://api.anthropic.com';

/**
 * Whether a request targets a Claude endpoint this installation already uses:
 * ANTHROPIC_API_URL (empty means api.anthropic.com), or OCR_API_URL while
 * Claude is the OCR provider. A stored key is only substituted for an empty
 * key field when this holds; otherwise any signed-in caller could name their
 * own host and receive the saved key in the x-api-key header. Typed keys are
 * not affected. An empty URL passes: the request then goes to the configured
 * proxy or to api.anthropic.com, both of which already hold the key.
 *
 * @param {string} requestedUrl - the URL the request names, empty for none
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isConfiguredAnthropicHost(requestedUrl, env = process.env) {
  const origin = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return ANTHROPIC_DEFAULT_ORIGIN;
    try {
      const parsed = new URL(trimmed);
      return `${parsed.protocol}//${parsed.host}`.toLowerCase();
    } catch {
      return null;
    }
  };

  if (!String(requestedUrl || '').trim()) return true;
  const requested = origin(requestedUrl);
  if (!requested) return false;

  const configured = [origin(env.ANTHROPIC_API_URL)];
  const ocrIsClaude =
    String(env.OCR_PROVIDER || '')
      .trim()
      .toLowerCase() === 'anthropic';
  if (ocrIsClaude && String(env.OCR_API_URL || '').trim()) {
    configured.push(origin(env.OCR_API_URL));
  }
  return configured.includes(requested);
}

/**
 * The visible answer of a Messages response: every text block, in order.
 * Thinking blocks are no part of it, and a response can begin with them, so
 * the content is read by type and never by position.
 *
 * @param {{content?: Array<{type: string, text?: string}>}} message
 * @returns {string}
 */
function anthropicMessageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Messages usage in the shape the rest of the app records: the same fields
 * readCompletionUsage() returns for the OpenAI-compatible providers, plus the
 * cache counts.
 *
 * promptTokens is everything the model read — uncached input, cache writes
 * and cache reads — so the dashboard's token totals mean the same thing for
 * every provider; the cache fields say how much of it was cached.
 *
 * @param {object|null|undefined} usage - `message.usage`
 * @returns {{promptTokens:number, completionTokens:number, totalTokens:number, reasoningTokens:null, cacheReadTokens:number, cacheWriteTokens:number}|null}
 */
function mapAnthropicUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const count = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  };
  const cacheReadTokens = count(usage.cache_read_input_tokens);
  const cacheWriteTokens = count(usage.cache_creation_input_tokens);
  const promptTokens =
    count(usage.input_tokens) + cacheReadTokens + cacheWriteTokens;
  const completionTokens = count(usage.output_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    reasoningTokens: null,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/**
 * Throws when a Messages response did not end with a usable answer.
 *
 * - `max_tokens`: the same error every provider throws for a cut-off answer
 *   (code 'ai_response_truncated', partial text on `error.partialText`), so
 *   the scan loop and the Duplicates review treat it alike.
 * - `refusal`: the model declined. Code 'ai_refused', the classifier's
 *   category in the message. Re-sending the same request would be declined
 *   again, so it must not look like a JSON problem that OCR could fix.
 *
 * @param {object} message - the Messages response
 * @param {string} provider - name for the message, e.g. 'Anthropic'
 * @param {string} remedy - sentence naming the limit to raise
 * @param {{partialText?: string}} [extra]
 */
function assertAnthropicCompleted(message, provider, remedy, extra) {
  const stopReason = message?.stop_reason;
  if (stopReason === 'max_tokens') {
    assertCompletionNotTruncated(
      {
        choices: [{ finish_reason: 'length' }],
        usage: { completion_tokens: message?.usage?.output_tokens },
      },
      provider,
      remedy,
      extra
    );
  }
  if (stopReason === 'refusal') {
    const category = message?.stop_details?.category;
    const error = new Error(
      `${provider} declined to answer${category ? ` (category: ${category})` : ''}.`
    );
    error.code = 'ai_refused';
    if (typeof extra?.partialText === 'string') {
      error.partialText = extra.partialText;
    }
    throw error;
  }
}

module.exports = {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_SUGGESTED_MODELS,
  ANTHROPIC_EFFORT_LEVELS,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  normalizeAnthropicModel,
  normalizeAnthropicEffort,
  anthropicModelTraits,
  anthropicThinkingParams,
  anthropicMaxTokens,
  createAnthropicClient,
  isConfiguredAnthropicHost,
  anthropicMessageText,
  mapAnthropicUsage,
  assertAnthropicCompleted,
};
