'use strict';

/**
 * The Claude API as an AI provider (AI_PROVIDER=anthropic).
 *
 * Same contract as the other four provider services — initialize(),
 * analyzeDocument(), generateText(), checkStatus() with the same arguments and
 * return shapes — so nothing that calls AIServiceFactory.getService() needs to
 * know which provider answers. Request building and answer reading go through
 * services/anthropicSupport.js; the analysis prompt comes from
 * services/analysisPrompt.js.
 *
 * Three things only this provider does:
 *
 * - Structured output (ANTHROPIC_STRUCTURED_OUTPUT): the analysis answer is
 *   constrained to the JSON schema of the object the prompt asks for, where
 *   the model supports it. The answer is still parsed the tolerant way, so
 *   a model or setting without it works as before.
 * - Prompt caching (ANTHROPIC_PROMPT_CACHING): the system prompt goes out as
 *   a cacheable block. It is the same for every document of a scan, so from
 *   the second document on it is read from the cache at a tenth of the price.
 * - Every request is streamed, also when nobody watches the progress: the
 *   SDK refuses a non-streamed request whose max_tokens could take longer
 *   than ten minutes (ANTHROPIC_MAX_TOKENS above about 21000), and thinking
 *   makes long answers likely. The answer is the same either way.
 */

const fs = require('fs').promises;
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/config');
const paperlessService = require('./paperlessService');
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('./thumbnailCachePaths');
const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit,
  isTimeoutError,
  buildTimeoutErrorMessage,
} = require('./serviceUtils');
const {
  abortSignal,
  abortedGenerationError,
  hasSystemPrompt,
  isAbortError,
  modelOverride,
  progressHandler,
  reasoningEnabled,
  runMessagesStream,
} = require('./aiGenerateOptions');
const {
  anthropicModelTraits,
  anthropicThinkingParams,
  anthropicMaxTokens,
  createAnthropicClient,
  anthropicMessageText,
  mapAnthropicUsage,
  assertAnthropicCompleted,
} = require('./anthropicSupport');
const {
  buildAnalysisPrompt,
  analysisResponseSchema,
  parseAnalysisAnswer,
} = require('./analysisPrompt');
const { resolveRules } = require('./aiProviderRules');

const PROVIDER = 'Anthropic';
const responseLogPath = path.join(
  process.cwd(),
  'data',
  'logs',
  'response.txt'
);
/**
 * What an operator can do about an answer that hit the completion cap.
 * Thinking counts toward the cap, so less effort is the other way out.
 */
const TRUNCATION_REMEDY =
  'Raise ANTHROPIC_MAX_TOKENS, or lower ANTHROPIC_EFFORT so less of it goes to thinking.';

class AnthropicService {
  constructor() {
    /** A client assigned from outside; wins over the configured one. */
    this._assignedClient = null;
    /** The configured client and the key and URL it was built from. */
    this._liveClient = null;
    this._liveClientKey = null;
    this.lastGenerateTextUsage = null;
    /**
     * Schemas the API refused for a model, as `model\nschema`. The analysis
     * then runs without structured output for the rest of the process
     * instead of paying for a refused request per document.
     */
    this.rejectedSchemas = new Set();
  }

