/**
 * The manual page: one document from Paperless-ngx with its file, text and
 * fields, the actions on it (OCR, unlock, AI analysis, ignore, delete), and a
 * list to step through with Next and Previous.
 *
 * A classic script: it reaches the kernel's toast through window.__zrToast,
 * the dialogs through window.zrDialog and the OCR run overlay through
 * window.zrOcrProgress.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const FIELDS = {
    title: 'fieldTitle',
    correspondent: 'fieldCorrespondent',
    documentType: 'fieldDocumentType',
    created: 'fieldCreated',
  };

  const state = {
    doc: null,
    view: 'preview',
    suggestion: null,
    availableTags: [],
    unlockSupported: true,
    ocrEnabled: false,
    worklist: { list: '', documents: [] },
    busy: false,
    // The id of the document being fetched, and whether the preview frame is
    // still fetching its PDF: either one shows the loading line over the viewer.
    fetching: null,
    framePending: false,
  };

  // Each loadDocument() call takes a number; an answer that arrives after a
  // later call started is dropped, so a fast Next does not show an older one.
  let loadSeq = 0;

  // How often the page asks whether Paperless-ngx has stored the unlocked
  // version of the document it shows.
  const UNLOCK_CHECK_MS = 10000;
  const STORING_UNLOCKED =
    'Paperless-ngx is still storing the unlocked version.';
  let unlockTimer = null;

  // A browser set to download PDFs instead of showing them never fires the
  // frame's load event; after this long the loading line gives up.
  const FRAME_WAIT_MS = 30000;
  let frameTimer = null;

  function toast(message, type = 'success') {
    if (typeof window.__zrToast !== 'function') return;
    window.__zrToast(message, { tone: type === 'error' ? 'danger' : 'ok' });
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      const error =
        data.error ||
        (Array.isArray(data.errors) && data.errors.join(', ')) ||
        data.message ||
        `Request failed (HTTP ${response.status})`;
      throw new Error(error);
    }
    return data;
  }

  const post = (url, body = {}) =>
    request(url, { method: 'POST', body: JSON.stringify(body) });

  // --- lookups -------------------------------------------------------------

  async function loadTags() {
    try {
      const tags = await request('/manual/tags');
      state.availableTags = Array.isArray(tags) ? tags : [];
      const select = $('newTagSelect');
      select.innerHTML = '<option value="">Select a tag...</option>';
      state.availableTags
        .slice()
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .forEach((tag) => {
          const option = document.createElement('option');
          option.value = tag.name;
          option.textContent = tag.name;
          select.appendChild(option);
        });
    } catch (error) {
      toast(`Tags could not be loaded: ${error.message}`, 'error');
    }
  }

  function fillDatalist(id, names) {
    const list = $(id);
    list.innerHTML = '';
    names.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      list.appendChild(option);
    });
  }

  async function loadVocabulary() {
    try {
      const { data } = await request('/manual/vocabulary');
      fillDatalist('correspondentNames', data.correspondents || []);
      fillDatalist('documentTypeNames', data.documentTypes || []);
    } catch {
      // Without the names the fields still take free text.
    }
  }

  async function loadUnlockStatus() {
    try {
      const { data } = await request('/api/ocr/unlock/status');
      state.unlockSupported = !!data.supported;
    } catch {
      state.unlockSupported = true;
    }
  }

  // --- the document --------------------------------------------------------

  function statusBadge(doc) {
    const s = doc.status || {};
    const badge = (tone, text, icon) =>
      `<span class="zr-badge${tone ? ` zr-badge--${tone}` : ''}">` +
      (icon
        ? `<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#${icon}"/></svg> `
        : '') +
      `${escapeHtml(text)}</span>`;
    if (s.ignored) return badge('warn', 'Ignored', 'i-eye-off');
    if (doc.locked) return badge('warn', 'Password protected', 'i-key');
    if (s.failedReason) return badge('danger', `Failed: ${s.failedReason}`);
    if (s.ocrStatus) return badge('info', `OCR queue: ${s.ocrStatus}`);
    if (s.processedAt) {
      return badge(
        'ok',
        `Processed ${window.zrDate.format(s.processedAt, { fallback: '' })}`
      );
    }
    return badge('', 'Not processed');
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function renderFacts(doc) {
    $('docFacts').classList.remove('hidden');
    $('factAdded').textContent = window.zrDate.format(doc.added, {
      fallback: '–',
    });
    const file = [doc.originalFileName, pagesLabel(doc.pageCount)]
      .filter(Boolean)
      .join(' · ');
    $('factFile').textContent = file || '–';
    $('factAsn').textContent =
      doc.archiveSerialNumber != null ? String(doc.archiveSerialNumber) : '–';
    $('factStatus').innerHTML = statusBadge(doc);
    $('docIdLabel').textContent = `#${doc.id}`;
    const link = $('paperlessLink');
    link.classList.toggle('hidden', !doc.paperlessLink);
    if (doc.paperlessLink) link.href = doc.paperlessLink;
  }

  function pagesLabel(count) {
    if (!count) return '';
    return count === 1 ? '1 page' : `${count} pages`;
  }

  function canPreview(doc) {
    return (
      !doc.locked &&
      (doc.hasArchive ||
        /^(application\/pdf|image\/|text\/plain)/.test(doc.mimeType || ''))
    );
  }

  function showEmpty(title, text) {
    $('viewerEmptyTitle').textContent = title;
    $('viewerEmptyText').textContent = text;
    $('viewerEmpty').classList.remove('hidden');
  }

  function renderLoading() {
    const pdf = state.framePending && state.view === 'preview';
    const show = !!state.fetching || pdf;
    $('viewerLoading').classList.toggle('hidden', !show);
    $('viewerLoadingText').textContent = state.fetching
      ? `Loading document #${state.fetching}...`
      : 'Loading the preview...';
    $('manualViewer').setAttribute('aria-busy', String(show));
  }

  function renderViewer() {
    renderViewerContent();
    renderLoading();
  }

  function renderViewerContent() {
    const doc = state.doc;
    const frame = $('previewFrame');
    const text = $('contentPreview');
    $('tabPreview').setAttribute('aria-selected', state.view === 'preview');
    $('tabText').setAttribute('aria-selected', state.view === 'text');
    frame.classList.add('hidden');
    text.classList.add('hidden');
    $('viewerEmpty').classList.add('hidden');
    $('viewerMeta').textContent = '';

    if (!doc) {
      // While the first document is on the way the loading line says enough.
      if (!state.fetching) {
        showEmpty('No document selected', 'Search above and pick a document.');
      }
      return;
    }

    if (state.view === 'preview') {
      if (!canPreview(doc)) {
        state.framePending = false;
        showEmpty(
          doc.locked ? 'No preview for a locked PDF' : 'No preview',
          doc.unlocking
            ? STORING_UNLOCKED
            : doc.locked
              ? 'Unlock it first.'
              : 'Paperless-ngx keeps no PDF of this file. Its text is under Text.'
        );
        return;
      }
      const src = `/manual/file/${doc.id}`;
      if (frame.getAttribute('src') !== src) {
        state.framePending = true;
        clearTimeout(frameTimer);
        frameTimer = setTimeout(onFrameLoad, FRAME_WAIT_MS);
        frame.setAttribute('src', src);
      }
      frame.classList.remove('hidden');
      $('viewerMeta').textContent = pagesLabel(doc.pageCount);
      return;
    }

    const content = doc.content || '';
    if (!content.trim()) {
      showEmpty(
        'Paperless-ngx has no text for this document',
        doc.unlocking
          ? STORING_UNLOCKED
          : doc.locked
            ? 'Unlock it first, then run OCR.'
            : state.ocrEnabled
              ? 'Run OCR to read it.'
              : 'Turn on OCR under Settings to read it.'
      );
      return;
    }
    text.textContent = content;
    text.classList.remove('hidden');
    $('viewerMeta').textContent =
      `${content.length.toLocaleString('en-US')} characters`;
  }

  function setView(view) {
    state.view = view;
    renderViewer();
  }

  function renderFields(doc) {
    $(FIELDS.title).value = doc.title || '';
    $(FIELDS.correspondent).value = doc.correspondent || '';
    $(FIELDS.documentType).value = doc.documentType || '';
    $(FIELDS.created).value = String(doc.created || '').slice(0, 10);
    const tags = $('currentTags');
    tags.innerHTML = '';
    (doc.tags || []).forEach((name) => tags.appendChild(tagChip(name)));
    $('suggestedTags').innerHTML = '';
    clearSuggestions();
  }

  function renderActions(doc) {
    const has = !!doc;
    const locked = has && doc.locked;
    const hasText = has && !!(doc.content || '').trim();

    // Unlocked a moment ago, but Paperless-ngx is still storing the unlocked
    // version: say that instead of asking for the password again.
    const unlocking = locked && !!doc.unlocking;

    $('unlockBox').classList.toggle('hidden', !locked);
    $('unlockForm').classList.toggle('hidden', unlocking);
    $('unlockTitle').textContent = unlocking
      ? 'Unlocked, waiting for Paperless-ngx'
      : 'This PDF needs a password';
    $('unlockBtn').disabled = !state.unlockSupported;
    $('unlockHint').textContent = unlocking
      ? `${STORING_UNLOCKED} This page shows the document as soon as it is there.`
      : state.unlockSupported
        ? 'None of the stored passwords opens it. Unlock it, then run OCR.'
        : 'Unlocking needs Paperless-ngx 3.0 or later.';

    $('ocrBtn').disabled = !has || locked || !state.ocrEnabled;
    $('ocrHint').classList.toggle('hidden', state.ocrEnabled);
    $('analyzeBtn').disabled = !has || !hasText;
    $('analyzeBtn').title =
      has && !hasText ? 'The document has no text yet.' : '';
    $('ignoreBtn').disabled = !has;
    $('ignoreLabel').textContent =
      has && doc.status?.ignored ? 'Unignore' : 'Ignore';
    $('deleteBtn').disabled = !has;
    $('saveBtn').disabled = !has;
    ['newTagSelect', 'addTagBtn', ...Object.values(FIELDS)].forEach((id) => {
      $(id).disabled = !has;
    });
  }

  async function loadDocument(id) {
    const documentId = Number(id);
    if (!Number.isInteger(documentId) || documentId <= 0) return;
    const seq = ++loadSeq;
    state.fetching = documentId;
    renderViewer();
    try {
      const doc = await request(`/manual/preview/${documentId}`);
      if (seq !== loadSeq) return;
      state.fetching = null;
      state.doc = doc;
      watchUnlock(doc);
      state.suggestion = null;
      $('manualDocumentSearchInput').value = doc.title || `Document ${doc.id}`;
      renderFacts(doc);
      renderFields(doc);
      renderActions(doc);
      renderViewer();
      updateWorklistPosition();
      updateUrl();
    } catch (error) {
      if (seq !== loadSeq) return;
      state.fetching = null;
      renderViewer();
      toast(
        `Document ${documentId} could not be loaded: ${error.message}`,
        'error'
      );
    }
  }

  // The frame's load event also fires when Paperless-ngx answers with an
  // error, so the loading line never stays up for good.
  function onFrameLoad() {
    clearTimeout(frameTimer);
    if (!state.framePending) return;
    state.framePending = false;
    renderLoading();
  }

  const reloadDocument = () => state.doc && loadDocument(state.doc.id);

  // While Paperless-ngx stores the unlocked version, ask now and then whether
  // it is there, and load the document anew once it is. The check leaves the
  // page alone until then, so nothing typed into the fields is lost.
  function watchUnlock(doc) {
    clearTimeout(unlockTimer);
    if (!doc || !doc.unlocking) return;
    unlockTimer = setTimeout(async () => {
      const current = () => state.doc && state.doc.id === doc.id;
      if (!current()) return;
      try {
        const fresh = await request(`/manual/preview/${doc.id}`);
        if (!current()) return;
        if (!fresh.unlocking) {
          loadDocument(doc.id);
          return;
        }
      } catch {
        // Paperless-ngx is busy or away; the next check asks again.
      }
      if (current()) watchUnlock(state.doc);
    }, UNLOCK_CHECK_MS);
  }

  function clearDocument() {
    clearTimeout(unlockTimer);
    state.doc = null;
    state.suggestion = null;
    state.framePending = false;
    $('docFacts').classList.add('hidden');
    $('docIdLabel').textContent = '';
    $('paperlessLink').classList.add('hidden');
    $('previewFrame').removeAttribute('src');
    $('manualDocumentSearchInput').value = '';
    Object.values(FIELDS).forEach((fid) => {
      $(fid).value = '';
    });
    $('currentTags').innerHTML = '';
    $('suggestedTags').innerHTML = '';
    clearSuggestions();
    renderActions(null);
    renderViewer();
    updateWorklistPosition();
    updateUrl();
  }

  // --- tags ----------------------------------------------------------------

  function chipButton(icon, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'zr-link';
    button.setAttribute('aria-label', label);
    button.innerHTML = `<svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#${icon}"/></svg>`;
    button.addEventListener('click', onClick);
    return button;
  }

  function currentTagNames() {
    return Array.from($('currentTags').children).map((el) => el.dataset.tag);
  }

  function addTag(name) {
    if (!name || currentTagNames().includes(name)) return;
    $('currentTags').appendChild(tagChip(name));
  }

  function tagChip(name, suggested = false) {
    const chip = document.createElement('div');
    chip.className = suggested ? 'zr-chip manual-chip--suggested' : 'zr-chip';
    chip.dataset.tag = name;
    const label = document.createElement('span');
    label.textContent = name;
    chip.appendChild(label);
    if (suggested) {
      chip.appendChild(
        chipButton('i-plus', `Add ${name}`, () => {
          addTag(name);
          chip.remove();
        })
      );
    }
    chip.appendChild(
      chipButton('i-x', suggested ? `Dismiss ${name}` : `Remove ${name}`, () =>
        chip.remove()
      )
    );
    return chip;
  }

  // --- AI suggestions ------------------------------------------------------

  function clearSuggestions() {
    document.querySelectorAll('[data-suggest]').forEach((el) => {
      el.classList.add('hidden');
      el.innerHTML = '';
    });
    $('useAllBtn').classList.add('hidden');
  }

  // One line under a field: the AI's value and a button to take it. Shown
  // only where the value differs from what the field holds.
  function renderSuggestions() {
    const s = state.suggestion;
    clearSuggestions();
    if (!s) return;
    let open = 0;
    Object.entries(FIELDS).forEach(([key, fieldId]) => {
      const value = s[key];
      const line = document.querySelector(`[data-suggest="${key}"]`);
      if (!value || value === $(fieldId).value) return;
      open += 1;
      line.innerHTML =
        '<span>AI:</span> <span class="manual-suggest__value"></span>';
      line.querySelector('.manual-suggest__value').textContent = value;
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'zr-link zr-link--underline';
      use.textContent = 'Use';
      use.addEventListener('click', () => {
        $(fieldId).value = value;
        renderSuggestions();
      });
      line.appendChild(use);
      line.classList.remove('hidden');
    });
    if (open || $('suggestedTags').children.length) {
      $('useAllBtn').classList.remove('hidden');
    }
  }

  // Drawn once per analysis; a dismissed suggestion stays dismissed.
  function renderTagSuggestions() {
    const tags = $('suggestedTags');
    tags.innerHTML = '';
    (state.suggestion?.tags || [])
      .filter((name) => !currentTagNames().includes(name))
      .forEach((name) => tags.appendChild(tagChip(name, true)));
  }

  function useAllSuggestions() {
    const s = state.suggestion;
    if (!s) return;
    Object.entries(FIELDS).forEach(([key, fieldId]) => {
      if (s[key]) $(fieldId).value = s[key];
    });
    (s.tags || []).forEach(addTag);
    $('suggestedTags').innerHTML = '';
    renderSuggestions();
  }

  async function analyze() {
    const doc = state.doc;
    if (!doc || $('analyzeBtn').disabled || state.busy) return;
    state.busy = true;
    $('aiStatus').classList.remove('hidden');
    $('analyzeBtn').disabled = true;
    try {
      const result = await post('/manual/analyze', {
        content: String(doc.content || '').slice(0, 50000),
        id: doc.id,
      });
      const d = result.document || {};
      state.suggestion = {
        title: d.title || '',
        correspondent: d.correspondent || '',
        documentType: d.document_type || '',
        created: /^\d{4}-\d{2}-\d{2}/.test(d.document_date || '')
          ? d.document_date.slice(0, 10)
          : '',
        tags: Array.isArray(d.tags) ? d.tags.filter(Boolean) : [],
      };
      renderTagSuggestions();
      renderSuggestions();
      toast('Analysis done. Take what fits, then save.');
    } catch (error) {
      toast(`Analysis failed: ${error.message}`, 'error');
    } finally {
      state.busy = false;
      $('aiStatus').classList.add('hidden');
      renderActions(state.doc);
    }
  }

  // --- actions -------------------------------------------------------------

  async function save() {
    const doc = state.doc;
    if (!doc || state.busy) return;
    state.busy = true;
    $('saveBtn').disabled = true;
    try {
      await post('/manual/updateDocument', {
        documentId: doc.id,
        title: $(FIELDS.title).value.trim(),
        correspondent: $(FIELDS.correspondent).value.trim() || null,
        documentType: $(FIELDS.documentType).value.trim() || null,
        created: $(FIELDS.created).value || null,
        tags: currentTagNames(),
      });
      toast('Saved to Paperless-ngx.');
      await reloadDocument();
    } catch (error) {
      toast(`Saving failed: ${error.message}`, 'error');
    } finally {
      state.busy = false;
      renderActions(state.doc);
    }
  }

  async function runOcr() {
    const doc = state.doc;
    if (!doc || $('ocrBtn').disabled) return;
    try {
      await post('/api/ocr/queue/add', { documentId: doc.id });
    } catch (error) {
      toast(`OCR could not be started: ${error.message}`, 'error');
      return;
    }
    // No analysis afterwards: on this page a person reviews before saving.
    window.zrOcrProgress.run({
      url: `/api/ocr/process/${doc.id}`,
      body: { autoAnalyze: false },
      title: `OCR for document #${doc.id}`,
      onDone: () => {
        state.view = 'text';
        reloadDocument();
      },
    });
  }

  async function unlock() {
    const doc = state.doc;
    if (!doc) return;
    const password = $('unlockPassword').value;
    $('unlockBtn').disabled = true;
    try {
      const result = await post(
        `/api/ocr/unlock/${doc.id}`,
        password ? { password } : {}
      );
      $('unlockPassword').value = '';
      toast(result.message || 'Unlocked.');
      await reloadDocument();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      renderActions(state.doc);
    }
  }

  async function toggleIgnore() {
    const doc = state.doc;
    if (!doc) return;
    try {
      if (doc.status?.ignored) {
        await request(`/api/ignored/${doc.id}`, { method: 'DELETE' });
        toast('The scan may process this document again.');
      } else {
        await post('/api/ignored/add', {
          documentId: doc.id,
          title: doc.title || '',
        });
        toast('Ignored. The scan leaves this document alone.');
      }
      await reloadDocument();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function remove() {
    const doc = state.doc;
    if (!doc || typeof window.zrDialog !== 'function') return;
    const answer = await window.zrDialog({
      title: `Delete document #${doc.id}?`,
      text: `“${doc.title || `Document ${doc.id}`}” is deleted in Paperless-ngx. Paperless-ngx 2.10 and later keep it in their trash for a while.`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Delete',
    });
    if (!answer.isConfirmed) return;
    try {
      await request(`/manual/document/${doc.id}`, { method: 'DELETE' });
      toast('Document deleted.');
      const list = state.worklist.documents;
      const index = list.findIndex((d) => d.id === doc.id);
      if (index >= 0) {
        list.splice(index, 1);
        const next = list[index] || list[index - 1];
        if (next) {
          await loadDocument(next.id);
          return;
        }
      }
      clearDocument();
    } catch (error) {
      toast(`Deleting failed: ${error.message}`, 'error');
    }
  }

  // --- the list to work through -------------------------------------------

  function worklistIndex() {
    if (!state.doc) return -1;
    return state.worklist.documents.findIndex((d) => d.id === state.doc.id);
  }

  function updateWorklistPosition() {
    const { list, documents } = state.worklist;
    const index = worklistIndex();
    const position = $('worklistPosition');
    if (!list) {
      position.textContent = '';
    } else if (!documents.length) {
      position.textContent = 'none';
    } else {
      position.textContent = `${index >= 0 ? index + 1 : '–'} / ${documents.length}`;
    }
    $('prevBtn').disabled = !list || index <= 0;
    $('nextBtn').disabled =
      !list || !documents.length || index >= documents.length - 1;
  }

  async function loadWorklist(list, { openFirst = true } = {}) {
    state.worklist = { list, documents: [] };
    updateWorklistPosition();
    updateUrl();
    if (!list) return;
    $('worklistPosition').textContent = '…';
    try {
      const { data } = await request(
        `/manual/worklist?list=${encodeURIComponent(list)}`
      );
      state.worklist.documents = data.documents || [];
    } catch (error) {
      toast(`The list could not be loaded: ${error.message}`, 'error');
    }
    updateWorklistPosition();
    if (openFirst && worklistIndex() < 0 && state.worklist.documents.length) {
      await loadDocument(state.worklist.documents[0].id);
    }
  }

  function step(delta) {
    const { documents } = state.worklist;
    if (!documents.length) return;
    const index = worklistIndex();
    const target = documents[index < 0 ? 0 : index + delta];
    if (target) loadDocument(target.id);
  }

  function updateUrl() {
    const params = new URLSearchParams();
    if (state.doc) params.set('id', state.doc.id);
    if (state.worklist.list) params.set('list', state.worklist.list);
    const query = params.toString();
    history.replaceState(null, '', query ? `/manual?${query}` : '/manual');
  }

  // --- keys ----------------------------------------------------------------

  const KEYS = {
    a: () => analyze(),
    s: () => !$('saveBtn').disabled && save(),
    n: () => !$('nextBtn').disabled && step(1),
    p: () => !$('prevBtn').disabled && step(-1),
  };

  function onKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (
      target.closest('input, textarea, select, [contenteditable]') ||
      document.querySelector('dialog[open]')
    ) {
      return;
    }
    const action = KEYS[event.key.toLowerCase()];
    if (!action) return;
    event.preventDefault();
    action();
  }

  // --- start ---------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', async () => {
    state.ocrEnabled = $('manualPage').dataset.ocrEnabled === 'yes';

    window.createDocumentOmnibox({
      preset: 'manual',
      inputId: 'manualDocumentSearchInput',
      resultsId: 'manualDocumentSearchResults',
      statusId: 'manualDocumentSearchStatus',
      hiddenInputId: 'documentSelect',
      limit: 100,
      debounceMs: 250,
      resultItemClass: 'manual-search-item',
      resultTitleClass: 'manual-search-title',
      resultMetaClass: 'manual-search-meta',
      resultPillClass: 'manual-search-pill',
      onSelect: (doc) => loadDocument(doc.id),
    });

    $('previewFrame').addEventListener('load', onFrameLoad);
    $('tabPreview').addEventListener('click', () => setView('preview'));
    $('tabText').addEventListener('click', () => setView('text'));
    $('analyzeBtn').addEventListener('click', analyze);
    $('saveBtn').addEventListener('click', save);
    $('useAllBtn').addEventListener('click', useAllSuggestions);
    $('ocrBtn').addEventListener('click', runOcr);
    $('unlockBtn').addEventListener('click', unlock);
    $('unlockPassword').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') unlock();
    });
    $('ignoreBtn').addEventListener('click', toggleIgnore);
    $('deleteBtn').addEventListener('click', remove);
    $('addTagBtn').addEventListener('click', () => {
      addTag($('newTagSelect').value);
      $('newTagSelect').value = '';
    });
    $('worklistSelect').addEventListener('change', (event) =>
      loadWorklist(event.target.value)
    );
    $('prevBtn').addEventListener('click', () => step(-1));
    $('nextBtn').addEventListener('click', () => step(1));
    Object.values(FIELDS).forEach((id) =>
      $(id).addEventListener('input', renderSuggestions)
    );
    document.addEventListener('keydown', onKey);

    renderActions(null);
    renderViewer();
    loadTags();
    loadVocabulary();

    // A link from another page: /manual?id=123&list=failed. The document, its
    // list and the unlock status load side by side, so the loading line shows
    // at once instead of after the other two.
    const params = new URLSearchParams(location.search);
    const list = params.get('list') || '';
    const id = params.get('id');
    const pending = [loadUnlockStatus()];
    if (
      list &&
      $('worklistSelect').querySelector(`option[value="${CSS.escape(list)}"]`)
    ) {
      $('worklistSelect').value = list;
      pending.push(loadWorklist(list, { openFirst: !id }));
    }
    if (id) pending.push(loadDocument(id));
    await Promise.all(pending);
    renderActions(state.doc);
  });
})();
