/**
 * Test: tags come off a document once its analysis was written back
 *
 * Whoever files documents through the Paperless-ngx inbox had to open every
 * processed document and take the inbox tag off by hand, because the
 * write-back only ever added tags (the union of the document's tags and the
 * proposed ones). Two settings make a processed document done:
 * REMOVE_INBOX_TAGS_AFTER_PROCESSING takes every tag Paperless-ngx marks as
 * inbox tag off, REMOVE_TAGS_AFTER_PROCESSING names further tags. Both apply
 * in the same PATCH that writes the analysis.
 *
 * Covers, driving paperlessService.updateDocument() against a stub client:
 * a. switch off, list empty: the union as before
 * b. switch on: inbox tags gone, other tags and the AI-processed tag kept
 * c. named list: those tags gone, matched case-insensitively
 * d. the analysis proposes the inbox tag itself: still removed
 * e. tag list unreadable: nothing removed, warned once, the write still happens
 * f. an update without tags: untouched, the tag list is not even read
 * g. both settings are read live
 * h. the tagging-off write-back still carries a tag list when removal is on
 * i. restoring the original tags is not subject to removal
 */

'use strict';

process.env.DUPLICATES_GUARD_NEW_NAMES = 'no';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// documentProcessingService loads models/document.js, which opens
// data/documents.db relative to the working directory. A throwaway directory
// keeps this offline test away from a real database.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-remove-tags-'));
fs.mkdirSync(path.join(tmpDir, 'data'));
process.chdir(tmpDir);
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const config = require('../config/config');
const paperlessService = require('../services/paperlessService');
const documentProcessingService = require('../services/documentProcessingService');

const TAGS = [
  { id: 1, name: 'Inbox', is_inbox_tag: true },
  { id: 2, name: 'Neu', is_inbox_tag: true },
  { id: 3, name: 'Invoice', is_inbox_tag: false },
  { id: 4, name: 'ai-processed', is_inbox_tag: false },
  { id: 5, name: 'ToDo', is_inbox_tag: false },
  { id: 6, name: 'Insurance', is_inbox_tag: false },
];

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

/** A Paperless-ngx with one document and the tag list above. */
function createServer({ docTags, tagListFails = false }) {
  const calls = { patches: [], tagReads: 0 };
  const doc = { id: 42, title: 'Doc', tags: [...docTags], correspondent: null };
  return {
    calls,
    doc,
    defaults: { baseURL: 'http://paperless.test/api' },
    get: async (url) => {
      if (url.startsWith('/tags/')) {
        calls.tagReads += 1;
        if (tagListFails) throw new Error('tag list unavailable');
        return { data: { count: TAGS.length, results: TAGS, next: null } };
      }
      if (url === '/documents/42/') return { data: { ...doc } };
      throw new Error(`unexpected GET ${url}`);
    },
    patch: async (url, body) => {
      calls.patches.push({ url, body });
      if (body.tags) doc.tags = [...body.tags];
      return { data: {} };
    },
  };
}

async function withServer(server, fn) {
  const originalClient = paperlessService.client;
  paperlessService.client = server;
  paperlessService.tags.invalidate();
  paperlessService._removeTagsWarned = false;
  try {
    return await fn();
  } finally {
    paperlessService.client = originalClient;
    paperlessService.tags.invalidate();
  }
}

function configure({ inbox = 'no', names = '' }) {
  process.env.REMOVE_INBOX_TAGS_AFTER_PROCESSING = inbox;
  process.env.REMOVE_TAGS_AFTER_PROCESSING = names;
}

const sorted = (ids) => [...ids].sort((a, b) => a - b);

async function captureLogs(fn) {
  const lines = { log: [], warn: [] };
  const original = { log: console.log, warn: console.warn };
  console.log = (...args) => lines.log.push(args.join(' '));
  console.warn = (...args) => lines.warn.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
  }
  return lines;
}

