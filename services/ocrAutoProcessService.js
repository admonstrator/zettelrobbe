// services/ocrAutoProcessService.js
//
// Drains the pending OCR queue. The document pipeline only ever fills
// `ocr_queue` (services/documentPipeline.js: OCR before the first analysis,
// short content, an OCR-relevant AI error); emptying it used to require
// pressing "Process All Pending" on the /ocr page. This service runs the exact
// same pipeline — mistralOcrService.processQueueItem() does download -> OCR ->
// write-back -> optional AI analysis — at two moments:
//
//   - on its own cron (OCR_AUTO_PROCESS_ENABLED, armed in server.js), one
//     batch per tick. It catches leftovers and documents queued by hand.
//   - right after the run that queued a document (OCR_RUN_RIGHT_AWAY): the
//     scan when its run ends, the webhook queue after each document. That
//     drain reads every pending document, batch after batch, so a new
//     document does not wait for the scan cron and then for the OCR cron.
//
// One drain at a time. A run that queues documents while a drain or a scan is
// going on is noted (waitingTrigger), and the drain starts once both are over:
// OCR never competes with a scan for the same AI backend.

const cron = require('node-cron');
const config = require('../config/config');
const paperlessService = require('./paperlessService');
const mistralOcrService = require('./mistralOcrService');
const documentModel = require('../models/document');
const dashboardStatsService = require('./dashboardStatsService');
const scanControl = require('./scanControl');

const DEFAULT_INTERVAL = '*/15 * * * *';
const DEFAULT_BATCH_SIZE = 10;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 100;

/**
 * What one drain did.
 *
 * @typedef {object} DrainResult
 * @property {string|null} skipped - why nothing ran: 'already_running',
 *   'disabled', 'paperless_unusable' or 'error'; null when the drain ran
 * @property {number} processed - queue items read (and analysed)
 * @property {number} failed - queue items that failed
 * @property {number} remaining - pending items the drain left for later
 * @property {number} durationMs
 */

class OcrAutoProcessService {
  constructor() {
    /** Whether a drain run is currently in progress. */
    this.running = false;
    /** Keeps the invalid-interval warning to one line per process. */
    this.invalidIntervalLogged = false;
    /**
     * The run that queued documents while a drain or a scan was going on
     * ('scan', 'webhook', 'rescan', 'unlock'), or null. One name is enough
     * however many runs asked: one drain reads every pending document.
     *
     * @type {string|null}
     */
    this.waitingTrigger = null;
  }

  /**
   * Automatic processing requires the global OCR fallback to be on — the
   * global switch always wins over the automation switch.
   */
  isEnabled() {
    return (
      mistralOcrService.isEnabled() &&
      config.mistralOcr?.autoProcessEnabled === 'yes'
    );
  }

  /**
   * Whether a run that queued documents has the queue read as soon as it
   * ends (OCR_RUN_RIGHT_AWAY). Independent of the cron switch above, and like
   * it, nothing while OCR itself is off. Read on every call, so a saved
   * change applies to the next run.
   */
  isRightAwayEnabled() {
    return (
      config.mistralOcr?.runRightAway === 'yes' && mistralOcrService.isEnabled()
    );
  }

  /**
   * Cron expression for the drain job. An invalid pattern would make
   * cron.schedule() throw during startup, so it falls back to the default.
   */
  get interval() {
    const configured = String(
      config.mistralOcr?.autoProcessInterval || ''
    ).trim();

    if (!configured) {
      return DEFAULT_INTERVAL;
    }

    if (cron.validate(configured)) {
      return configured;
    }

    if (!this.invalidIntervalLogged) {
      console.warn(
        `[OCR] Invalid OCR_AUTO_PROCESS_INTERVAL "${configured}". ` +
          `Falling back to "${DEFAULT_INTERVAL}".`
      );
      this.invalidIntervalLogged = true;
    }

    return DEFAULT_INTERVAL;
  }

