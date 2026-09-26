/**
 * Test: the local records behind the Duplicates page
 *
 * The merge service deletes tags and correspondents in Paperless-ngx. Once
 * they are gone, everything an undo needs exists only in these rows, and the
 * History page and the Restore action keep pointing at the deleted ids unless
 * the rewrite below runs. These cases pin the model contract the merge
 * service, the routes and the page are built against.
 *
 * Covers:
 * 1. Migration v11 creates both tables
 * 2. A merge is stored with its JSON columns and read back parsed, newest first
 * 3. An undo attempt is recorded; only a successful one stamps undone_at
 * 4. Dismissed pairs are stored order-independently, once, and can be removed
 * 5. Tag ids are rewritten in history and original rows, deduplicated, scoped
 * 6. Correspondents are rewritten by name in history and by id in originals
 */

'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

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

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-merge-model-'));
  process.chdir(tempRoot);
  const documentModel = require('../models/document');

  try {
    await test('Migration v11 creates entity_merges and entity_merge_dismissals', async () => {
      const Database = require('better-sqlite3');
      const db = new Database(path.join(tempRoot, 'data', 'documents.db'), {
        readonly: true,
      });
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name);
        assert.ok(tables.includes('entity_merges'), 'entity_merges missing');
        assert.ok(
          tables.includes('entity_merge_dismissals'),
          'entity_merge_dismissals missing'
        );
        assert.ok(
          db.pragma('user_version', { simple: true }) >= 11,
          'user_version must be at least 11'
        );
      } finally {
        db.close();
      }
    });

    let firstMergeId;
    await test('A merge is stored with parsed JSON columns and listed newest first', async () => {
      firstMergeId = await documentModel.addEntityMerge({
        kind: 'tags',
        targetId: 12,
        targetName: 'Invoices',
        targetBefore: { matchingAlgorithm: 0, match: '', isInsensitive: true },
        sources: [
          {
            id: 48,
            name: 'invoice',
            snapshot: {
              name: 'invoice',
              matchingAlgorithm: 1,
              match: 'invoice',
            },
            documentIds: [1, 2, 3],
            documentsAlreadyOnTarget: [2],
            documentsMoved: 3,
            deleted: true,
            error: null,
          },
        ],
        documentsMoved: 3,
        copiedMatchingRule: true,
        performedBy: 'tester',
      });
      assert.ok(
        Number.isInteger(firstMergeId) && firstMergeId > 0,
        'expected an id'
      );

      const secondId = await documentModel.addEntityMerge({
        kind: 'correspondents',
        targetId: 5,
        targetName: 'Amazon',
        sources: [],
      });
      assert.ok(secondId > firstMergeId, 'ids must grow');

      const entry = await documentModel.getEntityMergeById(firstMergeId);
      assert.strictEqual(entry.kind, 'tags');
      assert.strictEqual(entry.targetName, 'Invoices');
      assert.deepStrictEqual(entry.targetBefore, {
        matchingAlgorithm: 0,
        match: '',
        isInsensitive: true,
      });
      assert.strictEqual(entry.sources.length, 1);
      assert.deepStrictEqual(entry.sources[0].documentIds, [1, 2, 3]);
      assert.strictEqual(entry.copiedMatchingRule, true);
      assert.strictEqual(entry.status, 'done');
      assert.strictEqual(entry.performedBy, 'tester');
      assert.strictEqual(entry.undoneAt, null);
      assert.strictEqual(entry.undoResult, null);

      const page = await documentModel.getEntityMerges({ limit: 1, offset: 0 });
      assert.strictEqual(page.total, 2);
      assert.strictEqual(page.rows.length, 1);
      assert.strictEqual(page.rows[0].id, secondId, 'newest first');

      const tagsOnly = await documentModel.getEntityMerges({ kind: 'tags' });
      assert.strictEqual(tagsOnly.total, 1);
      assert.strictEqual(tagsOnly.rows[0].id, firstMergeId);

      assert.strictEqual(await documentModel.getEntityMergeById(999999), null);
    });

    await test('An undo attempt is recorded; only a successful one stamps undone_at', async () => {
      assert.strictEqual(
        await documentModel.updateEntityMergeUndo(firstMergeId, {
          status: 'undo_failed',
          undoResult: { status: 'undo_failed', sources: [] },
        }),
        true
      );
      let entry = await documentModel.getEntityMergeById(firstMergeId);
      assert.strictEqual(entry.status, 'undo_failed');
      assert.strictEqual(
        entry.undoneAt,
        null,
        'a failed undo leaves the row undoable'
      );
      assert.deepStrictEqual(entry.undoResult, {
        status: 'undo_failed',
        sources: [],
      });

      await documentModel.updateEntityMergeUndo(firstMergeId, {
        status: 'undone',
        undoResult: {
          status: 'undone',
          sources: [{ originalId: 48, restoredId: 101 }],
        },
      });
      entry = await documentModel.getEntityMergeById(firstMergeId);
      assert.strictEqual(entry.status, 'undone');
      assert.ok(entry.undoneAt, 'undone_at must be stamped');
      assert.strictEqual(entry.undoResult.sources[0].restoredId, 101);

      assert.strictEqual(
        await documentModel.updateEntityMergeUndo(999999, { status: 'undone' }),
        false
      );
    });

    await test('Dismissed pairs are stored once, order-independent, and can be removed', async () => {
      const inserted = await documentModel.addEntityMergeDismissals('tags', [
        { idA: 7, idB: 3, nameA: 'Seven', nameB: 'Three' },
        { idA: 3, idB: 7 },
        { idA: 4, idB: 4 },
        { idA: 'x', idB: 5 },
      ]);
      assert.strictEqual(
        inserted,
        1,
        'the mirrored, the self and the invalid pair are ignored'
      );

      await documentModel.addEntityMergeDismissals('correspondents', [
        { idA: 1, idB: 2 },
      ]);

      const tags = await documentModel.listEntityMergeDismissals('tags');
      assert.strictEqual(tags.length, 1);
      assert.strictEqual(tags[0].idA, 3, 'lower id first');
      assert.strictEqual(tags[0].idB, 7);
      assert.strictEqual(
        tags[0].nameA,
        'Three',
        'names follow the ids when swapped'
      );
      assert.strictEqual(tags[0].nameB, 'Seven');
      assert.strictEqual(tags[0].kind, 'tags');

      const all = await documentModel.listEntityMergeDismissals();
      assert.strictEqual(all.length, 2);

      assert.strictEqual(
        await documentModel.removeEntityMergeDismissal(tags[0].id),
        true
      );
      assert.strictEqual(
        await documentModel.removeEntityMergeDismissal(tags[0].id),
        false
      );
      assert.strictEqual(
        (await documentModel.listEntityMergeDismissals('tags')).length,
        0
      );
    });

    await test('Tag ids are rewritten in history and original rows, deduplicated and scoped', async () => {
      await documentModel.addToHistory(1001, [48, 9], 'Doc A', 'Amazon');
      await documentModel.addToHistory(1002, [48, 12], 'Doc B', 'Amazon');
      await documentModel.addToHistory(1003, [48], 'Doc C', 'Other');
      await documentModel.addToHistory(1004, [9], 'Doc D', 'Other');
      await documentModel.saveOriginalData(1001, [48, 9], 5, 'Doc A');
      await documentModel.saveOriginalData(1003, ['48'], 5, 'Doc C');

      const result = await documentModel.replaceEntityInLocalRecords('tags', {
        fromId: 48,
        toId: 12,
        documentIds: [1001, 1002],
      });
      assert.deepStrictEqual(result, { historyRows: 2, originalRows: 1 });

      const a = await documentModel.getHistoryByDocumentId(1001);
      assert.deepStrictEqual(JSON.parse(a.tags), [12, 9]);
      const b = await documentModel.getHistoryByDocumentId(1002);
      assert.deepStrictEqual(
        JSON.parse(b.tags),
        [12],
        'the target is not duplicated'
      );
      const c = await documentModel.getHistoryByDocumentId(1003);
      assert.deepStrictEqual(
        JSON.parse(c.tags),
        [48],
        'out of scope rows stay'
      );
      const originalA = await documentModel.getOriginalData(1001);
      assert.deepStrictEqual(JSON.parse(originalA.tags), [12, 9]);
      const originalC = await documentModel.getOriginalData(1003);
      assert.deepStrictEqual(JSON.parse(originalC.tags), ['48']);

      const unscoped = await documentModel.replaceEntityInLocalRecords('tags', {
        fromId: 48,
        toId: 12,
      });
      assert.deepStrictEqual(unscoped, { historyRows: 1, originalRows: 1 });
      assert.deepStrictEqual(
        JSON.parse((await documentModel.getOriginalData(1003)).tags),
        [12],
        'string ids are rewritten as integers'
      );
    });

    await test('Correspondents are rewritten by name in history and by id in originals', async () => {
      const result = await documentModel.replaceEntityInLocalRecords(
        'correspondents',
        {
          fromId: 5,
          toId: 6,
          fromName: 'Amazon',
          toName: 'Amazon EU',
          documentIds: [1001],
        }
      );
      assert.deepStrictEqual(result, { historyRows: 1, originalRows: 1 });
      assert.strictEqual(
        (await documentModel.getHistoryByDocumentId(1001)).correspondent,
        'Amazon EU'
      );
      assert.strictEqual(
        (await documentModel.getHistoryByDocumentId(1002)).correspondent,
        'Amazon',
        'out of scope rows stay'
      );
      assert.strictEqual(
        Number((await documentModel.getOriginalData(1001)).correspondent),
        6
      );
      assert.strictEqual(
        Number((await documentModel.getOriginalData(1003)).correspondent),
        5
      );

      const unknownKind = await documentModel.replaceEntityInLocalRecords(
        'document_types',
        {
          fromId: 1,
          toId: 2,
        }
      );
      assert.deepStrictEqual(unknownKind, { historyRows: 0, originalRows: 0 });
    });
    await test('Migration v12 adds the action and rename columns, the mappings and the calibration table', async () => {
      const Database = require('better-sqlite3');
      const db = new Database(path.join(tempRoot, 'data', 'documents.db'), {
        readonly: true,
      });
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name);
        assert.ok(tables.includes('entity_name_mappings'));
        assert.ok(tables.includes('ai_calibration'));
        const columns = db
          .prepare('PRAGMA table_info(entity_merges)')
          .all()
          .map((row) => row.name);
        assert.ok(columns.includes('action'));
        assert.ok(columns.includes('target_renamed_from'));
        assert.ok(db.pragma('user_version', { simple: true }) >= 12);
      } finally {
        db.close();
      }
    });

    await test('A log row is a merge unless it says delete, and remembers a rename', async () => {
      const mergeId = await documentModel.addEntityMerge({
        kind: 'tags',
        targetId: 12,
        targetName: 'Invoices',
        targetRenamedFrom: 'invoices',
        sources: [],
      });
      const merge = await documentModel.getEntityMergeById(mergeId);
      assert.strictEqual(merge.action, 'merge');
      assert.strictEqual(merge.targetRenamedFrom, 'invoices');

      const deleteId = await documentModel.addEntityMerge({
        kind: 'correspondents',
        targetId: 0,
        targetName: '',
        action: 'delete',
        sources: [{ id: 5, name: 'Nobody', snapshot: { name: 'Nobody' } }],
      });
      const removal = await documentModel.getEntityMergeById(deleteId);
      assert.strictEqual(removal.action, 'delete');
      assert.strictEqual(removal.targetRenamedFrom, null);
      assert.strictEqual(removal.sources[0].name, 'Nobody');

      const odd = await documentModel.addEntityMerge({
        kind: 'tags',
        targetId: 1,
        targetName: 'x',
        action: 'something else',
      });
      assert.strictEqual(
        (await documentModel.getEntityMergeById(odd)).action,
        'merge',
        'an unknown action is stored as a merge'
      );
    });

    await test('Name mappings are listed newest first and pruned to the newest 200', async () => {
      assert.strictEqual(await documentModel.clearEntityNameMappings(), 0);
      for (let i = 1; i <= 205; i += 1) {
        const id = await documentModel.addEntityNameMapping({
          kind: i % 2 ? 'tags' : 'correspondents',
          proposedName: `Rechnungen ${i}`,
          targetId: 100 + i,
          targetName: `Rechnung ${i}`,
          reason: 'plural',
          score: 0.92,
          documentId: i,
        });
        assert.ok(Number.isInteger(id) && id > 0);
      }
      const rows = await documentModel.listEntityNameMappings();
      assert.strictEqual(rows.length, 200, 'older rows are pruned');
      assert.strictEqual(
        rows[0].proposedName,
        'Rechnungen 205',
        'newest first'
      );
      assert.strictEqual(rows[199].proposedName, 'Rechnungen 6');
      assert.deepStrictEqual(
        {
          kind: rows[0].kind,
          targetId: rows[0].targetId,
          targetName: rows[0].targetName,
          reason: rows[0].reason,
          score: rows[0].score,
          documentId: rows[0].documentId,
        },
        {
          kind: 'tags',
          targetId: 305,
          targetName: 'Rechnung 205',
          reason: 'plural',
          score: 0.92,
          documentId: 205,
        }
      );
      const few = await documentModel.listEntityNameMappings({ limit: 3 });
      assert.strictEqual(few.length, 3);
      const withoutDocument = await documentModel.addEntityNameMapping({
        kind: 'tags',
        proposedName: 'x',
        targetId: 1,
        targetName: 'X',
        reason: 'exact-normalized',
      });
      assert.ok(withoutDocument > 0);
      assert.strictEqual(
        (await documentModel.listEntityNameMappings({ limit: 1 }))[0]
          .documentId,
        null
      );
      assert.strictEqual(await documentModel.clearEntityNameMappings(), 200);
      assert.deepStrictEqual(await documentModel.listEntityNameMappings(), []);
    });

    await test('The AI calibration is stored per model and thinking switch and replaced on save', async () => {
      assert.strictEqual(
        await documentModel.getAiCalibration('m', false),
        null
      );
      assert.strictEqual(
        await documentModel.saveAiCalibration({
          model: 'm',
          thinking: false,
          tokensPerPair: 32.5,
          tokensPerSecond: 59,
          largestCompletion: 128,
        }),
        true
      );
      const saved = await documentModel.getAiCalibration('m', false);
      assert.strictEqual(saved.tokensPerPair, 32.5);
      assert.strictEqual(saved.tokensPerSecond, 59);
      assert.strictEqual(saved.largestCompletion, 128);
      assert.ok(
        typeof saved.measuredAt === 'string' && saved.measuredAt !== ''
      );
      assert.strictEqual(
        await documentModel.getAiCalibration('m', true),
        null,
        'thinking on is a separate measurement'
      );
      await documentModel.saveAiCalibration({
        model: 'm',
        thinking: false,
        tokensPerPair: 40,
        tokensPerSecond: 61.2,
        largestCompletion: 737.4,
      });
      const replaced = await documentModel.getAiCalibration('m', false);
      assert.strictEqual(replaced.tokensPerPair, 40);
      assert.strictEqual(replaced.largestCompletion, 737, 'rounded to a token');
    });
  } finally {
    try {
      documentModel.closeDatabase();
    } catch {
      // The database may already be closed by a failing case.
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
