// @ts-check
'use strict';

/**
 * The scheduled scan: one run walks every document Paperless-ngx lists, hands
 * each to services/documentPipeline.js, writes the result back through
 * services/documentProcessingService.js and keeps count. server.js arms the
 * cron jobs and the initial scan and registers triggerScanNow() and
 * requestScanStop() with services/scanControl.js; everything a run does lives
 * here.
 *
 * The run writes to the one scan state of services/scanControl.js while it is
 * in progress; routes and the other cron jobs read it from there.
 */

/* config/config.js builds most of its getters at runtime, which the type
   checker cannot see; read through a loose view of the same live object. */
/** @type {Record<string, any>} */
const config = require('../config/config.js');
/** @type {Record<string, any>} */
const paperlessService = require('./paperlessService.js');
/** @type {Record<string, any>} */
const documentModel = require('../models/document.js');
/** @type {{ running: boolean }} */
const ocrAutoProcessService = require('./ocrAutoProcessService.js');
/** @type {{ isRunning: () => boolean }} */
const duplicateReviewJobService = require('./duplicateReviewJobService.js');
/** @type {{ isWriting: () => boolean }} */
const duplicateMergeService = require('./duplicateMergeService.js');
/** @type {Record<string, any>} */
const scanHealthService = require('./scanHealthService.js');
/** @type {Record<string, any>} */
const dashboardStatsService = require('./dashboardStatsService.js');
/** @type {Record<string, any>} */
const documentProcessingService = require('./documentProcessingService.js');
const documentPipeline = require('./documentPipeline.js');
const scanControlService = require('./scanControl.js');

/** @typedef {import('./scanControl.js').ScanState} ScanState */
/** @typedef {import('./scanControl.js').ScanTriggerResult} ScanTriggerResult */

/**
 * What one run counted, for the summary line at its end.
 *
 * @typedef {object} ScanStats
 * @property {string} source
 * @property {number} total
 * @property {number} processed
 * @property {number} skipped
 * @property {number} failed
 * @property {boolean} stopRequested
 * @property {string|null} abortReason
 */

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return /** @type {Error} */ (error).message;
}

class ScanService {
  constructor() {
    /**
     * The one scan state, owned by services/scanControl.js. Mutated here,
     * never replaced.
     *
     * @type {ScanState}
     */
    this.scanControl = scanControlService.getState();
    /**
     * Minimum content length, read once when the service is loaded at boot:
     * MIN_CONTENT_LENGTH restarts the server when it is saved
     * (services/settingsCatalog.js).
     *
     * @type {number}
     */
    this.minContentLength = config.minContentLength;
  }

  /**
   * Asks the running scan to stop before its next document.
   *
   * @returns {boolean} true when a running scan was asked to stop
   */
  requestScanStop() {
    const scanControl = this.scanControl;
    if (!scanControl.running) {
      return false;
    }

    scanControl.stopRequested = true;
    scanControl.stopRequestedAt = new Date().toISOString();
    return true;
  }

  /**
   * Starts a scan in the background unless something holds it off, and says
   * which.
   *
   * @param {string} [source] - what asks for the scan
   * @returns {Promise<ScanTriggerResult>}
   */
  async triggerScanNow(source = 'manual') {
    const scanControl = this.scanControl;
    if (scanControl.running) {
      return {
        started: false,
        running: true,
        stopRequested: scanControl.stopRequested,
        message: 'Scan is already running.',
      };
    }

    // The OCR drain works on the same documents through the same AI backend.
    // Letting a scan start next to it is what bought a second paid OCR run for a
    // document the drain had just finished (issue #322).
    if (ocrAutoProcessService.running) {
      return {
        started: false,
        running: false,
        message: 'OCR auto-processing is currently running.',
      };
    }

    // The Duplicates and Simplify pages write tags too; the scan loop itself
    // stands down for them, and the button is told why nothing started.
    if (duplicateReviewJobService.isRunning()) {
      return {
        started: false,
        running: false,
        message:
          'A Duplicates or Simplify job is running. Try again when it has finished.',
      };
    }
    if (duplicateMergeService.isWriting()) {
      return {
        started: false,
        running: false,
        message:
          'A merge, undo or delete is being written. Try again in a moment.',
      };
    }

    this.scanDocuments(source).catch((error) => {
      console.error(
        `[ERROR] scanDocuments() failed in triggerScanNow: ${error.message}`
      );
      console.debug(error);
    });

    return {
      started: true,
      running: true,
      stopRequested: false,
      message: 'Scan started.',
    };
  }

