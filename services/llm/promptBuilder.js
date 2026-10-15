'use strict';

/**
 * The analysis instructions, assembled once for every provider.
 *
 * openai, azure and custom send the result as their system message; Ollama
 * puts it in front of the document in its prompt and keeps its own short
 * system prompt. Either way the cascade below is the same, and it used to be
 * copied into each of them.
 */

const config = require('../../config/config');
const RestrictionPromptService = require('../restrictionPromptService');
const { toNameList } = require('../serviceUtils');
const { buildCustomFieldsBlock } = require('./customFieldsTemplate');

// The layout of the two literal blocks below is what the providers have always
// sent, down to the whitespace. It is kept as it was so that moving the code
// here does not change a single prompt.
const BLOCK_INDENT = '        ';

function preExistingDataBlock(tags, correspondents, documentTypes) {
  return (
    `\n${BLOCK_INDENT}Pre-existing tags: ${tags}\n\n\n` +
    `${BLOCK_INDENT}Pre-existing correspondents: ${correspondents}\n\n\n` +
    `${BLOCK_INDENT}Pre-existing document types: ${documentTypes}\n\n\n` +
    BLOCK_INDENT
  );
}

const PREDEFINED_TAGS_INTRO =
  `\n${BLOCK_INDENT}Take these tags and try to match one or more to the document content.\n\n\n` +
  BLOCK_INDENT;

/**
 * Build the instructions for one document analysis.
 *
 * In order, each step overriding or extending the previous one:
 *  1. SYSTEM_PROMPT plus mustHavePrompt with the custom fields block; with
 *     USE_EXISTING_DATA (and no restriction) the existing tags,
 *     correspondents and document types in front of it.
 *  2. The %RESTRICTED_*% placeholders resolved.
 *  3. The external API data appended.
 *  4. With USE_PROMPT_TAGS, all of the above replaced by the predefined-tags
 *     prompt; PROMPT_TAGS is handed out as promptTags.
 *  5. A custom prompt (webhook) replaces all of it, followed by mustHavePrompt.
 *
 * @param {Object} input
 * @param {Array<Object|string>} [input.existingTags]
 * @param {Array<Object|string>} [input.existingCorrespondentList]
 * @param {Array<Object|string>} [input.existingDocumentTypesList]
 * @param {string|null} [input.externalApiData] Already validated and truncated.
 * @param {string|null} [input.customPrompt]
 * @param {string} [input.customFieldsBlock] Defaults to the configured fields.
 * @returns {{systemPrompt: string, promptTags: string}}
 */
function buildAnalysisPrompt({
  existingTags = [],
  existingCorrespondentList = [],
  existingDocumentTypesList = [],
  externalApiData = null,
  customPrompt = null,
  customFieldsBlock = buildCustomFieldsBlock(),
} = {}) {
  const mustHavePrompt = config.mustHavePrompt.replace(
    '%CUSTOMFIELDS%',
    customFieldsBlock
  );
  let systemPrompt;
  let promptTags = '';

  if (
    config.useExistingData === 'yes' &&
    config.restrictToExistingTags === 'no' &&
    config.restrictToExistingCorrespondents === 'no'
  ) {
    systemPrompt =
      preExistingDataBlock(
        toNameList(existingTags).join(', '),
        toNameList(existingCorrespondentList).join(', '),
        toNameList(existingDocumentTypesList).join(', ')
      ) +
      process.env.SYSTEM_PROMPT +
      '\n\n' +
      mustHavePrompt;
  } else {
    systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + mustHavePrompt;
  }

  systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
    systemPrompt,
    existingTags,
    existingCorrespondentList,
    existingDocumentTypesList
  );

  if (externalApiData) {
    systemPrompt += `\n\nAdditional context from external API:\n${externalApiData}`;
  }

  if (process.env.USE_PROMPT_TAGS === 'yes') {
    promptTags = process.env.PROMPT_TAGS;
    systemPrompt = PREDEFINED_TAGS_INTRO + config.specialPromptPreDefinedTags;
  }

  if (customPrompt) {
    systemPrompt = customPrompt + '\n\n' + mustHavePrompt;
  }

  return { systemPrompt, promptTags };
}

module.exports = { buildAnalysisPrompt };
