/**
 * Test: simplify-assistant-ui
 *
 * The Simplify tags page as an assistant rather than a control panel: the
 * proposal read as baskets, one decision at a time where the model was unsure,
 * and the cost of a run said out loud before, during and after it.
 *
 * What is checked here at contract level is the ground both page scripts
 * stand on — the shared stylesheet is linked, layered and complete. The page's
 * own surfaces are checked below that as they are built.
 *
 * Covers:
 *  1. the shell links css/review.css, and the kit is one @layer components
 *     block that paints with tokens rather than hex codes
 *  2. the classes both pages agree on exist
 *  3. the kit works at phone width
 *  4. the view carries the plan, the stack and the run meter, and the segment
 *     opens on the plan
 *  5. the four baskets, including the two that are empty
 *  6. one sentence per action, with the names in bold and the evidence behind
 *     the dash
 *  7. the stack: its bar, its decision card, its three buttons and its keys
 *  8. the preflight: four numbered steps with their prices, the ledger with
 *     the token split, the free consequence, the levers — and the levers
 *     moving the numbers
 *  9. the run meter reading a progress fixture, request log with an `empty`
 *     row included
 * 10. the consequence of every button that writes, and the apply checklist
 * 11. the page stylesheet places the kit rather than redefining it
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

/* One helper of the page is async, so its case is too. The runner of this
   repository is synchronous, so the promises are collected here and the
   report waits for them. */
const pending = [];

function testAsync(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => {
        console.log(`✅  ${name}`);
        passed++;
      })
      .catch((error) => {
        console.error(`❌  ${name}`);
        console.error(`    ${error.message}`);
        failed++;
      })
  );
}

const ROOT = process.cwd();
const VIEWS = path.join(ROOT, 'views');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const HEAD = read('views', 'partials', 'shell', 'head-start.ejs');
const CSS = read('public', 'css', 'review.css');
const PAGE_CSS = read('public', 'css', 'pages', 'simplify.css');
const SCRIPT = read('public', 'js', 'simplify.js');

test('The shell links the review kit', () => {
  assert.ok(
    HEAD.includes('href="/css/review.css"'),
    'head-start.ejs does not link css/review.css'
  );
  assert.ok(
    HEAD.indexOf('href="/css/tokens.css"') <
      HEAD.indexOf('href="/css/review.css"'),
    'tokens.css declares the layer order and has to come first'
  );
});

