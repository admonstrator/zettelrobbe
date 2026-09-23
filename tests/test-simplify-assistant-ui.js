/**
 * Test: simplify-assistant-ui
 *
 * The Simplify tags page in its two modes. Simple is the default: one card
 * with one button, the shared sheet before a run, then the result as a head of
 * numbers, five checklists and one line of history. Advanced is the toolset of
 * today behind the gate, without a paragraph of explanation. The run meter,
 * the apply progress and the stack belong to both.
 *
 * Covers:
 *  1. the kit is linked, layered and has the classes this page places
 *  2. the modes: the root, the markers, the switch in the top bar, the gate's
 *     three lines, and no marked element that the page layer could show
 *  3. the empty card, with and without a model
 *  4. the sheet: its model built from an estimate fixture, its switches and
 *     their prices, the shared markup it renders into, and the levers that
 *     fetch a fresh estimate
 *  5. the result head: the headline, the cost line, and the button whose two
 *     numbers follow the ticks
 *  6. the five checklists sorted from a proposals fixture, their rows, their
 *     caps, the way into the stack and the unchanged line
 *  7. an apply writes the ticks as statuses first, then runs today's job
 *  8. the history line
 *  9. the stack: its bar, its card, its keys, and what it does to the ticks
 * 10. the running screen without a subject and a Stop without a second line
 * 11. the apply checklist
 * 12. the advanced page carries its controls and no hints; round 13's
 *     baskets, plan head and preflight are gone
 * 13. the page stylesheet places the kit rather than redefining it
 * 14. the voice: the page is in the list of the voice test, and no file of
 *     this page carries a dash
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

/* One helper of the page is async, so its case is too. The runner of this
   repository is synchronous, so the promises are collected here and the
   report waits for them. */
const pending = [];

function testAsync(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => {
        passed += 1;
        console.log(`  ok   ${name}`);
      })
      .catch((error) => {
        failed += 1;
        console.log(`  FAIL ${name}`);
        console.log(`       ${error.message}`);
      })
  );
}

const ROOT = process.cwd();
const VIEWS = path.join(ROOT, 'views');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const HEAD = read('views', 'partials', 'shell', 'head-start.ejs');
const KIT = read('public', 'css', 'review.css');
const PAGE_CSS = read('public', 'css', 'pages', 'simplify.css');
const MODULES_CSS = read('public', 'css', 'modules.css');
const SCRIPT = read('public', 'js', 'simplify.js');
const VIEW = read('views', 'simplify.ejs');

/* --- 1. the kit ----------------------------------------------------------- */

test('The shell links the review kit, after the tokens', () => {
  assert.ok(HEAD.includes('href="/css/review.css"'));
  assert.ok(
    HEAD.indexOf('href="/css/tokens.css"') <
      HEAD.indexOf('href="/css/review.css"'),
    'tokens.css declares the layer order and has to come first'
  );
});

