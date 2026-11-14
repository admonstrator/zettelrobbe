/**
 * Test: recognising password-protected PDFs and finding their password
 *
 * pdfPasswordService decides two things the unlock flow rests on: whether a
 * PDF cannot be opened without a password (only then is OCR stopped and an
 * unlock offered), and which stored password opens it (only that one goes to
 * Paperless-ngx). Both read poppler's pdfinfo; here a fake stands in for it,
 * test-pdf-password-real.js runs the real binary.
 *
 * Covers:
 * 1. The stored list: JSON array, one per line, blanks and repeats dropped
 * 2. isPdf() recognises the header, also after a little junk
 * 3. needsPassword(): only poppler's "Incorrect password" counts; a damaged
 *    PDF, a missing pdfinfo and a non-PDF do not
 * 4. findPassword() tries each candidate as user and as owner password and
 *    returns the first that opens the file, or null
 * 5. The settings field: empty keeps the stored list, a typed list replaces
 *    it as JSON, the remove switch empties it
 */

'use strict';

const assert = require('assert');

const pdfPasswordService = require('../services/pdfPasswordService');
const settingsCatalog = require('../services/settingsCatalog');

const { parsePasswordList, serializePasswordList, isPdf } = pdfPasswordService;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1');

/**
 * A fake pdfinfo: opens the file only with the given user or owner password.
 * Records every call.
 */
function fakePdfinfo({ userPassword = null, ownerPassword = null } = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args: args.slice(0, -1) });
    const flagIndex = args.findIndex((a) => a === '-upw' || a === '-opw');
    const flag = flagIndex >= 0 ? args[flagIndex] : null;
    const value = flagIndex >= 0 ? args[flagIndex + 1] : null;
    const opens =
      (userPassword === null && ownerPassword === null) ||
      (flag === '-upw' && value === userPassword) ||
      (flag === '-opw' && value === ownerPassword);
    if (opens) return { stdout: 'Encrypted: yes', stderr: '' };
    const error = new Error('Command failed: pdfinfo');
    error.code = 1;
    error.stderr = 'Command Line Error: Incorrect password\n';
    throw error;
  };
  return { exec, calls };
}

async function withExec(exec, fn) {
  const original = pdfPasswordService._execFile;
  pdfPasswordService._execFile = exec;
  try {
    return await fn();
  } finally {
    pdfPasswordService._execFile = original;
  }
}

async function run() {
  await test('the stored list reads JSON and one password per line', () => {
    assert.deepStrictEqual(parsePasswordList('["a, b", "c"]'), ['a, b', 'c']);
    assert.deepStrictEqual(parsePasswordList('one\r\ntwo\n\n one \ntwo'), [
      'one',
      'two',
    ]);
    assert.deepStrictEqual(parsePasswordList(''), []);
    assert.deepStrictEqual(parsePasswordList(undefined), []);
    assert.deepStrictEqual(parsePasswordList(['x', 3, '', 'x']), ['x']);
    // A value that only looks like JSON is read line by line.
    assert.deepStrictEqual(parsePasswordList('[broken'), ['[broken']);
    assert.strictEqual(serializePasswordList(['a"b']), '["a\\"b"]');
    assert.strictEqual(serializePasswordList([]), '');
  });

  await test('isPdf() finds the header, also after leading junk', () => {
    assert.strictEqual(isPdf(PDF), true);
    assert.strictEqual(
      isPdf(Buffer.concat([Buffer.from('\r\n  '), PDF])),
      true
    );
    assert.strictEqual(isPdf(Buffer.from('\x89PNG\r\n')), false);
    assert.strictEqual(isPdf(Buffer.alloc(0)), false);
  });

  await test('needsPassword() is true only for "Incorrect password"', async () => {
    const locked = fakePdfinfo({ userPassword: 'secret' });
    assert.strictEqual(
      await withExec(locked.exec, () => pdfPasswordService.needsPassword(PDF)),
      true
    );
    assert.deepStrictEqual(locked.calls[0].args, []);

    const open = fakePdfinfo();
    assert.strictEqual(
      await withExec(open.exec, () => pdfPasswordService.needsPassword(PDF)),
      false
    );

    const damaged = async () => {
      const error = new Error('Command failed');
      error.code = 1;
      error.stderr = "Syntax Error: Couldn't read xref table\n";
      throw error;
    };
    assert.strictEqual(
      await withExec(damaged, () => pdfPasswordService.needsPassword(PDF)),
      false
    );

    const missing = async () => {
      const error = new Error('spawn pdfinfo ENOENT');
      error.code = 'ENOENT';
      throw error;
    };
    assert.strictEqual(
      await withExec(missing, () => pdfPasswordService.needsPassword(PDF)),
      false
    );

    const neverCalled = fakePdfinfo({ userPassword: 'x' });
    assert.strictEqual(
      await withExec(neverCalled.exec, () =>
        pdfPasswordService.needsPassword(Buffer.from('plain text'))
      ),
      false
    );
    assert.strictEqual(neverCalled.calls.length, 0);
  });

  await test('findPassword() returns the first candidate that opens the file', async () => {
    const pdfinfo = fakePdfinfo({ userPassword: 'right' });
    const found = await withExec(pdfinfo.exec, () =>
      pdfPasswordService.findPassword(PDF, ['wrong', 'right', 'later'])
    );
    assert.strictEqual(found, 'right');
    assert.deepStrictEqual(
      pdfinfo.calls.map((c) => c.args),
      [
        ['-upw', 'wrong'],
        ['-opw', 'wrong'],
        ['-upw', 'right'],
      ]
    );
  });

  await test('findPassword() accepts the owner password too', async () => {
    const pdfinfo = fakePdfinfo({ userPassword: 'user', ownerPassword: 'own' });
    const found = await withExec(pdfinfo.exec, () =>
      pdfPasswordService.findPassword(PDF, ['own'])
    );
    assert.strictEqual(found, 'own');
  });

  await test('findPassword() answers null when nothing fits', async () => {
    const pdfinfo = fakePdfinfo({ userPassword: 'right' });
    assert.strictEqual(
      await withExec(pdfinfo.exec, () =>
        pdfPasswordService.findPassword(PDF, ['a', 'b'])
      ),
      null
    );
    assert.strictEqual(
      await withExec(pdfinfo.exec, () =>
        pdfPasswordService.findPassword(PDF, [])
      ),
      null
    );
  });

  await test('the settings field keeps, replaces and removes the list', () => {
    const entry = settingsCatalog.getEntry('PDF_PASSWORDS');
    assert.ok(entry, 'PDF_PASSWORDS is a setting');
    assert.strictEqual(entry.secret, true);
    const stored = '["old"]';
    assert.deepStrictEqual(entry.parse(undefined, stored, {}), {});
    assert.deepStrictEqual(entry.parse('   ', stored, {}), {});
    assert.deepStrictEqual(entry.parse('new, one\nsecond\n', stored, {}), {
      value: '["new, one","second"]',
    });
    assert.deepStrictEqual(
      entry.parse('ignored', stored, { pdfPasswordsClear: 'yes' }),
      { value: '' }
    );
    assert.deepStrictEqual(
      entry.parse('', stored, { pdfPasswordsClear: 'no' }),
      {}
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
