'use strict';

/**
 * The AI sections of the settings page: a basic view that only asks for what
 * makes a provider work, and "Advanced options" that explain every knob.
 *
 * What is pinned here, for each provider the page offers:
 *
 * - The AI provider section shows, for the chosen provider, exactly its
 *   connection fields from PROVIDERS in services/aiProviderRules.js, and no
 *   advanced option outside a disclosure.
 * - Every advanced option from AI_OPTIONS is rendered inside a closed
 *   disclosure, with its label, its help as the hint and its default as the
 *   placeholder, and carries the providers it applies to in data-providers.
 *   An option that does not apply to the selected provider is rendered
 *   hidden; public/js/settings.js toggles the same attribute on a switch.
 * - The Duplicates section follows the same split.
 * - No hint in the four AI sections warns about a restart.
 * - The Ollama thinking switch round-trips through POST /settings into the
 *   literal 'true'/'false' config.js checks.
 * - Every control the catalogue drives is in the fieldMappings list, which is
 *   what marks a field with its environment key.
 * - The settings-advanced module remembers the open state in localStorage
 *   and survives a storage that throws.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mountRouter } = require('./helpers/mount-router');
const rules = require('../services/aiProviderRules');

const API_KEY = 'test-api-key';

// server.js sets these on res.locals for every page; the harness does not run
// server.js, so the shell partials would throw on the first missing one.
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

// A configured instance: every provider has its connection values, so the
// page is looked at with values rather than as an empty form.
const START_ENV = {
  OLLAMA_API_URL: 'http://ollama.lan:11434',
  OLLAMA_MODEL: 'qwen3:8b',
  CUSTOM_BASE_URL: 'http://llm.lan:8080/v1',
  CUSTOM_API_KEY: 'test-custom-key',
  CUSTOM_MODEL: 'mistral-small',
  AZURE_ENDPOINT: 'https://example.openai.azure.com',
  AZURE_API_KEY: 'test-azure-key',
  AZURE_DEPLOYMENT_NAME: 'gpt-4o-prod',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  TOKEN_LIMIT: '64000',
  RESPONSE_TOKENS: '1500',
};

// The input each connection key is typed into, and the block that holds a
// provider's connection fields.
const CONNECTION_INPUTS = {
  OPENAI_API_KEY: 'openaiKey',
  OPENAI_MODEL: 'openaiModel',
  ANTHROPIC_API_KEY: 'anthropicApiKey',
  ANTHROPIC_MODEL: 'anthropicModel',
  OLLAMA_API_URL: 'ollamaUrl',
  OLLAMA_MODEL: 'ollamaModel',
  CUSTOM_BASE_URL: 'customBaseUrl',
  CUSTOM_API_KEY: 'customApiKey',
  CUSTOM_MODEL: 'customModel',
  AZURE_ENDPOINT: 'azureEndpoint',
  AZURE_API_KEY: 'azureApiKey',
  AZURE_DEPLOYMENT_NAME: 'azureDeploymentName',
};
const BLOCK_IDS = rules.PROVIDER_IDS.map((id) => `${id}Settings`);

const SECTIONS = ['ai-provider', 'ai-behavior', 'duplicates', 'simplify'];
const NEXT_ENTRY = {
  'ai-provider': 'ai-behavior',
  'ai-behavior': 'restrictions',
  duplicates: 'simplify',
  simplify: 'account',
};

let passed = 0;
let failed = 0;

// A successful POST /settings schedules process.exit(0) five seconds later.
const realExit = process.exit.bind(process);
process.exit = () => {};

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

function finish() {
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit = realExit;
  realExit(failed > 0 ? 1 : 0);
}

function sliceBetween(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start !== -1, `Could not find ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `Could not delimit the block starting at ${from}`);
  return source.slice(start, end);
}

/** The same escaping the view applies to attribute and hint text. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** [start, end) of every advanced disclosure on the page. */
function disclosureRanges(html) {
  const ranges = [];
  const pattern = /<details class="zr-module zr-settings-advanced"[^>]*>/g;
  let match;
  while ((match = pattern.exec(html))) {
    const end = html.indexOf('</details>', match.index);
    ranges.push({ start: match.index, end, tag: match[0] });
  }
  return ranges;
}

