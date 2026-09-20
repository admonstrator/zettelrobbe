/**
 * Test: services/duplicateMergeService.js
 *
 * The merge service is the only place in Zettelrobbe that deletes objects in
 * Paperless-ngx. Everything below is written from that angle: what has to be
 * true before a DELETE goes out, what has to be written down before it does,
 * and what an undo can still rebuild from those notes once the object is gone.
 *
 * The Paperless-ngx side is a real store (tests/helpers/fake-paperless.js)
 * rather than a per-case mock, so document_count, the case sensitivity of
 * names and the permission flag behave consistently. The local side is the
 * real models/document.js on a throwaway database.
 *
 * Covers:
 *  1. listEntities pages, keeps asking for page n+1 and never follows `next`
 *  2. scan groups, counts per kind, hides dismissed pairs and carries the URL
 *  3. scan refuses an unknown kind and reports an unreachable instance as 502
 *  4. Tags: documents move, the target survives on documents that had it,
 *     the source is deleted, the log carries what an undo needs, local rows
 *     are rewritten and the caches are dropped
 *  5. Correspondents: history rewritten by name, originals by id
 *  6. A source that still has a document after the move is NOT deleted
 *  7. A source the token may not change is skipped with a reason
 *  8. A running scan refuses the merge (409)
 *  9. Validation: unknown kind, target among the sources, empty sources
 * 10. copyMatchingRule copies once, and only when asked and only when the
 *     target has no rule of its own
 * 11. Undo: source re-created, documents handed back, the target only removed
 *     where it was not there before, rule reverted, local rows rewritten back
 * 12. Undo adopts a same-named object instead of creating a second one
 * 13. Undo skips documents that were deleted or changed meanwhile
 * 14. Undo twice is refused (409)
 * 15. Undo does not revert a matching rule the user changed since the merge
 * 16. A half-done undo stays retryable and finishes on the next attempt
 * 17. A burst of merges drops the caches at once but rebuilds the dashboard
 *     only after the last write
 * 18. Scan, merge, undo and dismiss write a log line each, with the names but
 *     never a document title
 * 19. The scan cache: a second scan of the same options reads nothing, other
 *     options and `fresh` do, and an old entry is dropped
 * 20. A merge, an undo, a dismissal and the restore of one all drop it — and
 *     so does a dismissal removed through the model, behind the service
 * 21. A scan lists the objects without documents, and never the inbox tag, a
 *     tag the settings name, or one the token may not change
 * 22. A merge renames the target before anything moves, logs it, and the undo
 *     puts the name and the local records back
 * 23. The survivor may take the spelling of a source it swallows; a name that
 *     belongs to anything else refuses the merge with nothing moved; an empty
 *     or unchanged name is no rename at all
 * 24. An undo leaves a name the user has changed since the merge alone
 * 25. deleteUnused refuses what it must not delete, deletes the rest, and
 *     writes one log row an undo re-creates the objects from
 * 26. A running document scan refuses a delete; a locked target refuses a rename
 * 27. listEntities reads its pages three at a time and keeps them in order
 * 28. A delete row that carries documents (the one "Simplify tags" writes)
 *     gives them back on an undo, and reopens the proposal behind it
 * 29. An undone merge reopens the proposal that made it, and only that one
 */

'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { createFakePaperless } = require('./helpers/fake-paperless');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed += 1;
  }
}

