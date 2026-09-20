/**
 * Test: services/tagSimplifyService.js
 *
 * "Simplify tags" is the second place in Zettelrobbe that deletes objects in
 * Paperless-ngx, and the first that creates them on the user's behalf: a
 * confirmed split writes topic tags and a document type onto every document
 * of a tag and then deletes the tag. The suite is written from that angle:
 * what has to be true before the DELETE goes out, what has to be written down
 * before it does, and what an undo can rebuild from those notes afterwards.
 *
 * The Paperless-ngx side is the real store (tests/helpers/fake-paperless.js)
 * including its document types, the local side is the real models/document.js
 * on a throwaway database, and the model is a stand-in that answers whatever
 * the case says and records every call.
 *
 * Covers:
 *  0. The document type cache the picker on the page reads: the TTL, the
 *     shared refresh, `fresh`, the writes that empty it, a failed refresh
 *  1. The vocabulary proposal merges the chunks by votes and keeps the size
 *  2. It reads the existing document types into its prompt and reports its
 *     requests as a job
 *  3. A chunk whose answer cannot be read costs that chunk, nothing else
 *  4. The token budget stops the proposal
 *  5. Without a provider the vocabulary proposal is refused
 *  6. Without a vocabulary the split proposals are refused
 *  7. The rule table: the type itself, a compound, a joint, a plural, the
 *     multi-word forms, a topic without a type, an unknown remainder
 *  8. The exclusions: the vocabulary itself, the inbox tag, a configured tag,
 *     a tag the token may not change
 *  9. The model answers what the rule could not settle
 * 10. A type or topic outside the vocabulary is dropped, with a note
 * 11. A cut-off answer is salvaged
 * 12. A stop keeps the proposals that were made and stores them
 * 13. Without a provider the rule proposals are all there is
 * 14. proposalImpact counts the documents that keep their type, and stores it
 * 15. applySplits: tags added, type set, tag deleted, log row with details,
 *     local records rewritten, the caches dropped
 * 16. A document with another type keeps it; overwriteType sets it anyway
 * 17. A created type and a created tag are recorded for the undo
 * 18. Refusals: no proposal, an empty proposal, an inbox tag, a gone tag, a
 *     configured tag, one applied twice
 * 19. A tag that still carries documents afterwards is not deleted: partial
 * 20. undoSplit puts the tag, the documents and the types back
 * 21. An object the split created is only deleted when nothing uses it
 * 22. undoSplit adopts a tag of the same name instead of creating a second
 * 23. A second undo is refused
 * 24. duplicateMergeService.undo() hands a split row to undoSplit
 *
 * Round 12, the proposed order:
 * 25. The rule gives every tag one of the four actions, in its own order
 * 26. A plural or another spelling merges into the tag with more documents
 * 27. The model settles the rest, with all four actions
 * 28. What the model may not say turns into keep, with a note
 * 29. Without a vocabulary there is nothing to keep
 * 30. The two phases, the counts and the log line of a run
 * 31. The apply works through merges, then splits, then deletes
 * 32. A deleted tag gives its documents back when the delete is undone
 * 33. A merge goes through the merge service and can be undone
 * 34. A merge target that is gone is a failure entry
 * 35. A stop between two tags leaves the rest accepted
 * 36. An apply with nothing accepted is not an error
 * 37. One group applies without touching the rest
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

/** Runs `fn` with console.log and console.warn captured. */
async function withLog(fn) {
  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

function simplifyLines(lines) {
  return lines.filter((line) => line.startsWith('[SIMPLIFY]'));
}

/** The ids a split request carried, in the order the prompt lists them. */
function idsInPrompt(prompt) {
  return [...String(prompt).matchAll(/"id":\s*"(\d+)"/g)].map(
    (match) => match[1]
  );
}

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-simplify-svc-'));
  process.chdir(tempRoot);

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://127.0.0.1:9';
  process.env.PAPERLESS_API_TOKEN = 'test-token';
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'test';
  process.env.OPENAI_MODEL = 'test-model';
  process.env.ADD_AI_PROCESSED_TAG = 'yes';
  process.env.AI_PROCESSED_TAG_NAME = 'ai-processed';
  process.env.IGNORE_TAGS = 'do-not-touch';
  delete process.env.TAGS;

  const config = require('../config/config');
  // The cases below count requests one after the other; the lane cases set
  // their own concurrency and restore this.
  config.duplicatesAiConcurrency = 1;
  const documentModel = require('../models/document');
  const paperlessService = require('../services/paperlessService');
  const dashboardStatsService = require('../services/dashboardStatsService');
  const AIServiceFactory = require('../services/aiServiceFactory');
  const duplicateMergeService = require('../services/duplicateMergeService');
  const service = require('../services/tagSimplifyService');

  // The dashboard rebuild is fired detached after every write; it would talk
  // to the network and outlive the test process.
  dashboardStatsService.refresh = async () => ({});
  const realGetService = AIServiceFactory.getService;

  /** Points the service at a fresh store and returns it. */
  function useFake(seed) {
    const fake = createFakePaperless(seed);
    paperlessService.client = fake.client;
    paperlessService.clearEntityCaches();
    duplicateMergeService.invalidateScanCache();
    return fake;
  }

  /** Points the factory at a stand-in that answers with `respond`. */
  function useProvider(respond) {
    const calls = [];
    const provider = {
      client: {},
      lastGenerateTextUsage: null,
      async generateText(prompt, options) {
        calls.push({ prompt, options });
        const answer = await respond(prompt, options, calls.length);
        if (answer instanceof Error) throw answer;
        provider.lastGenerateTextUsage = { totalTokens: 100 };
        return answer;
      },
    };
    AIServiceFactory.getService = () => provider;
    return { provider, calls };
  }

  /** No provider at all: what an instance without an API key looks like. */
  function useNoProvider() {
    AIServiceFactory.getService = () => null;
  }

  /** Saves a vocabulary the way the page does. */
  async function useVocabulary(types, topics) {
    await service.saveVocabulary({ types, topics });
  }

  /** The archive the apply and undo cases share. */
  function splitArchive() {
    return useFake({
      tags: [
        { id: 55, name: 'Stromrechnung' },
        { id: 60, name: 'Inbox', is_inbox_tag: true },
      ],
      documentTypes: [{ id: 7, name: 'Rechnung' }],
      documents: [
        { id: 100, tags: [55], document_type: null },
        { id: 101, tags: [55], document_type: null },
        { id: 102, tags: [55], document_type: 3 },
      ],
    });
  }

  /** One open proposal, as proposeSplits would have stored it. */
  async function useProposal(row) {
    await documentModel.replaceTagSplitProposals([
      {
        tagId: 55,
        tagName: 'Stromrechnung',
        documentCount: 3,
        typeName: 'Rechnung',
        topicNames: ['Strom'],
        source: 'rule',
        confidence: 'high',
        reason: 'compound of Rechnung and Strom',
        documentsWithType: 0,
        overwriteType: false,
        status: 'open',
        ...row,
      },
    ]);
  }

  try {
    /* --- The document type cache ---------------------------------------- */
    /* Not the simplify service's own code, but the list it and the picker on
       its page read. It sits here because this suite is the one that drives
       the real paperlessService against a real store. */

    /** How many times the code paged through /document_types/. */
    const typeReads = (fake) =>
      fake.calls.filter(
        (call) => call.method === 'get' && call.path === '/document_types/'
      ).length;

    await test('The document type cache answers a second call without a request', async () => {
      const fake = useFake({
        documentTypes: [
          { id: 7, name: 'Rechnung' },
          { id: 8, name: 'Brief' },
        ],
        documents: [{ id: 1, document_type: 7 }],
      });

      const { value: first, lines } = await withLog(() =>
        paperlessService.listDocumentTypesCached()
      );
      assert.deepStrictEqual(
        first.map((record) => record.name),
        ['Brief', 'Rechnung'],
        'the records are what listDocumentTypes() builds, in its order'
      );
      assert.strictEqual(first[1].documentCount, 1, 'counts come along');
      assert.strictEqual(first[1].userCanChange, true);
      assert.strictEqual(typeReads(fake), 1, 'one read to fill an empty cache');
      assert.ok(
        lines.some((line) =>
          line.includes('Document type cache empty, building it (TTL:')
        ),
        'a refresh says why it happened, the way the tag cache does'
      );
      assert.ok(
        lines.some((line) =>
          line.includes('Document type cache refreshed. Found 2 document types')
        ),
        'and what it found'
      );

      const second = await paperlessService.listDocumentTypesCached();
      assert.strictEqual(typeReads(fake), 1, 'the second call is the cache');
      assert.deepStrictEqual(
        second.map((record) => record.name),
        ['Brief', 'Rechnung']
      );
      // The caller gets a copy; editing it must not edit the cache.
      second.pop();
      const third = await paperlessService.listDocumentTypesCached();
      assert.strictEqual(third.length, 2, 'the cache handed out its own array');

      // Callers that arrive while one refresh runs share it.
      paperlessService.clearDocumentTypeCache();
      const together = await Promise.all([
        paperlessService.listDocumentTypesCached(),
        paperlessService.listDocumentTypesCached(),
        paperlessService.listDocumentTypesCached(),
      ]);
      assert.strictEqual(typeReads(fake), 2, 'three callers, one refresh');
      together.forEach((records) => assert.strictEqual(records.length, 2));
    });

    await test('fresh reads past the cache, and so does an expired one', async () => {
      const fake = useFake({ documentTypes: [{ id: 7, name: 'Rechnung' }] });

      await paperlessService.listDocumentTypesCached();
      assert.strictEqual(typeReads(fake), 1);
      await paperlessService.listDocumentTypesCached({ fresh: false });
      assert.strictEqual(typeReads(fake), 1, 'fresh: false is the cache');

      const { value: records, lines } = await withLog(() =>
        paperlessService.listDocumentTypesCached({ fresh: true })
      );
      assert.strictEqual(typeReads(fake), 2, 'fresh: true reads again');
      assert.deepStrictEqual(
        records.map((record) => record.name),
        ['Rechnung']
      );
      assert.ok(
        lines.some((line) =>
          line.includes('Document type cache bypassed on request')
        ),
        'the log has to say that the cache was skipped on purpose'
      );

      // An entry older than the TTL is read again without being asked to.
      paperlessService.lastDocumentTypeRefresh =
        Date.now() - paperlessService.CACHE_LIFETIME - 1000;
      const { lines: expiredLines } = await withLog(() =>
        paperlessService.listDocumentTypesCached()
      );
      assert.strictEqual(typeReads(fake), 3, 'an expired cache is rebuilt');
      assert.ok(
        expiredLines.some((line) =>
          line.includes('Document type cache expired (age:')
        ),
        'and says how old it was'
      );
    });

    await test('Every write that touches a document type empties the cache', async () => {
      const fake = useFake({
        documentTypes: [{ id: 7, name: 'Rechnung' }],
      });

      await paperlessService.listDocumentTypesCached();
      assert.strictEqual(typeReads(fake), 1);

      // A type a split creates must be in the next answer.
      const created = await paperlessService.createDocumentType('Brief');
      assert.strictEqual(created.name, 'Brief');
      assert.strictEqual(
        paperlessService.documentTypeCache.length,
        0,
        'a create must drop the list it just made wrong'
      );
      const afterCreate = await paperlessService.listDocumentTypesCached();
      assert.strictEqual(typeReads(fake), 2);
      assert.ok(
        afterCreate.some((record) => record.name === 'Brief'),
        'the created type is listed at once'
      );

      await paperlessService.deleteDocumentType(created.id);
      assert.strictEqual(
        paperlessService.documentTypeCache.length,
        0,
        'a delete must drop it too'
      );
      const afterDelete = await paperlessService.listDocumentTypesCached();
      assert.strictEqual(typeReads(fake), 3);
      assert.ok(
        !afterDelete.some((record) => record.name === 'Brief'),
        'the deleted type is gone from the next answer'
      );

      // The one call every write of the Duplicates feature already makes.
      await paperlessService.listDocumentTypesCached();
      assert.strictEqual(typeReads(fake), 3, 'still cached');
      paperlessService.clearEntityCaches();
      assert.strictEqual(paperlessService.documentTypeCache.length, 0);
      assert.strictEqual(paperlessService.documentTypeCacheFilledAt(), 0);
      await paperlessService.listDocumentTypesCached();
      assert.strictEqual(typeReads(fake), 4, 'and read again after it');
    });

    await test('A refresh that fails keeps what the cache had and throws', async () => {
      const fake = useFake({
        documentTypes: [
          { id: 7, name: 'Rechnung' },
          { id: 8, name: 'Brief' },
        ],
      });

      await paperlessService.listDocumentTypesCached();
      const filledAt = paperlessService.documentTypeCacheFilledAt();
      assert.ok(filledAt > 0, 'the cache knows when it was built');

      const realGet = fake.client.get;
      fake.client.get = async () => {
        throw new Error('connect ECONNREFUSED');
      };
      let thrown = null;
      try {
        await paperlessService.listDocumentTypesCached({ fresh: true });
      } catch (error) {
        thrown = error;
      }
      fake.client.get = realGet;

      assert.ok(thrown, 'a read that fails must not be swallowed');
      assert.match(thrown.message, /ECONNREFUSED/);
      assert.deepStrictEqual(
        paperlessService.documentTypeCache.map((record) => record.name),
        ['Brief', 'Rechnung'],
        'the entries of the last good read are still there'
      );
      assert.strictEqual(
        paperlessService.documentTypeCacheFilledAt(),
        filledAt,
        'and they are still dated from then'
      );
      // The next caller is served from them rather than from nothing.
      const after = await paperlessService.listDocumentTypesCached();
      assert.strictEqual(after.length, 2);
    });

    /* --- The vocabulary proposal --------------------------------------- */

    await test('The vocabulary proposal merges the chunks by votes and keeps the size', async () => {
      const tags = [];
      for (let id = 1; id <= 120; id += 1) {
        tags.push({ id, name: `Tag ${String(id).padStart(3, '0')}` });
      }
      useFake({ tags });
      config.duplicatesAiSweepNames = 50;
      config.simplifyVocabularySize = 6;
      const answers = [
        { types: ['Rechnung', 'Brief'], topics: ['Strom', 'Auto'] },
        { types: ['Rechnung'], topics: ['Strom', 'Steuer'] },
        { types: ['Vertrag'], topics: ['Strom'] },
      ];
      const { calls } = useProvider((prompt, options, index) =>
        JSON.stringify(answers[index - 1])
      );

      const result = await service.proposeVocabulary();

      assert.strictEqual(calls.length, 3, '120 names in chunks of 50');
      assert.strictEqual(result.requests, 3);
      assert.deepStrictEqual(
        result.types,
        ['Rechnung', 'Brief'],
        'two types at most: a third of six, and the most voted first'
      );
      assert.deepStrictEqual(
        result.topics,
        ['Strom', 'Auto', 'Steuer'],
        'the rest of the six, by votes then by first appearance'
      );
      assert.ok(result.tokens > 0, 'the tokens are counted');
      assert.deepStrictEqual(
        await service.getVocabulary(),
        { types: [], topics: [] },
        'a proposal saves nothing'
      );
    });

    await test('The proposal reads the existing document types and reports its requests', async () => {
      useFake({
        tags: [{ id: 1, name: 'Stromrechnung' }],
        documentTypes: [
          { id: 7, name: 'Rechnung' },
          { id: 8, name: 'Brief' },
        ],
      });
      const { calls } = useProvider(() =>
        JSON.stringify({ types: ['Rechnung'], topics: ['Strom'] })
      );
      const patches = [];
      const { value, lines } = await withLog(() =>
        service.proposeVocabulary(
          {},
          { onProgress: (patch) => patches.push(patch) }
        )
      );

      const system = calls[0].options.systemPrompt;
      assert.ok(
        system.includes('reuse them by name where they fit: Rechnung, Brief'),
        `the existing types are in the prompt:\n${system}`
      );
      assert.ok(
        system.includes('"types"') && system.includes('"topics"'),
        'the answer shape is in the prompt'
      );
      assert.strictEqual(calls[0].options.temperature, 0);
      assert.strictEqual(calls[0].options.reasoning, false);
      assert.ok(
        patches.some(
          (patch) =>
            patch.phase === 'vocabulary' &&
            patch.message ===
              'Reading 1 tag names for a vocabulary, request 1 of 1…'
        ),
        `no vocabulary line:\n${JSON.stringify(patches)}`
      );
      assert.strictEqual(value.requests, 1);
      assert.ok(
        simplifyLines(lines).some(
          (line) =>
            line ===
            '[SIMPLIFY] vocabulary proposed from 1 tag names in 1 request(s): ' +
              '1 type(s), 1 topic(s).'
        ),
        `no log line:\n${simplifyLines(lines).join('\n')}`
      );
    });

    await test('A chunk whose answer cannot be read costs that chunk, nothing else', async () => {
      const tags = [];
      for (let id = 1; id <= 60; id += 1) tags.push({ id, name: `Tag ${id}` });
      useFake({ tags });
      config.duplicatesAiSweepNames = 50;
      config.simplifyVocabularySize = 6;
      useProvider((prompt, options, index) =>
        index === 1
          ? 'I am afraid I cannot do that'
          : JSON.stringify({ types: ['Brief'], topics: ['Auto'] })
      );

      const { value } = await withLog(() => service.proposeVocabulary());
      assert.strictEqual(value.requests, 2);
      assert.deepStrictEqual(value.types, ['Brief']);
      assert.deepStrictEqual(value.topics, ['Auto']);
    });

    await test('The token budget stops the vocabulary proposal', async () => {
      const tags = [];
      for (let id = 1; id <= 200; id += 1) tags.push({ id, name: `Tag ${id}` });
      useFake({ tags });
      config.duplicatesAiSweepNames = 50;
      useProvider(() => JSON.stringify({ types: ['Brief'], topics: ['Auto'] }));

      let stoppedWith = null;
      const control = {
        tokenBudget: 150,
        stop: (reason) => {
          stoppedWith = reason;
          control.stopped = true;
        },
        stopReason: () => (control.stopped ? 'token-budget' : null),
      };
      const { value } = await withLog(() =>
        service.proposeVocabulary({}, control)
      );
      assert.strictEqual(value.requests, 2, 'two requests spend 200 tokens');
      assert.strictEqual(stoppedWith, 'token-budget');
      assert.strictEqual(value.stopped, true);
    });

    await test('Without a provider the vocabulary proposal is refused', async () => {
      useFake({ tags: [{ id: 1, name: 'Stromrechnung' }] });
      useNoProvider();
      const error = await expectRefusal(
        () => service.proposeVocabulary(),
        409,
        'no provider'
      );
      assert.match(error.message, /provider is not configured/);
    });

    /* --- The split proposals -------------------------------------------- */

    await test('Without a vocabulary the split proposals are refused', async () => {
      useFake({ tags: [{ id: 1, name: 'Stromrechnung' }] });
      await documentModel.replaceTagVocabulary([]);
      const error = await expectRefusal(
        () => service.proposeSplits(),
        409,
        'no vocabulary'
      );
      assert.match(error.message, /Save a vocabulary first/);
    });

    await test('The rule settles what the vocabulary accounts for', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Rechnungen' },
          { id: 2, name: 'Stromrechnung' },
          { id: 3, name: 'Versicherungsbeitrag' },
          { id: 4, name: 'Gasrechnungen' },
          { id: 5, name: 'Rechnung (Auto)' },
          { id: 6, name: 'Stromanbieter' },
          { id: 7, name: 'Handyrechnung' },
          { id: 8, name: 'Nachbarschaft' },
        ],
      });
      await useVocabulary(
        ['Rechnung', 'Beitrag'],
        ['Strom', 'Gas', 'Auto', 'Versicherung']
      );
      useNoProvider();

      const { value } = await withLog(() => service.proposeSplits());
      assert.strictEqual(value.usedModel, false);
      const rows = await service.listProposals();
      const byName = new Map(rows.map((row) => [row.tagName, row]));

      assert.deepStrictEqual(
        {
          typeName: byName.get('Rechnungen').typeName,
          topicNames: byName.get('Rechnungen').topicNames,
          confidence: byName.get('Rechnungen').confidence,
          reason: byName.get('Rechnungen').reason,
          source: byName.get('Rechnungen').source,
        },
        {
          typeName: 'Rechnung',
          topicNames: [],
          confidence: 'high',
          reason: 'the type itself',
          source: 'rule',
        },
        'a plain type in the plural'
      );
      assert.deepStrictEqual(
        [
          byName.get('Stromrechnung').typeName,
          byName.get('Stromrechnung').topicNames,
          byName.get('Stromrechnung').reason,
        ],
        ['Rechnung', ['Strom'], 'compound of Rechnung and Strom']
      );
      assert.deepStrictEqual(
        [
          byName.get('Versicherungsbeitrag').typeName,
          byName.get('Versicherungsbeitrag').topicNames,
        ],
        ['Beitrag', ['Versicherung']],
        'the joint is taken off'
      );
      assert.deepStrictEqual(
        [
          byName.get('Gasrechnungen').typeName,
          byName.get('Gasrechnungen').topicNames,
        ],
        ['Rechnung', ['Gas']],
        'the plural of the compound'
      );
      assert.deepStrictEqual(
        [
          byName.get('Rechnung (Auto)').typeName,
          byName.get('Rechnung (Auto)').topicNames,
        ],
        ['Rechnung', ['Auto']],
        'the written-out form'
      );
      assert.deepStrictEqual(
        [
          byName.get('Stromanbieter').typeName,
          byName.get('Stromanbieter').topicNames,
          byName.get('Stromanbieter').confidence,
        ],
        [null, ['Strom'], 'low'],
        'a topic without a type is only a guess'
      );
      assert.match(
        byName.get('Stromanbieter').reason,
        /"anbieter" is not in the vocabulary/
      );
      assert.deepStrictEqual(
        [
          byName.get('Handyrechnung').typeName,
          byName.get('Handyrechnung').confidence,
        ],
        ['Rechnung', 'low'],
        'a remainder nobody named stays low'
      );
      assert.ok(
        !byName.has('Nachbarschaft'),
        'a name the vocabulary says nothing about gets no proposal'
      );
      assert.strictEqual(value.byRule, rows.length);
      assert.strictEqual(value.withoutProposal, 1);
    });

    await test('The vocabulary itself, the inbox tag and the settings are left alone', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Stromrechnung' },
          { id: 2, name: 'Strom' },
          { id: 3, name: 'Rechnung' },
          { id: 4, name: 'Inbox', is_inbox_tag: true },
          { id: 5, name: 'ai-processed' },
          { id: 6, name: 'do-not-touch' },
          { id: 7, name: 'Gasrechnung', user_can_change: false },
        ],
      });
      await useVocabulary(['Rechnung'], ['Strom', 'Gas']);
      useNoProvider();

      const { value } = await withLog(() => service.proposeSplits());
      const names = (await service.listProposals()).map((row) => row.tagName);
      assert.deepStrictEqual(names, ['Stromrechnung']);
      assert.strictEqual(value.skipped, 6, 'six tags never became candidates');
      assert.strictEqual(value.candidates, 1);
    });

    await test('The model answers what the rule could not settle', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Stromrechnung' },
          { id: 2, name: 'Handyvertrag' },
          { id: 3, name: 'Nachbarschaft' },
        ],
      });
      await useVocabulary(['Rechnung', 'Vertrag'], ['Strom', 'Telefon']);
      config.simplifyTagsPerRequest = 50;
      const { calls } = useProvider((prompt) =>
        JSON.stringify(
          idsInPrompt(prompt).map((id) => ({
            id,
            type: id === '2' ? 'Vertrag' : null,
            topics: id === '2' ? ['Telefon'] : [],
            confidence: 'high',
            reason: 'a mobile phone contract',
          }))
        )
      );

      const { value, lines } = await withLog(() => service.proposeSplits());
      assert.strictEqual(calls.length, 1, 'one request for the two unsettled');
      assert.deepStrictEqual(
        idsInPrompt(calls[0].prompt).sort(),
        ['2', '3'],
        'the settled compound is not asked about'
      );
      assert.ok(
        calls[0].options.systemPrompt.includes(
          'The topics you may use: Strom, Telefon.'
        ),
        'the vocabulary is in the prompt'
      );
      const rows = new Map(
        (await service.listProposals()).map((row) => [row.tagName, row])
      );
      assert.deepStrictEqual(
        [
          rows.get('Handyvertrag').typeName,
          rows.get('Handyvertrag').topicNames,
          rows.get('Handyvertrag').source,
          rows.get('Handyvertrag').reason,
        ],
        ['Vertrag', ['Telefon'], 'model', 'a mobile phone contract']
      );
      assert.strictEqual(
        rows.get('Stromrechnung').source,
        'rule',
        'the rule keeps what it settled'
      );
      assert.strictEqual(
        rows.get('Nachbarschaft').typeName,
        null,
        'the model may say "nothing"'
      );
      assert.strictEqual(value.byRule, 1);
      assert.strictEqual(value.byModel, 2);
      assert.ok(
        simplifyLines(lines).some((line) =>
          /^\[SIMPLIFY\] proposals: 3 tag\(s\), 1 by rule, 2 by the model in 1 request\(s\), 0 without a proposal\.$/.test(
            line
          )
        ),
        `no totals line:\n${simplifyLines(lines).join('\n')}`
      );
    });

    await test('A name outside the vocabulary is dropped, with a note in the reason', async () => {
      useFake({ tags: [{ id: 3, name: 'Nachbarschaft' }] });
      await useVocabulary(['Rechnung'], ['Strom']);
      useProvider(() =>
        JSON.stringify([
          {
            id: '3',
            type: 'Protokoll',
            topics: ['Strom', 'Nachbarn'],
            confidence: 'low',
            reason: 'minutes of the neighbourhood meeting',
          },
        ])
      );

      await withLog(() => service.proposeSplits());
      const [row] = await service.listProposals();
      assert.strictEqual(row.typeName, null, 'the invented type is dropped');
      assert.deepStrictEqual(
        row.topicNames,
        ['Strom'],
        'the invented topic is dropped, the known one stays'
      );
      assert.match(
        row.reason,
        /\(not in the vocabulary: Protokoll, Nachbarn\)/
      );
    });

    await test('A cut-off answer keeps the proposals the model managed to write', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Nachbarschaft' },
          { id: 2, name: 'Gartenarbeit' },
        ],
      });
      await useVocabulary(['Rechnung'], ['Strom']);
      useProvider(() => {
        const error = new Error('the answer hit the token limit');
        error.code = 'ai_response_truncated';
        error.partialText =
          '[{"id":"1","type":"Rechnung","topics":[],"confidence":"low","reason":"an invoice"},{"id":"2","typ';
        return error;
      });

      const { value, lines } = await withLog(() => service.proposeSplits());
      assert.strictEqual(value.byModel, 1, 'the complete object survives');
      const rows = await service.listProposals();
      assert.deepStrictEqual(
        rows.map((row) => row.tagName),
        ['Nachbarschaft']
      );
      assert.ok(
        simplifyLines(lines).some((line) =>
          /salvaged 1 proposal\(s\)/.test(line)
        ),
        `no salvage line:\n${simplifyLines(lines).join('\n')}`
      );
    });

    await test('A vocabulary answer cut off by thinking is asked again with a raised cap', async () => {
      // The floor (Response Tokens) would hide the computed cap.
      const responseTokensBefore = config.responseTokens;
      config.responseTokens = 0;
      try {
        useFake({
          tags: [
            { id: 1, name: 'Stromrechnung' },
            { id: 2, name: 'Autorechnung' },
          ],
        });
        service._observedThinking = 0;
        const { calls } = useProvider((prompt, options, call) => {
          if (call === 1) {
            // What a model that thinks despite the switch leaves behind: the
            // cap spent, nothing usable in the answer.
            const error = new Error('the answer hit the token limit');
            error.code = 'ai_response_truncated';
            error.partialText = '';
            return error;
          }
          return JSON.stringify({
            types: ['Rechnung'],
            topics: ['Strom', 'Auto'],
          });
        });

        const { value, lines } = await withLog(() =>
          service.proposeVocabulary()
        );
        assert.strictEqual(calls.length, 2, 'asked once more');
        assert.strictEqual(
          calls[0].options.maxTokens,
          Math.max(160, Number(config.simplifyVocabularySize) * 16),
          'the first cap is the plain one'
        );
        assert.ok(
          calls[1].options.maxTokens >= 2048,
          `the raised cap is ${calls[1].options.maxTokens}`
        );
        assert.deepStrictEqual(value.types, ['Rechnung']);
        assert.deepStrictEqual(value.topics, ['Strom', 'Auto']);
        assert.ok(
          simplifyLines(lines).some((line) =>
            /cap \d+ — the answer hit the token limit with nothing usable in it .*raising the cap to \d+ and asking again/.test(
              line
            )
          ),
          `no raise line:\n${simplifyLines(lines).join('\n')}`
        );
      } finally {
        config.responseTokens = responseTokensBefore;
      }
    });

    await test('The thinking the judge measured widens every cap of this service', async () => {
      // The floor (Response Tokens) would hide the computed cap.
      const responseTokensBefore = config.responseTokens;
      config.responseTokens = 0;
      try {
        useFake({ tags: [{ id: 1, name: 'Stromrechnung' }] });
        const judge = require('../services/entityMatchAiService');
        const model = judge.modelName() || '';
        service._observedThinking = 0;
        judge.calibration.set(model, {
          tokensPerPair: 40,
          tokensPerSecond: 60,
          thinkingPerRequest: 600,
          largestCompletion: 0,
          thinking: judge.thinkingEnabled(),
          measuredAt: Date.now(),
        });
        try {
          const { calls } = useProvider(() =>
            JSON.stringify({ types: ['Rechnung'], topics: ['Strom'] })
          );
          await service.proposeVocabulary();
          assert.strictEqual(
            calls[0].options.maxTokens,
            Math.max(160, Number(config.simplifyVocabularySize) * 16) + 750,
            'the plain cap plus 1.25 times the measured thinking'
          );
        } finally {
          judge.calibration.delete(model);
        }
      } finally {
        config.responseTokens = responseTokensBefore;
      }
    });

    await test('Thinking seen in one answer widens the next cap', async () => {
      // The floor (Response Tokens) would hide the computed cap.
      const responseTokensBefore = config.responseTokens;
      config.responseTokens = 0;
      try {
        useFake({
          tags: [
            { id: 1, name: 'Nachbarschaft' },
            { id: 2, name: 'Gartenarbeit' },
          ],
        });
        await useVocabulary(['Rechnung'], ['Strom', 'Auto']);
        config.simplifyTagsPerRequest = 1;
        service._observedThinking = 0;
        const calls = [];
        const provider = {
          client: {},
          lastGenerateTextUsage: null,
          async generateText(prompt, options) {
            calls.push({ prompt, options });
            // The first answer reports 900 tokens of reasoning next to it.
            provider.lastGenerateTextUsage = {
              totalTokens: 100,
              reasoningTokens: calls.length === 1 ? 900 : 0,
            };
            return JSON.stringify(
              idsInPrompt(prompt).map((id) => ({
                id,
                type: 'Rechnung',
                topics: [],
                confidence: 'high',
                reason: 'an invoice',
              }))
            );
          },
        };
        AIServiceFactory.getService = () => provider;
        try {
          await service.proposeSplits();
          assert.strictEqual(calls.length, 2, 'one tag per request');
          assert.strictEqual(
            calls[0].options.maxTokens,
            160,
            'nothing known yet'
          );
          assert.strictEqual(
            calls[1].options.maxTokens,
            160 + 1125,
            'the second cap reserves 1.25 times the thinking the first answer cost'
          );
        } finally {
          service._observedThinking = 0;
          config.simplifyTagsPerRequest = 50;
        }
      } finally {
        config.responseTokens = responseTokensBefore;
      }
    });

    await test("The operator's Response Tokens is the floor of every cap", async () => {
      useFake({ tags: [{ id: 1, name: 'Stromrechnung' }] });
      const responseTokensBefore = config.responseTokens;
      config.responseTokens = 25000;
      service._observedThinking = 0;
      try {
        const { calls } = useProvider(() =>
          JSON.stringify({ types: ['Rechnung'], topics: ['Strom'] })
        );
        await service.proposeVocabulary();
        assert.strictEqual(
          calls[0].options.maxTokens,
          25000,
          'a cap below what the operator allows would starve a thinking model'
        );
      } finally {
        config.responseTokens = responseTokensBefore;
      }
    });

    await test('The vocabulary request streams so the gateway sees a live connection', async () => {
      useFake({ tags: [{ id: 1, name: 'Stromrechnung' }] });
      const { calls } = useProvider(() =>
        JSON.stringify({ types: ['Rechnung'], topics: ['Strom'] })
      );
      await service.proposeVocabulary({}, { onProgress: () => {} });
      assert.strictEqual(
        typeof calls[0].options.onProgress,
        'function',
        'the request asks for a stream when the job can take progress'
      );
    });

    await test('Vocabulary chunks run in lanes', async () => {
      const tags = [];
      for (let id = 1; id <= 150; id += 1)
        tags.push({ id, name: `Name ${id}` });
      useFake({ tags });
      config.duplicatesAiSweepNames = 50;
      config.duplicatesAiConcurrency = 3;
      let inFlight = 0;
      let peak = 0;
      const { calls } = useProvider(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
        return JSON.stringify({ types: ['Rechnung'], topics: ['Strom'] });
      });
      try {
        const value = await service.proposeVocabulary(
          {},
          { onProgress: () => {} }
        );
        assert.strictEqual(calls.length, 3, 'three chunks of fifty names');
        assert.ok(
          peak >= 2,
          `at most ${peak} request(s) were in flight at once`
        );
        assert.strictEqual(value.requests, 3);
        assert.deepStrictEqual(value.types, ['Rechnung']);
      } finally {
        config.duplicatesAiConcurrency = 1;
        config.duplicatesAiSweepNames = 300;
      }
    });

    await test('Order chunks run in lanes', async () => {
      // Each tag carries a document; a tag without one is a delete by rule
      // and never reaches the model.
      const tags = [];
      const documents = [];
      for (let id = 1; id <= 6; id += 1) {
        tags.push({ id, name: `Unknown ${id}` });
        documents.push({ id: 100 + id, tags: [id], document_type: null });
      }
      useFake({ tags, documents });
      await useVocabulary(['Rechnung'], ['Strom']);
      config.simplifyTagsPerRequest = 2;
      config.duplicatesAiConcurrency = 3;
      let inFlight = 0;
      let peak = 0;
      const { calls } = useProvider(async (prompt) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
        return JSON.stringify(
          idsInPrompt(prompt).map((id) => ({
            id,
            action: 'keep',
            type: null,
            topics: [],
            mergeInto: null,
            confidence: 'low',
            reason: 'a plain subject',
          }))
        );
      });
      try {
        const value = await service.proposeOrder(
          { vocabulary: 'keep' },
          { onProgress: () => {} }
        );
        assert.strictEqual(calls.length, 3, 'three chunks of two tags');
        assert.ok(
          peak >= 2,
          `at most ${peak} request(s) were in flight at once`
        );
        assert.strictEqual(value.byModel, 6);
      } finally {
        config.duplicatesAiConcurrency = 1;
        config.simplifyTagsPerRequest = 50;
      }
    });

    await test('A stop keeps the proposals that were made and stores them', async () => {
      const tags = [];
      for (let id = 1; id <= 6; id += 1) {
        tags.push({ id, name: `Unknown ${id}` });
      }
      useFake({ tags });
      await useVocabulary(['Rechnung'], ['Strom']);
      config.simplifyTagsPerRequest = 2;
      const control = { stopped: false, stopReason: () => control.stopped };
      useProvider((prompt) => {
        const answer = JSON.stringify(
          idsInPrompt(prompt).map((id) => ({
            id,
            type: 'Rechnung',
            topics: [],
            confidence: 'low',
            reason: 'an invoice',
          }))
        );
        control.stopped = true;
        return answer;
      });

      const { value } = await withLog(() => service.proposeSplits({}, control));
      assert.strictEqual(value.requests, 1, 'the stop ends the run');
      assert.strictEqual(value.stopped, true);
      const rows = await service.listProposals();
      assert.strictEqual(rows.length, 2, 'what was made is stored');
    });

    await test('Without a provider the rule proposals are all there is', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Stromrechnung' },
          { id: 2, name: 'Nachbarschaft' },
        ],
      });
      await useVocabulary(['Rechnung'], ['Strom']);
      useNoProvider();

      const { value, lines } = await withLog(() => service.proposeSplits());
      assert.strictEqual(value.requests, 0, 'nothing was asked');
      assert.strictEqual(value.usedModel, false);
      assert.strictEqual(value.byModel, 0);
      assert.strictEqual(value.byRule, 1);
      assert.ok(
        simplifyLines(lines).some((line) =>
          /no AI provider is configured/.test(line)
        ),
        `the result has to say so:\n${simplifyLines(lines).join('\n')}`
      );
    });

    /* --- What a split would cost ---------------------------------------- */

    await test('proposalImpact counts the documents that would keep their type', async () => {
      splitArchive();
      await useProposal({});

      const impact = await service.proposalImpact(55);
      assert.deepStrictEqual(impact, {
        tagId: 55,
        tagName: 'Stromrechnung',
        documents: 3,
        withType: 1,
        withDifferentType: 1,
        typeId: 7,
        typeSet: 2,
        typeKept: 1,
      });
      await useProposal({ overwriteType: true });
      const overwritten = await service.proposalImpact(55);
      assert.strictEqual(overwritten.typeSet, 3, 'overwrite sets every type');
      assert.strictEqual(overwritten.typeKept, 0, 'and keeps none');
      const stored = await documentModel.getTagSplitProposal(55);
      assert.strictEqual(
        stored.documentsWithType,
        1,
        'the conflict count is on the row after a reload'
      );
      await expectRefusal(
        () => service.proposalImpact(999),
        404,
        'a tag without a proposal'
      );
    });

    /* --- Applying a split ------------------------------------------------ */

    await test('A split gives the documents their tags and type and deletes the tag', async () => {
      const fake = splitArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useProposal({});
      await documentModel.addToHistory(100, [55], 'A document', 'Someone');

      const { value, lines } = await withLog(() =>
        service.applySplits({ tagIds: [55], performedBy: 'tester' })
      );

      assert.strictEqual(value.failed.length, 0, JSON.stringify(value.failed));
      const [applied] = value.applied;
      assert.strictEqual(applied.tagName, 'Stromrechnung');
      assert.strictEqual(applied.documentsUpdated, 3);
      assert.strictEqual(applied.typeSet, 2, 'two documents had no type');
      assert.strictEqual(applied.typeKept, 1, 'the third keeps its own');

      const strom = [...fake.state.tags.values()].find(
        (tag) => tag.name === 'Strom'
      );
      assert.ok(strom, 'the topic tag was created');
      assert.strictEqual(fake.tag(55), undefined, 'the compound is gone');
      assert.deepStrictEqual(fake.document(100).tags, [strom.id]);
      assert.strictEqual(fake.document(100).document_type, 7);
      assert.strictEqual(fake.document(101).document_type, 7);
      assert.strictEqual(
        fake.document(102).document_type,
        3,
        'a document with another type keeps it'
      );

      const entry = await documentModel.getEntityMergeById(applied.logId);
      assert.strictEqual(entry.action, 'split');
      assert.strictEqual(entry.kind, 'tags');
      assert.strictEqual(entry.targetId, 0);
      assert.strictEqual(entry.targetName, 'Rechnung + Strom');
      assert.strictEqual(entry.status, 'done');
      assert.strictEqual(entry.performedBy, 'tester');
      assert.strictEqual(entry.sources[0].id, 55);
      assert.strictEqual(entry.sources[0].deleted, true);
      assert.strictEqual(entry.sources[0].snapshot.name, 'Stromrechnung');
      assert.deepStrictEqual(entry.sources[0].documentIds, [100, 101, 102]);
      assert.deepStrictEqual(entry.details.typeName, 'Rechnung');
      assert.deepStrictEqual(entry.details.typeId, 7);
      assert.deepStrictEqual(entry.details.topicTagIds, [strom.id]);
      assert.deepStrictEqual(entry.details.createdTypeId, null);
      assert.deepStrictEqual(entry.details.createdTagIds, [strom.id]);
      assert.deepStrictEqual(entry.details.documents, [
        {
          id: 100,
          addedTagIds: [strom.id],
          previousTypeId: null,
          typeSet: true,
        },
        {
          id: 101,
          addedTagIds: [strom.id],
          previousTypeId: null,
          typeSet: true,
        },
        { id: 102, addedTagIds: [strom.id], previousTypeId: 3, typeSet: false },
      ]);

      const stored = await documentModel.getTagSplitProposal(55);
      assert.strictEqual(stored.status, 'applied');
      const history = await documentModel.getHistoryByDocumentId(100);
      assert.deepStrictEqual(
        JSON.parse(history.tags),
        [strom.id],
        'the local rows point at a tag that exists'
      );
      assert.ok(
        simplifyLines(lines).some(
          (line) =>
            line ===
            '[SIMPLIFY] split tag 55 "Stromrechnung": 3 document(s) → type "Rechnung" ' +
              '(2 set, 1 kept), tags Strom; tag deleted.'
        ),
        `no split line:\n${simplifyLines(lines).join('\n')}`
      );
    });

    await test('overwriteType sets the type on every document of the tag', async () => {
      const fake = splitArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useProposal({ overwriteType: true });

      const { value } = await withLog(() =>
        service.applySplits({ tagIds: [55] })
      );
      assert.strictEqual(value.applied[0].typeSet, 3);
      assert.strictEqual(value.applied[0].typeKept, 0);
      assert.strictEqual(fake.document(102).document_type, 7);
      const entry = await documentModel.getEntityMergeById(
        value.applied[0].logId
      );
      assert.strictEqual(
        entry.details.documents[2].previousTypeId,
        3,
        'what it had is written down before it is overwritten'
      );
    });

    await test('A created document type and a created tag are recorded for the undo', async () => {
      const fake = useFake({
        tags: [{ id: 55, name: 'Kfz-Steuerbescheid' }],
        documents: [{ id: 100, tags: [55], document_type: null }],
      });
      await useVocabulary(['Bescheid'], ['Steuer']);
      await documentModel.replaceTagSplitProposals([
        {
          tagId: 55,
          tagName: 'Kfz-Steuerbescheid',
          documentCount: 1,
          typeName: 'Bescheid',
          topicNames: ['Steuer'],
          source: 'rule',
          confidence: 'low',
          reason:
            'the type Bescheid and Steuer; "Kfz" is not in the vocabulary',
          status: 'open',
        },
      ]);

      const { value } = await withLog(() =>
        service.applySplits({ tagIds: [55] })
      );
      const entry = await documentModel.getEntityMergeById(
        value.applied[0].logId
      );
      const createdType = [...fake.state.document_types.values()][0];
      const createdTag = [...fake.state.tags.values()].find(
        (tag) => tag.name === 'Steuer'
      );
      assert.strictEqual(entry.details.createdTypeId, createdType.id);
      assert.deepStrictEqual(entry.details.createdTagIds, [createdTag.id]);

      const vocabulary = await service.getVocabulary();
      assert.strictEqual(
        vocabulary.types[0].paperlessId,
        createdType.id,
        'the vocabulary remembers the object it made'
      );
      assert.strictEqual(vocabulary.topics[0].paperlessId, createdTag.id);
    });

    await test('A split refuses what it must not take apart', async () => {
      const fake = splitArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await documentModel.replaceTagSplitProposals([
        {
          tagId: 60,
          tagName: 'Inbox',
          typeName: 'Rechnung',
          topicNames: ['Strom'],
          status: 'open',
        },
        { tagId: 55, tagName: 'Stromrechnung', topicNames: [], status: 'open' },
        { tagId: 900, tagName: 'Gone', typeName: 'Rechnung', status: 'open' },
      ]);

      const { value } = await withLog(() =>
        service.applySplits({ tagIds: [60, 55, 900, 901] })
      );
      assert.strictEqual(value.applied.length, 0);
      assert.deepStrictEqual(
        value.failed.map((entry) => entry.error),
        [
          'It is an inbox tag',
          'The proposal names neither a document type nor a topic tag',
          'It does not exist in Paperless-ngx any more',
          'There is no proposal for tag 901',
        ]
      );
      assert.ok(fake.tag(55), 'nothing was deleted');
      await expectRefusal(
        () => service.applySplits({ tagIds: [] }),
        400,
        'an empty request'
      );
      await expectRefusal(
        () => service.applySplits({ tagIds: [0] }),
        400,
        'an id that is not one'
      );
    });

    await test('A proposal cannot be applied twice', async () => {
      splitArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useProposal({});
      await withLog(() => service.applySplits({ tagIds: [55] }));
      const { value } = await withLog(() =>
        service.applySplits({ tagIds: [55] })
      );
      assert.strictEqual(value.applied.length, 0);
      assert.strictEqual(
        value.failed[0].error,
        'This proposal was already applied'
      );
    });

    await test('A tag that still carries documents afterwards is not deleted', async () => {
      const fake = useFake({
        tags: [{ id: 55, name: 'Stromrechnung' }],
        documents: [
          { id: 100, tags: [55], document_type: null },
          { id: 101, tags: [55], document_type: null },
        ],
        bulkEditIgnores: [101],
      });
      await useVocabulary(['Rechnung'], ['Strom']);
      await useProposal({});

      const { value, lines } = await withLog(() =>
        service.applySplits({ tagIds: [55] })
      );
      const [applied] = value.applied;
      assert.strictEqual(applied.status, 'partial');
      assert.ok(fake.tag(55), 'the tag is still there');
      const entry = await documentModel.getEntityMergeById(applied.logId);
      assert.strictEqual(entry.status, 'partial');
      assert.strictEqual(entry.sources[0].deleted, false);
      assert.match(entry.sources[0].error, /still carry this tag/);
      assert.ok(
        simplifyLines(lines).some((line) => /tag kept\.$/.test(line)),
        `the log says what happened:\n${simplifyLines(lines).join('\n')}`
      );
    });

    await test('A split drops the cached scans', async () => {
      const fake = splitArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useProposal({});
      const before = await duplicateMergeService.scan({ kind: 'tags' });
      assert.ok(before.groups.length >= 0);
      const readsBefore = fake.calls.length;
      await duplicateMergeService.scan({ kind: 'tags' });
      assert.strictEqual(
        fake.calls.length,
        readsBefore,
        'the second scan is the cached one'
      );

      await withLog(() => service.applySplits({ tagIds: [55] }));
      const readsAfterApply = fake.calls.length;
      await duplicateMergeService.scan({ kind: 'tags' });
      assert.ok(
        fake.calls.length > readsAfterApply,
        'the scan after a split reads the archive again'
      );
    });

    /* --- Undoing a split -------------------------------------------------- */

    await test('An undo puts the tag, the documents and the types back', async () => {
      const fake = splitArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useProposal({ overwriteType: true });
      await documentModel.addToHistory(100, [55], 'A document', 'Someone');
      const { value } = await withLog(() =>
        service.applySplits({ tagIds: [55] })
      );
      const logId = value.applied[0].logId;
      const strom = [...fake.state.tags.values()].find(
        (tag) => tag.name === 'Strom'
      );

      const entry = await documentModel.getEntityMergeById(logId);
      // The type existed before the split (createdTypeId is null): the undo
      // must not try to delete a document type, least of all number 0.
      const liveService = require('../services/paperlessService');
      const originalDelete = liveService.deleteDocumentType;
      const deletedTypes = [];
      liveService.deleteDocumentType = async (id) => {
        deletedTypes.push(id);
        return originalDelete.call(liveService, id);
      };
      let undone;
      let lines;
      try {
        ({ value: undone, lines } = await withLog(() =>
          service.undoSplit(entry, { performedBy: 'tester' })
        ));
      } finally {
        liveService.deleteDocumentType = originalDelete;
      }
      assert.deepStrictEqual(
        deletedTypes,
        [],
        'no document type is deleted when the split created none'
      );

      assert.strictEqual(undone.status, 'undone');
      assert.strictEqual(undone.performedBy, 'tester');
      const restoredId = undone.sources[0].restoredId;
      assert.ok(Number.isInteger(restoredId));
      assert.notStrictEqual(restoredId, 55, 'a re-created tag has a new id');
      assert.strictEqual(undone.sources[0].documentsRestored, 3);
      assert.strictEqual(fake.tag(restoredId).name, 'Stromrechnung');
      for (const id of [100, 101, 102]) {
        assert.deepStrictEqual(
          fake.document(id).tags,
          [restoredId],
          `document ${id} carries the compound again and not the topic`
        );
      }
      assert.strictEqual(fake.document(100).document_type, null);
      assert.strictEqual(fake.document(102).document_type, 3, 'as it was');
      assert.strictEqual(
        fake.tag(strom.id),
        undefined,
        'the tag the split created is gone again'
      );
      assert.ok(fake.documentType(7), 'a type it did not create stays');

      const after = await documentModel.getEntityMergeById(logId);
      assert.strictEqual(after.status, 'undone');
      assert.ok(after.undoneAt, 'the row is stamped');
      const proposal = await documentModel.getTagSplitProposal(55);
      assert.strictEqual(proposal.status, 'open', 'the proposal is open again');
      const history = await documentModel.getHistoryByDocumentId(100);
      assert.deepStrictEqual(JSON.parse(history.tags), [restoredId]);
      assert.ok(
        simplifyLines(lines).some((line) =>
          /^\[SIMPLIFY\] undid the split of "Stromrechnung": tag re-created as \d+, 3 document\(s\) re-tagged, 3 type\(s\) restored/.test(
            line
          )
        ),
        `no undo line:\n${simplifyLines(lines).join('\n')}`
      );
    });

    await test('An object the split created is kept when something uses it', async () => {
      const fake = splitArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useProposal({});
      const { value } = await withLog(() =>
        service.applySplits({ tagIds: [55] })
      );
      const strom = [...fake.state.tags.values()].find(
        (tag) => tag.name === 'Strom'
      );
      // Someone files another document under the new tag before the undo.
      fake.state.documents.set(500, {
        id: 500,
        title: 'Another document',
        content: '',
        tags: [strom.id],
        correspondent: null,
        document_type: null,
      });

      const entry = await documentModel.getEntityMergeById(
        value.applied[0].logId
      );
      const { lines } = await withLog(() => service.undoSplit(entry));
      assert.ok(fake.tag(strom.id), 'the tag with a document stays');
      assert.ok(
        simplifyLines(lines).some((line) =>
          /carries 1 document\(s\) and was kept/.test(line)
        ),
        `the log says why:\n${simplifyLines(lines).join('\n')}`
      );
    });

    await test('An undo adopts a tag of the same name instead of creating a second', async () => {
      const fake = splitArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useProposal({});
      const { value } = await withLog(() =>
        service.applySplits({ tagIds: [55] })
      );
      const recreated = await paperlessService.createEntity('tags', {
        name: 'Stromrechnung',
      });

      const entry = await documentModel.getEntityMergeById(
        value.applied[0].logId
      );
      const undone = await withLog(() => service.undoSplit(entry));
      assert.strictEqual(undone.value.sources[0].adoptedExisting, true);
      assert.strictEqual(
        undone.value.sources[0].restoredId,
        Number(recreated.id)
      );
      assert.strictEqual(
        fake.tagNames().filter((name) => name === 'Stromrechnung').length,
        1,
        'no second tag of that name'
      );
    });

    await test('A second undo is refused', async () => {
      splitArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useProposal({});
      const { value } = await withLog(() =>
        service.applySplits({ tagIds: [55] })
      );
      const entry = await documentModel.getEntityMergeById(
        value.applied[0].logId
      );
      await withLog(() => service.undoSplit(entry));
      const again = await documentModel.getEntityMergeById(
        value.applied[0].logId
      );
      await expectRefusal(() => service.undoSplit(again), 409, 'a second undo');
      await expectRefusal(
        () => service.undoSplit({ id: 1, action: 'merge' }),
        400,
        'a row that is not a split'
      );
    });

    await test('The merge service hands a split row to this service', async () => {
      const fake = splitArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useProposal({});
      const { value } = await withLog(() =>
        service.applySplits({ tagIds: [55] })
      );

      const undone = await withLog(() =>
        duplicateMergeService.undo(value.applied[0].logId, {
          performedBy: 'api-key',
        })
      );
      assert.strictEqual(undone.value.status, 'undone');
      assert.strictEqual(undone.value.performedBy, 'api-key');
      assert.ok(
        fake.tagNames().includes('Stromrechnung'),
        'the compound is back'
      );
    });
    /* --- The proposed order (round 12) ---------------------------------- */

    /** The archive the order cases start from. */
    function orderArchive() {
      return useFake({
        tags: [
          { id: 20, name: 'Stromrechnung' },
          { id: 21, name: 'rechnungen' },
          { id: 22, name: 'Rechnungen' },
          { id: 23, name: 'todo' },
        ],
        documentTypes: [{ id: 7, name: 'Rechnung' }],
        documents: [
          { id: 200, tags: [20], document_type: null },
          { id: 201, tags: [20], document_type: null },
          { id: 202, tags: [21], document_type: null },
          { id: 203, tags: [23], document_type: null },
          { id: 204, tags: [22], document_type: null },
        ],
      });
    }

    /** The order proposals the apply cases work on, all accepted. */
    async function useOrderProposals(rows) {
      await documentModel.replaceTagSplitProposals(
        rows.map((row) => ({
          documentCount: 1,
          action: 'split',
          mergeInto: null,
          typeName: null,
          topicNames: [],
          source: 'model',
          confidence: 'high',
          reason: 'because',
          documentsWithType: 0,
          overwriteType: false,
          status: 'accepted',
          ...row,
        }))
      );
    }

    /** The provider a run of the order uses: two questions, two answers. */
    function useOrderProvider(order) {
      return useProvider((prompt, options) => {
        if (
          options.systemPrompt.includes('Give every tag exactly one action')
        ) {
          return JSON.stringify(order(idsInPrompt(prompt), prompt));
        }
        return JSON.stringify({ types: ['Rechnung'], topics: ['Strom'] });
      });
    }

    await test('The rule gives every tag one of the four actions', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Stromrechnung' },
          { id: 2, name: 'Handyrechnung' },
          { id: 3, name: 'Strom' },
          { id: 4, name: 'Inbox', is_inbox_tag: true },
          { id: 5, name: 'ai-processed' },
          { id: 6, name: 'do-not-touch' },
          { id: 7, name: 'Leerlauf' },
          { id: 8, name: 'Gesperrt', user_can_change: false },
          { id: 9, name: 'Nachbarschaft' },
        ],
        documents: [
          { id: 100, tags: [1, 3] },
          { id: 101, tags: [1, 2] },
          { id: 102, tags: [4, 5, 6, 8, 9] },
        ],
      });
      await useVocabulary(['Rechnung'], ['Strom', 'Auto']);
      useNoProvider();

      const { value } = await withLog(() => service.proposeOrder());
      assert.strictEqual(value.proposals, 9, 'every tag gets a row');
      const rows = new Map(
        (await service.listProposals()).map((row) => [row.tagName, row])
      );
      const seen = (name) => ({
        action: rows.get(name).action,
        typeName: rows.get(name).typeName,
        topicNames: rows.get(name).topicNames,
        confidence: rows.get(name).confidence,
        reason: rows.get(name).reason,
        source: rows.get(name).source,
      });

      assert.deepStrictEqual(seen('Stromrechnung'), {
        action: 'split',
        typeName: 'Rechnung',
        topicNames: ['Strom'],
        confidence: 'high',
        reason: 'compound of Rechnung and Strom',
        source: 'rule',
      });
      assert.deepStrictEqual(
        [seen('Handyrechnung').action, seen('Handyrechnung').confidence],
        ['split', 'low'],
        'a remainder nobody named is a proposal with a doubt'
      );
      assert.deepStrictEqual(seen('Strom'), {
        action: 'keep',
        typeName: null,
        topicNames: [],
        confidence: 'high',
        reason: 'a topic of the vocabulary',
        source: 'rule',
      });
      assert.strictEqual(seen('Inbox').reason, 'the inbox tag');
      assert.strictEqual(
        seen('ai-processed').reason,
        'the settings refer to this tag'
      );
      assert.strictEqual(
        seen('do-not-touch').reason,
        'the settings refer to this tag'
      );
      assert.strictEqual(
        seen('Gesperrt').reason,
        'the API token may not change it'
      );
      assert.deepStrictEqual(
        [seen('Leerlauf').action, seen('Leerlauf').reason],
        ['delete', 'no documents'],
        'a tag nothing carries is the one proposal that costs nothing'
      );
      assert.deepStrictEqual(
        [seen('Nachbarschaft').action, seen('Nachbarschaft').reason],
        ['keep', 'nothing in the vocabulary accounts for this name'],
        'without a model the rest is left alone rather than dropped'
      );
      assert.strictEqual(
        rows.get('Inbox').action,
        'keep',
        'the inbox tag carries no document here and is still not deleted'
      );
      assert.strictEqual(value.byModel, 0);
      assert.strictEqual(value.byRule, 9);
    });

    await test('A plural or another spelling merges into the tag with more documents', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Nachbarschaft' },
          { id: 2, name: 'Nachbarschaften' },
          { id: 3, name: 'Ärzte' },
          { id: 4, name: 'Aerzte' },
        ],
        documents: [
          { id: 100, tags: [1, 3] },
          { id: 101, tags: [1, 4] },
          { id: 102, tags: [1] },
          { id: 103, tags: [2] },
        ],
      });
      await useVocabulary(['Rechnung'], ['Strom']);
      useNoProvider();

      await withLog(() => service.proposeOrder());
      const rows = new Map(
        (await service.listProposals()).map((row) => [row.tagName, row])
      );
      assert.deepStrictEqual(
        [
          rows.get('Nachbarschaften').action,
          rows.get('Nachbarschaften').mergeInto,
        ],
        ['merge', 'Nachbarschaft'],
        'three documents against one decides which spelling survives'
      );
      assert.match(
        rows.get('Nachbarschaften').reason,
        /another spelling of "Nachbarschaft" \(plural\)/
      );
      assert.strictEqual(
        rows.get('Nachbarschaft').action,
        'keep',
        'the survivor is not merged into anything'
      );
      assert.deepStrictEqual(
        [rows.get('Aerzte').action, rows.get('Aerzte').mergeInto],
        ['merge', 'Ärzte'],
        'one document each: the shorter name wins'
      );
      assert.strictEqual(rows.get('Ärzte').action, 'keep');
    });

    await test('The model settles what the rule could not, with four actions', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Stromrechnung' },
          { id: 2, name: 'Mobilfunkabo' },
          { id: 3, name: 'Krempel' },
          { id: 4, name: 'Nachbarschaft' },
          { id: 5, name: 'Nachbarn' },
        ],
        documents: [
          { id: 100, tags: [1, 2] },
          { id: 101, tags: [3, 4] },
          { id: 102, tags: [5] },
        ],
      });
      await useVocabulary(['Rechnung', 'Vertrag'], ['Strom', 'Telefon']);
      config.simplifyTagsPerRequest = 50;
      const answers = {
        2: {
          action: 'split',
          type: 'Vertrag',
          topics: ['Telefon'],
          confidence: 'high',
          reason: 'a mobile phone contract',
        },
        3: { action: 'delete', confidence: 'high', reason: 'says nothing' },
        4: {
          action: 'keep',
          confidence: 'high',
          reason: 'a subject of its own',
        },
        5: {
          action: 'merge',
          mergeInto: 'Nachbarschaft',
          confidence: 'low',
          reason: 'the same people',
        },
      };
      const { calls } = useProvider((prompt, options) => {
        if (
          options.systemPrompt.includes('Give every tag exactly one action')
        ) {
          return JSON.stringify(
            idsInPrompt(prompt).map((id) => ({ id, ...answers[id] }))
          );
        }
        return JSON.stringify({ types: [], topics: [] });
      });

      const { value } = await withLog(() =>
        service.proposeOrder({ vocabulary: 'keep' })
      );
      assert.strictEqual(calls.length, 1, 'the vocabulary was not asked for');
      assert.deepStrictEqual(
        idsInPrompt(calls[0].prompt).sort(),
        ['2', '3', '4', '5'],
        'the compound the rule settled is not asked about'
      );
      assert.ok(
        calls[0].options.systemPrompt.includes(
          'The topics you may use: Strom, Telefon.'
        ),
        'the vocabulary is in the prompt'
      );
      assert.ok(
        calls[0].options.systemPrompt.includes(
          'Judge by the name, and never guess what is inside a document.'
        ),
        'and the model is told it is looking at names'
      );
      assert.match(
        calls[0].prompt,
        /"name":"Mobilfunkabo","documents":1/,
        'the names of the request carry what they are worth'
      );

      const rows = new Map(
        (await service.listProposals()).map((row) => [row.tagName, row])
      );
      assert.deepStrictEqual(
        [
          rows.get('Mobilfunkabo').action,
          rows.get('Mobilfunkabo').typeName,
          rows.get('Mobilfunkabo').topicNames,
          rows.get('Mobilfunkabo').source,
          rows.get('Mobilfunkabo').reason,
        ],
        ['split', 'Vertrag', ['Telefon'], 'model', 'a mobile phone contract']
      );
      assert.strictEqual(rows.get('Krempel').action, 'delete');
      assert.strictEqual(rows.get('Nachbarschaft').action, 'keep');
      assert.deepStrictEqual(
        [rows.get('Nachbarn').action, rows.get('Nachbarn').mergeInto],
        ['merge', 'Nachbarschaft'],
        'the model may name another tag of the request'
      );
      assert.strictEqual(rows.get('Stromrechnung').source, 'rule');
      assert.strictEqual(value.byRule, 1);
      assert.strictEqual(value.byModel, 4);
    });

    await test('What the model may not say turns into keep, with a note', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Wohnung' },
          { id: 2, name: 'Garage' },
          { id: 3, name: 'Keller' },
          { id: 4, name: 'Dachboden' },
        ],
        documents: [{ id: 100, tags: [1, 2, 3, 4] }],
      });
      await useVocabulary(['Rechnung'], ['Strom']);
      const answers = {
        1: { action: 'split', type: 'Mietvertrag', topics: ['Wohnen'] },
        2: { action: 'merge', mergeInto: 'Autogarage' },
        3: { action: 'archive' },
        4: { action: 'split', topics: [] },
      };
      useOrderProvider((ids) => ids.map((id) => ({ id, ...answers[id] })));

      await withLog(() => service.proposeOrder({ vocabulary: 'keep' }));
      const rows = new Map(
        (await service.listProposals()).map((row) => [row.tagName, row])
      );
      for (const name of ['Wohnung', 'Garage', 'Keller', 'Dachboden']) {
        assert.strictEqual(
          rows.get(name).action,
          'keep',
          `${name} must not reach Paperless-ngx`
        );
      }
      assert.match(
        rows.get('Wohnung').reason,
        /not in the vocabulary: Mietvertrag, Wohnen/
      );
      assert.match(rows.get('Wohnung').reason, /nothing to split it into/);
      assert.strictEqual(rows.get('Wohnung').typeName, null);
      assert.match(
        rows.get('Garage').reason,
        /no other tag is called "Autogarage"/
      );
      assert.strictEqual(rows.get('Garage').mergeInto, null);
      assert.match(rows.get('Keller').reason, /unknown action "archive"/);
      assert.match(rows.get('Dachboden').reason, /nothing to split it into/);
    });

    await test('Without a vocabulary the order cannot keep one', async () => {
      useFake({ tags: [{ id: 1, name: 'Stromrechnung' }] });
      await documentModel.replaceTagVocabulary([]);
      useNoProvider();
      await expectRefusal(
        () => service.proposeOrder({ vocabulary: 'keep' }),
        409,
        'nothing to order the tags by'
      );
      await expectRefusal(
        () => service.proposeOrder(),
        409,
        'and without a provider there is nothing to propose one with'
      );
    });

    await test('The order reports its two phases and says what it decided', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Stromrechnung' },
          { id: 2, name: 'Krempel' },
          { id: 3, name: 'Leerlauf' },
        ],
        documents: [{ id: 100, tags: [1, 2] }],
      });
      await useVocabulary(['Rechnung'], ['Strom']);
      config.duplicatesAiSweepNames = 50;
      config.simplifyVocabularySize = 6;
      useOrderProvider((ids) =>
        ids.map((id) => ({ id, action: 'delete', reason: 'says nothing' }))
      );

      const progress = [];
      const { value, lines } = await withLog(() =>
        service.proposeOrder(
          {},
          { onProgress: (patch) => progress.push(patch) }
        )
      );
      assert.deepStrictEqual(
        {
          proposals: value.proposals,
          byRule: value.byRule,
          byModel: value.byModel,
          requests: value.requests,
          groups: value.groups,
          stopped: value.stopped,
        },
        {
          proposals: 3,
          byRule: 2,
          byModel: 1,
          requests: 2,
          groups: 3,
          stopped: false,
        },
        'one vocabulary request and one order request'
      );
      assert.deepStrictEqual(
        value.vocabulary.types.map((entry) => entry.name),
        ['Rechnung'],
        'the saved vocabulary comes back with the result'
      );
      assert.ok(
        lines.some(
          (line) =>
            line ===
            '[SIMPLIFY] order proposed: 3 tag(s): 1 split, 0 merge, 0 keep, 2 delete; ' +
              '2 by rule, 1 by the model in 2 request(s).'
        ),
        `no order line:\n${simplifyLines(lines).join('\n')}`
      );

      const phases = [...new Set(progress.map((patch) => patch.phase))];
      assert.deepStrictEqual(phases, ['vocabulary', 'ordering']);
      const ordering = progress.filter((patch) => patch.phase === 'ordering');
      assert.strictEqual(ordering[0].pairsTotal, 3, 'tags are the total');
      assert.strictEqual(ordering[0].pairsJudged, 2, 'settled by rule');
      assert.strictEqual(
        ordering[0].requestsPlanned,
        2,
        'the vocabulary request counts towards the same bar'
      );
      assert.strictEqual(
        ordering[ordering.length - 1].pairsJudged,
        3,
        'and every tag is settled at the end'
      );
    });

    await test('The apply works through merges, then splits, then deletes', async () => {
      const fake = orderArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useOrderProposals([
        {
          tagId: 20,
          tagName: 'Stromrechnung',
          documentCount: 2,
          action: 'split',
          typeName: 'Rechnung',
          topicNames: ['Strom'],
        },
        {
          tagId: 21,
          tagName: 'rechnungen',
          action: 'merge',
          mergeInto: 'Rechnungen',
        },
        { tagId: 22, tagName: 'Rechnungen', action: 'keep' },
        { tagId: 23, tagName: 'todo', action: 'delete' },
      ]);

      const { value, lines } = await withLog(() =>
        service.applyAccepted({ performedBy: 'tester' })
      );
      assert.deepStrictEqual(
        value.failed,
        [],
        `nothing may fail: ${JSON.stringify(value.failed)}`
      );
      assert.deepStrictEqual(
        value.applied.map((entry) => [entry.tagName, entry.action]),
        [
          ['Stromrechnung', 'split'],
          ['todo', 'delete'],
        ],
        'a keep is never applied'
      );
      assert.strictEqual(value.merged.length, 1);
      assert.deepStrictEqual(
        {
          tagId: value.merged[0].tagId,
          tagName: value.merged[0].tagName,
          targetId: value.merged[0].targetId,
          targetName: value.merged[0].targetName,
          documentsUpdated: value.merged[0].documentsUpdated,
        },
        {
          tagId: 21,
          tagName: 'rechnungen',
          targetId: 22,
          targetName: 'Rechnungen',
          documentsUpdated: 1,
        }
      );
      assert.strictEqual(value.stopped, false);

      const order = simplifyLines(lines)
        .filter((line) => /merged tag|split tag|deleted tag/.test(line))
        .map((line) => line.split(' ')[1]);
      assert.deepStrictEqual(
        order,
        ['merged', 'split', 'deleted'],
        'a merge first: a tag a split needs must still be there'
      );

      assert.strictEqual(fake.tag(20), undefined, 'the compound is gone');
      assert.strictEqual(fake.tag(21), undefined, 'the other spelling is gone');
      assert.strictEqual(fake.tag(23), undefined, 'the note to self is gone');
      assert.ok(fake.tag(22), 'the survivor of the merge stays');
      assert.deepStrictEqual(
        fake.document(202).tags,
        [22],
        'the merged documents carry the survivor'
      );
      assert.deepStrictEqual(
        fake.document(203).tags,
        [],
        'the deleted tag left its document behind'
      );
      assert.strictEqual(fake.document(200).document_type, 7);
      for (const tagId of [20, 21, 23]) {
        assert.strictEqual(
          (await documentModel.getTagSplitProposal(tagId)).status,
          'applied'
        );
      }
      assert.strictEqual(
        (await documentModel.getTagSplitProposal(22)).status,
        'accepted',
        'a keep stays what it was'
      );
      assert.ok(
        simplifyLines(lines).some((line) =>
          /^\[SIMPLIFY\] order applied: 1 split, 1 merged, 1 deleted, 0 failed, in \d+\.\d+s\.$/.test(
            line
          )
        ),
        `no apply line:\n${simplifyLines(lines).join('\n')}`
      );
    });

    await test('A deleted tag gives its documents back when the delete is undone', async () => {
      const fake = orderArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await documentModel.addToHistory(203, [23], 'A document', 'Someone');
      await useOrderProposals([
        { tagId: 23, tagName: 'todo', action: 'delete' },
      ]);

      const { value } = await withLog(() =>
        service.applyAccepted({ performedBy: 'tester' })
      );
      const logId = value.applied[0].logId;
      const entry = await documentModel.getEntityMergeById(logId);
      assert.strictEqual(entry.action, 'delete');
      assert.strictEqual(entry.targetName, '', 'a delete has no target');
      assert.deepStrictEqual(entry.sources[0].documentIds, [203]);
      assert.deepStrictEqual(
        entry.details.documents.map((document) => document.id),
        [203],
        'the documents are written down before the tag goes'
      );

      const undone = await withLog(() =>
        duplicateMergeService.undo(logId, { performedBy: 'tester' })
      );
      assert.strictEqual(undone.value.status, 'undone');
      const restoredId = undone.value.sources[0].restoredId;
      assert.ok(Number.isInteger(restoredId));
      assert.strictEqual(fake.tag(restoredId).name, 'todo');
      assert.deepStrictEqual(
        fake.document(203).tags,
        [restoredId],
        'the document carries it again'
      );
      assert.strictEqual(undone.value.sources[0].documentsRestored, 1);
      assert.strictEqual(
        (await documentModel.getTagSplitProposal(23)).status,
        'open',
        'and the proposal is a decision again'
      );
      const history = await documentModel.getHistoryByDocumentId(203);
      assert.deepStrictEqual(
        JSON.parse(history.tags),
        [restoredId],
        'the local rows point at the tag that exists'
      );
    });

    await test('A merge of the order goes through the merge service and can be undone', async () => {
      const fake = orderArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useOrderProposals([
        {
          tagId: 21,
          tagName: 'rechnungen',
          action: 'merge',
          mergeInto: 'Rechnungen',
        },
      ]);

      const { value } = await withLog(() => service.applyAccepted({}));
      const logId = value.merged[0].logId;
      const entry = await documentModel.getEntityMergeById(logId);
      assert.strictEqual(
        entry.action,
        'merge',
        'the row the log already knows'
      );
      assert.strictEqual(entry.targetId, 22);
      assert.strictEqual(
        (await documentModel.getTagSplitProposal(21)).status,
        'applied'
      );

      const undone = await withLog(() => duplicateMergeService.undo(logId));
      assert.strictEqual(undone.value.status, 'undone');
      assert.ok(
        fake.tagNames().includes('rechnungen'),
        'the merged tag is back'
      );
      assert.strictEqual(
        (await documentModel.getTagSplitProposal(21)).status,
        'open',
        'an undone merge is a decision again'
      );
    });

    await test('A merge target that is gone is a failure, not a crash', async () => {
      orderArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useOrderProposals([
        {
          tagId: 21,
          tagName: 'rechnungen',
          action: 'merge',
          mergeInto: 'Quittungen',
        },
        {
          tagId: 20,
          tagName: 'Stromrechnung',
          action: 'merge',
          mergeInto: 'Stromrechnung',
        },
      ]);

      const { value } = await withLog(() => service.applyAccepted({}));
      assert.strictEqual(value.merged.length, 0);
      assert.strictEqual(value.failed.length, 2);
      assert.match(
        value.failed.find((entry) => entry.tagId === 21).error,
        /There is no tag called "Quittungen"/
      );
      assert.match(
        value.failed.find((entry) => entry.tagId === 20).error,
        /cannot be merged into itself/
      );
      assert.strictEqual(
        (await documentModel.getTagSplitProposal(21)).status,
        'accepted',
        'what failed stays a decision'
      );
    });

    await test('A stop between two tags leaves the rest accepted', async () => {
      const fake = orderArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useOrderProposals([
        {
          tagId: 20,
          tagName: 'Stromrechnung',
          documentCount: 2,
          action: 'split',
          typeName: 'Rechnung',
          topicNames: ['Strom'],
        },
        { tagId: 23, tagName: 'todo', action: 'delete' },
      ]);

      let stopped = false;
      const control = {
        stopReason: () => (stopped ? 'user' : null),
        onProgress: () => {
          stopped = true;
        },
      };
      const { value } = await withLog(() => service.applyAccepted({}, control));
      assert.strictEqual(value.stopped, true);
      assert.deepStrictEqual(value.applied, []);
      assert.ok(fake.tag(20), 'nothing was written after the stop');
      assert.strictEqual(
        (await documentModel.getTagSplitProposal(20)).status,
        'accepted',
        'the rest waits for the next run'
      );
    });

    await test('An apply with nothing accepted is not an error', async () => {
      orderArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useOrderProposals([
        { tagId: 23, tagName: 'todo', action: 'delete', status: 'open' },
      ]);

      const { value, lines } = await withLog(() => service.applyAccepted({}));
      assert.deepStrictEqual(value, {
        applied: [],
        merged: [],
        failed: [],
        stopped: false,
      });
      assert.ok(
        simplifyLines(lines).some((line) =>
          /^\[SIMPLIFY\] order applied: 0 split, 0 merged, 0 deleted, 0 failed, in \d+\.\d+s\.$/.test(
            line
          )
        ),
        `no apply line:\n${simplifyLines(lines).join('\n')}`
      );
    });

    await test('One group applies without touching what is accepted elsewhere', async () => {
      const fake = orderArchive();
      await useVocabulary(['Rechnung'], ['Strom']);
      await useOrderProposals([
        {
          tagId: 20,
          tagName: 'Stromrechnung',
          documentCount: 2,
          action: 'split',
          typeName: 'Rechnung',
          topicNames: ['Strom'],
        },
        { tagId: 23, tagName: 'todo', action: 'delete' },
      ]);

      const { value } = await withLog(() =>
        service.applyAccepted({ groupKey: 'delete' })
      );
      assert.deepStrictEqual(
        value.applied.map((entry) => entry.tagName),
        ['todo']
      );
      assert.ok(fake.tag(20), 'the split group was not touched');
      assert.strictEqual(
        (await documentModel.getTagSplitProposal(20)).status,
        'accepted'
      );
      await expectRefusal(
        () => service.applyAccepted({ groupKey: 'type:Quittung' }),
        404,
        'a group nobody proposed'
      );
    });
  } finally {
    AIServiceFactory.getService = realGetService;
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
