/**
 * Dashboard module.
 *
 * Replaces the former dashboard.js + dashboard-scripts.ejs pair. All figures come
 * from /api/dashboard/stats (the rendered page ships zeroes only), the runner
 * state is polled from /api/processing-status.
 */

import { renderDonut } from './donut.js';
import { renderSpark } from './spark.js';
import { renderBarList } from './bar-list.js';
import { formatTimeAgo, updateScannerHealthBanner } from './scanner-health.js';
import { describeScanSchedule } from './scan-schedule.js';
import { describeBoard, renderBoard } from './runner-board.js';
import { escapeHtml } from './text-utils.js';
import { formatDate } from './date-format.js';

const STATS_URL = '/api/dashboard/stats';
const STATUS_URL = '/api/processing-status';
const STATUS_INTERVAL_MS = 3000;
// The scan clock re-renders from the last status body, no request involved.
// Half a second rather than one: a one-second timer drifts against the
// countdown's second boundaries and now and then skips or repeats a second.
const SCAN_CLOCK_TICK_MS = 500;
// Status polls between two attempts to recover a failing statistics endpoint.
const STATS_RETRY_POLLS = 10;
const REQUEST_TIMEOUT_MS = 15000;

const COMPACT_UNITS = [
  { threshold: 1e9, suffix: 'b' },
  { threshold: 1e6, suffix: 'm' },
  { threshold: 1e3, suffix: 'k' },
];

// Document types are categories, not states — they get the neutral chart palette
// rather than ok/warn/danger, which mean something else two modules over.
const CATEGORY_TONES = [
  'cat-1',
  'cat-2',
  'cat-3',
  'cat-4',
  'cat-5',
  'cat-6',
  'cat-7',
  'cat-8',
];

function formatNumber(value, { compact = false } = {}) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return '0';
  if (!compact || Math.abs(numeric) < 1000) return numeric.toLocaleString();

  const unit = COMPACT_UNITS.find(
    (entry) => Math.abs(numeric) >= entry.threshold
  );
  const scaled = numeric / unit.threshold;
  const rounded = Math.round(scaled * 10) / 10;
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(1).replace(/\.0$/, '');
  return `${text}${unit.suffix}`;
}

/**
 * The legend beside a donut. Shared by both charts so the escaping is not a
 * property of the call site: one legend is fed hardcoded labels today, and that
 * is not something the next caller inherits.
 *
 * @param {HTMLElement} el
 * @param {Array<{label: string, value: number, tone: string}>} series
 * @param {string} emptyHtml markup for an empty series
 */
function renderLegend(el, series, emptyHtml = '') {
  el.innerHTML = series.length
    ? series
        .map(
          (entry) => `
            <div class="zr-row">
              <span class="zr-dot zr-dot--${entry.tone}"></span>
              <span class="zr-grow zr-truncate">${escapeHtml(entry.label)}</span>
              <span class="zr-num zr-strong">${formatNumber(entry.value)}</span>
            </div>`
        )
        .join('')
    : emptyHtml;
}

