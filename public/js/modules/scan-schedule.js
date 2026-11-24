/**
 * The scan clock in the dashboard's "Processing status" card: when the last
 * scan finished, when the next one runs, and the schedule in words.
 *
 * Pure functions only — no DOM, no timers — so the wording, the countdown and
 * every state can be tested directly against the shipped code (see
 * tests/test-scan-schedule.js). The dashboard module owns the elements and the
 * one-second tick.
 */

import { formatTimeAgo } from './scanner-health.js';

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;

function pad(value) {
  return String(value).padStart(2, '0');
}

/** A whole number from a cron field, or null for anything else. */
function plainNumber(field, min, max) {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/** N from a "*\/N" step field, or null for anything else. */
function stepOf(field, max) {
  const match = /^\*\/(\d+)$/.exec(field);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 1 && value <= max ? value : null;
}

function asDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A cron expression in words, for the shapes people actually configure: every
 * N minutes, every N hours, hourly and daily at a time. Anything else comes back
 * as the raw expression, which is still true and still readable to whoever
 * wrote it.
 *
 * Times named in the words ("Daily at 02:00", "Every hour at :15") are taken
 * from `nextRunAt` when it is given, in the viewer's own time zone: the server
 * reads the expression in its zone (often UTC in a container), and the card
 * must not say "Daily at 02:00" right next to a next scan at 03:00.
 *
 * @param {string|null|undefined} expression five fields, or six with seconds
 * @param {{nextRunAt?: string|Date|null}} [options]
 * @returns {string} '' when there is no expression
 */
export function describeSchedule(expression, { nextRunAt = null } = {}) {
  const raw = String(expression || '').trim();
  if (!raw) return '';

  let fields = raw.split(/\s+/);
  // A seconds field of 0 is the five-field expression in disguise.
  if (fields.length === 6 && fields[0] === '0') fields = fields.slice(1);
  if (fields.length !== 5) return raw;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return raw;

  const next = asDate(nextRunAt);
  const localMinute = (fallback) => (next ? next.getMinutes() : fallback);
  const localClock = (h, m) =>
    next
      ? `${pad(next.getHours())}:${pad(next.getMinutes())}`
      : `${pad(h)}:${pad(m)}`;

  if (hour === '*') {
    if (minute === '*') return 'Every minute';
    const everyMinutes = stepOf(minute, 59);
    if (everyMinutes !== null) {
      return everyMinutes === 1
        ? 'Every minute'
        : `Every ${everyMinutes} minutes`;
    }
    const atMinute = plainNumber(minute, 0, 59);
    if (atMinute !== null) {
      const shown = localMinute(atMinute);
      return shown === 0 ? 'Every hour' : `Every hour at :${pad(shown)}`;
    }
    return raw;
  }

  const atMinute = plainNumber(minute, 0, 59);
  if (atMinute === null) return raw;

  const everyHours = stepOf(hour, 23);
  if (everyHours !== null) {
    const shown = localMinute(atMinute);
    const base = everyHours === 1 ? 'Every hour' : `Every ${everyHours} hours`;
    return shown === 0 ? base : `${base} at :${pad(shown)}`;
  }

  const atHour = plainNumber(hour, 0, 23);
  if (atHour !== null) return `Daily at ${localClock(atHour, atMinute)}`;

  return raw;
}

/**
 * The countdown to the next scan. Seconds are rounded up, so the last second
 * reads "in 1s" rather than "in 0s", and nothing at or past zero is ever shown
 * as a number: a scan that is due says so until the next poll brings the new
 * time (or the running state).
 *
 * @param {number} ms milliseconds until the run
 * @returns {string} "in 37s", "in 2m 37s", "in 1h 05m", "in 2d 3h" or "due now"
 */
export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'due now';

  const total = Math.ceil(ms / 1000);
  if (total < MINUTE_S) return `in ${total}s`;
  if (total < HOUR_S) {
    return `in ${Math.floor(total / MINUTE_S)}m ${pad(total % MINUTE_S)}s`;
  }
  if (total < DAY_S) {
    const minutes = Math.floor((total % HOUR_S) / MINUTE_S);
    return `in ${Math.floor(total / HOUR_S)}h ${pad(minutes)}m`;
  }
  const hours = Math.floor((total % DAY_S) / HOUR_S);
  return `in ${Math.floor(total / DAY_S)}d ${hours}h`;
}

