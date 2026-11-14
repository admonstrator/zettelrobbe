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
 *  6. The proposed order: a cut-off answer is salvaged, thinking seen in one
 *     answer widens the next cap, a stop keeps the proposals that were made
 *  7. applySplits: tags added, type set, tag deleted, log row with details,
 *     local records rewritten, the caches dropped
 *  8. A document with another type keeps it; overwriteType sets it anyway
 *  9. A created type and a created tag are recorded for the undo
 * 10. Refusals: no proposal, an empty proposal, an inbox tag, a gone tag, a
 *     configured tag, one applied twice
 * 11. A tag that still carries documents afterwards is not deleted: partial
 * 12. undoSplit puts the tag, the documents and the types back
 * 13. An object the split created is only deleted when nothing uses it
 * 14. undoSplit adopts a tag of the same name instead of creating a second
 * 15. A second undo is refused
 * 16. duplicateMergeService.undo() hands a split row to undoSplit
 *
 * The proposed order:
 * 17. The rule gives every tag one of the four actions, in its own order
 * 18. A plural or another spelling merges into the tag with more documents
 * 19. The model settles the rest, with all four actions
 * 20. What the model may not say turns into keep, with a note
 * 21. Without a vocabulary there is nothing to keep
 * 22. The two phases, the counts and the log line of a run
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

  /** One open proposal, as proposeOrder would have stored it. */
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

    await test('An empty answer names the reasoning it cost', async () => {
      // The log line of an answer that could not be read says what the model
      // did instead, so an operator can tell a model that thought itself
      // empty from one that sent nothing at all.
      useFake({ tags: [{ id: 1, name: 'Stromrechnung' }] });
      config.simplifyVocabularySize = 6;
      service._observedThinking = 0;
      const provider = {
        client: {},
        lastGenerateTextUsage: null,
        async generateText() {
          provider.lastGenerateTextUsage = {
            totalTokens: 900,
            reasoningTokens: 890,
            answerChars: 0,
            finishReason: 'stop',
          };
          return '';
        },
      };
      AIServiceFactory.getService = () => provider;
      try {
        const { value, lines } = await withLog(() =>
          service.proposeVocabulary()
        );
        assert.strictEqual(value.requests, 1);
        assert.deepStrictEqual(value.types, []);
        const line = simplifyLines(lines).find((entry) =>
          entry.includes('failed:')
        );
        assert.ok(line, `no failure line:\n${simplifyLines(lines).join('\n')}`);
        assert.ok(
          line.endsWith(
            'failed: the model answered nothing (reasoning: 890 token(s), ' +
              'answer: 0 character(s), finish_reason: stop). Raw answer: (none)'
          ),
          line
        );
      } finally {
        service._observedThinking = 0;
      }

      // A provider that reports nothing keeps the line as it was.
      useProvider(() => '');
      const { lines } = await withLog(() => service.proposeVocabulary());
      const line = simplifyLines(lines).find((entry) =>
        entry.includes('failed:')
      );
      assert.ok(
        line.endsWith('failed: the model answered nothing. Raw answer: (none)'),
        line
      );
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

    await test('A cut-off answer keeps the tags the model managed to write', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Nachbarschaft' },
          { id: 2, name: 'Gartenarbeit' },
        ],
        documents: [{ id: 100, tags: [1, 2] }],
      });
      await useVocabulary(['Rechnung'], ['Strom']);
      useProvider(() => {
        const error = new Error('the answer hit the token limit');
        error.code = 'ai_response_truncated';
        error.partialText =
          '[{"id":"1","action":"keep","confidence":"low","reason":"a subject"},{"id":"2","acti';
        return error;
      });

      const { value, lines } = await withLog(() =>
        service.proposeOrder({ vocabulary: 'keep' })
      );
      assert.strictEqual(value.byModel, 1, 'the complete object survives');
      const rows = await service.listProposals();
      const answered = rows.filter((row) => row.source === 'model');
      assert.deepStrictEqual(
        answered.map((row) => row.tagName),
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
          documents: [{ id: 100, tags: [1, 2] }],
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
                action: 'keep',
                confidence: 'high',
                reason: 'a subject',
              }))
            );
          },
        };
        AIServiceFactory.getService = () => provider;
        try {
          await service.proposeOrder({ vocabulary: 'keep' });
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
      const documents = [];
      for (let id = 1; id <= 6; id += 1) {
        tags.push({ id, name: `Unknown ${id}` });
        documents.push({ id: 100 + id, tags: [id], document_type: null });
      }
      useFake({ tags, documents });
      await useVocabulary(['Rechnung'], ['Strom']);
      config.simplifyTagsPerRequest = 2;
      const control = { stopped: false, stopReason: () => control.stopped };
      useProvider((prompt) => {
        const answer = JSON.stringify(
          idsInPrompt(prompt).map((id) => ({
            id,
            action: 'keep',
            confidence: 'low',
            reason: 'a subject',
          }))
        );
        control.stopped = true;
        return answer;
      });

      try {
        const { value } = await withLog(() =>
          service.proposeOrder({ vocabulary: 'keep' }, control)
        );
        assert.strictEqual(value.requests, 1, 'the stop ends the run');
        assert.strictEqual(value.stopped, true);
        const rows = await service.listProposals();
        assert.strictEqual(
          rows.filter((row) => row.source === 'model').length,
          2,
          'what the model answered is stored'
        );
      } finally {
        config.simplifyTagsPerRequest = 50;
      }
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
    /* --- The proposed order ---------------------------------- */

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

    await test('The order asks for short answers and reads one like a full one', async () => {
      // Every answered tag costs output tokens, and the output is where a
      // hosted model spends its time: the prompt asks for the fields that
      // apply and six words of reason, none for a keep, and the parser takes
      // such an answer as it took the full one.
      useFake({
        tags: [
          { id: 1, name: 'Stromrechnung' },
          { id: 2, name: 'Garten' },
          { id: 3, name: 'Gärten' },
          { id: 4, name: 'asdf' },
          { id: 5, name: 'Hobby' },
        ],
        documentTypes: [{ id: 7, name: 'Rechnung' }],
        documents: [
          { id: 100, tags: [1], document_type: null },
          { id: 101, tags: [2], document_type: null },
          { id: 102, tags: [3], document_type: null },
          { id: 103, tags: [4], document_type: null },
          { id: 104, tags: [5], document_type: null },
        ],
      });
      await useVocabulary(['Rechnung'], ['Strom', 'Garten']);
      const { calls } = useOrderProvider(() => [
        {
          id: '1',
          action: 'split',
          type: 'Rechnung',
          topics: ['Strom'],
          confidence: 'high',
          reason: 'invoice for electricity',
        },
        { id: '3', action: 'merge', mergeInto: 'Garten', confidence: 'high' },
        {
          id: '4',
          action: 'delete',
          confidence: 'low',
          reason: 'says nothing',
        },
        { id: '5', action: 'keep', confidence: 'high' },
      ]);

      await withLog(() => service.proposeOrder({ vocabulary: 'keep' }));

      const system = calls[0].options.systemPrompt;
      assert.ok(
        system.includes('"reason" is at most six words; a "keep" needs none.'),
        'the prompt asks for short reasons and none for a keep'
      );
      assert.ok(
        system.includes(
          'leave out every field that does not apply to the action.'
        ),
        'and for the fields that apply, no others'
      );
      assert.ok(
        system.includes('{"id": "14", "action": "keep", "confidence": "high"}'),
        'the example shows a keep without a reason'
      );
      assert.ok(
        !system.includes('"mergeInto": null'),
        'the example carries no null fields'
      );

      const rows = new Map(
        (await service.listProposals()).map((row) => [row.tagName, row])
      );
      assert.deepStrictEqual(
        [
          rows.get('Stromrechnung').action,
          rows.get('Stromrechnung').typeName,
          rows.get('Stromrechnung').topicNames,
          rows.get('Stromrechnung').mergeInto,
        ],
        ['split', 'Rechnung', ['Strom'], null],
        'a split without a mergeInto field is a split'
      );
      assert.deepStrictEqual(
        [
          rows.get('Gärten').action,
          rows.get('Gärten').mergeInto,
          rows.get('Gärten').typeName,
          rows.get('Gärten').reason,
        ],
        ['merge', 'Garten', null, 'proposed by the model'],
        'a merge without type, topics or reason is a merge'
      );
      assert.deepStrictEqual(
        [rows.get('asdf').action, rows.get('asdf').reason],
        ['delete', 'says nothing']
      );
      assert.deepStrictEqual(
        [
          rows.get('Hobby').action,
          rows.get('Hobby').confidence,
          rows.get('Hobby').reason,
          rows.get('Hobby').source,
        ],
        ['keep', 'high', 'proposed by the model', 'model'],
        'a keep of id, action and confidence alone is a keep by the model'
      );
    });

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
