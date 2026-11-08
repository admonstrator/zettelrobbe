'use strict';

/**
 * The run behind the Tidy up page: one job that compares every name, asks
 * the model where spelling cannot settle a pair, optionally asks which tags
 * to split, and turns all of it into suggestions a person accepts or
 * declines.
 *
 * Nothing here re-implements a merge, an undo, a dismissal or a split: the
 * run calls the services the old Duplicates and Simplify routes call, with
 * the same arguments, so the merge log, History and the undo chain stay what
 * they are. What this service adds is the presentation — the run as steps,
 * the result as suggestions (services/tidyUpSuggestions.js) in sentences
 * (services/tidyUpWording.js) — and the bookkeeping of decisions: which
 * suggestion was carried out, which batch undoes it.
 *
 * The run lives in memory. The job service keeps a finished job for ten
 * minutes; this service keeps the last run (with its suggestions and undo
 * batches) until the next one starts or the process restarts.
 *
 * Singleton: `require('./tidyUpRunService')` is the instance.
 */

const crypto = require('crypto');
const suggestionsModule = require('./tidyUpSuggestions');
const wording = require('./tidyUpWording');
const { classifyFailure, FAILURE_KINDS } = require('./modelFailure');

const {
  SUGGESTION_KINDS,
  CERTAINTY,
  SUGGESTION_STATUS,
  fromDuplicateGroup,
  fromUnusedEntity,
  fromOrderMember,
  summarize,
  evidenceFromMembers,
  sortSuggestions,
} = suggestionsModule;

/** The step keys in order; RUN_STEPS carries the labels. */
const STEP_KEYS = wording.RUN_STEPS.map((step) => step.key);

/** How much of the bar each step is worth; skipped steps give theirs away. */
const STEP_WEIGHTS = Object.freeze({
  compare: 15,
  evidence: 10,
  judge: 60,
  split: 10,
  sort: 5,
});

/** Job phases (services/duplicateReviewJobService.js PHASES) → step keys. */
const PHASE_STEPS = Object.freeze({
  starting: 'compare',
  scanning: 'compare',
  evidence: 'evidence',
  sweeping: 'judge',
  'warming-up': 'judge',
  judging: 'judge',
  escalating: 'judge',
  vocabulary: 'split',
  splitting: 'split',
  ordering: 'split',
  finishing: 'sort',
});

/** Run options the page may send back from a failure notice. */
const RUN_ACTIONS = Object.freeze([
  'retry',
  'continue',
  'retry-affected',
  'retry-larger',
  'test-connection',
]);

/** How many entities the run reads evidence for on its own, at most. */
const EVIDENCE_LIMIT = 120;
/** Parallel evidence reads. */
const EVIDENCE_CONCURRENCY = 4;
/** Most suggestion ids one decide call may name. */
const MAX_DECIDE_IDS = 500;
/** A surviving name is a name, not a paragraph. */
const MAX_NAME_LENGTH = 128;
/** Rows of the merge log the page lists. */
const RECENT_LIMIT = 20;

/** An error the route answers with its own status. */
class TidyUpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TidyUpError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

function capitalise(text) {
  return String(text).replace(/^./, (c) => c.toUpperCase());
}

/** "38,400" */
function number(value) {
  return (Number(value) || 0).toLocaleString('en-US');
}

/** The SQLite CURRENT_TIMESTAMP ("2026-11-08 09:12:00", UTC) as ISO. */
function isoFromSqlite(value) {
  if (!value) return null;
  const text = String(value);
  if (/T/.test(text)) return text;
  const iso = `${text.replace(' ', 'T')}Z`;
  return Number.isNaN(Date.parse(iso)) ? text : iso;
}

/** Runs `work` over `items`, at most `lanes` at a time. */
async function mapLimited(items, lanes, work) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(lanes, items.length) }, worker)
  );
  return results;
}

/**
 * The model as sentences name it: "Claude Haiku" for claude-haiku-*, the
 * model id otherwise.
 *
 * @param {string|null} model
 * @returns {string|null}
 */
function modelLabel(model) {
  const id = String(model ?? '').trim();
  if (id === '') return null;
  const claude = /^claude-(?:\d+(?:[-.]\d+)?-)?(haiku|sonnet|opus)/i.exec(id);
  if (claude) return `Claude ${capitalise(claude[1].toLowerCase())}`;
  return id;
}

/** "About a minute left" and friends; null when nothing is known. */
function etaText(etaMs) {
  const ms = Number(etaMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 30 * 1000) return 'A few seconds left';
  if (ms < 90 * 1000) return 'About a minute left';
  return `About ${Math.round(ms / 60000)} minutes left`;
}

/** "38,400 tokens of your 200,000 budget" / "38,400 tokens so far". */
function costText(tokens, budget) {
  if (!Number.isFinite(Number(tokens)) || Number(tokens) <= 0) return null;
  return budget
    ? `${number(tokens)} tokens of your ${number(budget)} budget`
    : `${number(tokens)} tokens so far`;
}

/** Who to record as the author of a change. */
function performedByOf(user) {
  return user?.username || 'api-key';
}

class TidyUpRunService {
  constructor() {
    /** @type {object|null} the running run, or the last one */
    this.run = null;
    /** True while a decide or undo call writes. */
    this.deciding = false;
    /** Listeners of run changes the job does not report (suggestions). */
    this.listeners = new Set();
  }

  /* --- services, read late so a test can replace their methods ---------- */

  _jobs() {
    return require('./duplicateReviewJobService');
  }

  _merges() {
    return require('./duplicateMergeService');
  }

  _judge() {
    return require('./entityMatchAiService');
  }

  _simplify() {
    return require('./tagSimplifyService');
  }

  _paperless() {
    return require('./paperlessService');
  }

  _documents() {
    return require('../models/document');
  }

  _threshold() {
    return require('./entityNameMatcher').SENSITIVITY.normal;
  }

  /* --- what the page knows before a run ---------------------------------- */

  /** Whether the judge may be asked at all. */
  modelAvailable() {
    try {
      return this._judge().isEnabled() === true;
    } catch {
      return false;
    }
  }

  /** Whether the order (splits) may be asked. */
  splitsAvailable() {
    try {
      return this._simplify().hasProvider() === true;
    } catch {
      return false;
    }
  }

  /** The model label the page and the notices use. */
  modelLabel() {
    try {
      return modelLabel(this._judge().modelName());
    } catch {
      return null;
    }
  }

