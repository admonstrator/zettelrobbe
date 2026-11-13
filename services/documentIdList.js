'use strict';

/**
 * Reads the document ids a row or bulk action sends, shared by the OCR queue
 * (routes/ocr.js) and the failed/ignored queues (routes/queues.js). Moved
 * verbatim from routes/setup.js.
 *
 * Exports: normalizeDocumentIdList.
 */

/* Accepts what the row menu sends (one id) and what the bulk menu sends (a
   list), so both reach the same endpoint. Anything that is not a positive
   whole number is dropped rather than rejected: a selection is assembled from
   checkboxes, and one stale row should not fail the other forty. */
function normalizeDocumentIdList(input) {
  const raw = Array.isArray(input) ? input : [input];
  const ids = raw
    .map((value) => Number.parseInt(String(value ?? '').trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);

  return [...new Set(ids)];
}

module.exports = { normalizeDocumentIdList };
