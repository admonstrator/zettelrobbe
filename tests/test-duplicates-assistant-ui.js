/**
 * Test: duplicates-assistant-ui
 *
 * The Duplicates page in two modes. The simple mode opens on one card with
 * one button, prices a run in the shared sheet before the model is asked
 * anything, and reads what a run found as a head with one button, three
 * checklists and one line of history. The advanced mode sits behind the gate
 * and carries the tools of the page, without prose.
 *
 * At contract level this checks the one thing that rots quietly: the
 * styleguide. /styleguide is where anyone looks before inventing a class, so
 * a kit component that never appears there does not exist in practice. The
 * page's own surfaces are checked below that, with the view rendered through
 * the real shell and the page script's pure helpers run on fixtures.
 *
 * Covers:
 *  1. the styleguide shows every component of the kit, as real controls
 *  2. the modes: the page names itself, marks each half, and no page rule
 *     decides whether a marked element shows
 *  3. the gate into the advanced mode and the switch in the top bar
 *  4. the empty card, its one button, and when the page trades it for the
 *     result
 *  5. the sheet's model built from an estimate fixture: after a scan, before
 *     one, with the sweep and at every lane count
 *  6. which checklist a group lands in, its chip and its reason
 *  7. the three checklists sorted from a groups fixture, and the numbers of
 *     the result head following the ticks
 *  8. the history line
 *  9. the stack: the decision card, its keys, and decisions that only tick
 * 10. the run meter reading a progress fixture, empty requests and all
 * 11. applying a batch as a checklist
 * 12. the advanced page carries its controls without hint paragraphs
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
    // What this page is built from since it has two modes.
    'zr-emptycard',
    'zr-resulthead',
    'zr-checklist',
    'zr-historyline',
    'zr-sheet',
    'zr-gate',
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
    .replace(/^import .*$/gm, '')
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
    },
    extra.globals || {}
  );
  const keys = Object.keys(globals);
  return new Function(
    ...keys,
    `${constants}\n${source}\nreturn { ${returned.join(', ')} };`
  )(...keys.map((key) => globals[key]));
}

/** A classList that remembers, for the helpers that toggle one. */
function fakeElement(classes = []) {
  const set = new Set(classes);
  return {
    textContent: '',
    innerHTML: '',
    disabled: false,
    style: {},
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
};

/* The unused objects of the same scan, in the shape unusedFromScan() makes. */
const UNUSED = [
  { kind: 'tags', record: { id: 70, name: 'Old <b>' } },
  { kind: 'correspondents', record: { id: 71, name: 'Nobody' } },
];

/* ── 2. the modes ─────────────────────────────────────────────────────────── */

let page = '';
let offered = '';

/** The opening tag of the element with this id. */
function openingTag(markup, id) {
  const tag = new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`).exec(markup);
  assert.ok(tag, `#${id} is missing from the view`);
  return tag[0];
}

test('The page names itself and opens in the simple mode', () => {
  page = renderSync('duplicates.ejs', LOCALS);
  offered = renderSync(
    'duplicates.ejs',
    Object.assign({}, LOCALS, { aiReviewEnabled: true })
  );
  [page, offered].forEach((markup) => {
    assert.match(
      markup,
      /<div class="dup-page" data-review-page="duplicates" data-mode="simple"\s+data-default-threshold="0\.85">/,
      'the root must name the page, start simple and carry the default threshold'
    );
  });
  // The mode the page was left in is read by the kit; the page only names
  // itself and where the switch goes.
  const init = functionBody('initMode');
  ["page: 'duplicates'", 'root: el.page', 'gate: GATE_LINES'].forEach(
    (part) => {
      assert.ok(init.includes(part), `the switch is mounted without ${part}`);
    }
  );
  assert.ok(
    init.includes("document.getElementById('zrTopbarActions')"),
    'the switch belongs in the top bar'
  );
  assert.ok(
    init.includes('onChange: () => renderSimple()'),
    'the simple page must read the cards again when it comes back'
  );
  assert.match(
    functionBody('init'),
    /\{\n\s+if \(!el\.results\) return;\n\n\s+initMode\(\);/,
    'the mode is set before anything else draws'
  );
});

test('Each half of the page is marked, and what both modes need is not', () => {
  [page, offered].forEach((markup) => {
    // The simple half: the sentence, the card and the result.
    assert.ok(
      markup.includes('<div class="dup-lede" data-simple>'),
      'the sentence of the simple page is not marked'
    );
    ['dupEmpty', 'dupResult'].forEach((id) => {
      assert.ok(
        /\sdata-simple[\s>]/.test(openingTag(markup, id)),
        `#${id} belongs to the simple page only`
      );
    });
    // The advanced half: the scan row, and one wrapper around every tool.
    assert.ok(
      /\sdata-advanced[\s>]/.test(openingTag(markup, 'dupControls')),
      'the scan row belongs to the advanced page only'
    );
    const tools = markup.indexOf('<div data-advanced>');
    assert.notStrictEqual(tools, -1, 'the tools have no marked wrapper');
    [
      'dupManual',
      'dupEverything',
      'dupUnused',
      'dupLog',
      'dupMappings',
      'dupDismissals',
    ].forEach((id) => {
      assert.ok(
        markup.indexOf(`id="${id}"`) > tools,
        `#${id} sits outside the advanced wrapper`
      );
    });
    assert.ok(
      markup.indexOf('id="dupResult"') < tools,
      'the result of the simple page must close before the tools begin'
    );
    // What a run and a merge show belongs to both modes.
    ['dupAiNotice', 'dupApply', 'dupStack'].forEach((id) => {
      assert.ok(
        !/data-(simple|advanced)/.test(openingTag(markup, id)),
        `#${id} must show in both modes`
      );
    });
    assert.strictEqual(
      (markup.match(/\sdata-simple[\s>]/g) || []).length,
      3,
      'three parts are the simple page: the sentence, the card, the result'
    );
    assert.strictEqual(
      (markup.match(/\sdata-advanced[\s>]/g) || []).length,
      2,
      'two parts are the advanced page: the scan row and the tools'
    );
  });
  assert.ok(
    !/\sdata-(simple|advanced)/.test(openingTag(offered, 'dupAiProgress')),
    'the run meter shows in both modes while a run runs'
  );
  // A finished run's meter is a detail of the advanced page; a new run brings
  // it back to both.
  assert.ok(
    functionBody('renderProgressOutcome').includes(
      "el.aiProgress.setAttribute('data-advanced', '')"
    ),
    'a finished meter stays on the simple page'
  );
  assert.ok(
    functionBody('showProgressPanel').includes(
      "el.aiProgress.removeAttribute('data-advanced')"
    ),
    'a new run does not show its meter in the simple mode'
  );
});

test('No page rule decides whether a marked element shows', () => {
  // The rule that hides the other mode sits in the utilities layer next to
  // .hidden, so no module or page display can outrank it; this stylesheet
  // still must not set a display on a marked element, or the intent is lost.
  const utilities = read('public', 'css', 'utilities.css');
  assert.ok(
    utilities.includes("[data-mode='simple'] [data-advanced],") &&
      utilities.includes("[data-mode='advanced'] [data-simple] {"),
    'the marks mean nothing without the rule of the utilities layer'
  );
  const marked = [
    ...page.matchAll(/<[a-z]+[^>]*\sdata-(?:simple|advanced)[^>]*>/g),
  ];
  const classes = new Set();
  marked.forEach((tag) => {
    const attribute = /class="([^"]*)"/.exec(tag[0]);
    if (!attribute) return;
    attribute[1]
      .split(/\s+/)
      .filter((name) => name.startsWith('dup-'))
      .forEach((name) => classes.add(name));
  });
  assert.ok(classes.size >= 4, 'the marked elements lost their classes');
  const rules = [
    ...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ];
  const offenders = [];
  rules.forEach((rule) => {
    const selectors = rule[1].split(',').map((selector) => selector.trim());
    const hit = selectors.find((selector) =>
      classes.has(selector.replace(/^\./, ''))
    );
    if (hit && /(^|[\s;])display\s*:/.test(rule[2])) offenders.push(hit);
  });
  assert.deepStrictEqual(
    offenders,
    [],
    `a page rule sets display on a marked element: ${offenders.join(', ')}`
  );
});

