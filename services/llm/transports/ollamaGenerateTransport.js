'use strict';

/**
 * Talks to Ollama's native /api/generate.
 *
 * Owns what makes Ollama different from the chat completions APIs: a prompt
 * and a system string instead of messages, a `format` schema for structured
 * output, num_ctx/num_predict, the `think` switch, one bounded retry for
 * transient failures, and the done_reason cut-off check. Like every
 * transport it throws on failure and never shapes an analysis result.
 *
 * The axios client is handed in rather than created here: the service builds
 * it, and tests replace it there.
 */

const config = require('../../../config/config');
const {
  abortSignal,
  abortedGenerationError,
  createProgressCollector,
  hasNumber,
  hasSystemPrompt,
  isAbortError,
  modelOverride,
  progressHandler,
  reasoningEnabled,
  stripReasoningText,
} = require('../../aiGenerateOptions');

/**
 * One bounded retry for transient failures (backend EOF, 5xx). The field
 * report behind this: an MLX runner closed its connection once under memory
 * pressure; the immediate second attempt succeeded.
 */
const MAX_ATTEMPTS = 2;

class OllamaGenerateTransport {
  /**
   * @param {Object} options
   * @param {Object} options.client - axios instance
   * @param {string} options.apiUrl - Ollama base URL
   * @param {string} options.model - Default model
   * @param {number} [options.retryDelayMs=1000] - Pause before the retry
   */
  constructor({ client, apiUrl, model, retryDelayMs = 1000 }) {
    this.label = 'Ollama';
    this.client = client;
    this.apiUrl = apiUrl;
    this.model = model;
    this.retryDelayMs = retryDelayMs;
    /** Usage of the last generate() call; read by the AI review features. */
    this.lastGenerateTextUsage = null;
  }

  initialize() {}

  isReady() {
    return Boolean(this.client);
  }

