/**
 * Test: duplicates-ui
 *
 * Static checks for the Duplicates page — the view, its navigation entry, its
 * stylesheet and its page script. The page itself talks to seven endpoints and
 * is reviewed in a browser; what is checked here is everything that can drift
 * without anyone noticing:
 *
 * 1. views/duplicates.ejs renders through the real shell and carries the ids
 *    and the sensitivity options the page script and the route agree on,
 *    including the "Merge by hand" module and its closed state
 * 2. nav.ejs lists /duplicates on the rail and leaves the phone tab bar alone
 * 3. head-start.ejs links the page stylesheet in the right place
 * 4. public/css/pages/duplicates.css is one @layer pages block of dup- classes
 * 5. public/icons.svg carries the i-merge symbol the page references
 * 6. public/js/duplicates.js escapes everything it writes into innerHTML
 * 7. the page has a label for every match reason and group warning the
 *    matcher can produce, and its own wording where a flow needs one
 * 8. the AI review is rendered only when the route says it is available, and
 *    the page speaks all three verdicts
 * 9. the selection bar, the select check on every card and the one dialog a
 *    batch merge asks with
 * 10. the results toolbar (sorting, "Select ≥"), the custom threshold and the
 *    guided "ask, review, merge" flow — including that every one of them
 *    works on an instance without the AI review
 * 11. the one-click "AI proposal": what it sends, what it pre-ticks, how its
 *    rows are ordered, the basis and confidence both dialogs show, the
 *    evidence counters of the stats tile, and the aligned member tables
 * 12. the review as a job the page watches: the progress panel, the pure
 *    helpers that word its numbers, the event stream with its polling
 *    fallback, and the re-attach after a reload
 * 13. what the panel shows inside one request: the bar moving on streamed
 *    answers, the warm-up and the measured batch size, the thinking state,
 *    and the settings link a failed review offers
 * 14. the name the single merge dialog offers for the survivor, and the rule
 *    that a name is only sent when it changed
 * 15. the Unused section: its ids, what it confirms before it deletes, the
 *    rows it draws and the one request it sends per kind
 * 16. the log rows a delete and a rename write
 * 17. the names the creation guard mapped, their rule and the document link
 * 18. the semantic sweep: its checkbox, what it sends and what it counts
 * 19. round 10: the log rows the Simplify tags page writes and how they are
 *     undone, the chip of a remembered verdict, what memory and lanes add to
 *     the two AI tiles, and the button that empties the judge's memory
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

test('The manual merge module sits between the scan stats and the results', () => {
  const stats = page.indexOf('id="dupStats"');
  const manual = page.indexOf('id="dupManual"');
  const results = page.indexOf('id="dupResults"');
  assert.ok(stats !== -1 && manual !== -1 && results !== -1);
  assert.ok(
    stats < manual && manual < results,
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
    ['0.95', '0.85', '0.75', 'custom'],
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

test('Custom sensitivity brings a number field the scan sends instead', () => {
  assert.ok(
    page.includes('>Custom</option>'),
    'the fourth option is not labelled'
  );
  // Hidden until "Custom" is chosen; .hidden is the framework's !important
  // class, which the page script toggles.
  assert.match(
    page,
    /class="dup-controls__field dup-controls__custom hidden" id="dupThresholdCustomField"/,
    'the number field must come up hidden beside the select'
  );
  const field = /<input[^>]*id="dupThresholdCustom"[^>]*>/.exec(page);
  assert.ok(field, '#dupThresholdCustom is missing from the view');
  ['type="number"', 'min="50"', 'max="100"', 'step="1"'].forEach(
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
});

test('The results toolbar renders hidden above the selection bar', () => {
  [
    'dupResultsBar',
    'dupSortSelect',
    'dupMinConfidence',
    'dupSelectMinBtn',
    'dupMinConfidenceCount',
  ].forEach((id) => {
    assert.ok(
      page.includes(`id="${id}"`),
      `#${id} is missing from the view; the toolbar cannot bind to it`
    );
  });
  // Nothing to order until a scan has answered.
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
  ['Sort by', 'Select ≥'].forEach((label) => {
    assert.ok(page.includes(label), `the toolbar has no "${label}"`);
  });
});

test('The stats row carries the confidence breakdown', () => {
  assert.match(
    page,
    /class="zr-stat__delta dup-stat__buckets" id="dupStatBuckets"/,
    'the breakdown under "Groups found" is missing'
  );
  assert.ok(
    page.indexOf('id="dupStatGroups"') < page.indexOf('id="dupStatBuckets"'),
    'the breakdown belongs under the number it breaks down'
  );
});

test('The AI review is rendered only when the route offers it', () => {
  const offered = renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  [
    'dupAiReviewBtn',
    'dupAiTitles',
    'dupAiHint',
    'dupAiNotice',
    'dupStatAiJudged',
    'dupStatAiCandidates',
    'dupStatAiRequests',
  ].forEach((id) => {
    assert.ok(
      offered.includes(`id="${id}"`),
      `#${id} is missing although the review is offered`
    );
  });
  assert.ok(offered.includes('Ask the AI'), 'the button is not labelled');
  assert.ok(
    offered.includes('Use document titles and neighbours as context'),
    'the titles checkbox has no label'
  );
  assert.match(
    offered,
    /id="dupAiTitles"[^>]*checked/,
    'the titles come as context unless the user says otherwise'
  );
  assert.match(
    offered,
    /id="dupAiReviewBtn"[^>]*disabled/,
    'the button waits for a scan to have found something'
  );
  assert.match(offered, /icons\.svg#i-wand/, 'the button has no i-wand icon');
  // The band below the threshold is what the model adds, and it is widest at
  // the strict preset — the hint is the only place that says so.
  assert.ok(
    offered.includes('Most useful at Strict sensitivity'),
    'the hint about where the review pays off is missing'
  );
  // Both tiles belong to the stats row and stay out of sight until a review
  // has answered; .hidden is the framework's !important class.
  ['dupStatAiJudgedTile', 'dupStatAiRequestsTile'].forEach((id) => {
    assert.match(
      offered,
      new RegExp(`class="zr-stat hidden" id="${id}"`),
      `#${id} must come up hidden`
    );
  });

  // The default: nothing of the review is rendered, not even its containers.
  [page, renderSync('duplicates.ejs', LOCALS)].forEach((markup) => {
    [
      'dupAiReviewBtn',
      'dupAiTitles',
      'dupAiHint',
      'dupAiNotice',
      'dupStatAiJudgedTile',
      'dupStatAiRequestsTile',
      'Ask the AI',
    ].forEach((needle) => {
      assert.ok(
        !markup.includes(needle),
        `"${needle}" must not be rendered without aiReviewEnabled`
      );
    });
  });
});

test('The guided button is rendered only when the review is offered', () => {
  const offered = renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  assert.ok(
    offered.includes('id="dupReviewThenMergeBtn"'),
    'the guided button is missing although the review is offered'
  );
  assert.ok(
    offered.includes('Ask the AI, then merge'),
    'the guided button is not labelled'
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
  // Both buttons carry the same weight, and the one without a model comes
  // first: the AI is an addition, never a condition.
  assert.ok(
    offered.indexOf('id="dupMergeSelectedBtn"') <
      offered.indexOf('id="dupReviewThenMergeBtn"'),
    '"Merge selected" belongs before the guided button'
  );
  [
    /class="zr-btn zr-btn--primary" id="dupMergeSelectedBtn"/,
    /class="zr-btn zr-btn--primary" id="dupReviewThenMergeBtn"/,
  ].forEach((rule) => {
    assert.match(offered, rule, 'the two buttons must look the same');
  });
});

test('Without the review the page is whole: toolbar, "Select ≥", batch merge', () => {
  // The user's rule for this page: the AI is an addition. Everything a merge
  // needs has to render and work with the review switched off.
  const plain = renderSync('duplicates.ejs', LOCALS);
  [
    'dupResultsBar',
    'dupSortSelect',
    'dupMinConfidence',
    'dupSelectMinBtn',
    'dupMinConfidenceCount',
    'dupStatBuckets',
    'dupThresholdCustom',
    'dupSelection',
    'dupMergeSelectedBtn',
    'dupSelectAllBtn',
    'dupClearSelectionBtn',
  ].forEach((id) => {
    assert.ok(
      plain.includes(`id="${id}"`),
      `#${id} must not depend on the AI review`
    );
  });
  ['Sort by', 'Select ≥', 'Merge selected'].forEach((label) => {
    assert.ok(
      plain.includes(label),
      `"${label}" must not depend on the review`
    );
  });
  [
    'dupReviewThenMergeBtn',
    'dupReviewThenMergeIcon',
    'Ask the AI, then merge',
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

  // The model's three verdicts are a vocabulary of their own; the page needs a
  // label, a tone class and an icon for each of them.
  const ai = require('../services/entityMatchAiService');
  Object.values(ai.AI_VERDICTS).forEach((verdict) => {
    assert.ok(
      hasKey(verdict),
      `the page has no label for the AI verdict "${verdict}"`
    );
    assert.ok(
      SCRIPT.includes(`AI: ${verdict}`),
      `the page never writes out "AI: ${verdict}"`
    );
    assert.ok(
      SCRIPT.includes(`dup-verdict--${verdict}`),
      `the verdict "${verdict}" has no tone class`
    );
  });
  // The page only has to recognise the source that changes what it renders:
  // everything that is not an AI candidate is a group the scan itself found.
  assert.ok(
    SCRIPT.includes(`'${ai.GROUP_SOURCES.AI_CANDIDATE}'`),
    'the page does not know the ai-candidate group source'
  );
});

test('The manual flow says what happens to an inbox tag among its sources', () => {
  // A group keeps its inbox tag: the matcher makes it the target. By hand the
  // user picks the target, so an inbox tag can be a source — and a source is
  // deleted. The two sentences must therefore stay apart.
  assert.ok(
    SCRIPT.includes('One of these is an inbox tag; it stays the target.'),
    'the group wording is gone'
  );
  assert.ok(
    SCRIPT.includes(
      'An inbox tag is among the entries to merge away; it will be deleted in Paperless-ngx.'
    ),
    'the manual flow still promises that the inbox tag survives'
  );
  assert.match(
    SCRIPT,
    /htmlWarnings\(manualWarnings\(target, sources\), MANUAL_WARNING_TEXTS\)/,
    'the manual module does not use its own wording'
  );
});

/* ── 9. merging several groups at once ────────────────────────────────────── */

