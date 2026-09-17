/**
 * Test: server-side update check
 *
 * The dashboard used to call api.github.com from the browser on every page
 * load. For a self-hosted application that hands the user's IP and referrer to
 * a third party on every view, and it spends the unauthenticated GitHub rate
 * limit (60 requests per hour per IP) — shared by everyone behind the same NAT.
 *
 * Covers:
 * 1. Version comparison, including tags of unequal length
 * 2. One outbound request per day, shared by concurrent callers
 * 3. A failing lookup degrading quietly instead of throwing
 * 4. UPDATE_CHECK_ENABLED=no suppressing the outbound call entirely
 * 5. No browser-side code contacting GitHub any more
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Load the service with axios stubbed out — no test may reach the network
// ──────────────────────────────────────────────────────────────────────────────

const calls = [];
let respond = () => ({ status: 200, data: { tag_name: 'v2026.09.01' } });

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'axios') {
    return {
      get: async (url, options) => {
        calls.push({ url, options });
        const result = respond();
        if (result instanceof Error) throw result;
        return result;
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const servicePath = path.join(
  process.cwd(),
  'services',
  'updateCheckService.js'
);
const config = require(path.join(process.cwd(), 'config', 'config.js'));
const updateCheckService = require(servicePath);

Module._load = originalLoad;

const { isNewer, parseVersion } = updateCheckService;

function reset() {
  calls.length = 0;
  updateCheckService.reset();
  config.updateCheckEnabled = 'yes';
  // Pin the app's own version below the mocked release: the service reads it
  // at call time, and the test must not flip whenever PAPERLESS_AI_VERSION
  // in config.js catches up with the tag used here.
  config.PAPERLESS_AI_VERSION = 'v2026.08.05';
  respond = () => ({ status: 200, data: { tag_name: 'v2026.09.01' } });
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Version comparison
// ──────────────────────────────────────────────────────────────────────────────

(async () => {
  await test('Version tags compare numerically, not as strings', () => {
    assert.deepStrictEqual(parseVersion('v2026.08.02'), [2026, 8, 2]);
    assert.strictEqual(isNewer('v2026.08.10', 'v2026.08.02'), true);
    assert.strictEqual(
      isNewer('v2026.08.9', 'v2026.08.10'),
      false,
      'String comparison would call 9 newer than 10'
    );
    assert.strictEqual(isNewer('v2026.08.02', 'v2026.08.02'), false);
    assert.strictEqual(isNewer('v2025.12.31', 'v2026.01.01'), false);
  });

  await test('Tags of unequal length are handled', () => {
    assert.strictEqual(isNewer('v2026.09', 'v2026.08.02'), true);
    assert.strictEqual(isNewer('v2026.08', 'v2026.08.02'), false);
    assert.strictEqual(isNewer('v2026.08.02.1', 'v2026.08.02'), true);
  });

  await test('An unparsable tag never claims an update', () => {
    assert.strictEqual(isNewer('', 'v2026.08.02'), false);
    assert.strictEqual(isNewer('nightly', 'v2026.08.02'), false);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 2. Caching
  // ────────────────────────────────────────────────────────────────────────────

  await test('The release is fetched once and then served from the cache', async () => {
    reset();
    const first = await updateCheckService.getStatus();
    const second = await updateCheckService.getStatus();
    const third = await updateCheckService.getStatus();

    assert.strictEqual(
      calls.length,
      1,
      'Every page load hitting GitHub is the failure mode this replaces'
    );
    assert.strictEqual(first.latestVersion, 'v2026.09.01');
    assert.strictEqual(second.latestVersion, 'v2026.09.01');
    assert.strictEqual(third.updateAvailable, true);
  });

  await test('Concurrent callers share a single request', async () => {
    reset();
    const results = await Promise.all([
      updateCheckService.getStatus(),
      updateCheckService.getStatus(),
      updateCheckService.getStatus(),
    ]);

    assert.strictEqual(calls.length, 1);
    results.forEach((result) =>
      assert.strictEqual(result.latestVersion, 'v2026.09.01')
    );
  });

  await test('The request identifies itself and cannot hang forever', async () => {
    reset();
    await updateCheckService.getStatus();

    const { url, options } = calls[0];
    assert.match(url, /^https:\/\/api\.github\.com\//);
    assert.ok(options.timeout > 0, 'A hanging lookup would stall the endpoint');
    assert.match(options.headers['User-Agent'], /zettelrobbe/);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 3. Failure handling
  // ────────────────────────────────────────────────────────────────────────────

  await test('A failed lookup resolves instead of throwing', async () => {
    reset();
    respond = () => new Error('getaddrinfo ENOTFOUND api.github.com');

    const result = await updateCheckService.getStatus();
    assert.strictEqual(result.updateAvailable, false);
    assert.strictEqual(result.latestVersion, null);
    assert.match(result.error, /ENOTFOUND/);
  });

  await test('A failed lookup keeps the last known release', async () => {
    reset();
    await updateCheckService.getStatus();

    respond = () => new Error('rate limit exceeded');
    const result = await updateCheckService.getStatus({ force: true });

    assert.strictEqual(
      result.latestVersion,
      'v2026.09.01',
      'A single hiccup should not retract a known update'
    );
    assert.match(result.error, /rate limit/);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 4. Opt-out
  // ────────────────────────────────────────────────────────────────────────────

  await test('UPDATE_CHECK_ENABLED=no makes no outbound request', async () => {
    reset();
    config.updateCheckEnabled = 'no';

    const result = await updateCheckService.getStatus();
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(result.enabled, false);
    assert.strictEqual(result.updateAvailable, false);
    config.updateCheckEnabled = 'yes';
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 5. Nothing in the browser talks to GitHub
  // ────────────────────────────────────────────────────────────────────────────

  await test('No shipped browser code calls the GitHub API', () => {
    const roots = [
      path.join(process.cwd(), 'public', 'js'),
      path.join(process.cwd(), 'views'),
    ];
    const offenders = [];

    const walk = (dir) => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          return;
        }
        if (!/\.(js|ejs)$/.test(entry.name)) return;
        if (fs.readFileSync(full, 'utf8').includes('api.github.com')) {
          offenders.push(path.relative(process.cwd(), full));
        }
      });
    };

    roots.filter((dir) => fs.existsSync(dir)).forEach(walk);

    assert.deepStrictEqual(
      offenders,
      [],
      `These files still reach GitHub from the browser: ${offenders.join(', ')}`
    );
  });

  await test('The endpoint keeps the upstream error out of the response', () => {
    const routeSource = fs.readFileSync(
      path.join(process.cwd(), 'routes', 'setup.js'),
      'utf8'
    );
    const start = routeSource.indexOf("router.get('/api/update-check'");
    assert.ok(start > -1, 'The endpoint is missing');

    const handler = routeSource.slice(
      start,
      routeSource.indexOf('\n});', start)
    );
    assert.match(
      handler,
      /isAuthenticated/,
      'Version information should not be readable without a session'
    );
    assert.match(
      handler,
      /delete data\.error/,
      'The upstream message belongs in the log, not in the browser'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
