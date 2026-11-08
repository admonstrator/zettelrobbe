'use strict';

/**
 * The two "done" settings on the settings page.
 *
 * REMOVE_INBOX_TAGS_AFTER_PROCESSING and REMOVE_TAGS_AFTER_PROCESSING sit in
 * the Tag Filters section under Ignore Tags. This test holds the path
 * together through the real router: the rendered fields with the configured
 * values, the POST that stores them, the lock an injected value puts on them,
 * the .env export group, the wiring in public/js/settings.js, and that
 * neither key asks for a restart.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mountRouter } = require('./helpers/mount-router');

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
      ].forEach((key) =>
        assert.ok(
          locked.includes(key),
          `${key} came from the environment, so its field is locked`
        )
      );

      const setupSource = fs.readFileSync(
        path.join(__dirname, '..', 'routes', 'setup.js'),
        'utf8'
      );
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
