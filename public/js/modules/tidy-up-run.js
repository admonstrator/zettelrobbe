/**
 * Tidy up › the run: its card while it works, the notice when the model
 * fails, and following it on the server.
 *
 * The run is a TidyUpRun (schemas.js). Its headline, step labels, step
 * details, time and cost lines and every failure sentence come from the API;
 * this module only lays them out.
 */

import { escapeHtml as esc } from './text-utils.js';

export const LIVE_STATES = ['running', 'stopping'];
export const END_STATES = ['done', 'stopped', 'failed'];
const POLL_MS = 2000;

const icon = (name, extra = '') =>
  `<svg class="zr-icon${extra}" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;

/* --- the card while it works ------------------------------------------- */

function stepsHtml(steps) {
  const drawn = (Array.isArray(steps) ? steps : []).filter(
    (s) => s.state !== 'skipped'
  );
  return `<ol class="tidy-steps">${drawn
    .map((step, i) => {
      const state = ['done', 'now', 'next'].includes(step.state)
        ? step.state
        : 'next';
      const mark =
        state === 'done'
          ? icon('i-check', ' zr-icon--sm')
          : state === 'now'
            ? String(i + 1)
            : '';
      return `<li class="tidy-step tidy-step--${state}" data-step="${esc(step.key)}" data-state="${state}"${
        state === 'now' ? ' aria-current="step"' : ''
      }>
        <span class="tidy-step__mark" aria-hidden="true">${mark}</span>
        <span class="tidy-step__label">${esc(step.label)}</span>
        <span class="tidy-step__detail zr-sm zr-faint">${esc(step.detail || '')}</span>
      </li>`;
    })
    .join('')}</ol>`;
}

/** The card of screen 2. The meter's width is set by paintMeter(). */
export function runCardHtml(run) {
  const progress = run.progress || {};
  const stopping = run.status === 'stopping';
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  return `<div class="zr-module__body tidy-run__body">
    <div class="tidy-run__head">
      <div class="tidy-run__text">
        <h2 class="tidy-title">${esc(run.headline || '')}</h2>
        <p class="zr-muted">You can leave this page. The run continues on the server and the suggestions wait for you here.</p>
      </div>
      <button type="button" class="zr-btn" data-act="stop"${stopping ? ' disabled' : ''}>
        ${icon('i-stop', ' zr-icon--sm')} Stop and keep what's found
      </button>
    </div>
    ${stepsHtml(run.steps)}
    <div class="zr-meter tidy-meter" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
      <div class="zr-meter__fill" data-meter-fill data-percent="${percent}"></div>
    </div>
    <div class="tidy-meter__text zr-sm zr-muted">
      <span data-eta>${esc(progress.etaText || '')}</span>
      <span data-cost>${progress.costText ? `Cost so far: ${esc(progress.costText)}` : ''}</span>
    </div>
  </div>`;
}

export function paintMeter(root) {
  root.querySelectorAll('[data-meter-fill]').forEach((fill) => {
    fill.style.width = `${Number(fill.dataset.percent) || 0}%`;
  });
}

/* --- the failure notice ------------------------------------------------- */

const TONES = {
  unreadable: 'warn',
  thinking: 'warn',
  budget: 'info',
  unreachable: 'danger',
  rejected: 'danger',
  paperless: 'danger',
  unknown: 'danger',
  stopped: 'muted',
};
const ICONS = {
  warn: 'i-alert',
  info: 'i-info',
  danger: 'i-alert-circle',
  muted: 'i-stop',
};

/** Where a notice's settings link goes. */
export function settingsHref(kind) {
  return kind === 'paperless' ? '/settings#connection' : '/settings#duplicates';
}

/** One TidyUpFailure as a notice card (screen 4). */
export function noticeHtml(failure, index = 0) {
  const kind = TONES[failure.kind] ? failure.kind : 'unknown';
  const tone = TONES[kind];
  const actions = Array.isArray(failure.actions) ? failure.actions : [];
  const buttons = actions
    .map(
      (a, i) =>
        `<button type="button" class="zr-btn${i === 0 ? ' zr-btn--primary' : ''}" data-act="failure-action" data-key="${esc(
          a.key
        )}">${esc(a.label)}</button>`
    )
    .join('');
  const hint = failure.settingsHint
    ? `<a class="zr-link tidy-notice__hint" href="${settingsHref(kind)}">${esc(failure.settingsHint)}</a>`
    : '';
  const technical = failure.technical
    ? `<details class="tidy-details tidy-notice__details">
        <summary>Details</summary>
        <pre class="tidy-notice__technical">${esc(failure.technical)}</pre>
      </details>`
    : '';
  return `<section class="tidy-notice tidy-notice--${tone}" data-failure-kind="${esc(kind)}" data-notice="${index}" role="alert">
    <span class="tidy-notice__icon">${icon(ICONS[tone])}</span>
    <div class="tidy-notice__main">
      <h3 class="tidy-notice__title">${esc(failure.title || '')}</h3>
      <p class="tidy-notice__body">${esc(failure.body || '')}</p>
      ${buttons || hint ? `<div class="tidy-actions">${buttons}${hint}</div>` : ''}
    </div>
    ${technical}
  </section>`;
}

/* --- following a run ---------------------------------------------------- */

/**
 * Follows a run until it ends: the event stream first, and polling
 * GET /api/tidy-up/runs/:id every two seconds when the stream fails (some
 * proxies close a stream they do not understand).
 *
 * @param {string} id
 * @param {{onSnapshot: (run: object) => void, onEnd: (run: object) => void, onLost: (error: Error) => void, getJson: (url: string) => Promise<object>}} handlers
 * @returns {() => void} stops following
 */
export function follow(id, { onSnapshot, onEnd, onLost, getJson }) {
  const base = `/api/tidy-up/runs/${encodeURIComponent(id)}`;
  let source = null;
  let timer = null;
  let over = false;

  const finish = () => {
    over = true;
    if (source) source.close();
    source = null;
    if (timer) window.clearInterval(timer);
    timer = null;
  };

  const take = (run) => {
    if (over || !run) return;
    if (END_STATES.includes(run.status)) {
      finish();
      onEnd(run);
    } else {
      onSnapshot(run);
    }
  };

  const pollOnce = async () => {
    if (over) return;
    try {
      const payload = await getJson(base);
      take(payload.data);
    } catch (error) {
      finish();
      onLost(error);
    }
  };

  const startPolling = () => {
    if (over || timer) return;
    timer = window.setInterval(pollOnce, POLL_MS);
    pollOnce();
  };

  if (typeof window.EventSource === 'function') {
    source = new EventSource(`${base}/events`);
    source.onmessage = (message) => {
      let run;
      try {
        run = JSON.parse(message.data);
      } catch {
        return;
      }
      take(run);
    };
    source.onerror = () => {
      if (over) return;
      source.close();
      source = null;
      startPolling();
    };
  } else {
    startPolling();
  }
  return finish;
}
