'use strict';

/**
 * The Azure OpenAI composition root: the DocumentAnalyzer wired to the chat
 * completions transport and the tiktoken budget. What is Azure's own lives
 * here — the client, the deployment as the model, the generateText()
 * request dialect, the API-version gate for streamed usage and the
 * deployment probe. services/azureService.js re-exports the singleton.
 */

const axios = require('axios');
const AzureOpenAI = require('openai').AzureOpenAI;
const config = require('../../../config/config');
const {
  hasNumber,
  hasSystemPrompt,
  modelOverride,
  reasoningEffortForOpenAi,
  reasoningEnabled,
} = require('../../aiGenerateOptions');
const { DocumentAnalyzer } = require('../documentAnalyzer');
const {
  ChatCompletionsTransport,
} = require('../transports/chatCompletionsTransport');
const tiktokenBudget = require('../tokenBudget/tiktokenBudget');
const { chatPromptLayout } = require('../promptLayout');

/** What an operator can do about an answer that hit the completion cap. */
const TRUNCATION_REMEDY = 'Raise Response Tokens (RESPONSE_TOKENS).';
/**
 * The first Azure API version that answers a streamed request with a usage
 * chunk. Older versions reject `stream_options` outright, which would turn a
 * working deployment into a 400 the moment progress is asked for.
 */
const STREAM_OPTIONS_SINCE = '2024-06-01';
/** Version aliases that always mean "the newest surface". */
const ROLLING_API_VERSIONS = ['preview', 'latest', 'v1'];

/**
 * Whether the configured API version understands
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

function createClient() {
  return config.aiProvider === 'azure'
    ? new AzureOpenAI({
        apiKey: config.azure.apiKey,
        endpoint: config.azure.endpoint,
        deploymentName: config.azure.deploymentName,
        apiVersion: config.azure.apiVersion,
      })
    : null;
}

/**
 * The generateText() request. The transport sends it, streams it and reads
 * the answer; what differs between the providers is here.
 *
 * @param {string} prompt
 * @param {object} options - see DocumentAnalyzer.generateText()
 * @param {number} [options.maxTokens] - Overrides RESPONSE_TOKENS
 * @param {boolean} [options.reasoning] - false sends reasoning_effort on the
 *   deployments that take it and nothing on the others, which have no
 *   thinking switch; true and null send nothing
 * @returns {Object} The chat completions request
 */
function buildGenerationRequest(prompt, options) {
  const model = modelOverride(options) || process.env.AZURE_DEPLOYMENT_NAME;
  const messages = [];
  if (hasSystemPrompt(options)) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const request = {
    model: model,
    messages,
    temperature: hasNumber(options.temperature)
      ? options.temperature
      : config.aiTemperatureGeneration,
    // Was a hardcoded 1000, which quarrelled with the setting the same way
    // Ollama's num_predict did — the reservation followed the operator,
    // the limit did not.
    max_tokens:
      hasNumber(options.maxTokens) && options.maxTokens > 0
        ? Math.floor(options.maxTokens)
        : Number(config.responseTokens),
  };
  // As on OpenAI: the reasoning deployments take reasoning_effort, every
  // other one answers 400 for it, so it is sent for those names only and
  // only when the caller asked for no thinking.
  if (reasoningEnabled(options) === false) {
    const effort = reasoningEffortForOpenAi(model);
    if (effort) request.reasoning_effort = effort;
  }

  return request;
}

async function checkStatus(provider) {
  try {
    provider.initialize();

    if (!provider.client) {
      throw new Error('Azure OpenAI client not initialized - missing API key');
    }

    const model = process.env.AZURE_DEPLOYMENT_NAME;

    // Token-free health check against deployment metadata endpoint.
    const endpoint = (config.azure.endpoint || '').replace(/\/$/, '');
    const apiVersion = config.azure.apiVersion;
    if (!endpoint || !apiVersion || !model) {
      throw new Error('Azure endpoint, apiVersion, or deployment name missing');
    }

    const url = `${endpoint}/openai/deployments/${model}?api-version=${encodeURIComponent(apiVersion)}`;
    const response = await axios.get(url, {
      headers: {
        'api-key': config.azure.apiKey,
      },
      timeout: 10000,
    });

    if (response.status < 200 || response.status >= 300) {
      return { status: 'error' };
    }

    return { status: 'ok', model: model };
  } catch (error) {
    console.error(`Error generating text with Azure OpenAI: ${error.message}`);
    console.debug(error);
    return { status: 'error', error: error.message };
  }
}

module.exports = new DocumentAnalyzer({
  label: 'AzureOpenAI',
  transport: new ChatCompletionsTransport({
    label: 'AzureOpenAI',
    createClient,
    generation: {
      notReadyMessage: 'AzureOpenAI client not initialized - missing API key',
      remedy: TRUNCATION_REMEDY,
      buildRequest: buildGenerationRequest,
      // Only where the configured API version takes it; an older one would
      // answer 400 instead of streaming, so that deployment estimates.
      streamUsage: () => supportsStreamOptions(config.azure.apiVersion),
    },
  }),
  tokenBudget: tiktokenBudget,
  promptLayout: chatPromptLayout,
  resolveModel: () => process.env.AZURE_DEPLOYMENT_NAME,
  checkStatus,
  clientNotReadyMessage: 'AzureOpenAI client not initialized',
});