  /**
   * Everything GET /tidy-up renders with. Never throws: Paperless-ngx being
   * unreachable shows zero names, it does not fail the page.
   *
   * @returns {Promise<{modelAvailable:boolean, modelLabel:string, splitsAvailable:boolean, counts:{tags:number, correspondents:number}, lastRun:{when:string, accepted:number}|null}>}
   */
  async pageLocals() {
    const counts = { tags: 0, correspondents: 0 };
    for (const kind of ['tags', 'correspondents']) {
      try {
        counts[kind] = (await this._merges().listEntities(kind)).length;
      } catch {
        counts[kind] = 0;
      }
    }
    return {
      modelAvailable: this.modelAvailable(),
      modelLabel: this.modelLabel() || '',
      splitsAvailable: this.splitsAvailable(),
      counts,
      lastRun: await this.lastRun(),
    };
  }

  /**
   * The last run, as the start screen mentions it. With a run in memory: its
   * start and the changes since then. Otherwise, from the merge log: the
   * newest entry's date, and the entries of that same (UTC) day that were not
   * undone — the log does not know where one run ended and the next began.
   *
   * @returns {Promise<{when:string, accepted:number}|null>}
   */
  async lastRun() {
    let rows;
    try {
      rows = (await this._documents().getEntityMerges({ limit: 100 })).rows;
    } catch {
      rows = [];
    }
    const kept = (row) => row.status !== 'undone';
    if (this.run) {
      // The log keeps whole seconds; the run's start is cut to match.
      const since = Math.floor(Date.parse(this.run.startedAt) / 1000) * 1000;
      return {
        when: this.run.startedAt,
        accepted: rows.filter(
          (row) =>
            kept(row) && Date.parse(isoFromSqlite(row.createdAt)) >= since
        ).length,
      };
    }
    if (rows.length === 0) return null;
    const newest = isoFromSqlite(rows[0].createdAt);
    const day = String(newest).slice(0, 10);
    return {
      when: newest,
      accepted: rows.filter(
        (row) =>
          kept(row) && String(isoFromSqlite(row.createdAt)).startsWith(day)
      ).length,
    };
  }

  /* --- starting a run ----------------------------------------------------- */

  /**
   * Reads a TidyUpRunRequest. Unknown keys are ignored; a wrong type is a 400.
   *
   * @param {object} body
   * @returns {{askModel:boolean, suggestSplits:boolean, kind:string, action:string|null, answerTokens:number|null}}
   */
  readOptions(body = {}) {
    const source = body && typeof body === 'object' ? body : {};
    const flag = (value, fallback, name) => {
      if (value === undefined || value === null) return fallback;
      if (typeof value !== 'boolean') {
        throw new TidyUpError(`${name} must be true or false`);
      }
      return value;
    };
    const kind = source.kind == null ? 'all' : String(source.kind);
    if (!['all', 'tags', 'correspondents'].includes(kind)) {
      throw new TidyUpError(`Unknown kind: ${kind}`);
    }
    const action =
      source.action == null || source.action === '' ? null : source.action;
    if (action !== null && !RUN_ACTIONS.includes(action)) {
      throw new TidyUpError(`Unknown action: ${action}`);
    }
    let answerTokens = null;
    if (source.answerTokens != null) {
      answerTokens = Number(source.answerTokens);
      if (!Number.isInteger(answerTokens) || answerTokens <= 0) {
        throw new TidyUpError('answerTokens must be a positive whole number');
      }
    }
    return {
      askModel: flag(source.askModel, true, 'askModel'),
      suggestSplits: flag(source.suggestSplits, false, 'suggestSplits'),
      kind,
      action,
      answerTokens,
    };
  }

  /**
   * Starts a run as a job and returns it at once.
   *
   * @param {object} body  a TidyUpRunRequest
   * @returns {object} the run (see toJSON())
   * @throws {TidyUpError} 400 on a bad request, 501 for an action that is not
   *   wired up, 409 while any job runs (`error.run` is the running run)
   */
  start(body = {}) {
    const requested = this.readOptions(body);
    if (requested.action === 'retry-larger') {
      throw new TidyUpError(
        'A run with a larger answer length is not available yet. Raise the answer length or pick another model on the settings page, then run again.',
        501
      );
    }
    if (requested.action === 'test-connection') {
      throw new TidyUpError(
        'Testing the connection is not a run. Check the AI provider on the settings page.',
        501
      );
    }

    const previous = this.run;
    // A run that is asked to continue, or to ask again about the pairs that
    // failed, asks the model only about the groups still marked "needs a
    // look"; everything else is carried over from the previous run.
    const narrowed =
      (requested.action === 'continue' ||
        requested.action === 'retry-affected') &&
      previous
        ? previous.suggestions
            .filter(
              (s) =>
                s.kind === SUGGESTION_KINDS.MERGE &&
                s.status === SUGGESTION_STATUS.OPEN &&
                s.certainty === CERTAINTY.UNSURE &&
                previous.groupIdOf.has(s.id)
            )
            .map((s) => previous.groupIdOf.get(s.id))
        : null;

    const modelAvailable = this.modelAvailable();
    const askModel = requested.askModel && modelAvailable;
    const suggestSplits =
      requested.suggestSplits &&
      requested.kind !== 'correspondents' &&
      this.splitsAvailable();
    const options = {
      askModel,
      suggestSplits,
      kind: requested.kind,
      ...(requested.action ? { action: requested.action } : {}),
      ...(requested.answerTokens
        ? { answerTokens: requested.answerTokens }
        : {}),
    };

    const run = {
      id: null,
      job: null,
      options,
      groupIds: narrowed && narrowed.length > 0 ? narrowed : null,
      carried: narrowed && previous ? previous.suggestions : null,
      model: askModel || suggestSplits ? this.modelLabel() : null,
      startedAt: new Date().toISOString(),
      // Where the runner is: compare, evidence, judge, split, sort.
      stage: 'compare',
      reached: 0,
      percent: 0,
      counts: {
        names: 0,
        sure: 0,
        open: 0,
        tags: 0,
      },
      judgeCounts: null,
      splitCounts: null,
      reviewTokens: null,
      orderTokens: null,
      failedRequests: 0,
      suggestions: [],
      groupIdOf: new Map(),
      batches: new Map(),
    };

    let job;
    try {
      job = this._jobs().start(
        { ...options, task: this._jobs().JOB_TASKS.TIDY_UP },
        (jobOptions, control) => this._runner(run, control)
      );
    } catch (error) {
      if (error?.status === 409) {
        const ours =
          this.run !== null && this.run.job === this._jobs().current();
        const conflict = new TidyUpError(
          ours
            ? 'A run is already going. Its suggestions appear here as they are found.'
            : 'Another clean-up job is running. Try again when it has finished.',
          409
        );
        conflict.run = ours ? this.toJSON(this.run) : null;
        throw conflict;
      }
      throw error;
    }
    run.id = job.id;
    run.job = job;
    this.run = run;
    this._changed(run);
    return run;
  }

  /* --- the runner --------------------------------------------------------- */

