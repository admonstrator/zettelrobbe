/**
 * Simplify tags: a compound tag becomes a document type and topic tags.
 *
 * "Stromrechnung" is not a concept, it is two: an invoice, about electricity.
 * Paperless-ngx has a field for the first and tags for the second, so this
 * page keeps a small target vocabulary of both, proposes for every tag what it
 * stands for, and applies what was chosen.
 *
 * The page has two modes (js/modules/review-mode.js). Simple is the default:
 * one button, the sheet before a run (js/modules/review-sheet.js), then the
 * result as five checklists with everything the model was sure of ticked,
 * and one button that applies the ticks. Advanced is the whole toolset: the
 * order as groups, the table of proposals with its per-row editing, and the
 * vocabulary. The run meter, the apply progress and the stack belong to both
 * modes and carry neither marker.
 *
 * A run costs tokens and writes nothing; an apply costs writes and asks no
 * model. Every write lands in the merge log on the Duplicates page, and that
 * log is where it is undone.
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
import {
  LANE_CHOICES,
  bindSheet,
  formatTokens,
  htmlSheet,
  roughTime,
  shares,
  updateSheet,
} from '/js/modules/review-sheet.js';
import { mountModeSwitch } from '/js/modules/review-mode.js';

/* --- interpolation helpers ------------------------------------------------ */

/** Anything that reaches an attribute or cell as a number, never as text. */
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** "1 tag" or "2 tags", without a parenthesised plural. */
function plural(count, one, many) {
  return num(count) === 1 ? one : many;
}

/* --- the page's vocabulary ------------------------------------------------ */

/** Where a proposal came from, as its badge and its chip say it. */
const SOURCE_LABELS = {
  rule: 'rule',
  model: 'model',
  user: 'edited',
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

/** Members a card renders before it offers the rest. */
const MEMBERS_PER_PAGE = 50;

/** The two job states that mean "still going". */
const JOB_LIVE_STATES = ['running', 'stopping'];

/** How often the page asks the job directly when the stream broke. */
const JOB_POLL_MS = 2000;

/** Proposals one apply call may name; the route refuses more. */
const MAX_APPLY_TAGS = 200;

/** Where an applied change is undone: the merge log on the Duplicates page. */
const UNDO_HREF = '/duplicates#dupLog';

/** What the empty vocabulary says instead of showing two empty lists. */
const VOCABULARY_EMPTY = 'No vocabulary';

/** What the empty table says. */
const PROPOSALS_EMPTY = 'No proposals';

/** What the groups say before any order has been proposed. */
const ORDER_EMPTY = 'No order proposed';

/** And what a filter that matches nothing says. */
const GROUPS_EMPTY = 'No groups match';

/** The notice over an unsaved model proposal. */
const PROPOSAL_NOTICE = 'Proposed by the model, not saved yet';

/** Its sibling for the types taken over from Paperless-ngx in one click. */
const ADOPT_NOTICE = 'Taken over from Paperless-ngx, not saved yet';

/** What the note says when the document types could not be read. */
const TYPES_UNREACHABLE = 'Paperless-ngx not reachable';

/** The badge a row of the picker wears when the vocabulary already has it. */
const IN_VOCABULARY_BADGE = { text: 'in vocabulary', tone: 'ok' };

/* --- the simple mode ------------------------------------------------------ */

/** The five checklists of a result, in the order they appear. */
const SECTION_KINDS = ['split', 'merge', 'delete', 'unsure', 'unchanged'];

/** What each checklist is called; the count follows after a middle dot. */
const SECTION_TITLES = {
  split: 'Split',
  merge: 'Merge',
  delete: 'Delete',
  unsure: 'Unsure',
  unchanged: 'Unchanged',
};

/** Rows a checklist shows before it offers the rest. */
const LIST_ROWS = 8;

/**
 * The spelling rule a rule merge names at the end of its reason, as the chip
 * on its row says it. The keys are services/entityNameMatcher.js's hard
 * reasons; a merge the model proposed carries its source instead.
 */
const MERGE_BASIS_LABELS = {
  'exact-normalized': 'same name',
  'umlaut-variant': 'umlaut',
  'legal-form': 'legal form',
  plural: 'plural',
  'token-order': 'word order',
};

/** The three lines the gate into advanced mode reads. */
const GATE_LINES = [
  { icon: 'i-tag', text: 'Vocabulary: document types and topics' },
  { icon: 'i-list', text: 'Every tag in a table, filters and search' },
  { icon: 'i-layers', text: 'Groups by type, topic and target' },
];

/** The cost line of a result the page did not see being produced. */
const COST_UNKNOWN = 'Cost not recorded';

/** Months the way the history line says them, whatever the locale. */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/* --- the sheet, the run and the apply ------------------------------------- */

/** Tags one request of the order job asks about. */
const ORDER_BATCH_SIZE = 50;

/** How much of the run's token budget has to be gone before it is named. */
const CEILING_SHOWN_ABOVE = 0.5;

/** The second lever: tags on fewer documents than this are left out. */
const MIN_DOCUMENTS_LEVER = 3;

/** The three statuses that mean a tag has been decided on. */
const DECIDED_STATUSES = ['accepted', 'skipped', 'applied'];

/** Where an estimate's numbers may say they come from. */
const ESTIMATE_BASES = ['run', 'model', 'guess'];

/** Where the sheet asks what a run will cost. */
const ESTIMATE_URL = '/api/simplify/order/estimate';

/** The fields that keep every key for themselves while they have focus. */
const EDITABLE_TAGS = ['input', 'select', 'textarea'];

/** How many tags an apply writes at once when the job does not say. */
const APPLY_LANES = 3;

/** Status changes sent at once before an apply; each is a local write. */
const PATCH_LANES = 6;

/** The order the apply job takes its tags in: merges, splits, deletions. */
const APPLY_ORDER = { merge: 0, split: 1, delete: 2 };

/* The guess of services/aiRunEstimate.js, kept here for the local estimate
   below. They are the same round numbers on purpose: a stub that invents its
   own arithmetic would read differently from the route. */
const GUESS_PROMPT_BASE = 900;
const GUESS_PROMPT_PER_ITEM = 18;
const GUESS_TOKENS_PER_ITEM = 26;
const GUESS_THINKING_PER_REQUEST = 1800;
const GUESS_TOKENS_PER_SECOND = 45;

/* --- state ---------------------------------------------------------------- */

const el = {
  page: document.getElementById('simPage'),
  topbarActions: document.getElementById('zrTopbarActions'),
  // Simple mode: the card before a run, the result after it.
  emptyCard: document.getElementById('simEmptyCard'),
  startBtn: document.getElementById('simStartBtn'),
  result: document.getElementById('simResult'),
  resultHeadline: document.getElementById('simResultHeadline'),
  resultCost: document.getElementById('simResultCost'),
  applyTickedBtn: document.getElementById('simApplyTickedBtn'),
  lists: document.getElementById('simLists'),
  historyLine: document.getElementById('simHistoryLine'),
  // Advanced mode: the order and its groups.
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
  groupsBlock: document.getElementById('simGroupsBlock'),
  groupFilters: document.getElementById('simGroupFilters'),
  groupKind: document.getElementById('simGroupKind'),
  groupStatus: document.getElementById('simGroupStatus'),
  groupSearch: document.getElementById('simGroupSearch'),
  groups: document.getElementById('simGroups'),
  applyAcceptedBtn: document.getElementById('simApplyAcceptedBtn'),
  // Both modes: the run meter, the apply progress and the stack.
  progress: document.getElementById('simProgress'),
  progressMessage: document.getElementById('simProgressMessage'),
  stopBtn: document.getElementById('simStopBtn'),
  runbar: document.getElementById('simRunbar'),
  runLedger: document.getElementById('simRunLedger'),
  runTokens: document.getElementById('simRunTokens'),
  runCeiling: document.getElementById('simRunCeiling'),
  reqLog: document.getElementById('simReqLog'),
  applyResult: document.getElementById('simApplyResult'),
  checklist: document.getElementById('simApplyChecklist'),
  stack: document.getElementById('simStack'),
  stackBar: document.getElementById('simStackBar'),
  stackCard: document.getElementById('simStackCard'),
  stackFoot: document.getElementById('simStackFoot'),
  // Advanced mode: the vocabulary.
  vocabularyBlock: document.getElementById('simVocabularyBlock'),
  reproposeBtn: document.getElementById('simReproposeBtn'),
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
  // Advanced mode: the table of proposals.
  proposals: document.getElementById('simProposals'),
  proposeSplitsBtn: document.getElementById('simProposeSplitsBtn'),
  proposeSplitsHint: document.getElementById('simProposeSplitsHint'),
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

/** The mode the page is in; the mode switch keeps it in step. */
let mode = 'simple';

/** The vocabulary the page is editing: names only, in the order given. */
const vocabulary = { types: [], topics: [] };

/** The rows behind it, kept for what only they know: who wrote an entry. */
let vocabularyRows = [];

/** The document types Paperless-ngx has, as the route last answered them. */
let documentTypes = [];

/** True once a fetch of them failed: no offer, and the note says so. */
let typesUnreachable = false;

/**
 * The tag names of the archive, lower case to { name, documentCount }. Read
 * once, the first time a topic is typed, and kept for the page's life: the
 * hint is an extra, not a reason to fetch a thousand names on load.
 */
let tagIndex = null;
let tagIndexPromise = null;

/** Every proposal the last load brought, by tag id. */
const proposals = new Map();

/** Tag ids ticked in the table for its apply bar. */
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

/** True while the panel shows the step before an apply job exists. */
let preparing = false;

/** What the last model-backed run cost, for the cost line of the result. */
let lastRunCost = null;

/**
 * The ticks of the simple mode that differ from what a row starts as. A row
 * starts ticked when the model was sure of it or it is accepted already; a
 * tick stays local until the apply button is pressed.
 */
const tickOverrides = new Map();

/** The checklists read in full rather than capped, and the unchanged list. */
const listsFull = new Set();
let unchangedShown = false;

/** The stack: the tag ids it still has to ask about, and where it is. */
let stackQueue = [];
let stackAt = 0;
let stackDecided = 0;
let stackUndo = null;

/** The levers of the sheet; they survive the dialog they were set in. */
const runLevers = {
  skipDecided: false,
  minDocuments: 1,
  lanes: 3,
  keepVocabulary: false,
};

/** The apply checklist: one row per accepted tag, and when the last ended. */
let checklistRows = [];
let checklistAt = 0;

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
      `Server answered ${response.status} without a body`
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

/** An alert with a title, and a line under it only when there is one. */
function htmlAlert(tone, title, body) {
  const text = String(body == null ? '' : body);
  const htmlBody = text === '' ? '' : `<p class="zr-sm">${esc(text)}</p>`;
  return `<div class="zr-alert zr-alert--${esc(tone)}"><div class="zr-alert__body"><div class="zr-alert__title">${esc(title)}</div>${htmlBody}</div></div>`;
}

function htmlEmptyRow(columns, text) {
  return `<tr><td colspan="${num(columns)}" class="zr-empty">${esc(text)}</td></tr>`;
}

/** One symbol out of the app's icon set; there is no icon font. */
function htmlIconMarkup(name, extra) {
  const htmlExtra =
    typeof extra === 'string' && extra !== '' ? ` ${esc(extra)}` : '';
  return `<svg class="zr-icon zr-icon--sm${htmlExtra}" aria-hidden="true"><use href="/icons.svg#${esc(name)}"/></svg>`;
}

/** "3,410": a count of documents the eye can take in at a glance. */
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
    return `<span class="sim-vocab__empty">${esc('None yet')}</span>`;
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

/** What a vocabulary proposal does to the lists: the saved entries first. */
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
  return `<div class="zr-alert__body"><p class="zr-sm">${esc(`${total} ${kinds} in Paperless-ngx`)}</p></div><button class="zr-btn" id="simAdoptTypesBtn" type="button">${esc(`Take over ${total}`)}</button>`;
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
 * being edited rather than from `inVocabulary` of the last fetch: a name
 * added a second ago must already wear it.
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
    el.vocabularyNotice.innerHTML = htmlAlert('info', ADOPT_NOTICE, '');
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
 * @param {string} typed the name as entered
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
    return esc(
      `Existing tag · ${count} ${plural(count, 'document', 'documents')}`
    );
  }
  const htmlUse = `<button type="button" class="zr-btn sim-hint__use" data-name="${esc(existing)}" data-typed="${esc(name)}">${esc(`Use ${existing}`)}</button>`;
  return `${esc(`Existing tag: ${existing}`)}${htmlUse}`;
}

