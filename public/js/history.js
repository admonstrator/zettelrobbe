import { createTable } from '/js/modules/data-table.js';

class HistoryManager {
  constructor() {
    this.confirmModal = document.getElementById('confirmModal');
    this.confirmModalAll = document.getElementById('confirmModalAll');
    this.selectAll = document.getElementById('selectAll');
    this.table = null; // Will be initialized in initializeDataTable
    this.initialize();
  }

  initialize() {
    this.loadHistoryWithProgress()
      .then(() => {
        this.initializeTableEvents();
        this.table = this.initializeDataTable();
        this.initializeModals();
        this.initializeResetButtons();
        this.initializeFilters();
        this.initializeSelectAll();
      })
      .catch((error) => {
        console.error('Failed to load history:', error);
        // Show error message to user and update accessibility state
        const loadingIndicator = document.getElementById(
          'historyLoadingIndicator'
        );
        const statusText = document.getElementById('historyLoadStatus');
        const progressContainer = document.getElementById(
          'historyProgressContainer'
        );

        if (loadingIndicator) {
          loadingIndicator.style.display = 'block';
        }
        if (statusText) {
          statusText.textContent =
            'Error loading history. Please refresh the page.';
        }
        if (progressContainer) {
          progressContainer.setAttribute('aria-label', 'Loading failed');
        }
      });
  }

  loadHistoryWithProgress() {
    const loadingIndicator = document.getElementById('historyLoadingIndicator');
    const tableContainer = document.getElementById('historyTableContainer');
    const progressBar = document.getElementById('historyLoadProgress');
    const progressContainer = document.getElementById(
      'historyProgressContainer'
    );
    const statusText = document.getElementById('historyLoadStatus');

    // Show loading state
    loadingIndicator.style.display = 'block';
    tableContainer.style.display = 'none';

    // Set a timeout to force fallback if EventSource takes too long to connect
    const connectionTimeout = setTimeout(() => {
      console.warn(
        'EventSource connection timeout - falling back to direct loading'
      );
      if (statusText) {
        statusText.textContent =
          'Loading taking longer than expected, continuing...';
      }
    }, 5000);

    // Use EventSource for real-time progress updates
    const eventSource = new EventSource('/api/history/load-progress');
    let hasReceivedData = false;

    return new Promise((resolve, reject) => {
      // Set overall timeout as safety net
      const overallTimeout = setTimeout(() => {
        clearTimeout(connectionTimeout);
        console.warn('Overall timeout reached - forcing table display');
        eventSource.close();
        loadingIndicator.style.display = 'none';
        tableContainer.style.display = 'block';
        resolve();
      }, 15000);
      eventSource.onmessage = (event) => {
        hasReceivedData = true;
        clearTimeout(connectionTimeout);

        const data = JSON.parse(event.data);

        if (data.type === 'progress') {
          // Update progress bar
          const percentage = data.percentage || 0;
          progressBar.style.width = `${percentage}%`;
          // Update aria-valuenow for accessibility
          if (progressContainer) {
            progressContainer.setAttribute('aria-valuenow', percentage);
          }

          // Build detailed status message
          let statusMessage = data.message || 'Loading...';

          // Add step information if available
          if (data.step && data.totalSteps) {
            statusMessage = `[Step ${data.step}/${data.totalSteps}] ${statusMessage}`;
          }

          // Add details if available
          if (data.details) {
            const detailParts = [];
            if (data.details.documents !== undefined) {
              detailParts.push(`${data.details.documents} docs`);
            }
            if (data.details.tags !== undefined) {
              detailParts.push(`${data.details.tags} tags`);
            }
            if (detailParts.length > 0) {
              statusMessage += ` (${detailParts.join(', ')})`;
            }
          }

          statusText.textContent = statusMessage;
        } else if (data.type === 'complete') {
          // Loading complete
          clearTimeout(overallTimeout);
          eventSource.close();
          progressBar.style.width = '100%';
          if (progressContainer) {
            progressContainer.setAttribute('aria-valuenow', 100);
          }
          statusText.textContent = 'Complete!';

          // Populate filters if provided
          if (data.filters) {
            this.populateFilters(data.filters);
          }

          // Small delay to show completion
          setTimeout(() => {
            loadingIndicator.style.display = 'none';
            tableContainer.style.display = 'block';
            resolve();
          }, 300);
        } else if (data.type === 'error') {
          clearTimeout(overallTimeout);
          eventSource.close();
          // Don't hide loading indicator or show table - let catch handler manage error state
          reject(new Error(data.message || 'Loading failed'));
        }
      };

      eventSource.onerror = (error) => {
        console.error('EventSource error:', error);
        console.error('EventSource readyState:', eventSource.readyState);
        clearTimeout(connectionTimeout);
        clearTimeout(overallTimeout);
        eventSource.close();

        // If we never received any data, this is likely a connection/auth issue
        if (!hasReceivedData) {
          console.error(
            'EventSource failed to connect - possible auth or network error'
          );
          if (statusText) {
            statusText.textContent =
              'Connection failed, loading table directly...';
          }
        }

        // Fallback: continue anyway after brief delay
        setTimeout(() => {
          loadingIndicator.style.display = 'none';
          tableContainer.style.display = 'block';
          resolve();
        }, 1000);
      };
    });
  }

  populateFilters(filters) {
    // Populate tag filter
    const tagFilter = document.getElementById('tagFilter');
    if (tagFilter && filters.tags) {
      // Keep the "All Tags" option
      tagFilter.innerHTML = '<option value="">All Tags</option>';
      filters.tags.forEach((tag) => {
        const option = document.createElement('option');
        option.value = tag.id;
        option.textContent = tag.name;
        tagFilter.appendChild(option);
      });
    }

    // Populate correspondent filter
    const correspondentFilter = document.getElementById('correspondentFilter');
    if (correspondentFilter && filters.correspondents) {
      // Keep the "All Correspondents" option
      correspondentFilter.innerHTML =
        '<option value="">All Correspondents</option>';
      filters.correspondents.forEach((corr) => {
        const option = document.createElement('option');
        option.value = corr;
        option.textContent = corr;
        correspondentFilter.appendChild(option);
      });
    }
  }

