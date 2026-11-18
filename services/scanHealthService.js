/**
 * ScanHealthService
 *
 * Tracks whether the document scan loop is actually able to do its job.
 *
 * Background: the scan scheduler used to be armed only after a successful
 * Paperless-ngx preflight call. A single connection failure at container start
 * left the app running without any scheduled scan while /health still reported
 * "healthy". The scheduler is now armed unconditionally and every run reports
 * its outcome here, so /health, the dashboard and monitoring see the truth.
 *
 * The service holds state only — no I/O, no timers, no dependencies besides the
 * config. That keeps it free of circular requires and testable offline. The
 * next scheduled run is the one exception to "state only": it is asked of the
 * real cron task through a provider function handed over in markArmed(), so
 * the dashboard shows the time node-cron will actually fire at instead of a
 * second parser's guess.
 */

const config = require('../config/config');

const DEFAULT_FAILURE_THRESHOLD = 3;

/** Run outcomes reported by the scan loop. */
const RUN_STATUS = {
  OK: 'ok',
  PAPERLESS_UNREACHABLE: 'paperless_unreachable',
  ERROR: 'error',
};

function createInitialState() {
  return {
    // Automatic processing is a deliberate opt-out (DISABLE_AUTOMATIC_PROCESSING=yes).
    // When it is disabled, a missing scheduler is expected and never degraded.
    automaticProcessingEnabled: true,
    armed: false,
    scanInterval: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastRunSource: null,
    lastRunStatus: null,
    lastSuccessfulRunAt: null,
    consecutiveFailures: 0,
    lastError: null,
    paperless: {
      // reachable: the host answered at all. authorized: the token was
      // accepted. usable: both — the only combination the scan loop can work
      // with. Keeping them apart stops a rejected token from being reported
      // as "Paperless-ngx is not reachable".
      reachable: null,
      authorized: null,
      usable: null,
      lastCheckedAt: null,
      status: null,
      error: null,
    },
  };
}

class ScanHealthService {
  constructor() {
    this.state = createInitialState();
    /**
     * Asks the armed cron task for its next run. Kept outside `state` so
     * getState() never copies a function into a payload.
     * @type {(() => Date|null)|null}
     */
    this.nextRunProvider = null;
  }

  /** Failure threshold before the scanner counts as degraded. */
  get failureThreshold() {
    const configured = Number(config.health?.scanFailureThreshold);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_FAILURE_THRESHOLD;
  }

  /** Whether /health should answer 503 while degraded (HEALTHCHECK_STRICT). */
  get strictHealthEnabled() {
    return config.health?.strict === 'yes';
  }

  /**
   * Records that the scan cron has been scheduled.
   * @param {string} scanInterval Cron expression the scheduler was armed with.
   * @param {(() => Date|null)|null} [nextRunProvider] Returns the next time the
   *   armed task fires — `() => task.getNextRun()` for a node-cron task.
   */
  markArmed(scanInterval, nextRunProvider = null) {
    this.state.automaticProcessingEnabled = true;
    this.state.armed = true;
    this.state.scanInterval = scanInterval || null;
    this.nextRunProvider =
      typeof nextRunProvider === 'function' ? nextRunProvider : null;
  }

  /** Records that automatic processing is switched off by configuration. */
  markAutomaticProcessingDisabled() {
    this.state.automaticProcessingEnabled = false;
    this.state.armed = false;
    this.state.scanInterval = null;
    this.nextRunProvider = null;
  }

  /**
   * When the armed scan task fires next, as an ISO string.
   *
   * Null whenever there is no honest answer: automatic processing is off, the
   * scheduler is not armed, nobody handed over a provider, or the task could
   * not name a time. Never throws — this feeds /health.
   * @returns {string|null}
   */
  getNextRunAt() {
    if (
      !this.state.automaticProcessingEnabled ||
      !this.state.armed ||
      !this.nextRunProvider
    ) {
      return null;
    }

    try {
      const next = this.nextRunProvider();
      return next instanceof Date && !Number.isNaN(next.getTime())
        ? next.toISOString()
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Records the start of a scan run.
   * @param {string} source Scan trigger ('initial', 'scheduler', 'api-manual', ...).
   */
  recordRunStart(source) {
    this.state.lastRunStartedAt = new Date().toISOString();
    this.state.lastRunSource = source || null;
  }

  /**
   * Records the outcome of a scan run. Only infrastructure problems count as
   * failures — individual documents failing to process do not.
   * @param {{status: string, error?: string|null}} result
   */
  recordRunResult({ status, error = null } = {}) {
    const runStatus = status || RUN_STATUS.ERROR;

    this.state.lastRunFinishedAt = new Date().toISOString();
    this.state.lastRunStatus = runStatus;

    if (runStatus === RUN_STATUS.OK) {
      this.state.lastSuccessfulRunAt = this.state.lastRunFinishedAt;
      this.state.consecutiveFailures = 0;
      this.state.lastError = null;
      return;
    }

    this.state.consecutiveFailures += 1;
    this.state.lastError = error || null;
  }

  /**
   * Records the result of a Paperless-ngx connectivity probe.
   * @param {{reachable: boolean, authorized: boolean, status: number|null, error: string|null}} probe
   */
  recordConnectivity(probe) {
    this.state.paperless = {
      reachable: Boolean(probe?.reachable),
      authorized: Boolean(probe?.authorized),
      usable: Boolean(probe?.reachable && probe?.authorized),
      lastCheckedAt: new Date().toISOString(),
      status: probe?.status ?? null,
      error: probe?.error || null,
    };
  }

  /**
   * Clears the connectivity result back to "never probed".
   *
   * Used when probing is not meaningful yet (setup incomplete), so the
   * dashboard shows nothing instead of warning about a connection the user has
   * not configured.
   */
  clearConnectivity() {
    this.state.paperless = createInitialState().paperless;
  }

  /**
   * Whether the scanner is unable to do its job.
   * Degraded means: automatic processing is expected to run, but either no
   * scheduler is armed or the configured number of consecutive runs failed.
   * @returns {boolean}
   */
  isDegraded() {
    if (!this.state.automaticProcessingEnabled) {
      return false;
    }

    if (!this.state.armed) {
      return true;
    }

    return this.state.consecutiveFailures >= this.failureThreshold;
  }

  /**
   * Snapshot for /health, /api/processing-status and the dashboard banner.
   * @returns {object} Deep copy so callers cannot mutate the internal state.
   */
  getState() {
    return {
      ...this.state,
      nextRunAt: this.getNextRunAt(),
      failureThreshold: this.failureThreshold,
      degraded: this.isDegraded(),
      paperless: { ...this.state.paperless },
    };
  }

  /** Resets all state. Test helper — not used by the application. */
  reset() {
    this.state = createInitialState();
    this.nextRunProvider = null;
  }
}

module.exports = new ScanHealthService();
module.exports.RUN_STATUS = RUN_STATUS;
module.exports.ScanHealthService = ScanHealthService;
