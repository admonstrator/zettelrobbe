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
 * One request per batch, temperature 0, thinking off unless the operator
 * switched it on, and a completion cap the review measures rather than
 * guesses (see "Measuring the model"). The system prompt states the job, the
 * rules and the output contract; the user prompt carries the kind and the
 * batch as JSON, one pair per line:
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
 * 3. If the answer is cut off anyway, all four providers raise
 *    `ai_response_truncated` with the text they managed to write on
 *    `error.partialText`; whatever complete objects that text already carries
 *    are salvaged, the cap is raised once for the pairs still missing, and
 *    only then are they asked again as two halves, recursively down to a
 *    single pair. A single pair that still does not fit is the one case that
 *    ends in "unsure". These retries are counted in `usage.retries`; they are
 *    not failures.
 *
 * ## Measuring the model, because guessing it cost the user two minutes
 *
 * The three keep a batch inside the *context* window. They say nothing about
 * how long a request takes, and on a hosted reasoning model at 31 tokens per
 * second that is what hurt: 25 pairs, a cap of 3200, and the model spent all
 * 3200 on its thoughts — 102 seconds for nothing, then a split into 13 + 12,
 * which does not help either, because the thinking does not get cheaper with
 * fewer pairs. The user watched "request 1 of 4 · estimating…" for two
 * minutes and pressed Stop.
 *
 * So the judge measures instead:
 *
 * - Thinking is off (`reasoning: false`) unless DUPLICATES_AI_THINKING says
 *   otherwise. The judge's job is to apply rules to evidence, and the
 *   evidence is in the prompt.
 * - The first request of an unmeasured model is a warm-up: WARMUP_PAIRS
 *   pairs, a deliberately generous cap, a few seconds.
 * - Its answer gives two numbers — tokens per pair and tokens per second —
 *   and every request after it is sized to last DUPLICATES_AI_REQUEST_SECONDS:
 *   `batchSize = requestSeconds × tokensPerSecond ÷ tokensPerPair`, capped at
 *   `tokensPerPair × batchSize × 1.5 + TOKENS_OVERHEAD`, both still bounded by
 *   the context window. Every later answer re-measures, smoothed by half
 *   against the measurement before it.
 * - What was measured is kept per model on the singleton *and* in the
 *   ai_calibration table, so the next review of the same model starts sized
 *   and skips the warm-up — after a restart as well, which is what a user who
 *   restarts the container between two reviews actually has. A measurement
 *   taken with thinking on is never reused with thinking off; the switch is
 *   part of the key in memory and in the table.
 * - A cut-off answer that salvaged nothing gets *twice the cap* and the same
 *   pairs once more; only when that bought nothing does the batch halve. A
 *   warm-up that does not fit either way ends the review with a message
 *   naming the two switches that can fix it.
 *
 * ## Thinking is a price per request, not per pair
 *
 * The first review of a real archive — 1300 tags, a hosted model — took
 * seventeen minutes. The model thought although it had been asked not to, and
 * every one of those thoughts was counted as the cost of a verdict: four
 * pairs and 600 tokens of reasoning read as 150 tokens per pair, the next
 * request was sized smaller, its reasoning cost the same, and the review
 * ended at one pair per request.
 *
 * So the two are measured apart. `reasoningTokens` comes off the provider's
 * usage or off the reasoning text the collector stripped;
 * `answerTokens = completionTokens − reasoningTokens` is what a verdict
 * costs, and the reasoning is a fixed price per request:
 *
 *   batch = (requestSeconds × tokensPerSecond − thinkingPerRequest) ÷ tokensPerPair
 *   cap   = tokensPerPair × batch × 1.5 + thinkingPerRequest × 1.25 + overhead
 *
 * With 40 tokens a verdict, 600 tokens of thought and 60 tokens a second, a
 * thirty-second request is thirty pairs instead of one. The cost is kept per
 * model in `ai_calibration.thinking_per_request`, and a model that thinks
 * although the switch says otherwise is said so once per review.
 *
 * ## Several requests at once
 *
 * DUPLICATES_AI_CONCURRENCY is how many requests a review keeps in flight: 1
 * for Ollama, which answers one at a time anyway, 3 for a hosted endpoint,
 * which answers three in the time of one. The warm-up runs alone — everything
 * after it is sized by what it measured — and from then on a lane that frees
 * takes the next batch off the queue at the size the last answer says is
 * right. A stop leaves the queue; the requests in flight abort and what they
 * still brought is kept.
 *
 * ## A verdict is asked once
 *
 * What the model said about two names is kept in `ai_pair_verdicts` for
 * DUPLICATES_AI_VERDICT_MEMORY_DAYS days. The next review answers those pairs
 * from the table and asks only about what is new — while both names are
 * unchanged, because a rename is a different question. "unsure" is never
 * remembered: it is the answer a second look should get another chance at.
 * `forgetVerdicts()` empties the table.
 *
 * ## The semantic sweep, for the names spelling will never link
 *
 * The matcher links names by how they are written. "Kontoauszug" and "Bank
 * statement", "KFZ" and "Auto", "Rechnung" and "Invoice" are the same thing
 * and no string distance will ever say so. `reviewScan({ semanticSweep:
 * true })` therefore adds one pass before the evidence is gathered: the model
 * is shown the names of a kind — ids and names, nothing else — in chunks of
 * DUPLICATES_AI_SWEEP_NAMES, and answers with the groups it believes name one
 * thing in another language, as a synonym or as an abbreviation.
 *
 * Nothing it proposes becomes a group on the spot. A proposed pair that is
 * not already inside a scan group, not already a candidate of the band and
 * not dismissed becomes an ordinary candidate pair with the reason
 * `semantic`, a score of 0.5 and the model's own basis and reason carried
 * into the judging prompt as `sweep_basis` and `sweep_reason` — so the judge
 * knows what it is being asked to check. These pairs always get document
 * excerpts, because they are the furthest from spelling: a proposal made from
 * names alone has to survive what the documents say. Then they are judged
 * with everything else, and only a "same" builds a group.
 *
 * The sweep is off unless the page asks for it, its requests are in the plan
 * before the first one is made (`sweepRequests`), the pairs it added are
 * counted (`sweepProposals`), and a kind with more than SWEEP_MAX_NAMES names
 * is not swept at all.
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
 * ## Being watched, and being stopped
 *
 * `reviewScan(options, control)` takes the control object of
 * services/duplicateReviewJobService.js as its optional second argument.
 * Without it the review is what it always was; with it three things happen.
 *
 * It reports, inside a request as well as between two. The provider streams
 * (`onProgress`), so the page is told whether the model is thinking, what
 * that has cost so far and how many verdicts have actually arrived — at most
 * one report every PROGRESS_INTERVAL_MS. A request that ends clears all of
 * that in the same report that counts it.
 *
 * It reports. The review is planned in full before the first request —
 * entities, pairs, evidence and batch sizes for every kind — so the page's
 * bar has a denominator (`requestsPlanned`, `pairsTotal`, `estimatedTokens`)
 * from request one instead of a number that grows per kind. That is the whole
 * reason the loop below runs twice: pass one plans, pass two judges.
 *
 * It stops. `control.signal` is looked at before every read, every request
 * and the second round, and it is handed to the provider, so a stop lands on
 * a request that is already in flight. A stopped review never throws: it
 * returns what it reached, with `aiReview.stopped` and `pairsNotJudged`. The
 * pairs nobody asked about get no verdict at all — "unsure" is the model's
 * word and would be a lie here — so they cannot turn into a group.
 *
 * It counts. One running total of tokens for the whole review, folded from
 * what the provider reports or, for a provider that reports nothing, from the
 * measured prompt plus the estimated answer. When `control.tokenBudget` is
 * reached the review stops itself through `control.stop('token-budget')`.
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
const { estimateRun } = require('./aiRunEstimate');

const AI_VERDICTS = Object.freeze({
  SAME: 'same',
  DIFFERENT: 'different',
  UNSURE: 'unsure',
});
const AI_VERDICT_LIST = Object.freeze(Object.values(AI_VERDICTS));

/**
 * A yes/no setting as config/config.js hands it over: parseEnvBoolean()
 * normalises the environment to the strings 'yes' and 'no', while a test may
 * set the field to a boolean. Both spellings of "on" count; everything else,
 * 'no' above all, is off. `Boolean('no')` is true, which is exactly the trap
 * this exists to avoid.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function switchedOn(value) {
  return value === true || String(value).trim().toLowerCase() === 'yes';
}

/**
 * An option the page may send as a boolean or as the string a form control
 * produces. Only the spellings of "on" count; an absent option, above all, is
 * off. This is for options that default to off, where `!== false` would be
 * the wrong reading.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function optedIn(value) {
  return (
    value === true ||
    ['yes', 'true', '1', 'on'].includes(String(value).trim().toLowerCase())
  );
}

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
 * Pairs the first request of an uncalibrated review asks about.
 *
 * Small enough that a slow model answers it in seconds rather than minutes,
 * large enough that dividing its completion tokens by the pairs says
 * something about what one verdict costs.
 */
const WARMUP_PAIRS = 4;
/**
 * The least the warm-up gives the model to answer in. A reasoning model
 * spends a fixed few hundred tokens on its thoughts before the first verdict,
 * and a warm-up that truncates measures nothing.
 */
const WARMUP_MIN_CAP = 1500;
/** How much of a fresh measurement replaces the one before it. */
const CALIBRATION_WEIGHT = 0.5;
/** The shortest request length an operator may ask for. */
const MIN_REQUEST_SECONDS = 5;
/** The request length the judge aims at when the setting says nothing. */
const DEFAULT_REQUEST_SECONDS = 30;
/**
 * Headroom on the measured cost per pair. The model that answered 200 tokens
 * per pair last time may write longer reasons this time, and a cap that is
 * half a verdict short costs a whole extra request.
 */
const CAP_SAFETY_FACTOR = 1.5;
/**
 * The cap never drops below the largest answer the model has produced in
 * this review, plus a quarter. A model that thinks pays a fixed price per
 * request, however few pairs it is asked about, so a cap sized by pairs
 * alone starves a small batch after a big one; a cap costs nothing unless
 * the model uses it, so the floor is free.
 *
 * The same quarter is the headroom on the measured thinking cost: what the
 * model spent on its thoughts last time, plus a quarter, is what its next
 * request is given for them.
 */
const CAP_FLOOR_FACTOR = 1.25;
/**
 * Model requests in flight at once when the setting says "automatic", and the
 * most an operator may ask for. One for Ollama: a local model answers one
 * request at a time whatever is sent to it, so more lanes only queue.
 */
const DEFAULT_CONCURRENCY = 3;
const OLLAMA_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
/** The least a request is ever given to answer in, whatever was measured. */
const MIN_COMPLETION_CAP = 256;
/**
 * How often one batch may have its cap raised before the batch itself is
 * halved. Once: a model that answers nothing with twice the room is not short
 * of room, and doubling on towards a 128k window would cost eight requests to
 * learn the same thing.
 */
const MAX_CAP_RAISES = 1;
/** The most often a streamed request reports to the page. */
const PROGRESS_INTERVAL_MS = 250;
/**
 * What is left free in the context window after prompt and completion cap.
 * The estimate is an estimate (÷4 characters for every non-OpenAI model), and
 * the providers add a few tokens of their own message framing.
 */
const TOKENS_CONTEXT_MARGIN = 256;
/**
 * The code serviceUtils.assertCompletionNotTruncated() raises, and with it
 * all four provider services — Ollama included, which used to return its
 * half-written answer instead. The error carries what was written on
 * `error.partialText`, so every truncation can be salvaged the same way.
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

/**
 * The most names one semantic sweep reads. Beyond this a sweep is dozens of
 * requests that each carry a slice of the archive, and a model that is shown
 * a fortieth of the names at a time proposes little worth judging. An archive
 * that large is told so in the log rather than swept badly.
 */
const SWEEP_MAX_NAMES = 5000;
/** The fewest names a sweep request may carry, whatever the setting says. */
const MIN_SWEEP_NAMES = 50;
/** Names the setting asks for when it says nothing usable. */
const DEFAULT_SWEEP_NAMES = 300;
/**
 * What one proposed group costs to write: two or three ids, a basis and a
 * twelve-word reason. The cap of a sweep request is this times the groups the
 * plan expects, and a cut-off answer raises it once, as a judged batch does.
 */
const SWEEP_TOKENS_PER_GROUP = 40;
/** The share of the names a sweep expects to end up in a group. */
const SWEEP_GROUPED_SHARE = 10;
/**
 * The score a semantic pair carries into the judging and, when the model
 * confirms it, into the group: the sweep saw names, nothing else, so the page
 * shows 50 % next to the semantic label rather than a number that pretends to
 * come from a measurement.
 */
const SEMANTIC_SCORE = 0.5;
/** Why the sweep says two names are one thing. Anything else becomes null. */
const SWEEP_BASES = Object.freeze(['translation', 'synonym', 'abbreviation']);
const SWEEP_BASIS_SET = new Set(SWEEP_BASES);
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

/**
 * The reasons that buy an entity its document excerpts: the spelling-only
 * tiers, and the semantic pairs of the sweep. A proposal the model made from
 * a list of names is the one pair that has seen no evidence at all, so it
 * gets the expensive kind before it is judged.
 */
const EXCERPT_REASON_SET = new Set([
  ...SPELLING_ONLY_REASONS,
  entityNameMatcher.MATCH_REASONS.SEMANTIC,
]);

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
 * What a review reports about where it is. The same words as the PHASES of
 * services/duplicateReviewJobService.js, repeated here rather than imported,
 * because the judge must not depend on the job that happens to run it.
 */
const REVIEW_PHASES = Object.freeze({
  SCANNING: 'scanning',
  EVIDENCE: 'evidence',
  SWEEPING: 'sweeping',
  WARMING_UP: 'warming-up',
  JUDGING: 'judging',
  ESCALATING: 'escalating',
  FINISHING: 'finishing',
});

/** What the page is told while the model is being measured. */
const WARMUP_MESSAGE = 'Measuring the model with a small first request…';
/**
 * What a review says when even a warm-up does not fit. Both switches are the
 * operator's, and both are spelled the way the settings page spells them.
 */
const WARMUP_IMPOSSIBLE_MESSAGE = (pairs) =>
  `The model's answers do not fit the token limit even for ${pairs} pair(s). ` +
  'Switch thinking off for the judge (DUPLICATES_AI_THINKING) or raise TOKEN_LIMIT.';

/**
 * What a review says once when the model writes reasoning although it was
 * asked not to. It is not an error: the requests are sized around the cost
 * instead, and the line says what that cost turned out to be.
 */
const UNREQUESTED_THINKING_MESSAGE = (tokens) =>
  `the model thinks although it was asked not to; requests are sized around ${tokens} tokens of thinking each.`;

/** The only stop the judge asks for itself. */
const STOP_REASON_TOKEN_BUDGET = 'token-budget';
/** What a stop is called when nobody said which one it was. */
const STOP_REASON_FALLBACK = 'user';

/**
 * @typedef {object} AiVerdict
 * @property {'same'|'different'|'unsure'} verdict
 * @property {string} reason   one short sentence from the model, '' when none
 * @property {string|null} basis  a VERDICT_BASES value, null when the model
 *   named none or named something else (an older model, another provider)
 * @property {'high'|'low'|null} confidence  how sure the model says it is
 * @property {'model'|'spelling-rule'} source  who decided: the provider, or a
 *   matcher tier a rule settles without asking anybody
 * @property {true} [remembered]  present only on a verdict the judge took from
 *   its memory of an earlier review instead of asking again
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
 * @property {string|null} [sweepBasis]   why the semantic sweep proposed this
 *   pair: translation, synonym or abbreviation
 * @property {string} [sweepReason]       the short reason the sweep gave
 */