/** The option row of `key`: its class list, providers and markup. */
function optionRow(html, key) {
  const pattern = new RegExp(
    `<div class="zr-settings-option([^"]*)" data-ai-option="${key}" data-level="([a-z]+)" data-providers="([^"]*)">`
  );
  const match = html.match(pattern);
  if (!match) return null;
  const nextRow = html.indexOf(
    '<div class="zr-settings-option',
    match.index + 1
  );
  const sectionEnd = html.indexOf('</section>', match.index);
  const end = nextRow === -1 ? sectionEnd : Math.min(nextRow, sectionEnd);
  return {
    index: match.index,
    hidden: match[1].includes('hidden'),
    level: match[2],
    providers: match[3].split(',').filter(Boolean),
    markup: html.slice(match.index, end),
  };
}

(async () => {
  const harness = await mountRouter({ env: START_ENV });
  Object.assign(harness.app.locals, SHELL_LOCALS);

  const getSettingsPage = async (provider) => {
    process.env.AI_PROVIDER = provider;
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
    for (const provider of rules.PROVIDERS) {
      await test(`${provider.id}: the basic view shows its connection fields and nothing else`, async () => {
        const html = await getSettingsPage(provider.id);
        const entry = sliceBetween(
          html,
          'id="entry-ai-provider"',
          'id="entry-ai-behavior"'
        );
        const basic = entry.slice(
          0,
          entry.indexOf('id="sec-provider-advanced"')
        );

        const blockId = `${provider.id}Settings`;
        const blockStart = basic.indexOf(`id="${blockId}"`);
        assert.ok(blockStart !== -1, `${blockId} is rendered`);
        const blockEnd = Math.min(
          ...BLOCK_IDS.filter((id) => id !== blockId)
            .map((id) => basic.indexOf(`id="${id}"`, blockStart))
            .concat(basic.indexOf('</section>', blockStart))
            .filter((index) => index > blockStart)
        );
        const block = basic.slice(blockStart, blockEnd);
        assert.ok(
          !block.slice(0, 80).includes('hidden'),
          `${blockId} is shown for ${provider.id}`
        );

        provider.connection.forEach((key) => {
          assert.ok(
            block.includes(`name="${CONNECTION_INPUTS[key]}"`),
            `${key} (${CONNECTION_INPUTS[key]}) is in the basic view`
          );
        });
        assert.strictEqual(
          (block.match(/ name="/g) || []).length,
          provider.connection.length,
          `${blockId} holds exactly the connection fields of ${provider.id}`
        );

        rules
          .optionsFor(provider.id, 'advanced', 'provider')
          .forEach((option) => {
            assert.ok(
              !basic.includes(`data-ai-option="${option.key}"`),
              `${option.key} is not part of the basic view`
            );
          });
      });

      await test(`${provider.id}: every advanced option sits in a closed disclosure and explains itself`, async () => {
        const html = await getSettingsPage(provider.id);
        const ranges = disclosureRanges(html);
        assert.ok(
          ranges.length >= 2,
          'the AI provider and Duplicates disclosures exist'
        );
        ranges.forEach(({ tag }) => {
          assert.ok(!/\sopen[\s>=]/.test(tag), `rendered closed: ${tag}`);
          assert.ok(tag.includes('data-module="settings-advanced"'), tag);
          assert.ok(tag.includes('data-advanced'), tag);
        });
        const inDisclosure = (index) =>
          ranges.some(({ start, end }) => index > start && index < end);

        // No advanced row anywhere on the page outside a disclosure.
        const advancedRows = [...html.matchAll(/data-level="advanced"/g)];
        assert.ok(advancedRows.length > 0);
        advancedRows.forEach((match) => {
          assert.ok(
            inDisclosure(match.index),
            'an advanced option outside a disclosure'
          );
        });

        rules.AI_OPTIONS.forEach((option) => {
          const row = optionRow(html, option.key);
          assert.ok(row, `${option.key} is rendered from the catalogue`);
          assert.strictEqual(row.level, option.level, `${option.key}: level`);
          assert.strictEqual(
            inDisclosure(row.index),
            option.level === 'advanced',
            `${option.key}: inside a disclosure exactly when it is advanced`
          );
          const expectedProviders = option.providers || rules.PROVIDER_IDS;
          assert.deepStrictEqual(
            [...row.providers].sort(),
            [...expectedProviders].sort(),
            `${option.key}: data-providers`
          );
          assert.strictEqual(
            row.hidden,
            !expectedProviders.includes(provider.id),
            `${option.key}: hidden exactly when ${provider.id} is not among its providers`
          );
          assert.ok(
            row.markup.includes(esc(option.label)),
            `${option.key}: label`
          );
          assert.ok(
            row.markup.includes(
              `<p class="zr-field__hint">${esc(option.help)}`
            ),
            `${option.key}: the help is the hint`
          );
          const isSwitch = row.markup.includes('data-switch-target=');
          const isSelect = row.markup.includes('<select');
          const isSecret = row.markup.includes('type="password"');
          if (!isSwitch && !isSelect && !isSecret && option.defaultValue) {
            assert.ok(
              row.markup.includes(`placeholder="${esc(option.defaultValue)}"`),
              `${option.key}: the default is the placeholder`
            );
          }
        });
      });
    }

    await test('the page shows the stored values, not an empty form', async () => {
      const html = await getSettingsPage('ollama');
      assert.ok(html.includes('value="http://ollama.lan:11434"'));
      assert.ok(html.includes('<option value="qwen3:8b" selected>'));
      assert.ok(
        optionRow(html, 'TOKEN_LIMIT').markup.includes('value="64000"')
      );
      assert.ok(
        optionRow(html, 'RESPONSE_TOKENS').markup.includes('value="1500"')
      );
    });

    await test('the Duplicates section keeps its three basic settings outside the disclosure', async () => {
      const html = await getSettingsPage('openai');
      const section = sliceBetween(
        html,
        'id="entry-duplicates"',
        'id="entry-simplify"'
      );
      const advancedStart = section.indexOf('id="sec-duplicates-advanced"');
      assert.ok(
        advancedStart !== -1,
        'the Duplicates section has advanced options'
      );
      [
        'duplicatesAiReview',
        'duplicatesGuardNewNames',
        'duplicatesAiModel',
      ].forEach((id) => {
        const index = section.indexOf(`id="${id}"`);
        assert.ok(
          index !== -1 && index < advancedStart,
          `${id} is in the basic view`
        );
      });
      rules.optionsFor('openai', 'advanced', 'duplicates').forEach((option) => {
        assert.ok(
          section.indexOf(`data-ai-option="${option.key}"`) > advancedStart,
          `${option.key} is under Advanced options`
        );
      });
      const simplify = sliceBetween(
        html,
        'id="entry-simplify"',
        'id="entry-account"'
      );
      assert.ok(
        !simplify.includes('<details'),
        'Simplify has nothing to tuck away'
      );
      ['simplifyTagsPerRequest', 'simplifyVocabularySize'].forEach((id) => {
        assert.ok(simplify.includes(`name="${id}"`), `${id} stays in Simplify`);
      });
    });

    await test('no hint in the four AI sections says "Restart required"', async () => {
      for (const provider of rules.PROVIDER_IDS) {
        const html = await getSettingsPage(provider);
        SECTIONS.forEach((id) => {
          const entry = sliceBetween(
            html,
            `id="entry-${id}"`,
            `id="entry-${NEXT_ENTRY[id]}"`
          );
          assert.ok(
            !/restart required/i.test(entry),
            `${id} (${provider}) still warns about a restart`
          );
        });
      }
    });

    await test('the Claude options carry no temperature', async () => {
      const keys = rules.optionsFor('anthropic').map((option) => option.key);
      assert.ok(!keys.includes('AI_TEMPERATURE_ANALYSIS'));
      assert.ok(!keys.includes('AI_TEMPERATURE_GENERATION'));
      assert.ok(!keys.includes('RESPONSE_TOKENS'));
      assert.ok(keys.includes('ANTHROPIC_EFFORT'));
    });

    await test('the Ollama thinking switch is a settings-switch shown only for Ollama', async () => {
      const ollama = optionRow(await getSettingsPage('ollama'), 'OLLAMA_THINK');
      assert.ok(!ollama.hidden);
      assert.deepStrictEqual(ollama.providers, ['ollama']);
      assert.ok(ollama.markup.includes('data-switch-target="ollamaThink"'));
      assert.ok(
        ollama.markup.includes(
          '<input type="hidden" id="ollamaThink" name="ollamaThink" value="no">'
        )
      );
      assert.ok(ollama.markup.includes('Default: off.'));
      assert.ok(
        optionRow(await getSettingsPage('openai'), 'OLLAMA_THINK').hidden
      );
    });

    await test('OLLAMA_THINK round-trips through POST /settings', async () => {
      const base = {
        aiProvider: 'ollama',
        ollamaUrl: 'http://ollama.lan:11434',
        ollamaModel: 'qwen3:8b',
      };

      let response = await postSettings({ ...base, ollamaThink: 'yes' });
      assert.strictEqual(response.status, 200, await response.text());
      assert.strictEqual(
        process.env.OLLAMA_THINK,
        'true',
        'on is stored as the literal true'
      );
      const on = optionRow(await getSettingsPage('ollama'), 'OLLAMA_THINK');
      assert.ok(
        on.markup.includes('data-switch-target="ollamaThink" checked'),
        'the stored value shows'
      );
      assert.ok(on.markup.includes('name="ollamaThink" value="yes"'));

      response = await postSettings({ ...base, ollamaThink: 'no' });
      assert.strictEqual(response.status, 200, await response.text());
      assert.strictEqual(
        process.env.OLLAMA_THINK,
        'false',
        'off is stored as the literal false'
      );
      const off = optionRow(await getSettingsPage('ollama'), 'OLLAMA_THINK');
      assert.ok(
        !off.markup.includes('data-switch-target="ollamaThink" checked')
      );

      const before = process.env.OLLAMA_THINK;
      response = await postSettings(base);
      assert.strictEqual(response.status, 200, await response.text());
      assert.strictEqual(
        process.env.OLLAMA_THINK,
        before,
        'a form without the field keeps the value'
      );
    });

    await test('every control the catalogue drives is marked with its environment key', async () => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'js', 'settings.js'),
        'utf8'
      );
      const html = await getSettingsPage('openai');
      rules.AI_OPTIONS.forEach((option) => {
        const row = optionRow(html, option.key);
        const id = (row.markup.match(/ name="([A-Za-z]+)"/) || [])[1];
        assert.ok(id, `${option.key}: a named control`);
        assert.ok(
          new RegExp(
            `selector:\\s*'#${id}',\\s*envKey:\\s*'${option.key}'`
          ).test(source),
          `#${id} must be paired with ${option.key} in fieldMappings`
        );
      });
    });

    await test('settings-advanced remembers the choice and survives a storage that throws', async () => {
      const mod = await import(
        path.join(
          __dirname,
          '..',
          'public',
          'js',
          'modules',
          'settings-advanced.js'
        )
      );
      assert.strictEqual(mod.STORAGE_KEY, 'zr.settings.advanced');
      const store = new Map();
      const storage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
      };
      assert.strictEqual(
        mod.readPreference(storage),
        false,
        'closed until asked'
      );
      mod.writePreference(storage, true);
      assert.strictEqual(store.get('zr.settings.advanced'), '1');
      assert.strictEqual(mod.readPreference(storage), true);
      mod.writePreference(storage, false);
      assert.strictEqual(store.get('zr.settings.advanced'), '0');
      const broken = {
        getItem() {
          throw new Error('denied');
        },
        setItem() {
          throw new Error('denied');
        },
      };
      assert.strictEqual(mod.readPreference(broken), false);
      assert.doesNotThrow(() => mod.writePreference(broken, true));
      assert.strictEqual(mod.readPreference(null), false);
    });
  } finally {
    await harness.close();
  }
  finish();
})().catch((error) => {
  console.error(error);
  process.exit = realExit;
  realExit(1);
});
