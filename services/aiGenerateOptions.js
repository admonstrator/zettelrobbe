'use strict';

const {
  assertCompletionNotTruncated,
  estimateTokenCount,
} = require('./serviceUtils');

/**
 * The optional second argument of `generateText(prompt, options)`.
 *
 * All four provider services accept the same three overrides — a system
 * prompt, a temperature and a completion cap — and they all have to read them
 * the same way, or a caller would get a different answer per provider. The
 * checks live here instead of four times over, because two of them are easy
 * to get wrong: `temperature: 0` is a value, not a missing one, and
 * `Number(null)` is 0 rather than NaN, so a null must not pass for a number.
 *
 * Nothing here talks to a provider; it only reads what the caller asked for.
 */

/**
 * True for a real, finite number. Guards against `null` (which `Number()`
 * turns into 0) and against numeric strings, which would silently change the
 * meaning of a caller's option.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function hasNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * True when the options carry a system prompt worth sending.
 *
 * @param {{systemPrompt?: unknown}} [options]
 * @returns {boolean}
 */
function hasSystemPrompt(options) {
  return (
    typeof options?.systemPrompt === 'string' &&
    options.systemPrompt.trim() !== ''
  );
}

/**
 * The model a caller asked for, or null when it named none.
 *
 * Only one caller does: the Duplicates review may run on a different model
 * than the document analysis (DUPLICATES_AI_MODEL), and it says so per call
 * instead of reconfiguring the provider. For Azure the name is the deployment
 * name, which is what that API calls a model.
 *
 * @param {{model?: unknown}} [options]
 * @returns {string|null}
 */
function modelOverride(options) {
  return typeof options?.model === 'string' && options.model.trim() !== ''
    ? options.model.trim()
    : null;
}

/**
 * The AbortSignal a caller handed in, or null when it handed in none.
 *
 * Only one caller does: the Duplicates review may be stopped while a request
 * is in flight, and a stop that only takes effect after the answer arrived is
 * not a stop. The provider services pass what comes back from here straight
 * to their client — the OpenAI SDK takes it as request option, axios as part
 * of the request config — and send exactly what they sent before when it is
 * null.
 *
 * A real AbortSignal is what the callers use; the duck-typed check below also
 * accepts a stand-in a test drives, because the value is only ever handed on.
 *
 * @param {{signal?: unknown}} [options]
 * @returns {AbortSignal|null}
 */
function abortSignal(options) {
  const signal = options?.signal;
  if (!signal || typeof signal !== 'object') return null;
  if (typeof AbortSignal === 'function' && signal instanceof AbortSignal) {
    return signal;
  }
  return typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function'
    ? signal
    : null;
}

/**
 * Whether the caller wants the model to think before it answers.
 *
 * `true` and `false` are explicit wishes: the Duplicates judge sends `false`
 * unless the operator switched thinking on (DUPLICATES_AI_THINKING), because
 * a reasoning model spends the whole answer budget on its thoughts before
 * the first verdict. `null` is "the caller said nothing": the provider keeps
 * whatever it does today (Ollama's OLLAMA_THINK, the model's own default).
 *
 * What a provider does with `false` is its business: Ollama sends
 * `think: false`, an OpenAI-compatible endpoint gets
 * `chat_template_kwargs: { enable_thinking: false }` and, for a Qwen model,
 * the soft switch the model family understands; OpenAI and Azure send
 * nothing, as their APIs have no such switch on ordinary models.
 *
 * @param {{reasoning?: unknown}} [options]
 * @returns {boolean|null}
 */
function reasoningEnabled(options) {
  return typeof options?.reasoning === 'boolean' ? options.reasoning : null;
}

/**
 * @typedef {object} GenerateTextProgress
 * @property {string} text               the answer so far, reasoning stripped
 * @property {boolean} thinking          the model is writing reasoning now
 * @property {number|null} completionTokens  tokens produced so far: reported
 *   by the provider when it streams usage, else estimated from the text
 * @property {number|null} thinkingTokens tokens of reasoning so far, estimated
 *   from the reasoning text the model wrote (null when it wrote none). Part of
 *   completionTokens, never in addition to it.
 * @property {boolean} done              the last report of this request
 */

/**
 * The progress callback a caller handed in, or null when it handed in none.
 *
 * With a callback the provider streams the answer and reports as it grows
 * (see GenerateTextProgress); without one it sends the plain request it
 * always sent. Either way `generateText` still resolves with the whole text,
 * and a truncated or aborted request still throws — but with the text that
 * arrived before the cut on `error.partialText`, so the caller can keep what
 * is in it.
 *
 * @param {{onProgress?: unknown}} [options]
 * @returns {((update: GenerateTextProgress) => void)|null}
 */
