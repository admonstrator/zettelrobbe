/**
 * Test: a switch on the settings page is one row with its state as a word
 *
 * views/partials/settings-switch.ejs renders a setting that is on or off: the
 * label and hint on the left, the switch on the right, and a hidden yes/no
 * input that the save reads. On a wide display the switch used to sit at the
 * far edge of the window and every switch drew a grey box of its own; now the
 * row sits in a bounded column, belongs to its card like any other row, shows
 * "On" or "Off" next to the switch and toggles on a click anywhere on it.
 *
 * Covers:
 * 1. The partial's markup contract: the ids, the label, the hidden yes/no
 *    input that carries the name, one control, no role on a div, the hint
 * 2. The state word: forms.css draws "On"/"Off" from the checkbox itself, for
 *    the partial's rows, rows written by hand and the on/off tiles alike, and
 *    keeps it out of the accessibility tree
 * 3. A click anywhere on the row toggles it: the label is stretched over the
 *    row and the switch stays on top
 * 4. The row draws no box of its own and is ruled off like the card's other
 *    rows; the unsaved-change marker reaches switch rows and tiles
 * 5. The rows written by hand in the view keep the shape the CSS relies on
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

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

const partialPath = path.join(root, 'views', 'partials', 'settings-switch.ejs');
const partial = fs.readFileSync(partialPath, 'utf8');
const render = (locals) =>
  ejs.render(partial, locals, { filename: partialPath });

const formsCss = read('public', 'css', 'forms.css');
const settingsCss = read('public', 'css', 'pages', 'settings.css');
const view = read('views', 'settings.ejs');
const formModule = read('public', 'js', 'modules', 'settings-form.js');

/** Whitespace collapsed, so a selector prettier split over lines still matches. */
const flat = (text) => text.replace(/\s+/g, ' ');

/**
 * The bodies of every rule whose selector list is exactly `selector`.
 *
 * @param {string} css
 * @param {string} selector
 * @returns {string[]}
 */
function rulesFor(css, selector) {
  const source = flat(css);
  const head = `${flat(selector)} {`;
  const bodies = [];
  let at = source.indexOf(head);
  while (at !== -1) {
    const before = source.slice(Math.max(0, at - 2), at);
    // Only a whole selector list: preceded by the end of a rule, a comment or
    // the opening of the layer.
    if (at === 0 || /[}{/] ?$/.test(before)) {
      const open = at + head.length;
      bodies.push(source.slice(open, source.indexOf('}', open)));
    }
    at = source.indexOf(head, at + 1);
  }
  return bodies;
}

function ruleFor(css, selector) {
  const bodies = rulesFor(css, selector);
  assert.ok(bodies.length > 0, `no rule for ${selector}`);
  return bodies.join(' ');
}

// ── 1. The partial ────────────────────────────────────────────────────────

test('an "on" switch renders the checkbox, its label and the hidden "yes"', () => {
  const html = render({
    id: 'aiProcessedTag',
    label: 'Add AI-processed tag to documents',
    checked: true,
    hint: 'Tags every document the AI has handled.',
  });
  assert.match(html, /<div class="zr-switchrow">/);
  assert.ok(
    html.includes(
      '<label for="aiProcessedTagSwitch" class="zr-field__name">Add AI-processed tag to documents</label>'
    ),
    'the label names the visible checkbox'
  );
  // Several tests read the state from this exact attribute order.
  assert.ok(
    html.includes(
      '<input type="checkbox" class="zr-toggle" id="aiProcessedTagSwitch" data-switch-target="aiProcessedTag" checked>'
    ),
    'the checkbox is a .zr-toggle, ticked, and points at its hidden input'
  );
  assert.ok(
    html.includes(
      '<input type="hidden" id="aiProcessedTag" name="aiProcessedTag" value="yes">'
    ),
    'the hidden input carries the name and "yes"'
  );
  assert.ok(
    html.includes(
      '<p class="zr-field__hint">Tags every document the AI has handled.</p>'
    ),
    'the hint is a .zr-field__hint paragraph'
  );
});

test('an "off" switch is unticked and submits "no"', () => {
  const html = render({
    id: 'usePromptTags',
    label: 'Use specific tags',
    checked: false,
  });
  assert.ok(
    html.includes('data-switch-target="usePromptTags" >') ||
      html.includes('data-switch-target="usePromptTags">'),
    'no checked attribute'
  );
  assert.ok(!/data-switch-target="usePromptTags" checked/.test(html));
  assert.ok(html.includes('name="usePromptTags" value="no"'));
  assert.ok(!html.includes('zr-field__hint'), 'no hint without one');
});