/** Every id the selection bar and the page script have to agree on. */
const SELECTION_IDS = [
  'dupSelection',
  'dupSelectionCount',
  'dupSelectionProgress',
  'dupMergeSelectedBtn',
  'dupSelectAllBtn',
  'dupSelectAiSameBtn',
  'dupClearSelectionBtn',
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
  // "Select AI: same" only means anything once a review has run.
  assert.match(
    page,
    /class="zr-btn zr-btn--ghost hidden" id="dupSelectAiSameBtn"/,
    'the AI button must come up hidden'
  );
  ['Merge selected', 'Select all', 'Select AI: same', 'Clear'].forEach(
    (label) => {
      assert.ok(page.includes(label), `the bar has no "${label}" button`);
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
  // Unchecked by default: nothing is ever preselected for a destructive step.
  assert.ok(
    !/class="zr-check dup-select"[^>]*checked/.test(SCRIPT),
    'the select check must come up unchecked'
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
    SCRIPT.includes("Copy a source's matching rule where the target has none"),
    'the batch checkbox is not labelled'
  );
  // The per-group checkbox keeps its own id; the two dialogs never collide.
  assert.ok(
    SCRIPT.includes('id="dupCopyRule"'),
    'the single-group checkbox lost its id'
  );
  // Every dialog that merges makes the same promise about the log: the single
  // merge, the batch and the guided review.
  assert.strictEqual(
    (SCRIPT.match(/esc\(UNDO_NOTE\)/g) || []).length,
    4,
    'every merge dialog must promise the same undo'
  );
  assert.strictEqual(
    (SCRIPT.match(/confirmDialog\(\{/g) || []).length,
    8,
    'one dialog for a group, one for a batch, one for the review, one for the proposal, one for undo, one for deleting unused objects, one for clearing the mappings, one for forgetting the remembered verdicts'
  );
});

test('A batch merges group by group through the one merge endpoint', () => {
  // No batch endpoint and no second request shape — the server side stays
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

/* ── 10. the results toolbar and the guided flow ──────────────────────────── */

/** The body of a top-level function of the page script, braces balanced. */
function functionBody(name) {
  const start = SCRIPT.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name}() is gone from the page script`);
  const open = SCRIPT.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SCRIPT.length; i += 1) {
    if (SCRIPT[i] === '{') depth += 1;
    if (SCRIPT[i] === '}') {
      depth -= 1;
      if (depth === 0) return SCRIPT.slice(open, i + 1);
    }
  }
  throw new Error(`${name}() is not balanced`);
}

test('The view and the page script agree on the toolbar ids', () => {
  [
    'dupResultsBar',
    'dupSortSelect',
    'dupMinConfidence',
    'dupSelectMinBtn',
    'dupMinConfidenceCount',
    'dupStatBuckets',
    'dupThresholdCustom',
    'dupThresholdCustomField',
    'dupReviewThenMergeBtn',
    'dupReviewThenMergeIcon',
  ].forEach((id) => {
    assert.ok(
      SCRIPT.includes(`'${id}'`),
      `the page script never looks up #${id}`
    );
  });
  // The threshold of a scan and of a review is one function, so the custom
  // percent cannot reach one of them and not the other.
  assert.match(
    SCRIPT,
    /threshold: String\(currentThreshold\(\)\)/,
    'the scan no longer asks for the current threshold'
  );
  assert.match(
    SCRIPT,
    /threshold: currentThreshold\(\)/,
    'the review no longer asks for the current threshold'
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

test('"Select ≥" ticks by confidence and remembers its number', () => {
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
  assert.ok(
    SCRIPT.includes('at or above'),
    'the count beside the button is not worded'
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
  // Pre-ticked for a settled "same" only; a verdict is information, never a
  // veto, and a "same" the model is unsure about is not settled.
  assert.match(
    row,
    /isSureSame\(verdict\) \? ' checked' : ''/,
    'the ticks must follow the pre-tick rule of both dialogs'
  );
  assert.match(
    SCRIPT,
    /class="zr-check dup-review-pick"/,
    'the rows have no pick check'
  );
  // Stacks on a phone: every cell carries its column name.
  assert.match(SCRIPT, /class="zr-table zr-table--stack dup-review-table"/);
  ['Merge', 'Group', 'Documents', 'AI', 'Why'].forEach((label) => {
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
  // The batch machinery of round 4 does the merging, unchanged.
  assert.match(
    functionBody('confirmReviewedBatch'),
    /await runBatch\(ticked, copyMatchingRule\(\)\)/,
    'the review dialog must merge through the batch runner'
  );
});

test('The batch dialog offers the guided path without insisting on it', () => {
  const body = functionBody('htmlBatchDialog');
  assert.match(
    body,
    /aiReviewOffered\(\)/,
    'the tip must not be rendered where there is no review'
  );
  // The apostrophe is escaped in the source of the string literal.
  assert.ok(
    SCRIPT.replace(/\\'/g, "'").includes(
      'Tip: "Ask the AI, then merge" shows the model\'s view first.'
    ),
    'the one line naming the guided path is gone'
  );
  assert.match(
    body,
    /class="zr-sm zr-faint dup-dialog__tip"/,
    'the tip must stay a faint line, not a warning'
  );
});

test('The stylesheet carries the toolbar and review classes', () => {
  [
    '.dup-results-bar',
    '.dup-results-bar__sort',
    '.dup-results-bar__min',
    '.dup-review-table',
    '.dup-review__reason',
    '.dup-stat__buckets',
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
  // Phone width: both controls take a line of their own rather than widening
  // the page past the viewport.
  assert.match(
    CSS,
    /\.dup-results-bar__sort,\n\s+\.dup-results-bar__min \{\n\s+width: 100%;/,
    'the toolbar does not wrap at phone width'
  );
});

/* ── 11. the AI proposal ──────────────────────────────────────────────────── */
/* One click does the scan, the review of everything and the proposal; the user
   only thins it out. What is checked here is that it is an addition — the
   ids are rendered only where the review is offered, the request is the one
   "Ask the AI" sends, and nothing of the earlier paths asks a model. */

/** The whole source of a top-level function, so a test can run it itself. */
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

/** The whole source of a top-level const whose value is an object literal. */
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

/** What a markup helper taken out of the module needs from the page. */
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
 * pure functions can be taken this way, which is why the two rules the
 * proposal turns on — what is pre-ticked, and in which order — are written as
 * pure functions in the first place.
 *
 * A markup helper needs the page's vocabulary as well: `constants` copies the
 * real object literals in (so a renamed label fails here), and `globals`
 * hands in what the module itself imports or keeps in a variable — the
 * escaper, the Paperless-ngx base URL, the date formatter.
 *
 * @param {string[]} names
 * @param {{constants?: string[], globals?: object}} [extra]
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

test('The AI proposal is rendered only when the review is offered', () => {
  const offered = renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  [
    'dupAiProposalBtn',
    'dupAiProposalIcon',
    'dupAiProposalHint',
    'dupAiProposalStatus',
    'dupAiExcerpts',
  ].forEach((id) => {
    assert.ok(
      offered.includes(`id="${id}"`),
      `#${id} is missing although the review is offered`
    );
  });
  assert.match(
    offered,
    /class="zr-btn zr-btn--primary" id="dupAiProposalBtn"/,
    'the proposal is the primary action of the AI row'
  );
  // It scans by itself, so unlike "Ask the AI" it is usable from the first
  // paint — a disabled attribute here would wait for a scan that never runs.
  assert.ok(
    !/id="dupAiProposalBtn"[^>]*disabled/.test(offered),
    'the proposal button must not wait for a scan'
  );
  assert.match(
    offered,
    /id="dupAiProposalIcon"[\s\S]{0,120}icons\.svg#i-wand/,
    'the proposal button has no i-wand icon'
  );
  assert.ok(offered.includes('AI proposal'), 'the button is not labelled');
  assert.ok(
    offered.includes(
      'Scans, lets the model judge every group and near-miss, and proposes what to merge. You deselect, nothing merges by itself.'
    ),
    'the hint under the AI row is missing'
  );
  assert.ok(
    offered.includes('Use document excerpts for spelling-only pairs'),
    'the excerpts checkbox has no label'
  );
  assert.match(
    offered,
    /id="dupAiExcerpts"[^>]*checked/,
    'the excerpts are evidence unless the user says otherwise'
  );
  // The status line says what the flow is doing; it starts out empty and
  // hidden through the framework's !important class.
  assert.match(
    offered,
    /class="zr-sm dup-ai-proposal__status hidden" id="dupAiProposalStatus"/,
    'the status line must come up hidden'
  );
  assert.match(
    offered,
    /id="dupAiProposalStatus"[^>]*aria-live="polite"/,
    'the status line is not announced'
  );

  // The default: none of it is rendered, and the page is whole without it.
  const plain = renderSync('duplicates.ejs', LOCALS);
  [
    'dupAiProposalBtn',
    'dupAiProposalHint',
    'dupAiProposalStatus',
    'dupAiExcerpts',
    'AI proposal',
    'Use document excerpts for spelling-only pairs',
  ].forEach((needle) => {
    assert.ok(
      !plain.includes(needle),
      `"${needle}" must not be rendered without aiReviewEnabled`
    );
  });
  ['dupScanBtn', 'dupMergeSelectedBtn', 'dupResultsBar'].forEach((id) => {
    assert.ok(
      plain.includes(`id="${id}"`),
      `#${id} must not depend on the AI review`
    );
  });
});

test('The proposal scans, asks about everything and sends both evidence flags', () => {
  const body = functionBody('runAiProposal');
  // It reuses the scan of the button beside it rather than a request of its own.
  assert.match(body, /await runScan\(\)/, 'the proposal does not scan first');
  assert.match(
    body,
    /if \(!scanned\) return;/,
    'a failed scan must stop the proposal rather than ask about nothing'
  );
  assert.match(
    body,
    /askForVerdicts\(\{ includeCandidates: true \}\)/,
    'the proposal must judge the near-misses as well'
  );
  assert.ok(
    !body.includes('groupIds'),
    'the proposal asks about everything; narrowing it is the guided path'
  );
  // The status line covers the scan, and stands down the moment the run
  // meter takes over: one place saying what is happening, not two.
  assert.ok(
    body.includes("setProposalStatus('Scanning…')"),
    'the scan is silent'
  );
  assert.ok(
    !body.includes('Asking the AI about'),
    'the run meter already says that the model is being asked'
  );
  assert.ok(
    body.indexOf("setProposalStatus('')") <
      body.indexOf('setAiReviewing(true)'),
    'the status line has to be cleared before the meter appears'
  );
  // No request of its own: the scan, the review and the merges are it.
  ['fetch(', 'postJson(', 'requestJson('].forEach((call) => {
    assert.ok(
      !body.includes(call),
      `the proposal must not send ${call} itself — three known requests, no more`
    );
  });
  // Both evidence flags reach every review, from both paths into one request.
  const ask = functionBody('askForVerdicts');
  assert.match(
    ask,
    /withTitles: Boolean\(el\.aiTitles && el\.aiTitles\.checked\)/,
    'the titles checkbox no longer reaches the request'
  );
  assert.match(
    ask,
    /withExcerpts: Boolean\(el\.aiExcerpts && el\.aiExcerpts\.checked\)/,
    'the excerpts checkbox does not reach the request'
  );
  assert.strictEqual(
    (SCRIPT.match(/'\/api\/duplicates\/ai-review\/jobs'/g) || []).length,
    1,
    'all three review paths start the one job'
  );
  // The page without a model is untouched: "Merge selected" asks nobody.
  const plain = functionBody('mergeSelected');
  ['ai-review', 'askForVerdicts', 'aiVerdict', 'runAiProposal'].forEach(
    (needle) => {
      assert.ok(
        !plain.includes(needle),
        `"Merge selected" must work without the review (${needle})`
      );
    }
  );
});

test('Only a settled "same" comes up ticked, in both dialogs', () => {
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
  // Everything else waits for the user, including a "same" without a
  // confidence — which is what an older answer and a failed request look like.
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
  // Both dialogs are the same renderer, so both follow the same rule.
  assert.match(
    functionBody('htmlReviewRow'),
    /isSureSame\(verdict\)/,
    'the row renderer no longer uses the pre-tick rule'
  );
  assert.strictEqual(
    (SCRIPT.match(/htmlReviewRow\(entry, '/g) || []).length,
    2,
    'the guided dialog and the proposal must share the row renderer'
  );
});

test('The proposal rows are sorted by verdict, the settled ones first', () => {
  const { compareProposalEntries } = helpers([
    'num',
    'proposalRank',
    'compareProposalEntries',
  ]);
  const entry = (id, verdict, confidence, score) => ({
    state: {
      group: {
        id,
        confidence: score,
        aiVerdict: verdict ? { verdict, confidence } : null,
      },
    },
  });
  const rows = [
    entry('f', 'different', 'high', 0.99),
    entry('d', 'unsure', null, 0.97),
    entry('g', null, null, 1),
    entry('b', 'same', 'high', 0.9),
    entry('c', 'same', 'low', 0.95),
    entry('a', 'same', 'high', 0.96),
    entry('e', 'unsure', 'low', 0.88),
  ];
  assert.deepStrictEqual(
    [...rows].sort(compareProposalEntries).map((row) => row.state.group.id),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    'same/high, then same, then unsure, then different, then the unjudged'
  );
  // The dialog sorts a copy: the order of the cards on the page is the user's.
  assert.match(
    functionBody('confirmProposal'),
    /\[\.\.\.entries\]\.sort\(compareProposalEntries\)/,
    'the proposal must sort a copy of the entries'
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

test('The proposal dialog names its parts and merges through the batch runner', () => {
  ['dupProposalTickSame', 'dupProposalUntickAll', 'dupProposalSummary'].forEach(
    (id) => {
      assert.ok(
        SCRIPT.includes(`id="${id}"`),
        `the proposal dialog has no #${id}`
      );
    }
  );
  ['Tick all same', 'Untick all', 'Merge ticked'].forEach((label) => {
    assert.ok(SCRIPT.includes(label), `the dialog has no "${label}"`);
  });
  assert.ok(
    SCRIPT.includes(
      'Pre-ticked: settled by a spelling rule, or the model is sure.'
    ),
    'the legend that explains the ticks is gone'
  );
  assert.ok(
    SCRIPT.includes("The AI's proposal: "),
    'the dialog title does not say whose proposal it is'
  );
  // The foot line counts what a confirmation would do, including the deletions.
  assert.match(
    functionBody('pickedSummaryText'),
    /will be deleted/,
    'the foot line does not say how many objects would be deleted'
  );
  const body = functionBody('confirmProposal');
  assert.match(
    body,
    /dialog\.classList\.add\(/,
    'the proposal needs the wide dialog'
  );
  assert.ok(
    body.includes("'dup-proposal-dialog'"),
    'the dialog is not marked as the proposal'
  );
  // Round 4 does the merging, unchanged, and the bar shows it: the selection
  // is set to exactly what was ticked before the batch starts.
  assert.match(
    body,
    /clearSelection\(\);\n\s+selectGroups\(\(state\) => wanted\.has\(String\(state\.group\.id\)\)\);\n\s+await runBatch\(ticked, copyMatchingRule\(\)\);/,
    'the proposal must hand its ticked groups to the batch runner'
  );
  // Cancelling merges nothing and leaves nothing ticked.
  assert.match(
    body,
    /if \(!\(await answer\)\) \{\n\s+\/\/[\s\S]{0,120}clearSelection\(\);\n\s+return;/,
    'cancelling the proposal must leave the page unticked'
  );
  // A group that cannot be merged is not proposed in the first place.
  assert.match(
    functionBody('proposalEntries'),
    /if \(selectBlockReason\(card, state\) !== ''\) return;/,
    'the proposal must skip what the page would refuse to merge'
  );
});

test('The judged tile counts the evidence the review used', () => {
  const body = functionBody('renderAiStats');
  [
    ['excerpts', 'excerpts'],
    ['spellingRules', 'by spelling rule'],
    ['escalated', 'escalated'],
  ].forEach(([field, wording]) => {
    assert.ok(
      body.includes(`review.${field}`),
      `the tile ignores aiReview.${field}`
    );
    assert.ok(body.includes(wording), `the sub line never says "${wording}"`);
    assert.ok(
      new RegExp(`num\\(review\\.${field}\\) > 0`).test(body),
      `aiReview.${field} must only show up when there is something to show`
    );
  });
  // A plain scan puts the tiles away again; the numbers of the last review say
  // nothing about a new scan.
  assert.match(
    body,
    /if \(!review\) \{[\s\S]{0,200}classList\.add\('hidden'\)/,
    'a scan without a review must hide the tiles'
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

test('The stylesheet carries the proposal classes', () => {
  [
    '.dup-proposal-dialog',
    '.dup-proposal-pick',
    '.dup-proposal__legend',
    '.dup-proposal__quick',
    '.dup-ai-proposal',
    '.dup-ai-proposal__status',
  ].forEach((selector) => {
    assert.ok(
      selectorsOf(CSS).includes(selector),
      `${selector} has no rule of its own`
    );
  });
  // The proposal's tick cell carries both classes: the column of the shared
  // table, and its own hook.
  assert.ok(
    SCRIPT.includes("'dup-review__pick dup-proposal-pick'"),
    'the proposal rows do not mark their tick column'
  );
  // Wider than the guided dialog, which is already wider than the framework's.
  const width = (selector) => {
    const rule = new RegExp(`\\${selector} \\{[^}]*width: min\\((\\d+)px`).exec(
      CSS
    );
    assert.ok(rule, `${selector} has no width`);
    return Number(rule[1]);
  };
  assert.ok(
    width('.dup-proposal-dialog') >= width('.dup-review-dialog'),
    'the proposal has one column more than the guided dialog, not one less'
  );
});

/* ── 12. the review as a watchable job ────────────────────────────────────── */
/* A review is many model requests in a row, so the server runs it as a job and
   the page watches it: a bar, what it costs, how long it still needs, and a
   Stop button. What is checked here is that the panel exists only where the
   review is offered, that the five pure helpers word the numbers the way the
   page promises, and that the script really streams (with a fallback) instead
   of waiting for one long POST. */

test('The progress panel is rendered only where the review is offered', () => {
  const offered = renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  [
    'dupAiProgress',
    'dupAiProgressBar',
    'dupAiProgressFill',
    'dupAiProgressMessage',
    'dupRunPosition',
    'dupRunRest',
    'dupRunCeiling',
    'dupAiStopBtn',
  ].forEach((id) => {
    assert.ok(
      offered.includes(`id="${id}"`),
      `#${id} is missing although the review is offered`
    );
    assert.ok(
      !page.includes(`id="${id}"`),
      `#${id} must not exist without the review`
    );
  });
  // Hidden until a review runs, and a live region so a screen reader hears it.
  assert.match(
    offered,
    /class="dup-progress zr-runmeter hidden" id="dupAiProgress" role="status" aria-live="polite"/,
    'the panel is not a hidden live region'
  );
  assert.match(
    offered,
    /class="zr-btn zr-btn--ghost zr-btn--stacked" id="dupAiStopBtn"/,
    'Stop is the quiet button of the row, not a primary action'
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
});

test('formatTokens reads a bill: 980, 12.4k, 1.2M', () => {
  const { formatTokens } = helpers(['formatTokens']);
  assert.strictEqual(formatTokens(0), '0');
  assert.strictEqual(formatTokens(null), '0');
  assert.strictEqual(formatTokens('nonsense'), '0');
  assert.strictEqual(formatTokens(980), '980');
  assert.strictEqual(formatTokens(999), '999');
  assert.strictEqual(formatTokens(1000), '1k');
  assert.strictEqual(formatTokens(12400), '12.4k');
  assert.strictEqual(formatTokens(31200), '31.2k');
  // Three digits of thousands drop the decimal; "200.0k" reads like precision
  // nobody has.
  assert.strictEqual(formatTokens(200000), '200k');
  assert.strictEqual(formatTokens(1200000), '1.2M');
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

test('stopNotice says why a review ended and what it did not judge', () => {
  const { stopNotice } = helpers([
    'num',
    'plural',
    'formatTokens',
    'stopNotice',
  ]);
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
    'Stopped after 3 of 8 requests: 56 pairs were not judged.'
  );
  assert.strictEqual(
    stopNotice({
      stopReason: 'token-budget',
      progress: progress({ requestsDone: 5, tokenBudget: 200000 }),
    }),
    'Stopped at the token budget of 200k after 5 requests: 56 pairs were not judged.'
  );
  assert.strictEqual(
    stopNotice({ stopReason: 'idle', progress: progress() }),
    'Stopped because nobody was watching: 56 pairs were not judged.'
  );
  // Nothing left over is still a sentence, and so is a plan nobody made.
  assert.strictEqual(
    stopNotice({
      stopReason: 'user',
      progress: progress({ pairsJudged: 96 }),
    }),
    'Stopped after 3 of 8 requests: 0 pairs were not judged.'
  );
  assert.strictEqual(
    stopNotice({
      stopReason: 'user',
      progress: progress({ requestsPlanned: null, pairsTotal: null }),
    }),
    'Stopped after 3 requests.'
  );
  assert.strictEqual(
    stopNotice({
      stopReason: 'user',
      progress: progress({ pairsJudged: 95 }),
    }),
    'Stopped after 3 of 8 requests: 1 pair was not judged.'
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
    ask.includes('followReviewJob(job)'),
    'the started job is not followed'
  );
  // Stop is one request and no dialog; the verdicts already reached are kept.
  const stop = functionBody('stopReview');
  assert.match(stop, /\/stop`/, 'the Stop button does not call the stop route');
  assert.ok(
    !/confirmDialog/.test(stop),
    'stopping must not ask a question — the user already decided'
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

/* ── 13. inside one request ───────────────────────────────────────────────── */
/* A request that asks about eighty pairs takes minutes, and a panel that only
   moves between requests shows nothing for all of it. The judge now streams
   its answers, measures the model on a small first request and says when it
   is thinking; every one of those has to reach the page. */

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

test('progressCountsText says where the running request is', () => {
  const { progressCountsText } = helpers([
    'plural',
    'formatTokens',
    'progressCountsText',
  ]);
  assert.strictEqual(
    progressCountsText({
      requestsDone: 2,
      requestsPlanned: 9,
      pairsJudged: 34,
      pairsTotal: 82,
      tokens: 12400,
      tokenBudget: 200000,
      requestPairs: 10,
      requestAnswers: 7,
    }),
    'Request 2 of 9 · 7 of 10 answers · 34 of 82 pairs · 12.4k of 200k tokens'
  );
  // Between two requests there is nothing to count, and the part is gone
  // rather than showing "0 of 0 answers".
  assert.strictEqual(
    progressCountsText({
      requestsDone: 2,
      requestsPlanned: 9,
      pairsJudged: 34,
      pairsTotal: 82,
      tokens: 12400,
      tokenBudget: 200000,
      requestPairs: null,
      requestAnswers: 0,
    }),
    'Request 2 of 9 · 34 of 82 pairs · 12.4k of 200k tokens'
  );
  // An answer count that ran ahead of the request it belongs to is capped
  // rather than printed as more answers than there are pairs.
  assert.match(
    progressCountsText({
      requestsDone: 1,
      requestsPlanned: 4,
      pairsTotal: 40,
      tokens: 0,
      requestPairs: 10,
      requestAnswers: 14,
    }),
    /10 of 10 answers/
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

test('The outcome line keeps the measured batch size', () => {
  const { progressOutcomeText } = helpers([
    'num',
    'plural',
    'formatTokens',
    'formatElapsed',
    'progressOutcomeText',
  ]);
  const progress = {
    elapsedMs: 84000,
    requestsDone: 9,
    requestsPlanned: 9,
    pairsJudged: 82,
    pairsTotal: 82,
    tokens: 12400,
    batchSize: 9,
  };
  assert.strictEqual(
    progressOutcomeText({ type: 'done', job: { progress } }),
    'Done in 1:24 · 9 requests · 82 pairs · 12.4k tokens · 9 pairs per request'
  );
  assert.strictEqual(
    progressOutcomeText({
      type: 'done',
      job: { progress: Object.assign({}, progress, { batchSize: null }) },
    }),
    'Done in 1:24 · 9 requests · 82 pairs · 12.4k tokens',
    'a review that never got to size anything says nothing about it'
  );
});

test('The panel says its phase once, and shows that the model is thinking', () => {
  const offered = renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  // One headline, one bar, three numbers, the split, the ceiling, the log —
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
  // The panel of a review that has finished says none of this any more.
  const outcome = functionBody('renderProgressOutcome');
  assert.ok(
    outcome.includes("classList.remove('dup-progress__fill--thinking')"),
    'a finished review keeps pulsing'
  );
  assert.ok(
    outcome.includes('progressCountsText(') &&
      outcome.includes('el.runPosition.textContent'),
    'a finished review does not sum itself up'
  );
  // The row is held open only while a review runs, so the tiles below do not
  // jump the moment the warm-up fills it.
  assert.ok(
    functionBody('showProgressPanel').includes("'dup-progress--live'"),
    'the panel has no reserved row while a review runs'
  );
});

test('A failed review points at the settings that could have prevented it', () => {
  const failure = functionBody('htmlReviewFailure');
  assert.ok(
    failure.includes('esc(text)'),
    'the message of a failed review must be escaped like everything else'
  );
  assert.ok(
    failure.includes('href="/settings#duplicates-tab"'),
    'the link must land on the Duplicates section, not on the settings page'
  );
  assert.ok(
    failure.includes('Open the Duplicates settings'),
    'the link needs the wording the page promises'
  );
  // One link, and every path that reports a failed review uses it.
  assert.strictEqual(
    (SCRIPT.match(/Open the Duplicates settings/g) || []).length,
    1,
    'the settings link is written once, not copied into every catch block'
  );
  assert.strictEqual(
    (SCRIPT.match(/htmlReviewFailure\(error\.message\)/g) || []).length,
    3,
    'the three AI paths must all report a failure the same way'
  );
  assert.ok(
    !/htmlAlert\(\s*'danger',\s*'The AI review failed'/.test(SCRIPT),
    'a failure notice without the settings link is left somewhere'
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

/* ── 14. a name for the survivor ──────────────────────────────────────────── */
/* A group of spellings often has no member that is the name the archive
   should end up with. The single dialog therefore carries a field; the batch
   and the two AI dialogs keep every target's name, because one field cannot
   stand for a dozen groups. */

test('The merge dialog asks for the name of the survivor', () => {
  assert.ok(
    SCRIPT.includes('id="dupTargetName"'),
    'the merge dialog has no name field'
  );
  assert.ok(
    SCRIPT.includes('Name of the survivor'),
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
  // "rename" is something the user does on purpose.
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
  ['htmlBatchDialog', 'htmlReviewDialog', 'htmlProposalDialog'].forEach(
    (name) => {
      const start = SCRIPT.indexOf(`function ${name}(`);
      assert.notStrictEqual(start, -1, `${name}() is gone`);
      const body = SCRIPT.slice(start, SCRIPT.indexOf('\n}\n', start));
      assert.ok(
        !body.includes('dupTargetName'),
        `${name} must keep the names of its groups, not rename them all at once`
      );
    }
  );
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

/* ── 15. unused objects ───────────────────────────────────────────────────── */

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
  // It sits between the results and the log: the log is where its undo is.
  assert.ok(
    page.indexOf('id="dupResults"') < page.indexOf('id="dupUnused"') &&
      page.indexOf('id="dupUnused"') < page.indexOf('id="dupLog"'),
    'the section belongs under the results and above the log'
  );
  assert.ok(
    /can be undone/.test(page),
    'the section must say that a delete is undoable before anything is ticked'
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

test('unusedConfirmText names the number, the kind and the way back', () => {
  const { unusedConfirmText } = helpers(
    ['num', 'plural', 'normalizeKind', 'unusedConfirmText'],
    { constants: ['KIND_LABELS', 'KIND_PLURALS'] }
  );
  const tags = (count) =>
    Array.from({ length: count }, () => ({ kind: 'tags' }));

  assert.strictEqual(
    unusedConfirmText(tags(12)),
    'Delete 12 unused tags? Undo re-creates them from the log, with new ids.'
  );
  assert.strictEqual(
    unusedConfirmText(tags(1)),
    'Delete 1 unused tag? Undo re-creates them from the log, with new ids.',
    'one object is not "1 tags"'
  );
  assert.match(
    unusedConfirmText([{ kind: 'correspondents' }, { kind: 'correspondents' }]),
    /^Delete 2 unused correspondents\?/
  );
  // A scan over both kinds produces a mixed selection; naming one of them
  // would be a lie about what is deleted.
  assert.match(
    unusedConfirmText([{ kind: 'tags' }, { kind: 'correspondents' }]),
    /^Delete 2 unused objects\?/
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
    /\/\/ A delete is a log entry like a merge, so the table below must show it\.\n\s+loadLog\(true\);/,
    'the log must be reloaded after a delete'
  );
  // Nothing is deleted without the question that names the way back.
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
    deleteFn.includes('unusedConfirmText(picked)'),
    'the dialog must ask the sentence the pure helper builds'
  );
  assert.ok(
    deleteFn.includes('markUnusedFailure'),
    'a refused object must keep its reason next to it'
  );
});

/* ── 16. the log speaks about deletes and renames ─────────────────────────── */

test('The log tells a delete from a merge and shows what a merge renamed', () => {
  const { isDeleteEntry, logSourceNames, htmlLogTargetCell } = helpers(
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

  // The two number cells a delete has no answer for read as a dash rather
  // than as a zero that looks like a merge that moved nothing.
  assert.match(
    SCRIPT,
    /const htmlDocuments = deleteRow\n\s+\? '<td data-label="Documents" class="zr-mono zr-faint">–<\/td>'/,
    'a delete row must not claim it moved 0 documents'
  );
  assert.match(
    SCRIPT,
    /data-log-action="delete"/,
    'a delete row must be findable by what it recorded'
  );
  // The undo dialog cannot promise to move documents back that never moved.
  assert.match(
    SCRIPT,
    /isDeleteEntry\(entry\)\n\s+\? `Re-creates \$\{names\} in Paperless-ngx with new ids\./,
    'the undo of a delete must be worded as one'
  );
});

/* ── 17. the names the creation guard mapped ──────────────────────────────── */

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
          esc: escForTest,
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
    linked.includes('Semantic (AI)'),
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
    linked.includes('<span class="zr-faint">–</span>'),
    'a mapping without a document says so instead of linking nowhere'
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
  assert.ok(
    SCRIPT.includes(
      'Nothing mapped yet. Document analysis records here when it used an '
    ),
    'the empty state must say what would put a row here'
  );
});

/* ── 18. the semantic sweep ───────────────────────────────────────────────── */

test('The sweep is a checkbox of the AI row, off and remembered', () => {
  const offered = renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  assert.ok(
    offered.includes('id="dupAiSweep"'),
    'the sweep checkbox is missing although the review is offered'
  );
  assert.ok(
    offered.includes(
      'Let the AI look at the whole list for synonyms and translations (more requests)'
    ),
    'the checkbox must say what it costs'
  );
  assert.ok(
    !/id="dupAiSweep"[^>]*checked/.test(offered),
    'a sweep costs requests of its own and must never be on by default'
  );
  // It is the third line of the AI row, under the two evidence options.
  assert.ok(
    offered.indexOf('id="dupAiExcerpts"') < offered.indexOf('id="dupAiSweep"'),
    'the sweep belongs under the two options it extends'
  );
  // An instance without the review renders none of it.
  assert.ok(
    !page.includes('id="dupAiSweep"'),
    'the sweep must not be rendered where no review is offered'
  );

  assert.match(
    SCRIPT,
    /semanticSweep: Boolean\(el\.aiSweep && el\.aiSweep\.checked\),/,
    'every AI path must send what the checkbox says'
  );
  assert.match(
    SCRIPT,
    /aiSweep: 'dup\.aiSweep',/,
    'the sweep must be remembered like the rest of the toolbar'
  );
  assert.match(
    SCRIPT,
    /el\.aiSweep\.checked = storeRead\(STORE_KEYS\.aiSweep\) === 'true';/,
    'a remembered sweep must come back ticked'
  );
  // The three AI paths all go through askForVerdicts, so one line covers the
  // proposal, "Ask the AI" and the guided flow.
  assert.strictEqual(
    (SCRIPT.match(/semanticSweep:/g) || []).length,
    1,
    'the sweep must be sent from the one place all three paths share'
  );
});

test('The judged tile says how many pairs came from the sweep', () => {
  const stats = SCRIPT.slice(
    SCRIPT.indexOf('function renderAiStats('),
    SCRIPT.indexOf('/** Registers a group and returns its card')
  );
  assert.match(
    stats,
    /if \(num\(review\.sweepProposals\) > 0\) \{\n\s+parts\.push\(`\$\{num\(review\.sweepProposals\)\} from the sweep`\);/,
    'the sub line must say how many pairs no string matcher could have found'
  );
  // Nothing is added when the sweep did not run; a "0 from the sweep" would
  // read like a sweep that found nothing rather than one that never ran.
  assert.ok(
    stats.indexOf('sweepProposals') > stats.indexOf('escalated'),
    'the sweep count belongs after the evidence counters'
  );
  assert.ok(
    /`requests` is every request the review made/.test(stats),
    'the request tile must say that the sweep is part of its number'
  );
  assert.strictEqual(
    (stats.match(/el\.statAiRequests\.textContent/g) || []).length,
    1,
    'the request count stays one number, the sweep included'
  );
  // The label of the reason the sweep produces is the page vocabulary.
  assert.match(
    SCRIPT,
    /semantic: 'Semantic \(AI\)',/,
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
  ].forEach((selector) => {
    assert.ok(
      CSS.includes(selector),
      `${selector} is used by the page but has no rule`
    );
  });
  // The drawers open like the two that were there before them.
  assert.match(
    CSS,
    /\.dup-unused\[open\] \.dup-unused__chevron \{\n\s+transform: rotate\(90deg\);/,
    'the unused drawer does not turn its chevron'
  );
  assert.match(
    CSS,
    /\.dup-mappings\[open\] \.dup-mappings__chevron \{\n\s+transform: rotate\(90deg\);/,
    'the mappings drawer does not turn its chevron'
  );
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

/* ── 19. round 10: splits in the log, a remembered verdict, the memory ────── */
/* The Simplify tags page writes its own rows into this log and this page shows
   and undoes them; the judge remembers verdicts and asks in several lanes, and
   both have to be visible where the numbers they change are. */

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
    undo.includes(
      'Undo this split? The tag is re-created with a new id, its documents get it back, the topics and the document type this split set are removed again.'
    ),
    'the confirmation must name everything the undo reverses'
  );
  assert.ok(
    undo.includes("'Undo this split'"),
    'the dialog title must say what is being undone'
  );
  assert.ok(
    undo.indexOf('isSplitEntry(entry)') < undo.indexOf('isDeleteEntry(entry)'),
    'a split is decided before the delete branch, or it reads as a merge'
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

test('The AI tiles say what memory and lanes saved', () => {
  const stats = SCRIPT.slice(
    SCRIPT.indexOf('function renderAiStats('),
    SCRIPT.indexOf('/** Registers a group and returns its card')
  );
  assert.match(
    stats,
    /if \(num\(review\.verdictsReused\) > 0\) \{\n\s+parts\.push\(`\$\{num\(review\.verdictsReused\)\} from memory`\);/,
    'the judged tile must say how many pairs never reached the model'
  );
  assert.ok(
    stats.indexOf('verdictsReused') > stats.indexOf('sweepProposals'),
    'the memory count closes the evidence line'
  );
  // One lane is the normal case and reads as no word at all; more than one is
  // the whole explanation of why a review took the time it did.
  assert.match(
    stats,
    /const lanes = Number\(review\.concurrency\);\n\s+if \(Number\.isFinite\(lanes\) && lanes > 1\) \{\n\s+costParts\.push\(`\$\{lanes\} lanes`\);/,
    'the request tile must say how many requests waited at once'
  );
  assert.ok(
    stats.indexOf('lanes') > stats.indexOf('per request'),
    'the lane count follows the batch size it multiplies'
  );
});

test('The AI row offers to forget the remembered verdicts', () => {
  const offered = renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  assert.ok(
    offered.includes('id="dupAiForgetBtn"'),
    'the button is missing although the review is offered'
  );
  assert.match(
    offered,
    /class="zr-btn zr-btn--ghost dup-ai-forget" id="dupAiForgetBtn"/,
    'forgetting is a ghost button, never a third way to start a review'
  );
  assert.ok(
    offered.includes('Forget remembered verdicts'),
    'the button is not labelled'
  );

  // Without the AI there is no memory to forget, so nothing of it renders.
  const plain = renderSync('duplicates.ejs', LOCALS);
  ['dupAiForgetBtn', 'Forget remembered verdicts'].forEach((needle) => {
    assert.ok(
      !plain.includes(needle),
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
    /Nothing in Paperless-ngx changes and no merge is undone/.test(forget),
    'the confirmation must say what it does not touch'
  );
  assert.match(
    CSS,
    /\.dup-ai-forget \{/,
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