/* ── 3. the gate ──────────────────────────────────────────────────────────── */

test('The gate names what the advanced page adds, in three lines', () => {
  const { GATE_LINES } = new Function(
    `${constantSource('GATE_LINES')}\nreturn { GATE_LINES };`
  )();
  assert.deepStrictEqual(
    GATE_LINES.map((line) => line.text),
    [
      'Sensitivity and threshold',
      'Pair anything by hand',
      'Every group as a list, sort and select',
    ],
    'the gate lines are the three things only the advanced page has'
  );
  const icons = read('public', 'icons.svg');
  GATE_LINES.forEach((line) => {
    assert.ok(
      icons.includes(`<symbol id="${line.icon}"`),
      `the gate line "${line.text}" points at a missing icon`
    );
  });
  // The kit draws them; the page hands them over as they are.
  const mode = loadModule('public/js/modules/review-mode.js', ['htmlGate'], {
    confirmDialog: () => Promise.resolve(false),
    window: {},
  });
  const gate = mode.htmlGate(GATE_LINES);
  GATE_LINES.forEach((line) => {
    assert.ok(
      gate.includes(line.text),
      `the gate does not read "${line.text}"`
    );
  });
});

/* ── 4. the empty card ────────────────────────────────────────────────────── */

test('The page opens on one card with one button', () => {
  [page, offered].forEach((markup) => {
    const card =
      /<div class="zr-emptycard dup-empty" id="dupEmpty" data-simple>([\s\S]*?)<\/div>/.exec(
        markup
      );
    assert.ok(card, 'the empty card is missing');
    assert.match(
      card[1],
      /icons\.svg#i-wand/,
      'the card has no icon of its own'
    );
    assert.ok(
      card[1].includes(
        '<button class="zr-btn zr-btn--primary" id="dupFindBtn" type="button">Find duplicates</button>'
      ),
      'the card has no primary "Find duplicates"'
    );
    assert.strictEqual(
      (card[1].match(/<button/g) || []).length,
      1,
      'one card, one button'
    );
    assert.ok(!card[1].includes('<p'), 'the card explains nothing');
  });
  assert.match(
    functionBody('initSimple'),
    /el\.findBtn\.addEventListener\('click', findDuplicates\)/,
    'the button does not start the one flow of the simple page'
  );
});

