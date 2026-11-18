'use strict';

/**
 * OCR before the first AI analysis (OCR_BEFORE_AI, discussion #280), as the
 * document pipeline applies it.
 *
 * Without the setting a document reaches OCR only as a fallback. With it
 * (and OCR switched on) the scan and the webhook send a new document, or one
 * that carries a chosen tag, to the OCR queue before any AI call, at most
 * once per document. Each scenario lists, in order, every call the pipeline
 * makes, the way tests/test-document-pipeline-callers.js does, so a call the
 * setting adds or saves shows up here.
 *
 * Covers: off (nothing changes), all, tagged (the tag matched by name in any
 * case, a document without it, a tag Paperless-ngx does not have, an empty
 * name, a tag list that cannot be read), OCR switched off, the at-most-once
 * rule (a document queued before, for any reason, is analysed instead; with
 * the text of its OCR run when Paperless-ngx refused it), the skip rules and
 * the ignored list before it, the manual rescan exemption, the webhook, and
 * the settings catalogue entries with their parsers.
 *
 * Runs offline: every collaborator is replaced through the require cache.
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const modulePaths = {
  config: require.resolve('../config/config'),
  documentModel: require.resolve('../models/document'),
  paperlessService: require.resolve('../services/paperlessService'),
  setupService: require.resolve('../services/setupService'),
  aiServiceFactory: require.resolve('../services/aiServiceFactory'),
  mistralOcrService: require.resolve('../services/mistralOcrService'),
  skipRuleService: require.resolve('../services/skipRuleService'),
  documentProcessingService:
    require.resolve('../services/documentProcessingService'),
  thumbnailCache: require.resolve('../services/thumbnailCache'),
  externalApiService: require.resolve('../services/externalApiService'),
};
const underTest = [
  require.resolve('../services/webhookQueueService'),
  path.join(ROOT, 'services', 'documentPipeline.js'),
];

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  [FAIL] ${name}: ${error.message}`);
  }
}

function inject(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

const DOC = { id: 7, title: 'Scan 0007' };
const TEXT = 'Invoice for the phone line, September. '.repeat(4);
const OCR_TEXT = 'Invoice No. 4711 for the phone line, September 2026. '.repeat(
  3
);
const ANALYSIS = { document: { title: 'Phone bill' } };
/* The tag list Paperless-ngx holds: the OCR tag is spelled in another case
   than the setting names it. */
const TAGS = [
  { id: 1, name: 'Tax' },
  { id: 5, name: 'Needs-OCR' },
];

/** A long string reads as its length, so the lists stay short. */
function show(value) {
  return JSON.stringify(value, (key, inner) =>
    typeof inner === 'string' && inner.length > 40
      ? `<${inner.length} chars>`
      : inner
  );
}

/**
 * Fresh fakes for one scenario.
 *
 * @param {object} scenario
 */
function makeWorld(scenario) {
  const s = {
    mode: 'off',
    tagName: 'needs-ocr',
    documentTags: [1],
    ocrEnabled: true,
    everQueued: false,
    ocrQueueItem: null,
    ocrQueueAccepts: true,
    content: TEXT,
    skipMatch: null,
    ignored: false,
    tagsFail: null,
    ...scenario,
  };
  const calls = [];
  const analysedTexts = [];
  const record =
    (name, result) =>
    async (...args) => {
      calls.push(`${name}(${args.map(show).join(', ')})`);
      return typeof result === 'function' ? result(...args) : result;
    };

  const fakes = {
    config: {
      minContentLength: 10,
      restrictToExistingTags: 'no',
      restrictToExistingCorrespondents: 'no',
      externalApiConfig: { enabled: 'no' },
      mistralOcr: { ocrBeforeAi: s.mode, ocrBeforeAiTag: s.tagName },
    },
    documentModel: {
      isDocumentProcessed: record('isDocumentProcessed', false),
      isDocumentIgnored: record('isDocumentIgnored', () => s.ignored),
      isDocumentFailed: record('isDocumentFailed', false),
      setProcessingStatus: record('setProcessingStatus'),
      addToOcrQueue: record('addToOcrQueue', () => s.ocrQueueAccepts),
      getOcrQueueItem: record('getOcrQueueItem', () => s.ocrQueueItem),
      wasEverQueuedForOcr: record('wasEverQueuedForOcr', () => s.everQueued),
      addFailedDocument: record('addFailedDocument'),
      deleteDocumentsIdList: record('deleteDocumentsIdList'),
    },
    paperlessService: {
      getPermissionOfDocument: record('getPermissionOfDocument', true),
      getDocumentContent: record('getDocumentContent', () => s.content),
      getDocument: record('getDocument', (id) => ({
        id,
        title: DOC.title,
        tags: s.documentTags,
      })),
      getTags: record('getTags', () => {
        if (s.tagsFail) throw new Error(s.tagsFail);
        return TAGS;
      }),
      listCorrespondentsNames: record('listCorrespondentsNames', []),
      listDocumentTypesNames: record('listDocumentTypesNames', []),
    },
    setupService: { isConfigured: record('isConfigured', true) },
    aiServiceFactory: {
      getService: () => ({
        analyzeDocument: record('analyzeDocument', (content) => {
          analysedTexts.push(content);
          return ANALYSIS;
        }),
      }),
    },
    mistralOcrService: {
      isEnabled: () => s.ocrEnabled,
      isDocumentActivelyProcessing: () => false,
    },
    skipRuleService: { apply: record('skipRules.apply', () => s.skipMatch) },
    documentProcessingService: {
      buildUpdateData: record('buildUpdateData', { title: 'Phone bill' }),
      saveDocumentChanges: record('saveDocumentChanges'),
    },
    thumbnailCache: { removeThumbnailCacheForDocumentIds: async () => {} },
    externalApiService: { fetchData: record('externalApi.fetchData', null) },
  };

  for (const key of Object.keys(modulePaths)) {
    delete require.cache[modulePaths[key]];
    inject(modulePaths[key], fakes[key]);
  }
  for (const modulePath of underTest) {
    delete require.cache[modulePath];
  }

  return { calls, analysedTexts, s };
}

