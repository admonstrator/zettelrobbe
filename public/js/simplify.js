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

/* --- round 13: the plan, the stack and the cost layer --------------------- */

/** The four baskets a finished plan is read as, in the order they appear. */
const BASKET_KINDS = ['rule', 'sure', 'ask', 'keep'];

/** What each basket is called. The title carries the count after a dash. */
const BASKET_TITLES = {
  rule: 'Clear as day',
  sure: 'The model is sure',
  ask: 'I need a word from you',
  keep: 'Stays as it is',
};

/** And the one line under each title, in the words the page speaks. */
const BASKET_NOTES = {
  rule: 'Compounds a rule already covers. No model was asked about these.',
  sure: 'The model read them and did not hesitate.',
  ask: 'Two ways to read them, and the model would only be guessing.',
  keep: 'Nothing to take apart; these tags stay exactly as they are.',
};

/** The mark each basket wears; only the one that needs an answer is amber. */
const BASKET_MARKS = {
  rule: 'zr-basket__mark--ok',
  sure: '',
  ask: 'zr-basket__mark--ask',
  keep: '',
};

/** One symbol each, out of the app's set. */
const BASKET_ICONS = {
  rule: 'i-check',
  sure: 'i-wand',
  ask: 'i-alert',
  keep: 'i-check-circle',
};

/** Sentences a basket writes before it offers to read the rest. */
const BASKET_LINES = 10;

/** Tags one request of the order job asks about. */
const ORDER_BATCH_SIZE = 50;

/** What the preflight's lanes select offers. */
const LANE_CHOICES = [1, 3, 5, 8];

/** The second lever: tags on fewer documents than this are left out. */
const MIN_DOCUMENTS_LEVER = 3;

/** The three statuses that mean "you have already said something about it". */
const DECIDED_STATUSES = ['accepted', 'skipped', 'applied'];

/** Where an estimate's numbers may say they come from. */
const ESTIMATE_BASES = ['run', 'model', 'guess'];

/** Where the preflight asks what a run will cost. */
const ESTIMATE_URL = '/api/simplify/order/estimate';

/** One write to Paperless-ngx is a round trip; this is what the page promises. */
const APPLY_SECONDS_PER_WRITE = 0.35;

/** The fields that keep every key for themselves while they have focus. */
const EDITABLE_TAGS = ['input', 'select', 'textarea'];

/** How many tags an apply writes at once when the job does not say. */
const APPLY_LANES = 3;

/* The guess of services/aiRunEstimate.js, kept here for the local estimate
   below. They are the same round numbers on purpose: a stub that invents its
   own arithmetic would read differently from the route once it lands. */
const GUESS_PROMPT_BASE = 900;
const GUESS_PROMPT_PER_ITEM = 18;
const GUESS_TOKENS_PER_ITEM = 26;
const GUESS_THINKING_PER_REQUEST = 1800;
const GUESS_TOKENS_PER_SECOND = 45;

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
  applyAcceptedSub: document.getElementById('simApplyAcceptedSub'),
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
  // Round 13: the plan, the stack, the run meter and the apply checklist.
  plan: document.getElementById('simPlan'),
  planHead: document.getElementById('simPlanHead'),
  baskets: document.getElementById('simBaskets'),
  stack: document.getElementById('simStack'),
  stackBar: document.getElementById('simStackBar'),
  stackCard: document.getElementById('simStackCard'),
  stackFoot: document.getElementById('simStackFoot'),
  groupsBlock: document.getElementById('simGroupsBlock'),
  runbar: document.getElementById('simRunbar'),
  runLedger: document.getElementById('simRunLedger'),
  runTokens: document.getElementById('simRunTokens'),
  runLive: document.getElementById('simRunLive'),
  reqLog: document.getElementById('simReqLog'),
  stopSub: document.getElementById('simStopSub'),
  checklist: document.getElementById('simApplyChecklist'),
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

/** What the last model-backed run cost, for the plan's first ledger. */
let lastRunCost = null;

/** The baskets whose body is open; the two that need reading start so. */
const basketsOpen = new Set(['sure', 'ask']);

/** And the ones the user asked to read in full rather than capped. */
const basketsFull = new Set();

/** The stack: the tag ids it still has to ask about, and where it is. */
let stackQueue = [];
let stackAt = 0;
let stackDecided = 0;
let stackUndo = null;

/** The levers of the preflight; they survive the dialog they were set in. */
const runLevers = { skipDecided: false, minDocuments: 1, lanes: 3 };

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
    renderPlan();
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
    renderPlan();
    renderStack();
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
  // Round 13: "no groups match" belongs to the block the group cards live in,
  // so it is only said while that block is open. An order that was never
  // proposed is the plan's empty state too, and is always said.
  const grouping = el.groupsBlock === null || el.groupsBlock.open === true;
  const show =
    view === 'groups' && count === 0 && (groups.length === 0 || grouping);
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
  // Round 13: the button says what pressing it writes, before it is pressed.
  if (el.applyAcceptedSub) {
    const totals = planWrites(
      [...proposals.values()].filter(
        (proposal) => String(proposal.status || 'open') === 'accepted'
      )
    );
    el.applyAcceptedSub.textContent =
      totals.tags === 0
        ? 'nothing accepted yet'
        : `${totals.writes} ${plural(totals.writes, 'write', 'writes')} on ${documentsText(totals.documents)} · ${totals.deletions} ${plural(totals.deletions, 'tag', 'tags')} deleted · no tokens`;
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
  // Round 13: the plan is what the first position of the segment shows, and
  // the stack is a mode inside it — both belong to the table's other side.
  const stacking = el.stack !== null && !el.stack.classList.contains('hidden');
  if (el.plan) el.plan.classList.toggle('hidden', table || stacking);
  if (el.stack) el.stack.classList.toggle('hidden', table || !stacking);
  if (el.groupsBlock) el.groupsBlock.classList.toggle('hidden', table);
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
      skipDecided: runLevers.skipDecided,
      minDocuments: runLevers.minDocuments,
      concurrency: runLevers.lanes,
    });
    const { result, stopped } = await followJob(job);
    orderResult = result || {};
    orderStopped = stopped === true;
    await loadVocabulary();
    await loadGroups();
    await loadProposals();
    renderOrderSummary();
    renderPlan();
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

async function proposeOrder() {
  const keep = el.keepVocabulary !== null && el.keepVocabulary.checked === true;
  // Round 13: nothing model-backed starts before the dialog said what it does,
  // what it costs and that it writes nothing.
  const go = await askPreflight(keep);
  if (!go) return;
  await runOrderJob(keep ? 'keep' : 'propose');
}

