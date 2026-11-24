/**
 * Test: the Manual page's unlock check never loads over another document
 *
 * While Paperless-ngx stores the unlocked version of a PDF, public/js/manual.js
 * asks every ten seconds whether it is there and loads the document anew once
 * it is. The check only asked whether the page still showed that document
 * (state.doc), not whether another one was loading (state.fetching). Picking
 * document B while A was waiting let the check load A again; B's answer then
 * arrived as an older load and was dropped, and the page showed A.
 *
 * The script runs in a vm context with a small stand-in for the page: every
 * element is a plain object that keeps what the script writes, fetch answers
 * from a table, and the timers fire only when the test says so.
 *
 * Covers:
 * 1. The check loads A once Paperless-ngx has stored its unlocked version
 * 2. B is loading when the check fires: A is not asked for, B is shown
 * 3. B starts loading while the check waits for its answer: A is not loaded,
 *    B is shown
 * 4. B cannot be loaded: A stays and its check goes on
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'manual.js'),
  'utf8'
);
const UNLOCK_CHECK_MS = 10000;

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

/** An element: keeps what the script writes, finds nothing below itself. */
function makeElement() {
  const classes = new Set();
  const attributes = new Map();
  const element = {
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    title: '',
    href: '',
    dataset: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) =>
      attributes.has(name) ? attributes.get(name) : null,
    removeAttribute: (name) => attributes.delete(name),
    addEventListener: () => {},
    appendChild: (child) => child,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus: () => {},
    remove: () => {},
  };
  return element;
}

