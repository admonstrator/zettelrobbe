/**
 * Guards the dashboard configuration validator in the route modules.
 *
 * PUT /api/dashboard/layout takes a set of named dashboards straight from the
 * browser and stores it as JSON on the user row, so normalizeDashboardConfig()
 * is the only thing standing between a hostile payload and the database. It has
 * to reject anything it cannot vouch for rather than store it half-checked.
 *
 * The helpers around it are checked here too: the reset detection that decides
 * when a payload clears the row instead of filling it, and the empty
 * configuration both the reset and an unarranged dashboard answer with.
 *
 * All of them are read out of the route file instead of being copied here:
 * a copy would keep passing after the real ones changed.
 */

const assert = require('assert');
const { readRouteSources } = require('./helpers/route-sources');

const source = readRouteSources();

const start = source.indexOf('const DASHBOARD_WIDGET_ID');
const end = source.indexOf(
  '\n}',
  source.indexOf('function normalizeDashboardConfig')
);
assert.ok(
  start !== -1 && end !== -1 && end > start,
  'Could not find normalizeDashboardConfig in the route modules — did it move or get renamed?'
);

const {
  normalizeDashboardConfig,
  isDashboardResetRequest,
  emptyDashboardConfig,
} = new Function(
  `${source.slice(start, end + 2)}
   return {
     normalizeDashboardConfig,
     isDashboardResetRequest,
     emptyDashboardConfig,
   };`
)();

const widget = (overrides) => ({
  id: 'task-runner',
  span: 6,
  rows: 6,
  ...overrides,
});
const board = (overrides) => ({
  slug: 'default',
  name: 'Dashboard',
  widgets: [widget({})],
  ...overrides,
});
const config = (overrides) => ({
  version: 1,
  active: 'default',
  dashboards: [board({})],
  ...overrides,
});
const boards = (count) =>
  Array.from({ length: count }, (unused, index) =>
    board({ slug: `board-${index}`, name: `Board ${index}` })
  );

/* --- what a stored configuration may look like ---------------------------- */

