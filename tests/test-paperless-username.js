'use strict';

/**
 * Test: Paperless-ngx with the API token alone; PAPERLESS_USERNAME is gone
 *
 * Zettelrobbe signs in to Paperless-ngx with the API token alone
 * (`Authorization: Token …`). The user name came over from
 * clusterzx/paperless-ai with the first commit of this repository (da558c1):
 * getOwnUserID() matched it against /api/users/, and three guards refused to
 * scan when that failed: at startup, behind "Scan now" and in the manual
 * queue. The ID they resolved was handed to processDocument(), which never
 * read it; whether a document may be changed was already decided by
 * Paperless-ngx's own user_can_change. 3dfc880 (#272) removed the startup
 * guard, 4fa54be (#305) the other two, and from then on nothing called
 * getOwnUserID(). 8a65943 made the field optional; now the setting is gone,
 * with getOwnUserID() and getOwnerOfDocument(), which had no caller either.
 * An installation that still has the key is covered by
 * tests/test-removed-settings.js.
 *
 * Covers:
 *  1. The setting does not exist: no catalogue entry, no config getter, and
 *     no server file, page script or view reads the key or the form field
 *     (two API descriptions say that an old field is ignored)
 *  2. getOwnUserID() and getOwnerOfDocument() are gone, and the processing
 *     path resolves no user ID
 *  3. The Paperless-ngx client signs in with the token alone: no name in a
 *     header, no basic auth, also while an old installation still has
 *     PAPERLESS_USERNAME set
 *  4. The connection probe behind Quick start and the scan asks with the
 *     token alone
 *  5. Writing a document and creating a tag, a correspondent and a document
 *     type send no owner, no permissions and not the name
 *  6. The settings page and Quick start have no user name field; the
 *     Paperless-ngx row shows the address and the connection state only, and
 *     the probe's word depends on address and token alone
 *  7. The setup wizard: no field, no line in the .env preview, nothing in its
 *     payload; POST /api/setup/complete accepts an old body that still
 *     carries paperlessUsername, saves no name, and still refuses a missing
 *     token
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

/** Every file below `dir` that ends in `extension`, repository-relative. */
function filesBelow(dir, extension) {
  const files = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, relative), {
      withFileTypes: true,
    })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(extension)) files.push(child);
    }
  };
  walk(dir);
  return files.map((file) => file.split(path.sep).join('/'));
}

/** Every .js file of the server side: what runs in a running installation. */
function serverFiles() {
  return [
    'server.js',
    ...['routes', 'services', 'middleware', 'models', 'config'].flatMap((dir) =>
      filesBelow(dir, '.js')
    ),
  ];
}

/** The scripts the browser loads. */
const clientFiles = () => filesBelow('public/js', '.js');

/** The page templates. */
const viewFiles = () => filesBelow('views', '.ejs');

/** True for a line that is a comment or part of a JSDoc block. */
const isCommentLine = (line) => /^\s*(\/\/|\/?\*)/.test(line);

/* ── 1–2. The setting does not exist ────────────────────────────────────── */

const NAME_PATTERN = /PAPERLESS_USERNAME|paperlessUsername/;

/**
 * Files that may still name the form field, in a comment only: the API
 * descriptions of POST /settings and POST /api/setup/complete say that an
 * older client's field is accepted and ignored.
 */
const MENTIONED_IN_COMMENTS = ['routes/settings.js', 'routes/setupWizard.js'];

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
  'services/paperlessService.js',
  'config/config.js',
];

async function censusTests() {
  const files = serverFiles();

  await test('No catalogue entry and no config getter for PAPERLESS_USERNAME', () => {
    const catalog = require('../services/settingsCatalog');
    assert.strictEqual(catalog.getEntry('PAPERLESS_USERNAME'), undefined);
    assert.ok(!NAME_PATTERN.test(read('config/config.js')));
  });

  await test('No server file, page script or view reads the name', () => {
    const readers = [...files, ...clientFiles(), ...viewFiles()].filter(
      (file) => NAME_PATTERN.test(read(file))
    );
    const unexpected = readers.filter(
      (file) => !MENTIONED_IN_COMMENTS.includes(file)
    );
    assert.deepStrictEqual(unexpected, [], 'files that read the name');
    for (const file of MENTIONED_IN_COMMENTS) {
      const code = read(file)
        .split('\n')
        .filter((line) => NAME_PATTERN.test(line) && !isCommentLine(line));
      assert.deepStrictEqual(code, [], `${file} reads the name in code`);
    }
  });

  await test('getOwnUserID() and getOwnerOfDocument() are gone', () => {
    const paperlessService = require('../services/paperlessService');
    assert.strictEqual(paperlessService.getOwnUserID, undefined);
    assert.strictEqual(paperlessService.getOwnerOfDocument, undefined);
    const mentions = [...files, ...clientFiles()].filter((file) =>
      /getOwnUserID|getOwnerOfDocument/.test(read(file))
    );
    assert.deepStrictEqual(mentions, []);
  });

  await test('No file of the processing path reads the name or an own user ID', () => {
    for (const file of PROCESSING_PATH) {
      const source = read(file);
      assert.ok(!NAME_PATTERN.test(source), `${file} reads the name`);
      assert.ok(!/ownUserId/i.test(source), `${file} resolves an own user ID`);
    }
  });
}

