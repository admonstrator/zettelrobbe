'use strict';

/**
 * The two "done" settings on the settings page.
 *
 * REMOVE_INBOX_TAGS_AFTER_PROCESSING and REMOVE_TAGS_AFTER_PROCESSING sit in
 * the Tag Filters section under Ignore Tags. This test holds the path
 * together through the real router: the rendered fields with the configured
 * values, the POST that stores them, the lock an injected value puts on them,
 * the .env export group, the wiring in public/js/settings.js, and that
 * neither key asks for a restart. It also holds the lock of a chip field:
 * with IGNORE_TAGS (and REMOVE_TAGS_AFTER_PROCESSING) injected, the input,
 * its Add button and the remove control of every chip are disabled, while a
 * chip field the environment does not pin stays editable.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readRouteSources } = require('./helpers/route-sources');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

const API_KEY = 'test-api-key';

// server.js sets these on res.locals for every page; the harness does not
// run server.js, so the shell partials would throw on the first missing one.
const SHELL_LOCALS = {
  theme: 'light',
  csrfToken: 'test-csrf',
  appVersion: 'test',
  appCommitSha: 'test',
  appPaperlessNgxVersion: 'test',
  appNodeVersion: 'test',
  appPlatform: 'test',
  appNodeEnv: 'test',
  appAiProvider: 'openai',
  appOcrProvider: 'mistral',
  appServerTimeUtc: 'test',
  appServerTimezone: 'test',
  appPaperlessApiUrl: 'test',
  appOllamaApiUrl: 'test',
  appOllamaModel: 'test',
  appCustomBaseUrl: 'test',
  appCustomModel: 'test',
  appAzureEndpoint: 'test',
  appAzureDeploymentName: 'test',
  appAzureApiVersion: 'test',
  appMistralOcrModel: 'test',
  appScanInterval: 'test',
  appTokenLimit: 'test',
  appResponseTokens: 'test',
  appTrustProxy: 'test',
  appUseExistingData: 'no',
  appRestrictTags: 'no',
  appRestrictCorrespondents: 'no',
  appRestrictDocumentTypes: 'no',
  appDateFormat: 'DD.MM.YYYY',
  appOcrEnabled: false,
  appPaperlessTokenSet: false,
  appOpenAiKeySet: false,
  appCustomKeySet: false,
  appAzureKeySet: false,
  appMistralKeySet: false,
  appApiKeySet: false,
};

let passed = 0;
let failed = 0;

// A browser is available in development containers, not in CI. The chip lock
// is a client-side step, so it is looked at in a real page when one can be had.
function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

// A successful POST /settings may schedule process.exit().
const realExit = process.exit.bind(process);
const exitCalls = [];
process.exit = (code) => {
  exitCalls.push(code);
};

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

function sliceBetween(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start !== -1, `Could not find ${from}`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `Could not delimit the block starting at ${from}`);
  return source.slice(start, end);
}

(async () => {
  const savedConfigs = [];
  const harness = await mountRouter({
    env: {
      REMOVE_INBOX_TAGS_AFTER_PROCESSING: 'yes',
      REMOVE_TAGS_AFTER_PROCESSING: 'todo,Scan',
      IGNORE_TAGS: 'pinned-one,pinned-two',
    },
    stub: ({ setupService }) => {
      setupService.saveConfig = async (config) => {
        savedConfigs.push(config);
        Object.entries(config).forEach(([key, value]) => {
          process.env[key] = Array.isArray(value)
            ? value.join(',')
            : String(value);
        });
      };
    },
  });
  Object.assign(harness.app.locals, SHELL_LOCALS);
  // The same module instance the router reads, so a save is seen here.
  const configFile = require('../config/config');

  const getSettingsPage = async () => {
    const response = await fetch(harness.base + '/settings', {
      redirect: 'manual',
      headers: { 'x-api-key': API_KEY },
    });
    assert.strictEqual(response.status, 200, 'GET /settings must render');
    return response.text();
  };

  const postSettings = (body) =>
    fetch(harness.base + '/settings', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    await test('both fields render under Ignore Tags with the configured values', async () => {
      const html = await getSettingsPage();
      const section = sliceBetween(html, 'id="sec-tag-filters"', '</section>');

      const ignoreAt = section.indexOf('id="ignoreTagInput"');
      const switchAt = section.indexOf(
        'data-switch-target="removeInboxTagsAfterProcessing"'
      );
      const listAt = section.indexOf('id="removeTagInput"');
      assert.ok(
        ignoreAt !== -1 && ignoreAt < switchAt && switchAt < listAt,
        'Ignore Tags, then the switch, then the list'
      );

      assert.ok(
        section.includes(
          'data-switch-target="removeInboxTagsAfterProcessing" checked'
        ),
        'the switch shows the configured value'
      );
      assert.ok(
        section.includes(
          '<input type="hidden" id="removeInboxTagsAfterProcessing" name="removeInboxTagsAfterProcessing" value="yes">'
        ),
        'the switch posts a yes/no value'
      );
      assert.match(
        section,
        /Remove the inbox tag when a document is done/,
        'the switch says what it does'
      );
      assert.match(
        section,
        /Paperless-ngx marks the tags it uses as inbox; every one of them is taken off a document once the analysis was written\. Use it when you let the analysis file documents on its own\./
      );

      const list = sliceBetween(
        section,
        'for="removeTagInput"',
        'id="removeTags"'
      );
      assert.match(list, /Also remove these tags/);
      assert.ok(list.includes('id="removeTagAddButton"'));
      assert.ok(list.includes('id="removeTagsContainer"'));
      assert.ok(
        list.includes('<span>todo</span>') &&
          list.includes('<span>Scan</span>'),
        'the configured tags render as chips'
      );
      assert.ok(
        section.includes(
          '<input type="hidden" id="removeTags" name="removeTags" value="todo,Scan">'
        ),
        'the hidden input carries the configured list'
      );
      assert.match(
        section,
        /Taken off a document after a successful analysis, whatever the analysis proposed\./
      );
    });

    await test('POST /settings stores both keys and the config reads them live', async () => {
      const response = await postSettings({
        removeInboxTagsAfterProcessing: 'no',
        removeTags: 'Inbox-Review, later',
      });
      const payload = await response.json();
      assert.strictEqual(response.status, 200, JSON.stringify(payload));
      const saved = savedConfigs[savedConfigs.length - 1];
      assert.strictEqual(saved.REMOVE_INBOX_TAGS_AFTER_PROCESSING, 'no');
      assert.deepStrictEqual(saved.REMOVE_TAGS_AFTER_PROCESSING, [
        'Inbox-Review',
        'later',
      ]);
      assert.ok(
        !(payload.restartKeys || []).some((key) => key.startsWith('REMOVE_')),
        'neither key asks for a restart'
      );
      assert.strictEqual(configFile.removeInboxTagsAfterProcessing, 'no');
      assert.deepStrictEqual(configFile.removeTagsAfterProcessing, [
        'Inbox-Review',
        'later',
      ]);

      const html = await getSettingsPage();
      assert.ok(
        html.includes(
          '<input type="hidden" id="removeTags" name="removeTags" value="Inbox-Review,later">'
        ),
        'the page shows what was saved'
      );

      const back = await postSettings({
        removeInboxTagsAfterProcessing: 'yes',
      });
      assert.strictEqual(back.status, 200);
      assert.strictEqual(
        savedConfigs[savedConfigs.length - 1]
          .REMOVE_INBOX_TAGS_AFTER_PROCESSING,
        'yes'
      );
    });

    await test('an injected value locks the field; the export lists both keys', async () => {
      const html = await getSettingsPage();
      const match = html.match(/data-locked-env-keys="([^"]*)"/);
      assert.ok(match, 'the form carries the locked keys');
      const locked = JSON.parse(match[1].replace(/&#34;/g, '"'));
      [
        'REMOVE_INBOX_TAGS_AFTER_PROCESSING',
        'REMOVE_TAGS_AFTER_PROCESSING',
        'IGNORE_TAGS',
      ].forEach((key) =>
        assert.ok(
          locked.includes(key),
          `${key} came from the environment, so its field is locked`
        )
      );

      const setupSource = readRouteSources();
      const group = sliceBetween(
        setupSource,
        "title: 'Document processing'",
        ']'
      );
      [
        'IGNORE_TAGS',
        'REMOVE_INBOX_TAGS_AFTER_PROCESSING',
        'REMOVE_TAGS_AFTER_PROCESSING',
      ].forEach((key) =>
        assert.ok(group.includes(`'${key}'`), `${key} in the export group`)
      );
    });

    await test('settings.js wires the chip input and maps both fields to their keys', async () => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'js', 'settings.js'),
        'utf8'
      );
      assert.match(
        source,
        /new TagsManager\(\s*'removeTagInput',\s*'removeTagsContainer',\s*'removeTags',\s*'removeTagAddButton'\s*\)/
      );
      assert.match(
        source,
        /selector: '#removeInboxTagsAfterProcessing',\s*envKey: 'REMOVE_INBOX_TAGS_AFTER_PROCESSING'/
      );
      assert.match(
        source,
        /selector: '#removeTagInput', envKey: 'REMOVE_TAGS_AFTER_PROCESSING'/
      );
    });

    await test('the lock covers a chip field as a whole, not only its input', async () => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'js', 'settings.js'),
        'utf8'
      );
      const lock = sliceBetween(
        source,
        'function lockChipField(fieldElement)',
        '\n}\n'
      );
      assert.match(lock, /closest\('\.zr-field'\)/, 'walks to the field');
      assert.match(lock, /querySelectorAll\('button'\)/, 'every button in it');
      assert.match(lock, /\.disabled = true/);
      assert.match(lock, /dataset\.locked = 'true'/, 'marks the chip list');
      assert.ok(
        !/ignoreTag|removeTag|promptTag|tagAddButton/.test(lock),
        'no field ids are special-cased'
      );
      const pills = sliceBetween(
        source,
        'function initializeRuntimeOverridePills()',
        '\n}\n'
      );
      assert.match(pills, /lockChipField\(fieldElement\)/);

      const manager = sliceBetween(source, 'class TagsManager', '\n}\n');
      assert.match(manager, /dataset\?\.locked === 'true'/);
      assert.match(
        manager,
        /async addTag\(\) \{\s*if \(!this\.tagInput \|\| this\.tagInput\.disabled \|\| this\.isLocked\(\)\) return;/,
        'Enter in a locked input adds nothing'
      );
      assert.match(manager, /removeButton\.disabled = this\.isLocked\(\);/);

      const css = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'css', 'badges.css'),
        'utf8'
      );
      assert.match(
        css,
        /\.zr-chips\[data-locked\] \.zr-chip button \{\s*display: none;/
      );

      // Each chip field's Add button is addressable, and the managers use it.
      const html = await getSettingsPage();
      [
        ['tagInput', 'tagAddButton'],
        ['ignoreTagInput', 'ignoreTagAddButton'],
        ['removeTagInput', 'removeTagAddButton'],
        ['ignoreTitlePatternInput', 'ignoreTitlePatternAddButton'],
        ['promptTagInput', 'promptTagAddButton'],
      ].forEach(([input, button]) => {
        assert.ok(html.includes(`id="${button}"`), `${button} is rendered`);
        assert.match(
          source,
          new RegExp(`new TagsManager\\(\\s*'${input}',[^)]*'${button}'`),
          `${input} is wired to ${button}`
        );
      });
      [
        ["'#tagInput'", "'TAGS'"],
        ["'#ignoreTagInput'", "'IGNORE_TAGS'"],
        ["'#promptTagInput'", "'PROMPT_TAGS'"],
      ].forEach(([selector, key]) =>
        assert.ok(
          source.includes(`{ selector: ${selector}, envKey: ${key} }`),
          `${selector} maps to ${key}`
        )
      );
    });

    const playwright = loadPlaywright();
    if (!playwright) {
      console.log(
        'ℹ️  no browser available; the chip lock was checked in source only'
      );
    } else {
      await test('in a browser, a pinned chip field is read-only and an unpinned one is not', async () => {
        const express = require(
          path.join(REPO_ROOT, 'node_modules', 'express')
        );
        harness.app.use(express.static(path.join(REPO_ROOT, 'public')));
        const browser = await playwright.chromium.launch();
        try {
          const page = await browser.newPage({
            extraHTTPHeaders: { 'x-api-key': API_KEY },
          });
          await page.goto(harness.base + '/settings#tag-filters');
          await page.waitForFunction(
            () => document.getElementById('ignoreTagInput')?.disabled === true,
            null,
            { timeout: 10000 }
          );

          const fieldState = (inputId) =>
            page.evaluate((id) => {
              const input = document.getElementById(id);
              const field = input.closest('.zr-field');
              const chips = field.querySelector('.zr-chips');
              const add = field.querySelector('.zr-inputgroup button');
              const removes = [...chips.querySelectorAll('.zr-chip button')];
              return {
                inputDisabled: input.disabled,
                addDisabled: add.disabled,
                locked: chips.dataset.locked || null,
                chips: chips.querySelectorAll('.zr-chip').length,
                removes: removes.map((button) => ({
                  disabled: button.disabled,
                  display: getComputedStyle(button).display,
                })),
                hint: [...field.querySelectorAll('.zr-field__hint')]
                  .map((hint) => hint.textContent)
                  .join(' | '),
              };
            }, inputId);

          const pinned = await fieldState('ignoreTagInput');
          assert.strictEqual(pinned.inputDisabled, true);
          assert.strictEqual(pinned.addDisabled, true, 'Add is disabled');
          assert.strictEqual(pinned.locked, 'true');
          assert.strictEqual(pinned.chips, 2, 'the pinned tags stay visible');
          assert.ok(
            pinned.removes.every(
              (button) => button.disabled && button.display === 'none'
            ),
            `no usable remove control: ${JSON.stringify(pinned.removes)}`
          );
          assert.match(pinned.hint, /Set by the environment \(IGNORE_TAGS\)\./);

          // Enter in the locked input, and the remove controls, change nothing.
          await page.evaluate(() => {
            const input = document.getElementById('ignoreTagInput');
            input.value = 'sneaked-in';
            input.dispatchEvent(
              new KeyboardEvent('keypress', { key: 'Enter', bubbles: true })
            );
            document.getElementById('ignoreTagAddButton').click();
            document
              .querySelectorAll('#ignoreTagsContainer .zr-chip button')
              .forEach((button) => button.click());
          });
          await page.waitForTimeout(200);
          const after = await page.evaluate(() => ({
            chips: document.querySelectorAll('#ignoreTagsContainer .zr-chip')
              .length,
            hidden: document.getElementById('ignoreTags').value,
            dialog: Boolean(document.querySelector('dialog[open]')),
          }));
          assert.deepStrictEqual(after, {
            chips: 2,
            hidden: 'pinned-one,pinned-two',
            dialog: false,
          });

          // The other injected list is locked the same way, by the same code.
          const removeList = await fieldState('removeTagInput');
          assert.strictEqual(removeList.addDisabled, true);
          assert.strictEqual(removeList.locked, 'true');

          // A chip field nobody pinned keeps its input, Add and removes.
          // It sits in another section of the page, so it is driven directly.
          await page.evaluate(() => {
            document.getElementById('ignoreTitlePatternInput').value = 'Scan_';
            document.getElementById('ignoreTitlePatternAddButton').click();
          });
          const free = await fieldState('ignoreTitlePatternInput');
          assert.strictEqual(free.inputDisabled, false);
          assert.strictEqual(free.addDisabled, false);
          assert.strictEqual(free.locked, null);
          assert.ok(free.chips >= 1, 'Add added a chip');
          assert.ok(
            free.removes.length > 0 &&
              free.removes.every(
                (button) => !button.disabled && button.display !== 'none'
              ),
            `remove controls stay usable: ${JSON.stringify(free.removes)}`
          );

          if (process.env.CHIP_LOCK_SCREENSHOT) {
            await page.setViewportSize({ width: 1280, height: 900 });
            await page
              .locator('#ignoreTagInput')
              .evaluate((el) =>
                el.closest('.zr-card, section').scrollIntoView()
              );
            await page.screenshot({ path: process.env.CHIP_LOCK_SCREENSHOT });
          }
        } finally {
          await browser.close();
        }
      });
    }
  } finally {
    await harness.close();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit = realExit;
    realExit(failed > 0 ? 1 : 0);
  }
})().catch((error) => {
  console.error('[FATAL]', error);
  process.exit = realExit;
  realExit(1);
});
