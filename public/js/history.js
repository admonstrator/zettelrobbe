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
                this.table = this.initializeDataTable();
                this.initializeModals();
                this.initializeResetButtons();
                this.initializeFilters();
                this.initializeSelectAll();
            })
            .catch((error) => {
                console.error('Failed to load history:', error);
                // Show error message to user and update accessibility state
                const loadingIndicator = document.getElementById('historyLoadingIndicator');
                const statusText = document.getElementById('historyLoadStatus');
                const progressContainer = document.getElementById('historyProgressContainer');
                
                if (loadingIndicator) {
                    loadingIndicator.style.display = 'block';
                }
                if (statusText) {
                    statusText.textContent = 'Error loading history. Please refresh the page.';
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
        const progressContainer = document.getElementById('historyProgressContainer');
        const statusText = document.getElementById('historyLoadStatus');

        // Show loading state
        loadingIndicator.style.display = 'block';
        tableContainer.style.display = 'none';

        // Set a timeout to force fallback if EventSource takes too long to connect
        const connectionTimeout = setTimeout(() => {
            console.warn('EventSource connection timeout - falling back to direct loading');
            if (statusText) {
                statusText.textContent = 'Loading taking longer than expected, continuing...';
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
                } 
                else if (data.type === 'complete') {
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
                }
                else if (data.type === 'error') {
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
                    console.error('EventSource failed to connect - possible auth or network error');
                    if (statusText) {
                        statusText.textContent = 'Connection failed, loading table directly...';
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
            filters.tags.forEach(tag => {
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
            correspondentFilter.innerHTML = '<option value="">All Correspondents</option>';
            filters.correspondents.forEach(corr => {
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
        return $('#historyTable').DataTable({
            serverSide: true,
            processing: true,
            ajax: {
                url: '/api/history',
                data: (d) => {
                    d.tag = $('#tagFilter').val();
                    d.correspondent = $('#correspondentFilter').val();
                }
            },
            columns: [
                {
                    data: 'document_id',
                    render: (data) => `<input type="checkbox" class="doc-select rounded" value="${data}">`,
                    orderable: false,
                    width: '40px'
                },
                { 
                    data: 'document_id',
                    width: '60px'
                },
                {
                    data: 'title',
                    render: (data, type, row) => {
                        if (type === 'display') {
                            const escapedData = this._escapeHTML(data);
                            return `
                                <div class="font-medium">${escapedData}</div>
                                <div class="text-xs text-gray-500">Modified: ${new Date(row.created_at).toLocaleString()}</div>
                            `;
                        }
                        return data;
                    }
                },
                {   // AI Info button column (replaces raw tag badges)
                    data: 'document_id',
                    render: (data) => {
                        return `<button onclick="window.historyManager.openInfoModal(${data})" class="toolbar-btn toolbar-btn--warning toolbar-btn--sm" title="Show AI analysis details">
                            <i class="fa-solid fa-circle-info"></i>
                            <span class="hidden sm:inline ml-1">Details</span>
                        </button>`;
                    },
                    orderable: false,
                    width: '80px'
                },
                { 
                    data: 'correspondent',
                    render: (data) => data ? `<span class="px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 rounded-full text-xs">${this._escapeHTML(data)}</span>` : '<span class="text-gray-400 italic text-xs">None</span>'
                },
                {
                    data: null,
                    render: (data) => `
                        <div class="flex flex-wrap items-center gap-2">
                            <button type="button" class="history-view-btn toolbar-btn toolbar-btn--primary toolbar-btn--sm" data-link="${this._escapeHTML(String(data.link ?? ''))}">
                                <i class="fa-solid fa-eye"></i>
                                <span class="hidden sm:inline ml-1">View</span>
                            </button>
                            <button type="button" class="history-chat-btn toolbar-btn toolbar-btn--neutral toolbar-btn--sm" data-docid="${this._escapeHTML(String(data.document_id ?? ''))}">
                                <i class="fa-solid fa-comment"></i>
                                <span class="hidden sm:inline ml-1">Chat</span>
                            </button>
                        </div>
                    `,
                    orderable: false,
                    width: '150px'
                }
            ],
            order: [[1, 'desc']], // Sort by document_id (column 1) descending - newest first
            pageLength: 10,
            dom: '<"flex flex-col sm:flex-row justify-between items-center mb-4"<"flex-1"f><"flex-none"l>>rtip',
            language: {
                search: "Search documents:",
                lengthMenu: "Show _MENU_ entries",
                info: "Showing _START_ to _END_ of _TOTAL_ documents",
                infoEmpty: "Showing 0 to 0 of 0 documents",
                infoFiltered: "(filtered from _MAX_ total documents)"
            },
            drawCallback: () => {
                // Update "Select All" checkbox state after table redraw
                this.updateSelectAllState();
                // Reattach event listeners to checkboxes
                this.attachCheckboxListeners();
                // Reattach action handlers after each redraw
                this.attachActionButtonListeners();
            }
        });
    }

    initializeModals() {
        // Modal close handlers
        [this.confirmModal, this.confirmModalAll].forEach(modal => {
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
        document.getElementById('confirmReset')?.addEventListener('click', async () => {
            const selectedDocs = this.getSelectedDocuments();
            const success = await this.resetDocuments(selectedDocs);
            if (success) {
                this.hideModal(this.confirmModal);
            }
        });

        document.getElementById('confirmResetAll')?.addEventListener('click', async () => {
            const success = await this.resetAllDocuments();
            if (success) {
                this.hideModal(this.confirmModalAll);
            }
        });

        // Force Reload button handler
        document.getElementById('forceReloadBtn')?.addEventListener('click', async () => {
            await this.forceReloadFilters();
        });

        // Info Modal handlers
        const infoModal = document.getElementById('infoModal');
        document.getElementById('infoModalClose')?.addEventListener('click', () => this.hideModal(infoModal));
        document.getElementById('infoModalCloseBtn')?.addEventListener('click', () => this.hideModal(infoModal));
        infoModal?.querySelector('.modal-overlay')?.addEventListener('click', () => this.hideModal(infoModal));
        document.getElementById('infoModalRescanBtn')?.addEventListener('click', () => this._handleRescanClick());
        document.getElementById('infoModalRestoreBtn')?.addEventListener('click', () => this._handleRestoreClick());
        document.getElementById('infoModalOriginalToggle')?.addEventListener('click', () => {
            const body    = document.getElementById('infoModalOriginalBody');
            const chevron = document.getElementById('infoModalOriginalChevron');
            const hidden  = body.classList.toggle('hidden');
            chevron.style.transform = hidden ? '' : 'rotate(90deg)';
        });
    }

    initializeResetButtons() {
        // Reset Selected button
        document.getElementById('resetSelectedBtn')?.addEventListener('click', () => {
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
        document.getElementById('rescanSelectedBtn')?.addEventListener('click', () => this._handleRescanSelected());
    }

    initializeFilters() {
        $('#tagFilter, #correspondentFilter').on('change', () => {
            this.table.ajax.reload();
        });
    }

    initializeSelectAll() {
        if (!this.selectAll) return;

        // Handle "Select All" checkbox
        this.selectAll.addEventListener('change', () => {
            const isChecked = this.selectAll.checked;
            const checkboxes = document.querySelectorAll('.doc-select');
            checkboxes.forEach(checkbox => {
                checkbox.checked = isChecked;
            });
        });

        // Initial state check
        this.updateSelectAllState();
    }

    attachCheckboxListeners() {
        const checkboxes = document.querySelectorAll('.doc-select');
        checkboxes.forEach(checkbox => {
            // Remove existing listeners to prevent duplicates
            checkbox.removeEventListener('change', this.handleCheckboxChange);
            // Add new listener
            checkbox.addEventListener('change', () => this.handleCheckboxChange());
        });
    }

    attachActionButtonListeners() {
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

        const chatButtons = document.querySelectorAll('.history-chat-btn');
        chatButtons.forEach((button) => {
            if (button.dataset.boundClick === 'true') {
                return;
            }

            button.addEventListener('click', () => {
                const docId = button.dataset.docid || '';
                if (!/^\d+$/.test(docId)) {
                    console.warn('Blocked unsafe document id:', docId);
                    return;
                }

                const encodedDocId = encodeURIComponent(docId);
                window.open(`/chat?open=${encodedDocId}`);
            });

            button.dataset.boundClick = 'true';
        });
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
        if (lower.startsWith('javascript:') || lower.startsWith('data:')) {
            return false;
        }

        try {
            const parsed = new URL(trimmed, window.location.origin);
            return parsed.origin === window.location.origin && parsed.pathname.startsWith('/');
        } catch (error) {
            return false;
        }
    }

    handleCheckboxChange() {
        this.updateSelectAllState();
    }

    updateSelectAllState() {
        if (!this.selectAll) return;

        const checkboxes = document.querySelectorAll('.doc-select');
        const checkedBoxes = document.querySelectorAll('.doc-select:checked');
        
        // Update "Select All" checkbox state
        this.selectAll.checked = checkboxes.length > 0 && checkboxes.length === checkedBoxes.length;
        
        // Update indeterminate state
        this.selectAll.indeterminate = checkedBoxes.length > 0 && checkedBoxes.length < checkboxes.length;
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
        return Array.from(document.querySelectorAll('.doc-select:checked'))
            .map(checkbox => checkbox.value);
    }

    async resetDocuments(ids) {
        try {
            const response = await fetch('/api/reset-documents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids })
            });

            if (!response.ok) {
                throw new Error('Failed to reset documents');
            }

            await this.table.ajax.reload();
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
                headers: { 'Content-Type': 'application/json' }
            });

            if (!response.ok) {
                throw new Error('Failed to reset all documents');
            }

            await this.table.ajax.reload();
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
        const modal        = document.getElementById('infoModal');
        const loading      = document.getElementById('infoModalLoading');
        const body         = document.getElementById('infoModalBody');
        const titleEl      = document.getElementById('infoModalTitle');
        const linkEl       = document.getElementById('infoModalLink');

        // Reset to loading state
        loading.style.display = 'block';
        body.style.display    = 'none';
        titleEl.textContent   = 'AI Analysis Details';
        linkEl.style.display  = 'none';
        this.showModal(modal);

        try {
            const res  = await fetch(`/api/history/${documentId}/detail`);
            const data = await res.json();

            if (!data.success) {
                throw new Error(data.error || 'Failed to load details');
            }

            // --- Header ---
            titleEl.textContent  = data.history.title || `Document #${documentId}`;
            if (data.link) {
                linkEl.href          = data.link;
                linkEl.style.display = 'inline';
            }

            // --- Tags ---
            const tagsEl    = document.getElementById('infoModalTags');
            const extTagsEl = document.getElementById('infoModalExternalTags');
            const liveHint  = document.getElementById('infoModalLiveHint');

            tagsEl.innerHTML    = '';
            extTagsEl.innerHTML = '';

            if (data.tags.liveAvailable) {
                liveHint.textContent = '(live comparison with Paperless-ngx)';
            } else {
                liveHint.textContent = '(live data unavailable)';
            }

            const statusStyle = {
                active:           'background:#dcfce7;color:#166534;border:1px solid #86efac;',
                removed:          'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;',
                unknown:          'background:#e0e7ff;color:#3730a3;border:1px solid #a5b4fc;',
                added_externally: 'background:#fef9c3;color:#854d0e;border:1px solid #fde047;'
            };
            const statusLabel = {
                active:           '✓ still active',
                removed:          '✗ removed',
                unknown:          '? unknown',
                added_externally: '+ added externally'
            };

            if (!data.tags.aiSet.length && !data.tags.external.length) {
                tagsEl.innerHTML = '<span class="text-gray-400 text-sm">No tags set by AI</span>';
            }

            data.tags.aiSet.forEach(tag => {
                const color = tag.color ? `#${tag.color.replace('#','')}` : '#6b7280';
                const span  = document.createElement('span');
                span.style  = `padding:3px 10px;border-radius:9999px;font-size:0.75rem;display:inline-flex;align-items:center;gap:4px;` + (statusStyle[tag.status] || '');
                span.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span>${this._esc(tag.name)}`;
                if (data.tags.liveAvailable) {
                    const hint   = document.createElement('span');
                    hint.style   = 'font-size:0.65rem;opacity:0.75;';
                    hint.textContent = statusLabel[tag.status] || '';
                    span.appendChild(hint);
                }
                tagsEl.appendChild(span);
            });

            if (data.tags.external.length) {
                const label       = document.createElement('div');
                label.className   = 'w-full text-xs text-gray-400 mt-1 mb-1';
                label.textContent = 'Tags in Paperless not set by AI:';
                extTagsEl.appendChild(label);
                data.tags.external.forEach(tag => {
                    const color = tag.color ? `#${tag.color.replace('#','')}` : '#6b7280';
                    const span  = document.createElement('span');
                    span.style  = `padding:3px 10px;border-radius:9999px;font-size:0.75rem;display:inline-flex;align-items:center;gap:4px;` + statusStyle.added_externally;
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
            const cfSection = document.getElementById('infoModalCustomFieldsSection');
            const cfEl      = document.getElementById('infoModalCustomFields');
            const cf        = data.history.custom_fields;

            if (!cf || (Array.isArray(cf) && cf.length === 0) ||
                (typeof cf === 'object' && !Array.isArray(cf) && Object.keys(cf).length === 0)) {
                cfEl.innerHTML = '<span class="text-gray-400 text-sm">No custom fields were detected or applied for this document</span>';
            } else {
                const items = Array.isArray(cf) ? cf : Object.values(cf);
                cfEl.innerHTML = items.map(item => {
                    const name  = this._esc(item.field_name || item.name || 'Unknown field');
                    const value = this._esc(String(item.value ?? ''));
                    return `<div class="flex gap-2 py-1 border-b border-gray-100">
                        <span class="font-medium text-gray-700 min-w-[140px]">${name}</span>
                        <span class="text-gray-600">${value}</span>
                    </div>`;
                }).join('');
            }

            // --- Processed At ---
            document.getElementById('infoModalProcessedAt').textContent =
                data.history.created_at ? new Date(data.history.created_at).toLocaleString() : 'Unknown';

            // --- Token Usage ---
            const tokensSection = document.getElementById('infoModalTokensSection');
            const tokensEl      = document.getElementById('infoModalTokens');
            if (data.metrics) {
                tokensSection.style.display = 'block';
                tokensEl.innerHTML = [
                    ['Prompt',     data.metrics.promptTokens],
                    ['Completion', data.metrics.completionTokens],
                    ['Total',      data.metrics.totalTokens]
                ].map(([label, val]) =>
                    `<span class="px-3 py-1 rounded bg-gray-100 text-gray-700">
                        <span class="font-medium">${label}:</span> ${(val ?? 0).toLocaleString()}
                    </span>`
                ).join('');
            } else {
                tokensSection.style.display = 'none';
            }

            // --- Original State ---
            const origSection = document.getElementById('infoModalOriginalSection');
            const restoreBtn  = document.getElementById('infoModalRestoreBtn');
            const origContent = document.getElementById('infoModalOriginalContent');
            if (data.original) {
                origSection.style.display = 'block';
                restoreBtn.style.display  = 'inline-flex';
                const tagCount = Array.isArray(data.original.tags) ? data.original.tags.length : 0;
                origContent.innerHTML = [
                    `<div class="flex gap-2 py-1 border-b border-gray-100">
                        <span class="font-medium text-gray-700 min-w-[140px]">Title</span>
                        <span class="text-gray-600">${this._esc(data.original.title || '\u2013')}</span>
                    </div>`,
                    `<div class="flex gap-2 py-1 border-b border-gray-100">
                        <span class="font-medium text-gray-700 min-w-[140px]">Correspondent</span>
                        <span class="text-gray-600">${data.original.correspondent ? `ID ${data.original.correspondent}` : 'None'}</span>
                    </div>`,
                    `<div class="flex gap-2 py-1 border-b border-gray-100">
                        <span class="font-medium text-gray-700 min-w-[140px]">Tags</span>
                        <span class="text-gray-600">${tagCount} tag${tagCount !== 1 ? 's' : ''} (IDs: ${this._esc(data.original.tags.join(', ') || 'none')})</span>
                    </div>`,
                    data.original.documentType != null ? `<div class="flex gap-2 py-1 border-b border-gray-100">
                        <span class="font-medium text-gray-700 min-w-[140px]">Document Type</span>
                        <span class="text-gray-600">ID ${data.original.documentType}</span>
                    </div>` : '',
                    data.original.language ? `<div class="flex gap-2 py-1">
                        <span class="font-medium text-gray-700 min-w-[140px]">Language</span>
                        <span class="text-gray-600">${this._esc(data.original.language)}</span>
                    </div>` : ''
                ].filter(Boolean).join('');
            } else {
                origSection.style.display = 'none';
                restoreBtn.style.display  = 'none';
            }

            loading.style.display = 'none';
            body.style.display    = 'block';
        } catch (err) {
            console.error('Error loading info modal:', err);
            loading.innerHTML = `<div class="text-red-500 py-4">
                <i class="fas fa-exclamation-triangle text-3xl mb-2"></i>
                <div>Failed to load details: ${this._esc(err.message)}</div>
            </div>`;
        }
    }

    _esc(str) {
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
        const btn      = document.getElementById('infoModalRestoreBtn');
        const origHtml = btn?.innerHTML;
        if (!confirm('Restore this document to its original state (before AI processing)?\nThis will overwrite the current title, tags, correspondent, document type and language in Paperless-ngx.')) {
            return;
        }
        if (btn) {
            btn.disabled  = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Restoring...';
        }
        try {
            const res = await fetch(`/api/history/${documentId}/restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Restore failed');

            this.hideModal(document.getElementById('infoModal'));
            this.showToast('Document restored to its original state.', 'success');
            this.table?.ajax.reload();
        } catch (err) {
            console.error('Restore failed:', err);
            this.showToast('Restore failed: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled  = false;
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
            btn.disabled  = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rescanning...';
        }

        try {
            // Reprocess the selected documents directly, bypassing the scan tag
            // filter (the backend clears their local record and enqueues them).
            const response = await fetch('/api/history/rescan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids })
            });
            if (!response.ok) throw new Error('Rescan request failed');

            await this.table.ajax.reload();
            this.showToast(`${ids.length} document(s) sent for rescan. It might take a few moments to process.`, 'success');
        } catch (err) {
            console.error('Bulk rescan failed:', err);
            this.showToast('Rescan failed. Please try again.', 'error');
        } finally {
            if (btn) {
                btn.disabled  = false;
                btn.innerHTML = origHtml;
            }
        }
    }

    async rescanDocument(documentId) {
        const btn = document.getElementById('infoModalRescanBtn');
        const origHtml = btn?.innerHTML;
        if (btn) {
            btn.disabled   = true;
            btn.innerHTML  = '<i class="fas fa-spinner fa-spin mr-1"></i> Rescanning...';
        }

        try {
            // Reprocess directly, bypassing the scan tag filter. The backend
            // clears the local record and enqueues the document for processing.
            const resetRes = await fetch(`/api/history/${documentId}/rescan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!resetRes.ok) throw new Error('Reset failed');

            // Close modal & show toast
            this.hideModal(document.getElementById('infoModal'));
            this.showToast('Document sent for rescan. It might take a few moments to process.', 'success');

            // Reload table
            this.table?.ajax.reload();
        } catch (err) {
            console.error('Rescan failed:', err);
            this.showToast('Rescan failed. Please try again.', 'error');
        } finally {
            if (btn) {
                btn.disabled  = false;
                btn.innerHTML = origHtml;
            }
        }
    }

    showToast(message, type = 'success') {
        const toast   = document.getElementById('toastNotification');
        const inner   = document.getElementById('toastInner');
        const icon    = document.getElementById('toastIcon');
        const msgEl   = document.getElementById('toastMessage');

        msgEl.textContent  = message;
        icon.className     = type === 'success' ? 'fas fa-check-circle' : 'fas fa-exclamation-circle';
        inner.className    = `${type === 'success' ? 'bg-green-500' : 'bg-red-500'} text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-3`;

        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 4000);
    }

    // ────────────────────────────────────────────────────────────────────────────

    async forceReloadFilters() {
        const btn = document.getElementById('forceReloadBtn');
        const icon = btn.querySelector('i');
        
        // Add spinning animation
        icon.classList.add('fa-spin');
        btn.disabled = true;
        
        try {
            // Clear cache on server
            const response = await fetch('/api/history/clear-cache', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) throw new Error('Failed to clear cache');
            
            // Reload the entire page to get fresh data
            window.location.reload();
        } catch (error) {
            console.error('[ERROR] Force reload failed:', error);
            alert('Failed to reload filters. Please try again.');
            icon.classList.remove('fa-spin');
            btn.disabled = false;
        }
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.historyManager = new HistoryManager();
});