test('The one button scans first, on the meter, and the sheet opens on its numbers', () => {
  const body = functionBody('findDuplicates');
  const scan = body.indexOf('await runScan(options, { meter: true });');
  const held = body.indexOf('simple.held = true;');
  const sheet = body.indexOf('if (!(await confirmRun(options))) return;');
  const released = body.indexOf('simple.held = false;');
  const ask = body.indexOf('askForVerdicts({ includeCandidates: true }');
  assert.ok(scan > -1, 'the scan does not come first');
  assert.ok(
    scan < held && held < sheet && sheet < released && released < ask,
    'scan, then the sheet over the card, then Start lets the run show'
  );
  // The scan phase is the run meter's own: its phase line, no Stop.
  const phase = functionBody('showScanPhase');
  assert.ok(
    phase.includes("phaseHeadline({ phase: 'scanning' })"),
    'the meter does not name the scan'
  );
  assert.ok(
    phase.includes("el.aiStopBtn.classList.add('hidden')"),
    'a scan cannot be stopped, so the meter offers no Stop'
  );
  const runScan = functionBody('runScan');
  assert.ok(
    runScan.includes('if (meter) showScanPhase();') &&
      runScan.includes('if (meter) hideProgressPanel();'),
    'the scan phase is not shown and taken down around the scan'
  );
  // Any new scan, and any answer, lets the result show again.
  assert.ok(runScan.includes('simple.held = false;'));
  assert.ok(functionBody('applyReviewResult').includes('simple.held = false;'));
});

test('The card gives way to the run and the result, and comes back with neither', () => {
  const run = (flags) => {
    const el = {
      result: fakeElement(['hidden']),
      empty: fakeElement(),
      findBtn: fakeElement(),
      aiProgress: fakeElement(flags.live ? ['dup-progress--live'] : []),
    };
    const { updateSimpleSurface } = helpers(['updateSimpleSurface'], {
      globals: Object.assign(
        {
          el,
          scanned: false,
          proposing: false,
          scanning: false,
          aiReviewing: false,
          merging: false,
          simple: { held: flags.held === true },
        },
        flags.state
      ),
    });
    updateSimpleSurface();
    return {
      result: !el.result.classList.contains('hidden'),
      empty: !el.empty.classList.contains('hidden'),
      button: el.findBtn.textContent,
      disabled: el.findBtn.disabled,
    };
  };
  // Nothing found yet: the card, and its button ready.
  assert.deepStrictEqual(run({ state: {} }), {
    result: false,
    empty: true,
    button: 'Find duplicates',
    disabled: false,
  });
  // The scan before a run: the card says so on its button.
  assert.deepStrictEqual(run({ state: { scanning: true, proposing: true } }), {
    result: false,
    empty: true,
    button: 'Scanning…',
    disabled: true,
  });
  // The scan of the one button runs on the meter: the card steps aside.
  assert.deepStrictEqual(
    run({ live: true, state: { scanning: true, proposing: true } }),
    { result: false, empty: false, button: 'Scanning…', disabled: true }
  );
  // The sheet after the scan: the card stays behind it, its button waiting.
  assert.deepStrictEqual(
    run({ held: true, state: { scanned: true, proposing: true } }),
    { result: false, empty: true, button: 'Find duplicates', disabled: true }
  );
  // Cancel: the card again, ready, and the scan's result not shown.
  assert.deepStrictEqual(run({ held: true, state: { scanned: true } }), {
    result: false,
    empty: true,
    button: 'Find duplicates',
    disabled: false,
  });
  // Start: between the scan and the job the page shows neither.
  assert.deepStrictEqual(run({ state: { scanned: true, proposing: true } }), {
    result: false,
    empty: false,
    button: 'Find duplicates',
    disabled: true,
  });
  // The model is asked: the meter is the page, the card steps aside.
  assert.deepStrictEqual(
    run({ live: true, state: { scanned: true, proposing: true } }),
    { result: false, empty: false, button: 'Find duplicates', disabled: true }
  );
  // What was found: the result, and no card.
  assert.deepStrictEqual(run({ state: { scanned: true } }), {
    result: true,
    empty: false,
    button: 'Find duplicates',
    disabled: false,
  });
});

/* ── 5. the sheet ─────────────────────────────────────────────────────────── */

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
  return helpers(['num', 'count', 'plural', 'sheetModel']);
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
      ['dupAiSweep', 'Synonym sweep', '+4 requests · +13k', false],
    ],
    'the three levers, what each costs, and the sweep off'
  );
  // The model is the one the kit draws: every number reaches the markup.
  const sheet = SHEET.htmlSheet(model);
  ['96 pairs · 12 requests', '38k', '200k limit', 'Synonym sweep'].forEach(
    (text) => {
      assert.ok(sheet.includes(text), `the drawn sheet does not say ${text}`);
    }
  );
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
    '+4 requests · +13k'
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
  // An estimate without excerpt reads names the lever plainly.
  const noReads = sheetModel(
    Object.assign({}, ESTIMATE, { extra: { sweepRequests: 0 } }),
    DRAFT
  );
  assert.deepStrictEqual(
    noReads.switches.map((one) => [one.label, one.price]),
    [
      ['Titles as context', ''],
      ['Excerpts', ''],
      ['Synonym sweep', ''],
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
  assert.ok(
    !SCRIPT.includes('Scan, then ask the model'),
    'the sheet still offers to scan first'
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
  // The estimate is asked with both levers on, so it can price them.
  const fetch = functionBody('fetchRunEstimate');
  ["sweep: 'true',", "excerpts: 'true',"].forEach((part) => {
    assert.ok(fetch.includes(part), `the estimate is asked without ${part}`);
  });
  assert.ok(
    fetch.includes('`/api/duplicates/ai-review/estimate?${params}`'),
    'the sheet does not ask the estimate route'
  );
});

/* ── 6. which checklist a group lands in ──────────────────────────────────── */

function checklistHelpers() {
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
      'isSureSame',
      'isRuleVerdict',
      'basisLabel',
      'checklistOf',
      'checklistChip',
      'checklistReason',
      'clip',
      'checklistRow',
      'unusedChecklistRow',
      'compareRows',
      'buildChecklists',
      'isTicked',
      'tickTotals',
      'mergeLabel',
      'resultHeadline',
      'resultCost',
      'htmlMiniBar',
      'htmlChecklistRow',
      'htmlChecklist',
    ],
    {
      constants: [
        'PLAIN_SCORE',
        'ASK_WARNINGS',
        'CHIP_BY_BASIS',
        'CHIP_BY_REASON',
        'REASON_BY_WARNING',
        'CHECKLIST_REASON_MAX',
        'CHECKLIST_ROWS',
        'AI_BASIS_LABELS',
        'AI_SOURCE_RULE',
      ],
    }
  );
}

