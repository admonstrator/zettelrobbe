/**
 * Duplicates page — find tags or correspondents that mean the same thing,
 * review why the server thinks so, and merge them in Paperless-ngx.
 *
 * Nothing here starts on its own: a scan runs when the button is used, and a
 * merge runs when the confirm dialog is accepted. Every destructive step names
 * the objects it deletes before it happens and is undoable from the log.
 *
 * Escaping rule for this file
 * ---------------------------
 * All markup is built from template literals, so an interpolation is only ever
 * one of three things:
 *   esc(...)     a value that came from the API, HTML-escaped
 *   num(...) / pct(...)   a finite number, never a string from the API
 *   html...      a local or helper whose name starts with "html" and whose
 *                value is markup this file has already escaped
 * tests/test-duplicates-ui.js checks the file against exactly that rule, so a
 * fourth kind of interpolation fails the build rather than the browser.
 */

import { toast, confirmDialog } from '/js/zr.js';
import { escapeHtml as esc } from '/js/modules/text-utils.js';

/* --- interpolation helpers ------------------------------------------------ */

/** Anything that reaches an attribute or cell as a number, never as text. */
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A 0–1 score as whole percent. */
function pct(score) {
  return Math.round(num(score) * 100);
}

/* --- the wire vocabulary -------------------------------------------------- */
/* The values come from services/entityNameMatcher.js and are contract; only
   the English labels beside them belong to this page. */

const REASON_LABELS = {
  'exact-normalized': 'Same name',
  'umlaut-variant': 'Umlaut spelling',
  'legal-form': 'Legal form',
  plural: 'Singular / plural',
  'token-order': 'Word order',
  prefix: 'Prefix',
  fuzzy: 'Similar spelling',
};

const WARNING_TEXTS = {
  'inbox-tag': 'One of these is an inbox tag; it stays the target.',
  'configured-tag':
    'One of these tags is referenced in the Zettelrobbe settings (processed tag, ignore tags or predefined tags). Check the settings after merging.',
  'no-permission':
    'The API token may not change every object in this group; those are skipped.',
  'has-matching-rule':
    'A source has a matching rule the target lacks; it can be copied to the target.',
  'owner-differs': 'The objects have different owners in Paperless-ngx.',
  'large-group': 'Large group; check every member before merging.',
};

/** Paperless-ngx matching_algorithm. 0 means the object matches nothing by itself. */
const ALGORITHM_LABELS = {
  0: 'none',
  1: 'Any word',
  2: 'All words',
  3: 'Exact match',
  4: 'Regular expression',
  5: 'Fuzzy match',
  6: 'Auto',
};

const KIND_LABELS = { tags: 'Tag', correspondents: 'Correspondent' };
const KIND_PLURALS = { tags: 'tags', correspondents: 'correspondents' };
/** What happens to the documents of a source when it is merged away. */
const KIND_VERBS = { tags: 're-tagged', correspondents: 're-assigned' };

const STATUS_BADGES = {
  done: { tone: 'zr-badge--ok', label: 'done' },
  partial: { tone: 'zr-badge--warn', label: 'partial' },
  undone: { tone: 'zr-badge--info', label: 'undone' },
  undo_failed: { tone: 'zr-badge--danger', label: 'undo failed' },
};

const htmlIcons = {
  tags: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-tag"/></svg>',
  correspondents:
    '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-building"/></svg>',
  warn: '<svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg>',
  ok: '<svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#i-check-circle"/></svg>',
  danger:
    '<svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#i-alert-circle"/></svg>',
  lock: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-shield"/></svg>',
  merge:
    '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-merge"/></svg>',
  undo: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-undo"/></svg>',
  spin: '<svg class="zr-icon zr-icon--sm zr-icon--spin" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg>',
  empty:
    '<svg class="zr-icon zr-icon--lg zr-empty__icon" aria-hidden="true"><use href="/icons.svg#i-merge"/></svg>',
};

const LOG_PAGE_SIZE = 10;

/* --- state ---------------------------------------------------------------- */

