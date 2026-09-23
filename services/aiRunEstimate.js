/**
 * What a model-backed run will cost, before it starts.
 *
 * Both review pages ask the same question in their own words: "how many
 * requests, how many tokens, how long?" The answer is the same arithmetic in
 * both cases, so it lives here once, as a pure function over numbers the
 * caller has already gathered — nothing in this file reads the database, the
 * config or Paperless-ngx.
 *
 * Three sources feed it, in falling order of trust:
 *
 *  1. `lastRun` — what a finished run of this task actually cost
 *     (models/document.js, `getLastAiRunStats`). Per-request averages from a
 *     real run beat every model of the world, because they carry the prompt
 *     this very task builds, the vocabulary it sends along and the model's
 *     habits at once.
 *  2. `calibration` — what the judge measured about the model itself
 *     (`getAiCalibration`): tokens per item, the fixed thinking surcharge per
 *     request, tokens per second. Present after the first warm-up, and still
 *     right when the task is new.
 *  3. The constants below — a guess, and reported as one. They are round
 *     numbers, not a fit to anyone's archive: a run on an unknown model is
 *     allowed to be wrong by a factor, as long as the page says so.
 *
 * Every number that leaves here is a whole number of tokens, requests or
 * seconds. A caller that renders "about 1.4 M" rounds it again for the eye;
 * the arithmetic never pretends to a precision it does not have.
 */

/** Instructions, the vocabulary and the shape of the answer, per request. */
const GUESS_PROMPT_BASE = 900;
/** One line per item in the question: its name, its document count, its id. */
const GUESS_PROMPT_PER_ITEM = 18;
/** One verdict: an id, an action, a short reason. */
const GUESS_TOKENS_PER_ITEM = 26;
/** What a thinking model spends before it writes the first answer token. */
const GUESS_THINKING_PER_REQUEST = 1800;
/** A local model on a warm GPU. Hosted endpoints are faster, Ollama slower. */
const GUESS_TOKENS_PER_SECOND = 45;

/** Below this a per-request average from a past run says nothing. */
const MIN_REQUESTS_FOR_AVERAGE = 2;

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const whole = (value) => Math.max(0, Math.round(Number(value) || 0));

/**
 * Per-request averages of a finished run, or null when the run is too small
 * to average over. A run of one request is a warm-up, not a measurement.
 *
 * @param {object|null} lastRun a row of `ai_run_stats`
 * @returns {{prompt:number|null, completion:number|null, thinking:number|null,
 *   seconds:number|null, items:number|null}|null}
 */
function perRequest(lastRun) {
  const requests = positive(lastRun?.requests);
  if (requests === null || requests < MIN_REQUESTS_FOR_AVERAGE) return null;
  const share = (value) => {
    const total = positive(value);
    return total === null ? null : total / requests;
  };
  return {
    prompt: share(lastRun.promptTokens),
    completion: share(lastRun.completionTokens),
    thinking: share(lastRun.thinkingTokens),
    seconds: share(lastRun.seconds),
    items: share(lastRun.items),
  };
}

/**
 * What one run over `items` items will cost.
 *
 * @param {object} options
 * @param {number} options.items        items the model is asked about
 * @param {number} options.batchSize    items per request
 * @param {number} [options.requests]   the request count when the caller
 *   knows it better than items ÷ batchSize, say because it batches per kind
 * @param {number} [options.lanes]      requests in flight at once, default 1
 * @param {object|null} [options.calibration] `getAiCalibration` of the model
 * @param {object|null} [options.lastRun]     `getLastAiRunStats` of the task
 * @param {boolean} [options.thinking]  the model writes reasoning
 * @returns {{items:number, batchSize:number, requests:number, lanes:number,
 *   tokens:{total:number, prompt:number, completion:number, thinking:number},
 *   seconds:number, basis:'run'|'model'|'guess', measuredAt:string|null}}
 */
function estimateRun({
  items,
  batchSize,
  requests: given = null,
  lanes = 1,
  calibration = null,
  lastRun = null,
  thinking = false,
} = {}) {
  const count = whole(items);
  const size = Math.max(1, whole(batchSize) || 1);
  const inFlight = Math.max(1, whole(lanes) || 1);
  const requests = whole(given) > 0 ? whole(given) : Math.ceil(count / size);

  const measured = perRequest(lastRun);
  const perItem = positive(calibration?.tokensPerPair);
  const thinkPerRequest = positive(calibration?.thinkingPerRequest);
  const speed = positive(calibration?.tokensPerSecond);

  // The prompt is the one part a model measurement never covers: it is this
  // task's own question, so only a run of this task knows its size.
  const promptEach =
    measured?.prompt ?? GUESS_PROMPT_BASE + GUESS_PROMPT_PER_ITEM * size;
  const completionEach =
    perItem !== null
      ? perItem * size
      : (measured?.completion ?? GUESS_TOKENS_PER_ITEM * size);
  const thinkEach = thinking
    ? (thinkPerRequest ?? measured?.thinking ?? GUESS_THINKING_PER_REQUEST)
    : (measured?.thinking ?? 0);

  const prompt = whole(promptEach * requests);
  const completion = whole(completionEach * requests);
  const think = whole(thinkEach * requests);

  // What the model writes is what takes time; the prompt is read at a
  // different, much higher rate and never dominates a run.
  const secondsEach =
    measured?.seconds ??
    (completionEach + thinkEach) / (speed ?? GUESS_TOKENS_PER_SECOND);

  let basis = 'guess';
  if (measured !== null) basis = 'run';
  else if (perItem !== null || speed !== null) basis = 'model';

  return {
    items: count,
    batchSize: size,
    requests,
    lanes: inFlight,
    tokens: {
      total: prompt + completion + think,
      prompt,
      completion,
      thinking: think,
    },
    seconds: whole((secondsEach * requests) / inFlight),
    basis,
    measuredAt:
      (basis === 'run' ? lastRun?.finishedAt : calibration?.measuredAt) ?? null,
  };
}

module.exports = {
  estimateRun,
  perRequest,
  GUESS_PROMPT_BASE,
  GUESS_PROMPT_PER_ITEM,
  GUESS_TOKENS_PER_ITEM,
  GUESS_THINKING_PER_REQUEST,
  GUESS_TOKENS_PER_SECOND,
  MIN_REQUESTS_FOR_AVERAGE,
};
