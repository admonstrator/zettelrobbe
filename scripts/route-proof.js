// @ts-check
'use strict';

/**
 * Proof tooling for moving route handlers between files.
 *
 * A move is a refactor: the same routes must exist afterwards, every handler
 * must be byte-identical and the OpenAPI document must not change. This script
 * proves the three things without anyone reading the moved code.
 *
 * Per-move workflow:
 *   1. node scripts/route-proof.js snapshot before.json         (before touching anything)
 *   2. move the handlers (and their @swagger blocks) into the feature router
 *   3. node scripts/route-proof.js snapshot after.json
 *   4. node scripts/route-proof.js compare before.json after.json    (exit 0 = nothing changed)
 *   5. git show HEAD~1:OPENAPI/openapi.json > old-openapi.json && node scripts/regen-openapi.js
 *      && node scripts/route-proof.js openapi old-openapi.json OPENAPI/openapi.json
 *
 * Commands:
 *   snapshot <out.json>             Build the route layer in-process (routes/oidc.js, routes/tidyUp.js and
 *                                   routes/setup.js on a throwaway database, no network) and write one
 *                                   record per route: method, full path, guards, middleware, final handler
 *                                   name, SHA-256 and source text of the final handler.
 *   compare <a.json> <b.json>       Diff two snapshots: routes added, routes removed, guards or middleware
 *                                   changed, handler source changed (with a line diff). Exit 0 only when
 *                                   identical. Moving a guard from a route to its router is not a change:
 *                                   the guards and middleware of a route are compared as one ordered chain.
 *     --ignore-middleware           Skip the chain comparison, for a commit that changes guards on purpose.
 *   openapi <a.json> <b.json>       Compare two OpenAPI files after sorting every object key recursively
 *                                   (path order changes when blocks move between files, content must not).
 *                                   Prints the differing JSON pointers. Exit 0 only when equal.
 *
 * Exit codes: 0 identical, 1 differences found, 2 usage or input error.
 *
 * Terms: "guards" are the router-level layers (router.use) that apply to a route's path and were registered
 * before it, at every nesting level; "middleware" are the handlers in front of the final handler inside the
 * route itself. Error handlers (four parameters) are left out. Nested routers are followed and their mount
 * paths are joined, so a feature router mounted inside an aggregator router yields the same table.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * @typedef {object} RouteRecord
 * @property {string} method           Upper-case HTTP method, or ALL.
 * @property {string} path             Full path including mount paths.
 * @property {string[]} guards         Names of the router-level layers that apply, in order.
 * @property {string[]} middleware     Names of the route-level handlers before the final one, in order.
 * @property {string[]} guardHashes     Short SHA-256 of each guard's source, parallel to guards.
 * @property {string[]} middlewareHashes Short SHA-256 of each middleware's source, parallel to middleware.
 * @property {string} handlerName      Function name of the final handler.
 * @property {string} handlerSha256    SHA-256 of the final handler's source text.
 * @property {string} handlerSource    Source text of the final handler (fn.toString()).
 */

/**
 * @typedef {object} Snapshot
 * @property {number} version
 * @property {RouteRecord[]} routes    Sorted by method and path.
 */

/**
 * @typedef {object} FixtureRoute
 * @property {string} route            "METHOD /path".
 * @property {string[]} guards         Guards followed by route-level middleware, as one ordered chain.
 */

/**
 * The parts of an Express 5 router layer this script reads. Express keeps
 * them undocumented, so everything is optional and checked at use.
 * @typedef {object} ExpressLayer
 * @property {any} handle
 * @property {string} name
 * @property {any} [route]
 * @property {Array<(p: string) => any>} [matchers]
 * @property {string} [method]
 * @property {boolean} [slash]   True for a use() layer mounted at '/': Express matches it without a matcher.
 */

/** @typedef {{ layer: ExpressLayer, base: string }} Guard */

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** The original path of every router.use() layer. Express drops it after compiling. */
const mountPaths = new WeakMap();

