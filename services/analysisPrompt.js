'use strict';

/**
 * The document-analysis prompt, assembled in one place.
 *
 * Each provider service builds this prompt itself, and the four copies agree
 * only because they were copied from each other. This module is the copy of
 * customService's assembly, kept byte for byte — the odd indentation of the
 * pre-existing data block, a SYSTEM_PROMPT that is not set turning into the
 * word "undefined", PROMPT_TAGS that only count toward the token budget and
 * never reach the model, a webhook prompt that replaces everything including
 * the restrictions and the external data — because operators tuned their
 * prompts against exactly that text. Only anthropicService uses it so far; the
 * other providers can switch to it later without changing what their models
 * read.
 *
 * Beside the prompt it knows the answer: the JSON schema that describes the
 * object the prompt asks for (for providers that can constrain an answer to a
 * schema) and the tolerant parser that digs that object out of an answer that
 * was not constrained.
 *
 * Pure: no environment, no config, no network, no file system, no logging. The
 * caller hands in what it read and logs what comes back.
 */

const RestrictionPromptService = require('./restrictionPromptService');
const { toNameList } = require('./serviceUtils');

/**
 * Which JSON object the prompt asks for.
 *
 * FULL is config.mustHavePrompt with the custom-fields template.
 * PREDEFINED_TAGS is config.specialPromptPreDefinedTags (USE_PROMPT_TAGS=yes),
 * which asks for neither a document type nor custom fields.
 */
const ANALYSIS_RESPONSE_SHAPES = Object.freeze({
  FULL: 'full',
  PREDEFINED_TAGS: 'predefined_tags',
});

/**
 * The custom fields CUSTOM_FIELDS configures, or none with the reason.
 *
 * customService parses the variable per document and falls back to no fields
 * when it does not parse. A value that parses but holds no `custom_fields`
 * list made customService fail every analysis with a TypeError; here it is
 * the same fallback as an unparsable value, reported the same way.
 *
 * @param {unknown} customFieldsJson - the CUSTOM_FIELDS value as read
 * @returns {{fields: Array<object>, error: Error|null}}
 */
function parseCustomFields(customFieldsJson) {
  let parsed;
  try {
    parsed = JSON.parse(customFieldsJson);
  } catch (error) {
    return { fields: [], error };
  }
  if (!Array.isArray(parsed?.custom_fields)) {
    return {
      fields: [],
      error: new Error('CUSTOM_FIELDS holds no custom_fields list'),
    };
  }
  return { fields: parsed.custom_fields, error: null };
}

/**
 * The hint the template puts where the model writes a field's value.
 *
 * @param {object} field - one CUSTOM_FIELDS entry
 * @returns {string}
 */
function customFieldValueHint(field) {
  if (field?.data_type === 'date') {
    return 'Fill in the date in ISO 8601 format (YYYY-MM-DD) based on your analysis';
  }
  if (field?.data_type === 'boolean') {
    return "Fill in 'true' or 'false' based on your analysis";
  }
  return 'Fill in the value based on your analysis';
}

/**
 * The custom fields part of the analysis prompt: the template the model fills
 * in, and the string that replaces %CUSTOMFIELDS% in the must-have prompt.
 * Shared with ollamaService, whose prompt carries the same block.
 *
 * @param {string|undefined} customFieldsJson - CUSTOM_FIELDS
 * @returns {{
 *   customFields: Array<object>,
 *   customFieldsTemplate: object,
 *   customFieldsStr: string,
 *   error: Error|null
 * }} error is for the caller to log; the block is then empty
 */
function buildCustomFieldsBlock(customFieldsJson) {
  const { fields: customFields, error } = parseCustomFields(customFieldsJson);

  // An index map, not an array: {"0": {...}, "1": {...}} is what the models
  // have always been shown, and documentProcessingService reads both.
  const customFieldsTemplate = {};
  customFields.forEach((field, index) => {
    customFieldsTemplate[index] = {
      field_name: field?.value,
      value: customFieldValueHint(field),
    };
  });

  const customFieldsStr =
    '"custom_fields": ' +
    JSON.stringify(customFieldsTemplate, null, 2)
      .split('\n')
      .map((line) => '    ' + line)
      .join('\n');

  return { customFields, customFieldsTemplate, customFieldsStr, error };
}