/* ── 3–5. The token alone ────────────────────────────────────────────────── */

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
        status: 200,
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
    assert.strictEqual(process.env.PAPERLESS_USERNAME, MARKER, 'a stale key');
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

  await test('The connection probe asks with the token alone', async () => {
    const client = recordingClient();
    paperlessService.client = client;
    const result = await paperlessService.checkConnection();
    assert.deepStrictEqual(
      { reachable: result.reachable, authorized: result.authorized },
      { reachable: true, authorized: true }
    );
    assert.deepStrictEqual(
      client.calls.map((call) => `${call.method} ${call.url}`),
      ['get /users/']
    );
    assert.ok(!JSON.stringify(client.calls).includes(MARKER));
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

/* ── 6. The settings page and Quick start ────────────────────────────────── */

async function pageTests() {
  const { renderSettingsPage } = require('./helpers/render-settings');
  const html = await renderSettingsPage();

  await test('Settings page and Quick start: no user name field', () => {
    assert.ok(!NAME_PATTERN.test(html), 'the page names the field');
    assert.ok(!/User name/.test(html), 'a user name label');
    assert.ok(html.includes('id="paperlessToken"'), 'the token field stays');
    assert.ok(html.includes('data-mirror="paperlessToken"'), 'and its mirror');
  });

  const qs = await import(
    path.join(REPO_ROOT, 'public', 'js', 'modules', 'settings-quick-start.js')
  );

  await test('Quick start: the Paperless-ngx row is the address and the connection state', () => {
    const base = { url: 'http://paperless:8000', tokenPresent: true };
    assert.deepStrictEqual(qs.summarizePaperless(base), {
      state: 'done',
      text: 'http://paperless:8000',
    });
    assert.deepStrictEqual(
      qs.summarizePaperless({ ...base, connection: 'ok' }),
      { state: 'done', text: 'http://paperless:8000 · connected' }
    );
    // An old caller that still hands in a name changes nothing.
    assert.deepStrictEqual(
      qs.summarizePaperless({ ...base, username: 'admin', connection: 'ok' }),
      { state: 'done', text: 'http://paperless:8000 · connected' }
    );
  });

  await test('Quick start: the probe depends on address and token alone', () => {
    const source = read('public/js/modules/settings-quick-start.js');
    const at = source.indexOf('const connectionFields = [');
    const block = source.slice(at, source.indexOf('];', at));
    assert.ok(block.includes("'paperlessUrl'"));
    assert.ok(block.includes("'paperlessToken'"));
    assert.strictEqual(block.match(/'/g).length, 4, 'two fields, no third');
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
  return { wizard: window.setupWizard, dialogs, elements };
}

/** The body of a wizard that finished every step. */
const SETUP_BODY = {
  adminUsername: 'admin',
  adminPassword: 'long-enough-password',
  paperlessUrl: 'http://paperless.test',
  paperlessToken: 'paperless-token',
  scanAllDocuments: true,
  aiProvider: 'openai',
  aiApiUrl: 'https://api.openai.com/v1',
  aiToken: 'sk-test',
  aiModel: 'gpt-4o-mini',
  mistralOcrEnabled: false,
  paperlessTestPassed: true,
  aiTestPassed: true,
};

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

  const complete = (body) =>
    fetch(harness.base + '/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    await test('Wizard page: no user name field', async () => {
      const html = await (await fetch(harness.base + '/setup')).text();
      assert.ok(html.includes('id="paperlessToken"'), 'the page rendered');
      assert.ok(!NAME_PATTERN.test(html), 'the page names the field');
      assert.ok(!/Paperless username/.test(html));
    });

    await test('POST /api/setup/complete ignores a user name an old client still sends', async () => {
      const response = await complete({
        ...SETUP_BODY,
        paperlessUsername: 'archivist',
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200, JSON.stringify(body));
      const saved = savedConfigs[savedConfigs.length - 1];
      assert.ok(!('PAPERLESS_USERNAME' in saved), 'a name was saved');
      assert.ok(!JSON.stringify(saved).includes('archivist'));
      assert.strictEqual(saved.PAPERLESS_API_TOKEN, 'paperless-token');
      assert.ok(!NAME_PATTERN.test(body.envPreview), body.envPreview);
    });

    await test('POST /api/setup/complete still refuses a missing token', async () => {
      const response = await complete({ ...SETUP_BODY, paperlessToken: '' });
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
    const { wizard, dialogs, elements } = loadWizard();

    await test('Wizard script: address and token are enough to leave the Paperless-ngx step', async () => {
      wizard.paperlessUrl.value = 'http://paperless:8000';
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

    await test('Wizard script: no user name in the .env preview or the payload', () => {
      assert.ok(!('paperlessUsername' in wizard), 'the wizard holds a field');
      assert.ok(!elements.has('paperlessUsername'), 'the wizard looks it up');
      const preview = wizard.buildEnvPreview();
      assert.match(preview, /PAPERLESS_API_TOKEN=token/);
      assert.ok(!NAME_PATTERN.test(preview), preview);
      const payload = JSON.stringify(wizard.buildFinalizePayload());
      assert.ok(!NAME_PATTERN.test(payload), payload);
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
  // An older installation may still have the key set.
  process.env.PAPERLESS_USERNAME = MARKER;

  try {
    await censusTests();
    await tokenTests();
    await pageTests();
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
