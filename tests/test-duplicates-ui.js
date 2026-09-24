/**
 * Test: duplicates-ui
 *
 * Static checks for the Duplicates page: the view, its navigation entry, its
 * stylesheet and its page script. The page talks to a dozen endpoints and is
 * reviewed in a browser; what is checked here is everything that can drift
 * without anyone noticing. The assistant on top (the start, the run, the
 * result), the tick rule, the sheet and the stack are described in
 * tests/test-duplicates-assistant-ui.js; this file covers the page as a
 * whole and the tools under the assistant:
 *
 * 1. views/duplicates.ejs renders through the real shell and carries the ids,
 *    the sensitivity options and the threshold field the page script and the
 *    route agree on, with the model offered and without it
 * 2. nav.ejs lists /duplicates on the rail and leaves the phone tab bar alone
 * 3. head-start.ejs links the page stylesheet in the right place
 * 4. public/css/pages/duplicates.css is one @layer pages block of dup- classes
 * 5. public/icons.svg carries the i-merge symbol the page references
 * 6. public/js/duplicates.js escapes everything it writes into innerHTML
 * 7. the page has a label for every match reason, group warning and verdict,
 *    and its own wording where a flow needs one
 * 8. the selection bar, the select check on every card and the one dialog a
 *    batch merge asks with
 * 9. every group as a list: its bar, sorting, "Select ≥", what is stored, and
 *    the guided "ask the model, then merge" flow, all of it working on an
 *    instance without the model as well
 * 10. what the two ways to the model send, the pre-tick rule, the basis and
 *    confidence a verdict shows, and the aligned member tables
 * 11. the run as a job the page watches: the run meter, the pure helpers that
 *    word its numbers, the event stream with its polling fallback, and the
 *    re-attach after a reload
 * 12. what the meter shows inside one request, and the settings link a failed
 *    run offers
 * 13. the name the single merge dialog offers for the survivor, and the rule
 *    that a name is only sent when it changed
 * 14. the Unused section: its ids, the question before a delete, the rows it
 *    draws and the one request it sends per kind
 * 15. the log rows a delete, a rename and a split write, and what their undo
 *    says it takes back
 * 16. the names the creation guard mapped, their rule and the document link
 * 17. the synonym sweep, the remembered verdict and the verdict memory
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

/** The page rendered where the route offers the model. */
function renderOffered() {
  return renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
}

const CSS = read('public', 'css', 'pages', 'duplicates.css');
const SCRIPT = read('public', 'js', 'duplicates.js');

/** Everything between a balanced pair of braces, from a starting offset. */
function balanced(start) {
  const open = SCRIPT.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SCRIPT.length; i += 1) {
    if (SCRIPT[i] === '{') depth += 1;
    if (SCRIPT[i] === '}') {
      depth -= 1;
      if (depth === 0) return SCRIPT.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in the page script');
}

/** The whole source of a top-level function, so a test can run it itself. */
function functionSource(name) {
  const start = SCRIPT.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name}() is gone from the page script`);
  return balanced(start);
}

/** The body of a top-level function, braces included, for the checks that only read it. */
function functionBody(name) {
  const source = functionSource(name);
  return source.slice(source.indexOf('{'));
}

/** The whole source of a top-level const whose value is an object literal. */
function constantSource(name) {
  const start = SCRIPT.indexOf(`const ${name} = {`);
  assert.notStrictEqual(start, -1, `${name} is gone from the page script`);
  return `${balanced(start)};`;
}

/** The escaper the module imports, so a helper taken out of it still escapes. */
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
 * What the page imports from the shared sheet module, loaded the way
 * tests/test-review-sheet.js loads it: a page helper that words a number with
 * these reads here exactly what it reads in the browser.
 */
const SHEET = new Function(
  'esc',
  `${read('public', 'js', 'modules', 'review-sheet.js')
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|function) /gm, '$1 ')}
return { formatTokens, roughTime };`
)(escForTest);

/**
 * The named helpers of the page script, evaluated out of their module. Only
 * pure functions can be taken this way, which is why the rules a test reads
 * are written as pure functions in the first place.
 *
 * A markup helper needs the page's vocabulary as well: `constants` copies the
 * real object literals in (so a renamed label fails here), and `globals`
 * hands in what the module keeps in a variable (the Paperless-ngx base URL,
 * the date formatter). What the module imports is handed in by default.
 *
 * @param {string[]} names
 * @param {{constants?: string[], globals?: object}} [extra]
 */
function helpers(names, extra = {}) {
  const constants = (extra.constants || []).map(constantSource).join('\n');
  const source = names.map(functionSource).join('\n');
  const globals = Object.assign(
    {
      esc: escForTest,
      formatTokens: SHEET.formatTokens,
      roughTime: SHEET.roughTime,
    },
    extra.globals || {}
  );
  const keys = Object.keys(globals);
  return new Function(
    ...keys,
    `${constants}\n${source}\nreturn { ${names.join(', ')} };`
  )(...keys.map((key) => globals[key]));
}

/* ── 1. the view ──────────────────────────────────────────────────────────── */

let page = '';

test('views/duplicates.ejs renders through the real shell partials', () => {
  page = renderSync('duplicates.ejs', LOCALS);
  assert.ok(page.includes('<!DOCTYPE html>'), 'no document was produced');
  assert.ok(
    page.includes('<section class="dup-assist" id="dupAssist" data-assist'),
    'the assistant is missing'
  );
});

test('The view carries the ids the page script and the route agree on', () => {
  [
    'dupAssist',
    'dupAssistCard',
    'dupAiProgress',
    'dupRunSteps',
    'dupRunSentence',
    'dupControls',
    'dupScanBtn',
    'dupAiNotice',
    'dupApply',
    'dupStack',
    'dupEverything',
    'dupResults',
    'dupLog',
    'dupDismissals',
  ].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
    // The two tools the script reaches through their parts are not looked
    // up themselves.
    if (id === 'dupControls' || id === 'dupDismissals') return;
    assert.ok(
      SCRIPT.includes(`'${id}'`),
      `the page script never looks up #${id}`
    );
  });
  // The row of numbers above the results said what the assistant says now,
  // and the simple result is gone with its mode.
  [
    'dupStats',
    'dupStatGroups',
    'dupStatBuckets',
    'dupEmpty',
    'dupResult',
    'dupChecklists',
    'dupHistoryLine',
  ].forEach((id) => {
    assert.ok(
      !page.includes(`id="${id}"`),
      `#${id} repeats the assistant and belongs to no mockup`
    );
  });
});

test('The manual merge module carries the ids the page script binds to', () => {
  [
    'dupManual',
    'dupManualKind',
    'dupManualTarget',
    'dupManualSources',
    'dupManualReloadBtn',
    'dupManualMergeBtn',
  ].forEach((id) => {
    assert.ok(
      page.includes(`id="${id}"`),
      `#${id} is missing from the view; the manual merge cannot bind to it`
    );
  });
  // The two dropdowns and the chip row are addressed by id as well; they carry
  // no markup of their own until something is picked.
  ['dupManualTargetList', 'dupManualSourcesList', 'dupManualChips'].forEach(
    (id) => {
      assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
    }
  );
});

test('The manual merge module is a closed details block', () => {
  const opening = /<details([^>]*)id="dupManual"([^>]*)>/.exec(page);
  assert.ok(opening, 'the module is not a <details> element');
  const attributes = `${opening[1]} ${opening[2]}`;
  assert.ok(
    !/\bopen\b/.test(attributes),
    'the module must come up closed; nothing is fetched until it is opened'
  );
  assert.ok(
    /class="[^"]*\bdup-manual\b[^"]*"/.test(attributes),
    'the module is styled through .dup-manual'
  );
  assert.ok(
    page.includes('>Merge by hand</span>'),
    'the summary is labelled "Merge by hand"'
  );
});

test('The manual merge module sits between the scan row and the results', () => {
  const controls = page.indexOf('id="dupControls"');
  const manual = page.indexOf('id="dupManual"');
  const results = page.indexOf('id="dupResults"');
  assert.ok(controls !== -1 && manual !== -1 && results !== -1);
  assert.ok(
    controls < manual && manual < results,
    'the module belongs after the scan controls and before their results'
  );
});

test('The page script is loaded as an ES module', () => {
  assert.ok(
    page.includes('<script type="module" src="/js/duplicates.js">'),
    'duplicates.js is not loaded as a module, so its imports would fail'
  );
});

/** The options of one select, so a second select on the page cannot confuse it. */
function optionsOf(markup, id) {
  const select = new RegExp(
    `<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`
  ).exec(markup);
  assert.ok(select, `#${id} is not a <select> on this page`);
  return [...select[1].matchAll(/<option value="([^"]+)"([^>]*)>/g)].map(
    (match) => ({ value: match[1], attrs: match[2] })
  );
}

test('The sensitivity select offers the three presets and Custom, normal preselected', () => {
  const options = optionsOf(page, 'dupSensitivity');
  assert.deepStrictEqual(
    options.map((option) => option.value),
    ['0.75', '0.85', '0.95', 'custom'],
    'the option values no longer match SENSITIVITY in the matcher, loosest first'
  );
  const preselected = options.filter((option) =>
    option.attrs.includes('selected')
  );
  assert.deepStrictEqual(
    preselected.map((option) => option.value),
    ['0.85'],
    'exactly the default threshold must come up preselected'
  );
  ['Loose', 'Normal', 'Strict', 'Custom'].forEach((label) => {
    assert.ok(
      page.includes(`>${label}</option>`),
      `the option "${label}" is not labelled`
    );
  });
});

test('The threshold field stands beside the select and follows it both ways', () => {
  // Always shown: a preset writes its number here, and a number no preset
  // has turns the select to Custom.
  assert.match(
    page,
    /class="dup-controls__field dup-controls__custom" id="dupThresholdCustomField"/,
    'the number field must be visible from the first paint'
  );
  const field = /<input[^>]*id="dupThresholdCustom"[^>]*>/.exec(page);
  assert.ok(field, '#dupThresholdCustom is missing from the view');
  ['type="number"', 'min="50"', 'max="100"', 'step="1"', 'value="85"'].forEach(
    (attribute) => {
      assert.ok(
        field[0].includes(attribute),
        `the threshold field is missing ${attribute}`
      );
    }
  );
  assert.ok(
    field[0].includes('class="zr-input"'),
    'the threshold field is not a framework input'
  );
  const init = functionBody('initSensitivity');
  assert.ok(
    init.includes('presets.find((option) => pct(option.value) === percent)'),
    'a number a preset has must turn the select to that preset'
  );
  assert.ok(
    init.includes('CUSTOM_SENSITIVITY') &&
      init.includes('syncThresholdField()'),
    'a preset must write its number into the field, and any other number is Custom'
  );
});

test('The list of every group renders hidden, its bar above the selection', () => {
  [
    'dupEverything',
    'dupResultsBar',
    'dupResultsCount',
    'dupSortSelect',
    'dupMinConfidence',
    'dupSelectMinBtn',
  ].forEach((id) => {
    assert.ok(
      page.includes(`id="${id}"`),
      `#${id} is missing from the view; the list cannot bind to it`
    );
  });
  // Nothing to order until a scan has answered, and before a scan the whole
  // block is out of the way.
  assert.match(
    page,
    /class="dup-everything hidden" id="dupEverything"/,
    'the list must come up hidden'
  );
  assert.match(
    page,
    /class="dup-results-bar hidden" id="dupResultsBar"/,
    'the toolbar must come up hidden'
  );
  assert.ok(
    page.indexOf('id="dupResultsBar"') < page.indexOf('id="dupSelection"'),
    'the toolbar belongs above the selection bar'
  );
  assert.ok(
    page.indexOf('id="dupSelection"') < page.indexOf('id="dupResults"'),
    'both bars belong above the cards they act on'
  );
  assert.deepStrictEqual(
    optionsOf(page, 'dupSortSelect').map((option) => option.value),
    ['confidence', 'documents', 'name', 'kind'],
    'the sort modes drifted away from the ones the page script knows'
  );
  const number = /<input[^>]*id="dupMinConfidence"[^>]*>/.exec(page);
  assert.ok(number, '#dupMinConfidence is missing from the view');
  ['type="number"', 'min="50"', 'max="100"', 'step="1"', 'value="95"'].forEach(
    (attribute) => {
      assert.ok(
        number[0].includes(attribute),
        `the confidence field is missing ${attribute}`
      );
    }
  );
  ['Every group', 'Sort: Confidence', 'Select ≥ 95%'].forEach((label) => {
    assert.ok(page.includes(label), `the toolbar has no "${label}"`);
  });
  // The count of "Select ≥" is the button's title now, not a line of prose.
  assert.ok(
    !page.includes('id="dupMinConfidenceCount"'),
    'the count beside the button is gone'
  );
});

