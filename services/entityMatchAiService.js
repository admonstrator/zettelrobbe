'use strict';

/**
 * AI review for the Duplicates page: the configured AI provider judges pairs
 * of tag or correspondent names the matcher is not sure about, on request.
 *
 * The vocabulary (verdicts, group sources), the shape of a verdict and the
 * two entry points are the contract the page and its route are built against.
 *
 * Design rules:
 * - Nothing runs on its own. A review happens when the user asks for one.
 * - The model never merges. It answers same / different / unsure per pair,
 *   with one short reason; the user decides.
 * - Every name the model returns is validated against the names it was
 *   given; anything else is dropped.
 * - The deterministic matcher stays the source of candidates. The model only
 *   sees pairs the matcher produced (groups and the wider candidate band).
 *
 * ## What the model is asked
 *
 * One request per batch of `batchSize()` pairs (25 by default), temperature 0,
 * a completion cap of TOKENS_PER_PAIR × pairs + TOKENS_OVERHEAD. The system
 * prompt states the job, the rules and the output contract; the user prompt
 * carries the kind and the batch as JSON, one pair per line:
 *
 *   {"id":"tags:12-48","a":{"name":"Rechnung","documents":31},"b":{...}}
 *
 * `titles` per entity is added when the caller asked for context; they are
 * the most recent document titles filed under that name.
 *
 * ## What comes back
 *
 * A JSON array of `{ id, verdict, reason }`. Everything else is treated as a
 * damaged answer rather than as an instruction: a code fence is stripped, the
 * text from the first `[` to the last `]` is parsed, an id that was not in
 * the batch is dropped, an unknown verdict becomes "unsure", a reason is cut
 * at REASON_MAX_LENGTH characters. A pair nobody answered is "unsure" too, so
 * the caller always gets exactly one verdict per pair it handed in. A batch
 * that fails (network error, unparseable answer) costs only its own pairs and
 * is counted in `usage.failedRequests`; the remaining batches still run.
 *
 * ## What it costs
 *
 * Per scan: the members of every group against their target, plus at most
 * CANDIDATE_LIMIT pairs from the band below the threshold, in batches of 25.
 * A 5000-tag archive with 400 groups therefore asks roughly 16 + 16 = 32
 * requests, no matter how large the archive is — the band is capped, the
 * groups are not, but they are few.
 */

const config = require('../config/config');
const entityNameMatcher = require('./entityNameMatcher');

const AI_VERDICTS = Object.freeze({
  SAME: 'same',
  DIFFERENT: 'different',
  UNSURE: 'unsure',
});
const AI_VERDICT_LIST = Object.freeze(Object.values(AI_VERDICTS));

/** Where a group in an AI review result came from. */
const GROUP_SOURCES = Object.freeze({
  SCAN: 'scan',
  AI_CANDIDATE: 'ai-candidate',
});

/** Completion budget per pair; a verdict plus twelve words is far less. */
const TOKENS_PER_PAIR = 60;
/** Room for the brackets and for a model that starts with a newline. */
const TOKENS_OVERHEAD = 100;
/** A reason longer than this is the model ignoring its instructions. */
const REASON_MAX_LENGTH = 200;
/** How many pairs of the candidate band one review looks at at most. */
const CANDIDATE_LIMIT = 400;
/** Document titles per entity handed to the model as context. */
const TITLE_LIMIT = 3;
/** Title reads in flight; the archive is somebody's server, not a benchmark. */
const TITLE_CONCURRENCY = 4;

/** Said about a pair the model left out of an otherwise sound answer. */
const NO_ANSWER_REASON = 'no answer from the model';
/** Said about a verdict that is not one of the three. */
const UNKNOWN_VERDICT_REASON = 'unrecognised verdict';

/**
 * @typedef {object} AiVerdict
 * @property {'same'|'different'|'unsure'} verdict
 * @property {string} reason   one short sentence from the model, '' when none
 */

/**
 * @typedef {object} AiReviewEntity
 * @property {number} id
 * @property {string} name
 * @property {number} [documentCount]
 * @property {string[]} [sampleTitles]  a few recent document titles for context
 */

