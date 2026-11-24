/**
 * Test: "Copy" next to the SSO redirect URI (settings-sso.js)
 *
 * The Redirect URI field is an override (OIDC_REDIRECT_URI): left empty, the
 * server derives the address from the request, so it follows the address
 * people open. Copy must never write into it. Run as shipped, on a stub DOM:
 * 1. With the Clipboard API, the address is written to the clipboard.
 * 2. Without it (plain http), a temporary textarea outside the form and
 *    execCommand('copy') copy it; the focus goes back to the button.
 * 3. When that fails too, the address is shown under the field and
 *    selected, to be copied by hand.
 * In every case the field keeps its value and gets no input or change event,
 * so nothing counts as an unsaved change. A typed override is what is copied.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

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

const DETECTED = 'http://zettelrobbe.lan:3000/auth/oidc/callback';

/* --- a stub DOM, as small as the copy needs ------------------------------- */

class StubElement extends EventTarget {
  constructor(page, tag, classes = []) {
    super();
    this.page = page;
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.parent = null;
    this.children = [];
    const set = new Set(classes);
    this.classList = {
      add: (name) => set.add(name),
      remove: (name) => set.delete(name),
      contains: (name) => set.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !set.has(name) : force;
        if (on) set.add(name);
        else set.delete(name);
        return on;
      },
    };
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  focus() {
    this.page.document.activeElement = this;
  }

  select() {
    this.focus();
    this.page.selectedText = this.value;
  }

  querySelector() {
    return null;
  }
}

/**
 * The SSO section as far as Copy reaches: the field, the button and the line
 * under the field. `clipboard` is what navigator.clipboard is; `copies` what
 * execCommand('copy') answers.
 */
function page({ clipboard, copies, typed = '' }) {
  const state = {
    toasts: [],
    clipboardText: null,
    execCopies: [],
    selectedText: null,
    selection: null,
    fieldEvents: [],
    textareasLeft: null,
  };
  const make = (tag, classes) => new StubElement(state, tag, classes);
  const body = make('body');
  const form = body.appendChild(make('form'));
  const field = form.appendChild(make('input'));
  field.id = 'oidcRedirectUri';
  field.value = typed;
  field.dataset.detected = DETECTED;
  ['input', 'change'].forEach((type) =>
    field.addEventListener(type, () => state.fieldEvents.push(type))
  );
  const root = form.appendChild(make('div'));
  const button = root.appendChild(make('button'));
  const byHand = root.appendChild(make('p', ['zr-field__hint', 'hidden']));
  const byHandText = byHand.appendChild(make('code'));
  const bySelector = {
    '[data-el="copy-redirect"]': button,
    '[data-el="copy-redirect-by-hand"]': byHand,
    '[data-el="copy-redirect-text"]': byHandText,
  };
  root.querySelector = (selector) => bySelector[selector] || null;

  state.document = {
    activeElement: null,
    body,
    createElement: (tag) => make(tag),
    getElementById: (id) => (id === field.id ? field : null),
    execCommand: (command) => {
      state.execCopies.push({ command, text: state.selectedText });
      state.textareasLeft = body.children.filter(
        (child) => child.tagName === 'TEXTAREA'
      ).length;
      if (copies === 'throws') throw new Error('not allowed');
      return copies;
    },
  };
  state.window = {
    location: { origin: 'http://zettelrobbe.lan:3000' },
    getSelection: () => ({
      selectAllChildren: (node) => {
        state.selection = node;
      },
    }),
  };
  state.navigator = {
    clipboard: clipboard
      ? {
          writeText: async (text) => {
            state.clipboardText = text;
          },
        }
      : undefined,
  };
  return { state, root, field, button, byHand, byHandText, body };
}

/** Runs the module's Copy on a page and waits for the click to settle. */
async function clickCopy(settingsSso, p) {
  const globals = ['document', 'window', 'navigator'];
  const saved = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name)
  );
  globals.forEach((name) =>
    Object.defineProperty(globalThis, name, {
      value: p.state[name],
      configurable: true,
      writable: true,
    })
  );
  try {
    settingsSso(p.root, {
      toast: (text, options) => p.state.toasts.push([text, options.tone]),
    });
    p.button.focus();
    p.button.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globals.forEach((name, index) => {
      if (saved[index]) Object.defineProperty(globalThis, name, saved[index]);
      else delete globalThis[name];
    });
  }
}

(async () => {
  const sso = await import(
    pathToFileURL(
      path.join(__dirname, '..', 'public', 'js', 'modules', 'settings-sso.js')
    ).href
  );

  await test('with the Clipboard API the address goes to the clipboard', async () => {
    const p = page({ clipboard: true, copies: false });
    await clickCopy(sso.default, p);
    assert.strictEqual(p.state.clipboardText, DETECTED);
    assert.deepStrictEqual(p.state.execCopies, []);
    assert.deepStrictEqual(p.state.toasts, [[`Copied ${DETECTED}`, 'ok']]);
    assert.strictEqual(p.field.value, '');
    assert.deepStrictEqual(p.state.fieldEvents, []);
  });

  await test('without the Clipboard API a temporary textarea copies it, the field stays empty', async () => {
    const p = page({ clipboard: false, copies: true });
    await clickCopy(sso.default, p);
    assert.deepStrictEqual(p.state.execCopies, [
      { command: 'copy', text: DETECTED },
    ]);
    assert.strictEqual(p.state.textareasLeft, 1, 'copied from the textarea');
    assert.deepStrictEqual(
      p.body.children.map((child) => child.tagName),
      ['FORM'],
      'the textarea is gone, and it never sat in the form'
    );
    assert.strictEqual(p.field.value, '', 'the override field stays empty');
    assert.deepStrictEqual(p.state.fieldEvents, [], 'nothing is unsaved');
    assert.strictEqual(p.state.document.activeElement, p.button);
    assert.ok(p.byHand.classList.contains('hidden'));
    assert.deepStrictEqual(p.state.toasts, [[`Copied ${DETECTED}`, 'ok']]);
  });

  for (const copies of [false, 'throws']) {
    await test(`when the browser cannot copy at all (${copies}) the address is shown and selected under the field`, async () => {
      const p = page({ clipboard: false, copies });
      await clickCopy(sso.default, p);
      assert.strictEqual(p.field.value, '', 'the override field stays empty');
      assert.deepStrictEqual(p.state.fieldEvents, [], 'nothing is unsaved');
      assert.ok(!p.byHand.classList.contains('hidden'), 'the line is shown');
      assert.strictEqual(p.byHandText.textContent, DETECTED);
      assert.strictEqual(p.state.selection, p.byHandText, 'and selected');
      assert.deepStrictEqual(p.state.toasts, [
        ['Copy the address shown under the field.', 'warn'],
      ]);
    });
  }

  await test('a typed override is what is copied, and it stays as typed', async () => {
    const typed = 'https://sso.example.org/auth/oidc/callback';
    const p = page({ clipboard: false, copies: true, typed });
    await clickCopy(sso.default, p);
    assert.deepStrictEqual(p.state.execCopies, [
      { command: 'copy', text: typed },
    ]);
    assert.strictEqual(p.field.value, typed);
    assert.deepStrictEqual(p.state.fieldEvents, []);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
