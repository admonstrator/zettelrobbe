// @ts-check
'use strict';

/**
 * A password-protected PDF that was just unlocked is processed as soon as
 * Paperless-ngx has stored the unlocked version, not with the next scheduled
 * scan.
 *
 * Paperless-ngx answers the password removal before the unlocked file is a
 * version of the document: its consumer reads the new file, extracts the text
 * and creates the version in the background. An analysis right after the
 * unlock would read the old text and download the locked file. So every
 * unlocked document gets one follow-up that asks Paperless-ngx, with growing
 * pauses, whether the document lists a version that was not there before the
 * password was removed. Paperless-ngx creates a version in the same database
 * transaction that stores its file and its text, so a new version id cannot
 * show up before both are there. When it shows up, the follow-up hands the
 * document to the webhook queue as source 'unlock' (see CALLER_PROFILES in
 * services/documentPipeline.js), which analyses one document at a time: many
 * unlocked documents reach the AI backend one after the other.
 *
 * While it waits, the follow-up holds the document's pipeline claim
 * (documentPipeline.claim()), so a scan running meanwhile leaves the
 * document alone instead of reading the old text and sending the locked file
 * to OCR. The claim is given back right before the hand-over; the queue then
 * claims it for the analysis, or a scan that gets there first takes it, and
 * processed_documents keeps the other one from analysing it a second time.
 *
 * Nothing is lost when the wait runs out or the process restarts: the
 * unlocked document has already left the OCR queue and the failed list
 * (pdfUnlockService._release()), so the next scan takes it, as it did before
 * there was a follow-up. With DISABLE_AUTOMATIC_PROCESSING=yes no follow-up
 * starts: the person switched automatic writes off.
 */

/* config/config.js builds most of its getters at runtime, which the type
   checker cannot see; read through a loose view of the same live object. */
/** @type {Record<string, any>} */
const config = require('../config/config.js');
/** @type {Record<string, any>} */
const paperlessService = require('./paperlessService.js');
/** @type {Record<string, any>} */
const mistralOcrService = require('./mistralOcrService');
const documentPipeline = require('./documentPipeline.js');
const webhookQueueService = require('./webhookQueueService.js');
const pdfPasswordService = require('./pdfPasswordService');

/**
 * Pauses between two looks at a document, in order; the last one repeats.
 * Paperless-ngx usually stores a small PDF within seconds, a long scan it
 * reads itself within a minute or two.
 */
const CHECK_INTERVALS_MS = Object.freeze([
  5000, 5000, 10000, 15000, 30000, 60000,
]);

/**
 * How long a follow-up waits for the unlocked version. After that the next
 * scan takes the document, as it would without a follow-up.
 */
const MAX_WAIT_MS = 15 * 60 * 1000;

/**
 * @typedef {object} FollowUp
 * @property {number} documentId
 * @property {number[]|null} versionsBefore - the version ids Paperless-ngx
 *   listed before the password was removed; null when they could not be
 *   read, and the file itself is asked instead
 * @property {boolean} versionStored - the latest file already opens without
 *   a password, nothing to wait for
 * @property {boolean} claimed - this follow-up holds the pipeline claim
 * @property {number} deadline - when the wait runs out
 * @property {number} checks - looks taken so far
 * @property {number} nextCheckAt - when to look next
 */

/**
 * @typedef {object} FollowUpOptions
 * @property {number[]|null} [versionsBefore] - see FollowUp
 * @property {boolean} [versionStored] - see FollowUp
 */

/** @typedef {'scheduled'|'already_waiting'|'automatic_processing_off'} ScheduleResult */

/**
 * Time as the follow-up sees it. Tests replace it, so they never sleep.
 *
 * @typedef {object} Clock
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 */

/** @type {Clock} */
const REAL_CLOCK = Object.freeze({
  now: () => Date.now(),
  sleep: (/** @type {number} */ ms) =>
    new Promise((resolve) => {
      // A pending look never keeps the process alive on its own.
      setTimeout(resolve, ms).unref();
    }),
});

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} error @returns {number|undefined} */
function httpStatusOf(error) {
  return /** @type {{ response?: { status?: number } }} */ (error)?.response
    ?.status;
}

