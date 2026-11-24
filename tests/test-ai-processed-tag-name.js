'use strict';

/**
 * The name of the AI-processed tag: unset, empty, or a name.
 *
 * ADD_AI_PROCESSED_TAG switches the tag on, AI_PROCESSED_TAG_NAME names it.
 * The settings page, the setup wizard, config.addAIProcessedTags and the
 * catalogue all said the name defaults to "ai-processed", but the code that
 * applies the tag (paperlessService.processTags) read process.env directly
 * and applied nothing while the key was unset. With the switch on and the page
 * showing "ai-processed", no document got the tag until some save of the
 * settings page happened to write the name down.
 *
 * The three states, and what each now does:
 *   - unset:  the default name, "ai-processed". The page shows it, so the tag
 *             is set.
 *   - empty:  no tag. That is what an empty name has done since #248
 *             (tests/test-ai-processed-tag-without-tags.js pins it), so the
 *             page now shows the empty name instead of "ai-processed", and a
 *             save keeps it empty.
 *   - a name: that name, as before.
 * The switch off means no tag in every state.
 *
 * Every reader agrees: processTags, config.addAIProcessedTags, the settings
 * catalogue (page, save, wizard), GET /settings, GET /setup and setup.js, the
 * names Tidy up protects (duplicateMergeService.configuredTagNames, which
 * tagSimplifyService asks too) and the .env export.
 */

// The creation guard reads the database; processTags is tested without it.
process.env.DUPLICATES_GUARD_NEW_NAMES = 'no';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

const SWITCH = 'ADD_AI_PROCESSED_TAG';
const NAME = 'AI_PROCESSED_TAG_NAME';
const DEFAULT_NAME = 'ai-processed';

delete process.env[SWITCH];
delete process.env[NAME];

let passed = 0;
let failed = 0;

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

/**
 * Sets the switch and the name for one case. `name: undefined` removes the
 * key, which is a state of its own.
 */
function configure({ on = true, name }) {
  process.env[SWITCH] = on ? 'yes' : 'no';
  if (name === undefined) delete process.env[NAME];
  else process.env[NAME] = name;
}

/** A Paperless-ngx that knows the given tags and creates any other. */
function createTagServer(existing = []) {
  const tags = new Map();
  const created = [];
  let nextId = 1;
  for (const name of existing) {
    tags.set(name.toLowerCase(), { id: nextId, name });
    nextId += 1;
  }
  return {
    tags,
    created,
    defaults: { baseURL: 'http://paperless.test/api' },
    get: async (_url, options = {}) => {
      const wanted = options?.params?.name__iexact;
      if (wanted) {
        const hit = tags.get(String(wanted).toLowerCase());
        return { data: { results: hit ? [hit] : [] } };
      }
      return {
        data: { count: tags.size, results: [...tags.values()], next: null },
      };
    },
    post: async (_url, body) => {
      const tag = { id: nextId, name: body.name };
      nextId += 1;
      created.push(body.name);
      tags.set(body.name.toLowerCase(), tag);
      return { data: tag };
    },
  };
}

/** The tag names processTags([]) applies, and what it had to create. */
async function appliedTags(paperlessService, existing = []) {
  const server = createTagServer(existing);
  const originalClient = paperlessService.client;
  paperlessService.client = server;
  paperlessService.tagCache.clear();
  paperlessService.lastTagRefresh = 0;
  try {
    const { tagIds } = await paperlessService.processTags([]);
    const byId = new Map([...server.tags.values()].map((t) => [t.id, t.name]));
    return { names: tagIds.map((id) => byId.get(id)), created: server.created };
  } finally {
    paperlessService.client = originalClient;
    paperlessService.tagCache.clear();
    paperlessService.lastTagRefresh = 0;
  }
}

/** The value attribute of an <input> by id, or null without one. */
function inputValue(html, id) {
  const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
  assert.ok(tag, `#${id} is rendered`);
  const value = tag[0].match(/\svalue="([^"]*)"/);
  return value ? value[1] : null;
}