test('The model is rendered only when the route offers it', () => {
  const offered = renderOffered();
  [
    'dupAiReviewBtn',
    'dupAiReviewIcon',
    'dupAiStopBtn',
    'dupReviewThenMergeBtn',
    'dupAiForgetBtn',
  ].forEach((id) => {
    assert.ok(
      offered.includes(`id="${id}"`),
      `#${id} is missing although the model is offered`
    );
    assert.ok(
      !page.includes(`id="${id}"`),
      `#${id} must not be rendered without aiReviewEnabled`
    );
  });
  assert.match(
    offered,
    /id="dupAiReviewBtn"[^>]*disabled/,
    'the button waits for a scan to have found something'
  );
  assert.match(
    offered,
    /id="dupAiReviewIcon"[\s\S]{0,120}icons\.svg#i-wand/,
    'the button has no i-wand icon'
  );
  assert.ok(offered.includes('Ask the model'), 'the button is not labelled');
  assert.ok(
    !page.includes('Ask the model'),
    'no page without the model may offer to ask it'
  );
  // The primary action of the row is the one that goes furthest: the model
  // where there is one, the scan where there is none.
  assert.match(
    page,
    /class="zr-btn zr-btn--primary" id="dupScanBtn"/,
    'without the model the scan is the primary action'
  );
  assert.match(
    offered,
    /class="zr-btn" id="dupScanBtn"/,
    'beside the model the scan is a plain button'
  );
  assert.match(
    offered,
    /class="zr-btn zr-btn--primary" id="dupAiReviewBtn"/,
    'asking the model is the primary action of the row'
  );
  // The options of a run live in the sheet a run opens with, not on the page.
  [offered, page].forEach((markup) => {
    [
      'dupAiTitles',
      'dupAiExcerpts',
      'dupAiSweep',
      'dupAiHint',
      'dupAiProposalBtn',
      'dupStatAiJudgedTile',
      'dupStatAiRequestsTile',
    ].forEach((id) => {
      assert.ok(
        !markup.includes(`id="${id}"`),
        `#${id} belongs to the sheet or is gone, not on the page`
      );
    });
  });
  // The notice carries a failed scan as well as a failed run, so it exists
  // either way.
  [offered, page].forEach((markup) => {
    assert.ok(
      markup.includes('class="dup-ai-notice" id="dupAiNotice"'),
      'a failed scan has nowhere to say so'
    );
  });
});

test('The guided button is rendered only when the model is offered', () => {
  const offered = renderOffered();
  assert.ok(
    offered.includes(
      '<span id="dupReviewThenMergeLabel">Ask the model about 0</span>'
    ),
    'the guided button does not carry its number'
  );
  assert.match(
    offered,
    /id="dupReviewThenMergeBtn"[^>]*disabled/,
    'the guided button waits for a selection'
  );
  assert.match(
    offered,
    /id="dupReviewThenMergeIcon"[\s\S]{0,120}icons\.svg#i-wand/,
    'the guided button has no i-wand icon'
  );
  // Merging is the primary action of the bar; asking the model first is the
  // addition beside it, and the primary action closes the row.
  assert.match(
    offered,
    /class="zr-btn" id="dupReviewThenMergeBtn"/,
    'the guided button is a plain button'
  );
  assert.match(
    offered,
    /class="zr-btn zr-btn--primary" id="dupMergeSelectedBtn"/,
    'merging is the primary action of the bar'
  );
  assert.ok(
    offered.indexOf('id="dupReviewThenMergeBtn"') <
      offered.indexOf('id="dupMergeSelectedBtn"'),
    'the primary action closes the row'
  );
});

test('Without the model the page is whole: the assistant, the list and every merge', () => {
  // The rule for this page: the model is an addition. Everything a merge
  // needs has to render and work with the model switched off; the assistant
  // draws its start and its result from the script either way, and a scan
  // runs on the same meter.
  const plain = renderSync('duplicates.ejs', LOCALS);
  [
    'dupAssist',
    'dupAssistCard',
    'dupAiProgress',
    'dupStack',
    'dupApply',
    'dupResultsBar',
    'dupSortSelect',
    'dupMinConfidence',
    'dupSelectMinBtn',
    'dupThresholdCustom',
    'dupSelection',
    'dupMergeSelectedBtn',
    'dupManual',
    'dupUnused',
  ].forEach((id) => {
    assert.ok(
      plain.includes(`id="${id}"`),
      `#${id} must not depend on the model`
    );
  });
  ['Sort: Confidence', 'Select ≥', 'Merge 0'].forEach((label) => {
    assert.ok(plain.includes(label), `"${label}" must not depend on the model`);
  });
  [
    'dupReviewThenMergeBtn',
    'dupReviewThenMergeIcon',
    'dupAiStopBtn',
    'dupAiForgetBtn',
    'Ask the model',
  ].forEach((needle) => {
    assert.ok(
      !plain.includes(needle),
      `"${needle}" must not be rendered without aiReviewEnabled`
    );
  });
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
  // "Find duplicates" scans with what the row shows, so the row's default
  // is the only default there is.
  assert.ok(
    output.includes('value="85" inputmode="numeric"'),
    'the threshold field has no default'
  );
  assert.ok(
    !output.includes('data-default-threshold'),
    'a second default nobody reads is back'
  );
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
    'one layer block per file: the duplicate checks in stylelint are scoped to it'
  );
});

/** The steps of a @keyframes block, which are not selectors at all. */
const KEYFRAME_STEPS = /^(from|to|\d+(\.\d+)?%)$/;

