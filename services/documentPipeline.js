// @ts-check
'use strict';

/**
 * One document, from "is it due?" to "here is what the model made of it". The
 * scheduled scan (services/scanService.js), a webhook delivery and a rescan
 * asked for by hand (services/webhookQueueService.js) all go through
 * processDocument() below.
 * Writing the result back to Paperless-ngx stays with the callers, which do it
 * through services/documentProcessingService.js.
 *
 * The three callers grew apart while each had its own copy, and they still do
 * not behave alike. Every difference is a named switch in CALLER_PROFILES, so
 * it can be read, and changed, in one place. Where a difference looks like an
 * oversight rather than a choice, the profile says so; the behaviour is kept
 * until someone decides otherwise.
 */

/* config/config.js builds most of its getters at runtime, which the type
   checker cannot see; read through a loose view of the same live object. */
/** @type {Record<string, any>} */
const config = require('../config/config.js');
const documentModel = require('../models/document.js');
const paperlessService = require('./paperlessService.js');
const AIServiceFactory = require('./aiServiceFactory');
const mistralOcrService = require('./mistralOcrService');
const skipRuleService = require('./skipRuleService');
const {
  shouldQueueForOcrOnAiError,
  classifyOcrQueueReasonFromAiError,
  isTimeoutError,
  buildTimeoutErrorMessage,
} = require('./serviceUtils');

/**
 * A Paperless-ngx document as the callers hand it over. Only id and title are
 * read here; the rest travels on to the skip rules.
 *
 * @typedef {{ id: number, title: string } & Record<string, any>} PipelineDocument
 */

/** @typedef {'scan'|'webhook'|'rescan'} PipelineSource */

/**
 * How one caller treats a document. Each switch is a difference between the
 * callers that existed when their two implementations were merged.
 *
 * @typedef {object} CallerProfile
 * @property {boolean} logAlreadyProcessed - say so when a document is skipped
 *   because it is already processed. The scan walks every document on each
 *   run and stays quiet; a webhook or rescan names the one document it got.
 * @property {boolean} skipWhileOcrPending - leave a document alone while it
 *   waits in the OCR queue or is inside an OCR run (issue #322).
 * @property {'first'|'after-fetch'|'never'} ignoredList - when the ignored
 *   list is read: before anything is written, after the document was fetched
 *   (and its processing mark is then cleared again), or not at all.
 * @property {boolean} applySkipRules - run the skip rules (page limit, title
 *   patterns, repeated text) before OCR and AI.
 * @property {boolean} guardedOcrInsert - queue for OCR only after re-checking
 *   that the document is neither processed nor inside an OCR run, and with
 *   the insert's own skipIfProcessed guard (issue #322).
 * @property {boolean} trackRetries - count non-terminal AI failures per
 *   document and give up after MAX_ATTEMPTS.
 * @property {boolean} timeoutHint - extend a timeout error with a hint to
 *   check the provider and the timeout settings.
 * @property {boolean} serviceFailureCode - record the AI service's own error
 *   code as the failure reason when it gives one.
 * @property {boolean} externalApiData - fetch the external API data and hand
 *   it to the AI service for the prompt.
 */

/**
 * The three callers. A rescan by hand is the webhook path without the ignored
 * list and the skip rules: unignoring a document, or asking for it by hand,
 * exempts it. The remaining differences between scan and webhook are listed
 * as suspected oversights in the commit that introduced this module; flipping
 * a switch here is how one is settled.
 *
 * @type {Readonly<Record<PipelineSource, Readonly<CallerProfile>>>}
 */
const CALLER_PROFILES = Object.freeze({
  scan: Object.freeze({
    logAlreadyProcessed: false,
    skipWhileOcrPending: true,
    ignoredList: 'first',
    applySkipRules: true,
    guardedOcrInsert: true,
    trackRetries: true,
    timeoutHint: true,
    serviceFailureCode: true,
    externalApiData: false,
  }),
  webhook: Object.freeze({
    logAlreadyProcessed: true,
    skipWhileOcrPending: false,
    ignoredList: 'after-fetch',
    applySkipRules: true,
    guardedOcrInsert: false,
    trackRetries: false,
    timeoutHint: false,
    serviceFailureCode: false,
    externalApiData: true,
  }),
  rescan: Object.freeze({
    logAlreadyProcessed: true,
    skipWhileOcrPending: false,
    ignoredList: 'never',
    applySkipRules: false,
    guardedOcrInsert: false,
    trackRetries: false,
    timeoutHint: false,
    serviceFailureCode: false,
    externalApiData: true,
  }),
});