async function quietly(fn) {
  const saved = {};
  const errors = [];
  for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
    saved[method] = console[method];
    console[method] = () => {};
  }
  console.error = (...args) => {
    const error = args.find((arg) => arg instanceof Error);
    if (error) errors.push(error.message);
  };
  try {
    return { value: await fn(), errors };
  } finally {
    Object.assign(console, saved);
  }
}

/** processDocument() the way the scan loop calls it, once. */
async function runScan(scenario, { prepare } = {}) {
  const world = makeWorld(scenario);
  const documentPipeline = require('../services/documentPipeline');
  if (prepare) prepare(documentPipeline);
  let outcome;
  await quietly(async () => {
    try {
      const result = await documentPipeline.processDocument(
        DOC,
        ['Tax'],
        [],
        [],
        { source: 'scan' }
      );
      outcome = result ? 'analysis' : 'null';
    } catch (error) {
      outcome = `throw ${error.message}`;
    }
  });
  return { ...world, outcome, documentPipeline };
}

/** One pass of the webhook queue: the webhook, or a rescan by hand. */
async function runQueue(scenario, { applySkipRules }) {
  const world = makeWorld(scenario);
  const webhookQueueService = require('../services/webhookQueueService');
  webhookQueueService.enqueue({ ...DOC }, { applySkipRules });
  const { errors } = await quietly(() => webhookQueueService.processQueue());
  return { ...world, errors };
}

// ── Expected call lists ─────────────────────────────────────────────────────

const START = [
  'isDocumentProcessed(7)',
  // OCR is on, so the queue is asked whether the document waits in it.
  'getOcrQueueItem(7)',
  'isDocumentIgnored(7)',
  'isDocumentFailed(7)',
  'setProcessingStatus(7, "Scan 0007", "processing")',
  'getPermissionOfDocument(7)',
  'getDocumentContent(7)',
  'getDocument(7)',
];
const skipRules = (tags = [1]) =>
  `skipRules.apply({"id":7,"title":"Scan 0007","tags":${JSON.stringify(tags)}}, "<156 chars>")`;
const ANALYZE =
  'analyzeDocument("<156 chars>", ["Tax"], [], [], 7, null, {"restrictToExistingTags":false,"restrictToExistingCorrespondents":false})';
const QUEUE_OCR_FIRST = [
  'isDocumentProcessed(7)',
  'addToOcrQueue(7, "Scan 0007", "ocr_before_ai", {"skipIfProcessed":true})',
];