/** The same job from the vocabulary block: these names, no new ones. */
async function repropose() {
  const go = await askPreflight(true);
  if (!go) return;
  await runOrderJob('keep');
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
  const accepted = [...proposals.values()].filter(
    (proposal) => String(proposal.status || 'open') === 'accepted'
  );
  checklistRows = checklistFrom(accepted);
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
  renderRunMeter(state);
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
  // The meter keeps what the run cost; the plan's first ledger reads it.
  const finished = progressJob ? progressJob.progress : null;
  renderRunMeter(finished);
  if (String(progressJob && progressJob.task) !== JOB_TASKS.APPLY) {
    keepRunCost(finished);
  }
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
        if (applying) advanceChecklist(event.job.progress);
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
      renderPlan();
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
    const payload = await applyTags(
      picks.map((proposal) => num(proposal.tagId))
    );
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

/* --- the cost layer: numbers that are never bare -------------------------- */

/**
 * "about 40 s", "about 4:30 min", "about 1:02:03 h" — a duration as a button
 * carries it. Pure on purpose.
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatRunTime(seconds) {
  const total = Math.max(0, num(seconds));
  if (total < 60) return `about ${Math.max(1, Math.round(total))} s`;
  if (total < 3600) return `about ${formatElapsed(total * 1000)} min`;
  return `about ${formatElapsed(total * 1000)} h`;
}

/**
 * The three parts of a token count as percentages of it. Pure on purpose: the
 * bar's widths are data, not theme, and the page has to be able to say they
 * add up to a hundred.
 *
 * @param {{prompt: number, answer: number, thinking: number}} split
 * @returns {{prompt: number, answer: number, thinking: number, total: number}}
 */
function tokenShares(split) {
  const prompt = Math.max(0, num(split && split.prompt));
  const answer = Math.max(0, num(split && split.answer));
  const thinking = Math.max(0, num(split && split.thinking));
  const total = prompt + answer + thinking;
  if (total <= 0) return { prompt: 0, answer: 0, thinking: 0, total: 0 };
  const share = (value) => Math.round((value / total) * 1000) / 10;
  return {
    prompt: share(prompt),
    answer: share(answer),
    thinking: share(thinking),
    total,
  };
}

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

/** The same count as one bar of three segments, or '' when there is none. */
function htmlTokenbar(split) {
  const shares = tokenShares(split);
  if (shares.total <= 0) return '';
  const key = (value, word) => `${formatTokens(value)} ${word}`;
  return `<div class="zr-tokenbar"><div class="zr-tokenbar__track"><span class="zr-tokenbar__seg zr-tokenbar__seg--prompt" style="width: ${num(shares.prompt)}%"></span><span class="zr-tokenbar__seg zr-tokenbar__seg--answer" style="width: ${num(shares.answer)}%"></span><span class="zr-tokenbar__seg zr-tokenbar__seg--thinking" style="width: ${num(shares.thinking)}%"></span></div><div class="zr-tokenbar__legend"><span class="zr-tokenbar__key"><span class="zr-tokenbar__dot zr-tokenbar__dot--prompt"></span>${esc(key(split.prompt, 'question'))}</span><span class="zr-tokenbar__key"><span class="zr-tokenbar__dot zr-tokenbar__dot--answer"></span>${esc(key(split.answer, 'answer'))}</span><span class="zr-tokenbar__key"><span class="zr-tokenbar__dot zr-tokenbar__dot--thinking"></span>${esc(key(split.thinking, 'thinking'))}</span></div></div>`;
}

/** The line above a button that says what pressing it writes. */
function htmlConsequence(text, free) {
  const htmlTone = free === true ? ' zr-consequence--free' : '';
  const htmlIcon = htmlIconMarkup(free === true ? 'i-check' : 'i-info');
  return `<p class="zr-consequence${htmlTone}">${htmlIcon}<span>${esc(text)}</span></p>`;
}

/* --- what a plan writes --------------------------------------------------- */

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

/** "9 documents", "1 document" — the unit most of these sentences need. */
function documentsText(count) {
  return `${num(count)} ${plural(count, 'document', 'documents')}`;
}

/**
 * What one proposal writes, in the sentence that stands above the button.
 * Pure on purpose: this is the only place the page promises writes.
 *
 * @param {object} proposal a TagSplitProposal
 * @returns {string}
 */
function consequenceText(proposal) {
  const totals = planWrites([proposal]);
  const name = String(
    proposal && proposal.tagName == null ? '' : proposal.tagName
  );
  const action = String((proposal && proposal.action) || 'split');
  const documents = num(proposal && proposal.documentCount);
  const writes = `${totals.writes} ${plural(totals.writes, 'write', 'writes')} to Paperless-ngx`;
  const tail =
    'No model is asked, and every write can be undone from the log on the Duplicates page.';
  if (action === 'keep') {
    return `Keeping ${name} writes nothing at all. No model is asked.`;
  }
  if (action === 'delete') {
    return `Deleting takes ${name} off ${documentsText(documents)} and removes the tag — ${writes}. ${tail}`;
  }
  if (action === 'merge') {
    const target = String(
      proposal.mergeInto == null ? 'the other tag' : proposal.mergeInto
    );
    return `Folding ${name} into ${target} moves ${documentsText(documents)} and deletes the old tag — ${writes}. ${tail}`;
  }
  const topics = Array.isArray(proposal.topicNames) ? proposal.topicNames : [];
  const parts = [];
  if (totals.typeSets > 0) {
    parts.push(`sets the type on ${documentsText(totals.typeSets)}`);
  }
  if (totals.topicSets > 0) {
    parts.push(
      `hangs ${topics.length} ${plural(topics.length, 'topic tag', 'topic tags')} on all ${documents}`
    );
  }
  parts.push('deletes the old tag');
  const what =
    parts.length > 1
      ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
      : parts[0];
  return `Splitting ${what} — ${writes}. ${tail}`;
}

/* --- the plan: four baskets of sentences ---------------------------------- */

/**
 * The proposals of the plan, sorted into the four baskets. A tag that stays as
 * it is lands in `keep` whatever proposed it; everything else is told apart by
 * who proposed it and how sure they were. Pure on purpose.
 *
 * @param {object[]} list proposals
 * @returns {{rule: object[], sure: object[], ask: object[], keep: object[]}}
 */
function planBaskets(list) {
  const baskets = { rule: [], sure: [], ask: [], keep: [] };
  (Array.isArray(list) ? list : []).forEach((proposal) => {
    const status = String((proposal && proposal.status) || 'open');
    if (status === 'applied' || status === 'skipped') return;
    const action = String((proposal && proposal.action) || 'split');
    if (action === 'keep') {
      baskets.keep.push(proposal);
      return;
    }
    const source = String(proposal.source || 'rule');
    if (source === 'model') {
      const sure = String(proposal.confidence || 'low') !== 'low';
      baskets[sure ? 'sure' : 'ask'].push(proposal);
      return;
    }
    baskets.rule.push(proposal);
  });
  return baskets;
}

/**
 * One proposal as a sentence, with the names in bold and the evidence behind
 * the dash. Pure on purpose: every line of the plan is built here.
 *
 * @param {object} proposal a TagSplitProposal
 * @returns {string} markup
 */
function htmlProposalSentence(proposal) {
  const name = String(
    proposal && proposal.tagName == null ? '' : proposal.tagName
  );
  const htmlName = `<strong>${esc(name)}</strong>`;
  const documents = num(proposal && proposal.documentCount);
  const action = String((proposal && proposal.action) || 'split');
  const keeps = num(proposal && proposal.documentsWithType);
  const evidence =
    keeps > 0 && proposal.overwriteType !== true && action === 'split'
      ? `${documentsText(documents)}, ${keeps} of them keep the type they already have`
      : documentsText(documents);
  const htmlAside = `<span class="zr-basket__aside">${esc(evidence)}</span>`;
  if (action === 'keep') {
    return `<p class="zr-basket__sentence">${htmlName} stays as it is — ${htmlAside}</p>`;
  }
  if (action === 'delete') {
    return `<p class="zr-basket__sentence">${htmlName} is taken off its documents and deleted — ${htmlAside}</p>`;
  }
  if (action === 'merge') {
    const htmlTarget = `<strong>${esc(proposal.mergeInto == null ? 'the other tag' : proposal.mergeInto)}</strong>`;
    return `<p class="zr-basket__sentence">${htmlName} is folded into ${htmlTarget} — ${htmlAside}</p>`;
  }
  const typeName = proposal.typeName == null ? '' : String(proposal.typeName);
  const topics = Array.isArray(proposal.topicNames) ? proposal.topicNames : [];
  const htmlTopics = topics
    .map((topic) => `<strong>${esc(topic)}</strong>`)
    .join(' and ');
  const htmlType = `<strong>${esc(typeName)}</strong>`;
  const topicWord = plural(topics.length, 'the topic', 'the topics');
  let htmlBecomes;
  if (typeName !== '' && topics.length > 0) {
    htmlBecomes = `becomes the type ${htmlType} plus ${esc(topicWord)} ${htmlTopics}`;
  } else if (typeName !== '') {
    htmlBecomes = `becomes the type ${htmlType}`;
  } else if (topics.length > 0) {
    htmlBecomes = `becomes ${esc(topicWord)} ${htmlTopics}`;
  } else {
    htmlBecomes = 'is taken apart';
  }
  return `<p class="zr-basket__sentence">${htmlName} ${htmlBecomes} — ${htmlAside}</p>`;
}

/**
 * The two or three answers the ask basket offers for one proposal. They are
 * the answers themselves, never "edit". Pure on purpose.
 *
 * @param {object} proposal a TagSplitProposal
 * @returns {Array<{answer: string, label: string}>}
 */
function askChoices(proposal) {
  const action = String((proposal && proposal.action) || 'split');
  const typeName =
    proposal && proposal.typeName == null ? '' : String(proposal.typeName);
  const topics = Array.isArray(proposal && proposal.topicNames)
    ? proposal.topicNames
    : [];
  const choices = [];
  if (action === 'merge') {
    const target = String(
      proposal.mergeInto == null ? 'the other tag' : proposal.mergeInto
    );
    choices.push({ answer: 'accept', label: `Fold it into ${target}` });
  } else if (action === 'delete') {
    choices.push({ answer: 'accept', label: 'Delete it' });
  } else {
    const parts = [];
    if (typeName !== '') parts.push(typeName);
    topics.forEach((topic) => parts.push(topic));
    choices.push({
      answer: 'accept',
      label: parts.length > 0 ? parts.join(' + ') : 'Take it apart',
    });
    if (typeName !== '' && topics.length > 0) {
      choices.push({
        answer: 'topics-only',
        label: `Only ${plural(topics.length, 'the topic', 'the topics')} ${topics.join(' and ')}`,
      });
    }
  }
  choices.push({ answer: 'keep', label: 'Leave it alone' });
  return choices;
}

/**
 * The question the ask basket puts for one proposal: the model's own reason
 * where it gave one, and the count either way. Pure on purpose.
 *
 * @param {object} proposal a TagSplitProposal
 * @returns {string}
 */
function askQuestion(proposal) {
  const documents = documentsText(num(proposal && proposal.documentCount));
  const reason = String(
    proposal && proposal.reason == null ? '' : proposal.reason
  ).trim();
  return reason === ''
    ? `${documents}. The model could not decide which of these it is.`
    : `${documents}. ${reason}`;
}
/**
 * One basket. `rule` opens on demand and says only how many it holds; `sure`
 * writes a sentence per proposal and caps at ten; `ask` writes a question with
 * its answers; `keep` is one quiet line. Pure on purpose.
 *
 * @param {string} kind one of BASKET_KINDS
 * @param {object[]} entries the proposals in it
 * @param {{open: boolean, full: boolean}} state what the user opened
 * @returns {string} markup, '' when the basket is empty
 */
function htmlBasket(kind, entries, state) {
  const list = Array.isArray(entries) ? entries : [];
  const open = Boolean(state && state.open);
  const full = Boolean(state && state.full);
  if (list.length === 0) return '';
  const count = list.length;
  const title = `${BASKET_TITLES[kind] || kind} — ${count} ${plural(count, 'tag', 'tags')}`;
  const mark = BASKET_MARKS[kind] || '';
  const htmlTone = mark === '' ? '' : ` ${esc(mark)}`;
  const htmlMark = `<span class="zr-basket__mark${htmlTone}">${htmlIconMarkup(BASKET_ICONS[kind] || 'i-info')}</span>`;
  const htmlToggle =
    kind === 'rule' || kind === 'keep'
      ? `<button class="zr-btn zr-btn--ghost sim-basket-toggle" type="button" data-basket="${esc(kind)}">${esc(open ? 'Hide them' : 'Show them')}</button>`
      : '';
  const htmlWalk =
    kind === 'ask'
      ? `<button class="zr-btn sim-stack-open" type="button">${esc('One at a time')}</button>`
      : '';
  const htmlHead = `<div class="zr-basket__head">${htmlMark}<span class="zr-basket__titles"><span class="zr-basket__title">${esc(title)}</span><span class="zr-basket__note">${esc(BASKET_NOTES[kind] || '')}</span></span>${htmlWalk}${htmlToggle}</div>`;

  let htmlBody;
  if (kind === 'ask') {
    htmlBody = list
      .map((proposal) => {
        const htmlChoices = askChoices(proposal)
          .map((choice, at) => {
            const htmlFirst = at === 0 ? ' zr-btn--primary' : '';
            return `<button class="zr-btn${htmlFirst} sim-ask-choice" type="button" data-tag-id="${num(proposal.tagId)}" data-answer="${esc(choice.answer)}">${esc(choice.label)}</button>`;
          })
          .join('');
        const htmlName = `<strong>${esc(proposal.tagName == null ? '' : proposal.tagName)}</strong>`;
        const htmlAsk = `<span class="zr-basket__aside">${esc(askQuestion(proposal))}</span>`;
        return `<div class="zr-basket__question"><p class="zr-basket__sentence">${htmlName} — ${htmlAsk}</p><div class="zr-basket__choices">${htmlChoices}</div></div>`;
      })
      .join('');
  } else if (kind === 'keep') {
    const documents = list.reduce(
      (sum, proposal) => sum + num(proposal.documentCount),
      0
    );
    const htmlQuiet = open
      ? list
          .map(
            (proposal) =>
              `<div class="zr-basket__line">${htmlProposalSentence(proposal)}</div>`
          )
          .join('')
      : '';
    htmlBody = `<p class="zr-basket__sentence sim-basket__quiet">${esc(`${count} ${plural(count, 'tag', 'tags')} on ${documentsText(documents)} stay exactly as they are. Nothing is written for them.`)}</p>${htmlQuiet}`;
  } else if (kind === 'rule' && !open) {
    const documents = list.reduce(
      (sum, proposal) => sum + num(proposal.documentCount),
      0
    );
    htmlBody = `<p class="zr-basket__sentence sim-basket__quiet">${esc(`${count} compound ${plural(count, 'tag', 'tags')} on ${documentsText(documents)}, every one of them taken apart by a rule you can read.`)}</p>`;
  } else {
    const shown = kind === 'sure' && !full ? list.slice(0, BASKET_LINES) : list;
    const htmlLines = shown
      .map(
        (proposal) =>
          `<div class="zr-basket__line">${htmlProposalSentence(proposal)}<button class="zr-btn zr-btn--ghost sim-basket-drop" type="button" data-tag-id="${num(proposal.tagId)}">${esc('Not this one')}</button></div>`
      )
      .join('');
    const rest = list.length - shown.length;
    const htmlMore =
      rest > 0
        ? `<div class="zr-basket__line"><button class="zr-btn zr-btn--ghost sim-basket-more" type="button" data-basket="${esc(kind)}">${esc(`Read the other ${rest}`)}</button></div>`
        : '';
    htmlBody = `${htmlLines}${htmlMore}`;
  }
  const htmlVariant =
    kind === 'ask'
      ? ' zr-basket--ask'
      : kind === 'keep'
        ? ' zr-basket--quiet'
        : '';
  return `<section class="zr-basket${htmlVariant} sim-basket" data-basket="${esc(kind)}">${htmlHead}<div class="zr-basket__body">${htmlBody}</div></section>`;
}

/**
 * The one sentence over the baskets. Pure on purpose.
 *
 * @param {object} baskets planBaskets()
 * @returns {string}
 */
function planHeadline(baskets) {
  const rule = baskets.rule.length;
  const sure = baskets.sure.length;
  const ask = baskets.ask.length;
  const keep = baskets.keep.length;
  const total = rule + sure + ask + keep;
  if (total === 0) return '';
  const agreed = rule + sure;
  const parts = [
    `${agreed} ${plural(agreed, 'tag is', 'tags are')} clear`,
    `${ask} ${plural(ask, 'needs', 'need')} a word from you`,
    `${keep} ${plural(keep, 'stays as it is', 'stay as they are')}`,
  ];
  return `I read ${total} ${plural(total, 'tag', 'tags')}: ${parts.join(', ')}.`;
}

/**
 * The header card of the plan: the sentence, what the proposal cost, what
 * running it will cost, and the one button that runs it. Pure on purpose.
 *
 * @param {object} baskets planBaskets()
 * @param {?object} cost what the last run cost, or null
 * @param {object} totals planWrites() over what is agreed
 * @param {number} seconds how long an apply is expected to take
 * @returns {string} markup
 */
function htmlPlanHead(baskets, cost, totals, seconds) {
  const headline = planHeadline(baskets);
  if (headline === '') return '';
  const htmlAsked =
    cost === null
      ? `<p class="zr-sm zr-faint">${esc('This plan was read off the stored proposals; what the run that produced it cost is not recorded.')}</p>`
      : `${htmlLedger([
          { value: String(num(cost.requests)), unit: 'requests' },
          { value: formatTokens(cost.tokens), unit: 'tokens' },
          { value: formatElapsed(num(cost.ms)), unit: 'minutes' },
          { value: '0', unit: 'writes', quiet: true },
        ])}${htmlTokenbar(tokenSplit(cost))}`;
  const agreed = totals.tags;
  const htmlRun = htmlLedger([
    { value: String(totals.writes), unit: 'writes' },
    { value: '0', unit: 'tokens', quiet: true },
    { value: formatRunTime(seconds), unit: '' },
  ]);
  const sub = `${totals.writes} ${plural(totals.writes, 'write', 'writes')} on ${documentsText(totals.documents)} · no tokens · ${formatRunTime(seconds)}`;
  const htmlDisabled = agreed === 0 ? ' disabled' : '';
  const htmlButton = `<button class="zr-btn zr-btn--primary zr-btn--stacked sim-plan__run" id="simRunAgreedBtn" type="button"${htmlDisabled}>${esc(`Run the ${agreed} agreed ${plural(agreed, 'one', 'ones')}`)}<span class="zr-btn__sub">${esc(sub)}</span></button>`;
  const htmlWalk =
    baskets.ask.length > 0
      ? `<button class="zr-btn zr-btn--stacked sim-stack-open" type="button">${esc(`Walk me through the ${baskets.ask.length}`)}<span class="zr-btn__sub">${esc('no model, no writing')}</span></button>`
      : '';
  return `<p class="sim-plan__headline">${esc(headline)}</p><div class="sim-plan__ledgers"><div class="sim-plan__ledger"><span class="zr-label">${esc('What this proposal cost')}</span>${htmlAsked}</div><div class="sim-plan__ledger"><span class="zr-label">${esc('What running it costs')}</span>${htmlRun}</div></div><div class="sim-plan__actions">${htmlButton}${htmlWalk}</div>`;
}

/** Everything the plan agrees on: the rule basket plus what the model was sure of. */
function agreedProposals() {
  const baskets = planBaskets([...proposals.values()]);
  return [...baskets.rule, ...baskets.sure];
}

/** The plan, drawn from the proposals the page already has. */
function renderPlan() {
  if (!el.baskets) return;
  const baskets = planBaskets([...proposals.values()]);
  el.baskets.innerHTML = BASKET_KINDS.map((kind) =>
    htmlBasket(kind, baskets[kind], {
      open: basketsOpen.has(kind),
      full: basketsFull.has(kind),
    })
  ).join('');
  if (el.planHead) {
    const totals = planWrites(agreedProposals());
    el.planHead.innerHTML = htmlPlanHead(
      baskets,
      lastRunCost,
      totals,
      applySeconds(totals)
    );
    el.planHead.classList.toggle('hidden', el.planHead.innerHTML === '');
  }
}

/** A write to Paperless-ngx is a round trip; this is what the page promises. */
function applySeconds(totals) {
  return Math.ceil(num(totals && totals.writes) * APPLY_SECONDS_PER_WRITE);
}
/* --- the stack: one decision per screen ----------------------------------- */

/**
 * The bar over the stack: where it is, how far, how much is left, and the one
 * way out of it that is not a decision. Pure on purpose.
 *
 * @param {number} at zero-based position in the queue
 * @param {number} total how long the queue is
 * @param {number} clear how many tags the plan already agrees on
 * @returns {string} markup
 */
function htmlStackBar(at, total, clear) {
  const size = Math.max(0, num(total));
  const position = Math.min(size, num(at) + 1);
  const left = Math.max(0, size - num(at));
  const percent = size === 0 ? 100 : Math.round((num(at) / size) * 100);
  const htmlSkip =
    num(clear) > 0
      ? `<button class="zr-btn zr-btn--ghost sim-stack-runclear" type="button">${esc(`Take the ${num(clear)} clear ones in one go`)}</button>`
      : '';
  return `<div class="zr-runbar"><span class="zr-runbar__position">${esc(`Tag ${position} of ${size}`)}</span><div class="zr-runbar__track"><div class="zr-runbar__fill" style="width: ${num(percent)}%"></div></div><span class="zr-runbar__rest">${esc(`${left} left`)}</span>${htmlSkip}</div>`;
}

/**
 * The card of one decision: the tag on the left, what it would become on the
 * right, the model's sentence, the evidence with the overwrite choice, the
 * consequence and the three buttons. Pure on purpose.
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
  const htmlBadges = `<span class="zr-badge">${esc(GROUP_KIND_LABELS[action] || action)}</span>${htmlSourceBadge(proposal)}`;
  const htmlFrom = `<div class="zr-decision__side zr-decision__side--from"><div class="zr-decision__label">${esc('AS IT IS')}</div><div class="zr-decision__name zr-decision__name--from">${esc(name)}</div><div class="zr-decision__meta">${esc(documentsText(documents))}</div></div>`;

  let htmlTo;
  if (action === 'merge') {
    const target = String(
      proposal.mergeInto == null ? 'the other tag' : proposal.mergeInto
    );
    htmlTo = `<div class="zr-decision__side"><div class="zr-decision__label">${esc('BECOMES')}</div><div class="zr-decision__name">${esc(target)}</div><div class="zr-decision__meta">${esc('the documents move, the old tag goes')}</div></div>`;
  } else if (action === 'delete') {
    htmlTo = `<div class="zr-decision__side"><div class="zr-decision__label">${esc('BECOMES')}</div><div class="zr-decision__name">${esc('nothing')}</div><div class="zr-decision__meta">${esc('the tag is taken off its documents and deleted')}</div></div>`;
  } else {
    htmlTo = `<div class="zr-decision__side"><div class="zr-decision__label">${esc('BECOMES')}</div><div class="sim-decision__field"><span class="zr-label">${esc('Document type')}</span>${htmlTypeSelect(proposal, types)}</div><div class="sim-decision__field"><span class="zr-label">${esc('Topics')}</span>${htmlTopicChips(proposal)}</div></div>`;
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
      typeName === ''
        ? 'Overwrite whatever is there'
        : `Overwrite it with ${typeName}`;
    const leave =
      keeps > 0
        ? `Leave the type on ${keeps} ${plural(keeps, 'document', 'documents')}`
        : 'Only where there is no type yet';
    const evidence =
      keeps > 0
        ? `${keeps} of these ${documents} documents already carry a document type.`
        : `None of these ${documents} documents carries a document type yet.`;
    htmlEvidence = `<div class="sim-decision__evidence"><p class="zr-sm">${esc(evidence)}</p><label class="sim-decision__radio"><input type="radio" class="sim-stack-overwrite" name="simStackOverwrite" value="keep"${htmlKeepChecked}><span class="zr-sm">${esc(leave)}</span></label><label class="sim-decision__radio"><input type="radio" class="sim-stack-overwrite" name="simStackOverwrite" value="overwrite"${htmlOverChecked}><span class="zr-sm">${esc(over)}</span></label></div>`;
  }

  const primary =
    action === 'merge'
      ? `Fold it into ${proposal.mergeInto == null ? 'the other tag' : proposal.mergeInto}`
      : action === 'delete'
        ? 'Delete it'
        : 'Split it';
  const htmlActions = `<div class="zr-decision__actions"><button class="zr-btn zr-btn--primary zr-btn--stacked sim-stack-accept" type="button" data-tag-id="${num(proposal.tagId)}">${esc(primary)}<span class="zr-btn__sub">${esc('agreed now, written when you run the plan')}</span></button><button class="zr-btn sim-stack-keep" type="button" data-tag-id="${num(proposal.tagId)}">${esc('Keep the tag')}</button><button class="zr-btn zr-btn--ghost sim-stack-later" type="button" data-tag-id="${num(proposal.tagId)}">${esc('Decide later')}</button><span class="zr-decision__keys">${esc('Enter · Esc · L')}</span></div>`;

  return `<div class="zr-decision" data-tag-id="${num(proposal.tagId)}"><div class="zr-decision__head">${htmlBadges}</div><div class="zr-decision__sides">${htmlFrom}<div class="zr-decision__arrow">${htmlIconMarkup('i-arrow-right')}</div>${htmlTo}</div>${htmlNote}${htmlEvidence}${htmlConsequence(consequenceText(proposal), false)}${htmlActions}</div>`;
}

/**
 * The line under the stack: how many were decided and what the last one was.
 * Pure on purpose.
 *
 * @param {number} decided how many decisions the stack has taken
 * @param {?object} undo the last one, `{ tagName, word }`, or null
 * @returns {string} markup
 */
function htmlStackFoot(decided, undo) {
  const count = num(decided);
  const tally = `${count} ${plural(count, 'decision', 'decisions')} so far. Nothing is written until you run the plan.`;
  const htmlUndo =
    undo === null
      ? ''
      : `<button class="zr-btn zr-btn--ghost sim-stack-undo" type="button">${esc(`Undo — ${String(undo.tagName)} was ${String(undo.word)}`)}</button>`;
  return `<p class="zr-sm zr-faint sim-stack__tally">${esc(tally)}</p>${htmlUndo}<button class="zr-btn zr-btn--ghost sim-stack-close" type="button">${esc('Back to the plan')}</button>`;
}

/** The proposals the stack still has to ask about, in the queue's order. */
function stackProposals() {
  return stackQueue
    .map((tagId) => proposals.get(num(tagId)))
    .filter((proposal) => proposal !== undefined);
}

/** The stack, or the plan again once the queue has run out. */
function renderStack() {
  if (!el.stack || el.stack.classList.contains('hidden')) return;
  const queue = stackProposals();
  const clear = planWrites(agreedProposals()).tags;
  if (el.stackBar) {
    el.stackBar.innerHTML = htmlStackBar(stackAt, queue.length, clear);
  }
  const proposal = queue[stackAt];
  if (!proposal) {
    if (el.stackCard) {
      el.stackCard.innerHTML = `<div class="zr-empty">${esc('Every one of them is answered. Back to the plan.')}</div>`;
    }
  } else if (el.stackCard) {
    el.stackCard.innerHTML = htmlDecision(proposal, vocabulary.types);
  }
  if (el.stackFoot) {
    el.stackFoot.innerHTML = htmlStackFoot(stackDecided, stackUndo);
  }
}

/** Opens the stack over the plan; it is a mode, not a page. */
function openStack() {
  if (!el.stack) return;
  stackQueue = planBaskets([...proposals.values()]).ask.map((proposal) =>
    num(proposal.tagId)
  );
  stackAt = 0;
  stackDecided = 0;
  stackUndo = null;
  el.stack.classList.remove('hidden');
  if (el.plan) el.plan.classList.add('hidden');
  // The segment still decides whether any of this is on screen at all.
  renderViewState();
  renderStack();
  el.stack.focus();
}

function closeStack() {
  if (!el.stack) return;
  el.stack.classList.add('hidden');
  stackQueue = [];
  stackAt = 0;
  stackUndo = null;
  renderViewState();
  renderPlan();
}

/**
 * One decision of the stack. Nothing here reaches Paperless-ngx: 'accept' and
 * 'keep' write the proposal's own status, 'later' only moves the queue on.
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
    word: decision === 'keep' ? 'kept' : 'agreed',
    before: {
      action: String(proposal.action || 'split'),
      status: String(proposal.status || 'open'),
    },
  };
  const patch =
    decision === 'keep'
      ? { action: 'keep', status: 'accepted' }
      : { status: 'accepted' };
  await patchProposal(tagId, patch);
  stackDecided += 1;
  stackQueue = stackQueue.filter((id) => id !== tagId);
  if (stackAt >= stackQueue.length)
    stackAt = Math.max(0, stackQueue.length - 1);
  renderStack();
  if (el.stack) el.stack.focus();
}

/** Puts the last decision back the way it was. */
async function undoLastDecision() {
  if (stackUndo === null) return;
  const { tagId, before } = stackUndo;
  stackUndo = null;
  await patchProposal(tagId, before);
  if (!stackQueue.includes(tagId)) stackQueue.splice(stackAt, 0, tagId);
  stackDecided = Math.max(0, stackDecided - 1);
  renderStack();
  if (el.stack) el.stack.focus();
}

/**
 * One answer straight out of the ask basket. The same three decisions the
 * stack takes, without opening it.
 *
 * @param {number} tagId
 * @param {string} answer 'accept' | 'topics-only' | 'keep'
 */
async function answerFromBasket(tagId, answer) {
  const proposal = proposals.get(num(tagId));
  if (!proposal) return;
  if (answer === 'keep') {
    await patchProposal(num(tagId), { action: 'keep', status: 'accepted' });
    return;
  }
  if (answer === 'topics-only') {
    await patchProposal(num(tagId), { typeName: null, status: 'accepted' });
    return;
  }
  await patchProposal(num(tagId), { status: 'accepted' });
}
/* --- the cost layer, before a run ----------------------------------------- */

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
  };
}

