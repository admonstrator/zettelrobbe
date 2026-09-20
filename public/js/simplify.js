/**
 * Simplify tags — a compound tag becomes a document type and topic tags.
 *
 * "Stromrechnung" is not a concept, it is two: an invoice, about electricity.
 * Paperless-ngx has a field for the first and tags for the second, so this
 * page keeps a small target vocabulary of both, proposes for every tag what it
 * stands for, and applies the splits the user confirmed.
 *
 * Round 12 puts the proposed order first: one job reads every tag and every
 * document type, proposes the vocabulary and gives every tag an action, and
 * the answer is read as a couple of dozen group cards — one per document type,
 * one per topic, one per merge target, plus "keep" and "delete". A group is
 * accepted, skipped or reopened as a whole and applied with one confirmation;
 * the table of round 10 stays as the detail view of the very same rows.
 *
 * Nothing here starts on its own. The vocabulary is saved when the button is
 * used, the order runs when the button is used, and an apply happens when the
 * confirm dialog is accepted. Every write is in the merge log on the
 * Duplicates page and can be undone from there.
 *
 * Escaping rule for this file
 * ---------------------------
 * All markup is built from template literals, so an interpolation is only ever
 * one of three things:
 *   esc(...)     a value that came from the API, HTML-escaped
 *   num(...)     a finite number, never a string from the API
 *   html...      a local or helper whose name starts with "html" and whose
 *                value is markup this file has already escaped
 * tests/test-simplify-ui.js checks the file against exactly that rule.
 */

import { toast, confirmDialog } from '/js/zr.js';
import { escapeHtml as esc } from '/js/modules/text-utils.js';
import { createPicker } from '/js/modules/picker.js';

/* --- interpolation helpers ------------------------------------------------ */

/** Anything that reaches an attribute or cell as a number, never as text. */
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** "1 tag" / "2 tags", without a parenthesised plural. */
function plural(count, one, many) {
  return num(count) === 1 ? one : many;
}

/* --- the page's vocabulary ------------------------------------------------ */

/** Where a proposal came from, as the badge says it. */
const SOURCE_LABELS = {
  rule: 'rule',
  model: 'model',
  user: 'you',
};

/** The tone each source wears; a rule is settled, the model is a proposal. */
const SOURCE_TONES = {
  rule: 'zr-badge--ok',
  model: 'zr-badge--info',
  user: 'zr-badge--brand',
};

/** What a proposal can be, as the status column says it. */
const STATUS_BADGES = {
  open: { tone: '', label: 'open' },
  accepted: { tone: 'zr-badge--info', label: 'accepted' },
  skipped: { tone: 'zr-badge--warn', label: 'skipped' },
  applied: { tone: 'zr-badge--ok', label: 'applied' },
};

/** The four tasks of this page, as the job service names them. */
const JOB_TASKS = {
  VOCABULARY: 'vocabulary',
  SPLITS: 'splits',
  ORDER: 'order',
  APPLY: 'apply',
};

/** The kinds of group, as the badge on a card says them. */
const GROUP_KIND_LABELS = {
  type: 'type',
  topic: 'topic',
  merge: 'merge',
  delete: 'delete',
  keep: 'keep',
};

/** One tone each, so a card is recognised before it is read. */
const GROUP_KIND_TONES = {
  type: 'zr-badge--brand',
  topic: 'zr-badge--info',
  merge: 'zr-badge--warn',
  delete: 'zr-badge--danger',
  keep: 'zr-badge--ok',
};

/** And one icon each, out of the app's set. */
const GROUP_KIND_ICONS = {
  type: 'i-file',
  topic: 'i-tag',
  merge: 'i-merge',
  delete: 'i-trash',
  keep: 'i-check-circle',
};

/** What a decision is called once it has happened. */
const DECISION_WORDS = {
  accept: 'accepted',
  skip: 'skipped',
  reopen: 'reopened',
};

/** Members a card renders before it offers "Show N more". */
const MEMBERS_PER_PAGE = 50;

/** The two job states that mean "still going". */
const JOB_LIVE_STATES = ['running', 'stopping'];

/** How often the page asks the job directly when the stream broke. */
const JOB_POLL_MS = 2000;

/** Proposals one apply call may name; the route refuses more. */
const MAX_APPLY_TAGS = 200;

/** Where an applied row points for its undo. */
const UNDO_HREF = '/duplicates#dupLog';

/** What the empty vocabulary says instead of showing two empty lists. */
const VOCABULARY_EMPTY =
  'No vocabulary yet. Propose one from your tags or type the document types and topics your archive should end up with.';

/** What the empty table says. */
const PROPOSALS_EMPTY =
  'No proposals yet. Save a vocabulary, then propose splits.';

/** What the page says before any order has been proposed. */
const ORDER_EMPTY =
  'No order proposed yet. Propose one: the model reads every tag and every document type.';

/** And what a filter that matches nothing says. */
const GROUPS_EMPTY = 'No groups match.';

/** The notice over an unsaved model proposal. */
const PROPOSAL_NOTICE = 'Proposed by the model, not saved yet';

/** Its sibling for the types taken over from Paperless-ngx in one click. */
const ADOPT_NOTICE = 'Taken over from Paperless-ngx, not saved yet';

/** What both notices say underneath: nothing is stored until Save is used. */
const UNSAVED_HINT =
  'Edit the lists, then save them. Nothing is stored until you do.';

/** What the note says when the document types could not be read. */
const TYPES_UNREACHABLE =
  'Paperless-ngx could not be reached; you can still type a name.';

/** The badge a row of the picker wears when the vocabulary already has it. */
const IN_VOCABULARY_BADGE = { text: 'in vocabulary', tone: 'ok' };

/* --- state ---------------------------------------------------------------- */

const el = {
  order: document.getElementById('simOrder'),
  orderBtn: document.getElementById('simOrderBtn'),
  orderMeta: document.getElementById('simOrderMeta'),
  orderSummary: document.getElementById('simOrderSummary'),
  orderEmpty: document.getElementById('simOrderEmpty'),
  keepVocabulary: document.getElementById('simOrderKeepVocabulary'),
  keepVocabularyWrap: document.getElementById('simOrderKeepWrap'),
  orderStats: document.getElementById('simOrderStats'),
  statGroupTypes: document.getElementById('simStatGroupTypes'),
  statGroupTopics: document.getElementById('simStatGroupTopics'),
  statGroupMerges: document.getElementById('simStatGroupMerges'),
  statGroupDelete: document.getElementById('simStatGroupDelete'),
  statGroupKeep: document.getElementById('simStatGroupKeep'),
  statOrderAccepted: document.getElementById('simStatOrderAccepted'),
  statOrderApplied: document.getElementById('simStatOrderApplied'),
  view: document.getElementById('simView'),
  groupFilters: document.getElementById('simGroupFilters'),
  groupKind: document.getElementById('simGroupKind'),
  groupStatus: document.getElementById('simGroupStatus'),
  groupSearch: document.getElementById('simGroupSearch'),
  groups: document.getElementById('simGroups'),
  applyAcceptedBtn: document.getElementById('simApplyAcceptedBtn'),
  applyAcceptedLabel: document.getElementById('simApplyAcceptedLabel'),
  applyResult: document.getElementById('simApplyResult'),
  vocabularyBlock: document.getElementById('simVocabularyBlock'),
  reproposeBtn: document.getElementById('simReproposeBtn'),
  proposals: document.getElementById('simProposals'),
  vocabularyNotice: document.getElementById('simVocabularyNotice'),
  vocabularyMeta: document.getElementById('simVocabularyMeta'),
  types: document.getElementById('simTypes'),
  topics: document.getElementById('simTopics'),
  typeInput: document.getElementById('simTypeInput'),
  typeList: document.getElementById('simTypeList'),
  typesReloadBtn: document.getElementById('simTypesReloadBtn'),
  typesNote: document.getElementById('simTypesNote'),
  adoptTypes: document.getElementById('simAdoptTypes'),
  topicInput: document.getElementById('simTopicInput'),
  topicHint: document.getElementById('simTopicHint'),
  proposeVocabularyBtn: document.getElementById('simProposeVocabularyBtn'),
  saveVocabularyBtn: document.getElementById('simSaveVocabularyBtn'),
  proposeSplitsBtn: document.getElementById('simProposeSplitsBtn'),
  proposeSplitsHint: document.getElementById('simProposeSplitsHint'),
  progress: document.getElementById('simProgress'),
  progressBar: document.getElementById('simProgressBar'),
  progressFill: document.getElementById('simProgressFill'),
  progressMessage: document.getElementById('simProgressMessage'),
  progressCounts: document.getElementById('simProgressCounts'),
  progressEta: document.getElementById('simProgressEta'),
  stopBtn: document.getElementById('simStopBtn'),
  stats: document.getElementById('simStats'),
  statProposals: document.getElementById('simStatProposals'),
  statOpen: document.getElementById('simStatOpen'),
  statRule: document.getElementById('simStatRule'),
  statModel: document.getElementById('simStatModel'),
  statApplied: document.getElementById('simStatApplied'),
  statusFilter: document.getElementById('simStatusFilter'),
  search: document.getElementById('simSearch'),
  proposalsAlert: document.getElementById('simProposalsAlert'),
  proposalsMeta: document.getElementById('simProposalsMeta'),
  proposalsBody: document.getElementById('simProposalsBody'),
  topicOptions: document.getElementById('simTopicOptions'),
  applyStatus: document.getElementById('simApplyStatus'),
  applyBtn: document.getElementById('simApplyBtn'),
  skipBtn: document.getElementById('simSkipBtn'),
  selectOpenBtn: document.getElementById('simSelectOpenBtn'),
  clearSelectionBtn: document.getElementById('simClearSelectionBtn'),
};

/** The vocabulary the page is editing: names only, in the user's order. */
const vocabulary = { types: [], topics: [] };

/** The rows behind it, kept for what only they know: who wrote an entry. */
let vocabularyRows = [];

/** The document types Paperless-ngx has, as the route last answered them. */
let documentTypes = [];

/** True once a fetch of them failed: no offer, and the note explains why. */
let typesUnreachable = false;

/**
 * The tag names of the archive, lower case -> { name, documentCount }. Read
 * once, the first time a topic is typed, and kept for the page's life: the
 * hint is an extra, not a reason to fetch a thousand names on load.
 */
let tagIndex = null;
let tagIndexPromise = null;

/** Every proposal the last load brought, by tag id. */
const proposals = new Map();

/** Tag ids ticked for the next apply. */
const selected = new Set();

/** The proposed order as the route last answered it, one card each. */
let groups = [];

/** Which cards are expanded, and how many members each of them renders. */
const groupsOpen = new Set();
const groupShown = new Map();

/** What the last order run reported, for the one summary line. */
let orderResult = null;
let orderStopped = false;

let groupKind = 'all';
let groupStatus = 'open';
let groupSearch = '';
let view = 'groups';
let statusFilter = 'open';
let searchText = '';
let vocabularySaved = false;
let jobId = null;
let progressJob = null;
let progressAt = 0;
let progressTimer = null;
let applying = false;

