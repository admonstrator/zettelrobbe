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
 * 1. One block at the page padding, like every page: topic list and topic in a
 *    grid that keeps its width and leaves the air on the right, the card gap
 *    between them (tests/test-page-rhythm.js covers the other pages)
 * 2. The frame: the window does not scroll; a region under the top bar does,
 *    over the save bar, which is a row of the layout and hidden without
 *    changes; its Save button belongs to the form from outside it
 * 3. The phone: one column, the topic list only while searching, the frame
 *    ends on the tab bar
 * 4. The topic list is a card with no scrollbar of its own: nothing sticky,
 *    no height cap, no overflow; groups that fold, each heading a real button
 * 5. Which groups are open (openGroups) and the scroll keys on a page where
 *    nothing has the focus (scrollStep), from the shipped module
 * 6. One right edge per card: no control capped inside a topic card, the
 *    row form decided by the type of the control, the rule in the comment
 * 7. A topic is one card like those of every other page: its head names it
 *    (group, title, one sentence on what it is for), its body holds the
 *    sections; no card in it, and no text of the settings column outside a
 *    card. A section is a block of that card: its title, one line under it,
 *    its rows, ruled off from the section before it. A disclosure (Advanced
 *    options, a release of the changelog) is a section that folds; Quick
 *    start's steps are rows of its card
 * 8. The rows of a section: the same air above and below, blocks ruled off
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

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
  'use',
  'path',
]);

/**
 * The element tree of a rendered page with its text, enough to ask what
 * holds what: comments and the content of scripts are dropped, void
 * elements close themselves, a closing tag closes up to its own element.
 *
 * @param {string} html
 */
function parse(html) {
  const root = { tag: '#root', cls: [], children: [], parent: null };
  const source = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
  const pattern =
    /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let node = root;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, close, name, attrs, selfClose, text] = match;
    if (text !== undefined) {
      if (text.trim()) {
        node.children.push({ text: text.trim(), parent: node, children: [] });
      }
      continue;
    }
    const tag = name.toLowerCase();
    if (close) {
      let open = node;
      while (open !== root && open.tag !== tag) open = open.parent;
      if (open !== root) node = open.parent;
      continue;
    }
    const cls = ((attrs.match(/\sclass="([^"]*)"/) || [])[1] || '')
      .split(/\s+/)
      .filter(Boolean);
    const id = (attrs.match(/\sid="([^"]*)"/) || [])[1] || '';
    const element = { tag, cls, id, attrs, children: [], parent: node };
    node.children.push(element);
    if (!selfClose && !VOID.has(tag)) node = element;
  }
  return root;
}

/** Every node under `node`, depth first. */
function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

/** Whether an ancestor of `node` (not `node` itself) carries `cls`. */
function inside(node, cls) {
  for (let up = node.parent; up; up = up.parent) {
    if (up.cls && up.cls.includes(cls)) return true;
  }
  return false;
}

/** The first element under `node` that carries `cls`. */
function first(node, cls) {
  return descendants(node).find((n) => n.cls && n.cls.includes(cls));
}

/** The texts of the settings column that no card holds. */
function textOutsideCards(html) {
  const main = first(parse(html), 'zr-settings__main');
  assert.ok(main, 'the settings column is rendered');
  return descendants(main)
    .filter((n) => n.text !== undefined && !inside(n, 'zr-module'))
    .map((n) => n.text);
}