test('The kit is one layered block and has every class this page places', () => {
  assert.strictEqual((KIT.match(/@layer [a-z]+ \{/g) || []).length, 1);
  assert.ok(KIT.includes('@layer components {'));
  [
    '.zr-start',
    '.zr-start__icon',
    '.zr-resulthead',
    '.zr-resulthead__headline',
    '.zr-resulthead__cost',
    '.zr-resulthead__action',
    '.zr-tokenbar--mini',
    '.zr-checklist',
    '.zr-checklist__head',
    '.zr-checklist__count',
    '.zr-checklist__row',
    '.zr-checklist__row--dim',
    '.zr-checklist__box',
    '.zr-checklist__text',
    '.zr-checklist__name',
    '.zr-checklist__meta',
    '.zr-checklist__reason',
    '.zr-checklist__chip',
    '.zr-checklist__more',
    '.zr-historyline',
    '.zr-sheet',
    '.zr-runmeter',
    '.zr-runbar__fill',
    '.zr-reqlog__row--warn',
    '.zr-decision',
    '.zr-consequence',
  ].forEach((selector) => {
    assert.ok(
      KIT.includes(`${selector} {`) || KIT.includes(`${selector},`),
      `${selector} has no rule in the kit`
    );
  });
  // The rule lives in the utilities layer next to .hidden, where no module
  // or page display can outrank it.
  assert.match(
    read('public', 'css', 'utilities.css'),
    /\[data-mode='simple'\] \[data-advanced\],\n\s+\[data-mode='advanced'\] \[data-simple\] \{\n\s+display: none !important;/,
    "the utilities layer hides the other mode by the root's data-mode"
  );
});

/* --- the page, rendered through the real shell ---------------------------- */

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

const page = renderSync(
  'simplify.ejs',
  Object.assign({}, LOCALS, { aiReviewEnabled: true })
);
const pageNoModel = renderSync(
  'simplify.ejs',
  Object.assign({}, LOCALS, { aiReviewEnabled: false })
);

/** The markup between an opening tag at `start` and its closing tag. */
function elementAt(html, start) {
  const name = /^<([a-z]+)/.exec(html.slice(start))[1];
  const open = new RegExp(`<${name}\\b`, 'g');
  const close = new RegExp(`</${name}>`, 'g');
  let depth = 0;
  let at = start;
  for (;;) {
    open.lastIndex = at;
    close.lastIndex = at;
    const nextOpen = open.exec(html);
    const nextClose = close.exec(html);
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      at = nextOpen.index + 1;
    } else {
      depth -= 1;
      at = nextClose.index + 1;
      if (depth === 0)
        return html.slice(start, nextClose.index + name.length + 3);
    }
  }
}

/** Every element marked for one mode, as its opening tag and its markup. */
function marked(html, attribute) {
  const found = [];
  const re = new RegExp(`<[a-z]+[^>]*\\s${attribute}(?=[\\s>])[^>]*>`, 'g');
  let match;
  while ((match = re.exec(html)) !== null) {
    found.push({ tag: match[0], html: elementAt(html, match.index) });
  }
  return found;
}

/* --- the helpers, taken out of the module ---------------------------------- */

function functionSource(name) {
  const start = SCRIPT.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name}() is gone from the page script`);
  const head = SCRIPT.slice(Math.max(0, start - 6), start);
  const from = head.endsWith('async ') ? start - 6 : start;
  const open = SCRIPT.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SCRIPT.length; i += 1) {
    if (SCRIPT[i] === '{') depth += 1;
    if (SCRIPT[i] === '}') {
      depth -= 1;
      if (depth === 0) return SCRIPT.slice(from, i + 1);
    }
  }
  throw new Error(`${name}() is not balanced`);
}

function functionBody(name) {
  const source = functionSource(name);
  return source.slice(source.indexOf('{'));
}

/** A top level `const NAME = ...;`, whatever shape its value has. */
function constantSource(name) {
  const start = SCRIPT.indexOf(`const ${name} = `);
  assert.notStrictEqual(start, -1, `${name} is gone from the page script`);
  let depth = 0;
  for (let i = start; i < SCRIPT.length; i += 1) {
    const ch = SCRIPT[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (ch === ';' && depth === 0) return SCRIPT.slice(start, i + 1);
  }
  throw new Error(`${name} is not terminated`);
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

/** The shared sheet module, loaded the way tests/test-review-sheet.js does. */
function loadModule(file, names) {
  const source = read(file)
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|function) /gm, '$1 ');
  return new Function(
    'esc',
    'CSS',
    `${source}\nreturn { ${names.join(', ')} };`
  )(escForTest, { escape: (value) => String(value) });
}

const SHEET = loadModule('public/js/modules/review-sheet.js', [
  'LANE_CHOICES',
  'formatTokens',
  'roughTime',
  'shares',
  'htmlSheet',
]);

/**
 * The named helpers of the page script, evaluated out of their module. Only
 * pure functions can be taken this way, which is why everything the modes,
 * the sheet and the checklists decide is written as a pure function.
 */
function helpers(names, extra = {}) {
  const constants = (extra.constants || []).map(constantSource).join('\n');
  const source = names.map(functionSource).join('\n');
  const globals = Object.assign(
    {
      esc: escForTest,
      formatTokens: SHEET.formatTokens,
      roughTime: SHEET.roughTime,
      shares: SHEET.shares,
      LANE_CHOICES: SHEET.LANE_CHOICES,
    },
    extra.globals || {}
  );
  const keys = Object.keys(globals);
  return new Function(
    ...keys,
    `${constants}\n${source}\nreturn { ${names.join(', ')} };`
  )(...keys.map((key) => globals[key]));
}

/** Everything the result, the checklists and the history line stand on. */
const SIMPLE = [
  'num',
  'plural',
  'grouped',
  'documentsText',
  'planWrites',
  'tokenSplit',
  'splitShares',
  'sectionOf',
  'simpleSections',
  'defaultTick',
  'isTicked',
  'tickedProposals',
  'resultHeadline',
  'applyTickedLabel',
  'mergeBasis',
  'htmlRowWhat',
  'rowMeta',
  'htmlChecklistRow',
  'htmlSectionRows',
  'htmlSection',
  'htmlResultCost',
  'parseStamp',
  'lastApplyAt',
  'shortDate',
  'htmlHistoryLine',
  'statusChanges',
];

const SIMPLE_CONSTANTS = [
  'SOURCE_LABELS',
  'SECTION_KINDS',
  'SECTION_TITLES',
  'LIST_ROWS',
  'MERGE_BASIS_LABELS',
  'COST_UNKNOWN',
  'MONTHS',
  'UNDO_HREF',
];

function simple() {
  return helpers(SIMPLE, { constants: SIMPLE_CONSTANTS });
}

/* --- the fixture: every checklist, both sources, every status --------------- */

function proposal(over) {
  return Object.assign(
    {
      tagId: 0,
      tagName: '',
      documentCount: 1,
      action: 'split',
      mergeInto: null,
      typeName: null,
      topicNames: [],
      source: 'rule',
      confidence: 'high',
      reason: null,
      documentsWithType: 0,
      overwriteType: false,
      status: 'open',
      updatedAt: '2026-09-20 08:00:00',
    },
    over
  );
}

const FIXTURE = [
  proposal({
    tagId: 1,
    tagName: 'Stromrechnung',
    typeName: 'Rechnung',
    topicNames: ['Strom'],
    documentCount: 38,
    documentsWithType: 7,
    reason: 'compound of Rechnung and Strom',
  }),
  proposal({
    tagId: 2,
    tagName: 'Handyrechnung',
    typeName: 'Rechnung',
    topicNames: ['Mobilfunk'],
    documentCount: 31,
    source: 'model',
  }),
  proposal({
    tagId: 3,
    tagName: 'rechnungen',
    action: 'merge',
    mergeInto: 'Rechnung',
    documentCount: 37,
    reason: 'another spelling of "Rechnung" (plural)',
  }),
  proposal({
    tagId: 4,
    tagName: 'KFZ',
    action: 'merge',
    mergeInto: 'Auto',
    documentCount: 8,
    source: 'model',
    reason: 'synonym',
  }),
  proposal({
    tagId: 5,
    tagName: 'Scan2019',
    action: 'delete',
    documentCount: 0,
    reason: 'no documents',
  }),
  proposal({
    tagId: 6,
    tagName: 'Privat',
    action: 'delete',
    documentCount: 22,
    source: 'model',
    confidence: 'low',
    reason: 'catch-all, still in use',
  }),
  proposal({
    tagId: 7,
    tagName: 'Nebenkosten',
    typeName: 'Abrechnung',
    topicNames: ['Wohnung'],
    documentCount: 9,
    source: 'model',
    confidence: 'low',
    reason: 'type or topic',
  }),
  proposal({
    tagId: 8,
    tagName: 'Wichtig',
    action: 'keep',
    documentCount: 91,
    confidence: 'low',
    reason: 'not a compound',
  }),
  proposal({
    tagId: 9,
    tagName: 'Erledigt',
    typeName: 'Rechnung',
    topicNames: ['Alt'],
    status: 'applied',
    updatedAt: '2026-09-14 10:00:00',
  }),
  proposal({
    tagId: 10,
    tagName: 'Gasrechnung',
    typeName: 'Rechnung',
    topicNames: ['Gas'],
    documentCount: 24,
    status: 'skipped',
  }),
  proposal({
    tagId: 11,
    tagName: 'Leer',
    typeName: null,
    topicNames: [],
    documentCount: 2,
    source: 'user',
  }),
];

/* --- 2. the modes ----------------------------------------------------------- */

test('The page is one root that carries the mode, simple until switched', () => {
  assert.match(
    page,
    /<div class="sim-page" id="simPage" data-review-page="simplify" data-mode="simple">/,
    'the root wraps both modes and starts in simple mode'
  );
  assert.strictEqual(
    (page.match(/data-review-page=/g) || []).length,
    1,
    'one root per page'
  );
  const simpleParts = marked(page, 'data-simple');
  const advancedParts = marked(page, 'data-advanced');
  assert.ok(simpleParts.length >= 2 && advancedParts.length >= 2);
  const inSimple = simpleParts.map((part) => part.html).join('\n');
  const inAdvanced = advancedParts.map((part) => part.html).join('\n');
  // What belongs where.
  [
    'simEmptyCard',
    'simStartBtn',
    'simResult',
    'simLists',
    'simHistoryLine',
  ].forEach((id) => {
    assert.ok(inSimple.includes(`id="${id}"`), `#${id} belongs to simple`);
    assert.ok(!inAdvanced.includes(`id="${id}"`));
  });
  [
    'simOrder',
    'simOrderBtn',
    'simView',
    'simGroupsBlock',
    'simProposals',
    'simVocabularyBlock',
  ].forEach((id) => {
    assert.ok(inAdvanced.includes(`id="${id}"`), `#${id} belongs to advanced`);
    assert.ok(!inSimple.includes(`id="${id}"`));
  });
  // What belongs to both carries neither marker.
  ['simProgress', 'simApplyChecklist', 'simApplyResult', 'simStack'].forEach(
    (id) => {
      assert.ok(page.includes(`id="${id}"`), `#${id} is missing`);
      assert.ok(
        !inSimple.includes(`id="${id}"`) && !inAdvanced.includes(`id="${id}"`),
        `#${id} belongs to both modes and carries no marker`
      );
    }
  );
});

test('No marked element wears a class the pages or modules layer displays', () => {
  // The kit hides the other mode from layer components. A display on the
  // marked element from a later layer would win over it and show both modes.
  const displayed = (css, name) =>
    new RegExp(`(^|\\n)\\s*\\.${name}\\s*\\{[^}]*\\bdisplay\\s*:`).test(css);
  [...marked(page, 'data-simple'), ...marked(page, 'data-advanced')].forEach(
    (part) => {
      const classes = (/class="([^"]*)"/.exec(part.tag) || ['', ''])[1]
        .split(/\s+/)
        .filter(Boolean);
      classes.forEach((name) => {
        assert.ok(
          !displayed(PAGE_CSS, name) && !displayed(MODULES_CSS, name),
          `${part.tag} wears .${name}, which a later layer gives a display`
        );
      });
    }
  );
});