const el = {
  kind: document.getElementById('dupKind'),
  sensitivity: document.getElementById('dupSensitivity'),
  includeDismissed: document.getElementById('dupIncludeDismissed'),
  scanBtn: document.getElementById('dupScanBtn'),
  scanIcon: document.getElementById('dupScanIcon'),
  stats: document.getElementById('dupStats'),
  statTags: document.getElementById('dupStatTags'),
  statCorrespondents: document.getElementById('dupStatCorrespondents'),
  statGroups: document.getElementById('dupStatGroups'),
  statDocuments: document.getElementById('dupStatDocuments'),
  results: document.getElementById('dupResults'),
  logMeta: document.getElementById('dupLogMeta'),
  logAlert: document.getElementById('dupLogAlert'),
  logBody: document.getElementById('dupLogBody'),
  logInfo: document.getElementById('dupLogInfo'),
  logMore: document.getElementById('dupLogMoreBtn'),
  dismissalsSummary: document.getElementById('dupDismissalsSummary'),
  dismissalsList: document.getElementById('dupDismissalsList'),
};

/** groupId -> { group, targetId, selected: Set<number> } */
const groups = new Map();
/** id -> the log entry, so the undo dialog can name what it restores. */
const logEntries = new Map();

let paperlessUrl = '';
let scanning = false;
let logOffset = 0;
let logTotal = 0;
let dismissalCount = 0;

/* --- small helpers -------------------------------------------------------- */

function normalizeKind(kind) {
  return kind === 'correspondents' ? 'correspondents' : 'tags';
}

function plural(count, one, many) {
  return num(count) === 1 ? one : many;
}

/**
 * Paperless-ngx stores a tag colour as a hex value. Only that shape is let
 * through — an inline style is the one place on this page where escaping alone
 * would not be enough.
 */
function safeColor(value) {
  const raw = String(value == null ? '' : value).trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(raw) ? raw : '';
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    // A proxy or an auth redirect can answer with something that is not JSON;
    // the status line is then the only thing worth showing.
    payload = null;
  }
  if (!payload) {
    throw new Error(`The server answered ${response.status} without a body.`);
  }
  if (!response.ok && payload.success !== false) {
    throw new Error(payload.error || payload.message || 'Request failed');
  }
  return payload;
}

function postJson(url, body) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* --- markup builders ------------------------------------------------------ */

function htmlAlert(tone, title, body) {
  const htmlIcon = htmlIcons[tone] || htmlIcons.warn;
  const htmlTitle = title
    ? `<div class="zr-alert__title">${esc(title)}</div>`
    : '';
  return `<div class="zr-alert zr-alert--${esc(tone)}">${htmlIcon}<div class="zr-alert__body">${htmlTitle}<p class="zr-sm">${esc(body)}</p></div></div>`;
}

function htmlEmpty(title, hint) {
  return `<div class="zr-module"><div class="zr-empty">${htmlIcons.empty}<div class="zr-empty__title">${esc(title)}</div><p class="zr-sm zr-faint">${esc(hint)}</p></div></div>`;
}

function htmlReasonChips(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  if (list.length === 0) return '';
  const htmlChips = list
    .map(
      (reason) =>
        `<span class="zr-chip">${esc(REASON_LABELS[reason] || reason)}</span>`
    )
    .join('');
  return `<div class="zr-chips dup-group__reasons">${htmlChips}</div>`;
}

function htmlWarnings(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (list.length === 0) return '';
  const htmlRows = list
    .map((warning) => htmlAlert('warn', '', WARNING_TEXTS[warning] || warning))
    .join('');
  return `<div class="dup-group__warnings">${htmlRows}</div>`;
}

function htmlDocumentsLink(kind, member) {
  const count = num(member.documentCount);
  if (!paperlessUrl) {
    return `<span class="zr-mono">${num(count)}</span>`;
  }
  const filter =
    kind === 'correspondents' ? 'correspondent__id=' : 'tags__id__all=';
  const url = paperlessUrl + '/documents?' + filter + String(num(member.id));
  return `<a class="zr-link zr-mono" href="${esc(url)}" target="_blank" rel="noopener">${num(count)}</a>`;
}

function htmlMatchingRule(member) {
  const algorithm = num(member.matchingAlgorithm);
  const label = ALGORITHM_LABELS[algorithm] || 'none';
  const match = String(member.match == null ? '' : member.match).trim();
  if (algorithm === 0 || !match) {
    return '<span class="zr-faint">none</span>';
  }
  return `<span class="dup-member__rule"><span class="zr-sm">${esc(label)}</span><span class="zr-sm zr-faint zr-mono zr-truncate" title="${esc(match)}">${esc(match)}</span></span>`;
}

