/**
 * Test: duplicates-assistant-ui
 *
 * The Duplicates page as an assistant: what a scan found read as baskets, one
 * pair at a time where it matters, and every button saying what it writes
 * before it is pressed.
 *
 * At contract level this checks the one thing that rots quietly: the
 * styleguide. /styleguide is where anyone looks before inventing a class, so
 * a kit component that never appears there does not exist in practice. The
 * page's own surfaces are checked below that as they are built.
 *
 * Covers:
 *  1. the styleguide has a section for the review kit and links to it
 *  2. every component of the kit is shown there at least once
 *  3. the examples are real controls, not divs with a click handler
 *  4. the view carries the three surfaces, and the full list folds away
 *  5. which basket a group lands in, for every kind of group there is
 *  6. the four baskets rendered from a scan fixture, empty ones included,
 *     and the sentence each kind of line is built into
 *  7. the decision card of the stack, its per-member ticks and its keys
 *  8. the preflight dialog: three blocks and the levers, needsScan both ways
 *  9. a lever changes the numbers it is priced with
 * 10. the run meter reading a progress fixture, an empty request and all
 * 11. every button that writes says what it writes
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
    'zr-basket__mark--ok',
    'zr-basket--ask',
    'zr-basket__choices',
    'zr-decision__sides',
    'zr-decision__side--from',
    'zr-decision__note',
    'zr-decision__keys',
    'zr-consequence',
    'zr-consequence--free',
    'zr-runbar__fill',
    'zr-reqlog__row--live',
    'zr-reqlog__row--warn',
    'zr-btn--stacked',
    'zr-btn__sub',
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
   grepped for. */

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
 * The named helpers of the page script, evaluated out of their module.
 *
 * @param {string[]} names
 * @param {{constants?: string[], globals?: object}} [extra]
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

/** The string constants the helpers read; they are values, not object literals. */
const WIRE = {
  PLAIN_SCORE: 0.95,
  BASKET_PLAIN: 'plain',
  BASKET_SAME: 'same',
  BASKET_ASK: 'ask',
  ASK_WARNINGS: [
    'has-matching-rule',
    'configured-tag',
    'no-permission',
    'owner-differs',
  ],
  AI_REASON_MAX: 200,
  AI_SOURCE_RULE: 'spelling-rule',
  AI_RULE_LABEL: 'Spelling rule',
  AI_RULE_TONE: 'dup-verdict--rule',
  AI_CANDIDATE_SOURCE: 'ai-candidate',
  DECISION_SAMPLES: 3,
  RUN_LANE_OPTIONS: [1, 3, 5, 8],
  currentThreshold: () => 0.85,
};

/** One group of the fixture below, with the page's own defaults applied. */
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

/* One scan, with one group of every kind the plan has to read. */
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
};

/* ── 4. the view ──────────────────────────────────────────────────────────── */

let page = '';
let offered = '';

test('The view carries the plan, the stack and the checklist', () => {
  page = renderSync('duplicates.ejs', LOCALS);
  offered = renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  [
    'dupPlan',
    'dupPlanSentence',
    'dupPlanLedger',
    'dupPlanTokenbar',
    'dupBaskets',
    'dupShowAllBtn',
    'dupEverything',
    'dupStack',
    'dupStackCard',
    'dupStackUndoBtn',
    'dupStackObviousBtn',
    'dupApply',
    'dupApplyList',
  ].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
    assert.ok(
      SCRIPT.includes(`'${id}'`),
      `the page script never looks up #${id}`
    );
  });
  // Three of them come up hidden: a plan of nothing, a stack over nothing and
  // a checklist of nothing would all read as an answer that was never given.
  ['dupPlan', 'dupStack', 'dupApply'].forEach((id) => {
    assert.match(
      page,
      new RegExp(`hidden" id="${id}"`),
      `#${id} must come up hidden`
    );
  });
  // The full list is not hidden at load: before a scan its empty state is the
  // only thing the page has to say.
  assert.match(
    page,
    /class="dup-everything" id="dupEverything"/,
    'the card list must be visible until a plan replaces it'
  );
  assert.ok(
    page.indexOf('id="dupPlan"') < page.indexOf('id="dupEverything"'),
    'the plan belongs above the list it replaces'
  );
  // The run button costs tokens, so it only exists where a model does.
  assert.ok(
    offered.includes('id="dupPlanAskBtn"'),
    'the header card has no run button although the review is offered'
  );
  assert.ok(
    !page.includes('id="dupPlanAskBtn"'),
    'the run button must not exist without the review'
  );
});

