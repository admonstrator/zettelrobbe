/**
 * Test: the settings page keeps a topic in a column of a readable width
 *
 * On a large display every control sat on the left while the switches sat at
 * the far right edge of the window, a screen away from their labels. A topic
 * now sits in a bounded column next to the topic list, left-aligned; on a
 * phone the page is one column, and the topic list shows only while a search
 * stands (the topic picker is the phone's list).
 *
 * Covers:
 * 1. The page wrapper: topic list, then a column of at most 760px
 * 2. The phone: one column, the side static, the topic list hidden unless
 *    searching, as a list rather than the scrolling strip of .zr-sectionnav
 * 3. The search field and the list follow the page as one sticky column
 * 4. The rows of a card carry their own air, the same above and below, and the
 *    blocks of rows (the OCR block, a provider's fields) are ruled off inside
 * 5. The styleguide keeps its own full-width frame
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const flat = (text) => text.replace(/\s+/g, ' ');

const css = flat(read('public', 'css', 'pages', 'settings.css'));
const view = read('views', 'settings.ejs');
const styleguide = read('views', 'styleguide.ejs');

/** The top-level part of the stylesheet and the part inside the phone query. */
const phoneAt = css.lastIndexOf('@media (max-width: 860px) {');
const desktop = css.slice(0, phoneAt);
const phone = css.slice(phoneAt);

/** The body of the first rule whose whole selector list is `selector`. */
function body(source, selector) {
  const head = `${flat(selector)} {`;
  let at = source.indexOf(head);
  // A whole selector list starts after the end of a rule, a comment or the
  // opening of a block; `.zr-settings-nav {` must not answer for
  // `.zr-settings-page:not([data-searching]) .zr-settings-nav {`.
  while (at !== -1 && !/[}{/] $/.test(source.slice(at - 2, at))) {
    at = source.indexOf(head, at + 1);
  }
  assert.notStrictEqual(at, -1, `no rule for ${selector}`);
  const open = at + head.length;
  return source.slice(open, source.indexOf('}', open));
}

// ── 1. The column ───────────────────────────────────────────────────────────

test('a topic sits in a column of at most 760px next to the topic list', () => {
  const rule = body(desktop, '.zr-settings-page > .zr-settings');
  const measure = rule.match(/--zr-settings-measure: (\d+)px;/);
  assert.ok(measure, 'the measure is one custom property');
  const width = Number(measure[1]);
  assert.ok(width >= 680 && width <= 760, `measure ${width}px`);
  assert.match(
    rule,
    /grid-template-columns: \d+px minmax\(0, var\(--zr-settings-measure\)\);/,
    'a fixed topic list, then the bounded column; no 1fr that would stretch it'
  );
});

test('the view wraps topic list, picker and topic in that frame', () => {
  const page = view.indexOf(
    '<div class="zr-settings-page" data-module="settings-nav">'
  );
  const frame = view.indexOf(
    '<div class="zr-settings" data-module="settings-form">'
  );
  const aside = view.indexOf('<aside class="zr-settings__aside">');
  const main = view.indexOf(
    '<div class="zr-col zr-col--loose zr-settings__main">'
  );
  assert.ok(page !== -1 && page < frame && frame < aside && aside < main);
  // The aside is no longer desktop-only: on a phone it holds the search field.
  assert.ok(!view.includes('<aside class="zr-only-desktop">'));
});

// ── 2. The phone ────────────────────────────────────────────────────────────

test('on a phone the page is one column and the side scrolls with it', () => {
  assert.match(
    body(phone, '.zr-settings, .zr-settings-page > .zr-settings'),
    /grid-template-columns: minmax\(0, 1fr\);/
  );
  assert.match(body(phone, '.zr-settings-side'), /position: static;/);
});

test('on a phone the topic list shows only what a search found', () => {
  assert.match(
    body(phone, '.zr-settings-page:not([data-searching]) .zr-settings-nav'),
    /display: none;/
  );
  // .zr-sectionnav turns into a horizontal strip on a phone; this list stays a
  // list and wraps its long names.
  assert.match(body(desktop, '.zr-settings-nav'), /flex-direction: column;/);
  assert.match(body(phone, '.zr-settings-nav'), /overflow: visible;/);
  assert.match(body(phone, '.zr-settings-nav a'), /white-space: normal;/);
});

// ── 3. Sticky side ──────────────────────────────────────────────────────────

test('search field and topic list stick together, the list scrolls inside', () => {
  const side = body(desktop, '.zr-settings-side');
  assert.match(side, /position: sticky;/);
  assert.match(side, /max-height: calc\(100dvh/);
  const nav = body(desktop, '.zr-settings-nav');
  assert.match(
    nav,
    /position: static;/,
    'not a sticky list inside a sticky side'
  );
  assert.match(nav, /min-height: 0;/, 'may shrink, so it scrolls');
});

// ── 4. Rows ─────────────────────────────────────────────────────────────────

test('a row of a card has the same air above and below', () => {
  assert.match(
    body(desktop, '.zr-settings .zr-module > .zr-module__body.zr-col--loose'),
    /gap: 0; padding-block: 0;/
  );
  assert.match(
    body(
      desktop,
      '.zr-settings .zr-module > .zr-module__body.zr-col--loose > *:not(.zr-alert, .zr-btn)'
    ),
    /margin-inline: calc\(var\(--zr-3\) \* -1\); padding: var\(--zr-3\);/
  );
  assert.match(
    body(desktop, '#customFieldsList:not(:has(*))'),
    /display: none;/
  );
});

test('a block of rows is ruled off inside, edge to edge', () => {
  const group =
    '.zr-settings-page .zr-module > .zr-module__body.zr-col--loose :is(.zr-col--loose, .zr-field--stacked:has(> .zr-field--stacked))';
  assert.match(body(desktop, group), /gap: 0; margin-inline: 0; padding: 0;/);
  assert.match(
    body(desktop, `${group} > :not(.hidden) ~ :not(.zr-alert, .zr-btn)`),
    /border-top: 1px solid var\(--zr-line\);/
  );
});

// ── 5. The styleguide ───────────────────────────────────────────────────────

test('the styleguide keeps its own frame and shows the settings rows', () => {
  assert.match(
    body(desktop, '.zr-settings'),
    /grid-template-columns: 220px minmax\(0, 1fr\);/
  );
  assert.ok(
    !styleguide.includes('zr-settings-page'),
    'not bounded like a topic'
  );
  assert.ok(styleguide.includes('id="sg-settings"'));
  assert.ok(styleguide.includes('class="zr-settings-nav__featured"'));
  assert.ok(styleguide.includes('class="zr-settings-find"'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
