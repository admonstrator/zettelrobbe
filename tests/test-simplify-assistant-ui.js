/**
 * Test: simplify-assistant-ui
 *
 * The Simplify tags page as one page. The assistant is the zone at the top:
 * the start with its one button, the run meter with the steps and the
 * sentence of what happens now, the result as a headline of numbers with the
 * lines of how the tools are used and two buttons, and the stack in its
 * place. The whole toolset stands under it from the first second and waits,
 * dimmed, until a result exists. The proposal of a run lands as status: what
 * the model was sure of, or a rule settled, is accepted once when the run
 * ends, and "accepted" is the tick in the groups.
 *
 * Covers:
 *  1. the kit is linked, layered and has every class this page places
 *  2. the view: one root, the assistant wrapper its first child, no mode, no
 *     gate, an empty top bar, one caption per tool, none of the retired
 *     classes
 *  3. the start from fixtures, with and without a model, with its facts line
 *  4. the result from a proposals fixture: its three numbers, the cost line,
 *     the lines of the guide, the two buttons and the numbers following a
 *     reopen
 *  5. the face the assistant shows, and the waiting switch of the workspace
 *  6. the accepted on finish rule: sure lands accepted, low stays open, once,
 *     through the status route; an order that ended unwatched lands once too
 *  7. the running screen: the steps, the sentence with the tally, the ledger,
 *     the token legend, the request rows worded by kind
 *  8. the sheet: its model from an estimate fixture, its switches and prices,
 *     the shared markup, the levers that fetch a fresh estimate
 *  9. the stack over the unsure proposals, and its keys
 * 10. the apply checklist, and the Undo of the apply result
 * 11. the page stylesheet places the kit rather than redefining it
 * 12. the voice: the page is in the list of the voice test, and no file of
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
const SCRIPT = read('public', 'js', 'simplify.js');
const VIEW = read('views', 'simplify.ejs');

/** The classes retired after this round; the page places none of them. */
const RETIRED = [
  'zr-start',
  'zr-resulthead',
  'zr-checklist',
  'zr-historyline',
  'zr-modebtn',
  'zr-gate',
];

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
    '.zr-assist',
    '.zr-assist__icon',
    '.zr-assist__text',
    '.zr-assist__title',
    '.zr-assist__line',
    '.zr-assist__facts',
    '.zr-assist__headline',
    '.zr-assist__cost',
    '.zr-assist__next',
    '.zr-assist__actions',
    '.zr-steps',
    '.zr-steps__step',
    '.zr-steps__step--done',
    '.zr-steps__step--now',
    '.zr-steps__mark',
    '.zr-steps__sub',
    '.zr-runmeter__sentence',
    '.zr-workspace__note',
    '.zr-module__caption',
    '.zr-tokenbar--mini',
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
  assert.ok(KIT.includes('.zr-workspace--waiting'));
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

