'use strict';

/**
 * The OpenAI provider: the OpenAI-compatible service configured from
 * OPENAI_API_KEY and OPENAI_MODEL. Everything lives in
 * services/openaiCompatibleService.js; this path stays for its importers.
 */
module.exports = require('./openaiCompatibleService').forProvider('openai');
