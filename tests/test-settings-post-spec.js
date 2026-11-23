/**
 * Test: the API documentation of POST /settings describes the fields that
 * changed meaning
 *
 * Two fields of the settings save changed in v2026.11.04 and were not in the
 * OpenAPI spec at all: ocrValidationTimeout (seconds, default 120 instead of
 * the old form's 30) and externalApiTransform (a path into the answer, no
 * longer JavaScript). aiTagName said only "Tag name to use", although an
 * unset name and an empty one mean different things.
 *
 * Reads OPENAPI/openapi.json, which CI regenerates from the @swagger blocks
 * and compares, so the routes say the same.
 *
 * Covers:
 * 1. ocrValidationTimeout: an integer in seconds, 1 to 7200, default 120
 * 2. externalApiTransform: a path such as data.items[0].name, not code
 * 3. aiTagName: unset means ai-processed, empty means no tag
 * 4. ocrRunRightAway: nothing while automatic processing is off
 */

'use strict';

const assert = require('assert');
const path = require('path');

const spec = require(path.join(__dirname, '..', 'OPENAPI', 'openapi.json'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

const fields =
  spec.paths['/settings'].post.requestBody.content['application/json'].schema
    .properties;

test('ocrValidationTimeout: seconds, 1 to 7200, default 120', () => {
  const field = fields.ocrValidationTimeout;
  assert.ok(field, 'documented');
  assert.strictEqual(field.type, 'integer');
  assert.strictEqual(field.minimum, 1);
  assert.strictEqual(field.maximum, 7200);
  assert.match(field.description, /in seconds/);
  assert.match(field.description, /default 120/);
  assert.match(field.description, /SETUP_OCR_VALIDATION_TIMEOUT_MS/);
});

test('externalApiTransform: a path, not code', () => {
  const field = fields.externalApiTransform;
  assert.ok(field, 'documented');
  assert.strictEqual(field.type, 'string');
  assert.match(field.description, /data\.items\[0\]\.name/);
  assert.match(field.description, /not code/);
  assert.match(field.description, /EXTERNAL_API_TRANSFORM/);
  assert.strictEqual(field.example, 'data.items[0].name');
});

test('aiTagName: unset means ai-processed, empty means no tag', () => {
  const field = fields.aiTagName;
  assert.match(field.description, /no name is set the tag is ai-processed/);
  assert.match(field.description, /empty string means no tag/);
  assert.strictEqual(field.example, 'ai-processed');
});

test('ocrRunRightAway: nothing while automatic processing is off', () => {
  assert.match(
    fields.ocrRunRightAway.description,
    /disableAutomaticProcessing is on/
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
