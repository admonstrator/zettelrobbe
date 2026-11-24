'use strict';

/**
 * Lists of values as removable pills: public/js/chip-list.js, the one
 * implementation the settings page, the setup wizard and Tidy up share.
 *
 * The script runs here as the browser runs it (a classic script that sets
 * window.zrChipList) against tests/helpers/mini-dom.js. Pinned:
 *
 *   - Enter, a comma and the Add button turn the typed text into a pill; Enter
 *     never reaches the form.
 *   - Pasting "a, b, c" or several lines makes three pills; a single value is
 *     left to the browser.
 *   - A value already on the list, in any case, is not added twice; its pill
 *     is highlighted instead.
 *   - Backspace in the empty field removes the last pill, but not while the
 *     key repeats and not while text is in the field.
 *   - Every pill has a remove button named "Remove <value>"; removing moves
 *     the focus to the next pill.
 *   - A locked list (data-locked, set for a value the environment pins)
 *     neither adds nor removes, and renders its buttons disabled.
 *   - Text left in the field is committed by commit() and commitAll().
 *   - The hidden input carries the comma-joined (or space-joined) value and
 *     announces each change with input and change events; a change made to it
 *     from outside redraws the pills.
 *   - A value is text: markup in it stays text.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDocument } = require('./helpers/mini-dom');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'chip-list.js'),
  'utf8'
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed++;
  }
}

/** A page with the script loaded and timers that run on demand. */
function page() {
  const dom = createDocument();
  const timers = [];
  vm.runInNewContext(SOURCE, {
    window: dom.window,
    document: dom.document,
    Event: dom.Event,
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => {},
  });
  return {
    ...dom,
    api: dom.window.zrChipList,
    runTimers: () => timers.splice(0).forEach((fn) => fn()),
  };
}

/**
 * The markup views/partials/chip-list.ejs renders for a settings field, in a
 * form: a text field, an Add button, the list and the hidden input.
 */
function field(p, { values = '', separator, locked = false } = {}) {
  const { el, document } = p;
  const input = el('input', {
    id: 'tagInput',
    type: 'text',
    class: 'zr-input',
  });
  const add = el('button', { id: 'tagAddButton', type: 'button' });
  const list = el('div', {
    id: 'tagsContainer',
    class: 'zr-chips',
    'data-chip-list': true,
    'data-chip-input': 'tagInput',
    'data-chip-add': 'tagAddButton',
    'data-chip-value': 'tags',
    'data-chip-separator': separator,
    'data-locked': locked ? 'true' : undefined,
  });
  const hidden = el('input', {
    id: 'tags',
    type: 'hidden',
    name: 'tags',
    value: values,
  });
  const form = el('form', { id: 'setupForm' }, [
    el('div', { class: 'zr-field' }, [
      el('div', { class: 'zr-inputgroup' }, [input, add]),
      list,
      hidden,
    ]),
  ]);
  document.body.appendChild(form);
  const events = [];
  hidden.addEventListener('input', () => events.push('input'));
  hidden.addEventListener('change', () => events.push('change'));
  return { form, input, add, list, hidden, events };
}

// Arrays made inside the script's context have that context's prototype;
// assert.deepStrictEqual compares prototypes, so they are copied out first.
const plain = (value) => JSON.parse(JSON.stringify(value));

const pillTexts = (list) =>
  list
    .querySelectorAll('.zr-chip')
    .map((pill) => pill.firstElementChild.textContent);

function type(p, input, text) {
  input.value = text;
  input.dispatchEvent(p.event('input'));
}

function key(p, input, name, extra = {}) {
  const event = p.event('keydown', { key: name, ...extra });
  input.dispatchEvent(event);
  return event;
}

function paste(p, input, text) {
  const event = p.event('paste', {
    clipboardData: { getData: () => text },
  });
  input.dispatchEvent(event);
  return event;
}

test('split: commas, line breaks and tabs end a value; spaces only in a space list', () => {
  const { api } = page();
  const split = (...args) => plain(api.split(...args));
  assert.deepStrictEqual(split(' a, b ,,c\nd\r\ne\tf '), [
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
  ]);
  assert.deepStrictEqual(split('Tax 2024, Scan'), ['Tax 2024', 'Scan']);
  assert.deepStrictEqual(split('openid  profile,email\n', ' '), [
    'openid',
    'profile',
    'email',
  ]);
  assert.deepStrictEqual(split(''), []);
  assert.deepStrictEqual(split(null), []);
});