/**
 * Express compiles the path of router.use() into a matcher and forgets the
 * string, but a nested router can only be placed in the route table when its
 * mount path is known. This wraps Router.prototype.use to remember it. It must
 * run before any route module is loaded.
 */
function installMountPathRecorder() {
  const routerPackage = require.resolve('router', {
    paths: [require.resolve('express', { paths: [REPO_ROOT] })],
  });
  /** @type {any} */
  const Router = require(routerPackage);
  if (Router.prototype.__routeProofPatched) {
    return;
  }
  const original = Router.prototype.use;
  Router.prototype.use = function (
    /** @type {any} */ handler,
    /** @type {any[]} */ ...rest
  ) {
    /** @type {any[]} */
    const stack = this.stack;
    const before = stack.length;
    const result = original.call(this, handler, ...rest);
    let mountPath = '/';
    if (typeof handler !== 'function') {
      let probe = handler;
      while (Array.isArray(probe) && probe.length !== 0) {
        probe = probe[0];
      }
      if (typeof probe !== 'function') {
        mountPath = handler;
      }
    }
    for (let i = before; i < stack.length; i += 1) {
      mountPaths.set(stack[i], mountPath);
    }
    return result;
  };
  Router.prototype.__routeProofPatched = true;
}

/**
 * @param {unknown} value a path as given to router.get / router.use
 * @returns {string[]} printable paths, one per alternative
 */
function pathsOf(value) {
  const list = Array.isArray(value) ? value.flat(Infinity) : [value];
  return list.map((entry) =>
    typeof entry === 'string' ? entry : String(entry)
  );
}

/**
 * @param {string} prefix
 * @param {string} suffix
 * @returns {string} joined without doubled or trailing slashes
 */
