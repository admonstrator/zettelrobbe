// @ts-check
'use strict';

/**
 * Unlocking password-protected PDFs that OCR could not read.
 *
 * Zettelrobbe never decrypts a file itself. It finds the password that opens
 * the PDF (pdfPasswordService, locally, so a wrong guess costs Paperless-ngx
 * nothing) and hands only that one to Paperless-ngx, which decrypts the file
 * and stores it as a new version of the same document (3.0 and later). The
 * document keeps its ID and metadata; Paperless-ngx reads the text of the new
 * version itself.
 *
 * Afterwards the document leaves the OCR queue and the failed list and is
 * processed like a new document as soon as Paperless-ngx has stored the
 * unlocked version (services/unlockFollowUpService.js): enough text from
 * Paperless-ngx means AI analysis, too little means the OCR queue again, this
 * time with a file that opens. When that does not happen (the wait runs out,
 * the process restarts, automatic processing is off), the next scan takes
 * the document, which nothing holds back any more.
 */

/* config/config.js builds most of its getters at runtime, which the type
   checker cannot see; read through a loose view of the same live object. */
/** @type {Record<string, any>} */
const config = require('../config/config.js');
/** @type {Record<string, any>} */
const documentModel = require('../models/document.js');
/** @type {Record<string, any>} */
const paperlessService = require('./paperlessService.js');
const pdfPasswordService = require('./pdfPasswordService');
const { parsePasswordList } = require('./pdfPasswordService');

/**
 * How long a document counts as just unlocked. Paperless-ngx consumes the
 * unlocked file in the background; an OCR run that finds the old, encrypted
 * file within this window waits instead of unlocking it a second time.
 */
const RECENT_UNLOCK_MS = 30 * 60 * 1000;

/**
 * What the person is told after a successful unlock, by what happens next.
 */
const NEXT_STEP = Object.freeze({
  unlocked:
    'Unlocked. The document is analysed as soon as Paperless-ngx has stored the unlocked version.',
  unlockedManual:
    'Unlocked. Paperless-ngx keeps the unlocked file as a new version. Automatic processing is off, so the document waits for a scan you start by hand.',
  notLocked:
    'This document does not need a password (any more). It is analysed right away.',
  notLockedManual:
    'This document does not need a password (any more). Automatic processing is off, so it waits for a scan you start by hand.',
  stillStoring:
    'Paperless-ngx is still storing the unlocked version of this document. It is analysed as soon as that version is there.',
});

/**
 * The follow-up of an unlock. Required when needed rather than at the top:
 * it reaches the OCR service through the pipeline, and the OCR service
 * requires this module for its own runs.
 *
 * @returns {typeof import('./unlockFollowUpService.js')}
 */
function followUps() {
  return require('./unlockFollowUpService.js');
}

/**
 * @typedef {'unlocked'|'not_locked'|'no_match'|'no_passwords'|'unsupported'|'rejected'|'forbidden'|'busy'|'failed'} UnlockOutcome
 */

/**
 * @typedef {object} UnlockResult
 * @property {number} documentId
 * @property {UnlockOutcome} outcome
 * @property {string} message one sentence for the person who asked
 */

/**
 * @typedef {object} UnlockOptions
 * @property {string} [password] the one password to try; without it the stored list is tried
 * @property {Buffer} [file] the file as an OCR run already downloaded it
 * @property {boolean} [fromOcrRun] the caller is the OCR run of this document
 */

class PdfUnlockService {
  constructor() {
    /** @type {Map<number, number>} document id -> time of the unlock */
    this._recentlyUnlocked = new Map();
    /** @type {Set<number>} */
    this._busy = new Set();
  }

  /** @returns {string[]} */
  storedPasswords() {
    return parsePasswordList(config.mistralOcr.pdfPasswords);
  }

  /**
   * @param {number} documentId
   * @returns {boolean}
   */
  wasRecentlyUnlocked(documentId) {
    const now = Date.now();
    for (const [id, at] of this._recentlyUnlocked) {
      if (now - at > RECENT_UNLOCK_MS) this._recentlyUnlocked.delete(id);
    }
    return this._recentlyUnlocked.has(documentId);
  }

  /**
   * What the OCR page needs to offer the unlock.
   *
   * @returns {Promise<{ supported: boolean, paperlessVersion: string|null, storedPasswords: number, locked: number }>}
   */
  async getStatus() {
    const [support, locked] = await Promise.all([
      paperlessService.getPasswordRemovalSupport(),
      documentModel.getPasswordProtectedOcrItems(),
    ]);
    return {
      supported: support.supported,
      paperlessVersion: support.version,
      storedPasswords: this.storedPasswords().length,
      locked: locked.length,
    };
  }

  /**
   * Takes the document out of the OCR queue and off the failed list, so the
   * follow-up, or else the next scan, processes it from what Paperless-ngx
   * now holds.
   *
   * The queue history goes too: no OCR provider ever read the locked file,
   * so OCR before the first analysis (OCR_BEFORE_AI) may still send the
   * unlocked one, once.
   *
   * @param {number} documentId
   * @returns {Promise<void>}
   */
  async _release(documentId) {
    await documentModel.removeFromOcrQueue(documentId);
    await documentModel.forgetOcrQueueHistory(documentId);
    await documentModel.resetFailedDocument(documentId);
  }