function localDayNumber(date) {
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) /
      (DAY_S * 1000)
  );
}

function isoDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The local clock time of a run, on a 24-hour clock like every other time in
 * the app. A run on another day names the day, so "02:00" can never be read
 * as "in a few minutes" when it means tomorrow night.
 *
 * @param {string|Date} value
 * @param {{now?: number, formatDay?: (date: Date) => string}} [options]
 *   `formatDay` renders a date further out than tomorrow (the dashboard passes
 *   the configured date format).
 * @returns {string} "14:45", "tomorrow 02:00", "<day> 02:00" or ''
 */
export function formatClockTime(
  value,
  { now = Date.now(), formatDay = isoDay } = {}
) {
  const date = asDate(value);
  if (!date) return '';

  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = localDayNumber(date) - localDayNumber(new Date(now));
  if (days === 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  return `${formatDay(date)} ${clock}`;
}

/**
 * "Last scan": when the last run finished, and whether it failed — the health
 * banner tells why, the card only must not make a failed run look like a good
 * one.
 *
 * @param {object} scanner the `scanner` block of /api/processing-status
 * @param {number} now
 */
function describeLastScan(scanner, now) {
  if (!scanner.lastRunFinishedAt) return 'No scan yet';
  const ago = formatTimeAgo(scanner.lastRunFinishedAt, { now });
  return scanner.lastRunStatus && scanner.lastRunStatus !== 'ok'
    ? `${ago} (failed)`
    : ago;
}

/**
 * Everything the card says about the scan schedule, from one
 * /api/processing-status body and the current time.
 *
 * - running: "Scanning now" instead of a countdown;
 * - automatic processing off: no next time, the schedule says it is off;
 * - scheduler not armed, or no next time known: no invented time;
 * - otherwise the clock time and the countdown, and `counting` asks the caller
 *   to keep ticking.
 *
 * @param {object} data /api/processing-status response body
 * @param {{now?: number, formatDay?: (date: Date) => string}} [options]
 * @returns {{last: string, next: string, schedule: string, scheduleTitle: string, counting: boolean}}
 *   `scheduleTitle` is the raw expression when the words replaced it.
 */
export function describeScanSchedule(
  data,
  { now = Date.now(), formatDay } = {}
) {
  const scanner = data && data.scanner;
  if (!scanner) {
    return {
      last: '—',
      next: '—',
      schedule: '—',
      scheduleTitle: '',
      counting: false,
    };
  }

  const last = describeLastScan(scanner, now);

  if (scanner.automaticProcessingEnabled === false) {
    return {
      last,
      next: 'Not scheduled',
      schedule: 'Automatic scanning is off',
      scheduleTitle: '',
      counting: false,
    };
  }

  const expression = String(scanner.scanInterval || '').trim();
  const words = describeSchedule(expression, { nextRunAt: scanner.nextRunAt });
  const schedule = scanner.armed ? words || '—' : 'Scheduler not running';
  const scheduleTitle =
    scanner.armed && expression && words !== expression ? expression : '';

  if (data.isScanning || scanner.running) {
    return {
      last,
      next: 'Scanning now',
      schedule,
      scheduleTitle,
      counting: false,
    };
  }

  const nextAt = scanner.armed ? asDate(scanner.nextRunAt) : null;
  if (!nextAt) {
    return {
      last,
      next: 'Not scheduled',
      schedule,
      scheduleTitle,
      counting: false,
    };
  }

  return {
    last,
    next: `${formatClockTime(nextAt, { now, formatDay })} · ${formatCountdown(nextAt.getTime() - now)}`,
    schedule,
    scheduleTitle,
    counting: true,
  };
}
