'use strict';

/**
 * The one place the analyzeDocument() result shape lives.
 *
 * Three callers read it — server.js processDocument(),
 * mistralOcrService._runAiAnalysis() and routes/setup.js processDocument() —
 * and hand `document` to documentProcessingService.buildUpdateData(). A
 * narrowed `document` does not fail, it silently stops setting fields.
 *
 * Failures are returned, never thrown: the scan loop routes a failed analysis
 * to the OCR queue by matching `error` against fixed phrases
 * (shouldQueueForOcrOnAiError), and a throw would skip that entirely.
 */

/**
 * @param {Object} document - What the model assigned
 * @param {{promptTokens:number, completionTokens:number, totalTokens:number}|null} metrics
 * @param {boolean} truncated - Whether the document was cut to fit
 */
function buildSuccess(document, metrics, truncated) {
  return { document, metrics, truncated };
}

/**
 * @param {Error} error - Why the analysis failed
 * @param {string} [message] - Replaces error.message, e.g. a normalized timeout
 */
function buildFailure(error, message = error.message) {
  return {
    document: { tags: [], correspondent: null },
    metrics: null,
    error: message,
    // Undefined for everything that is not one of ours; the scan loop falls
    // back to its generic reason then.
    errorCode: error.code,
  };
}

/**
 * The answer of a model that declined the document as too thin to analyse.
 * Returned with a placeholder document instead of thrown, so the retry loop
 * does not ask again; the error phrase routes it to OCR.
 *
 * @param {string|number} id - Paperless document id
 * @param {Object|null} metrics - The tokens the refusal cost
 */
function buildInsufficientContent(id, metrics) {
  return {
    document: {
      tags: [],
      correspondent: 'Unknown',
      title: `Document ${id}`,
      document_date: new Date().toISOString().split('T')[0],
      document_type: 'Document',
      language: 'und',
    },
    metrics,
    truncated: false,
    error: 'Insufficient content for AI analysis',
  };
}

/**
 * Throw unless the answer assigns something: a tags array and a correspondent
 * that is a string or null.
 *
 * @param {Object} parsed - The parsed answer
 * @throws {Error} "AI could not determine assignable metadata: …"
 */
function assertAssignableMetadata(parsed) {
  if (
    !parsed ||
    !Array.isArray(parsed.tags) ||
    (typeof parsed.correspondent !== 'string' && parsed.correspondent !== null)
  ) {
    throw new Error(
      'AI could not determine assignable metadata: no tags or correspondent found'
    );
  }
}

/**
 * Every document field present: tags an array, everything else a value or
 * null; fields the model invented are dropped. Shapes every provider's
 * success, after assertAssignableMetadata() has seen the parsed answer.
 *
 * @param {Object} parsed - The parsed answer
 */
function withDocumentDefaults(parsed) {
  return {
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    correspondent: parsed.correspondent || null,
    title: parsed.title || null,
    document_date: parsed.document_date || null,
    document_type: parsed.document_type || null,
    language: parsed.language || null,
    custom_fields: parsed.custom_fields || null,
  };
}

module.exports = {
  buildSuccess,
  buildFailure,
  buildInsufficientContent,
  assertAssignableMetadata,
  withDocumentDefaults,
};