/** Content beyond this many characters is cut before the analysis. */
const MAX_CONTENT_LENGTH = 50000;
/** Non-terminal AI failures a tracked document may have before it is failed. */
const MAX_ATTEMPTS = 3;

/**
 * @typedef {object} ProcessOptions
 * @property {PipelineSource} source - which caller this is; picks the profile
 * @property {string|null} [customPrompt] - prompt to analyse with instead of
 *   the configured one (webhook and rescan)
 * @property {number} [minContentLength] - shortest text worth analysing;
 *   read from the settings when left out. The scan passes the value it read
 *   at boot (MIN_CONTENT_LENGTH restarts the server when it is saved).
 * @property {Set<number>} [ocrQueuedDocumentIds] - documents in the OCR queue
 *   when the scan run started, read once per run
 */

/**
 * @typedef {object} PipelineResult
 * @property {any} analysis - what the AI service returned
 * @property {any} originalData - the document as Paperless-ngx holds it
 */

class DocumentPipeline {
  constructor() {
    /**
     * Non-terminal AI failures per document id, for callers with
     * trackRetries. Process-wide: it outlives one scan run on purpose.
     *
     * @type {Map<number, number>}
     */
    this.retryTracker = new Map();
    /** The switches per caller, for tests and for reading. */
    this.CALLER_PROFILES = CALLER_PROFILES;
  }

  /**
   * @param {PipelineSource} source
   * @returns {Readonly<CallerProfile>}
   */
  profileFor(source) {
    const profile = CALLER_PROFILES[source];
    if (!profile) {
      throw new Error(`Unknown document pipeline source: ${String(source)}`);
    }
    return profile;
  }

