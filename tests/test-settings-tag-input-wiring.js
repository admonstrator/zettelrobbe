/**
 * The Tags and Ignore Tags fields on the settings page were completely inert
 * (issue #299).
 *
 * TagsManager located its add button with
 * `this.tagInput?.closest('.space-y-2')?.querySelector('button')`. `.space-y-2`
 * is a Tailwind class, and no view has carried it since the move to the zr
 * system — it appeared nowhere in the repository except that selector. So
 * closest() returned null, addTagButton stayed undefined, and the constructor's
 * guard `if (tagInput && tagsContainer && addTagButton)` skipped initialize()
 * altogether. Three symptoms, one cause:
 *
 *   - the Add button did nothing (no click handler was ever attached),
 *   - Enter fell through to the form and saved the configuration instead of
 *     adding the tag — the "Btw, pressing ENTER above starts saving" half of
 *     the original report,
 *   - server-rendered chips could not be removed.
 *
 * TagsManager is gone: every list on the page is views/partials/chip-list.ejs,
 * driven by the shared public/js/chip-list.js (tests/test-chip-list.js pins its
 * behaviour). The list names its text field, Add button and hidden input by
 * id. This test renders the Tags and Ignore Tags fields with the real partial,
 * builds the same elements in tests/helpers/mini-dom.js and runs the real
 * script on them, so it fails if the view and the script drift apart again.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');
const { createDocument } = require('./helpers/mini-dom');

const ROOT = path.join(__dirname, '..');
const SETTINGS_JS = path.join(ROOT, 'public', 'js', 'settings.js');
const CHIP_LIST_JS = path.join(ROOT, 'public', 'js', 'chip-list.js');
const SETTINGS_EJS = path.join(ROOT, 'views', 'settings.ejs');
const PARTIAL = path.join(ROOT, 'views', 'partials', 'chip-list.ejs');
const source = fs.readFileSync(SETTINGS_JS, 'utf8');
const view = fs.readFileSync(SETTINGS_EJS, 'utf8');

/** The include parameters settings.ejs passes for the list whose text field is `id`. */
function includeFor(id) {
  const match = view.match(
    new RegExp(
      `include\\('partials/chip-list', \\{\\s*id: '${id}', addId: '([^']+)', listId: '([^']+)',\\s*valueId: '([^']+)'`
    )
  );
  assert.ok(match, `views/settings.ejs renders ${id} with partials/chip-list`);
  return { id, addId: match[1], listId: match[2], valueId: match[3] };
}

/** Renders the partial and reads the wiring back out of its markup. */
async function renderedWiring(params, items) {
  const html = await ejs.renderFile(PARTIAL, { ...params, items });
  const list = html.match(/<div id="([^"]+)" class="zr-chips"[^>]*>/);
  assert.ok(list, 'the partial renders a .zr-chips list');
  const attr = (name) =>
    (list[0].match(new RegExp(`${name}="([^"]*)"`)) || [])[1];
  assert.ok(
    html.includes(`<button type="button" id="${params.addId}"`),
    'the Add button carries its id'
  );
  return {
    html,
    listId: list[1],
    input: attr('data-chip-input'),
    add: attr('data-chip-add'),
    value: attr('data-chip-value'),
  };
}

function page({ wiring, existing, withAddButton = true }) {
  const dom = createDocument();
  const { el, document } = dom;
  const input = el('input', { id: wiring.input, type: 'text' });
  const add = el('button', { id: wiring.add, type: 'button' });
  const list = el('div', {
    id: wiring.listId,
    class: 'zr-chips',
    'data-chip-list': true,
    'data-chip-input': wiring.input,
    'data-chip-add': wiring.add,
    'data-chip-value': wiring.value,
  });
  const hidden = el('input', {
    id: wiring.value,
    type: 'hidden',
    name: wiring.value,
    value: existing.join(','),
  });
  const group = el(
    'div',
    { class: 'zr-inputgroup' },
    withAddButton ? [input, add] : [input]
  );
  const form = el('form', { id: 'setupForm' }, [
    el('div', { class: 'zr-field zr-field--stacked' }, [group, list, hidden]),
  ]);
  document.body.appendChild(form);
  vm.runInNewContext(fs.readFileSync(CHIP_LIST_JS, 'utf8'), {
    window: dom.window,
    document,
    Event: dom.Event,
    setTimeout: () => {},
  });
  // What initializeChipLists() in settings.js does on DOMContentLoaded.
  dom.window.zrChipList.attachAll(form);
  const texts = () =>
    list
      .querySelectorAll('.zr-chip')
      .map((pill) => pill.firstElementChild.textContent);
  return { ...dom, input, add, list, hidden, texts };
}

