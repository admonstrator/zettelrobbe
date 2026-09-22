/**
 * "Simplify tags": the service behind the page that turns compound tags into
 * a document type and topic tags.
 *
 * An archive that grew 1300 tags did not grow 1300 concepts. A tag such as
 * "Stromrechnung" presses two dimensions into one word: the kind of document
 * (an invoice) and what it is about (electricity). Paperless-ngx has a field
 * for the first, the document type, and tags for the second. This service
 * keeps a small target vocabulary of both, proposes for every tag what it
 * stands for, and applies the split the user confirmed: the documents get the
 * type and the topic tags, the compound tag is deleted, the merge log gets a
 * row with action 'split' that an undo can play back.
 *
 * Nothing here runs on its own. The vocabulary is the user's (the model may
 * propose it), every split is confirmed on the page, and the rule-based
 * decomposition works without any model at all.
 *
 * ## The contract (round 10)
 *
 * - The vocabulary lives in `tag_vocabulary` (models/document.js), read and
 *   written through getVocabulary() and saveVocabulary(). Entries of the
 *   dimension 'type' are document types, 'topic' entries are tags.
 * - Proposals live in `tag_split_proposals`, one per tag, and survive a
 *   reload. proposeSplits() replaces them; the user edits them one by one.
 * - applySplits() writes to Paperless-ngx and to the merge log (action
 *   'split', `details` per document), and duplicateMergeService.undo() hands
 *   a split row to undoSplit() here.
 * - The long-running pieces (the vocabulary proposal, the split proposals)
 *   run as a job of services/duplicateReviewJobService.js with their own
 *   runner and task name; they report progress through control.onProgress
 *   and honour control.signal like the judge does.
 *
 * ## The proposed order (round 12)
 *
 * The page does not ask for a decision per tag any more, it asks for one per
 * group. proposeOrder() is one job that proposes the vocabulary and then gives
 * *every* tag one of four actions — split, merge, keep, delete — by rule first
 * and by the model second. listGroups() derives the review from the stored
 * rows: one group per document type, per topic, per merge target, plus the two
 * buckets 'keep' and 'delete'. decideGroup() accepts, skips or reopens a whole
 * group, removeGroupMember() takes one tag out of one group, and
 * applyAccepted() writes what was accepted as a job: merges first (the merge
 * service does them, so the log row and its undo are the ones the Duplicates
 * page already knows), then splits, then deletes.
 *
 * ## What the model is asked, and what happens without one
 *
 * Two questions, both optional. The vocabulary proposal reads every tag name
 * in chunks and asks for the two dozen concepts the archive is really about;
 * the split proposals ask, for the tags the rule could not settle, which type
 * and which topics of the vocabulary a name stands for. Requests are shaped
 * like the judge's — temperature 0, thinking off, the judge's model override,
 * a cap that grows with the request, a cut-off answer salvaged rather than
 * thrown away. Without a provider the vocabulary proposal is refused and the
 * split proposals are what the rule alone makes of the tags.
 */

'use strict';

const documentModel = require('../models/document');
const paperlessService = require('./paperlessService');
const entityNameMatcher = require('./entityNameMatcher');
const { calculateTokens } = require('./serviceUtils');
const { estimateRun } = require('./aiRunEstimate');

/** The two dimensions a vocabulary entry can belong to. */
const DIMENSIONS = Object.freeze({ TYPE: 'type', TOPIC: 'topic' });
/** Where a proposal came from. */
const PROPOSAL_SOURCES = Object.freeze(['rule', 'model', 'user']);
/** What a proposal can be. */
const PROPOSAL_STATUSES = Object.freeze([
  'open',
  'accepted',
  'applied',
  'skipped',
]);
/**
 * What the proposed order does with one tag: split it into a document type
 * and/or topic tags, merge it into another tag, keep it as it is, or delete
 * it (its documents lose it; the log row makes that undoable).
 */
const PROPOSAL_ACTIONS = Object.freeze(['split', 'merge', 'keep', 'delete']);
/** The kinds of group the order is shown in. */
const GROUP_KINDS = Object.freeze(['type', 'topic', 'merge', 'keep', 'delete']);
/**
 * The order the page shows the kinds in: what the archive gains first, what
 * it only tidies after that.
 */
const GROUP_KINDS_IN_ORDER = Object.freeze([
  'type',
  'topic',
  'merge',
  'delete',
  'keep',
]);
/** What a group decision may be. */
const GROUP_DECISIONS = Object.freeze(['accept', 'skip', 'reopen']);
/** The log action of a split, shared with duplicateMergeService and the page. */
const SPLIT_ACTION = 'split';
/** The log action a deleted tag is written under, the same one the page knows. */
const DELETE_ACTION = 'delete';
/** Proposals one apply call may take. */
const MAX_APPLY_TAGS = 200;
/** Prefix of every line this service writes to the app log. */
const LOG_PREFIX = '[SIMPLIFY]';
/** The most model requests one run keeps in flight, whatever it was told. */
const MAX_LANES = 8;
/**
 * The document count below which a tag is offered as skippable when the
 * caller names no floor of its own. A tag on two documents is not what an
 * archive is reorganised around, and a run that leaves those out asks the
 * model about a third fewer names on a real archive.
 */
const DEFAULT_LOW_DOCUMENT_FLOOR = 3;
/**
 * How long the estimate may answer from the tag list it last read. Two pages
 * ask for an estimate on every move of a lever, and a walk over 1,200 tags is
 * a dozen requests to Paperless-ngx; the list does not change while somebody
 * drags a slider.
 */
const ESTIMATE_TAGS_TTL_MS = 60 * 1000;

/**
 * The phases the two long-running tasks report, the same strings
 * duplicateReviewJobService.PHASES holds for them. Kept here so the service
 * does not have to require the job it runs inside.
 */
const PHASES = Object.freeze({
  VOCABULARY: 'vocabulary',
  SPLITTING: 'splitting',
  ORDERING: 'ordering',
  APPLYING: 'applying',
});

/** Fewest tag names one vocabulary request reads, whatever the setting says. */
const MIN_VOCABULARY_NAMES_PER_REQUEST = 50;
/** Completion tokens one decomposed tag is worth. */
const TOKENS_PER_TAG = 60;
/** Smallest completion cap any request is sent with. */
const MIN_COMPLETION_CAP = 160;
/** How often a cut-off answer may be asked again with a raised cap. */
const MAX_CAP_RAISES = 2;
/**
 * The smallest cap a cut-off answer is asked again with. A model that thinks
 * although it was asked not to spends the whole first cap on its thinking and
 * answers nothing; doubling 400 would not get past that, so the first raise
 * jumps to a size a thinking model needs.
 */
const RAISED_CAP_MIN = 2048;
/** The ceiling a raise may reach when RESPONSE_TOKENS is set lower. */
const CAP_CEILING_MIN = 4096;
/** How much of the measured thinking a cap reserves on top of the answer. */
const THINKING_CAP_FACTOR = 1.25;
/** What the provider services set on an answer that hit the token limit. */
const TRUNCATION_ERROR_CODE = 'ai_response_truncated';
/** How much of an unreadable answer reaches the app log. */
const RAW_ANSWER_LOG_LENGTH = 200;
/** Longest reason a proposal keeps. */
const MAX_REASON_LENGTH = 200;

/** An error the routes turn into a status code and a message. */
class SimplifyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SimplifyError';
    this.status = status;
  }
}

/** Splits a list into chunks of at most `size`. */
/**
 * Runs `worker` over `items` with at most `limit` in flight, in order of
 * start; the judge does the same for its requests. Results keep the items'
 * order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function runInLanes(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };
  const runners = [];
  const lanes = Math.max(1, Math.min(limit, items.length));
  for (let index = 0; index < lanes; index += 1) runners.push(runner());
  await Promise.all(runners);
  return results;
}

function chunkList(items, size) {
  const chunks = [];
  const step = Math.max(1, Number(size) || 1);
  for (let start = 0; start < items.length; start += step) {
    chunks.push(items.slice(start, start + step));
  }
  return chunks;
}

/**
 * The JSON array in a model's answer. Strips one code fence, then takes
 * everything between the first `[` and the last `]` — the same reading the
 * judge does, because models like to explain themselves around the thing they
 * were asked for.
 *
 * @param {string} text
 * @returns {object[]}
 * @throws when there is nothing to parse
 */
function parseJsonArray(text) {
  let raw = String(text ?? '').trim();
  if (raw === '') {
    throw new Error('the model answered nothing');
  }
  raw = raw
    .replace(/^```[a-zA-Z0-9]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) {
    throw new Error('the answer contained no JSON array');
  }
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed)) {
    throw new Error('the answer was not a JSON array');
  }
  return parsed;
}

/**
 * The JSON object in a model's answer, for the vocabulary proposal: the same
 * reading as above, with braces instead of brackets.
 *
 * @param {string} text
 * @returns {object}
 * @throws when there is nothing to parse
 */
function parseJsonObject(text) {
  let raw = String(text ?? '').trim();
  if (raw === '') {
    throw new Error('the model answered nothing');
  }
  raw = raw
    .replace(/^```[a-zA-Z0-9]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('the answer contained no JSON object');
  }
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the answer was not a JSON object');
  }
  return parsed;
}

/**
 * The complete `{...}` objects of a cut-off answer.
 *
 * parseJsonArray() needs the closing bracket and gives up without it; this
 * walks the text from the first `[` and keeps every object whose braces
 * close, so an answer that ran out of room after eleven of fifty tags keeps
 * those eleven. Strings are tracked because a reason may contain a brace.
 *
 * @param {string|null|undefined} text
 * @returns {object[]} objects carrying an id
 */
function salvageObjects(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  if (start === -1) return [];

  const objects = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (character === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth > 0) continue;
      try {
        const parsed = JSON.parse(raw.slice(objectStart, index + 1));
        if (parsed && parsed.id != null) objects.push(parsed);
      } catch {
        // A half-written object is exactly what this function expects to meet.
      }
      objectStart = -1;
    }
  }

  return objects;
}

/** A tag name as the matcher compares it: one spelling for many. */
function normalizedTagKey(name) {
  return entityNameMatcher.normalizeName(String(name ?? ''), 'tags').asciiKey;
}

/**
 * A group key as the page and the routes spell it: 'keep', 'delete' or
 * '<kind>:<name>'. The name may itself contain a colon, so only the first one
 * separates; it is compared exactly, spelling for spelling.
 *
 * @param {string} key
 * @returns {{kind: string, name: string|null, key: string}|null}
 */
function parseGroupKey(key) {
  const raw = String(key ?? '').trim();
  if (raw === '') return null;
  if (raw === 'keep' || raw === 'delete') {
    return { kind: raw, name: null, key: raw };
  }
  const colon = raw.indexOf(':');
  if (colon <= 0) return null;
  const kind = raw.slice(0, colon);
  const name = raw.slice(colon + 1);
  if (!['type', 'topic', 'merge'].includes(kind) || name.trim() === '') {
    return null;
  }
  return { kind, name, key: `${kind}:${name}` };
}