  /**
   * Checks whether the document is due, fetches it and has the AI service
   * analyse it. Returns null when the document is skipped (already processed,
   * failed before, ignored, not editable, matched by a skip rule, too short,
   * waiting for OCR, out of attempts). Throws when the analysis failed; the
   * failure is recorded, or the document queued for OCR, before it throws.
   *
   * @param {PipelineDocument} doc
   * @param {string[]} existingTags - tag names
   * @param {string[]} existingCorrespondentList - correspondent names
   * @param {string[]} existingDocumentTypesList - document type names
   * @param {ProcessOptions} options
   * @returns {Promise<PipelineResult|null>}
   */
  async processDocument(
    doc,
    existingTags,
    existingCorrespondentList,
    existingDocumentTypesList,
    options
  ) {
    const profile = this.profileFor(options.source);
    const customPrompt = options.customPrompt || null;

    if (await documentModel.isDocumentProcessed(doc.id)) {
      if (profile.logAlreadyProcessed) {
        console.log(
          `[DEBUG] Document ${doc.id} already in processed_documents — skipping. Remove via Rescan to reprocess.`
        );
      }
      return null;
    }

    // A document that waits in the OCR queue, or sits inside an OCR run right
    // now, gets both its text and its analysis from that path. Analysing it
    // here would work on the very text the OCR run is about to replace, and
    // the three Paperless-ngx calls below would be spent for nothing.
    if (profile.skipWhileOcrPending) {
      const queuedForOcrIds = options.ocrQueuedDocumentIds;
      if (
        (queuedForOcrIds && queuedForOcrIds.has(Number(doc.id))) ||
        mistralOcrService.isDocumentActivelyProcessing(doc.id)
      ) {
        console.debug(
          `Document ${doc.id} is waiting for Mistral OCR, skipping analysis this round`
        );
        return null;
      }
    }

    if (
      profile.ignoredList === 'first' &&
      (await documentModel.isDocumentIgnored(doc.id))
    ) {
      console.debug(
        `Document ${doc.id} is marked as ignored, skipping permanently`
      );
      return null;
    }

    if (await documentModel.isDocumentFailed(doc.id)) {
      console.debug(
        `Document ${doc.id} is marked as permanently failed, skipping until reset`
      );
      return null;
    }

    await documentModel.setProcessingStatus(doc.id, doc.title, 'processing');

    const documentEditable = await paperlessService.getPermissionOfDocument(
      doc.id
    );
    if (!documentEditable) {
      console.debug(
        `Document ${doc.id} is not editable by the Zettelrobbe user, skipping analysis`
      );
      return null;
    }

    console.debug(`Document ${doc.id} is editable by the Zettelrobbe user`);

    /** @type {[any, any]} */
    let [content, originalData] = await Promise.all([
      paperlessService.getDocumentContent(doc.id),
      paperlessService.getDocument(doc.id),
    ]);

    if (
      profile.ignoredList === 'after-fetch' &&
      (await documentModel.isDocumentIgnored(doc.id))
    ) {
      await documentModel.clearProcessingStatusByDocumentId(doc.id);
      console.debug(
        `Document ${doc.id} is marked as ignored, skipping permanently`
      );
      return null;
    }

    // Skip rules come before both OCR and AI: a hundred pages of terms and
    // conditions should cost neither.
    if (
      profile.applySkipRules &&
      (await skipRuleService.apply(originalData || doc, content))
    ) {
      this.forgetAttempts(profile, doc.id);
      return null;
    }

    const minContentLength =
      options.minContentLength ?? config.minContentLength;
    if (!content || content.length < minContentLength) {
      console.debug(
        `Document ${doc.id} has insufficient content (${content?.length || 0} chars, minimum: ${minContentLength}), skipping analysis`
      );
      if (mistralOcrService.isEnabled()) {
        const added = await this.queueForOcr(
          profile,
          doc,
          `short_content_lt_${minContentLength}`
        );
        if (added) {
          console.info(
            `Document ${doc.id} queued for Mistral OCR (short_content)`
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
        this.forgetAttempts(profile, doc.id);
      }
      return null;
    }

    // Check the retry limit to prevent infinite retry loops.
    const attempts = this.retryTracker.get(doc.id) || 0;
    if (profile.trackRetries && attempts >= MAX_ATTEMPTS) {
      console.warn(
        `Document ${doc.id} has failed ${attempts} times, skipping to prevent infinite retry loop`
      );
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      this.retryTracker.delete(doc.id);
      return null;
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.substring(0, MAX_CONTENT_LENGTH);
    }

    /** @type {Record<string, any>} */
    const analysisOptions = {
      restrictToExistingTags: config.restrictToExistingTags === 'yes',
      restrictToExistingCorrespondents:
        config.restrictToExistingCorrespondents === 'yes',
    };
    if (profile.externalApiData) {
      const externalApiData = await this.fetchExternalApiData();
      if (externalApiData) {
        analysisOptions.externalApiData = externalApiData;
      }
    }

    if (customPrompt) {
      console.debug('Starting document analysis with custom prompt');
    }
    /** @type {any} */
    const aiService = AIServiceFactory.getService();
    /** @type {any} */
    const analysis = await aiService.analyzeDocument(
      content,
      existingTags,
      existingCorrespondentList,
      existingDocumentTypesList,
      doc.id,
      customPrompt,
      analysisOptions
    );
    console.debug('Response from AI service:', analysis);

    if (analysis.error) {
      await this.recordAnalysisFailure(profile, doc, analysis, attempts);
    }

    // Clear the retry count on success.
    this.forgetAttempts(profile, doc.id);
    return { analysis, originalData };
  }

  /**
   * Records a failed analysis (OCR fallback, failure row, attempt count) and
   * throws the error the caller logs.
   *
   * @param {Readonly<CallerProfile>} profile
   * @param {PipelineDocument} doc
   * @param {{ error: string, errorCode?: string }} analysis
   * @param {number} attempts - non-terminal failures so far
   * @returns {Promise<never>}
   */
  async recordAnalysisFailure(profile, doc, analysis, attempts) {
    const timedOut = profile.timeoutHint && isTimeoutError(analysis.error);
    const aiErrorMessage = timedOut
      ? `${buildTimeoutErrorMessage('AI')} Original error: ${analysis.error}`
      : analysis.error;

    if (timedOut) {
      console.error(`[TIMEOUT][AI] Document ${doc.id}: ${analysis.error}`);
    }

    let queuedForOcr = false;
    let markedTerminalFailed = false;
    // Queue for OCR on OCR-relevant AI errors (e.g. low content, invalid
    // response structure).
    if (
      mistralOcrService.isEnabled() &&
      shouldQueueForOcrOnAiError(aiErrorMessage)
    ) {
      const queueReason = classifyOcrQueueReasonFromAiError(aiErrorMessage);
      const added = await this.queueForOcr(profile, doc, queueReason);
      if (added) {
        console.log(
          `[OCR] Document ${doc.id} queued for Mistral OCR (ai_failed: ${aiErrorMessage})`
        );
      }
      // The OCR path stays responsible for this document even when nothing
      // was queued: a refusal means it is already processed, already done or
      // inside a run, and none of those is a terminal AI failure worth
      // recording.
      queuedForOcr = true;
    }

    // A service that knows exactly why it gave up says so (for callers that
    // listen); everything else keeps the generic reason.
    const serviceCode = profile.serviceFailureCode ? analysis.errorCode : null;
    if (!mistralOcrService.isEnabled()) {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(
        doc.id,
        doc.title,
        serviceCode || 'ai_failed_ocr_disabled',
        'ai'
      );
      markedTerminalFailed = true;
    } else if (!queuedForOcr) {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(
        doc.id,
        doc.title,
        serviceCode || 'ai_failed_without_ocr_fallback',
        'ai'
      );
      markedTerminalFailed = true;
    }

    if (markedTerminalFailed) {
      this.forgetAttempts(profile, doc.id);
    } else if (profile.trackRetries) {
      this.retryTracker.set(doc.id, attempts + 1);
    }
    throw new Error(`[ERROR] Document analysis failed: ${aiErrorMessage}`);
  }

  /**
   * Puts the document into the OCR queue.
   *
   * The guarded insert exists because the Paperless-ngx calls before it take
   * long enough for a running OCR job to finish in between, delete its queue
   * row and put the document into processed_documents; a fresh pending row
   * then bought a second paid OCR run (issue #322). The checks keep that out
   * of the log and off the wire; skipIfProcessed is the atomic safety net
   * inside the insert itself.
   *
   * @param {Readonly<CallerProfile>} profile
   * @param {PipelineDocument} doc
   * @param {string} queueReason
   * @returns {Promise<boolean>} true when a queue row was written
   */
  async queueForOcr(profile, doc, queueReason) {
    if (!profile.guardedOcrInsert) {
      return documentModel.addToOcrQueue(doc.id, doc.title, queueReason);
    }

    if (await documentModel.isDocumentProcessed(doc.id)) {
      console.debug(
        `Document ${doc.id} was processed while this scan was running, not queued for Mistral OCR (already processed)`
      );
      return false;
    }

    if (mistralOcrService.isDocumentActivelyProcessing(doc.id)) {
      console.debug(
        `Document ${doc.id} is inside an OCR run, not queued for Mistral OCR (currently processing)`
      );
      return false;
    }

    const queued = await documentModel.addToOcrQueue(
      doc.id,
      doc.title,
      queueReason,
      { skipIfProcessed: true }
    );

    if (!queued) {
      const queueItem = await documentModel.getOcrQueueItem(doc.id);
      let state = 'already processed';
      if (queueItem?.status === 'done') {
        state = 'already done';
      } else if (queueItem?.status === 'processing') {
        state = 'currently processing';
      }
      console.debug(
        `Document ${doc.id} was not queued for Mistral OCR (${state})`
      );
    }

    return queued;
  }

  /**
   * The external API data for the prompt, or null when the feature is off or
   * the fetch failed (the analysis goes ahead without it).
   *
   * @returns {Promise<unknown>}
   */
  async fetchExternalApiData() {
    if (config.externalApiConfig.enabled !== 'yes') {
      return null;
    }
    try {
      const externalApiService = require('./externalApiService');
      const externalData = await externalApiService.fetchData();
      if (externalData) {
        console.debug('Retrieved external API data for prompt enrichment');
      }
      return externalData || null;
    } catch (error) {
      console.error(
        '[ERROR] Failed to fetch external API data:',
        /** @type {Error} */ (error).message
      );
      return null;
    }
  }

  /**
   * @param {Readonly<CallerProfile>} profile
   * @param {number} documentId
   * @returns {void}
   */
  forgetAttempts(profile, documentId) {
    if (profile.trackRetries) {
      this.retryTracker.delete(documentId);
    }
  }
}

module.exports = new DocumentPipeline();
