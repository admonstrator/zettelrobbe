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
 * 7. the window itself never scrolls.
 * Also: a field the browser refuses, and a "Find a setting" match, rest
 * between the bars; a list of pills and a Quick start mirror are counted and
 * named once; with the group of the open topic open the topic list fits a
 * window 720px high.
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

const BETWEEN_BARS = String.raw`((el) => {
  const bar = document.querySelector('[data-el="actionbar"]').getBoundingClientRect();
  const top = document.querySelector('.zr-topbar').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { aboveBar: Math.round(bar.top - r.bottom), belowTopbar: Math.round(r.top - top.bottom) };
})`;

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
      const list = await browser.evaluate(`(() => {
        const nav = document.querySelector('[data-el="nav"]').getBoundingClientRect();
        return { bottom: Math.round(nav.bottom), height: innerHeight };
      })()`);
      await test(`the topic list fits a window 720px high (${topic} open)`, () => {
        assert.ok(list.bottom <= list.height, `ends at ${list.bottom}px`);
      });
    }

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
