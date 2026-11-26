/**
 * Test: Tidy up and the nested tags of Paperless-ngx 3.5+
 *
 * Paperless-ngx keeps tags in a tree. Deleting a tag there deletes every tag
 * below it, and the documents lose all of them; taking a tag off documents
 * takes the tags below it off too, and adding one adds the tags above it.
 * Tidy up deletes tags in three places (merge, delete unused, split) and
 * takes tags off documents in every undo, so each of them is checked here
 * against a store that behaves like that (tests/helpers/fake-paperless.js
 * with nested tags) and against one without the fields at all.
 *
 * Covers:
 *  1. The store: a delete cascades, modify_tags expands both ways, a bad parent is refused
 *  2. EntityRecords carry parentId/childIds only where the instance has them
 *  3. deleteEntity() refuses a tag with sub-tags, live, and deletes a leaf
 *  4. The scan: a parent is never "unused", wins the survivor rule, two
 *     parents are never grouped; the count of tags with sub-tags
 *  5. A merge with a parent as source is refused for that source: partial, nothing moved
 *  6. deleteUnused refuses a parent with the plain reason
 *  7. A split of a parent is refused before anything is written; the order
 *     keeps a parent and merges a plain spelling into it
 *  8. Undo puts a merged source back below its parent, or at the top level with a note
 *  9. Undo leaves the target on a document that carries one of its sub-tags
 * 10. Undo takes the parent the merge added off again, and only that one
 * 11. Undo of a delete and of a split puts the tag back below its parent
 * 12. Without hierarchy fields nothing changes: no parent in a snapshot, no extra field
 * 13. The run says in one sentence that tags with sub-tags were left alone
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

/** Runs `fn` with console.log and console.warn captured. */
async function quietly(fn) {
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

const sorted = (list) => [...list].map(Number).sort((a, b) => a - b);

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-nested-tags-'));
  process.chdir(tempRoot);

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://127.0.0.1:9';
  process.env.PAPERLESS_API_TOKEN = 'test-token';
  process.env.ADD_AI_PROCESSED_TAG = 'no';
  process.env.IGNORE_TAGS = '';
  delete process.env.TAGS;

  const documentModel = require('../models/document');
  const paperlessService = require('../services/paperlessService');
  const dashboardStatsService = require('../services/dashboardStatsService');
  const AIServiceFactory = require('../services/aiServiceFactory');
  const duplicateMergeService = require('../services/duplicateMergeService');
  const tagSimplifyService = require('../services/tagSimplifyService');
  const tidyUpRunService = require('../services/tidyUpRunService');
  const wording = require('../services/tidyUpWording');
  const tagHierarchy = require('../services/tagHierarchy');

  dashboardStatsService.refresh = async () => ({});
  paperlessService.getPublicBaseUrl = async () => 'https://paperless.example';
  // The order runs on the rule alone here.
  AIServiceFactory.getService = () => null;

  function useFake(seed) {
    const fake = createFakePaperless(seed);
    paperlessService.client = fake.client;
    paperlessService.clearEntityCaches();
    duplicateMergeService.invalidateScanCache();
    return fake;
  }

  /** Finance (1) > Invoice (2) > Electricity (3); Car (4) top level, no children. */
  function tree(extra = {}) {
    return useFake({
      tags: [
        { id: 1, name: 'Finance', parent: null },
        { id: 2, name: 'Invoice', parent: 1 },
        { id: 3, name: 'Electricity', parent: 2 },
        { id: 4, name: 'Car', parent: null },
        ...(extra.tags || []),
      ],
      documents: extra.documents || [],
    });
  }

  try {
    /* --- 1. the store ------------------------------------------------------ */

    await test('The store deletes a tag with everything below it and expands modify_tags', async () => {
      const fake = tree({ documents: [{ id: 10, tags: [1, 2, 3] }] });
      const detail = fake.handle('get', '/tags/1/').data;
      assert.deepStrictEqual(
        detail.children.map((child) => child.id),
        [2]
      );
      assert.deepStrictEqual(detail.children[0].children[0].id, 3);

      fake.handle(
        'post',
        '/documents/bulk_edit/',
        {},
        {
          documents: [10],
          method: 'modify_tags',
          parameters: { add_tags: [], remove_tags: [2] },
        }
      );
      assert.deepStrictEqual(
        fake.document(10).tags,
        [1],
        'Electricity goes with Invoice'
      );

      fake.handle(
        'post',
        '/documents/bulk_edit/',
        {},
        {
          documents: [10],
          method: 'modify_tags',
          parameters: { add_tags: [3], remove_tags: [] },
        }
      );
      assert.deepStrictEqual(sorted(fake.document(10).tags), [1, 2, 3]);

      fake.handle('delete', '/tags/2/');
      assert.strictEqual(fake.tag(2), undefined);
      assert.strictEqual(fake.tag(3), undefined, 'the child went with it');
      assert.deepStrictEqual(fake.document(10).tags, [1]);

      assert.throws(
        () => fake.handle('post', '/tags/', {}, { name: 'X', parent: 99 }),
        (error) => error.response.status === 400
      );
      assert.throws(
        () => fake.handle('patch', '/tags/1/', {}, { parent: 1 }),
        (error) => error.response.status === 400
      );
    });

    /* --- 2. records -------------------------------------------------------- */

    await test('listEntities carries parentId and childIds only where Paperless-ngx has them', async () => {
      tree();
      const records = await paperlessService.listEntities('tags');
      const byId = new Map(records.map((record) => [record.id, record]));
      assert.strictEqual(byId.get(2).parentId, 1);
      assert.deepStrictEqual(byId.get(1).childIds, [2]);
      assert.deepStrictEqual(byId.get(3).childIds, []);
      assert.strictEqual(byId.get(4).parentId, null);

      useFake({ tags: [{ id: 1, name: 'Finance' }] });
      const [plain] = await paperlessService.listEntities('tags');
      assert.ok(!('parentId' in plain), 'no field on an older version');
      assert.ok(!('childIds' in plain));
    });

    await test('childIds are completed from the parents when a tag does not list its children', async () => {
      const records = [
        { id: 1, parentId: null, childIds: [] },
        { id: 2, parentId: 1, childIds: [] },
      ];
      paperlessService._completeTagChildren(records);
      assert.deepStrictEqual(records[0].childIds, [2]);
    });

    /* --- 3. the last-moment guard ------------------------------------------ */

    await test('deleteEntity never deletes a tag with sub-tags, and still deletes a leaf', async () => {
      const fake = tree();
      const error = await quietly(() =>
        paperlessService.deleteEntity('tags', 2).then(
          () => null,
          (thrown) => thrown
        )
      );
      assert.ok(error, 'refused');
      assert.strictEqual(error.code, paperlessService.TAG_HAS_CHILDREN);
      assert.deepStrictEqual(error.childIds, [3]);
      assert.ok(fake.tag(2) && fake.tag(3), 'both still there');
      assert.ok(
        !fake.calls.some((call) => call.method === 'delete'),
        'no DELETE went out'
      );
      assert.strictEqual(await paperlessService.deleteEntity('tags', 3), true);
      assert.strictEqual(fake.tag(3), undefined);
      assert.strictEqual(await paperlessService.deleteEntity('tags', 3), false);
    });

    /* --- 4. the scan ------------------------------------------------------- */

    await test('The scan never calls a parent unused, makes it the survivor and counts it', async () => {
      useFake({
        tags: [
          // An empty parent whose child carries the documents.
          { id: 1, name: 'Vehicles', parent: null },
          { id: 2, name: 'Car', parent: 1 },
          // A parent and a plain spelling of it with more documents.
          { id: 5, name: 'Invoice', parent: null },
          { id: 6, name: 'Invoices', parent: null },
          { id: 7, name: 'Electricity', parent: 5 },
          // Two parents that spell the same: never a pair.
          { id: 8, name: 'Bank', parent: null },
          { id: 9, name: 'bank', parent: null },
          { id: 10, name: 'Giro', parent: 8 },
          { id: 11, name: 'Savings', parent: 9 },
          // A plain unused leaf.
          { id: 12, name: 'Empty', parent: null },
        ],
        documents: [
          { id: 100, tags: [1, 2] },
          { id: 101, tags: [6] },
          { id: 102, tags: [6] },
          { id: 103, tags: [5, 7] },
          { id: 104, tags: [10, 8] },
          { id: 105, tags: [11, 9] },
        ],
      });
      const scan = await duplicateMergeService.scan({
        kind: 'tags',
        fresh: true,
      });
      assert.deepStrictEqual(
        scan.unused.tags.map((tag) => tag.name),
        ['Empty']
      );
      assert.strictEqual(scan.tagsWithSubTags, 4);

      const invoice = scan.groups.find((group) =>
        group.members.some((member) => member.id === 6)
      );
      assert.ok(invoice, 'Invoice and Invoices are a group');
      assert.strictEqual(
        invoice.suggestedTargetId,
        5,
        'the tag with sub-tags survives although the other has more documents'
      );
      assert.ok(
        !scan.groups.some(
          (group) =>
            group.members.some((member) => member.id === 8) &&
            group.members.some((member) => member.id === 9)
        ),
        'two tags with sub-tags are never merged into each other'
      );
    });

    await test('An empty parent whose children carry documents is not offered for deletion', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Vehicles', parent: null },
          { id: 2, name: 'Car', parent: 1 },
        ],
        documents: [{ id: 100, tags: [2] }],
      });
      // The store counts direct links only, so the parent shows 0 documents.
      const scan = await duplicateMergeService.scan({
        kind: 'tags',
        fresh: true,
      });
      assert.deepStrictEqual(scan.unused.tags, []);
    });

    /* --- 5. merge ---------------------------------------------------------- */

    await test('A merge that names a parent as source leaves it and its documents alone', async () => {
      const fake = tree({
        tags: [{ id: 6, name: 'Invoices', parent: null }],
        documents: [
          { id: 100, tags: [1, 2, 3] },
          { id: 101, tags: [6] },
        ],
      });
      const result = await quietly(() =>
        duplicateMergeService.merge({
          kind: 'tags',
          targetId: 6,
          sourceIds: [2],
        })
      );
      assert.strictEqual(result.status, 'partial');
      assert.strictEqual(result.documentsMoved, 0);
      assert.strictEqual(result.sources[0].deleted, false);
      assert.match(result.sources[0].error, /sub-tag/);
      assert.ok(fake.tag(2) && fake.tag(3), 'Invoice and Electricity stay');
      assert.deepStrictEqual(sorted(fake.document(100).tags), [1, 2, 3]);
      assert.ok(
        !fake.calls.some((call) => call.path === '/documents/bulk_edit/'),
        'nothing was moved'
      );
    });

    /* --- 6. delete unused -------------------------------------------------- */

    await test('deleteUnused refuses a parent with the plain reason and deletes the rest', async () => {
      const fake = useFake({
        tags: [
          { id: 1, name: 'Vehicles', parent: null },
          { id: 2, name: 'Car', parent: 1 },
          { id: 3, name: 'Empty', parent: null },
        ],
        documents: [{ id: 100, tags: [2] }],
      });
      const result = await quietly(() =>
        duplicateMergeService.deleteUnused({ kind: 'tags', ids: [1, 3] })
      );
      assert.deepStrictEqual(
        result.deleted.map((entry) => entry.id),
        [3]
      );
      assert.strictEqual(result.failed.length, 1);
      assert.strictEqual(result.failed[0].id, 1);
      assert.strictEqual(
        result.failed[0].error,
        'It has a sub-tag, and Paperless-ngx would delete the sub-tag along with it'
      );
      assert.ok(fake.tag(1) && fake.tag(2));
      assert.deepStrictEqual(fake.document(100).tags, [2]);
    });

    /* --- 7. split and the order -------------------------------------------- */

    await test('A split of a parent is refused before anything is written', async () => {
      const fake = useFake({
        tags: [
          { id: 55, name: 'Stromrechnung', parent: null },
          { id: 56, name: 'Stromrechnung 2024', parent: 55 },
        ],
        documentTypes: [{ id: 7, name: 'Rechnung' }],
        documents: [{ id: 100, tags: [55, 56] }],
      });
      await tagSimplifyService.saveVocabulary({
        types: ['Rechnung'],
        topics: ['Strom'],
      });
      await documentModel.replaceTagSplitProposals([
        {
          tagId: 55,
          tagName: 'Stromrechnung',
          documentCount: 1,
          typeName: 'Rechnung',
          topicNames: ['Strom'],
          source: 'rule',
          confidence: 'high',
          reason: 'compound',
          documentsWithType: 0,
          overwriteType: false,
          status: 'open',
        },
      ]);
      const result = await quietly(() =>
        tagSimplifyService.applySplits({ tagIds: [55] })
      );
      assert.strictEqual(result.applied.length, 0);
      assert.match(result.failed[0].error, /sub-tag/);
      assert.ok(fake.tag(55) && fake.tag(56));
      assert.deepStrictEqual(sorted(fake.document(100).tags), [55, 56]);
      assert.ok(!fake.tagNames().includes('Strom'), 'no topic tag was created');
    });

    await test('The order keeps a parent and merges a plain spelling into it', async () => {
      useFake({
        tags: [
          { id: 5, name: 'Invoice', parent: null },
          { id: 6, name: 'Invoices', parent: null },
          { id: 7, name: 'Electricity', parent: 5 },
          { id: 8, name: 'Vehicles', parent: null },
          { id: 9, name: 'Car', parent: 8 },
        ],
        documents: [
          { id: 101, tags: [6] },
          { id: 102, tags: [6] },
          { id: 103, tags: [5, 7] },
          { id: 104, tags: [9] },
        ],
      });
      await tagSimplifyService.saveVocabulary({
        types: ['Rechnung'],
        topics: [],
      });
      await quietly(() =>
        tagSimplifyService.proposeOrder({ vocabulary: 'keep' })
      );
      const rows = new Map(
        (await tagSimplifyService.listProposals()).map((row) => [
          row.tagId,
          row,
        ])
      );
      assert.strictEqual(rows.get(5).action, 'keep');
      assert.strictEqual(rows.get(5).reason, 'it has sub-tags');
      assert.strictEqual(
        rows.get(8).action,
        'keep',
        'not deleted although empty'
      );
      assert.strictEqual(rows.get(6).action, 'merge');
      assert.strictEqual(rows.get(6).mergeInto, 'Invoice');
    });

    /* --- 8. undo: back below the parent ------------------------------------ */

    await test('Undo puts a merged source back below its parent', async () => {
      const fake = tree({
        tags: [{ id: 6, name: 'Invoices', parent: 1 }],
        documents: [{ id: 100, tags: [1, 6] }],
      });
      const merge = await quietly(() =>
        duplicateMergeService.merge({
          kind: 'tags',
          targetId: 2,
          sourceIds: [6],
        })
      );
      assert.strictEqual(merge.status, 'done');
      const entry = await documentModel.getEntityMergeById(merge.mergeId);
      assert.strictEqual(entry.sources[0].snapshot.parent, 1);

      const undo = await quietly(() =>
        duplicateMergeService.undo(merge.mergeId)
      );
      assert.strictEqual(undo.status, 'undone');
      const back = fake.tag(undo.sources[0].restoredId);
      assert.strictEqual(back.name, 'Invoices');
      assert.strictEqual(back.parent, 1);
      assert.strictEqual(undo.sources[0].note, undefined);
      assert.deepStrictEqual(sorted(fake.document(100).tags), [1, back.id]);
    });

    await test('Undo re-creates a source at the top level, with a note, when its parent is gone', async () => {
      const fake = tree({
        tags: [
          { id: 6, name: 'Invoices', parent: 7 },
          { id: 7, name: 'Old', parent: null },
        ],
        documents: [{ id: 100, tags: [7, 6] }],
      });
      const merge = await quietly(() =>
        duplicateMergeService.merge({
          kind: 'tags',
          targetId: 4,
          sourceIds: [6],
        })
      );
      fake.handle('delete', '/tags/7/');
      const undo = await quietly(() =>
        duplicateMergeService.undo(merge.mergeId)
      );
      const back = fake.tag(undo.sources[0].restoredId);
      assert.strictEqual(back.parent, null);
      assert.match(undo.sources[0].note, /parent tag no longer exists/);
    });

    /* --- 9. undo: the target keeps a sub-tag the document carries ---------- */

    await test('Undo leaves the target on a document that carries one of its sub-tags', async () => {
      const fake = tree({
        tags: [{ id: 6, name: 'Bills', parent: null }],
        documents: [
          { id: 100, tags: [6] },
          { id: 101, tags: [6] },
        ],
      });
      const merge = await quietly(() =>
        duplicateMergeService.merge({
          kind: 'tags',
          targetId: 2,
          sourceIds: [6],
        })
      );
      assert.deepStrictEqual(sorted(fake.document(100).tags), [1, 2]);
      // After the merge someone files document 100 under Electricity too.
      fake.document(100).tags.push(3);

      const undo = await quietly(() =>
        duplicateMergeService.undo(merge.mergeId)
      );
      const restoredId = undo.sources[0].restoredId;
      assert.deepStrictEqual(
        sorted(fake.document(100).tags),
        sorted([1, 2, 3, restoredId]),
        'Electricity stays, so Invoice and Finance stay'
      );
      assert.deepStrictEqual(
        fake.document(101).tags,
        [restoredId],
        'the other document is as it was'
      );
      assert.match(undo.sources[0].note, /kept the target/);
    });

    /* --- 10. undo: the parent the merge added ------------------------------ */

    await test('Undo takes off the parent the merge added, and keeps one the document had', async () => {
      const fake = tree({
        tags: [{ id: 6, name: 'Bills', parent: null }],
        documents: [
          { id: 100, tags: [6] },
          { id: 101, tags: [6, 1] },
        ],
      });
      const merge = await quietly(() =>
        duplicateMergeService.merge({
          kind: 'tags',
          targetId: 2,
          sourceIds: [6],
        })
      );
      const entry = await documentModel.getEntityMergeById(merge.mergeId);
      assert.deepStrictEqual(entry.sources[0].ancestorsAdded, [
        { tagId: 1, documentIds: [100] },
      ]);
      const undo = await quietly(() =>
        duplicateMergeService.undo(merge.mergeId)
      );
      const restoredId = undo.sources[0].restoredId;
      assert.deepStrictEqual(fake.document(100).tags, [restoredId]);
      assert.deepStrictEqual(
        sorted(fake.document(101).tags),
        sorted([1, restoredId])
      );
      assert.ok(fake.tag(3), 'Electricity was never touched');
    });

    /* --- 11. undo of a delete and of a split ------------------------------- */

    await test('Undo of a delete puts the tag back below its parent', async () => {
      const fake = tree({ tags: [{ id: 6, name: 'Spare', parent: 4 }] });
      const result = await quietly(() =>
        duplicateMergeService.deleteUnused({ kind: 'tags', ids: [6] })
      );
      assert.deepStrictEqual(result.failed, []);
      const undo = await quietly(() =>
        duplicateMergeService.undo(result.logId)
      );
      assert.strictEqual(fake.tag(undo.sources[0].restoredId).parent, 4);
    });

    await test('Undo of a split puts the tag back below its parent and the topic off again', async () => {
      const fake = useFake({
        tags: [
          { id: 50, name: 'Finanzen', parent: null },
          { id: 55, name: 'Stromrechnung', parent: 50 },
          { id: 60, name: 'Energie', parent: null },
          { id: 61, name: 'Strom', parent: 60 },
        ],
        documentTypes: [{ id: 7, name: 'Rechnung' }],
        documents: [{ id: 100, tags: [50, 55] }],
      });
      await tagSimplifyService.saveVocabulary({
        types: ['Rechnung'],
        topics: ['Strom'],
      });
      await documentModel.replaceTagSplitProposals([
        {
          tagId: 55,
          tagName: 'Stromrechnung',
          documentCount: 1,
          typeName: 'Rechnung',
          topicNames: ['Strom'],
          source: 'rule',
          confidence: 'high',
          reason: 'compound',
          documentsWithType: 0,
          overwriteType: false,
          status: 'open',
        },
      ]);
      const result = await quietly(() =>
        tagSimplifyService.applySplits({ tagIds: [55] })
      );
      assert.strictEqual(
        result.failed.length,
        0,
        JSON.stringify(result.failed)
      );
      assert.deepStrictEqual(sorted(fake.document(100).tags), [50, 60, 61]);

      const undo = await quietly(() =>
        duplicateMergeService.undo(result.applied[0].logId)
      );
      assert.strictEqual(undo.status, 'undone');
      const back = fake.tag(undo.sources[0].restoredId);
      assert.strictEqual(back.parent, 50);
      assert.deepStrictEqual(
        sorted(fake.document(100).tags),
        sorted([50, back.id]),
        'Strom and the Energie it brought along are off again'
      );
    });

    /* --- 12. without hierarchy --------------------------------------------- */

    await test('Without hierarchy fields a merge and its undo are what they always were', async () => {
      const fake = useFake({
        tags: [
          { id: 1, name: 'Invoice' },
          { id: 2, name: 'Invoices' },
        ],
        documents: [
          { id: 100, tags: [2] },
          { id: 101, tags: [1, 2] },
        ],
      });
      const merge = await quietly(() =>
        duplicateMergeService.merge({
          kind: 'tags',
          targetId: 1,
          sourceIds: [2],
        })
      );
      const entry = await documentModel.getEntityMergeById(merge.mergeId);
      assert.ok(!('parent' in entry.sources[0].snapshot));
      assert.ok(!('ancestorsAdded' in entry.sources[0]));
      const before = fake.calls.length;
      const undo = await quietly(() =>
        duplicateMergeService.undo(merge.mergeId)
      );
      assert.strictEqual(undo.status, 'undone');
      assert.ok(!('note' in undo.sources[0]));
      const bulkEdits = fake.calls
        .slice(before)
        .filter((call) => call.path === '/documents/bulk_edit/');
      assert.strictEqual(bulkEdits.length, 2, 'the same two edits as before');
      assert.ok(
        !fake.calls
          .slice(before)
          .some(
            (call) =>
              call.method === 'get' &&
              call.path === '/tags/' &&
              call.params?.name__iexact == null
          ),
        'no read of the whole tag list'
      );
    });

    /* --- 13. the page ------------------------------------------------------ */

    await test('The run says in one sentence that tags with sub-tags were left alone', async () => {
      assert.strictEqual(wording.nestedTagsNote(0), '');
      assert.strictEqual(wording.nestedTagsNote(undefined), '');
      assert.strictEqual(
        wording.nestedTagsNote(1),
        '1 tag with sub-tags was left alone, because Paperless-ngx would delete its sub-tags along with it.'
      );
      assert.strictEqual(
        wording.nestedTagsNote(1200),
        '1,200 tags with sub-tags were left alone, because Paperless-ngx would delete their sub-tags along with them.'
      );
      assert.deepStrictEqual(
        tidyUpRunService._notes({ tagsWithSubTags: 0 }),
        []
      );
      assert.deepStrictEqual(tidyUpRunService._notes({ tagsWithSubTags: 3 }), [
        { kind: 'nested-tags', text: wording.nestedTagsNote(3) },
      ]);
    });

    await test('removableTags never takes a tag whose sub-tag the document keeps', async () => {
      const parentOf = new Map([
        [1, null],
        [2, 1],
        [3, 2],
        [4, null],
      ]);
      assert.deepStrictEqual(
        tagHierarchy.removableTags([1, 2, 3], [2], parentOf),
        []
      );
      assert.deepStrictEqual(
        tagHierarchy.removableTags([1, 2, 3], [3, 2], parentOf),
        [3, 2]
      );
      assert.deepStrictEqual(
        tagHierarchy.removableTags([1, 2, 4], [1, 2], parentOf),
        [1, 2]
      );
      assert.deepStrictEqual(
        tagHierarchy.removableTags([1, 4], [2], parentOf),
        []
      );
      assert.deepStrictEqual(tagHierarchy.ancestorsOf(3, parentOf), [2, 1]);
    });
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
