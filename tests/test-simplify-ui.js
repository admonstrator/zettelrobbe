/**
 * Test: simplify-ui
 *
 * Static checks for the Simplify tags page: the view, its navigation entry,
 * its stylesheet and its page script. The page talks to a dozen endpoints and
 * is reviewed in a browser; what is checked here is everything that can drift
 * without anyone noticing. The assistant on top, the sheet, the run meter and
 * the stack are covered by tests/test-simplify-assistant-ui.js; this file
 * keeps the toolset under the assistant and the plumbing under both.
 *
 *  1. views/simplify.ejs renders through the real shell and carries the ids
 *     the page script and the route agree on
 *  2. nav.ejs lists /simplify right after /duplicates and leaves the phone tab
 *     bar alone; icons.svg carries the i-split symbol it references
 *  3. head-start.ejs links the page stylesheet, and the stylesheet is one
 *     @layer pages block of sim- and zr- classes
 *  4. public/js/simplify.js escapes everything it writes into innerHTML and
 *     carries no inline event handler
 *  5. the vocabulary chips, the document types Paperless-ngx already has, the
 *     picker, the offer to take them over and the hint under a typed topic
 *  6. the proposal row: the select of document types, the topic chips, the
 *     source badge, the overwrite switch with the number that keeps its type
 *  7. the dialog of the table's apply, with the numbers the impact route gives
 *  8. the empty states, word for word
 *  9. the progress panel: the helpers that word its numbers, the event stream
 *     with its polling fallback and the attach after a reload
 * 10. the requests the page sends, and the one route it sends each on
 * 11. the order as groups: the ids, the group card for every kind with its
 *     tick, the member row for every action with its tick, the cut at 50
 *     members, the three filters, the summary line, the dialogs, the result
 *     of an apply, the removal of one member, the jobs, the vocabulary block,
 *     the table as the other view
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
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
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

/* The shared sheet module, for the token counts the page now words through
   it. Loaded the way tests/test-review-sheet.js loads it. */
function loadSheetModule(names) {
  const source = read('public', 'js', 'modules', 'review-sheet.js')
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|function) /gm, '$1 ');
  return new Function(
    'esc',
    'CSS',
    `${source}\nreturn { ${names.join(', ')} };`
  )((value) => String(value), { escape: (value) => String(value) });
}

const SHEET = loadSheetModule(['formatTokens', 'roughTime', 'shares']);

/* -- 1. the view --------------------------------------------------------- */

let page = '';

test('views/simplify.ejs renders through the real shell partials', () => {
  page = renderSync('simplify.ejs', LOCALS);
  assert.ok(page.includes('<!DOCTYPE html>'), 'no document was produced');
  assert.ok(
    page.includes('id="simAssist" data-assist'),
    'the assistant the script fills is missing'
  );
  assert.ok(
    page.includes('<script type="module" src="/js/simplify.js">'),
    'the page script must be loaded as a module, like every other page'
  );
});

