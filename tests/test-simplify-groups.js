/**
 * Test: the proposed order as groups
 *
 * An order run stores one proposal per tag; listGroups() derives the groups
 * they make: one per document type, one per topic, one per merge target, and
 * the two buckets "keep" and "delete".
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
 *  8. An order run reports what the model answered as a tally while it goes
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
    });

    /* --- The tally of an order run ---------------------------------------- */

    await test('An order run reports what the model answered as a tally while it goes', async () => {
      const { createFakePaperless } = require('./helpers/fake-paperless');
      const paperlessService = require('../services/paperlessService');
      const duplicateMergeService = require('../services/duplicateMergeService');
      const AIServiceFactory = require('../services/aiServiceFactory');
      const config = require('../config/config');
      const realGetService = AIServiceFactory.getService;
      const realPerRequest = config.simplifyTagsPerRequest;
      const realConcurrency = config.duplicatesAiConcurrency;

      // Six tags no rule settles, one per request, so a request that
      // answers nothing costs exactly one tag.
      const fake = createFakePaperless({
        tags: [
          { id: 2, name: 'Mobilfunkabo' },
          { id: 3, name: 'Krempel' },
          { id: 4, name: 'Hobby' },
          { id: 5, name: 'Nachbarn' },
          { id: 6, name: 'Nachbarschaft' },
          { id: 7, name: 'Sammlung' },
        ],
        documents: [
          { id: 100, tags: [2, 3] },
          { id: 101, tags: [4, 5] },
          { id: 102, tags: [6, 7] },
        ],
      });
      paperlessService.client = fake.client;
      await withLog(async () => {
        paperlessService.clearEntityCaches();
        duplicateMergeService.invalidateScanCache();
        await service.saveVocabulary({
          types: ['Rechnung', 'Vertrag'],
          topics: ['Strom', 'Telefon'],
        });
      });
      config.simplifyTagsPerRequest = 1;
      config.duplicatesAiConcurrency = 1;

      const answers = {
        2: {
          action: 'split',
          type: 'Vertrag',
          topics: ['Telefon'],
          confidence: 'high',
          reason: 'a phone contract',
        },
        3: { action: 'delete', confidence: 'high', reason: 'says nothing' },
        5: {
          action: 'merge',
          mergeInto: 'Nachbarschaft',
          confidence: 'low',
          reason: 'the same people',
        },
        6: { action: 'keep', confidence: 'low', reason: 'a subject' },
        7: { action: 'keep', confidence: 'high', reason: 'a subject' },
      };
      const provider = {
        client: {},
        lastGenerateTextUsage: null,
        async generateText(prompt) {
          provider.lastGenerateTextUsage = { totalTokens: 100 };
          const ids = [...String(prompt).matchAll(/"id":\s*"(\d+)"/g)].map(
            (match) => match[1]
          );
          // Hobby's request comes back unreadable: a request that answered
          // nothing, which must leave the tally as it was.
          if (ids.includes('4')) return 'not an answer';
          return JSON.stringify(ids.map((id) => ({ id, ...answers[id] })));
        },
      };
      AIServiceFactory.getService = () => provider;

      const patches = [];
      // The unreadable answer is warned about; the warning is expected here.
      const realWarn = console.warn;
      console.warn = () => {};
      try {
        await withLog(() =>
          service.proposeOrder(
            { vocabulary: 'keep' },
            { onProgress: (patch) => patches.push({ ...patch }) }
          )
        );
      } finally {
        console.warn = realWarn;
        AIServiceFactory.getService = realGetService;
        config.simplifyTagsPerRequest = realPerRequest;
        config.duplicatesAiConcurrency = realConcurrency;
      }

      const ordering = patches.filter((patch) => patch.phase === 'ordering');
      assert.ok(ordering.length > 0, 'the order pass reported its phase');
      assert.ok(
        !('tally' in ordering[0]),
        'the first report comes before any answer and carries no tally'
      );
      const tallies = patches
        .filter((patch) => 'tally' in patch)
        .map((patch) => patch.tally);
      assert.strictEqual(
        tallies.length,
        5,
        'one tally with every request that answered, none with the one that did not'
      );
      const sum = (tally) =>
        tally.split + tally.merge + tally.delete + tally.keep + tally.unsure;
      tallies.forEach((tally, at) => {
        assert.strictEqual(sum(tally), at + 1, 'every answer counts once');
      });
      assert.deepStrictEqual(
        tallies[tallies.length - 1],
        { split: 1, merge: 0, delete: 1, keep: 2, unsure: 1 },
        'a low confidence answer counts as unsure, unless it is a keep'
      );
      assert.notStrictEqual(
        tallies[0],
        tallies[1],
        'every patch carries its own count, not one object that keeps moving'
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