test('The mode switch sits in the top bar and the gate reads three lines', () => {
  const init = functionBody('initMode');
  assert.ok(init.includes('mountModeSwitch({'));
  assert.ok(init.includes("page: 'simplify'"));
  assert.ok(init.includes('root: el.page'));
  assert.ok(init.includes('slot: el.topbarActions'));
  assert.ok(init.includes('gate: GATE_LINES'));
  assert.match(
    SCRIPT,
    /topbarActions: document\.getElementById\('zrTopbarActions'\)/
  );
  assert.ok(
    functionBody('init').indexOf('initMode()') <
      functionBody('init').indexOf('await loadVocabulary()'),
    'the mode is stamped before anything is loaded'
  );
  const { GATE_LINES } = new Function(
    `${constantSource('GATE_LINES')}\nreturn { GATE_LINES };`
  )();
  assert.deepStrictEqual(GATE_LINES, [
    { icon: 'i-tag', text: 'Vocabulary: document types and topics' },
    { icon: 'i-list', text: 'Every tag in a table, filters and search' },
    { icon: 'i-layers', text: 'Groups by type, topic and target' },
  ]);
  const icons = read('public', 'icons.svg');
  GATE_LINES.forEach((line) => {
    assert.ok(icons.includes(`id="${line.icon}"`), `${line.icon} is missing`);
  });
  // Leaving simple mode closes the stack it was opened from.
  assert.ok(init.includes('closeStack()'));
});

/* --- 3. the empty card ------------------------------------------------------ */

test('Before a run the simple page is the line and one card with one button', () => {
  const inSimple = marked(page, 'data-simple')
    .map((part) => part.html)
    .join('\n');
  assert.ok(
    inSimple.includes('Split compound tags into a document type and topics.')
  );
  const card = elementAt(page, page.indexOf('<section class="zr-start'));
  assert.match(card, /class="zr-start sim-start hidden" id="simEmptyCard"/);
  assert.ok(
    card.includes('<span class="zr-start__icon">') && card.includes('#i-split'),
    'the start wears the split icon'
  );
  // The sentence of the page is the title of the start; the line above it
  // is drawn only with a result.
  assert.ok(
    card.includes(
      '<h2 class="zr-start__title">Split compound tags into a document type and topics.</h2>'
    )
  );
  assert.ok(
    card.includes(
      'Every tag gets a proposal: split, merge, delete or keep. Nothing is written before Apply.'
    )
  );
  assert.match(
    card,
    /<button class="zr-btn zr-btn--primary zr-btn--lg" id="simStartBtn" type="button">Simplify tags<\/button>/
  );
  assert.ok(!card.includes('No model configured'));
  assert.ok(
    functionBody('renderSimple').includes(
      "el.sub.classList.toggle('hidden', !showResult)"
    )
  );
  // The result and the history wait for proposals; the script decides.
  assert.match(page, /class="zr-col zr-col--loose hidden" id="simResult"/);
  assert.match(page, /class="zr-historyline hidden" id="simHistoryLine"/);
  assert.ok(
    functionBody('initSimple').includes(
      "el.startBtn.addEventListener('click', proposeOrder)"
    ),
    "the card's button is the order run, and the order run opens the sheet"
  );
  assert.ok(functionBody('proposeOrder').includes('await askPreflight(false)'));
});

test('Without a model the card says so in one fact and its button is dead', () => {
  const card = elementAt(
    pageNoModel,
    pageNoModel.indexOf('<section class="zr-start')
  );
  assert.ok(card.includes('>No model configured<'));
  assert.match(card, /id="simStartBtn" type="button" disabled>Simplify tags</);
  const busy = functionBody('setOrderBusy');
  assert.ok(
    busy.includes('el.startBtn.disabled = busy || !modelReady()'),
    'the end of a job must not wake a button that has no model behind it'
  );
});

test('The script shows the card, the result or neither', () => {
  const render = functionBody('renderSimple');
  assert.ok(
    render.includes('const showResult = live > 0 && !ordering && !stacking')
  );
  assert.ok(
    render.includes(
      "el.emptyCard.classList.toggle('hidden', showResult || ordering || stacking)"
    ),
    'the card goes while a run runs and while the stack is open'
  );
  assert.ok(render.includes('updateApplyTicked(sections)'));
});

/* --- 4. the sheet ----------------------------------------------------------- */

const ESTIMATE = {
  tags: 1187,
  itemsByRule: 42,
  items: 1145,
  batchSize: 50,
  lanes: 3,
  requests: 23,
  seconds: 180,
  tokens: {
    total: 110000,
    prompt: 78000,
    completion: 20000,
    thinking: 12000,
  },
  basis: 'run',
  measuredAt: '2026-01-01T00:00:00Z',
  model: 'qwen3:30b',
  thinking: true,
  skippable: { decided: 118, lowDocument: 330 },
  lastRun: { requests: 23, seconds: 540 },
  tokenBudget: 200000,
};

function sheetHelpers() {
  return helpers(
    [
      'num',
      'plural',
      'grouped',
      'normaliseEstimate',
      'sheetSub',
      'laneSeconds',
      'leverPrice',
      'sheetSwitches',
      'sheetModel',
    ],
    {
      constants: ['ESTIMATE_BASES', 'ORDER_BATCH_SIZE', 'MIN_DOCUMENTS_LEVER'],
    }
  );
}

test('The sheet is built from the estimate the page already fetches', () => {
  const { normaliseEstimate, sheetModel } = sheetHelpers();
  const levers = { skipDecided: false, minDocuments: 1, lanes: 3 };
  const model = sheetModel(normaliseEstimate(ESTIMATE), levers, false);
  assert.strictEqual(
    model.sub,
    '1,145 of 1,187 tags · 23 requests · 42 by rule',
    'the facts line of the board, word for word'
  );
  assert.strictEqual(model.requests, 23);
  assert.deepStrictEqual(model.tokens, {
    prompt: 78000,
    completion: 20000,
    thinking: 12000,
  });
  assert.strictEqual(model.limit, 200000, 'the limit is the run budget');
  assert.strictEqual(model.seconds, 180);
  assert.strictEqual(model.lanes, 3);
  assert.deepStrictEqual(model.laneChoices, [1, 3, 5, 8]);
  assert.strictEqual(model.basis, 'run');
  assert.ok(!('fact' in model), 'the module writes the one fact itself');

  // The lanes change the time, not the work.
  const one = sheetModel(
    normaliseEstimate(ESTIMATE),
    { ...levers, lanes: 1 },
    false
  );
  assert.strictEqual(one.seconds, 540);
  assert.strictEqual(one.requests, 23);
  assert.deepStrictEqual(one.tokens, model.tokens);

  // Without a rule the facts end at the requests.
  assert.strictEqual(
    sheetModel(
      normaliseEstimate({ ...ESTIMATE, itemsByRule: 0, items: 1187 }),
      levers,
      false
    ).sub,
    '1,187 of 1,187 tags · 23 requests'
  );
  // The lanes of the page start at three, as the levers always did.
  assert.match(
    SCRIPT,
    /const runLevers = \{\n\s+skipDecided: false,\n\s+minDocuments: 1,\n\s+lanes: 3,\n\s+keepVocabulary: false,\n\s*\};/
  );
});

test('The switches come in their order, each only when it changes something', () => {
  const { normaliseEstimate, sheetSwitches, leverPrice } = sheetHelpers();
  const estimate = normaliseEstimate(ESTIMATE);
  const levers = {
    skipDecided: false,
    minDocuments: 1,
    lanes: 3,
    keepVocabulary: true,
  };
  const switches = sheetSwitches(estimate, levers, true);
  assert.deepStrictEqual(
    switches.map((lever) => [lever.id, lever.label, lever.on]),
    [
      ['skipDecided', 'Skip 118 already decided', false],
      ['minDocuments', 'Only tags on 3+ documents', false],
      ['keepVocabulary', 'Keep vocabulary', true],
    ]
  );
  // The price is what the estimate already knows: the requests the left out
  // tags would take, and their tokens at the estimate's own average.
  assert.strictEqual(switches[0].price, '−2 requests · −9.6k');
  assert.strictEqual(switches[1].price, '−6 requests · −29k');
  assert.strictEqual(switches[2].price, '', 'the vocabulary switch has none');
  // With the lever on, the estimate is already the smaller one; the price
  // stays the same distance.
  const on = normaliseEstimate({
    ...ESTIMATE,
    items: 1027,
    requests: 21,
    tokens: {
      total: 100435,
      prompt: 71217,
      completion: 18261,
      thinking: 10957,
    },
  });
  assert.strictEqual(leverPrice(on, 118, true), '−2 requests · −9.6k');
  // A lever that saves no request is offered without a price.
  assert.strictEqual(leverPrice(estimate, 5, false), '');
  // A lever that would leave out nothing is not offered at all, and the
  // vocabulary switch only where it belongs.
  const bare = sheetSwitches(
    normaliseEstimate({
      ...ESTIMATE,
      skippable: { decided: 0, lowDocument: 0 },
    }),
    levers,
    false
  );
  assert.deepStrictEqual(bare, []);
  // No price anywhere carries a dash; the minus is the minus sign.
  switches.forEach((lever) => {
    assert.ok(!/[\u2013\u2014]/.test(lever.price + lever.label));
  });
});

