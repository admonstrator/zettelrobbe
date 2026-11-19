// @ts-check
'use strict';

/**
 * The instruction a vision model gets with every OCR request.
 *
 * Two built-in prompts exist: Claude reads a whole PDF and gets a detailed
 * transcription brief, a local vision model (Ollama, LM Studio, any
 * OpenAI-compatible endpoint) gets one page image and a short sentence. The
 * Mistral OCR API takes no prompt at all.
 *
 * OCR_PROMPT replaces the built-in prompt of whichever vision provider is
 * selected. Empty means "the built-in one", so a stored prompt never pins the
 * Claude text onto a local model after a provider switch. The settings save
 * stores a prompt that equals a built-in one as empty for the same reason.
 */

/**
 * What Claude answers for a page without any text. The empty-result guard in
 * the OCR queue then refuses to overwrite the document's content, instead of
 * a sentence like "This page is blank." becoming its text.
 */
const NO_TEXT_MARKER = '[no text]';

const DEFAULT_OCR_PROMPTS = Object.freeze({
  anthropic: [
    'Transcribe all text in this document exactly as it is written, in reading order, page by page.',
    '- Keep the original language, spelling, numbers and punctuation. Do not translate, correct, summarize or explain anything.',
    '- Reproduce tables as Markdown tables. Keep headings, lists and paragraph breaks.',
    '- Include handwriting, stamps and filled-in form values where they are legible.',
    '- Write [illegible] where text cannot be read. Do not guess.',
    '- Answer with the transcript only: no introduction, no comments, no code fences.',
    `- If the document contains no readable text at all, answer with exactly ${NO_TEXT_MARKER}`,
  ].join('\n'),
  local:
    'Perform OCR on this image. Return only the extracted text in plain text. Do not add explanations.',
});

/**
 * The built-in prompt of an OCR provider: Claude's for `anthropic`, the
 * local one for every other provider.
 *
 * @param {unknown} provider OCR_PROVIDER
 * @returns {string}
 */
function defaultOcrPrompt(provider) {
  return String(provider || '')
    .trim()
    .toLowerCase() === 'anthropic'
    ? DEFAULT_OCR_PROMPTS.anthropic
    : DEFAULT_OCR_PROMPTS.local;
}

/**
 * A prompt as it is stored: line breaks unified, outer whitespace trimmed,
 * and empty when it equals a built-in prompt.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeOcrPrompt(raw) {
  const text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  return Object.values(DEFAULT_OCR_PROMPTS).includes(text) ? '' : text;
}

/**
 * The prompt an OCR request sends: OCR_PROMPT when set, else the provider's
 * built-in one. Read on every call, so a saved prompt applies at once.
 *
 * @param {unknown} provider OCR_PROVIDER
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
function resolveOcrPrompt(provider, env = process.env) {
  return normalizeOcrPrompt(env.OCR_PROMPT) || defaultOcrPrompt(provider);
}

module.exports = {
  NO_TEXT_MARKER,
  DEFAULT_OCR_PROMPTS,
  defaultOcrPrompt,
  normalizeOcrPrompt,
  resolveOcrPrompt,
};