/**
 * One group of the semantic sweep, after the ids were checked against the
 * names the request carried.
 *
 * @typedef {object} SweepProposal
 * @property {number[]} ids        two or more entity ids of the same chunk
 * @property {string|null} basis   a SWEEP_BASES value, null when the model
 *   named none or named something else
 * @property {string} reason       the model's short reason, '' when none
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
 * @property {boolean} stopped        true when the review ended before every
 *                                    pair it planned was judged
 * @property {string|null} stopReason always null here: the judge knows that
 *                                    it stopped, the job knows why and fills
 *                                    this in
 * @property {number} pairsNotJudged  pairs that were due and never answered
 * @property {number} sweepRequests   requests the semantic sweep made
 * @property {number} sweepProposals  pairs the sweep added to the review
 * @property {number} verdictsReused  pairs a remembered verdict answered, so
 *                                    the model was not asked about them
 * @property {number} concurrency     model requests the review kept in flight
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
 * @property {boolean} [semanticSweep] default false; let the model read the
 *   names of every kind of the review and propose the groups the string
 *   matcher cannot see. Its proposals are judged with evidence like the band.
 */

/**
 * The second argument of reviewScan(): what the job that runs the review
 * hands the judge. Every field is optional; an empty object is a review that
 * nobody watches and nothing stops.
 *
 * @typedef {object} AiReviewControl
 * @property {AbortSignal} [signal]  aborted on any stop
 * @property {(patch: object) => void} [onProgress]  takes a partial
 *   AiReviewProgress (see schemas.js); the job merges it by replacement, so
 *   every number in it is a total, never a delta
 * @property {(reason: string) => void} [stop]  what the judge calls when its
 *   own token budget is spent
 * @property {number|null} [tokenBudget]  the most this review may spend
 * @property {() => string|null} [stopReason]  why the job is stopping, for
 *   the one log line that says so
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
      // Only when the member that decided it came from the memory; a group
      // that was really asked about says nothing about remembering.
      ...(deciding[0]?.remembered ? { remembered: true } : {}),
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

/**
 * Whether a remembered verdict is still about the pair in front of us: both
 * names as they were, in either order. The pair key is a pair of ids, and an
 * id that was renamed is a different question about the same two objects.
 *
 * @param {{nameA:string, nameB:string}} row
 * @param {AiReviewPair} pair
 * @returns {boolean}
 */
function namesUnchanged(row, pair) {
  const stored = [String(row?.nameA ?? ''), String(row?.nameB ?? '')].sort();
  const now = [String(pair?.a?.name ?? ''), String(pair?.b?.name ?? '')].sort();
  return stored[0] === now[0] && stored[1] === now[1];
}

/** Splits a list into two halves, the first one the larger of the two. */
function splitInHalves(items) {
  const cut = Math.ceil(items.length / 2);
  return [items.slice(0, cut), items.slice(cut)];
}

/**
 * The complete `{...}` objects of a cut-off answer, whatever the answer was
 * about: verdicts, or the groups of a semantic sweep.
 *
 * parseVerdictArray() needs the closing bracket and gives up without it; this
 * one walks the text from the first `[` and takes every object whose braces
 * close, so a batch that was answered for nine of twenty-five pairs before the
 * model ran out of room keeps those nine. Strings are tracked because a reason
 * may well contain a brace.
 *
 * @param {string|null|undefined} text
 * @param {(parsed: object) => boolean} accept  what a usable object looks like
 * @returns {object[]}
 */
function salvageJsonObjects(text, accept) {
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
        if (parsed && accept(parsed)) objects.push(parsed);
      } catch {
        // A half-written object is exactly what this function expects to meet.
      }
      objectStart = -1;
    }
  }

  return objects;
}

/**
 * The complete verdict objects of a cut-off answer.
 *
 * @param {string|null|undefined} text
 * @returns {object[]} objects carrying at least `id` and `verdict`
 */
function salvageVerdictObjects(text) {
  return salvageJsonObjects(
    text,
    (parsed) => parsed.id != null && parsed.verdict != null
  );
}

/**
 * The complete group objects of a cut-off sweep answer: the same walk, a
 * different shape. A sweep group is worth keeping as soon as it carries a
 * list of ids; the ids themselves are checked against the names the request
 * carried afterwards.
 *
 * @param {string|null|undefined} text
 * @returns {object[]}
 */
function salvageSweepGroups(text) {
  return salvageJsonObjects(text, (parsed) => Array.isArray(parsed.ids));
}

/** The sweep's basis, or null when it named none or named something else. */
function toSweepBasis(value) {
  const basis = String(value ?? '')
    .trim()
    .toLowerCase();
  return SWEEP_BASIS_SET.has(basis) ? basis : null;
}

/**
 * How many verdicts have fully arrived in a streamed answer.
 *
 * The same walk that salvages a cut-off answer, counted instead of kept, so
 * "7 of 10 answers" on the page and the verdicts a truncation keeps are
 * always the same number.
 *
 * @param {string|null|undefined} text
 * @returns {number}
 */
