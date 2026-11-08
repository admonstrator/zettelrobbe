'use strict';

/**
 * Saving the settings restarts the server only when it has to.
 *
 * Every save used to end in process.exit(0) and a restart overlay, and the
 * overlay reloaded the page as soon as /health answered healthy — which the
 * old process did for the five seconds before it exited, so the reload landed
 * on a server that was gone (HTTP 502). Now:
 *
 *   1. /health carries a boot id and a start time, stable for the process
 *   2. config values are read live, so a save applies without a restart
 *   3. a save that changes only live values answers restart: false and does
 *      not exit
 *   4. a save that changes a key the process reads once at boot answers
 *      restart: true, names the key and exits
 *   5. the page carries the keys the container pins, the restart keys and
 *      the boot id on #setupForm, and the client locks a pinned field quietly
 *   6. the page no longer explains environment variables
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');
const { RESTART_REQUIRED_KEYS } = require('../config/restartRequiredKeys');

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
  appAnthropicModel: 'test',
  appAnthropicApiUrl: 'default',
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
  appAnthropicKeySet: false,
  appMistralKeySet: false,
  appApiKeySet: false,
};

// Present at startup, so the container pins it (decision 1).
const PINNED_KEY = 'SCAN_INTERVAL';
const PINNED_VALUE = '5 4 * * *';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed++;
  }
}

const decodeAttribute = (value) =>
  value
    .replace(/&#34;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

function formAttribute(html, name) {
  const tag = html.match(/<form id="setupForm"[^>]*>/);
  assert.ok(tag, '#setupForm must be rendered');
  const match = tag[0].match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `#setupForm must carry ${name}`);
  return decodeAttribute(match[1]);
}

// The page text a person reads: markup, scripts and styles removed. The
// changelog entry is left out: release notes quote what earlier versions did.
function visibleText(html) {
  return html
    .replace(
      /<section[^>]*data-entry="changelog"[\s\S]*?(?=<div class="zr-actionbar")/,
      ' '
    )
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

// A browser is available in development containers, not in CI. The lock is a
// client-side step, so it is looked at in a real page when one can be had.
function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

(async () => {
  const exitCalls = [];
  const realExit = process.exit;
  process.exit = (code) => {
    exitCalls.push(code);
  };

  delete process.env.TRUST_PROXY;
  delete process.env.AI_TEMPERATURE_ANALYSIS;
  const harness = await mountRouter({
    env: { [PINNED_KEY]: PINNED_VALUE },
  });
  Object.assign(harness.app.locals, SHELL_LOCALS);
  const config = require('../config/config');

  const request = (method, url, body, headers = {}) =>
    fetch(harness.base + url, {
      method,
      redirect: 'manual',
      headers: {
        'x-api-key': API_KEY,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  const health = async () => (await request('GET', '/health')).json();

  try {
    // ── 1. The boot identity ────────────────────────────────────────────────
    await test('GET /health carries bootId and startedAt, stable across calls', async () => {
      const first = await health();
      const second = await health();
      assert.ok(first.bootId, 'bootId expected');
      assert.ok(first.startedAt, 'startedAt expected');
      assert.strictEqual(second.bootId, first.bootId);
      assert.strictEqual(second.startedAt, first.startedAt);
      assert.ok(!Number.isNaN(Date.parse(first.startedAt)));
    });

    // ── 2. Live configuration ───────────────────────────────────────────────
    await test('config getters follow process.env without a re-require', async () => {
      const before = config.aiTemperatureAnalysis;
      process.env.AI_TEMPERATURE_ANALYSIS = '1.1';
      process.env.OLLAMA_MODEL = 'live-model';
      process.env.AI_PROVIDER = 'ollama';
      try {
        assert.strictEqual(config.aiTemperatureAnalysis, 1.1);
        assert.strictEqual(config.ollama.model, 'live-model');
        assert.strictEqual(config.aiProvider, 'ollama');
      } finally {
        delete process.env.AI_TEMPERATURE_ANALYSIS;
        delete process.env.OLLAMA_MODEL;
        process.env.AI_PROVIDER = 'openai';
      }
      assert.strictEqual(config.aiTemperatureAnalysis, before);
      assert.strictEqual(config.ollama.model, 'llama3.2');
    });

    await test('an assigned value holds until the environment changes', async () => {
      process.env.CUSTOM_MODEL = 'from-env';
      config.custom.model = 'assigned';
      assert.strictEqual(config.custom.model, 'assigned');
      process.env.CUSTOM_MODEL = 'saved-later';
      assert.strictEqual(config.custom.model, 'saved-later');
      delete process.env.CUSTOM_MODEL;
    });

    // ── 3. A live value: no restart ─────────────────────────────────────────
    await test('a save that changes only AI_TEMPERATURE_ANALYSIS does not restart', async () => {
      const response = await request('POST', '/settings', {
        aiTemperatureAnalysis: '0.9',
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200, JSON.stringify(body));
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.restart, false, JSON.stringify(body));
      assert.deepStrictEqual(body.restartKeys, []);
      assert.match(body.message, /in effect/);
      // Applied at once, without a restart.
      assert.strictEqual(config.aiTemperatureAnalysis, 0.9);
    });

    // ── 4. A boot-time value: restart ───────────────────────────────────────
    await test('a save that changes TRUST_PROXY restarts and names the key', async () => {
      const response = await request('POST', '/settings', {
        aiTemperatureAnalysis: '0.9',
        trustProxy: '1',
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200, JSON.stringify(body));
      assert.strictEqual(body.restart, true, JSON.stringify(body));
      assert.deepStrictEqual(body.restartKeys, ['TRUST_PROXY']);
    });

    await test('only the restarting save calls process.exit, after five seconds', async () => {
      assert.deepStrictEqual(exitCalls, [], 'nothing exits right away');
      await new Promise((resolve) => setTimeout(resolve, 5300));
      assert.deepStrictEqual(exitCalls, [0], 'exactly one scheduled exit');
    });

    await test('a pinned key is never reported as changed', async () => {
      const response = await request('POST', '/settings', {
        scanInterval: '0 * * * *',
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200, JSON.stringify(body));
      assert.strictEqual(body.restart, false, JSON.stringify(body));
      assert.strictEqual(process.env[PINNED_KEY], PINNED_VALUE);
    });

    // ── 5. What the page carries ────────────────────────────────────────────
    const pageResponse = await request('GET', '/settings');
    const html = await pageResponse.text();

    await test('#setupForm carries the locked keys, the restart keys and the boot id', async () => {
      assert.strictEqual(pageResponse.status, 200);
      const locked = JSON.parse(formAttribute(html, 'data-locked-env-keys'));
      assert.ok(locked.includes(PINNED_KEY), `${PINNED_KEY} is pinned`);
      assert.ok(!locked.includes('TRUST_PROXY'), 'a saved key is not pinned');
      const restartKeys = JSON.parse(formAttribute(html, 'data-restart-keys'));
      assert.deepStrictEqual(
        restartKeys.sort(),
        [...RESTART_REQUIRED_KEYS].sort()
      );
      assert.strictEqual(
        formAttribute(html, 'data-boot-id'),
        (await health()).bootId
      );
    });

    await test('the pinned value stays visible in its field', async () => {
      assert.match(
        html,
        new RegExp(
          `id="scanInterval"[^>]*value="${PINNED_VALUE.replace(/\*/g, '\\*')}"`
        )
      );
    });

    await test('the client locks a pinned field quietly', async () => {
      const source = fs.readFileSync(
        path.join(REPO_ROOT, 'public', 'js', 'settings.js'),
        'utf8'
      );
      assert.ok(source.includes('setupForm?.dataset.lockedEnvKeys'));
      assert.ok(source.includes('Set by the environment (${envKey}).'));
      assert.ok(!source.includes('Managed by ENV'), 'no badge');
      assert.ok(!source.includes('runtimeOverride'), 'no override details');
      assert.ok(!source.includes('resetLocalOverridesBtn'));

      const formModule = fs.readFileSync(
        path.join(REPO_ROOT, 'public', 'js', 'modules', 'settings-form.js'),
        'utf8'
      );
      assert.ok(formModule.includes('restartKeys.has(field.dataset.envKey)'));
      assert.ok(!/restart required/i.test(formModule.replace(/\/\/.*$/gm, '')));
    });

    // ── 6. No talk of environment variables ─────────────────────────────────
    await test('the page does not explain environment variables', async () => {
      const text = visibleText(html);
      for (const word of [
        /injected/i,
        /override/i,
        /container/i,
        /maps to an? (runtime )?environment variable/i,
        /Managed by ENV/i,
      ]) {
        assert.ok(!word.test(text), `the page still says ${word}`);
      }
      assert.ok(!html.includes('id="sec-local-overrides"'));
      assert.ok(!html.includes('resetLocalOverridesBtn'));
      assert.ok(!html.includes('data-runtime-override'));
      assert.ok(!html.includes('data-locked-env-details'));
      assert.ok(/data-entry-link="environment"[\s\S]*?>Export</.test(html));
    });

    await test('no hint outside the AI and tag-tool sections says restart required', async () => {
      const own = html
        .split('<section class="zr-settings-entry')
        .filter(
          (entry) =>
            !/^[^>]*data-entry="(ai-provider|ai-behavior|duplicates|simplify)"/.test(
              entry
            )
        )
        .join('');
      const hints = own.match(/class="zr-field__hint[^"]*"[^>]*>[^<]*/g) || [];
      const offending = hints.filter((hint) => /restart required/i.test(hint));
      assert.deepStrictEqual(offending, []);
    });

    // ── 5b. The lock, in a browser when there is one ────────────────────────
    const playwright = loadPlaywright();
    if (!playwright) {
      console.log(
        'ℹ️  no browser available; the client lock was checked in source only'
      );
    } else {
      await test('in a browser, the pinned field is disabled with the hint sentence', async () => {
        const express = require(
          path.join(REPO_ROOT, 'node_modules', 'express')
        );
        harness.app.use(express.static(path.join(REPO_ROOT, 'public')));
        const browser = await playwright.chromium.launch();
        try {
          const page = await browser.newPage({
            extraHTTPHeaders: { 'x-api-key': API_KEY },
          });
          await page.goto(harness.base + '/settings#schedule');
          await page.waitForFunction(
            () => document.getElementById('scanInterval')?.disabled === true,
            null,
            { timeout: 10000 }
          );
          const state = await page.evaluate(() => {
            const field = document.getElementById('scanInterval');
            const row = field.closest('.zr-field, .zr-switchrow');
            return {
              value: field.value,
              ariaDisabled: field.getAttribute('aria-disabled'),
              hint: [...row.querySelectorAll('.zr-field__hint')]
                .map((hint) => hint.textContent)
                .join(' | '),
              badges: row.querySelectorAll('.zr-badge').length,
            };
          });
          assert.strictEqual(state.value, PINNED_VALUE);
          assert.strictEqual(state.ariaDisabled, 'true');
          assert.match(
            state.hint,
            new RegExp(`Set by the environment \\(${PINNED_KEY}\\)\\.$`)
          );
          assert.strictEqual(state.badges, 0, 'no pill next to the field');
        } finally {
          await browser.close();
        }
      });
    }
  } finally {
    await harness.close();
    process.exit = realExit;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