test('The view carries the ids the page script and the route agree on', () => {
  // The section anchors are the page's structure; nothing in the script reads
  // them, so they are asserted on their own.
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
  // Apply and Skip are dead until something is picked.
  assert.match(page, /id="simApplyBtn" type="button" disabled/);
  assert.match(page, /id="simSkipBtn" type="button" disabled/);
  // Without a saved vocabulary there is nothing to decompose against.
  assert.match(
    page,
    /id="simProposeSplitsBtn" type="button" disabled/,
    'the split run must wait for a vocabulary'
  );
  assert.ok(
    page.includes('>No vocabulary saved<'),
    'the line beside the dead button says why, as a fact'
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

test('The model proposal is rendered only when the model is available', () => {
  const offered = renderSync(
    'simplify.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  ['simProposeVocabularyBtn', 'simProposeVocabularyIcon'].forEach((id) => {
    assert.ok(
      offered.includes(`id="${id}"`),
      `#${id} is missing although the model is available`
    );
  });
  assert.ok(
    offered.includes('Propose from tags'),
    'the button is not labelled'
  );
  assert.match(
    offered,
    /id="simProposeVocabularyIcon"[\s\S]{0,120}icons\.svg#i-wand/,
    'the model-backed button has no i-wand icon'
  );

  // The default: none of it, and the page is whole without it: the rule
  // pass, every edit and the apply work with no model at all.
  ['simProposeVocabularyBtn', 'Propose from tags'].forEach((needle) => {
    assert.ok(
      !page.includes(needle),
      `"${needle}" must not be rendered without aiReviewEnabled`
    );
  });
  ['simSaveVocabularyBtn', 'simProposeSplitsBtn', 'simApplyBtn'].forEach(
    (id) => {
      assert.ok(
        page.includes(`id="${id}"`),
        `#${id} must be there without the model as well`
      );
    }
  );
});

/* -- 2. the navigation and the icon -------------------------------------- */

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

test('icons.svg carries every symbol the page references', () => {
  const icons = read('public', 'icons.svg');
  const symbol = icons.slice(
    icons.indexOf('<symbol id="i-split"'),
    icons.indexOf('</symbol>', icons.indexOf('<symbol id="i-split"'))
  );
  assert.ok(symbol, 'the i-split symbol is missing');
  assert.ok(
    symbol.includes('viewBox="0 0 24 24"'),
    'the icon set is a 24 box; a symbol outside it renders at the wrong size'
  );
  assert.ok(
    !/fill="/.test(symbol),
    'the icon set is stroke based and inherits currentColor'
  );
  // Every icon the view or the script names must be in the set.
  const named = new Set([
    ...[...page.matchAll(/icons\.svg#(i-[a-z0-9-]+)/g)].map((m) => m[1]),
    ...[...SCRIPT.matchAll(/'(i-[a-z0-9-]+)'/g)].map((m) => m[1]),
  ]);
  const missing = [...named].filter((name) => !icons.includes(`id="${name}"`));
  assert.deepStrictEqual(missing, [], `missing symbols: ${missing.join(', ')}`);
});

/* -- 3. the stylesheet --------------------------------------------------- */

test('head-start.ejs links the page stylesheet', () => {
  const head = read('views', 'partials', 'shell', 'head-start.ejs');
  assert.ok(
    head.includes('<link rel="stylesheet" href="/css/pages/simplify.css">'),
    'the page stylesheet is never loaded'
  );
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

test('simplify.css is one @layer pages block of sim and zr classes', () => {
  assert.strictEqual(
    (CSS.match(/@layer [a-z]+ \{/g) || []).length,
    1,
    'stylelint scopes its duplicate checks per layer block, so keep one'
  );
  assert.match(CSS, /@layer pages \{/, 'the page file belongs in layer pages');
  const classes = [
    ...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g),
  ].map((match) => match[1]);
  const foreign = [...new Set(classes)].filter(
    (name) => !name.startsWith('sim-') && !name.startsWith('zr-')
  );
  assert.deepStrictEqual(
    foreign,
    [],
    `the page stylesheet may only style its own classes: ${foreign.join(', ')}`
  );
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
    'the sliding band ignores a reduced motion preference'
  );
});

/* -- 4. the escaping rule ------------------------------------------------ */

/**
 * Walks the source and returns every top level template literal with the text
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
    `only ${markup.length} markup templates found; the scanner lost track`
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

test('The page script imports the shared escaper, the kernel and the round modules', () => {
  assert.match(
    SCRIPT,
    /import \{ escapeHtml as esc \} from '\/js\/modules\/text-utils\.js';/,
    'the escaper is shared; a hand written one leaves quotes intact'
  );
  assert.match(
    SCRIPT,
    /import \{ toast, confirmDialog \} from '\/js\/zr\.js';/,
    'toasts and dialogs come from the kernel, never from a second host'
  );
  assert.match(
    SCRIPT,
    /from '\/js\/modules\/review-sheet\.js';/,
    'the sheet is the shared one'
  );
  assert.ok(
    !SCRIPT.includes('review-mode.js'),
    'the page has one mode and imports no switch'
  );
  assert.match(
    SCRIPT,
    /\} from '\/js\/modules\/review-assist\.js';/,
    'the assistant is the shared one'
  );
  assert.match(
    SCRIPT,
    /import \{ SIMPLIFY_GUIDE \} from '\/js\/modules\/review-guide\.js';/,
    'the words of the assistant come from the guide'
  );
  // The page words its tokens and its times the way the sheet does: one
  // formatter each, imported, never a second copy.
  assert.ok(
    !/^function (formatTokens|roughTime)\(/m.test(SCRIPT),
    'a local formatTokens or roughTime would say the same number differently'
  );
});

/* -- the helpers, taken out of the module -------------------------------- */

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
 * decides is written as a pure function in the first place.
 */
function helpers(names, extra = {}) {
  const constants = (extra.constants || []).map(constantSource).join('\n');
  const source = names.map(functionSource).join('\n');
  const globals = Object.assign(
    { formatTokens: SHEET.formatTokens, roughTime: SHEET.roughTime },
    extra.globals || {}
  );
  const keys = Object.keys(globals);
  return new Function(
    ...keys,
    `${constants}\n${source}\nreturn { ${names.join(', ')} };`
  )(...keys.map((key) => globals[key]));
}

/* -- 5. the vocabulary --------------------------------------------------- */

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
  assert.ok(chips.includes('data-dimension="type"'));
  assert.ok(chips.includes('data-name="Brief"'));
  assert.ok(
    chips.includes('aria-label="Remove Brief"'),
    'the remove button is an icon and needs a label'
  );
  assert.ok(chips.includes('/icons.svg#i-x'), 'the icon set, not a character');

  const nasty = htmlVocabularyChips(['<b>Rechnung</b>'], 'type');
  assert.ok(nasty.includes('&lt;b&gt;Rechnung&lt;/b&gt;'));
  assert.ok(!nasty.includes('<b>'), 'a name must never reach the page as tags');

  const empty = htmlVocabularyChips([], 'topic');
  assert.ok(
    empty.includes('sim-vocab__empty') && empty.includes('None yet'),
    'an empty list says so rather than collapsing'
  );
  assert.strictEqual(htmlVocabularyChips(null, 'topic'), empty);
});

test('Adding and removing a vocabulary name keeps the order and drops repeats', () => {
  const add = functionBody('addVocabularyName');
  assert.ok(add.includes('entry.toLowerCase() === name.toLowerCase()'));
  assert.ok(add.includes('list.push(name)'), 'a new name goes to the end');
  assert.ok(/if \(name === ''\) return false;/.test(add));

  const init = functionBody('initVocabulary');
  assert.ok(init.includes("event.key !== 'Enter'"), 'Enter adds a name');
  assert.ok(init.includes("input.value = ''"), 'the input clears itself');
  assert.ok(
    init.includes(".closest('.sim-chip__remove')"),
    'the remove button is handled by delegation'
  );
});

test('A model proposal keeps what was already there', () => {
  const { mergeProposedVocabulary } = helpers(['mergeProposedVocabulary'], {});
  assert.deepStrictEqual(
    mergeProposedVocabulary(['Brief'], ['Rechnung', 'Brief', 'Vertrag']),
    ['Brief', 'Rechnung', 'Vertrag']
  );
  assert.deepStrictEqual(mergeProposedVocabulary(['Brief'], ['  brief  ']), [
    'Brief',
  ]);
  assert.deepStrictEqual(mergeProposedVocabulary(['Brief'], null), ['Brief']);
  assert.deepStrictEqual(mergeProposedVocabulary([], ['Rechnung', '', '   ']), [
    'Rechnung',
  ]);

  assert.match(
    SCRIPT,
    /const PROPOSAL_NOTICE = 'Proposed by the model, not saved yet';/
  );
  const propose = functionBody('proposeVocabulary');
  assert.ok(propose.includes('PROPOSAL_NOTICE'), 'marked as unsaved');
  assert.ok(!propose.includes("sendJson('PUT'"), 'a proposal saves nothing');
  assert.ok(
    functionBody('saveVocabulary').includes(
      "sendJson('PUT', '/api/simplify/vocabulary'"
    ),
    'the save button is the one thing that stores a vocabulary'
  );
});

const PICKER = read('public', 'js', 'modules', 'picker.js');

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
  assert.match(page, /id="simTypeInput"[\s\S]{0,400}?role="combobox"/);
  assert.match(
    page,
    /id="simTypeInput"[\s\S]{0,400}?aria-controls="simTypeList"/
  );
  assert.match(page, /id="simTypeInput"[\s\S]{0,400}?aria-expanded="false"/);
  assert.match(page, /class="zr-picker" id="simTypePicker"/);
  assert.match(
    page,
    /class="zr-picker__list hidden" id="simTypeList" role="listbox"/
  );
  assert.ok(
    page.includes('placeholder="Search or add a document type"'),
    'the placeholder must say that a new name is allowed too'
  );
  assert.match(
    page,
    /id="simTypesReloadBtn"[^>]*aria-label="Reload document types"/
  );
  assert.match(
    page,
    /class="zr-alert zr-alert--info sim-adopt hidden" id="simAdoptTypes"/
  );
  assert.match(
    page,
    /class="zr-sm zr-faint sim-hint hidden" id="simTopicHint"/
  );
  assert.match(page, /id="simTopicHint"[^>]*aria-live="polite"/);
  assert.match(
    page,
    /class="zr-module sim-vocab-module" id="simVocabularyBlock"/,
    'the vocabulary section needs the class that lets the dropdown out'
  );
});

test('A row of the picker wears the badge the page asked for', () => {
  const { htmlPickerRow } = pickerHelpers(['htmlPickerRow'], {
    esc: escForTest,
  });
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
    marked.includes('<span class="zr-badge zr-badge--ok">in vocabulary</span>')
  );
  assert.match(
    SCRIPT,
    /import \{ createPicker \} from '\/js\/modules\/picker\.js';/,
    'the page must use the shared picker, not a copy'
  );
  assert.match(
    SCRIPT,
    /const IN_VOCABULARY_BADGE = \{ text: 'in vocabulary', tone: 'ok' \};/
  );
});

test('The offer to take over the existing types names their number', () => {
  const { htmlAdoptTypes } = helpers(['num', 'plural', 'htmlAdoptTypes'], {
    globals: { esc: escForTest },
  });
  const many = htmlAdoptTypes(4);
  assert.ok(
    many.includes('>4 document types in Paperless-ngx<'),
    'numbers first, then what they are'
  );
  assert.ok(many.includes('>Take over 4<'), 'a verb and a number');
  assert.ok(many.includes('id="simAdoptTypesBtn"'));
  const one = htmlAdoptTypes(1);
  assert.ok(one.includes('>1 document type in Paperless-ngx<'));

  const render = functionBody('renderAdoptOffer');
  assert.ok(render.includes('vocabulary.types.length === 0'));
  assert.ok(render.includes('!typesUnreachable'));
  assert.ok(render.includes('documentTypes.length > 0'));
  const adopt = functionBody('adoptDocumentTypes');
  assert.ok(adopt.includes("addVocabularyName('type'"));
  assert.ok(adopt.includes('ADOPT_NOTICE'), 'and the list is marked unsaved');
  assert.ok(!adopt.includes('sendJson'), 'taking over writes nothing');
  assert.match(
    SCRIPT,
    /const ADOPT_NOTICE = 'Taken over from Paperless-ngx, not saved yet';/
  );
});

test('The hint under a typed topic says what the tag list knows', () => {
  const { htmlTopicHint, useExistingSpelling } = helpers(
    ['num', 'plural', 'htmlTopicHint', 'useExistingSpelling'],
    { globals: { esc: escForTest } }
  );
  assert.strictEqual(
    htmlTopicHint('Strom', { name: 'Strom', documentCount: 12 }),
    'Existing tag · 12 documents'
  );
  assert.strictEqual(
    htmlTopicHint('Strom', { name: 'Strom', documentCount: 1 }),
    'Existing tag · 1 document'
  );
  const cased = htmlTopicHint('strom', { name: 'Strom', documentCount: 12 });
  assert.ok(cased.startsWith('Existing tag: Strom'), cased);
  assert.ok(cased.includes('class="zr-btn sim-hint__use"'));
  assert.ok(cased.includes('data-name="Strom"'));
  assert.ok(cased.includes('data-typed="strom"'));
  assert.ok(cased.includes('>Use Strom<'));
  assert.strictEqual(htmlTopicHint('Photovoltaik', null), '');
  const nasty = htmlTopicHint('<b>x</b>', { name: '<b>X</b>' });
  assert.ok(!nasty.includes('<b>'), 'a name must never reach the page as tags');

  assert.deepStrictEqual(
    useExistingSpelling(['Auto', 'strom', 'Steuer'], 'strom', 'Strom'),
    ['Auto', 'Strom', 'Steuer']
  );
  assert.deepStrictEqual(
    useExistingSpelling(['Strom', 'strom'], 'strom', 'Strom'),
    ['Strom']
  );
  assert.deepStrictEqual(useExistingSpelling(['Auto'], 'strom', 'Strom'), [
    'Auto',
  ]);

  const ensure = functionBody('ensureTagIndex');
  assert.ok(ensure.includes("'/api/duplicates/entities?kind=tags'"));
  assert.ok(ensure.includes('if (tagIndex) return Promise.resolve(tagIndex)'));
  assert.ok(ensure.includes('.catch('), 'a hint must never break the page');
  assert.ok(
    !functionBody('init').includes('ensureTagIndex'),
    'a page that never adds a topic must not fetch a thousand names'
  );
  assert.ok(
    functionBody('initVocabulary').includes(
      "addFrom(el.topicInput, 'topic', showTopicHint)"
    )
  );
});

test('The document types are read on load, past the cache on reload', () => {
  const load = functionBody('loadDocumentTypes');
  assert.ok(load.includes("'/api/simplify/document-types'"));
  assert.ok(load.includes("'/api/simplify/document-types?fresh=1'"));
  assert.ok(load.includes('TYPES_UNREACHABLE'));
  assert.match(
    SCRIPT,
    /const TYPES_UNREACHABLE = 'Paperless-ngx not reachable';/,
    'the note is a fact, not an instruction'
  );
  assert.ok(
    functionBody('reloadDocumentTypes').includes('loadDocumentTypes(true)')
  );
  assert.ok(functionBody('init').includes('loadDocumentTypes()'));
  assert.ok(
    functionBody('applySelected').includes('loadDocumentTypes()'),
    'a split may have created a type, so the list is read again afterwards'
  );
  const picker = functionBody('initTypePicker');
  assert.ok(picker.includes("prefix: 'simTypeRow'"));
  assert.ok(picker.includes("if (inVocabulary('type', name)) return;"));
  assert.ok(picker.includes("addVocabularyName('type', name)"));
  assert.ok(functionBody('typeChoices').includes('IN_VOCABULARY_BADGE'));
  assert.ok(
    functionBody('initVocabulary').includes(
      'if (event.defaultPrevented) return;'
    )
  );
});

/* -- 6. the proposal row ------------------------------------------------- */

const ROW_HELPERS = [
  'num',
  'plural',
  'actionLabel',
  'htmlSourceBadge',
  'overwriteLabel',
  'htmlTypeSelect',
  'htmlTopicChips',
  'htmlProposalRow',
];

function rowHelpers() {
  return helpers(ROW_HELPERS, {
    constants: ['SOURCE_LABELS', 'SOURCE_TONES', 'STATUS_BADGES'],
    globals: { esc: escForTest, UNDO_HREF: '/duplicates#dupLog' },
  });
}

test('The proposal row carries the select, the chips and the badges', () => {
  const { htmlProposalRow } = rowHelpers();
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
  assert.ok(row.includes('data-tag-id="9"'));
  assert.ok(row.includes('class="zr-check sim-pick" data-tag-id="9"'));
  assert.ok(row.includes('>Stromrechnung<'));
  assert.ok(row.includes('>12<'));
  assert.ok(row.includes('class="zr-select sim-type" data-tag-id="9"'));
  assert.ok(row.includes('<option value="">none</option>'));
  assert.ok(
    row.includes('<option value="Rechnung" selected>Rechnung</option>')
  );
  assert.ok(row.includes('>Brief<'), 'every vocabulary type is offered');
  assert.ok(
    row.includes('class="sim-topic-remove" data-tag-id="9" data-name="Strom"')
  );
  assert.ok(row.includes('list="simTopicOptions"'));
  assert.ok(row.includes('<span class="zr-badge zr-badge--ok">rule</span>'));
  assert.ok(row.includes('compound of Rechnung and Strom'));
  assert.ok(row.includes('<span class="zr-badge ">open</span>'));
  assert.ok(row.includes('class="zr-check sim-overwrite" data-tag-id="9"'));
  assert.ok(!/class="zr-check sim-overwrite"[^>]*checked/.test(row));
  assert.ok(row.includes('3 keep their type'));
  assert.ok(
    row.includes('<td data-label="Action" class="sim-proposals__actioncol">'),
    'the action comes first'
  );
});

test('The source badge says model and edited apart, with the confidence', () => {
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
    )
  );
  assert.ok(htmlSourceBadge({ source: 'model' }).includes('>model<'));
  assert.ok(
    htmlSourceBadge({ source: 'user' }).includes('>edited<'),
    'a row edited by hand says so, without addressing anybody'
  );
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
  const { htmlProposalRow } = rowHelpers();
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
  assert.ok(applied.includes('sim-row--applied'));
  assert.ok(
    applied.includes('href="/duplicates#dupLog"') && applied.includes('>Undo<'),
    'the one log of the app lives on the Duplicates page'
  );
  assert.ok(!applied.includes('sim-pick'));
  assert.ok(!applied.includes('class="zr-select sim-type"'));
  assert.ok(!applied.includes('sim-overwrite'));
  assert.ok(!/[\u2013\u2014]/.test(applied), 'no dash stands in for a box');

  const failedRow = htmlProposalRow(
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
    failedRow.includes('sim-row--failed') &&
      failedRow.includes('<span class="sim-error">Tag 4 is gone</span>')
  );
});

