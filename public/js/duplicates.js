/**
 * Duplicates page: tags and correspondents that mean the same thing, and the
 * merges that fold them into one name in Paperless-ngx.
 *
 * The page has two modes (js/modules/review-mode.js). Simple opens on one
 * button: it scans both kinds at the default sensitivity and asks the model
 * about what the spelling could not settle, then shows one head with the
 * button that merges and three checklists whose ticks move its numbers.
 * Advanced is the whole toolset: the scan row, merge by hand, every group as
 * a card, the log, the mapped names and the hidden pairs. The run meter, the
 * stack of one pair per screen and the apply progress belong to both.
 *
 * Asking the model costs tokens and opens the sheet first
 * (js/modules/review-sheet.js); merging costs writes and asks once. Every
 * merge is logged and can be undone from the log.
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
import { createPicker } from '/js/modules/picker.js';
import {
  htmlSheet,
  updateSheet,
  bindSheet,
  formatTokens,
  roughTime,
} from '/js/modules/review-sheet.js';
import {
  applyMode,
  htmlModeButton,
  mountModeSwitch,
} from '/js/modules/review-mode.js';

/* --- interpolation helpers ------------------------------------------------ */

/** Anything that reaches an attribute or cell as a number, never as text. */
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A score between 0 and 1 as whole percent. */
function pct(score) {
  return Math.round(num(score) * 100);
}

/** A whole number the way the page writes it: "2,340". */
function count(value) {
  return Math.round(num(value)).toLocaleString('en-US');
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
  // A pair the model's synonym sweep proposed; the string matcher saw nothing.
  semantic: 'Semantic',
};

/**
 * What the model says about a pair or a group. The three verdicts are the
 * contract (services/entityMatchAiService.js); the labels belong to this page.
 */
const AI_VERDICT_LABELS = {
  same: 'Model: same',
  different: 'Model: different',
  unsure: 'Model: unsure',
};

const AI_VERDICT_TONES = {
  same: 'dup-verdict--same',
  different: 'dup-verdict--different',
  unsure: 'dup-verdict--unsure',
};

/**
 * The rule the model says it applied. The values are contract (AiVerdict.basis
 * in schemas.js); the short labels are this page's. An answer may carry none,
 * and a value this page does not know yet is shown as it came.
 */
const AI_BASIS_LABELS = {
  'case-or-spacing': 'Case/spacing',
  umlaut: 'Umlaut',
  'legal-form': 'Legal form',
  plural: 'Plural',
  abbreviation: 'Abbreviation',
  translation: 'Translation',
  synonym: 'Synonym',
  typo: 'Typo',
  'different-thing': 'Different thing',
  'different-topic': 'Different topic',
  'insufficient-evidence': 'Not enough evidence',
};

/** How sure the model says it is. Null on an answer that did not say. */
const AI_CONFIDENCE_LABELS = { high: 'high', low: 'low' };

/**
 * Where a verdict came from. `spelling-rule` means no model saw the pair at
 * all: the matcher linked it by a hard tier and the server settled it itself.
 * A verdict without a source is the model's, as every earlier answer was.
 */
const AI_SOURCE_RULE = 'spelling-rule';
const AI_RULE_LABEL = 'Spelling rule';
const AI_RULE_TONE = 'dup-verdict--rule';

/** A group the model proposed although the scan scored it below the threshold. */
const AI_CANDIDATE_SOURCE = 'ai-candidate';

/** The model's sentences are untrusted text; a title attribute stops here. */
const AI_REASON_MAX = 200;

/** What a group warning says on its card, as one clause. */
const WARNING_TEXTS = {
  'inbox-tag': 'Inbox tag · it stays the target',
  'configured-tag':
    'A tag here is named in the settings (processed, ignore or predefined tags)',
  'no-permission': 'No permission for every object · those are skipped',
  'has-matching-rule': 'A source has a matching rule the target lacks',
  'owner-differs': 'Different owners in Paperless-ngx',
  'large-group': 'Large group',
};

/**
 * The same warnings, worded for the manual flow. There the target is picked
 * by hand, so an inbox tag can end up among the sources, and a source is
 * deleted: the group wording ("it stays the target") would say the opposite.
 */
const MANUAL_WARNING_TEXTS = {
  ...WARNING_TEXTS,
  'inbox-tag': 'Inbox tag among the names to merge away · it is deleted',
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

/**
 * What a log row records. A row without an action is a merge: every row
 * written before the log knew about deletes is one.
 */
const LOG_ACTION_DELETE = 'delete';

/**
 * A row the Simplify tags page wrote: one compound tag became a document type
 * and topic tags. It is undone from here like a merge (the service plays the
 * split back), so only its cells differ.
 */
const LOG_ACTION_SPLIT = 'split';

const htmlIcons = {
  tags: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-tag"/></svg>',
  correspondents:
    '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-building"/></svg>',
  warn: '<svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg>',
  info: '<svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#i-info"/></svg>',
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
  wand: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-wand"/></svg>',
  trash:
    '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-trash"/></svg>',
  link: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-link"/></svg>',
};

/** One icon per verdict, so a chip reads as a verdict without its text. */
const htmlVerdictIcons = {
  same: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-check-circle"/></svg>',
  different:
    '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-x"/></svg>',
  unsure:
    '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-help"/></svg>',
};

const LOG_PAGE_SIZE = 10;

/** What Paperless-ngx and the merge route accept as a name. */
const MAX_TARGET_NAME = 128;

/** How long the finished batch leaves its summary in the bar, in ms. */
const SELECTION_SUMMARY_MS = 2600;

/** The sensitivity option that hands the threshold to the number field. */
const CUSTOM_SENSITIVITY = 'custom';

/** Both number fields are whole percent and share these bounds. */
const PERCENT_MIN = 50;
const PERCENT_MAX = 100;

/** Where "Select ≥" starts, in whole percent. */
const BUCKET_HIGH = 95;

/** What the toolbar remembers between visits. Values are whole percent. */
const STORE_KEYS = {
  sort: 'dup.sort',
  minConfidence: 'dup.minConfidence',
  sensitivity: 'dup.sensitivity',
  thresholdCustom: 'dup.thresholdCustom',
  aiSweep: 'dup.aiSweep',
};

/** The empty state of the mapping list, which never depends on a scan. */
const MAPPINGS_EMPTY = 'None';

/** How the results list can be ordered; the first one is the default. */
const SORT_MODES = ['confidence', 'documents', 'name', 'kind'];

/** The three lines the gate into advanced mode reads out. */
const GATE_LINES = [
  { icon: 'i-filter', text: 'Sensitivity and threshold' },
  { icon: 'i-merge', text: 'Pair anything by hand' },
  { icon: 'i-list', text: 'Every group as a list, sort and select' },
];

/** Requests in flight at once until the sheet says otherwise. */
const SHEET_LANES = 3;

/** Rows a checklist shows before its "more" button. */
const CHECKLIST_ROWS = 10;

/* --- state ---------------------------------------------------------------- */

const el = {
  // The element that carries data-mode; both modes live inside it.
  page: document.querySelector('[data-review-page="duplicates"]'),
  kind: document.getElementById('dupKind'),
  sensitivity: document.getElementById('dupSensitivity'),
  thresholdCustom: document.getElementById('dupThresholdCustom'),
  includeDismissed: document.getElementById('dupIncludeDismissed'),
  scanBtn: document.getElementById('dupScanBtn'),
  scanIcon: document.getElementById('dupScanIcon'),
  // null on every instance that does not offer the model; every use is
  // guarded, so the page is the same page without them.
  aiReviewBtn: document.getElementById('dupAiReviewBtn'),
  aiReviewIcon: document.getElementById('dupAiReviewIcon'),
  aiNotice: document.getElementById('dupAiNotice'),
  aiProgress: document.getElementById('dupAiProgress'),
  aiProgressBar: document.getElementById('dupAiProgressBar'),
  aiProgressFill: document.getElementById('dupAiProgressFill'),
  aiProgressMessage: document.getElementById('dupAiProgressMessage'),
  runCeiling: document.getElementById('dupRunCeiling'),
  aiStopBtn: document.getElementById('dupAiStopBtn'),
  aiForgetBtn: document.getElementById('dupAiForgetBtn'),
  // Simple mode: the card the page opens on, and what a run found.
  lede: document.querySelector('.dup-lede'),
  empty: document.getElementById('dupEmpty'),
  findBtn: document.getElementById('dupFindBtn'),
  startFacts: document.getElementById('dupStartFacts'),
  result: document.getElementById('dupResult'),
  resultHeadline: document.getElementById('dupResultHeadline'),
  resultCost: document.getElementById('dupResultCost'),
  resultMergeBtn: document.getElementById('dupResultMergeBtn'),
  checklists: document.getElementById('dupChecklists'),
  historyLine: document.getElementById('dupHistoryLine'),
  historyText: document.getElementById('dupHistoryText'),
  historyUndoBtn: document.getElementById('dupHistoryUndoBtn'),
  // Advanced mode: every group, sorted, ticked and merged in batches.
  everything: document.getElementById('dupEverything'),
  results: document.getElementById('dupResults'),
  resultsBar: document.getElementById('dupResultsBar'),
  resultsCount: document.getElementById('dupResultsCount'),
  sortSelect: document.getElementById('dupSortSelect'),
  minConfidence: document.getElementById('dupMinConfidence'),
  selectMinBtn: document.getElementById('dupSelectMinBtn'),
  selection: document.getElementById('dupSelection'),
  selectionCount: document.getElementById('dupSelectionCount'),
  selectionProgress: document.getElementById('dupSelectionProgress'),
  mergeSelectedBtn: document.getElementById('dupMergeSelectedBtn'),
  mergeSelectedLabel: document.getElementById('dupMergeSelectedLabel'),
  // null on every instance without the model; every use is guarded.
  reviewThenMergeBtn: document.getElementById('dupReviewThenMergeBtn'),
  reviewThenMergeIcon: document.getElementById('dupReviewThenMergeIcon'),
  reviewThenMergeLabel: document.getElementById('dupReviewThenMergeLabel'),
  manual: document.getElementById('dupManual'),
  manualTitle: document.getElementById('dupManualTitle'),
  manualKind: document.getElementById('dupManualKind'),
  manualTarget: document.getElementById('dupManualTarget'),
  manualTargetList: document.getElementById('dupManualTargetList'),
  manualSources: document.getElementById('dupManualSources'),
  manualSourcesList: document.getElementById('dupManualSourcesList'),
  manualChips: document.getElementById('dupManualChips'),
  manualWarnings: document.getElementById('dupManualWarnings'),
  manualReload: document.getElementById('dupManualReloadBtn'),
  manualMerge: document.getElementById('dupManualMergeBtn'),
  manualResult: document.getElementById('dupManualResult'),
  manualConsequence: document.getElementById('dupManualConsequence'),
  unused: document.getElementById('dupUnused'),
  unusedSummary: document.getElementById('dupUnusedSummary'),
  unusedAlert: document.getElementById('dupUnusedAlert'),
  unusedBody: document.getElementById('dupUnusedBody'),
  unusedSelectAll: document.getElementById('dupUnusedSelectAllBtn'),
  unusedDelete: document.getElementById('dupUnusedDeleteBtn'),
  logMeta: document.getElementById('dupLogMeta'),
  logAlert: document.getElementById('dupLogAlert'),
  logBody: document.getElementById('dupLogBody'),
  logInfo: document.getElementById('dupLogInfo'),
  logMore: document.getElementById('dupLogMoreBtn'),
  mappings: document.getElementById('dupMappings'),
  mappingsSummary: document.getElementById('dupMappingsSummary'),
  mappingsAlert: document.getElementById('dupMappingsAlert'),
  mappingsBody: document.getElementById('dupMappingsBody'),
  mappingsClear: document.getElementById('dupMappingsClearBtn'),
  dismissalsSummary: document.getElementById('dupDismissalsSummary'),
  dismissalsList: document.getElementById('dupDismissalsList'),
  // The stack: one pair per screen.
  stack: document.getElementById('dupStack'),
  stackPosition: document.getElementById('dupStackPosition'),
  stackFill: document.getElementById('dupStackFill'),
  stackRest: document.getElementById('dupStackRest'),
  stackCard: document.getElementById('dupStackCard'),
  stackTally: document.getElementById('dupStackTally'),
  stackUndoBtn: document.getElementById('dupStackUndoBtn'),
  stackCloseBtn: document.getElementById('dupStackCloseBtn'),
  // The checklist a batch merge writes itself onto.
  apply: document.getElementById('dupApply'),
  applyPosition: document.getElementById('dupApplyPosition'),
  applyFill: document.getElementById('dupApplyFill'),
  applyRest: document.getElementById('dupApplyRest'),
  applyList: document.getElementById('dupApplyList'),
  // The run meter around the progress panel; null without the model.
  runPosition: document.getElementById('dupRunPosition'),
  runRest: document.getElementById('dupRunRest'),
  runLedger: document.getElementById('dupRunLedger'),
  runTokenbar: document.getElementById('dupRunTokenbar'),
  runSegPrompt: document.getElementById('dupRunSegPrompt'),
  runSegAnswer: document.getElementById('dupRunSegAnswer'),
  runSegThinking: document.getElementById('dupRunSegThinking'),
  runLegend: document.getElementById('dupRunLegend'),
  runLog: document.getElementById('dupRunLog'),
};

/** groupId -> { group, targetId, selected: Set<number> } */
const groups = new Map();
/** Group ids ticked for a batch merge; a subset of the keys of `groups`. */
const selectedGroups = new Set();
/** id -> the log entry, so the undo dialog can name what it restores. */
const logEntries = new Map();

let paperlessUrl = '';
let scanning = false;
/** A review judges what a scan found, so it waits for one in this page view. */
let scanned = false;
let aiReviewing = false;
let logOffset = 0;
let logTotal = 0;
let dismissalCount = 0;
/** What the last scan called unused, as { kind, record } pairs. */
let unusedEntries = [];
/** True while a delete request is out; the section is inert meanwhile. */
let deletingUnused = false;
/** The mappings as the server sent them, so the links can be drawn again. */
let mappingRecords = [];
/** True while a batch merge walks its groups; the bar then belongs to it. */
let merging = false;
/** True from the click on "Find duplicates" until its run is over. */
let proposing = false;
/** The review job this page is following, or null when none is. */
let reviewJobId = null;
/** The last job the panel drew, plus when it arrived, so elapsed can tick. */
let progressJob = null;
let progressAt = 0;
let progressTimer = null;
/** What the next run is asked with; the sheet changes it, Start keeps it. */
const levers = {
  titles: true,
  excerpts: true,
  sweep: false,
  lanes: SHEET_LANES,
};
/**
 * The lanes the last Start kept, or null. A run that opened no sheet (the
 * model asked about a selection) runs with what the settings say.
 */
let runLanes = null;
/** What the scan on the page was made with, so the model is asked the same. */
let scanOptions = null;
/** What the last run cost, for the cost line of the result head. */
let lastRunProgress = null;
/** The `aiReview` block of the last answer, or null after a plain scan. */
let lastRunReview = null;
/** The totals of the last scan, for the headline of the result head. */
let lastScanTotals = null;
/**
 * The ticks of the simple checklists, by row key, and the lists that show
 * every row. A row that is not in `ticks` carries the tick of its list.
 * `held` keeps the card up over a scan of the one button: while its sheet
 * is open, and after Cancel, until the next scan or run.
 */
const simple = { ticks: new Map(), open: new Set(), held: false };
/** The log entry the history line undoes, or null when there is none. */
let historyEntry = null;

/* --- small helpers -------------------------------------------------------- */

function normalizeKind(kind) {
  return kind === 'correspondents' ? 'correspondents' : 'tags';
}

/** A whole percent inside the bounds both number fields use. */
function clampPercent(value, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, parsed));
}

/* localStorage is a convenience here and nothing more: a private window, a
   blocked origin or a full quota makes either call throw, and the page has to
   come up with its defaults rather than not at all. */

function storeRead(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeWrite(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Nothing to do: the page keeps working, it just forgets the setting.
  }
}

function plural(value, one, many) {
  return num(value) === 1 ? one : many;
}

/**
 * Paperless-ngx stores a tag colour as a hex value. Only that shape is let
 * through: an inline style is the one place on this page where escaping alone
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
    throw new Error(`The server answered ${response.status} without a body`);
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

function htmlEmpty(title) {
  return `<div class="zr-module"><div class="zr-empty">${htmlIcons.empty}<div class="zr-empty__title">${esc(title)}</div></div></div>`;
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

/**
 * @param {string[]} warnings  wire values from GROUP_WARNINGS
 * @param {Record<string,string>} [texts]  wording of the flow that shows them
 */
function htmlWarnings(warnings, texts = WARNING_TEXTS) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (list.length === 0) return '';
  const htmlRows = list
    .map((warning) =>
      htmlAlert('warn', '', texts[warning] || WARNING_TEXTS[warning] || warning)
    )
    .join('');
  return `<div class="dup-group__warnings">${htmlRows}</div>`;
}

/** The model's sentence, short enough for a title attribute. */
function shortReason(text) {
  const raw = String(text == null ? '' : text).trim();
  return raw.length > AI_REASON_MAX
    ? `${raw.slice(0, AI_REASON_MAX - 1)}…`
    : raw;
}

/** The rule the model applied, worded for the page; '' when it named none. */
function basisLabel(verdict) {
  const value =
    verdict == null || verdict.basis == null ? '' : String(verdict.basis);
  if (value === '') return '';
  return AI_BASIS_LABELS[value] || value;
}

/** True when the server settled this pair by a spelling rule, without a model. */
function isRuleVerdict(verdict) {
  return Boolean(verdict) && String(verdict.source) === AI_SOURCE_RULE;
}

/** 'high', 'low' or '': an older answer carries no confidence at all. */
function confidenceLabel(verdict) {
  const value =
    verdict == null || verdict.confidence == null
      ? ''
      : String(verdict.confidence);
  return AI_CONFIDENCE_LABELS[value] || '';
}

/**
 * Only a "same" the model is sure about comes up ticked, in the verdict
 * dialog and in the checklists. A "same" without a confidence, or with a low
 * one, is a proposal to look at, never one to merge unseen. Pure on purpose:
 * tests/test-duplicates-ui.js evaluates this function itself.
 */
function isSureSame(verdict) {
  return (
    Boolean(verdict) &&
    String(verdict.verdict) === 'same' &&
    String(verdict.confidence) === 'high'
  );
}

/** What a verdict's title attribute says: the rule first, then the sentence. */
function verdictTitle(verdict) {
  const basis = basisLabel(verdict);
  const reason = verdict ? shortReason(verdict.reason) : '';
  if (basis === '') return reason;
  return reason === '' ? basis : `${basis} · ${reason}`;
}

/** '· high' after the verdict, or '' when nothing is known about it. */
function htmlConfidenceSuffix(verdict) {
  const confidence = confidenceLabel(verdict);
  // The suffix is part of the verdict, not a second chip: "Model: same · high".
  return confidence === ''
    ? ''
    : `<span class="dup-verdict__confidence">· ${esc(confidence)}</span>`;
}

/**
 * '· remembered', or '' for a verdict the model gave in this review. The judge
 * keeps its verdicts for DUPLICATES_AI_VERDICT_MEMORY_DAYS, so a chip has to
 * say when it is quoting an earlier review rather than this one.
 */
function htmlRememberedSuffix(verdict) {
  return verdict && verdict.remembered === true
    ? `<span class="dup-verdict__remembered">· ${esc('remembered')}</span>`
    : '';
}

/**
 * The verdict a group carries, as a chip beside its reason chips. A pair a
 * spelling rule settled says so instead of quoting a model that never saw it;
 * it is as sure as this page gets, which is why it wears the "same" tone.
 */
function htmlVerdictChip(verdict) {
  const value = verdict ? String(verdict.verdict) : '';
  if (!AI_VERDICT_LABELS[value]) return '';
  if (isRuleVerdict(verdict)) {
    return `<span class="zr-chip dup-verdict ${esc(AI_RULE_TONE)}" title="${esc(shortReason(verdict.reason))}">${htmlVerdictIcons.same}${esc(AI_RULE_LABEL)}</span>`;
  }
  const htmlIcon = htmlVerdictIcons[value];
  return `<span class="zr-chip dup-verdict ${esc(AI_VERDICT_TONES[value])}" title="${esc(verdictTitle(verdict))}">${htmlIcon}${esc(AI_VERDICT_LABELS[value])}${htmlConfidenceSuffix(verdict)}${htmlRememberedSuffix(verdict)}</span>`;
}

/** The rule the model applied, as a badge of its own in the two dialogs. */
function htmlBasisBadge(verdict) {
  const label = basisLabel(verdict);
  return label === ''
    ? ''
    : `<span class="zr-badge dup-basis">${esc(label)}</span>`;
}

/** The verdict a single member carries, under its match percentage. */
function htmlMemberVerdict(member) {
  const verdict = member.aiVerdict;
  const value = verdict ? String(verdict.verdict) : '';
  if (!AI_VERDICT_LABELS[value]) return '';
  if (isRuleVerdict(verdict)) {
    return `<span class="zr-sm dup-member__verdict ${esc(AI_RULE_TONE)}" title="${esc(shortReason(verdict.reason))}">${esc(AI_RULE_LABEL)}</span>`;
  }
  return `<span class="zr-sm dup-member__verdict ${esc(AI_VERDICT_TONES[value])}" title="${esc(verdictTitle(verdict))}">${esc(AI_VERDICT_LABELS[value])}${htmlConfidenceSuffix(verdict)}${htmlRememberedSuffix(verdict)}</span>`;
}

function htmlDocumentsLink(kind, member) {
  const documents = num(member.documentCount);
  if (!paperlessUrl) {
    return `<span class="zr-mono">${num(documents)}</span>`;
  }
  const filter =
    kind === 'correspondents' ? 'correspondent__id=' : 'tags__id__all=';
  const url = paperlessUrl + '/documents?' + filter + String(num(member.id));
  return `<a class="zr-link zr-mono" href="${esc(url)}" target="_blank" rel="noopener">${num(documents)}</a>`;
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
        ? ''
        : `<input type="checkbox" class="zr-check dup-source" value="${num(member.id)}"${htmlSourceChecked} aria-label="Merge ${esc(name)}">`;
      const htmlScore = isTarget
        ? '<span class="zr-faint">target</span>'
        : `<span class="zr-mono">${pct(member.scoreToTarget)}%</span>`;
      return `<tr data-member-id="${num(member.id)}">
        <td data-label="Keep" class="dup-members__pick">${htmlPick}</td>
        <td data-label="Merge" class="dup-members__pick">${htmlMerge}</td>
        <td data-label="Name" class="dup-members__name">${htmlMemberName(member, withDot)}</td>
        <td data-label="Documents" class="dup-members__num">${htmlDocumentsLink(kind, member)}</td>
        <td data-label="Matching rule" class="dup-members__rule">${htmlMatchingRule(member)}</td>
        <td data-label="Match" class="dup-members__score">${htmlScore}${htmlMemberVerdict(member)}</td>
      </tr>`;
    })
    .join('');
}