test('The run meter grows around the bar the panel already had', () => {
  [
    'dupRunPosition',
    'dupRunRest',
    'dupRunLedger',
    'dupRunTokenbar',
    'dupRunLog',
    'dupAiStopSub',
  ].forEach((id) => {
    assert.ok(
      offered.includes(`id="${id}"`),
      `#${id} is missing although the review is offered`
    );
  });
  // The bar is the same bar, inside the kit's run bar: one bar, with the
  // position on its left and what is left of the wait on its right.
  assert.match(
    offered,
    /class="zr-runbar dup-progress__runbar"/,
    'the progress bar is not inside a run bar'
  );
  assert.match(
    offered,
    /class="dup-progress__bar zr-runbar__track" id="dupAiProgressBar"/,
    'the existing bar is no longer the track of the run bar'
  );
  assert.ok(
    offered.indexOf('id="dupRunPosition"') <
      offered.indexOf('id="dupAiProgressBar"') &&
      offered.indexOf('id="dupAiProgressBar"') <
        offered.indexOf('id="dupRunRest"'),
    'the position, the bar and the time left are in the wrong order'
  );
  // Stop says what stopping keeps, and only then lays out two lines.
  assert.match(
    functionBody('setStopSub'),
    /classList\.toggle\('zr-btn--stacked', text !== ''\)/,
    'the Stop button stacks even when it has nothing on its second line'
  );
});

/* ── 5. which basket a group lands in ─────────────────────────────────────── */

test('Every kind of group lands in the basket that fits it', () => {
  const { planBasketOf } = helpers(['planBasketOf', 'isSureSame', 'num'], {
    globals: WIRE,
  });
  assert.strictEqual(planBasketOf(FIXTURE.plain), 'plain', 'same name');
  assert.strictEqual(planBasketOf(FIXTURE.three), 'plain', 'above 0.95');
  assert.strictEqual(
    planBasketOf(FIXTURE.same),
    'same',
    'the model confirmed it'
  );
  assert.strictEqual(
    planBasketOf(FIXTURE.ask),
    'ask',
    'unsure and a rule warning'
  );
  // A verdict of "different" is an answer: the group stays as it is and is in
  // no basket at all.
  assert.strictEqual(planBasketOf(FIXTURE.apart), '', 'called apart');
  // A warning only the user can settle outranks a perfect score.
  const warned = stateOf({
    ...FIXTURE.plain.group,
    id: 'tags:1-2-warned',
    warnings: ['has-matching-rule'],
  });
  assert.strictEqual(
    planBasketOf(warned),
    'ask',
    'a rule warning is a question'
  );
  // An inbox tag is a note, not a question: it does not move a group.
  const noted = stateOf({
    ...FIXTURE.plain.group,
    id: 'tags:1-2-noted',
    warnings: ['inbox-tag', 'large-group'],
  });
  assert.strictEqual(planBasketOf(noted), 'plain', 'a note is not a question');
  // A "same" the model is not sure about, below the sensitivity, is a question.
  const shaky = stateOf({
    ...FIXTURE.same.group,
    id: 'correspondents:5-6-shaky',
    confidence: 0.7,
    aiVerdict: { verdict: 'same', confidence: 'low', basis: 'synonym' },
  });
  assert.strictEqual(planBasketOf(shaky), 'ask', 'below the sensitivity');
  // Nothing falls through: a group nothing settled is a question, never a
  // proposal that slipped past every rule.
  const bare = stateOf({
    id: 'tags:40-41',
    kind: 'tags',
    confidence: 0.9,
    reasons: ['token-order'],
    warnings: [],
    suggestedTargetId: 40,
    members: [
      { id: 40, name: 'Haus Versicherung', documentCount: 3 },
      { id: 41, name: 'Versicherung Haus', documentCount: 2 },
    ],
  });
  assert.strictEqual(planBasketOf(bare), 'ask', 'the ask basket is the floor');
});

/* ── 6. the four baskets, and the sentences in them ───────────────────────── */

/** The four basket builders with everything they read, out of the module. */
function basketHelpers(unusedEntries) {
  return helpers(
    [
      'num',
      'pct',
      'plural',
      'normalizeKind',
      'memberOf',
      'selectedSources',
      'groupDocuments',
      'countDocuments',
      'shortReason',
      'aiReviewOffered',
      'planMovingDocuments',
      'planPhrase',
      'planQuestion',
      'htmlPlanSources',
      'htmlPlanTarget',
      'htmlPlanLine',
      'htmlPlanQuestion',
      'htmlBasket',
      'htmlBasketPlain',
      'htmlBasketSame',
      'htmlBasketAsk',
      'htmlBasketLeftovers',
    ],
    {
      constants: ['AI_BASIS_PHRASES', 'REASON_PHRASES', 'htmlPlanMarks'],
      globals: {
        ...WIRE,
        unusedEntries,
        el: { aiReviewBtn: {}, reviewThenMergeBtn: null },
      },
    }
  );
}

