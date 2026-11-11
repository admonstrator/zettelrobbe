/**
 * Reproduces the broken "Process only specific pre-tagged documents" workflow.
 *
 * The operator assigns a trigger tag (e.g. perform-ai-scan) in Paperless-ngx,
 * expecting Zettelrobbe to process the document — including AGAIN, when the
 * tag is set on a document that was already analysed (the documented way to
 * re-run documents after fixing a bug).
 *
 * processDocument() used to consult processed_documents before anything
 * else, so a re-tagged document was silently skipped forever. Taking the
 * trigger tag off after processing is REMOVE_TAGS_AFTER_PROCESSING's job
 * (see test-remove-tags-after-processing.js).
 *
 * Covers:
 * 1. The scan loop re-processes a tagged document that is already recorded
 *    as processed (source-level guard, since the loop lives in server.js)
 * 2. Ignored and permanently-failed documents stay protected
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