test('The sheet renders into the shared markup, levers and all', () => {
  const { normaliseEstimate, sheetModel } = sheetHelpers();
  const html = SHEET.htmlSheet(
    sheetModel(
      normaliseEstimate(ESTIMATE),
      { skipDecided: true, minDocuments: 1, lanes: 3, keepVocabulary: false },
      true
    )
  );
  assert.ok(html.includes('1,145 of 1,187 tags · 23 requests · 42 by rule'));
  assert.ok(html.includes('>110k<'), 'the big number is the tokens');
  assert.ok(html.includes('>~3 min<'), 'the time beside it');
  assert.ok(html.includes('200k limit'), 'the bar is the run budget');
  assert.ok(html.includes('data-switch="skipDecided" checked'));
  assert.ok(html.includes('data-switch="minDocuments">'));
  assert.ok(html.includes('data-switch="keepVocabulary">'));
  assert.ok(html.includes('Measured · last run'));
  assert.ok(html.includes('Nothing is written.'));
});

test('The sheet is the kernel dialog, and every lever fetches a fresh estimate', () => {
  const ask = functionBody('askPreflight');
  assert.ok(ask.includes('confirmDialog({'));
  assert.ok(ask.includes("title: 'Simplify tags'"));
  assert.ok(ask.includes('html: htmlSheet(model())'));
  assert.ok(ask.includes("confirmLabel: 'Start'"));
  assert.ok(ask.includes("cancelLabel: 'Cancel'"));
  assert.ok(ask.includes("className: 'zr-dialog--sheet'"));
  assert.ok(ask.includes("document.querySelector('dialog.zr-dialog[open]')"));
  assert.ok(ask.includes('bindSheet(dialog, {'));
  assert.ok(ask.includes('onLanes:') && ask.includes('onSwitch:'));
  assert.ok(
    ask.includes('await fetchOrderEstimate(keepFor())') &&
      ask.includes('updateSheet(dialog, model())'),
    'a lever moves runLevers, fetches, and moves the sheet in place'
  );
  assert.ok(
    ask.includes('ticket !== asked'),
    'an estimate that a later move overtook is dropped'
  );
  assert.ok(ask.includes('unbind()'), 'the listener goes with the dialog');
  assert.ok(
    ask.includes("mode === 'simple' && vocabularySaved && forceKeep !== true"),
    'the vocabulary switch lives on the sheet in simple mode only'
  );
  assert.ok(
    ask.includes('if (el.keepVocabulary) el.keepVocabulary.checked = on'),
    'the switch of the sheet and the switch of the order row are one lever'
  );

  const fetchBody = functionBody('fetchOrderEstimate');
  assert.ok(
    fetchBody.includes('concurrency: String(runLevers.lanes)'),
    'the lanes reach the estimate, so the time follows them'
  );
  assert.ok(
    fetchBody.includes('if (runLevers.minDocuments > 1) {'),
    'without the lever no floor is sent, so the lever keeps its count'
  );
  assert.ok(fetchBody.includes('localOrderEstimate()'));
  assert.strictEqual(
    SCRIPT.split('ESTIMATE_URL').length - 1,
    2,
    'one declaration and one use'
  );
  // Nothing of round 13's dialog is left.
  [
    'htmlPreflight',
    'preflightLede',
    'basisText',
    'preflightConfirmText',
  ].forEach((name) => {
    assert.ok(!SCRIPT.includes(`function ${name}(`), `${name}() is retired`);
  });
});

testAsync('The levers move the numbers of the local estimate', async () => {
  const levers = { skipDecided: false, minDocuments: 1, lanes: 3 };
  const stored = [];
  const push = (count, row) => {
    for (let at = 0; at < count; at += 1) {
      stored.push(Object.assign({ tagId: stored.length + 1 }, row));
    }
  };
  push(20, { source: 'rule', status: 'open', documentCount: 40 });
  push(100, { source: 'model', status: 'open', documentCount: 40 });
  push(60, { source: 'model', status: 'accepted', documentCount: 40 });
  push(30, { source: 'model', status: 'open', documentCount: 1 });
  const { localOrderEstimate } = helpers(['num', 'localOrderEstimate'], {
    constants: [
      'DECIDED_STATUSES',
      'ORDER_BATCH_SIZE',
      'MIN_DOCUMENTS_LEVER',
      'GUESS_PROMPT_BASE',
      'GUESS_PROMPT_PER_ITEM',
      'GUESS_TOKENS_PER_ITEM',
      'GUESS_THINKING_PER_REQUEST',
      'GUESS_TOKENS_PER_SECOND',
    ],
    globals: {
      runLevers: levers,
      ensureTagIndex: async () => new Map(),
      proposals: new Map(stored.map((row) => [row.tagId, row])),
    },
  });
  const plain = await localOrderEstimate();
  assert.strictEqual(plain.items, 190);
  assert.strictEqual(plain.requests, 4);
  assert.strictEqual(plain.basis, 'guess');
  levers.skipDecided = true;
  assert.strictEqual((await localOrderEstimate()).requests, 3);
  levers.minDocuments = 3;
  const fewest = await localOrderEstimate();
  assert.strictEqual(fewest.items, 100);
  levers.skipDecided = false;
  levers.minDocuments = 1;
  levers.lanes = 8;
  const faster = await localOrderEstimate();
  assert.strictEqual(faster.tokens.total, plain.tokens.total, 'lanes are free');
  assert.ok(faster.seconds < plain.seconds, 'but they buy time');
});

/* --- 5. the result head ----------------------------------------------------- */

test('The headline counts the tags and the changes, and a tick moves neither', () => {
  const { simpleSections, resultHeadline } = simple();
  const sections = simpleSections(FIXTURE);
  // Ten live tags: two splits, two merges, one delete, two unsure, three
  // unchanged (the kept one, the empty split, and none applied).
  assert.strictEqual(resultHeadline(sections), '10 tags · 6 changes proposed');
  assert.strictEqual(
    resultHeadline(simpleSections([FIXTURE[0]])),
    '1 tag · 1 change proposed'
  );
});

test('The apply button says what the ticks add up to', () => {
  const { simpleSections, tickedProposals, applyTickedLabel } = simple();
  const sections = simpleSections(FIXTURE);
  const overrides = new Map();
  const start = tickedProposals(sections, overrides);
  assert.deepStrictEqual(
    start.map((row) => row.tagId).sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
    'what the model was sure of starts ticked; unsure and skipped do not'
  );
  assert.strictEqual(applyTickedLabel(start), 'Apply 5 · 181 writes');
  overrides.set(1, false);
  overrides.set(6, true);
  const moved = tickedProposals(sections, overrides);
  assert.strictEqual(
    applyTickedLabel(moved),
    'Apply 5 · 134 writes',
    'unticking a split and ticking an unsure delete moves only the numbers'
  );
  overrides.set(10, true);
  assert.strictEqual(
    tickedProposals(sections, overrides).length,
    6,
    'a skipped row can be ticked back in'
  );
  assert.strictEqual(applyTickedLabel([]), 'Apply 0 · 0 writes');
  assert.strictEqual(
    applyTickedLabel([proposal({ action: 'delete', documentCount: 0 })]),
    'Apply 1 · 1 write'
  );
  // A tick is local: the listener moves the button and nothing else.
  const init = functionBody('initSimple');
  assert.ok(
    init.includes(
      'tickOverrides.set(num(box.dataset.tagId), box.checked === true)'
    )
  );
  const onTick = init.slice(
    init.indexOf("addEventListener('change'"),
    init.indexOf(
      "addEventListener('click'",
      init.indexOf("addEventListener('change'")
    )
  );
  assert.ok(onTick.includes('updateApplyTicked()'));
  assert.ok(
    !/sendJson|patchProposal|renderSimple/.test(onTick),
    'a tick writes nothing and redraws nothing'
  );
});