/**
 * The seam. `GET /api/simplify/order/estimate` is being built elsewhere; until
 * it answers, the same numbers are worked out here from what the page already
 * knows, with the same arithmetic services/aiRunEstimate.js uses and `basis`
 * reported as the guess it is. Nothing else in this file knows the difference.
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
    minDocuments: String(runLevers.minDocuments),
  });
  try {
    const payload = await requestJson(`${ESTIMATE_URL}?${query.toString()}`);
    const answer = normaliseEstimate(payload.data || {});
    // A build whose route answers without numbers is the same as one without
    // the route at all — a dialog of zeroes would be worse than a guess.
    if (answer.tags > 0 || answer.items > 0) return answer;
  } catch {
    // The route is not on this build yet.
  }
  // Either way the stub answers, and says so through basis === 'guess'.
  return normaliseEstimate(await localOrderEstimate());
}

/**
 * Where the numbers come from, said out loud. A guess is named a guess. Pure
 * on purpose.
 *
 * @param {object} estimate normaliseEstimate()
 * @returns {string}
 */
function basisText(estimate) {
  const model = estimate.model === '' ? 'the model' : estimate.model;
  if (estimate.basis === 'run') {
    const last = estimate.lastRun || {};
    const requests = num(last.requests);
    return `These are the per-request averages of the last run of this task on ${model}: ${requests} ${plural(requests, 'request', 'requests')}, ${formatRunTime(num(last.seconds))}.`;
  }
  if (estimate.basis === 'model') {
    return `These come from what was measured on ${model} itself, not from a run of this task — the shape of the question can still move them.`;
  }
  return `Nothing has been measured yet, so this is a round guess. It can be out by a factor; the first run is what makes the next estimate honest.`;
}