test('Every kind of group lands in the list that fits it', () => {
  const { checklistOf } = checklistHelpers();
  const at = (state) => checklistOf(state.group, 0.85);
  // Settled by the spelling, or by a model that is sure.
  assert.strictEqual(at(FIXTURE.plain), 'proposed', 'an exact match');
  assert.strictEqual(at(FIXTURE.three), 'proposed', 'at or above 95%');
  assert.strictEqual(at(FIXTURE.same), 'proposed', 'a sure "same"');
  // What only a person can settle.
  assert.strictEqual(at(FIXTURE.ask), 'unsure', 'the model is unsure');
  assert.strictEqual(at(FIXTURE.apart), 'unsure', 'the model says different');
  assert.strictEqual(
    at(pairOf('fuzzy:1', { confidence: 0.88 })),
    'unsure',
    'nothing settled a spelling match below 95%'
  );
  assert.strictEqual(
    at(pairOf('owner:2', { confidence: 1, warnings: ['owner-differs'] })),
    'unsure',
    'a warning that is a question outweighs the score'
  );
  assert.strictEqual(
    at(
      pairOf('inbox:3', {
        confidence: 1,
        warnings: ['inbox-tag', 'large-group'],
      })
    ),
    'proposed',
    'a warning that is a note does not'
  );
  // A "same" the model is not sure about carries only what the scan would
  // have proposed anyway.
  const lowSame = { verdict: 'same', confidence: 'low', basis: 'typo' };
  assert.strictEqual(
    at(pairOf('low:4', { confidence: 0.9, aiVerdict: lowSame })),
    'proposed'
  );
  assert.strictEqual(
    at(pairOf('low:5', { confidence: 0.8, aiVerdict: lowSame })),
    'unsure'
  );
  // A pair only the model found, and is sure about.
  assert.strictEqual(
    at(
      pairOf('candidate:6', {
        source: 'ai-candidate',
        reasons: ['semantic'],
        confidence: 0.4,
        aiVerdict: {
          verdict: 'same',
          confidence: 'high',
          basis: 'translation',
        },
      })
    ),
    'proposed'
  );
});

test('A proposed row names its rule in a word, an unsure row its reason', () => {
  const { checklistChip, checklistReason } = checklistHelpers();
  assert.strictEqual(checklistChip(FIXTURE.plain.group), 'case');
  assert.strictEqual(checklistChip(FIXTURE.three.group), 'umlaut');
  assert.strictEqual(checklistChip(FIXTURE.same.group), 'legal form');
  assert.strictEqual(
    checklistChip({
      reasons: ['semantic'],
      aiVerdict: { verdict: 'same', confidence: 'high', basis: 'translation' },
    }),
    'translation'
  );
  assert.strictEqual(
    checklistChip({ aiVerdict: { verdict: 'same', confidence: 'high' } }),
    'model',
    'a sure model without a basis is named as the model'
  );
  assert.strictEqual(
    checklistChip({
      reasons: ['plural'],
      aiVerdict: { verdict: 'same', source: 'spelling-rule' },
    }),
    'plural',
    'a spelling rule is named by what the matcher found'
  );
  assert.strictEqual(checklistChip({ reasons: ['token-order'] }), 'word order');
  assert.strictEqual(checklistChip({ reasons: [] }), 'spelling');

  // The model's own sentence first, then its basis, then the warning, then
  // the score.
  assert.strictEqual(
    checklistReason(FIXTURE.ask.group),
    'Kontoauszug and Kontoumzug are not obviously the same word.'
  );
  assert.strictEqual(checklistReason(FIXTURE.apart.group), 'different thing');
  assert.strictEqual(
    checklistReason({ warnings: ['has-matching-rule'], confidence: 1 }),
    'matching rule on a source'
  );
  assert.strictEqual(
    checklistReason({
      confidence: 0.8,
      aiVerdict: { verdict: 'same', confidence: 'low' },
    }),
    'low confidence'
  );
  assert.strictEqual(checklistReason({ confidence: 0.88 }), '88% alike');
});

/* ── 7. the three checklists and the head ─────────────────────────────────── */

const STATES = [
  FIXTURE.plain,
  FIXTURE.same,
  FIXTURE.ask,
  FIXTURE.three,
  FIXTURE.apart,
];

