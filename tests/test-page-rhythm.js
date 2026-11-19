/**
 * Test: one page rhythm on every page
 *
 * Every page of the app is made of white cards (.zr-module and its kin) on
 * the grey page. They used to sit at whatever distance the page happened to
 * give them: Manual's "Select document" card touched the cards under it, the
 * dashboard's cards stood 12px apart and its alert 16px above the figures,
 * the OCR queue's lead line sat 4px higher than History's, the settings page
 * started 28px down and up to 96px in from the rail. These are the rules that
 * keep it one rhythm, read from the stylesheets and the views the way
 * tests/test-settings-layout.js reads them; the settings page itself is
 * covered there.
 *
 * Covers:
 * 1. Two custom properties, in the tokens only: the page padding and the gap
 *    between cards (both 16px, 12px on a phone)
 * 2. The framework draws every gap between cards from the card gap: a column
 *    of cards (.zr-stack), the grid, the figures, two cards side by side, two
 *    modules stacked by hand
 * 3. No page stylesheet sets a distance of its own between cards
 * 4. Every page puts its content in one column of cards, and no view spaces a
 *    card by hand
 * 5. Manual: the first card is a sibling of the cards below it, not glued on
 * 6. The same start: the view and the settings page take the page padding,
 *    a lead line sits on it, the settings save bar lines up with the block
 * 7. The styleguide shows the column
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
/** A stylesheet without its comments, on one line. */
const sheet = (...parts) =>
  flat(read(...parts).replace(/\/\*[\s\S]*?\*\//g, ''));

const tokens = sheet('public', 'css', 'tokens.css');
const shell = sheet('public', 'css', 'shell.css');
const modules = sheet('public', 'css', 'modules.css');
const shared = sheet('public', 'css', 'pages', 'shared.css');
const pagesDir = path.join(root, 'public', 'css', 'pages');
const pageSheets = fs
  .readdirSync(pagesDir)
  .filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, css: sheet('public', 'css', 'pages', name) }));
const cssDir = path.join(root, 'public', 'css');
const frameworkSheets = fs
  .readdirSync(cssDir)
  .filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, css: sheet('public', 'css', name) }));

/** Every rule of a flattened sheet: its selector list and its declarations. */
function rules(css) {
  const out = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    const selector = match[1].trim();
    if (selector.startsWith('@')) continue;
    out.push({ selector, body: match[2] });
  }
  return out;
}

/** The declarations of the rules whose whole selector list is `selector`. */
function body(css, selector) {
  const found = rules(css)
    .filter((rule) => rule.selector === flat(selector))
    .map((rule) => rule.body);
  assert.ok(found.length > 0, `no rule for ${selector}`);
  return found.join(' ');
}

/** The part of a sheet inside its phone query. */
const phoneOf = (css) => css.slice(css.indexOf('@media (max-width: 860px) {'));