/**
 * The four numbered steps, each with its own price. Pure on purpose.
 *
 * @param {object} estimate normaliseEstimate()
 * @returns {string} markup
 */
function htmlPreflightSteps(estimate) {
  const steps = [
    {
      what: `Read your ${grouped(estimate.tags)} ${plural(estimate.tags, 'tag', 'tags')} and every document type`,
      price: 'no model',
    },
    {
      what: `Take apart what a rule already covers — ${grouped(estimate.itemsByRule)} of them`,
      price: 'no model',
    },
    {
      what: `Ask about the other ${grouped(estimate.items)}, ${estimate.batchSize} per request`,
      price: `${estimate.requests} ${plural(estimate.requests, 'request', 'requests')} · ${formatTokens(estimate.tokens.total)} tokens`,
    },
    {
      what: 'Fold the answers into one plan and store it',
      price: 'free',
    },
  ];
  const htmlItems = steps
    .map(
      (step) =>
        `<li class="sim-preflight__step"><span class="sim-preflight__what">${esc(step.what)}</span><span class="sim-preflight__price">${esc(step.price)}</span></li>`
    )
    .join('');
  return `<ol class="sim-preflight__steps">${htmlItems}</ol>`;
}

/** The levers, in the state `runLevers` has them. Pure on purpose. */
function htmlPreflightLevers(estimate) {
  const htmlDecided = runLevers.skipDecided === true ? ' checked' : '';
  const htmlLow = runLevers.minDocuments > 1 ? ' checked' : '';
  const htmlLanes = LANE_CHOICES.map((lanes) => {
    const htmlSelected = lanes === runLevers.lanes ? ' selected' : '';
    return `<option value="${num(lanes)}"${htmlSelected}>${num(lanes)}</option>`;
  }).join('');
  const decided = `Skip the ${grouped(estimate.skippable.decided)} ${plural(estimate.skippable.decided, 'tag', 'tags')} you have already decided`;
  const low = `Only tags on at least ${MIN_DOCUMENTS_LEVER} documents — leaves out ${grouped(estimate.skippable.lowDocument)}`;
  return `<div class="sim-preflight__levers"><label class="sim-preflight__lever"><input type="checkbox" class="zr-check sim-lever" data-lever="skipDecided"${htmlDecided}><span class="zr-sm">${esc(decided)}</span></label><label class="sim-preflight__lever"><input type="checkbox" class="zr-check sim-lever" data-lever="minDocuments"${htmlLow}><span class="zr-sm">${esc(low)}</span></label><label class="sim-preflight__lever"><span class="zr-sm">${esc('Requests in flight at once')}</span><select class="zr-select sim-lever" data-lever="lanes" aria-label="Requests in flight at once">${htmlLanes}</select></label></div>`;
}