/* -- 7. the dialog of the table's apply ---------------------------------- */

test('The table apply asks with every number it will change', () => {
  const { applyConfirmText } = helpers(
    ['num', 'plural', 'applyConfirmText'],
    {}
  );
  assert.strictEqual(
    applyConfirmText([{ documents: 340, typeSet: 300, typeKept: 40 }]),
    '340 documents get topics · 300 get a type · 40 keep theirs · 1 tag deleted',
    'numbers first, one fact per part'
  );
  const clean = applyConfirmText([{ documents: 5, typeSet: 5, typeKept: 0 }]);
  assert.ok(!clean.includes('keep'), clean);
  const topicsOnly = applyConfirmText([
    { documents: 4, typeSet: 0, typeKept: 0 },
  ]);
  assert.strictEqual(topicsOnly, '4 documents get topics · 1 tag deleted');
  assert.ok(
    applyConfirmText([{ documents: 1, typeSet: 1, typeKept: 0 }]).startsWith(
      '1 document gets topics'
    )
  );
  const many = applyConfirmText(
    Array.from({ length: 12 }, () => ({
      documents: 40 / 11,
      typeSet: 20 / 11,
      typeKept: 20 / 11,
    }))
  );
  assert.ok(many.endsWith('12 tags deleted'), many);

  const apply = functionBody('applySelected');
  assert.ok(
    apply.includes('confirmDialog({') && apply.includes("tone: 'danger'")
  );
  assert.ok(apply.includes('applyConfirmText(entries)'));
  assert.ok(
    apply.includes('Checking documents, ${index + 1} of ${picks.length}…')
  );
});

