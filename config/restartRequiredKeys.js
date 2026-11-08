'use strict';

/**
 * The environment keys whose new value only takes effect after the process
 * restarts, because something read them once at boot and keeps the result:
 * the listening port, the proxy and cookie flags the Express app was built
 * with, the rate limiter, the cron schedules, the OpenID client.
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
    // Express app construction
    'PAPERLESS_AI_PORT',
    'TRUST_PROXY',
    'COOKIE_SECURE_MODE',
    'GLOBAL_RATE_LIMIT_WINDOW_MS',
    'GLOBAL_RATE_LIMIT_MAX',
    'JWT_SECRET',
    // Cron schedules registered at boot
    'SCAN_INTERVAL',
    'RECONCILIATION_INTERVAL',
    'OCR_AUTO_PROCESS_INTERVAL',
    'OCR_AUTO_PROCESS_ENABLED',
    // OpenID Connect client, discovered once at boot
    'OIDC_ENABLED',
    'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_ADMIN_EMAIL',
    'OIDC_REDIRECT_URI',
    'OIDC_SCOPES',
    'OIDC_EMAIL_CLAIM',
    'OIDC_ALLOW_UNVERIFIED_EMAIL',
    'OIDC_TOKEN_AUTH_METHOD',
    // Logging is configured when the logger module loads
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
