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
 *   {"id":"tags:12-48","matched_by":"fuzzy","score":0.91,
 *    "a":{"name":"Kontoauszug","documents":31,"titles":[...],
 *         "filed_with":["Sparkasse"],"rule":{...},"excerpts":["..."]},"b":{...}}
 *
 * ## Evidence, and what it costs
 *
 * The user ran into "Kontoauszug" next to "Kontoumzug": one letter apart, two
 * different things, and a model that sees two names and three titles says
 * "same". So a pair now carries how the matcher linked it, and the evidence
 * is graded by how much the link is worth:
 *
 * - `matched_by` and `score` on every pair. "fuzzy", "prefix" and
 *   "token-order" mean nothing but spelling links the two names; the system
 *   prompt tells the model to treat those as different unless the evidence
 *   says otherwise.
 * - `titles` and `filed_with` per entity for every judged pair (`withTitles`):
 *   the recent document titles, and who the entity is usually filed with —
 *   the correspondents of a tag's documents, the tags of a correspondent's.
 * - `excerpts` only for the spelling-only pairs (`withExcerpts`,
 *   DUPLICATES_AI_EXCERPTS): the first DUPLICATES_AI_EXCERPT_CHARS characters
 *   of DUPLICATES_AI_EXCERPT_DOCUMENTS recent documents. One read per entity
 *   per review, and never for a pair a strong tier produced.
 * - a pair the model still calls "unsure" and that had no excerpts is asked
 *   once more, with them (`aiReview.escalated`).
 *
 * The other half of the budget is not spending it at all: a member pair the
 * matcher settled by a rule — same but for case, umlauts or a legal form —
 * never reaches the provider. It gets `source: 'spelling-rule'` and counts in
 * `aiReview.spellingRules`, not in `judged`.
 *
 * The judge may run on its own model (DUPLICATES_AI_MODEL): a review is a
 * different job from writing a title, and a few hundred pairs are a different
 * bill.
 *
 * ## The token limit, which is what a real archive runs into
 *
 * The first version sized its batches by count alone and every batch of a
 * 4000-tag archive died of the completion limit, so every pair came back
 * "unsure". Three things keep that from happening now:
 *
 * 1. The budget is per pair and generous: a JSON object with a long id and a
 *    twelve-word reason costs 60 to 90 tokens once a model pretty-prints it.
 * 2. Before the first request a batch is *sized against the context window*:
 *    the prompt of a batch is measured with calculateTokens() and the batch is
 *    halved until prompt + completion cap + TOKENS_CONTEXT_MARGIN fits into
 *    TOKEN_LIMIT. `batchSize()` is only the upper bound. This matters most for
 *    a local model with a small window, and for the custom provider, which
 *    clamps the cap to what is left of the window and would otherwise hand the
 *    model a budget too small for the batch it is looking at.
 * 3. If the answer is cut off anyway — OpenAI, Azure and the custom provider
 *    raise `ai_response_truncated`, Ollama simply returns a half-written array
 *    — whatever complete objects the answer already carries are salvaged and
 *    only the pairs still missing are asked again, as two halves, recursively
 *    down to a single pair. A single pair that still does not fit is the one
 *    case that ends in "unsure". These retries are counted in `usage.retries`;
 *    they are not failures.
 *
 * ## What comes back
 *
 * A JSON array of `{ id, verdict, basis, confidence, reason }`, where `basis`
 * is the rule the model says it applied and `confidence` is how sure it is
 * (the page's AI proposal pre-ticks only "same" with "high"). An unknown
 * basis or confidence becomes null rather than an argument.
 * Everything else is treated as a
 * damaged answer rather than as an instruction: a code fence is stripped, the
 * text from the first `[` to the last `]` is parsed, an id that was not in
 * the batch is dropped, an unknown verdict becomes "unsure", a reason is cut
 * at REASON_MAX_LENGTH characters. A pair nobody answered is "unsure" too, so
 * the caller always gets exactly one verdict per pair it handed in. A batch
 * that fails for any other reason (network error, an answer with nothing
 * usable in it) costs only its own pairs and is counted in
 * `usage.failedRequests`; the remaining batches still run.
 *
 * ## What it says while it works
 *
 * Every line goes to the app log with the prefix [AI-REVIEW]: what a review
 * was asked to judge, the batch size it settled on, one line per request with
 * its numbers, and the totals. Names of tags and correspondents appear there
 * because they are what the operator is looking at; document titles never do,
 * because they are content.
 *
 * ## What it costs
 *
 * Per scan: the members of every group against their target, plus at most
 * CANDIDATE_LIMIT pairs from the band below the threshold, in batches of up to
 * 25. A 5000-tag archive with 400 groups therefore asks roughly 16 + 16 = 32
 * requests, no matter how large the archive is — the band is capped, the
 * groups are not, but they are few. A small context window buys more, smaller
 * requests for the same pairs; a truncation adds one request per split.
 *
 * ## Asking about a few groups only
 *
 * An archive with hundreds of correspondents produces dozens of groups at 94,
 * 95, 96 per cent, and the user wants the model's opinion on a handful of them
 * before merging, not on all of them. `reviewScan()` therefore takes three
 * options that narrow what is asked: `groupIds` (the scan groups to judge),
 * `minConfidence` (judge nothing below it) and `includeCandidates: false` (no
 * band at all, which also saves the entity read per kind). They narrow the
 * question, never the answer: every group of the scan comes back, the ones
 * nobody asked about with `aiVerdict: null`, so the page keeps its list. A
 * dozen selected groups without the band are one or two requests.
 */

const config = require('../config/config');
const entityNameMatcher = require('./entityNameMatcher');
const { calculateTokens } = require('./serviceUtils');

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

/**
 * Completion budget per pair. A verdict with a twelve-word reason is 60 to 90
 * tokens once the model adds whitespace and repeats the id, so this is roughly
 * double what an obedient answer needs — the cheap side of the trade, because
 * the expensive side is a whole batch coming back unusable.
 */
const TOKENS_PER_PAIR = 120;
/** Room for the brackets, a code fence and a model that explains itself. */
const TOKENS_OVERHEAD = 200;
/**
 * What is left free in the context window after prompt and completion cap.
 * The estimate is an estimate (÷4 characters for every non-OpenAI model), and
 * the providers add a few tokens of their own message framing.
 */
const TOKENS_CONTEXT_MARGIN = 256;
/**
 * The code serviceUtils.assertCompletionNotTruncated() raises, and with it
 * OpenAI, Azure and the custom provider. Ollama's generateText() has no such
 * check: it returns the half-written answer, which arrives here as an array
 * that does not parse and is salvaged the same way.
 */
const TRUNCATION_ERROR_CODE = 'ai_response_truncated';
/** A reason longer than this is the model ignoring its instructions. */
const REASON_MAX_LENGTH = 200;
/** How many pairs of the candidate band one review looks at at most. */
const CANDIDATE_LIMIT = 400;
/** Document titles per entity handed to the model as context. */
const TITLE_LIMIT = 3;
/** Title reads in flight; the archive is somebody's server, not a benchmark. */
const TITLE_CONCURRENCY = 4;
/** Excerpt reads in flight; one read per entity, so the same budget as above. */
const EXCERPT_CONCURRENCY = 4;
/** Documents one neighbourhood read looks at. */
const NEIGHBOUR_DOCUMENTS = 30;
/** Neighbour names per entity handed to the model, most frequent first. */
const NEIGHBOUR_LIMIT = 3;

/**
 * The matcher reasons that say nothing but "these two strings look alike".
 * A pair linked by one of them is the case the user ran into — "Kontoauszug"
 * next to "Kontoumzug" — and the only case worth paying for document
 * excerpts: the strong tiers (exact, umlaut, legal form, plural) already
 * carry a reason a person can check by reading the two names.
 */
const SPELLING_ONLY_REASONS = Object.freeze([
  entityNameMatcher.MATCH_REASONS.FUZZY,
  entityNameMatcher.MATCH_REASONS.PREFIX,
  entityNameMatcher.MATCH_REASONS.TOKEN_ORDER,
]);
const SPELLING_ONLY_REASON_SET = new Set(SPELLING_ONLY_REASONS);

/** Where a verdict came from. */
const VERDICT_SOURCES = Object.freeze({
  MODEL: 'model',
  SPELLING_RULE: 'spelling-rule',
});

/**
 * The matcher tiers a rule settles on its own, and the basis each one stands
 * for. "Amazon" / "amazon", "Müller" / "Mueller" and "Telekom" / "Telekom
 * GmbH" are the same thing by a rule anybody can check; asking a model about
 * them buys nothing and costs a request per pair. These pairs never reach the
 * provider — they get their verdict here, marked as what it is.
 */
const SETTLED_REASON_BASES = Object.freeze({
  [entityNameMatcher.MATCH_REASONS.EXACT]: 'case-or-spacing',
  [entityNameMatcher.MATCH_REASONS.UMLAUT]: 'umlaut',
  [entityNameMatcher.MATCH_REASONS.LEGAL_FORM]: 'legal-form',
});

/**
 * The rule the model says it applied. A closed list, because the page renders
 * it and the AI proposal decides on it; anything else becomes null.
 */
const VERDICT_BASES = Object.freeze([
  'case-or-spacing',
  'umlaut',
  'legal-form',
  'plural',
  'abbreviation',
  'translation',
  'synonym',
  'typo',
  'different-thing',
  'different-topic',
  'insufficient-evidence',
]);
const VERDICT_BASIS_SET = new Set(VERDICT_BASES);

/** How sure the model says it is. The proposal pre-ticks "same" + "high". */
const CONFIDENCE_LEVELS = Object.freeze(['high', 'low']);
const CONFIDENCE_SET = new Set(CONFIDENCE_LEVELS);

/** Paperless-ngx `matching_algorithm` values, as words for the prompt. */
const MATCHING_ALGORITHM_WORDS = Object.freeze({
  1: 'any',
  2: 'all',
  3: 'literal',
  4: 'regex',
  5: 'fuzzy',
  6: 'auto',
});

/** Said about a pair the model left out of an otherwise sound answer. */
const NO_ANSWER_REASON = 'no answer from the model';
/** Said about a verdict that is not one of the three. */
const UNKNOWN_VERDICT_REASON = 'unrecognised verdict';
/** Said about the one pair that does not fit even on its own. */
const SINGLE_PAIR_TRUNCATION_REASON =
  "the model's answer exceeded the token limit even for one pair";

/** Prefix of every line this service writes to the app log. */
const LOG_PREFIX = '[AI-REVIEW]';
/** How much of a damaged answer a warning shows. */
const RAW_ANSWER_LOG_LENGTH = 200;

/**
 * @typedef {object} AiVerdict
 * @property {'same'|'different'|'unsure'} verdict
 * @property {string} reason   one short sentence from the model, '' when none
 * @property {string|null} basis  a VERDICT_BASES value, null when the model
 *   named none or named something else (an older model, another provider)
 * @property {'high'|'low'|null} confidence  how sure the model says it is
 * @property {'model'|'spelling-rule'} source  who decided: the provider, or a
 *   matcher tier a rule settles without asking anybody
 */

/**
 * @typedef {object} AiReviewEntity
 * @property {number} id
 * @property {string} name
 * @property {number} [documentCount]
 * @property {number} [matchingAlgorithm]  Paperless-ngx matching rule, 0 = none
 * @property {string} [match]              the rule's expression
 * @property {string[]} [sampleTitles]     a few recent document titles for context
 * @property {string[]} [neighbourNames]   who this entity is usually filed with:
 *   the most frequent correspondents of a tag, the most frequent tags of a
 *   correspondent
 * @property {string[]} [sampleExcerpts]   the beginning of a few documents,
 *   only fetched for pairs the matcher linked by spelling alone
 */

/**
 * @typedef {object} AiReviewPair
 * @property {string} key     pairKey() of the two ids
 * @property {AiReviewEntity} a
 * @property {AiReviewEntity} b
 * @property {string|null} [matchedBy]  the MATCH_REASONS value of the edge
 * @property {number} [score]           the matcher score of the edge
 */

/**
 * @typedef {object} AiReviewUsage
 * @property {number} requests        model requests made, retries included
 * @property {number|null} tokens     total tokens when the provider reports them
 * @property {number} failedRequests  requests that answered nothing usable
 * @property {number} retries         requests made because an answer was cut off
 * @property {number} batchSize       pairs per request after the budget sizing
 */

/**
 * What reviewScan() reports about the review itself; the page shows it and
 * schemas.js spells it as DuplicateAiReviewSummary.
 *
 * @typedef {object} AiReviewSummary
 * @property {boolean} enabled
 * @property {string|null} model
 * @property {number} requests        model requests made, retries included
 * @property {number|null} tokens     total tokens when the provider reports them
 * @property {number} judged          pairs handed to the model
 * @property {number} candidates      pairs from the band below the threshold
 * @property {number} failedRequests  requests that answered nothing usable
 * @property {number} retries         requests made because an answer was cut off
 * @property {number} batchSize       pairs per request after the budget sizing
 * @property {boolean} targeted       true when groupIds, minConfidence or
 *                                    includeCandidates narrowed the review
 * @property {number} groupsJudged    scan groups whose members were judged
 * @property {number} groupsSkipped   scan groups the targeting left out; they
 *                                    are still in `groups`, without a verdict
 * @property {number} excerpts        entities that carried document excerpts
 *                                    into a prompt
 * @property {number} spellingRules   pairs a matcher rule settled, so the
 *                                    model was never asked about them
 * @property {number} escalated       unsure pairs that were asked a second
 *                                    time, with excerpts
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
 * @property {boolean} [withExcerpts] default true; fetch the beginning of a few
 *   documents per entity for the pairs the matcher linked by spelling alone.
 *   DUPLICATES_AI_EXCERPTS switches the same evidence off instance-wide.
 * @property {string[]} [groupIds]    judge only these scan groups, by the id
 *   findDuplicateGroups() gave them; every other group comes back unchanged.
 *   An id this scan does not know is ignored.
 * @property {number} [minConfidence] judge only groups scoring at least this;
 *   with groupIds both have to hold
 * @property {boolean} [includeCandidates] default true; false leaves the band
 *   of near-misses below the threshold out of the review entirely
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
 * The confidence of a set of verdicts that agree: "low" as soon as one of
 * them is low, "high" when at least one says so and none says low, null when
 * none of them named a confidence at all.
 *
 * @param {AiVerdict[]} deciding
 * @returns {'high'|'low'|null}
 */
function combineConfidence(deciding) {
  const named = deciding
    .map((verdict) => verdict.confidence)
    .filter((value) => CONFIDENCE_SET.has(value));
  if (named.length === 0) return null;
  return named.includes('low') ? 'low' : 'high';
}

/**
 * Reduces the verdicts of a group's members (each judged against the target)
 * to one verdict for the group: any "different" wins, otherwise all "same"
 * is "same", otherwise "unsure". Reason and basis come from the first member
 * that decided it; the confidence is the weakest of the deciding members, so
 * one "low" among them makes the group low.
 *
 * @param {Array<AiVerdict|null|undefined>} verdicts
 * @returns {AiVerdict}
 */
function aggregateVerdict(verdicts) {
  const list = (Array.isArray(verdicts) ? verdicts : []).filter(Boolean);
  if (list.length === 0) {
    return {
      verdict: AI_VERDICTS.UNSURE,
      reason: '',
      basis: null,
      confidence: null,
      source: VERDICT_SOURCES.MODEL,
    };
  }
  const decide = (verdict) => {
    const deciding = list.filter((entry) => entry.verdict === verdict);
    return {
      verdict,
      reason: deciding[0]?.reason || '',
      basis: deciding[0]?.basis ?? null,
      confidence: combineConfidence(deciding),
      source: deciding[0]?.source || VERDICT_SOURCES.MODEL,
    };
  };
  if (list.some((v) => v.verdict === AI_VERDICTS.DIFFERENT)) {
    return decide(AI_VERDICTS.DIFFERENT);
  }
  if (list.every((v) => v.verdict === AI_VERDICTS.SAME)) {
    return decide(AI_VERDICTS.SAME);
  }
  return decide(AI_VERDICTS.UNSURE);
}

/** Cuts a model's reason down to something a table cell can hold. */
function toReason(value) {
  if (value == null) return '';
  return String(value).trim().slice(0, REASON_MAX_LENGTH);
}

/** The model's basis, or null when it named none or named something else. */
function toBasis(value) {
  const basis = String(value ?? '')
    .trim()
    .toLowerCase();
  return VERDICT_BASIS_SET.has(basis) ? basis : null;
}

/** The model's confidence, or null when it named none or something else. */
function toConfidence(value) {
  const confidence = String(value ?? '')
    .trim()
    .toLowerCase();
  return CONFIDENCE_SET.has(confidence) ? confidence : null;
}

/** Splits a list into two halves, the first one the larger of the two. */
function splitInHalves(items) {
  const cut = Math.ceil(items.length / 2);
  return [items.slice(0, cut), items.slice(cut)];
}

/**
 * The complete `{...}` objects of a cut-off answer.
 *
 * parseVerdictArray() needs the closing bracket and gives up without it; this
 * one walks the text from the first `[` and takes every object whose braces
 * close, so a batch that was answered for nine of twenty-five pairs before the
 * model ran out of room keeps those nine. Strings are tracked because a reason
 * may well contain a brace.
 *
 * @param {string|null|undefined} text
 * @returns {object[]} objects carrying at least `id` and `verdict`
 */
function salvageVerdictObjects(text) {
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
        if (parsed && parsed.id != null && parsed.verdict != null) {
          objects.push(parsed);
        }
      } catch {
        // A half-written object is exactly what this function expects to meet.
      }
      objectStart = -1;
    }
  }

  return objects;
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
   * The model the judge runs on when the operator picked one for it
   * (DUPLICATES_AI_MODEL), or '' when it runs on the provider's configured
   * model. A judge is a different job from writing a title: a small local
   * model may be enough for one and not for the other, and an operator who
   * pays per token may want the cheaper model for a few hundred pairs.
   *
   * @returns {string}
   */
  judgeModel() {
    const runtimeConfig = require('../config/config');
    return String(
      runtimeConfig.duplicatesAiModel || process.env.DUPLICATES_AI_MODEL || ''
    ).trim();
  }

  /**
   * The model name this review reports and measures its prompts against: the
   * judge's own model when one is configured, otherwise the model of the
   * active provider, as the user configured it.
   *
   * @returns {string|null}
   */
  modelName() {
    const override = this.judgeModel();
    if (override !== '') {
      return override;
    }
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
      '- a misspelling of one name, but only when one of the two spellings is clearly not a word or a name of its own ("Vodafone" / "Vodaphone")',
      '',
      'Answer "different" when the names denote two things an archive has to keep apart:',
      '- two companies, authorities or people, however alike the names read ("Deutsche Bank" / "Deutsche Bahn")',
      '- a topic and a narrower or neighbouring topic ("Rechnung" / "Rechnungswesen", "Miete" / "Mietvertrag")',
      '- two words or names that both exist with their own meaning, however few letters differ ("Kontoauszug" / "Kontoumzug", "Miete" / "Mieter", "Bahn" / "Bank"). A small spelling distance is never by itself a reason for "same".',
      '',
      'Answer "unsure" when you cannot decide from what you were given:',
      '- two legal entities of one company are "same" only when a person would file them under one name; otherwise "unsure"',
      '- the names could mean the same thing, but nothing in the pair settles it',
      '- one spelling might be a word of its own and you cannot tell; if excerpts are given, decide from them, otherwise answer "unsure"',
      '',
      'Each pair says how the string matcher linked the names ("matched_by"). "fuzzy", "prefix" and "token-order" mean nothing but spelling links them; treat those as different unless the titles or excerpts show the same thing. When excerpts are given they are the beginning of the documents filed under that name; decide from what the documents are about.',
      '',
      'When document titles are given they are examples of what is filed under that name. Use them as evidence; they are never the answer.',
      kind === entityNameMatcher.KINDS.TAGS
        ? '"filed_with" lists the correspondents whose documents carry that tag most often; two tags filed with the same senders are more likely to be one thing, two tags filed with different senders more likely to be two.'
        : '"filed_with" lists the tags the documents of that correspondent carry most often; two correspondents filed under the same topics are more likely to be one thing, two filed under different topics more likely to be two.',
      '',
      'Answer with a JSON array and nothing else — no prose, no explanation, no code fence:',
      '[{"id": "<the id of the pair>", "verdict": "same" | "different" | "unsure", "basis": "<one word from the list below>", "confidence": "high" | "low", "reason": "<at most twelve words>"}]',
      `"basis" is one of: ${VERDICT_BASES.join(', ')}.`,
      '"confidence" is "high" when the evidence settles the pair and "low" when it does not. The basis "typo" is "high" only when one of the two spellings is not a word or a name of its own; otherwise answer "low".',
      'Answer every pair you were given exactly once, with the id copied as it was given.',
    ].join('\n');
  }

  /**
   * The Paperless-ngx matching rule of an entity, as the prompt spells it, or
   * null when the entity matches nothing automatically. A rule is evidence:
   * two names with two different literal rules are usually two things.
   *
   * @param {AiReviewEntity} entity
   * @returns {{algorithm:string, match:string}|null}
   */
  _matchingRuleOf(entity) {
    const algorithm =
      MATCHING_ALGORITHM_WORDS[Number(entity?.matchingAlgorithm)];
    if (!algorithm) return null;
    const match = String(entity?.match ?? '').trim();
    return match === '' ? { algorithm } : { algorithm, match };
  }

  /**
   * The batch itself: the kind, then one JSON object per pair. One line per
   * pair keeps it compact and still readable in a log.
   *
   * Every pair says how the matcher linked the two names (`matched_by`) and
   * how strongly (`score`), because that is what tells the model whether it
   * is looking at a reason or at a spelling coincidence. Each entity carries
   * its document count, its matching rule, and the titles and excerpts the
   * review fetched for it.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {AiReviewPair[]} pairs
   * @returns {string}
   */
  buildUserPrompt(kind, pairs) {
    const words = KIND_WORDS[kind] || KIND_WORDS.tags;
    const texts = (values) =>
      (values || []).map((value) => String(value ?? '').trim()).filter(Boolean);
    const describe = (entity) => {
      const described = {
        name: String(entity?.name ?? ''),
        documents: Number(entity?.documentCount) || 0,
      };
      const titles = texts(entity?.sampleTitles);
      if (titles.length > 0) described.titles = titles;
      const neighbours = texts(entity?.neighbourNames);
      if (neighbours.length > 0) described.filed_with = neighbours;
      const rule = this._matchingRuleOf(entity);
      if (rule) described.rule = rule;
      const excerpts = texts(entity?.sampleExcerpts);
      if (excerpts.length > 0) described.excerpts = excerpts;
      return described;
    };
    const lines = pairs.map((pair) => {
      const line = { id: pair.key };
      if (pair.matchedBy) line.matched_by = String(pair.matchedBy);
      if (Number.isFinite(Number(pair.score))) {
        line.score = Number(Number(pair.score).toFixed(2));
      }
      line.a = describe(pair.a);
      line.b = describe(pair.b);
      return JSON.stringify(line);
    });
    return [
      `Kind: ${words.plural}`,
      `Pairs: ${pairs.length}`,
      '[',
      lines.join(',\n'),
      ']',
    ].join('\n');
  }

  /** One line in the app log, at info level, like [RECONCILIATION] writes. */
  _log(message) {
    console.log(`${LOG_PREFIX} ${message}`);
  }

  /** The completion budget of a batch of this size. */
  _completionCap(pairCount) {
    return TOKENS_PER_PAIR * pairCount + TOKENS_OVERHEAD;
  }

  /**
   * The context window prompt and answer have to share. Read from the
   * environment first, the way modelName() does, so a TOKEN_LIMIT changed on
   * the settings page counts on the next review instead of on the next
   * restart.
   *
   * @returns {number}
   */
  _contextLimit() {
    const fromEnvironment = Number(process.env.TOKEN_LIMIT);
    if (Number.isFinite(fromEnvironment) && fromEnvironment > 0) {
      return fromEnvironment;
    }
    const runtimeConfig = require('../config/config');
    const configured = Number(runtimeConfig.tokenLimit);
    return Number.isFinite(configured) && configured > 0 ? configured : 128000;
  }

  /**
   * What one request of this batch would cost in prompt tokens. The system
   * prompt is counted with it because every provider sends both.
   *
   * @returns {Promise<number>}
   */
  async _promptTokens(systemPrompt, userPrompt) {
    const model = this.modelName() || undefined;
    const tokens = await calculateTokens(
      `${systemPrompt}\n${userPrompt}`,
      model
    );
    return Number.isFinite(tokens) ? tokens : 0;
  }

  /**
   * The batch size this review can afford, decided before the first request.
   *
   * Starts at `batchSize()` and halves until prompt, completion cap and margin
   * fit into the context window. Long names and three document titles per
   * entity make a batch of 25 expensive; a model with a 4k window cannot take
   * one at all, and would answer every batch with a cut-off array.
   *
   * @returns {Promise<{size:number, promptTokens:number, cap:number, limit:number}>}
   */
  async _planBatchSize(kind, pairs, systemPrompt) {
    const limit = this._contextLimit();
    let size = Math.max(1, Math.min(this.batchSize(), pairs.length));
    let promptTokens = await this._promptTokens(
      systemPrompt,
      this.buildUserPrompt(kind, pairs.slice(0, size))
    );
    let cap = this._completionCap(size);

    while (size > 1 && promptTokens + cap + TOKENS_CONTEXT_MARGIN > limit) {
      size = Math.max(1, Math.floor(size / 2));
      cap = this._completionCap(size);
      promptTokens = await this._promptTokens(
        systemPrompt,
        this.buildUserPrompt(kind, pairs.slice(0, size))
      );
    }

    return { size, promptTokens, cap, limit };
  }

  /**
   * The text a provider produced before it hit the limit.
   *
   * None of the four attaches it today — assertCompletionNotTruncated() throws
   * before the content is read — so a thrown truncation currently splits
   * without salvaging, and only Ollama's half-written answers are salvaged.
   * The day a provider starts carrying its prefix on the error, this picks it
   * up and the split gets cheaper.
   *
   * @returns {string|null}
   */
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
   * Takes the verdicts of one answer into the result map. Anything the batch
   * did not ask about, and anything already answered, is dropped.
   *
   * @returns {{same:number, different:number, unsure:number, recorded:number}}
   */
  _recordVerdicts(items, keys, verdicts) {
    const tally = { same: 0, different: 0, unsure: 0, recorded: 0 };
    for (const item of Array.isArray(items) ? items : []) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!keys.has(id) || verdicts.has(id)) continue;
      const verdict = String(item?.verdict ?? '')
        .trim()
        .toLowerCase();
      tally.recorded += 1;
      if (!AI_VERDICT_LIST.includes(verdict)) {
        verdicts.set(id, {
          verdict: AI_VERDICTS.UNSURE,
          reason: UNKNOWN_VERDICT_REASON,
          basis: null,
          confidence: null,
          source: VERDICT_SOURCES.MODEL,
        });
        tally.unsure += 1;
        continue;
      }
      verdicts.set(id, {
        verdict,
        reason: toReason(item?.reason),
        basis: toBasis(item?.basis),
        confidence: toConfidence(item?.confidence),
        source: VERDICT_SOURCES.MODEL,
      });
      tally[verdict] += 1;
    }
    return tally;
  }

  /**
   * A request that answered nothing usable: one warning with the reason and
   * the beginning of what came back, one failed request, its pairs unsure.
   * The logger redacts credentials on the way to the file; an API key is never
   * part of an answer or of one of these messages to begin with.
   */
  _failRequest(head, message, answer, keys, verdicts, usage) {
    const raw = String(answer ?? '').slice(0, RAW_ANSWER_LOG_LENGTH);
    console.warn(
      `${LOG_PREFIX} ${head} — failed: ${message}. Raw answer: ${raw || '(none)'}`
    );
    usage.failedRequests += 1;
    this._fillMissing(keys, verdicts, message);
  }

  /** Gives every pair of the batch still without a verdict the same reason. */
  _fillMissing(keys, verdicts, reason) {
    let filled = 0;
    for (const key of keys) {
      if (verdicts.has(key)) continue;
      verdicts.set(key, {
        verdict: AI_VERDICTS.UNSURE,
        reason: toReason(reason) || 'the request failed',
        basis: null,
        confidence: null,
        source: VERDICT_SOURCES.MODEL,
      });
      filled += 1;
    }
    return filled;
  }

  /**
   * One model request, and everything that can come back from it.
   *
   * Recursive on one path only: an answer that was cut off is salvaged and the
   * pairs still missing are asked again as two halves. Each half is strictly
   * smaller than the batch it came from, so the recursion ends at single
   * pairs.
   *
   * @param {AiReviewPair[]} batch
   * @param {object} context  kind, systemPrompt, service, verdicts, usage, state
   * @param {{isRetry?: boolean}} [options]
   */
  async _judgeBatch(batch, context, { isRetry = false } = {}) {
    const { kind, systemPrompt, service, verdicts, usage, state } = context;
    const keys = new Set(batch.map((pair) => pair.key));
    const cap = this._completionCap(batch.length);
    const userPrompt = this.buildUserPrompt(kind, batch);
    const promptTokens = await this._promptTokens(systemPrompt, userPrompt);

    state.requestNumber += 1;
    const requestNumber = state.requestNumber;
    usage.requests += 1;
    if (isRetry) usage.retries += 1;

    const startedAt = Date.now();
    const withExcerpts = batch.filter(
      (pair) =>
        (pair.a?.sampleExcerpts || []).length > 0 ||
        (pair.b?.sampleExcerpts || []).length > 0
    ).length;
    const evidence = withExcerpts > 0 ? `, ${withExcerpts} with excerpts` : '';
    const head = () =>
      `${kind}: request ${requestNumber}, ${batch.length} pair(s)${evidence}, ~${promptTokens} prompt tokens, cap ${cap}, ${Date.now() - startedAt}ms`;

    let answer;
    let truncated = false;
    const requestOptions = {
      systemPrompt,
      temperature: 0,
      maxTokens: cap,
    };
    // Only when the operator picked a model for the judge; without it the
    // provider stays on the model it is configured with.
    const judgeModel = this.judgeModel();
    if (judgeModel !== '') requestOptions.model = judgeModel;
    try {
      answer = await service.generateText(userPrompt, requestOptions);
    } catch (error) {
      if (error?.code !== TRUNCATION_ERROR_CODE) {
        this._failRequest(
          head(),
          error?.message || 'the AI provider could not be reached',
          null,
          keys,
          verdicts,
          usage
        );
        return;
      }
      truncated = true;
      answer = this._partialAnswerOf(error);
    }

    const spentTokens = Number(service.lastGenerateTextUsage?.totalTokens);
    if (Number.isFinite(spentTokens)) {
      usage.tokens = (usage.tokens || 0) + spentTokens;
    }
    const completionTokens = Number(
      service.lastGenerateTextUsage?.completionTokens
    );
    const spent = Number.isFinite(completionTokens)
      ? `, ${completionTokens} completion tokens`
      : '';

    let items = null;
    let parseError = null;
    if (!truncated) {
      try {
        items = parseVerdictArray(answer);
      } catch (error) {
        parseError = error;
      }
    }

    // The ordinary case: an answer that parses. Gaps in it are the model's
    // business, not a failure of the request.
    if (items) {
      const tally = this._recordVerdicts(items, keys, verdicts);
      const missing = this._fillMissing(keys, verdicts, NO_ANSWER_REASON);
      this._log(
        `${head()}${spent}, ${tally.same} same / ${tally.different} different / ${tally.unsure + missing} unsure.`
      );
      return;
    }

    // Everything below is a cut-off answer: the provider said so, or the text
    // stops in the middle of the array.
    const salvaged = this._recordVerdicts(
      salvageVerdictObjects(answer),
      keys,
      verdicts
    );
    const missing = batch.filter((pair) => !verdicts.has(pair.key));

    if (!truncated && salvaged.recorded === 0) {
      // A damaged answer with nothing usable in it stays what it was before:
      // one failed request, its own pairs unsure, the next batch runs.
      this._failRequest(
        head(),
        parseError?.message || 'the answer could not be read',
        answer,
        keys,
        verdicts,
        usage
      );
      return;
    }

    if (missing.length === 0) {
      this._log(
        `${head()}${spent} — the answer was cut off, salvaged all ${salvaged.recorded} verdict(s).`
      );
      return;
    }

    if (batch.length === 1) {
      this._fillMissing(keys, verdicts, SINGLE_PAIR_TRUNCATION_REASON);
      this._log(
        `${head()} — the answer hit the token limit for a single pair, giving up on ${batch[0].key}.`
      );
      return;
    }

    const halves = splitInHalves(missing).filter((half) => half.length > 0);
    this._log(
      salvaged.recorded > 0
        ? `${head()}${spent} — the answer was cut off, salvaged ${salvaged.recorded}, re-asking ${missing.length} in ${halves.length} request(s).`
        : `${head()}${spent} — the answer hit the token limit, splitting into ${halves.map((half) => half.length).join(' + ')}.`
    );
    for (const half of halves) {
      await this._judgeBatch(half, context, { isRetry: true });
    }
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
    const usage = {
      requests: 0,
      tokens: null,
      failedRequests: 0,
      retries: 0,
      batchSize: this.batchSize(),
    };
    const model = this.modelName();
    if (list.length === 0) {
      return { verdicts, model, usage };
    }

    const service = this._provider();
    const systemPrompt = this.buildSystemPrompt(kind);
    const plan = await this._planBatchSize(kind, list, systemPrompt);
    usage.batchSize = plan.size;
    this._log(
      `${kind}: batch size ${plan.size} of at most ${this.batchSize()} (context limit ${plan.limit} tokens), ` +
        `first batch ~${plan.promptTokens} prompt tokens, completion cap ${plan.cap}.`
    );

    const context = {
      kind,
      systemPrompt,
      service,
      verdicts,
      usage,
      state: { requestNumber: 0 },
    };
    for (const batch of chunk(list, plan.size)) {
      await this._judgeBatch(batch, context);
    }

    return { verdicts, model, usage };
  }

  /**
   * The pairs of one scanned kind: every non-target member against its
   * group's target, plus the candidates from the band below the threshold
   * that are not already inside one group.
   *
   * `judgedGroupIds` is the targeting: a group that is not in it contributes
   * no pairs, but its members' pairs still count as "inside one group", so a
   * group the user did not select cannot come back as a candidate either.
   *
   * A member pair the matcher settled by a rule — same name but for case,
   * umlauts or a legal form — is not a question for a model: it comes back in
   * `settled`, with the verdict a rule gives it, and never leaves the house.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {object[]} groups        every scan group of this kind
   * @param {object[]} candidates    the band below the threshold, possibly empty
   * @param {Set<string>|null} [judgedGroupIds]  null judges every group
   * @returns {{pairs: AiReviewPair[], candidates: AiReviewPair[], candidateEdges: Map<string, {score:number, reason:string}>, settled: Map<string, AiVerdict>}}
   */
  _pairsForKind(kind, groups, candidates, judgedGroupIds = null) {
    /** @type {AiReviewPair[]} */
    const pairs = [];
    /** @type {Map<string, AiVerdict>} */
    const settled = new Map();
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
      if (judgedGroupIds && !judgedGroupIds.has(group.id)) continue;
      for (const member of group.members) {
        if (member.id === target.id) continue;
        const key = entityNameMatcher.pairKey(kind, target.id, member.id);
        const basis = SETTLED_REASON_BASES[member.reason];
        if (basis) {
          settled.set(key, {
            verdict: AI_VERDICTS.SAME,
            reason: `settled by the spelling rule ${member.reason}`,
            basis,
            confidence: 'high',
            source: VERDICT_SOURCES.SPELLING_RULE,
          });
          continue;
        }
        // The edge of a group pair is the member's own score against the
        // target; the target itself carries 1 and no reason.
        pairs.push({
          key,
          a: target,
          b: member,
          matchedBy: member.reason ?? null,
          score: member.scoreToTarget,
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
        matchedBy: candidate.reason ?? null,
        score: candidate.score,
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
      settled,
    };
  }

  /**
   * Adds the neighbourhood of every entity the pairs name: who a tag is
   * usually filed with, what a correspondent is usually filed under. One
   * request per entity, cached in the review, and the cheapest evidence there
   * is — a tag whose documents come from banks is not the tag whose documents
   * come from a removal company.
   *
   * Switched by the same option as the titles: both are the context a person
   * would look at before deciding, and the page offers them as one choice.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {AiReviewPair[]} pairs
   * @param {{neighbours: Map<string, string[]>}} store  the review's memory
   * @returns {Promise<AiReviewPair[]>}
   */
  async _addNeighbourhood(kind, pairs, store) {
    const paperlessService = require('./paperlessService');
    if (typeof paperlessService.getEntityNeighbourhood !== 'function') {
      return pairs;
    }
    const ids = [
      ...new Set(pairs.flatMap((pair) => [pair.a.id, pair.b.id])),
    ].filter((id) => Number.isInteger(Number(id)));
    const unread = ids.filter((id) => !store.neighbours.has(`${kind}:${id}`));
    const fetched = await mapWithConcurrency(
      unread,
      TITLE_CONCURRENCY,
      async (id) => {
        try {
          return await paperlessService.getEntityNeighbourhood(kind, id, {
            documents: NEIGHBOUR_DOCUMENTS,
            limit: NEIGHBOUR_LIMIT,
          });
        } catch {
          // Context is a nicety; a review must not fail over it.
          return [];
        }
      }
    );
    unread.forEach((id, index) => {
      store.neighbours.set(
        `${kind}:${id}`,
        Array.isArray(fetched[index]) ? fetched[index] : []
      );
    });

    const withNeighbours = (entity) => {
      const list = store.neighbours.get(`${kind}:${Number(entity.id)}`);
      return list && list.length > 0
        ? { ...entity, neighbourNames: list }
        : entity;
    };
    return pairs.map((pair) => ({
      ...pair,
      a: withNeighbours(pair.a),
      b: withNeighbours(pair.b),
    }));
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
   * Adds document excerpts to the entities of the pairs the matcher linked by
   * spelling alone — and to no others. This is the evidence that separates
   * "Kontoauszug" from "Kontoumzug", and it is the expensive kind: one read
   * and a few hundred characters of prompt per entity.
   *
   * Three things keep the cost where it belongs:
   * - a pair whose `matched_by` is a strong tier never triggers a read;
   * - every entity is read once per review, whatever number of pairs names it
   *   (`cache`, keyed by kind and id, is the review's memory);
   * - the read itself is bounded by DUPLICATES_AI_EXCERPT_DOCUMENTS and
   *   DUPLICATES_AI_EXCERPT_CHARS, on the API side and again in the client.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {AiReviewPair[]} pairs
   * @param {{cache: Map<string, string[]>, entities: Set<string>}} store
   *   `cache` holds the excerpts already read, `entities` collects the ones
   *   that actually carried evidence into a prompt (what `aiReview.excerpts`
   *   reports).
   * @param {{force?: boolean}} [options] `force` takes every pair as worth the
   *   evidence, whatever linked it; that is what the escalation of an unsure
   *   verdict asks for.
   * @returns {Promise<{pairs: AiReviewPair[], spellingOnly: number}>}
   */
  async _addExcerpts(kind, pairs, store, { force = false } = {}) {
    const paperlessService = require('./paperlessService');
    const spellingOnly = force
      ? pairs
      : pairs.filter((pair) => SPELLING_ONLY_REASON_SET.has(pair.matchedBy));
    if (
      spellingOnly.length === 0 ||
      typeof paperlessService.getRecentDocumentExcerptsByEntity !== 'function'
    ) {
      return { pairs, spellingOnly: spellingOnly.length };
    }

    const ids = [
      ...new Set(spellingOnly.flatMap((pair) => [pair.a.id, pair.b.id])),
    ].filter((id) => Number.isInteger(Number(id)));
    const unread = ids.filter((id) => !store.cache.has(`${kind}:${id}`));
    const fetched = await mapWithConcurrency(
      unread,
      EXCERPT_CONCURRENCY,
      async (id) => {
        try {
          return await paperlessService.getRecentDocumentExcerptsByEntity(
            kind,
            id,
            { limit: this.excerptDocuments(), chars: this.excerptChars() }
          );
        } catch {
          // Evidence is a nicety; a review must not fail over it.
          return [];
        }
      }
    );
    unread.forEach((id, index) => {
      const list = Array.isArray(fetched[index]) ? fetched[index] : [];
      store.cache.set(`${kind}:${id}`, list);
    });

    const keys = new Set(spellingOnly.map((pair) => pair.key));
    const withExcerpts = (entity) => {
      const list = store.cache.get(`${kind}:${Number(entity.id)}`);
      if (!list || list.length === 0) return entity;
      store.entities.add(`${kind}:${Number(entity.id)}`);
      return { ...entity, sampleExcerpts: list };
    };
    return {
      pairs: pairs.map((pair) =>
        keys.has(pair.key)
          ? { ...pair, a: withExcerpts(pair.a), b: withExcerpts(pair.b) }
          : pair
      ),
      spellingOnly: spellingOnly.length,
    };
  }

  /**
   * The groups of one kind a targeted review judges: the ones `selectedIds`
   * names and, when a `minConfidence` is given, only those that reach it.
   * Both conditions hold at once; an id nobody knows simply matches nothing.
   *
   * @param {object[]} groups
   * @param {Set<string>|null} selectedIds
   * @param {number|null} minConfidence
   * @returns {object[]}
   */
  _selectGroups(groups, selectedIds, minConfidence) {
    return groups.filter((group) => {
      if (selectedIds && !selectedIds.has(String(group.id))) return false;
      if (minConfidence != null && !(Number(group.confidence) >= minConfidence))
        return false;
      return true;
    });
  }

  /**
   * What the log says about the narrowing, e.g. ` (min confidence 0.95, 12
   * ids)`. Empty when only the band was switched off.
   *
   * @param {Set<string>|null} selectedIds
   * @param {number|null} minConfidence
   * @returns {string}
   */
  _targetingNote(selectedIds, minConfidence) {
    const parts = [];
    if (minConfidence != null) parts.push(`min confidence ${minConfidence}`);
    if (selectedIds) parts.push(`${selectedIds.size} ids`);
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
  }

  /**
   * Runs a scan, adds the wider candidate band, has the model judge every
   * pair (group members against their target, and the candidates) and
   * returns the scan result with verdicts attached.
   *
   * `groupIds`, `minConfidence` and `includeCandidates` narrow what is asked
   * about without narrowing what comes back: a group the targeting left out
   * is still in `groups`, as the scan produced it, with `aiVerdict: null` on
   * the group and on every member. The page therefore keeps rendering its
   * whole scan and only pays for the groups it asked about.
   *
   * @param {AiReviewOptions} options
   * @returns {Promise<object>} DuplicateAiReviewResult (see schemas.js): the
   *   scan result with `groups` judged and an `aiReview` of type
   *   {@link AiReviewSummary}
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

    const startedAt = Date.now();
    const scan = await duplicateMergeService.scan(options);
    const requested = options.kind || 'all';
    const kinds =
      requested === 'all' ? [...entityNameMatcher.KIND_LIST] : [requested];
    const configuredTagNames =
      typeof duplicateMergeService._configuredTagNames === 'function'
        ? duplicateMergeService._configuredTagNames()
        : [];

    // The targeting. An absent option is no filter; only `includeCandidates`
    // has a default, and it is the behaviour of an untargeted review.
    const includeCandidates = options.includeCandidates !== false;
    const selectedIds = Array.isArray(options.groupIds)
      ? new Set(options.groupIds.map((id) => String(id)))
      : null;
    const minConfidence =
      options.minConfidence == null ||
      !Number.isFinite(Number(options.minConfidence))
        ? null
        : Number(options.minConfidence);
    const targeted =
      selectedIds !== null || minConfidence !== null || !includeCandidates;

    // The evidence. Titles are context for every pair; excerpts are evidence
    // for the spelling-only ones and are read once per entity per review.
    const withTitles = options.withTitles !== false;
    const withExcerpts =
      options.withExcerpts !== false && this.excerptsEnabled();
    const excerptStore = {
      cache: new Map(),
      entities: new Set(),
      neighbours: new Map(),
    };

    if (selectedIds) {
      const known = new Set((scan.groups || []).map((group) => group.id));
      const unknown = [...selectedIds].filter((id) => !known.has(id)).length;
      if (unknown > 0) {
        this._log(
          `${unknown} of ${selectedIds.size} group id(s) are not in this scan and were ignored.`
        );
      }
    }

    const scanGroups = [];
    const candidateGroups = [];
    let judged = 0;
    let candidateCount = 0;
    let groupsJudged = 0;
    let groupsSkipped = 0;
    let requests = 0;
    let failedRequests = 0;
    let retries = 0;
    let batchSize = null;
    let tokens = null;
    let spellingRules = 0;
    let escalated = 0;
    let model = this.modelName();

    /** Folds the usage of one round of requests into the totals above. */
    const foldUsage = (usage) => {
      requests += usage.requests;
      failedRequests += usage.failedRequests;
      retries += usage.retries;
      // Two kinds can end up with two sizes; the smaller one is what the
      // review actually had to work with.
      batchSize =
        batchSize == null
          ? usage.batchSize
          : Math.min(batchSize, usage.batchSize);
      if (usage.tokens != null) {
        tokens = (tokens || 0) + usage.tokens;
      }
    };

    for (const kind of kinds) {
      const groups = (scan.groups || []).filter((group) => group.kind === kind);
      const selected = this._selectGroups(groups, selectedIds, minConfidence);
      const selectedGroupIds = new Set(selected.map((group) => group.id));
      groupsJudged += selected.length;
      groupsSkipped += groups.length - selected.length;

      // Without the band nothing needs the entity list either, which is what
      // makes a targeted review cheap: one scan, no second read per kind.
      let entities = [];
      let band = [];
      if (includeCandidates) {
        entities = await paperlessService.listEntities(kind);

        let dismissed = [];
        if (!options.includeDismissed) {
          const rows = await documentModel.listEntityMergeDismissals(kind);
          dismissed = rows.map((row) =>
            entityNameMatcher.pairKey(kind, row.idA, row.idB)
          );
        }

        band = entityNameMatcher.findCandidatePairs(entities, {
          kind,
          floor: this.candidateFloor(),
          threshold: scan.threshold,
          dismissedPairs: dismissed,
          limit: CANDIDATE_LIMIT,
        });
      }

      const { pairs, candidates, candidateEdges, settled } = this._pairsForKind(
        kind,
        groups,
        band,
        selectedGroupIds
      );
      candidateCount += candidates.length;
      judged += pairs.length;
      spellingRules += settled.size;

      // The evidence is gathered before the start line, so the line can say
      // what the model is about to see rather than what it was offered.
      let asked = pairs;
      let spellingOnly = 0;
      const fetchedBefore = excerptStore.entities.size;
      if (pairs.length > 0 && withTitles) {
        asked = await this._addTitles(kind, asked);
        asked = await this._addNeighbourhood(kind, asked, excerptStore);
      }
      if (pairs.length > 0 && withExcerpts) {
        const evidence = await this._addExcerpts(kind, asked, excerptStore);
        asked = evidence.pairs;
        spellingOnly = evidence.spellingOnly;
      }
      const fetchedHere = excerptStore.entities.size - fetchedBefore;

      this._log(
        [
          `${kind}: threshold ${scan.threshold}`,
          targeted
            ? `judging ${selected.length} of ${groups.length} group(s)` +
              this._targetingNote(selectedIds, minConfidence)
            : `${groups.length} scan group(s)`,
          includeCandidates
            ? `${candidates.length} candidate(s) in the band`
            : 'band skipped',
          ...(settled.size > 0
            ? [`${settled.size} pair(s) settled by a spelling rule`]
            : []),
          `${pairs.length} pair(s) to judge`,
          `titles ${withTitles ? 'on' : 'off'}`,
          withExcerpts
            ? `excerpts on for ${spellingOnly} spelling-only pair(s), ` +
              `${fetchedHere} entity/entities fetched`
            : 'excerpts off',
          `model ${model || 'unknown'}`,
        ].join(', ') + '.'
      );
      if (pairs.length === 0) {
        // A group whose members a rule settled still carries its verdicts.
        scanGroups.push(
          ...groups.map((group) => this._withVerdicts(group, settled))
        );
        continue;
      }

      const review = await this.reviewPairs(asked, { kind });
      foldUsage(review.usage);
      model = review.model || model;

      // Second round: a pair the model could not decide and had no excerpts
      // for is asked again, this time with the documents. That is the cheap
      // half of the evidence budget — it is spent only where the first answer
      // says the names alone were not enough.
      const unsureWithoutExcerpts = withExcerpts
        ? asked.filter(
            (pair) =>
              review.verdicts.get(pair.key)?.verdict === AI_VERDICTS.UNSURE &&
              (pair.a?.sampleExcerpts || []).length === 0 &&
              (pair.b?.sampleExcerpts || []).length === 0
          )
        : [];
      if (unsureWithoutExcerpts.length > 0) {
        const evidence = await this._addExcerpts(
          kind,
          unsureWithoutExcerpts,
          excerptStore,
          { force: true }
        );
        // Asking the same question again with the same evidence buys
        // nothing, and an archive of documents without text would double
        // its requests for it. Only the pairs that gained something go.
        const again = evidence.pairs.filter(
          (pair) =>
            (pair.a?.sampleExcerpts || []).length > 0 ||
            (pair.b?.sampleExcerpts || []).length > 0
        );
        this._log(
          `${kind}: escalated ${again.length} of ${unsureWithoutExcerpts.length} unsure pair(s) with excerpts, ` +
            `${excerptStore.entities.size - fetchedBefore - fetchedHere} entity/entities fetched.`
        );
        if (again.length > 0) {
          const second = await this.reviewPairs(again, { kind });
          foldUsage(second.usage);
          escalated += again.length;
          for (const [key, verdict] of second.verdicts) {
            review.verdicts.set(key, verdict);
          }
        }
      }

      // The rule's verdicts and the model's answers are one map from here on;
      // a group aggregates them without knowing which is which.
      const verdicts = new Map([...settled, ...review.verdicts]);
      scanGroups.push(
        ...groups.map((group) => this._withVerdicts(group, verdicts))
      );

      const accepted = [];
      for (const candidate of candidates) {
        const verdict = verdicts.get(candidate.key);
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
            this._withVerdicts(group, verdicts, GROUP_SOURCES.AI_CANDIDATE)
          )
        );
      }
    }

    candidateGroups.sort(
      (x, y) =>
        y.confidence - x.confidence || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
    );

    const groups = [...scanGroups, ...candidateGroups];
    const confirmed = groups.filter(
      (group) => group.aiVerdict?.verdict === AI_VERDICTS.SAME
    ).length;
    this._log(
      `review finished: ${requests} request(s) (${retries} retry/retries, ${failedRequests} failed), ` +
        `${tokens == null ? 'unknown' : tokens} token(s), ${judged} pair(s) judged, ` +
        `${candidateCount} candidate(s), ${confirmed} group(s) confirmed` +
        (targeted
          ? `, ${groupsJudged} group(s) judged, ${groupsSkipped} skipped`
          : '') +
        `, in ${Date.now() - startedAt}ms.`
    );

    return {
      ...scan,
      groups,
      aiReview: {
        enabled: true,
        model,
        requests,
        tokens,
        judged,
        candidates: candidateCount,
        failedRequests,
        retries,
        batchSize: batchSize == null ? this.batchSize() : batchSize,
        targeted,
        groupsJudged,
        groupsSkipped,
        excerpts: excerptStore.entities.size,
        spellingRules,
        escalated,
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
entityMatchAiService.VERDICT_SOURCES = VERDICT_SOURCES;
entityMatchAiService.VERDICT_BASES = VERDICT_BASES;
entityMatchAiService.CONFIDENCE_LEVELS = CONFIDENCE_LEVELS;
entityMatchAiService.SPELLING_ONLY_REASONS = SPELLING_ONLY_REASONS;
entityMatchAiService.SETTLED_REASON_BASES = SETTLED_REASON_BASES;
entityMatchAiService.CANDIDATE_LIMIT = CANDIDATE_LIMIT;
entityMatchAiService.TOKENS_PER_PAIR = TOKENS_PER_PAIR;
entityMatchAiService.TOKENS_OVERHEAD = TOKENS_OVERHEAD;
entityMatchAiService.TOKENS_CONTEXT_MARGIN = TOKENS_CONTEXT_MARGIN;
entityMatchAiService.TRUNCATION_ERROR_CODE = TRUNCATION_ERROR_CODE;
entityMatchAiService.SINGLE_PAIR_TRUNCATION_REASON =
  SINGLE_PAIR_TRUNCATION_REASON;
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
/** Whether document excerpts may be read as evidence at all. */
entityMatchAiService.excerptsEnabled = () =>
  Boolean(config.duplicatesAiExcerpts);
/** Characters per excerpt, the bound the prompt is sized by. */
entityMatchAiService.excerptChars = () => {
  const chars = Number(config.duplicatesAiExcerptChars);
  return Number.isInteger(chars) && chars > 0 ? chars : 300;
};
/** Documents per entity one excerpt read looks at. */
entityMatchAiService.excerptDocuments = () => {
  const documents = Number(config.duplicatesAiExcerptDocuments);
  return Number.isInteger(documents) && documents > 0 ? documents : 2;
};

module.exports = entityMatchAiService;
