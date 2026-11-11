'use strict';

/**
 * The one service that speaks the OpenAI chat completions protocol.
 *
 * OpenAI, Azure OpenAI and any OpenAI-compatible endpoint ("custom") used to
 * be three services that agreed on four fifths of their code and disagreed on
 * the rest by accident. They are three configurations of this class now:
 *
 * - a provider profile (PROFILES below) says where the connection settings
 *   come from, how the SDK client is built, which model name is sent, what
 *   the errors call the provider and how the status check is made;
 * - services/aiProviderRules.js says what a request may carry for that
 *   provider and model: a temperature, which field the completion cap travels
 *   in, a reasoning effort, a thinking switch. resolveRules() is asked for
 *   every request; nothing about a model family is decided in here.
 *
 * The SDK client follows the configuration: it is rebuilt whenever the
 * connection tuple (API key, base URL or endpoint, API version) changes, so a
 * key saved on the settings page reaches the next request without a restart.
 * A test (or a caller) may still assign `service.client` to use a client of
 * its own; assigning null returns to the configured one.
 *
 * services/openaiService.js, azureService.js and customService.js export the
 * instance for their provider, so every existing import keeps working.
 */

const OpenAI = require('openai');
const { AzureOpenAI } = require('openai');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config/config');
const { cacheThumbnail } = require('./thumbnailCache');
const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit,
  writePromptToFile,
  extractChatMessageContent,
  assertCompletionNotTruncated,
  isTimeoutError,
  buildTimeoutErrorMessage,
  isRefusalAnswer,
  insufficientContentResult,
} = require('./serviceUtils');
const {
  abortSignal,
  abortedGenerationError,
  hasNumber,
  hasSystemPrompt,
  isAbortError,
  modelOverride,
  progressHandler,
  readCompletionUsage,
  reasoningEnabled,
  runChatCompletionStream,
  stripReasoningText,
} = require('./aiGenerateOptions');
const {
  buildAnalysisPrompt,
  parseAnalysisAnswer,
} = require('./analysisPrompt');
const {
  normalizeProvider,
  resolveRules,
  transportFor,
} = require('./aiProviderRules');
const {
  FAILURE_KINDS,
  tagFailure,
  tagTransportFailure,
} = require('./modelFailure');

const responseLogPath = path.join(
  process.cwd(),
  'data',
  'logs',
  'response.txt'
);

/** What an operator can do about an analysis answer that hit a cap. */
const ANALYSIS_TRUNCATION_REMEDY =
  'Reduce the number of custom fields the prompt asks for, or use a model with a larger completion limit.';
/** ... and about a generateText() answer that hit RESPONSE_TOKENS. */
const RESPONSE_TOKENS_REMEDY = 'Raise Response Tokens (RESPONSE_TOKENS).';

/**
 * OpenAI-compatible SDKs require an apiKey value even when the server has
 * authentication switched off.
 */
const CUSTOM_PROVIDER_FALLBACK_API_KEY = 'no-auth-required';

/**
 * Room left between prompt and context limit when the completion cap of a
 * generateText() call is clamped, for the tokens a chat template adds.
 */
const CLAMP_HEADROOM_TOKENS = 64;

/**
 * The first Azure API version that answers a streamed request with a usage
 * chunk. Older versions reject `stream_options` outright, which would turn a
 * working deployment into a 400 the moment progress is asked for.
 */
const STREAM_OPTIONS_SINCE = '2024-06-01';
/** Version aliases that always mean "the newest surface". */
const ROLLING_API_VERSIONS = ['preview', 'latest', 'v1'];

/**
 * Whether the configured Azure API version understands
 * `stream_options: { include_usage: true }`.
 *
 * Azure versions are dates, so the comparison is a string comparison on the
 * leading YYYY-MM-DD; a preview of a supported date counts as supported.
 * Anything unrecognized is treated as too old and the token count for that
 * deployment stays an estimate, which is the harmless half of being wrong.
 *
 * @param {string} apiVersion
 * @returns {boolean}
 */
