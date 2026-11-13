// @ts-check
'use strict';

/**
 * No route of an earlier router may swallow a static route of a later one.
 *
 * routes/setup.js was one router, so the order of its routes was the order of
 * one file. Split into one router per feature, the routes of a later router
 * run only after every route of the routers mounted before it. A route with a
 * parameter or a wildcard (GET /api/ignored/:documentId) in an earlier router
 * would then answer a static path (GET /api/ignored/queue) that a later router
 * declares, and the static handler would never run.
 *
 * The test builds the route layer as server.js mounts it (routes/oidc.js, then
 * routes/tidyUp.js and routes/index.js through tests/helpers/mount-router.js),
 * walks every router in mount order, nested ones included, and asks each
 * parameter or wildcard route whether it matches the path of a static route
 * with the same method (or any method, for router.all) in a router mounted
 * after it. Express's own matcher answers, so the check is exactly what a
 * request would see. Routes within one router keep their relative order from
 * the former routes/setup.js and are not compared with each other here.
 */

const assert = require('assert');
const path = require('path');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

/**
 * @typedef {object} MountedRoute
 * @property {string} method   upper-case method, or ALL
 * @property {string} path     the declared path
 * @property {number} router   index of the router that declares it, in mount order
 * @property {string} file     where the router came from, for the message
 * @property {any} layer       the router layer of the route (has .match())
 */

/**
 * True when an Express router or app sits behind this value.
 * @param {any} value
 * @returns {boolean}
 */
function isRouter(value) {
  return typeof value === 'function' && Array.isArray(value.stack);
}

/**
 * Lists every route below `router` in the order Express tries them.
 *
 * @param {any} router
 * @param {Map<any, string>} names router → file name, for messages
 * @param {{ next: number }} counter numbers the routers in mount order
 * @param {MountedRoute[]} out
 */
function collect(router, names, counter, out) {
  const id = counter.next++;
  const file = names.get(router) || `router #${id}`;
  for (const layer of router.stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter(
        (method) => layer.route.methods[method]
      );
      for (const method of methods.length ? methods : ['_all']) {
        out.push({
          method: method === '_all' ? 'ALL' : method.toUpperCase(),
          path: String(layer.route.path),
          router: id,
          file,
          layer,
        });
      }
    } else if (isRouter(layer.handle)) {
      assert.ok(
        layer.slash,
        `a router inside ${file} is mounted under a path; mount feature routers at / with full paths`
      );
      collect(layer.handle, names, counter, out);
    }
  }
}

/**
 * @param {string} routePath
 * @returns {boolean} true when the path has a parameter or a wildcard
 */
function isDynamic(routePath) {
  return /[:*{(]/.test(routePath);
}

(async () => {
  let failed = 0;
  /**
   * @param {string} name
   * @param {() => void} fn
   */
  const test = (name, fn) => {
    try {
      fn();
      console.log(`✅  ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`❌  ${name}`);
      console.error(
        `    ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const harness = await mountRouter({});
  try {
    const fs = require('fs');
    /** @type {Map<any, string>} */
    const names = new Map();
    for (const file of fs.readdirSync(path.join(REPO_ROOT, 'routes'))) {
      if (file.endsWith('.js')) {
        const mod = require(path.join(REPO_ROOT, 'routes', file));
        if (isRouter(mod)) names.set(mod, `routes/${file}`);
      }
    }

    /** @type {MountedRoute[]} */
    const routes = [];
    const counter = { next: 0 };
    // server.js mounts oidc first; the harness mounts tidyUp and index.
    collect(
      require(path.join(REPO_ROOT, 'routes', 'oidc.js')),
      names,
      counter,
      routes
    );
    for (const router of harness.routers) {
      collect(router, names, counter, routes);
    }

    test('the walk sees the feature routers', () => {
      assert.ok(routes.length > 100, `only ${routes.length} routes found`);
      assert.ok(
        new Set(routes.map((route) => route.router)).size >= 3,
        'expected routes from several routers'
      );
    });

    test('no earlier parameter route matches a later static route', () => {
      const shadowed = [];
      for (const dynamic of routes.filter((r) => isDynamic(r.path))) {
        for (const target of routes) {
          if (
            target.router > dynamic.router &&
            !isDynamic(target.path) &&
            (dynamic.method === 'ALL' || dynamic.method === target.method) &&
            dynamic.layer.match(target.path)
          ) {
            shadowed.push(
              `${dynamic.method} ${dynamic.path} (${dynamic.file}) answers ` +
                `${target.method} ${target.path} (${target.file})`
            );
          }
        }
      }
      assert.deepStrictEqual(shadowed, []);
    });
  } finally {
    await harness.close();
  }

  if (failed > 0) {
    process.exit(1);
  }
  console.log('\nNo route shadows a route of a later router');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