test('The cost line is the last run, or says that it is not recorded', () => {
  const { htmlResultCost } = simple();
  const cost = htmlResultCost({
    requests: 23,
    tokens: 110000,
    ms: 180000,
    prompt: 78000,
    completion: 32000,
    thinking: 12000,
  });
  assert.ok(cost.includes('class="zr-tokenbar zr-tokenbar--mini"'));
  assert.ok(cost.includes('>23 requests · 110k tokens · ~3 min<'));
  assert.ok(
    cost.includes('aria-label="78k question · 20k answer · 12k thinking"'),
    'the answer is what is left of the completion after the thinking'
  );
  assert.ok(/width: 70\.9%/.test(cost), 'the widths are shares of the run');
  assert.strictEqual(htmlResultCost(null), '<span>Cost not recorded</span>');
  // The page keeps the cost of the run it watched, as the plan head did.
  assert.ok(
    functionBody('renderSimple').includes(
      'el.resultCost.innerHTML = htmlResultCost(lastRunCost)'
    )
  );
  assert.ok(
    functionBody('renderProgressOutcome').includes('keepRunCost(finished)')
  );
  assert.match(
    page,
    /<div class="zr-resulthead__action">[\s\S]*?<button class="zr-btn zr-btn--primary" id="simApplyTickedBtn" type="button" disabled>Apply 0 · 0 writes<\/button>/
  );
  // The result stays while a proposal lives, so the next run has a button
  // of its own, before the one that writes.
  assert.match(
    page,
    /<button class="zr-btn" id="simAgainBtn" type="button">Simplify tags<\/button>[\s\S]*?id="simApplyTickedBtn"/
  );
  assert.match(
    page,
    /<p class="zr-resulthead__headline" id="simResultHeadline"><\/p>/
  );
  assert.match(page, /<p class="zr-resulthead__cost" id="simResultCost"><\/p>/);
});

/* --- 6. the five checklists ------------------------------------------------- */

test('Every proposal lands in exactly one checklist, the biggest first', () => {
  const { simpleSections, sectionOf } = simple();
  const sections = simpleSections(FIXTURE);
  const ids = (kind) => sections[kind].map((row) => row.tagId);
  assert.deepStrictEqual(ids('split'), [1, 2, 10], 'by documents, then name');
  assert.deepStrictEqual(ids('merge'), [3, 4]);
  assert.deepStrictEqual(ids('delete'), [5]);
  assert.deepStrictEqual(ids('unsure'), [6, 7], 'low confidence, any action');
  assert.deepStrictEqual(ids('unchanged'), [8, 11]);
  assert.strictEqual(sectionOf(FIXTURE[8]), null, 'an applied tag is history');
  assert.strictEqual(
    sectionOf(FIXTURE[10]),
    'unchanged',
    'a split with nothing to split into stays as it is'
  );
  assert.strictEqual(
    sectionOf(
      proposal({
        action: 'split',
        typeName: 'Brief',
        confidence: 'low',
        source: 'rule',
      })
    ),
    'unsure',
    'a rule that was not sure is not sure either'
  );
});

test('A row says what the tag becomes, with the target in bold', () => {
  const { htmlChecklistRow } = simple();
  const split = htmlChecklistRow(FIXTURE[0], 'split', true);
  assert.ok(split.startsWith('<label class="zr-checklist__row"'));
  assert.ok(
    split.includes(
      '<input class="zr-check zr-checklist__box sim-tick" type="checkbox" data-tag-id="1" checked>'
    ),
    'the box is the framework tick, and it carries the tag'
  );
  assert.ok(
    split.includes(
      'Stromrechnung<span class="sim-list__arrow"> → </span><span class="zr-checklist__name">Rechnung</span> + Strom<span class="zr-checklist__meta">38 documents</span>'
    ),
    'from, the type in bold, the topics, the documents'
  );
  assert.ok(split.includes('<span class="zr-checklist__chip">rule</span>'));
  assert.ok(
    htmlChecklistRow(FIXTURE[1], 'split', true).includes(
      'class="zr-checklist__chip">model<'
    )
  );

  const merge = htmlChecklistRow(FIXTURE[2], 'merge', true);
  assert.ok(
    merge.includes(
      'rechnungen<span class="sim-list__arrow"> → </span><span class="zr-checklist__name">Rechnung</span><span class="zr-checklist__meta">37 documents</span>'
    )
  );
  assert.ok(
    merge.includes('class="zr-checklist__chip">plural<'),
    'a rule merge wears the spelling rule it named'
  );
  assert.ok(
    htmlChecklistRow(FIXTURE[3], 'merge', true).includes(
      'class="zr-checklist__chip">model<'
    ),
    'a model merge wears its source'
  );

  const remove = htmlChecklistRow(FIXTURE[4], 'delete', true);
  assert.ok(
    remove.includes(
      'Scan2019<span class="zr-checklist__meta">0 documents</span>'
    )
  );
  assert.ok(!remove.includes('zr-checklist__chip'), 'a deletion needs no chip');

  const unsure = htmlChecklistRow(FIXTURE[5], 'unsure', false);
  assert.ok(
    unsure.includes('class="zr-checklist__row zr-checklist__row--dim"')
  );
  assert.ok(!unsure.includes(' checked>'), 'unsure starts unticked');
  assert.ok(unsure.includes('>22 documents · delete<'));
  assert.ok(
    unsure.includes(
      '<span class="zr-checklist__reason">catch-all, still in use</span>'
    ),
    'the reason is one clause on the row'
  );
  assert.ok(!unsure.includes('zr-checklist__chip'));

  const kept = htmlChecklistRow(FIXTURE[7], 'unchanged', false);
  assert.ok(kept.startsWith('<div class="zr-checklist__row'));
  assert.ok(!kept.includes('type="checkbox"'), 'what stays has no box');

  const nasty = htmlChecklistRow(
    proposal({ tagId: 1, tagName: '<b>x</b>', typeName: '<i>y</i>' }),
    'split',
    true
  );
  assert.ok(!nasty.includes('<b>') && !nasty.includes('<i>'));
});

test('A tag edited in the stack keeps its edit in the row', () => {
  const { htmlChecklistRow, sectionOf } = simple();
  const edited = proposal({
    ...FIXTURE[6],
    typeName: 'Rechnung',
    topicNames: ['Wohnung', 'Strom'],
    source: 'user',
    status: 'accepted',
  });
  assert.strictEqual(sectionOf(edited), 'unsure', 'it stays where it was');
  const row = htmlChecklistRow(edited, 'unsure', true);
  assert.ok(
    row.includes(
      'Nebenkosten<span class="sim-list__arrow"> → </span><span class="zr-checklist__name">Rechnung</span> + Wohnung + Strom'
    )
  );
  assert.ok(row.includes(' checked>'), 'accepted in the stack is ticked');
  const topicsOnly = htmlChecklistRow(
    proposal({
      ...FIXTURE[0],
      typeName: null,
      topicNames: ['Strom', 'Haus'],
      source: 'user',
    }),
    'split',
    true
  );
  assert.ok(
    topicsOnly.includes(
      'Stromrechnung<span class="sim-list__arrow"> → </span><span class="zr-checklist__name">Strom + Haus</span>'
    )
  );
  assert.ok(topicsOnly.includes('class="zr-checklist__chip">edited<'));
});

