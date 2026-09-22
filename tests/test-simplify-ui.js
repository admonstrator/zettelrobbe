/**
 * Test: simplify-ui
 *
 * Static checks for the Simplify tags page — the view, its navigation entry,
 * its stylesheet and its page script. The page itself talks to seven endpoints
 * and is reviewed in a browser; what is checked here is everything that can
 * drift without anyone noticing:
 *
 *  1. views/simplify.ejs renders through the real shell and carries the ids
 *     the page script and the route agree on
 *  2. nav.ejs lists /simplify right after /duplicates and leaves the phone tab
 *     bar alone; icons.svg carries the i-split symbol it references
 *  3. head-start.ejs links the page stylesheet, and the stylesheet is one
 *     @layer pages block of sim- classes
 *  4. public/js/simplify.js escapes everything it writes into innerHTML and
 *     carries no inline event handler
 *  5. the vocabulary chips: what they render, what removes one, what an empty
 *     vocabulary says instead of two empty lists
 *  5b. the document types Paperless-ngx already has: the picker markup, the
 *     shared module and its stylesheet, the offer to take the types over and
 *     the hint under a typed topic
 *  6. the proposal row: the select of document types, the topic chips, the
 *     source badge, the overwrite switch with the number that keeps its type
 *  7. the confirmation of an apply, with the numbers the impact route gives
 *  8. the two empty states, word for word
 *  9. the progress panel: its ids, the pure helpers that word its numbers,
 *     the event stream with its polling fallback and the re-attach after a
 *     reload
 * 10. the requests the page sends, and the one route it sends each on
 * 11. the proposed order of round 12: the ids the section carries, the group
 *     card for every kind, the member row for every action, the cut at 50
 *     members, the three filters, the summary line, the two confirmations,
 *     the result of an apply, the removal of one member, the two jobs, the
 *     vocabulary block, the table as the detail view and the empty states
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

const SCRIPT = read('public', 'js', 'simplify.js');
const CSS = read('public', 'css', 'pages', 'simplify.css');

/* ── 1. the view ──────────────────────────────────────────────────────────── */

let page = '';

test('views/simplify.ejs renders through the real shell partials', () => {
  page = renderSync('simplify.ejs', LOCALS);
  assert.ok(page.includes('<!DOCTYPE html>'), 'no document was produced');
  assert.ok(
    page.includes(
      'Turn compound tags into a document type and topic tags. Nothing here runs on its own.'
    ),
    'the view head sentence is missing'
  );
  assert.ok(
    page.includes('<script type="module" src="/js/simplify.js">'),
    'the page script must be loaded as a module, like every other page'
  );
});

test('The view carries the ids the page script and the route agree on', () => {
  // The two section anchors are the page's structure; nothing in the script
  // reads them, so they are asserted on their own.
  ['simVocabulary', 'simProposals', 'simProposalsTable'].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
  });

  [
    'simVocabularyNotice',
    'simVocabularyMeta',
    'simTypes',
    'simTopics',
    'simTypeInput',
    'simTopicInput',
    'simSaveVocabularyBtn',
    'simProposalsMeta',
    'simProposeSplitsBtn',
    'simProposeSplitsHint',
    'simProgress',
    'simProgressMessage',
    'simStopBtn',
    'simStats',
    'simStatProposals',
    'simStatOpen',
    'simStatRule',
    'simStatModel',
    'simStatApplied',
    'simStatusFilter',
    'simSearch',
    'simProposalsAlert',
    'simProposalsBody',
    'simTopicOptions',
    'simApplyStatus',
    'simSelectOpenBtn',
    'simClearSelectionBtn',
    'simSkipBtn',
    'simApplyBtn',
  ].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
    assert.ok(
      SCRIPT.includes(`'${id}'`) || SCRIPT.includes(`"${id}"`),
      `#${id} is in the view but the page script never reads it`
    );
  });

  // The table stacks on a phone like every other list of the app.
  assert.match(
    page,
    /class="zr-table zr-table--stack sim-proposals__table" id="simProposalsTable"/,
    'the proposal table must stack on a phone'
  );
  // "Apply selected" is the primary action and is dead until something is
  // ticked; the same for "Skip".
  assert.match(
    page,
    /id="simApplyBtn" type="button" disabled/,
    'the apply button must come up disabled'
  );
  assert.match(
    page,
    /id="simSkipBtn" type="button" disabled/,
    'the skip button must come up disabled'
  );
  // Without a saved vocabulary there is nothing to decompose against.
  assert.match(
    page,
    /id="simProposeSplitsBtn" type="button" disabled/,
    'the split run must wait for a vocabulary'
  );
  assert.ok(
    page.includes('Save a vocabulary first'),
    'the hint must say why the button is dead'
  );
  // The progress panel starts hidden through the framework's !important class.
  assert.match(
    page,
    /class="sim-progress zr-runmeter hidden" id="simProgress"/,
    'the progress panel must come up hidden'
  );
  assert.match(
    page,
    /id="simProgress"[^>]*aria-live="polite"/,
    'a running job is not announced'
  );
  assert.match(
    page,
    /class="zr-stats sim-stats hidden" id="simStats"/,
    'the tiles must wait for a proposal run'
  );
});

test('The model proposal is rendered only when the AI is available', () => {
  const offered = renderSync(
    'simplify.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  ['simProposeVocabularyBtn', 'simProposeVocabularyIcon'].forEach((id) => {
    assert.ok(
      offered.includes(`id="${id}"`),
      `#${id} is missing although the AI is available`
    );
  });
  assert.ok(
    offered.includes('Propose from my tags'),
    'the button is not labelled'
  );
  assert.match(
    offered,
    /id="simProposeVocabularyIcon"[\s\S]{0,120}icons\.svg#i-wand/,
    'the model-backed button has no i-wand icon'
  );

  // The default: none of it, and the page is whole without it — the rule
  // pass, every edit and the apply work with no model at all.
  ['simProposeVocabularyBtn', 'Propose from my tags'].forEach((needle) => {
    assert.ok(
      !page.includes(needle),
      `"${needle}" must not be rendered without aiReviewEnabled`
    );
  });
  ['simSaveVocabularyBtn', 'simProposeSplitsBtn', 'simApplyBtn'].forEach(
    (id) => {
      assert.ok(
        page.includes(`id="${id}"`),
        `#${id} must be there without the AI as well`
      );
    }
  );
});

/* ── 2. the navigation and the icon ───────────────────────────────────────── */

test('nav.ejs lists /simplify right after /duplicates', () => {
  const nav = read('views', 'partials', 'nav.ejs');
  assert.match(
    nav,
    /\{ href: '\/simplify', icon: 'i-split', label: 'Simplify tags' \}/,
    'the entry is missing or worded differently'
  );
  assert.ok(
    nav.indexOf("href: '/duplicates'") < nav.indexOf("href: '/simplify'"),
    'Simplify tags belongs after Duplicates, its log lives there'
  );
  // The phone tab bar has four places and they are taken; the entry carries
  // no `tab`, so it stays on the rail.
  const entry = nav.slice(
    nav.indexOf("href: '/simplify'"),
    nav.indexOf("href: '/simplify'") + 120
  );
  assert.ok(!entry.includes('tab:'), 'the entry must not take a phone tab');

  const rail = ejs.render(
    nav,
    { surface: 'rail' },
    {
      filename: path.join(VIEWS, 'partials', 'nav.ejs'),
      views: [VIEWS],
    }
  );
  assert.ok(
    rail.includes('href="/simplify"') && rail.includes('#i-split'),
    'the rail must show the entry with its icon'
  );
  const tabbar = ejs.render(
    nav,
    { surface: 'tabbar' },
    {
      filename: path.join(VIEWS, 'partials', 'nav.ejs'),
      views: [VIEWS],
    }
  );
  assert.ok(
    !tabbar.includes('href="/simplify"'),
    'the phone tab bar must be left alone'
  );
});

test('icons.svg carries the i-split symbol the page references', () => {
  const icons = read('public', 'icons.svg');
  const symbol = icons.slice(
    icons.indexOf('<symbol id="i-split"'),
    icons.indexOf('</symbol>', icons.indexOf('<symbol id="i-split"'))
  );
  assert.ok(symbol, 'the symbol is missing');
  assert.ok(
    symbol.includes('viewBox="0 0 24 24"'),
    'the icon set is a 24-box; a symbol outside it renders at the wrong size'
  );
  assert.ok(
    !/fill="/.test(symbol),
    'the icon set is stroke-based and inherits currentColor'
  );
  // Everything that references it must find it.
  [page, read('views', 'settings.ejs')].forEach((markup) => {
    if (!markup.includes('#i-split')) return;
    assert.ok(
      icons.includes('id="i-split"'),
      'a page references i-split but the set does not carry it'
    );
  });
});

/* ── 3. the stylesheet ────────────────────────────────────────────────────── */

test('head-start.ejs links the page stylesheet', () => {
  const head = read('views', 'partials', 'shell', 'head-start.ejs');
  assert.ok(
    head.includes('<link rel="stylesheet" href="/css/pages/simplify.css">'),
    'the page stylesheet is never loaded'
  );
  // Layer order decides, not link order — but tokens.css still has to come
  // first, and the page file belongs in the pages block.
  assert.ok(
    head.indexOf('/css/tokens.css') < head.indexOf('/css/pages/simplify.css'),
    'tokens.css declares the layer order and must be linked first'
  );
  assert.ok(
    head.indexOf('/css/pages/duplicates.css') <
      head.indexOf('/css/pages/simplify.css'),
    'the page files keep the order of the pages they belong to'
  );
});