/**
 * `withDot` is decided per group, not per member: a tag without a colour in a
 * group that has coloured ones still reserves the swatch, or its name starts
 * 17px to the left of every other name in the table.
 */
function htmlMemberName(member, withDot) {
  const color = safeColor(member.color);
  const htmlDot = withDot
    ? `<span class="dup-member__dot" style="background:${esc(color || 'transparent')}"></span>`
    : '';
  const htmlInbox = member.isInboxTag
    ? '<span class="zr-badge zr-badge--info">inbox</span>'
    : '';
  const htmlLock =
    member.userCanChange === false
      ? `<span class="dup-member__lock" title="The API token may not change this object">${htmlIcons.lock}</span>`
      : '';
  const name = String(member.name == null ? '' : member.name);
  return `<span class="zr-row dup-member__name">${htmlDot}<span class="zr-truncate" title="${esc(name)}">${esc(name)}</span>${htmlInbox}${htmlLock}</span>`;
}

function htmlMemberRows(state) {
  const group = state.group;
  const kind = normalizeKind(group.kind);
  const members = Array.isArray(group.members) ? group.members : [];
  const withDot = members.some((member) => safeColor(member.color));
  return members
    .map((member) => {
      const isTarget = num(member.id) === state.targetId;
      // Both are attribute fragments, not values: the "html" prefix is what
      // marks them as already-safe markup for the escaping check.
      const htmlTargetChecked = isTarget ? ' checked' : '';
      const htmlSourceChecked = state.selected.has(num(member.id))
        ? ' checked'
        : '';
      const name = String(member.name == null ? '' : member.name);
      const htmlPick = `<input type="radio" class="zr-check dup-target" name="dupTarget-${esc(group.id)}" value="${num(member.id)}"${htmlTargetChecked} aria-label="Keep ${esc(name)}">`;
      const htmlMerge = isTarget
        ? '<span class="zr-faint">–</span>'
        : `<input type="checkbox" class="zr-check dup-source" value="${num(member.id)}"${htmlSourceChecked} aria-label="Merge ${esc(name)}">`;
      const htmlScore = isTarget
        ? '<span class="zr-faint">target</span>'
        : `<span class="zr-mono">${pct(member.scoreToTarget)}%</span>`;
      return `<tr data-member-id="${num(member.id)}">
        <td data-label="Keep" class="dup-members__pick">${htmlPick}</td>
        <td data-label="Merge" class="dup-members__pick">${htmlMerge}</td>
        <td data-label="Name">${htmlMemberName(member, withDot)}</td>
        <td data-label="Documents" class="dup-members__num">${htmlDocumentsLink(kind, member)}</td>
        <td data-label="Matching rule">${htmlMatchingRule(member)}</td>
        <td data-label="Match" class="dup-members__score">${htmlScore}</td>
      </tr>`;
    })
    .join('');
}

function htmlGroupCard(state) {
  const group = state.group;
  const kind = normalizeKind(group.kind);
  const htmlKindIcon = htmlIcons[kind];
  return `<section class="zr-module dup-group" data-group-id="${esc(group.id)}" data-kind="${esc(kind)}">
    <div class="zr-module__head dup-group__head">
      <span class="zr-badge zr-badge--brand">${htmlKindIcon}${esc(KIND_LABELS[kind])}</span>
      <div class="dup-group__confidence" role="img" aria-label="${pct(group.confidence)} percent match">
        <div class="zr-meter dup-group__meter"><div class="zr-meter__fill" style="width:${pct(group.confidence)}%"></div></div>
        <span class="zr-sm zr-faint">${pct(group.confidence)}% match</span>
      </div>
      ${htmlReasonChips(group.reasons)}
    </div>
    ${htmlWarnings(group.warnings)}
    <div class="dup-group__result"></div>
    <div class="zr-table-wrap">
      <table class="zr-table zr-table--stack dup-members">
        <thead>
          <tr>
            <th class="dup-members__pick">Keep</th>
            <th class="dup-members__pick">Merge</th>
            <th>Name</th>
            <th class="dup-members__num">Documents</th>
            <th>Matching rule</th>
            <th class="dup-members__score" title="Similarity to the suggested target">Match</th>
          </tr>
        </thead>
        <tbody class="dup-members__body">${htmlMemberRows(state)}</tbody>
      </table>
    </div>
    <div class="zr-module__foot dup-group__foot">
      <button type="button" class="zr-btn zr-btn--primary dup-merge-btn"></button>
      <button type="button" class="zr-btn zr-btn--ghost dup-dismiss-btn">Not a duplicate</button>
    </div>
  </section>`;
}

