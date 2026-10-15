'use strict';

/**
 * Reads the JSON object out of a document analysis answer, once for every
 * provider.
 *
 * Models wrap their answer: reasoning models put a <think> block in front,
 * many fence the JSON in ```json, some add a sentence before or after it, and
 * smaller local models leave trailing commas or unquoted keys behind. Each
 * provider used to cope with a different subset of that. This is the union:
 *
 *  1. an answer that already is an object (Ollama's structured output) is
 *     used as it is;
 *  2. reasoning blocks and code fences are stripped;
 *  3. the rest is parsed as it stands;
 *  4. failing that, every top-level {...} in it is tried in turn, as written
 *     and then repaired, and the first one that parses wins.
 *
 * Every failure is an Error whose message starts with "Invalid JSON response
 * from API" — shouldQueueForOcrOnAiError() matches on that phrase, and
 * without it the document no longer reaches the OCR fallback.
 */

const INVALID_JSON = 'Invalid JSON response from API';

/**
 * What a model writes when it declines a document as too thin to analyse.
 * Matched only on an answer that did not parse (Finding 7c).
 */
const INSUFFICIENT_CONTENT_MARKERS = ["i'm sorry", 'i cannot', 'insufficient'];

/** Drop reasoning blocks and code fences around the answer. */
function stripResponseWrapping(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();
}

/**
 * Whether an answer that did not parse is a refusal rather than broken JSON.
 * Such a document is reported as insufficient content: it still reaches OCR,
 * under that reason, and the retry loop does not ask the model again.
 *
 * @param {string} raw - The model's answer
 * @returns {boolean}
 */
function isInsufficientContentAnswer(raw) {
  const text = stripResponseWrapping(raw).toLowerCase();
  return (
    text !== '' &&
    INSUFFICIENT_CONTENT_MARKERS.some((marker) => text.includes(marker))
  );
}

/**
 * The end index of the balanced {...} that opens at `start`, or -1 when the
 * text ends first. Braces inside string literals do not count.
 */
function findObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Every top-level {...} in the text, left to right. An object that does not
 * parse is skipped as a whole: what is nested inside it is part of a broken
 * answer, not an answer of its own.
 */
function* topLevelObjects(text) {
  let start = text.indexOf('{');
  while (start !== -1) {
    const end = findObjectEnd(text, start);
    if (end === -1) {
      return;
    }
    yield text.slice(start, end + 1);
    start = text.indexOf('{', end + 1);
  }
}

/** The repairs Ollama has always applied to an answer that would not parse. */
function repairJson(jsonStr) {
  return jsonStr
    .replace(/,\s*}/g, '}') // Remove trailing commas before closing braces
    .replace(/,\s*]/g, ']') // Remove trailing commas before closing brackets
    .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":'); // Ensure property names are quoted
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The parsed object, or undefined when the text is not one. */
function tryParseObject(text) {
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse a document analysis answer.
 *
 * @param {string|object} raw - The model's answer
 * @returns {{ parsed: object, normalized: string }} The answer object, and
 *   the JSON it was read from (what goes to the response log)
 * @throws {Error} "Invalid JSON response from API: …" when no object can be
 *   read; the first parse error is attached as `cause`
 */
function parseAnalysisResponse(raw) {
  if (isPlainObject(raw)) {
    return { parsed: raw, normalized: JSON.stringify(raw) };
  }

  const text = stripResponseWrapping(raw);
  if (!text) {
    throw new Error(`${INVALID_JSON}: the answer is empty`);
  }

  let firstError;
  try {
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed)) {
      return { parsed, normalized: text };
    }
  } catch (error) {
    firstError = error;
  }

  let sawObject = false;
  for (const candidate of topLevelObjects(text)) {
    sawObject = true;
    for (const attempt of [candidate, repairJson(candidate)]) {
      const parsed = tryParseObject(attempt);
      if (parsed) {
        return { parsed, normalized: attempt };
      }
    }
  }

  if (!sawObject) {
    throw new Error(`${INVALID_JSON}: no JSON object in the answer`, {
      cause: firstError,
    });
  }
  throw new Error(
    `${INVALID_JSON}: unreadable even after repair${firstError ? `: ${firstError.message}` : ''}`,
    { cause: firstError }
  );
}

module.exports = {
  parseAnalysisResponse,
  stripResponseWrapping,
  isInsufficientContentAnswer,
};