/** window.__SETUP_BOOTSTRAP__ as GET /setup renders it. */
function setupBootstrap(html) {
  const match = html.match(
    /window\.__SETUP_BOOTSTRAP__ = (\{[\s\S]*?\});\s*<\/script>/
  );
  assert.ok(match, 'GET /setup renders the bootstrap');
  return JSON.parse(match[1]);
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

(async () => {
  const harness = await mountRouter({
    stub: ({ documentModel }) => {
      documentModel.getUsers = async () => [];
    },
  });
  Object.assign(harness.app.locals, {
    theme: 'light',
    csrfToken: 'test-csrf',
    appVersion: 'test',
  });

  const { paperlessService } = harness;
  const config = require('../config/config');
  const catalog = require('../services/settingsCatalog');
  const settingsService = require('../services/settingsService');
  const mergeService = require('../services/duplicateMergeService');
  const { renderSettingsPage } = require('./helpers/render-settings');

  /** What the settings page shows as the tag name for the current env. */
  const settingsPageName = async () =>
    inputValue(
      await renderSettingsPage({
        config: catalog.defaultsFromEnv(process.env, 'page'),
      }),
      'aiTagName'
    );

  const wizardBootstraps = {};

  try {
    /* ── Unset: the default name ─────────────────────────────────────── */

    await test('Unset, the switch on: documents get "ai-processed"', async () => {
      configure({ name: undefined });
      const existing = await appliedTags(paperlessService, [DEFAULT_NAME]);
      assert.deepStrictEqual(existing.names, [DEFAULT_NAME]);
      const fresh = await appliedTags(paperlessService);
      assert.deepStrictEqual(fresh.created, [DEFAULT_NAME], 'created once');
      assert.deepStrictEqual(fresh.names, [DEFAULT_NAME]);
    });

    await test('Unset: every reader says "ai-processed"', async () => {
      configure({ name: undefined });
      const html = await (await fetch(harness.base + '/setup')).text();
      wizardBootstraps.unset = setupBootstrap(html);
      assert.strictEqual(config.addAIProcessedTags, DEFAULT_NAME);
      for (const surface of ['page', 'save', 'wizard']) {
        assert.strictEqual(
          catalog.valueFromEnv(NAME, process.env, surface),
          DEFAULT_NAME,
          `${surface} surface`
        );
      }
      assert.strictEqual(await settingsPageName(), DEFAULT_NAME);
      assert.deepStrictEqual(mergeService.configuredTagNames(), [DEFAULT_NAME]);
      assert.strictEqual(inputValue(html, 'processedTag'), DEFAULT_NAME);
      assert.strictEqual(wizardBootstraps.unset.config[NAME], DEFAULT_NAME);
    });

    /* ── Empty: no tag, and the page says so ─────────────────────────── */

    await test('Empty, the switch on: no tag, none created', async () => {
      configure({ name: '' });
      const result = await appliedTags(paperlessService);
      assert.deepStrictEqual(result.names, []);
      assert.deepStrictEqual(result.created, []);
    });

    await test('Empty: every reader says there is no name', async () => {
      configure({ name: '' });
      const html = await (await fetch(harness.base + '/setup')).text();
      wizardBootstraps.empty = setupBootstrap(html);
      assert.strictEqual(config.addAIProcessedTags, '');
      for (const surface of ['page', 'save', 'wizard']) {
        assert.strictEqual(
          catalog.valueFromEnv(NAME, process.env, surface),
          '',
          `${surface} surface`
        );
      }
      const shown = await settingsPageName();
      assert.ok(
        shown === '' || shown === null,
        `the settings page shows "${shown}" for an empty name`
      );
      assert.deepStrictEqual(
        mergeService.configuredTagNames(),
        [],
        'Tidy up protects no name'
      );
      const wizardShown = inputValue(html, 'processedTag');
      assert.ok(
        wizardShown === '' || wizardShown === null,
        `the wizard shows "${wizardShown}" for an empty name`
      );
      assert.strictEqual(wizardBootstraps.empty.config[NAME], '');
    });

    await test('Empty: a save of the page keeps the name empty', async () => {
      configure({ name: '' });
      const current = settingsService.currentSettings(process.env);
      const { updates } = settingsService.buildFieldUpdates(
        { aiProcessedTag: 'yes', aiTagName: '' },
        current
      );
      const { merged } = settingsService.planSave(
        current,
        updates,
        process.env
      );
      assert.strictEqual(merged[NAME], '');
    });

    await test('Empty: the .env export keeps the empty name', async () => {
      configure({ name: '' });
      const { env } = settingsService.buildEnvExport(process.env);
      assert.ok(
        new RegExp(`^${NAME}=$`, 'm').test(env),
        'an empty name is exported, so the copy behaves the same'
      );
      configure({ name: undefined });
      assert.ok(
        !settingsService.buildEnvExport(process.env).env.includes(`${NAME}=`),
        'an unset name stays unset'
      );
    });

    /* ── A name ──────────────────────────────────────────────────────── */

    await test('A name: documents get that tag, and every reader says it', async () => {
      configure({ name: 'done-by-ai' });
      const result = await appliedTags(paperlessService);
      assert.deepStrictEqual(result.names, ['done-by-ai']);
      assert.strictEqual(config.addAIProcessedTags, 'done-by-ai');
      assert.strictEqual(await settingsPageName(), 'done-by-ai');
      assert.deepStrictEqual(mergeService.configuredTagNames(), ['done-by-ai']);
    });

    /* ── The switch off ──────────────────────────────────────────────── */

    await test('The switch off: no tag in any state', async () => {
      for (const name of [undefined, '', 'done-by-ai']) {
        configure({ on: false, name });
        const result = await appliedTags(paperlessService);
        assert.deepStrictEqual(result.names, [], `name ${String(name)}`);
        assert.deepStrictEqual(result.created, []);
        assert.deepStrictEqual(mergeService.configuredTagNames(), []);
      }
    });
  } finally {
    await harness.close();
  }

  /* ── setup.js: the wizard field doubles as the switch ─────────────────── */

  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;

  await test('setup.js: unset prefills "ai-processed", empty prefills nothing', async () => {
    const wizard = loadWizard(wizardBootstraps.unset);
    assert.strictEqual(wizard.processedTag.value, DEFAULT_NAME);
    let preview = wizard.buildEnvPreview();
    assert.ok(preview.includes(`${SWITCH}=yes`));
    assert.ok(preview.includes(`${NAME}=${DEFAULT_NAME}`));

    // The script declares a top-level class, so it loads once; reopening the
    // wizard with another configuration is populateInitialValues() again.
    wizard.config = wizardBootstraps.empty.config;
    wizard.populateInitialValues();
    assert.strictEqual(wizard.processedTag.value, '');
    preview = wizard.buildEnvPreview();
    assert.ok(preview.includes(`${SWITCH}=no`), 'no name, no tag');
  });

  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