function htmlGroupCard(state) {
  const group = state.group;
  const kind = normalizeKind(group.kind);
  const htmlKindIcon = htmlIcons[kind];
  // Attribute fragments, not values: a group the model called apart is muted
  // through the attribute, and a group only the model proposed says so.
  const htmlDifferent =
    group.aiVerdict && group.aiVerdict.verdict === 'different'
      ? ' data-ai-verdict="different"'
      : '';
  const htmlCandidateBadge =
    group.source === AI_CANDIDATE_SOURCE
      ? '<span class="zr-badge zr-badge--info">Found by the model</span>'
      : '';
  return `<section class="zr-module dup-group" data-group-id="${esc(group.id)}" data-kind="${esc(kind)}"${htmlDifferent}>
    <div class="zr-module__head dup-group__head">
      <input type="checkbox" class="zr-check dup-select" aria-label="Select this group">
      <span class="zr-badge zr-badge--brand">${htmlKindIcon}${esc(KIND_LABELS[kind])}</span>
      ${htmlCandidateBadge}
      <div class="dup-group__confidence" role="img" aria-label="${pct(group.confidence)} percent match">
        <div class="zr-meter dup-group__meter"><div class="zr-meter__fill" style="width:${pct(group.confidence)}%"></div></div>
        <span class="zr-sm zr-faint">${pct(group.confidence)}% match</span>
      </div>
      ${htmlReasonChips(group.reasons)}${htmlVerdictChip(group.aiVerdict)}
    </div>
    ${htmlWarnings(group.warnings)}
    <div class="dup-group__result"></div>
    <div class="zr-table-wrap">
      <table class="zr-table zr-table--stack dup-members">
        <thead>
          <tr>
            <th class="dup-members__pick">Keep</th>
            <th class="dup-members__pick">Merge</th>
            <th class="dup-members__name">Name</th>
            <th class="dup-members__num">Documents</th>
            <th class="dup-members__rule">Matching rule</th>
            <th class="dup-members__score" title="Similarity to the suggested target">Match</th>
          </tr>
        </thead>
        <tbody class="dup-members__body">${htmlMemberRows(state)}</tbody>
      </table>
    </div>
    <p class="zr-sm zr-faint dup-group__consequence hidden"></p>
    <div class="zr-module__foot dup-group__foot">
      <button type="button" class="zr-btn zr-btn--primary dup-merge-btn"></button>
      <button type="button" class="zr-btn dup-dismiss-btn">Not a duplicate</button>
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
  // Every change to a card runs through here, which is what keeps the select
  // check, the line that says what merging writes and the count in the bar
  // honest without a second set of listeners.
  updateGroupConsequence(card, state);
  updateSelect(card, state);
  updateSelectionBar();
}

/** True when a source could hand its matching rule to a target without one. */
function groupOffersCopy(state, target) {
  return (
    (state.group.warnings || []).includes('has-matching-rule') &&
    num(target.matchingAlgorithm) === 0
  );
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
    if (input.classList.contains('dup-select')) {
      // Space and click both land here; the count follows immediately.
      const id = String(state.group.id);
      if (input.checked) selectedGroups.add(id);
      else selectedGroups.delete(id);
      updateSelectionBar();
      return;
    }
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

/**
 * The threshold the scan and the model are asked with, as a score between 0
 * and 1. The three presets carry theirs in the option value; "Custom" hands
 * the question to the number field beside the select, where 94 and 96 are a
 * different answer than "strict" and "normal" ever are.
 */
function currentThreshold() {
  if (!el.sensitivity) return 0.85;
  if (el.sensitivity.value !== CUSTOM_SENSITIVITY) {
    return Number(el.sensitivity.value);
  }
  const percent = clampPercent(
    el.thresholdCustom ? el.thresholdCustom.value : PERCENT_MAX,
    BUCKET_HIGH
  );
  return percent / 100;
}

/**
 * Writes the number of a preset into the threshold field. With Custom the
 * number is the answer and stays what it is.
 */
function syncThresholdField() {
  if (!el.sensitivity || !el.thresholdCustom) return;
  if (el.sensitivity.value === CUSTOM_SENSITIVITY) return;
  el.thresholdCustom.value = String(pct(el.sensitivity.value));
}

/** What the scan row of the advanced mode asks for. */
function controlOptions() {
  return {
    kind: selectedKind(),
    threshold: currentThreshold(),
    includeDismissed: Boolean(
      el.includeDismissed && el.includeDismissed.checked
    ),
  };
}

/**
 * What the one button of the simple mode asks for: both kinds, the default
 * sensitivity the route rendered, no hidden pairs.
 */
function simpleOptions() {
  const fallback = Number(el.page ? el.page.dataset.defaultThreshold : NaN);
  return {
    kind: 'all',
    threshold: Number.isFinite(fallback) && fallback > 0 ? fallback : 0.85,
    includeDismissed: false,
  };
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
  updateAiButton();
}

function showSkeletons() {
  el.results.innerHTML =
    '<div class="dup-skeletons"><div class="zr-skeleton dup-skeleton"></div><div class="zr-skeleton dup-skeleton"></div><div class="zr-skeleton dup-skeleton"></div></div>';
  // The cards are gone from the page, so everything that counts them has to be
  // told; a scan that then fails leaves no toolbar over an error message.
  groups.clear();
  selectedGroups.clear();
  updateResultsBar();
  updateSelectionBar();
}

/** Registers a group and returns its card; the order of the list decides. */
function htmlCardFor(group) {
  const targetId = num(group.suggestedTargetId);
  const selected = new Set(
    (group.members || [])
      .map((member) => num(member.id))
      .filter((id) => id !== targetId)
  );
  const state = { group, targetId, selected };
  groups.set(String(group.id), state);
  return htmlGroupCard(state);
}

function htmlCandidateDivider() {
  return `<div class="dup-divider"><span class="zr-sm">${esc('From the model · below the threshold')}</span></div>`;
}

function renderGroups(list) {
  groups.clear();
  selectedGroups.clear();
  // A new answer is a new proposal: every tick goes back to its list's own.
  simple.ticks.clear();
  simple.open.clear();
  if (!Array.isArray(list) || list.length === 0) {
    el.results.innerHTML = htmlEmpty('0 groups');
    updateResultsBar();
    updateSelectionBar();
    renderSimple();
    return;
  }
  // A scan hands out no `source` at all, so everything is a scan group and the
  // divider never appears; only a review can fill the second block.
  const scanGroups = list.filter(
    (group) => group.source !== AI_CANDIDATE_SOURCE
  );
  const candidates = list.filter(
    (group) => group.source === AI_CANDIDATE_SOURCE
  );
  const htmlScanned = scanGroups.map(htmlCardFor).join('');
  const htmlCandidates = candidates.length
    ? htmlCandidateDivider() + candidates.map(htmlCardFor).join('')
    : '';
  el.results.innerHTML = `${htmlScanned}${htmlCandidates}`;
  el.results.querySelectorAll('.dup-group').forEach(bindGroup);
  // The order chosen on the advanced page survives a new scan and a review;
  // it is a way of reading the list, not a property of one answer.
  sortResults();
  updateResultsBar();
  updateSelectionBar();
  // The simple page is a reading of the same cards.
  renderSimple();
}

/* --- ordering and picking by confidence ----------------------------------- */
/* A grown archive answers a scan with dozens of groups that all read "94 %",
   "95 %", "96 %". The toolbar is what turns that list into a decision: put it
   in the order that helps, and tick everything above a confidence in one move.
   Neither fetches anything: the sort moves the cards that are already there,
   so a card keeps its picks, its tick, its verdict and its busy state. */

function sortMode() {
  const value = el.sortSelect ? el.sortSelect.value : SORT_MODES[0];
  return SORT_MODES.includes(value) ? value : SORT_MODES[0];
}

function groupDocuments(state) {
  return (state.group.members || []).reduce(
    (sum, member) => sum + num(member.documentCount),
    0
  );
}

/** The name the card is headed by: what survives the merge it proposes. */
function groupTargetName(state) {
  const target =
    memberOf(state, state.targetId) || (state.group.members || [])[0] || {};
  return String(target.name == null ? '' : target.name);
}

/**
 * The comparator behind the sort select. Confidence and documents run from
 * high to low (the interesting end of both is the top), while a name is
 * compared the way the browser's locale sorts it.
 */
function compareStates(mode, a, b) {
  if (mode === 'documents') {
    return groupDocuments(b) - groupDocuments(a);
  }
  if (mode === 'name') {
    return groupTargetName(a).localeCompare(groupTargetName(b));
  }
  if (mode === 'kind') {
    const kinds = normalizeKind(a.group.kind).localeCompare(
      normalizeKind(b.group.kind)
    );
    if (kinds !== 0) return kinds;
    return num(b.group.confidence) - num(a.group.confidence);
  }
  return num(b.group.confidence) - num(a.group.confidence);
}

/**
 * Re-orders the cards in place. The divider stays where it is and both blocks
 * are sorted inside themselves: what the scan found and what the model
 * proposed below the threshold are two answers, not one list.
 */
function sortResults() {
  if (!el.results) return;
  const cards = [...el.results.querySelectorAll('.dup-group')];
  if (cards.length < 2) return;
  const divider = el.results.querySelector('.dup-divider');
  const mode = sortMode();
  const scanned = [];
  const candidates = [];
  cards.forEach((card) => {
    const state = groups.get(card.dataset.groupId);
    if (!state) return;
    const below =
      divider !== null &&
      (divider.compareDocumentPosition(card) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0;
    (below ? candidates : scanned).push({ card, state });
  });
  const order = (entries) =>
    entries
      .sort((a, b) => compareStates(mode, a.state, b.state))
      .map((entry) => entry.card);
  const ordered = [
    ...order(scanned),
    ...(divider ? [divider] : []),
    ...order(candidates),
  ];
  // appendChild moves a node that is already in the document, so every card
  // keeps its listeners, its checks and whatever it is in the middle of.
  ordered.forEach((node) => el.results.appendChild(node));
}

/** The percent the "Select ≥" button compares against. */
function minConfidencePercent() {
  return clampPercent(
    el.minConfidence ? el.minConfidence.value : BUCKET_HIGH,
    BUCKET_HIGH
  );
}

/**
 * Groups the button would tick right now. Only selectable cards are counted:
 * a count that promised more than the click delivers would be worse than no
 * count at all. The card's own rounded percentage decides, so a card that
 * reads "95 % match" is ticked by "Select ≥ 95".
 */
function groupsAtOrAbove(percent) {
  let matching = 0;
  eachGroupCard((card, state) => {
    const check = card.querySelector('.dup-select');
    if (!check || check.disabled) return;
    if (pct(state.group.confidence) >= percent) matching += 1;
  });
  return matching;
}

/** The label of "Select ≥" follows its number; the title counts the groups. */
function updateMinConfidenceCount() {
  if (!el.selectMinBtn) return;
  const percent = minConfidencePercent();
  const matching = groupsAtOrAbove(percent);
  el.selectMinBtn.textContent = `Select ≥ ${percent}%`;
  el.selectMinBtn.title = `${count(matching)} ${plural(matching, 'group', 'groups')}`;
}

/**
 * The bar belongs to a result list; without cards there is nothing to order.
 * Before a scan the whole block is out of the way, bar, selection and all.
 */
function updateResultsBar() {
  if (el.everything && el.results) {
    el.everything.classList.toggle(
      'hidden',
      groups.size === 0 && el.results.innerHTML.trim() === ''
    );
  }
  if (!el.resultsBar) return;
  el.resultsBar.classList.toggle('hidden', groups.size === 0);
  if (el.resultsCount) el.resultsCount.textContent = `· ${count(groups.size)}`;
  updateMinConfidenceCount();
}

/** Ticks every selectable group at or above the number, unticks the rest. */
function selectByMinConfidence() {
  const percent = minConfidencePercent();
  selectedGroups.clear();
  eachGroupCard((card, state) => {
    const check = card.querySelector('.dup-select');
    if (!check) return;
    const wanted = !check.disabled && pct(state.group.confidence) >= percent;
    check.checked = wanted;
    if (wanted) selectedGroups.add(String(state.group.id));
  });
  setSelectionProgress('');
  updateSelectionBar();
}

function initResultsBar() {
  if (el.sortSelect) {
    const stored = storeRead(STORE_KEYS.sort);
    if (stored && SORT_MODES.includes(stored)) el.sortSelect.value = stored;
    el.sortSelect.addEventListener('change', () => {
      storeWrite(STORE_KEYS.sort, sortMode());
      sortResults();
    });
  }
  if (el.minConfidence) {
    const stored = Number(storeRead(STORE_KEYS.minConfidence));
    if (Number.isFinite(stored) && stored > 0) {
      el.minConfidence.value = String(clampPercent(stored, BUCKET_HIGH));
    }
    el.minConfidence.addEventListener('input', updateMinConfidenceCount);
    el.minConfidence.addEventListener('change', () => {
      el.minConfidence.value = String(minConfidencePercent());
      storeWrite(STORE_KEYS.minConfidence, minConfidencePercent());
      updateMinConfidenceCount();
    });
  }
  if (el.selectMinBtn) {
    el.selectMinBtn.addEventListener('click', selectByMinConfidence);
  }
  updateResultsBar();
}

function initSensitivity() {
  if (!el.sensitivity) return;
  const presets = [...el.sensitivity.options].filter(
    (option) => option.value !== CUSTOM_SENSITIVITY
  );
  const storedSensitivity = storeRead(STORE_KEYS.sensitivity);
  if (
    storedSensitivity &&
    [...el.sensitivity.options].some(
      (option) => option.value === storedSensitivity
    )
  ) {
    el.sensitivity.value = storedSensitivity;
  }
  if (el.thresholdCustom) {
    const stored = Number(storeRead(STORE_KEYS.thresholdCustom));
    if (
      el.sensitivity.value === CUSTOM_SENSITIVITY &&
      Number.isFinite(stored) &&
      stored > 0
    ) {
      el.thresholdCustom.value = String(clampPercent(stored, BUCKET_HIGH));
    }
    // A number a preset has is that preset; any other number is Custom.
    el.thresholdCustom.addEventListener('change', () => {
      const percent = clampPercent(el.thresholdCustom.value, BUCKET_HIGH);
      el.thresholdCustom.value = String(percent);
      const preset = presets.find((option) => pct(option.value) === percent);
      el.sensitivity.value = preset ? preset.value : CUSTOM_SENSITIVITY;
      storeWrite(STORE_KEYS.sensitivity, el.sensitivity.value);
      storeWrite(STORE_KEYS.thresholdCustom, percent);
    });
  }
  el.sensitivity.addEventListener('change', () => {
    storeWrite(STORE_KEYS.sensitivity, el.sensitivity.value);
    syncThresholdField();
  });
  syncThresholdField();
}

/**
 * One scan, with what the caller asks for: the scan row's settings in the
 * advanced mode, the defaults in the simple one.
 *
 * @param {{kind: string, threshold: number, includeDismissed: boolean}} [options]
 * @param {{meter?: boolean}} [show]  `meter` puts the scan on the run meter,
 *   for the one button of the simple page, which has no scan row to say so
 */
async function runScan(options, show) {
  if (scanning || aiReviewing) return;
  const asked = options || controlOptions();
  const meter = Boolean(show && show.meter);
  // A new scan is a new question: every verdict of the last review goes with
  // the cards it belonged to, and the simple page shows what it finds.
  scanned = false;
  simple.held = false;
  clearAiNotice();
  // The panel belongs to the review it reported on; a new scan is a new
  // question and starts without it.
  hideProgressPanel();
  setScanning(true);
  showSkeletons();
  if (meter) showScanPhase();
  try {
    const params = new URLSearchParams({
      kind: asked.kind,
      threshold: String(asked.threshold),
      includeDismissed: asked.includeDismissed ? 'true' : 'false',
    });
    const payload = await requestJson(`/api/duplicates/scan?${params}`);
    if (!payload.success) {
      throw new Error(payload.error || 'The scan failed');
    }
    const data = payload.data || {};
    paperlessUrl = data.paperlessUrl || '';
    scanOptions = asked;
    // The headline needs what was looked at, and a plain scan is a new
    // question: the numbers of the last review say nothing about it.
    lastScanTotals = data.totals || null;
    lastRunReview = data.aiReview || null;
    if (!lastRunReview) lastRunProgress = null;
    scanned = true;
    renderGroups(data.groups);
    renderUnused(data);
    // The scan is where the page learns the public Paperless-ngx URL, so the
    // mapping rows drawn before it can become links now.
    refreshMappingLinks();
  } catch (error) {
    el.results.innerHTML = '';
    updateResultsBar();
    if (el.aiNotice) {
      el.aiNotice.innerHTML = htmlAlert('danger', 'Scan failed', error.message);
    }
  } finally {
    if (meter) hideProgressPanel();
    setScanning(false);
  }
}

/**
 * The run meter while the one button scans: the phase, a bar that slides,
 * and no Stop, because a scan ends in seconds and asks nobody.
 */
function showScanPhase() {
  if (!el.aiProgress) return;
  showProgressPanel();
  if (el.aiStopBtn) el.aiStopBtn.classList.add('hidden');
  if (el.aiProgressMessage) {
    el.aiProgressMessage.textContent = phaseHeadline({ phase: 'scanning' });
  }
  if (el.aiProgressFill) {
    el.aiProgressFill.classList.add('dup-progress__fill--indeterminate');
    el.aiProgressFill.style.width = '';
  }
  if (el.aiProgressBar) el.aiProgressBar.removeAttribute('aria-valuenow');
}

/* --- the model ------------------------------------------------------------ */
/* After a scan the configured provider is asked what it makes of the pairs.
   It judges, it never merges: every verdict lands next to the result of the
   string matcher, and a merge is a button of its own. The whole flow is
   guarded by the elements being there at all, so an instance without a model
   runs this file unchanged. */

function clearAiNotice() {
  if (el.aiNotice) el.aiNotice.innerHTML = '';
}

/**
 * "Ask the model" waits for a scan to have produced cards, and every button
 * that starts something waits while anything is running.
 */
function updateAiButton() {
  const busy = scanning || aiReviewing || merging || proposing;
  if (el.aiReviewBtn) {
    el.aiReviewBtn.disabled = !scanned || busy;
    el.aiReviewBtn.title = scanned ? '' : 'Scan first';
  }
  updateSimpleSurface();
}

function setAiReviewing(active) {
  aiReviewing = active;
  const use = el.aiReviewIcon ? el.aiReviewIcon.querySelector('use') : null;
  if (use) {
    use.setAttribute(
      'href',
      active ? '/icons.svg#i-refresh' : '/icons.svg#i-wand'
    );
  }
  if (el.aiReviewIcon) {
    el.aiReviewIcon.classList.toggle('zr-icon--spin', active);
  }
  updateAiButton();
}

/** Pairs the page knows about: every member of a group but its target. */
function reviewPairCount() {
  let pairs = 0;
  groups.forEach((state) => {
    pairs += Math.max(0, (state.group.members || []).length - 1);
  });
  return pairs;
}

/**
 * The review needs the status of a refusal to word it itself: a 409 means the
 * setting is off, which is not an error the server has to phrase for the page.
 */
async function postForReview(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // An auth redirect or a proxy can answer without JSON; the status is then
    // the only thing the page can say anything about.
  }
  return { status: response.status, payload };
}

/** True on an instance that offers the model at all. */
function aiReviewOffered() {
  return Boolean(el.aiReviewBtn || el.aiProgress);
}

/* --- the run meter ------------------------------------------------------- */
/* A review is many model requests in a row. Left to a spinner it would be a
   bill nobody sees, so the server runs it as a job and this panel says where
   it is, what it has spent and how long it still needs, with the one button
   that ends it. Every way into the model shares the panel, both modes show
   it while it runs, and a reloaded page attaches to a review that is still
   going. */

/** How often the fallback asks a job whose event stream broke. */
const REVIEW_POLL_MS = 2000;

/** The two job states that mean "still going". */
const REVIEW_LIVE_STATES = ['running', 'stopping'];

/**
 * What is left of a review, the way a person reads a wait. An estimate the
 * job does not have yet is no text at all; the caller says "estimating…"
 * where that is the honest answer.
 */
function formatEta(ms) {
  if (ms === null || ms === undefined || ms === '') return '';
  const left = Number(ms);
  if (!Number.isFinite(left) || left < 0) return '';
  // Under five seconds a number would be noise; it is about to be over.
  if (left < 5000) return 'almost done';
  if (left < 60000) return `about ${Math.round(left / 1000)} s left`;
  return `about ${Math.max(1, Math.round(left / 60000))} min left`;
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

/**
 * How far a review is, 0 to 100, or null while nothing is known yet.
 *
 * Pairs are the unit whenever the plan knows how many there are, because the
 * answers that stream in during a request count as well: a bar that only
 * moves between requests stands still for the whole minute one of them takes.
 * Requests are the fallback for the stretch before the pairs are counted, and
 * before that there is no honest share at all.
 */
function progressPercent(progress) {
  const state = progress || {};
  const pairs = Number(state.pairsTotal);
  if (Number.isFinite(pairs) && pairs > 0) {
    const judged = Number(state.pairsJudged) || 0;
    const answers = Number(state.requestAnswers) || 0;
    const share = (judged + answers) / pairs;
    return Math.max(0, Math.min(100, Math.round(share * 100)));
  }
  const planned = Number(state.requestsPlanned);
  if (!Number.isFinite(planned) || planned <= 0) return null;
  const done = Number(state.requestsDone);
  const share = (Number.isFinite(done) ? done : 0) / planned;
  return Math.max(0, Math.min(100, Math.round(share * 100)));
}

/** The one line a run that ended early leaves above the results. */
function stopNotice(job) {
  const state = (job && job.progress) || {};
  const done = Number(state.requestsDone) || 0;
  // A count the job does not have yet is null, and Number(null) is 0, which
  // would read as "of 0 requests". NaN is the honest answer here.
  const planned =
    state.requestsPlanned == null ? NaN : Number(state.requestsPlanned);
  const pairs = state.pairsTotal == null ? NaN : Number(state.pairsTotal);
  const judged = Number(state.pairsJudged) || 0;
  const missing = Number.isFinite(pairs) ? Math.max(0, pairs - judged) : null;
  const tail =
    missing === null
      ? ''
      : ` · ${missing} ${plural(missing, 'pair', 'pairs')} not asked`;
  const requests = plural(
    Number.isFinite(planned) ? planned : done,
    'request',
    'requests'
  );
  const reason = job ? job.stopReason : null;
  if (reason === 'token-budget') {
    const budget = formatTokens(state.tokenBudget);
    return `Stopped at the ${budget} limit after ${done} ${requests}${tail}`;
  }
  if (reason === 'idle') {
    return `Stopped · no page was watching${tail}`;
  }
  const of = Number.isFinite(planned) ? ` of ${planned}` : '';
  return `Stopped after ${done}${of} ${requests}${tail}`;
}

/** "Request 2 of 9 · 7 of 10 answers · 34 of 82 pairs · 12.4k of 200k tokens". */
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
  // Inside a request: what the streamed answer has said so far. Between two
  // requests there is nothing to count, and the part is left out entirely.
  const requestPairs = Number(state.requestPairs);
  if (Number.isFinite(requestPairs) && requestPairs > 0) {
    const answers = Number(state.requestAnswers) || 0;
    parts.push(
      `${Math.max(0, Math.min(answers, requestPairs))} of ${requestPairs} answers`
    );
  }
  const judged = Number(state.pairsJudged) || 0;
  const pairs = Number(state.pairsTotal);
  if (Number.isFinite(pairs) && pairs > 0) {
    parts.push(`${judged} of ${pairs} pairs`);
  } else if (judged > 0) {
    parts.push(`${judged} ${plural(judged, 'pair', 'pairs')}`);
  }
  const budget = Number(state.tokenBudget);
  const spent = formatTokens(state.tokens);
  let cost =
    Number.isFinite(budget) && budget > 0
      ? `${spent} of ${formatTokens(budget)} tokens`
      : `${spent} tokens`;
  // Before the first answer the only honest number is the plan's own guess.
  const estimate = Number(state.estimatedTokens);
  if (done === 0 && Number.isFinite(estimate) && estimate > 0) {
    cost += `, estimated ${formatTokens(estimate)}`;
  }
  parts.push(cost);
  return parts.join(' · ');
}

/** The single line the panel keeps after a review ended. */
function progressOutcomeText(event) {
  const job = (event && event.job) || {};
  const state = job.progress || {};
  const elapsed = formatElapsed(state.elapsedMs);
  const done = Number(state.requestsDone) || 0;
  const planned =
    state.requestsPlanned == null ? NaN : Number(state.requestsPlanned);
  const judged = Number(state.pairsJudged) || 0;
  const pairs = state.pairsTotal == null ? NaN : Number(state.pairsTotal);
  const tokens = `${formatTokens(state.tokens)} tokens`;
  // What the measurement settled on belongs in the sentence the panel keeps:
  // it is the one number that explains how long the whole thing took.
  const size = Number(state.batchSize);
  const batch =
    Number.isFinite(size) && size > 0
      ? ` · ${size} ${plural(size, 'pair', 'pairs')} per request`
      : '';
  if (event && event.type === 'failed') return `Failed after ${elapsed}`;
  if (event && event.type === 'stopped') {
    const requests = Number.isFinite(planned)
      ? `${done} of ${planned} requests`
      : `${done} ${plural(done, 'request', 'requests')}`;
    const judgedPart = Number.isFinite(pairs)
      ? `${judged} of ${pairs} pairs judged`
      : `${judged} ${plural(judged, 'pair', 'pairs')} judged`;
    return `Stopped after ${requests} · ${judgedPart} · ${tokens}${batch}`;
  }
  return `Done in ${elapsed} · ${done} ${plural(done, 'request', 'requests')} · ${judged} ${plural(judged, 'pair', 'pairs')} · ${tokens}${batch}`;
}

function setStopLabel(text) {
  if (!el.aiStopBtn) return;
  const label = el.aiStopBtn.querySelector('.dup-progress__stop-label');
  if (label) label.textContent = text;
}

function showProgressPanel() {
  if (!el.aiProgress) return;
  el.aiProgress.classList.remove('hidden');
  // A running meter belongs to both modes; only the line it leaves behind
  // is the advanced page's (see renderProgressOutcome).
  el.aiProgress.removeAttribute('data-advanced');
  el.aiProgress.classList.add('dup-progress--live');
  if (el.aiStopBtn) {
    el.aiStopBtn.classList.remove('hidden');
    el.aiStopBtn.disabled = false;
    setStopLabel('Stop');
  }
  updateSimpleSurface();
}

/** Takes the panel off the page; the next scan or review starts it over. */
function hideProgressPanel() {
  stopProgressTicker();
  progressJob = null;
  if (!el.aiProgress) return;
  el.aiProgress.classList.add('hidden');
  el.aiProgress.classList.remove('dup-progress--live');
  if (el.aiProgressMessage) el.aiProgressMessage.textContent = '';
  if (el.aiProgressFill) {
    el.aiProgressFill.classList.remove('dup-progress__fill--indeterminate');
    el.aiProgressFill.classList.remove('dup-progress__fill--thinking');
    el.aiProgressFill.style.width = '0%';
  }
  clearRunMeter();
  updateSimpleSurface();
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

/**
 * Keeps the elapsed figure moving between two progress events, so a run that
 * is thinking does not look frozen. Everything else in the meter only changes
 * when the job says something, which is the point of it.
 */
function drawProgressTime() {
  if (!el.runLedger || !progressJob) return;
  const state = progressJob.progress || {};
  const base = Number(state.elapsedMs) || 0;
  const live = progressJob.finishedAt ? base : base + (Date.now() - progressAt);
  renderRunLedger(Object.assign({}, state, { elapsedMs: live }));
}

/**
 * What the run is doing, in two or three words, for the one line at the top
 * of the panel.
 *
 * The service's own message is longer and changes inside a phase ("The model
 * is thinking… (168 tokens so far)"); that detail belongs to the request it
 * describes and is shown on its row in the log. What stays up here is the
 * phase, so the eye has something that does not flicker. A phase nobody
 * mapped falls back to the message rather than to silence.
 *
 * @param {object} progress
 * @returns {string}
 */
function phaseHeadline(progress) {
  const state = progress || {};
  const labels = {
    starting: 'Getting ready',
    scanning: 'Comparing the names',
    evidence: 'Reading documents',
    sweeping: 'Looking at the whole list',
    'warming-up': 'Measuring the model',
    judging: 'Asking the model',
    escalating: 'Asking again with excerpts',
    finishing: 'Finishing up',
    applying: 'Writing to Paperless-ngx',
    // The order of the Simplify page runs through the same job service.
    vocabulary: 'Proposing a vocabulary',
    ordering: 'Asking the model',
    splitting: 'Asking the model',
  };
  const label = labels[String(state.phase || '')];
  if (label) return label;
  return String(state.message || 'Working');
}

/** One `progress` event on the panel. */
function renderProgress(job) {
  if (!el.aiProgress || !job) return;
  progressJob = job;
  progressAt = Date.now();
  const state = job.progress || {};
  const percent = progressPercent(state);
  if (el.aiProgressFill) {
    const unknown = percent === null;
    el.aiProgressFill.classList.toggle(
      'dup-progress__fill--indeterminate',
      unknown
    );
    // Reasoning takes as long as it takes and moves nothing; the fill
    // breathes so the panel does not look frozen while it happens.
    el.aiProgressFill.classList.toggle(
      'dup-progress__fill--thinking',
      Boolean(state.thinking)
    );
    // An inline width would beat the class, so the sliding band gets none.
    el.aiProgressFill.style.width = unknown ? '' : `${percent}%`;
  }
  if (el.aiProgressBar) {
    if (percent === null) {
      el.aiProgressBar.removeAttribute('aria-valuenow');
    } else {
      el.aiProgressBar.setAttribute('aria-valuenow', String(percent));
    }
  }
  if (el.aiProgressMessage) {
    el.aiProgressMessage.textContent = phaseHeadline(state);
  }
  renderRunMeter(state);
  drawProgressTime();
  startProgressTicker();
}

/** The last thing the panel says; it stays until the next scan or review. */
function renderProgressOutcome(event) {
  if (!el.aiProgress) return;
  const job = (event && event.job) || null;
  progressJob = job;
  progressAt = Date.now();
  stopProgressTicker();
  if (el.aiStopBtn) {
    el.aiStopBtn.disabled = true;
    el.aiStopBtn.classList.add('hidden');
  }
  el.aiProgress.classList.remove('dup-progress--live');
  // The line a finished run leaves is the advanced page's; the simple page
  // says what the run cost in its result head instead.
  el.aiProgress.setAttribute('data-advanced', '');
  const percent = progressPercent(job ? job.progress : null);
  if (el.aiProgressFill) {
    el.aiProgressFill.classList.remove('dup-progress__fill--indeterminate');
    el.aiProgressFill.classList.remove('dup-progress__fill--thinking');
    el.aiProgressFill.style.width =
      event.type === 'done' ? '100%' : `${percent === null ? 0 : percent}%`;
  }
  // The run is over: the headline says how it ended, the bar carries the one
  // line that sums it up, and the bill it leaves behind is the ledger, the
  // split and the request log. Stop has nothing left to keep.
  if (el.aiProgressMessage) {
    el.aiProgressMessage.textContent = progressOutcomeText(event);
  }
  if (el.runPosition) el.runPosition.textContent = '';
  if (el.runRest) {
    el.runRest.textContent = progressCountsText(job ? job.progress : null);
  }
  updateSimpleSurface();
}

/** What the answer of a review does to the page, wherever it came from. */
function applyReviewResult(data) {
  if (data.paperlessUrl) paperlessUrl = data.paperlessUrl;
  // What this run cost. The `aiReview` block counts the requests and the
  // tokens; only the job's own progress carries the seconds and the split
  // between question, answer and reasoning, so the cost line reads both.
  lastRunReview = data.aiReview || null;
  lastRunProgress = progressJob ? progressJob.progress || null : null;
  if (data.totals) lastScanTotals = data.totals;
  // An answer is a result, whichever button asked for it.
  simple.held = false;
  renderGroups(data.groups);
  renderUnused(data);
  refreshMappingLinks();
}

/** Asks the job to end after the request it is in. No dialog, no question. */
async function stopReview() {
  if (!el.aiStopBtn || !reviewJobId) return;
  el.aiStopBtn.disabled = true;
  setStopLabel('Stopping…');
  const id = reviewJobId;
  try {
    const payload = await postJson(
      `/api/duplicates/ai-review/jobs/${encodeURIComponent(id)}/stop`,
      {}
    );
    // The job words its own stop; the panel only repeats it. The answer can
    // arrive after the stream already ended the job, and a snapshot from the
    // stopping moment must not paint over the outcome or restart the clock.
    const job = payload.data ? payload.data.job : null;
    if (job && reviewJobId === id && REVIEW_LIVE_STATES.includes(job.status)) {
      renderProgress(job);
    }
  } catch (error) {
    // The request failed, so nothing was stopped: the button goes back to
    // being a button and the stream still decides how this ends.
    if (el.aiStopBtn && reviewJobId === id) {
      el.aiStopBtn.disabled = false;
      setStopLabel('Stop');
    }
    toast(error.message, { tone: 'danger' });
  }
}

/**
 * Follows a review job to its end and puts what it says on the page.
 *
 * The event stream is the normal way. A proxy that breaks it drops the page
 * onto polling the job instead, because a review that ran must still come
 * home, and a poll counts as watching, so the job does not stop itself.
 *
 * @param {object} job  the AiReviewJob to follow
 * @returns {Promise<{aiReview: object, stopped: boolean}>}
 */
function followReviewJob(job) {
  return new Promise((resolve, reject) => {
    reviewJobId = job.id;
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
      reviewJobId = null;
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
        settle(reject, new Error(event.error || 'The run failed'));
        return;
      }
      // done and stopped both carry a result; a stopped one is the verdicts
      // the review did reach, and they belong on the cards.
      const data = event.data || null;
      if (data) applyReviewResult(data);
      const stopped = event.type === 'stopped';
      if (stopped && el.aiNotice) {
        el.aiNotice.innerHTML = htmlAlert(
          'warn',
          'Stopped early',
          stopNotice(event.job)
        );
      }
      settle(resolve, { aiReview: (data && data.aiReview) || {}, stopped });
    };

    const pollOnce = async () => {
      if (settled) return;
      try {
        const payload = await requestJson(base);
        const current = payload.data ? payload.data.job : null;
        if (!current) throw new Error('The run is gone');
        if (REVIEW_LIVE_STATES.includes(current.status)) {
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
      poll = window.setInterval(pollOnce, REVIEW_POLL_MS);
    };

    if (typeof window.EventSource === 'function') {
      source = new EventSource(`${base}/events`);
      source.onmessage = (message) => {
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          // A line this page cannot read is a line it ignores.
          return;
        }
        handle(event);
      };
      source.onerror = () => {
        if (settled) return;
        // Some proxies close a stream they do not understand. The review is
        // still running on the server, so ask it directly from now on.
        closeSource();
        startPolling();
      };
    } else {
      startPolling();
    }
  });
}

/**
 * One question to the model, and its answer put on the page. Every way into
 * a review ends here: the one button of the simple mode, "Ask the model" and
 * the groups ticked on the advanced page. The request, the refusals and what
 * the answer does to the cards are the same in all three. The page is only
 * touched when an answer arrives; a throw leaves the cards exactly as they
 * were and the caller words it.
 *
 * The review runs as a job on the server and this follows it, so a long one
 * shows where it is and can be stopped.
 *
 * @param {object} extra  fields on top of the ones every caller sends; the
 *   guided path narrows the question with `groupIds` and `includeCandidates`
 * @param {{kind: string, threshold: number, includeDismissed: boolean}} [options]
 *   what the scan is made with; the scan row's settings when left out
 * @returns {Promise<{aiReview: object, stopped: boolean}>} what the review
 *   has to say about itself, and whether it ended before it was through
 */
async function askForVerdicts(extra, options) {
  hideProgressPanel();
  const asked = options || controlOptions();
  const { status, payload } = await postForReview(
    '/api/duplicates/ai-review/jobs',
    {
      kind: asked.kind,
      threshold: asked.threshold,
      includeDismissed: Boolean(asked.includeDismissed),
      withTitles: levers.titles,
      withExcerpts: levers.excerpts,
      semanticSweep: levers.sweep,
      // The lanes of the sheet are the lanes of the run; without a sheet the
      // settings decide.
      ...(runLanes === null ? {} : { concurrency: runLanes }),
      ...extra,
    }
  );
  const job = payload && payload.data ? payload.data.job : null;
  // A 409 that names a job is not a failure: another tab or an earlier click
  // started this very review, so this one watches it instead of asking twice.
  if (status !== 202 && !(status === 409 && job)) {
    if (!payload) {
      throw new Error(`The server answered ${status} without a body`);
    }
    throw new Error(payload.error || 'The run failed');
  }
  if (!job) {
    throw new Error('The server started a run without naming it');
  }
  // The answer rebuilds the cards from a scan made with these options.
  scanOptions = asked;
  return followReviewJob(job);
}

/**
 * On load: a review that is still running somewhere gets its page back. A
 * finished one is left alone: a reload is not a request to see the last
 * answer again.
 */
async function reattachReview() {
  if (!el.aiProgress) return;
  let job;
  try {
    const payload = await requestJson('/api/duplicates/ai-review/jobs/current');
    job = payload.data ? payload.data.job : null;
  } catch {
    // Nothing to attach to is the normal case; a page that cannot ask simply
    // behaves as if no review were running.
    return;
  }
  if (!job || !REVIEW_LIVE_STATES.includes(job.status)) return;
  setAiReviewing(true);
  try {
    const { aiReview, stopped } = await followReviewJob(job);
    // The answer is on the page now, so the toolbar and the selection belong
    // to it exactly as they would after a review started here.
    if (groups.size > 0) scanned = true;
    if (!stopped && el.aiNotice) {
      el.aiNotice.innerHTML = htmlFailedRequests(aiReview);
    }
  } catch (error) {
    if (el.aiNotice) {
      el.aiNotice.innerHTML = htmlReviewFailure(error.message);
    }
  } finally {
    setAiReviewing(false);
  }
}

/**
 * A review that ended as `failed` said why, and the judge words that message
 * itself: it names the setting that would have prevented it (thinking, the
 * token limit). The notice repeats it as it is and links the one place where
 * those settings live.
 *
 * @param {string} message  what the job reported
 * @returns {string} markup for the notice area
 */
function htmlReviewFailure(message) {
  const text = String(message == null ? '' : message);
  return `<div class="zr-alert zr-alert--danger">${htmlIcons.danger}<div class="zr-alert__body"><div class="zr-alert__title">Run failed</div><p class="zr-sm">${esc(text)}</p><p class="zr-sm"><a class="zr-link" href="/settings#duplicates-tab">Duplicates settings</a></p></div></div>`;
}

/** What a review has to admit about itself, or '' when it went through. */
function htmlFailedRequests(review) {
  const failed = num(review.failedRequests);
  return failed > 0
    ? htmlAlert(
        'warn',
        `${failed} ${plural(failed, 'request', 'requests')} failed`,
        `${plural(failed, 'Its pairs are', 'Their pairs are')} marked unsure`
      )
    : '';
}

/**
 * Empties the judge's memory of earlier verdicts. Local only: nothing in
 * Paperless-ngx is touched and no merge is undone; the next review asks the
 * model about every pair again.
 */
async function forgetVerdicts() {
  if (!el.aiForgetBtn) return;
  const confirmed = await confirmDialog({
    title: 'Clear verdict memory',
    body: 'The next run asks about every pair again.',
    confirmLabel: 'Clear',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;
  el.aiForgetBtn.disabled = true;
  try {
    const payload = await requestJson('/api/duplicates/ai-review/memory', {
      method: 'DELETE',
    });
    const removed = num(payload.data && payload.data.removed);
    toast(
      `${count(removed)} ${plural(removed, 'verdict', 'verdicts')} cleared`,
      {
        tone: 'ok',
      }
    );
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  } finally {
    el.aiForgetBtn.disabled = false;
  }
}

/** "Ask the model" of the advanced page: the sheet, then the model. */
async function runAiReview() {
  if (!el.aiReviewBtn || scanning || aiReviewing || !scanned) return;
  const options = controlOptions();
  // Asking costs tokens, so the sheet says how many before anything starts.
  if (!(await confirmRun(options))) return;
  setAiReviewing(true);
  clearAiNotice();
  try {
    const { aiReview, stopped } = await askForVerdicts({}, options);
    // A review that stopped early has already said so where this would speak.
    if (!stopped && el.aiNotice) {
      el.aiNotice.innerHTML = htmlFailedRequests(aiReview);
    }
  } catch (error) {
    if (el.aiNotice) {
      el.aiNotice.innerHTML = htmlReviewFailure(error.message);
    }
  } finally {
    setAiReviewing(false);
  }
}

/* --- merging -------------------------------------------------------------- */

function htmlMergeDialog(kind, target, sources, offerCopy) {
  const documents = countDocuments(sources);
  const facts = `${count(documents)} ${plural(documents, 'document', 'documents')} ${KIND_VERBS[kind]} · ${count(sources.length)} ${plural(sources.length, KIND_LABELS[kind].toLowerCase(), KIND_PLURALS[kind])} deleted`;
  const htmlNames = sources
    .map(
      (member) =>
        `<li>${esc(String(member.name == null ? '' : member.name))}</li>`
    )
    .join('');
  const targetName = String(target.name == null ? '' : target.name);
  const htmlCopy = offerCopy
    ? `<label class="dup-dialog__check"><input type="checkbox" class="zr-check" id="dupCopyRule" checked><span>${esc(`Copy the matching rule to ${targetName}`)}</span></label>`
    : '';
  // The survivor may be renamed in the same step: a group of spellings often
  // has no member that is the name the archive should end up with
  // ("Amazon", "amazon" become "Amazon EU S.a.r.l."). Prefilled with the name
  // it has, so leaving it alone is the default.
  const htmlName = `<label class="dup-dialog__field" for="dupTargetName"><span class="zr-label">Name</span><input class="zr-input" type="text" id="dupTargetName" maxlength="${num(MAX_TARGET_NAME)}" value="${esc(targetName)}" autocomplete="off" spellcheck="false"></label>`;
  return `<p>${esc(facts)}</p><ul class="dup-dialog__list">${htmlNames}</ul>${htmlName}${htmlCopy}`;
}

/**
 * The name the merge request should carry, or null when the field was left
 * as it was. The rename is an option of the merge, not a second request, so
 * "unchanged" has to mean "say nothing"; otherwise every merge would rename
 * the target to the name it already has.
 *
 * @param {string} current  the target's name right now
 * @param {string} typed    what the dialog's field holds
 * @returns {string|null}
 */
function mergeTargetName(current, typed) {
  const next = String(typed == null ? '' : typed).trim();
  const now = String(current == null ? '' : current).trim();
  if (next === '' || next === now) return null;
  return next.slice(0, MAX_TARGET_NAME);
}

function htmlMergeSuccess(result) {
  const target = result.target || {};
  const names = (result.sources || [])
    .filter((source) => source.deleted)
    .map((source) => String(source.name == null ? '' : source.name));
  const moved = num(result.documentsMoved);
  const body = `${count(moved)} ${plural(moved, 'document', 'documents')} moved · deleted: ${names.length ? names.join(', ') : 'none'}`;
  const title = `Merged into ${String(target.name == null ? '' : target.name)}`;
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
  return `<div class="zr-alert zr-alert--danger">${htmlIcons.danger}<div class="zr-alert__body"><div class="zr-alert__title">Partly merged</div><p class="zr-sm">${esc(`${count(result.documentsMoved)} ${plural(result.documentsMoved, 'document', 'documents')} moved · not merged:`)}</p>${htmlList}</div></div>`;
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
  // updateFoot() does this on the way back out, but nothing else runs on the
  // way in; without it a running card stays tickable.
  const state = groups.get(card.dataset.groupId);
  if (state) updateSelect(card, state);
}

function finishGroup(card, markup) {
  card
    .querySelectorAll(
      '.zr-table-wrap, .dup-group__warnings, .dup-group__consequence'
    )
    .forEach((node) => node.remove());
  const foot = card.querySelector('.dup-group__foot');
  if (foot) foot.remove();
  const result = card.querySelector('.dup-group__result');
  if (result) result.innerHTML = markup;
  delete card.dataset.state;
  const state = groups.get(card.dataset.groupId);
  if (state) updateSelect(card, state);
  updateSelectionBar();
}

/**
 * One merge, from the confirm dialog to the reloaded log. Every way into a
 * merge ends here (a group the scan proposed, a pair put together by hand, a
 * step of a batch) because the request, the dialog and the answers are the
 * same thing in all of them. Only where the outcome is shown differs, and
 * that is what the two callbacks are for.
 *
 * @param {object} request
 * @param {'tags'|'correspondents'} request.kind
 * @param {object} request.target      the record that survives
 * @param {object[]} request.sources   records whose documents move to it
 * @param {boolean} request.offerCopy  offer to copy a source's matching rule
 * @param {(busy: boolean) => void} request.busy  called around the request
 * @param {(markup: string, status: string) => void} request.result
 *   'done' for a finished merge, 'partial' when sources were left alone,
 *   'error' when the request itself failed
 * @param {(result: object) => void} [request.done] after a finished merge
 * @param {{copyMatchingRule: boolean}} [request.batch]
 *   set when this merge is one step of a batch: the answer of the one dialog
 *   the batch showed replaces the per-merge dialog, and the toast and the log
 *   reload are left to the batch, which does both once at the end
 * @returns {Promise<{status: string, documentsMoved: number}|null>}
 *   null when nothing was asked for, otherwise how the merge ended
 */
async function runMerge({
  kind,
  target,
  sources,
  offerCopy,
  busy,
  result,
  done,
  batch,
}) {
  if (!target || sources.length === 0) return null;
  const targetName = String(target.name == null ? '' : target.name);

  // A batch already asked, once, for all of its groups; its answer only means
  // anything for a group that has a rule to copy in the first place.
  let copyMatchingRule = Boolean(batch && batch.copyMatchingRule && offerCopy);
  // A batch keeps the names of its groups; only the single dialog offers one.
  let renameTo = null;
  if (!batch) {
    // confirmDialog appends its <dialog> synchronously, so the checkbox exists
    // as soon as the promise is handed back, and it is gone again once the
    // dialog closes, which is why the value is captured here rather than after.
    const answer = confirmDialog({
      title: `Merge into ${targetName}`,
      html: htmlMergeDialog(kind, target, sources, offerCopy),
      confirmLabel: 'Merge',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
    const checkbox = document.getElementById('dupCopyRule');
    copyMatchingRule = Boolean(checkbox && checkbox.checked);
    if (checkbox) {
      checkbox.addEventListener('change', () => {
        copyMatchingRule = checkbox.checked;
      });
    }
    const nameField = document.getElementById('dupTargetName');
    if (nameField) {
      renameTo = mergeTargetName(targetName, nameField.value);
      nameField.addEventListener('input', () => {
        renameTo = mergeTargetName(targetName, nameField.value);
      });
    }
    if (!(await answer)) return null;
  }

  busy(true);
  // Set on every path out of the request below, which is what a batch counts.
  let outcome;
  try {
    const payload = await postJson('/api/duplicates/merge', {
      kind,
      targetId: num(target.id),
      sourceIds: sources.map((member) => num(member.id)),
      ...(renameTo === null ? {} : { targetName: renameTo }),
      copyMatchingRule,
    });
    const data = payload.data || {};
    if (payload.success && data.status !== 'partial') {
      result(htmlMergeSuccess(data), 'done');
      const moved = num(data.documentsMoved);
      outcome = { status: 'done', documentsMoved: moved, message: '' };
      if (!batch) {
        toast(
          `Merged ${moved} ${plural(moved, 'document', 'documents')} into ${targetName}`,
          { tone: 'ok' }
        );
      }
      if (done) done(data);
    } else if (data.status === 'partial') {
      result(htmlMergeProblems(data), 'partial');
      busy(false);
      outcome = {
        status: 'partial',
        documentsMoved: num(data.documentsMoved),
        message: 'Partly merged',
      };
      if (!batch) {
        toast('Partly merged', {
          tone: 'danger',
        });
      }
    } else {
      throw new Error(payload.error || payload.message || 'The merge failed');
    }
  } catch (error) {
    result(htmlAlert('danger', 'The merge failed', error.message), 'error');
    busy(false);
    outcome = { status: 'error', documentsMoved: 0, message: error.message };
    if (!batch) toast(error.message, { tone: 'danger' });
  }
  if (!batch) loadLog(true);
  return outcome;
}

/**
 * @param {HTMLElement} card
 * @param {object} state
 * @param {{copyMatchingRule: boolean}} [batch]  one step of a batch merge
 * @returns {Promise<{status: string, documentsMoved: number}|null>|undefined}
 */
function mergeGroup(card, state, batch) {
  const target = memberOf(state, state.targetId);
  const sources = selectedSources(state);
  if (!target || sources.length === 0) return;

  return runMerge({
    kind: normalizeKind(state.group.kind),
    target,
    sources,
    offerCopy: groupOffersCopy(state, target),
    batch,
    busy: (on) => {
      setGroupBusy(card, on);
      // The foot was replaced by the spinner label; putting it back is what
      // makes a card that reported a problem usable again.
      if (!on) updateFoot(card, state);
    },
    result: (markup, status) => {
      if (status === 'done') {
        finishGroup(card, markup);
        return;
      }
      const holder = card.querySelector('.dup-group__result');
      if (holder) holder.innerHTML = markup;
    },
  });
}

/* --- merging several groups at once --------------------------------------- */
/* A scan of a grown archive proposes dozens of groups, and confirming one
   dialog per group is the whole cost of the page. The selection is therefore
   over the cards: tick what is right, confirm once, and the groups are merged
   one after the other, never in parallel (Paperless-ngx gets one bulk edit at
   a time), with every card reporting exactly what a single merge reports. Only
   the log is reloaded, once, at the end; nothing else on the page is refetched.

   A card keeps its own target and its own source ticks: the selection says
   which groups take part, never what they merge. */

/** Calls back for every card on the page that still has a state. */
function eachGroupCard(fn) {
  if (!el.results) return;
  el.results.querySelectorAll('.dup-group').forEach((card) => {
    const state = groups.get(card.dataset.groupId);
    if (state) fn(card, state);
  });
}

/** Why this group cannot take part in a batch, or '' when it can. */
function selectBlockReason(card, state) {
  if (card.dataset.state === 'busy') return 'This group is being merged';
  if (!card.querySelector('.dup-group__foot')) {
    return 'This group is already merged';
  }
  const target = memberOf(state, state.targetId);
  if (!target) return 'This group has no target';
  if (target.userCanChange === false) {
    return 'The API token may not change the target of this group';
  }
  if (selectedSources(state).length === 0) {
    return 'Tick at least one entry to merge away';
  }
  return '';
}

/**
 * The check in one card's head. A group that cannot take part loses its tick
 * as well as its check, so a card that goes busy or finishes mid-batch is out
 * of the selection rather than silently still in it.
 */
function updateSelect(card, state) {
  const check = card.querySelector('.dup-select');
  if (!check) return;
  const id = String(state.group.id);
  const reason = selectBlockReason(card, state);
  check.disabled = reason !== '';
  check.title = reason;
  // A card that is being merged stays in the batch that is merging it; every
  // other reason takes it out of the selection for good.
  if (reason !== '' && card.dataset.state !== 'busy') {
    selectedGroups.delete(id);
  }
  check.checked = selectedGroups.has(id);
}

/** What one card would merge right now, or null when it would merge nothing. */
function entryFor(card, state) {
  const target = memberOf(state, state.targetId);
  const sources = selectedSources(state);
  if (!target || sources.length === 0) return null;
  return {
    card,
    state,
    target,
    sources,
    kind: normalizeKind(state.group.kind),
  };
}

/** Every ticked group that is ready to merge, in the order the page shows. */
function selectedBatch() {
  const entries = [];
  eachGroupCard((card, state) => {
    if (!selectedGroups.has(String(state.group.id))) return;
    const entry = entryFor(card, state);
    if (entry) entries.push(entry);
  });
  return entries;
}

function countDocuments(sources) {
  return sources.reduce((sum, member) => sum + num(member.documentCount), 0);
}

/** What merging one entry writes: every document that moves, every deletion. */
function entryWrites(entry) {
  return countDocuments(entry.sources) + entry.sources.length;
}

/** "Merge 34 · 61 writes": what the one button does, in its own numbers. */
function mergeLabel(merges, writes) {
  return `Merge ${count(merges)} · ${count(writes)} ${plural(writes, 'write', 'writes')}`;
}

function setSelectionProgress(text) {
  if (!el.selectionProgress) return;
  el.selectionProgress.textContent = text;
  el.selectionProgress.classList.toggle('hidden', text === '');
}

function setSelectionBusy(busy) {
  [el.mergeSelectedBtn, el.reviewThenMergeBtn, el.selectMinBtn].forEach(
    (button) => {
      if (button) button.disabled = busy;
    }
  );
  // The one button of the simple page would scan over a running batch; it
  // waits like the rest.
  updateAiButton();
}

function updateSelectionBar() {
  if (!el.selection) return;
  // While a batch runs the bar is the batch's: its cards go busy and leave the
  // selection one by one, which would otherwise pull the progress line away.
  if (merging) return;
  const entries = selectedBatch();
  const writes = entries.reduce((sum, entry) => sum + entryWrites(entry), 0);
  if (el.selectionCount) {
    el.selectionCount.textContent = `${count(entries.length)} selected · ${count(writes)} ${plural(writes, 'write', 'writes')}`;
  }
  if (el.mergeSelectedBtn) el.mergeSelectedBtn.disabled = entries.length === 0;
  if (el.mergeSelectedLabel) {
    el.mergeSelectedLabel.textContent = `Merge ${count(entries.length)}`;
  }
  if (el.reviewThenMergeBtn) {
    el.reviewThenMergeBtn.disabled = entries.length === 0;
  }
  if (el.reviewThenMergeLabel) {
    el.reviewThenMergeLabel.textContent = `Ask the model about ${count(entries.length)}`;
  }
  // The title of "Select ≥" counts selectable cards, which is what a card
  // going busy or finishing changes.
  updateMinConfidenceCount();
  // The bar appears as soon as a card can be selected; without any
  // selectable card it hides, unless it still reports the last batch.
  const selectable = Boolean(
    el.results && el.results.querySelector('.dup-select:not([disabled])')
  );
  const reporting = Boolean(
    el.selectionProgress && !el.selectionProgress.classList.contains('hidden')
  );
  el.selection.classList.toggle('hidden', !selectable && !reporting);
}

/** Ticks every card the predicate accepts; a disabled check is never touched. */
function selectGroups(match) {
  eachGroupCard((card, state) => {
    const check = card.querySelector('.dup-select');
    if (!check || check.disabled || !match(state)) return;
    selectedGroups.add(String(state.group.id));
    check.checked = true;
  });
  updateSelectionBar();
}

/** One line per group: what goes, into what, and how many documents move. */
function htmlBatchLine(entry) {
  const documents = countDocuments(entry.sources);
  const names = entry.sources
    .map((member) => String(member.name == null ? '' : member.name))
    .join(', ');
  const targetName = String(entry.target.name == null ? '' : entry.target.name);
  return `<li>${esc(names)} → <strong>${esc(targetName)}</strong> <span class="zr-faint">${esc(`· ${count(documents)} ${plural(documents, 'document', 'documents')}`)}</span></li>`;
}

/**
 * The one dialog of a batch: every group, every unused object that goes with
 * it, the totals, and the copied matching rule asked once for the whole
 * batch rather than per group.
 *
 * @param {object[]} entries   what selectedBatch() returned
 * @param {{name: string}[]} unused  unused objects deleted with the batch
 * @param {boolean} offerCopy  at least one group has a rule to hand over
 */
function htmlBatchDialog(entries, unused, offerCopy) {
  const documents = entries.reduce(
    (sum, entry) => sum + countDocuments(entry.sources),
    0
  );
  const deleted =
    entries.reduce((sum, entry) => sum + entry.sources.length, 0) +
    unused.length;
  const htmlLines = entries.map(htmlBatchLine).join('');
  const htmlUnused = unused
    .map(
      (entry) =>
        `<li>${esc(entry.name)} <span class="zr-faint">${esc('· 0 documents · delete')}</span></li>`
    )
    .join('');
  const facts = `${count(documents)} ${plural(documents, 'document', 'documents')} moved · ${count(deleted)} deleted`;
  return `<ul class="dup-dialog__list">${htmlLines}${htmlUnused}</ul><p>${esc(facts)}</p>${htmlCopyRuleCheck(offerCopy)}`;
}

/**
 * Asks once before a batch writes. The title is the button that was pressed,
 * with its numbers; the answer carries the copy-rule tick of the dialog.
 *
 * @param {object[]} entries  groups to merge
 * @param {{name: string}[]} unused  unused objects to delete with them
 * @returns {Promise<{ok: boolean, copyMatchingRule: boolean}>}
 */
async function confirmMerge(entries, unused) {
  const offerCopy = entries.some((entry) =>
    groupOffersCopy(entry.state, entry.target)
  );
  const writes =
    entries.reduce((sum, entry) => sum + entryWrites(entry), 0) + unused.length;
  const answer = confirmDialog({
    title: mergeLabel(entries.length, writes),
    html: htmlBatchDialog(entries, unused, offerCopy),
    confirmLabel: 'Merge',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  const copyMatchingRule = copyRuleAnswer('dupCopyRuleAll');
  const ok = await answer;
  return { ok, copyMatchingRule: copyMatchingRule() };
}

/**
 * Walk a batch: every entry through the request a single merge uses, one after
 * the other, and a failure on one group leaves the rest running. Every path
 * into a batch ends here (the button of the simple page, "Merge" of the
 * selection bar, the model on a selection), so the progress line, the toast,
 * the one log reload and what is left ticked afterwards are the same thing in
 * all of them.
 *
 * @param {object[]} entries  what selectedBatch() returned, possibly filtered
 * @param {boolean} copyMatchingRule  the one answer the dialog collected
 */
async function runBatch(entries, copyMatchingRule) {
  merging = true;
  setSelectionBusy(true);
  updateResultButton();
  // The checklist is the visible half of this loop: which group is being
  // written, which are waiting, and what Paperless-ngx said about a failure.
  openApply(entries);
  let merged = 0;
  let failed = 0;
  let documents = 0;
  for (let index = 0; index < entries.length; index += 1) {
    setSelectionProgress(`Merging ${index + 1} of ${entries.length}…`);
    const entry = entries[index];
    drawApplyBar(index, entries.length);
    markApply(entry.state.group.id, 'running', '');
    const startedAt = Date.now();
    // Awaited on purpose: one bulk edit at a time is what Paperless-ngx wants.
    const outcome = await mergeGroup(entry.card, entry.state, {
      copyMatchingRule,
    });
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    documents += outcome ? num(outcome.documentsMoved) : 0;
    if (outcome && outcome.status === 'done') {
      merged += 1;
      markApply(
        entry.state.group.id,
        'done',
        `${count(outcome.documentsMoved)} ${plural(outcome.documentsMoved, 'document', 'documents')} · ${seconds} s`
      );
    } else {
      failed += 1;
      markApply(
        entry.state.group.id,
        'failed',
        (outcome && outcome.message) || 'Refused by Paperless-ngx'
      );
    }
  }
  drawApplyBar(entries.length, entries.length);

  const summary =
    `${count(merged)} merged · ` +
    `${count(documents)} ${plural(documents, 'document', 'documents')}` +
    (failed > 0 ? ` · ${count(failed)} failed` : '');
  toast(summary, { tone: failed > 0 ? 'danger' : 'ok' });
  merging = false;
  setSelectionBusy(false);
  finishApply(summary);
  setSelectionProgress(summary);
  // What the batch left behind: the merged groups are gone from the selection,
  // a group that failed is still in it and can be tried again.
  updateSelectionBar();
  // The one reload of the whole batch; nothing else on the page is refetched.
  loadLog(true);
  // The simple page is a reading of the cards, and the cards have just changed.
  renderSimple();
  window.setTimeout(() => {
    setSelectionProgress('');
    updateSelectionBar();
    // A batch that went through leaves no checklist behind; one that did not
    // keeps its failed rows and the button that tries them again.
    if (failed === 0) closeApply();
  }, SELECTION_SUMMARY_MS);
}

/**
 * Reads the copy-rule answer out of a dialog that was just opened. The
 * checkbox lives in the markup confirmDialog appends synchronously, so it is
 * there before the promise settles and gone once the dialog closes.
 *
 * @param {string} id  the checkbox the dialog rendered
 * @returns {() => boolean} the answer at the moment it is asked for
 */
function copyRuleAnswer(id) {
  const checkbox = document.getElementById(id);
  let value = Boolean(checkbox && checkbox.checked);
  if (checkbox) {
    checkbox.addEventListener('change', () => {
      value = checkbox.checked;
    });
  }
  return () => value;
}

/**
 * Merge every selected group. One confirmation covers all of them, and no
 * model is involved: this is the page's own answer, for an archive whose owner
 * trusts the matcher, or has no model configured at all.
 */
async function mergeSelected() {
  if (merging) return;
  const entries = selectedBatch();
  if (entries.length === 0) return;
  const answer = await confirmMerge(entries, []);
  if (!answer.ok) return;
  await runBatch(entries, answer.copyMatchingRule);
}

/* --- the model on the selection, then merge ------------------------------- */
/* "Ask the model about 6" asks about exactly the groups that are ticked, puts
   the verdicts on the cards as a full review would, and then shows them once
   in a dialog whose ticks decide what is merged. A verdict never blocks
   anything: "different" and "unsure" only come up unticked, and any row can
   be ticked again. */

/** What every card is set to merge, so a re-render can put it back. */
function capturePicks() {
  const picks = new Map();
  groups.forEach((state, id) => {
    picks.set(id, { targetId: state.targetId, selected: [...state.selected] });
  });
  return picks;
}

/**
 * Puts those picks back on the cards a review rebuilt. A group that came back
 * changed (a member gone, a different target) keeps what the answer says;
 * only a pick that still fits the members is restored.
 */
function restorePicks(picks) {
  eachGroupCard((card, state) => {
    const pick = picks.get(String(state.group.id));
    if (!pick) return;
    const ids = (state.group.members || []).map((member) => num(member.id));
    if (!ids.includes(num(pick.targetId))) return;
    state.targetId = num(pick.targetId);
    state.selected = new Set(
      pick.selected
        .map(num)
        .filter((id) => ids.includes(id) && id !== state.targetId)
    );
    renderMembers(card, state);
  });
}

/**
 * One row of the verdict dialog: what would be merged, and what the model
 * (or the spelling rule the server applied instead) said about it.
 *
 * @param {object} entry     what selectedBatch() returned
 * @param {string} cellClass classes of the tick cell
 */
function htmlReviewRow(entry, cellClass) {
  const group = entry.state.group;
  const verdict = group.aiVerdict;
  const value = verdict ? String(verdict.verdict) : '';
  // Only a "same" that is settled comes up ticked: a spelling rule, or a
  // model that says it is sure. Every other row starts unticked.
  const htmlChecked = isSureSame(verdict) ? ' checked' : '';
  const documents = countDocuments(entry.sources);
  const targetName = String(entry.target.name == null ? '' : entry.target.name);
  const names = entry.sources
    .map((member) => String(member.name == null ? '' : member.name))
    .join(', ');
  const htmlVerdict =
    htmlVerdictChip(verdict) || '<span class="zr-faint">not asked</span>';
  const htmlCandidate =
    group.source === AI_CANDIDATE_SOURCE
      ? '<span class="zr-badge zr-badge--info">Found by the model</span>'
      : '';
  const reason = verdict ? shortReason(verdict.reason) : '';
  return `<tr data-group-id="${esc(String(group.id))}" data-documents="${num(documents)}" data-sources="${num(entry.sources.length)}" data-verdict="${esc(value)}">
    <td data-label="Merge" class="${esc(cellClass)}"><input type="checkbox" class="zr-check dup-review-pick" value="${esc(String(group.id))}"${htmlChecked} aria-label="Merge into ${esc(targetName)}"></td>
    <td data-label="Group"><span class="dup-review__names">${esc(names)} <span class="zr-faint">→</span> <strong>${esc(targetName)}</strong></span>${htmlCandidate}</td>
    <td data-label="Documents" class="zr-mono">${num(documents)}</td>
    <td data-label="Model">${htmlVerdict}</td>
    <td data-label="Basis">${htmlBasisBadge(verdict)}</td>
    <td data-label="Why" class="dup-review__reason">${esc(reason)}</td>
  </tr>`;
}

/** The table of the verdict dialog. */
function htmlVerdictTable(htmlRows) {
  return `<div class="zr-table-wrap"><table class="zr-table zr-table--stack dup-review-table">
      <thead>
        <tr>
          <th class="dup-review__pick">Merge</th>
          <th>Group</th>
          <th>Documents</th>
          <th>Model</th>
          <th>Basis</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>${htmlRows}</tbody>
    </table></div>`;
}

/** The copy-rule question a batch dialog asks once for all its groups. */
function htmlCopyRuleCheck(offerCopy) {
  return offerCopy
    ? `<label class="dup-dialog__check"><input type="checkbox" class="zr-check" id="dupCopyRuleAll" checked><span>Copy matching rules where the target has none</span></label>`
    : '';
}

function htmlReviewDialog(entries, offerCopy) {
  const htmlRows = entries
    .map((entry) => htmlReviewRow(entry, 'dup-review__pick'))
    .join('');
  return `${htmlVerdictTable(htmlRows)}
    <p class="zr-sm dup-review__summary" id="dupReviewSummary"></p>${htmlCopyRuleCheck(offerCopy)}`;
}

/**
 * "4 of 6 ticked · 23 documents · 4 deletions", live while the checks are
 * used.
 *
 * @param {HTMLElement} dialog
 * @param {number} total  rows the dialog shows
 */
function pickedSummaryText(dialog, total) {
  const picked = [...dialog.querySelectorAll('.dup-review-pick')].filter(
    (check) => check.checked
  );
  const rowOf = (check) => check.closest('tr');
  const documents = picked.reduce((sum, check) => {
    const row = rowOf(check);
    return sum + num(row ? row.dataset.documents : 0);
  }, 0);
  const deleted = picked.reduce((sum, check) => {
    const row = rowOf(check);
    return sum + num(row ? row.dataset.sources : 0);
  }, 0);
  return `${picked.length} of ${total} ticked · ${count(documents)} ${plural(documents, 'document', 'documents')} · ${count(deleted)} ${plural(deleted, 'deletion', 'deletions')}`;
}

/** The dialog confirmDialog() has just appended; it does so synchronously. */
function lastDialog() {
  const dialogs = document.querySelectorAll('dialog.zr-dialog');
  return dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
}

function setGuidedBusy(active) {
  if (!el.reviewThenMergeBtn) return;
  const use = el.reviewThenMergeIcon
    ? el.reviewThenMergeIcon.querySelector('use')
    : null;
  if (use) {
    use.setAttribute(
      'href',
      active ? '/icons.svg#i-refresh' : '/icons.svg#i-wand'
    );
  }
  if (el.reviewThenMergeIcon) {
    el.reviewThenMergeIcon.classList.toggle('zr-icon--spin', active);
  }
}

/**
 * Shows the verdicts of the groups that were just judged and merges what stays
 * ticked. Returns without merging when the dialog is cancelled; the selection
 * on the page is untouched either way.
 */
async function confirmReviewedBatch(entries) {
  const offerCopy = entries.some((entry) =>
    groupOffersCopy(entry.state, entry.target)
  );
  const same = entries.filter(
    (entry) =>
      entry.state.group.aiVerdict &&
      String(entry.state.group.aiVerdict.verdict) === 'same'
  ).length;
  const answer = confirmDialog({
    title: `${count(entries.length)} ${plural(entries.length, 'group', 'groups')} · ${count(same)} same`,
    html: htmlReviewDialog(entries, offerCopy),
    confirmLabel: 'Merge',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  const dialog = lastDialog();
  const copyMatchingRule = copyRuleAnswer('dupCopyRuleAll');
  // The table is wide for a dialog; the kernel appends it before this runs.
  let picked = [];
  if (dialog) {
    dialog.classList.add('zr-dialog--wide', 'dup-review-dialog');
    const summary = dialog.querySelector('#dupReviewSummary');
    const primary = dialog.querySelector('[value="ok"]');
    const update = () => {
      if (summary) {
        summary.textContent = pickedSummaryText(dialog, entries.length);
      }
      picked = [...dialog.querySelectorAll('.dup-review-pick')]
        .filter((check) => check.checked)
        .map((check) => check.value);
      // The button says how many it merges, and the number follows the ticks.
      if (primary) primary.textContent = `Merge ${count(picked.length)}`;
    };
    update();
    dialog.addEventListener('change', (event) => {
      if (event.target.classList.contains('dup-review-pick')) update();
    });
  }
  if (!(await answer)) return;

  const wanted = new Set(picked);
  const ticked = entries.filter((entry) =>
    wanted.has(String(entry.state.group.id))
  );
  if (ticked.length === 0) {
    setSelectionProgress('0 merged');
    window.setTimeout(() => {
      setSelectionProgress('');
      updateSelectionBar();
    }, SELECTION_SUMMARY_MS);
    return;
  }
  // Whatever stayed unticked keeps its tick on the page, so the groups the
  // model was unsure about are still there afterwards.
  await runBatch(ticked, copyMatchingRule());
}

/** "Ask the model about 6": the model on exactly the ticked groups, then merge. */
async function reviewThenMerge() {
  if (!el.reviewThenMergeBtn || merging || scanning || aiReviewing) return;
  const entries = selectedBatch();
  if (entries.length === 0) return;
  const ids = entries.map((entry) => String(entry.state.group.id));
  const picks = capturePicks();

  setGuidedBusy(true);
  setAiReviewing(true);
  setSelectionBusy(true);
  setSelectionProgress(
    `Asking the model about ${ids.length} ${plural(ids.length, 'group', 'groups')}…`
  );
  clearAiNotice();
  let asked = false;
  try {
    // The cards came from one scan; the model is asked about the same one.
    const { aiReview, stopped } = await askForVerdicts(
      {
        groupIds: ids,
        includeCandidates: false,
      },
      scanOptions || controlOptions()
    );
    // The answer rebuilt the cards; their picks and their ticks go back on.
    restorePicks(picks);
    const wanted = new Set(ids);
    selectGroups((state) => wanted.has(String(state.group.id)));
    if (!stopped && el.aiNotice) {
      el.aiNotice.innerHTML = htmlFailedRequests(aiReview);
    }
    // A review that did not get through every group is not an answer to
    // merge from; its partial verdicts sit on the cards and wait.
    asked = !stopped;
  } catch (error) {
    // Exactly where a full review reports: above the results, and no dialog.
    if (el.aiNotice) {
      el.aiNotice.innerHTML = htmlReviewFailure(error.message);
    }
  } finally {
    setGuidedBusy(false);
    setAiReviewing(false);
    setSelectionBusy(false);
    setSelectionProgress('');
    updateSelectionBar();
  }
  if (!asked) return;
  // Re-read the selection: the cards are new elements after the answer.
  const judged = selectedBatch();
  if (judged.length === 0) return;
  await confirmReviewedBatch(judged);
}

/* --- the one button of the simple page ------------------------------------ */
/* "Find duplicates" scans both kinds at the default sensitivity, opens the
   sheet with what the scan left for the model, and on Start has the model
   judge every group and the band below it; the result is the head and the
   checklists of the simple page. The scan comes first because it is free
   and takes seconds, and without it the sheet has no numbers. Without a
   model the button is a scan, and the result is what the spelling settled. */

function setProposalBusy(active) {
  proposing = active;
  updateAiButton();
}

async function findDuplicates() {
  if (scanning || aiReviewing || merging || proposing) return;
  const options = simpleOptions();
  if (!aiReviewOffered()) {
    await runScan(options);
    return;
  }
  setProposalBusy(true);
  clearAiNotice();
  try {
    await runScan(options, { meter: true });
    // A failed scan has already said so in the notice; there is nothing to
    // ask the model about.
    if (!scanned) return;
    // The sheet, with the scan's numbers. The card stays behind it, and
    // Cancel leaves the page on the card.
    simple.held = true;
    updateSimpleSurface();
    if (!(await confirmRun(options))) return;
    simple.held = false;
    setAiReviewing(true);
    let outcome;
    try {
      outcome = await askForVerdicts({ includeCandidates: true }, options);
    } finally {
      setAiReviewing(false);
    }
    // A run that stopped early has said so in the notice already.
    if (!outcome.stopped && el.aiNotice) {
      el.aiNotice.innerHTML = htmlFailedRequests(outcome.aiReview);
    }
  } catch (error) {
    if (el.aiNotice) {
      el.aiNotice.innerHTML = htmlReviewFailure(error.message);
    }
  } finally {
    setProposalBusy(false);
  }
}

function initSelection() {
  if (!el.selection) return;
  if (el.mergeSelectedBtn) {
    el.mergeSelectedBtn.addEventListener('click', mergeSelected);
  }
  if (el.reviewThenMergeBtn) {
    el.reviewThenMergeBtn.addEventListener('click', reviewThenMerge);
  }
  updateSelectionBar();
}

/* --- merge by hand -------------------------------------------------------- */
/* A merge nobody proposed: the target and the sources are picked out of the
   whole list of one kind. Everything that makes a merge safe (the confirm
   dialog, the verified deletion, the log entry, the undo) is the code above;
   what is new here is only the picking, and the warnings the scan would
   otherwise have attached to a group.

   The list is fetched on the first open of the module and kept per kind, so a
   page that never opens it costs nothing and a kind switched back and forth
   costs one request. */

/** More sources than this and the scan's large-group warning applies here too. */
const MANUAL_LARGE_GROUP = 8;

const manual = {
  kind: 'tags',
  /** kind -> EntityRecord[]; null means "not loaded yet". */
  cache: { tags: null, correspondents: null },
  loading: false,
  busy: false,
  targetId: null,
  /** chosen source ids, in the order they were picked */
  sourceIds: [],
};

/** True when a record carries a matching rule Paperless-ngx would act on. */
function hasMatchingRule(record) {
  return (
    num(record.matchingAlgorithm) !== 0 &&
    String(record.match == null ? '' : record.match).trim() !== ''
  );
}

function manualRecords() {
  return manual.cache[manual.kind] || [];
}

function manualRecord(id) {
  return manualRecords().find((record) => num(record.id) === num(id)) || null;
}

function manualTargetRecord() {
  return manual.targetId == null ? null : manualRecord(manual.targetId);
}

function manualSourceRecords() {
  return manual.sourceIds
    .map((id) => manualRecord(id))
    .filter((record) => record !== null);
}

/**
 * The warnings the page can work out on its own. `configured-tag` is missing
 * on purpose: only the server knows which tag names the settings refer to, and
 * this module never asks the server anything but the list.
 */
function manualWarnings(target, sources) {
  const warnings = [];
  if (sources.some((record) => record.isInboxTag)) {
    warnings.push('inbox-tag');
  }
  if (
    target.userCanChange === false ||
    sources.some((record) => record.userCanChange === false)
  ) {
    warnings.push('no-permission');
  }
  if (num(target.matchingAlgorithm) === 0 && sources.some(hasMatchingRule)) {
    warnings.push('has-matching-rule');
  }
  const owners = new Set(
    [target, ...sources].map((record) =>
      record.owner == null ? null : num(record.owner)
    )
  );
  if (owners.size > 1) {
    warnings.push('owner-differs');
  }
  if (sources.length > MANUAL_LARGE_GROUP) {
    warnings.push('large-group');
  }
  return warnings;
}

function htmlManualChips(sources) {
  return sources
    .map((record) => {
      const name = String(record.name == null ? '' : record.name);
      return `<span class="zr-chip dup-manual__chip" data-id="${num(record.id)}"><span>${esc(name)}</span><button type="button" class="dup-manual__remove" data-id="${num(record.id)}" aria-label="Remove ${esc(name)}"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-x"/></svg></button></span>`;
    })
    .join('');
}