  /**
   * What the job runs: compare, evidence, judge, split, sort. Suggestions are
   * pushed as soon as the comparison is done, so the page can show cards
   * while the model works; the final result replaces them, keeping whatever
   * the person already decided.
   */
  async _runner(run, control) {
    const kind = run.options.kind;
    const threshold = this._threshold();
    const merges = this._merges();

    // (a) the comparison by spelling. With the model it is the scan the
    // judge then reads from the cache, so the archive is read once.
    this._stage(run, 'compare', control, 'Comparing names by spelling…');
    const scan = await merges.scan({
      kind,
      threshold,
      includeDismissed: false,
      fresh: true,
    });
    run.counts.names =
      (Number(scan.totals?.tags) || 0) +
      (Number(scan.totals?.correspondents) || 0);
    this._build(run, { scan, order: null, final: false });
    run.counts.sure = run.suggestions.filter(
      (s) => s.kind === SUGGESTION_KINDS.MERGE && s.certainty === CERTAINTY.SURE
    ).length;
    run.counts.open = run.suggestions.filter(
      (s) => s.kind === SUGGESTION_KINDS.MERGE && s.certainty !== CERTAINTY.SURE
    ).length;
    this._changed(run);

    let result = scan;
    if (run.options.askModel && !control.signal.aborted) {
      // (b) the judge, with the band below the threshold and the evidence.
      run.stage = 'review';
      const reviewControl = {
        ...control,
        onProgress: (patch) => {
          control.onProgress(patch);
          this._notePhase(run, patch?.phase);
        },
      };
      try {
        result = await this._judge().reviewScan(
          {
            kind,
            threshold,
            includeDismissed: false,
            includeCandidates: true,
            withTitles: true,
            withExcerpts: true,
            ...(run.groupIds ? { groupIds: run.groupIds } : {}),
          },
          reviewControl
        );
      } catch (error) {
        if (!control.signal.aborted) throw error;
        // Stopped while the judge was asking: keep what the scan found.
        result = scan;
      }
      const progress = run.job?.progress || {};
      run.judgeCounts = {
        requestsDone: Number(progress.requestsDone) || 0,
        requestsPlanned: Number(progress.requestsPlanned) || 0,
        pairsJudged: Number(progress.pairsJudged) || 0,
        pairs: Number(progress.pairsTotal) || 0,
      };
      run.reviewTokens = Number(progress.tokens) || 0;
      run.failedRequests =
        Number(result?.aiReview?.failedRequests) ||
        Number(progress.failedRequests) ||
        0;
      if (run.judgeCounts.pairs > 0) run.counts.open = run.judgeCounts.pairs;
      this._build(run, { scan: result, order: null, final: false });
      this._changed(run);
    } else {
      run.reviewTokens = 0;
      // Without the model the evidence step reads the titles itself, for
      // the pairs a person has to decide.
      this._stage(run, 'evidence', control, 'Reading document titles…');
      await this._readEvidence(run);
      this._changed(run);
    }

    // (c) the order: which tags to split into a type and topics.
    let order = null;
    if (run.options.suggestSplits && !control.signal.aborted) {
      this._stage(run, 'split', control, 'Asking which tags to split…');
      const simplify = this._simplify();
      const saved = await simplify.getVocabulary();
      const vocabulary =
        saved.types.length > 0 || saved.topics.length > 0 ? 'keep' : 'propose';
      await simplify.proposeOrder({ vocabulary }, control);
      const progress = run.job?.progress || {};
      run.orderTokens = Number(progress.tokens) || 0;
      run.splitCounts = {
        requestsDone: Number(progress.requestsDone) || 0,
        requestsPlanned: Number(progress.requestsPlanned) || 0,
        tags: Number(progress.pairsTotal) || 0,
      };
      run.counts.tags = run.splitCounts.tags;
      order = await this._orderMembers();
    }

    // (d) everything into suggestions.
    this._stage(run, 'sort', control, 'Sorting everything into suggestions…');
    this._build(run, { scan: result, order, final: true });
    await this._readEvidence(run);
    this._changed(run);
    return {
      ...result,
      tidyUp: { suggestions: run.suggestions.length },
    };
  }

  /** Moves the run to a step and tells the job. */
  _stage(run, stage, control, message) {
    run.stage = stage;
    run.reached = Math.max(run.reached, STEP_KEYS.indexOf(stage));
    const phase = {
      compare: 'scanning',
      evidence: 'evidence',
      split: 'vocabulary',
      sort: 'finishing',
    }[stage];
    control.onProgress({ phase, message });
  }

  /** A phase the judge reported, as the step it belongs to. */
  _notePhase(run, phase) {
    let step = PHASE_STEPS[phase];
    if (!step) return;
    // The judge's own "finishing" is the end of judging, not the end of the
    // run: the order may still come, and the sort is ours.
    if (step === 'sort') step = 'judge';
    run.reached = Math.max(run.reached, STEP_KEYS.indexOf(step));
  }

  /**
   * The proposals of the order that are still to decide, with the tag a
   * merge names resolved to its id.
   */
  async _orderMembers() {
    const simplify = this._simplify();
    const proposals = (await simplify.listProposals()).filter((proposal) =>
      ['open', 'accepted'].includes(proposal.status)
    );
    let tags;
    try {
      tags = await this._merges().listEntities('tags');
    } catch {
      tags = [];
    }
    // A pair the person declined as "not the same" stays declined, whoever
    // proposes it again: the order's own rule merges plurals too.
    const dismissed = new Set(
      (await this._documents().listEntityMergeDismissals('tags')).map(
        (row) => `${Math.min(row.idA, row.idB)}-${Math.max(row.idA, row.idB)}`
      )
    );
    const members = proposals.map((proposal) => {
      let mergeTarget = null;
      if (proposal.action === 'merge' && proposal.mergeInto) {
        const name = String(proposal.mergeInto);
        const found =
          tags.find((tag) => String(tag.name) === name) ||
          tags.find(
            (tag) => String(tag.name).toLowerCase() === name.toLowerCase()
          );
        mergeTarget = found
          ? {
              id: Number(found.id),
              name: String(found.name),
              documentCount: Number(found.documentCount) || 0,
            }
          : null;
      }
      return { member: proposal, mergeTarget };
    });
    return members.filter(({ member, mergeTarget }) => {
      if (!mergeTarget) return true;
      const a = Number(member.tagId);
      const b = mergeTarget.id;
      return !dismissed.has(`${Math.min(a, b)}-${Math.max(a, b)}`);
    });
  }