/* --- group behaviour ------------------------------------------------------ */

function memberOf(state, id) {
  return (state.group.members || []).find((m) => num(m.id) === num(id)) || null;
}

function selectedSources(state) {
  return [...state.selected]
    .map((id) => memberOf(state, id))
    .filter((member) => member && num(member.id) !== state.targetId);
}

function updateFoot(card, state) {
  const button = card.querySelector('.dup-merge-btn');
  if (!button) return;
  const target = memberOf(state, state.targetId);
  const name = target ? String(target.name == null ? '' : target.name) : '';
  const sources = selectedSources(state);
  button.innerHTML = `${htmlIcons.merge}<span>Merge into ${esc(name)}</span>`;
  button.disabled =
    sources.length === 0 || (target ? target.userCanChange === false : true);
  button.title =
    target && target.userCanChange === false
      ? 'The API token may not change this object'
      : '';
}

function renderMembers(card, state) {
  const body = card.querySelector('.dup-members__body');
  if (body) body.innerHTML = htmlMemberRows(state);
  updateFoot(card, state);
}

function bindGroup(card) {
  const state = groups.get(card.dataset.groupId);
  if (!state) return;

  card.addEventListener('change', (event) => {
    const input = event.target;
    if (input.classList.contains('dup-target')) {
      // The old target rejoins the sources so nothing silently drops out of
      // the merge when the user changes their mind about who survives.
      const nextTarget = num(input.value);
      state.selected.add(state.targetId);
      state.selected.delete(nextTarget);
      state.targetId = nextTarget;
      renderMembers(card, state);
      return;
    }
    if (input.classList.contains('dup-source')) {
      const id = num(input.value);
      if (input.checked) state.selected.add(id);
      else state.selected.delete(id);
      updateFoot(card, state);
    }
  });

  card.addEventListener('click', (event) => {
    if (event.target.closest('.dup-merge-btn')) {
      mergeGroup(card, state);
    } else if (event.target.closest('.dup-dismiss-btn')) {
      dismissGroup(card, state);
    }
  });

  updateFoot(card, state);
}

/* --- scanning ------------------------------------------------------------- */

function selectedKind() {
  const active = el.kind
    ? el.kind.querySelector('button[aria-selected="true"]')
    : null;
  return active ? active.dataset.kind : 'all';
}

function setScanning(active) {
  scanning = active;
  if (el.scanBtn) el.scanBtn.disabled = active;
  const use = el.scanIcon ? el.scanIcon.querySelector('use') : null;
  if (use) {
    use.setAttribute(
      'href',
      active ? '/icons.svg#i-refresh' : '/icons.svg#i-search'
    );
  }
  if (el.scanIcon) el.scanIcon.classList.toggle('zr-icon--spin', active);
}

function showSkeletons() {
  el.results.innerHTML =
    '<div class="dup-skeletons"><div class="zr-skeleton dup-skeleton"></div><div class="zr-skeleton dup-skeleton"></div><div class="zr-skeleton dup-skeleton"></div></div>';
}

function renderStats(data) {
  const totals = data.totals || {};
  const documents = (data.groups || []).reduce(
    (sum, group) =>
      sum +
      (group.members || []).reduce(
        (inner, member) => inner + num(member.documentCount),
        0
      ),
    0
  );
  el.statTags.textContent =
    totals.tags == null ? '–' : String(num(totals.tags));
  el.statCorrespondents.textContent =
    totals.correspondents == null ? '–' : String(num(totals.correspondents));
  el.statGroups.textContent = String((data.groups || []).length);
  el.statDocuments.textContent = String(documents);
  el.stats.classList.remove('hidden');
}