/**
 * The whole preflight body: what it does, what it costs, what it changes, and
 * the levers that make it cheaper. Pure on purpose.
 *
 * @param {object} estimate normaliseEstimate()
 * @returns {string} markup
 */
function htmlPreflight(estimate) {
  const htmlCost = `${htmlLedger([
    { value: String(estimate.requests), unit: 'requests' },
    { value: formatTokens(estimate.tokens.total), unit: 'tokens' },
    { value: formatRunTime(estimate.seconds), unit: '' },
    { value: '0', unit: 'writes', quiet: true },
  ])}${htmlTokenbar(tokenSplit(estimate.tokens))}<p class="zr-sm zr-faint sim-preflight__basis">${esc(basisText(estimate))}</p>`;
  return `<div class="sim-preflight"><section class="sim-preflight__block"><span class="zr-label">${esc('What I actually do')}</span>${htmlPreflightSteps(estimate)}</section><section class="sim-preflight__block"><span class="zr-label">${esc('What it costs')}</span>${htmlCost}</section><section class="sim-preflight__block"><span class="zr-label">${esc('What it changes')}</span>${htmlConsequence('Nothing is written while this runs. The plan is a proposal until you run it.', true)}</section><section class="sim-preflight__block"><span class="zr-label">${esc('Cheaper, if you want')}</span>${htmlPreflightLevers(estimate)}</section></div>`;
}

