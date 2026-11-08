'use strict';

/**
 * What went wrong with a model, in kinds a person can be told about.
 *
 * The services that talk to a model fail in a handful of ways, and today
 * each one surfaces as the raw message ("the answer contained no JSON
 * array"). This module sorts a failure into one of a few kinds; the page
 * turns the kind into a notice (services/tidyUpWording.js failureNotice)
 * and keeps the raw message one click away.
 *
 * Pure module. Classification is by the error object first (a service may
 * set `error.failureKind` where it knows), then by its message.
 */

const FAILURE_KINDS = Object.freeze({
  /** The answer arrived but could not be parsed into what was asked for. */
  UNREADABLE: 'unreadable',
  /** The run stopped itself at the configured token budget. */
  BUDGET: 'budget',
  /** The provider did not answer at all: connection refused, DNS, timeout, 5xx. */
  UNREACHABLE: 'unreachable',
  /** A reasoning model spent the whole completion on its thoughts. */
  THINKING: 'thinking',
  /** The provider refused the request itself: bad key, quota, 4xx. */
  REJECTED: 'rejected',
  /** Paperless-ngx, not the model, could not be reached. */
  PAPERLESS: 'paperless',
  /** The person stopped it. */
  STOPPED: 'stopped',
  /** Anything else. */
  UNKNOWN: 'unknown',
});

const PATTERNS = Object.freeze([
  // Paperless-ngx first: a Paperless error mentions it by name, whatever else
  // the message says, and the person needs the Paperless notice, not a model one.
  { kind: FAILURE_KINDS.PAPERLESS, re: /paperless/i },
  {
    kind: FAILURE_KINDS.THINKING,
    re: /thinking|reasoning (tokens|budget)|answer (cap|budget) .*thought|spent .*on its (thoughts|reasoning)|no verdict.*reason/i,
  },
  {
    kind: FAILURE_KINDS.UNREADABLE,
    re: /no json|not a json|answered nothing|empty answer|could not (be )?pars|unexpected token|invalid json|truncated/i,
  },
  {
    kind: FAILURE_KINDS.BUDGET,
    re: /token budget|budget (reached|exhausted)|stopReason.*budget/i,
  },
  {
    kind: FAILURE_KINDS.UNREACHABLE,
    re: /econnrefused|enotfound|eai_again|etimedout|econnreset|socket hang up|timeout|timed out|fetch failed|network|502|503|504|unreachable|did not answer/i,
  },
  {
    kind: FAILURE_KINDS.REJECTED,
    re: /401|403|429|invalid api key|incorrect api key|unauthori[sz]ed|quota|insufficient_quota|rate limit|model .*not found|404/i,
  },
]);

/**
 * @typedef {object} ClassifiedFailure
 * @property {string} kind          a FAILURE_KINDS value
 * @property {string} message       the raw message, for the Details disclosure
 * @property {string|null} model    the model name, when the error carried one
 * @property {string|null} endpoint the URL or host, when the error carried one
 * @property {number|null} status   an HTTP status, when the error carried one
 */

/**
 * @param {unknown} error  an Error, a job's `error` string, or `{ message }`
 * @param {{stopReason?: string|null, model?: string|null, endpoint?: string|null}} [context]
 * @returns {ClassifiedFailure}
 */
function classifyFailure(error, context = {}) {
  const message =
    typeof error === 'string'
      ? error
      : String(error?.message ?? error?.error ?? '');
  const explicit =
    typeof error === 'object' && error ? error.failureKind : null;
  const status =
    typeof error === 'object' && error
      ? Number(error.status ?? error.statusCode ?? error.response?.status) ||
        null
      : null;
  let kind = Object.values(FAILURE_KINDS).includes(explicit) ? explicit : null;
  if (!kind && context.stopReason === 'token-budget')
    kind = FAILURE_KINDS.BUDGET;
  if (!kind && context.stopReason === 'user') kind = FAILURE_KINDS.STOPPED;
  if (!kind && status) {
    if (status >= 500) kind = FAILURE_KINDS.UNREACHABLE;
    else if ([401, 403, 404, 429].includes(status))
      kind = FAILURE_KINDS.REJECTED;
  }
  if (!kind) {
    const hit = PATTERNS.find((p) => p.re.test(message));
    kind = hit ? hit.kind : FAILURE_KINDS.UNKNOWN;
  }
  return {
    kind,
    message,
    model:
      context.model ||
      (typeof error === 'object' && error ? error.model : null) ||
      null,
    endpoint:
      context.endpoint ||
      (typeof error === 'object' && error ? error.endpoint : null) ||
      null,
    status,
  };
}

/**
 * Marks an error with a kind where the throwing code knows it, so the
 * classifier does not have to guess from the message.
 *
 * @template {Error} E
 * @param {E} error
 * @param {string} kind  a FAILURE_KINDS value
 * @returns {E}
 */
function tagFailure(error, kind) {
  if (error && typeof error === 'object') error.failureKind = kind;
  return error;
}

module.exports = { FAILURE_KINDS, classifyFailure, tagFailure };
