/**
 * Reproduces the broken "Process only specific pre-tagged documents" workflow.
 *
 * The operator assigns a trigger tag (e.g. perform-ai-scan) in Paperless-ngx,
 * expecting Zettelrobbe to process the document — including AGAIN, when the
 * tag is set on a document that was already analysed (the documented way to
 * re-run documents after fixing a bug).
 *
 * Two defects made that workflow impossible:
 * 1. processDocument() consulted processed_documents before anything else, so
 *    a re-tagged document was silently skipped forever.
 * 2. updateDocument() merged the AI tag list into the current tags, so the
 *    trigger tag stuck around after processing instead of being removed.
 *
 * Covers:
 * 1. The scan loop re-processes a tagged document that is already recorded
 *    as processed (source-level guard, since the loop lives in server.js)
 * 2. Ignored and permanently-failed documents stay protected
 * 3. updateDocument() drops the trigger tag from the merged payload when
 *    asked to (functional, against a mocked Paperless API)
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

const serverSource = fs.readFileSync(
  path.join(process.cwd(), 'server.js'),
  'utf8'
);

test('A tagged document is re-processed even when already recorded', () => {
  // The processed-documents guard must not fire unconditionally: in
  // predefined mode the presence of a configured trigger tag is the
  // operator's explicit request to run the document again.
  assert.match(
    serverSource,
    /isDocumentProcessed\(doc\.id\)[\s\S]{0,600}?predefined/i,
    'The isProcessed guard must consider the predefined trigger tags'
  );
});

test('The re-trigger respects ignored and permanently-failed documents', () => {
  const processedIdx = serverSource.indexOf('isDocumentProcessed(doc.id)');
  const ignoredIdx = serverSource.indexOf('isDocumentIgnored(doc.id)');
  const failedIdx = serverSource.indexOf('isDocumentFailed(doc.id)');
  assert.ok(processedIdx !== -1 && ignoredIdx !== -1 && failedIdx !== -1);
  // Ignored/failed checks come after the processed check but must NOT sit
  // behind the re-trigger bypass, or a re-tagged ignore would resurrect.
  const between = serverSource.slice(ignoredIdx, failedIdx + 200);
  assert.ok(
    !/return null;\s*\}\s*\n\s*\/\/.*predefined|re-?trigger/i.test(between),
    'Ignored/failed guards must stay ahead of any re-trigger logic'
  );
});

(async () => {
  // ── updateDocument drops the trigger tag on request ──────────────────────
  process.env.PAPERLESS_API_URL = 'http://paperless.test';
  process.env.PAPERLESS_API_TOKEN = 'test-token';

  const calls = [];
  const paperlessService = require('../services/paperlessService');

  const originalClient = paperlessService.client;
  paperlessService.client = {
    defaults: { baseURL: 'http://paperless.test/api' },
    get: async (url) => {
      calls.push({ method: 'get', url });
      if (url === '/documents/315/') {
        return {
          data: {
            id: 315,
            tags: [11, 42], // 42 is the trigger tag
            correspondent: 7,
          },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    patch: async (url, body) => {
      calls.push({ method: 'patch', url, body });
      if (url === '/documents/315/') {
        return { data: { ok: true } };
      }
      throw new Error(`unexpected PATCH ${url}`);
    },
    post: async (url) => {
      throw new Error(`unexpected POST ${url}`);
    },
  };

  try {
    await test('updateDocument removes configured tag ids from the merged payload', async () => {
      await paperlessService.updateDocument(315, {
        title: 'New title',
        tags: [5], // AI-chosen tags
        removeTagIds: [42], // the predefined-mode trigger tag
      });

      const updateCall = calls.find((call) => call.method === 'patch');
      assert.ok(updateCall, 'an update request was sent');
      const sentTags = updateCall.body.tags;
      assert.deepStrictEqual(
        [...sentTags].sort((a, b) => a - b),
        [5, 11],
        'AI tags merge with existing tags, the trigger tag is gone'
      );
      assert.strictEqual(
        sentTags.includes(42),
        false,
        'the trigger tag must not survive the write-back'
      );
    });
  } finally {
    paperlessService.client = originalClient;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
