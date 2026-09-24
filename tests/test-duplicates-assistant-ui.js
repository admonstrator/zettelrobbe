/**
 * Test: duplicates-assistant-ui
 *
 * The Duplicates page as one page: the assistant on top, the whole toolset
 * under it from the first second, dimmed until a result exists, and the
 * proposal of a run landing as the tick on each group card.
 *
 * At contract level this checks the one thing that rots quietly: the
 * styleguide. /styleguide is where anyone looks before inventing a class, so
 * a kit component that never appears there does not exist in practice. The
 * page's own surfaces are checked below that, with the view rendered through
 * the real shell and the page script's pure helpers run on fixtures, next to
 * the kit modules they call (review-assist.js, review-guide.js).
 *
 * Covers:
 *  1. the styleguide shows every component of the kit, as real controls
 *  2. the view: one page, the assistant first, no mode, no retired class,
 *     one caption slot per tool
 *  3. the assistant in its three states: the start, the run, the result
 *  4. the waiting toolset
 *  5. the tick on a card: two signs, and the semantic case
 *  6. the numbers of the result, and the buttons that follow the ticks
 *  7. the sheet's model, with the price of the sweep
 *  8. the stack: the decision card, its keys, and decisions that only tick
 *  9. the run meter: the tally, the legend, the request log by kind
 * 10. applying a batch as a checklist
 * 11. the voice of the page
 */

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

const GUIDE = read('views', 'styleguide.ejs');
const SCRIPT = read('public', 'js', 'duplicates.js');
const CSS = read('public', 'css', 'pages', 'duplicates.css');

/** The classes retired after round 15; the page places none of them. */
const RETIRED = [
  'zr-start',
  'zr-resulthead',
  'zr-checklist',
  'zr-historyline',
  'zr-modebtn',
  'zr-gate',
];

/* ── 1. the styleguide ────────────────────────────────────────────────────── */

test('The styleguide has the section and a way to reach it', () => {
  assert.ok(
    GUIDE.includes('id="sg-review"'),
    'no review section in the styleguide'
  );
  assert.ok(
    GUIDE.includes('href="#sg-review"'),
    'the section is not in the styleguide navigation'
  );
  assert.ok(
    GUIDE.includes('css/review.css'),
    'the section does not say which file it documents'
  );
});

test('Every component of the kit is shown once', () => {
  [
    'zr-ledger',
    'zr-tokenbar__seg--prompt',
    'zr-tokenbar__seg--thinking',
    'zr-tokenbar--mini',
    'zr-decision__sides',
    'zr-decision__side--from',
    'zr-decision__note',
    'zr-decision__keys',
    'zr-consequence',
    'zr-consequence--free',
    'zr-runbar__fill',
    'zr-reqlog__row--live',
    'zr-reqlog__row--warn',
    'zr-sheet',
    // What this page is built from since it is one page.
    'zr-assist--start',
    'zr-assist--done',
    'zr-assist__headline',
    'zr-assist__actions',
    'zr-steps__step--now',
    'zr-runmeter__sentence',
    'zr-workspace__note',
    'zr-module__caption',
  ].forEach((className) => {
    assert.ok(
      GUIDE.includes(className),
      `${className} is not shown in the styleguide`
    );
  });
});

test('The examples are real controls', () => {
  const section = GUIDE.slice(
    GUIDE.indexOf('id="sg-review"'),
    GUIDE.indexOf('id="sg-toasts"')
  );
  assert.ok(section.length > 500, 'the section is suspiciously short');
  const buttons = section.match(/<button[^>]*>/g) || [];
  assert.ok(
    buttons.length >= 8,
    `only ${buttons.length} buttons in the examples`
  );
  buttons.forEach((button) => {
    assert.ok(
      button.includes('type="button"'),
      `a button without a type submits something one day: ${button}`
    );
  });
  assert.ok(
    !/<div[^>]+onclick/i.test(section),
    'a div with a click handler is not reachable with a keyboard'
  );
});

/* ── the harness ──────────────────────────────────────────────────────────── */
/* The same way tests/test-duplicates-ui.js does it: the view is rendered
   through the real shell partials, and the page script's pure helpers are
   evaluated out of their module so a sentence can be read rather than
   grepped for. The kit modules the page imports are loaded the same way and
   handed in. */

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

/** The body of a top-level function, for the checks that only read it. */
function functionBody(name) {
  const source = functionSource(name);
  return source.slice(source.indexOf('{'));
}

/**
 * The whole statement of a top-level const: an object, an array or a
 * number. Only the page's own values are read, so a renamed label or a
 * changed limit fails here rather than in a copy of it.
 */
function constantSource(name) {
  const start = SCRIPT.indexOf(`\nconst ${name} = `);
  assert.notStrictEqual(start, -1, `${name} is gone from the page script`);
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < SCRIPT.length; i += 1) {
    const character = SCRIPT[i];
    const pair = SCRIPT.slice(i, i + 2);
    // A comment may carry an apostrophe; it is skipped whole.
    if (!quote && pair === '//') {
      i = SCRIPT.indexOf('\n', i);
      continue;
    }
    if (!quote && pair === '/*') {
      i = SCRIPT.indexOf('*/', i) + 1;
      continue;
    }
    if (quote) {
      if (character === '\\') i += 1;
      else if (character === quote) quote = null;
    } else if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if ('([{'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character)) {
      depth -= 1;
    } else if (character === ';' && depth === 0) {
      return SCRIPT.slice(start + 1, i + 1);
    }
  }
  throw new Error(`${name} is not terminated`);
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
 * A browser module of the kit, loaded the way tests/test-review-sheet.js
 * loads it: the imports dropped, the exports made plain declarations.
 */
function loadModule(file, names, globals = {}) {
  const source = read(...file.split('/'))
    .replace(/^import [\s\S]*?;$/gm, '')
    .replace(/^export (const|function) /gm, '$1 ');
  const keys = Object.keys(globals);
  return new Function(
    'esc',
    ...keys,
    `${source}\nreturn { ${names.join(', ')} };`
  )(escForTest, ...keys.map((key) => globals[key]));
}

/** What the page imports from the shared sheet module. */
const SHEET = loadModule('public/js/modules/review-sheet.js', [
  'formatTokens',
  'roughTime',
  'htmlSheet',
]);

/** A classList that remembers, for the helpers that toggle one. */
function fakeElement(classes = []) {
  const set = new Set(classes);
  return {
    textContent: '',
    innerHTML: '',
    disabled: false,
    style: {},
    dataset: {},
    classList: {
      add: (name) => set.add(name),
      remove: (name) => set.delete(name),
      contains: (name) => set.has(name),
      toggle: (name, on) => {
        const next = on === undefined ? !set.has(name) : Boolean(on);
        if (next) set.add(name);
        else set.delete(name);
        return next;
      },
    },
  };
}

/** What the page imports from the assistant module and the guide. */
const ASSIST = loadModule(
  'public/js/modules/review-assist.js',
  [
    'stepStates',
    'htmlSteps',
    'htmlSentence',
    'htmlAssistStart',
    'htmlAssistDone',
    'htmlCaption',
  ],
  { document: { createElement: () => fakeElement() } }
);
const { DUPLICATES_GUIDE } = loadModule('public/js/modules/review-guide.js', [
  'DUPLICATES_GUIDE',
]);

/**
 * The named helpers of the page script, evaluated out of their module, with
 * what the module imports handed in.
 *
 * `expose` returns constants as well, for a test that has to look at the
 * state the helpers keep.
 *
 * @param {string[]} names
 * @param {{constants?: string[], globals?: object, expose?: string[]}} [extra]
 */
function helpers(names, extra = {}) {
  const constants = (extra.constants || []).map(constantSource).join('\n');
  const source = names.map(functionSource).join('\n');
  const returned = names.concat(extra.expose || []);
  const globals = Object.assign(
    {
      esc: escForTest,
      formatTokens: SHEET.formatTokens,
      roughTime: SHEET.roughTime,
      DUPLICATES_GUIDE,
    },
    ASSIST,
    extra.globals || {}
  );
  const keys = Object.keys(globals);
  return new Function(
    ...keys,
    `${constants}\n${source}\nreturn { ${returned.join(', ')} };`
  )(...keys.map((key) => globals[key]));
}

/** One group of the fixtures below, with the page's own defaults applied. */
function stateOf(group) {
  const targetId = Number(group.suggestedTargetId);
  return {
    group,
    targetId,
    selected: new Set(
      group.members
        .map((member) => Number(member.id))
        .filter((id) => id !== targetId)
    ),
  };
}

/** Two members, for the cases that only differ in how they were found. */
function pairOf(id, extra) {
  const numeric = Number(String(id).replace(/\D/g, '')) || 1;
  return stateOf(
    Object.assign(
      {
        id,
        kind: 'tags',
        confidence: 0.9,
        reasons: ['fuzzy'],
        warnings: [],
        suggestedTargetId: numeric * 10,
        members: [
          { id: numeric * 10, name: `Keep ${id}`, documentCount: 10 },
          { id: numeric * 10 + 1, name: `Away ${id}`, documentCount: 2 },
        ],
      },
      extra
    )
  );
}

