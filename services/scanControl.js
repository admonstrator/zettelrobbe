// @ts-check
'use strict';

/**
 * The state of the document scan and the two levers on it, start and stop.
 *
 * The scan loop lives in services/scanService.js, which mutates the state
 * object while it runs; server.js registers its start and stop functions at
 * boot. Routes and services only read the state or pull a lever through this
 * module; before server.js has registered, both levers report that they are
 * not available.
 */

/**
 * @typedef {object} ScanState
 * @property {boolean} running - a scan is in progress
 * @property {boolean} stopRequested - the user asked the running scan to stop
 * @property {string|null} source - what started the running scan
 * @property {string|null} startedAt - ISO time the running scan started
 * @property {string|null} stopRequestedAt - ISO time the stop was requested
 */

/**
 * @typedef {object} ScanTriggerResult
 * @property {boolean} started - a new scan was started
 * @property {boolean} running - a scan is running now
 * @property {boolean} [stopRequested] - the running scan is stopping
 * @property {string} message - what happened, for the caller
 */

/**
 * @callback TriggerScanNow
 * @param {string} [source] - what asks for the scan, e.g. 'api-manual'
 * @returns {Promise<ScanTriggerResult>}
 */

/**
 * @callback RequestScanStop
 * @returns {boolean} true when a running scan was asked to stop
 */

/** @returns {ScanState} */
function idleState() {
  return {
    running: false,
    stopRequested: false,
    source: null,
    startedAt: null,
    stopRequestedAt: null,
  };
}

/**
 * The one scan state. Never replaced, only mutated, so a reference taken at
 * boot stays valid.
 *
 * @type {ScanState}
 */
const state = idleState();

/** @type {TriggerScanNow|null} */
let registeredTrigger = null;
/** @type {RequestScanStop|null} */
let registeredStop = null;

/**
 * The live scan state object. services/scanService.js writes to it; everyone
 * else reads.
 *
 * @returns {ScanState}
 */
function getState() {
  return state;
}

/** @returns {boolean} true while a scan is in progress */
function isRunning() {
  return state.running === true;
}

/**
 * Called once by server.js at boot, with the levers of services/scanService.js.
 *
 * @param {{ triggerScanNow?: TriggerScanNow|null, requestScanStop?: RequestScanStop|null }} levers
 * @returns {void}
 */
function register({ triggerScanNow = null, requestScanStop = null } = {}) {
  registeredTrigger =
    typeof triggerScanNow === 'function' ? triggerScanNow : null;
  registeredStop =
    typeof requestScanStop === 'function' ? requestScanStop : null;
}

/** @returns {boolean} true once a scan can be started */
function canTriggerScan() {
  return registeredTrigger !== null;
}

/** @returns {boolean} true once a running scan can be asked to stop */
function canRequestStop() {
  return registeredStop !== null;
}

/**
 * Starts a scan through the registered trigger.
 *
 * @param {string} [source] - what asks for the scan
 * @returns {Promise<ScanTriggerResult>}
 * @throws {Error} when no trigger is registered; check canTriggerScan() first
 */
async function triggerScanNow(source) {
  if (!registeredTrigger) {
    throw new Error('Scan control is not registered');
  }
  return registeredTrigger(source);
}

/**
 * Asks the running scan to stop after the current document.
 *
 * @returns {boolean} true when a running scan was asked to stop
 * @throws {Error} when no stop function is registered; check canRequestStop() first
 */
function requestScanStop() {
  if (!registeredStop) {
    throw new Error('Scan control is not registered');
  }
  return registeredStop();
}

/**
 * Back to boot state: idle, nothing registered. For tests.
 *
 * @returns {void}
 */
function reset() {
  Object.assign(state, idleState());
  registeredTrigger = null;
  registeredStop = null;
}

module.exports = {
  getState,
  isRunning,
  register,
  canTriggerScan,
  canRequestStop,
  triggerScanNow,
  requestScanStop,
  reset,
};
