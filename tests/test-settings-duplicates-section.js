'use strict';

/**
 * The Duplicates settings section.
 *
 * Every DUPLICATES_* variable used to be reachable only by editing the
 * container environment, which is exactly the kind of setting the settings
 * page exists for. The section makes the seven of them editable, so this test
 * holds the whole path together: the rendered fields, the nav entry that
 * reaches them, the POST that stores them, and the .env export that lists
 * them.
 *
 * Two behaviours are deliberate and therefore pinned here. A number outside
 * its range is clamped rather than rejected — the ranges are guard rails, not
 * a reason to throw a whole settings form away. A value that is not a number
 * at all (or a cleared field) keeps what is configured now, so a typo cannot
 * silently reset a setting to its default.
 *
 * The page is rendered through the real router, so a field that stops being
 * emitted, a renamed body key or a group missing from the export all fail
 * here rather than in production.
 */

const assert = require('assert');
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
        7,
        'each of the seven fields says what it does and what its default is'
      );
    });

    // ── 2. Saving stores all seven ──────────────────────────────────────────
    await test('POST /settings persists all seven values', async () => {
      const response = await postSettings({
        duplicatesAiReview: 'yes',
        duplicatesAiModel: '  gpt-judge  ',
        duplicatesAiReviewBatchSize: '12',
        duplicatesAiCandidateFloor: '0.85',
        duplicatesAiExcerpts: 'yes',
        duplicatesAiExcerptChars: '250',
        duplicatesAiExcerptDocuments: '3',
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
      });
      assert.strictEqual(response.status, 200, await response.text());

      const saved = lastSaved();
      assert.strictEqual(saved.DUPLICATES_AI_REVIEW, 'no');
      assert.strictEqual(saved.DUPLICATES_AI_REVIEW_BATCH_SIZE, '100');
      assert.strictEqual(saved.DUPLICATES_AI_CANDIDATE_FLOOR, '0.5');
      assert.strictEqual(saved.DUPLICATES_AI_EXCERPT_CHARS, '50');
      assert.strictEqual(saved.DUPLICATES_AI_EXCERPT_DOCUMENTS, '5');
    });

    await test('a value that is not a number keeps the previous one', async () => {
      const response = await postSettings({
        duplicatesAiReview: 'maybe',
        duplicatesAiReviewBatchSize: 'twenty',
        duplicatesAiCandidateFloor: 'high',
        duplicatesAiExcerptChars: '',
        duplicatesAiExcerptDocuments: 'lots',
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
    });

    // ── 4. The .env export lists them ───────────────────────────────────────
    await test('the .env export carries a Duplicates group with all seven keys', async () => {
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
    });
  } finally {
    await harness.close();
  }

  finish();
})().catch((error) => {
  console.error(error);
  finish();
});
