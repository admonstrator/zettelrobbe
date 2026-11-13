// @ts-check
'use strict';

/**
 * The in-memory queue behind the webhook and the manual rescan: documents are
 * pushed here and processed one at a time, outside the scheduled scan of
 * server.js (which has its own, different processDocument()).
 *
 * The queue and its "is processing" flag must exist once: two copies would
 * process the same document twice in parallel.
 */

/* config/config.js builds most of its getters at runtime, which the type
   checker cannot see; read through a loose view of the same live object. */
/** @type {Record<string, any>} */
const config = require('../config/config.js');
const documentModel = require('../models/document.js');
const paperlessService = require('./paperlessService.js');
const setupService = require('./setupService.js');
const AIServiceFactory = require('./aiServiceFactory');
const mistralOcrService = require('./mistralOcrService');
const skipRuleService = require('./skipRuleService');
const documentProcessingService = require('./documentProcessingService');
const { removeThumbnailCacheForDocumentIds } = require('./thumbnailCache');
const {
  shouldQueueForOcrOnAiError,
  classifyOcrQueueReasonFromAiError,
  toNameList,
} = require('./serviceUtils');

/**
 * A Paperless-ngx document as the queue carries it. Only id and title are read
 * here; the rest travels on to the AI service and the write-back.
 *
 * @typedef {{ id: number, title: string } & Record<string, any>} QueuedDocument
 */

/**
 * @typedef {object} QueueEntry
 * @property {QueuedDocument} document
 * @property {boolean} applySkipRules - true for webhook deliveries, false for a rescan by hand
 */

/** Content beyond this many characters is cut before the analysis. */
const MAX_CONTENT_LENGTH = 50000;

class WebhookQueueService {
  constructor() {
    /** @type {QueueEntry[]} */
    this.documentQueue = [];
    this.isProcessing = false;
  }

