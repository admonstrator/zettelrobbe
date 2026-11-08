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
 * set `error.failureKind` where it knows), then by its code and status, then
 * by its message.
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

const KIND_VALUES = Object.freeze(Object.values(FAILURE_KINDS));

/**
 * The fallback for an error nobody tagged: its message. Every pattern is
 * pinned in tests/test-model-failure.js with a message the services in this
 * code base really throw or log.
 */
const PATTERNS = Object.freeze([
  // Paperless-ngx first: a Paperless error mentions it by name, whatever else
  // the message says, and the person needs the Paperless notice, not a model one.
  { kind: FAILURE_KINDS.PAPERLESS, re: /paperless/i },
  {
    kind: FAILURE_KINDS.STOPPED,
    re: /request was aborted|operation was aborted|stopped while waiting/i,
  },
  {
    kind: FAILURE_KINDS.THINKING,
    re: /thinking|reasoning (tokens|budget)|answer (cap|budget) .*thought|spent .*on its (thoughts|reasoning)|no verdict.*reason|hit a token limit|exceeded the token limit|do not fit the token limit|cut off with nothing usable/i,
  },
  {
    kind: FAILURE_KINDS.UNREADABLE,
    re: /no json|not a json|answered nothing|empty answer|could not (be )?(pars|read)|unexpected token|invalid json|truncated|invalid response from|carried no text|proposed no vocabulary/i,
  },
  {
    kind: FAILURE_KINDS.BUDGET,
    re: /token budget|budget (reached|exhausted|spent)|stopReason.*budget/i,
  },
  {
    kind: FAILURE_KINDS.UNREACHABLE,
    re: /econnrefused|enotfound|eai_again|etimedout|econnreset|ehostunreach|enetunreach|socket hang up|timeout|timed out|fetch failed|network|connection error|502|503|504|unreachable|did not answer/i,
  },
  {
    kind: FAILURE_KINDS.REJECTED,
    re: /401|403|429|invalid api key|incorrect api key|invalid x-api-key|unauthori[sz]ed|forbidden|quota|rate limit|model .*not found|404|not configured|no ai provider|missing api key|client not initialized/i,
  },
]);

/**
 * Codes a transport leaves on what it throws when nothing answered: Node's
 * socket codes, axios' own and undici's.
 */