class UnlockFollowUpService {
  constructor() {
    /**
     * One follow-up per document, in the order the documents were unlocked.
     *
     * @type {Map<number, FollowUp>}
     */
    this._pending = new Map();
    /** @type {Promise<void>|null} the loop working on _pending */
    this._running = null;
    /** @type {(() => void)|null} ends the loop's pause early */
    this._wake = null;
    /** when the loop's pause ends by itself */
    this._pausedUntil = 0;
    /** @type {Clock} */
    this.clock = REAL_CLOCK;
    /** @type {{ intervalsMs: ReadonlyArray<number>, maxWaitMs: number }} */
    this.timing = { intervalsMs: CHECK_INTERVALS_MS, maxWaitMs: MAX_WAIT_MS };
  }

  /**
   * DISABLE_AUTOMATIC_PROCESSING=yes, read the way server.js reads it when it
   * decides whether to schedule the scan.
   *
   * @returns {boolean}
   */
  isAutomaticProcessingOff() {
    return config.disableAutomaticProcessing === 'yes';
  }

  /**
   * @param {number} documentId
   * @returns {boolean} a follow-up waits for this document's unlocked version
   */
  isWaiting(documentId) {
    return this._pending.has(Number(documentId));
  }

  /** @returns {number[]} the documents whose follow-up is still waiting */
  waitingDocumentIds() {
    return [...this._pending.keys()];
  }

  /**
   * Starts the follow-up of one unlocked document and returns at once; the
   * waiting and the analysis happen in the background. Call it after the
   * document has left the OCR queue and the failed list.
   *
   * @param {number} documentId
   * @param {FollowUpOptions} [options]
   * @returns {ScheduleResult}
   */
  schedule(documentId, { versionsBefore = null, versionStored = false } = {}) {
    const id = Number(documentId);
    if (this.isAutomaticProcessingOff()) {
      return 'automatic_processing_off';
    }
    if (this._pending.has(id)) {
      return 'already_waiting';
    }
    const now = this.clock.now();
    /** @type {FollowUp} */
    const entry = {
      documentId: id,
      versionsBefore: Array.isArray(versionsBefore)
        ? [...versionsBefore]
        : null,
      versionStored,
      // Claimed now, so a scan in the next minutes leaves the document to
      // this follow-up. Another run that holds it right now (a scan passing
      // by) gives it back within moments; every look tries again.
      claimed: documentPipeline.claim(id),
      deadline: now + this.timing.maxWaitMs,
      checks: 0,
      nextCheckAt: versionStored ? now : now + this._pause(0),
    };
    this._pending.set(id, entry);
    console.info(
      versionStored
        ? `[OCR] Document ${id} opens without a password; it is processed right away`
        : `[OCR] Document ${id} is processed as soon as Paperless-ngx has stored the unlocked version`
    );
    if (!this._running) {
      this._ensureRunning();
    } else if (this._wake && entry.nextCheckAt < this._pausedUntil) {
      // The loop pauses for a later look at another document.
      this._wake();
    }
    return 'scheduled';
  }

  /**
   * Resolves once no follow-up is left. For tests.
   *
   * @returns {Promise<void>}
   */
  async whenIdle() {
    while (this._running) {
      await this._running;
    }
  }

  /** @returns {void} */
  _ensureRunning() {
    if (this._running) return;
    this._running = this._loop()
      .catch((error) => {
        console.error(
          `[OCR] The follow-up after unlocking stopped: ${messageOf(error)}`
        );
      })
      .finally(() => {
        this._running = null;
        // A follow-up scheduled while the loop was ending.
        if (this._pending.size > 0) this._ensureRunning();
      });
  }

  /** @returns {Promise<void>} */
  async _loop() {
    while (this._pending.size > 0) {
      for (const entry of [...this._pending.values()]) {
        if (this._pending.get(entry.documentId) !== entry) continue;
        if (entry.nextCheckAt <= this.clock.now()) {
          await this._check(entry);
        }
      }
      if (this._pending.size === 0) return;
      const next = Math.min(
        ...[...this._pending.values()].map((entry) => entry.nextCheckAt)
      );
      await this._pauseUntil(next);
    }
  }

  /**
   * Waits until `at`, or less when a new follow-up is scheduled meanwhile.
   *
   * @param {number} at
   * @returns {Promise<void>}
   */
  async _pauseUntil(at) {
    const ms = Math.max(0, at - this.clock.now());
    this._pausedUntil = at;
    await new Promise((resolve) => {
      this._wake = () => resolve(undefined);
      this.clock.sleep(ms).then(() => resolve(undefined));
    });
    this._wake = null;
  }

