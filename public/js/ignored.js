// public/js/ignored.js – Ignored documents queue frontend logic

(function () {
  'use strict';

  let currentPage = 0;
  const pageSize = 25;
  let totalRecords = 0;
  let paperlessUrl = '';

  const tableBody = document.getElementById('ignoredTableBody');
  const tableInfo = document.getElementById('ignoredTableInfo');
  const clearAllBtn = document.getElementById('ignoredClearAllBtn');
  const prevBtn = document.getElementById('ignoredPrevPageBtn');
  const nextBtn = document.getElementById('ignoredNextPageBtn');
  const addBtn = document.getElementById('ignoreAddBtn');
  const docIdInput = document.getElementById('ignoreDocIdInput');
  const reasonInput = document.getElementById('ignoreReasonInput');
  let clearAllInProgress = false;

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

    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', function () {
        clearAllIgnoredDocuments();
      });
    }

    if (addBtn) {
      addBtn.addEventListener('click', function () {
        addIgnoredDocument();
      });
    }

    if (docIdInput) {
      docIdInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') addIgnoredDocument();
      });
    }
  });

  async function loadQueue() {
    if (!tableBody) return;
    tableBody.innerHTML = `<tr><td colspan="5" class="zr-empty"><svg class="zr-icon zr-icon--sm zr-icon--spin" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg> Loading…</td></tr>`;

    try {
      const params = new URLSearchParams({
        start: currentPage * pageSize,
        length: pageSize,
        search: '',
      });

      const resp = await fetch(`/api/ignored/queue?${params}`);
      const data = await resp.json();
      if (!data.success)
        throw new Error(data.error || 'Failed to load ignored documents');

      totalRecords = data.recordsTotal || 0;
      paperlessUrl = data.paperlessUrl || '';
      renderTable(data.data || []);
      updatePagination();
    } catch (err) {
      tableBody.innerHTML = `<tr><td colspan="5" class="zr-empty zr-danger-text"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg>${escHtml(err.message)}</td></tr>`;
    }
  }

  function renderTable(items) {
    if (!items.length) {
      tableBody.innerHTML = `<tr><td colspan="5" class="zr-empty"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-check-circle"/></svg>No ignored documents</td></tr>`;
      return;
    }

    tableBody.innerHTML = items
      .map((item) => {
        const docLink = paperlessUrl
          ? `<a href="${paperlessUrl}/documents/${item.document_id}/details" target="_blank" class="zr-link zr-mono">#${item.document_id}</a>`
          : `<span class="zr-mono">#${item.document_id}</span>`;

        // Date only; the full timestamp stays reachable through the cell title.
        const added = window.zrDate.format(item.created_at, { fallback: '–' });
        const addedTitle = escHtml(
          window.zrDate.formatDateTime(item.created_at)
        );

        // data-label carries the column name into the stacked phone layout,
        // where the header row is hidden.
        return `<tr>
                <td data-label="Doc ID">${docLink}</td>
                <td data-label="Title" class="zr-truncate" title="${escHtml(item.title || '')}">${escHtml(item.title || '–')}</td>
                <td data-label="Reason"><span class="zr-badge">${escHtml(item.reason || 'manual')}</span></td>
                <td data-label="Added" class="zr-sm zr-faint zr-table__date" title="${addedTitle}">${added}</td>
                <td data-label="" class="zr-table__actions">
                    <div class="zr-row">
                        <a class="zr-btn zr-btn--ghost" href="/manual?id=${item.document_id}&list=ignored" title="Open in Manual">
                            <svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-file"/></svg> Manual
                        </a>
                        <button class="zr-btn ignored-unignore-btn" data-id="${item.document_id}" title="Remove from ignore list and allow scanning again">
                            <svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-eye"/></svg> Unignore
                        </button>
                    </div>
                </td>
            </tr>`;
      })
      .join('');

    tableBody.querySelectorAll('.ignored-unignore-btn').forEach((btn) => {
      btn.addEventListener('click', function () {
        unignoreDocument(parseInt(this.dataset.id, 10));
      });
    });
  }

  async function addIgnoredDocument() {
    const docId = parseInt(docIdInput?.value || '', 10);
    if (isNaN(docId) || docId < 1) {
      showToast('Please enter a valid document ID', 'error');
      return;
    }

    const reason = (reasonInput?.value || '').trim() || 'manual';

    try {
      const resp = await fetch('/api/ignored/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: docId, title: '', reason }),
      });
      const data = await resp.json();

      if (data.success) {
        showToast(data.message || 'Document added to ignore list');
        if (docIdInput) docIdInput.value = '';
        if (reasonInput) reasonInput.value = '';
        currentPage = 0;
        await loadQueue();
      } else {
        showToast(data.error || 'Failed to add document', 'error');
      }
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function unignoreDocument(documentId) {
    try {
      const resp = await fetch(`/api/ignored/${documentId}`, {
        method: 'DELETE',
      });
      const data = await resp.json();

      if (data.success) {
        showToast(data.message || 'Document removed from ignore list');
      } else {
        showToast(data.message || data.error || 'Unignore failed', 'error');
      }
      await loadQueue();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function clearAllIgnoredDocuments() {
    if (clearAllInProgress || totalRecords === 0) return;

    const confirmed = window.confirm(
      `Remove all ${totalRecords} ignored document${totalRecords === 1 ? '' : 's'} from the ignore list?`
    );
    if (!confirmed) return;

    try {
      clearAllInProgress = true;
      if (clearAllBtn) clearAllBtn.disabled = true;

      const resp = await fetch('/api/ignored/clear-all', { method: 'POST' });
      const data = await resp.json();

      if (!resp.ok || !data.success) {
        throw new Error(data.error || data.message || 'Clear all failed');
      }

      showToast(data.message || 'All ignored documents removed');
      currentPage = 0;
      await loadQueue();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      clearAllInProgress = false;
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

    if (clearAllBtn)
      clearAllBtn.disabled = clearAllInProgress || totalRecords === 0;
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