  /**
   * One scan run. The initial scan runs through here as well
   * (source='initial') so it shares the concurrency guard, the stop support
   * and the health reporting below.
   *
   * @param {string} [source] - what started the run
   * @returns {Promise<void>}
   */
  async scanDocuments(source = 'scheduler') {
    const scanControl = this.scanControl;
    const { RUN_STATUS } = scanHealthService;
    if (scanControl.running) {
      console.info('Scan request ignored because a task is already running');
      return;
    }

    // The OCR cron already stands down while a scan runs; this is the other
    // direction. Both paths analyse the same documents through the same AI
    // backend, and a scan that overlaps an OCR run is what let a document be
    // OCR'd twice within minutes (issue #322).
    if (ocrAutoProcessService.running) {
      console.info(
        'Scan request ignored because OCR auto-processing is currently running'
      );
      return;
    }

    // The Duplicates and Simplify pages write tags too: their jobs wait for a
    // running scan, and a scan waits for them, because a scan that tags
    // documents while a merge deletes tags is how a document ends up with an
    // id that no longer exists. A merge, undo or delete made by hand counts
    // as well; it is over in seconds and the next tick catches up.
    const busy = duplicateReviewJobService.isRunning()
      ? 'a Duplicates or Simplify job is running'
      : duplicateMergeService.isWriting()
        ? 'a merge, undo or delete is being written'
        : null;
    if (busy) {
      console.info(
        `Scan request ignored because ${busy}; the next scheduled scan tries again`
      );
      return;
    }

    const scanStartedAtMs = Date.now();
    /** @type {ScanStats} */
    const scanStats = {
      source,
      total: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      stopRequested: false,
      abortReason: null,
    };

    scanControl.running = true;
    scanControl.stopRequested = false;
    scanControl.source = source;
    scanControl.startedAt = new Date().toISOString();
    scanControl.stopRequestedAt = null;
    scanHealthService.recordRunStart(source);

    console.info(`Scan started (source=${source})`);

    try {
      // Probe first: the read helpers below swallow transport errors and return
      // empty lists, which would make an unreachable Paperless-ngx look like a
      // successful scan with nothing to do.
      const connection = await paperlessService.checkConnection();
      scanHealthService.recordConnectivity(connection);

      if (!connection.reachable || !connection.authorized) {
        scanStats.abortReason = connection.reachable
          ? 'paperless_unauthorized'
          : 'paperless_unreachable';
        scanHealthService.recordRunResult({
          status: RUN_STATUS.PAPERLESS_UNREACHABLE,
          error: connection.error,
        });
        console.error(
          `[ERROR] Scan aborted: Paperless-ngx is not usable (${connection.error}). ` +
            `The scheduler stays armed and retries at the next interval (${config.scanInterval}).`
        );
        return;
      }

      /** @type {[{ name: string }[], any[], { name: string }[], { name: string }[]]} */
      const [
        existingTags,
        documents,
        existingCorrespondents,
        existingDocumentTypes,
      ] = await Promise.all([
        paperlessService.getTags(),
        paperlessService.getAllDocuments(),
        paperlessService.listCorrespondentsNames(),
        paperlessService.listDocumentTypesNames(),
      ]);

      scanStats.total = documents.length;

      // get existing correspondent list
      const existingCorrespondentList = existingCorrespondents.map(
        (correspondent) => correspondent.name
      );

      // get existing document types list
      const existingDocumentTypesList = existingDocumentTypes.map(
        (docType) => docType.name
      );

      // Extract tag names from tag objects
      const existingTagNames = existingTags.map((tag) => tag.name);

      // Read once per run: every document that waits for OCR or is being OCR'd
      // is skipped below before the scan spends a single Paperless-ngx call on
      // it. Documents that enter the queue during this run are caught by the
      // per-document checks in documentPipeline.processDocument().
      const ocrQueuedDocumentIds = new Set(
        /** @type {Array<number|string>} */ (
          await documentModel.getOcrQueueDocumentIds()
        ).map((documentId) => Number(documentId))
      );

      for (const doc of documents) {
        if (scanControl.stopRequested) {
          scanStats.stopRequested = true;
          console.info(
            `Graceful stop requested. Halting scan before next document (source=${scanControl.source || 'unknown'})`
          );
          break;
        }

        try {
          const result = await documentPipeline.processDocument(
            doc,
            existingTagNames,
            existingCorrespondentList,
            existingDocumentTypesList,
            {
              source: 'scan',
              minContentLength: this.minContentLength,
              ocrQueuedDocumentIds,
            }
          );
          if (!result) {
            scanStats.skipped += 1;
            continue;
          }

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
          await documentModel.setProcessingStatus(
            doc.id,
            doc.title,
            'complete'
          );
          scanStats.processed += 1;
          // The document counters and token figures just changed. Marking the
          // cache stale costs nothing here; the next dashboard poll pays for the
          // rebuild, so a long scan does not rebuild once per document.
          dashboardStatsService.invalidate();
        } catch (error) {
          await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
          scanStats.failed += 1;
          // A failure moves the failed counter and the failure rate, which the
          // dashboard shows just as prominently as the successes.
          dashboardStatsService.invalidate();
          console.error(
            `[ERROR] processing document ${doc.id}: ${messageOf(error)}`
          );
          console.debug(error);
        }
      }

      // Documents that fail individually are not an infrastructure problem, so
      // the run itself still counts as successful for health reporting.
      scanHealthService.recordRunResult({ status: RUN_STATUS.OK });
    } catch (error) {
      scanHealthService.recordRunResult({
        status: RUN_STATUS.ERROR,
        error: messageOf(error),
      });
      scanStats.abortReason = 'error';
      console.error(`[ERROR] during document scan: ${messageOf(error)}`);
      console.debug(error);
    } finally {
      const durationMs = Date.now() - scanStartedAtMs;
      const abortSuffix = scanStats.abortReason
        ? `, aborted=${scanStats.abortReason}`
        : '';
      console.info(
        `Scan completed (source=${scanStats.source}, total=${scanStats.total}, processed=${scanStats.processed}, skipped=${scanStats.skipped}, failed=${scanStats.failed}, stopRequested=${scanStats.stopRequested}${abortSuffix}, durationMs=${durationMs})`
      );

      scanControl.running = false;
      scanControl.stopRequested = false;
      scanControl.source = null;
      scanControl.startedAt = null;
      scanControl.stopRequestedAt = null;

      // Rebuild once the run is over so the first dashboard poll after a scan
      // reads finished numbers instead of paying for the assembly itself.
      // Detached: nothing in the scan depends on it, and an unhandled rejection
      // would take the process down.
      dashboardStatsService.refresh().catch((/** @type {Error} */ error) => {
        console.debug(
          `[DASHBOARD-STATS] Refresh after scan failed: ${error.message}`
        );
      });
    }
  }
}

module.exports = new ScanService();
