/**
 * Test: dashboard warning when Paperless-ngx is not usable
 *
 * Regression guard for the failure mode where the dashboard banner was wired
 * to `scanner.degraded` only. Because `degraded` needs `failureThreshold`
 * consecutive scan runs, an outage stayed invisible for up to three
 * SCAN_INTERVALs — and forever with DISABLE_AUTOMATIC_PROCESSING=yes, where
 * the scanner is never degraded by definition.
 *
 * Covers:
 * 1. The banner logic from public/js/modules/scanner-health.js, executed for
 *    real against a minimal DOM stub
 * 2. The /api/processing-status payload carrying the fields it needs
 * 3. server.js arming the standalone connectivity probe
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

// ──────────────────────────────────────────────────────────────────────────────
// Load the real banner code from the shipped module
// ──────────────────────────────────────────────────────────────────────────────

// The module is browser-facing ESM; strip the export keywords so it can run in
// a VM without a module loader. Testing the shipped source beats
// re-implementing the logic here.
const modulePath = path.join(
  process.cwd(),
  'public',
  'js',
  'modules',
  'scanner-health.js'
);
const bannerSource = fs
  .readFileSync(modulePath, 'utf8')
  .replace(/^export /gm, '');

function createElement() {
  const classes = new Set();
  return {
    textContent: '',
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return on;
      },
    },
  };
}

/**
 * Runs the shipped banner code against a fresh DOM stub.
 * @param {object} payload The /api/processing-status response body.
 * @returns {{banner: object, title: object, message: object}}
 */
function renderBanner(payload) {
  const elements = {
    scannerHealthBanner: createElement(),
    scannerHealthTitle: createElement(),
    scannerHealthMessage: createElement(),
  };
  elements.scannerHealthBanner.classList.add('zr-alert--danger');
  elements.scannerHealthBanner.classList.add('hidden');

  const sandbox = {
    console: { log() {}, error() {}, debug() {}, warn() {} },
    document: {
      getElementById: (id) => elements[id] || createElement(),
      addEventListener() {},
    },
    window: {},
    // The block self-starts its poll on load; keep it from firing.
    setInterval: () => 0,
    setTimeout: () => 0,
    fetch: () => new Promise(() => {}),
  };
  vm.createContext(sandbox);
  vm.runInContext(bannerSource, sandbox);

  sandbox.updateScannerHealthBanner(
    {
      banner: elements.scannerHealthBanner,
      title: elements.scannerHealthTitle,
      message: elements.scannerHealthMessage,
    },
    payload
  );

  return {
    banner: elements.scannerHealthBanner,
    title: elements.scannerHealthTitle,
    message: elements.scannerHealthMessage,
  };
}

/**
 * Same shipped code, but the elements survive across calls and count how often
 * their text is assigned — the banner lives in a live region, so a write is an
 * announcement whether or not the string changed.
 *
 * @returns {{update: (payload: object) => void, writes: object, elements: object}}
 */
function createBannerHarness() {
  const writes = { title: 0, message: 0 };
  const counting = (key) => {
    const el = createElement();
    let text = '';
    Object.defineProperty(el, 'textContent', {
      get: () => text,
      set: (value) => {
        writes[key] += 1;
        text = value;
      },
    });
    return el;
  };

  const elements = {
    banner: createElement(),
    title: counting('title'),
    message: counting('message'),
  };
  elements.banner.classList.add('hidden');

  const sandbox = {
    console: { log() {}, error() {}, debug() {}, warn() {} },
    document: { getElementById: () => createElement(), addEventListener() {} },
    window: {},
    setInterval: () => 0,
    setTimeout: () => 0,
    fetch: () => new Promise(() => {}),
  };
  vm.createContext(sandbox);
  vm.runInContext(bannerSource, sandbox);

  return {
    elements,
    writes,
    update: (payload) => sandbox.updateScannerHealthBanner(elements, payload),
  };
}

const HEALTHY_SCANNER = {
  automaticProcessingEnabled: true,
  armed: true,
  degraded: false,
  consecutiveFailures: 0,
  failureThreshold: 3,
  lastError: null,
  lastSuccessfulRunAt: '2026-08-09T10:00:00.000Z',
};

// ──────────────────────────────────────────────────────────────────────────────
// 1. Banner behaviour
// ──────────────────────────────────────────────────────────────────────────────

test('A healthy system shows no banner', () => {
  const { banner } = renderBanner({
    scanner: HEALTHY_SCANNER,
    paperless: { reachable: true, authorized: true, usable: true },
  });

  assert.strictEqual(banner.classList.contains('hidden'), true);
});

