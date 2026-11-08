'use strict';

/**
 * The environment keys whose new value only takes effect after the process
 * restarts, because something read them once at boot and keeps the result:
 * the listening port, the proxy and cookie flags the Express app was built
 * with, the rate limiter, the cron schedules, the Paperless-ngx client.
 *
 * Every other key is read live — config getters and services look at
 * process.env when they need the value — so saving it applies at once and
 * the settings page does not restart the server for it. The settings route
 * decides from this list whether a save ends in a restart, and the settings
 * form shows its restart note from the same list; neither has a list of its
 * own.
 *
 * A key belongs here only while its consumer provably snapshots it. Whoever
 * makes a consumer read live removes the key in the same change.
 */
const RESTART_REQUIRED_KEYS = Object.freeze(
  new Set([
    // Express app construction (server.js): app.listen(), app.set('trust
    // proxy'), the CSRF cookie options and the global rate limiter.
    'PAPERLESS_AI_PORT',
    'TRUST_PROXY',
    'COOKIE_SECURE_MODE',
    'GLOBAL_RATE_LIMIT_WINDOW_MS',
    'GLOBAL_RATE_LIMIT_MAX',
    // The API docs routes are mounted or not at boot (server.js).
    'EXPOSE_API_DOCS',
    // Cron schedules registered at boot by startScanning() in server.js, and
    // the switches that decide whether each one is registered at all.
    'SCAN_INTERVAL',
    'DISABLE_AUTOMATIC_PROCESSING',
    'RECONCILIATION_INTERVAL',
    'RECONCILIATION_ENABLED',
    'OCR_AUTO_PROCESS_INTERVAL',
    'OCR_AUTO_PROCESS_ENABLED',
    'MISTRAL_OCR_ENABLED',
    // The connectivity probe's setInterval is started once at boot.
    'PAPERLESS_PROBE_INTERVAL_SECONDS',
    // server.js keeps MIN_CONTENT_LENGTH in a module constant.
    'MIN_CONTENT_LENGTH',
    // paperlessService builds its HTTP client once from these and keeps the
    // tag, correspondent and custom field ids it read from that instance.
    'PAPERLESS_API_URL',
    'PAPERLESS_API_TOKEN',
    'PAPERLESS_REQUEST_TIMEOUT_SECONDS',
    // Each logger takes its level when it is constructed.
    'LOG_LEVEL',
  ])
);

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isRestartRequiredKey(key) {
  return RESTART_REQUIRED_KEYS.has(String(key ?? '').trim());
}

/**
 * The keys among `changedKeys` that need a restart, in the order given.
 *
 * @param {Iterable<string>} changedKeys
 * @returns {string[]}
 */
function restartRequiredAmong(changedKeys) {
  return [...changedKeys].filter(isRestartRequiredKey);
}

module.exports = {
  RESTART_REQUIRED_KEYS,
  isRestartRequiredKey,
  restartRequiredAmong,
};
