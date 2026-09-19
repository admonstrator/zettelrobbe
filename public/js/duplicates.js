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
};

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
  aiNotice: document.getElementById('dupAiNotice'),
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
/** True while a batch merge walks its groups; the bar then belongs to it. */
let merging = false;
/** True from the click on "AI proposal" until its dialog is done with. */
let proposing = false;

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
  return `<span class="zr-chip dup-verdict ${esc(AI_VERDICT_TONES[value])}" title="${esc(verdictTitle(verdict))}">${htmlIcon}${esc(AI_VERDICT_LABELS[value])}${htmlConfidenceSuffix(verdict)}</span>`;
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
  return `<span class="zr-sm dup-member__verdict ${esc(AI_VERDICT_TONES[value])}" title="${esc(verdictTitle(verdict))}">${esc(AI_VERDICT_LABELS[value])}${htmlConfidenceSuffix(verdict)}</span>`;
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
  // check and the count in the bar honest without a second set of listeners.
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
  el.statAiCandidates.textContent = parts.join(' · ');
  el.statAiRequests.textContent = String(num(review.requests));
  const tokens = Number(review.tokens);
  el.statAiTokens.textContent =
    review.tokens != null && Number.isFinite(tokens)
      ? `${tokens} ${plural(tokens, 'token', 'tokens')}`
      : '';
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
    renderStats(data);
    renderGroups(data.groups);
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

/**
 * One question to the model, and its answer put on the page. Both ways into a
 * review end here — the whole result list and the groups the user ticked —
 * because the request, the refusals and what the answer does to the cards are
 * the same in both cases. The page is only touched when an answer arrives; a
 * throw leaves the cards exactly as they were and the caller words it.
 *
 * @param {object} extra  fields on top of the ones both callers send; the
 *   guided path narrows the question with `groupIds` and `includeCandidates`
 * @returns {Promise<object>} the `aiReview` block of the answer
 */