function joinPaths(prefix, suffix) {
  const joined = `${prefix}/${suffix}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/**
 * @param {Guard} guard
 * @param {string} fullPath
 * @returns {boolean} whether the guard's mount path matches the route path
 */
function guardApplies(guard, fullPath) {
  const relative = fullPath.startsWith(guard.base)
    ? fullPath.slice(guard.base.length) || '/'
    : fullPath;
  if (guard.layer.slash) {
    return true;
  }
  const matchers = guard.layer.matchers || [];
  return matchers.some((match) => Boolean(match(relative)));
}

/**
 * @param {Function} fn
 * @returns {string} first 12 hex digits of the SHA-256 of the function's source
 */
function shortHash(fn) {
  return crypto
    .createHash('sha256')
    .update(Function.prototype.toString.call(fn))
    .digest('hex')
    .slice(0, 12);
}

/**
 * @param {Function} fn
 * @returns {string}
 */
function nameOf(fn) {
  return fn.name || '<anonymous>';
}

/**
 * Appends one record per route of `router` (and of the routers mounted in it).
 *
 * @param {any} router
 * @param {string} prefix mount path of this router
 * @param {Guard[]} inherited guards registered before this router was mounted
 * @param {RouteRecord[]} out
 * @param {boolean} collectGuards false for the app-level stack, whose middleware (body parsers,
 *   cookies) belongs to the test harness and not to the routes
 */
function walkRouter(router, prefix, inherited, out, collectGuards) {
  /** @type {Guard[]} */
  const guards = [...inherited];
  for (const layer of /** @type {ExpressLayer[]} */ (router.stack)) {
    if (layer.route) {
      collectRoute(layer.route, prefix, guards, out);
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      const mounts = pathsOf(mountPaths.get(layer) ?? '/');
      for (const mount of mounts) {
        walkRouter(layer.handle, joinPaths(prefix, mount), guards, out, true);
      }
    } else if (
      collectGuards &&
      typeof layer.handle === 'function' &&
      layer.handle.length !== 4
    ) {
      guards.push({ layer, base: prefix });
    }
  }
}

/**
 * @param {any} route an Express Route
 * @param {string} prefix
 * @param {Guard[]} guards
 * @param {RouteRecord[]} out
 */
function collectRoute(route, prefix, guards, out) {
  /** @type {ExpressLayer[]} */
  const stack = route.stack;
  /** @type {Set<string>} */
  const methods = new Set(stack.map((layer) => layer.method ?? 'all'));
  const isAll = methods.has('all');
  const methodNames = isAll ? ['all'] : [...methods];
  for (const routePath of pathsOf(route.path)) {
    const fullPath = joinPaths(prefix, routePath);
    for (const method of methodNames) {
      const handlers = stack.filter(
        (layer) => layer.method === undefined || layer.method === method
      );
      const final = handlers[handlers.length - 1].handle;
      const source = Function.prototype.toString.call(final);
      const applying = guards.filter((guard) => guardApplies(guard, fullPath));
      const inRoute = handlers.slice(0, -1);
      out.push({
        method: method.toUpperCase(),
        path: fullPath,
        guards: applying.map((guard) => guard.layer.name),
        middleware: inRoute.map((layer) => nameOf(layer.handle)),
        guardHashes: applying.map((guard) => shortHash(guard.layer.handle)),
        middlewareHashes: inRoute.map((layer) => shortHash(layer.handle)),
        handlerName: nameOf(final),
        handlerSha256: crypto.createHash('sha256').update(source).digest('hex'),
        handlerSource: source,
      });
    }
  }
}

/**
 * @param {RouteRecord} a
 * @param {RouteRecord} b
 * @returns {number}
 */
function byMethodAndPath(a, b) {
  if (a.method !== b.method) {
    return a.method < b.method ? -1 : 1;
  }
  if (a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  return 0;
}

/**
 * Builds the route layer in-process and returns its route table. Mounts
 * routes/oidc.js, routes/tidyUp.js and routes/setup.js on the throwaway
 * database of tests/helpers/mount-router.js; nothing leaves the machine.
 * Console output of the application modules is muted while it builds.
 *
 * @returns {Promise<Snapshot>}
 */
async function buildSnapshot() {
  installMountPathRecorder();
  const { mountRouter } = require('../tests/helpers/mount-router');

  const muted = ['log', 'info', 'warn'];
  /** @type {Record<string, any>} */
  const saved = {};
  for (const name of muted) {
    saved[name] = /** @type {any} */ (console)[name];
    /** @type {any} */ (console)[name] = () => {};
  }
  const harness = await mountRouter({});
  try {
    /** @type {RouteRecord[]} */
    const routes = [];
    // server.js mounts oidc before tidyUp and setup; the harness mounts the latter two.
    const oidcRouter = require(path.join(REPO_ROOT, 'routes', 'oidc.js'));
    walkRouter(oidcRouter, '', [], routes, true);
    walkRouter(harness.app.router, '', [], routes, false);
    return {
      version: 1,
      routes: routes
        .map((route, index) => ({ route, index }))
        .sort((a, b) => byMethodAndPath(a.route, b.route) || a.index - b.index)
        .map((entry) => entry.route),
    };
  } finally {
    await harness.close();
    for (const name of muted) {
      /** @type {any} */ (console)[name] = saved[name];
    }
  }
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

/**
 * Keys a snapshot's routes. A second registration of the same method and path
 * (Express runs the first one only) gets a #2 suffix.
 *
 * @param {Snapshot} snapshot
 * @returns {Map<string, RouteRecord>}
 */
function indexRoutes(snapshot) {
  /** @type {Map<string, RouteRecord>} */
  const map = new Map();
  for (const route of snapshot.routes) {
    const base = `${route.method} ${route.path}`;
    let key = base;
    for (let n = 2; map.has(key); n += 1) {
      key = `${base} #${n}`;
    }
    map.set(key, route);
  }
  return map;
}

/**
 * Line diff of two texts, unified style with three lines of context.
 *
 * @param {string} before
 * @param {string} after
 * @returns {string[]}
 */