/**
 * Replaces the typed spelling with the existing one, keeping its position and
 * never leaving the same name twice. Pure on purpose.
 *
 * @param {string[]} list the topics as they stand
 * @param {string} typed what was entered
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

/** Shows what the tag list says about a topic that was just typed. */
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
 * What the saved vocabulary decides about the order: the block is open while
 * there is nothing in it, "Keep vocabulary" is only offered once something is
 * saved and comes up on when any of it was written by hand, and the button
 * that proposes again waits for a vocabulary to propose against.
 */
function renderVocabularyState(fresh) {
  if (el.vocabularyBlock) el.vocabularyBlock.open = !vocabularySaved;
  if (el.reproposeBtn) {
    el.reproposeBtn.classList.toggle('hidden', !vocabularySaved);
  }
  if (el.keepVocabularyWrap) {
    // Without the model there is no button the switch belongs to: the order
    // then only runs from the vocabulary block, against the saved names.
    el.keepVocabularyWrap.classList.toggle(
      'hidden',
      !vocabularySaved || el.orderBtn === null
    );
  }
  // Only on a load or a save: a switch set by hand stays as it was set.
  if (fresh === true) {
    runLevers.keepVocabulary = vocabularyRows.some(
      (row) => String(row.source || '') === 'user'
    );
    if (el.keepVocabulary) {
      el.keepVocabulary.checked = runLevers.keepVocabulary;
    }
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
        'Vocabulary not loaded',
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
    toast('Vocabulary saved', { tone: 'ok' });
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
    ? `<input type="checkbox" class="zr-check sim-pick" data-tag-id="${num(proposal.tagId)}" aria-label="Pick ${esc(proposal.tagName)}">`
    : '<span class="zr-faint">·</span>';
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
    ? `<a class="zr-link zr-sm" href="${esc(UNDO_HREF)}">${esc('Undo')}</a>`
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
        <td data-label="Pick" class="sim-proposals__pickcol">${htmlPick}</td>
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
    : htmlEmptyRow(9, proposals.size === 0 ? PROPOSALS_EMPTY : 'No match');
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
  el.proposalsBody.innerHTML = htmlEmptyRow(9, 'Loading');
  try {
    const payload = await requestJson('/api/simplify/proposals');
    proposals.clear();
    (payload.data || []).forEach((proposal) => {
      proposals.set(num(proposal.tagId), proposal);
    });
    [...selected].forEach((id) => {
      if (!proposals.has(id)) selected.delete(id);
    });
    [...tickOverrides.keys()].forEach((id) => {
      if (!proposals.has(id)) tickOverrides.delete(id);
    });
    if (el.proposalsAlert) el.proposalsAlert.innerHTML = '';
    renderProposals();
    renderSimple();
    renderStack();
    updateApplyAcceptedButton();
  } catch (error) {
    el.proposalsBody.innerHTML = htmlEmptyRow(9, error.message);
  }
}

/** One PATCH, and everything that shows the proposal redrawn from the answer. */
async function patchProposal(tagId, patch) {
  try {
    const payload = await sendJson(
      'PATCH',
      `/api/simplify/proposals/${encodeURIComponent(String(tagId))}`,
      patch
    );
    if (payload.data) proposals.set(num(payload.data.tagId), payload.data);
    renderProposals();
    renderSimple();
    renderStack();
    updateApplyAcceptedButton();
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
    el.proposeSplitsHint.textContent = ready ? '' : 'No vocabulary saved';
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
  if (kind === 'keep') return 'Unchanged';
  return name;
}

/** The same group as the title of the dialog that applies it. */
function groupConfirmName(group) {
  const kind = String((group && group.kind) || '');
  const name = String(group && group.name == null ? '' : group.name);
  if (kind === 'merge') return `merge into ${name}`;
  if (kind === 'delete') return 'the deletions';
  if (kind === 'keep') return 'the unchanged tags';
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
      : `<button type="button" class="zr-btn zr-btn--ghost zr-btn--icon sim-member-remove" data-tag-id="${num(member.tagId)}" title="Take out of the group" aria-label="Take ${esc(name)} out of the group">${htmlIconMarkup('i-x')}</button>`;
  const htmlSkip =
    status === 'applied'
      ? ''
      : `<button type="button" class="zr-btn zr-btn--ghost zr-sm sim-member-skip" data-tag-id="${num(member.tagId)}" data-status="${esc(status)}">${esc(status === 'skipped' ? 'Reopen' : 'Skip')}</button>`;
  return `<tr class="sim-member" data-tag-id="${num(member.tagId)}">
        <td data-label="Tag" class="zr-truncate" title="${esc(name)}">${esc(name)}</td>
        <td data-label="Documents" class="zr-mono">${esc(grouped(documents))}</td>
        <td data-label="Outcome"><span class="sim-member__outcome">${esc(memberOutcome(member))}</span></td>
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
      : `<div class="sim-group__morewrap"><button type="button" class="zr-btn zr-btn--ghost sim-group__more">${esc(`${rest} more`)}</button></div>`;
  // A keep group decides nothing and applies nothing: its tags are the ones
  // the order leaves alone.
  const htmlAccept =
    kind === 'keep'
      ? ''
      : `<button type="button" class="zr-btn zr-btn--primary sim-group-accept"${htmlDecideDisabled}>${esc('Accept')}</button>`;
  const htmlApply =
    kind === 'keep'
      ? ''
      : `<button type="button" class="zr-btn sim-group-apply"${htmlApplyDisabled}>${esc(`Apply ${accepted}`)}</button>`;
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
              <th>Outcome</th>
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
      ? `${groups.length} ${plural(groups.length, 'group', 'groups')} · ${grouped(totals.tags)} ${plural(totals.tags, 'tag', 'tags')}`
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

/** The proposals a button that applies everything accepted would write. */
function acceptedProposals() {
  return [...proposals.values()].filter(
    (proposal) => String(proposal.status || 'open') === 'accepted'
  );
}

/**
 * "Apply 12 accepted · 45 writes". Pure on purpose: the numbers are
 * planWrites() over what is accepted, and a tag that stays writes nothing.
 *
 * @param {object} totals planWrites()
 * @returns {string}
 */
function applyAcceptedLabel(totals) {
  const tags = num(totals && totals.tags);
  const writes = num(totals && totals.writes);
  return `Apply ${grouped(tags)} accepted · ${grouped(writes)} ${plural(writes, 'write', 'writes')}`;
}

function updateApplyAcceptedButton() {
  if (!el.applyAcceptedBtn) return;
  const totals = planWrites(acceptedProposals());
  el.applyAcceptedBtn.textContent = applyAcceptedLabel(totals);
  el.applyAcceptedBtn.disabled =
    totals.tags === 0 || jobId !== null || applying;
}

/** What the view segment decides: the groups, or the table. */
function renderViewState() {
  const table = view === 'table';
  if (el.groupFilters) {
    // Three filters over nothing are noise; they come back with the groups.
    el.groupFilters.classList.toggle('hidden', groups.length === 0);
  }
  if (el.groupsBlock) el.groupsBlock.classList.toggle('hidden', table);
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
    // A decision patches every member's proposal; the table, the simple
    // lists and the apply button read the proposals, so they are read again.
    await loadProposals();
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
  if (action === 'keep') return `${name} stays as it is`;
  if (kind === 'type') return `${name} keeps its topics, loses the type`;
  if (kind === 'topic') {
    return `${name} loses the topic ${String(group.name == null ? '' : group.name)}`;
  }
  return `${name} stays as it is`;
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
    await loadProposals();
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
    await loadProposals();
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  }
}

/* --- the two jobs of the order -------------------------------------------- */

/** True when this build offers the model: the view only draws its button then. */
function modelReady() {
  return el.orderBtn !== null;
}

/** Everything that starts a job is dead while one runs. */
function setOrderBusy(busy) {
  if (el.orderBtn) el.orderBtn.disabled = busy;
  if (el.startBtn) el.startBtn.disabled = busy || !modelReady();
  if (el.reproposeBtn) el.reproposeBtn.disabled = busy;
  updateApplyAcceptedButton();
  updateProposeSplitsButton();
  renderSimple();
}

/**
 * The one job that proposes the order: the vocabulary, then an action for
 * every tag. 'keep' runs it against the saved vocabulary instead.
 */
async function runOrderJob(vocabularyMode) {
  if (jobId) return;
  setOrderBusy(true);
  if (el.applyResult) el.applyResult.innerHTML = '';
  if (el.checklist) el.checklist.innerHTML = '';
  checklistRows = [];
  try {
    const job = await startJob('/api/simplify/order/propose', {
      vocabulary: vocabularyMode === 'keep' ? 'keep' : 'propose',
      skipDecided: runLevers.skipDecided,
      minDocuments: runLevers.minDocuments,
      concurrency: runLevers.lanes,
    });
    const { result, stopped } = await followJob(job);
    orderResult = result || {};
    orderStopped = stopped === true;
    // A new order is a new list: every tick starts over from what the model
    // was sure of, and every checklist from its first rows.
    tickOverrides.clear();
    listsFull.clear();
    unchangedShown = false;
    await loadVocabulary();
    await loadGroups();
    await loadProposals();
    renderOrderSummary();
    toast(stopped ? 'Stopped' : 'Order ready', {
      tone: stopped ? 'warn' : 'ok',
    });
  } catch (error) {
    if (el.applyResult) {
      el.applyResult.innerHTML = htmlAlert(
        'danger',
        'Order not proposed',
        error.message
      );
    }
    toast(error.message, { tone: 'danger' });
  } finally {
    setOrderBusy(false);
  }
}

/** The run of both modes: the sheet first, then the job with its levers. */
async function proposeOrder() {
  const go = await askPreflight(false);
  if (!go) return;
  const keep = vocabularySaved && runLevers.keepVocabulary === true;
  await runOrderJob(keep ? 'keep' : 'propose');
}

/** The same job from the vocabulary block: these names, no new ones. */
async function repropose() {
  const go = await askPreflight(true);
  if (!go) return;
  await runOrderJob('keep');
}

/**
 * How many of a list of proposals each action takes. Pure on purpose.
 *
 * @param {object[]} list proposals
 * @returns {{split: number, merge: number, delete: number, keep: number}}
 */
function actionCounts(list) {
  const counts = { split: 0, merge: 0, delete: 0, keep: 0 };
  (Array.isArray(list) ? list : []).forEach((proposal) => {
    const action = String((proposal && proposal.action) || 'split');
    if (counts[action] !== undefined) counts[action] += 1;
  });
  return counts;
}

/**
 * What applying a list writes, in one line of numbers: "812 split · 96
 * merged · 37 deleted · 2,340 writes". An action nothing is picked for is
 * left out. Pure on purpose.
 *
 * @param {object[]} list proposals
 * @returns {string}
 */
function applySummaryText(list) {
  const counts = actionCounts(list);
  const writes = planWrites(list).writes;
  const parts = [];
  if (counts.split > 0) parts.push(`${grouped(counts.split)} split`);
  if (counts.merge > 0) parts.push(`${grouped(counts.merge)} merged`);
  if (counts.delete > 0) parts.push(`${grouped(counts.delete)} deleted`);
  parts.push(`${grouped(writes)} ${plural(writes, 'write', 'writes')}`);
  return parts.join(' · ');
}

/**
 * The line the dialog of "Apply" on a group card reads. Pure on purpose.
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
    what = `documents move to ${name}`;
  } else if (kind === 'delete') {
    what = 'taken off their documents';
  } else if (kind === 'topic') {
    what = 'documents get their type and topics';
  } else {
    what = `documents get the type ${name} and their topics`;
  }
  const tags = `${accepted} ${plural(accepted, 'tag', 'tags')}`;
  return `${accepted} accepted ${plural(accepted, 'tag', 'tags')} · ${what} · ${tags} deleted`;
}

/**
 * The line an apply leaves behind: "12 split · 3 merged · 1 deleted · 2 failed".
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
  return parts.join(' · ');
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
      ? `<p class="zr-sm">${esc('Stopped · the rest stays accepted')}</p>`
      : '';
  const tone = failed.length > 0 ? 'warn' : 'ok';
  return `<div class="zr-alert zr-alert--${esc(tone)}"><div class="zr-alert__body"><div class="zr-alert__title">${esc(applyResultText(result))}</div>${htmlNote}${htmlFailures}</div></div>`;
}

/** Starts the apply job, for one group or for everything accepted. */
async function applyOrder(groupKey) {
  if (jobId) return;
  applying = true;
  setOrderBusy(true);
  if (el.applyResult) el.applyResult.innerHTML = '';
  // The checklist is what this apply will write: every accepted proposal, or
  // the accepted members of the one group.
  const group = groupKey ? groupByKey(groupKey) : null;
  const members = group
    ? new Set(
        (Array.isArray(group.members) ? group.members : []).map((member) =>
          num(member.tagId)
        )
      )
    : null;
  checklistRows = checklistFrom(
    acceptedProposals().filter(
      (proposal) => members === null || members.has(num(proposal.tagId))
    )
  );
  checklistAt = Date.now();
  renderChecklist();
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
    finishChecklist(data);
    const failures = Array.isArray(data.failed) ? data.failed.length : 0;
    // In simple mode a clean apply is said by the line above in one go; the
    // rows stay only while one of them failed and can be tried again.
    if (mode === 'simple' && failures === 0) {
      checklistRows = [];
      renderChecklist();
    }
    await loadGroups();
    await loadProposals();
    // An apply creates the document types it needs, so the picker's choices
    // are one behind. The service drops the cache on that write; this reads it.
    await loadDocumentTypes();
    toast(applyResultText(data), { tone: failures > 0 ? 'warn' : 'ok' });
  } catch (error) {
    hidePreparing();
    if (el.applyResult) {
      el.applyResult.innerHTML = htmlAlert(
        'danger',
        'Not applied',
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
    title: `Apply ${groupConfirmName(group)}`,
    body: groupApplyConfirmText(group),
    confirmLabel: 'Apply',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;
  await applyOrder(group.key);
}

async function applyAllAccepted() {
  const list = acceptedProposals().filter(
    (proposal) => String(proposal.action || 'split') !== 'keep'
  );
  if (list.length === 0) return;
  const confirmed = await confirmDialog({
    title: `Apply ${grouped(list.length)} accepted`,
    body: applySummaryText(list),
    confirmLabel: 'Apply',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;
  await applyOrder(null);
}

/* --- the job panel -------------------------------------------------------- */

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
  if (left < 60000) return `~${Math.round(left / 1000)} s left`;
  return `~${Math.max(1, Math.round(left / 60000))} min left`;
}

/** How far the job is, 0 to 100, or null while the plan is unknown. */
function progressPercent(progress) {
  const state = progress || {};
  const planned = Number(state.requestsPlanned);
  if (!Number.isFinite(planned) || planned <= 0) return null;
  const done = Number(state.requestsDone) || 0;
  return Math.max(0, Math.min(100, Math.round((done / planned) * 100)));
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
  preparing = false;
  el.progress.classList.remove('hidden');
  if (el.stopBtn) {
    el.stopBtn.classList.remove('hidden');
    el.stopBtn.disabled = false;
    setStopLabel('Stop');
  }
}

/**
 * The panel before a job exists: the ticks of an apply are written as
 * statuses first, and that step has a line of its own and nothing to stop.
 */
function showPreparing(text) {
  if (!el.progress) return;
  preparing = true;
  el.progress.classList.remove('hidden');
  if (el.stopBtn) el.stopBtn.classList.add('hidden');
  if (el.progressMessage) el.progressMessage.textContent = text;
  [el.runbar, el.runLedger, el.runTokens, el.reqLog].forEach((node) => {
    if (node) node.innerHTML = '';
  });
  if (el.runCeiling) el.runCeiling.classList.add('hidden');
}

/** Takes that line away again when no job followed it. */
function hidePreparing() {
  if (!preparing) return;
  preparing = false;
  if (el.progress) el.progress.classList.add('hidden');
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
  if (!el.runLedger || !progressJob) return;
  const state = progressJob.progress || {};
  const base = num(state.elapsedMs);
  const live = progressJob.finishedAt ? base : base + (Date.now() - progressAt);
  el.runLedger.innerHTML = htmlRunLedger(
    Object.assign({}, state, { elapsedMs: live })
  );
}

/** One `progress` event on the panel. */
function renderProgress(job) {
  if (!el.progress || !job) return;
  progressJob = job;
  progressAt = Date.now();
  const state = job.progress || {};
  if (el.progressMessage) {
    el.progressMessage.textContent = phaseHeadline(state);
  }
  renderRunMeter(state);
  startProgressTicker();
}

/**
 * What the run is doing, in two or three words and without a subject, for the
 * one line at the top of the panel. The job's own message is longer and
 * changes inside a phase; that detail belongs to the request it describes, on
 * its row in the log.
 *
 * @param {object} progress
 * @returns {string}
 */
function phaseHeadline(progress) {
  const state = progress || {};
  // Every phase the shared job service knows, because the order borrows the
  // judge's warm up and would otherwise fall back to a sentence that changes
  // with every token.
  const labels = {
    starting: 'Getting ready',
    'warming-up': 'Measuring the model',
    vocabulary: 'Proposing a vocabulary',
    ordering: 'Asking the model',
    splitting: 'Asking the model',
    judging: 'Asking the model',
    escalating: 'Asking again',
    applying: 'Writing to Paperless-ngx',
    finishing: 'Finishing',
  };
  const label = labels[String(state.phase || '')];
  if (label) return label;
  return String(state.message || 'Working');
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
  if (el.progressMessage) {
    el.progressMessage.textContent = progressOutcomeText(event);
  }
  // The meter keeps what the run cost; the cost line of the result reads it.
  const finished = progressJob ? progressJob.progress : null;
  renderRunMeter(finished);
  if (String(progressJob && progressJob.task) !== JOB_TASKS.APPLY) {
    keepRunCost(finished);
  }
  // In simple mode the result takes over from here: its head carries what the
  // run cost, and the line under the apply says what the apply did.
  if (mode === 'simple') el.progress.classList.add('hidden');
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
    // A job the page attached to on load has to take the card off the page.
    renderSimple();

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
        if (applying) advanceChecklist(event.job.progress);
        return;
      }
      renderProgressOutcome(event);
      if (event.type === 'failed') {
        settle(reject, new Error(event.error || 'Job failed'));
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
        if (!current) throw new Error('Job gone');
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

/** Starts one of the jobs and hands back the job the server named. */
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
        `Server answered ${response.status} without a body`
    );
  }
  if (!job) throw new Error('Server started a job without an id');
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
        ''
      );
    }
    toast('Vocabulary proposed', { tone: 'ok' });
  } catch (error) {
    if (el.vocabularyNotice) {
      el.vocabularyNotice.innerHTML = htmlAlert(
        'danger',
        'Vocabulary not proposed',
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
    toast('Proposals ready', { tone: 'ok' });
  } catch (error) {
    if (el.proposalsAlert) {
      el.proposalsAlert.innerHTML = htmlAlert(
        'danger',
        'Splits not proposed',
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
 * review of the Duplicates page is left alone; it belongs there.
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
      tickOverrides.clear();
      listsFull.clear();
      unchangedShown = false;
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
      el.vocabularyNotice.innerHTML = htmlAlert('info', PROPOSAL_NOTICE, '');
    }
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  }
}

/* --- applying from the table ---------------------------------------------- */

/**
 * The line the dialog of the table's apply reads. Pure on purpose:
 * tests/test-simplify-ui.js checks the numbers it produces.
 *
 * @param {Array<{documents: number, typeSet: number, typeKept: number}>} entries
 * @returns {string}
 */
function applyConfirmText(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const tags = list.length;
  const total = (key) =>
    Math.round(list.reduce((sum, entry) => sum + num(entry[key]), 0));
  const documents = total('documents');
  const typeSet = total('typeSet');
  const typeKept = total('typeKept');
  const parts = [
    `${documents} ${plural(documents, 'document gets', 'documents get')} topics`,
  ];
  if (typeSet > 0 || typeKept > 0) {
    parts.push(`${typeSet} ${plural(typeSet, 'gets', 'get')} a type`);
    if (typeKept > 0) {
      parts.push(`${typeKept} ${plural(typeKept, 'keeps its', 'keep theirs')}`);
    }
  }
  parts.push(`${tags} ${plural(tags, 'tag', 'tags')} deleted`);
  return parts.join(' · ');
}

/** The one route that applies a list of splits; every caller goes through it. */
function applyTags(tagIds) {
  return sendJson('POST', '/api/simplify/apply', { tagIds });
}

function setApplyStatus(text) {
  if (!el.applyStatus) return;
  el.applyStatus.textContent = text || '';
  el.applyStatus.classList.toggle('hidden', !text);
}

/**
 * What one split would touch. The route asks Paperless-ngx; a build whose
 * service cannot answer yet (501) falls back to what the proposal itself
 * recorded, so the dialog still names honest numbers.
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
    toast(`At most ${MAX_APPLY_TAGS} tags at once`, { tone: 'danger' });
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
    title: `Split ${picks.length} ${plural(picks.length, 'tag', 'tags')}`,
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
    const payload = await applyTags(
      picks.map((proposal) => num(proposal.tagId))
    );
    const data = payload.data || {};
    selected.clear();
    toast(payload.success ? 'Splits applied' : 'Some splits failed', {
      tone: payload.success ? 'ok' : 'danger',
    });
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
        'Splits not applied',
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

/* --- the cost layer: numbers that are never bare -------------------------- */

/**
 * What a provider reports, read as question, answer and the model thinking to
 * itself. `completion` carries the reasoning where the provider counts it
 * there, so the answer is what is left of it. Pure on purpose.
 *
 * @param {object} tokens { prompt, completion, thinking }
 * @returns {{prompt: number, answer: number, thinking: number}}
 */
function tokenSplit(tokens) {
  const source = tokens || {};
  const prompt = Math.max(0, num(source.prompt));
  const thinking = Math.max(0, num(source.thinking));
  const completion = Math.max(0, num(source.completion));
  return {
    prompt,
    answer: Math.max(0, completion - thinking),
    thinking,
  };
}

/** The row of numbers. `items` is `[{ value, unit, quiet }]`. */
function htmlLedger(items) {
  const htmlItems = (Array.isArray(items) ? items : [])
    .map((item) => {
      const htmlQuiet = item.quiet === true ? ' zr-ledger__value--quiet' : '';
      const unit = String(item.unit == null ? '' : item.unit);
      const htmlUnit = unit === '' ? '' : ` ${esc(unit)}`;
      return `<span class="zr-ledger__item"><span class="zr-ledger__value${htmlQuiet}">${esc(item.value)}</span>${htmlUnit}</span>`;
    })
    .join('');
  return `<div class="zr-ledger">${htmlItems}</div>`;
}

/** The three widths of a split as shares of its own total. */
function splitShares(split) {
  return shares(
    {
      prompt: split && split.prompt,
      completion: split && split.answer,
      thinking: split && split.thinking,
    },
    0
  );
}

/** The same count as one bar of three segments, or '' when there is none. */
function htmlTokenbar(split) {
  const part = splitShares(split);
  if (part.total <= 0) return '';
  // A part that cost nothing is left out of the legend: "0 answer" next to a
  // bar with no green in it is a reading exercise, not information.
  const htmlKeys = [
    { part: 'prompt', value: split.prompt, word: 'question' },
    { part: 'answer', value: split.answer, word: 'answer' },
    { part: 'thinking', value: split.thinking, word: 'thinking' },
  ]
    .filter((key) => num(key.value) > 0)
    .map(
      (key) =>
        `<span class="zr-tokenbar__key"><span class="zr-tokenbar__dot zr-tokenbar__dot--${esc(key.part)}"></span>${esc(`${formatTokens(key.value)} ${key.word}`)}</span>`
    )
    .join('');
  return `<div class="zr-tokenbar"><div class="zr-tokenbar__track"><span class="zr-tokenbar__seg zr-tokenbar__seg--prompt" style="width: ${num(part.prompt)}%"></span><span class="zr-tokenbar__seg zr-tokenbar__seg--answer" style="width: ${num(part.answer)}%"></span><span class="zr-tokenbar__seg zr-tokenbar__seg--thinking" style="width: ${num(part.thinking)}%"></span></div><div class="zr-tokenbar__legend">${htmlKeys}</div></div>`;
}

/** The line above a button that says what pressing it writes. */
function htmlConsequence(text, free) {
  const htmlTone = free === true ? ' zr-consequence--free' : '';
  const htmlIcon = htmlIconMarkup(free === true ? 'i-check' : 'i-info');
  return `<p class="zr-consequence${htmlTone}">${htmlIcon}<span>${esc(text)}</span></p>`;
}

/* --- what an apply writes ------------------------------------------------- */

/**
 * What applying a set of proposals writes to Paperless-ngx. A document is one
 * write per thing that changes on it, the tag that goes away is one more, and
 * a tag that stays costs nothing at all. Pure on purpose: every number this
 * page promises about an apply comes from here.
 *
 * @param {object[]} list proposals
 * @returns {{tags: number, documents: number, typeSets: number,
 *   topicSets: number, deletions: number, writes: number}}
 */
function planWrites(list) {
  const totals = {
    tags: 0,
    documents: 0,
    typeSets: 0,
    topicSets: 0,
    deletions: 0,
    writes: 0,
  };
  (Array.isArray(list) ? list : []).forEach((proposal) => {
    const action = String((proposal && proposal.action) || 'split');
    if (action === 'keep') return;
    const documents = num(proposal.documentCount);
    totals.tags += 1;
    totals.documents += documents;
    totals.deletions += 1;
    if (action === 'merge' || action === 'delete') {
      totals.writes += documents + 1;
      return;
    }
    const keeps =
      proposal.overwriteType === true ? 0 : num(proposal.documentsWithType);
    const typeName = proposal.typeName == null ? '' : String(proposal.typeName);
    const topics = Array.isArray(proposal.topicNames)
      ? proposal.topicNames
      : [];
    const typeSets = typeName === '' ? 0 : Math.max(0, documents - keeps);
    const topicSets = topics.length > 0 ? documents : 0;
    totals.typeSets += typeSets;
    totals.topicSets += topicSets;
    totals.writes += typeSets + topicSets + 1;
  });
  return totals;
}

/** "9 documents", "1 document": the unit most of these lines need. */
function documentsText(count) {
  return `${grouped(count)} ${plural(count, 'document', 'documents')}`;
}

/**
 * What one proposal writes, as the line above the stack's buttons: numbers
 * first, then what they are. Pure on purpose.
 *
 * @param {object} proposal a TagSplitProposal
 * @returns {string}
 */
function consequenceText(proposal) {
  const totals = planWrites([proposal]);
  const action = String((proposal && proposal.action) || 'split');
  const documents = num(proposal && proposal.documentCount);
  const writes = `${totals.writes} ${plural(totals.writes, 'write', 'writes')}`;
  if (action === 'keep') return '0 writes';
  if (action === 'delete') {
    return `${writes} · off ${documentsText(documents)} · tag deleted`;
  }
  if (action === 'merge') {
    const target = String(
      proposal.mergeInto == null ? 'the other tag' : proposal.mergeInto
    );
    return `${writes} · ${documentsText(documents)} to ${target} · tag deleted`;
  }
  const parts = [writes];
  if (totals.typeSets > 0) {
    parts.push(`type on ${documentsText(totals.typeSets)}`);
  }
  if (totals.topicSets > 0) {
    parts.push(`topics on ${documentsText(totals.topicSets)}`);
  }
  parts.push('tag deleted');
  return parts.join(' · ');
}

/* --- the simple mode: five checklists and one button ---------------------- */

/**
 * The checklist a proposal belongs in, or null when it has been applied and
 * is history. What stays as it is goes to Unchanged, whoever proposed it;
 * what the rule or the model was not sure of goes to Unsure, whatever it
 * does; the rest goes by its action. A split with nothing left to split into
 * stays as it is. Pure on purpose.
 *
 * @param {object} proposal a TagSplitProposal
 * @returns {?string} one of SECTION_KINDS
 */
function sectionOf(proposal) {
  const status = String((proposal && proposal.status) || 'open');
  if (status === 'applied') return null;
  const action = String(proposal.action || 'split');
  const typeName = proposal.typeName == null ? '' : String(proposal.typeName);
  const topics = Array.isArray(proposal.topicNames) ? proposal.topicNames : [];
  if (action === 'keep') return 'unchanged';
  if (action === 'split' && typeName === '' && topics.length === 0) {
    return 'unchanged';
  }
  if (String(proposal.confidence || '') === 'low') return 'unsure';
  if (action === 'merge' || action === 'delete') return action;
  return 'split';
}

/**
 * Every proposal in its checklist, the ones on the most documents first.
 * Pure on purpose.
 *
 * @param {object[]} list proposals
 * @returns {{split: object[], merge: object[], delete: object[],
 *   unsure: object[], unchanged: object[]}}
 */
function simpleSections(list) {
  const sections = {
    split: [],
    merge: [],
    delete: [],
    unsure: [],
    unchanged: [],
  };
  (Array.isArray(list) ? list : []).forEach((proposal) => {
    const kind = sectionOf(proposal);
    if (kind) sections[kind].push(proposal);
  });
  const order = (a, b) =>
    num(b.documentCount) - num(a.documentCount) ||
    String(a.tagName || '').localeCompare(String(b.tagName || ''), 'en', {
      sensitivity: 'base',
    });
  SECTION_KINDS.forEach((kind) => sections[kind].sort(order));
  return sections;
}

/**
 * Whether a row starts ticked: accepted already, or open and in a checklist
 * the model was sure of. Unsure and skipped rows start empty. Pure on purpose.
 *
 * @param {object} proposal
 * @returns {boolean}
 */
function defaultTick(proposal) {
  const status = String((proposal && proposal.status) || 'open');
  if (status === 'accepted') return true;
  if (status !== 'open') return false;
  const kind = sectionOf(proposal);
  return kind === 'split' || kind === 'merge' || kind === 'delete';
}

/**
 * Whether a row is ticked now: the tick it was given, or the one it starts
 * with. A row of Unchanged has no box. Pure on purpose.
 *
 * @param {object} proposal
 * @param {Map<number, boolean>} overrides
 * @returns {boolean}
 */
function isTicked(proposal, overrides) {
  if (sectionOf(proposal) === 'unchanged') return false;
  const id = num(proposal && proposal.tagId);
  if (overrides && overrides.has(id)) return overrides.get(id) === true;
  return defaultTick(proposal);
}

/**
 * The proposals the apply button would write, in checklist order. Pure on
 * purpose.
 *
 * @param {object} sections simpleSections()
 * @param {Map<number, boolean>} overrides
 * @returns {object[]}
 */
function tickedProposals(sections, overrides) {
  return ['split', 'merge', 'delete', 'unsure'].reduce(
    (list, kind) =>
      list.concat(
        (sections[kind] || []).filter((proposal) =>
          isTicked(proposal, overrides)
        )
      ),
    []
  );
}

/**
 * "1,187 tags · 945 changes proposed". Every tag of the result counts, and a
 * change is what the model was sure of; a tick moves neither. Pure on purpose.
 *
 * @param {object} sections simpleSections()
 * @returns {string}
 */
function resultHeadline(sections) {
  const count = (kind) => (sections[kind] || []).length;
  const tags = SECTION_KINDS.reduce((sum, kind) => sum + count(kind), 0);
  const changes = count('split') + count('merge') + count('delete');
  return `${grouped(tags)} ${plural(tags, 'tag', 'tags')} · ${grouped(changes)} ${plural(changes, 'change', 'changes')} proposed`;
}

/**
 * "Apply 945 · 2,340 writes": what the ticks add up to. Pure on purpose.
 *
 * @param {object[]} ticked tickedProposals()
 * @returns {string}
 */
function applyTickedLabel(ticked) {
  const totals = planWrites(ticked);
  return `Apply ${grouped(totals.tags)} · ${grouped(totals.writes)} ${plural(totals.writes, 'write', 'writes')}`;
}

/**
 * The chip of a merge: the spelling rule a rule merge names at the end of its
 * reason, or who proposed it. Pure on purpose.
 *
 * @param {object} proposal
 * @returns {string}
 */
function mergeBasis(proposal) {
  const source = String((proposal && proposal.source) || 'rule');
  if (source !== 'rule') return SOURCE_LABELS[source] || source;
  const match = /\(([a-z-]+)\)\s*$/.exec(
    String(proposal.reason == null ? '' : proposal.reason)
  );
  if (!match) return SOURCE_LABELS.rule;
  return MERGE_BASIS_LABELS[match[1]] || match[1];
}

/**
 * What a row says a tag becomes, with the target in bold: "Stromrechnung →
 * Rechnung + Strom", "rechnungen → Rechnung", or the name alone for a tag
 * that goes away. Pure on purpose.
 *
 * @param {object} proposal
 * @returns {string} markup
 */
function htmlRowWhat(proposal) {
  const name = String(proposal.tagName == null ? '' : proposal.tagName);
  const action = String(proposal.action || 'split');
  if (action === 'delete' || action === 'keep') return esc(name);
  if (action === 'merge') {
    const target = String(proposal.mergeInto == null ? '' : proposal.mergeInto);
    return `${esc(`${name} → `)}<span class="zr-checklist__name">${esc(target)}</span>`;
  }
  const typeName = proposal.typeName == null ? '' : String(proposal.typeName);
  const topics = (
    Array.isArray(proposal.topicNames) ? proposal.topicNames : []
  ).map((topic) => String(topic));
  const lead = typeName !== '' ? typeName : topics.join(' + ');
  const rest = typeName !== '' && topics.length > 0 ? topics.join(' + ') : '';
  const htmlRest = rest === '' ? '' : esc(` + ${rest}`);
  return `${esc(`${name} → `)}<span class="zr-checklist__name">${esc(lead)}</span>${htmlRest}`;
}

/**
 * The quiet part after the name: the documents, and for an unsure row that
 * goes away, the verb. Pure on purpose.
 *
 * @param {object} proposal
 * @param {string} kind the checklist it sits in
 * @returns {string}
 */
function rowMeta(proposal, kind) {
  const action = String(proposal.action || 'split');
  const documents = documentsText(num(proposal.documentCount));
  return kind === 'unsure' && action === 'delete'
    ? `${documents} · delete`
    : documents;
}

/**
 * One row of a checklist. Pure on purpose: tests/test-simplify-assistant-ui.js
 * renders one of every kind.
 *
 * @param {object} proposal a TagSplitProposal
 * @param {string} kind the checklist it sits in
 * @param {boolean} ticked
 * @returns {string} markup
 */
function htmlChecklistRow(proposal, kind, ticked) {
  const id = num(proposal.tagId);
  const htmlMeta = `<span class="zr-checklist__meta">${esc(rowMeta(proposal, kind))}</span>`;
  const htmlText = `<span class="zr-checklist__text">${htmlRowWhat(proposal)}${htmlMeta}</span>`;
  if (kind === 'unchanged') {
    return `<div class="zr-checklist__row sim-list__row--plain" data-tag-id="${num(id)}">${htmlText}</div>`;
  }
  const htmlChecked = ticked === true ? ' checked' : '';
  const htmlBox = `<input class="zr-check zr-checklist__box sim-tick" type="checkbox" data-tag-id="${num(id)}"${htmlChecked}>`;
  if (kind === 'unsure') {
    const reason = String(proposal.reason == null ? '' : proposal.reason);
    const htmlReason =
      reason === ''
        ? ''
        : `<span class="zr-checklist__reason">${esc(reason)}</span>`;
    return `<label class="zr-checklist__row zr-checklist__row--dim" data-tag-id="${num(id)}">${htmlBox}${htmlText}${htmlReason}</label>`;
  }
  let chip = '';
  if (kind === 'split') {
    const source = String(proposal.source || 'rule');
    chip = SOURCE_LABELS[source] || source;
  } else if (kind === 'merge') {
    chip = mergeBasis(proposal);
  }
  const htmlChip =
    chip === '' ? '' : `<span class="zr-checklist__chip">${esc(chip)}</span>`;
  return `<label class="zr-checklist__row" data-tag-id="${num(id)}">${htmlBox}${htmlText}${htmlChip}</label>`;
}

/**
 * One checklist: its head with the count, its first rows and the button that
 * shows the rest. Unsure carries the way into the stack in its head;
 * Unchanged is one line with a button that lists its tags. An empty list is
 * not drawn at all. Pure on purpose.
 *
 * @param {string} kind one of SECTION_KINDS
 * @param {object[]} rows the proposals in it, in order
 * @param {{full?: boolean, shown?: boolean, overrides?: Map}} state
 * @returns {string} markup
 */
function htmlSection(kind, rows, state) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return '';
  const options = state || {};
  const count = list.length;
  const htmlHead = `<span class="zr-label">${esc(SECTION_TITLES[kind] || kind)} <span class="zr-checklist__count">${esc(`· ${grouped(count)}`)}</span></span>`;
  const htmlReview =
    kind === 'unsure'
      ? `<button class="zr-btn zr-btn--ghost sim-stack-open" type="button">${esc('Review one by one')}</button>`
      : '';

  let htmlBody;
  if (kind === 'unchanged') {
    const shown = options.shown === true;
    const htmlExpanded = shown ? 'true' : 'false';
    const htmlLine = `<div class="zr-checklist__row sim-list__row--plain sim-list__summary"><span class="zr-checklist__text">${esc(`${grouped(count)} ${plural(count, 'tag stays as it is', 'tags stay as they are')}`)}</span><button class="zr-btn zr-btn--ghost sim-unchanged-toggle" type="button" aria-expanded="${htmlExpanded}">${esc(shown ? 'Hide' : 'Show')}</button></div>`;
    htmlBody = shown
      ? `${htmlLine}${htmlSectionRows(kind, list, options)}`
      : htmlLine;
  } else {
    htmlBody = htmlSectionRows(kind, list, options);
  }
  return `<section class="zr-checklist sim-list sim-list--${esc(kind)}" data-section="${esc(kind)}"><div class="zr-checklist__head">${htmlHead}${htmlReview}</div><div class="sim-list__card">${htmlBody}</div></section>`;
}

/** The rows of one checklist, capped at LIST_ROWS until it is read in full. */
function htmlSectionRows(kind, list, options) {
  const shown = options.full === true ? list : list.slice(0, LIST_ROWS);
  const htmlRows = shown
    .map((proposal) =>
      htmlChecklistRow(proposal, kind, isTicked(proposal, options.overrides))
    )
    .join('');
  const rest = list.length - shown.length;
  const htmlMore =
    rest > 0
      ? `<div class="zr-checklist__more"><button class="zr-btn zr-btn--ghost sim-list-more" type="button" data-section="${esc(kind)}">${esc(`${grouped(rest)} more`)}</button></div>`
      : '';
  return `${htmlRows}${htmlMore}`;
}

/**
 * The cost line of the result: the mini bar and "23 requests · 110k tokens ·
 * ~3 min", or one quiet phrase when the page did not see the run. Pure on
 * purpose.
 *
 * @param {?object} cost lastRunCost
 * @returns {string} markup
 */
function htmlResultCost(cost) {
  if (!cost) return `<span>${esc(COST_UNKNOWN)}</span>`;
  const split = tokenSplit(cost);
  const part = splitShares(split);
  const tokens = num(cost.tokens) > 0 ? num(cost.tokens) : part.total;
  const requests = num(cost.requests);
  const text = `${grouped(requests)} ${plural(requests, 'request', 'requests')} · ${formatTokens(tokens)} tokens · ${roughTime(num(cost.ms) / 1000)}`;
  if (part.total <= 0) return `<span>${esc(text)}</span>`;
  const label = `${formatTokens(split.prompt)} question · ${formatTokens(split.answer)} answer · ${formatTokens(split.thinking)} thinking`;
  const htmlBar = `<span class="zr-tokenbar zr-tokenbar--mini" role="img" aria-label="${esc(label)}" title="${esc(label)}"><span class="zr-tokenbar__track"><span class="zr-tokenbar__seg zr-tokenbar__seg--prompt" style="width: ${num(part.prompt)}%"></span><span class="zr-tokenbar__seg zr-tokenbar__seg--answer" style="width: ${num(part.answer)}%"></span><span class="zr-tokenbar__seg zr-tokenbar__seg--thinking" style="width: ${num(part.thinking)}%"></span></span></span>`;
  return `${htmlBar}<span>${esc(text)}</span>`;
}

/**
 * A stamp as the database writes it ("2026-09-14 10:00:00", UTC) or as ISO.
 * Pure on purpose.
 *
 * @param {string} value
 * @returns {?Date}
 */
function parseStamp(value) {
  const text = String(value == null ? '' : value).trim();
  if (text === '') return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * When the page last saw an apply land: the newest stamp of an applied
 * proposal. Pure on purpose.
 *
 * @param {object[]} list proposals
 * @returns {?Date}
 */
function lastApplyAt(list) {
  let newest = null;
  (Array.isArray(list) ? list : []).forEach((proposal) => {
    if (String((proposal && proposal.status) || '') !== 'applied') return;
    const date = parseStamp(proposal.updatedAt);
    if (date && (newest === null || date > newest)) newest = date;
  });
  return newest;
}

/**
 * "14 Sep", with the year only when it is not this one. Pure on purpose.
 *
 * @param {Date} date
 * @param {Date} now
 * @returns {string}
 */
function shortDate(date, now) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const today = now instanceof Date ? now : new Date();
  const text = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === today.getFullYear()
    ? text
    : `${text} ${date.getFullYear()}`;
}

/**
 * The one line under a simple page: "History · last apply 14 Sep" and the
 * way to the log that undoes it, or '' when nothing was applied. Pure on
 * purpose.
 *
 * @param {?Date} date lastApplyAt()
 * @param {Date} now
 * @returns {string} markup
 */
function htmlHistoryLine(date, now) {
  const day = shortDate(date, now);
  if (day === '') return '';
  return `<span>${esc(`History · last apply ${day}`)}</span><a class="zr-btn zr-btn--ghost" href="${esc(UNDO_HREF)}">${esc('Undo')}</a>`;
}

/** The simple mode from the proposals as they stand. */
function renderSimple() {
  if (!el.result && !el.emptyCard) return;
  const sections = simpleSections([...proposals.values()]);
  const live =
    sections.split.length +
    sections.merge.length +
    sections.delete.length +
    sections.unsure.length;
  const ordering = jobId !== null && !applying;
  const stacking = el.stack !== null && !el.stack.classList.contains('hidden');
  const showResult = live > 0 && !ordering && !stacking;
  if (el.result) el.result.classList.toggle('hidden', !showResult);
  if (el.emptyCard) {
    el.emptyCard.classList.toggle('hidden', showResult || ordering || stacking);
  }
  if (el.historyLine) {
    const htmlLine = htmlHistoryLine(
      lastApplyAt([...proposals.values()]),
      new Date()
    );
    el.historyLine.innerHTML = htmlLine;
    el.historyLine.classList.toggle(
      'hidden',
      htmlLine === '' || ordering || stacking
    );
  }
  if (!showResult) return;
  if (el.resultHeadline) {
    el.resultHeadline.textContent = resultHeadline(sections);
  }
  if (el.resultCost) el.resultCost.innerHTML = htmlResultCost(lastRunCost);
  if (el.lists) {
    el.lists.innerHTML = SECTION_KINDS.map((kind) =>
      htmlSection(kind, sections[kind], {
        full: listsFull.has(kind),
        shown: unchangedShown,
        overrides: tickOverrides,
      })
    ).join('');
  }
  updateApplyTicked(sections);
}

/** Only the numbers of the button: a tick moves nothing else. */
function updateApplyTicked(sections) {
  if (!el.applyTickedBtn) return;
  const ticked = tickedProposals(
    sections || simpleSections([...proposals.values()]),
    tickOverrides
  );
  el.applyTickedBtn.textContent = applyTickedLabel(ticked);
  el.applyTickedBtn.disabled =
    ticked.length === 0 || jobId !== null || applying;
}

/**
 * The status changes that make "accepted" mean exactly the ticks: a ticked
 * row that is not accepted yet is accepted, an accepted row that was
 * unticked is opened again. Rows that stay as they are keep their status.
 * Pure on purpose.
 *
 * @param {object[]} list every proposal
 * @param {object[]} ticked tickedProposals()
 * @returns {Array<{tagId: number, status: string}>}
 */
function statusChanges(list, ticked) {
  const wanted = new Set(
    (Array.isArray(ticked) ? ticked : []).map((proposal) => num(proposal.tagId))
  );
  const changes = [];
  (Array.isArray(list) ? list : []).forEach((proposal) => {
    const status = String(proposal.status || 'open');
    if (status === 'applied') return;
    const id = num(proposal.tagId);
    if (wanted.has(id)) {
      if (status !== 'accepted')
        changes.push({ tagId: id, status: 'accepted' });
      return;
    }
    if (
      status === 'accepted' &&
      String(proposal.action || 'split') !== 'keep'
    ) {
      changes.push({ tagId: id, status: 'open' });
    }
  });
  return changes;
}

/**
 * Writes the status changes, a few at a time, without redrawing anything per
 * row: 945 redraws of the table would take longer than the writes.
 */
async function writeStatuses(changes) {
  let done = 0;
  let next = 0;
  // The first failure ends every lane after the request it is in, so no
  // status is written behind the error the page is about to show.
  let failure = null;
  const lane = async () => {
    while (failure === null && next < changes.length) {
      const change = changes[next];
      next += 1;
      try {
        const payload = await sendJson(
          'PATCH',
          `/api/simplify/proposals/${encodeURIComponent(String(change.tagId))}`,
          { status: change.status }
        );
        if (payload.data) proposals.set(num(payload.data.tagId), payload.data);
      } catch (error) {
        failure = failure || error;
        return;
      }
      done += 1;
      showPreparing(`Preparing ${grouped(done)} of ${grouped(changes.length)}`);
    }
  };
  const lanes = Math.min(PATCH_LANES, changes.length);
  await Promise.all(Array.from({ length: lanes }, lane));
  if (failure !== null) throw failure;
}

/**
 * The one button of the simple mode: what is ticked becomes what is
 * accepted, and the apply job writes it with the apply progress of both
 * modes.
 */
async function applyTicked() {
  if (jobId || applying) return;
  const all = [...proposals.values()];
  const ticked = tickedProposals(simpleSections(all), tickOverrides);
  if (ticked.length === 0) return;
  const confirmed = await confirmDialog({
    title: `Apply ${grouped(ticked.length)}`,
    body: applySummaryText(ticked),
    confirmLabel: 'Apply',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;
  applying = true;
  updateApplyTicked();
  if (el.applyResult) el.applyResult.innerHTML = '';
  const changes = statusChanges(all, ticked);
  try {
    if (changes.length > 0) {
      showPreparing(`Preparing 0 of ${grouped(changes.length)}`);
      await writeStatuses(changes);
    }
  } catch (error) {
    applying = false;
    hidePreparing();
    toast(error.message, { tone: 'danger' });
    await loadProposals();
    return;
  }
  applying = false;
  await applyOrder(null);
}

/* --- the stack: one decision per screen ----------------------------------- */

/**
 * The bar over the stack: where it is, how far, how much is left, and the one
 * way out of it that is not a decision. Pure on purpose.
 *
 * @param {number} at zero-based position in the queue
 * @param {number} total how long the queue is
 * @param {number} clear how many rows the model was sure of
 * @returns {string} markup
 */
function htmlStackBar(at, total, clear) {
  const size = Math.max(0, num(total));
  const position = Math.min(size, num(at) + 1);
  const left = Math.max(0, size - num(at));
  const percent = size === 0 ? 100 : Math.round((num(at) / size) * 100);
  const sure = num(clear);
  const htmlAccept =
    sure > 0
      ? `<button class="zr-btn zr-btn--ghost sim-stack-acceptclear" type="button">${esc(`Accept the ${grouped(sure)} clear ${plural(sure, 'one', 'ones')}`)}</button>`
      : '';
  return `<div class="zr-runbar"><span class="zr-runbar__position">${esc(`Tag ${position} of ${size}`)}</span><div class="zr-runbar__track"><div class="zr-runbar__fill" style="width: ${num(percent)}%"></div></div><span class="zr-runbar__rest">${esc(`${left} left`)}</span>${htmlAccept}</div>`;
}

/**
 * The card of one decision: the tag on the left, what it would become on the
 * right, the model's reason, the evidence with the overwrite choice, what it
 * writes and the three buttons. Pure on purpose.
 *
 * @param {object} proposal a TagSplitProposal
 * @param {string[]} types the vocabulary's document types
 * @returns {string} markup
 */
function htmlDecision(proposal, types) {
  const name = String(proposal.tagName == null ? '' : proposal.tagName);
  const documents = num(proposal.documentCount);
  const action = String(proposal.action || 'split');
  const keeps = num(proposal.documentsWithType);
  const target = String(
    proposal.mergeInto == null ? 'the other tag' : proposal.mergeInto
  );
  const htmlBadges = `<span class="zr-badge">${esc(GROUP_KIND_LABELS[action] || action)}</span>${htmlSourceBadge(proposal)}`;
  const htmlFrom = `<div class="zr-decision__side zr-decision__side--from"><div class="zr-decision__label">${esc('As it is')}</div><div class="zr-decision__name zr-decision__name--from">${esc(name)}</div><div class="zr-decision__meta">${esc(documentsText(documents))}</div></div>`;

  let htmlTo;
  if (action === 'merge') {
    htmlTo = `<div class="zr-decision__side"><div class="zr-decision__label">${esc('Becomes')}</div><div class="zr-decision__name">${esc(target)}</div><div class="zr-decision__meta">${esc('documents move, tag deleted')}</div></div>`;
  } else if (action === 'delete') {
    htmlTo = `<div class="zr-decision__side"><div class="zr-decision__label">${esc('Becomes')}</div><div class="zr-decision__name">${esc('nothing')}</div><div class="zr-decision__meta">${esc('off its documents, tag deleted')}</div></div>`;
  } else {
    htmlTo = `<div class="zr-decision__side"><div class="zr-decision__label">${esc('Becomes')}</div><div class="sim-decision__field"><span class="zr-label">${esc('Document type')}</span>${htmlTypeSelect(proposal, types)}</div><div class="sim-decision__field"><span class="zr-label">${esc('Topics')}</span>${htmlTopicChips(proposal)}</div></div>`;
  }

  const reason = String(proposal.reason == null ? '' : proposal.reason).trim();
  const htmlNote =
    reason === '' ? '' : `<p class="zr-decision__note">${esc(reason)}</p>`;

  let htmlEvidence = '';
  if (action === 'split') {
    const htmlKeepChecked = proposal.overwriteType === true ? '' : ' checked';
    const htmlOverChecked = proposal.overwriteType === true ? ' checked' : '';
    const typeName = proposal.typeName == null ? '' : String(proposal.typeName);
    const over =
      typeName === '' ? 'Overwrite any type' : `Overwrite with ${typeName}`;
    const leave =
      keeps > 0 ? `Keep the type on ${keeps}` : 'Only where none is set';
    const evidence = `${keeps} of ${documentsText(documents)} with a type`;
    htmlEvidence = `<div class="sim-decision__evidence"><p class="zr-sm">${esc(evidence)}</p><label class="sim-decision__radio"><input type="radio" class="sim-stack-overwrite" name="simStackOverwrite" value="keep"${htmlKeepChecked}><span class="zr-sm">${esc(leave)}</span></label><label class="sim-decision__radio"><input type="radio" class="sim-stack-overwrite" name="simStackOverwrite" value="overwrite"${htmlOverChecked}><span class="zr-sm">${esc(over)}</span></label></div>`;
  }

  const primary =
    action === 'merge'
      ? `Merge into ${target}`
      : action === 'delete'
        ? 'Delete'
        : 'Split';
  const htmlActions = `<div class="zr-decision__actions"><button class="zr-btn zr-btn--primary sim-stack-accept" type="button" data-tag-id="${num(proposal.tagId)}">${esc(primary)}</button><button class="zr-btn sim-stack-keep" type="button" data-tag-id="${num(proposal.tagId)}">${esc('Keep')}</button><button class="zr-btn zr-btn--ghost sim-stack-later" type="button" data-tag-id="${num(proposal.tagId)}">${esc('Later')}</button><span class="zr-decision__keys">${esc('Enter · Esc · L')}</span></div>`;

  return `<div class="zr-decision" data-tag-id="${num(proposal.tagId)}"><div class="zr-decision__head">${htmlBadges}</div><div class="zr-decision__sides">${htmlFrom}<div class="zr-decision__arrow">${htmlIconMarkup('i-arrow-right')}</div>${htmlTo}</div>${htmlNote}${htmlEvidence}${htmlConsequence(consequenceText(proposal), false)}${htmlActions}</div>`;
}

/**
 * The line under the stack: how many were decided, the way back from the
 * last one, and the way out. Pure on purpose.
 *
 * @param {number} decided how many decisions the stack has taken
 * @param {?object} undo the last one, `{ tagName }`, or null
 * @returns {string} markup
 */
function htmlStackFoot(decided, undo) {
  const count = num(decided);
  const htmlUndo =
    undo === null
      ? ''
      : `<button class="zr-btn zr-btn--ghost sim-stack-undo" type="button">${esc(`Undo ${String(undo.tagName)}`)}</button>`;
  return `<p class="zr-sm zr-faint sim-stack__tally">${esc(`${count} decided`)}</p>${htmlUndo}<button class="zr-btn zr-btn--ghost sim-stack-close" type="button">${esc('Back')}</button>`;
}

/** The proposals the stack still has to ask about, in the queue's order. */
function stackProposals() {
  return stackQueue
    .map((tagId) => proposals.get(num(tagId)))
    .filter((proposal) => proposal !== undefined);
}

/** The stack as it stands, when it is open. */
function renderStack() {
  if (!el.stack || el.stack.classList.contains('hidden')) return;
  const queue = stackProposals();
  const sections = simpleSections([...proposals.values()]);
  const clear =
    sections.split.length + sections.merge.length + sections.delete.length;
  if (el.stackBar) {
    el.stackBar.innerHTML = htmlStackBar(stackAt, queue.length, clear);
  }
  const proposal = queue[stackAt];
  if (!proposal) {
    if (el.stackCard) {
      el.stackCard.innerHTML = `<div class="zr-empty">${esc('All decided')}</div>`;
    }
  } else if (el.stackCard) {
    el.stackCard.innerHTML = htmlDecision(proposal, vocabulary.types);
  }
  if (el.stackFoot) {
    el.stackFoot.innerHTML = htmlStackFoot(stackDecided, stackUndo);
  }
}

/**
 * Opens the stack over exactly the unsure rows. It is a mode, not a page: the
 * result gives way to it and comes back when it closes.
 */
function openStack() {
  if (!el.stack) return;
  stackQueue = simpleSections([...proposals.values()]).unsure.map((proposal) =>
    num(proposal.tagId)
  );
  stackAt = 0;
  stackDecided = 0;
  stackUndo = null;
  el.stack.classList.remove('hidden');
  renderSimple();
  renderStack();
  el.stack.focus();
}

function closeStack() {
  if (!el.stack) return;
  el.stack.classList.add('hidden');
  stackQueue = [];
  stackAt = 0;
  stackUndo = null;
  renderSimple();
}

/**
 * One decision of the stack. Nothing here reaches Paperless-ngx: 'accept' and
 * 'keep' write the proposal's own status, 'later' only moves the queue on. An
 * accepted row is ticked in its checklist; a kept one moves to Unchanged.
 *
 * @param {string} decision 'accept' | 'keep' | 'later'
 */
async function decideOnStack(decision) {
  const queue = stackProposals();
  const proposal = queue[stackAt];
  if (!proposal) return;
  if (decision === 'later') {
    stackQueue.push(stackQueue.splice(stackAt, 1)[0]);
    if (stackAt >= stackQueue.length) stackAt = 0;
    renderStack();
    if (el.stack) el.stack.focus();
    return;
  }
  const tagId = num(proposal.tagId);
  stackUndo = {
    tagId,
    tagName: String(proposal.tagName == null ? '' : proposal.tagName),
    before: {
      action: String(proposal.action || 'split'),
      status: String(proposal.status || 'open'),
    },
    tick: tickOverrides.has(tagId) ? tickOverrides.get(tagId) : null,
  };
  if (decision === 'keep') tickOverrides.delete(tagId);
  else tickOverrides.set(tagId, true);
  const patch =
    decision === 'keep'
      ? { action: 'keep', status: 'accepted' }
      : { status: 'accepted' };
  await patchProposal(tagId, patch);
  stackDecided += 1;
  stackQueue = stackQueue.filter((id) => id !== tagId);
  if (stackAt >= stackQueue.length) {
    stackAt = Math.max(0, stackQueue.length - 1);
  }
  renderStack();
  if (el.stack) el.stack.focus();
}

/** Puts the last decision back the way it was, tick included. */
async function undoLastDecision() {
  if (stackUndo === null) return;
  const { tagId, before, tick } = stackUndo;
  stackUndo = null;
  if (tick === null) tickOverrides.delete(tagId);
  else tickOverrides.set(tagId, tick);
  await patchProposal(tagId, before);
  if (!stackQueue.includes(tagId)) stackQueue.splice(stackAt, 0, tagId);
  stackDecided = Math.max(0, stackDecided - 1);
  renderStack();
  if (el.stack) el.stack.focus();
}

/**
 * The way out of the stack that is not a decision: every row the model was
 * sure of ticked, the stack closed, and the apply button in reach.
 */
function acceptClearOnes() {
  const sections = simpleSections([...proposals.values()]);
  ['split', 'merge', 'delete'].forEach((kind) => {
    sections[kind].forEach((proposal) => {
      tickOverrides.set(num(proposal.tagId), true);
    });
  });
  closeStack();
  if (el.applyTickedBtn) el.applyTickedBtn.focus();
}

/* --- the sheet before a run ----------------------------------------------- */

/** Every number of an estimate, whatever answered it. Pure on purpose. */
function normaliseEstimate(data) {
  const source = data || {};
  const tokens = source.tokens || {};
  const skippable = source.skippable || {};
  const basis = String(source.basis || 'guess');
  return {
    tags: num(source.tags),
    itemsByRule: num(source.itemsByRule),
    items: num(source.items),
    batchSize: Math.max(1, num(source.batchSize) || ORDER_BATCH_SIZE),
    lanes: Math.max(1, num(source.lanes) || 1),
    requests: num(source.requests),
    seconds: num(source.seconds),
    tokens: {
      total: num(tokens.total),
      prompt: num(tokens.prompt),
      completion: num(tokens.completion),
      thinking: num(tokens.thinking),
    },
    basis: ESTIMATE_BASES.includes(basis) ? basis : 'guess',
    measuredAt: source.measuredAt == null ? '' : String(source.measuredAt),
    model: source.model == null ? '' : String(source.model),
    thinking: source.thinking === true,
    skippable: {
      decided: num(skippable.decided),
      lowDocument: num(skippable.lowDocument),
    },
    lastRun: source.lastRun || null,
    // The ceiling that would end the run: the bar of the sheet is drawn
    // against it, so it is not met for the first time on the running screen.
    tokenBudget: num(source.tokenBudget),
  };
}

/**
 * The seam for a build without the estimate route, or without a provider:
 * the same numbers worked out from what the page already knows, with the
 * arithmetic services/aiRunEstimate.js uses and `basis` reported as the guess
 * it is. Nothing else in this file knows the difference.
 *
 * @returns {Promise<object>} the raw estimate shape
 */
async function localOrderEstimate() {
  const index = await ensureTagIndex();
  const stored = [...proposals.values()];
  const tags = stored.length > 0 ? stored.length : index.size;
  const byRule = stored.filter(
    (proposal) => String(proposal.source || '') === 'rule'
  ).length;
  const decided = stored.filter((proposal) =>
    DECIDED_STATUSES.includes(String(proposal.status || 'open'))
  ).length;
  const lowDocument =
    stored.length > 0
      ? stored.filter(
          (proposal) => num(proposal.documentCount) < MIN_DOCUMENTS_LEVER
        ).length
      : [...index.values()].filter(
          (tag) => num(tag.documentCount) < MIN_DOCUMENTS_LEVER
        ).length;

  let items = Math.max(0, tags - byRule);
  if (runLevers.skipDecided) items = Math.max(0, items - decided);
  if (runLevers.minDocuments > 1) items = Math.max(0, items - lowDocument);
  const requests = Math.ceil(items / ORDER_BATCH_SIZE);
  const prompt =
    requests * (GUESS_PROMPT_BASE + GUESS_PROMPT_PER_ITEM * ORDER_BATCH_SIZE);
  const completion = requests * GUESS_TOKENS_PER_ITEM * ORDER_BATCH_SIZE;
  const thinking = requests * GUESS_THINKING_PER_REQUEST;
  return {
    tags,
    itemsByRule: byRule,
    items,
    batchSize: ORDER_BATCH_SIZE,
    lanes: runLevers.lanes,
    requests,
    seconds: Math.round(
      (completion + thinking) / GUESS_TOKENS_PER_SECOND / runLevers.lanes
    ),
    tokens: {
      total: prompt + completion + thinking,
      prompt,
      completion,
      thinking,
    },
    basis: 'guess',
    measuredAt: null,
    model: '',
    thinking: true,
    skippable: { decided, lowDocument },
    lastRun: null,
  };
}

/** The estimate for the levers as they stand, from the route or from the stub. */
async function fetchOrderEstimate(keepVocabulary) {
  const query = new URLSearchParams({
    keepVocabulary: keepVocabulary === true ? 'true' : 'false',
    skipDecided: runLevers.skipDecided === true ? 'true' : 'false',
    concurrency: String(runLevers.lanes),
  });
  // Without the lever no floor is sent, so the estimate still counts what the
  // lever would leave out at its own floor of three.
  if (runLevers.minDocuments > 1) {
    query.set('minDocuments', String(runLevers.minDocuments));
  }
  try {
    const payload = await requestJson(`${ESTIMATE_URL}?${query.toString()}`);
    const answer = normaliseEstimate(payload.data || {});
    // A build whose route answers without numbers is the same as one without
    // the route at all: a sheet of zeroes would be worse than a guess.
    if (answer.tags > 0 || answer.items > 0) return answer;
  } catch {
    // No route on this build, or no provider behind it.
  }
  // Either way the stub answers, and says so through basis === 'guess'.
  return normaliseEstimate(await localOrderEstimate());
}

/**
 * The facts under the title: "1,145 of 1,187 tags · 23 requests · 42 by
 * rule". The rule part only when a rule takes some. Pure on purpose.
 *
 * @param {object} estimate normaliseEstimate()
 * @returns {string}
 */
function sheetSub(estimate) {
  const requests = num(estimate.requests);
  const parts = [
    `${grouped(estimate.items)} of ${grouped(estimate.tags)} tags`,
    `${grouped(requests)} ${plural(requests, 'request', 'requests')}`,
  ];
  if (num(estimate.itemsByRule) > 0) {
    parts.push(`${grouped(estimate.itemsByRule)} by rule`);
  }
  return parts.join(' · ');
}

/**
 * The run's time at a number of lanes. The estimate says it for the lanes it
 * was asked at; the requests themselves do not change with the lanes, only
 * how many run side by side. Pure on purpose.
 *
 * @param {object} estimate normaliseEstimate()
 * @param {number} lanes
 * @returns {number} seconds
 */
function laneSeconds(estimate, lanes) {
  const asked = Math.max(1, num(estimate.lanes) || 1);
  const wanted = Math.max(1, num(lanes) || 1);
  return Math.round((num(estimate.seconds) * asked) / wanted);
}

/**
 * What a lever saves, from the estimate already on the sheet: the requests
 * the tags it leaves out would take, and their tokens at the estimate's own
 * average. '' when it saves no request. Pure on purpose.
 *
 * @param {object} estimate normaliseEstimate()
 * @param {number} count the tags the lever leaves out
 * @param {boolean} on whether the estimate was made with the lever on
 * @returns {string} "−3 requests · −14k", or ''
 */
function leverPrice(estimate, count, on) {
  const batch = Math.max(1, num(estimate.batchSize));
  const items = num(estimate.items);
  const left = Math.max(0, num(count));
  const without = on === true ? items + left : items;
  const within = on === true ? items : Math.max(0, items - left);
  const saved = Math.ceil(without / batch) - Math.ceil(within / batch);
  if (saved <= 0) return '';
  const requests = num(estimate.requests);
  const each = requests > 0 ? num(estimate.tokens.total) / requests : 0;
  const tokens = Math.round(saved * each);
  const parts = [`−${saved} ${plural(saved, 'request', 'requests')}`];
  if (tokens > 0) parts.push(`−${formatTokens(tokens)}`);
  return parts.join(' · ');
}

/**
 * The switches of the sheet, in their order, each only when it would change
 * something: the decided tags, the tags on few documents, and in simple mode
 * the saved vocabulary. Pure on purpose.
 *
 * @param {object} estimate normaliseEstimate()
 * @param {object} levers runLevers
 * @param {boolean} keepOffer whether the vocabulary switch belongs here
 * @returns {Array<{id: string, label: string, price: string, on: boolean}>}
 */
function sheetSwitches(estimate, levers, keepOffer) {
  const switches = [];
  const decided = num(estimate.skippable.decided);
  if (decided > 0) {
    const on = levers.skipDecided === true;
    switches.push({
      id: 'skipDecided',
      label: `Skip ${grouped(decided)} already decided`,
      price: leverPrice(estimate, decided, on),
      on,
    });
  }
  const low = num(estimate.skippable.lowDocument);
  if (low > 0) {
    const on = num(levers.minDocuments) > 1;
    switches.push({
      id: 'minDocuments',
      label: `Only tags on ${MIN_DOCUMENTS_LEVER}+ documents`,
      price: leverPrice(estimate, low, on),
      on,
    });
  }
  if (keepOffer === true) {
    switches.push({
      id: 'keepVocabulary',
      label: 'Keep vocabulary',
      price: '',
      on: levers.keepVocabulary === true,
    });
  }
  return switches;
}

/**
 * The model the shared sheet draws: the facts, the tokens against the run's
 * limit, the time at the lanes chosen, the switches and where the numbers
 * come from. Pure on purpose.
 *
 * @param {object} estimate normaliseEstimate()
 * @param {object} levers runLevers
 * @param {boolean} keepOffer
 * @returns {object} a SheetModel of js/modules/review-sheet.js
 */
function sheetModel(estimate, levers, keepOffer) {
  const lanes = Math.max(1, num(levers.lanes) || 1);
  return {
    sub: sheetSub(estimate),
    requests: num(estimate.requests),
    tokens: {
      prompt: num(estimate.tokens.prompt),
      completion: num(estimate.tokens.completion),
      thinking: num(estimate.tokens.thinking),
    },
    limit: num(estimate.tokenBudget),
    seconds: laneSeconds(estimate, lanes),
    lanes,
    laneChoices: LANE_CHOICES,
    switches: sheetSwitches(estimate, levers, keepOffer),
    basis: estimate.basis,
  };
}

/**
 * Opens the sheet and keeps its numbers in step with its levers. The dialog
 * is the kernel's and the body the shared sheet's; this page only hands it
 * the model and listens.
 *
 * @param {boolean} forceKeep true when the run keeps the saved vocabulary
 *   whatever the switch says (the button of the vocabulary block)
 * @returns {Promise<boolean>} true when Start was pressed
 */
async function askPreflight(forceKeep) {
  const keepOffer = mode === 'simple' && vocabularySaved && forceKeep !== true;
  const keepFor = () =>
    forceKeep === true ||
    (vocabularySaved && runLevers.keepVocabulary === true);
  let estimate = await fetchOrderEstimate(keepFor());
  const model = () => sheetModel(estimate, runLevers, keepOffer);
  const answer = confirmDialog({
    title: 'Simplify tags',
    html: htmlSheet(model()),
    confirmLabel: 'Start',
    cancelLabel: 'Cancel',
    className: 'zr-dialog--sheet',
  });
  const dialog = document.querySelector('dialog.zr-dialog[open]');
  let unbind = () => {};
  if (dialog) {
    let asked = 0;
    const refresh = async () => {
      // The lever moves at once; the numbers follow from a fresh estimate,
      // and an answer that a later move overtook is dropped.
      updateSheet(dialog, model());
      asked += 1;
      const ticket = asked;
      const next = await fetchOrderEstimate(keepFor());
      if (ticket !== asked || !dialog.open) return;
      estimate = next;
      updateSheet(dialog, model());
    };
    unbind = bindSheet(dialog, {
      onLanes: (lanes) => {
        runLevers.lanes = Math.max(1, num(lanes) || 1);
        refresh();
      },
      onSwitch: (id, on) => {
        if (id === 'skipDecided') runLevers.skipDecided = on;
        if (id === 'minDocuments') {
          runLevers.minDocuments = on ? MIN_DOCUMENTS_LEVER : 1;
        }
        if (id === 'keepVocabulary') {
          runLevers.keepVocabulary = on;
          if (el.keepVocabulary) el.keepVocabulary.checked = on;
        }
        refresh();
      },
    });
  }
  try {
    return await answer;
  } finally {
    unbind();
  }
}

/* --- the run meter -------------------------------------------------------- */

/** The bar of the run: where it is, how far, what is left. Pure on purpose. */
function htmlRunbar(progress) {
  const state = progress || {};
  const done = num(state.requestsDone);
  const planned = num(state.requestsPlanned);
  const percent = progressPercent(state);
  const position =
    planned > 0
      ? `Request ${Math.min(done + 1, planned)} of ${planned}`
      : `Request ${done + 1}`;
  const rest = formatEta(state.etaMs) || 'estimating…';
  const htmlFill =
    percent === null
      ? '<div class="zr-runbar__fill sim-progress__fill--indeterminate"></div>'
      : `<div class="zr-runbar__fill" style="width: ${num(percent)}%"></div>`;
  return `<div class="zr-runbar"><span class="zr-runbar__position">${esc(position)}</span><div class="zr-runbar__track">${htmlFill}</div><span class="zr-runbar__rest">${esc(rest)}</span></div>`;
}

/** Tokens so far against the estimate, and the time. Pure on purpose. */
function htmlRunLedger(progress) {
  const state = progress || {};
  const spent = num(state.tokens);
  const planned = num(state.estimatedTokens);
  const judged = num(state.pairsJudged);
  const total = num(state.pairsTotal);
  const items = [
    { value: formatElapsed(num(state.elapsedMs)), unit: 'elapsed' },
  ];
  if (total > 0) {
    items.push({ value: `${judged} of ${total}`, unit: 'tags' });
  } else if (judged > 0) {
    items.push({ value: String(judged), unit: 'tags' });
  }
  if (spent > 0) {
    items.push({
      value:
        planned > 0
          ? `${formatTokens(spent)} of ~${formatTokens(planned)}`
          : formatTokens(spent),
      unit: 'tokens',
    });
  }
  return htmlLedger(items);
}

/**
 * The ceiling that would end the run, and only when it is close enough to
 * matter. It is the whole run's budget, not one request's.
 *
 * @param {object} progress
 * @returns {string} the line, or '' while it is far away
 */
function runCeilingText(progress) {
  const state = progress || {};
  const budget = num(state.tokenBudget);
  const spent = num(state.tokens);
  if (budget <= 0 || spent <= budget * CEILING_SHOWN_ABOVE) return '';
  return `${formatTokens(spent)} of ${formatTokens(budget)} limit`;
}

/**
 * The request being answered right now, as the first row of the log. This is
 * where the thinking belongs: on the request that is thinking.
 *
 * @param {object} progress
 * @returns {string} markup, or '' when nothing is in flight
 */
function htmlLiveRequest(progress) {
  const state = progress || {};
  const running = num(state.requestTokens);
  const thinking = state.thinking === true;
  if (running <= 0 && !thinking) return '';
  const index = num(state.requestsDone) + 1;
  const items = num(state.requestPairs);
  const answers = num(state.requestAnswers);
  const what =
    items > 0
      ? `Request ${index} · ${items} ${plural(items, 'tag', 'tags')} · ${answers} answered`
      : `Request ${index}`;
  const cost =
    running > 0
      ? `${formatTokens(running)} so far${thinking ? ' · thinking' : ''}`
      : 'thinking';
  return `<div class="zr-reqlog__row zr-reqlog__row--live"><span class="zr-reqlog__mark">${htmlIconMarkup('i-refresh', 'zr-icon--spin')}</span><span class="zr-reqlog__what">${esc(what)}</span><span class="zr-reqlog__cost">${esc(cost)}</span><span class="zr-reqlog__state">${esc('running')}</span></div>`;
}

/**
 * What one finished request did, in one line of facts. `empty` and `failed`
 * are the two that are worth reading. Pure on purpose.
 *
 * @param {object} record an AiReviewRequestRecord
 * @returns {string}
 */
function reqlogText(record) {
  const entry = record || {};
  const index = num(entry.index);
  const items = num(entry.items);
  const answers = num(entry.answers);
  const outcome = String(entry.outcome || 'answered');
  const asked = `${items} ${plural(items, 'tag', 'tags')}`;
  if (outcome === 'empty') {
    return `Request ${index} · ${formatTokens(entry.thinkingTokens)} thinking · no answer`;
  }
  if (outcome === 'failed') {
    return `Request ${index} · ${asked} · ended by the provider`;
  }
  if (outcome === 'partial') {
    return `Request ${index} · ${asked} · ${answers} answered · rest asked again`;
  }
  return `Request ${index} · ${asked} · ${answers} answered`;
}

/** What that request cost, as the row's right hand column. Pure on purpose. */
function reqlogCost(record) {
  const entry = record || {};
  const tokens = num(entry.tokens);
  const thinking = num(entry.thinkingTokens);
  if (tokens <= 0) return '0 tokens';
  if (thinking <= 0) return `${formatTokens(tokens)} tokens`;
  if (thinking >= tokens) return `${formatTokens(tokens)} · all thinking`;
  return `${formatTokens(tokens)} · ${formatTokens(thinking)} thinking`;
}

/** The last handful of requests, newest first. Pure on purpose. */
function htmlReqLog(list) {
  const rows = Array.isArray(list) ? list : [];
  if (rows.length === 0) return '';
  const htmlRows = rows
    .map((record) => {
      const outcome = String(record.outcome || 'answered');
      const warn = outcome === 'empty' || outcome === 'failed';
      const htmlClass = warn ? ' zr-reqlog__row--warn' : '';
      const htmlMark = `<span class="zr-reqlog__mark">${htmlIconMarkup(warn ? 'i-alert' : 'i-check')}</span>`;
      return `<div class="zr-reqlog__row${htmlClass}">${htmlMark}<span class="zr-reqlog__what">${esc(reqlogText(record))}</span><span class="zr-reqlog__cost">${esc(reqlogCost(record))}</span><span class="zr-reqlog__state">${esc(formatElapsed(num(record.ms)))}</span></div>`;
    })
    .join('');
  return `<div class="zr-reqlog">${htmlRows}</div>`;
}

/** The run meter, from one progress event. */
function renderRunMeter(progress) {
  const state = progress || {};
  if (el.runbar) el.runbar.innerHTML = htmlRunbar(state);
  if (el.runLedger) el.runLedger.innerHTML = htmlRunLedger(state);
  if (el.runTokens) {
    el.runTokens.innerHTML = htmlTokenbar(
      tokenSplit({
        prompt: state.promptTokens,
        completion: state.completionTokens,
        thinking: state.thinkingTotal,
      })
    );
  }
  if (el.runCeiling) {
    const ceiling = runCeilingText(state);
    el.runCeiling.textContent = ceiling;
    el.runCeiling.classList.toggle('hidden', ceiling === '');
  }
  // The request in flight is the first row of the log, where it belongs.
  if (el.reqLog) {
    el.reqLog.innerHTML = htmlLiveRequest(state) + htmlReqLog(state.requestLog);
  }
}

/** What a finished model run cost, kept for the cost line of the result. */
function keepRunCost(progress) {
  const state = progress || {};
  const tokens = num(state.tokens);
  if (tokens <= 0 && num(state.requestsDone) <= 0) return;
  lastRunCost = {
    requests: num(state.requestsDone),
    tokens,
    ms: num(state.elapsedMs),
    prompt: num(state.promptTokens),
    completion: num(state.completionTokens),
    thinking: num(state.thinkingTotal),
  };
}

/* --- the apply as a checklist --------------------------------------------- */

/**
 * One row per tag the apply will write, in the order the apply job takes
 * them: merges, splits, deletions, the biggest first. A tag that stays is
 * never written and has no row. Pure on purpose.
 *
 * @param {object[]} list the accepted proposals
 * @returns {Array<object>}
 */
function checklistFrom(list) {
  return (Array.isArray(list) ? list : [])
    .filter(
      (proposal) =>
        APPLY_ORDER[String((proposal && proposal.action) || 'split')] !==
        undefined
    )
    .sort(
      (a, b) =>
        APPLY_ORDER[String(a.action || 'split')] -
          APPLY_ORDER[String(b.action || 'split')] ||
        num(b.documentCount) - num(a.documentCount) ||
        String(a.tagName || '').localeCompare(String(b.tagName || ''), 'en', {
          sensitivity: 'base',
        })
    )
    .map((proposal) => ({
      tagId: num(proposal.tagId),
      tagName: String(proposal.tagName == null ? '' : proposal.tagName),
      writes: planWrites([proposal]).writes,
      state: 'waiting',
      seconds: 0,
      error: '',
    }));
}

/**
 * The checklist as it stands. Pure on purpose: the rows carry their own state
 * and this only writes them out.
 *
 * @param {Array<object>} rows checklistFrom(), updated in place
 * @returns {string} markup
 */
function htmlChecklist(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return '';
  const done = list.filter((row) => row.state === 'done').length;
  const failed = list.filter((row) => row.state === 'failed').length;
  const writes = list.reduce((sum, row) => sum + num(row.writes), 0);
  const parts = [`${done} of ${list.length} done`];
  if (failed > 0) parts.push(`${failed} failed`);
  parts.push(`${grouped(writes)} ${plural(writes, 'write', 'writes')}`);
  const htmlRows = list
    .map((row) => {
      const state = String(row.state || 'waiting');
      const warn = state === 'failed';
      const htmlClass =
        state === 'running'
          ? ' zr-reqlog__row--live'
          : warn
            ? ' zr-reqlog__row--warn'
            : '';
      const icon =
        state === 'done'
          ? 'i-check'
          : state === 'failed'
            ? 'i-alert'
            : state === 'running'
              ? 'i-refresh'
              : 'i-clock';
      const htmlMark = `<span class="zr-reqlog__mark">${htmlIconMarkup(icon)}</span>`;
      const writesText = `${row.writes} ${plural(row.writes, 'write', 'writes')}`;
      const what = warn
        ? `${row.tagName} · ${row.error} · ${writesText} to do`
        : `${row.tagName} · ${writesText}`;
      const when =
        state === 'done'
          ? formatElapsed(num(row.seconds) * 1000)
          : state === 'running'
            ? 'running'
            : state === 'failed'
              ? 'failed'
              : 'waiting';
      const htmlRetry = warn
        ? `<button class="zr-btn zr-btn--ghost sim-checklist-retry" type="button" data-tag-id="${num(row.tagId)}">${esc('Retry')}</button>`
        : '';
      return `<div class="zr-reqlog__row${htmlClass}">${htmlMark}<span class="zr-reqlog__what">${esc(what)}</span>${htmlRetry}<span class="zr-reqlog__state">${esc(when)}</span></div>`;
    })
    .join('');
  return `<div class="sim-checklist__head"><span class="zr-label">${esc(parts.join(' · '))}</span><span class="zr-sm zr-faint">${esc('0 tokens')}</span></div><div class="zr-reqlog">${htmlRows}</div>`;
}

function renderChecklist() {
  if (!el.checklist) return;
  el.checklist.innerHTML = htmlChecklist(checklistRows);
}

/**
 * Moves the checklist on from one progress event of the apply job. The job
 * reports how many are through, and the lanes decide how many are in flight.
 *
 * @param {object} progress the job's progress
 */
function advanceChecklist(progress) {
  if (checklistRows.length === 0) return;
  const state = progress || {};
  const done = Math.min(checklistRows.length, num(state.pairsJudged));
  const lanes = Math.max(1, num(state.concurrency) || APPLY_LANES);
  const now = Date.now();
  checklistRows.forEach((row, at) => {
    if (row.state === 'failed') return;
    if (at < done) {
      if (row.state !== 'done') {
        row.state = 'done';
        row.seconds = Math.max(0, Math.round((now - checklistAt) / 1000));
        checklistAt = now;
      }
      return;
    }
    row.state = at < done + lanes ? 'running' : 'waiting';
  });
  renderChecklist();
}

/** And the last word: what the apply reported, row by row. */
function finishChecklist(result) {
  if (checklistRows.length === 0) return;
  const data = result || {};
  const failures = new Map();
  (Array.isArray(data.failed) ? data.failed : []).forEach((failure) => {
    failures.set(num(failure.tagId), String(failure.error || 'unknown error'));
  });
  checklistRows.forEach((row) => {
    if (failures.has(row.tagId)) {
      row.state = 'failed';
      row.error = failures.get(row.tagId);
      return;
    }
    if (row.state !== 'done') row.state = 'done';
  });
  renderChecklist();
}

/** One failed row of the checklist, tried again on its own. */
async function retryOne(tagId) {
  try {
    await applyTags([num(tagId)]);
    const row = checklistRows.find((entry) => entry.tagId === num(tagId));
    if (row) {
      row.state = 'done';
      row.error = '';
    }
    renderChecklist();
    await loadProposals();
    toast('Applied', { tone: 'ok' });
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  }
}

/* --- wiring --------------------------------------------------------------- */

/** The mode switch in the top bar, and what a change of mode closes. */
function initMode() {
  if (!el.page) return;
  mode = mountModeSwitch({
    page: 'simplify',
    root: el.page,
    slot: el.topbarActions,
    gate: GATE_LINES,
    onChange: (next) => {
      mode = next;
      // The stack is opened from the simple result; it does not outlive it.
      if (el.stack && !el.stack.classList.contains('hidden')) closeStack();
    },
  });
}

/** The simple mode: the card's button, the ticks, the lists and the apply. */
function initSimple() {
  if (el.startBtn) el.startBtn.addEventListener('click', proposeOrder);
  if (el.applyTickedBtn) {
    el.applyTickedBtn.addEventListener('click', applyTicked);
  }
  if (!el.lists) return;
  // A tick is local and moves only the numbers of the button.
  el.lists.addEventListener('change', (event) => {
    const box = event.target.closest('.sim-tick');
    if (!box) return;
    tickOverrides.set(num(box.dataset.tagId), box.checked === true);
    updateApplyTicked();
  });
  el.lists.addEventListener('click', (event) => {
    const more = event.target.closest('.sim-list-more');
    if (more) {
      listsFull.add(String(more.dataset.section));
      renderSimple();
      return;
    }
    if (event.target.closest('.sim-unchanged-toggle')) {
      unchangedShown = !unchangedShown;
      renderSimple();
      return;
    }
    if (event.target.closest('.sim-stack-open')) openStack();
  });
}

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
    emptyText: 'No match · Enter adds it',
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

/** The order of the advanced mode: its buttons, the filters and the cards. */
function initOrder() {
  if (el.orderBtn) el.orderBtn.addEventListener('click', proposeOrder);
  if (el.reproposeBtn) {
    el.reproposeBtn.addEventListener('click', repropose);
  }
  if (el.applyAcceptedBtn) {
    el.applyAcceptedBtn.addEventListener('click', applyAllAccepted);
  }
  if (el.keepVocabulary) {
    el.keepVocabulary.addEventListener('change', () => {
      runLevers.keepVocabulary = el.keepVocabulary.checked === true;
    });
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

  // A card that is open stays open across a render; `toggle` does not
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

/** The stack and the apply checklist: one delegated listener each. */
function initStack() {
  if (el.checklist) {
    el.checklist.addEventListener('click', (event) => {
      const retry = event.target.closest('.sim-checklist-retry');
      if (retry) retryOne(num(retry.dataset.tagId));
    });
  }

  if (!el.stack) return;
  el.stack.addEventListener('click', (event) => {
    if (event.target.closest('.sim-stack-accept')) {
      decideOnStack('accept');
      return;
    }
    if (event.target.closest('.sim-stack-keep')) {
      decideOnStack('keep');
      return;
    }
    if (event.target.closest('.sim-stack-later')) {
      decideOnStack('later');
      return;
    }
    if (event.target.closest('.sim-stack-undo')) {
      undoLastDecision();
      return;
    }
    if (event.target.closest('.sim-stack-close')) {
      closeStack();
      return;
    }
    if (event.target.closest('.sim-stack-acceptclear')) {
      acceptClearOnes();
      return;
    }
    const remove = event.target.closest('.sim-topic-remove');
    if (!remove) return;
    const tagId = num(remove.dataset.tagId);
    const proposal = proposals.get(tagId);
    if (!proposal) return;
    patchProposal(tagId, {
      topicNames: (proposal.topicNames || []).filter(
        (entry) => entry !== remove.dataset.name
      ),
    });
  });

  el.stack.addEventListener('change', (event) => {
    const target = event.target;
    if (target.classList.contains('sim-type')) {
      patchProposal(num(target.dataset.tagId), {
        typeName: target.value === '' ? null : target.value,
      });
      return;
    }
    if (!target.classList.contains('sim-stack-overwrite')) return;
    const card = el.stack.querySelector('.zr-decision');
    if (!card) return;
    patchProposal(num(card.dataset.tagId), {
      overwriteType: target.value === 'overwrite',
    });
  });

  // The keys of the stack. They are bound on the container, and a field that
  // has the focus keeps every key it needs for itself.
  el.stack.addEventListener('keydown', (event) => {
    const input = event.target.closest('.sim-topics__input');
    if (input) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const tagId = num(input.dataset.tagId);
      const proposal = proposals.get(tagId);
      const name = String(input.value || '').trim();
      if (!proposal || name === '') return;
      const names = [...(proposal.topicNames || [])];
      if (!names.includes(name)) names.push(name);
      input.value = '';
      patchProposal(tagId, { topicNames: names });
      return;
    }
    if (EDITABLE_TAGS.includes(String(event.target.tagName).toLowerCase())) {
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      decideOnStack('accept');
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      decideOnStack('keep');
      return;
    }
    if (event.key === 'l' || event.key === 'L') {
      event.preventDefault();
      decideOnStack('later');
    }
  });
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
  initMode();
  initSimple();
  initVocabulary();
  initOrder();
  initStack();
  initProposals();
  setView('groups');
  await loadVocabulary();
  await loadDocumentTypes();
  await loadGroups();
  await loadProposals();
  // Once more after the loads, so a page whose proposals could not be read
  // still shows its card.
  renderSimple();
  await reattachJob();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
