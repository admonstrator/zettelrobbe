'use strict';

/**
 * Ollama's token budget, counted in characters.
 *
 * Two characters make one token. That is deliberately conservative: German
 * and CJK text tokenizes at roughly two characters per token rather than the
 * ~4 of English, and a ÷4 estimate under-sizes num_ctx for exactly those
 * documents. Everything here uses the same divisor, so the prompt estimate,
 * the context window and the document cut agree by construction (Finding 5
 * of docs/llm-service-refactoring.md — do not unify it with tiktoken's).
 *
 * Shares its reserve()/fit()/count()/cut() shape with tiktokenBudget.js.
 */

const config = require('../../../config/config');

const CHARS_PER_TOKEN = 2;

/** Estimated tokens for a text. */
function estimateTokens(text) {
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

/**
 * The context window to request: the prompt plus the reserved answer, but
 * never more than TOKEN_LIMIT.
 *
 * @param {number} promptTokens - From estimateTokens()
 * @param {number} responseTokens - Tokens reserved for the answer
 * @returns {number}
 */
function numCtx(promptTokens, responseTokens) {
  return Math.min(promptTokens + responseTokens, Number(config.tokenLimit));
}

/**
 * Reserve room for the fixed prompt parts and the answer.
 *
 * A TOKEN_LIMIT or RESPONSE_TOKENS that is not a number leaves the document
 * uncut (availableTokens is Infinity), as Ollama always did; it is the
 * context window that is then wrong, not the document.
 *
 * @param {string} promptPrefix - The fully built prompt without the document
 * @returns {Promise<{totalPromptTokens:number, reservedTokens:number, availableTokens:number}>}
 * @throws {Error} "Token limit exceeded: …" when nothing is left for the document
 */
async function reserve(promptPrefix) {
  const maxWindow = Number(config.tokenLimit);
  const responseTokens = Number(config.responseTokens);
  const totalPromptTokens = estimateTokens(promptPrefix);
  const reservedTokens = totalPromptTokens + responseTokens;

  if (!Number.isFinite(maxWindow) || !Number.isFinite(responseTokens)) {
    return { totalPromptTokens, reservedTokens, availableTokens: Infinity };
  }

  const availableTokens = maxWindow - reservedTokens;
  if (availableTokens <= 0) {
    throw new Error(
      'Token limit exceeded: the prompt alone does not fit the configured ' +
        'TOKEN_LIMIT. Raise TOKEN_LIMIT or shorten the system prompt.'
    );
  }
  return { totalPromptTokens, reservedTokens, availableTokens };
}

/**
 * Cut the document to the tokens reserve() left for it.
 *
 * A document that is not a string is measured as its JSON. One that fits is
 * returned as it was handed in; one that does not comes back as a string.
 *
 * @param {string|Object} content - Document content
 * @param {number} availableTokens - From reserve()
 * @returns {Promise<string|Object>}
 */
async function fit(content, availableTokens) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const maxChars = availableTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return content;
  }

  console.log(
    `[DEBUG] Document content (${text.length} chars) exceeds the context ` +
      `budget (${maxChars} chars for a ${config.tokenLimit}-token window minus prompt` +
      ` and ${config.responseTokens} reserved answer tokens); truncating`
  );
  return text.substring(0, maxChars);
}

/**
 * Cut a text to a token count, e.g. the external API data.
 *
 * @param {string} text
 * @param {number} maxTokens
 * @returns {string}
 */
function cut(text, maxTokens) {
  return String(text).substring(0, maxTokens * CHARS_PER_TOKEN);
}

module.exports = {
  estimateTokens,
  count: estimateTokens,
  cut,
  numCtx,
  reserve,
  fit,
};