function formatDocumentCount(value) {
  const numeric = Number(value || 0);
  return `${formatNumber(numeric)} ${Math.abs(numeric) === 1 ? 'doc' : 'docs'}`;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export default function dashboard(root, { toast }) {
  const paperlessUrl = (root.dataset.paperlessUrl || '').replace(/\/$/, '');

  const byId = (id) => document.getElementById(id);
  const setText = (id, value) => {
    const el = byId(id);
    if (el) el.textContent = value;
  };

  /* --- statistics ------------------------------------------------------- */

  function documentUrl(documentId) {
    const id = Number(documentId || 0);
    if (!Number.isInteger(id) || id <= 0 || !paperlessUrl) return '';
    return `${paperlessUrl}/documents/${id}/details`;
  }

  function renderRecentActivity(items) {
    const container = byId('recentActivityList');
    if (!container) return;

    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) {
      container.innerHTML =
        '<div class="zr-list__item"><span class="zr-sm zr-faint">No recent processing activity.</span></div>';
      return;
    }

    container.innerHTML = rows
      .map((item) => {
        const url = documentUrl(item.documentId);
        const tag = url ? 'a' : 'div';
        const href = url
          ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"`
          : '';
        return `
          <${tag} class="zr-list__item"${href}>
            <span class="zr-badge zr-badge--ok">
              <svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-check"/></svg>
            </span>
            <span class="zr-list__main">
              <span class="zr-list__title">${escapeHtml(item.title || 'Untitled document')}</span>
              <span class="zr-list__sub">${escapeHtml(item.correspondent || 'Unknown correspondent')} &middot; #${Number(item.documentId || 0)}</span>
            </span>
            <span class="zr-list__time">${escapeHtml(formatDate(item.createdAt, { fallback: 'unknown date' }))}</span>
          </${tag}>`;
      })
      .join('');
  }

  function renderDocumentTypes(items) {
    const chart = byId('documentTypesDonut');
    const legend = byId('documentTypesLegend');
    const rows = (Array.isArray(items) ? items : [])
      .map((entry) => ({
        label: entry.type || 'Unknown',
        value: Number(entry.count || 0),
      }))
      .sort((a, b) => b.value - a.value);

    // The palette runs out before the categories do, and a donut with two
    // identical slices is worse than one that admits it grouped the tail.
    const limit = CATEGORY_TONES.length - 1;
    const head = rows.slice(0, limit);
    const tail = rows.slice(limit);
    const grouped = tail.length
      ? [
          ...head,
          {
            label: `Other (${tail.length})`,
            value: tail.reduce((sum, entry) => sum + entry.value, 0),
          },
        ]
      : head;

    const series = grouped.map((entry, index) => ({
      ...entry,
      tone: CATEGORY_TONES[index],
    }));

    if (chart) renderDonut(chart, series, 'classified');
    if (legend) {
      renderLegend(
        legend,
        series,
        '<p class="zr-sm zr-faint">No document types yet.</p>'
      );
    }
  }

  function renderProcessingSplit(stats) {
    const chart = byId('processingDonut');
    const legend = byId('processingLegend');

    const documentCount = Number(stats.documentCount || 0);
    const processed = Math.max(0, Number(stats.processedDocumentCount || 0));
    const ocrNeeded = Math.max(0, Number(stats.ocrNeededCount || 0));
    const failed = Math.max(0, Number(stats.failedCount || 0));
    const unprocessed = Math.max(
      0,
      documentCount - Math.min(processed, documentCount) - ocrNeeded - failed
    );

    const series = [
      {
        label: 'AI processed',
        value: Math.min(processed, documentCount),
        tone: 'brand',
      },
      { label: 'OCR needed', value: ocrNeeded, tone: 'warn' },
      { label: 'Failed', value: failed, tone: 'danger' },
      { label: 'Unprocessed', value: unprocessed, tone: 'text-faint' },
    ];

    if (chart) renderDonut(chart, series, 'documents');
    if (legend) renderLegend(legend, series);
  }

  function applyStats(payload) {
    const stats = payload.paperless_data || {};
    const ai = payload.openai_data || {};

    const documentCount = Number(stats.documentCount || 0);
    const rawProcessed = Math.max(0, Number(stats.processedDocumentCount || 0));
    const ocrNeeded = Math.max(0, Number(stats.ocrNeededCount || 0));
    const failed = Math.max(0, Number(stats.failedCount || 0));
    // The processed total is all-time and survives deletions in Paperless-ngx,
    // so it can exceed the current library. Capping it in one place keeps the
    // tile, the coverage figure and the donut from stating different numbers
    // for the same thing on the same screen.
    const processed = Math.min(rawProcessed, documentCount);
    const unprocessed = Math.max(
      0,
      documentCount - processed - ocrNeeded - failed
    );

    setText('kpiDocuments', formatNumber(documentCount));
    setText('kpiProcessed', formatNumber(processed));
    setText('kpiOcr', formatNumber(ocrNeeded));
    setText('kpiFailed', formatNumber(failed));
    setText('kpiUnprocessed', formatNumber(unprocessed));

    const coverage =
      documentCount > 0 ? Math.round((processed / documentCount) * 100) : 0;
    setText(
      'kpiProcessedDelta',
      rawProcessed > documentCount
        ? `${coverage} % coverage, ${formatNumber(rawProcessed)} all-time`
        : `${coverage} % coverage`
    );

    const failedDelta = byId('kpiFailedDelta');
    if (failedDelta) {
      failedDelta.textContent =
        failed > 0 ? 'needs attention' : 'nothing failed';
      failedDelta.classList.toggle('zr-stat__delta--down', failed > 0);
    }

    setText('totalTags', formatNumber(stats.tagCount));
    setText('totalCorrespondents', formatNumber(stats.correspondentCount));
    setText(
      'efficiencyRate',
      `${Math.max(0, Number(stats.processingEfficiencyRate || 0))} %`
    );
    setText('queueBacklog', formatNumber(stats.queueBacklog));
    setText('failedRate', `${Math.max(0, Number(stats.failedRate || 0))} %`);

    setText(
      'avgPromptTokens',
      formatNumber(ai.averagePromptTokens, { compact: true })
    );
    setText(
      'avgCompletionTokens',
      formatNumber(ai.averageCompletionTokens, { compact: true })
    );
    setText(
      'avgTotalTokens',
      formatNumber(ai.averageTotalTokens, { compact: true })
    );
    setText('tokensOverall', formatNumber(ai.tokensOverall, { compact: true }));

    const trend = Array.isArray(stats.tokenTrend) ? stats.tokenTrend : [];
    const spark = byId('tokenTrendSpark');
    if (spark) {
      renderSpark(
        spark,
        trend.map((point) => Number(point.totalTokens || 0)),
        trend.map((point) => String(point.day || ''))
      );
      byId('tokenTrendEmpty')?.classList.toggle(
        'hidden',
        !spark.hasAttribute('data-empty')
      );
    }

    const distributionList = byId('tokenDistributionList');
    if (distributionList) {
      renderBarList(
        distributionList,
        (Array.isArray(stats.tokenDistribution)
          ? stats.tokenDistribution
          : []
        ).map((entry) => ({
          label: entry.range,
          value: Number(entry.count || 0),
          display: formatDocumentCount(entry.count),
        })),
        { emptyText: 'No token data yet.' }
      );
    }

    const languageList = byId('languageDistributionList');
    if (languageList) {
      renderBarList(
        languageList,
        (Array.isArray(stats.languageDistribution)
          ? stats.languageDistribution
          : []
        ).map((entry) => ({
          label: entry.language || 'Unknown',
          value: Number(entry.count || 0),
          display: formatDocumentCount(entry.count),
        })),
        { emptyText: 'No language data yet.' }
      );
    }

    renderDocumentTypes(stats.documentTypes);
    renderProcessingSplit(stats);
    renderRecentActivity(stats.recentActivity);
  }

  /* --- freshness -------------------------------------------------------- */

  // Every figure on this page is polled. When a poll fails the old numbers stay
  // on screen, so the page has to say so — a toast that fades leaves a dashboard
  // that looks current and is not.
  const failures = new Map();
  // When each source last delivered, keyed by source. One shared timestamp did
  // not work: the status poll succeeds every three seconds, so it kept
  // restamping the label to "now" and hid the age of the statistics, which come
  // out of a server-side cache and can legitimately be a minute old — or much
  // older when Paperless-ngx is down and the cache is being served stale.
  const freshAt = new Map();

  // The oldest thing on screen is the honest claim for a label that covers the
  // whole page.
  function oldestFresh() {
    // A source that has never answered has no age to report, and borrowing the
    // other one's would date figures that are not on screen at all.
    for (const source of failures.keys()) {
      if (!freshAt.has(source)) return null;
    }
    if (!freshAt.size) return null;
    return new Date(Math.min(...freshAt.values()));
  }

  function renderFreshness() {
    const label = byId('statusLastUpdated');
    if (!label) return;

    const reason = [...failures.values()][0] || '';
    const updatedAt = oldestFresh();
    const at = updatedAt ? updatedAt.toLocaleTimeString() : '';
    if (!reason) {
      label.textContent = at ? `updated ${at}` : '';
    } else {
      label.textContent = at
        ? `${reason} — showing data from ${at}`
        : `${reason} — retrying`;
    }
    label.classList.toggle('zr-danger-text', Boolean(reason));
    label.classList.toggle('zr-faint', !reason);
  }

  // Tracked per source: the status poll succeeding every three seconds must not
  // paper over a statistics endpoint that is still failing.
  // `at` is the epoch-millisecond timestamp at which the data was assembled —
  // the statistics endpoint answers from a cache, so the time of the fetch is
  // not the age of the numbers it returned. Sources that have no such stamp
  // (the status poll builds its answer per request) date themselves to now.
  function markFresh(source, at = null) {
    failures.delete(source);
    freshAt.set(source, Number.isFinite(at) && at > 0 ? at : Date.now());
    renderFreshness();
  }

  function markStale(source, reason) {
    failures.set(source, reason);
    renderFreshness();
  }

  let statsInFlight = false;

  async function loadStats({ silent = false } = {}) {
    if (statsInFlight) return;
    statsInFlight = true;

    try {
      const payload = await fetchJson(STATS_URL);
      if (!payload?.success)
        throw new Error(payload?.error || 'Invalid dashboard stats response');
      applyStats(payload);
      markFresh('stats', payload.cachedAt);
    } catch (error) {
      console.error('[dashboard] stats failed', error);
      markStale('stats', 'Statistics could not be loaded');
      if (!silent) {
        toast('Dashboard statistics could not be loaded', { tone: 'danger' });
      }
    } finally {
      statsInFlight = false;
      settleLoading('stats');
    }
  }

  /* The page is loading until both fetches have reported back once: the figures
     come from the stats call, the runner line from the status poll. Reporting
     back counts either way — a failure is told by the stale banner, not by a
     page that keeps pretending to load. Only the first pass matters; the
     background refreshes must not blank the page out again. */
  const firstPass = { stats: false, status: false };
  function settleLoading(source) {
    firstPass[source] = true;
    if (firstPass.stats && firstPass.status) delete root.dataset.loading;
  }

  /* --- scan clock ------------------------------------------------------ */

  // Last scan, next scan with a countdown, the schedule in words and the
  // board of the two lanes, all in the Task runner card. The countdowns and
  // the timers move every second between two polls by re-rendering the last
  // status body; they only tick while something counts and the tab is
  // visible.
  let scanStatus = null;
  let scanTick = null;

  // Written only on a change, so an unchanged line is not touched twice a
  // second.
  function setTextOnChange(id, value) {
    const el = byId(id);
    if (el && el.textContent !== value) el.textContent = value;
  }

  function syncScanTick(counting) {
    const wanted = Boolean(counting) && !document.hidden;
    if (wanted && !scanTick) {
      scanTick = setInterval(renderScanClock, SCAN_CLOCK_TICK_MS);
    } else if (!wanted && scanTick) {
      clearInterval(scanTick);
      scanTick = null;
    }
  }

  function renderScanClock() {
    if (!scanStatus) return;
    const view = describeScanSchedule(scanStatus, {
      formatDay: (date) => formatDate(date),
    });

    setTextOnChange('scanLastRun', view.last);
    setTextOnChange('scanNextRun', view.next);
    setTextOnChange('scanSchedule', view.schedule);
    const schedule = byId('scanSchedule');
    if (schedule && schedule.title !== view.scheduleTitle) {
      if (view.scheduleTitle) schedule.title = view.scheduleTitle;
      else schedule.removeAttribute('title');
    }

    const formatDay = (date) => formatDate(date);
    const board = describeBoard(scanStatus, { formatDay });
    const card = byId('runnerBoard')?.closest('[data-widget="task-runner"]');
    if (card) renderBoard(card, board);

    syncScanTick(view.counting || board.ticking);
  }

  function updateScanClock(data) {
    scanStatus = data;
    renderScanClock();
  }

  // A hidden tab has nobody to count down for; coming back renders at once
  // instead of waiting for the next tick.
  function onVisibilityChange() {
    if (document.hidden) syncScanTick(false);
    else renderScanClock();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  /* --- runner status ---------------------------------------------------- */

  let lastSeenProcessedDocId = null;
  let statsRetryCountdown = STATS_RETRY_POLLS;
  // Which of the two scan requests is in flight; both are read by setScanButtons.
  const pending = { scan: false, stop: false };

  function setScanButtons(isScanning, stopRequested) {
    const scanButton = byId('scanButton');
    const stopButton = byId('stopScanButton');
    if (!scanButton || !stopButton) return;

    // The runner card shows the seal sorting documents while a scan is on. It
    // hangs off the same state the buttons read, so the animation can never
    // disagree with what the buttons say.
    const card = scanButton.closest('[data-widget="task-runner"]');
    if (card) card.classList.toggle('is-scanning', Boolean(isScanning));

    // While the start request is in flight the scan button stays put and says
    // so. Swapping straight to "Stop" would claim a scan is running before the
    // server has agreed, and hide the "Starting…" label on the way out.
    scanButton.classList.toggle('hidden', isScanning && !pending.scan);
    scanButton.disabled = isScanning || pending.scan;
    scanButton.querySelector('span').textContent = pending.scan
      ? 'Starting…'
      : 'Scan now';

    stopButton.classList.toggle('hidden', !isScanning || pending.scan);
    stopButton.disabled = !isScanning || stopRequested || pending.stop;
    stopButton.querySelector('span').textContent =
      stopRequested || pending.stop ? 'Stopping…' : 'Stop';
  }

  async function pollStatus() {
    try {
      const data = await fetchJson(STATUS_URL);

      const currentDocId = data.lastProcessed
        ? data.lastProcessed.documentId
        : null;
      const documentChanged =
        lastSeenProcessedDocId !== null &&
        currentDocId !== null &&
        currentDocId !== lastSeenProcessedDocId;
      // The statistics are otherwise fetched exactly once, so a hiccup at page
      // load used to freeze them until a manual reload. Retry on a slower beat
      // than the status poll while they are known to be stale.
      const retryStats = failures.has('stats') && statsRetryCountdown-- <= 0;
      if (retryStats) statsRetryCountdown = STATS_RETRY_POLLS;
      if (documentChanged || retryStats) {
        loadStats({ silent: true });
      }
      lastSeenProcessedDocId = currentDocId;

      const isScanning = Boolean(data.isScanning || data.currentlyProcessing);
      const dot = byId('runnerDot');
      const docIdBadge = byId('currentDocId');

      if (data.currentlyProcessing) {
        const title = String(data.currentlyProcessing.title || '');
        setText('runnerLabel', 'Processing document');
        setText(
          'runnerDetail',
          title.length > 90 ? `${title.slice(0, 90)}…` : title
        );
        if (docIdBadge) {
          docIdBadge.textContent = `#${data.currentlyProcessing.documentId}`;
          docIdBadge.classList.remove('hidden');
        }
        setText('lastProcessed', 'in progress');
      } else {
        // OCR reads the queue on its own, outside a scan.
        const ocrActivity = data.activity?.ocr;
        const ocrBusy = Boolean(
          ocrActivity?.running || ocrActivity?.active?.length
        );
        setText(
          'runnerLabel',
          isScanning
            ? 'Scanning'
            : ocrBusy
              ? 'Reading the OCR queue'
              : 'System idle'
        );
        setText(
          'runnerDetail',
          isScanning
            ? 'Looking for documents to process'
            : ocrBusy
              ? 'OCR reads one document after the other'
              : 'Waiting for new documents'
        );
        docIdBadge?.classList.add('hidden');
        setText(
          'lastProcessed',
          data.lastProcessed
            ? // Database timestamps carry no timezone marker and are UTC.
              formatTimeAgo(data.lastProcessed.processed_at, {
                assumeUtc: true,
              })
            : 'no data'
        );
      }

      if (dot)
        dot.className = `zr-dot ${isScanning || data.activity?.ocr?.running ? 'zr-dot--live' : 'zr-dot--ok'}`;

      setScanButtons(isScanning, Boolean(data.stopRequested));
      updateScannerHealthBanner(
        {
          banner: byId('scannerHealthBanner'),
          title: byId('scannerHealthTitle'),
          message: byId('scannerHealthMessage'),
        },
        data
      );
      updateScanClock(data);
      setText('processedToday', formatNumber(data.processedToday));
      markFresh('status');
    } catch (error) {
      console.error('[dashboard] processing status failed', error);
      markStale('status', 'Live status lost');
    } finally {
      settleLoading('status');
    }
  }

  // Start and stop differ only in wording and in which pending flag they hold,
  // so they share one request path — which is also how they get the request
  // timeout every other call on this page already has.
  async function runScanAction({
    action,
    buttonId,
    url,
    stopRequested,
    success,
    successTone,
    failure,
  }) {
    const button = byId(buttonId);
    if (!button || button.disabled) return;

    pending[action] = true;
    setScanButtons(true, stopRequested);
    try {
      await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      toast(success, { tone: successTone });
    } catch (error) {
      console.error(`[dashboard] ${action} failed`, error);
      toast(failure, { tone: 'danger' });
    } finally {
      pending[action] = false;
      pollStatus();
    }
  }

  byId('scanButton')?.addEventListener('click', () =>
    runScanAction({
      action: 'scan',
      buttonId: 'scanButton',
      url: '/api/scan/now',
      stopRequested: false,
      success: 'Scan started',
      successTone: 'ok',
      failure: 'Scan could not be started',
    })
  );

  byId('stopScanButton')?.addEventListener('click', () =>
    runScanAction({
      action: 'stop',
      buttonId: 'stopScanButton',
      url: '/api/scan/stop',
      stopRequested: true,
      success: 'Stop requested — the current document is finished first',
      successTone: 'info',
      failure: 'Stop request failed',
    })
  );

  /* --- entity details dialog -------------------------------------------- */

  const modal = byId('detailsModal');

  async function showEntities(title, url) {
    if (!modal) return;
    setText('detailsModalTitle', title);
    const body = byId('detailsModalBody');
    body.innerHTML =
      '<div class="zr-row"><span class="zr-spinner"></span><span>Loading…</span></div>';
    modal.showModal();

    try {
      const items = await fetchJson(url);
      const rows = Array.isArray(items) ? items : [];
      body.innerHTML = rows.length
        ? `<div class="zr-list">${rows
            .map(
              (item) => `
                <div class="zr-list__item">
                  <span class="zr-list__main"><span class="zr-list__title">${escapeHtml(item.name)}</span></span>
                  <span class="zr-list__time">${formatDocumentCount(item.document_count)}</span>
                </div>`
            )
            .join('')}</div>`
        : '<p class="zr-sm zr-faint">Nothing to show.</p>';
    } catch (error) {
      console.error('[dashboard] entity list failed', error);
      body.innerHTML =
        '<p class="zr-sm zr-danger-text">Could not load the list.</p>';
    }
  }

  byId('showTagDetails')?.addEventListener('click', () =>
    showEntities('Tags', '/api/tagsCount')
  );
  byId('showCorrespondentDetails')?.addEventListener('click', () =>
    showEntities('Correspondents', '/api/correspondentsCount')
  );
  byId('detailsModalClose')?.addEventListener('click', () => modal?.close());

  /* --- start ------------------------------------------------------------- */

  loadStats();
  pollStatus();
  const statusTimer = setInterval(pollStatus, STATUS_INTERVAL_MS);

  return {
    destroy() {
      clearInterval(statusTimer);
      syncScanTick(false);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