  /** Maximum queue items handled per run; local vision models are slow. */
  get batchSize() {
    const parsed = Number.parseInt(
      String(config.mistralOcr?.autoProcessBatchSize ?? ''),
      10
    );

    if (!Number.isFinite(parsed)) {
      return DEFAULT_BATCH_SIZE;
    }

    return Math.min(Math.max(parsed, MIN_BATCH_SIZE), MAX_BATCH_SIZE);
  }

  /** Whether AI analysis runs straight after OCR. */
  get autoAnalyze() {
    return config.mistralOcr?.autoAnalyze !== 'no';
  }

  _skip(reason) {
    return {
      skipped: reason,
      processed: 0,
      failed: 0,
      remaining: 0,
      durationMs: 0,
    };
  }

  /**
   * Called when a run that may have queued documents for OCR is over: the
   * scan at the end of every run (services/scanService.js), the webhook queue
   * after each document (services/webhookQueueService.js), which covers the
   * webhook, a rescan by hand and the unlock follow-up. With
   * OCR_RUN_RIGHT_AWAY and OCR on, a run that queued at least one document
   * starts a drain that reads every pending document.
   *
   * A run that ends while a drain or a scan is going on is noted, and the
   * drain starts when that is over: a drain that ends starts the noted one,
   * and so does the scan, which calls this at its end whether or not it
   * queued anything. Several notes make one drain.
   *
   * Never throws: the callers call it from a finally block.
   *
   * @param {string} trigger - the run that ended: 'scan', 'webhook', 'rescan'
   *   or 'unlock'; the drain names it in the log
   * @param {number} queued - documents the run put into the OCR queue
   * @param {object} [logger=console]
   * @returns {Promise<DrainResult>|null} the drain this started, or null
   */
  afterRun(trigger, queued, logger = console) {
    try {
      if (!this.isRightAwayEnabled()) {
        this.waitingTrigger = null;
        return null;
      }
      if (queued > 0 && !this.waitingTrigger) {
        this.waitingTrigger = trigger;
      }
      return this.startWaitingDrain(logger);
    } catch (error) {
      logger.error(
        `[OCR] Could not start reading the OCR queue after a ${trigger} run: ${error.message}`
      );
      return null;
    }
  }

  /**
   * Starts the drain a run asked for, unless a drain or a scan is going on.
   * Then the note stays for whichever of them ends last.
   *
   * @param {object} [logger=console]
   * @returns {Promise<DrainResult>|null} the drain this started, or null
   */
  startWaitingDrain(logger = console) {
    try {
      const trigger = this.waitingTrigger;
      if (!trigger) {
        return null;
      }
      if (!this.isRightAwayEnabled()) {
        this.waitingTrigger = null;
        return null;
      }
      if (this.running) {
        logger.debug(
          `[OCR] A ${trigger} run queued documents during an OCR run. The queue is read again when that run ends.`
        );
        return null;
      }
      if (scanControl.isRunning()) {
        logger.debug(
          `[OCR] A ${trigger} run queued documents during a scan. The queue is read when the scan ends.`
        );
        return null;
      }
      this.waitingTrigger = null;
      return this.drainQueue(logger, { trigger, untilEmpty: true });
    } catch (error) {
      logger.error(
        `[OCR] Could not start reading the OCR queue: ${error.message}`
      );
      return null;
    }
  }

