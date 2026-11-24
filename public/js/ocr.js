// public/js/ocr.js – OCR Queue frontend logic

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  let currentPage = 0;
  const pageSize = 25;
  let totalRecords = 0;
  let paperlessUrl = '';
  let currentSearch = '';
  let currentStatus = '';
  let loadTimeout = null;
  let manualDocumentOmnibox = null;
  let queuedDocIds = new Set();
  // Whether Paperless-ngx can remove PDF passwords and what is stored; the
  // unlock actions follow it. Starts closed until the status has loaded.
  let unlockStatus = { supported: false, storedPasswords: 0, locked: 0 };

  // ── DOM refs ───────────────────────────────────────────────────────────
  const tableBody = document.getElementById('ocrTableBody');
  const tableInfo = document.getElementById('tableInfo');
  const prevBtn = document.getElementById('prevPageBtn');
  const nextBtn = document.getElementById('nextPageBtn');
  const statusFilter = document.getElementById('statusFilter');
  const manualDocId = document.getElementById('manualDocId');
  const manualDocSearchInput = document.getElementById('manualDocSearchInput');
  // #manualDocSearchResults and #manualDocSearchStatus are resolved by the
  // omnibox itself via the IDs passed to createDocumentOmnibox().
  const processAllBtn = document.getElementById('processAllBtn');
  const unlockAllBtn = document.getElementById('unlockAllBtn');
  const autoAnalyze = document.getElementById('autoAnalyzeToggle');

  // ── AI-analysis toggle ─────────────────────────────────────────────────
  /* The toggle decides whether the runs started on this page also analyze the
     document; each run sends its current state along. It is not the stored
     OCR_AUTO_ANALYZE setting, which the scheduled drain reads once at startup
     and which Settings owns — writing that from here would leave the schedule
     on the old value until a restart while manual runs already followed the
     new one.

     What it lacked was memory: nothing kept the choice, so leaving the page
     and coming back silently put it back on the configured default. It is
     remembered per browser now, the same way the theme is. Storage can be
     unavailable (private windows, blocked site data), and a toggle is not
     worth failing the page over, so both sides are guarded. */
  const AUTO_ANALYZE_STORAGE_KEY = 'zr.ocr.autoAnalyze';

  function readStoredAutoAnalyze() {
    try {
      const stored = window.localStorage.getItem(AUTO_ANALYZE_STORAGE_KEY);
      if (stored === 'yes') return true;
      if (stored === 'no') return false;
    } catch {
      // No stored preference available; the server-rendered default stands.
    }
    return null;
  }

  function initializeAutoAnalyzeToggle() {
    if (!autoAnalyze) return;

    const stored = readStoredAutoAnalyze();
    if (stored !== null) {
      autoAnalyze.checked = stored;
    }

    autoAnalyze.addEventListener('change', function () {
      try {
        window.localStorage.setItem(
          AUTO_ANALYZE_STORAGE_KEY,
          this.checked ? 'yes' : 'no'
        );
      } catch {
        // Nothing to do: the toggle still governs the run being started.
      }
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    const urlParams = new URLSearchParams(window.location.search);
    const initialStatus = (urlParams.get('status') || '').trim();
    if (
      initialStatus &&
      ['pending', 'processing', 'done', 'failed'].includes(initialStatus)
    ) {
      currentStatus = initialStatus;
      if (statusFilter) statusFilter.value = initialStatus;
    }

    // The result filter reads queuedDocIds lazily, so the search must not wait
    // for that request - a stalled fetch would leave the search box dead.
    initializeAutoAnalyzeToggle();
    initializeManualDocumentSearch();
    initializeSearchModeToggles();
    refreshQueuedIds();
    loadUnlockStatus().then(loadQueue);
    loadStats();

    if (statusFilter)
      statusFilter.addEventListener('change', function () {
        currentStatus = this.value;
        currentPage = 0;
        loadQueue();
      });

    if (processAllBtn) processAllBtn.addEventListener('click', processAll);
    if (unlockAllBtn) unlockAllBtn.addEventListener('click', unlockAll);
    if (prevBtn)
      prevBtn.addEventListener('click', function () {
        if (currentPage > 0) {
          currentPage--;
          loadQueue();
        }
      });
    if (nextBtn)
      nextBtn.addEventListener('click', function () {
        const maxPage = Math.ceil(totalRecords / pageSize) - 1;
        if (currentPage < maxPage) {
          currentPage++;
          loadQueue();
        }
      });
  });

  // ── Load queue ─────────────────────────────────────────────────────────
  function loadQueue() {
    clearTimeout(loadTimeout);
    loadTimeout = setTimeout(_doLoad, 100);
  }

  async function _doLoad() {
    if (!tableBody) return;
    tableBody.innerHTML = `<tr><td colspan="6" class="zr-empty"><svg class="zr-icon zr-icon--sm zr-icon--spin" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg> Loading…</td></tr>`;

    try {
      const params = new URLSearchParams({
        start: currentPage * pageSize,
        length: pageSize,
        search: currentSearch,
        status: currentStatus,
      });
      const resp = await fetch(`/api/ocr/queue?${params}`);
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      paperlessUrl = data.paperlessUrl || '';
      totalRecords = data.recordsTotal || 0;
      renderTable(data.data || []);
      updatePagination();
    } catch (err) {
      tableBody.innerHTML = `<tr><td colspan="6" class="zr-empty zr-danger-text"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg>${escHtml(err.message)}</td></tr>`;
    }
  }

  // ── Render table ───────────────────────────────────────────────────────
  function formatReasonLabel(reason) {
    if (!reason) {
      return '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-help"/></svg>Unknown';
    }

    const reasonMap = {
      short_content:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-eye-off"/></svg>Content too short',
      short_content_lt_10:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-eye-off"/></svg>Content too short (&lt; 10 chars)',
      ai_failed:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-cpu"/></svg>AI analysis failed',
      ai_insufficient_content:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-cpu"/></svg>AI: insufficient content',
      ai_invalid_json:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-code"/></svg>AI: invalid JSON response',
      ai_invalid_response_structure:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-layers"/></svg>AI: no tags/correspondent found',
      ai_invalid_api_response_structure:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-server"/></svg>AI: invalid API response structure',
      ai_failed_unknown:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg>AI failed (unknown)',
      manual:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-user"/></svg>Manual',
      ocr_before_ai:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-scan"/></svg>OCR before analysis',
    };

    if (reasonMap[reason]) {
      return reasonMap[reason];
    }

    if (reason.startsWith('short_content_lt_')) {
      const threshold = reason.replace('short_content_lt_', '');
      if (/^\d+$/.test(threshold)) {
        return `<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-eye-off"/></svg>Content too short (&lt; ${threshold} chars)`;
      }
    }

    return escHtml(reason);
  }

  function renderTable(items) {
    if (!items.length) {
      tableBody.innerHTML = `<tr><td colspan="6" class="zr-empty"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-inbox"/></svg>Queue is empty</td></tr>`;
      return;
    }

    tableBody.innerHTML = items
      .map((item) => {
        const docLink = paperlessUrl
          ? `<a href="${paperlessUrl}/documents/${item.document_id}/details" target="_blank" class="zr-link zr-mono">#${item.document_id}</a>`
          : `<span class="zr-mono">#${item.document_id}</span>`;

        const reasonLabel = formatReasonLabel(item.reason);

        // A finished item whose text Paperless-ngx accepted is removed from the
        // queue, so a 'done' row that is still listed is one whose text exists
        // nowhere else. A plain green "done" would read as "nothing to see
        // here", which is the opposite of what that row means.
        const localOnly = item.status === 'done' && item.wrote_back === 0;
        // A PDF that needs a password failed for a reason a retry cannot
        // fix, so the row says that instead of a plain "failed".
        const locked =
          item.status === 'failed' && Number(item.password_protected) === 1;
        let statusHtml;
        if (localOnly) {
          statusHtml = `<span class="zr-badge zr-badge--warn" title="Paperless-ngx did not accept the content. The OCR text exists only in this queue entry."><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg> not written back</span>`;
        } else if (locked) {
          statusHtml = `<span class="zr-badge zr-badge--warn" title="OCR cannot read this PDF until its password is removed."><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-key"/></svg> password protected</span>`;
        } else {
          statusHtml = `<span class="zr-badge ${statusTone(item.status)}">${statusIcon(item.status)} ${escHtml(item.status)}</span>`;
        }

        // Date only: the exact second added nothing and its width forced the
        // table to scroll sideways on ordinary desktop windows. The full
        // timestamp stays reachable through the cell title.
        const addedDate = window.zrDate.format(item.added_at, {
          fallback: '–',
        });
        const addedTitle = escHtml(window.zrDate.formatDateTime(item.added_at));

        // One labelled action per row, everything else behind the "…" — which
        // state a row is in decides what that primary action is, so the column
        // keeps the same two slots throughout.
        const hasOcrText = !!(item.ocr_text && String(item.ocr_text).trim());
        const canProcess =
          item.status === 'pending' || item.status === 'failed';
        // A row that failed at the AI step still carries the OCR text it paid
        // for, and analysing it again costs one AI call. Tying this to 'done'
        // alone left such a row with "Process" as its only offer, which runs
        // the whole pipeline and buys the same text from the OCR provider a
        // second time.
        const canAnalyze =
          hasOcrText && (item.status === 'done' || item.status === 'failed');

        // Analyze wins the primary slot wherever both apply: it is the cheaper
        // of the two and the one that moves the document forward. Re-running
        // OCR stays reachable in the menu.
        // A locked PDF is unlocked first: OCR would only fail on it again.
        const canUnlock = locked && unlockStatus.supported;
        let primaryBtn = '';
        if (canUnlock) {
          primaryBtn = `<button class="zr-btn unlock-btn" data-id="${item.document_id}" title="Enter the password of this PDF"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-key"/></svg> Unlock</button>`;
        } else if (locked) {
          primaryBtn = `<span class="zr-xs zr-faint" title="Removing PDF passwords needs Paperless-ngx 3.0 or later${unlockStatus.paperlessVersion ? `; this one is ${escHtml(unlockStatus.paperlessVersion)}` : ''}.">Needs Paperless-ngx 3.0</span>`;
        } else if (canAnalyze) {
          primaryBtn = `<button class="zr-btn analyze-btn" data-id="${item.document_id}" title="Start AI analysis using existing OCR text"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-cpu"/></svg> Analyze</button>`;
        } else if (canProcess) {
          primaryBtn = `<button class="zr-btn process-btn" data-id="${item.document_id}" title="Send to OCR provider"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-play"/></svg> Process</button>`;
        }

        const menuId = `ocrRowMenu${item.document_id}`;
        const menuItems = [
          `<a class="zr-menu__item" href="/manual?id=${item.document_id}&list=${locked ? 'locked' : 'ocr'}"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-file"/></svg>Open in Manual</a>`,
          canUnlock && unlockStatus.storedPasswords
            ? `<button type="button" class="zr-menu__item unlock-stored-btn" data-id="${item.document_id}"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-key"/></svg>Try stored passwords</button>`
            : '',
          locked
            ? `<button type="button" class="zr-menu__item process-btn" data-id="${item.document_id}" title="Run OCR again, for a document unlocked in Paperless-ngx by hand"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-play"/></svg>Run OCR again</button>`
            : '',
          canProcess && canAnalyze
            ? `<button type="button" class="zr-menu__item process-btn" data-id="${item.document_id}" title="Discard the stored text and run the OCR provider again"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-play"/></svg>Run OCR again</button>`
            : '',
          hasOcrText
            ? `<button type="button" class="zr-menu__item info-btn" data-id="${item.document_id}"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-info"/></svg>Show OCR output</button>`
            : '',
          item.status !== 'processing'
            ? `<button type="button" class="zr-menu__item zr-menu__item--danger remove-btn" data-id="${item.document_id}"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-trash"/></svg>Remove from queue</button>`
            : '',
        ]
          .filter(Boolean)
          .join('');

        // Labelled and bordered, matching the history row: as a ghost icon
        // button the "…" read as decoration and nothing said it opened a menu.
        const menu = menuItems
          ? `<button type="button" class="zr-btn" popovertarget="${menuId}" title="More actions" aria-haspopup="menu"><span>Actions</span><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-chevron-down"/></svg></button>
             <div id="${menuId}" popover class="zr-menu">${menuItems}</div>`
          : '';

        // data-label carries the column name into the stacked phone layout,
        // where the header row is hidden.
        return `<tr>
                <td data-label="Doc ID">${docLink}</td>
                <td data-label="Title" class="zr-truncate" title="${escHtml(item.title || '')}">${escHtml(item.title || '–')}</td>
                <td data-label="Reason"><span class="zr-badge">${reasonLabel}</span></td>
                <td data-label="Status">${statusHtml}</td>
                <td data-label="Added" class="zr-sm zr-faint zr-table__date" title="${addedTitle}">${addedDate}</td>
                <td data-label="" class="zr-table__actions">
                    <div class="zr-row">
                        ${primaryBtn}
                        ${menu}
                    </div>
                </td>
            </tr>`;
      })
      .join('');

    // Attach button handlers
    tableBody.querySelectorAll('.process-btn').forEach((btn) => {
      btn.addEventListener('click', function () {
        processSingle(parseInt(this.dataset.id, 10));
      });
    });
    tableBody.querySelectorAll('.unlock-btn').forEach((btn) => {
      btn.addEventListener('click', function () {
        unlockSingle(parseInt(this.dataset.id, 10));
      });
    });
    tableBody.querySelectorAll('.unlock-stored-btn').forEach((btn) => {
      btn.addEventListener('click', function () {
        unlockRequest(parseInt(this.dataset.id, 10));
      });
    });
    tableBody.querySelectorAll('.analyze-btn').forEach((btn) => {
      btn.addEventListener('click', function () {
        analyzeSingle(parseInt(this.dataset.id, 10));
      });
    });
    tableBody.querySelectorAll('.info-btn').forEach((btn) => {
      btn.addEventListener('click', function () {
        showOcrInfo(parseInt(this.dataset.id, 10));
      });
    });
    tableBody.querySelectorAll('.remove-btn').forEach((btn) => {
      btn.addEventListener('click', function () {
        removeItem(parseInt(this.dataset.id, 10));
      });
    });
  }

  // Queue states map onto the framework badge tones rather than a second set of
  // status colours that would not follow the theme.
  function statusTone(status) {
    return (
      {
        pending: 'zr-badge--warn',
        processing: 'zr-badge--info',
        done: 'zr-badge--ok',
        failed: 'zr-badge--danger',
      }[status] || ''
    );
  }

  function statusIcon(status) {
    return (
      {
        pending:
          '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-clock"/></svg>',
        processing:
          '<svg class="zr-icon zr-icon--sm zr-icon--spin" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg>',
        done: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-check"/></svg>',
        failed:
          '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-x"/></svg>',
      }[status] || ''
    );
  }

  // ── Pagination ─────────────────────────────────────────────────────────
  function updatePagination() {
    const start = currentPage * pageSize + 1;
    const end = Math.min((currentPage + 1) * pageSize, totalRecords);
    if (tableInfo)
      tableInfo.textContent = totalRecords
        ? `Showing ${start}–${end} of ${totalRecords}`
        : 'No results';
    if (prevBtn) prevBtn.disabled = currentPage === 0;
    if (nextBtn) nextBtn.disabled = totalRecords === 0 || end >= totalRecords;
  }

  // ── Stats ──────────────────────────────────────────────────────────────
  async function loadStats() {
    try {
      const resp = await fetch('/api/ocr/stats');
      const data = await resp.json();
      if (!data.success) return;
      const s = data.stats;
      setStatCount('statPendingCount', s.pending);
      setStatCount('statDoneCount', s.done);
      setStatCount('statFailedCount', s.failed);
      setStatCount('statNotWrittenBackCount', s.notWrittenBack);
      const notWrittenBack = document.getElementById('statNotWrittenBack');
      if (notWrittenBack) {
        notWrittenBack.classList.toggle('hidden', !s.notWrittenBack);
      }
    } catch (error) {
      // Stats are decorative; keep the queue view usable if they fail to load.
      console.warn('Could not load OCR stats:', error);
    }
  }

  // ── Password-protected PDFs ────────────────────────────────────────────
  async function loadUnlockStatus() {
    try {
      const resp = await fetch('/api/ocr/unlock/status');
      const data = await resp.json();
      if (data.success && data.data) unlockStatus = data.data;
    } catch (error) {
      // Without the status the unlock actions stay hidden; the queue works.
      console.warn('Could not load the unlock status:', error);
    }
    renderUnlockControls();
  }

  function renderUnlockControls() {
    const { supported, storedPasswords, locked } = unlockStatus;
    setStatCount('statLockedCount', locked);
    const badge = document.getElementById('statLocked');
    if (badge) badge.classList.toggle('hidden', !locked);
    if (!unlockAllBtn) return;
    unlockAllBtn.classList.toggle('hidden', !locked || !supported);
    unlockAllBtn.disabled = !storedPasswords;
    unlockAllBtn.title = storedPasswords
      ? `Try the ${storedPasswords} password(s) stored in Settings on every password-protected document`
      : 'No passwords stored. Add them under Settings → OCR → PDF passwords.';
  }

  async function unlockSingle(documentId) {
    if (typeof window.zrDialog !== 'function') return;
    const answer = await window.zrDialog({
      title: `Unlock document #${documentId}`,
      text: 'Enter the password of this PDF. Paperless-ngx removes it and keeps the unlocked file as a new version of the document.',
      input: 'password',
      inputPlaceholder: unlockStatus.storedPasswords
        ? 'Password (empty: try the stored ones)'
        : 'Password',
      showCancelButton: true,
      confirmButtonText: 'Unlock',
    });
    if (!answer.isConfirmed) return;
    const password = String(answer.value || '');
    if (!password && !unlockStatus.storedPasswords) {
      showToast('Enter a password.', 'error');
      return;
    }
    await unlockRequest(documentId, password);
  }

  async function unlockRequest(documentId, password) {
    try {
      const resp = await fetch(`/api/ocr/unlock/${documentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(password ? { password } : {}),
      });
      const data = await resp.json();
      showToast(
        data.success ? data.message : data.error || 'Unlocking failed',
        data.success ? 'success' : 'error'
      );
      if (data.success) queuedDocIds.delete(documentId);
    } catch (err) {
      showToast(err.message, 'error');
    }
    await loadUnlockStatus();
    loadQueue();
    loadStats();
  }

  function unlockAll() {
    progress().run({
      url: '/api/ocr/unlock-all',
      body: {},
      title: 'Unlocking Password-Protected Documents…',
      onDone: refreshAfterRun,
    });
  }

  function setStatCount(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val ?? '0';
  }

  async function refreshQueuedIds() {
    try {
      const resp = await fetch('/api/ocr/queue/ids');
      const payload = await resp.json();
      const ids = payload && payload.data ? payload.data.ids : null;
      if (payload && payload.success && Array.isArray(ids)) {
        queuedDocIds = new Set(ids.map(Number));
      }
    } catch (error) {
      // Non-fatal: without the list, already queued documents simply stay
      // visible in the search results.
      console.warn('Could not load queued document IDs:', error);
    }
  }

  async function addToQueueDirect(docId) {
    if (!docId || queuedDocIds.has(Number(docId))) return;
    try {
      const resp = await fetch('/api/ocr/queue/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: Number(docId) }),
      });
      const data = await resp.json();
      if (data.success) {
        showToast(data.message || 'Added to queue');
        queuedDocIds.add(Number(docId));
        loadQueue();
        loadStats();
      } else {
        showToast(data.message || data.error || 'Failed', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function initializeManualDocumentSearch() {
    if (!manualDocSearchInput || !manualDocId) return;

    manualDocumentOmnibox = window.createDocumentOmnibox({
      preset: 'ocr',
      inputId: 'manualDocSearchInput',
      resultsId: 'manualDocSearchResults',
      statusId: 'manualDocSearchStatus',
      hiddenInputId: 'manualDocId',
      limit: 100,
      debounceMs: 250,
      multiSelect: true,
      resultItemClass: 'manual-search-item',
      resultTitleClass: 'manual-search-title',
      resultMetaClass: 'manual-search-meta',
      resultPillClass: 'manual-search-pill',
      filterResults: (documents) =>
        documents.filter((doc) => !queuedDocIds.has(doc.id)),
      onSelect: (doc) => {
        addToQueueDirect(doc.id);
      },
      onEnterAfterSelect: () => {},
    });
  }

  // The placeholder carries the whole scope hint; the status line below is
  // reserved for live feedback (searching, errors, selection) and stays empty
  // while idle instead of paraphrasing the placeholder.
  const SEARCH_MODE_HINTS = {
    all: { placeholder: 'Search documents...' },
    id: { placeholder: 'Enter a numeric document ID…' },
    title: { placeholder: 'Search by title...' },
    tags: { placeholder: 'Search by tag name...' },
    correspondent: { placeholder: 'Search by correspondent...' },
  };

  function applySearchModeHint(mode) {
    const hint = SEARCH_MODE_HINTS[mode] || SEARCH_MODE_HINTS.all;
    if (manualDocSearchInput) {
      manualDocSearchInput.placeholder = hint.placeholder;
    }
    if (
      manualDocumentOmnibox &&
      typeof manualDocumentOmnibox.setStatus === 'function'
    ) {
      const hasQuery =
        manualDocSearchInput && manualDocSearchInput.value.trim();
      // Only clear the idle status; keep live search results status intact.
      if (!hasQuery) {
        manualDocumentOmnibox.setStatus('', false);
      }
    }
  }

  // The search scope used to be a row of pills below the field; it is a select
  // in front of it now, so the toolbar stays one line high.
  function initializeSearchModeToggles() {
    const select = document.getElementById('searchModeSelect');
    if (!select || !manualDocumentOmnibox) return;

    applySearchModeHint('all');

    select.addEventListener('change', function () {
      const mode = this.value || 'all';
      manualDocumentOmnibox.setSearchMode(mode);
      applySearchModeHint(mode);
      const currentValue = manualDocSearchInput
        ? manualDocSearchInput.value.trim()
        : '';
      if (currentValue) {
        manualDocumentOmnibox.load(currentValue, { showResults: true });
      }
    });
  }

  // ── Remove item ────────────────────────────────────────────────────────
  async function removeItem(documentId) {
    try {
      const resp = await fetch(`/api/ocr/queue/${documentId}`, {
        method: 'DELETE',
      });
      const data = await resp.json();
      showToast(
        data.success ? 'Removed from queue' : data.message || 'Failed',
        data.success ? 'success' : 'error'
      );
      if (data.success) queuedDocIds.delete(documentId);
      loadQueue();
      loadStats();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // The overlay and the SSE reader live in /js/ocr-progress.js, which the
  // history page drives as well.
  const progress = () => window.zrOcrProgress;

  // A run can find a locked PDF, so the unlock status is read again before
  // the rows are drawn.
  const refreshAfterRun = (done) => {
    if (done) {
      loadUnlockStatus().then(loadQueue);
      loadStats();
    }
  };

  // ── Process single ─────────────────────────────────────────────────────
  function processSingle(documentId) {
    progress().run({
      url: `/api/ocr/process/${documentId}`,
      body: { autoAnalyze: autoAnalyze ? autoAnalyze.checked : false },
      title: `Processing Document #${documentId}…`,
      onDone: refreshAfterRun,
    });
  }

  // ── Process all ────────────────────────────────────────────────────────
  function processAll() {
    progress().run({
      url: '/api/ocr/process-all',
      body: { autoAnalyze: autoAnalyze ? autoAnalyze.checked : false },
      title: 'Processing All Pending Items…',
      onDone: refreshAfterRun,
    });
  }

  // ── AI only (existing OCR text) ───────────────────────────────────────
  function analyzeSingle(documentId) {
    progress().run({
      url: `/api/ocr/analyze/${documentId}`,
      title: `AI Analysis for Document #${documentId}…`,
      onDone: refreshAfterRun,
    });
  }

  // ── OCR output info ───────────────────────────────────────────────────
  async function showOcrInfo(documentId) {
    const { open, setProgress, appendLog, finalize } = progress();
    open(`OCR Output for Document #${documentId}`);
    setProgress(100);
    try {
      const resp = await fetch(`/api/ocr/queue/${documentId}/text`);
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || 'Could not load OCR output');
      }

      if (!data.hasOcrText) {
        appendLog('error', 'No OCR text available for this document.');
        finalize(true);
        return;
      }

      const infoHeader = `Status: ${data.status || 'unknown'} | Reason: ${data.reason || 'unknown'}`;
      appendLog('done', infoHeader);
      appendLog('progress', '────────────────────────────────────────');

      const text = String(data.ocrText || '');
      const preview =
        text.length > 12000
          ? `${text.slice(0, 12000)}\n\n[... truncated ...]`
          : text;
      appendLog('progress', preview);
      finalize();
    } catch (error) {
      appendLog('error', error.message);
      finalize(true);
    }
  }

  // ── Toast ──────────────────────────────────────────────────────────────
  // Adapter only: the toast DOM lives in the module kernel (public/js/zr.js).
  // This classic script runs before that module, so the lookup is deferred to
  // call time — toasts only fire on user interaction, never during load.
  function showToast(message, type = 'success') {
    if (typeof window.__zrToast !== 'function') return null;
    return window.__zrToast(message, {
      tone: type === 'error' ? 'danger' : 'ok',
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  function escHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }
})();