const accepted = [
  {
    label: 'a configuration with two named dashboards',
    input: config({
      active: 'work',
      dashboards: [
        board({}),
        board({
          slug: 'work',
          name: 'Work',
          widgets: [widget({ id: 'entities', span: 3, rows: 0 })],
        }),
      ],
    }),
    expect: (result) => {
      assert.strictEqual(result.version, 1);
      assert.strictEqual(result.active, 'work');
      assert.strictEqual(result.dashboards.length, 2);
      assert.deepStrictEqual(result.dashboards[1], {
        slug: 'work',
        name: 'Work',
        widgets: [{ id: 'entities', span: 3, rows: 0, hidden: false }],
      });
    },
  },
  {
    label: 'an active slug no dashboard answers to, falling back to the first',
    input: config({ active: 'deleted-board' }),
    expect: (result) => assert.strictEqual(result.active, 'default'),
  },
  {
    label: 'a missing active slug, falling back to the first',
    input: (() => {
      const input = config();
      delete input.active;
      return input;
    })(),
    expect: (result) => assert.strictEqual(result.active, 'default'),
  },
  {
    label: 'hidden defaulting to false when the card does not mention it',
    input: config(),
    expect: (result) =>
      assert.strictEqual(result.dashboards[0].widgets[0].hidden, false),
  },
  {
    label: 'hidden coerced to a boolean rather than stored as it arrived',
    input: config({
      dashboards: [board({ widgets: [widget({ hidden: 'yes' })] })],
    }),
    expect: (result) =>
      assert.strictEqual(result.dashboards[0].widgets[0].hidden, true),
  },
  {
    label: 'numeric strings from a form',
    input: config({
      dashboards: [board({ widgets: [widget({ span: '6', rows: '6' })] })],
    }),
    expect: (result) => {
      assert.strictEqual(result.dashboards[0].widgets[0].span, 6);
      assert.strictEqual(result.dashboards[0].widgets[0].rows, 6);
    },
  },
  {
    label: 'rows 0 meaning "as tall as the content"',
    input: config({
      dashboards: [board({ widgets: [widget({ rows: 0 })] })],
    }),
    expect: (result) =>
      assert.strictEqual(result.dashboards[0].widgets[0].rows, 0),
  },
  {
    label: 'missing rows defaulting to 0',
    input: config({
      dashboards: [board({ widgets: [{ id: 'entities', span: 4 }] })],
    }),
    expect: (result) =>
      assert.strictEqual(result.dashboards[0].widgets[0].rows, 0),
  },
  {
    label: 'the full grid width and the tallest tile',
    input: config({
      dashboards: [board({ widgets: [widget({ span: 12, rows: 24 })] })],
    }),
    expect: (result) => {
      assert.strictEqual(result.dashboards[0].widgets[0].span, 12);
      assert.strictEqual(result.dashboards[0].widgets[0].rows, 24);
    },
  },
  {
    label: 'the card order it was sent in',
    input: config({
      dashboards: [
        board({
          widgets: [
            widget({ id: 'entities' }),
            widget({ id: 'task-runner' }),
            widget({ id: 'language-mix' }),
          ],
        }),
      ],
    }),
    expect: (result) =>
      assert.deepStrictEqual(
        result.dashboards[0].widgets.map((entry) => entry.id),
        ['entities', 'task-runner', 'language-mix']
      ),
  },
  {
    label: 'a dashboard without widgets, which shows the default arrangement',
    input: config({ dashboards: [{ slug: 'default', name: 'Dashboard' }] }),
    expect: (result) =>
      assert.deepStrictEqual(result.dashboards[0].widgets, []),
  },
  {
    label: 'an empty widget list under a name',
    input: config({ dashboards: [board({ widgets: [] })] }),
    expect: (result) =>
      assert.deepStrictEqual(result.dashboards[0].widgets, []),
  },
  {
    label: 'the same card on two dashboards',
    input: config({
      dashboards: [board({}), board({ slug: 'work', name: 'Work' })],
    }),
    expect: (result) => {
      assert.strictEqual(result.dashboards[0].widgets[0].id, 'task-runner');
      assert.strictEqual(result.dashboards[1].widgets[0].id, 'task-runner');
    },
  },
  {
    label: 'a name with padding around it, trimmed',
    input: config({ dashboards: [board({ name: '  Work  ' })] }),
    expect: (result) => assert.strictEqual(result.dashboards[0].name, 'Work'),
  },
  {
    label: 'the shortest and the longest name allowed',
    input: config({
      dashboards: [
        board({ name: 'W' }),
        board({ slug: 'long', name: 'n'.repeat(60) }),
      ],
    }),
    expect: (result) => {
      assert.strictEqual(result.dashboards[0].name, 'W');
      assert.strictEqual(result.dashboards[1].name.length, 60);
    },
  },
  {
    label: 'as many dashboards as a user may keep',
    input: config({ active: 'board-0', dashboards: boards(10) }),
    expect: (result) => assert.strictEqual(result.dashboards.length, 10),
  },
  {
    label: 'as many cards as a dashboard may hold',
    input: config({
      dashboards: [
        board({
          widgets: Array.from({ length: 50 }, (unused, index) =>
            widget({ id: `w-${index}` })
          ),
        }),
      ],
    }),
    expect: (result) =>
      assert.strictEqual(result.dashboards[0].widgets.length, 50),
  },
  {
    label: 'unknown card properties being dropped rather than stored',
    input: config({
      dashboards: [
        board({
          widgets: [widget({ evil: '<script>', nested: { a: 1 } })],
        }),
      ],
    }),
    expect: (result) =>
      assert.deepStrictEqual(Object.keys(result.dashboards[0].widgets[0]), [
        'id',
        'span',
        'rows',
        'hidden',
      ]),
  },
  {
    label: 'unknown dashboard properties being dropped',
    input: config({
      dashboards: [board({ icon: '<img onerror=alert(1)>', owner: 'root' })],
    }),
    expect: (result) =>
      assert.deepStrictEqual(Object.keys(result.dashboards[0]), [
        'slug',
        'name',
        'widgets',
      ]),
  },
  {
    label:
      'unknown top-level properties being dropped, a stray widget list among them',
    input: config({ theme: 'dark', widgets: [widget({ id: 'smuggled' })] }),
    expect: (result) =>
      assert.deepStrictEqual(Object.keys(result), [
        'version',
        'active',
        'dashboards',
      ]),
  },
];

/* --- what must never reach the database ----------------------------------- */