function supportsStreamOptions(apiVersion) {
  const version = String(apiVersion || '')
    .trim()
    .toLowerCase();
  if (ROLLING_API_VERSIONS.includes(version)) return true;
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(version);
  return date ? date[1] >= STREAM_OPTIONS_SINCE : false;
}

/**
 * @typedef {object} ProviderProfile
 * @property {string} label - the provider's name in errors and log lines
 * @property {() => string|undefined} model - the configured model; for Azure
 *   the deployment name, which is what that API routes by
 * @property {() => object|null} connection - the SDK client options, or null
 *   when the provider is not usable with what is configured
 * @property {(options: object) => object} createClient
 * @property {string} generateRemedy - the sentence a truncated
 *   generateText() answer names
 * @property {() => boolean} streamUsage - a streamed request may ask for the
 *   usage chunk
 * @property {(service: OpenAICompatibleService, client: object) => Promise<object>} checkStatus
 */

/** @type {Readonly<Record<'openai'|'azure'|'custom', ProviderProfile>>} */
const PROFILES = Object.freeze({
  openai: {
    label: 'OpenAI',
    model: () => process.env.OPENAI_MODEL || config.openai.model,
    connection: () =>
      config.openai.apiKey ? { apiKey: config.openai.apiKey } : null,
    createClient: (options) => new OpenAI(options),
    // What this provider has always named, kept as it was.
    generateRemedy: ANALYSIS_TRUNCATION_REMEDY,
    streamUsage: () => true,
    async checkStatus(service, client) {
      // Token-free: listing the models proves connectivity and the key.
      await client.models.list();
      return { status: 'ok', model: service.model() };
    },
  },
  azure: {
    label: 'AzureOpenAI',
    model: () =>
      process.env.AZURE_DEPLOYMENT_NAME || config.azure.deploymentName,
    // No deployment here: the SDK takes the request's model field as the
    // deployment, so a per-call model override addresses another one. The
    // explicit null keeps the SDK from reading OPENAI_BASE_URL, which it
    // would refuse next to an endpoint.
    connection: () => ({
      baseURL: null,
      apiKey: config.azure.apiKey,
      endpoint: config.azure.endpoint,
      apiVersion: config.azure.apiVersion,
    }),
    createClient: (options) => new AzureOpenAI(options),
    generateRemedy: RESPONSE_TOKENS_REMEDY,
    // Only where the configured API version takes it; an older one would
    // answer 400 instead of streaming, so that deployment estimates.
    streamUsage: () => supportsStreamOptions(config.azure.apiVersion),
    async checkStatus(service) {
      const model = service.model();
      // Token-free health check against the deployment metadata endpoint.
      const endpoint = (config.azure.endpoint || '').replace(/\/$/, '');
      const apiVersion = config.azure.apiVersion;
      if (!endpoint || !apiVersion || !model) {
        throw new Error(
          'Azure endpoint, apiVersion, or deployment name missing'
        );
      }
      const url = `${endpoint}/openai/deployments/${model}?api-version=${encodeURIComponent(apiVersion)}`;
      const response = await axios.get(url, {
        headers: { 'api-key': config.azure.apiKey },
        timeout: 10000,
      });
      if (response.status < 200 || response.status >= 300) {
        return { status: 'error' };
      }
      return { status: 'ok', model };
    },
  },
  custom: {
    label: 'Custom OpenAI',
    model: () => config.custom.model,
    connection: () => ({
      baseURL: config.custom.apiUrl,
      apiKey: config.custom.apiKey || CUSTOM_PROVIDER_FALLBACK_API_KEY,
    }),
    createClient: (options) => new OpenAI(options),
    generateRemedy: RESPONSE_TOKENS_REMEDY,
    streamUsage: () => true,
    async checkStatus(service, client) {
      // Token-free where the endpoint supports it.
      await client.models.list();
      return { status: 'ok', model: service.model() };
    },
  },
});