/**
 * @typedef {object} AiReviewPair
 * @property {string} key     pairKey() of the two ids
 * @property {AiReviewEntity} a
 * @property {AiReviewEntity} b
 */

/**
 * @typedef {object} AiReviewUsage
 * @property {number} requests        model requests made
 * @property {number|null} tokens     total tokens when the provider reports them
 * @property {number} failedRequests  requests that answered nothing usable
 */

/**
 * @typedef {object} AiReviewPairsResult
 * @property {Map<string, AiVerdict>} verdicts   keyed by pair key; every pair gets one
 * @property {string|null} model
 * @property {AiReviewUsage} usage
 */

/**
 * @typedef {object} AiReviewOptions
 * @property {'tags'|'correspondents'|'all'} [kind]
 * @property {number} [threshold]
 * @property {boolean} [includeDismissed]
 * @property {boolean} [withTitles]   fetch a few document titles per entity as context
 */

/** What one kind is called in the prompt. */
const KIND_WORDS = Object.freeze({
  tags: {
    plural: 'tags',
    singular: 'tag',
    explanation:
      'A tag is a topic or a category documents are filed under, for example "Rechnung", "Invoice" or "Versicherung".',
  },
  correspondents: {
    plural: 'correspondents',
    singular: 'correspondent',
    explanation:
      'A correspondent is the sender of a document: a company, an authority or a person.',
  },
});

/**
 * Reduces the verdicts of a group's members (each judged against the target)
 * to one verdict for the group: any "different" wins, otherwise all "same"
 * is "same", otherwise "unsure". The reason is the first one that decided it.
 *
 * @param {Array<AiVerdict|null|undefined>} verdicts
 * @returns {AiVerdict}
 */
function aggregateVerdict(verdicts) {
  const list = (Array.isArray(verdicts) ? verdicts : []).filter(Boolean);
  if (list.length === 0) {
    return { verdict: AI_VERDICTS.UNSURE, reason: '' };
  }
  const different = list.find((v) => v.verdict === AI_VERDICTS.DIFFERENT);
  if (different) {
    return { verdict: AI_VERDICTS.DIFFERENT, reason: different.reason || '' };
  }
  if (list.every((v) => v.verdict === AI_VERDICTS.SAME)) {
    return { verdict: AI_VERDICTS.SAME, reason: list[0].reason || '' };
  }
  const unsure = list.find((v) => v.verdict === AI_VERDICTS.UNSURE);
  return { verdict: AI_VERDICTS.UNSURE, reason: unsure?.reason || '' };
}

/** Cuts a model's reason down to something a table cell can hold. */
function toReason(value) {
  if (value == null) return '';
  return String(value).trim().slice(0, REASON_MAX_LENGTH);
}

/** Splits a list into chunks of at most `size`. */
function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Runs `worker` over `items`, never more than `limit` at the same time. */
async function mapWithConcurrency(items, limit, worker) {
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
  for (let index = 0; index < Math.min(limit, items.length); index += 1) {
    runners.push(runner());
  }
  await Promise.all(runners);
  return results;
}

/**
 * The JSON array in a model's answer. Strips one code fence, then takes
 * everything between the first `[` and the last `]` — models like to explain
 * themselves before and after the thing they were asked for.
 *
 * @param {string} text
 * @returns {object[]}
 * @throws when there is nothing to parse
 */
