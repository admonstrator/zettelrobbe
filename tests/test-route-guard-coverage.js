'use strict';

/**
 * Every route that is not public must carry its own guard.
 *
 * routes/setup.js has a router-wide guard (a pathless router.use) that keeps
 * anonymous callers out of everything that is not public. That guard is one
 * edit away from disappearing: when the router is split into one router per
 * feature, a route that moves into a new router no longer runs behind it. The
 * defence is a guard in the route's own handler stack, so a moved route stays
 * protected. This test fails for any route that has none.
 *
 * What counts as a guard: a handler in the route's own stack whose function
 * name is one of GUARD_NAMES (isAuthenticated, authenticateJWT,
 * protectApiRoute). A name is checked, not behaviour, because the behaviour is
 * covered by test-session-token-type and the endpoint-protection tests; this
 * test is the net that catches a route nobody thought about.
 *
 * What counts as public: exactly the paths the router-wide guard lets
 * through (PUBLIC_ROUTES in middleware/authGate.js, matched on whole path
 * segments), plus the explicit, commented ALLOWLIST below.
 *
 * What is walked: everything the harness mounts, recursing into nested
 * routers (a layer whose handle has a `stack` is a router), plus every module
 * in routes/ that exports a router, which the test mounts itself when the
 * harness did not. A router file added by the next refactoring step is
 * therefore covered without touching this test. Not covered: the few routes
 * declared directly in server.js, which cannot be required in-process.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

/** Handler names that make a route self-guarding. */
const GUARD_NAMES = new Set([
  'isAuthenticated',
  'authenticateJWT',
  'protectApiRoute',
]);

/**
 * Public on purpose: the paths the router-wide guard waves through
 * (PUBLIC_ROUTES in middleware/authGate.js). Pinned here on purpose: widening
 * the public list must fail this test until it is updated deliberately.
 */
const PUBLIC_PREFIXES = [
  '/health',
  '/login',
  '/logout',
  '/setup',
  '/api/setup',
  '/auth/oidc',
];

/**
 * Other routes that are public on purpose and are not under a public prefix.
 * Entries are `METHOD /path` with a one-line reason. There are none: after the
 * contract every non-public route has its own guard. Adding a line here is a
 * security decision, so say why.
 */
const ALLOWLIST = new Map([
  // ['GET /example', 'why this must be reachable without a session'],
]);

/**
 * Yields every route below a router layer stack as
 * { method, path, handlers: string[] }, recursing into nested routers.
 * Fails loudly for a router mounted under a path prefix: the prefix is not
 * recoverable from an Express 5 layer, so the paths would be wrong and the
 * public check meaningless. Extend this function when a split needs that.
 *
 * @param {any[]} stack
 * @param {string} [prefix]
 * @returns {{ method: string, path: string, handlers: string[] }[]}
 */
function collectRoutes(stack, prefix = '') {
  const found = [];
  for (const layer of stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      assert.strictEqual(
        typeof routePath,
        'string',
        `a route with a non-string path (${String(routePath)}) cannot be checked; extend the test`
      );
      const handlers = layer.route.stack.map((l) => l.name || '<anonymous>');
      const methods = Object.keys(layer.route.methods || {}).filter(
        (m) => layer.route.methods[m]
      );
      for (const method of methods.length ? methods : ['all']) {
        found.push({
          method: method.toUpperCase(),
          path: prefix + routePath,
          handlers,
        });
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      assert.ok(
        layer.slash,
        'a router is mounted under a path prefix; collectRoutes() cannot recover the prefix, extend it'
      );
      found.push(...collectRoutes(layer.handle.stack, prefix));
    }
  }
  return found;
}

function isPublic(route) {
  return (
    PUBLIC_PREFIXES.some(
      (p) => route.path === p || route.path.startsWith(`${p}/`)
    ) || ALLOWLIST.has(`${route.method} ${route.path}`)
  );
}

/** The routes that are not public and have no guard in their own handler stack. */
function findUnguarded(routes) {
  return routes.filter(
    (r) => !isPublic(r) && !r.handlers.some((h) => GUARD_NAMES.has(h))
  );
}

