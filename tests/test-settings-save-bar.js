/**
 * Test: what the save bar of the settings page counts and says
 *
 * public/js/modules/settings-form.js shows the save bar while a setting is
 * not saved: how many settings changed, their labels in page order, and
 * whether saving restarts Zettelrobbe. The counting and the wording are pure
 * functions, run here as shipped; tests/test-settings-save-bar-browser.js
 * measures the bar on the page.
 *
 * Covers:
 * 1. describeChanges: the count and its words, the labels in page order, a
 *    setting counted and named once however many of its fields changed (a
 *    list of pills, a switch and its hidden yes/no), two settings with one
 *    label told apart by their topic, the restart note
 * 2. Cutting a long list is left to CSS: the text holds every label, the
 *    line ends in an ellipsis, the whole list is the title
 * 3. countsAsSetting: Quick start mirrors, tools that are not settings and
 *    hidden twins are left out; the value of a list and the custom fields
 *    are counted
 * 4. keyboardOpen: when the bar steps aside for the on-screen keyboard
 * 5. The page marks what is not a setting and names the custom fields
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { renderSettingsPage } = require('./helpers/render-settings');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

/** A stand-in for a form control, enough for countsAsSetting. */
function control({ type = 'text', id = 'x', scope = null, attrs = [] } = {}) {
  return {
    type,
    id,
    closest: (selector) => (scope && selector.includes(scope) ? {} : null),
    hasAttribute: (name) => attrs.includes(name),
  };
}

