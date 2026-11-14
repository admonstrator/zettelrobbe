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
 * makes a consumer read live removes the mark in the same change.
 *
 * The keys themselves are the entries marked `restart: true` in
 * services/settingsCatalog.js, where each one says why.
 */
const RESTART_REQUIRED_KEYS = Object.freeze(
  new Set(require('../services/settingsCatalog').restartKeys())
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
