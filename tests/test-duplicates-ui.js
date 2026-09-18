/**
 * Test: duplicates-ui
 *
 * Static checks for the Duplicates page — the view, its navigation entry, its
 * stylesheet and its page script. The page itself talks to seven endpoints and
 * is reviewed in a browser; what is checked here is everything that can drift
 * without anyone noticing:
 *
 * 1. views/duplicates.ejs renders through the real shell and carries the ids
 *    and the sensitivity options the page script and the route agree on
 * 2. nav.ejs lists /duplicates on the rail and leaves the phone tab bar alone
 * 3. head-start.ejs links the page stylesheet in the right place
 * 4. public/css/pages/duplicates.css is one @layer pages block of dup- classes
 * 5. public/icons.svg carries the i-merge symbol the page references
 * 6. public/js/duplicates.js escapes everything it writes into innerHTML
 * 7. the page has a label for every match reason and group warning the
 *    matcher can produce
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

const ROOT = process.cwd();
const VIEWS = path.join(ROOT, 'views');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

/* The shell partials read every one of these off res.locals; a missing key
   makes the include throw rather than render an empty string. */
const LOCALS = {
  theme: 'light',
  version: 'v0.0.0-test',
  csrfToken: 'test-csrf',
  appDateFormat: 'DD.MM.YYYY',
  sensitivity: { strict: 0.95, normal: 0.85, loose: 0.75 },
  defaultThreshold: 0.85,
  appVersion: 'v0.0.0-test',
  appCommitSha: 'testsha',
  appPaperlessNgxVersion: '2.14.7',
  appNodeVersion: process.version,
  appPlatform: 'linux',
  appNodeEnv: 'test',
  appAiProvider: 'ollama',
  appOcrEnabled: false,
  appServerTimeUtc: '2026-01-01T00:00:00Z',
  appServerTimezone: 'UTC',
  appPaperlessApiUrl: 'http://paperless:8000/api',
  appOllamaApiUrl: '',
  appOllamaModel: '',
  appCustomBaseUrl: '',
  appCustomModel: '',
  appAzureEndpoint: '',
  appAzureDeploymentName: '',
  appAzureApiVersion: '',
  appMistralOcrModel: '',
  appScanInterval: '*/30 * * * *',
  appTokenLimit: 128000,
  appResponseTokens: 2000,
  appTrustProxy: 'loopback',
  appUseExistingData: 'no',
  appRestrictTags: 'no',
  appRestrictCorrespondents: 'no',
  appRestrictDocumentTypes: 'no',
  appPaperlessTokenSet: true,
  appOpenAiKeySet: false,
  appCustomKeySet: false,
  appAzureKeySet: false,
  appMistralKeySet: false,
  appApiKeySet: false,
};

function renderSync(file, locals) {
  const filename = path.join(VIEWS, file);
  return ejs.render(fs.readFileSync(filename, 'utf8'), locals, {
    filename,
    views: [VIEWS],
  });
}

/* ── 1. the view ──────────────────────────────────────────────────────────── */

let page = '';

test('views/duplicates.ejs renders through the real shell partials', () => {
  page = renderSync('duplicates.ejs', LOCALS);
  assert.ok(page.includes('<!DOCTYPE html>'), 'no document was produced');
  assert.ok(
    page.includes(
      'Find tags and correspondents that mean the same thing and merge them in Paperless-ngx. Nothing here runs on its own.'
    ),
    'the view head sentence is missing'
  );
});

test('The view carries the ids the page script and the route agree on', () => {
  [
    'dupControls',
    'dupScanBtn',
    'dupStats',
    'dupResults',
    'dupLog',
    'dupDismissals',
  ].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
  });
});

test('The page script is loaded as an ES module', () => {
  assert.ok(
    page.includes('<script type="module" src="/js/duplicates.js">'),
    'duplicates.js is not loaded as a module, so its imports would fail'
  );
});

test('The sensitivity select offers the three presets, normal preselected', () => {
  const options = [...page.matchAll(/<option value="([^"]+)"([^>]*)>/g)].map(
    (match) => ({ value: match[1], attrs: match[2] })
  );
  assert.deepStrictEqual(
    options.map((option) => option.value),
    ['0.95', '0.85', '0.75'],
    'the option values no longer match SENSITIVITY in the matcher'
  );
  const preselected = options.filter((option) =>
    option.attrs.includes('selected')
  );
  assert.deepStrictEqual(
    preselected.map((option) => option.value),
    ['0.85'],
    'exactly the default threshold must come up preselected'
  );
});

