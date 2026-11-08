/**
 * Tidy up › the page (views/tidy-up.ejs, data-module="tidy-up").
 *
 * One page in four states:
 *   1. start    — the server-rendered card with the options and Find suggestions
 *   2. running  — the run card, following the run, and the suggestions so far
 *   3. result   — the counts, the filter chips and the suggestion cards
 *   4. failure  — the run's failure notice in place of the run card; notices
 *                 for single requests that failed stand above the suggestions
 *
 * The API is routes/tidyUp.js (shapes in schemas.js, TidyUp*). The page keeps
 * the run, the suggestions and what the person typed into a card in `state`
 * and redraws the list from it; a decision re-renders from the list the API
 * returns.
 *
 * While a decide or undo writes to Paperless-ngx (started here, in another
 * tab, or seen in a 409) a status strip says what is being done (the
 * `activity` of GET /api/tidy-up/suggestions, its sentence from the API),
 * every button that would write is aria-disabled, and the card in flight
 * shows a spinner in place of its buttons. The page polls the suggestions
 * once a second until the activity is over, then redraws the list.
 */

import { escapeHtml as esc } from './text-utils.js';
import {
  cardHtml,
  deleteGroupHtml,
  filtersHtml,
  lineHtml,
  passes,
  summaryHtml,
} from './tidy-up-cards.js';
import {
  END_STATES,
  LIVE_STATES,
  follow,
  noticeHtml,
  paintMeter,
  runCardHtml,
} from './tidy-up-run.js';

/** How often the page asks what is being written while something is. */
const ACTIVITY_POLL_MS = 1000;
/** How long a refusal by another request holds the buttons. */
const EXTERNAL_HOLD_MS = 3000;
/**
 * Said between a click and the server's first word about it. The sentences
 * after that come from the API (tidyUpWording.activitySentence).
 */
const WRITING_PLACEHOLDER = 'Writing to Paperless-ngx…';
/** Buttons that write (or start something) and wait while anything writes. */
const WRITING_ACTS = new Set([
  'accept',
  'decline',
  'later',
  'retry',
  'undo',
  'swap',
  'delete-all',
  'pick',
  'delete-ticked',
  'accept-sure',
  'undo-batch',
  'run-again',
  'recent-undo',
]);

const STATUS_WORDS = {
  done: 'Done',
  partial: 'Partly done',
  failed: 'Failed',
  undone: 'Undone',
};

/* --- requests ------------------------------------------------------------ */

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 204)
    return { success: true, data: null, status: 204 };
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!payload) {
    throw new Error(`The server answered ${response.status} without a body`);
  }
  if (!response.ok || payload.success === false) {
    const error = new Error(
      payload.error || payload.message || 'Request failed'
    );
    error.status = response.status;
    error.data = payload.data ?? null;
    throw error;
  }
  payload.status = response.status;
  return payload;
}

const getJson = (url) => requestJson(url);
const sendJson = (method, url, body) =>
  requestJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/* --- small helpers ------------------------------------------------------- */

const number = (n) => Number(n || 0).toLocaleString('en-US');

