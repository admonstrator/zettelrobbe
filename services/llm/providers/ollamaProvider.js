'use strict';

/**
 * The Ollama composition root: the DocumentAnalyzer wired to the
 * /api/generate transport, the character budget and Ollama's prompt layout.
 * What is Ollama's own lives here — the axios client, the output schema, the
 * num_ctx sizing, the CONTENT_MAX_LENGTH cut and the /api/ps status probe.
 * services/ollamaService.js re-exports the singleton.
 *
 * The singleton keeps the seams the tests call or stub: apiUrl, model,
 * documentAnalysisSchema, _buildPrompt(), _callOllamaAPI(),
 * _calculatePromptTokenCount(), _calculateNumCtx(), _extractOllamaMetrics().
 * The context is sized through _calculatePromptTokenCount() and
 * _calculateNumCtx(), so a stub there reaches the request.
 */

const axios = require('axios');
const config = require('../../../config/config');
const { DocumentAnalyzer } = require('../documentAnalyzer');
const {
  OllamaGenerateTransport,
} = require('../transports/ollamaGenerateTransport');
const charBudget = require('../tokenBudget/charBudget');
const { buildAnalysisPrompt } = require('../promptBuilder');
const { ollamaPromptLayout, ollamaPrompt } = require('../promptLayout');

/** The output schema Ollama is held to (`format`). */
const DOCUMENT_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    correspondent: { type: 'string' },
    tags: {
      type: 'array',
      items: { type: 'string' },
    },
    document_type: { type: 'string' },
    document_date: { type: 'string' },
    language: { type: 'string' },
    custom_fields: {
      type: 'object',
      additionalProperties: true,
    },
  },
  required: [
    'title',
    'correspondent',
    'tags',
    'document_type',
    'document_date',
    'language',
  ],
};

/** Tokens the external API data may take up in the prompt. */
const EXTERNAL_API_DATA_MAX_TOKENS = 500;

/** CONTENT_MAX_LENGTH, Ollama's own cut before the budget (kept as is). */
function truncateContent(content) {
  try {
    if (process.env.CONTENT_MAX_LENGTH) {
      console.log(
        'Truncating content to max length:',
        process.env.CONTENT_MAX_LENGTH
      );
      return content.substring(0, process.env.CONTENT_MAX_LENGTH);
    }
  } catch (error) {
    console.error(`Error truncating content: ${error.message}`);
    console.debug(error);
  }
  return content;
}

/** The external API data as prompt text, cut the character-budget way. */
function externalApiDataForPrompt(apiData) {
  const dataString =
    typeof apiData === 'object'
      ? JSON.stringify(apiData, null, 2)
      : String(apiData);
  return charBudget.count(dataString) > EXTERNAL_API_DATA_MAX_TOKENS
    ? charBudget.cut(dataString, EXTERNAL_API_DATA_MAX_TOKENS)
    : dataString;
}

async function checkStatus(provider) {
  // use ollama status endpoint
  try {
    const response = await provider.client.get(`${provider.apiUrl}/api/ps`, {
      headers: provider._buildRequestHeaders(),
    });
    if (response.status === 200) {
      const data = response.data;
      // Ensure data is an array and has at least one model
      let modelName = null;
      if (Array.isArray(data.models) && data.models.length > 0) {
        modelName = data.models[0].name;
      }
      console.log('Ollama model name:', modelName);
      return { status: 'ok', model: modelName };
    }
  } catch (error) {
    console.error(`Error checking Ollama service status: ${error.message}`);
    console.debug(error);
  }
  return { status: 'error' };
}

const transport = new OllamaGenerateTransport({
  client: axios.create({
    timeout: 1800000, // 30 minutes timeout
  }),
  apiUrl: config.ollama.apiUrl,
  model: config.ollama.model,
});

const ollamaProvider = new DocumentAnalyzer({
  label: 'Ollama',
  transport,
  tokenBudget: charBudget,
  promptLayout: ollamaPromptLayout,
  resolveModel: () => transport.model,
  responseSchema: DOCUMENT_ANALYSIS_SCHEMA,
  contextWindow: (promptText, responseTokens) =>
    ollamaProvider._calculateNumCtx(
      ollamaProvider._calculatePromptTokenCount(promptText),
      responseTokens
    ),
  prepareContent: truncateContent,
  checkStatus,
  clientNotReadyMessage: 'Ollama client not initialized',
});

Object.defineProperties(ollamaProvider, {
  apiUrl: {
    get() {
      return this.transport.apiUrl;
    },
    set(apiUrl) {
      this.transport.apiUrl = apiUrl;
    },
    enumerable: true,
  },
  model: {
    get() {
      return this.transport.model;
    },
    set(model) {
      this.transport.model = model;
    },
    enumerable: true,
  },
  documentAnalysisSchema: {
    get() {
      return this.responseSchema;
    },
    set(schema) {
      this.responseSchema = schema;
    },
    enumerable: true,
  },
});

Object.assign(ollamaProvider, {
  /**
   * The analysis prompt for a document: the instructions, then the document.
   * @param {string} content - The document text
   * @param {string[]} [existingTags]
   * @param {string[]} [existingCorrespondent]
   * @param {string[]} [existingDocumentTypes]
   * @param {Object} [options] - May carry externalApiData
   * @returns {string}
   */
  _buildPrompt(
    content,
    existingTags = [],
    existingCorrespondent = [],
    existingDocumentTypes = [],
    options = {}
  ) {
    const { systemPrompt } = buildAnalysisPrompt({
      existingTags,
      existingCorrespondentList: Array.isArray(existingCorrespondent)
        ? existingCorrespondent
        : [],
      existingDocumentTypesList: existingDocumentTypes,
      externalApiData: options.externalApiData
        ? externalApiDataForPrompt(options.externalApiData)
        : null,
    });
    return ollamaPrompt(systemPrompt, content);
  },

  /** Estimated tokens of a prompt, two characters each. */
  _calculatePromptTokenCount(prompt) {
    return charBudget.estimateTokens(prompt);
  },

  /** The context window to request: prompt plus answer, at most TOKEN_LIMIT. */
  _calculateNumCtx(promptTokenCount, expectedResponseTokens) {
    const numCtx = charBudget.numCtx(promptTokenCount, expectedResponseTokens);

    console.log('Prompt Token Count:', promptTokenCount);
    console.log('Expected Response Tokens:', expectedResponseTokens);
    console.log('Dynamic calculated num_ctx:', numCtx);

    return numCtx;
  },

  /** Request headers, with bearer auth when an API key is set. */
  _buildRequestHeaders() {
    return this.transport.buildHeaders();
  },

  /**
   * Send one analysis request as it is.
   * @param {string} prompt - Prompt text
   * @param {string} systemPrompt - System prompt
   * @param {number} numCtx - Context window size
   * @param {Object} schema - Response schema
   * @returns {Promise<Object>} The raw /api/generate response data
   */
  async _callOllamaAPI(prompt, systemPrompt, numCtx, schema) {
    const { raw } = await this.transport.complete({
      systemPrompt,
      userContent: prompt,
      temperature: config.aiTemperatureAnalysis,
      maxResponseTokens: Number(config.responseTokens),
      numCtx,
      schema,
    });
    return raw;
  },

  /** See OllamaGenerateTransport.assertNotTruncated(). */
  _assertNotTruncated(responseData, numPredict, numCtx, extra) {
    this.transport.assertNotTruncated(responseData, numPredict, numCtx, extra);
  },

  /** Token usage of an /api/generate response. */
  _extractOllamaMetrics(responseData) {
    return this.transport.extractMetrics(responseData);
  },
});

module.exports = ollamaProvider;