test('one control per row: only the hidden input has a name, no role anywhere', () => {
  const html = render({ id: 'x', label: 'X', checked: true, hint: 'Y' });
  const named = html.match(/\sname="/g) || [];
  assert.strictEqual(named.length, 1, 'exactly one named input');
  assert.ok(!/\srole="/.test(html), 'no role attribute');
  assert.strictEqual((html.match(/<input /g) || []).length, 2);
  assert.strictEqual((html.match(/<label /g) || []).length, 1);
});

test('the partial carries no state word of its own that could go stale', () => {
  const html = render({ id: 'x', label: 'X', checked: true });
  const text = html.replace(/<[^>]+>/g, ' ');
  assert.ok(!/\b(On|Off)\b/.test(text), 'the word comes from forms.css');
});

test('label and hint escape what they are given', () => {
  const html = render({
    id: 'x',
    label: '<b>A</b>',
    checked: false,
    hint: '"B" & C',
  });
  assert.ok(html.includes('&lt;b&gt;A&lt;/b&gt;'));
  assert.ok(
    html.includes('&#34;B&#34; &amp; C') ||
      html.includes('&quot;B&quot; &amp; C')
  );
});

// ── 2. The state word ─────────────────────────────────────────────────────

test('forms.css says "Off" next to a switch that is off, for rows and tiles', () => {
  const body = ruleFor(
    formsCss,
    '.zr-switchrow::after, .zr-checktile:has(> .zr-toggle)::after'
  );
  assert.match(
    body,
    /content: 'Off' \/ '';/,
    'Off, hidden from assistive tech'
  );
  assert.match(body, /order: 1;/, 'between the text and the switch');
});

test('the word follows the checkbox: "On" while it is checked', () => {
  const body = ruleFor(
    formsCss,
    '.zr-switchrow:has(.zr-toggle:checked)::after, .zr-checktile:has(> .zr-toggle:checked)::after'
  );
  assert.match(body, /content: 'On' \/ '';/);
  assert.match(body, /color: var\(--zr-brand-text\)/);
});

test('a switch set by the environment dims its word with it', () => {
  const body = ruleFor(
    formsCss,
    '.zr-switchrow:has(.zr-toggle:disabled)::after, .zr-checktile:has(> .zr-toggle:disabled)::after'
  );
  assert.match(body, /opacity:/);
});

// ── 3. Click anywhere ─────────────────────────────────────────────────────

test('the label is stretched over the whole row, the switch sits on the right', () => {
  const row = ruleFor(formsCss, '.zr-switchrow');
  assert.match(
    row,
    /position: relative;/,
    'the row anchors the stretched label'
  );
  assert.match(row, /align-items: center;/);
  assert.match(row, /cursor: pointer;/);
  const stretch = ruleFor(formsCss, '.zr-switchrow label::after');
  assert.match(stretch, /position: absolute;/);
  assert.match(stretch, /inset: 0;/);
  assert.match(ruleFor(formsCss, '.zr-switchrow > .zr-toggle'), /order: 2;/);
  // The toggle is positioned and comes after the label, so it paints above
  // the stretched box and takes its own clicks.
  assert.match(ruleFor(formsCss, '.zr-toggle'), /position: relative;/);
});

// ── 4. A row of its card ──────────────────────────────────────────────────

test('a switch row draws no box of its own', () => {
  const row = ruleFor(formsCss, '.zr-switchrow');
  assert.doesNotMatch(row, /border|background|border-radius/);
});

test('the card rules switch rows off like every other row', () => {
  const css = flat(settingsCss);
  assert.ok(
    !/:not\([^)]*\.zr-switchrow/.test(css),
    'no row rule in pages/settings.css exempts switch rows any more'
  );
  const hairline = ruleFor(
    settingsCss,
    '.zr-settings .zr-module > .zr-module__body.zr-col--loose > *:not(.hidden, #customFieldsList:not(:has(*))) ~ *:not(.zr-alert, .zr-btn)'
  );
  assert.match(hairline, /border-top: 1px solid var\(--zr-line\)/);
});

test('the on/off tiles become rows of their card on the settings page', () => {
  const list = ruleFor(
    settingsCss,
    '.zr-settings-page .zr-formgrid:has(> .zr-checktile > .zr-toggle)'
  );
  assert.match(list, /flex-direction: column;/);
  const tile = ruleFor(
    settingsCss,
    '.zr-settings-page .zr-formgrid > .zr-checktile:has(> .zr-toggle)'
  );
  assert.match(tile, /border: 0;/);
  assert.match(tile, /background: transparent;/);
});

test('an unsaved switch marks its own row', () => {
  assert.ok(
    formModule.includes(
      "field.closest('.zr-switchrow, .zr-checktile, .zr-field')"
    ),
    'settings-form.js marks the switch row, not the block around it'
  );
  const marker = ruleFor(
    formsCss,
    '.zr-switchrow[data-dirty]::before, .zr-checktile[data-dirty]::before'
  );
  assert.match(marker, /background: var\(--zr-brand\)/);
});

// ── 5. Rows written by hand ───────────────────────────────────────────────

test('the switch rows written by hand keep the shape the CSS relies on', () => {
  // A label for the checkbox inside the row, the checkbox a direct child.
  const rows = view.split('<div class="zr-switchrow">').slice(1);
  assert.ok(rows.length >= 2, 'the view still writes two rows by hand');
  rows.forEach((row) => {
    const end = row.indexOf('</div>\n', row.indexOf('class="zr-toggle"'));
    const markup = row.slice(0, end);
    const id = (markup.match(/class="zr-toggle" id="([A-Za-z]+)"/) || [])[1];
    assert.ok(id, 'a .zr-toggle with an id');
    assert.ok(
      markup.includes(`<label for="${id}"`),
      `${id} has its label in the row`
    );
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