const UNREACHABLE_CODES = Object.freeze([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_NETWORK',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
/** How the OpenAI and Anthropic SDKs name a request that got no answer. */
const UNREACHABLE_NAMES = Object.freeze([
  'APIConnectionError',
  'APIConnectionTimeoutError',
]);
/** Codes and types an API error body carries for a refused request. */
const REJECTED_CODES = Object.freeze([
  'invalid_api_key',
  'insufficient_quota',
  'model_not_found',
  'rate_limit_exceeded',
  'authentication_error',
  'permission_error',
]);

/** The HTTP status an error carries, null when it carries none. */
function statusOf(error) {
  if (!error || typeof error !== 'object') return null;
  return (
    Number(error.status ?? error.statusCode ?? error.response?.status) || null
  );
}

/**
 * The kind a transport error is by its code, name and status alone; null
 * when none of them says. Never reads the message: that is the classifier's
 * fallback, not something the transport knows.
 *
 * @param {unknown} error
 * @returns {string|null}
 */
function transportKind(error) {
  if (!error || typeof error !== 'object') return null;
  const code = String(error.code ?? error.cause?.code ?? '');
  if (UNREACHABLE_CODES.includes(code.toUpperCase())) {
    return FAILURE_KINDS.UNREACHABLE;
  }
  if (
    REJECTED_CODES.includes(code) ||
    REJECTED_CODES.includes(String(error.type ?? error.error?.type ?? ''))
  ) {
    return FAILURE_KINDS.REJECTED;
  }
  if (
    UNREACHABLE_NAMES.includes(error.name) ||
    UNREACHABLE_NAMES.includes(error.constructor?.name)
  ) {
    return FAILURE_KINDS.UNREACHABLE;
  }
  const status = statusOf(error);
  if (status === 408 || (status && status >= 500)) {
    return FAILURE_KINDS.UNREACHABLE;
  }
  if ([401, 403, 404, 429].includes(status)) return FAILURE_KINDS.REJECTED;
  return null;
}

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
  const isObject = typeof error === 'object' && error !== null;
  const explicit = isObject ? error.failureKind : null;
  const status = statusOf(error);
  let kind = KIND_VALUES.includes(explicit) ? explicit : null;
  if (!kind && context.stopReason === 'token-budget')
    kind = FAILURE_KINDS.BUDGET;
  if (!kind && (context.stopReason === 'user' || context.stopReason === 'idle'))
    kind = FAILURE_KINDS.STOPPED;
  // Paperless-ngx by name before any status: its errors reach the services
  // as 502s, and a 502 of the archive is not a model that went away.
  if (!kind && PATTERNS[0].re.test(message)) kind = FAILURE_KINDS.PAPERLESS;
  if (!kind && isObject && error.name === 'AbortError')
    kind = FAILURE_KINDS.STOPPED;
  if (!kind) kind = transportKind(error);
  if (!kind) {
    const hit = PATTERNS.find((p) => p.re.test(message));
    kind = hit ? hit.kind : FAILURE_KINDS.UNKNOWN;
  }
  return {
    kind,
    message,
    model: context.model || (isObject ? error.model : null) || null,
    endpoint: context.endpoint || (isObject ? error.endpoint : null) || null,
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

/**
 * Tags a transport error by its code or status, unless it already carries a
 * kind. What the provider services call in their catch blocks: it changes
 * nothing about what is thrown, only what it says about itself.
 *
 * @template E
 * @param {E} error
 * @returns {E}
 */
function tagTransportFailure(error) {
  if (!error || typeof error !== 'object' || error.failureKind) return error;
  const kind = transportKind(error);
  if (kind) error.failureKind = kind;
  return error;
}

/** A `<think>` block, closed or left open by a cut-off. */
const THINK_BLOCK = /<think>[\s\S]*?(<\/think>|$)/gi;

/**
 * Why an answer that could not be used could not be used: the model spent
 * the completion on reasoning (`thinking`), or it wrote something that is
 * not what it was asked for (`unreadable`).
 *
 * Thinking is what the request reports, not a guess: the provider counted
 * reasoning tokens, or streamed reasoning text (Ollama's `thinking`, vLLM's
 * `reasoning_content`, a Claude thinking block), or the model wrote a
 * `<think>` block — and nothing of an answer is left once that is taken
 * away. A completion that stopped at its cap with nothing written outside
 * its reasoning is the same case with the reasoning not shown. A model that
 * reasoned and then wrote prose instead of the list is unreadable: it did
 * answer, just not in the form asked for.
 *
 * @param {unknown} answer  the text the service returned (or the partial
 *   text of a cut-off); the services normally strip the reasoning already
 * @param {object|null} usage  the service's `lastGenerateTextUsage`
 * @param {{truncated?: boolean}} [flags]
 * @returns {'thinking'|'unreadable'}
 */
function unusableAnswerKind(answer, usage, { truncated = false } = {}) {
  const raw = String(answer ?? '');
  const rest = raw.replace(THINK_BLOCK, '').trim();
  const reasoned =
    Number(usage?.reasoningTokens) > 0 ||
    Number(usage?.reasoningChars) > 0 ||
    /<think>/i.test(raw);
  if (rest === '' && (reasoned || truncated)) return FAILURE_KINDS.THINKING;
  return FAILURE_KINDS.UNREADABLE;
}

/**
 * One failed request as a run's usage summary keeps it (`usage.failures`):
 * the classification plus what the request was about and where it sat.
 *
 * @typedef {ClassifiedFailure & {
 *   pairsAffected?: number, tagsAffected?: number, namesAffected?: number,
 *   request?: {index: number|null, total: number|null}, requests?: number
 * }} RequestFailure
 */

/** The counts a failure may carry, summed by collapseFailures(). */
const COUNT_KEYS = Object.freeze([
  'pairsAffected',
  'tagsAffected',
  'namesAffected',
]);

/**
 * @param {unknown} error  an Error or a message
 * @param {{kind?: string, model?: string|null, endpoint?: string|null,
 *   pairsAffected?: number, tagsAffected?: number, namesAffected?: number,
 *   index?: number|null, total?: number|null}} [context]  `kind` overrides
 *   the classification where the caller knows better than the error
 * @returns {RequestFailure}
 */
function requestFailure(error, context = {}) {
  const record = classifyFailure(error, {
    model: context.model,
    endpoint: context.endpoint,
  });
  if (KIND_VALUES.includes(context.kind)) record.kind = context.kind;
  for (const key of COUNT_KEYS) {
    const value = Number(context[key]);
    if (context[key] != null && Number.isFinite(value) && value >= 0) {
      record[key] = value;
    }
  }
  const index = Number(context.index);
  const total = Number(context.total);
  record.request = {
    index: Number.isFinite(index) && index > 0 ? index : null,
    total: Number.isFinite(total) && total > 0 ? total : null,
  };
  return record;
}

/**
 * Many failed requests as the page tells them: one entry per kind, in the
 * order the kinds first occurred, the affected counts summed, `requests`
 * saying how many failed requests stand behind it, and the first message as
 * the technical line.
 *
 * @param {RequestFailure[]} failures
 * @returns {RequestFailure[]}
 */
function collapseFailures(failures) {
  const byKind = new Map();
  for (const failure of Array.isArray(failures) ? failures : []) {
    if (!failure || typeof failure !== 'object') continue;
    const kind = KIND_VALUES.includes(failure.kind)
      ? failure.kind
      : FAILURE_KINDS.UNKNOWN;
    let entry = byKind.get(kind);
    if (!entry) {
      entry = {
        kind,
        message: String(failure.message ?? ''),
        model: failure.model ?? null,
        endpoint: failure.endpoint ?? null,
        status: failure.status ?? null,
        requests: 0,
      };
      byKind.set(kind, entry);
    }
    entry.requests +=
      Number(failure.requests) > 0 ? Number(failure.requests) : 1;
    for (const key of COUNT_KEYS) {
      const value = Number(failure[key]);
      if (failure[key] != null && Number.isFinite(value)) {
        entry[key] = (entry[key] || 0) + value;
      }
    }
  }
  return [...byKind.values()];
}

module.exports = {
  FAILURE_KINDS,
  classifyFailure,
  tagFailure,
  tagTransportFailure,
  transportKind,
  unusableAnswerKind,
  requestFailure,
  collapseFailures,
};
