/**
 * Test: the "Quick start" topic of the settings page
 *
 * Quick start shows the six decisions Zettelrobbe needs, each one row with a
 * summary in words, and opens a step in place with controls that mirror real
 * fields of the form. The real fields stay the single source: a mirror has no
 * name, writes through to its real field and fires the events the page
 * listens to there.
 *
 * Covers, against the shipped public/js/modules/settings-quick-start.js:
 * 1. The summaries as pure functions: Paperless-ngx, provider and model, the
 *    fill list, the prompt, the OCR mode, the schedule in words (the words
 *    come from scan-schedule.js describeSchedule), the counter; no secret is
 *    ever part of a summary
 * 2. The mirror on a stub DOM: both directions, each event fired once on the
 *    real field, no loop, the mirror's own event stopped, disabled state and
 *    the environment note followed, select options copied and kept by index,
 *    the hidden yes/no input of a switch row resolved to its switch
 * 3. The partial: no control with a name, six steps in order, each head a real
 *    button with aria-expanded and aria-controls, every mirror names a field
 *    of the settings page, no stored secret rendered
 * 4. The wiring: Quick start is the first, featured entry and the topic a bare
 *    /settings shows; the old "quickstart" topic keeps its id; the settings
 *    page renders with it; settings-form.js leaves the mirrors out of its count
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

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

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const PARTIAL = path.join(
  root,
  'views',
  'partials',
  'settings-quick-start.ejs'
);

/* --- a stub DOM, as small as the mirror needs --------------------------- */

class StubOption {
  constructor(value, text, attrs = {}) {
    this.tagName = 'OPTION';
    this.value = value;
    this.text = text;
    this.attrs = attrs;
    this.parentElement = null;
    this.children = [];
  }

  get textContent() {
    return this.text;
  }

  cloneNode() {
    return new StubOption(this.value, this.text, { ...this.attrs });
  }
}

class StubField extends EventTarget {
  constructor({
    tag = 'INPUT',
    type = 'text',
    value = '',
    checked = false,
    disabled = false,
    placeholder,
  } = {}) {
    super();
    this.tagName = tag;
    this.type = type;
    this._value = value;
    this.checked = checked;
    this.disabled = disabled;
    if (placeholder !== undefined) this.placeholder = placeholder;
    this.children = [];
    this.selectedIndex = -1;
    this.replaced = 0;
  }

  get options() {
    return this.children.flatMap((node) =>
      node.tagName === 'OPTGROUP' ? node.children : [node]
    );
  }

  get value() {
    if (this.tagName !== 'SELECT') return this._value;
    const option = this.options[this.selectedIndex];
    return option ? option.value : '';
  }

  set value(next) {
    if (this.tagName !== 'SELECT') {
      this._value = String(next);
      return;
    }
    this.selectedIndex = this.options.findIndex((o) => o.value === next);
  }

  replaceChildren(...nodes) {
    this.replaced++;
    this.children = nodes;
    nodes.forEach((node) => {
      node.parentElement = this;
    });
    this.selectedIndex = this.options.length ? 0 : -1;
  }

  closest() {
    return null;
  }
}

const stubSelect = (options, selectedIndex = 0) => {
  const select = new StubField({ tag: 'SELECT', type: 'select-one' });
  select.children = options.map(
    ([value, text, attrs]) => new StubOption(value, text, attrs)
  );
  select.children.forEach((option) => {
    option.parentElement = select;
  });
  select.selectedIndex = selectedIndex;
  return select;
};

/** Counts the events a field receives, by type. */
function recorder(target) {
  const seen = { input: 0, change: 0 };
  target.addEventListener('input', () => seen.input++);
  target.addEventListener('change', () => seen.change++);
  return seen;
}

/** A person's edit: the value changes, then input and change fire. */
function edit(control, apply) {
  apply(control);
  const input = new Event('input', { bubbles: true });
  const change = new Event('change', { bubbles: true });
  control.dispatchEvent(input);
  control.dispatchEvent(change);
  return { input, change };
}

/* Elements with classes and a parent chain, for isAvailable and lockNote. */
class StubElement {
  constructor(classes = [], props = {}) {
    this.classes = new Set(classes);
    this.parentElement = null;
    this.children = [];
    Object.assign(this, props);
  }

  append(...children) {
    children.forEach((child) => {
      child.parentElement = this;
      this.children.push(child);
    });
    return this;
  }

  matches(selector) {
    return selector
      .split(',')
      .map((part) => part.trim())
      .some((part) => part.startsWith('.') && this.classes.has(part.slice(1)));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }
}