test('attach renders the stored value as pills with named remove buttons', () => {
  const p = page();
  const f = field(p, { values: 'invoice, household' });
  p.api.attachAll(f.form);
  assert.deepStrictEqual(pillTexts(f.list), ['invoice', 'household']);
  const buttons = f.list.querySelectorAll('.zr-chip button');
  assert.deepStrictEqual(
    buttons.map((b) => b.getAttribute('aria-label')),
    ['Remove invoice', 'Remove household']
  );
  assert.ok(
    buttons.every((b) => b.type === 'button'),
    'never a submit button'
  );
  assert.strictEqual(f.list.getAttribute('role'), 'list');
  assert.strictEqual(
    f.hidden.value,
    'invoice, household',
    'attaching does not rewrite the stored value'
  );
  assert.deepStrictEqual(f.events, [], 'attaching is not a change');
  assert.strictEqual(
    p.api.attach(f.list),
    p.api.attach(f.list),
    'attaching twice returns the same list'
  );
});

test('Enter commits the typed value and does not submit the form', () => {
  const p = page();
  const f = field(p, { values: 'alpha' });
  p.api.attachAll(f.form);
  f.input.value = '  beta ';
  const event = key(p, f.input, 'Enter');
  assert.ok(event.defaultPrevented, 'Enter is kept from the form');
  assert.deepStrictEqual(pillTexts(f.list), ['alpha', 'beta']);
  assert.strictEqual(f.hidden.value, 'alpha,beta');
  assert.strictEqual(f.input.value, '');
  assert.deepStrictEqual(
    f.events,
    ['input', 'change'],
    'the unsaved-change tracking hears it'
  );
  const empty = key(p, f.input, 'Enter');
  assert.ok(
    empty.defaultPrevented,
    'Enter in the empty field does not save either'
  );
  assert.strictEqual(f.hidden.value, 'alpha,beta');
  const composing = key(p, f.input, 'Enter', { isComposing: true });
  assert.ok(
    !composing.defaultPrevented,
    'Enter that ends an IME composition is left alone'
  );
});

test('a typed comma ends the value; the text after it stays in the field', () => {
  const p = page();
  const f = field(p);
  p.api.attachAll(f.form);
  type(p, f.input, 'invoice,');
  assert.deepStrictEqual(pillTexts(f.list), ['invoice']);
  assert.strictEqual(f.input.value, '');
  type(p, f.input, 'tax, 20');
  assert.deepStrictEqual(pillTexts(f.list), ['invoice', 'tax']);
  assert.strictEqual(f.input.value, '20');
  assert.strictEqual(f.hidden.value, 'invoice,tax');
  type(p, f.input, ',');
  assert.deepStrictEqual(
    pillTexts(f.list),
    ['invoice', 'tax'],
    'a lone comma adds nothing'
  );
});

test('the Add button commits and returns the focus to the field', () => {
  const p = page();
  const f = field(p);
  p.api.attachAll(f.form);
  f.input.value = 'gamma';
  f.add.click();
  assert.deepStrictEqual(pillTexts(f.list), ['gamma']);
  assert.strictEqual(p.document.activeElement, f.input);
});

test('pasting a list makes one pill per value; a single value is pasted as usual', () => {
  const p = page();
  const f = field(p);
  p.api.attachAll(f.form);
  const many = paste(p, f.input, 'a, b\nc\r\n');
  assert.ok(many.defaultPrevented);
  assert.deepStrictEqual(pillTexts(f.list), ['a', 'b', 'c']);
  assert.strictEqual(f.hidden.value, 'a,b,c');
  const one = paste(p, f.input, 'Tax 2024');
  assert.ok(!one.defaultPrevented, 'the browser inserts a single value');
  assert.deepStrictEqual(pillTexts(f.list), ['a', 'b', 'c']);

  // Pasted into text already typed: the text joins the first value.
  f.input.value = 'x';
  f.input.selectionStart = 1;
  f.input.selectionEnd = 1;
  paste(p, f.input, 'y,z');
  assert.deepStrictEqual(pillTexts(f.list), ['a', 'b', 'c', 'xy', 'z']);
  assert.strictEqual(f.input.value, '');
});