  _escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  initializeDataTable() {
    const escape = (value) => this._escapeHTML(String(value ?? ''));

    return createTable(document.getElementById('historyTable'), {
      url: '/api/history',
      pageLength: 10,
      order: { column: 1, dir: 'desc' },
      emptyText: 'No processed documents yet.',
      toolbar: document.getElementById('historyFilters'),
      extraParams: () => ({
        tag: document.getElementById('tagFilter')?.value || '',
        correspondent:
          document.getElementById('correspondentFilter')?.value || '',
      }),
      columns: [
        {
          key: 'document_id',
          label: '',
          sortable: false,
          width: '36px',
          // Kept in the card layout: without the checkbox a phone has no way
          // to feed "Rescan selected" or "Reset selected".
          mobileLabel: 'Select',
          render: (value) =>
            `<input type="checkbox" class="doc-select zr-check" value="${escape(value)}" aria-label="Select document">`,
        },
        { key: 'document_id', label: 'ID', width: '64px', mobileLabel: 'ID' },
        {
          key: 'title',
          label: 'Title',
          render: (value, row) =>
            `<div class="zr-strong">${escape(value)}</div>` +
            // Date only, like the queue pages; the full timestamp sits in the title.
            `<div class="zr-sm zr-faint" title="${escape(window.zrDate.formatDateTime(row.created_at))}">Modified: ${escape(window.zrDate.format(row.created_at, { fallback: '–' }))}</div>`,
        },
        {
          key: 'correspondent',
          label: 'Correspondent',
          render: (value) =>
            value
              ? `<span class="zr-badge zr-badge--brand">${escape(value)}</span>`
              : '<span class="zr-faint zr-sm">None</span>',
        },
        {
          key: 'document_id',
          label: 'Actions',
          sortable: false,
          // The column sizes itself to the buttons and keeps them on one line;
          // wrapping used to push the second button down and double the row
          // height.
          cellClass: 'zr-table__actions',
          mobileLabel: '',
          // One labelled action plus the overflow, like the queue pages. Wrapping
          // stays on for the card layout, where a phone has less room; inside
          // the table the actions column overrides it back to a single line.
          render: (value, row, surface) => {
            const docId = escape(row.document_id ?? value);
            // The table copy and the card copy of this row both exist in the
            // DOM at all times; only one of them is displayed. Without the
            // surface in the id, the card's button would target the table's
            // menu, and a menu inside a display:none wrapper has no box to
            // place — the popover opened and was dismissed again, so the row
            // menu simply never appeared on a phone.
            const menuId = `historyRowMenu-${surface || 'table'}-${docId}`;
            return (
              '<div class="zr-row zr-row--wrap">' +
              `<button type="button" class="history-info-btn zr-btn" data-docid="${escape(value)}" title="Show AI analysis details">` +
              '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-info"/></svg><span>Details</span></button>' +
              // Labelled and bordered rather than a bare "…": as a ghost icon
              // button it read as decoration, and nothing said it opened
              // anything. The chevron is the part that promises a menu.
              `<button type="button" class="zr-btn" popovertarget="${menuId}" title="More actions" aria-haspopup="menu">` +
              '<span>Actions</span>' +
              '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-chevron-down"/></svg></button>' +
              `<div id="${menuId}" popover class="zr-menu">` +
              `<button type="button" class="zr-menu__item history-view-btn" data-link="${escape(row.link ?? '')}">` +
              '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-eye"/></svg>Open in Paperless-ngx</button>' +
              '<div class="zr-menu__sep"></div>' +
              // Shown whether or not the OCR fallback is configured. Hiding
              // them made "this build has no such feature" and "OCR is
              // switched off here" look identical, which cost an afternoon of
              // looking for the wrong bug — and the queue entry, which had
              // always been unconditional, disappeared along with them. The
              // run endpoint answers "OCR fallback is not enabled. Set
              // MISTRAL_OCR_ENABLED=yes …" in the progress log, which says it
              // better than an absent menu item ever could.
              `<button type="button" class="zr-menu__item history-ocr-run-btn" data-docid="${docId}">` +
              '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-play"/></svg>OCR now, then analyze</button>' +
              `<button type="button" class="zr-menu__item history-ocr-btn" data-docid="${docId}">` +
              '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-scan"/></svg>Send to OCR queue</button>' +
              `<button type="button" class="zr-menu__item history-rescan-btn" data-docid="${docId}">` +
              '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg>Reanalyze</button>' +
              '<div class="zr-menu__sep"></div>' +
              // Last and set apart: it is the only entry here that takes the
              // document out of future scans rather than feeding one.
              `<button type="button" class="zr-menu__item zr-menu__item--danger history-skip-btn" data-docid="${docId}">` +
              '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-eye-off"/></svg>Skip…</button>' +
              '</div>' +
              '</div>'
            );
          },
        },
      ],
    });
  }

  initializeModals() {
    // Modal close handlers
    [this.confirmModal, this.confirmModalAll].forEach((modal) => {
      if (!modal) return;

      // Close on overlay click
      modal.querySelector('.modal-overlay')?.addEventListener('click', () => {
        this.hideModal(modal);
      });

      // Close on X button click
      modal.querySelector('.modal-close')?.addEventListener('click', () => {
        this.hideModal(modal);
      });

      // Close on Cancel button click
      modal.querySelector('[id^="cancel"]')?.addEventListener('click', () => {
        this.hideModal(modal);
      });
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideModal(this.confirmModal);
        this.hideModal(this.confirmModalAll);
        this.hideModal(document.getElementById('infoModal'));
      }
    });

    // Reset action handlers
    document
      .getElementById('confirmReset')
      ?.addEventListener('click', async () => {
        const selectedDocs = this.getSelectedDocuments();
        const success = await this.resetDocuments(selectedDocs);
        if (success) {
          this.hideModal(this.confirmModal);
        }
      });

