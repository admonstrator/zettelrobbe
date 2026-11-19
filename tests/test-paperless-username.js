'use strict';

/**
 * Test: PAPERLESS_USERNAME, what reads it and what it is not needed for
 *
 * Zettelrobbe signs in to Paperless-ngx with the API token alone
 * (`Authorization: Token …`). The user name came over from
 * clusterzx/paperless-ai with the first commit of this repository (da558c1):
 * getOwnUserID() matched it against /api/users/, and three guards refused to
 * scan when that failed — at startup, behind "Scan now" and in the manual
 * queue. The ID they resolved was handed to processDocument(), which never
 * read it; whether a document may be changed was already decided by
 * Paperless-ngx's own user_can_change. 3dfc880 (#272) removed the startup
 * guard, 4fa54be (#305) the other two. Since then nothing calls
 * getOwnUserID(), and the name changes nothing Zettelrobbe does to a
 * document.
 *
 * The pages still required it: the settings page refused to save without
 * one, the setup wizard refused to continue (page, script and
 * POST /api/setup/complete), and Quick start called the Paperless-ngx row
 * unfinished. This file pins both halves, so that the answer stays true and
 * the name stays optional.
 *
 * Covers:
 *  1. In the code that runs, only the settings save, the .env export, the
 *     wizard and paperlessService.getOwnUserID() read the name;
 *     config/config.js has no getter for it, and the processing path does
 *     not mention it
 *  2. getOwnUserID() has no caller
 *  3. The Paperless-ngx client signs in with the token alone: the name is in
 *     no header, and there is no basic auth
 *  4. Writing a document and creating a tag, a correspondent and a document
 *     type send no owner, no permissions and not the name
 *  5. The settings page: the field is optional and says what the name is for
 *  6. Quick start: address and token finish the Paperless-ngx row; the name
 *     is shown when there is one, and editing it does not void the probe
 *  7. The setup wizard: the page, its step check and POST /api/setup/complete
 *     accept an empty name
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const MARKER = 'zr-username-marker';

let passed = 0;
let failed = 0;

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

const read = (relative) =>
  fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

/** Every .js file of the server side: what runs in a running installation. */
function serverFiles() {
  const files = ['server.js'];
  for (const dir of ['routes', 'services', 'middleware', 'models', 'config']) {
    const walk = (relative) => {
      for (const entry of fs.readdirSync(path.join(REPO_ROOT, relative), {
        withFileTypes: true,
      })) {
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith('.js')) files.push(child);
      }
    };
    walk(dir);
  }
  return files.map((file) => file.split(path.sep).join('/'));
}

/** True for a line that is a comment or part of a JSDoc block. */
const isCommentLine = (line) => /^\s*(\/\/|\/?\*)/.test(line);

/* ── 1–2. Who reads the name ─────────────────────────────────────────────── */

const NAME_PATTERN = /PAPERLESS_USERNAME|paperlessUsername/;

/**
 * The server files that may read the name, and what each does with it. A
 * file not listed here that starts to read it fails the census: decide
 * whether the name is needed after all, and update the hints on the settings
 * page and in the wizard that say it is not.
 */
const READERS = {
  // The settings catalogue: the key, its form field, its .env export group.
  'services/settingsCatalog.js': 'saved and exported',
  // The wizard's saved configuration, built from the form body.
  'services/settingsService.js': 'saved by the wizard',
  // The wizard: the form field and the .env preview.
  'routes/setupWizard.js': 'saved by the wizard',
  // getOwnUserID() prefers the configured name; nothing calls it (case 2).
  'services/paperlessService.js': 'getOwnUserID() only',
};

/** Files that only mention the name in a comment or in API documentation. */
const MENTIONED_IN_COMMENTS = ['routes/scan.js', 'routes/settings.js'];

/** The files a document passes through from the scan to the write-back. */
const PROCESSING_PATH = [
  'server.js',
  'services/scanService.js',
  'services/documentPipeline.js',
  'services/webhookQueueService.js',
  'services/analysisPrompt.js',
  'services/aiServiceFactory.js',
  'services/openaiCompatibleService.js',
  'services/ollamaService.js',
  'services/anthropicService.js',
  'services/mistralOcrService.js',
  'config/config.js',
];

