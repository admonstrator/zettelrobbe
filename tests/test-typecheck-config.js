// @ts-check
'use strict';

/**
 * Every JavaScript file listed in tsconfig.json "files" must really be type
 * checked.
 *
 * tsconfig.json sets checkJs to false, so tsc checks a .js file only when it
 * starts with // @ts-check. A file that is listed but lacks the header (or a
 * path that no longer exists) is silently left unchecked, and `npm run
 * typecheck` stays green. This test closes that gap: the header may follow an
 * optional shebang line and nothing else.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
/**
 * @param {string} label
 * @param {() => void} fn
 */
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(
      `  ✗ ${label}: ${error instanceof Error ? error.message : error}`
    );
  }
};

/**
 * True when the text starts with // @ts-check, after an optional shebang line
 * and a byte order mark.
 *
 * @param {string} source
 * @returns {boolean}
 */
function startsWithTsCheck(source) {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const lines = text.split(/\r?\n/);
  const first = lines[0].startsWith('#!') ? lines[1] : lines[0];
  return typeof first === 'string' && /^\/\/\s*@ts-check\s*$/.test(first);
}

const tsconfig = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tsconfig.json'), 'utf8')
);
/** @type {string[]} */
const files = tsconfig.files;
const scripts = files.filter((file) => /\.(c|m)?js$/.test(file));

check('the header check recognises the accepted and rejected forms', () => {
  assert.ok(startsWithTsCheck('// @ts-check\n"use strict";\n'));
  assert.ok(startsWithTsCheck('#!/usr/bin/env node\n// @ts-check\n'));
  assert.ok(startsWithTsCheck('// @ts-check\r\n'));
  assert.ok(!startsWithTsCheck("'use strict';\n// @ts-check\n"));
  assert.ok(!startsWithTsCheck('/* @ts-check */\n'));
  assert.ok(!startsWithTsCheck('// @ts-nocheck\n'));
  assert.ok(!startsWithTsCheck(''));
});

check('tsconfig.json lists JavaScript files', () => {
  assert.ok(Array.isArray(files), 'tsconfig.json "files" is not an array');
  assert.ok(scripts.length > 0, 'no .js entry in tsconfig.json "files"');
});

for (const file of scripts) {
  check(`${file} exists and starts with // @ts-check`, () => {
    const absolute = path.join(REPO_ROOT, file);
    assert.ok(fs.existsSync(absolute), `${file} is listed but does not exist`);
    assert.ok(
      startsWithTsCheck(fs.readFileSync(absolute, 'utf8')),
      `${file} is listed in tsconfig.json but does not start with // @ts-check, so tsc skips it (checkJs is false)`
    );
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
