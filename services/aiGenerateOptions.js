'use strict';

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
 * The token usage of an OpenAI-compatible completion, or null when the
 * provider did not report any. Kept separate from the return value of
 * `generateText` so its contract (a string) stays what it was; callers that
 * care read `service.lastGenerateTextUsage` after the call.
 *
 * @param {object} response
 * @returns {{promptTokens:number|null, completionTokens:number|null, totalTokens:number}|null}
 */
function readCompletionUsage(response) {
  const usage = response?.usage;
  if (!usage) return null;
  const promptTokens = Number(usage.prompt_tokens);
  const completionTokens = Number(usage.completion_tokens);
  const totalTokens = Number(usage.total_tokens);
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
  };
}

module.exports = {
  abortSignal,
  hasNumber,
  hasSystemPrompt,
  modelOverride,
  readCompletionUsage,
};