/** Splits `text` on `separator` where it stands outside parentheses. */
function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && separator.test(c)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * The classes (and the dashboard's data-module) of the element a selector
 * styles: its last compound, without what stands inside :not(), :has(), :is().
 */
function subject(selector) {
  const last = splitTop(selector, /[\s>+~]/).pop() || '';
  const plain = last.replace(/\((?:[^()]|\([^()]*\))*\)/g, '');
  const names = plain.match(/\.[\w-]+|\[data-module='[\w-]+'\]/g) || [];
  return names;
}

/** The selectors of a rule, split on the commas between them. */
const selectorsOf = (selector) => splitTop(selector, /,/);

/** Gap and vertical margin declarations of a rule body. */
function spacing(decls) {
  return splitTop(decls, /;/)
    .map((decl) => decl.trim())
    .filter((decl) =>
      /^(gap|row-gap|column-gap|margin|margin-top|margin-bottom|margin-block):/.test(
        decl
      )
    )
    .filter((decl) => decl !== 'margin: 0 auto');
}

// What holds cards on some page, and what is a card (or stands between two:
// a lead line, a toolbar). A holder's gap is the distance between its cards;
// a card's own gap is the room inside it, so only its margins count. A
// settings topic is one card (.zr-settings-entry): its sections are blocks
// inside it, not cards, and a page sheet may space them as it likes.
const HOLDERS = [
  '.zr-stack',
  '.zr-grid',
  '.zr-stats',
  '.card-grid',
  '.zr-settings',
  '.tidy-page',
  '.tidy-results',
  '.tidy-list',
  '.tidy-notices',
  '.about-page',
  "[data-module='dashboard']",
  '.zr-settings__main',
];
const CARDS = [
  '.zr-module',
  '.zr-alert',
  '.zr-stat',
  '.zr-viewhead',
  '.zr-btnbar',
  '.zr-layoutbar',
  '.zr-editbar',
  '.tidy-card',
  '.tidy-line',
  '.tidy-notice',
  '.zr-settings-entry',
];

/**
 * A holder taking back the framework's stacking margin from the cards it
 * holds: its own gap is the distance already. `.zr-grid > .zr-module`, never
 * a margin of a page's own between two cards.
 */
function isUndo(selector, decl) {
  if (decl !== 'margin-top: 0') return false;
  const match = selector.match(/^(\S+) > \.zr-(module|alert)$/);
  return Boolean(match) && HOLDERS.includes(match[1]);
}

/** Every spacing declaration of `sheets` that is not the card gap. */
function ownDistances(sheets) {
  const offenders = [];
  sheets.forEach(({ name, css }) => {
    rules(css).forEach(({ selector, body: decls }) => {
      selectorsOf(selector).forEach((one) => {
        const names = subject(one);
        const holder = names.some((n) => HOLDERS.includes(n));
        const card = holder || names.some((n) => CARDS.includes(n));
        if (!card) return;
        spacing(decls)
          .filter((decl) => holder || /^margin/.test(decl))
          .filter((decl) => !/var\(--zr-card-gap\)/.test(decl))
          .filter((decl) => !isUndo(one, decl))
          .forEach((decl) => offenders.push(`${name}: ${one} { ${decl} }`));
      });
    });
  });
  return offenders;
}

/**
 * The element tree of a view, enough to ask who is whose parent: EJS tags and
 * HTML comments are dropped, void elements close themselves.
 */
function tree(source) {
  const html = source
    .replace(/<%[\s\S]*?%>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const VOID = new Set([
    'input',
    'img',
    'br',
    'hr',
    'meta',
    'link',
    'use',
    'source',
    'path',
  ]);
  const top = { tag: '#root', cls: [], attrs: '', children: [] };
  const stack = [top];
  const pattern = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const [, close, name, attrs, selfClose] = match;
    const tag = name.toLowerCase();
    if (close) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const cls = ((attrs.match(/\sclass="([^"]*)"/) || [])[1] || '')
      .split(/\s+/)
      .filter(Boolean);
    const node = { tag, cls, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !VOID.has(tag)) stack.push(node);
  }
  return top;
}

/** Depth-first: the first element `match` accepts. */
function find(node, match) {
  for (const child of node.children) {
    if (match(child)) return child;
    const deeper = find(child, match);
    if (deeper) return deeper;
  }
  return null;
}

/** The element a page puts its content in: the first one under <html> that
 *  is not a script, a style or a dialog. */
function pageRoot(view) {
  const html = find(
    tree(read('views', `${view}.ejs`)),
    (n) => n.tag === 'html'
  );
  assert.ok(html, `${view}: no <html>`);
  const first = html.children.find(
    (n) => !['script', 'style', 'dialog', 'head', 'body'].includes(n.tag)
  );
  assert.ok(first, `${view}: no page element`);
  return first;
}

const PAGES = [
  'dashboard',
  'manual',
  'history',
  'tidy-up',
  'ocr',
  'failed',
  'ignored',
  'about',
];

// ── 1. Two custom properties ─────────────────────────────────────────────────

test('the card gap and the page padding are custom properties of the tokens', () => {
  const desktop = tokens.slice(0, tokens.indexOf('@media'));
  assert.match(desktop, /--zr-card-gap: var\(--zr-4\);/, 'cards 16px apart');
  assert.match(desktop, /--zr-page-pad: var\(--zr-4\);/, 'pages 16px in');
  const phone = phoneOf(tokens);
  assert.match(phone, /--zr-card-gap: var\(--zr-3\);/, '12px on a phone');
  assert.match(phone, /--zr-page-pad: var\(--zr-3\);/, '12px on a phone');
  [...frameworkSheets, ...pageSheets]
    .filter((s) => s.name !== 'tokens.css')
    .forEach((s) => {
      assert.doesNotMatch(
        s.css,
        /--zr-(card-gap|page-pad):/,
        `${s.name} defines a rhythm of its own`
      );
    });
});

// ── 2. The framework draws every gap from it ────────────────────────────────

test('a column of cards, the grid, the figures and two cards side by side keep the card gap', () => {
  const stack = body(modules, '.zr-stack');
  assert.match(stack, /display: flex;/);
  assert.match(stack, /flex-direction: column;/);
  assert.match(stack, /gap: var\(--zr-card-gap\);/);
  assert.match(body(modules, '.zr-grid'), /gap: var\(--zr-card-gap\);/);
  assert.match(body(modules, '.zr-stats'), /gap: var\(--zr-card-gap\);/);
  assert.match(body(shared, '.card-grid'), /gap: var\(--zr-card-gap\);/);
  // Two modules stacked by hand in a plain wrapper.
  assert.match(
    body(
      modules,
      '.zr-module + .zr-module, .zr-module + .zr-alert, .zr-alert + .zr-module'
    ),
    /margin-top: var\(--zr-card-gap\);/
  );
  // …which a column and a grid take back: their gap is the distance already.
  assert.match(
    body(
      modules,
      '.zr-grid > .zr-module, .zr-grid > .zr-alert, .zr-stack > .zr-module, .zr-stack > .zr-alert'
    ),
    /margin-top: 0;/
  );
  // The phone keeps the same property; nothing narrows the figures by hand.
  assert.doesNotMatch(phoneOf(modules), /\.zr-stats \{[^}]*gap:/);
  // A dashboard tile is whole rows plus the gaps between them.
  assert.match(
    body(
      sheet('public', 'css', 'pages', 'dashboard.css'),
      '.zr-module[data-rows]'
    ),
    /\(var\(--zr-rows\) - 1\) \* var\(--zr-card-gap\)/
  );
});

test('every gap and margin between cards in the framework is the card gap', () => {
  const offenders = ownDistances(
    frameworkSheets.filter((s) =>
      ['modules.css', 'feedback.css', 'shell.css', 'tables.css'].includes(
        s.name
      )
    )
  );
  assert.deepStrictEqual(offenders, []);
});

test('a grid of two columns takes back the stacking margin like the grid', () => {
  // Without it the second card of a row on About stood 16px below the first.
  assert.match(
    body(shared, '.card-grid > .zr-module, .card-grid > .zr-alert'),
    /margin-top: 0;/
  );
});

// ── 3. No page stylesheet has a number of its own ───────────────────────────

test('no page stylesheet sets a distance of its own between cards', () => {
  assert.deepStrictEqual(ownDistances(pageSheets), []);
  // The undo of the framework's stacking margin was the old way to space a
  // page; a page that needs it is not in a column.
  pageSheets.forEach(({ name, css }) => {
    assert.ok(
      !/\.zr-module \+ \.zr-(module|alert)/.test(css),
      `${name} spaces modules by hand`
    );
  });
});

// ── 4. Every page is one column of cards ────────────────────────────────────

test('every page puts its content in a column of cards', () => {
  PAGES.forEach((view) => {
    const page = pageRoot(view);
    assert.ok(
      page.cls.includes('zr-stack'),
      `${view}: <${page.tag} class="${page.cls.join(' ')}"> is not a .zr-stack`
    );
  });
});

test('no view spaces a card or a lead line by hand', () => {
  [...PAGES, 'settings'].forEach((view) => {
    const source = read('views', `${view}.ejs`);
    assert.doesNotMatch(
      source,
      /class="[^"]*\b(zr-module|zr-alert|zr-viewhead|zr-viewhead__sub|zr-btnbar|zr-stats|card-grid)\b[^"]*"[^>]*style="[^"]*margin/,
      `${view}: a margin written on a card`
    );
    assert.doesNotMatch(
      source,
      /style="[^"]*margin[^"]*"[^>]*class="[^"]*\b(zr-module|zr-alert|zr-viewhead__sub|zr-btnbar)\b/,
      `${view}: a margin written on a card`
    );
  });
});

