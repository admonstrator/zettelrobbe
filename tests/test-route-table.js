// @ts-check
'use strict';

/**
 * The route table is part of the contract of the route layer: which method and
 * path exist, and which guards and middleware run in front of each handler.
 *
 * tests/fixtures/route-table.json lists every route as "METHOD /path" with its
 * ordered guard chain (router-level guards that apply, then route-level
 * middleware). The test builds the real routers (routes/oidc.js,
 * routes/tidyUp.js, routes/index.js) and fails on any difference, so a route
 * lost or added by accident, or a guard dropped in a move, cannot pass.
 * Handler code is not part of the fixture; scripts/route-proof.js proves that
 * per move.
 *
 * After a deliberate change:  node tests/test-route-table.js --update
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  buildSnapshot,
  compareOpenApi,
  compareSnapshots,
  installMountPathRecorder,
  snapshotOfRouter,
  toFixture,
} = require('../scripts/route-proof');

let passed = 0;
let failed = 0;
/**
 * @param {string} label
 * @param {() => void} fn
 */
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(
      `  ✗ ${label}: ${error instanceof Error ? error.message : error}`
    );
  }
};

/**
 * The proof tooling itself: a route moved from a flat router into a router
 * mounted inside an aggregator must give the same table, and a change must show.
 */
function checkTooling() {
  installMountPathRecorder();
  const express = require(
    path.join(__dirname, '..', 'node_modules', 'express')
  );
  const guard = function guard(
    /** @type {any} */ _req,
    /** @type {any} */ _res,
    /** @type {() => void} */ next
  ) {
    next();
  };
  const other = function other(
    /** @type {any} */ _req,
    /** @type {any} */ _res,
    /** @type {() => void} */ next
  ) {
    next();
  };
  const auth = function auth(
    /** @type {any} */ _req,
    /** @type {any} */ _res,
    /** @type {() => void} */ next
  ) {
    next();
  };
  const handler = (/** @type {any} */ _req, /** @type {any} */ res) =>
    res.json({ ok: true });

  const flat = express.Router();
  flat.use(guard);
  flat.use('/admin', other);
  flat.get('/api/things/:id', auth, handler);
  flat.post('/admin/reset', handler);

  const feature = express.Router();
  feature.get('/things/:id', auth, handler);
  const adminFeature = express.Router();
  adminFeature.post('/reset', handler);
  const nested = express.Router();
  nested.use(guard);
  nested.use('/admin', other);
  nested.use('/api', feature);
  nested.use('/admin', adminFeature);

  const before = snapshotOfRouter(flat);
  const after = snapshotOfRouter(nested);

  check(
    'a route moved into a nested router keeps path, guards and handler',
    () => {
      assert.deepStrictEqual(
        before.routes.map((r) => `${r.method} ${r.path}`),
        ['GET /api/things/:id', 'POST /admin/reset']
      );
      const result = compareSnapshots(before, after);
      assert.ok(result.identical, result.report.join('\n'));
    }
  );

  check('a guard mounted on /admin applies to /admin routes only', () => {
    const byPath = Object.fromEntries(
      before.routes.map((r) => [r.path, r.guards])
    );
    assert.deepStrictEqual(byPath['/api/things/:id'], ['guard']);
    assert.deepStrictEqual(byPath['/admin/reset'], ['guard', 'other']);
  });

  check(
    'an edited handler, a lost route and a dropped guard are reported',
    () => {
      const edited = express.Router();
      edited.use(guard);
      edited.use('/admin', other);
      edited.get(
        '/api/things/:id',
        (/** @type {any} */ _req, /** @type {any} */ res) =>
          res.json({ ok: false })
      );
      const result = compareSnapshots(before, snapshotOfRouter(edited));
      const text = result.report.join('\n');
      assert.ok(!result.identical);
      assert.match(text, /Routes removed[^]*POST \/admin\/reset/);
      assert.match(
        text,
        /Guards or middleware changed[^]*GET \/api\/things\/:id/
      );
      assert.match(text, /Handler source changed[^]*\+ {3}.*ok: false/);
      assert.ok(
        compareSnapshots(before, snapshotOfRouter(edited), {
          ignoreMiddleware: true,
        })
          .report.join('\n')
          .indexOf('Guards or middleware') === -1
      );
    }
  );

  check(
    'OpenAPI comparison ignores key order and reports differing pointers',
    () => {
      const a = {
        openapi: '3.0.0',
        paths: { '/a': { get: { summary: 'x' } }, '/b': { get: {} } },
      };
      const reordered = {
        paths: { '/b': { get: {} }, '/a': { get: { summary: 'x' } } },
        openapi: '3.0.0',
      };
      assert.deepStrictEqual(compareOpenApi(a, reordered), []);
      const changed = {
        openapi: '3.0.0',
        paths: { '/a': { get: { summary: 'y' } } },
      };
      const lines = compareOpenApi(a, changed);
      assert.ok(
        lines.some((line) => line.startsWith('/paths/~1a/get/summary'))
      );
      assert.ok(lines.some((line) => line.startsWith('/paths/~1b')));
    }
  );
}

const FIXTURE = path.join(__dirname, 'fixtures', 'route-table.json');

/**
 * @param {string[]} guards
 * @returns {string}
 */
const chain = (guards) =>
  guards.length > 0 ? guards.join(' > ') : '(no guards)';

/**
 * @param {Array<{ route: string, guards: string[] }>} expected
 * @param {Array<{ route: string, guards: string[] }>} actual
 * @returns {string[]} one line per difference
 */
function differences(expected, actual) {
  const before = new Map(expected.map((entry) => [entry.route, entry.guards]));
  const after = new Map(actual.map((entry) => [entry.route, entry.guards]));
  /** @type {string[]} */
  const lines = [];
  for (const [route, guards] of after) {
    const old = before.get(route);
    if (!old) lines.push(`+ added:    ${route}   [${chain(guards)}]`);
    else if (JSON.stringify(old) !== JSON.stringify(guards)) {
      lines.push(
        `~ guards:   ${route}\n      expected [${chain(old)}]\n      actual   [${chain(guards)}]`
      );
    }
  }
  for (const route of before.keys()) {
    if (!after.has(route)) lines.push(`- removed:  ${route}`);
  }
  return lines;
}

(async () => {
  checkTooling();
  const snapshot = await buildSnapshot();
  const actual = toFixture(snapshot);

  if (process.argv.includes('--update')) {
    let text = `${JSON.stringify(actual, null, 2)}\n`;
    try {
      const prettier = require('prettier');
      text = await prettier.format(text, { parser: 'json' });
    } catch {
      // The fixture is still valid JSON without prettier.
    }
    fs.writeFileSync(FIXTURE, text);
    console.log(
      `Wrote ${actual.length} routes to ${path.relative(process.cwd(), FIXTURE)}`
    );
    process.exit(0);
  }

  /** @type {Array<{ route: string, guards: string[] }>} */
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const lines = differences(expected, actual);
  if (lines.length > 0) {
    failed += 1;
    console.error(
      `  ✗ route table differs from tests/fixtures/route-table.json (${lines.length}):`
    );
    for (const line of lines) console.error(`    ${line}`);
    console.error(
      '    If the change is intended: node tests/test-route-table.js --update'
    );
  } else {
    passed += 1;
    console.log(
      `  ✓ ${actual.length} routes and their guard chains match the fixture`
    );
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