  /**
   * One look at one document: hand it over when its unlocked version is
   * there, give up when the wait has run out, otherwise look again later.
   * Never throws.
   *
   * @param {FollowUp} entry
   * @returns {Promise<void>}
   */
  async _check(entry) {
    const id = entry.documentId;
    entry.checks += 1;
    try {
      if (!entry.claimed) {
        entry.claimed = documentPipeline.claim(id);
      }
      // An OCR run that met the locked file and unlocked it is still on its
      // way out; the document is the follow-up's once it has ended.
      if (
        entry.claimed &&
        !mistralOcrService.isDocumentActivelyProcessing(id) &&
        (entry.versionStored || (await this._versionStored(entry)))
      ) {
        await this._handOver(entry);
        return;
      }
    } catch (error) {
      if (httpStatusOf(error) === 404) {
        this._finish(entry);
        console.info(
          `[OCR] Document ${id} no longer exists in Paperless-ngx; nothing to process after the unlock`
        );
        return;
      }
      console.warn(
        `[OCR] Document ${id}: could not check for the unlocked version (${messageOf(error)}); trying again`
      );
    }

    const now = this.clock.now();
    if (now >= entry.deadline) {
      this._finish(entry);
      console.warn(
        `[OCR] Document ${id}: Paperless-ngx has not stored the unlocked version within ${Math.round(this.timing.maxWaitMs / 60000)} minutes; the next scan processes it`
      );
      return;
    }
    entry.nextCheckAt = now + this._pause(entry.checks);
  }

  /**
   * Whether Paperless-ngx has stored the unlocked version: it lists a version
   * that was not there before the password was removed. Without that list
   * the file is asked instead: the latest version opens without a password.
   * Paperless-ngx serves the latest version, and before the new one exists
   * that is the locked file, so neither can say yes too early.
   *
   * @param {FollowUp} entry
   * @returns {Promise<boolean>}
   */
  async _versionStored(entry) {
    const before = entry.versionsBefore;
    if (before) {
      const ids = await paperlessService.getDocumentVersionIds(
        entry.documentId
      );
      if (Array.isArray(ids)) {
        return ids.some((id) => !before.includes(id));
      }
    }
    const { buffer } = await paperlessService.downloadOriginalFile(
      entry.documentId
    );
    return !(await pdfPasswordService.needsPassword(buffer));
  }

  /**
   * Puts the document into the webhook queue, which analyses it as source
   * 'unlock' with the protections of a new document.
   *
   * @param {FollowUp} entry
   * @returns {Promise<void>}
   */
  async _handOver(entry) {
    const id = entry.documentId;
    if (this.isAutomaticProcessingOff()) {
      this._finish(entry);
      console.info(
        `[OCR] Document ${id}: automatic processing was switched off; it waits for a scan started by hand`
      );
      return;
    }
    // Fetched while the claim is still held; a failure is one more look.
    const document = await paperlessService.getDocument(id);
    if (!document) {
      throw new Error('Paperless-ngx returned no document');
    }
    this._finish(entry);
    webhookQueueService.enqueue(document, {
      applySkipRules: true,
      source: 'unlock',
    });
    console.info(
      `[OCR] Document ${id}: the unlocked version is in Paperless-ngx; processing it now`
    );
    webhookQueueService.processQueue().catch((/** @type {unknown} */ error) => {
      console.error(
        `[ERROR] Processing document ${id} after the unlock failed: ${messageOf(error)}`
      );
    });
  }

  /**
   * Ends a follow-up and gives its claim back.
   *
   * @param {FollowUp} entry
   * @returns {void}
   */
  _finish(entry) {
    if (this._pending.get(entry.documentId) === entry) {
      this._pending.delete(entry.documentId);
    }
    if (entry.claimed) {
      documentPipeline.release(entry.documentId);
      entry.claimed = false;
    }
  }

  /**
   * @param {number} checks - looks taken so far
   * @returns {number} the pause before the next look
   */
  _pause(checks) {
    const intervals = this.timing.intervalsMs;
    return intervals[Math.min(checks, intervals.length - 1)];
  }
}

module.exports = new UnlockFollowUpService();