test('An outage warns on the first failed probe, before degraded', () => {
  const { banner, title, message } = renderBanner({
    scanner: HEALTHY_SCANNER,
    paperless: {
      reachable: false,
      authorized: false,
      usable: false,
      status: null,
      lastCheckedAt: '2026-08-09T10:00:00.000Z',
      error: 'connect ECONNREFUSED 172.18.0.2:8000',
    },
  });

  assert.strictEqual(
    banner.classList.contains('hidden'),
    false,
    'Waiting for degraded hides the outage for up to three scan intervals'
  );
  assert.match(message.textContent, /not reachable/i);
  assert.match(message.textContent, /ECONNREFUSED/);
  assert.match(title.textContent, /connection problem/i);
  assert.strictEqual(
    banner.classList.contains('zr-alert--warn'),
    true,
    'A recoverable outage is a warning, not a hard failure'
  );
  assert.strictEqual(banner.classList.contains('zr-alert--danger'), false);
});

test('A rejected token is reported as a credentials problem', () => {
  const { banner, message } = renderBanner({
    scanner: HEALTHY_SCANNER,
    paperless: {
      reachable: true,
      authorized: false,
      usable: false,
      status: 401,
      lastCheckedAt: '2026-08-09T10:00:00.000Z',
      error: 'Request failed with status code 401',
    },
  });

  assert.strictEqual(banner.classList.contains('hidden'), false);
  assert.match(message.textContent, /rejected the API credentials/i);
  assert.doesNotMatch(
    message.textContent,
    /not reachable/i,
    'The host answered — calling it unreachable sends users hunting the wrong problem'
  );
});

test('The warning appears with automatic processing disabled', () => {
  const { banner, message } = renderBanner({
    scanner: {
      ...HEALTHY_SCANNER,
      automaticProcessingEnabled: false,
      armed: false,
      degraded: false,
    },
    paperless: {
      reachable: false,
      authorized: false,
      usable: false,
      error: 'connect ECONNREFUSED 172.18.0.2:8000',
    },
  });

  assert.strictEqual(
    banner.classList.contains('hidden'),
    false,
    'DISABLE_AUTOMATIC_PROCESSING=yes makes degraded permanently false'
  );
  assert.match(message.textContent, /not reachable/i);
  assert.doesNotMatch(
    message.textContent,
    /scheduler is not armed/i,
    'An intentionally disabled scheduler must not be reported as broken'
  );
});

test('A degraded scanner escalates to the error style', () => {
  const { banner, title, message } = renderBanner({
    scanner: {
      ...HEALTHY_SCANNER,
      degraded: true,
      consecutiveFailures: 3,
      lastError: 'connect ECONNREFUSED 172.18.0.2:8000',
    },
    paperless: {
      reachable: false,
      authorized: false,
      usable: false,
      error: 'connect ECONNREFUSED 172.18.0.2:8000',
    },
  });

  assert.strictEqual(banner.classList.contains('zr-alert--danger'), true);
  assert.strictEqual(banner.classList.contains('zr-alert--warn'), false);
  assert.match(title.textContent, /not working/i);
  assert.match(message.textContent, /3 consecutive failed scans/);
});

test('A degraded scanner with a healthy Paperless reports the scan error', () => {
  const { banner, message } = renderBanner({
    scanner: {
      ...HEALTHY_SCANNER,
      degraded: true,
      consecutiveFailures: 4,
      lastError: 'Unexpected token < in JSON',
    },
    paperless: { reachable: true, authorized: true, usable: true },
  });

  assert.strictEqual(banner.classList.contains('hidden'), false);
  assert.match(message.textContent, /Last scan error: Unexpected token/);
  assert.match(message.textContent, /4 consecutive failed scans/);
});

test('An unarmed scheduler is still reported', () => {
  const { message } = renderBanner({
    scanner: { ...HEALTHY_SCANNER, armed: false, degraded: true },
    paperless: { reachable: true, authorized: true, usable: true },
  });

  assert.match(message.textContent, /scheduler is not armed/i);
});

test('An unprobed connection is not treated as an outage', () => {
  const { banner } = renderBanner({
    scanner: HEALTHY_SCANNER,
    paperless: {
      reachable: null,
      authorized: null,
      usable: null,
      lastCheckedAt: null,
      error: null,
    },
  });

  assert.strictEqual(
    banner.classList.contains('hidden'),
    true,
    'Before the first probe there is nothing to warn about'
  );
});

test('A payload without health fields hides the banner instead of throwing', () => {
  const { banner } = renderBanner({});
  assert.strictEqual(banner.classList.contains('hidden'), true);
});

test('An unchanged banner is not rewritten on every poll', () => {
  // The banner sits in a live region and the status endpoint is polled every
  // three seconds. Reassigning the same text still mutates the DOM, which made
  // screen readers announce the same outage over and over.
  const payload = {
    scanner: HEALTHY_SCANNER,
    paperless: {
      reachable: true,
      authorized: false,
      usable: false,
      status: 401,
      lastCheckedAt: '2026-08-09T10:00:00.000Z',
      error: 'Request failed with status code 401',
    },
  };

  const { update, writes } = createBannerHarness();
  update(payload);
  const afterFirst = { ...writes };
  update(payload);
  update(payload);

  assert.ok(afterFirst.title > 0 && afterFirst.message > 0);
  assert.strictEqual(
    writes.title,
    afterFirst.title,
    'The title was reassigned although nothing about the problem changed'
  );
  assert.strictEqual(
    writes.message,
    afterFirst.message,
    'The message was reassigned although nothing about the problem changed'
  );
});