test('A checklist shows eight rows, then the rest by number', () => {
  const { htmlSection } = simple();
  const many = Array.from({ length: 812 }, (unused, at) =>
    proposal({ tagId: at + 1, tagName: `Tag ${at}`, typeName: 'Rechnung' })
  );
  const capped = htmlSection('split', many, { overrides: new Map() });
  assert.ok(
    capped.startsWith('<section class="zr-checklist sim-list sim-list--split"')
  );
  assert.ok(
    capped.includes(
      '<div class="zr-checklist__head"><span class="zr-label">Split <span class="zr-checklist__count">· 812</span></span></div>'
    ),
    'the head is the label and its count'
  );
  assert.strictEqual((capped.match(/zr-checklist__box/g) || []).length, 8);
  assert.ok(
    capped.includes(
      '<div class="zr-checklist__more"><button class="zr-btn sim-list-more" type="button" data-section="split">804 more</button></div>'
    )
  );
  const full = htmlSection('split', many, { full: true, overrides: new Map() });
  assert.strictEqual((full.match(/zr-checklist__box/g) || []).length, 812);
  assert.ok(!full.includes('sim-list-more'));
  assert.strictEqual(
    htmlSection('delete', [], {}),
    '',
    'an empty list is not drawn'
  );
  const wiring = functionBody('initSimple');
  assert.ok(wiring.includes('listsFull.add(String(more.dataset.section))'));
});

test('Unsure carries the way into the stack, Unchanged is one line', () => {
  const { htmlSection, simpleSections } = simple();
  const sections = simpleSections(FIXTURE);
  const unsure = htmlSection('unsure', sections.unsure, {
    overrides: new Map(),
  });
  assert.ok(
    unsure.includes(
      '<span class="zr-label">Unsure <span class="zr-checklist__count">· 2</span></span><button class="zr-btn sim-stack-open" type="button">Review one by one</button>'
    )
  );
  const keep = Array.from({ length: 124 }, (unused, at) =>
    proposal({ tagId: at + 1, tagName: `Bleibt ${at}`, action: 'keep' })
  );
  const closed = htmlSection('unchanged', keep, { shown: false });
  assert.ok(closed.includes('>124 tags stay as they are<'));
  assert.ok(
    closed.includes(
      'class="zr-btn sim-unchanged-toggle" type="button" aria-expanded="false">Show<'
    )
  );
  assert.ok(!closed.includes('type="checkbox"'));
  assert.ok(!closed.includes('Bleibt 0'), 'the tags wait for Show');
  const shown = htmlSection('unchanged', keep, { shown: true });
  assert.ok(shown.includes('>Hide<') && shown.includes('Bleibt 0'));
  assert.ok(shown.includes('>116 more<'));
  assert.ok(!shown.includes('type="checkbox"'));
  assert.ok(
    htmlSection('unchanged', [keep[0]], {}).includes('>1 tag stays as it is<')
  );
  const wiring = functionBody('initSimple');
  assert.ok(wiring.includes("event.target.closest('.sim-stack-open')"));
  assert.ok(wiring.includes('unchangedShown = !unchangedShown'));
});

