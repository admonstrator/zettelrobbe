'use strict';

/**
 * The one AI review that may run at a time, as a job the page can watch and
 * stop.
 *
 * Why a job: a review of a large archive is many model requests in a row, and
 * a single POST that answers when everything is done shows nothing while it
 * runs and cannot be stopped. Here the route starts the review, answers at
 * once with the job, and the page follows it through `subscribe()` (a
 * server-sent event stream) until `done`, `stopped` or `failed`. The job
 * keeps its result for a while after it finished, so a page that was reloaded
 * can pick it up through `current()`.
 *
 * Two brakes, both from the settings: the token budget stops a review that
 * spent more than the operator allowed, and the idle stop ends a review that
 * nobody has been watching (no subscriber, no `touch()`) for a while, so a
 * closed tab cannot leave the model running.
 *
 * The judge (services/entityMatchAiService.js, `reviewScan(options, control)`)
 * gets a `control` object from here:
 *   - `signal`        an AbortSignal, aborted on any stop
 *   - `onProgress()`  takes a partial AiReviewProgress and merges it
 *   - `stop(reason)`  what the judge calls when its own token budget is spent
 *   - `tokenBudget`   the ceiling, null when there is none
 *   - `stopReason()`  why the job is stopping, for the judge's own log line;
 *                     null while it is not
 * A judge that stops early returns what it has, with `aiReview.stopped` set;
 * that partial result is kept on the job like a complete one.
 *
 * Singleton: `require('./duplicateReviewJobService')` is the instance.
 */

const crypto = require('crypto');
const config = require('../config/config');

/** @typedef {import('./entityMatchAiService')} EntityMatchAiService */

const JOB_STATUS = Object.freeze({
  RUNNING: 'running',
  STOPPING: 'stopping',
  DONE: 'done',
  STOPPED: 'stopped',
  FAILED: 'failed',
});

const STOP_REASONS = Object.freeze({
  USER: 'user',
  TOKEN_BUDGET: 'token-budget',
  IDLE: 'idle',
});

const EVENT_TYPES = Object.freeze({
  PROGRESS: 'progress',
  DONE: 'done',
  STOPPED: 'stopped',
  FAILED: 'failed',
});

const PHASES = Object.freeze({
  STARTING: 'starting',
  SCANNING: 'scanning',
  EVIDENCE: 'evidence',
  SWEEPING: 'sweeping',
  WARMING_UP: 'warming-up',
  JUDGING: 'judging',
  ESCALATING: 'escalating',
  FINISHING: 'finishing',
  // The tasks of the Simplify tags page, run through the same job.
  VOCABULARY: 'vocabulary',
  SPLITTING: 'splitting',
});

/** What a job runs; the review is the default, the other two belong to Simplify tags. */
const JOB_TASKS = Object.freeze({
  REVIEW: 'review',
  VOCABULARY: 'vocabulary',
  SPLITS: 'splits',
});

/** How long a finished job stays reachable through current() and get(). */
const RETENTION_MS = 10 * 60 * 1000;
/** How often the idle watch looks at a running job. */
const IDLE_CHECK_MS = 5 * 1000;

/**
 * @typedef {object} AiReviewProgress
 * @property {string} phase
 * @property {string} message
 * @property {string|null} kind
 * @property {number} requestsDone
 * @property {number|null} requestsPlanned
 * @property {number} pairsJudged
 * @property {number|null} pairsTotal
 * @property {number|null} tokens
 * @property {number|null} tokenBudget
 * @property {number|null} estimatedTokens
 * @property {number} elapsedMs
 * @property {number|null} etaMs
 * @property {number} excerpts
 * @property {number} escalated
 * @property {number} spellingRules
 * @property {number} failedRequests
 * @property {number} retries
 * @property {number|null} requestPairs   pairs in the request being answered
 * @property {number} requestAnswers      verdicts streamed in so far in it
 * @property {number|null} requestTokens  completion tokens it produced so far
 * @property {boolean} thinking           the model is writing reasoning
 * @property {number|null} batchSize      pairs per request in use
 * @property {boolean} calibrated         sizes come from a measurement
 */

/**
 * @typedef {object} AiReviewJobEvent
 * @property {'progress'|'done'|'stopped'|'failed'} type
 * @property {object} job      the public shape, see toJSON()
 * @property {object} [data]   the review result on done and stopped
 * @property {string} [error]  the message on failed
 */

