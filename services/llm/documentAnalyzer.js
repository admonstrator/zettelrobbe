'use strict';

/**
 * The single business logic behind the LLM document analysis.
 *
 * Each provider is a composition root (services/llm/providers/): it hands
 * this class its transport, its token budget, its prompt layout and the few
 * knobs that really differ, and exports the instance as its singleton.
 * Nothing extends DocumentAnalyzer. What happens between the document and
 * the AnalysisResult — prompt, budget, request, parsing, the metadata check,
 * the field defaults, the refusal — happens here, once, for every provider.
 */

const path = require('path');
const fs = require('fs').promises;
const config = require('../../config/config');
const { writePromptToFile } = require('../serviceUtils');
const { hasNumber } = require('../aiGenerateOptions');
const { cacheThumbnail } = require('../thumbnailCache');
const defaultPromptBuilder = require('./promptBuilder');
const defaultResponseParser = require('./responseParser');
const {
  buildSuccess,
  buildFailure,
  buildInsufficientContent,
  assertAssignableMetadata,
  withDocumentDefaults,
} = require('./analysisResult');

/** Tokens the external API data may take up in the prompt. */
const EXTERNAL_API_DATA_MAX_TOKENS = 500;

class DocumentAnalyzer {
  /**
   * @param {Object} deps
   * @param {string} deps.label - Provider name for the log
   * @param {Object} deps.transport - One API family: initialize(), isReady(),
   *   complete(request), generate(prompt, options[, sizes]), and the
   *   `client` / `lastGenerateTextUsage` the tests and the AI review read
   * @param {Object} deps.tokenBudget - reserve(), fit(), count(), cut()
   * @param {Object} deps.promptLayout - frame() and build(); see promptLayout.js
   * @param {() => string} deps.resolveModel - The model of this request
   * @param {(provider: DocumentAnalyzer) => Promise<Object>} deps.checkStatus
   *   The provider's own status probe (row g: kept as it was)
   * @param {string} deps.clientNotReadyMessage - The failure without a client
   * @param {(model: string) => number|undefined} [deps.analysisTemperature]
   *   undefined leaves the parameter out of the request
   * @param {Object|null} [deps.responseSchema] - Structured-output schema
   * @param {(promptText: string, responseTokens: number) => number} [deps.contextWindow]
   *   The context to request for a prompt; set by the providers that size it
   *   themselves (Ollama's num_ctx)
   * @param {(content: string) => string} [deps.prepareContent] - A cut the
   *   provider applies before anything else (Ollama's CONTENT_MAX_LENGTH)
   * @param {(error: Error) => string} [deps.describeFailure] - The failure
   *   message, when the provider rewords one (Custom's timeouts, rows e/m)
   * @param {Object} [deps.promptBuilder] - buildAnalysisPrompt()
   * @param {Object} [deps.responseParser] - parseAnalysisResponse(),
   *   isInsufficientContentAnswer()
   * @param {(id: string|number) => Promise<boolean>} [deps.cacheThumbnail]
   */
  constructor({
    label,
    transport,
    tokenBudget,
    promptLayout,
    resolveModel,
    checkStatus,
    clientNotReadyMessage,
    analysisTemperature = () => config.aiTemperatureAnalysis,
    responseSchema = null,
    contextWindow = null,
    prepareContent = (content) => content,
    describeFailure = (error) => error.message,
    promptBuilder = defaultPromptBuilder,
    responseParser = defaultResponseParser,
    cacheThumbnail: cacheThumbnailFn = cacheThumbnail,
  }) {
    this.label = label;
    this.transport = transport;
    this.tokenBudget = tokenBudget;
    this.promptLayout = promptLayout;
    this.resolveModel = resolveModel;
    this.clientNotReadyMessage = clientNotReadyMessage;
    this.analysisTemperature = analysisTemperature;
    this.responseSchema = responseSchema;
    this.contextWindow = contextWindow;
    this.prepareContent = prepareContent;
    this.describeFailure = describeFailure;
    this.promptBuilder = promptBuilder;
    this.responseParser = responseParser;
    this.cacheThumbnail = cacheThumbnailFn;
    this._checkStatus = checkStatus;
  }

  /** The SDK or axios client. It lives on the transport; tests replace it here. */
  get client() {
    return this.transport.client;
  }

  set client(client) {
    this.transport.client = client;
  }

  /** Usage of the last generateText() call; read by the AI review features. */
  get lastGenerateTextUsage() {
    return this.transport.lastGenerateTextUsage;
  }

  set lastGenerateTextUsage(usage) {
    this.transport.lastGenerateTextUsage = usage;
  }

  initialize() {
    this.transport.initialize();
  }

