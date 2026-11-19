'use strict';

/**
 * The OCR timeout has one default, and every surface uses it.
 *
 * SETUP_OCR_VALIDATION_TIMEOUT_MS sets how long Zettelrobbe waits for one OCR
 * request (and how long Test OCR connection and Fetch models wait). Without
 * the key, document OCR in services/mistralOcrService.js waited 120 seconds,
 * while the settings page, the setup wizard and a save offered 30 seconds:
 * the page showed 30, OCR waited 120, and the first save of the page wrote
 * 30 down without anyone touching the field.
 *
 * The runtime's 120 seconds is what an installation without the key has
 * always experienced, so it is the default; every other surface now says the
 * same. The runtime number is measured, not assumed, so this test compares
 * every surface against what OCR really waits.
 *
 * Covers, with neither SETUP_OCR_VALIDATION_TIMEOUT_MS nor
 * SETUP_VALIDATION_TIMEOUT_MS set:
 *  1. OCR waits 120 seconds, as it always did
 *  2. the settings catalogue reports that number on the page, save and wizard
 *     surfaces
 *  3. GET /settings shows it in the OCR timeout field
 *  4. a settings save without the field, or with it empty, writes it
 *  5. GET /setup shows it, hands it to the script, and its hint names it
 *  6. POST /api/setup/complete without a timeout writes it
 *  7. public/js/setup.js falls back to it for an empty field (payload and
 *     .env preview)
 *  8. public/js/settings.js falls back to the value the page rendered, never
 *     to a number of its own
 * And:
 *  9. a value that is set wins on every surface, and
 *     SETUP_VALIDATION_TIMEOUT_MS stands in for it on every surface
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

const KEY = 'SETUP_OCR_VALIDATION_TIMEOUT_MS';
const FALLBACK_KEY = 'SETUP_VALIDATION_TIMEOUT_MS';
/** What document OCR waited without the key before this change (1572d36). */
const HISTORICAL_RUNTIME_MS = 120000;

delete process.env[KEY];
delete process.env[FALLBACK_KEY];

let passed = 0;
let failed = 0;

// A successful POST /api/setup/complete schedules process.exit(0) later.
const realExit = process.exit.bind(process);
process.exit = () => {};

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed += 1;
  }
}

/** Runs fn with the two timeout keys set as given, then restores them. */
async function withEnv(values, fn) {
  const saved = {
    [KEY]: process.env[KEY],
    [FALLBACK_KEY]: process.env[FALLBACK_KEY],
  };
  delete process.env[KEY];
  delete process.env[FALLBACK_KEY];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The value attribute of the OCR timeout <input> in a rendered page. */
function fieldValue(html) {
  const tag = html.match(/<input[^>]*id="ocrValidationTimeout"[^>]*>/);
  assert.ok(tag, 'the OCR timeout field is rendered');
  const value = tag[0].match(/\svalue="([^"]*)"/);
  assert.ok(value, 'the OCR timeout field has a value');
  return value[1];
}

/** window.__SETUP_BOOTSTRAP__ as GET /setup renders it. */
function setupBootstrap(html) {
  const match = html.match(
    /window\.__SETUP_BOOTSTRAP__ = (\{[\s\S]*?\});\s*<\/script>/
  );
  assert.ok(match, 'GET /setup renders the bootstrap');
  return JSON.parse(match[1]);
}

/** The hint paragraph that follows the OCR timeout field. */
function fieldHint(html) {
  const at = html.indexOf('id="ocrValidationTimeout"');
  assert.ok(at > 0);
  const hint = html.slice(at).match(/<p class="zr-field__hint">([^<]*)<\/p>/);
  assert.ok(hint, 'the field has a hint');
  return hint[1];
}

/* ── public/js/setup.js in a minimal DOM ─────────────────────────────────── */

function createMockClassList() {
  const classes = new Set();
  return {
    add: (...items) => items.forEach((item) => classes.add(item)),
    remove: (...items) => items.forEach((item) => classes.delete(item)),
    toggle: (item, force) => {
      if (force === undefined ? !classes.has(item) : force) {
        classes.add(item);
        return true;
      }
      classes.delete(item);
      return false;
    },
    contains: (item) => classes.has(item),
  };
}

function createMockElement(id) {
  const listeners = {};
  return {
    id,
    value: '',
    checked: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    className: '',
    style: {},
    dataset: {},
    classList: createMockClassList(),
    appendChild: () => {},
    addEventListener: (event, handler) => {
      (listeners[event] = listeners[event] || []).push(handler);
    },
    dispatchEvent: (eventName) => {
      (listeners[eventName] || []).forEach((fn) => fn());
    },
    focus: () => {},
    select: () => {},
    setAttribute: () => {},
    removeAttribute: () => {},
  };
}