  /**
   * Processes pending queue items: one batch of `batchSize` for the cron, or
   * every pending item for a drain right after a run (`untilEmpty`), batch
   * after batch until no item is left that this drain has not tried. Items
   * queued meanwhile are read too. A failed item is never tried again, and
   * Paperless-ngx is probed before each batch.
   *
   * @param {object} [logger=console]
   * @param {{ trigger?: string, untilEmpty?: boolean }} [options] - trigger
   *   names what started the drain in the log ('schedule' for the cron)
   * @returns {Promise<DrainResult>}
   */
  async drainQueue(
    logger = console,
    { trigger = 'schedule', untilEmpty = false } = {}
  ) {
    if (this.running) {
      logger.debug(
        '[OCR] Auto-processing is already running. Skipping duplicate trigger.'
      );
      return this._skip('already_running');
    }

    const enabled = untilEmpty ? this.isRightAwayEnabled() : this.isEnabled();
    if (!enabled) {
      logger.debug('[OCR] Auto-processing is disabled. Skipping run.');
      return this._skip('disabled');
    }

    this.running = true;
    const startedAtMs = Date.now();
    const autoAnalyze = this.autoAnalyze;
    // Every item this drain handed to processQueueItem(). A failed item has
    // left 'pending' anyway; one that waits for Paperless-ngx to store its
    // unlocked version stays pending and must not come round twice either.
    const attempted = new Set();
    let processed = 0;
    let failed = 0;
    let remaining = 0;
    let batches = 0;

    try {
      for (;;) {
        // Switched off (or OCR switched off) since the drain started: the
        // batch in hand was finished, the rest waits.
        if (batches > 0 && !this.isRightAwayEnabled()) {
          logger.info(
            `[OCR] Auto-processing stopped (trigger=${trigger}): reading the queue right away is switched off.`
          );
          break;
        }

        // Probe before touching a single item: processQueueItem() records
        // every error as a terminal failure, so an unreachable Paperless-ngx
        // would burn the whole queue in one run and lock those documents
        // behind isDocumentFailed() until someone resets them by hand.
        const connection = await paperlessService.checkConnection();
        if (!connection.reachable || !connection.authorized) {
          logger.warn(
            `[OCR] Auto-processing ${batches ? 'stopped' : 'skipped'} (trigger=${trigger}): ` +
              `Paperless-ngx is not usable (${connection.error}). ` +
              'Queued documents stay pending and are retried later.'
          );
          if (batches === 0) {
            return this._skip('paperless_unusable');
          }
          break;
        }

        const pendingItems = (
          await documentModel.getOcrQueue('pending')
        ).filter((item) => !attempted.has(Number(item.document_id)));
        if (pendingItems.length === 0) {
          remaining = 0;
          if (batches === 0) {
            logger.debug('[OCR] Auto-processing found no pending queue items.');
            return {
              skipped: null,
              processed: 0,
              failed: 0,
              remaining: 0,
              durationMs: Date.now() - startedAtMs,
            };
          }
          break;
        }

        const batch = pendingItems.slice(0, this.batchSize);
        logger.info(
          `[OCR] Auto-processing ${batches ? 'continues' : 'started'} (trigger=${trigger}, ` +
            `pending=${pendingItems.length}, batch=${batch.length}, ` +
            `autoAnalyze=${autoAnalyze ? 'yes' : 'no'})`
        );

        for (const item of batch) {
          attempted.add(Number(item.document_id));
          try {
            await mistralOcrService.processQueueItem(item.document_id, {
              autoAnalyze,
            });
            processed += 1;
            // This queue drains outside the scan, so nothing else tells the
            // dashboard that the document counters just moved.
            dashboardStatsService.invalidate();
          } catch (error) {
            // processQueueItem() already moved the item out of 'pending' and
            // recorded the failure, so the next run will not pick it up again.
            // Counting and continuing keeps one bad document from blocking the
            // rest of the batch.
            failed += 1;
            logger.error(
              `[OCR] Auto-processing failed for document ${item.document_id}: ${error.message}`
            );
          }
        }

        batches += 1;
        remaining = Math.max(pendingItems.length - batch.length, 0);
        if (!untilEmpty) {
          break;
        }
      }

      const durationMs = Date.now() - startedAtMs;
      logger.info(
        `[OCR] Auto-processing completed (trigger=${trigger}, processed=${processed}, failed=${failed}, ` +
          `remaining=${remaining}, durationMs=${durationMs})`
      );

      return { skipped: null, processed, failed, remaining, durationMs };
    } catch (error) {
      logger.error(`[OCR] Auto-processing run failed: ${error.message}`);
      logger.debug(error);
      return this._skip('error');
    } finally {
      this.running = false;
      // A run that queued documents while this drain worked asked for one
      // more. Detached: this drain's result does not wait for the next one.
      this.startWaitingDrain(logger);
    }
  }
}

module.exports = new OcrAutoProcessService();
