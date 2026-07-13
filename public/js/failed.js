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

        if (prevBtn) prevBtn.addEventListener('click', function () {
            if (currentPage > 0) {
                currentPage--;
                loadQueue();
            }
        });

        if (nextBtn) nextBtn.addEventListener('click', function () {
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
        tableBody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-gray-400"><i class="fas fa-spinner fa-spin mr-2"></i> Loading…</td></tr>`;

        try {
            const params = new URLSearchParams({
                start: currentPage * pageSize,
                length: pageSize,
                search: ''
            });

            const resp = await fetch(`/api/failed/queue?${params}`);
            const data = await resp.json();
            if (!data.success) throw new Error(data.error || 'Failed to load permanently failed queue');

            totalRecords = data.recordsTotal || 0;
            paperlessUrl = data.paperlessUrl || '';
            renderTable(data.data || []);
            updatePagination();
        } catch (err) {
            tableBody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-red-500"><i class="fas fa-exclamation-triangle mr-2"></i>${escHtml(err.message)}</td></tr>`;
        }
    }

    function renderTable(items) {
        if (!items.length) {
            tableBody.innerHTML = `<tr><td colspan="6" class="text-center py-10 text-gray-400"><i class="fas fa-check-circle text-2xl mb-2 block"></i>No permanently failed documents</td></tr>`;
            return;
        }

        tableBody.innerHTML = items.map(item => {
            const docLink = paperlessUrl
                ? `<a href="${paperlessUrl}/documents/${item.document_id}/details" target="_blank" class="text-blue-500 hover:underline font-mono">#${item.document_id}</a>`
                : `<span class="font-mono">#${item.document_id}</span>`;

            const reasonLabel = formatFailedReason(item.failed_reason);
            const sourceLabel = formatFailedSource(item.source);
            const updated = item.updated_at ? new Date(item.updated_at).toLocaleString() : '–';

            return `<tr class="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors border-b border-gray-100 dark:border-gray-700">
                <td class="py-3 px-4">${docLink}</td>
                <td class="py-3 px-4 max-w-xs truncate" title="${escHtml(item.title || '')}">${escHtml(item.title || '–')}</td>
                <td class="py-3 px-4"><span class="reason-badge">${reasonLabel}</span></td>
                <td class="py-3 px-4 text-sm">${sourceLabel}</td>
                <td class="py-3 px-4 text-sm text-gray-500 whitespace-nowrap">${updated}</td>
                <td class="py-3 px-4 flex gap-1 flex-wrap">
                    <button class="px-3 py-1 bg-amber-500 text-white rounded-lg text-xs hover:bg-amber-600 transition-colors failed-reset-btn" data-id="${item.document_id}" title="Reset failed state and allow re-scan">
                        <i class="fas fa-rotate-left"></i> Reset
                    </button>
                    <button class="px-3 py-1 bg-gray-500 text-white rounded-lg text-xs hover:bg-gray-600 transition-colors failed-ignore-btn" data-id="${item.document_id}" title="Permanently ignore this document (move to ignored list)">
                        <i class="fas fa-eye-slash"></i> Ignore
                    </button>
                </td>
            </tr>`;
        }).join('');

        tableBody.querySelectorAll('.failed-reset-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                resetFailedDocument(parseInt(this.dataset.id, 10));
            });
        });

        tableBody.querySelectorAll('.failed-ignore-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                ignoreFailedDocument(parseInt(this.dataset.id, 10));
            });
        });
    }

    function formatFailedReason(reason) {
        const map = {
            'ocr_failed': '<i class="fas fa-eye-slash mr-1"></i>OCR failed',
            'ai_failed_after_ocr': '<i class="fas fa-robot mr-1"></i>AI failed after OCR',
            'ai_failed_ocr_disabled': '<i class="fas fa-power-off mr-1"></i>AI failed (OCR disabled)',
            'ai_failed_without_ocr_fallback': '<i class="fas fa-triangle-exclamation mr-1"></i>AI failed (no OCR fallback)',
            'insufficient_content_lt_10': '<i class="fas fa-file-slash mr-1"></i>Insufficient content (&lt; 10 chars)'
        };

        if (map[reason]) return map[reason];
        if (reason && reason.startsWith('insufficient_content_lt_')) {
            const threshold = reason.replace('insufficient_content_lt_', '');
            if (/^\d+$/.test(threshold)) {
                return `<i class="fas fa-file-slash mr-1"></i>Insufficient content (&lt; ${threshold} chars)`;
            }
        }
        return escHtml(reason || 'unknown_failure');
    }

    function formatFailedSource(source) {
        if (source === 'ocr') return '<span class="text-violet-600">OCR</span>';
        if (source === 'ai') return '<span class="text-blue-600">AI</span>';
        return escHtml(source || 'unknown');
    }

    async function resetFailedDocument(documentId) {
        try {
            const resp = await fetch(`/api/failed/reset/${documentId}`, { method: 'POST' });
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
            const resp = await fetch(`/api/failed/ignore/${documentId}`, { method: 'POST' });
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

        const confirmed = window.confirm(`Reset all ${totalRecords} permanently failed document${totalRecords === 1 ? '' : 's'}?`);
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

        if (resetAllBtn) resetAllBtn.disabled = resetAllInProgress || totalRecords === 0;
        if (prevBtn) prevBtn.disabled = currentPage === 0;
        if (nextBtn) nextBtn.disabled = totalRecords === 0 || end >= totalRecords;
    }

    function showToast(message, type = 'success') {
        const toast = document.getElementById('toastNotification');
        const inner = document.getElementById('toastInner');
        const icon = document.getElementById('toastIcon');
        const msg = document.getElementById('toastMessage');
        if (!toast) return;

        inner.className = `${type === 'error' ? 'bg-red-500' : 'bg-green-500'} text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-3`;
        icon.className = `fas ${type === 'error' ? 'fa-exclamation-circle' : 'fa-check-circle'}`;
        msg.textContent = message;

        toast.classList.remove('hidden');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => toast.classList.add('hidden'), 4000);
    }

    function escHtml(str) {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(str || ''));
        return div.innerHTML;
    }
})();