test('The kit is one layered block and paints with tokens', () => {
  assert.strictEqual(
    (CSS.match(/@layer [a-z]+ \{/g) || []).length,
    1,
    'stylelint scopes its duplicate checks per layer block, so keep one'
  );
  assert.ok(
    CSS.includes('@layer components {'),
    'the kit belongs in components, under the page stylesheets'
  );
  const hex = CSS.match(/:\s*#[0-9a-f]{3,8}\b/gi) || [];
  assert.deepStrictEqual(
    hex,
    [],
    `the kit has to use tokens so both themes follow: ${hex.join(', ')}`
  );
});

test('The classes both pages build on are there', () => {
  [
    '.zr-ledger',
    '.zr-ledger__value',
    '.zr-tokenbar__track',
    '.zr-tokenbar__seg--prompt',
    '.zr-tokenbar__seg--answer',
    '.zr-tokenbar__seg--thinking',
    '.zr-basket',
    '.zr-basket--ask',
    '.zr-basket__line',
    '.zr-basket__sentence',
    '.zr-decision',
    '.zr-decision__sides',
    '.zr-decision__side--from',
    '.zr-decision__note',
    '.zr-decision__actions',
    '.zr-consequence',
    '.zr-consequence--free',
    '.zr-runbar__fill',
    '.zr-reqlog__row--warn',
    '.zr-btn--stacked',
    '.zr-btn__sub',
  ].forEach((selector) => {
    assert.ok(
      CSS.includes(`${selector} {`) || CSS.includes(`${selector},`),
      `${selector} has no rule of its own`
    );
  });
});

test('A decision card works at phone width', () => {
  assert.match(
    CSS,
    /@media \(max-width: 720px\) \{[\s\S]*\.zr-decision__sides \{\s+flex-direction: column;/,
    'the two sides of a decision have to stack on a phone'
  );
  assert.match(
    CSS,
    /\.zr-decision__keys \{\s+display: none;/,
    'keyboard hints on a phone are a lie'
  );
});

/* ── the page, rendered through the real shell ────────────────────────────── */

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

const page = renderSync(
  'simplify.ejs',
  Object.assign({}, LOCALS, { aiReviewEnabled: true })
);

test('The view opens on the plan and carries the stack and the run meter', () => {
  [
    'simPlan',
    'simPlanHead',
    'simBaskets',
    'simStack',
    'simStackBar',
    'simStackCard',
    'simStackFoot',
    'simGroupsBlock',
    'simRunbar',
    'simRunLedger',
    'simRunTokens',
    'simRunLive',
    'simReqLog',
    'simStopSub',
    'simApplyChecklist',
    'simApplyAcceptedSub',
  ].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
    assert.ok(
      SCRIPT.includes(`'${id}'`) || SCRIPT.includes(`"${id}"`),
      `#${id} is in the view but the page script never reads it`
    );
  });

  // The segment is Plan and Table now; the data name of the first position is
  // what round 12 left it, so every route and test that knows it still works.
  assert.match(
    page,
    /<button type="button" data-view="groups" aria-selected="true">Plan<\/button>/,
    'the first position of the segment is the plan'
  );
  assert.ok(
    page.indexOf('id="simPlan"') < page.indexOf('id="simGroupsBlock"'),
    'the plan comes first; the group cards wait behind a summary'
  );
  assert.match(
    page,
    /<details class="sim-groupsblock" id="simGroupsBlock">/,
    "round 12's cards are one step back, not gone"
  );
  // The stack is a mode: it starts hidden and replaces the baskets in place.
  assert.match(
    page,
    /class="sim-stack hidden" id="simStack"/,
    'the stack must come up hidden'
  );
  assert.match(
    page,
    /id="simStack"[^>]*tabindex="-1"/,
    'the stack takes the focus so its keys can be bound on it'
  );
  // The Stop button says what stopping keeps.
  assert.match(
    page,
    /id="simStopBtn"[\s\S]{0,260}zr-btn__sub" id="simStopSub"/,
    'the stop button carries its own second line'
  );
});

/* ── the helpers, taken out of the module ─────────────────────────────────── */

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

/** A top-level `const NAME = …;`, whatever shape its value has. */
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

/**
 * The named helpers of the page script, evaluated out of their module. Only
 * pure functions can be taken this way, which is why everything the plan, the
 * stack and the cost layer decide is written as a pure function.
 */
function helpers(names, extra = {}) {
  const constants = (extra.constants || []).map(constantSource).join('\n');
  const source = names.map(functionSource).join('\n');
  const globals = Object.assign({ esc: escForTest }, extra.globals || {});
  const keys = Object.keys(globals);
  return new Function(
    ...keys,
    `${constants}\n${source}\nreturn { ${names.join(', ')} };`
  )(...keys.map((key) => globals[key]));
}

/** Everything the sentence, basket and ledger helpers stand on. */
const BASE = [
  'num',
  'plural',
  'grouped',
  'htmlIconMarkup',
  'documentsText',
  'formatTokens',
  'formatElapsed',
  'formatRunTime',
  'tokenShares',
  'tokenSplit',
  'htmlLedger',
  'htmlTokenbar',
  'htmlConsequence',
  'planWrites',
];

/* ── the fixture: one proposal per action, both confidences ───────────────── */

const FIXTURE = [
  {
    tagId: 1,
    tagName: 'Stromrechnung',
    action: 'split',
    source: 'rule',
    confidence: null,
    documentCount: 42,
    documentsWithType: 3,
    overwriteType: false,
    typeName: 'Rechnung',
    topicNames: ['Strom'],
    reason: 'compound of a known type and a known topic',
    status: 'open',
  },
  {
    tagId: 2,
    tagName: 'Autoversicherung',
    action: 'split',
    source: 'model',
    confidence: 'high',
    documentCount: 13,
    documentsWithType: 4,
    overwriteType: false,
    typeName: 'Versicherung',
    topicNames: ['Auto'],
    reason: 'the model read it as a type plus a topic',
    status: 'open',
  },
  {
    tagId: 3,
    tagName: 'Kirchenaustrittserklärung',
    action: 'split',
    source: 'model',
    confidence: 'low',
    documentCount: 3,
    documentsWithType: 0,
    overwriteType: false,
    typeName: 'Brief',
    topicNames: ['Kirchenaustritt'],
    reason: 'A Brief about Kirchenaustritt, or the same thing as that tag?',
    status: 'open',
  },
  {
    tagId: 4,
    tagName: 'Wichtig',
    action: 'keep',
    source: 'rule',
    confidence: null,
    documentCount: 91,
    documentsWithType: 0,
    overwriteType: false,
    typeName: null,
    topicNames: [],
    reason: 'not a compound',
    status: 'open',
  },
  {
    tagId: 5,
    tagName: 'Amazon.de',
    action: 'merge',
    source: 'model',
    confidence: 'high',
    documentCount: 7,
    documentsWithType: 0,
    overwriteType: false,
    mergeInto: 'Amazon',
    typeName: null,
    topicNames: [],
    reason: 'the same shop, spelled with its domain',
    status: 'open',
  },
  {
    tagId: 6,
    tagName: 'zz-alt',
    action: 'delete',
    source: 'model',
    confidence: 'high',
    documentCount: 2,
    documentsWithType: 0,
    overwriteType: false,
    typeName: null,
    topicNames: [],
    reason: 'left over from an import',
    status: 'open',
  },
  {
    tagId: 7,
    tagName: 'Schon erledigt',
    action: 'split',
    source: 'model',
    confidence: 'high',
    documentCount: 5,
    documentsWithType: 0,
    overwriteType: false,
    typeName: 'Rechnung',
    topicNames: [],
    reason: 'already applied, so out of the plan',
    status: 'applied',
  },
];

/* ── 5. the four baskets ──────────────────────────────────────────────────── */

test('A plan is four baskets, and an empty one is not rendered at all', () => {
  const { planBaskets, htmlBasket } = helpers(
    [
      ...BASE,
      'planBaskets',
      'askChoices',
      'askQuestion',
      'htmlProposalSentence',
      'htmlBasket',
    ],
    {
      constants: [
        'BASKET_TITLES',
        'BASKET_NOTES',
        'BASKET_MARKS',
        'BASKET_ICONS',
        'BASKET_LINES',
      ],
    }
  );

  const baskets = planBaskets(FIXTURE);
  assert.deepStrictEqual(
    baskets.rule.map((row) => row.tagId),
    [1],
    'a rule proposal that does something belongs in the first basket'
  );
  assert.deepStrictEqual(
    baskets.sure.map((row) => row.tagId),
    [2, 5, 6],
    'what the model was sure of, whatever the action'
  );
  assert.deepStrictEqual(
    baskets.ask.map((row) => row.tagId),
    [3],
    'and the low-confidence one is the only question'
  );
  assert.deepStrictEqual(
    baskets.keep.map((row) => row.tagId),
    [4],
    'a tag that stays is a basket of its own, whoever proposed it'
  );
  // A proposal that has been applied or dropped is not part of the plan.
  const seen = [
    ...baskets.rule,
    ...baskets.sure,
    ...baskets.ask,
    ...baskets.keep,
  ].map((row) => row.tagId);
  assert.ok(!seen.includes(7), 'an applied proposal is out of the plan');
  assert.strictEqual(
    new Set(seen).size,
    seen.length,
    'every proposal lands in exactly one basket'
  );

  // The empty ones render nothing at all — not an empty card.
  assert.strictEqual(
    htmlBasket('ask', [], { open: true, full: false }),
    '',
    'an empty basket is not a card that says nothing'
  );
  assert.strictEqual(htmlBasket('keep', null, {}), '');

  // Clear as day: collapsed, one line, and the button that opens it.
  const rule = htmlBasket('rule', baskets.rule, { open: false, full: false });
  assert.ok(
    rule.includes('Clear as day — 1 tag'),
    'the title says what it is and how many'
  );
  assert.ok(
    rule.includes('class="zr-btn zr-btn--ghost sim-basket-toggle"') &&
      rule.includes('>Show them<'),
    'a collapsed basket offers to be opened'
  );
  assert.ok(
    !rule.includes('sim-basket-drop'),
    'a collapsed basket writes no lines yet'
  );
  assert.ok(
    rule.includes('No model was asked about these'),
    'the note says why these were free'
  );

  // The model is sure: one line per proposal, each with its quiet way out.
  const sure = htmlBasket('sure', baskets.sure, { open: true, full: false });
  assert.strictEqual(
    (sure.match(/class="zr-basket__line"/g) || []).length,
    3,
    'one line per proposal'
  );
  assert.strictEqual(
    (sure.match(/sim-basket-drop/g) || []).length,
    3,
    '"Not this one" is at the end of every line and opens nothing'
  );
  assert.ok(sure.includes('>Not this one<'), 'and it is worded quietly');

  // The cap, and the way past it.
  const many = Array.from({ length: 82 }, (unused, at) =>
    Object.assign({}, FIXTURE[1], { tagId: 100 + at })
  );
  const capped = htmlBasket('sure', many, { open: true, full: false });
  assert.strictEqual(
    (capped.match(/class="zr-basket__line"/g) || []).length,
    11,
    'ten sentences plus the line that offers the rest'
  );
  assert.ok(
    capped.includes('Read the other 72'),
    'and it says exactly how many are left'
  );
  const full = htmlBasket('sure', many, { open: true, full: true });
  assert.strictEqual(
    (full.match(/sim-basket-more/g) || []).length,
    0,
    'once it is read in full there is nothing left to offer'
  );

  // The ask basket: the amber edge, a question each, and answers as buttons.
  const ask = htmlBasket('ask', baskets.ask, { open: true, full: false });
  assert.ok(ask.includes('zr-basket--ask'), 'the bucket that asks is amber');
  assert.ok(
    ask.includes('class="zr-basket__question"'),
    'a question is not a line'
  );
  assert.ok(
    ask.includes('class="zr-basket__choices"'),
    'and it carries its answers'
  );
  assert.ok(
    ask.includes('Brief + Kirchenaustritt') && ask.includes('Leave it alone'),
    'the buttons are the answers themselves, not "edit"'
  );
  assert.ok(
    !/>\s*Edit\s*</.test(ask),
    'an answer is never a button that opens a form'
  );
  assert.ok(
    ask.includes('sim-stack-open') && ask.includes('One at a time'),
    'the ask basket is where the stack is reached from'
  );

  // Stays as it is: one quiet line with the count, nothing else.
  const keep = htmlBasket('keep', baskets.keep, { open: false, full: false });
  assert.ok(keep.includes('zr-basket--quiet'), 'the quiet basket is quiet');
  assert.ok(
    keep.includes('1 tag on 91 documents stay exactly as they are'),
    'it says how many and how big they are'
  );
  assert.ok(
    keep.includes('Nothing is written for them'),
    'and that they cost nothing'
  );
});

/* ── 6. the sentence ──────────────────────────────────────────────────────── */

test('Every action reads as a sentence, with the evidence behind the dash', () => {
  const { htmlProposalSentence } = helpers([...BASE, 'htmlProposalSentence']);

  const split = htmlProposalSentence(FIXTURE[0]);
  assert.ok(
    split.includes('<strong>Stromrechnung</strong>'),
    'the tag is the subject and it is bold'
  );
  assert.ok(
    split.includes(
      'becomes the type <strong>Rechnung</strong> plus the topic <strong>Strom</strong>'
    ),
    'the type and the topics are named, both bold'
  );
  assert.ok(
    split.includes('42 documents, 3 of them keep the type they already have'),
    'the evidence is the count and what stays as it is'
  );
  assert.ok(
    split.includes('class="zr-basket__aside"'),
    'and it is quieter than the sentence'
  );

  // Two topics read as a list, and an overwrite drops the "keep" clause.
  const two = htmlProposalSentence(
    Object.assign({}, FIXTURE[0], {
      topicNames: ['Strom', 'Haus'],
      overwriteType: true,
    })
  );
  assert.ok(
    two.includes(
      'plus the topics <strong>Strom</strong> and <strong>Haus</strong>'
    ),
    'two topics are "the topics A and B"'
  );
  assert.ok(
    !two.includes('keep the type they already have'),
    'nothing keeps its type once the overwrite is on'
  );

  assert.ok(
    htmlProposalSentence(FIXTURE[4]).includes(
      'is folded into <strong>Amazon</strong>'
    ),
    'a merge says where it goes'
  );
  assert.ok(
    htmlProposalSentence(FIXTURE[5]).includes(
      'is taken off its documents and deleted'
    ),
    'a delete says what happens to the documents too'
  );
  assert.ok(
    htmlProposalSentence(FIXTURE[3]).includes('stays as it is'),
    'and a keep says the shortest thing of all'
  );

  // A name is the user's and the model's, so it is escaped everywhere.
  const nasty = htmlProposalSentence(
    Object.assign({}, FIXTURE[0], { tagName: '<b>Strom</b>' })
  );
  assert.ok(nasty.includes('&lt;b&gt;Strom&lt;/b&gt;'));
  assert.ok(!nasty.includes('<b>'), 'a name must never reach the page as tags');
});

/* ── 7. the stack ─────────────────────────────────────────────────────────── */

test('The stack is one decision per screen, with its bar and its keys', () => {
  const { htmlStackBar, htmlDecision, htmlStackFoot } = helpers(
    [
      ...BASE,
      'consequenceText',
      'htmlSourceBadge',
      'htmlTypeSelect',
      'htmlTopicChips',
      'htmlStackBar',
      'htmlDecision',
      'htmlStackFoot',
    ],
    {
      constants: ['SOURCE_LABELS', 'SOURCE_TONES', 'GROUP_KIND_LABELS'],
    }
  );

  const bar = htmlStackBar(4, 16, 118);
  assert.ok(bar.includes('class="zr-runbar"'), 'the bar is the kit one');
  assert.ok(bar.includes('Tag 5 of 16'), 'it says where the stack is');
  assert.ok(bar.includes('12 left'), 'and how much of it is left');
  assert.ok(
    bar.includes('Take the 118 clear ones in one go'),
    'the one way out that is not a decision'
  );
  assert.ok(
    bar.includes('width: 25%'),
    'the fill is the share that is behind it'
  );

  const card = htmlDecision(FIXTURE[2], ['Rechnung', 'Brief']);
  assert.ok(card.includes('class="zr-decision"'), 'the card is the kit one');
  assert.ok(
    card.includes(
      'class="zr-decision__name zr-decision__name--from">Kirchenaustrittserkl'
    ),
    'the tag as it is stands on the left'
  );
  assert.ok(card.includes('3 documents'), 'with its document count');
  assert.ok(
    card.includes('class="zr-select sim-type"'),
    'the type is a select, limited to the vocabulary'
  );
  assert.ok(
    card.includes('<option value="Brief" selected>'),
    'and it opens on what the model proposed'
  );
  assert.ok(
    !card.includes('<option value="Versicherung"'),
    'a type outside the vocabulary is not on offer'
  );
  assert.ok(
    card.includes('sim-topics__input') && card.includes('zr-chip'),
    'the topics are chips plus an input'
  );
  assert.ok(
    card.includes('class="zr-decision__note">A Brief about Kirchenaustritt'),
    "the model's sentence is in its own note"
  );
  // The evidence and the choice it belongs to.
  assert.ok(
    card.includes('None of these 3 documents carries a document type yet'),
    'the evidence is how many already carry a type'
  );
  assert.strictEqual(
    (card.match(/type="radio" class="sim-stack-overwrite"/g) || []).length,
    2,
    'the overwrite choice is two radios, not a checkbox'
  );
  // The consequence, then the three buttons, then the keys.
  assert.ok(
    card.indexOf('zr-consequence') < card.indexOf('zr-decision__actions'),
    'the consequence stands directly above the buttons'
  );
  ['sim-stack-accept', 'sim-stack-keep', 'sim-stack-later'].forEach((name) => {
    assert.ok(card.includes(name), `the stack needs its ${name} button`);
  });
  assert.ok(
    card.includes('class="zr-decision__keys">Enter · Esc · L'),
    'and the keys that do the same'
  );
  assert.ok(
    card.includes('agreed now, written when you run the plan'),
    'the primary button says that it writes nothing yet'
  );

  const foot = htmlStackFoot(3, { tagName: 'Stromrechnung', word: 'agreed' });
  assert.ok(foot.includes('3 decisions so far'), 'the tally is in the footer');
  assert.ok(
    foot.includes('Nothing is written until you run the plan'),
    'and it says so again where it matters'
  );
  assert.ok(
    foot.includes('Undo — Stromrechnung was agreed'),
    'the last decision can be taken back'
  );
  assert.ok(
    !htmlStackFoot(0, null).includes('sim-stack-undo'),
    'with nothing decided there is nothing to undo'
  );
});

test('The keys are bound on the stack and never inside a field', () => {
  const init = functionBody('initPlan');
  assert.ok(
    init.includes("el.stack.addEventListener('keydown'"),
    'the keys belong to the stack container, not to the document'
  );
  assert.match(
    SCRIPT,
    /const EDITABLE_TAGS = \['input', 'select', 'textarea'\];/,
    'the three fields that keep every key for themselves'
  );
  assert.ok(
    init.includes(
      'EDITABLE_TAGS.includes(String(event.target.tagName).toLowerCase())'
    ),
    'a field with the focus must keep its keys'
  );
  const keys = init.indexOf('EDITABLE_TAGS.includes');
  [
    "event.key === 'Enter'",
    "event.key === 'Escape'",
    "event.key === 'l'",
  ].forEach((needle) => {
    assert.ok(init.includes(needle), `${needle} is not bound`);
    assert.ok(
      init.indexOf(needle) > keys,
      'every key is read after the field guard, never before'
    );
  });
  // Enter inside the topic input adds a topic; it is not a decision.
  assert.ok(
    init.includes(".closest('.sim-topics__input')"),
    'the topic input handles its own Enter first'
  );
  // Opening the stack hides the plan: it is a mode, not a page.
  const open = functionBody('openStack');
  assert.ok(
    open.includes("el.stack.classList.remove('hidden')") &&
      open.includes("el.plan.classList.add('hidden')"),
    'while the stack is open the baskets are gone'
  );
  assert.ok(open.includes('el.stack.focus()'), 'and it takes the focus');
  // Nothing in the stack writes to Paperless-ngx.
  const decide = functionBody('decideOnStack');
  assert.ok(
    decide.includes("{ action: 'keep', status: 'accepted' }") &&
      decide.includes("{ status: 'accepted' }"),
    'the stack calls the accept endpoint, nothing else'
  );
  assert.ok(
    !decide.includes('/api/simplify/apply'),
    'a decision never applies anything on its own'
  );
  assert.ok(
    decide.includes("decision === 'later'"),
    '"decide later" only moves the queue on'
  );
});

/* ── 8. the preflight ─────────────────────────────────────────────────────── */

const ESTIMATE = {
  tags: 1187,
  itemsByRule: 42,
  items: 1145,
  batchSize: 50,
  lanes: 3,
  requests: 23,
  seconds: 372,
  tokens: {
    total: 1410000,
    prompt: 46000,
    completion: 296000,
    thinking: 1068000,
  },
  basis: 'run',
  measuredAt: '2026-01-01T00:00:00Z',
  model: 'qwen3:30b',
  thinking: true,
  skippable: { decided: 312, lowDocument: 659 },
  lastRun: { requests: 23, seconds: 372 },
};

test('The preflight says what it does, what it costs and what it changes', () => {
  const { normaliseEstimate, htmlPreflight, preflightConfirmText, basisText } =
    helpers(
      [
        ...BASE,
        'normaliseEstimate',
        'basisText',
        'htmlPreflightSteps',
        'htmlPreflightLevers',
        'htmlPreflight',
        'preflightConfirmText',
      ],
      {
        constants: ['ESTIMATE_BASES', 'ORDER_BATCH_SIZE', 'LANE_CHOICES'],
        globals: {
          runLevers: { skipDecided: false, minDocuments: 1, lanes: 3 },
          MIN_DOCUMENTS_LEVER: 3,
        },
      }
    );

  const estimate = normaliseEstimate(ESTIMATE);
  const html = htmlPreflight(estimate);

  // Block 1: four numbered steps, each with its own price.
  assert.ok(html.includes('What I actually do'), 'the first block is missing');
  assert.strictEqual(
    (html.match(/class="sim-preflight__step"/g) || []).length,
    4,
    'four steps: reading, the rule pass, asking, folding'
  );
  assert.strictEqual(
    (html.match(/class="sim-preflight__price"/g) || []).length,
    4,
    'every step carries its own price'
  );
  assert.strictEqual(
    (html.match(/>no model</g) || []).length,
    2,
    'reading the tags and the rule pass ask no model'
  );
  assert.ok(html.includes('>free<'), 'and folding the answers costs nothing');
  assert.ok(
    html.includes('23 requests · 1.4M tokens'),
    'the one step that costs tokens says how many'
  );

  // Block 2: the ledger, the split bar and where the numbers come from.
  assert.ok(html.includes('What it costs'), 'the second block is missing');
  assert.ok(html.includes('class="zr-ledger"'), 'the numbers are a ledger');
  assert.ok(
    html.includes('class="zr-tokenbar__track"'),
    'and the tokens are split into three'
  );
  assert.ok(
    html.includes('zr-ledger__value--quiet">0</span> writes'),
    'nought writes is the point of the whole dialog'
  );
  assert.ok(
    html.includes('qwen3:30b'),
    'basis "run" names the run the numbers come from'
  );

  // Block 3: the sentence that makes the dialog worth having.
  assert.ok(html.includes('What it changes'), 'the third block is missing');
  assert.ok(
    html.includes('zr-consequence--free'),
    'and it is the free variant of the line'
  );
  assert.ok(
    html.includes('Nothing is written while this runs'),
    'word for word'
  );

  // The levers.
  assert.ok(
    html.includes('Cheaper, if you want'),
    'the lever block is missing'
  );
  assert.strictEqual(
    (html.match(/class="zr-check sim-lever"/g) || []).length,
    2,
    'two checkboxes: the decided ones and the small ones'
  );
  assert.ok(
    html.includes('Skip the 312 tags you have already decided'),
    'the first lever says how many it would leave out'
  );
  assert.ok(html.includes('leaves out 659'), 'and so does the second');
  assert.strictEqual(
    (html.match(/<option value="\d+"/g) || []).length,
    4,
    'the lanes select offers 1, 3, 5 and 8'
  );

  // The button carries the final numbers.
  assert.strictEqual(
    preflightConfirmText(estimate),
    'Start — 23 requests, about 6:12 min'
  );

  // A guess says it is one, in plain words.
  const guess = normaliseEstimate(
    Object.assign({}, ESTIMATE, { basis: 'guess', lastRun: null })
  );
  assert.ok(
    basisText(guess).includes('Nothing has been measured yet') &&
      basisText(guess).includes('out by a factor'),
    'an unmeasured estimate has to say so plainly'
  );
  assert.ok(
    basisText(
      normaliseEstimate(Object.assign({}, ESTIMATE, { basis: 'model' }))
    ).includes('measured on qwen3:30b itself'),
    'and a model measurement says what it is'
  );
  // An unknown basis is a guess, never a claim.
  assert.strictEqual(
    normaliseEstimate({ basis: 'vibes' }).basis,
    'guess',
    'only the three bases of the contract are believed'
  );
});

testAsync('The levers move the numbers the dialog shows', async () => {
  const levers = { skipDecided: false, minDocuments: 1, lanes: 3 };
  // Big enough that a lever crosses a request boundary; with four tags every
  // lever would land in the same single request and prove nothing.
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
      'GUESS_PROMPT_BASE',
      'GUESS_PROMPT_PER_ITEM',
      'GUESS_TOKENS_PER_ITEM',
      'GUESS_THINKING_PER_REQUEST',
      'GUESS_TOKENS_PER_SECOND',
    ],
    globals: {
      runLevers: levers,
      MIN_DOCUMENTS_LEVER: 3,
      ensureTagIndex: async () => new Map(),
      proposals: new Map(stored.map((row) => [row.tagId, row])),
    },
  });

  const plain = await localOrderEstimate();
  assert.strictEqual(plain.tags, 210);
  assert.strictEqual(plain.itemsByRule, 20, 'the rule pass covers twenty');
  assert.strictEqual(plain.items, 190, 'the model is asked about the rest');
  assert.strictEqual(plain.requests, 4, 'fifty items to a request');
  assert.strictEqual(
    plain.basis,
    'guess',
    'the stub never claims a measurement'
  );
  assert.strictEqual(plain.skippable.decided, 60);
  assert.strictEqual(plain.skippable.lowDocument, 30);

  levers.skipDecided = true;
  const fewer = await localOrderEstimate();
  assert.strictEqual(
    fewer.items,
    130,
    'a decided tag is not asked about again'
  );
  assert.strictEqual(fewer.requests, 3, 'and that is one request less');

  levers.minDocuments = 3;
  const fewest = await localOrderEstimate();
  assert.strictEqual(fewest.items, 100, 'and neither is a tag on one document');
  assert.ok(
    fewest.tokens.total < plain.tokens.total,
    'fewer items have to cost fewer tokens'
  );

  levers.skipDecided = false;
  levers.minDocuments = 1;
  levers.lanes = 8;
  const faster = await localOrderEstimate();
  assert.strictEqual(
    faster.tokens.total,
    plain.tokens.total,
    'lanes cost nothing'
  );
  assert.ok(faster.seconds < plain.seconds, 'but they do buy time');

  // And the dialog re-asks rather than doing the arithmetic twice.
  const ask = functionBody('askPreflight');
  assert.ok(
    ask.includes("dialog.addEventListener('change'") &&
      ask.includes('await fetchOrderEstimate(keepVocabulary)') &&
      ask.includes('draw()'),
    'every lever re-asks the estimate and redraws the numbers'
  );
  assert.ok(
    ask.includes("confirm.classList.add('zr-btn--stacked')") &&
      ask.includes('htmlPreflightConfirm(estimate)'),
    "the primary button's own second line moves with them"
  );
  assert.ok(
    ask.includes('confirmDialog({'),
    'the dialog is the kernel one; this page never builds an overlay'
  );
});