test('The three checklists are sorted from a scan, most documents first', () => {
  const { buildChecklists } = checklistHelpers();
  const lists = buildChecklists(STATES, UNUSED, 0.85);
  assert.deepStrictEqual(
    lists.proposed.map((row) => [
      row.target,
      row.documents,
      row.writes,
      row.chip,
    ]),
    [
      ['Rechnung', 37, 38, 'case'],
      ['Müller GmbH', 9, 10, 'legal form'],
      ['Bücherei', 8, 10, 'umlaut'],
    ],
    'proposed: what moves, what it writes and why, most documents first'
  );
  assert.deepStrictEqual(
    lists.unsure.map((row) => [row.target, row.documents, row.writes]),
    [
      ['Auto', 12, 13],
      ['Kontoauszug', 4, 5],
    ]
  );
  assert.deepStrictEqual(
    lists.unused.map((row) => [row.key, row.name, row.writes]),
    [
      ['u:tags:70', 'Old <b>', 1],
      ['u:correspondents:71', 'Nobody', 1],
    ],
    'unused: in the order of the scan, one deletion each'
  );
  // An unused object a group on the list merges is that row's, not a second
  // deletion: once as a source, once as the name the merge keeps.
  const overlap = buildChecklists(
    STATES,
    UNUSED.concat([
      { kind: 'tags', record: { id: 2, name: 'rechnungen' } },
      { kind: 'correspondents', record: { id: 5, name: 'Müller GmbH' } },
      { kind: 'correspondents', record: { id: 2, name: 'Not a tag' } },
    ]),
    0.85
  );
  assert.deepStrictEqual(
    overlap.unused.map((row) => row.key),
    ['u:tags:70', 'u:correspondents:71', 'u:correspondents:2'],
    'a group member is not offered for deletion as well; the kind counts'
  );
  // A group merged already is off the lists, and its names stay off Unused.
  const merged = buildChecklists(
    STATES.filter((state) => state !== FIXTURE.plain),
    [{ kind: 'tags', record: { id: 2, name: 'rechnungen' } }],
    0.85,
    STATES
  );
  assert.deepStrictEqual(merged.unused, [], 'a merged-away name is not left');
  const three = lists.proposed[2];
  assert.deepStrictEqual(three.sources, ['Buecherei', 'buecherei']);
  assert.strictEqual(three.key, 'g:tags:20-21-22');
  assert.strictEqual(three.groupId, 'tags:20-21-22');
  // A long sentence of the model is cut for the row and kept whole as its
  // title.
  const long = 'x'.repeat(90);
  const cut = buildChecklists(
    [
      pairOf('long:1', {
        aiVerdict: { verdict: 'unsure', reason: long },
      }),
    ],
    [],
    0.85
  ).unsure[0];
  assert.strictEqual(cut.reason.length, 64);
  assert.ok(cut.reason.endsWith('…'), 'a cut reason says it was cut');
  assert.strictEqual(cut.reasonTitle, long);
});

test('The head counts what is ticked, and follows every tick', () => {
  const { buildChecklists, isTicked, tickTotals, mergeLabel } =
    checklistHelpers();
  const lists = buildChecklists(STATES, UNUSED, 0.85);
  const ticks = new Map();
  // Proposed and unused start ticked, unsure does not.
  assert.strictEqual(isTicked(lists.proposed[0], ticks), true);
  assert.strictEqual(isTicked(lists.unsure[0], ticks), false);
  assert.strictEqual(isTicked(lists.unused[0], ticks), true);
  let totals = tickTotals(lists, ticks);
  assert.deepStrictEqual(totals, { merges: 3, writes: 60 });
  assert.strictEqual(
    mergeLabel(totals.merges, totals.writes),
    'Merge 3 · 60 writes'
  );
  // Untick a proposed row, tick an unsure one: both numbers move.
  ticks.set(lists.proposed[0].key, false);
  ticks.set(lists.unsure[0].key, true);
  totals = tickTotals(lists, ticks);
  assert.deepStrictEqual(totals, { merges: 3, writes: 35 });
  // An unused object deletes; it is a write, not a merge.
  ticks.set(lists.unused[0].key, false);
  ticks.set(lists.unused[1].key, false);
  assert.deepStrictEqual(tickTotals(lists, ticks), { merges: 3, writes: 33 });
  assert.strictEqual(mergeLabel(1, 1), 'Merge 1 · 1 write');
  assert.strictEqual(mergeLabel(1234, 5678), 'Merge 1,234 · 5,678 writes');
  // The button follows the ticks, and nothing else does.
  const change =
    /el\.checklists\.addEventListener\('change', \(event\) => \{[\s\S]*?\n {4}\}\);/.exec(
      functionBody('initSimple')
    );
  assert.ok(change, 'the checklists have no change handler');
  assert.ok(
    change[0].includes('simple.ticks.set(box.dataset.key, box.checked);') &&
      change[0].includes('updateResultButton();') &&
      !change[0].includes('renderSimple'),
    'a tick must move the numbers of the button, not redraw the lists'
  );
  assert.ok(
    functionBody('updateResultButton').includes(
      'el.resultMergeBtn.textContent = mergeLabel(totals.merges, totals.writes);'
    ),
    'the button does not say its numbers'
  );
});

test('The headline counts what was scanned and what is proposed', () => {
  const { resultHeadline, resultCost } = checklistHelpers();
  assert.strictEqual(
    resultHeadline({ tags: 200, correspondents: 75 }, 34),
    '275 scanned · 34 merges proposed'
  );
  assert.strictEqual(
    resultHeadline({ tags: 1 }, 1),
    '1 scanned · 1 merge proposed'
  );
  assert.strictEqual(resultHeadline(null, 0), '0 merges proposed');

  // What the run behind the result cost, and the split of its tokens.
  const cost = resultCost(
    { requests: 12, tokens: 38000 },
    {
      elapsedMs: 120000,
      promptTokens: 24000,
      completionTokens: 6000,
      thinkingTotal: 8000,
    },
    true
  );
  assert.strictEqual(cost.text, '12 requests · 38k tokens · ~2 min');
  assert.deepStrictEqual(cost.split, {
    prompt: 24000,
    completion: 6000,
    thinking: 8000,
  });
  assert.deepStrictEqual(resultCost({ requests: 1, tokens: 0 }, null, true), {
    text: '1 request',
    split: null,
  });
  // No run behind the result: no cost line, whatever the instance offers.
  assert.deepStrictEqual(resultCost(null, null), { text: '', split: null });
  assert.deepStrictEqual(resultCost(null, null, false), {
    text: '',
    split: null,
  });
});