function progressHandler(options) {
  return typeof options?.onProgress === 'function' ? options.onProgress : null;
}

/**
 * The token usage of an OpenAI-compatible completion, or null when the
 * provider did not report any. Kept separate from the return value of
 * `generateText` so its contract (a string) stays what it was; callers that
 * care read `service.lastGenerateTextUsage` after the call.
 *
 * @param {object} response
 * @returns {{promptTokens:number|null, completionTokens:number|null, totalTokens:number, reasoningTokens:number|null}|null}
 *   reasoningTokens is what the provider itself reported as reasoning
 *   (completion_tokens_details.reasoning_tokens), null when it reported none
 */
function readCompletionUsage(response) {
  const usage = response?.usage;
  if (!usage) return null;
  const promptTokens = Number(usage.prompt_tokens);
  const completionTokens = Number(usage.completion_tokens);
  const totalTokens = Number(usage.total_tokens);
  const reasoningTokens = Number(
    usage.completion_tokens_details?.reasoning_tokens
  );
  if (
    !Number.isFinite(promptTokens) &&
    !Number.isFinite(completionTokens) &&
    !Number.isFinite(totalTokens)
  ) {
    return null;
  }
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
    completionTokens: Number.isFinite(completionTokens)
      ? completionTokens
      : null,
    totalTokens: Number.isFinite(totalTokens)
      ? totalTokens
      : (Number.isFinite(promptTokens) ? promptTokens : 0) +
        (Number.isFinite(completionTokens) ? completionTokens : 0),
    reasoningTokens: Number.isFinite(reasoningTokens) ? reasoningTokens : null,
  };
}

/**
 * How often a streaming provider may report progress: one report per this
 * many milliseconds, plus the final one. A token-by-token callback would
 * report a few hundred times a second, and every consumer would have to
 * throttle it again.
 */
const PROGRESS_THROTTLE_MS = 100;

/** The markers a model writes its reasoning between when it writes it inline. */
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * How many characters at the end of `text` are the beginning of `marker`.
 *
 * A stream cuts wherever the network felt like cutting, so "<thi" can be the
 * last thing a chunk holds. Those characters are neither answer nor reasoning
 * yet; they wait for the next chunk instead of being handed out and taken
 * back.
 *
 * @param {string} text
 * @param {string} marker
 * @returns {number}
 */
