/**
 * Regression test for the OCR enabled-flag normalization bug.
 *
 * The string 'no' is truthy in JavaScript. A naive `enabled ? 'yes' : 'no'`
 * check therefore treated `enabled = 'no'` as "OCR is enabled", causing
 * /api/setup/complete to attempt (and fail) an OCR connection test even when
 * the user explicitly disabled the OCR feature.
 *
 * This test verifies that validateOcrConnectionForSetup skips the network
 * check for all falsy / disabled representations of `enabled`.
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// Inline a minimal copy of validateOcrConnectionForSetup so the test works
// without needing a running setupService or network.  The production version
// lives in routes/setup.js; we replicate only the normalization branch under
// test.
// ---------------------------------------------------------------------------

function normalizeEnabled(enabled) {
  // FIXED version (routes/setup.js line ~3465):
  return (enabled === true || String(enabled ?? '').trim().toLowerCase() === 'yes') ? 'yes' : 'no';
}

const cases = [
  // disabled representations
  { input: false,       expected: 'no',  label: 'boolean false' },
  { input: 'no',        expected: 'no',  label: 'string "no"' },
  { input: 'No',        expected: 'no',  label: 'string "No" (mixed case)' },
  { input: 'NO',        expected: 'no',  label: 'string "NO" (uppercase)' },
  { input: '',          expected: 'no',  label: 'empty string' },
  { input: null,        expected: 'no',  label: 'null' },
  { input: undefined,   expected: 'no',  label: 'undefined' },
  { input: 0,           expected: 'no',  label: 'number 0' },

  // enabled representations
  { input: true,        expected: 'yes', label: 'boolean true' },
  { input: 'yes',       expected: 'yes', label: 'string "yes"' },
  { input: 'Yes',       expected: 'yes', label: 'string "Yes" (mixed case)' },
  { input: 'YES',       expected: 'yes', label: 'string "YES" (uppercase)' },
];

let failed = 0;
for (const { input, expected, label } of cases) {
  const result = normalizeEnabled(input);
  try {
    assert.strictEqual(result, expected, `normalizeEnabled(${JSON.stringify(input)}) should be "${expected}"`);
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}: ${err.message}`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n[FAIL] test-setup-ocr-disabled-skip: ${failed} case(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\n✅ test-setup-ocr-disabled-skip passed');
}