  /**
   * Builds the suggestion list from a scan (or judged scan) and the order,
   * and merges it with what is already on the run: a suggestion the person
   * decided keeps its decision; one that is no longer proposed but was
   * decided stays on the list as the record of it.
   */
  _build(run, { scan, order }) {
    const wantedKinds =
      run.options.kind === 'all'
        ? ['tags', 'correspondents']
        : [run.options.kind];
    const fresh = [];
    const groupIdOf = new Map();
    const carried = new Map(
      (run.carried || []).map((suggestion) => [suggestion.id, suggestion])
    );
    const targeted = run.groupIds ? new Set(run.groupIds) : null;

    for (const group of scan?.groups || []) {
      if (!wantedKinds.includes(group.kind)) continue;
      // Without the model, a pair below the threshold is not shown: spelling
      // alone cannot make it "likely". The scan has none; the band only
      // exists in a judged result, as `ai-candidate` groups.
      let suggestion = fromDuplicateGroup(group);
      if (
        targeted &&
        !targeted.has(group.id) &&
        carried.has(suggestion.id) &&
        group.source !== 'ai-candidate'
      ) {
        // Not asked this time: the previous run's answer stands.
        suggestion = { ...carried.get(suggestion.id) };
      } else if (suggestion.certainty !== CERTAINTY.SURE) {
        suggestion.evidence = evidenceFromMembers(
          group.members,
          group.suggestedTargetId
        );
      }
      groupIdOf.set(suggestion.id, group.id);
      fresh.push(suggestion);
    }

    const ids = new Set(fresh.map((suggestion) => suggestion.id));
    for (const kind of wantedKinds) {
      for (const entity of scan?.unused?.[kind] || []) {
        const suggestion = fromUnusedEntity(entity, kind);
        if (ids.has(suggestion.id)) continue;
        ids.add(suggestion.id);
        fresh.push(suggestion);
      }
    }

    // Pairs a scan group already proposes are not proposed twice.
    const scanPairs = new Set();
    for (const suggestion of fresh) {
      if (suggestion.kind !== SUGGESTION_KINDS.MERGE || !suggestion.to)
        continue;
      for (const source of suggestion.from) {
        scanPairs.add(
          `${suggestion.entityKind}:${Math.min(source.id, suggestion.to.id)}-${Math.max(source.id, suggestion.to.id)}`
        );
      }
    }
    for (const { member, mergeTarget } of order || []) {
      const suggestion = fromOrderMember(member, { mergeTarget });
      if (!suggestion || ids.has(suggestion.id)) continue;
      if (suggestion.kind === SUGGESTION_KINDS.MERGE && suggestion.to?.id) {
        const a = suggestion.from[0].id;
        const b = suggestion.to.id;
        if (scanPairs.has(`tags:${Math.min(a, b)}-${Math.max(a, b)}`)) continue;
      }
      ids.add(suggestion.id);
      fresh.push(suggestion);
    }

    // What the person decided survives the rebuild.
    const before = new Map(
      run.suggestions.map((suggestion) => [suggestion.id, suggestion])
    );
    const merged = fresh.map((suggestion) => {
      const old = before.get(suggestion.id);
      if (!old || old.status === SUGGESTION_STATUS.OPEN) return suggestion;
      return {
        ...suggestion,
        status: old.status,
        outcome: old.outcome,
        undoId: old.undoId,
      };
    });
    for (const old of run.suggestions) {
      if (!ids.has(old.id) && old.status !== SUGGESTION_STATUS.OPEN) {
        merged.push(old);
      }
    }
    for (const [id, groupId] of run.groupIdOf) {
      if (!groupIdOf.has(id)) groupIdOf.set(id, groupId);
    }
    run.groupIdOf = groupIdOf;
    run.suggestions = sortSuggestions(merged);
  }

  /**
   * Fills the evidence of the open, not-sure merges whose sides have no
   * titles yet, by reading Paperless-ngx directly. The judge brings its own
   * when it ran; this covers the run without a model and the pairs a stopped
   * judge never reached. Bounded by EVIDENCE_LIMIT entities.
   */
  async _readEvidence(run) {
    const paperless = this._paperless();
    const wanted = new Map();
    for (const suggestion of run.suggestions) {
      if (
        suggestion.kind !== SUGGESTION_KINDS.MERGE ||
        suggestion.status !== SUGGESTION_STATUS.OPEN ||
        !suggestion.evidence
      ) {
        continue;
      }
      for (const side of suggestion.evidence.sides) {
        if (side.titles.length > 0 || side.neighbours.length > 0) continue;
        const key = `${suggestion.entityKind}:${side.id}`;
        if (!wanted.has(key) && wanted.size < EVIDENCE_LIMIT) {
          wanted.set(key, { kind: suggestion.entityKind, id: side.id });
        }
      }
    }
    if (wanted.size === 0) return;
    const entries = [...wanted.entries()];
    const read = await mapLimited(
      entries,
      EVIDENCE_CONCURRENCY,
      async ([, { kind, id }]) => {
        const titles =
          typeof paperless.getRecentDocumentTitlesByEntity === 'function'
            ? await paperless
                .getRecentDocumentTitlesByEntity(kind, id, 3)
                .catch(() => [])
            : [];
        const neighbours =
          typeof paperless.getEntityNeighbourhood === 'function'
            ? await paperless
                .getEntityNeighbourhood(kind, id, { documents: 30, limit: 3 })
                .catch(() => [])
            : [];
        return { titles, neighbours };
      }
    );
    const found = new Map(entries.map(([key], index) => [key, read[index]]));
    for (const suggestion of run.suggestions) {
      if (!suggestion.evidence) continue;
      suggestion.evidence = {
        sides: suggestion.evidence.sides.map((side) => {
          const extra = found.get(`${suggestion.entityKind}:${side.id}`);
          if (!extra) return side;
          return {
            ...side,
            titles: side.titles.length
              ? side.titles
              : (extra.titles || []).map(String).slice(0, 3),
            neighbours: side.neighbours.length
              ? side.neighbours
              : (extra.neighbours || []).map(String).slice(0, 5),
          };
        }),
      };
    }
  }

  /* --- reading a run -------------------------------------------------------- */

  /** The running or last run, null when none since start. */
  current() {
    return this.run;
  }

  /** One run by id; only the last one is kept. */
  get(id) {
    return this.run && this.run.id === id ? this.run : null;
  }

  /** Reading a run counts as watching it (the idle stop). */
  touch(run) {
    if (run) this._jobs().touch(run.id);
  }

  /**
   * Stops a run; the suggestions found so far are kept.
   *
   * @returns {object|null} the run, null when unknown
   */
  stop(id) {
    const run = this.get(id);
    if (!run) return null;
    const jobs = this._jobs();
    if (jobs.get(id)) jobs.stop(id, jobs.STOP_REASONS.USER);
    return run;
  }