test('The view falls back to the presets when the route passes no locals', () => {
  // Rendered without `sensitivity` / `defaultThreshold`, as the other views do
  // for their optional locals.
  const bare = Object.assign({}, LOCALS);
  delete bare.sensitivity;
  delete bare.defaultThreshold;
  const output = renderSync('duplicates.ejs', bare);
  assert.ok(output.includes('<option value="0.95">'), 'strict is missing');
  assert.ok(
    output.includes('<option value="0.85" selected>'),
    'normal is missing'
  );
  assert.ok(output.includes('<option value="0.75">'), 'loose is missing');
});

/* ── 2. navigation ────────────────────────────────────────────────────────── */

test('The rail lists Duplicates, the phone tab bar does not', () => {
  const rail = renderSync('partials/nav.ejs', { surface: 'rail' });
  assert.match(rail, /href="\/duplicates"/, '/duplicates is not on the rail');
  assert.match(
    rail,
    /<span class="zr-navitem__label">Duplicates<\/span>/,
    'the rail entry is not labelled "Duplicates"'
  );
  assert.match(
    rail,
    /icons\.svg#i-merge/,
    'the rail entry has no i-merge icon'
  );

  const tabbar = renderSync('partials/nav.ejs', { surface: 'tabbar' });
  assert.ok(
    !tabbar.includes('/duplicates'),
    'the tab bar is full; the entry reaches the phone through the drawer'
  );
});

/* ── 3. the stylesheet link ───────────────────────────────────────────────── */

test('head-start.ejs links duplicates.css directly after queues.css', () => {
  const head = read('views', 'partials', 'shell', 'head-start.ejs');
  const links = [...head.matchAll(/href="\/css\/([^"]+)"/g)].map((m) => m[1]);
  const queues = links.indexOf('pages/queues.css');
  const duplicates = links.indexOf('pages/duplicates.css');
  assert.ok(duplicates !== -1, 'duplicates.css is not linked at all');
  assert.strictEqual(
    duplicates,
    queues + 1,
    'duplicates.css must follow queues.css in the link list'
  );
});

/* ── 4. the stylesheet ────────────────────────────────────────────────────── */

const CSS = read('public', 'css', 'pages', 'duplicates.css');

function selectorsOf(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((selector) => selector && !selector.startsWith('@'))
    .flatMap((selector) => selector.split(','))
    .map((selector) => selector.trim())
    .filter(Boolean);
}

test('duplicates.css is a single @layer pages block', () => {
  const layers = [
    ...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@layer\s+([^;{]+)[;{]/g),
  ].map((m) => m[1].trim());
  assert.deepStrictEqual(
    layers,
    ['pages'],
    'one layer block per file — the duplicate checks in stylelint are scoped to it'
  );
});

test('Every rule in duplicates.css is owned by a dup- class', () => {
  // Framework classes may appear as descendants; what a page file may not do is
  // start a selector with one, because layer pages would then beat the
  // framework everywhere on every page that loads this file.
  const offenders = selectorsOf(CSS).filter(
    (selector) => !selector.startsWith('.dup-')
  );
  assert.deepStrictEqual(
    offenders,
    [],
    `selector(s) not scoped to this page: ${offenders.join(' | ')}`
  );
});

/* ── 5. the icon ──────────────────────────────────────────────────────────── */

test('icons.svg carries the i-merge symbol', () => {
  const icons = read('public', 'icons.svg');
  assert.match(icons, /<symbol id="i-merge" viewBox="0 0 24 24">/);
});

/* ── 6. escaping ──────────────────────────────────────────────────────────── */

const SCRIPT = read('public', 'js', 'duplicates.js');

/**
 * Walks the source and returns every top-level template literal with the text
 * it produces and the expressions it interpolates.
 *
 * Comments and ordinary strings are skipped, and a template literal nested
 * inside an interpolation is treated as opaque text — the page script does not
 * write one, and the assertion below rejects any that appears.
 */
function templateLiterals(source) {
  const found = [];
  const stack = [];
  let current = null;
  let depth = 0;
  let expression = '';
  let i = 0;

  const context = () => stack[stack.length - 1];
  const skipQuoted = (quote) => {
    i += 1;
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source[i] === quote) break;
      i += 1;
    }
    i += 1;
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    const ctx = context();

    if (ctx === 'line') {
      if (ch === '\n') stack.pop();
      i += 1;
    } else if (ctx === 'block') {
      if (ch === '*' && next === '/') {
        stack.pop();
        i += 2;
      } else {
        i += 1;
      }
    } else if (ctx === 'template') {
      if (ch === '\\') {
        i += 2;
      } else if (ch === '`') {
        stack.pop();
        found.push(current);
        current = null;
        i += 1;
      } else if (ch === '$' && next === '{') {
        stack.push('expression');
        depth = 0;
        expression = '';
        i += 2;
      } else {
        current.text += ch;
        i += 1;
      }
    } else if (ctx === 'expression') {
      if (ch === '}' && depth === 0) {
        stack.pop();
        current.expressions.push(expression.trim());
        i += 1;
      } else {
        if (ch === '{') depth += 1;
        if (ch === '}') depth -= 1;
        const start = i;
        if (ch === "'" || ch === '"' || ch === '`') skipQuoted(ch);
        else i += 1;
        expression += source.slice(start, i);
      }
    } else if (ch === '/' && next === '/') {
      stack.push('line');
      i += 2;
    } else if (ch === '/' && next === '*') {
      stack.push('block');
      i += 2;
    } else if (ch === "'" || ch === '"') {
      skipQuoted(ch);
    } else if (ch === '`') {
      current = { text: '', expressions: [] };
      stack.push('template');
      i += 1;
    } else {
      i += 1;
    }
  }
  return found;
}