async function censusTests() {
  const files = serverFiles();

  await test('Only the save, the export, the wizard and getOwnUserID() read the name', () => {
    const readers = files.filter((file) => NAME_PATTERN.test(read(file)));
    const unexpected = readers.filter(
      (file) => !(file in READERS) && !MENTIONED_IN_COMMENTS.includes(file)
    );
    assert.deepStrictEqual(
      unexpected,
      [],
      'a new reader of PAPERLESS_USERNAME: decide whether Zettelrobbe needs the name, then update READERS and the hints that call it optional'
    );
    for (const file of MENTIONED_IN_COMMENTS) {
      const code = read(file)
        .split('\n')
        .filter((line) => NAME_PATTERN.test(line) && !isCommentLine(line));
      assert.deepStrictEqual(code, [], `${file} reads the name in code`);
    }
  });

  await test('config/config.js has no getter for the name', () => {
    assert.ok(!NAME_PATTERN.test(read('config/config.js')));
  });

  await test('No file of the processing path reads the name or the own user ID', () => {
    for (const file of PROCESSING_PATH) {
      const source = read(file);
      assert.ok(!NAME_PATTERN.test(source), `${file} reads the name`);
      assert.ok(
        !source.includes('getOwnUserID'),
        `${file} resolves the own user ID`
      );
    }
  });

  await test('In paperlessService.js the name is read inside getOwnUserID() and nowhere else', () => {
    const source = read('services/paperlessService.js');
    const start = source.indexOf('async getOwnUserID()');
    assert.ok(start > 0, 'getOwnUserID() is still defined');
    // The comment above the method names the key as well.
    const from = source.lastIndexOf('/*', start);
    const end = source.indexOf('\n  }\n', start);
    const outside = [...source.matchAll(/PAPERLESS_USERNAME/g)]
      .map((match) => match.index)
      .filter((index) => index < from || index > end);
    assert.deepStrictEqual(outside, [], 'the name read outside getOwnUserID()');
  });

  await test('getOwnUserID() has no caller', () => {
    const calls = [];
    for (const file of [...files, ...clientFiles()]) {
      read(file)
        .split('\n')
        .forEach((line, index) => {
          if (
            line.includes('getOwnUserID') &&
            !isCommentLine(line) &&
            !/async getOwnUserID\(\)/.test(line)
          ) {
            calls.push(`${file}:${index + 1}`);
          }
        });
    }
    assert.deepStrictEqual(
      calls,
      [],
      'a caller of getOwnUserID() makes PAPERLESS_USERNAME matter again'
    );
  });
}

/** The scripts the browser loads. */
function clientFiles() {
  const files = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, relative), {
      withFileTypes: true,
    })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.js')) files.push(child);
    }
  };
  walk('public/js');
  return files.map((file) => file.split(path.sep).join('/'));
}

/* ── 3–4. The token alone ────────────────────────────────────────────────── */

/**
 * An axios-shaped client that answers every request with something the
 * write paths accept and records what was sent.
 */
function recordingClient() {
  const calls = [];
  const record = (method, url, body, config) => {
    calls.push({ method, url, body, config });
  };
  return {
    calls,
    async get(url, config = {}) {
      record('get', url, undefined, config);
      return {
        data: {
          results: [],
          count: 0,
          next: null,
          id: 1,
          title: 'Invoice',
          tags: [],
          correspondent: null,
          document_type: null,
          custom_fields: [],
        },
      };
    },
    async post(url, body, config = {}) {
      record('post', url, body, config);
      return { data: { id: 501, ...(body || {}) } };
    },
    async patch(url, body, config = {}) {
      record('patch', url, body, config);
      return { data: { id: 1, ...(body || {}) } };
    },
    async put(url, body, config = {}) {
      record('put', url, body, config);
      return { data: {} };
    },
    async delete(url, config = {}) {
      record('delete', url, undefined, config);
      return { data: {} };
    },
  };
}