/* ── 9. the run meter ─────────────────────────────────────────────────────── */

const PROGRESS = {
  phase: 'asking',
  message: 'Asking about 50 tags…',
  requestsDone: 12,
  requestsPlanned: 23,
  tokens: 760000,
  estimatedTokens: 1410000,
  tokenBudget: 2000000,
  elapsedMs: 190000,
  etaMs: 180000,
  requestPairs: 50,
  requestAnswers: 21,
  requestTokens: 89100,
  thinking: true,
  promptTokens: 24000,
  completionTokens: 180000,
  // The request being answered right now, and the whole run's reasoning. The
  // bar is drawn from the second: the first falls back to null between
  // requests and would collapse the bar every time one finished.
  thinkingTokens: 45000,
  thinkingTotal: 120000,
  requestLog: [
    {
      index: 12,
      items: 50,
      answers: 50,
      tokens: 61000,
      thinkingTokens: 38000,
      ms: 44000,
      outcome: 'answered',
    },
    {
      index: 11,
      items: 50,
      answers: 31,
      tokens: 52000,
      thinkingTokens: 20000,
      ms: 51000,
      outcome: 'partial',
    },
    {
      index: 9,
      items: 50,
      answers: 0,
      tokens: 71000,
      thinkingTokens: 25000,
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

test('The run meter reads a progress event, empty requests included', () => {
  const {
    htmlRunbar,
    htmlRunLedger,
    htmlLiveRequest,
    htmlReqLog,
    reqlogText,
    stopSubText,
  } = helpers(
    [
      ...BASE,
      'progressPercent',
      'formatEta',
      'htmlRunbar',
      'htmlRunLedger',
      'htmlLiveRequest',
      'reqlogText',
      'reqlogCost',
      'htmlReqLog',
      'stopSubText',
    ],
    {}
  );

  const bar = htmlRunbar(PROGRESS);
  assert.ok(bar.includes('Request 13 of 23'), 'the bar says which request');
  assert.ok(bar.includes('width: 52%'), 'and how far the run is');
  assert.ok(bar.includes('about 3 min left'), 'with the estimate beside it');

  const ledger = htmlRunLedger(PROGRESS);
  assert.ok(
    ledger.includes('760k of 1.4M'),
    'the tokens so far are read against the estimate'
  );
  assert.ok(ledger.includes('4,000/s'), 'and the rate is said out loud');
  assert.ok(
    ledger.includes('zr-ledger__value--quiet">0</span> writes'),
    'a run that asks writes nothing, and the ledger repeats it'
  );

  const live = htmlLiveRequest(PROGRESS);
  assert.ok(
    live.includes('89.1k of the 2M this run may spend'),
    'the request running now is read against the budget'
  );
  assert.ok(live.includes('21 of 50 answered'), 'and against its own items');
  assert.ok(live.includes('still thinking'), 'a thinking model says so');

  const log = htmlReqLog(PROGRESS.requestLog);
  assert.strictEqual(
    (log.match(/class="zr-reqlog__row/g) || []).length,
    4,
    'one row per request, newest first'
  );
  assert.strictEqual(
    (log.match(/zr-reqlog__row--warn/g) || []).length,
    2,
    'only the empty and the failed one are worth a warning'
  );
  assert.ok(
    log.indexOf('Request 12') < log.indexOf('Request 9'),
    'newest first, as the service hands them over'
  );
  assert.strictEqual(
    reqlogText(PROGRESS.requestLog[2]),
    'Request 9 — thought for 25k tokens and answered nothing',
    'an empty request says what it did with the time'
  );
  assert.ok(
    reqlogText(PROGRESS.requestLog[3]).includes('the provider ended it'),
    'and a failed one says who ended it'
  );
  assert.ok(
    reqlogText(PROGRESS.requestLog[1]).includes(
      '31 answered, the rest asked again'
    ),
    'a partial request says what came back'
  );
  assert.strictEqual(htmlReqLog([]), '', 'no requests, no log');

  // The stop button says what stopping keeps.
  assert.ok(
    stopSubText(PROGRESS).includes(
      'Keeps the 12 requests that already came back'
    ),
    'stopping keeps what has been paid for'
  );
  assert.ok(
    stopSubText({ requestsDone: 0 }).includes('Nothing has come back yet'),
    'and says so when there is nothing to keep'
  );

  // The meter rides on the events the panel already gets.
  assert.ok(
    functionBody('renderProgress').includes('renderRunMeter(state)'),
    'every progress event redraws the meter'
  );
  assert.ok(
    functionBody('renderRunMeter').includes('el.stopSub.textContent'),
    'including the stop button’s second line'
  );
});

test('The token split is the question, the answer and the thinking', () => {
  const { tokenSplit, tokenShares, htmlTokenbar } = helpers([...BASE], {});
  const split = tokenSplit({
    prompt: PROGRESS.promptTokens,
    completion: PROGRESS.completionTokens,
    thinking: PROGRESS.thinkingTotal,
  });
  assert.deepStrictEqual(split, {
    prompt: 24000,
    answer: 60000,
    thinking: 120000,
  });
  const shares = tokenShares(split);
  assert.strictEqual(
    Math.round(shares.prompt + shares.answer + shares.thinking),
    100,
    'the three segments are the whole bar'
  );
  const bar = htmlTokenbar(split);
  assert.ok(bar.includes('24k question'), 'the question is named');
  assert.ok(bar.includes('60k answer'), 'the answer is what is left');
  assert.ok(bar.includes('120k thinking'), 'and the reasoning is its own');
  assert.strictEqual(
    htmlTokenbar({ prompt: 0, answer: 0, thinking: 0 }),
    '',
    'a run that reported nothing draws no bar'
  );
});

/* ── 10. what a button writes ─────────────────────────────────────────────── */

test('Every button that writes says what it writes', () => {
  const { planWrites, consequenceText, htmlPlanHead, planHeadline } = helpers(
    [...BASE, 'planBaskets', 'consequenceText', 'planHeadline', 'htmlPlanHead'],
    {}
  );

  // The arithmetic: a document is one write per thing that changes on it, the
  // tag that goes away is one more, and a tag that stays costs nothing.
  const totals = planWrites([FIXTURE[1]]);
  assert.deepStrictEqual(totals, {
    tags: 1,
    documents: 13,
    typeSets: 9,
    topicSets: 13,
    deletions: 1,
    writes: 23,
  });
  assert.strictEqual(
    planWrites([FIXTURE[3]]).writes,
    0,
    'a tag that stays as it is writes nothing at all'
  );

  const split = consequenceText(FIXTURE[1]);
  assert.ok(
    split.includes('sets the type on 9 documents'),
    'it names the documents that change'
  );
  assert.ok(
    split.includes('hangs 1 topic tag on all 13'),
    'and the tags it hangs on them'
  );
  assert.ok(split.includes('deletes the old tag'), 'and the deletion');
  assert.ok(
    split.includes('23 writes to Paperless-ngx'),
    'with the total in writes'
  );
  assert.ok(split.includes('No model is asked'), 'an apply asks no model');
  assert.ok(split.includes('can be undone'), 'and it can be taken back');

  assert.ok(
    consequenceText(FIXTURE[4]).includes('Folding Amazon.de into Amazon'),
    'a merge names both sides'
  );
  assert.ok(
    consequenceText(FIXTURE[5]).includes('removes the tag — 3 writes'),
    'a delete counts the documents plus the tag'
  );
  assert.ok(
    consequenceText(FIXTURE[3]).includes('writes nothing at all'),
    'and a keep is honest about costing nothing'
  );

  // The header card of the plan: the sentence, the two ledgers, the button.
  const baskets = {
    rule: [FIXTURE[0]],
    sure: [FIXTURE[1]],
    ask: [FIXTURE[2]],
    keep: [FIXTURE[3]],
  };
  assert.strictEqual(
    planHeadline(baskets),
    'I read 4 tags: 2 tags are clear, 1 needs a word from you, 1 stays as it is.'
  );
  const head = htmlPlanHead(
    baskets,
    {
      requests: 23,
      tokens: 1410000,
      ms: 372000,
      prompt: 46000,
      completion: 296000,
      thinking: 1068000,
    },
    planWrites([FIXTURE[0], FIXTURE[1]]),
    30
  );
  assert.strictEqual(
    (head.match(/class="zr-ledger"/g) || []).length,
    2,
    'one ledger for what it cost, one for what it will cost'
  );
  assert.ok(
    head.includes('What this proposal cost') &&
      head.includes('What running it costs'),
    'and they are labelled apart'
  );
  assert.ok(
    head.includes('class="zr-tokenbar__track"'),
    'the tokens of the proposal are split into three'
  );
  assert.ok(
    head.includes('zr-ledger__value--quiet">0</span> writes') &&
      head.includes('zr-ledger__value--quiet">0</span> tokens'),
    'asking costs tokens and applying costs writes — each says the other is nought'
  );
  assert.ok(
    head.includes('Run the 2 agreed ones'),
    'the primary button counts what it would run'
  );
  assert.ok(
    head.includes('zr-btn--stacked') && head.includes('class="zr-btn__sub">'),
    'and carries the second ledger on its own second line'
  );
  assert.ok(
    head.includes('no tokens'),
    'an apply never asks a model, and the button says so'
  );
  assert.ok(
    head.includes('Walk me through the 1'),
    'the stack is reachable from the header too'
  );

  // "Apply all accepted" writes too, so it carries its own price.
  assert.match(
    page,
    /id="simApplyAcceptedBtn"[\s\S]{0,240}zr-btn__sub" id="simApplyAcceptedSub"/,
    'the head button must carry a second line of its own'
  );
  const accepted = functionBody('updateApplyAcceptedButton');
  assert.ok(
    accepted.includes('el.applyAcceptedSub.textContent') &&
      accepted.includes('planWrites('),
    'and it has to be the same arithmetic as everywhere else'
  );
  assert.ok(
    accepted.includes("'nothing accepted yet'") &&
      accepted.includes('no tokens'),
    'an empty selection says so, and an apply never asks a model'
  );

  // A plan with nothing in it is no card at all.
  assert.strictEqual(
    htmlPlanHead(
      { rule: [], sure: [], ask: [], keep: [] },
      null,
      planWrites([]),
      0
    ),
    ''
  );
});

test('The apply is a checklist that never asks a model', () => {
  const { checklistFrom, htmlChecklist } = helpers(
    [...BASE, 'checklistFrom', 'htmlChecklist'],
    {}
  );
  const rows = checklistFrom([FIXTURE[0], FIXTURE[1], FIXTURE[4]]);
  assert.strictEqual(rows.length, 3, 'one row per accepted tag');
  assert.strictEqual(rows[0].state, 'waiting', 'and they all start waiting');

  rows[0].state = 'done';
  rows[0].seconds = 3;
  rows[1].state = 'running';
  rows[2].state = 'failed';
  rows[2].error = '400 Bad Request: tag is in use';

  const html = htmlChecklist(rows);
  assert.ok(
    html.includes('0 tokens — this step never asks the model'),
    'the head of the checklist is the point of it'
  );
  assert.ok(html.includes('1 of 3 done, 1 failed'), 'the tally is at the top');
  assert.ok(html.includes('>0:03<'), 'a done row carries its seconds');
  assert.ok(
    html.includes('zr-reqlog__row--live'),
    'the ones running now are marked'
  );
  assert.ok(
    html.includes('zr-reqlog__row--warn') &&
      html.includes('400 Bad Request: tag is in use'),
    'a failure is red and says what Paperless-ngx said'
  );
  assert.ok(
    html.includes('sim-checklist-retry') && html.includes('Try it now'),
    'and it can be tried again on its own'
  );
  assert.strictEqual(htmlChecklist([]), '', 'nothing accepted, no checklist');

  // The job's own progress moves it on, and its result closes it.
  assert.ok(
    functionBody('applyOrder').includes('checklistRows = checklistFrom(') &&
      functionBody('applyOrder').includes('finishChecklist(data)'),
    'the checklist is built at the start of an apply and closed at its end'
  );
  assert.ok(
    functionBody('followJob').includes('if (applying) advanceChecklist('),
    'and every progress event of the apply moves it on'
  );
});

test('No model-backed run starts before the preflight said what it costs', () => {
  ['proposeOrder', 'repropose'].forEach((name) => {
    const body = functionBody(name);
    assert.ok(body.includes('await askPreflight('), `${name}() must ask first`);
    assert.ok(
      body.includes('if (!go) return;'),
      `${name}() must take no for an answer`
    );
  });
  // And the levers reach the job that is started.
  const run = functionBody('runOrderJob');
  [
    'skipDecided: runLevers.skipDecided',
    'minDocuments: runLevers.minDocuments',
    'concurrency: runLevers.lanes',
  ].forEach((needle) => {
    assert.ok(run.includes(needle), `${needle} never reaches the start call`);
  });
  // The estimate has one door, so the seam is visible while the route is built.
  assert.match(
    SCRIPT,
    /const ESTIMATE_URL = '\/api\/simplify\/order\/estimate';/,
    'the estimate route is named once'
  );
  assert.strictEqual(
    SCRIPT.split('ESTIMATE_URL').length - 1,
    2,
    'one declaration and one use: every caller goes through fetchOrderEstimate'
  );
  assert.ok(
    functionBody('fetchOrderEstimate').includes('localOrderEstimate()'),
    'and a build without the route falls back to the local stub'
  );
});

/* ── 11. the page stylesheet ──────────────────────────────────────────────── */

test('The page places the kit rather than redefining it', () => {
  assert.strictEqual(
    (PAGE_CSS.match(/@layer [a-z]+ \{/g) || []).length,
    1,
    'stylelint scopes its duplicate checks per layer block, so keep one'
  );
  [
    '.sim-plan',
    '.sim-plan__ledgers',
    '.sim-baskets',
    '.sim-stack',
    '.sim-decision__evidence',
    '.sim-preflight',
    '.sim-preflight__step',
    '.sim-meter',
    '.sim-checklist',
    '.sim-groupsblock',
  ].forEach((selector) => {
    assert.ok(
      PAGE_CSS.includes(`${selector} {`) || PAGE_CSS.includes(`${selector},`),
      `${selector} has no rule of its own`
    );
  });
  // The kit's own classes are never redefined here; they are only placed.
  const redefined = [
    '.zr-basket',
    '.zr-decision',
    '.zr-ledger',
    '.zr-tokenbar',
    '.zr-consequence',
    '.zr-runbar',
    '.zr-reqlog',
  ].filter((selector) => PAGE_CSS.includes(`\n  ${selector} {`));
  assert.deepStrictEqual(
    redefined,
    [],
    `the kit belongs to css/review; the page may only place it: ${redefined.join(', ')}`
  );
  // 390px: the two ledgers of the plan read one under the other.
  assert.match(
    PAGE_CSS,
    /@media \(max-width: 720px\) \{[\s\S]*\.sim-plan__ledgers \{\n\s+grid-template-columns: minmax\(0, 1fr\);/,
    'the two ledgers have to stack on a phone'
  );
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
});