test('The four baskets are rendered, the empty ones included', () => {
  const kit = basketHelpers([
    { kind: 'tags', record: { id: 77, name: 'Altpapier', documentCount: 0 } },
    {
      kind: 'correspondents',
      record: { id: 78, name: 'Ex-Vermieter', documentCount: 0 },
    },
  ]);
  const markup = [
    kit.htmlBasketPlain([FIXTURE.plain, FIXTURE.three]),
    kit.htmlBasketSame([]),
    kit.htmlBasketAsk([FIXTURE.ask]),
    kit.htmlBasketLeftovers(),
  ].join('');

  ['plain', 'same', 'ask', 'leftovers'].forEach((name) => {
    assert.ok(
      markup.includes(`data-basket="${name}"`),
      `the ${name} basket was not rendered at all`
    );
  });
  assert.ok(
    markup.includes('The same thing, plainly — 2 groups'),
    'the plain basket does not count what is in it'
  );
  // An empty basket keeps its heading and says so; a basket that disappeared
  // would read as a basket nobody looked in.
  assert.ok(
    markup.includes('The model says it is the same — 0 groups'),
    'the empty basket lost its heading'
  );
  assert.ok(
    markup.includes('The model has confirmed nothing here yet.'),
    'the empty basket does not say it is empty'
  );
  assert.ok(
    markup.includes('zr-basket--quiet'),
    'an empty basket is not toned down'
  );
  // Only the basket that needs answers wears the amber edge.
  assert.strictEqual(
    (markup.match(/zr-basket--ask/g) || []).length,
    1,
    'exactly the ask basket carries the amber edge'
  );
  // The plain basket is collapsed behind its own button.
  assert.ok(markup.includes('Show them'), 'the plain basket cannot be opened');
  assert.ok(
    markup.includes(
      'class="zr-basket__body dup-basket__body hidden" data-basket-body="plain"'
    ),
    'the plain basket must come up collapsed'
  );
  assert.ok(
    markup.includes('Leftovers — 2 objects') &&
      markup.includes('1 tag and 1 correspondent carry no document'),
    'the leftovers basket does not count both kinds'
  );
  // Nothing is preselected and nothing carries an inline handler.
  assert.ok(
    !/\son(click|change)\s*=/.test(markup),
    'a basket built an inline handler'
  );
});

test('Each kind of line is built into a sentence with its numbers in it', () => {
  const kit = basketHelpers([]);

  // A plain fold: what goes into what, how much moves, and why.
  const plain = kit.htmlPlanLine(FIXTURE.plain);
  assert.ok(
    plain.includes(
      '<strong>rechnungen</strong> folded into <strong>Rechnung</strong>'
    ),
    `the plain sentence does not read as one: ${plain}`
  );
  assert.ok(
    plain.includes('37 of 486 documents move, the same name'),
    `the plain sentence lost its numbers: ${plain}`
  );
  assert.ok(
    plain.includes('Not the same'),
    'a proposal cannot be dropped from the plan'
  );

  // A model verdict words itself from the rule the model named.
  const same = kit.htmlPlanLine(FIXTURE.same);
  assert.ok(
    same.includes('9 of 149 documents move'),
    `the model line lost its numbers: ${same}`
  );
  assert.ok(
    same.includes('the legal form is the only difference'),
    `the model line does not say what the model went on: ${same}`
  );

  // A group of three folds both of the others in, and says so.
  const three = kit.htmlPlanLine(FIXTURE.three);
  assert.ok(
    three.includes(
      '<strong>Buecherei</strong>, <strong>buecherei</strong> folded into <strong>Bücherei</strong>'
    ),
    `a group of three does not name both sources: ${three}`
  );
  assert.ok(
    three.includes('8 of 39 documents move'),
    `a group of three counts the wrong documents: ${three}`
  );

  // A question says why it is one, and offers real answers.
  const question = kit.htmlPlanQuestion(FIXTURE.ask);
  assert.ok(
    question.includes('zr-basket__question'),
    'a question is not built as one'
  );
  assert.ok(
    question.includes(
      'one of them carries a matching rule the survivor does not'
    ),
    `the question does not say why it is being asked: ${question}`
  );
  ['Fold into Kontoauszug', 'Keep both', 'Look at it'].forEach((answer) => {
    assert.ok(question.includes(answer), `the question has no "${answer}"`);
  });
  // The one answer that writes says what it writes.
  assert.ok(
    question.includes('4 documents · 1 deletion · undoable'),
    `the folding answer does not price itself: ${question}`
  );
  assert.ok(
    question.includes('nothing is written in Paperless-ngx'),
    'keeping both does not say that it writes nothing'
  );
});

/* ── 7. the stack ─────────────────────────────────────────────────────────── */

/** The decision card with the whole vocabulary it reads. */
function decisionHelpers() {
  return helpers(
    [
      'num',
      'pct',
      'plural',
      'normalizeKind',
      'memberOf',
      'selectedSources',
      'countDocuments',
      'groupOffersCopy',
      'shortReason',
      'basisLabel',
      'isRuleVerdict',
      'confidenceLabel',
      'verdictTitle',
      'htmlConfidenceSuffix',
      'htmlRememberedSuffix',
      'htmlVerdictChip',
      'memberMetaText',
      'htmlDecisionSamples',
      'htmlDecisionSide',
      'htmlDecisionHead',
      'htmlDecisionMembers',
      'htmlDecisionCopy',
      'decisionConsequenceText',
      'htmlDecisionCard',
    ],
    {
      constants: [
        'ALGORITHM_LABELS',
        'KIND_LABELS',
        'KIND_PLURALS',
        'REASON_LABELS',
        'AI_VERDICT_LABELS',
        'AI_VERDICT_TONES',
        'AI_BASIS_LABELS',
        'AI_CONFIDENCE_LABELS',
        'htmlIcons',
        'htmlVerdictIcons',
        'htmlPlanMarks',
      ],
      globals: WIRE,
    }
  );
}