(async () => {
  const qs = await import(
    path.join(root, 'public', 'js', 'modules', 'settings-quick-start.js')
  );
  const { describeSchedule } = await import(
    path.join(root, 'public', 'js', 'modules', 'scan-schedule.js')
  );

  // ──────────────────────────────────────────────────────────────────────
  // 1. Summaries
  // ──────────────────────────────────────────────────────────────────────

  await test('Paperless-ngx: open until address and token are there', () => {
    assert.deepStrictEqual(
      qs.summarizePaperless({ url: '', tokenPresent: true }),
      { state: 'open', text: 'No address yet' }
    );
    assert.deepStrictEqual(
      qs.summarizePaperless({
        url: 'http://paperless:8000',
        tokenPresent: false,
      }),
      { state: 'open', text: 'http://paperless:8000 · no API token yet' }
    );
    // Zettelrobbe signs in with the token alone (tests/test-paperless-username.js).
    assert.deepStrictEqual(
      qs.summarizePaperless({
        url: 'http://paperless:8000',
        tokenPresent: true,
      }),
      { state: 'done', text: 'http://paperless:8000' }
    );
  });

  await test('Paperless-ngx: the probe adds connected, or turns the row into a problem', () => {
    const base = {
      url: 'http://paperless:8000',
      tokenPresent: true,
    };
    assert.deepStrictEqual(
      qs.summarizePaperless({ ...base, connection: 'ok' }),
      { state: 'done', text: 'http://paperless:8000 · connected' }
    );
    assert.deepStrictEqual(
      qs.summarizePaperless({ ...base, connection: 'rejected' }),
      {
        state: 'problem',
        text: 'http://paperless:8000 · Paperless-ngx rejects the API token',
      }
    );
    assert.strictEqual(
      qs.summarizePaperless({ ...base, connection: 'unreachable' }).state,
      'problem'
    );
    assert.strictEqual(qs.connectionState({ usable: true }), 'ok');
    assert.strictEqual(
      qs.connectionState({ reachable: true, authorized: false, usable: false }),
      'rejected'
    );
    assert.strictEqual(
      qs.connectionState({ reachable: false, usable: false }),
      'unreachable'
    );
    assert.strictEqual(qs.connectionState({ usable: null }), null);
    assert.strictEqual(qs.connectionState(null), null);
  });

  await test('Paperless-ngx: credentials in the address never reach the row', () => {
    const { text } = qs.summarizePaperless({
      url: 'https://user:hunter2@paperless.lan',
      tokenPresent: true,
      connection: 'ok',
    });
    assert.ok(!text.includes('hunter2'), text);
    assert.strictEqual(text, 'https://paperless.lan · connected');
  });

  await test('AI model: provider label and model, open while something is missing', () => {
    assert.deepStrictEqual(
      qs.summarizeAi({
        provider: 'openai',
        providerLabel: 'OpenAI',
        values: { openaiKey: '', openaiModel: 'gpt-4o-mini' },
        stored: { openaiKey: true },
      }),
      { state: 'done', text: 'OpenAI · gpt-4o-mini' }
    );
    assert.deepStrictEqual(
      qs.summarizeAi({
        provider: 'openai',
        providerLabel: 'OpenAI',
        values: { openaiModel: 'gpt-4o-mini' },
      }),
      { state: 'open', text: 'OpenAI · no API key yet' }
    );
    assert.deepStrictEqual(
      qs.summarizeAi({
        provider: 'ollama',
        providerLabel: 'Ollama',
        values: { ollamaUrl: '', ollamaModel: 'llama3.2' },
      }),
      { state: 'open', text: 'Ollama · no server address yet' }
    );
    // A local OpenAI-compatible server needs no key.
    assert.deepStrictEqual(
      qs.summarizeAi({
        provider: 'custom',
        providerLabel: 'LM Studio',
        values: {
          customBaseUrl: 'http://127.0.0.1:1234/v1',
          customModel: 'qwen2.5',
        },
      }),
      { state: 'done', text: 'LM Studio · qwen2.5' }
    );
    assert.deepStrictEqual(
      qs.summarizeAi({
        provider: 'azure',
        providerLabel: 'Azure OpenAI',
        values: { azureEndpoint: 'https://x', azureApiKey: 'k' },
      }),
      { state: 'open', text: 'Azure OpenAI · no deployment yet' }
    );
    assert.strictEqual(qs.summarizeAi({ provider: 'nope' }).state, 'open');
    assert.strictEqual(
      qs.summarizeAi({ provider: 'constructor' }).state,
      'open',
      'an inherited property is no provider'
    );
  });

  await test('AI model: a typed key counts but never shows', () => {
    const { state, text } = qs.summarizeAi({
      provider: 'anthropic',
      providerLabel: 'Anthropic (Claude)',
      values: { anthropicApiKey: 'sk-ant-secret', anthropicModel: 'claude-x' },
    });
    assert.strictEqual(state, 'done');
    assert.ok(!text.includes('sk-ant-secret'), text);
  });

  await test('What the AI fills in: the switched-on fields in page order', () => {
    const all = Object.fromEntries(qs.FILL_FIELDS.map(({ id }) => [id, true]));
    assert.deepStrictEqual(qs.summarizeFill({ on: all, customFieldCount: 2 }), {
      state: 'done',
      text: 'Title, tags, correspondent, document type, custom fields',
    });
    assert.strictEqual(
      qs.summarizeFill({ on: all, customFieldCount: 0 }).text,
      'Title, tags, correspondent, document type, custom fields (none set up)'
    );
    assert.deepStrictEqual(
      qs.summarizeFill({
        on: { activateTagging: true, activateDocumentType: true },
      }),
      { state: 'done', text: 'Tags, document type' }
    );
    assert.deepStrictEqual(qs.summarizeFill({ on: {} }), {
      state: 'open',
      text: 'Nothing switched on',
    });
  });

  await test('Prompt: none of your own, own (quoted, cut) or prompt tags only', () => {
    assert.deepStrictEqual(
      qs.summarizePrompt({ usePromptTags: false, systemPrompt: '  ' }),
      { state: 'done', text: 'No prompt of your own' }
    );
    assert.deepStrictEqual(
      qs.summarizePrompt({
        usePromptTags: false,
        systemPrompt: '\n  Name invoices by vendor.\nSecond line',
      }),
      { state: 'done', text: 'Your own prompt: “Name invoices by vendor.”' }
    );
    // Stored line breaks arrive as a literal \n.
    assert.strictEqual(
      qs.promptExcerpt('First line\\nsecond line'),
      'First line'
    );
    const long = qs.promptExcerpt('x'.repeat(80));
    assert.strictEqual(long.length, 48);
    assert.ok(long.endsWith('…'));
    assert.deepStrictEqual(
      qs.summarizePrompt({
        usePromptTags: true,
        promptTags: ['invoice', 'contract'],
        systemPrompt: 'ignored',
      }),
      { state: 'done', text: 'Prompt tags only: invoice, contract' }
    );
    assert.strictEqual(
      qs.summarizePrompt({ usePromptTags: true, promptTags: [] }).state,
      'open'
    );
  });

  await test('OCR: optional when off, the mode in words when on', () => {
    assert.deepStrictEqual(qs.summarizeOcr({ enabled: false }), {
      state: 'skipped',
      text: 'Off',
    });
    assert.deepStrictEqual(
      qs.summarizeOcr({
        enabled: true,
        providerLabel: 'Mistral OCR API',
        needsKey: true,
      }),
      { state: 'open', text: 'Mistral OCR API · no API key yet' }
    );
    assert.strictEqual(
      qs.summarizeOcr({ enabled: true, mode: 'off', providerLabel: 'Claude' })
        .text,
      'Claude · when the text is too short or the analysis fails'
    );
    assert.strictEqual(
      qs.summarizeOcr({
        enabled: true,
        mode: 'tagged',
        tag: 'needs-ocr',
        providerLabel: 'Claude',
      }).text,
      'Claude · before the analysis of documents tagged needs-ocr'
    );
    assert.strictEqual(
      qs.summarizeOcr({ enabled: true, mode: 'tagged', tag: '' }).state,
      'open'
    );
    assert.strictEqual(
      qs.summarizeOcr({ enabled: true, mode: 'ALL', providerLabel: 'Claude' })
        .text,
      'Claude · before the analysis of every new document'
    );
    // An unknown value reads as off, as config/config.js reads it.
    assert.strictEqual(
      qs.summarizeOcr({ enabled: true, mode: 'sometimes', providerLabel: 'X' })
        .text,
      'X · when the text is too short or the analysis fails'
    );
    // OCR_RUN_RIGHT_AWAY ends a complete summary; an open one says only what
    // is missing.
    assert.strictEqual(
      qs.summarizeOcr({
        enabled: true,
        mode: 'all',
        providerLabel: 'Claude',
        rightAway: true,
      }).text,
      'Claude · before the analysis of every new document · read right away'
    );
    assert.strictEqual(
      qs.summarizeOcr({ enabled: true, providerLabel: 'X', rightAway: true })
        .text,
      'X · when the text is too short or the analysis fails · read right away'
    );
    assert.deepStrictEqual(
      qs.summarizeOcr({
        enabled: true,
        mode: 'tagged',
        tag: '',
        providerLabel: 'X',
        rightAway: true,
      }),
      { state: 'open', text: 'X · no OCR tag yet' }
    );
    assert.deepStrictEqual(
      qs.summarizeOcr({ enabled: false, rightAway: true }),
      { state: 'skipped', text: 'Off' }
    );
  });

  await test('OCR timing: one answer for the two queue switches', () => {
    assert.deepStrictEqual(
      qs.OCR_TIMINGS.map((timing) => timing.value),
      ['right-away', 'schedule', 'both', 'manual']
    );
    assert.match(qs.OCR_TIMINGS[0].label, /recommended/);
    assert.strictEqual(
      qs.ocrTiming({ rightAway: true, schedule: false }),
      'right-away'
    );
    assert.strictEqual(
      qs.ocrTiming({ rightAway: false, schedule: true }),
      'schedule'
    );
    assert.strictEqual(
      qs.ocrTiming({ rightAway: true, schedule: true }),
      'both'
    );
    assert.strictEqual(
      qs.ocrTiming({ rightAway: false, schedule: false }),
      'manual'
    );
    // Every answer maps back to itself.
    qs.OCR_TIMINGS.forEach((timing) =>
      assert.strictEqual(qs.ocrTiming(timing), timing.value)
    );
    // The answer ends the summary; undecided keeps the step open.
    assert.strictEqual(
      qs.summarizeOcr({
        enabled: true,
        providerLabel: 'Claude',
        mode: 'tagged',
        tag: 'needs-ocr',
        timing: 'schedule',
      }).text,
      'Claude · before the analysis of documents tagged needs-ocr · read on a schedule'
    );
    assert.strictEqual(
      qs.summarizeOcr({ enabled: true, providerLabel: 'X', timing: 'manual' })
        .text,
      'X · when the text is too short or the analysis fails · read when started by hand'
    );
    assert.deepStrictEqual(
      qs.summarizeOcr({
        enabled: true,
        providerLabel: 'X',
        timing: 'manual',
        undecided: true,
      }),
      { state: 'open', text: 'X · choose when OCR runs' }
    );
    assert.deepStrictEqual(
      qs.summarizeOcr({ enabled: false, undecided: true }),
      { state: 'skipped', text: 'Off' }
    );
  });

  await test('Partial: the OCR step asks when OCR runs, right below the switch', () => {
    const source = fs.readFileSync(PARTIAL, 'utf8');
    const ocr = source.slice(
      source.indexOf('data-qs-step="ocr"'),
      source.indexOf('data-qs-step="run"')
    );
    const at = (needle) => {
      const index = ocr.indexOf(needle);
      assert.ok(index > -1, `missing ${needle}`);
      return index;
    };
    assert.ok(
      at("target: 'mistralOcrEnabled'") < at('data-qs-ocr-timing-picker')
    );
    assert.ok(at('data-qs-ocr-timing-picker') < at("target: 'ocrBeforeAi'"));
    assert.ok(at("target: 'ocrAutoProcessInterval'") > -1);
    assert.ok(!ocr.includes('data-qs-ocr-queue'));
  });

  await test('When it runs: the schedule in the words of describeSchedule', () => {
    assert.strictEqual(
      qs.scheduleWords('*/30 * * * *'),
      describeSchedule('*/30 * * * *')
    );
    assert.strictEqual(qs.scheduleWords('0  *  * * *'), 'Every hour');
    assert.strictEqual(
      qs.scheduleWords('0 8-18 * * 1-5'),
      'Cron 0 8-18 * * 1-5',
      'a shape without words is shown as it is'
    );
    assert.deepStrictEqual(
      qs.summarizeRun({
        automatic: true,
        scanInterval: '*/30 * * * *',
        onlyTagged: false,
      }),
      {
        state: 'done',
        text: 'Every 30 minutes · every document not analysed yet',
      }
    );
    assert.deepStrictEqual(
      qs.summarizeRun({
        automatic: true,
        scanInterval: '*/5 * * * *',
        onlyTagged: true,
        tags: ['inbox', 'scan'],
      }),
      {
        state: 'done',
        text: 'Every 5 minutes · only documents tagged inbox, scan',
      }
    );
    // A tag filter without tags finds nothing (paperlessService.js).
    assert.strictEqual(
      qs.summarizeRun({
        automatic: true,
        scanInterval: '*/5 * * * *',
        onlyTagged: true,
        tags: [],
      }).state,
      'open'
    );
    assert.deepStrictEqual(
      qs.summarizeRun({
        automatic: false,
        scanInterval: '',
        onlyTagged: false,
      }),
      { state: 'done', text: 'Automatic scans are stopped' }
    );
    assert.strictEqual(
      qs.summarizeRun({ automatic: true, scanInterval: ' ', onlyTagged: false })
        .state,
      'open'
    );
    qs.SCHEDULE_PRESETS.forEach((cron) =>
      assert.notStrictEqual(
        describeSchedule(cron),
        cron,
        `the preset ${cron} has no words`
      )
    );
  });

  await test('The counter counts done steps; an optional step off is not one', () => {
    const summaries = {
      paperless: { state: 'done' },
      ai: { state: 'open' },
      fill: { state: 'done' },
      prompt: { state: 'done' },
      ocr: { state: 'skipped' },
      run: { state: 'problem' },
    };
    assert.strictEqual(qs.countDone(summaries), 3);
    assert.strictEqual(qs.progressText(5), '5 of 6 done');
    assert.deepStrictEqual(qs.QUICK_START_STEPS, [
      'paperless',
      'ai',
      'fill',
      'prompt',
      'ocr',
      'run',
    ]);
    Object.keys(qs.STATE_WORDS).forEach((state) =>
      assert.ok(qs.STATE_WORDS[state].endsWith('.'), state)
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. The mirror
  // ──────────────────────────────────────────────────────────────────────

  await test('Mirror: shows the real value and placeholder from the start', () => {
    const real = new StubField({
      value: 'http://a:8000',
      placeholder: 'Configured',
    });
    const control = new StubField();
    qs.bindMirror(control, real);
    assert.strictEqual(control.value, 'http://a:8000');
    assert.strictEqual(control.placeholder, 'Configured');
  });

  await test('Mirror: an edit writes through and fires each event once on the real field', () => {
    const real = new StubField({ value: 'old' });
    const control = new StubField();
    qs.bindMirror(control, real);
    const onReal = recorder(real);
    const bubbling = [];
    real.addEventListener('input', (event) => bubbling.push(event.bubbles));
    const { input, change } = edit(control, (c) => {
      c.value = 'new';
    });
    assert.strictEqual(real.value, 'new');
    assert.deepStrictEqual(onReal, { input: 1, change: 1 });
    assert.deepStrictEqual(
      bubbling,
      [true],
      'the real event bubbles to the form'
    );
    assert.ok(
      input.cancelBubble && change.cancelBubble,
      "the mirror's own events stop at the mirror"
    );
  });

  await test('Mirror: an edit of the real field comes back without an event on the mirror', () => {
    const real = new StubField({ value: 'a' });
    const control = new StubField();
    qs.bindMirror(control, real);
    const onControl = recorder(control);
    const onReal = recorder(real);
    real.value = 'b';
    real.dispatchEvent(new Event('change', { bubbles: true }));
    assert.strictEqual(control.value, 'b');
    assert.deepStrictEqual(onControl, { input: 0, change: 0 }, 'no loop');
    assert.deepStrictEqual(onReal, { input: 0, change: 1 });
    // Set without an event (Fetch models, a provider preset): pull() catches up.
    real.value = 'c';
    assert.strictEqual(control.value, 'b');
    const binding = qs.bindMirror(new StubField(), real);
    real.value = 'd';
    binding.pull();
    assert.strictEqual(binding.control.value, 'd');
  });

  await test('Mirror: a listener that rewrites the real value is followed, once', () => {
    const real = new StubField();
    const control = new StubField();
    qs.bindMirror(control, real);
    const onReal = recorder(real);
    real.addEventListener('input', () => {
      real.value = real.value.trim();
    });
    edit(control, (c) => {
      c.value = '  spaced  ';
    });
    assert.strictEqual(real.value, 'spaced');
    assert.strictEqual(control.value, 'spaced');
    assert.deepStrictEqual(onReal, { input: 1, change: 1 });
  });

  await test('Mirror: a checkbox follows checked both ways', () => {
    const real = new StubField({ type: 'checkbox', checked: true });
    const control = new StubField({ type: 'checkbox' });
    qs.bindMirror(control, real);
    assert.strictEqual(control.checked, true);
    const onReal = recorder(real);
    edit(control, (c) => {
      c.checked = false;
    });
    assert.strictEqual(real.checked, false);
    assert.deepStrictEqual(onReal, { input: 1, change: 1 });
    real.checked = true;
    real.dispatchEvent(new Event('change'));
    assert.strictEqual(control.checked, true);
  });

  await test('Mirror: disabled follows the real field, which is never written then', () => {
    const real = new StubField({ value: 'pinned' });
    const control = new StubField();
    const binding = qs.bindMirror(control, real);
    real.disabled = true;
    binding.pull();
    assert.strictEqual(control.disabled, true);
    const onReal = recorder(real);
    edit(control, (c) => {
      c.value = 'changed anyway';
    });
    assert.strictEqual(real.value, 'pinned');
    assert.strictEqual(
      control.value,
      'pinned',
      'the mirror shows the real value again'
    );
    assert.deepStrictEqual(onReal, { input: 0, change: 0 });
    real.disabled = false;
    binding.pull();
    assert.strictEqual(control.disabled, false);
  });

  await test('Mirror: a select gets the real options and keeps the choice by position', () => {
    // Two entries share the value "custom", as in the provider list.
    const real = stubSelect(
      [
        ['openai', 'OpenAI', { choice: 'openai-default' }],
        ['custom', 'Mistral', { choice: 'mistral' }],
        ['custom', 'LM Studio', { choice: 'lmstudio-local' }],
      ],
      0
    );
    const control = new StubField({ tag: 'SELECT', type: 'select-one' });
    const binding = qs.bindMirror(control, real);
    assert.deepStrictEqual(
      control.options.map((o) => o.text),
      ['OpenAI', 'Mistral', 'LM Studio']
    );
    assert.notStrictEqual(
      control.options[0],
      real.options[0],
      'copies, not moves'
    );
    const onReal = recorder(real);
    edit(control, (c) => {
      c.selectedIndex = 2;
    });
    assert.strictEqual(
      real.selectedIndex,
      2,
      'LM Studio, not the first "custom"'
    );
    assert.deepStrictEqual(onReal, { input: 1, change: 1 });
    const copies = control.replaced;
    binding.pull();
    assert.strictEqual(
      control.replaced,
      copies,
      'unchanged options are not copied again'
    );
    // Fetch models refills the real select.
    real.replaceChildren(
      new StubOption('llama3.2', 'llama3.2'),
      new StubOption('qwen', 'qwen')
    );
    real.selectedIndex = 1;
    binding.pull();
    assert.deepStrictEqual(
      control.options.map((o) => o.value),
      ['llama3.2', 'qwen']
    );
    assert.strictEqual(control.selectedIndex, 1);
  });

  await test('Mirror: destroy() unbinds both directions', () => {
    const real = new StubField({ value: 'a' });
    const control = new StubField();
    const binding = qs.bindMirror(control, real);
    binding.destroy();
    const onReal = recorder(real);
    edit(control, (c) => {
      c.value = 'x';
    });
    assert.strictEqual(real.value, 'a');
    assert.deepStrictEqual(onReal, { input: 0, change: 0 });
  });

  await test('Mirror target: the hidden yes/no input of a switch row means its switch', () => {
    const hidden = { id: 'showTags', type: 'hidden' };
    const visible = { id: 'showTagsSwitch', type: 'checkbox' };
    const plain = { id: 'scanInterval', type: 'text' };
    const doc = {
      getElementById: (id) =>
        ({ showTags: hidden, scanInterval: plain })[id] || null,
      querySelector: (selector) =>
        selector === '[data-switch-target="showTags"]' ? visible : null,
    };
    assert.strictEqual(qs.resolveMirrorTarget('showTags', doc), visible);
    assert.strictEqual(qs.resolveMirrorTarget('scanInterval', doc), plain);
    assert.strictEqual(qs.resolveMirrorTarget('missing', doc), null);
  });

  await test('Availability: hidden blocks of the topic count, the hidden topic does not', () => {
    const entry = new StubElement(['zr-settings-entry', 'hidden']);
    const block = new StubElement(['zr-col']);
    const field = new StubElement([]);
    entry.append(block.append(field));
    assert.strictEqual(qs.isAvailable(field), true, 'another topic is shown');
    block.classes.add('hidden');
    assert.strictEqual(
      qs.isAvailable(field),
      false,
      "another provider's block"
    );
  });

  await test('Lock note: the sentence settings.js wrote, else the pinned key', () => {
    const row = new StubElement(['zr-field']);
    const hint = new StubElement(['zr-field__hint']);
    const sentence = new StubElement(['zr-field__locked'], {
      textContent: ' Set by the environment (SCAN_INTERVAL).',
    });
    const field = new StubElement([], { disabled: true, dataset: {} });
    row.append(hint.append(sentence), field);
    assert.strictEqual(
      qs.lockNote(field),
      'Set by the environment (SCAN_INTERVAL).'
    );

    const tile = new StubElement(['zr-checktile'], {
      title: 'Set by the environment (ACTIVATE_TAGGING).',
    });
    const box = new StubElement([], { disabled: true, dataset: {} });
    tile.append(box);
    assert.strictEqual(
      qs.lockNote(box),
      'Set by the environment (ACTIVATE_TAGGING).'
    );

    const bare = new StubElement([], {
      disabled: true,
      dataset: { envKey: 'AI_PROVIDER' },
    });
    assert.strictEqual(
      qs.lockNote(bare, new Set(['AI_PROVIDER'])),
      'Set by the environment (AI_PROVIDER).'
    );
    assert.strictEqual(
      qs.lockNote(bare, new Set()),
      '',
      'disabled for another reason'
    );
    assert.strictEqual(qs.lockNote({ disabled: false }), '');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. The partial
  // ──────────────────────────────────────────────────────────────────────

  const view = read('views', 'settings.ejs');
  const groupsSource = view.slice(
    view.indexOf('const settingsGroups = ['),
    view.indexOf('const settingsFirstEntry')
  );
  const settingsGroups = [
    {
      label: 'Essentials',
      entries: [{ id: 'quick-start', title: 'Quick start' }],
    },
    ...[...groupsSource.matchAll(/\{ id: '([a-z-]+)', title: '([^']+)'/g)]
      .slice(1)
      .map(([, id, title]) => ({ label: 'x', entries: [{ id, title }] })),
  ];
  const secrets = {
    PAPERLESS_API_TOKEN: true,
    OPENAI_API_KEY: true,
    CUSTOM_API_KEY: false,
    AZURE_API_KEY: false,
    ANTHROPIC_API_KEY: true,
  };
  const html = await ejs.renderFile(PARTIAL, {
    configuredSecrets: secrets,
    settingsGroups,
    ocrKeyStored: true,
  });

  await test('Partial: no control carries a name', () => {
    assert.ok(!/\sname\s*=/i.test(html), 'a name attribute in the partial');
    const controls = html.match(/<(input|select|textarea)\b/gi) || [];
    assert.ok(controls.length >= 20, `only ${controls.length} controls`);
  });

  await test('Partial: six steps in order, each head a real button that controls its body', () => {
    const order = [...html.matchAll(/data-qs-step="([a-z]+)"/g)].map(
      (m) => m[1]
    );
    assert.deepStrictEqual(order, qs.QUICK_START_STEPS);
    const buttons = [
      ...html.matchAll(/<button\b[^>]*data-qs-toggle[^>]*>/g),
    ].map((m) => m[0]);
    assert.strictEqual(buttons.length, 6);
    buttons.forEach((button) => {
      assert.match(button, /type="button"/);
      assert.match(button, /aria-expanded="false"/);
      const controls = button.match(/aria-controls="([^"]+)"/);
      assert.ok(controls, button);
      assert.ok(html.includes(`id="${controls[1]}"`), `no body ${controls[1]}`);
    });
    assert.match(
      html,
      /OCR for scanned documents <span class="zr-badge">Optional<\/span>/
    );
  });

  await test('Partial: every mirror names a field of the settings page, the summaries read the same ones', () => {
    const targets = [...html.matchAll(/data-mirror="([A-Za-z]+)"/g)].map(
      (m) => m[1]
    );
    assert.strictEqual(
      new Set(targets).size,
      targets.length,
      'a field mirrored twice'
    );
    const missing = targets.filter(
      (id) => !view.includes(`id="${id}"`) && !view.includes(`id: '${id}'`)
    );
    assert.deepStrictEqual(missing, [], 'mirrors without a real field');
    const needed = [
      ...Object.values(qs.PROVIDER_NEEDS).flatMap((needs) =>
        Object.values(needs)
      ),
      ...qs.FILL_FIELDS.map(({ id }) => id),
      'aiProvider',
      'paperlessUrl',
      'paperlessToken',
      'systemPrompt',
      'mistralOcrEnabled',
      'ocrBeforeAi',
      'scanInterval',
      'showTags',
    ];
    const unmirrored = needed.filter((id) => !targets.includes(id));
    assert.deepStrictEqual(unmirrored, [], 'summary fields without a control');
  });

  await test('Partial: its ids are its own, and no secret value is rendered', () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate id');
    const clashes = ids.filter((id) => view.includes(`id="${id}"`));
    assert.deepStrictEqual(clashes, [], 'ids that settings.ejs uses too');
    const stored = html.match(/data-stored-secrets="([^"]*)"/);
    assert.ok(stored, 'no stored-secrets attribute');
    const flags = JSON.parse(stored[1].replace(/&#34;|&quot;/g, '"'));
    Object.values(flags).forEach((flag) =>
      assert.strictEqual(typeof flag, 'boolean')
    );
    assert.strictEqual(flags.paperlessToken, true);
    assert.strictEqual(flags.ocrApiKey, true);
    assert.match(html, /data-mirror-scope/);
    assert.match(html, /data-module="settings-quick-start"/);
    assert.match(html, /Leave it empty to keep the stored token\./);
  });

  await test('Partial: each step links to its topic by the current topic name', () => {
    assert.match(
      html,
      /href="#connection">All options in Paperless-ngx connection</
    );
    assert.match(html, /href="#ai-provider">All options in AI provider</);
    assert.match(
      html,
      /href="#schedule">All options in Schedule and tag filters</
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Wiring
  // ──────────────────────────────────────────────────────────────────────

  await test('Quick start is the first, featured entry; the old quickstart keeps its id', () => {
    const first = groupsSource.match(/\{ id: '([a-z-]+)'[^}]*\}/);
    assert.ok(first, 'no entry in settingsGroups');
    assert.strictEqual(first[1], 'quick-start');
    assert.match(first[0], /featured: true/);
    assert.match(groupsSource, /\{ id: 'quickstart', title: '/);
    const quickStart = view.indexOf("entryOpen('quick-start')");
    const connection = view.indexOf("entryOpen('connection')");
    assert.ok(
      quickStart > view.indexOf('<form id="setupForm"'),
      'outside the form'
    );
    assert.ok(
      quickStart !== -1 && quickStart < connection,
      'not the first topic in the form'
    );
    assert.match(view, /include\('partials\/settings-quick-start'/);
  });

  await test('settings-form.js leaves the mirrors out of the unsaved-change count', async () => {
    const { countsAsSetting } = await import(
      path.join(root, 'public', 'js', 'modules', 'settings-form.js')
    );
    // A Quick start control: inside [data-mirror-scope], so the real field it
    // mirrors is what the save bar counts.
    const field = (scope, extra = {}) => ({
      type: 'text',
      id: 'quickStartPaperlessUrl',
      closest: (selector) =>
        selector.includes(scope) ? { matches: () => true } : null,
      hasAttribute: () => false,
      ...extra,
    });
    assert.strictEqual(
      countsAsSetting(field('[data-mirror-scope]'), new Set()),
      false
    );
    assert.strictEqual(
      countsAsSetting(field('nothing', { id: 'paperlessUrl' }), new Set()),
      true
    );
  });

  await test('The settings page renders with Quick start shown and every other topic hidden', async () => {
    const catalog = require('../services/settingsCatalog');
    const aiProviderRules = require('../services/aiProviderRules');
    const aiFormOptions = require('../services/aiFormOptions');
    const { DEFAULT_OCR_PROMPTS } = require('../services/ocrPrompt');
    const { RESTART_REQUIRED_KEYS } = require('../config/restartRequiredKeys');
    const config = catalog.defaultsFromEnv({}, 'page');
    const configuredSecrets = {};
    catalog.secretKeys().forEach((key) => {
      configuredSecrets[key] = false;
      config[key] = '';
    });
    const presets = await aiFormOptions.loadAiProviderPresets();
    const shellLocals = {};
    const navScripts = read('views', 'partials', 'sidebar-nav-scripts.ejs');
    [...new Set(navScripts.match(/\bapp[A-Z][A-Za-z]*/g) || [])].forEach(
      (key) => {
        shellLocals[key] = '';
      }
    );
    const page = await ejs.renderFile(
      path.join(root, 'views', 'settings.ejs'),
      {
        ...shellLocals,
        version: 'test',
        theme: 'light',
        config,
        configuredSecrets,
        pdfPasswordCount: 0,
        lockedEnvKeys: [],
        bootId: 'test',
        aiProviderPresets: presets,
        aiProviderChoice: aiFormOptions.matchProviderChoice(
          presets,
          config.AI_PROVIDER,
          ''
        )?.id,
        anthropicOptions: aiFormOptions.getAnthropicFormOptions(),
        ocrPromptDefaults: DEFAULT_OCR_PROMPTS,
        aiOptions: aiProviderRules.AI_OPTIONS,
        aiProviders: aiProviderRules.PROVIDERS,
        restartRequiredKeys: Array.from(RESTART_REQUIRED_KEYS),
        mfaSettings: { available: false, username: '', enabled: false },
        oidcDetectedRedirectUri: '',
        oidcStatus: { enabled: false, errors: [] },
        changelogReleases: [],
        success: undefined,
        settingsError: undefined,
      }
    );
    const entries = [
      ...page.matchAll(
        /<section class="zr-settings-entry([^"]*)" id="entry-([a-z-]+)"/g
      ),
    ];
    assert.strictEqual(entries[0][2], 'quick-start', 'not the first topic');
    assert.ok(!entries[0][1].includes('hidden'), 'Quick start is hidden');
    entries
      .slice(1)
      .forEach((entry) =>
        assert.ok(entry[1].includes('hidden'), `${entry[2]} is shown too`)
      );
    assert.match(page, /data-entry-link="quick-start" aria-current="page"/);
    // Every mirror finds its real field in the rendered page.
    const targets = [...page.matchAll(/data-mirror="([A-Za-z]+)"/g)].map(
      (m) => m[1]
    );
    const absent = targets.filter((id) => !page.includes(`id="${id}"`));
    assert.deepStrictEqual(
      absent,
      [],
      'mirrors whose field the page does not render'
    );
    // The partial adds no named control, so the form posts what it did before.
    const quick = page.slice(
      page.indexOf('id="entry-quick-start"'),
      page.indexOf('id="entry-connection"')
    );
    assert.ok(
      !/\sname\s*=/i.test(quick),
      'a named control in the Quick start topic'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
