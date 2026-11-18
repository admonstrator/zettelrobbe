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
 * The three callers grew apart while each had its own copy. They now protect
 * a document the same way: the OCR guards of issue #322, the ignored list
 * before any Paperless-ngx call, the service's failure code and the timeout
 * hint, the external API data, MIN_CONTENT_LENGTH read live. What still
 * differs does so on purpose, and each difference is a named switch in
 * CALLER_PROFILES that says why.
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
const { OCR_BEFORE_AI_REASON, documentCarriesTag } = require('./ocrBeforeAi');
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
 * How one caller treats a document: only the differences that are meant.
 *
 * @typedef {object} CallerProfile
 * @property {boolean} logAlreadyProcessed - say so when a document is skipped
 *   because it is already processed. The scan walks every document on each
 *   run and would log one line per processed document; a webhook or rescan
 *   names the one document it got, so the line explains a "nothing happened".
 * @property {boolean} checkIgnoredList - leave an ignored document alone,
 *   before anything is written or fetched. Off for a rescan: asking for a
 *   document by hand exempts it, as unignoring it does.
 * @property {boolean} applySkipRules - run the skip rules (page limit, title
 *   patterns, repeated text) before OCR and AI. Off for a rescan, for the
 *   same reason.
 * @property {boolean} trackRetries - count non-terminal AI failures per
 *   document and give up after MAX_ATTEMPTS. Only the scan: it comes back to
 *   every unprocessed document on every tick and would retry forever. A
 *   webhook or a rescan is one delivery or one click for one document, and
 *   no loop brings it back.
 * @property {boolean} applyOcrBeforeAi - send the document through the OCR
 *   queue before its first analysis when OCR_BEFORE_AI applies to it. The
 *   scan and the webhook meet a new document there. Off for a rescan: the
 *   person asked for an analysis now, of a document that was analysed
 *   before, and can send it to OCR by hand instead.
 */

/**
 * The three callers. A rescan by hand is the webhook path without the ignored
 * list, the skip rules and OCR before the first analysis.
 *
 * @type {Readonly<Record<PipelineSource, Readonly<CallerProfile>>>}
 */
