'use strict';

/**
 * The OCR key field is locked when the container pins MISTRAL_API_KEY.
 *
 * The page has one field for the OCR key (#ocrApiKey), and it writes
 * OCR_API_KEY. Mistral OCR, the OpenAI-compatible and the Ollama OCR read
 * OCR_API_KEY first and fall back to MISTRAL_API_KEY, so a key typed into the
 * field would win over a MISTRAL_API_KEY the container pins. The field was
 * locked only for a pinned OCR_API_KEY. It is now locked for a pinned
 * MISTRAL_API_KEY too, unless the OCR provider is Claude, which never reads
 * that key; the lock follows the provider switch.
 *
 * What is pinned here:
 * - GET /settings lists MISTRAL_API_KEY in data-locked-env-keys when the
 *   container sets it (the browser decides from that list).
 * - The lock code of public/js/settings.js, driven against a small stub DOM:
 *   locked for mistral/custom/ollama, free for anthropic, both on load and
 *   after a provider switch, one note per hint, and a pinned OCR_API_KEY
 *   stays locked whatever the provider.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Pinned by the container; config.js asks this object on every call. Set
// before the harness loads config.js.
global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = {
  MISTRAL_API_KEY: 'pinned-mistral-key',
};

const { mountRouter } = require('./helpers/mount-router');

const API_KEY = 'test-api-key';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

/* ── A stub DOM: just enough for the lock code ─────────────────────────── */

function matches(element, selector) {
  return selector.split(',').some((part) => {
    const one = part.trim();
    if (one.startsWith('.')) {
      return String(element.className || '')
        .split(/\s+/)
        .includes(one.slice(1));
    }
    if (one.startsWith('#')) return element.id === one.slice(1);
    if (one === '[data-env-key]') return 'envKey' in element.dataset;
    const lockedBy = one.match(/^\[data-locked-by="(.+)"\]$/);
    if (lockedBy) return element.dataset.lockedBy === lockedBy[1];
    return false;
  });
}

class StubElement {
  constructor(tagName, props = {}) {
    this.tagName = tagName;
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.disabled = false;
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.parent = null;
    this.listeners = {};
    Object.assign(this, props);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, listener) {
    (this.listeners[type] = this.listeners[type] || []).push(listener);
  }

  dispatch(type) {
    (this.listeners[type] || []).forEach((listener) =>
      listener({ type, target: this })
    );
  }

  append(...children) {
    children.forEach((child) => {
      child.parent = this;
      this.children.push(child);
    });
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(
      (child) => child !== this
    );
    this.parent = null;
  }