/* --- requests ------------------------------------------------------------- */

/* /js/csrf.js patches window.fetch, so a state-changing request carries its
   token without this file knowing about one. */
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
    const error = new Error(
      `The server answered ${response.status} without a body.`
    );
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(
      payload.error || payload.message || 'Request failed'
    );
    error.status = response.status;
    throw error;
  }
  return payload;
}

function sendJson(method, url, body) {
  return requestJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

/* --- small markup helpers ------------------------------------------------- */

function htmlAlert(tone, title, body) {
  return `<div class="zr-alert zr-alert--${esc(tone)}"><div class="zr-alert__body"><div class="zr-alert__title">${esc(title)}</div><p class="zr-sm">${esc(body)}</p></div></div>`;
}

function htmlEmptyRow(columns, text) {
  return `<tr><td colspan="${num(columns)}" class="zr-empty">${esc(text)}</td></tr>`;
}

/** One symbol out of the app's icon set; there is no icon font. */
function htmlIconMarkup(name) {
  return `<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#${esc(name)}"/></svg>`;
}

/** "3,410" — a count of documents the eye can take in at a glance. */
function grouped(value) {
  return num(value).toLocaleString('en-US');
}

/* --- the vocabulary editor ------------------------------------------------ */

/**
 * One dimension of the vocabulary as chips, each with the button that removes
 * it. Pure on purpose: tests/test-simplify-ui.js renders it itself.
 *
 * @param {string[]} names
 * @param {string} dimension  'type' or 'topic', for the remove button's data
 * @returns {string} markup
 */
function htmlVocabularyChips(names, dimension) {
  if (!Array.isArray(names) || names.length === 0) {
    return `<span class="sim-vocab__empty">${esc('Nothing yet')}</span>`;
  }
  return names
    .map(
      (name) =>
        `<span class="zr-chip sim-chip" role="listitem"><span class="sim-chip__name" title="${esc(name)}">${esc(name)}</span><button type="button" class="sim-chip__remove" data-dimension="${esc(dimension)}" data-name="${esc(name)}" aria-label="Remove ${esc(name)}"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-x"/></svg></button></span>`
    )
    .join('');
}

/** The one line the empty vocabulary shows instead of two empty lists. */
function htmlVocabularyEmpty() {
  return `<div class="zr-alert zr-alert--info"><div class="zr-alert__body"><p class="zr-sm">${esc(VOCABULARY_EMPTY)}</p></div></div>`;
}

function renderVocabulary() {
  if (el.types) {
    el.types.innerHTML = htmlVocabularyChips(vocabulary.types, 'type');
  }
  if (el.topics) {
    el.topics.innerHTML = htmlVocabularyChips(vocabulary.topics, 'topic');
  }
  if (el.topicOptions) {
    el.topicOptions.innerHTML = vocabulary.topics
      .map((name) => `<option value="${esc(name)}"></option>`)
      .join('');
  }
  if (el.vocabularyMeta) {
    const total = vocabulary.types.length + vocabulary.topics.length;
    el.vocabularyMeta.textContent = total
      ? `${total} ${plural(total, 'entry', 'entries')}`
      : '';
  }
  renderAdoptOffer();
  updateProposeSplitsButton();
}

/** Adds a name to one dimension, keeping the order and dropping repeats. */
function addVocabularyName(dimension, raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (name === '') return false;
  const list = dimension === 'type' ? vocabulary.types : vocabulary.topics;
  if (list.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
    return false;
  }
  list.push(name);
  renderVocabulary();
  return true;
}

function removeVocabularyName(dimension, name) {
  const key = dimension === 'type' ? 'types' : 'topics';
  vocabulary[key] = vocabulary[key].filter((entry) => entry !== name);
  renderVocabulary();
}

/** What a vocabulary proposal does to the lists: the user's entries first. */
function mergeProposedVocabulary(current, proposed) {
  const merged = [...current];
  (Array.isArray(proposed) ? proposed : []).forEach((raw) => {
    const name = String(raw == null ? '' : raw).trim();
    if (name === '') return;
    if (merged.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
      return;
    }
    merged.push(name);
  });
  return merged;
}

/* --- the document types Paperless-ngx already has ------------------------- */

/**
 * The offer that turns the existing document types into a vocabulary. Pure on
 * purpose: tests/test-simplify-ui.js renders it for one type and for four.
 *
 * @param {number} count how many types the instance has
 * @returns {string} markup for the body of #simAdoptTypes
 */
function htmlAdoptTypes(count) {
  const total = num(count);
  const kinds = `document ${plural(total, 'type', 'types')}`;
  return `<div class="zr-alert__body"><p class="zr-sm">${esc(`Paperless-ngx already has ${total} ${kinds}.`)}</p></div><button class="zr-btn" id="simAdoptTypesBtn" type="button">${esc(`Take over ${total} ${kinds}`)}</button>`;
}

/** Shows the offer only while there is nothing to lose by taking it. */
function renderAdoptOffer() {
  if (!el.adoptTypes) return;
  const offer =
    !typesUnreachable &&
    vocabulary.types.length === 0 &&
    documentTypes.length > 0;
  el.adoptTypes.innerHTML = offer ? htmlAdoptTypes(documentTypes.length) : '';
  el.adoptTypes.classList.toggle('hidden', !offer);
}

/**
 * What the picker may offer right now. The badge is worked out from the list
 * the user is editing rather than from `inVocabulary` of the last fetch: a
 * name added a second ago must already wear it.
 */
function typeChoices() {
  const taken = new Set(vocabulary.types.map((name) => name.toLowerCase()));
  return documentTypes.map((record) => {
    const name = String(record.name == null ? '' : record.name);
    return taken.has(name.toLowerCase())
      ? { ...record, badge: IN_VOCABULARY_BADGE }
      : record;
  });
}

/** True when the vocabulary already holds this name, whatever its case. */
function inVocabulary(dimension, name) {
  const list = dimension === 'type' ? vocabulary.types : vocabulary.topics;
  const wanted = String(name == null ? '' : name).toLowerCase();
  return list.some((entry) => entry.toLowerCase() === wanted);
}

/**
 * Reads the document types behind the cache, or `fresh` past it.
 *
 * A failure is not an error state of the page: the field stays a text field
 * and the note says so, because a vocabulary is a list of names and does not
 * need Paperless-ngx to be typed.
 *
 * @param {boolean} [fresh] true reads past the cache
 * @returns {Promise<boolean>} whether Paperless-ngx answered
 */
async function loadDocumentTypes(fresh) {
  try {
    // Two spelled-out literals rather than one built URL: nothing of this
    // page's data reaches a path, and the escaping check can see that.
    const payload = await requestJson(
      fresh === true
        ? '/api/simplify/document-types?fresh=1'
        : '/api/simplify/document-types'
    );
    const data = payload.data || {};
    documentTypes = Array.isArray(data.types) ? data.types : [];
    typesUnreachable = false;
  } catch {
    documentTypes = [];
    typesUnreachable = true;
  }
  if (el.typesNote) {
    el.typesNote.textContent = typesUnreachable ? TYPES_UNREACHABLE : '';
    el.typesNote.classList.toggle('hidden', !typesUnreachable);
  }
  renderAdoptOffer();
  return !typesUnreachable;
}

/** The reload button: past the cache, and it says what came back. */
async function reloadDocumentTypes() {
  if (!el.typesReloadBtn) return;
  el.typesReloadBtn.disabled = true;
  try {
    const reached = await loadDocumentTypes(true);
    if (!reached) {
      toast(TYPES_UNREACHABLE, { tone: 'danger' });
      return;
    }
    const total = documentTypes.length;
    toast(`${total} document ${plural(total, 'type', 'types')} read`, {
      tone: 'ok',
    });
  } finally {
    el.typesReloadBtn.disabled = false;
  }
}

/** The one click that makes the existing types the vocabulary's types. */
function adoptDocumentTypes() {
  let added = 0;
  documentTypes.forEach((record) => {
    if (addVocabularyName('type', record.name)) added += 1;
  });
  if (added === 0) return;
  if (el.vocabularyNotice) {
    el.vocabularyNotice.innerHTML = htmlAlert(
      'info',
      ADOPT_NOTICE,
      UNSAVED_HINT
    );
  }
  toast(`${added} document ${plural(added, 'type', 'types')} taken over`, {
    tone: 'ok',
  });
}

/* --- the hint under a typed topic ----------------------------------------- */

/**
 * The tag names of the archive, read once and kept. A list that cannot be
 * read is an empty one: the hint is an extra, never a reason to fail.
 *
 * @returns {Promise<Map<string, {name: string, documentCount: number}>>}
 */
function ensureTagIndex() {
  if (tagIndex) return Promise.resolve(tagIndex);
  if (!tagIndexPromise) {
    tagIndexPromise = requestJson('/api/duplicates/entities?kind=tags')
      .then((payload) => {
        const index = new Map();
        (payload.data || []).forEach((record) => {
          const name = String(record.name == null ? '' : record.name);
          if (name === '' || index.has(name.toLowerCase())) return;
          index.set(name.toLowerCase(), {
            name,
            documentCount: num(record.documentCount),
          });
        });
        tagIndex = index;
        return index;
      })
      .catch(() => {
        tagIndex = new Map();
        return tagIndex;
      });
  }
  return tagIndexPromise;
}

/**
 * What a typed topic is told about the tag of that name. Pure on purpose:
 * tests/test-simplify-ui.js runs the three cases.
 *
 * @param {string} typed the name the user entered
 * @param {?{name: string, documentCount: number}} match the tag of that name,
 *   ignoring case, or null when there is none
 * @returns {string} markup, '' when there is nothing to say
 */
function htmlTopicHint(typed, match) {
  const name = String(typed == null ? '' : typed);
  if (!match) return '';
  const existing = String(match.name == null ? '' : match.name);
  if (existing === name) {
    const count = num(match.documentCount);
    const documents = `${count} ${plural(count, 'document', 'documents')}`;
    return esc(
      `'${name}' is an existing tag with ${documents}; a split reuses it.`
    );
  }
  const htmlUse = `<button type="button" class="zr-btn sim-hint__use" data-name="${esc(existing)}" data-typed="${esc(name)}">${esc(`Use '${existing}'`)}</button>`;
  return `${esc(`'${name}' differs from the existing tag '${existing}' only in spelling.`)}${htmlUse}`;
}

/**
 * Replaces the typed spelling with the existing one, keeping its position and
 * never leaving the same name twice. Pure on purpose.
 *
 * @param {string[]} list the topics as they stand
 * @param {string} typed what the user entered
 * @param {string} wanted how Paperless-ngx spells it
 * @returns {string[]} the topics afterwards
 */
function useExistingSpelling(list, typed, wanted) {
  const names = Array.isArray(list) ? [...list] : [];
  const at = names.indexOf(typed);
  if (at === -1) return names;
  const others = names.filter((entry, index) => index !== at);
  if (others.some((entry) => entry.toLowerCase() === wanted.toLowerCase())) {
    return others;
  }
  names[at] = wanted;
  return names;
}

/** Shows what the tag list says about a topic the user just typed. */
async function showTopicHint(typed) {
  if (!el.topicHint) return;
  const index = await ensureTagIndex();
  const match = index.get(String(typed).toLowerCase()) || null;
  el.topicHint.innerHTML = htmlTopicHint(typed, match);
  el.topicHint.classList.toggle('hidden', !match);
}

/** Takes the hint's offer: the chip gets the spelling Paperless-ngx uses. */
function takeExistingSpelling(button) {
  vocabulary.topics = useExistingSpelling(
    vocabulary.topics,
    String(button.dataset.typed || ''),
    String(button.dataset.name || '')
  );
  renderVocabulary();
  if (el.topicHint) {
    el.topicHint.innerHTML = '';
    el.topicHint.classList.add('hidden');
  }
}

/**
 * What the saved vocabulary decides about the order section: the block is open
 * while there is nothing in it, "Keep my vocabulary" is only offered once
 * something is saved and comes up ticked when the user wrote any of it, and
 * the re-propose button waits for a vocabulary to re-propose against.
 */
function renderVocabularyState(fresh) {
  if (el.vocabularyBlock) el.vocabularyBlock.open = !vocabularySaved;
  if (el.reproposeBtn) {
    el.reproposeBtn.classList.toggle('hidden', !vocabularySaved);
  }
  if (el.keepVocabularyWrap) {
    // Without the model there is no button the tick belongs to: the order then
    // only runs from the vocabulary block, against the saved names anyway.
    el.keepVocabularyWrap.classList.toggle(
      'hidden',
      !vocabularySaved || el.orderBtn === null
    );
  }
  // Only on a load or a save: a tick the user set themselves is theirs.
  if (fresh === true && el.keepVocabulary) {
    el.keepVocabulary.checked = vocabularyRows.some(
      (row) => String(row.source || '') === 'user'
    );
  }
}

function readVocabularyPayload(data) {
  const rows = data || {};
  vocabulary.types = (rows.types || []).map((row) => String(row.name));
  vocabulary.topics = (rows.topics || []).map((row) => String(row.name));
  vocabularyRows = [...(rows.types || []), ...(rows.topics || [])];
  vocabularySaved = vocabulary.types.length > 0 || vocabulary.topics.length > 0;
  if (el.vocabularyNotice) {
    el.vocabularyNotice.innerHTML = vocabularySaved
      ? ''
      : htmlVocabularyEmpty();
  }
  renderVocabularyState(true);
}

async function loadVocabulary() {
  try {
    const payload = await requestJson('/api/simplify/vocabulary');
    readVocabularyPayload(payload.data || {});
    renderVocabulary();
  } catch (error) {
    if (el.vocabularyNotice) {
      el.vocabularyNotice.innerHTML = htmlAlert(
        'danger',
        'The vocabulary could not be loaded',
        error.message
      );
    }
  }
}

async function saveVocabulary() {
  if (!el.saveVocabularyBtn) return;
  el.saveVocabularyBtn.disabled = true;
  try {
    const payload = await sendJson('PUT', '/api/simplify/vocabulary', {
      types: vocabulary.types,
      topics: vocabulary.topics,
    });
    readVocabularyPayload(payload.data || {});
    renderVocabulary();
    renderProposals();
    toast(payload.message || 'The vocabulary was saved', { tone: 'ok' });
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  } finally {
    el.saveVocabularyBtn.disabled = false;
  }
}

/* --- the proposal table --------------------------------------------------- */

/**
 * What the order does with the tag, as the table's first column says it:
 * "split", "merge → Amazon", "keep", "delete". Pure on purpose.
 *
 * @param {object} proposal a TagSplitProposal
 * @returns {string}
 */
function actionLabel(proposal) {
  const action = String((proposal && proposal.action) || 'split');
  if (action !== 'merge') return action;
  const target = String(
    proposal.mergeInto == null ? '' : proposal.mergeInto
  ).trim();
  return target === '' ? 'merge' : `merge → ${target}`;
}

/** The badge a proposal wears for where it came from. */
function htmlSourceBadge(proposal) {
  const source = String(proposal.source || 'rule');
  const label = SOURCE_LABELS[source] || source;
  const tone = SOURCE_TONES[source] || '';
  const confidence =
    source === 'model' && proposal.confidence
      ? ` · ${String(proposal.confidence)}`
      : '';
  return `<span class="zr-badge ${esc(tone)}">${esc(label + confidence)}</span>`;
}

/**
 * The "3 keep their type" note beside the overwrite switch, or '' while the
 * number is not known. Pure on purpose.
 */
function overwriteLabel(proposal) {
  const keeps = num(proposal && proposal.documentsWithType);
  if (keeps <= 0) return '';
  return `${keeps} ${plural(keeps, 'keeps its type', 'keep their type')}`;
}

/** The document type a proposal sets, as a select of the vocabulary. */
function htmlTypeSelect(proposal, types) {
  const current = proposal.typeName == null ? '' : String(proposal.typeName);
  const names = Array.isArray(types) ? [...types] : [];
  if (current !== '' && !names.includes(current)) names.push(current);
  // An attribute fragment, not a value: the escaping rule of this file only
  // lets esc(), num() and a local whose name starts with "html" into markup.
  const htmlOptions = names
    .map((name) => {
      const htmlSelected = name === current ? ' selected' : '';
      return `<option value="${esc(name)}"${htmlSelected}>${esc(name)}</option>`;
    })
    .join('');
  const htmlNoneSelected = current === '' ? ' selected' : '';
  const htmlNone = `<option value=""${htmlNoneSelected}>${esc('none')}</option>`;
  return `<select class="zr-select sim-type" data-tag-id="${num(proposal.tagId)}" aria-label="Document type for ${esc(proposal.tagName)}">${htmlNone}${htmlOptions}</select>`;
}

/** The topic tags a proposal adds, as chips plus the input that adds one. */
function htmlTopicChips(proposal) {
  const names = Array.isArray(proposal.topicNames) ? proposal.topicNames : [];
  const htmlChips = names
    .map(
      (name) =>
        `<span class="zr-chip sim-chip"><span class="sim-chip__name" title="${esc(name)}">${esc(name)}</span><button type="button" class="sim-topic-remove" data-tag-id="${num(proposal.tagId)}" data-name="${esc(name)}" aria-label="Remove ${esc(name)}"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-x"/></svg></button></span>`
    )
    .join('');
  return `<div class="sim-topics"><div class="zr-chips">${htmlChips}</div><input class="zr-input sim-topics__input" type="text" list="simTopicOptions" autocomplete="off" data-tag-id="${num(proposal.tagId)}" placeholder="Add a topic" aria-label="Add a topic to ${esc(proposal.tagName)}"></div>`;
}

/**
 * One row of the proposal table. Pure on purpose: tests/test-simplify-ui.js
 * renders it and reads the cells back.
 *
 * @param {object} proposal  a TagSplitProposal
 * @param {string[]} types   the vocabulary's document types
 * @returns {string} markup
 */
function htmlProposalRow(proposal, types) {
  const status = String(proposal.status || 'open');
  const badge = STATUS_BADGES[status] || { tone: '', label: status };
  const applied = status === 'applied';
  const editable = !applied;
  const htmlPick = editable
    ? `<input type="checkbox" class="zr-check sim-pick" data-tag-id="${num(proposal.tagId)}" aria-label="Apply the split of ${esc(proposal.tagName)}">`
    : '<span class="zr-faint">–</span>';
  const htmlType = editable
    ? htmlTypeSelect(proposal, types)
    : `<span class="zr-sm">${esc(proposal.typeName == null ? 'none' : proposal.typeName)}</span>`;
  const htmlTopics = editable
    ? htmlTopicChips(proposal)
    : `<span class="zr-sm">${esc((proposal.topicNames || []).join(', '))}</span>`;
  const note = overwriteLabel(proposal);
  const htmlNote = note
    ? `<span class="zr-sm zr-faint">(${esc(note)})</span>`
    : '';
  const htmlChecked = proposal.overwriteType === true ? ' checked' : '';
  const htmlOverwrite = editable
    ? `<label class="sim-overwrite-row"><input type="checkbox" class="zr-check sim-overwrite" data-tag-id="${num(proposal.tagId)}"${htmlChecked}>${esc('overwrite type')}${htmlNote}</label>`
    : '';
  const htmlUndo = applied
    ? `<a class="zr-link zr-sm" href="${esc(UNDO_HREF)}">${esc('undo on the Duplicates page')}</a>`
    : '';
  const htmlError = proposal.error
    ? `<span class="sim-error">${esc(proposal.error)}</span>`
    : '';
  const rowClass = applied
    ? 'sim-row sim-row--applied'
    : proposal.error
      ? 'sim-row sim-row--failed'
      : 'sim-row';
  return `<tr class="${esc(rowClass)}" data-tag-id="${num(proposal.tagId)}">
        <td data-label="Action" class="sim-proposals__actioncol"><span class="zr-sm sim-action">${esc(actionLabel(proposal))}</span></td>
        <td data-label="Apply" class="sim-proposals__pickcol">${htmlPick}</td>
        <td data-label="Tag" class="zr-truncate" title="${esc(proposal.tagName)}">${esc(proposal.tagName)}</td>
        <td data-label="Documents" class="zr-mono">${num(proposal.documentCount)}</td>
        <td data-label="Type" class="sim-cell--type"><div class="sim-typecell">${htmlType}${htmlOverwrite}</div></td>
        <td data-label="Topics" class="sim-cell--topics">${htmlTopics}</td>
        <td data-label="Source">${htmlSourceBadge(proposal)}</td>
        <td data-label="Reason"><span class="zr-sm zr-faint sim-reason">${esc(proposal.reason == null ? '' : proposal.reason)}</span></td>
        <td data-label="Status"><span class="zr-badge ${esc(badge.tone)}">${esc(badge.label)}</span>${htmlUndo}${htmlError}</td>
      </tr>`;
}

/** The rows the filters leave, in the order the server sent them. */
function visibleProposals() {
  const needle = searchText.trim().toLowerCase();
  return [...proposals.values()].filter((proposal) => {
    if (String(proposal.status || 'open') !== statusFilter) return false;
    if (needle === '') return true;
    return String(proposal.tagName || '')
      .toLowerCase()
      .includes(needle);
  });
}

function renderProposals() {
  if (!el.proposalsBody) return;
  const rows = visibleProposals();
  el.proposalsBody.innerHTML = rows.length
    ? rows
        .map((proposal) => htmlProposalRow(proposal, vocabulary.types))
        .join('')
    : htmlEmptyRow(9, proposals.size === 0 ? PROPOSALS_EMPTY : 'Nothing here.');
  rows.forEach((proposal) => {
    if (!selected.has(proposal.tagId)) return;
    const box = el.proposalsBody.querySelector(
      `.sim-pick[data-tag-id="${proposal.tagId}"]`
    );
    if (box) box.checked = true;
  });
  renderStats();
  updateApplyButtons();
}

function renderStats() {
  if (!el.stats) return;
  const all = [...proposals.values()];
  el.stats.classList.toggle('hidden', all.length === 0);
  const count = (test) => all.filter(test).length;
  if (el.statProposals) el.statProposals.textContent = String(all.length);
  if (el.statOpen) {
    el.statOpen.textContent = String(
      count((row) => String(row.status || 'open') === 'open')
    );
  }
  if (el.statRule) {
    el.statRule.textContent = String(count((row) => row.source === 'rule'));
  }
  if (el.statModel) {
    el.statModel.textContent = String(count((row) => row.source === 'model'));
  }
  if (el.statApplied) {
    el.statApplied.textContent = String(
      count((row) => String(row.status) === 'applied')
    );
  }
  if (el.proposalsMeta) {
    el.proposalsMeta.textContent = all.length
      ? `${all.length} ${plural(all.length, 'proposal', 'proposals')}`
      : '';
  }
}

async function loadProposals() {
  if (!el.proposalsBody) return;
  el.proposalsBody.innerHTML = htmlEmptyRow(9, 'Loading proposals…');
  try {
    const payload = await requestJson('/api/simplify/proposals');
    proposals.clear();
    (payload.data || []).forEach((proposal) => {
      proposals.set(num(proposal.tagId), proposal);
    });
    [...selected].forEach((id) => {
      if (!proposals.has(id)) selected.delete(id);
    });
    if (el.proposalsAlert) el.proposalsAlert.innerHTML = '';
    renderProposals();
  } catch (error) {
    el.proposalsBody.innerHTML = htmlEmptyRow(9, error.message);
  }
}

/** One PATCH, and the row redrawn from what came back. */
async function patchProposal(tagId, patch) {
  try {
    const payload = await sendJson(
      'PATCH',
      `/api/simplify/proposals/${encodeURIComponent(String(tagId))}`,
      patch
    );
    if (payload.data) proposals.set(num(payload.data.tagId), payload.data);
    renderProposals();
  } catch (error) {
    toast(error.message, { tone: 'danger' });
    loadProposals();
  }
}

function updateProposeSplitsButton() {
  if (!el.proposeSplitsBtn) return;
  const ready = vocabularySaved;
  el.proposeSplitsBtn.disabled = !ready || jobId !== null;
  if (el.proposeSplitsHint) {
    el.proposeSplitsHint.textContent = ready
      ? 'Runs the rule against your vocabulary first; the model only answers what the rule could not.'
      : 'Save a vocabulary first';
  }
}

function updateApplyButtons() {
  const count = selected.size;
  if (el.applyBtn) el.applyBtn.disabled = count === 0 || applying;
  if (el.skipBtn) el.skipBtn.disabled = count === 0 || applying;
}

/* --- the proposed order, as groups ---------------------------------------- */

/**
 * What a card is called. A type or a topic group is its name; the other three
 * say what they are, because "Amazon" alone would read like a tag.
 *
 * @param {object} group a TagOrderGroup
 * @returns {string}
 */
function groupTitle(group) {
  const kind = String((group && group.kind) || '');
  const name = String(group && group.name == null ? '' : group.name);
  if (kind === 'merge') return `→ ${name}`;
  if (kind === 'delete') return 'Delete';
  if (kind === 'keep') return 'Keep as they are';
  return name;
}

/** The same group in the one sentence a confirmation asks with. */
function groupConfirmName(group) {
  const kind = String((group && group.kind) || '');
  const name = String(group && group.name == null ? '' : group.name);
  if (kind === 'merge') return `merge into ${name}`;
  if (kind === 'delete') return 'the deletions';
  if (kind === 'keep') return 'the tags that stay';
  return name;
}

/** "212 tags · 3,410 documents". */
function groupCountsText(group) {
  const tags = num(group && group.tags);
  const documents = num(group && group.documents);
  return `${tags} ${plural(tags, 'tag', 'tags')} · ${grouped(documents)} ${plural(
    documents,
    'document',
    'documents'
  )}`;
}

/**
 * What the proposed order does with one tag, in the words the member table
 * uses: "→ Rechnung + Strom", "→ merge into Amazon", "delete", "keep".
 *
 * @param {object} member a TagOrderGroupMember
 * @returns {string}
 */
function memberOutcome(member) {
  const action = String((member && member.action) || 'split');
  if (action === 'merge') {
    const target = String(member.mergeInto == null ? '' : member.mergeInto);
    return target === '' ? 'merge' : `→ merge into ${target}`;
  }
  if (action === 'delete') return 'delete';
  if (action === 'keep') return 'keep';
  const parts = [];
  const type = String(member.typeName == null ? '' : member.typeName);
  if (type !== '') parts.push(type);
  (Array.isArray(member.topicNames) ? member.topicNames : []).forEach((raw) => {
    const name = String(raw == null ? '' : raw);
    if (name !== '') parts.push(name);
  });
  return parts.length === 0 ? 'keep' : `→ ${parts.join(' + ')}`;
}

/** "180 open · 30 accepted · 2 applied", as small badges; zeroes are left out. */
function htmlGroupStatusBadges(group) {
  return ['open', 'accepted', 'applied', 'skipped']
    .filter((status) => num(group[status]) > 0)
    .map((status) => {
      const badge = STATUS_BADGES[status] || { tone: '', label: status };
      return `<span class="zr-badge ${esc(badge.tone)}">${esc(`${num(group[status])} ${badge.label}`)}</span>`;
    })
    .join('');
}

/**
 * One row of a group's member table. Pure on purpose: tests/test-simplify-ui.js
 * renders it for every action.
 *
 * @param {object} group the card the row belongs to
 * @param {object} member a TagOrderGroupMember
 * @returns {string} markup
 */
function htmlMemberRow(group, member) {
  const status = String(member.status || 'open');
  const badge = STATUS_BADGES[status] || { tone: '', label: status };
  const name = String(member.tagName == null ? '' : member.tagName);
  const documents = num(member.documentCount);
  // A keep group holds the tags nothing happens to; there is nothing to take
  // out of it, and an applied row is history.
  const htmlRemove =
    String(group.kind || '') === 'keep' || status === 'applied'
      ? ''
      : `<button type="button" class="zr-btn zr-btn--ghost zr-btn--icon sim-member-remove" data-tag-id="${num(member.tagId)}" title="Take this tag out of the group" aria-label="Take ${esc(name)} out of the group">${htmlIconMarkup('i-x')}</button>`;
  const htmlSkip =
    status === 'applied'
      ? ''
      : `<button type="button" class="zr-btn zr-btn--ghost zr-sm sim-member-skip" data-tag-id="${num(member.tagId)}" data-status="${esc(status)}">${esc(status === 'skipped' ? 'Reopen' : 'Skip')}</button>`;
  return `<tr class="sim-member" data-tag-id="${num(member.tagId)}">
        <td data-label="Tag" class="zr-truncate" title="${esc(name)}">${esc(name)}</td>
        <td data-label="Documents" class="zr-mono">${esc(grouped(documents))}</td>
        <td data-label="What happens"><span class="sim-member__outcome">${esc(memberOutcome(member))}</span></td>
        <td data-label="Source">${htmlSourceBadge(member)}</td>
        <td data-label="Reason"><span class="zr-sm zr-faint sim-reason">${esc(member.reason == null ? '' : member.reason)}</span></td>
        <td data-label="Status"><span class="zr-badge ${esc(badge.tone)}">${esc(badge.label)}</span></td>
        <td data-label="Edit" class="sim-member__actions">${htmlSkip}${htmlRemove}</td>
      </tr>`;
}

/**
 * One card. Pure on purpose: tests/test-simplify-ui.js renders it for every
 * kind and reads the badge, the counts and the buttons back.
 *
 * @param {object} group a TagOrderGroup
 * @param {{open?: boolean, shown?: number}} state what the page remembers of it
 * @returns {string} markup
 */
function htmlGroupCard(group, state) {
  const card = state || {};
  const kind = String(group.kind || 'type');
  const members = Array.isArray(group.members) ? group.members : [];
  const shown = Math.max(1, num(card.shown) || MEMBERS_PER_PAGE);
  const rest = Math.max(0, members.length - shown);
  const open = num(group.open);
  const accepted = num(group.accepted);
  const decided = accepted + num(group.skipped);
  // Attribute fragments, not values: the "html" prefix is what marks them as
  // markup this file has already made safe.
  const htmlOpen = card.open === true ? ' open' : '';
  const htmlDecideDisabled = open === 0 ? ' disabled' : '';
  const htmlApplyDisabled = accepted === 0 ? ' disabled' : '';
  const htmlRows = members
    .slice(0, shown)
    .map((member) => htmlMemberRow(group, member))
    .join('');
  const htmlMore =
    rest === 0
      ? ''
      : `<div class="sim-group__morewrap"><button type="button" class="zr-btn zr-btn--ghost sim-group__more">${esc(`Show ${rest} more`)}</button></div>`;
  // A keep group decides nothing and applies nothing: its tags are the ones
  // the order leaves alone.
  const htmlAccept =
    kind === 'keep'
      ? ''
      : `<button type="button" class="zr-btn zr-btn--primary sim-group-accept"${htmlDecideDisabled}>${esc('Accept')}</button>`;
  const htmlApply =
    kind === 'keep'
      ? ''
      : `<button type="button" class="zr-btn sim-group-apply"${htmlApplyDisabled}>${esc('Apply group')}</button>`;
  const htmlReopen =
    decided === 0
      ? ''
      : `<button type="button" class="zr-btn zr-btn--ghost sim-group-reopen">${esc('Reopen')}</button>`;
  const htmlSkip = `<button type="button" class="zr-btn zr-btn--ghost sim-group-skip"${htmlDecideDisabled}>${esc('Skip')}</button>`;
  return `<section class="zr-module sim-group" data-group-key="${esc(group.key)}" data-kind="${esc(kind)}">
    <div class="zr-module__head sim-group__head">
      <span class="zr-badge ${esc(GROUP_KIND_TONES[kind] || '')}">${htmlIconMarkup(GROUP_KIND_ICONS[kind] || 'i-tag')}${esc(GROUP_KIND_LABELS[kind] || kind)}</span>
      <span class="zr-module__title sim-group__name" title="${esc(groupTitle(group))}">${esc(groupTitle(group))}</span>
      <span class="zr-sm zr-faint sim-group__counts">${esc(groupCountsText(group))}</span>
      <span class="zr-chips sim-group__status">${htmlGroupStatusBadges(group)}</span>
    </div>
    <details class="sim-group__members"${htmlOpen}>
      <summary class="sim-group__summary">${esc(`Show ${members.length} ${plural(members.length, 'tag', 'tags')}`)}</summary>
      <div class="zr-table-wrap">
        <table class="zr-table zr-table--stack sim-members">
          <thead>
            <tr>
              <th>Tag</th>
              <th>Documents</th>
              <th>What happens</th>
              <th>Source</th>
              <th class="sim-members__reasoncol">Reason</th>
              <th>Status</th>
              <th class="sim-members__editcol">Edit</th>
            </tr>
          </thead>
          <tbody class="sim-group__rows">${htmlRows}</tbody>
        </table>
      </div>
      ${htmlMore}
    </details>
    <div class="zr-module__foot sim-group__foot">${htmlAccept}${htmlSkip}${htmlReopen}${htmlApply}</div>
  </section>`;
}

/**
 * Every tag of the order, counted once however many groups it is a member of,
 * by status and by action. Pure on purpose.
 *
 * @param {object[]} groupList the cards as the route answered them
 * @param {?string} status only members in this status, or every one
 * @returns {object} { tags, open, accepted, applied, skipped, split, merge, keep, delete }
 */
function memberTotals(groupList, status) {
  const seen = new Map();
  (Array.isArray(groupList) ? groupList : []).forEach((group) => {
    (Array.isArray(group.members) ? group.members : []).forEach((member) => {
      const id = num(member.tagId);
      if (!seen.has(id)) seen.set(id, member);
    });
  });
  const totals = {
    tags: 0,
    open: 0,
    accepted: 0,
    applied: 0,
    skipped: 0,
    split: 0,
    merge: 0,
    keep: 0,
    delete: 0,
  };
  seen.forEach((member) => {
    const rowStatus = String(member.status || 'open');
    if (status && rowStatus !== status) return;
    totals.tags += 1;
    if (totals[rowStatus] !== undefined) totals[rowStatus] += 1;
    const action = String(member.action || 'split');
    if (totals[action] !== undefined) totals[action] += 1;
  });
  return totals;
}

/**
 * The one line a finished order run leaves behind. Pure on purpose.
 *
 * @param {object} result what the job answered
 * @param {object} totals memberTotals() over the groups it produced
 * @returns {string}
 */
function orderSummaryText(result, totals) {
  const run = result || {};
  const tags = num(totals.tags);
  const requests = num(run.requests);
  const parts = [
    `${tags} ${plural(tags, 'tag', 'tags')}: ${num(totals.split)} split, ${num(totals.merge)} merge, ${num(totals.keep)} keep, ${num(totals.delete)} delete`,
    `${num(run.byRule)} by rule, ${num(run.byModel)} by the model`,
    `${requests} ${plural(requests, 'request', 'requests')}`,
  ];
  if (run.stopped === true) parts.push('stopped');
  return parts.join(' · ');
}

/** True while the card passes the three filters above the list. */
function matchesFilters(group) {
  if (groupKind !== 'all' && String(group.kind || '') !== groupKind) {
    return false;
  }
  if (groupStatus !== 'all' && num(group[groupStatus]) <= 0) return false;
  const needle = groupSearch.trim().toLowerCase();
  if (needle === '') return true;
  if (groupTitle(group).toLowerCase().includes(needle)) return true;
  return (Array.isArray(group.members) ? group.members : []).some((member) =>
    String(member.tagName || '')
      .toLowerCase()
      .includes(needle)
  );
}

function visibleGroups() {
  return groups.filter(matchesFilters);
}

function groupByKey(key) {
  return groups.find((group) => String(group.key) === String(key)) || null;
}

/** The card element of a key; a key carries a name, so no selector is built. */
function groupNode(key) {
  if (!el.groups) return null;
  return (
    [...el.groups.querySelectorAll('.sim-group')].find(
      (node) => node.dataset.groupKey === String(key)
    ) || null
  );
}

function cardState(group) {
  return {
    open: groupsOpen.has(String(group.key)),
    shown: groupShown.get(String(group.key)) || MEMBERS_PER_PAGE,
  };
}

function renderGroups() {
  if (!el.groups) return;
  const rows = visibleGroups();
  el.groups.innerHTML = rows
    .map((group) => htmlGroupCard(group, cardState(group)))
    .join('');
  renderViewState();
  renderOrderEmpty(rows.length);
  renderOrderStats();
  updateApplyAcceptedButton();
}

/** One card redrawn from what a route answered; a group that is gone is gone. */
function renderGroupCard(key, group) {
  const at = groups.findIndex((row) => String(row.key) === String(key));
  if (!group) {
    if (at !== -1) groups.splice(at, 1);
    groupsOpen.delete(String(key));
    groupShown.delete(String(key));
    renderGroups();
    return;
  }
  if (at === -1) groups.push(group);
  else groups[at] = group;
  const node = groupNode(key);
  if (!node) {
    renderGroups();
    return;
  }
  // In place, and in place even when the decision just took the card out of
  // the filter: a group that was accepted is a group that is about to be
  // applied, and it must not vanish under the hand that accepted it.
  node.outerHTML = htmlGroupCard(group, cardState(group));
  renderOrderStats();
  updateApplyAcceptedButton();
}

function renderOrderEmpty(count) {
  if (!el.orderEmpty) return;
  const show = view === 'groups' && count === 0;
  if (show) {
    el.orderEmpty.textContent =
      groups.length === 0 ? ORDER_EMPTY : GROUPS_EMPTY;
  }
  el.orderEmpty.classList.toggle('hidden', !show);
}

function renderOrderStats() {
  const has = groups.length > 0;
  if (el.orderStats) el.orderStats.classList.toggle('hidden', !has);
  const ofKind = (kind) =>
    groups.filter((group) => String(group.kind || '') === kind).length;
  const write = (node, value) => {
    if (node) node.textContent = String(value);
  };
  write(el.statGroupTypes, ofKind('type'));
  write(el.statGroupTopics, ofKind('topic'));
  write(el.statGroupMerges, ofKind('merge'));
  write(el.statGroupDelete, ofKind('delete'));
  write(el.statGroupKeep, ofKind('keep'));
  const totals = memberTotals(groups);
  write(el.statOrderAccepted, totals.accepted);
  write(el.statOrderApplied, totals.applied);
  if (el.orderMeta) {
    el.orderMeta.textContent = has
      ? `${groups.length} ${plural(groups.length, 'group', 'groups')} · ${totals.tags} ${plural(totals.tags, 'tag', 'tags')}`
      : '';
  }
}

function renderOrderSummary() {
  if (!el.orderSummary) return;
  const text = orderResult
    ? orderSummaryText(
        Object.assign({}, orderResult, { stopped: orderStopped }),
        memberTotals(groups)
      )
    : '';
  el.orderSummary.textContent = text;
  el.orderSummary.classList.toggle('hidden', text === '');
}

function updateApplyAcceptedButton() {
  if (!el.applyAcceptedBtn) return;
  const accepted = memberTotals(groups, 'accepted').tags;
  if (el.applyAcceptedLabel) {
    el.applyAcceptedLabel.textContent = `Apply all accepted (${accepted})`;
  }
  el.applyAcceptedBtn.disabled = accepted === 0 || jobId !== null || applying;
}

/** What the view segment decides: the cards and their filters, or the table. */
function renderViewState() {
  const table = view === 'table';
  if (el.groupFilters) {
    // Three filters over nothing are noise; they come back with the groups.
    el.groupFilters.classList.toggle('hidden', table || groups.length === 0);
  }
  if (el.groups) el.groups.classList.toggle('hidden', table);
  if (el.proposals) el.proposals.classList.toggle('hidden', !table);
}

/** Groups or table; the table is the same proposals, one row each. */
function setView(next) {
  view = next === 'table' ? 'table' : 'groups';
  if (el.view) {
    [...el.view.querySelectorAll('button[data-view]')].forEach((button) => {
      button.setAttribute(
        'aria-selected',
        button.dataset.view === view ? 'true' : 'false'
      );
    });
  }
  renderViewState();
  renderOrderEmpty(visibleGroups().length);
}

async function loadGroups() {
  if (!el.groups) return;
  try {
    const payload = await requestJson('/api/simplify/groups');
    const data = payload.data || {};
    groups = Array.isArray(data.groups) ? data.groups : [];
    renderGroups();
  } catch (error) {
    groups = [];
    renderGroups();
    if (el.orderEmpty) {
      el.orderEmpty.textContent = error.message;
      el.orderEmpty.classList.remove('hidden');
    }
  }
}

/** Accept, skip or reopen every open member of one group. */
async function decideGroup(group, decision) {
  try {
    const payload = await sendJson(
      'POST',
      `/api/simplify/groups/${encodeURIComponent(String(group.key))}/decision`,
      { decision }
    );
    const data = payload.data || {};
    renderGroupCard(group.key, data.group || null);
    toast(
      `${groupTitle(group)} ${DECISION_WORDS[decision] || decision}: ${num(data.changed)} ${plural(num(data.changed), 'tag', 'tags')}`,
      { tone: 'ok' }
    );
  } catch (error) {
    toast(error.message, { tone: 'danger' });
    await loadGroups();
  }
}

/**
 * What a removal did, in one short sentence. Pure on purpose: the route
 * answers the patched proposal, and this reads it back.
 *
 * @param {object} group the card the tag was taken out of
 * @param {object} proposal the TagSplitProposal the route answered
 * @returns {string}
 */
function removeMemberText(group, proposal) {
  const name = String(proposal.tagName == null ? '' : proposal.tagName);
  const action = String(proposal.action || 'keep');
  const kind = String(group.kind || '');
  if (action === 'keep') return `${name} is kept as it is`;
  if (kind === 'type') return `${name} keeps its topics, loses the type`;
  if (kind === 'topic') {
    return `${name} loses the topic ${String(group.name == null ? '' : group.name)}`;
  }
  return `${name} is kept as it is`;
}

/** One tag out of one group. No question asked; the toast says what happened. */
async function removeGroupMember(group, tagId) {
  try {
    const payload = await requestJson(
      `/api/simplify/groups/${encodeURIComponent(String(group.key))}/members/${encodeURIComponent(String(tagId))}`,
      { method: 'DELETE' }
    );
    // The answer is one proposal, and a proposal can sit in three groups, so
    // the list is read again rather than patched in place.
    await loadGroups();
    toast(removeMemberText(group, payload.data || {}), { tone: 'ok' });
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  }
}

/** The per-tag skip, and the same button back again. */
async function toggleMemberStatus(group, tagId, status) {
  const next = String(status) === 'skipped' ? 'open' : 'skipped';
  try {
    await sendJson(
      'PATCH',
      `/api/simplify/proposals/${encodeURIComponent(String(tagId))}`,
      { status: next }
    );
    await loadGroups();
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  }
}

/* --- the two jobs of the order -------------------------------------------- */

/** Everything that starts a job is dead while one runs. */
function setOrderBusy(busy) {
  if (el.orderBtn) el.orderBtn.disabled = busy;
  if (el.reproposeBtn) el.reproposeBtn.disabled = busy;
  updateApplyAcceptedButton();
  updateProposeSplitsButton();
}

/**
 * The one job that proposes the order: the vocabulary, then an action for
 * every tag. 'keep' runs it against the saved vocabulary instead.
 */
async function runOrderJob(mode) {
  if (jobId) return;
  setOrderBusy(true);
  if (el.applyResult) el.applyResult.innerHTML = '';
  try {
    const job = await startJob('/api/simplify/order/propose', {
      vocabulary: mode === 'keep' ? 'keep' : 'propose',
    });
    const { result, stopped } = await followJob(job);
    orderResult = result || {};
    orderStopped = stopped === true;
    await loadVocabulary();
    await loadGroups();
    await loadProposals();
    renderOrderSummary();
    toast(stopped ? 'The order was stopped' : 'The order is ready', {
      tone: stopped ? 'warn' : 'ok',
    });
  } catch (error) {
    if (el.applyResult) {
      el.applyResult.innerHTML = htmlAlert(
        'danger',
        'The order could not be proposed',
        error.message
      );
    }
    toast(error.message, { tone: 'danger' });
  } finally {
    setOrderBusy(false);
  }
}

function proposeOrder() {
  const keep = el.keepVocabulary !== null && el.keepVocabulary.checked === true;
  return runOrderJob(keep ? 'keep' : 'propose');
}

/** The same job from the vocabulary block: these names, no new ones. */
function repropose() {
  return runOrderJob('keep');
}

/**
 * The one sentence "Apply group" asks with. Pure on purpose.
 *
 * @param {object} group a TagOrderGroup
 * @returns {string}
 */
function groupApplyConfirmText(group) {
  const accepted = num(group.accepted);
  const kind = String(group.kind || '');
  const name = String(group.name == null ? '' : group.name);
  let what;
  if (kind === 'merge') {
    what = `their documents merge into ${name}; the tags are deleted`;
  } else if (kind === 'delete') {
    what = 'the tags are deleted from their documents';
  } else if (kind === 'topic') {
    what =
      'their documents get the document type and the topics of each tag; the tags are deleted';
  } else {
    what = `their documents get the document type ${name} and the topics of each tag; the tags are deleted`;
  }
  return `Apply ${groupConfirmName(group)}? ${accepted} accepted ${plural(accepted, 'tag', 'tags')}: ${what}. You can undo each one from the log on the Duplicates page.`;
}

/**
 * And the one "Apply all accepted" asks with, with the totals per action.
 * Pure on purpose.
 *
 * @param {object} totals memberTotals(groups, 'accepted')
 * @returns {string}
 */
function applyAllConfirmText(totals) {
  const tags = num(totals.tags);
  const parts = [];
  if (num(totals.split) > 0) {
    parts.push(
      `${num(totals.split)} ${plural(num(totals.split), 'is', 'are')} split into a document type and topics`
    );
  }
  if (num(totals.merge) > 0) {
    parts.push(`${num(totals.merge)} merge into another tag`);
  }
  if (num(totals.delete) > 0) {
    parts.push(
      `${num(totals.delete)} ${plural(num(totals.delete), 'is', 'are')} deleted from their documents`
    );
  }
  if (num(totals.keep) > 0) {
    parts.push(`${num(totals.keep)} stay as they are`);
  }
  return `Apply everything accepted? ${tags} ${plural(tags, 'tag', 'tags')}: ${parts.join(', ')}. You can undo each one from the log on the Duplicates page.`;
}

/**
 * The line an apply leaves behind: "12 split, 3 merged, 1 deleted, 2 failed".
 * Pure on purpose.
 *
 * @param {object} result a TagOrderApplyResult
 * @returns {string}
 */
function applyResultText(result) {
  const applied = Array.isArray(result.applied) ? result.applied : [];
  const merged = Array.isArray(result.merged) ? result.merged : [];
  const failed = Array.isArray(result.failed) ? result.failed : [];
  const deleted = applied.filter(
    (entry) => String(entry.action || 'split') === 'delete'
  ).length;
  const parts = [
    `${applied.length - deleted} split`,
    `${merged.length} merged`,
    `${deleted} deleted`,
  ];
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  return parts.join(', ');
}

/** The same, as the block under the panel, with every failure named. */
function htmlApplyResultBlock(result, stopped) {
  const failed = Array.isArray(result.failed) ? result.failed : [];
  const htmlItems = failed
    .map(
      (failure) =>
        `<li class="zr-sm">${esc(`${failure.tagName == null ? failure.tagId : failure.tagName}: ${failure.error}`)}</li>`
    )
    .join('');
  const htmlFailures =
    failed.length === 0
      ? ''
      : `<ul class="sim-apply-result__failures">${htmlItems}</ul>`;
  const htmlNote =
    stopped === true
      ? `<p class="zr-sm">${esc('Stopped; everything that was not applied stays accepted.')}</p>`
      : '';
  const tone = failed.length > 0 ? 'warn' : 'ok';
  return `<div class="zr-alert zr-alert--${esc(tone)}"><div class="zr-alert__body"><div class="zr-alert__title">${esc(applyResultText(result))}</div>${htmlNote}${htmlFailures}</div></div>`;
}

/** Starts the apply job, for one group or for everything accepted. */
async function applyOrder(groupKey) {
  if (jobId) return;
  setOrderBusy(true);
  applying = true;
  if (el.applyResult) el.applyResult.innerHTML = '';
  try {
    const job = await startJob(
      '/api/simplify/order/apply',
      groupKey ? { groupKey } : {}
    );
    const { result, stopped } = await followJob(job);
    const data = result || {};
    if (el.applyResult) {
      el.applyResult.innerHTML = htmlApplyResultBlock(
        data,
        stopped === true || data.stopped === true
      );
    }
    await loadGroups();
    await loadProposals();
    // An apply creates the document types it needs, so the picker's choices
    // are one behind. The service drops the cache on that write; this reads it.
    await loadDocumentTypes();
    const failures = Array.isArray(data.failed) ? data.failed.length : 0;
    toast(applyResultText(data), { tone: failures > 0 ? 'warn' : 'ok' });
  } catch (error) {
    if (el.applyResult) {
      el.applyResult.innerHTML = htmlAlert(
        'danger',
        'The order could not be applied',
        error.message
      );
    }
    toast(error.message, { tone: 'danger' });
  } finally {
    applying = false;
    setOrderBusy(false);
  }
}

async function applyGroup(group) {
  const confirmed = await confirmDialog({
    title: 'Apply this group',
    body: groupApplyConfirmText(group),
    confirmLabel: 'Apply',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;
  await applyOrder(group.key);
}

async function applyAllAccepted() {
  const totals = memberTotals(groups, 'accepted');
  if (totals.tags === 0) return;
  const confirmed = await confirmDialog({
    title: 'Apply everything accepted',
    body: applyAllConfirmText(totals),
    confirmLabel: 'Apply',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;
  await applyOrder(null);
}

/* --- the job panel -------------------------------------------------------- */

/** Token counts the way a bill reads: "980", "12.4k", "1.2M". */
function formatTokens(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 1000) return String(Math.round(count));
  const million = count >= 1000000;
  const scaled = count / (million ? 1000000 : 1000);
  const shown =
    scaled < 100 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
  return `${shown}${million ? 'M' : 'k'}`;
}

/** How long this has been running: "0:07", "1:24", "1:02:03". */
function formatElapsed(ms) {
  const total = Math.max(0, Number(ms) || 0) / 1000;
  const seconds = Math.floor(total % 60);
  const minutes = Math.floor((total / 60) % 60);
  const hours = Math.floor(total / 3600);
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** What is left, or '' when the job has nothing to estimate from yet. */
function formatEta(ms) {
  if (ms === null || ms === undefined || ms === '') return '';
  const left = Number(ms);
  if (!Number.isFinite(left) || left < 0) return '';
  if (left < 5000) return 'almost done';
  if (left < 60000) return `about ${Math.round(left / 1000)} s left`;
  return `about ${Math.max(1, Math.round(left / 60000))} min left`;
}

/** How far the job is, 0 to 100, or null while the plan is unknown. */
function progressPercent(progress) {
  const state = progress || {};
  const planned = Number(state.requestsPlanned);
  if (!Number.isFinite(planned) || planned <= 0) return null;
  const done = Number(state.requestsDone) || 0;
  return Math.max(0, Math.min(100, Math.round((done / planned) * 100)));
}

/** "Request 2 of 9 · 12.4k of 200k tokens". */
function progressCountsText(progress) {
  const state = progress || {};
  const parts = [];
  const done = Number(state.requestsDone) || 0;
  const planned = Number(state.requestsPlanned);
  if (Number.isFinite(planned) && planned > 0) {
    parts.push(`Request ${Math.min(done, planned)} of ${planned}`);
  } else if (done > 0) {
    parts.push(`Request ${done}`);
  }
  const budget = Number(state.tokenBudget);
  const spent = formatTokens(state.tokens);
  parts.push(
    Number.isFinite(budget) && budget > 0
      ? `${spent} of ${formatTokens(budget)} tokens`
      : `${spent} tokens`
  );
  return parts.join(' · ');
}

/** "about 40 s left · 1:24 elapsed"; the elapsed part is always there. */
function progressTimeText(progress, elapsedMs) {
  const state = progress || {};
  const parts = [];
  const eta = formatEta(state.etaMs);
  if (eta) parts.push(eta);
  parts.push(`${formatElapsed(elapsedMs)} elapsed`);
  return parts.join(' · ');
}

/** The single line the panel keeps after a job ended. */
function progressOutcomeText(event) {
  const job = (event && event.job) || {};
  const state = job.progress || {};
  const elapsed = formatElapsed(state.elapsedMs);
  const done = Number(state.requestsDone) || 0;
  const requests = `${done} ${plural(done, 'request', 'requests')}`;
  const tokens = `${formatTokens(state.tokens)} tokens`;
  if (event && event.type === 'failed') return `Failed after ${elapsed}`;
  if (event && event.type === 'stopped') {
    return `Stopped after ${requests} · ${tokens}`;
  }
  return `Done in ${elapsed} · ${requests} · ${tokens}`;
}

function setStopLabel(text) {
  if (!el.stopBtn) return;
  const label = el.stopBtn.querySelector('.sim-progress__stop-label');
  if (label) label.textContent = text;
}

function showProgressPanel() {
  if (!el.progress) return;
  el.progress.classList.remove('hidden');
  if (el.stopBtn) {
    el.stopBtn.classList.remove('hidden');
    el.stopBtn.disabled = false;
    setStopLabel('Stop');
  }
}

function startProgressTicker() {
  if (progressTimer !== null) return;
  progressTimer = window.setInterval(drawProgressTime, 1000);
}

function stopProgressTicker() {
  if (progressTimer === null) return;
  window.clearInterval(progressTimer);
  progressTimer = null;
}

function drawProgressTime() {
  if (!el.progressEta || !progressJob) return;
  const state = progressJob.progress || {};
  const base = Number(state.elapsedMs) || 0;
  const live = progressJob.finishedAt ? base : base + (Date.now() - progressAt);
  el.progressEta.textContent = progressTimeText(state, live);
}

/** One `progress` event on the panel. */
function renderProgress(job) {
  if (!el.progress || !job) return;
  progressJob = job;
  progressAt = Date.now();
  const state = job.progress || {};
  const percent = progressPercent(state);
  if (el.progressFill) {
    const unknown = percent === null;
    el.progressFill.classList.toggle(
      'sim-progress__fill--indeterminate',
      unknown
    );
    el.progressFill.style.width = unknown ? '' : `${percent}%`;
  }
  if (el.progressBar) {
    if (percent === null) {
      el.progressBar.removeAttribute('aria-valuenow');
    } else {
      el.progressBar.setAttribute('aria-valuenow', String(percent));
    }
  }
  if (el.progressMessage) el.progressMessage.textContent = state.message || '';
  if (el.progressCounts) {
    el.progressCounts.textContent = progressCountsText(state);
  }
  drawProgressTime();
  startProgressTicker();
}

/** The last thing the panel says; it stays until the next run. */
function renderProgressOutcome(event) {
  if (!el.progress) return;
  progressJob = (event && event.job) || null;
  progressAt = Date.now();
  stopProgressTicker();
  if (el.stopBtn) {
    el.stopBtn.disabled = true;
    el.stopBtn.classList.add('hidden');
  }
  const percent = progressPercent(progressJob ? progressJob.progress : null);
  if (el.progressFill) {
    el.progressFill.classList.remove('sim-progress__fill--indeterminate');
    el.progressFill.style.width =
      event.type === 'done' ? '100%' : `${percent === null ? 0 : percent}%`;
  }
  if (el.progressMessage) {
    el.progressMessage.textContent = progressOutcomeText(event);
  }
  if (el.progressCounts) el.progressCounts.textContent = '';
  if (el.progressEta) el.progressEta.textContent = '';
}

/**
 * Follows a job of this page to its end. The event stream is the normal way;
 * a proxy that breaks it drops the page onto polling the job instead, and a
 * poll counts as watching, so the job does not stop itself.
 *
 * @param {object} job  the AiReviewJob to follow
 * @returns {Promise<{result: object|null, stopped: boolean}>}
 */
function followJob(job) {
  return new Promise((resolve, reject) => {
    jobId = job.id;
    const base = `/api/duplicates/ai-review/jobs/${encodeURIComponent(job.id)}`;
    showProgressPanel();
    renderProgress(job);

    let settled = false;
    let source = null;
    let poll = null;

    const closeSource = () => {
      if (!source) return;
      try {
        source.close();
      } catch {
        // Already gone; nothing to close.
      }
      source = null;
    };

    const stopPolling = () => {
      if (poll === null) return;
      window.clearInterval(poll);
      poll = null;
    };

    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      closeSource();
      stopPolling();
      jobId = null;
      setOrderBusy(false);
      finish(value);
    };

    const handle = (event) => {
      if (settled || !event) return;
      if (event.type === 'progress') {
        renderProgress(event.job);
        return;
      }
      renderProgressOutcome(event);
      if (event.type === 'failed') {
        settle(reject, new Error(event.error || 'The job failed.'));
        return;
      }
      settle(resolve, {
        result: event.data || null,
        stopped: event.type === 'stopped',
      });
    };

    const pollOnce = async () => {
      if (settled) return;
      try {
        const payload = await requestJson(base);
        const current = payload.data ? payload.data.job : null;
        if (!current) throw new Error('The job is gone.');
        if (JOB_LIVE_STATES.includes(current.status)) {
          renderProgress(current);
          return;
        }
        handle({
          type: current.status === 'failed' ? 'failed' : current.status,
          job: current,
          data: payload.data ? payload.data.result : null,
          error: current.error,
        });
      } catch (error) {
        settle(reject, error);
      }
    };

    const startPolling = () => {
      if (settled || poll !== null) return;
      poll = window.setInterval(pollOnce, JOB_POLL_MS);
    };

    if (typeof window.EventSource === 'function') {
      source = new EventSource(`${base}/events`);
      source.onmessage = (message) => {
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        handle(event);
      };
      source.onerror = () => {
        if (settled) return;
        closeSource();
        startPolling();
      };
    } else {
      startPolling();
    }
  });
}

/** Asks the job to end after the request it is in. No dialog, no question. */
async function stopJob() {
  if (!el.stopBtn || !jobId) return;
  el.stopBtn.disabled = true;
  setStopLabel('Stopping…');
  const id = jobId;
  try {
    const payload = await sendJson(
      'POST',
      `/api/duplicates/ai-review/jobs/${encodeURIComponent(id)}/stop`,
      {}
    );
    const job = payload.data ? payload.data.job : null;
    if (job && jobId === id && JOB_LIVE_STATES.includes(job.status)) {
      renderProgress(job);
    }
  } catch (error) {
    if (el.stopBtn && jobId === id) {
      el.stopBtn.disabled = false;
      setStopLabel('Stop');
    }
    toast(error.message, { tone: 'danger' });
  }
}

/** Starts one of the two jobs and hands back the job the server named. */
async function startJob(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    // A body this page cannot read is a body it ignores; the status decides.
    payload = null;
  }
  const job = payload && payload.data ? payload.data.job : null;
  // A 409 that names a job is not a failure: another tab started this very
  // run, so this page watches it instead of asking twice.
  if (response.status !== 202 && !(response.status === 409 && job)) {
    throw new Error(
      (payload && payload.error) ||
        `The server answered ${response.status} without a body.`
    );
  }
  if (!job) throw new Error('The server started a job without naming it.');
  return job;
}

async function proposeVocabulary() {
  if (!el.proposeVocabularyBtn || jobId) return;
  el.proposeVocabularyBtn.disabled = true;
  try {
    const job = await startJob('/api/simplify/vocabulary/propose', {});
    const { result, stopped } = await followJob(job);
    const data = result || {};
    vocabulary.types = mergeProposedVocabulary(vocabulary.types, data.types);
    vocabulary.topics = mergeProposedVocabulary(vocabulary.topics, data.topics);
    renderVocabulary();
    if (el.vocabularyNotice) {
      el.vocabularyNotice.innerHTML = htmlAlert(
        stopped ? 'warn' : 'info',
        PROPOSAL_NOTICE,
        UNSAVED_HINT
      );
    }
    toast('The model proposed a vocabulary', { tone: 'ok' });
  } catch (error) {
    if (el.vocabularyNotice) {
      el.vocabularyNotice.innerHTML = htmlAlert(
        'danger',
        'The vocabulary proposal failed',
        error.message
      );
    }
    toast(error.message, { tone: 'danger' });
  } finally {
    el.proposeVocabularyBtn.disabled = false;
  }
}

async function proposeSplits() {
  if (!el.proposeSplitsBtn || jobId) return;
  el.proposeSplitsBtn.disabled = true;
  if (el.proposalsAlert) el.proposalsAlert.innerHTML = '';
  try {
    const job = await startJob('/api/simplify/proposals/run', {});
    await followJob(job);
    await loadProposals();
    toast('The proposals are ready', { tone: 'ok' });
  } catch (error) {
    if (el.proposalsAlert) {
      el.proposalsAlert.innerHTML = htmlAlert(
        'danger',
        'The split proposals failed',
        error.message
      );
    }
    toast(error.message, { tone: 'danger' });
  } finally {
    updateProposeSplitsButton();
  }
}

/**
 * On load: a job of this page that is still running gets its page back. A
 * review of the Duplicates page is left alone — it belongs there.
 */
async function reattachJob() {
  if (!el.progress) return;
  let job;
  try {
    const payload = await requestJson('/api/duplicates/ai-review/jobs/current');
    job = payload.data ? payload.data.job : null;
  } catch {
    return;
  }
  if (!job || !JOB_LIVE_STATES.includes(job.status)) return;
  const task = String(job.task || '');
  const mine = [
    JOB_TASKS.VOCABULARY,
    JOB_TASKS.SPLITS,
    JOB_TASKS.ORDER,
    JOB_TASKS.APPLY,
  ];
  if (!mine.includes(task)) return;
  try {
    const { result, stopped } = await followJob(job);
    if (task === JOB_TASKS.SPLITS) {
      await loadProposals();
      return;
    }
    if (task === JOB_TASKS.ORDER) {
      orderResult = result || {};
      orderStopped = stopped === true;
      await loadVocabulary();
      await loadGroups();
      await loadProposals();
      renderOrderSummary();
      return;
    }
    if (task === JOB_TASKS.APPLY) {
      const applied = result || {};
      if (el.applyResult) {
        el.applyResult.innerHTML = htmlApplyResultBlock(
          applied,
          stopped === true || applied.stopped === true
        );
      }
      await loadGroups();
      await loadProposals();
      return;
    }
    const data = result || {};
    vocabulary.types = mergeProposedVocabulary(vocabulary.types, data.types);
    vocabulary.topics = mergeProposedVocabulary(vocabulary.topics, data.topics);
    renderVocabulary();
    if (el.vocabularyNotice) {
      el.vocabularyNotice.innerHTML = htmlAlert(
        'info',
        PROPOSAL_NOTICE,
        UNSAVED_HINT
      );
    }
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  }
}

/* --- applying ------------------------------------------------------------- */

/**
 * The one sentence the confirmation asks with. Pure on purpose:
 * tests/test-simplify-ui.js checks the numbers it produces.
 *
 * @param {Array<{documents: number, typeSet: number, typeKept: number}>} entries
 * @returns {string}
 */
function applyConfirmText(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const tags = list.length;
  const total = (key) => list.reduce((sum, entry) => sum + num(entry[key]), 0);
  const documents = total('documents');
  const typeSet = total('typeSet');
  const typeKept = total('typeKept');
  const parts = [
    `Split ${tags} ${plural(tags, 'tag', 'tags')}: ${documents} ${plural(documents, 'document gets', 'documents get')} their topics`,
  ];
  if (typeSet > 0 || typeKept > 0) {
    let type = `${typeSet} ${plural(typeSet, 'gets', 'get')} their document type`;
    if (typeKept > 0) {
      type += `, ${typeKept} ${plural(typeKept, 'keeps', 'keep')} the one they have`;
    }
    parts.push(type);
  }
  return `${parts.join('; ')}. ${tags} ${plural(tags, 'tag is', 'tags are')} deleted. You can undo each split from the log on the Duplicates page.`;
}

function setApplyStatus(text) {
  if (!el.applyStatus) return;
  el.applyStatus.textContent = text || '';
  el.applyStatus.classList.toggle('hidden', !text);
}

/**
 * What one split would touch. The route asks Paperless-ngx; a build whose
 * service cannot answer yet (501) falls back to what the proposal itself
 * recorded, so the confirmation still names honest numbers.
 */
async function impactOf(proposal) {
  const fallback = {
    tagId: proposal.tagId,
    tagName: proposal.tagName,
    documents: num(proposal.documentCount),
    typeKept:
      proposal.overwriteType === true ? 0 : num(proposal.documentsWithType),
    typeSet: 0,
  };
  fallback.typeSet =
    proposal.typeName == null ? 0 : fallback.documents - fallback.typeKept;
  try {
    const payload = await requestJson(
      `/api/simplify/proposals/${encodeURIComponent(String(proposal.tagId))}/impact`
    );
    const data = payload.data || {};
    return {
      tagId: proposal.tagId,
      tagName: proposal.tagName,
      documents: num(data.documents),
      typeSet: num(data.typeSet),
      typeKept: num(data.typeKept),
    };
  } catch {
    return fallback;
  }
}

async function applySelected() {
  if (applying || selected.size === 0) return;
  const picks = [...selected]
    .map((id) => proposals.get(id))
    .filter((proposal) => proposal && String(proposal.status) !== 'applied');
  if (picks.length === 0) return;
  if (picks.length > MAX_APPLY_TAGS) {
    toast(`At most ${MAX_APPLY_TAGS} tags can be applied at once`, {
      tone: 'danger',
    });
    return;
  }
  applying = true;
  updateApplyButtons();
  const entries = [];
  try {
    for (let index = 0; index < picks.length; index += 1) {
      setApplyStatus(`Checking documents, ${index + 1} of ${picks.length}…`);
      entries.push(await impactOf(picks[index]));
    }
  } finally {
    setApplyStatus('');
  }

  const confirmed = await confirmDialog({
    title: 'Apply these splits',
    body: applyConfirmText(entries),
    confirmLabel: 'Split',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) {
    applying = false;
    updateApplyButtons();
    return;
  }

  try {
    const payload = await sendJson('POST', '/api/simplify/apply', {
      tagIds: picks.map((proposal) => num(proposal.tagId)),
    });
    const data = payload.data || {};
    (data.failed || []).forEach((failure) => {
      const proposal = proposals.get(num(failure.tagId));
      if (proposal) proposal.error = failure.error;
    });
    selected.clear();
    if (payload.success) {
      toast(payload.message || 'The splits were applied', { tone: 'ok' });
    } else {
      toast(payload.message || 'Not every split went through', {
        tone: 'danger',
      });
    }
    await loadProposals();
    // A split creates the document type it needs, so the picker's choices are
    // one behind. The service drops the cache on that write; this reads it.
    await loadDocumentTypes();
    (data.failed || []).forEach((failure) => {
      const proposal = proposals.get(num(failure.tagId));
      if (proposal) proposal.error = failure.error;
    });
    renderProposals();
  } catch (error) {
    if (el.proposalsAlert) {
      el.proposalsAlert.innerHTML = htmlAlert(
        'danger',
        'The splits could not be applied',
        error.message
      );
    }
    toast(error.message, { tone: 'danger' });
  } finally {
    applying = false;
    updateApplyButtons();
  }
}

async function skipSelected() {
  if (applying || selected.size === 0) return;
  const ids = [...selected];
  for (const id of ids) {
    const proposal = proposals.get(id);
    if (!proposal || String(proposal.status) === 'applied') continue;
    await patchProposal(id, { status: 'skipped' });
  }
  selected.clear();
  renderProposals();
}

/* --- wiring --------------------------------------------------------------- */

function initVocabulary() {
  // Before addFrom() below, so the picker's Enter handler runs first and can
  // mark the event as handled for it.
  initTypePicker();

  const addFrom = (input, dimension, added) => {
    if (!input) return;
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      // The picker already picked a row with this Enter; the text in the
      // field is a query, not a name to add.
      if (event.defaultPrevented) return;
      event.preventDefault();
      const name = String(input.value || '').trim();
      if (!addVocabularyName(dimension, name)) return;
      input.value = '';
      if (added) added(name);
    });
  };
  addFrom(el.typeInput, 'type');
  addFrom(el.topicInput, 'topic', showTopicHint);

  if (el.topicHint) {
    el.topicHint.addEventListener('click', (event) => {
      const button = event.target.closest('.sim-hint__use');
      if (button) takeExistingSpelling(button);
    });
  }

  if (el.typesReloadBtn) {
    el.typesReloadBtn.addEventListener('click', reloadDocumentTypes);
  }
  if (el.adoptTypes) {
    el.adoptTypes.addEventListener('click', (event) => {
      if (event.target.closest('#simAdoptTypesBtn')) adoptDocumentTypes();
    });
  }

  [el.types, el.topics].forEach((host) => {
    if (!host) return;
    host.addEventListener('click', (event) => {
      const button = event.target.closest('.sim-chip__remove');
      if (!button) return;
      removeVocabularyName(button.dataset.dimension, button.dataset.name);
    });
  });

  if (el.saveVocabularyBtn) {
    el.saveVocabularyBtn.addEventListener('click', saveVocabulary);
  }
  if (el.proposeVocabularyBtn) {
    el.proposeVocabularyBtn.addEventListener('click', proposeVocabulary);
  }
}

/** The search field over the document types, on the vocabulary's type list. */
function initTypePicker() {
  if (!el.typeInput || !el.typeList) return;
  createPicker({
    input: el.typeInput,
    list: el.typeList,
    prefix: 'simTypeRow',
    choices: typeChoices,
    emptyText: 'No document type matches. Press Enter to add it as a new one.',
    onPick: (record) => {
      const name = String(record.name == null ? '' : record.name);
      el.typeInput.value = '';
      // A type the vocabulary already holds is shown so it can be recognised,
      // not so it can be added twice; picking it only closes the list.
      if (inVocabulary('type', name)) return;
      addVocabularyName('type', name);
    },
  });
}

/** The order section: the two jobs, the three filters and the cards. */
function initOrder() {
  if (el.orderBtn) el.orderBtn.addEventListener('click', proposeOrder);
  if (el.reproposeBtn) {
    el.reproposeBtn.addEventListener('click', repropose);
  }
  if (el.applyAcceptedBtn) {
    el.applyAcceptedBtn.addEventListener('click', applyAllAccepted);
  }

  const pickOne = (host, attribute, apply) => {
    if (!host) return;
    host.addEventListener('click', (event) => {
      const button = event.target.closest(`button[${attribute}]`);
      if (!button) return;
      [...host.querySelectorAll('button')].forEach((entry) => {
        entry.setAttribute(
          'aria-selected',
          entry === button ? 'true' : 'false'
        );
      });
      apply(button.dataset);
    });
  };
  pickOne(el.view, 'data-view', (data) => setView(data.view));
  pickOne(el.groupKind, 'data-kind', (data) => {
    groupKind = data.kind;
    renderGroups();
  });
  pickOne(el.groupStatus, 'data-group-status', (data) => {
    groupStatus = data.groupStatus;
    renderGroups();
  });
  if (el.groupSearch) {
    el.groupSearch.addEventListener('input', () => {
      groupSearch = el.groupSearch.value || '';
      renderGroups();
    });
  }

  if (!el.groups) return;
  el.groups.addEventListener('click', (event) => {
    const card = event.target.closest('.sim-group');
    if (!card) return;
    const group = groupByKey(card.dataset.groupKey);
    if (!group) return;
    if (event.target.closest('.sim-group-accept')) {
      decideGroup(group, 'accept');
      return;
    }
    if (event.target.closest('.sim-group-skip')) {
      decideGroup(group, 'skip');
      return;
    }
    if (event.target.closest('.sim-group-reopen')) {
      decideGroup(group, 'reopen');
      return;
    }
    if (event.target.closest('.sim-group-apply')) {
      applyGroup(group);
      return;
    }
    if (event.target.closest('.sim-group__more')) {
      groupShown.set(
        String(group.key),
        (Array.isArray(group.members) ? group.members : []).length
      );
      renderGroupCard(group.key, group);
      return;
    }
    const remove = event.target.closest('.sim-member-remove');
    if (remove) {
      removeGroupMember(group, num(remove.dataset.tagId));
      return;
    }
    const skip = event.target.closest('.sim-member-skip');
    if (skip) {
      toggleMemberStatus(group, num(skip.dataset.tagId), skip.dataset.status);
    }
  });

  // A card that is open stays open across a re-render; `toggle` does not
  // bubble, so the listener has to catch it on the way down.
  el.groups.addEventListener(
    'toggle',
    (event) => {
      const details = event.target;
      if (
        !details.classList ||
        !details.classList.contains('sim-group__members')
      ) {
        return;
      }
      const card = details.closest('.sim-group');
      if (!card) return;
      const key = String(card.dataset.groupKey);
      if (details.open) groupsOpen.add(key);
      else groupsOpen.delete(key);
    },
    true
  );
}

function initProposals() {
  if (el.proposeSplitsBtn) {
    el.proposeSplitsBtn.addEventListener('click', proposeSplits);
  }
  if (el.stopBtn) el.stopBtn.addEventListener('click', stopJob);

  if (el.statusFilter) {
    el.statusFilter.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-status]');
      if (!button) return;
      statusFilter = button.dataset.status;
      [...el.statusFilter.querySelectorAll('button')].forEach((entry) => {
        entry.setAttribute(
          'aria-selected',
          entry === button ? 'true' : 'false'
        );
      });
      renderProposals();
    });
  }
  if (el.search) {
    el.search.addEventListener('input', () => {
      searchText = el.search.value || '';
      renderProposals();
    });
  }

  if (el.proposalsBody) {
    el.proposalsBody.addEventListener('change', (event) => {
      const target = event.target;
      const tagId = num(target.dataset ? target.dataset.tagId : 0);
      if (target.classList.contains('sim-pick')) {
        if (target.checked) selected.add(tagId);
        else selected.delete(tagId);
        updateApplyButtons();
        return;
      }
      if (target.classList.contains('sim-type')) {
        patchProposal(tagId, {
          typeName: target.value === '' ? null : target.value,
        });
        return;
      }
      if (target.classList.contains('sim-overwrite')) {
        patchProposal(tagId, { overwriteType: target.checked === true });
      }
    });

    el.proposalsBody.addEventListener('keydown', (event) => {
      const input = event.target.closest('.sim-topics__input');
      if (!input || event.key !== 'Enter') return;
      event.preventDefault();
      const tagId = num(input.dataset.tagId);
      const proposal = proposals.get(tagId);
      const name = String(input.value || '').trim();
      if (!proposal || name === '') return;
      const names = [...(proposal.topicNames || [])];
      if (!names.includes(name)) names.push(name);
      input.value = '';
      patchProposal(tagId, { topicNames: names });
    });

    el.proposalsBody.addEventListener('click', (event) => {
      const button = event.target.closest('.sim-topic-remove');
      if (!button) return;
      const tagId = num(button.dataset.tagId);
      const proposal = proposals.get(tagId);
      if (!proposal) return;
      const names = (proposal.topicNames || []).filter(
        (entry) => entry !== button.dataset.name
      );
      patchProposal(tagId, { topicNames: names });
    });
  }

  if (el.selectOpenBtn) {
    el.selectOpenBtn.addEventListener('click', () => {
      visibleProposals()
        .filter((proposal) => String(proposal.status || 'open') === 'open')
        .forEach((proposal) => selected.add(num(proposal.tagId)));
      renderProposals();
    });
  }
  if (el.clearSelectionBtn) {
    el.clearSelectionBtn.addEventListener('click', () => {
      selected.clear();
      renderProposals();
    });
  }
  if (el.skipBtn) el.skipBtn.addEventListener('click', skipSelected);
  if (el.applyBtn) el.applyBtn.addEventListener('click', applySelected);
}

async function init() {
  initVocabulary();
  initOrder();
  initProposals();
  setView('groups');
  await loadVocabulary();
  await loadDocumentTypes();
  await loadGroups();
  await loadProposals();
  await reattachJob();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
