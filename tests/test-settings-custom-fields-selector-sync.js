/**
 * Custom Fields save broke (issue #357) because settings.js still queried
 * Tailwind-era selectors (`p.font-medium`, `p.text-sm`) while the settings view
 * had moved to zr markup (`.zr-strong`, `.zr-sm`, plus data hooks for new rows).
 *
 * This test keeps the serializer and duplicate detection wired to selectors that
 * match the actual markup rendered by views/settings.ejs and by
 * createFieldElement() in settings.js.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SETTINGS_JS = path.join(__dirname, '..', 'public', 'js', 'settings.js');
const SETTINGS_EJS = path.join(__dirname, '..', 'views', 'settings.ejs');

const settingsSource = fs.readFileSync(SETTINGS_JS, 'utf8');
const viewSource = fs.readFileSync(SETTINGS_EJS, 'utf8');

function section(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  assert.ok(start !== -1, `Could not find "${startToken}"`);
  const end = source.indexOf(endToken, start);
  assert.ok(end !== -1, `Could not find "${endToken}" after "${startToken}"`);
  return source.slice(start, end);
}

const selectorConstants = section(
  settingsSource,
  'const CUSTOM_FIELD_NAME_SELECTOR',
  'function updateCustomFieldsJson()'
);
assert.ok(
  selectorConstants.includes('[data-field-name]') &&
    selectorConstants.includes('p.zr-strong'),
  'CUSTOM_FIELD_NAME_SELECTOR must include zr/data-hook selectors used by custom field rows'
);
assert.ok(
  selectorConstants.includes('[data-field-type]') &&
    selectorConstants.includes('p.zr-sm'),
  'CUSTOM_FIELD_TYPE_SELECTOR must include zr/data-hook selectors used by custom field rows'
);

const updateBlock = section(
  settingsSource,
  'function updateCustomFieldsJson()',
  'function createFieldElement('
);
assert.ok(
  updateBlock.includes('CUSTOM_FIELD_NAME_SELECTOR') &&
    updateBlock.includes('CUSTOM_FIELD_TYPE_SELECTOR'),
  'updateCustomFieldsJson must use shared selectors so serialization stays in sync with markup changes'
);
assert.ok(
  !updateBlock.includes("querySelector('p.font-medium')") &&
    !updateBlock.includes("querySelector('p.text-sm')"),
  'updateCustomFieldsJson must not depend on removed Tailwind-era selectors'
);

const addBlock = section(
  settingsSource,
  'function addCustomField()',
  '// Called from inline onclick handlers in the settings view.'
);
assert.ok(
  addBlock.includes('CUSTOM_FIELD_NAME_SELECTOR'),
  'addCustomField duplicate detection must use shared custom field selectors'
);
assert.ok(
  !addBlock.includes("querySelectorAll('p.font-medium')"),
  'addCustomField must not use stale Tailwind selectors for duplicate detection'
);

const customFieldsSection = section(
  viewSource,
  'id="sec-custom-fields"',
  'id="customFieldsJson"'
);
assert.ok(
  /<p class="zr-strong">/.test(customFieldsSection),
  'views/settings.ejs server-rendered custom field rows must expose the zr-strong name element'
);
assert.ok(
  /<p class="zr-sm zr-faint">/.test(customFieldsSection),
  'views/settings.ejs server-rendered custom field rows must expose the zr-sm type element'
);

console.log('[PASS] Custom field selector wiring is synced between view and settings.js');
