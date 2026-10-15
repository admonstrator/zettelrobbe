'use strict';

/**
 * The OpenAI composition root: the DocumentAnalyzer wired to the chat
 * completions transport and the tiktoken budget. What is OpenAI's own lives
 * here — the client, the model, the generateText() request dialect and the
 * status probe. services/openaiService.js re-exports the singleton.
 */

const OpenAI = require('openai');
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
const TRUNCATION_REMEDY =
  'Reduce the number of custom fields the prompt asks for, or use a model with a larger completion limit.';

/**
 * The factory hands this service out for the openai provider only (and as
 * its default for an unknown one), so there is no client for any other.
 */
function createClient() {
  if (config.aiProvider === 'openai' && config.openai.apiKey) {
    return new OpenAI({
      apiKey: config.openai.apiKey,
    });
  }
  return null;
}

/**
 * The generateText() request. The transport sends it, streams it and reads
 * the answer; what differs between the providers is here.
 *
 * @param {string} prompt
 * @param {object} options - see DocumentAnalyzer.generateText()
 * @param {number} [options.maxTokens] - Completion cap for this call; without
 *   one the model answers with whatever the deployment allows
 * @param {boolean} [options.reasoning] - false sends reasoning_effort on the
 *   model families that take it and nothing on the others, which have no
 *   thinking switch; true and null send nothing
 * @returns {Object} The chat completions request
 */
function buildGenerationRequest(prompt, options) {
  const model =
    modelOverride(options) || process.env.OPENAI_MODEL || config.openai.model;
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
  };
  // Without a cap the model answers with whatever the deployment allows,
  // which is what every caller before the AI review wanted.
  if (hasNumber(options.maxTokens) && options.maxTokens > 0) {
    request.max_tokens = Math.floor(options.maxTokens);
  }
  // The one thinking switch this API has, and it exists on the reasoning
  // families only: an ordinary model answers 400 for the field, so it is
  // sent for those names and for no others, and only when the caller
  // asked for no thinking.
  if (reasoningEnabled(options) === false) {
    const effort = reasoningEffortForOpenAi(model);
    if (effort) request.reasoning_effort = effort;
  }

  return request;
}

async function checkStatus(provider) {
  // Use a token-free endpoint for connectivity/auth checks.
  try {
    provider.initialize();

    if (!provider.client) {
      throw new Error('OpenAI client not initialized - missing API key');
    }

    await provider.client.models.list();
    return { status: 'ok', model: process.env.OPENAI_MODEL };
  } catch (error) {
    console.error(`Error checking OpenAI status: ${error.message}`);
    console.debug(error);
    return { status: 'error', error: error.message };
  }
}

module.exports = new DocumentAnalyzer({
  label: 'OpenAI',
  transport: new ChatCompletionsTransport({
    label: 'OpenAI',
    createClient,
    generation: {
      notReadyMessage: 'OpenAI client not initialized - missing API key',
      remedy: TRUNCATION_REMEDY,
      buildRequest: buildGenerationRequest,
    },
  }),
  tokenBudget: tiktokenBudget,
  promptLayout: chatPromptLayout,
  resolveModel: () => process.env.OPENAI_MODEL,
  // o3-mini rejects the parameter.
  analysisTemperature: (model) =>
    model !== 'o3-mini' ? config.aiTemperatureAnalysis : undefined,
  checkStatus,
  clientNotReadyMessage: 'OpenAI client not initialized',
});
