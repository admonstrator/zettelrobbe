(function () {
    'use strict';

    function defaultGetTitle(doc) {
        return doc && doc.title ? doc.title : `Document ${doc && doc.id ? doc.id : ''}`;
    }

    function defaultFormatDate(createdValue) {
        if (!createdValue) {
            return 'Unknown date';
        }

        const parsedDate = new Date(createdValue);
        if (Number.isNaN(parsedDate.getTime())) {
            return String(createdValue).slice(0, 10) || 'Unknown date';
        }

        const year = parsedDate.getFullYear();
        const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
        const day = String(parsedDate.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    const DOCUMENT_OMNIBOX_PRESETS = {
        default: {
            searchingMessage: 'Searching documents...',
            noResultsMessage: 'No matching documents found.',
            loadErrorMessage: 'Could not load documents. Please try again.',
            initialStatusMessage: 'Type to search documents...',
            selectedStatusFormatter: (doc) => `Selected: ${defaultGetTitle(doc)}`,
            availableStatusFormatter: () => ''
        },
        chat: {
            searchingMessage: 'Searching documents...',
            noResultsMessage: 'No matching documents found.',
            loadErrorMessage: 'Could not load documents. Please try again.',
            initialStatusMessage: 'Type to search documents...',
            selectedStatusFormatter: (doc) => `Selected: ${defaultGetTitle(doc)}`,
            availableStatusFormatter: () => ''
        },
        manual: {
            searchingMessage: 'Searching documents...',
            noResultsMessage: 'No matching documents found.',
            loadErrorMessage: 'Could not load documents. Please try again.',
            initialStatusMessage: 'Type to search documents...',
            selectedStatusFormatter: (doc) => `Selected: ${defaultGetTitle(doc)}`,
            availableStatusFormatter: () => ''
        },
        ocr: {
            searchingMessage: 'Searching documents...',
            noResultsMessage: 'No matching documents found.',
            loadErrorMessage: 'Could not load documents. Please try again.',
            initialStatusMessage: 'Type to search documents...',
            selectedStatusFormatter: (doc) => `Selected: ${defaultGetTitle(doc)} (ID ${doc && doc.id ? doc.id : '-'})`,
            availableStatusFormatter: () => ''
        }
    };

    function createDocumentOmnibox(config) {
        const input = document.getElementById(config.inputId);
        const resultsElement = document.getElementById(config.resultsId);
        const statusElement = document.getElementById(config.statusId);
        const hiddenInput = document.getElementById(config.hiddenInputId);

        if (!input || !resultsElement || !statusElement || !hiddenInput) {
            return null;
        }

        const presetName = typeof config.preset === 'string' ? config.preset : 'default';
        const preset = DOCUMENT_OMNIBOX_PRESETS[presetName] || DOCUMENT_OMNIBOX_PRESETS.default;

        const settings = {
            fetchUrl: config.fetchUrl || '/api/chat/documents',
            limit: Number.isInteger(config.limit) ? config.limit : 100,
            debounceMs: Number.isInteger(config.debounceMs) ? config.debounceMs : 250,
            getTitle: typeof config.getTitle === 'function' ? config.getTitle : defaultGetTitle,
            formatDate: typeof config.formatDate === 'function' ? config.formatDate : defaultFormatDate,
            selectedStatusFormatter: typeof config.selectedStatusFormatter === 'function'
                ? config.selectedStatusFormatter
                : preset.selectedStatusFormatter,
            availableStatusFormatter: typeof config.availableStatusFormatter === 'function'
                ? config.availableStatusFormatter
                : preset.availableStatusFormatter,
            searchingMessage: config.searchingMessage || preset.searchingMessage,
            noResultsMessage: config.noResultsMessage || preset.noResultsMessage,
            loadErrorMessage: config.loadErrorMessage || preset.loadErrorMessage,
            initialStatusMessage: config.initialStatusMessage || preset.initialStatusMessage,
            resultItemClass: config.resultItemClass || 'search-result-item',
            resultTitleClass: config.resultTitleClass || 'search-result-title',
            resultMetaClass: config.resultMetaClass || 'search-result-meta',
            resultPillClass: config.resultPillClass || 'search-result-pill',
            filterResults: typeof config.filterResults === 'function' ? config.filterResults : null,
            multiSelect: !!config.multiSelect
        };

        let debounceTimer = null;
        let searchController = null;
        let searchResults = [];
        let activeResultIndex = -1;
        let searchMode = 'all';

        function cancelPendingSearch() {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }

            if (searchController) {
                searchController.abort();
                searchController = null;
            }
        }

        function setStatus(message, isError) {
            statusElement.textContent = message;
            statusElement.classList.toggle('error', !!isError);
        }

        function createMetaPill(text, type) {
            const pill = document.createElement('span');
            pill.className = `${settings.resultPillClass} ${type}`;
            pill.textContent = text;
            return pill;
        }

        function clearResults() {
            resultsElement.innerHTML = '';
            resultsElement.classList.add('hidden');
            searchResults = [];
            activeResultIndex = -1;
        }

        function updateActiveResultHighlight() {
            const items = resultsElement.querySelectorAll(`.${settings.resultItemClass}`);
            items.forEach((item, index) => {
                item.classList.toggle('active', index === activeResultIndex);
            });
        }

        function removeResultRow(doc) {
            const idx = searchResults.indexOf(doc);
            if (idx === -1) return;
            searchResults.splice(idx, 1);
            const items = resultsElement.querySelectorAll(`.${settings.resultItemClass}`);
            if (items[idx]) items[idx].remove();
            if (activeResultIndex >= searchResults.length) {
                activeResultIndex = searchResults.length - 1;
            }
            if (!searchResults.length) {
                resultsElement.classList.add('hidden');
                setStatus(settings.noResultsMessage, false);
            }
        }

        function selectDocument(doc, context) {
            if (!doc) return null;

            if (settings.multiSelect) {
                if (typeof config.onSelect === 'function') {
                    config.onSelect(doc, context || { trigger: 'select' });
                }
                removeResultRow(doc);
                return doc;
            }

            cancelPendingSearch();

            hiddenInput.value = String(doc.id);
            input.dataset.selectedDocumentId = String(doc.id);
            input.value = settings.getTitle(doc);

            clearResults();
            setStatus(settings.selectedStatusFormatter(doc));

            if (typeof config.onSelect === 'function') {
                config.onSelect(doc, context || { trigger: 'select' });
            }

            return doc;
        }

        function renderResults(documents) {
            resultsElement.innerHTML = '';
            searchResults = documents;
            activeResultIndex = -1;

            if (!documents.length) {
                resultsElement.classList.add('hidden');
                return;
            }

            documents.forEach((doc, index) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = settings.resultItemClass;
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', 'false');
                item.dataset.index = String(index);

                const titleElement = document.createElement('div');
                titleElement.className = settings.resultTitleClass;
                titleElement.textContent = settings.getTitle(doc);

                const metaRow = document.createElement('div');
                metaRow.className = settings.resultMetaClass;
                metaRow.appendChild(createMetaPill((doc && doc.correspondent) || 'No correspondent', 'correspondent'));
                metaRow.appendChild(createMetaPill(settings.formatDate(doc && doc.created), 'date'));
                metaRow.appendChild(createMetaPill(`ID ${(doc && doc.id) || '-'}`, 'id'));

                item.appendChild(titleElement);
                item.appendChild(metaRow);

                const tags = Array.isArray(doc && doc.tags) ? doc.tags : [];
                if (tags.length) {
                    const tagRow = document.createElement('div');
                    tagRow.className = settings.resultMetaClass;
                    tags.forEach(tag => tagRow.appendChild(createMetaPill(tag, 'tag')));
                    item.appendChild(tagRow);
                }

                item.addEventListener('mousedown', (event) => {
                    event.preventDefault();
                    selectDocument(doc, { trigger: 'mouse' });
                });

                resultsElement.appendChild(item);
            });

            resultsElement.classList.remove('hidden');
        }

        function selectActiveResult(context) {
            if (activeResultIndex >= 0 && activeResultIndex < searchResults.length) {
                return selectDocument(searchResults[activeResultIndex], context || { trigger: 'keyboard' });
            }

            if (searchResults.length === 1) {
                return selectDocument(searchResults[0], context || { trigger: 'single-result' });
            }

            return null;
        }

        async function load(searchTerm, options) {
            const requestOptions = options || {};
            const showResults = requestOptions.showResults !== false;
            const normalizedSearchTerm = String(searchTerm || '').trim();

            if (!normalizedSearchTerm) {
                cancelPendingSearch();
                clearResults();
                return;
            }

            if (searchController) {
                searchController.abort();
            }

            searchController = new AbortController();

            const params = new URLSearchParams({
                q: normalizedSearchTerm,
                mode: searchMode,
                limit: String(settings.limit)
            });

            setStatus(settings.searchingMessage, false);

            try {
                const response = await fetch(`${settings.fetchUrl}?${params.toString()}`, {
                    method: 'GET',
                    signal: searchController.signal
                });

                if (!response.ok) {
                    throw new Error('Failed to fetch documents');
                }

                const payload = await response.json();
                let documents = Array.isArray(payload && payload.data && payload.data.documents)
                    ? payload.data.documents
                    : [];

                if (settings.filterResults) {
                    documents = settings.filterResults(documents);
                }

                if (showResults) {
                    renderResults(documents);
                }

                if (documents.length === 0) {
                    if (showResults) {
                        clearResults();
                    }
                    setStatus(settings.noResultsMessage, false);
                } else {
                    const availableStatus = settings.availableStatusFormatter(documents.length);
                    setStatus(availableStatus || '', false);
                }
            } catch (error) {
                if (error.name === 'AbortError') {
                    return;
                }

                if (showResults) {
                    clearResults();
                }
                setStatus(settings.loadErrorMessage, true);
            }
        }

        function initialize() {
            setStatus(settings.initialStatusMessage, false);

            input.addEventListener('focus', () => {
                load(input.value.trim(), { showResults: true });
            });

            input.addEventListener('input', () => {
                hiddenInput.value = '';
                input.dataset.selectedDocumentId = '';

                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    load(input.value.trim(), { showResults: true });
                }, settings.debounceMs);
            });

            input.addEventListener('keydown', (event) => {
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    if (searchResults.length === 0) return;
                    activeResultIndex = Math.min(activeResultIndex + 1, searchResults.length - 1);
                    updateActiveResultHighlight();
                    return;
                }

                if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    if (searchResults.length === 0) return;
                    activeResultIndex = Math.max(activeResultIndex - 1, 0);
                    updateActiveResultHighlight();
                    return;
                }

                if (event.key === 'Enter') {
                    event.preventDefault();
                    const selectedDoc = selectActiveResult({ trigger: 'enter' });
                    if (selectedDoc && typeof config.onEnterAfterSelect === 'function') {
                        config.onEnterAfterSelect(selectedDoc);
                    }
                    return;
                }

                if (event.key === 'Escape') {
                    clearResults();
                }
            });

            input.addEventListener('blur', () => {
                window.setTimeout(() => {
                    clearResults();
                }, 120);
            });
        }

        initialize();

        return {
            load,
            clearResults,
            selectActiveResult,
            setStatus,
            getSelectedDocumentId: () => hiddenInput.value.trim(),
            setSelectedDocument: selectDocument,
            setSearchMode: (mode) => { searchMode = mode; }
        };
    }

    window.createDocumentOmnibox = createDocumentOmnibox;
    window.DOCUMENT_OMNIBOX_PRESETS = DOCUMENT_OMNIBOX_PRESETS;
})();