test('a value already on the list is not added again and its pill lights up', () => {
  const p = page();
  const f = field(p, { values: 'Invoice' });
  p.api.attachAll(f.form);
  f.input.value = 'invoice';
  key(p, f.input, 'Enter');
  assert.deepStrictEqual(pillTexts(f.list), ['Invoice']);
  assert.strictEqual(f.hidden.value, 'Invoice');
  assert.deepStrictEqual(f.events, [], 'nothing changed');
  assert.strictEqual(f.input.value, '', 'the field is emptied all the same');
  const pill = f.list.querySelector('.zr-chip');
  assert.ok(
    pill.hasAttribute('data-flash'),
    'the existing pill is highlighted'
  );
  p.runTimers();
  assert.ok(!pill.hasAttribute('data-flash'), 'only for a moment');
  paste(p, f.input, 'new, NEW, invoice');
  assert.deepStrictEqual(
    pillTexts(f.list),
    ['Invoice', 'new'],
    'repeats inside one paste count once'
  );
});

test('Backspace in the empty field removes the last pill', () => {
  const p = page();
  const f = field(p, { values: 'a,b,c' });
  p.api.attachAll(f.form);
  f.input.value = 'x';
  key(p, f.input, 'Backspace');
  assert.deepStrictEqual(
    pillTexts(f.list),
    ['a', 'b', 'c'],
    'not while text is in the field'
  );
  f.input.value = '';
  key(p, f.input, 'Backspace', { repeat: true });
  assert.deepStrictEqual(
    pillTexts(f.list),
    ['a', 'b', 'c'],
    'not from a held key'
  );
  const event = key(p, f.input, 'Backspace');
  assert.ok(event.defaultPrevented);
  assert.deepStrictEqual(pillTexts(f.list), ['a', 'b']);
  assert.strictEqual(f.hidden.value, 'a,b');
});

test('a remove button removes its pill and hands the focus on', () => {
  const p = page();
  const f = field(p, { values: 'a,b,c' });
  p.api.attachAll(f.form);
  f.list.querySelectorAll('.zr-chip button')[1].click();
  assert.deepStrictEqual(pillTexts(f.list), ['a', 'c']);
  assert.strictEqual(f.hidden.value, 'a,c');
  assert.strictEqual(
    p.document.activeElement.getAttribute('aria-label'),
    'Remove c',
    'the pill that took its place'
  );
  f.list.querySelectorAll('.zr-chip button')[1].click();
  assert.strictEqual(
    p.document.activeElement.getAttribute('aria-label'),
    'Remove a'
  );
  f.list.querySelectorAll('.zr-chip button')[0].click();
  assert.strictEqual(
    p.document.activeElement,
    f.input,
    'the field, once the list is empty'
  );
  assert.strictEqual(f.hidden.value, '');
});

test('a locked list neither adds nor removes', () => {
  const p = page();
  const f = field(p, { values: 'pinned-one,pinned-two', locked: true });
  p.api.attachAll(f.form);
  assert.ok(
    f.list.querySelectorAll('.zr-chip button').every((b) => b.disabled),
    'the remove buttons are rendered disabled'
  );
  f.input.value = 'sneaked-in';
  key(p, f.input, 'Enter');
  f.add.click();
  type(p, f.input, 'sneaked,');
  paste(p, f.input, 'x, y');
  f.input.value = '';
  key(p, f.input, 'Backspace');
  f.list.querySelectorAll('.zr-chip button').forEach((b) => {
    b.disabled = false; // even a button someone re-enabled does nothing
    b.click();
  });
  p.api.commitAll(f.form);
  assert.deepStrictEqual(pillTexts(f.list), ['pinned-one', 'pinned-two']);
  assert.strictEqual(f.hidden.value, 'pinned-one,pinned-two');
  assert.deepStrictEqual(f.events, []);
});