test('A decision card shows the two sides, the evidence and the consequence', () => {
  const kit = decisionHelpers();
  const card = kit.htmlDecisionCard(FIXTURE.same);
  assert.ok(
    card.includes('class="zr-decision"'),
    'the card is not the kit card'
  );
  assert.ok(
    card.includes('>STAYS<') && card.includes('>GOES AWAY<'),
    'the two sides are not labelled'
  );
  assert.ok(
    card.includes('Müller GmbH') && card.includes('Müller GmbH &amp; Co. KG'),
    'the card does not name both sides, escaped'
  );
  // Each side carries its documents and its matching rule.
  assert.ok(
    card.includes('140 documents · no matching rule'),
    'the surviving side does not say what it holds'
  );
  assert.ok(
    card.includes('9 documents · rule: Any word'),
    'the side that goes away does not say what it matches'
  );
  // Up to three document titles, where the review fetched any.
  assert.ok(
    card.includes('zr-decision__samples') &&
      card.includes('Rechnung 2024-08-14'),
    'the evidence under a name is missing'
  );
  // The model's own sentence, and what pressing the button writes.
  assert.ok(
    card.includes(
      '<p class="zr-decision__note">The same company with and without its legal form.</p>'
    ),
    'the model does not get to say why'
  );
  assert.ok(
    card.includes(
      'Merging rewrites 9 documents in Paperless-ngx and deletes 1 correspondent. No model is asked. One Undo puts it all back.'
    ),
    `the consequence line is wrong: ${card}`
  );
  // Three buttons and the keys that do the same.
  ['dup-stack-merge', 'dup-stack-keep', 'dup-stack-later'].forEach((hook) => {
    assert.ok(card.includes(hook), `the card has no ${hook} button`);
  });
  assert.ok(
    card.includes('<span class="zr-decision__keys">Enter · Esc · L</span>'),
    'the card does not name its keys'
  );
});

test('A rule only the source has becomes an amber checkbox, ticked', () => {
  const kit = decisionHelpers();
  const card = kit.htmlDecisionCard(FIXTURE.ask);
  assert.ok(
    card.includes('dup-decision__copy'),
    'the rule warning did not become a checkbox in the card'
  );
  assert.match(
    card,
    /class="zr-check dup-stack-copy" checked/,
    'the copy offer must come up ticked where it applies'
  );
  assert.ok(
    card.includes('Copy the matching rule over to Kontoauszug'),
    'the checkbox does not say what it copies where'
  );
  assert.ok(
    card.includes(', copies the matching rule over'),
    'the consequence does not mention the rule it copies'
  );
  // A group without the warning gets no checkbox at all.
  assert.ok(
    !kit.htmlDecisionCard(FIXTURE.plain).includes('dup-stack-copy'),
    'a group with nothing to copy must not be asked about it'
  );
  // The amber lives in the page stylesheet, on the page's own class.
  assert.match(
    CSS,
    /\.dup-decision__copy \{[^}]*background: var\(--zr-warn-soft\)/,
    'the copy offer is not amber'
  );
});

test('A group of three keeps its ticks, and its target stays choosable', () => {
  const kit = decisionHelpers();
  const card = kit.htmlDecisionCard(FIXTURE.three);
  assert.ok(
    card.includes('dup-decision__members'),
    'a group of three does not show its members'
  );
  assert.strictEqual(
    (card.match(/class="zr-check dup-stack-target"/g) || []).length,
    3,
    'every member has to be choosable as the survivor'
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
  // Two members need no list: the two sides already are the whole group.
  assert.ok(
    !kit.htmlDecisionCard(FIXTURE.plain).includes('dup-decision__members'),
    'a pair does not need a member list'
  );
});

test('The keys of the stack fire on the card, never inside a field', () => {
  const body = functionBody('stackKeydown');
  assert.match(
    body,
    /target\.closest\('input, select, textarea, button, a'\)/,
    'a key pressed in a field must stay in that field'
  );
  [
    ["event.key === 'Enter'", 'stackMerge()'],
    ["event.key === 'Escape'", 'stackKeep()'],
    ["event.key === 'l'", 'stackLater()'],
  ].forEach(([key, call]) => {
    assert.ok(body.includes(key), `the stack does not listen for ${key}`);
    assert.ok(body.includes(call), `${key} does not do ${call}`);
  });
  assert.ok(
    body.includes("event.key === 'L'"),
    'a capital L has to work like a small one'
  );
  // Bound on the stack container, and only while the stack is open.
  assert.match(
    functionBody('initStack'),
    /el\.stack\.addEventListener\('keydown', stackKeydown\)/,
    'the keys are not bound on the stack container'
  );
  assert.match(
    body,
    /el\.stack\.classList\.contains\('hidden'\)\) return;/,
    'a closed stack must not answer keys'
  );
  // The card itself is delegated, like everything else on this page.
  assert.ok(
    !/\son(click|keydown)\s*=/.test(SCRIPT),
    'the page script built an inline handler'
  );
});