/**
 * The system prompt of one document analysis, and what goes with it.
 *
 * The inputs are what customService reads from the environment, from config
 * and from its arguments, under the same names. The order of the steps is
 * customService's, and it matters: the restriction placeholders are replaced
 * before the external data is appended, USE_PROMPT_TAGS then replaces all of
 * it, and a webhook prompt replaces that again.
 *
 * Nothing per document goes into the system prompt — no timestamp, no id, no
 * document text — so it stays byte-identical across the documents of a scan
 * and a provider can cache it. What does change it: the existing tags,
 * correspondents and document types (with USE_EXISTING_DATA or a restriction
 * placeholder), external API data and a webhook prompt.
 *
 * @param {object} inputs
 * @param {string|undefined} inputs.systemPrompt - SYSTEM_PROMPT
 * @param {string} inputs.mustHavePrompt - config.mustHavePrompt
 * @param {string} inputs.specialPromptPreDefinedTags - config.specialPromptPreDefinedTags
 * @param {string|undefined} inputs.customFieldsJson - CUSTOM_FIELDS
 * @param {string} inputs.useExistingData - config.useExistingData ('yes'/'no')
 * @param {string} inputs.restrictToExistingTags - config.restrictToExistingTags
 * @param {string} inputs.restrictToExistingCorrespondents - config.restrictToExistingCorrespondents
 * @param {string|undefined} inputs.usePromptTags - USE_PROMPT_TAGS
 * @param {string|undefined} inputs.promptTags - PROMPT_TAGS
 * @param {Array|string} [inputs.existingTags] - entity objects or names
 * @param {Array|string} [inputs.existingCorrespondentList]
 * @param {Array|string} [inputs.existingDocumentTypesList]
 * @param {string|null} [inputs.externalApiData] - already validated and truncated
 * @param {string|null} [inputs.customPrompt] - the webhook's prompt
 * @returns {{
 *   systemPrompt: string,
 *   promptTags: string,
 *   customFieldsTemplate: object,
 *   customFieldsStr: string,
 *   customFields: Array<object>,
 *   customFieldsError: Error|null,
 *   responseShape: string
 * }} promptTags is counted toward the token budget and sent nowhere, as in
 *   customService; customFieldsError is for the caller to log
 */
