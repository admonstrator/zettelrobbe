/**
 * Test: the layout of the settings page
 *
 * The page was rebuilt after it read, on a 2K Windows display, as unbalanced
 * and full of scrollbars: a topic list with a scrollbar of its own, list and
 * topic left-aligned with a quarter of the window empty, inputs ending 180px
 * before the switches, bare switch rows, a save bar floating over the end of
 * the page, five text styles in the topic list. These are the rules that can
 * be read from the stylesheets and the markup; tests/test-settings-save-bar.js
 * covers what the save bar says, tests/test-settings-save-bar-browser.js
 * measures the page in a browser.
 *
 * Covers:
 * 1. One block, next to the rail: topic list and topic in a grid that keeps its width
 *    and leaves the air on the right
 * 2. The frame: the window does not scroll; a region under the top bar does,
 *    over the save bar, which is a row of the layout and hidden without
 *    changes; its Save button belongs to the form from outside it
 * 3. The phone: one column, the topic list only while searching, the frame
 *    ends on the tab bar
 * 4. No scrollbar of its own in the topic list: nothing sticky, no height
 *    cap, no overflow; groups that fold, each heading a real button
 * 5. Which groups are open (openGroups) and the scroll keys on a page where
 *    nothing has the focus (scrollStep), from the shipped module
 * 6. One right edge per card: no control capped inside a settings card, the
 *    row form decided by the type of the control, the rule in the comment
 * 7. Sections: the title and one line above the card, no header bar inside;
 *    every topic says in one sentence what it is for
 * 8. The rows of a card: the same air above and below, blocks ruled off
 * 9. The styleguide shows the row forms, the topic list and the save bar
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
const flat = (text) => text.replace(/\s+/g, ' ');

const css = flat(read('public', 'css', 'pages', 'settings.css'));
const modulesCss = flat(read('public', 'css', 'modules.css'));
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

(async () => {
  const html = await renderSettingsPage();

  // ── 1. One block, next to the rail ────────────────────────────────────────────────

  await test('topic list and topic are one block next to the rail, the topic at most 760px', () => {
    const vars = body(desktop, '.zr-settings-page');
    const measure = vars.match(/--zr-settings-measure: (\d+)px;/);
    assert.ok(measure, 'the measure is one custom property');
    const width = Number(measure[1]);
    assert.ok(width >= 680 && width <= 760, `measure ${width}px`);
    assert.match(vars, /--zr-settings-list: \d+px;/);
    // The bar lines its content up with the same block.
    assert.match(vars, /--zr-actionbar-measure: calc\(/);
    const grid = body(desktop, '.zr-settings-page .zr-settings');
    assert.match(
      grid,
      /grid-template-columns: var\(--zr-settings-list\) minmax\( 0, var\(--zr-settings-measure\) \);/,
      'a fixed list, then the bounded column; no 1fr that would stretch it'
    );
    assert.match(
      grid,
      /justify-content: start;/,
      'the block starts at the rail'
    );
    const inset = vars.match(
      /--zr-settings-inset: clamp\(var\(--zr-settings-pad\), \d+vw, (\d+)px\);/
    );
    assert.ok(
      inset,
      'the distance to the rail is one custom property with an upper bound'
    );
    assert.ok(
      Number(inset[1]) <= 120,
      `at most 120px between rail and topic list, got ${inset[1]}px`
    );
    assert.match(grid, /padding: [^;]*var\(--zr-settings-inset\);/);
    assert.match(
      vars,
      /--zr-actionbar-inset: var\(--zr-settings-inset\);/,
      'the save bar starts with the block'
    );
    assert.ok(!/<div class="zr-settings-columns|third column/i.test(view));
  });

  // ── 2. The frame ─────────────────────────────────────────────────────────

  await test('the view nests page, frame, region, block; the bar follows the region', () => {
    const order = [
      '<div class="zr-settings-page" data-module="settings-nav">',
      '<div class="zr-settings-frame" data-module="settings-form">',
      '<div class="zr-settings-scroll" data-el="scroller">',
      '<div class="zr-settings">',
      '<aside class="zr-settings__aside">',
      '<div class="zr-col zr-col--loose zr-settings__main">',
      '<form id="setupForm"',
      '</form>',
      '<div class="zr-settings-scroll__reserve" data-el="reserve" aria-hidden="true"></div>',
      '<div class="zr-actionbar" id="settingsSaveRow"',
    ].map((marker) => {
      const at = view.indexOf(marker);
      assert.notStrictEqual(at, -1, `missing ${marker}`);
      return at;
    });
    order.reduce((previous, at) => {
      assert.ok(previous < at, 'out of order');
      return at;
    });
  });

  await test('the window does not scroll; the region under the top bar does', () => {
    assert.match(
      body(desktop, '.zr-main:has(> .zr-view > .zr-settings-page)'),
      /height: 100vh; height: 100dvh;/
    );
    const shell = body(desktop, '.zr-view:has(> .zr-settings-page)');
    assert.match(shell, /max-width: none;/, 'the full width right of the rail');
    assert.match(shell, /overflow: hidden;/);
    const region = body(desktop, '.zr-settings-scroll');
    assert.match(region, /overflow-y: auto;/);
    assert.match(region, /position: relative;/, 'clips what is positioned');
    assert.match(region, /scrollbar-gutter: stable;/);
    assert.match(region, /scroll-padding-block: var\(--zr-6\);/);
  });

  await test('the bar is a row of the layout and absent without changes', () => {
    const bar = view.slice(
      view.indexOf('<div class="zr-actionbar" id="settingsSaveRow"'),
      view.indexOf(
        '>',
        view.indexOf('<div class="zr-actionbar" id="settingsSaveRow"')
      )
    );
    assert.match(bar, /role="region" aria-label="Unsaved changes" hidden$/);
    const rule = body(modulesCss, '.zr-actionbar');
    assert.match(rule, /flex: none;/);
    assert.doesNotMatch(
      rule,
      /position|display|bottom|z-index|box-shadow|backdrop-filter/,
      'not floating, and no display that would beat the hidden attribute'
    );
    // Rendered, the bar comes after the form and is hidden.
    const rendered = html.slice(html.indexOf('id="settingsSaveRow"') - 40);
    assert.ok(html.indexOf('</form>') < html.indexOf('id="settingsSaveRow"'));
    assert.match(rendered, /aria-label="Unsaved changes" hidden>/);
    assert.match(
      rendered,
      /<button type="submit" class="zr-btn zr-btn--primary" data-el="save" form="setupForm">/,
      'Save belongs to the form from outside it'
    );
    assert.match(
      read('public', 'js', 'settings.js'),
      /document\.querySelector\('button\[type="submit"\]\[form="setupForm"\]'\)/,
      'the submit handler finds the button outside the form'
    );
  });

  // ── 3. The phone ─────────────────────────────────────────────────────────

  await test('on a phone the page is one column and ends on the tab bar', () => {
    assert.match(
      body(phone, '.zr-settings-page .zr-settings'),
      /grid-template-columns: minmax\(0, 1fr\);/
    );
    assert.match(
      body(phone, '.zr-view:has(> .zr-settings-page)'),
      /padding-bottom: var\(--zr-tabbar-h\);/
    );
    assert.match(
      body(phone, '.zr-settings-page:not([data-searching]) .zr-settings-nav'),
      /display: none;/
    );
    assert.match(body(phone, '.zr-settings-nav a'), /white-space: normal;/);
    // The picker stays.
    assert.ok(
      view.includes(
        '<select id="settingsEntrySelect" class="zr-input" data-el="select">'
      )
    );
  });

  // ── 4. The topic list ────────────────────────────────────────────────────

  await test('the topic list has no scrollbar of its own', () => {
    const side = body(desktop, '.zr-settings-side');
    assert.doesNotMatch(side, /sticky|max-height|overflow/);
    const nav = body(desktop, '.zr-settings-nav');
    assert.match(nav, /position: static;/, '.zr-sectionnav is sticky');
    assert.match(nav, /max-height: none;/);
    assert.match(nav, /overflow: visible;/);
    assert.match(nav, /flex-direction: column;/);
  });

  await test('every group heading is a button that folds its topics', () => {
    const nav = html.slice(
      html.indexOf('<nav class="zr-sectionnav zr-settings-nav"'),
      html.indexOf(
        '</nav>',
        html.indexOf('<nav class="zr-sectionnav zr-settings-nav"')
      )
    );
    const buttons = [
      ...nav.matchAll(
        /<button type="button" class="zr-settings-nav__toggle" id="settingsNavToggle-([a-z]+)" aria-expanded="false" aria-controls="settingsNavItems-\1" data-nav-toggle="\1">/g
      ),
    ].map((m) => m[1]);
    assert.deepStrictEqual(buttons, [
      'basics',
      'analysis',
      'processing',
      'tags',
      'security',
      'system',
    ]);
    buttons.forEach((key) => {
      assert.match(
        nav,
        new RegExp(
          `<div class="zr-settings-nav__items" id="settingsNavItems-${key}" role="group" aria-labelledby="settingsNavToggle-${key}" hidden>`
        )
      );
      assert.match(nav, new RegExp(`data-group-dirty="${key}"`), 'a dot');
      assert.match(nav, new RegExp(`data-group-count="${key}"`), 'a count');
    });
    assert.match(
      nav,
      /<span class="zr-settings-nav__size">7<span class="zr-sr"> topics<\/span>/
    );
    // Two kinds of line: no upper-case labels with icons, no caption.
    assert.ok(!nav.includes('zr-settings-nav__label'));
    assert.ok(!nav.includes('All options'));
    // A closed group keeps the marks of its topics on its heading.
    assert.match(
      body(
        desktop,
        ".zr-settings-nav__toggle[aria-expanded='true'] :is(.zr-settings-nav__dirty, .zr-settings-nav__count)"
      ),
      /display: none;/
    );
  });

  // ── 5. The module ────────────────────────────────────────────────────────

  const nav = await import(
    pathToFileURL(path.join(root, 'public', 'js', 'modules', 'settings-nav.js'))
      .href
  );
  const groups = [
    'basics',
    'analysis',
    'processing',
    'tags',
    'security',
    'system',
  ];
  const open = (state) => [
    ...nav.openGroups({
      groups,
      opened: new Set(),
      closedCurrent: false,
      current: null,
      ...state,
    }),
  ];

  await test('the group of the open topic is open, the others closed', () => {
    assert.deepStrictEqual(open({ current: 'analysis' }), ['analysis']);
    assert.deepStrictEqual(
      open({ current: null }),
      [],
      'Quick start opens none'
    );
  });

  await test('a group a person opened stays open; one they closed stays closed', () => {
    assert.deepStrictEqual(
      open({ current: 'analysis', opened: new Set(['system']) }),
      ['analysis', 'system']
    );
    assert.deepStrictEqual(
      open({ current: 'analysis', closedCurrent: true }),
      []
    );
    assert.strictEqual(nav.GROUPS_KEY, 'zr.settings.groups');
    assert.match(
      read('public', 'js', 'modules', 'settings-nav.js'),
      /window\.sessionStorage/,
      'remembered for the browser session'
    );
  });

  await test('a search opens the groups with a match, unless closed by hand', () => {
    assert.deepStrictEqual(
      open({ current: 'basics', matched: new Set(['analysis', 'system']) }),
      ['analysis', 'system']
    );
    assert.deepStrictEqual(
      open({
        matched: new Set(['analysis', 'system']),
        closedInSearch: new Set(['system']),
      }),
      ['analysis']
    );
  });

  await test('the scroll keys move the region while nothing has the focus', () => {
    assert.strictEqual(nav.scrollStep({ key: 'PageDown' }, 800), 700);
    assert.strictEqual(nav.scrollStep({ key: 'PageUp' }, 800), -700);
    assert.strictEqual(nav.scrollStep({ key: ' ' }, 800), 700);
    assert.strictEqual(nav.scrollStep({ key: ' ', shiftKey: true }, 800), -700);
    assert.strictEqual(nav.scrollStep({ key: 'ArrowDown' }, 800), 40);
    assert.strictEqual(nav.scrollStep({ key: 'End' }, 800), 'end');
    assert.strictEqual(nav.scrollStep({ key: 'Home' }, 800), 'start');
    assert.strictEqual(nav.scrollStep({ key: 'a' }, 800), null);
  });

  // ── 6. One right edge ────────────────────────────────────────────────────

  await test('no control in a settings card carries a width cap of its own', () => {
    assert.match(
      body(
        desktop,
        '.zr-settings-card :is(.zr-input, .zr-select, .zr-textarea, .zr-inputgroup), .zr-settings-card .zr-field__hint'
      ),
      /max-width: none;/
    );
    // forms.css caps them at 460px and 560px; the card rule is the later layer.
    assert.match(read('public', 'css', 'forms.css'), /max-width: 560px;/);
  });

  await test('the row form is decided by the type of the control', () => {
    const beside = body(
      desktop,
      ".zr-settings-card .zr-field--stacked:has( > :is( select.zr-input, input.zr-input:is( [type='number'], [type='text']:not([inputmode='url'], .hidden) ) ) ):not(:has(> :is(.zr-inputgroup, .zr-textarea, .zr-chips)))"
    );
    assert.match(
      beside,
      /grid-template-columns: minmax\(0, 1fr\) var\(--zr-settings-control\);/
    );
    assert.match(
      css,
      /Row forms\. A row takes one of two forms, decided by the type of its control and never by the field/
    );
    // Addresses carry inputmode="url", so they go under their label.
    [
      'paperlessUrl',
      'paperlessPublicUrl',
      'ollamaUrl',
      'customBaseUrl',
      'azureEndpoint',
      'externalApiUrl',
      'ocrApiUrl',
      'anthropicApiUrl',
      'oidcIssuerUrl',
      'oidcRedirectUri',
      'oidcButtonIcon',
      'settingsQuickstartUrl',
    ].forEach((id) => {
      const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
      assert.ok(tag, `${id} is rendered`);
      assert.match(tag[0], /inputmode="url"/, `${id} is an address`);
    });
    // A field of the settings page never sits beside another one.
    const form = html.slice(
      html.indexOf('<form id="setupForm"'),
      html.indexOf('</form>')
    );
    assert.ok(!form.includes('zr-formgrid'), 'no two-column grid of fields');
  });

  // ── 7. Sections and topics ───────────────────────────────────────────────

  await test('a section names itself above its card, with one line', () => {
    const sections = [
      ...html.matchAll(
        /<section class="zr-settings-section" id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g
      ),
    ];
    assert.ok(sections.length >= 25, `only ${sections.length} sections`);
    sections.forEach(([, id, inner]) => {
      assert.match(
        inner,
        /^\s*<div class="zr-settings-section__head">/,
        `${id}: the head first`
      );
      assert.match(
        inner,
        /<h3 class="zr-settings-section__title" id="[^"]+">[^<]+<\/h3>/,
        `${id}: a title`
      );
      assert.match(
        inner,
        /<p class="zr-settings-section__desc">[^<]{12,}/,
        `${id}: one line`
      );
      assert.match(
        inner,
        /<div class="zr-module zr-settings-card">/,
        `${id}: then the card`
      );
      assert.doesNotMatch(
        inner,
        /<div class="zr-module__head">/,
        `${id}: no header bar`
      );
    });
  });

  await test('every topic says in one sentence what it is for', () => {
    const topics = [
      ...html.matchAll(
        /<section class="zr-settings-entry[^"]*" id="entry-([a-z-]+)"[\s\S]*?<\/header>/g
      ),
    ];
    assert.ok(topics.length >= 20);
    topics.forEach(([head, id]) => {
      assert.match(
        head,
        /<p class="zr-settings-entry__lead">[A-Z][^<]{20,}\.<\/p>/,
        `${id}: a lead`
      );
      if (id !== 'quick-start') {
        assert.match(
          head,
          /<p class="zr-settings-entry__group">[^<]+<\/p>/,
          `${id}: its group`
        );
      }
    });
  });

  // ── 8. Rows ──────────────────────────────────────────────────────────────

  await test('a row of a card has the same air above and below', () => {
    assert.match(
      body(desktop, '.zr-settings-card > .zr-module__body.zr-col--loose'),
      /gap: 0; padding: 0 var\(--zr-row-x\);/
    );
    assert.match(
      body(
        desktop,
        '.zr-settings-card > .zr-module__body.zr-col--loose > *:not(.zr-alert, .zr-btn)'
      ),
      /margin-inline: calc\(var\(--zr-row-x\) \* -1\); padding: var\(--zr-row-y\) var\(--zr-row-x\);/
    );
    assert.match(
      body(desktop, '#customFieldsList:not(:has(*))'),
      /display: none;/
    );
  });

  await test('a block of rows is ruled off inside, edge to edge', () => {
    const group =
      '.zr-settings-card > .zr-module__body.zr-col--loose :is(.zr-col--loose, .zr-field--stacked:has(> .zr-field--stacked))';
    assert.match(body(desktop, group), /gap: 0; margin-inline: 0; padding: 0;/);
    assert.match(
      body(desktop, `${group} > :not(.hidden) ~ :not(.zr-alert, .zr-btn)`),
      /border-top: 1px solid var\(--zr-line\);/
    );
  });

  // ── 9. The styleguide ────────────────────────────────────────────────────

  await test('the styleguide keeps its frame and shows rows, topic list and save bar', () => {
    assert.match(
      body(desktop, '.zr-settings'),
      /grid-template-columns: 220px minmax\(0, 1fr\);/
    );
    assert.ok(
      !styleguide.includes('zr-settings-page'),
      'not laid out like the page'
    );
    assert.ok(styleguide.includes('id="sg-settings"'));
    assert.ok(styleguide.includes('class="zr-settings-section"'));
    assert.ok(styleguide.includes('class="zr-module zr-settings-card"'));
    assert.ok(
      styleguide.includes('inputmode="url"'),
      'a row of the below form'
    );
    assert.ok(styleguide.includes('class="zr-settings-nav__featured"'));
    assert.ok(
      styleguide.includes(
        'class="zr-settings-nav__toggle" aria-expanded="false"'
      )
    );
    assert.ok(styleguide.includes('class="zr-settings-find"'));
    assert.ok(styleguide.includes('<div class="zr-actionbar__inner">'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