function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  // Longest common subsequence table; handlers are a few hundred lines at most.
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  /** @type {Array<{ tag: ' ' | '-' | '+', text: string }>} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ tag: ' ', text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ tag: '-', text: a[i] });
      i += 1;
    } else {
      ops.push({ tag: '+', text: b[j] });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) ops.push({ tag: '-', text: a[i] });
  for (; j < b.length; j += 1) ops.push({ tag: '+', text: b[j] });

  const context = 3;
  const keep = ops.map((op, index) => {
    if (op.tag !== ' ') return true;
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(ops.length - 1, index + context);
      k += 1
    ) {
      if (ops[k].tag !== ' ') return true;
    }
    return false;
  });
  /** @type {string[]} */
  const lines = [];
  let gap = false;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      gap = true;
      return;
    }
    if (gap && lines.length > 0) lines.push('  ...');
    gap = false;
    lines.push(`${op.tag} ${op.text}`);
  });
  return lines;
}

/**
 * @typedef {object} CompareResult
 * @property {boolean} identical
 * @property {string[]} report   Human-readable lines.
 */

/**
 * @param {Snapshot} a snapshot taken before
 * @param {Snapshot} b snapshot taken after
 * @param {{ ignoreMiddleware?: boolean }} [options]
 * @returns {CompareResult}
 */
function compareSnapshots(a, b, options = {}) {
  const before = indexRoutes(a);
  const after = indexRoutes(b);
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const chainChanged = [];
  /** @type {string[]} */
  const sourceChanged = [];

  for (const [key, route] of after) {
    const old = before.get(key);
    if (!old) {
      added.push(key);
      continue;
    }
    if (!options.ignoreMiddleware) {
      if (chainKey(old) !== chainKey(route)) {
        chainChanged.push(
          `${key}\n    before: ${describeChain(old)}\n    after:  ${describeChain(route)}`
        );
      }
    }
    if (old.handlerSha256 !== route.handlerSha256) {
      sourceChanged.push(
        `${key}  (${old.handlerName} -> ${route.handlerName})\n${lineDiff(
          old.handlerSource,
          route.handlerSource
        )
          .map((line) => `    ${line}`)
          .join('\n')}`
      );
    }
  }
  for (const key of before.keys()) {
    if (!after.has(key)) removed.push(key);
  }

  /** @type {string[]} */
  const report = [];
  /**
   * @param {string} title
   * @param {string[]} items
   */
  const section = (title, items) => {
    if (items.length === 0) return;
    report.push(`${title} (${items.length})`);
    for (const item of items) report.push(`  ${item}`);
    report.push('');
  };
  section('Routes added', added);
  section('Routes removed', removed);
  section('Guards or middleware changed', chainChanged);
  section('Handler source changed', sourceChanged);
  const identical = report.length === 0;
  report.push(
    identical
      ? `Identical: ${after.size} routes, same handlers${options.ignoreMiddleware ? ' (middleware not compared)' : ' and same guard chains'}.`
      : `Different: ${before.size} routes before, ${after.size} after.`
  );
  return { identical, report };
}

/**
 * The ordered chain of a route (guards, then route-level middleware) with the
 * source hash of each entry, so an edited guard counts as a change.
 *
 * @param {RouteRecord} route
 * @returns {string}
 */
function chainKey(route) {
  const hash = (/** @type {string[]} */ list, /** @type {number} */ i) =>
    list[i] ?? '';
  return JSON.stringify([
    ...route.guards.map((name, i) => [name, hash(route.guardHashes, i)]),
    ...route.middleware.map((name, i) => [
      name,
      hash(route.middlewareHashes, i),
    ]),
  ]);
}

/**
 * @param {RouteRecord} route
 * @returns {string}
 */
function describeChain(route) {
  const chain = [
    ...route.guards.map(
      (name, i) => `${name}#${(route.guardHashes[i] ?? '').slice(0, 6)}`
    ),
    ...route.middleware.map(
      (name, i) => `${name}#${(route.middlewareHashes[i] ?? '').slice(0, 6)}*`
    ),
  ];
  return chain.length > 0
    ? `${chain.join(' > ')}   (* = route-level)`
    : '(none)';
}

// ---------------------------------------------------------------------------
// Route table fixture (committed, no hashes)
// ---------------------------------------------------------------------------

