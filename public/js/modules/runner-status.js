/**
 * The status line of the Task runner card: what Zettelrobbe is doing right
 * now and on which document ("Classifying document", "Reading with OCR ·
 * page 3 of 7"), how many documents wait for OCR, and when the OCR schedule
 * reads the queue next. Fed by `activity` in /api/processing-status.
 *
 * describeRunner() is pure and tested in tests/test-runner-status.js; the
 * dashboard module copies its strings into the card.
 */

import { formatClockTime, formatCountdown } from './scan-schedule.js';

const ANALYSIS_STEPS = {
  checking: 'Checking document',
  ai: 'Classifying document',
  writeback: 'Writing back to Paperless-ngx',
};

const OCR_STEPS = {
  download: 'Fetching the file for OCR',
  unlock: 'Unlocking the PDF',
  ocr: 'Reading with OCR',
  writeback: 'Saving the OCR text',
  ai: 'Classifying document',
};

function asTime(value) {
  // new Date(null) is 1970, not "no time".
  if (value === null || value === undefined || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * The words for a document's step: "Classifying document", "Reading with
 * OCR · page 3 of 7".
 *
 * @param {'analysis'|'ocr'} lane
 * @param {string} step
 * @param {string|null} [detail] e.g. "3/7" for the page OCR reads
 * @returns {string}
 */
export function describeStep(lane, step, detail = null) {
  const words =
    (lane === 'ocr' ? OCR_STEPS : ANALYSIS_STEPS)[step] ||
    (lane === 'ocr' ? 'Reading with OCR' : 'Processing document');
  if (lane === 'ocr' && step === 'ocr' && detail) {
    const [page, pages] = String(detail).split('/');
    if (page && pages) return `${words} · page ${page} of ${pages}`;
  }
  return words;
}

function firstActive(lane) {
  return lane && Array.isArray(lane.active) && lane.active.length
    ? lane.active[0]
    : null;
}

function titleOf(doc) {
  return String((doc && doc.title) || `Document ${doc && doc.documentId}`);
}

/**
 * Everything the Task runner says, from one /api/processing-status body.
 *
 * - a document in progress: its step as the label, its title as the detail,
 *   its number as the badge; a second one in the other lane is named in the
 *   detail
 * - otherwise: Processing document, Scanning (with where the scan is in its
 *   list), Reading the OCR queue, or System idle
 *
 * @param {object} data /api/processing-status response body
 * @param {{ now?: number, formatDay?: (date: Date) => string }} [options]
 * @returns {{ label: string, detail: string, documentId: number|null, busy: boolean, ocrWaiting: number, nextOcrRun: string|null, counting: boolean }}
 */
export function describeRunner(data, { now = Date.now(), formatDay } = {}) {
  const body = data || {};
  const activity = body.activity || {};
  const analysis = activity.analysis || {};
  const ocr = activity.ocr || {};
  const ocrEnabled = ocr.enabled === true;

  const analysisDoc = firstActive(analysis);
  const ocrDoc = ocrEnabled ? firstActive(ocr) : null;
  const isScanning = Boolean(body.isScanning);
  const ocrRunning = ocrEnabled && Boolean(ocr.running);

  let label;
  let detail;
  let documentId = null;

  if (analysisDoc || ocrDoc) {
    const [lane, doc] = analysisDoc
      ? ['analysis', analysisDoc]
      : ['ocr', ocrDoc];
    label = describeStep(lane, doc.step, doc.detail);
    detail = titleOf(doc);
    documentId = Number(doc.documentId) || null;
    // The webhook can analyse while OCR reads another document.
    if (analysisDoc && ocrDoc) {
      detail += ` · OCR busy with #${ocrDoc.documentId}`;
    }
  } else if (body.currentlyProcessing) {
    label = 'Processing document';
    detail = titleOf(body.currentlyProcessing);
    documentId = Number(body.currentlyProcessing.documentId) || null;
  } else if (isScanning) {
    const scan = analysis.scan;
    label = 'Scanning';
    detail =
      scan && Number(scan.total) > 0
        ? `Checked ${Math.min(scan.checked, scan.total)} of ${scan.total} documents`
        : 'Looking for documents to process';
  } else if (ocrRunning) {
    label = 'Reading the OCR queue';
    detail = 'One document after the other';
  } else {
    label = 'System idle';
    detail = 'Waiting for new documents';
  }

  const nextAt = asTime(ocr.nextRunAt);
  let nextOcrRun = null;
  if (ocrEnabled && nextAt !== null) {
    nextOcrRun = ocrRunning
      ? 'Reading now'
      : `${formatClockTime(nextAt, { now, formatDay })} · ${formatCountdown(nextAt - now)}`;
  }

  return {
    label,
    detail: detail.length > 90 ? `${detail.slice(0, 90)}…` : detail,
    documentId,
    busy: Boolean(
      analysisDoc ||
      ocrDoc ||
      body.currentlyProcessing ||
      isScanning ||
      ocrRunning
    ),
    ocrWaiting: ocrEnabled ? Math.max(0, Number(ocr.waitingCount) || 0) : 0,
    nextOcrRun,
    counting: Boolean(nextOcrRun && !ocrRunning),
  };
}