test('The impact falls back to what the proposal itself recorded', () => {
  const impact = functionBody('impactOf');
  assert.ok(
    impact.includes('/api/simplify/proposals/') && impact.includes('/impact')
  );
  assert.ok(impact.includes('return fallback;'));
  assert.ok(impact.includes('proposal.overwriteType === true ? 0 :'));
});

/* -- 8. the empty states ------------------------------------------------- */

test('The empty states are short facts, word for word', () => {
  assert.match(SCRIPT, /const VOCABULARY_EMPTY = 'No vocabulary';/);
  assert.match(SCRIPT, /const PROPOSALS_EMPTY = 'No proposals';/);
  assert.match(SCRIPT, /const ORDER_EMPTY = 'No order proposed';/);
  assert.match(SCRIPT, /const GROUPS_EMPTY = 'No groups match';/);

  const { htmlVocabularyEmpty } = helpers(['htmlVocabularyEmpty'], {
    globals: { esc: escForTest, VOCABULARY_EMPTY: 'nothing here' },
  });
  assert.ok(htmlVocabularyEmpty().includes('zr-alert zr-alert--info'));
  const render = functionBody('renderProposals');
  assert.ok(render.includes('PROPOSALS_EMPTY'));
  assert.ok(
    render.includes("'No match'"),
    'a filter that matches nothing is not the same as no proposals at all'
  );
});

/* -- 9. the progress panel ----------------------------------------------- */

