/**
 * Duplicates page — find tags or correspondents that mean the same thing,
 * review why the server thinks so, and merge them in Paperless-ngx.
 *
 * Nothing here starts on its own: a scan runs when the button is used, the AI
 * review when "Ask the AI" is used, and a merge when the confirm dialog is
 * accepted. Every destructive step names the objects it deletes before it
 * happens and is undoable from the log. A verdict from the model is
 * information beside the deterministic result; it merges nothing.
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
  // A pair the AI's semantic sweep proposed; the string matcher saw nothing.
  semantic: 'Semantic (AI)',
};

/**
 * What the AI review says about a pair or a group. The three verdicts are the
 * contract (services/entityMatchAiService.js); the labels belong to this page.
 */
const AI_VERDICT_LABELS = {
  same: 'AI: same',
  different: 'AI: different',
  unsure: 'AI: unsure',
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

/**
 * The same warnings, worded for the manual flow. There the user picks the
 * target themselves, so an inbox tag can end up among the sources — and a
 * source is deleted, which the group wording ("it stays the target") would
 * promise the opposite of.
 */
const MANUAL_WARNING_TEXTS = {
  ...WARNING_TEXTS,
  'inbox-tag':
    'An inbox tag is among the entries to merge away; it will be deleted in Paperless-ngx.',
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
 * What a log row records. A row without an action is a merge — every row
 * written before the log knew about deletes is one.
 */
const LOG_ACTION_DELETE = 'delete';

/**
 * A row the Simplify tags page wrote: one compound tag became a document type
 * and topic tags. It is undone from here like a merge — the service plays the
 * split back — so only its cells differ.
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

/** What every merge dialog promises, single group or batch. */
const UNDO_NOTE =
  'You can undo this from the log below. Restored objects get new ids in Paperless-ngx.';

/** How long the finished batch leaves its summary in the bar, in ms. */
const SELECTION_SUMMARY_MS = 2600;

/**
 * The guided path is an offer, never a condition: the batch dialog names it in
 * one faint line and is otherwise unchanged. On an instance without the review
 * the line is not rendered at all.
 */
const GUIDED_TIP =
  'Tip: "Ask the AI, then merge" shows the model\'s view first.';

/** The sensitivity option that hands the threshold to the number field. */
const CUSTOM_SENSITIVITY = 'custom';

/** Both number fields are whole percent and share these bounds. */
const PERCENT_MIN = 50;
const PERCENT_MAX = 100;

/** The two lines the confidence breakdown under "Groups found" draws. */
const BUCKET_HIGH = 95;
const BUCKET_MID = 90;

/** What the toolbar remembers between visits. Values are whole percent. */
const STORE_KEYS = {
  sort: 'dup.sort',
  minConfidence: 'dup.minConfidence',
  sensitivity: 'dup.sensitivity',
  thresholdCustom: 'dup.thresholdCustom',
  aiSweep: 'dup.aiSweep',
};

/** The empty state of the mapping list, which never depends on a scan. */
const MAPPINGS_EMPTY =
  'Nothing mapped yet. Document analysis records here when it used an ' +
  'existing name instead of creating a near-duplicate.';

/** How the results list can be ordered; the first one is the default. */
const SORT_MODES = ['confidence', 'documents', 'name', 'kind'];

/* --- state ---------------------------------------------------------------- */

const el = {
  kind: document.getElementById('dupKind'),
  sensitivity: document.getElementById('dupSensitivity'),
  thresholdCustom: document.getElementById('dupThresholdCustom'),
  thresholdCustomField: document.getElementById('dupThresholdCustomField'),
  includeDismissed: document.getElementById('dupIncludeDismissed'),
  scanBtn: document.getElementById('dupScanBtn'),
  scanIcon: document.getElementById('dupScanIcon'),
  // null on every instance that does not offer the AI review; every use is
  // guarded, so the page is the same page without them.
  aiReviewBtn: document.getElementById('dupAiReviewBtn'),
  aiReviewIcon: document.getElementById('dupAiReviewIcon'),
  aiTitles: document.getElementById('dupAiTitles'),
  aiExcerpts: document.getElementById('dupAiExcerpts'),
  aiProposalBtn: document.getElementById('dupAiProposalBtn'),
  aiProposalIcon: document.getElementById('dupAiProposalIcon'),
  aiProposalStatus: document.getElementById('dupAiProposalStatus'),
  aiSweep: document.getElementById('dupAiSweep'),
  aiNotice: document.getElementById('dupAiNotice'),
  aiProgress: document.getElementById('dupAiProgress'),
  aiProgressBar: document.getElementById('dupAiProgressBar'),
  aiProgressFill: document.getElementById('dupAiProgressFill'),
  aiProgressMessage: document.getElementById('dupAiProgressMessage'),
  runCeiling: document.getElementById('dupRunCeiling'),
  aiStopBtn: document.getElementById('dupAiStopBtn'),
  aiForgetBtn: document.getElementById('dupAiForgetBtn'),
  stats: document.getElementById('dupStats'),
  statTags: document.getElementById('dupStatTags'),
  statCorrespondents: document.getElementById('dupStatCorrespondents'),
  statGroups: document.getElementById('dupStatGroups'),
  statDocuments: document.getElementById('dupStatDocuments'),
  statAiJudgedTile: document.getElementById('dupStatAiJudgedTile'),
  statAiJudged: document.getElementById('dupStatAiJudged'),
  statAiCandidates: document.getElementById('dupStatAiCandidates'),
  statAiRequestsTile: document.getElementById('dupStatAiRequestsTile'),
  statAiRequests: document.getElementById('dupStatAiRequests'),
  statAiTokens: document.getElementById('dupStatAiTokens'),
  statBuckets: document.getElementById('dupStatBuckets'),
  results: document.getElementById('dupResults'),
  resultsBar: document.getElementById('dupResultsBar'),
  sortSelect: document.getElementById('dupSortSelect'),
  minConfidence: document.getElementById('dupMinConfidence'),
  selectMinBtn: document.getElementById('dupSelectMinBtn'),
  minConfidenceCount: document.getElementById('dupMinConfidenceCount'),
  selection: document.getElementById('dupSelection'),
  selectionCount: document.getElementById('dupSelectionCount'),
  selectionProgress: document.getElementById('dupSelectionProgress'),
  mergeSelectedBtn: document.getElementById('dupMergeSelectedBtn'),
  // null on every instance without the AI review; every use is guarded.
  reviewThenMergeBtn: document.getElementById('dupReviewThenMergeBtn'),
  reviewThenMergeIcon: document.getElementById('dupReviewThenMergeIcon'),
  selectAllBtn: document.getElementById('dupSelectAllBtn'),
  selectAiSameBtn: document.getElementById('dupSelectAiSameBtn'),
  clearSelectionBtn: document.getElementById('dupClearSelectionBtn'),
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
  // The plan: what a scan found, read as baskets of sentences.
  plan: document.getElementById('dupPlan'),
  planSentence: document.getElementById('dupPlanSentence'),
  planLedger: document.getElementById('dupPlanLedger'),
  planTokenbar: document.getElementById('dupPlanTokenbar'),
  planSegPrompt: document.getElementById('dupPlanSegPrompt'),
  planSegAnswer: document.getElementById('dupPlanSegAnswer'),
  planSegThinking: document.getElementById('dupPlanSegThinking'),
  planLegend: document.getElementById('dupPlanLegend'),
  // null on every instance without the AI review; every use is guarded.
  planAskBtn: document.getElementById('dupPlanAskBtn'),
  planAskLabel: document.getElementById('dupPlanAskLabel'),
  planAskSub: document.getElementById('dupPlanAskSub'),
  planApplyBtn: document.getElementById('dupPlanApplyBtn'),
  planApplyLabel: document.getElementById('dupPlanApplyLabel'),
  planApplySub: document.getElementById('dupPlanApplySub'),
  planStackBtn: document.getElementById('dupPlanStackBtn'),
  planStackLabel: document.getElementById('dupPlanStackLabel'),
  planStackSub: document.getElementById('dupPlanStackSub'),
  baskets: document.getElementById('dupBaskets'),
  showAllBtn: document.getElementById('dupShowAllBtn'),
  showAllLabel: document.getElementById('dupShowAllLabel'),
  everything: document.getElementById('dupEverything'),
  // The stack: one pair per screen.
  stack: document.getElementById('dupStack'),
  stackPosition: document.getElementById('dupStackPosition'),
  stackFill: document.getElementById('dupStackFill'),
  stackRest: document.getElementById('dupStackRest'),
  stackObviousBtn: document.getElementById('dupStackObviousBtn'),
  stackObviousLabel: document.getElementById('dupStackObviousLabel'),
  stackObviousSub: document.getElementById('dupStackObviousSub'),
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
  // The run meter around the progress panel; null without the review.
  runPosition: document.getElementById('dupRunPosition'),
  runRest: document.getElementById('dupRunRest'),
  runLedger: document.getElementById('dupRunLedger'),
  runTokenbar: document.getElementById('dupRunTokenbar'),
  runSegPrompt: document.getElementById('dupRunSegPrompt'),
  runSegAnswer: document.getElementById('dupRunSegAnswer'),
  runSegThinking: document.getElementById('dupRunSegThinking'),
  runLegend: document.getElementById('dupRunLegend'),
  runLog: document.getElementById('dupRunLog'),
  aiStopSub: document.getElementById('dupAiStopSub'),
  selectionConsequence: document.getElementById('dupSelectionConsequence'),
  manualConsequence: document.getElementById('dupManualConsequence'),
  unusedConsequence: document.getElementById('dupUnusedConsequence'),
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
/** True from the click on "AI proposal" until its dialog is done with. */
let proposing = false;
/** The review job this page is following, or null when none is. */
let reviewJobId = null;
/** The last job the panel drew, plus when it arrived, so elapsed can tick. */
let progressJob = null;
let progressAt = 0;
let progressTimer = null;

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

/** 'high', 'low' or '' — an older answer carries no confidence at all. */
function confidenceLabel(verdict) {
  const value =
    verdict == null || verdict.confidence == null
      ? ''
      : String(verdict.confidence);
  return AI_CONFIDENCE_LABELS[value] || '';
}

/**
 * Only a "same" the model is sure about comes up ticked, in both dialogs. A
 * "same" without a confidence, or with a low one, is a proposal to look at —
 * never one to merge unseen. Pure on purpose: tests/test-duplicates-ui.js
 * evaluates this function itself.
 */
function isSureSame(verdict) {
  return (
    Boolean(verdict) &&
    String(verdict.verdict) === 'same' &&
    String(verdict.confidence) === 'high'
  );
}

/**
 * Where a verdict puts its row in the proposal: what is settled first, what
 * needs a decision after it. Pure on purpose — tests/test-duplicates-ui.js
 * evaluates this function and sorts a list with it.
 *
 * @param {object|null} verdict
 * @returns {number} 0 sure same, 1 same, 2 unsure, 3 different, 4 not judged
 */
function proposalRank(verdict) {
  const value = verdict ? String(verdict.verdict) : '';
  const confidence = verdict ? String(verdict.confidence) : '';
  if (value === 'same') return confidence === 'high' ? 0 : 1;
  if (value === 'unsure') return 2;
  if (value === 'different') return 3;
  return 4;
}

/** What a verdict's title attribute says: the rule first, then the sentence. */
function verdictTitle(verdict) {
  const basis = basisLabel(verdict);
  const reason = verdict ? shortReason(verdict.reason) : '';
  if (basis === '') return reason;
  return reason === '' ? basis : `${basis} · ${reason}`;
}

/** 'AI: same · high', or '' when nothing is known about the confidence. */
function htmlConfidenceSuffix(verdict) {
  const confidence = confidenceLabel(verdict);
  // The suffix is part of the verdict, not a second chip: "AI: same · high".
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
      ? '<span class="zr-badge zr-badge--info">AI suggested</span>'
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
    <p class="zr-consequence dup-group__consequence hidden"></p>
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
 * The threshold the scan and the review are asked with, as a 0–1 score. The
 * three presets carry theirs in the option value; "Custom" hands the question
 * to the number field beside the select, where 94 and 96 are a different
 * answer than "strict" and "normal" ever are.
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

/** Shows the number field for "Custom" and hides it for the presets. */
function updateThresholdField() {
  if (!el.sensitivity || !el.thresholdCustomField) return;
  el.thresholdCustomField.classList.toggle(
    'hidden',
    el.sensitivity.value !== CUSTOM_SENSITIVITY
  );
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
  renderBuckets();
  updateResultsBar();
  updateSelectionBar();
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
  renderAiStats(data.aiReview || null);
  el.stats.classList.remove('hidden');
}

/**
 * How the groups on the page are spread over the confidence bands, under the
 * "Groups found" tile. It is what makes "everything above 95 %" a decision
 * rather than a guess, and it is counted from the cards, not from the answer,
 * so a review that adds candidates updates it too.
 */
function renderBuckets() {
  if (!el.statBuckets) return;
  let high = 0;
  let mid = 0;
  let low = 0;
  groups.forEach((state) => {
    const percent = pct(state.group.confidence);
    if (percent >= BUCKET_HIGH) high += 1;
    else if (percent >= BUCKET_MID) mid += 1;
    else low += 1;
  });
  el.statBuckets.textContent =
    groups.size === 0
      ? ''
      : `≥${BUCKET_HIGH} %: ${high} · ${BUCKET_MID}–${BUCKET_HIGH} %: ${mid} · <${BUCKET_MID} %: ${low}`;
}

/**
 * The two tiles the review adds. A plain scan passes null, which puts them
 * away again — the numbers of the last review say nothing about a new scan.
 *
 * @param {object|null} review  the `aiReview` block of a review result
 */
function renderAiStats(review) {
  if (!el.statAiJudgedTile || !el.statAiRequestsTile) return;
  if (!review) {
    el.statAiJudgedTile.classList.add('hidden');
    el.statAiRequestsTile.classList.add('hidden');
    return;
  }
  el.statAiJudged.textContent = String(num(review.judged));
  // `candidates` counts the pairs from the band below the threshold the model
  // was shown, not the groups that came out of it. What follows it is the
  // evidence the review used and the work it saved: excerpts it fetched, pairs
  // a spelling rule settled without a model, pairs it asked about twice.
  const parts = [];
  const candidates = Number(review.candidates);
  if (review.candidates != null && Number.isFinite(candidates)) {
    parts.push(
      `${candidates} near-${plural(candidates, 'miss', 'misses')} judged`
    );
  }
  if (num(review.excerpts) > 0) {
    parts.push(`${num(review.excerpts)} excerpts`);
  }
  if (num(review.spellingRules) > 0) {
    parts.push(`${num(review.spellingRules)} by spelling rule`);
  }
  if (num(review.escalated) > 0) {
    parts.push(`${num(review.escalated)} escalated`);
  }
  // Pairs no string matcher could have proposed. They are judged like any
  // candidate, so they are already inside `judged`; this says where they
  // came from.
  if (num(review.sweepProposals) > 0) {
    parts.push(`${num(review.sweepProposals)} from the sweep`);
  }
  // Pairs the judge did not have to ask about at all, because it still
  // remembered what it decided about them.
  if (num(review.verdictsReused) > 0) {
    parts.push(`${num(review.verdictsReused)} from memory`);
  }
  el.statAiCandidates.textContent = parts.join(' · ');
  // `requests` is every request the review made, the sweep's own ones
  // (`sweepRequests`) among them; the tile counts the whole bill.
  el.statAiRequests.textContent = String(num(review.requests));
  const tokens = Number(review.tokens);
  const costParts = [];
  if (review.tokens != null && Number.isFinite(tokens)) {
    costParts.push(`${tokens} ${plural(tokens, 'token', 'tokens')}`);
  }
  // How many pairs one request carried explains the request count better than
  // the count does on its own; after a warm-up it is a measured number.
  const size = Number(review.batchSize);
  if (review.batchSize != null && Number.isFinite(size) && size > 0) {
    costParts.push(`${size} ${plural(size, 'pair', 'pairs')} per request`);
  }
  // How many of those requests waited for an answer at the same time. One
  // lane is the normal case and says nothing worth a word.
  const lanes = Number(review.concurrency);
  if (Number.isFinite(lanes) && lanes > 1) {
    costParts.push(`${lanes} lanes`);
  }
  el.statAiTokens.textContent = costParts.join(' · ');
  // The model name belongs on the request count, not in a tile of its own.
  el.statAiRequestsTile.title = String(
    review.model == null ? '' : review.model
  );
  el.statAiJudgedTile.classList.remove('hidden');
  el.statAiRequestsTile.classList.remove('hidden');
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
  return `<div class="dup-divider"><span class="zr-sm">${esc('Suggested by the AI, below your sensitivity')}</span></div>`;
}

function renderGroups(list) {
  groups.clear();
  selectedGroups.clear();
  if (!Array.isArray(list) || list.length === 0) {
    el.results.innerHTML = htmlEmpty(
      'No duplicates found',
      'No duplicates found at this sensitivity.'
    );
    renderBuckets();
    renderPlan();
    updateResultsBar();
    updateSelectionBar();
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
  renderBuckets();
  // The plan is a reading of the cards, so it is drawn from them and the full
  // list folds away behind "Show every group".
  renderPlan();
  showEverything(false);
  // The order the user chose survives a new scan and a review; it is a way of
  // reading the list, not a property of one answer.
  sortResults();
  updateResultsBar();
  updateSelectionBar();
}

/* --- ordering and picking by confidence ----------------------------------- */
/* A grown archive answers a scan with dozens of groups that all read "94 %",
   "95 %", "96 %". The toolbar is what turns that list into a decision: put it
   in the order that helps, and tick everything above a confidence in one move.
   Neither fetches anything — the sort moves the cards that are already there,
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
 * The comparator behind the "Sort by" select. Confidence and documents run
 * from high to low — the interesting end of both is the top — while a name is
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
  let count = 0;
  eachGroupCard((card, state) => {
    const check = card.querySelector('.dup-select');
    if (!check || check.disabled) return;
    if (pct(state.group.confidence) >= percent) count += 1;
  });
  return count;
}

function updateMinConfidenceCount() {
  if (!el.minConfidenceCount) return;
  const count = groupsAtOrAbove(minConfidencePercent());
  el.minConfidenceCount.textContent = `${count} ${plural(count, 'group', 'groups')} at or above`;
}

/** The bar belongs to a result list; without cards there is nothing to order. */
function updateResultsBar() {
  if (!el.resultsBar) return;
  el.resultsBar.classList.toggle('hidden', groups.size === 0);
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
    if (Number.isFinite(stored) && stored > 0) {
      el.thresholdCustom.value = String(clampPercent(stored, BUCKET_HIGH));
    }
    el.thresholdCustom.addEventListener('change', () => {
      const percent = clampPercent(el.thresholdCustom.value, BUCKET_HIGH);
      el.thresholdCustom.value = String(percent);
      storeWrite(STORE_KEYS.thresholdCustom, percent);
    });
  }
  el.sensitivity.addEventListener('change', () => {
    storeWrite(STORE_KEYS.sensitivity, el.sensitivity.value);
    updateThresholdField();
  });
  updateThresholdField();
}

async function runScan() {
  if (scanning || aiReviewing) return;
  // A new scan is a new question: every verdict of the last review goes with
  // the cards it belonged to.
  scanned = false;
  clearAiNotice();
  // The panel belongs to the review it reported on; a new scan is a new
  // question and starts without it.
  hideProgressPanel();
  setScanning(true);
  showSkeletons();
  try {
    const params = new URLSearchParams({
      kind: selectedKind(),
      threshold: String(currentThreshold()),
      includeDismissed:
        el.includeDismissed && el.includeDismissed.checked ? 'true' : 'false',
    });
    const payload = await requestJson(`/api/duplicates/scan?${params}`);
    if (!payload.success) {
      throw new Error(payload.error || 'The scan failed.');
    }
    const data = payload.data || {};
    paperlessUrl = data.paperlessUrl || '';
    // The plan's one sentence needs what was looked at, and a plain scan is a
    // new question: the numbers of the last review say nothing about it.
    lastScanTotals = data.totals || null;
    lastRunReview = data.aiReview || null;
    if (!lastRunReview) lastRunProgress = null;
    renderStats(data);
    renderGroups(data.groups);
    renderUnused(data);
    // The scan is where the page learns the public Paperless-ngx URL, so the
    // mapping rows drawn before it can become links now.
    refreshMappingLinks();
    scanned = true;
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

/* --- the AI review -------------------------------------------------------- */
/* Stage one of "use a model for matching": after a scan the user can ask the
   configured provider what it makes of the pairs. It judges, it never merges —
   every verdict lands next to the deterministic result and the user decides.
   The whole flow is guarded by the elements being there at all, so an instance
   without the review runs this file unchanged. */

function clearAiNotice() {
  if (el.aiNotice) el.aiNotice.innerHTML = '';
}

/**
 * "Ask the AI" is disabled until a scan has produced cards, and while anything
 * is running. "AI proposal" scans by itself, so it only waits for a run that
 * is already going on.
 */
function updateAiButton() {
  const busy = scanning || aiReviewing || merging || proposing;
  if (el.aiProposalBtn) el.aiProposalBtn.disabled = busy;
  if (!el.aiReviewBtn) return;
  el.aiReviewBtn.disabled = !scanned || busy;
  el.aiReviewBtn.title = scanned
    ? ''
    : 'Scan first — the AI judges what the scan found.';
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
 * The review needs the status of a refusal to word it itself — a 409 means the
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

/** True on an instance that offers the review at all. */
function aiReviewOffered() {
  return Boolean(el.aiReviewBtn || el.reviewThenMergeBtn);
}

/* --- the progress panel --------------------------------------------------- */
/* A review is many model requests in a row. Left to a spinner it would be a
   bill nobody sees, so the server runs it as a job and this panel says where
   it is, what it has spent and how long it still needs — with the one button
   that ends it. All three AI paths share the panel, and a reloaded page
   attaches to a review that is still going. */

/** How often the fallback asks a job whose event stream broke. */
const REVIEW_POLL_MS = 2000;

/** The two job states that mean "still going". */
const REVIEW_LIVE_STATES = ['running', 'stopping'];

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

/**
 * What is left of a review, the way a person reads a wait. An estimate the
 * job does not have yet is no text at all — the caller says "estimating…"
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
 * answers that stream in during a request count as well — a bar that only
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

/** The one sentence a review that ended early leaves above the results. */
function stopNotice(job) {
  const state = (job && job.progress) || {};
  const done = Number(state.requestsDone) || 0;
  // A count the job does not have yet is null, and Number(null) is 0 — which
  // would read as "of 0 requests". NaN is the honest answer here.
  const planned =
    state.requestsPlanned == null ? NaN : Number(state.requestsPlanned);
  const pairs = state.pairsTotal == null ? NaN : Number(state.pairsTotal);
  const judged = Number(state.pairsJudged) || 0;
  const missing = Number.isFinite(pairs) ? Math.max(0, pairs - judged) : null;
  const tail =
    missing === null
      ? '.'
      : `: ${missing} ${plural(missing, 'pair was', 'pairs were')} not judged.`;
  const requests = plural(
    Number.isFinite(planned) ? planned : done,
    'request',
    'requests'
  );
  const reason = job ? job.stopReason : null;
  if (reason === 'token-budget') {
    const budget = formatTokens(state.tokenBudget);
    return `Stopped at the token budget of ${budget} after ${done} ${requests}${tail}`;
  }
  if (reason === 'idle') {
    return `Stopped because nobody was watching${tail}`;
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

/**
 * The one line under the counts that says how the judge is sizing its
 * requests, and whether that size is a guess or a measurement.
 *
 * @param {object|null} progress  an AiReviewProgress
 * @returns {string} empty while the batch size is not known
 */

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
  // While a review runs the note line holds its row open even before the
  // warm-up filled it, so the tiles below do not jump when it appears.
  el.aiProgress.classList.add('dup-progress--live');
  if (el.aiStopBtn) {
    el.aiStopBtn.classList.remove('hidden');
    el.aiStopBtn.disabled = false;
    setStopLabel('Stop');
  }
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
    escalating: 'Asking again, with more to go on',
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
  setStopSub('');
}

/** What the answer of a review does to the page, wherever it came from. */
function applyReviewResult(data) {
  if (data.paperlessUrl) paperlessUrl = data.paperlessUrl;
  // What this run cost. The `aiReview` block counts the requests and the
  // tokens; only the job's own progress carries the seconds and the split
  // between question, answer and reasoning, so the ledger reads both.
  lastRunReview = data.aiReview || null;
  lastRunProgress = progressJob ? progressJob.progress || null : null;
  if (data.totals) lastScanTotals = data.totals;
  renderStats(data);
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
 * home — and a poll counts as watching, so the job does not stop itself.
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
        settle(reject, new Error(event.error || 'The AI review failed.'));
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
          'The AI review stopped early',
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
        if (!current) throw new Error('The AI review job is gone.');
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
 * One question to the model, and its answer put on the page. Both ways into a
 * review end here — the whole result list and the groups the user ticked —
 * because the request, the refusals and what the answer does to the cards are
 * the same in both cases. The page is only touched when an answer arrives; a
 * throw leaves the cards exactly as they were and the caller words it.
 *
 * The review runs as a job on the server and this follows it, so a long one
 * shows where it is and can be stopped.
 *
 * @param {object} extra  fields on top of the ones both callers send; the
 *   guided path narrows the question with `groupIds` and `includeCandidates`
 * @returns {Promise<{aiReview: object, stopped: boolean}>} what the review
 *   has to say about itself, and whether it ended before it was through
 */
async function askForVerdicts(extra) {
  hideProgressPanel();
  const { status, payload } = await postForReview(
    '/api/duplicates/ai-review/jobs',
    {
      kind: selectedKind(),
      threshold: currentThreshold(),
      includeDismissed: Boolean(
        el.includeDismissed && el.includeDismissed.checked
      ),
      withTitles: Boolean(el.aiTitles && el.aiTitles.checked),
      withExcerpts: Boolean(el.aiExcerpts && el.aiExcerpts.checked),
      semanticSweep: Boolean(el.aiSweep && el.aiSweep.checked),
      ...extra,
    }
  );
  const job = payload && payload.data ? payload.data.job : null;
  // A 409 that names a job is not a failure: another tab or an earlier click
  // started this very review, so this one watches it instead of asking twice.
  if (status !== 202 && !(status === 409 && job)) {
    if (!payload) {
      throw new Error(`The server answered ${status} without a body.`);
    }
    throw new Error(payload.error || 'The AI review failed.');
  }
  if (!job) {
    throw new Error('The server started a review without naming it.');
  }
  return followReviewJob(job);
}

/**
 * On load: a review that is still running somewhere gets its page back. A
 * finished one is left alone — a reload is not a request to see the last
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
 * itself — it names the setting that would have prevented it (thinking, the
 * token limit). The notice repeats it as it is and hands the user the one
 * place where those settings live.
 *
 * @param {string} message  what the job reported
 * @returns {string} markup for the notice area
 */
function htmlReviewFailure(message) {
  const text = String(message == null ? '' : message);
  return `<div class="zr-alert zr-alert--danger">${htmlIcons.danger}<div class="zr-alert__body"><div class="zr-alert__title">The AI review failed</div><p class="zr-sm">${esc(text)}</p><p class="zr-sm"><a class="zr-link" href="/settings#duplicates-tab">Open the Duplicates settings</a></p></div></div>`;
}

/** What a review has to admit about itself, or '' when it went through. */
function htmlFailedRequests(review) {
  const failed = num(review.failedRequests);
  return failed > 0
    ? htmlAlert(
        'warn',
        'Not every request reached the model',
        `${failed} ${plural(failed, 'request', 'requests')} failed; the pairs they covered are marked as unsure.`
      )
    : '';
}

/**
 * Empties the judge's memory of earlier verdicts. Local only: nothing in
 * Paperless-ngx is touched and no merge is undone — the next review simply
 * asks the model about every pair again.
 */
async function forgetVerdicts() {
  if (!el.aiForgetBtn) return;
  const confirmed = await confirmDialog({
    title: 'Forget remembered verdicts',
    body: 'The judge asks the model about every pair again from now on. Nothing in Paperless-ngx changes and no merge is undone.',
    confirmLabel: 'Forget',
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
      payload.message ||
        `${removed} remembered ${plural(removed, 'verdict', 'verdicts')} forgotten`,
      { tone: 'ok' }
    );
  } catch (error) {
    toast(error.message, { tone: 'danger' });
  } finally {
    el.aiForgetBtn.disabled = false;
  }
}

async function runAiReview() {
  if (!el.aiReviewBtn || scanning || aiReviewing || !scanned) return;
  // Asking costs tokens, so the dialog says how many before anything starts.
  if (!(await confirmRun('Ask the AI'))) return;
  setAiReviewing(true);
  const pairs = reviewPairCount();
  if (el.aiNotice) {
    el.aiNotice.innerHTML = htmlAlert(
      'info',
      '',
      `Asking the AI about ${pairs} ${plural(pairs, 'pair', 'pairs')} and near-misses…`
    );
  }
  try {
    const { aiReview, stopped } = await askForVerdicts({});
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
  // The survivor may be renamed in the same step: a group of spellings often
  // has no member that is the name the archive should end up with
  // ("Amazon", "amazon" -> "Amazon EU S.a.r.l."). Prefilled with the name it
  // has, so leaving it alone is the default.
  const htmlName = `<label class="dup-dialog__field" for="dupTargetName"><span class="zr-label">Name of the survivor</span><input class="zr-input" type="text" id="dupTargetName" maxlength="${num(MAX_TARGET_NAME)}" value="${esc(targetName)}" autocomplete="off" spellcheck="false"></label>`;
  return `<p>${esc(sentence)}</p><p>${esc(deleted)}</p><ul class="dup-dialog__list">${htmlNames}</ul>${htmlName}<p class="zr-sm dup-dialog__note">${esc(UNDO_NOTE)}</p>${htmlCopy}`;
}

/**
 * The name the merge request should carry, or null when the field was left
 * as it was. The rename is an option of the merge, not a second request, so
 * "unchanged" has to mean "say nothing" — otherwise every merge would rename
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
  // updateFoot() does this on the way back out, but nothing else runs on the
  // way in — without it a running card stays tickable.
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
 * One merge, from the confirm dialog to the reloaded log. Both ways into a
 * merge end here — a group the scan proposed and a pair the user put together
 * by hand — because the request, the dialog, the answers and the undo note are
 * the same thing in both cases. Only where the outcome is shown differs, and
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
    // as soon as the promise is handed back — and it is gone again once the
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
        message: payload.message || 'Not everything could be merged',
      };
      if (!batch) {
        toast(payload.message || 'Not everything could be merged', {
          tone: 'danger',
        });
      }
    } else {
      throw new Error(payload.error || payload.message || 'The merge failed.');
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
   one after the other — never in parallel, Paperless-ngx gets one bulk edit at
   a time — with every card reporting exactly what a single merge reports. Only
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

/** True when any card on the page carries a verdict from the AI review. */
function anyGroupVerdict() {
  let found = false;
  groups.forEach((state) => {
    const verdict = state.group.aiVerdict;
    if (verdict && AI_VERDICT_LABELS[String(verdict.verdict)]) found = true;
  });
  return found;
}

function setSelectionProgress(text) {
  if (!el.selectionProgress) return;
  el.selectionProgress.textContent = text;
  el.selectionProgress.classList.toggle('hidden', text === '');
}

function setSelectionBusy(busy) {
  [
    el.mergeSelectedBtn,
    el.reviewThenMergeBtn,
    el.selectAllBtn,
    el.selectAiSameBtn,
    el.clearSelectionBtn,
    el.selectMinBtn,
  ].forEach((button) => {
    if (button) button.disabled = busy;
  });
  // The one-click path would scan over a running batch; it waits like the rest.
  updateAiButton();
}

function updateSelectionBar() {
  updateSelectionConsequence();
  if (!el.selection) return;
  // While a batch runs the bar is the batch's: its cards go busy and leave the
  // selection one by one, which would otherwise pull the progress line away.
  if (merging) return;
  const entries = selectedBatch();
  const documents = entries.reduce(
    (sum, entry) => sum + countDocuments(entry.sources),
    0
  );
  if (el.selectionCount) {
    el.selectionCount.textContent =
      entries.length === 0
        ? 'No groups selected'
        : `${entries.length} ${plural(entries.length, 'group', 'groups')} selected` +
          ` · ${documents} ${plural(documents, 'document', 'documents')}`;
  }
  if (el.selectAiSameBtn) {
    el.selectAiSameBtn.classList.toggle('hidden', !anyGroupVerdict());
  }
  if (el.mergeSelectedBtn) el.mergeSelectedBtn.disabled = entries.length === 0;
  if (el.reviewThenMergeBtn) {
    el.reviewThenMergeBtn.disabled = entries.length === 0;
  }
  // The count beside "Select ≥" counts selectable cards, which is what a card
  // going busy or finishing changes.
  updateMinConfidenceCount();
  // The bar appears as soon as a card can be selected, so "Select all" is
  // reachable before the first tick; without any selectable card it hides —
  // unless it is still reporting what the last batch did.
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

function clearSelection() {
  selectedGroups.clear();
  eachGroupCard((card) => {
    const check = card.querySelector('.dup-select');
    if (check) check.checked = false;
  });
  setSelectionProgress('');
  updateSelectionBar();
}

/** One line per group: what survives, what goes into it, how many documents. */
function htmlBatchLine(entry) {
  const documents = countDocuments(entry.sources);
  const names = entry.sources
    .map((member) => String(member.name == null ? '' : member.name))
    .join(', ');
  const targetName = String(entry.target.name == null ? '' : entry.target.name);
  return `<li><strong>${esc(targetName)}</strong> ← ${esc(names)} <span class="zr-faint">(${num(documents)} ${esc(plural(documents, 'document', 'documents'))})</span></li>`;
}

/**
 * The one dialog of a batch. It names every group, both totals and the same
 * undo promise a single merge makes, and offers the copied matching rule once
 * for the whole batch rather than per group.
 *
 * @param {object[]} entries   what selectedBatch() returned
 * @param {boolean} offerCopy  at least one group has a rule to hand over
 */
function htmlBatchDialog(entries, offerCopy) {
  const documents = entries.reduce(
    (sum, entry) => sum + countDocuments(entry.sources),
    0
  );
  const deleted = entries.reduce((sum, entry) => sum + entry.sources.length, 0);
  const htmlLines = entries.map(htmlBatchLine).join('');
  const intro = `${entries.length} ${plural(entries.length, 'group is', 'groups are')} merged one after the other:`;
  const totals = `${documents} ${plural(documents, 'document', 'documents')} will be moved and ${deleted} ${plural(deleted, 'entry', 'entries')} deleted in Paperless-ngx.`;
  const htmlCopy = htmlCopyRuleCheck(offerCopy);
  // One line, once, and only where the guided path exists at all. The matcher
  // is the page's own answer; the model is an offer beside it.
  const htmlTip = aiReviewOffered()
    ? `<p class="zr-sm zr-faint dup-dialog__tip">${esc(GUIDED_TIP)}</p>`
    : '';
  return `<p>${esc(intro)}</p><ul class="dup-dialog__list">${htmlLines}</ul><p>${esc(totals)}</p><p class="zr-sm dup-dialog__note">${esc(UNDO_NOTE)}</p>${htmlTip}${htmlCopy}`;
}

/**
 * Walk a batch: every entry through the request a single merge uses, one after
 * the other, and a failure on one group leaves the rest running. Both paths
 * into a batch end here — "Merge selected" and the guided review — so the
 * progress line, the toast, the one log reload and what is left ticked
 * afterwards are the same thing in both cases.
 *
 * @param {object[]} entries  what selectedBatch() returned, possibly filtered
 * @param {boolean} copyMatchingRule  the one answer the dialog collected
 */
async function runBatch(entries, copyMatchingRule) {
  merging = true;
  setSelectionBusy(true);
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
        `${num(outcome.documentsMoved)} ${plural(outcome.documentsMoved, 'document', 'documents')} in ${seconds} s`
      );
    } else {
      failed += 1;
      markApply(
        entry.state.group.id,
        'failed',
        (outcome && outcome.message) || 'Paperless-ngx refused it'
      );
    }
  }
  drawApplyBar(entries.length, entries.length);

  const summary =
    `Merged ${merged} ${plural(merged, 'group', 'groups')}, ` +
    `${documents} ${plural(documents, 'document', 'documents')}` +
    (failed > 0 ? `, ${failed} failed` : '');
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
  // The plan is a reading of the cards, and the cards have just changed.
  renderPlan();
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
 * trusts the matcher — or has no review configured at all.
 */
async function mergeSelected() {
  if (merging) return;
  const entries = selectedBatch();
  if (entries.length === 0) return;

  const offerCopy = entries.some((entry) =>
    groupOffersCopy(entry.state, entry.target)
  );
  const answer = confirmDialog({
    title: `Merge ${entries.length} ${plural(entries.length, 'group', 'groups')}`,
    html: htmlBatchDialog(entries, offerCopy),
    confirmLabel: 'Merge all',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  // The button carries what pressing it writes, on its second line.
  const documents = entries.reduce(
    (sum, entry) => sum + countDocuments(entry.sources),
    0
  );
  const deleted = entries.reduce((sum, entry) => sum + entry.sources.length, 0);
  setDialogPrimary(
    lastDialog(),
    'Merge all',
    `${documents} ${plural(documents, 'document', 'documents')} rewritten · ${deleted} ${plural(deleted, 'deletion', 'deletions')} · no model asked · one Undo each`
  );
  const copyMatchingRule = copyRuleAnswer('dupCopyRuleAll');
  if (!(await answer)) return;

  await runBatch(entries, copyMatchingRule());
}

/* --- ask the AI about the selection, then merge --------------------------- */
/* The guided path, and an offer rather than a condition: it asks the model
   about exactly the groups that are ticked, puts the verdicts on the cards as
   a full review would, and then shows them once in a dialog whose ticks decide
   what is merged. A verdict never blocks anything — "different" and "unsure"
   only come up unticked, and any row can be ticked again. */

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
 * changed — a member gone, a different target — keeps what the answer says;
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
 * One row of a verdict dialog: what would be merged, and what the model — or
 * the spelling rule the server applied instead — said about it. Both dialogs
 * share it, so a verdict reads the same in the guided path and in the
 * proposal; only the cell class differs, which is how the proposal styles and
 * finds its own column.
 *
 * @param {object} entry     what selectedBatch() / proposalEntries() returned
 * @param {string} cellClass classes of the tick cell
 */
function htmlReviewRow(entry, cellClass) {
  const group = entry.state.group;
  const verdict = group.aiVerdict;
  const value = verdict ? String(verdict.verdict) : '';
  // Only a "same" that is settled comes up ticked — a spelling rule or a model
  // that says it is sure. Everything else is the user's call.
  const htmlChecked = isSureSame(verdict) ? ' checked' : '';
  const documents = countDocuments(entry.sources);
  const targetName = String(entry.target.name == null ? '' : entry.target.name);
  const names = entry.sources
    .map((member) => String(member.name == null ? '' : member.name))
    .join(', ');
  const htmlVerdict =
    htmlVerdictChip(verdict) || '<span class="zr-faint">not judged</span>';
  const htmlCandidate =
    group.source === AI_CANDIDATE_SOURCE
      ? '<span class="zr-badge zr-badge--info">AI suggested</span>'
      : '';
  const reason = verdict ? shortReason(verdict.reason) : '';
  return `<tr data-group-id="${esc(String(group.id))}" data-documents="${num(documents)}" data-sources="${num(entry.sources.length)}" data-verdict="${esc(value)}">
    <td data-label="Merge" class="${esc(cellClass)}"><input type="checkbox" class="zr-check dup-review-pick" value="${esc(String(group.id))}"${htmlChecked} aria-label="Merge into ${esc(targetName)}"></td>
    <td data-label="Group"><span class="dup-review__names"><strong>${esc(targetName)}</strong> <span class="zr-faint">←</span> ${esc(names)}</span>${htmlCandidate}</td>
    <td data-label="Documents" class="zr-mono">${num(documents)}</td>
    <td data-label="AI">${htmlVerdict}</td>
    <td data-label="Basis">${htmlBasisBadge(verdict)}</td>
    <td data-label="Why" class="dup-review__reason">${esc(reason)}</td>
  </tr>`;
}

/** The table both verdict dialogs are built around. */
function htmlVerdictTable(htmlRows) {
  return `<div class="zr-table-wrap"><table class="zr-table zr-table--stack dup-review-table">
      <thead>
        <tr>
          <th class="dup-review__pick">Merge</th>
          <th>Group</th>
          <th>Documents</th>
          <th>AI</th>
          <th>Basis</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>${htmlRows}</tbody>
    </table></div>`;
}

/** The copy-rule question both batch dialogs ask once for all their groups. */
function htmlCopyRuleCheck(offerCopy) {
  return offerCopy
    ? `<label class="dup-dialog__check"><input type="checkbox" class="zr-check" id="dupCopyRuleAll" checked><span>Copy a source's matching rule where the target has none</span></label>`
    : '';
}

function htmlReviewDialog(entries, offerCopy) {
  const htmlRows = entries
    .map((entry) => htmlReviewRow(entry, 'dup-review__pick'))
    .join('');
  return `${htmlVerdictTable(htmlRows)}
    <p class="zr-sm dup-review__summary" id="dupReviewSummary"></p>
    <p class="zr-sm dup-dialog__note">${esc(UNDO_NOTE)}</p>${htmlCopyRuleCheck(offerCopy)}`;
}

/**
 * "N of M ticked · K documents", live while the checks are used, and what the
 * merge would delete where the dialog promises to say so.
 *
 * @param {HTMLElement} dialog
 * @param {number} total       rows the dialog shows
 * @param {boolean} [withDeleted]  also count the objects that would be deleted
 */
function pickedSummaryText(dialog, total, withDeleted) {
  const picked = [...dialog.querySelectorAll('.dup-review-pick')].filter(
    (check) => check.checked
  );
  const rowOf = (check) => check.closest('tr');
  const documents = picked.reduce((sum, check) => {
    const row = rowOf(check);
    return sum + num(row ? row.dataset.documents : 0);
  }, 0);
  const text = `${picked.length} of ${total} ticked · ${documents} ${plural(documents, 'document', 'documents')}`;
  if (!withDeleted) return text;
  const deleted = picked.reduce((sum, check) => {
    const row = rowOf(check);
    return sum + num(row ? row.dataset.sources : 0);
  }, 0);
  return `${text} · ${deleted} ${plural(deleted, 'object', 'objects')} will be deleted`;
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
  const answer = confirmDialog({
    title: `The AI on ${entries.length} ${plural(entries.length, 'group', 'groups')}`,
    html: htmlReviewDialog(entries, offerCopy),
    confirmLabel: 'Merge ticked',
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
    const update = () => {
      if (summary) {
        summary.textContent = pickedSummaryText(dialog, entries.length);
      }
      picked = [...dialog.querySelectorAll('.dup-review-pick')]
        .filter((check) => check.checked)
        .map((check) => check.value);
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
    setSelectionProgress('Nothing was ticked; nothing was merged.');
    window.setTimeout(() => {
      setSelectionProgress('');
      updateSelectionBar();
    }, SELECTION_SUMMARY_MS);
    return;
  }
  // Whatever stayed unticked keeps its tick on the page, so the groups the
  // model was unsure about are still in front of the user afterwards.
  await runBatch(ticked, copyMatchingRule());
}

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
    `Asking the AI about ${ids.length} ${plural(ids.length, 'group', 'groups')}…`
  );
  if (el.aiNotice) el.aiNotice.innerHTML = '';
  let asked = false;
  try {
    const { aiReview, stopped } = await askForVerdicts({
      groupIds: ids,
      includeCandidates: false,
    });
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

/* --- the AI proposal: one click, one overview, deselect what you do not want */
/* The path for an archive nobody wants to work through group by group: one
   button scans, lets the model judge everything the scan found and everything
   in the band below it, and then shows one proposal. Only what is settled —
   a spelling rule, or a model that says it is sure — comes up ticked; the rest
   waits. Nothing merges until the dialog is confirmed, and every other path on
   this page is exactly what it was. */

/** The first line of the proposal dialog: what a tick means. */
const PROPOSAL_LEGEND =
  'Pre-ticked: settled by a spelling rule, or the model is sure. ' +
  'Everything else waits for you.';

/** Every card that could be merged right now — the rows of the proposal. */
function proposalEntries() {
  const entries = [];
  eachGroupCard((card, state) => {
    if (selectBlockReason(card, state) !== '') return;
    const entry = entryFor(card, state);
    if (entry) entries.push(entry);
  });
  return entries;
}

/**
 * The order of the proposal: what is settled first, then what needs a look,
 * and inside a verdict the strongest match first. Pure on purpose —
 * tests/test-duplicates-ui.js evaluates it and sorts a list with it.
 */
function compareProposalEntries(a, b) {
  const rank =
    proposalRank(a.state.group.aiVerdict) -
    proposalRank(b.state.group.aiVerdict);
  if (rank !== 0) return rank;
  return num(b.state.group.confidence) - num(a.state.group.confidence);
}

function htmlProposalDialog(entries, offerCopy) {
  const htmlRows = entries
    .map((entry) => htmlReviewRow(entry, 'dup-review__pick dup-proposal-pick'))
    .join('');
  return `<p class="zr-sm zr-faint dup-proposal__legend">${esc(PROPOSAL_LEGEND)}</p>
    <div class="dup-proposal__quick">
      <button type="button" class="zr-btn zr-btn--ghost" id="dupProposalTickSame">Tick all same</button>
      <button type="button" class="zr-btn zr-btn--ghost" id="dupProposalUntickAll">Untick all</button>
    </div>
    ${htmlVerdictTable(htmlRows)}
    <p class="zr-sm dup-review__summary" id="dupProposalSummary"></p>
    <p class="zr-sm dup-dialog__note">${esc(UNDO_NOTE)}</p>${htmlCopyRuleCheck(offerCopy)}`;
}

/**
 * The proposal itself: every judged group in one table, sorted by verdict,
 * with the sure ones ticked. What stays ticked is merged through the batch
 * runner of round 4; cancelling leaves the verdicts on the cards and ticks
 * nothing.
 */
async function confirmProposal(entries) {
  const sorted = [...entries].sort(compareProposalEntries);
  const sure = sorted.filter((entry) =>
    isSureSame(entry.state.group.aiVerdict)
  ).length;
  const offerCopy = sorted.some((entry) =>
    groupOffersCopy(entry.state, entry.target)
  );
  const answer = confirmDialog({
    title: `The AI's proposal: ${sure} of ${sorted.length} ${plural(sorted.length, 'group', 'groups')}`,
    html: htmlProposalDialog(sorted, offerCopy),
    confirmLabel: 'Merge ticked',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  const dialog = lastDialog();
  const copyMatchingRule = copyRuleAnswer('dupCopyRuleAll');
  let picked = [];
  if (dialog) {
    // Six columns need the room the guided dialog already takes, and a little
    // more: the proposal shows every group of a scan, not a handful.
    dialog.classList.add(
      'zr-dialog--wide',
      'dup-review-dialog',
      'dup-proposal-dialog'
    );
    const summary = dialog.querySelector('#dupProposalSummary');
    const update = () => {
      if (summary) {
        summary.textContent = pickedSummaryText(dialog, sorted.length, true);
      }
      picked = [...dialog.querySelectorAll('.dup-review-pick')]
        .filter((check) => check.checked)
        .map((check) => check.value);
    };
    update();
    dialog.addEventListener('change', (event) => {
      if (event.target.classList.contains('dup-review-pick')) update();
    });
    // The two quick buttons are type="button" inside the dialog's form, so
    // neither of them closes it.
    dialog.addEventListener('click', (event) => {
      const tickSame = event.target.closest('#dupProposalTickSame');
      const untickAll = event.target.closest('#dupProposalUntickAll');
      if (!tickSame && !untickAll) return;
      dialog.querySelectorAll('.dup-review-pick').forEach((check) => {
        const row = check.closest('tr');
        const verdict = row ? row.dataset.verdict : '';
        check.checked = Boolean(tickSame) && verdict === 'same';
      });
      update();
    });
  }
  if (!(await answer)) {
    // Cancelled: the verdicts stay on the cards, and nothing is ticked.
    clearSelection();
    return;
  }

  const wanted = new Set(picked);
  const ticked = sorted.filter((entry) =>
    wanted.has(String(entry.state.group.id))
  );
  if (ticked.length === 0) {
    setSelectionProgress('Nothing was ticked; nothing was merged.');
    updateSelectionBar();
    window.setTimeout(() => {
      setSelectionProgress('');
      updateSelectionBar();
    }, SELECTION_SUMMARY_MS);
    return;
  }
  // The selection bar reports the batch, so it has to hold exactly what runs.
  clearSelection();
  selectGroups((state) => wanted.has(String(state.group.id)));
  await runBatch(ticked, copyMatchingRule());
}

function setProposalStatus(text) {
  if (!el.aiProposalStatus) return;
  el.aiProposalStatus.textContent = text;
  el.aiProposalStatus.classList.toggle('hidden', text === '');
}

function setProposalBusy(active) {
  if (!el.aiProposalBtn) return;
  proposing = active;
  const use = el.aiProposalIcon ? el.aiProposalIcon.querySelector('use') : null;
  if (use) {
    use.setAttribute(
      'href',
      active ? '/icons.svg#i-refresh' : '/icons.svg#i-wand'
    );
  }
  if (el.aiProposalIcon) {
    el.aiProposalIcon.classList.toggle('zr-icon--spin', active);
  }
  updateAiButton();
}

/**
 * One click: scan, let the model judge every group and every near-miss, then
 * propose. The scan is the one the button beside it runs — same kind, same
 * sensitivity, same hidden pairs — and the review is the one "Ask the AI"
 * sends, only never narrowed. Two requests in total, and no merge until the
 * dialog is confirmed.
 */
async function runAiProposal() {
  if (!el.aiProposalBtn || scanning || aiReviewing || merging || proposing) {
    return;
  }
  // The same dialog the button beside it opens: what the run does, what it
  // costs, what it changes, and the levers that make it cheaper.
  if (!(await confirmRun('Scan and ask the AI'))) return;
  setProposalBusy(true);
  clearAiNotice();
  try {
    setProposalStatus('Scanning…');
    await runScan();
    // A failed scan has already said so where the results are; the proposal
    // has nothing to add and nothing to ask about.
    if (!scanned) return;
    // From here the run meter says what is happening, how far it is and what
    // it costs; a second line above it saying the same thing in other words
    // is what this panel had too much of.
    setProposalStatus('');
    setAiReviewing(true);
    let outcome;
    try {
      outcome = await askForVerdicts({ includeCandidates: true });
    } finally {
      setAiReviewing(false);
    }
    // Stopped means the model did not see everything, so there is nothing to
    // propose; the notice above the results says what happened.
    if (outcome.stopped) return;
    if (el.aiNotice) {
      el.aiNotice.innerHTML = htmlFailedRequests(outcome.aiReview);
    }
    setProposalStatus('');
    const entries = proposalEntries();
    if (entries.length === 0) {
      if (el.aiNotice) {
        el.aiNotice.innerHTML = htmlAlert(
          'info',
          '',
          'Nothing came back that could be merged.'
        );
      }
      return;
    }
    await confirmProposal(entries);
  } catch (error) {
    if (el.aiNotice) {
      el.aiNotice.innerHTML = htmlAlert(
        'danger',
        'The AI proposal failed',
        error.message
      );
    }
  } finally {
    setProposalStatus('');
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
  if (el.selectAllBtn) {
    el.selectAllBtn.addEventListener('click', () => selectGroups(() => true));
  }
  if (el.selectAiSameBtn) {
    el.selectAiSameBtn.addEventListener('click', () =>
      selectGroups(
        (state) =>
          Boolean(state.group.aiVerdict) &&
          state.group.aiVerdict.verdict === 'same'
      )
    );
  }
  if (el.clearSelectionBtn) {
    el.clearSelectionBtn.addEventListener('click', clearSelection);
  }
  updateSelectionBar();
}

/* --- merge by hand -------------------------------------------------------- */
/* A merge nobody proposed: the user names the target and the sources out of
   the whole list of one kind. Everything that makes a merge safe — the confirm
   dialog, the verified deletion, the log entry, the undo — is the code above;
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
    ? `Merge by hand · ${records.length} ${KIND_PLURALS[manual.kind]}`
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
  el.manualMerge.title = locked
    ? 'The API token may not change every entry you picked'
    : '';
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
      throw new Error(payload.error || 'The list could not be loaded.');
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
      // record and the field have to learn the new name — otherwise the next
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
      throw new Error(payload.error || 'The pair could not be hidden.');
    }
    groups.delete(card.dataset.groupId);
    selectedGroups.delete(card.dataset.groupId);
    card.remove();
    updateSelectionBar();
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

/* --- unused objects ------------------------------------------------------- */
/* The other half of a tidy archive: objects that are not duplicates of
   anything because they carry no document at all. The scan reports them, this
   section lists them, and deleting them goes through the same log and the same
   undo as a merge — the server checks every id against Paperless-ngx again
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
 * What the confirm dialog asks before anything is deleted. It names the
 * number, the kind and the way back, because nothing else on this page
 * removes an object the user did not look at member by member.
 *
 * @param {{kind: string}[]} entries
 * @returns {string}
 */
function unusedConfirmText(entries) {
  const count = entries.length;
  const kinds = new Set(entries.map((entry) => normalizeKind(entry.kind)));
  const kind = [...kinds][0];
  const label =
    kinds.size === 1
      ? plural(count, KIND_LABELS[kind].toLowerCase(), KIND_PLURALS[kind])
      : plural(count, 'object', 'objects');
  return `Delete ${count} unused ${label}? Undo re-creates them from the log, with new ids.`;
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
  el.unusedSummary.textContent = `Unused (${unusedRows().length})`;
}

function updateUnusedButton() {
  updateUnusedConsequence();
  if (!el.unusedDelete) return;
  const picked = unusedPicked().length;
  el.unusedDelete.disabled = deletingUnused || picked === 0;
  if (el.unusedSelectAll) el.unusedSelectAll.disabled = deletingUnused;
  const htmlPicked = picked > 0 ? ` (${num(picked)})` : '';
  el.unusedDelete.innerHTML = deletingUnused
    ? `${htmlIcons.spin}<span>Deleting…</span>`
    : `${htmlIcons.trash}<span>Delete selected${htmlPicked}</span>`;
}

/**
 * Draws the section for a scan result. A scan that found nothing unused still
 * opens the section — "nothing unused" is an answer, and a section that stayed
 * hidden would read as "not looked at".
 */
function renderUnused(data) {
  if (!el.unused || !el.unusedBody) return;
  unusedEntries = unusedFromScan(data);
  el.unusedAlert.innerHTML = '';
  el.unusedBody.innerHTML = unusedEntries.length
    ? htmlUnusedRows(unusedEntries)
    : '<tr><td colspan="4" class="zr-empty">Nothing unused.</td></tr>';
  el.unused.classList.remove('hidden');
  updateUnusedSummary();
  updateUnusedButton();
  renderPlan();
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

async function deleteUnused() {
  if (deletingUnused) return;
  const picked = unusedPicked();
  if (picked.length === 0) return;

  const confirmed = await confirmDialog({
    title: 'Delete unused objects',
    body: unusedConfirmText(picked),
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;

  el.unusedAlert.innerHTML = '';
  unusedRows().forEach((row) => {
    const note = row.querySelector('.dup-unused__error');
    if (note) note.textContent = '';
  });
  setUnusedBusy(true);

  // One request per kind: the endpoint deletes one kind at a time, and a
  // mixed selection is the normal case after a scan over both.
  const byKind = new Map();
  picked.forEach((entry) => {
    if (!byKind.has(entry.kind)) byKind.set(entry.kind, []);
    byKind.get(entry.kind).push(entry.id);
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
          payload.error || payload.message || 'The delete failed.'
        );
      }
      (data.deleted || []).forEach((entry) => {
        const row = unusedRowOf(kind, entry.id);
        if (row) row.remove();
        removed += 1;
      });
      failed.forEach((entry) => {
        markUnusedFailure(kind, entry.id, entry.error);
        problems += 1;
      });
    }
    if (unusedRows().length === 0) {
      el.unusedBody.innerHTML =
        '<tr><td colspan="4" class="zr-empty">Nothing unused.</td></tr>';
    }
    toast(
      problems === 0
        ? `${removed} unused ${plural(removed, 'object', 'objects')} deleted`
        : `${removed} deleted, ${problems} kept. The reason is next to each one.`,
      { tone: problems === 0 ? 'ok' : 'danger' }
    );
  } catch (error) {
    el.unusedAlert.innerHTML = htmlAlert(
      'danger',
      'The delete failed',
      error.message
    );
    toast(error.message, { tone: 'danger' });
  }
  setUnusedBusy(false);
  updateUnusedSummary();
  // A delete is a log entry like a merge, so the table below must show it.
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
  if (documentId <= 0) return '<span class="zr-faint">–</span>';
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
      const date = window.zrDate.format(item.createdAt, { fallback: '–' });
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
  el.mappingsSummary.textContent = `Names mapped while processing (${mappingRecords.length})`;
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
      throw new Error(payload.error || 'The mappings could not be loaded.');
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
    title: 'Forget the mappings',
    body: 'Clears the list only. Nothing in Paperless-ngx changes: the names were mapped when the documents were analysed.',
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
      throw new Error(payload.error || 'The mappings could not be cleared.');
    }
    mappingRecords = [];
    renderMappings();
    toast(payload.message || 'The mappings were forgotten', { tone: 'ok' });
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
      const date = window.zrDate.format(entry.createdAt, { fallback: '–' });
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
      // A delete moved no document and merged nothing away; both cells say so
      // rather than showing a zero that reads like a failed merge.
      const htmlMerged = deleteRow
        ? '<td data-label="Merged" class="dup-log__sources zr-faint">–</td>'
        : `<td data-label="Merged" class="zr-truncate dup-log__sources" title="${esc(names)}">${esc(names)}</td>`;
      const htmlDocuments = deleteRow
        ? '<td data-label="Documents" class="zr-mono zr-faint">–</td>'
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
  const names = logSourceNames(entry);
  const target = String(entry.targetName == null ? '' : entry.targetName);
  // A delete row has no target and moved no document, so promising to move
  // documents back would be a promise about nothing.
  // A split has no target either, and it did more than move documents: the
  // sentence has to name everything an undo takes back.
  const sentence = isSplitEntry(entry)
    ? 'Undo this split? The tag is re-created with a new id, its documents get it back, the topics and the document type this split set are removed again.'
    : isDeleteEntry(entry)
      ? `Re-creates ${names} in Paperless-ngx with new ids. They carried no document when they were deleted, so nothing is moved.`
      : `Re-creates ${names} in Paperless-ngx with new ids and moves the documents back. Documents that no longer carry ${target} are left alone.`;
  const confirmed = await confirmDialog({
    title: isSplitEntry(entry)
      ? 'Undo this split'
      : isDeleteEntry(entry)
        ? 'Undo this delete'
        : 'Undo this merge',
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

/* --- the plan: a scan read as four baskets -------------------------------- */
/* A scan of a grown archive answers with dozens of groups that all look the
   same in a table. The plan is the same answer read out loud: what is plainly
   the same thing, what the model confirmed, what it could not settle without
   a word from the user, and what carries no document at all. Every line is a
   sentence with the numbers in it, and every button on it delegates to the
   card the scan already built — the plan is a way of reading the result, not
   a second copy of it. */

/** At or above this a pair is the same thing whatever a model would say. */
const PLAIN_SCORE = 0.95;

/** The four baskets, in the order they are read. */
const BASKET_PLAIN = 'plain';
const BASKET_SAME = 'same';
const BASKET_ASK = 'ask';

/**
 * Warnings that are a question rather than a note. An inbox tag and a large
 * group are things to know about a merge; these four are things only the user
 * can decide, so a group carrying one of them goes into the ask basket
 * however well it scored.
 */
const ASK_WARNINGS = [
  'has-matching-rule',
  'configured-tag',
  'no-permission',
  'owner-differs',
];

/**
 * What the rule the model named means, as half a sentence. The keys are the
 * contract (AiVerdict.basis in schemas.js); the wording belongs to this page.
 */
const AI_BASIS_PHRASES = {
  'case-or-spacing': 'same word, different case',
  umlaut: 'one spelling writes the umlaut out',
  'legal-form': 'the legal form is the only difference',
  plural: 'singular and plural of the same word',
  abbreviation: 'the long form and its abbreviation',
  translation: 'the same thing in two languages',
  synonym: 'two words for the same thing',
  typo: 'one of them is a typo',
  'different-thing': 'two different things',
  'different-topic': 'two different topics',
  'insufficient-evidence': 'not enough to go on',
};

/** The same, for what the string matcher saw when no model was asked. */
const REASON_PHRASES = {
  'exact-normalized': 'the same name',
  'umlaut-variant': 'an umlaut spelled two ways',
  'legal-form': 'the legal form is the only difference',
  plural: 'singular and plural',
  'token-order': 'the same words in another order',
  prefix: 'one name is how the other one starts',
  fuzzy: 'the spellings are close',
  semantic: 'the model looked past the spelling',
};

/** What the last finished review cost, for the ledger of the header card. */
let lastRunProgress = null;
/** The `aiReview` block of the last answer, or null after a plain scan. */
let lastRunReview = null;
/** The totals of the last scan, for the one sentence above the baskets. */
let lastScanTotals = null;

/**
 * Which basket a group belongs in. The first match wins, and the ask basket
 * is the floor: a group nothing settled is a question, never a proposal that
 * slips through because no rule named it.
 *
 * Pure on purpose — tests/test-duplicates-assistant-ui.js evaluates it.
 *
 * @param {object} state  a registered group state
 * @returns {string} one of the three basket names, or '' for a group the
 *   model called apart, which stays as it is and is in no basket at all
 */
function planBasketOf(state) {
  const group = (state && state.group) || {};
  const verdict = group.aiVerdict;
  const value = verdict ? String(verdict.verdict) : '';
  if (value === 'different') return '';
  const warnings = Array.isArray(group.warnings) ? group.warnings : [];
  if (
    value === 'unsure' ||
    warnings.some((warning) => ASK_WARNINGS.includes(warning))
  ) {
    return BASKET_ASK;
  }
  const reasons = Array.isArray(group.reasons) ? group.reasons : [];
  const plain =
    reasons.includes('exact-normalized') ||
    num(group.confidence) >= PLAIN_SCORE;
  if (plain) return BASKET_PLAIN;
  if (value === 'same') {
    // A pair the model confirmed below the sensitivity is still a pair the
    // scan would not have proposed; only a sure "same" carries it alone.
    return isSureSame(verdict) || num(group.confidence) >= currentThreshold()
      ? BASKET_SAME
      : BASKET_ASK;
  }
  return BASKET_ASK;
}

/** The cards of the page sorted into their baskets, in the order they stand. */
function planBuckets() {
  const buckets = { plain: [], same: [], ask: [], apart: [] };
  eachGroupCard((card, state) => {
    if (selectBlockReason(card, state) !== '') return;
    const basket = planBasketOf(state);
    if (basket === '') buckets.apart.push(state);
    else buckets[basket].push(state);
  });
  return buckets;
}

/** Everything the plan proposes without asking anything: plain plus same. */
function planObvious() {
  const buckets = planBuckets();
  return [...buckets.plain, ...buckets.same];
}

/** Documents that move when this group is merged as it stands. */
function planMovingDocuments(state) {
  return countDocuments(selectedSources(state));
}

/** Why this group is proposed, as half a sentence. */
function planPhrase(state) {
  const group = state.group;
  const basis = group.aiVerdict ? String(group.aiVerdict.basis) : '';
  if (AI_BASIS_PHRASES[basis]) return AI_BASIS_PHRASES[basis];
  const reasons = Array.isArray(group.reasons) ? group.reasons : [];
  const named = reasons.find((reason) => REASON_PHRASES[reason]);
  if (named) return REASON_PHRASES[named];
  return `${pct(group.confidence)} % of the spelling in common`;
}

/** Why this group is a question rather than a proposal. */
function planQuestion(state) {
  const group = state.group;
  const warnings = Array.isArray(group.warnings) ? group.warnings : [];
  if (warnings.includes('has-matching-rule')) {
    return 'one of them carries a matching rule the survivor does not';
  }
  if (warnings.includes('no-permission')) {
    return 'the API token may not change every object here';
  }
  if (warnings.includes('configured-tag')) {
    return 'one of these tags is named in the Zettelrobbe settings';
  }
  if (warnings.includes('owner-differs')) {
    return 'they belong to different owners in Paperless-ngx';
  }
  const verdict = group.aiVerdict;
  if (verdict && String(verdict.verdict) === 'unsure') {
    const said = shortReason(verdict.reason);
    return said === '' ? 'the model was unsure' : said;
  }
  const percent = pct(group.confidence);
  const floor = Math.round(currentThreshold() * 100);
  if (percent < floor) {
    return `only ${percent} % alike, under your ${floor} %`;
  }
  return `${percent} % alike, and nothing settled it`;
}

/** The names a merge would fold away, bold, as one phrase. */
function htmlPlanSources(state) {
  return selectedSources(state)
    .map(
      (member) =>
        `<strong>${esc(String(member.name == null ? '' : member.name))}</strong>`
    )
    .join(', ');
}

/** The name that survives, bold. */
function htmlPlanTarget(state) {
  const target = memberOf(state, state.targetId);
  const name = target ? String(target.name == null ? '' : target.name) : '';
  return `<strong>${esc(name)}</strong>`;
}

/**
 * One proposal as a sentence: what is folded into what, how many documents
 * move out of how many, and why.
 */
function htmlPlanLine(state) {
  const moving = planMovingDocuments(state);
  const total = groupDocuments(state);
  const htmlSources = htmlPlanSources(state);
  const htmlTarget = htmlPlanTarget(state);
  const aside = `${moving} of ${total} ${plural(total, 'document', 'documents')} move, ${planPhrase(state)}`;
  return `<div class="zr-basket__line" data-group-id="${esc(state.group.id)}">
      <p class="zr-basket__sentence">${htmlSources} folded into ${htmlTarget} — <span class="zr-basket__aside">${esc(aside)}</span></p>
      <button type="button" class="zr-btn zr-btn--ghost dup-basket-drop" data-group-id="${esc(state.group.id)}">Not the same</button>
    </div>`;
}

/** One question, with the two or three answers that settle it. */
function htmlPlanQuestion(state) {
  const target = memberOf(state, state.targetId);
  const targetName = target
    ? String(target.name == null ? '' : target.name)
    : '';
  const moving = planMovingDocuments(state);
  const sources = selectedSources(state);
  const htmlSources = htmlPlanSources(state);
  const htmlTarget = htmlPlanTarget(state);
  const aside = `${moving} ${plural(moving, 'document', 'documents')} would move — ${planQuestion(state)}`;
  const writes = `${moving} ${plural(moving, 'document', 'documents')} · ${sources.length} ${plural(sources.length, 'deletion', 'deletions')} · undoable`;
  return `<div class="zr-basket__question" data-group-id="${esc(state.group.id)}">
      <p class="zr-basket__sentence">${htmlSources} or ${htmlTarget}? <span class="zr-basket__aside">${esc(aside)}</span></p>
      <div class="zr-basket__choices">
        <button type="button" class="zr-btn zr-btn--stacked dup-basket-fold" data-group-id="${esc(state.group.id)}">Fold into ${esc(targetName)}<span class="zr-btn__sub">${esc(writes)}</span></button>
        <button type="button" class="zr-btn zr-btn--stacked dup-basket-keep" data-group-id="${esc(state.group.id)}">Keep both<span class="zr-btn__sub">nothing is written in Paperless-ngx</span></button>
        <button type="button" class="zr-btn zr-btn--ghost dup-basket-look" data-group-id="${esc(state.group.id)}">Look at it</button>
      </div>
    </div>`;
}

/**
 * One basket. `htmlBody` is already-escaped markup; an empty basket keeps its
 * heading and says so, because "nothing in here" is an answer and a basket
 * that disappeared would read as a basket nobody looked in.
 */
function htmlBasket(options) {
  const htmlMark = options.htmlMark;
  const htmlAction = options.htmlAction || '';
  const htmlBody = options.htmlBody || '';
  const toneClass = options.empty
    ? ' zr-basket--quiet'
    : options.ask
      ? ' zr-basket--ask'
      : '';
  const hiddenClass = options.collapsed ? ' hidden' : '';
  return `<section class="zr-basket${esc(toneClass)} dup-basket" data-basket="${esc(options.name)}">
      <div class="zr-basket__head">
        <span class="zr-basket__mark ${esc(options.mark)}">${htmlMark}</span>
        <span class="zr-basket__titles">
          <span class="zr-basket__title">${esc(options.title)}</span>
          <span class="zr-basket__note">${esc(options.note)}</span>
        </span>
        ${htmlAction}
      </div>
      <div class="zr-basket__body dup-basket__body${esc(hiddenClass)}" data-basket-body="${esc(options.name)}">${htmlBody}</div>
    </section>`;
}

/** "The same thing, plainly" — collapsed, because there is nothing to weigh. */
function htmlBasketPlain(states) {
  const count = states.length;
  const htmlAction =
    count > 0
      ? `<button type="button" class="zr-btn zr-btn--ghost dup-basket-toggle" data-basket="${esc(BASKET_PLAIN)}" aria-expanded="false">Show them</button>`
      : '';
  return htmlBasket({
    name: BASKET_PLAIN,
    mark: 'zr-basket__mark--ok',
    htmlMark: htmlPlanMarks.ok,
    title: `The same thing, plainly — ${count} ${plural(count, 'group', 'groups')}`,
    note:
      count === 0
        ? 'Nothing was that clear this time.'
        : 'Same name, or all but identical. There is nothing here to weigh up.',
    empty: count === 0,
    collapsed: true,
    htmlAction,
    htmlBody: states.map(htmlPlanLine).join(''),
  });
}

/** "The model says it is the same" — expanded, one sentence per group. */
function htmlBasketSame(states) {
  const count = states.length;
  const note =
    count === 0
      ? aiReviewOffered()
        ? 'The model has confirmed nothing here yet.'
        : 'No model is configured, so nothing is confirmed by one.'
      : 'It said why. Drop any line you disagree with.';
  return htmlBasket({
    name: BASKET_SAME,
    mark: 'zr-basket__mark--ok',
    htmlMark: htmlPlanMarks.wand,
    title: `The model says it is the same — ${count} ${plural(count, 'group', 'groups')}`,
    note,
    empty: count === 0,
    htmlBody: states.map(htmlPlanLine).join(''),
  });
}

/** "I need a word from you" — the amber basket, one question per group. */
function htmlBasketAsk(states) {
  const count = states.length;
  const htmlAction =
    count > 0
      ? `<button type="button" class="zr-btn dup-basket-walk">Walk me through them</button>`
      : '';
  return htmlBasket({
    name: BASKET_ASK,
    mark: 'zr-basket__mark--ask',
    htmlMark: htmlPlanMarks.ask,
    title: `I need a word from you — ${count} ${plural(count, 'group', 'groups')}`,
    note:
      count === 0
        ? 'Nothing is waiting on you.'
        : 'Too close to call from the spelling alone, or something about them needs deciding.',
    ask: count > 0,
    empty: count === 0,
    htmlAction,
    htmlBody: states.map(htmlPlanQuestion).join(''),
  });
}

/** "Leftovers" — the unused objects, written as one line over the old table. */
function htmlBasketLeftovers() {
  const entries = Array.isArray(unusedEntries) ? unusedEntries : [];
  const count = entries.length;
  const tags = entries.filter(
    (entry) => normalizeKind(entry.kind) === 'tags'
  ).length;
  const correspondents = count - tags;
  const htmlAction =
    count > 0
      ? `<button type="button" class="zr-btn zr-btn--ghost dup-basket-unused">Open the list</button>`
      : '';
  const sentence = `${tags} ${plural(tags, 'tag', 'tags')} and ${correspondents} ${plural(correspondents, 'correspondent', 'correspondents')} carry no document at all, so they are duplicates of nothing. Deleting them is logged below and can be undone; the re-created objects get new ids.`;
  const htmlBody =
    count === 0
      ? ''
      : `<div class="zr-basket__line">
          <p class="zr-basket__sentence">${esc(sentence)}</p>
        </div>`;
  return htmlBasket({
    name: 'leftovers',
    mark: '',
    htmlMark: htmlPlanMarks.leftovers,
    title: `Leftovers — ${count} ${plural(count, 'object', 'objects')}`,
    note:
      count === 0
        ? 'Every object the scan looked at carries at least one document.'
        : 'Not duplicates of anything — just nothing left using them.',
    empty: count === 0,
    htmlAction,
    htmlBody,
  });
}

/** The marks the four baskets wear. */
const htmlPlanMarks = {
  ok: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-check"/></svg>',
  wand: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-wand"/></svg>',
  ask: '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg>',
  leftovers:
    '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-inbox"/></svg>',
  arrow:
    '<svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#i-arrow-left"/></svg>',
  free: '<svg class="zr-icon zr-icon--sm zr-consequence__icon" aria-hidden="true"><use href="/icons.svg#i-check"/></svg>',
  cost: '<svg class="zr-icon zr-icon--sm zr-consequence__icon" aria-hidden="true"><use href="/icons.svg#i-info"/></svg>',
  running:
    '<svg class="zr-icon zr-icon--sm zr-icon--spin" aria-hidden="true"><use href="/icons.svg#i-refresh"/></svg>',
  waiting:
    '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-clock"/></svg>',
  failed:
    '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-alert"/></svg>',
};

/** The one sentence above the baskets: what was looked at and what came back. */
function planSentenceText(buckets) {
  const totals = lastScanTotals || {};
  const looked = [];
  if (totals.tags != null) {
    looked.push(
      `${num(totals.tags)} ${plural(num(totals.tags), 'tag', 'tags')}`
    );
  }
  if (totals.correspondents != null) {
    looked.push(
      `${num(totals.correspondents)} ${plural(num(totals.correspondents), 'correspondent', 'correspondents')}`
    );
  }
  const proposals = buckets.plain.length + buckets.same.length;
  const opening =
    looked.length > 0
      ? `I looked at ${looked.join(' and ')}.`
      : 'I looked at what you asked for.';
  const middle = `${proposals} ${plural(proposals, 'group is', 'groups are')} ready to merge, ${buckets.ask.length} ${plural(buckets.ask.length, 'needs', 'need')} a word from you`;
  const apart =
    buckets.apart.length > 0
      ? `, and ${buckets.apart.length} ${plural(buckets.apart.length, 'group the model called apart stays', 'groups the model called apart stay')} as ${plural(buckets.apart.length, 'it is', 'they are')}`
      : '';
  return `${opening} ${middle}${apart}.`;
}

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

/** A number of seconds the way a person says it. */
function formatSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} s`;
  if (total < 3600) return `${Math.max(1, Math.round(total / 60))} min`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return `${hours} h ${minutes} min`;
}

/**
 * The ledger of the header card: what the last review cost. A page that has
 * asked nothing yet says so rather than showing four zeros that look like a
 * measurement of something.
 */
function renderPlanLedger() {
  if (!el.planLedger) return;
  const review = lastRunReview;
  const progress = lastRunProgress || {};
  if (!review) {
    el.planLedger.innerHTML = `<span class="zr-ledger__item">${esc('No model has been asked about this scan — the numbers below come from the name matcher alone.')}</span>`;
    drawTokenbar(planTokenParts(), 0, 0, 0);
    return;
  }
  const tokens = num(review.tokens);
  const seconds = Math.round(num(progress.elapsedMs) / 1000);
  el.planLedger.innerHTML = [
    htmlLedgerItem(String(num(review.requests)), 'requests', false),
    htmlLedgerItem(formatTokens(tokens), 'tokens', false),
    htmlLedgerItem(formatSeconds(seconds), 'spent', false),
    htmlLedgerItem('0', 'writes', true),
  ].join('');
  drawTokenbar(
    planTokenParts(),
    progress.promptTokens,
    progress.completionTokens,
    progress.thinkingTotal
  );
}

/** The elements of the header card's token bar, as drawTokenbar wants them. */
function planTokenParts() {
  return {
    bar: el.planTokenbar,
    prompt: el.planSegPrompt,
    answer: el.planSegAnswer,
    thinking: el.planSegThinking,
    legend: el.planLegend,
  };
}

/** The three buttons of the header card, with what pressing each one costs. */
function updatePlanButtons(buckets) {
  const obvious = buckets.plain.length + buckets.same.length;
  if (el.planApplyBtn) {
    const states = planObvious();
    const documents = states.reduce(
      (sum, state) => sum + planMovingDocuments(state),
      0
    );
    const deletions = states.reduce(
      (sum, state) => sum + selectedSources(state).length,
      0
    );
    el.planApplyBtn.classList.toggle('hidden', obvious === 0);
    el.planApplyBtn.disabled = merging || proposing;
    if (el.planApplyLabel) {
      el.planApplyLabel.textContent = `Merge the ${obvious} agreed ${plural(obvious, 'one', 'ones')}`;
    }
    if (el.planApplySub) {
      el.planApplySub.textContent = `${documents} ${plural(documents, 'document', 'documents')} rewritten · ${deletions} ${plural(deletions, 'deletion', 'deletions')} · no model asked · one Undo each`;
    }
  }
  if (el.planStackBtn) {
    el.planStackBtn.classList.toggle('hidden', buckets.ask.length === 0);
    if (el.planStackLabel) {
      el.planStackLabel.textContent = `Walk me through the ${buckets.ask.length}`;
    }
    if (el.planStackSub) {
      el.planStackSub.textContent =
        'one pair per screen · no model, no writing';
    }
  }
  if (el.planAskBtn) {
    const pairs = reviewPairCount();
    el.planAskBtn.classList.remove('hidden');
    el.planAskBtn.disabled = scanning || aiReviewing || merging || proposing;
    if (el.planAskLabel) {
      el.planAskLabel.textContent = `Ask the AI about ${pairs} ${plural(pairs, 'pair', 'pairs')}`;
    }
    if (el.planAskSub) {
      el.planAskSub.textContent =
        'tokens, no writes — the dialog says what it costs first';
    }
  }
}

/** Draws the plan from the cards on the page. */
function renderPlan() {
  if (!el.plan || !el.baskets) return;
  if (groups.size === 0 && unusedEntries.length === 0) {
    el.plan.classList.add('hidden');
    showEverything(true);
    return;
  }
  const buckets = planBuckets();
  el.plan.classList.remove('hidden');
  if (el.planSentence) {
    el.planSentence.textContent = planSentenceText(buckets);
  }
  el.baskets.innerHTML = [
    htmlBasketPlain(buckets.plain),
    htmlBasketSame(buckets.same),
    htmlBasketAsk(buckets.ask),
    htmlBasketLeftovers(),
  ].join('');
  renderPlanLedger();
  updatePlanButtons(buckets);
}

/** Shows or folds away the full card list, the toolbar and the selection bar. */
function showEverything(visible) {
  if (!el.everything) return;
  el.everything.classList.toggle('hidden', !visible);
  if (el.showAllBtn) {
    el.showAllBtn.setAttribute('aria-expanded', visible ? 'true' : 'false');
  }
  if (el.showAllLabel) {
    el.showAllLabel.textContent = visible
      ? 'Hide the full list'
      : 'Show every group';
  }
}

/** The card behind a group id, or null when it has been merged away. */
function cardFor(groupId) {
  let found = null;
  eachGroupCard((card) => {
    if (card.dataset.groupId === String(groupId)) found = card;
  });
  return found;
}

/** Both halves of a group the plan acts on, or null when it is gone. */
function planEntry(groupId) {
  const state = groups.get(String(groupId));
  const card = cardFor(groupId);
  return state && card ? { state, card } : null;
}

/** Folds one group in from a basket, through the card the scan built. */
async function planFold(groupId) {
  const entry = planEntry(groupId);
  if (!entry) return;
  await mergeGroup(entry.card, entry.state);
  renderPlan();
}

/** Drops one group out of the plan: the pair is hidden, nothing is merged. */
async function planDrop(groupId) {
  const entry = planEntry(groupId);
  if (!entry) return;
  await dismissGroup(entry.card, entry.state);
  renderPlan();
}

/* --- the stack: one pair per screen --------------------------------------- */
/* The ask basket is a list of questions, and a list of questions is a list
   nobody answers. The stack asks them one at a time: two sides, the evidence
   under each name, what the model said, what pressing each button writes, and
   the three keys that do the same. It is a mode of this page, not a second
   page — the cards behind it never move, and every decision goes through the
   same merge request and the same log as a card would. */

/** Document titles a decision card shows per side, when the review fetched any. */
const DECISION_SAMPLES = 3;

const stack = {
  /** Group ids still to decide, in the order they were handed over. */
  ids: [],
  /** How far through the ids we are; equal to ids.length when it is done. */
  index: 0,
  /** What has been decided, newest last, so the last one can be taken back. */
  decisions: [],
  tally: { merged: 0, kept: 0, later: 0 },
  /** True while one decision is being written; the card is inert meanwhile. */
  busy: false,
  /** The pairs that were put off, so "decide later" comes round again. */
  later: [],
};

/** The group the stack is asking about right now, or null when it is done. */
function stackState() {
  const id = stack.ids[stack.index];
  return id === undefined ? null : groups.get(String(id)) || null;
}

/** What a member has to say for itself: its documents and its matching rule. */
function memberMetaText(member) {
  const count = num(member.documentCount);
  const algorithm = num(member.matchingAlgorithm);
  const match = String(member.match == null ? '' : member.match).trim();
  const rule =
    algorithm === 0 || match === ''
      ? 'no matching rule'
      : `rule: ${ALGORITHM_LABELS[algorithm] || 'none'} “${match}”`;
  return `${count} ${plural(count, 'document', 'documents')} · ${rule}`;
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

/** One side of a decision: what stays, or what goes away. */
function htmlDecisionSide(member, from) {
  const sideClass = from ? ' zr-decision__side--from' : '';
  const nameClass = from ? ' zr-decision__name--from' : '';
  const name = String(member.name == null ? '' : member.name);
  return `<div class="zr-decision__side${esc(sideClass)}">
      <div class="zr-decision__label">${esc(from ? 'GOES AWAY' : 'STAYS')}</div>
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
      <span class="zr-badge">${pct(group.confidence)} % alike</span>
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
        ? '<span class="zr-faint">–</span>'
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
      <span class="zr-label">${esc(`All ${members.length} in this group — keep, merge away`)}</span>
      <ul class="dup-decision__memberlist">${htmlRows}</ul>
    </div>`;
}

/** The amber offer to hand the survivor the matching rule it does not have. */
function htmlDecisionCopy(state, target) {
  if (!groupOffersCopy(state, target)) return '';
  const name = String(target.name == null ? '' : target.name);
  return `<label class="dup-decision__copy">
      <input type="checkbox" class="zr-check dup-stack-copy" checked>
      <span>${esc(`Copy the matching rule over to ${name}, so the documents it catches keep being caught`)}</span>
    </label>`;
}

/** What merging this group writes, in one sentence above the buttons. */
function decisionConsequenceText(state, target, copies) {
  const kind = normalizeKind(state.group.kind);
  const sources = selectedSources(state);
  const documents = countDocuments(sources);
  const rule = copies ? ', copies the matching rule over' : '';
  const deleted = `${sources.length} ${plural(sources.length, KIND_LABELS[kind].toLowerCase(), KIND_PLURALS[kind])}`;
  return `Merging rewrites ${documents} ${plural(documents, 'document', 'documents')} in Paperless-ngx${rule} and deletes ${deleted}. No model is asked. One Undo puts it all back.`;
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
  const offersCopy = groupOffersCopy(state, target);
  const targetName = String(target.name == null ? '' : target.name);
  const htmlAway = sources
    .map((member) => htmlDecisionSide(member, true))
    .join('');
  return `<div class="zr-decision" data-group-id="${esc(state.group.id)}">
      ${htmlDecisionHead(state)}
      <div class="zr-decision__sides">
        ${htmlDecisionSide(target, false)}
        <div class="zr-decision__arrow">${htmlPlanMarks.arrow}</div>
        ${htmlAway}
      </div>
      ${htmlDecisionMembers(state)}
      ${htmlNote}
      ${htmlDecisionCopy(state, target)}
      <p class="zr-consequence dup-decision__consequence">${htmlPlanMarks.cost}<span>${esc(decisionConsequenceText(state, target, offersCopy))}</span></p>
      <div class="zr-decision__actions">
        <button type="button" class="zr-btn zr-btn--primary dup-stack-merge">${htmlIcons.merge}<span>${esc(`Merge into ${targetName}`)}</span></button>
        <button type="button" class="zr-btn dup-stack-keep">Keep both</button>
        <button type="button" class="zr-btn zr-btn--ghost dup-stack-later">Decide later</button>
        <span class="zr-decision__keys">Enter · Esc · L</span>
      </div>
    </div>`;
}

/** What the stack says once every pair has had an answer. */
function htmlStackDone() {
  const tally = stack.tally;
  const sentence = `${tally.merged} merged, ${tally.kept} kept apart, ${tally.later} put off.`;
  return `<div class="zr-basket zr-basket--quiet dup-stack__done">
      <div class="zr-basket__head">
        <span class="zr-basket__mark zr-basket__mark--ok">${htmlPlanMarks.ok}</span>
        <span class="zr-basket__titles">
          <span class="zr-basket__title">Nothing left to ask</span>
          <span class="zr-basket__note">${esc(sentence)}</span>
        </span>
      </div>
    </div>`;
}

/** The one line a stack that has just undone something keeps above the card. */
function htmlStackNotice(text) {
  return `<p class="zr-consequence dup-stack__notice">${htmlPlanMarks.cost}<span>${esc(text)}</span></p>`;
}

function setStackBusy(busy) {
  stack.busy = busy;
  if (!el.stackCard) return;
  el.stackCard.querySelectorAll('button, input').forEach((control) => {
    control.disabled = busy;
  });
}

/** The run bar of the stack: where we are, and the one bulk offer beside it. */
function renderStackBar() {
  const total = stack.ids.length;
  const done = Math.min(stack.index, total);
  const left = Math.max(0, total - done);
  if (el.stackPosition) {
    el.stackPosition.textContent =
      left === 0
        ? `All ${total} ${plural(total, 'pair', 'pairs')} answered`
        : `Pair ${done + 1} of ${total}`;
  }
  if (el.stackFill) {
    const share = total === 0 ? 0 : Math.round((done / total) * 100);
    el.stackFill.style.width = `${share}%`;
  }
  if (el.stackRest) {
    el.stackRest.textContent =
      left === 0 ? '' : `${left} ${plural(left, 'is', 'are')} left`;
  }
  if (el.stackObviousBtn) {
    const obvious = planObvious();
    const documents = obvious.reduce(
      (sum, state) => sum + planMovingDocuments(state),
      0
    );
    el.stackObviousBtn.classList.toggle('hidden', obvious.length === 0);
    el.stackObviousBtn.disabled = merging || stack.busy;
    if (el.stackObviousLabel) {
      el.stackObviousLabel.textContent = `Take the ${obvious.length} obvious ${plural(obvious.length, 'one', 'ones')} in one go`;
    }
    if (el.stackObviousSub) {
      el.stackObviousSub.textContent = `${documents} ${plural(documents, 'document', 'documents')} rewritten · no model asked`;
    }
  }
  if (el.stackTally) {
    el.stackTally.textContent = `${stack.tally.merged} merged · ${stack.tally.kept} kept apart · ${stack.tally.later} put off`;
  }
  if (el.stackUndoBtn) {
    el.stackUndoBtn.disabled = stack.decisions.length === 0 || stack.busy;
  }
}

/** Draws the card the stack is on, or its closing line. */
function renderStack(notice) {
  if (!el.stack || !el.stackCard) return;
  const htmlNotice = notice ? htmlStackNotice(notice) : '';
  const state = stackState();
  const htmlCard = state ? htmlDecisionCard(state) : htmlStackDone();
  el.stackCard.innerHTML = `${htmlNotice}${htmlCard}`;
  renderStackBar();
}

/** Opens the stack over the plan, on the pairs it was handed. */
function openStack(ids) {
  if (!el.stack) return;
  stack.ids = ids.map((id) => String(id));
  stack.index = 0;
  stack.decisions = [];
  stack.later = [];
  stack.tally = { merged: 0, kept: 0, later: 0 };
  el.stack.classList.remove('hidden');
  renderStack('');
  el.stack.focus();
  el.stack.scrollIntoView({ block: 'start' });
}

function closeStack() {
  if (!el.stack) return;
  el.stack.classList.add('hidden');
  renderPlan();
}

/** Moves on, and puts the pairs that were put off at the end of the queue. */
function stackAdvance(notice) {
  stack.index += 1;
  if (stack.index >= stack.ids.length && stack.later.length > 0) {
    stack.ids = stack.ids.concat(stack.later);
    stack.later = [];
  }
  renderStack(notice || '');
}

/** The copy-rule answer of the card on screen. */
function stackCopyAnswer() {
  const check = el.stackCard
    ? el.stackCard.querySelector('.dup-stack-copy')
    : null;
  return Boolean(check && check.checked);
}

/**
 * Merge the pair on screen. The card is the confirmation — it named the
 * documents, the deletions and the undo before the button existed — so the
 * merge goes through the batch path of runMerge(), which asks nothing again.
 */
async function stackMerge() {
  const state = stackState();
  if (!state || stack.busy) return;
  const entry = planEntry(state.group.id);
  if (!entry) return;
  const target = memberOf(state, state.targetId);
  const sources = selectedSources(state);
  if (!target || sources.length === 0) return;
  let mergeId = null;
  const outcome = await runMerge({
    kind: normalizeKind(state.group.kind),
    target,
    sources,
    offerCopy: groupOffersCopy(state, target),
    batch: { copyMatchingRule: stackCopyAnswer() },
    busy: (on) => setStackBusy(on),
    result: (markup, status) => {
      if (status === 'done') {
        finishGroup(entry.card, markup);
        return;
      }
      const holder = entry.card.querySelector('.dup-group__result');
      if (holder) holder.innerHTML = markup;
    },
    done: (data) => {
      mergeId = data && data.mergeId != null ? num(data.mergeId) : null;
    },
  });
  setStackBusy(false);
  if (!outcome || outcome.status !== 'done') {
    toast((outcome && outcome.message) || 'The merge failed', {
      tone: 'danger',
    });
    renderStack('');
    return;
  }
  stack.tally.merged += 1;
  stack.decisions.push({
    action: 'merge',
    groupId: String(state.group.id),
    mergeId,
  });
  const moved = num(outcome.documentsMoved);
  const name = String(target.name == null ? '' : target.name);
  toast(
    `Merged ${moved} ${plural(moved, 'document', 'documents')} into ${name}`,
    { tone: 'ok' }
  );
  loadLog(true);
  stackAdvance('');
}

/** Keep both: the pair is hidden from the next scan, nothing is merged. */
async function stackKeep() {
  const state = stackState();
  if (!state || stack.busy) return;
  const entry = planEntry(state.group.id);
  if (!entry) return;
  setStackBusy(true);
  await dismissGroup(entry.card, state);
  setStackBusy(false);
  stack.tally.kept += 1;
  stack.decisions.push({
    action: 'keep',
    groupId: String(state.group.id),
    kind: normalizeKind(state.group.kind),
    ids: (state.group.members || []).map((member) => num(member.id)),
  });
  stackAdvance('');
}

/** Decide later: the pair comes round again at the end of the queue. */
function stackLater() {
  const state = stackState();
  if (!state || stack.busy) return;
  stack.tally.later += 1;
  stack.later.push(String(state.group.id));
  stack.decisions.push({ action: 'later', groupId: String(state.group.id) });
  stackAdvance('');
}

/**
 * Takes the last decision back. A merge is undone in Paperless-ngx, which
 * re-creates the objects with new ids — so that pair cannot simply be asked
 * about again, and the stack says so instead of offering a card that would
 * fail. A "keep both" and a "decide later" wrote nothing that cannot simply
 * be put back.
 */
async function stackUndo() {
  const decision = stack.decisions.pop();
  if (!decision || stack.busy) {
    renderStackBar();
    return;
  }
  if (decision.action === 'later') {
    stack.tally.later = Math.max(0, stack.tally.later - 1);
    stack.later = stack.later.filter((id) => id !== decision.groupId);
    stack.index = Math.max(0, stack.index - 1);
    renderStack('');
    return;
  }
  setStackBusy(true);
  try {
    if (decision.action === 'merge') {
      if (decision.mergeId === null) {
        throw new Error(
          'This merge was not logged, so it cannot be undone here.'
        );
      }
      const payload = await postJson(
        `/api/duplicates/log/${num(decision.mergeId)}/undo`,
        {}
      );
      if (!payload.success) {
        throw new Error(payload.error || 'The undo failed.');
      }
      stack.tally.merged = Math.max(0, stack.tally.merged - 1);
      loadLog(true);
      toast(payload.message || 'The merge was undone', { tone: 'ok' });
      renderStack(
        'Undone — the objects are back in Paperless-ngx with new ids. Scan again to decide about them.'
      );
    } else {
      await undoDismissal(decision.kind, decision.ids);
      stack.tally.kept = Math.max(0, stack.tally.kept - 1);
      stack.index = Math.max(0, stack.index - 1);
      loadDismissals();
      renderStack('');
    }
  } catch (error) {
    toast(error.message, { tone: 'danger' });
    renderStack('');
  } finally {
    setStackBusy(false);
  }
}

/**
 * Un-hides every pair a "keep both" hid. The dismiss endpoint answers with a
 * count rather than ids, so the rows are found again by the members they
 * were written for.
 *
 * @param {string} kind
 * @param {number[]} ids  the members of the group that was kept apart
 */
async function undoDismissal(kind, ids) {
  const payload = await requestJson('/api/duplicates/dismissals');
  const list = Array.isArray(payload.data) ? payload.data : [];
  const wanted = new Set((ids || []).map((id) => num(id)));
  const rows = list.filter(
    (item) =>
      normalizeKind(item.kind) === normalizeKind(kind) &&
      wanted.has(num(item.idA)) &&
      wanted.has(num(item.idB))
  );
  for (const row of rows) {
    await requestJson(`/api/duplicates/dismissals/${num(row.id)}`, {
      method: 'DELETE',
    });
  }
}

/** The keys of the stack, and the one place they are allowed to fire. */
function stackKeydown(event) {
  if (!el.stack || el.stack.classList.contains('hidden')) return;
  if (stack.busy) return;
  const target = event.target;
  // A key pressed inside a field is that field's business, and a key on a
  // button is the button's — the browser already clicks it.
  if (target && target.closest('input, select, textarea, button, a')) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    stackMerge();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    stackKeep();
  } else if (event.key === 'l' || event.key === 'L') {
    event.preventDefault();
    stackLater();
  }
}

function initStack() {
  if (!el.stack || !el.stackCard) return;

  el.stackCard.addEventListener('click', (event) => {
    if (event.target.closest('.dup-stack-merge')) stackMerge();
    else if (event.target.closest('.dup-stack-keep')) stackKeep();
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
      const card = cardFor(state.group.id);
      if (card) renderMembers(card, state);
      renderStack('');
      return;
    }
    if (input.classList.contains('dup-stack-source')) {
      const id = num(input.value);
      if (input.checked) state.selected.add(id);
      else state.selected.delete(id);
      const card = cardFor(state.group.id);
      if (card) renderMembers(card, state);
      renderStack('');
    }
  });

  if (el.stackCloseBtn) el.stackCloseBtn.addEventListener('click', closeStack);
  if (el.stackUndoBtn) el.stackUndoBtn.addEventListener('click', stackUndo);
  if (el.stackObviousBtn) {
    el.stackObviousBtn.addEventListener('click', () => mergeObvious());
  }
  el.stack.addEventListener('keydown', stackKeydown);
}

/* --- the cost layer ------------------------------------------------------- */
/* Asking costs tokens; applying costs writes. The page said neither before,
   so a run was "something is happening" and a merge was a button. Three
   surfaces fix that: what a run will cost before it starts, what it has cost
   while it runs, and what every button that writes will write. */

/** The lanes the preflight offers. One is the safe default on a local model. */
const RUN_LANE_OPTIONS = [1, 3, 5, 8];

/** How much of the run's token budget has to be gone before it is named. */
const CEILING_SHOWN_ABOVE = 0.5;

/* The round numbers the page falls back to while the estimate endpoint is
   not there yet. They are the ones services/aiRunEstimate.js guesses with —
   restated here because a browser cannot require a Node module — and a plan
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
 * measurements, so `basis` is always 'guess' and the dialog says so in words.
 *
 * @param {{lanes:number, sweep:boolean, excerpts:boolean}} levers
 * @returns {object} the shape of GET /api/duplicates/ai-review/estimate
 */
function localRunEstimate(levers) {
  const pairs = reviewPairCount();
  const size = GUESS_BATCH_SIZE;
  const requests = Math.ceil(pairs / size);
  const entities = [...groups.values()].reduce(
    (sum, state) => sum + (state.group.members || []).length,
    0
  );
  const sweepRequests = levers.sweep
    ? Math.ceil(entities / GUESS_SWEEP_BATCH)
    : 0;
  const excerptReads = levers.excerpts ? entities : 0;
  const all = requests + sweepRequests;
  const prompt = (GUESS_PROMPT_BASE + GUESS_PROMPT_PER_ITEM * size) * all;
  const completion = GUESS_TOKENS_PER_ITEM * size * all;
  const thinking = GUESS_THINKING_PER_REQUEST * all;
  const lanes = Math.max(1, num(levers.lanes) || 1);
  const seconds = Math.round(
    ((completion + thinking) / GUESS_TOKENS_PER_SECOND / Math.max(1, all)) *
      (all / lanes)
  );
  return {
    groups: groups.size,
    pairs,
    needsScan: !scanned,
    items: pairs,
    itemsByRule: 0,
    batchSize: size,
    lanes,
    requests: all,
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
    extra: { sweepRequests, excerptReads },
    lastRun: null,
  };
}

/**
 * What a run will cost, from the server where it can answer and from the
 * arithmetic above where it cannot.
 *
 * The endpoint is built beside this page. Until it answers, this is the one
 * function the seam runs through: nothing else on the page knows whether the
 * numbers were measured or guessed, because everything reads `basis`.
 *
 * @param {object} levers  what the "Cheaper, if you want" block currently says
 * @returns {Promise<object>} an estimate in the shape the brief fixed
 */
async function fetchRunEstimate(levers) {
  const params = new URLSearchParams({
    kind: selectedKind(),
    threshold: String(currentThreshold()),
    sweep: levers.sweep ? 'true' : 'false',
    excerpts: levers.excerpts ? 'true' : 'false',
    lanes: String(num(levers.lanes) || 1),
  });
  try {
    const payload = await requestJson(
      `/api/duplicates/ai-review/estimate?${params}`
    );
    if (payload && payload.success && payload.data) {
      return { ...localRunEstimate(levers), ...payload.data };
    }
  } catch {
    // No endpoint, no network, no answer: the page still has to be able to
    // say what a run will roughly cost, and to say that it is a guess.
  }
  return localRunEstimate(levers);
}

/** Where the numbers come from, in a handful of words. */
function estimateBasisText(estimate) {
  if (estimate.basis === 'run') return 'Measured on your last run';
  if (estimate.basis === 'model') {
    const model = estimate.model ? String(estimate.model) : 'your model';
    return `Measured on ${model}`;
  }
  return 'A rough guess — nothing measured yet';
}

/**
 * A length of time a person can feel, rather than one that looks measured.
 * "about 3:51 min" reads like a promise; this is an estimate, so it rounds.
 */
function roughTime(seconds) {
  const total = Math.max(0, num(seconds));
  if (total < 45) return 'under a minute';
  if (total < 5400) {
    const minutes = Math.max(1, Math.round(total / 60));
    return `${minutes} min`;
  }
  return `${Math.round(total / 360) / 10} h`;
}

/** The one sentence above the numbers: what the run actually asks about. */
function preflightLede(estimate) {
  if (estimate.needsScan === true) {
    return 'Nothing has been scanned yet, so I scan first and then ask. The numbers below are what the asking usually costs.';
  }
  const pairs = num(estimate.items);
  const groups = num(estimate.groups);
  if (pairs <= 0) {
    return 'The name matcher settled everything it found. There is nothing left to ask about.';
  }
  return `I ask the model about ${pairs} ${plural(pairs, 'pair', 'pairs')} the spelling alone cannot settle, out of ${groups} ${plural(groups, 'group', 'groups')} it found.`;
}

/**
 * The hero: the time first, because that is what anyone feels, the price
 * under it, and the token split as the one graphic in the dialog.
 */
function htmlPreflightHero(estimate) {
  const tokens = estimate.tokens || {};
  const total = num(tokens.total);
  const share = (value) =>
    total <= 0 ? '0%' : `${Math.round((num(value) / total) * 100)}%`;
  const requests = `${num(estimate.requests)} ${plural(estimate.requests, 'request', 'requests')}`;
  const ceiling = num(estimate.tokenBudget);
  const htmlCeiling =
    ceiling > 0
      ? `<p class="zr-preflight__basis">${esc(`It stops itself at ${formatTokens(ceiling)} tokens.`)}</p>`
      : '';
  // A part that cost nothing is left out of the legend: "0 answer" next to a
  // bar with no green in it is a reading exercise, not information.
  const htmlKeys = [
    { part: 'prompt', value: tokens.prompt, word: 'question' },
    { part: 'answer', value: tokens.completion, word: 'answer' },
    { part: 'thinking', value: tokens.thinking, word: 'thinking' },
  ]
    .filter((key) => num(key.value) > 0)
    .map(
      (key) =>
        `<span class="zr-tokenbar__key"><span class="zr-tokenbar__dot zr-tokenbar__dot--${esc(key.part)}"></span>${esc(`${formatTokens(key.value)} ${key.word}`)}</span>`
    )
    .join('');
  const htmlBar =
    total <= 0
      ? ''
      : `<div class="zr-tokenbar">
      <div class="zr-tokenbar__track">
        <span class="zr-tokenbar__seg zr-tokenbar__seg--prompt" style="width:${esc(share(tokens.prompt))}"></span>
        <span class="zr-tokenbar__seg zr-tokenbar__seg--answer" style="width:${esc(share(tokens.completion))}"></span>
        <span class="zr-tokenbar__seg zr-tokenbar__seg--thinking" style="width:${esc(share(tokens.thinking))}"></span>
      </div>
      <div class="zr-tokenbar__legend">${htmlKeys}</div>
    </div>`;
  return `<div class="zr-preflight__hero">
      <span class="zr-preflight__time">${esc(roughTime(estimate.seconds))}</span>
      <span class="zr-preflight__sub">${esc(`${requests} · ${formatTokens(total)} tokens`)}</span>
      ${htmlBar}
      <p class="zr-preflight__basis">${esc(estimateBasisText(estimate))}</p>
      ${htmlCeiling}
    </div>`;
}

/**
 * The levers, folded away behind Options. Each says what it costs in three
 * words, not a sentence, and the ids stay what the listener knows them as.
 */
function htmlEstimateLevers(estimate, levers) {
  const extra = estimate.extra || {};
  const htmlSweepChecked = levers.sweep ? ' checked' : '';
  const htmlExcerptsChecked = levers.excerpts ? ' checked' : '';
  const htmlLanes = RUN_LANE_OPTIONS.map((lanes) => {
    const htmlSelected = num(lanes) === num(levers.lanes) ? ' selected' : '';
    return `<option value="${num(lanes)}"${htmlSelected}>${num(lanes)}</option>`;
  }).join('');
  const htmlSensitivity = [...(el.sensitivity ? el.sensitivity.options : [])]
    .map((option) => {
      // An attribute fragment, not a value: the "html" prefix is what marks
      // it as already-safe markup for the escaping check.
      const htmlSelected =
        option.value === levers.sensitivity ? ' selected' : '';
      return `<option value="${esc(option.value)}"${htmlSelected}>${esc(option.textContent)}</option>`;
    })
    .join('');
  const sweepPrice = num(extra.sweepRequests);
  const htmlSweepPrice =
    sweepPrice > 0
      ? `<span class="zr-sm zr-faint">${esc(`+${sweepPrice} ${plural(sweepPrice, 'request', 'requests')}`)}</span>`
      : '';
  const reads = num(extra.excerptReads);
  const htmlReadPrice =
    reads > 0
      ? `<span class="zr-sm zr-faint">${esc(`${reads} document ${plural(reads, 'read', 'reads')}`)}</span>`
      : '';
  return `<div class="zr-preflight__levers">
      <label class="zr-preflight__lever">
        <input type="checkbox" class="zr-check" id="dupRunSweep"${htmlSweepChecked}>
        <span>Look at the whole list for synonyms</span>
        ${htmlSweepPrice}
      </label>
      <label class="zr-preflight__lever">
        <input type="checkbox" class="zr-check" id="dupRunExcerpts"${htmlExcerptsChecked}>
        <span>Read excerpts where spelling cannot decide</span>
        ${htmlReadPrice}
      </label>
      <label class="zr-preflight__lever" for="dupRunSensitivity">
        <span>Sensitivity</span>
        <select class="zr-select" id="dupRunSensitivity">${htmlSensitivity}</select>
      </label>
      <label class="zr-preflight__lever" for="dupRunLanes">
        <span>Requests at a time</span>
        <select class="zr-select" id="dupRunLanes">${htmlLanes}</select>
      </label>
    </div>`;
}

/**
 * The whole preflight body: one sentence, one number, one graphic, one
 * promise, and everything adjustable folded away.
 */
function htmlPreflight(estimate, levers) {
  const safe =
    estimate.needsScan === true
      ? 'Nothing is merged. The scan only looks.'
      : 'Nothing is merged while this runs.';
  const htmlOptions = `<details class="zr-preflight__options"><summary class="zr-preflight__summary"><svg class="zr-icon zr-icon--sm zr-preflight__chevron" aria-hidden="true"><use href="/icons.svg#i-chevron-right"/></svg>Options</summary>${htmlEstimateLevers(estimate, levers)}</details>`;
  return `<div class="zr-preflight" id="dupPreflight">
      <p class="zr-preflight__lede">${esc(preflightLede(estimate))}</p>
      ${htmlPreflightHero(estimate)}
      <p class="zr-preflight__safe">${htmlPlanMarks.free}<span>${esc(safe)}</span></p>
      ${htmlOptions}
    </div>`;
}

/** The dialog's own primary button, with the price on its second line. */
function setDialogPrimary(dialog, label, sub) {
  const button = dialog ? dialog.querySelector('[value="ok"]') : null;
  if (!button) return;
  button.classList.add('zr-btn--stacked');
  button.innerHTML =
    '<span class="dup-preflight__btnlabel"></span><span class="zr-btn__sub"></span>';
  const labelNode = button.querySelector('.dup-preflight__btnlabel');
  const subNode = button.querySelector('.zr-btn__sub');
  if (labelNode) labelNode.textContent = label;
  if (subNode) subNode.textContent = sub;
}

/**
 * What the preflight hands the kernel dialog. Three of its four values follow
 * `needsScan`, which is why they are decided in one place rather than four.
 *
 * @param {object} estimate  what fetchRunEstimate() answered
 * @param {object} levers    the state of the "Cheaper, if you want" block
 * @param {string} label     what the primary button does, without its price
 * @returns {object} the argument of confirmDialog
 */
function preflightOptions(estimate, levers, label) {
  const scanFirst = estimate.needsScan === true;
  return {
    title: scanFirst ? 'Scan, then ask the AI' : label,
    html: htmlPreflight(estimate, levers),
    confirmLabel: scanFirst ? 'Scan, then ask' : label,
    cancelLabel: 'Not now',
    tone: 'primary',
  };
}

/**
 * The dialog every model-backed run opens first: what it does, what it costs,
 * what it changes, and the levers that make it cheaper. Every lever re-asks
 * the estimate and rewrites the numbers and the button.
 *
 * @param {string} label  what the primary button does, without its price
 * @returns {Promise<boolean>} true when the run was confirmed
 */
async function confirmRun(label) {
  const levers = {
    sweep: Boolean(el.aiSweep && el.aiSweep.checked),
    excerpts: Boolean(el.aiExcerpts && el.aiExcerpts.checked),
    sensitivity: el.sensitivity ? el.sensitivity.value : '',
    lanes: RUN_LANE_OPTIONS[1],
  };
  let estimate = await fetchRunEstimate(levers);
  const answer = confirmDialog(preflightOptions(estimate, levers, label));
  const dialog = lastDialog();
  if (dialog) {
    // Not wide any more: the dialog is one sentence, one number and one bar,
    // and a wide box around that only spreads it thin.
    dialog.classList.add('dup-preflight-dialog');
    // The button says what it does; what it costs is the number above it.
    const redraw = async () => {
      estimate = await fetchRunEstimate(levers);
      const body = dialog.querySelector('.zr-dialog__body');
      if (!body) return;
      const wasOpen =
        body.querySelector('.zr-preflight__options')?.open === true;
      body.innerHTML = htmlPreflight(estimate, levers);
      const options = body.querySelector('.zr-preflight__options');
      if (options) options.open = wasOpen;
    };
    dialog.addEventListener('change', (event) => {
      const input = event.target;
      if (input.id === 'dupRunSweep') levers.sweep = input.checked;
      else if (input.id === 'dupRunExcerpts') levers.excerpts = input.checked;
      else if (input.id === 'dupRunSensitivity')
        levers.sensitivity = input.value;
      else if (input.id === 'dupRunLanes') levers.lanes = num(input.value);
      else return;
      redraw();
    });
  }
  const confirmed = await answer;
  if (!confirmed) return false;
  // The levers of the dialog are the page's own controls: what was decided
  // here is what the run is started with, and what the page shows afterwards.
  if (el.aiSweep) {
    el.aiSweep.checked = levers.sweep;
    storeWrite(STORE_KEYS.aiSweep, levers.sweep);
  }
  if (el.aiExcerpts) el.aiExcerpts.checked = levers.excerpts;
  if (el.sensitivity && levers.sensitivity !== '') {
    el.sensitivity.value = levers.sensitivity;
    storeWrite(STORE_KEYS.sensitivity, levers.sensitivity);
    updateThresholdField();
  }
  return true;
}

/* --- the run meter -------------------------------------------------------- */

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
 * matter. It is the whole run's budget, not one request's — the panel used to
 * print it beside the request in flight, which read as if a single question
 * were allowed two hundred thousand tokens.
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
    ? `${formatTokens(spent)} of the ${formatTokens(budget)} this run may spend — it stops itself there.`
    : '';
}

/** What one finished request cost, as a sentence rather than a row of cells. */
function reqlogWhatText(record) {
  const index = num(record.index);
  const items = num(record.items);
  const answers = num(record.answers);
  const unit = plural(items, 'pair', 'pairs');
  if (record.outcome === 'empty') {
    const thought = num(record.thinkingTokens);
    return thought > 0
      ? `Request ${index} — thought for ${formatTokens(thought)} tokens and answered nothing`
      : `Request ${index} — answered nothing usable`;
  }
  if (record.outcome === 'failed') {
    return `Request ${index} — the provider or the budget ended it; its ${items} ${unit} are marked unsure`;
  }
  if (record.outcome === 'partial') {
    return `Request ${index} — ${items} ${unit}, ${answers} answered; the rest were asked again`;
  }
  return `Request ${index} — ${items} ${unit}, ${answers} answered`;
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

/** The last handful of requests, newest first. */
/**
 * The request being answered right now, as the first row of the log. This is
 * where "the model is thinking" belongs: on the request that is thinking,
 * with what it has spent, rather than in the headline above everything.
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
      ? `Request ${index} — ${pairs} ${plural(pairs, 'pair', 'pairs')}, ${answers} answered so far`
      : `Request ${index}`;
  const cost =
    running > 0
      ? `${formatTokens(running)} so far${thinking ? ', thinking' : ''}`
      : 'thinking';
  return `<div class="zr-reqlog__row zr-reqlog__row--live">
      <span class="zr-reqlog__mark">${htmlPlanMarks.running}</span>
      <span class="zr-reqlog__what">${esc(what)}</span>
      <span class="zr-reqlog__cost">${esc(cost)}</span>
      <span class="zr-reqlog__state">running</span>
    </div>`;
}

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
        const htmlMark = warn ? htmlPlanMarks.failed : htmlPlanMarks.ok;
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

/** What stopping now keeps, on the second line of the Stop button. */
function setStopSub(text) {
  if (!el.aiStopSub || !el.aiStopBtn) return;
  el.aiStopSub.textContent = text;
  // The base button is a one-line flex row; only a button that has something
  // on its second line lays its two lines out itself.
  el.aiStopBtn.classList.toggle('zr-btn--stacked', text !== '');
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
  const judged = num(state.pairsJudged);
  setStopSub(
    judged > 0
      ? `keeps ${judged} ${plural(judged, 'verdict', 'verdicts')}`
      : 'nothing is written either way'
  );
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
  setStopSub('');
}

/* --- applying: the live checklist ----------------------------------------- */
/* A batch merge used to be one line in the selection bar that counted up. It
   is the most destructive thing this page does, so it gets the room: one row
   per group, the one being written now, the rest waiting, and a failure in
   its own colour with what Paperless-ngx said about it and a button that
   tries that one again. Merges run one after the other on purpose — Paperless
   gets one bulk edit at a time. */

/** What the checklist is walking right now, so a retry can find its entry. */
let applyEntries = [];

/** One row of the checklist, in the state it is in. */
function htmlApplyRow(entry, state, detail) {
  const targetName = String(entry.target.name == null ? '' : entry.target.name);
  const names = entry.sources
    .map((member) => String(member.name == null ? '' : member.name))
    .join(', ');
  const documents = countDocuments(entry.sources);
  const htmlMarks = {
    waiting: htmlPlanMarks.waiting,
    running: htmlPlanMarks.running,
    done: htmlPlanMarks.ok,
    failed: htmlPlanMarks.failed,
  };
  const rowClass =
    state === 'running'
      ? ' zr-reqlog__row--live'
      : state === 'failed'
        ? ' zr-reqlog__row--warn'
        : '';
  const what = `${targetName} ← ${names}`;
  const htmlRetry =
    state === 'failed'
      ? `<button type="button" class="zr-btn zr-btn--ghost dup-apply-retry" data-group-id="${esc(entry.state.group.id)}">Try it now</button>`
      : '';
  return `<div class="zr-reqlog__row${esc(rowClass)}" data-apply-id="${esc(entry.state.group.id)}">
      <span class="zr-reqlog__mark">${htmlMarks[state]}</span>
      <span class="zr-reqlog__what">${esc(what)}</span>
      <span class="zr-reqlog__cost">${esc(detail || `${documents} ${plural(documents, 'document', 'documents')}`)}</span>
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
        ? `All ${total} ${plural(total, 'group', 'groups')} written`
        : `Group ${Math.min(done + 1, total)} of ${total}`;
  }
  if (el.applyFill) {
    const share = total === 0 ? 0 : Math.round((done / total) * 100);
    el.applyFill.style.width = `${share}%`;
  }
  if (el.applyRest) {
    const left = Math.max(0, total - done);
    el.applyRest.textContent =
      left === 0 ? '' : `${left} ${plural(left, 'is', 'are')} waiting`;
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

/**
 * Merges everything the plan proposes without asking: plain plus same. It
 * ticks those groups and hands them to the batch the page already has, so
 * there is one dialog, one runner and one wording for what a batch writes.
 */
async function mergeObvious() {
  if (merging) return;
  const states = planObvious();
  if (states.length === 0) return;
  const wanted = new Set(states.map((state) => String(state.group.id)));
  clearSelection();
  selectGroups((state) => wanted.has(String(state.group.id)));
  await mergeSelected();
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
      `${num(outcome.documentsMoved)} ${plural(outcome.documentsMoved, 'document', 'documents')} moved`
    );
  } else {
    markApply(
      groupId,
      'failed',
      (outcome && outcome.message) || 'It failed again'
    );
  }
  loadLog(true);
  renderPlan();
}

/* --- what every writing button writes ------------------------------------- */

/** The consequence line of "Merge selected". */
function updateSelectionConsequence() {
  if (!el.selectionConsequence) return;
  const entries = selectedBatch();
  if (entries.length === 0) {
    el.selectionConsequence.classList.add('hidden');
    el.selectionConsequence.innerHTML = '';
    return;
  }
  const documents = entries.reduce(
    (sum, entry) => sum + countDocuments(entry.sources),
    0
  );
  const deleted = entries.reduce((sum, entry) => sum + entry.sources.length, 0);
  const text = `Merging rewrites ${documents} ${plural(documents, 'document', 'documents')} in Paperless-ngx and deletes ${deleted} ${plural(deleted, 'object', 'objects')}. No model is asked. Every group can be undone from the log.`;
  el.selectionConsequence.classList.remove('hidden');
  el.selectionConsequence.innerHTML = `${htmlPlanMarks.cost}<span>${esc(text)}</span>`;
}

/** The consequence line of the Merge button in "Merge by hand". */
function updateManualConsequence() {
  if (!el.manualConsequence) return;
  const target = manualTargetRecord();
  const sources = manualSourceRecords();
  if (!target || sources.length === 0) {
    el.manualConsequence.classList.add('hidden');
    el.manualConsequence.innerHTML = '';
    return;
  }
  const documents = sources.reduce(
    (sum, record) => sum + num(record.documentCount),
    0
  );
  const name = String(target.name == null ? '' : target.name);
  const text = `Merging rewrites ${documents} ${plural(documents, 'document', 'documents')} onto ${name} and deletes ${sources.length} ${plural(sources.length, 'object', 'objects')} in Paperless-ngx. No model is asked. One Undo puts it all back.`;
  el.manualConsequence.classList.remove('hidden');
  el.manualConsequence.innerHTML = `${htmlPlanMarks.cost}<span>${esc(text)}</span>`;
}

/** The consequence line of "Delete selected" in the Unused section. */
function updateUnusedConsequence() {
  if (!el.unusedConsequence) return;
  const picked = unusedPicked();
  if (picked.length === 0) {
    el.unusedConsequence.classList.add('hidden');
    el.unusedConsequence.innerHTML = '';
    return;
  }
  const text = `Deleting removes ${picked.length} ${plural(picked.length, 'object', 'objects')} from Paperless-ngx. They carry no document, so nothing is moved and no model is asked. Undo re-creates them with new ids.`;
  el.unusedConsequence.classList.remove('hidden');
  el.unusedConsequence.innerHTML = `${htmlPlanMarks.cost}<span>${esc(text)}</span>`;
}

/** The consequence line inside a group card, above its Merge button. */
function updateGroupConsequence(card, state) {
  const holder = card.querySelector('.dup-group__consequence');
  if (!holder) return;
  const target = memberOf(state, state.targetId);
  const sources = selectedSources(state);
  if (!target || sources.length === 0) {
    holder.classList.add('hidden');
    holder.innerHTML = '';
    return;
  }
  holder.classList.remove('hidden');
  holder.innerHTML = `${htmlPlanMarks.cost}<span>${esc(decisionConsequenceText(state, target, false))}</span>`;
}

/* --- wiring the three surfaces -------------------------------------------- */

function initPlan() {
  if (!el.plan || !el.baskets) return;

  el.baskets.addEventListener('click', (event) => {
    const toggle = event.target.closest('.dup-basket-toggle');
    if (toggle) {
      const name = toggle.dataset.basket;
      const body = el.baskets.querySelector(`[data-basket-body="${name}"]`);
      if (!body) return;
      const open = body.classList.contains('hidden');
      body.classList.toggle('hidden', !open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? 'Hide them' : 'Show them';
      return;
    }
    if (event.target.closest('.dup-basket-walk')) {
      openStack(planBuckets().ask.map((state) => state.group.id));
      return;
    }
    if (event.target.closest('.dup-basket-unused')) {
      if (el.unused) {
        el.unused.open = true;
        el.unused.scrollIntoView({ block: 'start' });
      }
      return;
    }
    const drop = event.target.closest('.dup-basket-drop');
    if (drop) {
      planDrop(drop.dataset.groupId);
      return;
    }
    const fold = event.target.closest('.dup-basket-fold');
    if (fold) {
      planFold(fold.dataset.groupId);
      return;
    }
    const keep = event.target.closest('.dup-basket-keep');
    if (keep) {
      planDrop(keep.dataset.groupId);
      return;
    }
    const look = event.target.closest('.dup-basket-look');
    if (look) openStack([look.dataset.groupId]);
  });

  if (el.showAllBtn && el.everything) {
    el.showAllBtn.addEventListener('click', () => {
      showEverything(el.everything.classList.contains('hidden'));
    });
  }
  if (el.planApplyBtn) {
    el.planApplyBtn.addEventListener('click', () => mergeObvious());
  }
  if (el.planStackBtn) {
    el.planStackBtn.addEventListener('click', () => {
      openStack(planBuckets().ask.map((state) => state.group.id));
    });
  }
  if (el.planAskBtn) {
    el.planAskBtn.addEventListener('click', () => {
      if (scanned) runAiReview();
      else runAiProposal();
    });
  }
  if (el.applyList) {
    el.applyList.addEventListener('click', (event) => {
      const retry = event.target.closest('.dup-apply-retry');
      if (retry) retryApply(retry.dataset.groupId);
    });
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
  if (el.aiReviewBtn) {
    el.aiReviewBtn.addEventListener('click', runAiReview);
    updateAiButton();
  }
  if (el.aiProposalBtn) {
    el.aiProposalBtn.addEventListener('click', runAiProposal);
  }
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

  if (el.aiSweep) {
    // The sweep costs requests of its own, so it is off until it is asked
    // for — and stays on for the next visit once it has been.
    el.aiSweep.checked = storeRead(STORE_KEYS.aiSweep) === 'true';
    el.aiSweep.addEventListener('change', () => {
      storeWrite(STORE_KEYS.aiSweep, el.aiSweep.checked);
    });
  }

  initSensitivity();
  initResultsBar();
  initSelection();
  initPlan();
  initStack();
  initManual();
  initUnused();
  initMappings();
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
