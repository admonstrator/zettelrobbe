'use strict';

/**
 * The scanner and Paperless-ngx part of the health payload, shared by
 * GET /health (routes/system.js) and GET /api/processing-status
 * (routes/scan.js). Moved verbatim from routes/setup.js.
 *
 * Exports: buildScannerHealthSnapshot.
 */

const scanControl = require('./scanControl');
const scanHealthService = require('./scanHealthService');

/**
 * Builds the scanner/Paperless section of the health payload.
 * Shared by /health and /api/processing-status so both report the same state.
 */
function buildScannerHealthSnapshot() {
  const scanner = scanHealthService.getState();
  const scanState = scanControl.getState();

  return {
    scanner: {
      automaticProcessingEnabled: scanner.automaticProcessingEnabled,
      armed: scanner.armed,
      running: Boolean(scanState.running),
      scanInterval: scanner.scanInterval,
      lastRunStartedAt: scanner.lastRunStartedAt,
      lastRunFinishedAt: scanner.lastRunFinishedAt,
      lastRunSource: scanner.lastRunSource,
      lastRunStatus: scanner.lastRunStatus,
      lastSuccessfulRunAt: scanner.lastSuccessfulRunAt,
      consecutiveFailures: scanner.consecutiveFailures,
      failureThreshold: scanner.failureThreshold,
      degraded: scanner.degraded,
      lastError: scanner.lastError,
    },
    paperless: {
      reachable: scanner.paperless.reachable,
      authorized: scanner.paperless.authorized,
      usable: scanner.paperless.usable,
      status: scanner.paperless.status,
      lastCheckedAt: scanner.paperless.lastCheckedAt,
      error: scanner.paperless.error,
    },
  };
}

module.exports = { buildScannerHealthSnapshot };