/** What the primary button of the dialog says once the numbers are in. */
function preflightConfirmText(estimate) {
  return `Start — ${estimate.requests} ${plural(estimate.requests, 'request', 'requests')}, ${formatRunTime(estimate.seconds)}`;
}

/** The same, with the token count on the second line. */
function htmlPreflightConfirm(estimate) {
  const sub = `${formatTokens(estimate.tokens.total)} tokens · ${estimate.lanes} ${plural(estimate.lanes, 'lane', 'lanes')} · 0 writes`;
  return `${esc(preflightConfirmText(estimate))}<span class="zr-btn__sub">${esc(sub)}</span>`;
}

/**
 * Opens the preflight and keeps its numbers in step with its levers. The
 * dialog is the kernel's; this only fills it and listens on it.
 *
 * @param {boolean} keepVocabulary whether the run keeps the saved vocabulary
 * @returns {Promise<boolean>} true when the run was started
 */
async function askPreflight(keepVocabulary) {
  let estimate = await fetchOrderEstimate(keepVocabulary);
  const answer = confirmDialog({
    title: 'Propose a new order',
    html: htmlPreflight(estimate),
    confirmLabel: preflightConfirmText(estimate),
    cancelLabel: 'Not now',
  });
  const dialog = document.querySelector('dialog.zr-dialog[open]');
  if (dialog) {
    const body = dialog.querySelector('.zr-dialog__body');
    const confirm = dialog.querySelector('[value="ok"]');
    const draw = () => {
      if (body) body.innerHTML = htmlPreflight(estimate);
      if (confirm) {
        confirm.classList.add('zr-btn--stacked');
        confirm.innerHTML = htmlPreflightConfirm(estimate);
      }
    };
    draw();
    // Delegated, so a redraw of the body does not lose the listener.
    dialog.addEventListener('change', async (event) => {
      const field = event.target.closest('.sim-lever');
      if (!field) return;
      const lever = field.dataset.lever;
      if (lever === 'skipDecided') runLevers.skipDecided = field.checked;
      if (lever === 'minDocuments') {
        runLevers.minDocuments = field.checked ? MIN_DOCUMENTS_LEVER : 1;
      }
      if (lever === 'lanes') runLevers.lanes = Math.max(1, num(field.value));
      estimate = await fetchOrderEstimate(keepVocabulary);
      draw();
    });
  }
  return answer;
}
/* --- the cost layer, while a run costs something -------------------------- */

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
  const rest = formatEta(state.etaMs) || 'time unknown so far';
  const htmlFill =
    percent === null
      ? '<div class="zr-runbar__fill sim-progress__fill--indeterminate"></div>'
      : `<div class="zr-runbar__fill" style="width: ${num(percent)}%"></div>`;
  return `<div class="zr-runbar"><span class="zr-runbar__position">${esc(position)}</span><div class="zr-runbar__track">${htmlFill}</div><span class="zr-runbar__rest">${esc(rest)}</span></div>`;
}