function freshProgress(tokenBudget) {
  return {
    phase: PHASES.STARTING,
    message: 'Starting…',
    kind: null,
    requestsDone: 0,
    requestsPlanned: null,
    pairsJudged: 0,
    pairsTotal: null,
    tokens: null,
    tokenBudget,
    estimatedTokens: null,
    elapsedMs: 0,
    etaMs: null,
    excerpts: 0,
    escalated: 0,
    spellingRules: 0,
    failedRequests: 0,
    retries: 0,
    requestPairs: null,
    requestAnswers: 0,
    requestTokens: null,
    thinking: false,
    batchSize: null,
    calibrated: false,
    concurrency: null,
    inFlight: 0,
    verdictsReused: 0,
    thinkingTokens: null,
  };
}

class DuplicateReviewJobService {
  constructor() {
    /** @type {object|null} the running job, or the last finished one */
    this.job = null;
    this.idleTimer = null;
    this.retentionTimer = null;
  }

  /** The judge; read late so a test can replace the singleton's methods. */
  _judge() {
    return require('./entityMatchAiService');
  }

  /** The token ceiling of one review, null when the setting is 0 or unset. */
  tokenBudget() {
    const budget = Number(config.duplicatesAiTokenBudget);
    return Number.isInteger(budget) && budget > 0 ? budget : null;
  }

  /** Seconds a review may run unwatched before it stops; 0 means never. */
  idleStopSeconds() {
    const seconds = Number(config.duplicatesAiIdleStopSeconds);
    return Number.isInteger(seconds) && seconds > 0 ? seconds : 0;
  }

  /**
   * Starts a review as a job and returns at once.
   *
   * @param {object} options  what reviewScan() takes; `options.task` names
   *   another task (JOB_TASKS) when a runner is given
   * @param {(function(object, object): Promise<object>)|null} [runner]  what to
   *   run instead of the judge's reviewScan: called with (options, control),
   *   reports through control.onProgress, honours control.signal. The
   *   Simplify tags page runs its vocabulary and split proposals this way.
   * @returns {object} the job (see toJSON() for what leaves the process)
   * @throws {Error} status 409 while another job is running
   */
  start(options, runner = null) {
    if (this.isRunning()) {
      const error = new Error('An AI review is already running');
      error.status = 409;
      error.job = this.toJSON(this.job);
      throw error;
    }
    this._clearRetention();
    const tokenBudget = this.tokenBudget();
    const job = {
      id: crypto.randomUUID(),
      status: JOB_STATUS.RUNNING,
      options: { ...(options || {}) },
      task:
        typeof runner === 'function' && options?.task
          ? String(options.task)
          : JOB_TASKS.REVIEW,
      runner: typeof runner === 'function' ? runner : null,
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
      judgingSinceMs: null,
      finishedAt: null,
      stopReason: null,
      progress: freshProgress(tokenBudget),
      result: null,
      error: null,
      controller: new AbortController(),
      listeners: new Set(),
      watchedMs: Date.now(),
      finished: null,
    };
    job.finished = new Promise((resolve) => {
      job._resolveFinished = resolve;
    });
    this.job = job;
    this._startIdleWatch();
    // Detached on purpose: the route answers with the job, the review runs on.
    this._run(job).catch((error) => {
      console.error(
        '[AI-REVIEW] job runner failed outside the review:',
        error?.message || error
      );
    });
    return job;
  }

  /** True while a review is running or still winding down after a stop. */
  isRunning() {
    return (
      this.job !== null &&
      (this.job.status === JOB_STATUS.RUNNING ||
        this.job.status === JOB_STATUS.STOPPING)
    );
  }

  /** The running job, or the last finished one while it is retained. */
  current() {
    return this.job;
  }

  /** @returns {object|null} */
  get(id) {
    return this.job && this.job.id === id ? this.job : null;
  }

  /**
   * Stops a running job. The judge sees the aborted signal, stops asking and
   * returns what it has; the job ends as `stopped` once that result is in.
   *
   * @param {string} id
   * @param {string} [reason]  one of STOP_REASONS
   * @returns {object|null} the job, or null when there is none with that id
   */
  stop(id, reason = STOP_REASONS.USER) {
    const job = this.get(id);
    if (!job) return null;
    if (job.status !== JOB_STATUS.RUNNING) return job;
    job.status = JOB_STATUS.STOPPING;
    job.stopReason = Object.values(STOP_REASONS).includes(reason)
      ? reason
      : STOP_REASONS.USER;
    job.progress.message =
      job.stopReason === STOP_REASONS.USER
        ? 'Stopping after the current request…'
        : job.stopReason === STOP_REASONS.TOKEN_BUDGET
          ? 'Token budget spent, stopping…'
          : 'Nobody is watching, stopping…';
    this._log(`job ${job.id} stopping (${job.stopReason}).`);
    job.controller.abort();
    this._emit(job, EVENT_TYPES.PROGRESS);
    return job;
  }