/** Loads setup.js once with the bootstrap GET /setup rendered. */
function loadWizard(bootstrap) {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, createMockElement(id));
    return elements.get(id);
  };
  const steps = Array.from({ length: 7 }, (_unused, index) => ({
    dataset: { stepTitle: `Step ${index + 1}` },
    classList: createMockClassList(),
    style: {},
    disabled: false,
  }));

  global.window = { __SETUP_BOOTSTRAP__: bootstrap, fetch: async () => ({}) };
  global.document = {
    addEventListener: (_event, callback) => callback(),
    querySelectorAll: (selector) => (selector === '.zr-steppane' ? steps : []),
    querySelector: (selector) =>
      selector === 'meta[name="csrf-token"]'
        ? { getAttribute: () => '' }
        : null,
    getElementById: getElement,
    createElement: (tagName) => createMockElement(tagName),
  };
  global.Swal = { fire: async () => ({ isConfirmed: false }) };
  Object.defineProperty(global, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
  });
  global.Headers = class Headers {};
  global.setInterval = () => 1;
  global.clearInterval = () => {};

  const setupJsPath = path.join(REPO_ROOT, 'public', 'js', 'setup.js');
  vm.runInThisContext(fs.readFileSync(setupJsPath, 'utf8'), {
    filename: setupJsPath,
  });
  return window.setupWizard;
}

/* ── public/js/settings.js: the timeout helper, run on its own ───────────── */

/**
 * getOcrValidationTimeoutMs() as settings.js defines it, bound to a stub of
 * the field. The page script needs a whole DOM to start; this one function
 * only reads the field.
 */
function settingsTimeoutHelper(field) {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'public', 'js', 'settings.js'),
    'utf8'
  );
  const start = source.indexOf('const getOcrValidationTimeoutMs = () => {');
  assert.ok(start > 0, 'settings.js defines getOcrValidationTimeoutMs');
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    if (source[end] === '}') depth -= 1;
    if (depth === 0) break;
  }
  const body = source.slice(start, end + 1);
  return new Function(
    'ocrValidationTimeoutInput',
    `${body}\nreturn getOcrValidationTimeoutMs;`
  )(field);
}