  closest(selector) {
    for (let node = this; node; node = node.parent) {
      if (matches(node, selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      node.children.forEach((child) => {
        if (matches(child, selector)) found.push(child);
        walk(child);
      });
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

/**
 * The OCR part of the settings form with the given locked keys and OCR
 * provider, and the page's lock code bound to it.
 */
function buildPage(lockedEnvKeys, provider) {
  const setupForm = new StubElement('form', { id: 'setupForm' });
  setupForm.dataset.lockedEnvKeys = JSON.stringify(lockedEnvKeys);

  const providerField = new StubElement('div', { className: 'zr-field' });
  const providerSelect = new StubElement('select', {
    id: 'ocrProvider',
    value: provider,
  });
  providerField.append(providerSelect);

  const keyField = new StubElement('div', {
    id: 'ocrApiKeyContainer',
    className: 'zr-field zr-field--stacked',
  });
  const keyInput = new StubElement('input', { id: 'ocrApiKey' });
  const hint = new StubElement('p', {
    id: 'ocrApiKeyHint',
    className: 'zr-field__hint',
    textContent: 'Optional for local and custom providers',
  });
  const anthropicHint = new StubElement('p', {
    id: 'ocrApiKeyAnthropicHint',
    className: 'zr-field__hint hidden',
    textContent: 'Empty uses the Anthropic API key from the AI provider',
  });
  keyField.append(keyInput, hint, anthropicHint);
  setupForm.append(providerField, keyField);

  const byId = { setupForm, ocrProvider: providerSelect, ocrApiKey: keyInput };
  const documentStub = {
    getElementById: (id) => byId[id] || null,
    querySelector: (selector) =>
      selector.startsWith('#') ? byId[selector.slice(1)] || null : null,
    createElement: (tagName) => new StubElement(tagName),
  };

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'settings.js'),
    'utf8'
  );
  const start = source.indexOf('function annotateEnvKeys(');
  const end = source.indexOf('// Custom Fields Management', start);
  assert.ok(start !== -1 && end > start, 'lock code not found in settings.js');
  const initialize = new Function(
    'document',
    `${source.slice(start, end)}\nreturn initializeRuntimeOverridePills;`
  )(documentStub);
  initialize();

  const notes = () =>
    keyField
      .querySelectorAll('.zr-field__locked')
      .map((note) => note.textContent.trim());
  const switchTo = (value) => {
    providerSelect.value = value;
    providerSelect.dispatch('change');
  };
  return { keyInput, notes, switchTo };
}

const NOTE = (key) => `· Set by the environment (${key}).`;

async function main() {
  await test('GET /settings lists a pinned MISTRAL_API_KEY as locked', async () => {
    const harness = await mountRouter({
      env: { MISTRAL_API_KEY: 'pinned-mistral-key' },
    });
    try {
      const response = await fetch(harness.base + '/settings', {
        redirect: 'manual',
        headers: { 'x-api-key': API_KEY },
      });
      assert.strictEqual(response.status, 200, 'GET /settings must render');
      const html = await response.text();
      const match = html.match(/data-locked-env-keys="([^"]*)"/);
      assert.ok(match, 'data-locked-env-keys is rendered');
      const locked = JSON.parse(match[1].replace(/&#34;/g, '"'));
      assert.ok(locked.includes('MISTRAL_API_KEY'), JSON.stringify(locked));
      assert.ok(!locked.includes('OCR_API_KEY'), JSON.stringify(locked));
    } finally {
      await harness.close();
    }
  });

  await test('a pinned MISTRAL_API_KEY locks the OCR key for Mistral, custom and Ollama', async () => {
    for (const provider of ['mistral', 'custom', 'ollama']) {
      const page = buildPage(['MISTRAL_API_KEY'], provider);
      assert.strictEqual(page.keyInput.disabled, true, provider);
      assert.strictEqual(
        page.keyInput.attributes['aria-disabled'],
        'true',
        provider
      );
      assert.deepStrictEqual(
        page.notes(),
        [NOTE('MISTRAL_API_KEY'), NOTE('MISTRAL_API_KEY')],
        provider
      );
    }
  });

  await test('Claude OCR never reads MISTRAL_API_KEY: the field stays free', async () => {
    const page = buildPage(['MISTRAL_API_KEY'], 'anthropic');
    assert.strictEqual(page.keyInput.disabled, false);
    assert.deepStrictEqual(page.notes(), []);
  });

  await test('the lock follows the provider switch', async () => {
    const page = buildPage(['MISTRAL_API_KEY'], 'mistral');
    page.switchTo('anthropic');
    assert.strictEqual(page.keyInput.disabled, false, 'free for Claude');
    assert.strictEqual(page.keyInput.attributes['aria-disabled'], undefined);
    assert.deepStrictEqual(page.notes(), []);
    page.switchTo('custom');
    assert.strictEqual(page.keyInput.disabled, true, 'locked again');
    assert.deepStrictEqual(page.notes(), [
      NOTE('MISTRAL_API_KEY'),
      NOTE('MISTRAL_API_KEY'),
    ]);
    page.switchTo('ollama');
    assert.strictEqual(page.notes().length, 2, 'one note per hint');

    const fromClaude = buildPage(['MISTRAL_API_KEY'], 'anthropic');
    fromClaude.switchTo('mistral');
    assert.strictEqual(fromClaude.keyInput.disabled, true);
  });

  await test('a pinned OCR_API_KEY locks the field for every provider', async () => {
    const page = buildPage(['OCR_API_KEY', 'MISTRAL_API_KEY'], 'anthropic');
    assert.strictEqual(page.keyInput.disabled, true);
    assert.deepStrictEqual(page.notes(), [
      NOTE('OCR_API_KEY'),
      NOTE('OCR_API_KEY'),
    ]);
    page.switchTo('mistral');
    assert.strictEqual(page.keyInput.disabled, true);
    assert.strictEqual(page.notes().length, 2);
  });

  await test('nothing pinned: the field is free', async () => {
    const page = buildPage([], 'mistral');
    assert.strictEqual(page.keyInput.disabled, false);
    assert.deepStrictEqual(page.notes(), []);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌  settings-ocr-key-lock test crashed');
  console.error(error);
  process.exit(1);
});
