'use strict';

/**
 * Test: AI_TEMPERATURE_GENERATION and the callers of generateText()
 *
 * The setting came in with dd5fdc1 (#121) as the temperature of
 * generateText(), the provider call for answers outside the document
 * analysis. Its one caller then was the RAG chat ("ask your documents",
 * services/ragService.js). The RAG went in c4c4907 and the chat in 4bcd459;
 * from then until 5bc84c4 nothing called generateText() at all. The callers
 * since are Tidy up's: the judge of name pairs, its synonym sweep, the
 * vocabulary proposal and the tag split. Each of them passes temperature 0 on
 * purpose (5bc84c4, 8fa1367): it asks for a verdict or a lookup in a fixed
 * JSON shape, and a verdict that changes from run to run, or an answer that
 * stops parsing, is worth nothing.
 *
 * The provider services still fall back to the setting when a caller passes
 * no temperature (tests/test-ollama-temperature-wiring.js,
 * tests/test-openai-compatible-service.js), but no caller does, so the value
 * changes nothing. The settings page offered it as if it did.
 *
 * Covers:
 *  1. The census: the code that runs calls generateText() in exactly four
 *     places, two in entityMatchAiService.js and two in tagSimplifyService.js
 *  2. The judge asks with temperature 0, whatever AI_TEMPERATURE_GENERATION says
 *  3. The synonym sweep asks with temperature 0
 *  4. The vocabulary proposal asks with temperature 0
 *  5. The tag split asks with temperature 0
 *  6. The settings page says that nothing uses the value
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFakePaperless } = require('./helpers/fake-paperless');

const REPO_ROOT = path.resolve(__dirname, '..');

/** What the setting is set to here: anything but the 0 the callers send. */
const CONFIGURED = '1.3';

let passed = 0;
let failed = 0;

// The services log every request; the cases below silence console.log and
// console.warn, and the results are written with the real one.
const say = console.log.bind(console);

async function test(name, fn) {
  try {
    await fn();
    say(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed++;
  }
}

const read = (relative) =>
  fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

/* ── 1. The census ───────────────────────────────────────────────────────── */

/**
 * Every call of generateText() in the code that runs, as "file#method": the
 * class method the call sits in. A new entry here means a new caller: decide
 * its temperature, give it a case below, and say on the settings page (the
 * AI_TEMPERATURE_GENERATION help in services/aiProviderRules.js) whether the
 * value now does something.
 */
const CALLERS = [
  // The judge: same / different / unsure per name pair.
  'services/entityMatchAiService.js#_judgeBatch',
  // The synonym sweep: which names of the archive mean the same thing.
  'services/entityMatchAiService.js#_sweepChunk',
  // The vocabulary: the document types and topics the tags are about.
  'services/tagSimplifyService.js#_vocabularyChunk',
  // The split: one action per tag the rule could not settle.
  'services/tagSimplifyService.js#_splitChunk',
];

function serverFiles() {
  const files = ['server.js'];
  for (const dir of ['routes', 'services', 'middleware', 'models']) {
    const walk = (relative) => {
      for (const entry of fs.readdirSync(path.join(REPO_ROOT, relative), {
        withFileTypes: true,
      })) {
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith('.js')) files.push(child);
      }
    };
    walk(dir);
  }
  return files.map((file) => file.split(path.sep).join('/'));
}