/** null until init() has run; the page works without the module. */
let manualTargetPicker = null;
let manualSourcePicker = null;

function manualUpdateTitle() {
  if (!el.manualTitle) return;
  if (manual.loading) {
    el.manualTitle.textContent = 'Merge by hand · loading…';
    return;
  }
  const records = manual.cache[manual.kind];
  el.manualTitle.textContent = records
    ? `Merge by hand · ${count(records.length)} ${KIND_PLURALS[manual.kind]}`
    : 'Merge by hand';
}

function manualRender() {
  if (!el.manualMerge) return;
  const target = manualTargetRecord();
  const sources = manualSourceRecords();

  el.manualChips.innerHTML = htmlManualChips(sources);
  el.manualWarnings.innerHTML =
    target && sources.length > 0
      ? htmlWarnings(manualWarnings(target, sources), MANUAL_WARNING_TEXTS)
      : '';

  const locked =
    (target && target.userCanChange === false) ||
    sources.some((record) => record.userCanChange === false);
  el.manualMerge.disabled =
    manual.busy || manual.loading || !target || sources.length === 0 || locked;
  el.manualMerge.title = locked ? 'No permission for every entry' : '';
  updateManualConsequence();
}

function setManualBusy(busy) {
  manual.busy = busy;
  const blocked = busy || manual.loading;
  [el.manualTarget, el.manualSources, el.manualReload].forEach((node) => {
    if (node) node.disabled = blocked;
  });
  if (el.manualKind) {
    el.manualKind.querySelectorAll('button[data-kind]').forEach((button) => {
      button.disabled = blocked;
    });
  }
  el.manualMerge.innerHTML = busy
    ? `${htmlIcons.spin}<span>Merging…</span>`
    : `${htmlIcons.merge}<span>Merge</span>`;
  manualRender();
}