  /**
   * The version ids Paperless-ngx lists for the document before its password
   * is removed, for the follow-up to recognise the new one by. Null when they
   * cannot be read; the follow-up then asks the file itself.
   *
   * @param {number} documentId
   * @returns {Promise<number[]|null>}
   */
  async _versionsBefore(documentId) {
    try {
      return await paperlessService.getDocumentVersionIds(documentId);
    } catch (error) {
      console.warn(
        `[OCR] Could not read the versions of document ${documentId} (${error instanceof Error ? error.message : String(error)}); the follow-up checks the file instead`
      );
      return null;
    }
  }

  /**
   * Unlocks one document with the given password or the stored list.
   * Never throws for a document that simply stays locked; the outcome says
   * what happened.
   *
   * A successful unlock starts the follow-up that processes the document as
   * soon as Paperless-ngx has stored the unlocked version, unless automatic
   * processing is off. The answer does not wait for it.
   *
   * @param {number} documentId
   * @param {UnlockOptions} [options]
   * @returns {Promise<UnlockResult>}
   */
  async unlock(documentId, options = {}) {
    /**
     * @param {UnlockOutcome} outcome
     * @param {string} message
     * @returns {UnlockResult}
     */
    const result = (outcome, message) => ({ documentId, outcome, message });

    if (this._busy.has(documentId)) {
      return result('busy', 'This document is being unlocked right now.');
    }
    // Unlocked moments ago: the file Paperless-ngx serves is still the
    // locked one, and a second removal would only add a second version.
    if (followUps().isWaiting(documentId)) {
      return result('busy', NEXT_STEP.stillStoring);
    }
    if (!options.fromOcrRun) {
      // Required here rather than at the top: the OCR service requires this
      // module for its own runs.
      const mistralOcrService = require('./mistralOcrService');
      if (mistralOcrService.isDocumentActivelyProcessing(documentId)) {
        return result('busy', 'OCR is working on this document right now.');
      }
    }

    const typed = typeof options.password === 'string' ? options.password : '';
    const candidates = typed ? [typed] : this.storedPasswords();
    if (!candidates.length) {
      return result(
        'no_passwords',
        'No password was given and no passwords are stored in Settings.'
      );
    }

    this._busy.add(documentId);
    try {
      const support = await paperlessService.getPasswordRemovalSupport();
      if (!support.supported) {
        return result(
          'unsupported',
          `Paperless-ngx ${support.version} cannot remove passwords; that needs version 3.0 or later.`
        );
      }

      const file =
        options.file ||
        (await paperlessService.downloadOriginalFile(documentId)).buffer;

      if (!(await pdfPasswordService.needsPassword(file))) {
        await this._release(documentId);
        console.log(
          `[OCR] Document ${documentId} no longer needs a password; released for processing`
        );
        // The file Paperless-ngx serves is its latest version, and it opens:
        // nothing to wait for.
        const followUp = followUps().schedule(documentId, {
          versionStored: true,
        });
        return result(
          'not_locked',
          followUp === 'automatic_processing_off'
            ? NEXT_STEP.notLockedManual
            : NEXT_STEP.notLocked
        );
      }

      const password = await pdfPasswordService.findPassword(file, candidates);
      if (password === null) {
        return result(
          'no_match',
          typed
            ? 'This password does not open the PDF.'
            : `None of the ${candidates.length} stored password(s) opens the PDF.`
        );
      }

      const versionsBefore = followUps().isAutomaticProcessingOff()
        ? null
        : await this._versionsBefore(documentId);

      try {
        await paperlessService.removePassword(documentId, password);
      } catch (error) {
        const err = /** @type {Error & { code?: string }} */ (error);
        const outcome =
          err.code === 'unsupported' ||
          err.code === 'forbidden' ||
          err.code === 'rejected'
            ? err.code
            : 'failed';
        console.error(
          `[OCR] Unlocking document ${documentId} failed: ${err.message}`
        );
        return result(outcome, err.message);
      }

      this._recentlyUnlocked.set(documentId, Date.now());
      await this._release(documentId);
      console.log(
        `[OCR] Document ${documentId} unlocked in Paperless-ngx (${typed ? 'typed password' : 'stored password'})`
      );
      // Straight after the release, with nothing sent over the network in
      // between: the follow-up claims the document before a running scan
      // can reach it with the old text.
      const followUp = followUps().schedule(documentId, { versionsBefore });
      return result(
        'unlocked',
        followUp === 'automatic_processing_off'
          ? NEXT_STEP.unlockedManual
          : NEXT_STEP.unlocked
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[OCR] Unlocking document ${documentId} failed: ${message}`
      );
      return result('failed', `Unlocking failed: ${message}`);
    } finally {
      this._busy.delete(documentId);
    }
  }

  /**
   * Tries the stored passwords on every OCR queue item marked as password
   * protected, one after the other. Each unlocked document gets its own
   * follow-up; the webhook queue analyses them one at a time.
   *
   * @param {(item: { title: string } & UnlockResult, index: number, total: number) => void} [onItem]
   * @returns {Promise<{ total: number, unlocked: number, stillLocked: number }>}
   */
  async unlockAllLocked(onItem) {
    const items = await documentModel.getPasswordProtectedOcrItems();
    let unlocked = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const outcome = await this.unlock(Number(item.document_id));
      if (outcome.outcome === 'unlocked' || outcome.outcome === 'not_locked') {
        unlocked += 1;
      }
      if (onItem)
        onItem({ ...outcome, title: item.title }, index, items.length);
    }
    return {
      total: items.length,
      unlocked,
      stillLocked: items.length - unlocked,
    };
  }
}

module.exports = new PdfUnlockService();