/** The direct children of an element, as their opening tags. */
function childTags(html) {
  const inner = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</'));
  const tags = [];
  let at = inner.search(/<[a-z]/);
  while (at !== -1) {
    tags.push(/^<[^>]*>/.exec(inner.slice(at))[0]);
    const whole = elementAt(inner, at);
    const next = inner.slice(at + whole.length).search(/<[a-z]/);
    at = next === -1 ? -1 : at + whole.length + next;
  }
  return tags;
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

/** A module of the kit, loaded the way tests/test-review-sheet.js does. */
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
const ASSIST = loadModule('public/js/modules/review-assist.js', [
  'stepStates',
  'htmlSteps',
  'htmlSentence',
  'htmlAssistStart',
  'htmlAssistDone',
  'htmlCaption',
]);
const { SIMPLIFY_GUIDE } = loadModule('public/js/modules/review-guide.js', [
  'SIMPLIFY_GUIDE',
]);

/**
 * The named helpers of the page script, evaluated out of their module. Only
 * pure functions can be taken this way, which is why everything the
 * assistant decides is written as a pure function.
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
      SIMPLIFY_GUIDE,
    },
    ASSIST,
    extra.globals || {}
  );
  const keys = Object.keys(globals);
  return new Function(
    ...keys,
    `${constants}\n${source}\nreturn { ${names.join(', ')} };`
  )(...keys.map((key) => globals[key]));
}

/** Everything the result, its numbers and the start stand on. */
const RESULT = [
  'num',
  'plural',
  'grouped',
  'planWrites',
  'tokenSplit',
  'splitShares',
  'sectionOf',
  'sureChanges',
  'unsureOpen',
  'resultCounts',
  'doneHeadline',
  'applyLabel',
  'reviewLabel',
  'htmlRunCost',
  'parseStamp',
  'lastApplyAt',
  'shortDate',
  'lastApplyFacts',
  'assistState',
  'htmlStartCard',
  'htmlDoneCard',
  'missedFinish',
  'acceptPlan',
];

const RESULT_CONSTANTS = ['CHANGE_SECTIONS', 'NO_MODEL', 'MONTHS', 'JOB_TASKS'];

function result(globals) {
  return helpers(RESULT, { constants: RESULT_CONSTANTS, globals });
}

/* --- the fixture: every kind, both sources, every status -------------------- */

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

/** A run as it lands: every proposal open, before the finish ticks it. */
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

/** The fixture after the finish: the sure changes accepted, nothing else. */
function landed() {
  const sure = new Set([1, 2, 3, 4, 5]);
  return FIXTURE.map((row) =>
    sure.has(row.tagId) ? Object.assign({}, row, { status: 'accepted' }) : row
  );
}

/* --- 2. the view -------------------------------------------------------------- */

test('One root, no mode, and the assistant is its first child', () => {
  assert.match(
    page,
    /<div class="sim-page" id="simPage" data-review-page="simplify">/,
    'the root keeps its review page and carries no mode'
  );
  assert.strictEqual((page.match(/data-review-page=/g) || []).length, 1);
  ['data-mode', 'data-simple', 'data-advanced'].forEach((mark) => {
    assert.ok(!VIEW.includes(mark), `${mark} is back in the view`);
    assert.ok(!page.includes(`${mark}=`) && !page.includes(`${mark}>`));
  });
  const root = elementAt(page, page.indexOf('<div class="sim-page"'));
  const children = childTags(root);
  assert.match(
    children[0],
    /^<section class="sim-assist" id="simAssist" data-assist data-provider="ready"/,
    'the assistant wrapper is the first child, for setWorkspaceWaiting'
  );
  assert.ok(
    /data-provider="none"/.test(pageNoModel),
    'the assistant says when no model is configured'
  );
  assert.ok(
    children[0].includes(
      `aria-label="${escForTest(SIMPLIFY_GUIDE.start.title)}"`
    ),
    'the region is named by the sentence of the page, as its start says it'
  );
  // The toolset follows it, in its order.
  const ids = children.map((tag) => (/id="([^"]+)"/.exec(tag) || [])[1]);
  assert.deepStrictEqual(ids, [
    'simAssist',
    'simOrder',
    'simGroupsBlock',
    'simProposals',
    'simVocabularyBlock',
  ]);
  // The run meter, the apply and the stack live in the assistant.
  const assist = elementAt(root, root.indexOf('<section class="sim-assist"'));
  [
    'simAssistCard',
    'simProgress',
    'simSteps',
    'simSentence',
    'simRunbar',
    'simRunLedger',
    'simRunTokens',
    'simReqLog',
    'simApplyChecklist',
    'simApplyResult',
    'simStack',
  ].forEach((id) => {
    assert.ok(assist.includes(`id="${id}"`), `#${id} belongs to the assistant`);
  });
  assert.match(
    assist,
    /class="sim-progress zr-runmeter hidden" id="simProgress"/
  );
  assert.match(assist, /class="sim-stack hidden" id="simStack"/);
});

test('No gate, no mode switch, nothing stored about a mode', () => {
  assert.ok(!SCRIPT.includes('review-mode.js'), 'the mode module is retired');
  assert.ok(!SCRIPT.includes('mountModeSwitch'));
  assert.ok(!SCRIPT.includes('zrTopbarActions'), 'the top bar slot is empty');
  assert.ok(!SCRIPT.includes('localStorage') && !SCRIPT.includes('GATE_'));
  assert.ok(!/\bmode\b\s*=/.test(SCRIPT), 'no mode is kept');
  [
    'initMode',
    'initSimple',
    'renderSimple',
    'simpleSections',
    'htmlSection',
    'htmlChecklistRow',
    'applyTicked',
    'updateApplyTicked',
    'acceptClearOnes',
    'htmlHistoryLine',
    'resultHeadline',
  ].forEach((name) => {
    assert.ok(!SCRIPT.includes(`function ${name}(`), `${name}() is retired`);
  });
  ['tickOverrides', 'simEmptyCard', 'simResult', 'simLists'].forEach(
    (needle) => {
      assert.ok(!SCRIPT.includes(needle) && !VIEW.includes(needle), needle);
    }
  );
});

test('The page places none of the retired classes', () => {
  RETIRED.forEach((name) => {
    const re = new RegExp(`${name}(?![a-z-])|${name}__|${name}--`);
    assert.ok(!re.test(VIEW), `.${name} is in the view`);
    assert.ok(!re.test(SCRIPT), `.${name} is in the script`);
    assert.ok(!re.test(PAGE_CSS), `.${name} is in the page stylesheet`);
  });
});

test('One caption per tool, from the guide, and no other prose', () => {
  const places = [
    ...VIEW.matchAll(/<div data-caption="([a-z]+)"><\/div>/g),
  ].map((match) => match[1]);
  assert.deepStrictEqual(places, ['order', 'table', 'vocabulary']);
  places.forEach((key) => {
    assert.ok(SIMPLIFY_GUIDE.sections[key], `the guide has no ${key}`);
  });
  // The order caption sits in the groups block, the table's in the table.
  const at = (needle) => page.indexOf(needle);
  assert.ok(
    at('id="simGroupsBlock"') < at('data-caption="order"') &&
      at('data-caption="order"') < at('id="simProposals"')
  );
  assert.ok(
    at('id="simProposals"') < at('data-caption="table"') &&
      at('data-caption="table"') < at('id="simVocabularyBlock"')
  );
  const init = functionBody('initCaptions');
  assert.ok(init.includes('htmlCaption('));
  assert.ok(init.includes('SIMPLIFY_GUIDE.sections['));
  assert.strictEqual(
    ASSIST.htmlCaption(SIMPLIFY_GUIDE.sections.order),
    `<p class="zr-module__caption">${escForTest(SIMPLIFY_GUIDE.sections.order)}</p>`
  );
  // No paragraph of the view explains anything: its text is labels.
  const text = VIEW.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<%[\s\S]*?%>/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const long = text.filter((line) => line.split(/\s+/).length > 5);
  assert.deepStrictEqual(long, [], `prose in the view: ${long.join(' | ')}`);
  assert.ok(functionBody('init').includes('initCaptions()'));
});

/* --- 3. the start ------------------------------------------------------------- */

test('The start is the guide, the split icon, one button and the facts line', () => {
  const { htmlStartCard } = result();
  const card = htmlStartCard(true, '');
  assert.ok(card.startsWith('<div class="zr-assist zr-assist--start">'));
  assert.ok(card.includes('#i-split'), 'the start wears the split icon');
  assert.ok(
    card.includes(
      `<h2 class="zr-assist__title">${escForTest(SIMPLIFY_GUIDE.start.title)}</h2>`
    )
  );
  assert.ok(card.includes(escForTest(SIMPLIFY_GUIDE.start.what)));
  assert.ok(
    card.includes(
      '<button class="zr-btn zr-btn--primary zr-btn--lg" id="simStartBtn" type="button">Simplify tags</button>'
    )
  );
  assert.ok(
    card.includes('<p class="zr-assist__facts hidden" id="simStartFacts"></p>'),
    'without an apply the facts line is hidden'
  );
  const withFacts = htmlStartCard(true, 'Last apply 23 Sep · 20 tags');
  assert.ok(
    withFacts.includes(
      '<p class="zr-assist__facts" id="simStartFacts">Last apply 23 Sep · 20 tags</p>'
    )
  );
  assert.strictEqual(SIMPLIFY_GUIDE.start.button, 'Simplify tags');
  // The button opens the sheet and runs the order.
  assert.ok(
    functionBody('initAssist').includes("event.target.closest('#simStartBtn')")
  );
  assert.ok(functionBody('initAssist').includes('proposeOrder()'));
  assert.ok(functionBody('proposeOrder').includes('await askPreflight(false)'));
});

test('Without a model the button is dead and the facts line says so', () => {
  const { htmlStartCard } = result();
  const card = htmlStartCard(false, 'Last apply 23 Sep · 20 tags');
  assert.match(card, /id="simStartBtn" type="button" disabled>Simplify tags</);
  assert.ok(
    card.includes(
      '<p class="zr-assist__facts" id="simStartFacts">No model configured</p>'
    )
  );
  assert.ok(card.includes(escForTest(SIMPLIFY_GUIDE.start.whatWithoutModel)));
  assert.ok(
    functionBody('modelReady').includes(
      "el.assist.dataset.provider === 'ready'"
    )
  );
});

test('The facts line names the last apply from the proposals', () => {
  const { lastApplyFacts } = result();
  const now = new Date('2026-09-24T12:00:00Z');
  const applied = (id, stamp) =>
    proposal({ tagId: id, status: 'applied', updatedAt: stamp });
  const list = [
    ...FIXTURE,
    applied(20, '2026-09-23 09:00:00'),
    applied(21, '2026-09-23 11:30:00'),
    applied(22, '2026-09-23 11:31:00'),
  ];
  assert.strictEqual(lastApplyFacts(list, now), 'Last apply 23 Sep · 3 tags');
  assert.strictEqual(
    lastApplyFacts([FIXTURE[8]], now),
    'Last apply 14 Sep · 1 tag'
  );
  assert.strictEqual(lastApplyFacts(FIXTURE.slice(0, 8), now), '');
  assert.strictEqual(
    lastApplyFacts([FIXTURE[8]], new Date('2027-01-02T00:00:00Z')),
    'Last apply 14 Sep 2026 · 1 tag',
    'the year only when it is not this one'
  );
});

/* --- 4. the result ------------------------------------------------------------ */

test('The headline counts every tag, the ticked changes and the open unsure ones', () => {
  const { resultCounts, doneHeadline } = result();
  const counts = resultCounts(landed());
  assert.deepStrictEqual(
    [counts.tags, counts.proposed, counts.unsure],
    [11, 5, 2],
    'every proposal, the five sure changes, the two unsure changes'
  );
  assert.strictEqual(
    doneHeadline(counts),
    '11 tags · 5 changes proposed · 2 unsure'
  );
  assert.strictEqual(
    doneHeadline({ tags: 1187, proposed: 945, unsure: 118 }),
    '1,187 tags · 945 changes proposed · 118 unsure'
  );
  assert.strictEqual(
    doneHeadline({ tags: 1, proposed: 1, unsure: 0 }),
    '1 tag · 1 change proposed · 0 unsure'
  );
  // A kept tag with a doubt writes nothing and is not in the review.
  assert.strictEqual(FIXTURE[7].confidence, 'low');
  assert.strictEqual(resultCounts([FIXTURE[7]]).unsure, 0);
  assert.strictEqual(counts.live, 8, 'the changes left to act on, skipped too');
  assert.strictEqual(resultCounts(FIXTURE.slice(7, 9)).live, 0);
});

test('The numbers follow a reopen, a stack decision and a skip, live', () => {
  const { resultCounts, applyLabel, doneHeadline } = result();
  const rows = landed();
  const before = resultCounts(rows);
  assert.strictEqual(
    applyLabel({ tags: before.proposed, writes: before.writes }),
    'Apply 5 · 181 writes'
  );
  // Untick one: it is open again, and Apply writes one tag less.
  const reopened = rows.map((row) =>
    row.tagId === 3 ? Object.assign({}, row, { status: 'open' }) : row
  );
  const after = resultCounts(reopened);
  assert.strictEqual(after.proposed, 4);
  assert.strictEqual(
    applyLabel({ tags: after.proposed, writes: after.writes }),
    'Apply 4 · 143 writes'
  );
  assert.strictEqual(after.unsure, 2, 'a sure tag reopened is not unsure');
  // The stack accepts an unsure one: one change more, one unsure less.
  const decided = rows.map((row) =>
    row.tagId === 7 ? Object.assign({}, row, { status: 'accepted' }) : row
  );
  assert.strictEqual(
    doneHeadline(resultCounts(decided)),
    '11 tags · 6 changes proposed · 1 unsure'
  );
  // The stack keeps one: it stays, accepted, and writes nothing.
  const kept = rows.map((row) =>
    row.tagId === 6
      ? Object.assign({}, row, { action: 'keep', status: 'accepted' })
      : row
  );
  assert.deepStrictEqual(
    [resultCounts(kept).proposed, resultCounts(kept).unsure],
    [5, 1]
  );
  assert.strictEqual(
    applyLabel({ tags: 945, writes: 2340 }),
    'Apply 945 · 2,340 writes'
  );
  assert.strictEqual(applyLabel({ tags: 1, writes: 1 }), 'Apply 1 · 1 write');
});

test('The result card: headline, cost, the lines of the guide, two buttons', () => {
  const { htmlDoneCard, resultCounts } = result();
  const cost = {
    requests: 23,
    tokens: 110000,
    ms: 180000,
    prompt: 78000,
    completion: 32000,
    thinking: 12000,
  };
  const card = htmlDoneCard(resultCounts(landed()), cost, false);
  assert.ok(card.startsWith('<div class="zr-assist zr-assist--done">'));
  assert.ok(
    card.includes(
      '<p class="zr-assist__headline">11 tags · 5 changes proposed · 2 unsure</p>'
    )
  );
  assert.ok(card.includes('23 requests · 110k tokens · ~3 min'));
  assert.ok(card.includes('zr-tokenbar--mini'));
  assert.ok(card.includes('78k read · 20k written · 12k thinking'));
  SIMPLIFY_GUIDE.done.next.forEach((line) => {
    assert.ok(card.includes(`<li>${escForTest(line)}</li>`), line);
  });
  assert.ok(
    card.includes(
      '<button class="zr-btn" id="simReviewBtn" type="button">Review 2 unsure one by one</button>'
    )
  );
  assert.ok(
    card.includes(
      '<button class="zr-btn zr-btn--primary" id="simApplyAcceptedBtn" type="button">Apply 5 · 181 writes</button>'
    )
  );
  // Without a cost the line is not drawn at all, and never says it is missing.
  const bare = htmlDoneCard(resultCounts(landed()), null, false);
  assert.ok(!bare.includes('zr-assist__cost'));
  assert.ok(!SCRIPT.includes('Cost not recorded'));
  // Nothing unsure: no way into the stack. Nothing ticked: Apply is dead.
  const none = htmlDoneCard(
    { tags: 3, proposed: 0, writes: 0, unsure: 0 },
    null,
    false
  );
  assert.ok(!none.includes('simReviewBtn'));
  assert.match(
    none,
    /id="simApplyAcceptedBtn" type="button" disabled>Apply 0 · 0 writes</
  );
  assert.match(
    htmlDoneCard(resultCounts(landed()), null, true),
    /id="simApplyAcceptedBtn" type="button" disabled>/,
    'dead while a job runs'
  );
  // The buttons are the stack and today's apply of everything accepted.
  const wiring = functionBody('initAssist');
  assert.ok(
    wiring.includes("closest('#simReviewBtn')") &&
      wiring.includes('openStack()')
  );
  assert.ok(
    wiring.includes("closest('#simApplyAcceptedBtn')") &&
      wiring.includes('applyAllAccepted()')
  );
  const all = functionBody('applyAllAccepted');
  assert.ok(
    all.includes('confirmDialog({') && all.includes('applySummaryText(list)')
  );
  assert.ok(all.includes('await applyOrder(null)'));
});

/* --- 5. the face and the waiting workspace ------------------------------------- */

test('The assistant shows the run, the stack, the result or the start', () => {
  const { assistState } = result();
  assert.strictEqual(
    assistState({ running: true, stack: true, live: 5 }),
    'running'
  );
  assert.strictEqual(
    assistState({ running: false, stack: true, live: 5 }),
    'stack'
  );
  assert.strictEqual(
    assistState({ running: false, stack: false, live: 5 }),
    'done'
  );
  assert.strictEqual(
    assistState({ running: false, stack: false, live: 0 }),
    'start'
  );
  assert.strictEqual(assistState(null), 'start');
});

/** A node with a class list, enough for renderAssist. */
function fakeNode() {
  const classes = new Set(['hidden']);
  return {
    innerHTML: '',
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
  };
}

/** renderAssist over a page state, with the waiting switch recorded. */
function renderWith(state) {
  const calls = [];
  const el = {
    assist: { dataset: { provider: 'ready' } },
    assistCard: fakeNode(),
    progress: fakeNode(),
    stack: fakeNode(),
    page: { id: 'simPage' },
  };
  const { renderAssist } = helpers([...RESULT, 'renderAssist'], {
    constants: RESULT_CONSTANTS,
    globals: Object.assign(
      {
        el,
        proposals: new Map((state.list || []).map((row) => [row.tagId, row])),
        jobId: null,
        finishing: null,
        stacking: false,
        starting: false,
        loaded: true,
        lastRunCost: null,
        applying: false,
        modelReady: () => true,
        setWorkspaceWaiting: (root, waiting) => calls.push([root, waiting]),
      },
      state.globals || {}
    ),
  });
  renderAssist();
  return { el, calls };
}

test('The workspace waits on load without proposals and during a run', () => {
  const empty = renderWith({ list: [] });
  assert.deepStrictEqual(empty.calls, [[empty.el.page, true]]);
  assert.ok(empty.el.assistCard.innerHTML.includes('zr-assist--start'));
  assert.ok(empty.el.progress.classList.contains('hidden'));

  const done = renderWith({ list: landed() });
  assert.deepStrictEqual(
    done.calls,
    [[done.el.page, false]],
    'awake with a result'
  );
  assert.ok(done.el.assistCard.innerHTML.includes('zr-assist--done'));

  const running = renderWith({ list: landed(), globals: { jobId: 'job-1' } });
  assert.deepStrictEqual(running.calls, [[running.el.page, true]]);
  assert.ok(
    !running.el.progress.classList.contains('hidden'),
    'the meter shows'
  );
  assert.strictEqual(running.el.assistCard.innerHTML, '', 'the card gives way');

  const ticking = renderWith({
    list: landed(),
    globals: { finishing: { done: 3, total: 5 } },
  });
  assert.deepStrictEqual(ticking.calls, [[ticking.el.page, true]]);

  const stack = renderWith({ list: landed(), globals: { stacking: true } });
  assert.ok(!stack.el.stack.classList.contains('hidden'));
  assert.strictEqual(stack.el.assistCard.innerHTML, '');
  assert.deepStrictEqual(stack.calls, [[stack.el.page, false]]);

  // Everything written: the start again, with the tools awake below it.
  const history = renderWith({ list: [FIXTURE[8], FIXTURE[7]] });
  assert.ok(history.el.assistCard.innerHTML.includes('zr-assist--start'));
  assert.ok(
    history.el.assistCard.innerHTML.includes('Last apply 14 Sep · 1 tag')
  );
  assert.deepStrictEqual(history.calls, [[history.el.page, false]]);

  // From the moment a run is asked for, its button is dead.
  const asked = renderWith({ list: [], globals: { starting: true } });
  assert.match(
    asked.el.assistCard.innerHTML,
    /id="simStartBtn" type="button" disabled>/
  );
  const applying = renderWith({ list: landed(), globals: { starting: true } });
  assert.match(
    applying.el.assistCard.innerHTML,
    /id="simApplyAcceptedBtn" type="button" disabled>/
  );

  // Before the first load nothing is drawn and nothing waits.
  const first = renderWith({ list: [], globals: { loaded: false } });
  assert.strictEqual(first.el.assistCard.innerHTML, '');
  assert.deepStrictEqual(first.calls, []);
});

test('The page follows every change of the proposals with the assistant', () => {
  assert.ok(functionBody('loadProposals').includes('renderAssist()'));
  assert.ok(functionBody('patchProposal').includes('renderAssist()'));
  assert.ok(functionBody('setOrderBusy').includes('renderAssist()'));
  assert.ok(functionBody('showProgressPanel').includes('renderAssist()'));
  assert.ok(
    functionBody('loadProposals').includes('loaded = true'),
    'a page whose proposals could not be read still shows its start'
  );
});

/* --- 6. the proposal lands as status ------------------------------------------- */

test('When a run ends, sure proposals are accepted and low ones stay open', () => {
  const { sureChanges } = result();
  assert.deepStrictEqual(sureChanges(FIXTURE), [
    { tagId: 1, status: 'accepted' },
    { tagId: 2, status: 'accepted' },
    { tagId: 3, status: 'accepted' },
    { tagId: 4, status: 'accepted' },
    { tagId: 5, status: 'accepted' },
  ]);
  // Low confidence (6, 7), a keep (8), history (9), a decision (10) and a
  // split into nothing (11) are left as they are.
  assert.deepStrictEqual(
    sureChanges(landed()),
    [],
    'once: nothing is left to tick'
  );
  const finish = functionBody('finishOrder');
  assert.ok(finish.includes('acceptPlan(groups, [...proposals.values()])'));
  assert.ok(finish.includes('await writeAcceptPlan(plan,'));
  assert.ok(
    finish.indexOf('await loadGroups()') < finish.indexOf('acceptPlan('),
    'the plan is made from the groups of this run'
  );
  const writePlan = functionBody('writeAcceptPlan');
  assert.ok(
    writePlan.includes(
      '`/api/simplify/groups/${encodeURIComponent(String(group.key))}/decision`'
    ) && writePlan.includes("{ decision: 'accept' }"),
    "a whole group through the decision a card's Accept sends"
  );
  assert.ok(writePlan.includes('await writeStatuses(plan.tags,'));
  const write = functionBody('writeStatuses');
  assert.ok(
    write.includes("'PATCH'") &&
      write.includes(
        '`/api/simplify/proposals/${encodeURIComponent(String(change.tagId))}`'
      ),
    "through today's status route"
  );
  assert.ok(write.includes('PATCH_LANES'));
  // The order job's finish handler, from a run of this page and from a
  // reload while one runs; no other job ticks anything.
  assert.ok(functionBody('runOrderJob').includes('await finishOrder('));
  assert.ok(functionBody('reattachJob').includes('await finishOrder(result'));
  assert.ok(!functionBody('proposeSplits').includes('finishOrder'));
  assert.ok(!functionBody('applyOrder').includes('finishOrder'));
  // The step after the run starts before the job is let go, so the old
  // result never shows in between.
  assert.ok(
    functionBody('renderProgressOutcome').includes(
      'finishing = { done: 0, total: 0 }'
    )
  );
});

test('The sure changes are written with the fewest requests, and exactly them', () => {
  const { acceptPlan, sureChanges } = result();
  const member = (tagId, status = 'open') => ({ tagId, status });
  const groups = [
    // Every open tag of it is sure: accepted whole, in one request.
    {
      key: 'type:Rechnung',
      kind: 'type',
      tags: 3,
      members: [member(1), member(2), member(9, 'applied')],
    },
    // An unsure tag in it: its sure tags go one by one, unless covered.
    {
      key: 'type:Abrechnung',
      kind: 'type',
      tags: 2,
      members: [member(7), member(2)],
    },
    { key: 'merge:Rechnung', kind: 'merge', tags: 1, members: [member(3)] },
    { key: 'merge:Auto', kind: 'merge', tags: 1, members: [member(4)] },
    // A skipped tag would be accepted with the group: not whole.
    {
      key: 'topic:Gas',
      kind: 'topic',
      tags: 2,
      members: [member(10, 'skipped'), member(1)],
    },
    // Everything in it is covered already: no request of its own.
    { key: 'topic:Strom', kind: 'topic', tags: 1, members: [member(1)] },
    { key: 'delete', kind: 'delete', tags: 2, members: [member(5), member(6)] },
    { key: 'keep', kind: 'keep', tags: 1, members: [member(8)] },
  ];
  const plan = acceptPlan(groups, FIXTURE);
  assert.deepStrictEqual(plan.groups, [
    { key: 'type:Rechnung', tags: 2 },
    { key: 'merge:Rechnung', tags: 1 },
    { key: 'merge:Auto', tags: 1 },
  ]);
  assert.deepStrictEqual(plan.tags, [{ tagId: 5, status: 'accepted' }]);
  assert.strictEqual(plan.total, 5);
  const written = new Set([
    ...plan.tags.map((change) => change.tagId),
    1,
    2,
    3,
    4,
  ]);
  assert.deepStrictEqual(
    [...written].sort(),
    sureChanges(FIXTURE)
      .map((change) => change.tagId)
      .sort(),
    'exactly the sure changes, however they are written'
  );
  // Without groups every sure change goes one by one.
  assert.deepStrictEqual(acceptPlan([], FIXTURE).tags, sureChanges(FIXTURE));
  assert.deepStrictEqual(acceptPlan(groups, landed()).groups, [], 'once');
});

test('An order that ended unwatched lands once, and only then', () => {
  const { missedFinish } = result();
  const job = { task: 'order', status: 'done' };
  assert.strictEqual(missedFinish(job, FIXTURE.slice(0, 9)), true);
  assert.strictEqual(
    missedFinish(job, FIXTURE),
    false,
    'a skipped tag is a decision: the page leaves the statuses alone'
  );
  assert.strictEqual(missedFinish(job, landed()), false, 'once');
  assert.strictEqual(
    missedFinish({ task: 'order', status: 'stopped' }, FIXTURE.slice(0, 9)),
    true
  );
  assert.strictEqual(
    missedFinish({ task: 'order', status: 'failed' }, FIXTURE.slice(0, 9)),
    false
  );
  assert.strictEqual(
    missedFinish({ task: 'apply', status: 'done' }, FIXTURE.slice(0, 9)),
    false
  );
  assert.strictEqual(
    missedFinish(job, [FIXTURE[5], FIXTURE[7]]),
    false,
    'nothing sure'
  );
  const reattach = functionBody('reattachJob');
  assert.ok(reattach.includes('missedFinish(job, [...proposals.values()])'));
  assert.ok(
    functionBody('init').indexOf('await loadProposals()') <
      functionBody('init').indexOf('reattachJob()'),
    'the proposals are read before the page decides'
  );
});

test('A tick in the groups is the status: ticked accepts, unticked reopens', () => {
  const tick = functionBody('tickMember');
  assert.ok(tick.includes("{ status: on === true ? 'accepted' : 'open' }"));
  assert.ok(
    tick.includes('await refreshGroups()') &&
      tick.includes('await loadProposals()'),
    'every card the tag sits in follows, in place'
  );
  const refresh = functionBody('refreshGroups');
  assert.ok(refresh.includes("querySelectorAll('.sim-group')"));
  assert.ok(
    refresh.includes('node.outerHTML = htmlGroupCard(group, cardState(group))')
  );
  assert.ok(
    !refresh.includes('visibleGroups()'),
    'no card vanishes under the hand'
  );
  assert.ok(functionBody('decideGroup').includes('await refreshGroups()'));
  const wiring = functionBody('initOrder');
  assert.ok(wiring.includes(".closest('.sim-member-tick')"));
  assert.ok(wiring.includes(".closest('.sim-group-tick')"));
  assert.ok(wiring.includes("head.checked === true ? 'accept' : 'reopen'"));
  assert.ok(!SCRIPT.includes("'/api/simplify/apply', { tagIds: ticked"));
});

/* --- 7. the running screen ----------------------------------------------------- */

const RUNNING = [
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
  'itemsText',
  'reqlogText',
  'reqlogCost',
  'runCeilingText',
  'phaseHeadline',
  'tallyText',
  'stepSub',
  'runSteps',
  'htmlRunSentence',
  'tokenSplit',
  'splitShares',
  'htmlTokenbar',
];

function running() {
  return helpers(RUNNING, {
    constants: ['CEILING_SHOWN_ABOVE', 'JOB_TASKS', 'STEPS_NOT_RUN'],
  });
}

const PROGRESS = {
  phase: 'ordering',
  kind: 'tags',
  requestsDone: 12,
  requestsPlanned: 23,
  pairsJudged: 640,
  pairsTotal: 1187,
  tokens: 76000,
  estimatedTokens: 110000,
  tokenBudget: 120000,
  elapsedMs: 190000,
  etaMs: 180000,
  requestPairs: 50,
  requestAnswers: 21,
  requestTokens: 8900,
  thinking: true,
  tally: { split: 812, merge: 96, delete: 37, keep: 40, unsure: 3 },
  requestLog: [
    {
      index: 12,
      kind: 'tags',
      items: 50,
      answers: 50,
      tokens: 6100,
      thinkingTokens: 3800,
      ms: 44000,
      outcome: 'answered',
    },
    {
      index: 11,
      kind: 'tags',
      items: 50,
      answers: 31,
      tokens: 5200,
      thinkingTokens: 0,
      ms: 51000,
      outcome: 'partial',
    },
    {
      index: 9,
      kind: 'tags',
      items: 50,
      answers: 0,
      tokens: 7100,
      thinkingTokens: 7100,
      ms: 112000,
      outcome: 'empty',
    },
    {
      index: 8,
      kind: 'tags',
      items: 50,
      answers: 0,
      tokens: 0,
      thinkingTokens: 0,
      ms: 3000,
      outcome: 'failed',
    },
    {
      index: 1,
      kind: 'names',
      items: 300,
      answers: 300,
      tokens: 1400,
      thinkingTokens: 0,
      ms: 60000,
      outcome: 'answered',
    },
    {
      index: 7,
      kind: null,
      items: 50,
      answers: 50,
      tokens: 900,
      thinkingTokens: 0,
      ms: 9000,
      outcome: 'answered',
    },
  ],
};

test('The steps of an order: the vocabulary, the sort, the result', () => {
  const { runSteps } = running();
  const run = {
    task: 'order',
    keepsVocabulary: false,
    seen: new Set(['starting', 'vocabulary', 'ordering']),
    finishing: null,
  };
  const steps = runSteps(run, {
    phase: 'ordering',
    requestsDone: 4,
    requestsPlanned: 11,
  });
  assert.deepStrictEqual(
    steps.map((step) => step.key),
    ['vocabulary', 'ordering', 'finishing'],
    'the order never measures the model, so that step is left out'
  );
  assert.strictEqual(steps[1].sub, 'request 5 of 11');
  assert.ok(!('sub' in steps[0]) && !('sub' in steps[2]));
  const states = ASSIST.stepStates(steps, 'ordering');
  assert.deepStrictEqual(
    states.map((step) => step.state),
    ['done', 'now', 'next']
  );
  const strip = ASSIST.htmlSteps(states);
  assert.ok(
    strip.includes('Propose a vocabulary') && strip.includes('Sort every tag')
  );
  assert.ok(
    strip.includes('<span class="zr-steps__sub">· request 5 of 11</span>')
  );
  // Keeping the vocabulary drops its step.
  assert.deepStrictEqual(
    runSteps({ ...run, keepsVocabulary: true }, { phase: 'ordering' }).map(
      (step) => step.key
    ),
    ['ordering', 'finishing']
  );
  // A step the run did report is drawn.
  assert.ok(
    runSteps({ ...run, seen: new Set(['warming-up']) }, { phase: 'ordering' })
      .map((step) => step.key)
      .includes('warming-up')
  );
  // The step after the run says how many proposals are ticked.
  const ticking = runSteps(
    { ...run, finishing: { done: 412, total: 945 } },
    { phase: 'finishing' }
  );
  assert.strictEqual(ticking[2].sub, '412 of 945 ticked');
  // The other jobs of the page are one step each and show none.
  ['vocabulary', 'splits', 'apply'].forEach((task) => {
    assert.deepStrictEqual(
      runSteps({ ...run, task }, { phase: 'ordering' }),
      []
    );
  });
  const meter = functionBody('renderRunMeter');
  assert.ok(meter.includes('htmlSteps(') && meter.includes('stepStates('));
  assert.ok(meter.includes('htmlRunSentence(state)'));
});

test('The sentence says what happens now and why, and the tally as it grows', () => {
  const { htmlRunSentence, tallyText } = running();
  const guide = SIMPLIFY_GUIDE.phases.ordering;
  assert.strictEqual(
    htmlRunSentence(PROGRESS),
    `<p class="zr-runmeter__sentence">${escForTest(`${guide.what} ${guide.why} 812 split · 96 merge · 37 delete · 40 keep · 3 unsure so far.`)}</p>`
  );
  assert.strictEqual(
    htmlRunSentence({ phase: 'ordering', tally: null }),
    `<p class="zr-runmeter__sentence">${escForTest(`${guide.what} ${guide.why}`)}</p>`,
    'before the model answered there is no tail'
  );
  const vocab = SIMPLIFY_GUIDE.phases.vocabulary;
  assert.strictEqual(
    htmlRunSentence({ phase: 'vocabulary', tally: PROGRESS.tally }),
    `<p class="zr-runmeter__sentence">${escForTest(`${vocab.what} ${vocab.why}`)}</p>`
  );
  assert.strictEqual(
    htmlRunSentence({ phase: 'finishing' }),
    `<p class="zr-runmeter__sentence">${escForTest(SIMPLIFY_GUIDE.phases.finishing.what)}</p>`
  );
  assert.strictEqual(tallyText(null), '');
  assert.strictEqual(
    tallyText({ split: 1812, merge: 0, delete: 2, keep: 5, unsure: 1 }),
    // keep is named too: a run that only keeps is not an empty run
    '1,812 split · 0 merge · 2 delete · 5 keep · 1 unsure'
  );
});

test('The meter keeps its shape: bar, ledger with the tally, token legend', () => {
  const {
    htmlRunbar,
    htmlRunLedger,
    runCeilingText,
    htmlTokenbar,
    tokenSplit,
  } = running();
  assert.ok(htmlRunbar(PROGRESS).includes('Request 13 of 23'));
  assert.ok(htmlRunbar(PROGRESS).includes('~3 min left'));
  const ledger = htmlRunLedger(PROGRESS);
  assert.ok(ledger.includes('>640 of 1187</span> tags'));
  assert.ok(
    ledger.includes(
      '<span class="zr-ledger__value">812 split · 96 merge · 37 delete · 40 keep · 3 unsure</span> so far'
    )
  );
  assert.ok(ledger.includes('76k of ~110k'));
  assert.ok(
    htmlRunLedger({ ...PROGRESS, phase: 'finishing' }).includes(
      '</span> by the model'
    ),
    'after the run the tally is no longer "so far"'
  );
  assert.ok(!htmlRunLedger({ ...PROGRESS, tally: null }).includes('so far'));
  assert.strictEqual(runCeilingText(PROGRESS), '76k of 120k limit');
  // The legend reads read, written, thinking.
  const bar = htmlTokenbar(
    tokenSplit({ prompt: 13000, completion: 4200, thinking: 1000 })
  );
  assert.ok(bar.includes('>13k read<'));
  assert.ok(bar.includes('>3.2k written<'));
  assert.ok(bar.includes('>1k thinking<'));
  assert.ok(!bar.includes('question') && !bar.includes('answer<'));
  // An apply counts the tags it writes.
  const apply = htmlRunbar({
    phase: 'applying',
    requestsPlanned: 0,
    pairsTotal: 945,
    pairsJudged: 12,
  });
  assert.ok(apply.includes('Tag 13 of 945') && apply.includes('933 left'));
});

test('Every request row is worded by what it was about', () => {
  const { reqlogText, reqlogCost, htmlLiveRequest } = running();
  const [answered, partial, empty, broken, names, items] = PROGRESS.requestLog;
  assert.strictEqual(
    reqlogText(answered),
    'Request 12 · 50 tags · 50 answered'
  );
  assert.strictEqual(
    reqlogText(partial),
    'Request 11 · 50 tags · 31 answered · the rest asked again'
  );
  assert.strictEqual(
    reqlogText(empty),
    'Request 9 · 7.1k thinking · no answer'
  );
  assert.strictEqual(
    reqlogText(broken),
    'Request 8 · 50 tags · ended by the provider'
  );
  assert.strictEqual(reqlogText(names), 'Request 1 · 300 names read');
  assert.strictEqual(
    reqlogText({ ...names, answers: 120, outcome: 'partial' }),
    'Request 1 · 300 names read · 120 proposed'
  );
  assert.strictEqual(reqlogText(items), 'Request 7 · 50 items · 50 answered');
  assert.ok(
    !reqlogText({ ...answered, outcome: 'partial' }).includes('asked again'),
    'the rest is asked again only when fewer came back than were asked'
  );
  assert.strictEqual(reqlogCost(answered), '6.1k · 3.8k thinking');
  assert.strictEqual(reqlogCost(empty), '7.1k · all thinking');
  assert.strictEqual(reqlogCost(broken), '0 tokens');
  // The request in flight, by the same words.
  assert.ok(
    htmlLiveRequest(PROGRESS).includes('Request 13 · 50 tags · 21 answered')
  );
  assert.ok(htmlLiveRequest(PROGRESS).includes('8.9k so far · thinking'));
  assert.ok(
    htmlLiveRequest({
      ...PROGRESS,
      phase: 'vocabulary',
      requestPairs: 300,
    }).includes('Request 13 · 300 names')
  );
  assert.ok(
    htmlLiveRequest({ ...PROGRESS, kind: null }).includes(
      'Request 13 · 50 items · 21 answered'
    )
  );
});

test('A request row takes as long as the Duplicates page says it does', () => {
  const kit = helpers([...RUNNING, 'requestTime', 'htmlReqLog'], {
    constants: ['CEILING_SHOWN_ABOVE', 'JOB_TASKS', 'STEPS_NOT_RUN'],
  });
  assert.strictEqual(kit.requestTime(2000), '2 s');
  assert.strictEqual(kit.requestTime(59400), '59 s');
  assert.strictEqual(kit.requestTime(84000), '1:24');
  const row = kit.htmlReqLog([
    { index: 3, kind: 'tags', items: 3, answers: 3, tokens: 1, ms: 2000 },
  ]);
  assert.ok(row.includes('>2 s<'), 'the row counts seconds as "2 s"');
  assert.ok(row.includes('>1 token<'), 'one token is one token');
  // The legend names all three, a zero included.
  const bar = kit.htmlTokenbar(
    kit.tokenSplit({ prompt: 908, completion: 118, thinking: 0 })
  );
  assert.ok(bar.includes('>908 read<') && bar.includes('>118 written<'));
  assert.ok(bar.includes('>0 thinking<'), 'the zero of thinking is left out');
});

test('An order stopped early says so in the assistant, with what it left', () => {
  const { htmlStopNotice } = helpers(
    ['num', 'plural', 'grouped', 'htmlAlert', 'htmlStopNotice'],
    {}
  );
  const job = (over) => ({
    stopReason: 'user',
    progress: {
      requestsDone: 4,
      requestsPlanned: 5,
      pairsTotal: 25,
      pairsJudged: 20,
      tokenBudget: 200000,
    },
    ...over,
  });
  const user = htmlStopNotice(job());
  assert.ok(
    user.includes('zr-alert--warn') && user.includes('>Stopped early<')
  );
  assert.ok(user.includes('Stopped after 4 of 5 requests · 5 tags not asked'));
  assert.ok(
    htmlStopNotice(job({ stopReason: 'token-budget' })).includes(
      'Stopped at the 200k limit after 4 requests · 5 tags not asked'
    )
  );
  assert.ok(
    htmlStopNotice(job({ stopReason: 'idle' })).includes(
      'Stopped · no page was watching · 5 tags not asked'
    )
  );
  // Stopped in the vocabulary pass: no tag was counted yet.
  assert.ok(
    htmlStopNotice({
      progress: { requestsDone: 1, requestsPlanned: 1 },
    }).includes('Stopped after 1 of 1 request<')
  );
  // Both ways of following an order put it where the result is read.
  ['runOrderJob', 'reattachJob'].forEach((name) => {
    assert.ok(
      functionBody(name).includes('htmlStopNotice(ended)'),
      `${name} does not say that the run stopped`
    );
  });
});

test('The apply dialog is titled with the button that was pressed', () => {
  const all = functionBody('applyAllAccepted');
  assert.ok(
    all.includes(
      'title: applyLabel({ tags: list.length, writes: planWrites(list).writes })'
    )
  );
});

test('The headline has no subject, and Stop is one word', () => {
  const { phaseHeadline } = running();
  [
    'starting',
    'warming-up',
    'vocabulary',
    'ordering',
    'splitting',
    'applying',
    'finishing',
  ].forEach((phase) => {
    const line = phaseHeadline({ phase });
    assert.ok(!/\bI\b|\byou\b/i.test(line), `${phase}: ${line}`);
    assert.ok(!/[\u2013\u2014]/.test(line));
  });
  const stop = elementAt(
    page,
    page.indexOf('<button class="zr-btn" id="simStopBtn"')
  );
  assert.ok(stop.includes('>Stop</span>'));
  assert.ok(!stop.includes('zr-btn__sub'));
  // A run keeps its cost for the result only when it is an order.
  const outcome = functionBody('renderProgressOutcome');
  assert.ok(outcome.includes('!== JOB_TASKS.ORDER) return'));
  assert.ok(outcome.includes('keepRunCost(finished)'));
});

/* --- 8. the sheet ----------------------------------------------------------- */

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
    '1,145 of 1,187 tags · 23 requests · 42 by rule'
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
  const one = sheetModel(
    normaliseEstimate(ESTIMATE),
    { ...levers, lanes: 1 },
    false
  );
  assert.strictEqual(
    one.seconds,
    540,
    'the lanes change the time, not the work'
  );
  assert.strictEqual(one.requests, 23);
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
  assert.strictEqual(switches[0].price, '−2 requests · −9.6k');
  assert.strictEqual(switches[1].price, '−6 requests · −29k');
  assert.strictEqual(switches[2].price, '', 'the vocabulary switch has none');
  assert.strictEqual(leverPrice(estimate, 5, false), '');
  const bare = sheetSwitches(
    normaliseEstimate({
      ...ESTIMATE,
      skippable: { decided: 0, lowDocument: 0 },
    }),
    levers,
    false
  );
  assert.deepStrictEqual(bare, []);
  switches.forEach((lever) => {
    assert.ok(!/[\u2013\u2014]/.test(lever.price + lever.label));
  });
});

