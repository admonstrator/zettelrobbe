/**
 * Test: the local records behind "Simplify tags" and the judge's memory
 *
 * Round 10 of the Duplicates feature adds a vocabulary of document types and
 * topic tags, one split proposal per tag, remembered verdicts of the AI
 * judge, and a `details` column on the merge log for split rows. These
 * cases pin the model contract the simplify service, the judge, the routes
 * and the page are built against.
 *
 * Covers:
 * 1. Migration v13 creates the three tables and the details column
 * 2. A split row is stored with action 'split' and its details, read back parsed
 * 3. The vocabulary is replaced wholesale, ordered, deduplicated, ids survive
 * 4. Proposals are replaced, listed by name, filtered by status
 * 5. A proposal patch changes only what it names
 * 6. Verdicts are upserted, read by key, pruned by age, cleared
 * 7. The simplify service's thin methods sit on the model
 * 8. The calibration round-trips the thinking cost per request
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
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'zr-simplify-model-')
  );
  process.chdir(tempRoot);
  const documentModel = require('../models/document');
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(tempRoot, 'data', 'documents.db'), {
    readonly: true,
  });

  await test('Migration v13 creates the tables and the details column', () => {
    const version = raw.pragma('user_version', { simple: true });
    assert.ok(version >= 13, `user_version is ${version}`);
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    for (const table of [
      'tag_vocabulary',
      'tag_split_proposals',
      'ai_pair_verdicts',
    ]) {
      assert.ok(tables.includes(table), `${table} missing`);
    }
    const columns = raw
      .prepare('PRAGMA table_info(entity_merges)')
      .all()
      .map((c) => c.name);
    assert.ok(columns.includes('details'), 'entity_merges.details missing');
  });

  await test('A split row keeps its action and details', async () => {
    const details = {
      typeName: 'Rechnung',
      typeId: 7,
      topicTagIds: [31],
      createdTypeId: null,
      createdTagIds: [31],
      documents: [
        { id: 100, addedTagIds: [31], previousTypeId: null, typeSet: true },
        { id: 101, addedTagIds: [31], previousTypeId: 3, typeSet: false },
      ],
    };
    const id = await documentModel.addEntityMerge({
      kind: 'tags',
      targetId: 0,
      targetName: 'Rechnung + Strom',
      sources: [
        {
          id: 55,
          name: 'Stromrechnung',
          deleted: true,
          documentIds: [100, 101],
        },
      ],
      documentsMoved: 2,
      action: 'split',
      details,
    });
    const entry = await documentModel.getEntityMergeById(id);
    assert.strictEqual(entry.action, 'split');
    assert.deepStrictEqual(entry.details, details);
    const merge = await documentModel.addEntityMerge({
      kind: 'tags',
      targetId: 1,
      targetName: 'a',
      sources: [],
    });
    const plain = await documentModel.getEntityMergeById(merge);
    assert.strictEqual(plain.action, 'merge');
    assert.strictEqual(plain.details, null);
    const odd = await documentModel.addEntityMerge({
      kind: 'tags',
      targetId: 1,
      targetName: 'a',
      sources: [],
      action: 'whatever',
    });
    assert.strictEqual(
      (await documentModel.getEntityMergeById(odd)).action,
      'merge'
    );
  });

  await test('The vocabulary is replaced wholesale, ordered and deduplicated', async () => {
    const stored = await documentModel.replaceTagVocabulary([
      { dimension: 'type', name: 'Rechnung', source: 'model' },
      { dimension: 'topic', name: 'Strom' },
      { dimension: 'type', name: 'Brief' },
      { dimension: 'topic', name: 'Strom' },
      { dimension: 'topic', name: '   ' },
      { dimension: 'topic', name: 'Auto', paperlessId: 12 },
    ]);
    assert.strictEqual(stored, 4);
    const rows = await documentModel.getTagVocabulary();
    assert.deepStrictEqual(
      rows.map((row) => [
        row.dimension,
        row.name,
        row.position,
        row.source,
        row.paperlessId,
      ]),
      [
        ['topic', 'Strom', 0, 'user', null],
        ['topic', 'Auto', 1, 'user', 12],
        ['type', 'Rechnung', 0, 'model', null],
        ['type', 'Brief', 1, 'user', null],
      ]
    );
    const strom = rows.find((row) => row.name === 'Strom');
    assert.strictEqual(
      await documentModel.setTagVocabularyPaperlessId(strom.id, 44),
      true
    );
    // A save without ids keeps the ids already known for a name.
    await documentModel.replaceTagVocabulary([
      { dimension: 'topic', name: 'Strom' },
      { dimension: 'type', name: 'Rechnung' },
    ]);
    const after = await documentModel.getTagVocabulary();
    assert.strictEqual(
      after.find((row) => row.name === 'Strom').paperlessId,
      44
    );
    assert.strictEqual(after.length, 2);
  });

  await test('Proposals are replaced, listed by name and filtered by status', async () => {
    const stored = await documentModel.replaceTagSplitProposals([
      {
        tagId: 9,
        tagName: 'Stromrechnung',
        documentCount: 12,
        typeName: 'Rechnung',
        topicNames: ['Strom'],
        source: 'rule',
        confidence: 'high',
        reason: 'compound',
      },
      {
        tagId: 4,
        tagName: 'Autorechnung',
        documentCount: 3,
        typeName: 'Rechnung',
        topicNames: ['Auto'],
        source: 'model',
        confidence: 'low',
        reason: 'the model',
        documentsWithType: 2,
      },
      { tagId: 0, tagName: 'ignored' },
      {
        tagId: 15,
        tagName: 'Zahnarzt',
        typeName: null,
        topicNames: [],
        source: 'model',
        status: 'skipped',
      },
    ]);
    assert.strictEqual(stored, 3);
    const all = await documentModel.listTagSplitProposals();
    assert.deepStrictEqual(
      all.map((row) => row.tagName),
      ['Autorechnung', 'Stromrechnung', 'Zahnarzt']
    );
    const open = await documentModel.listTagSplitProposals({ status: 'open' });
    assert.deepStrictEqual(
      open.map((row) => row.tagId),
      [4, 9]
    );
    const strom = await documentModel.getTagSplitProposal(9);
    assert.deepStrictEqual(strom.topicNames, ['Strom']);
    assert.strictEqual(strom.overwriteType, false);
    assert.strictEqual(strom.documentsWithType, 0);
    assert.strictEqual(all.find((row) => row.tagId === 4).documentsWithType, 2);
  });

  await test('A proposal patch changes only what it names', async () => {
    assert.strictEqual(
      await documentModel.updateTagSplitProposal(9, {}),
      false
    );
    assert.strictEqual(
      await documentModel.updateTagSplitProposal(9, {
        topicNames: ['Energie'],
        overwriteType: true,
        source: 'user',
      }),
      true
    );
    const row = await documentModel.getTagSplitProposal(9);
    assert.deepStrictEqual(row.topicNames, ['Energie']);
    assert.strictEqual(row.overwriteType, true);
    assert.strictEqual(row.typeName, 'Rechnung');
    assert.strictEqual(row.source, 'user');
    await documentModel.updateTagSplitProposal(9, { status: 'applied' });
    assert.strictEqual(
      (await documentModel.getTagSplitProposal(9)).status,
      'applied'
    );
    assert.strictEqual(
      await documentModel.updateTagSplitProposal(999, { status: 'open' }),
      false
    );
    assert.strictEqual(await documentModel.clearTagSplitProposals(), 3);
    assert.deepStrictEqual(await documentModel.listTagSplitProposals(), []);
  });

  await test('Verdicts are upserted, read by key, pruned by age and cleared', async () => {
    assert.strictEqual(
      await documentModel.saveAiPairVerdict({
        kind: 'tags',
        pairKey: '3-9',
        nameA: 'Rechnung',
        nameB: 'Rechnungen',
        verdict: 'same',
        basis: 'plural',
        confidence: 'high',
        reason: 'plural',
        model: 'm',
      }),
      true
    );
    await documentModel.saveAiPairVerdict({
      kind: 'tags',
      pairKey: '3-9',
      nameA: 'Rechnung',
      nameB: 'Rechnungen',
      verdict: 'different',
      model: 'm',
    });
    await documentModel.saveAiPairVerdict({
      kind: 'correspondents',
      pairKey: '1-2',
      nameA: 'a',
      nameB: 'b',
      verdict: 'unsure',
    });
    const rows = await documentModel.getAiPairVerdicts('tags', ['3-9', '7-8']);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].verdict, 'different');
    assert.strictEqual(rows[0].nameB, 'Rechnungen');
    assert.deepStrictEqual(
      await documentModel.getAiPairVerdicts('tags', []),
      []
    );
    assert.strictEqual(await documentModel.countAiPairVerdicts(), 2);
    assert.strictEqual(await documentModel.pruneAiPairVerdicts(30), 0);
    assert.strictEqual(await documentModel.pruneAiPairVerdicts(0), 0);
    assert.strictEqual(await documentModel.clearAiPairVerdicts(), 2);
    assert.strictEqual(await documentModel.countAiPairVerdicts(), 0);
  });

  await test("The simplify service's thin methods sit on the model", async () => {
    const service = require('../services/tagSimplifyService');
    const saved = await service.saveVocabulary({
      types: ['Rechnung', ' Brief ', ''],
      topics: ['Strom', 'Strom'],
    });
    assert.deepStrictEqual(
      saved.types.map((row) => row.name),
      ['Rechnung', 'Brief']
    );
    assert.deepStrictEqual(
      saved.topics.map((row) => row.name),
      ['Strom']
    );
    await documentModel.replaceTagSplitProposals([
      {
        tagId: 9,
        tagName: 'Stromrechnung',
        typeName: 'Rechnung',
        topicNames: ['Strom'],
        source: 'rule',
      },
    ]);
    const patched = await service.updateProposal(9, {
      topicNames: ['Strom', ' Energie ', 'Strom'],
      status: 'skipped',
    });
    assert.deepStrictEqual(patched.topicNames, ['Strom', 'Energie']);
    assert.strictEqual(patched.status, 'skipped');
    assert.strictEqual(patched.source, 'user');
    await assert.rejects(
      () => service.updateProposal(9, { status: 'applied' }),
      /open or skipped/
    );
    await assert.rejects(() => service.updateProposal(123, {}), /no proposal/);
    await assert.rejects(
      () => service.applySplits({ tagIds: [9] }),
      (error) => error.status === 501
    );
    await assert.rejects(
      () => service.proposeVocabulary(),
      (error) => error.status === 501
    );
  });

  await test('The calibration round-trips the thinking cost per request', async () => {
    const columns = raw
      .prepare('PRAGMA table_info(ai_calibration)')
      .all()
      .map((c) => c.name);
    assert.ok(
      columns.includes('thinking_per_request'),
      'ai_calibration.thinking_per_request missing'
    );
    await documentModel.saveAiCalibration({
      model: 'contract-model',
      thinking: false,
      tokensPerPair: 40,
      tokensPerSecond: 60,
      thinkingPerRequest: 620,
      largestCompletion: 900,
    });
    const stored = await documentModel.getAiCalibration(
      'contract-model',
      false
    );
    assert.strictEqual(stored.tokensPerPair, 40);
    assert.strictEqual(stored.thinkingPerRequest, 620);
    assert.strictEqual(stored.largestCompletion, 900);
    // A save that leaves the cost out means "none measured", not "unchanged".
    await documentModel.saveAiCalibration({
      model: 'contract-model',
      thinking: false,
      tokensPerPair: 40,
      tokensPerSecond: 60,
      largestCompletion: 900,
    });
    const reset = await documentModel.getAiCalibration('contract-model', false);
    assert.strictEqual(reset.thinkingPerRequest, null);
  });

  raw.close();
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
