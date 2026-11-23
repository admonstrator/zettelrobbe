/**
 * Test: the settings topic list shows which topic is open
 *
 * settings-nav.js shows one topic per view and marks its link in the side list
 * with aria-current="page" (the page renders the first one the same way). The
 * highlight lived only on aria-current="true", the value the scroll-spy of the
 * old section list wrote, so the open topic looked like every other one. On top
 * of that a plain `.zr-settings-nav a { font-weight }` in the pages layer beat
 * the bold of the highlight whatever its specificity.
 *
 * Covers:
 * 1. The value settings-nav.js and the view write is one the stylesheet styles
 * 2. No pages rule restyles every topic link, which would bury the highlight
 * 3. A hash that is not valid percent-encoding (/settings#100%) is read as
 *    written instead of throwing, which left the page without its topics
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const navJs = read('public', 'js', 'modules', 'settings-nav.js');
const view = read('views', 'settings.ejs');
const modulesCss = read('public', 'css', 'modules.css');
const settingsCss = read('public', 'css', 'pages', 'settings.css');

/** The rule body for a selector list that contains `selector`. */
function bodyFor(css, selector) {
  const at = css.indexOf(selector);
  if (at === -1) return null;
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

test('The open topic is marked with a value the stylesheet highlights', () => {
  const written = navJs.match(
    /dataset\.entryLink === entry\.dataset\.entry \? '([a-z]+)'/
  );
  assert.ok(written, 'settings-nav.js no longer marks the open topic link');
  const value = written[1];
  assert.ok(
    view.includes(`settingsFirstEntry ? '${value}'`),
    `The view renders the first topic with another value than "${value}"`
  );
  const body = bodyFor(modulesCss, `.zr-sectionnav a[aria-current='${value}']`);
  assert.ok(body, `No rule styles .zr-sectionnav a[aria-current='${value}']`);
  assert.match(body, /background:/, 'The highlight has no background');
  assert.match(body, /font-weight:\s*600/, 'The highlight is not bold');
});

test('No settings rule restyles every topic link over the highlight', () => {
  const plain = settingsCss.match(/\.zr-settings-nav a\s*\{[^}]*\}/g) || [];
  plain.forEach((rule) =>
    assert.doesNotMatch(
      rule,
      /font-weight|background|color/,
      `This pages-layer rule outranks the highlight: ${rule}`
    )
  );
});

(async () => {
  const nav = await import(
    pathToFileURL(path.join(root, 'public', 'js', 'modules', 'settings-nav.js'))
      .href
  );

  test('A malformed hash is read as written, never thrown', () => {
    assert.strictEqual(nav.hashKey('#ocr'), 'ocr');
    assert.strictEqual(nav.hashKey('#sec-%C3%BCber'), 'sec-\u00fcber');
    assert.strictEqual(nav.hashKey(''), '');
    // Not percent-encoding: the text as written. It names no topic, so the
    // page opens the first one.
    ['100%', '%E0%A4', '%', 'ocr%zz'].forEach((raw) => {
      assert.strictEqual(nav.hashKey(`#${raw}`), raw);
      assert.strictEqual(
        nav.entryForHash(raw, () => false),
        null
      );
    });
    // The topic list reads every hash through it, on load and on hashchange
    // alike (both call resolve()).
    assert.match(
      navJs,
      /function resolve\(hash\) \{\s+const key = hashKey\(hash\);/
    );
    assert.doesNotMatch(
      navJs.replace(/export function hashKey[\s\S]*?\n\}\n/, ''),
      /decodeURIComponent/,
      'every hash goes through hashKey()'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