test('Keep vocabulary is a lever of the sheet, and only there', () => {
  const ask = functionBody('askPreflight');
  assert.ok(
    ask.includes('const keepOffer = vocabularySaved && forceKeep !== true'),
    'offered whenever a vocabulary is saved, unless the run keeps it anyway'
  );
  assert.ok(
    ask.includes("if (id === 'keepVocabulary') runLevers.keepVocabulary = on")
  );
  assert.ok(
    !VIEW.includes('simOrderKeepVocabulary') &&
      !VIEW.includes('Keep vocabulary')
  );
  assert.ok(
    functionBody('renderVocabularyState').includes(
      'runLevers.keepVocabulary ='
    ),
    'it comes up on when any of the saved vocabulary was written by hand'
  );
  assert.ok(
    functionBody('proposeOrder').includes('runLevers.keepVocabulary === true')
  );
  assert.ok(functionBody('repropose').includes('await askPreflight(true)'));
  // The order row's own button is the assistant's now.
  assert.ok(
    !VIEW.includes('simOrderBtn') && !VIEW.includes('Propose a new order')
  );
});

test('The sheet is the kernel dialog, and every lever fetches a fresh estimate', () => {
  const ask = functionBody('askPreflight');
  assert.ok(ask.includes('confirmDialog({'));
  assert.ok(ask.includes("title: 'Simplify tags'"));
  assert.ok(ask.includes('html: htmlSheet(model())'));
  assert.ok(ask.includes("confirmLabel: 'Start'"));
  assert.ok(ask.includes("cancelLabel: 'Cancel'"));
  assert.ok(ask.includes("className: 'zr-dialog--sheet'"));
  assert.ok(ask.includes('bindSheet(dialog, {'));
  assert.ok(
    ask.includes('await fetchOrderEstimate(keepFor())') &&
      ask.includes('updateSheet(dialog, model())')
  );
  assert.ok(ask.includes('ticket !== asked'));
  assert.ok(ask.includes('unbind()'));
  const html = SHEET.htmlSheet(
    sheetHelpers().sheetModel(
      sheetHelpers().normaliseEstimate(ESTIMATE),
      { skipDecided: true, minDocuments: 1, lanes: 3, keepVocabulary: false },
      true
    )
  );
  assert.ok(html.includes('data-switch="skipDecided" checked'));
  assert.ok(html.includes('data-switch="keepVocabulary">'));
  assert.ok(html.includes('Nothing is written.'));
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
  assert.strictEqual((await localOrderEstimate()).items, 100);
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
  const bar = htmlStackBar(4, 16);
  assert.ok(bar.includes('class="zr-runbar"'));
  assert.ok(bar.includes('Tag 5 of 16') && bar.includes('12 left'));
  assert.ok(!bar.includes('clear'), 'no "Accept the clear ones" on this page');
  assert.ok(!SCRIPT.includes('sim-stack-acceptclear'));
  const card = htmlDecision(FIXTURE[6], ['Rechnung', 'Abrechnung']);
  assert.ok(card.includes('class="zr-decision"'));
  assert.ok(card.includes('>As it is<') && card.includes('>Becomes<'));
  assert.ok(card.includes('<option value="Abrechnung" selected>'));
  assert.ok(
    card.includes(
      '19 writes · type on 9 documents · topics on 9 documents · tag deleted'
    )
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
  const foot = htmlStackFoot(3, { tagName: 'Stromrechnung' });
  assert.ok(
    foot.includes('>3 decided<') && foot.includes('>Undo Stromrechnung<')
  );
  assert.ok(foot.includes('>Back<'));
});

test('The stack opens over the unsure proposals and every decision is a status', () => {
  const { unsureOpen } = result();
  assert.deepStrictEqual(
    unsureOpen(landed()).map((row) => row.tagId),
    [6, 7],
    'the unsure ones nobody decided on, the ones on the most documents first'
  );
  const open = functionBody('openStack');
  assert.ok(open.includes('unsureOpen([...proposals.values()])'));
  assert.ok(
    open.includes('stacking = true') && open.includes('renderAssist()')
  );
  assert.ok(open.includes('el.stack.focus()'));
  assert.ok(functionBody('closeStack').includes('stacking = false'));
  const decide = functionBody('decideOnStack');
  assert.ok(decide.includes("{ action: 'keep', status: 'accepted' }"));
  assert.ok(decide.includes("{ status: 'accepted' }"));
  assert.ok(decide.includes('await refreshGroups()'), 'the groups follow');
  assert.ok(!decide.includes('/api/simplify/apply'), 'the stack writes no tag');
  assert.ok(
    functionBody('undoLastDecision').includes(
      'await patchProposal(tagId, before)'
    )
  );
});

test('The keys are bound on the stack and never inside a field', () => {
  const init = functionBody('initStack');
  assert.ok(init.includes("el.stack.addEventListener('keydown'"));
  const guard = init.indexOf('EDITABLE_TAGS.includes');
  [
    "event.key === 'Enter'",
    "event.key === 'Escape'",
    "event.key === 'l'",
  ].forEach((needle) => {
    assert.ok(init.indexOf(needle) > guard, `${needle} after the field guard`);
  });
});

/* --- 10. the apply ---------------------------------------------------------- */

test('The apply is a checklist in the order the job writes, and leaves its Undo', () => {
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
    [3, 4, 1, 5]
  );
  rows[3].state = 'failed';
  rows[3].error = '400 Bad Request';
  const html = htmlChecklist(rows);
  assert.ok(html.includes('0 of 4 done · 1 failed · 118 writes'));
  assert.ok(html.includes('sim-checklist-retry') && html.includes('>Retry<'));
  const apply = functionBody('applyOrder');
  assert.ok(apply.includes('checklistRows = checklistFrom('));
  assert.ok(
    apply.includes('if (failures === 0) {'),
    'a clean apply leaves its one line, not every row'
  );
  const { htmlApplyResultBlock } = helpers(
    ['applyResultText', 'htmlApplyResultBlock'],
    { constants: ['UNDO_HREF'] }
  );
  const block = htmlApplyResultBlock({
    applied: [{ tagId: 1, action: 'split' }],
    merged: [],
    failed: [],
  });
  assert.ok(
    block.includes(
      '<a class="zr-btn sim-apply-result__undo" href="/duplicates#dupLog">Undo</a>'
    ),
    'the Undo lands on the merge log of the Duplicates page'
  );
  assert.ok(
    !htmlApplyResultBlock({
      applied: [],
      merged: [],
      failed: [{ tagId: 2 }],
    }).includes('Undo'),
    'nothing written, nothing to undo'
  );
});