function renderGroups(list) {
  groups.clear();
  if (!Array.isArray(list) || list.length === 0) {
    el.results.innerHTML = htmlEmpty(
      'No duplicates found',
      'No duplicates found at this sensitivity.'
    );
    return;
  }
  const markup = list
    .map((group) => {
      const targetId = num(group.suggestedTargetId);
      const selected = new Set(
        (group.members || [])
          .map((member) => num(member.id))
          .filter((id) => id !== targetId)
      );
      const state = { group, targetId, selected };
      groups.set(String(group.id), state);
      return htmlGroupCard(state);
    })
    .join('');
  el.results.innerHTML = markup;
  el.results.querySelectorAll('.dup-group').forEach(bindGroup);
}

async function runScan() {
  if (scanning) return;
  setScanning(true);
  showSkeletons();
  try {
    const params = new URLSearchParams({
      kind: selectedKind(),
      threshold: el.sensitivity ? el.sensitivity.value : '0.85',
      includeDismissed:
        el.includeDismissed && el.includeDismissed.checked ? 'true' : 'false',
    });
    const payload = await requestJson(`/api/duplicates/scan?${params}`);
    if (!payload.success) {
      throw new Error(payload.error || 'The scan failed.');
    }
    const data = payload.data || {};
    paperlessUrl = data.paperlessUrl || '';
    renderStats(data);
    renderGroups(data.groups);
  } catch (error) {
    el.results.innerHTML = htmlAlert(
      'danger',
      'The scan failed',
      error.message
    );
  } finally {
    setScanning(false);
  }
}

/* --- merging -------------------------------------------------------------- */

function htmlMergeDialog(state, target, sources, offerCopy) {
  const kind = normalizeKind(state.group.kind);
  const documents = sources.reduce(
    (sum, member) => sum + num(member.documentCount),
    0
  );
  const sentence = `${documents} ${plural(documents, 'document', 'documents')} will be ${KIND_VERBS[kind]}.`;
  const deleted = `${sources.length} ${plural(sources.length, KIND_LABELS[kind].toLowerCase(), KIND_PLURALS[kind])} will be deleted in Paperless-ngx:`;
  const htmlNames = sources
    .map(
      (member) =>
        `<li>${esc(String(member.name == null ? '' : member.name))}</li>`
    )
    .join('');
  const targetName = String(target.name == null ? '' : target.name);
  const htmlCopy = offerCopy
    ? `<label class="dup-dialog__check"><input type="checkbox" class="zr-check" id="dupCopyRule" checked><span>Copy the matching rule to ${esc(targetName)}</span></label>`
    : '';
  return `<p>${esc(sentence)}</p><p>${esc(deleted)}</p><ul class="dup-dialog__list">${htmlNames}</ul><p class="zr-sm dup-dialog__note">${esc('You can undo this from the log below. Restored objects get new ids in Paperless-ngx.')}</p>${htmlCopy}`;
}

function htmlMergeSuccess(result) {
  const kind = normalizeKind(result.kind);
  const target = result.target || {};
  const names = (result.sources || [])
    .filter((source) => source.deleted)
    .map((source) => String(source.name == null ? '' : source.name));
  const moved = num(result.documentsMoved);
  const body = `${moved} ${plural(moved, 'document', 'documents')} moved to ${String(target.name == null ? '' : target.name)}. Deleted in Paperless-ngx: ${names.length ? names.join(', ') : 'nothing'}.`;
  const title = `Merged ${plural(names.length, KIND_LABELS[kind].toLowerCase(), KIND_PLURALS[kind])}`;
  return htmlAlert('ok', title, body);
}

function htmlMergeProblems(result) {
  const failed = (result.sources || []).filter((source) => source.error);
  const htmlRows = failed
    .map(
      (source) =>
        `<li>${esc(String(source.name == null ? '' : source.name))}: ${esc(source.error)}</li>`
    )
    .join('');
  const htmlList = failed.length
    ? `<ul class="dup-dialog__list">${htmlRows}</ul>`
    : '';
  return `<div class="zr-alert zr-alert--danger">${htmlIcons.danger}<div class="zr-alert__body"><div class="zr-alert__title">Not everything could be merged</div><p class="zr-sm">${esc(`${num(result.documentsMoved)} ${plural(result.documentsMoved, 'document', 'documents')} moved. These sources were left alone:`)}</p>${htmlList}</div></div>`;
}