test('The panel words its numbers the way a wait reads', () => {
  const {
    formatElapsed,
    formatEta,
    progressPercent,
    progressOutcomeText,
    phaseHeadline,
  } = helpers(
    [
      'num',
      'plural',
      'formatElapsed',
      'formatEta',
      'progressPercent',
      'progressOutcomeText',
      'phaseHeadline',
    ],
    {}
  );

  assert.strictEqual(formatElapsed(7000), '0:07');
  assert.strictEqual(formatElapsed(84000), '1:24');
  assert.strictEqual(formatElapsed(3723000), '1:02:03');

  assert.strictEqual(formatEta(null), '');
  assert.strictEqual(formatEta(2000), 'almost done');
  assert.strictEqual(formatEta(40000), '~40 s left');
  assert.strictEqual(formatEta(180000), '~3 min left');

  assert.strictEqual(progressPercent({}), null);
  assert.strictEqual(progressPercent({ requestsPlanned: 0 }), null);
  assert.strictEqual(
    progressPercent({ requestsDone: 3, requestsPlanned: 6 }),
    50
  );
  assert.strictEqual(
    progressPercent({ requestsDone: 9, requestsPlanned: 6 }),
    100
  );

  assert.strictEqual(
    phaseHeadline({ phase: 'ordering', message: 'Asking about 50 tags…' }),
    'Asking the model'
  );
  assert.strictEqual(
    phaseHeadline({ phase: 'vocabulary' }),
    'Proposing a vocabulary'
  );
  assert.strictEqual(phaseHeadline({ phase: 'escalating' }), 'Asking again');
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
  assert.ok(follow.includes('new EventSource(`${base}/events`)'));
  assert.ok(follow.includes('startPolling();'));
  assert.ok(follow.includes('/api/duplicates/ai-review/jobs/'));
  assert.ok(follow.includes("typeof window.EventSource === 'function'"));

  const stop = functionBody('stopJob');
  assert.ok(stop.includes('/stop'));
  assert.ok(stop.includes("setStopLabel('Stopping…')"));

  const reattach = functionBody('reattachJob');
  assert.ok(reattach.includes('/api/duplicates/ai-review/jobs/current'));
  assert.ok(reattach.includes('if (!mine.includes(task)) return;'));
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

/* -- 10. the requests ---------------------------------------------------- */

test('Every request goes to the route the page was built for', () => {
  [
    ["'/api/simplify/vocabulary'", 2],
    ["'/api/simplify/vocabulary/propose'", 1],
    ["'/api/simplify/proposals'", 1],
    ["'/api/simplify/proposals/run'", 1],
    ["'/api/simplify/apply'", 1],
    ["'/api/simplify/order/propose'", 1],
    ["'/api/simplify/order/apply'", 1],
  ].forEach(([needle, times]) => {
    assert.strictEqual(
      SCRIPT.split(needle).length - 1,
      times,
      `${needle} must be reached exactly ${times} time(s)`
    );
  });
  assert.ok(SCRIPT.includes("sendJson('PUT', '/api/simplify/vocabulary'"));
  // Every id that reaches a URL is encoded, however it got into the page.
  const urls = [
    ...SCRIPT.matchAll(/`\/api\/simplify\/[^`]*\$\{([^}]*)\}/g),
  ].map((match) => match[1].trim());
  assert.ok(urls.length >= 5, 'the scan lost the templated routes');
  urls.forEach((expression) => {
    assert.ok(
      expression.startsWith('encodeURIComponent('),
      `an id reaches a URL unencoded: ${expression}`
    );
  });

  const init = functionBody('init');
  assert.ok(
    init.includes('loadVocabulary()') &&
      init.includes('loadProposals()') &&
      init.includes('reattachJob()')
  );
  [
    'saveVocabulary',
    'proposeVocabulary',
    'proposeSplits',
    'applySelected',
    'repropose',
  ].forEach((name) => {
    assert.ok(
      SCRIPT.includes(`addEventListener('click', ${name})`),
      `${name}() must be behind a button`
    );
  });
  // The assistant's buttons are drawn with its card; one listener serves them.
  const assist = functionBody('initAssist');
  ['proposeOrder()', 'openStack()', 'applyAllAccepted()'].forEach((call) => {
    assert.ok(assist.includes(call), `${call} must be behind a button`);
  });
});

/* -- 11. the order as groups --------------------------------------------- */

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

const CARD_HELPERS = [
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
  'htmlGroupTick',
  'htmlGroupCard',
];

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