function whenText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const today = new Date();
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );
  const diff = Math.floor(
    (startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate())) /
      86400000
  );
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`;
}

function topicList(text) {
  return String(text || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/* --- the page ------------------------------------------------------------ */

export default function tidyUp(root, ctx = {}) {
  const toast =
    ctx.toast ||
    ((message, opts) => window.__zrToast && window.__zrToast(message, opts));

  const el = {
    start: root.querySelector('[data-tidy-start]'),
    find: root.querySelector('[data-tidy-find]'),
    estimate: root.querySelector('[data-tidy-estimate]'),
    run: root.querySelector('[data-tidy-run]'),
    notices: root.querySelector('[data-tidy-notices]'),
    results: root.querySelector('[data-tidy-results]'),
    summary: root.querySelector('[data-tidy-summary]'),
    sofar: root.querySelector('[data-tidy-sofar]'),
    banner: root.querySelector('[data-tidy-banner]'),
    filters: root.querySelector('[data-tidy-filters]'),
    list: root.querySelector('[data-tidy-list]'),
    recent: root.querySelector('[data-tidy-recent-list]'),
    forget: root.querySelector('[data-tidy-forget]'),
    hiddenToggle: root.querySelector('[data-tidy-hidden-toggle]'),
    hidden: root.querySelector('[data-tidy-hidden]'),
    activity: root.querySelector('[data-tidy-activity]'),
  };
  const modelAvailable = root.dataset.modelAvailable === 'yes';

  const state = {
    run: null,
    suggestions: [],
    summary: null,
    filter: 'all',
    showEarlier: false,
    /** ids decided while this page was open: they stay in the list as lines */
    decidedHere: new Set(),
    /** batchId → number of suggestions it accepted */
    batchSizes: new Map(),
    /** suggestion id → batchId of the accept that did it */
    batchOf: new Map(),
    banner: null, // { batchId, count }
    edits: {},
    openDetails: new Set(),
    picking: new Set(),
    ticked: new Set(),
    vocabulary: null,
    documentTypes: null,
    vocabularyAsked: false,
    lastOptions: null,
    stopFollowing: null,
    busy: false,
    /** TidyUpActivity from the server while a decide or undo writes */
    activity: null,
    /** this page's own decide or undo request in flight: { ids } */
    writing: null,
    /** a refusal because another request writes: { sentence } */
    external: null,
  };

  /* --- options ----------------------------------------------------------- */

  function readOptions() {
    const box = (key) => root.querySelector(`[data-tidy-option="${key}"]`);
    return {
      askModel: Boolean(box('askModel')?.checked) && modelAvailable,
      suggestSplits: Boolean(box('suggestSplits')?.checked) && modelAvailable,
      kind: 'all',
    };
  }

  function writeOptions(options) {
    const box = (key) => root.querySelector(`[data-tidy-option="${key}"]`);
    if (box('askModel')) box('askModel').checked = options.askModel !== false;
    if (box('suggestSplits'))
      box('suggestSplits').checked = options.suggestSplits === true;
  }

  /* --- screens ----------------------------------------------------------- */

  function show(node, visible) {
    if (node) node.classList.toggle('hidden', !visible);
  }

  function showStart() {
    if (state.stopFollowing) state.stopFollowing();
    state.stopFollowing = null;
    show(el.start, true);
    show(el.run, false);
    show(el.notices, false);
    show(el.results, false);
    if (state.lastOptions) writeOptions(state.lastOptions);
  }

  /** Screen 2, 3 or 4, from the run as it stands. */
  function renderRun() {
    const run = state.run;
    if (!run) {
      showStart();
      return;
    }
    show(el.start, false);
    const live = LIVE_STATES.includes(run.status);
    const notices = [];
    if (run.failure && run.failure.kind !== 'stopped') {
      el.run.innerHTML = noticeHtml(run.failure, 0);
      el.run.classList.add('tidy-run--failure');
      show(el.run, true);
    } else if (live) {
      el.run.classList.remove('tidy-run--failure');
      el.run.innerHTML = runCardHtml(run);
      paintMeter(el.run);
      show(el.run, true);
    } else {
      el.run.innerHTML = '';
      show(el.run, false);
    }
    (run.partialFailures || []).forEach((f, i) =>
      notices.push(noticeHtml(f, i + 1))
    );
    el.notices.innerHTML = notices.join('');
    show(el.notices, notices.length > 0);
    renderResults();
  }

  /* --- the list ---------------------------------------------------------- */

  function earlierList() {
    return state.suggestions.filter(
      (s) =>
        ['done', 'declined', 'later'].includes(s.status) &&
        !state.decidedHere.has(s.id)
    );
  }

  function splitCount() {
    return state.suggestions.filter(
      (s) => s.kind === 'split' && s.status === 'open'
    ).length;
  }

  function ensureVocabulary() {
    if (state.vocabularyAsked) return;
    if (!state.suggestions.some((s) => s.kind === 'split')) return;
    state.vocabularyAsked = true;
    loadVocabulary().then(renderResults);
  }

  async function loadVocabulary() {
    const [vocab, types] = await Promise.allSettled([
      getJson('/api/simplify/vocabulary'),
      getJson('/api/simplify/document-types'),
    ]);
    state.vocabulary =
      vocab.status === 'fulfilled' && vocab.value.data
        ? {
            types: vocab.value.data.types || [],
            topics: vocab.value.data.topics || [],
          }
        : { types: [], topics: [] };
    state.documentTypes =
      types.status === 'fulfilled' && types.value.data
        ? types.value.data.types || []
        : [];
  }

  function renderResults() {
    drawResults();
    renderActivity();
  }

  function drawResults() {
    const run = state.run;
    const live = run && LIVE_STATES.includes(run.status);
    const list = state.suggestions;
    const hasAny = list.length > 0;
    show(el.results, Boolean(run) && (hasAny || !live));
    if (!run) return;
    ensureVocabulary();

    // The top: the counts once the run has ended, a line while it works.
    if (live) {
      show(el.summary, false);
      const open = list.filter((s) => s.status === 'open').length;
      el.sofar.innerHTML = `<h2 class="tidy-subtitle">Suggestions so far · ${number(open)}</h2>
        <p class="zr-sm zr-muted">You can start deciding while the model works.</p>`;
      show(el.sofar, hasAny);
      show(el.filters, false);
    } else {
      show(el.sofar, false);
      el.summary.innerHTML = summaryHtml(state.summary, run);
      show(el.summary, true);
      const earlier = earlierList().length;
      el.filters.innerHTML = filtersHtml(
        state.summary,
        state.filter,
        earlier,
        state.showEarlier
      );
      show(el.filters, Number(state.summary?.open) > 0 || earlier > 0);
    }

    // The banner of the last batch.
    if (state.banner) {
      el.banner.innerHTML = `<div class="zr-alert zr-alert--ok tidy-banner__alert">
        <svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#i-check-circle"/></svg>
        <span class="zr-grow">${number(state.banner.count)} ${state.banner.count === 1 ? 'change' : 'changes'} made</span>
        <button type="button" class="zr-btn" data-act="undo-batch">Undo all</button>
      </div>`;
      show(el.banner, true);
    } else {
      el.banner.innerHTML = '';
      show(el.banner, false);
    }

    const filter = live ? 'all' : state.filter;
    const view = {
      edits: state.edits,
      openDetails: state.openDetails,
      picking: state.picking,
      ticked: state.ticked,
      vocabulary: state.vocabulary,
      documentTypes: state.documentTypes,
      splitCount: splitCount(),
    };

    // Single-name delete suggestions of one kind are one card.
    const deleteGroups = new Map();
    for (const s of list) {
      if (
        s.kind === 'delete' &&
        s.status === 'open' &&
        (s.from || []).length === 1
      ) {
        const key = s.entityKind;
        if (!deleteGroups.has(key)) deleteGroups.set(key, []);
        deleteGroups.get(key).push(s);
      }
    }

    const out = [];
    const drawnGroups = new Set();
    for (const s of list) {
      if (!passes(s, filter)) continue;
      if (s.status === 'open') {
        const group =
          s.kind === 'delete' ? deleteGroups.get(s.entityKind) : null;
        if (group && group.length > 1) {
          if (drawnGroups.has(s.entityKind)) continue;
          drawnGroups.add(s.entityKind);
          out.push(deleteGroupHtml(s.entityKind, group, view));
          continue;
        }
        out.push(cardHtml(s, view));
      } else if (s.status === 'failed' || state.decidedHere.has(s.id)) {
        out.push(
          lineHtml({
            ...s,
            batchId: s.batchId || state.batchOf.get(s.id) || null,
          })
        );
      } else if (state.showEarlier) {
        out.push(lineHtml(s));
      }
    }
    if (!out.length && !live) {
      out.push(
        `<p class="zr-sm zr-muted tidy-list__empty">${
          Number(state.summary?.total)
            ? 'Nothing left to decide here.'
            : 'Nothing to tidy up: every name looks fine.'
        }</p>`
      );
    }
    el.list.innerHTML = out.join('');
  }

  /* --- loading ----------------------------------------------------------- */

  async function loadSuggestions() {
    try {
      const payload = await getJson('/api/tidy-up/suggestions');
      const data = payload.data || {};
      state.suggestions = Array.isArray(data.suggestions)
        ? data.suggestions
        : [];
      state.summary = data.summary || null;
      // Another tab (or the API) is writing: show it and wait for its end.
      if (data.activity && !state.writing) {
        state.activity = data.activity;
        startPolling();
      }
    } catch (error) {
      toast(error.message, { tone: 'danger' });
    }
  }

  /* --- what is being written right now ------------------------------------ */

  function busy() {
    return Boolean(state.activity || state.writing || state.external);
  }

  function activitySentence() {
    if (state.activity && state.activity.sentence)
      return state.activity.sentence;
    if (state.writing) return WRITING_PLACEHOLDER;
    if (state.external) return state.external.sentence;
    return '';
  }

  /** The suggestions in flight: what the server names, else what was sent. */
  function inFlightIds() {
    const current = state.activity && state.activity.current;
    if (current && Array.isArray(current.ids) && current.ids.length)
      return current.ids;
    if (current && current.id) return [current.id];
    if (state.writing) return state.writing.ids;
    return [];
  }

  const stripHtml = (sentence) =>
    `<span class="zr-spinner" aria-hidden="true"></span><span class="tidy-activity__text">${esc(sentence)}</span>`;

  /** The strip, the run card's copy of it, and every button that writes. */
  function renderActivity() {
    const on = busy();
    const sentence = on ? activitySentence() : '';
    root.toggleAttribute('data-busy', on);
    if (el.activity) {
      // Rewritten only when the sentence changes, so a screen reader hears
      // each step once.
      if (el.activity.dataset.sentence !== sentence) {
        el.activity.dataset.sentence = sentence;
        el.activity.innerHTML = on ? stripHtml(sentence) : '';
      }
      show(el.activity, on);
    }
    if (el.run) {
      const body = el.run.querySelector('.tidy-run__body');
      let copy = el.run.querySelector('[data-tidy-run-activity]');
      if (on && body) {
        if (!copy) {
          copy = document.createElement('div');
          copy.className = 'tidy-activity tidy-activity--run';
          copy.dataset.tidyRunActivity = '';
          // The strip above the list is the one that is announced.
          copy.setAttribute('aria-hidden', 'true');
          body.appendChild(copy);
        }
        if (copy.dataset.sentence !== sentence) {
          copy.dataset.sentence = sentence;
          copy.innerHTML = stripHtml(sentence);
        }
      } else if (copy) {
        copy.remove();
      }
    }
    applyBusy(on);
  }

  function applyBusy(on = busy()) {
    root.querySelectorAll('button[data-act]').forEach((button) => {
      if (!WRITING_ACTS.has(button.dataset.act)) return;
      if (on) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    });
    if (el.find) {
      if (on) el.find.setAttribute('aria-disabled', 'true');
      else el.find.removeAttribute('aria-disabled');
    }
    const flying = new Set(on ? inFlightIds() : []);
    root
      .querySelectorAll('.tidy-list .tidy-card, .tidy-list .tidy-line')
      .forEach((node) => {
        const own = node.dataset.ids
          ? node.dataset.ids.split(' ')
          : [node.dataset.id];
        const inFlight = own.some((id) => flying.has(id));
        node.classList.toggle('tidy-inflight', inFlight);
        const mark = node.querySelector('.tidy-inflight__mark');
        if (inFlight && !mark) {
          const holder =
            [...node.querySelectorAll('.tidy-actions')].pop() || node;
          holder.insertAdjacentHTML(
            'beforeend',
            '<span class="tidy-inflight__mark" aria-hidden="true"><span class="zr-spinner"></span></span>'
          );
        } else if (!inFlight && mark) {
          mark.remove();
        }
      });
  }

  let pollTimer = null;
  let pollGeneration = 0;
  let polling = false;

  function startPolling({ soon = false } = {}) {
    if (!pollTimer) {
      pollTimer = window.setInterval(pollActivity, ACTIVITY_POLL_MS);
    }
    if (soon) window.setTimeout(pollActivity, 250);
  }

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
    pollGeneration += 1;
  }

  /** One look at the server: the activity, or its end and the list after it. */
  async function pollActivity() {
    if (polling || !pollTimer) return;
    polling = true;
    const generation = pollGeneration;
    try {
      const payload = await getJson('/api/tidy-up/suggestions');
      if (generation !== pollGeneration) return;
      const data = payload.data || {};
      if (data.activity) {
        state.activity = data.activity;
        renderActivity();
        return;
      }
      // This page's own request answers with the list itself.
      if (state.writing) return;
      stopPolling();
      state.activity = null;
      takeList(data);
      renderResults();
      loadRecent();
    } catch {
      // The next tick asks again.
    } finally {
      polling = false;
    }
  }

  /** An activity from the server outside a request of this page (SSE). */
  function seeActivity(activity) {
    if (activity) {
      state.activity = activity;
      if (!state.writing) startPolling();
    } else if (state.activity && !state.writing) {
      startPolling({ soon: true });
    }
  }

  /** A 409: show what is going on instead of a toast. */
  function refused(error) {
    const activity = error.data && error.data.activity;
    if (activity) {
      state.activity = activity;
      startPolling();
    } else {
      state.external = { sentence: error.message };
      window.setTimeout(() => {
        state.external = null;
        renderActivity();
      }, EXTERNAL_HOLD_MS);
    }
    renderActivity();
  }

  /**
   * Runs one writing request with the strip up and the buttons held. A 409
   * becomes the strip of what holds the server; `{ ok: false }` then.
   */
  async function withWriting(ids, work, { strip = true } = {}) {
    if (strip) {
      state.writing = { ids: [...ids] };
      startPolling({ soon: true });
      renderActivity();
    }
    let refusal = null;
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      if (error.status !== 409) throw error;
      refusal = error;
      return { ok: false };
    } finally {
      if (strip) {
        state.writing = null;
        state.activity = null;
        stopPolling();
        renderActivity();
      }
      if (refusal) refused(refusal);
    }
  }

  function takeList(data) {
    if (!data) return;
    if (Array.isArray(data.suggestions)) state.suggestions = data.suggestions;
    if (data.summary) state.summary = data.summary;
  }

  let lastTotal = -1;
  let fetching = null;
  async function refreshWhileRunning(run) {
    const total = Number(run.summary?.total);
    if (total === lastTotal || fetching) return;
    lastTotal = total;
    fetching = loadSuggestions().finally(() => {
      fetching = null;
    });
    await fetching;
    renderResults();
  }

  function attach(run) {
    state.run = run;
    state.lastOptions = run.options || state.lastOptions;
    renderRun();
    if (!LIVE_STATES.includes(run.status)) return;
    if (state.stopFollowing) state.stopFollowing();
    lastTotal = -1;
    refreshWhileRunning(run);
    state.stopFollowing = follow(run.id, {
      getJson,
      onSnapshot(next) {
        state.run = next;
        if (next && 'activity' in next) seeActivity(next.activity);
        renderRun();
        refreshWhileRunning(next);
      },
      async onEnd(next) {
        state.stopFollowing = null;
        state.run = next;
        await loadSuggestions();
        renderRun();
        loadRecent();
      },
      onLost(error) {
        state.stopFollowing = null;
        toast(`The run could not be followed: ${error.message}`, {
          tone: 'danger',
        });
      },
    });
  }

  async function loadCurrent() {
    try {
      const payload = await getJson('/api/tidy-up/runs/current');
      const run = payload.data;
      if (!run) {
        showStart();
        return;
      }
      if (END_STATES.includes(run.status)) {
        state.run = run;
        state.lastOptions = run.options || null;
        await loadSuggestions();
        renderRun();
        return;
      }
      attach(run);
    } catch {
      // No run service (yet), or no run: the start screen is the page.
      showStart();
    }
  }

  /* --- starting and stopping ---------------------------------------------- */

  async function startRun(options) {
    if (state.busy || busy()) return;
    state.busy = true;
    if (el.find) el.find.disabled = true;
    try {
      state.lastOptions = { ...options };
      state.suggestions = [];
      state.summary = null;
      state.decidedHere.clear();
      state.banner = null;
      state.edits = {};
      state.filter = 'all';
      state.showEarlier = false;
      const payload = await sendJson('POST', '/api/tidy-up/runs', options);
      attach(payload.data);
    } catch (error) {
      if (error.status === 409) {
        await loadCurrent();
      } else {
        toast(error.message, { tone: 'danger' });
      }
    } finally {
      state.busy = false;
      if (el.find) el.find.disabled = false;
    }
  }

  async function stopRun(button) {
    if (!state.run) return;
    button.disabled = true;
    try {
      const payload = await sendJson(
        'POST',
        `/api/tidy-up/runs/${encodeURIComponent(state.run.id)}/stop`
      );
      if (payload.data) {
        state.run = payload.data;
        renderRun();
      }
    } catch (error) {
      button.disabled = false;
      toast(error.message, { tone: 'danger' });
    }
  }

  /* --- deciding ---------------------------------------------------------- */

  function editsFor(ids) {
    const out = {};
    for (const id of ids) {
      const e = state.edits[id];
      if (e && Object.keys(e).length) out[id] = e;
    }
    return Object.keys(out).length ? out : undefined;
  }

  async function decide(ids, decision, { batchBanner = false } = {}) {
    if (!ids.length || busy()) return;
    try {
      const body = { ids, decision };
      const edits = decision === 'accept' ? editsFor(ids) : undefined;
      if (edits) body.edits = edits;
      // "Later" writes nothing: no strip, but a 409 still shows what holds.
      const result = await withWriting(
        ids,
        () => sendJson('POST', '/api/tidy-up/suggestions/decide', body),
        { strip: decision !== 'later' }
      );
      if (!result.ok) return;
      const payload = result.value;
      const data = payload.data || {};
      takeList(data);
      ids.forEach((id) => state.decidedHere.add(id));
      ids.forEach((id) => state.ticked.delete(id));
      if (decision === 'accept' && data.batchId) {
        const done = state.suggestions.filter(
          (s) => ids.includes(s.id) && s.status === 'done'
        );
        state.batchSizes.set(data.batchId, done.length);
        done.forEach((s) => state.batchOf.set(s.id, data.batchId));
        if (batchBanner && done.length) {
          state.banner = { batchId: data.batchId, count: done.length };
        }
        const failed = state.suggestions.filter(
          (s) => ids.includes(s.id) && s.status === 'failed'
        );
        if (failed.length) {
          toast(
            failed.length === 1
              ? 'One change was refused; the line says why.'
              : `${failed.length} changes were refused; the lines say why.`,
            { tone: 'warn' }
          );
        }
        loadRecent();
      }
      renderResults();
    } catch (error) {
      toast(error.message, { tone: 'danger' });
    }
  }

  /** Undoes one batch; false when the server was busy (the strip says so). */
  async function undoBatch(batchId) {
    const ids = [...state.batchOf]
      .filter(([, b]) => b === batchId)
      .map(([id]) => id);
    const result = await withWriting(ids, () =>
      sendJson('POST', '/api/tidy-up/suggestions/undo', { batchId })
    );
    if (!result.ok) return false;
    const payload = result.value;
    if (payload.data && Array.isArray(payload.data.suggestions)) {
      takeList(payload.data);
    } else {
      await loadSuggestions();
    }
    for (const [id, b] of state.batchOf)
      if (b === batchId) state.batchOf.delete(id);
    state.batchSizes.delete(batchId);
    if (state.banner && state.banner.batchId === batchId) state.banner = null;
    return true;
  }

  /** One done line's Undo: its own batch when it was alone in it, else its log entry. */
  async function undoOne(s) {
    const batchId = s.batchId || state.batchOf.get(s.id) || null;
    const alone = batchId && state.batchSizes.get(batchId) === 1;
    try {
      if (batchId && (alone || !s.undoId)) {
        if (!(await undoBatch(batchId))) return;
      } else if (s.undoId) {
        const result = await withWriting([s.id], () =>
          sendJson(
            'POST',
            `/api/duplicates/log/${encodeURIComponent(s.undoId)}/undo`
          )
        );
        if (!result.ok) return;
        await loadSuggestions();
      }
      state.decidedHere.delete(s.id);
      toast('Undone', { tone: 'ok' });
      loadRecent();
      renderResults();
    } catch (error) {
      toast(error.message, { tone: 'danger' });
    }
  }

  /* --- failure actions ----------------------------------------------------- */

  async function testConnection() {
    try {
      const payload = await getJson(
        '/api/duplicates/ai-review/estimate?kind=all'
      );
      const d = payload.data || {};
      const requests = Number(d.requests) || 0;
      toast(
        `${d.model || 'The model'} is set up${requests ? `; the next run needs about ${number(requests)} requests` : ''}.`,
        { tone: 'ok' }
      );
    } catch (error) {
      toast(error.message, { tone: 'danger' });
    }
  }

  function failureAction(key) {
    if (key === 'decide-myself') {
      state.filter = 'unsure';
      renderResults();
      const first = el.list.querySelector(
        '[data-certainty="unsure"][data-status="open"]'
      );
      if (first) {
        first.scrollIntoView({ behavior: 'smooth', block: 'start' });
        first.querySelector('button')?.focus({ preventScroll: true });
      }
      return;
    }
    if (key === 'test-connection') {
      testConnection();
      return;
    }
    const options = state.lastOptions || readOptions();
    startRun({ ...options, action: key });
  }

  /* --- the vocabulary dialog ----------------------------------------------- */

  async function editVocabulary() {
    if (!state.vocabulary) await loadVocabulary();
    const lines = (list) => esc(list.map((e) => e.name).join('\n'));
    const result = await window.zrDialog({
      title: 'The names splits use',
      html: `<div class="tidy-vocab">
          <p class="zr-sm zr-muted">One name per line. Every split suggestion picks from these.</p>
          <label class="tidy-vocab__field"><span class="zr-sm">Document types</span>
            <textarea class="zr-textarea" rows="7" data-vocab="types">${lines(state.vocabulary.types)}</textarea></label>
          <label class="tidy-vocab__field"><span class="zr-sm">Topics</span>
            <textarea class="zr-textarea" rows="7" data-vocab="topics">${lines(state.vocabulary.topics)}</textarea></label>
        </div>`,
      showCancelButton: true,
      confirmButtonText: 'Save',
      onOpen({ dialog }) {
        dialog.classList.add('tidy-vocab-dialog');
        editVocabulary.dialog = dialog;
      },
    });
    const dialog = editVocabulary.dialog;
    editVocabulary.dialog = null;
    if (!result.isConfirmed || !dialog) return;
    const read = (key) =>
      String(dialog.querySelector(`[data-vocab="${key}"]`)?.value || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    try {
      await sendJson('PUT', '/api/simplify/vocabulary', {
        types: read('types'),
        topics: read('topics'),
      });
      await loadVocabulary();
      renderResults();
      toast('Saved', { tone: 'ok' });
    } catch (error) {
      toast(error.message, { tone: 'danger' });
    }
  }

  /* --- recent changes ------------------------------------------------------ */

  async function loadRecent() {
    if (!el.recent) return;
    try {
      const payload = await getJson('/api/tidy-up/recent');
      const rows = Array.isArray(payload.data) ? payload.data : [];
      if (!rows.length) {
        el.recent.innerHTML =
          '<p class="zr-sm zr-faint tidy-recent__empty">Nothing changed yet.</p>';
        return;
      }
      el.recent.innerHTML = `<ul class="tidy-recent__rows">${rows
        .map(
          (r) => `<li class="tidy-recent__row" data-recent-id="${esc(r.id)}">
            <span class="zr-sm zr-faint tidy-recent__when">${esc(whenText(r.when))}</span>
            <span class="tidy-recent__sentence">${esc(r.sentence)}</span>
            <span class="zr-sm tidy-recent__status tidy-recent__status--${esc(r.status)}">${esc(STATUS_WORDS[r.status] || r.status)}</span>
            ${r.canUndo ? `<button type="button" class="zr-btn" data-act="recent-undo" data-id="${esc(r.id)}">Undo</button>` : ''}
          </li>`
        )
        .join('')}</ul>`;
      applyBusy();
    } catch {
      el.recent.innerHTML =
        '<p class="zr-sm zr-faint tidy-recent__empty">Recent changes could not be loaded.</p>';
    }
  }

  async function undoRecent(id, button) {
    if (busy()) return;
    button.disabled = true;
    try {
      const result = await withWriting([], () =>
        sendJson('POST', `/api/duplicates/log/${encodeURIComponent(id)}/undo`)
      );
      if (!result.ok) {
        button.disabled = false;
        return;
      }
      toast('Undone', { tone: 'ok' });
      await loadRecent();
      if (state.run) {
        await loadSuggestions();
        renderResults();
      }
    } catch (error) {
      button.disabled = false;
      toast(error.message, { tone: 'danger' });
    }
  }

  /* --- advanced ------------------------------------------------------------ */

  async function forgetDecisions(button) {
    const answer = await window.zrDialog({
      title: 'Forget my earlier decisions?',
      text: 'The model has to answer every pair again on the next run, which takes longer. Pairs you marked as not the same stay hidden.',
      showCancelButton: true,
      confirmButtonText: 'Forget',
      icon: 'warning',
    });
    if (!answer.isConfirmed) return;
    button.disabled = true;
    try {
      const payload = await sendJson(
        'DELETE',
        '/api/duplicates/ai-review/memory'
      );
      const removed = Number(payload.data?.removed) || 0;
      toast(
        `${number(removed)} earlier ${removed === 1 ? 'answer' : 'answers'} forgotten`,
        { tone: 'ok' }
      );
    } catch (error) {
      toast(error.message, { tone: 'danger' });
    } finally {
      button.disabled = false;
    }
  }

  async function loadHidden() {
    el.hidden.innerHTML = '<p class="zr-sm zr-faint">Loading…</p>';
    try {
      const payload = await getJson('/api/duplicates/dismissals');
      const rows = Array.isArray(payload.data) ? payload.data : [];
      el.hidden.innerHTML = rows.length
        ? `<ul class="tidy-hidden__rows">${rows
            .map((d) => {
              const a = d.nameA == null ? `#${d.idA}` : d.nameA;
              const b = d.nameB == null ? `#${d.idB}` : d.nameB;
              return `<li class="tidy-hidden__row">
                <span class="zr-sm zr-faint">${d.kind === 'correspondents' ? 'correspondents' : 'tags'}</span>
                <span class="zr-grow"><code class="tidy-name">${esc(a)}</code> and <code class="tidy-name">${esc(b)}</code></span>
                <button type="button" class="zr-btn" data-act="restore" data-id="${Number(d.id)}">Restore</button>
              </li>`;
            })
            .join('')}</ul>`
        : '<p class="zr-sm zr-faint">No hidden pairs.</p>';
    } catch (error) {
      el.hidden.innerHTML = `<p class="zr-sm zr-danger-text">${esc(error.message)}</p>`;
    }
  }

  async function restoreHidden(id, button) {
    button.disabled = true;
    try {
      await sendJson(
        'DELETE',
        `/api/duplicates/dismissals/${encodeURIComponent(id)}`
      );
      toast('The pair comes back in the next run', { tone: 'ok' });
      await loadHidden();
    } catch (error) {
      button.disabled = false;
      toast(error.message, { tone: 'danger' });
    }
  }

  async function fillEstimate() {
    if (!modelAvailable || !el.estimate) return;
    try {
      const payload = await getJson(
        '/api/duplicates/ai-review/estimate?kind=all'
      );
      const d = payload.data || {};
      const requests = Number(d.requests) || 0;
      if (!d.needsScan && requests > 0) {
        el.estimate.textContent = `, about ${number(requests)} ${requests === 1 ? 'request' : 'requests'}`;
      }
    } catch {
      // Without an estimate the sentence reads fine as it is.
    }
  }

  /* --- clicks ------------------------------------------------------------- */

  function suggestionOf(node) {
    const holder = node.closest('[data-id]');
    if (!holder) return null;
    return state.suggestions.find((s) => s.id === holder.dataset.id) || null;
  }

  function groupIds(node) {
    const card = node.closest('[data-group]');
    return card ? card.dataset.ids.split(' ').filter(Boolean) : [];
  }

  root.addEventListener('click', (event) => {
    const filterBtn = event.target.closest('[data-filter]');
    if (filterBtn) {
      state.filter = filterBtn.dataset.filter;
      renderResults();
      return;
    }
    const button = event.target.closest('[data-act]');
    if (
      !button ||
      button.disabled ||
      button.getAttribute('aria-disabled') === 'true'
    )
      return;
    const act = button.dataset.act;
    const s = suggestionOf(button);
    switch (act) {
      case 'accept':
        if (s) decide([s.id], 'accept');
        break;
      case 'decline':
        if (s) decide([s.id], 'decline');
        break;
      case 'later':
        if (s) decide([s.id], 'later');
        break;
      case 'retry':
        if (s) decide([s.id], 'accept');
        break;
      case 'undo':
        if (s) {
          button.disabled = true;
          undoOne(s);
        }
        break;
      case 'swap':
        if (s) {
          const keepId = Number(button.dataset.keep);
          const edit = { ...(state.edits[s.id] || {}) };
          if (s.to && keepId === s.to.id) delete edit.keepId;
          else edit.keepId = keepId;
          state.edits[s.id] = edit;
          renderResults();
        }
        break;
      case 'edit-list':
        editVocabulary();
        break;
      case 'delete-all': {
        const ids = groupIds(button);
        decide(ids, 'accept', { batchBanner: ids.length > 1 });
        break;
      }
      case 'pick': {
        const card = button.closest('[data-group]');
        state.picking.add(card.dataset.group);
        groupIds(button).forEach((id) => state.ticked.add(id));
        renderResults();
        break;
      }
      case 'pick-cancel':
        state.picking.delete(button.closest('[data-group]').dataset.group);
        renderResults();
        break;
      case 'delete-ticked': {
        const card = button.closest('[data-group]');
        const ids = groupIds(button).filter((id) => state.ticked.has(id));
        state.picking.delete(card.dataset.group);
        decide(ids, 'accept', { batchBanner: ids.length > 1 });
        break;
      }
      case 'accept-sure': {
        const ids = state.suggestions
          .filter((x) => x.status === 'open' && x.certainty === 'sure')
          .map((x) => x.id);
        decide(ids, 'accept', { batchBanner: true });
        break;
      }
      case 'undo-batch':
        if (state.banner) {
          button.disabled = true;
          const { batchId, count } = state.banner;
          undoBatch(batchId)
            .then((ok) => {
              if (!ok) {
                button.disabled = false;
                return;
              }
              state.decidedHere.forEach((id) => {
                const x = state.suggestions.find((y) => y.id === id);
                if (x && x.status === 'open') state.decidedHere.delete(id);
              });
              toast(
                `${number(count)} ${count === 1 ? 'change' : 'changes'} undone`,
                { tone: 'ok' }
              );
              loadRecent();
              renderResults();
            })
            .catch((error) => {
              button.disabled = false;
              toast(error.message, { tone: 'danger' });
            });
        }
        break;
      case 'run-again':
        state.run = null;
        showStart();
        el.start?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      case 'toggle-earlier':
        state.showEarlier = !state.showEarlier;
        renderResults();
        break;
      case 'stop':
        stopRun(button);
        break;
      case 'failure-action':
        failureAction(button.dataset.key);
        break;
      case 'recent-undo':
        undoRecent(button.dataset.id, button);
        break;
      case 'restore':
        restoreHidden(button.dataset.id, button);
        break;
      default:
        break;
    }
  });

  root.addEventListener('change', (event) => {
    const target = event.target;
    const act = target.dataset?.act;
    const s = suggestionOf(target);
    if (act === 'keep' && s) {
      const keepId = Number(target.value);
      const edit = { ...(state.edits[s.id] || {}) };
      if (s.to && keepId === s.to.id) delete edit.keepId;
      else edit.keepId = keepId;
      state.edits[s.id] = edit;
      renderResults();
    } else if (act === 'type' && s) {
      state.edits[s.id] = {
        ...(state.edits[s.id] || {}),
        typeName: target.value || null,
      };
    } else if (act === 'tick') {
      if (target.checked) state.ticked.add(target.value);
      else state.ticked.delete(target.value);
      renderResults();
    }
  });

  root.addEventListener('input', (event) => {
    const target = event.target;
    if (target.dataset?.act !== 'topics') return;
    const s = suggestionOf(target);
    if (s)
      state.edits[s.id] = {
        ...(state.edits[s.id] || {}),
        topicNames: topicList(target.value),
      };
  });

  // Remember which Details are open, so a redraw keeps them open.
  root.addEventListener(
    'toggle',
    (event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || !details.dataset.details)
        return;
      if (details.open) state.openDetails.add(details.dataset.details);
      else state.openDetails.delete(details.dataset.details);
    },
    true
  );

  el.find?.addEventListener('click', () => startRun(readOptions()));
  el.forget?.addEventListener('click', () => forgetDecisions(el.forget));
  el.hiddenToggle?.addEventListener('click', () => {
    const open = el.hiddenToggle.getAttribute('aria-expanded') !== 'true';
    el.hiddenToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    show(el.hidden, open);
    if (open) loadHidden();
  });

  loadCurrent();
  loadRecent();
  fillEstimate();

  return {
    destroy() {
      if (state.stopFollowing) state.stopFollowing();
      stopPolling();
    },
  };
}
