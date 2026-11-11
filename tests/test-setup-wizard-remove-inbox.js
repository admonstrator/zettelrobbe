'use strict';

/**
 * The setup wizard's "Remove the inbox tag when a document is done" switch.
 *
 * The Document scope step offers REMOVE_INBOX_TAGS_AFTER_PROCESSING next to
 * the processed tag, because whoever sets that tag usually wants this
 * workflow. Covered end to end:
 *   1. GET /setup renders the switch, off by default and on when the
 *      configuration says yes.
 *   2. public/js/setup.js prefills it from the configuration, sends it in the
 *      setup payload and lists it in the review step's env preview.
 *   3. POST /api/setup/complete saves 'yes' / 'no' from the body, and 'no'
 *      when the key is absent (requests from older clients).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

const SWITCH_ID = 'removeInboxTagsAfterProcessing';
const ENV_KEY = 'REMOVE_INBOX_TAGS_AFTER_PROCESSING';

let passed = 0;
let failed = 0;

// A successful POST /api/setup/complete schedules process.exit(0) later.
const realExit = process.exit.bind(process);
process.exit = () => {};

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed++;
  }
}

/* The <input> tag of the switch as rendered, or null. */
function switchTag(html) {
  const match = html.match(new RegExp(`<input id="${SWITCH_ID}"[^>]*>`));
  return match ? match[0] : null;
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

function loadWizard(config) {
  // Every id the script asks for gets an element, as on the rendered page.
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

  global.window = {
    __SETUP_BOOTSTRAP__: { config, defaults: {}, aiProviderPresets: [] },
    fetch: async () => ({}),
  };
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
  // Node has its own read-only navigator.
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

(async () => {
  const savedConfigs = [];
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const harness = await mountRouter({
    stub: ({ setupService, documentModel }) => {
      setupService.saveConfig = async (config) => {
        savedConfigs.push(config);
      };
      // The wizard closes for good once an account exists; this file
      // completes it more than once.
      documentModel.getUsers = async () => [];
    },
  });
  Object.assign(harness.app.locals, {
    theme: 'light',
    csrfToken: 'test-csrf',
    appVersion: 'test',
  });

  const complete = async (extra) => {
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
    return { body, saved: savedConfigs[savedConfigs.length - 1] };
  };

  try {
    await test('GET /setup renders the switch in Document scope, off by default', async () => {
      delete process.env[ENV_KEY];
      const response = await fetch(harness.base + '/setup');
      assert.strictEqual(response.status, 200);
      const html = await response.text();
      const tag = switchTag(html);
      assert.ok(tag, 'the switch is rendered');
      assert.ok(tag.includes('type="checkbox"'));
      assert.ok(tag.includes('class="zr-toggle"'));
      assert.ok(!/\schecked\b/.test(tag), 'off by default');
      assert.ok(
        html.includes('Remove the inbox tag when a document is done'),
        'the label is shown'
      );
      assert.ok(
        html.includes(
          'Paperless-ngx marks the tags it uses as inbox; every one of them is taken off a document once the analysis was written. Use it when you let the analysis file documents on its own.'
        ),
        'the hint is shown'
      );
      // In the Document scope step, after the processed tag field.
      const processedAt = html.indexOf('id="processedTag"');
      const switchAt = html.indexOf(`id="${SWITCH_ID}"`);
      const nextStepAt = html.indexOf('data-step-title="AI provider"');
      assert.ok(processedAt > 0 && switchAt > processedAt);
      assert.ok(switchAt < nextStepAt, 'before the AI provider step');
    });

    await test('GET /setup renders the switch on when the configuration says yes', async () => {
      process.env[ENV_KEY] = 'yes';
      try {
        const html = await (await fetch(harness.base + '/setup')).text();
        const tag = switchTag(html);
        assert.ok(tag && /\schecked\b/.test(tag), 'checked');
        assert.ok(
          html.includes(`"${ENV_KEY}":"yes"`),
          'the bootstrap config carries the value for the script'
        );
      } finally {
        delete process.env[ENV_KEY];
      }
    });

    await test('POST /api/setup/complete saves yes when the switch is on', async () => {
      const { body, saved } = await complete({
        removeInboxTagsAfterProcessing: true,
      });
      assert.strictEqual(saved[ENV_KEY], 'yes');
      assert.ok(body.envPreview.includes(`${ENV_KEY}=yes`));
    });

    await test('POST /api/setup/complete saves no when the switch is off', async () => {
      const { saved } = await complete({
        removeInboxTagsAfterProcessing: false,
      });
      assert.strictEqual(saved[ENV_KEY], 'no');
    });

    await test('POST /api/setup/complete saves no when the key is absent (older clients)', async () => {
      const { saved } = await complete({});
      assert.ok(ENV_KEY in saved, 'the key is written');
      assert.strictEqual(saved[ENV_KEY], 'no');
    });
  } finally {
    await harness.close();
  }

  // The script part runs after the harness: it replaces the timer globals.
  await test('setup.js: off by default, payload false, preview no', async () => {
    const wizard = loadWizard({});
    assert.strictEqual(wizard[SWITCH_ID].checked, false);
    assert.strictEqual(wizard.buildFinalizePayload()[SWITCH_ID], false);
    assert.ok(wizard.buildEnvPreview().includes(`${ENV_KEY}=no`));
  });

  await test('setup.js: prefilled from the configuration, payload true, preview yes', async () => {
    // The script declares a top-level class, so it loads once; reopening the
    // wizard with a configuration is populateInitialValues() again.
    const wizard = window.setupWizard;
    wizard.config = { [ENV_KEY]: 'yes' };
    wizard.populateInitialValues();
    assert.strictEqual(wizard[SWITCH_ID].checked, true);
    assert.strictEqual(wizard.buildFinalizePayload()[SWITCH_ID], true);
    assert.ok(wizard.buildEnvPreview().includes(`${ENV_KEY}=yes`));

    wizard[SWITCH_ID].checked = false;
    assert.strictEqual(wizard.buildFinalizePayload()[SWITCH_ID], false);
    assert.ok(wizard.buildEnvPreview().includes(`${ENV_KEY}=no`));
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