/** Forgets records that no longer exist in Paperless-ngx. */
function manualForget(kind, ids) {
  const records = manual.cache[kind];
  if (!records) return;
  const gone = new Set(ids.map(num));
  manual.cache[kind] = records.filter((record) => !gone.has(num(record.id)));
}

function manualClearPicks() {
  manual.targetId = null;
  manual.sourceIds = [];
  el.manualTarget.value = '';
  el.manualTarget.dataset.selectedId = '';
  el.manualSources.value = '';
  el.manualResult.innerHTML = '';
  if (manualTargetPicker) manualTargetPicker.close();
  if (manualSourcePicker) manualSourcePicker.close();
}

async function loadManualEntities(force) {
  const kind = manual.kind;
  if (manual.cache[kind] && !force) {
    manualUpdateTitle();
    manualRender();
    return;
  }
  if (force) manual.cache[kind] = null;

  manual.loading = true;
  manualUpdateTitle();
  setManualBusy(manual.busy);
  try {
    const payload = await requestJson(
      `/api/duplicates/entities?kind=${encodeURIComponent(kind)}`
    );
    if (!payload.success) {
      throw new Error(payload.error || 'The list could not be loaded');
    }
    manual.cache[kind] = Array.isArray(payload.data) ? payload.data : [];
    if (manual.kind === kind) el.manualResult.innerHTML = '';
  } catch (error) {
    manual.cache[kind] = null;
    if (manual.kind === kind) {
      el.manualResult.innerHTML = htmlAlert(
        'danger',
        'The list could not be loaded',
        error.message
      );
    }
  } finally {
    // A kind switched while the request was in flight owns the fields now.
    if (manual.kind === kind) {
      manual.loading = false;
      manualUpdateTitle();
      setManualBusy(manual.busy);
    }
  }
}