/* One scan, with one group of every kind the page has to read. */
const FIXTURE = {
  plain: stateOf({
    id: 'tags:1-2',
    kind: 'tags',
    confidence: 1,
    reasons: ['exact-normalized'],
    warnings: [],
    suggestedTargetId: 1,
    members: [
      { id: 1, name: 'Rechnung', documentCount: 449, matchingAlgorithm: 0 },
      { id: 2, name: 'rechnungen', documentCount: 37, matchingAlgorithm: 0 },
    ],
  }),
  same: stateOf({
    id: 'correspondents:5-6',
    kind: 'correspondents',
    confidence: 0.88,
    reasons: ['legal-form'],
    warnings: [],
    suggestedTargetId: 5,
    aiVerdict: {
      verdict: 'same',
      confidence: 'high',
      basis: 'legal-form',
      reason: 'The same company with and without its legal form.',
    },
    members: [
      {
        id: 5,
        name: 'Müller GmbH',
        documentCount: 140,
        matchingAlgorithm: 0,
        sampleTitles: ['Rechnung 2024-08-14', 'Mahnung 2024-09-02'],
      },
      {
        id: 6,
        name: 'Müller GmbH & Co. KG',
        documentCount: 9,
        matchingAlgorithm: 1,
        match: 'mueller',
      },
    ],
  }),
  ask: stateOf({
    id: 'tags:9-10',
    kind: 'tags',
    confidence: 0.86,
    reasons: ['fuzzy'],
    warnings: ['has-matching-rule'],
    suggestedTargetId: 9,
    aiVerdict: {
      verdict: 'unsure',
      confidence: 'low',
      basis: 'insufficient-evidence',
      reason: 'Kontoauszug and Kontoumzug are not obviously the same word.',
    },
    members: [
      { id: 9, name: 'Kontoauszug', documentCount: 212, matchingAlgorithm: 0 },
      {
        id: 10,
        name: 'Kontoumzug',
        documentCount: 4,
        matchingAlgorithm: 1,
        match: 'konto',
      },
    ],
  }),
  three: stateOf({
    id: 'tags:20-21-22',
    kind: 'tags',
    confidence: 0.97,
    reasons: ['umlaut-variant'],
    warnings: [],
    suggestedTargetId: 20,
    members: [
      { id: 20, name: 'Bücherei', documentCount: 31, matchingAlgorithm: 0 },
      { id: 21, name: 'Buecherei', documentCount: 6, matchingAlgorithm: 0 },
      { id: 22, name: 'buecherei', documentCount: 2, matchingAlgorithm: 0 },
    ],
  }),
  apart: stateOf({
    id: 'tags:30-31',
    kind: 'tags',
    confidence: 0.86,
    reasons: ['prefix'],
    warnings: [],
    suggestedTargetId: 30,
    aiVerdict: {
      verdict: 'different',
      confidence: 'high',
      basis: 'different-thing',
    },
    members: [
      { id: 30, name: 'Auto', documentCount: 80, matchingAlgorithm: 0 },
      { id: 31, name: 'Autor', documentCount: 12, matchingAlgorithm: 0 },
    ],
  }),
  /* The pair that started it: the sweep proposed it, the model said "same"
     and was sure, and nothing in the spelling links the two names. */
  racun: stateOf({
    id: 'tags:40-41',
    kind: 'tags',
    confidence: 0.5,
    reasons: ['semantic'],
    warnings: [],
    source: 'ai-candidate',
    suggestedTargetId: 40,
    aiVerdict: {
      verdict: 'same',
      confidence: 'high',
      basis: 'synonym',
      reason: 'Both name invoices of a physiotherapy practice.',
    },
    members: [
      { id: 40, name: 'Physiotherapie', documentCount: 12 },
      { id: 41, name: 'Racun', documentCount: 3, matchedBy: 'semantic' },
    ],
  }),
};

/* ── 2. the view ──────────────────────────────────────────────────────────── */

let page = '';
let offered = '';

/** The opening tag of the element with this id. */
function openingTag(markup, id) {
  const tag = new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`).exec(markup);
  assert.ok(tag, `#${id} is missing from the view`);
  return tag[0];
}

/** The rendered page between its root and its script. */
function pageRoot(markup) {
  return markup.slice(
    markup.indexOf('<div class="dup-page'),
    markup.indexOf('<script type="module" src="/js/duplicates.js">')
  );
}

test('The page is one page: the root names itself and starts waiting', () => {
  page = renderSync('duplicates.ejs', LOCALS);
  offered = renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  [page, offered].forEach((markup) => {
    assert.match(
      markup,
      /<div class="dup-page zr-workspace--waiting" data-review-page="duplicates">/,
      'the root must name the page and start dimmed, so the first paint waits'
    );
    assert.ok(
      !/\sdata-(simple|advanced|mode)[\s=>]/.test(pageRoot(markup)),
      'no part of the page is marked for a mode'
    );
    // The top bar slot of the shell is there and stays empty.
    assert.match(
      markup,
      /<span class="zr-topbar__actions" id="zrTopbarActions"><\/span>/,
      'the slot in the top bar must stay empty'
    );
  });
  // Nothing of the retired mode is left in the script.
  assert.ok(
    !SCRIPT.includes('review-mode.js'),
    'the page still imports the mode'
  );
  ['zrTopbarActions', 'data-mode', 'data-simple', 'data-advanced'].forEach(
    (needle) => {
      assert.ok(!SCRIPT.includes(needle), `the script still knows ${needle}`);
    }
  );
  assert.ok(
    !/\bmode\b/i.test(constantSource('STORE_KEYS')),
    'nothing is stored about a mode'
  );
  ['initMode', 'renderSimple', 'updateSimpleSurface', 'GATE_LINES'].forEach(
    (name) => {
      assert.ok(
        !new RegExp(`\\b${name}\\b`).test(SCRIPT),
        `${name} is still in the page script`
      );
    }
  );
});

test('The assistant is the first child of the root, and the meter lives in it', () => {
  [page, offered].forEach((markup) => {
    const root = pageRoot(markup);
    const afterRoot = root
      .slice(root.indexOf('>') + 1)
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    assert.ok(
      afterRoot.startsWith(
        '<section class="dup-assist" id="dupAssist" data-assist'
      ),
      `the assistant is not the first child of the root: ${afterRoot.slice(0, 80)}`
    );
    const start = root.indexOf('id="dupAssist"');
    const end = root.indexOf('</section>', start);
    [
      'dupAssistCard',
      'dupAiProgress',
      'dupRunSteps',
      'dupRunSentence',
      'dupAiNotice',
    ].forEach((id) => {
      const at = root.indexOf(`id="${id}"`);
      assert.ok(at > start && at < end, `#${id} belongs inside the assistant`);
    });
    // The card is the script's: the view draws no start of its own.
    assert.match(
      root,
      /<div class="dup-assist__card" id="dupAssistCard"><\/div>/,
      'the card of the assistant is drawn by the script'
    );
    assert.ok(!root.includes('id="dupFindBtn"'));
  });
  // A scan runs on the meter too, so it is on every instance; Stop only
  // where a model can be stopped.
  assert.ok(page.includes('id="dupAiProgress"'));
  assert.ok(!page.includes('id="dupAiStopBtn"'));
  assert.ok(offered.includes('id="dupAiStopBtn"'));
  assert.match(
    openingTag(offered, 'dupAiProgress'),
    /class="dup-progress zr-runmeter hidden"/,
    'the meter is hidden until something runs'
  );
});

test('No retired class is placed by the view, the script or the stylesheet', () => {
  RETIRED.forEach((name) => {
    [
      ['view', pageRoot(page) + pageRoot(offered)],
      ['script', SCRIPT],
      ['stylesheet', CSS],
    ].forEach(([where, text]) => {
      assert.ok(!text.includes(name), `the ${where} still places ${name}`);
    });
  });
  // The simple result and its ids are gone with it.
  [
    'dupEmpty',
    'dupResult',
    'dupChecklists',
    'dupHistoryLine',
    'dupStartFacts',
  ].forEach((id) => {
    assert.ok(!page.includes(`id="${id}"`), `#${id} is still in the view`);
  });
});

test('Every tool has one caption slot, written from the guide', () => {
  const keys = Object.keys(DUPLICATES_GUIDE.sections);
  const slots = (markup) =>
    [...markup.matchAll(/<p data-caption="([a-z]+)"><\/p>/g)].map(
      (match) => match[1]
    );
  assert.deepStrictEqual(
    slots(offered).sort(),
    [...keys].sort(),
    'one slot per section of the guide, no more and no less'
  );
  assert.deepStrictEqual(
    slots(page).sort(),
    keys.filter((key) => key !== 'memory').sort(),
    'without the model there is no memory to caption'
  );
  // Each slot sits under the head of its own tool.
  [
    ['controls', 'dupControls'],
    ['manual', 'dupManual'],
    ['groups', 'dupResultsBar'],
    ['unused', 'dupUnused'],
    ['log', 'dupLog'],
    ['mappings', 'dupMappings'],
    ['dismissals', 'dupDismissals'],
    ['memory', 'dupAiForgetBtn'],
  ].forEach(([key, id]) => {
    const slot = offered.indexOf(`data-caption="${key}"`);
    const tool = offered.indexOf(`id="${id}"`);
    const next = offered.indexOf('data-caption=', slot + 1);
    assert.ok(
      key === 'memory' ? slot < tool : tool < slot,
      `the ${key} caption is not with its tool`
    );
    assert.ok(
      key === 'memory' || next === -1 || next > slot,
      `the ${key} caption is out of order`
    );
  });
  // The script writes each one through the kit.
  const init = functionBody('initCaptions');
  assert.ok(
    init.includes("querySelectorAll('[data-caption]')") &&
      init.includes('htmlCaption(') &&
      init.includes('DUPLICATES_GUIDE.sections[slot.dataset.caption]'),
    'the captions are not written from the guide through htmlCaption'
  );
  assert.match(
    functionBody('init'),
    /initCaptions\(\);/,
    'the captions are not written when the page opens'
  );
});

