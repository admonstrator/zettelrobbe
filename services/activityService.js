// @ts-check
'use strict';

/**
 * What the two lanes of work are doing right now, for the Task runner card on
 * the dashboard: the analysis lane (scan, webhook queue, manual rescan, all
 * through services/documentPipeline.js) and the OCR lane (every queue item
 * mistralOcrService.processQueueItem() reads).
 *
 * A record only. Nothing reads it to decide anything, it lives in memory and
 * starts empty after a restart, and every method swallows bad input instead of
 * throwing: a mistake here must never stop a document.
 *
 * Exports the singleton; the shapes are below.
 */

/** How many finished documents a lane remembers for its "Ready" column. */
const READY_LIMIT = 5;

/** @typedef {'analysis' | 'ocr'} LaneName */

/**
 * The step a document is in.
 * analysis: checking (permission, text, rules), ai, writeback.
 * ocr: download, unlock, ocr, writeback, ai.
 *
 * @typedef {'checking' | 'download' | 'unlock' | 'ocr' | 'ai' | 'writeback'} StepName
 */

/**
 * @typedef {object} ActiveDocument
 * @property {number} documentId
 * @property {string} title
 * @property {StepName} step
 * @property {string|null} detail - e.g. "3/7" for the page OCR reads
 * @property {string} startedAt - ISO, when the lane took the document
 * @property {string} stepStartedAt - ISO, when the current step began
 */

/**
 * @typedef {object} ReadyDocument
 * @property {number} documentId
 * @property {string} title
 * @property {string} finishedAt - ISO
 */

/**
 * @typedef {object} LaneSnapshot
 * @property {ActiveDocument[]} active - oldest first
 * @property {ReadyDocument[]} ready - newest first
 */

/**
 * @typedef {object} ScanProgress
 * @property {number} checked - documents the running scan has looked at
 * @property {number} total - documents it fetched from Paperless-ngx
 */

const STEPS = new Set([
  'checking',
  'download',
  'unlock',
  'ocr',
  'ai',
  'writeback',
]);

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

class Lane {
  constructor() {
    /** @type {Map<number, ActiveDocument>} */
    this.active = new Map();
    /** @type {ReadyDocument[]} */
    this.ready = [];
  }
}

class ActivityService {
  constructor() {
    /** @type {Record<LaneName, Lane>} */
    this.lanes = { analysis: new Lane(), ocr: new Lane() };
    /** @type {ScanProgress|null} */
    this.scan = null;
    /** For tests and readers. */
    this.READY_LIMIT = READY_LIMIT;
  }

  /**
   * @param {unknown} name
   * @returns {Lane|null}
   */
  lane(name) {
    return name === 'analysis' || name === 'ocr' ? this.lanes[name] : null;
  }

  /**
   * A lane took a document. Taking it again (a second pass of the same run)
   * starts it over.
   *
   * @param {LaneName} laneName
   * @param {{ id?: unknown, documentId?: unknown, title?: unknown }} doc
   * @param {StepName} [step]
   * @returns {void}
   */
  start(laneName, doc, step = 'checking') {
    const lane = this.lane(laneName);
    const id = toId(doc?.documentId ?? doc?.id);
    if (!lane || id === null) return;
    const now = new Date().toISOString();
    lane.active.set(id, {
      documentId: id,
      title:
        typeof doc.title === 'string' && doc.title
          ? doc.title
          : `Document ${id}`,
      step: STEPS.has(step) ? step : 'checking',
      detail: null,
      startedAt: now,
      stepStartedAt: now,
    });
  }

  /**
   * The document moved to another step, or the same step got a new detail
   * (the next OCR page). Ignored for a document the lane does not hold.
   *
   * @param {LaneName} laneName
   * @param {unknown} documentId
   * @param {StepName} step
   * @param {string|null} [detail]
   * @returns {void}
   */
  step(laneName, documentId, step, detail = null) {
    const lane = this.lane(laneName);
    const id = toId(documentId);
    if (!lane || id === null || !STEPS.has(step)) return;
    const entry = lane.active.get(id);
    if (!entry) return;
    if (entry.step !== step) {
      entry.step = step;
      entry.stepStartedAt = new Date().toISOString();
    }
    entry.detail = detail;
  }

  /**
   * The lane let go of the document. Only 'done' puts it into the Ready
   * column; a failure or a document that needed nothing just leaves.
   * Finishing a document the lane does not hold is a no-op, so a caller may
   * finish once with the outcome and once more from its finally.
   *
   * @param {LaneName} laneName
   * @param {unknown} documentId
   * @param {'done' | 'failed' | 'skipped'} outcome
   * @returns {void}
   */
  finish(laneName, documentId, outcome) {
    const lane = this.lane(laneName);
    const id = toId(documentId);
    if (!lane || id === null) return;
    const entry = lane.active.get(id);
    if (!entry) return;
    lane.active.delete(id);
    if (outcome !== 'done') return;
    lane.ready = [
      {
        documentId: id,
        title: entry.title,
        finishedAt: new Date().toISOString(),
      },
      ...lane.ready.filter((item) => item.documentId !== id),
    ].slice(0, READY_LIMIT);
  }

  /**
   * Where the running scan is in its list, or null when no scan runs.
   *
   * @param {number|null} checked
   * @param {number} [total]
   * @returns {void}
   */
  scanProgress(checked, total = 0) {
    if (checked === null || !Number.isFinite(checked)) {
      this.scan = null;
      return;
    }
    this.scan = {
      checked: Math.max(0, Math.floor(checked)),
      total: Math.max(0, Math.floor(Number(total) || 0)),
    };
  }

  /**
   * A copy for the status endpoint.
   *
   * @returns {{ analysis: LaneSnapshot, ocr: LaneSnapshot, scan: ScanProgress|null }}
   */
  snapshot() {
    /** @param {Lane} lane @returns {LaneSnapshot} */
    const copy = (lane) => ({
      active: [...lane.active.values()].map((entry) => ({ ...entry })),
      ready: lane.ready.map((entry) => ({ ...entry })),
    });
    return {
      analysis: copy(this.lanes.analysis),
      ocr: copy(this.lanes.ocr),
      scan: this.scan ? { ...this.scan } : null,
    };
  }

  /** Back to empty, for tests. */
  reset() {
    this.lanes = { analysis: new Lane(), ocr: new Lane() };
    this.scan = null;
  }
}

module.exports = new ActivityService();
