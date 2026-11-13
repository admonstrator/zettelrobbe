// @ts-check
'use strict';

/**
 * The in-memory queue behind the webhook and the manual rescan: documents are
 * pushed here and processed one at a time, outside the scheduled scan of
 * server.js. Both go through services/documentPipeline.js like the scan; a
 * webhook entry as source 'webhook', a rescan entry as source 'rescan'.
 *
 * The queue and its "is processing" flag must exist once: two copies would
 * process the same document twice in parallel.
 */

const documentModel = require('../models/document.js');
const paperlessService = require('./paperlessService.js');
const setupService = require('./setupService.js');
const documentPipeline = require('./documentPipeline.js');
const documentProcessingService = require('./documentProcessingService');
const { removeThumbnailCacheForDocumentIds } = require('./thumbnailCache');
const { toNameList } = require('./serviceUtils');

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
          const result = await documentPipeline.processDocument(
            doc,
            existingTagNames,
            existingCorrespondentNames,
            existingDocumentTypesList,
            {
              source: applySkipRules ? 'webhook' : 'rescan',
              customPrompt: customPrompt || null,
            }
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
          // Complete only once the result is in Paperless-ngx, as the scan does.
          await documentModel.setProcessingStatus(
            doc.id,
            doc.title,
            'complete'
          );
        } catch (error) {
          // A failed analysis or write-back leaves no "processing" mark behind.
          await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
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
   * A document the OCR path is responsible for (it waits in the OCR queue or
   * an OCR run is reading it, see documentPipeline.isWaitingForOcr) is left
   * alone as well: the pipeline would skip it, so deleting its records would
   * lose them for nothing. It comes back in `waitingForOcr` and is analysed
   * once OCR has read it.
   *
   * @param {Array<number|string>} ids - Document IDs to reprocess.
   * @returns {Promise<{queued: number, notFound: number[], waitingForOcr: number[]}>}
   */
  async rescanDocumentsByIds(ids) {
    const numericIds = (Array.isArray(ids) ? ids : [])
      .map((id) => parseInt(String(id), 10))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (numericIds.length === 0) {
      return { queued: 0, notFound: [], waitingForOcr: [] };
    }

    /** @type {number[]} */
    const notFound = [];
    /** @type {number[]} */
    const waitingForOcr = [];
    /** @type {{ id: number, document: QueuedDocument }[]} */
    const resolvedDocuments = [];

    for (const id of numericIds) {
      if (await documentPipeline.isWaitingForOcr(id)) {
        waitingForOcr.push(id);
        continue;
      }
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
      return { queued: 0, notFound, waitingForOcr };
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

    return { queued, notFound, waitingForOcr };
  }
}

module.exports = new WebhookQueueService();
