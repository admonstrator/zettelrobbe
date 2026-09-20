/**
 * Test: the proposed order as groups (round 12)
 *
 * The page of round 12 does not show 1300 rows any more, it shows the groups
 * the proposals make: one per document type, one per topic, one per merge
 * target, and the two buckets "keep" and "delete". A group is what the user
 * accepts, skips or reopens, and a tag can be taken out of one without
 * losing the rest of its proposal.
 *
 * Everything here is derived from stored rows, so the suite writes proposals
 * straight into the real models/document.js on a throwaway database and asks
 * the service what it makes of them. No Paperless-ngx and no model: grouping,
 * order, counts and the decisions are arithmetic on what is stored.
 *
 * Covers:
 *  1. A tag with a type and two topics is in three groups
 *  2. Every group counts its tags, its documents and its statuses
 *  3. The totals count every proposal once, whatever it is in
 *  4. The kinds come in the order type, topic, merge, delete, keep
 *  5. Inside a kind the bigger group comes first, then the name
 *  6. Members come by documents, then by name
 *  7. Keys are exact names: umlauts, spaces and a colon survive
 *  8. accept takes open and skipped members, applied ones are left alone
 *  9. skip takes open and accepted members
 * 10. reopen takes accepted and skipped members
 * 11. An unknown key is 404, an unknown decision is 400
 * 12. Out of a type group the tag loses its type
 * 13. Out of a topic group it loses that topic, and the last one makes it keep
 * 14. Out of a merge group and out of delete it becomes keep
 * 15. The keep group has nothing to let go of: 400
 * 16. A tag that is not in the group is 404, an applied one is 409
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

/** Runs `fn` with console.log captured. */
async function withLog(fn) {
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.log = realLog;
  }
}

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-simplify-grp-'));
  process.chdir(tempRoot);

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://127.0.0.1:9';
  process.env.PAPERLESS_API_TOKEN = 'test-token';

  const documentModel = require('../models/document');
  const service = require('../services/tagSimplifyService');

  /** One proposal row with the defaults of an order run. */
  function proposal(row) {
    return {
      tagId: row.tagId,
      tagName: row.tagName,
      documentCount: row.documentCount ?? 0,
      action: row.action ?? 'split',
      mergeInto: row.mergeInto ?? null,
      typeName: row.typeName ?? null,
      topicNames: row.topicNames ?? [],
      source: row.source ?? 'rule',
      confidence: row.confidence ?? 'high',
      reason: row.reason ?? 'because',
      documentsWithType: 0,
      overwriteType: false,
      status: row.status ?? 'open',
    };
  }

  /** Replaces the stored proposals with the given rows. */
  async function useProposals(rows) {
    await documentModel.replaceTagSplitProposals(rows.map(proposal));
  }

  /** The archive most cases work on. */
  async function useArchive() {
    await useProposals([
      {
        tagId: 1,
        tagName: 'Stromrechnung',
        documentCount: 12,
        typeName: 'Rechnung',
        topicNames: ['Strom', 'Haus'],
      },
      {
        tagId: 2,
        tagName: 'Autorechnung',
        documentCount: 30,
        typeName: 'Rechnung',
        topicNames: ['Auto'],
      },
      {
        tagId: 3,
        tagName: 'Stromvertrag',
        documentCount: 4,
        typeName: 'Vertrag',
        topicNames: ['Strom'],
      },
      {
        tagId: 4,
        tagName: 'rechnungen',
        documentCount: 2,
        action: 'merge',
        mergeInto: 'Rechnungen',
      },
      {
        tagId: 5,
        tagName: 'RECHNUNGEN',
        documentCount: 1,
        action: 'merge',
        mergeInto: 'Rechnungen',
      },
      { tagId: 6, tagName: 'todo', documentCount: 0, action: 'delete' },
      { tagId: 7, tagName: 'Strom', documentCount: 9, action: 'keep' },
    ]);
  }

  /** The group of that key, or null. */
  function groupOf(groups, key) {
    return groups.groups.find((entry) => entry.key === key) || null;
  }

  try {
    /* --- What the groups are --------------------------------------------- */

    await test('A tag with a type and two topics is in three groups', async () => {
      await useArchive();
      const groups = await service.listGroups();
      const keys = groups.groups
        .filter((group) => group.members.some((member) => member.tagId === 1))
        .map((group) => group.key);
      assert.deepStrictEqual(
        keys.sort(),
        ['topic:Haus', 'topic:Strom', 'type:Rechnung'],
        'the compound is reviewed under its type and under both topics'
      );
      const member = groupOf(groups, 'type:Rechnung').members.find(
        (entry) => entry.tagId === 1
      );
      assert.deepStrictEqual(
        {
          tagName: member.tagName,
          action: member.action,
          typeName: member.typeName,
          topicNames: member.topicNames,
          mergeInto: member.mergeInto,
          source: member.source,
          confidence: member.confidence,
          status: member.status,
        },
        {
          tagName: 'Stromrechnung',
          action: 'split',
          typeName: 'Rechnung',
          topicNames: ['Strom', 'Haus'],
          mergeInto: null,
          source: 'rule',
          confidence: 'high',
          status: 'open',
        },
        'a member carries the whole proposal, not only its name'
      );
    });

    await test('Every group counts its tags, its documents and its statuses', async () => {
      await useProposals([
        {
          tagId: 1,
          tagName: 'Stromrechnung',
          documentCount: 12,
          typeName: 'Rechnung',
          status: 'open',
        },
        {
          tagId: 2,
          tagName: 'Autorechnung',
          documentCount: 30,
          typeName: 'Rechnung',
          status: 'accepted',
        },
        {
          tagId: 3,
          tagName: 'Handyrechnung',
          documentCount: 3,
          typeName: 'Rechnung',
          status: 'applied',
        },
        {
          tagId: 4,
          tagName: 'Gasrechnung',
          documentCount: 1,
          typeName: 'Rechnung',
          status: 'skipped',
        },
      ]);
      const group = groupOf(await service.listGroups(), 'type:Rechnung');
      assert.deepStrictEqual(
        {
          kind: group.kind,
          name: group.name,
          tags: group.tags,
          documents: group.documents,
          open: group.open,
          accepted: group.accepted,
          applied: group.applied,
          skipped: group.skipped,
        },
        {
          kind: 'type',
          name: 'Rechnung',
          tags: 4,
          documents: 46,
          open: 1,
          accepted: 1,
          applied: 1,
          skipped: 1,
        }
      );
    });

    await test('The totals count every proposal once, whatever it is in', async () => {
      await useArchive();
      const groups = await service.listGroups();
      assert.strictEqual(groups.tags, 7, 'seven proposals, not eleven members');
      assert.deepStrictEqual(
        {
          open: groups.open,
          accepted: groups.accepted,
          applied: groups.applied,
          skipped: groups.skipped,
        },
        { open: 7, accepted: 0, applied: 0, skipped: 0 }
      );
      const members = groups.groups.reduce((sum, group) => sum + group.tags, 0);
      assert.strictEqual(
        members,
        11,
        'the compounds are counted once per group they are in'
      );
    });

    await test('The kinds come in the order type, topic, merge, delete, keep', async () => {
      await useArchive();
      const kinds = (await service.listGroups()).groups.map(
        (group) => group.kind
      );
      const firstOf = (kind) => kinds.indexOf(kind);
      assert.ok(firstOf('type') < firstOf('topic'), 'types before topics');
      assert.ok(firstOf('topic') < firstOf('merge'), 'topics before merges');
      assert.ok(firstOf('merge') < firstOf('delete'), 'merges before deletes');
      assert.ok(
        firstOf('delete') < firstOf('keep'),
        'what is kept comes last: it is the group with nothing to do'
      );
    });

    await test('Inside a kind the bigger group comes first, then the name', async () => {
      await useProposals([
        { tagId: 1, tagName: 'A', documentCount: 2, typeName: 'Brief' },
        { tagId: 2, tagName: 'B', documentCount: 30, typeName: 'Rechnung' },
        { tagId: 3, tagName: 'C', documentCount: 2, typeName: 'Antrag' },
      ]);
      const keys = (await service.listGroups()).groups.map(
        (group) => group.key
      );
      assert.deepStrictEqual(keys, [
        'type:Rechnung',
        'type:Antrag',
        'type:Brief',
      ]);
    });

    await test('Members come by documents, then by name', async () => {
      await useProposals([
        {
          tagId: 1,
          tagName: 'Zahnarzt',
          documentCount: 3,
          typeName: 'Rechnung',
        },
        {
          tagId: 2,
          tagName: 'Apotheke',
          documentCount: 3,
          typeName: 'Rechnung',
        },
        { tagId: 3, tagName: 'Auto', documentCount: 9, typeName: 'Rechnung' },
      ]);
      const group = groupOf(await service.listGroups(), 'type:Rechnung');
      assert.deepStrictEqual(
        group.members.map((member) => member.tagName),
        ['Auto', 'Apotheke', 'Zahnarzt']
      );
    });

    await test('Keys are exact names: umlauts, spaces and a colon survive', async () => {
      await useProposals([
        {
          tagId: 1,
          tagName: 'Behördenbrief',
          documentCount: 4,
          typeName: 'Behörde',
          topicNames: ['Stadt: Bonn'],
        },
        {
          tagId: 2,
          tagName: 'behoerdenbrief',
          documentCount: 1,
          action: 'merge',
          mergeInto: 'Behördenbrief',
        },
      ]);
      const groups = await service.listGroups();
      const keys = groups.groups.map((group) => group.key);
      assert.ok(keys.includes('type:Behörde'), `umlaut key missing: ${keys}`);
      assert.ok(
        keys.includes('topic:Stadt: Bonn'),
        `a name with a colon stays whole: ${keys}`
      );
      assert.ok(keys.includes('merge:Behördenbrief'), `merge key: ${keys}`);
      const decided = await withLog(() =>
        service.decideGroup('topic:Stadt: Bonn', 'accept')
      );
      assert.strictEqual(
        decided.value.changed,
        1,
        'the key round-trips through a decision'
      );
      assert.strictEqual(decided.value.group.name, 'Stadt: Bonn');
    });

    /* --- Deciding a group ------------------------------------------------ */

    await test('accept takes open and skipped members, applied ones are left alone', async () => {
      await useProposals([
        {
          tagId: 1,
          tagName: 'A',
          documentCount: 1,
          typeName: 'Rechnung',
          status: 'open',
        },
        {
          tagId: 2,
          tagName: 'B',
          documentCount: 1,
          typeName: 'Rechnung',
          status: 'skipped',
        },
        {
          tagId: 3,
          tagName: 'C',
          documentCount: 1,
          typeName: 'Rechnung',
          status: 'applied',
        },
      ]);
      const { value, lines } = await withLog(() =>
        service.decideGroup('type:Rechnung', 'accept')
      );
      assert.strictEqual(value.key, 'type:Rechnung');
      assert.strictEqual(value.changed, 2);
      assert.deepStrictEqual(
        {
          open: value.group.open,
          accepted: value.group.accepted,
          applied: value.group.applied,
          skipped: value.group.skipped,
        },
        { open: 0, accepted: 2, applied: 1, skipped: 0 },
        'the answer already carries the group as it is now'
      );
      assert.strictEqual(
        (await documentModel.getTagSplitProposal(3)).status,
        'applied',
        'what was written to Paperless-ngx is not a decision any more'
      );
      assert.ok(
        lines.some(
          (line) =>
            line ===
            '[SIMPLIFY] group "type:Rechnung": accept, 2 of 3 tag(s) changed.'
        ),
        `no group line:\n${lines.join('\n')}`
      );
    });

    await test('skip takes open and accepted members', async () => {
      await useProposals([
        { tagId: 1, tagName: 'A', action: 'delete', status: 'open' },
        { tagId: 2, tagName: 'B', action: 'delete', status: 'accepted' },
        { tagId: 3, tagName: 'C', action: 'delete', status: 'applied' },
      ]);
      const { value } = await withLog(() =>
        service.decideGroup('delete', 'skip')
      );
      assert.strictEqual(value.changed, 2);
      assert.deepStrictEqual(
        [
          (await documentModel.getTagSplitProposal(1)).status,
          (await documentModel.getTagSplitProposal(2)).status,
          (await documentModel.getTagSplitProposal(3)).status,
        ],
        ['skipped', 'skipped', 'applied']
      );
    });

    await test('reopen takes accepted and skipped members', async () => {
      await useProposals([
        {
          tagId: 1,
          tagName: 'A',
          action: 'merge',
          mergeInto: 'Amazon',
          status: 'accepted',
        },
        {
          tagId: 2,
          tagName: 'B',
          action: 'merge',
          mergeInto: 'Amazon',
          status: 'skipped',
        },
        {
          tagId: 3,
          tagName: 'C',
          action: 'merge',
          mergeInto: 'Amazon',
          status: 'open',
        },
      ]);
      const { value } = await withLog(() =>
        service.decideGroup('merge:Amazon', 'reopen')
      );
      assert.strictEqual(value.changed, 2, 'the open one was already open');
      assert.strictEqual(value.group.open, 3);
    });

    await test('An unknown key is 404, an unknown decision is 400', async () => {
      await useArchive();
      await expectRefusal(
        () => service.decideGroup('type:Vertrag2', 'accept'),
        404,
        'a group nobody proposed'
      );
      await expectRefusal(
        () => service.decideGroup('nonsense:Rechnung', 'accept'),
        404,
        'a kind that does not exist'
      );
      await expectRefusal(
        () => service.decideGroup('', 'accept'),
        404,
        'an empty key'
      );
      await expectRefusal(
        () => service.decideGroup('type:Rechnung', 'delete'),
        400,
        'a decision nobody offered'
      );
      await expectRefusal(
        () => service.decideGroup('type:Rechnung', ''),
        400,
        'no decision at all'
      );
    });

    /* --- Taking one tag out of a group ----------------------------------- */

    await test('Out of a type group the tag loses its type', async () => {
      await useArchive();
      const { value } = await withLog(() =>
        service.removeGroupMember('type:Rechnung', 1)
      );
      assert.deepStrictEqual(
        {
          action: value.action,
          typeName: value.typeName,
          topicNames: value.topicNames,
          source: value.source,
        },
        {
          action: 'split',
          typeName: null,
          topicNames: ['Strom', 'Haus'],
          source: 'user',
        },
        'the topics are none of the type group’s business'
      );
      const groups = await service.listGroups();
      assert.ok(
        !groupOf(groups, 'type:Rechnung').members.some(
          (member) => member.tagId === 1
        ),
        'it is gone from the group'
      );
      assert.ok(
        groupOf(groups, 'topic:Strom').members.some(
          (member) => member.tagId === 1
        ),
        'and still in the others'
      );
    });

    await test('Out of a topic group it loses that topic, and the last one makes it keep', async () => {
      await useArchive();
      const first = await withLog(() =>
        service.removeGroupMember('topic:Haus', 1)
      );
      assert.deepStrictEqual(first.value.topicNames, ['Strom']);
      assert.strictEqual(first.value.action, 'split');

      // The tag now has a type and one topic; taking both away leaves nothing
      // to split it into.
      await withLog(() => service.removeGroupMember('topic:Strom', 1));
      const { value } = await withLog(() =>
        service.removeGroupMember('type:Rechnung', 1)
      );
      assert.deepStrictEqual(
        {
          action: value.action,
          typeName: value.typeName,
          topicNames: value.topicNames,
        },
        { action: 'keep', typeName: null, topicNames: [] },
        'a split with nothing left is a tag that stays as it is'
      );
      const groups = await service.listGroups();
      assert.ok(
        groupOf(groups, 'keep').members.some((member) => member.tagId === 1),
        'and it is in the keep group now'
      );
      assert.strictEqual(
        groupOf(groups, 'topic:Haus'),
        null,
        'a group without members is gone'
      );
    });

    await test('Out of a merge group and out of delete it becomes keep', async () => {
      await useArchive();
      const merged = await withLog(() =>
        service.removeGroupMember('merge:Rechnungen', 4)
      );
      assert.deepStrictEqual(
        {
          action: merged.value.action,
          mergeInto: merged.value.mergeInto,
          source: merged.value.source,
        },
        { action: 'keep', mergeInto: null, source: 'user' }
      );
      const deleted = await withLog(() =>
        service.removeGroupMember('delete', 6)
      );
      assert.strictEqual(deleted.value.action, 'keep');
      const groups = await service.listGroups();
      assert.strictEqual(
        groupOf(groups, 'delete'),
        null,
        'the only tag that was to go stays'
      );
      assert.strictEqual(
        groupOf(groups, 'merge:Rechnungen').tags,
        1,
        'the other spelling is still proposed for the merge'
      );
      assert.strictEqual(groupOf(groups, 'keep').tags, 3);
    });

    await test('The keep group has nothing to let go of', async () => {
      await useArchive();
      await expectRefusal(
        () => service.removeGroupMember('keep', 7),
        400,
        'a tag that is kept is already out of everything'
      );
    });

    await test('A tag that is not in the group is 404, an applied one is 409', async () => {
      await useArchive();
      await expectRefusal(
        () => service.removeGroupMember('type:Rechnung', 3),
        404,
        'tag 3 is a Vertrag, not a Rechnung'
      );
      await expectRefusal(
        () => service.removeGroupMember('topic:Auto', 1),
        404,
        'tag 1 does not carry that topic'
      );
      await expectRefusal(
        () => service.removeGroupMember('type:Rechnung', 99),
        404,
        'no proposal at all'
      );
      await expectRefusal(
        () => service.removeGroupMember('type:Vertrag2', 3),
        404,
        'no such group'
      );
      await documentModel.updateTagSplitProposal(2, { status: 'applied' });
      await expectRefusal(
        () => service.removeGroupMember('type:Rechnung', 2),
        409,
        'what was written cannot be taken out again'
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