const CALLER_PROFILES = Object.freeze({
  scan: Object.freeze({
    logAlreadyProcessed: false,
    checkIgnoredList: true,
    applySkipRules: true,
    trackRetries: true,
    applyOcrBeforeAi: true,
  }),
  webhook: Object.freeze({
    logAlreadyProcessed: true,
    checkIgnoredList: true,
    applySkipRules: true,
    trackRetries: false,
    applyOcrBeforeAi: true,
  }),
  rescan: Object.freeze({
    logAlreadyProcessed: true,
    checkIgnoredList: false,
    applySkipRules: false,
    trackRetries: false,
    applyOcrBeforeAi: false,
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
 * @property {() => Promise<unknown>} [getExternalApiData] - the external API
 *   data of this run, from externalApiDataForRun(): a scan run or a pass over
 *   the webhook queue asks the API once, not once per document. Left out,
 *   the data is fetched for this document alone.
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
    /**
     * Documents a caller is working on right now, from its first check to
     * the status after the write-back. Process-wide: the scan and the
     * webhook queue run side by side, and without a claim both pass
     * isDocumentProcessed() for the same document and pay for two analyses
     * and two write-backs.
     *
     * @type {Set<number>}
     */
    this.inFlight = new Set();
  }

  /**
   * Claims a document for the calling run. A caller claims before its first
   * check and releases in its finally, after the write-back and the status;
   * a caller that cannot claim leaves the document alone (the scan finds it
   * again on its next run).
   *
   * @param {number} documentId
   * @returns {boolean} false when another run holds the document
   */
  claim(documentId) {
    const id = Number(documentId);
    if (this.inFlight.has(id)) {
      return false;
    }
    this.inFlight.add(id);
    return true;
  }

  /**
   * @param {number} documentId
   * @returns {void}
   */
  release(documentId) {
    this.inFlight.delete(Number(documentId));
  }

  /**
   * Whether the OCR path is responsible for the document right now: an OCR
   * run is reading it, or it waits in the OCR queue (pending or processing).
   * Such a document gets both its text and its analysis from that path.
   *
   * A queue row only counts while OCR is switched on. With OCR off nothing
   * works the queue, and a pending row would hold the document back forever.
   * A run in progress counts either way: it is reading the document now.
   *
   * Looked up per document, not once per run: the webhook queue picks up
   * entries added while it drains, and the OCR queue changes meanwhile too.
   *
   * @param {number} documentId
   * @returns {Promise<boolean>}
   */
  async isWaitingForOcr(documentId) {
    if (mistralOcrService.isDocumentActivelyProcessing(documentId)) {
      return true;
    }
    if (!mistralOcrService.isEnabled()) {
      return false;
    }
    const queueItem = await documentModel.getOcrQueueItem(documentId);
    return (
      queueItem?.status === 'pending' || queueItem?.status === 'processing'
    );
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
   * failed before, ignored, not editable, matched by a skip rule, sent to OCR
   * before its first analysis, too short, waiting for OCR, out of attempts).
   * Throws when the analysis failed; the failure is recorded, or the document
   * queued for OCR, before it throws.
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
    if (await this.isWaitingForOcr(doc.id)) {
      console.debug(
        `Document ${doc.id} is waiting for Mistral OCR, skipping analysis this round`
      );
      return null;
    }

    if (
      profile.checkIgnoredList &&
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

    // Skip rules come before both OCR and AI: a hundred pages of terms and
    // conditions should cost neither.
    if (
      profile.applySkipRules &&
      (await skipRuleService.apply(originalData || doc, content))
    ) {
      this.forgetAttempts(profile, doc.id);
      return null;
    }

    // OCR before the first analysis (OCR_BEFORE_AI). After the skip rules, so
    // an ignored document costs neither OCR nor AI; before the short-content
    // branch, which would queue the same document under another reason. With
    // OCR switched off the setting does nothing.
    if (profile.applyOcrBeforeAi && mistralOcrService.isEnabled()) {
      const step = await this.ocrBeforeAiStep(doc, originalData);
      if (step === 'queue') {
        const added = await this.queueForOcr(doc, OCR_BEFORE_AI_REASON);
        if (added) {
          // The analysis will read new text; failures on the old one no
          // longer count against it.
          this.forgetAttempts(profile, doc.id);
          console.info(
            `Document ${doc.id} queued for OCR before its first analysis (${OCR_BEFORE_AI_REASON})`
          );
        }
        return null;
      }
      if (step === 'analyse') {
        content = await this.textAfterOcr(doc.id, content);
      }
    }

    // Read per document: a saved MIN_CONTENT_LENGTH applies to the next one.
    const minContentLength = config.minContentLength;
    if (!content || content.length < minContentLength) {
      console.debug(
        `Document ${doc.id} has insufficient content (${content?.length || 0} chars, minimum: ${minContentLength}), skipping analysis`
      );
      if (mistralOcrService.isEnabled()) {
        const added = await this.queueForOcr(
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
      // Recorded like every other terminal failure. Without the row the next
      // run starts a fresh count and pays for three more analyses, forever.
      // The failed page lists it, and its reset brings the document back.
      await documentModel.addFailedDocument(
        doc.id,
        doc.title,
        'ai_failed_retry_limit',
        'ai'
      );
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
    const externalApiData = options.getExternalApiData
      ? await options.getExternalApiData()
      : await this.fetchExternalApiData();
    if (externalApiData) {
      analysisOptions.externalApiData = externalApiData;
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
    const timedOut = isTimeoutError(analysis.error);
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
      const added = await this.queueForOcr(doc, queueReason);
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

    // A service that knows exactly why it gave up says so; everything else
    // keeps the generic reason.
    const serviceCode = analysis.errorCode || null;
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
   * What OCR before the first analysis (OCR_BEFORE_AI) asks of a document
   * that is about to be analysed:
   *
   * - 'none': the setting is off, or the document lacks the tag `tagged`
   *   looks for
   * - 'queue': it applies and the document was never sent to OCR; it goes to
   *   the OCR queue now and is analysed once OCR has read it
   * - 'analyse': it applies, but the document was sent to OCR before (by
   *   this setting, by hand or as a fallback). That run is over, failed or
   *   was removed from the queue, so the document is analysed now and never
   *   queued again.
   *
   * At most once per document: ocr_queue_history remembers every document
   * that was ever queued, also after its queue row is gone (done and written
   * back, removed on the OCR page). A row that is still pending or
   * processing never gets this far (isWaitingForOcr).
   *
   * `tagged` matches the tag by name, case-insensitively, through the cached
   * tag list of paperlessService rather than one request per document. A
   * name no tag has matches nothing. A tag list that cannot be read throws:
   * the document is left for the next run instead of being analysed on the
   * text it was meant to have replaced first.
   *
   * @param {PipelineDocument} doc
   * @param {any} originalData - the document as Paperless-ngx holds it
   * @returns {Promise<'none'|'queue'|'analyse'>}
   */
  async ocrBeforeAiStep(doc, originalData) {
    const mode = config.mistralOcr?.ocrBeforeAi;
    if (mode !== 'tagged' && mode !== 'all') {
      return 'none';
    }

    if (mode === 'tagged') {
      const tagName = String(config.mistralOcr?.ocrBeforeAiTag || '').trim();
      if (!tagName) {
        return 'none';
      }
      /** @type {any[]} */
      let tags;
      try {
        tags = await paperlessService.getTags();
      } catch (error) {
        throw new Error(
          `Could not read the Paperless-ngx tag list to look for the OCR tag "${tagName}": ${/** @type {Error} */ (error).message}`,
          { cause: error }
        );
      }
      const documentTags = originalData?.tags ?? doc.tags;
      if (!documentCarriesTag(documentTags, tagName, tags)) {
        return 'none';
      }
    }

    return (await documentModel.wasEverQueuedForOcr(doc.id))
      ? 'analyse'
      : 'queue';
  }

  /**
   * The text an analysis after OCR reads: normally what Paperless-ngx holds,
   * which is the OCR text once the run wrote it back. When Paperless-ngx
   * refused the write-back, the OCR text exists only in the queue row, and
   * the analysis reads it from there rather than the text OCR was meant to
   * replace.
   *
   * @param {number} documentId
   * @param {any} content - the text Paperless-ngx holds
   * @returns {Promise<any>}
   */
  async textAfterOcr(documentId, content) {
    const queueItem = await documentModel.getOcrQueueItem(documentId);
    const ocrText = queueItem?.ocr_text;
    if (
      queueItem?.wrote_back === 0 &&
      typeof ocrText === 'string' &&
      ocrText.trim()
    ) {
      console.info(
        `Document ${documentId}: analysing the text of its OCR run, which Paperless-ngx did not accept`
      );
      return ocrText;
    }
    return content;
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
   * @param {PipelineDocument} doc
   * @param {string} queueReason
   * @returns {Promise<boolean>} true when a queue row was written
   */
  async queueForOcr(doc, queueReason) {
    if (await documentModel.isDocumentProcessed(doc.id)) {
      console.debug(
        `Document ${doc.id} was processed while it was being analysed, not queued for Mistral OCR (already processed)`
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
   * The external API data of one run, fetched when the first document needs
   * it and reused for the rest: a first scan of 2000 documents makes one
   * call, an unreachable API costs one timeout per run instead of one per
   * document, and a run that analyses nothing makes none.
   *
   * @returns {() => Promise<unknown>}
   */
  externalApiDataForRun() {
    /** @type {Promise<unknown>|null} */
    let pending = null;
    return () => {
      if (!pending) {
        pending = this.fetchExternalApiData();
      }
      return pending;
    };
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
