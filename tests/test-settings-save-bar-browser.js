/**
 * Test: the save bar never covers the settings page, measured in a browser
 *
 * The definition of "the bar is part of the layout": in headless Chrome,
 * at several widths and in several topics, a change makes the bar appear,
 * and then
 * 1. the region that scrolls ends exactly where the bar starts, and on a
 *    phone the bar ends exactly where the tab bar starts;
 * 2. at the top, the middle and the end of the region no control, label,
 *    hint or section title of the topic is drawn under the bar;
 * 3. the last row of the topic can be scrolled fully into view;
 * 4. the last field, focused, rests above the bar and below the top bar;
 * 5. a link to the last section of the topic lands between the two bars;
 * 6. the bar goes when the change is undone, and at the end of the region
 *    the row being edited does not move when it goes;
 * 7. the window itself never scrolls;
 * 8. the bar's content starts at the left edge of the block (the topic list
 *    card, at the page padding) and, once the topic column has its full
 *    width, ends at the right edge of the topic.
 * Also: a field the browser refuses, and a "Find a setting" match, rest
 * between the bars; a list of pills and a Quick start mirror are counted and
 * named once; with the group of the open topic open the topic list fits a
 * window 720px high; at 1477px and on a phone the page draws two cards, the
 * topic list and the open topic, and no text or box of the settings column
 * outside the topic's card. And what the bar counts: nothing typed in Ask a
 * server (Detect models), every real field its Apply writes; Discard puts
 * the written fields and the list of custom fields back.
 *
 * Needs Chrome (CHROME_PATH, or Google Chrome where macOS installs it);
 * without it the runner skips this test.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { launchChrome } = require('./helpers/cdp');

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

/** Runs in the page: one change in the open topic, then the measurements. */
const PROBE = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const scroller = document.querySelector('[data-el="scroller"]');
  const bar = document.querySelector('[data-el="actionbar"]');
  const topbar = document.querySelector('.zr-topbar');
  const tabbar = document.querySelector('.zr-tabbar');
  const entry = document.querySelector('.zr-settings-entry:not(.hidden)');
  const rect = (el) => el.getBoundingClientRect();
  const visible = (el) => el.getClientRects().length > 0 && !el.closest('.hidden, [hidden]') && !el.closest('details:not([open]) > :not(summary)');
  const clip = (r, c) => ({ top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom), left: Math.max(r.left, c.left), right: Math.min(r.right, c.right) });
  const meets = (a, b) => a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 && a.left < b.right && b.left < a.right;
  const out = { topic: entry.dataset.entry, barHiddenAtLoad: bar.hidden };
  const editable = (el) => visible(el) && !el.disabled && !el.readOnly && !el.closest('[data-not-a-setting]');

  // A switch of the topic, else a text field; switches set by the
  // environment are locked.
  const toggle = [...entry.querySelectorAll('input.zr-toggle')].reverse().find(editable);
  const texts = () => [...entry.querySelectorAll('input.zr-input[type="text"], input.zr-input[type="number"], textarea')].filter(editable);
  const typed = toggle ? null : texts()[0];
  const change = () => {
    if (toggle) toggle.click();
    else {
      typed.value += '1';
      typed.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  const undo = () => {
    if (toggle) toggle.click();
    else {
      typed.value = typed.value.slice(0, -1);
      typed.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  if (!toggle && !typed) return out;
  change();
  await frame();
  out.barShown = !bar.hidden;
  const barR = rect(bar);
  out.regionEndsAtBar = Math.round(barR.top - rect(scroller).bottom);
  // The bar's content starts with the block (the topic list card) and, once
  // the topic column has its full width, ends with it.
  const inner = bar.querySelector('.zr-actionbar__inner');
  const pad = getComputedStyle(inner);
  const innerR = rect(inner);
  const asideR = rect(document.querySelector('.zr-settings__aside'));
  const mainR = rect(document.querySelector('.zr-settings__main'));
  out.barStart = Math.round(innerR.left + parseFloat(pad.paddingLeft) - asideR.left);
  out.barEnd = Math.round(innerR.right - parseFloat(pad.paddingRight) - mainR.right);
  out.columnFull = mainR.width >= 719;
  out.barOnTabbar = tabbar && getComputedStyle(tabbar).display !== 'none' ? Math.round(rect(tabbar).top - barR.bottom) : null;

  const things = () => [...entry.querySelectorAll('input:not([type="hidden"]), select, textarea, button, label, .zr-field__hint, .zr-settings-section__title')].filter(visible);
  out.overlaps = 0;
  for (const where of [0, 0.5, 1]) {
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * where;
    await frame();
    const c = rect(scroller);
    things().forEach((el) => {
      const v = clip(rect(el), c);
      if (v.bottom > v.top && meets(v, rect(bar))) out.overlaps++;
    });
  }
  scroller.scrollTop = scroller.scrollHeight;
  await frame();
  const last = things().pop();
  out.lastRowGap = Math.round(rect(scroller).bottom - rect(last).bottom);

  const fields = [...entry.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter((el) => visible(el) && !el.disabled);
  const lastField = fields.pop();
  scroller.scrollTop = 0;
  await frame();
  lastField.focus();
  await frame();
  out.focus = { aboveBar: Math.round(rect(bar).top - rect(lastField).bottom), belowTopbar: Math.round(rect(lastField).top - rect(topbar).bottom) };
  lastField.blur();

  const section = [...entry.querySelectorAll('.zr-settings-section[id]')].filter(visible).pop();
  if (section) {
    scroller.scrollTop = 0;
    await frame();
    location.hash = '#' + section.id;
    await sleep(250);
    const r = rect(section.querySelector('.zr-settings-section__title'));
    out.hash = { aboveBar: Math.round(rect(bar).top - r.bottom), belowTopbar: Math.round(r.top - rect(topbar).bottom) };
  }

  undo();
  await frame();
  out.barGone = bar.hidden;

  const lastText = texts().pop();
  if (lastText) {
    lastText.value += '1';
    lastText.dispatchEvent(new Event('input', { bubbles: true }));
    await frame();
    scroller.scrollTop = scroller.scrollHeight;
    await frame();
    const at = rect(lastText).top;
    lastText.value = lastText.value.slice(0, -1);
    lastText.dispatchEvent(new Event('input', { bubbles: true }));
    await frame();
    out.exitMoved = Math.round(rect(lastText).top - at);
  }
  out.windowScrolls = document.scrollingElement.scrollHeight > innerHeight + 1;
  return out;
})()`;

/**
 * Runs in the page: the cards the settings column draws and what it draws
 * outside them. Every piece of text with a box on screen, and every element
 * with one, has to sit in the one card of the open topic.
 */
const ONE_CARD = String.raw`(() => {
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const main = document.querySelector('.zr-settings__main');
  const cards = [...main.querySelectorAll('.zr-module')].filter(shown);
  const card = cards[0] || null;
  const holds = (node) => Boolean(card) && card.contains(node);
  const texts = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim() || holds(node)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if ([...range.getClientRects()].some((r) => r.width > 0 && r.height > 0)) {
      texts.push(node.textContent.trim().slice(0, 40));
    }
  }
  const boxes = [...main.querySelectorAll('*')]
    .filter((el) => shown(el) && !holds(el) && !(card && el.contains(card)))
    .map((el) => el.tagName + '.' + el.className);
  const list = document.querySelector('.zr-settings__aside > .zr-module').getBoundingClientRect();
  const r = card ? card.getBoundingClientRect() : null;
  return {
    cards: cards.length,
    allCards: [...document.querySelectorAll('.zr-settings .zr-module')].filter(shown).length,
    texts,
    boxes,
    sideBySide: r ? list.right <= r.left && Math.round(r.top - list.top) === 0 : null,
    below: r ? list.bottom <= r.top : null,
  };
})()`;

const BETWEEN_BARS = String.raw`((el) => {
  const bar = document.querySelector('[data-el="actionbar"]').getBoundingClientRect();
  const top = document.querySelector('.zr-topbar').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { aboveBar: Math.round(bar.top - r.bottom), belowTopbar: Math.round(r.top - top.bottom) };
})`;

/** In the page: what the save bar, the topic list and the leave warning say. */
const UNSAVED = String.raw`const unsaved = () => {
  const bar = document.querySelector('[data-el="actionbar"]');
  const leave = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leave);
  return {
    bar: bar.hidden ? null : document.querySelector('[data-el="changes"]').textContent,
    topics: [...document.querySelectorAll('[data-entry-dirty]:not(.hidden)')].map((dot) => dot.dataset.entryDirty),
    warnsOnLeave: leave.defaultPrevented,
  };
};
const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  return check();
};
const confirmDialog = async () => {
  await until(() => document.querySelector('dialog.zr-dialog:not([id])[open]'));
  document.querySelector('dialog.zr-dialog:not([id])[open] button[value="ok"]')?.click();
  await until(() => !document.querySelector('dialog.zr-dialog:not([id])[open]'));
  await new Promise((r) => setTimeout(r, 50));
};
const discard = async () => {
  document.querySelector('[data-el="reset"]').click();
  await confirmDialog();
};`;

/**
 * Runs in the page: Ask a server, typed into and detected (the answer is
 * the page's own fetch, stubbed), then Apply, then Discard.
 */
const ASK_A_SERVER = String.raw`(async () => {
  ${UNSAVED}
  const realFetch = window.fetch;
  window.fetch = (url, init) =>
    String(url).includes('/api/settings/quickstart/detect')
      ? Promise.resolve(new Response(JSON.stringify({
          success: true,
          message: 'Detected.',
          detection: {
            aiProvider: 'custom',
            ocrProvider: 'custom',
            resolvedAiApiUrl: 'http://lmstudio.test:1234/v1',
            resolvedOcrApiUrl: 'http://lmstudio.test:1234/v1',
            textModels: ['qwen3-8b', 'gemma-3-12b'],
            suggestedAiModel: 'qwen3-8b',
            suggestedOcrModel: 'gemma-3-12b',
          },
        }), { headers: { 'Content-Type': 'application/json' } }))
      : realFetch(url, init);
  const edit = (id, value) => {
    const field = document.getElementById(id);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const real = () => ({
    provider: document.getElementById('aiProvider').value,
    url: document.getElementById('customBaseUrl').value,
    key: document.getElementById('customApiKey').value,
    model: document.getElementById('customModel').value,
    ollamaModel: document.getElementById('ollamaModel').value,
    ocr: document.getElementById('mistralOcrEnabled').value,
    ocrSwitch: document.querySelector('[data-switch-target="mistralOcrEnabled"]').checked,
    ocrUrl: document.getElementById('ocrApiUrl').value,
    ocrModel: document.getElementById('mistralOcrModel').value,
  });
  const quickStart = () => document.querySelector('[data-entry="quick-start"]').textContent;
  const seen = { loaded: real() };
  edit('settingsQuickstartUrl', 'http://lmstudio.test:1234');
  edit('settingsQuickstartApiKey', 'lm-key');
  document.getElementById('settingsQuickstartDetectBtn').click();
  await until(() => !document.getElementById('settingsQuickstartResults').classList.contains('hidden'));
  edit('settingsQuickstartAiModel', 'gemma-3-12b');
  edit('settingsQuickstartOcrModel', 'qwen3-8b');
  document.getElementById('settingsQuickstartEnableOcr').click();
  document.getElementById('settingsQuickstartEnableOcr').click();
  seen.typed = unsaved();
  seen.quickStartBefore = quickStart().includes('gemma-3-12b');
  document.getElementById('settingsQuickstartApplyBtn').click();
  await new Promise((r) => setTimeout(r, 100));
  seen.applied = unsaved();
  seen.written = real();
  seen.quickStartAfter = quickStart().includes('gemma-3-12b');
  await discard();
  seen.discarded = unsaved();
  seen.restored = real();
  return seen;
})()`;

/**
 * Runs in the page: the list of custom fields through add, remove and
 * Discard; what it shows and what #customFieldsJson posts.
 */
const CUSTOM_FIELDS_DISCARD = String.raw`(async () => {
  ${UNSAVED}
  const json = document.getElementById('customFieldsJson');
  const look = () => ({
    rows: [...document.querySelectorAll('#customFieldsList .custom-field-item')].map((row) =>
      row.querySelector('[data-field-name]').textContent.trim() + ' / ' + row.querySelector('[data-field-type]').textContent.trim()),
    posts: JSON.parse(json.value).custom_fields.map((field) => field.value),
    bar: unsaved().bar,
  });
  const add = (name) => {
    document.getElementById('newFieldName').value = name;
    document.querySelector('.customfield-add button').click();
  };
  const remove = async (name) => {
    const row = [...document.querySelectorAll('#customFieldsList .custom-field-item')]
      .find((item) => item.querySelector('[data-field-name]').textContent.trim() === name);
    row.querySelector('button').click();
    await confirmDialog();
  };
  const seen = { loaded: look() };
  add('Due date');
  seen.added = look();
  await discard();
  seen.addDiscarded = look();
  add('Notes');
  seen.nextAdd = look();
  await discard();
  await remove('Amount');
  seen.removed = look();
  await discard();
  seen.removeDiscarded = look();
  await remove('Invoice number');
  seen.nextRemove = look();
  return seen;
})()`;

(async () => {
  const { mountRouter } = require('./helpers/mount-router');
  const harness = await mountRouter({
    user: { username: 'admin' },
    env: {
      PAPERLESS_API_URL: 'http://paperless.test:8000/api',
      PAPERLESS_API_TOKEN: 'token',
      AI_PROVIDER: 'ollama',
      OLLAMA_API_URL: 'http://ollama.test:11434',
      OLLAMA_MODEL: 'qwen3:8b',
      MISTRAL_OCR_ENABLED: 'yes',
      OCR_PROVIDER: 'custom',
      OCR_AUTO_PROCESS_ENABLED: 'yes',
      EXTERNAL_API_ENABLED: 'yes',
      PROCESS_PREDEFINED_DOCUMENTS: 'yes',
      TAGS: 'inbox,scan',
      REMOVE_TAGS_AFTER_PROCESSING: 'needs-ocr',
    },
  });
  const express = require(
    path.join(__dirname, '..', 'node_modules', 'express')
  );
  harness.app.use(express.static(path.join(__dirname, '..', 'public')));
  const browser = await launchChrome();
  // The "What's new" dialog of a fresh install would hold the focus.
  await browser.beforeEachPage(`(() => {
    const show = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      if (this.id === 'changelogModal') return undefined;
      return show.call(this);
    };
  })();`);
  const url = (hash) => `${harness.base}/settings#${hash}`;

  try {
    const sizes = [
      { width: 375, height: 760, mobile: true },
      { width: 1024, height: 768 },
      { width: 1477, height: 900 },
      { width: 2560, height: 1200 },
    ];
    const topics = ['ai-behavior', 'ocr', 'sso', 'caching', 'external-data'];
    for (const size of sizes) {
      await browser.viewport(size.width, size.height, { mobile: size.mobile });
      for (const topic of topics) {
        await browser.goto(url(topic));
        const m = await browser.evaluate(PROBE);
        await test(`${size.width}px, ${topic}: the bar never lies over the topic`, () => {
          assert.strictEqual(m.barHiddenAtLoad, true, 'no bar without changes');
          assert.strictEqual(m.barShown, true, 'a change shows the bar');
          assert.ok(
            Math.abs(m.regionEndsAtBar) <= 1,
            `region ends ${m.regionEndsAtBar}px off the bar`
          );
          if (size.mobile) {
            assert.ok(
              Math.abs(m.barOnTabbar) <= 1,
              `bar ends ${m.barOnTabbar}px off the tab bar`
            );
          }
          assert.ok(
            Math.abs(m.barStart) <= 1,
            `the bar's content starts ${m.barStart}px off the block`
          );
          if (m.columnFull) {
            assert.ok(
              Math.abs(m.barEnd) <= 1,
              `the bar's content ends ${m.barEnd}px off the block`
            );
          }
          assert.strictEqual(m.overlaps, 0, 'controls under the bar');
          assert.ok(
            m.lastRowGap >= 0,
            `last row ${-m.lastRowGap}px out of view`
          );
          assert.ok(
            m.focus.aboveBar >= 0 && m.focus.belowTopbar >= 0,
            `focused field ${JSON.stringify(m.focus)}`
          );
          if (m.hash) {
            assert.ok(
              m.hash.aboveBar >= 0 && m.hash.belowTopbar >= 0,
              `hash target ${JSON.stringify(m.hash)}`
            );
          }
          assert.strictEqual(m.barGone, true, 'undone, the bar goes');
          if (m.exitMoved !== undefined) {
            assert.strictEqual(
              m.exitMoved,
              0,
              `the row moved ${m.exitMoved}px when the bar went`
            );
          }
          assert.strictEqual(m.windowScrolls, false, 'the window scrolls');
        });
      }

      await browser.goto(url('caching'));
      const refused = await browser.evaluate(`(async () => {
        const field = document.getElementById('tagCacheTTL');
        field.value = '5';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-el="scroller"]').scrollTop = 0;
        document.getElementById('setupForm').requestSubmit();
        await new Promise((r) => setTimeout(r, 300));
        return { focused: document.activeElement === field, ...(${BETWEEN_BARS})(field) };
      })()`);
      await test(`${size.width}px: a refused field rests between the bars`, () => {
        assert.ok(refused.focused, 'the browser points at the field');
        assert.ok(
          refused.aboveBar >= 0 && refused.belowTopbar >= 0,
          JSON.stringify(refused)
        );
      });
    }

    await browser.viewport(1280, 720);
    await browser.goto(url('ai-behavior'));
    const found = await browser.evaluate(`(async () => {
      document.getElementById('activateTagging').click();
      const search = document.getElementById('settingsSearch');
      search.value = 'pdf passwords';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      document.querySelector('[data-entry-link="ocr"]').click();
      await new Promise((r) => setTimeout(r, 400));
      const mark = document.querySelector('.zr-settings-entry:not(.hidden) .zr-settings-match');
      return (${BETWEEN_BARS})(mark);
    })()`);
    await test('a "Find a setting" match rests between the bars', () => {
      assert.ok(
        found.aboveBar >= 0 && found.belowTopbar >= 0,
        JSON.stringify(found)
      );
    });

    for (const topic of ['ai-behavior', 'runtime', 'account']) {
      await browser.goto(url(topic));
      // The whole card of the topic list, not only the list inside it.
      const list = await browser.evaluate(`(() => {
        const card = document.querySelector('[data-el="nav"]').closest('.zr-module').getBoundingClientRect();
        return { bottom: Math.round(card.bottom), height: innerHeight };
      })()`);
      await test(`the topic list fits a window 720px high (${topic} open)`, () => {
        assert.ok(list.bottom <= list.height, `ends at ${list.bottom}px`);
      });
    }

    // Two cards and nothing outside them: the topic list on the left (on a
    // phone above), the open topic in one card on the right.
    for (const size of [
      { width: 1477, height: 900 },
      { width: 375, height: 760, mobile: true },
    ]) {
      await browser.viewport(size.width, size.height, { mobile: size.mobile });
      for (const topic of [
        'quick-start',
        'ai-provider',
        'ai-behavior',
        'ocr',
        'set-by-environment',
        'changelog',
        'sso',
        'account',
        'api-key',
      ]) {
        await browser.goto(url(topic));
        const seen = await browser.evaluate(ONE_CARD);
        await test(`${size.width}px, ${topic}: the topic is one card, nothing outside it`, () => {
          assert.strictEqual(seen.cards, 1, `${seen.cards} cards`);
          assert.strictEqual(seen.allCards, 2, 'the topic list and the topic');
          assert.deepStrictEqual(seen.texts, [], 'text outside the card');
          assert.deepStrictEqual(seen.boxes, [], 'boxes outside the card');
          if (size.mobile) assert.ok(seen.below, 'the topic under the list');
          else assert.ok(seen.sideBySide, 'list and topic side by side');
        });
      }
    }

    await browser.viewport(1280, 720);
    await browser.goto(url('ai-behavior'));
    const named = await browser.evaluate(`(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const say = () => document.querySelector('[data-el="status"]').textContent + ' | ' + document.querySelector('[data-el="changes"]').textContent;
      const said = [];
      const input = document.getElementById('removeTagInput');
      input.value = 'archive';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await frame();
      said.push(say());
      document.getElementById('removeTagAddButton').click();
      await frame();
      said.push(say());
      location.hash = '#quick-start';
      await new Promise((r) => setTimeout(r, 200));
      document.getElementById('quickStartFillToggle').click();
      document.getElementById('quickStartActivateTitle').click();
      await frame();
      said.push(say());
      return said;
    })()`);
    await test('a list of pills and a Quick start mirror are named once', () => {
      assert.deepStrictEqual(named, [
        '1 unsaved change | Also remove these tags',
        '1 unsaved change | Also remove these tags',
        '2 unsaved changes | Title, Also remove these tags',
      ]);
    });

    // From here on the fields Apply writes and the custom fields are stored
    // settings, not ones the environment sets (the harness pins what it
    // started with), so the page lets them be edited.
    const snapshot = global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__;
    [
      'AI_PROVIDER',
      'OLLAMA_API_URL',
      'OLLAMA_MODEL',
      'MISTRAL_OCR_ENABLED',
      'OCR_PROVIDER',
    ].forEach((key) => delete snapshot[key]);
    process.env.MISTRAL_OCR_ENABLED = 'no';
    process.env.CUSTOM_FIELDS = JSON.stringify({
      custom_fields: [
        { value: 'Invoice number', data_type: 'string' },
        { value: 'Amount', data_type: 'monetary', currency: 'EUR' },
      ],
    });

    await browser.goto(url('quickstart'));
    const asked = await browser.evaluate(ASK_A_SERVER);
    await test('Ask a server: typing, detecting and choosing are no unsaved change', () => {
      assert.deepStrictEqual(asked.typed, {
        bar: null,
        topics: [],
        warnsOnLeave: false,
      });
      assert.ok(!asked.quickStartBefore, 'nothing is applied yet');
    });
    await test('Ask a server: Apply writes the real fields and the bar names them', () => {
      assert.deepStrictEqual(asked.written, {
        provider: 'custom',
        url: 'http://lmstudio.test:1234/v1',
        key: 'lm-key',
        model: 'gemma-3-12b',
        ollamaModel: asked.loaded.ollamaModel,
        ocr: 'yes',
        ocrSwitch: true,
        ocrUrl: 'http://lmstudio.test:1234/v1',
        ocrModel: 'qwen3-8b',
      });
      assert.deepStrictEqual(asked.applied, {
        bar: 'AI provider, Server address, API key, Model, Use OCR, Server address (optional), OCR API key, OCR model',
        topics: ['ai-provider', 'ocr'],
        warnsOnLeave: true,
      });
      assert.ok(asked.quickStartAfter, 'Quick start names the applied model');
    });
    await test('Ask a server: Discard after Apply puts every field back', () => {
      assert.deepStrictEqual(asked.discarded, {
        bar: null,
        topics: [],
        warnsOnLeave: false,
      });
      assert.deepStrictEqual(asked.restored, asked.loaded);
    });

    await browser.goto(url('custom-fields'));
    const listed = await browser.evaluate(CUSTOM_FIELDS_DISCARD);
    await test('custom fields: Discard brings the list back to what posts', () => {
      const both = [
        'Invoice number / Type: string',
        'Amount / Type: monetary (EUR)',
      ];
      assert.deepStrictEqual(listed.loaded, {
        rows: both,
        posts: ['Invoice number', 'Amount'],
        bar: null,
      });
      assert.deepStrictEqual(listed.added.posts, [
        'Invoice number',
        'Amount',
        'Due date',
      ]);
      assert.strictEqual(listed.added.bar, 'Custom fields');
      assert.deepStrictEqual(
        listed.addDiscarded,
        listed.loaded,
        'an added field goes'
      );
      assert.deepStrictEqual(
        listed.nextAdd.posts,
        ['Invoice number', 'Amount', 'Notes'],
        'the next edit starts from the restored list'
      );
      assert.deepStrictEqual(listed.removed.rows, [both[0]]);
      assert.deepStrictEqual(
        listed.removeDiscarded,
        listed.loaded,
        'a removed field comes back'
      );
      assert.deepStrictEqual(listed.nextRemove, {
        rows: [both[1]],
        posts: ['Amount'],
        bar: 'Custom fields',
      });
    });
  } finally {
    await browser.close();
    await harness.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
