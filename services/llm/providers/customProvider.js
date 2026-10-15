'use strict';

/**
 * The composition root for any OpenAI-compatible server behind a custom base
 * URL: the DocumentAnalyzer wired to the chat completions transport and the
 * tiktoken budget. What is Custom's own lives here — the client, the
 * detailed "Invalid API response structure" messages, the generateText()
 * request with its context clamp and three reasoning dialects, the timeout
 * wording (rows e/m, kept as they are) and the status probe.
 * services/customService.js re-exports the singleton.
 */

const OpenAI = require('openai');
const config = require('../../../config/config');
const {
  calculateTokens,
  isTimeoutError,
  buildTimeoutErrorMessage,
} = require('../../serviceUtils');
const {
  hasNumber,
  hasSystemPrompt,
  modelOverride,
  reasoningEffortForCompatible,
  reasoningEnabled,
} = require('../../aiGenerateOptions');
const { DocumentAnalyzer } = require('../documentAnalyzer');
const {
  ChatCompletionsTransport,
} = require('../transports/chatCompletionsTransport');
const tiktokenBudget = require('../tokenBudget/tiktokenBudget');
const { chatPromptLayout } = require('../promptLayout');

const CUSTOM_PROVIDER_FALLBACK_API_KEY = 'no-auth-required';
/** What an operator can do about an answer that hit the completion cap. */
const TRUNCATION_REMEDY = 'Raise Response Tokens (RESPONSE_TOKENS).';
/**
 * The soft switch the Qwen family reads out of the prompt itself.
 *
 * `chat_template_kwargs` only reaches a server that applies the model's chat
 * template; a gateway that forwards the messages and drops the rest leaves the
 * model thinking anyway. Qwen understands the same wish written into the last
 * line of the user message, so both are sent and whichever arrives wins.
 */
const QWEN_NO_THINK_SWITCH = '/no_think';
/** Models that understand the line above. */
const QWEN_MODEL_PATTERN = /qwen/i;

function createClient() {
  return config.aiProvider === 'custom'
    ? new OpenAI({
        baseURL: config.custom.apiUrl,
        // OpenAI-compatible SDKs require an apiKey value even when auth is disabled.
        apiKey: config.custom.apiKey || CUSTOM_PROVIDER_FALLBACK_API_KEY,
      })
    : null;
}

/**
 * Every message keeps the "Invalid API response structure" prefix:
 * shouldQueueForOcrOnAiError() matches on that phrase, and without it
 * the document no longer reaches the OCR fallback.
 */
function describeMissingContent(response, message) {
  const missing = !response
    ? 'the response is empty'
    : !response.choices
      ? 'missing choices'
      : !response.choices[0]
        ? 'missing choices[0]'
        : !response.choices[0].message
          ? 'missing choices[0].message'
          : !response.choices[0].message.content
            ? 'missing choices[0].message.content'
            : `unusable content ${message?.content}`;
  return `Invalid API response structure: ${missing}.`;
}

/**
 * Say what came back: a gateway that timed out behind a 200, a
 * model that stopped after its reasoning without an answer, or an
 * empty choices array all end here and need telling apart.
 */
function describeEmptyText(response) {
  const finishReason = response?.choices?.[0]?.finish_reason ?? 'unknown';
  const head = JSON.stringify(response ?? null).slice(0, 200);
  return `Invalid API response structure: the answer carried no text (finish_reason ${finishReason}; the response begins ${head})`;
}

/**
 * The generateText() request. The transport sends it, streams it and reads
 * the answer; what differs between the providers is here.
 *
 * @param {string} prompt
 * @param {object} options - see DocumentAnalyzer.generateText()
 * @param {number} [options.maxTokens] - Overrides RESPONSE_TOKENS, still clamped
 * @param {boolean} [options.reasoning] - Switches the model's thinking off
 *   or on for this one call; nothing new is sent when the caller says
 *   nothing. Off also sends reasoning_effort where the model family takes it
 * @returns {Promise<Object>} The chat completions request
 */
async function buildGenerationRequest(prompt, options) {
  const model = modelOverride(options) || config.custom.model;
  const maxContextTokens = Number(config.tokenLimit) || 128000;
  const desiredCompletionTokens =
    hasNumber(options.maxTokens) && options.maxTokens > 0
      ? Math.floor(options.maxTokens)
      : Number(config.responseTokens) || 1000;
  const promptTokens = await calculateTokens(prompt, model);
  const availableCompletionTokens = Math.max(
    1,
    maxContextTokens - promptTokens - 64
  );
  const maxCompletionTokens = Math.max(
    1,
    Math.min(desiredCompletionTokens, availableCompletionTokens)
  );

  if (maxCompletionTokens < desiredCompletionTokens) {
    console.log(
      `[DEBUG] Clamped max_tokens for custom generateText from ${desiredCompletionTokens} to ${maxCompletionTokens} ` +
        `(context limit: ${maxContextTokens}, prompt tokens: ${promptTokens})`
    );
  }

  const reasoning = reasoningEnabled(options);
  const messages = [];
  if (hasSystemPrompt(options)) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({
    role: 'user',
    content:
      reasoning === false && QWEN_MODEL_PATTERN.test(model)
        ? `${prompt}\n${QWEN_NO_THINK_SWITCH}`
        : prompt,
  });

  const request = {
    model: model,
    messages,
    temperature: hasNumber(options.temperature)
      ? options.temperature
      : config.aiTemperatureGeneration,
    max_tokens: maxCompletionTokens,
  };
  // The key every OpenAI-compatible server that applies a chat template
  // understands; one that does not know it passes it through and the
  // model decides for itself, as it did before.
  if (reasoning !== null) {
    request.chat_template_kwargs = { enable_thinking: reasoning };
  }
  // A hosted reasoning model reads neither of the two above and thinks
  // anyway; the families that take reasoning_effort are told in their own
  // dialect. Only when the caller asked for no thinking, and only for
  // those names — another model answers 400 for the field.
  if (reasoning === false) {
    const effort = reasoningEffortForCompatible(model);
    if (effort) request.reasoning_effort = effort;
  }

  return request;
}

/** Only Custom words a timeout as such (rows e/m, kept as they are). */
function describeFailure(error) {
  if (!isTimeoutError(error)) {
    return error.message;
  }
  console.error(
    `[TIMEOUT][AI] Custom provider request timed out: ${error.message}`
  );
  return buildTimeoutErrorMessage('AI');
}

async function checkStatus(provider) {
  try {
    provider.initialize();

    if (!provider.client) {
      throw new Error('Custom OpenAI client not initialized - missing API key');
    }

    const model = config.custom.model;

    // Use token-free endpoint where supported by OpenAI-compatible providers.
    await provider.client.models.list();

    return { status: 'ok', model: model };
  } catch (error) {
    console.error(`Error generating text with Custom OpenAI: ${error.message}`);
    console.debug(error);
    return { status: 'error', error: error.message };
  }
}

module.exports = new DocumentAnalyzer({
  label: 'Custom OpenAI',
  transport: new ChatCompletionsTransport({
    label: 'Custom OpenAI',
    createClient,
    describeMissingContent,
    generation: {
      notReadyMessage: 'Custom OpenAI client not initialized - missing API key',
      remedy: TRUNCATION_REMEDY,
      buildRequest: buildGenerationRequest,
      describeEmptyText,
    },
  }),
  tokenBudget: tiktokenBudget,
  promptLayout: chatPromptLayout,
  resolveModel: () => config.custom.model,
  describeFailure,
  checkStatus,
  clientNotReadyMessage: 'Custom OpenAI client not initialized',
});
