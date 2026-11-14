/**
 * The scan loop, the manual queue and the OCR service write their results
 * back through one documentProcessingService. Before that each carried its own
 * copy, and the copies drifted: the queue recorded documents as processed when
 * Paperless-ngx had rejected the update, and the OCR path dropped custom
 * fields and never saved the "restore original" snapshot.
 *
 * Runs offline: config, Paperless-ngx, the database and the dashboard cache
 * are replaced through the require cache.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const modulePaths = {
  config: require.resolve('../config/config'),
  paperlessService: require.resolve('../services/paperlessService'),
  documentModel: require.resolve('../models/document'),
  dashboardStatsService: require.resolve('../services/dashboardStatsService'),
  aiServiceFactory: require.resolve('../services/aiServiceFactory'),
  documentProcessingService:
    require.resolve('../services/documentProcessingService'),
  mistralOcrService: require.resolve('../services/mistralOcrService'),
};

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

/**
 * Load the service (and optionally the OCR service) against fresh mocks.
 *
 * @param {Object} [overrides]
 * @param {Object|null} [overrides.updateResult] What updateDocument resolves to.
 * @param {Object} [overrides.analysis] What the AI service returns (OCR path).
 * @param {Object|null} [overrides.correspondent] What getOrCreateCorrespondent resolves to.
 * @param {Object} [overrides.limitFunctions] Feature toggles over the all-on default.
 */
function load({
  updateResult = { id: 42 },
  analysis = null,
  correspondent = { id: 7, name: 'Telekom' },
  limitFunctions = {},
} = {}) {
  Object.values(modulePaths).forEach((modulePath) => {
    delete require.cache[modulePath];
  });

  const calls = [];
  const record =
    (name, result) =>
    async (...args) => {
      calls.push({ name, args });
      return typeof result === 'function' ? result(...args) : result;
    };

  inject(modulePaths.config, {
    limitFunctions: {
      activateTagging: 'yes',
      activateCorrespondents: 'yes',
      activateDocumentType: 'yes',
      activateTitle: 'yes',
      activateCustomFields: 'yes',
      ...limitFunctions,
    },
    restrictToExistingTags: 'no',
    restrictToExistingCorrespondents: 'no',
    restrictToExistingDocumentTypes: 'no',
    addAIProcessedTag: 'no',
  });

  const customFieldTypes = { notes: 'longtext', 'invoice number': 'string' };
  inject(modulePaths.paperlessService, {
    processTags: record('processTags', { tagIds: [1, 2], errors: [] }),
    getOrCreateDocumentType: record('getOrCreateDocumentType', {
      id: 3,
      name: 'Invoice',
    }),
    getOrCreateCorrespondent: record('getOrCreateCorrespondent', correspondent),
    getExistingCustomFields: record('getExistingCustomFields', [
      { field: 5, value: 'old notes' },
      { field: 9, value: 'kept' },
    ]),
    findExistingCustomField: record('findExistingCustomField', (name) => {
      const key = name.toLowerCase();
      if (!customFieldTypes[key]) return null;
      return { id: key === 'notes' ? 5 : 6, data_type: customFieldTypes[key] };
    }),
    updateDocument: record('updateDocument', updateResult),
    getTags: async () => [],
    listCorrespondentsNames: async () => [],
    listDocumentTypesNames: async () => [],
    getDocument: async (id) => ({
      id,
      title: 'Scan 0001',
      created: '2026-09-01',
      tags: [4],
      correspondent: 11,
      document_type: null,
    }),
  });

  inject(modulePaths.documentModel, {
    saveOriginalData: record('saveOriginalData', true),
    addProcessedDocument: record('addProcessedDocument', true),
    addToHistory: record('addToHistory', true),
    addOpenAIMetrics: record('addOpenAIMetrics', true),
  });

  inject(modulePaths.dashboardStatsService, {
    invalidate: () => calls.push({ name: 'invalidate', args: [] }),
  });

  inject(modulePaths.aiServiceFactory, {
    getService: () => ({ analyzeDocument: async () => analysis }),
  });

  const documentProcessingService = require('../services/documentProcessingService');
  const mistralOcrService = require('../services/mistralOcrService');
  const callsTo = (name) => calls.filter((call) => call.name === name);
  const indexOf = (name) => calls.findIndex((call) => call.name === name);
  return { documentProcessingService, mistralOcrService, callsTo, indexOf };
}

const LONG_NOTES = 'Line of notes.\n'.repeat(20).trim();