  /**
   * Build request headers, adding bearer auth when an API key is set.
   * The key is read at request time, so runtime config changes apply
   * without re-instantiating the singleton.
   * @returns {Object} Headers object
   */
  buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OLLAMA_API_KEY || config.ollama.apiKey || '';
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  /**
   * Extract the cause an Ollama (or its inference backend) reported in a
   * non-2xx response body. Ollama wraps backend failures — its runner closing
   * the connection on an oversized prompt, for example — into
   * `{ error: 'Post "http://…/v1/completions": EOF' }`; without this the
   * operator only ever sees "Request failed with status code 500" and cannot
   * tell an Ollama problem from a model-backend problem.
   *
   * @param {Object} axiosError
   * @returns {string|null}
   */
  extractUpstreamErrorMessage(axiosError) {
    const data = axiosError?.response?.data;
    if (!data) return null;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      try {
        return JSON.parse(trimmed)?.error || trimmed || null;
      } catch {
        return trimmed || null;
      }
    }
    return data.error || data.message || null;
  }

  /**
   * True for failures worth one more attempt: the connection dropped or the
   * server answered 5xx. A 4xx is a request problem and will fail again.
   *
   * @param {Object} axiosError
   * @returns {boolean}
   */
  isTransientFailure(axiosError) {
    if (!axiosError.response) {
      // No response at all: connection refused/reset/timeout.
      return true;
    }
    return axiosError.response.status >= 500;
  }

  /**
   * Wrap an axios failure with the upstream detail attached.
   *
   * @param {Object} axiosError - The axios error being wrapped
   * @param {number} attempt - Which attempt failed (1-based)
   * @returns {Error}
   */
  wrapRequestError(axiosError, attempt) {
    const upstream = this.extractUpstreamErrorMessage(axiosError);
    const status = axiosError?.response?.status;
    const detail = upstream ? `: ${upstream}` : '';
    const wrapped = new Error(
      `Ollama request failed (HTTP ${status || 'no response'}, attempt ${attempt})${detail}`,
      { cause: axiosError }
    );
    // Keep the axios code so the scan-loop classification (OCR fallback,
    // failure reasons) keeps working unchanged.
    wrapped.code = axiosError.code;
    return wrapped;
  }

  /**
   * Send one analysis request.
   *
   * @param {Object} request
   * @param {string} request.systemPrompt - Sent as `system`
   * @param {string} request.userContent - Sent as `prompt`
   * @param {string} [request.model] - Defaults to the transport's model
   * @param {number} request.temperature
   * @param {number} request.maxResponseTokens - Sent as num_predict
   * @param {number} request.numCtx - Context window to request
   * @param {Object|null} request.schema - Sent as `format`
   * @returns {Promise<{payload:string|Object, metrics:Object, raw:Object}>}
   */
  async complete({
    systemPrompt,
    userContent,
    model,
    temperature,
    maxResponseTokens,
    numCtx,
    schema,
  }) {
    const numPredict = maxResponseTokens;
    const requestBody = {
      model: model || this.model,
      prompt: userContent,
      system: systemPrompt,
      stream: false,
      format: schema,
      options: {
        temperature,
        top_p: 0.9,
        repeat_penalty: 1.1,
        top_k: 7,
        num_predict: numPredict,
        num_ctx: numCtx,
      },
    };

    // Disable thinking for reasoning models (e.g. Qwen3, DeepSeek-R1)
    // unless explicitly enabled via OLLAMA_THINK=true
    if (!config.ollama.think) {
      requestBody.think = false;
    }

    let response;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        response = await this.client.post(
          `${this.apiUrl}/api/generate`,
          requestBody,
          {
            headers: this.buildHeaders(),
          }
        );
        break;
      } catch (error) {
        const wrapped = this.wrapRequestError(error, attempt);
        console.error(`[ERROR] ${wrapped.message}`);
        if (attempt >= MAX_ATTEMPTS || !this.isTransientFailure(error)) {
          throw wrapped;
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }

    if (!response?.data) {
      throw new Error('Invalid response from Ollama API');
    }

    this.assertNotTruncated(response.data, numPredict, numCtx);
    // Worded unlike the chat providers' "Invalid API response structure", so
    // it matches no OCR marker (row l, kept as it is).
    if (!response.data.response) {
      throw new Error('No response data from Ollama API');
    }
    return {
      payload: response.data.response,
      metrics: this.extractMetrics(response.data),
      raw: response.data,
    };
  }

  /**
   * Send one generation request and return its text.
   *
   * @param {string} prompt
   * @param {object} [options] - As read by aiGenerateOptions: systemPrompt,
   *   temperature, model, signal, onProgress, reasoning
   * @param {Object} numbers - Sized by the caller
   * @param {number} numbers.responseTokens - Sent as num_predict
   * @param {number} numbers.numCtx - Context window to request
   * @returns {Promise<string>} - The generated text
   */
  async generate(prompt, options = {}, { responseTokens, numCtx }) {
    // Read before the try so the catch can tell a stopped request from a
    // failed one, and so a cut-off request keeps what it measured.
    const signal = abortSignal(options);
    const onProgress = progressHandler(options);
    let measuredUsage = null;

    try {
      // Simple system prompt for text generation; a caller that knows the job
      // better (the Duplicates review) brings its own.
      const systemPrompt = hasSystemPrompt(options)
        ? options.systemPrompt
        : `You are a helpful assistant. Generate a clear, concise, and informative response to the user's question or request.`;

      // Call Ollama API without enforcing a specific response format
      const generateTextBody = {
        model: modelOverride(options) || this.model,
        prompt: prompt,
        system: systemPrompt,
        stream: false,
        options: {
          temperature: hasNumber(options.temperature)
            ? options.temperature
            : config.aiTemperatureGeneration,
          top_p: 0.9,
          // The line above reserves the same number in the context; a
          // constant here would have the same quarrel with it that the
          // analysis path had.
          num_predict: responseTokens,
          num_ctx: numCtx,
        },
      };

      // A caller that says what it wants overrules the setting; without one
      // OLLAMA_THINK decides, which is what it did before.
      const reasoning = reasoningEnabled(options);
      if (reasoning !== null) {
        generateTextBody.think = reasoning;
      } else if (!config.ollama.think) {
        // Disable thinking for reasoning models (e.g. Qwen3, DeepSeek-R1)
        // unless explicitly enabled via OLLAMA_THINK=true
        generateTextBody.think = false;
      }

      // axios takes the signal in the request config; without one the config
      // is the headers it always was.
      const requestConfig = { headers: this.buildHeaders() };
      if (signal) requestConfig.signal = signal;

      if (onProgress) {
        return await this._generateStreamed(
          generateTextBody,
          requestConfig,
          { signal, onProgress, numPredict: responseTokens, numCtx },
          (usage) => {
            measuredUsage = usage;
            this.lastGenerateTextUsage = usage;
          }
        );
      }

      const response = await this.client.post(
        `${this.apiUrl}/api/generate`,
        generateTextBody,
        requestConfig
      );

      if (!response.data || !response.data.response) {
        throw new Error('Invalid response from Ollama API');
      }

      // Ollama reports its token counts on the answer itself; the callers
      // that care (the Duplicates review) read them off the service after
      // the call, so the return value stays a plain string.
      const promptTokens = Number(response.data.prompt_eval_count);
      const completionTokens = Number(response.data.eval_count);
      measuredUsage =
        Number.isFinite(promptTokens) || Number.isFinite(completionTokens)
          ? {
              promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
              completionTokens: Number.isFinite(completionTokens)
                ? completionTokens
                : null,
              totalTokens:
                (Number.isFinite(promptTokens) ? promptTokens : 0) +
                (Number.isFinite(completionTokens) ? completionTokens : 0),
            }
          : null;
      this.lastGenerateTextUsage = measuredUsage;

      // A model that writes its reasoning into the answer wrote it for
      // itself; only what it said afterwards is the answer. Anything that is
      // not a string is left alone — it is a structured answer, not text.
      const generatedText =
        typeof response.data.response === 'string'
          ? stripReasoningText(response.data.response).trim()
          : response.data.response;

      // The cut-off check the analysis path has always run, now on this path
      // too, and carrying the prefix the caller can still use.
      this.assertNotTruncated(response.data, responseTokens, numCtx, {
        partialText: typeof generatedText === 'string' ? generatedText : '',
      });

      return generatedText;
    } catch (error) {
      // Whatever was measured before the failure stays readable; a failure
      // that measured nothing still leaves null behind, as it always did.
      this.lastGenerateTextUsage = measuredUsage;
      // One name for a stopped request, whatever axios called it; an abort
      // this transport raised already carries its partial text.
      const thrown =
        isAbortError(error, signal) && error?.name !== 'AbortError'
          ? abortedGenerationError(error, '')
          : error;
      console.error(`Error generating text with Ollama: ${thrown.message}`);
      console.debug(thrown);
      throw thrown;
    }
  }

  /**
   * The streamed half of generate(): the same request with `stream: true`,
   * read as the NDJSON lines Ollama answers with.
   *
   * Ollama does not speak server-sent events — every line is a complete JSON
   * object with the next piece of the answer in `response`, the next piece of
   * the model's thinking in `thinking`, and on the last line the counts and
   * the reason it stopped. Lines arrive split across socket reads, so the tail
   * of a read is kept until its newline turns up.
   *
   * @param {Object} body - the request body, `stream` still to be set
   * @param {Object} requestConfig - headers, and the signal if there is one
   * @param {Object} context
   * @param {AbortSignal|null} context.signal
   * @param {Function} context.onProgress
   * @param {number} context.numPredict - response budget that was sent
   * @param {number} context.numCtx - context window that was sent
   * @param {Function} onUsage - told before a cut-off throws
   * @returns {Promise<string>} the answer, reasoning stripped
   */
  async _generateStreamed(body, requestConfig, context, onUsage) {
    const { signal, onProgress, numPredict, numCtx } = context;
    const collector = createProgressCollector({ onProgress });
    let last = {};

    try {
      const response = await this.client.post(
        `${this.apiUrl}/api/generate`,
        { ...body, stream: true },
        { ...requestConfig, responseType: 'stream' }
      );

      const stream = response.data;
      // An abort tears the socket down, and a socket error that arrives after
      // the loop has left would be an unhandled 'error' event — which ends
      // the process rather than the request.
      stream.on('error', () => {});
      let pending = '';
      const takeLine = (line) => {
        if (line.trim() === '') return;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          // A line that is not JSON is a line this client cannot use; the
          // stream goes on, and the answer is whatever the rest carries.
          return;
        }
        collector.pushContent(parsed.response);
        collector.pushReasoning(parsed.thinking);
        if (parsed.done === true) last = parsed;
        collector.report();
      };

      for await (const piece of stream) {
        if (signal?.aborted) {
          // Nothing more is wanted, so nothing more is read: the socket goes
          // now rather than after the model finished talking to itself.
          stream.destroy();
          break;
        }
        pending += piece.toString('utf8');
        let at = pending.indexOf('\n');
        while (at !== -1) {
          takeLine(pending.slice(0, at));
          pending = pending.slice(at + 1);
          at = pending.indexOf('\n');
        }
      }
      if (!signal?.aborted) takeLine(pending);

      if (signal?.aborted) {
        collector.finish();
        throw abortedGenerationError(null, collector.text());
      }
    } catch (error) {
      collector.finish();
      if (error?.name === 'AbortError') throw error;
      if (isAbortError(error, signal)) {
        throw abortedGenerationError(error, collector.text());
      }
      throw error;
    }

    collector.finish();

    const promptTokens = Number(last.prompt_eval_count);
    const completionTokens = Number(last.eval_count);
    const measured =
      Number.isFinite(promptTokens) || Number.isFinite(completionTokens)
        ? {
            promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
            completionTokens: Number.isFinite(completionTokens)
              ? completionTokens
              : null,
            totalTokens:
              (Number.isFinite(promptTokens) ? promptTokens : 0) +
              (Number.isFinite(completionTokens) ? completionTokens : 0),
          }
        : collector.usageSummary();
    if (typeof onUsage === 'function') onUsage(measured);

    this.assertNotTruncated(last, numPredict, numCtx, {
      partialText: collector.text(),
    });

    return collector.text();
  }

  /**
   * A generation Ollama had to cut short comes back with done_reason "length".
   * What it returns is a prefix, and for structured output that means JSON
   * without its closing braces — which no amount of sanitizing recovers, so
   * there is nothing to do with it but say so.
   *
   * Two different limits produce the same done_reason and want opposite fixes:
   * num_predict is the response budget, but the context window can leave less
   * room than that, and then raising Response Tokens changes nothing. The
   * message names whichever one actually bit.
   *
   * @param {Object} responseData - Ollama /api/generate response
   * @param {number} numPredict - response token limit that was sent
   * @param {number} numCtx - context window that was sent
   * @param {Object} [extra] - what the caller salvaged from the cut-off answer
   * @param {string} [extra.partialText] - the text that did arrive, reasoning
   *   stripped; put on the error as `partialText` the way the OpenAI-compatible
   *   providers do, so a caller can keep it instead of asking twice
   */
  assertNotTruncated(responseData, numPredict, numCtx, extra) {
    const evalCount = Number(responseData?.eval_count) || 0;
    const promptEvalCount = Number(responseData?.prompt_eval_count) || 0;

    // done_reason is the direct signal. Reaching the limit exactly is the
    // fallback for an Ollama old enough not to send one.
    const stoppedOnLength =
      responseData?.done_reason === 'length' ||
      (!responseData?.done_reason && numPredict > 0 && evalCount >= numPredict);

    if (!stoppedOnLength) {
      return;
    }

    /* Which limit bit is read off the count itself rather than guessed from
       the context arithmetic: reaching num_predict exactly is the response
       budget, stopping short of it means the context filled up first. The
       arithmetic route was tried and got it backwards — the window is sized
       from an estimate of the prompt, so comparing it against the real
       prompt_eval_count blames the context for a run that generated its full
       budget. */
    const error =
      evalCount >= numPredict
        ? new Error(
            `Ollama stopped generating after ${evalCount} tokens, which is the configured response limit. Raise Response Tokens (RESPONSE_TOKENS) above ${numPredict}.`
          )
        : new Error(
            `Ollama stopped generating after ${evalCount} of ${numPredict} response tokens: the ${numCtx}-token context window was full, ${promptEvalCount} of it prompt. Raise Token Limit (TOKEN_LIMIT) or shorten the document.`
          );

    /* Carried as a code rather than matched out of the message later. The
       phrase-matching in serviceUtils classifies errors that arrive from
       elsewhere and have no better handle; this one is raised right here, so
       rewording it should not silently reclassify the failure. */
    error.code = 'ai_response_truncated';
    if (typeof extra?.partialText === 'string') {
      error.partialText = extra.partialText;
    }
    throw error;
  }

  /**
   * Token usage of an /api/generate response.
   * @param {Object} responseData - Ollama API response data
   * @returns {{promptTokens:number, completionTokens:number, totalTokens:number}}
   */
  extractMetrics(responseData) {
    const promptTokens = Number(responseData?.prompt_eval_count) || 0;
    const completionTokens = Number(responseData?.eval_count) || 0;

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }
}

module.exports = { OllamaGenerateTransport };
