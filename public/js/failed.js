// public/js/failed.js – Permanently Failed queue frontend logic

(function () {
  'use strict';

  let currentPage = 0;
  const pageSize = 25;
  let totalRecords = 0;
  let paperlessUrl = '';

  const tableBody = document.getElementById('failedTableBody');
  const tableInfo = document.getElementById('failedTableInfo');
  const resetAllBtn = document.getElementById('failedResetAllBtn');
  const prevBtn = document.getElementById('failedPrevPageBtn');
  const nextBtn = document.getElementById('failedNextPageBtn');
  let resetAllInProgress = false;

  document.addEventListener('DOMContentLoaded', function () {
    loadQueue();

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

    if (resetAllBtn) {
      resetAllBtn.addEventListener('click', function () {
        resetAllFailedDocuments();
      });
    }
  });

  async function loadQueue() {
    if (!tableBody) return;
    tableBody.innerHTML = `<tr><td colspan="6" class="zr-empty"><svg class="zr-icon zr-icon--sm zr-icon--spin" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg> Loading…</td></tr>`;

    try {
      const params = new URLSearchParams({
        start: currentPage * pageSize,
        length: pageSize,
        search: '',
      });

      const resp = await fetch(`/api/failed/queue?${params}`);
      const data = await resp.json();
      if (!data.success)
        throw new Error(
          data.error || 'Failed to load permanently failed queue'
        );

      totalRecords = data.recordsTotal || 0;
      paperlessUrl = data.paperlessUrl || '';
      renderTable(data.data || []);
      updatePagination();
    } catch (err) {
      tableBody.innerHTML = `<tr><td colspan="6" class="zr-empty zr-danger-text"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg>${escHtml(err.message)}</td></tr>`;
    }
  }

  function renderTable(items) {
    if (!items.length) {
      tableBody.innerHTML = `<tr><td colspan="6" class="zr-empty"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-check-circle"/></svg>No permanently failed documents</td></tr>`;
      return;
    }

    tableBody.innerHTML = items
      .map((item) => {
        const docLink = paperlessUrl
          ? `<a href="${paperlessUrl}/documents/${item.document_id}/details" target="_blank" class="zr-link zr-mono">#${item.document_id}</a>`
          : `<span class="zr-mono">#${item.document_id}</span>`;

        const reasonLabel = formatFailedReason(item.failed_reason);
        const sourceLabel = formatFailedSource(item.source);
        // Date only; the full timestamp stays reachable through the cell title.
        const updated = window.zrDate.format(item.updated_at, {
          fallback: '–',
        });
        const updatedTitle = escHtml(
          window.zrDate.formatDateTime(item.updated_at)
        );

        // data-label carries the column name into the stacked phone layout,
        // where the header row is hidden.
        return `<tr>
                <td data-label="Doc ID">${docLink}</td>
                <td data-label="Title" class="zr-truncate" title="${escHtml(item.title || '')}">${escHtml(item.title || '–')}</td>
                <td data-label="Reason"><span class="zr-badge">${reasonLabel}</span></td>
                <td data-label="Source" class="zr-sm">${sourceLabel}</td>
                <td data-label="Updated" class="zr-sm zr-faint zr-table__date" title="${updatedTitle}">${updated}</td>
                <td data-label="" class="zr-table__actions"><div class="zr-row">
                    <button class="zr-btn failed-reset-btn" data-id="${item.document_id}" title="Reset failed state and allow re-scan">
                        <svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-undo"/></svg> Reset
                    </button>
                    <!-- Labelled and bordered, matching the history row: as a
                         ghost icon button the "…" read as decoration and
                         nothing said it opened a menu. -->
                    <button type="button" class="zr-btn" popovertarget="failedRowMenu${item.document_id}" title="More actions" aria-haspopup="menu">
                        <span>Actions</span>
                        <svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-chevron-down"/></svg>
                    </button>
                    <div id="failedRowMenu${item.document_id}" popover class="zr-menu">
                        <button type="button" class="zr-menu__item failed-ignore-btn" data-id="${item.document_id}">
                            <svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-eye-off"/></svg>Ignore permanently
                        </button>
                    </div>
                </div></td>
            </tr>`;
      })
      .join('');

    tableBody.querySelectorAll('.failed-reset-btn').forEach((btn) => {
      btn.addEventListener('click', function () {
        resetFailedDocument(parseInt(this.dataset.id, 10));
      });
    });

    tableBody.querySelectorAll('.failed-ignore-btn').forEach((btn) => {
      btn.addEventListener('click', function () {
        ignoreFailedDocument(parseInt(this.dataset.id, 10));
      });
    });
  }

  function formatFailedReason(reason) {
    const map = {
      ocr_failed:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-eye-off"/></svg>OCR failed',
      ai_failed_after_ocr:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-cpu"/></svg>AI failed after OCR',
      ai_failed_ocr_disabled:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-power"/></svg>AI failed (OCR disabled)',
      ai_failed_without_ocr_fallback:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg>AI failed (no OCR fallback)',
      // The scan gave up after three failed analyses in a row.
      ai_failed_retry_limit:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg>AI failed 3 times (retry limit)',
      insufficient_content_lt_10:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-eye-off"/></svg>Insufficient content (&lt; 10 chars)',
      ai_response_truncated:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-cpu"/></svg>AI answer cut off (token limit)',
      // A Claude model declined the request (stop_reason "refusal").
      ai_refused:
        '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-ban"/></svg>Declined by the AI model',
    };

    if (map[reason]) return map[reason];
    if (reason && reason.startsWith('insufficient_content_lt_')) {
      const threshold = reason.replace('insufficient_content_lt_', '');
      if (/^\d+$/.test(threshold)) {
        return `<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-eye-off"/></svg>Insufficient content (&lt; ${threshold} chars)`;
      }
    }
    return escHtml(reason || 'unknown_failure');
  }

  function formatFailedSource(source) {
    if (source === 'ocr') return '<span class="zr-warn-text">OCR</span>';
    if (source === 'ai') return '<span class="zr-link">AI</span>';
    return escHtml(source || 'unknown');
  }

  async function resetFailedDocument(documentId) {
    try {
      const resp = await fetch(`/api/failed/reset/${documentId}`, {
        method: 'POST',
      });
      const data = await resp.json();

      if (data.success) {
        showToast(data.message || 'Document reset successfully');
      } else {
        showToast(data.message || data.error || 'Reset failed', 'error');
      }
      loadQueue();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function ignoreFailedDocument(documentId) {
    try {
      const resp = await fetch(`/api/failed/ignore/${documentId}`, {
        method: 'POST',
      });
      const data = await resp.json();

      if (data.success) {
        showToast(data.message || 'Document moved to ignored list');
      } else {
        showToast(data.message || data.error || 'Ignore failed', 'error');
      }
      loadQueue();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function resetAllFailedDocuments() {
    if (resetAllInProgress || totalRecords === 0) return;

    const confirmed = window.confirm(
      `Reset all ${totalRecords} permanently failed document${totalRecords === 1 ? '' : 's'}?`
    );
    if (!confirmed) return;

    try {
      resetAllInProgress = true;
      if (resetAllBtn) resetAllBtn.disabled = true;

      const resp = await fetch('/api/failed/reset-all', { method: 'POST' });
      const data = await resp.json();

      if (!resp.ok || !data.success) {
        throw new Error(data.error || data.message || 'Reset all failed');
      }

      showToast(data.message || 'All failed documents reset successfully');
      currentPage = 0;
      await loadQueue();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      resetAllInProgress = false;
      updatePagination();
    }
  }

  function updatePagination() {
    const start = currentPage * pageSize + 1;
    const end = Math.min((currentPage + 1) * pageSize, totalRecords);

    if (tableInfo) {
      tableInfo.textContent = totalRecords
        ? `Showing ${start}–${end} of ${totalRecords}`
        : 'No results';
    }

    if (resetAllBtn)
      resetAllBtn.disabled = resetAllInProgress || totalRecords === 0;
    if (prevBtn) prevBtn.disabled = currentPage === 0;
    if (nextBtn) nextBtn.disabled = totalRecords === 0 || end >= totalRecords;
  }

  // Adapter only: the toast DOM lives in the module kernel (public/js/zr.js).
  // This classic script runs before that module, so the lookup is deferred to
  // call time — toasts only fire on user interaction, never during load.
  function showToast(message, type = 'success') {
    if (typeof window.__zrToast !== 'function') return null;
    return window.__zrToast(message, {
      tone: type === 'error' ? 'danger' : 'ok',
    });
  }

  function escHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }
})();