/** Tokens so far against the estimate, and the rate. Pure on purpose. */
function htmlRunLedger(progress) {
  const state = progress || {};
  const spent = num(state.tokens);
  const planned = num(state.estimatedTokens);
  const elapsed = Math.max(1, num(state.elapsedMs)) / 1000;
  const rate = Math.round(spent / elapsed);
  const items = [
    {
      value:
        planned > 0
          ? `${formatTokens(spent)} of ${formatTokens(planned)}`
          : formatTokens(spent),
      unit: 'tokens',
    },
    { value: `${grouped(rate)}/s`, unit: '' },
    { value: formatElapsed(num(state.elapsedMs)), unit: 'elapsed' },
    { value: '0', unit: 'writes', quiet: true },
  ];
  return htmlLedger(items);
}

/** The request being answered right now, against its ceiling. Pure on purpose. */
function htmlLiveRequest(progress) {
  const state = progress || {};
  const running = num(state.requestTokens);
  if (running <= 0) return '';
  const budget = num(state.tokenBudget);
  const answers = num(state.requestAnswers);
  const items = num(state.requestPairs);
  const where =
    items > 0 ? `${answers} of ${items} answered` : `${answers} answered`;
  const against =
    budget > 0
      ? `${formatTokens(running)} of the ${formatTokens(budget)} this run may spend`
      : `${formatTokens(running)} so far`;
  const thinking = state.thinking === true ? ', still thinking' : '';
  return `<p class="zr-sm zr-faint sim-meter__live">${esc(`This request: ${against} · ${where}${thinking}`)}</p>`;
}