/** A model's reason, trimmed to what a table cell can show. */
function toReason(value) {
  const reason = String(value ?? '').trim();
  if (reason === '') return null;
  return reason.length > MAX_REASON_LENGTH
    ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`
    : reason;
}

/**
 * Everything an undo needs from a tag, in Paperless-ngx spelling, the way
 * duplicateMergeService stores it for a merged source — a deleted object is a
 * deleted object, whoever deleted it.
 */
function snapshotOfTag(raw) {
  return {
    name: raw?.name ?? '',
    match: raw?.match ?? '',
    matching_algorithm: Number(raw?.matching_algorithm) || 0,
    is_insensitive: Boolean(raw?.is_insensitive),
    owner: raw?.owner ?? null,
    color: raw?.color ?? null,
    text_color: raw?.text_color ?? null,
    is_inbox_tag: Boolean(raw?.is_inbox_tag),
  };
}

/** The payload that re-creates a tag from its snapshot. */
function createPayloadFromSnapshot(snapshot) {
  const payload = {
    name: snapshot?.name ?? '',
    match: snapshot?.match ?? '',
    matching_algorithm: Number(snapshot?.matching_algorithm) || 0,
    is_insensitive: Boolean(snapshot?.is_insensitive),
    is_inbox_tag: Boolean(snapshot?.is_inbox_tag),
  };
  if (snapshot?.color) payload.color = snapshot.color;
  if (snapshot?.text_color) payload.text_color = snapshot.text_color;
  if (snapshot?.owner != null) payload.owner = snapshot.owner;
  return payload;
}

class TagSimplifyService {
  /**
   * The vocabulary by dimension, in the user's order.
   *
   * @returns {Promise<{types: object[], topics: object[]}>} TagVocabulary
   */
  async getVocabulary() {
    const rows = await documentModel.getTagVocabulary();
    return {
      types: rows.filter((row) => row.dimension === DIMENSIONS.TYPE),
      topics: rows.filter((row) => row.dimension === DIMENSIONS.TOPIC),
    };
  }

  /**
   * Saves the vocabulary as the user edited it: names only, order kept,
   * blanks and repeats dropped. Paperless-ngx ids already known for a name
   * survive the save.
   *
   * @param {{types?: string[], topics?: string[], source?: 'model'|'user'}} body
   * @returns {Promise<{types: object[], topics: object[]}>} what was stored
   */
  async saveVocabulary(body = {}) {
    const names = (list) =>
      (Array.isArray(list) ? list : [])
        .map((name) => String(name ?? '').trim())
        .filter((name) => name !== '');
    const types = names(body.types);
    const topics = names(body.topics);
    for (const name of [...types, ...topics]) {
      if (name.length > 128) {
        throw new SimplifyError(
          `A vocabulary name is longer than 128 characters: "${name.slice(0, 40)}…"`,
          400
        );
      }
    }
    const source = body.source === 'model' ? 'model' : 'user';
    await documentModel.replaceTagVocabulary([
      ...types.map((name) => ({ dimension: DIMENSIONS.TYPE, name, source })),
      ...topics.map((name) => ({ dimension: DIMENSIONS.TOPIC, name, source })),
    ]);
    console.log(
      `${LOG_PREFIX} vocabulary saved: ${types.length} type(s), ${topics.length} topic(s).`
    );
    return this.getVocabulary();
  }

  /* --- The model, the job and the app log -------------------------------- */

  /** One line in the app log, like the merge service writes them. */
  _log(message) {
    console.log(`${LOG_PREFIX} ${message}`);
  }

  /**
   * The configuration, re-required at call time the way the judge does it, so
   * a value changed on the settings page counts on the next run instead of on
   * the next restart.
   */
  _config() {
    return require('../config/config');
  }

  /** The merge service, required late: it hands split rows back to us. */
  _mergeService() {
    return require('./duplicateMergeService');
  }

  /**
   * The provider service, or a refusal. A missing key is a configuration
   * problem, not a failed request: it would fail every request the same way.
   *
   * @returns {object}
   */
  _provider() {
    const AIServiceFactory = require('./aiServiceFactory');
    const service = AIServiceFactory.getService();
    if (!service || typeof service.generateText !== 'function') {
      throw new SimplifyError('The AI provider is not configured', 409);
    }
    if (typeof service.initialize === 'function') {
      service.initialize();
    }
    if (!service.client) {
      throw new SimplifyError('The AI provider is not configured', 409);
    }
    return service;
  }

  /** True when a provider is there to ask; never throws. */
  hasProvider() {
    try {
      this._provider();
      return true;
    } catch {
      return false;
    }
  }

  /** The model the judge runs on, so both jobs speak to the same endpoint. */
  _judgeModel() {
    try {
      return require('./entityMatchAiService').judgeModel() || '';
    } catch {
      return '';
    }
  }

  /** The model name the token estimate is made against, or undefined. */
  _modelName() {
    try {
      return require('./entityMatchAiService').modelName() || undefined;
    } catch {
      return undefined;
    }
  }

  /** True once the job was stopped, whichever way. */
  _stopped(control) {
    if (control?.signal?.aborted) return true;
    if (typeof control?.stopReason === 'function') {
      return Boolean(control.stopReason());
    }
    return false;
  }

  /** Passes a progress patch on to the job, when there is one. */
  _report(control, patch) {
    if (typeof control?.onProgress === 'function') {
      control.onProgress(patch);
    }
  }

  /**
   * Stops the job once the tokens it was allowed are spent. The judge's own
   * brake, on the same control object.
   */
  _checkTokenBudget(control, usage) {
    const budget = Number(control?.tokenBudget);
    if (!Number.isFinite(budget) || budget <= 0) return;
    if (usage.tokens < budget) return;
    if (typeof control.stop !== 'function') return;
    let reason = 'token-budget';
    try {
      reason =
        require('./duplicateReviewJobService').STOP_REASONS?.TOKEN_BUDGET ||
        reason;
    } catch {
      // The job service is optional here; the literal is what it stores.
    }
    this._log(
      `token budget ${budget} reached after ${usage.requests} request(s); stopping.`
    );
    control.stop(reason);
  }

  /**
   * How many model requests this service keeps in flight: the judge's
   * setting (DUPLICATES_AI_CONCURRENCY, automatic per provider). A model that
   * thinks for a minute per request answers a vocabulary of 27 chunks in a
   * third of the time in three lanes.
   *
   * @returns {number}
   */
  _lanes(override = null) {
    try {
      const judge = require('./entityMatchAiService');
      const lanes = Number(judge.concurrency(override));
      return Number.isFinite(lanes) && lanes > 0
        ? Math.min(MAX_LANES, Math.floor(lanes))
        : 1;
    } catch {
      const wanted = Number(override);
      return Number.isFinite(wanted) && wanted >= 1
        ? Math.max(1, Math.min(Math.floor(wanted), MAX_LANES))
        : 1;
    }
  }

  /** Whether the model this service asks writes reasoning before it answers. */
  _thinkingOn() {
    try {
      return Boolean(require('./entityMatchAiService').thinkingEnabled());
    } catch {
      return false;
    }
  }

  /**
   * Tells the job what this run is, in the terms `ai_run_stats` keeps it.
   * Nothing happens without a job, which is every caller but the route.
   *
   * @param {object} control
   * @param {{items?:number, itemsByRule?:number, model?:string|null, thinking?:boolean}} patch
   */
  _noteRun(control, patch) {
    if (typeof control?.noteRun !== 'function') return;
    try {
      control.noteRun(patch);
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} what this run costs could not be noted: ${error?.message || error}`
      );
    }
  }

  /**
   * Hands one finished request to the job that keeps the run meter: what it
   * asked about, what came back, what it cost and how it ended.
   *
   * @param {object} control
   * @param {object} record  an AiReviewRequestRecord plus `promptTokens`
   */
  _recordRequest(control, record) {
    if (typeof control?.recordRequest !== 'function') return;
    try {
      control.recordRequest(record);
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} a request record was refused: ${error?.message || error}`
      );
    }
  }

  /**
   * What the provider says one request cost. A field it never reported stays
   * null: what is written here reaches `ai_run_stats` and is read back later
   * as a measurement, and an estimate in that place would be believed.
   *
   * @param {object} service
   * @returns {{prompt:number|null, completion:number|null, thinking:number|null}}
   */
  _spendOf(service) {
    const usage = service?.lastGenerateTextUsage;
    // `Number(null)` is 0, so null has to be turned away before the guard:
    // a provider that reported nothing did not report a zero.
    const reported = (value) => {
      if (value === null || value === undefined) return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
    };
    return {
      prompt: reported(usage?.promptTokens),
      completion: reported(usage?.completionTokens),
      thinking: reported(usage?.reasoningTokens),
    };
  }

  /**
   * The floor of every cap: the operator's Response Tokens. Document analysis
   * sends no cap at all and so never noticed a model that reasons before it
   * answers; a cap below what the operator allows for an answer starves that
   * model for no gain, since a cap is a ceiling, not a cost.
   *
   * @returns {number}
   */
  _capFloor() {
    const config = require('../config/config');
    return Math.max(0, Number(config.responseTokens) || 0);
  }

  /**
   * The ceiling any raised cap stops at: the operator's Response Tokens, but
   * never below what a thinking model needs for one answer.
   *
   * @returns {number}
   */
  _capCeiling() {
    const config = require('../config/config');
    return Math.max(CAP_CEILING_MIN, Number(config.responseTokens) || 0);
  }

  /**
   * Tokens a cap reserves for the model's thinking, on top of the answer: the
   * larger of what the judge measured for this model (its calibration,
   * loaded from the table when a review has not run yet) and what this
   * process has already seen in an answer. Zero for a model that does not
   * think.
   *
   * @returns {Promise<number>}
   */
  async _thinkingAllowance() {
    let measured;
    try {
      const judge = require('./entityMatchAiService');
      const model =
        typeof judge.modelName === 'function' ? judge.modelName() || '' : '';
      if (
        judge.calibration &&
        !judge.calibration.has(model) &&
        typeof judge._loadCalibration === 'function'
      ) {
        await judge._loadCalibration();
      }
      const calibration = judge.calibration
        ? judge.calibration.get(model)
        : null;
      measured = Number(calibration?.thinkingPerRequest) || 0;
    } catch {
      measured = 0;
    }
    const seen = Number(this._observedThinking) || 0;
    return Math.ceil(Math.max(measured, seen) * THINKING_CAP_FACTOR);
  }

  /**
   * Remembers the thinking the last answer cost, so every later cap of this
   * process reserves it without asking twice.
   *
   * @param {object} service
   */
  _noteThinking(service) {
    const thought = Number(service?.lastGenerateTextUsage?.reasoningTokens);
    if (!Number.isFinite(thought) || thought <= 0) return;
    if (thought > (Number(this._observedThinking) || 0)) {
      this._observedThinking = thought;
    }
  }

  /**
   * What the last request came back with, for the log line of an answer that
   * could not be read: the reasoning it cost, the characters of answer, and
   * how the server said it ended. Empty when the service reported nothing.
   *
   * @param {object} service
   * @returns {string} '' or ' (reasoning: …, answer: …, finish_reason: …)'
   */
  _answerDiagnosis(service) {
    const usage = service?.lastGenerateTextUsage;
    if (!usage || typeof usage !== 'object') return '';
    const parts = [];
    const thought = Number(usage.reasoningTokens);
    if (Number.isFinite(thought) && thought > 0) {
      parts.push(`reasoning: ${thought} token(s)`);
    }
    const answer = Number(usage.answerChars);
    if (Number.isFinite(answer)) {
      parts.push(`answer: ${answer} character(s)`);
    }
    if (typeof usage.finishReason === 'string' && usage.finishReason !== '') {
      parts.push(`finish_reason: ${usage.finishReason}`);
    }
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
  }

  /**
   * The cap a cut-off answer is asked again with: at least four times the
   * last one and never below RAISED_CAP_MIN, bounded by the ceiling; null
   * when the ceiling leaves no room.
   *
   * @param {number} cap
   * @param {number} base  what the answer alone needs
   * @returns {Promise<number|null>}
   */
  async _raisedCap(cap, base) {
    const allowance = await this._thinkingAllowance();
    const raised = Math.min(
      this._capCeiling(),
      Math.max(cap * 4, RAISED_CAP_MIN, base + allowance)
    );
    return raised > cap ? raised : null;
  }

  /**
   * The options one request is sent with: the judge's shape, so both jobs
   * behave the same way on the same endpoint.
   *
   * @param {string} systemPrompt
   * @param {number} cap
   * @param {object} control
   * @param {(update: object) => void} [onProgress]
   * @returns {object}
   */
  _requestOptions(systemPrompt, cap, control, onProgress = null) {
    const options = {
      systemPrompt,
      temperature: 0,
      maxTokens: cap,
      // A decomposition is a lookup, not a deliberation.
      reasoning: false,
    };
    const model = this._judgeModel();
    if (model !== '') options.model = model;
    if (control?.signal) options.signal = control.signal;
    if (control?.onProgress && onProgress) options.onProgress = onProgress;
    return options;
  }

  /** The text a provider produced before it hit the limit, or null. */
  _partialAnswerOf(error) {
    const candidates = [
      error?.partialText,
      error?.partialContent,
      error?.partialAnswer,
    ];
    const found = candidates.find(
      (value) => typeof value === 'string' && value.trim() !== ''
    );
    return found || null;
  }

  /**
   * What one request cost: what the provider reported, or an estimate of
   * prompt plus answer when it reported nothing.
   */
  async _countTokens(service, usage, promptText, answer) {
    const reported = Number(service?.lastGenerateTextUsage?.totalTokens);
    if (Number.isFinite(reported)) {
      usage.tokens += reported;
      return;
    }
    const model = this._modelName();
    const prompt = await calculateTokens(String(promptText ?? ''), model);
    const completion = await calculateTokens(String(answer ?? ''), model);
    usage.tokens +=
      (Number.isFinite(prompt) ? prompt : 0) +
      (Number.isFinite(completion) ? completion : 0);
  }

  /** Wraps a Paperless-ngx failure so the route answers 502, not 500. */
  _asPaperlessError(error, what) {
    if (error instanceof SimplifyError) return error;
    return new SimplifyError(
      `Paperless-ngx could not be reached while ${what}: ${
        error?.message || 'unknown error'
      }`,
      502
    );
  }

  /* --- The vocabulary proposal ------------------------------------------ */

  /**
   * What the model is told about the vocabulary: the two dimensions, the
   * document types that already exist, and how many entries the archive
   * should end up with. English and in the judge's shape.
   *
   * @param {string[]} existingTypes  the document types of the instance
   * @param {number} size             entries the answer should aim at
   * @returns {string}
   */
  buildVocabularySystemPrompt(existingTypes, size) {
    const typeLimit = Math.max(1, Math.floor(size / 3));
    const lines = [
      'You are given the tag names of one personal document archive (Paperless-ngx).',
      'Tags in this archive press two dimensions into one name: the kind of document it is ("Rechnung", "Brief", "Vertrag", "Bescheid") and what it is about ("Strom", "Auto", "Lebensmittel").',
      'Propose the small vocabulary the archive should end up with: the kinds as "types", the subjects as "topics".',
      '',
      'A type is a kind of document. Paperless-ngx has a field for it, the document type, and one document has exactly one.',
      'A topic is what a document is about. A topic is never a kind of document, and a kind of document is never a topic.',
      'Keep both lists short: a name that covers many tags is worth more than a name that covers one.',
      'Propose no name that is only another spelling of a name you already proposed.',
      'Write the names in the language and the spelling the tags use.',
      `At most ${size} entries in total, at most ${typeLimit} of them types.`,
    ];
    if (existingTypes.length > 0) {
      lines.push(
        `These document types already exist; reuse them by name where they fit: ${existingTypes.join(', ')}.`
      );
    }
    lines.push(
      '',
      'Answer with a JSON object and nothing else — no prose, no explanation, no code fence:',
      '{"types": ["Rechnung", "Brief"], "topics": ["Strom", "Auto"]}'
    );
    return lines.join('\n');
  }

  /** The names of one request: one per line, nothing else. */
  buildNameListPrompt(names) {
    return [`Tag names: ${names.length}`, ...names].join('\n');
  }

  /**
   * Asks the model for a vocabulary from the names of every tag: about
   * `config.simplifyVocabularySize` entries, types and topics, in chunks of
   * `config.duplicatesAiSweepNames` names per request. Runs as a job; the
   * result is a TagVocabulary the page shows for editing, not yet saved.
   *
   * @param {object} options
   * @param {object} control  { signal, onProgress, tokenBudget, stop, stopReason }
   * @returns {Promise<{types: string[], topics: string[], requests: number, tokens: number}>}
   */
  async proposeVocabulary(options = {}, control = {}) {
    const config = this._config();
    const service = this._provider();
    const size = Math.max(4, Number(config.simplifyVocabularySize) || 25);
    const perRequest = Math.max(
      MIN_VOCABULARY_NAMES_PER_REQUEST,
      Number(config.duplicatesAiSweepNames) || MIN_VOCABULARY_NAMES_PER_REQUEST
    );

    let tags;
    try {
      tags = await paperlessService.listEntities('tags');
    } catch (error) {
      throw this._asPaperlessError(error, 'reading the tags');
    }
    const names = [];
    const seen = new Set();
    for (const tag of tags) {
      const name = String(tag?.name ?? '').trim();
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    if (names.length === 0) {
      throw new SimplifyError(
        'There are no tags to read a vocabulary from',
        409
      );
    }

    let existingTypes;
    try {
      existingTypes = (await paperlessService.listDocumentTypesNames())
        .map((entry) => String(entry?.name ?? '').trim())
        .filter((name) => name !== '');
    } catch {
      // Without them the model simply proposes its own names.
      existingTypes = [];
    }

    const chunks = chunkList(names, perRequest);
    const usage = { requests: 0, tokens: 0, failedRequests: 0 };
    const votes = {
      types: new Map(),
      topics: new Map(),
    };
    const systemPrompt = this.buildVocabularySystemPrompt(existingTypes, size);

    this._report(control, {
      phase: PHASES.VOCABULARY,
      kind: 'tags',
      requestsDone: 0,
      requestsPlanned: chunks.length,
      tokens: 0,
      message: `Reading ${names.length} tag names for a vocabulary in ${chunks.length} request(s)…`,
    });

    // One run's own answer to how many requests it keeps in flight; absent
    // means the setting decides, as it always did.
    this._noteRun(control, {
      items: names.length,
      model: this._modelName() ?? null,
      thinking: this._thinkingOn(),
    });
    const lanes = Math.min(this._lanes(options?.concurrency), chunks.length);
    const laneNote = lanes > 1 ? ` in ${lanes} lanes` : '';
    let started = 0;
    let done = 0;
    await runInLanes(chunks, lanes, async (chunk) => {
      if (this._stopped(control)) return;
      started += 1;
      this._report(control, {
        phase: PHASES.VOCABULARY,
        message: `Reading ${names.length} tag names for a vocabulary, request ${started} of ${chunks.length}${laneNote}…`,
        requestsDone: done,
        requestsPlanned: chunks.length,
        tokens: usage.tokens,
      });
      const proposed = await this._vocabularyChunk(
        service,
        systemPrompt,
        chunk,
        size,
        usage,
        control
      );
      for (const dimension of ['types', 'topics']) {
        for (const name of proposed[dimension]) {
          this._vote(votes[dimension], name);
        }
      }
      done += 1;
      this._report(control, {
        phase: PHASES.VOCABULARY,
        requestsDone: done,
        requestsPlanned: chunks.length,
        tokens: usage.tokens,
        failedRequests: usage.failedRequests,
      });
      this._checkTokenBudget(control, usage);
    });

    const merged = this._mergeVocabularyVotes(votes, size);
    this._log(
      `vocabulary proposed from ${names.length} tag names in ${usage.requests} request(s): ` +
        `${merged.types.length} type(s), ${merged.topics.length} topic(s).`
    );
    return {
      types: merged.types,
      topics: merged.topics,
      requests: usage.requests,
      tokens: usage.tokens,
      names: names.length,
      stopped: this._stopped(control),
    };
  }

  /**
   * One vocabulary request: a chunk of names in, the names the model proposes
   * out. A request that fails costs its chunk's names, nothing else.
   *
   * @returns {Promise<{types: string[], topics: string[]}>}
   */
  async _vocabularyChunk(
    service,
    systemPrompt,
    names,
    size,
    usage,
    control,
    { cap: wanted = null, raises = 0 } = {}
  ) {
    const userPrompt = this.buildNameListPrompt(names);
    const base = Math.max(MIN_COMPLETION_CAP, size * 16);
    const cap =
      wanted == null
        ? Math.max(base + (await this._thinkingAllowance()), this._capFloor())
        : wanted;
    usage.requests += 1;
    const startedAt = Date.now();
    const head = () => `vocabulary: ${names.length} name(s), cap ${cap}`;
    /** One row of the run meter for this request; see _splitChunk. */
    const meter = (outcome, answers) => {
      const spend = this._spendOf(service);
      this._recordRequest(control, {
        items: names.length,
        answers,
        // Omitted rather than null where nothing was reported; see
        // recordRequest, which reads an explicit null as a measured 0.
        tokens: spend.completion ?? undefined,
        thinkingTokens: spend.thinking ?? undefined,
        promptTokens: spend.prompt ?? undefined,
        ms: Date.now() - startedAt,
        outcome,
      });
    };

    let answer;
    let truncated = false;
    try {
      // Streamed like the judge's requests: a gateway drops a silent
      // connection while a thinking model deliberates for minutes, and the
      // stream is where the thinking gets counted.
      answer = await service.generateText(
        userPrompt,
        this._requestOptions(systemPrompt, cap, control, () => {})
      );
    } catch (error) {
      if (this._stopped(control)) return { types: [], topics: [] };
      if (error?.code === TRUNCATION_ERROR_CODE) {
        truncated = true;
        answer = this._partialAnswerOf(error);
      } else {
        usage.failedRequests += 1;
        console.warn(
          `${LOG_PREFIX} ${head()} — failed: ${
            error?.message || 'the AI provider could not be reached'
          }.`
        );
        meter('failed', 0);
        return { types: [], topics: [] };
      }
    }

    await this._countTokens(
      service,
      usage,
      `${systemPrompt}\n${userPrompt}`,
      answer
    );
    this._noteThinking(service);

    let parsed;
    try {
      parsed = parseJsonObject(answer);
    } catch (error) {
      // A cut-off answer with nothing usable in it is what a thinking model
      // leaves behind when the cap covered its thinking and not its answer:
      // ask once more with room for both.
      const raised =
        truncated && raises < MAX_CAP_RAISES
          ? await this._raisedCap(cap, base)
          : null;
      if (raised != null) {
        this._log(
          `${head()} — the answer hit the token limit with nothing usable in it ` +
            `(a thinking model spends the cap before it answers), raising the cap to ${raised} and asking again.`
        );
        meter('empty', 0);
        return this._vocabularyChunk(
          service,
          systemPrompt,
          names,
          size,
          usage,
          control,
          { cap: raised, raises: raises + 1 }
        );
      }
      usage.failedRequests += 1;
      console.warn(
        `${LOG_PREFIX} ${head()} — failed: ${
          truncated
            ? 'the answer was cut off with nothing usable in it'
            : error.message
        }${this._answerDiagnosis(service)}. Raw answer: ` +
          `${String(answer ?? '').slice(0, RAW_ANSWER_LOG_LENGTH) || '(none)'}`
      );
      meter(truncated ? 'empty' : 'failed', 0);
      return { types: [], topics: [] };
    }

    const asNames = (value) =>
      (Array.isArray(value) ? value : [])
        .map((name) => String(name ?? '').trim())
        .filter((name) => name !== '' && name.length <= 128);
    const proposed = {
      types: asNames(parsed.types),
      topics: asNames(parsed.topics),
    };
    // A vocabulary request reads a chunk of names and answers with the words
    // it found in them: it read all of them, so it answered for all of them.
    // A request that found nothing at all read nothing usable.
    meter(
      proposed.types.length + proposed.topics.length === 0
        ? 'empty'
        : 'answered',
      names.length
    );
    return proposed;
  }

  /** One vote for a name, counted under its normalised spelling. */
  _vote(counter, name) {
    const key = entityNameMatcher.normalizeName(name, 'tags').asciiKey;
    if (key === '') return;
    const current = counter.get(key);
    if (current) {
      current.votes += 1;
      return;
    }
    counter.set(key, { name, votes: 1, first: counter.size });
  }

  /**
   * The vocabulary the chunks agree on: a name proposed in more chunks ranks
   * higher, types take at most a third of the entries, and a name that is
   * both a type and a topic stays a type.
   *
   * @param {{types: Map, topics: Map}} votes
   * @param {number} size
   * @returns {{types: string[], topics: string[]}}
   */
  _mergeVocabularyVotes(votes, size) {
    const rank = (counter) =>
      [...counter.values()].sort(
        (a, b) => b.votes - a.votes || a.first - b.first
      );
    const typeLimit = Math.max(1, Math.floor(size / 3));
    const types = rank(votes.types).slice(0, typeLimit);
    const taken = new Set(
      types.map(
        (entry) => entityNameMatcher.normalizeName(entry.name, 'tags').asciiKey
      )
    );
    const topics = rank(votes.topics)
      .filter(
        (entry) =>
          !taken.has(
            entityNameMatcher.normalizeName(entry.name, 'tags').asciiKey
          )
      )
      .slice(0, Math.max(0, size - types.length));
    return {
      types: types.map((entry) => entry.name),
      topics: topics.map((entry) => entry.name),
    };
  }

  /* --- The split proposals ---------------------------------------------- */

  /**
   * What the model is told about the decomposition: the vocabulary it may use
   * and nothing else.
   *
   * @param {{types: object[], topics: object[]}} vocabulary
   * @returns {string}
   */
  buildSplitSystemPrompt(vocabulary) {
    const typeNames = vocabulary.types.map((entry) => entry.name);
    const topicNames = vocabulary.topics.map((entry) => entry.name);
    return [
      'You are given tag names of one personal document archive (Paperless-ngx).',
      'A tag in this archive often presses two dimensions into one name: the kind of document it is, and what it is about. The kind belongs in the document type, the subject belongs in a tag.',
      'For every tag name, say which document type it encodes and which topics it is about.',
      '',
      `The document types you may use: ${typeNames.join(', ') || '(none)'}.`,
      `The topics you may use: ${topicNames.join(', ') || '(none)'}.`,
      '',
      'Use those names and no others. Never invent a type or a topic, and never answer with a name that is not in the two lists above.',
      'Copy the names exactly as they are spelled in the lists.',
      '"type" is null when the name says nothing about the kind of document.',
      '"topics" is an empty list when the name is about nothing in the list.',
      'A name that is neither gets "type": null and an empty "topics".',
      '"confidence" is "high" when the name plainly says it and "low" when you had to guess.',
      '"reason" is at most six words.',
      '',
      'Answer with a JSON array and nothing else — no prose, no explanation, no code fence:',
      '[{"id": "12", "type": "Rechnung", "topics": ["Strom"], "confidence": "high", "reason": "<at most six words>"}]',
      'Answer every tag you were given exactly once, with the id copied as it was given.',
    ].join('\n');
  }

  /** The tags of one request: id and name, one JSON object per line. */
  buildSplitUserPrompt(tags) {
    return [
      `Tags: ${tags.length}`,
      '[',
      tags
        .map((tag) =>
          JSON.stringify({ id: String(tag.id), name: String(tag.name ?? '') })
        )
        .join(',\n'),
      ']',
    ].join('\n');
  }

  /**
   * Proposes, for every tag that is not itself in the vocabulary, the
   * document type and topic tags it stands for: first by rule
   * (entityNameMatcher.decomposeCompound against the vocabulary), then by
   * the model for the rest, `config.simplifyTagsPerRequest` names per
   * request. Replaces the stored proposals. Runs as a job.
   *
   * @param {object} options  { fresh?: boolean }
   * @param {object} control
   * @returns {Promise<{proposals: number, byRule: number, byModel: number, requests: number, tokens: number}>}
   */
  async proposeSplits(options = {}, control = {}) {
    void options;
    const config = this._config();
    const vocabulary = await this.getVocabulary();
    if (vocabulary.types.length === 0 && vocabulary.topics.length === 0) {
      throw new SimplifyError('Save a vocabulary first', 409);
    }

    let tags;
    try {
      tags = await paperlessService.listEntities('tags');
    } catch (error) {
      throw this._asPaperlessError(error, 'reading the tags');
    }

    const mergeService = this._mergeService();
    const configuredTagNames = mergeService.configuredTagNames();
    const vocabularyKeys = new Set(
      [...vocabulary.types, ...vocabulary.topics].map(
        (entry) => entityNameMatcher.normalizeName(entry.name, 'tags').asciiKey
      )
    );

    const candidates = [];
    let skipped = 0;
    for (const tag of tags) {
      const name = String(tag?.name ?? '').trim();
      if (name === '') {
        skipped += 1;
        continue;
      }
      const isVocabulary = vocabularyKeys.has(
        entityNameMatcher.normalizeName(name, 'tags').asciiKey
      );
      if (
        isVocabulary ||
        tag.isInboxTag ||
        tag.userCanChange === false ||
        mergeService.isConfiguredTagName(configuredTagNames, name)
      ) {
        skipped += 1;
        continue;
      }
      candidates.push(tag);
    }

    // Pass one: what the vocabulary accounts for without asking anybody.
    const proposals = new Map();
    const unsettled = [];
    for (const tag of candidates) {
      const decomposed = entityNameMatcher.decomposeCompound(
        tag.name,
        vocabulary
      );
      if (decomposed) {
        proposals.set(Number(tag.id), this._ruleProposal(tag, decomposed));
      }
      if (!decomposed || decomposed.score < 1) unsettled.push(tag);
    }
    const settledByRule =
      proposals.size -
      unsettled.filter((tag) => proposals.has(Number(tag.id))).length;

    const usage = { requests: 0, tokens: 0, failedRequests: 0 };
    const withModel = this.hasProvider();
    const perRequest = Math.max(1, Number(config.simplifyTagsPerRequest) || 50);
    const chunks = withModel ? chunkList(unsettled, perRequest) : [];

    this._noteRun(control, {
      items: unsettled.length,
      itemsByRule: settledByRule,
      model: this._modelName() ?? null,
      thinking: this._thinkingOn(),
    });

    this._report(control, {
      phase: PHASES.SPLITTING,
      kind: 'tags',
      requestsDone: 0,
      requestsPlanned: chunks.length,
      pairsTotal: candidates.length,
      pairsJudged: settledByRule,
      tokens: 0,
      message: this._splitMessage(
        settledByRule,
        candidates.length,
        unsettled.length,
        chunks.length,
        0
      ),
    });

    if (chunks.length > 0) {
      const service = this._provider();
      const systemPrompt = this.buildSplitSystemPrompt(vocabulary);
      const lanes = Math.min(this._lanes(), chunks.length);
      let started = 0;
      let done = 0;
      await runInLanes(chunks, lanes, async (chunk) => {
        if (this._stopped(control)) return;
        started += 1;
        this._report(control, {
          phase: PHASES.SPLITTING,
          message: this._splitMessage(
            settledByRule,
            candidates.length,
            unsettled.length,
            chunks.length,
            started
          ),
          requestsDone: done,
          requestsPlanned: chunks.length,
          tokens: usage.tokens,
        });
        const answered = await this._splitChunk(
          service,
          systemPrompt,
          chunk,
          vocabulary,
          usage,
          control
        );
        for (const row of answered) {
          proposals.set(row.tagId, row);
        }
        done += 1;
        this._report(control, {
          phase: PHASES.SPLITTING,
          requestsDone: done,
          requestsPlanned: chunks.length,
          pairsJudged: proposals.size,
          tokens: usage.tokens,
          failedRequests: usage.failedRequests,
        });
        this._checkTokenBudget(control, usage);
      });
    }

    const rows = [...proposals.values()].sort((a, b) =>
      String(a.tagName).localeCompare(String(b.tagName), undefined, {
        sensitivity: 'base',
      })
    );
    await documentModel.replaceTagSplitProposals(rows);

    const byRule = rows.filter((row) => row.source === 'rule').length;
    const byModel = rows.filter((row) => row.source === 'model').length;
    const without = candidates.length - rows.length;
    this._log(
      `proposals: ${candidates.length} tag(s), ${byRule} by rule, ${byModel} by the model ` +
        `in ${usage.requests} request(s), ${without} without a proposal.`
    );
    if (!withModel) {
      this._log(
        'no AI provider is configured; the proposals are what the vocabulary alone accounts for.'
      );
    }

    return {
      proposals: rows.length,
      byRule,
      byModel,
      requests: usage.requests,
      tokens: usage.tokens,
      skipped,
      candidates: candidates.length,
      withoutProposal: without,
      usedModel: withModel,
      stopped: this._stopped(control),
    };
  }

  /** The line the page reads while the split proposals are being made. */
  _splitMessage(settled, total, asked, requests, request) {
    const head = `${settled} of ${total} tags settled by rule`;
    if (requests === 0) {
      return asked === 0
        ? `${head}.`
        : `${head}; no model was asked about the other ${asked}.`;
    }
    const line = `${head}; asking the model about ${asked} in ${requests} requests`;
    return request > 0
      ? `${line}, request ${request} of ${requests}…`
      : `${line}…`;
  }

  /**
   * The proposal a decomposition makes on its own.
   *
   * @param {object} tag  EntityRecord
   * @param {{type: string|null, topics: string[], rest: string, score: number}} decomposed
   * @returns {object} a TagSplitProposal row
   */
  _ruleProposal(tag, decomposed) {
    const settled = decomposed.score >= 1;
    return {
      tagId: Number(tag.id),
      tagName: String(tag.name ?? ''),
      documentCount: Number(tag.documentCount) || 0,
      typeName: decomposed.type,
      topicNames: [...decomposed.topics],
      source: 'rule',
      confidence: settled ? 'high' : 'low',
      reason: this._ruleReason(decomposed),
      documentsWithType: 0,
      overwriteType: false,
      status: 'open',
    };
  }

  /** Why the rule proposes what it proposes, in one line. */
  _ruleReason(decomposed) {
    const topics = decomposed.topics.join(', ');
    if (decomposed.score >= 1) {
      return decomposed.topics.length === 0
        ? 'the type itself'
        : `compound of ${decomposed.type} and ${topics}`;
    }
    const found = decomposed.type
      ? `the type ${decomposed.type}${topics ? ` and ${topics}` : ''}`
      : `the topic(s) ${topics}`;
    return decomposed.rest
      ? `${found}; "${decomposed.rest}" is not in the vocabulary`
      : `${found}, but no document type`;
  }

  /**
   * One decomposition request: a chunk of tags in, the proposals the model
   * makes out.
   *
   * A cut-off answer is treated the way the judge treats one: what the model
   * managed to write is kept, and an answer that salvaged nothing is asked
   * once more with a raised cap.
   *
   * The proposed order asks a wider question of the same shape, so `prompt`
   * and `build` let it reuse this: `label` names the request in the log,
   * `prompt` writes the user prompt and `build` turns the answered items into
   * rows.
   *
   * @returns {Promise<object[]>} TagSplitProposal rows
   */
  async _splitChunk(
    service,
    systemPrompt,
    tags,
    vocabulary,
    usage,
    control,
    {
      cap: wanted = null,
      raises = 0,
      label = 'splits',
      prompt = null,
      build = null,
    } = {}
  ) {
    const userPrompt =
      typeof prompt === 'function'
        ? prompt(tags)
        : this.buildSplitUserPrompt(tags);
    const base = Math.max(MIN_COMPLETION_CAP, tags.length * TOKENS_PER_TAG);
    const cap =
      wanted == null
        ? Math.max(base + (await this._thinkingAllowance()), this._capFloor())
        : wanted;
    usage.requests += 1;
    const startedAt = Date.now();
    const head = () => `${label}: ${tags.length} tag(s), cap ${cap}`;
    /**
     * One row of the run meter for this request. The page shows these, so
     * `outcome` says what actually came back rather than what was hoped for.
     */
    const meter = (outcome, answers) => {
      const spend = this._spendOf(service);
      this._recordRequest(control, {
        items: tags.length,
        answers,
        // Omitted rather than null where nothing was reported; see
        // recordRequest, which reads an explicit null as a measured 0.
        tokens: spend.completion ?? undefined,
        thinkingTokens: spend.thinking ?? undefined,
        promptTokens: spend.prompt ?? undefined,
        ms: Date.now() - startedAt,
        outcome,
      });
    };

    let answer;
    let truncated = false;
    try {
      answer = await service.generateText(
        userPrompt,
        this._requestOptions(systemPrompt, cap, control, () => {})
      );
    } catch (error) {
      // A stop is not a finished request; it goes into no row.
      if (this._stopped(control)) return [];
      if (error?.code !== TRUNCATION_ERROR_CODE) {
        usage.failedRequests += 1;
        console.warn(
          `${LOG_PREFIX} ${head()} — failed: ${
            error?.message || 'the AI provider could not be reached'
          }.`
        );
        meter('failed', 0);
        return [];
      }
      truncated = true;
      answer = this._partialAnswerOf(error);
    }

    await this._countTokens(
      service,
      usage,
      `${systemPrompt}\n${userPrompt}`,
      answer
    );
    this._noteThinking(service);

    let items = null;
    let parseError = null;
    if (!truncated) {
      try {
        items = parseJsonArray(answer);
      } catch (error) {
        parseError = error;
      }
    }
    if (items === null) {
      const salvaged = salvageObjects(answer);
      const raised =
        salvaged.length === 0 && truncated && raises < MAX_CAP_RAISES
          ? await this._raisedCap(cap, base)
          : null;
      if (raised != null) {
        this._log(
          `${head()} — the answer hit the token limit and salvaged nothing ` +
            `(a thinking model spends the cap before it answers), raising the cap to ${raised} and reading the same tags again.`
        );
        // Nothing usable came back, reasoning aside — the row the run meter
        // exists for. The request after it records its own.
        meter('empty', 0);
        return this._splitChunk(
          service,
          systemPrompt,
          tags,
          vocabulary,
          usage,
          control,
          { cap: raised, raises: raises + 1, label, prompt, build }
        );
      }
      if (salvaged.length === 0) {
        usage.failedRequests += 1;
        console.warn(
          `${LOG_PREFIX} ${head()} — failed: ${
            truncated
              ? 'the answer was cut off with nothing usable in it'
              : parseError?.message || 'the answer could not be read'
          }${this._answerDiagnosis(service)}. Raw answer: ${
            String(answer ?? '').slice(0, RAW_ANSWER_LOG_LENGTH) || '(none)'
          }`
        );
        // A cut-off answer spent its budget and said nothing; an unreadable
        // one is a request that went wrong. The page tells them apart.
        meter(truncated ? 'empty' : 'failed', 0);
        return [];
      }
      this._log(
        `${head()} — the answer was cut off, salvaged ${salvaged.length} proposal(s).`
      );
      items = salvaged;
    }

    const rows =
      typeof build === 'function'
        ? build(items, tags, vocabulary)
        : this._modelProposals(items, tags, vocabulary);
    meter(
      rows.length === 0
        ? 'empty'
        : rows.length < tags.length
          ? 'partial'
          : 'answered',
      rows.length
    );
    return rows;
  }

  /**
   * The rows one answer is worth: ids the request did not carry are dropped,
   * and a type or topic outside the vocabulary is dropped with a note in the
   * reason rather than written to Paperless-ngx later.
   *
   * @returns {object[]}
   */
  _modelProposals(items, tags, vocabulary) {
    const byId = new Map(tags.map((tag) => [String(tag.id), tag]));
    const nameOf = (entries, value) => {
      const wanted = entityNameMatcher.normalizeName(
        String(value ?? ''),
        'tags'
      ).asciiKey;
      if (wanted === '') return null;
      const found = entries.find(
        (entry) =>
          entityNameMatcher.normalizeName(entry.name, 'tags').asciiKey ===
          wanted
      );
      return found ? found.name : null;
    };

    const rows = [];
    const answered = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      const id = String(item?.id ?? '').trim();
      const tag = byId.get(id);
      if (!tag || answered.has(id)) continue;
      answered.add(id);

      const dropped = [];
      let typeName = null;
      if (item?.type != null && String(item.type).trim() !== '') {
        typeName = nameOf(vocabulary.types, item.type);
        if (!typeName) dropped.push(String(item.type).trim());
      }
      const topicNames = [];
      for (const value of Array.isArray(item?.topics) ? item.topics : []) {
        const name = nameOf(vocabulary.topics, value);
        if (!name) {
          const raw = String(value ?? '').trim();
          if (raw !== '') dropped.push(raw);
          continue;
        }
        if (!topicNames.includes(name)) topicNames.push(name);
      }

      let reason = toReason(item?.reason) || 'proposed by the model';
      if (dropped.length > 0) {
        reason = `${reason} (not in the vocabulary: ${dropped.join(', ')})`;
      }
      rows.push({
        tagId: Number(tag.id),
        tagName: String(tag.name ?? ''),
        documentCount: Number(tag.documentCount) || 0,
        typeName,
        topicNames,
        source: 'model',
        confidence: item?.confidence === 'high' ? 'high' : 'low',
        reason: toReason(reason),
        documentsWithType: 0,
        overwriteType: false,
        status: 'open',
      });
    }
    return rows;
  }

  /** @returns {Promise<object[]>} TagSplitProposal[], by name */
  async listProposals({ status = null } = {}) {
    return documentModel.listTagSplitProposals({ status });
  }

  /**
   * What the user changed on one proposal. A changed target marks the
   * proposal as the user's; `status` may only move between open and skipped.
   *
   * @param {number} tagId
   * @param {{typeName?: string|null, topicNames?: string[], overwriteType?: boolean, status?: 'open'|'skipped'}} patch
   * @returns {Promise<object>} the proposal as stored
   */
  async updateProposal(tagId, patch = {}) {
    const id = Number(tagId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new SimplifyError('Unknown tag', 404);
    }
    const current = await documentModel.getTagSplitProposal(id);
    if (!current) {
      throw new SimplifyError(`There is no proposal for tag ${id}`, 404);
    }
    if (current.status === 'applied') {
      throw new SimplifyError('This proposal was already applied', 409);
    }
    const next = {};
    if ('typeName' in patch) {
      const name = patch.typeName == null ? '' : String(patch.typeName).trim();
      next.typeName = name === '' ? null : name;
      next.source = 'user';
    }
    if ('topicNames' in patch) {
      if (!Array.isArray(patch.topicNames)) {
        throw new SimplifyError('topicNames must be a list of names', 400);
      }
      const seen = new Set();
      next.topicNames = patch.topicNames
        .map((name) => String(name ?? '').trim())
        .filter((name) => name !== '' && !seen.has(name) && seen.add(name));
      next.source = 'user';
    }
    if ('overwriteType' in patch) {
      next.overwriteType = patch.overwriteType === true;
    }
    if ('status' in patch) {
      if (
        patch.status !== 'open' &&
        patch.status !== 'skipped' &&
        patch.status !== 'accepted'
      ) {
        throw new SimplifyError(
          'status must be open, accepted or skipped',
          400
        );
      }
      next.status = patch.status;
    }
    if ('action' in patch) {
      if (!PROPOSAL_ACTIONS.includes(patch.action)) {
        throw new SimplifyError(
          `action must be one of ${PROPOSAL_ACTIONS.join(', ')}`,
          400
        );
      }
      next.action = patch.action;
      next.source = 'user';
    }
    if ('mergeInto' in patch) {
      const name =
        patch.mergeInto == null ? '' : String(patch.mergeInto).trim();
      next.mergeInto = name === '' ? null : name;
      next.source = 'user';
    }
    await documentModel.updateTagSplitProposal(id, next);
    return documentModel.getTagSplitProposal(id);
  }

  /* --- What a split would cost ------------------------------------------ */

  /**
   * What applying one proposal would mean for its documents: how many there
   * are, how many already carry a document type, and how many carry one that
   * differs from the proposed one — those keep theirs unless the user switches
   * `overwriteType` on. The page asks for this before it asks for a
   * confirmation, and the number is stored on the proposal so a reload still
   * shows it.
   *
   * @param {number} tagId
   * @returns {Promise<{tagId:number, tagName:string, documents:number, withType:number, withDifferentType:number, typeId:number|null, typeSet:number, typeKept:number}>}
   */
  async proposalImpact(tagId) {
    const id = Number(tagId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new SimplifyError('Unknown tag', 404);
    }
    const proposal = await documentModel.getTagSplitProposal(id);
    if (!proposal) {
      throw new SimplifyError(`There is no proposal for tag ${id}`, 404);
    }

    let typeId = null;
    try {
      if (proposal.typeName) {
        const existing = await paperlessService.findDocumentTypeByExactName(
          proposal.typeName
        );
        // A type that does not exist yet cannot conflict with anything.
        typeId = existing ? Number(existing.id) : null;
      }
      const documentIds = await paperlessService.getDocumentIdsByEntity(
        'tags',
        id
      );
      const documents =
        documentIds.length > 0
          ? await paperlessService.getDocumentsByIds(
              documentIds,
              'id,document_type'
            )
          : [];
      let withType = 0;
      let withDifferentType = 0;
      for (const document of documents) {
        const current =
          document?.document_type == null
            ? null
            : Number(document.document_type);
        if (current == null) continue;
        withType += 1;
        if (typeId == null || current !== typeId) withDifferentType += 1;
      }
      await this._storeDocumentsWithType(id, withDifferentType);
      // What the apply would do with the type: every document with
      // overwriteType, otherwise only those without one; a differing type is
      // kept unless overwritten. Documents that already carry the proposed
      // type are neither.
      const overwrite = proposal.overwriteType === true;
      const typeSet = !proposal.typeName
        ? 0
        : overwrite
          ? documents.length
          : documents.length - withType;
      const typeKept = !proposal.typeName || overwrite ? 0 : withDifferentType;
      return {
        tagId: id,
        tagName: proposal.tagName,
        documents: documents.length,
        withType,
        withDifferentType,
        typeId,
        typeSet,
        typeKept,
      };
    } catch (error) {
      throw this._asPaperlessError(error, `reading the documents of tag ${id}`);
    }
  }

  /** Stores the conflict count on the proposal row. */
  async _storeDocumentsWithType(tagId, count) {
    await documentModel.updateTagSplitProposal(tagId, {
      documentsWithType: count,
    });
  }

  /* --- Applying a split -------------------------------------------------- */

  /**
   * Applies the proposals of the given tags, one after the other: the
   * vocabulary objects are created in Paperless-ngx where missing, the
   * documents of the tag get the topic tags and (where they carry none, or
   * always with overwriteType) the document type, the tag is deleted, one
   * merge-log row per tag records it with action 'split' and `details`.
   *
   * @param {{tagIds: number[], performedBy?: string|null}} request
   * @returns {Promise<{applied: object[], failed: object[]}>} TagSplitApplyResult
   */
  async applySplits(request = {}) {
    const numeric = (Array.isArray(request.tagIds) ? request.tagIds : []).map(
      Number
    );
    if (
      numeric.length === 0 ||
      !numeric.every((id) => Number.isInteger(id) && id > 0)
    ) {
      throw new SimplifyError(
        'tagIds must be at least one positive integer',
        400
      );
    }
    const tagIds = [...new Set(numeric)];
    if (tagIds.length > MAX_APPLY_TAGS) {
      throw new SimplifyError(
        `At most ${MAX_APPLY_TAGS} proposals can be applied at once`,
        400
      );
    }
    if (global.__paperlessAiScanControl?.running) {
      throw new SimplifyError(
        'A document scan is running. Wait until it has finished.',
        409
      );
    }

    const performedBy = request.performedBy ?? null;
    const mergeService = this._mergeService();
    const configuredTagNames = mergeService.configuredTagNames();
    const vocabulary = await this.getVocabulary();
    const startedAt = Date.now();
    this._log(`split started: ${tagIds.length} proposal(s) requested.`);

    const applied = [];
    const failed = [];
    for (const tagId of tagIds) {
      try {
        applied.push(
          await this._applyOne(tagId, {
            performedBy,
            configuredTagNames,
            vocabulary,
            mergeService,
          })
        );
      } catch (error) {
        failed.push({
          tagId,
          tagName: error?.tagName || '',
          error: error?.message || 'unknown error',
        });
        this._log(
          `split tag ${tagId}${
            error?.tagName ? ` "${error.tagName}"` : ''
          }: refused, ${error?.message || 'unknown error'}.`
        );
      }
    }

    if (applied.length > 0) {
      mergeService.afterWrite('split');
    }
    this._log(
      `split finished: ${applied.length} applied, ${failed.length} refused, ` +
        `in ${Date.now() - startedAt}ms.`
    );
    return { applied, failed };
  }

  /** A refusal that knows which tag it is about. */
  _refusal(message, tagName = '') {
    const error = new SimplifyError(message, 409);
    error.tagName = tagName;
    return error;
  }

  /**
   * One tag: read fresh, refuse what must not be split, write, log, delete.
   *
   * Two actions take this path. A split gives the documents a document type
   * and topic tags before the tag goes; a delete gives them nothing and is
   * the same walk with an empty target, which is why it may not be refused
   * for naming neither of the two. `context.statuses` says which proposals
   * this run is allowed to take: the per-tag apply takes open ones, the
   * apply job takes accepted ones.
   *
   * @returns {Promise<object>} one entry of TagSplitApplyResult.applied
   */
  async _applyOne(tagId, context) {
    const { performedBy, configuredTagNames, vocabulary, mergeService } =
      context;
    const statuses = Array.isArray(context.statuses)
      ? context.statuses
      : ['open'];
    const proposal = await documentModel.getTagSplitProposal(tagId);
    if (!proposal) {
      throw this._refusal(`There is no proposal for tag ${tagId}`);
    }
    if (!statuses.includes(proposal.status)) {
      throw this._refusal(
        proposal.status === 'applied'
          ? 'This proposal was already applied'
          : `This proposal is not ${statuses.join(' or ')}`,
        proposal.tagName
      );
    }
    const isDelete = proposal.action === 'delete';
    // A delete takes the tag off its documents and nothing else; the split's
    // two targets are empty on purpose here.
    const typeName = isDelete ? null : proposal.typeName;
    const topicNames = isDelete ? [] : proposal.topicNames;
    if (!isDelete && !typeName && topicNames.length === 0) {
      throw this._refusal(
        'The proposal names neither a document type nor a topic tag',
        proposal.tagName
      );
    }

    // A proposal is a picture of a moment ago; Paperless-ngx decides.
    let raw;
    try {
      raw = await paperlessService.getEntity('tags', tagId);
    } catch (error) {
      throw this._refusal(
        `it could not be read: ${error?.message || 'unknown error'}`,
        proposal.tagName
      );
    }
    if (!raw) {
      throw this._refusal(
        'It does not exist in Paperless-ngx any more',
        proposal.tagName
      );
    }
    const tagName = String(raw.name ?? '');
    if (raw.user_can_change === false) {
      throw this._refusal('The API token may not change it', tagName);
    }
    if (raw.is_inbox_tag) {
      throw this._refusal('It is an inbox tag', tagName);
    }
    if (mergeService.isConfiguredTagName(configuredTagNames, tagName)) {
      throw this._refusal('The settings refer to this tag', tagName);
    }

    let typeId = null;
    let createdTypeId = null;
    if (typeName) {
      try {
        const found = await this._typeIdFor(typeName, context);
        typeId = found.id;
        if (found.created) createdTypeId = typeId;
      } catch (error) {
        throw this._refusal(
          `the document type "${typeName}" could not be prepared: ${
            error?.message || 'unknown error'
          }`,
          tagName
        );
      }
      if (!Number.isInteger(typeId)) {
        throw this._refusal(
          `Paperless-ngx did not return an id for the document type "${typeName}"`,
          tagName
        );
      }
      await this._rememberVocabularyId(
        DIMENSIONS.TYPE,
        typeName,
        typeId,
        vocabulary
      );
    }

    const topicTagIds = [];
    const createdTagIds = [];
    for (const topicName of topicNames) {
      let id;
      try {
        id = await this._topicTagIdFor(topicName, context, createdTagIds);
      } catch (error) {
        throw this._refusal(
          `the topic tag "${topicName}" could not be prepared: ${
            error?.message || 'unknown error'
          }`,
          tagName
        );
      }
      // A proposal that names its own tag as a topic would delete what it
      // just asked for; the tag stays, the topic is already there.
      if (!Number.isInteger(id) || id === Number(tagId)) continue;
      if (!topicTagIds.includes(id)) topicTagIds.push(id);
    }

    let documentIds;
    let documents;
    try {
      documentIds = await paperlessService.getDocumentIdsByEntity(
        'tags',
        tagId
      );
      documents =
        documentIds.length > 0
          ? await paperlessService.getDocumentsByIds(
              documentIds,
              'id,tags,document_type'
            )
          : [];
    } catch (error) {
      throw this._refusal(
        `its documents could not be read: ${error?.message || 'unknown error'}`,
        tagName
      );
    }

    const details = {
      typeName: typeName ?? null,
      typeId,
      topicTagIds,
      createdTypeId,
      createdTagIds,
      documents: [],
    };
    const typeSetIds = [];
    let typeKept = 0;
    for (const document of documents) {
      const carried = new Set(
        (Array.isArray(document?.tags) ? document.tags : []).map(Number)
      );
      const previousTypeId =
        document?.document_type == null ? null : Number(document.document_type);
      const typeSet =
        typeId != null &&
        previousTypeId !== typeId &&
        (previousTypeId == null || proposal.overwriteType === true);
      if (typeId != null && previousTypeId != null && !typeSet) typeKept += 1;
      details.documents.push({
        id: Number(document.id),
        addedTagIds: topicTagIds.filter((id) => !carried.has(id)),
        previousTypeId,
        typeSet,
      });
      if (typeSet) typeSetIds.push(Number(document.id));
    }

    try {
      if (documentIds.length > 0) {
        await paperlessService.bulkEditDocuments(documentIds, 'modify_tags', {
          add_tags: topicTagIds,
          remove_tags: [Number(tagId)],
        });
      }
      if (typeSetIds.length > 0) {
        await paperlessService.setDocumentTypeOnDocuments(typeSetIds, typeId);
      }
    } catch (error) {
      throw this._refusal(
        `its documents were not changed: ${error?.message || 'unknown error'}`,
        tagName
      );
    }

    // Never delete a tag that still has documents: Paperless-ngx is the only
    // authority on that, so it is asked again rather than trusted.
    let deleted = false;
    let remaining = [];
    try {
      remaining = await paperlessService.getDocumentIdsByEntity('tags', tagId);
      if (remaining.length === 0) {
        deleted = await paperlessService.deleteEntity('tags', tagId);
      }
    } catch (error) {
      console.error(
        `[ERROR] deleting tag ${tagId} after its split:`,
        error?.message || error
      );
    }

    // A delete has no target at all; the column is NOT NULL, so the empty
    // string is what deleteUnused() writes for one too.
    const targetName = isDelete
      ? ''
      : [typeName, ...topicNames].filter(Boolean).join(' + ');
    const status = deleted ? 'done' : 'partial';
    const logId = await documentModel.addEntityMerge({
      kind: 'tags',
      // Neither a split nor a delete has a survivor; the row is about the
      // tag it took apart or removed.
      targetId: 0,
      targetName,
      targetBefore: null,
      sources: [
        {
          id: Number(tagId),
          name: tagName,
          snapshot: snapshotOfTag(raw),
          documentIds,
          documentsAlreadyOnTarget: [],
          documentsMoved: documents.length,
          deleted,
          error: deleted
            ? null
            : remaining.length > 0
              ? `${remaining.length} document(s) still carry this tag, it was not deleted`
              : 'The tag was already gone in Paperless-ngx',
        },
      ],
      documentsMoved: documents.length,
      copiedMatchingRule: false,
      status,
      performedBy,
      action: isDelete ? DELETE_ACTION : SPLIT_ACTION,
      details,
    });

    // History and Restore keep a valid tag id: the compound is gone, so its
    // rows point at the first topic tag instead. An approximation — a
    // document that had two topics keeps one of them locally — but a row
    // pointing at a deleted id would show nothing at all.
    if (topicTagIds.length > 0 && documentIds.length > 0) {
      await documentModel.replaceEntityInLocalRecords('tags', {
        fromId: Number(tagId),
        toId: topicTagIds[0],
        documentIds,
      });
    }

    await documentModel.updateTagSplitProposal(tagId, { status: 'applied' });

    this._log(
      isDelete
        ? `deleted tag ${tagId} "${tagName}": ${documents.length} document(s) lost it; ` +
            `${deleted ? 'tag deleted' : 'tag kept'}.`
        : `split tag ${tagId} "${tagName}": ${documents.length} document(s)` +
            (typeName
              ? ` → type "${typeName}" (${typeSetIds.length} set, ${typeKept} kept)`
              : ' → no document type') +
            `, tags ${topicNames.join(', ') || '(none)'}; ` +
            `${deleted ? 'tag deleted' : 'tag kept'}.`
    );

    return {
      tagId: Number(tagId),
      tagName,
      action: isDelete ? DELETE_ACTION : SPLIT_ACTION,
      logId,
      documentsUpdated: documents.length,
      typeSet: typeSetIds.length,
      typeKept,
      status,
    };
  }

  /**
   * The tag a topic of the vocabulary stands for: the id the vocabulary knows
   * when it still exists, otherwise the tag of that name, otherwise a new
   * one. A tag this call created is recorded, so an undo can remove it again.
   *
   * @returns {Promise<number|null>}
   */
  async _topicTagId(topicName, vocabulary, createdTagIds) {
    const entry = vocabulary.topics.find((row) => row.name === topicName);
    if (entry?.paperlessId != null) {
      const known = await paperlessService.getEntity(
        'tags',
        Number(entry.paperlessId)
      );
      if (known?.id != null) return Number(known.id);
      // The remembered tag is gone; the name decides again.
      await documentModel.setTagVocabularyPaperlessId(entry.id, null);
      entry.paperlessId = null;
    }

    const existing = await paperlessService.findEntityByExactName(
      'tags',
      topicName
    );
    if (existing?.id != null) {
      const id = Number(existing.id);
      await this._rememberVocabularyId(
        DIMENSIONS.TOPIC,
        topicName,
        id,
        vocabulary
      );
      return id;
    }

    const created = await paperlessService.createEntity('tags', {
      name: topicName,
    });
    const id = Number(created?.id);
    if (!Number.isInteger(id)) return null;
    createdTagIds.push(id);
    await this._rememberVocabularyId(
      DIMENSIONS.TOPIC,
      topicName,
      id,
      vocabulary
    );
    return id;
  }

  /** Writes the Paperless-ngx id of an object onto its vocabulary entry. */
  /**
   * The id of a document type, found or created once per apply run:
   * proposals applied side by side share the lookup, so two splits into the
   * same type never create it twice. `created` is true for the one caller
   * whose lookup created it; that caller's undo owns the type.
   *
   * @param {string} typeName
   * @param {object} context - the run's context; the memo lives on it
   * @returns {Promise<{ id: number, created: boolean }>}
   */
  async _typeIdFor(typeName, context) {
    const memo = (context.typeIds ||= new Map());
    const key = typeName.toLowerCase();
    let first = false;
    if (!memo.has(key)) {
      first = true;
      memo.set(
        key,
        (async () => {
          const existing =
            await paperlessService.findDocumentTypeByExactName(typeName);
          if (existing) return { id: Number(existing.id), created: false };
          const created = await paperlessService.createDocumentType(typeName);
          return { id: Number(created?.id), created: true };
        })().catch((error) => {
          // The next proposal with this type asks again.
          memo.delete(key);
          throw error;
        })
      );
    }
    const found = await memo.get(key);
    return { id: found.id, created: first && found.created };
  }

  /**
   * The id of a topic tag the same way: one lookup per name and run, and the
   * tag counts as created for the first caller only.
   *
   * @param {string} topicName
   * @param {object} context
   * @param {number[]} createdTagIds - this proposal's list, appended to when
   *   the lookup created the tag for it
   * @returns {Promise<number|null>}
   */
  async _topicTagIdFor(topicName, context, createdTagIds) {
    const memo = (context.topicIds ||= new Map());
    const key = normalizedTagKey(topicName);
    let first = false;
    if (!memo.has(key)) {
      first = true;
      const own = [];
      memo.set(
        key,
        this._topicTagId(topicName, context.vocabulary, own)
          .then((id) => ({ id, created: own.length > 0 }))
          .catch((error) => {
            memo.delete(key);
            throw error;
          })
      );
    }
    const found = await memo.get(key);
    if (first && found.created && Number.isInteger(found.id)) {
      createdTagIds.push(found.id);
    }
    return found.id;
  }

  async _rememberVocabularyId(dimension, name, paperlessId, vocabulary) {
    const list =
      dimension === DIMENSIONS.TYPE ? vocabulary?.types : vocabulary?.topics;
    const entry = (Array.isArray(list) ? list : []).find(
      (row) => row.name === name
    );
    if (!entry) return;
    entry.paperlessId = paperlessId == null ? null : Number(paperlessId);
    await documentModel.setTagVocabularyPaperlessId(
      entry.id,
      entry.paperlessId
    );
  }

  /* --- Undoing a split --------------------------------------------------- */

  /**
   * Plays a split back from its log row: the compound tag is re-created
   * (new id), the documents get it back, the topic tags the split added are
   * removed from them, a document type the split set is restored to what
   * the document had, objects the split created are deleted again.
   *
   * @param {object} entry  the EntityMergeLogEntry with action 'split'
   * @param {{performedBy?: string|null}} [options]
   * @returns {Promise<object>} what duplicateMergeService.undo() returns for a merge
   */
  async undoSplit(entry, options = {}) {
    if (!entry || entry.action !== SPLIT_ACTION) {
      throw new SimplifyError('This log row is not a split', 400);
    }
    if (entry.status === 'undone') {
      throw new SimplifyError('This split was already undone', 409);
    }
    const performedBy = options.performedBy ?? null;
    const source = (Array.isArray(entry.sources) ? entry.sources : [])[0];
    if (!source) {
      throw new SimplifyError('This split has nothing to restore', 409);
    }
    const details = entry.details || {};
    const recorded = Array.isArray(details.documents) ? details.documents : [];
    const startedAt = Date.now();
    const restored = {
      originalId: Number(source.id),
      name: String(source.snapshot?.name ?? source.name ?? ''),
      restoredId: null,
      adoptedExisting: false,
      documentsRestored: 0,
      documentsSkipped: 0,
      error: null,
    };

    try {
      const existing = await paperlessService.findEntityByExactName(
        'tags',
        restored.name
      );
      if (existing) {
        restored.restoredId = Number(existing.id);
        restored.adoptedExisting = true;
      } else {
        const payload = createPayloadFromSnapshot(source.snapshot);
        let created;
        try {
          created = await paperlessService.createEntity('tags', payload);
        } catch (error) {
          const status = error?.response?.status;
          if (payload.owner != null && (status === 400 || status === 403)) {
            // Setting the owner is refused for some tokens; the tag itself
            // matters more than who owns it.
            const { owner, ...withoutOwner } = payload;
            void owner;
            created = await paperlessService.createEntity('tags', withoutOwner);
          } else {
            throw error;
          }
        }
        restored.restoredId = Number(created?.id);
      }
    } catch (error) {
      restored.error = `could not be restored: ${
        error?.message || 'unknown error'
      }`;
    }

    let typesRestored = 0;
    if (restored.restoredId != null && Number.isInteger(restored.restoredId)) {
      try {
        const wanted = recorded.map((document) => Number(document.id));
        const alive = new Set(
          (wanted.length > 0
            ? await paperlessService.getDocumentsByIds(wanted, 'id')
            : []
          ).map((document) => Number(document.id))
        );
        restored.documentsRestored = alive.size;
        restored.documentsSkipped = wanted.length - alive.size;

        const living = wanted.filter((id) => alive.has(id));
        if (living.length > 0) {
          await paperlessService.bulkEditDocuments(living, 'modify_tags', {
            add_tags: [restored.restoredId],
            remove_tags: [],
          });
        }

        // The topic tags this split added, taken off again — grouped by the
        // set that was added, so a hundred documents cost one request.
        const byAdded = new Map();
        for (const document of recorded) {
          const id = Number(document.id);
          if (!alive.has(id)) continue;
          const added = (
            Array.isArray(document.addedTagIds) ? document.addedTagIds : []
          ).map(Number);
          if (added.length === 0) continue;
          const key = [...added].sort((a, b) => a - b).join(',');
          if (!byAdded.has(key)) byAdded.set(key, { added, documents: [] });
          byAdded.get(key).documents.push(id);
        }
        for (const group of byAdded.values()) {
          await paperlessService.bulkEditDocuments(
            group.documents,
            'modify_tags',
            { add_tags: [], remove_tags: group.added }
          );
        }

        // The document type this split set, put back to what the document
        // had — grouped by that previous type, null included.
        const byType = new Map();
        for (const document of recorded) {
          const id = Number(document.id);
          if (!alive.has(id) || !document.typeSet) continue;
          const key =
            document.previousTypeId == null
              ? 'none'
              : String(Number(document.previousTypeId));
          if (!byType.has(key)) byType.set(key, []);
          byType.get(key).push(id);
        }
        for (const [key, ids] of byType) {
          await paperlessService.setDocumentTypeOnDocuments(
            ids,
            key === 'none' ? null : Number(key)
          );
          typesRestored += ids.length;
        }

        // The local records follow the tag back, for the documents whose
        // rows the split rewrote onto the first topic tag.
        const firstTopic = Array.isArray(details.topicTagIds)
          ? Number(details.topicTagIds[0])
          : null;
        if (Number.isInteger(firstTopic)) {
          const rewritten = recorded
            .filter(
              (document) =>
                alive.has(Number(document.id)) &&
                (Array.isArray(document.addedTagIds)
                  ? document.addedTagIds.map(Number)
                  : []
                ).includes(firstTopic)
            )
            .map((document) => Number(document.id));
          if (rewritten.length > 0) {
            await documentModel.replaceEntityInLocalRecords('tags', {
              fromId: firstTopic,
              toId: restored.restoredId,
              documentIds: rewritten,
            });
          }
        }
      } catch (error) {
        restored.error = `the documents were not put back: ${
          error?.message || 'unknown error'
        }`;
      }
    }

    const removed = await this._removeCreatedObjects(details);

    await documentModel.updateTagSplitProposal(Number(source.id), {
      status: 'open',
    });

    const status =
      restored.restoredId != null && restored.error == null
        ? 'undone'
        : 'undo_failed';
    const undoResult = {
      status,
      revertedMatchingRule: false,
      performedBy,
      sources: [restored],
    };

    this._mergeService().afterWrite('undo');
    await documentModel.updateEntityMergeUndo(entry.id, { status, undoResult });

    this._log(
      restored.error
        ? `undid the split of "${restored.name}": ${restored.error}.`
        : `undid the split of "${restored.name}": tag re-created as ${restored.restoredId}, ` +
            `${restored.documentsRestored} document(s) re-tagged, ${typesRestored} type(s) restored` +
            `${removed === 0 ? '' : `, ${removed} object(s) removed again`}, in ${
              Date.now() - startedAt
            }ms.`
    );
    return undoResult;
  }

  /**
   * Deletes the tags and the document type the split created — but only the
   * ones nothing uses by now. A tag the user has filed something under since
   * is theirs.
   *
   * @param {object} details
   * @returns {Promise<number>} objects removed
   */
  async _removeCreatedObjects(details) {
    let removed = 0;
    for (const created of Array.isArray(details.createdTagIds)
      ? details.createdTagIds
      : []) {
      const id = Number(created);
      if (!Number.isInteger(id)) continue;
      try {
        const documents = await paperlessService.getDocumentIdsByEntity(
          'tags',
          id
        );
        if (documents.length > 0) {
          this._log(
            `the tag ${id} the split created carries ${documents.length} document(s) and was kept.`
          );
          continue;
        }
        if (await paperlessService.deleteEntity('tags', id)) removed += 1;
        await this._forgetVocabularyId(id, 'topic');
      } catch (error) {
        console.error(
          `[ERROR] removing the tag ${id} a split created:`,
          error?.message || error
        );
      }
    }

    // Null when the type existed before the split: Number(null) is 0, which
    // is an integer and not a document type.
    const typeId =
      details.createdTypeId == null ? null : Number(details.createdTypeId);
    if (Number.isInteger(typeId) && typeId > 0) {
      try {
        const documents =
          await paperlessService.getDocumentIdsByDocumentType(typeId);
        if (documents.length > 0) {
          this._log(
            `the document type ${typeId} the split created carries ${documents.length} document(s) and was kept.`
          );
        } else {
          if (await paperlessService.deleteDocumentType(typeId)) removed += 1;
          await this._forgetVocabularyId(typeId, 'type');
        }
      } catch (error) {
        console.error(
          `[ERROR] removing the document type ${typeId} a split created:`,
          error?.message || error
        );
      }
    }
    return removed;
  }

  /** Clears the Paperless-ngx id of a vocabulary entry whose object is gone. */
  async _forgetVocabularyId(paperlessId, dimension) {
    const rows = await documentModel.getTagVocabulary();
    for (const row of rows) {
      if (row.dimension !== dimension) continue;
      if (Number(row.paperlessId) !== Number(paperlessId)) continue;
      await documentModel.setTagVocabularyPaperlessId(row.id, null);
    }
  }

  /* --- The proposed order (round 12) ------------------------------------ */

  /**
   * What the model is told about the order: the four actions, the vocabulary
   * it may use, and that it is looking at names, not at documents.
   *
   * @param {{types: object[], topics: object[]}} vocabulary
   * @returns {string}
   */
  buildOrderSystemPrompt(vocabulary) {
    const typeNames = vocabulary.types.map((entry) => entry.name);
    const topicNames = vocabulary.topics.map((entry) => entry.name);
    return [
      'You are given tag names of one personal document archive (Paperless-ngx).',
      'The archive grew one tag per idea. The order it should end up with has two dimensions: the kind of a document belongs in its document type, what the document is about belongs in a tag.',
      'Give every tag exactly one action:',
      '"split" — the name presses a kind of document and a subject into one word ("Stromrechnung"). Name the "type" and the "topics" it stands for.',
      '"merge" — the name is another spelling of another tag of this request. Name that tag in "mergeInto", copied exactly.',
      '"keep" — the name is already a plain subject and stands on its own.',
      '"delete" — the name carries no meaning worth a tag: a note to self, a leftover, a word that says nothing about the documents.',
      '',
      `The document types you may use: ${typeNames.join(', ') || '(none)'}.`,
      `The topics you may use: ${topicNames.join(', ') || '(none)'}.`,
      '',
      'Use those names and no others. Never invent a type or a topic, and never answer with a name that is not in the two lists above.',
      'Copy the names exactly as they are spelled in the lists.',
      '"mergeInto" is the name of another tag of this request, copied exactly; never a type and never a topic.',
      'You are given names and document counts, not documents. Judge by the name, and never guess what is inside a document.',
      '"confidence" is "high" when the name plainly says it and "low" when you had to guess.',
      '"type" and "topics" belong to "split" only and "mergeInto" to "merge" only; leave out every field that does not apply to the action.',
      '"reason" is at most six words; a "keep" needs none.',
      '',
      'Answer with a JSON array and nothing else — no prose, no explanation, no code fence:',
      '[{"id": "12", "action": "split", "type": "Rechnung", "topics": ["Strom"], "confidence": "high", "reason": "<at most six words>"}, ' +
        '{"id": "13", "action": "merge", "mergeInto": "<another tag of this request>", "confidence": "high", "reason": "<at most six words>"}, ' +
        '{"id": "14", "action": "keep", "confidence": "high"}, ' +
        '{"id": "15", "action": "delete", "confidence": "low", "reason": "<at most six words>"}]',
      'Answer every tag you were given exactly once, with the id copied as it was given.',
    ].join('\n');
  }

  /** The tags of one order request: id, name and how many documents carry it. */
  buildOrderUserPrompt(tags) {
    return [
      `Tags: ${tags.length}`,
      '[',
      tags
        .map((tag) =>
          JSON.stringify({
            id: String(tag.id),
            name: String(tag.name ?? ''),
            documents: Number(tag.documentCount) || 0,
          })
        )
        .join(',\n'),
      ']',
    ].join('\n');
  }

  /**
   * One job for the whole order: reads every tag and every document type,
   * proposes the vocabulary itself (or keeps the saved one when
   * options.vocabulary is 'keep'), and gives every tag one action — split,
   * merge, keep or delete — by rule first and by the model second. Replaces
   * the stored proposals. Runs as a job with task 'order'.
   *
   * Three options narrow what this one run does without changing what the
   * order means: `skipDecided` leaves out the tags the user has already
   * decided on (keeping their proposals), `minDocuments` leaves out the tags
   * on fewer documents than that, and `concurrency` overrides
   * DUPLICATES_AI_CONCURRENCY for this run. All three are absent by default,
   * and an absent one narrows and overrides nothing.
   *
   * @param {{ vocabulary?: 'propose'|'keep', skipDecided?: boolean,
   *   minDocuments?: number|null, concurrency?: number|null }} options
   * @param {object} control  { signal, onProgress, tokenBudget, stop,
   *   stopReason, noteRun, recordRequest }
   * @returns {Promise<{ vocabulary: object, proposals: number, byRule: number, byModel: number, items: number, itemsByRule: number, requests: number, tokens: number, groups: number, stopped: boolean }>}
   */
  async proposeOrder(options = {}, control = {}) {
    const config = this._config();
    const mode = options?.vocabulary === 'keep' ? 'keep' : 'propose';
    const usage = { requests: 0, tokens: 0, failedRequests: 0 };

    const vocabulary = await this._orderVocabulary(
      mode,
      usage,
      control,
      options?.concurrency
    );

    let tags;
    try {
      tags = await paperlessService.listEntities('tags');
    } catch (error) {
      throw this._asPaperlessError(error, 'reading the tags');
    }
    const named = tags.filter((tag) => String(tag?.name ?? '').trim() !== '');

    const pass = this._rulePass(named, vocabulary);
    const proposals = pass.settled;
    const unsettled = pass.unsettled;
    const settledByRule = proposals.size;

    // The two levers of this run: what the user has already decided and what
    // sits on too few documents never reach the model. Absent options narrow
    // nothing, so a run that says neither asks exactly what it always asked.
    const narrowed = await this._narrowToAsk(unsettled, options);
    const asked = narrowed.items;
    const withModel = asked.length > 0 && this.hasProvider();
    const perRequest = Math.max(1, Number(config.simplifyTagsPerRequest) || 50);
    const chunks = withModel ? chunkList(asked, perRequest) : [];
    // The vocabulary proposal made requests of its own; the job's counters
    // carry on from there instead of starting again.
    const baseRequests = usage.requests;
    const planned = baseRequests + chunks.length;

    // What this run costs is filed under the tags the model is asked about
    // and the tags a rule settled first, so the next estimate of the order
    // divides by the right number.
    this._noteRun(control, {
      items: asked.length,
      itemsByRule: settledByRule,
      model: this._modelName() ?? null,
      thinking: this._thinkingOn(),
    });

    this._report(control, {
      phase: PHASES.ORDERING,
      kind: 'tags',
      requestsDone: baseRequests,
      requestsPlanned: planned,
      pairsTotal: named.length,
      pairsJudged: settledByRule,
      tokens: usage.tokens,
      message: this._splitMessage(
        settledByRule,
        named.length,
        asked.length,
        chunks.length,
        0
      ),
    });

    if (chunks.length > 0) {
      const service = this._provider();
      const systemPrompt = this.buildOrderSystemPrompt(vocabulary);
      const index = new Map();
      for (const tag of named) {
        const key = normalizedTagKey(tag.name);
        if (key !== '' && !index.has(key)) index.set(key, tag);
      }
      const lanes = Math.min(this._lanes(options?.concurrency), chunks.length);
      let started = 0;
      let done = baseRequests;
      await runInLanes(chunks, lanes, async (chunk) => {
        if (this._stopped(control)) return;
        started += 1;
        this._report(control, {
          phase: PHASES.ORDERING,
          message: this._splitMessage(
            settledByRule,
            named.length,
            asked.length,
            chunks.length,
            started
          ),
          requestsDone: done,
          requestsPlanned: planned,
          tokens: usage.tokens,
        });
        const answered = await this._splitChunk(
          service,
          systemPrompt,
          chunk,
          vocabulary,
          usage,
          control,
          {
            label: 'order',
            prompt: (part) => this.buildOrderUserPrompt(part),
            build: (items, part, vocab) =>
              this._orderProposals(items, part, vocab, index),
          }
        );
        for (const row of answered) proposals.set(row.tagId, row);
        done += 1;
        this._report(control, {
          phase: PHASES.ORDERING,
          requestsDone: done,
          requestsPlanned: planned,
          pairsJudged: proposals.size,
          tokens: usage.tokens,
          failedRequests: usage.failedRequests,
        });
        this._checkTokenBudget(control, usage);
      });
    }

    // A tag the run was told not to ask about keeps the proposal it was
    // decided on. Skipping it saves a request; it does not undo a decision.
    for (const [tagId, row] of narrowed.keepAsIs) {
      if (!proposals.has(tagId)) proposals.set(tagId, row);
    }
    const belowFloor = new Set(
      narrowed.lowDocument.map((tag) => Number(tag.id))
    );

    // Every tag ends up with an action. What neither the rule nor the model
    // settled stays as it is rather than disappearing from the review, and
    // the reason says which of the three it was.
    for (const tag of named) {
      const tagId = Number(tag.id);
      if (proposals.has(tagId)) continue;
      proposals.set(
        tagId,
        this._orderRow(tag, {
          action: 'keep',
          confidence: 'low',
          reason: belowFloor.has(tagId)
            ? 'this run left out the tags on few documents'
            : withModel
              ? 'the model did not answer for this tag'
              : 'nothing in the vocabulary accounts for this name',
        })
      );
    }

    const rows = [...proposals.values()].sort((a, b) =>
      String(a.tagName).localeCompare(String(b.tagName), undefined, {
        sensitivity: 'base',
      })
    );
    await documentModel.replaceTagSplitProposals(rows);

    const count = (action) =>
      rows.filter((row) => row.action === action).length;
    const byRule = rows.filter((row) => row.source === 'rule').length;
    const byModel = rows.filter((row) => row.source === 'model').length;
    const groups = (await this.listGroups()).groups.length;

    this._log(
      `order proposed: ${rows.length} tag(s): ${count('split')} split, ` +
        `${count('merge')} merge, ${count('keep')} keep, ${count('delete')} delete; ` +
        `${byRule} by rule, ${byModel} by the model in ${usage.requests} request(s).`
    );
    const leftOut = unsettled.length - asked.length;
    if (leftOut > 0) {
      this._log(
        `${leftOut} tag(s) the rule could not settle were left out of this ` +
          'run by its own options; their proposals are as they were.'
      );
    }
    if (!withModel && asked.length > 0) {
      this._log(
        'no AI provider is configured; the tags the rule could not settle are kept.'
      );
    }

    return {
      vocabulary,
      proposals: rows.length,
      byRule,
      byModel,
      // What the model was asked about and what a rule settled first: the
      // two numbers `ai_run_stats` files this run under.
      items: asked.length,
      itemsByRule: settledByRule,
      requests: usage.requests,
      tokens: usage.tokens,
      groups,
      stopped: this._stopped(control),
    };
  }

  /**
   * The vocabulary the order is built against: the saved one, or one the
   * model proposes from every tag name and that is saved before the tags are
   * read. Without a provider the saved one is all there is.
   *
   * @param {'propose'|'keep'} mode
   * @param {{requests: number, tokens: number}} usage
   * @param {object} control
   * @param {number|null} [concurrency]  the run's own lane count, if it named one
   * @returns {Promise<{types: object[], topics: object[]}>}
   */
  async _orderVocabulary(mode, usage, control, concurrency = null) {
    const saved = await this.getVocabulary();
    const isEmpty = (entry) =>
      entry.types.length === 0 && entry.topics.length === 0;

    if (mode === 'keep') {
      if (isEmpty(saved)) {
        throw new SimplifyError(
          'There is no saved vocabulary; let this run propose one',
          409
        );
      }
      this._report(control, {
        phase: PHASES.VOCABULARY,
        kind: 'tags',
        message: `Using the saved vocabulary: ${saved.types.length} type(s), ${saved.topics.length} topic(s).`,
      });
      return saved;
    }

    if (!this.hasProvider()) {
      if (isEmpty(saved)) {
        throw new SimplifyError('The AI provider is not configured', 409);
      }
      this._log(
        'no AI provider is configured; the saved vocabulary is used as it is.'
      );
      return saved;
    }

    const proposed = await this.proposeVocabulary({ concurrency }, control);
    usage.requests += Number(proposed.requests) || 0;
    usage.tokens += Number(proposed.tokens) || 0;
    if (proposed.types.length === 0 && proposed.topics.length === 0) {
      if (isEmpty(saved)) {
        throw new SimplifyError(
          'The model proposed no vocabulary to order the tags by',
          409
        );
      }
      this._log(
        'the model proposed no vocabulary; the saved one is used as it is.'
      );
      return saved;
    }
    return this.saveVocabulary({
      types: proposed.types,
      topics: proposed.topics,
      source: 'model',
    });
  }

  /**
   * One proposal row with the defaults of the order, overwritten by what the
   * rule or the model decided.
   *
   * @param {object} tag  EntityRecord
   * @param {object} row
   * @returns {object} a TagSplitProposal row
   */
  _orderRow(tag, row = {}) {
    const defaults = {
      tagId: Number(tag.id),
      tagName: String(tag.name ?? ''),
      documentCount: Number(tag.documentCount) || 0,
      action: 'keep',
      mergeInto: null,
      typeName: null,
      topicNames: [],
      source: 'rule',
      confidence: 'high',
      reason: null,
      documentsWithType: 0,
      overwriteType: false,
      status: 'open',
    };
    return { ...defaults, ...row, reason: toReason(row.reason) };
  }

  /**
   * The pass the order runs before it asks anything: every tag the rule can
   * settle on its own, and the ones only the model can answer for.
   *
   * It is a function of the tags and the vocabulary and nothing else — no
   * request, no write — which is why the estimate can run it too. The
   * estimate and the run therefore never disagree about how many tags reach
   * the model.
   *
   * @param {object[]} named  every tag of the archive that has a name
   * @param {{types: object[], topics: object[]}} vocabulary
   * @returns {{settled: Map<number, object>, unsettled: object[]}}
   */
  _rulePass(named, vocabulary) {
    const mergeService = this._mergeService();
    const rules = {
      mergeService,
      configuredTagNames: mergeService.configuredTagNames(),
      topicKeys: new Set(
        vocabulary.topics.map((entry) => normalizedTagKey(entry.name))
      ),
    };
    const settled = new Map();
    const unsettled = [];
    for (const tag of named) {
      const row = this._ruleAction(tag, named, vocabulary, rules);
      if (row) settled.set(Number(tag.id), row);
      else unsettled.push(tag);
    }
    return { settled, unsettled };
  }

  /**
   * The floor a run was given for the document count, or null when it was
   * given none. Negative is nonsense, not a refusal: it is clamped to zero,
   * which skips nothing.
   *
   * @param {unknown} value
   * @returns {number|null}
   */
  _minDocuments(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.floor(number));
  }

  /** The stored proposals the user has already accepted or applied, by tag id. */
  async _decidedProposals() {
    const decided = new Map();
    for (const row of await documentModel.listTagSplitProposals({})) {
      if (row?.status !== 'accepted' && row?.status !== 'applied') continue;
      const id = Number(row.tagId);
      if (Number.isInteger(id)) decided.set(id, row);
    }
    return decided;
  }

  /**
   * The two levers of the order, applied to the tags the rule could not
   * settle: leave out what the user has already decided, and leave out what
   * sits on too few documents to be worth a model request.
   *
   * A tag left out for being decided keeps the proposal it was decided on —
   * skipping it saves a request, it does not throw the decision away.
   *
   * @param {object[]} unsettled  the tags the rule left open
   * @param {{skipDecided?: boolean, minDocuments?: number|null}} [options]
   * @returns {Promise<{items: object[], keepAsIs: Map<number, object>,
   *   lowDocument: object[]}>}
   */
  async _narrowToAsk(unsettled, options = {}) {
    const skipDecided = options?.skipDecided === true;
    const floor = this._minDocuments(options?.minDocuments);
    if (!skipDecided && floor === null) {
      return { items: unsettled, keepAsIs: new Map(), lowDocument: [] };
    }
    const decided = skipDecided ? await this._decidedProposals() : new Map();
    const items = [];
    const keepAsIs = new Map();
    const lowDocument = [];
    for (const tag of unsettled) {
      const id = Number(tag.id);
      const row = decided.get(id);
      if (row) {
        keepAsIs.set(id, row);
        continue;
      }
      if (floor !== null && (Number(tag.documentCount) || 0) < floor) {
        lowDocument.push(tag);
        continue;
      }
      items.push(tag);
    }
    return { items, keepAsIs, lowDocument };
  }

  /**
   * The tags of the archive, from the read the estimate last made when that
   * was less than ESTIMATE_TAGS_TTL_MS ago.
   *
   * Only the estimate uses it. A run reads the archive as it is, because it
   * is about to write to it.
   *
   * @returns {Promise<object[]>}
   */
  async _tagsForEstimate() {
    const cached = this._estimateTags;
    if (cached && Date.now() - cached.at < ESTIMATE_TAGS_TTL_MS) {
      return cached.tags;
    }
    let tags;
    try {
      tags = await paperlessService.listEntities('tags');
    } catch (error) {
      throw this._asPaperlessError(error, 'reading the tags');
    }
    this._estimateTags = { tags, at: Date.now() };
    return tags;
  }

  /** Forgets the tag list the estimate answers from; the tests use it. */
  forgetEstimateTags() {
    this._estimateTags = null;
  }

  /**
   * What the next run of the proposed order would cost, without asking
   * anybody.
   *
   * The page calls this on every move of a lever, so nothing here asks a
   * model and nothing reads a document: the rule pass the run itself runs,
   * the tag list (cached for a minute), the saved vocabulary, the stored
   * proposals, and what the judge measured about this model.
   *
   * `skippable` is what each lever would save, counted over the tags that
   * would otherwise reach the model — the number the page puts next to the
   * lever, not a count of the whole archive. `lowDocument` uses the floor it
   * was given, or DEFAULT_LOW_DOCUMENT_FLOOR when it was given none, so the
   * page has something real to offer before anybody has moved anything.
   *
   * @param {object} [options]
   * @param {boolean} [options.keepVocabulary]  use the saved vocabulary
   *   instead of proposing a new one, which is the pass that costs extra
   * @param {boolean} [options.skipDecided]
   * @param {number|null} [options.minDocuments]
   * @param {number|null} [options.concurrency]
   * @returns {Promise<object>} a TagOrderEstimate
   */
  async estimateOrder(options = {}) {
    const config = this._config();
    const keepVocabulary = options?.keepVocabulary === true;
    const floor = this._minDocuments(options?.minDocuments);

    const tags = await this._tagsForEstimate();
    const named = tags.filter((tag) => String(tag?.name ?? '').trim() !== '');
    const vocabulary = await this.getVocabulary();
    const { settled, unsettled } = this._rulePass(named, vocabulary);

    const decided = await this._decidedProposals();
    const skippable = {
      decided: unsettled.filter((tag) => decided.has(Number(tag.id))).length,
      lowDocument: unsettled.filter(
        (tag) =>
          (Number(tag.documentCount) || 0) <
          (floor === null ? DEFAULT_LOW_DOCUMENT_FLOOR : floor)
      ).length,
    };
    const narrowed = await this._narrowToAsk(unsettled, options);

    const model = this._modelName() ?? null;
    const thinking = this._thinkingOn();
    const batchSize = Math.max(1, Number(config.simplifyTagsPerRequest) || 50);
    const lanes = this._lanes(options?.concurrency);
    const [calibration, lastRun] = await Promise.all([
      model
        ? documentModel.getAiCalibration(model, thinking)
        : Promise.resolve(null),
      documentModel.getLastAiRunStats('order', model),
    ]);

    return {
      tags: named.length,
      itemsByRule: settled.size,
      ...estimateRun({
        items: narrowed.items.length,
        batchSize,
        lanes,
        calibration,
        lastRun,
        thinking,
      }),
      model,
      thinking,
      skippable,
      lastRun,
      // What comes on top of `requests`: proposing a new vocabulary is a
      // pass of its own over every tag name, before the first tag is
      // ordered. Nothing when the run keeps the saved one.
      extra: {
        vocabularyRequests: keepVocabulary
          ? 0
          : this._vocabularyRequestsFor(named),
      },
    };
  }

  /** How many requests a vocabulary proposal over these tags would take. */
  _vocabularyRequestsFor(named) {
    const config = this._config();
    const perRequest = Math.max(
      MIN_VOCABULARY_NAMES_PER_REQUEST,
      Number(config.duplicatesAiSweepNames) || MIN_VOCABULARY_NAMES_PER_REQUEST
    );
    const distinct = new Set();
    for (const tag of named) {
      const name = String(tag?.name ?? '').trim();
      if (name !== '') distinct.add(name);
    }
    return Math.ceil(distinct.size / perRequest);
  }

  /**
   * What the rule alone makes of one tag, or null when only the model can
   * say.
   *
   * The order of the questions is the point. What must not be touched is
   * settled first, so neither the inbox tag nor a tag the settings name nor
   * the target vocabulary itself is ever proposed for deletion; only then
   * does an empty tag become one.
   *
   * @param {object} tag  EntityRecord
   * @param {object[]} tags  every tag of the archive, for the spelling match
   * @param {{types: object[], topics: object[]}} vocabulary
   * @param {{mergeService: object, configuredTagNames: string[], topicKeys: Set<string>}} rules
   * @returns {object|null} a TagSplitProposal row
   */
  _ruleAction(tag, tags, vocabulary, rules) {
    const name = String(tag.name ?? '');
    if (tag.isInboxTag) {
      return this._orderRow(tag, { reason: 'the inbox tag' });
    }
    if (
      rules.mergeService.isConfiguredTagName(rules.configuredTagNames, name)
    ) {
      return this._orderRow(tag, { reason: 'the settings refer to this tag' });
    }
    if (tag.userCanChange === false) {
      return this._orderRow(tag, {
        reason: 'the API token may not change it',
      });
    }
    if (rules.topicKeys.has(normalizedTagKey(name))) {
      return this._orderRow(tag, { reason: 'a topic of the vocabulary' });
    }
    if ((Number(tag.documentCount) || 0) === 0) {
      return this._orderRow(tag, { action: 'delete', reason: 'no documents' });
    }

    const decomposed = entityNameMatcher.decomposeCompound(name, vocabulary);
    if (decomposed && decomposed.score >= 1) {
      return this._ruleSplit(tag, decomposed);
    }

    const match = this._hardMatch(tag, tags);
    if (match) {
      return this._orderRow(tag, {
        action: 'merge',
        mergeInto: String(match.entity.name),
        reason: `another spelling of "${match.entity.name}" (${match.reason})`,
      });
    }

    if (decomposed && decomposed.score >= 0.7) {
      return this._ruleSplit(tag, decomposed);
    }
    return null;
  }

  /** The split row a decomposition is worth, with the reason it already has. */
  _ruleSplit(tag, decomposed) {
    return this._orderRow(tag, {
      action: 'split',
      typeName: decomposed.type,
      topicNames: [...decomposed.topics],
      confidence: decomposed.score >= 1 ? 'high' : 'low',
      reason: this._ruleReason(decomposed),
    });
  }

  /**
   * The tag this one is only another spelling of, when that other tag is the
   * one to keep. The matcher's hard tiers are the same word in another
   * spelling (case, umlauts, legal form, plural, word order); prefix and
   * fuzzy are not, and are left to the model.
   *
   * The tag with more documents survives; a tie goes to the shorter name and
   * then to the lower id, so both tags of a pair reach the same verdict and
   * two tags never merge into each other.
   *
   * @returns {{entity: object, reason: string, score: number}|null}
   */
  _hardMatch(tag, tags) {
    const others = tags.filter((other) => Number(other.id) !== Number(tag.id));
    const best = entityNameMatcher.bestMatch(String(tag.name ?? ''), others, {
      kind: 'tags',
    });
    if (!best || !entityNameMatcher.HARD_REASONS.includes(best.reason)) {
      return null;
    }
    return this._mergeSurvivor(tag, best.entity) === tag ? null : best;
  }

  /** Which of two tags of a hard pair is the one to keep. */
  _mergeSurvivor(a, b) {
    const documentsA = Number(a.documentCount) || 0;
    const documentsB = Number(b.documentCount) || 0;
    if (documentsA !== documentsB) return documentsA > documentsB ? a : b;
    const nameA = String(a.name ?? '');
    const nameB = String(b.name ?? '');
    if (nameA.length !== nameB.length)
      return nameA.length < nameB.length ? a : b;
    return Number(a.id) <= Number(b.id) ? a : b;
  }

  /**
   * The rows one order answer is worth. Ids the request did not carry are
   * dropped; a type or topic outside the vocabulary, a merge target that is
   * no tag and an action nobody offered turn the row into 'keep' with a note
   * in the reason rather than into a write to Paperless-ngx later.
   *
   * @param {object[]} items  what the model answered
   * @param {object[]} tags   the tags of this request
   * @param {{types: object[], topics: object[]}} vocabulary
   * @param {Map<string, object>} index  every tag of the archive by name key
   * @returns {object[]} TagSplitProposal rows
   */
  _orderProposals(items, tags, vocabulary, index) {
    const byId = new Map(tags.map((tag) => [String(tag.id), tag]));
    const nameOf = (entries, value) => {
      const wanted = normalizedTagKey(value);
      if (wanted === '') return null;
      const found = entries.find(
        (entry) => normalizedTagKey(entry.name) === wanted
      );
      return found ? found.name : null;
    };

    const rows = [];
    const answered = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      const id = String(item?.id ?? '').trim();
      const tag = byId.get(id);
      if (!tag || answered.has(id)) continue;
      answered.add(id);

      const notes = [];
      let action = String(item?.action ?? '')
        .trim()
        .toLowerCase();
      if (!PROPOSAL_ACTIONS.includes(action)) {
        notes.push(
          action === ''
            ? 'the model named no action'
            : `unknown action "${action.slice(0, 40)}"`
        );
        action = 'keep';
      }

      let typeName = null;
      const topicNames = [];
      let mergeInto = null;
      if (action === 'split') {
        const dropped = [];
        if (item?.type != null && String(item.type).trim() !== '') {
          typeName = nameOf(vocabulary.types, item.type);
          if (!typeName) dropped.push(String(item.type).trim());
        }
        for (const value of Array.isArray(item?.topics) ? item.topics : []) {
          const name = nameOf(vocabulary.topics, value);
          if (!name) {
            const raw = String(value ?? '').trim();
            if (raw !== '') dropped.push(raw);
            continue;
          }
          if (!topicNames.includes(name)) topicNames.push(name);
        }
        if (dropped.length > 0) {
          notes.push(`not in the vocabulary: ${dropped.join(', ')}`);
        }
        if (!typeName && topicNames.length === 0) {
          notes.push('nothing to split it into');
          action = 'keep';
        }
      } else if (action === 'merge') {
        const wanted = String(item?.mergeInto ?? '').trim();
        const target = index.get(normalizedTagKey(wanted));
        if (!target || Number(target.id) === Number(tag.id)) {
          notes.push(
            wanted === ''
              ? 'the model named no tag to merge into'
              : `no other tag is called "${wanted.slice(0, 60)}"`
          );
          action = 'keep';
        } else {
          mergeInto = String(target.name);
        }
      }

      let reason = toReason(item?.reason) || 'proposed by the model';
      if (notes.length > 0) reason = `${reason} (${notes.join('; ')})`;
      rows.push(
        this._orderRow(tag, {
          action,
          typeName,
          topicNames,
          mergeInto,
          source: 'model',
          confidence: item?.confidence === 'high' ? 'high' : 'low',
          reason,
        })
      );
    }
    return rows;
  }

  /* --- The groups ------------------------------------------------------- */

  /**
   * The stored proposals as groups: one per document type (kind 'type', the
   * tags that become or get it), one per topic (kind 'topic', the tags that
   * carry it), one per merge target (kind 'merge'), and the two buckets
   * 'keep' and 'delete'. A tag with a type and two topics is a member of
   * three groups; a decision on a group patches its members' proposals.
   *
   * @returns {Promise<{ groups: object[], tags: number, open: number, accepted: number, applied: number, skipped: number }>}
   */
  async listGroups() {
    const proposals = await documentModel.listTagSplitProposals();
    return this._groupsOf(proposals);
  }

  /**
   * The groups a list of proposals makes, in the order the page shows them:
   * the kinds in the order type, topic, merge, delete, keep, inside a kind
   * the biggest by documents first, and inside a group the same.
   *
   * @param {object[]} proposals
   * @returns {{groups: object[], tags: number, open: number, accepted: number, applied: number, skipped: number}}
   */
  _groupsOf(proposals) {
    const totals = { tags: 0, open: 0, accepted: 0, applied: 0, skipped: 0 };
    const groups = new Map();
    const add = (kind, name, member) => {
      const key = name == null ? kind : `${kind}:${name}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          kind,
          name,
          tags: 0,
          documents: 0,
          open: 0,
          accepted: 0,
          applied: 0,
          skipped: 0,
          members: [],
        };
        groups.set(key, group);
      }
      group.members.push(member);
      group.tags += 1;
      group.documents += member.documentCount;
      if (PROPOSAL_STATUSES.includes(member.status)) {
        group[member.status] += 1;
      }
    };

    for (const proposal of Array.isArray(proposals) ? proposals : []) {
      const member = {
        tagId: Number(proposal.tagId),
        tagName: String(proposal.tagName ?? ''),
        documentCount: Number(proposal.documentCount) || 0,
        action: proposal.action || 'split',
        typeName: proposal.typeName ?? null,
        topicNames: Array.isArray(proposal.topicNames)
          ? [...proposal.topicNames]
          : [],
        mergeInto: proposal.mergeInto ?? null,
        source: proposal.source || 'rule',
        confidence: proposal.confidence ?? null,
        reason: proposal.reason ?? null,
        status: proposal.status || 'open',
      };
      totals.tags += 1;
      if (PROPOSAL_STATUSES.includes(member.status)) {
        totals[member.status] += 1;
      }

      if (member.action === 'split') {
        if (member.typeName) add('type', member.typeName, member);
        for (const topic of member.topicNames) add('topic', topic, member);
      } else if (member.action === 'merge') {
        if (member.mergeInto) add('merge', member.mergeInto, member);
      } else if (member.action === 'delete') {
        add('delete', null, member);
      } else {
        add('keep', null, member);
      }
    }

    const byName = (a, b) =>
      String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
    const list = [...groups.values()].sort(
      (a, b) =>
        GROUP_KINDS_IN_ORDER.indexOf(a.kind) -
          GROUP_KINDS_IN_ORDER.indexOf(b.kind) ||
        b.documents - a.documents ||
        byName(a.name ?? a.kind, b.name ?? b.kind)
    );
    for (const group of list) {
      group.members.sort(
        (a, b) =>
          b.documentCount - a.documentCount || byName(a.tagName, b.tagName)
      );
    }
    return { groups: list, ...totals };
  }

  /**
   * Accepts, skips or reopens every open member of a group (applied members
   * are left alone). A group key is 'type:Rechnung', 'topic:Strom',
   * 'merge:Amazon', 'keep' or 'delete'.
   *
   * @param {string} key
   * @param {'accept'|'skip'|'reopen'} decision
   * @returns {Promise<{ key: string, changed: number, group: object|null }>}
   */
  async decideGroup(key, decision) {
    if (!GROUP_DECISIONS.includes(decision)) {
      throw new SimplifyError(
        `decision must be one of ${GROUP_DECISIONS.join(', ')}`,
        400
      );
    }
    const parsed = parseGroupKey(key);
    const before = parsed ? await this.listGroups() : null;
    const group =
      before?.groups.find((entry) => entry.key === parsed.key) || null;
    if (!group) {
      throw new SimplifyError(`There is no group "${String(key ?? '')}"`, 404);
    }

    const moves = {
      accept: { from: ['open', 'skipped'], to: 'accepted' },
      skip: { from: ['open', 'accepted'], to: 'skipped' },
      reopen: { from: ['accepted', 'skipped'], to: 'open' },
    }[decision];
    const tagIds = group.members
      .filter((member) => moves.from.includes(member.status))
      .map((member) => member.tagId);
    const changed =
      tagIds.length > 0
        ? await documentModel.setTagSplitProposalStatus(tagIds, moves.to)
        : 0;
    this._log(
      `group "${group.key}": ${decision}, ${changed} of ${group.tags} tag(s) changed.`
    );

    const after = await this.listGroups();
    return {
      key: group.key,
      changed,
      group: after.groups.find((entry) => entry.key === group.key) || null,
    };
  }

  /**
   * Takes one tag out of a group without touching the rest of its proposal:
   * out of a type group the tag loses its type, out of a topic group that
   * topic, out of a merge group it becomes 'keep', out of 'delete' it becomes
   * 'keep'. A tag left with nothing becomes 'keep'.
   *
   * @param {string} key
   * @param {number} tagId
   * @returns {Promise<object>} the patched proposal
   */
  async removeGroupMember(key, tagId) {
    const parsed = parseGroupKey(key);
    if (!parsed) {
      throw new SimplifyError(`There is no group "${String(key ?? '')}"`, 404);
    }
    const id = Number(tagId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new SimplifyError('Unknown tag', 404);
    }
    const proposal = await documentModel.getTagSplitProposal(id);
    if (!proposal) {
      throw new SimplifyError(`There is no proposal for tag ${id}`, 404);
    }
    if (!this._isGroupMember(parsed, proposal)) {
      throw new SimplifyError(
        `Tag ${id} is not in the group "${parsed.key}"`,
        404
      );
    }
    if (proposal.status === 'applied') {
      throw new SimplifyError('This proposal was already applied', 409);
    }
    if (parsed.kind === 'keep') {
      throw new SimplifyError(
        'A tag that is kept is already out of everything',
        400
      );
    }

    let action = proposal.action || 'split';
    let typeName = proposal.typeName ?? null;
    let topicNames = [...proposal.topicNames];
    let mergeInto = proposal.mergeInto ?? null;
    if (parsed.kind === 'type') {
      typeName = null;
    } else if (parsed.kind === 'topic') {
      topicNames = topicNames.filter((name) => name !== parsed.name);
    } else {
      action = 'keep';
    }
    if (action === 'split' && !typeName && topicNames.length === 0) {
      action = 'keep';
    }
    if (action === 'keep') {
      typeName = null;
      topicNames = [];
      mergeInto = null;
    }

    const patched = await this.updateProposal(id, {
      action,
      typeName,
      topicNames,
      mergeInto,
    });
    this._log(
      `group "${parsed.key}": tag ${id} "${patched.tagName}" taken out, it is now "${patched.action}".`
    );
    return patched;
  }

  /** True when a proposal is shown in the given group. */
  _isGroupMember(parsed, proposal) {
    const action = proposal.action || 'split';
    if (parsed.kind === 'keep') return action === 'keep';
    if (parsed.kind === 'delete') return action === 'delete';
    if (parsed.kind === 'merge') {
      return action === 'merge' && proposal.mergeInto === parsed.name;
    }
    if (parsed.kind === 'type') {
      return action === 'split' && proposal.typeName === parsed.name;
    }
    return (
      action === 'split' &&
      Array.isArray(proposal.topicNames) &&
      proposal.topicNames.includes(parsed.name)
    );
  }

  /* --- Applying the order ----------------------------------------------- */

  /**
   * Applies every accepted proposal (or those of one group when
   * request.groupKey is set), one tag after the other: merges first, then
   * splits, then deletes, because a merge that feeds a split must happen
   * before it. Runs as a job with task 'apply'; the result has the shape of
   * TagOrderApplyResult. A stop between two tags leaves the rest accepted.
   *
   * @param {{ groupKey?: string|null, performedBy?: string|null }} request
   * @param {object} control
   * @returns {Promise<{ applied: object[], merged: object[], failed: object[], stopped: boolean }>}
   */
  async applyAccepted(request = {}, control = {}) {
    if (global.__paperlessAiScanControl?.running) {
      throw new SimplifyError(
        'A document scan is running. Wait until it has finished.',
        409
      );
    }
    const performedBy = request.performedBy ?? null;
    const wanted =
      request.groupKey == null || String(request.groupKey).trim() === ''
        ? null
        : String(request.groupKey);

    let accepted = await documentModel.listTagSplitProposals({
      status: 'accepted',
    });
    let groupKey = null;
    if (wanted !== null) {
      const parsed = parseGroupKey(wanted);
      const group = parsed
        ? (await this.listGroups()).groups.find(
            (entry) => entry.key === parsed.key
          )
        : null;
      if (!group) {
        throw new SimplifyError(`There is no group "${wanted}"`, 404);
      }
      groupKey = group.key;
      const ids = new Set(group.members.map((member) => member.tagId));
      accepted = accepted.filter((proposal) => ids.has(proposal.tagId));
    }

    // 'keep' is a decision not to write anything; it never reaches the API.
    const order = { merge: 0, split: 1, delete: 2 };
    const todo = accepted
      .filter((proposal) => order[proposal.action] != null)
      .sort(
        (a, b) =>
          order[a.action] - order[b.action] ||
          b.documentCount - a.documentCount ||
          String(a.tagName).localeCompare(String(b.tagName), undefined, {
            sensitivity: 'base',
          })
      );

    const mergeService = this._mergeService();
    const context = {
      performedBy,
      configuredTagNames: mergeService.configuredTagNames(),
      vocabulary: await this.getVocabulary(),
      mergeService,
      statuses: ['accepted'],
      tags: null,
      tagsLoading: null,
    };
    const startedAt = Date.now();
    this._log(
      `order apply started: ${todo.length} accepted proposal(s)` +
        `${groupKey ? ` of the group "${groupKey}"` : ''}.`
    );
    this._report(control, {
      phase: PHASES.APPLYING,
      kind: 'tags',
      requestsDone: 0,
      requestsPlanned: 0,
      pairsTotal: todo.length,
      pairsJudged: 0,
      tokens: 0,
      message:
        todo.length === 0
          ? 'Nothing is accepted.'
          : `Applying ${todo.length} tag(s)…`,
    });

    const applied = [];
    const merged = [];
    const failed = [];
    let stopped = false;
    let done = 0;
    let started = 0;
    /** Applies one proposal and books what came of it; never throws. */
    const applyOne = async (proposal) => {
      if (stopped || this._stopped(control)) {
        stopped = true;
        return;
      }
      started += 1;
      this._report(control, {
        phase: PHASES.APPLYING,
        pairsTotal: todo.length,
        pairsJudged: done,
        message: `Applying ${started} of ${todo.length}: ${proposal.tagName}…`,
      });
      try {
        if (proposal.action === 'merge') {
          merged.push(await this._applyMerge(proposal, context));
        } else {
          applied.push(await this._applyOne(proposal.tagId, context));
        }
      } catch (error) {
        failed.push({
          tagId: Number(proposal.tagId),
          tagName: error?.tagName || proposal.tagName,
          error: error?.message || 'unknown error',
        });
        this._log(
          `${proposal.action} tag ${proposal.tagId} "${proposal.tagName}": refused, ` +
            `${error?.message || 'unknown error'}.`
        );
      }
      done += 1;
      this._report(control, {
        phase: PHASES.APPLYING,
        pairsTotal: todo.length,
        pairsJudged: done,
      });
    };

    // Merges, then splits, then deletes, as sorted above. Inside a phase the
    // proposals run side by side, as many at once as the model requests do,
    // where that changes nothing: deletes always, merges unless one feeds
    // another, splits unless two touch the same document. A split reads the
    // type a document had for its undo; two at once would both read none,
    // and the second undo would put back nothing where the first set a type.
    const lanes = this._lanes();
    for (const action of ['merge', 'split', 'delete']) {
      if (stopped) break;
      const batch = todo.filter((proposal) => proposal.action === action);
      if (batch.length === 0) continue;
      if (action === 'split' && batch.length > 1) {
        this._report(control, {
          phase: PHASES.APPLYING,
          message: `Reading the documents of ${batch.length} splits…`,
        });
      }
      const strands = await this._applyStrands(action, batch);
      await runInLanes(strands, lanes, async (strand) => {
        for (const proposal of strand) await applyOne(proposal);
      });
    }

    const deleted = applied.filter(
      (entry) => entry.action === DELETE_ACTION
    ).length;
    if (applied.length > 0) {
      // A merge drops the caches itself; a split or a delete does not.
      mergeService.afterWrite('split');
    }
    this._log(
      `order applied: ${applied.length - deleted} split, ${merged.length} merged, ` +
        `${deleted} deleted, ${failed.length} failed, in ${(
          (Date.now() - startedAt) /
          1000
        ).toFixed(1)}s.`
    );
    return { applied, merged, failed, stopped };
  }

  /**
   * One merge of the order: the target is looked up by name in Paperless-ngx
   * (the proposal only remembers a name), and the merge service does the
   * rest, so the row in the log and its undo are the ones the Duplicates page
   * already knows.
   *
   * @returns {Promise<{tagId:number, tagName:string, targetId:number, targetName:string, logId:number|null, documentsUpdated:number}>}
   */
  /**
   * The proposals of one apply phase in strands: the proposals of a strand
   * run one after the other, strands run side by side. A delete is a strand
   * of its own. Merges are one strand when any of them feeds another (its
   * target is another one's source), else one each. Splits that share a
   * document share a strand, found by reading each split tag's documents;
   * a tag whose documents cannot be read gets a strand of its own and
   * reports the error when it is applied.
   *
   * @param {'merge'|'split'|'delete'} action
   * @param {object[]} batch - the proposals of that action, in apply order
   * @returns {Promise<object[][]>}
   */
  async _applyStrands(action, batch) {
    if (action === 'merge') {
      const sources = new Set(
        batch.map((proposal) => normalizedTagKey(proposal.tagName))
      );
      const chained = batch.some((proposal) =>
        sources.has(normalizedTagKey(String(proposal.mergeInto ?? '')))
      );
      return chained ? [batch] : batch.map((proposal) => [proposal]);
    }
    if (action !== 'split') return batch.map((proposal) => [proposal]);

    // Union-find over the documents: the root is always the earliest index,
    // so the strands keep the apply order among and within themselves.
    const parent = batch.map((_, index) => index);
    const find = (index) => {
      let root = index;
      while (parent[root] !== root) root = parent[root];
      parent[index] = root;
      return root;
    };
    const union = (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB)
        parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    };
    const firstWith = new Map();
    for (const [index, proposal] of batch.entries()) {
      let documentIds = [];
      try {
        documentIds = await paperlessService.getDocumentIdsByEntity(
          'tags',
          proposal.tagId
        );
      } catch {
        // _applyOne reads them again and refuses in its own words.
      }
      for (const id of documentIds) {
        const other = firstWith.get(Number(id));
        if (other == null) firstWith.set(Number(id), index);
        else union(other, index);
      }
    }
    const strands = new Map();
    for (const [index, proposal] of batch.entries()) {
      const root = find(index);
      if (!strands.has(root)) strands.set(root, []);
      strands.get(root).push(proposal);
    }
    return [...strands.values()];
  }

  async _applyMerge(proposal, context) {
    const name = String(proposal.mergeInto ?? '').trim();
    if (name === '') {
      throw this._refusal(
        'The proposal names no tag to merge into',
        proposal.tagName
      );
    }
    if (context.tags === null) {
      try {
        // One read for the run, shared by merges applied side by side.
        context.tagsLoading ||= context.mergeService.listEntities('tags');
        const loaded = await context.tagsLoading;
        if (context.tags === null) context.tags = loaded;
      } catch (error) {
        context.tagsLoading = null;
        throw this._refusal(
          `the tags could not be read: ${error?.message || 'unknown error'}`,
          proposal.tagName
        );
      }
    }
    const wanted = normalizedTagKey(name);
    const target =
      context.tags.find((entity) => String(entity.name) === name) ||
      context.tags.find((entity) => normalizedTagKey(entity.name) === wanted);
    if (!target) {
      throw this._refusal(
        `There is no tag called "${name}" in Paperless-ngx`,
        proposal.tagName
      );
    }
    if (Number(target.id) === Number(proposal.tagId)) {
      throw this._refusal(
        'A tag cannot be merged into itself',
        proposal.tagName
      );
    }

    const result = await context.mergeService.merge({
      kind: 'tags',
      targetId: Number(target.id),
      sourceIds: [Number(proposal.tagId)],
      performedBy: context.performedBy,
    });
    const source = (Array.isArray(result?.sources) ? result.sources : [])[0];
    if (!source || !source.deleted) {
      throw this._refusal(
        source?.error || 'The tag was not merged',
        proposal.tagName
      );
    }
    await documentModel.updateTagSplitProposal(proposal.tagId, {
      status: 'applied',
    });
    // The tag is gone; the next merge of this run must not find it again.
    context.tags = context.tags.filter(
      (entity) => Number(entity.id) !== Number(proposal.tagId)
    );
    this._log(
      `merged tag ${proposal.tagId} "${proposal.tagName}" into ` +
        `${target.id} "${target.name}": ${source.documentsMoved} document(s).`
    );
    return {
      tagId: Number(proposal.tagId),
      tagName: String(proposal.tagName ?? ''),
      targetId: Number(target.id),
      targetName: String(target.name ?? ''),
      logId: result?.mergeId ?? null,
      documentsUpdated: Number(source.documentsMoved) || 0,
    };
  }
}

const tagSimplifyService = new TagSimplifyService();
tagSimplifyService.DIMENSIONS = DIMENSIONS;
tagSimplifyService.PROPOSAL_SOURCES = PROPOSAL_SOURCES;
tagSimplifyService.PROPOSAL_STATUSES = PROPOSAL_STATUSES;
tagSimplifyService.PROPOSAL_ACTIONS = PROPOSAL_ACTIONS;
tagSimplifyService.GROUP_KINDS = GROUP_KINDS;
tagSimplifyService.GROUP_DECISIONS = GROUP_DECISIONS;
tagSimplifyService.SPLIT_ACTION = SPLIT_ACTION;
tagSimplifyService.DELETE_ACTION = DELETE_ACTION;
tagSimplifyService.MAX_APPLY_TAGS = MAX_APPLY_TAGS;
tagSimplifyService.SimplifyError = SimplifyError;
tagSimplifyService.PHASES = PHASES;

module.exports = tagSimplifyService;
