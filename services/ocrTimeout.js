// @ts-check
'use strict';

/**
 * How long OCR waits for one request (SETUP_OCR_VALIDATION_TIMEOUT_MS, in
 * milliseconds).
 *
 * The key is older than its job. It came in (4125ba5) for the setup's OCR
 * connection test and model discovery, with 30 seconds as the form's default.
 * Document OCR had its own fixed 120 seconds until 1572d36 let the same key
 * govern it, keeping 120 seconds for an installation without the key. The
 * settings page, the wizard and the save went on offering 30 seconds, so a
 * page that showed 30 ran OCR with 120 until the first save wrote 30 down.
 *
 * The default lives here so that every surface uses the same one: the
 * runtime (services/mistralOcrService.js), the settings catalogue (page,
 * save, wizard, .env export) and the setup wizard. It stays the 120 seconds
 * document OCR has always waited without the key.
 *
 * Nothing here reads process.env on its own: the caller passes the
 * environment, so a value saved on the settings page counts on the next call.
 */

/** What OCR waits when neither key below is set. */
const DEFAULT_OCR_TIMEOUT_MS = 120000;

/**
 * The OCR timeout in effect, in milliseconds: SETUP_OCR_VALIDATION_TIMEOUT_MS,
 * else SETUP_VALIDATION_TIMEOUT_MS (the setup's general timeout), else the
 * default. A value below one second, or one that is not a number, counts as
 * unset.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env
 * @returns {number}
 */
function ocrTimeoutMsFromEnv(env) {
  const raw =
    env.SETUP_OCR_VALIDATION_TIMEOUT_MS ||
    env.SETUP_VALIDATION_TIMEOUT_MS ||
    String(DEFAULT_OCR_TIMEOUT_MS);
  const parsed = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(parsed) && parsed >= 1000
    ? parsed
    : DEFAULT_OCR_TIMEOUT_MS;
}

module.exports = { DEFAULT_OCR_TIMEOUT_MS, ocrTimeoutMsFromEnv };