function parseVerdictArray(text) {
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

class EntityMatchAiService {
  /**
   * Whether the page should offer the review at all: the setting is on and
   * an AI provider is configured.
   *
   * @returns {boolean}
   */
  isEnabled() {
    const runtimeConfig = require('../config/config');
    return (
      Boolean(runtimeConfig.duplicatesAiReview) &&
      Boolean(runtimeConfig.aiProvider)
    );
  }

  /**
   * The model name of the active provider, as the user configured it. Only
   * for the report on the page — nothing is decided by it.
   *
   * @returns {string|null}
   */
  modelName() {
    const runtimeConfig = require('../config/config');
    switch (runtimeConfig.aiProvider) {
      case 'ollama':
        return process.env.OLLAMA_MODEL || runtimeConfig.ollama?.model || null;
      case 'custom':
        return process.env.CUSTOM_MODEL || runtimeConfig.custom?.model || null;
      case 'azure':
        return (
          process.env.AZURE_DEPLOYMENT_NAME ||
          runtimeConfig.azure?.deploymentName ||
          null
        );
      default:
        return process.env.OPENAI_MODEL || runtimeConfig.openai?.model || null;
    }
  }

  /**
   * The provider service, or a refusal. A missing key is a configuration
   * problem, not a failed batch: it would fail every batch the same way.
   *
   * @returns {object}
   */
  _provider() {
    const AIServiceFactory = require('./aiServiceFactory');
    const service = AIServiceFactory.getService();
    if (!service || typeof service.generateText !== 'function') {
      throw this._unavailable('No AI provider is configured');
    }
    if (typeof service.initialize === 'function') {
      service.initialize();
    }
    if (!service.client) {
      throw this._unavailable(
        'The AI provider is not configured (API key or endpoint missing)'
      );
    }
    return service;
  }

  /** An error the route turns into 409: the review is not on offer. */
  _unavailable(message) {
    const error = new Error(message);
    error.status = 409;
    return error;
  }

  /**
   * What the model is told about its job. English, and the same for every
   * provider — the rules are what makes the answers comparable.
   *
   * @param {'tags'|'correspondents'} kind
   * @returns {string}
   */
  buildSystemPrompt(kind) {
    const words = KIND_WORDS[kind] || KIND_WORDS.tags;
    return [
      `You review pairs of ${words.plural} from one personal document archive (Paperless-ngx).`,
      words.explanation,
      `For every pair, decide whether the two names denote the same ${words.singular}.`,
      '',
      'Judge by meaning, not by how similar the spelling looks.',
      '',
      'Answer "same" when the two names are two spellings of one thing:',
      '- different case, spacing or punctuation ("Amazon" / "amazon")',
      '- umlauts written out or dropped ("Müller" / "Mueller" / "Muller")',
      '- one name carries a legal form and the other does not ("Telekom" / "Telekom GmbH", AG, Inc, Ltd, S.a.r.l.)',
      '- singular and plural of the same word ("Rechnung" / "Rechnungen", "Invoice" / "Invoices")',
      '- an abbreviation and the long form of the same name ("TK" / "Techniker Krankenkasse")',
      '- the German and the English name for the same thing ("Steuer" / "Tax")',
      '- an obvious typo of the same name ("Vodafone" / "Vodaphone")',
      '',
      'Answer "different" when the names denote two things an archive has to keep apart:',
      '- two companies, authorities or people, however alike the names read ("Deutsche Bank" / "Deutsche Bahn")',
      '- a topic and a narrower or neighbouring topic ("Rechnung" / "Rechnungswesen", "Miete" / "Mietvertrag")',
      '',
      'Answer "unsure" when you cannot decide from the names alone:',
      '- two legal entities of one company are "same" only when a person would file them under one name; otherwise "unsure"',
      '- the names could mean the same thing, but nothing in the pair settles it',
      '',
      'When document titles are given they are examples of what is filed under that name. Use them as evidence; they are never the answer.',
      '',
      'Answer with a JSON array and nothing else — no prose, no explanation, no code fence:',
      '[{"id": "<the id of the pair>", "verdict": "same" | "different" | "unsure", "reason": "<at most twelve words>"}]',
      'Answer every pair you were given exactly once, with the id copied as it was given.',
    ].join('\n');
  }

  /**
   * The batch itself: the kind, then one JSON object per pair. One line per
   * pair keeps it compact and still readable in a log.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {AiReviewPair[]} pairs
   * @returns {string}
   */
  buildUserPrompt(kind, pairs) {
    const words = KIND_WORDS[kind] || KIND_WORDS.tags;
    const describe = (entity) => {
      const described = {
        name: String(entity?.name ?? ''),
        documents: Number(entity?.documentCount) || 0,
      };
      const titles = (entity?.sampleTitles || [])
        .map((title) => String(title ?? '').trim())
        .filter(Boolean);
      if (titles.length > 0) described.titles = titles;
      return described;
    };
    const lines = pairs.map((pair) =>
      JSON.stringify({
        id: pair.key,
        a: describe(pair.a),
        b: describe(pair.b),
      })
    );
    return [
      `Kind: ${words.plural}`,
      `Pairs: ${pairs.length}`,
      '[',
      lines.join(',\n'),
      ']',
    ].join('\n');
  }

  /**
   * Asks the model about every pair and returns one verdict per pair.
   *
   * @param {AiReviewPair[]} pairs
   * @param {{kind:'tags'|'correspondents'}} options
   * @returns {Promise<AiReviewPairsResult>}
   */
  async reviewPairs(pairs, options = {}) {
    const kind = KIND_WORDS[options.kind]
      ? options.kind
      : entityNameMatcher.KINDS.TAGS;
    const list = (Array.isArray(pairs) ? pairs : []).filter(
      (pair) => pair && typeof pair.key === 'string' && pair.key !== ''
    );
    /** @type {Map<string, AiVerdict>} */
    const verdicts = new Map();
    const usage = { requests: 0, tokens: null, failedRequests: 0 };
    const model = this.modelName();
    if (list.length === 0) {
      return { verdicts, model, usage };
    }

    const service = this._provider();
    const systemPrompt = this.buildSystemPrompt(kind);

    for (const batch of chunk(list, this.batchSize())) {
      const keys = new Set(batch.map((pair) => pair.key));
      const failBatch = (message) => {
        usage.failedRequests += 1;
        const reason = toReason(message) || 'the request failed';
        for (const key of keys) {
          if (!verdicts.has(key)) {
            verdicts.set(key, { verdict: AI_VERDICTS.UNSURE, reason });
          }
        }
      };

      usage.requests += 1;
      let answer;
      try {
        answer = await service.generateText(this.buildUserPrompt(kind, batch), {
          systemPrompt,
          temperature: 0,
          maxTokens: TOKENS_PER_PAIR * batch.length + TOKENS_OVERHEAD,
        });
      } catch (error) {
        failBatch(error?.message || 'the AI provider could not be reached');
        continue;
      }

      const spent = Number(service.lastGenerateTextUsage?.totalTokens);
      if (Number.isFinite(spent)) {
        usage.tokens = (usage.tokens || 0) + spent;
      }

      let items;
      try {
        items = parseVerdictArray(answer);
      } catch (error) {
        failBatch(error?.message || 'the answer could not be read');
        continue;
      }

      for (const item of items) {
        const id = typeof item?.id === 'string' ? item.id.trim() : '';
        if (!keys.has(id) || verdicts.has(id)) continue;
        const verdict = String(item?.verdict ?? '')
          .trim()
          .toLowerCase();
        if (!AI_VERDICT_LIST.includes(verdict)) {
          verdicts.set(id, {
            verdict: AI_VERDICTS.UNSURE,
            reason: UNKNOWN_VERDICT_REASON,
          });
          continue;
        }
        verdicts.set(id, { verdict, reason: toReason(item?.reason) });
      }

      for (const key of keys) {
        if (!verdicts.has(key)) {
          verdicts.set(key, {
            verdict: AI_VERDICTS.UNSURE,
            reason: NO_ANSWER_REASON,
          });
        }
      }
    }

    return { verdicts, model, usage };
  }

  /**
   * The pairs of one scanned kind: every non-target member against its
   * group's target, plus the candidates from the band below the threshold
   * that are not already inside one group.
   *
   * @returns {{pairs: AiReviewPair[], candidates: AiReviewPair[], candidateEdges: Map<string, {score:number, reason:string}>}}
   */
  _pairsForKind(kind, groups, candidates) {
    /** @type {AiReviewPair[]} */
    const pairs = [];
    const insideOneGroup = new Set();

    for (const group of groups) {
      const target = group.members.find(
        (member) => member.id === group.suggestedTargetId
      );
      if (!target) continue;
      const ids = group.members.map((member) => member.id);
      for (const a of ids) {
        for (const b of ids) {
          if (a !== b)
            insideOneGroup.add(entityNameMatcher.pairKey(kind, a, b));
        }
      }
      for (const member of group.members) {
        if (member.id === target.id) continue;
        pairs.push({
          key: entityNameMatcher.pairKey(kind, target.id, member.id),
          a: target,
          b: member,
        });
      }
    }

    /** @type {AiReviewPair[]} */
    const candidatePairs = [];
    /** @type {Map<string, {score:number, reason:string}>} */
    const candidateEdges = new Map();
    for (const candidate of candidates) {
      if (insideOneGroup.has(candidate.key)) continue;
      candidatePairs.push({
        key: candidate.key,
        a: candidate.a,
        b: candidate.b,
      });
      candidateEdges.set(candidate.key, {
        score: candidate.score,
        reason: candidate.reason,
      });
    }

    return {
      pairs: [...pairs, ...candidatePairs],
      candidates: candidatePairs,
      candidateEdges,
    };
  }

  /**
   * Adds a few recent document titles to every entity the pairs name. The
   * pairs are rewritten rather than the entities, so nothing the scan
   * returned is touched.
   */
  async _addTitles(kind, pairs) {
    const paperlessService = require('./paperlessService');
    if (
      typeof paperlessService.getRecentDocumentTitlesByEntity !== 'function'
    ) {
      return pairs;
    }
    const ids = [
      ...new Set(pairs.flatMap((pair) => [pair.a.id, pair.b.id])),
    ].filter((id) => Number.isInteger(Number(id)));

    const titles = new Map();
    const fetched = await mapWithConcurrency(
      ids,
      TITLE_CONCURRENCY,
      async (id) => {
        try {
          return await paperlessService.getRecentDocumentTitlesByEntity(
            kind,
            id,
            TITLE_LIMIT
          );
        } catch {
          // Context is a nicety; a review must not fail over it.
          return [];
        }
      }
    );
    ids.forEach((id, index) => {
      const list = Array.isArray(fetched[index]) ? fetched[index] : [];
      if (list.length > 0) titles.set(Number(id), list);
    });

    const withTitles = (entity) => {
      const list = titles.get(Number(entity.id));
      return list ? { ...entity, sampleTitles: list } : entity;
    };
    return pairs.map((pair) => ({
      ...pair,
      a: withTitles(pair.a),
      b: withTitles(pair.b),
    }));
  }

  /**
   * Runs a scan, adds the wider candidate band, has the model judge every
   * pair (group members against their target, and the candidates) and
   * returns the scan result with verdicts attached.
   *
   * @param {AiReviewOptions} options
   * @returns {Promise<object>} DuplicateAiReviewResult (see schemas.js)
   */
  async reviewScan(options = {}) {
    if (!this.isEnabled()) {
      throw this._unavailable(
        'The AI review is switched off (DUPLICATES_AI_REVIEW)'
      );
    }
    const duplicateMergeService = require('./duplicateMergeService');
    const paperlessService = require('./paperlessService');
    const documentModel = require('../models/document');

    const scan = await duplicateMergeService.scan(options);
    const requested = options.kind || 'all';
    const kinds =
      requested === 'all' ? [...entityNameMatcher.KIND_LIST] : [requested];
    const configuredTagNames =
      typeof duplicateMergeService._configuredTagNames === 'function'
        ? duplicateMergeService._configuredTagNames()
        : [];

    const scanGroups = [];
    const candidateGroups = [];
    let judged = 0;
    let candidateCount = 0;
    let requests = 0;
    let failedRequests = 0;
    let tokens = null;
    let model = this.modelName();

    for (const kind of kinds) {
      const groups = (scan.groups || []).filter((group) => group.kind === kind);
      const entities = await paperlessService.listEntities(kind);

      let dismissed = [];
      if (!options.includeDismissed) {
        const rows = await documentModel.listEntityMergeDismissals(kind);
        dismissed = rows.map((row) =>
          entityNameMatcher.pairKey(kind, row.idA, row.idB)
        );
      }

      const band = entityNameMatcher.findCandidatePairs(entities, {
        kind,
        floor: this.candidateFloor(),
        threshold: scan.threshold,
        dismissedPairs: dismissed,
        limit: CANDIDATE_LIMIT,
      });

      const { pairs, candidates, candidateEdges } = this._pairsForKind(
        kind,
        groups,
        band
      );
      candidateCount += candidates.length;
      judged += pairs.length;
      if (pairs.length === 0) {
        scanGroups.push(
          ...groups.map((group) => this._withVerdicts(group, new Map()))
        );
        continue;
      }

      const asked =
        options.withTitles === false
          ? pairs
          : await this._addTitles(kind, pairs);
      const review = await this.reviewPairs(asked, { kind });
      requests += review.usage.requests;
      failedRequests += review.usage.failedRequests;
      if (review.usage.tokens != null) {
        tokens = (tokens || 0) + review.usage.tokens;
      }
      model = review.model || model;

      scanGroups.push(
        ...groups.map((group) => this._withVerdicts(group, review.verdicts))
      );

      const accepted = [];
      for (const candidate of candidates) {
        const verdict = review.verdicts.get(candidate.key);
        if (verdict?.verdict !== AI_VERDICTS.SAME) continue;
        const edge = candidateEdges.get(candidate.key);
        accepted.push({
          key: candidate.key,
          score: edge?.score ?? 0,
          reason: edge?.reason ?? null,
        });
      }
      if (accepted.length > 0) {
        const built = entityNameMatcher.buildGroupsFromEdges(
          kind,
          entities,
          accepted,
          {
            configuredTagNames:
              kind === entityNameMatcher.KINDS.TAGS ? configuredTagNames : [],
          }
        );
        candidateGroups.push(
          ...built.map((group) =>
            this._withVerdicts(
              group,
              review.verdicts,
              GROUP_SOURCES.AI_CANDIDATE
            )
          )
        );
      }
    }

    candidateGroups.sort(
      (x, y) =>
        y.confidence - x.confidence || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
    );

    return {
      ...scan,
      groups: [...scanGroups, ...candidateGroups],
      aiReview: {
        enabled: true,
        model,
        requests,
        tokens,
        judged,
        candidates: candidateCount,
        failedRequests,
      },
    };
  }

  /**
   * Copies a group with the verdict of every member against its target and
   * the aggregated verdict of the group.
   */
  _withVerdicts(group, verdicts, source = GROUP_SOURCES.SCAN) {
    const memberVerdicts = [];
    const members = (group.members || []).map((member) => {
      if (member.id === group.suggestedTargetId) {
        return { ...member, aiVerdict: null };
      }
      const verdict =
        verdicts.get(
          entityNameMatcher.pairKey(
            group.kind,
            group.suggestedTargetId,
            member.id
          )
        ) || null;
      if (verdict) memberVerdicts.push(verdict);
      return { ...member, aiVerdict: verdict };
    });
    return {
      ...group,
      source,
      aiVerdict:
        memberVerdicts.length > 0 ? aggregateVerdict(memberVerdicts) : null,
      members,
    };
  }
}

const entityMatchAiService = new EntityMatchAiService();
entityMatchAiService.AI_VERDICTS = AI_VERDICTS;
entityMatchAiService.AI_VERDICT_LIST = AI_VERDICT_LIST;
entityMatchAiService.GROUP_SOURCES = GROUP_SOURCES;
entityMatchAiService.CANDIDATE_LIMIT = CANDIDATE_LIMIT;
entityMatchAiService.TOKENS_PER_PAIR = TOKENS_PER_PAIR;
entityMatchAiService.TOKENS_OVERHEAD = TOKENS_OVERHEAD;
entityMatchAiService.REASON_MAX_LENGTH = REASON_MAX_LENGTH;
entityMatchAiService.aggregateVerdict = aggregateVerdict;
entityMatchAiService.batchSize = () => {
  const size = Number(config.duplicatesAiReviewBatchSize);
  return Number.isInteger(size) && size > 0 ? size : 25;
};
entityMatchAiService.candidateFloor = () => {
  const floor = Number(config.duplicatesAiCandidateFloor);
  return Number.isFinite(floor) && floor > 0 && floor < 1 ? floor : 0.6;
};

module.exports = entityMatchAiService;