function setGroupBusy(card, busy) {
  const buttons = card.querySelectorAll('.dup-group__foot .zr-btn');
  buttons.forEach((button) => {
    button.disabled = busy;
  });
  if (busy) {
    card.dataset.state = 'busy';
    const merge = card.querySelector('.dup-merge-btn');
    if (merge) merge.innerHTML = `${htmlIcons.spin}<span>Merging…</span>`;
  } else {
    delete card.dataset.state;
  }
}

function finishGroup(card, markup) {
  card
    .querySelectorAll('.zr-table-wrap, .dup-group__warnings')
    .forEach((node) => node.remove());
  const foot = card.querySelector('.dup-group__foot');
  if (foot) foot.remove();
  const result = card.querySelector('.dup-group__result');
  if (result) result.innerHTML = markup;
  delete card.dataset.state;
}

async function mergeGroup(card, state) {
  const target = memberOf(state, state.targetId);
  const sources = selectedSources(state);
  if (!target || sources.length === 0) return;

  const kind = normalizeKind(state.group.kind);
  const offerCopy =
    (state.group.warnings || []).includes('has-matching-rule') &&
    num(target.matchingAlgorithm) === 0;

  // confirmDialog appends its <dialog> synchronously, so the checkbox exists
  // as soon as the promise is handed back — and it is gone again once the
  // dialog closes, which is why the value is captured here rather than after.
  const answer = confirmDialog({
    title: `Merge into ${String(target.name == null ? '' : target.name)}`,
    html: htmlMergeDialog(state, target, sources, offerCopy),
    confirmLabel: 'Merge',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  const checkbox = document.getElementById('dupCopyRule');
  let copyMatchingRule = Boolean(checkbox && checkbox.checked);
  if (checkbox) {
    checkbox.addEventListener('change', () => {
      copyMatchingRule = checkbox.checked;
    });
  }
  if (!(await answer)) return;

  setGroupBusy(card, true);
  try {
    const payload = await postJson('/api/duplicates/merge', {
      kind,
      targetId: state.targetId,
      sourceIds: sources.map((member) => num(member.id)),
      copyMatchingRule,
    });
    const result = payload.data || {};
    if (payload.success && result.status !== 'partial') {
      finishGroup(card, htmlMergeSuccess(result));
      const moved = num(result.documentsMoved);
      toast(
        `Merged ${moved} ${plural(moved, 'document', 'documents')} into ${String(target.name == null ? '' : target.name)}`,
        { tone: 'ok' }
      );
    } else if (result.status === 'partial') {
      const holder = card.querySelector('.dup-group__result');
      if (holder) holder.innerHTML = htmlMergeProblems(result);
      setGroupBusy(card, false);
      updateFoot(card, state);
      toast(payload.message || 'Not everything could be merged', {
        tone: 'danger',
      });
    } else {
      throw new Error(payload.error || payload.message || 'The merge failed.');
    }
  } catch (error) {
    const holder = card.querySelector('.dup-group__result');
    if (holder) {
      holder.innerHTML = htmlAlert('danger', 'The merge failed', error.message);
    }
    setGroupBusy(card, false);
    updateFoot(card, state);
    toast(error.message, { tone: 'danger' });
  }
  loadLog(true);
}

/* --- dismissing a group --------------------------------------------------- */

async function dismissGroup(card, state) {
  const members = state.group.members || [];
  const names = {};
  members.forEach((member) => {
    names[num(member.id)] = String(member.name == null ? '' : member.name);
  });
  setGroupBusy(card, true);
  try {
    const payload = await postJson('/api/duplicates/dismiss', {
      kind: normalizeKind(state.group.kind),
      ids: members.map((member) => num(member.id)),
      names,
    });
    if (!payload.success) {
      throw new Error(payload.error || 'The pair could not be hidden.');
    }
    groups.delete(card.dataset.groupId);
    card.remove();
    if (groups.size === 0) {
      el.results.innerHTML = htmlEmpty(
        'Nothing left to review',
        'Every group from this scan was merged or hidden.'
      );
    }
    toast(payload.message || 'Hidden as not a duplicate', { tone: 'ok' });
    loadDismissals();
  } catch (error) {
    setGroupBusy(card, false);
    updateFoot(card, state);
    toast(error.message, { tone: 'danger' });
  }
}

/* --- the merge log -------------------------------------------------------- */

function htmlLogRows(entries) {
  return entries
    .map((entry) => {
      const kind = normalizeKind(entry.kind);
      const badge = STATUS_BADGES[entry.status] || {
        tone: '',
        label: String(entry.status || 'unknown'),
      };
      const names = (entry.sources || [])
        .map((source) => String(source.name == null ? '' : source.name))
        .join(', ');
      const date = window.zrDate.format(entry.createdAt, { fallback: '–' });
      const dateTitle = window.zrDate.formatDateTime(entry.createdAt);
      const undoable = entry.status === 'done' || entry.status === 'partial';
      const htmlUndo = undoable
        ? `<button type="button" class="zr-btn dup-undo-btn" data-id="${num(entry.id)}">${htmlIcons.undo} Undo</button>`
        : '';
      return `<tr data-log-id="${num(entry.id)}">
        <td data-label="Date" class="zr-sm zr-faint zr-table__date" title="${esc(dateTitle)}">${esc(date)}</td>
        <td data-label="Kind"><span class="zr-badge">${htmlIcons[kind]}${esc(KIND_LABELS[kind])}</span></td>
        <td data-label="Target" class="zr-truncate" title="${esc(String(entry.targetName == null ? '' : entry.targetName))}">${esc(String(entry.targetName == null ? '' : entry.targetName))}</td>
        <td data-label="Merged" class="zr-truncate dup-log__sources" title="${esc(names)}">${esc(names)}</td>
        <td data-label="Documents" class="zr-mono">${num(entry.documentsMoved)}</td>
        <td data-label="Status"><span class="zr-badge ${esc(badge.tone)}">${esc(badge.label)}</span></td>
        <td data-label="" class="zr-table__actions">${htmlUndo}</td>
      </tr>`;
    })
    .join('');
}

function htmlUndoProblems(result) {
  const failed = (result.sources || []).filter((source) => source.error);
  const htmlRows = failed
    .map(
      (source) =>
        `<li>${esc(String(source.name == null ? '' : source.name))}: ${esc(source.error)}</li>`
    )
    .join('');
  return `<div class="zr-alert zr-alert--danger">${htmlIcons.danger}<div class="zr-alert__body"><div class="zr-alert__title">The undo did not finish</div><ul class="dup-dialog__list">${htmlRows}</ul></div></div>`;
}

async function loadLog(reset) {
  if (reset) {
    logOffset = 0;
    logEntries.clear();
    el.logBody.innerHTML = `<tr><td colspan="7" class="zr-empty">${htmlIcons.spin} Loading merges…</td></tr>`;
  }
  try {
    const params = new URLSearchParams({
      limit: String(LOG_PAGE_SIZE),
      offset: String(logOffset),
    });
    const payload = await requestJson(`/api/duplicates/log?${params}`);
    if (!payload.success) {
      throw new Error(payload.error || 'The merge log could not be loaded.');
    }
    const entries = payload.data || [];
    logTotal = num(payload.recordsTotal);
    entries.forEach((entry) => logEntries.set(num(entry.id), entry));
    const markup = htmlLogRows(entries);
    if (logOffset === 0) {
      el.logBody.innerHTML =
        markup ||
        '<tr><td colspan="7" class="zr-empty">No merges yet.</td></tr>';
    } else {
      el.logBody.insertAdjacentHTML('beforeend', markup);
    }
    logOffset += entries.length;
    el.logInfo.textContent = logTotal
      ? `Showing ${logOffset} of ${logTotal}`
      : '';
    el.logMeta.textContent = logTotal
      ? `${logTotal} ${plural(logTotal, 'merge', 'merges')}`
      : '';
    el.logMore.classList.toggle('hidden', logOffset >= logTotal);
  } catch (error) {
    el.logBody.innerHTML = `<tr><td colspan="7" class="zr-empty zr-danger-text">${esc(error.message)}</td></tr>`;
  }
}

async function undoMerge(id) {
  const entry = logEntries.get(num(id));
  if (!entry) return;
  const names = (entry.sources || [])
    .map((source) => String(source.name == null ? '' : source.name))
    .join(', ');
  const target = String(entry.targetName == null ? '' : entry.targetName);
  const sentence = `Re-creates ${names} in Paperless-ngx with new ids and moves the documents back. Documents that no longer carry ${target} are left alone.`;
  const confirmed = await confirmDialog({
    title: 'Undo this merge',
    body: sentence,
    confirmLabel: 'Undo',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;

  el.logAlert.innerHTML = '';
  try {
    const payload = await postJson(`/api/duplicates/log/${num(id)}/undo`, {});
    const result = payload.data || {};
    if (payload.success && result.status !== 'undo_failed') {
      toast(payload.message || 'The merge was undone', { tone: 'ok' });
    } else if (result.status === 'undo_failed') {
      el.logAlert.innerHTML = htmlUndoProblems(result);
      toast(payload.message || 'The undo did not finish', { tone: 'danger' });
    } else {
      throw new Error(payload.error || payload.message || 'The undo failed.');
    }
  } catch (error) {
    el.logAlert.innerHTML = htmlAlert(
      'danger',
      'The undo failed',
      error.message
    );
    toast(error.message, { tone: 'danger' });
  }
  loadLog(true);
}

/* --- hidden pairs --------------------------------------------------------- */

function htmlDismissalRows(list) {
  if (list.length === 0) {
    return '<p class="zr-sm zr-faint">Nothing is hidden. Pairs you mark as "Not a duplicate" show up here.</p>';
  }
  return list
    .map((item) => {
      const kind = normalizeKind(item.kind);
      const pair = `${String(item.nameA == null ? '#' + num(item.idA) : item.nameA)} · ${String(item.nameB == null ? '#' + num(item.idB) : item.nameB)}`;
      return `<div class="dup-hidden__row" data-dismissal-id="${num(item.id)}">
        <span class="zr-badge">${htmlIcons[kind]}${esc(KIND_LABELS[kind])}</span>
        <span class="zr-grow zr-truncate" title="${esc(pair)}">${esc(pair)}</span>
        <button type="button" class="zr-btn zr-btn--ghost dup-restore-btn" data-id="${num(item.id)}">Show again</button>
      </div>`;
    })
    .join('');
}

function updateDismissalCount() {
  el.dismissalsSummary.textContent = `Hidden pairs (${dismissalCount})`;
}

async function loadDismissals() {
  try {
    const payload = await requestJson('/api/duplicates/dismissals');
    if (!payload.success) {
      throw new Error(payload.error || 'The hidden pairs could not be loaded.');
    }
    const list = payload.data || [];
    dismissalCount = list.length;
    updateDismissalCount();
    el.dismissalsList.innerHTML = htmlDismissalRows(list);
  } catch (error) {
    dismissalCount = 0;
    updateDismissalCount();
    el.dismissalsList.innerHTML = htmlAlert(
      'danger',
      'Hidden pairs unavailable',
      error.message
    );
  }
}

async function restoreDismissal(id, row) {
  try {
    const payload = await requestJson(`/api/duplicates/dismissals/${num(id)}`, {
      method: 'DELETE',
    });
    if (!payload.success) {
      throw new Error(payload.error || 'The pair could not be restored.');
    }
    row.remove();
    dismissalCount = Math.max(0, dismissalCount - 1);
    updateDismissalCount();
    if (dismissalCount === 0) {
      el.dismissalsList.innerHTML = htmlDismissalRows([]);
    }
    toast(payload.message || 'The pair shows up in the next scan again', {
      tone: 'ok',
    });
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  }
}

/* --- wiring --------------------------------------------------------------- */

function init() {
  if (!el.results) return;

  if (el.kind) {
    el.kind.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-kind]');
      if (!button) return;
      el.kind.querySelectorAll('button[data-kind]').forEach((other) => {
        other.setAttribute(
          'aria-selected',
          other === button ? 'true' : 'false'
        );
      });
    });
  }

  if (el.scanBtn) el.scanBtn.addEventListener('click', runScan);
  if (el.logMore) el.logMore.addEventListener('click', () => loadLog(false));

  if (el.logBody) {
    el.logBody.addEventListener('click', (event) => {
      const button = event.target.closest('.dup-undo-btn');
      if (button) undoMerge(button.dataset.id);
    });
  }

  if (el.dismissalsList) {
    el.dismissalsList.addEventListener('click', (event) => {
      const button = event.target.closest('.dup-restore-btn');
      if (!button) return;
      restoreDismissal(button.dataset.id, button.closest('.dup-hidden__row'));
    });
  }

  loadLog(true);
  loadDismissals();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