async function expectRefusal(fn, status, hint) {
  try {
    await fn();
  } catch (error) {
    assert.strictEqual(
      error.status,
      status,
      `${hint}: expected status ${status}, got ${error.status} (${error.message})`
    );
    return error;
  }
  throw new Error(`${hint}: expected a refusal, none was thrown`);
}

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-merge-svc-'));
  process.chdir(tempRoot);

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://127.0.0.1:9';
  process.env.PAPERLESS_API_TOKEN = 'test-token';
  process.env.ADD_AI_PROCESSED_TAG = 'yes';
  process.env.AI_PROCESSED_TAG_NAME = 'ai-processed';
  process.env.IGNORE_TAGS = 'do-not-touch';

  const documentModel = require('../models/document');
  const paperlessService = require('../services/paperlessService');
  const dashboardStatsService = require('../services/dashboardStatsService');
  const duplicateMergeService = require('../services/duplicateMergeService');

  // The dashboard rebuild is fired detached after every write; it would talk
  // to the network and outlive the test process.
  dashboardStatsService.refresh = async () => ({});
  paperlessService.getPublicBaseUrl = async () => 'https://paperless.example';

  /** Points the service at a fresh store and returns it. */
  function useFake(seed) {
    const fake = createFakePaperless(seed);
    paperlessService.client = fake.client;
    // A new archive is exactly what the scan cache must not answer for.
    duplicateMergeService.invalidateScanCache();
    return fake;
  }

  try {
    await test('listEntities pages through and never follows the next link', async () => {
      const many = [];
      for (let id = 1; id <= 150; id += 1) {
        many.push({ id, name: `Tag ${String(id).padStart(3, '0')}` });
      }
      const fake = useFake({ tags: many });
      const entities = await paperlessService.listEntities('tags');
      assert.strictEqual(entities.length, 150);
      const pages = fake.calls
        .filter((call) => call.path === '/tags/')
        .map((call) => call.params.page);
      assert.deepStrictEqual(pages, [1, 2], 'asks for page 1 then page 2');
      assert.ok(
        fake.calls.every((call) => !String(call.path).startsWith('http')),
        'never requests an absolute URL'
      );
      assert.deepStrictEqual(
        {
          name: entities[0].name,
          documentCount: entities[0].documentCount,
          matchingAlgorithm: entities[0].matchingAlgorithm,
          userCanChange: entities[0].userCanChange,
          isInboxTag: entities[0].isInboxTag,
        },
        {
          name: 'Tag 001',
          documentCount: 0,
          matchingAlgorithm: 0,
          userCanChange: true,
          isInboxTag: false,
        },
        'EntityRecord is camelCase and complete'
      );
    });

    await test('scan finds groups per kind, hides dismissed pairs and carries the URL', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Amazon' },
          { id: 2, name: 'amazon' },
          { id: 3, name: 'Invoices' },
        ],
        correspondents: [
          { id: 10, name: 'Müller GmbH' },
          { id: 11, name: 'müller gmbh' },
        ],
        documents: [
          { id: 100, tags: [1] },
          { id: 101, tags: [2], correspondent: 10 },
        ],
      });

      const result = await duplicateMergeService.scan({ kind: 'all' });
      assert.deepStrictEqual(result.totals, { tags: 3, correspondents: 2 });
      assert.strictEqual(result.threshold, 0.85);
      assert.strictEqual(result.paperlessUrl, 'https://paperless.example');
      assert.strictEqual(result.dismissedPairs, 0);
      assert.strictEqual(result.groups.length, 2, 'one group per kind');
      const tagGroup = result.groups.find((group) => group.kind === 'tags');
      assert.deepStrictEqual(
        tagGroup.members.map((member) => member.id).sort(),
        [1, 2]
      );
      assert.ok(result.scannedAt, 'scannedAt is stamped');

      const single = await duplicateMergeService.scan({ kind: 'tags' });
      assert.deepStrictEqual(
        single.totals,
        { tags: 3, correspondents: null },
        'the kind that was not scanned stays null'
      );

      // Through the service, so the cached scan above goes with the row.
      await duplicateMergeService.dismiss({
        kind: 'tags',
        ids: [1, 2],
        names: { 1: 'Amazon', 2: 'amazon' },
      });
      const hidden = await duplicateMergeService.scan({ kind: 'tags' });
      assert.strictEqual(hidden.groups.length, 0, 'the pair is gone');
      assert.strictEqual(hidden.dismissedPairs, 1);

      const shown = await duplicateMergeService.scan({
        kind: 'tags',
        includeDismissed: true,
      });
      assert.strictEqual(shown.groups.length, 1, 'includeDismissed shows it');
      assert.strictEqual(shown.dismissedPairs, 0);

      const rows = await documentModel.listEntityMergeDismissals('tags');
      for (const row of rows) {
        await duplicateMergeService.restoreDismissal(row.id);
      }
    });

    await test('scan refuses an unknown kind and reports an unreachable instance', async () => {
      await expectRefusal(
        () => duplicateMergeService.scan({ kind: 'document_types' }),
        400,
        'unknown kind'
      );

      paperlessService.client = {
        get: async () => {
          throw Object.assign(
            new Error('connect ECONNREFUSED 127.0.0.1:8000'),
            {
              code: 'ECONNREFUSED',
            }
          );
        },
      };
      const error = await expectRefusal(
        // fresh, or the scan of the case above would answer this one.
        () => duplicateMergeService.scan({ kind: 'tags', fresh: true }),
        502,
        'unreachable Paperless-ngx'
      );
      assert.ok(
        /ECONNREFUSED/.test(error.message),
        'the reason survives into the message'
      );
    });

    let tagMergeId = null;
    await test('Tags: documents move, the source is deleted and the log carries the undo data', async () => {
      const fake = useFake({
        tags: [
          { id: 12, name: 'Invoices' },
          { id: 48, name: 'invoices' },
          { id: 9, name: 'Bank' },
        ],
        documents: [
          { id: 1001, tags: [48, 9] },
          { id: 1002, tags: [48, 12] },
          { id: 1003, tags: [12] },
          { id: 1004, tags: [48] },
        ],
      });
      await documentModel.addToHistory(1001, [48, 9], 'Doc A', 'Someone');
      await documentModel.addToHistory(1002, [48, 12], 'Doc B', 'Someone');
      await documentModel.saveOriginalData(1001, [48, 9], 5, 'Doc A');

      paperlessService.tagCache.set('invoices', { id: 48 });
      paperlessService.correspondentNameCache.set(5, 'Someone');
      paperlessService.lastCorrespondentRefresh = Date.now();

      const result = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 12,
        sourceIds: [48],
        performedBy: 'tester',
      });
      tagMergeId = result.mergeId;

      assert.strictEqual(result.status, 'done');
      assert.strictEqual(result.documentsMoved, 3);
      assert.deepStrictEqual(result.target, { id: 12, name: 'Invoices' });
      assert.deepStrictEqual(result.sources, [
        {
          id: 48,
          name: 'invoices',
          documentsMoved: 3,
          deleted: true,
          error: null,
        },
      ]);

      assert.strictEqual(fake.tag(48), undefined, 'the source is gone');
      assert.deepStrictEqual(fake.document(1001).tags, [9, 12]);
      assert.deepStrictEqual(fake.document(1002).tags, [12]);
      assert.deepStrictEqual(fake.document(1004).tags, [12]);

      const entry = await documentModel.getEntityMergeById(tagMergeId);
      assert.strictEqual(entry.kind, 'tags');
      assert.strictEqual(entry.performedBy, 'tester');
      assert.deepStrictEqual(entry.sources[0].documentIds, [1001, 1002, 1004]);
      assert.deepStrictEqual(
        entry.sources[0].documentsAlreadyOnTarget,
        [1002],
        'the document that already carried the target is remembered'
      );
      assert.strictEqual(entry.sources[0].snapshot.name, 'invoices');
      assert.deepStrictEqual(entry.targetBefore, {
        match: '',
        matching_algorithm: 0,
        is_insensitive: true,
      });

      assert.deepStrictEqual(
        JSON.parse((await documentModel.getHistoryByDocumentId(1001)).tags),
        [12, 9],
        'history rewritten in place'
      );
      assert.deepStrictEqual(
        JSON.parse((await documentModel.getOriginalData(1001)).tags),
        [12, 9],
        'originals rewritten in place'
      );

      assert.strictEqual(paperlessService.tagCache.size, 0, 'tag cache empty');
      assert.strictEqual(
        paperlessService.correspondentNameCache.size,
        0,
        'correspondent cache empty'
      );
      assert.strictEqual(paperlessService.lastCorrespondentRefresh, 0);

      // The undo of exactly this merge, on the same store.
      const undo = await duplicateMergeService.undo(tagMergeId);
      assert.strictEqual(undo.status, 'undone');
      assert.strictEqual(undo.sources.length, 1);
      const restored = undo.sources[0];
      assert.strictEqual(restored.originalId, 48);
      assert.strictEqual(restored.adoptedExisting, false);
      assert.ok(
        restored.restoredId > 0 && restored.restoredId !== 48,
        'the re-created tag gets a new id'
      );
      assert.strictEqual(restored.documentsRestored, 3);
      assert.strictEqual(restored.documentsSkipped, 0);
      assert.strictEqual(fake.tag(restored.restoredId).name, 'invoices');

      assert.deepStrictEqual(
        fake.document(1001).tags.sort((a, b) => a - b),
        [9, restored.restoredId].sort((a, b) => a - b),
        'the target is removed again where it was not there before'
      );
      assert.deepStrictEqual(
        fake.document(1002).tags.sort((a, b) => a - b),
        [12, restored.restoredId].sort((a, b) => a - b),
        'a document that already had the target keeps it'
      );
      assert.deepStrictEqual(fake.document(1003).tags, [12], 'untouched');

      assert.deepStrictEqual(
        JSON.parse(
          (await documentModel.getHistoryByDocumentId(1001)).tags
        ).sort((a, b) => a - b),
        [9, restored.restoredId].sort((a, b) => a - b),
        'history rewritten back'
      );

      const undone = await documentModel.getEntityMergeById(tagMergeId);
      assert.strictEqual(undone.status, 'undone');
      assert.ok(undone.undoneAt, 'undone_at is stamped');
      assert.strictEqual(undone.undoResult.sources[0].documentsRestored, 3);
    });

    await test('Undoing the same merge twice is refused', async () => {
      await expectRefusal(
        () => duplicateMergeService.undo(tagMergeId),
        409,
        'second undo'
      );
      await expectRefusal(
        () => duplicateMergeService.undo(987654),
        404,
        'unknown merge'
      );
    });

    await test('Correspondents: history follows the name, originals follow the id', async () => {
      const fake = useFake({
        correspondents: [
          { id: 5, name: 'Amazon' },
          { id: 6, name: 'amazon' },
        ],
        documents: [
          { id: 2001, correspondent: 6 },
          { id: 2002, correspondent: 6 },
          { id: 2003, correspondent: 5 },
        ],
      });
      await documentModel.addToHistory(2001, [], 'Order', 'amazon');
      await documentModel.addToHistory(2003, [], 'Other order', 'Amazon');
      await documentModel.saveOriginalData(2001, [], 6, 'Order');

      const result = await duplicateMergeService.merge({
        kind: 'correspondents',
        targetId: 5,
        sourceIds: [6],
      });
      assert.strictEqual(result.status, 'done');
      assert.strictEqual(result.documentsMoved, 2);
      assert.strictEqual(fake.correspondent(6), undefined);
      assert.strictEqual(fake.document(2001).correspondent, 5);
      assert.strictEqual(fake.document(2002).correspondent, 5);

      assert.strictEqual(
        (await documentModel.getHistoryByDocumentId(2001)).correspondent,
        'Amazon',
        'history follows the name'
      );
      assert.strictEqual(
        Number((await documentModel.getOriginalData(2001)).correspondent),
        5,
        'originals follow the id'
      );

      const undo = await duplicateMergeService.undo(result.mergeId);
      assert.strictEqual(undo.status, 'undone');
      const restoredId = undo.sources[0].restoredId;
      assert.strictEqual(fake.correspondent(restoredId).name, 'amazon');
      assert.strictEqual(fake.document(2001).correspondent, restoredId);
      assert.strictEqual(
        fake.document(2003).correspondent,
        5,
        'a document that was never the source keeps the target'
      );
      assert.strictEqual(
        (await documentModel.getHistoryByDocumentId(2001)).correspondent,
        'amazon'
      );
      assert.strictEqual(
        Number((await documentModel.getOriginalData(2001)).correspondent),
        restoredId
      );
    });

    await test('A source that still has a document after the move is not deleted', async () => {
      const fake = useFake({
        tags: [
          { id: 20, name: 'Receipts' },
          { id: 21, name: 'receipts' },
        ],
        documents: [
          { id: 3001, tags: [21] },
          { id: 3002, tags: [21] },
        ],
        // Paperless-ngx accepts the bulk edit but does not apply it to 3002.
        bulkEditIgnores: [3002],
      });

      const result = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 20,
        sourceIds: [21],
      });
      assert.strictEqual(result.status, 'partial');
      assert.strictEqual(result.sources[0].deleted, false);
      assert.match(result.sources[0].error, /still carry/);
      assert.ok(fake.tag(21), 'the source survives');

      const entry = await documentModel.getEntityMergeById(result.mergeId);
      assert.strictEqual(
        entry.status,
        'partial',
        'the row exists even for a partial merge'
      );
    });

    await test('A source the token may not change is skipped with a reason', async () => {
      const fake = useFake({
        tags: [
          { id: 30, name: 'Contracts' },
          { id: 31, name: 'contracts', user_can_change: false },
          { id: 32, name: 'CONTRACTS' },
        ],
        documents: [
          { id: 4001, tags: [31] },
          { id: 4002, tags: [32] },
        ],
      });

      const result = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 30,
        sourceIds: [31, 32],
      });
      assert.strictEqual(result.status, 'partial');
      assert.strictEqual(result.sources[0].error, 'no permission');
      assert.strictEqual(result.sources[0].deleted, false);
      assert.strictEqual(result.sources[0].documentsMoved, 0);
      assert.ok(fake.tag(31), 'the protected tag survives');
      assert.deepStrictEqual(
        fake.document(4001).tags,
        [31],
        'its documents are untouched'
      );
      assert.strictEqual(
        result.sources[1].deleted,
        true,
        'the next source is still merged'
      );
      assert.strictEqual(fake.tag(32), undefined);
    });

    await test('A running document scan refuses a merge and an undo', async () => {
      useFake({
        tags: [
          { id: 40, name: 'Travel' },
          { id: 41, name: 'travel' },
        ],
      });
      global.__paperlessAiScanControl = { running: true };
      try {
        await expectRefusal(
          () =>
            duplicateMergeService.merge({
              kind: 'tags',
              targetId: 40,
              sourceIds: [41],
            }),
          409,
          'merge during a scan'
        );
      } finally {
        global.__paperlessAiScanControl = { running: false };
      }
      assert.ok(true);
    });

    await test('Validation refuses before anything is touched', async () => {
      const fake = useFake({
        tags: [
          { id: 50, name: 'Health' },
          { id: 51, name: 'health' },
        ],
      });
      const cases = [
        [{ kind: 'document_types', targetId: 50, sourceIds: [51] }, 'kind'],
        [{ kind: 'tags', targetId: 50, sourceIds: [] }, 'empty sources'],
        [{ kind: 'tags', targetId: 50, sourceIds: [50] }, 'target in sources'],
        [
          { kind: 'tags', targetId: 50, sourceIds: [51, 51] },
          'repeated source',
        ],
        [{ kind: 'tags', targetId: 0, sourceIds: [51] }, 'invalid target'],
        [{ kind: 'tags', targetId: 50, sourceIds: ['x'] }, 'non-numeric id'],
      ];
      for (const [request, hint] of cases) {
        await expectRefusal(
          () => duplicateMergeService.merge(request),
          400,
          hint
        );
      }
      await expectRefusal(
        () =>
          duplicateMergeService.merge({
            kind: 'tags',
            targetId: 50,
            sourceIds: [9999],
          }),
        404,
        'unknown source'
      );
      assert.strictEqual(
        fake.calls.filter((call) => call.method === 'post').length,
        0,
        'nothing was written'
      );
    });

    await test('copyMatchingRule copies once, and only when asked', async () => {
      const seed = () => ({
        tags: [
          { id: 60, name: 'Insurance', match: '', matching_algorithm: 0 },
          {
            id: 61,
            name: 'insurance',
            match: 'insurance',
            matching_algorithm: 1,
            is_insensitive: true,
          },
        ],
        documents: [{ id: 5001, tags: [61] }],
      });

      const withoutCopy = useFake(seed());
      const off = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 60,
        sourceIds: [61],
        copyMatchingRule: false,
      });
      assert.strictEqual(off.copiedMatchingRule, false);
      assert.strictEqual(withoutCopy.tag(60).match, '');
      assert.strictEqual(withoutCopy.tag(60).matching_algorithm, 0);

      const withCopy = useFake(seed());
      const on = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 60,
        sourceIds: [61],
        copyMatchingRule: true,
      });
      assert.strictEqual(on.copiedMatchingRule, true);
      assert.strictEqual(withCopy.tag(60).match, 'insurance');
      assert.strictEqual(withCopy.tag(60).matching_algorithm, 1);

      const entry = await documentModel.getEntityMergeById(on.mergeId);
      assert.strictEqual(entry.copiedMatchingRule, true);
      assert.strictEqual(entry.sources[0].copiedMatchingRule, true);

      const undo = await duplicateMergeService.undo(on.mergeId);
      assert.strictEqual(undo.revertedMatchingRule, true);
      assert.strictEqual(withCopy.tag(60).match, '');
      assert.strictEqual(withCopy.tag(60).matching_algorithm, 0);

      // A target that already has a rule keeps it.
      const keeps = useFake({
        tags: [
          {
            id: 70,
            name: 'Taxes',
            match: 'taxes',
            matching_algorithm: 1,
          },
          {
            id: 71,
            name: 'taxes',
            match: 'steuer',
            matching_algorithm: 1,
          },
        ],
        documents: [{ id: 5002, tags: [71] }],
      });
      const kept = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 70,
        sourceIds: [71],
        copyMatchingRule: true,
      });
      assert.strictEqual(kept.copiedMatchingRule, false);
      assert.strictEqual(keeps.tag(70).match, 'taxes');
    });

    await test('Undo does not revert a matching rule the user changed since', async () => {
      const fake = useFake({
        tags: [
          { id: 80, name: 'Car', match: '', matching_algorithm: 0 },
          { id: 81, name: 'car', match: 'car', matching_algorithm: 1 },
        ],
        documents: [{ id: 6001, tags: [81] }],
      });
      const merged = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 80,
        sourceIds: [81],
        copyMatchingRule: true,
      });
      assert.strictEqual(merged.copiedMatchingRule, true);

      // The user edits the rule in Paperless-ngx afterwards.
      fake.tag(80).match = 'automobile';

      const undo = await duplicateMergeService.undo(merged.mergeId);
      assert.strictEqual(undo.status, 'undone');
      assert.strictEqual(
        undo.revertedMatchingRule,
        false,
        'a rule that is no longer the copied one is left alone'
      );
      assert.strictEqual(fake.tag(80).match, 'automobile');
    });

    await test('Undo adopts a same-named object instead of creating a second one', async () => {
      const fake = useFake({
        tags: [
          { id: 90, name: 'Garden' },
          { id: 91, name: 'garden' },
        ],
        documents: [{ id: 7001, tags: [91] }],
      });
      const merged = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 90,
        sourceIds: [91],
      });
      assert.strictEqual(merged.status, 'done');

      // Somebody re-creates the tag by hand before the undo runs.
      const recreated = fake.handle('post', '/tags/', {}, { name: 'garden' });
      const recreatedId = recreated.data.id;

      const undo = await duplicateMergeService.undo(merged.mergeId);
      assert.strictEqual(undo.status, 'undone');
      assert.strictEqual(undo.sources[0].adoptedExisting, true);
      assert.strictEqual(undo.sources[0].restoredId, recreatedId);
      assert.deepStrictEqual(fake.document(7001).tags, [recreatedId]);
      assert.strictEqual(
        fake.tagNames().filter((name) => name === 'garden').length,
        1,
        'no second tag with the same name'
      );
    });

    await test('Undo skips documents that were deleted or changed meanwhile', async () => {
      const fake = useFake({
        tags: [
          { id: 95, name: 'Warranty' },
          { id: 96, name: 'warranty' },
        ],
        documents: [
          { id: 8001, tags: [96] },
          { id: 8002, tags: [96] },
          { id: 8003, tags: [96] },
        ],
      });
      const merged = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 95,
        sourceIds: [96],
      });
      assert.strictEqual(merged.documentsMoved, 3);

      // One document is deleted, one loses the target by hand.
      fake.state.documents.delete(8002);
      fake.document(8003).tags = [];

      const undo = await duplicateMergeService.undo(merged.mergeId);
      assert.strictEqual(undo.status, 'undone');
      assert.strictEqual(undo.sources[0].documentsRestored, 1);
      assert.strictEqual(undo.sources[0].documentsSkipped, 2);
      assert.deepStrictEqual(fake.document(8003).tags, [], 'left alone');
    });

    await test('A half-done undo stays retryable and finishes on the next attempt', async () => {
      const fake = useFake({
        tags: [
          { id: 97, name: 'Lease' },
          { id: 98, name: 'lease' },
        ],
        documents: [
          { id: 9001, tags: [98] },
          { id: 9002, tags: [98] },
        ],
      });
      const merged = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 97,
        sourceIds: [98],
      });
      assert.strictEqual(merged.status, 'done');

      // The tag comes back, then Paperless-ngx drops the connection before
      // the documents move.
      const originalPost = fake.client.post.bind(fake.client);
      let failOnce = true;
      fake.client.post = async (url, body) => {
        if (failOnce && String(url).includes('bulk_edit')) {
          failOnce = false;
          throw new Error('socket hang up');
        }
        return originalPost(url, body);
      };

      const first = await duplicateMergeService.undo(merged.mergeId);
      assert.strictEqual(first.status, 'undo_failed');
      assert.ok(first.sources[0].restoredId, 'the tag itself was re-created');
      assert.match(first.sources[0].error, /not moved back/);
      assert.deepStrictEqual(
        fake.document(9001).tags,
        [97],
        'the documents are still on the target'
      );
      const afterFirst = await documentModel.getEntityMergeById(merged.mergeId);
      assert.strictEqual(afterFirst.status, 'undo_failed');
      assert.strictEqual(afterFirst.undoneAt, null, 'still undoable');

      const second = await duplicateMergeService.undo(merged.mergeId, {
        performedBy: 'tester',
      });
      assert.strictEqual(second.status, 'undone');
      assert.strictEqual(second.performedBy, 'tester');
      assert.strictEqual(
        second.sources[0].adoptedExisting,
        true,
        'the re-created tag is adopted, not created a second time'
      );
      assert.strictEqual(
        second.sources[0].restoredId,
        first.sources[0].restoredId
      );
      assert.deepStrictEqual(fake.document(9001).tags, [
        second.sources[0].restoredId,
      ]);
      assert.strictEqual(
        fake.tagNames().filter((name) => name === 'lease').length,
        1
      );
      const afterSecond = await documentModel.getEntityMergeById(
        merged.mergeId
      );
      assert.strictEqual(afterSecond.status, 'undone');
      assert.ok(afterSecond.undoneAt);
    });
    await test('A burst of merges rebuilds the dashboard once', async () => {
      const fake = useFake({
        tags: [
          { id: 110, name: 'Trips' },
          { id: 111, name: 'trips' },
          { id: 112, name: 'TRIPS' },
          { id: 113, name: 'Trip' },
        ],
        documents: [
          { id: 9101, tags: [111] },
          { id: 9102, tags: [112] },
          { id: 9103, tags: [113] },
        ],
      });

      assert.strictEqual(
        duplicateMergeService.DASHBOARD_REFRESH_DEBOUNCE_MS,
        2000,
        'two seconds in production'
      );

      let refreshes = 0;
      const realRefresh = dashboardStatsService.refresh;
      dashboardStatsService.refresh = async () => {
        refreshes += 1;
        return {};
      };
      const realDelay = duplicateMergeService.dashboardRefreshDebounceMs;
      duplicateMergeService.dashboardRefreshDebounceMs = 40;
      try {
        for (const sourceId of [111, 112, 113]) {
          paperlessService.tagCache.set(`source-${sourceId}`, { id: sourceId });
          const result = await duplicateMergeService.merge({
            kind: 'tags',
            targetId: 110,
            sourceIds: [sourceId],
          });
          assert.strictEqual(result.status, 'done');
          assert.strictEqual(
            paperlessService.tagCache.size,
            0,
            'the caches are dropped immediately, not on the timer'
          );
        }
        assert.strictEqual(
          refreshes,
          0,
          'no rebuild while the burst is still running'
        );
        assert.ok(
          duplicateMergeService._dashboardRefreshTimer,
          'one rebuild is pending'
        );

        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.strictEqual(refreshes, 1, 'one rebuild for three merges');
        assert.strictEqual(
          duplicateMergeService._dashboardRefreshTimer,
          null,
          'and nothing is left pending'
        );
        assert.strictEqual(fake.tag(111), undefined, 'the merges really ran');
      } finally {
        duplicateMergeService.dashboardRefreshDebounceMs = realDelay;
        dashboardStatsService.refresh = realRefresh;
      }
    });

    await test('The log says what a scan, a merge and an undo did', async () => {
      const fake = useFake({
        tags: [
          { id: 120, name: 'Holiday' },
          { id: 121, name: 'holiday' },
        ],
        documents: [
          { id: 9201, title: 'Hotel booking Rome', tags: [121] },
          { id: 9202, title: 'Flight to Rome', tags: [121] },
        ],
      });

      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      let merged;
      try {
        await duplicateMergeService.scan({ kind: 'tags' });
        merged = await duplicateMergeService.merge({
          kind: 'tags',
          targetId: 120,
          sourceIds: [121],
        });
        await duplicateMergeService.undo(merged.mergeId);
        await duplicateMergeService.dismiss({
          kind: 'tags',
          ids: [120, 121],
          names: { 120: 'Holiday', 121: 'holiday' },
        });
      } finally {
        console.log = realLog;
      }

      const log = lines.filter((line) => line.startsWith('[DUPLICATES]'));
      const has = (pattern) =>
        assert.ok(
          log.some((line) => pattern.test(line)),
          `no [DUPLICATES] line matches ${pattern}\n${log.join('\n')}`
        );
      has(/scan started: tags, threshold 0\.85, dismissed pairs hidden\./);
      has(
        /scan finished: 2 tags, 1 group\(s\), 0 dismissed pair\(s\) hidden, in \d+ms\./
      );
      has(/merge started: tags, target 120 "Holiday", source\(s\) 121\./);
      has(
        /merge tags 121 "holiday": 2 document\(s\) found, 2 moved, source empty, deleted\./
      );
      has(
        /merge finished: status done, 2 document\(s\) moved, log id \d+, in \d+ms\./
      );
      has(
        /undo started: merge \d+, tags, target 120 "Holiday", 1 deleted source/
      );
      has(
        /undo tags "holiday": restored as \d+ \(created\), 2 document\(s\) restored, 0 skipped\./
      );
      has(/undo finished: status undone, matching rule left alone, in \d+ms\./);
      has(/dismissed: tags, 1 new pair\(s\) stored from 2 entries/);
      assert.ok(
        !lines.some((line) => /Hotel booking|Flight to Rome/.test(line)),
        'document titles are content and stay out of the log'
      );
      assert.ok(fake.tag(120), 'the target is still there');

      const rows = await documentModel.listEntityMergeDismissals('tags');
      for (const row of rows) {
        await documentModel.removeEntityMergeDismissal(row.id);
      }
    });

    // ------------------------------------------------------- the scan cache

    /**
     * Two tags that make one group, and a counter of how often the archive
     * was actually read. A scan that is served from the cache reads nothing.
     */
    function seedForCache() {
      const fake = useFake({
        tags: [
          { id: 200, name: 'Reise' },
          { id: 201, name: 'reise' },
          { id: 202, name: 'Steuer' },
        ],
        correspondents: [{ id: 210, name: 'Bahn' }],
        documents: [
          { id: 500, tags: [200] },
          { id: 501, tags: [201] },
        ],
      });
      return {
        fake,
        reads: () => fake.calls.filter((call) => call.path === '/tags/').length,
      };
    }

    await test('A second scan of the same options is served from the cache', async () => {
      const { reads } = seedForCache();
      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      let first;
      let second;
      try {
        first = await duplicateMergeService.scan({ kind: 'tags' });
        const afterFirst = reads();
        second = await duplicateMergeService.scan({ kind: 'tags' });
        assert.strictEqual(
          reads(),
          afterFirst,
          'the archive was not read a second time'
        );
      } finally {
        console.log = realLog;
      }

      assert.strictEqual(second.groups.length, first.groups.length);
      assert.strictEqual(second.scannedAt, first.scannedAt, 'the same scan');
      assert.strictEqual(
        lines.filter((line) => /scan started/.test(line)).length,
        1,
        'only the first scan started anything'
      );
      assert.ok(
        lines.some((line) =>
          /\[DUPLICATES\] scan served from cache \(age \d+s\)\./.test(line)
        ),
        `no cache line:\n${lines.join('\n')}`
      );
    });

    await test('Other options are another scan, and fresh is always one', async () => {
      const { reads } = seedForCache();
      await duplicateMergeService.scan({ kind: 'tags' });
      const afterFirst = reads();

      await duplicateMergeService.scan({ kind: 'tags', threshold: 0.75 });
      assert.ok(reads() > afterFirst, 'another threshold is another scan');
      const afterThreshold = reads();

      await duplicateMergeService.scan({
        kind: 'tags',
        includeDismissed: true,
      });
      assert.ok(
        reads() > afterThreshold,
        'and so is asking for the dismissed pairs'
      );
      const afterDismissed = reads();

      await duplicateMergeService.scan({ kind: 'tags' });
      assert.strictEqual(
        reads(),
        afterDismissed,
        'the first set of options is still cached'
      );

      await duplicateMergeService.scan({ kind: 'tags', fresh: true });
      assert.ok(
        reads() > afterDismissed,
        'fresh is what the page sends when the user presses Scan'
      );
      const afterFresh = reads();
      await duplicateMergeService.scan({ kind: 'tags' });
      assert.strictEqual(reads(), afterFresh, 'and it refills the cache');
    });

    await test('A cached scan is forgotten when it grows too old', async () => {
      const { reads } = seedForCache();
      const previous = duplicateMergeService.scanCacheMs;
      duplicateMergeService.scanCacheMs = 0;
      try {
        await duplicateMergeService.scan({ kind: 'tags' });
        const afterFirst = reads();
        await duplicateMergeService.scan({ kind: 'tags' });
        assert.ok(reads() > afterFirst, 'nothing is cached for no time at all');
      } finally {
        duplicateMergeService.scanCacheMs = previous;
      }
    });

    await test('A merge, an undo and a dismissal all drop the cached scans', async () => {
      const { reads } = seedForCache();
      await duplicateMergeService.scan({ kind: 'tags' });
      let seen = reads();

      const merged = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 200,
        sourceIds: [201],
      });
      await duplicateMergeService.scan({ kind: 'tags' });
      assert.ok(reads() > seen, 'a merge changes what a scan would find');
      seen = reads();

      await duplicateMergeService.undo(merged.mergeId);
      await duplicateMergeService.scan({ kind: 'tags' });
      assert.ok(reads() > seen, 'and so does taking it back');
      seen = reads();

      const stored = await duplicateMergeService.dismiss({
        kind: 'tags',
        ids: [200, 202],
        names: { 200: 'Reise', 202: 'Steuer' },
      });
      assert.strictEqual(stored, 1);
      await duplicateMergeService.scan({ kind: 'tags' });
      assert.ok(reads() > seen, 'a dismissed pair hides a group');
      seen = reads();

      const rows = await documentModel.listEntityMergeDismissals('tags');
      await duplicateMergeService.restoreDismissal(rows[0].id);
      await duplicateMergeService.scan({ kind: 'tags' });
      assert.ok(reads() > seen, 'and taking that back shows it again');

      for (const row of await documentModel.listEntityMergeDismissals('tags')) {
        await duplicateMergeService.restoreDismissal(row.id);
      }
    });

    await test('A dismissal removed behind the service still drops the cache', async () => {
      const { reads } = seedForCache();
      // The route deletes the row through the model; the fingerprint of the
      // cached scan is what notices.
      await duplicateMergeService.dismiss({
        kind: 'tags',
        ids: [200, 201],
        names: { 200: 'Reise', 201: 'reise' },
      });
      const hidden = await duplicateMergeService.scan({ kind: 'tags' });
      assert.strictEqual(hidden.groups.length, 0);
      const seen = reads();

      const rows = await documentModel.listEntityMergeDismissals('tags');
      await documentModel.removeEntityMergeDismissal(rows[0].id);
      const back = await duplicateMergeService.scan({ kind: 'tags' });
      assert.ok(reads() > seen, 'the cached scan was not served');
      assert.strictEqual(back.groups.length, 1, 'the group is back');
    });

    // ------------------------------------------------- objects without a use

    await test('A scan lists the objects that carry no document, and what it never lists', async () => {
      useFake({
        tags: [
          { id: 301, name: 'Used' },
          { id: 302, name: 'Unused B' },
          { id: 303, name: 'Unused A' },
          { id: 304, name: 'Inbox', is_inbox_tag: true },
          { id: 305, name: 'do-not-touch' },
          { id: 306, name: 'ai-processed' },
          { id: 307, name: 'Locked', user_can_change: false },
        ],
        correspondents: [
          { id: 310, name: 'Bahn' },
          { id: 311, name: 'Stadtwerke' },
        ],
        documents: [{ id: 3001, tags: [301], correspondent: 311 }],
      });

      const result = await duplicateMergeService.scan({ kind: 'all' });
      assert.deepStrictEqual(
        result.unused.tags.map((entity) => entity.name),
        ['Unused A', 'Unused B'],
        'sorted by name; the inbox tag, the configured tags, the used one ' +
          'and the one the token may not change are all left out'
      );
      assert.deepStrictEqual(
        result.unused.tags.map((entity) => entity.id),
        [303, 302]
      );
      assert.deepStrictEqual(
        result.unused.correspondents.map((entity) => entity.name),
        ['Bahn']
      );
      assert.strictEqual(
        result.unused.tags[0].documentCount,
        0,
        'they arrive as EntityRecords, with everything the page needs'
      );

      const single = await duplicateMergeService.scan({
        kind: 'correspondents',
      });
      assert.deepStrictEqual(
        single.unused.tags,
        [],
        'the kind that was not scanned has no unused objects either'
      );
      assert.deepStrictEqual(
        single.unused.correspondents.map((entity) => entity.name),
        ['Bahn']
      );

      const cached = await duplicateMergeService.scan({
        kind: 'correspondents',
      });
      assert.deepStrictEqual(
        cached.unused,
        single.unused,
        'and the list is part of the cached result'
      );
    });

    // ------------------------------------------ a new name for the survivor

    await test('A merge may rename the target, before anything moves', async () => {
      const fake = useFake({
        correspondents: [
          { id: 5, name: 'amazon' },
          { id: 6, name: 'Amazon EU' },
        ],
        documents: [
          { id: 2001, correspondent: 6 },
          { id: 2002, correspondent: 5 },
        ],
      });
      await documentModel.addToHistory(2001, [], 'Order', 'Amazon EU');
      await documentModel.addToHistory(2002, [], 'Other order', 'amazon');

      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      let result;
      try {
        result = await duplicateMergeService.merge({
          kind: 'correspondents',
          targetId: 5,
          sourceIds: [6],
          targetName: '  Amazon  ',
          performedBy: 'tester',
        });
      } finally {
        console.log = realLog;
      }

      assert.strictEqual(result.status, 'done');
      assert.deepStrictEqual(result.target, { id: 5, name: 'Amazon' });
      assert.strictEqual(fake.correspondent(5).name, 'Amazon');
      assert.strictEqual(fake.document(2001).correspondent, 5);

      const entry = await documentModel.getEntityMergeById(result.mergeId);
      assert.strictEqual(entry.targetName, 'Amazon');
      assert.strictEqual(entry.targetRenamedFrom, 'amazon');
      assert.strictEqual(entry.action, 'merge');

      assert.strictEqual(
        (await documentModel.getHistoryByDocumentId(2001)).correspondent,
        'Amazon',
        'the moved document follows the new name'
      );
      assert.strictEqual(
        (await documentModel.getHistoryByDocumentId(2002)).correspondent,
        'Amazon',
        'and so does a document the target already had'
      );
      assert.ok(
        lines.some(
          (line) =>
            line ===
            '[DUPLICATES] renamed correspondent 5 "amazon" to "Amazon" before the merge.'
        ),
        `no rename line:\n${lines.filter((l) => l.startsWith('[DUPLICATES]')).join('\n')}`
      );

      // And the undo puts the name back with the documents.
      const undo = await duplicateMergeService.undo(result.mergeId);
      assert.strictEqual(undo.status, 'undone');
      assert.strictEqual(fake.correspondent(5).name, 'amazon');
      const restoredId = undo.sources[0].restoredId;
      assert.strictEqual(fake.correspondent(restoredId).name, 'Amazon EU');
      assert.strictEqual(
        (await documentModel.getHistoryByDocumentId(2001)).correspondent,
        'Amazon EU'
      );
      assert.strictEqual(
        (await documentModel.getHistoryByDocumentId(2002)).correspondent,
        'amazon',
        'the local name is back where the object kept its documents'
      );
    });

    await test('The survivor may take the spelling of a source it swallows', async () => {
      const fake = useFake({
        tags: [
          { id: 1, name: 'invoices' },
          { id: 2, name: 'Invoices' },
        ],
        documents: [
          { id: 4401, tags: [1] },
          { id: 4402, tags: [2] },
        ],
      });

      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      let merged;
      try {
        merged = await duplicateMergeService.merge({
          kind: 'tags',
          targetId: 1,
          sourceIds: [2],
          targetName: 'Invoices',
        });
      } finally {
        console.log = realLog;
      }

      assert.strictEqual(merged.status, 'done');
      assert.deepStrictEqual(merged.target, { id: 1, name: 'Invoices' });
      assert.strictEqual(fake.tag(1).name, 'Invoices');
      assert.strictEqual(fake.tag(2), undefined);
      assert.deepStrictEqual(fake.document(4402).tags, [1]);
      assert.ok(
        lines.some(
          (line) =>
            line ===
            '[DUPLICATES] renamed tag 1 "invoices" to "Invoices" after the merge.'
        ),
        `the rename waited for the name:\n${lines.filter((l) => l.startsWith('[DUPLICATES]')).join('\n')}`
      );

      const entry = await documentModel.getEntityMergeById(merged.mergeId);
      assert.strictEqual(entry.targetName, 'Invoices');
      assert.strictEqual(entry.targetRenamedFrom, 'invoices');

      // And the undo frees the name again before it re-creates the source.
      const undo = await duplicateMergeService.undo(merged.mergeId);
      assert.strictEqual(undo.status, 'undone');
      assert.strictEqual(fake.tag(1).name, 'invoices');
      assert.strictEqual(
        fake.tag(undo.sources[0].restoredId).name,
        'Invoices',
        'the source is back under its own spelling'
      );
    });

    await test('A name that is already taken refuses the merge and moves nothing', async () => {
      const fake = useFake({
        tags: [
          { id: 12, name: 'Invoices' },
          { id: 48, name: 'invoices' },
          { id: 13, name: 'Taken' },
        ],
        documents: [{ id: 4001, tags: [48] }],
      });

      const error = await expectRefusal(
        () =>
          duplicateMergeService.merge({
            kind: 'tags',
            targetId: 12,
            sourceIds: [48],
            targetName: 'Taken',
          }),
        409,
        'a name that exists'
      );
      assert.ok(/already taken/.test(error.message));
      assert.strictEqual(fake.tag(12).name, 'Invoices', 'the target kept it');
      assert.ok(fake.tag(48), 'the source is still there');
      assert.deepStrictEqual(
        fake.document(4001).tags,
        [48],
        'not one document moved'
      );
      const log = await documentModel.getEntityMerges({ limit: 1 });
      assert.notStrictEqual(
        log.rows[0]?.targetId,
        12,
        'and nothing was written to the log'
      );
    });

    await test('An empty or unchanged name is no rename at all', async () => {
      const fake = useFake({
        tags: [
          { id: 20, name: 'Reise' },
          { id: 21, name: 'reise' },
          { id: 22, name: 'Steuer' },
          { id: 23, name: 'steuer' },
        ],
        documents: [
          { id: 4101, tags: [21] },
          { id: 4102, tags: [23] },
        ],
      });

      const empty = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 20,
        sourceIds: [21],
        targetName: '   ',
      });
      assert.strictEqual(empty.target.name, 'Reise');
      assert.strictEqual(
        (await documentModel.getEntityMergeById(empty.mergeId))
          .targetRenamedFrom,
        null
      );

      const same = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 22,
        sourceIds: [23],
        targetName: 'Steuer',
      });
      assert.strictEqual(same.target.name, 'Steuer');
      assert.strictEqual(
        (await documentModel.getEntityMergeById(same.mergeId))
          .targetRenamedFrom,
        null
      );
      assert.strictEqual(
        fake.calls.filter(
          (call) => call.method === 'patch' && call.body?.name != null
        ).length,
        0,
        'no rename request went out'
      );
    });

    await test('An undo leaves a name the user has changed since alone', async () => {
      const fake = useFake({
        tags: [
          { id: 30, name: 'holiday' },
          { id: 31, name: 'Holidays' },
        ],
        documents: [{ id: 4201, tags: [31] }],
      });

      const merged = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 30,
        sourceIds: [31],
        targetName: 'Holiday',
      });
      assert.strictEqual(fake.tag(30).name, 'Holiday');

      // The user renames it again through Paperless-ngx itself.
      fake.tag(30).name = 'Urlaub';

      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      try {
        await duplicateMergeService.undo(merged.mergeId);
      } finally {
        console.log = realLog;
      }
      assert.strictEqual(fake.tag(30).name, 'Urlaub', 'their name survives');
      assert.ok(
        lines.some((line) =>
          /undo tag 30: it is called "Urlaub" and no longer "Holiday"/.test(
            line
          )
        ),
        `no explanation:\n${lines.filter((l) => l.startsWith('[DUPLICATES]')).join('\n')}`
      );
    });

    // ------------------------------------------------- deleting what is unused

    let deleteLogId = null;
    await test('deleteUnused refuses what it must not delete and deletes the rest', async () => {
      const fake = useFake({
        tags: [
          { id: 401, name: 'Used' },
          { id: 402, name: 'Inbox', is_inbox_tag: true },
          { id: 403, name: 'do-not-touch' },
          { id: 404, name: 'Locked', user_can_change: false },
          {
            id: 405,
            name: 'Orphan A',
            color: '#112233',
            match: 'orphan',
            matching_algorithm: 1,
          },
          { id: 406, name: 'Orphan B' },
        ],
        documents: [{ id: 4301, tags: [401] }],
      });

      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      let result;
      try {
        result = await duplicateMergeService.deleteUnused({
          kind: 'tags',
          ids: [401, 402, 403, 404, 405, 406, 999],
          performedBy: 'tester',
        });
      } finally {
        console.log = realLog;
      }
      deleteLogId = result.logId;

      assert.strictEqual(result.kind, 'tags');
      assert.deepStrictEqual(result.deleted, [
        { id: 405, name: 'Orphan A' },
        { id: 406, name: 'Orphan B' },
      ]);
      assert.deepStrictEqual(
        result.failed.map((entry) => [entry.id, entry.error]),
        [
          [401, '1 document(s) carry it by now'],
          [402, 'It is an inbox tag'],
          [403, 'The settings refer to this tag'],
          [404, 'The API token may not change it'],
          [999, 'It does not exist in Paperless-ngx any more'],
        ],
        'every refusal says why'
      );
      assert.deepStrictEqual(
        fake.tagNames().sort(),
        ['Inbox', 'Locked', 'Used', 'do-not-touch'],
        'only the two orphans are gone'
      );

      const entry = await documentModel.getEntityMergeById(result.logId);
      assert.strictEqual(entry.action, 'delete');
      assert.strictEqual(entry.targetId, 0);
      assert.strictEqual(entry.targetName, '');
      assert.strictEqual(entry.documentsMoved, 0);
      assert.strictEqual(entry.status, 'partial', 'some ids were refused');
      assert.strictEqual(entry.performedBy, 'tester');
      assert.strictEqual(entry.sources.length, 2);
      assert.deepStrictEqual(entry.sources[0].documentIds, []);
      assert.strictEqual(entry.sources[0].deleted, true);
      assert.deepStrictEqual(
        {
          name: entry.sources[0].snapshot.name,
          color: entry.sources[0].snapshot.color,
          match: entry.sources[0].snapshot.match,
          matching_algorithm: entry.sources[0].snapshot.matching_algorithm,
          is_inbox_tag: entry.sources[0].snapshot.is_inbox_tag,
        },
        {
          name: 'Orphan A',
          color: '#112233',
          match: 'orphan',
          matching_algorithm: 1,
          is_inbox_tag: false,
        },
        'the snapshot is what an undo re-creates from'
      );

      assert.ok(
        lines.some(
          (line) =>
            line === '[DUPLICATES] deleted 2 unused tag(s): Orphan A, Orphan B.'
        ),
        `no delete line:\n${lines.filter((l) => l.startsWith('[DUPLICATES]')).join('\n')}`
      );

      // The undo of exactly this call, on the same store: one object is
      // created again, the other is adopted because its name exists again.
      await paperlessService.createEntity('tags', { name: 'Orphan B' });
      const undo = await duplicateMergeService.undo(result.logId, {
        performedBy: 'tester',
      });
      assert.strictEqual(undo.status, 'undone');
      assert.strictEqual(undo.sources.length, 2);
      const orphanA = undo.sources.find((one) => one.name === 'Orphan A');
      const orphanB = undo.sources.find((one) => one.name === 'Orphan B');
      assert.strictEqual(orphanA.adoptedExisting, false);
      assert.strictEqual(orphanA.documentsRestored, 0);
      assert.strictEqual(orphanA.documentsSkipped, 0);
      assert.strictEqual(orphanB.adoptedExisting, true);
      assert.strictEqual(
        fake.tag(orphanA.restoredId).match,
        'orphan',
        'the matching rule came back with it'
      );
      assert.strictEqual(fake.tag(orphanA.restoredId).color, '#112233');
      assert.strictEqual(
        (await documentModel.getEntityMergeById(result.logId)).status,
        'undone'
      );
    });

    await test('A running document scan refuses a delete, and a locked target refuses a rename', async () => {
      const fake = useFake({
        tags: [
          { id: 420, name: 'Orphan', user_can_change: true },
          { id: 421, name: 'Locked', user_can_change: false },
          { id: 422, name: 'locked' },
        ],
      });

      global.__paperlessAiScanControl = { running: true };
      try {
        await expectRefusal(
          () =>
            duplicateMergeService.deleteUnused({ kind: 'tags', ids: [420] }),
          409,
          'a delete during a document scan'
        );
      } finally {
        global.__paperlessAiScanControl = { running: false };
      }
      assert.ok(fake.tag(420), 'nothing was deleted');

      const error = await expectRefusal(
        () =>
          duplicateMergeService.merge({
            kind: 'tags',
            targetId: 421,
            sourceIds: [422],
            targetName: 'Unlocked',
          }),
        403,
        'a rename the token may not make'
      );
      assert.ok(/may not rename/.test(error.message));
      assert.strictEqual(fake.tag(421).name, 'Locked');
      assert.ok(fake.tag(422), 'and the source is untouched');
    });

    await test('An undone delete cannot be undone twice, and a bad request is refused', async () => {
      await expectRefusal(
        () => duplicateMergeService.undo(deleteLogId),
        409,
        'second undo of a delete'
      );
      await expectRefusal(
        () => duplicateMergeService.deleteUnused({ kind: 'nope', ids: [1] }),
        400,
        'unknown kind'
      );
      await expectRefusal(
        () => duplicateMergeService.deleteUnused({ kind: 'tags', ids: [] }),
        400,
        'no ids'
      );
      await expectRefusal(
        () => duplicateMergeService.deleteUnused({ kind: 'tags', ids: [0] }),
        400,
        'not an id'
      );
    });

    await test('A delete of nothing writes no log row, and a delete drops the cached scans', async () => {
      const { fake, reads } = seedForCache();
      await duplicateMergeService.scan({ kind: 'tags' });
      const seen = reads();

      const refused = await duplicateMergeService.deleteUnused({
        kind: 'tags',
        ids: [200],
      });
      assert.deepStrictEqual(refused.deleted, []);
      assert.strictEqual(refused.logId, null, 'nothing to undo, no row');

      const removed = await duplicateMergeService.deleteUnused({
        kind: 'tags',
        ids: [202],
      });
      assert.deepStrictEqual(removed.deleted, [{ id: 202, name: 'Steuer' }]);
      assert.strictEqual(removed.failed.length, 0);
      assert.strictEqual(
        (await documentModel.getEntityMergeById(removed.logId)).status,
        'done'
      );
      assert.strictEqual(fake.tag(202), undefined);

      await duplicateMergeService.scan({ kind: 'tags' });
      assert.ok(reads() > seen, 'a delete changes what a scan would find');
    });

    // ------------------------------------------------ reading pages in parallel

    await test('listEntities reads its pages in parallel and keeps them in order', async () => {
      const many = [];
      for (let id = 1; id <= 450; id += 1) {
        many.push({ id, name: `Tag ${String(id).padStart(3, '0')}` });
      }
      const fake = createFakePaperless({ tags: many, requestDelayMs: 20 });
      paperlessService.client = fake.client;
      duplicateMergeService.invalidateScanCache();

      const startedAt = Date.now();
      const entities = await paperlessService.listEntities('tags');
      const elapsed = Date.now() - startedAt;

      assert.strictEqual(entities.length, 450);
      assert.strictEqual(entities[0].name, 'Tag 001');
      assert.strictEqual(
        entities[100].name,
        'Tag 101',
        'page 2 follows page 1'
      );
      assert.strictEqual(entities[449].name, 'Tag 450', 'and page 5 is last');

      const pages = fake.calls
        .filter((call) => call.path === '/tags/')
        .map((call) => call.params.page)
        .sort((a, b) => a - b);
      assert.deepStrictEqual(pages, [1, 2, 3, 4, 5], 'every page once');
      assert.strictEqual(
        fake.state.maxInFlight,
        3,
        'three pages were in flight at the same time'
      );

      // Sequential would be five delays and four pauses of 100ms; this reads
      // the first page, then three at once, pauses once, then the last.
      assert.ok(
        elapsed < 300,
        `parallel pages should beat the ~500ms a sequential read costs, took ${elapsed}ms`
      );
    });

    // ---------------------------------- the delete "Simplify tags" writes

    await test('A delete row that carries documents gives them back', async () => {
      const fake = useFake({
        tags: [{ id: 10, name: 'Keep me' }],
        documents: [
          { id: 100, tags: [10] },
          { id: 101, tags: [] },
        ],
      });
      // The row "Simplify tags" writes for the delete action: the tag is
      // already gone, and its documents are in `details`.
      fake.state.tags.delete(10);
      fake.state.documents.get(100).tags = [];
      const logId = await documentModel.addEntityMerge({
        kind: 'tags',
        targetId: 0,
        targetName: '',
        sources: [
          {
            id: 10,
            name: 'Keep me',
            snapshot: { name: 'Keep me', color: '#ff0000' },
            documentIds: [100, 999],
            documentsAlreadyOnTarget: [],
            documentsMoved: 1,
            deleted: true,
            error: null,
          },
        ],
        documentsMoved: 1,
        status: 'done',
        action: 'delete',
        details: {
          typeName: null,
          typeId: null,
          topicTagIds: [],
          createdTypeId: null,
          createdTagIds: [],
          documents: [
            { id: 100, addedTagIds: [], previousTypeId: null, typeSet: false },
          ],
        },
      });
      await documentModel.replaceTagSplitProposals([
        {
          tagId: 10,
          tagName: 'Keep me',
          documentCount: 1,
          action: 'delete',
          typeName: null,
          topicNames: [],
          source: 'model',
          confidence: 'high',
          reason: 'says nothing',
          documentsWithType: 0,
          overwriteType: false,
          status: 'applied',
        },
      ]);

      const undone = await duplicateMergeService.undo(logId, {
        performedBy: 'tester',
      });
      assert.strictEqual(undone.status, 'undone');
      assert.strictEqual(undone.performedBy, 'tester');
      const restoredId = undone.sources[0].restoredId;
      assert.ok(Number.isInteger(restoredId));
      assert.notStrictEqual(restoredId, 10, 'a re-created tag has a new id');
      assert.strictEqual(fake.tag(restoredId).name, 'Keep me');
      assert.deepStrictEqual(fake.document(100).tags, [restoredId]);
      assert.strictEqual(undone.sources[0].documentsRestored, 1);
      assert.strictEqual(
        undone.sources[0].documentsSkipped,
        1,
        'a document that no longer exists is skipped, not invented'
      );
      assert.strictEqual(
        (await documentModel.getEntityMergeById(logId)).status,
        'undone'
      );
      assert.strictEqual(
        (await documentModel.getTagSplitProposal(10)).status,
        'open',
        'the proposal behind it is a decision again'
      );
    });

    await test('An undone merge reopens the proposal that made it', async () => {
      const fake = useFake({
        tags: [
          { id: 10, name: 'Amazon' },
          { id: 11, name: 'amazon' },
          { id: 12, name: 'Zalando' },
        ],
        documents: [{ id: 100, tags: [11] }],
      });
      await documentModel.replaceTagSplitProposals([
        {
          tagId: 11,
          tagName: 'amazon',
          documentCount: 1,
          action: 'merge',
          mergeInto: 'Amazon',
          typeName: null,
          topicNames: [],
          source: 'rule',
          confidence: 'high',
          reason: 'another spelling',
          documentsWithType: 0,
          overwriteType: false,
          status: 'applied',
        },
        {
          tagId: 12,
          tagName: 'Something else',
          documentCount: 0,
          action: 'delete',
          typeName: null,
          topicNames: [],
          source: 'rule',
          confidence: 'high',
          reason: 'no documents',
          documentsWithType: 0,
          overwriteType: false,
          status: 'applied',
        },
      ]);

      const result = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 10,
        sourceIds: [11],
      });
      await duplicateMergeService.undo(result.mergeId);
      assert.ok(fake.tagNames().includes('amazon'), 'the source is back');
      assert.strictEqual(
        (await documentModel.getTagSplitProposal(11)).status,
        'open'
      );
      assert.strictEqual(
        (await documentModel.getTagSplitProposal(12)).status,
        'applied',
        'a proposal this row is not about is left alone'
      );
    });
  } finally {
    try {
      documentModel.closeDatabase();
    } catch {
      // A failing case may have closed it already.
    }
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