test('a list locked after attaching (the environment lock) stops at once', () => {
  const p = page();
  const f = field(p, { values: 'a' });
  p.api.attachAll(f.form);
  f.list.dataset.locked = 'true';
  f.input.value = 'b';
  key(p, f.input, 'Enter');
  f.list.querySelector('.zr-chip button').click();
  assert.deepStrictEqual(pillTexts(f.list), ['a']);
});

test('text left in the field is committed before a save', () => {
  const p = page();
  const f = field(p, { values: 'a' });
  p.api.attachAll(f.form);
  f.input.value = 'typed-not-added';
  p.api.commitAll(f.form);
  assert.strictEqual(f.hidden.value, 'a,typed-not-added');
  assert.strictEqual(f.input.value, '');
  p.api.commitAll(f.form);
  assert.strictEqual(
    f.hidden.value,
    'a,typed-not-added',
    'committing an empty field changes nothing'
  );
});

test('a value set on the hidden input from outside redraws the pills', () => {
  const p = page();
  const f = field(p, { values: 'a,b' });
  p.api.attachAll(f.form);
  f.input.value = 'c';
  key(p, f.input, 'Enter');
  // "Discard changes" puts the value it started with back and fires change.
  f.hidden.value = 'a,b';
  f.hidden.dispatchEvent(p.event('change'));
  assert.deepStrictEqual(pillTexts(f.list), ['a', 'b']);
});

test('a space-separated list (single sign-on scopes) joins with a space', () => {
  const p = page();
  const f = field(p, { values: 'openid profile email', separator: ' ' });
  p.api.attachAll(f.form);
  assert.deepStrictEqual(pillTexts(f.list), ['openid', 'profile', 'email']);
  type(p, f.input, 'groups ');
  assert.deepStrictEqual(pillTexts(f.list), [
    'openid',
    'profile',
    'email',
    'groups',
  ]);
  assert.strictEqual(f.hidden.value, 'openid profile email groups');
  type(p, f.input, 'offline_access,');
  assert.strictEqual(
    f.hidden.value,
    'openid profile email groups offline_access'
  );
});

test('markup in a value stays text', () => {
  const p = page();
  const f = field(p);
  p.api.attachAll(f.form);
  f.input.value = '<b>bold</b> & "quoted"';
  key(p, f.input, 'Enter');
  const pill = f.list.querySelector('.zr-chip');
  assert.strictEqual(
    pill.firstElementChild.textContent,
    '<b>bold</b> & "quoted"'
  );
  assert.strictEqual(
    pill.firstElementChild.children.length,
    0,
    'no element was parsed from it'
  );
  assert.strictEqual(
    pill.querySelector('button').getAttribute('aria-label'),
    'Remove <b>bold</b> & "quoted"'
  );
  assert.strictEqual(f.hidden.value, '<b>bold</b> & "quoted"');
});

test('without a hidden input the list reports to onChange (the wizard, Tidy up)', () => {
  const p = page();
  const { el, document } = p;
  const input = el('input', { type: 'text' });
  const list = el('div', { class: 'zr-chips' });
  document.body.appendChild(el('div', {}, [input, list]));
  const seen = [];
  const controller = p.api.attach(list, {
    input,
    values: ['inbox', ' ', 'todo '],
    onChange: (values) => seen.push(plain(values)),
  });
  assert.deepStrictEqual(plain(controller.values()), ['inbox', 'todo']);
  assert.ok(list.hasAttribute('data-chip-list'), 'commitAll finds it');
  input.value = 'later';
  p.api.commitAll(document.body);
  assert.deepStrictEqual(seen, [['inbox', 'todo', 'later']]);
  controller.remove('INBOX');
  assert.deepStrictEqual(seen[1], ['todo', 'later']);
  controller.add('a, b');
  assert.deepStrictEqual(plain(controller.values()), [
    'todo',
    'later',
    'a',
    'b',
  ]);
});

test('a disabled field (the wizard while "scan all" is on) adds nothing', () => {
  const p = page();
  const f = field(p);
  p.api.attachAll(f.form);
  f.input.disabled = true;
  f.input.value = 'x';
  key(p, f.input, 'Enter');
  assert.deepStrictEqual(pillTexts(f.list), []);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