  /**
   * Follows a job. The listener first gets the job as it is now, then every
   * change, and the stream ends with done, stopped or failed. A job that
   * already finished gets that final event at once.
   *
   * @param {string} id
   * @param {(event: AiReviewJobEvent) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(id, listener) {
    const job = this.get(id);
    if (!job) return () => {};
    this.touch(id);
    if (!this.isRunning()) {
      listener(this._finalEvent(job));
      return () => {};
    }
    job.listeners.add(listener);
    // Where the job is right now, so a page that subscribes late (after the
    // start answered, or after a reload) does not wait for the next change.
    listener({ type: EVENT_TYPES.PROGRESS, job: this.toJSON(job) });
    return () => {
      job.listeners.delete(listener);
      job.watchedMs = Date.now();
    };
  }

  /** Marks the job as watched now; a poll of the job counts as watching. */
  touch(id) {
    const job = this.get(id);
    if (job) job.watchedMs = Date.now();
  }

  /**
   * Resolves with the final event once the job ends; for a caller that wants
   * the old synchronous behaviour.
   *
   * @param {string} id
   * @returns {Promise<AiReviewJobEvent|null>}
   */
  wait(id) {
    const job = this.get(id);
    if (!job) return Promise.resolve(null);
    if (!this.isRunning()) return Promise.resolve(this._finalEvent(job));
    return job.finished;
  }

  /** The review result of a done or stopped job, null otherwise. */
  result(id) {
    const job = this.get(id);
    return job ? job.result : null;
  }