async function tokenTests() {
  const paperlessService = require('../services/paperlessService');

  await test('The Paperless-ngx client signs in with the token alone', () => {
    paperlessService.client = null;
    paperlessService.initialize();
    const defaults = paperlessService.client.defaults;
    assert.strictEqual(defaults.headers.Authorization, 'Token token-only');
    assert.strictEqual(defaults.auth, undefined, 'no basic auth');
    assert.ok(
      !JSON.stringify(defaults.headers).includes(MARKER),
      'the name is in no header'
    );
  });

  await test('Writes and creations send no owner, no permissions and not the name', async () => {
    const client = recordingClient();
    paperlessService.client = client;
    const quiet = console.log;
    console.log = () => {};
    try {
      await paperlessService.createTagSafely('Electricity');
      await paperlessService.getOrCreateCorrespondent('Stadtwerke Nord');
      await paperlessService.getOrCreateDocumentType('Invoice');
      await paperlessService.updateDocument(1, {
        title: 'Electricity bill',
        tags: [501],
        correspondent: 501,
        document_type: 501,
      });
    } finally {
      console.log = quiet;
    }

    const writes = client.calls.filter((call) => call.method !== 'get');
    assert.deepStrictEqual(
      writes.map((call) => `${call.method} ${call.url}`),
      [
        'post /tags/',
        'post /correspondents/',
        'post /document_types/',
        'patch /documents/1/',
      ],
      'the four writes were made'
    );
    for (const call of client.calls) {
      const sent = JSON.stringify(call);
      assert.ok(!sent.includes(MARKER), `${call.url} carries the name`);
      if (call.body && typeof call.body === 'object') {
        for (const key of ['owner', 'set_permissions', 'permissions']) {
          assert.ok(!(key in call.body), `${call.url} sends ${key}`);
        }
      }
    }
  });
}

/* ── 5–6. The settings page and Quick start ──────────────────────────────── */

/** The rendered field of `id` on the settings page: label, input and hint. */
function settingsField(html, id) {
  const at = html.indexOf(`<input type="text" id="${id}"`);
  assert.ok(at > 0, `#${id} is rendered`);
  const start = html.lastIndexOf('<div class="zr-field', at);
  const end = html.indexOf('</div>', at);
  return html.slice(start, end);
}

async function pageTests() {
  const { renderSettingsPage } = require('./helpers/render-settings');
  const html = await renderSettingsPage();

  await test('Settings page: the user name is optional and says what it is for', () => {
    const field = settingsField(html, 'paperlessUsername');
    const input = field.match(/<input[^>]*>/)[0];
    assert.ok(
      !/\srequired\b/.test(input),
      'a required field blocks every save of an installation without a name'
    );
    assert.match(field, /User name \(optional\)/);
    assert.match(field, /signs in with the API token alone/);
    assert.ok(
      !field.includes('The Paperless-ngx user the token belongs to'),
      'the old hint implied the name was needed'
    );
  });

  await test('Quick start: the user name row is optional and says so', () => {
    const start = html.indexOf('data-mirror="paperlessUsername"');
    assert.ok(start > 0, 'Quick start mirrors the field');
    const row = html.slice(
      html.lastIndexOf('<div class="zr-qs__field"', start),
      html.indexOf('</div>', start)
    );
    assert.match(row, /User name \(optional\)/);
    assert.match(row, /signs in with the API token alone/);
  });

  const qs = await import(
    path.join(REPO_ROOT, 'public', 'js', 'modules', 'settings-quick-start.js')
  );

  await test('Quick start: address and token finish the Paperless-ngx row', () => {
    const base = { url: 'http://paperless:8000', tokenPresent: true };
    assert.deepStrictEqual(qs.summarizePaperless({ ...base, username: '' }), {
      state: 'done',
      text: 'http://paperless:8000',
    });
    assert.deepStrictEqual(
      qs.summarizePaperless({ ...base, username: ' ', connection: 'ok' }),
      { state: 'done', text: 'http://paperless:8000 · connected' }
    );
    assert.deepStrictEqual(
      qs.summarizePaperless({ ...base, username: 'admin', connection: 'ok' }),
      { state: 'done', text: 'http://paperless:8000 · user admin · connected' },
      'a name that is there is still shown'
    );
  });

  await test('Quick start: editing the name does not void the connection probe', () => {
    const source = read('public/js/modules/settings-quick-start.js');
    const block = source.slice(
      source.indexOf('const connectionFields = ['),
      source.indexOf('];', source.indexOf('const connectionFields = ['))
    );
    assert.ok(block.includes("'paperlessUrl'"));
    assert.ok(block.includes("'paperlessToken'"));
    assert.ok(
      !block.includes("'paperlessUsername'"),
      'the probe never sends the name, so a new name leaves its word standing'
    );
  });
}

/* ── 7. The setup wizard ─────────────────────────────────────────────────── */

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

