/**
 * Test: review-sheet
 *
 * The sheet a model-backed run opens first, and the mode switch of a review
 * page: both are shared modules, so both pages inherit what is checked here.
 *
 * Covers:
 *  1. tokens and time read the way the sheet says them
 *  2. requests fall into lanes fullest first, never a row of zero
 *  3. the bar's widths are shares of the limit, capped at the track
 *  4. the sheet's markup: every hook the page updates, every label escaped,
 *     no dash and no first person anywhere in it
 *  5. updateSheet moves the numbers, the bar, the rows and the switches
 *     without rebuilding the sheet
 *  6. the mode button, the gate and the stored mode
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Loads a browser ES module for node: the imports become parameters, the
 * exports a returned object. Enough for modules that only need the escaper.
 */
function loadModule(file, names, extra = {}) {
  const source = fs
    .readFileSync(path.join(__dirname, '..', file), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|function) /gm, '$1 ');
  const factory = new Function(
    'esc',
    'confirmDialog',
    'window',
    'CSS',
    `${source}\nreturn { ${names.join(', ')} };`
  );
  return factory(
    esc,
    extra.confirmDialog || (() => Promise.resolve(false)),
    extra.window || {},
    { escape: (value) => String(value).replace(/["\\]/g, '\\$&') }
  );
}

const sheet = loadModule('public/js/modules/review-sheet.js', [
  'LANE_CHOICES',
  'formatTokens',
  'roughTime',
  'laneRows',
  'shares',
  'htmlSheet',
  'updateSheet',
]);

const MODEL = {
  sub: '96 pairs · 12 requests',
  requests: 12,
  tokens: { prompt: 24000, completion: 6000, thinking: 8000 },
  limit: 200000,
  seconds: 120,
  lanes: 3,
  switches: [
    { id: 'excerpts', label: 'Excerpts · 31 reads', price: '+12k', on: true },
    { id: 'sweep', label: 'Synonym <sweep>', price: '', on: false },
  ],
  basis: 'guess',
};

console.log('\nreview-sheet');

test('Tokens read whole, then one decimal, then thousands, then millions', () => {
  assert.strictEqual(sheet.formatTokens(0), '0');
  assert.strictEqual(sheet.formatTokens(820), '820');
  assert.strictEqual(sheet.formatTokens(6320), '6.3k');
  assert.strictEqual(sheet.formatTokens(6000), '6k');
  assert.strictEqual(sheet.formatTokens(38000), '38k');
  assert.strictEqual(sheet.formatTokens(110400), '110k');
  assert.strictEqual(sheet.formatTokens(1410000), '1.4 M');
  assert.strictEqual(sheet.formatTokens(null), '0');
});

test('Time is felt, not measured', () => {
  assert.strictEqual(sheet.roughTime(0), 'under a minute');
  assert.strictEqual(sheet.roughTime(44), 'under a minute');
  assert.strictEqual(sheet.roughTime(45), '~1 min');
  assert.strictEqual(sheet.roughTime(80), '~1.5 min');
  assert.strictEqual(sheet.roughTime(120), '~2 min');
  assert.strictEqual(sheet.roughTime(360), '~6 min');
  assert.strictEqual(sheet.roughTime(540), '~9 min');
  assert.strictEqual(sheet.roughTime(5400), '~1.5 h');
});

test('Requests fall into lanes fullest first, never a row of zero', () => {
  assert.deepStrictEqual(sheet.laneRows(12, 1), [12]);
  assert.deepStrictEqual(sheet.laneRows(12, 3), [4, 4, 4]);
  assert.deepStrictEqual(sheet.laneRows(12, 8), [2, 2, 2, 2, 1, 1, 1, 1]);
  assert.deepStrictEqual(sheet.laneRows(23, 5), [5, 5, 5, 4, 4]);
  assert.deepStrictEqual(sheet.laneRows(2, 8), [1, 1]);
  assert.deepStrictEqual(sheet.laneRows(0, 3), []);
  assert.deepStrictEqual(sheet.laneRows(5, 0), [5], 'no lanes means one');
  assert.deepStrictEqual(sheet.LANE_CHOICES, [1, 3, 5, 8]);
});

test('The bar is a share of the limit, and never past the track', () => {
  const split = sheet.shares(MODEL.tokens, 200000);
  assert.strictEqual(split.total, 38000);
  assert.strictEqual(split.prompt, 12);
  assert.strictEqual(split.answer, 3);
  assert.strictEqual(split.thinking, 4);
  const over = sheet.shares(
    { prompt: 300000, completion: 0, thinking: 0 },
    200000
  );
  assert.strictEqual(
    over.prompt,
    100,
    'an estimate past the limit fills the track'
  );
  const none = sheet.shares({ prompt: 300, completion: 100, thinking: 0 }, 0);
  assert.strictEqual(
    none.prompt + none.answer,
    100,
    'without a limit the estimate is the track'
  );
  const empty = sheet.shares({}, 200000);
  assert.strictEqual(empty.total, 0);
  assert.strictEqual(empty.prompt, 0);
});

test('The sheet carries every hook, escapes every label, and says nothing in the first person', () => {
  const html = sheet.htmlSheet(MODEL);
  for (const hook of [
    'sub',
    'total',
    'time',
    'timesub',
    'seg-prompt',
    'seg-answer',
    'seg-thinking',
    'legend',
    'limit',
    'lanes',
    'rows',
    'switches',
    'basis',
  ]) {
    assert.ok(html.includes(`data-sheet="${hook}"`), `hook ${hook}`);
  }
  assert.ok(html.includes('class="zr-sheet"'));
  assert.ok(html.includes('zr-tokenbar zr-tokenbar--limit'));
  assert.ok(html.includes('>38k<'), 'the big number');
  assert.ok(html.includes('>~2 min<'), 'the time');
  assert.ok(html.includes('>3 at a time<'), 'the lanes under the time');
  assert.ok(html.includes('>200k limit<'), 'the limit at the end of the bar');
  assert.ok(
    html.includes('24k question') &&
      html.includes('6k answer') &&
      html.includes('8k thinking')
  );
  assert.ok(html.includes('data-lanes="3" aria-selected="true"'));
  assert.ok(html.includes('data-lanes="8" aria-selected="false"'));
  assert.strictEqual(
    (html.match(/class="zr-lanes__row"/g) || []).length,
    3,
    'three lanes, three rows'
  );
  assert.strictEqual(
    (html.match(/zr-lanes__block/g) || []).length,
    12,
    'twelve requests, twelve blocks'
  );
  assert.ok(
    html.includes('style="width: 33.3%"'),
    'a row of four out of twelve'
  );
  assert.ok(
    html.includes('class="zr-toggle" data-switch="excerpts" checked>'),
    'a lever is the framework toggle'
  );
  assert.ok(html.includes('class="zr-toggle" data-switch="sweep">'));
  assert.ok(html.includes('class="zr-sheet__lever"'));
  assert.ok(html.includes('Synonym &lt;sweep&gt;'), 'labels are escaped');
  assert.ok(!html.includes('<sweep>'));
  assert.ok(html.includes('Nothing is written.'));
  assert.ok(html.includes('Estimate · not measured yet'));
  assert.ok(!/[—–]/.test(html), 'no dash');
  assert.ok(!/\bI\b/.test(html), 'no first person');
  assert.ok(!/\bAI\b/.test(html));
  const bare = sheet.htmlSheet({ ...MODEL, sub: '', limit: 0, switches: [] });
  assert.ok(!bare.includes('data-sheet="sub"'), 'no sub, no line');
  assert.ok(bare.includes('data-sheet="limit"></span>'), 'no limit, no label');
  assert.ok(!bare.includes('zr-tokenbar--limit'));
  assert.ok(bare.includes('data-sheet="switches"></div>'));
  assert.ok(
    sheet.htmlSheet({ ...MODEL, basis: 'run' }).includes('Measured · last run')
  );
});

/** The smallest DOM that updateSheet needs: hooks by name, buttons by data. */
function fakeSheet(html) {
  const nodes = new Map();
  const hookNames = [...html.matchAll(/data-sheet="([^"]+)"/g)].map(
    (m) => m[1]
  );
  for (const name of hookNames) {
    nodes.set(name, {
      name,
      textContent: '',
      innerHTML: '',
      style: {},
      children: [],
    });
  }
  const laneButtons = [...html.matchAll(/data-lanes="(\d+)"/g)].map((m) => ({
    dataset: { lanes: m[1] },
    attrs: {},
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
  }));
  const switches = new Map(
    [...html.matchAll(/data-switch="([^"]+)"/g)].map((m) => [
      m[1],
      { checked: false },
    ])
  );
  nodes.get('lanes').querySelectorAll = () => laneButtons;
  nodes.get('switches').querySelector = (selector) => {
    const id = selector.match(/data-switch="([^"]+)"/)[1];
    return switches.get(id) || null;
  };
  return {
    nodes,
    laneButtons,
    switches,
    querySelector(selector) {
      const name = selector.match(/data-sheet="([^"]+)"/);
      return name ? nodes.get(name[1]) || null : null;
    },
  };
}