(async () => {
  const { describeChanges, countsAsSetting, keyboardOpen } = await import(
    pathToFileURL(
      path.join(root, 'public', 'js', 'modules', 'settings-form.js')
    ).href
  );

  // ── 1. The count and the labels ──────────────────────────────────────────

  await test('without changes the bar says so and names nothing', () => {
    assert.deepStrictEqual(describeChanges([]), {
      count: 0,
      title: 'No unsaved changes',
      labels: [],
      text: '',
      restart: false,
    });
  });

  await test('one change, then several, in page order', () => {
    const one = describeChanges([{ row: 'a', label: 'Custom fields' }]);
    assert.strictEqual(one.title, '1 unsaved change');
    assert.strictEqual(one.text, 'Custom fields');
    const three = describeChanges([
      { row: 'a', label: 'Custom fields' },
      { row: 'b', label: 'Remove the inbox tags' },
      { row: 'c', label: 'Scan schedule (cron)' },
    ]);
    assert.strictEqual(three.count, 3);
    assert.strictEqual(three.title, '3 unsaved changes');
    assert.strictEqual(
      three.text,
      'Custom fields, Remove the inbox tags, Scan schedule (cron)'
    );
  });

  await test('a list of pills and a switch are counted and named once', () => {
    const pills = { label: 'Also remove these tags', row: 'removeTagsRow' };
    const summary = describeChanges([
      // The text field with a tag typed into it and the hidden value.
      { ...pills, restart: false },
      { ...pills, restart: false },
      // A switch: its visible checkbox and its hidden yes/no.
      { row: 'inboxRow', label: 'Remove the inbox tags' },
      { row: 'inboxRow', label: 'Remove the inbox tags' },
    ]);
    assert.strictEqual(summary.count, 2);
    assert.deepStrictEqual(summary.labels, [
      'Also remove these tags',
      'Remove the inbox tags',
    ]);
  });

  await test('two settings with one label are told apart by their topic', () => {
    const summary = describeChanges([
      { row: 'a', label: 'Tags', topic: 'What the AI fills in' },
      { row: 'b', label: 'Tags', topic: 'Schedule and tag filters' },
      { row: 'c', label: 'Title', topic: 'What the AI fills in' },
    ]);
    assert.deepStrictEqual(summary.labels, [
      'Tags (What the AI fills in)',
      'Tags (Schedule and tag filters)',
      'Title',
    ]);
  });

  await test('the restart note follows any setting that restarts', () => {
    assert.strictEqual(
      describeChanges([
        { row: 'a', label: 'Tags' },
        { row: 'b', label: 'Port', restart: true },
      ]).restart,
      true
    );
    assert.strictEqual(
      describeChanges([{ row: 'a', label: 'Tags' }]).restart,
      false
    );
  });

  // ── 2. A long list ───────────────────────────────────────────────────────

  await test('a long list keeps every name; the line is cut in CSS', () => {
    const fields = Array.from({ length: 12 }, (_, i) => ({
      row: i,
      label: `Setting number ${i + 1}`,
    }));
    const summary = describeChanges(fields);
    assert.strictEqual(summary.labels.length, 12);
    assert.ok(summary.text.endsWith('Setting number 12'));
    const css = read('public', 'css', 'modules.css').replace(/\s+/g, ' ');
    assert.match(
      css,
      /\.zr-actionbar__list \{ overflow: hidden; color: var\(--zr-text-muted\); text-overflow: ellipsis; white-space: nowrap; \}/
    );
    const module = read('public', 'js', 'modules', 'settings-form.js');
    assert.match(module, /list\.textContent = summary\.text;/);
    assert.match(
      module,
      /list\.title = summary\.text;/,
      'the whole list on hover'
    );
  });

  // ── 3. What counts ───────────────────────────────────────────────────────

  await test('Quick start mirrors and tools that are not settings are left out', () => {
    const lists = new Set(['removeTags']);
    assert.strictEqual(
      countsAsSetting(control({ scope: '[data-mirror-scope]' }), lists),
      false
    );
    assert.strictEqual(
      countsAsSetting(control({ scope: '[data-not-a-setting]' }), lists),
      false
    );
    assert.strictEqual(
      countsAsSetting(control({ id: 'scanInterval' }), lists),
      true
    );
    assert.strictEqual(
      countsAsSetting(control({ type: 'checkbox' }), lists),
      true
    );
  });

  await test('of the hidden inputs, a list value and a named one count', () => {
    const lists = new Set(['removeTags']);
    assert.strictEqual(
      countsAsSetting(control({ type: 'hidden', id: 'removeTags' }), lists),
      true
    );
    assert.strictEqual(
      countsAsSetting(
        control({
          type: 'hidden',
          id: 'customFieldsJson',
          attrs: ['data-setting-label'],
        }),
        lists
      ),
      true
    );
    // A switch's yes/no: its visible checkbox counts instead.
    assert.strictEqual(
      countsAsSetting(control({ type: 'hidden', id: 'aiProcessedTag' }), lists),
      false
    );
  });

  // ── 4. The on-screen keyboard ────────────────────────────────────────────

  await test('the bar steps aside only while a touch keyboard takes room', () => {
    const state = {
      coarse: true,
      typing: true,
      layoutHeight: 800,
      visualHeight: 420,
    };
    assert.strictEqual(keyboardOpen(state), true);
    assert.strictEqual(
      keyboardOpen({ ...state, visualHeight: 790 }),
      false,
      'no keyboard'
    );
    assert.strictEqual(
      keyboardOpen({ ...state, coarse: false }),
      false,
      'a desktop'
    );
    assert.strictEqual(
      keyboardOpen({ ...state, typing: false }),
      false,
      'a switch has the focus'
    );
    assert.strictEqual(
      keyboardOpen({ ...state, visualHeight: null }),
      true,
      'no Visual Viewport API'
    );
  });

  // ── 5. The page ──────────────────────────────────────────────────────────

  await test('the page marks its tools and names the custom fields', async () => {
    const html = await renderSettingsPage();
    const tools = [...html.matchAll(/<[^>]+data-not-a-setting[^>]*>/g)].length;
    assert.ok(tools >= 3, `only ${tools} tools marked`);
    ['newFieldName', 'settingsQuickstartUrl', 'envFileOutput'].forEach((id) => {
      const at = html.indexOf(`id="${id}"`);
      const open = html.lastIndexOf('data-not-a-setting', at);
      assert.ok(open !== -1 && open < at, `${id} sits in a tool`);
    });
    assert.match(
      html,
      /<input type="hidden" id="customFieldsJson" name="customFields" value='[^']*' data-setting-label="Custom fields">/
    );
    assert.match(
      read('public', 'js', 'settings.js'),
      /json\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);/,
      'adding or removing a custom field is an unsaved change'
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