class OpenAICompatibleService {
  /**
   * @param {'openai'|'azure'|'custom'} providerId
   */
  constructor(providerId) {
    if (!PROFILES[providerId]) {
      throw new Error(`No OpenAI-compatible provider "${providerId}"`);
    }
    this.providerId = providerId;
    this.profile = PROFILES[providerId];
    this.lastGenerateTextUsage = null;
    /** A client assigned from outside; wins over the configured one. */
    this._assignedClient = null;
    /** The configured client and the connection tuple it was built from. */
    this._liveClient = null;
    this._liveClientKey = null;
  }

  /**
   * The SDK client for the next request: an assigned one, else the one the
   * current configuration describes (rebuilt when that changed), else null
   * when this provider is not the selected one or lacks its credentials.
   */
  get client() {
    if (this._assignedClient) return this._assignedClient;
    if (normalizeProvider(config.aiProvider) !== this.providerId) return null;
    const options = this.profile.connection();
    if (!options) return null;
    const key = JSON.stringify(options);
    if (!this._liveClient || this._liveClientKey !== key) {
      this._liveClient = this.profile.createClient(options);
      this._liveClientKey = key;
    }
    return this._liveClient;
  }

  set client(value) {
    this._assignedClient = value || null;
  }

  /**
   * Kept because callers invoke it before a request. The client is built on
   * demand from the live configuration, so there is nothing left to set up.
   */
  initialize() {}

  /** The configured model; for Azure the deployment name. */
  model() {
    return this.profile.model();
  }

  /** The request rules for a model on this provider. */
  rules(model) {
    return resolveRules(this.providerId, model);
  }

  /**
   * Caches the document's thumbnail for the history page. Best effort: the
   * thumbnail never enters the prompt, so no outcome here decides whether
   * the document is analysed (see services/thumbnailCache.js).
   *
   * @returns {Promise<boolean>} true when a thumbnail is cached afterwards
   */
  async _cacheThumbnail(id) {
    return cacheThumbnail(id);
  }

  async analyzeDocument(
    content,
    existingTags = [],
    existingCorrespondentList = [],
    existingDocumentTypesList = [],
    id,
    customPrompt = null,
    options = {}
  ) {
    const { label } = this.profile;
    try {
      const client = this.client;
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', {
        dateStyle: 'short',
        timeStyle: 'short',
      });

      if (!client) {
        throw new Error(`${label} client not initialized`);
      }

      await this._cacheThumbnail(id);

      let validatedExternalApiData = null;
      if (options.externalApiData) {
        try {
          validatedExternalApiData =
            await this._validateAndTruncateExternalApiData(
              options.externalApiData
            );
          console.log('[DEBUG] External API data validated and included');
        } catch (error) {
          console.warn(
            '[WARNING] External API data validation failed:',
            error.message
          );
          validatedExternalApiData = null;
        }
      }

      const model = this.model();
      const prompt = buildAnalysisPrompt({
        systemPrompt: process.env.SYSTEM_PROMPT,
        mustHavePrompt: config.mustHavePrompt,
        specialPromptPreDefinedTags: config.specialPromptPreDefinedTags,
        customFieldsJson: process.env.CUSTOM_FIELDS,
        useExistingData: config.useExistingData,
        restrictToExistingTags: config.restrictToExistingTags,
        restrictToExistingCorrespondents:
          config.restrictToExistingCorrespondents,
        usePromptTags: process.env.USE_PROMPT_TAGS,
        promptTags: process.env.PROMPT_TAGS,
        existingTags,
        existingCorrespondentList,
        existingDocumentTypesList,
        externalApiData: validatedExternalApiData,
        customPrompt,
      });
      if (prompt.customFieldsError) {
        console.error(
          `Failed to parse CUSTOM_FIELDS: ${prompt.customFieldsError.message}`
        );
        console.debug(prompt.customFieldsError);
      }
      if (customPrompt) {
        console.log('[DEBUG] Replace system prompt with custom prompt');
      }
      const { systemPrompt } = prompt;