test('updateSheet moves the numbers, the bar, the rows and the switches in place', () => {
  const root = fakeSheet(sheet.htmlSheet(MODEL));
  sheet.updateSheet(root, {
    ...MODEL,
    requests: 16,
    tokens: { prompt: 30000, completion: 7000, thinking: 10000 },
    seconds: 60,
    lanes: 8,
    switches: [
      { id: 'excerpts', label: 'Excerpts · 31 reads', price: '+12k', on: true },
      { id: 'sweep', label: 'Synonym sweep', price: '', on: true },
    ],
    basis: 'run',
  });
  assert.strictEqual(root.nodes.get('total').textContent, '47k');
  assert.strictEqual(root.nodes.get('time').textContent, '~1 min');
  assert.strictEqual(root.nodes.get('timesub').textContent, '8 at a time');
  assert.strictEqual(root.nodes.get('seg-prompt').style.width, '15%');
  assert.strictEqual(root.nodes.get('seg-thinking').style.width, '5%');
  assert.ok(root.nodes.get('legend').innerHTML.includes('30k question'));
  assert.strictEqual(
    (root.nodes.get('rows').innerHTML.match(/zr-lanes__row/g) || []).length,
    8
  );
  assert.strictEqual(
    root.nodes.get('basis').textContent,
    'Measured · last run'
  );
  const selected = root.laneButtons.filter(
    (b) => b.attrs['aria-selected'] === 'true'
  );
  assert.deepStrictEqual(
    selected.map((b) => b.dataset.lanes),
    ['8']
  );
  const levers = root.nodes.get('switches').innerHTML;
  assert.ok(levers.includes('data-switch="sweep" checked>'), 'the sweep is on');
  assert.ok(levers.includes('data-switch="excerpts" checked>'));
  assert.ok(levers.includes('Synonym sweep'), 'the label follows the model');
  sheet.updateSheet(null, MODEL);
});

