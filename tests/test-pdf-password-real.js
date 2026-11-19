/**
 * Real-binary test for pdfPasswordService: runs the actual pdfinfo against
 * two small PDFs in tests/fixtures/pdf-passwords/. The test runner skips this
 * test when pdfinfo is not installed.
 *
 * - user-password.pdf: AES-256, user password "open, sesame", owner password
 *   "owner-pw". Cannot be read without one of them.
 * - owner-password-only.pdf: AES-128 with an empty user password. Opens
 *   without a password and must not count as protected.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pdfPasswordService = require('../services/pdfPasswordService');

const FIXTURES = path.join(__dirname, 'fixtures', 'pdf-passwords');
const locked = fs.readFileSync(path.join(FIXTURES, 'user-password.pdf'));
const ownerOnly = fs.readFileSync(
  path.join(FIXTURES, 'owner-password-only.pdf')
);

async function run() {
  assert.strictEqual(await pdfPasswordService.needsPassword(locked), true);
  assert.strictEqual(await pdfPasswordService.needsPassword(ownerOnly), false);
  console.log('✅  only a user password makes a PDF protected');

  assert.strictEqual(
    await pdfPasswordService.findPassword(locked, [
      'wrong',
      'open, sesame',
      'later',
    ]),
    'open, sesame'
  );
  assert.strictEqual(
    await pdfPasswordService.findPassword(locked, ['owner-pw']),
    'owner-pw'
  );
  assert.strictEqual(
    await pdfPasswordService.findPassword(locked, ['open', 'sesame']),
    null
  );
  console.log('✅  the right user or owner password is found, nothing else');
}

run().catch((error) => {
  console.error(`❌  ${error.message}`);
  process.exit(1);
});