  /**
   * Analyze one document. Never throws: a failure is returned as the record
   * the OCR fallback matches on (analysisResult.js).
   *
   * @param {string} content - The document text
   * @param {Array<Object|string>} [existingTags]
   * @param {Array<Object|string>} [existingCorrespondentList]
   * @param {Array<Object|string>} [existingDocumentTypesList]
   * @param {string|number} id - Paperless document id
   * @param {string|null} [customPrompt] - Replaces the instructions (webhook)
   * @param {Object} [options]
   * @param {Object|string} [options.externalApiData] - Context to append
   * @returns {Promise<Object>} The AnalysisResult
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

      if (!this.transport.isReady()) {
        throw new Error(this.clientNotReadyMessage);
      }

      content = this.prepareContent(content);

      // Cache the thumbnail for the UI; never let it affect the analysis.
      await this.cacheThumbnail(id);

      const externalApiData = await this._externalApiData(
        options.externalApiData
      );

      const model = this.resolveModel();
      const { systemPrompt: instructions, promptTags } =
        this.promptBuilder.buildAnalysisPrompt({
          existingTags,
          existingCorrespondentList,
          existingDocumentTypesList,
          externalApiData,
          customPrompt,
        });
      if (customPrompt) {
        console.log('[DEBUG] Replace system prompt with custom prompt');
      }

      // Calculate tokens AFTER all prompt modifications are complete
      const { availableTokens } = await this.tokenBudget.reserve(
        this.promptLayout.frame(instructions, { customPrompt }),
        process.env.USE_PROMPT_TAGS === 'yes' ? [promptTags] : [],
        model
      );
      console.log(
        `[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`
      );
      console.log(
        `[DEBUG] External API data: ${externalApiData ? 'included' : 'none'}`
      );

      const fittedContent = await this.tokenBudget.fit(
        content,
        availableTokens,
        model
      );
      const { systemPrompt, userContent } = this.promptLayout.build(
        instructions,
        fittedContent,
        { customPrompt }
      );

      await writePromptToFile(systemPrompt, userContent);

      const maxResponseTokens = Number(config.responseTokens);
      const { payload, metrics } = await this.transport.complete({
        systemPrompt,
        userContent,
        model,
        temperature: this.analysisTemperature(model),
        maxResponseTokens,
        schema: this.responseSchema,
        numCtx: this.contextWindow
          ? this.contextWindow(userContent, maxResponseTokens)
          : undefined,
      });

      let parsed;
      let normalized;
      try {
        ({ parsed, normalized } =
          this.responseParser.parseAnalysisResponse(payload));
      } catch (error) {
        console.error(`Failed to parse JSON response: ${error.message}`);
        console.debug(error);
        // A model that declined the document is not a broken answer: the
        // placeholder keeps the retry loop from asking again, and the
        // document still reaches OCR (Finding 7c).
        if (this.responseParser.isInsufficientContentAnswer(payload)) {
          console.warn(`Document ${id} has insufficient content for analysis`);
          return buildInsufficientContent(id, metrics);
        }
        throw error;
      }

      await this._logResponse(normalized);

      // On the parsed answer: the defaults would turn a missing `tags` into
      // [] and let every answer pass (Finding 7k).
      assertAssignableMetadata(parsed);

      return buildSuccess(
        withDocumentDefaults(parsed),
        metrics,
        String(fittedContent).length < String(content).length
      );
    } catch (error) {
      const message = this.describeFailure(error);
      console.error(
        `Failed to analyze document with ${this.label}: ${message}`
      );
      console.debug(error);
      return buildFailure(error, message);
    }
  }

  /**
   * The external API data as prompt text, cut to its token share; null when
   * there is none or it cannot be read.
   *
   * @param {Object|string|undefined} apiData
   * @returns {Promise<string|null>}
   */
  async _externalApiData(apiData) {
    if (!apiData) {
      return null;
    }
    try {
      const data = await this._validateAndTruncateExternalApiData(apiData);
      console.log('[DEBUG] External API data validated and included');
      return data;
    } catch (error) {
      console.warn(
        '[WARNING] External API data validation failed:',
        error.message
      );
      return null;
    }
  }

  /**
   * Validate and truncate external API data to prevent token overflow
   * @param {any} apiData - The external API data to validate
   * @param {number} maxTokens - Maximum tokens allowed for external data
   * @returns {Promise<string>} - Validated and potentially truncated data string
   */
  async _validateAndTruncateExternalApiData(
    apiData,
    maxTokens = EXTERNAL_API_DATA_MAX_TOKENS
  ) {
    const dataString =
      typeof apiData === 'object'
        ? JSON.stringify(apiData, null, 2)
        : String(apiData);

    const model = this.resolveModel();
    const dataTokens = await this.tokenBudget.count(dataString, model);

    if (dataTokens > maxTokens) {
      console.warn(
        `[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`
      );
      return await this.tokenBudget.cut(dataString, maxTokens, model);
    }

    console.log(`[DEBUG] External API data validated: ${dataTokens} tokens`);
    return dataString;
  }

  /** Append the answer to data/logs/response.txt; best effort. */
  async _logResponse(normalized) {
    const responseLogPath = path.join(
      process.cwd(),
      'data',
      'logs',
      'response.txt'
    );
    try {
      await fs.mkdir(path.dirname(responseLogPath), { recursive: true });
      await fs.appendFile(responseLogPath, `${normalized}\n`);
    } catch (logError) {
      console.warn('Failed to write AI response log:', logError.message);
    }
  }

  /**
   * Generate text based on a prompt. The request dialect, streaming and the
   * usage seam live on the transport and its provider's buildRequest(); a
   * provider that sizes its own context gets the sizes handed in.
   *
   * @param {string} prompt
   * @param {object} [options] - As read by aiGenerateOptions: systemPrompt,
   *   temperature, maxTokens, model, signal, onProgress, reasoning
   * @returns {Promise<string>} The generated text
   */
  async generateText(prompt, options = {}) {
    if (!this.contextWindow) {
      return this.transport.generate(prompt, options);
    }
    const responseTokens =
      hasNumber(options.maxTokens) && options.maxTokens > 0
        ? Math.floor(options.maxTokens)
        : Number(config.responseTokens);
    return this.transport.generate(prompt, options, {
      responseTokens,
      numCtx: this.contextWindow(prompt, responseTokens),
    });
  }

  /** The provider's status probe, unchanged (row g; decided with step 8). */
  checkStatus() {
    return this._checkStatus(this);
  }
}

module.exports = { DocumentAnalyzer };
