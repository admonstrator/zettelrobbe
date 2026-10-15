'use strict';

/**
 * The token budget of the chat providers (openai, azure, custom).
 *
 * The prompt is counted with tiktoken (a ÷4 estimate for models tiktoken does
 * not know), the configured answer is reserved, and the document gets what is
 * left of TOKEN_LIMIT. This block used to be copied into all three services.
 *
 * Shares its reserve()/fit()/count()/cut() shape with charBudget.js, which is
 * Ollama's.
 */

const config = require('../../../config/config');
const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit,
} = require('../../serviceUtils');

/**
 * Reserve room for the prompt and the answer.
 *
 * @param {string} systemPrompt - The fully built system prompt
 * @param {string[]} extraPrompts - Further prompt parts counted as messages
 * @param {string} model - Model the prompt is counted for
 * @returns {Promise<{totalPromptTokens:number, reservedTokens:number, availableTokens:number}>}
 * @throws {Error} "Token limit exceeded: …" when nothing is left for the document
 */
async function reserve(systemPrompt, extraPrompts, model) {
  const totalPromptTokens = await calculateTotalPromptTokens(
    systemPrompt,
    extraPrompts,
    model
  );

  const maxTokens = Number(config.tokenLimit);
  const reservedTokens = totalPromptTokens + Number(config.responseTokens);
  const availableTokens = maxTokens - reservedTokens;

  // A non-finite budget is the same failure as an exhausted one: it slips
  // past a bare `<= 0` and truncates the document down to nothing instead of
  // stopping.
  if (!Number.isFinite(availableTokens) || availableTokens <= 0) {
    console.warn(
      `[WARNING] No available tokens for content. Reserved: ${reservedTokens}, Max: ${maxTokens}`
    );
    throw new Error(
      'Token limit exceeded: prompt too large for available token limit'
    );
  }

  console.log(
    `[DEBUG] Token calculation - Prompt: ${totalPromptTokens}, Reserved: ${reservedTokens}, Available: ${availableTokens}`
  );
  return { totalPromptTokens, reservedTokens, availableTokens };
}

/**
 * Cut the document to the tokens reserve() left for it.
 *
 * @param {string} content - Document content
 * @param {number} availableTokens - From reserve()
 * @param {string} model - Model the content is counted for
 * @returns {Promise<string>}
 */
function fit(content, availableTokens, model) {
  return truncateToTokenLimit(content, availableTokens, model);
}

/** Tokens of a text, e.g. the external API data. */
function count(text, model) {
  return calculateTokens(text, model);
}

/** Cut a text to a token count, e.g. the external API data. */
function cut(text, maxTokens, model) {
  return truncateToTokenLimit(text, maxTokens, model);
}

module.exports = { reserve, fit, count, cut };