test('The advanced view carries the order, the groups, the table and the vocabulary', () => {
  [
    'simOrder',
    'simOrderMeta',
    'simOrderSummary',
    'simOrderEmpty',
    'simOrderStats',
    'simStatGroupTypes',
    'simStatGroupTopics',
    'simStatGroupMerges',
    'simStatGroupDelete',
    'simStatGroupKeep',
    'simStatOrderAccepted',
    'simStatOrderApplied',
    'simView',
    'simGroupsBlock',
    'simGroupKind',
    'simGroupStatus',
    'simGroupSearch',
    'simGroups',
    'simGroupFilters',
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

  // The order row first with the segment in its head, then the groups, the
  // table, and the vocabulary last.
  const at = (id) => page.indexOf(`id="${id}"`);
  assert.ok(at('simOrder') < at('simView'));
  assert.ok(at('simView') < at('simGroupsBlock'));
  assert.ok(at('simGroupsBlock') < at('simProposals'));
  assert.ok(at('simProposals') < at('simVocabularyBlock'));
  assert.match(page, /class="zr-module hidden" id="simProposals"/);
  assert.match(
    page,
    /<button type="button" data-view="groups" aria-selected="true">Groups<\/button>/,
    'the groups are the view the advanced page opens in'
  );
  assert.match(page, /data-view="table" aria-selected="false">Table</);
  assert.match(
    page,
    /<details class="zr-module sim-vocab-module" id="simVocabularyBlock" data-awake>/
  );
  assert.ok(page.includes('Propose order again'));
  // The apply of everything accepted is the assistant's button now, and
  // keeping the vocabulary is a lever of the sheet.
  assert.ok(!page.includes('id="simApplyAcceptedBtn"'));
  assert.ok(SCRIPT.includes('id="simApplyAcceptedBtn"'));
  assert.ok(!page.includes('simOrderKeepVocabulary'));
  // After a run most groups are accepted whole: the filter shows them all.
  assert.match(
    page,
    /data-group-status="all" aria-selected="true">All</,
    'the groups open on All, so the proposal the run landed is in sight'
  );
  assert.match(SCRIPT, /let groupStatus = 'all';/);
});

test('The order is started from the assistant, which knows about the model', () => {
  const offered = renderSync(
    'simplify.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  assert.ok(offered.includes('data-provider="ready"'));
  assert.ok(page.includes('data-provider="none"'), 'no model, and it says so');
  // The order row carries no button of its own any more.
  ['simOrderBtn', 'simOrderAiHint', 'Propose a new order'].forEach((needle) => {
    assert.ok(!offered.includes(needle) && !page.includes(needle), needle);
  });
  ['simGroups', 'simReproposeBtn'].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} must be there without it`);
  });
});

test('A group card says what it is, how big it is and what can be done', () => {
  const { htmlGroupCard } = orderHelpers(CARD_HELPERS);
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
  assert.ok(card.includes('data-group-key="type:Rechnung"'));
  assert.ok(card.includes('data-kind="type"'));
  assert.ok(card.includes('<span class="zr-badge zr-badge--brand">'));
  assert.ok(card.includes('#i-file'));
  assert.ok(card.includes('>type<'));
  assert.ok(card.includes('>Rechnung<'));
  assert.ok(card.includes('212 tags · 3,410 documents'));
  assert.ok(
    card.includes('>180 open<') &&
      card.includes('>30 accepted<') &&
      card.includes('>2 applied<')
  );
  assert.ok(!card.includes('skipped<'));
  ['sim-group-accept', 'sim-group-skip', 'sim-group-reopen'].forEach((cls) => {
    assert.ok(card.includes(cls), `${cls} is missing from the foot`);
  });
  assert.ok(
    /class="zr-btn sim-group-apply">Apply 30</.test(card),
    'the apply of a card is a verb and the number it writes'
  );
  assert.ok(
    card.includes(
      '<summary class="sim-group__summary"><svg class="zr-icon zr-icon--sm sim-group__chevron" aria-hidden="true"><use href="/icons.svg#i-chevron-right"/></svg>Show 1 tag</summary>'
    )
  );
  assert.ok(!card.includes('<details class="sim-group__members" open>'));
  assert.ok(
    htmlGroupCard(fixtureGroup({ members: [fixtureMember({})] }), {
      open: true,
    }).includes('<details class="sim-group__members" open>')
  );
  // The tick on the head: half while some tags are accepted, full when all
  // that are left are, empty when none are.
  assert.ok(
    card.includes(
      '<input type="checkbox" class="zr-check sim-group-tick" aria-label="Apply Rechnung" data-mixed="true">'
    )
  );
  assert.ok(card.includes('<th class="sim-members__tickcol">Apply</th>'));
  const { htmlGroupTick } = orderHelpers(CARD_HELPERS);
  assert.match(
    htmlGroupTick(fixtureGroup({ open: 0, accepted: 4 })),
    /class="zr-check sim-group-tick" aria-label="Apply Rechnung" checked>$/
  );
  assert.match(
    htmlGroupTick(fixtureGroup({ open: 2, accepted: 0 })),
    /aria-label="Apply Rechnung">$/
  );
  assert.match(
    htmlGroupTick(fixtureGroup({ open: 0, accepted: 0, applied: 3 })),
    / checked disabled>$/,
    'a group written whole shows it and cannot change'
  );
  assert.ok(functionBody('renderGroups').includes('markMixedTicks(el.groups)'));
});

test('Every kind of group reads as itself', () => {
  const { htmlGroupCard, groupTitle } = orderHelpers(CARD_HELPERS);
  assert.strictEqual(
    groupTitle({ kind: 'type', name: 'Rechnung' }),
    'Rechnung'
  );
  assert.strictEqual(groupTitle({ kind: 'topic', name: 'Strom' }), 'Strom');
  assert.strictEqual(groupTitle({ kind: 'merge', name: 'Amazon' }), '→ Amazon');
  assert.strictEqual(groupTitle({ kind: 'delete', name: null }), 'Delete');
  assert.strictEqual(groupTitle({ kind: 'keep', name: null }), 'Unchanged');

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
  assert.ok(of('topic', { name: 'Strom' }).includes('zr-badge--info'));
  const merge = of('merge', { accepted: 1 });
  assert.ok(merge.includes('zr-badge--warn') && merge.includes('#i-merge'));
  assert.ok(merge.includes('→ Amazon'));
  const remove = of('delete');
  assert.ok(remove.includes('zr-badge--danger') && remove.includes('#i-trash'));
  const keep = of('keep', { members: [fixtureMember({ action: 'keep' })] });
  assert.ok(keep.includes('zr-badge--ok'));
  assert.ok(
    !keep.includes('sim-group-tick') && !keep.includes('sim-member-tick')
  );
  assert.ok(!keep.includes('sim-group-accept'));
  assert.ok(!keep.includes('sim-group-apply'));
  assert.ok(!keep.includes('sim-member-remove'));
  const fresh = of('type', { name: 'Brief' });
  assert.ok(/class="zr-btn sim-group-apply" disabled/.test(fresh));
  assert.ok(!fresh.includes('sim-group-reopen'));
  const done = of('type', { name: 'Brief', open: 0, accepted: 2 });
  assert.ok(
    /class="zr-btn zr-btn--primary sim-group-accept" disabled/.test(done)
  );
  assert.ok(done.includes('sim-group-reopen'));
});

test('A member row says what happens to the tag', () => {
  const { htmlMemberRow, memberOutcome } = orderHelpers(CARD_HELPERS);
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
      fixtureMember({ action: 'merge', mergeInto: 'Amazon', typeName: null })
    ),
    '→ merge into Amazon'
  );
  assert.strictEqual(
    memberOutcome(fixtureMember({ action: 'delete' })),
    'delete'
  );
  assert.strictEqual(memberOutcome(fixtureMember({ action: 'keep' })), 'keep');
  assert.strictEqual(
    memberOutcome(fixtureMember({ typeName: null, topicNames: [] })),
    'keep'
  );

  const row = htmlMemberRow(fixtureGroup({}), fixtureMember({}));
  assert.ok(row.includes('data-tag-id="9"'));
  // The tick is the proposal: accepted is ticked, applied is ticked for good.
  assert.ok(
    row.includes(
      '<td data-label="Apply" class="sim-member__tick"><input type="checkbox" class="zr-check sim-member-tick" data-tag-id="9" aria-label="Apply Stromrechnung"></td>'
    )
  );
  assert.ok(
    htmlMemberRow(
      fixtureGroup({}),
      fixtureMember({ status: 'accepted' })
    ).includes('aria-label="Apply Stromrechnung" checked>')
  );
  assert.ok(
    htmlMemberRow(
      fixtureGroup({}),
      fixtureMember({ status: 'applied' })
    ).includes('aria-label="Apply Stromrechnung" checked disabled>')
  );
  assert.ok(row.includes('>Stromrechnung<'));
  assert.ok(row.includes('>12<'));
  assert.ok(row.includes('<span class="zr-badge zr-badge--ok">rule</span>'));
  assert.ok(row.includes('class="zr-btn zr-btn--icon sim-member-remove"'));
  assert.ok(row.includes('title="Take out of the group"'));
  assert.ok(row.includes('>Skip<'));
  assert.ok(
    htmlMemberRow(
      fixtureGroup({}),
      fixtureMember({ status: 'skipped' })
    ).includes('>Reopen<')
  );
  const applied = htmlMemberRow(
    fixtureGroup({}),
    fixtureMember({ status: 'applied' })
  );
  assert.ok(!applied.includes('sim-member-skip'));
  assert.ok(!applied.includes('sim-member-remove'));

  const nasty = htmlMemberRow(
    fixtureGroup({}),
    fixtureMember({
      tagName: '<img src=x>',
      mergeInto: '<b>x</b>',
      action: 'merge',
      reason: '<script>alert(1)</script>',
    })
  );
  assert.ok(!nasty.includes('<img'));
  assert.ok(!nasty.includes('<script>'));
});

test('A card renders 50 members and offers the rest', () => {
  const { htmlGroupCard } = orderHelpers(CARD_HELPERS);
  const members = Array.from({ length: 212 }, (unused, index) =>
    fixtureMember({ tagId: index + 1, tagName: `Tag ${index + 1}` })
  );
  const card = htmlGroupCard(fixtureGroup({ tags: 212, members }), {});
  assert.strictEqual((card.match(/class="sim-member"/g) || []).length, 50);
  assert.ok(card.includes('>162 more<'), 'the rest is offered by number');
  assert.ok(card.includes('sim-group__more'));
  const all = htmlGroupCard(fixtureGroup({ tags: 212, members }), {
    shown: 212,
  });
  assert.strictEqual((all.match(/class="sim-member"/g) || []).length, 212);
  assert.ok(!all.includes('sim-group__more'));
  const wiring = functionBody('initOrder');
  assert.ok(wiring.includes('groupShown.set('));
  assert.ok(wiring.includes('renderGroupCard(group.key, group)'));
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

  assert.deepStrictEqual(visible('all', 'all', ''), [
    'type:Rechnung',
    'topic:Strom',
    'merge:Amazon',
    'keep',
  ]);
  assert.deepStrictEqual(visible('all', 'open', ''), ['type:Rechnung', 'keep']);
  assert.deepStrictEqual(visible('all', 'accepted', ''), ['topic:Strom']);
  assert.deepStrictEqual(visible('all', 'applied', ''), ['merge:Amazon']);
  assert.deepStrictEqual(visible('topic', 'all', ''), ['topic:Strom']);
  assert.deepStrictEqual(visible('all', 'all', 'rechnung'), [
    'type:Rechnung',
    'topic:Strom',
  ]);
  assert.deepStrictEqual(visible('all', 'all', 'unchanged'), ['keep']);
  assert.deepStrictEqual(visible('all', 'all', 'zzz'), []);
});

test('The tiles and the summary count every tag once', () => {
  const { memberTotals, orderSummaryText } = helpers(
    ['num', 'plural', 'memberTotals', 'orderSummaryText'],
    {}
  );
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
  assert.strictEqual(totals.accepted, 1);
  assert.strictEqual(totals.applied, 1);
  assert.strictEqual(totals.open, 3);
  assert.strictEqual(memberTotals(groups, 'accepted').tags, 1);
  assert.strictEqual(memberTotals(null).tags, 0);

  assert.strictEqual(
    orderSummaryText(
      { byRule: 640, byModel: 660, requests: 14 },
      { tags: 1300, split: 812, merge: 94, keep: 371, delete: 23 }
    ),
    '1300 tags: 812 split, 94 merge, 371 keep, 23 delete · 640 by rule, 660 by the model · 14 requests'
  );
  assert.ok(
    orderSummaryText({ requests: 1, stopped: true }, { tags: 1 }).endsWith(
      '1 request · stopped'
    )
  );
});

test('Every apply of the order asks with the numbers of what it will write', () => {
  const { groupApplyConfirmText, applySummaryText, applyLabel } = helpers(
    [
      'num',
      'plural',
      'grouped',
      'planWrites',
      'actionCounts',
      'applySummaryText',
      'groupConfirmName',
      'groupApplyConfirmText',
      'applyLabel',
    ],
    {}
  );
  assert.strictEqual(
    groupApplyConfirmText({ kind: 'type', name: 'Rechnung', accepted: 30 }),
    '30 accepted tags · documents get the type Rechnung and their topics · 30 tags deleted'
  );
  assert.ok(
    groupApplyConfirmText({
      kind: 'merge',
      name: 'Amazon',
      accepted: 4,
    }).includes('documents move to Amazon')
  );
  assert.ok(
    groupApplyConfirmText({
      kind: 'delete',
      name: null,
      accepted: 1,
    }).startsWith('1 accepted tag · taken off their documents')
  );

  const list = [
    fixtureMember({ tagId: 1, documentCount: 10 }),
    fixtureMember({ tagId: 2, action: 'merge', documentCount: 4 }),
    fixtureMember({ tagId: 3, action: 'delete', documentCount: 0 }),
    fixtureMember({ tagId: 4, action: 'keep' }),
  ];
  assert.strictEqual(
    applySummaryText(list),
    '1 split · 1 merged · 1 deleted · 27 writes',
    'a tag that stays writes nothing and is not counted'
  );
  assert.strictEqual(
    applySummaryText([fixtureMember({ documentCount: 0 })]),
    '1 split · 1 write'
  );
  assert.strictEqual(
    applyLabel({ tags: 12, writes: 1450 }),
    'Apply 12 · 1,450 writes'
  );

  const group = functionBody('applyGroup');
  assert.ok(
    group.includes('confirmDialog({') && group.includes("tone: 'danger'")
  );
  assert.ok(group.includes('groupApplyConfirmText(group)'));
  const all = functionBody('applyAllAccepted');
  assert.ok(all.includes('applySummaryText(list)'));
  assert.ok(
    all.includes('acceptedProposals()'),
    'the totals come from the accepted proposals, the same the job reads'
  );
  assert.ok(
    functionBody('resultCounts').includes('planWrites('),
    "the assistant's Apply counts what the job will write"
  );
});

test('An apply leaves a line, and names every tag that failed', () => {
  const { applyResultText, htmlApplyResultBlock } = helpers(
    ['applyResultText', 'htmlApplyResultBlock'],
    { globals: { esc: escForTest, UNDO_HREF: '/duplicates#dupLog' } }
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
    '2 split · 1 merged · 1 deleted · 2 failed'
  );
  assert.strictEqual(
    applyResultText({}),
    '0 split · 0 merged · 0 deleted',
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
  assert.ok(block.includes('zr-alert--warn'));
  assert.ok(block.includes('&lt;b&gt;Autorechnung&lt;/b&gt;: Tag is gone'));
  assert.ok(!block.includes('<b>'));
  const clean = htmlApplyResultBlock({ applied: [], merged: [], failed: [] });
  assert.ok(clean.includes('zr-alert--ok'));
  assert.ok(!clean.includes('Undo'), 'nothing written, nothing to undo');
  assert.ok(
    block.includes('href="/duplicates#dupLog">Undo</a>'),
    'what was written is undone in the merge log'
  );
  const stopped = htmlApplyResultBlock({ applied: [], merged: [] }, true);
  assert.ok(stopped.includes('Stopped · the rest stays accepted'));
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
  assert.strictEqual(
    removeMemberText(
      { kind: 'merge', name: 'Amazon' },
      { tagName: 'amazon', action: 'keep' }
    ),
    'amazon stays as it is'
  );
  const remove = functionBody('removeGroupMember');
  assert.ok(!remove.includes('confirmDialog'));
  assert.ok(remove.includes('removeMemberText(group, payload.data || {})'));
  assert.ok(remove.includes('await loadGroups()'));
});

test('A decision reaches the route and redraws the card and the proposals', () => {
  const decide = functionBody('decideGroup');
  assert.ok(
    decide.includes(
      '`/api/simplify/groups/${encodeURIComponent(String(group.key))}/decision`'
    )
  );
  assert.ok(decide.includes('{ decision }'));
  assert.ok(decide.includes('renderGroupCard(group.key, data.group || null)'));
  assert.ok(
    decide.includes('await loadProposals()'),
    'the simple lists and the apply button read the proposals'
  );
  assert.match(
    SCRIPT,
    /const DECISION_WORDS = \{\n\s+accept: 'accepted',\n\s+skip: 'skipped',\n\s+reopen: 'reopened',\n\s*\};/
  );
  const render = functionBody('renderGroupCard');
  assert.ok(
    render.includes('if (!group) {') && render.includes('groups.splice(at, 1)')
  );
  assert.ok(
    render.includes('node.outerHTML = htmlGroupCard(group, cardState(group))')
  );
});

test('The order and the apply run as jobs of the one job service', () => {
  const run = functionBody('runOrderJob');
  assert.ok(run.includes("startJob('/api/simplify/order/propose'"));
  assert.ok(
    run.includes("vocabulary: vocabularyMode === 'keep' ? 'keep' : 'propose'")
  );
  assert.ok(
    run.includes('await followJob(job)') && run.includes('await finishOrder(')
  );
  const finish = functionBody('finishOrder');
  assert.ok(
    finish.includes('await loadGroups()') &&
      finish.includes('renderOrderSummary()'),
    'a new order is read again and summed up'
  );
  assert.ok(
    functionBody('proposeOrder').includes('runLevers.keepVocabulary === true'),
    'the switch decides what the button asks for'
  );
  assert.ok(functionBody('repropose').includes("runOrderJob('keep')"));

  const apply = functionBody('applyOrder');
  assert.ok(apply.includes("'/api/simplify/order/apply'"));
  assert.ok(apply.includes('groupKey ? { groupKey } : {}'));
  assert.ok(apply.includes('htmlApplyResultBlock('));
  assert.ok(apply.includes('await loadDocumentTypes()'));
});

test('The saved vocabulary decides what the order row offers', () => {
  const state = functionBody('renderVocabularyState');
  assert.ok(state.includes('el.vocabularyBlock.open = !vocabularySaved'));
  assert.ok(
    state.includes(
      "el.reproposeBtn.classList.toggle('hidden', !vocabularySaved)"
    )
  );
  assert.ok(state.includes("String(row.source || '') === 'user'"));
  assert.ok(
    state.includes('runLevers.keepVocabulary ='),
    'the switch of the order row and the switch of the sheet are one lever'
  );
  assert.ok(
    functionBody('readVocabularyPayload').includes(
      'renderVocabularyState(true)'
    )
  );
  assert.ok(
    functionBody('askPreflight').includes(
      "if (id === 'keepVocabulary') runLevers.keepVocabulary = on"
    ),
    'the switch lives on the sheet'
  );
});

test('The table is the other view, with the action in front', () => {
  const { actionLabel } = helpers(['actionLabel'], {});
  assert.strictEqual(actionLabel({ action: 'split' }), 'split');
  assert.strictEqual(actionLabel({ action: 'keep' }), 'keep');
  assert.strictEqual(actionLabel({ action: 'delete' }), 'delete');
  assert.strictEqual(
    actionLabel({ action: 'merge', mergeInto: 'Amazon' }),
    'merge → Amazon'
  );
  assert.strictEqual(actionLabel({}), 'split');
  assert.match(
    page,
    /<th class="sim-proposals__actioncol">Action<\/th>\s*\n\s*<th class="sim-proposals__pickcol">Pick<\/th>/
  );
  assert.ok(SCRIPT.includes('htmlEmptyRow(9,'), 'nine columns');
  const setter = functionBody('renderViewState');
  assert.ok(
    setter.includes("el.groupsBlock.classList.toggle('hidden', table)") &&
      setter.includes("el.proposals.classList.toggle('hidden', !table)"),
    'one view at a time'
  );
  assert.ok(setter.includes('groups.length === 0'));
  assert.ok(functionBody('init').includes("setView('groups')"));
  assert.ok(
    page.indexOf('id="simProposeSplitsBtn"') >
      page.indexOf('id="simProposals"'),
    'Propose splits belongs to the table view'
  );
});

test('The order has an empty state for nothing and one for no match', () => {
  const empty = functionBody('renderOrderEmpty');
  assert.ok(empty.includes('groups.length === 0 ? ORDER_EMPTY : GROUPS_EMPTY'));
  assert.ok(empty.includes("view === 'groups'"));
  assert.ok(empty.includes('el.orderEmpty.textContent'));
  assert.match(
    page,
    /class="zr-empty sim-order__empty hidden" id="simOrderEmpty"/
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
  assert.match(
    CSS,
    /@media \(max-width: 720px\) \{[\s\S]*?\.sim-group__foot \.zr-btn \{\n\s+flex: 1;/
  );
  assert.match(
    CSS,
    /\.sim-filters__field--wide \.zr-segment \{\n\s+flex-wrap: wrap;/
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