test('Every rule in duplicates.css is owned by a dup- class', () => {
  // Framework classes may appear as descendants; what a page file may not do is
  // start a selector with one, because layer pages would then beat the
  // framework everywhere on every page that loads this file.
  const offenders = selectorsOf(CSS).filter(
    (selector) =>
      !selector.startsWith('.dup-') && !KEYFRAME_STEPS.test(selector)
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

/**
 * Walks the source and returns every top-level template literal with the text
 * it produces and the expressions it interpolates.
 *
 * Comments and ordinary strings are skipped, and a template literal nested
 * inside an interpolation is treated as opaque text: the page script does not
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
     pct(...)    a score from 0 to 1 as whole percent; a finite number
     html…       a helper or local whose name starts with "html" and whose
                 value is markup the file has already escaped */
const SAFE_INTERPOLATIONS = [/^esc\(/, /^num\(/, /^pct\(/, /^html[A-Z]/];

test('Every value interpolated into markup is escaped or a number', () => {
  const markup = templateLiterals(SCRIPT).filter((literal) =>
    /<[a-zA-Z/!]/.test(literal.text)
  );
  assert.ok(
    markup.length >= 10,
    `only ${markup.length} markup templates found; the scanner lost track of the file`
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

  // The model's three verdicts are a vocabulary of their own; the page needs a
  // label, a tone class and an icon for each of them.
  const ai = require('../services/entityMatchAiService');
  Object.values(ai.AI_VERDICTS).forEach((verdict) => {
    assert.ok(
      hasKey(verdict),
      `the page has no label for the verdict "${verdict}"`
    );
    assert.ok(
      SCRIPT.includes(`Model: ${verdict}`),
      `the page never writes out "Model: ${verdict}"`
    );
    assert.ok(
      SCRIPT.includes(`dup-verdict--${verdict}`),
      `the verdict "${verdict}" has no tone class`
    );
  });
  // The page only has to recognise the source that changes what it renders:
  // everything that is not a candidate of the model is a group the scan
  // itself found.
  assert.ok(
    SCRIPT.includes(`'${ai.GROUP_SOURCES.AI_CANDIDATE}'`),
    'the page does not know the ai-candidate group source'
  );
});

test('The manual flow says what happens to an inbox tag among its sources', () => {
  // A group keeps its inbox tag: the matcher makes it the target. By hand the
  // target is picked, so an inbox tag can be a source, and a source is
  // deleted. The two clauses must therefore stay apart.
  assert.ok(
    SCRIPT.includes("'inbox-tag': 'Inbox tag · it stays the target'"),
    'the group wording is gone'
  );
  assert.ok(
    SCRIPT.includes(
      "'inbox-tag': 'Inbox tag among the names to merge away · it is deleted'"
    ),
    'the manual flow still promises that the inbox tag survives'
  );
  assert.match(
    SCRIPT,
    /htmlWarnings\(manualWarnings\(target, sources\), MANUAL_WARNING_TEXTS\)/,
    'the manual module does not use its own wording'
  );
});

/* ── 8. merging several groups at once ────────────────────────────────────── */

/** Every id the selection bar and the page script have to agree on. */
const SELECTION_IDS = [
  'dupSelection',
  'dupSelectionCount',
  'dupSelectionProgress',
  'dupMergeSelectedBtn',
  'dupMergeSelectedLabel',
];

test('The selection bar renders hidden above the results', () => {
  SELECTION_IDS.forEach((id) => {
    assert.ok(
      page.includes(`id="${id}"`),
      `#${id} is missing from the view; the batch merge cannot bind to it`
    );
  });
  // .hidden is the framework's !important class: nothing of the bar shows
  // until a card is ticked.
  assert.match(
    page,
    /class="dup-selection hidden" id="dupSelection"/,
    'the bar must come up hidden'
  );
  assert.match(
    page,
    /class="zr-sm dup-selection__progress hidden" id="dupSelectionProgress"/,
    'the progress line must come up hidden'
  );
  assert.ok(
    page.includes('<span id="dupMergeSelectedLabel">Merge 0</span>'),
    'the merge button does not carry its number'
  );
  // The bar counts and merges; the checks and "Select ≥" do the selecting.
  ['dupSelectAllBtn', 'dupSelectAiSameBtn', 'dupClearSelectionBtn'].forEach(
    (id) => {
      assert.ok(
        !page.includes(`id="${id}"`),
        `#${id} is not part of the bar any more`
      );
    }
  );
  assert.ok(
    page.indexOf('id="dupSelection"') < page.indexOf('id="dupResults"'),
    'the bar belongs above the cards it selects'
  );
});

test('The view and the page script agree on the selection ids', () => {
  SELECTION_IDS.forEach((id) => {
    assert.ok(
      SCRIPT.includes(`'${id}'`),
      `the page script never looks up #${id}`
    );
  });
});

test('Every group card carries the select check', () => {
  // The check is part of the card template, so it exists for a card the page
  // builds from a scan and for one a review re-rendered.
  assert.match(
    SCRIPT,
    /<input type="checkbox" class="zr-check dup-select" aria-label="Select this group">/,
    'the card head has no select check'
  );
  // The template never ticks: the check follows the selection, and the only
  // thing that fills the selection unasked is the proposal of a new answer,
  // by the one rule (isProposed, tested in test-duplicates-assistant-ui.js).
  assert.ok(
    !/class="zr-check dup-select"[^>]*checked/.test(SCRIPT),
    'the template must not tick a card by itself'
  );
  assert.match(
    SCRIPT,
    /check\.checked = selectedGroups\.has\(id\);/,
    'the check does not follow the selection'
  );
  assert.strictEqual(
    (SCRIPT.match(/selectedGroups\.add\(/g) || []).length,
    5,
    'the proposal, a tick on the card, "Select ≥", the stack and the guided flow are the ways into the selection'
  );
  // A card that may not be merged says why instead of silently doing nothing.
  [
    'This group is being merged',
    'This group is already merged',
    'The API token may not change the target of this group',
    'Tick at least one entry to merge away',
  ].forEach((reason) => {
    assert.ok(
      SCRIPT.includes(reason),
      `a disabled check has no reason "${reason}"`
    );
  });
  assert.match(
    SCRIPT,
    /check\.disabled = reason !== '';/,
    'the reason does not disable the check'
  );
});

test('The batch dialog asks once, with one copy-rule checkbox', () => {
  // Its markup goes through the escaping scanner above like everything else;
  // what is checked here is that it is a batch dialog at all.
  assert.match(
    SCRIPT,
    /id="dupCopyRuleAll" checked/,
    'the batch dialog has no copy-rule checkbox'
  );
  assert.ok(
    SCRIPT.includes('Copy matching rules where the target has none'),
    'the batch checkbox is not labelled'
  );
  // The per-group checkbox keeps its own id; the two dialogs never collide.
  assert.ok(
    SCRIPT.includes('id="dupCopyRule"'),
    'the single-group checkbox lost its id'
  );
  // The question is titled with the numbers of the button that asked it.
  assert.match(
    functionBody('confirmMerge'),
    /title: mergeLabel\(entries\.length, writes\),/,
    'the dialog must say what the button said'
  );
  assert.strictEqual(
    (SCRIPT.match(/confirmDialog\(\{/g) || []).length,
    8,
    'one dialog for a group, one for a batch, one for the verdicts, one for the sheet before a run, one for undo, one for deleting unused objects, one for clearing the mappings, one for clearing the verdict memory'
  );
});

test('The batch dialog lists what goes, and what it moves and deletes', () => {
  const { htmlBatchDialog } = helpers([
    'num',
    'count',
    'plural',
    'countDocuments',
    'htmlBatchLine',
    'htmlCopyRuleCheck',
    'htmlBatchDialog',
  ]);
  const entries = [
    {
      target: { name: 'Rechnung' },
      sources: [{ name: 'rechnungen', documentCount: 37 }],
    },
    {
      target: { name: 'Müller GmbH' },
      sources: [
        { name: 'Mueller <b>', documentCount: 9 },
        { name: 'Müller', documentCount: 1 },
      ],
    },
  ];
  const markup = htmlBatchDialog(entries, [{ name: 'Old' }], true);
  assert.ok(
    markup.includes(
      '<li>rechnungen → <strong>Rechnung</strong> <span class="zr-faint">· 37 documents</span></li>'
    ),
    `a line does not say what goes into what: ${markup}`
  );
  assert.ok(
    markup.includes('Mueller &lt;b&gt;, Müller'),
    'the names are user data and must be escaped'
  );
  assert.ok(
    markup.includes(
      '<li>Old <span class="zr-faint">· 0 documents · delete</span></li>'
    ),
    'an unused object deleted with the batch is not listed'
  );
  assert.ok(
    markup.includes('<p>47 documents moved · 4 deleted</p>'),
    'the totals must count every document and every deletion'
  );
  assert.ok(
    markup.includes('id="dupCopyRuleAll"'),
    'a rule to hand over must be asked about'
  );
  assert.ok(
    !htmlBatchDialog(entries, [], false).includes('dupCopyRuleAll'),
    'a batch without a rule to hand over must not ask about one'
  );
  assert.ok(
    !SCRIPT.includes('Tip:'),
    'the dialog names its numbers, not another way to get there'
  );
});

test('A batch merges group by group through the one merge endpoint', () => {
  // No batch endpoint and no second request shape: the server side stays
  // exactly what a single merge uses.
  assert.strictEqual(
    (SCRIPT.match(/'\/api\/duplicates\/merge'/g) || []).length,
    1,
    'the batch must reuse the single merge request, not add one of its own'
  );
  // Sequential: Paperless-ngx gets one bulk edit at a time.
  assert.match(
    SCRIPT,
    /await mergeGroup\(entry\.card, entry\.state, \{/,
    'the batch does not walk its groups one after the other'
  );
  assert.ok(
    !/Promise\.all|Promise\.allSettled/.test(SCRIPT),
    'the groups must never be merged in parallel'
  );
  // One reload at the end, and nothing else: no rescan, no entity reload.
  assert.match(
    SCRIPT,
    /if \(!batch\) loadLog\(true\);/,
    'a batch step must leave the log reload to the batch'
  );
});

test('The stylesheet carries the selection classes and sticks the bar', () => {
  [
    '.dup-selection',
    '.dup-selection__count',
    '.dup-selection__actions',
    '.dup-selection__progress',
    '.dup-select',
  ].forEach((selector) => {
    assert.ok(
      selectorsOf(CSS).includes(selector),
      `${selector} has no rule of its own`
    );
  });
  assert.match(
    CSS,
    /\.dup-selection \{[^}]*position: sticky;[^}]*top: var\(--zr-topbar-h\);/,
    'the bar must stick below the top bar rather than scroll away'
  );
  // A phone gets the buttons on a line of their own instead of a wider page.
  assert.match(
    CSS,
    /\.dup-selection__actions \{\n\s+margin-left: 0;\n\s+width: 100%;/,
    'the bar does not wrap at phone width'
  );
});

/* ── 9. every group as a list, and the guided flow ────────────────────────── */

test('The view and the page script agree on the toolbar ids', () => {
  [
    'dupEverything',
    'dupResultsBar',
    'dupResultsCount',
    'dupSortSelect',
    'dupMinConfidence',
    'dupSelectMinBtn',
    'dupThresholdCustom',
    'dupReviewThenMergeBtn',
    'dupReviewThenMergeIcon',
    'dupReviewThenMergeLabel',
    'dupMergeSelectedLabel',
  ].forEach((id) => {
    assert.ok(
      SCRIPT.includes(`'${id}'`),
      `the page script never looks up #${id}`
    );
  });
  // The threshold of a scan and of a run is one function, so the custom
  // percent cannot reach one of them and not the other.
  assert.match(
    functionBody('controlOptions'),
    /threshold: currentThreshold\(\),/,
    'the scan row no longer asks for the current threshold'
  );
  assert.match(
    functionBody('runScan'),
    /threshold: String\(asked\.threshold\),/,
    'the scan does not send the threshold it was asked with'
  );
  assert.match(
    functionBody('askForVerdicts'),
    /threshold: asked\.threshold,/,
    'the run does not send the threshold it was asked with'
  );
  assert.match(
    SCRIPT,
    /return percent \/ 100;/,
    'the custom percent is not turned into a 0-1 score'
  );
});

test('Sorting moves the cards instead of rendering them again', () => {
  const body = functionBody('sortResults');
  assert.ok(
    !body.includes('renderGroups'),
    'a re-render would throw away the picks, the ticks and the verdicts'
  );
  assert.ok(
    !body.includes('innerHTML'),
    'the cards must be moved, not rebuilt'
  );
  assert.match(
    body,
    /el\.results\.appendChild\(node\)/,
    'appendChild is what moves a node that is already in the document'
  );
  // The divider between the scan and the model's suggestions stays put, and
  // each block is ordered inside itself.
  assert.match(body, /\.dup-divider/, 'the divider is not taken into account');
  // The handler behind the select does no more than store and re-order.
  const handler =
    /el\.sortSelect\.addEventListener\('change',[\s\S]{0,220}?\}\);/.exec(
      SCRIPT
    );
  assert.ok(handler, 'the sort select has no change handler');
  assert.ok(
    !handler[0].includes('renderGroups') && !handler[0].includes('fetch'),
    'sorting must neither re-render nor re-fetch anything'
  );
});

test('"Select ≥" ticks by confidence and names its number', () => {
  const body = functionBody('selectByMinConfidence');
  assert.match(
    body,
    /selectedGroups\.clear\(\)/,
    'the button must untick what is below the number'
  );
  assert.match(
    body,
    /pct\(state\.group\.confidence\) >= percent/,
    'the card’s own percentage is what the number is compared against'
  );
  assert.match(
    body,
    /check\.disabled/,
    'a group that cannot be merged must never be ticked'
  );
  // The button says its number, and its title how many groups that is.
  const label = functionBody('updateMinConfidenceCount');
  assert.ok(
    label.includes('`Select ≥ ${percent}%`'),
    'the button does not follow its number'
  );
  assert.ok(
    label.includes("plural(matching, 'group', 'groups')"),
    'the title does not count the groups at or above the number'
  );
});

test('Everything the toolbar remembers survives a blocked localStorage', () => {
  [
    'dup.sort',
    'dup.minConfidence',
    'dup.sensitivity',
    'dup.thresholdCustom',
  ].forEach((key) => {
    assert.ok(SCRIPT.includes(`'${key}'`), `${key} is not persisted`);
  });
  // A private window, a blocked origin or a full quota makes either call
  // throw; the page has to come up with its defaults rather than not at all.
  [functionBody('storeRead'), functionBody('storeWrite')].forEach((body) => {
    assert.match(body, /try \{/, 'the access is not wrapped in try/catch');
    assert.match(body, /\} catch/, 'the access is not wrapped in try/catch');
  });
  assert.strictEqual(
    (SCRIPT.match(/window\.localStorage/g) || []).length,
    2,
    'localStorage is touched in exactly the two wrapped helpers'
  );
});

test('The guided flow asks about the selection only, and never merges on its own', () => {
  const body = functionBody('reviewThenMerge');
  assert.match(
    body,
    /groupIds: ids/,
    'the guided review does not narrow the question to the ticked groups'
  );
  assert.match(
    body,
    /includeCandidates: false/,
    'the guided review must not pull in the band below the threshold'
  );
  assert.match(
    body,
    /const ids = entries\.map\(/,
    'the ids come from the selection'
  );
  // An error is reported where a full review reports, and no dialog opens.
  assert.match(
    body,
    /htmlReviewFailure\(error\.message\)/,
    'a failed review must say so above the results'
  );
  assert.match(body, /if \(!asked\) return;/, 'a failed review opens a dialog');
  // The path without a model never asks one.
  const plain = functionBody('mergeSelected');
  ['ai-review', 'askForVerdicts', 'aiVerdict'].forEach((needle) => {
    assert.ok(
      !plain.includes(needle),
      `"Merge selected" must work without the review (${needle})`
    );
  });
  assert.strictEqual(
    (SCRIPT.match(/'\/api\/duplicates\/ai-review\/jobs'/g) || []).length,
    1,
    'both review paths start the one job'
  );
});

test('The review dialog shows verdicts and merges what stays ticked', () => {
  // Its markup goes through the escaping scanner above like every other
  // template; what is checked here is that the untrusted parts go through esc.
  const row = functionBody('htmlReviewRow');
  ['esc(targetName)', 'esc(names)', 'esc(reason)'].forEach((call) => {
    assert.ok(row.includes(call), `the review row writes ${call} unescaped`);
  });
  assert.match(
    row,
    /const reason = verdict \? shortReason\(verdict\.reason\) : '';/,
    'the model’s sentence is not cut to length'
  );
  // Pre-ticked by the rule the cards follow: two signs, and never a pair
  // only the model proposed. Any row can be ticked by hand.
  assert.match(
    row,
    /isProposed\(group\) \? ' checked' : ''/,
    'the ticks must follow the pre-tick rule'
  );
  assert.match(
    SCRIPT,
    /class="zr-check dup-review-pick"/,
    'the rows have no pick check'
  );
  // Stacks on a phone: every cell carries its column name.
  assert.match(SCRIPT, /class="zr-table zr-table--stack dup-review-table"/);
  ['Merge', 'Group', 'Documents', 'Model', 'Why'].forEach((label) => {
    assert.ok(
      SCRIPT.includes(`data-label="${label}"`),
      `the review table has no data-label="${label}"`
    );
  });
  assert.ok(
    SCRIPT.includes('ticked · '),
    'the foot line does not count what is ticked'
  );
  assert.match(
    SCRIPT,
    /dialog\.classList\.add\('zr-dialog--wide', 'dup-review-dialog'\)/,
    'the table needs the wide dialog'
  );
  // The batch machinery does the merging, unchanged.
  assert.match(
    functionBody('confirmReviewedBatch'),
    /await runBatch\(ticked, copyMatchingRule\(\)\)/,
    'the review dialog must merge through the batch runner'
  );
});

test('The stylesheet carries the toolbar and review classes', () => {
  [
    '.dup-everything',
    '.dup-results-bar',
    '.dup-results-bar__title',
    '.dup-results-bar__count',
    '.dup-results-bar__minrow',
    '.dup-review-table',
    '.dup-review__reason',
  ].forEach((selector) => {
    assert.ok(
      selectorsOf(CSS).includes(selector),
      `${selector} has no rule of its own`
    );
  });
  assert.ok(
    CSS.includes('.dup-review-pick') || SCRIPT.includes('dup-review-pick'),
    'the pick check has no class'
  );
  // The order is one short word and keeps its width; on a phone the button
  // of "Select ≥" takes the rest of its line rather than widening the page.
  assert.match(
    CSS,
    /\.dup-results-bar \.zr-select \{\n\s+width: auto;/,
    'the sort select stretches over the whole bar'
  );
  assert.match(
    CSS,
    /@media \(max-width: 720px\) \{\n\s+\.dup-results-bar__minrow \.zr-btn \{\n\s+flex: 1 1 auto;/,
    'the toolbar does not wrap at phone width'
  );
});

/* ── 10. the two ways to the model ────────────────────────────────────────── */
/* "Find duplicates" of the assistant scans and asks about everything, and
   "Ask the model" of the scan row asks about the scan on the page; both
   open the sheet first and send what its levers say. What is checked here is
   that the model stays an addition: the requests are the ones the job route
   knows, and nothing of the paths without a model asks one. */

test('Find duplicates scans, opens the sheet, and asks about everything', () => {
  const body = functionBody('findDuplicates');
  // Without the model the button is a scan and nothing else.
  assert.match(
    body,
    /if \(!aiReviewOffered\(\)\) \{\n\s+await runScan\(options\);\n\s+return;\n\s+\}/,
    'without the model the one button must scan and stop there'
  );
  assert.match(
    body,
    /const options = controlOptions\(\);/,
    'the button scans with what the scan row shows'
  );
  // With it, the free scan comes first, on the meter, so the sheet opens
  // with its numbers; the model is asked only after Start.
  const scan = body.indexOf('await runScan(options, { withModel: true });');
  const stop = body.indexOf('if (!scanned) return;');
  const sheet = body.indexOf('await confirmRun(options)');
  const ask = body.indexOf('askForVerdicts(');
  assert.ok(scan > -1, 'the one button must scan on the run meter');
  assert.ok(
    scan < stop && stop < sheet && sheet < ask,
    'the order must be scan, a failed scan stops, the sheet, the model'
  );
  assert.match(
    body,
    /askForVerdicts\(\{ includeCandidates: true \}, options\)/,
    'the button must have the near-misses judged as well'
  );
  assert.ok(
    !body.includes('groupIds'),
    'the button asks about everything; narrowing it is the guided path'
  );
  ['fetch(', 'postJson(', 'requestJson('].forEach((call) => {
    assert.ok(
      !body.includes(call),
      `the button must not send ${call} itself: the scan and the job are it`
    );
  });
  // "Ask the model" of the scan row opens the same sheet.
  assert.match(
    functionBody('runAiReview'),
    /if \(!\(await confirmRun\(options\)\)\) return;/,
    'the run of the scan row must price itself first as well'
  );
});

test('Every run sends the levers of the sheet through the one job route', () => {
  const ask = functionBody('askForVerdicts');
  [
    'withTitles: levers.titles,',
    'withExcerpts: levers.excerpts,',
    'semanticSweep: levers.sweep,',
  ].forEach((line) => {
    assert.ok(ask.includes(line), `the run does not send ${line}`);
  });
  // The lanes of the sheet are sent only after a Start chose them; a run that
  // opened no sheet runs with what the settings say.
  assert.ok(
    ask.includes('...(runLanes === null ? {} : { concurrency: runLanes }),'),
    'the lanes of the sheet do not reach the run'
  );
  assert.match(
    functionBody('confirmRun'),
    /Object\.assign\(levers, draft\);\n\s+runLanes = draft\.lanes;/,
    'Start must keep the levers and the lanes for the run'
  );
  assert.strictEqual(
    (SCRIPT.match(/'\/api\/duplicates\/ai-review\/jobs'/g) || []).length,
    1,
    'every way to the model starts the one job'
  );
  // The page without a model is untouched: "Merge" of the bar asks nobody.
  const plain = functionBody('mergeSelected');
  ['ai-review', 'askForVerdicts', 'aiVerdict', 'confirmRun'].forEach(
    (needle) => {
      assert.ok(
        !plain.includes(needle),
        `"Merge" must work without the model (${needle})`
      );
    }
  );
});

test('Only a settled "same" is a sign for a tick', () => {
  const { isSureSame } = helpers(['isSureSame']);
  // What the model is sure about, and what a spelling rule settled without it.
  assert.strictEqual(
    isSureSame({ verdict: 'same', confidence: 'high', source: 'model' }),
    true
  );
  assert.strictEqual(
    isSureSame({
      verdict: 'same',
      confidence: 'high',
      source: 'spelling-rule',
    }),
    true
  );
  // Everything else waits for a person, including a "same" without a
  // confidence, which is what an older answer and a failed request look like.
  [
    { verdict: 'same', confidence: 'low' },
    { verdict: 'same', confidence: null },
    { verdict: 'same' },
    { verdict: 'unsure', confidence: 'high' },
    { verdict: 'different', confidence: 'high' },
    null,
    undefined,
  ].forEach((verdict) => {
    assert.strictEqual(
      isSureSame(verdict),
      false,
      `${JSON.stringify(verdict)} must not come up ticked`
    );
  });
  // The sign is read by the one rule, and the verdict dialog uses the rule.
  assert.match(
    functionBody('isProposed'),
    /return isSureSame\(verdict\);/,
    'the rule no longer reads the sign'
  );
  assert.match(
    functionBody('htmlReviewRow'),
    /isProposed\(group\)/,
    'the row renderer no longer uses the pre-tick rule'
  );
  assert.strictEqual(
    (SCRIPT.match(/htmlReviewRow\(entry, '/g) || []).length,
    1,
    'the verdict dialog is the one place that draws verdict rows'
  );
});

test('The page labels every basis the contract lists', () => {
  const schemas = read('schemas.js');
  const block = /AiVerdict:[\s\S]*?basis:([\s\S]*?)confidence:/.exec(schemas);
  assert.ok(block, 'AiVerdict.basis is gone from schemas.js');
  const description = block[1].replace(/\n\s*\*/g, ' ');
  const listed = /one of ([^;]*?), or null/.exec(description);
  assert.ok(listed, 'the basis description no longer lists its values');
  const values = listed[1]
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  assert.ok(values.length >= 10, `only ${values.length} basis values parsed`);

  const map = /const AI_BASIS_LABELS = \{([\s\S]*?)\n\};/.exec(SCRIPT);
  assert.ok(map, 'the page has no basis label map');
  const labelled = [...map[1].matchAll(/^\s*'?([a-z-]+)'?:\s*'([^']+)'/gm)].map(
    (match) => ({ value: match[1], label: match[2] })
  );
  values.forEach((value) => {
    assert.ok(
      labelled.some((entry) => entry.value === value),
      `the page has no label for the basis "${value}"`
    );
  });
  // The wording of two of them, because they are the ones that read wrong when
  // taken straight from the wire value.
  assert.ok(
    labelled.some(
      (entry) =>
        entry.value === 'case-or-spacing' && entry.label === 'Case/spacing'
    ),
    'case-or-spacing is not worded for a badge'
  );
  assert.ok(
    labelled.some(
      (entry) =>
        entry.value === 'insufficient-evidence' &&
        entry.label === 'Not enough evidence'
    ),
    'insufficient-evidence is not worded for a badge'
  );
  // It is a badge in both dialogs and a title on the cards; no new column.
  assert.match(
    functionBody('htmlBasisBadge'),
    /class="zr-badge dup-basis"/,
    'the basis is not rendered as a badge'
  );
  assert.match(
    functionBody('verdictTitle'),
    /basisLabel\(verdict\)/,
    'the card chip does not carry the basis in its title'
  );
});

test('A verdict a spelling rule settled says so instead of quoting a model', () => {
  assert.ok(
    SCRIPT.includes("const AI_SOURCE_RULE = 'spelling-rule'"),
    'the page does not know the spelling-rule verdict source'
  );
  assert.ok(
    SCRIPT.includes("const AI_RULE_LABEL = 'Spelling rule'"),
    'the chip of a settled pair is not labelled'
  );
  const chip = functionBody('htmlVerdictChip');
  assert.match(
    chip,
    /isRuleVerdict\(verdict\)/,
    'the chip does not tell a spelling rule from a model'
  );
  assert.match(
    chip,
    /htmlVerdictIcons\.same/,
    'a settled pair must wear the tick of a "same"'
  );
  assert.match(
    chip,
    /title="\$\{esc\(shortReason\(verdict\.reason\)\)\}"/,
    'the rule chip must carry the reason as its title'
  );
  // The tone exists in both the script and the stylesheet.
  assert.ok(
    SCRIPT.includes('dup-verdict--rule'),
    'the rule verdict has no tone class'
  );
  ['.dup-verdict--rule', '.dup-verdict__confidence', '.dup-basis'].forEach(
    (selector) => {
      assert.ok(
        selectorsOf(CSS).includes(selector),
        `${selector} has no rule of its own`
      );
    }
  );
  // The confidence is a suffix of the verdict, not a column and not a chip.
  assert.match(
    functionBody('htmlConfidenceSuffix'),
    /class="dup-verdict__confidence"/,
    'the confidence is not rendered as a suffix'
  );
  assert.match(
    functionBody('confidenceLabel'),
    /AI_CONFIDENCE_LABELS\[value\] \|\| ''/,
    'an answer without a confidence must render none'
  );
});

test('The member tables line up across cards whatever the names are', () => {
  // With the automatic layout every card measures its own content, so a card
  // of short tags puts its columns somewhere else than the card below it.
  assert.match(
    CSS,
    /\.dup-members \{\n\s+table-layout: fixed;\n\s+width: 100%;\n\s+\}/,
    'the member table does not fix its layout'
  );
  ['.dup-members__name', '.dup-members__rule'].forEach((selector) => {
    assert.ok(
      selectorsOf(CSS).includes(selector),
      `${selector} has no rule of its own, so its column has no width`
    );
  });
  assert.match(
    CSS,
    /\.dup-members__rule \{\n\s+width: \d+%;/,
    'the matching-rule column has no share of the row'
  );
  // Every column the widths apply to carries its class in the markup, header
  // and cell alike, and the stacked rows keep their labels.
  ['dup-members__name', 'dup-members__rule'].forEach((cls) => {
    assert.ok(
      new RegExp(`<th class="${cls}">`).test(SCRIPT),
      `the header cell of .${cls} is missing`
    );
    assert.ok(
      new RegExp(`<td data-label="[^"]+" class="${cls}">`).test(SCRIPT),
      `the body cell of .${cls} is missing`
    );
  });
  ['Name', 'Matching rule'].forEach((label) => {
    assert.ok(
      SCRIPT.includes(`data-label="${label}"`),
      `the member table lost data-label="${label}"`
    );
  });
  // Stacked on a phone the fixed widths would cut every name off mid-word.
  assert.match(
    CSS,
    /\.dup-members__score,\n\s+\.dup-members__rule \{\n\s+width: auto;/,
    'the rule column keeps its desktop width on a phone'
  );
});

/* ── 11. the run as a watchable job ───────────────────────────────────────── */
/* A run is many model requests in a row, so the server runs it as a job and
   the page watches it: a bar, what it costs, how long it still needs, and a
   Stop button. What is checked here is that the meter exists only where the
   model is offered, that the pure helpers word the numbers the way the page
   promises, and that the script really streams (with a fallback) instead of
   waiting for one long POST. */

test('The run meter is on every page, and Stop only where a model runs', () => {
  const offered = renderOffered();
  // A scan runs on the meter too, so the meter is there without the model.
  [
    'dupAiProgress',
    'dupAiProgressBar',
    'dupAiProgressFill',
    'dupAiProgressMessage',
    'dupRunPosition',
    'dupRunRest',
    'dupRunCeiling',
  ].forEach((id) => {
    [offered, page].forEach((markup) => {
      assert.ok(markup.includes(`id="${id}"`), `#${id} is missing`);
    });
  });
  // A scan cannot be stopped; only a run of the model can.
  assert.ok(offered.includes('id="dupAiStopBtn"'));
  assert.ok(
    !page.includes('id="dupAiStopBtn"'),
    'nothing can be stopped without the model'
  );
  assert.match(
    functionBody('aiReviewOffered'),
    /return Boolean\(el\.aiReviewBtn\);/,
    'the meter on the page no longer says whether a model is offered'
  );
  // Hidden until a run runs, and a live region so a screen reader hears it.
  assert.match(
    offered,
    /class="dup-progress zr-runmeter hidden" id="dupAiProgress" role="status" aria-live="polite"/,
    'the meter is not a hidden live region'
  );
  assert.match(
    offered,
    /class="zr-btn" id="dupAiStopBtn"/,
    'Stop is the quiet button of the row, one word and no second line'
  );
  assert.match(
    offered,
    /id="dupAiStopBtn"[\s\S]{0,200}icons\.svg#i-x/,
    'the Stop button has no i-x icon'
  );
  assert.match(
    offered,
    /<span class="dup-progress__stop-label">Stop<\/span>/,
    'the label is not addressable, so "Stopping…" cannot replace it'
  );
  assert.match(
    offered,
    /id="dupAiProgressBar" role="progressbar" aria-label="Run progress"/,
    'the bar does not say what it measures'
  );
});

test('The page words tokens and time through the shared sheet module', () => {
  assert.match(
    SCRIPT,
    /import \{\n\s+htmlSheet,\n\s+updateSheet,\n\s+bindSheet,\n\s+formatTokens,\n\s+roughTime,\n\} from '\/js\/modules\/review-sheet\.js';/,
    'the sheet and its two formatters come from the shared module'
  );
  ['formatTokens', 'roughTime'].forEach((name) => {
    assert.ok(
      !SCRIPT.includes(`function ${name}(`),
      `a second ${name}() would word the same number another way`
    );
  });
  // The numbers the page promises, read through the module it imports.
  assert.strictEqual(SHEET.formatTokens(980), '980');
  assert.strictEqual(SHEET.formatTokens(12400), '12k');
  assert.strictEqual(SHEET.formatTokens(200000), '200k');
});

test('formatEta says how long, and nothing when it does not know', () => {
  const { formatEta } = helpers(['formatEta']);
  assert.strictEqual(formatEta(null), '', 'no estimate is no sentence');
  assert.strictEqual(formatEta(undefined), '');
  assert.strictEqual(formatEta(-5), '');
  assert.strictEqual(formatEta(3000), 'almost done');
  assert.strictEqual(formatEta(40000), 'about 40 s left');
  assert.strictEqual(formatEta(59400), 'about 59 s left');
  assert.strictEqual(formatEta(180000), 'about 3 min left');
  assert.strictEqual(formatEta(60000), 'about 1 min left');
});

test('formatElapsed counts up the way a clock does', () => {
  const { formatElapsed } = helpers(['formatElapsed']);
  assert.strictEqual(formatElapsed(0), '0:00');
  assert.strictEqual(formatElapsed(7000), '0:07');
  assert.strictEqual(formatElapsed(84000), '1:24');
  assert.strictEqual(formatElapsed(3723000), '1:02:03');
  assert.strictEqual(formatElapsed(-10), '0:00');
  assert.strictEqual(formatElapsed(null), '0:00');
});

test('progressPercent is null while the plan is unknown', () => {
  const { progressPercent } = helpers(['progressPercent']);
  assert.strictEqual(
    progressPercent({ requestsDone: 0, requestsPlanned: null }),
    null,
    'an unknown plan must show the indeterminate bar, not 0 %'
  );
  assert.strictEqual(progressPercent({}), null);
  assert.strictEqual(progressPercent(null), null);
  assert.strictEqual(
    progressPercent({ requestsDone: 0, requestsPlanned: 8 }),
    0
  );
  assert.strictEqual(
    progressPercent({ requestsDone: 3, requestsPlanned: 8 }),
    38
  );
  assert.strictEqual(
    progressPercent({ requestsDone: 8, requestsPlanned: 8 }),
    100
  );
  assert.strictEqual(
    progressPercent({ requestsDone: 12, requestsPlanned: 8 }),
    100,
    'a re-asked batch must not push the bar past its track'
  );
});

test('stopNotice says why a run ended and what it did not ask', () => {
  const { stopNotice } = helpers(['num', 'plural', 'stopNotice']);
  const progress = (extra) =>
    Object.assign(
      {
        requestsDone: 3,
        requestsPlanned: 8,
        pairsJudged: 40,
        pairsTotal: 96,
        tokenBudget: null,
      },
      extra
    );
  assert.strictEqual(
    stopNotice({ stopReason: 'user', progress: progress() }),
    'Stopped after 3 of 8 requests · 56 pairs not asked'
  );
  assert.strictEqual(
    stopNotice({
      stopReason: 'token-budget',
      progress: progress({ requestsDone: 5, tokenBudget: 200000 }),
    }),
    'Stopped at the 200k limit after 5 requests · 56 pairs not asked'
  );
  assert.strictEqual(
    stopNotice({ stopReason: 'idle', progress: progress() }),
    'Stopped · no page was watching · 56 pairs not asked'
  );
  // Nothing left over is still a number, and so is a plan nobody made.
  assert.strictEqual(
    stopNotice({
      stopReason: 'user',
      progress: progress({ pairsJudged: 96 }),
    }),
    'Stopped after 3 of 8 requests · 0 pairs not asked'
  );
  assert.strictEqual(
    stopNotice({
      stopReason: 'user',
      progress: progress({ requestsPlanned: null, pairsTotal: null }),
    }),
    'Stopped after 3 requests'
  );
  assert.strictEqual(
    stopNotice({
      stopReason: 'user',
      progress: progress({ pairsJudged: 95 }),
    }),
    'Stopped after 3 of 8 requests · 1 pair not asked'
  );
});

test('The page follows the review through the job routes and an event stream', () => {
  const follow = functionBody('followReviewJob');
  assert.ok(
    follow.includes('new EventSource('),
    'the review is watched, not waited for'
  );
  assert.ok(
    follow.includes('`${base}/events`'),
    'the stream is the events route of the job'
  );
  ['progress', 'failed', 'stopped'].forEach((type) => {
    assert.ok(
      follow.includes(`'${type}'`),
      `the page does not handle the ${type} event`
    );
  });
  // The three AI paths all end in askForVerdicts, which starts the job.
  const ask = functionBody('askForVerdicts');
  assert.ok(
    ask.includes("'/api/duplicates/ai-review/jobs'"),
    'the review is not started as a job'
  );
  assert.match(
    ask,
    /status === 409 && job/,
    'a running review must be attached to, not reported as a failure'
  );
  assert.ok(
    /followReviewJob\(\n?\s*job,/.test(ask),
    'the started job is not followed'
  );
  // Stop is one request and no dialog; the verdicts already reached are kept.
  const stop = functionBody('stopReview');
  assert.match(stop, /\/stop`/, 'the Stop button does not call the stop route');
  assert.ok(
    !/confirmDialog/.test(stop),
    'stopping must not ask a question: Stop is already the decision'
  );
  assert.ok(
    stop.includes("setStopLabel('Stopping…')"),
    'the button does not say what it is doing'
  );
});

test('A broken stream falls back to polling, and a reload re-attaches', () => {
  const follow = functionBody('followReviewJob');
  assert.ok(
    follow.includes('source.onerror'),
    'a stream that dies is not noticed'
  );
  assert.ok(
    follow.includes('startPolling()'),
    'there is no fallback for a proxy that closes the stream'
  );
  assert.match(
    SCRIPT,
    /const REVIEW_POLL_MS = 2000;/,
    'the fallback asks at another interval than the one promised'
  );
  assert.ok(
    follow.includes('window.setInterval(pollOnce, REVIEW_POLL_MS)'),
    'the fallback does not poll the job'
  );
  // The reload path: ask what is running, follow it, and leave a finished
  // review alone.
  const reattach = functionBody('reattachReview');
  assert.ok(
    reattach.includes("'/api/duplicates/ai-review/jobs/current'"),
    'the page does not ask whether a review is running'
  );
  assert.ok(
    reattach.includes('REVIEW_LIVE_STATES.includes(job.status)'),
    'a finished job must not be replayed on every reload'
  );
  assert.ok(
    reattach.includes('followReviewJob(job)'),
    'the running review is not followed after a reload'
  );
  assert.match(
    SCRIPT,
    /const REVIEW_LIVE_STATES = \['running', 'stopping'\];/,
    'the two live states are not the ones the job service reports'
  );
  assert.match(
    functionBody('init'),
    /reattachReview\(\)/,
    'nothing re-attaches when the page loads'
  );
});

test('The answer of a Stop request cannot paint over a finished review', () => {
  // The stream can end the job before the stop request answers; that late
  // snapshot from the stopping moment must not replace the outcome line or
  // restart the elapsed clock.
  const stop = functionBody('stopReview');
  assert.ok(
    stop.includes('reviewJobId === id'),
    'the stop answer is rendered even when the review is no longer followed'
  );
  assert.ok(
    stop.includes('REVIEW_LIVE_STATES.includes(job.status)'),
    'the stop answer is rendered even when the job already finished'
  );
});

test('The stylesheet carries the progress panel and stops its animation', () => {
  [
    '.dup-progress',
    '.dup-progress__bar',
    '.dup-progress__fill',
    '.dup-progress__fill--indeterminate',
  ].forEach((selector) => {
    assert.ok(
      selectorsOf(CSS).includes(selector),
      `${selector} has no rule of its own`
    );
  });
  // The bar moves; nothing else does.
  assert.match(
    CSS,
    /\.dup-progress__fill \{[^}]*transition: width 200ms/,
    'the fill does not ease into its new width'
  );
  assert.match(
    CSS,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.dup-progress__fill--indeterminate \{\s*animation: none;/,
    'the sliding band keeps sliding for someone who asked it not to'
  );
  // The panel is the shared run meter now: a headline, a bar, three numbers,
  // the split and the log, with nothing left to reserve a row for.
  assert.ok(
    !CSS.includes('.dup-progress__text'),
    'the four stacked text lines are gone, and so is the rule that spaced them'
  );
});

/* ── 12. inside one request ───────────────────────────────────────────────── */
/* A request that asks about eighty pairs takes minutes, and a meter that only
   moves between requests shows nothing for all of it. The judge streams its
   answers, measures the model on a small first request and says when it is
   thinking; every one of those has to reach the page. */

test('progressPercent counts the answers that streamed in', () => {
  const { progressPercent } = helpers(['progressPercent']);
  // Pairs win over requests: the batch size changes after the warm-up, so a
  // request is no fixed amount of work, and the answers of the running one
  // are work that is done.
  assert.strictEqual(
    progressPercent({
      requestsDone: 1,
      requestsPlanned: 9,
      pairsJudged: 34,
      pairsTotal: 82,
      requestAnswers: 7,
    }),
    50,
    '(34 + 7) of 82 pairs is half the review, not one ninth of it'
  );
  assert.strictEqual(
    progressPercent({ pairsJudged: 0, pairsTotal: 82, requestAnswers: 0 }),
    0
  );
  assert.strictEqual(
    progressPercent({ pairsJudged: 82, pairsTotal: 82, requestAnswers: 4 }),
    100,
    'a re-asked batch must not push the bar past its track'
  );
  // No pair count yet: the request plan is the fallback, exactly as before.
  assert.strictEqual(
    progressPercent({ requestsDone: 3, requestsPlanned: 8, pairsTotal: null }),
    38
  );
  assert.strictEqual(
    progressPercent({ requestsDone: 2, pairsTotal: 0, requestAnswers: 5 }),
    null,
    'zero pairs is not a share to show; nothing is known yet'
  );
});

test('The headline is the phase, not the sentence that flickers under it', () => {
  const { phaseHeadline } = helpers(['phaseHeadline']);
  // The phase is what stays put while a request thinks.
  assert.strictEqual(
    phaseHeadline({ phase: 'warming-up', message: 'The model is thinking…' }),
    'Measuring the model'
  );
  assert.strictEqual(phaseHeadline({ phase: 'judging' }), 'Asking the model');
  assert.strictEqual(
    phaseHeadline({ phase: 'sweeping' }),
    'Looking at the whole list'
  );
  // A phase nobody mapped falls back to what the job said, never to silence.
  assert.strictEqual(
    phaseHeadline({ phase: 'brand-new', message: 'Waiting for the scan…' }),
    'Waiting for the scan…'
  );
  assert.strictEqual(phaseHeadline({}), 'Working');
});

test('The panel says its phase once, and shows that the model is thinking', () => {
  const offered = renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  // One headline, one bar, three numbers, the split, the ceiling, the log,
  // and none of the four text lines that used to repeat each other.
  ['dupAiProgressCounts', 'dupAiProgressNote', 'dupAiProgressEta'].forEach(
    (id) => {
      assert.ok(
        !offered.includes(`id="${id}"`),
        `#${id} said what the ledger and the log say better`
      );
    }
  );
  assert.ok(
    offered.indexOf('id="dupAiProgressMessage"') <
      offered.indexOf('id="dupRunPosition"') &&
      offered.indexOf('id="dupRunLedger"') <
        offered.indexOf('id="dupRunCeiling"') &&
      offered.indexOf('id="dupRunCeiling"') < offered.indexOf('id="dupRunLog"'),
    'the panel reads top to bottom: what, how far, how much, what each cost'
  );
  // The Stop sits in the headline row rather than under everything.
  assert.ok(
    offered.indexOf('id="dupAiStopBtn"') <
      offered.indexOf('id="dupRunPosition"'),
    'Stop belongs next to what it would stop'
  );

  const render = functionBody('renderProgress');
  assert.ok(
    render.includes("'dup-progress__fill--thinking'"),
    'nothing shows that the model is thinking'
  );
  assert.ok(
    render.includes('phaseHeadline(state)'),
    'the headline is never written'
  );
  // The panel of a review that has finished says none of this any more: it
  // steps down, and the assistant sums the run up as its result.
  const outcome = functionBody('renderProgressOutcome');
  assert.ok(
    outcome.includes("classList.remove('dup-progress__fill--thinking')"),
    'a finished review keeps pulsing'
  );
  assert.ok(
    outcome.includes('renderAssist();'),
    'a finished review does not hand over to the result'
  );
  ['progressCountsText', 'progressOutcomeText'].forEach((name) => {
    assert.ok(
      !SCRIPT.includes(`function ${name}(`),
      `${name}() wrote a line nobody sees any more`
    );
  });
  // The row is held open only while a review runs, so the tiles below do not
  // jump the moment the warm-up fills it.
  assert.ok(
    functionBody('showProgressPanel').includes("'dup-progress--live'"),
    'the panel has no reserved row while a review runs'
  );
});

test('A failed run points at the settings that could have prevented it', () => {
  const failure = functionBody('htmlReviewFailure');
  assert.ok(
    failure.includes('esc(text)'),
    'the message of a failed run must be escaped like everything else'
  );
  assert.ok(
    failure.includes('href="/settings#duplicates-tab"'),
    'the link must land on the Duplicates section, not on the settings page'
  );
  assert.ok(
    failure.includes('>Duplicates settings</a>'),
    'the link is named after the place it opens'
  );
  assert.ok(
    failure.includes('>Run failed</div>'),
    'the notice does not say what failed'
  );
  // One link, and every path that reports a failed run uses it.
  assert.strictEqual(
    (SCRIPT.match(/Duplicates settings/g) || []).length,
    1,
    'the settings link is written once, not copied into every catch block'
  );
  assert.strictEqual(
    (SCRIPT.match(/htmlReviewFailure\(error\.message\)/g) || []).length,
    4,
    'the reattach, both ways to the model and the guided flow must all report a failure the same way'
  );
});

test('The stylesheet pulses while the model thinks, and stops for reduced motion', () => {
  ['.dup-progress__fill--thinking'].forEach((selector) => {
    assert.ok(
      selectorsOf(CSS).includes(selector),
      `${selector} has no rule of its own`
    );
  });
  assert.match(
    CSS,
    /\.dup-progress__fill--thinking \{[^}]*animation: dupProgressThink/,
    'the thinking fill does not pulse'
  );
  assert.match(
    CSS,
    /@keyframes dupProgressThink \{/,
    'the pulse has no keyframes'
  );
  // Slower than the sliding band: waiting is not progress.
  const think = /animation: dupProgressThink ([\d.]+)s/.exec(CSS);
  const slide = /animation: dupProgressSlide ([\d.]+)s/.exec(CSS);
  assert.ok(think && slide, 'one of the two animations is gone');
  assert.ok(
    Number(think[1]) > Number(slide[1]),
    'the thinking pulse must be calmer than the indeterminate band'
  );
  assert.match(
    CSS,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.dup-progress__fill--thinking \{\s*animation: none;/,
    'the pulse keeps pulsing for someone who asked it not to'
  );
});

/* ── 13. a name for the survivor ──────────────────────────────────────────── */
/* A group of spellings often has no member that is the name the archive
   should end up with. The single dialog therefore carries a field; the batch
   and the verdict dialog keep every target's name, because one field cannot
   stand for a dozen groups. */

test('The merge dialog asks for the name of the survivor', () => {
  assert.ok(
    SCRIPT.includes('id="dupTargetName"'),
    'the merge dialog has no name field'
  );
  assert.ok(
    SCRIPT.includes(
      '<label class="dup-dialog__field" for="dupTargetName"><span class="zr-label">Name</span>'
    ),
    'the name field is not labelled'
  );
  assert.match(
    SCRIPT,
    /const MAX_TARGET_NAME = 128;/,
    'the page must cap the name where the route caps it'
  );
  assert.match(
    SCRIPT,
    /id="dupTargetName" maxlength="\$\{num\(MAX_TARGET_NAME\)\}"/,
    'the field must carry the same maximum the route enforces'
  );
  // Prefilled with the name it has, so leaving it alone is the default and
  // a rename is something done on purpose.
  assert.match(
    SCRIPT,
    /id="dupTargetName"[^`]*value="\$\{esc\(targetName\)\}"/,
    'the field must come up with the target name'
  );

  // The field belongs to htmlMergeDialog, which is the one dialog both the
  // group card and "Merge by hand" go through.
  const dialog = SCRIPT.slice(
    SCRIPT.indexOf('function htmlMergeDialog('),
    SCRIPT.indexOf('function mergeTargetName(')
  );
  assert.ok(
    dialog.includes('dupTargetName'),
    'the field must live in the dialog both merge paths share'
  );
  ['htmlBatchDialog', 'htmlReviewDialog'].forEach((name) => {
    const start = SCRIPT.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `${name}() is gone`);
    const body = SCRIPT.slice(start, SCRIPT.indexOf('\n}\n', start));
    assert.ok(
      !body.includes('dupTargetName'),
      `${name} must keep the names of its groups, not rename them all at once`
    );
  });
});

test('mergeTargetName sends a name only when it changed', () => {
  const { mergeTargetName } = helpers(['mergeTargetName'], {
    globals: { MAX_TARGET_NAME: 128 },
  });
  // Unchanged is silence: a merge that renamed the target to the name it
  // already has would write a pointless "renamed from" into the log.
  assert.strictEqual(mergeTargetName('Amazon', 'Amazon'), null);
  assert.strictEqual(mergeTargetName('Amazon', '  Amazon  '), null);
  assert.strictEqual(mergeTargetName('Amazon', ''), null);
  assert.strictEqual(mergeTargetName('Amazon', '   '), null);
  assert.strictEqual(mergeTargetName('Amazon', null), null);
  assert.strictEqual(mergeTargetName(null, ''), null);

  assert.strictEqual(
    mergeTargetName('Amazon', '  Amazon EU S.a.r.l. '),
    'Amazon EU S.a.r.l.',
    'a new name arrives trimmed'
  );
  // Case is a change: "amazon" and "Amazon" are two objects in Paperless-ngx.
  assert.strictEqual(mergeTargetName('Amazon', 'amazon'), 'amazon');
  assert.strictEqual(
    mergeTargetName('Amazon', 'x'.repeat(200)).length,
    128,
    'a pasted essay is cut where the route would refuse it'
  );
});

test('The merge request carries targetName only when the dialog changed it', () => {
  assert.match(
    SCRIPT,
    /\.\.\.\(renameTo === null \? \{\} : \{ targetName: renameTo \}\),/,
    'an unchanged name must not be part of the request at all'
  );
  // A batch answered one dialog for all of its groups, and that dialog has no
  // name field; the rename must stay null on that path.
  assert.match(
    SCRIPT,
    /\/\/ A batch keeps the names of its groups; only the single dialog offers one\.\n\s+let renameTo = null;/,
    'a batch step must not carry a rename'
  );
  assert.match(
    SCRIPT,
    /const nameField = document\.getElementById\('dupTargetName'\);/,
    'the dialog value must be captured while the dialog is open'
  );
});

/* ── 14. unused objects ───────────────────────────────────────────────────── */

test('The view carries the Unused section, hidden until a scan ran', () => {
  [
    'dupUnused',
    'dupUnusedSummary',
    'dupUnusedAlert',
    'dupUnusedBody',
    'dupUnusedSelectAllBtn',
    'dupUnusedDeleteBtn',
  ].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
  });
  assert.match(
    page,
    /<details class="zr-module dup-unused hidden" id="dupUnused">/,
    'the section must be a closed drawer and hidden until a scan looked'
  );
  assert.match(
    page,
    /id="dupUnusedDeleteBtn"[^>]*disabled/,
    'the delete button must start disabled; nothing is selected yet'
  );
  assert.match(
    page,
    /class="zr-btn zr-btn--danger" id="dupUnusedDeleteBtn"/,
    'deleting objects is a danger-toned action, like every other delete'
  );
  assert.match(
    page,
    /id="dupUnusedDeleteBtn"[\s\S]{0,140}icons\.svg#i-trash/,
    'the delete button has no i-trash icon'
  );
  // The head counts, and the button says how many it would delete.
  assert.ok(
    page.includes(
      'Unused <span class="dup-summary__count" id="dupUnusedSummary">· 0</span>'
    ),
    'the drawer head does not count its rows'
  );
  assert.match(
    page,
    /id="dupUnusedDeleteBtn"[\s\S]{0,200}Delete 0\s*<\/button>/,
    'the delete button does not carry its number'
  );
  // It sits between the results and the log: the log is where its undo is.
  assert.ok(
    page.indexOf('id="dupResults"') < page.indexOf('id="dupUnused"') &&
      page.indexOf('id="dupUnused"') < page.indexOf('id="dupLog"'),
    'the section belongs under the results and above the log'
  );
});

test('unusedFromScan flattens what a scan called unused', () => {
  const { unusedFromScan } = helpers(['unusedFromScan']);
  assert.deepStrictEqual(unusedFromScan(null), []);
  assert.deepStrictEqual(unusedFromScan({}), [], 'a scan of round 8 has none');
  assert.deepStrictEqual(unusedFromScan({ unused: {} }), []);
  assert.deepStrictEqual(
    unusedFromScan({ unused: { tags: null, correspondents: 'nope' } }),
    [],
    'a malformed answer must not throw the section away'
  );

  const rows = unusedFromScan({
    unused: {
      correspondents: [{ id: 5, name: 'Nobody' }],
      tags: [{ id: 1, name: 'Old' }, { id: 2, name: 'Older' }, { name: 'x' }],
    },
  });
  assert.deepStrictEqual(
    rows.map((row) => `${row.kind}:${row.record.id}`),
    ['tags:1', 'tags:2', 'correspondents:5'],
    'tags come first, and an entry without an id is not a row'
  );
});

test('unusedConfirmText names the number and the kind', () => {
  const { unusedConfirmText } = helpers(
    ['num', 'count', 'plural', 'normalizeKind', 'unusedConfirmText'],
    { constants: ['KIND_LABELS', 'KIND_PLURALS'] }
  );
  const tags = (total) =>
    Array.from({ length: total }, () => ({ kind: 'tags' }));

  assert.strictEqual(unusedConfirmText(tags(12)), 'Delete 12 unused tags');
  assert.strictEqual(
    unusedConfirmText(tags(1)),
    'Delete 1 unused tag',
    'one object is not "1 tags"'
  );
  assert.strictEqual(
    unusedConfirmText([{ kind: 'correspondents' }, { kind: 'correspondents' }]),
    'Delete 2 unused correspondents'
  );
  // A scan over both kinds produces a mixed selection; naming one of them
  // would be a lie about what is deleted.
  assert.strictEqual(
    unusedConfirmText([{ kind: 'tags' }, { kind: 'correspondents' }]),
    'Delete 2 unused objects'
  );
  assert.strictEqual(
    unusedConfirmText(tags(1200)),
    'Delete 1,200 unused tags',
    'a number is grouped the way every other number on the page is'
  );
});

test('htmlUnusedRows draws a pick, a kind and the matching rule', () => {
  const { htmlUnusedRows } = helpers(
    ['num', 'normalizeKind', 'htmlMatchingRule', 'htmlUnusedRows'],
    {
      constants: ['KIND_LABELS', 'ALGORITHM_LABELS', 'htmlIcons'],
      globals: { esc: escForTest },
    }
  );
  const markup = htmlUnusedRows([
    {
      kind: 'tags',
      record: { id: 7, name: 'Old <b>', matchingAlgorithm: 0, match: '' },
    },
    {
      kind: 'correspondents',
      record: { id: 8, name: 'Nobody', matchingAlgorithm: 1, match: 'nobody' },
    },
  ]);
  assert.ok(
    markup.includes('data-unused-kind="tags" data-unused-id="7"'),
    'a row must say which object it is, or the delete cannot name it'
  );
  assert.ok(
    markup.includes('class="zr-check dup-unused__pick"'),
    'every row needs its own checkbox'
  );
  assert.ok(
    markup.includes('Old &lt;b&gt;'),
    'a tag name is user data and must be escaped'
  );
  assert.ok(
    markup.includes('<span class="zr-faint">none</span>'),
    'an object without a rule says so'
  );
  assert.ok(markup.includes('Any word'), 'a rule is named, not printed as 1');
  // The error cell is rendered empty, so a refusal can be written into the
  // row rather than into a toast that is gone before the row is read.
  assert.ok(
    markup.includes('class="zr-sm dup-unused__error"></span>'),
    'a row has nowhere to show why it was kept'
  );
});

test('The delete goes to its own endpoint, one request per kind', () => {
  assert.strictEqual(
    (SCRIPT.match(/'\/api\/duplicates\/delete'/g) || []).length,
    1,
    'there is one place that deletes, and it is the delete endpoint'
  );
  assert.match(
    SCRIPT,
    /const payload = await postJson\('\/api\/duplicates\/delete', \{ kind, ids \}\);/,
    'the request must carry exactly the kind and the ids'
  );
  // A mixed selection is the normal case after a scan over both kinds, and
  // the endpoint takes one kind at a time.
  assert.match(
    SCRIPT,
    /const byKind = new Map\(\);/,
    'the selection must be split by kind before it is sent'
  );
  assert.match(
    SCRIPT,
    /\/\/ A delete is a log entry like a merge, so the log must show it\.\n\s+loadLog\(true\);/,
    'the log must be reloaded after a delete'
  );
  // Nothing is deleted without the question that names what goes.
  const deleteFn = SCRIPT.slice(
    SCRIPT.indexOf('async function deleteUnused()'),
    SCRIPT.indexOf('function initUnused()')
  );
  assert.ok(
    deleteFn.indexOf('confirmDialog({') <
      deleteFn.indexOf('setUnusedBusy(true)'),
    'the confirm dialog must come before anything is sent'
  );
  assert.ok(
    deleteFn.includes('title: unusedConfirmText(picked),'),
    'the dialog must be titled with what the pure helper builds'
  );
  assert.ok(
    deleteFn.includes('markUnusedFailure'),
    'a refused object must keep its reason next to it'
  );
  // The section is the one way to delete: "Merge" of the assistant merges
  // the ticked groups and nothing else.
  assert.match(
    functionBody('deleteUnused'),
    /await deleteUnusedEntries\(picked\);/,
    'the section does not delete through the one function'
  );
  assert.strictEqual(
    (SCRIPT.match(/deleteUnusedEntries\(/g) || []).length,
    2,
    'the definition and the section: nothing else deletes'
  );
});

/* ── 15. the log speaks about deletes, renames and splits ─────────────────── */

test('The log tells a delete from a merge and shows what a merge renamed', () => {
  const { isDeleteEntry, logSourceNames, htmlLogTargetCell } = helpers(
    ['isDeleteEntry', 'isSplitEntry', 'logSourceNames', 'htmlLogTargetCell'],
    {
      globals: {
        LOG_ACTION_DELETE: 'delete',
        LOG_ACTION_SPLIT: 'split',
      },
    }
  );
  assert.match(
    SCRIPT,
    /const LOG_ACTION_DELETE = 'delete';/,
    'the action value is contract and must not drift'
  );

  // A row without an action is a merge: every row written before the log
  // knew about deletes is one.
  assert.strictEqual(isDeleteEntry({}), false);
  assert.strictEqual(isDeleteEntry({ action: 'merge' }), false);
  assert.strictEqual(isDeleteEntry({ action: 'delete' }), true);

  assert.strictEqual(
    logSourceNames({ sources: [{ name: 'a' }, { name: 'b' }, {}] }),
    'a, b, '
  );

  const merged = htmlLogTargetCell({
    targetName: 'Amazon EU',
    targetRenamedFrom: null,
  });
  assert.ok(merged.includes('>Amazon EU<'), 'a merge names its survivor');
  assert.ok(
    !merged.includes('renamed from'),
    'a merge that renamed nothing must not say it did'
  );

  const renamed = htmlLogTargetCell({
    targetName: 'Amazon EU S.a.r.l.',
    targetRenamedFrom: 'Amazon',
  });
  assert.ok(
    renamed.includes('renamed from Amazon'),
    'the old name belongs under the new one, or a rename is invisible'
  );
  assert.ok(
    renamed.includes('dup-log__renamed'),
    'the old name needs its own line'
  );

  const deleted = htmlLogTargetCell({
    action: 'delete',
    targetName: '',
    sources: [{ name: 'Leftover' }, { name: 'Also <b>' }],
  });
  assert.ok(
    deleted.includes('<span class="zr-badge zr-badge--warn">delete</span>'),
    'a delete row must be recognisable as one'
  );
  assert.ok(
    deleted.includes('Deleted: Leftover, Also &lt;b&gt;'),
    'a delete row lists what it removed, escaped'
  );

  // The two number cells a delete has no answer for stay empty rather than
  // showing a zero that looks like a merge that moved nothing.
  assert.match(
    SCRIPT,
    /const htmlDocuments = deleteRow\n\s+\? '<td data-label="Documents" class="zr-mono zr-faint"><\/td>'/,
    'a delete row must not claim it moved 0 documents'
  );
  assert.match(
    SCRIPT,
    /data-log-action="delete"/,
    'a delete row must be findable by what it recorded'
  );
});

test('The undo dialog names what it re-creates and moves back', () => {
  const { undoFactsText } = helpers(
    [
      'num',
      'count',
      'plural',
      'isDeleteEntry',
      'isSplitEntry',
      'logSourceNames',
      'undoFactsText',
    ],
    { globals: { LOG_ACTION_DELETE: 'delete', LOG_ACTION_SPLIT: 'split' } }
  );
  assert.strictEqual(
    undoFactsText({
      sources: [{ name: 'rechnungen' }, { name: 'Rechnungen' }],
      documentsMoved: 17,
    }),
    'rechnungen, Rechnungen re-created · 17 documents moved back'
  );
  assert.strictEqual(
    undoFactsText({ sources: [{ name: 'x' }], documentsMoved: 1 }),
    'x re-created · 1 document moved back'
  );
  // The undo of a delete cannot promise to move back documents that never
  // moved.
  assert.strictEqual(
    undoFactsText({ action: 'delete', sources: [{ name: 'Leftover' }] }),
    'Leftover re-created'
  );
  assert.strictEqual(
    undoFactsText({ action: 'split', sources: [{ name: 'Stromrechnung' }] }),
    'Stromrechnung re-created · document type and topics removed'
  );
  const undo = functionBody('undoMerge');
  assert.ok(
    undo.includes('body: undoFactsText(entry),'),
    'the dialog must say what the undo does, in the helper’s words'
  );
  assert.ok(
    undo.includes('`Undo merge into ${target}`'),
    'the dialog title must name the survivor'
  );
});

test('The log row of a split names what the tag became', () => {
  const { isSplitEntry, htmlLogTargetCell } = helpers(
    ['isDeleteEntry', 'isSplitEntry', 'logSourceNames', 'htmlLogTargetCell'],
    {
      globals: {
        esc: escForTest,
        LOG_ACTION_DELETE: 'delete',
        LOG_ACTION_SPLIT: 'split',
      },
    }
  );
  assert.match(
    SCRIPT,
    /const LOG_ACTION_SPLIT = 'split';/,
    'the action value is contract with the log and must not drift'
  );
  assert.strictEqual(isSplitEntry({}), false);
  assert.strictEqual(isSplitEntry({ action: 'merge' }), false);
  assert.strictEqual(isSplitEntry({ action: 'delete' }), false);
  assert.strictEqual(isSplitEntry({ action: 'split' }), true);

  const cell = htmlLogTargetCell({
    action: 'split',
    targetName: 'Rechnung + Strom',
    sources: [{ name: 'Stromrechnung' }],
  });
  assert.ok(
    cell.includes('<span class="zr-badge zr-badge--info">split</span>'),
    'a split row must be recognisable as one, and not wear the delete tone'
  );
  assert.ok(
    cell.includes('Rechnung + Strom'),
    'the cell names the type and the topics the tag became'
  );
  assert.ok(
    !cell.includes('renamed from'),
    'a split renamed nothing, it removed a tag'
  );

  const nasty = htmlLogTargetCell({
    action: 'split',
    targetName: 'Rechnung + <b>Strom</b>',
    sources: [],
  });
  assert.ok(
    nasty.includes('Rechnung + &lt;b&gt;Strom&lt;/b&gt;'),
    'the target text of a split is model and user data, so it is escaped'
  );

  // The row carries the action as an attribute, like a delete row does, so it
  // can be found by what it records.
  assert.match(
    SCRIPT,
    /data-log-action="split"/,
    'a split row must be findable by what it recorded'
  );
  // A split moved documents and lists the tag it removed, so neither cell
  // reads as a dash the way a delete's do.
  const rows = functionBody('htmlLogRows');
  assert.ok(
    rows.includes('const deleteRow = isDeleteEntry(entry);'),
    'only a delete blanks the two number cells'
  );
});

test('The undo of a split says what it takes back', () => {
  const undo = functionBody('undoMerge');
  assert.ok(
    undo.includes("'Undo split'"),
    'the dialog title must say what is being undone'
  );
  assert.ok(
    undo.indexOf('isSplitEntry(entry)') < undo.indexOf('isDeleteEntry(entry)'),
    'a split is decided before the delete branch, or it reads as a merge'
  );
  // The log is the one place that undoes, and a link from Simplify tags
  // opens it on a page that has no result yet.
  assert.match(
    functionBody('undoMerge'),
    /const entry = logEntries\.get\(num\(id\)\);/,
    'an undo reads a row of the log'
  );
  const visit = functionBody('initLogVisit');
  assert.ok(
    visit.includes("'#dupLog'") && visit.includes('el.log.open = true')
  );
  assert.ok(
    visit.includes('assist.logVisit = true;'),
    'the log of a visit that came for it must not wait for a scan'
  );
});

/* ── 16. the names the creation guard mapped ──────────────────────────────── */

test('The view carries the mappings section, with no scan to wait for', () => {
  [
    'dupMappings',
    'dupMappingsSummary',
    'dupMappingsAlert',
    'dupMappingsBody',
    'dupMappingsClearBtn',
  ].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
  });
  assert.ok(
    !/id="dupMappings"[^>]*hidden/.test(page),
    'the mappings do not depend on a scan and must not be hidden until one'
  );
  assert.ok(
    page.indexOf('id="dupLog"') < page.indexOf('id="dupMappings"'),
    'the mappings belong under the log'
  );
  assert.ok(
    page.includes('Proposed → mapped to'),
    'the table must say which name became which'
  );
  assert.match(
    SCRIPT,
    /await requestJson\('\/api\/duplicates\/mappings'\)/,
    'the section must load itself from its own endpoint'
  );
  assert.match(
    SCRIPT,
    /method: 'DELETE',/,
    'the Clear button has nothing to call'
  );
  assert.match(
    SCRIPT,
    /initMappings\(\);/,
    'the section must be wired up when the page opens'
  );
});

test('mappingDocumentLink points at the document, or nowhere', () => {
  const { mappingDocumentLink } = helpers(['num', 'mappingDocumentLink']);
  assert.strictEqual(
    mappingDocumentLink('https://paperless.example.org', 4711),
    'https://paperless.example.org/documents/4711/details'
  );
  assert.strictEqual(
    mappingDocumentLink('https://paperless.example.org/', '4711'),
    'https://paperless.example.org/documents/4711/details',
    'a trailing slash must not produce a double one'
  );
  // Both halves have to be known: the base URL only arrives with a scan, and
  // a mapping made outside a document carries no id.
  assert.strictEqual(mappingDocumentLink('', 4711), '');
  assert.strictEqual(mappingDocumentLink(null, 4711), '');
  assert.strictEqual(mappingDocumentLink('https://p.test', null), '');
  assert.strictEqual(mappingDocumentLink('https://p.test', 0), '');
  assert.strictEqual(mappingDocumentLink('https://p.test', 'nonsense'), '');
});

test('htmlMappingRows names the rule and links the document', () => {
  const zrDate = {
    format: () => '19.09.2026',
    formatDateTime: () => '19.09.2026 10:00',
  };
  const build = (baseUrl) =>
    helpers(
      [
        'num',
        'normalizeKind',
        'mappingDocumentLink',
        'htmlMappingDocument',
        'htmlMappingRows',
      ],
      {
        constants: ['KIND_LABELS', 'REASON_LABELS', 'htmlIcons'],
        globals: {
          paperlessUrl: baseUrl,
          window: { zrDate },
        },
      }
    ).htmlMappingRows;

  const rows = [
    {
      id: 1,
      kind: 'tags',
      proposedName: 'rechnungen',
      targetName: 'Rechnung',
      reason: 'plural',
      documentId: 4711,
      createdAt: '2026-09-19T10:00:00.000Z',
    },
    {
      id: 2,
      kind: 'correspondents',
      proposedName: 'Mueller <b>',
      targetName: 'Müller GmbH',
      reason: 'semantic',
      documentId: null,
      createdAt: '2026-09-19T09:00:00.000Z',
    },
  ];

  const linked = build('https://paperless.example.org')(rows);
  assert.ok(
    linked.includes('rechnungen → Rechnung'),
    'a row must read as one name becoming another'
  );
  assert.ok(
    linked.includes('Singular / plural'),
    'the rule is named the way the cards name it, not printed as "plural"'
  );
  assert.ok(
    linked.includes('<span class="zr-chip">Synonym</span>'),
    'a sweep-proposed rule reads the same here as on a card'
  );
  assert.ok(
    linked.includes(
      'href="https://paperless.example.org/documents/4711/details"'
    ),
    'the document must be reachable from the row'
  );
  assert.ok(
    linked.includes('rel="noopener"'),
    'an outbound link opens without handing the opener over'
  );
  assert.ok(
    linked.includes('Mueller &lt;b&gt;'),
    'a proposed name is user data and must be escaped'
  );
  assert.ok(
    linked.includes('<td data-label="Document"></td>'),
    'a mapping without a document leaves its cell empty instead of linking nowhere'
  );

  // Before the first scan the page does not know the public URL; the row
  // still says which document it was, it just cannot link it.
  const plain = build('')(rows);
  assert.ok(
    !plain.includes('<a '),
    "no base URL means no link (the kind icon's href does not count)"
  );
  assert.ok(
    plain.includes('#4711'),
    'the document id stays readable without a link'
  );
  assert.match(
    SCRIPT,
    /function refreshMappingLinks\(\) \{/,
    'the rows must be drawn again once a scan hands over the base URL'
  );
  assert.match(
    SCRIPT,
    /const MAPPINGS_EMPTY = 'None';/,
    'the empty list says so in one word'
  );
});

/* ── 17. the sweep, the remembered verdict, the memory ────────────────────── */

test('The sweep is a switch of the sheet, off and remembered', () => {
  [renderOffered(), page].forEach((markup) => {
    assert.ok(
      !markup.includes('id="dupAiSweep"'),
      'the sweep is priced in the sheet before a run, not ticked on the page'
    );
  });
  assert.match(
    SCRIPT,
    /const levers = \{\n\s+titles: true,\n\s+excerpts: true,\n\s+sweep: false,/,
    'a sweep costs requests of its own and must never be on by default'
  );
  assert.match(
    SCRIPT,
    /aiSweep: 'dup\.aiSweep',/,
    'the sweep must be remembered like the rest of the page'
  );
  assert.match(
    SCRIPT,
    /levers\.sweep = storeRead\(STORE_KEYS\.aiSweep\) === 'true';/,
    'a remembered sweep must come back switched on'
  );
  assert.match(
    functionBody('confirmRun'),
    /storeWrite\(STORE_KEYS\.aiSweep, levers\.sweep\);/,
    'a sweep switched on in the sheet must stay on for the next visit'
  );
  // Every way to the model goes through askForVerdicts, so one line covers
  // "Find duplicates", "Ask the model" and the guided flow.
  assert.strictEqual(
    (SCRIPT.match(/semanticSweep:/g) || []).length,
    1,
    'the sweep must be sent from the one place every run shares'
  );
  // The label of the reason the sweep produces is the page vocabulary.
  assert.match(
    SCRIPT,
    /semantic: 'Synonym',/,
    'a pair the sweep proposed must read as one wherever reasons are shown'
  );
});

test('The stylesheet carries the unused, mapping and log classes', () => {
  [
    '.dup-unused__summary',
    '.dup-unused__chevron',
    '.dup-unused__body',
    '.dup-unused__error',
    '.dup-unused__actions',
    '.dup-mappings__summary',
    '.dup-mappings__chevron',
    '.dup-mappings__body',
    '.dup-mappings__pair',
    '.dup-mappings__actions',
    '.dup-log__renamed',
    '.dup-dialog__field',
    '.dup-summary__count',
  ].forEach((selector) => {
    assert.ok(
      CSS.includes(selector),
      `${selector} is used by the page but has no rule`
    );
  });
  // Every drawer of the page turns its chevron the same way, in one rule.
  const turning =
    /((?:\s*\.dup-[a-z]+\[open\] \.dup-[a-z]+__chevron,?)+)\s*\{\n\s+transform: rotate\(90deg\);/.exec(
      CSS
    );
  assert.ok(turning, 'no drawer turns its chevron');
  ['manual', 'unused', 'log', 'mappings', 'hidden'].forEach((name) => {
    assert.ok(
      turning[1].includes(`.dup-${name}[open] .dup-${name}__chevron`),
      `the ${name} drawer does not turn its chevron`
    );
  });
  // A refusal is red where the object it refers to is.
  assert.match(
    CSS,
    /\.dup-unused__error:not\(:empty\) \{[^}]*color: var\(--zr-danger\)/,
    'the reason an object was kept must read as a problem'
  );
  // Phone width: the pick column stops being a narrow centred column once
  // the table stacks, or the checkbox sits alone in the middle of a line.
  assert.match(
    CSS,
    /@media \(max-width: 720px\) \{\n\s+\.dup-unused__table \.dup-unused__pickcol \{\n\s+width: auto;/,
    'the pick column does not stack on a phone'
  );
});

test('A remembered verdict says so on its chip', () => {
  const { htmlVerdictChip, htmlMemberVerdict } = helpers(
    [
      'basisLabel',
      'isRuleVerdict',
      'confidenceLabel',
      'shortReason',
      'verdictTitle',
      'htmlConfidenceSuffix',
      'htmlRememberedSuffix',
      'htmlVerdictChip',
      'htmlMemberVerdict',
    ],
    {
      constants: [
        'AI_VERDICT_LABELS',
        'AI_VERDICT_TONES',
        'AI_BASIS_LABELS',
        'AI_CONFIDENCE_LABELS',
        'htmlVerdictIcons',
      ],
      globals: {
        esc: escForTest,
        AI_SOURCE_RULE: 'spelling-rule',
        AI_RULE_LABEL: 'Spelling rule',
        AI_RULE_TONE: 'dup-verdict--rule',
        AI_REASON_MAX: 200,
      },
    }
  );

  const fresh = htmlVerdictChip({
    verdict: 'same',
    confidence: 'high',
    reason: 'plural',
  });
  assert.ok(
    !fresh.includes('remembered'),
    'a verdict the model just gave must not claim to be remembered'
  );

  const remembered = htmlVerdictChip({
    verdict: 'same',
    confidence: 'high',
    reason: 'plural',
    remembered: true,
  });
  assert.ok(
    remembered.includes('· remembered'),
    'a remembered verdict must say where it came from'
  );
  assert.ok(
    remembered.includes('dup-verdict__remembered'),
    'the suffix needs a class of its own so it can be dimmed'
  );
  assert.ok(
    remembered.indexOf('high') < remembered.indexOf('remembered'),
    'the confidence comes first: how sure, then where from'
  );

  // The member line under a name says the same thing, or a group reads as
  // freshly judged because one of its rows does.
  const member = htmlMemberVerdict({
    aiVerdict: { verdict: 'different', remembered: true },
  });
  assert.ok(member.includes('· remembered'));
});

test('The last tool offers to clear the verdict memory', () => {
  const offered = renderOffered();
  assert.match(
    offered,
    /class="zr-btn" id="dupAiForgetBtn"/,
    'clearing is a plain button, never a third way to start a run'
  );
  assert.ok(
    offered.includes('>Clear verdict memory</button>'),
    'the button is not labelled'
  );
  assert.ok(
    offered.indexOf('id="dupDismissals"') <
      offered.indexOf('id="dupAiForgetBtn"'),
    'the button closes the toolset'
  );

  // Without the model there is no memory to clear, so nothing of it renders.
  ['dupAiForgetBtn', 'Clear verdict memory'].forEach((needle) => {
    assert.ok(
      !page.includes(needle),
      `"${needle}" must not be rendered without aiReviewEnabled`
    );
  });

  const forget = functionBody('forgetVerdicts');
  assert.ok(
    forget.includes("'/api/duplicates/ai-review/memory'") &&
      forget.includes("method: 'DELETE'"),
    'the button must call the one route that empties the memory'
  );
  assert.ok(
    forget.includes('confirmDialog({'),
    'emptying the memory is a decision and gets a confirmation'
  );
  assert.ok(
    forget.includes("body: 'The next run asks about every pair again.',"),
    'the confirmation must say what clearing costs'
  );
  assert.match(
    CSS,
    /\.dup-forget \{/,
    'the button has no rule of its own in the page stylesheet'
  );
  assert.match(
    CSS,
    /\.dup-verdict__remembered \{/,
    'the remembered suffix has no rule of its own'
  );
  assert.match(
    CSS,
    /\.dup-log__deleted,\n\s+\.dup-log__split \{/,
    'the split cell must lay out like the delete cell it sits beside'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