    document
      .getElementById('confirmResetAll')
      ?.addEventListener('click', async () => {
        const success = await this.resetAllDocuments();
        if (success) {
          this.hideModal(this.confirmModalAll);
        }
      });

    // Force Reload button handler
    document
      .getElementById('forceReloadBtn')
      ?.addEventListener('click', async () => {
        await this.forceReloadFilters();
      });

    // Info Modal handlers
    const infoModal = document.getElementById('infoModal');
    document
      .getElementById('infoModalClose')
      ?.addEventListener('click', () => this.hideModal(infoModal));
    document
      .getElementById('infoModalCloseBtn')
      ?.addEventListener('click', () => this.hideModal(infoModal));
    infoModal
      ?.querySelector('.modal-overlay')
      ?.addEventListener('click', () => this.hideModal(infoModal));
    document
      .getElementById('infoModalRescanBtn')
      ?.addEventListener('click', () => this._handleRescanClick());
    document
      .getElementById('infoModalRestoreBtn')
      ?.addEventListener('click', () => this._handleRestoreClick());
    document
      .getElementById('infoModalOriginalToggle')
      ?.addEventListener('click', () => {
        const body = document.getElementById('infoModalOriginalBody');
        const chevron = document.getElementById('infoModalOriginalChevron');
        const hidden = body.classList.toggle('hidden');
        chevron.style.transform = hidden ? '' : 'rotate(90deg)';
      });
  }

  initializeResetButtons() {
    // Reset Selected button
    document
      .getElementById('resetSelectedBtn')
      ?.addEventListener('click', () => {
        const selectedDocs = this.getSelectedDocuments();
        if (selectedDocs.length === 0) {
          alert('Please select at least one document to reset.');
          return;
        }
        this.showModal(this.confirmModal);
      });

    // Reset All button
    document.getElementById('resetAllBtn')?.addEventListener('click', () => {
      this.showModal(this.confirmModalAll);
    });

    // Rescan Selected button
    document
      .getElementById('rescanSelectedBtn')
      ?.addEventListener('click', () => this._handleRescanSelected());

    // The row menu applied to a selection. Wired once — unlike the row
    // buttons these live in the toolbar and survive every table re-render.
    const bulk = [
      ['bulkOcrRunBtn', () => this.bulkOcrAndAnalyze()],
      ['bulkOcrQueueBtn', () => this.bulkSendToOcrQueue()],
      ['bulkReanalyzeBtn', () => this._handleRescanSelected()],
      ['bulkIgnoreBtn', () => this.bulkIgnore()],
    ];
    bulk.forEach(([id, handler]) => {
      document.getElementById(id)?.addEventListener('click', () => {
        document.getElementById('historyBulkMenu')?.hidePopover?.();
        handler();
      });
    });
  }

  initializeTableEvents() {
    // The table module re-renders rows on every page, sort and search, so the
    // row-level handlers are re-attached on its render event.
    document
      .getElementById('historyTable')
      ?.addEventListener('zr:table-rendered', () => {
        this.updateSelectAllState();
        this.attachCheckboxListeners();
        this.attachActionButtonListeners();
      });
  }

  initializeFilters() {
    ['tagFilter', 'correspondentFilter'].forEach((id) => {
      document
        .getElementById(id)
        ?.addEventListener('change', () => this.table.reload());
    });
  }

  initializeSelectAll() {
    if (!this.selectAll) return;

    // Handle "Select All" checkbox
    this.selectAll.addEventListener('change', () => {
      this.setAllSelected(this.selectAll.checked);
    });

    // Initial state check
    this.updateSelectAllState();
  }

  /** Checks or clears every row checkbox and brings the header state along. */
  setAllSelected(selected) {
    document.querySelectorAll('.doc-select').forEach((checkbox) => {
      checkbox.checked = selected;
    });
    this.updateSelectAllState();
  }

  attachCheckboxListeners() {
    const checkboxes = document.querySelectorAll('.doc-select');
    checkboxes.forEach((checkbox) => {
      // Remove existing listeners to prevent duplicates
      checkbox.removeEventListener('change', this.handleCheckboxChange);
      // Add new listener
      checkbox.addEventListener('change', () =>
        this.handleCheckboxChange(checkbox)
      );
    });
  }

  attachActionButtonListeners() {
    document.querySelectorAll('.history-info-btn').forEach((button) => {
      if (button.dataset.boundClick === 'true') return;
      button.addEventListener('click', () => {
        const docId = button.dataset.docid || '';
        if (/^\d+$/.test(docId)) this.openInfoModal(Number(docId));
      });
      button.dataset.boundClick = 'true';
    });

    const viewButtons = document.querySelectorAll('.history-view-btn');
    viewButtons.forEach((button) => {
      if (button.dataset.boundClick === 'true') {
        return;
      }

      button.addEventListener('click', () => {
        const link = button.dataset.link || '';
        if (!this.isSafeHistoryLink(link)) {
          console.warn('Blocked unsafe history link:', link);
          return;
        }
        window.open(link);
      });

      button.dataset.boundClick = 'true';
    });

    document.querySelectorAll('.history-ocr-run-btn').forEach((button) => {
      if (button.dataset.boundClick === 'true') return;
      button.addEventListener('click', () => {
        const docId = button.dataset.docid || '';
        if (!/^\d+$/.test(docId)) {
          console.warn('Blocked unsafe document id:', docId);
          return;
        }
        this.ocrAndAnalyze(Number(docId));
      });
      button.dataset.boundClick = 'true';
    });

    document.querySelectorAll('.history-ocr-btn').forEach((button) => {
      if (button.dataset.boundClick === 'true') return;
      button.addEventListener('click', () => {
        const docId = button.dataset.docid || '';
        if (!/^\d+$/.test(docId)) {
          console.warn('Blocked unsafe document id:', docId);
          return;
        }
        this.sendToOcrQueue(Number(docId));
      });
      button.dataset.boundClick = 'true';
    });

    document.querySelectorAll('.history-rescan-btn').forEach((button) => {
      if (button.dataset.boundClick === 'true') return;
      button.addEventListener('click', () => {
        const docId = button.dataset.docid || '';
        if (!/^\d+$/.test(docId)) {
          console.warn('Blocked unsafe document id:', docId);
          return;
        }
        this.rescanFromRow(Number(docId));
      });
      button.dataset.boundClick = 'true';
    });

    document.querySelectorAll('.history-skip-btn').forEach((button) => {
      if (button.dataset.boundClick === 'true') return;
      button.addEventListener('click', () => {
        const docId = button.dataset.docid || '';
        if (!/^\d+$/.test(docId)) {
          console.warn('Blocked unsafe document id:', docId);
          return;
        }
        this.openSkipDialog(Number(docId));
      });
      button.dataset.boundClick = 'true';
    });
  }

  /**
   * Runs OCR for one document now and lets the AI analysis follow, from the row
   * the operator is already looking at. Queueing and then walking to the OCR
   * page to press Process was the only route before.
   *
   * The queue entry is created first even though processQueueItem() does not
   * insist on one: the extracted text is stored on that row, and without it the
   * OCR page — where the output is read back — would never learn the document
   * had been through.
   */
  async ocrAndAnalyze(documentId) {
    try {
      const response = await fetch('/api/ocr/queue/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });

      // A 200 carrying success:false only means the document was in the queue
      // already, which is the ordinary case here. Anything else is a real
      // refusal — an unknown document, a bad id — and stops the run.
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          data?.error ||
            `Could not queue the document (HTTP ${response.status})`
        );
      }
    } catch (error) {
      this.showToast(`OCR could not be started: ${error.message}`, 'error');
      return;
    }

    if (!window.zrOcrProgress) {
      this.showToast('The progress overlay is unavailable.', 'error');
      return;
    }

    window.zrOcrProgress.run({
      url: `/api/ocr/process/${documentId}`,
      // The whole point of this entry over the queue one: the operator wants
      // the finished result, not an OCR text to analyze from another page.
      body: { autoAnalyze: true },
      title: `OCR and analysis for document #${documentId}`,
      onDone: (ok) => {
        if (ok) this.table?.reload();
      },
    });
  }

  /**
   * The ids behind the checkboxes, or null after telling the operator there
   * are none. Every bulk action starts here, so the complaint is worded once.
   */
  _selectionOrComplain(action) {
    const ids = this.getSelectedDocuments()
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (!ids.length) {
      this.showToast(`Select at least one document to ${action}.`, 'error');
      return null;
    }
    return ids;
  }

  /**
   * Asks before a bulk action that is awkward to undo. Falls through to a
   * plain yes when the dialog module has not loaded, rather than swallowing
   * the action the operator asked for.
   */
  async _confirmBulk(text) {
    if (typeof window.zrDialog !== 'function') return true;

    const result = await window.zrDialog({
      icon: 'warning',
      title: 'Apply to the selection?',
      text,
      showCancelButton: true,
      confirmButtonText: 'Yes, apply',
      destructive: true,
    });
    return Boolean(result?.isConfirmed);
  }

  /** Sends the whole selection to the OCR queue in one request. */
  async bulkSendToOcrQueue() {
    const ids = this._selectionOrComplain('send to the OCR queue');
    if (!ids) return;

    try {
      const response = await fetch('/api/ocr/queue/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentIds: ids }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || `Request failed (${response.status})`);
      }
      this.showToast(
        data?.message || `${ids.length} document(s) queued.`,
        'success'
      );
    } catch (error) {
      this.showToast(
        `Could not queue the selection: ${error.message}`,
        'error'
      );
    }
  }

  /** Ignores the whole selection in one request. */
  async bulkIgnore() {
    const ids = this._selectionOrComplain('ignore');
    if (!ids) return;

    const confirmed = await this._confirmBulk(
      `Ignore ${ids.length} document(s)? They will be skipped by future scans.`
    );
    if (!confirmed) return;

    try {
      const response = await fetch('/api/ignored/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentIds: ids, reason: 'manual' }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || `Request failed (${response.status})`);
      }
      this.showToast(
        data?.message || `${ids.length} document(s) ignored.`,
        'success'
      );
      await this.table?.reload();
    } catch (error) {
      this.showToast(
        `Could not ignore the selection: ${error.message}`,
        'error'
      );
    }
  }

  /**
   * Runs OCR and the analysis for every selected document, one after another
   * in the shared progress overlay. The queue entries are created up front in
   * a single request so the runs themselves are the only thing left to wait
   * for, and so the OCR page shows the whole batch while it works through it.
   */
  async bulkOcrAndAnalyze() {
    const ids = this._selectionOrComplain('run OCR on');
    if (!ids) return;

    try {
      const response = await fetch('/api/ocr/queue/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentIds: ids }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || `Request failed (${response.status})`);
      }
    } catch (error) {
      this.showToast(`OCR could not be started: ${error.message}`, 'error');
      return;
    }

    if (!window.zrOcrProgress) {
      this.showToast('The progress overlay is unavailable.', 'error');
      return;
    }

    window.zrOcrProgress.runAll(
      ids.map((id) => ({
        url: `/api/ocr/process/${id}`,
        body: { autoAnalyze: true },
        label: `Document #${id}`,
      })),
      {
        title: `OCR and analysis for ${ids.length} document(s)`,
        onDone: () => this.table?.reload(),
      }
    );
  }

  /**
   * Queues an already-processed document for OCR reprocessing. Useful when the
   * AI result was poor because the scan carried little or garbled text — the
   * queue page is otherwise the only way in, and it only knows about documents
   * the scan loop already flagged.
   */
  async sendToOcrQueue(documentId) {
    let message;
    let tone = 'success';

    // The request is on its own so a rendering fault in the toast cannot be
    // reported back as if the queueing itself had failed.
    try {
      const response = await fetch('/api/ocr/queue/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });
      const data = await response.json();

      if (data.success) {
        message =
          data.message || `Document ${documentId} added to the OCR queue.`;
      } else {
        // Reached for a document Paperless-ngx no longer has, and for one the
        // OCR worker is busy with. Re-queueing a pending document succeeds and
        // simply moves it back to the front.
        message = data.message || data.error || 'Could not add the document.';
        tone = 'error';
      }
    } catch (error) {
      message = `Could not add the document: ${error.message}`;
      tone = 'error';
    }

    this.showToast(message, tone);
  }

  /**
   * Opens the skip dialog for one document: it goes on the ignore list, and
   * the dialog proposes rules built from it so the next copy is skipped too.
   * The proposals come from Paperless-ngx, so the dialog opens first and
   * fills once they arrive.
   */
  async openSkipDialog(documentId) {
    const dialog = document.getElementById('skipDialog');
    if (!dialog) return;
    this.bindSkipDialog(dialog);

    const loading = document.getElementById('skipDialogLoading');
    const errorBox = document.getElementById('skipDialogError');
    const form = document.getElementById('skipDialogForm');
    const confirm = document.getElementById('skipDialogConfirm');
    loading.classList.remove('hidden');
    errorBox.classList.add('hidden');
    form.classList.add('hidden');
    confirm.disabled = true;
    this.skipDocumentId = documentId;
    dialog.showModal();

    try {
      const response = await fetch(`/api/ignored/suggest/${documentId}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || `Request failed (${response.status})`);
      }
      // A second row opened while this one was loading wins.
      if (this.skipDocumentId !== documentId) return;
      this.fillSkipDialog(data.data);
      loading.classList.add('hidden');
      form.classList.remove('hidden');
      confirm.disabled = false;
    } catch (error) {
      loading.classList.add('hidden');
      errorBox.textContent = `Could not read the document: ${error.message}`;
      errorBox.classList.remove('hidden');
    }
  }

  /** Wires the dialog's controls once. */
  bindSkipDialog(dialog) {
    if (dialog.dataset.bound === 'true') return;
    dialog.dataset.bound = 'true';

    dialog
      .querySelectorAll('[data-skip-close]')
      .forEach((button) =>
        button.addEventListener('click', () => dialog.close())
      );
    dialog.addEventListener('change', () => this.updateSkipConfirm());
    document
      .getElementById('skipTitlePattern')
      .addEventListener('input', () => {
        document.getElementById('skipRuleTitle').checked = Boolean(
          document.getElementById('skipTitlePattern').value.trim()
        );
        this.updateSkipTitleHint();
        this.updateSkipConfirm();
      });
    document.getElementById('skipPageLimit').addEventListener('input', () => {
      document.getElementById('skipRulePages').checked = true;
      this.updateSkipConfirm();
    });
    document
      .getElementById('skipDialogConfirm')
      .addEventListener('click', () => this.submitSkip(dialog));
  }

  fillSkipDialog(suggestion) {
    const { document: doc, sameText, title, pageLimit } = suggestion;
    const setText = (id, value) => {
      document.getElementById(id).textContent = value;
    };

    setText('skipFactDocument', `#${doc.id} ${doc.title || ''}`.trim());
    setText(
      'skipFactPages',
      doc.pageCount === null ? 'unknown' : String(doc.pageCount)
    );
    setText('skipFactFile', doc.fileName || '–');
    setText('skipFactCorrespondent', doc.correspondent || '–');

    const textBox = document.getElementById('skipRuleText');
    textBox.disabled = !sameText.available;
    textBox.checked = sameText.available;
    let textHint = sameText.available
      ? `Fingerprint of the ${doc.characters.toLocaleString()} characters Paperless-ngx recognised. Catches the next copy with the same text, even as a newly generated PDF. An identical file is caught the same way.`
      : 'The text is too short to tell copies apart, so copies are not recognised.';
    if (sameText.available && !sameText.enabled) {
      textHint +=
        ' Copy recognition is switched off in Settings › Skip rules; the fingerprint is kept for when it is on.';
    }
    setText('skipRuleTextHint', textHint);

    this.skipTitleSuggestions = title.suggestions;
    const first = title.suggestions[0];
    document.getElementById('skipTitlePattern').value = first?.pattern || '';
    document.getElementById('skipRuleTitle').checked = Boolean(first);
    const picks = document.getElementById('skipTitleSuggestions');
    picks.querySelectorAll('button').forEach((button) => button.remove());
    title.suggestions.slice(1).forEach((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-skip__pick';
      button.textContent = entry.pattern;
      button.addEventListener('click', () => {
        document.getElementById('skipTitlePattern').value = entry.pattern;
        document.getElementById('skipRuleTitle').checked = true;
        this.updateSkipTitleHint();
        this.updateSkipConfirm();
      });
      picks.appendChild(button);
    });
    picks.classList.toggle('hidden', title.suggestions.length < 2);
    this.skipExistingPatterns = title.existing;
    this.updateSkipTitleHint();

    const pagesTile = document.getElementById('skipRulePagesTile');
    pagesTile.classList.toggle('hidden', !pageLimit.suggested);
    document.getElementById('skipRulePages').checked = false;
    document.getElementById('skipPageLimit').value = pageLimit.suggested || '';
    setText(
      'skipRulePagesHint',
      pageLimit.current > 0
        ? `The current limit is ${pageLimit.current}. Applies to all documents.`
        : 'No limit is set yet. Applies to all documents.'
    );

    this.updateSkipConfirm();
  }

  updateSkipTitleHint() {
    const value = document
      .getElementById('skipTitlePattern')
      .value.trim()
      .toLowerCase();
    const known = (this.skipTitleSuggestions || []).find(
      (entry) => entry.pattern.toLowerCase() === value
    );
    let hint = 'Dates and numbers are left out of the suggestion.';
    if (known) {
      hint += ` Matches ${known.historyMatches} earlier document${known.historyMatches === 1 ? '' : 's'} in the history.`;
    }
    const existing = this.skipExistingPatterns || [];
    if (existing.length) {
      hint += ` Already on the list: ${existing.join(', ')}.`;
    }
    document.getElementById('skipRuleTitleHint').textContent = hint;
  }

  updateSkipConfirm() {
    const pagesTile = document.getElementById('skipRulePagesTile');
    const count =
      1 +
      ['skipRuleText', 'skipRuleTitle'].filter(
        (id) => document.getElementById(id).checked
      ).length +
      (!pagesTile.classList.contains('hidden') &&
      document.getElementById('skipRulePages').checked
        ? 1
        : 0);
    document.getElementById('skipDialogConfirm').textContent =
      count === 1 ? 'Skip document' : `Skip with ${count} rules`;
  }

  async submitSkip(dialog) {
    const confirm = document.getElementById('skipDialogConfirm');
    const pagesTile = document.getElementById('skipRulePagesTile');
    const titleChecked = document.getElementById('skipRuleTitle').checked;
    const pagesChecked =
      !pagesTile.classList.contains('hidden') &&
      document.getElementById('skipRulePages').checked;
    const payload = {
      documentId: this.skipDocumentId,
      sameText: document.getElementById('skipRuleText').checked,
      titlePattern: titleChecked
        ? document.getElementById('skipTitlePattern').value.trim()
        : null,
      pageLimit: pagesChecked
        ? Number(document.getElementById('skipPageLimit').value)
        : null,
    };

    confirm.disabled = true;
    try {
      const response = await fetch('/api/ignored/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || `Request failed (${response.status})`);
      }
      dialog.close();
      this.showToast(data.message, 'success');
      this.table?.reload();
    } catch (error) {
      this.showToast(`Could not skip the document: ${error.message}`, 'error');
    } finally {
      confirm.disabled = false;
    }
  }

  isSafeHistoryLink(link) {
    if (typeof link !== 'string') {
      return false;
    }

    const trimmed = link.trim();
    if (!trimmed) {
      return false;
    }

    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith('javascript:') ||
      lower.startsWith('data:') ||
      lower.startsWith('vbscript:')
    ) {
      return false;
    }

    try {
      const parsed = new URL(trimmed, window.location.origin);
      return (
        parsed.origin === window.location.origin &&
        parsed.pathname.startsWith('/')
      );
    } catch {
      return false;
    }
  }

  handleCheckboxChange(changed) {
    // The table and the card layout are both in the DOM (CSS shows one), so
    // every document has two checkboxes. Keep the hidden twin in step or the
    // counts and the selection would depend on the viewport.
    if (changed) {
      document.querySelectorAll('.doc-select').forEach((checkbox) => {
        if (checkbox !== changed && checkbox.value === changed.value) {
          checkbox.checked = changed.checked;
        }
      });
    }
    this.updateSelectAllState();
  }

  updateSelectAllState() {
    if (!this.selectAll) return;

    const checkboxes = document.querySelectorAll('.doc-select');
    const checkedBoxes = document.querySelectorAll('.doc-select:checked');

    // Update "Select All" checkbox state
    this.selectAll.checked =
      checkboxes.length > 0 && checkboxes.length === checkedBoxes.length;

    // Update indeterminate state
    this.selectAll.indeterminate =
      checkedBoxes.length > 0 && checkedBoxes.length < checkboxes.length;
  }

  showModal(modal) {
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('show');
    }
  }

  hideModal(modal) {
    if (modal) {
      modal.classList.remove('show');
      modal.classList.add('hidden');
    }
  }

  getSelectedDocuments() {
    // Deduplicated: each document renders a checkbox in the table and one in
    // the card layout, and both are checked after "Select all".
    return [
      ...new Set(
        Array.from(document.querySelectorAll('.doc-select:checked')).map(
          (checkbox) => checkbox.value
        )
      ),
    ];
  }

  async resetDocuments(ids) {
    try {
      const response = await fetch('/api/reset-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });

      if (!response.ok) {
        throw new Error('Failed to reset documents');
      }

      await this.table.reload();
      return true;
    } catch (error) {
      console.error('Error resetting documents:', error);
      alert('Failed to reset documents. Please try again.');
      return false;
    }
  }

  async resetAllDocuments() {
    try {
      const response = await fetch('/api/reset-all-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error('Failed to reset all documents');
      }

      await this.table.reload();
      return true;
    } catch (error) {
      console.error('Error resetting all documents:', error);
      alert('Failed to reset all documents. Please try again.');
      return false;
    }
  }

  // ── Info Modal ──────────────────────────────────────────────────────────────

  async openInfoModal(documentId) {
    this._currentInfoDocId = documentId;
    const modal = document.getElementById('infoModal');
    const loading = document.getElementById('infoModalLoading');
    const body = document.getElementById('infoModalBody');
    const titleEl = document.getElementById('infoModalTitle');
    const linkEl = document.getElementById('infoModalLink');

    // Reset to loading state
    loading.style.display = 'block';
    body.style.display = 'none';
    titleEl.textContent = 'AI Analysis Details';
    linkEl.style.display = 'none';
    this.showModal(modal);

    try {
      const res = await fetch(`/api/history/${documentId}/detail`);
      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to load details');
      }

      // --- Header ---
      titleEl.textContent = data.history.title || `Document #${documentId}`;
      if (data.link) {
        linkEl.href = data.link;
        linkEl.style.display = 'inline';
      }

      // --- Tags ---
      const tagsEl = document.getElementById('infoModalTags');
      const extTagsEl = document.getElementById('infoModalExternalTags');
      const liveHint = document.getElementById('infoModalLiveHint');

      tagsEl.innerHTML = '';
      extTagsEl.innerHTML = '';

      if (data.tags.liveAvailable) {
        liveHint.textContent = '(live comparison with Paperless-ngx)';
      } else {
        liveHint.textContent = '(live data unavailable)';
      }

      const statusStyle = {
        active: 'background:#dcfce7;color:#166534;border:1px solid #86efac;',
        removed: 'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;',
        unknown: 'background:#e0e7ff;color:#3730a3;border:1px solid #a5b4fc;',
        added_externally:
          'background:#fef9c3;color:#854d0e;border:1px solid #fde047;',
      };
      const statusLabel = {
        active: '✓ still active',
        removed: '✗ removed',
        unknown: '? unknown',
        added_externally: '+ added externally',
      };

      if (!data.tags.aiSet.length && !data.tags.external.length) {
        tagsEl.innerHTML =
          '<span class="zr-sm zr-faint">No tags set by AI</span>';
      }

      data.tags.aiSet.forEach((tag) => {
        const color = tag.color ? `#${tag.color.replace('#', '')}` : '#6b7280';
        const span = document.createElement('span');
        span.style =
          `padding:3px 10px;border-radius:9999px;font-size:0.75rem;display:inline-flex;align-items:center;gap:4px;` +
          (statusStyle[tag.status] || '');
        span.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span>${this._esc(tag.name)}`;
        if (data.tags.liveAvailable) {
          const hint = document.createElement('span');
          hint.style = 'font-size:0.65rem;opacity:0.75;';
          hint.textContent = statusLabel[tag.status] || '';
          span.appendChild(hint);
        }
        tagsEl.appendChild(span);
      });

      if (data.tags.external.length) {
        const label = document.createElement('div');
        label.className = 'zr-xs zr-faint';
        label.textContent = 'Tags in Paperless not set by AI:';
        extTagsEl.appendChild(label);
        data.tags.external.forEach((tag) => {
          const color = tag.color
            ? `#${tag.color.replace('#', '')}`
            : '#6b7280';
          const span = document.createElement('span');
          span.style =
            `padding:3px 10px;border-radius:9999px;font-size:0.75rem;display:inline-flex;align-items:center;gap:4px;` +
            statusStyle.added_externally;
          span.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span>${this._esc(tag.name)}`;
          extTagsEl.appendChild(span);
        });
      }

      // --- Correspondent ---
      const corrEl = document.getElementById('infoModalCorrespondent');
      corrEl.textContent = data.history.correspondent || 'Not assigned';

      // --- Document Classification ---
      document.getElementById('infoModalDocType').textContent =
        data.history.document_type_name || '\u2013';
      document.getElementById('infoModalLanguage').textContent =
        data.history.language || '\u2013';

      // --- Custom Fields ---
      const cfEl = document.getElementById('infoModalCustomFields');
      const cf = data.history.custom_fields;

      if (
        !cf ||
        (Array.isArray(cf) && cf.length === 0) ||
        (typeof cf === 'object' &&
          !Array.isArray(cf) &&
          Object.keys(cf).length === 0)
      ) {
        cfEl.innerHTML =
          '<span class="zr-sm zr-faint">No custom fields were detected or applied for this document</span>';
      } else {
        const items = Array.isArray(cf) ? cf : Object.values(cf);
        cfEl.innerHTML = items
          .map((item) => {
            const name = this._esc(
              item.field_name || item.name || 'Unknown field'
            );
            const value = this._esc(String(item.value ?? ''));
            return `<div class="zr-kv">
                        <span class="zr-strong zr-detail-label">${name}</span>
                        <span class="zr-muted">${value}</span>
                    </div>`;
          })
          .join('');
      }

      // --- Processed At ---
      document.getElementById('infoModalProcessedAt').textContent =
        window.zrDate.formatDateTime(data.history.created_at, {
          fallback: 'Unknown',
        });

      // --- Token Usage ---
      const tokensSection = document.getElementById('infoModalTokensSection');
      const tokensEl = document.getElementById('infoModalTokens');
      if (data.metrics) {
        tokensSection.style.display = 'block';
        tokensEl.innerHTML = [
          ['Prompt', data.metrics.promptTokens],
          ['Completion', data.metrics.completionTokens],
          ['Total', data.metrics.totalTokens],
        ]
          .map(
            ([label, val]) =>
              `<span class="zr-badge">
                        <span class="zr-strong">${label}:</span> ${(val ?? 0).toLocaleString()}
                    </span>`
          )
          .join('');
      } else {
        tokensSection.style.display = 'none';
      }

      // --- Original State ---
      const origSection = document.getElementById('infoModalOriginalSection');
      const restoreBtn = document.getElementById('infoModalRestoreBtn');
      const origContent = document.getElementById('infoModalOriginalContent');
      if (data.original) {
        origSection.style.display = 'block';
        restoreBtn.style.display = 'inline-flex';
        const tagCount = Array.isArray(data.original.tags)
          ? data.original.tags.length
          : 0;
        origContent.innerHTML = [
          `<div class="zr-kv">
                        <span class="zr-strong zr-detail-label">Title</span>
                        <span class="zr-muted">${this._esc(data.original.title || '\u2013')}</span>
                    </div>`,
          `<div class="zr-kv">
                        <span class="zr-strong zr-detail-label">Correspondent</span>
                        <span class="zr-muted">${data.original.correspondent ? `ID ${data.original.correspondent}` : 'None'}</span>
                    </div>`,
          `<div class="zr-kv">
                        <span class="zr-strong zr-detail-label">Tags</span>
                        <span class="zr-muted">${tagCount} tag${tagCount !== 1 ? 's' : ''} (IDs: ${this._esc(data.original.tags.join(', ') || 'none')})</span>
                    </div>`,
          data.original.documentType != null
            ? `<div class="zr-kv">
                        <span class="zr-strong zr-detail-label">Document Type</span>
                        <span class="zr-muted">ID ${data.original.documentType}</span>
                    </div>`
            : '',
          data.original.language
            ? `<div class="zr-row">
                        <span class="zr-strong zr-detail-label">Language</span>
                        <span class="zr-muted">${this._esc(data.original.language)}</span>
                    </div>`
            : '',
        ]
          .filter(Boolean)
          .join('');
      } else {
        origSection.style.display = 'none';
        restoreBtn.style.display = 'none';
      }

      loading.style.display = 'none';
      body.style.display = 'block';
    } catch (err) {
      console.error('Error loading info modal:', err);
      loading.innerHTML = `<div class="zr-empty zr-danger-text">
                <svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg>
                <div>Failed to load details: ${this._esc(err.message)}</div>
            </div>`;
    }
  }

  _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _handleRescanClick() {
    if (this._currentInfoDocId) {
      this.rescanDocument(this._currentInfoDocId);
    }
  }

  _handleRestoreClick() {
    if (this._currentInfoDocId) {
      this.restoreDocument(this._currentInfoDocId);
    }
  }

  async restoreDocument(documentId) {
    const btn = document.getElementById('infoModalRestoreBtn');
    const origHtml = btn?.innerHTML;
    if (
      !confirm(
        'Restore this document to its original state (before AI processing)?\nThis will overwrite the current title, tags, correspondent, document type and language in Paperless-ngx.'
      )
    ) {
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<svg class="zr-icon zr-icon--sm zr-icon--spin" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg> Restoring...';
    }
    try {
      const res = await fetch(`/api/history/${documentId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Restore failed');

      this.hideModal(document.getElementById('infoModal'));
      this.showToast('Document restored to its original state.', 'success');
      this.table?.reload();
    } catch (err) {
      console.error('Restore failed:', err);
      this.showToast('Restore failed: ' + err.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }
  }

  async _handleRescanSelected() {
    const ids = this.getSelectedDocuments();
    if (ids.length === 0) {
      this.showToast('Please select at least one document to rescan.', 'error');
      return;
    }

    const btn = document.getElementById('rescanSelectedBtn');
    const origHtml = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<svg class="zr-icon zr-icon--sm zr-icon--spin" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg> Rescanning...';
    }

    try {
      // Reprocess the selected documents directly, bypassing the scan tag
      // filter (the backend clears their local record and enqueues them).
      const response = await fetch('/api/history/rescan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!response.ok) throw new Error('Rescan request failed');

      await this.table.reload();
      this.showToast(
        `${ids.length} document(s) sent for rescan. It might take a few moments to process.`,
        'success'
      );
    } catch (err) {
      console.error('Bulk rescan failed:', err);
      this.showToast('Rescan failed. Please try again.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }
  }

  /**
   * Sends one document back for reprocessing and returns the parsed response.
   * Only the request is shared: the modal button and the row menu differ in
   * what they have to put back afterwards (a spinner, a modal), and the row
   * menu has neither. Throws on anything the caller should report as a failure.
   */
  async postRescan(documentId) {
    // Reprocess directly, bypassing the scan tag filter. The backend clears the
    // local record and enqueues the document for processing.
    const response = await fetch(`/api/history/${documentId}/rescan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Rescan request failed (${response.status})`);
    }

    // A JSON body is part of the contract, so an expired session answered with
    // the login page throws here instead of passing for a queued document.
    const data = await response.json();
    if (data && data.success === false) {
      throw new Error(data.error || 'Rescan failed');
    }
    return data;
  }

  async rescanDocument(documentId) {
    const btn = document.getElementById('infoModalRescanBtn');
    const origHtml = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<svg class="zr-icon zr-icon--sm zr-icon--spin" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg> Rescanning...';
    }

    try {
      await this.postRescan(documentId);

      // Close modal & show toast
      this.hideModal(document.getElementById('infoModal'));
      this.showToast(
        'Document sent for rescan. It might take a few moments to process.',
        'success'
      );

      // Reload table
      this.table?.reload();
    } catch (err) {
      console.error('Rescan failed:', err);
      this.showToast('Rescan failed. Please try again.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }
  }

  /**
   * "Reanalyze" from the row menu. Same request as the modal button, minus the
   * modal: the menu closes itself on click, so there is no spinner to restore
   * and nothing to hide once the document is queued.
   */
  async rescanFromRow(documentId) {
    // Wording taken from the modal path on purpose — the same action should not
    // report itself differently depending on where it was started.
    let message =
      'Document sent for rescan. It might take a few moments to process.';
    let tone = 'success';

    try {
      await this.postRescan(documentId);
    } catch (err) {
      console.error('Rescan failed:', err);
      message = 'Rescan failed. Please try again.';
      tone = 'error';
    }

    this.showToast(message, tone);
    // The backend drops the processing record, so the row leaves the table
    // until the document has been analyzed again.
    if (tone === 'success') {
      this.table?.reload();
    }
  }

  // Adapter only: the toast DOM lives in the module kernel (public/js/zr.js).
  // This classic script runs before that module, so the lookup is deferred to
  // call time — toasts only fire on user interaction, never during load.
  showToast(message, type = 'success') {
    if (typeof window.__zrToast !== 'function') return null;
    return window.__zrToast(message, {
      tone: type === 'error' ? 'danger' : 'ok',
    });
  }

  // ────────────────────────────────────────────────────────────────────────────

  async forceReloadFilters() {
    const btn = document.getElementById('forceReloadBtn');
    // The button holds an SVG, not a font icon; querySelector('i') has returned
    // null since the UI migration, and adding a class to it threw before the
    // cache was ever cleared — the button did nothing at all.
    const icon = btn.querySelector('.zr-icon');

    icon?.classList.add('zr-icon--spin');
    btn.disabled = true;

    try {
      // Clear cache on server
      const response = await fetch('/api/history/clear-cache', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) throw new Error('Failed to clear cache');

      // Reload the entire page to get fresh data
      window.location.reload();
    } catch (error) {
      console.error('[ERROR] Force reload failed:', error);
      this.showToast('Failed to reload filters. Please try again.', 'error');
      icon?.classList.remove('zr-icon--spin');
      btn.disabled = false;
    }
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.historyManager = new HistoryManager();
});