  /**
   * Follows a run: `listener(run, final)` on every change, the last call with
   * final true. Throttled to at most four calls a second; the final one is
   * never held back. Subscribing to the job counts as watching it.
   *
   * @returns {() => void} unsubscribe
   */
  follow(id, listener, { intervalMs = 250 } = {}) {
    const run = this.get(id);
    if (!run) return () => {};
    let closed = false;
    let timer = null;
    let lastSent = 0;
    const send = () => {
      timer = null;
      if (closed) return;
      lastSent = Date.now();
      listener(this.toJSON(run), false);
    };
    const schedule = () => {
      if (closed || timer) return;
      const wait = Math.max(0, intervalMs - (Date.now() - lastSent));
      timer = setTimeout(send, wait);
      if (typeof timer.unref === 'function') timer.unref();
    };
    let unsubscribeJob = () => {};
    const finish = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      this.listeners.delete(onRunChange);
      unsubscribeJob();
      listener(this.toJSON(run), true);
    };
    const onRunChange = (changed) => {
      if (changed === run) schedule();
    };

    const jobs = this._jobs();
    if (!jobs.get(id) || !jobs.isRunning()) {
      // Over already (or no longer held by the job service).
      Promise.resolve().then(finish);
      return () => {
        closed = true;
      };
    }
    this.listeners.add(onRunChange);
    unsubscribeJob = jobs.subscribe(id, (event) => {
      if (event?.type === 'progress') schedule();
      else Promise.resolve().then(finish);
    });
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      this.listeners.delete(onRunChange);
      unsubscribeJob();
    };
  }

  _changed(run) {
    for (const listener of [...this.listeners]) {
      try {
        listener(run);
      } catch {
        // A broken stream is the stream's problem.
      }
    }
  }

  /** The suggestions of the current run, as GET /suggestions serves them. */
  suggestionsOf(run = this.run) {
    if (!run) {
      return { runId: null, summary: summarize([]), suggestions: [] };
    }
    return {
      runId: run.id,
      summary: summarize(run.suggestions),
      suggestions: run.suggestions,
    };
  }

  /**
   * A run in the TidyUpRun shape (schemas.js).
   *
   * @param {object} run
   * @returns {object}
   */
  toJSON(run) {
    if (!run) return null;
    const job = run.job || {};
    const progress = job.progress || {};
    const status = job.status || 'running';
    const steps = this._steps(run, status, progress);
    const budget = Number(progress.tokenBudget) || null;
    const tokens = this._tokens(run, progress);
    return {
      id: run.id,
      status,
      headline: wording.runHeadline(status),
      options: run.options,
      steps,
      progress: {
        percent: this._percent(run, status, steps, progress),
        etaText: status === 'running' ? etaText(progress.etaMs) : null,
        costText: costText(tokens, budget),
        tokens,
        tokenBudget: budget,
      },
      model: run.model,
      failure: this._failure(run, job),
      partialFailures: this._partialFailures(run, job),
      summary: summarize(run.suggestions),
      startedAt: run.startedAt,
      finishedAt: job.finishedAt || null,
    };
  }

  /** Tokens the whole run spent: the judge's and the order's. */
  _tokens(run, progress) {
    const live = Number(progress.tokens) || 0;
    if (run.reviewTokens === null) return live;
    if (run.stage === 'split' && run.orderTokens === null) {
      return run.reviewTokens + live;
    }
    return run.reviewTokens + (run.orderTokens || 0);
  }

  /** The step whose numbers are live, by where the runner is. */
  _current(run) {
    if (run.stage === 'review') return STEP_KEYS[run.reached];
    return run.stage;
  }

  _skipped(run, key) {
    if (key === 'judge') return !run.options.askModel;
    if (key === 'split') return !run.options.suggestSplits;
    return false;
  }

  _steps(run, status, progress) {
    const current = this._current(run);
    const currentIndex = Math.max(STEP_KEYS.indexOf(current), run.reached);
    const finished = status === 'done';
    return wording.RUN_STEPS.map((step, index) => {
      let state;
      if (this._skipped(run, step.key)) state = 'skipped';
      else if (finished || index < currentIndex) state = 'done';
      else if (index === currentIndex) state = 'now';
      else state = 'next';
      return {
        key: step.key,
        label: step.label,
        state,
        detail: this._detail(run, step.key, state, progress),
      };
    });
  }

  _detail(run, key, state, progress) {
    if (state === 'skipped') return '';
    const judgeLive = run.stage === 'review' && run.judgeCounts === null;
    const judge = run.judgeCounts || {
      requestsDone: judgeLive ? Number(progress.requestsDone) || 0 : 0,
      requestsPlanned: judgeLive ? Number(progress.requestsPlanned) || 0 : 0,
      pairsJudged: judgeLive ? Number(progress.pairsJudged) || 0 : 0,
      pairs: judgeLive ? Number(progress.pairsTotal) || 0 : 0,
    };
    switch (key) {
      case 'compare':
        return wording.stepDetail('compare', {
          names: run.counts.names,
          sure: run.counts.sure,
          open: judge.pairs || run.counts.open,
          done: state === 'done',
        });
      case 'evidence':
        return wording.stepDetail('evidence', {
          pairs: judge.pairs || run.counts.open,
        });
      case 'judge':
        return wording.stepDetail('judge', {
          ...judge,
          model: run.model,
        });
      case 'split': {
        const live = run.stage === 'split' && run.splitCounts === null;
        return wording.stepDetail('split', {
          tags: live
            ? Number(progress.pairsTotal) || 0
            : run.splitCounts?.tags || 0,
        });
      }
      default:
        return wording.stepDetail(key, {});
    }
  }

  /**
   * 0–100 over the whole run, never backwards: compare 0–15, evidence
   * 15–25, judge 25–85 by pairs answered, split 85–95, sort 95–100; a
   * skipped step's share goes to the others.
   */
  _percent(run, status, steps, progress) {
    if (status === 'done') {
      run.percent = 100;
      return 100;
    }
    const active = steps.filter((step) => step.state !== 'skipped');
    const total = active.reduce((sum, step) => sum + STEP_WEIGHTS[step.key], 0);
    let done = 0;
    for (const step of active) {
      const weight = STEP_WEIGHTS[step.key];
      if (step.state === 'done') done += weight;
      else if (step.state === 'now') {
        let fraction = 0;
        if (step.key === 'judge') {
          const pairs = Number(progress.pairsTotal) || 0;
          fraction =
            pairs > 0 ? (Number(progress.pairsJudged) || 0) / pairs : 0;
        } else if (step.key === 'split') {
          const planned = Number(progress.requestsPlanned) || 0;
          fraction =
            planned > 0 ? (Number(progress.requestsDone) || 0) / planned : 0;
        }
        done += weight * Math.max(0, Math.min(1, fraction));
      }
    }
    const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
    run.percent = Math.max(run.percent, Math.min(99, percent));
    return run.percent;
  }

  /** The context a failure notice is worded with. */
  _noticeContext(run, extra = {}) {
    const judge = run.judgeCounts || {};
    const pairs = Number(judge.pairs) || 0;
    const pairsJudged = Number(judge.pairsJudged) || 0;
    return {
      model: run.model || undefined,
      budget: Number(run.job?.progress?.tokenBudget) || 0,
      pairs,
      pairsJudged,
      pairsLeft: Math.max(0, pairs - pairsJudged),
      ...extra,
    };
  }

  /** A ClassifiedFailure as the TidyUpFailure the page renders. */
  _notice(run, classified, extra = {}) {
    const ctx = this._noticeContext(run, {
      endpoint: classified.endpoint || undefined,
      model: classified.model || run.model || undefined,
      ...extra,
    });
    const notice = wording.failureNotice(classified.kind, ctx);
    const technical = [
      classified.message,
      classified.status ? `HTTP ${classified.status}` : '',
      classified.endpoint ? `endpoint ${classified.endpoint}` : '',
      classified.model ? `model ${classified.model}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      kind: classified.kind,
      title: notice.title,
      body: notice.body,
      actions: notice.actions,
      settingsHint: notice.settingsHint,
      technical,
      pairsAffected:
        Number(extra.pairsAffected) ||
        (classified.kind === FAILURE_KINDS.BUDGET ? ctx.pairsLeft : 0),
    };
  }

  /**
   * The failure that ended the run: the job's own classification when the
   * job carries one, else derived from its error and stop reason. A stop by
   * the person or by the idle watch is not a failure.
   */
  _failure(run, job) {
    if (job.failure && typeof job.failure === 'object') {
      return this._notice(
        run,
        {
          kind: job.failure.kind || FAILURE_KINDS.UNKNOWN,
          message: String(job.failure.message || job.error || ''),
          model: job.failure.model || null,
          endpoint: job.failure.endpoint || null,
          status: job.failure.status || null,
        },
        job.failure
      );
    }
    if (job.status === 'failed') {
      return this._notice(
        run,
        classifyFailure(job.error || '', {
          stopReason: job.stopReason,
          model: run.model,
        })
      );
    }
    if (job.stopReason === 'token-budget') {
      return this._notice(
        run,
        classifyFailure('token budget reached', {
          stopReason: job.stopReason,
          model: run.model,
        })
      );
    }
    return null;
  }

  /**
   * Requests that failed without failing the run; their pairs are "needs a
   * look". From the job when it lists them, else one notice derived from the
   * judge's count of failed requests.
   */
  _partialFailures(run, job) {
    if (Array.isArray(job.partialFailures)) {
      return job.partialFailures.map((entry) =>
        this._notice(
          run,
          {
            kind: entry?.kind || FAILURE_KINDS.UNKNOWN,
            message: String(entry?.message || ''),
            model: entry?.model || null,
            endpoint: entry?.endpoint || null,
            status: entry?.status || null,
          },
          entry || {}
        )
      );
    }
    const failedRequests =
      run.judgeCounts === null && run.stage === 'review'
        ? Number(job.progress?.failedRequests) || 0
        : run.failedRequests;
    if (!failedRequests) return [];
    const affected = run.suggestions.filter(
      (s) =>
        s.kind === SUGGESTION_KINDS.MERGE &&
        s.status === SUGGESTION_STATUS.OPEN &&
        s.details?.verdict?.verdict === 'unsure'
    ).length;
    const judged = Number(run.judgeCounts?.pairsJudged) || 0;
    return [
      this._notice(
        run,
        classifyFailure(
          `${failedRequests} request(s) answered nothing usable`,
          { model: run.model }
        ),
        {
          pairsAffected: affected,
          pairsFine: Math.max(0, judged - affected),
        }
      ),
    ];
  }

  /* --- deciding ------------------------------------------------------------ */

  /**
   * Accepts, declines or postpones suggestions of the current run.
   *
   * @param {{ids: string[], decision: string, edits?: object}} body
   * @param {object|null} user  req.user
   * @returns {Promise<{batchId: string|null, summary: object, suggestions: object[]}>}
   */
  async decide(body = {}, user = null) {
    const run = this.run;
    if (!run) throw new TidyUpError('There is no run to decide on', 404);
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new TidyUpError('ids must be a non-empty list of suggestion ids');
    }
    if (ids.length > MAX_DECIDE_IDS) {
      throw new TidyUpError(`ids must not name more than ${MAX_DECIDE_IDS}`);
    }
    const decision = body?.decision;
    if (!['accept', 'decline', 'later'].includes(decision)) {
      throw new TidyUpError('decision must be accept, decline or later');
    }
    const edits =
      body?.edits && typeof body.edits === 'object' ? body.edits : {};
    const byId = new Map(run.suggestions.map((s) => [s.id, s]));
    const unknown = ids.filter((id) => !byId.has(String(id)));
    if (unknown.length > 0) {
      throw new TidyUpError(
        `Unknown suggestion: ${unknown.slice(0, 3).join(', ')}`,
        404
      );
    }
    const chosen = [...new Set(ids.map(String))]
      .map((id) => byId.get(id))
      // A suggestion that was carried out stays carried out; only an undo
      // takes it back.
      .filter((s) => s.status !== SUGGESTION_STATUS.DONE);

    if (this.deciding || this._merges().isWriting()) {
      throw new TidyUpError(
        'Another change is being written to Paperless-ngx. Try again in a moment.',
        409
      );
    }
    this.deciding = true;
    let batchId = null;
    try {
      if (decision === 'later') {
        for (const s of chosen) s.status = SUGGESTION_STATUS.LATER;
      } else if (decision === 'decline') {
        for (const s of chosen) await this._decline(s);
      } else {
        batchId = await this._accept(run, chosen, edits, performedByOf(user));
      }
    } finally {
      this.deciding = false;
    }
    this._changed(run);
    return { batchId, ...this._listOf(run) };
  }

  _listOf(run) {
    return {
      summary: summarize(run.suggestions),
      suggestions: run.suggestions,
    };
  }

  async _decline(suggestion) {
    try {
      if (suggestion.kind === SUGGESTION_KINDS.MERGE) {
        if (suggestion.details?.source === 'order') {
          await this._simplify().updateProposal(suggestion.from[0].id, {
            status: 'skipped',
          });
        } else {
          const members = [suggestion.to, ...suggestion.from].filter(Boolean);
          const names = {};
          for (const member of members) names[member.id] = member.name;
          // "Not the same": later runs leave the pair alone.
          await this._merges().dismiss({
            kind: suggestion.entityKind,
            ids: members.map((member) => member.id),
            names,
          });
        }
      } else if (suggestion.kind === SUGGESTION_KINDS.SPLIT) {
        await this._simplify().updateProposal(suggestion.from[0].id, {
          status: 'skipped',
        });
      }
      // A delete is declined for this run only.
      suggestion.status = SUGGESTION_STATUS.DECLINED;
      suggestion.outcome = null;
    } catch (error) {
      suggestion.outcome = error?.message || 'It could not be declined';
    }
  }

  /**
   * Carries the accepted suggestions out, one after the other, and records
   * them as one batch the undo can take back.
   *
   * @returns {Promise<string>} the batch id
   */
  async _accept(run, chosen, edits, performedBy) {
    const batchId = crypto.randomUUID();
    const entries = [];
    const record = (suggestion, undoId) => {
      if (undoId != null) {
        entries.push({ suggestionId: suggestion.id, undoId: String(undoId) });
      }
    };

    // Deletes of unused names go together, one call per kind, the way the
    // page groups them on one card.
    const unusedDeletes = chosen.filter(
      (s) =>
        s.kind === SUGGESTION_KINDS.DELETE && s.details?.source === 'unused'
    );
    const rest = chosen.filter((s) => !unusedDeletes.includes(s));

    for (const suggestion of rest) {
      const edit = edits[suggestion.id] || {};
      try {
        if (suggestion.kind === SUGGESTION_KINDS.MERGE) {
          record(
            suggestion,
            await this._acceptMerge(suggestion, edit, performedBy)
          );
        } else {
          // A split, or a delete the order proposed (it takes the tag off
          // its documents first): the order's own apply for this tag alone.
          record(
            suggestion,
            await this._acceptOrderTag(suggestion, edit, performedBy)
          );
        }
      } catch (error) {
        suggestion.status = SUGGESTION_STATUS.FAILED;
        suggestion.outcome = error?.message || 'It could not be carried out';
        suggestion.undoId = null;
      }
    }

    for (const kind of ['tags', 'correspondents']) {
      const group = unusedDeletes.filter((s) => s.entityKind === kind);
      if (group.length === 0) continue;
      await this._acceptDeletes(group, kind, edits, performedBy, record);
    }

    if (entries.length > 0) {
      run.batches.set(batchId, { id: batchId, entries });
    }
    return batchId;
  }

  async _acceptMerge(suggestion, edit, performedBy) {
    const members = [suggestion.to, ...suggestion.from].filter(Boolean);
    let targetId = Number(suggestion.to?.id);
    if (edit.keepId != null) {
      const keep = Number(edit.keepId);
      if (!members.some((member) => member.id === keep)) {
        throw new TidyUpError('keepId is not one of the names of this merge');
      }
      targetId = keep;
    }
    if (!Number.isInteger(targetId) || targetId <= 0) {
      throw new TidyUpError(
        `There is no ${suggestion.entityKind === 'correspondents' ? 'correspondent' : 'tag'} called "${suggestion.to?.name ?? ''}" in Paperless-ngx`,
        404
      );
    }
    let targetName = null;
    if (edit.targetName != null) {
      if (typeof edit.targetName !== 'string') {
        throw new TidyUpError('targetName must be a string');
      }
      const trimmed = edit.targetName.trim();
      if (trimmed.length > MAX_NAME_LENGTH) {
        throw new TidyUpError(
          `targetName must not be longer than ${MAX_NAME_LENGTH} characters`
        );
      }
      targetName = trimmed === '' ? null : trimmed;
    }
    const sourceIds = members
      .map((member) => member.id)
      .filter((id) => id !== targetId);

    const result = await this._merges().merge({
      kind: suggestion.entityKind,
      targetId,
      sourceIds,
      ...(targetName ? { targetName } : {}),
      performedBy,
    });
    const sources = Array.isArray(result?.sources) ? result.sources : [];
    const deleted = sources.filter((source) => source.deleted);
    if (deleted.length === 0) {
      suggestion.status = SUGGESTION_STATUS.FAILED;
      suggestion.outcome =
        sources.find((source) => source.error)?.error || 'Nothing was merged';
      suggestion.undoId = null;
      return null;
    }
    if (suggestion.details?.source === 'order') {
      // The order's own merge marks its proposal as applied; so does this.
      await this._documents().updateTagSplitProposal(suggestion.from[0].id, {
        status: 'applied',
      });
    }
    const moved = capitalise(
      `${wording.documents(result.documentsMoved)} moved`
    );
    const refused = sources.filter((source) => !source.deleted);
    suggestion.status = SUGGESTION_STATUS.DONE;
    suggestion.outcome =
      refused.length === 0
        ? moved
        : `${moved} · ${refused.map((source) => `${source.name}: ${source.error}`).join('; ')}`;
    suggestion.undoId = String(result.mergeId);
    return result.mergeId;
  }

  async _acceptOrderTag(suggestion, edit, performedBy) {
    const simplify = this._simplify();
    const tagId = suggestion.from[0].id;
    const patch = { status: 'open' };
    if (suggestion.kind === SUGGESTION_KINDS.SPLIT) {
      if ('typeName' in edit) patch.typeName = edit.typeName;
      if ('topicNames' in edit) patch.topicNames = edit.topicNames;
    }
    // The per-tag apply takes open proposals; an edit makes the proposal the
    // person's own, exactly as the old page's edit did.
    await simplify.updateProposal(tagId, patch);
    const result = await simplify.applySplits({ tagIds: [tagId], performedBy });
    const applied = (result?.applied || [])[0];
    if (!applied) {
      const refusal = (result?.failed || [])[0];
      suggestion.status = SUGGESTION_STATUS.FAILED;
      suggestion.outcome = refusal?.error || 'The tag was not changed';
      suggestion.undoId = null;
      return null;
    }
    if (suggestion.kind === SUGGESTION_KINDS.SPLIT) {
      const stored = await this._documents()
        .getTagSplitProposal(tagId)
        .catch(() => null);
      if (stored) {
        suggestion.typeName = stored.typeName ?? null;
        suggestion.topicNames = Array.isArray(stored.topicNames)
          ? [...stored.topicNames]
          : [];
      }
    }
    suggestion.status = SUGGESTION_STATUS.DONE;
    suggestion.outcome = capitalise(
      `${wording.documents(applied.documentsUpdated)} updated`
    );
    suggestion.undoId = applied.logId == null ? null : String(applied.logId);
    return applied.logId;
  }

  async _acceptDeletes(group, kind, edits, performedBy, record) {
    const wanted = new Set();
    for (const suggestion of group) {
      const memberIds = edits[suggestion.id]?.memberIds;
      if (Array.isArray(memberIds)) {
        for (const id of memberIds) wanted.add(Number(id));
      } else {
        wanted.add(suggestion.from[0].id);
      }
    }
    const targets = group.filter((s) => wanted.has(s.from[0].id));
    if (targets.length === 0) return;
    let result;
    try {
      result = await this._merges().deleteUnused({
        kind,
        ids: targets.map((s) => s.from[0].id),
        performedBy,
      });
    } catch (error) {
      for (const suggestion of targets) {
        suggestion.status = SUGGESTION_STATUS.FAILED;
        suggestion.outcome = error?.message || 'It could not be deleted';
        suggestion.undoId = null;
      }
      return;
    }
    const deleted = new Set((result.deleted || []).map((e) => Number(e.id)));
    const failed = new Map(
      (result.failed || []).map((e) => [Number(e.id), e.error])
    );
    for (const suggestion of targets) {
      const id = suggestion.from[0].id;
      if (deleted.has(id)) {
        suggestion.status = SUGGESTION_STATUS.DONE;
        suggestion.outcome = 'Deleted';
        suggestion.undoId = result.logId == null ? null : String(result.logId);
        record(suggestion, result.logId);
      } else {
        suggestion.status = SUGGESTION_STATUS.FAILED;
        suggestion.outcome = failed.get(id) || 'It was not deleted';
        suggestion.undoId = null;
      }
    }
  }

  /* --- undo ------------------------------------------------------------------ */

  /**
   * Undoes everything one decide call carried out. Each log entry is undone
   * once, through the same undo the merge log offers; the suggestions it
   * covered go back to open, with the ids of the re-created names.
   *
   * @param {{batchId: string}} body
   * @returns {Promise<{batchId:string, undone:string[], failed:Array<{undoId:string, error:string}>, summary:object, suggestions:object[]}>}
   */
  async undo(body = {}, user = null) {
    const run = this.run;
    const batchId = body?.batchId;
    if (typeof batchId !== 'string' || batchId.trim() === '') {
      throw new TidyUpError('batchId is required');
    }
    const batch = run?.batches.get(batchId);
    if (!batch) throw new TidyUpError('Unknown or expired batch', 404);
    if (this.deciding || this._merges().isWriting()) {
      throw new TidyUpError(
        'Another change is being written to Paperless-ngx. Try again in a moment.',
        409
      );
    }
    this.deciding = true;
    const undone = [];
    const failed = [];
    try {
      const undoIds = [...new Set(batch.entries.map((e) => e.undoId))];
      for (const undoId of undoIds) {
        try {
          const result = await this._merges().undo(Number(undoId), {
            performedBy: performedByOf(user),
          });
          if (result?.status === 'undo_failed') {
            failed.push({
              undoId,
              error:
                (result.sources || []).find((s) => s.error)?.error ||
                'Not everything could be restored',
            });
          } else {
            undone.push(undoId);
          }
          this._reopen(run, batch, undoId, result);
        } catch (error) {
          failed.push({
            undoId,
            error: error?.message || 'It could not be undone',
          });
        }
      }
      if (failed.length === 0) run.batches.delete(batchId);
    } finally {
      this.deciding = false;
    }
    this._changed(run);
    return { batchId, undone, failed, ...this._listOf(run) };
  }

  /** The suggestions an undone entry covered, open again with new ids. */
  _reopen(run, batch, undoId, result) {
    const renamed = new Map();
    for (const source of result?.sources || []) {
      if (source.restoredId != null && source.originalId != null) {
        renamed.set(Number(source.originalId), Number(source.restoredId));
      }
    }
    const remap = (entity) =>
      entity && renamed.has(entity.id)
        ? { ...entity, id: renamed.get(entity.id) }
        : entity;
    const ids = new Set(
      batch.entries
        .filter((entry) => entry.undoId === undoId)
        .map((entry) => entry.suggestionId)
    );
    run.suggestions = run.suggestions.map((suggestion) => {
      if (!ids.has(suggestion.id)) return suggestion;
      return {
        ...suggestion,
        from: suggestion.from.map(remap),
        to: remap(suggestion.to),
        status: SUGGESTION_STATUS.OPEN,
        outcome: null,
        undoId: null,
      };
    });
  }

  /* --- recent changes ------------------------------------------------------ */

  /**
   * The last merge-log rows as the page lists them.
   *
   * @returns {Promise<Array<{id:string, when:string, sentence:string, status:string, canUndo:boolean}>>}
   */
  async recent() {
    const { rows } = await this._documents().getEntityMerges({
      limit: RECENT_LIMIT,
      offset: 0,
    });
    return rows.map((entry) => {
      // The wording module says the sentence, marks the names in it and
      // judges status and undo; the fallback below only builds the sentence.
      const worded =
        typeof wording.recentChangeSentence === 'function'
          ? wording.recentChangeSentence(entry)
          : { sentence: recentChangeSentence(entry) };
      const status =
        worded.status ||
        (entry.status === 'undone'
          ? 'undone'
          : entry.status === 'partial'
            ? 'partial'
            : entry.status === 'undo_failed'
              ? 'failed'
              : 'done');
      return {
        id: String(entry.id),
        when: isoFromSqlite(entry.createdAt),
        sentence: worded.sentence,
        segments: Array.isArray(worded.segments) ? worded.segments : null,
        status,
        canUndo:
          typeof worded.canUndo === 'boolean'
            ? worded.canUndo
            : entry.status !== 'undone',
      };
    });
  }

  /** Forgets the run; tests use it between cases. */
  reset() {
    this.run = null;
    this.deciding = false;
    this.listeners.clear();
  }
}

/**
 * One merge-log row in a sentence. A stand-in until the wording module has
 * its own `recentChangeSentence`; the route prefers that one when it exists.
 *
 * @param {object} entry  EntityMergeLogEntry
 * @returns {string}
 */
function recentChangeSentence(entry) {
  const sources = Array.isArray(entry?.sources) ? entry.sources : [];
  const names = sources
    .filter((source) => source.deleted !== false)
    .map((source) => source.name);
  const noun = entry?.kind === 'correspondents' ? 'correspondent' : 'tag';
  switch (entry?.action) {
    case 'delete':
      if (entry.details) return `Deleted the ${noun} ${names[0] ?? ''}`.trim();
      return names.length === 1
        ? `Deleted the unused ${noun} ${names[0]}`
        : `Deleted ${names.length} unused ${noun}s`;
    case 'split':
      return `Split ${sources[0]?.name ?? ''} into ${entry.targetName || '…'}`;
    default:
      return `Merged ${wording.listNames(names)} into ${entry?.targetName ?? ''} · ${wording.documents(entry?.documentsMoved)} moved`;
  }
}

const tidyUpRunService = new TidyUpRunService();
tidyUpRunService.TidyUpError = TidyUpError;
tidyUpRunService.STEP_WEIGHTS = STEP_WEIGHTS;
tidyUpRunService.PHASE_STEPS = PHASE_STEPS;
tidyUpRunService.RUN_ACTIONS = RUN_ACTIONS;
tidyUpRunService.modelLabelOf = modelLabel;
tidyUpRunService.etaText = etaText;
tidyUpRunService.costText = costText;
tidyUpRunService.recentChangeSentence = recentChangeSentence;

module.exports = tidyUpRunService;