test('The stack undoes the last decision in the terms it was made', () => {
  const body = functionBody('stackUndo');
  // A merge is undone in Paperless-ngx, through the log route the page has.
  assert.match(
    body,
    /\/api\/duplicates\/log\/\$\{num\(decision\.mergeId\)\}\/undo/,
    'a merge is not undone through the log'
  );
  // Re-created objects get new ids, so that pair cannot simply be asked again.
  assert.ok(
    body.includes('back in Paperless-ngx with new ids'),
    'the undo does not say what it left behind'
  );
  // "Decide later" wrote nothing, so taking it back writes nothing either.
  assert.match(
    body,
    /if \(decision\.action === 'later'\)[\s\S]{0,260}return;/,
    'taking back a "decide later" must not send a request'
  );
  assert.ok(
    functionBody('undoDismissal').includes('/api/duplicates/dismissals'),
    'a "keep both" is not taken back through the dismissals'
  );
});

/* ── 8. and 9. the preflight ──────────────────────────────────────────────── */

const ESTIMATE = {
  groups: 2,
  pairs: 31,
  needsScan: false,
  items: 31,
  itemsByRule: 0,
  batchSize: 25,
  lanes: 3,
  requests: 4,
  seconds: 38,
  tokens: { total: 96000, prompt: 12000, completion: 23000, thinking: 61000 },
  basis: 'model',
  measuredAt: null,
  model: 'qwen3:30b',
  thinking: true,
  extra: { sweepRequests: 4, excerptReads: 12 },
  lastRun: null,
};

function preflightHelpers() {
  return helpers(
    [
      'num',
      'plural',
      'formatTokens',
      'formatSeconds',
      'htmlLedgerItem',
      'estimateBasisText',
      'roughTime',
      'preflightLede',
      'htmlPreflightHero',
      'htmlEstimateLevers',
      'htmlPreflight',
      'preflightOptions',
    ],
    {
      constants: ['htmlPlanMarks'],
      globals: { ...WIRE, el: { sensitivity: { options: [] } } },
    }
  );
}

test('The preflight is one sentence, one number, one bar and one promise', () => {
  const kit = preflightHelpers();
  const levers = { sweep: true, excerpts: true, sensitivity: '', lanes: 3 };
  const markup = kit.htmlPreflight(ESTIMATE, levers);

  // One sentence instead of four labelled sections of prose.
  assert.ok(
    markup.includes(
      'I ask the model about 31 pairs the spelling alone cannot settle, out of 2 groups it found.'
    ),
    'the lede does not say what the run asks about'
  );
  ['What I actually do', 'What it costs', 'What it changes', 'Cheaper'].forEach(
    (heading) => {
      assert.ok(
        !markup.includes(heading),
        `"${heading}" is a section header the dialog no longer needs`
      );
    }
  );

  // The hero: the time a person feels, the price under it, the one graphic.
  assert.ok(
    markup.includes('class="zr-preflight__time">under a minute<'),
    'the time is the big number, and 38 seconds is not "0:38"'
  );
  assert.ok(
    markup.includes('4 requests · 96k tokens'),
    'the price sits under it in one line'
  );
  assert.ok(
    markup.includes('class="zr-tokenbar__track"'),
    'the token split is the graphic of the dialog'
  );
  assert.ok(
    markup.includes('Measured on qwen3:30b'),
    'and one short line says where the numbers come from'
  );
  assert.ok(
    !markup.includes('class="zr-ledger'),
    'the ledger belonged to the old four-section layout'
  );

  // The promise, in five words.
  assert.ok(
    markup.includes('class="zr-preflight__safe"'),
    'the dialog does not say that nothing is merged'
  );
  assert.ok(
    markup.includes('Nothing is merged while this runs.'),
    'word for word'
  );

  // Everything adjustable is folded away.
  assert.ok(
    markup.includes('<details class="zr-preflight__options">'),
    'the levers are not folded away'
  );
  assert.ok(markup.includes('Options</summary>'), 'and the fold has a name');

  // The time rounds, and says so in words where a number would lie.
  assert.strictEqual(kit.roughTime(20), 'under a minute');
  assert.strictEqual(kit.roughTime(75), '1 min');
  assert.strictEqual(kit.roughTime(372), '6 min');

  // Where the numbers come from, in a handful of words.
  assert.strictEqual(
    kit.estimateBasisText({ ...ESTIMATE, basis: 'run' }),
    'Measured on your last run'
  );
  assert.ok(
    kit
      .estimateBasisText({ ...ESTIMATE, basis: 'guess' })
      .includes('rough guess'),
    'an unmeasured estimate has to say so plainly'
  );
});

