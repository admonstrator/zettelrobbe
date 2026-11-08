'use strict';

/**
 * The custom provider: the OpenAI-compatible service configured from
 * CUSTOM_BASE_URL, CUSTOM_API_KEY and CUSTOM_MODEL. Everything lives in
 * services/openaiCompatibleService.js; this path stays for its importers.
 */
module.exports = require('./openaiCompatibleService').forProvider('custom');