async function main() {
  await test('a. switch off and list empty: the union as before', async () => {
    configure({});
    const server = createServer({ docTags: [1, 5] });
    await withServer(server, () =>
      paperlessService.updateDocument(42, { tags: [3, 4], title: 'T' })
    );
    assert.strictEqual(server.calls.patches.length, 1);
    assert.deepStrictEqual(
      sorted(server.calls.patches[0].body.tags),
      [1, 3, 4, 5]
    );
    assert.strictEqual(
      server.calls.tagReads,
      0,
      'with nothing to remove the tag list is not read'
    );
  });

  await test('b. switch on: every inbox tag goes, the rest and the AI-processed tag stay', async () => {
    configure({ inbox: 'yes' });
    const server = createServer({ docTags: [1, 2, 5] });
    let logs;
    await withServer(server, async () => {
      logs = await captureLogs(() =>
        paperlessService.updateDocument(42, { tags: [3, 4] })
      );
    });
    assert.deepStrictEqual(
      sorted(server.calls.patches[0].body.tags),
      [3, 4, 5]
    );
    const line = logs.log.find((l) =>
      l.includes('Removed tags after processing')
    );
    assert.ok(line, 'one [DEBUG] line names what was removed');
    assert.ok(line.startsWith('[DEBUG]'));
    assert.ok(line.includes('Inbox (1)') && line.includes('Neu (2)'), line);
  });

  await test('c. named list: those tags go, matched case-insensitively', async () => {
    configure({ names: 'todo, INSURANCE,unknown-tag' });
    const server = createServer({ docTags: [1, 5, 6] });
    await withServer(server, () =>
      paperlessService.updateDocument(42, { tags: [3] })
    );
    assert.deepStrictEqual(
      sorted(server.calls.patches[0].body.tags),
      [1, 3],
      'the inbox tag stays while the switch is off; a name with no tag is ignored'
    );
  });

  await test('d. the analysis proposes the inbox tag itself: it still comes off', async () => {
    configure({ inbox: 'yes' });
    const server = createServer({ docTags: [] });
    await withServer(server, () =>
      paperlessService.updateDocument(42, { tags: [1, 3] })
    );
    assert.deepStrictEqual(server.calls.patches[0].body.tags, [3]);

    configure({ names: 'invoice' });
    const second = createServer({ docTags: [] });
    await withServer(second, () =>
      paperlessService.updateDocument(42, { tags: [3, 4] })
    );
    assert.deepStrictEqual(
      second.calls.patches[0].body.tags,
      [4],
      'the removal list wins over a proposed tag'
    );
  });

  await test('e. tag list unreadable: nothing removed, warned once, the write happens', async () => {
    configure({ inbox: 'yes', names: 'todo' });
    const server = createServer({ docTags: [1, 5], tagListFails: true });
    let logs;
    let result;
    await withServer(server, async () => {
      logs = await captureLogs(async () => {
        result = await paperlessService.updateDocument(42, { tags: [3] });
        await paperlessService.updateDocument(42, { tags: [4] });
      });
    });
    assert.strictEqual(server.calls.patches.length, 2, 'both writes happen');
    assert.deepStrictEqual(
      sorted(server.calls.patches[0].body.tags),
      [1, 3, 5]
    );
    assert.ok(result, 'updateDocument still returns the document');
    const warnings = logs.warn.filter((l) =>
      l.includes('no tags are removed after processing')
    );
    assert.strictEqual(warnings.length, 1, 'warned once, not per document');
  });

  await test('f. an update without tags is left alone', async () => {
    configure({ inbox: 'yes', names: 'todo' });
    const server = createServer({ docTags: [1, 5] });
    await withServer(server, () =>
      paperlessService.updateDocument(42, { title: 'Only a title' })
    );
    assert.ok(!('tags' in server.calls.patches[0].body));
    assert.strictEqual(server.calls.tagReads, 0);
  });

  await test('g. both settings are read live', async () => {
    configure({});
    assert.strictEqual(config.removeInboxTagsAfterProcessing, 'no');
    assert.deepStrictEqual(config.removeTagsAfterProcessing, []);
    configure({ inbox: 'true', names: ' a ,b,, c' });
    assert.strictEqual(config.removeInboxTagsAfterProcessing, 'yes');
    assert.deepStrictEqual(config.removeTagsAfterProcessing, ['a', 'b', 'c']);
    delete process.env.REMOVE_INBOX_TAGS_AFTER_PROCESSING;
    delete process.env.REMOVE_TAGS_AFTER_PROCESSING;
    assert.strictEqual(config.removeInboxTagsAfterProcessing, 'no');
    assert.deepStrictEqual(config.removeTagsAfterProcessing, []);

    const restartKeys = require('../config/restartRequiredKeys');
    const list = [
      ...(restartKeys.RESTART_REQUIRED_KEYS || restartKeys.default || []),
    ];
    assert.ok(
      !list.includes('REMOVE_INBOX_TAGS_AFTER_PROCESSING') &&
        !list.includes('REMOVE_TAGS_AFTER_PROCESSING'),
      'neither key needs a restart'
    );
  });

  await test('h. with tagging off, the write-back still carries a tag list when removal is on', async () => {
    const previous = {
      ACTIVATE_TAGGING: process.env.ACTIVATE_TAGGING,
      ADD_AI_PROCESSED_TAG: process.env.ADD_AI_PROCESSED_TAG,
      ACTIVATE_TITLE: process.env.ACTIVATE_TITLE,
      ACTIVATE_DOCUMENT_TYPE: process.env.ACTIVATE_DOCUMENT_TYPE,
      ACTIVATE_CORRESPONDENTS: process.env.ACTIVATE_CORRESPONDENTS,
      ACTIVATE_CUSTOM_FIELDS: process.env.ACTIVATE_CUSTOM_FIELDS,
    };
    Object.assign(process.env, {
      ACTIVATE_TAGGING: 'no',
      ADD_AI_PROCESSED_TAG: 'no',
      ACTIVATE_TITLE: 'no',
      ACTIVATE_DOCUMENT_TYPE: 'no',
      ACTIVATE_CORRESPONDENTS: 'no',
      ACTIVATE_CUSTOM_FIELDS: 'no',
    });
    try {
      const analysis = { document: { tags: ['x'], document_date: null } };
      const doc = { id: 42, title: 'Doc', created: '2026-01-01' };

      configure({});
      const without = await documentProcessingService.buildUpdateData(
        analysis,
        doc
      );
      assert.ok(!('tags' in without), 'nothing to add, nothing to remove');

      configure({ inbox: 'yes' });
      const withRemoval = await documentProcessingService.buildUpdateData(
        analysis,
        doc
      );
      assert.deepStrictEqual(withRemoval.tags, []);

      const server = createServer({ docTags: [1, 5] });
      await withServer(server, () =>
        paperlessService.updateDocument(42, withRemoval)
      );
      assert.deepStrictEqual(server.calls.patches[0].body.tags, [5]);
    } finally {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  await test('i. restoring the original tags is not subject to removal', async () => {
    configure({ inbox: 'yes', names: 'todo' });
    const server = createServer({ docTags: [3] });
    await withServer(server, () =>
      paperlessService.restoreDocument(42, { tags: [1, 5] })
    );
    assert.deepStrictEqual(server.calls.patches[0].body.tags, [1, 5]);
  });

  configure({});
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exitCode = 1;
});