test('The levers are folded away, each with what it costs', () => {
  const kit = preflightHelpers();
  const levers = { sweep: false, excerpts: true, sensitivity: '', lanes: 3 };
  const markup = kit.htmlEstimateLevers(ESTIMATE, levers);
  ['dupRunSweep', 'dupRunExcerpts', 'dupRunSensitivity', 'dupRunLanes'].forEach(
    (id) => {
      assert.ok(markup.includes(`id="${id}"`), `the levers have no #${id}`);
    }
  );
  assert.ok(
    markup.includes('+4 requests'),
    'the sweep does not say what switching it on costs'
  );
  assert.ok(
    markup.includes('12 document reads'),
    'the excerpts do not say what they cost'
  );
  // A price nobody would pay is not printed at all.
  const free = kit.htmlEstimateLevers(
    { ...ESTIMATE, extra: { sweepRequests: 0, excerptReads: 0 } },
    levers
  );
  assert.ok(
    !free.includes('+0 requests') && !free.includes('0 document reads'),
    'a lever that costs nothing does not say "+0"'
  );
  // The lanes are the four the page offers, with the current one selected.
  WIRE.RUN_LANE_OPTIONS.forEach((lanes) => {
    assert.ok(
      markup.includes(`<option value="${lanes}"`),
      `the lanes select is missing ${lanes}`
    );
  });
  assert.ok(
    markup.includes('<option value="3" selected>3</option>'),
    'the lanes select does not show what is in force'
  );
  // Only the one that is on comes up ticked.
  assert.ok(
    markup.includes('id="dupRunExcerpts" checked') &&
      !markup.includes('id="dupRunSweep" checked'),
    'the levers do not show their own state'
  );
});

test('When nothing has been scanned the dialog says so instead of inventing', () => {
  const kit = preflightHelpers();
  const levers = { sweep: false, excerpts: false, sensitivity: '', lanes: 1 };
  const needs = kit.htmlPreflight({ ...ESTIMATE, needsScan: true }, levers);
  assert.ok(
    needs.includes('Nothing has been scanned yet'),
    'the dialog does not say that there is nothing to judge'
  );
  assert.ok(
    needs.includes('Nothing is merged. The scan only looks.'),
    'and a scan that only looks has to say so'
  );
  assert.ok(
    !kit
      .htmlPreflight(ESTIMATE, levers)
      .includes('Nothing has been scanned yet'),
    'a scanned page must not be told to scan'
  );
  // And the button offers to do both, in one line.
  const both = kit.preflightOptions(
    { ...ESTIMATE, needsScan: true },
    levers,
    'Ask the AI'
  );
  assert.strictEqual(both.confirmLabel, 'Scan, then ask');
  assert.strictEqual(both.title, 'Scan, then ask the AI');
  const plain = kit.preflightOptions(ESTIMATE, levers, 'Ask the AI');
  assert.strictEqual(plain.confirmLabel, 'Ask the AI');
  assert.strictEqual(plain.title, 'Ask the AI');
});

test('A lever changes the numbers the run is priced with', () => {
  const groups = new Map([
    ['tags:1-2', FIXTURE.plain],
    ['tags:20-21-22', FIXTURE.three],
  ]);
  const kit = helpers(['num', 'reviewPairCount', 'localRunEstimate'], {
    globals: {
      groups,
      scanned: true,
      GUESS_BATCH_SIZE: 25,
      GUESS_PROMPT_BASE: 900,
      GUESS_PROMPT_PER_ITEM: 18,
      GUESS_TOKENS_PER_ITEM: 26,
      GUESS_THINKING_PER_REQUEST: 1800,
      GUESS_TOKENS_PER_SECOND: 45,
      GUESS_SWEEP_BATCH: 60,
    },
  });
  const base = { sweep: false, excerpts: false, sensitivity: '', lanes: 1 };
  const plain = kit.localRunEstimate(base);
  const swept = kit.localRunEstimate({ ...base, sweep: true });
  const read = kit.localRunEstimate({ ...base, excerpts: true });
  const fast = kit.localRunEstimate({ ...base, lanes: 8 });

  assert.strictEqual(plain.pairs, 3, 'a group of three is two pairs, not one');
  assert.ok(
    swept.requests > plain.requests,
    'the sweep must cost requests of its own'
  );
  assert.ok(
    swept.tokens.total > plain.tokens.total,
    'the sweep must cost tokens of its own'
  );
  assert.strictEqual(
    swept.extra.sweepRequests,
    1,
    'the sweep does not count its own requests'
  );
  // Reading excerpts is Paperless-ngx work, not model work: document reads go
  // up, the request count does not.
  assert.strictEqual(read.extra.excerptReads, 5, 'the reads are not counted');
  assert.strictEqual(
    read.requests,
    plain.requests,
    'reading an excerpt must not cost a model request'
  );
  // Lanes buy time, never tokens.
  assert.ok(fast.seconds < plain.seconds, 'more lanes must finish sooner');
  assert.strictEqual(
    fast.tokens.total,
    plain.tokens.total,
    'more lanes must cost exactly the same'
  );
  // A page that has measured nothing says so.
  assert.strictEqual(plain.basis, 'guess');
});

