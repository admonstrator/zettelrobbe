'use strict';

/**
 * The Duplicates settings section.
 *
 * Every DUPLICATES_* variable used to be reachable only by editing the
 * container environment, which is exactly the kind of setting the settings
 * page exists for. The section makes the nine of them editable, so this test
 * holds the whole path together: the rendered fields, the nav entry that
 * reaches them, the POST that stores them, the "Managed by ENV" marking that
 * greys them out, and the .env export that lists them.
 *
 * Two behaviours are deliberate and therefore pinned here. A number outside
 * its range is clamped rather than rejected — the ranges are guard rails, not
 * a reason to throw a whole settings form away. A value that is not a number
 * at all (or a cleared field) keeps what is configured now, so a typo cannot
 * silently reset a setting to its default.
 *
 * The two brakes of a running review — the token budget and the idle stop —
 * are the only fields of the section whose range starts at zero, because zero
 * is a meaningful value for both (no token limit, never stop an unwatched
 * review) rather than an unset one. A clamp that treated them like the others
 * would quietly turn "no limit" into the smallest allowed limit.
 *
 * The page is rendered through the real router, so a field that stops being
 * emitted, a renamed body key or a group missing from the export all fail
 * here rather than in production.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mountRouter } = require('./helpers/mount-router');

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

// Deliberately none of the defaults, so a field that ignores the current
// configuration and prints its own fallback is visible.
const START_ENV = {
  DUPLICATES_AI_REVIEW: 'no',
  DUPLICATES_AI_MODEL: 'judge-of-record',
  DUPLICATES_AI_REVIEW_BATCH_SIZE: '40',
  DUPLICATES_AI_CANDIDATE_FLOOR: '0.72',
  DUPLICATES_AI_EXCERPTS: 'no',
  DUPLICATES_AI_EXCERPT_CHARS: '120',
  DUPLICATES_AI_EXCERPT_DOCUMENTS: '4',
  DUPLICATES_AI_TOKEN_BUDGET: '120000',
  DUPLICATES_AI_IDLE_STOP_SECONDS: '90',
};

const ENV_KEYS = Object.keys(START_ENV);

// The body keys the page sends, in the order the section shows them.
const FIELDS = [
  { input: 'duplicatesAiReview', envKey: 'DUPLICATES_AI_REVIEW' },
  { input: 'duplicatesAiModel', envKey: 'DUPLICATES_AI_MODEL' },
  {
    input: 'duplicatesAiReviewBatchSize',
    envKey: 'DUPLICATES_AI_REVIEW_BATCH_SIZE',
  },
  {
    input: 'duplicatesAiCandidateFloor',
    envKey: 'DUPLICATES_AI_CANDIDATE_FLOOR',
  },
  { input: 'duplicatesAiExcerpts', envKey: 'DUPLICATES_AI_EXCERPTS' },
  { input: 'duplicatesAiExcerptChars', envKey: 'DUPLICATES_AI_EXCERPT_CHARS' },
  {
    input: 'duplicatesAiExcerptDocuments',
    envKey: 'DUPLICATES_AI_EXCERPT_DOCUMENTS',
  },
  { input: 'duplicatesAiTokenBudget', envKey: 'DUPLICATES_AI_TOKEN_BUDGET' },
  {
    input: 'duplicatesAiIdleStopSeconds',
    envKey: 'DUPLICATES_AI_IDLE_STOP_SECONDS',
  },
];

let passed = 0;
let failed = 0;

// A successful POST /settings schedules process.exit(0) five seconds later.
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

function finish() {
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit = realExit;
  realExit(failed > 0 ? 1 : 0);
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
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
    env: START_ENV,
    stub: ({ setupService }) => {
      // The real saveConfig writes the merged configuration back onto
      // process.env and touches the data directory. Only the first half
      // matters here — the route reads the current values from process.env,
      // so "keeps the previous value" only means anything if a save lands
      // there.
      setupService.saveConfig = async (config) => {
        savedConfigs.push(config);
        Object.entries(config).forEach(([key, value]) => {
          process.env[key] = String(value);
        });
      };
    },
  });
  Object.assign(harness.app.locals, SHELL_LOCALS);

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

  const lastSaved = () => savedConfigs[savedConfigs.length - 1];

  try {
    // ── 1. The section is on the page, with a way to reach it ───────────────
    await test('GET /settings renders the Duplicates section and its nav entry', async () => {
      const html = await getSettingsPage();

      assert.ok(
        html.includes('id="sec-duplicates"'),
        'the section itself must be rendered'
      );
      assert.ok(
        html.includes('id="duplicates-tab"'),
        'the nav entry needs a target block'
      );

      const desktopNav = sliceBetween(
        html,
        '<nav class="zr-sectionnav" data-module="section-nav">',
        '</nav>'
      );
      const mobileNav = sliceBetween(
        html,
        '<nav class="zr-sectionnav zr-only-mobile">',
        '</nav>'
      );

      [
        ['desktop', desktopNav],
        ['mobile', mobileNav],
      ].forEach(([label, nav]) => {
        assert.ok(
          nav.includes('href="#duplicates-tab"'),
          `the ${label} nav must link the section`
        );
        // The nav order has to match the page order or the scroll-spy
        // highlight jumps around while scrolling.
        assert.ok(
          nav.indexOf('href="#ai-tab"') <
            nav.indexOf('href="#duplicates-tab"') &&
            nav.indexOf('href="#duplicates-tab"') <
              nav.indexOf('href="#ocr-tab"'),
          `the ${label} nav must list Duplicates after AI and before OCR`
        );
      });

      assert.ok(
        desktopNav.includes('/icons.svg#i-merge'),
        'the desktop nav entry carries the i-merge icon, like every other entry carries one'
      );
      assert.ok(
        html.indexOf('id="ai-tab"') < html.indexOf('id="duplicates-tab"') &&
          html.indexOf('id="duplicates-tab"') < html.indexOf('id="ocr-tab"'),
        'the section itself sits after the AI sections and before OCR'
      );
    });

    await test('every field is rendered with the value that is configured now', async () => {
      const html = await getSettingsPage();
      const section = sliceBetween(html, 'id="duplicates-tab"', 'id="ocr-tab"');

      FIELDS.forEach(({ input, envKey }) => {
        assert.ok(
          section.includes(`name="${input}"`),
          `${input} must be part of the settings form, or it is never submitted`
        );
        assert.ok(
          section.includes(`value="${START_ENV[envKey]}"`),
          `${input} must show the configured ${envKey} (${START_ENV[envKey]})`
        );
      });

      // Both switches go through the shared partial, so the hidden yes/no
      // input the POST route reads exists and is driven by the visible one.
      ['duplicatesAiReview', 'duplicatesAiExcerpts'].forEach((id) => {
        assert.ok(
          section.includes(`data-switch-target="${id}"`),
          `${id} must be a settings-switch, not a bare checkbox`
        );
      });

      assert.strictEqual(
        countOccurrences(section, 'class="zr-field__hint"'),
        9,
        'each of the nine fields says what it does and what its default is'
      );
    });

    await test('the two brakes render as number fields with a range that starts at zero', async () => {
      const html = await getSettingsPage();
      const section = sliceBetween(html, 'id="duplicates-tab"', 'id="ocr-tab"');

      const budget = sliceBetween(
        section,
        'id="duplicatesAiTokenBudget"',
        '</div>'
      );
      assert.ok(
        budget.includes('min="0"') &&
          budget.includes('max="10000000"') &&
          budget.includes('step="1000"'),
        'the token budget spans 0 to 10000000 and steps in thousands'
      );
      assert.ok(
        budget.includes('value="120000"'),
        'the token budget shows the configured DUPLICATES_AI_TOKEN_BUDGET'
      );
      assert.ok(
        /0 means no limit/.test(budget) && /Default: 200000/.test(budget),
        'its hint says what zero means and what the default is'
      );

      const idle = sliceBetween(
        section,
        'id="duplicatesAiIdleStopSeconds"',
        '</div>'
      );
      assert.ok(
        idle.includes('min="0"') &&
          idle.includes('max="3600"') &&
          idle.includes('step="1"'),
        'the idle stop spans 0 to 3600 seconds'
      );
      assert.ok(
        idle.includes('value="90"'),
        'the idle stop shows the configured DUPLICATES_AI_IDLE_STOP_SECONDS'
      );
      assert.ok(
        /0 means never/.test(idle) && /Default: 60/.test(idle),
        'its hint says what zero means and what the default is'
      );

      // The brakes belong to the section, and they close it — the AI review
      // settings above them describe what one request looks like, these two
      // describe when the whole run has to stop.
      assert.ok(
        section.indexOf('id="duplicatesAiExcerptDocuments"') <
          section.indexOf('id="duplicatesAiTokenBudget"') &&
          section.indexOf('id="duplicatesAiTokenBudget"') <
            section.indexOf('id="duplicatesAiIdleStopSeconds"'),
        'the budget and the idle stop close the section, in that order'
      );
    });

    await test('every field of the section is marked when it is managed by the environment', async () => {
      const markedFields = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'js', 'settings.js'),
        'utf8'
      );

      FIELDS.forEach(({ input, envKey }) => {
        const entry = new RegExp(
          `selector:\\s*'#${input}',\\s*envKey:\\s*'${envKey}'`
        );
        assert.ok(
          entry.test(markedFields),
          `${input} must be paired with ${envKey} in settings.js, or an operator-set value is never greyed out`
        );
      });
    });

    // ── 2. Saving stores all nine ───────────────────────────────────────────
    await test('POST /settings persists all nine values', async () => {
      const response = await postSettings({
        duplicatesAiReview: 'yes',
        duplicatesAiModel: '  gpt-judge  ',
        duplicatesAiReviewBatchSize: '12',
        duplicatesAiCandidateFloor: '0.85',
        duplicatesAiExcerpts: 'yes',
        duplicatesAiExcerptChars: '250',
        duplicatesAiExcerptDocuments: '3',
        duplicatesAiTokenBudget: '75000',
        duplicatesAiIdleStopSeconds: '30',
      });
      assert.strictEqual(response.status, 200, await response.text());

      const expected = {
        DUPLICATES_AI_REVIEW: 'yes',
        DUPLICATES_AI_MODEL: 'gpt-judge',
        DUPLICATES_AI_REVIEW_BATCH_SIZE: '12',
        DUPLICATES_AI_CANDIDATE_FLOOR: '0.85',
        DUPLICATES_AI_EXCERPTS: 'yes',
        DUPLICATES_AI_EXCERPT_CHARS: '250',
        DUPLICATES_AI_EXCERPT_DOCUMENTS: '3',
        DUPLICATES_AI_TOKEN_BUDGET: '75000',
        DUPLICATES_AI_IDLE_STOP_SECONDS: '30',
      };
      Object.entries(expected).forEach(([key, value]) => {
        assert.strictEqual(
          lastSaved()[key],
          value,
          `${key} must reach setupService.saveConfig as "${value}"`
        );
        assert.strictEqual(
          process.env[key],
          value,
          `${key} must be live after the save`
        );
      });
    });

    await test('an emptied model field hands the judge back to the configured model', async () => {
      const response = await postSettings({ duplicatesAiModel: '   ' });
      assert.strictEqual(response.status, 200, await response.text());
      assert.strictEqual(
        lastSaved().DUPLICATES_AI_MODEL,
        '',
        'empty is a meaningful value here, unlike the numbers'
      );
    });

    // ── 3. Ranges are guard rails, not a reason to lose the form ────────────
    await test('numbers outside their range are clamped', async () => {
      const response = await postSettings({
        // Switched off here so the next case can tell "kept the previous
        // value" apart from "fell back to the default", which is on.
        duplicatesAiReview: 'no',
        duplicatesAiModel: 'gpt-judge',
        duplicatesAiReviewBatchSize: '999',
        duplicatesAiCandidateFloor: '0.1',
        duplicatesAiExcerptChars: '5',
        duplicatesAiExcerptDocuments: '9',
        duplicatesAiTokenBudget: '99999999',
        duplicatesAiIdleStopSeconds: '-5',
      });
      assert.strictEqual(response.status, 200, await response.text());

      const saved = lastSaved();
      assert.strictEqual(saved.DUPLICATES_AI_REVIEW, 'no');
      assert.strictEqual(saved.DUPLICATES_AI_REVIEW_BATCH_SIZE, '100');
      assert.strictEqual(saved.DUPLICATES_AI_CANDIDATE_FLOOR, '0.5');
      assert.strictEqual(saved.DUPLICATES_AI_EXCERPT_CHARS, '50');
      assert.strictEqual(saved.DUPLICATES_AI_EXCERPT_DOCUMENTS, '5');
      assert.strictEqual(
        saved.DUPLICATES_AI_TOKEN_BUDGET,
        '10000000',
        'a budget above the ceiling is capped, not rejected'
      );
      assert.strictEqual(
        saved.DUPLICATES_AI_IDLE_STOP_SECONDS,
        '0',
        'a negative idle stop lands on zero, which means "never"'
      );
    });

    await test('zero is kept for both brakes, because it is a value and not an unset field', async () => {
      const response = await postSettings({
        duplicatesAiTokenBudget: '0',
        duplicatesAiIdleStopSeconds: '0',
      });
      assert.strictEqual(response.status, 200, await response.text());

      const saved = lastSaved();
      assert.strictEqual(
        saved.DUPLICATES_AI_TOKEN_BUDGET,
        '0',
        '0 means no token limit and must survive the round trip'
      );
      assert.strictEqual(
        saved.DUPLICATES_AI_IDLE_STOP_SECONDS,
        '0',
        '0 means an unwatched review is never stopped'
      );
    });

    await test('a fractional budget is rounded rather than stored as a fraction', async () => {
      const response = await postSettings({
        duplicatesAiTokenBudget: '1500.7',
        duplicatesAiIdleStopSeconds: '45.2',
      });
      assert.strictEqual(response.status, 200, await response.text());

      const saved = lastSaved();
      assert.strictEqual(saved.DUPLICATES_AI_TOKEN_BUDGET, '1501');
      assert.strictEqual(saved.DUPLICATES_AI_IDLE_STOP_SECONDS, '45');
    });

    await test('a value that is not a number keeps the previous one', async () => {
      const response = await postSettings({
        duplicatesAiReview: 'maybe',
        duplicatesAiReviewBatchSize: 'twenty',
        duplicatesAiCandidateFloor: 'high',
        duplicatesAiExcerptChars: '',
        duplicatesAiExcerptDocuments: 'lots',
        duplicatesAiTokenBudget: '',
        duplicatesAiIdleStopSeconds: 'forever',
      });
      assert.strictEqual(response.status, 200, await response.text());

      const saved = lastSaved();
      assert.strictEqual(
        saved.DUPLICATES_AI_REVIEW,
        'no',
        'an unknown switch value must not flip the setting back to its default'
      );
      assert.strictEqual(saved.DUPLICATES_AI_REVIEW_BATCH_SIZE, '100');
      assert.strictEqual(saved.DUPLICATES_AI_CANDIDATE_FLOOR, '0.5');
      assert.strictEqual(
        saved.DUPLICATES_AI_EXCERPT_CHARS,
        '50',
        'a cleared field must not reset the setting to its default'
      );
      assert.strictEqual(saved.DUPLICATES_AI_EXCERPT_DOCUMENTS, '5');
      assert.strictEqual(
        saved.DUPLICATES_AI_TOKEN_BUDGET,
        '1501',
        'a cleared budget keeps what the last save stored, not the default'
      );
      assert.strictEqual(
        saved.DUPLICATES_AI_IDLE_STOP_SECONDS,
        '45',
        'an unparsable idle stop keeps what the last save stored'
      );
    });

    // ── 4. The .env export lists them ───────────────────────────────────────
    await test('the .env export carries a Duplicates group with all nine keys', async () => {
      const response = await fetch(harness.base + '/api/settings/env-file', {
        headers: { 'x-api-key': API_KEY },
      });
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.strictEqual(payload.success, true);

      const env = payload.data.env;
      assert.ok(env.includes('# Duplicates'), 'the group has its own heading');
      ENV_KEYS.forEach((key) => {
        assert.ok(
          env.includes(`${key}=`),
          `${key} must be part of the exported configuration`
        );
      });

      // The export is read top to bottom by a human pasting it into a compose
      // file, so the two brakes follow the settings they brake.
      assert.ok(
        env.indexOf('DUPLICATES_AI_EXCERPT_DOCUMENTS=') <
          env.indexOf('DUPLICATES_AI_TOKEN_BUDGET=') &&
          env.indexOf('DUPLICATES_AI_TOKEN_BUDGET=') <
            env.indexOf('DUPLICATES_AI_IDLE_STOP_SECONDS='),
        'the group lists the budget and the idle stop after the round-6 keys, in that order'
      );
    });
  } finally {
    await harness.close();
  }

  finish();
})().catch((error) => {
  console.error(error);
  finish();
});