function describe(r) {
  return `${r.method} ${r.path} [${r.handlers.join(', ')}]`;
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌  ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

/** True when the value is an Express router (or app) with a layer stack. */
function isRouter(value) {
  return typeof value === 'function' && Array.isArray(value.stack);
}

/** All routers in the harness app's stack, direct children only. */
function mountedRouters(app) {
  return app.router.stack
    .map((layer) => layer.handle)
    .filter((handle) => isRouter(handle));
}

(async () => {
  const harness = await mountRouter();

  // Every routes/*.js that exports a router must be part of what is walked.
  const routeFiles = fs
    .readdirSync(path.join(REPO_ROOT, 'routes'))
    .filter((f) => f.endsWith('.js'));
  const routerModules = new Map();
  for (const file of routeFiles) {
    const mod = require(path.join(REPO_ROOT, 'routes', file));
    if (isRouter(mod)) {
      routerModules.set(file, mod);
    }
  }
  const alreadyMounted = new Set(mountedRouters(harness.app));
  const mountedByThisTest = [];
  for (const [file, mod] of routerModules) {
    if (!alreadyMounted.has(mod)) {
      harness.app.use(mod);
      mountedByThisTest.push(file);
    }
  }

  const routes = collectRoutes(harness.app.router.stack);

  await test('the walk reaches the routers it is meant to cover', () => {
    assert.ok(
      routerModules.has('setup.js') && routerModules.has('tidyUp.js'),
      'routes/setup.js and routes/tidyUp.js export routers'
    );
    for (const [file, mod] of routerModules) {
      assert.ok(
        mountedRouters(harness.app).includes(mod),
        `routes/${file} is not mounted`
      );
    }
    assert.ok(
      routes.length > 100,
      `only ${routes.length} routes found; the walk is broken`
    );
    assert.ok(
      routes.some((r) => r.path === '/api/settings/api-key'),
      'a known setup.js route is in the list'
    );
    assert.ok(
      routes.some((r) => r.path.startsWith('/api/tidy-up')),
      'a known tidyUp.js route is in the list'
    );
  });

  await test('every non-public route has its own guard', () => {
    const unguarded = findUnguarded(routes);
    assert.deepStrictEqual(
      unguarded.map(describe),
      [],
      `${unguarded.length} route(s) rely on the router-wide guard alone; ` +
        `add isAuthenticated, or list the route in ALLOWLIST with a reason`
    );
  });

  await test('the public paths match what the auth gate lets through', () => {
    const { PUBLIC_ROUTES } = require(
      path.join(REPO_ROOT, 'middleware', 'authGate.js')
    );
    assert.deepStrictEqual(
      [...PUBLIC_ROUTES].sort(),
      [...PUBLIC_PREFIXES].sort()
    );
  });

  await test('the allowlist has no stale entries', () => {
    for (const key of ALLOWLIST.keys()) {
      assert.ok(
        routes.some((r) => `${r.method} ${r.path}` === key),
        `${key} is allowlisted but no such route exists`
      );
    }
  });

  await test('the detector flags an unguarded route (self-check)', () => {
    const router = express.Router();
    const guard = function isAuthenticated(_req, _res, next) {
      next();
    };
    router.get('/guarded', guard, (_req, res) => res.end());
    router.post('/open', (_req, res) => res.end());
    router.get('/login', (_req, res) => res.end());
    const nested = express.Router();
    nested.delete('/nested-open', (_req, res) => res.end());
    router.use(nested);

    const flagged = findUnguarded(collectRoutes(router.stack)).map(
      (r) => `${r.method} ${r.path}`
    );
    assert.deepStrictEqual(flagged, ['POST /open', 'DELETE /nested-open']);
  });

  await test('a router mounted under a prefix is refused, not mis-checked', () => {
    const router = express.Router();
    router.use(
      '/feature',
      express.Router().get('/x', (_req, res) => res.end())
    );
    assert.throws(() => collectRoutes(router.stack), /path prefix/);
  });

  if (mountedByThisTest.length) {
    console.log(
      `ℹ️   mounted by this test (not by the harness): ${mountedByThisTest.join(', ')}`
    );
  }

  await harness.close();

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error('❌  Fatal error:', error);
  process.exit(1);
});