const stored = new Map();
const mode = loadModule(
  'public/js/modules/review-mode.js',
  ['MODES', 'readMode', 'writeMode', 'applyMode', 'htmlModeButton', 'htmlGate'],
  {
    window: {
      localStorage: {
        getItem: (key) => (stored.has(key) ? stored.get(key) : null),
        setItem: (key, value) => stored.set(key, value),
      },
    },
  }
);

test('The mode button says what it switches to, and the gate is three escaped lines', () => {
  const toAdvanced = mode.htmlModeButton('simple');
  assert.ok(toAdvanced.includes('data-mode-switch="advanced"'));
  assert.ok(toAdvanced.includes('#i-sliders'));
  assert.ok(toAdvanced.includes('>Advanced</button>'));
  const toSimple = mode.htmlModeButton('advanced');
  assert.ok(toSimple.includes('data-mode-switch="simple"'));
  assert.ok(toSimple.includes('#i-wand'));
  assert.ok(toSimple.includes('>Simple</button>'));
  const gate = mode.htmlGate([
    { icon: 'i-filter', text: 'Sensitivity and threshold' },
    { icon: 'i-list', text: 'Every <group> as a list' },
  ]);
  assert.strictEqual((gate.match(/zr-gate__row/g) || []).length, 2);
  assert.ok(gate.includes('#i-filter'));
  assert.ok(gate.includes('Every &lt;group&gt; as a list'));
  assert.ok(!/[—–]/.test(gate + toAdvanced + toSimple));
});

test('The stored mode is simple until someone switched, and a bad value is simple too', () => {
  assert.deepStrictEqual(mode.MODES, ['simple', 'advanced']);
  assert.strictEqual(mode.readMode('duplicates'), 'simple');
  mode.writeMode('duplicates', 'advanced');
  assert.strictEqual(mode.readMode('duplicates'), 'advanced');
  assert.strictEqual(mode.readMode('simplify'), 'simple', 'kept per page');
  mode.writeMode('duplicates', 'sideways');
  assert.strictEqual(mode.readMode('duplicates'), 'simple');
  stored.set('zr:mode:simplify', 'nonsense');
  assert.strictEqual(mode.readMode('simplify'), 'simple');
  const root = { dataset: {} };
  mode.applyMode(root, 'advanced');
  assert.strictEqual(root.dataset.mode, 'advanced');
  mode.applyMode(root, 'whatever');
  assert.strictEqual(root.dataset.mode, 'simple');
  mode.applyMode(null, 'simple');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
