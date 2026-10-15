'use strict';

/**
 * The %CUSTOMFIELDS% block of the analysis prompt.
 *
 * Renders the custom fields configured in CUSTOM_FIELDS as the JSON fragment
 * the model is asked to fill in, one entry per field with a hint for its data
 * type. Every provider used to carry its own copy of this; Ollama had three.
 */

const DATE_HINT =
  'Fill in the date in ISO 8601 format (YYYY-MM-DD) based on your analysis';
const BOOLEAN_HINT = "Fill in 'true' or 'false' based on your analysis";
const VALUE_HINT = 'Fill in the value based on your analysis';

/**
 * The value hint the model gets for one data type.
 *
 * @param {string} dataType Paperless-ngx custom field data type.
 * @returns {string}
 */
function valueHintFor(dataType) {
  if (dataType === 'date') return DATE_HINT;
  if (dataType === 'boolean') return BOOLEAN_HINT;
  return VALUE_HINT;
}

/**
 * The configured custom fields, or none when the setting cannot be read.
 *
 * @param {string|undefined} rawCustomFields CUSTOM_FIELDS as stored.
 * @returns {{custom_fields: Array<{value: string, data_type: string}>}}
 */
function parseCustomFields(rawCustomFields) {
  try {
    return JSON.parse(rawCustomFields);
  } catch (error) {
    console.error(`Failed to parse CUSTOM_FIELDS: ${error.message}`);
    console.debug(error);
    return { custom_fields: [] };
  }
}

/**
 * Build the `"custom_fields": {...}` fragment that replaces %CUSTOMFIELDS%.
 *
 * The fragment is indented so it sits inside the JSON example of
 * mustHavePrompt; the model copies that layout back.
 *
 * @param {string|undefined} [rawCustomFields=process.env.CUSTOM_FIELDS]
 * @returns {string}
 */
function buildCustomFieldsBlock(rawCustomFields = process.env.CUSTOM_FIELDS) {
  const template = {};
  parseCustomFields(rawCustomFields).custom_fields.forEach((field, index) => {
    template[index] = {
      field_name: field.value,
      value: valueHintFor(field.data_type),
    };
  });

  return (
    '"custom_fields": ' +
    JSON.stringify(template, null, 2)
      .split('\n')
      .map((line) => '    ' + line)
      .join('\n')
  );
}

module.exports = { buildCustomFieldsBlock };
