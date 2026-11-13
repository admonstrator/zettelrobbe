'use strict';

/**
 * Source text of the route layer, for tests that look for a handler or a
 * helper by its text.
 *
 * Why this exists: the former routes/setup.js was split into one router per
 * feature plus shared middleware. A test that reads one fixed file would break
 * on every move although nothing changed in behaviour. Reading every route module and
 * every middleware module keeps such tests valid wherever the code lives.
 *
 * Code that moves into services/ is not covered on purpose: a test of a service
 * helper should require that service directly instead of reading its text.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_DIRS = ['routes', 'middleware'];

/**
 * Concatenates every .js file in routes/ and middleware/ (sorted by name)
 * into one string.
 *
 * @returns {string} the joined source text
 */
function readRouteSources() {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    const absDir = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(absDir)) {
      continue;
    }
    const names = fs
      .readdirSync(absDir)
      .filter((name) => name.endsWith('.js'))
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      files.push(path.join(absDir, name));
    }
  }
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

module.exports = { readRouteSources, REPO_ROOT };