test('The five lists render in their order into the grid of the board', () => {
  const render = functionBody('renderSimple');
  assert.ok(render.includes('SECTION_KINDS.map((kind) =>'));
  const { SECTION_KINDS } = new Function(
    `${constantSource('SECTION_KINDS')}\nreturn { SECTION_KINDS };`
  )();
  assert.deepStrictEqual(SECTION_KINDS, [
    'split',
    'merge',
    'delete',
    'unsure',
    'unchanged',
  ]);
  assert.match(
    PAGE_CSS,
    /\.sim-lists \{\n\s+display: grid;\n\s+grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/
  );
  assert.match(PAGE_CSS, /\.sim-list--unchanged \{\n\s+grid-column: 1 \/ -1;/);
});

/* --- 7. the apply ----------------------------------------------------------- */

test('Apply makes accepted mean exactly the ticks, then runs the apply job', () => {
  const { statusChanges, simpleSections, tickedProposals } = simple();
  const list = FIXTURE.map((row) =>
    row.tagId === 2 ? { ...row, status: 'accepted' } : row
  ).concat(
    proposal({
      tagId: 12,
      tagName: 'Bleibt',
      action: 'keep',
      status: 'accepted',
    })
  );
  const overrides = new Map([
    [2, false],
    [6, true],
  ]);
  const ticked = tickedProposals(simpleSections(list), overrides);
  assert.deepStrictEqual(
    statusChanges(list, ticked),
    [
      { tagId: 1, status: 'accepted' },
      { tagId: 2, status: 'open' },
      { tagId: 3, status: 'accepted' },
      { tagId: 4, status: 'accepted' },
      { tagId: 5, status: 'accepted' },
      { tagId: 6, status: 'accepted' },
    ],
    'ticked becomes accepted, an unticked accepted row opens again, a kept row and history stay'
  );
  const apply = functionBody('applyTicked');
  assert.ok(
    apply.includes('confirmDialog({') && apply.includes("tone: 'danger'")
  );
  assert.ok(apply.includes('body: applySummaryText(ticked)'));
  assert.ok(apply.includes('statusChanges(all, ticked)'));
  assert.ok(apply.includes('await writeStatuses(changes)'));
  assert.ok(
    apply.indexOf('await writeStatuses(changes)') <
      apply.indexOf('await applyOrder(null)'),
    'the statuses first, then the one apply job of today'
  );
  const write = functionBody('writeStatuses');
  assert.ok(write.includes('encodeURIComponent(String(change.tagId))'));
  assert.ok(write.includes('PATCH_LANES'), 'a few at a time');
  assert.ok(
    write.includes('while (failure === null && next < changes.length)') &&
      write.includes('if (failure !== null) throw failure;'),
    'a failed write stops every lane, and the apply never starts'
  );
  assert.ok(
    !/renderProposals|renderSimple|patchProposal/.test(write),
    'no redraw per row'
  );
});

/* --- 8. the history line ---------------------------------------------------- */

test('The history line says when the last apply landed and leads to its undo', () => {
  const { lastApplyAt, shortDate, htmlHistoryLine, parseStamp } = simple();
  const date = lastApplyAt(FIXTURE);
  assert.ok(date instanceof Date);
  assert.strictEqual(date.toISOString(), '2026-09-14T10:00:00.000Z');
  assert.strictEqual(parseStamp('nonsense'), null);
  assert.strictEqual(lastApplyAt([FIXTURE[0]]), null);
  const now = new Date(2026, 8, 23);
  const here = new Date(2026, 8, 14, 12);
  assert.strictEqual(shortDate(here, now), '14 Sep');
  assert.strictEqual(shortDate(new Date(2025, 11, 2), now), '2 Dec 2025');
  assert.strictEqual(
    htmlHistoryLine(here, now),
    '<span>History · last apply 14 Sep</span><span aria-hidden="true">·</span><a class="zr-btn" href="/duplicates#dupLog">Undo</a>',
    'the undo of an apply lives in the merge log, as it did before'
  );
  assert.strictEqual(htmlHistoryLine(null, now), '');
});

/* --- 9. the stack ----------------------------------------------------------- */

function stackHelpers() {
  return helpers(
    [
      'num',
      'plural',
      'grouped',
      'documentsText',
      'planWrites',
      'htmlIconMarkup',
      'htmlConsequence',
      'consequenceText',
      'htmlSourceBadge',
      'htmlTypeSelect',
      'htmlTopicChips',
      'htmlStackBar',
      'htmlDecision',
      'htmlStackFoot',
    ],
    { constants: ['SOURCE_LABELS', 'SOURCE_TONES', 'GROUP_KIND_LABELS'] }
  );
}

test('The stack is one unsure tag per screen, with its bar and its way out', () => {
  const { htmlStackBar, htmlDecision, htmlStackFoot } = stackHelpers();
  const bar = htmlStackBar(4, 16, 945);
  assert.ok(bar.includes('class="zr-runbar"'));
  assert.ok(bar.includes('Tag 5 of 16') && bar.includes('12 left'));
  assert.ok(bar.includes('>Accept the 945 clear ones<'));
  assert.ok(htmlStackBar(0, 1, 1).includes('>Accept the 1 clear one<'));
  assert.ok(!htmlStackBar(0, 1, 0).includes('sim-stack-acceptclear'));

  const card = htmlDecision(FIXTURE[6], ['Rechnung', 'Abrechnung']);
  assert.ok(card.includes('class="zr-decision"'));
  assert.ok(card.includes('>As it is<') && card.includes('>Becomes<'));
  assert.ok(card.includes('<option value="Abrechnung" selected>'));
  assert.ok(card.includes('class="zr-decision__note">type or topic<'));
  assert.ok(card.includes('>0 of 9 documents with a type<'));
  assert.strictEqual(
    (card.match(/type="radio" class="sim-stack-overwrite"/g) || []).length,
    2
  );
  assert.ok(
    card.includes(
      '19 writes · type on 9 documents · topics on 9 documents · tag deleted'
    ),
    'what it writes, numbers first'
  );
  assert.ok(
    card.includes('sim-stack-accept" type="button" data-tag-id="7">Split<')
  );
  assert.ok(
    card.includes('sim-stack-keep" type="button" data-tag-id="7">Keep<')
  );
  assert.ok(
    card.includes('sim-stack-later" type="button" data-tag-id="7">Later<')
  );
  assert.ok(card.includes('class="zr-decision__keys">Enter · Esc · L<'));
  assert.ok(!card.includes('zr-btn__sub'), 'a button without a second line');
  assert.ok(
    htmlDecision(FIXTURE[5], []).includes('>Delete<') &&
      htmlDecision(FIXTURE[3], []).includes('>Merge into Auto<')
  );

  const foot = htmlStackFoot(3, { tagName: 'Stromrechnung' });
  assert.ok(foot.includes('>3 decided<'));
  assert.ok(foot.includes('>Undo Stromrechnung<'));
  assert.ok(foot.includes('>Back<'));
  assert.ok(!htmlStackFoot(0, null).includes('sim-stack-undo'));
});

test('The stack opens over exactly the unsure rows and moves their ticks', () => {
  const open = functionBody('openStack');
  assert.ok(open.includes('.unsure.map((proposal) =>'));
  assert.ok(open.includes("el.stack.classList.remove('hidden')"));
  assert.ok(open.includes('renderSimple()'), 'the result gives way to it');
  assert.ok(open.includes('el.stack.focus()'));

  const decide = functionBody('decideOnStack');
  assert.ok(decide.includes("{ action: 'keep', status: 'accepted' }"));
  assert.ok(decide.includes("{ status: 'accepted' }"));
  assert.ok(
    decide.includes('tickOverrides.set(tagId, true)'),
    'accepted is ticked'
  );
  assert.ok(decide.includes('tickOverrides.delete(tagId)'), 'kept has no box');
  assert.ok(!decide.includes('/api/simplify/apply'), 'the stack writes no tag');
  assert.ok(
    functionBody('undoLastDecision').includes('tickOverrides.set(tagId, tick)'),
    'an undo puts the tick back too'
  );
  const clear = functionBody('acceptClearOnes');
  assert.ok(clear.includes("['split', 'merge', 'delete']"));
  assert.ok(clear.includes('tickOverrides.set(num(proposal.tagId), true)'));
  assert.ok(clear.includes('closeStack()'));
  assert.ok(!clear.includes('applyOrder'), 'accepting is not applying');
});

test('The keys are bound on the stack and never inside a field', () => {
  const init = functionBody('initStack');
  assert.ok(init.includes("el.stack.addEventListener('keydown'"));
  assert.match(
    SCRIPT,
    /const EDITABLE_TAGS = \['input', 'select', 'textarea'\];/
  );
  const guard = init.indexOf('EDITABLE_TAGS.includes');
  [
    "event.key === 'Enter'",
    "event.key === 'Escape'",
    "event.key === 'l'",
  ].forEach((needle) => {
    assert.ok(init.indexOf(needle) > guard, `${needle} after the field guard`);
  });
  assert.ok(init.includes(".closest('.sim-topics__input')"));
  assert.ok(init.includes("event.target.closest('.sim-stack-acceptclear')"));
});

/* --- 10. the running screen ------------------------------------------------- */

const PROGRESS = {
  requestsDone: 12,
  requestsPlanned: 23,
  tokens: 76000,
  estimatedTokens: 110000,
  tokenBudget: 120000,
  elapsedMs: 190000,
  etaMs: 180000,
  requestPairs: 50,
  requestAnswers: 21,
  requestTokens: 8900,
  thinking: true,
  requestLog: [
    {
      index: 12,
      items: 50,
      answers: 50,
      tokens: 6100,
      thinkingTokens: 3800,
      ms: 44000,
      outcome: 'answered',
    },
    {
      index: 11,
      items: 50,
      answers: 31,
      tokens: 5200,
      thinkingTokens: 0,
      ms: 51000,
      outcome: 'partial',
    },
    {
      index: 9,
      items: 50,
      answers: 0,
      tokens: 7100,
      thinkingTokens: 7100,
      ms: 112000,
      outcome: 'empty',
    },
    {
      index: 8,
      items: 50,
      answers: 0,
      tokens: 0,
      thinkingTokens: 0,
      ms: 3000,
      outcome: 'failed',
    },
  ],
};

test('The running screen keeps its shape and loses its subject', () => {
  const {
    htmlRunbar,
    htmlRunLedger,
    htmlLiveRequest,
    reqlogText,
    reqlogCost,
    runCeilingText,
    phaseHeadline,
  } = helpers(
    [
      'num',
      'plural',
      'grouped',
      'htmlIconMarkup',
      'formatElapsed',
      'formatEta',
      'progressPercent',
      'htmlLedger',
      'htmlRunbar',
      'htmlRunLedger',
      'htmlLiveRequest',
      'reqlogText',
      'reqlogCost',
      'runCeilingText',
      'phaseHeadline',
    ],
    { constants: ['CEILING_SHOWN_ABOVE'] }
  );
  assert.ok(htmlRunbar(PROGRESS).includes('Request 13 of 23'));
  assert.ok(htmlRunbar(PROGRESS).includes('~3 min left'));
  assert.ok(htmlRunLedger(PROGRESS).includes('76k of ~110k'));
  assert.ok(
    htmlLiveRequest(PROGRESS).includes('Request 13 · 50 tags · 21 answered'),
    'the live row, facts only'
  );
  assert.ok(htmlLiveRequest(PROGRESS).includes('8.9k so far · thinking'));
  assert.strictEqual(
    reqlogText(PROGRESS.requestLog[2]),
    'Request 9 · 7.1k thinking · no answer'
  );
  assert.strictEqual(
    reqlogText(PROGRESS.requestLog[1]),
    'Request 11 · 50 tags · 31 answered · rest asked again'
  );
  assert.strictEqual(
    reqlogText(PROGRESS.requestLog[3]),
    'Request 8 · 50 tags · ended by the provider'
  );
  assert.strictEqual(
    reqlogCost(PROGRESS.requestLog[0]),
    '6.1k · 3.8k thinking'
  );
  assert.strictEqual(reqlogCost(PROGRESS.requestLog[2]), '7.1k · all thinking');
  assert.strictEqual(reqlogCost(PROGRESS.requestLog[3]), '0 tokens');
  assert.strictEqual(runCeilingText(PROGRESS), '76k of 120k limit');
  assert.strictEqual(runCeilingText({ tokens: 10, tokenBudget: 120000 }), '');
  [
    'starting',
    'warming-up',
    'vocabulary',
    'ordering',
    'splitting',
    'judging',
    'escalating',
    'applying',
    'finishing',
  ].forEach((phase) => {
    const line = phaseHeadline({ phase });
    assert.ok(!/\bI\b|\byou\b/i.test(line), `${phase}: ${line}`);
    assert.ok(!/[\u2013\u2014]/.test(line));
  });
  // Stop is one word with nothing under it.
  const stop = elementAt(
    page,
    page.indexOf('<button class="zr-btn" id="simStopBtn"')
  );
  assert.ok(stop.includes('>Stop</span>'));
  assert.ok(!stop.includes('zr-btn__sub') && !page.includes('simStopSub'));
  assert.ok(!SCRIPT.includes('function stopSubText('));
  // In simple mode the result takes over once a job has ended.
  assert.ok(
    functionBody('renderProgressOutcome').includes(
      "if (mode === 'simple') el.progress.classList.add('hidden')"
    )
  );
});

/* --- 11. the apply checklist ------------------------------------------------ */

test('The apply is a checklist in the order the job writes', () => {
  const { checklistFrom, htmlChecklist } = helpers(
    [
      'num',
      'plural',
      'grouped',
      'htmlIconMarkup',
      'formatElapsed',
      'planWrites',
      'checklistFrom',
      'htmlChecklist',
    ],
    { constants: ['APPLY_ORDER'] }
  );
  const rows = checklistFrom([
    FIXTURE[0],
    FIXTURE[4],
    FIXTURE[3],
    FIXTURE[2],
    FIXTURE[7],
  ]);
  assert.deepStrictEqual(
    rows.map((row) => row.tagId),
    [3, 4, 1, 5],
    'merges, splits, deletions, the biggest first; a kept tag writes nothing'
  );
  rows[0].state = 'done';
  rows[0].seconds = 3;
  rows[1].state = 'running';
  rows[3].state = 'failed';
  rows[3].error = '400 Bad Request';
  const html = htmlChecklist(rows);
  assert.ok(html.includes('1 of 4 done · 1 failed · 118 writes'));
  assert.ok(html.includes('>0 tokens<'));
  assert.ok(html.includes('>rechnungen · 38 writes<'));
  assert.ok(html.includes('Scan2019 · 400 Bad Request · 1 write to do'));
  assert.ok(html.includes('sim-checklist-retry') && html.includes('>Retry<'));
  assert.strictEqual(htmlChecklist([]), '');
  const apply = functionBody('applyOrder');
  assert.ok(apply.includes('checklistRows = checklistFrom('));
  assert.ok(apply.includes('finishChecklist(data)'));
  assert.ok(
    apply.includes("if (mode === 'simple' && failures === 0) {"),
    'in simple mode a clean apply leaves its one line, not every row'
  );
  assert.ok(
    functionBody('followJob').includes('if (applying) advanceChecklist(')
  );
});

/* --- 12. the advanced page -------------------------------------------------- */

test("The advanced page carries today's tools and no hints", () => {
  const inAdvanced = marked(page, 'data-advanced')
    .map((part) => part.html)
    .join('\n');
  [
    'Propose a new order',
    'Keep vocabulary<',
    'data-view="groups"',
    'data-view="table"',
    'id="simGroupFilters"',
    'id="simGroupSearch"',
    'id="simVocabularyBlock"',
    'id="simProposalsTable"',
    'id="simSearch"',
    'Propose splits',
    '>Select all open<',
    '>Clear<',
    'Skip\n',
    'Apply\n',
  ].forEach((needle) => {
    assert.ok(
      inAdvanced.includes(needle),
      `${needle} is missing from advanced`
    );
  });
  assert.match(inAdvanced, /class="zr-toggle" id="simOrderKeepVocabulary"/);
  // No paragraph explains anything.
  [
    'Nothing here runs',
    'The model reads every tag',
    'A document type is the kind of document',
    'Runs the rule against',
    'Group them by type',
    'Keep my vocabulary',
    'Propose from my tags',
    'switched off in the settings',
    'Save a vocabulary first',
  ].forEach((needle) => {
    assert.ok(
      !page.includes(needle) && !pageNoModel.includes(needle),
      `"${needle}" is back`
    );
  });
  assert.ok(
    !/<p class="zr-sm zr-faint">[^<]{40,}<\/p>/.test(inAdvanced),
    'a long faint paragraph is a hint, and hints are gone'
  );
});

test("Round 13's baskets, plan head and preflight are gone", () => {
  [
    'simPlan',
    'simPlanHead',
    'simBaskets',
    'simStopSub',
    'simApplyAcceptedSub',
    'zr-basket',
    'zr-preflight',
    'sim-groupsblock__summary',
  ].forEach((needle) => {
    assert.ok(!VIEW.includes(needle), `${needle} is still in the view`);
    assert.ok(!SCRIPT.includes(needle), `${needle} is still in the script`);
  });
  [
    'planBaskets',
    'htmlBasket',
    'htmlPlanHead',
    'planHeadline',
    'runAgreed',
    'askChoices',
  ].forEach((name) => {
    assert.ok(!SCRIPT.includes(`function ${name}(`), `${name}() is retired`);
  });
  assert.ok(!PAGE_CSS.includes('sim-plan') && !PAGE_CSS.includes('sim-basket'));
});

/* --- 13. the page stylesheet ------------------------------------------------ */

test('The page places the kit rather than redefining it', () => {
  assert.strictEqual((PAGE_CSS.match(/@layer [a-z]+ \{/g) || []).length, 1);
  assert.ok(PAGE_CSS.includes('@layer pages {'));
  const redefined = [
    '.zr-start',
    '.zr-resulthead',
    '.zr-checklist',
    '.zr-checklist__row',
    '.zr-historyline',
    '.zr-sheet',
    '.zr-decision',
    '.zr-tokenbar',
    '.zr-runbar',
    '.zr-reqlog',
    '.zr-runmeter',
  ].filter((selector) =>
    new RegExp(`\\n  ${selector.replace('.', '\\.')}( |,)`).test(PAGE_CSS)
  );
  assert.deepStrictEqual(
    redefined,
    [],
    `the kit belongs to css/review; the page may only place it: ${redefined.join(', ')}`
  );
  [
    '.sim-page',
    '.sim-resultcard',
    '.sim-lists',
    '.sim-list__card',
    '.sim-stack',
    '.sim-checklist',
    '.sim-progress',
  ].forEach((selector) => {
    assert.ok(PAGE_CSS.includes(`${selector} {`), `${selector} has no rule`);
  });
  // 390px: one column of checklists.
  assert.match(
    PAGE_CSS,
    /@media \(max-width: 720px\) \{\n\s+\.sim-lists \{\n\s+grid-template-columns: minmax\(0, 1fr\);/
  );
});

/* --- 14. the voice ---------------------------------------------------------- */

test('The page is held to the voice, and no file of it carries a dash', () => {
  const voice = read('tests', 'test-review-voice.js');
  assert.ok(voice.includes("'views/simplify.ejs'"));
  assert.ok(voice.includes("'public/js/simplify.js'"));
  [
    'views/simplify.ejs',
    'public/js/simplify.js',
    'public/css/pages/simplify.css',
    'tests/test-simplify-ui.js',
    'tests/test-simplify-assistant-ui.js',
    'tests/test-simplify-groups.js',
  ].forEach((file) => {
    const text = read(file);
    const at = text.search(/[\u2013\u2014]/);
    assert.strictEqual(
      at,
      -1,
      `${file} carries a dash: ${text.slice(Math.max(0, at - 30), at + 30)}`
    );
  });
});

test('Every action is a bordered button, never a text button or a bare link', () => {
  // A button with no border reads as a link, and a link is not a way to
  // cancel, undo or open anything on these pages. The kit's own modules
  // are held to the same rule.
  const modules = [
    read('public', 'js', 'modules', 'review-sheet.js'),
    read('public', 'js', 'modules', 'review-mode.js'),
  ].join('\n');
  for (const [name, text] of [
    ['view', VIEW],
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

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