// ── 5. Manual ────────────────────────────────────────────────────────────────

test('Manual: the first card and the cards below it are siblings in one column', () => {
  const page = pageRoot('manual');
  assert.ok(page.attrs.includes('id="manualPage"'));
  const kids = page.children.filter((n) => n.tag !== 'script');
  assert.ok(kids[0].cls.includes('zr-module'), 'the search card first');
  assert.ok(kids[1].cls.includes('card-grid'), 'then the grid of the others');
  assert.ok(page.cls.includes('zr-stack'), 'with the card gap between them');
  // The right column of the grid stacks Actions over Metadata the same way.
  const right = kids[1].children[1];
  assert.ok(right.cls.includes('zr-stack'), 'Actions and Metadata in a column');
  assert.strictEqual(
    right.children.filter((n) => n.cls.includes('zr-module')).length,
    2
  );
});

// ── 6. The same start ────────────────────────────────────────────────────────

test('a page starts at the page padding under the top bar', () => {
  assert.match(body(shell, '.zr-view'), /padding: var\(--zr-page-pad\);/);
  // The phone narrows the padding through the token, not with a number.
  assert.doesNotMatch(
    phoneOf(shell),
    /\.zr-view \{[^}]*padding: var\(--zr-3\)/
  );
  assert.match(body(shell, '.zr-topbar'), /padding: 0 var\(--zr-page-pad\);/);
});