/** public/js/setup.js in a minimal DOM; returns the wizard and its dialogs. */
function loadWizard() {
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
  const dialogs = [];

  global.window = {
    __SETUP_BOOTSTRAP__: { config: {}, defaults: {}, aiProviderPresets: [] },
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
  global.zrDialog = async (options) => {
    dialogs.push(options);
    return { isConfirmed: false, isDismissed: true };
  };
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
  return { wizard: window.setupWizard, dialogs };
}

async function wizardRouteTests() {
  const { mountRouter } = require('./helpers/mount-router');
  // A successful POST /api/setup/complete schedules a restart.
  require('../services/restartService').exit = () => {};
  const savedConfigs = [];
  const harness = await mountRouter({
    // This file already runs in a throwaway directory of its own.
    modelsLoadedInTempDir: true,
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

  try {
    await test('Wizard page: the user name is optional and says what it is for', async () => {
      const html = await (await fetch(harness.base + '/setup')).text();
      const input = html.match(/<input id="paperlessUsername"[^>]*>/);
      assert.ok(input, 'the field is rendered');
      assert.ok(!/\srequired\b/.test(input[0]), input[0]);
      const field = html.slice(
        html.lastIndexOf('<div class="zr-field', input.index),
        html.indexOf('</div>', input.index)
      );
      assert.match(field, /Paperless username \(optional\)/);
      assert.match(field, /signs in with the API token alone/);
    });

    await test('POST /api/setup/complete accepts an empty user name and saves it empty', async () => {
      const response = await fetch(harness.base + '/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminUsername: 'admin',
          adminPassword: 'long-enough-password',
          paperlessUrl: 'http://paperless.test',
          paperlessUsername: '',
          paperlessToken: 'paperless-token',
          scanAllDocuments: true,
          aiProvider: 'openai',
          aiApiUrl: 'https://api.openai.com/v1',
          aiToken: 'sk-test',
          aiModel: 'gpt-4o-mini',
          mistralOcrEnabled: false,
          paperlessTestPassed: true,
          aiTestPassed: true,
        }),
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200, JSON.stringify(body));
      const saved = savedConfigs[savedConfigs.length - 1];
      assert.strictEqual(saved.PAPERLESS_USERNAME, '');
      assert.strictEqual(saved.PAPERLESS_API_TOKEN, 'paperless-token');
    });

    await test('POST /api/setup/complete still refuses a missing token', async () => {
      const response = await fetch(harness.base + '/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminUsername: 'admin',
          adminPassword: 'long-enough-password',
          paperlessUrl: 'http://paperless.test',
          paperlessUsername: 'admin',
          paperlessToken: '',
          scanAllDocuments: true,
          aiProvider: 'openai',
          aiToken: 'sk-test',
          aiModel: 'gpt-4o-mini',
          paperlessTestPassed: true,
          aiTestPassed: true,
        }),
      });
      const body = await response.json();
      assert.strictEqual(response.status, 400);
      assert.match(body.error, /token are required/);
      assert.ok(!/username/i.test(body.error), body.error);
    });
  } finally {
    await harness.close();
  }
}

async function wizardScriptTests() {
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  try {
    const { wizard, dialogs } = loadWizard();

    await test('Wizard script: address and token are enough to leave the Paperless-ngx step', async () => {
      wizard.paperlessUrl.value = 'http://paperless:8000';
      wizard.paperlessUsername.value = '';
      wizard.paperlessToken.value = 'token';
      wizard.paperlessTestState = {
        ran: true,
        success: true,
        allowFailure: false,
      };
      dialogs.length = 0;
      assert.strictEqual(await wizard.validateStepBeforeContinue(2), true);
      assert.deepStrictEqual(dialogs, [], 'no "Missing values" dialog');
    });

    await test('Wizard script: an empty token still stops the step', async () => {
      wizard.paperlessToken.value = '';
      dialogs.length = 0;
      assert.strictEqual(await wizard.validateStepBeforeContinue(2), false);
      assert.strictEqual(dialogs.length, 1);
      assert.ok(!/username/i.test(dialogs[0].text), dialogs[0].text);
    });
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async () => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-username-'));
  process.chdir(tempRoot);
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://paperless.test';
  process.env.PAPERLESS_API_TOKEN = 'token-only';
  process.env.PAPERLESS_USERNAME = MARKER;

  try {
    await censusTests();
    await tokenTests();
    await pageTests();
    // The page tests and the token tests set the name; the wizard renders
    // the configuration it finds, and here that has none.
    delete process.env.PAPERLESS_USERNAME;
    await wizardRouteTests();
    await wizardScriptTests();
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