test('The stylesheet places the kit and redefines none of it', () => {
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...rules.matchAll(/([^{}@;]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((selector) => selector && !selector.startsWith('@'))
    .flatMap((selector) => selector.split(','))
    .map((selector) => selector.trim())
    .filter((selector) => /zr-/.test(selector));
  selectors.forEach((selector) => {
    assert.ok(
      /^\.dup-[^\s>]*[\s>]/.test(selector),
      `a kit class without a page parent: ${selector}`
    );
  });
  assert.ok(!CSS.includes('data-mode'), 'the stylesheet still knows a mode');
  // On a phone the assistant stacks; the kit does that for both pages.
  assert.match(
    read('public', 'css', 'review.css'),
    /@media \(max-width: 720px\) \{\n[\s\S]*?\.zr-assist \{\n\s+flex-direction: column;/,
    'the assistant does not stack on a phone'
  );
});

/* ── 3. the assistant in its three states ─────────────────────────────────── */

test('The assistant is in one of three states, read off the page', () => {
  const { assistStateOf } = helpers(['assistStateOf']);
  assert.strictEqual(assistStateOf({}), 'start');
  assert.strictEqual(assistStateOf({ scanned: true }), 'done');
  assert.strictEqual(
    assistStateOf({ scanned: true, held: true }),
    'start',
    'the sheet after the scan keeps the start up'
  );
  assert.strictEqual(assistStateOf({ live: true }), 'running');
  assert.strictEqual(
    assistStateOf({ live: true, scanned: true, held: true }),
    'running',
    'a run wins over everything'
  );
});

test('The start: the guide, the one button and the facts of the last run', () => {
  const draw = (offeredModel, facts, busy) =>
    helpers(['htmlStartCard'], {
      globals: {
        aiReviewOffered: () => offeredModel,
        assist: { facts },
      },
    }).htmlStartCard(busy);
  const start = draw(true, '', false);
  assert.ok(start.startsWith('<div class="zr-assist zr-assist--start">'));
  assert.ok(start.includes('#i-wand'), 'the start has no wand');
  assert.ok(
    start.includes(
      '<h2 class="zr-assist__title">Merge tags and correspondents that mean the same thing.</h2>'
    )
  );
  assert.ok(
    start.includes(escForTest(DUPLICATES_GUIDE.start.what)),
    'the line with the model is the guide’s'
  );
  assert.ok(
    start.includes(
      '<button class="zr-btn zr-btn--primary zr-btn--lg" id="dupFindBtn" type="button">Find duplicates</button>'
    ),
    'the start has no large primary "Find duplicates"'
  );
  assert.ok(
    start.includes(
      '<p class="zr-assist__facts hidden" id="dupStartFacts"></p>'
    ),
    'an empty facts line is hidden'
  );
  const without = draw(false, '', true);
  assert.ok(
    without.includes(escForTest(DUPLICATES_GUIDE.start.whatWithoutModel)),
    'the line without the model is the guide’s own'
  );
  assert.ok(
    without.includes('id="dupFindBtn" type="button" disabled>'),
    'the button waits while something runs'
  );
  assert.ok(
    draw(true, 'Last run 20 Sep · 275 pairs', false).includes(
      '<p class="zr-assist__facts" id="dupStartFacts">Last run 20 Sep · 275 pairs</p>'
    )
  );
  // The button does what it did: it scans, then opens the sheet.
  assert.match(
    functionBody('initAssist'),
    /closest\('#dupFindBtn'\)\) \{\n\s+findDuplicates\(\);/,
    'the button does not start the one flow'
  );
  const find = functionBody('findDuplicates');
  const scan = find.indexOf('await runScan(options, { withModel: true });');
  const held = find.indexOf('assist.held = true;');
  const sheet = find.indexOf('if (!(await confirmRun(options))) return;');
  const ask = find.indexOf('askForVerdicts({ includeCandidates: true }');
  const released = find.lastIndexOf('assist.held = false;');
  assert.ok(
    scan > -1 && scan < held && held < sheet && sheet < ask && ask < released,
    'scan, the sheet over the start, the run, and the result shows at the end'
  );
  assert.match(
    find,
    /if \(!aiReviewOffered\(\)\) \{\n\s+await runScan\(options\);\n\s+return;\n\s+\}/,
    'without a model the button only scans'
  );
  assert.ok(
    find.includes('const options = controlOptions();'),
    'the button scans with what the scan row shows'
  );
  // Any answer lets the result show, and makes the page a result.
  const apply = functionBody('applyReviewResult');
  assert.ok(apply.includes('assist.held = false;'));
  assert.ok(apply.includes('scanned = true;'));
});

/** Steps, sentence and tally of the meter, with a fake meter to draw into. */
function runGuide(progress, run = {}) {
  const el = { runSteps: fakeElement(), runSentence: fakeElement() };
  const assist = Object.assign(
    { withModel: true, sawWarmup: false },
    run.assist || {}
  );
  const levers = Object.assign(
    { sweep: false, excerpts: true },
    run.levers || {}
  );
  const kit = helpers(
    [
      'num',
      'count',
      'plural',
      'runSteps',
      'requestSub',
      'tallyOf',
      'tallySentence',
      'renderRunGuide',
    ],
    {
      constants: ['REQUEST_PHASES', 'SCAN_STEPS'],
      globals: { el, assist, levers },
    }
  );
  kit.renderRunGuide(progress);
  return { el, assist, kit };
}

/** The labels of a drawn strip, with the state and sub of each step. */
function stripOf(markup) {
  return [
    ...markup.matchAll(
      /zr-steps__step--(done|now|next)"><span class="zr-steps__mark">.*?<\/span>([^<]+)(?:<span class="zr-steps__sub">· ([^<]+)<\/span>)?/g
    ),
  ].map((match) => `${match[2]}:${match[1]}${match[3] ? `(${match[3]})` : ''}`);
}

test('The run: the steps of this run, the one it is on, and where it is', () => {
  const judging = {
    phase: 'judging',
    requestsDone: 4,
    requestsPlanned: 11,
    calibrated: true,
    tally: { same: 7, different: 3, unsure: 1 },
  };
  const { el } = runGuide(judging, { assist: { sawWarmup: true } });
  assert.deepStrictEqual(
    stripOf(el.runSteps.innerHTML),
    [
      'Compare names:done',
      'Read documents:done',
      'Measure the model:done',
      'Judge pairs:now(request 5 of 11)',
      'Ask again with excerpts:next',
      'Result:next',
    ],
    'the sweep is left out when it is off; the current step says where it is'
  );
  // With the sweep, and a model measured before this run.
  const swept = runGuide(judging, { levers: { sweep: true } }).el;
  assert.deepStrictEqual(stripOf(swept.runSteps.innerHTML), [
    'Compare names:done',
    'Read documents:done',
    'Look for synonyms:done',
    'Judge pairs:now(request 5 of 11)',
    'Ask again with excerpts:next',
    'Result:next',
  ]);
  // The run the reload found: the step of its phase is never dropped.
  const sweeping = runGuide(
    { phase: 'sweeping', requestsDone: 0, requestsPlanned: 2 },
    { levers: { sweep: false } }
  ).el;
  assert.ok(
    stripOf(sweeping.runSteps.innerHTML).includes(
      'Look for synonyms:now(request 1 of 2)'
    )
  );
  // Without excerpts there is no second round.
  const bare = runGuide(judging, { levers: { excerpts: false } }).el;
  assert.ok(
    !stripOf(bare.runSteps.innerHTML).some((step) =>
      step.startsWith('Ask again')
    )
  );
  // A scan without the model is two steps, and the scan names no request.
  const scan = runGuide(
    { phase: 'scanning' },
    { assist: { withModel: false } }
  ).el;
  assert.deepStrictEqual(stripOf(scan.runSteps.innerHTML), [
    'Compare names:now',
    'Result:next',
  ]);
  // The warm-up is its own step once the run measured the model.
  const warming = runGuide({ phase: 'warming-up', requestsPlanned: 11 });
  assert.ok(warming.assist.sawWarmup, 'the page remembers the warm-up');
  assert.ok(
    stripOf(warming.el.runSteps.innerHTML).includes(
      'Measure the model:now(request 1 of 11)'
    )
  );
});

test('The run: what happens now, why, and what the model said so far', () => {
  const { el } = runGuide({
    phase: 'judging',
    tally: { same: 7, different: 3, unsure: 1 },
  });
  const phase = DUPLICATES_GUIDE.phases.judging;
  assert.strictEqual(
    el.runSentence.innerHTML,
    `<p class="zr-runmeter__sentence">${escForTest(`${phase.what} ${phase.why} 7 of 11 pairs so far were the same.`)}</p>`
  );
  const before = runGuide({ phase: 'judging', tally: null }).el;
  assert.ok(
    before.runSentence.innerHTML.endsWith(`${escForTest(phase.why)}</p>`),
    'before the model answered the sentence ends with its why'
  );
  const scanning = runGuide({ phase: 'scanning' }).el;
  assert.ok(
    scanning.runSentence.innerHTML.includes(
      escForTest(DUPLICATES_GUIDE.phases.scanning.what)
    )
  );
  const { tallySentence, tallyText } = helpers(
    ['num', 'count', 'plural', 'tallyOf', 'tallySentence', 'tallyText'],
    {}
  );
  assert.strictEqual(tallySentence(null), '');
  assert.strictEqual(
    tallySentence({ same: 0, different: 0, unsure: 0 }),
    '',
    'nothing answered is nothing said'
  );
  assert.strictEqual(
    tallySentence({ same: 1, different: 0, unsure: 0 }),
    '1 of 1 pair so far was the same.'
  );
  assert.strictEqual(
    tallyText({ same: 7, different: 3, unsure: 1 }),
    '7 same · 3 different · 1 unsure'
  );
  // The meter draws it, and the scan phase too, without a Stop.
  assert.ok(functionBody('renderProgress').includes('renderRunGuide(state);'));
  const phaseBody = functionBody('showScanPhase');
  assert.ok(phaseBody.includes("renderRunGuide({ phase: 'scanning' });"));
  assert.ok(phaseBody.includes("el.aiStopBtn.classList.add('hidden')"));
  assert.ok(
    functionBody('runScan').includes(
      'showScanPhase(Boolean(show && show.withModel));'
    ),
    'every scan runs on the meter'
  );
});

/* ── 6. the numbers of the result ─────────────────────────────────────────── */

/** Rows the way cardRows() reads the cards. */
function rowsOf(list) {
  return list.map((row, index) =>
    Object.assign(
      { id: `g${index}`, mergeable: true, ticked: false, writes: 0 },
      row
    )
  );
}

/* The result of the mockup: 13 proposed and ticked for 41 writes, 4 unsure,
   and one merged group that counts for nothing any more. */
const RESULT_ROWS = rowsOf([
  ...Array.from({ length: 12 }, () => ({
    proposed: true,
    ticked: true,
    writes: 3,
  })),
  { proposed: true, ticked: true, writes: 5 },
  ...Array.from({ length: 4 }, () => ({ proposed: false })),
  { proposed: true, ticked: false, mergeable: false, writes: 0 },
]);

const REVIEW = { requests: 7, tokens: 11000 };
const REVIEW_PROGRESS = {
  elapsedMs: 38000,
  promptTokens: 8800,
  completionTokens: 2200,
  thinkingTotal: 0,
};

function doneKit(globals = {}) {
  return helpers(
    [
      'num',
      'count',
      'plural',
      'mergeLabel',
      'resultNumbers',
      'doneHeadline',
      'resultCost',
      'htmlMiniBar',
      'htmlDoneCard',
    ],
    {
      globals: Object.assign(
        {
          lastRunReview: REVIEW,
          lastRunProgress: REVIEW_PROGRESS,
          lastScanTotals: { tags: 40, correspondents: 14 },
        },
        globals
      ),
    }
  );
}

test('The result counts what is proposed, what is unsure, and what Merge writes', () => {
  const { resultNumbers, doneHeadline } = doneKit();
  const numbers = resultNumbers(RESULT_ROWS);
  assert.deepStrictEqual(
    {
      proposed: numbers.proposed,
      unsure: numbers.unsure,
      merges: numbers.merges,
      writes: numbers.writes,
    },
    { proposed: 13, unsure: 4, merges: 13, writes: 41 },
    'a merged group is out of every number'
  );
  assert.deepStrictEqual(numbers.unsureIds, ['g13', 'g14', 'g15', 'g16']);
  assert.strictEqual(
    doneHeadline({ tags: 40, correspondents: 14 }, 13, 4),
    '54 scanned · 13 merges proposed · 4 unsure'
  );
  assert.strictEqual(
    doneHeadline({ tags: 1 }, 1, 0),
    '1 scanned · 1 merge proposed · 0 unsure'
  );
  assert.strictEqual(doneHeadline(null, 0, 2), '0 merges proposed · 2 unsure');
  // A tick moves Merge; the proposal stays what the run said.
  const unticked = RESULT_ROWS.map((row, index) =>
    index === 0 ? Object.assign({}, row, { ticked: false }) : row
  );
  const after = resultNumbers(unticked);
  assert.deepStrictEqual(
    [after.proposed, after.unsure, after.merges, after.writes],
    [13, 4, 12, 38]
  );
  // An unsure group ticked by hand, or in the stack, is merged as well.
  const ticked = RESULT_ROWS.map((row, index) =>
    index === 13 ? Object.assign({}, row, { ticked: true, writes: 2 }) : row
  );
  assert.deepStrictEqual(
    [resultNumbers(ticked).merges, resultNumbers(ticked).writes],
    [14, 43]
  );
});

test('The result: the headline, the cost, how to go on, and two buttons', () => {
  const kit = doneKit();
  const done = kit.htmlDoneCard(kit.resultNumbers(RESULT_ROWS), false);
  assert.ok(done.startsWith('<div class="zr-assist zr-assist--done">'));
  assert.ok(
    done.includes(
      '<p class="zr-assist__headline">54 scanned · 13 merges proposed · 4 unsure</p>'
    )
  );
  assert.ok(
    done.includes('zr-tokenbar zr-tokenbar--mini') &&
      done.includes('<span>7 requests · 11k tokens · under a minute</span>'),
    'the cost line has no bar or no numbers'
  );
  DUPLICATES_GUIDE.done.next.forEach((line) => {
    assert.ok(
      done.includes(`<li>${escForTest(line)}</li>`),
      `missing: ${line}`
    );
  });
  assert.ok(
    done.includes(
      '<button type="button" class="zr-btn dup-assist-review" id="dupReviewUnsureBtn">Review 4 unsure one by one</button>'
    )
  );
  assert.ok(
    done.includes(
      '<button type="button" class="zr-btn zr-btn--primary dup-assist-merge" id="dupMergeTickedBtn">Merge 13 · 41 writes</button>'
    )
  );
  // Nothing unsure: no Review. Nothing ticked: Merge waits.
  const none = kit.htmlDoneCard(
    kit.resultNumbers(rowsOf([{ proposed: true, ticked: false }])),
    false
  );
  assert.ok(!none.includes('dup-assist-review'));
  assert.ok(
    none.includes('id="dupMergeTickedBtn" disabled>Merge 0 · 0 writes')
  );
  // A batch that writes holds both.
  const busy = kit.htmlDoneCard(kit.resultNumbers(RESULT_ROWS), true);
  assert.ok(busy.includes('id="dupReviewUnsureBtn" disabled>'));
  assert.ok(busy.includes('id="dupMergeTickedBtn" disabled>'));
  // A scan without the model has no cost line, and neither has a run that
  // asked nothing; there is never a "not recorded".
  [null, { requests: 0, tokens: 0 }].forEach((review) => {
    const plain = doneKit({ lastRunReview: review }).htmlDoneCard(
      kit.resultNumbers(RESULT_ROWS),
      false
    );
    assert.ok(!plain.includes('zr-assist__cost'), 'a cost line for nothing');
  });
  assert.ok(
    !/not recorded/i.test(SCRIPT),
    'the page still says "not recorded"'
  );
  // The buttons: the stack over the unsure groups, and today's batch merge.
  const init = functionBody('initAssist');
  assert.ok(init.includes("closest('.dup-assist-review')"));
  assert.ok(init.includes('openStack(unsureGroupIds());'));
  assert.ok(init.includes("closest('.dup-assist-merge')"));
  assert.ok(init.includes('mergeSelected();'));
  assert.ok(
    functionBody('mergeSelected').includes('await confirmMerge(entries, []);'),
    'Merge asks with the batch dialog of today'
  );
});

test('The numbers follow the ticks on the cards, live', () => {
  // Every tick, every card that goes busy or finishes, every new answer
  // runs through the selection bar, and the bar redraws the assistant.
  assert.match(
    functionBody('updateSelectionBar'),
    /if \(drawing\) return;\n\s+renderAssist\(\);/,
    'the assistant does not follow the selection'
  );
  const rows = functionBody('cardRows');
  [
    'isProposed(state.group)',
    "selectBlockReason(card, state) === ''",
    'selectedGroups.has(id)',
    'entryWrites(entry)',
  ].forEach((part) => {
    assert.ok(rows.includes(part), `the rows are read without ${part}`);
  });
  // A card that would come out the same is not drawn again.
  assert.ok(functionBody('renderAssist').includes('markup !== assist.markup'));
});

/* ── 4. the waiting toolset ───────────────────────────────────────────────── */

test('The toolset waits on load and during a run, and wakes with a result', () => {
  const draw = (flags) => {
    const calls = [];
    const el = {
      assistCard: fakeElement(),
      aiProgress: fakeElement(flags.live ? ['dup-progress--live'] : ['hidden']),
      assist: fakeElement(),
      page: fakeElement(),
    };
    const assist = Object.assign(
      { held: false, markup: null, waiting: null, logVisit: false },
      flags.assist || {}
    );
    const kit = helpers(['assistStateOf', 'renderAssist'], {
      globals: {
        el,
        assist,
        scanned: flags.scanned === true,
        scanning: false,
        aiReviewing: false,
        merging: false,
        proposing: false,
        drawing: false,
        htmlStartCard: () => 'START',
        htmlDoneCard: () => 'DONE',
        resultNumbers: () => ({}),
        cardRows: () => [],
        setWorkspaceWaiting: (root, waiting) => calls.push(waiting),
      },
    });
    kit.renderAssist();
    kit.renderAssist();
    return {
      calls,
      state: el.assist.dataset.state,
      card: el.assistCard.innerHTML,
      cardHidden: el.assistCard.classList.contains('hidden'),
      meterHidden: el.aiProgress.classList.contains('hidden'),
    };
  };
  assert.deepStrictEqual(draw({}), {
    calls: [true],
    state: 'start',
    card: 'START',
    cardHidden: false,
    meterHidden: true,
  });
  assert.deepStrictEqual(draw({ live: true, scanned: true }), {
    calls: [true],
    state: 'running',
    card: '',
    cardHidden: true,
    meterHidden: false,
  });
  assert.deepStrictEqual(draw({ scanned: true }), {
    calls: [false],
    state: 'done',
    card: 'DONE',
    cardHidden: false,
    meterHidden: true,
  });
  // The sheet over a fresh scan: still waiting.
  assert.deepStrictEqual(
    draw({ scanned: true, assist: { held: true } }).calls,
    [true]
  );
  // A visit that came for the log gets the log.
  assert.deepStrictEqual(draw({ assist: { logVisit: true } }).calls, [false]);
  // The kit's switch is the one used, on the page root.
  assert.ok(
    functionBody('renderAssist').includes(
      'setWorkspaceWaiting(el.page, waiting);'
    )
  );
  assert.ok(
    functionBody('initLogVisit').includes("window.location.hash !== '#dupLog'")
  );
});

/* ── 5. the tick on a card ────────────────────────────────────────────────── */

function tickKit() {
  return helpers(
    [
      'num',
      'pct',
      'isSureSame',
      'isRuleVerdict',
      'basisLabel',
      'isSemanticGroup',
      'isProposed',
      'proposalReason',
      'clip',
      'htmlProposalReason',
      'reasonChipLabel',
    ],
    {
      constants: [
        'PLAIN_SCORE',
        'ASK_WARNINGS',
        'REASON_BY_WARNING',
        'REASON_MAX',
        'AI_BASIS_LABELS',
        'AI_SOURCE_RULE',
        'SEMANTIC_REASON',
        'REASON_LABELS',
      ],
    }
  );
}

test('A tick needs two signs: the scan settled it, or the model is sure of a spelling match', () => {
  const { isProposed } = tickKit();
  const at = (state) => isProposed(state.group);
  // (a) the scan settled it.
  assert.strictEqual(at(FIXTURE.plain), true, 'the same name but for case');
  assert.strictEqual(at(FIXTURE.three), true, 'at or above 95%');
  assert.strictEqual(
    at(
      pairOf('rule:1', {
        confidence: 0.9,
        reasons: ['legal-form'],
        aiVerdict: {
          verdict: 'same',
          confidence: 'high',
          source: 'spelling-rule',
        },
      })
    ),
    true,
    'a pair the server settled by a spelling rule'
  );
  // (b) the model is sure about a pair the spelling found.
  assert.strictEqual(at(FIXTURE.same), true, 'a sure "same" on a legal form');
  // Not ticked: one sign only, or a sign against.
  const lowSame = { verdict: 'same', confidence: 'low', basis: 'typo' };
  assert.strictEqual(
    at(pairOf('low:4', { confidence: 0.9, aiVerdict: lowSame })),
    false,
    'a "same" the model is not sure about'
  );
  assert.strictEqual(
    at(pairOf('fuzzy:1', { confidence: 0.88 })),
    false,
    'a spelling match below 95% that no model saw'
  );
  assert.strictEqual(at(FIXTURE.ask), false, 'the model is unsure');
  assert.strictEqual(at(FIXTURE.apart), false, 'the model says different');
  assert.strictEqual(
    at(pairOf('owner:2', { confidence: 1, warnings: ['owner-differs'] })),
    false,
    'a warning that is a question outweighs the score'
  );
  assert.strictEqual(
    at(
      pairOf('inbox:3', {
        confidence: 1,
        warnings: ['inbox-tag', 'large-group'],
      })
    ),
    true,
    'a warning that is a note does not'
  );
});

test('A pair only the model proposed is never ticked: Racun and Physiotherapie', () => {
  const { isProposed, isSemanticGroup, proposalReason, htmlProposalReason } =
    tickKit();
  // The case itself: model "same · high", the pair from the sweep.
  assert.strictEqual(isSemanticGroup(FIXTURE.racun.group), true);
  assert.strictEqual(
    isProposed(FIXTURE.racun.group),
    false,
    'one weak answer of the model is one click from a merge'
  );
  // However the group says it: a member that was matched semantically, a
  // member whose reason is semantic, or the group's reasons alone.
  const byMember = Object.assign({}, FIXTURE.racun.group, { reasons: [] });
  assert.strictEqual(isProposed(byMember), false, 'matchedBy on a member');
  const byReason = Object.assign({}, FIXTURE.racun.group, {
    reasons: ['fuzzy'],
    confidence: 0.97,
    members: [
      { id: 40, name: 'Physiotherapie' },
      { id: 41, name: 'Racun', reason: 'semantic' },
    ],
  });
  assert.strictEqual(
    isProposed(byReason),
    false,
    'not even a high score ticks a group with a semantic pair'
  );
  // It is counted as unsure, and its card says why in the model's words.
  const { resultNumbers } = doneKit();
  const numbers = resultNumbers([
    {
      id: FIXTURE.racun.group.id,
      proposed: isProposed(FIXTURE.racun.group),
      mergeable: true,
    },
  ]);
  assert.deepStrictEqual([numbers.proposed, numbers.unsure], [0, 1]);
  assert.strictEqual(
    proposalReason(FIXTURE.racun.group),
    'Both name invoices of a physiotherapy practice.'
  );
  assert.strictEqual(
    htmlProposalReason(FIXTURE.racun.group),
    '<p class="zr-sm dup-group__why" title="Both name invoices of a physiotherapy practice.">Both name invoices of a physiotherapy practice.</p>'
  );
  assert.strictEqual(
    proposalReason(Object.assign({}, FIXTURE.racun.group, { aiVerdict: null })),
    'paired by the model alone'
  );
});

test('An unticked card says why in one clause, and a ticked one says nothing', () => {
  const { proposalReason, htmlProposalReason } = tickKit();
  assert.strictEqual(proposalReason(FIXTURE.plain.group), '');
  assert.strictEqual(htmlProposalReason(FIXTURE.plain.group), '');
  assert.strictEqual(
    proposalReason(FIXTURE.ask.group),
    'Kontoauszug and Kontoumzug are not obviously the same word.'
  );
  assert.strictEqual(proposalReason(FIXTURE.apart.group), 'different thing');
  assert.strictEqual(
    proposalReason({ warnings: ['has-matching-rule'], confidence: 1 }),
    'matching rule on a source'
  );
  assert.strictEqual(
    proposalReason({
      confidence: 0.8,
      aiVerdict: { verdict: 'same', confidence: 'low' },
    }),
    'low confidence'
  );
  assert.strictEqual(proposalReason({ confidence: 0.88 }), '88% alike');
  // A long sentence is cut on the card and kept whole in its title.
  const long = 'x'.repeat(200);
  const html = htmlProposalReason({
    confidence: 0.8,
    aiVerdict: { verdict: 'unsure', reason: long },
  });
  assert.ok(html.includes(`title="${long}"`));
  assert.ok(html.includes(`>${'x'.repeat(119)}…</p>`));
  // The card draws the line, and a new answer ticks by the rule.
  assert.ok(
    functionBody('htmlGroupCard').includes('${htmlProposalReason(group)}')
  );
  assert.match(
    functionBody('renderGroups'),
    /if \(isProposed\(state\.group\)\) selectedGroups\.add\(id\);/,
    'the cards of a new answer are not ticked by the rule'
  );
  // The verdict dialog reads the same rule.
  assert.ok(
    functionBody('htmlReviewRow').includes(
      "const htmlChecked = isProposed(group) ? ' checked' : '';"
    )
  );
});

test('The chip of a semantic pair names the model’s basis, or says synonym', () => {
  const { reasonChipLabel } = tickKit();
  assert.strictEqual(reasonChipLabel('semantic', null), 'Synonym');
  assert.strictEqual(
    reasonChipLabel('semantic', { verdict: 'same', basis: 'translation' }),
    'Translation'
  );
  assert.strictEqual(
    reasonChipLabel('semantic', { verdict: 'same', basis: 'abbreviation' }),
    'Abbreviation'
  );
  assert.strictEqual(
    reasonChipLabel('semantic', { verdict: 'same', basis: 'typo' }),
    'Synonym',
    'a basis the sweep does not give is not a reason for the pair'
  );
  assert.strictEqual(reasonChipLabel('legal-form', null), 'Legal form');
  assert.ok(
    functionBody('htmlReasonChips').includes(
      'reasonChipLabel(reason, group.aiVerdict)'
    )
  );
  assert.ok(
    functionBody('htmlDecisionHead').includes(
      'reasonChipLabel(reason, group.aiVerdict)'
    ),
    'the stack names the pair the way its card does'
  );
});

/* ── 7. the sheet ─────────────────────────────────────────────────────────── */

/* What GET /api/duplicates/ai-review/estimate answers after a scan: 96 pairs
   in 12 requests at the server's 3 lanes, with the last run of this task. */
const ESTIMATE = {
  items: 96,
  requests: 12,
  lanes: 3,
  seconds: 40,
  tokens: { prompt: 24000, completion: 6000, thinking: 8000 },
  basis: 'model',
  tokenBudget: 200000,
  needsScan: false,
  extra: { sweepRequests: 4, excerptReads: 31 },
  lastRun: {
    requests: 10,
    items: 80,
    promptTokens: 20000,
    completionTokens: 5000,
    thinkingTokens: 7000,
    seconds: 150,
  },
};

/* The same endpoint before a scan: the pairs are not known yet. */
const BEFORE_SCAN = Object.assign({}, ESTIMATE, {
  items: 0,
  requests: 0,
  seconds: 0,
  tokens: { prompt: 0, completion: 0, thinking: 0 },
  basis: 'guess',
  needsScan: true,
});

const DRAFT = { titles: true, excerpts: true, sweep: false, lanes: 3 };

function sheetHelpers() {
  return helpers(['num', 'count', 'plural', 'sheetModel'], {
    constants: ['SWEEP_CLAUSE'],
  });
}

test('The sheet reads an estimate after a scan: pairs, requests, tokens, time', () => {
  const { sheetModel } = sheetHelpers();
  const model = sheetModel(ESTIMATE, DRAFT);
  assert.strictEqual(model.sub, '96 pairs · 12 requests');
  assert.strictEqual(model.requests, 12);
  assert.deepStrictEqual(model.tokens, {
    prompt: 24000,
    completion: 6000,
    thinking: 8000,
  });
  assert.strictEqual(model.limit, 200000, 'the run is held against its limit');
  // 40 s at the server's 3 lanes is 10 s a request; 12 requests at 3 lanes
  // are 4 rounds.
  assert.strictEqual(model.seconds, 40);
  assert.strictEqual(model.lanes, 3);
  assert.strictEqual(model.basis, 'model');
  assert.deepStrictEqual(
    model.switches.map((one) => [one.id, one.label, one.price, one.on]),
    [
      ['dupAiTitles', 'Titles as context', '', true],
      ['dupAiExcerpts', 'Excerpts · 31 reads', '', true],
      [
        'dupAiSweep',
        'Synonym sweep',
        '+4 requests · +13k · never ticked alone',
        false,
      ],
    ],
    'the three levers, what each costs, and what the sweep does not buy'
  );
  // The model is the one the kit draws: every number reaches the markup.
  const sheet = SHEET.htmlSheet(model);
  [
    '96 pairs · 12 requests',
    '38k',
    '200k limit',
    'Synonym sweep',
    '+4 requests · +13k · never ticked alone',
  ].forEach((text) => {
    assert.ok(sheet.includes(text), `the drawn sheet does not say ${text}`);
  });
});

test('A lever moves the numbers: the sweep adds requests, lanes change time only', () => {
  const { sheetModel } = sheetHelpers();
  const swept = sheetModel(ESTIMATE, Object.assign({}, DRAFT, { sweep: true }));
  assert.strictEqual(swept.sub, '96 pairs · 16 requests');
  assert.strictEqual(swept.requests, 16);
  // Four requests more, each at what a request cost on average.
  assert.deepStrictEqual(swept.tokens, {
    prompt: 32000,
    completion: 8000,
    thinking: 10667,
  });
  assert.strictEqual(swept.seconds, 60, '16 requests at 3 lanes are 6 rounds');
  assert.strictEqual(
    swept.switches.find((one) => one.id === 'dupAiSweep').on,
    true
  );

  // The lanes change the time and never the tokens.
  [
    [1, 120],
    [3, 40],
    [5, 30],
    [8, 20],
  ].forEach(([lanes, seconds]) => {
    const model = sheetModel(ESTIMATE, Object.assign({}, DRAFT, { lanes }));
    assert.strictEqual(model.seconds, seconds, `${lanes} lanes`);
    assert.strictEqual(model.lanes, lanes);
    assert.deepStrictEqual(model.tokens, sheetModel(ESTIMATE, DRAFT).tokens);
  });

  // The two evidence levers are a choice without a price the estimate knows.
  const bare = sheetModel(
    ESTIMATE,
    Object.assign({}, DRAFT, { titles: false, excerpts: false })
  );
  assert.deepStrictEqual(
    bare.switches.map((one) => one.on),
    [false, false, false]
  );
  assert.strictEqual(bare.requests, 12, 'the evidence does not add requests');
});

test('Before a scan the sheet shows the last run, as measured, or nothing', () => {
  const { sheetModel } = sheetHelpers();
  const model = sheetModel(BEFORE_SCAN, DRAFT);
  assert.strictEqual(model.sub, '80 pairs · 10 requests');
  assert.strictEqual(model.requests, 10);
  assert.deepStrictEqual(model.tokens, {
    prompt: 20000,
    completion: 5000,
    thinking: 7000,
  });
  // 150 s for 10 requests at the lanes it ran with; 10 requests at 3 lanes
  // are 4 rounds of 15 s.
  assert.strictEqual(model.seconds, 60);
  assert.strictEqual(model.basis, 'run', 'a measured run says so');
  assert.strictEqual(
    model.switches.find((one) => one.id === 'dupAiSweep').price,
    '+4 requests · +13k · never ticked alone'
  );

  // No run behind it either: no numbers are invented.
  const unknown = sheetModel(
    Object.assign({}, BEFORE_SCAN, { lastRun: null }),
    DRAFT
  );
  assert.strictEqual(unknown.sub, '', 'nothing known is nothing said');
  assert.strictEqual(unknown.requests, 0);
  assert.strictEqual(unknown.seconds, 0);
  assert.strictEqual(unknown.basis, 'guess');
  // An estimate without excerpt reads names the lever plainly; the sweep
  // still says what it does not buy.
  const noReads = sheetModel(
    Object.assign({}, ESTIMATE, { extra: { sweepRequests: 0 } }),
    DRAFT
  );
  assert.deepStrictEqual(
    noReads.switches.map((one) => [one.label, one.price]),
    [
      ['Titles as context', ''],
      ['Excerpts', ''],
      ['Synonym sweep', 'never ticked alone'],
    ]
  );
});

test('The sheet opens before every run, and Start keeps what it chose', () => {
  const body = functionBody('confirmRun');
  // Every way here comes after a scan, so the title never promises one.
  assert.ok(
    body.includes("title: 'Ask the model',"),
    'the sheet is not titled "Ask the model"'
  );
  [
    "confirmLabel: 'Start',",
    "cancelLabel: 'Cancel',",
    "className: 'zr-dialog--sheet',",
  ].forEach((part) => {
    assert.ok(body.includes(part), `the sheet is opened without ${part}`);
  });
  assert.ok(
    body.includes('html: htmlSheet(sheetModel(estimate, draft)),'),
    'the sheet is not drawn by the kit from the page model'
  );
  // A lever redraws at once and asks again; only the newest answer draws.
  assert.ok(
    body.includes('if (ticket !== asked || !dialog.open) return;'),
    'an older answer could paint over a newer choice'
  );
  // Cancel forgets the draft; Start keeps it for the run.
  assert.ok(
    body.indexOf('if (!confirmed) return false;') <
      body.indexOf('Object.assign(levers, draft);'),
    'a cancelled sheet must not change the levers'
  );
});

/* ── 8. the stack ─────────────────────────────────────────────────────────── */

/** The decision card with the whole vocabulary it reads. */
function decisionHelpers() {
  return helpers(
    [
      'num',
      'pct',
      'count',
      'plural',
      'normalizeKind',
      'memberOf',
      'selectedSources',
      'countDocuments',
      'shortReason',
      'basisLabel',
      'isRuleVerdict',
      'confidenceLabel',
      'verdictTitle',
      'htmlConfidenceSuffix',
      'htmlRememberedSuffix',
      'htmlVerdictChip',
      'reasonChipLabel',
      'memberMetaText',
      'htmlDecisionSamples',
      'htmlDecisionSide',
      'htmlDecisionHead',
      'htmlDecisionMembers',
      'mergeFactsText',
      'isSureSame',
      'isSemanticGroup',
      'isProposed',
      'proposalReason',
      'htmlDecisionCard',
    ],
    {
      constants: [
        'PLAIN_SCORE',
        'ASK_WARNINGS',
        'REASON_BY_WARNING',
        'ALGORITHM_LABELS',
        'KIND_LABELS',
        'KIND_PLURALS',
        'REASON_LABELS',
        'SEMANTIC_REASON',
        'AI_VERDICT_LABELS',
        'AI_VERDICT_TONES',
        'AI_BASIS_LABELS',
        'AI_CONFIDENCE_LABELS',
        'AI_SOURCE_RULE',
        'AI_RULE_LABEL',
        'AI_RULE_TONE',
        'AI_CANDIDATE_SOURCE',
        'AI_REASON_MAX',
        'DECISION_SAMPLES',
        'htmlIcons',
        'htmlVerdictIcons',
        'htmlMarks',
      ],
    }
  );
}

test('A decision card shows the two sides, the evidence and what merging writes', () => {
  const kit = decisionHelpers();
  const card = kit.htmlDecisionCard(FIXTURE.same);
  assert.ok(
    card.includes('class="zr-decision"'),
    'the card is not the kit card'
  );
  assert.ok(
    card.includes('>Keep<') && card.includes('>Merge away<'),
    'the two sides are not labelled'
  );
  assert.ok(
    card.includes('Müller GmbH') && card.includes('Müller GmbH &amp; Co. KG'),
    'the card does not name both sides, escaped'
  );
  assert.ok(
    card.includes('140 documents · no matching rule'),
    'the side that stays does not say what it holds'
  );
  assert.ok(
    card.includes('9 documents · rule: Any word “mueller”'),
    'the side that goes does not say what it matches'
  );
  assert.ok(
    card.includes('zr-decision__samples') &&
      card.includes('Rechnung 2024-08-14'),
    'the evidence under a name is missing'
  );
  assert.ok(
    card.includes('88% alike'),
    'the head does not say how alike the names are'
  );
  assert.ok(
    card.includes(
      '<p class="zr-decision__note">The same company with and without its legal form.</p>'
    ),
    'the model does not get to say why'
  );
  assert.ok(
    card.includes('1 object · 9 document rewrites · 1 deletion'),
    `the numbers of a merge are missing: ${card}`
  );
  [
    ['dup-stack-merge', 'Merge'],
    ['dup-stack-keep', 'Keep both'],
    ['dup-stack-later', 'Later'],
  ].forEach(([hook, label]) => {
    assert.ok(card.includes(hook), `the card has no ${hook} button`);
    assert.ok(card.includes(label), `the card has no "${label}"`);
  });
  assert.ok(
    card.includes('<span class="zr-decision__keys">Enter · Esc · L</span>'),
    'the card does not name its keys'
  );
  // The semantic pair: its basis on the chip, the model's reason as the note.
  const racun = kit.htmlDecisionCard(FIXTURE.racun);
  assert.ok(racun.includes('<span class="zr-badge">Synonym</span>'));
  assert.ok(racun.includes('Found by the model'));
  // "Accept the clear ones" is not on this page: they are ticked already.
  assert.ok(!/Accept the/.test(SCRIPT));
});

test('A group of three keeps its ticks, and its target stays choosable', () => {
  const kit = decisionHelpers();
  const card = kit.htmlDecisionCard(FIXTURE.three);
  assert.ok(
    card.includes('3 names · keep · merge away'),
    'a group of three does not show its members'
  );
  assert.strictEqual(
    (card.match(/class="zr-check dup-stack-target"/g) || []).length,
    3,
    'every member has to be choosable as the one that stays'
  );
  assert.strictEqual(
    (card.match(/class="zr-check dup-stack-source"/g) || []).length,
    2,
    'every member but the target has to be droppable from the merge'
  );
  assert.match(
    card,
    /class="zr-check dup-stack-target" name="dupStackTarget" value="20" checked/,
    'the suggested target is not the one that comes up chosen'
  );
  assert.ok(
    card.includes('2 objects · 8 document rewrites · 2 deletions'),
    'the numbers do not count both names that go'
  );
  // Two members need no list: the two sides already are the whole group.
  assert.ok(
    !kit.htmlDecisionCard(FIXTURE.plain).includes('dup-decision__members'),
    'a pair does not need a member list'
  );
});

test('A decision sets or clears the tick on the card, comes round again, and is taken back', () => {
  const groups = new Map(['a', 'b', 'c'].map((id) => [id, { group: { id } }]));
  // "c" came up ticked by the proposal; "a" and "b" did not.
  const selectedGroups = new Set(['c']);
  const setTick = (id, on) => {
    if (on) selectedGroups.add(String(id));
    else selectedGroups.delete(String(id));
  };
  const noop = () => {};
  const kit = helpers(
    [
      'num',
      'count',
      'stackState',
      'stackTally',
      'stackTallyText',
      'stackAnswered',
      'stackAdvance',
      'stackDecide',
      'stackLater',
      'stackUndo',
    ],
    {
      constants: ['stack'],
      expose: ['stack'],
      globals: {
        groups,
        selectedGroups,
        setTick,
        renderStack: noop,
        renderStackBar: noop,
      },
    }
  );
  const { stack } = kit;
  stack.ids = ['a', 'b', 'c'];
  stack.total = 3;
  const at = () => (kit.stackState() ? kit.stackState().group.id : null);

  assert.strictEqual(at(), 'a');
  kit.stackDecide(true);
  assert.ok(selectedGroups.has('a'), 'Merge ticks the card');
  assert.strictEqual(at(), 'b');
  kit.stackLater();
  assert.strictEqual(at(), 'c', 'Later moves on');
  kit.stackDecide(false);
  assert.ok(!selectedGroups.has('c'), 'Keep both unticks it');
  // The end of the queue brings back what was put off.
  assert.strictEqual(at(), 'b', 'a pair put off comes round again');
  assert.strictEqual(
    kit.stackTallyText(),
    '1 to merge · 1 kept apart · 1 later'
  );
  kit.stackDecide(true);
  assert.strictEqual(at(), null, 'every pair has its answer');
  assert.deepStrictEqual([...selectedGroups].sort(), ['a', 'b']);

  // Undo takes back the last decision and puts the tick where it was.
  kit.stackUndo();
  assert.strictEqual(at(), 'b');
  assert.ok(!selectedGroups.has('b'), 'the tick goes with it');
  kit.stackUndo();
  assert.strictEqual(at(), 'c');
  assert.ok(selectedGroups.has('c'), 'the proposal’s tick comes back');

  // Nothing of this sends a request: a decision is a tick, and "Merge"
  // writes.
  ['stackDecide', 'stackLater', 'stackUndo', 'stackAdvance'].forEach((name) => {
    const body = functionBody(name);
    ['postJson(', 'requestJson(', 'fetch(', 'mergeGroup('].forEach((call) => {
      assert.ok(!body.includes(call), `${name}() must not call ${call}`);
    });
  });
  // The tick is the card's own check, and the numbers follow it.
  const tick = functionBody('setTick');
  assert.ok(tick.includes('updateSelect(found.card, found.state);'));
  assert.ok(tick.includes('updateSelectionBar();'));
});

test('The stack counts its pairs, and names one by the number it first had', () => {
  const bar = functionBody('renderStackBar');
  assert.ok(
    bar.includes('`Pair ${count(number)} of ${count(total)}`') &&
      bar.includes('`All ${count(total)} answered`'),
    'the bar does not say where the stack is'
  );
  assert.ok(
    bar.includes('stack.ids.indexOf(String(state.group.id)) + 1'),
    'a pair that comes round again must keep its number'
  );
  assert.ok(
    functionBody('openStack').includes(
      'stack.total = new Set(stack.ids).size;'
    ),
    'a pair must be counted once, however often it comes round'
  );
  // It opens over the unsure groups of the result.
  assert.ok(
    functionBody('unsureGroupIds').includes(
      'resultNumbers(cardRows()).unsureIds'
    )
  );
});

test('The keys of the stack fire on the stack, never inside a field', () => {
  const body = functionBody('stackKeydown');
  assert.match(
    body,
    /target\.closest\('input, select, textarea, button, a'\)/,
    'a key pressed in a field must stay in that field'
  );
  [
    ["event.key === 'Enter'", 'stackDecide(true)'],
    ["event.key === 'Escape'", 'stackDecide(false)'],
    ["event.key === 'l'", 'stackLater()'],
  ].forEach(([key, call]) => {
    assert.ok(body.includes(key), `the stack does not listen for ${key}`);
    assert.ok(body.includes(call), `${key} does not do ${call}`);
  });
  assert.ok(
    body.includes("event.key === 'L'"),
    'a capital L has to work like a small one'
  );
  assert.match(
    functionBody('initStack'),
    /el\.stack\.addEventListener\('keydown', stackKeydown\)/,
    'the keys are not bound on the stack container'
  );
  assert.ok(
    !/\son(click|keydown)\s*=/.test(SCRIPT),
    'the page script built an inline handler'
  );
  assert.match(
    page,
    /<section class="dup-stack hidden" id="dupStack" tabindex="-1"/,
    'the stack cannot take the focus its keys need'
  );
  assert.ok(
    page.includes('id="dupStackCloseBtn" type="button">Back</button>'),
    'the stack has no way back'
  );
});

/* ── 9. the run meter ─────────────────────────────────────────────────────── */

const PROGRESS = {
  phase: 'judging',
  requestsDone: 12,
  requestsPlanned: 23,
  pairsJudged: 590,
  pairsTotal: 1150,
  tokens: 742000,
  tokenBudget: 200000,
  estimatedTokens: 1410000,
  elapsedMs: 372000,
  etaMs: 180000,
  requestPairs: 50,
  requestAnswers: 21,
  requestTokens: 89100,
  thinking: true,
  promptTokens: 183000,
  completionTokens: 148000,
  thinkingTokens: 45000,
  thinkingTotal: 411000,
  tally: { same: 400, different: 150, unsure: 40 },
  requestLog: [
    {
      index: 12,
      kind: 'pairs',
      items: 50,
      answers: 50,
      tokens: 61000,
      thinkingTokens: 38000,
      ms: 44000,
      outcome: 'answered',
    },
    {
      index: 11,
      kind: 'pairs',
      items: 50,
      answers: 31,
      tokens: 42000,
      thinkingTokens: 9000,
      ms: 38000,
      outcome: 'partial',
    },
    {
      index: 9,
      kind: 'pairs',
      items: 50,
      answers: 0,
      tokens: 71000,
      thinkingTokens: 25000,
      ms: 112000,
      outcome: 'empty',
    },
    {
      index: 8,
      kind: 'pairs',
      items: 50,
      answers: 0,
      tokens: null,
      thinkingTokens: null,
      ms: 9000,
      outcome: 'failed',
    },
    {
      index: 2,
      kind: 'names',
      items: 300,
      answers: 2,
      tokens: 1400,
      thinkingTokens: 0,
      ms: 60000,
      outcome: 'answered',
    },
    {
      index: 1,
      kind: null,
      items: 22,
      answers: 8,
      tokens: 900,
      thinkingTokens: 0,
      ms: 5000,
      outcome: 'answered',
    },
  ],
};

function meterKit() {
  return helpers(
    [
      'num',
      'count',
      'plural',
      'formatElapsed',
      'requestItemsText',
      'reqlogWhatText',
      'reqlogCostText',
      'liveRequestText',
      'htmlLiveRequestRow',
      'htmlRequestLog',
      'runPositionText',
    ],
    { constants: ['htmlMarks', 'REQUEST_UNITS'] }
  );
}

test('The request log words every row by what the request was about', () => {
  const kit = meterKit();
  const what = (record) =>
    kit.reqlogWhatText(Object.assign({ index: 5 }, record));
  assert.strictEqual(
    what({ kind: 'pairs', items: 22, answers: 8, outcome: 'answered' }),
    'Request 5 · 22 pairs · 8 answered'
  );
  assert.strictEqual(
    what({ kind: 'names', items: 300, answers: 2, outcome: 'answered' }),
    'Request 5 · 300 names read · 2 groups proposed'
  );
  assert.strictEqual(
    what({ kind: null, items: 22, answers: 8, outcome: 'answered' }),
    'Request 5 · 22 items · 8 answered'
  );
  // "The rest asked again" only where an answer was cut and fell short.
  assert.strictEqual(
    what({ kind: 'pairs', items: 50, answers: 31, outcome: 'partial' }),
    'Request 5 · 50 pairs · 31 answered · the rest asked again'
  );
  assert.strictEqual(
    what({ kind: 'pairs', items: 50, answers: 50, outcome: 'partial' }),
    'Request 5 · 50 pairs · 50 answered'
  );
  assert.strictEqual(
    what({ kind: 'names', items: 300, answers: 3, outcome: 'partial' }),
    'Request 5 · 300 names read · 3 groups proposed',
    'the sweep asks nothing again'
  );
  // A count that cannot be groups is the names the sweep read.
  assert.strictEqual(
    what({ kind: 'names', items: 21, answers: 21, outcome: 'answered' }),
    'Request 5 · 21 names read'
  );
  // What failed says where its items went, in their own words.
  assert.strictEqual(
    what({ kind: 'pairs', items: 50, answers: 0, outcome: 'failed' }),
    'Request 5 · failed · 50 pairs marked unsure'
  );
  assert.strictEqual(
    what({ kind: 'names', items: 300, answers: 0, outcome: 'failed' }),
    'Request 5 · failed · 300 names'
  );
  assert.strictEqual(
    what({ kind: 'pairs', items: 1, answers: 1, outcome: 'answered' }),
    'Request 5 · 1 pair · 1 answered'
  );
  // The row in flight says the same, by the phase the run is in.
  assert.strictEqual(
    kit.liveRequestText({
      phase: 'judging',
      requestsDone: 4,
      requestPairs: 22,
      requestAnswers: 8,
    }),
    'Request 5 · 22 pairs · 8 answered'
  );
  assert.strictEqual(
    kit.liveRequestText({
      phase: 'sweeping',
      requestsDone: 0,
      requestPairs: 300,
      requestAnswers: 0,
    }),
    'Request 1 · 300 names'
  );
  assert.strictEqual(
    kit.liveRequestText({ phase: 'judging', requestsDone: 0 }),
    'Request 1'
  );
});

test('The run meter reads a progress snapshot, empty requests and all', () => {
  const kit = meterKit();
  assert.strictEqual(kit.runPositionText(PROGRESS), 'Request 13 of 23');
  assert.strictEqual(kit.runPositionText({}), 'Starting…');

  const log = kit.htmlRequestLog(PROGRESS);
  assert.strictEqual(
    (log.match(/<div class="zr-reqlog__row/g) || []).length,
    7,
    'the log shows the finished requests and the one in flight'
  );
  assert.ok(
    log.indexOf('zr-reqlog__row--live') < log.indexOf('Request 12'),
    'the request in flight belongs at the top of the log'
  );
  [
    'Request 12 · 50 pairs · 50 answered',
    '61k · 38k of it thinking',
    'Request 11 · 50 pairs · 31 answered · the rest asked again',
    'Request 9 · 25k tokens of thinking · no answer',
    'Request 8 · failed · 50 pairs marked unsure',
    'Request 2 · 300 names read · 2 groups proposed',
    'Request 1 · 22 items · 8 answered',
    'Request 13 · 50 pairs · 21 answered',
    '89k so far · thinking',
    '1:52',
    '44 s',
  ].forEach((text) => {
    assert.ok(log.includes(text), `the log does not say "${text}": ${log}`);
  });
  assert.strictEqual(
    (log.match(/zr-reqlog__row--warn/g) || []).length,
    2,
    'an empty and a failed request must both be marked'
  );
  assert.strictEqual(
    kit.htmlRequestLog({}),
    '',
    'an empty log renders nothing'
  );
  assert.strictEqual(
    kit.htmlLiveRequestRow({ requestTokens: 0, thinking: false }),
    '',
    'a run between two requests has nothing in flight to show'
  );
});

test('The run meter counts what is spent, what the model said, and splits the tokens', () => {
  const el = { runLedger: fakeElement(), runCeiling: fakeElement() };
  const { renderRunLedger } = helpers(
    [
      'num',
      'count',
      'plural',
      'formatElapsed',
      'htmlLedgerItem',
      'tallyOf',
      'tallyText',
      'renderRunCeiling',
      'renderRunLedger',
    ],
    { constants: ['CEILING_SHOWN_ABOVE'], globals: { el } }
  );
  renderRunLedger({
    elapsedMs: 159000,
    pairsJudged: 11,
    pairsTotal: 158,
    tally: { same: 7, different: 3, unsure: 1 },
    tokens: 16000,
    estimatedTokens: 95000,
  });
  const ledger = el.runLedger.innerHTML;
  [
    '<span class="zr-ledger__value">2:39</span> elapsed',
    '<span class="zr-ledger__value">11 of 158</span> pairs',
    '<span class="zr-ledger__value">7 same · 3 different · 1 unsure</span> so far',
    '<span class="zr-ledger__value">16k of ~95k</span> tokens',
  ].forEach((item) => {
    assert.ok(ledger.includes(item), `the ledger lacks ${item}: ${ledger}`);
  });
  assert.ok(
    ledger.indexOf('elapsed') < ledger.indexOf('pairs') &&
      ledger.indexOf('pairs') < ledger.indexOf('so far') &&
      ledger.indexOf('so far') < ledger.indexOf('tokens'),
    'how long, how far, what was said, how much'
  );
  renderRunLedger({ elapsedMs: 1000, tally: null });
  assert.ok(!el.runLedger.innerHTML.includes('so far'));

  // The split reads what the model read, wrote and thought.
  const parts = {
    bar: fakeElement(['hidden']),
    prompt: fakeElement(),
    answer: fakeElement(),
    thinking: fakeElement(),
    legend: fakeElement(),
  };
  const { drawTokenbar } = helpers(['num', 'drawTokenbar']);
  drawTokenbar(parts, 13000, 3200, 0);
  const legend = parts.legend.innerHTML.replace(/<[^>]+>/g, '|');
  ['13k read', '3.2k written', '0 thinking'].forEach((key) => {
    assert.ok(
      legend.includes(key),
      `the legend does not say ${key}: ${legend}`
    );
  });
  assert.ok(!parts.bar.classList.contains('hidden'));
  // The split comes from the three counts the job reports separately.
  const meter = functionBody('renderRunMeter');
  ['promptTokens', 'completionTokens', 'thinkingTotal'].forEach((field) => {
    assert.ok(meter.includes(field), `the split ignores ${field}`);
  });
  assert.ok(meter.includes('htmlRequestLog(state)'));
});

test('A run that ends hands the assistant over to its result', () => {
  const outcome = functionBody('renderProgressOutcome');
  assert.ok(
    outcome.includes("el.aiProgress.classList.remove('dup-progress--live');")
  );
  assert.ok(outcome.includes('renderAssist();'));
  // The job of the run is kept, so the result can say what it cost.
  assert.ok(outcome.includes('progressJob = (event && event.job) || null;'));
  assert.ok(
    functionBody('applyReviewResult').includes(
      'lastRunProgress = progressJob ? progressJob.progress || null : null;'
    )
  );
  // A stopped run says so beside the result; a reload finds the run.
  assert.ok(functionBody('followReviewJob').includes("'Stopped early'"));
  assert.ok(functionBody('reattachReview').includes('followReviewJob(job)'));
  assert.ok(
    functionBody('followReviewJob').includes('assist.withModel = true;')
  );
});

/* ── 10. applying ─────────────────────────────────────────────────────────── */

test('Applying is a checklist of groups, and it never asks the model', () => {
  const body = functionBody('runBatch');
  assert.ok(body.includes('openApply(entries)'), 'a batch opens no checklist');
  assert.match(
    body,
    /markApply\(entry\.state\.group\.id, 'running', ''\)/,
    'the group being written is not marked as such'
  );
  assert.ok(
    body.includes("'done'") && body.includes('· ${seconds} s`'),
    'a finished row does not say how long it took'
  );
  assert.ok(
    body.includes("'failed'") && body.includes("'Refused by Paperless-ngx'"),
    'a failed row does not say what happened'
  );
  assert.match(
    body,
    /if \(failed === 0\) closeApply\(\);/,
    'a batch that failed must keep its rows on the page'
  );
  assert.ok(
    !/ai-review|askForVerdicts/.test(body),
    'writing never asks the model'
  );
  assert.ok(
    body.includes('updateSelectionBar();'),
    'the numbers of the assistant do not follow what a batch merged'
  );

  const { htmlApplyRow } = helpers(
    ['num', 'count', 'plural', 'countDocuments', 'htmlApplyRow'],
    { constants: ['htmlMarks'] }
  );
  const entry = {
    state: { group: { id: 'tags:1-2' } },
    target: { name: 'Rechnung' },
    sources: [{ name: 'rechnungen <b>', documentCount: 37 }],
  };
  const waiting = htmlApplyRow(entry, 'waiting', '');
  assert.ok(waiting.includes('rechnungen &lt;b&gt; → Rechnung'));
  assert.ok(waiting.includes('37 documents'));
  assert.ok(waiting.includes('>waiting</span>'));
  assert.ok(
    htmlApplyRow(entry, 'running', '').includes('>writing</span>'),
    'the row being written says so'
  );
  const refused = htmlApplyRow(entry, 'failed', 'Refused by Paperless-ngx');
  assert.ok(refused.includes('zr-reqlog__row--warn'));
  assert.ok(
    refused.includes('dup-apply-retry') && refused.includes('>Retry</button>'),
    'a failed row offers no way to try it again'
  );

  // The bar above the rows counts groups, not sentences.
  const el = {
    applyPosition: fakeElement(),
    applyFill: fakeElement(),
    applyRest: fakeElement(),
  };
  const { drawApplyBar } = helpers(['num', 'count', 'drawApplyBar'], {
    globals: { el },
  });
  drawApplyBar(0, 3);
  assert.strictEqual(el.applyPosition.textContent, 'Group 1 of 3');
  assert.strictEqual(el.applyRest.textContent, '3 waiting');
  drawApplyBar(3, 3);
  assert.strictEqual(el.applyPosition.textContent, 'All 3 written');
  assert.strictEqual(el.applyRest.textContent, '');
  assert.strictEqual(el.applyFill.style.width, '100%');

  // The section is the bar and the rows, and no line of prose.
  const section =
    /<section class="dup-apply hidden" id="dupApply"[\s\S]*?<\/section>/.exec(
      page
    );
  assert.ok(section, 'the checklist has no place on the page');
  assert.ok(!section[0].includes('<p'), 'the checklist explains nothing');
});

/* ── 11. the voice ────────────────────────────────────────────────────────── */

/** The rendered page between its root and its script, tags stripped. */
function visibleText(markup) {
  return pageRoot(markup)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('After a batch the assistant says what it wrote, and a title stands alone', () => {
  const body = functionBody('runBatch');
  assert.match(
    body,
    /el\.aiNotice\.innerHTML = htmlAlert\(failed > 0 \? 'warn' : 'ok', summary, ''\)/,
    'the assistant does not say what the batch merged'
  );
  // The notice lives in the assistant, and a new scan clears it.
  const view = read('views', 'duplicates.ejs');
  const assist = view.slice(
    view.indexOf('id="dupAssist"'),
    view.indexOf('</section>', view.indexOf('id="dupAssist"'))
  );
  assert.ok(assist.includes('id="dupAiNotice"'));
  assert.ok(functionBody('runScan').includes('clearAiNotice();'));
  const { htmlAlert } = helpers(['htmlAlert'], { constants: ['htmlIcons'] });
  const alone = htmlAlert('ok', '5 merged · 15 documents', '');
  assert.ok(alone.includes('>5 merged · 15 documents</div>'));
  assert.ok(!alone.includes('<p'), 'an empty line under a title');
  assert.ok(htmlAlert('warn', '', 'Inbox tag').includes('>Inbox tag</p>'));
});

test('One token is one token, and the pair head wraps on a phone', () => {
  const kit = meterKit();
  assert.strictEqual(kit.reqlogCostText({ tokens: 1 }), '1 token');
  assert.strictEqual(kit.reqlogCostText({ tokens: 900 }), '900 tokens');
  assert.match(
    read('public', 'css', 'review.css'),
    /\.zr-decision__head \{\n\s+display: flex;\n\s+flex-wrap: wrap;/,
    'the badges of a pair push the stack sideways on a phone'
  );
});

test('The toolset carries its controls, named in a word or two', () => {
  const tools = offered.slice(offered.indexOf('id="dupControls"'));
  [
    '>Look at<',
    '>Sensitivity<',
    '>Threshold<',
    '<span>Include hidden pairs</span>',
    'Scan',
    'Ask the model',
    '>Merge by hand<',
    'Every group',
    'Unused',
    'History',
    'Names mapped while processing',
    'Hidden pairs',
    '>Clear verdict memory<',
  ].forEach((label) => {
    assert.ok(tools.includes(label), `the toolset has no "${label}"`);
  });
  assert.match(
    offered,
    /<input type="checkbox" class="zr-toggle" id="dupIncludeDismissed">/,
    'hidden pairs are not a switch'
  );
});

test('No paragraph of the view explains anything: the guide does', () => {
  [page, offered].forEach((markup) => {
    const prose = [...pageRoot(markup).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
      .map((match) =>
        match[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter((text) => text !== '');
    assert.deepStrictEqual(
      prose,
      [],
      `a paragraph of prose is back in the view: ${prose.join(' | ')}`
    );
  });
  // What the page used to say at length is gone from the script as well;
  // its comments may still say how the page works.
  const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /^\s*\/\/.*$/gm,
    ''
  );
  [
    'Nothing here runs on its own',
    'Tip:',
    'Most useful at Strict sensitivity',
    'can be undone',
    'Undo re-creates',
  ].forEach((sentence) => {
    assert.ok(
      !code.includes(sentence) && !page.includes(sentence),
      `"${sentence}" explains what the numbers already say`
    );
  });
});

/* The two dashes the voice rules out, built from their code points so this
   file does not carry them itself. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

test('The page names the model, and speaks to nobody', () => {
  [page, offered].forEach((markup) => {
    const text = visibleText(markup);
    assert.ok(
      !/\bAI\b/.test(text),
      'the page says "AI" where it means the model'
    );
    assert.ok(!/\byou(r)?\b/i.test(text), 'the page speaks to someone');
    assert.ok(!text.includes('!'), 'the page exclaims');
    assert.ok(!DASHES.test(text), 'the page uses a dash');
  });
  // No dash anywhere in what this page owns, comments included.
  [
    ['script', SCRIPT],
    ['stylesheet', CSS],
    ['view', read('views', 'duplicates.ejs')],
  ].forEach(([where, text]) => {
    assert.ok(!DASHES.test(text), `the ${where} carries a dash`);
  });
});

test('The start says what the last run cost, from the run the estimate carries', () => {
  const { startFactsText } = helpers(
    ['startFactsText', 'num', 'count', 'plural', 'parseDay', 'shortDay'],
    { constants: ['MONTHS'] }
  );
  const now = new Date(2026, 8, 23, 12, 0, 0);
  // No run kept: no line at all, so the start does not claim a measurement.
  assert.strictEqual(startFactsText(null, now), '');
  assert.strictEqual(startFactsText({ requests: 0, items: 40 }, now), '');
  assert.strictEqual(
    startFactsText(
      {
        requests: 12,
        items: 275,
        promptTokens: 30000,
        completionTokens: 6000,
        thinkingTokens: 2000,
        seconds: 372,
        finishedAt: '2026-09-20T09:12:00.000Z',
      },
      now
    ),
    'Last run 20 Sep · 275 pairs · 38k tokens · ~6 min'
  );
  // Tokens nobody reported are not a measured zero: the part is left out.
  assert.strictEqual(
    startFactsText(
      {
        requests: 1,
        items: 1,
        promptTokens: null,
        completionTokens: null,
        thinkingTokens: null,
        seconds: 4,
        finishedAt: '2025-12-31T23:00:00.000Z',
      },
      now
    ),
    'Last run 31 Dec 2025 · 1 pair · under a minute'
  );
  const load = functionBody('loadStartFacts');
  assert.ok(load.includes('aiReviewOffered()'));
  assert.ok(load.includes('assist.facts = startFactsText('));
  assert.ok(load.includes('renderAssist();'));
  assert.ok(functionBody('init').includes('loadStartFacts();'));
});

test('Every action is a bordered button, never a text button or a bare link', () => {
  // A button with no border reads as a link, and a link is not a way to
  // cancel, undo or open anything on these pages. The kit's own modules
  // are held to the same rule.
  const modules = [
    read('public', 'js', 'modules', 'review-sheet.js'),
    read('public', 'js', 'modules', 'review-assist.js'),
  ].join('\n');
  for (const [name, text] of [
    ['view', pageRoot(page)],
    ['script', SCRIPT],
    ['modules', modules],
  ]) {
    assert.ok(!text.includes('zr-btn--ghost'), `a text button in the ${name}`);
  }
  // A link opens a document in Paperless-ngx or the log of the other page;
  // it never carries an action of this page.
  const actionLinks = [
    ...SCRIPT.matchAll(/<a class="zr-link[^>]*>\$\{esc\('([^']+)'\)\}<\/a>/g),
  ];
  assert.deepStrictEqual(
    actionLinks.map((m) => m[1]),
    []
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