test('a lead line sits on the page padding; only a title pulls it up', () => {
  const sub = body(modules, '.zr-viewhead__sub');
  assert.doesNotMatch(sub, /margin-top: -/, 'no pull without a title');
  assert.match(
    body(modules, '.zr-viewhead__title ~ .zr-viewhead__sub'),
    /margin-top: -4px;/
  );
  assert.doesNotMatch(
    body(modules, '.zr-viewhead'),
    /margin-bottom/,
    'the column puts the card gap under it'
  );
});

test('the settings page starts at the page padding, its save bar with it', () => {
  const settings = sheet('public', 'css', 'pages', 'settings.css');
  assert.doesNotMatch(settings, /--zr-settings-inset|--zr-actionbar-inset/);
  assert.doesNotMatch(modules, /--zr-actionbar-inset/);
  assert.match(
    body(settings, '.zr-settings-page .zr-settings'),
    /padding: var\(--zr-page-pad\) var\(--zr-page-pad\) /
  );
  assert.match(
    body(settings, '.zr-settings-page .zr-settings'),
    /gap: var\(--zr-card-gap\);/
  );
  assert.match(
    body(modules, '.zr-actionbar__inner'),
    /padding: 10px var\(--zr-page-pad\);/
  );
  // The bar's content ends where the topic column ends.
  assert.match(
    body(settings, '.zr-settings-page'),
    /--zr-actionbar-measure: calc\( var\(--zr-page-pad\) \* 2 \+ var\(--zr-settings-list\) \+ var\(--zr-card-gap\) \+ var\(--zr-settings-measure\) \);/
  );
});

// ── 7. The styleguide ────────────────────────────────────────────────────────

test('the styleguide shows the column and puts its own page in one', () => {
  const styleguide = read('views', 'styleguide.ejs');
  assert.ok(styleguide.includes('.zr-stack'), 'named in the layout section');
  assert.match(
    styleguide,
    /^<div class="zr-stack">\s*<div class="zr-viewhead">/m
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