async function testField(name, id) {
  const params = includeFor(id);
  const wiring = await renderedWiring(params, ['alpha']);
  assert.strictEqual(
    wiring.input,
    id,
    `${name}: the list names its text field`
  );
  assert.strictEqual(
    wiring.add,
    params.addId,
    `${name}: the list names its Add button`
  );
  assert.strictEqual(
    wiring.value,
    params.valueId,
    `${name}: the list names its hidden input`
  );
  assert.ok(
    wiring.html.includes('<span>alpha</span>'),
    `${name}: a stored tag is rendered as a chip`
  );

  const p = page({ wiring, existing: ['alpha'] });

  // The Add button commits — this is what did nothing before.
  p.input.value = 'beta';
  p.add.click();
  assert.deepStrictEqual(
    p.texts(),
    ['alpha', 'beta'],
    `${name}: the Add button must add the typed tag`
  );
  assert.strictEqual(
    p.hidden.value,
    'alpha,beta',
    `${name}: the hidden input the form posts must carry the new tag`
  );
  assert.strictEqual(p.input.value, '', `${name}: the input is cleared`);

  // Enter commits too, and must not be left to bubble into a form submit.
  p.input.value = 'gamma';
  const enter = p.event('keydown', { key: 'Enter' });
  p.input.dispatchEvent(enter);
  assert.deepStrictEqual(
    p.texts(),
    ['alpha', 'beta', 'gamma'],
    `${name}: Enter must add the tag`
  );
  assert.ok(
    enter.defaultPrevented,
    `${name}: Enter must be prevented from submitting the settings form`
  );

  // A server-rendered chip must be removable.
  p.list.querySelectorAll('.zr-chip button')[0].click();
  assert.deepStrictEqual(
    p.texts(),
    ['beta', 'gamma'],
    `${name}: a server-rendered chip must be removable`
  );
  assert.strictEqual(
    p.hidden.value,
    'beta,gamma',
    `${name}: removing a chip must update the posted value`
  );

  // A comma cannot reach the comma-joined value inside one tag: it ends one.
  p.input.value = 'a,b';
  p.add.click();
  assert.strictEqual(
    p.hidden.value,
    'beta,gamma,a,b',
    `${name}: a comma separates two tags`
  );
}

async function testEnterSurvivesAMissingButton() {
  // The button is the part that may legitimately be absent; losing it must not
  // take Enter and chip removal down with it, which is exactly what the old
  // three-way guard did.
  const wiring = await renderedWiring(includeFor('tagInput'), []);
  const p = page({ wiring, existing: [], withAddButton: false });
  p.input.value = 'delta';
  p.input.dispatchEvent(p.event('keydown', { key: 'Enter' }));
  assert.strictEqual(
    p.hidden.value,
    'delta',
    'Enter must keep working even when the add button is missing'
  );
  p.list.querySelector('.zr-chip button').click();
  assert.strictEqual(p.hidden.value, '', 'and so must removing a chip');
}

// ── The wiring the view and the script have to agree on ──────────────────────

function testWiringContract() {
  assert.ok(
    !/closest\(\s*['"]\.space-y-2['"]\s*\)/.test(source),
    'public/js/settings.js must not look up ancestors by .space-y-2 — that Tailwind class is gone from every view, so the lookup silently returns null'
  );

  assert.match(
    source,
    /window\.zrChipList\.attachAll\(form\)/,
    'public/js/settings.js attaches every list of the form'
  );
  assert.ok(
    view.includes('<script src="/js/chip-list.js"></script>'),
    'views/settings.ejs loads the shared list script'
  );

  // The runtime-override / locked-env pills bailed out on the same dead class,
  // so none of them ever rendered.
  assert.ok(
    /closest\(\s*['"]\.zr-field, \.zr-switchrow['"]\s*\)/.test(source),
    'the override pills must find their row as a .zr-field or a .zr-switchrow — the two shapes the settings form renders'
  );
}

async function run() {
  testWiringContract();
  await testField('Tags', 'tagInput');
  await testField('Ignore Tags', 'ignoreTagInput');
  await testEnterSurvivesAMissingButton();
  console.log('PASS test-settings-tag-input-wiring');
}

run().catch((error) => {
  console.error('FAIL test-settings-tag-input-wiring');
  console.error(error);
  process.exit(1);
});