test('simplify.css is one @layer pages block of sim- classes', () => {
  assert.strictEqual(
    (CSS.match(/@layer [a-z]+ \{/g) || []).length,
    1,
    'stylelint scopes its duplicate checks per layer block, so keep one'
  );
  assert.match(CSS, /@layer pages \{/, 'the page file belongs in layer pages');
  // Every class this file styles is its own or the framework's.
  const classes = [...CSS.matchAll(/\.([a-z][a-z0-9-]*)/g)].map(
    (match) => match[1]
  );
  const foreign = [...new Set(classes)].filter(
    (name) => !name.startsWith('sim-') && !name.startsWith('zr-')
  );
  assert.deepStrictEqual(
    foreign,
    [],
    `the page stylesheet may only style its own classes: ${foreign.join(', ')}`
  );
  // The panel and the two editable cells are what the page adds; the rest is
  // framework.
  [
    '.sim-vocab',
    '.sim-chip',
    '.sim-progress',
    '.sim-topics',
    '.sim-type',
  ].forEach((selector) => {
    assert.ok(
      CSS.includes(`${selector} {`) || CSS.includes(`${selector},`),
      `${selector} has no rule of its own`
    );
  });
  // Phone width: the two vocabulary lists stack rather than widening the page.
  assert.match(
    CSS,
    /@media \(max-width: 720px\) \{\n\s+\.sim-vocab \{\n\s+grid-template-columns: minmax\(0, 1fr\);/,
    'the vocabulary editor does not stack at phone width'
  );
  // Reduced motion: the indeterminate bar stands still rather than sliding.
  assert.match(
    CSS,
    /@media \(prefers-reduced-motion: reduce\) \{\n\s+\.sim-progress__fill--indeterminate \{\n\s+animation: none;/,
    'the sliding band ignores a reduced-motion preference'
  );
});

/* ── 4. the escaping rule ─────────────────────────────────────────────────── */

/**
 * Walks the source and returns every top-level template literal with the text
 * it produces and the expressions it interpolates. The same scanner
 * tests/test-duplicates-ui.js uses, so both page scripts are held to one rule.
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
        depth = 1;
        expression = '';
        i += 2;
      } else {
        current.text += ch;
        i += 1;
      }
    } else if (ctx === 'expression') {
      if (ch === '{') {
        depth += 1;
        expression += ch;
        i += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          stack.pop();
          current.expressions.push(expression.trim());
          current.text += '\u0000';
          i += 1;
        } else {
          expression += ch;
          i += 1;
        }
      } else {
        expression += ch;
        i += 1;
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
   and the page script says the same thing in its header comment. */
const SAFE_INTERPOLATIONS = [/^esc\(/, /^num\(/, /^html[A-Z]/];

test('Every value interpolated into markup is escaped or a number', () => {
  const markup = templateLiterals(SCRIPT).filter((literal) =>
    /<[a-zA-Z/!]/.test(literal.text)
  );
  assert.ok(
    markup.length >= 6,
    `only ${markup.length} markup templates found — the scanner lost track`
  );

  const offenders = [];
  markup.forEach((literal) => {
    literal.expressions.forEach((expression) => {
      if (expression.includes('`')) {
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

test('The page script imports the shared escaper and the kernel', () => {
  assert.match(
    SCRIPT,
    /import \{ escapeHtml as esc \} from '\/js\/modules\/text-utils\.js';/,
    'the escaper is shared; a hand-written one leaves quotes intact'
  );
  assert.match(
    SCRIPT,
    /import \{ toast, confirmDialog \} from '\/js\/zr\.js';/,
    'toasts and dialogs come from the kernel, never from a second host'
  );
});

/* ── the helpers, taken out of the module ─────────────────────────────────── */

function functionSource(name) {
  const start = SCRIPT.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name}() is gone from the page script`);
  const open = SCRIPT.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SCRIPT.length; i += 1) {
    if (SCRIPT[i] === '{') depth += 1;
    if (SCRIPT[i] === '}') {
      depth -= 1;
      if (depth === 0) return SCRIPT.slice(start, i + 1);
    }
  }
  throw new Error(`${name}() is not balanced`);
}

function functionBody(name) {
  const source = functionSource(name);
  return source.slice(source.indexOf('{'));
}

function constantSource(name) {
  const start = SCRIPT.indexOf(`const ${name} = {`);
  assert.notStrictEqual(start, -1, `${name} is gone from the page script`);
  const open = SCRIPT.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SCRIPT.length; i += 1) {
    if (SCRIPT[i] === '{') depth += 1;
    if (SCRIPT[i] === '}') {
      depth -= 1;
      if (depth === 0) return `${SCRIPT.slice(start, i + 1)};`;
    }
  }
  throw new Error(`${name} is not balanced`);
}

const escForTest = (value) =>
  String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]
  );

/**
 * The named helpers of the page script, evaluated out of their module. Only
 * pure functions can be taken this way, which is why everything this page
 * decides — what a row looks like, what the confirmation says — is written as
 * a pure function in the first place.
 */
function helpers(names, extra = {}) {
  const constants = (extra.constants || []).map(constantSource).join('\n');
  const source = names.map(functionSource).join('\n');
  const globals = extra.globals || {};
  const keys = Object.keys(globals);
  return new Function(
    ...keys,
    `${constants}\n${source}\nreturn { ${names.join(', ')} };`
  )(...keys.map((key) => globals[key]));
}

/* ── 5. the vocabulary chips ──────────────────────────────────────────────── */

test('The vocabulary renders as chips, each with the button that removes it', () => {
  const { htmlVocabularyChips } = helpers(['htmlVocabularyChips'], {
    globals: { esc: escForTest },
  });

  const chips = htmlVocabularyChips(['Rechnung', 'Brief'], 'type');
  assert.strictEqual(
    (chips.match(/class="zr-chip sim-chip"/g) || []).length,
    2,
    'one chip per entry, and it is a framework chip'
  );
  assert.ok(chips.includes('>Rechnung<'), 'the name belongs in the chip');
  assert.ok(
    chips.includes('data-dimension="type"'),
    'the remove button must say which list it belongs to'
  );
  assert.ok(
    chips.includes('data-name="Brief"'),
    'the remove button must name what it removes'
  );
  assert.ok(
    chips.includes('aria-label="Remove Brief"'),
    'the remove button is an icon and needs a label'
  );
  assert.ok(
    chips.includes('/icons.svg#i-x'),
    'the remove button uses the icon set, not a character'
  );

  // Names are the user's and the model's, so they are escaped everywhere they
  // land — in the text and in the attribute.
  const nasty = htmlVocabularyChips(['<b>Rechnung</b>'], 'type');
  assert.ok(nasty.includes('&lt;b&gt;Rechnung&lt;/b&gt;'));
  assert.ok(!nasty.includes('<b>'), 'a name must never reach the page as tags');

  const empty = htmlVocabularyChips([], 'topic');
  assert.ok(
    empty.includes('sim-vocab__empty'),
    'an empty list says so rather than collapsing'
  );
  assert.strictEqual(htmlVocabularyChips(null, 'topic'), empty);
});

test('Adding and removing a vocabulary name keeps the order and drops repeats', () => {
  const add = functionBody('addVocabularyName');
  assert.ok(
    add.includes('entry.toLowerCase() === name.toLowerCase()'),
    'a name that differs only in case is the same name'
  );
  assert.ok(
    add.includes('list.push(name)'),
    'a new name goes to the end; the user decides the order'
  );
  assert.ok(
    /if \(name === ''\) return false;/.test(add),
    'an empty input must not add a chip'
  );

  // Enter adds; there is no second button for it.
  const init = functionBody('initVocabulary');
  assert.ok(
    init.includes("event.key !== 'Enter'"),
    'Enter is what adds a name'
  );
  assert.ok(
    init.includes("input.value = ''"),
    'the input clears itself once the chip is there'
  );
  assert.ok(
    init.includes(".closest('.sim-chip__remove')"),
    'the remove button is handled by delegation, not by a listener per chip'
  );
});

test('A model proposal keeps what the user already had', () => {
  const { mergeProposedVocabulary } = helpers(['mergeProposedVocabulary'], {});
  assert.deepStrictEqual(
    mergeProposedVocabulary(['Brief'], ['Rechnung', 'Brief', 'Vertrag']),
    ['Brief', 'Rechnung', 'Vertrag'],
    "the user's entries come first and are not repeated"
  );
  assert.deepStrictEqual(
    mergeProposedVocabulary(['Brief'], ['  brief  ']),
    ['Brief'],
    'a proposal that differs only in case and spacing is the same name'
  );
  assert.deepStrictEqual(mergeProposedVocabulary(['Brief'], null), ['Brief']);
  assert.deepStrictEqual(
    mergeProposedVocabulary([], ['Rechnung', '', '   ']),
    ['Rechnung'],
    'a blank proposal is not an entry'
  );

  assert.match(
    SCRIPT,
    /const PROPOSAL_NOTICE = 'Proposed by the model, not saved yet';/,
    'the notice over an unsaved proposal must say exactly that'
  );
  const propose = functionBody('proposeVocabulary');
  assert.ok(
    propose.includes('PROPOSAL_NOTICE'),
    'the proposal must be marked as unsaved'
  );
  assert.ok(
    !propose.includes("sendJson('PUT'"),
    'a proposal saves nothing; only the save button does'
  );
  assert.ok(
    functionBody('saveVocabulary').includes(
      "sendJson('PUT', '/api/simplify/vocabulary'"
    ),
    'the save button is the one thing that stores a vocabulary'
  );
});

/* ── 5b. the document types Paperless-ngx already has ─────────────────────── */

const PICKER = read('public', 'js', 'modules', 'picker.js');
const PICKER_CSS = read('public', 'css', 'picker.css');

/**
 * The same trick helpers() plays, for the shared module: it has no page to
 * belong to, so its exports are evaluated straight out of the file with the
 * import line and the export keywords taken off.
 */
function pickerHelpers(names, globals = {}) {
  const source = PICKER.replace(/^import .*$/m, '').replace(/^export /gm, '');
  const keys = Object.keys(globals);
  return new Function(...keys, `${source}\nreturn { ${names.join(', ')} };`)(
    ...keys.map((key) => globals[key])
  );
}

test('The view carries the picker, the reload and the two notices', () => {
  [
    'simTypePicker',
    'simTypeInput',
    'simTypeList',
    'simTypesReloadBtn',
    'simTypesNote',
    'simAdoptTypes',
    'simTopicHint',
  ].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
  });
  ['simTypeList', 'simTypesReloadBtn', 'simTypesNote', 'simAdoptTypes'].forEach(
    (id) => {
      assert.ok(
        SCRIPT.includes(`'${id}'`) || SCRIPT.includes(`"${id}"`),
        `#${id} is in the view but the page script never reads it`
      );
    }
  );

  // The input is the picker's, with the aria wiring a combobox needs.
  assert.match(
    page,
    /id="simTypeInput"[\s\S]{0,400}?role="combobox"/,
    'the type field must announce itself as a combobox'
  );
  assert.match(
    page,
    /id="simTypeInput"[\s\S]{0,400}?aria-controls="simTypeList"/,
    'the combobox must name the list it controls'
  );
  assert.match(
    page,
    /id="simTypeInput"[\s\S]{0,400}?aria-expanded="false"/,
    'the list starts closed'
  );
  assert.match(
    page,
    /class="zr-picker" id="simTypePicker"/,
    'the field must sit in the shared .zr-picker wrapper'
  );
  assert.match(
    page,
    /class="zr-picker__list hidden" id="simTypeList" role="listbox"/,
    'the dropdown is a listbox and comes up hidden'
  );
  assert.ok(
    page.includes('placeholder="Search a document type or type a new one"'),
    'the placeholder must say that a new name is allowed too'
  );

  // The reload is an icon button and says what it does.
  assert.match(
    page,
    /id="simTypesReloadBtn"[^>]*aria-label="Reload document types"/,
    'an icon button needs a label'
  );
  assert.match(
    page,
    /id="simTypesReloadIcon"[\s\S]{0,120}icons\.svg#i-refresh/,
    'the reload button uses the icon set'
  );

  // Both notices come up empty and hidden; the script fills them.
  assert.match(
    page,
    /class="zr-alert zr-alert--info sim-adopt hidden" id="simAdoptTypes"/,
    'the offer is an info alert that starts hidden'
  );
  assert.match(
    page,
    /class="zr-sm zr-faint sim-hint hidden" id="simTopicHint"/,
    'the topic hint starts hidden'
  );
  assert.match(
    page,
    /id="simTopicHint"[^>]*aria-live="polite"/,
    'a hint that appears after a keystroke has to be announced'
  );
  // The module clips what leaves it, which would cut the dropdown short.
  assert.match(
    page,
    /class="zr-module sim-vocab-module" id="simVocabularyBlock"/,
    'the vocabulary section needs the class that lets the dropdown out'
  );
});

test('head-start.ejs links picker.css, which is one @layer components block', () => {
  const head = read('views', 'partials', 'shell', 'head-start.ejs');
  assert.ok(
    head.includes('<link rel="stylesheet" href="/css/picker.css">'),
    'the shared picker stylesheet is never loaded'
  );
  assert.ok(
    head.indexOf('/css/dialogs.css') < head.indexOf('/css/picker.css'),
    'picker.css belongs right after dialogs.css'
  );

  const layers = [
    ...PICKER_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(
      /@layer\s+([^;{]+)[;{]/g
    ),
  ].map((match) => match[1].trim());
  assert.deepStrictEqual(
    layers,
    ['components'],
    'the shared picker is framework, not a page — and one layer block per file'
  );
  // Every class it styles is its own.
  const classes = [
    ...PICKER_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(
      /\.([a-z][a-z0-9-]*)/g
    ),
  ].map((match) => match[1]);
  assert.deepStrictEqual(
    [...new Set(classes)].filter((name) => !name.startsWith('zr-picker')),
    [],
    'picker.css may only style .zr-picker*'
  );
  // The page files must not carry the old copy any more.
  ['duplicates', 'simplify'].forEach((name) => {
    assert.ok(
      !read('public', 'css', 'pages', `${name}.css`).includes('dup-picker'),
      `${name}.css still carries the picker rules that moved`
    );
  });
  assert.ok(
    !read('public', 'js', 'duplicates.js').includes('dup-picker'),
    'the Duplicates page must use the shared classes now'
  );
  assert.match(
    read('views', 'duplicates.ejs'),
    /class="zr-picker" id="dupManualTargetPicker"/,
    'the manual merge markup must use the shared classes now'
  );
});

test('A row of the picker wears the badge the page asked for', () => {
  const { htmlPickerRow } = pickerHelpers(['htmlPickerRow'], {
    esc: escForTest,
  });

  const plain = htmlPickerRow(
    { name: 'Brief', documentCount: 64 },
    0,
    'simTypeRow'
  );
  assert.ok(plain.includes('class="zr-picker__row"'), 'the shared row class');
  assert.ok(plain.includes('id="simTypeRow0"'), 'the row must be addressable');
  assert.ok(plain.includes('>Brief<'), 'the name belongs in the row');
  assert.ok(plain.includes('>64<'), 'so does the document count');
  assert.ok(!plain.includes('zr-badge'), 'a plain row wears no badge');

  const marked = htmlPickerRow(
    {
      name: 'Rechnung',
      documentCount: 128,
      badge: { text: 'in vocabulary', tone: 'ok' },
    },
    1,
    'simTypeRow'
  );
  assert.ok(
    marked.includes('<span class="zr-badge zr-badge--ok">in vocabulary</span>'),
    'the badge must be a framework badge in the tone the page asked for'
  );

  // A tone the framework does not have is dropped, not written into a class.
  const odd = htmlPickerRow(
    { name: 'Brief', badge: { text: 'x', tone: 'evil"><script>' } },
    0,
    'r'
  );
  assert.ok(
    odd.includes('<span class="zr-badge">x</span>'),
    'an unknown tone leaves the badge plain'
  );
  assert.ok(!odd.includes('<script>'), 'and never reaches the page as markup');

  // Names are user data wherever they land.
  const nasty = htmlPickerRow(
    { name: '<b>Brief</b>', documentCount: 'nope' },
    0,
    'r'
  );
  assert.ok(nasty.includes('&lt;b&gt;Brief&lt;/b&gt;'));
  assert.ok(!nasty.includes('<b>'), 'a name must never reach the page as tags');
  assert.ok(nasty.includes('>0<'), 'a count that is not a number is 0');

  // The lock the Duplicates page relies on survived the move.
  const locked = htmlPickerRow({ name: 'Brief', userCanChange: false }, 0, 'r');
  assert.ok(locked.includes('zr-picker__lock'), 'the lock is gone');
  assert.ok(locked.includes('icons.svg#i-shield'), 'with the icon it had');

  // The page hands the module what it may offer; the module fetches nothing.
  assert.ok(
    !/fetch\(|getElementById/.test(PICKER),
    'the shared module must know nothing about a page: no ids, no requests'
  );
  assert.match(
    SCRIPT,
    /import \{ createPicker \} from '\/js\/modules\/picker\.js';/,
    'the page must use the shared picker, not a copy'
  );
});

test('The offer to take over the existing types names their number', () => {
  const { htmlAdoptTypes } = helpers(['num', 'plural', 'htmlAdoptTypes'], {
    globals: { esc: escForTest },
  });

  const many = htmlAdoptTypes(4);
  assert.ok(
    many.includes('Paperless-ngx already has 4 document types.'),
    'the sentence must say how many there are'
  );
  assert.ok(
    many.includes('>Take over 4 document types<'),
    'and the button must say what it will do'
  );
  assert.ok(
    many.includes('id="simAdoptTypesBtn"'),
    'the button is addressed by id'
  );

  const one = htmlAdoptTypes(1);
  assert.ok(one.includes('Paperless-ngx already has 1 document type.'));
  assert.ok(one.includes('>Take over 1 document type<'));

  // Offered only while there is nothing to lose, and never after a failure.
  const render = functionBody('renderAdoptOffer');
  assert.ok(
    render.includes('vocabulary.types.length === 0'),
    'a vocabulary that already has a type is not offered one'
  );
  assert.ok(
    render.includes('!typesUnreachable'),
    'nothing is offered while the list could not be read'
  );
  assert.ok(
    render.includes('documentTypes.length > 0'),
    'and nothing is offered when the instance has none'
  );
  assert.ok(
    functionBody('renderVocabulary').includes('renderAdoptOffer()'),
    'the offer must go as soon as the list has an entry'
  );

  // Taking it over stores nothing; the save button still does that.
  const adopt = functionBody('adoptDocumentTypes');
  assert.ok(
    adopt.includes("addVocabularyName('type'"),
    'the names go into the list the user is editing'
  );
  assert.ok(adopt.includes('ADOPT_NOTICE'), 'and the list is marked unsaved');
  assert.ok(
    !adopt.includes('sendJson'),
    'taking over must not write anything by itself'
  );
  assert.match(
    SCRIPT,
    /const ADOPT_NOTICE = 'Taken over from Paperless-ngx, not saved yet';/,
    'the notice must say exactly that'
  );
});

test('The hint under a typed topic says what the tag list knows', () => {
  const { htmlTopicHint, useExistingSpelling } = helpers(
    ['num', 'plural', 'htmlTopicHint', 'useExistingSpelling'],
    { globals: { esc: escForTest } }
  );

  // 1. the same name: the split reuses the tag.
  assert.strictEqual(
    htmlTopicHint('Strom', { name: 'Strom', documentCount: 12 }),
    '&#39;Strom&#39; is an existing tag with 12 documents; a split reuses it.'
  );
  assert.ok(
    htmlTopicHint('Strom', { name: 'Strom', documentCount: 1 }).includes(
      '1 document;'
    ),
    'one document is not "1 documents"'
  );

  // 2. only the spelling differs: the offer to take the existing one.
  const cased = htmlTopicHint('strom', { name: 'Strom', documentCount: 12 });
  assert.ok(
    cased.includes(
      '&#39;strom&#39; differs from the existing tag &#39;Strom&#39; only in spelling.'
    ),
    'the sentence must name both spellings'
  );
  assert.ok(
    cased.includes('class="zr-btn sim-hint__use"'),
    'the offer is a button, not a sentence to read'
  );
  assert.ok(cased.includes('data-name="Strom"'), 'it must name what it sets');
  assert.ok(cased.includes('data-typed="strom"'), 'and what it replaces');
  assert.ok(cased.includes('>Use &#39;Strom&#39;<'), 'and say so');

  // 3. nothing of that name: no hint at all.
  assert.strictEqual(htmlTopicHint('Photovoltaik', null), '');

  // A name is user data here too.
  const nasty = htmlTopicHint('<b>x</b>', { name: '<b>X</b>' });
  assert.ok(!nasty.includes('<b>'), 'a name must never reach the page as tags');

  // Taking the offer keeps the position and never leaves the name twice.
  assert.deepStrictEqual(
    useExistingSpelling(['Auto', 'strom', 'Steuer'], 'strom', 'Strom'),
    ['Auto', 'Strom', 'Steuer'],
    'the chip stays where it was'
  );
  assert.deepStrictEqual(
    useExistingSpelling(['Strom', 'strom'], 'strom', 'Strom'),
    ['Strom'],
    'a list that already holds the wanted spelling only loses the typed one'
  );
  assert.deepStrictEqual(
    useExistingSpelling(['Auto'], 'strom', 'Strom'),
    ['Auto'],
    'a chip that is gone is not put back'
  );

  // The tag list is read once, lazily, and never fails the page.
  const ensure = functionBody('ensureTagIndex');
  assert.ok(
    ensure.includes("'/api/duplicates/entities?kind=tags'"),
    'the names come from the list the Duplicates page already offers'
  );
  assert.ok(
    ensure.includes('if (tagIndex) return Promise.resolve(tagIndex)'),
    'the list is read once and kept'
  );
  assert.ok(ensure.includes('.catch('), 'a hint must never break the page');
  assert.ok(
    !functionBody('init').includes('ensureTagIndex'),
    'a page that never adds a topic must not fetch a thousand names'
  );
  // Only a typed topic is hinted at; a proposal of the model is not.
  const wiring = functionBody('initVocabulary');
  assert.ok(
    wiring.includes("addFrom(el.topicInput, 'topic', showTopicHint)"),
    'the hint hangs off the topic input, nothing else'
  );
  assert.ok(
    !functionBody('proposeVocabulary').includes('showTopicHint'),
    'a proposal of the model gets no hint'
  );
});

test('The document types are read on load, past the cache on reload', () => {
  const load = functionBody('loadDocumentTypes');
  assert.ok(
    load.includes("'/api/simplify/document-types'"),
    'the page reads the cached list on load'
  );
  assert.ok(
    load.includes("'/api/simplify/document-types?fresh=1'"),
    'and past the cache when asked to'
  );
  assert.ok(
    load.includes('TYPES_UNREACHABLE'),
    'a failure must say so rather than leave an empty field'
  );
  assert.match(
    SCRIPT,
    /const TYPES_UNREACHABLE =\n\s+'Paperless-ngx could not be reached; you can still type a name\.';/,
    'the note must be worded exactly that way'
  );
  assert.ok(
    functionBody('reloadDocumentTypes').includes('loadDocumentTypes(true)'),
    'the reload button is the one thing that bypasses the cache'
  );
  const init = functionBody('init');
  assert.ok(
    init.includes('loadDocumentTypes()'),
    'the list is fetched once when the page opens'
  );
  assert.ok(
    functionBody('applySelected').includes('loadDocumentTypes()'),
    'a split may have created a type, so the list is read again afterwards'
  );

  // Picking a row adds the name; a row already in the vocabulary only closes.
  const picker = functionBody('initTypePicker');
  assert.ok(picker.includes("prefix: 'simTypeRow'"), 'the rows need an id');
  assert.ok(
    picker.includes("if (inVocabulary('type', name)) return;"),
    'a type the vocabulary has is not added a second time'
  );
  assert.ok(
    picker.includes("addVocabularyName('type', name)"),
    'and any other row is'
  );
  assert.ok(
    functionBody('typeChoices').includes('IN_VOCABULARY_BADGE'),
    'a row the vocabulary already holds must be recognisable'
  );
  assert.match(
    SCRIPT,
    /const IN_VOCABULARY_BADGE = \{ text: 'in vocabulary', tone: 'ok' \};/,
    'the badge must read "in vocabulary"'
  );
  // Enter on a query nothing matches still adds the typed name.
  assert.ok(
    functionBody('initVocabulary').includes(
      'if (event.defaultPrevented) return;'
    ),
    'a row picked with Enter must not be added as text as well'
  );
});

/* ── 6. the proposal row ──────────────────────────────────────────────────── */

test('The proposal row carries the select, the chips and the badges', () => {
  const { htmlProposalRow } = helpers(
    [
      'num',
      'plural',
      'actionLabel',
      'htmlSourceBadge',
      'overwriteLabel',
      'htmlTypeSelect',
      'htmlTopicChips',
      'htmlProposalRow',
    ],
    {
      constants: ['SOURCE_LABELS', 'SOURCE_TONES', 'STATUS_BADGES'],
      globals: { esc: escForTest, UNDO_HREF: '/duplicates#dupLog' },
    }
  );

  const row = htmlProposalRow(
    {
      tagId: 9,
      tagName: 'Stromrechnung',
      documentCount: 12,
      typeName: 'Rechnung',
      topicNames: ['Strom'],
      source: 'rule',
      confidence: 'high',
      reason: 'compound of Rechnung and Strom',
      documentsWithType: 3,
      overwriteType: false,
      status: 'open',
    },
    ['Rechnung', 'Brief']
  );

  assert.ok(row.includes('data-tag-id="9"'), 'the row names its tag');
  assert.ok(
    row.includes('class="zr-check sim-pick" data-tag-id="9"'),
    'the pick checkbox is missing or renamed'
  );
  assert.ok(row.includes('>Stromrechnung<'), 'the tag name belongs in the row');
  assert.ok(row.includes('>12<'), 'the document count belongs in the row');

  // The type is a select of the vocabulary plus "none", with the proposal
  // selected.
  assert.ok(
    row.includes('class="zr-select sim-type" data-tag-id="9"'),
    'the type cell is not a select'
  );
  assert.ok(
    row.includes('<option value="">none</option>') ||
      row.includes('<option value="" >none</option>'),
    'a tag may encode no document type at all'
  );
  assert.ok(
    row.includes('<option value="Rechnung" selected>Rechnung</option>'),
    'the proposed type must come up selected'
  );
  assert.ok(row.includes('>Brief<'), 'every vocabulary type is offered');

  // The topics are chips plus an input that offers the vocabulary.
  assert.ok(
    row.includes('class="sim-topic-remove" data-tag-id="9" data-name="Strom"'),
    'a topic chip must carry the button that removes it'
  );
  assert.ok(
    row.includes('list="simTopicOptions"'),
    'the topic input must offer the vocabulary'
  );

  assert.ok(
    row.includes('<span class="zr-badge zr-badge--ok">rule</span>'),
    'a rule-settled row must say so'
  );
  assert.ok(
    row.includes('compound of Rechnung and Strom'),
    'the reason belongs in the row'
  );
  assert.ok(
    row.includes('<span class="zr-badge ">open</span>'),
    'the status belongs in the row'
  );

  // The overwrite switch, with the number of documents that keep their type.
  assert.ok(
    row.includes('class="zr-check sim-overwrite" data-tag-id="9"'),
    'the overwrite switch is missing or renamed'
  );
  assert.ok(
    !/class="zr-check sim-overwrite"[^>]*checked/.test(row),
    'a document that carries a type keeps it unless the user says otherwise'
  );
  assert.ok(
    row.includes('3 keep their type'),
    'the row must say how many documents keep the type they have'
  );
});

test('The source badge says model and user apart, with the confidence', () => {
  const { htmlSourceBadge, overwriteLabel } = helpers(
    ['htmlSourceBadge', 'num', 'plural', 'overwriteLabel'],
    {
      constants: ['SOURCE_LABELS', 'SOURCE_TONES'],
      globals: { esc: escForTest },
    }
  );
  assert.ok(htmlSourceBadge({ source: 'rule' }).includes('>rule<'));
  assert.ok(
    htmlSourceBadge({ source: 'model', confidence: 'low' }).includes(
      '>model · low<'
    ),
    'a model proposal must show how sure the model was'
  );
  assert.ok(
    htmlSourceBadge({ source: 'model' }).includes('>model<'),
    'an answer without a confidence claims none'
  );
  assert.ok(
    htmlSourceBadge({ source: 'user' }).includes('>you<'),
    'a row the user edited says so in their own words'
  );
  // A rule needs no confidence: it is as sure as this page gets.
  assert.ok(
    !htmlSourceBadge({ source: 'rule', confidence: 'high' }).includes('high')
  );

  assert.strictEqual(overwriteLabel({ documentsWithType: 0 }), '');
  assert.strictEqual(overwriteLabel({}), '');
  assert.strictEqual(
    overwriteLabel({ documentsWithType: 1 }),
    '1 keeps its type'
  );
  assert.strictEqual(
    overwriteLabel({ documentsWithType: 7 }),
    '7 keep their type'
  );
});

test('An applied row is history, with the one link that takes it back', () => {
  const { htmlProposalRow } = helpers(
    [
      'num',
      'plural',
      'actionLabel',
      'htmlSourceBadge',
      'overwriteLabel',
      'htmlTypeSelect',
      'htmlTopicChips',
      'htmlProposalRow',
    ],
    {
      constants: ['SOURCE_LABELS', 'SOURCE_TONES', 'STATUS_BADGES'],
      globals: { esc: escForTest, UNDO_HREF: '/duplicates#dupLog' },
    }
  );

  const applied = htmlProposalRow(
    {
      tagId: 9,
      tagName: 'Stromrechnung',
      documentCount: 12,
      typeName: 'Rechnung',
      topicNames: ['Strom'],
      source: 'rule',
      status: 'applied',
    },
    ['Rechnung']
  );
  assert.ok(
    applied.includes('sim-row--applied'),
    'an applied row must read as done'
  );
  assert.ok(
    applied.includes('href="/duplicates#dupLog"') &&
      applied.includes('undo on the Duplicates page'),
    'the one log of the app lives on the Duplicates page, and the row says so'
  );
  assert.ok(
    !applied.includes('sim-pick'),
    'an applied row cannot be applied again'
  );
  assert.ok(
    !applied.includes('class="zr-select sim-type"'),
    'an applied row is not edited any more'
  );
  assert.ok(
    !applied.includes('sim-overwrite'),
    'an applied row has no overwrite switch either'
  );
  assert.ok(
    applied.includes('<span class="zr-badge zr-badge--ok">applied</span>')
  );

  const failed = htmlProposalRow(
    {
      tagId: 4,
      tagName: 'Autorechnung',
      documentCount: 3,
      topicNames: [],
      source: 'model',
      status: 'open',
      error: 'Tag 4 is gone',
    },
    []
  );
  assert.ok(
    failed.includes('sim-row--failed') &&
      failed.includes('<span class="sim-error">Tag 4 is gone</span>'),
    'a row that failed must show its reason where it happened'
  );
});

/* ── 7. the confirmation of an apply ──────────────────────────────────────── */

test('The confirmation names every number the apply will change', () => {
  const { applyConfirmText } = helpers(
    ['num', 'plural', 'applyConfirmText'],
    {}
  );

  const many = applyConfirmText([
    { documents: 300, typeSet: 280, typeKept: 20 },
    ...Array.from({ length: 11 }, () => ({
      documents: 40 / 11,
      typeSet: 20 / 11,
      typeKept: 20 / 11,
    })),
  ]);
  assert.ok(many.startsWith('Split 12 tags: '), `wrong opening: ${many}`);
  assert.ok(
    many.includes('12 tags are deleted.'),
    'the sentence must say that the compound tags go away'
  );
  assert.ok(
    many.includes(
      'You can undo each split from the log on the Duplicates page.'
    ),
    'the promise of an undo belongs in the confirmation'
  );

  const one = applyConfirmText([
    { documents: 340, typeSet: 300, typeKept: 40 },
  ]);
  assert.strictEqual(
    one,
    'Split 1 tag: 340 documents get their topics; 300 get their document type, 40 keep the one they have. 1 tag is deleted. You can undo each split from the log on the Duplicates page.',
    'the numbers and the wording of the confirmation are contract'
  );

  // Nothing keeps a type: the clause that would say "0 keep" is left out.
  const clean = applyConfirmText([{ documents: 5, typeSet: 5, typeKept: 0 }]);
  assert.ok(clean.includes('5 get their document type.'), clean);
  assert.ok(!clean.includes('keep the one they have'), clean);

  // A tag that encodes no type at all only moves topics.
  const topicsOnly = applyConfirmText([
    { documents: 4, typeSet: 0, typeKept: 0 },
  ]);
  assert.ok(!topicsOnly.includes('document type'), topicsOnly);
  assert.ok(topicsOnly.includes('4 documents get their topics.'), topicsOnly);

  const single = applyConfirmText([{ documents: 1, typeSet: 1, typeKept: 0 }]);
  assert.ok(single.includes('1 document gets their topics'), single);

  // The dialog is the one the kernel draws, and it is a decision.
  const apply = functionBody('applySelected');
  assert.ok(
    apply.includes('confirmDialog({') && apply.includes("tone: 'danger'"),
    'an apply deletes tags and asks like every other destructive step'
  );
  assert.ok(
    apply.includes('applyConfirmText(entries)'),
    'the dialog must be filled from the impact, not from a guess'
  );
  assert.ok(
    apply.includes('Checking documents, ${index + 1} of ${picks.length}…'),
    'the wait while the impact is fetched must say how far it is'
  );
});

test('The impact falls back to what the proposal itself recorded', () => {
  const impact = functionBody('impactOf');
  assert.ok(
    impact.includes('/api/simplify/proposals/') && impact.includes('/impact'),
    'the numbers come from the route that asks Paperless-ngx'
  );
  assert.ok(
    impact.includes('return fallback;'),
    'a build whose service cannot answer yet must still name honest numbers'
  );
  assert.ok(
    impact.includes('proposal.overwriteType === true ? 0 :'),
    'with overwrite nothing keeps its type, so nothing is counted as kept'
  );
});

/* ── 8. the empty states ──────────────────────────────────────────────────── */

test('Both empty states say what to do next, word for word', () => {
  assert.match(
    SCRIPT,
    /const VOCABULARY_EMPTY =\n\s+'No vocabulary yet\. Propose one from your tags or type the document types and topics your archive should end up with\.';/,
    'the empty vocabulary must say exactly that'
  );
  assert.match(
    SCRIPT,
    /const PROPOSALS_EMPTY =\n\s+'No proposals yet\. Save a vocabulary, then propose splits\.';/,
    'the empty table must say exactly that'
  );

  const { htmlVocabularyEmpty } = helpers(['htmlVocabularyEmpty'], {
    globals: { esc: escForTest, VOCABULARY_EMPTY: 'nothing here' },
  });
  assert.ok(
    htmlVocabularyEmpty().includes('zr-alert zr-alert--info'),
    'an empty vocabulary is information, not a problem'
  );

  const render = functionBody('renderProposals');
  assert.ok(
    render.includes('PROPOSALS_EMPTY'),
    'the empty table must show the sentence'
  );
  assert.ok(
    render.includes("'Nothing here.'"),
    'a filter that matches nothing is not the same as no proposals at all'
  );
});

/* ── 9. the progress panel ────────────────────────────────────────────────── */

test('The panel words its numbers the way a wait reads', () => {
  const {
    formatTokens,
    formatElapsed,
    formatEta,
    progressPercent,
    progressOutcomeText,
    phaseHeadline,
  } = helpers(
    [
      'num',
      'plural',
      'formatTokens',
      'formatElapsed',
      'formatEta',
      'progressPercent',
      'progressOutcomeText',
      'phaseHeadline',
    ],
    {}
  );

  assert.strictEqual(formatTokens(0), '0');
  assert.strictEqual(formatTokens(980), '980');
  assert.strictEqual(formatTokens(12400), '12.4k');
  assert.strictEqual(formatTokens(1200000), '1.2M');

  assert.strictEqual(formatElapsed(7000), '0:07');
  assert.strictEqual(formatElapsed(84000), '1:24');
  assert.strictEqual(formatElapsed(3723000), '1:02:03');

  assert.strictEqual(formatEta(null), '');
  assert.strictEqual(formatEta(2000), 'almost done');
  assert.strictEqual(formatEta(40000), 'about 40 s left');
  assert.strictEqual(formatEta(180000), 'about 3 min left');

  // Before the plan knows how many requests it needs there is no share.
  assert.strictEqual(progressPercent({}), null);
  assert.strictEqual(progressPercent({ requestsPlanned: 0 }), null);
  assert.strictEqual(
    progressPercent({ requestsDone: 3, requestsPlanned: 6 }),
    50
  );
  assert.strictEqual(
    progressPercent({ requestsDone: 9, requestsPlanned: 6 }),
    100,
    'a plan that grew must not push the bar past its end'
  );

  // The headline is the phase, and it does not flicker with the message
  // underneath it — that detail lives on the request's own row in the log.
  assert.strictEqual(
    phaseHeadline({ phase: 'ordering', message: 'Asking about 50 tags…' }),
    'Asking the model'
  );
  assert.strictEqual(
    phaseHeadline({ phase: 'vocabulary' }),
    'Proposing a vocabulary'
  );
  assert.strictEqual(
    phaseHeadline({ phase: 'brand-new', message: 'Waiting for the scan…' }),
    'Waiting for the scan…'
  );
  assert.strictEqual(phaseHeadline({}), 'Working');

  assert.strictEqual(
    progressOutcomeText({
      type: 'done',
      job: { progress: { elapsedMs: 42000, requestsDone: 3, tokens: 1200 } },
    }),
    'Done in 0:42 · 3 requests · 1.2k tokens'
  );
  assert.strictEqual(
    progressOutcomeText({
      type: 'stopped',
      job: { progress: { elapsedMs: 42000, requestsDone: 1, tokens: 500 } },
    }),
    'Stopped after 1 request · 500 tokens'
  );
  assert.strictEqual(
    progressOutcomeText({
      type: 'failed',
      job: { progress: { elapsedMs: 5000 } },
    }),
    'Failed after 0:05'
  );
});

test('The page follows a job through the stream, and polls when it breaks', () => {
  const follow = functionBody('followJob');
  assert.ok(
    follow.includes('new EventSource(`${base}/events`)'),
    'the stream is the normal way to watch a job'
  );
  assert.ok(
    follow.includes('startPolling();'),
    'a proxy that closes the stream must not lose the job'
  );
  assert.ok(
    follow.includes('/api/duplicates/ai-review/jobs/'),
    'both pages watch the same job service'
  );
  assert.ok(
    follow.includes("typeof window.EventSource === 'function'"),
    'a browser without EventSource polls from the start'
  );

  const stop = functionBody('stopJob');
  assert.ok(
    stop.includes('/stop'),
    'the stop button must reach the job it is stopping'
  );
  assert.ok(
    stop.includes("setStopLabel('Stopping…')"),
    'the button must say that it has been used'
  );

  // A reload attaches to a job of this page and leaves a review alone.
  const reattach = functionBody('reattachJob');
  assert.ok(
    reattach.includes('/api/duplicates/ai-review/jobs/current'),
    'a reloaded page asks what is running'
  );
  assert.ok(
    reattach.includes('if (!mine.includes(task)) return;'),
    'a review of the Duplicates page belongs there, not here'
  );
  ['VOCABULARY', 'SPLITS', 'ORDER', 'APPLY'].forEach((task) => {
    assert.ok(
      reattach.includes(`JOB_TASKS.${task}`),
      `a running ${task.toLowerCase()} job must get its page back`
    );
  });
  assert.match(
    SCRIPT,
    /const JOB_TASKS = \{\n\s+VOCABULARY: 'vocabulary',\n\s+SPLITS: 'splits',\n\s+ORDER: 'order',\n\s+APPLY: 'apply',\n\s*\};/,
    'the task names are contract with the job service'
  );
});

/* ── 10. the requests ─────────────────────────────────────────────────────── */

test('Every request goes to the route the page was built for', () => {
  [
    ["'/api/simplify/vocabulary'", 2],
    ["'/api/simplify/vocabulary/propose'", 1],
    ["'/api/simplify/proposals'", 1],
    ["'/api/simplify/proposals/run'", 1],
    ["'/api/simplify/apply'", 1],
  ].forEach(([needle, times]) => {
    assert.strictEqual(
      SCRIPT.split(needle).length - 1,
      times,
      `${needle} must be reached exactly ${times} time(s)`
    );
  });
  assert.ok(
    SCRIPT.includes("sendJson('PUT', '/api/simplify/vocabulary'"),
    'the vocabulary is saved with a PUT, it replaces what is there'
  );
  assert.ok(
    SCRIPT.includes(
      "'PATCH',\n      `/api/simplify/proposals/${encodeURIComponent(String(tagId))}`"
    ) || SCRIPT.includes("sendJson(\n      'PATCH',"),
    'an edit is a PATCH of one proposal'
  );
  // Every id that reaches a URL is encoded, however it got into the page.
  const urls = [
    ...SCRIPT.matchAll(/`\/api\/simplify\/[^`]*\$\{([^}]*)\}/g),
  ].map((match) => match[1].trim());
  urls.forEach((expression) => {
    assert.ok(
      expression.startsWith('encodeURIComponent('),
      `an id reaches a URL unencoded: ${expression}`
    );
  });

  // Nothing on this page starts by itself: every request that writes hangs
  // off a click.
  const init = functionBody('init');
  assert.ok(
    init.includes('loadVocabulary()') &&
      init.includes('loadProposals()') &&
      init.includes('reattachJob()'),
    'the page loads what is stored and attaches to what is running'
  );
  [
    'saveVocabulary',
    'proposeVocabulary',
    'proposeSplits',
    'applySelected',
  ].forEach((name) => {
    assert.ok(
      SCRIPT.includes(`addEventListener('click', ${name})`),
      `${name}() must be behind a button`
    );
  });
});

/* ── 11. the proposed order ───────────────────────────────────────────────── */

/**
 * The renderers of the order, taken out of the module the same way. The
 * constants that are plain numbers or that the scanner cannot read are handed
 * in as globals; everything else comes out of the file itself.
 */
function orderHelpers(names, globals = {}) {
  return helpers(names, {
    constants: [
      'GROUP_KIND_LABELS',
      'GROUP_KIND_TONES',
      'GROUP_KIND_ICONS',
      'STATUS_BADGES',
      'SOURCE_LABELS',
      'SOURCE_TONES',
      'DECISION_WORDS',
    ],
    globals: Object.assign({ esc: escForTest, MEMBERS_PER_PAGE: 50 }, globals),
  });
}

/** One group of the fixture the filter cases run on. */
function fixtureGroup(over) {
  return Object.assign(
    {
      key: 'type:Rechnung',
      kind: 'type',
      name: 'Rechnung',
      tags: 2,
      documents: 30,
      open: 2,
      accepted: 0,
      applied: 0,
      skipped: 0,
      members: [],
    },
    over
  );
}

function fixtureMember(over) {
  return Object.assign(
    {
      tagId: 9,
      tagName: 'Stromrechnung',
      documentCount: 12,
      action: 'split',
      typeName: 'Rechnung',
      topicNames: ['Strom'],
      mergeInto: null,
      source: 'rule',
      confidence: 'high',
      reason: 'compound of Rechnung and Strom',
      status: 'open',
    },
    over
  );
}

test('The view opens with the order, above the vocabulary and the table', () => {
  [
    'simOrder',
    'simOrderMeta',
    'simOrderSummary',
    'simOrderEmpty',
    'simOrderKeepVocabulary',
    'simOrderKeepWrap',
    'simOrderStats',
    'simStatGroupTypes',
    'simStatGroupTopics',
    'simStatGroupMerges',
    'simStatGroupDelete',
    'simStatGroupKeep',
    'simStatOrderAccepted',
    'simStatOrderApplied',
    'simView',
    'simGroupKind',
    'simGroupStatus',
    'simGroupSearch',
    'simGroups',
    'simGroupFilters',
    'simApplyAcceptedBtn',
    'simApplyAcceptedLabel',
    'simApplyResult',
    'simVocabularyBlock',
    'simReproposeBtn',
  ].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
    assert.ok(
      SCRIPT.includes(`'${id}'`) || SCRIPT.includes(`"${id}"`),
      `#${id} is in the view but the page script never reads it`
    );
  });

  // The order comes first, then the vocabulary, then the table of round 10.
  assert.ok(
    page.indexOf('id="simOrder"') < page.indexOf('id="simVocabularyBlock"'),
    'the order is what the page opens with'
  );
  assert.ok(
    page.indexOf('id="simVocabularyBlock"') < page.indexOf('id="simProposals"'),
    'the table is the detail view and comes last'
  );
  // Groups are the default; the table waits behind the segment.
  assert.match(
    page,
    /class="zr-module hidden" id="simProposals"/,
    'the table view must come up hidden'
  );
  assert.match(
    page,
    /data-view="groups" aria-selected="true"/,
    'Groups is the view the page opens in'
  );
  assert.match(
    page,
    /id="simApplyAcceptedBtn" type="button" disabled/,
    'nothing is accepted yet, so the button is dead'
  );
  // The block is a details, closed by the script once a vocabulary is saved.
  assert.match(
    page,
    /<details class="zr-module sim-vocab-module" id="simVocabularyBlock">/,
    'the vocabulary moved into a details block'
  );
  assert.ok(
    page.includes('Re-propose with this vocabulary'),
    'the block must offer the order again against the saved names'
  );
  assert.ok(
    page.includes(
      'The model reads every tag and every document type, proposes a vocabulary and sorts every tag into it. Nothing here runs on its own.'
    ),
    'the sentence over the order is contract'
  );
});

test('The order button is the model-backed one; without it comes the hint', () => {
  const offered = renderSync(
    'simplify.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  assert.ok(
    offered.includes('id="simOrderBtn"') &&
      offered.includes('Propose a new order'),
    'the primary button of the page is missing'
  );
  assert.match(
    offered,
    /id="simOrderIcon"[\s\S]{0,120}icons\.svg#i-wand/,
    'the model-backed button wears the wand'
  );
  assert.ok(
    !offered.includes('id="simOrderAiHint"'),
    'with a model there is nothing to explain'
  );

  // Without a model the page still works, and says what it can do.
  assert.ok(!page.includes('id="simOrderBtn"'), 'no model, no model button');
  assert.ok(
    page.includes(
      'The AI review is switched off in the settings; the page can only propose splits by rule from a saved vocabulary.'
    ),
    'the hint must be worded exactly that way'
  );
  // Everything that decides and applies is there either way.
  ['simGroups', 'simApplyAcceptedBtn', 'simReproposeBtn'].forEach((id) => {
    assert.ok(
      page.includes(`id="${id}"`),
      `#${id} must be there without the AI as well`
    );
  });
});

test('A group card says what it is, how big it is and what can be done', () => {
  const { htmlGroupCard } = orderHelpers([
    'num',
    'plural',
    'grouped',
    'htmlIconMarkup',
    'groupTitle',
    'groupCountsText',
    'htmlGroupStatusBadges',
    'memberOutcome',
    'htmlSourceBadge',
    'htmlMemberRow',
    'htmlGroupCard',
  ]);

  const card = htmlGroupCard(
    fixtureGroup({
      tags: 212,
      documents: 3410,
      open: 180,
      accepted: 30,
      applied: 2,
      members: [fixtureMember({})],
    }),
    {}
  );
  assert.ok(
    card.includes('data-group-key="type:Rechnung"'),
    'a card names the group it is'
  );
  assert.ok(card.includes('data-kind="type"'), 'and the kind it belongs to');
  assert.ok(
    card.includes('<span class="zr-badge zr-badge--brand">'),
    'a type group wears the brand tone'
  );
  assert.ok(card.includes('#i-file'), 'and the icon of a document type');
  assert.ok(card.includes('>type<'), 'the badge says what kind it is');
  assert.ok(card.includes('>Rechnung<'), 'the name belongs in the head');
  assert.ok(
    card.includes('212 tags · 3,410 documents'),
    `the counts are wrong: ${card}`
  );
  assert.ok(
    card.includes('>180 open<') &&
      card.includes('>30 accepted<') &&
      card.includes('>2 applied<'),
    'the status counts belong in the head'
  );
  assert.ok(
    !card.includes('skipped<'),
    'a count of zero is not worth a badge of its own'
  );
  ['sim-group-accept', 'sim-group-skip', 'sim-group-reopen'].forEach((cls) => {
    assert.ok(card.includes(cls), `${cls} is missing from the foot`);
  });
  assert.ok(
    /class="zr-btn sim-group-apply"(?!.{0,20}disabled)/.test(card),
    'with accepted members the apply must be alive'
  );
  assert.ok(
    card.includes('<summary class="sim-group__summary">Show 1 tag</summary>'),
    `the member list must be collapsed behind a summary: ${card}`
  );
  assert.ok(
    !card.includes('<details class="sim-group__members" open>'),
    'a card comes up closed'
  );
  assert.ok(
    htmlGroupCard(fixtureGroup({ members: [fixtureMember({})] }), {
      open: true,
    }).includes('<details class="sim-group__members" open>'),
    'a card the user opened stays open'
  );
});

test('Every kind of group reads as itself', () => {
  const { htmlGroupCard, groupTitle } = orderHelpers([
    'num',
    'plural',
    'grouped',
    'htmlIconMarkup',
    'groupTitle',
    'groupCountsText',
    'htmlGroupStatusBadges',
    'memberOutcome',
    'htmlSourceBadge',
    'htmlMemberRow',
    'htmlGroupCard',
  ]);

  assert.strictEqual(
    groupTitle({ kind: 'type', name: 'Rechnung' }),
    'Rechnung'
  );
  assert.strictEqual(groupTitle({ kind: 'topic', name: 'Strom' }), 'Strom');
  assert.strictEqual(groupTitle({ kind: 'merge', name: 'Amazon' }), '→ Amazon');
  assert.strictEqual(groupTitle({ kind: 'delete', name: null }), 'Delete');
  assert.strictEqual(
    groupTitle({ kind: 'keep', name: null }),
    'Keep as they are'
  );

  const of = (kind, over) =>
    htmlGroupCard(
      fixtureGroup(
        Object.assign(
          { key: kind, kind, name: kind === 'merge' ? 'Amazon' : null },
          over
        )
      ),
      {}
    );

  assert.ok(
    of('topic', { name: 'Strom' }).includes('zr-badge--info'),
    'a topic is information, not a claim'
  );
  const merge = of('merge', { accepted: 1 });
  assert.ok(merge.includes('zr-badge--warn') && merge.includes('#i-merge'));
  assert.ok(merge.includes('→ Amazon'), 'a merge group names its target');
  const remove = of('delete');
  assert.ok(remove.includes('zr-badge--danger') && remove.includes('#i-trash'));
  assert.ok(remove.includes('>Delete<'));

  // The tags nothing happens to: no accept, no apply, nothing to take out.
  const keep = of('keep', { members: [fixtureMember({ action: 'keep' })] });
  assert.ok(keep.includes('zr-badge--ok'), 'keep is settled, not a warning');
  assert.ok(keep.includes('Keep as they are'));
  assert.ok(
    !keep.includes('sim-group-accept'),
    'a keep group has nothing to accept'
  );
  assert.ok(!keep.includes('sim-group-apply'), 'and nothing to apply either');
  assert.ok(
    !keep.includes('sim-member-remove'),
    'there is nothing to take out of the tags that stay'
  );

  // Nothing accepted, nothing decided: the apply sleeps, reopen is not shown.
  const fresh = of('type', { name: 'Brief' });
  assert.ok(
    /class="zr-btn sim-group-apply" disabled/.test(fresh),
    'without accepted members the apply must be dead'
  );
  assert.ok(
    !fresh.includes('sim-group-reopen'),
    'nothing was decided, so there is nothing to reopen'
  );
  // Nothing open: accept and skip have nothing left to do.
  const done = of('type', { name: 'Brief', open: 0, accepted: 2 });
  assert.ok(
    /class="zr-btn zr-btn--primary sim-group-accept" disabled/.test(done),
    'every member is decided, so accept is dead'
  );
  assert.ok(done.includes('sim-group-reopen'), 'and reopen is offered');
});

test('A member row says what happens to the tag', () => {
  const { htmlMemberRow, memberOutcome } = orderHelpers([
    'num',
    'plural',
    'grouped',
    'htmlIconMarkup',
    'memberOutcome',
    'htmlSourceBadge',
    'htmlMemberRow',
  ]);

  assert.strictEqual(memberOutcome(fixtureMember({})), '→ Rechnung + Strom');
  assert.strictEqual(
    memberOutcome(fixtureMember({ topicNames: [] })),
    '→ Rechnung'
  );
  assert.strictEqual(
    memberOutcome(fixtureMember({ typeName: null })),
    '→ Strom'
  );
  assert.strictEqual(
    memberOutcome(
      fixtureMember({ typeName: null, topicNames: ['Strom', 'Auto'] })
    ),
    '→ Strom + Auto'
  );
  assert.strictEqual(
    memberOutcome(
      fixtureMember({ action: 'merge', mergeInto: 'Amazon', typeName: null })
    ),
    '→ merge into Amazon'
  );
  assert.strictEqual(
    memberOutcome(fixtureMember({ action: 'delete' })),
    'delete'
  );
  assert.strictEqual(memberOutcome(fixtureMember({ action: 'keep' })), 'keep');
  // A split that has nothing left to give is a keep, whatever it is called.
  assert.strictEqual(
    memberOutcome(fixtureMember({ typeName: null, topicNames: [] })),
    'keep'
  );

  const row = htmlMemberRow(fixtureGroup({}), fixtureMember({}));
  assert.ok(row.includes('data-tag-id="9"'), 'the row names its tag');
  assert.ok(row.includes('>Stromrechnung<'), 'and shows its name');
  assert.ok(row.includes('>12<'), 'and how many documents it carries');
  assert.ok(
    row.includes('<span class="zr-badge zr-badge--ok">rule</span>'),
    'the source badge is the one of round 10'
  );
  assert.ok(
    row.includes('compound of Rechnung and Strom'),
    'the reason belongs in the row'
  );
  assert.ok(
    row.includes('class="zr-btn zr-btn--ghost zr-btn--icon sim-member-remove"'),
    'every row carries the button that takes it out'
  );
  assert.ok(
    row.includes('title="Take this tag out of the group"'),
    'and that button says what it does'
  );
  assert.ok(row.includes('sim-member-skip'), 'and the per-tag skip');
  assert.ok(row.includes('>Skip<'), 'an open row is skipped');
  assert.ok(
    htmlMemberRow(fixtureGroup({}), fixtureMember({ status: 'skipped' })),
    'a skipped row can be reopened'
  );
  assert.ok(
    htmlMemberRow(
      fixtureGroup({}),
      fixtureMember({ status: 'skipped' })
    ).includes('>Reopen<'),
    'the same button reads the other way round'
  );
  // An applied row is history: nothing is decided on it any more.
  const applied = htmlMemberRow(
    fixtureGroup({}),
    fixtureMember({ status: 'applied' })
  );
  assert.ok(!applied.includes('sim-member-skip'));
  assert.ok(!applied.includes('sim-member-remove'));
  assert.ok(
    applied.includes('<span class="zr-badge zr-badge--ok">applied</span>')
  );
  assert.ok(
    htmlMemberRow(
      fixtureGroup({}),
      fixtureMember({ status: 'accepted' })
    ).includes('<span class="zr-badge zr-badge--info">accepted</span>'),
    'accepted is a status of its own since round 12'
  );

  // Names are the user's and the model's, everywhere they land.
  const nasty = htmlMemberRow(
    fixtureGroup({}),
    fixtureMember({
      tagName: '<img src=x>',
      mergeInto: '<b>x</b>',
      action: 'merge',
      reason: '<script>alert(1)</script>',
    })
  );
  assert.ok(
    !nasty.includes('<img'),
    'a tag name must never reach the page as tags'
  );
  assert.ok(!nasty.includes('<script>'), 'and neither must a reason');
  assert.ok(nasty.includes('&lt;img src=x&gt;'));
});

test('A card renders 50 members and offers the rest', () => {
  const { htmlGroupCard } = orderHelpers([
    'num',
    'plural',
    'grouped',
    'htmlIconMarkup',
    'groupTitle',
    'groupCountsText',
    'htmlGroupStatusBadges',
    'memberOutcome',
    'htmlSourceBadge',
    'htmlMemberRow',
    'htmlGroupCard',
  ]);

  const members = Array.from({ length: 212 }, (unused, index) =>
    fixtureMember({ tagId: index + 1, tagName: `Tag ${index + 1}` })
  );
  const card = htmlGroupCard(fixtureGroup({ tags: 212, members }), {});
  assert.strictEqual(
    (card.match(/class="sim-member"/g) || []).length,
    50,
    'a card must not render two hundred rows before it is asked to'
  );
  assert.ok(
    card.includes('>Show 162 more<'),
    `the rest must be offered by number: ${card.slice(0, 200)}`
  );
  assert.ok(
    card.includes('sim-group__more'),
    'and behind the class that appends it'
  );

  const all = htmlGroupCard(fixtureGroup({ tags: 212, members }), {
    shown: 212,
  });
  assert.strictEqual((all.match(/class="sim-member"/g) || []).length, 212);
  assert.ok(!all.includes('sim-group__more'), 'nothing is left to show');

  const small = htmlGroupCard(
    fixtureGroup({ tags: 2, members: members.slice(0, 2) }),
    {}
  );
  assert.ok(!small.includes('sim-group__more'), 'two rows need no button');

  // The page appends by remembering the number, not by fetching again.
  const wiring = functionBody('initOrder');
  assert.ok(
    wiring.includes('groupShown.set('),
    'the "show more" click must raise what the card renders'
  );
  assert.ok(
    wiring.includes('renderGroupCard(group.key, group)'),
    'and redraw that one card'
  );
});

test('The three filters over the cards, on a fixture', () => {
  const groups = [
    fixtureGroup({ key: 'type:Rechnung', kind: 'type', name: 'Rechnung' }),
    fixtureGroup({
      key: 'topic:Strom',
      kind: 'topic',
      name: 'Strom',
      open: 0,
      accepted: 3,
      members: [fixtureMember({ tagName: 'Stromrechnung' })],
    }),
    fixtureGroup({
      key: 'merge:Amazon',
      kind: 'merge',
      name: 'Amazon',
      open: 0,
      applied: 4,
      members: [fixtureMember({ tagName: 'amazon' })],
    }),
    fixtureGroup({ key: 'keep', kind: 'keep', name: null, open: 7 }),
  ];
  const visible = (kind, status, search) =>
    helpers(['num', 'groupTitle', 'matchesFilters', 'visibleGroups'], {
      globals: {
        groups,
        groupKind: kind,
        groupStatus: status,
        groupSearch: search,
      },
    })
      .visibleGroups()
      .map((group) => group.key);

  assert.deepStrictEqual(
    visible('all', 'all', ''),
    ['type:Rechnung', 'topic:Strom', 'merge:Amazon', 'keep'],
    'All over All leaves everything'
  );
  assert.deepStrictEqual(
    visible('all', 'open', ''),
    ['type:Rechnung', 'keep'],
    'Open means "has an open member", not "is untouched"'
  );
  assert.deepStrictEqual(visible('all', 'accepted', ''), ['topic:Strom']);
  assert.deepStrictEqual(visible('all', 'applied', ''), ['merge:Amazon']);
  assert.deepStrictEqual(visible('all', 'skipped', ''), []);
  assert.deepStrictEqual(visible('topic', 'all', ''), ['topic:Strom']);
  assert.deepStrictEqual(visible('keep', 'all', ''), ['keep']);
  // The search reads the group's name and the names of its members.
  assert.deepStrictEqual(visible('all', 'all', 'rechnung'), [
    'type:Rechnung',
    'topic:Strom',
  ]);
  assert.deepStrictEqual(visible('all', 'all', 'AMAZON'), ['merge:Amazon']);
  assert.deepStrictEqual(visible('all', 'all', 'keep as'), ['keep']);
  assert.deepStrictEqual(visible('all', 'all', 'zzz'), []);
});

test('The tiles and the summary count every tag once', () => {
  const { memberTotals, orderSummaryText } = helpers(
    ['num', 'plural', 'memberTotals', 'orderSummaryText'],
    {}
  );

  // A tag with a type and two topics is a member of three groups and stays
  // one tag.
  const groups = [
    {
      kind: 'type',
      members: [
        fixtureMember({ tagId: 1, status: 'accepted' }),
        fixtureMember({ tagId: 2 }),
      ],
    },
    {
      kind: 'topic',
      members: [fixtureMember({ tagId: 1, status: 'accepted' })],
    },
    {
      kind: 'merge',
      members: [
        fixtureMember({ tagId: 3, action: 'merge', status: 'applied' }),
      ],
    },
    {
      kind: 'delete',
      members: [fixtureMember({ tagId: 4, action: 'delete' })],
    },
    { kind: 'keep', members: [fixtureMember({ tagId: 5, action: 'keep' })] },
  ];
  const totals = memberTotals(groups);
  assert.strictEqual(totals.tags, 5, 'a tag in three groups is one tag');
  assert.strictEqual(totals.split, 2);
  assert.strictEqual(totals.merge, 1);
  assert.strictEqual(totals.delete, 1);
  assert.strictEqual(totals.keep, 1);
  assert.strictEqual(totals.accepted, 1);
  assert.strictEqual(totals.applied, 1);
  assert.strictEqual(totals.open, 3);

  const accepted = memberTotals(groups, 'accepted');
  assert.strictEqual(accepted.tags, 1, 'only what is accepted counts');
  assert.strictEqual(accepted.split, 1);
  assert.strictEqual(memberTotals([], 'accepted').tags, 0);
  assert.strictEqual(memberTotals(null).tags, 0);

  // The one line a run leaves behind, word for word.
  assert.strictEqual(
    orderSummaryText(
      { byRule: 640, byModel: 660, requests: 14 },
      {
        tags: 1300,
        split: 812,
        merge: 94,
        keep: 371,
        delete: 23,
      }
    ),
    '1300 tags: 812 split, 94 merge, 371 keep, 23 delete · 640 by rule, 660 by the model · 14 requests'
  );
  assert.ok(
    orderSummaryText({ requests: 1, stopped: true }, { tags: 1 }).endsWith(
      '1 request · stopped'
    ),
    'a stopped run says so at the end'
  );
});

test('Every apply asks with the numbers of what it is about to do', () => {
  const { groupApplyConfirmText, applyAllConfirmText } = helpers(
    [
      'num',
      'plural',
      'groupTitle',
      'groupConfirmName',
      'groupApplyConfirmText',
      'applyAllConfirmText',
    ],
    {}
  );

  assert.strictEqual(
    groupApplyConfirmText({ kind: 'type', name: 'Rechnung', accepted: 30 }),
    'Apply Rechnung? 30 accepted tags: their documents get the document type Rechnung and the topics of each tag; the tags are deleted. You can undo each one from the log on the Duplicates page.',
    'the wording of the confirmation is contract'
  );
  assert.ok(
    groupApplyConfirmText({
      kind: 'topic',
      name: 'Strom',
      accepted: 1,
    }).startsWith('Apply Strom? 1 accepted tag: '),
    'one tag is one tag'
  );
  const merge = groupApplyConfirmText({
    kind: 'merge',
    name: 'Amazon',
    accepted: 4,
  });
  assert.ok(
    merge.startsWith('Apply merge into Amazon? 4 accepted tags: '),
    merge
  );
  assert.ok(
    merge.includes('their documents merge into Amazon'),
    'a merge group says where the documents go'
  );
  const remove = groupApplyConfirmText({
    kind: 'delete',
    name: null,
    accepted: 5,
  });
  assert.ok(
    remove.startsWith('Apply the deletions? 5 accepted tags: '),
    remove
  );
  assert.ok(
    remove.includes('the tags are deleted from their documents'),
    'a delete group says what it takes away'
  );
  [merge, remove].forEach((text) => {
    assert.ok(
      text.endsWith(
        'You can undo each one from the log on the Duplicates page.'
      ),
      'every apply promises the undo'
    );
  });

  assert.strictEqual(
    applyAllConfirmText({ tags: 42, split: 30, merge: 8, delete: 4, keep: 0 }),
    'Apply everything accepted? 42 tags: 30 are split into a document type and topics, 8 merge into another tag, 4 are deleted from their documents. You can undo each one from the log on the Duplicates page.'
  );
  const one = applyAllConfirmText({ tags: 1, split: 1, merge: 0, delete: 0 });
  assert.ok(
    one.startsWith('Apply everything accepted? 1 tag: 1 is split'),
    one
  );
  assert.ok(
    !one.includes('merge into another tag'),
    'an action nothing is accepted for is left out'
  );

  // Both dialogs are the kernel's, and both are decisions.
  const group = functionBody('applyGroup');
  assert.ok(
    group.includes('confirmDialog({') && group.includes("tone: 'danger'"),
    'an apply deletes tags and asks like every other destructive step'
  );
  assert.ok(group.includes('groupApplyConfirmText(group)'));
  const all = functionBody('applyAllAccepted');
  assert.ok(all.includes('applyAllConfirmText(totals)'));
  assert.ok(
    all.includes("memberTotals(groups, 'accepted')"),
    'the totals come from the groups, not from a guess'
  );
});

test('An apply leaves a line, and names every tag that failed', () => {
  const { applyResultText, htmlApplyResultBlock } = helpers(
    ['applyResultText', 'htmlApplyResultBlock'],
    { globals: { esc: escForTest } }
  );

  assert.strictEqual(
    applyResultText({
      applied: [
        { tagId: 1, action: 'split' },
        { tagId: 2, action: 'split' },
        { tagId: 3, action: 'delete' },
      ],
      merged: [{ tagId: 4 }],
      failed: [{ tagId: 5 }, { tagId: 6 }],
    }),
    '2 split, 1 merged, 1 deleted, 2 failed'
  );
  assert.strictEqual(
    applyResultText({ applied: [], merged: [], failed: [] }),
    '0 split, 0 merged, 0 deleted',
    'a run without failures does not say "0 failed"'
  );
  assert.strictEqual(
    applyResultText({}),
    '0 split, 0 merged, 0 deleted',
    'a result the page cannot read is not a crash'
  );

  const block = htmlApplyResultBlock(
    {
      applied: [{ tagId: 1, action: 'split' }],
      merged: [],
      failed: [
        { tagId: 2, tagName: '<b>Autorechnung</b>', error: 'Tag is gone' },
      ],
    },
    false
  );
  assert.ok(block.includes('zr-alert--warn'), 'a failure is a warning');
  assert.ok(block.includes('1 split, 0 merged, 0 deleted, 1 failed'));
  assert.ok(
    block.includes('sim-apply-result__failures'),
    'the failures are listed under the line'
  );
  assert.ok(
    block.includes('&lt;b&gt;Autorechnung&lt;/b&gt;: Tag is gone'),
    'each failure names its tag and its error, escaped'
  );
  assert.ok(!block.includes('<b>'), 'a tag name is never markup');

  const clean = htmlApplyResultBlock(
    { applied: [], merged: [], failed: [] },
    false
  );
  assert.ok(clean.includes('zr-alert--ok'), 'a clean run is a good one');
  assert.ok(!clean.includes('sim-apply-result__failures'));

  const stopped = htmlApplyResultBlock({ applied: [], merged: [] }, true);
  assert.ok(
    stopped.includes(
      'Stopped; everything that was not applied stays accepted.'
    ),
    'a stop must say what happened to the rest'
  );
});

test('A removal says what it did to the tag', () => {
  const { removeMemberText } = helpers(['removeMemberText'], {});

  assert.strictEqual(
    removeMemberText(
      { kind: 'type', name: 'Rechnung' },
      { tagName: 'Stromrechnung', action: 'split', topicNames: ['Strom'] }
    ),
    'Stromrechnung keeps its topics, loses the type'
  );
  assert.strictEqual(
    removeMemberText(
      { kind: 'topic', name: 'Strom' },
      { tagName: 'Stromrechnung', action: 'split', typeName: 'Rechnung' }
    ),
    'Stromrechnung loses the topic Strom'
  );
  // Nothing left to split, nothing to merge into, nothing to delete: it stays.
  assert.strictEqual(
    removeMemberText(
      { kind: 'type', name: 'Rechnung' },
      { tagName: 'Stromrechnung', action: 'keep' }
    ),
    'Stromrechnung is kept as it is'
  );
  assert.strictEqual(
    removeMemberText(
      { kind: 'merge', name: 'Amazon' },
      { tagName: 'amazon', action: 'keep' }
    ),
    'amazon is kept as it is'
  );

  // No dialog: a removal is one tag out of one group and is undone by hand.
  const remove = functionBody('removeGroupMember');
  assert.ok(
    !remove.includes('confirmDialog'),
    'taking one tag out of a group asks nothing'
  );
  assert.ok(
    remove.includes('removeMemberText(group, payload.data || {})'),
    'the toast is built from what the route answered'
  );
  assert.ok(
    remove.includes('await loadGroups()'),
    'a tag sits in up to three groups, so the list is read again'
  );
});

test('A decision reaches the route and redraws the one card', () => {
  const decide = functionBody('decideGroup');
  assert.ok(
    decide.includes(
      '`/api/simplify/groups/${encodeURIComponent(String(group.key))}/decision`'
    ),
    'a group key carries a name and must be encoded'
  );
  assert.ok(
    decide.includes('{ decision }'),
    'the body is the decision, nothing else'
  );
  assert.ok(
    decide.includes('renderGroupCard(group.key, data.group || null)'),
    'the card is redrawn from what came back'
  );
  assert.match(
    SCRIPT,
    /const DECISION_WORDS = \{\n\s+accept: 'accepted',\n\s+skip: 'skipped',\n\s+reopen: 'reopened',\n\s*\};/,
    'the toast says the decision in the past tense'
  );

  // A group that comes back null is gone from the page.
  const render = functionBody('renderGroupCard');
  assert.ok(
    render.includes('if (!group) {') && render.includes('groups.splice(at, 1)'),
    'a group the route no longer knows disappears'
  );
  assert.ok(
    render.includes('node.outerHTML = htmlGroupCard(group, cardState(group))'),
    'and everything else is redrawn in place'
  );
});

test('The order and the apply run as jobs of the one job service', () => {
  const run = functionBody('runOrderJob');
  assert.ok(
    run.includes("startJob('/api/simplify/order/propose'"),
    'the order is one job'
  );
  assert.ok(
    run.includes("vocabulary: mode === 'keep' ? 'keep' : 'propose'"),
    'and it is told whether to propose a vocabulary or keep the saved one'
  );
  assert.ok(
    run.includes('await followJob(job)') &&
      run.includes('await loadGroups()') &&
      run.includes('renderOrderSummary()'),
    'a finished run reloads the groups and leaves its line'
  );
  assert.ok(
    functionBody('proposeOrder').includes('el.keepVocabulary.checked === true'),
    'the checkbox decides what the button asks for'
  );
  assert.ok(
    functionBody('repropose').includes("runOrderJob('keep')"),
    'the vocabulary block always re-proposes against the saved names'
  );

  const apply = functionBody('applyOrder');
  assert.ok(
    apply.includes(
      "startJob(\n      '/api/simplify/order/apply',\n      groupKey ? { groupKey } : {}\n    )"
    ) || apply.includes("'/api/simplify/order/apply'"),
    'the apply is a job too'
  );
  assert.ok(
    apply.includes('groupKey ? { groupKey } : {}'),
    'one group, or everything that is accepted'
  );
  assert.ok(
    apply.includes('htmlApplyResultBlock('),
    'and it leaves its result on the page'
  );
  assert.ok(
    apply.includes('await loadDocumentTypes()'),
    'an apply creates document types, so the picker is read again'
  );

  // Nothing on this page starts by itself.
  ['proposeOrder', 'repropose', 'applyAllAccepted'].forEach((name) => {
    assert.ok(
      SCRIPT.includes(`addEventListener('click', ${name})`),
      `${name}() must be behind a button`
    );
  });
});

test('The saved vocabulary decides what the order section offers', () => {
  const state = functionBody('renderVocabularyState');
  assert.ok(
    state.includes('el.vocabularyBlock.open = !vocabularySaved'),
    'the block is open exactly while there is nothing in it'
  );
  assert.ok(
    state.includes(
      "el.reproposeBtn.classList.toggle('hidden', !vocabularySaved)"
    ),
    'there is nothing to re-propose against without a vocabulary'
  );
  assert.ok(
    state.includes("String(row.source || '') === 'user'"),
    'a vocabulary the user wrote is one they want kept'
  );
  assert.ok(
    state.includes('el.orderBtn === null'),
    'without the model button the tick has nothing to belong to'
  );
  assert.ok(
    functionBody('readVocabularyPayload').includes(
      'renderVocabularyState(true)'
    ),
    'a load and a save are the two moments the tick is set'
  );
});

test('The table stays as the detail view, with the action in front', () => {
  const { actionLabel } = helpers(['actionLabel'], {});
  assert.strictEqual(actionLabel({ action: 'split' }), 'split');
  assert.strictEqual(actionLabel({ action: 'keep' }), 'keep');
  assert.strictEqual(actionLabel({ action: 'delete' }), 'delete');
  assert.strictEqual(
    actionLabel({ action: 'merge', mergeInto: 'Amazon' }),
    'merge → Amazon'
  );
  assert.strictEqual(actionLabel({ action: 'merge' }), 'merge');
  assert.strictEqual(actionLabel({}), 'split', 'a row of round 10 is a split');

  // The column is the first one, in the head and in the row.
  assert.match(
    page,
    /<th class="sim-proposals__actioncol">Action<\/th>\s*\n\s*<th class="sim-proposals__pickcol">Apply<\/th>/,
    'the action comes before the checkbox'
  );
  assert.ok(
    SCRIPT.includes(
      '<td data-label="Action" class="sim-proposals__actioncol">'
    ),
    'and the row carries the same cell'
  );
  assert.ok(
    SCRIPT.includes('htmlEmptyRow(9,'),
    'nine columns, so the empty row spans nine'
  );

  // The segment swaps the two, and the table only lives behind it.
  const setter = functionBody('renderViewState');
  assert.ok(
    setter.includes("el.groups.classList.toggle('hidden', table)") &&
      setter.includes("el.proposals.classList.toggle('hidden', !table)"),
    'one view at a time'
  );
  assert.ok(
    setter.includes('groups.length === 0'),
    'three filters over nothing are noise'
  );
  assert.ok(
    functionBody('init').includes("setView('groups')"),
    'the page opens on the groups'
  );
  // "Propose splits" of round 10 stays where the table is.
  assert.ok(
    page.indexOf('id="simProposeSplitsBtn"') >
      page.indexOf('id="simProposals"'),
    'the old button belongs to the table view'
  );
});

test('The order has an empty state for nothing and one for no match', () => {
  assert.match(
    SCRIPT,
    /const ORDER_EMPTY =\n\s+'No order proposed yet\. Propose one: the model reads every tag and every document type\.';/,
    'the empty order must say exactly that'
  );
  assert.match(
    SCRIPT,
    /const GROUPS_EMPTY = 'No groups match\.';/,
    'and a filter that matches nothing must say exactly that'
  );
  const empty = functionBody('renderOrderEmpty');
  assert.ok(
    empty.includes('groups.length === 0 ? ORDER_EMPTY : GROUPS_EMPTY'),
    'the two states are told apart by what is there, not by what is shown'
  );
  assert.ok(
    empty.includes("view === 'groups'"),
    'the table view has an empty state of its own'
  );
  assert.ok(
    empty.includes('el.orderEmpty.textContent'),
    'an empty state is text, never markup'
  );
  assert.match(
    page,
    /class="zr-empty sim-order__empty hidden" id="simOrderEmpty"/,
    'the empty state comes up hidden and is the framework one'
  );
});

test('The group cards and the order keep the stylesheet to itself', () => {
  [
    '.sim-groups',
    '.sim-group__head',
    '.sim-group__summary',
    '.sim-group__foot',
    '.sim-member__actions',
    '.sim-order__head',
    '.sim-apply-result__failures',
    '.sim-view',
  ].forEach((selector) => {
    assert.ok(
      CSS.includes(`${selector} {`) || CSS.includes(`${selector},`),
      `${selector} has no rule of its own`
    );
  });
  // Still one block, still only this page's classes (checked in full above).
  assert.strictEqual(
    (CSS.match(/@layer [a-z]+ \{/g) || []).length,
    1,
    'stylelint scopes its duplicate checks per layer block, so keep one'
  );
  // A card at 390px: the foot's buttons take a row each rather than four
  // squeezed onto one.
  assert.match(
    CSS,
    /@media \(max-width: 720px\) \{[\s\S]*?\.sim-group__foot \.zr-btn \{\n\s+flex: 1;/,
    'the buttons of a card do not work at phone width'
  );
  assert.match(
    CSS,
    /\.sim-filters__field--wide \.zr-segment \{\n\s+flex-wrap: wrap;/,
    'six filter choices do not fit on one phone line'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