      // Calculate tokens AFTER all prompt modifications are complete
      const totalPromptTokens = await calculateTotalPromptTokens(
        systemPrompt,
        process.env.USE_PROMPT_TAGS === 'yes' ? [prompt.promptTags] : [],
        model
      );

      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens);
      const availableTokens = maxTokens - reservedTokens;

      // Validate that we have positive available tokens. A non-finite budget
      // is the same failure: it slips past a bare `<= 0` and truncates the
      // document down to nothing instead of stopping.
      if (!Number.isFinite(availableTokens) || availableTokens <= 0) {
        console.warn(
          `[WARNING] No available tokens for content. Reserved: ${reservedTokens}, Max: ${maxTokens}`
        );
        throw new Error(
          'Token limit exceeded: prompt too large for available token limit'
        );
      }

      console.log(
        `[DEBUG] Token calculation - Prompt: ${totalPromptTokens}, Reserved: ${reservedTokens}, Available: ${availableTokens}`
      );
      console.log(
        `[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`
      );
      console.log(
        `[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`
      );

      const truncatedContent = await truncateToTokenLimit(
        content,
        availableTokens,
        model
      );

      await writePromptToFile(systemPrompt, truncatedContent);

      const rules = this.rules(model);
      const request = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: truncatedContent },
        ],
      };
      if (rules.temperature) {
        request.temperature = config.aiTemperatureAnalysis;
      }

      const response = await client.chat.completions.create(request);

      assertCompletionNotTruncated(response, label, ANALYSIS_TRUNCATION_REMEDY);
      const message = response?.choices?.[0]?.message;
      let jsonContent = extractChatMessageContent(message, label);
      if (!jsonContent) {
        throw new Error('Invalid API response structure');
      }

      console.log(`[DEBUG] [${timestamp}] ${label} request sent`);
      console.log(
        `[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`
      );

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      };

      let parsedResponse;
      try {
        const parsedResult = parseAnalysisAnswer(jsonContent);
        parsedResponse = parsedResult.parsed;
        jsonContent = parsedResult.normalized;
      } catch (error) {
        console.error(`Failed to parse JSON response: ${error.message}`);
        console.debug(error);
        // A model that declines the document instead of answering: a
        // default structure rather than a throw, so the scan loop does not
        // retry it, with the error the OCR fallback recognises.
        if (isRefusalAnswer(jsonContent)) {
          console.warn(`Document ${id} has insufficient content for analysis`);
          return insufficientContentResult(id, mappedUsage);
        }
        throw error;
      }

      try {
        await fs.mkdir(path.dirname(responseLogPath), { recursive: true });
        await fs.appendFile(responseLogPath, `${jsonContent}\n`);
      } catch (logError) {
        console.warn('Failed to write AI response log:', logError.message);
      }

      if (
        !parsedResponse ||
        !Array.isArray(parsedResponse.tags) ||
        (typeof parsedResponse.correspondent !== 'string' &&
          parsedResponse.correspondent !== null)
      ) {
        throw new Error(
          'AI could not determine assignable metadata: no tags or correspondent found'
        );
      }

      return {
        document: parsedResponse,
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length,
      };
    } catch (error) {
      const normalizedMessage = isTimeoutError(error)
        ? buildTimeoutErrorMessage('AI')
        : error.message;

      if (isTimeoutError(error)) {
        console.error(
          `[TIMEOUT][AI] ${label} request timed out: ${error.message}`
        );
      }

      console.error(`Failed to analyze document: ${normalizedMessage}`);
      console.debug(error);
      return {
        document: { tags: [], correspondent: null },
        metrics: null,
        error: normalizedMessage,
        // Undefined for everything that is not one of ours; the scan loop
        // falls back to its generic reason then.
        errorCode: error.code,
      };
    }
  }

  /**
   * Validate and truncate external API data to prevent token overflow
   * @param {any} apiData - The external API data to validate
   * @param {number} maxTokens - Maximum tokens allowed for external data (default: 500)
   * @returns {Promise<string|null>} - Validated and potentially truncated data string
   */
  async _validateAndTruncateExternalApiData(apiData, maxTokens = 500) {
    if (!apiData) {
      return null;
    }

    const dataString =
      typeof apiData === 'object'
        ? JSON.stringify(apiData, null, 2)
        : String(apiData);

    const model = this.model();
    const dataTokens = await calculateTokens(dataString, model);

    if (dataTokens > maxTokens) {
      console.warn(
        `[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`
      );
      return await truncateToTokenLimit(dataString, maxTokens, model);
    }

    console.log(`[DEBUG] External API data validated: ${dataTokens} tokens`);
    return dataString;
  }

  /**
   * The completion cap of one generateText() call, or null for none.
   *
   * A cap the caller asked for, else RESPONSE_TOKENS where the provider
   * caps by default — clamped so prompt and answer fit the context
   * (TOKEN_LIMIT), because a small self-hosted context answers 400 for a cap
   * it cannot hold.
   */
  async _completionCap(prompt, model, options, rules) {
    const asked = hasNumber(options.maxTokens) && options.maxTokens > 0;
    if (!asked && !rules.defaultCompletionCap) return null;

    const maxContextTokens = Number(config.tokenLimit) || 128000;
    const desired = asked
      ? Math.floor(options.maxTokens)
      : Number(config.responseTokens) || 1000;
    const promptTokens = await calculateTokens(prompt, model);
    const available = Math.max(
      1,
      maxContextTokens - promptTokens - CLAMP_HEADROOM_TOKENS
    );
    const cap = Math.max(1, Math.min(desired, available));
    if (cap < desired) {
      console.log(
        `[DEBUG] Clamped ${rules.maxTokensParam} for ${this.profile.label} generateText from ${desired} to ${cap} ` +
          `(context limit: ${maxContextTokens}, prompt tokens: ${promptTokens})`
      );
    }
    return cap;
  }

  /**
   * The chat completion body of one generateText() call. Every field that
   * depends on the model is decided by resolveRules().
   */
  async _generateRequest(prompt, options) {
    const model = modelOverride(options) || this.model();
    const rules = this.rules(model);
    const reasoning = reasoningEnabled(options);

    const messages = [];
    if (hasSystemPrompt(options)) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    // The soft switch for a family that reads it out of the prompt: its own
    // line at the end, and only when the caller asked for no thinking.
    messages.push({
      role: 'user',
      content:
        reasoning === false && rules.thinkingPromptSwitch
          ? `${prompt}\n${rules.thinkingPromptSwitch}`
          : prompt,
    });

    const request = { model, messages };
    if (rules.temperature) {
      request.temperature = hasNumber(options.temperature)
        ? options.temperature
        : config.aiTemperatureGeneration;
    }
    const cap = await this._completionCap(prompt, model, options, rules);
    if (cap !== null) request[rules.maxTokensParam] = cap;

    // The key every server that applies a chat template understands; one
    // that does not passes it through and the model decides for itself.
    if (rules.thinkingSwitch === 'chat_template' && reasoning !== null) {
      request.chat_template_kwargs = { enable_thinking: reasoning };
    }
    // A hosted reasoning model reads neither of the above and thinks anyway;
    // the families that take reasoning_effort are told in their dialect.
    // Only when the caller asked for no thinking, and only for those names —
    // another model answers 400 for the field.
    if (
      reasoning === false &&
      rules.reasoningEffort &&
      rules.reasoningOffEffort
    ) {
      request.reasoning_effort = rules.reasoningOffEffort;
    }
    return request;
  }

  /**
   * Generate text based on a prompt
   * @param {string} prompt - The prompt to generate text from
   * @param {object} [options] - Optional overrides for this one call
   * @param {string} [options.systemPrompt] - Sent as the system message
   * @param {number} [options.temperature] - Overrides AI_TEMPERATURE_GENERATION
   *   on models that take a temperature
   * @param {number} [options.maxTokens] - Completion cap, clamped to the context
   * @param {string} [options.model] - Model (Azure: deployment) for this call
   * @param {AbortSignal} [options.signal] - Cancels the request in flight
   * @param {Function} [options.onProgress] - Streams the answer and reports it
   *   as it grows; see GenerateTextProgress in aiGenerateOptions
   * @param {boolean} [options.reasoning] - Switches the model's thinking off
   *   or on for this one call, in whatever way the rules know for the model;
   *   nothing new is sent when the caller says nothing
   * @returns {Promise<string>} - The generated text
   */
  async generateText(prompt, options = {}) {
    // Read before the try so the catch can tell a stopped request from a
    // failed one.
    const signal = abortSignal(options);
    const onProgress = progressHandler(options);
    const { label, generateRemedy } = this.profile;

    try {
      const client = this.client;
      if (!client) {
        throw new Error(`${label} client not initialized - missing API key`);
      }

      const request = await this._generateRequest(prompt, options);

      this.lastGenerateTextUsage = null;
      // The second argument is the SDK's request option bag; a caller that
      // brought no signal gets the call it always got.
      const requestOptions = signal ? { signal } : null;

      if (onProgress) {
        const streamRequest = { ...request, stream: true };
        // include_usage buys the exact completion count at the end of the
        // stream; without it the report is an estimate all the way.
        if (this.profile.streamUsage()) {
          streamRequest.stream_options = { include_usage: true };
        }
        return await runChatCompletionStream({
          client,
          request: streamRequest,
          requestOptions,
          signal,
          onProgress,
          provider: label,
          remedy: generateRemedy,
          onUsage: (usage) => {
            this.lastGenerateTextUsage = usage;
          },
        });
      }

      const response = requestOptions
        ? await client.chat.completions.create(request, requestOptions)
        : await client.chat.completions.create(request);
      this.lastGenerateTextUsage = readCompletionUsage(response);

      const message = response?.choices?.[0]?.message;
      // Reasoning is no part of the answer, and a block the cut-off left
      // open is no part of it either.
      const generatedText = extractChatMessageContent(
        { ...message, content: stripReasoningText(message?.content) },
        label
      );

      // After the text is in hand: a cut-off answer is still a failure, but
      // the caller can keep the prefix instead of paying for it twice.
      assertCompletionNotTruncated(response, label, generateRemedy, {
        partialText: generatedText,
      });

      if (!generatedText) {
        // Say what came back: a gateway that timed out behind a 200, a
        // model that stopped after its reasoning without an answer, or an
        // empty choices array all end here and need telling apart.
        const finishReason = response?.choices?.[0]?.finish_reason ?? 'unknown';
        const head = JSON.stringify(response ?? null).slice(0, 200);
        const error = new Error(
          `Invalid API response structure: the answer carried no text (finish_reason ${finishReason}; the response begins ${head})`
        );
        // Reasoning and no answer: the model spent the completion thinking.
        throw message?.reasoning_content ||
          message?.reasoning ||
          /<think>/i.test(String(message?.content ?? ''))
          ? tagFailure(error, FAILURE_KINDS.THINKING)
          : error;
      }

      return generatedText;
    } catch (error) {
      // One name for a stopped request, whatever the client called it; an
      // abort this service raised already carries its partial text.
      const thrown =
        isAbortError(error, signal) && error?.name !== 'AbortError'
          ? abortedGenerationError(error, '')
          : error;
      console.error(`Error generating text with ${label}: ${thrown.message}`);
      console.debug(thrown);
      throw tagTransportFailure(thrown);
    }
  }

  async checkStatus() {
    const { label } = this.profile;
    try {
      const client = this.client;
      if (!client) {
        throw new Error(`${label} client not initialized - missing API key`);
      }
      return await this.profile.checkStatus(this, client);
    } catch (error) {
      console.error(`Error checking ${label} status: ${error.message}`);
      console.debug(error);
      return { status: 'error', error: error.message };
    }
  }
}

/** One instance per provider, shared by every import of it. */
const instances = new Map();

/**
 * The service instance for an OpenAI-compatible provider.
 *
 * @param {unknown} provider - 'openai', 'azure' or 'custom'
 * @returns {OpenAICompatibleService}
 */
function forProvider(provider) {
  const id = normalizeProvider(provider);
  if (transportFor(id) !== 'openai-compatible') {
    throw new Error(`Provider "${id}" does not speak the OpenAI protocol`);
  }
  if (!instances.has(id)) {
    instances.set(id, new OpenAICompatibleService(id));
  }
  return instances.get(id);
}

module.exports = {
  OpenAICompatibleService,
  forProvider,
  supportsStreamOptions,
  PROVIDER_PROFILES: PROFILES,
};