function sampleAnalysis() {
  return {
    document: {
      title: 'Phone bill September',
      tags: ['Phone', 'Bill'],
      correspondent: 'Deutsche Telekom AG',
      document_type: 'Bill',
      document_date: '2026-09-03',
      language: 'de',
      custom_fields: {
        0: { field_name: 'Notes', value: LONG_NOTES },
        1: { field_name: 'Invoice number', value: 'X'.repeat(200) },
        2: null,
        3: { field_name: 'Unknown field', value: 'ignored' },
      },
    },
    metrics: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

async function main() {
  await test('buildUpdateData merges custom fields into the existing ones', async () => {
    const { documentProcessingService } = load();
    const updateData = await documentProcessingService.buildUpdateData(
      sampleAnalysis(),
      { id: 42, title: 'Scan 0001', created: '2026-09-01' }
    );

    assert.deepStrictEqual(updateData.tags, [1, 2]);
    assert.strictEqual(updateData.title, 'Phone bill September');
    assert.strictEqual(updateData.document_type, 3);
    assert.strictEqual(updateData.correspondent, 7);
    assert.deepStrictEqual(
      updateData.custom_fields,
      [
        { field: 5, value: LONG_NOTES },
        { field: 9, value: 'kept' },
      ],
      'longtext keeps its long value, the over-long string and the unknown field are dropped, the untouched field stays'
    );
    assert.deepStrictEqual(updateData._customFieldsForHistory, [
      { field_name: 'Notes', value: LONG_NOTES },
    ]);
  });

  await test('saveDocumentChanges snapshots first and strips history-only data', async () => {
    const { documentProcessingService, callsTo, indexOf } = load();
    const updateData = await documentProcessingService.buildUpdateData(
      sampleAnalysis(),
      { id: 42, title: 'Scan 0001', created: '2026-09-01' }
    );
    await documentProcessingService.saveDocumentChanges(
      42,
      updateData,
      sampleAnalysis(),
      { title: 'Scan 0001', tags: [4], correspondent: 11 }
    );

    assert.ok(
      indexOf('saveOriginalData') < indexOf('updateDocument'),
      'the restore snapshot is written before Paperless-ngx is changed'
    );
    const [, payload] = callsTo('updateDocument')[0].args;
    assert.ok(
      Object.keys(payload).every((key) => !key.startsWith('_')),
      'no history-only key reaches Paperless-ngx'
    );
    assert.strictEqual(callsTo('addProcessedDocument').length, 1);
    assert.strictEqual(callsTo('addOpenAIMetrics').length, 1);
    assert.strictEqual(callsTo('invalidate').length, 1);
    const historyArgs = callsTo('addToHistory')[0].args;
    assert.deepStrictEqual(historyArgs[4], [
      { field_name: 'Notes', value: LONG_NOTES },
    ]);
  });

  await test('a rejected update records nothing as processed', async () => {
    const { documentProcessingService, callsTo } = load({ updateResult: null });
    const updateData = await documentProcessingService.buildUpdateData(
      sampleAnalysis(),
      { id: 42, title: 'Scan 0001' }
    );
    await assert.rejects(
      documentProcessingService.saveDocumentChanges(
        42,
        updateData,
        sampleAnalysis(),
        { title: 'Scan 0001' }
      ),
      /Paperless update failed for document 42/
    );
    assert.strictEqual(callsTo('saveOriginalData').length, 1);
    assert.strictEqual(callsTo('addProcessedDocument').length, 0);
    assert.strictEqual(callsTo('addToHistory').length, 0);
    assert.strictEqual(callsTo('addOpenAIMetrics').length, 0);
  });

  await test('title generation off records the document title, not null', async () => {
    const { documentProcessingService, callsTo } = load();
    const updateData = { tags: [1] };
    await documentProcessingService.saveDocumentChanges(
      42,
      updateData,
      { document: {} },
      { title: 'Scan 0001' }
    );
    assert.strictEqual(callsTo('addProcessedDocument')[0].args[1], 'Scan 0001');
    assert.strictEqual(callsTo('addToHistory')[0].args[2], 'Scan 0001');
  });

  await test('history records the names Paperless-ngx has, not the model answer', async () => {
    const { documentProcessingService, callsTo } = load();
    const updateData = await documentProcessingService.buildUpdateData(
      sampleAnalysis(),
      { id: 42, title: 'Scan 0001' }
    );
    await documentProcessingService.saveDocumentChanges(
      42,
      updateData,
      sampleAnalysis(),
      { title: 'Scan 0001' }
    );
    const historyArgs = callsTo('addToHistory')[0].args;
    assert.strictEqual(
      historyArgs[3],
      'Telekom',
      'the correspondent the model named was mapped to an existing one'
    );
    assert.strictEqual(historyArgs[5], 'Invoice');
  });

  await test('history stays empty for what was not set', async () => {
    const { documentProcessingService, callsTo } = load({
      correspondent: null,
      limitFunctions: { activateDocumentType: 'no' },
    });
    const updateData = await documentProcessingService.buildUpdateData(
      sampleAnalysis(),
      { id: 42, title: 'Scan 0001' }
    );
    assert.strictEqual(updateData.correspondent, undefined);
    assert.strictEqual(updateData.document_type, undefined);
    await documentProcessingService.saveDocumentChanges(
      42,
      updateData,
      sampleAnalysis(),
      { title: 'Scan 0001' }
    );
    const historyArgs = callsTo('addToHistory')[0].args;
    assert.strictEqual(
      historyArgs[3],
      null,
      'a correspondent the restriction rejected was never written'
    );
    assert.strictEqual(
      historyArgs[5],
      null,
      'document type detection is off, so the document type was never written'
    );
  });

  await test('the OCR path writes custom fields and the restore snapshot', async () => {
    const { mistralOcrService, callsTo } = load({ analysis: sampleAnalysis() });
    await mistralOcrService._runAiAnalysis(42, 'OCR text');

    const [docId, payload] = callsTo('updateDocument')[0].args;
    assert.strictEqual(docId, 42);
    assert.deepStrictEqual(payload.custom_fields, [
      { field: 5, value: LONG_NOTES },
      { field: 9, value: 'kept' },
    ]);
    assert.strictEqual(callsTo('saveOriginalData').length, 1);
  });

  await test('scan loop, queue and OCR call the shared write-back', async () => {
    const files = [
      path.join('services', 'scanService.js'),
      path.join('services', 'webhookQueueService.js'),
      path.join('services', 'mistralOcrService.js'),
    ];
    files.forEach((file) => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(
        !/async function (buildUpdateData|saveDocumentChanges)\b/.test(source),
        `${file} must not carry its own copy of the write-back`
      );
      assert.ok(
        source.includes('documentProcessingService.buildUpdateData(') &&
          source.includes('documentProcessingService.saveDocumentChanges('),
        `${file} must write back through documentProcessingService`
      );
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exitCode = 1;
});