/** A promise the test resolves or rejects itself. */
function gate() {
  let open;
  let fail;
  const promise = new Promise((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const LOCKED_A = {
  id: 1,
  title: 'Payslip A',
  locked: true,
  unlocking: true,
  content: '',
};
const UNLOCKED_A = {
  id: 1,
  title: 'Payslip A',
  locked: false,
  unlocking: false,
  content: 'Net pay',
  mimeType: 'text/plain',
};
const DOC_B = {
  id: 2,
  title: 'Invoice B',
  locked: false,
  content: 'Total',
  mimeType: 'text/plain',
};

/**
 * Loads the page script with document 1 in the address, as a link from the
 * OCR page would, and runs its start.
 *
 * @param {(url: string, count: number) => unknown} answer - the body for a
 *   request, or a promise of it; `count` counts the requests for that URL
 */
async function openPage(answer) {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  $('manualPage').dataset.ocrEnabled = 'yes';

  const requests = [];
  const counts = new Map();
  const timers = new Map();
  let nextTimer = 1;
  const started = [];
  let omnibox = null;

  const context = {
    document: {
      getElementById: $,
      createElement: makeElement,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (type, handler) => {
        if (type === 'DOMContentLoaded') started.push(handler);
      },
    },
    location: { search: '?id=1' },
    history: { replaceState: () => {} },
    CSS: { escape: (value) => value },
    URLSearchParams,
    console,
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url) => {
      requests.push(url);
      const count = (counts.get(url) || 0) + 1;
      counts.set(url, count);
      const body = await answer(url, count);
      return { ok: true, status: 200, json: async () => body };
    },
    __zrToast: () => {},
    zrDate: { format: () => 'today' },
    createDocumentOmnibox: (options) => {
      omnibox = options;
    },
  };
  context.window = context;
  vm.runInNewContext(SCRIPT, context, { filename: 'manual.js' });
  await Promise.all(started.map((handler) => handler()));
  await flush();

  return {
    $,
    requests,
    /** Picks a document in the search, as a person does. */
    pick: (id) => omnibox.onSelect({ id }),
    /** Fires the unlock check that is due, and waits for what it starts. */
    async fireUnlockCheck() {
      const due = [...timers.entries()].filter(
        ([, timer]) => timer.ms === UNLOCK_CHECK_MS
      );
      assert.strictEqual(due.length, 1, 'one unlock check is set');
      const [id, timer] = due[0];
      timers.delete(id);
      const run = timer.fn();
      await flush();
      return run;
    },
    unlockCheckSet: () =>
      [...timers.values()].some((timer) => timer.ms === UNLOCK_CHECK_MS),
    shown: () => $('docIdLabel').textContent,
    previews: (id) =>
      requests.filter((url) => url === `/manual/preview/${id}`).length,
  };
}

/** The other lookups the page makes at start. */
function lookups(url) {
  if (url === '/api/ocr/unlock/status') return { data: { supported: true } };
  if (url === '/manual/tags') return [];
  if (url === '/manual/vocabulary') return { data: {} };
  return undefined;
}

(async () => {
  await test('the check loads A once its unlocked version is stored', async () => {
    const page = await openPage(
      (url, count) =>
        lookups(url) ??
        (url === '/manual/preview/1'
          ? count === 1
            ? LOCKED_A
            : UNLOCKED_A
          : null)
    );
    assert.strictEqual(page.shown(), '#1');
    assert.ok(page.unlockCheckSet(), 'A waits for its unlocked version');

    await page.fireUnlockCheck();
    await flush();
    // One look by the check, one load of the unlocked document.
    assert.strictEqual(page.previews(1), 3);
    assert.strictEqual(page.$('fieldTitle').value, 'Payslip A');
    assert.strictEqual(
      page.$('unlockBox').classList.contains('hidden'),
      true,
      'the unlock box is gone'
    );
    assert.strictEqual(page.unlockCheckSet(), false);
  });

  await test('B is loading when the check fires: A is not asked for, B is shown', async () => {
    const b = gate();
    const page = await openPage(
      (url, count) =>
        lookups(url) ??
        (url === '/manual/preview/1'
          ? count === 1
            ? LOCKED_A
            : UNLOCKED_A
          : url === '/manual/preview/2'
            ? b.promise
            : null)
    );
    const loadingB = page.pick(2);
    await flush();
    await page.fireUnlockCheck();
    assert.strictEqual(page.previews(1), 1, 'the check did not ask for A');

    b.open(DOC_B);
    await loadingB;
    await flush();
    assert.strictEqual(page.shown(), '#2');
    assert.strictEqual(page.$('fieldTitle').value, 'Invoice B');
    assert.strictEqual(page.unlockCheckSet(), false, 'B needs no check');
  });

  await test('B starts loading while the check waits for its answer: A is not loaded, B is shown', async () => {
    const look = gate();
    const b = gate();
    const page = await openPage(
      (url, count) =>
        lookups(url) ??
        (url === '/manual/preview/1'
          ? count === 1
            ? LOCKED_A
            : count === 2
              ? look.promise
              : UNLOCKED_A
          : url === '/manual/preview/2'
            ? b.promise
            : null)
    );
    const check = page.fireUnlockCheck();
    const loadingB = page.pick(2);
    // The look answers while B is still on its way.
    look.open(UNLOCKED_A);
    await check;
    await flush();
    b.open(DOC_B);
    await loadingB;
    await flush();
    assert.strictEqual(page.previews(1), 2, 'the look, and no load of A');
    assert.strictEqual(page.shown(), '#2');
    assert.strictEqual(page.$('fieldTitle').value, 'Invoice B');
  });

  await test('B cannot be loaded: A stays and its check goes on', async () => {
    const b = gate();
    const page = await openPage(
      (url, count) =>
        lookups(url) ??
        (url === '/manual/preview/1'
          ? count === 1
            ? LOCKED_A
            : UNLOCKED_A
          : url === '/manual/preview/2'
            ? b.promise
            : null)
    );
    const loadingB = page.pick(2);
    await flush();
    await page.fireUnlockCheck();
    b.fail(new Error('Paperless-ngx is away'));
    await loadingB;
    await flush();
    assert.strictEqual(page.shown(), '#1');
    assert.ok(page.unlockCheckSet(), 'A is checked again');

    await page.fireUnlockCheck();
    await flush();
    assert.strictEqual(page.$('fieldTitle').value, 'Payslip A');
    assert.strictEqual(page.$('unlockBox').classList.contains('hidden'), true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