function switchManualKind(kind) {
  const next = normalizeKind(kind);
  if (next === manual.kind) return;
  manual.kind = next;
  manualClearPicks();
  manualRender();
  manualUpdateTitle();
  loadManualEntities(false);
}

function mergeByHand() {
  const target = manualTargetRecord();
  const sources = manualSourceRecords();
  if (!target || sources.length === 0) return;
  const kind = manual.kind;

  return runMerge({
    kind,
    target,
    sources,
    offerCopy:
      num(target.matchingAlgorithm) === 0 && sources.some(hasMatchingRule),
    busy: setManualBusy,
    done: (data) => {
      // The merge may have renamed the survivor. The picker keeps it, so the
      // record and the field have to learn the new name; otherwise the next
      // merge into it would send the old one and rename it back.
      const name =
        data.target && data.target.name != null ? String(data.target.name) : '';
      if (!name) return;
      const record = manualRecord(num(target.id));
      if (record) record.name = name;
      el.manualTarget.value = name;
    },
    result: (markup, status) => {
      el.manualResult.innerHTML = markup;
      if (status !== 'done') return;
      // The sources are gone in Paperless-ngx; the target survives and stays
      // picked, so the next merge into it needs no second search.
      manualForget(
        kind,
        sources.map((record) => num(record.id))
      );
      manual.sourceIds = [];
      el.manualSources.value = '';
      manualUpdateTitle();
      setManualBusy(false);
    },
  });
}

function initManual() {
  if (!el.manual || !el.manualMerge) return;

  manualTargetPicker = createPicker({
    input: el.manualTarget,
    list: el.manualTargetList,
    prefix: 'dupManualTargetRow',
    // A record already picked as a source is not offered as the target; it is
    // in the chip row, where it can be taken back out.
    choices: () =>
      manualRecords().filter(
        (record) => !manual.sourceIds.includes(num(record.id))
      ),
    onPick: (record) => {
      manual.targetId = num(record.id);
      el.manualTarget.value = String(record.name == null ? '' : record.name);
      el.manualTarget.dataset.selectedId = String(num(record.id));
      manualRender();
    },
  });

  manualSourcePicker = createPicker({
    input: el.manualSources,
    list: el.manualSourcesList,
    prefix: 'dupManualSourcesRow',
    choices: () =>
      manualRecords().filter(
        (record) =>
          num(record.id) !== manual.targetId &&
          !manual.sourceIds.includes(num(record.id))
      ),
    onPick: (record) => {
      const id = num(record.id);
      if (!manual.sourceIds.includes(id)) manual.sourceIds.push(id);
      el.manualSources.value = '';
      manualRender();
    },
  });

  // Typing over a picked name unpicks it: the field and the stored id must
  // never disagree about what will be merged.
  el.manualTarget.addEventListener('input', () => {
    const picked = manualTargetRecord();
    if (!picked) return;
    if (
      el.manualTarget.value !== String(picked.name == null ? '' : picked.name)
    ) {
      manual.targetId = null;
      el.manualTarget.dataset.selectedId = '';
      manualRender();
    }
  });

  el.manualKind.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-kind]');
    if (!button || button.disabled) return;
    el.manualKind.querySelectorAll('button[data-kind]').forEach((other) => {
      other.setAttribute('aria-selected', other === button ? 'true' : 'false');
    });
    switchManualKind(button.dataset.kind);
  });

  el.manualChips.addEventListener('click', (event) => {
    const button = event.target.closest('.dup-manual__remove');
    if (!button) return;
    const id = num(button.dataset.id);
    manual.sourceIds = manual.sourceIds.filter((other) => other !== id);
    manualRender();
  });

  el.manual.addEventListener('toggle', () => {
    if (el.manual.open) loadManualEntities(false);
  });
  el.manualReload.addEventListener('click', () => loadManualEntities(true));
  el.manualMerge.addEventListener('click', mergeByHand);

  manualUpdateTitle();
  manualRender();
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
      throw new Error(payload.error || 'The pair could not be hidden');
    }
    groups.delete(card.dataset.groupId);
    selectedGroups.delete(card.dataset.groupId);
    card.remove();
    updateSelectionBar();
    updateResultsBar();
    if (groups.size === 0) {
      el.results.innerHTML = htmlEmpty('0 groups left');
    }
    renderSimple();
    toast('Hidden as not a duplicate', { tone: 'ok' });
    loadDismissals();
  } catch (error) {
    setGroupBusy(card, false);
    updateFoot(card, state);
    toast(error.message, { tone: 'danger' });
  }
}

/* --- unused objects ------------------------------------------------------- */
/* The other half of a tidy archive: objects that are not duplicates of
   anything because they carry no document at all. The scan reports them, this
   section lists them, and deleting them goes through the same log and the same
   undo as a merge. The server checks every id against Paperless-ngx again
   before it deletes, so an object that has meanwhile been used is refused. */

/**
 * The unused objects of a scan result as flat rows, tags before
 * correspondents. A scan of one kind carries only that kind.
 *
 * @param {object} data  a DuplicateScanResult
 * @returns {{kind: string, record: object}[]}
 */
function unusedFromScan(data) {
  const unused = data && data.unused ? data.unused : null;
  if (!unused) return [];
  const rows = [];
  ['tags', 'correspondents'].forEach((kind) => {
    const list = Array.isArray(unused[kind]) ? unused[kind] : [];
    list.forEach((record) => {
      if (record && record.id != null) rows.push({ kind, record });
    });
  });
  return rows;
}

/**
 * The title of the dialog that asks before unused objects are deleted: the
 * number and the kind.
 *
 * @param {{kind: string}[]} entries
 * @returns {string}
 */
function unusedConfirmText(entries) {
  const total = entries.length;
  const kinds = new Set(entries.map((entry) => normalizeKind(entry.kind)));
  const kind = [...kinds][0];
  const label =
    kinds.size === 1
      ? plural(total, KIND_LABELS[kind].toLowerCase(), KIND_PLURALS[kind])
      : plural(total, 'object', 'objects');
  return `Delete ${count(total)} unused ${label}`;
}

function htmlUnusedRows(entries) {
  return entries
    .map(({ kind, record }) => {
      const safeKind = normalizeKind(kind);
      const name = String(record.name == null ? '' : record.name);
      return `<tr data-unused-kind="${esc(safeKind)}" data-unused-id="${num(record.id)}">
        <td data-label="Delete" class="dup-unused__pickcol"><input type="checkbox" class="zr-check dup-unused__pick" aria-label="Select ${esc(name)}"></td>
        <td data-label="Kind"><span class="zr-badge">${htmlIcons[safeKind]}${esc(KIND_LABELS[safeKind])}</span></td>
        <td data-label="Name" class="dup-unused__name"><span class="zr-truncate" title="${esc(name)}">${esc(name)}</span><span class="zr-sm dup-unused__error"></span></td>
        <td data-label="Matching rule">${htmlMatchingRule(record)}</td>
      </tr>`;
    })
    .join('');
}

function unusedRows() {
  return el.unusedBody
    ? [...el.unusedBody.querySelectorAll('tr[data-unused-id]')]
    : [];
}

/** The rows the user ticked, as the entries the request is built from. */
function unusedPicked() {
  return unusedRows()
    .filter((row) => {
      const pick = row.querySelector('.dup-unused__pick');
      return Boolean(pick && pick.checked);
    })
    .map((row) => ({
      kind: normalizeKind(row.dataset.unusedKind),
      id: num(row.dataset.unusedId),
      row,
    }));
}

function updateUnusedSummary() {
  if (!el.unusedSummary) return;
  el.unusedSummary.textContent = `· ${count(unusedRows().length)}`;
}

function updateUnusedButton() {
  if (!el.unusedDelete) return;
  const picked = unusedPicked().length;
  el.unusedDelete.disabled = deletingUnused || picked === 0;
  if (el.unusedSelectAll) el.unusedSelectAll.disabled = deletingUnused;
  el.unusedDelete.innerHTML = deletingUnused
    ? `${htmlIcons.spin}<span>Deleting…</span>`
    : `${htmlIcons.trash}<span>Delete ${num(picked)}</span>`;
}

/**
 * Draws the section for a scan result. A scan that found nothing unused still
 * opens the section: "none" is an answer, and a section that stayed hidden
 * would read as "not looked at".
 */
function renderUnused(data) {
  unusedEntries = unusedFromScan(data);
  if (el.unused && el.unusedBody) {
    el.unusedAlert.innerHTML = '';
    el.unusedBody.innerHTML = unusedEntries.length
      ? htmlUnusedRows(unusedEntries)
      : '<tr><td colspan="4" class="zr-empty">None</td></tr>';
    el.unused.classList.remove('hidden');
    updateUnusedSummary();
    updateUnusedButton();
  }
  renderSimple();
}

function setUnusedBusy(busy) {
  deletingUnused = busy;
  unusedRows().forEach((row) => {
    const pick = row.querySelector('.dup-unused__pick');
    if (pick) pick.disabled = busy;
  });
  updateUnusedButton();
}

/** Finds a row by what the request named, or null when it is already gone. */
function unusedRowOf(kind, id) {
  return (
    unusedRows().find(
      (candidate) =>
        normalizeKind(candidate.dataset.unusedKind) === normalizeKind(kind) &&
        num(candidate.dataset.unusedId) === num(id)
    ) || null
  );
}

/** Puts the reason next to the object that was kept, not into a toast. */
function markUnusedFailure(kind, id, message) {
  const row = unusedRowOf(kind, id);
  if (!row) return;
  const note = row.querySelector('.dup-unused__error');
  if (note) note.textContent = String(message || 'Could not be deleted');
  const pick = row.querySelector('.dup-unused__pick');
  if (pick) pick.checked = false;
}

/** The name the last scan knew an unused object by. */
function unusedName(kind, id) {
  const entry = unusedEntries.find(
    (candidate) =>
      normalizeKind(candidate.kind) === normalizeKind(kind) &&
      num(candidate.record.id) === num(id)
  );
  return entry
    ? String(entry.record.name == null ? '' : entry.record.name)
    : '';
}