test('The estimate has one seam, and it falls back rather than lying', () => {
  const body = functionBody('fetchRunEstimate');
  assert.ok(
    body.includes('/api/duplicates/ai-review/estimate?'),
    'the page does not ask the estimate endpoint at all'
  );
  ['kind:', 'threshold:', 'sweep:', 'excerpts:', 'lanes:'].forEach((field) => {
    assert.ok(body.includes(field), `the estimate request carries no ${field}`);
  });
  assert.match(
    body,
    /return localRunEstimate\(levers\);/,
    'without an endpoint the page has to fall back to its own arithmetic'
  );
  // Both run buttons open the dialog first, and neither sends a request itself.
  ['runAiReview', 'runAiProposal'].forEach((name) => {
    assert.match(
      functionBody(name),
      /if \(!\(await confirmRun\(/,
      `${name}() starts a run without saying what it costs`
    );
  });
});

/* ── 10. the run meter ────────────────────────────────────────────────────── */

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
  requestTokens: 89100,
  thinking: true,
  promptTokens: 183000,
  completionTokens: 148000,
  // The request being answered right now, and the whole run's reasoning. The
  // bar is drawn from the second: the first falls back to null between
  // requests and would collapse the bar every time one finished.
  thinkingTokens: 45000,
  thinkingTotal: 411000,
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
      tokens: 42000,
      thinkingTokens: 9000,
      ms: 38000,
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
      tokens: null,
      thinkingTokens: null,
      ms: 9000,
      outcome: 'failed',
    },
  ],
};