  /**
   * The SDK client for the next request: an assigned one, else the one the
   * current key and API URL describe (rebuilt when either changed, so a key
   * saved on the settings page needs no restart), else null when Anthropic
   * is not the selected provider or has no key.
   */
  get client() {
    if (this._assignedClient) return this._assignedClient;
    if (config.aiProvider !== 'anthropic' || !config.anthropic.apiKey) {
      return null;
    }
    const connection = {
      apiKey: config.anthropic.apiKey,
      apiUrl: config.anthropic.apiUrl,
    };
    const key = JSON.stringify(connection);
    if (!this._liveClient || this._liveClientKey !== key) {
      this._liveClient = createAnthropicClient(connection);
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

  /**
   * What the transport takes (services/aiProviderRules.js): no temperature,
   * prompt caching, structured output through output_config. The per-model
   * details — which model thinks how, which takes a schema — stay with
   * anthropicModelTraits(), which knows more than the generic rules.
   *
   * @param {string} model
   */
  _rules(model) {
    return resolveRules('anthropic', model);
  }

  /**
   * The `system` field: a plain string, or with ANTHROPIC_PROMPT_CACHING one
   * text block marked cacheable. The marker sits on the only system block,
   * so the cached prefix is exactly the system prompt; a prompt shorter than
   * the model's minimum is simply not cached, at no extra cost.
   *
   * @param {string} text
   * @param {string} model
   * @returns {string|Array<object>}
   */
  _systemField(text, model) {
    if (
      config.anthropic.promptCaching !== 'yes' ||
      !this._rules(model).promptCaching
    ) {
      return text;
    }
    return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  }

  /**
   * One debug line per request with what the cache did, so an operator can
   * see whether the system prompt is actually being reused.
   *
   * @param {{cacheReadTokens?: number, cacheWriteTokens?: number}|null} usage
   */
  _logCacheUsage(usage) {
    if (config.anthropic.promptCaching !== 'yes' || !usage) return;
    console.debug(
      `[DEBUG] Anthropic cache: read ${usage.cacheReadTokens || 0}, write ${usage.cacheWriteTokens || 0}`
    );
  }

  /**
   * Caches the document's thumbnail for the history page, as every provider
   * does before it analyses. A thumbnail Paperless-ngx cannot deliver is
   * only a missing picture: the analysis goes on (the other providers return
   * nothing at all then, which the scan loop cannot read).
   *
   * @param {unknown} id - the Paperless-ngx document id
   */
  async _cacheThumbnail(id) {
    let cachePath;
    try {
      cachePath = getThumbnailCachePath(id);
    } catch (error) {
      console.warn(`Thumbnail not cached: ${error.message}`);
      return;
    }

    try {
      await fs.access(cachePath);
      console.log('[DEBUG] Thumbnail already cached');
      return;
    } catch {
      console.log('Thumbnail not cached, fetching from Paperless');
    }

    const thumbnailData = await paperlessService.getThumbnailImage(id);
    if (!thumbnailData) {
      console.warn('Thumbnail not found');
      return;
    }
    await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
    await fs.writeFile(cachePath, thumbnailData);
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

    const model = config.anthropic.model;
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
   * The Messages body of one document analysis.
   *
   * No temperature: the current models reject sampling parameters, and the
   * analysis does not depend on it. Thinking follows ANTHROPIC_EFFORT only;
   * the analysis has no wish of its own about it.
   *
   * @param {string} model
   * @param {object} prompt - from buildAnalysisPrompt()
   * @param {string} documentText - already truncated
   * @returns {object}
   */
  _analysisRequest(model, prompt, documentText) {
    const thinking = anthropicThinkingParams(model, {
      effort: config.anthropic.effort,
    });
    const request = {
      model,
      max_tokens: anthropicMaxTokens(null, config.anthropic.maxTokens),
      system: this._systemField(prompt.systemPrompt, model),
      messages: [{ role: 'user', content: documentText }],
    };
    if (thinking.thinking) request.thinking = thinking.thinking;

    const outputConfig = { ...(thinking.output_config || {}) };
    if (
      config.anthropic.structuredOutput === 'yes' &&
      this._rules(model).structuredOutput === 'anthropic' &&
      anthropicModelTraits(model).structuredOutput
    ) {
      const schema = analysisResponseSchema(prompt);
      if (!this.rejectedSchemas.has(this._schemaKey(model, schema))) {
        outputConfig.format = { type: 'json_schema', schema };
      }
    }
    if (Object.keys(outputConfig).length > 0) {
      request.output_config = outputConfig;
    }
    return request;
  }

  /** What rejectedSchemas remembers a refused schema by. */
  _schemaKey(model, schema) {
    return `${model}\n${JSON.stringify(schema)}`;
  }

  /**
   * Sends the analysis and returns the final message.
   *
   * A schema the API refuses (400) would fail every document the same way,
   * so the request is sent once more without it; when that one goes through,
   * the schema is remembered as refused and the following documents skip it.
   * Any other failure, and a 400 that has nothing to do with the schema,
   * surfaces as it is.
   *
   * @param {object} request
   * @returns {Promise<object>} the Messages response
   */
  async _sendAnalysis(request) {
    try {
      return await this.client.messages.stream(request).finalMessage();
    } catch (error) {
      const format = request.output_config?.format;
      if (!format || !(error instanceof Anthropic.BadRequestError)) {
        throw error;
      }
      // The same request without the schema; an effort stays.
      const retry = { ...request, output_config: { ...request.output_config } };
      delete retry.output_config.format;
      if (Object.keys(retry.output_config).length === 0) {
        delete retry.output_config;
      }
      const message = await this.client.messages.stream(retry).finalMessage();
      this.rejectedSchemas.add(this._schemaKey(request.model, format.schema));
      console.warn(
        `[WARN] Anthropic refused the analysis schema for ${request.model} (${error.message}); analysing without structured output from now on.`
      );
      return message;
    }
  }

  /**
   * Analyse one document. Same arguments and return shapes as every other
   * provider: `{ document, metrics, truncated }` on success and
   * `{ document: { tags: [], correspondent: null }, metrics: null, error,
   * errorCode }` on failure — it never throws.
   *
   * errorCode is 'ai_response_truncated' for an answer that hit
   * ANTHROPIC_MAX_TOKENS and 'ai_refused' for a request the model declined.
   * Neither message is one the scan loop sends to OCR: new text would be cut
   * off or declined the same way.
   *
   * @param {string} content - the document text
   * @param {Array|string} [existingTags]
   * @param {Array|string} [existingCorrespondentList]
   * @param {Array|string} [existingDocumentTypesList]
   * @param {number|string} id - the Paperless-ngx document id
   * @param {string|null} [customPrompt] - replaces SYSTEM_PROMPT (webhook)
   * @param {{externalApiData?: unknown}} [options]
   * @returns {Promise<object>}
   */
  async analyzeDocument(
    content,
    existingTags = [],
    existingCorrespondentList = [],
    existingDocumentTypesList = [],
    id,
    customPrompt = null,
    options = {}
  ) {
    try {
      this.initialize();

      if (!this.client) {
        throw new Error('Anthropic client not initialized - missing API key');
      }

      await this._cacheThumbnail(id);

      // Get external API data if available and validate it
      let validatedExternalApiData = null;
      if (options?.externalApiData) {
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

      const model = config.anthropic.model;
      const usePromptTags = process.env.USE_PROMPT_TAGS;
      const prompt = buildAnalysisPrompt({
        systemPrompt: process.env.SYSTEM_PROMPT,
        mustHavePrompt: config.mustHavePrompt,
        specialPromptPreDefinedTags: config.specialPromptPreDefinedTags,
        customFieldsJson: process.env.CUSTOM_FIELDS,
        useExistingData: config.useExistingData,
        restrictToExistingTags: config.restrictToExistingTags,
        restrictToExistingCorrespondents:
          config.restrictToExistingCorrespondents,
        usePromptTags,
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

      // Calculate tokens AFTER all prompt modifications are complete
      const totalPromptTokens = await calculateTotalPromptTokens(
        prompt.systemPrompt,
        usePromptTags === 'yes' ? [prompt.promptTags] : [],
        model
      );

      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens);
      const availableTokens = maxTokens - reservedTokens;

      // A non-finite budget is the same failure as a negative one: it slips
      // past a bare `<= 0` and truncates the document down to nothing.
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

      const request = this._analysisRequest(model, prompt, truncatedContent);
      const message = await this._sendAnalysis(request);

      // A cut-off or declined answer is a failure of its own, reported before
      // its text is looked at.
      assertAnthropicCompleted(message, PROVIDER, TRUNCATION_REMEDY);

      const metrics = mapAnthropicUsage(message.usage);
      console.log(
        `[DEBUG] Anthropic request sent, total tokens: ${metrics ? metrics.totalTokens : 'unknown'}`
      );
      this._logCacheUsage(metrics);

      let jsonContent = anthropicMessageText(message);
      if (!jsonContent) {
        throw new Error('Invalid API response structure');
      }

      let parsedResponse;
      try {
        const parsedResult = parseAnalysisAnswer(jsonContent);
        parsedResponse = parsedResult.parsed;
        jsonContent = parsedResult.normalized;
      } catch (error) {
        console.error(`Failed to parse JSON response: ${error.message}`);
        console.debug(error);
        throw error;
      }

      try {
        await fs.mkdir(path.dirname(responseLogPath), { recursive: true });
        await fs.appendFile(responseLogPath, `${jsonContent}\n`);
      } catch (logError) {
        console.warn('Failed to write AI response log:', logError.message);
      }

      // Validate response structure
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
        metrics,
        truncated: truncatedContent.length < content.length,
      };
    } catch (error) {
      const timedOut =
        error instanceof Anthropic.APIConnectionTimeoutError ||
        isTimeoutError(error);
      const normalizedMessage = timedOut
        ? buildTimeoutErrorMessage('AI')
        : error.message;

      if (timedOut) {
        console.error(
          `[TIMEOUT][AI] Anthropic request timed out: ${error.message}`
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
   * Generate text based on a prompt
   * @param {string} prompt - The prompt to generate text from
   * @param {object} [options] - Optional overrides for this one call
   * @param {string} [options.systemPrompt] - Sent as the top-level system
   *   field, cacheable with ANTHROPIC_PROMPT_CACHING
   * @param {string} [options.model] - Overrides ANTHROPIC_MODEL
   * @param {number} [options.temperature] - Accepted and ignored: the current
   *   Claude models answer 400 to any sampling parameter, and the callers'
   *   temperatures (0 for a judge) only ask for what the model does anyway
   * @param {number} [options.maxTokens] - Overrides ANTHROPIC_MAX_TOKENS;
   *   thinking counts toward it
   * @param {AbortSignal} [options.signal] - Cancels the request in flight
   * @param {Function} [options.onProgress] - Reports the answer as it grows;
   *   see GenerateTextProgress in aiGenerateOptions. The request is streamed
   *   either way (see the top of this file), so without a handler nothing
   *   changes but the reports
   * @param {boolean} [options.reasoning] - false asks for as little thinking
   *   as the model allows, true for thinking where the model only thinks when
   *   asked; see anthropicThinkingParams()
   * @returns {Promise<string>} - The generated text
   */
  async generateText(prompt, options = {}) {
    // Read before the try so the catch can tell a stopped request from a
    // failed one.
    const signal = abortSignal(options);
    const onProgress = progressHandler(options);

    try {
      this.initialize();

      if (!this.client) {
        throw new Error('Anthropic client not initialized - missing API key');
      }

      const model = modelOverride(options) || config.anthropic.model;
      const thinking = anthropicThinkingParams(model, {
        reasoning: reasoningEnabled(options),
        effort: config.anthropic.effort,
      });

      const request = {
        model,
        max_tokens: anthropicMaxTokens(
          options?.maxTokens,
          config.anthropic.maxTokens
        ),
      };
      if (hasSystemPrompt(options)) {
        request.system = this._systemField(options.systemPrompt, model);
      }
      // options.temperature is not forwarded: the rules say this transport
      // takes none (see _rules()).
      request.messages = [{ role: 'user', content: prompt }];
      Object.assign(request, thinking);

      this.lastGenerateTextUsage = null;
      return await runMessagesStream({
        client: this.client,
        request,
        // The SDK's request option bag; a caller that brought no signal
        // gets the call without one.
        requestOptions: signal ? { signal } : null,
        signal,
        onProgress,
        provider: PROVIDER,
        remedy: TRUNCATION_REMEDY,
        onUsage: (usage) => {
          this.lastGenerateTextUsage = usage;
          this._logCacheUsage(usage);
        },
      });
    } catch (error) {
      // One name for a stopped request, whatever the client called it; an
      // abort the runner raised already carries its partial text.
      const thrown =
        isAbortError(error, signal) && error?.name !== 'AbortError'
          ? abortedGenerationError(error, '')
          : error;
      console.error(`Error generating text with Anthropic: ${thrown.message}`);
      console.debug(thrown);
      throw require('./modelFailure').tagTransportFailure(thrown);
    }
  }

  /**
   * Checks the key and the model without spending a token: the models
   * endpoint knows the configured model only when the key is valid and the
   * model exists for it.
   *
   * @returns {Promise<{status: 'ok', model: string}|{status: 'error', error: string}>}
   */
  async checkStatus() {
    const model = config.anthropic.model;
    try {
      this.initialize();

      if (!this.client) {
        throw new Error('Anthropic client not initialized - missing API key');
      }

      await this.client.models.retrieve(model);
      return { status: 'ok', model };
    } catch (error) {
      let message = error.message;
      if (error instanceof Anthropic.AuthenticationError) {
        message = 'The Anthropic API key was rejected.';
      } else if (error instanceof Anthropic.NotFoundError) {
        message = `The Anthropic model "${model}" was not found.`;
      }
      console.error(`Error checking Anthropic status: ${error.message}`);
      console.debug(error);
      return { status: 'error', error: message };
    }
  }
}

module.exports = new AnthropicService();