/* --- 11. the page stylesheet ------------------------------------------------ */

test('The page places the kit rather than redefining it', () => {
  assert.strictEqual((PAGE_CSS.match(/@layer [a-z]+ \{/g) || []).length, 1);
  assert.ok(PAGE_CSS.includes('@layer pages {'));
  const redefined = [
    '.zr-assist',
    '.zr-steps',
    '.zr-runmeter',
    '.zr-runmeter__sentence',
    '.zr-workspace--waiting',
    '.zr-workspace__note',
    '.zr-module__caption',
    '.zr-sheet',
    '.zr-decision',
    '.zr-tokenbar',
    '.zr-runbar',
    '.zr-reqlog',
    '.zr-ledger',
  ].filter((selector) =>
    new RegExp(
      `\\n\\s+${selector.replace(/[.-]/g, (c) => `\\${c}`)}( |,|\\n)`
    ).test(PAGE_CSS)
  );
  assert.deepStrictEqual(
    redefined,
    [],
    `the kit belongs to css/review; the page may only place it: ${redefined.join(', ')}`
  );
  [
    '.sim-page',
    '.sim-assist',
    '.sim-stack',
    '.sim-checklist',
    '.sim-progress',
  ].forEach((selector) => {
    assert.ok(PAGE_CSS.includes(`${selector} {`), `${selector} has no rule`);
  });
  // 390px: the assistant stacks; the kit does that for both pages.
  assert.match(
    KIT,
    /@media \(max-width: 720px\) \{\n[\s\S]*?\.zr-assist \{\n\s+flex-direction: column;/
  );
  assert.ok(!PAGE_CSS.includes('data-mode') && !PAGE_CSS.includes('sim-list'));
});

/* --- 12. the voice ---------------------------------------------------------- */

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
  // Every string the assistant draws comes from the guide or is a label.
  [
    SIMPLIFY_GUIDE.start.title,
    SIMPLIFY_GUIDE.start.what,
    ...SIMPLIFY_GUIDE.done.next,
  ].forEach((line) => {
    assert.ok(
      !SCRIPT.includes(line),
      `the page copies a line of the guide: ${line}`
    );
  });
});

test('Every action is a bordered button, never a text button or a bare link', () => {
  const modules = [
    read('public', 'js', 'modules', 'review-sheet.js'),
    read('public', 'js', 'modules', 'review-assist.js'),
  ].join('\n');
  for (const [name, text] of [
    ['view', VIEW],
    ['script', SCRIPT],
    ['modules', modules],
  ]) {
    assert.ok(!text.includes('zr-btn--ghost'), `a text button in the ${name}`);
  }
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