(async () => {
  const html = await renderSettingsPage();

  // ── 1. One block, next to the rail ────────────────────────────────────────────────

  await test('topic list and topic are one block at the page padding, the topic at most 760px', () => {
    const vars = body(desktop, '.zr-settings-page');
    const measure = vars.match(/--zr-settings-measure: (\d+)px;/);
    assert.ok(measure, 'the measure is one custom property');
    const width = Number(measure[1]);
    assert.ok(width >= 680 && width <= 760, `measure ${width}px`);
    assert.match(vars, /--zr-settings-list: \d+px;/);
    // The bar lines its content up with the same block: it starts at the
    // page padding and ends where the topic column ends.
    assert.match(
      vars,
      /--zr-actionbar-measure: calc\( var\(--zr-page-pad\) \* 2 \+ var\(--zr-settings-list\) \+ var\(--zr-card-gap\) \+ var\(--zr-settings-measure\) \);/
    );
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
    // Where every page starts: the page padding under the top bar and next
    // to the rail, no inset of its own; the list card and the topic stand
    // the card gap apart.
    assert.match(
      grid,
      /padding: var\(--zr-page-pad\) var\(--zr-page-pad\) var\(--zr-10\);/
    );
    assert.match(grid, /gap: var\(--zr-card-gap\);/);
    assert.doesNotMatch(
      css,
      /--zr-settings-(inset|pad|gap)|--zr-actionbar-inset/,
      'no distance of the settings page alone'
    );
    assert.match(
      body(modulesCss, '.zr-actionbar__inner'),
      /padding: 10px var\(--zr-page-pad\);/,
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
      '<div class="zr-module">',
      '<div class="zr-module__body zr-settings-side">',
      '<div class="zr-only-mobile zr-settings-picker">',
      '</aside>',
      '<div class="zr-stack zr-settings__main">',
      '<form id="setupForm" class="zr-stack"',
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
    // The picker stays, in the card of the topic list under the field.
    assert.ok(
      view.includes(
        '<select id="settingsEntrySelect" class="zr-input" data-el="select">'
      )
    );
    const aside = view.slice(
      view.indexOf('<aside class="zr-settings__aside">'),
      view.indexOf('</aside>')
    );
    assert.ok(aside.includes('id="settingsEntrySelect"'), 'picker in the card');
    assert.ok(
      aside.indexOf('id="settingsSearch"') <
        aside.indexOf('id="settingsEntrySelect"'),
      'under the field'
    );
    // The phone starts at the page padding too.
    assert.match(
      body(phone, '.zr-settings-page .zr-settings'),
      /padding: var\(--zr-page-pad\) var\(--zr-page-pad\) var\(--zr-6\);/
    );
  });

  // ── 4. The topic list ────────────────────────────────────────────────────

  await test('the topic list is a card with no scrollbar of its own', () => {
    assert.match(
      html,
      /<aside class="zr-settings__aside">\s*<div class="zr-module">\s*<div class="zr-module__body zr-settings-side">/,
      'field and list in a card, like the cards of every other page'
    );
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

  await test('no control in a topic card carries a width cap of its own', () => {
    assert.match(
      body(
        desktop,
        '.zr-settings-entry :is(.zr-input, .zr-select, .zr-textarea, .zr-inputgroup), .zr-settings-entry .zr-field__hint'
      ),
      /max-width: none;/
    );
    // forms.css caps them at 460px and 560px; the card rule is the later layer.
    assert.match(read('public', 'css', 'forms.css'), /max-width: 560px;/);
  });

  await test('the row form is decided by the type of the control', () => {
    const beside = body(
      desktop,
      ".zr-settings-entry .zr-field--stacked:has( > :is( select.zr-input, input.zr-input:is( [type='number'], [type='text']:not([inputmode='url'], .hidden) ) ) ):not(:has(> :is(.zr-inputgroup, .zr-textarea, .zr-chips)))"
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

  // ── 7. A topic is one card ───────────────────────────────────────────────

  await test('a topic is one card: its head names it, its body holds the sections', () => {
    const topics = [
      ...html.matchAll(
        /<section class="zr-settings-entry([^"]*)" id="entry-([a-z-]+)"[^>]*>\s*<header class="([^"]+)">[\s\S]*?<\/header>\s*<div class="([^"]+)">/g
      ),
    ];
    assert.ok(topics.length >= 20, `only ${topics.length} topics`);
    topics.forEach(([, classes, id, head, bodyClasses]) => {
      assert.match(classes, /^ zr-module( hidden)?$/, `${id}: ${classes}`);
      assert.strictEqual(
        head,
        'zr-module__head zr-settings-entry__head',
        `${id}: the card head`
      );
      assert.strictEqual(
        bodyClasses,
        'zr-module__body zr-module__body--tight zr-settings-entry__body',
        `${id}: the card body`
      );
    });
    assert.strictEqual(
      topics.length,
      (html.match(/<section class="zr-settings-entry/g) || []).length,
      'every topic has head and body'
    );
    // The head is a column at the inset of the rows: group, title, lead.
    const head = body(desktop, '.zr-settings-entry__head');
    assert.match(head, /flex-direction: column;/);
    assert.match(head, /padding: var\(--zr-4\) var\(--zr-row-x\);/);
    const card = body(desktop, '.zr-settings-entry');
    assert.match(card, /--zr-row-x: var\(--zr-4\);/);
    assert.match(card, /--zr-row-y: var\(--zr-3\);/);
    // The title is the main heading of the page: the brand face, larger
    // than a module title (--zr-fs-md) and than a section title.
    const title = body(desktop, '.zr-settings-entry__title');
    assert.match(title, /font-family: var\(--zr-font-brand\);/);
    assert.match(title, /font-size: var\(--zr-fs-xl\);/);
    // The wrappers two topic modules put around their sections are plain:
    // no column with a card gap inside a card.
    assert.ok(html.includes('<div data-module="settings-sso">'));
    assert.ok(html.includes('<div data-module="settings-environment">'));
    const form = html.slice(
      html.indexOf('<form id="setupForm"'),
      html.indexOf('</form>')
    );
    assert.ok(
      !/<(section|div) class="zr-settings-entry[^"]*zr-stack/.test(form),
      'a topic is no column of cards'
    );
  });

  await test('no card inside a topic card', () => {
    const entries = descendants(parse(html)).filter(
      (n) => n.cls && n.cls.includes('zr-settings-entry')
    );
    assert.ok(entries.length >= 20, `only ${entries.length} topics`);
    entries.forEach((entry) => {
      assert.ok(entry.cls.includes('zr-module'), `${entry.id} is a card`);
      const nested = descendants(entry).filter(
        (n) => n.cls && n.cls.includes('zr-module')
      );
      assert.deepStrictEqual(
        nested.map((n) => `${n.tag}#${n.id}.${n.cls.join('.')}`),
        [],
        `${entry.id}: a card in the card`
      );
    });
    assert.ok(!html.includes('zr-settings-card'), 'the old section card');
  });

  await test('no text of the settings column stands outside a card', async () => {
    assert.deepStrictEqual(textOutsideCards(html), []);
    // With every optional part rendered: the releases, the three lists of
    // Set by the environment. A message of the page itself (settingsError)
    // is a box of its own above the card, an alert, not text on the page.
    const full = await renderSettingsPage({
      changelogReleases: require('../config/changelog').releases,
      environmentOverview: {
        count: 3,
        settings: [
          {
            key: 'SCAN_INTERVAL',
            value: '*/15 * * * *',
            secret: false,
            stored: 'none',
            canTakeOver: true,
            anchor: 'scanInterval',
          },
        ],
        unused: [
          {
            key: 'PAPERLESS_USERNAME',
            removedIn: 'v2026.11.04',
            inEnvironment: true,
          },
        ],
        blocked: [
          {
            key: 'OCR_TIMEOUT',
            title: 'OCR timeout',
            text: 'Kept at 30 seconds.',
          },
        ],
      },
      settingsError: 'Please check your settings.',
    });
    assert.ok(full.includes('id="sec-env-blocked"'), 'every list rendered');
    assert.ok(full.includes('class="changelog-release'), 'releases rendered');
    const tree = parse(full);
    const outside = descendants(first(tree, 'zr-settings__main')).filter(
      (n) =>
        n.text !== undefined &&
        !inside(n, 'zr-module') &&
        !inside(n, 'zr-alert')
    );
    assert.deepStrictEqual(
      outside.map((n) => n.text),
      []
    );
    descendants(tree)
      .filter((n) => n.cls && n.cls.includes('zr-settings-entry'))
      .forEach((entry) => {
        assert.ok(
          !descendants(entry).some((n) => n.cls && n.cls.includes('zr-module')),
          `${entry.id}: a card in the card`
        );
      });
  });

  await test('a section is a block of its card: title, one line, its rows', () => {
    const sections = [
      ...html.matchAll(
        /<section class="zr-settings-section" id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g
      ),
    ];
    assert.ok(sections.length >= 25, `only ${sections.length} sections`);
    sections.forEach(([, id, inner]) => {
      assert.match(
        inner,
        /^\s*<div class="zr-settings-section__head">\s*<h3 class="zr-settings-section__title" id="[^"]+">[^<]+<\/h3>/,
        `${id}: its title first`
      );
      assert.match(
        inner,
        /<\/div>\s*<p class="zr-settings-section__desc">[^<]{12,}/,
        `${id}: one line under the title`
      );
      assert.doesNotMatch(
        inner,
        /class="zr-module[ "]/,
        `${id}: no card in the section`
      );
    });
    // Each section after another one is ruled off from card edge to card
    // edge, and its title starts a step lower than a row (--zr-row-y).
    const ruled = body(desktop, '.zr-settings-section ~ .zr-settings-section');
    assert.match(ruled, /border-top: 1px solid var\(--zr-line\);/);
    // Never drawn as a card of its own.
    assert.doesNotMatch(ruled, /background|box-shadow|border-radius/);
    assert.ok(!css.includes('zr-settings-card'));
    assert.match(
      body(desktop, '.zr-settings-section__head'),
      /padding: var\(--zr-5\) var\(--zr-row-x\) 0;/
    );
    assert.match(
      body(desktop, '.zr-settings-section__title'),
      /font-size: var\(--zr-fs-lg\);/
    );
    assert.match(
      body(desktop, '.zr-settings-section__desc'),
      /padding: var\(--zr-1\) var\(--zr-row-x\) 0;/
    );
    // The phone keeps the steps: the title of the topic, of a section, a
    // label, each a size smaller than the one before.
    assert.match(
      body(phone, '.zr-settings-entry__title'),
      /font-size: var\(--zr-fs-lg\);/
    );
    assert.match(
      body(phone, '.zr-settings-section__title'),
      /font-size: var\(--zr-fs-md\);/
    );
  });

  await test('a disclosure is a section that folds, one look for all of them', async () => {
    const folding = [
      ...html.matchAll(
        /<details class="zr-settings-section zr-settings-disclosure" id="([^"]+)"[^>]*>\s*<summary class="zr-settings-section__head zr-settings-disclosure__summary">\s*<h3 class="zr-settings-section__title">([^<]+)<\/h3>/g
      ),
    ].map((m) => `${m[1]}: ${m[2]}`);
    assert.deepStrictEqual(folding, [
      'sec-provider-advanced: Advanced options',
      'sec-tidy-up-advanced: Advanced options',
      'sec-sso-advanced: Advanced',
    ]);
    const summary = body(desktop, '.zr-settings-disclosure__summary');
    assert.match(summary, /padding: var\(--zr-3\) var\(--zr-row-x\);/);
    assert.match(summary, /cursor: pointer;/);
    assert.match(
      body(desktop, '.zr-settings-disclosure__summary:hover'),
      /background: var\(--zr-surface-2\);/
    );
    assert.match(
      body(
        desktop,
        '.zr-settings-disclosure[open] > .zr-settings-disclosure__summary'
      ),
      /border-bottom: 1px solid var\(--zr-line\);/
    );
    assert.doesNotMatch(css, /zr-settings-advanced|zr-sso-advanced/);
    // A release of the changelog folds the same way: a row of its section,
    // ruled off from the next, not a panel with a timeline beside it.
    const page = await renderSettingsPage({
      changelogReleases: require('../config/changelog').releases,
    });
    const releases = [
      ...page.matchAll(
        /<li class="changelog-release[^"]*">\s*<details class="changelog-details zr-settings-disclosure"( open)?>\s*<summary class="changelog-summary zr-settings-disclosure__summary">/g
      ),
    ];
    assert.ok(releases.length >= 2, `only ${releases.length} releases`);
    assert.strictEqual(releases[0][1], ' open', 'the current one is open');
    assert.ok(!page.includes('changelog-dot'));
    const changelogCss = flat(
      read('public', 'css', 'pages', 'settings-changelog.css')
    );
    assert.doesNotMatch(changelogCss, /\.changelog-details \{/);
    assert.doesNotMatch(changelogCss, /changelog-dot|::before/);
    assert.match(
      changelogCss,
      /\.changelog-release \+ \.changelog-release \{ border-top: 1px solid var\(--zr-line\); \}/
    );
    // Quick start: its steps are the rows of the topic card.
    assert.match(
      html,
      /<div class="zr-qs"[^>]*>\s*<div class="zr-qs__list">/,
      'Quick start: its steps in the card'
    );
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

  await test('a row of a section has the same air above and below', () => {
    assert.match(
      body(desktop, '.zr-settings-section__body.zr-col--loose'),
      /gap: 0; padding: 0 var\(--zr-row-x\);/
    );
    assert.match(
      body(
        desktop,
        '.zr-settings-section__body.zr-col--loose > *:not(.zr-alert, .zr-btn)'
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
      '.zr-settings-section__body.zr-col--loose :is(.zr-col--loose, .zr-field--stacked:has(> .zr-field--stacked))';
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
    assert.ok(
      styleguide.includes(
        'class="zr-module zr-settings-card zr-settings-section"'
      ),
      'a section as a card'
    );
    assert.ok(
      styleguide.includes(
        'class="zr-module__title zr-settings-section__title"'
      ),
      'its title in the card head'
    );
    assert.ok(
      styleguide.includes('<div class="zr-module__body zr-settings-side">'),
      'the topic list in a card'
    );
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
