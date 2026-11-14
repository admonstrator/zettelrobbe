// @ts-check
'use strict';

/**
 * The one place that ends the process on purpose so the supervisor (pm2 in the
 * Docker image) starts it again with the new configuration.
 *
 * Routes call requestRestart() instead of process.exit(), so a test can replace
 * `exit` and still exercise the handler without ending its own process.
 */

/** Long enough for the response to reach the browser before the process ends. */
const DEFAULT_RESTART_DELAY_MS = 5000;

class RestartService {
  constructor() {
    /**
     * Ends the process. Looked up on every call, so a test may replace it.
     *
     * @type {(code: number) => void}
     */
    this.exit = (code) => process.exit(code);
  }

  /**
   * Schedules a clean exit (code 0) after `delayMs`.
   *
   * @param {number} [delayMs] - how long to wait before exiting
   * @returns {NodeJS.Timeout} the pending timer
   */
  requestRestart(delayMs = DEFAULT_RESTART_DELAY_MS) {
    return setTimeout(() => this.exit(0), delayMs);
  }
}

module.exports = new RestartService();