function generateTextCallers() {
  const found = [];
  for (const file of serverFiles()) {
    const lines = read(file).split('\n');
    lines.forEach((line, index) => {
      if (!/\.generateText\(/.test(line)) return;
      if (/^\s*(\/\/|\/?\*)/.test(line)) return;
      // The class method the call sits in: the nearest method head above it.
      let method = '?';
      for (let at = index; at >= 0; at -= 1) {
        const head = /^ {2}(?:async )?([A-Za-z_$][\w$]*)\(/.exec(lines[at]);
        if (head) {
          method = head[1];
          break;
        }
      }
      found.push(`${file}#${method}`);
    });
  }
  return found.sort();
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async () => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-gen-temp-'));
  process.chdir(tempRoot);

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://127.0.0.1:9';
  process.env.PAPERLESS_API_TOKEN = 'test-token';
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'test';
  process.env.OPENAI_MODEL = 'test-model';
  process.env.DUPLICATES_AI_REVIEW = 'yes';
  process.env.DUPLICATES_AI_VERDICT_MEMORY_DAYS = '0';
  process.env.AI_TEMPERATURE_GENERATION = CONFIGURED;

  const config = require('../config/config');
  config.duplicatesAiConcurrency = 1;
  const paperlessService = require('../services/paperlessService');
  const dashboardStatsService = require('../services/dashboardStatsService');
  const AIServiceFactory = require('../services/aiServiceFactory');
  const duplicateMergeService = require('../services/duplicateMergeService');
  const matcher = require('../services/entityNameMatcher');
  const entityMatchAiService = require('../services/entityMatchAiService');
  const tagSimplifyService = require('../services/tagSimplifyService');

  // The dashboard rebuild is fired detached after every write; it would talk
  // to the network and outlive the test process.
  dashboardStatsService.refresh = async () => ({});
  const realGetService = AIServiceFactory.getService;
  const quiet = { log: console.log, warn: console.warn };

  /** A provider that records every call and answers with `respond`. */
  function useProvider(respond) {
    const calls = [];
    const provider = {
      client: {},
      lastGenerateTextUsage: null,
      async generateText(prompt, options) {
        calls.push({ prompt, options });
        provider.lastGenerateTextUsage = { totalTokens: 100 };
        return respond(prompt, options);
      },
    };
    AIServiceFactory.getService = () => provider;
    return { provider, calls };
  }

  function useFake(seed) {
    const fake = createFakePaperless(seed);
    paperlessService.client = fake.client;
    paperlessService.clearEntityCaches();
    duplicateMergeService.invalidateScanCache();
    return fake;
  }

  const entity = (id, name, documentCount = 1) => ({
    id,
    name,
    documentCount,
    matchingAlgorithm: 0,
    match: '',
    isInsensitive: true,
    owner: null,
    userCanChange: true,
  });

  /** Asserts that every recorded call asked with temperature 0. */
  function assertAskedWithZero(calls, who) {
    assert.ok(calls.length > 0, `${who} made no request`);
    calls.forEach((call, index) => {
      assert.strictEqual(
        call.options?.temperature,
        0,
        `${who}, request ${index + 1}: temperature ${call.options?.temperature} instead of 0`
      );
    });
  }

  try {
    console.log = () => {};
    console.warn = () => {};

    await test('The code that runs calls generateText() in four places', () => {
      assert.deepStrictEqual(generateTextCallers(), [...CALLERS].sort());
    });

    await test('The judge asks with temperature 0: a verdict must not change from run to run', async () => {
      assert.strictEqual(config.aiTemperatureGeneration, Number(CONFIGURED));
      entityMatchAiService.resetCalibration();
      const a = entity(1, 'Rechnung', 3);
      const b = entity(2, 'Rechnungen', 1);
      const { calls } = useProvider((prompt) =>
        JSON.stringify(
          [...String(prompt).matchAll(/"id":"([^"]+)"/g)].map((hit) => ({
            id: hit[1],
            verdict: 'same',
            reason: 'plural',
          }))
        )
      );
      await entityMatchAiService.reviewPairs(
        [{ key: matcher.pairKey('tags', a.id, b.id), a, b }],
        { kind: 'tags' }
      );
      assertAskedWithZero(calls, 'the judge');
    });

    await test('The synonym sweep asks with temperature 0: it is a lookup, not a draft', async () => {
      const { provider, calls } = useProvider(() => '[]');
      await entityMatchAiService._sweepKind(
        'tags',
        [entity(1, 'Auto'), entity(2, 'Fahrzeug'), entity(3, 'Versicherung')],
        {
          known: new Set(),
          dismissed: new Set(),
          service: provider,
          tracker: null,
          sizer: null,
        }
      );
      assertAskedWithZero(calls, 'the sweep');
    });

    await test('The vocabulary proposal asks with temperature 0: the answer must parse as JSON', async () => {
      useFake({
        tags: [{ id: 1, name: 'Stromrechnung' }],
        documentTypes: [{ id: 7, name: 'Rechnung' }],
      });
      const { calls } = useProvider(() =>
        JSON.stringify({ types: ['Rechnung'], topics: ['Strom'] })
      );
      await tagSimplifyService.proposeVocabulary();
      assertAskedWithZero(calls, 'the vocabulary proposal');
    });

    await test('The tag split asks with temperature 0: one fixed action per tag', async () => {
      useFake({
        tags: [
          { id: 4, name: 'asdf' },
          { id: 5, name: 'Hobby' },
        ],
        documentTypes: [{ id: 7, name: 'Rechnung' }],
        documents: [
          { id: 103, tags: [4], document_type: null },
          { id: 104, tags: [5], document_type: null },
        ],
      });
      await tagSimplifyService.saveVocabulary({
        types: ['Rechnung'],
        topics: ['Garten'],
      });
      const { calls } = useProvider((prompt, options) =>
        options.systemPrompt.includes('Give every tag exactly one action')
          ? JSON.stringify(
              [...String(prompt).matchAll(/"id":\s*"?(\d+)"?/g)].map((hit) => ({
                id: hit[1],
                action: 'keep',
                confidence: 'high',
              }))
            )
          : JSON.stringify({ types: ['Rechnung'], topics: ['Garten'] })
      );
      await tagSimplifyService.proposeOrder({ vocabulary: 'keep' });
      const split = calls.filter((call) =>
        call.options.systemPrompt.includes('Give every tag exactly one action')
      );
      assertAskedWithZero(split, 'the tag split');
    });

    console.log = quiet.log;
    console.warn = quiet.warn;

    await test('The settings page says that nothing uses the value', async () => {
      const { AI_OPTIONS } = require('../services/aiProviderRules');
      const option = AI_OPTIONS.find(
        (entry) => entry.key === 'AI_TEMPERATURE_GENERATION'
      );
      assert.ok(option, 'the option is still offered');
      assert.match(
        option.help,
        /does not use this value/,
        'the hint must say that the value has no effect'
      );
      assert.match(option.help, /Tidy up/);
      assert.ok(
        !/free-text answers outside the analysis may be/.test(option.help),
        'the old hint described an effect the value does not have'
      );

      const { renderSettingsPage } = require('./helpers/render-settings');
      const html = await renderSettingsPage();
      const at = html.indexOf('data-ai-option="AI_TEMPERATURE_GENERATION"');
      assert.ok(at > 0, 'the field is rendered');
      const row = html.slice(at, html.indexOf('data-ai-option=', at + 10));
      assert.match(row, /does not use this value/);
    });
  } finally {
    console.log = quiet.log;
    console.warn = quiet.warn;
    AIServiceFactory.getService = realGetService;
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
