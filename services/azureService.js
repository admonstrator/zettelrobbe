'use strict';

/**
 * The Azure OpenAI provider: the OpenAI-compatible service configured from
 * AZURE_ENDPOINT, AZURE_API_KEY, AZURE_API_VERSION and AZURE_DEPLOYMENT_NAME,
 * with the deployment name as the model. Everything lives in
 * services/openaiCompatibleService.js; this path stays for its importers.
 */
module.exports = require('./openaiCompatibleService').forProvider('azure');
