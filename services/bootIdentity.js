// @ts-check
'use strict';

/**
 * The identity of this process, drawn once when the module loads: GET /health
 * (routes/system.js) reports it and the settings page (routes/settings.js)
 * embeds it. It must exist exactly once per process. Moved verbatim from
 * routes/setup.js.
 *
 * Exports: BOOT_IDENTITY.
 */

const crypto = require('crypto');

/* Drawn once per process. The settings page embeds it and, after a save that
   restarts the server, waits for /health to report a different one: the old
   process keeps answering healthy for the seconds before it exits, which is
   how a reload used to land on a server that was already gone. */
const BOOT_IDENTITY = Object.freeze({
  bootId: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
});

module.exports = { BOOT_IDENTITY };