test('The run meter reads a progress snapshot, empty requests and all', () => {
  const kit = helpers(
    [
      'num',
      'plural',
      'formatTokens',
      'formatElapsed',
      'reqlogWhatText',
      'reqlogCostText',
      'htmlLiveRequestRow',
      'htmlRequestLog',
      'runPositionText',
    ],
    { constants: ['htmlPlanMarks'], globals: WIRE }
  );

  assert.strictEqual(kit.runPositionText(PROGRESS), 'Request 13 of 23');
  assert.strictEqual(kit.runPositionText({}), 'Starting…');

  const log = kit.htmlRequestLog(PROGRESS);
  assert.strictEqual(
    (log.match(/<div class="zr-reqlog__row/g) || []).length,
    5,
    'the log shows the four finished requests and the one in flight'
  );
  assert.ok(
    log.indexOf('zr-reqlog__row--live') < log.indexOf('Request 12'),
    'the request in flight belongs at the top of the log'
  );
  // An answered request says what it asked and what came back, with the share
  // of its tokens that went into reasoning.
  assert.ok(
    log.includes('Request 12 — 50 pairs, 50 answered'),
    `an answered request is not worded: ${log}`
  );
  assert.ok(
    log.includes('61k · 38k of it thinking'),
    'an answered request does not split its tokens'
  );
  // A partial one says the rest were asked again.
  assert.ok(
    log.includes(
      'Request 11 — 50 pairs, 31 answered; the rest were asked again'
    ),
    'a partial request reads like a finished one'
  );
  // The two that wasted tokens are marked, and say what happened in words.
  assert.strictEqual(
    (log.match(/zr-reqlog__row--warn/g) || []).length,
    2,
    'an empty and a failed request must both be marked'
  );
  assert.ok(
    log.includes('Request 9 — thought for 25k tokens and answered nothing'),
    `an empty request does not say what it cost for nothing: ${log}`
  );
  assert.ok(
    log.includes('Request 8 — the provider or the budget ended it'),
    'a failed request does not say what ended it'
  );
  assert.ok(
    log.includes('1:52'),
    'a request over a minute is not shown as a clock'
  );
  assert.strictEqual(
    kit.htmlRequestLog({}),
    '',
    'an empty log renders nothing'
  );
  // The request in flight is the first row of the log, which is where "the
  // model is thinking" belongs — on the request that is thinking.
  const live = kit.htmlRequestLog({
    requestsDone: 12,
    requestPairs: 50,
    requestAnswers: 21,
    requestTokens: 89100,
    thinking: true,
    requestLog: [],
  });
  assert.ok(
    live.includes('zr-reqlog__row--live'),
    'the running request has no row'
  );
  assert.ok(
    live.includes('Request 13 — 50 pairs, 21 answered so far'),
    'the running row does not say where it is'
  );
  assert.ok(
    live.includes('89.1k so far, thinking'),
    'the running row does not say what it has spent, or that it is thinking'
  );
  assert.strictEqual(
    kit.htmlLiveRequestRow({ requestTokens: 0, thinking: false }),
    '',
    'a run between two requests has nothing in flight to show'
  );
});

test('The run meter counts what is spent against what was promised', () => {
  const ledger = functionBody('renderRunLedger');
  assert.ok(
    ledger.includes('estimatedTokens'),
    'what has been spent is not held against what was estimated'
  );
  assert.ok(
    ledger.includes("'elapsed'") && ledger.includes("'pairs'"),
    'three numbers: how long, how far, how much'
  );
  // The budget belongs to the run, not to the request in flight, and it is
  // only named once it is close enough to matter.
  assert.ok(
    !ledger.includes("'this request'"),
    "a single question was never allowed the whole run's budget"
  );
  const ceiling = functionBody('renderRunCeiling');
  assert.ok(
    ceiling.includes('tokenBudget') &&
      ceiling.includes('CEILING_SHOWN_ABOVE') &&
      ceiling.includes('this run may spend'),
    "the ceiling is not named as the run's, or is named too early"
  );
  // The split comes from the three counts the job reports separately, and the
  // reasoning is the run's total rather than the request in flight.
  const meter = functionBody('renderRunMeter');
  ['promptTokens', 'completionTokens', 'thinkingTotal'].forEach((field) => {
    assert.ok(meter.includes(field), `the split ignores ${field}`);
  });
  assert.ok(
    !/state\.thinkingTokens/.test(meter),
    'the bar would collapse between requests if it read the live field'
  );
  assert.ok(
    meter.includes('htmlRequestLog(state)'),
    'the meter never draws the request log'
  );
  // Stopping says what it keeps, in three words.
  assert.ok(
    meter.includes("plural(judged, 'verdict', 'verdicts')") &&
      meter.includes("'nothing is written either way'"),
    'Stop does not say what stopping keeps'
  );
  // And every progress event redraws it.
  assert.ok(
    functionBody('renderProgress').includes('renderRunMeter(state)'),
    'a progress event does not reach the run meter'
  );
});

/* ── 11. what every button that writes writes ─────────────────────────────── */

test('Every button that writes says what it writes first', () => {
  // The four writing surfaces of the page, each with the line above it.
  [
    ['updateSelectionConsequence', 'Merge selected'],
    ['updateManualConsequence', 'Merge by hand'],
    ['updateUnusedConsequence', 'Delete selected'],
    ['updateGroupConsequence', 'a group card'],
  ].forEach(([name, what]) => {
    const body = functionBody(name);
    assert.ok(
      body.includes('zr-consequence') || body.includes('htmlPlanMarks.cost'),
      `${what} has no consequence line`
    );
    assert.ok(
      body.includes("classList.add('hidden')"),
      `${what} keeps an empty consequence line on the page`
    );
  });
  // Documents, deletions, whether a model is asked, and whether it can be
  // undone — in every one of them.
  [
    functionBody('updateSelectionConsequence'),
    functionBody('updateManualConsequence'),
    functionBody('decisionConsequenceText'),
  ].forEach((body) => {
    assert.ok(
      body.includes('No model is asked'),
      'it does not say who is asked'
    );
    assert.ok(
      /Undo|undone/.test(body),
      'it does not say whether it can be taken back'
    );
    assert.ok(body.includes('deletes'), 'it does not say what is deleted');
  });
  // Deleting an unused object moves nothing, and says that rather than
  // promising documents that do not exist.
  const unused = functionBody('updateUnusedConsequence');
  assert.ok(
    unused.includes('nothing is moved and no model is asked'),
    'the delete line promises documents that are not there'
  );
  assert.ok(
    unused.includes('re-creates them with new ids'),
    'the delete line does not say what an undo gives back'
  );
  // The three elements the lines are written into exist in the view.
  [
    'dupSelectionConsequence',
    'dupManualConsequence',
    'dupUnusedConsequence',
  ].forEach((id) => {
    assert.ok(page.includes(`id="${id}"`), `#${id} is missing from the view`);
  });
  // And the card's own line is part of the card template.
  assert.ok(
    SCRIPT.includes('<p class="zr-consequence dup-group__consequence hidden">'),
    'a group card has no room for what its Merge button writes'
  );
});

test('Applying is a checklist, and it never asks a model', () => {
  const body = functionBody('runBatch');
  assert.ok(body.includes('openApply(entries)'), 'a batch opens no checklist');
  assert.match(
    body,
    /markApply\(entry\.state\.group\.id, 'running', ''\)/,
    'the group being written is not marked as such'
  );
  assert.ok(
    body.includes("'done'") && body.includes('in ${seconds} s'),
    'a finished row does not say how long it took'
  );
  assert.ok(
    body.includes("'failed'") && body.includes('Paperless-ngx refused it'),
    'a failed row does not say what happened'
  );
  // A failure keeps its row and the button that tries it again.
  assert.ok(
    functionBody('htmlApplyRow').includes('dup-apply-retry'),
    'a failed row offers no way to try it again'
  );
  assert.match(
    body,
    /if \(failed === 0\) closeApply\(\);/,
    'a batch that failed must keep its rows on the page'
  );
  // The line above it, in the view, says what this step costs.
  assert.ok(
    page.includes('0 tokens — this step never asks the model'),
    'the checklist does not say that applying asks nobody'
  );
  assert.ok(
    page.includes('The document scan is standing by'),
    'the checklist does not say what would refuse a merge'
  );
});

test('The plan folds the full list away, and gives it back', () => {
  const body = functionBody('showEverything');
  assert.ok(
    body.includes("classList.toggle('hidden', !visible)"),
    'the full list cannot be folded away'
  );
  assert.ok(
    body.includes('aria-expanded') && body.includes('Show every group'),
    'the toggle does not say what it does, or say it to a screen reader'
  );
  // A scan that produced cards puts the plan in front of them.
  assert.match(
    functionBody('renderGroups'),
    /renderPlan\(\);\n\s+showEverything\(false\);/,
    'a scan must leave the plan in front of the card list'
  );
  // The plan is built from the cards, so every one of its buttons can find one.
  assert.ok(
    functionBody('planBuckets').includes('eachGroupCard('),
    'the plan is built from something other than the cards'
  );
  ['planFold', 'planDrop'].forEach((name) => {
    assert.ok(
      functionBody(name).includes('planEntry('),
      `${name}() acts on something other than the card it belongs to`
    );
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