function buildAnalysisPrompt({
  systemPrompt: configuredSystemPrompt,
  mustHavePrompt,
  specialPromptPreDefinedTags,
  customFieldsJson,
  useExistingData,
  restrictToExistingTags,
  restrictToExistingCorrespondents,
  usePromptTags,
  promptTags: configuredPromptTags,
  existingTags = [],
  existingCorrespondentList = [],
  existingDocumentTypesList = [],
  externalApiData = null,
  customPrompt = null,
} = {}) {
  const existingTagNames = toNameList(existingTags).join(', ');
  const existingCorrespondentNames = toNameList(existingCorrespondentList).join(
    ', '
  );
  const existingDocumentTypeNames = toNameList(existingDocumentTypesList).join(
    ', '
  );

  const {
    customFields,
    customFieldsTemplate,
    customFieldsStr,
    error: customFieldsError,
  } = buildCustomFieldsBlock(customFieldsJson);
  const mustHave = String(mustHavePrompt).replace(
    '%CUSTOMFIELDS%',
    customFieldsStr
  );

  let systemPrompt;
  let promptTags = '';
  let responseShape = ANALYSIS_RESPONSE_SHAPES.FULL;

  if (
    useExistingData === 'yes' &&
    restrictToExistingTags === 'no' &&
    restrictToExistingCorrespondents === 'no'
  ) {
    // customService writes this block as an indented template literal; these
    // are its bytes, newline and eight spaces of indentation per line.
    systemPrompt =
      '\n' +
      `        Pre-existing tags: ${existingTagNames}\n\n\n` +
      `        Pre-existing correspondents: ${existingCorrespondentNames}\n\n\n` +
      `        Pre-existing document types: ${existingDocumentTypeNames}\n\n\n` +
      '        ' +
      configuredSystemPrompt +
      '\n\n' +
      mustHave;
  } else {
    systemPrompt = configuredSystemPrompt + '\n\n' + mustHave;
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

  if (usePromptTags === 'yes') {
    promptTags = configuredPromptTags;
    systemPrompt =
      '\n' +
      '        Take these tags and try to match one or more to the document content.\n\n\n' +
      '        ' +
      specialPromptPreDefinedTags;
    responseShape = ANALYSIS_RESPONSE_SHAPES.PREDEFINED_TAGS;
  }

  if (customPrompt) {
    systemPrompt = customPrompt + '\n\n' + mustHave;
    responseShape = ANALYSIS_RESPONSE_SHAPES.FULL;
  }

  return {
    systemPrompt,
    promptTags,
    customFieldsTemplate,
    customFieldsStr,
    customFields,
    customFieldsError,
    responseShape,
  };
}

/**
 * The JSON schema of the object the prompt asks for, in the dialect the
 * Claude API's structured outputs accept: every object closed with
 * `additionalProperties: false`, no numeric or length constraints.
 *
 * Every key is required and absence is spelled null, so the model never has
 * to decide between leaving a key out and sending an empty value:
 *
 * - `correspondent` is null when the document names no sender; the analysis
 *   has always accepted that.
 * - `document_type` and `document_date` are null when the document says
 *   nothing about them. A forced date would be written to Paperless-ngx as
 *   the created date; null keeps the date the document already has.
 * - a custom field's `value` is null when the document holds nothing for it
 *   ("the custom_fields are optional and can be left out"); its `field_name`
 *   is fixed to the configured name ("do not change the value of
 *   field_name"). The values stay strings, as the template shows them —
 *   the write-back validates and converts them per data type.
 *
 * The prompt still asks for the same object in words; the schema only makes
 * sure the answer parses.
 *
 * @param {{responseShape?: string, customFields?: Array<object>}} prompt -
 *   what buildAnalysisPrompt() returned
 * @returns {object} the schema, for `output_config.format.schema`
 */
function analysisResponseSchema({
  responseShape = ANALYSIS_RESPONSE_SHAPES.FULL,
  customFields = [],
} = {}) {
  const text = () => ({ type: 'string' });
  const nullableText = () => ({ type: ['string', 'null'] });
  const full = responseShape !== ANALYSIS_RESPONSE_SHAPES.PREDEFINED_TAGS;

  // In the order the prompt lists them.
  const properties = {
    title: text(),
    correspondent: nullableText(),
    tags: { type: 'array', items: text() },
  };
  if (full) properties.document_type = nullableText();
  properties.document_date = nullableText();
  properties.language = text();

  if (full) {
    const fieldProperties = {};
    (Array.isArray(customFields) ? customFields : []).forEach(
      (field, index) => {
        const name = field?.value;
        fieldProperties[String(index)] = {
          type: 'object',
          properties: {
            field_name:
              typeof name === 'string'
                ? { type: 'string', const: name }
                : text(),
            value: nullableText(),
          },
          required: ['field_name', 'value'],
          additionalProperties: false,
        };
      }
    );
    const fieldKeys = Object.keys(fieldProperties);
    properties.custom_fields = {
      type: 'object',
      properties: fieldProperties,
      ...(fieldKeys.length > 0 ? { required: fieldKeys } : {}),
      additionalProperties: false,
    };
  }

  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/**
 * The first complete JSON object or array in a text, or null.
 *
 * Bracket counting that skips over strings, so a brace inside a title does
 * not end the object early. customService's _extractFirstJsonValue.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractFirstJsonValue(text) {
  if (!text) {
    return null;
  }

  const starts = [];
  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  if (firstObject !== -1) starts.push(firstObject);
  if (firstArray !== -1) starts.push(firstArray);
  if (starts.length === 0) {
    return null;
  }

  const startIndex = Math.min(...starts);
  const opening = text[startIndex];
  const closing = opening === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === opening) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

/**
 * The analysis object out of a model's answer.
 *
 * A schema-constrained answer parses directly. Everything else may come
 * wrapped in a code fence, after a <think> block or behind a sentence of
 * prose, so those are stripped and the first JSON value is tried next.
 * customService's _parseJsonResponse, with the same error message — the scan
 * loop sends "Invalid JSON response from API" to the OCR queue.
 *
 * @param {unknown} rawContent
 * @returns {{parsed: unknown, normalized: string}} normalized is the JSON text
 *   that parsed, for the response log
 * @throws {Error} 'Invalid JSON response from API', with the parse error as cause
 */
function parseAnalysisAnswer(rawContent) {
  const sanitizedContent = String(rawContent || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();

  try {
    return {
      parsed: JSON.parse(sanitizedContent),
      normalized: sanitizedContent,
    };
  } catch (directParseError) {
    const extractedJson = extractFirstJsonValue(sanitizedContent);
    if (!extractedJson) {
      throw new Error('Invalid JSON response from API', {
        cause: directParseError,
      });
    }

    try {
      return {
        parsed: JSON.parse(extractedJson),
        normalized: extractedJson,
      };
    } catch (extractedParseError) {
      throw new Error('Invalid JSON response from API', {
        cause: extractedParseError,
      });
    }
  }
}

module.exports = {
  ANALYSIS_RESPONSE_SHAPES,
  buildAnalysisPrompt,
  buildCustomFieldsBlock,
  analysisResponseSchema,
  parseAnalysisAnswer,
};