test('A checklist draws ten rows, its count, and a button for the rest', () => {
  const { buildChecklists, htmlChecklist, htmlMiniBar } = checklistHelpers();
  const many = Array.from({ length: 12 }, (_, index) =>
    pairOf(`many:${index + 1}`, { confidence: 1 })
  );
  const lists = buildChecklists(many, [], 0.85);
  const closed = htmlChecklist('proposed', 'Proposed', lists.proposed, {
    ticks: new Map(),
    open: false,
  });
  assert.ok(
    closed.includes('Proposed <span class="zr-checklist__count">· 12</span>'),
    'the head does not count its rows'
  );
  assert.strictEqual(
    (closed.match(/class="zr-checklist__row/g) || []).length,
    10,
    'ten rows before the rest is asked for'
  );
  assert.ok(
    closed.includes('data-list="proposed">2 more</button>'),
    'the rest is not offered'
  );
  const open = htmlChecklist('proposed', 'Proposed', lists.proposed, {
    ticks: new Map(),
    open: true,
  });
  assert.strictEqual(
    (open.match(/class="zr-checklist__row/g) || []).length,
    12
  );
  assert.ok(!open.includes('more</button>'));
  assert.strictEqual(
    htmlChecklist('unsure', 'Unsure', [], { ticks: new Map(), open: false }),
    '',
    'an empty list is not drawn'
  );

  // One row of each list: ticked or not, dim or not, and escaped.
  const mixed = buildChecklists(STATES, UNUSED, 0.85);
  const proposed = htmlChecklist('proposed', 'Proposed', mixed.proposed, {
    ticks: new Map(),
    open: false,
  });
  assert.ok(
    proposed.includes('data-key="g:tags:1-2" checked>'),
    'a proposed row starts ticked'
  );
  assert.ok(
    proposed.includes(
      'rechnungen<span class="dup-checklist__arrow"> → </span><span class="zr-checklist__name">Rechnung</span>'
    ),
    'a row reads as what goes into what'
  );
  assert.ok(
    proposed.includes('Müller GmbH &amp; Co. KG'),
    'names are user data and must be escaped'
  );
  assert.ok(proposed.includes('<span class="zr-checklist__chip">case</span>'));
  const unsure = htmlChecklist('unsure', 'Unsure', mixed.unsure, {
    ticks: new Map(),
    open: false,
    htmlAction: '<button type="button">x</button>',
  });
  assert.ok(
    unsure.includes('zr-checklist__row--dim') && !unsure.includes(' checked>'),
    'an unsure row starts dim and unticked'
  );
  assert.ok(
    unsure.includes('title="different thing">different thing</span>'),
    'an unsure row says why it is unsure'
  );
  const unused = htmlChecklist('unused', 'Unused', mixed.unused, {
    ticks: new Map(),
    open: false,
  });
  assert.ok(unused.includes('Old &lt;b&gt;'));
  assert.ok(unused.includes('0 documents · delete'));

  // The small bar of the cost line splits the run's own tokens.
  const bar = htmlMiniBar({ prompt: 24000, completion: 6000, thinking: 10000 });
  assert.ok(bar.includes('zr-tokenbar zr-tokenbar--mini'));
  assert.ok(bar.includes('style="width: 60%"'));
  assert.ok(bar.includes('style="width: 25%"'));
  assert.ok(bar.includes('24k question · 6k answer · 10k thinking'));
});

test('The result is one head, three lists and one button that asks once', () => {
  const render = functionBody('renderSimple');
  [
    "htmlChecklist('proposed', 'Proposed', lists.proposed,",
    "htmlChecklist('unsure', 'Unsure', lists.unsure,",
    "htmlChecklist('unused', 'Unused', lists.unused,",
  ].forEach((call) => {
    assert.ok(render.includes(call), `the result does not draw ${call}`);
  });
  assert.ok(
    render.includes('Review one by one'),
    'the unsure list has no way into the stack'
  );
  assert.ok(
    render.includes('lists.unsure.length > 0'),
    'the stack is offered only when something is unsure'
  );
  // The one button: one question, then the merges, then the deletes.
  const merge = functionBody('mergeTicked');
  assert.ok(
    merge.indexOf('await confirmMerge(entries, unused)') <
      merge.indexOf('await runBatch(entries, answer.copyMatchingRule)'),
    'nothing is written before the one question'
  );
  assert.ok(
    merge.indexOf('await runBatch(') <
      merge.indexOf('await deleteUnusedEntries('),
    'the merges come before the deletes'
  );
  assert.ok(
    !/ai-review|askForVerdicts/.test(merge),
    'merging what is ticked never asks the model'
  );
  // The rows are the cards of the advanced page read another way.
  assert.ok(
    functionBody('currentChecklists').includes('eachGroupCard('),
    'the lists are built from something other than the cards'
  );
});

/* ── 8. the history line ──────────────────────────────────────────────────── */

test('The history line counts the merges of the newest day', () => {
  const { historyOf, shortDay } = helpers(
    [
      'num',
      'count',
      'plural',
      'isDeleteEntry',
      'isSplitEntry',
      'parseDay',
      'shortDay',
      'historyOf',
    ],
    {
      constants: ['MONTHS', 'LOG_ACTION_DELETE', 'LOG_ACTION_SPLIT'],
    }
  );
  const now = new Date(2026, 8, 23, 12, 0, 0);
  const history = historyOf(
    [
      { id: 9, status: 'done', createdAt: '2026-09-19 10:00:00' },
      { id: 10, status: 'partial', createdAt: '2026-09-20 09:12:00' },
      { id: 11, status: 'done', createdAt: '2026-09-20 15:00:00' },
      {
        id: 12,
        action: 'delete',
        status: 'done',
        createdAt: '2026-09-21 08:00:00',
      },
      {
        id: 13,
        action: 'split',
        status: 'done',
        createdAt: '2026-09-22 08:00:00',
      },
      { id: 14, status: 'undone', createdAt: '2026-09-22 09:00:00' },
    ],
    now
  );
  assert.strictEqual(history.text, 'History · 2 merges on 20 Sep');
  assert.strictEqual(history.entry.id, 11, 'Undo takes back the newest merge');
  assert.strictEqual(
    historyOf(
      [{ id: 1, status: 'undo_failed', createdAt: '2026-09-23 08:00:00' }],
      now
    ).text,
    'History · 1 merge on 23 Sep',
    'a failed undo can be tried again, so it still counts'
  );
  assert.strictEqual(historyOf([], now), null, 'no merges, no line');
  assert.strictEqual(
    historyOf([{ id: 2, action: 'delete', status: 'done' }], now),
    null,
    'a delete is not a merge'
  );
  assert.strictEqual(shortDay('2025-12-31 10:00:00', now), '31 Dec 2025');
  assert.strictEqual(shortDay('', now), '');
  assert.strictEqual(shortDay('nonsense', now), '');

  // The view carries the line hidden, and the script reads merges only.
  assert.match(
    page,
    /<p class="zr-historyline hidden" id="dupHistoryLine">[\s\S]*?id="dupHistoryText"[\s\S]*?id="dupHistoryUndoBtn" type="button">Undo<\/button>/,
    'the line needs its text and its Undo'
  );
  assert.ok(
    functionBody('loadHistory').includes(
      "new URLSearchParams({ action: 'merge', limit: '100' })"
    ),
    'the line must ask the log for merges only'
  );
  assert.match(
    functionBody('loadLog'),
    /loadHistory\(\)/,
    'the line must follow the log whenever it is reloaded'
  );
});

/* ── 9. the stack ─────────────────────────────────────────────────────────── */

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
      'memberMetaText',
      'htmlDecisionSamples',
      'htmlDecisionSide',
      'htmlDecisionHead',
      'htmlDecisionMembers',
      'mergeFactsText',
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

test('A decision ticks or unticks a row, comes round again, and is taken back', () => {
  const groups = new Map(['a', 'b', 'c'].map((id) => [id, { group: { id } }]));
  const simple = { ticks: new Map() };
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
        simple,
        renderSimple: noop,
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
  assert.strictEqual(simple.ticks.get('g:a'), true, 'Merge ticks the row');
  assert.strictEqual(at(), 'b');
  kit.stackLater();
  assert.strictEqual(at(), 'c', 'Later moves on');
  kit.stackDecide(false);
  assert.strictEqual(simple.ticks.get('g:c'), false, 'Keep both unticks it');
  // The end of the queue brings back what was put off.
  assert.strictEqual(at(), 'b', 'a pair put off comes round again');
  assert.strictEqual(
    kit.stackTallyText(),
    '1 to merge · 1 kept apart · 1 later'
  );
  kit.stackDecide(true);
  assert.strictEqual(at(), null, 'every pair has its answer');
  assert.strictEqual(
    kit.stackTallyText(),
    '2 to merge · 1 kept apart · 0 later'
  );

  // Undo takes back the last decision and puts the stack where it was made.
  kit.stackUndo();
  assert.strictEqual(at(), 'b');
  assert.strictEqual(simple.ticks.has('g:b'), false, 'the tick goes with it');
  assert.strictEqual(
    kit.stackTallyText(),
    '1 to merge · 1 kept apart · 1 later'
  );
  kit.stackUndo();
  assert.strictEqual(at(), 'c');
  assert.strictEqual(simple.ticks.has('g:c'), false);

  // Nothing of this sends a request: a decision is a tick, and the one
  // button of the result head writes.
  ['stackDecide', 'stackLater', 'stackUndo', 'stackAdvance'].forEach((name) => {
    const body = functionBody(name);
    ['postJson(', 'requestJson(', 'fetch(', 'mergeGroup('].forEach((call) => {
      assert.ok(!body.includes(call), `${name}() must not call ${call}`);
    });
  });
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
    bar.includes('`${count(left)} left`'),
    'the bar does not say how many are left'
  );
  assert.ok(
    functionBody('openStack').includes(
      'stack.total = new Set(stack.ids).size;'
    ),
    'a pair must be counted once, however often it comes round'
  );
  // "Review one by one" opens the stack on the unsure rows.
  assert.match(
    functionBody('initSimple'),
    /openStack\(currentChecklists\(\)\.unsure\.map\(\(row\) => row\.groupId\)\)/,
    'the stack does not open on the unsure list'
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
  assert.match(
    body,
    /el\.stack\.classList\.contains\('hidden'\)\) return;/,
    'a closed stack must not answer keys'
  );
  // The buttons of the card do what the keys do, through one listener.
  const init = functionBody('initStack');
  [
    ["'.dup-stack-merge'", 'stackDecide(true)'],
    ["'.dup-stack-keep'", 'stackDecide(false)'],
    ["'.dup-stack-later'", 'stackLater()'],
  ].forEach(([hook, call]) => {
    assert.ok(
      init.includes(hook) && init.includes(call),
      `${hook} does not do ${call}`
    );
  });
  assert.ok(
    !/\son(click|keydown)\s*=/.test(SCRIPT),
    'the page script built an inline handler'
  );
  // The view: the stack is focusable, and its foot has Undo and Close.
  assert.match(
    page,
    /<section class="dup-stack hidden" id="dupStack" tabindex="-1"/,
    'the stack cannot take the focus its keys need'
  );
  assert.match(
    page,
    /id="dupStackUndoBtn" type="button" disabled>[\s\S]*?Undo\s*<\/button>/,
    'the stack has no Undo'
  );
  assert.ok(
    page.includes('id="dupStackCloseBtn" type="button">Back</button>'),
    'the stack has no Close'
  );
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
      'formatElapsed',
      'reqlogWhatText',
      'reqlogCostText',
      'htmlLiveRequestRow',
      'htmlRequestLog',
      'runPositionText',
    ],
    { constants: ['htmlMarks'] }
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
  // An answered request says what it asked and what came back, with the
  // share of its tokens that went into reasoning.
  assert.ok(
    log.includes('Request 12 · 50 pairs · 50 answered'),
    `an answered request is not worded: ${log}`
  );
  assert.ok(
    log.includes('61k · 38k of it thinking'),
    'an answered request does not split its tokens'
  );
  assert.ok(
    log.includes('Request 11 · 50 pairs · 31 answered · the rest asked again'),
    'a partial request reads like a finished one'
  );
  // The two that wasted tokens are marked, and say what happened in numbers.
  assert.strictEqual(
    (log.match(/zr-reqlog__row--warn/g) || []).length,
    2,
    'an empty and a failed request must both be marked'
  );
  assert.ok(
    log.includes('Request 9 · 25k tokens of thinking · no answer'),
    `an empty request does not say what it cost for nothing: ${log}`
  );
  assert.ok(
    log.includes('Request 8 · failed · 50 pairs marked unsure'),
    'a failed request does not say where its pairs went'
  );
  assert.ok(
    log.includes('1:52'),
    'a request over a minute is not shown as a clock'
  );
  assert.ok(log.includes('44 s'), 'a short request is shown in seconds');
  assert.strictEqual(
    kit.htmlRequestLog({}),
    '',
    'an empty log renders nothing'
  );
  // The request in flight is the first row of the log, which is where
  // "thinking" belongs: on the request that is thinking.
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
    live.includes('Request 13 · 50 pairs · 21 answered'),
    'the running row does not say where it is'
  );
  assert.ok(
    live.includes('89k so far · thinking'),
    'the running row does not say what it has spent, or that it is thinking'
  );
  assert.strictEqual(
    kit.htmlLiveRequestRow({ requestTokens: 0, thinking: false }),
    '',
    'a run between two requests has nothing in flight to show'
  );
});

test('The run meter counts what is spent against what was estimated', () => {
  const ledger = functionBody('renderRunLedger');
  assert.ok(
    ledger.includes('estimatedTokens'),
    'what has been spent is not held against what was estimated'
  );
  assert.ok(
    ledger.includes("'elapsed'") &&
      ledger.includes("'pairs'") &&
      ledger.includes("'tokens'"),
    'three numbers: how long, how far, how much'
  );
  // The limit belongs to the run, and it is only named once it is close
  // enough to matter.
  const ceiling = functionBody('renderRunCeiling');
  assert.ok(
    ceiling.includes('CEILING_SHOWN_ABOVE') &&
      ceiling.includes(
        '`${formatTokens(spent)} of the ${formatTokens(budget)} limit`'
      ),
    "the ceiling is not named as the run's, or is named too early"
  );
  // The split comes from the three counts the job reports separately, and
  // the reasoning is the run's total rather than the request in flight.
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
  assert.ok(
    functionBody('renderProgress').includes('renderRunMeter(state)'),
    'a progress event does not reach the run meter'
  );
  // The view keeps the meter's markup and ids.
  [
    'dupRunLedger',
    'dupRunTokenbar',
    'dupRunSegPrompt',
    'dupRunSegAnswer',
    'dupRunSegThinking',
    'dupRunLegend',
    'dupRunLog',
  ].forEach((id) => {
    assert.ok(offered.includes(`id="${id}"`), `#${id} is missing`);
  });
});

/* ── 11. applying ─────────────────────────────────────────────────────────── */

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
    body.includes('renderSimple();'),
    'the simple page does not follow what a batch merged'
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

/* ── 12. the advanced page ────────────────────────────────────────────────── */

/** The rendered page between its root and its script, tags stripped. */
function visibleText(markup) {
  const start = markup.indexOf('<div class="dup-page"');
  const end = markup.indexOf('<script type="module" src="/js/duplicates.js">');
  return markup
    .slice(start, end)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('The advanced page carries its controls, named in a word or two', () => {
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
    assert.ok(tools.includes(label), `the advanced page has no "${label}"`);
  });
  // The switch of the scan row is a toggle, the way the kit draws one.
  assert.match(
    offered,
    /<input type="checkbox" class="zr-toggle" id="dupIncludeDismissed">/,
    'hidden pairs are not a switch'
  );
});

test('No paragraph on the page explains anything', () => {
  [page, offered].forEach((markup) => {
    const root = markup.slice(
      markup.indexOf('<div class="dup-page"'),
      markup.indexOf('<script type="module" src="/js/duplicates.js">')
    );
    const prose = [...root.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
      .map((match) =>
        match[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter((text) => text !== '');
    // The sentence under the title, and the Undo of the history line; every
    // other paragraph is a place the script writes numbers into.
    assert.deepStrictEqual(
      prose,
      ['Merge tags and correspondents that mean the same thing.', '· Undo'],
      `a paragraph of prose is back: ${prose.join(' | ')}`
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
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