  /** What leaves the process: no controller, no listeners, no result body. */
  toJSON(job) {
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      task: job.task || JOB_TASKS.REVIEW,
      options: job.options,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      stopReason: job.stopReason,
      progress: { ...job.progress, elapsedMs: this._elapsed(job) },
      error: job.error,
      hasResult: job.result !== null,
    };
  }

  /** Forgets the retained job; tests use it between cases. */
  reset() {
    this._stopIdleWatch();
    this._clearRetention();
    if (this.job && this.isRunning()) {
      this.job.controller.abort();
    }
    this.job = null;
  }

  /* --- internals -------------------------------------------------------- */

  async _run(job) {
    const control = {
      signal: job.controller.signal,
      tokenBudget: job.progress.tokenBudget,
      onProgress: (patch) => this._progress(job, patch),
      stop: (reason) => {
        this.stop(job.id, reason);
      },
      // Read, not passed: the judge asks for it when it writes the line that
      // says why it stopped. The reason it returns in the result stays null;
      // this job fills that in below.
      stopReason: () => job.stopReason,
    };
    try {
      const run =
        job.runner ||
        ((options, ctl) => this._judge().reviewScan(options, ctl));
      const data = await run(job.options, control);
      job.result = data || null;
      const stoppedEarly =
        job.stopReason !== null || Boolean(data?.aiReview?.stopped);
      if (stoppedEarly && data?.aiReview && !data.aiReview.stopReason) {
        data.aiReview.stopped = true;
        data.aiReview.stopReason = job.stopReason;
      }
      job.status = stoppedEarly ? JOB_STATUS.STOPPED : JOB_STATUS.DONE;
    } catch (error) {
      if (job.stopReason !== null || job.controller.signal.aborted) {
        // A judge that throws on the aborted signal still ends as stopped;
        // it just has nothing to keep.
        job.status = JOB_STATUS.STOPPED;
        if (job.stopReason === null) job.stopReason = STOP_REASONS.USER;
      } else {
        job.status = JOB_STATUS.FAILED;
        job.error = error?.message || 'The AI review failed';
        job.errorStatus = Number.isInteger(error?.status) ? error.status : 500;
      }
    }
    job.finishedAt = new Date().toISOString();
    job.progress.elapsedMs = this._elapsed(job);
    job.progress.etaMs = null;
    this._stopIdleWatch();
    this._log(
      `job ${job.id} ${job.status}` +
        (job.stopReason ? ` (${job.stopReason})` : '') +
        ` after ${job.progress.elapsedMs}ms, ${job.progress.requestsDone} request(s), ` +
        `${job.progress.tokens ?? 0} token(s).`
    );
    const event = this._finalEvent(job);
    for (const listener of [...job.listeners]) {
      try {
        listener(event);
      } catch {
        // A listener that throws is a broken stream; the job is not.
      }
    }
    job.listeners.clear();
    job._resolveFinished(event);
    this._scheduleRetention(job);
  }

  _finalEvent(job) {
    if (job.status === JOB_STATUS.FAILED) {
      return {
        type: EVENT_TYPES.FAILED,
        job: this.toJSON(job),
        error: job.error,
      };
    }
    return {
      type:
        job.status === JOB_STATUS.STOPPED
          ? EVENT_TYPES.STOPPED
          : EVENT_TYPES.DONE,
      job: this.toJSON(job),
      data: job.result,
    };
  }

  /**
   * Merges what the judge reports and derives elapsed time and the estimate.
   * The estimate is the request rate so far applied to the requests still
   * planned; it exists only while requests are answered.
   */
  _progress(job, patch) {
    if (!patch || typeof patch !== 'object') return;
    const before = job.progress;
    const next = { ...before, ...patch };
    // A stop message stays on top of whatever the judge says next.
    if (job.status === JOB_STATUS.STOPPING) next.message = before.message;
    if (
      (next.phase === PHASES.JUDGING || next.phase === PHASES.WARMING_UP) &&
      job.judgingSinceMs === null
    ) {
      job.judgingSinceMs = Date.now();
    }
    next.elapsedMs = this._elapsed(job);
    next.etaMs = this._eta(job, next);
    job.progress = next;
    this._emit(job, EVENT_TYPES.PROGRESS);
  }

  /**
   * The time left, from the share of the work that is done since the model
   * was first asked. Pairs are the unit when the plan knows them (the answers
   * streamed in during the current request count), because the batch size
   * may change after the warm-up and a request is then no fixed amount of
   * work; requests are the fallback. Null until something is done.
   *
   * What is done counts answers that have arrived, and a review with several
   * requests in flight has as many more nearly done at the same moment — so
   * the time the rest takes is divided by the lanes it is asked in. Without
   * them (or on a review that never reported a concurrency) that is one and
   * the estimate is what it always was.
   */
  _eta(job, progress) {
    if (job.judgingSinceMs === null) return null;
    const pairsTotal = Number(progress.pairsTotal);
    const requestsPlanned = Number(progress.requestsPlanned);
    let fraction = null;
    if (Number.isFinite(pairsTotal) && pairsTotal > 0) {
      const done =
        (Number(progress.pairsJudged) || 0) +
        (Number(progress.requestAnswers) || 0);
      fraction = Math.min(1, done / pairsTotal);
    } else if (Number.isFinite(requestsPlanned) && requestsPlanned > 0) {
      fraction = Math.min(
        1,
        (Number(progress.requestsDone) || 0) / requestsPlanned
      );
    }
    if (fraction === null || fraction <= 0) return null;
    if (fraction >= 1) return 0;
    const elapsed = Date.now() - job.judgingSinceMs;
    const lanes = Number(progress.concurrency);
    const inParallel = Number.isFinite(lanes) && lanes > 1 ? lanes : 1;
    return Math.round((elapsed * (1 - fraction)) / fraction / inParallel);
  }

  _elapsed(job) {
    const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
    return Math.max(0, end - job.startedMs);
  }

  _emit(job, type) {
    if (job.listeners.size === 0) return;
    const event = { type, job: this.toJSON(job) };
    for (const listener of [...job.listeners]) {
      try {
        listener(event);
      } catch {
        // see _run()
      }
    }
  }

  _startIdleWatch() {
    this._stopIdleWatch();
    this.idleTimer = setInterval(() => this._checkIdle(), IDLE_CHECK_MS);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  _stopIdleWatch() {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Exposed for tests: one tick of the idle watch. */
  _checkIdle() {
    const job = this.job;
    if (!job || job.status !== JOB_STATUS.RUNNING) return;
    const seconds = this.idleStopSeconds();
    if (seconds === 0 || job.listeners.size > 0) return;
    if (Date.now() - job.watchedMs >= seconds * 1000) {
      this.stop(job.id, STOP_REASONS.IDLE);
    }
  }

  _scheduleRetention(job) {
    this._clearRetention();
    this.retentionTimer = setTimeout(() => {
      if (this.job === job && !this.isRunning()) this.job = null;
      this.retentionTimer = null;
    }, RETENTION_MS);
    if (typeof this.retentionTimer.unref === 'function') {
      this.retentionTimer.unref();
    }
  }

  _clearRetention() {
    if (this.retentionTimer) {
      clearTimeout(this.retentionTimer);
      this.retentionTimer = null;
    }
  }

  _log(message) {
    console.log(`[AI-REVIEW] ${message}`);
  }
}

const duplicateReviewJobService = new DuplicateReviewJobService();
duplicateReviewJobService.JOB_STATUS = JOB_STATUS;
duplicateReviewJobService.JOB_TASKS = JOB_TASKS;
duplicateReviewJobService.STOP_REASONS = STOP_REASONS;
duplicateReviewJobService.EVENT_TYPES = EVENT_TYPES;
duplicateReviewJobService.PHASES = PHASES;
duplicateReviewJobService.RETENTION_MS = RETENTION_MS;

module.exports = duplicateReviewJobService;
