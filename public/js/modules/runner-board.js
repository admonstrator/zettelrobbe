/**
 * The Task runner board: per lane (analysis, OCR) the documents that wait,
 * the ones in progress and the last ones done, like the pick-up screen at a
 * counter. Fed by `activity` in /api/processing-status; the dashboard module
 * calls renderBoard() on every poll and every clock tick.
 *
 * describeBoard() is pure and tested in tests/test-runner-board.js; the DOM
 * part only copies its strings into the card.
 */

import { formatClockTime, formatCountdown } from './scan-schedule.js';

/** Waiting tickets shown per lane; the rest is "+n". */
export const WAITING_SHOWN = 4;
/** Ready tickets shown per lane. */
export const READY_SHOWN = 3;

const STEP_WORDS = {
  checking: 'Checking',
  download: 'Downloading',
  unlock: 'Unlocking',
  ocr: 'Reading',
  ai: 'Asking the AI',
  writeback: 'Writing back',
};

function asTime(value) {
  // new Date(null) is 1970, not "no time".
  if (value === null || value === undefined || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * How long a document has been in progress: "0:14", "12:05", "1:02:09".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * The words for a step: "Asking the AI", "Reading page 3/7".
 *
 * @param {string} step
 * @param {string|null} [detail]
 * @returns {string}
 */
export function describeStep(step, detail = null) {
  if (step === 'ocr' && detail) return `Reading page ${detail}`;
  return STEP_WORDS[step] || 'Working';
}

function ticket(doc) {
  const id = Number(doc && doc.documentId);
  return {
    id,
    number: `#${id}`,
    title: String((doc && doc.title) || `Document ${id}`),
  };
}

function waitingColumn(lane) {
  const waiting = Array.isArray(lane.waiting) ? lane.waiting : [];
  const count = Math.max(Number(lane.waitingCount) || 0, waiting.length);
  const shown = waiting.slice(0, WAITING_SHOWN).map(ticket);
  return { tickets: shown, more: Math.max(0, count - shown.length), count };
}

function activeColumn(lane, now) {
  const active = Array.isArray(lane.active) ? lane.active : [];
  return active.map((doc) => {
    const started = asTime(doc.startedAt);
    return {
      ...ticket(doc),
      step: describeStep(doc.step, doc.detail),
      elapsed: started === null ? '' : formatElapsed(now - started),
    };
  });
}

function readyColumn(lane) {
  const ready = Array.isArray(lane.ready) ? lane.ready : [];
  return ready.slice(0, READY_SHOWN).map(ticket);
}

/**
 * Everything the board and the "Next OCR run" line say, from one
 * /api/processing-status body.
 *
 * @param {object} data /api/processing-status response body
 * @param {{ now?: number, formatDay?: (date: Date) => string }} [options]
 */
export function describeBoard(data, { now = Date.now(), formatDay } = {}) {
  const activity = (data && data.activity) || {};
  const analysis = activity.analysis || {};
  const ocr = activity.ocr || {};

  const analysisWaiting = waitingColumn(analysis);
  const scan = analysis.scan;
  let analysisNote = '';
  if (scan && Number(scan.total) > 0) {
    analysisNote = `Scan checks ${Math.min(scan.checked, scan.total)} of ${scan.total}`;
  }

  const ocrEnabled = ocr.enabled === true;
  const ocrWaiting = waitingColumn(ocr);
  const nextAt = asTime(ocr.nextRunAt);
  let ocrNote = '';
  if (ocrWaiting.count > 0 && !(ocr.active && ocr.active.length)) {
    if (ocr.waitingForScan) {
      ocrNote = 'Starts when the scan is done';
    } else if (!ocr.running && nextAt !== null) {
      ocrNote = `Next run ${formatClockTime(nextAt, { now, formatDay })}`;
    } else if (!ocr.running && !ocr.rightAway) {
      ocrNote = 'Waits to be started';
    }
  }

  let nextOcrRun = null;
  if (ocrEnabled && nextAt !== null) {
    nextOcrRun = ocr.running
      ? 'Reading now'
      : `${formatClockTime(nextAt, { now, formatDay })} · ${formatCountdown(nextAt - now)}`;
  }

  const analysisActive = activeColumn(analysis, now);
  const ocrActive = ocrEnabled ? activeColumn(ocr, now) : [];

  return {
    analysis: {
      off: false,
      waiting: analysisWaiting,
      note: analysisNote,
      active: analysisActive,
      ready: readyColumn(analysis),
    },
    ocr: {
      off: !ocrEnabled,
      waiting: ocrWaiting,
      note: ocrNote,
      active: ocrActive,
      ready: ocrEnabled ? readyColumn(ocr) : [],
    },
    nextOcrRun,
    // The timers and the countdown move every second.
    ticking:
      analysisActive.length > 0 ||
      ocrActive.length > 0 ||
      Boolean(nextOcrRun && !ocr.running),
  };
}

/* --- DOM ---------------------------------------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ticketNode(item, tone) {
  const node = el('span', `runner-ticket runner-ticket--${tone}`);
  node.title = item.title;
  node.appendChild(el('strong', 'runner-ticket__no', item.number));
  if (item.step) {
    const meta = item.elapsed ? `${item.step} · ${item.elapsed}` : item.step;
    node.appendChild(el('span', 'runner-ticket__step', meta));
    node.appendChild(el('span', 'runner-ticket__title', item.title));
  }
  return node;
}

function fill(container, nodes) {
  if (!container) return;
  container.replaceChildren(...nodes);
}

function renderLane(laneEl, view) {
  if (!laneEl) return;
  laneEl.classList.toggle('is-off', view.off);

  const waiting = view.waiting.tickets.map((item) =>
    ticketNode(item, 'waiting')
  );
  if (view.waiting.more > 0) {
    waiting.push(el('span', 'runner-lane__more', `+${view.waiting.more}`));
  }
  if (view.note) waiting.push(el('span', 'runner-lane__note', view.note));

  const active = view.active.map((item) => ticketNode(item, 'active'));
  const ready = view.ready.map((item) => ticketNode(item, 'ready'));

  const dash = () => el('span', 'runner-lane__empty', '—');
  if (view.off) {
    fill(laneEl.querySelector('[data-lane-waiting]'), [
      el('span', 'runner-lane__note', 'OCR is off'),
    ]);
    fill(laneEl.querySelector('[data-lane-active]'), []);
    fill(laneEl.querySelector('[data-lane-ready]'), []);
    return;
  }
  fill(
    laneEl.querySelector('[data-lane-waiting]'),
    waiting.length ? waiting : [dash()]
  );
  fill(
    laneEl.querySelector('[data-lane-active]'),
    active.length ? active : [dash()]
  );
  fill(
    laneEl.querySelector('[data-lane-ready]'),
    ready.length ? ready : [dash()]
  );
}

/**
 * Copies a describeBoard() view into the card.
 *
 * @param {ParentNode} root the card (or the document)
 * @param {ReturnType<typeof describeBoard>} view
 */
export function renderBoard(root, view) {
  renderLane(root.querySelector('[data-lane="analysis"]'), view.analysis);
  renderLane(root.querySelector('[data-lane="ocr"]'), view.ocr);

  const row = root.querySelector('#ocrNextRunRow');
  const value = root.querySelector('#ocrNextRun');
  if (row) row.classList.toggle('hidden', !view.nextOcrRun);
  if (value && view.nextOcrRun && value.textContent !== view.nextOcrRun) {
    value.textContent = view.nextOcrRun;
  }
}