/** "Delete 2" of the Unused section: the ticked rows, after one question. */
async function deleteUnused() {
  if (deletingUnused) return;
  const picked = unusedPicked();
  if (picked.length === 0) return;

  const confirmed = await confirmDialog({
    title: unusedConfirmText(picked),
    body: picked.map((entry) => unusedName(entry.kind, entry.id)).join(', '),
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;
  await deleteUnusedEntries(picked);
}

/**
 * Deletes unused objects, one request per kind: the endpoint deletes one kind
 * at a time, and a mixed selection is the normal case after a scan over both.
 * Both ways in end here: the Unused section and the one button of the simple
 * page, which asked its own question before.
 *
 * @param {{kind: string, id: number}[]} entries
 */
async function deleteUnusedEntries(entries) {
  if (el.unusedAlert) el.unusedAlert.innerHTML = '';
  unusedRows().forEach((row) => {
    const note = row.querySelector('.dup-unused__error');
    if (note) note.textContent = '';
  });
  setUnusedBusy(true);
  updateResultButton();

  const byKind = new Map();
  entries.forEach((entry) => {
    const kind = normalizeKind(entry.kind);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(num(entry.id));
  });

  let removed = 0;
  let problems = 0;
  try {
    for (const [kind, ids] of byKind) {
      const payload = await postJson('/api/duplicates/delete', { kind, ids });
      const data = payload.data || {};
      const failed = data.failed || [];
      if (!payload.success && failed.length === 0) {
        throw new Error(
          payload.error || payload.message || 'The delete failed'
        );
      }
      (data.deleted || []).forEach((entry) => {
        const row = unusedRowOf(kind, entry.id);
        if (row) row.remove();
        // The simple page reads the same list, so a deleted object leaves it.
        unusedEntries = unusedEntries.filter(
          (candidate) =>
            !(
              normalizeKind(candidate.kind) === kind &&
              num(candidate.record.id) === num(entry.id)
            )
        );
        removed += 1;
      });
      failed.forEach((entry) => {
        markUnusedFailure(kind, entry.id, entry.error);
        problems += 1;
      });
    }
    if (unusedRows().length === 0 && el.unusedBody) {
      el.unusedBody.innerHTML =
        '<tr><td colspan="4" class="zr-empty">None</td></tr>';
    }
    toast(
      problems === 0
        ? `${count(removed)} unused ${plural(removed, 'object', 'objects')} deleted`
        : `${count(removed)} deleted · ${count(problems)} kept`,
      { tone: problems === 0 ? 'ok' : 'danger' }
    );
  } catch (error) {
    if (el.unusedAlert) {
      el.unusedAlert.innerHTML = htmlAlert(
        'danger',
        'The delete failed',
        error.message
      );
    }
    toast(error.message, { tone: 'danger' });
  }
  setUnusedBusy(false);
  updateUnusedSummary();
  renderSimple();
  // A delete is a log entry like a merge, so the log must show it.
  loadLog(true);
}

function initUnused() {
  if (!el.unused || !el.unusedBody) return;
  el.unusedBody.addEventListener('change', (event) => {
    if (event.target.closest('.dup-unused__pick')) updateUnusedButton();
  });
  if (el.unusedSelectAll) {
    el.unusedSelectAll.addEventListener('click', () => {
      const picks = unusedRows()
        .map((row) => row.querySelector('.dup-unused__pick'))
        .filter(Boolean);
      // One button for both directions: everything ticked means "untick".
      const next = picks.some((pick) => !pick.checked);
      picks.forEach((pick) => {
        pick.checked = next;
      });
      updateUnusedButton();
    });
  }
  if (el.unusedDelete) el.unusedDelete.addEventListener('click', deleteUnused);
}

/* --- names the guard mapped ----------------------------------------------- */
/* Drift prevented where it starts. Every row is one moment where document
   analysis proposed a name and an existing object was used instead; the link
   leads to the document it happened on, so a wrong mapping can be checked
   rather than believed. */

/**
 * The Paperless-ngx URL of a document, or '' when the page does not know the
 * base URL yet (it learns it from a scan) or the mapping carries no document.
 *
 * @param {string} baseUrl
 * @param {number|string|null} id
 * @returns {string}
 */
function mappingDocumentLink(baseUrl, id) {
  const base = String(baseUrl == null ? '' : baseUrl).replace(/\/+$/, '');
  const documentId = num(id);
  if (!base || documentId <= 0) return '';
  return `${base}/documents/${documentId}/details`;
}

function htmlMappingDocument(item) {
  const documentId = num(item.documentId);
  if (documentId <= 0) return '';
  const url = mappingDocumentLink(paperlessUrl, documentId);
  if (!url) return `<span class="zr-mono">#${num(documentId)}</span>`;
  return `<a class="zr-link zr-mono" href="${esc(url)}" target="_blank" rel="noopener">#${num(documentId)}</a>`;
}

function htmlMappingRows(list) {
  return list
    .map((item) => {
      const kind = normalizeKind(item.kind);
      const proposed = String(
        item.proposedName == null ? '' : item.proposedName
      );
      const target = String(item.targetName == null ? '' : item.targetName);
      const pair = `${proposed} → ${target}`;
      const reason = String(item.reason == null ? '' : item.reason);
      const label = REASON_LABELS[reason] || reason || 'unknown';
      const date = window.zrDate.format(item.createdAt, { fallback: '' });
      const dateTitle = window.zrDate.formatDateTime(item.createdAt);
      return `<tr data-mapping-id="${num(item.id)}">
        <td data-label="Date" class="zr-sm zr-faint zr-table__date" title="${esc(dateTitle)}">${esc(date)}</td>
        <td data-label="Kind"><span class="zr-badge">${htmlIcons[kind]}${esc(KIND_LABELS[kind])}</span></td>
        <td data-label="Proposed → mapped to" class="dup-mappings__pair"><span class="zr-truncate" title="${esc(pair)}">${esc(pair)}</span></td>
        <td data-label="Rule"><span class="zr-chip">${esc(label)}</span></td>
        <td data-label="Document">${htmlMappingDocument(item)}</td>
      </tr>`;
    })
    .join('');
}

function renderMappings() {
  if (!el.mappingsBody || !el.mappingsSummary) return;
  el.mappingsSummary.textContent = `· ${count(mappingRecords.length)}`;
  el.mappingsBody.innerHTML = mappingRecords.length
    ? htmlMappingRows(mappingRecords)
    : `<tr><td colspan="5" class="zr-empty">${esc(MAPPINGS_EMPTY)}</td></tr>`;
  if (el.mappingsClear) {
    el.mappingsClear.disabled = mappingRecords.length === 0;
  }
}

/**
 * A scan is the only thing that tells the page the public Paperless-ngx URL,
 * so the document links of an already drawn list are drawn again once it
 * arrives.
 */
function refreshMappingLinks() {
  if (paperlessUrl && mappingRecords.length > 0) renderMappings();
}

async function loadMappings() {
  if (!el.mappingsBody) return;
  try {
    const payload = await requestJson('/api/duplicates/mappings');
    if (!payload.success) {
      throw new Error(payload.error || 'The mappings could not be loaded');
    }
    mappingRecords = payload.data || [];
    el.mappingsAlert.innerHTML = '';
    renderMappings();
  } catch (error) {
    mappingRecords = [];
    renderMappings();
    el.mappingsAlert.innerHTML = htmlAlert(
      'danger',
      'Mappings unavailable',
      error.message
    );
  }
}

async function clearMappings() {
  const confirmed = await confirmDialog({
    title: 'Clear mappings',
    body: `${count(mappingRecords.length)} ${plural(mappingRecords.length, 'mapping', 'mappings')} removed from this list`,
    confirmLabel: 'Clear',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;
  try {
    const payload = await requestJson('/api/duplicates/mappings', {
      method: 'DELETE',
    });
    if (!payload.success) {
      throw new Error(payload.error || 'The mappings could not be cleared');
    }
    mappingRecords = [];
    renderMappings();
    toast('Mappings cleared', { tone: 'ok' });
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  }
}

function initMappings() {
  if (!el.mappings) return;
  if (el.mappingsClear) {
    el.mappingsClear.addEventListener('click', clearMappings);
  }
  loadMappings();
}

/* --- the merge log -------------------------------------------------------- */

/** True for a row that removed unused objects rather than merging any. */
function isDeleteEntry(entry) {
  return String(entry && entry.action) === LOG_ACTION_DELETE;
}

/** True for a row the Simplify tags page wrote. */
function isSplitEntry(entry) {
  return String(entry && entry.action) === LOG_ACTION_SPLIT;
}

/** The names a row is about, in the order the log stored them. */
function logSourceNames(entry) {
  return (entry.sources || [])
    .map((source) => String(source.name == null ? '' : source.name))
    .join(', ');
}

/**
 * The cell next to the kind. A merge names the survivor and, when the merge
 * renamed it, the name it had before. A delete has no survivor: it says what
 * it was and lists the objects it removed.
 */
function htmlLogTargetCell(entry) {
  if (isDeleteEntry(entry)) {
    const names = logSourceNames(entry);
    const title = `Deleted: ${names}`;
    return `<td data-label="Target" class="dup-log__deleted" title="${esc(title)}"><span class="zr-badge zr-badge--warn">${esc(LOG_ACTION_DELETE)}</span><span class="zr-truncate">${esc(title)}</span></td>`;
  }
  if (isSplitEntry(entry)) {
    // The split has no survivor either: what it names is the pair of things
    // the compound tag turned into, "Rechnung + Strom".
    const into = String(entry.targetName == null ? '' : entry.targetName);
    return `<td data-label="Target" class="dup-log__split" title="${esc(into)}"><span class="zr-badge zr-badge--info">${esc(LOG_ACTION_SPLIT)}</span><span class="zr-truncate">${esc(into)}</span></td>`;
  }
  const name = String(entry.targetName == null ? '' : entry.targetName);
  const before = String(
    entry.targetRenamedFrom == null ? '' : entry.targetRenamedFrom
  );
  const htmlRenamed = before
    ? `<span class="zr-sm zr-faint dup-log__renamed" title="${esc(before)}">renamed from ${esc(before)}</span>`
    : '';
  return `<td data-label="Target" class="dup-log__target" title="${esc(name)}"><span class="zr-truncate">${esc(name)}</span>${htmlRenamed}</td>`;
}

function htmlLogRows(entries) {
  return entries
    .map((entry) => {
      const kind = normalizeKind(entry.kind);
      const badge = STATUS_BADGES[entry.status] || {
        tone: '',
        label: String(entry.status || 'unknown'),
      };
      const deleteRow = isDeleteEntry(entry);
      const names = logSourceNames(entry);
      const date = window.zrDate.format(entry.createdAt, { fallback: '' });
      const dateTitle = window.zrDate.formatDateTime(entry.createdAt);
      // A failed undo stays retryable: the next attempt adopts what was
      // already re-created and moves the remaining documents.
      const undoable =
        entry.status === 'done' ||
        entry.status === 'partial' ||
        entry.status === 'undo_failed';
      const undoLabel = entry.status === 'undo_failed' ? 'Retry undo' : 'Undo';
      const htmlUndo = undoable
        ? `<button type="button" class="zr-btn dup-undo-btn" data-id="${num(entry.id)}">${htmlIcons.undo} ${esc(undoLabel)}</button>`
        : '';
      // A delete moved no document and merged nothing away; both cells stay
      // empty rather than showing a zero that reads like a failed merge.
      const htmlMerged = deleteRow
        ? '<td data-label="Merged" class="dup-log__sources zr-faint"></td>'
        : `<td data-label="Merged" class="zr-truncate dup-log__sources" title="${esc(names)}">${esc(names)}</td>`;
      const htmlDocuments = deleteRow
        ? '<td data-label="Documents" class="zr-mono zr-faint"></td>'
        : `<td data-label="Documents" class="zr-mono">${num(entry.documentsMoved)}</td>`;
      // An attribute fragment, not a value, so the row can be found by what
      // it records without a second class.
      const htmlAction = deleteRow
        ? ' data-log-action="delete"'
        : isSplitEntry(entry)
          ? ' data-log-action="split"'
          : '';
      return `<tr data-log-id="${num(entry.id)}"${htmlAction}>
        <td data-label="Date" class="zr-sm zr-faint zr-table__date" title="${esc(dateTitle)}">${esc(date)}</td>
        <td data-label="Kind"><span class="zr-badge">${htmlIcons[kind]}${esc(KIND_LABELS[kind])}</span></td>
        ${htmlLogTargetCell(entry)}
        ${htmlMerged}
        ${htmlDocuments}
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
  return `<div class="zr-alert zr-alert--danger">${htmlIcons.danger}<div class="zr-alert__body"><div class="zr-alert__title">Undo incomplete</div><ul class="dup-dialog__list">${htmlRows}</ul></div></div>`;
}

async function loadLog(reset) {
  if (reset) {
    logOffset = 0;
    logEntries.clear();
    el.logBody.innerHTML = `<tr><td colspan="7" class="zr-empty">${htmlIcons.spin} Loading</td></tr>`;
    // The history line of the simple page reads the same log.
    loadHistory();
  }
  try {
    const params = new URLSearchParams({
      limit: String(LOG_PAGE_SIZE),
      offset: String(logOffset),
    });
    const payload = await requestJson(`/api/duplicates/log?${params}`);
    if (!payload.success) {
      throw new Error(payload.error || 'The log could not be loaded');
    }
    const entries = payload.data || [];
    logTotal = num(payload.recordsTotal);
    entries.forEach((entry) => logEntries.set(num(entry.id), entry));
    const markup = htmlLogRows(entries);
    if (logOffset === 0) {
      el.logBody.innerHTML =
        markup || '<tr><td colspan="7" class="zr-empty">None</td></tr>';
    } else {
      el.logBody.insertAdjacentHTML('beforeend', markup);
    }
    logOffset += entries.length;
    el.logInfo.textContent = logTotal
      ? `${count(logOffset)} of ${count(logTotal)}`
      : '';
    el.logMeta.textContent = `· ${count(logTotal)}`;
    el.logMore.classList.toggle('hidden', logOffset >= logTotal);
  } catch (error) {
    el.logBody.innerHTML = `<tr><td colspan="7" class="zr-empty zr-danger-text">${esc(error.message)}</td></tr>`;
  }
}

/**
 * What undoing one log row takes back, as the dialog says it: the names that
 * come back, and what else the undo changes.
 */
function undoFactsText(entry) {
  const names = logSourceNames(entry);
  if (isSplitEntry(entry)) {
    return `${names} re-created · document type and topics removed`;
  }
  if (isDeleteEntry(entry)) return `${names} re-created`;
  const moved = num(entry.documentsMoved);
  return `${names} re-created · ${count(moved)} ${plural(moved, 'document', 'documents')} moved back`;
}

async function undoMerge(id) {
  const entry = logEntries.get(num(id)) || historyEntryWith(id);
  if (!entry) return;
  const target = String(entry.targetName == null ? '' : entry.targetName);
  const confirmed = await confirmDialog({
    title: isSplitEntry(entry)
      ? 'Undo split'
      : isDeleteEntry(entry)
        ? 'Undo delete'
        : `Undo merge into ${target}`,
    body: undoFactsText(entry),
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
      toast('Undone', { tone: 'ok' });
    } else if (result.status === 'undo_failed') {
      el.logAlert.innerHTML = htmlUndoProblems(result);
      toast('Undo incomplete', { tone: 'danger' });
    } else {
      throw new Error(payload.error || payload.message || 'The undo failed');
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
    return '<p class="zr-sm zr-faint">None</p>';
  }
  return list
    .map((item) => {
      const kind = normalizeKind(item.kind);
      const pair = `${String(item.nameA == null ? '#' + num(item.idA) : item.nameA)} · ${String(item.nameB == null ? '#' + num(item.idB) : item.nameB)}`;
      return `<div class="dup-hidden__row" data-dismissal-id="${num(item.id)}">
        <span class="zr-badge">${htmlIcons[kind]}${esc(KIND_LABELS[kind])}</span>
        <span class="zr-grow zr-truncate" title="${esc(pair)}">${esc(pair)}</span>
        <button type="button" class="zr-btn dup-restore-btn" data-id="${num(item.id)}">Show again</button>
      </div>`;
    })
    .join('');
}

function updateDismissalCount() {
  el.dismissalsSummary.textContent = `· ${count(dismissalCount)}`;
}

async function loadDismissals() {
  try {
    const payload = await requestJson('/api/duplicates/dismissals');
    if (!payload.success) {
      throw new Error(payload.error || 'The hidden pairs could not be loaded');
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
      throw new Error(payload.error || 'The pair could not be restored');
    }
    row.remove();
    dismissalCount = Math.max(0, dismissalCount - 1);
    updateDismissalCount();
    if (dismissalCount === 0) {
      el.dismissalsList.innerHTML = htmlDismissalRows([]);
    }
    toast('Shown again in the next scan', { tone: 'ok' });
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  }
}

/* --- the simple page: one head, three checklists, one line of history ----- */
/* What a run found, read as what will happen: the groups the spelling or the
   model settled, ticked; the ones nothing settled, not ticked; the objects no
   document uses, ticked for deletion. Every row is a group card of the
   advanced page read another way, so a merge from here is the merge of that
   card, and a tick here moves nothing but the numbers of the one button. */

/** At or above this a pair is the same thing whatever a model would say. */
const PLAIN_SCORE = 0.95;

/**
 * Warnings that are a question rather than a note. An inbox tag and a large
 * group are things to know about a merge; these four only the person can
 * decide, so a group carrying one of them is Unsure however well it scored.
 */
const ASK_WARNINGS = [
  'has-matching-rule',
  'configured-tag',
  'no-permission',
  'owner-differs',
];

/**
 * The chip of a proposed row: the rule that settled it, in a word or two.
 * The keys are the contract (AiVerdict.basis in schemas.js).
 */
const CHIP_BY_BASIS = {
  'case-or-spacing': 'case',
  umlaut: 'umlaut',
  'legal-form': 'legal form',
  plural: 'plural',
  abbreviation: 'abbreviation',
  translation: 'translation',
  synonym: 'synonym',
  typo: 'typo',
};

/** The same for a group no model saw: what the string matcher found. */
const CHIP_BY_REASON = {
  'exact-normalized': 'case',
  'umlaut-variant': 'umlaut',
  'legal-form': 'legal form',
  plural: 'plural',
  'token-order': 'word order',
  prefix: 'prefix',
  fuzzy: 'spelling',
  semantic: 'model',
};

/** Why a group is Unsure when a warning is the reason, as one clause. */
const REASON_BY_WARNING = {
  'has-matching-rule': 'matching rule on a source',
  'configured-tag': 'named in the settings',
  'no-permission': 'no permission',
  'owner-differs': 'different owners',
};

/** A reason clause longer than this is cut; its title keeps the whole. */
const CHECKLIST_REASON_MAX = 64;

/** The months of a history line. */
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

/**
 * Which checklist a group belongs in. Pure on purpose:
 * tests/test-duplicates-assistant-ui.js runs it over every kind of group.
 *
 * @param {object} group      a scan group, with its verdict when there is one
 * @param {number} threshold  the sensitivity the scan was made with
 * @returns {'proposed'|'unsure'}
 */
function checklistOf(group, threshold) {
  const source = group || {};
  const verdict = source.aiVerdict;
  const value = verdict ? String(verdict.verdict) : '';
  if (value === 'different' || value === 'unsure') return 'unsure';
  const warnings = Array.isArray(source.warnings) ? source.warnings : [];
  if (warnings.some((warning) => ASK_WARNINGS.includes(warning))) {
    return 'unsure';
  }
  const reasons = Array.isArray(source.reasons) ? source.reasons : [];
  if (
    reasons.includes('exact-normalized') ||
    num(source.confidence) >= PLAIN_SCORE
  ) {
    return 'proposed';
  }
  // A pair the model confirmed below the sensitivity is still a pair the
  // scan would not have proposed; only a sure "same" carries it alone.
  if (
    value === 'same' &&
    (isSureSame(verdict) || num(source.confidence) >= num(threshold))
  ) {
    return 'proposed';
  }
  return 'unsure';
}

/** The word on the chip of a proposed row. Pure. */
function checklistChip(group) {
  const source = group || {};
  const verdict = source.aiVerdict;
  if (verdict && String(verdict.verdict) === 'same') {
    const basis = verdict.basis == null ? '' : String(verdict.basis);
    if (CHIP_BY_BASIS[basis]) return CHIP_BY_BASIS[basis];
    if (!isRuleVerdict(verdict)) return 'model';
  }
  const reasons = Array.isArray(source.reasons) ? source.reasons : [];
  const named = Object.keys(CHIP_BY_REASON).find((reason) =>
    reasons.includes(reason)
  );
  return named ? CHIP_BY_REASON[named] : 'spelling';
}

/** Why a row is Unsure, as one clause: what the model said comes first. Pure. */
function checklistReason(group) {
  const source = group || {};
  const verdict = source.aiVerdict;
  const value = verdict ? String(verdict.verdict) : '';
  if (value === 'different' || value === 'unsure') {
    const said = String(verdict.reason == null ? '' : verdict.reason).trim();
    if (said !== '') return said;
    const basis = basisLabel(verdict);
    return basis === '' ? value : basis.toLowerCase();
  }
  const warnings = Array.isArray(source.warnings) ? source.warnings : [];
  const warning = ASK_WARNINGS.find((one) => warnings.includes(one));
  if (warning) return REASON_BY_WARNING[warning];
  if (value === 'same') return 'low confidence';
  return `${pct(source.confidence)}% alike`;
}

/** A clause cut to the length a row has room for. */
function clip(text, max) {
  const raw = String(text == null ? '' : text);
  return raw.length > max ? `${raw.slice(0, max - 1).trimEnd()}…` : raw;
}

/**
 * One row of a checklist for one group: what goes, into what, how many
 * documents move, what it writes, and why it sits where it sits. Pure.
 *
 * @param {object} state      a registered group state
 * @param {number} threshold  the sensitivity the scan was made with
 */
function checklistRow(state, threshold) {
  const group = state.group;
  const target = memberOf(state, state.targetId);
  const sources = selectedSources(state);
  const documents = countDocuments(sources);
  const list = checklistOf(group, threshold);
  const reason = list === 'unsure' ? checklistReason(group) : '';
  return {
    key: `g:${group.id}`,
    list,
    groupId: String(group.id),
    sources: sources.map((member) =>
      String(member.name == null ? '' : member.name)
    ),
    target: target ? String(target.name == null ? '' : target.name) : '',
    documents,
    writes: documents + sources.length,
    chip: list === 'proposed' ? checklistChip(group) : '',
    reason: clip(reason, CHECKLIST_REASON_MAX),
    reasonTitle: reason,
  };
}

/** One row of the Unused checklist: one object, one deletion. Pure. */
function unusedChecklistRow(entry) {
  const kind = normalizeKind(entry.kind);
  const id = num(entry.record.id);
  return {
    key: `u:${kind}:${id}`,
    list: 'unused',
    kind,
    id,
    name: String(entry.record.name == null ? '' : entry.record.name),
    documents: 0,
    writes: 1,
    chip: '',
    reason: '',
    reasonTitle: '',
  };
}

/** Most documents first, then by name. */
function compareRows(a, b) {
  if (b.documents !== a.documents) return b.documents - a.documents;
  return String(a.target || a.name).localeCompare(String(b.target || b.name));
}

/**
 * The three checklists of the simple page. Pure: the groups that can still
 * be merged, the unused objects of the scan, and the sensitivity it ran at.
 *
 * An unused object that is also in a group belongs to that group: listed
 * under Unused as well it would be deleted after the merge already had, or
 * deleted as the name the merge keeps. `grouped` is every group on the page,
 * the merged ones included; without it, the listed ones.
 *
 * @returns {{proposed: object[], unsure: object[], unused: object[]}}
 */
function buildChecklists(states, unused, threshold, grouped) {
  const listed = states || [];
  const inGroup = new Set();
  (grouped || listed).forEach((state) => {
    const kind = normalizeKind(state.group.kind);
    (state.group.members || []).forEach((member) => {
      inGroup.add(`${kind}:${num(member.id)}`);
    });
  });
  const rows = listed.map((state) => checklistRow(state, threshold));
  return {
    proposed: rows.filter((row) => row.list === 'proposed').sort(compareRows),
    unsure: rows.filter((row) => row.list === 'unsure').sort(compareRows),
    unused: (unused || [])
      .filter(
        (entry) =>
          !inGroup.has(`${normalizeKind(entry.kind)}:${num(entry.record.id)}`)
      )
      .map(unusedChecklistRow),
  };
}

/** A row's tick: what the person set, or what its list starts with. Pure. */
function isTicked(row, ticks) {
  if (ticks && ticks.has(row.key)) return ticks.get(row.key) === true;
  return row.list !== 'unsure';
}

/**
 * The two numbers of the one button: the ticked merges, and every write the
 * ticked rows cost. An unused row deletes, it does not merge. Pure.
 */
function tickTotals(lists, ticks) {
  let merges = 0;
  let writes = 0;
  [...lists.proposed, ...lists.unsure].forEach((row) => {
    if (!isTicked(row, ticks)) return;
    merges += 1;
    writes += row.writes;
  });
  lists.unused.forEach((row) => {
    if (isTicked(row, ticks)) writes += row.writes;
  });
  return { merges, writes };
}

/** "275 scanned · 34 merges proposed". Pure. */
function resultHeadline(totals, proposed) {
  const source = totals || {};
  const kinds = ['tags', 'correspondents'].filter(
    (kind) => source[kind] != null
  );
  const scannedCount = kinds.reduce((sum, kind) => sum + num(source[kind]), 0);
  const merges = `${count(proposed)} ${plural(proposed, 'merge', 'merges')} proposed`;
  return kinds.length > 0
    ? `${count(scannedCount)} scanned · ${merges}`
    : merges;
}

/**
 * What the run behind the result cost: "12 requests · 38k tokens · ~2 min",
 * and the split for the small bar. A result no run is known for says so on
 * an instance that has a model, and says nothing on one that has none. Pure.
 *
 * @param {object|null} review    the `aiReview` block of the last answer
 * @param {object|null} progress  the job's last progress, for time and split
 * @returns {{text: string, split: object|null}}
 */
function resultCost(review, progress) {
  // A result nobody asked a model about has no cost line at all.
  if (!review) return { text: '', split: null };
  const state = progress || {};
  const requests = num(review.requests);
  const tokens = num(review.tokens);
  const seconds = num(state.elapsedMs) / 1000;
  const parts = [
    `${count(requests)} ${plural(requests, 'request', 'requests')}`,
  ];
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  if (seconds > 0) parts.push(roughTime(seconds));
  const split = {
    prompt: num(state.promptTokens),
    completion: num(state.completionTokens),
    thinking: num(state.thinkingTotal),
  };
  const total = split.prompt + split.completion + split.thinking;
  return { text: parts.join(' · '), split: total > 0 ? split : null };
}

/** The small bar of the cost line: the run's tokens as its own whole. */
function htmlMiniBar(split) {
  const total = num(split.prompt) + num(split.completion) + num(split.thinking);
  const share = (value) =>
    total <= 0 ? 0 : Math.round((num(value) / total) * 1000) / 10;
  const label = `${formatTokens(split.prompt)} question · ${formatTokens(split.completion)} answer · ${formatTokens(split.thinking)} thinking`;
  return `<span class="zr-tokenbar zr-tokenbar--mini" role="img" aria-label="${esc(label)}" title="${esc(label)}"><span class="zr-tokenbar__track"><span class="zr-tokenbar__seg zr-tokenbar__seg--prompt" style="width: ${num(share(split.prompt))}%"></span><span class="zr-tokenbar__seg zr-tokenbar__seg--answer" style="width: ${num(share(split.completion))}%"></span><span class="zr-tokenbar__seg zr-tokenbar__seg--thinking" style="width: ${num(share(split.thinking))}%"></span></span></span>`;
}

/** One row of a checklist. */
function htmlChecklistRow(row, ticked) {
  const htmlChecked = ticked ? ' checked' : '';
  const dimClass = row.list === 'unsure' ? ' zr-checklist__row--dim' : '';
  const meta =
    row.list === 'unused'
      ? '0 documents · delete'
      : `${count(row.documents)} ${plural(row.documents, 'document', 'documents')}`;
  const htmlName =
    row.list === 'unused'
      ? esc(row.name)
      : `${esc(row.sources.join(', '))}<span class="dup-checklist__arrow"> → </span><span class="zr-checklist__name">${esc(row.target)}</span>`;
  let htmlEnd = '';
  if (row.chip) {
    htmlEnd = `<span class="zr-checklist__chip">${esc(row.chip)}</span>`;
  } else if (row.reason) {
    htmlEnd = `<span class="zr-checklist__reason" title="${esc(row.reasonTitle)}">${esc(row.reason)}</span>`;
  }
  return `<label class="zr-checklist__row${esc(dimClass)}"><input class="zr-check zr-checklist__box" type="checkbox" data-key="${esc(row.key)}"${htmlChecked}><span class="zr-checklist__text">${htmlName}<span class="zr-checklist__meta">${esc(meta)}</span></span>${htmlEnd}</label>`;
}

/**
 * One checklist: its head with the count, ten rows, and the button that
 * shows the rest. A list without rows is not drawn at all.
 *
 * @param {string} name   'proposed', 'unsure' or 'unused'
 * @param {string} title  what the head says
 * @param {object[]} rows
 * @param {{ticks: Map, open: boolean, htmlAction?: string}} options
 */
function htmlChecklist(name, title, rows, options) {
  if (rows.length === 0) return '';
  const shown = options.open ? rows : rows.slice(0, CHECKLIST_ROWS);
  const hidden = rows.length - shown.length;
  const htmlRows = shown
    .map((row) => htmlChecklistRow(row, isTicked(row, options.ticks)))
    .join('');
  const htmlMore =
    hidden > 0
      ? `<div class="zr-checklist__more"><button type="button" class="zr-btn dup-checklist-more" data-list="${esc(name)}">${esc(`${count(hidden)} more`)}</button></div>`
      : '';
  const htmlAction = options.htmlAction || '';
  return `<section class="zr-checklist dup-checklist" data-list="${esc(name)}" aria-label="${esc(title)}">
      <div class="zr-checklist__head">
        <span class="zr-label">${esc(title)} <span class="zr-checklist__count">${esc(`· ${count(rows.length)}`)}</span></span>
        ${htmlAction}
      </div>
      <div class="dup-checklist__rows">${htmlRows}${htmlMore}</div>
    </section>`;
}

/** The checklists of the cards on the page, as they stand now. */
function currentChecklists() {
  const states = [];
  const all = [];
  eachGroupCard((card, state) => {
    all.push(state);
    if (selectBlockReason(card, state) === '') states.push(state);
  });
  const threshold = scanOptions ? scanOptions.threshold : currentThreshold();
  return buildChecklists(states, unusedEntries, threshold, all);
}

/** Which of the simple page's parts show: the card, or the result. */
function updateSimpleSurface() {
  const live = Boolean(
    el.aiProgress && el.aiProgress.classList.contains('dup-progress--live')
  );
  const held = simple.held === true;
  const showResult = scanned && !proposing && !live && !held;
  if (el.result) el.result.classList.toggle('hidden', !showResult);
  // The start carries the sentence of the page as its title, so the line
  // above it is drawn only with a result.
  if (el.lede) el.lede.classList.toggle('hidden', !showResult);
  if (el.empty) {
    el.empty.classList.toggle(
      'hidden',
      showResult || live || (scanned && proposing && !held)
    );
  }
  if (el.findBtn) {
    el.findBtn.disabled = scanning || aiReviewing || merging || proposing;
    el.findBtn.textContent = scanning ? 'Scanning…' : 'Find duplicates';
  }
}

/** The one button of the result head; its numbers follow the ticks. */
function updateResultButton(lists) {
  if (!el.resultMergeBtn) return;
  const totals = tickTotals(lists || currentChecklists(), simple.ticks);
  el.resultMergeBtn.textContent = mergeLabel(totals.merges, totals.writes);
  el.resultMergeBtn.disabled = merging || deletingUnused || totals.writes === 0;
}

function renderResultCost() {
  if (!el.resultCost) return;
  const cost = resultCost(lastRunReview, lastRunProgress);
  const htmlBar = cost.split ? htmlMiniBar(cost.split) : '';
  el.resultCost.classList.toggle('hidden', cost.text === '');
  el.resultCost.innerHTML =
    cost.text === '' ? '' : `${htmlBar}<span>${esc(cost.text)}</span>`;
}

/** Draws the head and the three checklists from the cards on the page. */
function renderSimple() {
  updateSimpleSurface();
  if (!el.checklists) return;
  const lists = currentChecklists();
  if (el.resultHeadline) {
    el.resultHeadline.textContent = resultHeadline(
      lastScanTotals,
      lists.proposed.length
    );
  }
  renderResultCost();
  const htmlReview =
    lists.unsure.length > 0
      ? '<button type="button" class="zr-btn dup-review-one">Review one by one</button>'
      : '';
  el.checklists.innerHTML = [
    htmlChecklist('proposed', 'Proposed', lists.proposed, {
      ticks: simple.ticks,
      open: simple.open.has('proposed'),
    }),
    htmlChecklist('unsure', 'Unsure', lists.unsure, {
      ticks: simple.ticks,
      open: simple.open.has('unsure'),
      htmlAction: htmlReview,
    }),
    htmlChecklist('unused', 'Unused', lists.unused, {
      ticks: simple.ticks,
      open: simple.open.has('unused'),
    }),
  ].join('');
  updateResultButton(lists);
}

/**
 * The one button of the result head: the ticked groups through the batch
 * merge, then the ticked unused objects through their delete, after one
 * question for both.
 */
async function mergeTicked() {
  if (merging || deletingUnused) return;
  const lists = currentChecklists();
  const entries = [];
  [...lists.proposed, ...lists.unsure].forEach((row) => {
    if (!isTicked(row, simple.ticks)) return;
    const found = groupEntry(row.groupId);
    const entry = found ? entryFor(found.card, found.state) : null;
    if (entry) entries.push(entry);
  });
  const unused = lists.unused
    .filter((row) => isTicked(row, simple.ticks))
    .map((row) => ({ kind: row.kind, id: row.id, name: row.name }));
  if (entries.length === 0 && unused.length === 0) return;
  const answer = await confirmMerge(entries, unused);
  if (!answer.ok) return;
  if (entries.length > 0) await runBatch(entries, answer.copyMatchingRule);
  if (unused.length > 0) await deleteUnusedEntries(unused);
}

/** A log date as a Date, or null; SQLite's space is what Safari refuses. */
function parseDay(value) {
  if (value === null || value === undefined || value === '') return null;
  const date =
    value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "20 Sep", with the year when it is not this one. Pure. */
function shortDay(value, now) {
  const date = parseDay(value);
  if (!date) return '';
  const today = now instanceof Date ? now : new Date();
  const text = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === today.getFullYear()
    ? text
    : `${text} ${date.getFullYear()}`;
}

/**
 * The line under the simple page: the merges of the newest day in the log,
 * and the newest merge, which its Undo takes back. Only merges count, and
 * only the ones that can still be undone. Pure.
 *
 * @param {object[]} entries  rows of the merge log
 * @param {Date} [now]
 * @returns {{text: string, entry: object}|null}
 */
function historyOf(entries, now) {
  const undoable = (Array.isArray(entries) ? entries : [])
    .filter(
      (entry) =>
        !isDeleteEntry(entry) &&
        !isSplitEntry(entry) &&
        ['done', 'partial', 'undo_failed'].includes(String(entry.status))
    )
    .sort((a, b) => num(b.id) - num(a.id));
  if (undoable.length === 0) return null;
  const newest = undoable[0];
  const day = shortDay(newest.createdAt, now);
  const merges = undoable.filter(
    (entry) => shortDay(entry.createdAt, now) === day
  ).length;
  const on = day === '' ? '' : ` on ${day}`;
  return {
    text: `History · ${count(merges)} ${plural(merges, 'merge', 'merges')}${on}`,
    entry: newest,
  };
}

/** Reads the merges of the log for the history line. */
/**
 * The line under the start button: what the last run of this task cost,
 * from the run stats the estimate carries. Pure; '' when no run was kept.
 *
 * @param {object|null} lastRun  `lastRun` of an estimate
 * @param {Date} [now]
 * @returns {string}
 */
function startFactsText(lastRun, now) {
  const run = lastRun || {};
  if (num(run.requests) <= 0) return '';
  const items = num(run.items);
  const tokens =
    num(run.promptTokens) + num(run.completionTokens) + num(run.thinkingTokens);
  const parts = [`Last run ${shortDay(run.finishedAt, now)}`];
  if (items > 0)
    parts.push(`${count(items)} ${plural(items, 'pair', 'pairs')}`);
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  if (num(run.seconds) > 0) parts.push(roughTime(num(run.seconds)));
  return parts.join(' · ');
}

/** Reads the last run for the start's facts line; nothing without a model. */
async function loadStartFacts() {
  if (!el.startFacts || !aiReviewOffered()) return;
  const estimate = await fetchRunEstimate({
    kind: 'all',
    threshold: currentThreshold(),
  });
  const text = startFactsText(estimate.lastRun, new Date());
  el.startFacts.textContent = text;
  el.startFacts.classList.toggle('hidden', text === '');
}

async function loadHistory() {
  if (!el.historyLine) return;
  try {
    const params = new URLSearchParams({ action: 'merge', limit: '100' });
    const payload = await requestJson(`/api/duplicates/log?${params}`);
    const history = payload.success
      ? historyOf(payload.data || [], new Date())
      : null;
    historyEntry = history ? history.entry : null;
    if (el.historyText)
      el.historyText.textContent = history ? history.text : '';
    el.historyLine.classList.toggle('hidden', history === null);
  } catch {
    // The line is a convenience; the log of the advanced page says the rest.
    historyEntry = null;
    el.historyLine.classList.add('hidden');
  }
}

/** The history line's entry, when that is the one asked for. */
function historyEntryWith(id) {
  return historyEntry && num(historyEntry.id) === num(id) ? historyEntry : null;
}

/** "Undo" of the history line: the newest merge, as the log undoes it. */
async function undoLast() {
  if (!historyEntry) return;
  await undoMerge(historyEntry.id);
}

/** The marks of the stack, the request log and the apply progress. */
const htmlMarks = {
  ok: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-check"/></svg>',
  arrow:
    '<svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#i-arrow-left"/></svg>',
  running:
    '<svg class="zr-icon zr-icon--sm zr-icon--spin" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg>',
  waiting:
    '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-clock"/></svg>',
  failed:
    '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg>',
};

/**
 * The three segments of a token bar, as widths in percent. They are data, not
 * theme, which is why they are set inline rather than through a class.
 */
function drawTokenbar(parts, prompt, completion, thinking) {
  if (!parts.bar) return;
  const total = num(prompt) + num(completion) + num(thinking);
  if (total <= 0) {
    parts.bar.classList.add('hidden');
    return;
  }
  parts.bar.classList.remove('hidden');
  const share = (value) => `${Math.round((num(value) / total) * 100)}%`;
  if (parts.prompt) parts.prompt.style.width = share(prompt);
  if (parts.answer) parts.answer.style.width = share(completion);
  if (parts.thinking) parts.thinking.style.width = share(thinking);
  if (!parts.legend) return;
  parts.legend.innerHTML = `<span class="zr-tokenbar__key"><span class="zr-tokenbar__dot zr-tokenbar__dot--prompt"></span>${esc(formatTokens(prompt))} question</span><span class="zr-tokenbar__key"><span class="zr-tokenbar__dot zr-tokenbar__dot--answer"></span>${esc(formatTokens(completion))} answer</span><span class="zr-tokenbar__key"><span class="zr-tokenbar__dot zr-tokenbar__dot--thinking"></span>${esc(formatTokens(thinking))} thinking</span>`;
}

/** One row of a ledger: the number, then what it is. */
function htmlLedgerItem(value, label, quiet) {
  const quietClass = quiet ? ' zr-ledger__value--quiet' : '';
  return `<span class="zr-ledger__item"><span class="zr-ledger__value${esc(quietClass)}">${esc(value)}</span> ${esc(label)}</span>`;
}

/** The card behind a group id, or null when it has been merged away. */
function cardFor(groupId) {
  let found = null;
  eachGroupCard((card) => {
    if (card.dataset.groupId === String(groupId)) found = card;
  });
  return found;
}

/** Both halves of a group, its state and its card, or null when it is gone. */
function groupEntry(groupId) {
  const state = groups.get(String(groupId));
  const card = cardFor(groupId);
  return state && card ? { state, card } : null;
}

/* --- the stack: one pair per screen --------------------------------------- */
/* "Review one by one" asks the Unsure rows one at a time: two sides, the
   evidence under each name, what the model said and what merging writes. A
   decision is a tick: Merge ticks the row, Keep both unticks it, Later puts
   it at the end of the queue. Nothing is written until the one button of the
   result head is pressed. The keys are Enter, Esc and L. */

/** Document titles a decision card shows per side, when the review fetched any. */
const DECISION_SAMPLES = 3;

const stack = {
  /** Group ids in the order they are asked; a pair put off comes again. */
  ids: [],
  /** Where in the ids the stack is; ids.length when it is through. */
  index: 0,
  /** How many distinct pairs the stack was opened on. */
  total: 0,
  /** groupId -> 'merge', 'keep' or 'later': the answer each pair has now. */
  answers: new Map(),
  /** What has been decided, newest last, so the last one can be taken back. */
  decisions: [],
  /** The pairs put off since the queue last came round. */
  later: [],
};

/** The group the stack is asking about right now, or null when it is done. */
function stackState() {
  const id = stack.ids[stack.index];
  return id === undefined ? null : groups.get(String(id)) || null;
}

/** What a member has to say for itself: its documents and its matching rule. */
function memberMetaText(member) {
  const documents = num(member.documentCount);
  const algorithm = num(member.matchingAlgorithm);
  const match = String(member.match == null ? '' : member.match).trim();
  const rule =
    algorithm === 0 || match === ''
      ? 'no matching rule'
      : `rule: ${ALGORITHM_LABELS[algorithm] || 'none'} “${match}”`;
  return `${count(documents)} ${plural(documents, 'document', 'documents')} · ${rule}`;
}

/** Up to three recent document titles, when the review fetched any. */
function htmlDecisionSamples(member) {
  const titles = Array.isArray(member.sampleTitles) ? member.sampleTitles : [];
  if (titles.length === 0) return '';
  const htmlRows = titles
    .slice(0, DECISION_SAMPLES)
    .map((title) => `<li>${esc(String(title == null ? '' : title))}</li>`)
    .join('');
  return `<ul class="zr-decision__samples">${htmlRows}</ul>`;
}

/** One side of a decision: what stays, or what is merged away. */
function htmlDecisionSide(member, from) {
  const sideClass = from ? ' zr-decision__side--from' : '';
  const nameClass = from ? ' zr-decision__name--from' : '';
  const name = String(member.name == null ? '' : member.name);
  return `<div class="zr-decision__side${esc(sideClass)}">
      <div class="zr-decision__label">${esc(from ? 'Merge away' : 'Keep')}</div>
      <div class="zr-decision__name${esc(nameClass)}">${esc(name)}</div>
      <div class="zr-decision__meta">${esc(memberMetaText(member))}</div>
      ${htmlDecisionSamples(member)}
    </div>`;
}

/** The kind, how it was found and how alike the two names are. */
function htmlDecisionHead(state) {
  const group = state.group;
  const kind = normalizeKind(group.kind);
  const htmlReasons = (Array.isArray(group.reasons) ? group.reasons : [])
    .map(
      (reason) =>
        `<span class="zr-badge">${esc(REASON_LABELS[reason] || reason)}</span>`
    )
    .join('');
  const htmlCandidate =
    group.source === AI_CANDIDATE_SOURCE
      ? '<span class="zr-badge zr-badge--info">Found by the model</span>'
      : '';
  return `<div class="zr-decision__head">
      <span class="zr-badge zr-badge--brand">${htmlIcons[kind]}${esc(KIND_LABELS[kind])}</span>
      ${htmlReasons}${htmlCandidate}${htmlVerdictChip(group.aiVerdict)}
      <span class="zr-badge">${pct(group.confidence)}% alike</span>
    </div>`;
}

/**
 * The per-member ticks a group of more than two members keeps inside its
 * card: the target stays choosable and a member can be left out of the merge
 * without leaving the stack.
 */
function htmlDecisionMembers(state) {
  const members = Array.isArray(state.group.members) ? state.group.members : [];
  if (members.length <= 2) return '';
  const htmlRows = members
    .map((member) => {
      const id = num(member.id);
      const isTarget = id === state.targetId;
      const htmlTargetChecked = isTarget ? ' checked' : '';
      const htmlSourceChecked = state.selected.has(id) ? ' checked' : '';
      const name = String(member.name == null ? '' : member.name);
      const htmlMerge = isTarget
        ? '<span class="dup-decision__nopick"></span>'
        : `<input type="checkbox" class="zr-check dup-stack-source" value="${num(id)}"${htmlSourceChecked} aria-label="Merge ${esc(name)} away">`;
      return `<li class="dup-decision__member">
          <input type="radio" class="zr-check dup-stack-target" name="dupStackTarget" value="${num(id)}"${htmlTargetChecked} aria-label="Keep ${esc(name)}">
          ${htmlMerge}
          <span class="zr-truncate dup-decision__membername" title="${esc(name)}">${esc(name)}</span>
          <span class="zr-sm zr-faint zr-mono">${num(member.documentCount)}</span>
        </li>`;
    })
    .join('');
  return `<div class="dup-decision__members">
      <span class="zr-label">${esc(`${members.length} names · keep · merge away`)}</span>
      <ul class="dup-decision__memberlist">${htmlRows}</ul>
    </div>`;
}

/**
 * What merging a group writes, in numbers: "2 objects · 17 document
 * rewrites · 2 deletions". The stack, the card and merge by hand say it the
 * same way.
 *
 * @param {number} sources    objects merged away
 * @param {number} documents  documents that move
 */
function mergeFactsText(sources, documents) {
  return `${count(sources)} ${plural(sources, 'object', 'objects')} · ${count(documents)} document ${plural(documents, 'rewrite', 'rewrites')} · ${count(sources)} ${plural(sources, 'deletion', 'deletions')}`;
}

/** The card of the stack: two sides, the evidence, the note and the buttons. */
function htmlDecisionCard(state) {
  const target = memberOf(state, state.targetId);
  const sources = selectedSources(state);
  if (!target || sources.length === 0) return '';
  const verdict = state.group.aiVerdict;
  const said = verdict ? shortReason(verdict.reason) : '';
  const htmlNote =
    said === '' ? '' : `<p class="zr-decision__note">${esc(said)}</p>`;
  const htmlAway = sources
    .map((member) => htmlDecisionSide(member, true))
    .join('');
  const facts = mergeFactsText(sources.length, countDocuments(sources));
  return `<div class="zr-decision" data-group-id="${esc(state.group.id)}">
      ${htmlDecisionHead(state)}
      <div class="zr-decision__sides">
        ${htmlDecisionSide(target, false)}
        <div class="zr-decision__arrow">${htmlMarks.arrow}</div>
        ${htmlAway}
      </div>
      ${htmlDecisionMembers(state)}
      ${htmlNote}
      <p class="zr-sm zr-faint dup-decision__consequence">${esc(facts)}</p>
      <div class="zr-decision__actions">
        <button type="button" class="zr-btn zr-btn--primary dup-stack-merge">${htmlIcons.merge}<span>Merge</span></button>
        <button type="button" class="zr-btn dup-stack-keep">Keep both</button>
        <button type="button" class="zr-btn dup-stack-later">Later</button>
        <span class="zr-decision__keys">Enter · Esc · L</span>
      </div>
    </div>`;
}

/** How many pairs have which answer now: merge, keep and later. */
function stackTally() {
  const tally = { merge: 0, keep: 0, later: 0 };
  stack.answers.forEach((answer) => {
    if (tally[answer] !== undefined) tally[answer] += 1;
  });
  return tally;
}

/** "2 to merge · 1 kept apart · 1 later". */
function stackTallyText() {
  const tally = stackTally();
  return `${count(tally.merge)} to merge · ${count(tally.keep)} kept apart · ${count(tally.later)} later`;
}

/** What the stack says once every pair has had an answer. */
function htmlStackDone() {
  return `<p class="dup-stack__done">${esc(stackTallyText())}</p>`;
}

/** The run bar of the stack: how many pairs have an answer, and the tally. */
function renderStackBar() {
  const total = stack.total;
  const tally = stackTally();
  const answered = Math.min(total, tally.merge + tally.keep);
  const state = stackState();
  if (el.stackPosition) {
    // A pair keeps its number when it comes round again after "Later".
    const number = state ? stack.ids.indexOf(String(state.group.id)) + 1 : 0;
    el.stackPosition.textContent = state
      ? `Pair ${count(number)} of ${count(total)}`
      : `All ${count(total)} answered`;
  }
  if (el.stackFill) {
    const share = total === 0 ? 0 : Math.round((answered / total) * 100);
    el.stackFill.style.width = `${share}%`;
  }
  if (el.stackRest) {
    const left = Math.max(0, total - answered);
    el.stackRest.textContent =
      !state || left === 0 ? '' : `${count(left)} left`;
  }
  if (el.stackTally) el.stackTally.textContent = stackTallyText();
  if (el.stackUndoBtn) el.stackUndoBtn.disabled = stack.decisions.length === 0;
}

/** Draws the card the stack is on, or its closing line. */
function renderStack() {
  if (!el.stack || !el.stackCard) return;
  const state = stackState();
  el.stackCard.innerHTML = state ? htmlDecisionCard(state) : htmlStackDone();
  renderStackBar();
}

/** Opens the stack on the pairs it was handed. */
function openStack(ids) {
  if (!el.stack) return;
  stack.ids = ids.map((id) => String(id));
  stack.index = 0;
  stack.total = new Set(stack.ids).size;
  stack.answers = new Map();
  stack.decisions = [];
  stack.later = [];
  el.stack.classList.remove('hidden');
  renderStack();
  el.stack.focus();
  el.stack.scrollIntoView({ block: 'start' });
}

function closeStack() {
  if (!el.stack) return;
  el.stack.classList.add('hidden');
  renderSimple();
}

/** True for a pair that has its answer: merge or keep, not later. */
function stackAnswered(id) {
  const answer = stack.answers.get(String(id));
  return answer === 'merge' || answer === 'keep';
}

/**
 * Moves on to the next pair without an answer. At the end of the queue the
 * pairs put off come round again, until every pair has one.
 */
function stackAdvance() {
  stack.index += 1;
  for (;;) {
    while (
      stack.index < stack.ids.length &&
      stackAnswered(stack.ids[stack.index])
    ) {
      stack.index += 1;
    }
    if (stack.index < stack.ids.length || stack.later.length === 0) break;
    stack.ids = stack.ids.concat(stack.later);
    stack.later = [];
  }
  renderStack();
}

/**
 * Merge or Keep both: the row of the pair is ticked or unticked, and the
 * checklists behind the stack follow at once.
 *
 * @param {boolean} merge
 */
function stackDecide(merge) {
  const state = stackState();
  if (!state) return;
  const id = String(state.group.id);
  const key = `g:${id}`;
  stack.decisions.push({
    id,
    at: stack.index,
    before: stack.answers.get(id),
    key,
    had: simple.ticks.has(key),
    was: simple.ticks.get(key),
  });
  stack.answers.set(id, merge ? 'merge' : 'keep');
  simple.ticks.set(key, merge);
  renderSimple();
  stackAdvance();
}

/** Later: the pair comes round again at the end of the queue. */
function stackLater() {
  const state = stackState();
  if (!state) return;
  const id = String(state.group.id);
  stack.decisions.push({
    id,
    at: stack.index,
    before: stack.answers.get(id),
    later: true,
  });
  stack.answers.set(id, 'later');
  stack.later.push(id);
  stackAdvance();
}

/** Takes the last decision back: the pair and its tick are what they were. */
function stackUndo() {
  const decision = stack.decisions.pop();
  if (!decision) {
    renderStackBar();
    return;
  }
  if (decision.before === undefined) stack.answers.delete(decision.id);
  else stack.answers.set(decision.id, decision.before);
  if (decision.later) {
    const at = stack.later.lastIndexOf(decision.id);
    if (at !== -1) stack.later.splice(at, 1);
  } else {
    if (decision.had) simple.ticks.set(decision.key, decision.was);
    else simple.ticks.delete(decision.key);
    renderSimple();
  }
  stack.index = decision.at;
  renderStack();
}

/** The keys of the stack, and the one place they are allowed to fire. */
function stackKeydown(event) {
  if (!el.stack || el.stack.classList.contains('hidden')) return;
  const target = event.target;
  // A key pressed inside a field is that field's business, and a key on a
  // button is the button's: the browser already clicks it.
  if (target && target.closest('input, select, textarea, button, a')) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    stackDecide(true);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    stackDecide(false);
  } else if (event.key === 'l' || event.key === 'L') {
    event.preventDefault();
    stackLater();
  }
}

function initStack() {
  if (!el.stack || !el.stackCard) return;

  el.stackCard.addEventListener('click', (event) => {
    if (event.target.closest('.dup-stack-merge')) stackDecide(true);
    else if (event.target.closest('.dup-stack-keep')) stackDecide(false);
    else if (event.target.closest('.dup-stack-later')) stackLater();
  });

  // The ticks of a group with more than two members: the target stays
  // choosable, and the card is drawn again so both sides follow the choice.
  el.stackCard.addEventListener('change', (event) => {
    const state = stackState();
    if (!state) return;
    const input = event.target;
    if (input.classList.contains('dup-stack-target')) {
      const next = num(input.value);
      state.selected.add(state.targetId);
      state.selected.delete(next);
      state.targetId = next;
    } else if (input.classList.contains('dup-stack-source')) {
      const id = num(input.value);
      if (input.checked) state.selected.add(id);
      else state.selected.delete(id);
    } else {
      return;
    }
    const card = cardFor(state.group.id);
    if (card) renderMembers(card, state);
    renderStack();
    renderSimple();
  });

  if (el.stackCloseBtn) el.stackCloseBtn.addEventListener('click', closeStack);
  if (el.stackUndoBtn) el.stackUndoBtn.addEventListener('click', stackUndo);
  el.stack.addEventListener('keydown', stackKeydown);
}

/* --- the sheet before a run ----------------------------------------------- */
/* Asking costs tokens; merging costs writes. Before a run asks anything, the
   sheet says what it will cost: the tokens against the run's limit, the time
   at the lanes chosen, the requests side by side and the levers that move
   them. The markup is js/modules/review-sheet.js; what this page adds is the
   model it is drawn from. */

/** How much of the run's token budget has to be gone before it is named. */
const CEILING_SHOWN_ABOVE = 0.5;

/* The round numbers the page falls back to while the estimate endpoint does
   not answer. They are the ones services/aiRunEstimate.js guesses with,
   restated here because a browser cannot require a Node module; an estimate
   built from them says `basis: 'guess'`, which is exactly what it is. */
const GUESS_BATCH_SIZE = 25;
const GUESS_PROMPT_BASE = 900;
const GUESS_PROMPT_PER_ITEM = 18;
const GUESS_TOKENS_PER_ITEM = 26;
const GUESS_THINKING_PER_REQUEST = 1800;
const GUESS_TOKENS_PER_SECOND = 45;
/** Entities the sweep looks at per request when it is switched on. */
const GUESS_SWEEP_BATCH = 60;

/**
 * What a run over the pairs on the page would cost, worked out here.
 *
 * This is the fallback half of the one seam in this file: the numbers come
 * from the same arithmetic the server uses, but from none of its
 * measurements, so `basis` is always 'guess' and the sheet says so. Like the
 * server's answer it prices both levers as if they were on, and at one lane.
 *
 * @returns {object} the shape of GET /api/duplicates/ai-review/estimate
 */
function localRunEstimate() {
  const pairs = reviewPairCount();
  const size = GUESS_BATCH_SIZE;
  const requests = Math.ceil(pairs / size);
  const entities = [...groups.values()].reduce(
    (sum, state) => sum + (state.group.members || []).length,
    0
  );
  const prompt = (GUESS_PROMPT_BASE + GUESS_PROMPT_PER_ITEM * size) * requests;
  const completion = GUESS_TOKENS_PER_ITEM * size * requests;
  const thinking = GUESS_THINKING_PER_REQUEST * requests;
  const seconds = Math.round((completion + thinking) / GUESS_TOKENS_PER_SECOND);
  return {
    groups: groups.size,
    pairs,
    needsScan: !scanned,
    items: pairs,
    itemsByRule: 0,
    batchSize: size,
    lanes: 1,
    requests,
    seconds,
    tokens: {
      total: prompt + completion + thinking,
      prompt,
      completion,
      thinking,
    },
    basis: 'guess',
    measuredAt: null,
    model: null,
    thinking: true,
    tokenBudget: 0,
    extra: {
      sweepRequests: Math.ceil(entities / GUESS_SWEEP_BATCH),
      excerptReads: entities,
    },
    lastRun: null,
  };
}

/**
 * What a run will cost, from the server where it can answer and from the
 * arithmetic above where it cannot. Both levers are asked for as on: the
 * estimate's main numbers do not depend on them, and only this way does the
 * answer know what switching one on would add.
 *
 * @param {{kind: string, threshold: number}} options  what the run scans
 * @returns {Promise<object>} an estimate
 */
async function fetchRunEstimate(options) {
  const params = new URLSearchParams({
    kind: options.kind,
    threshold: String(options.threshold),
    sweep: 'true',
    excerpts: 'true',
  });
  try {
    const payload = await requestJson(
      `/api/duplicates/ai-review/estimate?${params}`
    );
    if (payload && payload.success && payload.data) {
      return { ...localRunEstimate(), ...payload.data };
    }
  } catch {
    // No endpoint, no network, no answer: the page still says what a run
    // roughly costs, and that it is a guess.
  }
  return localRunEstimate();
}

/**
 * The sheet's model: an estimate read through the levers. Pure on purpose,
 * tests/test-duplicates-assistant-ui.js reads a fixture through it.
 *
 * Before a scan the estimate knows no pairs; what it knows then is the last
 * run of this task, and that is what the sheet shows, as measured. The
 * sweep adds its requests, and its tokens at what a request cost on
 * average; the lanes change the time and the rows, never the tokens.
 *
 * @param {object} estimate  what fetchRunEstimate() answered
 * @param {{titles: boolean, excerpts: boolean, sweep: boolean, lanes: number}} draft
 * @returns {object} the SheetModel of js/modules/review-sheet.js
 */
function sheetModel(estimate, draft) {
  const source = estimate || {};
  const extra = source.extra || {};
  const last = source.lastRun || null;
  const fromLast =
    source.needsScan === true && last !== null && num(last.requests) > 0;
  const base = fromLast ? num(last.requests) : num(source.requests);
  const items = fromLast ? num(last.items) : num(source.items);
  const measured = source.tokens || {};
  const parts = fromLast
    ? {
        prompt: num(last.promptTokens),
        completion: num(last.completionTokens),
        thinking: num(last.thinkingTokens),
      }
    : {
        prompt: num(measured.prompt),
        completion: num(measured.completion),
        thinking: num(measured.thinking),
      };
  // What one request takes, serially: the server's time is at its own lanes,
  // the last run's is what it took.
  const serverLanes = Math.max(1, num(source.lanes) || 1);
  let each = 0;
  if (base > 0) {
    each = fromLast
      ? num(last.seconds) / base
      : (num(source.seconds) * serverLanes) / base;
  }
  const sweepRequests = num(extra.sweepRequests);
  const added = draft.sweep === true ? sweepRequests : 0;
  const requests = base + added;
  const perRequest = (value) => (base > 0 ? value / base : 0);
  // The estimate is priced with both context levers on; a lever turned off
  // takes its guess out of the prompt again.
  const titlesTokens = num(extra.titlesTokens);
  const excerptTokens = num(extra.excerptTokens);
  const off =
    (draft.titles === false ? titlesTokens : 0) +
    (draft.excerpts === false ? excerptTokens : 0);
  const tokens = {
    prompt: Math.max(
      0,
      Math.round(parts.prompt + perRequest(parts.prompt) * added - off)
    ),
    completion: Math.round(
      parts.completion + perRequest(parts.completion) * added
    ),
    thinking: Math.round(parts.thinking + perRequest(parts.thinking) * added),
  };
  const sweepTokens = Math.round(
    perRequest(parts.prompt + parts.completion + parts.thinking) * sweepRequests
  );
  const lanes = Math.max(1, num(draft.lanes) || 1);
  const reads = num(extra.excerptReads);
  const sweepPrice =
    sweepRequests > 0
      ? `+${count(sweepRequests)} ${plural(sweepRequests, 'request', 'requests')}` +
        (sweepTokens > 0 ? ` · +${formatTokens(sweepTokens)}` : '')
      : '';
  const known = fromLast || source.needsScan !== true;
  return {
    sub: known
      ? `${count(items)} ${plural(items, 'pair', 'pairs')} · ${count(requests)} ${plural(requests, 'request', 'requests')}`
      : '',
    requests,
    tokens,
    limit: num(source.tokenBudget),
    seconds: requests > 0 ? Math.round(each * Math.ceil(requests / lanes)) : 0,
    lanes,
    switches: [
      {
        id: 'dupAiTitles',
        label: 'Titles as context',
        price: titlesTokens > 0 ? `+${formatTokens(titlesTokens)}` : '',
        on: draft.titles !== false,
      },
      {
        id: 'dupAiExcerpts',
        label:
          reads > 0
            ? `Excerpts · ${count(reads)} ${plural(reads, 'read', 'reads')}`
            : 'Excerpts',
        price: excerptTokens > 0 ? `+${formatTokens(excerptTokens)}` : '',
        on: draft.excerpts !== false,
      },
      {
        id: 'dupAiSweep',
        label: 'Synonym sweep',
        price: sweepPrice,
        on: draft.sweep === true,
      },
    ],
    basis: fromLast
      ? 'run'
      : ['run', 'model', 'guess'].includes(source.basis)
        ? source.basis
        : 'guess',
  };
}

/** The lever a sheet switch stands for. */
const SWITCH_LEVERS = {
  dupAiTitles: 'titles',
  dupAiExcerpts: 'excerpts',
  dupAiSweep: 'sweep',
};

/**
 * The sheet every model run opens first: what it costs, the levers that move
 * it, and Start. A lever moves the numbers at once and asks the estimate
 * again; Start keeps the levers for the run, Cancel forgets them.
 *
 * @param {{kind: string, threshold: number}} options  what the run scans
 * @returns {Promise<boolean>} true when the run was started
 */
async function confirmRun(options) {
  const draft = { ...levers };
  let estimate = await fetchRunEstimate(options);
  // Both ways here come after a scan: the one button scans first, and the
  // advanced page's button waits for one.
  const answer = confirmDialog({
    title: 'Ask the model',
    html: htmlSheet(sheetModel(estimate, draft)),
    confirmLabel: 'Start',
    cancelLabel: 'Cancel',
    className: 'zr-dialog--sheet',
  });
  const dialog = document.querySelector('dialog.zr-dialog[open]');
  let unbind = () => {};
  if (dialog) {
    let asked = 0;
    const refresh = async () => {
      updateSheet(dialog, sheetModel(estimate, draft));
      asked += 1;
      const ticket = asked;
      const next = await fetchRunEstimate(options);
      // Only the answer to the last move may draw; an older one is stale.
      if (ticket !== asked || !dialog.open) return;
      estimate = next;
      updateSheet(dialog, sheetModel(estimate, draft));
    };
    unbind = bindSheet(dialog, {
      onLanes(lanes) {
        draft.lanes = lanes;
        refresh();
      },
      onSwitch(id, on) {
        const lever = SWITCH_LEVERS[id];
        if (!lever) return;
        draft[lever] = on;
        refresh();
      },
    });
  }
  const confirmed = await answer;
  unbind();
  if (!confirmed) return false;
  Object.assign(levers, draft);
  runLanes = draft.lanes;
  storeWrite(STORE_KEYS.aiSweep, levers.sweep);
  return true;
}

/* --- what the run meter reads out ---------------------------------------- */

/** The elements of the run meter's token bar. */
function runTokenParts() {
  return {
    bar: el.runTokenbar,
    prompt: el.runSegPrompt,
    answer: el.runSegAnswer,
    thinking: el.runSegThinking,
    legend: el.runLegend,
  };
}

/** "Request 13 of 23", or what is known of it. */
function runPositionText(progress) {
  const state = progress || {};
  const done = Number(state.requestsDone) || 0;
  const planned = Number(state.requestsPlanned);
  if (Number.isFinite(planned) && planned > 0) {
    return `Request ${Math.min(done + 1, planned)} of ${planned}`;
  }
  return done > 0 ? `Request ${done + 1}` : 'Starting…';
}

/**
 * The ledger of a running review: what it has spent, against what it was
 * estimated to spend, and how fast it is going.
 */
function renderRunLedger(progress) {
  if (!el.runLedger) return;
  const state = progress || {};
  const spent = num(state.tokens);
  const estimated = num(state.estimatedTokens);
  const judged = num(state.pairsJudged);
  const total = num(state.pairsTotal);
  const items = [
    htmlLedgerItem(formatElapsed(state.elapsedMs), 'elapsed', false),
  ];
  if (total > 0) {
    items.push(htmlLedgerItem(`${judged} of ${total}`, 'pairs', false));
  } else if (judged > 0) {
    items.push(htmlLedgerItem(String(judged), 'pairs', false));
  }
  if (spent > 0) {
    items.push(
      htmlLedgerItem(
        estimated > 0
          ? `${formatTokens(spent)} of ~${formatTokens(estimated)}`
          : formatTokens(spent),
        'tokens',
        false
      )
    );
  }
  el.runLedger.innerHTML = items.join('');
  renderRunCeiling(state);
}

/**
 * The ceiling that would end the run, and only when it is close enough to
 * matter. It is the whole run's limit, not one request's.
 *
 * @param {object} state the progress
 */
function renderRunCeiling(state) {
  if (!el.runCeiling) return;
  const budget = num(state.tokenBudget);
  const spent = num(state.tokens);
  const near = budget > 0 && spent > budget * CEILING_SHOWN_ABOVE;
  el.runCeiling.classList.toggle('hidden', !near);
  el.runCeiling.textContent = near
    ? `${formatTokens(spent)} of the ${formatTokens(budget)} limit`
    : '';
}

/** What one finished request cost, as one line of facts. */
function reqlogWhatText(record) {
  const index = num(record.index);
  const items = num(record.items);
  const answers = num(record.answers);
  const unit = plural(items, 'pair', 'pairs');
  if (record.outcome === 'empty') {
    const thought = num(record.thinkingTokens);
    return thought > 0
      ? `Request ${index} · ${formatTokens(thought)} tokens of thinking · no answer`
      : `Request ${index} · no usable answer`;
  }
  if (record.outcome === 'failed') {
    return `Request ${index} · failed · ${items} ${unit} marked unsure`;
  }
  if (record.outcome === 'partial') {
    return `Request ${index} · ${items} ${unit} · ${answers} answered · the rest asked again`;
  }
  return `Request ${index} · ${items} ${unit} · ${answers} answered`;
}

/** The token half of a request's row: the total, and what of it was thinking. */
function reqlogCostText(record) {
  const tokens = Number(record.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  const thinking = num(record.thinkingTokens);
  if (thinking <= 0) return `${formatTokens(tokens)} tokens`;
  if (thinking >= tokens) return `${formatTokens(tokens)}, all thinking`;
  return `${formatTokens(tokens)} · ${formatTokens(thinking)} of it thinking`;
}

/**
 * The request being answered right now, as the first row of the log. This is
 * where "thinking" belongs: on the request that is thinking, with what it has
 * spent, rather than in the headline above everything.
 *
 * @param {object} state the progress
 * @returns {string} markup, or '' when nothing is in flight
 */
function htmlLiveRequestRow(state) {
  const running = num(state.requestTokens);
  const thinking = state.thinking === true;
  if (running <= 0 && !thinking) return '';
  const index = num(state.requestsDone) + 1;
  const pairs = num(state.requestPairs);
  const answers = num(state.requestAnswers);
  const what =
    pairs > 0
      ? `Request ${index} · ${pairs} ${plural(pairs, 'pair', 'pairs')} · ${answers} answered`
      : `Request ${index}`;
  const cost =
    running > 0
      ? `${formatTokens(running)} so far${thinking ? ' · thinking' : ''}`
      : 'thinking';
  return `<div class="zr-reqlog__row zr-reqlog__row--live">
      <span class="zr-reqlog__mark">${htmlMarks.running}</span>
      <span class="zr-reqlog__what">${esc(what)}</span>
      <span class="zr-reqlog__cost">${esc(cost)}</span>
      <span class="zr-reqlog__state">running</span>
    </div>`;
}

/** The last handful of requests, newest first, under the one in flight. */
function htmlRequestLog(progress) {
  const state = progress || {};
  const htmlLive = htmlLiveRequestRow(state);
  const list = Array.isArray(state.requestLog) ? state.requestLog : [];
  if (list.length === 0) return htmlLive;
  return (
    htmlLive +
    list
      .map((record) => {
        const warn = record.outcome === 'empty' || record.outcome === 'failed';
        const rowClass = warn ? ' zr-reqlog__row--warn' : '';
        const htmlMark = warn ? htmlMarks.failed : htmlMarks.ok;
        const seconds = num(record.ms) / 1000;
        const took =
          seconds >= 60 ? formatElapsed(record.ms) : `${Math.round(seconds)} s`;
        return `<div class="zr-reqlog__row${esc(rowClass)}">
          <span class="zr-reqlog__mark">${htmlMark}</span>
          <span class="zr-reqlog__what">${esc(reqlogWhatText(record))}</span>
          <span class="zr-reqlog__cost">${esc(reqlogCostText(record))}</span>
          <span class="zr-reqlog__state">${esc(took)}</span>
        </div>`;
      })
      .join('')
  );
}

/** Everything the run meter says, from one progress snapshot. */
function renderRunMeter(progress) {
  if (!el.runLedger) return;
  const state = progress || {};
  if (el.runPosition) el.runPosition.textContent = runPositionText(state);
  if (el.runRest) {
    const eta = formatEta(state.etaMs);
    el.runRest.textContent = eta === '' ? 'estimating…' : eta;
  }
  renderRunLedger(state);
  drawTokenbar(
    runTokenParts(),
    state.promptTokens,
    state.completionTokens,
    state.thinkingTotal
  );
  if (el.runLog) el.runLog.innerHTML = htmlRequestLog(state);
}

/** Empties the run meter when the panel goes away. */
function clearRunMeter() {
  if (el.runPosition) el.runPosition.textContent = '';
  if (el.runRest) el.runRest.textContent = '';
  if (el.runLedger) el.runLedger.innerHTML = '';
  if (el.runLog) el.runLog.innerHTML = '';
  if (el.runTokenbar) el.runTokenbar.classList.add('hidden');
  if (el.runCeiling) {
    el.runCeiling.textContent = '';
    el.runCeiling.classList.add('hidden');
  }
}

/* --- applying: the live checklist ----------------------------------------- */
/* A batch merge is the most destructive thing this page does, so it gets the
   room: one row per group, the one being written now, the rest waiting, and a
   failure in its own colour with what Paperless-ngx said about it and a
   button that tries that one again. Merges run one after the other on
   purpose: Paperless-ngx gets one bulk edit at a time. */

/** What the checklist is walking right now, so a retry can find its entry. */
let applyEntries = [];

/** One row of the checklist, in the state it is in. */
function htmlApplyRow(entry, state, detail) {
  const targetName = String(entry.target.name == null ? '' : entry.target.name);
  const names = entry.sources
    .map((member) => String(member.name == null ? '' : member.name))
    .join(', ');
  const documents = countDocuments(entry.sources);
  const htmlStateMarks = {
    waiting: htmlMarks.waiting,
    running: htmlMarks.running,
    done: htmlMarks.ok,
    failed: htmlMarks.failed,
  };
  const rowClass =
    state === 'running'
      ? ' zr-reqlog__row--live'
      : state === 'failed'
        ? ' zr-reqlog__row--warn'
        : '';
  const what = `${names} → ${targetName}`;
  const htmlRetry =
    state === 'failed'
      ? `<button type="button" class="zr-btn dup-apply-retry" data-group-id="${esc(entry.state.group.id)}">Retry</button>`
      : '';
  return `<div class="zr-reqlog__row${esc(rowClass)}" data-apply-id="${esc(entry.state.group.id)}">
      <span class="zr-reqlog__mark">${htmlStateMarks[state]}</span>
      <span class="zr-reqlog__what">${esc(what)}</span>
      <span class="zr-reqlog__cost">${esc(detail || `${count(documents)} ${plural(documents, 'document', 'documents')}`)}</span>
      <span class="zr-reqlog__state">${esc(state === 'running' ? 'writing' : state)}</span>
      ${htmlRetry}
    </div>`;
}

/** Opens the checklist over a batch that is about to run. */
function openApply(entries) {
  if (!el.apply || !el.applyList) return;
  applyEntries = entries;
  el.apply.classList.remove('hidden');
  el.applyList.innerHTML = entries
    .map((entry) => htmlApplyRow(entry, 'waiting', ''))
    .join('');
  drawApplyBar(0, entries.length);
  el.apply.scrollIntoView({ block: 'nearest' });
}

function drawApplyBar(done, total) {
  if (el.applyPosition) {
    el.applyPosition.textContent =
      done >= total
        ? `All ${count(total)} written`
        : `Group ${count(Math.min(done + 1, total))} of ${count(total)}`;
  }
  if (el.applyFill) {
    const share = total === 0 ? 0 : Math.round((done / total) * 100);
    el.applyFill.style.width = `${share}%`;
  }
  if (el.applyRest) {
    const left = Math.max(0, total - done);
    el.applyRest.textContent = left === 0 ? '' : `${count(left)} waiting`;
  }
}

/** Puts one row of the checklist into a new state. */
function markApply(groupId, state, detail) {
  if (!el.applyList) return;
  const entry = applyEntries.find(
    (candidate) => String(candidate.state.group.id) === String(groupId)
  );
  if (!entry) return;
  const rows = [...el.applyList.querySelectorAll('[data-apply-id]')];
  const row = rows.find((node) => node.dataset.applyId === String(groupId));
  if (!row) return;
  row.outerHTML = htmlApplyRow(entry, state, detail);
}

/** The last line of a finished batch. */
function finishApply(summary) {
  if (!el.applyRest) return;
  el.applyRest.textContent = summary;
}

function closeApply() {
  if (!el.apply) return;
  el.apply.classList.add('hidden');
  applyEntries = [];
}

/** Tries one failed group of the checklist again, on its own. */
async function retryApply(groupId) {
  const entry = applyEntries.find(
    (candidate) => String(candidate.state.group.id) === String(groupId)
  );
  if (!entry || merging) return;
  markApply(groupId, 'running', '');
  const outcome = await mergeGroup(entry.card, entry.state, {
    copyMatchingRule: false,
  });
  if (outcome && outcome.status === 'done') {
    markApply(
      groupId,
      'done',
      `${count(outcome.documentsMoved)} ${plural(outcome.documentsMoved, 'document', 'documents')} moved`
    );
  } else {
    markApply(
      groupId,
      'failed',
      (outcome && outcome.message) || 'Failed again'
    );
  }
  loadLog(true);
  renderSimple();
}

/* --- what a button writes, in numbers ------------------------------------- */

/** The line under "Merge by hand": what its Merge button writes. */
function updateManualConsequence() {
  if (!el.manualConsequence) return;
  const target = manualTargetRecord();
  const sources = manualSourceRecords();
  if (!target || sources.length === 0) {
    el.manualConsequence.classList.add('hidden');
    el.manualConsequence.textContent = '';
    return;
  }
  const documents = sources.reduce(
    (sum, record) => sum + num(record.documentCount),
    0
  );
  el.manualConsequence.classList.remove('hidden');
  el.manualConsequence.textContent = mergeFactsText(sources.length, documents);
}

/** The line inside a group card, above its Merge button. */
function updateGroupConsequence(card, state) {
  const holder = card.querySelector('.dup-group__consequence');
  if (!holder) return;
  const target = memberOf(state, state.targetId);
  const sources = selectedSources(state);
  if (!target || sources.length === 0) {
    holder.classList.add('hidden');
    holder.textContent = '';
    return;
  }
  holder.classList.remove('hidden');
  holder.textContent = mergeFactsText(sources.length, countDocuments(sources));
}

/* --- wiring --------------------------------------------------------------- */

/** The simple page: its one button, the ticks, the head and the history line. */
function initSimple() {
  if (el.findBtn) el.findBtn.addEventListener('click', findDuplicates);
  if (el.resultMergeBtn) {
    el.resultMergeBtn.addEventListener('click', mergeTicked);
  }
  if (el.historyUndoBtn) el.historyUndoBtn.addEventListener('click', undoLast);
  if (el.checklists) {
    // A tick moves the numbers of the one button and nothing else.
    el.checklists.addEventListener('change', (event) => {
      const box = event.target.closest('.zr-checklist__box');
      if (!box) return;
      simple.ticks.set(box.dataset.key, box.checked);
      updateResultButton();
    });
    el.checklists.addEventListener('click', (event) => {
      const more = event.target.closest('.dup-checklist-more');
      if (more) {
        simple.open.add(more.dataset.list);
        renderSimple();
        return;
      }
      if (event.target.closest('.dup-review-one')) {
        openStack(currentChecklists().unsure.map((row) => row.groupId));
      }
    });
  }
  if (el.applyList) {
    el.applyList.addEventListener('click', (event) => {
      const retry = event.target.closest('.dup-apply-retry');
      if (retry) retryApply(retry.dataset.groupId);
    });
  }
}

/** The mode: the button in the top bar, the gate, and data-mode on the page. */
function initMode() {
  if (!el.page) return;
  mountModeSwitch({
    page: 'duplicates',
    root: el.page,
    slot: document.getElementById('zrTopbarActions'),
    gate: GATE_LINES,
    // The simple page reads the cards; what changed on them while the
    // advanced page was open shows when it comes back.
    onChange: () => renderSimple(),
  });
  // A link from elsewhere to the log (the Undo of Simplify tags) lands on
  // the advanced page for this visit, with the log open. The stored mode
  // stays what it was.
  if (window.location.hash === '#dupLog') {
    applyMode(el.page, 'advanced');
    const slot = document.getElementById('zrTopbarActions');
    if (slot) slot.innerHTML = htmlModeButton('advanced');
    const log = document.getElementById('dupLog');
    if (log) log.open = true;
  }
}

function init() {
  if (!el.results) return;

  initMode();

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

  if (el.scanBtn) el.scanBtn.addEventListener('click', () => runScan());
  if (el.aiReviewBtn) el.aiReviewBtn.addEventListener('click', runAiReview);
  if (el.aiStopBtn) el.aiStopBtn.addEventListener('click', stopReview);
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

  if (el.aiForgetBtn) {
    el.aiForgetBtn.addEventListener('click', forgetVerdicts);
  }

  // The sweep costs requests of its own, so it is off until it is asked
  // for, and stays on for the next visit once it has been.
  levers.sweep = storeRead(STORE_KEYS.aiSweep) === 'true';

  initSensitivity();
  initResultsBar();
  initSelection();
  initSimple();
  loadStartFacts();
  initStack();
  initManual();
  initUnused();
  initMappings();
  updateAiButton();
  loadLog(true);
  loadDismissals();
  // A review the server is still working on gets its page back after a reload.
  reattachReview();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