/**
 * @param {Snapshot} snapshot
 * @returns {FixtureRoute[]} sorted "METHOD path" with the ordered guard chain
 */
function toFixture(snapshot) {
  return [...indexRoutes(snapshot)].map(([key, route]) => ({
    route: key,
    guards: [...route.guards, ...route.middleware],
  }));
}

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {unknown} the same data with every object's keys in sorted order
 */
function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(
        /** @type {Record<string, unknown>} */ (value)[key]
      );
    }
    return sorted;
  }
  return value;
}

/**
 * @param {string} key
 * @returns {string} one JSON pointer segment
 */
function pointerSegment(key) {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} pointer
 * @param {string[]} out
 */
function diffValues(a, b, pointer, out) {
  const aIsObject = a !== null && typeof a === 'object';
  const bIsObject = b !== null && typeof b === 'object';
  if (aIsObject && bIsObject && Array.isArray(a) === Array.isArray(b)) {
    const left = /** @type {Record<string, unknown>} */ (a);
    const right = /** @type {Record<string, unknown>} */ (b);
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      const child = `${pointer}/${pointerSegment(key)}`;
      if (!(key in left)) out.push(`${child}  only in second file`);
      else if (!(key in right)) out.push(`${child}  only in first file`);
      else diffValues(left[key], right[key], child, out);
    }
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`${pointer || '/'}  value differs`);
  }
}

/**
 * @param {unknown} a parsed OpenAPI document
 * @param {unknown} b parsed OpenAPI document
 * @returns {string[]} JSON pointers where the documents differ (empty when equal)
 */
function compareOpenApi(a, b) {
  /** @type {string[]} */
  const out = [];
  diffValues(sortKeys(a), sortKeys(b), '', out);
  return out;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/**
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(
      `Cannot read ${file}: ${error instanceof Error ? error.message : error}`
    );
  }
}

class UsageError extends Error {}

/**
 * @param {string[]} argv arguments after the script name
 * @returns {Promise<number>} exit code
 */
async function main(argv) {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  const args = argv.filter((arg) => !arg.startsWith('--'));
  const [command, first, second] = args;
  try {
    if (command === 'snapshot' && first && !second) {
      const snapshot = await buildSnapshot();
      fs.writeFileSync(first, `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(`Wrote ${snapshot.routes.length} routes to ${first}`);
      return 0;
    }
    if (command === 'compare' && first && second) {
      const result = compareSnapshots(readJson(first), readJson(second), {
        ignoreMiddleware: flags.includes('--ignore-middleware'),
      });
      console.log(result.report.join('\n'));
      return result.identical ? 0 : 1;
    }
    if (command === 'openapi' && first && second) {
      const differences = compareOpenApi(readJson(first), readJson(second));
      if (differences.length === 0) {
        console.log('OpenAPI documents are equal (keys sorted).');
        return 0;
      }
      console.log(
        `OpenAPI documents differ at ${differences.length} place(s):`
      );
      for (const line of differences) console.log(`  ${line}`);
      return 1;
    }
    throw new UsageError(
      'Usage:\n  node scripts/route-proof.js snapshot <out.json>\n  node scripts/route-proof.js compare <a.json> <b.json> [--ignore-middleware]\n  node scripts/route-proof.js openapi <a.json> <b.json>'
    );
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

/**
 * Route table of one router, for checking the tooling itself on small routers.
 * installMountPathRecorder() must have run before the router was built.
 *
 * @param {any} router an Express router
 * @returns {Snapshot}
 */
function snapshotOfRouter(router) {
  /** @type {RouteRecord[]} */
  const routes = [];
  walkRouter(router, '', [], routes, true);
  return { version: 1, routes: routes.sort(byMethodAndPath) };
}

module.exports = {
  installMountPathRecorder,
  snapshotOfRouter,
  buildSnapshot,
  compareSnapshots,
  compareOpenApi,
  toFixture,
  lineDiff,
  sortKeys,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    // The application modules start timers; leave explicitly.
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(2);
    }
  );
}