function openMarkerLength(text, marker) {
  const longest = Math.min(text.length, marker.length - 1);
  for (let length = longest; length > 0; length -= 1) {
    if (marker.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

/**
 * Splits a growing answer into what the model said and what it thought.
 *
 * Reasoning models write their deliberation into the content, between
 * `<think>` and `</think>`. It is not an answer: it must not reach the page,
 * it must not reach a JSON parser, and it must not reach the text a caller
 * keeps from a cut-off request. The split runs incrementally because a stream
 * hands over the block in pieces, and it survives a block that never closes:
 * what a truncated answer left open was reasoning, and reasoning is dropped.
 *
 * @returns {{push(chunk: string): void, end(): void, text(): string,
 *   reasoning(): string, inside(): boolean}}
 */
function createReasoningSplitter() {
  let inside = false;
  let pending = '';
  let visible = '';
  let hidden = '';

  const settle = (piece) => {
    if (inside) hidden += piece;
    else visible += piece;
  };

  return {
    push(chunk) {
      pending += chunk;
      for (;;) {
        const marker = inside ? THINK_CLOSE : THINK_OPEN;
        const at = pending.indexOf(marker);
        if (at === -1) break;
        settle(pending.slice(0, at));
        pending = pending.slice(at + marker.length);
        inside = !inside;
      }
      const marker = inside ? THINK_CLOSE : THINK_OPEN;
      const keep = openMarkerLength(pending, marker);
      settle(pending.slice(0, pending.length - keep));
      pending = keep === 0 ? '' : pending.slice(pending.length - keep);
    },
    end() {
      // Outside a block the leftover is a marker that never came: ordinary
      // text. Inside one it is the tail of reasoning nobody closed.
      settle(pending);
      pending = '';
    },
    text() {
      return visible;
    },
    reasoning() {
      return hidden;
    },
    inside() {
      return inside;
    },
  };
}

/**
 * The answer without the reasoning the model wrote into it.
 *
 * Used on the whole content of a plain, unstreamed answer; the streaming path
 * gets the same result from the splitter above.
 *
 * @param {unknown} text
 * @returns {string}
 */
function stripReasoningText(text) {
  if (typeof text !== 'string' || text === '') return '';
  const splitter = createReasoningSplitter();
  splitter.push(text);
  splitter.end();
  return splitter.text();
}

/**
 * Collects a streamed answer and reports it as it grows.
 *
 * Every provider assembles the same four things — the answer so far, whether
 * the model is thinking, how many completion tokens it has produced and
 * whether this is the last word — and every provider has to throttle them the
 * same way, so the collecting lives here and the providers only feed it the
 * deltas their API spells differently.
 *
 * `completionTokens` is what the provider reported once a usage chunk arrived
 * and an estimate over everything produced before that, reasoning included:
 * the thoughts are what the budget was spent on, so leaving them out would
 * report a cap of 3200 as a few hundred tokens.
 *
 * @param {object} [options]
 * @param {((update: GenerateTextProgress) => void)|null} [options.onProgress]
 * @param {number} [options.throttleMs] - defaults to PROGRESS_THROTTLE_MS
 * @param {() => number} [options.now] - the clock, for tests
 * @returns {object} the collector the provider feeds
 */
function createProgressCollector(options = {}) {
  const handler =
    typeof options.onProgress === 'function' ? options.onProgress : null;
  const throttleMs = hasNumber(options.throttleMs)
    ? options.throttleMs
    : PROGRESS_THROTTLE_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  const splitter = createReasoningSplitter();
  let producedChars = 0;
  let separateReasoning = false;
  let started = false;
  let finished = false;
  let lastReportAt = -Infinity;
  let usage = null;
  let finishReason = null;

  const thinking = () => splitter.inside() || separateReasoning;

  const completionTokens = () => {
    const reported = Number(usage?.completion_tokens);
    if (Number.isFinite(reported)) return reported;
    return started ? estimateTokenCount(producedChars) : null;
  };

  const emit = (done) => {
    if (!handler) return;
    try {
      handler({
        text: splitter.text().trim(),
        thinking: thinking(),
        completionTokens: completionTokens(),
        done,
      });
    } catch (error) {
      // A consumer that throws is the consumer's problem; the request is
      // still in flight and must not die with it.
      console.warn(`[WARN] Progress handler failed: ${error.message}`);
    }
  };

  return {
    /** A piece of the answer itself, reasoning markers and all. */
    pushContent(delta) {
      if (typeof delta !== 'string' || delta === '') return;
      producedChars += delta.length;
      started = true;
      separateReasoning = false;
      splitter.push(delta);
    },
    /** A piece the API delivered as reasoning of its own, never an answer. */
    pushReasoning(delta) {
      if (typeof delta !== 'string' || delta === '') return;
      producedChars += delta.length;
      started = true;
      separateReasoning = true;
    },
    /** The usage object of an OpenAI-compatible usage chunk. */
    setUsage(reported) {
      if (reported && typeof reported === 'object') usage = reported;
    },
    /** 'stop', 'length', … whichever the provider sent last. */
    setFinishReason(reason) {
      if (typeof reason === 'string' && reason !== '') finishReason = reason;
    },
    /** A throttled report; silent until the first delta arrived. */
    report() {
      if (finished || !started) return;
      const at = now();
      if (at - lastReportAt < throttleMs) return;
      lastReportAt = at;
      emit(false);
    },
    /** The one report that says done, on success, truncation and abort alike. */
    finish() {
      if (finished) return;
      finished = true;
      splitter.end();
      lastReportAt = now();
      emit(true);
    },
    /** The answer, reasoning stripped. Call finish() first. */
    text() {
      return splitter.text().trim();
    },
    reasoning() {
      return splitter.reasoning();
    },
    finishReason() {
      return finishReason;
    },
    usage() {
      return usage;
    },
    /** True once any delta arrived, whichever kind. */
    started() {
      return started;
    },
    /** What lastGenerateTextUsage becomes after a streamed request. */
    usageSummary() {
      const reported = readCompletionUsage({ usage });
      if (reported) return reported;
      const estimate = estimateTokenCount(producedChars);
      return {
        promptTokens: null,
        completionTokens: estimate,
        totalTokens: estimate,
        estimated: true,
      };
    },
  };
}

/**
 * Reads an OpenAI-compatible completion stream into a collector.
 *
 * The three SDK providers differ in what they put into the request, never in
 * how the answer comes back: content deltas, reasoning deltas under either of
 * the two names vLLM-style servers use, a finish reason on the last choice
 * and a usage chunk with no choices at all.
 *
 * Returns as soon as the signal is aborted; leaving the loop early makes the
 * SDK abort the request, so the server sees the connection go.
 *
 * @param {AsyncIterable<object>} stream
 * @param {object} collector - from createProgressCollector()
 * @param {AbortSignal|null} [signal]
 * @returns {Promise<void>}
 */
async function consumeChatCompletionStream(stream, collector, signal = null) {
  for await (const chunk of stream) {
    if (signal?.aborted) break;
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta;
    collector.pushContent(delta?.content);
    // reasoning_content is what vLLM and its kin send; reasoning is the
    // spelling of the servers that followed the other example.
    collector.pushReasoning(
      typeof delta?.reasoning_content === 'string'
        ? delta.reasoning_content
        : delta?.reasoning
    );
    collector.setFinishReason(choice?.finish_reason);
    collector.setUsage(chunk?.usage);
    collector.report();
  }
}

/**
 * True when this error is a request the caller stopped, not one that failed.
 *
 * The SDK, axios and fetch each have their own name for it, and the SDK even
 * swallows the abort of a stream it is iterating — so the signal itself is
 * the first thing asked.
 *
 * @param {unknown} error
 * @param {AbortSignal|null} [signal]
 * @returns {boolean}
 */
function isAbortError(error, signal = null) {
  if (signal?.aborted === true) return true;
  const name = String(error?.name || '');
  const code = String(error?.code || '');
  return (
    name === 'AbortError' ||
    name === 'CanceledError' ||
    name === 'APIUserAbortError' ||
    code === 'ERR_CANCELED' ||
    code === 'ABORT_ERR'
  );
}

/**
 * The error a stopped request throws: one name for all four providers, and
 * the text that had arrived before the stop on it.
 *
 * @param {unknown} cause - what the client threw, if it threw at all
 * @param {string} partialText - the answer so far, reasoning stripped
 * @returns {Error}
 */
function abortedGenerationError(cause, partialText) {
  const message =
    typeof cause?.message === 'string' && cause.message.trim() !== ''
      ? cause.message
      : 'The request was aborted before the answer was complete.';
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ai_request_aborted';
  error.partialText = typeof partialText === 'string' ? partialText : '';
  if (cause instanceof Error) error.cause = cause;
  return error;
}

/**
 * Runs one streamed completion against an OpenAI-compatible client.
 *
 * OpenAI, Azure and the custom provider disagree about what goes into the
 * request and agree about everything that happens afterwards, so this is the
 * afterwards: read the stream, report as it grows, say `done` exactly once —
 * on a clean end, on a cut-off and on an abort alike — and then either return
 * the answer or throw an error that carries what did arrive.
 *
 * @param {object} params
 * @param {object} params.client - the SDK client, already initialized
 * @param {object} params.request - the whole body, `stream: true` included
 * @param {object|null} params.requestOptions - the SDK's second argument, or
 *   null when the caller brought no signal and the call keeps its old shape
 * @param {AbortSignal|null} params.signal
 * @param {(update: GenerateTextProgress) => void} params.onProgress
 * @param {string} params.provider - name for the truncation message
 * @param {string} params.remedy - sentence naming the limit to raise
 * @param {(usage: object) => void} params.onUsage - told before the throw, so
 *   a cut-off request still reports what it spent
 * @returns {Promise<string>} the answer, reasoning stripped
 */
async function runChatCompletionStream({
  client,
  request,
  requestOptions,
  signal,
  onProgress,
  provider,
  remedy,
  onUsage,
}) {
  const collector = createProgressCollector({ onProgress });

  try {
    const stream = requestOptions
      ? await client.chat.completions.create(request, requestOptions)
      : await client.chat.completions.create(request);
    await consumeChatCompletionStream(stream, collector, signal);
    if (signal?.aborted) {
      // The loop left early, which made the SDK close the connection; the
      // caller still has to be told, with what arrived until then.
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
  const usage = collector.usageSummary();
  if (typeof onUsage === 'function') onUsage(usage);

  assertCompletionNotTruncated(
    {
      choices: [{ finish_reason: collector.finishReason() }],
      usage: { completion_tokens: usage.completionTokens },
    },
    provider,
    remedy,
    { partialText: collector.text() }
  );

  return collector.text();
}

module.exports = {
  reasoningEnabled,
  progressHandler,
  abortSignal,
  hasNumber,
  hasSystemPrompt,
  modelOverride,
  readCompletionUsage,
  PROGRESS_THROTTLE_MS,
  stripReasoningText,
  createProgressCollector,
  consumeChatCompletionStream,
  runChatCompletionStream,
  isAbortError,
  abortedGenerationError,
};