test('A changed banner message is still written', () => {
  const { update, writes, elements } = createBannerHarness();
  update({
    scanner: HEALTHY_SCANNER,
    paperless: { reachable: false, usable: false, error: 'ECONNREFUSED' },
  });
  const afterFirst = writes.message;

  update({
    scanner: HEALTHY_SCANNER,
    paperless: { reachable: true, authorized: false, usable: false },
  });

  assert.strictEqual(writes.message, afterFirst + 1);
  assert.match(elements.message.textContent, /rejected the API credentials/i);
});

test('The dashboard banner is a status region, not an assertive alert', () => {
  const view = fs.readFileSync(
    path.join(process.cwd(), 'views', 'dashboard.ejs'),
    'utf8'
  );
  const tagStart = view.indexOf('id="scannerHealthBanner"');
  const tag = view.slice(
    view.lastIndexOf('<', tagStart),
    view.indexOf('>', tagStart)
  );

  assert.match(tag, /role="status"/);
  assert.doesNotMatch(
    tag,
    /aria-live="assertive"/,
    'An assertive region interrupts the reader on every three-second poll'
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. API payload
// ──────────────────────────────────────────────────────────────────────────────

test('The health snapshot exposes the fields the banner needs', () => {
  const scanHealthService = require('../services/scanHealthService');
  const scanControl = require('../services/scanControl');
  const {
    buildScannerHealthSnapshot,
  } = require('../services/scannerHealthSnapshot');

  const paperless = {
    reachable: false,
    authorized: true,
    usable: false,
    status: 'unreachable',
    lastCheckedAt: '2026-01-01T00:00:00.000Z',
    error: 'connect ECONNREFUSED',
  };
  const originalHealth = scanHealthService.getState;
  const originalControl = scanControl.getState;
  scanHealthService.getState = () => ({ paperless });
  scanControl.getState = () => ({ running: false });
  try {
    const snapshot = buildScannerHealthSnapshot();
    for (const field of [
      'reachable',
      'authorized',
      'usable',
      'lastCheckedAt',
    ]) {
      assert.strictEqual(
        snapshot.paperless[field],
        paperless[field],
        `Expected the snapshot to expose paperless.${field}`
      );
    }
  } finally {
    scanHealthService.getState = originalHealth;
    scanControl.getState = originalControl;
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. Standalone connectivity probe
// ──────────────────────────────────────────────────────────────────────────────

const serverSource = fs.readFileSync(
  path.join(process.cwd(), 'server.js'),
  'utf8'
);

test('The connectivity probe is armed independently of the scan loop', () => {
  assert.ok(
    serverSource.includes('function startConnectivityMonitor()'),
    'Expected a standalone Paperless-ngx probe'
  );

  const monitorCall = serverSource.indexOf('startConnectivityMonitor();');
  const startScanning = serverSource.indexOf('function startScanning()');
  assert.ok(monitorCall > -1, 'Expected the probe to be started');
  assert.ok(
    !serverSource
      .slice(startScanning, serverSource.indexOf('\n}', startScanning))
      .includes('startConnectivityMonitor()'),
    'Arming inside startScanning() would skip the probe when automatic processing is off'
  );
});

test('The probe records connectivity without touching the failure counter', () => {
  const monitorStart = serverSource.indexOf(
    'function startConnectivityMonitor'
  );
  const monitorEnd = serverSource.indexOf('// Start scanning', monitorStart);
  const monitor = serverSource.slice(monitorStart, monitorEnd);

  assert.ok(monitor.includes('recordConnectivity('));
  assert.ok(
    !monitor.includes('recordRunResult('),
    'A passive probe must not push /health into 503 on its own'
  );
  assert.ok(
    monitor.includes('clearConnectivity()'),
    'An unconfigured setup must not look like an outage'
  );
});

test('Abandoning the initial scan is counted as a failed run', () => {
  const loopStart = serverSource.indexOf(
    'async function runInitialScanWhenReachable'
  );
  const loopEnd = serverSource.indexOf('\n}', loopStart);
  const loop = serverSource.slice(loopStart, loopEnd);

  assert.ok(
    loop.includes('recordRunResult('),
    'Giving up on the initial scan left consecutiveFailures at 0, so the app never looked degraded'
  );
  assert.strictEqual(
    (loop.match(/recordRunResult\(/g) || []).length,
    1,
    'Counting every retry would trip the threshold during a normal slow start'
  );
});

// ──────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
