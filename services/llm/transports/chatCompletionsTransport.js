'use strict';

/**
 * Talks to one chat completions API: OpenAI, Azure OpenAI, or any
 * OpenAI-compatible server behind a custom base URL.
 *
 * A transport owns the client and the request/response mapping, and nothing
 * else. It throws on a transport failure and on a provider-reported cut-off
 * (error.code 'ai_response_truncated'); it never shapes an analysis result —
 * that is analysisResult.js.
 */

const {
  assertCompletionNotTruncated,
  extractChatMessageContent,
} = require('../../serviceUtils');
const {
  abortSignal,
  abortedGenerationError,
  isAbortError,
  progressHandler,
  readCompletionUsage,
  runChatCompletionStream,
  stripReasoningText,
} = require('../../aiGenerateOptions');

/** What an operator can do about an analysis answer that hit the cap. */
const ANALYSIS_TRUNCATION_REMEDY =
  'Reduce the number of custom fields the prompt asks for, or use a model with a larger completion limit.';

class ChatCompletionsTransport {
  /**
   * @param {Object} options
   * @param {string} options.label - Provider name used in logs and errors
   * @param {() => Object|null} options.createClient - Builds the SDK client;
   *   null when the provider is not configured, which leaves it not ready
   * @param {(response:Object, message:Object) => string} [options.describeMissingContent]
   *   The error message for an answer without usable text. It must keep the
   *   "Invalid API response structure" phrase the OCR fallback matches on.
   * @param {Object} [options.generation] - What generate() needs from the provider
   * @param {string} options.generation.notReadyMessage - Thrown without a client
   * @param {(prompt:string, options:Object) => Promise<Object>} options.generation.buildRequest
   *   The provider's request: model, messages and its own knobs (temperature
   *   default, max_tokens policy, reasoning fields). The dialects differ for
   *   real, so they stay with the provider.
   * @param {string} options.generation.remedy - Named when the answer is cut off
   * @param {() => boolean} [options.generation.streamUsage] - Whether a
   *   streamed request may ask for its usage (stream_options.include_usage)
   * @param {(response:Object) => string} [options.generation.describeEmptyText]
   *   The error message for an answer without text
   */
  constructor({ label, createClient, describeMissingContent, generation }) {
    this.label = label;
    this.client = null;
    /** Usage of the last generate() call; read by the AI review features. */
    this.lastGenerateTextUsage = null;
    this._createClient = createClient;
    this._describeMissingContent =
      describeMissingContent || (() => 'Invalid API response structure');
    this._generation = {
      streamUsage: () => true,
      describeEmptyText: () => 'Invalid API response structure',
      ...generation,
    };
  }

  /** Build the client on first use; a client set from outside is kept. */
  initialize() {
    if (!this.client) {
      this.client = this._createClient() || null;
    }
  }

  isReady() {
    return Boolean(this.client);
  }

  /**
   * Send one analysis request.
   *
   * @param {Object} request
   * @param {string} request.systemPrompt
   * @param {string} request.userContent
   * @param {string} request.model
   * @param {number} [request.temperature] - Not sent when undefined
   * @returns {Promise<{payload:string, metrics:{promptTokens:number, completionTokens:number, totalTokens:number}}>}
   */
  async complete({ systemPrompt, userContent, model, temperature }) {
    const timestamp = new Date().toLocaleString('de-DE', {
      dateStyle: 'short',
      timeStyle: 'short',
    });

    const response = await this.client.chat.completions.create({
      model: model,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userContent,
        },
      ],
      ...(temperature !== undefined && { temperature }),
    });

    assertCompletionNotTruncated(
      response,
      this.label,
      ANALYSIS_TRUNCATION_REMEDY
    );
    const message = response?.choices?.[0]?.message;
    const payload = extractChatMessageContent(message, this.label);
    if (!payload) {
      throw new Error(this._describeMissingContent(response, message));
    }

    console.log(`[DEBUG] [${timestamp}] ${this.label} request sent`);
    console.log(
      `[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`
    );

    const usage = response.usage;
    return {
      payload,
      metrics: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      },
    };
  }

  /**
   * Send one generation request and return its text.
   *
   * @param {string} prompt
   * @param {Object} [options] - As read by aiGenerateOptions: signal,
   *   onProgress, and whatever the provider's buildRequest() reads
   * @returns {Promise<string>} The answer, reasoning stripped
   */
  async generate(prompt, options = {}) {
    // Read before the try so the catch can tell a stopped request from a
    // failed one.
    const signal = abortSignal(options);
    const onProgress = progressHandler(options);
    const generation = this._generation;

    try {
      this.initialize();

      if (!this.client) {
        throw new Error(generation.notReadyMessage);
      }

      const request = await generation.buildRequest(prompt, options);

      this.lastGenerateTextUsage = null;
      // The second argument is the SDK's request option bag; a caller that
      // brought no signal gets the call it always got.
      const requestOptions = signal ? { signal } : null;

      if (onProgress) {
        const streamRequest = { ...request, stream: true };
        // include_usage buys the exact completion count at the end of the
        // stream; without it the report is an estimate all the way.
        if (generation.streamUsage()) {
          streamRequest.stream_options = { include_usage: true };
        }
        return await runChatCompletionStream({
          client: this.client,
          request: streamRequest,
          requestOptions,
          signal,
          onProgress,
          provider: this.label,
          remedy: generation.remedy,
          onUsage: (usage) => {
            this.lastGenerateTextUsage = usage;
          },
        });
      }

      const response = requestOptions
        ? await this.client.chat.completions.create(request, requestOptions)
        : await this.client.chat.completions.create(request);
      this.lastGenerateTextUsage = readCompletionUsage(response);

      const message = response?.choices?.[0]?.message;
      // Reasoning is no part of the answer, and a block the cut-off left
      // open is no part of it either.
      const generatedText = extractChatMessageContent(
        { ...message, content: stripReasoningText(message?.content) },
        this.label
      );

      // After the text is in hand: a cut-off answer is still a failure, but
      // the caller can keep the prefix instead of paying for it twice.
      assertCompletionNotTruncated(response, this.label, generation.remedy, {
        partialText: generatedText,
      });

      if (!generatedText) {
        throw new Error(generation.describeEmptyText(response));
      }

      return generatedText;
    } catch (error) {
      // One name for a stopped request, whatever the client called it; an
      // abort this transport raised already carries its partial text.
      const thrown =
        isAbortError(error, signal) && error?.name !== 'AbortError'
          ? abortedGenerationError(error, '')
          : error;
      console.error(
        `Error generating text with ${this.label}: ${thrown.message}`
      );
      console.debug(thrown);
      throw thrown;
    }
  }
}

module.exports = { ChatCompletionsTransport, ANALYSIS_TRUNCATION_REMEDY };