/**
 * What one finished request did, in a sentence. `empty` and `failed` are the
 * two that are worth reading. Pure on purpose.
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
    const thought = formatTokens(entry.thinkingTokens);
    return `Request ${index} — thought for ${thought} tokens and answered nothing`;
  }
  if (outcome === 'failed') {
    return `Request ${index} — ${asked}, and the provider ended it`;
  }
  if (outcome === 'partial') {
    return `Request ${index} — ${asked}, ${answers} answered, the rest asked again`;
  }
  return `Request ${index} — ${asked}, ${answers} answered`;
}

/** What that request cost, as the row's right-hand column. Pure on purpose. */
function reqlogCost(record) {
  const entry = record || {};
  const tokens = num(entry.tokens);
  const thinking = num(entry.thinkingTokens);
  if (tokens <= 0) return 'no tokens reported';
  if (thinking <= 0) return `${formatTokens(tokens)} tokens`;
  if (thinking >= tokens) return `${formatTokens(tokens)}, all thinking`;
  return `${formatTokens(tokens)} · ${formatTokens(thinking)} of it thinking`;
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

/** What stopping keeps, on the Stop button's second line. Pure on purpose. */
function stopSubText(progress) {
  const state = progress || {};
  const done = num(state.requestsDone);
  if (done <= 0) {
    return 'Nothing has come back yet; stopping costs you the tokens already spent.';
  }
  return `Keeps the ${done} ${plural(done, 'request', 'requests')} that already came back; the tags they covered stay in the plan.`;
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
  if (el.runLive) el.runLive.innerHTML = htmlLiveRequest(state);
  if (el.reqLog) el.reqLog.innerHTML = htmlReqLog(state.requestLog);
  if (el.stopSub) el.stopSub.textContent = stopSubText(state);
}

/** What a finished model run cost, kept for the plan's first ledger. */
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

/* --- the cost layer, afterwards: the apply as a checklist ------------------ */

/**
 * One row per accepted tag, in the order the apply will take them.
 *
 * @param {object[]} list the accepted proposals
 * @returns {Array<object>}
 */
function checklistFrom(list) {
  return (Array.isArray(list) ? list : []).map((proposal) => ({
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
  const head = `${done} of ${list.length} done${failed > 0 ? `, ${failed} failed` : ''} · ${writes} ${plural(writes, 'write', 'writes')}`;
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
      const what = warn
        ? `${row.tagName} — ${row.error}; its ${row.writes} ${plural(row.writes, 'write', 'writes')} are still to do`
        : `${row.tagName} — ${row.writes} ${plural(row.writes, 'write', 'writes')}`;
      const when =
        state === 'done'
          ? formatElapsed(num(row.seconds) * 1000)
          : state === 'running'
            ? 'running'
            : state === 'failed'
              ? 'failed'
              : 'waiting';
      const htmlRetry = warn
        ? `<button class="zr-btn zr-btn--ghost sim-checklist-retry" type="button" data-tag-id="${num(row.tagId)}">${esc('Try it now')}</button>`
        : '';
      return `<div class="zr-reqlog__row${htmlClass}">${htmlMark}<span class="zr-reqlog__what">${esc(what)}</span>${htmlRetry}<span class="zr-reqlog__state">${esc(when)}</span></div>`;
    })
    .join('');
  return `<div class="sim-checklist__head"><span class="zr-label">${esc(head)}</span><span class="zr-sm zr-faint">${esc('0 tokens — this step never asks the model')}</span></div><div class="zr-reqlog">${htmlRows}</div>`;
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

/**
 * Runs everything the plan agrees on: the rule basket and what the model was
 * sure of. They are marked accepted first — that is a local write — and the
 * one apply job then does the writing to Paperless-ngx.
 */
async function runAgreed() {
  const agreed = agreedProposals().filter(
    (proposal) => String(proposal.status || 'open') !== 'accepted'
  );
  const totals = planWrites(agreedProposals());
  if (totals.tags === 0) return;
  const confirmed = await confirmDialog({
    title: 'Run the agreed part of the plan',
    body: `${totals.tags} ${plural(totals.tags, 'tag', 'tags')}: ${consequenceSummary(totals)}`,
    confirmLabel: 'Run it',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;
  for (let at = 0; at < agreed.length; at += 1) {
    setApplyStatus(`Agreeing, ${at + 1} of ${agreed.length}…`);
    await patchProposal(num(agreed[at].tagId), { status: 'accepted' });
  }
  setApplyStatus('');
  await applyOrder(null);
}

/**
 * What running a whole plan writes, in one sentence. Pure on purpose.
 *
 * @param {object} totals planWrites()
 * @returns {string}
 */
function consequenceSummary(totals) {
  const writes = num(totals && totals.writes);
  const documents = num(totals && totals.documents);
  const deletions = num(totals && totals.deletions);
  return `${writes} ${plural(writes, 'write', 'writes')} over ${documentsText(documents)}, ${deletions} ${plural(deletions, 'tag', 'tags')} deleted. No model is asked, and every write can be undone from the log on the Duplicates page.`;
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
  if (el.groupsBlock) {
    el.groupsBlock.addEventListener('toggle', () => {
      renderOrderEmpty(visibleGroups().length);
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

/** The plan, the stack and the checklist: one delegated listener each. */
function initPlan() {
  if (el.baskets) {
    el.baskets.addEventListener('click', (event) => {
      const toggle = event.target.closest('.sim-basket-toggle');
      if (toggle) {
        const kind = String(toggle.dataset.basket);
        if (basketsOpen.has(kind)) basketsOpen.delete(kind);
        else basketsOpen.add(kind);
        renderPlan();
        return;
      }
      const more = event.target.closest('.sim-basket-more');
      if (more) {
        basketsFull.add(String(more.dataset.basket));
        renderPlan();
        return;
      }
      if (event.target.closest('.sim-stack-open')) {
        openStack();
        return;
      }
      const drop = event.target.closest('.sim-basket-drop');
      if (drop) {
        patchProposal(num(drop.dataset.tagId), { status: 'skipped' });
        return;
      }
      const choice = event.target.closest('.sim-ask-choice');
      if (choice) {
        answerFromBasket(num(choice.dataset.tagId), choice.dataset.answer);
      }
    });
  }

  if (el.planHead) {
    el.planHead.addEventListener('click', (event) => {
      if (event.target.closest('.sim-stack-open')) {
        openStack();
        return;
      }
      if (event.target.closest('.sim-plan__run')) runAgreed();
    });
  }

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
    if (event.target.closest('.sim-stack-runclear')) {
      closeStack();
      runAgreed();
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
  initVocabulary();
  initOrder();
  initPlan();
  initProposals();
  setView('groups');
  await loadVocabulary();
  await loadDocumentTypes();
  await loadGroups();
  await loadProposals();
  renderPlan();
  await reattachJob();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
