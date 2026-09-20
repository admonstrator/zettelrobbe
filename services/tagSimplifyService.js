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

/** The two dimensions a vocabulary entry can belong to. */
const DIMENSIONS = Object.freeze({ TYPE: 'type', TOPIC: 'topic' });
/** Where a proposal came from. */
const PROPOSAL_SOURCES = Object.freeze(['rule', 'model', 'user']);
/** What a proposal can be. */
const PROPOSAL_STATUSES = Object.freeze(['open', 'applied', 'skipped']);
/** The log action of a split, shared with duplicateMergeService and the page. */
const SPLIT_ACTION = 'split';
/** Proposals one apply call may take. */
const MAX_APPLY_TAGS = 200;
/** Prefix of every line this service writes to the app log. */
const LOG_PREFIX = '[SIMPLIFY]';

/**
 * The phases the two long-running tasks report, the same strings
 * duplicateReviewJobService.PHASES holds for them. Kept here so the service
 * does not have to require the job it runs inside.
 */
const PHASES = Object.freeze({
  VOCABULARY: 'vocabulary',
  SPLITTING: 'splitting',
});

/** Fewest tag names one vocabulary request reads, whatever the setting says. */
const MIN_VOCABULARY_NAMES_PER_REQUEST = 50;
/** Completion tokens one decomposed tag is worth. */
const TOKENS_PER_TAG = 60;
/** Smallest completion cap any request is sent with. */
const MIN_COMPLETION_CAP = 160;
/** How often a cut-off answer may be asked again with a raised cap. */
const MAX_CAP_RAISES = 1;
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
    void options;
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

    for (let index = 0; index < chunks.length; index += 1) {
      if (this._stopped(control)) break;
      this._report(control, {
        phase: PHASES.VOCABULARY,
        message: `Reading ${names.length} tag names for a vocabulary, request ${
          index + 1
        } of ${chunks.length}…`,
        requestsDone: usage.requests,
        requestsPlanned: chunks.length,
        tokens: usage.tokens,
      });
      const proposed = await this._vocabularyChunk(
        service,
        systemPrompt,
        chunks[index],
        size,
        usage,
        control
      );
      for (const dimension of ['types', 'topics']) {
        for (const name of proposed[dimension]) {
          this._vote(votes[dimension], name);
        }
      }
      this._report(control, {
        phase: PHASES.VOCABULARY,
        requestsDone: usage.requests,
        requestsPlanned: chunks.length,
        tokens: usage.tokens,
        failedRequests: usage.failedRequests,
      });
      this._checkTokenBudget(control, usage);
    }

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
  async _vocabularyChunk(service, systemPrompt, names, size, usage, control) {
    const userPrompt = this.buildNameListPrompt(names);
    const cap = Math.max(MIN_COMPLETION_CAP, size * 16);
    usage.requests += 1;
    const head = () => `vocabulary: ${names.length} name(s), cap ${cap}`;

    let answer;
    try {
      answer = await service.generateText(
        userPrompt,
        this._requestOptions(systemPrompt, cap, control)
      );
    } catch (error) {
      if (this._stopped(control)) return { types: [], topics: [] };
      if (error?.code === TRUNCATION_ERROR_CODE) {
        answer = this._partialAnswerOf(error);
      } else {
        usage.failedRequests += 1;
        console.warn(
          `${LOG_PREFIX} ${head()} — failed: ${
            error?.message || 'the AI provider could not be reached'
          }.`
        );
        return { types: [], topics: [] };
      }
    }

    await this._countTokens(
      service,
      usage,
      `${systemPrompt}\n${userPrompt}`,
      answer
    );

    let parsed;
    try {
      parsed = parseJsonObject(answer);
    } catch (error) {
      usage.failedRequests += 1;
      console.warn(
        `${LOG_PREFIX} ${head()} — failed: ${error.message}. Raw answer: ` +
          `${String(answer ?? '').slice(0, RAW_ANSWER_LOG_LENGTH) || '(none)'}`
      );
      return { types: [], topics: [] };
    }

    const asNames = (value) =>
      (Array.isArray(value) ? value : [])
        .map((name) => String(name ?? '').trim())
        .filter((name) => name !== '' && name.length <= 128);
    return { types: asNames(parsed.types), topics: asNames(parsed.topics) };
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
      '',
      'Answer with a JSON array and nothing else — no prose, no explanation, no code fence:',
      '[{"id": "12", "type": "Rechnung", "topics": ["Strom"], "confidence": "high", "reason": "<at most twelve words>"}]',
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
      for (let index = 0; index < chunks.length; index += 1) {
        if (this._stopped(control)) break;
        this._report(control, {
          phase: PHASES.SPLITTING,
          message: this._splitMessage(
            settledByRule,
            candidates.length,
            unsettled.length,
            chunks.length,
            index + 1
          ),
          requestsDone: usage.requests,
          requestsPlanned: chunks.length,
          tokens: usage.tokens,
        });
        const answered = await this._splitChunk(
          service,
          systemPrompt,
          chunks[index],
          vocabulary,
          usage,
          control
        );
        for (const row of answered) {
          proposals.set(row.tagId, row);
        }
        this._report(control, {
          phase: PHASES.SPLITTING,
          requestsDone: usage.requests,
          requestsPlanned: chunks.length,
          pairsJudged: proposals.size,
          tokens: usage.tokens,
          failedRequests: usage.failedRequests,
        });
        this._checkTokenBudget(control, usage);
      }
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
   * @returns {Promise<object[]>} TagSplitProposal rows
   */
  async _splitChunk(
    service,
    systemPrompt,
    tags,
    vocabulary,
    usage,
    control,
    { cap: wanted = null, raises = 0 } = {}
  ) {
    const userPrompt = this.buildSplitUserPrompt(tags);
    const cap =
      wanted == null
        ? Math.max(MIN_COMPLETION_CAP, tags.length * TOKENS_PER_TAG)
        : wanted;
    usage.requests += 1;
    const head = () => `splits: ${tags.length} tag(s), cap ${cap}`;

    let answer;
    let truncated = false;
    try {
      answer = await service.generateText(
        userPrompt,
        this._requestOptions(systemPrompt, cap, control, () => {})
      );
    } catch (error) {
      if (this._stopped(control)) return [];
      if (error?.code !== TRUNCATION_ERROR_CODE) {
        usage.failedRequests += 1;
        console.warn(
          `${LOG_PREFIX} ${head()} — failed: ${
            error?.message || 'the AI provider could not be reached'
          }.`
        );
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
      if (salvaged.length === 0 && truncated && raises < MAX_CAP_RAISES) {
        this._log(
          `${head()} — the answer hit the token limit and salvaged nothing, ` +
            `raising the cap to ${cap * 2} and reading the same tags again.`
        );
        return this._splitChunk(
          service,
          systemPrompt,
          tags,
          vocabulary,
          usage,
          control,
          { cap: cap * 2, raises: raises + 1 }
        );
      }
      if (salvaged.length === 0) {
        usage.failedRequests += 1;
        console.warn(
          `${LOG_PREFIX} ${head()} — failed: ${
            truncated
              ? 'the answer was cut off with nothing usable in it'
              : parseError?.message || 'the answer could not be read'
          }. Raw answer: ${
            String(answer ?? '').slice(0, RAW_ANSWER_LOG_LENGTH) || '(none)'
          }`
        );
        return [];
      }
      this._log(
        `${head()} — the answer was cut off, salvaged ${salvaged.length} proposal(s).`
      );
      items = salvaged;
    }

    return this._modelProposals(items, tags, vocabulary);
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
      if (patch.status !== 'open' && patch.status !== 'skipped') {
        throw new SimplifyError('status must be open or skipped', 400);
      }
      next.status = patch.status;
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
   * @returns {Promise<{tagId:number, documents:number, withType:number, withDifferentType:number, typeId:number|null}>}
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
      return {
        tagId: id,
        documents: documents.length,
        withType,
        withDifferentType,
        typeId,
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
   * @returns {Promise<object>} one entry of TagSplitApplyResult.applied
   */
  async _applyOne(tagId, context) {
    const { performedBy, configuredTagNames, vocabulary, mergeService } =
      context;
    const proposal = await documentModel.getTagSplitProposal(tagId);
    if (!proposal) {
      throw this._refusal(`There is no proposal for tag ${tagId}`);
    }
    if (proposal.status !== 'open') {
      throw this._refusal(
        proposal.status === 'applied'
          ? 'This proposal was already applied'
          : 'This proposal is not open',
        proposal.tagName
      );
    }
    if (!proposal.typeName && proposal.topicNames.length === 0) {
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
    if (proposal.typeName) {
      try {
        const existing = await paperlessService.findDocumentTypeByExactName(
          proposal.typeName
        );
        if (existing) {
          typeId = Number(existing.id);
        } else {
          const created = await paperlessService.createDocumentType(
            proposal.typeName
          );
          typeId = Number(created?.id);
          createdTypeId = typeId;
        }
      } catch (error) {
        throw this._refusal(
          `the document type "${proposal.typeName}" could not be prepared: ${
            error?.message || 'unknown error'
          }`,
          tagName
        );
      }
      if (!Number.isInteger(typeId)) {
        throw this._refusal(
          `Paperless-ngx did not return an id for the document type "${proposal.typeName}"`,
          tagName
        );
      }
      await this._rememberVocabularyId(
        DIMENSIONS.TYPE,
        proposal.typeName,
        typeId,
        vocabulary
      );
    }

    const topicTagIds = [];
    const createdTagIds = [];
    for (const topicName of proposal.topicNames) {
      let id;
      try {
        id = await this._topicTagId(topicName, vocabulary, createdTagIds);
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
      typeName: proposal.typeName ?? null,
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

    const targetName = [proposal.typeName, ...proposal.topicNames]
      .filter(Boolean)
      .join(' + ');
    const status = deleted ? 'done' : 'partial';
    const logId = await documentModel.addEntityMerge({
      kind: 'tags',
      // A split has no survivor; the row is about the tag it took apart.
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
      action: SPLIT_ACTION,
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
      `split tag ${tagId} "${tagName}": ${documents.length} document(s)` +
        (proposal.typeName
          ? ` → type "${proposal.typeName}" (${typeSetIds.length} set, ${typeKept} kept)`
          : ' → no document type') +
        `, tags ${proposal.topicNames.join(', ') || '(none)'}; ` +
        `${deleted ? 'tag deleted' : 'tag kept'}.`
    );

    return {
      tagId: Number(tagId),
      tagName,
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
}

const tagSimplifyService = new TagSimplifyService();
tagSimplifyService.DIMENSIONS = DIMENSIONS;
tagSimplifyService.PROPOSAL_SOURCES = PROPOSAL_SOURCES;
tagSimplifyService.PROPOSAL_STATUSES = PROPOSAL_STATUSES;
tagSimplifyService.SPLIT_ACTION = SPLIT_ACTION;
tagSimplifyService.MAX_APPLY_TAGS = MAX_APPLY_TAGS;
tagSimplifyService.SimplifyError = SimplifyError;
tagSimplifyService.PHASES = PHASES;

module.exports = tagSimplifyService;