/* The allow list. An interpolation that lands in markup must be one of these,
   and the page script says the same thing in its header comment:
     esc(...)    escapeHtml, imported from /js/modules/text-utils.js
     num(...)    Number coercion; returns a finite number or 0
     pct(...)    a 0–1 score as whole percent; a finite number
     html…       a helper or local whose name starts with "html" and whose
                 value is markup the file has already escaped */
const SAFE_INTERPOLATIONS = [/^esc\(/, /^num\(/, /^pct\(/, /^html[A-Z]/];

test('Every value interpolated into markup is escaped or a number', () => {
  const markup = templateLiterals(SCRIPT).filter((literal) =>
    /<[a-zA-Z/!]/.test(literal.text)
  );
  assert.ok(
    markup.length >= 10,
    `only ${markup.length} markup templates found — the scanner lost track of the file`
  );

  const offenders = [];
  markup.forEach((literal) => {
    literal.expressions.forEach((expression) => {
      if (expression.includes('`')) {
        // A nested template hides its own interpolations from this check, so
        // it is only allowed inside an escaping call.
        if (!/^esc\(/.test(expression)) offenders.push(expression);
        return;
      }
      if (!SAFE_INTERPOLATIONS.some((rule) => rule.test(expression))) {
        offenders.push(expression);
      }
    });
  });

  assert.deepStrictEqual(
    offenders,
    [],
    `unescaped interpolation(s) in markup: ${offenders.join(' | ')}`
  );
});

test('The markup carries no inline event handlers', () => {
  const offenders = templateLiterals(SCRIPT)
    .map((literal) => literal.text)
    .filter((text) =>
      /\son(click|change|input|submit|error|load)\s*=/.test(text)
    );
  assert.deepStrictEqual(
    offenders,
    [],
    'inline handlers cannot be reviewed by the escaping check above'
  );
});

test('The page script imports the shared escaper rather than rolling its own', () => {
  assert.match(
    SCRIPT,
    /import \{ escapeHtml as esc \} from '\/js\/modules\/text-utils\.js';/,
    'the incomplete hand-written escapers this replaced left quotes intact'
  );
  assert.match(
    SCRIPT,
    /import \{ toast, confirmDialog \} from '\/js\/zr\.js';/,
    'toasts and dialogs come from the kernel, never from a second host'
  );
});

/* ── 7. the page speaks the matcher's whole vocabulary ────────────────────── */

test('Every match reason and group warning has a label on the page', () => {
  const matcher = require('../services/entityNameMatcher');
  // A wire value is a key in the label map; the ones without a hyphen are
  // valid identifiers, so Prettier drops their quotes.
  const hasKey = (value) =>
    new RegExp(`(?:^|[\\s,{])'?${value}'?\\s*:`, 'm').test(SCRIPT);

  Object.values(matcher.MATCH_REASONS).forEach((reason) => {
    assert.ok(
      hasKey(reason),
      `the page has no label for the match reason "${reason}"`
    );
  });
  Object.values(matcher.GROUP_WARNINGS).forEach((warning) => {
    assert.ok(
      hasKey(warning),
      `the page has no text for the group warning "${warning}"`
    );
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