async function main() {
  console.log('Helpers');

  const {
    OCR_BEFORE_AI_MODES,
    OCR_BEFORE_AI_REASON,
    parseOcrBeforeAiMode,
    normalizeOcrBeforeAiMode,
    documentCarriesTag,
  } = require('../services/ocrBeforeAi');

  await test('the three values; anything else is off', () => {
    assert.deepStrictEqual([...OCR_BEFORE_AI_MODES], ['off', 'tagged', 'all']);
    assert.strictEqual(OCR_BEFORE_AI_REASON, 'ocr_before_ai');
    assert.strictEqual(parseOcrBeforeAiMode(' ALL '), 'all');
    assert.strictEqual(parseOcrBeforeAiMode('Tagged'), 'tagged');
    assert.strictEqual(parseOcrBeforeAiMode('always'), null);
    assert.strictEqual(parseOcrBeforeAiMode(undefined), null);
    assert.strictEqual(normalizeOcrBeforeAiMode('always'), 'off');
    assert.strictEqual(normalizeOcrBeforeAiMode(''), 'off');
    assert.strictEqual(normalizeOcrBeforeAiMode('all'), 'all');
  });

  await test('the tag is matched by name in any case, through the tag ids', () => {
    assert.strictEqual(documentCarriesTag([1, 5], 'needs-ocr', TAGS), true);
    assert.strictEqual(documentCarriesTag(['5'], ' NEEDS-OCR ', TAGS), true);
    assert.strictEqual(
      documentCarriesTag([{ id: 5, name: 'Needs-OCR' }], 'needs-ocr', TAGS),
      true,
      'tags given as objects'
    );
    assert.strictEqual(documentCarriesTag([1], 'needs-ocr', TAGS), false);
    assert.strictEqual(documentCarriesTag([1, 5], 'no-such-tag', TAGS), false);
    assert.strictEqual(documentCarriesTag([1, 5], '', TAGS), false);
    assert.strictEqual(documentCarriesTag(undefined, 'needs-ocr', TAGS), false);
    assert.strictEqual(documentCarriesTag([5], 'needs-ocr', null), false);
  });

  console.log('Settings catalogue');

  const catalog = require('../services/settingsCatalog');

  await test('OCR_BEFORE_AI and its tag are OCR settings the page shows and saves', () => {
    for (const key of ['OCR_BEFORE_AI', 'OCR_BEFORE_AI_TAG']) {
      const entry = catalog.getEntry(key);
      assert.ok(entry, `${key} is in the catalogue`);
      assert.strictEqual(entry.group, 'OCR fallback', `${key} group`);
      assert.strictEqual(entry.restart, false, `${key} applies at once`);
      assert.strictEqual(entry.page, true, `${key} is on the page`);
      assert.strictEqual(entry.save, true, `${key} is saved`);
    }
    const mode = catalog.getEntry('OCR_BEFORE_AI');
    assert.strictEqual(mode.type, 'enum');
    assert.strictEqual(mode.default, 'off');
    assert.deepStrictEqual([...mode.values], ['off', 'tagged', 'all']);
    assert.strictEqual(mode.field, 'ocrBeforeAi');
    const tag = catalog.getEntry('OCR_BEFORE_AI_TAG');
    assert.strictEqual(tag.default, 'needs-ocr');
    assert.strictEqual(tag.field, 'ocrBeforeAiTag');
  });

  await test('the parsers: an unknown mode is saved as off, an empty tag as the default', () => {
    const parse = (key, raw) =>
      catalog.getEntry(key).parse(raw, catalog.getEntry(key).default);
    assert.deepStrictEqual(parse('OCR_BEFORE_AI', ' All '), { value: 'all' });
    assert.deepStrictEqual(parse('OCR_BEFORE_AI', 'tagged'), {
      value: 'tagged',
    });
    assert.deepStrictEqual(parse('OCR_BEFORE_AI', 'always'), {
      value: 'off',
      warning: '[WARN] Invalid OCR_BEFORE_AI value: always. Using default: off',
    });
    assert.deepStrictEqual(parse('OCR_BEFORE_AI', undefined), {});
    assert.deepStrictEqual(parse('OCR_BEFORE_AI_TAG', '  Scan-Me '), {
      value: 'Scan-Me',
    });
    assert.deepStrictEqual(parse('OCR_BEFORE_AI_TAG', '   '), {
      value: 'needs-ocr',
    });
    assert.deepStrictEqual(parse('OCR_BEFORE_AI_TAG', undefined), {});
  });

  console.log('Caller profiles');

  await test('the scan and the webhook apply it, a rescan by hand does not', () => {
    makeWorld({});
    const documentPipeline = require('../services/documentPipeline');
    const profiles = documentPipeline.CALLER_PROFILES;
    assert.strictEqual(profiles.scan.applyOcrBeforeAi, true);
    assert.strictEqual(profiles.webhook.applyOcrBeforeAi, true);
    assert.strictEqual(profiles.rescan.applyOcrBeforeAi, false);
  });

  console.log('Off and OCR switched off');

  await test('off: the calls are exactly those without the setting', async () => {
    const { calls, outcome } = await runScan({ mode: 'off' });
    assert.deepStrictEqual(calls, [...START, skipRules(), ANALYZE]);
    assert.strictEqual(outcome, 'analysis');
  });

  await test('all with OCR switched off: the setting does nothing', async () => {
    const { calls, outcome } = await runScan({
      mode: 'all',
      ocrEnabled: false,
    });
    assert.deepStrictEqual(calls, [
      'isDocumentProcessed(7)',
      'isDocumentIgnored(7)',
      'isDocumentFailed(7)',
      'setProcessingStatus(7, "Scan 0007", "processing")',
      'getPermissionOfDocument(7)',
      'getDocumentContent(7)',
      'getDocument(7)',
      skipRules(),
      ANALYZE,
    ]);
    assert.strictEqual(outcome, 'analysis');
  });

  console.log('All');

  await test('all: a new document goes to the OCR queue before any AI call', async () => {
    const { calls, outcome } = await runScan({ mode: 'all' });
    assert.deepStrictEqual(calls, [
      ...START,
      skipRules(),
      'wasEverQueuedForOcr(7)',
      ...QUEUE_OCR_FIRST,
    ]);
    assert.strictEqual(outcome, 'null');
  });

  await test('all: earlier failures on the old text no longer count once it is queued', async () => {
    const { outcome, documentPipeline } = await runScan(
      { mode: 'all' },
      { prepare: (pipeline) => pipeline.retryTracker.set(7, 2) }
    );
    assert.strictEqual(outcome, 'null');
    assert.strictEqual(documentPipeline.retryTracker.has(7), false);
  });

  await test('all: a refused insert still leaves the analysis to the OCR path', async () => {
    const { calls, outcome } = await runScan({
      mode: 'all',
      ocrQueueAccepts: false,
    });
    // The refusal is explained from the queue row; nothing is analysed.
    assert.deepStrictEqual(calls.slice(-1), ['getOcrQueueItem(7)']);
    assert.ok(!calls.some((call) => call.startsWith('analyzeDocument')));
    assert.strictEqual(outcome, 'null');
  });

  console.log('Tagged');

  await test('tagged: a document with the tag (in another case) is queued', async () => {
    const { calls, outcome } = await runScan({
      mode: 'tagged',
      documentTags: [1, 5],
    });
    assert.deepStrictEqual(calls, [
      ...START,
      skipRules([1, 5]),
      'getTags()',
      'wasEverQueuedForOcr(7)',
      ...QUEUE_OCR_FIRST,
    ]);
    assert.strictEqual(outcome, 'null');
  });

  await test('tagged: a document without the tag is analysed right away', async () => {
    const { calls, outcome } = await runScan({
      mode: 'tagged',
      documentTags: [1],
    });
    assert.deepStrictEqual(calls, [
      ...START,
      skipRules(),
      'getTags()',
      ANALYZE,
    ]);
    assert.strictEqual(outcome, 'analysis');
  });

  await test('tagged: a tag Paperless-ngx does not have matches nothing, without an error', async () => {
    const { calls, outcome } = await runScan({
      mode: 'tagged',
      tagName: 'never-created',
      documentTags: [1, 5],
    });
    assert.deepStrictEqual(calls, [
      ...START,
      skipRules([1, 5]),
      'getTags()',
      ANALYZE,
    ]);
    assert.strictEqual(outcome, 'analysis');
  });

  await test('tagged: an empty tag name matches nothing and reads no tag list', async () => {
    const { calls, outcome } = await runScan({
      mode: 'tagged',
      tagName: '',
      documentTags: [1, 5],
    });
    assert.deepStrictEqual(calls, [...START, skipRules([1, 5]), ANALYZE]);
    assert.strictEqual(outcome, 'analysis');
  });

  await test('tagged: a tag list that cannot be read leaves the document for the next run', async () => {
    const { calls, outcome } = await runScan({
      mode: 'tagged',
      documentTags: [1, 5],
      tagsFail: 'connect ECONNREFUSED',
    });
    assert.match(outcome, /^throw Could not read the Paperless-ngx tag list/);
    assert.match(outcome, /needs-ocr/);
    assert.match(outcome, /ECONNREFUSED/);
    assert.ok(!calls.some((call) => call.startsWith('analyzeDocument')));
    assert.ok(!calls.some((call) => call.startsWith('addToOcrQueue')));
  });

  console.log('At most once');

  await test('a document queued before is analysed, not queued again', async () => {
    for (const [label, item] of [
      ['done and written back', { status: 'done', wrote_back: 1 }],
      ['OCR failed', { status: 'failed', wrote_back: null }],
      ['removed from the queue', null],
      ['done before write-backs were recorded', { status: 'done' }],
    ]) {
      const { calls, outcome, analysedTexts } = await runScan({
        mode: 'all',
        everQueued: true,
        ocrQueueItem: item,
      });
      assert.deepStrictEqual(
        calls,
        [
          ...START,
          skipRules(),
          'wasEverQueuedForOcr(7)',
          'getOcrQueueItem(7)',
          ANALYZE,
        ],
        label
      );
      assert.strictEqual(outcome, 'analysis', label);
      assert.deepStrictEqual(analysedTexts, [TEXT], label);
    }
  });

  await test('a refused write-back: the analysis reads the text of the OCR run', async () => {
    const { outcome, analysedTexts, calls } = await runScan({
      mode: 'all',
      everQueued: true,
      ocrQueueItem: { status: 'done', wrote_back: 0, ocr_text: OCR_TEXT },
    });
    assert.strictEqual(outcome, 'analysis');
    assert.deepStrictEqual(analysedTexts, [OCR_TEXT]);
    assert.ok(!calls.some((call) => call.startsWith('addToOcrQueue')));
  });

  await test('a refused write-back without stored text keeps the Paperless-ngx text', async () => {
    const { analysedTexts } = await runScan({
      mode: 'all',
      everQueued: true,
      ocrQueueItem: { status: 'done', wrote_back: 0, ocr_text: '   ' },
    });
    assert.deepStrictEqual(analysedTexts, [TEXT]);
  });

  await test('tagged: a tagged document queued before is analysed, not queued again', async () => {
    const { calls, outcome } = await runScan({
      mode: 'tagged',
      documentTags: [5],
      everQueued: true,
      ocrQueueItem: { status: 'done', wrote_back: 1 },
    });
    assert.ok(calls.includes('wasEverQueuedForOcr(7)'));
    assert.ok(!calls.some((call) => call.startsWith('addToOcrQueue')));
    assert.strictEqual(outcome, 'analysis');
  });

  console.log('What comes first');

  await test('the skip rules win: an ignored document costs neither OCR nor AI', async () => {
    const { calls, outcome } = await runScan({
      mode: 'all',
      skipMatch: { reason: 'Page limit' },
    });
    assert.deepStrictEqual(calls, [...START, skipRules()]);
    assert.strictEqual(outcome, 'null');
  });

  await test('a document on the ignored list is left before anything is fetched', async () => {
    const { calls, outcome } = await runScan({ mode: 'all', ignored: true });
    assert.deepStrictEqual(calls, [
      'isDocumentProcessed(7)',
      'getOcrQueueItem(7)',
      'isDocumentIgnored(7)',
    ]);
    assert.strictEqual(outcome, 'null');
  });

  await test('short text in mode all goes to the queue as OCR before AI, not as short content', async () => {
    const { calls } = await runScan({ mode: 'all', content: 'x' });
    assert.ok(
      calls.includes(
        'addToOcrQueue(7, "Scan 0007", "ocr_before_ai", {"skipIfProcessed":true})'
      )
    );
    assert.ok(!calls.some((call) => call.includes('short_content')));
  });

  console.log('Callers');

  await test('the webhook sends a new document to OCR first', async () => {
    const { calls, errors } = await runQueue(
      { mode: 'all' },
      { applySkipRules: true }
    );
    assert.deepStrictEqual(errors, []);
    assert.ok(
      calls.includes(
        'addToOcrQueue(7, "Scan 0007", "ocr_before_ai", {"skipIfProcessed":true})'
      )
    );
    assert.ok(!calls.some((call) => call.startsWith('analyzeDocument')));
    assert.ok(!calls.some((call) => call.startsWith('saveDocumentChanges')));
  });

  await test('a rescan by hand analyses now and never asks about OCR first', async () => {
    const { calls, errors } = await runQueue(
      { mode: 'all' },
      { applySkipRules: false }
    );
    assert.deepStrictEqual(errors, []);
    assert.ok(!calls.includes('wasEverQueuedForOcr(7)'));
    assert.ok(!calls.some((call) => call.startsWith('addToOcrQueue')));
    assert.ok(calls.some((call) => call.startsWith('analyzeDocument')));
    assert.ok(calls.some((call) => call.startsWith('saveDocumentChanges')));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