  /**
   * @param {string} url - the document URL Paperless-ngx sends in the webhook
   * @returns {number} the document id
   * @throws {Error} when the URL holds no /documents/<id>/ segment
   */
  extractDocumentId(url) {
    const match = url.match(/\/documents\/(\d+)\//);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
    throw new Error('Could not extract document ID from URL');
  }

  /**
   * Adds a document to the end of the queue. Does not start processing; call
   * processQueue() for that.
   *
   * @param {QueuedDocument} document
   * @param {{ applySkipRules: boolean }} options
   * @returns {void}
   */
  enqueue(document, { applySkipRules }) {
    this.documentQueue.push({ document, applySkipRules });
  }

  /** @returns {number} documents waiting in the queue */
  getQueueLength() {
    return this.documentQueue.length;
  }

  /**
   * Analyses one queued document. Returns null when the document is skipped
   * (already processed, failed before, not editable, ignored, too short).
   *
   * @param {QueuedDocument} doc
   * @param {string[]} existingTags
   * @param {string[]} existingCorrespondentList
   * @param {string[]} existingDocumentTypesList
   * @param {string|null} [customPrompt]
   * @param {{ applySkipRules?: boolean }} [options]
   * @returns {Promise<{ analysis: any, originalData: any }|null>}
   */
  async processDocument(
    doc,
    existingTags,
    existingCorrespondentList,
    existingDocumentTypesList,
    customPrompt = null,
    { applySkipRules = false } = {}
  ) {
    const isProcessed = await documentModel.isDocumentProcessed(doc.id);
    if (isProcessed) {
      console.log(
        `[DEBUG] Document ${doc.id} already in processed_documents — skipping. Remove via Rescan to reprocess.`
      );
      return null;
    }

    const isFailed = await documentModel.isDocumentFailed(doc.id);
    if (isFailed) {
      console.log(
        `[DEBUG] Document ${doc.id} is marked as permanently failed, skipping until reset`
      );
      return null;
    }

    await documentModel.setProcessingStatus(doc.id, doc.title, 'processing');

    const documentEditable = await paperlessService.getPermissionOfDocument(
      doc.id
    );
    if (!documentEditable) {
      console.log(
        `[DEBUG] Document belongs to: ${documentEditable}, skipping analysis`
      );
      console.log(
        `[DEBUG] Document ${doc.id} Not Editable by Paper-Ai User, skipping analysis`
      );
      return null;
    } else {
      console.log(`[DEBUG] Document ${doc.id} rights for AI User - processed`);
    }

    /** @type {[any, any]} */
    let [content, originalData] = await Promise.all([
      paperlessService.getDocumentContent(doc.id),
      paperlessService.getDocument(doc.id),
    ]);

    // A webhook delivers what Paperless-ngx just consumed, so the ignored list
    // and the skip rules hold here as in the scan. A rescan asked for by hand
    // passes both.
    if (applySkipRules) {
      if (await documentModel.isDocumentIgnored(doc.id)) {
        await documentModel.clearProcessingStatusByDocumentId(doc.id);
        console.log(
          `[DEBUG] Document ${doc.id} is on the ignored list, skipping`
        );
        return null;
      }
      if (await skipRuleService.apply(originalData || doc, content)) {
        return null;
      }
    }

    const minContentLength = config.minContentLength;
    if (!content || content.length < minContentLength) {
      console.log(
        `[DEBUG] Document ${doc.id} has insufficient content (${content?.length || 0} chars, minimum: ${minContentLength}), skipping analysis`
      );
      if (mistralOcrService.isEnabled()) {
        const added = await documentModel.addToOcrQueue(
          doc.id,
          doc.title,
          `short_content_lt_${minContentLength}`
        );
        if (added) {
          console.log(
            `[OCR] Document ${doc.id} queued for Mistral OCR (short_content)`
          );
        }
      } else {
        await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
        await documentModel.addFailedDocument(
          doc.id,
          doc.title,
          `insufficient_content_lt_${minContentLength}`,
          'ai'
        );
      }
      return null;
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.substring(0, MAX_CONTENT_LENGTH);
    }

    // Prepare options for AI service
    /** @type {Record<string, any>} */
    const options = {
      restrictToExistingTags: config.restrictToExistingTags === 'yes',
      restrictToExistingCorrespondents:
        config.restrictToExistingCorrespondents === 'yes',
    };

    // Get external API data if enabled
    if (config.externalApiConfig.enabled === 'yes') {
      try {
        const externalApiService = require('./externalApiService');
        const externalData = await externalApiService.fetchData();
        if (externalData) {
          options.externalApiData = externalData;
          console.log(
            '[DEBUG] Retrieved external API data for prompt enrichment'
          );
        }
      } catch (error) {
        console.error(
          '[ERROR] Failed to fetch external API data:',
          /** @type {Error} */ (error).message
        );
      }
    }

    /** @type {any} */
    const aiService = AIServiceFactory.getService();
    /** @type {any} */
    let analysis;
    if (customPrompt) {
      console.log('[DEBUG] Starting document analysis with custom prompt');
      analysis = await aiService.analyzeDocument(
        content,
        existingTags,
        existingCorrespondentList,
        existingDocumentTypesList,
        doc.id,
        customPrompt,
        options
      );
    } else {
      analysis = await aiService.analyzeDocument(
        content,
        existingTags,
        existingCorrespondentList,
        existingDocumentTypesList,
        doc.id,
        null,
        options
      );
    }
    console.log('Repsonse from AI service:', analysis);
    if (analysis.error) {
      let queuedForOcr = false;
      if (
        mistralOcrService.isEnabled() &&
        shouldQueueForOcrOnAiError(analysis.error)
      ) {
        const queueReason = classifyOcrQueueReasonFromAiError(analysis.error);
        const added = await documentModel.addToOcrQueue(
          doc.id,
          doc.title,
          queueReason
        );
        if (added) {
          console.log(
            `[OCR] Document ${doc.id} queued for Mistral OCR (ai_failed: ${analysis.error})`
          );
        }
        queuedForOcr = true;
      }

      if (!mistralOcrService.isEnabled()) {
        await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
        await documentModel.addFailedDocument(
          doc.id,
          doc.title,
          'ai_failed_ocr_disabled',
          'ai'
        );
      } else if (!queuedForOcr) {
        await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
        await documentModel.addFailedDocument(
          doc.id,
          doc.title,
          'ai_failed_without_ocr_fallback',
          'ai'
        );
      }
      throw new Error(`[ERROR] Document analysis failed: ${analysis.error}`);
    }
    await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
    return { analysis, originalData };
  }

  /**
   * Works through the queue until it is empty. A call while the queue is
   * already being worked on returns at once; the running pass picks up what
   * was added.
   *
   * @param {string} [customPrompt] - prompt to analyse with instead of the configured one
   * @returns {Promise<void>}
   */
  async processQueue(customPrompt) {
    if (customPrompt) {
      console.log('Using custom prompt:', customPrompt);
    }

    if (this.isProcessing || this.documentQueue.length === 0) return;

    this.isProcessing = true;

    try {
      const isConfigured = await setupService.isConfigured();
      if (!isConfigured) {
        console.log(
          `Setup not completed. Visit http://your-machine-ip:${process.env.PAPERLESS_AI_PORT || 3000}/setup to complete setup.`
        );
        return;
      }

      // No own-user-ID lookup here: it was resolved, threaded through two call
      // frames and dropped, since processDocument() never reads it. It also used
      // to gate the queue — an unresolvable ID aborted manual processing
      // outright (issue #305) — so this drops the guard, the request and the
      // warning it would now log once per run.
      const [existingTags, existingCorrespondentList, existingDocumentTypes] =
        await Promise.all([
          paperlessService.getTags(),
          paperlessService.listCorrespondentsNames(),
          paperlessService.listDocumentTypesNames(),
        ]);

      // The paperlessService helpers return entity objects, so every list has to
      // be reduced to plain names before it reaches the AI services — otherwise
      // the "Pre-existing ..." prompt blocks render as "[object Object]".
      const existingTagNames = toNameList(existingTags);
      const existingCorrespondentNames = toNameList(existingCorrespondentList);
      const existingDocumentTypesList = toNameList(existingDocumentTypes);

      while (this.documentQueue.length > 0) {
        const { document: doc, applySkipRules } = /** @type {QueueEntry} */ (
          this.documentQueue.shift()
        );

        try {
          const result = await this.processDocument(
            doc,
            existingTagNames,
            existingCorrespondentNames,
            existingDocumentTypesList,
            customPrompt,
            { applySkipRules }
          );
          if (!result) continue;

          const { analysis, originalData } = result;
          const updateData = await documentProcessingService.buildUpdateData(
            analysis,
            doc
          );
          await documentProcessingService.saveDocumentChanges(
            doc.id,
            updateData,
            analysis,
            originalData
          );
        } catch (error) {
          console.error(`[ERROR] Failed to process document ${doc.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[ERROR] Error during queue processing:', error);
    } finally {
      this.isProcessing = false;

      if (this.documentQueue.length > 0) {
        this.processQueue();
      }
    }
  }

  /**
   * Reprocess specific documents by ID, bypassing the scan tag/filter rules.
   *
   * Clears the local processed_documents record (so the processDocument() gate
   * lets them through) and enqueues each document for direct AI processing via
   * the shared documentQueue — regardless of whether it still carries the
   * configured trigger tag. Processing runs in the background (fire-and-forget)
   * so callers get a fast response.
   *
   * Fetch first, delete second. deleteDocumentsIdList() also clears
   * original_documents, which holds the only copy of a document's pre-AI title,
   * tags and correspondent — the thing "restore original" restores from. Deleting
   * it before knowing whether the document can be fetched meant a rescan started
   * during a Paperless-ngx restart destroyed that snapshot for every selected
   * document and then reported success. Now a document that cannot be resolved
   * costs nothing: its records stay untouched and it comes back in `notFound`.
   *
   * @param {Array<number|string>} ids - Document IDs to reprocess.
   * @returns {Promise<{queued: number, notFound: number[]}>}
   */
  async rescanDocumentsByIds(ids) {
    const numericIds = (Array.isArray(ids) ? ids : [])
      .map((id) => parseInt(String(id), 10))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (numericIds.length === 0) {
      return { queued: 0, notFound: [] };
    }

    /** @type {number[]} */
    const notFound = [];
    /** @type {{ id: number, document: QueuedDocument }[]} */
    const resolvedDocuments = [];

    for (const id of numericIds) {
      try {
        const document = await paperlessService.getDocument(id);
        if (!document) {
          notFound.push(id);
          continue;
        }
        resolvedDocuments.push({ id, document });
      } catch (error) {
        console.error(
          `[ERROR] Failed to fetch document ${id} for rescan:`,
          /** @type {Error} */ (error).message
        );
        notFound.push(id);
      }
    }

    if (resolvedDocuments.length === 0) {
      return { queued: 0, notFound };
    }

    // Drop the local "already processed" record so the gate in processDocument()
    // no longer skips these documents — only for the ones that really exist.
    const resolvedIds = resolvedDocuments.map((entry) => entry.id);
    await documentModel.deleteDocumentsIdList(resolvedIds);
    await removeThumbnailCacheForDocumentIds(resolvedIds);

    for (const entry of resolvedDocuments) {
      this.documentQueue.push({
        document: entry.document,
        applySkipRules: false,
      });
    }
    const queued = resolvedDocuments.length;

    // Fire-and-forget: the HTTP response should not wait for AI processing.
    this.processQueue();

    return { queued, notFound };
  }
}

module.exports = new WebhookQueueService();