const rejected = [
  { label: 'no body at all', input: null },
  { label: 'a body that is an array', input: [] },
  { label: 'a body without a version', input: { dashboards: [board({})] } },
  { label: 'a version from the future', input: config({ version: 2 }) },
  {
    label: 'a version that is a string, which is a bug and not a form value',
    input: config({ version: '1' }),
  },
  { label: 'a body without dashboards', input: { version: 1 } },
  {
    label: 'dashboards that is not an array',
    input: config({ dashboards: 'all of them' }),
  },
  {
    label: 'an empty dashboards list, which is a reset and not a layout',
    input: config({ dashboards: [] }),
  },
  {
    label: 'more dashboards than a user may keep',
    input: config({ dashboards: boards(11) }),
  },
  {
    label: 'a dashboard entry that is not an object',
    input: config({ dashboards: [null] }),
  },
  {
    label: 'a dashboard entry that is an array',
    input: config({ dashboards: [[]] }),
  },
  {
    label: 'two dashboards with the same slug',
    input: config({ dashboards: [board({}), board({ name: 'Copy' })] }),
  },
  {
    label: 'an empty slug',
    input: config({ dashboards: [board({ slug: '' })] }),
  },
  {
    label: 'a slug with markup in it',
    input: config({ dashboards: [board({ slug: '<script>' })] }),
  },
  {
    label: 'a slug with an uppercase letter',
    input: config({ dashboards: [board({ slug: 'Default' })] }),
  },
  {
    label: 'a slug longer than 40 characters',
    input: config({ dashboards: [board({ slug: 'a'.repeat(41) })] }),
  },
  {
    label: 'a name that is only whitespace',
    input: config({ dashboards: [board({ name: '   ' })] }),
  },
  {
    label: 'a name of 61 characters',
    input: config({ dashboards: [board({ name: 'n'.repeat(61) })] }),
  },
  {
    label: 'a name that is not a string',
    input: config({ dashboards: [board({ name: 42 })] }),
  },
  {
    label: 'widgets that is not an array',
    input: config({ dashboards: [board({ widgets: 'all of them' })] }),
  },
  {
    label: 'a duplicate card id on one dashboard',
    input: config({
      dashboards: [board({ widgets: [widget({}), widget({})] })],
    }),
  },
  {
    label: 'an empty card id',
    input: config({ dashboards: [board({ widgets: [widget({ id: '' })] })] }),
  },
  {
    label: 'a card id with markup in it',
    input: config({
      dashboards: [board({ widgets: [widget({ id: '<script>' })] })],
    }),
  },
  {
    label: 'a card id with an underscore',
    input: config({
      dashboards: [board({ widgets: [widget({ id: 'task_runner' })] })],
    }),
  },
  {
    label: 'a card id starting with a dash',
    input: config({
      dashboards: [board({ widgets: [widget({ id: '-runner' })] })],
    }),
  },
  {
    label: 'a card id longer than 40 characters',
    input: config({
      dashboards: [board({ widgets: [widget({ id: 'a'.repeat(41) })] })],
    }),
  },
  {
    label: 'a span below the minimum',
    input: config({ dashboards: [board({ widgets: [widget({ span: 2 })] })] }),
  },
  {
    label: 'a span wider than the grid',
    input: config({ dashboards: [board({ widgets: [widget({ span: 13 })] })] }),
  },
  {
    label: 'a missing span',
    input: config({ dashboards: [board({ widgets: [{ id: 'entities' }] })] }),
  },
  {
    label: 'a non-numeric span',
    input: config({
      dashboards: [board({ widgets: [widget({ span: 'wide' })] })],
    }),
  },
  {
    label: 'more rows than a tile may have',
    input: config({ dashboards: [board({ widgets: [widget({ rows: 25 })] })] }),
  },
  {
    label: 'fewer rows than a card can show anything in',
    input: config({ dashboards: [board({ widgets: [widget({ rows: 2 })] })] }),
  },
  {
    label: 'a negative row count',
    input: config({ dashboards: [board({ widgets: [widget({ rows: -4 })] })] }),
  },
  {
    label: 'more cards than a dashboard could ever hold',
    input: config({
      dashboards: [
        board({
          widgets: Array.from({ length: 51 }, (unused, index) =>
            widget({ id: `w-${index}` })
          ),
        }),
      ],
    }),
  },
  {
    label: 'a bad card on the second dashboard, taking the whole write down',
    input: config({
      dashboards: [
        board({}),
        board({
          slug: 'work',
          name: 'Work',
          widgets: [widget({ span: 99 })],
        }),
      ],
    }),
  },
];

/* --- resetting, and the answer a dashboard nobody arranged gets ------------ */

const helpers = [
  {
    label: 'an empty dashboards list read as a reset',
    run: () =>
      assert.strictEqual(isDashboardResetRequest({ dashboards: [] }), true),
  },
  {
    label: 'a single emptied dashboard read as a reset',
    run: () =>
      assert.strictEqual(
        isDashboardResetRequest(
          config({ dashboards: [board({ widgets: [] })] })
        ),
        true
      ),
  },
  {
    label: 'one emptied dashboard among several left alone',
    run: () =>
      assert.strictEqual(
        isDashboardResetRequest(
          config({
            dashboards: [
              board({ widgets: [] }),
              board({ slug: 'work', name: 'Work' }),
            ],
          })
        ),
        false
      ),
  },
  {
    label: 'an arrangement not read as a reset',
    run: () => assert.strictEqual(isDashboardResetRequest(config()), false),
  },
  {
    label: 'a body without dashboards not read as a reset',
    run: () => {
      assert.strictEqual(isDashboardResetRequest(null), false);
      assert.strictEqual(isDashboardResetRequest({ widgets: [] }), false);
    },
  },
  {
    label: 'the empty configuration a reset and an untouched user both get',
    run: () =>
      assert.deepStrictEqual(emptyDashboardConfig(), {
        version: 1,
        active: 'default',
        dashboards: [],
      }),
  },
];

let failed = 0;

for (const { label, input, expect } of accepted) {
  try {
    const result = normalizeDashboardConfig(input);
    assert.ok(result, `${label} should be accepted`);
    expect(result);
    console.log(`  ✓ accepts ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ accepts ${label}: ${error.message}`);
  }
}

for (const { label, input } of rejected) {
  try {
    assert.strictEqual(
      normalizeDashboardConfig(input),
      null,
      `${label} should be rejected`
    );
    console.log(`  ✓ rejects ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ rejects ${label}: ${error.message}`);
  }
}

for (const { label, run } of helpers) {
  try {
    run();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${label}: ${error.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} dashboard layout validation case(s) failed`);
  process.exit(1);
}

console.log('\nAll dashboard layout validation cases passed');