(async () => {
  const savedConfigs = [];
  const harness = await mountRouter({
    stub: ({ setupService, documentModel }) => {
      setupService.saveConfig = async (config) => {
        savedConfigs.push(config);
      };
      documentModel.getUsers = async () => [];
    },
  });
  Object.assign(harness.app.locals, {
    theme: 'light',
    csrfToken: 'test-csrf',
    appVersion: 'test',
  });

  // Loaded after the harness: the OCR service opens the database on load.
  const ocrService = require('../services/mistralOcrService');
  const catalog = require('../services/settingsCatalog');
  const settingsService = require('../services/settingsService');
  const { renderSettingsPage } = require('./helpers/render-settings');

  const runtimeMs = () => ocrService.ocrTimeoutMs;

  const complete = async (extra = {}) => {
    const response = await fetch(harness.base + '/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminUsername: 'admin',
        adminPassword: 'long-enough-password',
        paperlessUrl: 'http://paperless.test',
        paperlessUsername: 'admin',
        paperlessToken: 'paperless-token',
        scanAllDocuments: true,
        processedTag: 'ai-processed',
        aiProvider: 'openai',
        aiApiUrl: 'https://api.openai.com/v1',
        aiToken: 'sk-test',
        aiModel: 'gpt-4o-mini',
        mistralOcrEnabled: false,
        paperlessTestPassed: true,
        aiTestPassed: true,
        ...extra,
      }),
    });
    const body = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    return savedConfigs[savedConfigs.length - 1];
  };

  let setupHtml = '';

  try {
    await test('Without the key, OCR waits 120 seconds, as it always did', async () => {
      assert.strictEqual(runtimeMs(), HISTORICAL_RUNTIME_MS);
      const { DEFAULT_OCR_TIMEOUT_MS } = require('../services/ocrTimeout');
      assert.strictEqual(DEFAULT_OCR_TIMEOUT_MS, HISTORICAL_RUNTIME_MS);
    });

    await test('The catalogue reports the same number on the page, save and wizard surfaces', async () => {
      for (const surface of ['page', 'save', 'wizard']) {
        assert.strictEqual(
          Number(catalog.valueFromEnv(KEY, {}, surface)),
          runtimeMs(),
          `${surface} surface`
        );
      }
      assert.strictEqual(Number(catalog.getEntry(KEY).default), runtimeMs());
    });

    await test('GET /settings shows it in the OCR timeout field', async () => {
      const html = await renderSettingsPage();
      assert.strictEqual(Number(fieldValue(html)) * 1000, runtimeMs());
    });

    await test('A settings save without the field, or with it empty, writes it', async () => {
      const current = settingsService.currentSettings({});
      for (const body of [{}, { ocrValidationTimeout: '' }]) {
        const ocr = settingsService.resolveOcrSettings(body, current);
        assert.strictEqual(
          ocr.validationTimeoutMs,
          runtimeMs(),
          JSON.stringify(body)
        );
        const values = settingsService.buildOcrUpdate(body, current, ocr, {});
        assert.strictEqual(Number(values[KEY]), runtimeMs());
      }
      // Nothing in effect at all (a configuration that predates the key).
      const bare = settingsService.resolveOcrSettings({}, {});
      assert.strictEqual(bare.validationTimeoutMs, runtimeMs());
    });

    await test('GET /setup shows it, hands it to the script and names it in the hint', async () => {
      const response = await fetch(harness.base + '/setup');
      assert.strictEqual(response.status, 200);
      setupHtml = await response.text();
      assert.strictEqual(Number(fieldValue(setupHtml)) * 1000, runtimeMs());
      const bootstrap = setupBootstrap(setupHtml);
      assert.strictEqual(Number(bootstrap.config[KEY]), runtimeMs());
      assert.strictEqual(Number(bootstrap.defaults.ocrTimeoutMs), runtimeMs());
      const hint = fieldHint(setupHtml);
      assert.ok(
        hint.includes(`Default: ${runtimeMs() / 1000} seconds.`),
        `the hint names the default: ${hint}`
      );
    });

    await test('POST /api/setup/complete without a timeout writes it', async () => {
      const saved = await complete();
      assert.strictEqual(Number(saved[KEY]), runtimeMs());
    });

    await test('A value that is set wins on every surface', async () => {
      await withEnv({ [KEY]: '45000' }, async () => {
        assert.strictEqual(runtimeMs(), 45000);
        assert.strictEqual(
          catalog.valueFromEnv(KEY, process.env, 'page'),
          '45000'
        );
        assert.strictEqual(
          Number(
            fieldValue(
              await renderSettingsPage({
                config: catalog.defaultsFromEnv(process.env, 'page'),
              })
            )
          ),
          45
        );
        const current = settingsService.currentSettings(process.env);
        assert.strictEqual(
          settingsService.resolveOcrSettings({}, current).validationTimeoutMs,
          45000
        );
        const html = await (await fetch(harness.base + '/setup')).text();
        assert.strictEqual(fieldValue(html), '45');
      });
    });

    await test('SETUP_VALIDATION_TIMEOUT_MS stands in for the key on every surface', async () => {
      await withEnv({ [FALLBACK_KEY]: '9000' }, async () => {
        assert.strictEqual(runtimeMs(), 9000);
        assert.strictEqual(
          catalog.valueFromEnv(KEY, process.env, 'page'),
          '9000'
        );
        assert.strictEqual(
          Number(
            fieldValue(
              await renderSettingsPage({
                config: catalog.defaultsFromEnv(process.env, 'page'),
              })
            )
          ),
          9
        );
        const html = await (await fetch(harness.base + '/setup')).text();
        assert.strictEqual(fieldValue(html), '9');
      });
    });
  } finally {
    await harness.close();
  }

  // The script parts run after the harness: they replace the timer globals.
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;

  await test('setup.js: an empty field falls back to the default, in the payload and the .env preview', async () => {
    const wizard = loadWizard(setupBootstrap(setupHtml));
    assert.strictEqual(
      Number(wizard.ocrValidationTimeout.value) * 1000,
      runtimeMs()
    );
    wizard.ocrValidationTimeout.value = '';
    assert.strictEqual(wizard.getOcrValidationTimeoutMs(), runtimeMs());
    assert.ok(
      wizard.buildEnvPreview().includes(`${KEY}=${runtimeMs()}`),
      'the .env preview carries the default'
    );
    wizard.ocrValidationTimeout.value = '45';
    assert.strictEqual(wizard.getOcrValidationTimeoutMs(), 45000);
  });

  await test('settings.js: an empty field falls back to the value the page rendered, never to a number of its own', async () => {
    const field = {
      value: '',
      defaultValue: String(HISTORICAL_RUNTIME_MS / 1000),
    };
    const timeoutMs = settingsTimeoutHelper(field);
    assert.strictEqual(timeoutMs(), HISTORICAL_RUNTIME_MS);
    field.value = '45';
    assert.strictEqual(timeoutMs(), 45000);
    field.value = '99999';
    assert.strictEqual(timeoutMs(), 7200000, 'clamped to the field maximum');
    // Nothing to go by: the request leaves the timeout to the server.
    field.value = '';
    field.defaultValue = '';
    assert.strictEqual(timeoutMs(), undefined);
  });

  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit = realExit;
  realExit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit = realExit;
  realExit(1);
});
