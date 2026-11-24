// @ts-check
'use strict';

/**
 * OCR before the first AI analysis (OCR_BEFORE_AI, discussion #280).
 *
 * Without it a document reaches OCR only as a fallback: its text is too
 * short, or the analysis failed in a way OCR can fix. A document whose
 * Paperless-ngx text is long but poor is analysed on that text first, and
 * once more after someone sends it to OCR by hand. The setting sends chosen
 * documents (`tagged`) or every new one (`all`) through the OCR queue before
 * their first analysis instead.
 *
 * The values and the tag match live here because three places share them:
 * config/config.js reads the setting, services/settingsCatalog.js saves it
 * and services/documentPipeline.js acts on it. Nothing here reads
 * process.env or calls Paperless-ngx.
 */

/**
 * @typedef {'off'|'tagged'|'all'} OcrBeforeAiMode
 */

/**
 * The values of OCR_BEFORE_AI. `off` is the behaviour without the setting.
 *
 * @type {ReadonlyArray<OcrBeforeAiMode>}
 */
const OCR_BEFORE_AI_MODES = Object.freeze(['off', 'tagged', 'all']);

/** @type {OcrBeforeAiMode} */
const DEFAULT_OCR_BEFORE_AI_MODE = 'off';

/** The tag `tagged` looks for when OCR_BEFORE_AI_TAG is not set. */
const DEFAULT_OCR_BEFORE_AI_TAG = 'needs-ocr';

/** The OCR queue reason of a document this setting sent. */
const OCR_BEFORE_AI_REASON = 'ocr_before_ai';

/**
 * One of the values, or null for anything else. Case and surrounding
 * spaces do not count.
 *
 * @param {unknown} value
 * @returns {OcrBeforeAiMode|null}
 */
function parseOcrBeforeAiMode(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  const mode = OCR_BEFORE_AI_MODES.find(
    (candidate) => candidate === normalized
  );
  return mode || null;
}

/**
 * The mode in effect: an unknown or empty value is `off`, so a typo never
 * sends documents to a paid OCR service.
 *
 * @param {unknown} value
 * @returns {OcrBeforeAiMode}
 */
function normalizeOcrBeforeAiMode(value) {
  return parseOcrBeforeAiMode(value) || DEFAULT_OCR_BEFORE_AI_MODE;
}

/**
 * Whether a document carries the tag named `tagName`. The name is matched
 * case-insensitively against the tag list Paperless-ngx holds (the cached
 * one of paperlessService), and the document's tag ids against the ids of
 * the tags that have it. A name no tag has, or an empty one, matches no
 * document.
 *
 * @param {unknown} documentTagIds - the document's `tags`: ids, or objects with an id
 * @param {unknown} tagName
 * @param {ReadonlyArray<{ id?: unknown, name?: unknown }>|null|undefined} tagList
 * @returns {boolean}
 */
function documentCarriesTag(documentTagIds, tagName, tagList) {
  const wanted = String(tagName ?? '')
    .trim()
    .toLowerCase();
  if (!wanted || !Array.isArray(documentTagIds) || !Array.isArray(tagList)) {
    return false;
  }

  /** @type {Set<number>} */
  const matchingIds = new Set();
  for (const tag of tagList) {
    if (
      typeof tag?.name === 'string' &&
      tag.name.trim().toLowerCase() === wanted
    ) {
      const id = Number(tag.id);
      if (Number.isInteger(id)) matchingIds.add(id);
    }
  }
  if (matchingIds.size === 0) return false;

  return documentTagIds.some((entry) => {
    const id = Number(
      entry && typeof entry === 'object' ? /** @type {any} */ (entry).id : entry
    );
    return matchingIds.has(id);
  });
}

module.exports = {
  OCR_BEFORE_AI_MODES,
  DEFAULT_OCR_BEFORE_AI_MODE,
  DEFAULT_OCR_BEFORE_AI_TAG,
  OCR_BEFORE_AI_REASON,
  parseOcrBeforeAiMode,
  normalizeOcrBeforeAiMode,
  documentCarriesTag,
};