function countCompleteVerdicts(text) {
  return salvageVerdictObjects(text).length;
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
  constructor() {
    /**
     * What the last review measured, per model name. A review that finds a
     * measurement of its own model starts sized from it instead of spending
     * a warm-up on the same question; a measurement taken with thinking on
     * says nothing about the same model with thinking off, so the switch is
     * part of what is stored and is compared before it is reused.
     *
     * Backed by the ai_calibration table: what one review measured is written
     * there and read back at the start of the next one, so a restart between
     * two reviews does not cost another warm-up.
     *
     * @type {Map<string, {tokensPerPair:number, tokensPerSecond:number, largestCompletion:number, thinking:boolean, measuredAt:number}>}
     */
    this.calibration = new Map();
    /** Overridable so a test does not have to wait a quarter of a second. */
    this.progressIntervalMs = PROGRESS_INTERVAL_MS;
    /**
     * The last write to the ai_calibration table. Nothing waits for it — a
     * measurement is saved detached — but a test that wants to read the row
     * back has something to await.
     *
     * @type {Promise<unknown>}
     */
    this.lastCalibrationSave = Promise.resolve();
    /** One warning is enough when the table cannot be written. */
    this._calibrationWarned = false;
    /**
     * The last write to the ai_pair_verdicts table. Detached like the
     * calibration; a test that wants to read a remembered verdict back has
     * something to await.
     *
     * @type {Promise<unknown>}
     */
    this.lastVerdictSave = Promise.resolve();
    /** One warning is enough when that table cannot be read or written. */
    this._verdictMemoryWarned = false;
  }

  /**
   * Whether the page should offer the review at all: the setting is on and
   * an AI provider is configured.
   *
   * @returns {boolean}
   */
  isEnabled() {
    const runtimeConfig = require('../config/config');
    return (
      switchedOn(runtimeConfig.duplicatesAiReview) &&
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
      '"matched_by":"semantic" is a pair nothing in the spelling links: it was proposed from the names alone, and "sweep_basis" and "sweep_reason" say why. Treat that as a claim to check against the evidence, never as a reason of its own.',
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
   * What the model is told about the semantic sweep: it reads names, it
   * proposes groups, and it proposes nothing the string matcher already has.
   * English and in the shape of the judge's prompt, for the same reason —
   * the rules are what makes the answers comparable.
   *
   * @param {'tags'|'correspondents'} kind
   * @returns {string}
   */
  buildSweepSystemPrompt(kind) {
    const words = KIND_WORDS[kind] || KIND_WORDS.tags;
    return [
      `You are given the names of the ${words.plural} of one personal document archive (Paperless-ngx).`,
      words.explanation,
      `Find groups of names that denote the same ${words.singular} although they are written differently.`,
      '',
      'Group two or more names only when they clearly name one and the same thing:',
      '- the same thing in two languages ("Rechnung" / "Invoice", "Kontoauszug" / "Bank statement")',
      '- two words for the same thing in one language ("Auto" / "KFZ", "Arzt" / "Mediziner")',
      '- an abbreviation and the long form of the same name ("TK" / "Techniker Krankenkasse", "KFZ" / "Kraftfahrzeug")',
      '',
      'Propose nothing else:',
      '- nothing that is merely related, near or part of the other ("Auto" / "Versicherung", "Rechnung" / "Mahnung", "Miete" / "Mietvertrag")',
      '- nothing that differs only in how it is written — case, spacing, umlauts, a legal form, singular and plural, or a typo ("Amazon" / "amazon", "Müller" / "Mueller", "Rechnung" / "Rechnungen"). Those are already known.',
      '- nothing you are unsure about. A wrong group costs the user a question; a missing one costs nothing.',
      '',
      'Answer with a JSON array and nothing else — no prose, no explanation, no code fence:',
      '[{"ids": ["<id>", "<id>"], "basis": "translation" | "synonym" | "abbreviation", "reason": "<at most twelve words>"}]',
      'Every group carries at least two ids, copied exactly as they were given. Use an id at most once in the whole answer.',
      'Answer with an empty array when no group is worth proposing.',
    ].join('\n');
  }

  /**
   * The names of one sweep request: ids and names, nothing else. Three
   * hundred names of a real archive are roughly three thousand tokens this
   * way, which is what makes a sweep of a whole kind affordable.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {AiReviewEntity[]} entities
   * @returns {string}
   */
  buildSweepUserPrompt(kind, entities) {
    const words = KIND_WORDS[kind] || KIND_WORDS.tags;
    const lines = entities.map((entity) =>
      JSON.stringify({
        id: String(entity.id),
        name: String(entity?.name ?? ''),
      })
    );
    return [
      `Kind: ${words.plural}`,
      `Names: ${entities.length}`,
      '[',
      lines.join(',\n'),
      ']',
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
      // Only a pair the semantic sweep proposed carries these: what the model
      // said when it saw nothing but the two names, so the judge knows what
      // claim it is being asked to check.
      if (pair.sweepBasis) line.sweep_basis = String(pair.sweepBasis);
      if (pair.sweepReason) line.sweep_reason = String(pair.sweepReason);
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

  /** The completion budget of a batch of this size, before anything is measured. */
  _completionCap(pairCount) {
    return TOKENS_PER_PAIR * pairCount + TOKENS_OVERHEAD;
  }

  /**
   * Whether the model may think before it answers.
   *
   * Off unless the operator switched it on. The user's model spent all 3200
   * tokens of its budget on reasoning and answered nothing, twice, on a batch
   * of 25 pairs — and halving the batch does not help, because the thinking
   * does not get cheaper with fewer pairs. The judge gives the model evidence
   * instead of room to think about it.
   *
   * @returns {boolean}
   */
  thinkingEnabled() {
    const runtimeConfig = require('../config/config');
    return switchedOn(runtimeConfig.duplicatesAiThinking);
  }

  /**
   * How long one model request should take, in seconds. Everything the judge
   * measures serves this number: a request the page can show progress for and
   * a person can wait out, instead of a two-minute silence.
   *
   * @returns {number}
   */
  requestSeconds() {
    const runtimeConfig = require('../config/config');
    const seconds = Number(runtimeConfig.duplicatesAiRequestSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return DEFAULT_REQUEST_SECONDS;
    }
    return Math.max(MIN_REQUEST_SECONDS, Math.floor(seconds));
  }

  /**
   * How many model requests a review keeps in flight at once
   * (DUPLICATES_AI_CONCURRENCY). 0 is automatic: one for Ollama, where a
   * local model answers one request at a time whatever is sent to it, three
   * for a hosted endpoint, which answers three as fast as one. Read at the
   * start of a review, so a change on the settings page counts on the next
   * review rather than on the next restart.
   *
   * `override` is one run's own answer, from the page: out of range is
   * clamped into it rather than refused, and absent means "as configured".
   *
   * @param {unknown} [override]
   * @returns {number} between 1 and MAX_CONCURRENCY
   */
  concurrency(override = null) {
    const wanted = Number(override);
    if (Number.isFinite(wanted) && wanted >= 1) {
      return Math.max(1, Math.min(Math.floor(wanted), MAX_CONCURRENCY));
    }
    const runtimeConfig = require('../config/config');
    const configured = Number(runtimeConfig.duplicatesAiConcurrency);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(1, Math.min(Math.floor(configured), MAX_CONCURRENCY));
    }
    return runtimeConfig.aiProvider === 'ollama'
      ? OLLAMA_CONCURRENCY
      : DEFAULT_CONCURRENCY;
  }

  /**
   * How long a verdict about a pair of names is remembered
   * (DUPLICATES_AI_VERDICT_MEMORY_DAYS), 0 when the memory is switched off.
   * Nothing is read and nothing is written then.
   *
   * @returns {number}
   */
  verdictMemoryDays() {
    const runtimeConfig = require('../config/config');
    const days = Number(runtimeConfig.duplicatesAiVerdictMemoryDays);
    return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  }

  /**
   * Forgets every remembered verdict, so the next review asks about every
   * pair again. The page offers this next to the calibration reset: the
   * memory is keyed by the two names, so it goes stale only when the user
   * disagrees with what the model said, and then all of it should go.
   *
   * @returns {Promise<number>} verdicts forgotten
   */
  async forgetVerdicts() {
    const documentModel = require('../models/document');
    if (typeof documentModel.clearAiPairVerdicts !== 'function') return 0;
    try {
      return Number(await documentModel.clearAiPairVerdicts()) || 0;
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} the remembered verdicts could not be cleared: ${error?.message || error}`
      );
      return 0;
    }
  }

  /** What the provider is configured to spend on one answer (RESPONSE_TOKENS). */
  _responseTokens() {
    const runtimeConfig = require('../config/config');
    const tokens = Number(runtimeConfig.responseTokens);
    return Number.isFinite(tokens) && tokens > 0 ? tokens : 1000;
  }

  /**
   * Forgets every measurement, in memory and in the table, so the next review
   * measures again. The current model is always among the ones forgotten,
   * even when this service has never measured it itself — a fresh process
   * that only ever read the row must be able to drop it too.
   *
   * @returns {Promise<unknown>} the write, for a caller that wants to wait
   */
  resetCalibration() {
    const models = new Set(this.calibration.keys());
    models.add(this.modelName() || '');
    this.calibration.clear();
    return this._forgetCalibrationRows([...models]);
  }

  /**
   * Forgets one model, in memory and in the table. The same thing
   * resetCalibration() does, for the operator who wants to re-measure one
   * model rather than all of them.
   *
   * @param {string} [model]  the judge's current model when none is given
   * @returns {Promise<unknown>}
   */
  forgetCalibration(model) {
    const name = String(model ?? this.modelName() ?? '');
    this.calibration.delete(name);
    return this._forgetCalibrationRows([name]);
  }

  /**
   * Empties the stored measurement of every named model, for both settings of
   * the thinking switch.
   *
   * models/document.js has no delete for a calibration row and it is the
   * contract of this round, so the row is overwritten with nothing instead:
   * a row without tokens per pair is a model that was never measured, and
   * _loadCalibration() steps over it exactly as it steps over a missing row.
   *
   * @param {string[]} models
   * @returns {Promise<unknown>}
   */
  _forgetCalibrationRows(models) {
    const documentModel = require('../models/document');
    if (typeof documentModel.saveAiCalibration !== 'function') {
      return Promise.resolve();
    }
    const writes = [];
    for (const model of models) {
      for (const thinking of [false, true]) {
        writes.push(
          this._writeCalibration({
            model,
            thinking,
            tokensPerPair: null,
            tokensPerSecond: null,
            thinkingPerRequest: null,
            largestCompletion: 0,
          })
        );
      }
    }
    this.lastCalibrationSave = Promise.all(writes);
    return this.lastCalibrationSave;
  }

  /**
   * Reads what an earlier review — possibly in an earlier process — measured
   * about this model into the in-memory calibration, so _sizer() finds it and
   * the review starts sized. What this process measured itself wins: it is
   * newer than the row, and the row is what it will be overwritten with.
   *
   * @returns {Promise<void>}
   */
  async _loadCalibration() {
    const documentModel = require('../models/document');
    if (typeof documentModel.getAiCalibration !== 'function') return;
    const model = this.modelName() || '';
    const thinking = this.thinkingEnabled();
    const known = this.calibration.get(model);
    if (known && known.thinking === thinking) return;
    let stored;
    try {
      stored = await documentModel.getAiCalibration(model, thinking);
    } catch (error) {
      this._warnCalibration('read', error);
      return;
    }
    // A row without both numbers measures nothing: it is either a model that
    // only ever truncated or one whose measurement was forgotten.
    if (
      !stored ||
      stored.tokensPerPair == null ||
      stored.tokensPerSecond == null
    ) {
      return;
    }
    this.calibration.set(model, {
      tokensPerPair: Number(stored.tokensPerPair),
      tokensPerSecond: Number(stored.tokensPerSecond),
      // Null in a row written before the thinking was measured apart; the
      // next answer of this model measures it.
      thinkingPerRequest: Number(stored.thinkingPerRequest) || 0,
      largestCompletion: Number(stored.largestCompletion) || 0,
      thinking,
      measuredAt: Date.parse(stored.measuredAt) || Date.now(),
    });
  }

  /**
   * Saves what a request measured. Detached on purpose: a review must not
   * wait for a disk write between two model requests, and a table that
   * refuses is worth one warning, not a failed review.
   *
   * @param {object} measurement
   * @returns {Promise<unknown>}
   */
  _persistCalibration(measurement) {
    this.lastCalibrationSave = this._writeCalibration(measurement);
    return this.lastCalibrationSave;
  }

  /** One write, with its own error handling. */
  _writeCalibration(measurement) {
    const documentModel = require('../models/document');
    if (typeof documentModel.saveAiCalibration !== 'function') {
      return Promise.resolve(false);
    }
    try {
      return Promise.resolve(
        documentModel.saveAiCalibration(measurement)
      ).catch((error) => {
        this._warnCalibration('save', error);
        return false;
      });
    } catch (error) {
      this._warnCalibration('save', error);
      return Promise.resolve(false);
    }
  }

  /** The one line a broken calibration table is worth. */
  _warnCalibration(what, error) {
    if (this._calibrationWarned) return;
    this._calibrationWarned = true;
    console.warn(
      `${LOG_PREFIX} the calibration could not be ${what === 'read' ? 'read' : 'saved'}: ` +
        `${error?.message || error}. The judge measures the model again instead.`
    );
  }

  /**
   * The sizing of one review: what it knows about the model before its first
   * request, and what it learns from every answer.
   *
   * A review that finds a measurement of its own model (same model, same
   * thinking switch) starts calibrated: no warm-up, the first request already
   * at the computed size and cap. Everything else starts at `null` and the
   * first request is the warm-up.
   *
   * @returns {object}
   */
  _sizer() {
    const thinking = this.thinkingEnabled();
    const model = this.modelName() || '';
    const stored = this.calibration.get(model);
    const usable = stored && stored.thinking === thinking ? stored : null;
    return {
      model,
      thinking,
      tokensPerPair: usable ? usable.tokensPerPair : null,
      tokensPerSecond: usable ? usable.tokensPerSecond : null,
      /**
       * What this model spends on thinking per request, whatever the switch
       * says: a fixed price, not a price per pair. `thinking` above is the
       * wish the request carries; this is what the answers cost.
       */
      thinkingPerRequest: usable ? usable.thinkingPerRequest || 0 : null,
      /** One line per review is enough when the model thinks regardless. */
      unrequestedThinkingLogged: false,
      /** The largest completion one request produced, the floor of the cap. */
      largestCompletion: usable ? usable.largestCompletion || 0 : 0,
      /** True once size and cap come from a measurement rather than defaults. */
      calibrated: Boolean(usable),
      /** True when that measurement came from an earlier review. */
      fromMemory: Boolean(usable),
      /** False while the first, small request is still due. */
      warmedUp: Boolean(usable),
      /** True once somebody has told the page that the warm-up is coming. */
      warmupAnnounced: false,
      /** The context-safe ceiling of the kind being judged. */
      maxSize: Math.max(1, this.batchSize()),
      /** Pairs per request in use, null before the first one is sized. */
      batchSize: null,
      measurements: 0,
      lastPromptTokens: 0,
      lastPairs: 1,
      lastCap: 0,
    };
  }

  /**
   * The batch size a measurement asks for: as many pairs as the model can
   * answer within the configured request seconds, never more than the
   * operator's batch size and never more than the context window allows.
   *
   * The thinking is paid before the first verdict and once per request,
   * however many pairs the request carries, so it is taken off the seconds
   * rather than divided into the pairs. That is the whole of round 10's
   * speed-up: a model that thinks for 600 tokens and writes 40 per verdict
   * was sized at one pair per request while its thoughts were counted as the
   * cost of a verdict; with the same numbers it now gets thirty.
   *
   * @param {object} sizer
   * @param {number} bound  the context-safe ceiling for this kind
   * @returns {number}
   */
  _sizeFor(sizer, bound) {
    const ceiling = Math.max(1, Math.min(this.batchSize(), bound));
    if (
      !sizer ||
      sizer.tokensPerPair == null ||
      sizer.tokensPerSecond == null
    ) {
      return ceiling;
    }
    // What the model writes in the seconds one request may take, minus what
    // it spends on thinking before it writes the first verdict.
    const inTheTime = this.requestSeconds() * sizer.tokensPerSecond;
    const affordable = Math.floor(
      (inTheTime - (sizer.thinkingPerRequest || 0)) / sizer.tokensPerPair
    );
    return Math.max(1, Math.min(affordable, ceiling));
  }

  /**
   * What a batch of this size may spend on its answer, before the context
   * window has its say: the measured cost per pair with headroom, the
   * warm-up's own generous budget, or the flat estimate of the first version.
   *
   * @param {object} sizer
   * @param {number} pairCount
   * @param {{warmingUp?: boolean}} [options]
   * @returns {number}
   */
  _capFor(sizer, pairCount, { warmingUp = false } = {}) {
    if (warmingUp) {
      return Math.max(
        this._responseTokens(),
        this._completionCap(pairCount),
        WARMUP_MIN_CAP
      );
    }
    if (!sizer || sizer.tokensPerPair == null) {
      return this._completionCap(pairCount);
    }
    // The verdicts by the pair, the thinking once — the same split the batch
    // size is derived from, so a small batch is not starved of the room its
    // thoughts need and a large one is not paid for them twice.
    const byPairs =
      Math.ceil(sizer.tokensPerPair * pairCount * CAP_SAFETY_FACTOR) +
      Math.ceil((sizer.thinkingPerRequest || 0) * CAP_FLOOR_FACTOR) +
      TOKENS_OVERHEAD;
    const floor = Math.ceil((sizer.largestCompletion || 0) * CAP_FLOOR_FACTOR);
    return Math.max(byPairs, floor);
  }

  /**
   * The cap one request actually gets, and the ceiling the context window
   * puts on it. `atBound` is what tells a truncation apart from a cap that is
   * merely too small: at the bound there is no more room to give, so the
   * batch has to get smaller instead.
   *
   * @param {object} sizer
   * @param {number} pairCount
   * @param {number} promptTokens
   * @param {{warmingUp?: boolean, wanted?: number|null}} [options]
   * @returns {{cap:number, bound:number, atBound:boolean}}
   */
  _capForRequest(sizer, pairCount, promptTokens, options = {}) {
    const limit = this._contextLimit();
    const bound = Math.max(
      MIN_COMPLETION_CAP,
      limit - promptTokens - TOKENS_CONTEXT_MARGIN
    );
    // `Number(null)` is 0, not NaN: a missing cap must not pass for one.
    const wanted =
      typeof options.wanted === 'number' && Number.isFinite(options.wanted)
        ? options.wanted
        : this._capFor(sizer, pairCount, { warmingUp: options.warmingUp });
    const cap = Math.max(MIN_COMPLETION_CAP, Math.min(wanted, bound));
    return { cap, bound, atBound: cap >= bound };
  }

  /**
   * Takes one answered request into the sizing and returns true when the
   * batch size changed because of it.
   *
   * Three numbers come out of every request. What a verdict costs this model
   * (the *answer* tokens ÷ pairs), what its thinking costs (the reasoning
   * tokens, per request, because that is how they are paid) and how fast it
   * writes both (completion tokens ÷ seconds). All three are smoothed against
   * the measurement before them, so one slow minute on a busy server does not
   * halve the batch for the rest of the review.
   *
   * Separating the two is what round 10 is about: while the thoughts counted
   * as the cost of a verdict, a model that thought for 600 tokens before
   * answering four pairs looked like 150 tokens a pair, then like 300 on the
   * batch of two that followed, and a review of 1300 tags ended at one pair
   * per request.
   *
   * A truncated answer measures only the speed: it stopped at the cap, so its
   * tokens per pair say nothing except that the cap was too small.
   *
   * @param {object} context
   * @param {{pairs:number, completionTokens:number|null, reasoningTokens:number|null, elapsedMs:number, truncated:boolean, warmingUp:boolean}} measurement
   * @returns {boolean} true when the next request will be a different size
   */
  _measure(context, measurement) {
    const { sizer } = context;
    const tokens = Number(measurement.completionTokens);
    if (!sizer || !Number.isFinite(tokens) || tokens <= 0) return false;

    const seconds = Math.max(0.001, Number(measurement.elapsedMs) / 1000);
    const blend = (previous, fresh) =>
      previous == null
        ? fresh
        : previous * (1 - CALIBRATION_WEIGHT) + fresh * CALIBRATION_WEIGHT;
    const pairs = Math.max(1, Number(measurement.pairs) || 1);
    // What the provider or the collector reported as reasoning, bounded by
    // the completion it is part of; a model that wrote none costs none.
    const reasoning = Number(measurement.reasoningTokens);
    const thinking = Number.isFinite(reasoning)
      ? Math.max(0, Math.min(reasoning, tokens))
      : 0;
    const answerTokens = tokens - thinking;

    sizer.tokensPerSecond = blend(sizer.tokensPerSecond, tokens / seconds);
    sizer.largestCompletion = Math.max(sizer.largestCompletion || 0, tokens);
    sizer.thinkingPerRequest = blend(sizer.thinkingPerRequest, thinking);
    if (!measurement.truncated && answerTokens > 0) {
      sizer.tokensPerPair = blend(sizer.tokensPerPair, answerTokens / pairs);
    }
    sizer.measurements += 1;
    // A model that was asked not to think and thinks anyway is worth saying
    // once: the review does not fight it, it pays for it in every request.
    if (thinking > 0 && !sizer.thinking && !sizer.unrequestedThinkingLogged) {
      sizer.unrequestedThinkingLogged = true;
      this._log(
        UNREQUESTED_THINKING_MESSAGE(Math.round(sizer.thinkingPerRequest))
      );
    }
    if (sizer.tokensPerPair == null) return false;

    sizer.calibrated = true;
    this.calibration.set(sizer.model, {
      tokensPerPair: sizer.tokensPerPair,
      tokensPerSecond: sizer.tokensPerSecond,
      thinkingPerRequest: sizer.thinkingPerRequest || 0,
      largestCompletion: sizer.largestCompletion,
      thinking: sizer.thinking,
      measuredAt: Date.now(),
    });
    // And into the table, so the next review after a restart starts sized.
    this._persistCalibration({
      model: sizer.model,
      thinking: sizer.thinking,
      tokensPerPair: sizer.tokensPerPair,
      tokensPerSecond: sizer.tokensPerSecond,
      thinkingPerRequest: sizer.thinkingPerRequest || 0,
      largestCompletion: sizer.largestCompletion,
    });

    const before = sizer.batchSize;
    sizer.batchSize = this._sizeFor(sizer, sizer.maxSize);
    const cap = this._capFor(sizer, sizer.batchSize);
    const perPair = Math.round(sizer.tokensPerPair);
    const perSecond = Math.round(sizer.tokensPerSecond);
    const perRequest = Math.round(sizer.thinkingPerRequest || 0);
    if (measurement.warmingUp) {
      this._log(
        `warm-up: ${pairs} pair(s), ${tokens} completion tokens (${perPair} per pair, ` +
          `${perRequest} thinking per request), ` +
          `${perSecond} tokens/s, thinking ${sizer.thinking ? 'on' : 'off'} ` +
          `→ batch size ${sizer.batchSize}, cap ${cap}.`
      );
    } else if (sizer.batchSize !== before) {
      this._log(
        `re-sized after ${sizer.measurements} measurement(s): ${perPair} tokens per pair, ` +
          `${perRequest} thinking per request, ` +
          `${perSecond} tokens/s → batch size ${before} becomes ${sizer.batchSize}, cap ${cap}.`
      );
    }
    return sizer.batchSize !== before;
  }

  /**
   * Re-derives the plan from what the model turned out to cost: the requests
   * still to make for the pairs nobody has asked about yet, and what they are
   * expected to spend. Only a calibrated review does this — before the first
   * measurement the numbers of pass one are all there is.
   *
   * @param {object} context
   */
  _replan(context) {
    const { tracker, sizer } = context;
    if (!tracker || !sizer || !sizer.calibrated || !sizer.batchSize) return;
    const remaining = Math.max(0, tracker.pairsTotal - tracker.pairsAsked);
    const batches = Math.ceil(remaining / sizer.batchSize);
    // The requests the other lanes are still working on: their pairs have
    // left `remaining` and their answers have not reached requestsDone, so
    // without them the denominator would drop by one per busy lane. One of
    // the busy lanes is the one this replan runs in.
    const otherLanes = Math.max(0, tracker.lanesBusy || 0);
    tracker.requestsPlanned =
      tracker.requestsDone + otherLanes + tracker.pendingRequests + batches;
    const promptPerPair = sizer.lastPromptTokens / Math.max(1, sizer.lastPairs);
    const perRequest =
      Math.round(promptPerPair * sizer.batchSize) +
      this._capFor(sizer, sizer.batchSize);
    tracker.estimatedTokens = (tracker.tokens || 0) + batches * perRequest;
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
   * All four attach it as `error.partialText` now, reasoning stripped, so
   * every truncation arrives here with whatever verdicts the model had
   * already written; they are kept and only the missing pairs are asked
   * again. The two other names are read as well, because an error that
   * travels through another layer may arrive under one of them.
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
   * @param {object[]} items
   * @param {Set<string>} keys
   * @param {Map<string, AiVerdict>} verdicts
   * @param {((key: string, verdict: AiVerdict) => void)|null} [onRecorded]
   *   told about every verdict that came from this answer; that is what the
   *   judge's memory is written from
   * @returns {{same:number, different:number, unsure:number, recorded:number}}
   */
  _recordVerdicts(items, keys, verdicts, onRecorded = null) {
    const tally = { same: 0, different: 0, unsure: 0, recorded: 0 };
    const record = (id, given) => {
      verdicts.set(id, given);
      if (onRecorded) onRecorded(id, given);
    };
    for (const item of Array.isArray(items) ? items : []) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!keys.has(id) || verdicts.has(id)) continue;
      const verdict = String(item?.verdict ?? '')
        .trim()
        .toLowerCase();
      tally.recorded += 1;
      if (!AI_VERDICT_LIST.includes(verdict)) {
        record(id, {
          verdict: AI_VERDICTS.UNSURE,
          reason: UNKNOWN_VERDICT_REASON,
          basis: null,
          confidence: null,
          source: VERDICT_SOURCES.MODEL,
        });
        tally.unsure += 1;
        continue;
      }
      record(id, {
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
   * The judge's memory of what it decided about a pair of names, or null when
   * the operator switched it off (DUPLICATES_AI_VERDICT_MEMORY_DAYS = 0).
   *
   * Opened once per review: the old rows are pruned here, so a review is the
   * only thing that ever cleans the table, and the memory carries the model
   * the review runs on into every row it writes.
   *
   * @returns {Promise<{days:number, model:string|null}|null>}
   */
  async _openVerdictMemory() {
    const days = this.verdictMemoryDays();
    if (days === 0) return null;
    const documentModel = require('../models/document');
    if (
      typeof documentModel.getAiPairVerdicts !== 'function' ||
      typeof documentModel.saveAiPairVerdict !== 'function'
    ) {
      return null;
    }
    try {
      const forgotten = await documentModel.pruneAiPairVerdicts(days);
      if (forgotten > 0) {
        this._log(
          `${forgotten} remembered verdict(s) older than ${days} day(s) were forgotten.`
        );
      }
    } catch (error) {
      this._warnVerdictMemory('read', error);
      return null;
    }
    return { days, model: this.modelName() };
  }

  /**
   * The pairs of a list an earlier review already answered, by pair key.
   *
   * A row counts only while both names are what they were: a rename is a new
   * question, and the two names are stored so nothing but the model's own
   * answer is reused. "unsure" is never stored, so it is never reused.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {AiReviewPair[]} pairs
   * @param {{days:number, model:string|null}|null} memory
   * @returns {Promise<Map<string, AiVerdict>>}
   */
  async _rememberedVerdicts(kind, pairs, memory) {
    const answered = new Map();
    if (!memory || pairs.length === 0) return answered;
    const documentModel = require('../models/document');
    let rows;
    try {
      rows = await documentModel.getAiPairVerdicts(
        kind,
        pairs.map((pair) => pair.key)
      );
    } catch (error) {
      this._warnVerdictMemory('read', error);
      return answered;
    }
    const byKey = new Map(
      (Array.isArray(rows) ? rows : []).map((row) => [row.pairKey, row])
    );
    for (const pair of pairs) {
      const row = byKey.get(pair.key);
      if (!row || !namesUnchanged(row, pair)) continue;
      const verdict = String(row.verdict ?? '')
        .trim()
        .toLowerCase();
      if (verdict !== AI_VERDICTS.SAME && verdict !== AI_VERDICTS.DIFFERENT) {
        continue;
      }
      answered.set(pair.key, {
        verdict,
        reason: toReason(row.reason),
        basis: toBasis(row.basis),
        confidence: toConfidence(row.confidence),
        source: VERDICT_SOURCES.MODEL,
        remembered: true,
      });
    }
    return answered;
  }

  /**
   * Remembers one verdict the model just gave. Only "same" and "different"
   * are worth keeping: "unsure" and the reasons a failed request fills in are
   * the answers a later review should get another chance at.
   *
   * Detached like the calibration — a review must not wait for a disk write
   * between two requests — with `lastVerdictSave` for a test that wants to
   * read the row back.
   *
   * @param {object} context
   * @param {AiReviewPair|undefined} pair
   * @param {AiVerdict} verdict
   */
  _rememberVerdict(context, pair, verdict) {
    const { memory, kind } = context;
    if (!memory || !pair) return;
    if (
      verdict.verdict !== AI_VERDICTS.SAME &&
      verdict.verdict !== AI_VERDICTS.DIFFERENT
    ) {
      return;
    }
    const documentModel = require('../models/document');
    const write = Promise.resolve()
      .then(() =>
        documentModel.saveAiPairVerdict({
          kind,
          pairKey: pair.key,
          nameA: String(pair.a?.name ?? ''),
          nameB: String(pair.b?.name ?? ''),
          verdict: verdict.verdict,
          basis: verdict.basis,
          confidence: verdict.confidence,
          reason: verdict.reason,
          model: memory.model,
        })
      )
      .catch((error) => {
        this._warnVerdictMemory('save', error);
        return false;
      });
    this.lastVerdictSave = Promise.all([this.lastVerdictSave, write]);
  }

  /** The one line a broken verdict table is worth. */
  _warnVerdictMemory(what, error) {
    if (this._verdictMemoryWarned) return;
    this._verdictMemoryWarned = true;
    console.warn(
      `${LOG_PREFIX} the remembered verdicts could not be ${what === 'read' ? 'read' : 'saved'}: ` +
        `${error?.message || error}. The judge asks the model instead.`
    );
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
   * The review's own bookkeeping for the control object it was given, or null
   * when it was given nothing worth keeping books for. A review without a
   * tracker is the review this service ran before there was a job: it reports
   * nothing, it measures nothing it does not already measure, and it never
   * stops early.
   *
   * @param {AiReviewControl} [control]
   * @returns {object|null}
   */
  _reviewTracker(control) {
    const given = control && typeof control === 'object' ? control : {};
    const budget = Number(given.tokenBudget);
    const tokenBudget = Number.isFinite(budget) && budget > 0 ? budget : null;
    const signal =
      given.signal && typeof given.signal === 'object' ? given.signal : null;
    const onProgress =
      typeof given.onProgress === 'function' ? given.onProgress : null;
    if (!signal && !onProgress && tokenBudget === null) return null;
    return {
      signal,
      onProgress,
      stop: typeof given.stop === 'function' ? given.stop : null,
      readStopReason:
        typeof given.stopReason === 'function' ? given.stopReason : null,
      // What the job writes down about the run: one record per finished
      // request, and what the review knows about its own size. Both absent
      // when nobody is keeping the books, which is every caller but the job.
      recordRequest:
        typeof given.recordRequest === 'function' ? given.recordRequest : null,
      noteRun: typeof given.noteRun === 'function' ? given.noteRun : null,
      tokenBudget,
      stopped: false,
      budgetSpent: false,
      kind: null,
      requestsPlanned: 0,
      requestsDone: 0,
      // Requests a cut-off answer added and that have not been made yet; they
      // belong in the denominator without being part of the pairs still to ask.
      pendingRequests: 0,
      pairsJudged: 0,
      pairsTotal: 0,
      // Pairs that were put into a request, retries not counted twice. What
      // is left of pairsTotal is what the plan still has to pay for.
      pairsAsked: 0,
      estimatedTokens: 0,
      tokens: null,
      failedRequests: 0,
      retries: 0,
      excerpts: 0,
      escalated: 0,
      spellingRules: 0,
      // Pairs an earlier review already answered, so this one did not ask.
      verdictsReused: 0,
      // Requests this review keeps in flight at once, and the lanes that are
      // busy right now; the second one is what the plan and the page need
      // while several answers are still on their way.
      concurrency: 1,
      lanesBusy: 0,
      // Numbers the rows of the run meter. Run-wide and monotonic, unlike
      // the per-kind number the log lines carry: two rows of the same run
      // must not show the same number to the person reading them.
      requestNumber: 0,
    };
  }

  /** The next number for the run meter, 0 when nobody is keeping one. */
  _nextRequestIndex(tracker) {
    if (!tracker) return 0;
    tracker.requestNumber = (Number(tracker.requestNumber) || 0) + 1;
    return tracker.requestNumber;
  }

  /**
   * True once this review must not read, ask or escalate any more. Asked
   * before every one of those, so a stop costs at most the request that is
   * already in flight.
   *
   * @param {object|null} tracker
   * @returns {boolean}
   */
  _stopped(tracker) {
    if (!tracker) return false;
    if (tracker.stopped) return true;
    if (tracker.signal?.aborted === true) {
      tracker.stopped = true;
      return true;
    }
    return false;
  }

  /**
   * One progress report. The patch is partial and every number in it is a
   * total; the job merges it by replacement. A listener that throws is the
   * page's problem, not the review's.
   *
   * @param {object|null} tracker
   * @param {object} patch  a partial AiReviewProgress
   */
  _report(tracker, patch) {
    if (!tracker || !tracker.onProgress) return;
    try {
      tracker.onProgress(patch);
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} a progress listener threw: ${error?.message || error}`
      );
    }
  }

  /**
   * How many distinct entities a set of pairs names; what the evidence
   * messages count, because a read happens per entity, not per pair.
   *
   * @param {AiReviewPair[]} pairs
   * @returns {number}
   */
  _entityCount(pairs) {
    const ids = new Set();
    for (const pair of pairs) {
      for (const entity of [pair?.a, pair?.b]) {
        const id = Number(entity?.id);
        if (Number.isInteger(id)) ids.add(id);
      }
    }
    return ids.size;
  }

  /**
   * What one request cost, folded into the review's running total.
   *
   * The provider's own number is the truth when it reports one, and
   * `usage.tokens` keeps carrying exactly that. A provider that reports
   * nothing would leave the page's counter at null and the token budget
   * blind, so the request is measured instead: the prompt as the batch was
   * sized, the answer as the estimator reads it. That estimate steers the
   * budget and the page; it does not enter `usage.tokens`, which stays the
   * number the provider stands behind.
   *
   * @param {object} context
   * @param {number} promptTokens  what the prompt of this request measured
   * @param {string|null} answer
   */
  async _countRequestTokens(context, promptTokens, answer) {
    const { service, usage, tracker } = context;
    const reported = Number(service.lastGenerateTextUsage?.totalTokens);
    if (Number.isFinite(reported)) {
      usage.tokens = (usage.tokens || 0) + reported;
      if (tracker) tracker.tokens = (tracker.tokens || 0) + reported;
      return;
    }
    if (!tracker) return;
    const measured = await calculateTokens(
      String(answer ?? ''),
      this.modelName() || undefined
    );
    tracker.tokens =
      (tracker.tokens || 0) +
      promptTokens +
      (Number.isFinite(measured) ? measured : 0);
  }

  /**
   * Reads what the provider says one request cost onto a small holder, so
   * every exit of `_askBatch` can report the same three numbers.
   *
   * A field the provider did not report stays null. `_countRequestTokens`
   * estimates a total for the page's counter and the token budget where it
   * has to; that estimate is deliberately not copied here, because what is
   * written here ends up in `ai_run_stats` and is read back as a
   * measurement.
   *
   * @param {object} service  the provider service, after the call
   * @param {{prompt:number|null, completion:number|null, thinking:number|null}} into
   */
  _readSpend(service, into) {
    const usage = service?.lastGenerateTextUsage;
    // `Number(null)` is 0, so null has to be turned away before the guard:
    // a provider that reported nothing did not report a zero.
    const reported = (value) => {
      if (value === null || value === undefined) return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
    };
    into.prompt = reported(usage?.promptTokens);
    into.completion = reported(usage?.completionTokens);
    into.thinking = reported(usage?.reasoningTokens);
  }

  /**
   * Hands one finished request to the job that is keeping the books. Nothing
   * happens when nobody is: a review the tests run without a job makes the
   * same requests, it just writes nothing down.
   *
   * @param {object} context
   * @param {object} record  an AiReviewRequestRecord plus `promptTokens`
   */
  _recordRequest(context, record) {
    const tracker = context?.tracker;
    if (!tracker || typeof tracker.recordRequest !== 'function') return;
    try {
      tracker.recordRequest(record);
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} a request record was refused: ${error?.message || error}`
      );
    }
  }

  /**
   * Tells the job what this review is, in the terms `ai_run_stats` keeps:
   * how many pairs the model is asked about, how many a rule settled first,
   * the model and whether it thinks.
   *
   * @param {object|null} tracker
   * @param {{items?:number, itemsByRule?:number, model?:string|null, thinking?:boolean}} patch
   */
  _noteRun(tracker, patch) {
    if (!tracker || typeof tracker.noteRun !== 'function') return;
    try {
      tracker.noteRun(patch);
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} what this run costs could not be noted: ${error?.message || error}`
      );
    }
  }

  /**
   * What an answered request adds to the progress: one request done, the
   * pairs it settled, the running token total, and the line that names the
   * request the page is now waiting for.
   *
   * `splits` is what a cut-off answer turned into. It is added to the plan in
   * the same report, so the bar never falls back a few per cent because the
   * denominator was one request short.
   *
   * @param {object} context
   * @param {AiReviewPair[]} batch
   * @param {number} [splits]
   */
  _afterRequest(context, batch, splits = 0) {
    const { tracker, verdicts, kind, sizer, state } = context;
    if (!tracker) return;
    tracker.requestsDone += 1;
    tracker.requestsPlanned += splits;
    tracker.pendingRequests += splits;
    // The pairs this request settled: a split answers only what it salvaged,
    // and its halves report their own, so nothing is counted twice.
    tracker.pairsJudged += batch.filter((pair) =>
      verdicts.has(pair.key)
    ).length;
    tracker.kind = kind;
    // What the measurement of this request changed, if anything: the plan for
    // the pairs nobody has asked about yet, and what they should cost.
    this._replan(context);
    const patch = {
      kind,
      requestsDone: tracker.requestsDone,
      requestsPlanned: tracker.requestsPlanned,
      pairsJudged: tracker.pairsJudged,
      pairsTotal: tracker.pairsTotal,
      estimatedTokens: tracker.estimatedTokens,
      tokens: tracker.tokens,
      failedRequests: tracker.failedRequests,
      retries: tracker.retries,
      batchSize: sizer ? sizer.batchSize : null,
      calibrated: Boolean(sizer && sizer.calibrated),
      concurrency: tracker.concurrency,
      inFlight: state ? state.inFlight : 0,
      verdictsReused: tracker.verdictsReused,
      // The request is over; nothing about it is in flight any more.
      requestPairs: null,
      requestAnswers: 0,
      requestTokens: null,
      thinkingTokens: null,
      thinking: false,
      message: this._requestMessage(tracker),
    };
    // The warm-up is the one request the page waits out under its own phase;
    // its answer is what moves the review into judging.
    if (state?.warmupReported) {
      patch.phase = REVIEW_PHASES.JUDGING;
      state.warmupReported = false;
    }
    this._report(tracker, patch);
    this._checkTokenBudget(tracker);
  }

  /**
   * One report from inside a request the provider is streaming.
   *
   * What the page shows while an answer is being written: whether the model
   * is still thinking, how many tokens that has cost so far, and how many of
   * the pairs it has actually answered. At most one report every
   * PROGRESS_INTERVAL_MS — a fast model produces chunks faster than any page
   * can paint them.
   *
   * The running token total is the tracker's plus what this request has
   * produced so far; it is never written back, because the provider's own
   * number replaces it once the request is over.
   *
   * @param {object} context
   * @param {AiReviewPair[]} batch
   * @param {import('./aiGenerateOptions').GenerateTextProgress} update
   */
  _onStream(context, batch, update) {
    const { tracker, state } = context;
    if (!tracker || !tracker.onProgress) return;
    const now = Date.now();
    const interval = Number(this.progressIntervalMs);
    if (
      now - state.lastStreamMs <
      (interval >= 0 ? interval : PROGRESS_INTERVAL_MS)
    ) {
      return;
    }
    state.lastStreamMs = now;
    state.streamed = true;

    const thinking = update?.thinking === true;
    const produced = Number(update?.completionTokens);
    const requestTokens = Number.isFinite(produced) ? produced : null;
    const thought = Number(update?.thinkingTokens);
    const thinkingTokens = Number.isFinite(thought) ? thought : null;
    const answers = thinking ? 0 : countCompleteVerdicts(update?.text);
    const answered =
      answers > 0 ? ` · ${answers} of ${batch.length} answers` : '';
    // While the warm-up is running the page is told what it is for, not
    // which request it is; the plan behind that number is still provisional.
    const waiting = state.warmingUp
      ? WARMUP_MESSAGE
      : this._requestMessage(tracker);
    this._report(tracker, {
      requestPairs: batch.length,
      requestAnswers: answers,
      requestTokens,
      thinkingTokens,
      inFlight: state.inFlight,
      thinking,
      tokens: (tracker.tokens || 0) + (requestTokens || 0),
      message: thinking
        ? `The model is thinking… (${requestTokens || 0} tokens so far)`
        : `${waiting}${answered}`,
    });
  }

  /**
   * Clears what a request left on the page when it ends without a report of
   * its own — a stop while the answer was still arriving. Only for a request
   * that streamed something, so a review nobody streamed to reports nothing
   * extra.
   *
   * @param {object} context
   */
  _clearRequestProgress(context) {
    const { tracker, state } = context;
    if (!tracker || !state?.streamed) return;
    state.streamed = false;
    this._report(tracker, {
      requestPairs: null,
      requestAnswers: 0,
      requestTokens: null,
      thinkingTokens: null,
      inFlight: state.inFlight,
      thinking: false,
      message: this._requestMessage(tracker),
    });
  }

  /** The line the page shows while it waits for the next answer. */
  _requestMessage(tracker) {
    const next = tracker.requestsDone + 1;
    return next <= tracker.requestsPlanned
      ? `Asking the model, request ${next} of ${tracker.requestsPlanned}`
      : 'Waiting for the last answer…';
  }

  /**
   * The judge's own brake: a review that has spent what the operator allowed
   * stops itself. The job is told why, so the page says "token budget" rather
   * than "somebody pressed stop".
   *
   * @param {object|null} tracker
   */
  _checkTokenBudget(tracker) {
    if (!tracker || tracker.budgetSpent || tracker.tokenBudget === null) return;
    if (
      !Number.isFinite(tracker.tokens) ||
      tracker.tokens < tracker.tokenBudget
    ) {
      return;
    }
    tracker.budgetSpent = true;
    tracker.stopped = true;
    this._log(
      `token budget ${tracker.tokenBudget} reached after ${tracker.requestsDone} request(s) ` +
        `(${tracker.tokens} tokens).`
    );
    if (!tracker.stop) return;
    try {
      tracker.stop(STOP_REASON_TOKEN_BUDGET);
    } catch (error) {
      // The job is gone; the review stops on its own flag either way.
      console.warn(
        `${LOG_PREFIX} the stop of the token budget was not accepted: ${error?.message || error}`
      );
    }
  }

  /**
   * Why this review stopped, for the one line that says so. The job knows
   * (the user, the idle watch, the budget); without one, the budget is the
   * only reason the judge could have had itself.
   *
   * @param {object|null} tracker
   * @returns {string|null}
   */
  _stopReason(tracker) {
    if (!tracker) return null;
    const given = tracker.readStopReason ? tracker.readStopReason() : null;
    if (typeof given === 'string' && given !== '') return given;
    return tracker.budgetSpent
      ? STOP_REASON_TOKEN_BUDGET
      : STOP_REASON_FALLBACK;
  }

  /**
   * One model request, and everything that can come back from it.
   *
   * Two paths ask again. An answer that was cut off with nothing usable in it
   * is asked again with twice the cap, because on a model that thinks the cut
   * is the thinking rather than the pairs, and halving the batch would only
   * buy the same truncation at half the value. Once the cap has reached what
   * the context window allows, or MAX_CAP_RAISES raises have bought nothing,
   * the batch itself is split in two — each half strictly smaller, so the
   * splitting ends at single pairs.
   *
   * Neither path asks again from here: both put the work back at the *front*
   * of the queue the scheduler in reviewPairs() takes batches from. With one
   * lane that is the request that would have been the recursion; with several
   * it is a half that goes to whichever lane frees first.
   *
   * Two things a stopped review needs from here: nothing is asked once the
   * signal is aborted, and a request that dies on the signal while it is in
   * flight is not a failure — its pairs simply stay unanswered.
   *
   * @param {AiReviewPair[]} batch
   * @param {object} context  kind, systemPrompt, service, verdicts, usage,
   *   state, tracker, sizer, memory, enqueue
   * @param {{isRetry?: boolean, cap?: number|null, raises?: number, warmup?: boolean, lane?: function}} [options]
   *   `cap` is the budget a raised retry asks for; without one the sizing
   *   decides. `warmup` keeps a raised retry of the warm-up the warm-up.
   *   `lane` is what the scheduler gave this request; it is closed the moment
   *   the request is counted as done, so the plan knows how many of the other
   *   lanes are still out.
   */
  async _judgeBatch(
    batch,
    context,
    {
      isRetry = false,
      cap: wanted = null,
      raises = 0,
      warmup = false,
      lane = null,
    } = {}
  ) {
    const {
      kind,
      systemPrompt,
      service,
      verdicts,
      usage,
      state,
      tracker,
      sizer,
    } = context;
    // Between two requests is where a stop costs nothing at all.
    if (this._stopped(tracker)) return;

    // Numbered when it is dispatched rather than when its prompt is counted,
    // so the numbers in the log follow the order the requests went out in
    // even when several lanes are counting prompts at the same time.
    state.requestNumber += 1;
    const requestNumber = state.requestNumber;
    // The run meter numbers every request of the whole run, sweep included.
    const meterIndex = this._nextRequestIndex(tracker);

    const keys = new Set(batch.map((pair) => pair.key));
    const byKey = new Map(batch.map((pair) => [pair.key, pair]));
    const userPrompt = this.buildUserPrompt(kind, batch);
    const promptTokens = await this._promptTokens(systemPrompt, userPrompt);
    // The first request of an unmeasured review is the warm-up: few pairs, a
    // generous budget, and the measurement every later request is sized by.
    const warmingUp = warmup || (Boolean(sizer) && !sizer.warmedUp);
    const budget = this._capForRequest(sizer, batch.length, promptTokens, {
      warmingUp,
      wanted,
    });
    const cap = budget.cap;

    state.lastStreamMs = 0;
    state.streamed = false;
    state.warmingUp = warmingUp;
    usage.requests += 1;
    if (isRetry) {
      usage.retries += 1;
      if (tracker) {
        tracker.retries += 1;
        tracker.pendingRequests = Math.max(0, tracker.pendingRequests - 1);
      }
    } else if (tracker) {
      tracker.pairsAsked += batch.length;
    }
    if (sizer) {
      sizer.lastPromptTokens = promptTokens;
      sizer.lastPairs = batch.length;
      sizer.lastCap = cap;
      if (sizer.batchSize === null) sizer.batchSize = batch.length;
    }
    if (warmingUp && tracker) {
      // The answer of this request is what moves the page out of the
      // warming-up phase, whoever announced the phase itself.
      state.warmupReported = true;
    }
    if (warmingUp && tracker && !sizer.warmupAnnounced) {
      sizer.warmupAnnounced = true;
      this._report(tracker, {
        phase: REVIEW_PHASES.WARMING_UP,
        kind,
        batchSize: batch.length,
        calibrated: false,
        requestPairs: batch.length,
        requestAnswers: 0,
        requestTokens: null,
        thinking: false,
        message: WARMUP_MESSAGE,
      });
    }

    const startedAt = Date.now();
    // What this one request cost, as the provider reported it. Read off the
    // service after the answer arrived; null while nothing came back, and
    // null afterwards for a provider that reports nothing — an estimate in
    // this place would be written to `ai_run_stats` and believed later.
    const spentHere = { prompt: null, completion: null, thinking: null };
    const withExcerpts = batch.filter(
      (pair) =>
        (pair.a?.sampleExcerpts || []).length > 0 ||
        (pair.b?.sampleExcerpts || []).length > 0
    ).length;
    const evidence = withExcerpts > 0 ? `, ${withExcerpts} with excerpts` : '';
    const head = () =>
      `${kind}: request ${requestNumber}, ${batch.length} pair(s)${evidence}, ~${promptTokens} prompt tokens, cap ${cap}, ${Date.now() - startedAt}ms`;
    // Every path that answered something reports it; `splits` says how many
    // requests a cut-off answer added to the plan. The lane is closed first:
    // this request is counted from here on, and the plan counts the lanes
    // that are still out.
    //
    // `outcome` and `answers` are what the run meter shows for this request.
    // Every path below names its own, because the difference between a
    // request that answered everything, one that answered half of it and one
    // that thought for 25,000 tokens and said nothing is the whole reason
    // the log exists — and the page shows what it is told.
    const report = (splits = 0, outcome = 'answered', answers = null) => {
      if (typeof lane === 'function') lane();
      this._recordRequest(context, {
        index: meterIndex,
        items: batch.length,
        answers: answers === null ? batch.length : answers,
        // Omitted rather than null where nothing was reported: the
        // contract's recordRequest reads an explicit null as a measured 0.
        tokens: spentHere.completion ?? undefined,
        thinkingTokens: spentHere.thinking ?? undefined,
        promptTokens: spentHere.prompt ?? undefined,
        ms: Date.now() - startedAt,
        outcome,
      });
      return this._afterRequest(context, batch, splits);
    };

    let answer;
    let truncated = false;
    const requestOptions = {
      systemPrompt,
      temperature: 0,
      maxTokens: cap,
      // Off unless the operator switched it on; see thinkingEnabled().
      reasoning: Boolean(sizer && sizer.thinking),
    };
    // Only when the operator picked a model for the judge; without it the
    // provider stays on the model it is configured with.
    const judgeModel = this.judgeModel();
    if (judgeModel !== '') requestOptions.model = judgeModel;
    // With a signal the provider can be stopped mid-request; without one it
    // sends exactly what it sent before.
    if (tracker?.signal) requestOptions.signal = tracker.signal;
    // Streaming is for the page: with nobody to report to, the plain request
    // says the same thing at the end.
    if (tracker?.onProgress) {
      requestOptions.onProgress = (update) =>
        this._onStream(context, batch, update);
    }
    // Waiting for an answer from here until it arrives, whichever way it
    // ends: this is what the page shows as `inFlight`. The lanes the plan
    // counts are the scheduler's, and they stay busy until the answer has
    // been read as well.
    state.inFlight += 1;
    let settled = false;
    const landed = () => {
      if (settled) return;
      settled = true;
      state.inFlight = Math.max(0, state.inFlight - 1);
    };
    try {
      answer = await service.generateText(userPrompt, requestOptions);
      landed();
    } catch (error) {
      landed();
      if (this._stopped(tracker)) {
        // A stop, not a failure: no failed request, no retry, and above all
        // no "unsure" for pairs nobody answered.
        this._clearRequestProgress(context);
        this._log(
          `${head()} — stopped while waiting for the answer, ${batch.length} pair(s) left unjudged.`
        );
        return;
      }
      if (error?.code !== TRUNCATION_ERROR_CODE) {
        this._readSpend(service, spentHere);
        this._failRequest(
          head(),
          error?.message || 'the AI provider could not be reached',
          null,
          keys,
          verdicts,
          usage
        );
        if (tracker) tracker.failedRequests += 1;
        return report(0, 'failed', 0);
      }
      truncated = true;
      // What the provider wrote before it ran out of room. All four carry it
      // now, so the salvage below has something to work with.
      answer = this._partialAnswerOf(error);
    }

    const elapsedMs = Date.now() - startedAt;
    await this._countRequestTokens(context, promptTokens, answer);
    this._readSpend(service, spentHere);
    const completionTokens = Number(
      service.lastGenerateTextUsage?.completionTokens
    );
    // What of that was the model thinking rather than answering: the
    // provider's own number where it reports one, the collector's estimate
    // off the reasoning text otherwise.
    const reasoningTokens = Number(
      service.lastGenerateTextUsage?.reasoningTokens
    );
    const thought = Number.isFinite(reasoningTokens) ? reasoningTokens : 0;
    const spent = Number.isFinite(completionTokens)
      ? `, ${completionTokens} completion tokens` +
        (thought > 0 ? ` (${thought} of them thinking)` : '')
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

    // What this request says about the model. A cut-off answer only says how
    // fast it writes; it stopped at the cap, so its tokens per pair are the
    // cap rather than the cost of a verdict.
    this._measure(context, {
      pairs: batch.length,
      completionTokens,
      reasoningTokens: thought,
      elapsedMs,
      truncated: truncated || items === null,
      warmingUp,
    });
    if (sizer) sizer.warmedUp = true;

    // Every verdict this request produced goes into the judge's memory, so
    // the next review asks only about what is new.
    const remember = (key, verdict) =>
      this._rememberVerdict(context, byKey.get(key), verdict);

    // The ordinary case: an answer that parses. Gaps in it are the model's
    // business, not a failure of the request.
    if (items) {
      const tally = this._recordVerdicts(items, keys, verdicts, remember);
      const missing = this._fillMissing(keys, verdicts, NO_ANSWER_REASON);
      this._log(
        `${head()}${spent}, ${tally.same} same / ${tally.different} different / ${tally.unsure + missing} unsure.`
      );
      // A readable answer that left pairs out is not an answered request:
      // those pairs are unsure because nobody answered them, and the meter
      // says so rather than showing a full green row.
      return report(
        0,
        missing === 0 ? 'answered' : 'partial',
        batch.length - missing
      );
    }

    // Everything below is a cut-off answer: the provider said so, or the text
    // stops in the middle of the array.
    const salvaged = this._recordVerdicts(
      salvageVerdictObjects(answer),
      keys,
      verdicts,
      remember
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
      if (tracker) tracker.failedRequests += 1;
      return report(0, 'failed', 0);
    }

    if (missing.length === 0) {
      this._log(
        `${head()}${spent} — the answer was cut off, salvaged all ${salvaged.recorded} verdict(s).`
      );
      return report(0, 'answered', salvaged.recorded);
    }

    // Nothing came back at all and there is still room in the window: the cap
    // was the problem, not the batch. Asking the same pairs with twice the
    // budget is one request; halving the batch would be two, and on a model
    // that spends its budget on thinking it would truncate again.
    if (salvaged.recorded === 0 && !budget.atBound && raises < MAX_CAP_RAISES) {
      // The warm-up gets the whole window in one step: it is a measurement,
      // it is four pairs, and the review cannot start without it. An ordinary
      // request doubles, because it has halving to fall back on.
      const raised = warmingUp ? budget.bound : Math.min(cap * 2, budget.bound);
      this._log(
        `${head()}${spent} — the answer hit the token limit and salvaged nothing, ` +
          `raising the cap from ${cap} to ${raised} and asking the same ${batch.length} pair(s) again.`
      );
      // Nothing usable came back, reasoning aside: this is the row the run
      // meter exists for, and it is asked again right after it.
      report(1, 'empty', 0);
      // Back to the front of the queue rather than straight on: with one
      // lane that is the very next request either way, and with several the
      // lane this ran in is free for the batch behind it.
      context.enqueue(batch, {
        isRetry: true,
        cap: raised,
        raises: raises + 1,
        warmup: warmingUp,
      });
      return;
    }

    if (warmingUp && salvaged.recorded === 0 && budget.atBound) {
      // The measurement itself does not fit, with the whole window behind it.
      // Splitting would not help: a review whose warm-up cannot answer four
      // pairs will not answer four hundred, and the operator has two switches
      // that can do something about it.
      if (typeof lane === 'function') lane();
      this._recordRequest(context, {
        index: meterIndex,
        items: batch.length,
        answers: 0,
        // Omitted rather than null where nothing was reported: the
        // contract's recordRequest reads an explicit null as a measured 0.
        tokens: spentHere.completion ?? undefined,
        thinkingTokens: spentHere.thinking ?? undefined,
        promptTokens: spentHere.prompt ?? undefined,
        ms: elapsedMs,
        outcome: 'failed',
      });
      throw this._unavailable(WARMUP_IMPOSSIBLE_MESSAGE(batch.length));
    }

    if (batch.length === 1) {
      this._fillMissing(keys, verdicts, SINGLE_PAIR_TRUNCATION_REASON);
      this._log(
        `${head()} — the answer hit the token limit for a single pair, giving up on ${batch[0].key}.`
      );
      return report(0, 'empty', 0);
    }

    const halves = splitInHalves(missing).filter((half) => half.length > 0);
    this._log(
      salvaged.recorded > 0
        ? `${head()}${spent} — the answer was cut off, salvaged ${salvaged.recorded}, re-asking ${missing.length} in ${halves.length} request(s).`
        : `${head()}${spent} — the answer hit the token limit and a raised cap did not help, halving into ${halves.map((half) => half.length).join(' + ')}.`
    );
    report(
      halves.length,
      salvaged.recorded > 0 ? 'partial' : 'empty',
      salvaged.recorded
    );
    // In order, at the front: the first half is the next request, so a
    // review with one lane asks in exactly the order it always did.
    for (const half of [...halves].reverse()) {
      context.enqueue(half, { isRetry: true });
    }
  }

  /**
   * Asks the model about every pair and returns one verdict per pair.
   *
   * `plan`, `systemPrompt`, `tracker` and `sizer` are what reviewScan() hands
   * in: it has sized the batches before the first request of the whole review,
   * so this must not size them again, the progress of a request belongs to the
   * review rather than to one round of it, and the model is measured once for
   * the review and not once per kind.
   *
   * The batch is taken off the front of a live queue rather than chunked up
   * front, because the size changes: the warm-up asks WARMUP_PAIRS, every
   * answer may resize the requests after it, and a cut-off answer puts its
   * two halves back at the front. A caller that brings no sizer — the tests,
   * and nothing else today — gets plan-sized batches from the first request
   * on, because a warm-up is a property of a review, not of one list of
   * pairs.
   *
   * `concurrency` is how many of those batches may be in flight at once. The
   * warm-up always runs alone, because it is the measurement everything
   * after it is sized by; from the answer that settles the measurement on,
   * a lane that frees takes the next batch at the size that is right then.
   * A stop leaves the queue and lets the requests in flight abort, and the
   * token budget is looked at before every dispatch — what is already out
   * finishes and counts.
   *
   * @param {AiReviewPair[]} pairs
   * @param {object} options
   * @param {'tags'|'correspondents'} options.kind
   * @param {{size:number, promptTokens:number, cap:number, limit:number}} [options.plan]
   * @param {string} [options.systemPrompt]
   * @param {object|null} [options.tracker]  the review's bookkeeping
   * @param {object|null} [options.sizer]    the review's measurement of the model
   * @param {number} [options.concurrency]   requests in flight at once, 1 by
   *   default: parallel lanes are a property of a review, and reviewScan()
   *   reads the setting once and hands the number down
   * @param {{days:number, model:string|null}|null} [options.memory]  the
   *   judge's memory of earlier verdicts, null when it is switched off
   * @returns {Promise<AiReviewPairsResult & {verdictsReused:number}>}
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
      return { verdicts, model, usage, verdictsReused: 0 };
    }

    const service = this._provider();
    const systemPrompt = options.systemPrompt || this.buildSystemPrompt(kind);
    const plan =
      options.plan || (await this._planBatchSize(kind, list, systemPrompt));
    const sizer = options.sizer || null;
    // The context window bounds this kind; a measurement may ask for less
    // than that, never for more.
    if (sizer) {
      sizer.maxSize = plan.size;
      sizer.batchSize = this._sizeFor(sizer, plan.size);
    }
    const size = sizer ? sizer.batchSize : plan.size;
    usage.batchSize = size;
    // A measured review says what it will actually spend; an unmeasured one
    // says the flat estimate and calls it provisional.
    const firstCap =
      sizer && sizer.calibrated ? this._capFor(sizer, size) : plan.cap;
    this._log(
      `${kind}: batch size ${size} of at most ${this.batchSize()} (context limit ${plan.limit} tokens), ` +
        `first batch ~${plan.promptTokens} prompt tokens, completion cap ${firstCap}` +
        (!sizer || sizer.calibrated
          ? '.'
          : ' — provisional, the model has not been measured yet.')
    );

    /** What the scheduler below takes its next request off. */
    const queue = [];
    const context = {
      kind,
      systemPrompt,
      service,
      verdicts,
      usage,
      state: {
        requestNumber: 0,
        lastStreamMs: 0,
        streamed: false,
        warmingUp: false,
        warmupReported: false,
        inFlight: 0,
      },
      tracker: options.tracker || null,
      sizer,
      memory: options.memory || null,
      /** A cut-off answer puts what it could not answer back at the front. */
      enqueue: (batch, batchOptions) =>
        queue.unshift({ batch, options: batchOptions }),
    };

    // What an earlier review already decided about these names: answered
    // here, never asked again. The band and the sweep pairs come through
    // this same list, so both are covered.
    const verdictsReused = await this._answerFromMemory(context, list, plan);
    const toAsk = list.filter((pair) => !verdicts.has(pair.key));
    for (let index = 0; index < toAsk.length; index += 1) {
      // One entry per pair; the scheduler takes as many as a request holds.
      queue.push({ pair: toAsk[index] });
    }

    const lanes = Math.max(
      1,
      Math.min(MAX_CONCURRENCY, Math.floor(Number(options.concurrency)) || 1)
    );
    await this._runQueue(context, queue, { lanes, plan });

    return { verdicts, model, usage, verdictsReused };
  }

  /**
   * The scheduler: takes batches off the queue and keeps `lanes` of them in
   * flight until the queue is empty and the last answer is in.
   *
   * A queue entry is either one pair waiting to be batched with its
   * neighbours or a whole batch a cut-off answer put back; the second kind is
   * asked exactly as it was handed over, because its size and its cap were
   * decided when the answer was cut off.
   *
   * @param {object} context
   * @param {Array<{pair?: AiReviewPair, batch?: AiReviewPair[], options?: object}>} queue
   * @param {{lanes:number, plan:object}} options
   * @returns {Promise<void>}
   */
  async _runQueue(context, queue, { lanes, plan }) {
    const { usage, sizer, tracker, state } = context;
    const inFlight = new Set();
    let failure = null;

    /** The batch the next request asks about, and how to ask it. */
    const next = () => {
      if (queue[0]?.batch) return queue.shift();
      const size = this._nextBatchSize(context, plan.size);
      const batch = [];
      while (batch.length < size && queue[0]?.pair) {
        batch.push(queue.shift().pair);
      }
      return batch.length > 0 ? { batch, options: undefined } : null;
    };

    /** How many requests may be out at once right now. */
    const lanesNow = () =>
      sizer && (!sizer.warmedUp || !sizer.calibrated) ? 1 : lanes;

    while (!failure && (queue.length > 0 || inFlight.size > 0)) {
      while (
        !failure &&
        queue.length > 0 &&
        inFlight.size < lanesNow() &&
        // A stop and a spent token budget both land here: what is in flight
        // finishes and counts, nothing new goes out.
        !this._stopped(tracker)
      ) {
        const item = next();
        if (!item) break;
        // A lane is busy from the dispatch until its request is counted as
        // done: its pairs have left the queue and its answer has not reached
        // requestsDone, which is exactly what the plan has to know about the
        // other lanes. A request that never reports — a stop in flight —
        // frees its lane when its task ends.
        const lane = this._openLane(tracker);
        const task = this._judgeBatch(item.batch, context, {
          ...(item.options || {}),
          lane,
        }).then(
          () => {},
          (error) => {
            failure = failure || error;
          }
        );
        // The set holds what is awaited, and the entry removes itself.
        const tracked = task.finally(() => {
          inFlight.delete(tracked);
          lane();
        });
        inFlight.add(tracked);
        usage.batchSize = sizer
          ? sizer.batchSize || usage.batchSize
          : plan.size;
      }
      if (inFlight.size === 0) break;
      // One answer at a time: the lane it frees is filled with a batch sized
      // by what that answer measured.
      await Promise.race(inFlight);
    }

    // A stop or a failure leaves requests out; they are waited for, so the
    // review reports the verdicts they still brought and nothing keeps
    // running after it returned.
    if (inFlight.size > 0) await Promise.all(inFlight);
    state.inFlight = 0;
    if (failure) throw failure;
  }

  /**
   * One lane of the scheduler, as a function that closes it. Closing twice
   * is closing once: the request closes its own lane when it is counted, and
   * the task closes whatever is left when it ends.
   *
   * @param {object|null} tracker
   * @returns {() => void}
   */
  _openLane(tracker) {
    if (!tracker) return () => {};
    tracker.lanesBusy += 1;
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      tracker.lanesBusy = Math.max(0, tracker.lanesBusy - 1);
    };
  }

  /**
   * Answers what the judge already knows and says so.
   *
   * The pairs an earlier review decided about — same names, a verdict that
   * was not "unsure" — never reach the queue. The plan is corrected in the
   * same breath: those requests will not be made, so the page's denominator
   * must not keep counting them.
   *
   * @param {object} context
   * @param {AiReviewPair[]} list
   * @param {{size:number}} plan
   * @returns {Promise<number>} pairs answered from memory
   */
  async _answerFromMemory(context, list, plan) {
    const { kind, memory, verdicts, tracker, sizer } = context;
    if (!memory) return 0;
    const remembered = await this._rememberedVerdicts(kind, list, memory);
    if (remembered.size === 0) return 0;
    for (const [key, verdict] of remembered) verdicts.set(key, verdict);
    this._log(
      `${kind}: ${remembered.size} pair(s) answered from memory, ` +
        `${list.length - remembered.size} asked.`
    );
    if (tracker) {
      const size = Math.max(1, this._sizeFor(sizer, plan.size));
      const saved =
        Math.ceil(list.length / size) -
        Math.ceil((list.length - remembered.size) / size);
      tracker.verdictsReused += remembered.size;
      // Answered, and never asked: both ends of the bar know it.
      tracker.pairsJudged += remembered.size;
      tracker.pairsAsked += remembered.size;
      tracker.requestsPlanned = Math.max(
        tracker.requestsDone,
        tracker.requestsPlanned - Math.max(0, saved)
      );
      const left = list.length - remembered.size;
      this._report(tracker, {
        kind,
        verdictsReused: tracker.verdictsReused,
        pairsJudged: tracker.pairsJudged,
        requestsPlanned: tracker.requestsPlanned,
        message:
          left > 0
            ? `${remembered.size} pair(s) answered from an earlier review, ${left} to ask about…`
            : `${remembered.size} pair(s) answered from an earlier review; nothing left to ask.`,
      });
    }
    return remembered.size;
  }

  /**
   * How many pairs the next request asks about: the warm-up's handful while
   * the model is unmeasured, otherwise what the measurement affords.
   *
   * @param {object} context
   * @param {number} fallback  the plan's size, for a caller without a sizer
   * @returns {number}
   */
  _nextBatchSize(context, fallback) {
    const { sizer } = context;
    if (!sizer) return Math.max(1, fallback);
    if (!sizer.warmedUp) {
      return Math.max(1, Math.min(WARMUP_PAIRS, sizer.maxSize));
    }
    return Math.max(1, sizer.batchSize || fallback);
  }

  /**
   * The completion budget of one sweep request: enough room for a tenth of
   * the names it carries to come back inside a group. A group nobody proposes
   * costs nothing, and a cap that is one group short costs the whole tail of
   * the answer.
   *
   * @param {number} nameCount
   * @returns {number}
   */
  _sweepCap(nameCount) {
    const groups = Math.ceil(Math.max(1, nameCount) / SWEEP_GROUPED_SHARE);
    return SWEEP_TOKENS_PER_GROUP * groups + TOKENS_OVERHEAD;
  }

  /**
   * One report from inside a sweep request the provider is streaming. The
   * sweep has no pairs to count answers against, so it reports what it has:
   * whether the model is thinking and what that has cost so far.
   *
   * @param {object} context
   * @param {AiReviewEntity[]} chunk
   * @param {import('./aiGenerateOptions').GenerateTextProgress} update
   */
  _onSweepStream(context, chunk, update) {
    const { tracker, state } = context;
    if (!tracker || !tracker.onProgress) return;
    const now = Date.now();
    const interval = Number(this.progressIntervalMs);
    if (
      now - state.lastStreamMs <
      (interval >= 0 ? interval : PROGRESS_INTERVAL_MS)
    ) {
      return;
    }
    state.lastStreamMs = now;
    const thinking = update?.thinking === true;
    const produced = Number(update?.completionTokens);
    const requestTokens = Number.isFinite(produced) ? produced : null;
    this._report(tracker, {
      requestPairs: chunk.length,
      requestAnswers: 0,
      requestTokens,
      thinking,
      tokens: (tracker.tokens || 0) + (requestTokens || 0),
      message: thinking
        ? `The model is thinking… (${requestTokens || 0} tokens so far)`
        : `Reading ${chunk.length} names for synonyms and translations…`,
    });
  }

  /**
   * The groups of one sweep answer, checked against the names that request
   * carried. An id the request never showed the model is dropped, exactly as
   * an invented pair id is dropped from a verdict.
   *
   * @param {object[]} items
   * @param {AiReviewEntity[]} chunk
   * @returns {SweepProposal[]}
   */
  _sweepProposals(items, chunk) {
    const allowed = new Set(chunk.map((entity) => Number(entity.id)));
    const proposals = [];
    for (const item of Array.isArray(items) ? items : []) {
      const ids = [
        ...new Set(
          (Array.isArray(item?.ids) ? item.ids : [])
            .map((id) => Number(String(id).trim()))
            .filter((id) => Number.isInteger(id) && allowed.has(id))
        ),
      ];
      if (ids.length < 2) continue;
      proposals.push({
        ids,
        basis: toSweepBasis(item?.basis),
        reason: toReason(item?.reason),
      });
    }
    return proposals;
  }

  /**
   * One sweep request: a chunk of names in, the groups the model proposes
   * out.
   *
   * A cut-off answer is treated the way a cut-off batch of verdicts is: what
   * the model managed to write is salvaged, and an answer that salvaged
   * nothing is asked once more with a raised cap. There is no halving to fall
   * back on — the names of a chunk are not a question that gets smaller — so
   * a second cut-off simply costs this chunk its proposals.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {AiReviewEntity[]} chunk
   * @param {object} context  service, usage, tracker, sizer, state
   * @param {{cap?: number|null, raises?: number}} [options]
   * @returns {Promise<SweepProposal[]>}
   */
  async _sweepChunk(
    kind,
    chunk,
    context,
    { cap: wanted = null, raises = 0 } = {}
  ) {
    const { service, usage, tracker, sizer, state } = context;
    if (this._stopped(tracker)) return [];

    const systemPrompt = this.buildSweepSystemPrompt(kind);
    const userPrompt = this.buildSweepUserPrompt(kind, chunk);
    const promptTokens = await this._promptTokens(systemPrompt, userPrompt);
    const budget = this._capForRequest(sizer, 0, promptTokens, {
      wanted: wanted == null ? this._sweepCap(chunk.length) : wanted,
    });
    const cap = budget.cap;

    state.lastStreamMs = 0;
    usage.requests += 1;
    const startedAt = Date.now();
    const meterIndex = this._nextRequestIndex(tracker);
    const spentHere = { prompt: null, completion: null, thinking: null };
    /** One row of the run meter for this sweep request; see _askBatch. */
    const meter = (outcome, answers) => ({
      index: meterIndex,
      items: chunk.length,
      answers,
      tokens: spentHere.completion ?? undefined,
      thinkingTokens: spentHere.thinking ?? undefined,
      promptTokens: spentHere.prompt ?? undefined,
      ms: Date.now() - startedAt,
      outcome,
    });
    const head = () =>
      `sweep ${kind}: ${chunk.length} name(s), ~${promptTokens} prompt tokens, ` +
      `cap ${cap}, ${Date.now() - startedAt}ms`;

    const requestOptions = {
      systemPrompt,
      temperature: 0,
      maxTokens: cap,
      // The same switch as every judge request: off unless the operator
      // turned it on. A sweep is a lookup, not a deliberation.
      reasoning: Boolean(sizer && sizer.thinking),
    };
    const judgeModel = this.judgeModel();
    if (judgeModel !== '') requestOptions.model = judgeModel;
    if (tracker?.signal) requestOptions.signal = tracker.signal;
    if (tracker?.onProgress) {
      requestOptions.onProgress = (update) =>
        this._onSweepStream(context, chunk, update);
    }

    let answer;
    let truncated = false;
    try {
      answer = await service.generateText(userPrompt, requestOptions);
    } catch (error) {
      if (this._stopped(tracker)) {
        this._log(`${head()} — stopped while waiting for the answer.`);
        return [];
      }
      if (error?.code !== TRUNCATION_ERROR_CODE) {
        usage.failedRequests += 1;
        console.warn(
          `${LOG_PREFIX} ${head()} — failed: ${error?.message || 'the AI provider could not be reached'}.`
        );
        this._readSpend(service, spentHere);
        this._recordRequest(context, meter('failed', 0));
        this._afterSweepRequest(kind, context);
        return [];
      }
      truncated = true;
      answer = this._partialAnswerOf(error);
    }

    await this._countRequestTokens(context, promptTokens, answer);
    this._readSpend(service, spentHere);

    let items = null;
    let parseError = null;
    if (!truncated) {
      try {
        items = parseVerdictArray(answer);
      } catch (error) {
        parseError = error;
      }
    }
    if (items === null) {
      const salvaged = salvageSweepGroups(answer);
      if (
        salvaged.length === 0 &&
        truncated &&
        !budget.atBound &&
        raises < MAX_CAP_RAISES
      ) {
        const raised = Math.min(cap * 2, budget.bound);
        this._log(
          `${head()} — the answer hit the token limit and salvaged nothing, ` +
            `raising the cap from ${cap} to ${raised} and reading the same names again.`
        );
        if (tracker) tracker.requestsPlanned += 1;
        this._recordRequest(context, meter('empty', 0));
        this._afterSweepRequest(kind, context);
        return this._sweepChunk(kind, chunk, context, {
          cap: raised,
          raises: raises + 1,
        });
      }
      if (salvaged.length === 0) {
        usage.failedRequests += 1;
        console.warn(
          `${LOG_PREFIX} ${head()} — failed: ` +
            `${truncated ? 'the answer was cut off with nothing usable in it' : parseError?.message || 'the answer could not be read'}. ` +
            `Raw answer: ${String(answer ?? '').slice(0, RAW_ANSWER_LOG_LENGTH) || '(none)'}`
        );
        this._recordRequest(context, meter(truncated ? 'empty' : 'failed', 0));
        this._afterSweepRequest(kind, context);
        return [];
      }
      this._log(
        `${head()} — the answer was cut off, salvaged ${salvaged.length} group(s).`
      );
      items = salvaged;
    }

    const proposals = this._sweepProposals(items, chunk);
    if (!truncated) {
      this._log(`${head()} — ${proposals.length} group(s) proposed.`);
    }
    // A sweep answers with the groups it found among the names it was shown;
    // finding none is a complete answer, not an empty one. Only a cut-off
    // answer left something behind.
    this._recordRequest(
      context,
      meter(truncated ? 'partial' : 'answered', chunk.length)
    );
    this._afterSweepRequest(kind, context);
    return proposals;
  }

  /**
   * What an answered sweep request adds to the progress: one request done,
   * the running token total, and the line the page waits on next.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {object} context
   */
  _afterSweepRequest(kind, context) {
    const { tracker } = context;
    if (!tracker) return;
    tracker.requestsDone += 1;
    tracker.kind = kind;
    this._report(tracker, {
      phase: REVIEW_PHASES.SWEEPING,
      kind,
      requestsDone: tracker.requestsDone,
      requestsPlanned: tracker.requestsPlanned,
      tokens: tracker.tokens,
      failedRequests: tracker.failedRequests,
      requestPairs: null,
      requestAnswers: 0,
      requestTokens: null,
      thinking: false,
      // The judging requests of this kind are not in the plan yet — they are
      // counted once the sweep's pairs are part of it — so the generic line
      // would read "waiting for the last answer" after the last chunk.
      message:
        tracker.requestsDone < tracker.requestsPlanned
          ? this._requestMessage(tracker)
          : 'The sweep is done, gathering the evidence…',
    });
    this._checkTokenBudget(tracker);
  }

  /**
   * The semantic sweep of one kind: the model reads every name, in chunks,
   * and proposes the groups spelling will never produce.
   *
   * What comes back are candidate pairs, not groups: a proposed pair that is
   * already inside a scan group, already a candidate of the band or dismissed
   * is dropped, and everything else is judged with evidence like any other
   * candidate.
   *
   * A group whose names sit in two different chunks cannot be found. That is
   * the accepted cost of a bounded request: a sweep that showed the model
   * every name at once would be the whole archive in one prompt.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {AiReviewEntity[]} entities  every entity of the kind
   * @param {object} options
   * @param {Set<string>} options.known      pair keys the review already has
   * @param {Set<string>} options.dismissed  pair keys the user put away
   * @param {object} options.service         the provider
   * @param {object|null} options.tracker
   * @param {object|null} options.sizer
   * @returns {Promise<{pairs: AiReviewPair[], groups: number, usage: {requests:number, tokens:number|null, failedRequests:number}}>}
   */
  async _sweepKind(kind, entities, options) {
    const { known, dismissed, service, tracker, sizer } = options;
    const usage = { requests: 0, tokens: null, failedRequests: 0 };
    /** @type {AiReviewPair[]} */
    const pairs = [];
    const result = { pairs, groups: 0, usage };

    const names = (Array.isArray(entities) ? entities : []).filter(
      (entity) =>
        entity &&
        Number.isInteger(Number(entity.id)) &&
        String(entity.name ?? '').trim() !== ''
    );
    if (names.length < 2) return result;
    if (names.length > SWEEP_MAX_NAMES) {
      this._log(
        `sweep: ${kind}, ${names.length} names is more than the ${SWEEP_MAX_NAMES} ` +
          'a sweep reads, so it was skipped — a model that sees a fortieth of the ' +
          'archive per request proposes little worth judging.'
      );
      return result;
    }

    const chunkSize = this.sweepNames();
    const chunks = [];
    for (let index = 0; index < names.length; index += chunkSize) {
      chunks.push(names.slice(index, index + chunkSize));
    }

    // The plan knows what the sweep will cost before the first request of it
    // is made, so the page's bar does not grow a denominator mid-sweep.
    if (tracker) tracker.requestsPlanned += chunks.length;
    const words = KIND_WORDS[kind] || KIND_WORDS.tags;
    const announcement = {
      phase: REVIEW_PHASES.SWEEPING,
      kind,
      message:
        `Asking the model for synonyms and translations among ${names.length} ` +
        `${words.singular} names…`,
    };
    if (tracker) announcement.requestsPlanned = tracker.requestsPlanned;
    this._report(tracker, announcement);

    const context = {
      service,
      usage,
      tracker,
      sizer,
      state: { lastStreamMs: 0 },
    };
    const byId = new Map(names.map((entity) => [Number(entity.id), entity]));
    const seen = new Set();
    for (const chunk of chunks) {
      if (this._stopped(tracker)) break;
      const proposals = await this._sweepChunk(kind, chunk, context);
      result.groups += proposals.length;
      for (const proposal of proposals) {
        for (let i = 0; i < proposal.ids.length; i += 1) {
          for (let j = i + 1; j < proposal.ids.length; j += 1) {
            const [low, high] =
              proposal.ids[i] < proposal.ids[j]
                ? [proposal.ids[i], proposal.ids[j]]
                : [proposal.ids[j], proposal.ids[i]];
            const key = entityNameMatcher.pairKey(kind, low, high);
            if (known.has(key) || dismissed.has(key) || seen.has(key)) continue;
            seen.add(key);
            pairs.push({
              key,
              a: byId.get(low),
              b: byId.get(high),
              matchedBy: entityNameMatcher.MATCH_REASONS.SEMANTIC,
              score: SEMANTIC_SCORE,
              sweepBasis: proposal.basis,
              sweepReason: proposal.reason,
            });
          }
        }
      }
    }

    this._log(
      `sweep: ${kind}, ${names.length} names in ${usage.requests} request(s), ` +
        `${result.groups} group(s) proposed, ${pairs.length} new pair(s) to judge.`
    );
    return result;
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
   * @returns {{pairs: AiReviewPair[], candidates: AiReviewPair[], candidateEdges: Map<string, {score:number, reason:string}>, settled: Map<string, AiVerdict>, insideOneGroup: Set<string>}}
   *   `insideOneGroup` is every pair key a scan group already holds, whether
   *   that group is judged or not; the semantic sweep needs it to know what
   *   it must not propose again.
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
      insideOneGroup,
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
   * Adds document excerpts to the entities of the pairs that have nothing
   * but a name behind them — the ones the matcher linked by spelling alone,
   * and the ones the semantic sweep proposed. This is the evidence that
   * separates "Kontoauszug" from "Kontoumzug", and it is the expensive kind:
   * one read and a few hundred characters of prompt per entity.
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
   *   `spellingOnly` counts the pairs a spelling tier linked, for the log
   *   line; the pairs of the sweep are counted with the sweep.
   */
  async _addExcerpts(kind, pairs, store, { force = false } = {}) {
    const paperlessService = require('./paperlessService');
    const worthIt = force
      ? pairs
      : pairs.filter((pair) => EXCERPT_REASON_SET.has(pair.matchedBy));
    // What the log calls spelling-only stays what it always was; a pair the
    // sweep proposed is counted where the sweep is counted.
    const spellingOnly = force
      ? pairs.length
      : worthIt.filter((pair) => SPELLING_ONLY_REASON_SET.has(pair.matchedBy))
          .length;
    if (
      worthIt.length === 0 ||
      typeof paperlessService.getRecentDocumentExcerptsByEntity !== 'function'
    ) {
      return { pairs, spellingOnly };
    }

    const ids = [
      ...new Set(worthIt.flatMap((pair) => [pair.a.id, pair.b.id])),
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

    const keys = new Set(worthIt.map((pair) => pair.key));
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
      spellingOnly,
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
   * The scan the merge service still has in its cache for these options, or
   * null. It never scans.
   *
   * A scan is a walk over every tag and every correspondent of the archive
   * and costs Paperless-ngx a page request per hundred of them. The estimate
   * is asked again on every move of a slider, so it reads what is there and
   * says "scan first" when there is nothing — the same three conditions the
   * scan itself applies to its cache: the options, the age, and the
   * dismissals that may have changed behind the service's back.
   *
   * @param {{kind:string, threshold:number, includeDismissed:boolean}} options
   * @returns {Promise<object|null>} DuplicateScanResult or null
   */
  async _cachedScan({ kind, threshold, includeDismissed }) {
    const duplicateMergeService = require('./duplicateMergeService');
    const cache = duplicateMergeService._scanCache;
    if (!(cache instanceof Map)) return null;
    const cached = cache.get(
      `${kind}|${threshold}|${includeDismissed ? 1 : 0}`
    );
    if (!cached) return null;
    const age = Date.now() - cached.at;
    if (!(age < (Number(duplicateMergeService.scanCacheMs) || 0))) return null;
    try {
      const kinds =
        kind === duplicateMergeService.KIND_ALL
          ? [...entityNameMatcher.KIND_LIST]
          : [kind];
      const fingerprint = await duplicateMergeService._dismissalFingerprint(
        kinds,
        includeDismissed
      );
      if (cached.dismissals !== fingerprint) return null;
    } catch {
      // A fingerprint that cannot be read is a cache that cannot be trusted.
      return null;
    }
    return cached.result;
  }

  /**
   * What the next AI review would cost, without asking anybody and without
   * scanning.
   *
   * Two pages call this on every move of a lever, so it may read nothing but
   * what is already there: the scan the merge service still holds, the
   * judge's measurement of this model, and what the last review of this
   * archive actually cost. When there is no cached scan for these options
   * there is nothing honest to say — the answer is `needsScan: true` and the
   * page asks for a scan instead of showing a number it made up.
   *
   * The pairs come out of the same `_pairsForKind` the review itself uses,
   * with an empty band: the band needs the entity list, which is a read this
   * must not make. So `items` is what the groups of the scan alone would
   * cost, and a review that also asks about the band asks about more.
   *
   * @param {object} [options]
   * @param {'tags'|'correspondents'|'all'} [options.kind]
   * @param {number} [options.threshold]
   * @param {boolean} [options.sweep]     the semantic sweep is on
   * @param {boolean} [options.excerpts]  document excerpts are on
   * @returns {Promise<object>} an AiReviewEstimate
   */
  async estimateReview(options = {}) {
    const duplicateMergeService = require('./duplicateMergeService');
    const documentModel = require('../models/document');
    const kind = options.kind || duplicateMergeService.KIND_ALL;
    const threshold = Number.isFinite(Number(options.threshold))
      ? Number(options.threshold)
      : entityNameMatcher.DEFAULT_THRESHOLD;
    const sweep = options.sweep === true;
    const excerpts = options.excerpts !== false && this.excerptsEnabled();

    const model = this.modelName();
    const thinking = this.thinkingEnabled();
    const lanes = this.concurrency();
    const batchSize = this.batchSize();
    const [calibration, lastRun] = await Promise.all([
      model
        ? documentModel.getAiCalibration(model, thinking)
        : Promise.resolve(null),
      documentModel.getLastAiRunStats('review', model),
    ]);

    // Either state of the page's "show dismissed pairs" box answers; what is
    // cached is what the user last scanned with.
    const scan =
      (await this._cachedScan({ kind, threshold, includeDismissed: false })) ??
      (await this._cachedScan({ kind, threshold, includeDismissed: true }));

    const shape = (extra) => ({
      model,
      thinking,
      lastRun,
      ...extra,
    });

    if (!scan) {
      return shape({
        ...estimateRun({ items: 0, batchSize, lanes }),
        // Nothing was measured, so nothing is claimed — whatever the model
        // calibration would have allowed the arithmetic to say.
        basis: 'guess',
        measuredAt: null,
        itemsByRule: 0,
        groups: 0,
        pairs: 0,
        needsScan: true,
        extra: { sweepRequests: 0, excerptReads: 0 },
      });
    }

    const kinds =
      kind === duplicateMergeService.KIND_ALL
        ? [...entityNameMatcher.KIND_LIST]
        : [kind];
    let groupCount = 0;
    let asked = 0;
    let settledByRule = 0;
    let sweepRequests = 0;
    const excerptEntities = new Set();
    for (const one of kinds) {
      const groups = (scan.groups || []).filter((group) => group.kind === one);
      groupCount += groups.length;
      const built = this._pairsForKind(one, groups, []);
      asked += built.pairs.length;
      settledByRule += built.settled.size;
      if (excerpts) {
        for (const pair of built.pairs) {
          if (!EXCERPT_REASON_SET.has(pair.matchedBy)) continue;
          for (const entity of [pair.a, pair.b]) {
            const id = Number(entity?.id);
            if (Number.isInteger(id)) excerptEntities.add(`${one}:${id}`);
          }
        }
      }
      if (sweep) {
        const names = Number(scan.totals?.[one]);
        if (Number.isFinite(names) && names >= 2 && names <= SWEEP_MAX_NAMES) {
          sweepRequests += Math.ceil(names / this.sweepNames());
        }
      }
    }

    return shape({
      ...estimateRun({
        items: asked,
        batchSize,
        lanes,
        calibration,
        lastRun,
        thinking,
      }),
      itemsByRule: settledByRule,
      groups: groupCount,
      // Every pair of the scan's groups: what the model is asked about plus
      // what a spelling rule settled before it was.
      pairs: asked + settledByRule,
      needsScan: false,
      // What comes on top of `requests`: the sweep asks its own, and the
      // excerpts are reads of Paperless-ngx rather than model requests.
      extra: { sweepRequests, excerptReads: excerptEntities.size },
    });
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
   * The work happens in two passes. Pass one reads the archive, builds the
   * pairs, settles what a rule settles, gathers the evidence and sizes the
   * batches — for every kind, before a single request leaves the house, so
   * the page knows how many requests the whole review will take before the
   * first one. Pass two judges, kind after kind, and reports every answer.
   *
   * @param {AiReviewOptions} options
   * @param {AiReviewControl} [control]  what the job that runs this review
   *   hands in: a signal to stop on, a progress sink, a token budget. An
   *   empty control is a review nobody watches.
   * @returns {Promise<object>} DuplicateAiReviewResult (see schemas.js): the
   *   scan result with `groups` judged and an `aiReview` of type
   *   {@link AiReviewSummary}
   */
  async reviewScan(options = {}, control = {}) {
    if (!this.isEnabled()) {
      throw this._unavailable(
        'The AI review is switched off (DUPLICATES_AI_REVIEW)'
      );
    }
    const duplicateMergeService = require('./duplicateMergeService');
    const paperlessService = require('./paperlessService');
    const documentModel = require('../models/document');

    const startedAt = Date.now();
    const tracker = this._reviewTracker(control);
    // What an earlier review measured about this model, from the table when
    // this process has not measured it itself. It has to be read before the
    // sizer, because the sizer is what reads it.
    await this._loadCalibration();
    // One measurement for the whole review: the model does not get faster
    // between two kinds, and the warm-up is worth paying for once.
    const sizer = this._sizer();
    if (sizer.fromMemory) {
      this._log(
        `calibrated from a previous review: ${Math.round(sizer.tokensPerPair)} tokens per pair, ` +
          `${Math.round(sizer.tokensPerSecond)} tokens/s, thinking ${sizer.thinking ? 'on' : 'off'}.`
      );
    }
    // What the judge already decided about a pair of names, pruned to what
    // the operator still wants remembered. Null switches the memory off for
    // the whole review: nothing is read and nothing is written.
    const memory = await this._openVerdictMemory();
    // How many requests this review keeps in flight. One while the model is
    // being measured, whatever this says. `options.concurrency` is this
    // review's own answer to the question the setting answers for every
    // review: the page offers it as a lever, and it is clamped rather than
    // refused, because a slider that can send 40 is the page's bug and not a
    // reason to refuse the run.
    const concurrency = this.concurrency(options.concurrency);
    if (tracker) tracker.concurrency = concurrency;
    const requested = options.kind || 'all';
    const kinds =
      requested === 'all' ? [...entityNameMatcher.KIND_LIST] : [requested];

    // A review that cannot ask anybody should not read an archive first.
    // The sweep asks this one directly; reviewPairs() asks for its own.
    const provider = this._provider();

    this._report(tracker, {
      phase: REVIEW_PHASES.SCANNING,
      kind: null,
      message: `Scanning ${kinds.join(' and ')} for duplicate names…`,
    });

    // Never `fresh`: the page has just scanned, and a review that scans the
    // same archive again costs the user thirteen seconds for the same answer.
    // The flag is dropped rather than passed on, so a route that forwards the
    // page's own scan options cannot buy a second scan by accident.
    const scan = await duplicateMergeService.scan({
      ...options,
      fresh: false,
    });
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
    // The semantic sweep is off unless the page asks for it, and it is the
    // one part of a review that reads names the matcher never linked.
    const semanticSweep = optedIn(options.semanticSweep);

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
    let pairsNotJudged = 0;
    let sweepRequests = 0;
    let sweepProposals = 0;
    let verdictsReused = 0;
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

    // ---------------------------------------------------------- pass one
    // Everything that decides what this review will cost, for every kind,
    // before the first request: the pairs, the evidence, the batch sizes.
    /** @type {object[]} */
    const plans = [];
    for (const kind of kinds) {
      const groups = (scan.groups || []).filter((group) => group.kind === kind);
      const selected = this._selectGroups(groups, selectedIds, minConfidence);
      const selectedGroupIds = new Set(selected.map((group) => group.id));
      groupsJudged += selected.length;
      groupsSkipped += groups.length - selected.length;

      // Without the band nothing needs the entity list either, which is what
      // makes a targeted review cheap: one scan, no second read per kind.
      // The sweep needs the same list, so it buys the read back.
      let entities = [];
      let band = [];
      const dismissed = new Set();
      if ((includeCandidates || semanticSweep) && !this._stopped(tracker)) {
        entities = await paperlessService.listEntities(kind);

        if (!options.includeDismissed) {
          const rows = await documentModel.listEntityMergeDismissals(kind);
          for (const row of rows) {
            dismissed.add(entityNameMatcher.pairKey(kind, row.idA, row.idB));
          }
        }
      }
      if (includeCandidates && !this._stopped(tracker)) {
        band = entityNameMatcher.findCandidatePairs(entities, {
          kind,
          floor: this.candidateFloor(),
          threshold: scan.threshold,
          dismissedPairs: [...dismissed],
          limit: CANDIDATE_LIMIT,
        });
      }

      const { pairs, candidates, candidateEdges, settled, insideOneGroup } =
        this._pairsForKind(kind, groups, band, selectedGroupIds);
      candidateCount += candidates.length;
      spellingRules += settled.size;
      if (tracker) tracker.spellingRules = spellingRules;

      // The semantic sweep, after the scan and before the evidence: what it
      // proposes is a candidate pair like any other from here on, so it has
      // to exist before the titles and excerpts are read.
      const reviewed = [...candidates];
      let toJudge = pairs;
      if (semanticSweep && !this._stopped(tracker)) {
        const swept = await this._sweepKind(kind, entities, {
          known: new Set([...insideOneGroup, ...candidateEdges.keys()]),
          dismissed,
          service: provider,
          tracker,
          sizer,
        });
        requests += swept.usage.requests;
        sweepRequests += swept.usage.requests;
        failedRequests += swept.usage.failedRequests;
        if (swept.usage.tokens != null) {
          tokens = (tokens || 0) + swept.usage.tokens;
        }
        sweepProposals += swept.pairs.length;
        for (const pair of swept.pairs) {
          candidateEdges.set(pair.key, {
            score: pair.score,
            reason: pair.matchedBy,
          });
          reviewed.push(pair);
        }
        toJudge = [...pairs, ...swept.pairs];
      }
      judged += toJudge.length;

      // The evidence is gathered before the start line, so the line can say
      // what the model is about to see rather than what it was offered.
      let asked = toJudge;
      let spellingOnly = 0;
      const fetchedBefore = excerptStore.entities.size;
      const gathering = toJudge.length > 0 && !this._stopped(tracker);
      if (gathering && withTitles) {
        this._report(tracker, {
          phase: REVIEW_PHASES.EVIDENCE,
          kind,
          message: `Reading titles and neighbours for ${this._entityCount(toJudge)} entities…`,
        });
        asked = await this._addTitles(kind, asked);
        asked = await this._addNeighbourhood(kind, asked, excerptStore);
      }
      if (gathering && withExcerpts) {
        const evidenceEntities = this._entityCount(
          toJudge.filter((pair) => EXCERPT_REASON_SET.has(pair.matchedBy))
        );
        if (evidenceEntities > 0) {
          this._report(tracker, {
            phase: REVIEW_PHASES.EVIDENCE,
            kind,
            message: `Reading excerpts for ${evidenceEntities} entities…`,
          });
        }
        const evidence = await this._addExcerpts(kind, asked, excerptStore);
        asked = evidence.pairs;
        spellingOnly = evidence.spellingOnly;
      }
      const fetchedHere = excerptStore.entities.size - fetchedBefore;
      if (tracker) tracker.excerpts = excerptStore.entities.size;

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
          ...(semanticSweep
            ? [`${reviewed.length - candidates.length} pair(s) from the sweep`]
            : []),
          ...(settled.size > 0
            ? [`${settled.size} pair(s) settled by a spelling rule`]
            : []),
          `${toJudge.length} pair(s) to judge`,
          `titles ${withTitles ? 'on' : 'off'}`,
          withExcerpts
            ? `excerpts on for ${spellingOnly} spelling-only pair(s), ` +
              `${fetchedHere} entity/entities fetched`
            : 'excerpts off',
          `model ${model || 'unknown'}`,
        ].join(', ') + '.'
      );

      const systemPrompt = this.buildSystemPrompt(kind);
      let plan = null;
      if (asked.length > 0 && !this._stopped(tracker)) {
        plan = await this._planBatchSize(kind, asked, systemPrompt);
        if (tracker) {
          // Provisional while the model is unmeasured: the warm-up replaces
          // both numbers with what this model actually costs.
          const size = this._sizeFor(sizer, plan.size);
          const planned = Math.ceil(asked.length / size);
          tracker.requestsPlanned += planned;
          tracker.pairsTotal += asked.length;
          tracker.estimatedTokens +=
            planned * (plan.promptTokens + this._capFor(sizer, size));
        }
      }
      plans.push({
        kind,
        groups,
        entities,
        // Band and sweep together: both are pairs that become a group only
        // when the model confirms them.
        candidates: reviewed,
        candidateEdges,
        settled,
        asked,
        plan,
        systemPrompt,
      });
    }

    // What this run is, in the terms `ai_run_stats` keeps it: the pairs the
    // model is asked about and the pairs a spelling rule settled before it
    // was. Told once pass one is over, so a run that is stopped during pass
    // two still writes down the size of the question it was asked.
    if (tracker) {
      this._noteRun(tracker, {
        items: tracker.pairsTotal,
        itemsByRule: spellingRules,
        model,
        thinking: Boolean(sizer && sizer.thinking),
      });
    }

    if (tracker && tracker.requestsPlanned > 0 && !this._stopped(tracker)) {
      // The plan as pass one knows it. On an unmeasured model both the
      // denominator and the estimate are provisional: the warm-up is the
      // first request, and its answer settles them.
      const firstSize = plans.find((one) => one.plan)?.plan.size ?? 1;
      if (!sizer.calibrated) sizer.warmupAnnounced = true;
      this._report(tracker, {
        phase: sizer.calibrated
          ? REVIEW_PHASES.JUDGING
          : REVIEW_PHASES.WARMING_UP,
        kind: null,
        requestsPlanned: tracker.requestsPlanned,
        pairsTotal: tracker.pairsTotal,
        estimatedTokens: tracker.estimatedTokens,
        spellingRules: tracker.spellingRules,
        excerpts: tracker.excerpts,
        batchSize: sizer.calibrated
          ? this._sizeFor(sizer, firstSize)
          : Math.max(1, Math.min(WARMUP_PAIRS, firstSize)),
        calibrated: sizer.calibrated,
        concurrency,
        message: sizer.calibrated
          ? `Asking the model, request 1 of ${tracker.requestsPlanned}`
          : WARMUP_MESSAGE,
      });
    }

    // ---------------------------------------------------------- pass two
    for (const planned of plans) {
      const {
        kind,
        groups,
        entities,
        candidates,
        candidateEdges,
        settled,
        asked,
        plan,
        systemPrompt,
      } = planned;

      if (!plan || this._stopped(tracker)) {
        // Nothing to ask about, or the review stopped before this kind. A
        // group whose members a rule settled still carries its verdicts; the
        // pairs nobody asked about get none, so they cannot become a group.
        scanGroups.push(
          ...groups.map((group) => this._withVerdicts(group, settled))
        );
        pairsNotJudged += asked.length;
        continue;
      }
      if (tracker) tracker.kind = kind;

      const review = await this.reviewPairs(asked, {
        kind,
        plan,
        systemPrompt,
        tracker,
        sizer,
        concurrency,
        memory,
      });
      foldUsage(review.usage);
      verdictsReused += review.verdictsReused || 0;
      model = review.model || model;

      // Second round: a pair the model could not decide and had no excerpts
      // for is asked again, this time with the documents. That is the cheap
      // half of the evidence budget — it is spent only where the first answer
      // says the names alone were not enough.
      const unsureWithoutExcerpts =
        withExcerpts && !this._stopped(tracker)
          ? asked.filter(
              (pair) =>
                review.verdicts.get(pair.key)?.verdict === AI_VERDICTS.UNSURE &&
                (pair.a?.sampleExcerpts || []).length === 0 &&
                (pair.b?.sampleExcerpts || []).length === 0
            )
          : [];
      if (unsureWithoutExcerpts.length > 0) {
        const beforeEscalation = excerptStore.entities.size;
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
            `${excerptStore.entities.size - beforeEscalation} entity/entities fetched.`
        );
        if (tracker) tracker.excerpts = excerptStore.entities.size;
        if (again.length > 0 && !this._stopped(tracker)) {
          // The second round is requests the plan did not know about, so the
          // page is told about them before they are made.
          const secondPlan = await this._planBatchSize(
            kind,
            again,
            systemPrompt
          );
          escalated += again.length;
          if (tracker) {
            tracker.requestsPlanned += Math.ceil(
              again.length / this._sizeFor(sizer, secondPlan.size)
            );
            // The escalated pairs are asked a second time, so they are due a
            // second time: both ends of the bar grow, and what the page shows
            // as judged never overtakes what it shows as planned.
            tracker.pairsTotal += again.length;
            tracker.escalated = escalated;
            this._report(tracker, {
              phase: REVIEW_PHASES.ESCALATING,
              kind,
              requestsPlanned: tracker.requestsPlanned,
              pairsTotal: tracker.pairsTotal,
              escalated: tracker.escalated,
              excerpts: tracker.excerpts,
              batchSize: sizer.batchSize,
              calibrated: sizer.calibrated,
              message: `Asking once more about ${again.length} unsure pairs, with excerpts…`,
            });
          }
          const second = await this.reviewPairs(again, {
            kind,
            plan: secondPlan,
            systemPrompt,
            tracker,
            sizer,
            concurrency,
            memory,
          });
          foldUsage(second.usage);
          verdictsReused += second.verdictsReused || 0;
          for (const [key, verdict] of second.verdicts) {
            review.verdicts.set(key, verdict);
          }
        }
      }

      // The rule's verdicts and the model's answers are one map from here on;
      // a group aggregates them without knowing which is which.
      const verdicts = new Map([...settled, ...review.verdicts]);
      pairsNotJudged += asked.filter((pair) => !verdicts.has(pair.key)).length;
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

    this._report(tracker, {
      phase: REVIEW_PHASES.FINISHING,
      kind: null,
      message: 'Building the groups…',
    });

    candidateGroups.sort(
      (x, y) =>
        y.confidence - x.confidence || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
    );

    const groups = [...scanGroups, ...candidateGroups];
    const confirmed = groups.filter(
      (group) => group.aiVerdict?.verdict === AI_VERDICTS.SAME
    ).length;
    const stopped = this._stopped(tracker);
    if (stopped) {
      this._log(
        `review stopped (${this._stopReason(tracker)}): ` +
          `${tracker.requestsDone} of ${tracker.requestsPlanned} request(s) made, ` +
          `${pairsNotJudged} pair(s) not judged, ${tracker.tokens ?? 0} token(s).`
      );
    }
    this._log(
      `review finished: ${requests} request(s) (${retries} retry/retries, ${failedRequests} failed), ` +
        `${tokens == null ? 'unknown' : tokens} token(s), ${judged} pair(s) planned, ` +
        `${candidateCount} candidate(s), ${confirmed} group(s) confirmed` +
        (semanticSweep
          ? `, ${sweepRequests} sweep request(s), ${sweepProposals} sweep pair(s)`
          : '') +
        (targeted
          ? `, ${groupsJudged} group(s) judged, ${groupsSkipped} skipped`
          : '') +
        (verdictsReused > 0 ? `, ${verdictsReused} answered from memory` : '') +
        `, in ${Date.now() - startedAt}ms in ${concurrency} lane(s).`
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
        // Always present, so the page never has to guess: a review that ran
        // through says so with false, null and 0.
        stopped,
        stopReason: null,
        pairsNotJudged,
        // Both 0 without the sweep, because a review that did not sweep made
        // no sweep request and proposed no pair.
        sweepRequests,
        sweepProposals,
        // Pairs an earlier review had already decided, and the lanes this
        // one asked the rest in.
        verdictsReused,
        concurrency,
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
entityMatchAiService.SWEEP_BASES = SWEEP_BASES;
entityMatchAiService.SWEEP_MAX_NAMES = SWEEP_MAX_NAMES;
entityMatchAiService.MIN_SWEEP_NAMES = MIN_SWEEP_NAMES;
entityMatchAiService.SEMANTIC_SCORE = SEMANTIC_SCORE;
entityMatchAiService.SETTLED_REASON_BASES = SETTLED_REASON_BASES;
entityMatchAiService.CANDIDATE_LIMIT = CANDIDATE_LIMIT;
entityMatchAiService.REVIEW_PHASES = REVIEW_PHASES;
entityMatchAiService.TOKENS_PER_PAIR = TOKENS_PER_PAIR;
entityMatchAiService.TOKENS_OVERHEAD = TOKENS_OVERHEAD;
entityMatchAiService.TOKENS_CONTEXT_MARGIN = TOKENS_CONTEXT_MARGIN;
entityMatchAiService.WARMUP_PAIRS = WARMUP_PAIRS;
entityMatchAiService.WARMUP_MIN_CAP = WARMUP_MIN_CAP;
entityMatchAiService.CALIBRATION_WEIGHT = CALIBRATION_WEIGHT;
entityMatchAiService.CAP_SAFETY_FACTOR = CAP_SAFETY_FACTOR;
entityMatchAiService.CAP_FLOOR_FACTOR = CAP_FLOOR_FACTOR;
entityMatchAiService.DEFAULT_CONCURRENCY = DEFAULT_CONCURRENCY;
entityMatchAiService.MAX_CONCURRENCY = MAX_CONCURRENCY;
entityMatchAiService.MIN_COMPLETION_CAP = MIN_COMPLETION_CAP;
entityMatchAiService.PROGRESS_INTERVAL_MS = PROGRESS_INTERVAL_MS;
entityMatchAiService.WARMUP_MESSAGE = WARMUP_MESSAGE;
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
  switchedOn(config.duplicatesAiExcerpts);
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
/**
 * Names per semantic sweep request. Never fewer than MIN_SWEEP_NAMES: a
 * sweep of twenty names at a time is a request per twenty names and a model
 * that cannot see the two names it is meant to link.
 */
entityMatchAiService.sweepNames = () => {
  const names = Number(config.duplicatesAiSweepNames);
  return Math.max(
    MIN_SWEEP_NAMES,
    Number.isInteger(names) && names > 0 ? names : DEFAULT_SWEEP_NAMES
  );
};

module.exports = entityMatchAiService;