async function askForVerdicts(extra) {
  const { status, payload } = await postForReview('/api/duplicates/ai-review', {
    kind: selectedKind(),
    threshold: currentThreshold(),
    includeDismissed: Boolean(
      el.includeDismissed && el.includeDismissed.checked
    ),
    withTitles: Boolean(el.aiTitles && el.aiTitles.checked),
    withExcerpts: Boolean(el.aiExcerpts && el.aiExcerpts.checked),
    ...extra,
  });
  if (status === 409) {
    throw new Error('AI review is switched off (DUPLICATES_AI_REVIEW)');
  }
  if (!payload) {
    throw new Error(`The server answered ${status} without a body.`);
  }
  if (!payload.success) {
    throw new Error(payload.error || 'The AI review failed.');
  }
  const data = payload.data || {};
  if (data.paperlessUrl) paperlessUrl = data.paperlessUrl;
  renderStats(data);
  renderGroups(data.groups);
  return data.aiReview || {};
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

async function runAiReview() {
  if (!el.aiReviewBtn || scanning || aiReviewing || !scanned) return;
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
    const review = await askForVerdicts({});
    if (el.aiNotice) el.aiNotice.innerHTML = htmlFailedRequests(review);
  } catch (error) {
    if (el.aiNotice) {
      el.aiNotice.innerHTML = htmlAlert(
        'danger',
        'The AI review failed',
        error.message
      );
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
  return `<p>${esc(sentence)}</p><p>${esc(deleted)}</p><ul class="dup-dialog__list">${htmlNames}</ul><p class="zr-sm dup-dialog__note">${esc(UNDO_NOTE)}</p>${htmlCopy}`;
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
    .querySelectorAll('.zr-table-wrap, .dup-group__warnings')
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
      copyMatchingRule,
    });
    const data = payload.data || {};
    if (payload.success && data.status !== 'partial') {
      result(htmlMergeSuccess(data), 'done');
      const moved = num(data.documentsMoved);
      outcome = { status: 'done', documentsMoved: moved };
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
    outcome = { status: 'error', documentsMoved: 0 };
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
  let merged = 0;
  let failed = 0;
  let documents = 0;
  for (let index = 0; index < entries.length; index += 1) {
    setSelectionProgress(`Merging ${index + 1} of ${entries.length}…`);
    const entry = entries[index];
    // Awaited on purpose: one bulk edit at a time is what Paperless-ngx wants.
    const outcome = await mergeGroup(entry.card, entry.state, {
      copyMatchingRule,
    });
    documents += outcome ? num(outcome.documentsMoved) : 0;
    if (outcome && outcome.status === 'done') merged += 1;
    else failed += 1;
  }

  const summary =
    `Merged ${merged} ${plural(merged, 'group', 'groups')}, ` +
    `${documents} ${plural(documents, 'document', 'documents')}` +
    (failed > 0 ? `, ${failed} failed` : '');
  toast(summary, { tone: failed > 0 ? 'danger' : 'ok' });
  merging = false;
  setSelectionBusy(false);
  setSelectionProgress(summary);
  // What the batch left behind: the merged groups are gone from the selection,
  // a group that failed is still in it and can be tried again.
  updateSelectionBar();
  // The one reload of the whole batch; nothing else on the page is refetched.
  loadLog(true);
  window.setTimeout(() => {
    setSelectionProgress('');
    updateSelectionBar();
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
    const review = await askForVerdicts({
      groupIds: ids,
      includeCandidates: false,
    });
    // The answer rebuilt the cards; their picks and their ticks go back on.
    restorePicks(picks);
    const wanted = new Set(ids);
    selectGroups((state) => wanted.has(String(state.group.id)));
    if (el.aiNotice) el.aiNotice.innerHTML = htmlFailedRequests(review);
    asked = true;
  } catch (error) {
    // Exactly where a full review reports: above the results, and no dialog.
    if (el.aiNotice) {
      el.aiNotice.innerHTML = htmlAlert(
        'danger',
        'The AI review failed',
        error.message
      );
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
  setProposalBusy(true);
  clearAiNotice();
  try {
    setProposalStatus('Scanning…');
    await runScan();
    // A failed scan has already said so where the results are; the proposal
    // has nothing to add and nothing to ask about.
    if (!scanned) return;
    const pairs = reviewPairCount();
    setProposalStatus(
      `Asking the AI about ${pairs} ${plural(pairs, 'pair', 'pairs')} and near-misses…`
    );
    setAiReviewing(true);
    let review;
    try {
      review = await askForVerdicts({ includeCandidates: true });
    } finally {
      setAiReviewing(false);
    }
    if (el.aiNotice) el.aiNotice.innerHTML = htmlFailedRequests(review);
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

/** Rows the dropdown shows before it starts counting the rest. */
const PICKER_ROWS = 12;
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

function htmlPickerRow(record, index, prefix) {
  const name = String(record.name == null ? '' : record.name);
  const htmlInbox = record.isInboxTag
    ? '<span class="zr-badge zr-badge--info">inbox</span>'
    : '';
  const htmlLock =
    record.userCanChange === false
      ? `<span class="dup-picker__lock" title="The API token may not change this object">${htmlIcons.lock}</span>`
      : '';
  return `<div class="dup-picker__row" role="option" aria-selected="false" id="${esc(prefix)}${num(index)}" data-index="${num(index)}">
    <span class="zr-truncate dup-picker__name" title="${esc(name)}">${esc(name)}</span>${htmlInbox}${htmlLock}
    <span class="zr-sm zr-faint zr-mono dup-picker__count">${num(record.documentCount)}</span>
  </div>`;
}

function htmlManualChips(sources) {
  return sources
    .map((record) => {
      const name = String(record.name == null ? '' : record.name);
      return `<span class="zr-chip dup-manual__chip" data-id="${num(record.id)}"><span>${esc(name)}</span><button type="button" class="dup-manual__remove" data-id="${num(record.id)}" aria-label="Remove ${esc(name)}"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-x"/></svg></button></span>`;
    })
    .join('');
}

/**
 * A search field with a dropdown of matching records underneath it.
 *
 * The dropdown is rebuilt on every keystroke rather than filtered in place: a
 * few hundred names are nothing to rebuild, and it keeps the active row, the
 * truncation line and the aria wiring in one place.
 *
 * @param {object} config
 * @param {HTMLInputElement} config.input
 * @param {HTMLElement} config.list
 * @param {string} config.prefix   id prefix for the option rows
 * @param {() => object[]} config.choices  what may be offered right now
 * @param {(record: object) => void} config.onPick
 * @returns {{open: () => void, close: () => void}}
 */
function createPicker({ input, list, prefix, choices, onPick }) {
  /** The rows the dropdown currently shows, in the order it shows them. */
  let shown = [];
  let active = -1;

  function isOpen() {
    return !list.classList.contains('hidden');
  }

  function close() {
    list.classList.add('hidden');
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    shown = [];
    active = -1;
  }

  function markActive() {
    const rows = list.querySelectorAll('.dup-picker__row');
    rows.forEach((row, index) => {
      const on = index === active;
      row.classList.toggle('dup-picker__row--active', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const row = rows[active];
    if (row) {
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function open() {
    if (input.disabled) return;
    const query = input.value.trim().toLowerCase();
    const nameOf = (record) =>
      String(record.name == null ? '' : record.name).toLowerCase();
    let matches = choices();
    if (query !== '') {
      matches = matches.filter((record) => nameOf(record).includes(query));
      // A name that begins with what was typed is what was meant; everything
      // else that contains it follows in the order the server sent.
      matches = [
        ...matches.filter((record) => nameOf(record).startsWith(query)),
        ...matches.filter((record) => !nameOf(record).startsWith(query)),
      ];
    }

    shown = matches.slice(0, PICKER_ROWS);
    const rest = matches.length - shown.length;
    const htmlRows = shown
      .map((record, index) => htmlPickerRow(record, index, prefix))
      .join('');
    const htmlMore =
      rest > 0 ? `<div class="dup-picker__more">… ${num(rest)} more</div>` : '';
    list.innerHTML =
      shown.length === 0
        ? '<div class="dup-picker__more">No entry matches.</div>'
        : htmlRows + htmlMore;

    list.classList.toggle('dup-picker__list--empty', shown.length === 0);
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    active = shown.length > 0 ? 0 : -1;
    markActive();
  }

  function pick(record) {
    if (!record) return;
    close();
    onPick(record);
  }

  input.addEventListener('input', open);
  input.addEventListener('focus', open);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen()) {
        open();
        return;
      }
      if (shown.length === 0) return;
      active =
        event.key === 'ArrowDown'
          ? (active + 1) % shown.length
          : (active - 1 + shown.length) % shown.length;
      markActive();
      return;
    }
    if (event.key === 'Enter' && isOpen() && active >= 0) {
      event.preventDefault();
      pick(shown[active]);
      return;
    }
    if (event.key === 'Escape' && isOpen()) {
      // Without this the dialog-less page would hand Escape on to the browser,
      // which on a phone closes the keyboard instead of the list.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  // mousedown rather than click: the row must be picked before the field loses
  // the focus, or the outside-click handler below has already closed the list.
  list.addEventListener('mousedown', (event) => {
    const row = event.target.closest('.dup-picker__row');
    if (!row) return;
    event.preventDefault();
    pick(shown[num(row.dataset.index)]);
  });

  document.addEventListener('click', (event) => {
    if (
      isOpen() &&
      event.target.closest('.dup-picker') !== list.parentElement
    ) {
      close();
    }
  });

  return { open, close };
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
  if (el.aiReviewBtn) {
    el.aiReviewBtn.addEventListener('click', runAiReview);
    updateAiButton();
  }
  if (el.aiProposalBtn) {
    el.aiProposalBtn.addEventListener('click', runAiProposal);
  }
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

  initSensitivity();
  initResultsBar();
  initSelection();
  initManual();
  loadLog(true);
  loadDismissals();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
