/**
 * Test: services/entityMatchAiService.js
 *
 * The AI review is the one place in the Duplicates feature where an answer
 * comes from outside the house, so the suite is written from the angle of a
 * model that does not do as it is told: it fences its JSON, it talks around
 * it, it invents an id, it makes up a verdict, it forgets a pair, it answers
 * nothing at all, it times out. None of that may cost more than the batch it
 * happened in, and every pair that went in must come back with a verdict.
 *
 * The provider is a stand-in that records every call (no network, no key).
 * Paperless-ngx is the real store from tests/helpers/fake-paperless.js and
 * the local side is the real models/document.js on a throwaway database, so
 * reviewScan runs the same path it runs in production.
 *
 * Covers:
 *  1. The contract: verdicts, group sources, the two entry points
 *  2. The setting and the provider decide whether the review is offered
 *  3. aggregateVerdict: any different wins, all same is same, else unsure
 *  4. The three verdicts are mapped through, reasons are kept
 *  5. Batching: 60 pairs at batch size 25 are three requests, every key once
 *  6. A code fence and prose around the array do not hide the answer
 *  7. An id that was not in the batch is dropped
 *  8. An invalid verdict becomes unsure, a forgotten pair says so
 *  9. An answer that is not JSON fails its batch and is counted
 * 10. A network error fails its batch; the batches after it still run
 * 11. The token limit: a truncated batch is split until it fits, a single
 *     pair that still does not fit is unsure, the complete objects of a
 *     cut-off answer are salvaged and only the rest is re-asked, and a small
 *     TOKEN_LIMIT shrinks the batch before the first request
 * 12. The system prompt carries the JSON contract, the call temperature 0
 *     and a completion cap that grows with the batch
 * 13. An unconfigured provider refuses the whole review
 * 14. A reason is trimmed and cut at 200 characters
 * 15. generateText without options sends what it sent before, in all four
 *     provider services
 * 16. systemPrompt, temperature and maxTokens reach each provider the way its
 *     own API spells them, and the token count is left on the service
 * 17. The fixture really scores where the review needs it to
 * 18. reviewScan end to end: scan groups and the candidate band get their
 *     verdicts, a confirmed candidate becomes an ai-candidate group with the
 *     matcher's reason, a rejected one does not appear, the dismissed pair is
 *     never sent, judged/candidates/requests/tokens add up
 * 19. reviewScan with withTitles: false asks without document titles
 * 20. reviewScan with includeDismissed also judges the dismissed pair
 * 21. The log lines of a review carry its numbers and no document title
 * 22. reviewScan is refused with 409 when the review is switched off
 * 23. Document titles come from Paperless-ngx; an error only means no context
 * 24. groupIds judges the groups it names and nothing else; every other group
 *     still comes back, untouched
 * 25. minConfidence judges only the groups that reach it
 * 26. includeCandidates: false leaves the band out and reads no entity list
 * 27. groupIds and minConfidence both have to hold; unknown ids are ignored,
 *     an empty selection costs no request at all
 * 28. The log names the targeting, in the start line and in the totals
 * 29. Without any of the three options the counters say "not targeted"
 * 30. The system prompt refuses a spelling distance as a reason of its own,
 *     names the pair the user ran into, and offers basis and confidence
 * 31. basis and confidence are parsed; anything else becomes null
 * 32. Excerpts are read for the spelling-only pairs only, once per entity,
 *     and the log names the evidence without ever naming its content
 * 33. withExcerpts: false and DUPLICATES_AI_EXCERPTS read no document
 * 34. An excerpt is cut to the configured length and count
 * 35. "Kontoauszug" / "Kontoumzug": the documents decide, the page is told
 *     why, and a rejected candidate never becomes a group
 * 36. A pair a matcher rule settles costs no request, no read and no token
 * 37. The neighbourhood of an entity is read once and reaches the model
 * 38. An unsure pair without excerpts is asked a second time, with them, and
 *     an escalation that finds no document does not ask again
 * 39. The judge can run on its own model, and the option reaches every
 *     provider the way its API spells it
 * 40. getRecentDocumentExcerptsByEntity and getEntityNeighbourhood: what they
 *     ask Paperless-ngx for, and that they never throw
 * 41. The batch is sized on the prompt the excerpts made
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

/** The ids the user prompt of one request carried, in order. */
function idsInPrompt(prompt) {
  return [...String(prompt).matchAll(/"id":"([^"]+)"/g)].map((hit) => hit[1]);
}

function entity(id, name, documentCount = 0) {
  return {
    id,
    name,
    documentCount,
    matchingAlgorithm: 0,
    match: '',
    isInsensitive: true,
    owner: null,
    userCanChange: true,
  };
}

/**
 * A verdict as the service records it. `basis`, `confidence` and `source` are
 * part of every verdict now; a model that names none of them still produces
 * the other two fields, which is what the page renders.
 */
function verdict(value, reason, extra = {}) {
  return {
    verdict: value,
    reason,
    basis: null,
    confidence: null,
    source: 'model',
    ...extra,
  };
}

/** The verdict a matcher rule gives a pair nobody has to ask about. */
function ruleVerdict(reason, basis) {
  return {
    verdict: 'same',
    reason: `settled by the spelling rule ${reason}`,
    basis,
    confidence: 'high',
    source: 'spelling-rule',
  };
}

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-ai-review-'));
  process.chdir(tempRoot);

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://127.0.0.1:9';
  process.env.PAPERLESS_API_TOKEN = 'test-token';
  process.env.DUPLICATES_AI_REVIEW = 'yes';
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'test';
  process.env.OPENAI_MODEL = 'test-model';

  const config = require('../config/config');
  const documentModel = require('../models/document');
  const paperlessService = require('../services/paperlessService');
  const dashboardStatsService = require('../services/dashboardStatsService');
  const AIServiceFactory = require('../services/aiServiceFactory');
  const matcher = require('../services/entityNameMatcher');
  const service = require('../services/entityMatchAiService');

  // The dashboard rebuild is fired detached after every write; it would talk
  // to the network and outlive the test process.
  dashboardStatsService.refresh = async () => ({});
  paperlessService.getPublicBaseUrl = async () => 'https://paperless.example';

  const realGetService = AIServiceFactory.getService;

  /**
   * Points the factory at a stand-in that answers with whatever `respond`
   * returns (an Error is thrown instead) and records every call.
   */
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

  /** Answers every pair of the batch with one fixed verdict. */
  function answerAll(verdict, reason) {
    return (prompt) =>
      JSON.stringify(
        idsInPrompt(prompt).map((id) => ({ id, verdict, reason }))
      );
  }

  /** Points the service at a fresh Paperless-ngx store and returns it. */
  function useFake(seed) {
    const fake = createFakePaperless(seed);
    paperlessService.client = fake.client;
    return fake;
  }

  /** Two tags, for the pair-level tests. */
  function tagPairs(count) {
    const pairs = [];
    for (let index = 0; index < count; index += 1) {
      const a = entity(index * 2 + 1, `Rechnung ${index}`, 3);
      const b = entity(index * 2 + 2, `Rechnungen ${index}`, 1);
      pairs.push({ key: matcher.pairKey('tags', a.id, b.id), a, b });
    }
    return pairs;
  }

  try {
    await test('The contract exports exist', () => {
      assert.deepStrictEqual(service.AI_VERDICT_LIST, [
        'same',
        'different',
        'unsure',
      ]);
      assert.deepStrictEqual(service.GROUP_SOURCES, {
        SCAN: 'scan',
        AI_CANDIDATE: 'ai-candidate',
      });
      assert.strictEqual(typeof service.reviewPairs, 'function');
      assert.strictEqual(typeof service.reviewScan, 'function');
      assert.strictEqual(typeof service.isEnabled, 'function');
    });

    await test('The setting and the provider decide whether the review is offered', () => {
      assert.strictEqual(service.isEnabled(), true);
      assert.strictEqual(service.batchSize(), 25);
      assert.strictEqual(service.candidateFloor(), 0.6);
    });

    await test('aggregateVerdict: any different wins, all same is same, else unsure', () => {
      const same = verdict('same', 'same company');
      const different = verdict('different', 'other bank');
      const unsure = verdict('unsure', 'not enough context');
      assert.deepStrictEqual(service.aggregateVerdict([same, same]), same);
      assert.deepStrictEqual(
        service.aggregateVerdict([same, different]),
        different
      );
      assert.deepStrictEqual(service.aggregateVerdict([same, unsure]), unsure);
      assert.deepStrictEqual(
        service.aggregateVerdict([]),
        verdict('unsure', '')
      );
      assert.deepStrictEqual(service.aggregateVerdict([null, same]), same);
    });

    await test('aggregateVerdict keeps the deciding basis and the weakest confidence', () => {
      const high = verdict('same', 'two spellings', {
        basis: 'umlaut',
        confidence: 'high',
      });
      const low = verdict('same', 'might be a word', {
        basis: 'typo',
        confidence: 'low',
      });
      assert.deepStrictEqual(
        service.aggregateVerdict([high, low]),
        verdict('same', 'two spellings', {
          basis: 'umlaut',
          confidence: 'low',
        }),
        'the first deciding member gives reason and basis, one low makes it low'
      );
      assert.deepStrictEqual(
        service.aggregateVerdict([high, high]).confidence,
        'high'
      );
      const different = verdict('different', 'two accounts', {
        basis: 'different-thing',
        confidence: 'high',
      });
      assert.deepStrictEqual(
        service.aggregateVerdict([low, different]),
        different,
        'a different wins and brings its own basis and confidence'
      );
      const rule = ruleVerdict('exact-normalized', 'case-or-spacing');
      assert.deepStrictEqual(
        service.aggregateVerdict([rule]),
        rule,
        'a verdict a rule settled aggregates like any other'
      );
      assert.strictEqual(
        service.aggregateVerdict([verdict('same', 'no fields')]).confidence,
        null,
        'a model that names no confidence does not invent one'
      );
    });

    await test('Every verdict the model gives is mapped, with its reason', async () => {
      const pairs = tagPairs(3);
      const verdicts = ['same', 'different', 'unsure'];
      const { calls } = useProvider((prompt) =>
        JSON.stringify(
          idsInPrompt(prompt).map((id, index) => ({
            id,
            verdict: verdicts[index],
            reason: `reason ${index}`,
          }))
        )
      );

      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.strictEqual(calls.length, 1, 'three pairs are one request');
      assert.strictEqual(result.model, 'test-model');
      assert.deepStrictEqual(result.usage, {
        requests: 1,
        tokens: 100,
        failedRequests: 0,
        retries: 0,
        batchSize: 3,
      });
      pairs.forEach((pair, index) => {
        assert.deepStrictEqual(
          result.verdicts.get(pair.key),
          verdict(verdicts[index], `reason ${index}`)
        );
      });
    });

    await test('Sixty pairs at batch size twenty-five are three requests, every key once', async () => {
      const pairs = tagPairs(60);
      const { calls } = useProvider(answerAll('same', 'same word'));

      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.strictEqual(calls.length, 3, '25 + 25 + 10');
      assert.deepStrictEqual(
        calls.map((call) => idsInPrompt(call.prompt).length),
        [25, 25, 10]
      );
      const asked = calls.flatMap((call) => idsInPrompt(call.prompt));
      assert.strictEqual(asked.length, 60);
      assert.strictEqual(new Set(asked).size, 60, 'no key was asked twice');
      assert.strictEqual(result.verdicts.size, 60);
      assert.strictEqual(result.usage.requests, 3);
      assert.strictEqual(result.usage.tokens, 300, 'usage is summed up');
      assert.ok(
        [...result.verdicts.values()].every((v) => v.verdict === 'same')
      );
    });

    await test('A code fence and prose around the array do not hide the answer', async () => {
      const pairs = tagPairs(1);
      useProvider(
        (prompt) =>
          '```json\nHere is my answer:\n' +
          JSON.stringify(
            idsInPrompt(prompt).map((id) => ({
              id,
              verdict: 'SAME',
              reason: 'plural of the same word',
            }))
          ) +
          '\nI hope this helps.\n```'
      );

      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.deepStrictEqual(
        result.verdicts.get(pairs[0].key),
        verdict('same', 'plural of the same word')
      );
      assert.strictEqual(result.usage.failedRequests, 0);
    });

    await test('An id the batch never carried is dropped', async () => {
      const pairs = tagPairs(2);
      useProvider((prompt) =>
        JSON.stringify([
          { id: 'tags:9998-9999', verdict: 'same', reason: 'invented' },
          ...idsInPrompt(prompt).map((id) => ({
            id,
            verdict: 'same',
            reason: 'real',
          })),
        ])
      );

      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.strictEqual(result.verdicts.size, 2, 'only the pairs asked about');
      assert.strictEqual(result.verdicts.has('tags:9998-9999'), false);
      assert.ok(
        [...result.verdicts.values()].every((v) => v.reason === 'real')
      );
    });

    await test('An invalid verdict becomes unsure, a forgotten pair says so', async () => {
      const pairs = tagPairs(3);
      useProvider((prompt) => {
        const ids = idsInPrompt(prompt);
        return JSON.stringify([
          { id: ids[0], verdict: 'probably', reason: 'hedging' },
          { id: ids[1], verdict: 'different', reason: 'two topics' },
          // ids[2] is left out entirely.
        ]);
      });

      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.deepStrictEqual(
        result.verdicts.get(pairs[0].key),
        verdict('unsure', 'unrecognised verdict')
      );
      assert.deepStrictEqual(
        result.verdicts.get(pairs[1].key),
        verdict('different', 'two topics')
      );
      assert.deepStrictEqual(
        result.verdicts.get(pairs[2].key),
        verdict('unsure', 'no answer from the model')
      );
      assert.strictEqual(
        result.usage.failedRequests,
        0,
        'a sound answer with gaps is not a failed request'
      );
    });

    await test('An answer that is not JSON fails its batch and is counted', async () => {
      const pairs = tagPairs(2);
      useProvider(() => 'I am afraid I cannot help with that.');

      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.strictEqual(result.usage.failedRequests, 1);
      assert.strictEqual(result.verdicts.size, 2);
      for (const pair of pairs) {
        const verdict = result.verdicts.get(pair.key);
        assert.strictEqual(verdict.verdict, 'unsure');
        assert.match(verdict.reason, /no JSON array/);
      }

      useProvider(() => '');
      const empty = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.strictEqual(empty.usage.failedRequests, 1);
      assert.match(
        empty.verdicts.get(pairs[0].key).reason,
        /answered nothing/,
        'an empty answer is a failed batch too'
      );
    });

    await test('A network error fails its batch; the batches after it still run', async () => {
      const pairs = tagPairs(60);
      const { calls } = useProvider((prompt, options, callNumber) => {
        if (callNumber === 2) {
          return new Error('socket hang up');
        }
        return answerAll('same', 'same word')(prompt);
      });

      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.strictEqual(calls.length, 3, 'the third batch still went out');
      assert.strictEqual(result.usage.requests, 3);
      assert.strictEqual(result.usage.failedRequests, 1);
      assert.strictEqual(result.usage.tokens, 200, 'the failed call cost none');
      assert.strictEqual(result.verdicts.size, 60);
      const failedKeys = idsInPrompt(calls[1].prompt);
      for (const key of failedKeys) {
        assert.deepStrictEqual(
          result.verdicts.get(key),
          verdict('unsure', 'socket hang up')
        );
      }
      const okKeys = idsInPrompt(calls[0].prompt);
      assert.strictEqual(result.verdicts.get(okKeys[0]).verdict, 'same');
    });

    // ------------------------------------------------------- the token limit

    /** The error OpenAI, Azure and the custom provider raise when cut off. */
    function truncationError() {
      const error = new Error(
        'OpenAI stopped generating after 700 tokens because the answer hit a token limit. Raise Response Tokens.'
      );
      error.code = 'ai_response_truncated';
      return error;
    }

    await test('A batch that hits the token limit is split until it fits', async () => {
      const pairs = tagPairs(8);
      const { calls } = useProvider((prompt) => {
        const ids = idsInPrompt(prompt);
        if (ids.length > 2) return truncationError();
        return answerAll('same', 'same word')(prompt);
      });

      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.deepStrictEqual(
        calls.map((call) => idsInPrompt(call.prompt).length),
        [8, 4, 2, 2, 4, 2, 2],
        'eight, then halves, then halves of those'
      );
      assert.strictEqual(result.verdicts.size, 8, 'every pair has a verdict');
      assert.ok(
        [...result.verdicts.values()].every((v) => v.verdict === 'same'),
        'and it is the verdict the model gave, not "unsure"'
      );
      assert.strictEqual(result.usage.requests, 7);
      assert.strictEqual(
        result.usage.retries,
        6,
        'the six re-asks are retries, the first request is not'
      );
      assert.strictEqual(
        result.usage.failedRequests,
        0,
        'a truncation is not a failed request'
      );
    });

    await test('A single pair that still does not fit ends as unsure', async () => {
      const pairs = tagPairs(1);
      useProvider(() => truncationError());

      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.deepStrictEqual(
        result.verdicts.get(pairs[0].key),
        verdict('unsure', service.SINGLE_PAIR_TRUNCATION_REASON)
      );
      assert.strictEqual(result.usage.requests, 1, 'one pair is not split');
      assert.strictEqual(result.usage.retries, 0);
      assert.strictEqual(result.usage.failedRequests, 0);
    });

    await test('The complete objects of a cut-off answer are salvaged', async () => {
      const pairs = tagPairs(6);
      const { calls } = useProvider((prompt, options, callNumber) => {
        const ids = idsInPrompt(prompt);
        if (callNumber > 1) return answerAll('different', 'two topics')(prompt);
        // Ollama does not raise anything; it returns what it managed to write
        // before num_predict ran out — here two objects and half a third.
        return (
          '[' +
          ids
            .slice(0, 2)
            .map((id) =>
              JSON.stringify({ id, verdict: 'same', reason: 'two spellings' })
            )
            .join(',') +
          `,{"id":"${ids[2]}","verd`
        );
      });

      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.deepStrictEqual(
        calls.map((call) => idsInPrompt(call.prompt).length),
        [6, 2, 2],
        'only the four pairs without a verdict are asked again'
      );
      assert.strictEqual(result.usage.requests, 3);
      assert.strictEqual(result.usage.retries, 2);
      assert.strictEqual(
        result.usage.failedRequests,
        0,
        'a salvageable answer is not a failed request'
      );
      assert.deepStrictEqual(
        result.verdicts.get(pairs[0].key),
        verdict('same', 'two spellings')
      );
      assert.deepStrictEqual(
        result.verdicts.get(pairs[1].key),
        verdict('same', 'two spellings')
      );
      for (const pair of pairs.slice(2)) {
        assert.strictEqual(
          result.verdicts.get(pair.key).verdict,
          'different',
          'the rest comes from the second round'
        );
      }
    });

    await test('An answer with nothing in it is still a failed batch', async () => {
      const pairs = tagPairs(4);
      useProvider(() => 'I am afraid I cannot help with that.');
      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.strictEqual(result.usage.failedRequests, 1, 'not a truncation');
      assert.strictEqual(result.usage.requests, 1, 'and nothing is re-asked');
      assert.strictEqual(result.usage.retries, 0);
    });

    await test('A small context window shrinks the batch before the first request', async () => {
      const pairs = tagPairs(30);
      const previousLimit = process.env.TOKEN_LIMIT;
      process.env.TOKEN_LIMIT = '2000';
      try {
        const { calls } = useProvider(answerAll('same', 'same word'));
        const result = await service.reviewPairs(pairs, { kind: 'tags' });

        assert.ok(
          result.usage.batchSize < service.batchSize(),
          `the batch shrank from ${service.batchSize()} to ${result.usage.batchSize}`
        );
        assert.ok(
          calls.every(
            (call) => idsInPrompt(call.prompt).length <= result.usage.batchSize
          ),
          'no request is larger than the size the plan settled on'
        );
        for (const call of calls) {
          // The same estimate the service uses for a non-OpenAI model.
          const estimate = Math.ceil(
            `${call.options.systemPrompt}\n${call.prompt}`.length / 4
          );
          assert.ok(
            estimate + call.options.maxTokens + service.TOKENS_CONTEXT_MARGIN <=
              2000,
            `prompt ${estimate} + cap ${call.options.maxTokens} does not fit into 2000`
          );
        }
        assert.strictEqual(
          result.verdicts.size,
          30,
          'and every pair is still judged'
        );
      } finally {
        if (previousLimit === undefined) delete process.env.TOKEN_LIMIT;
        else process.env.TOKEN_LIMIT = previousLimit;
      }
    });

    await test('The prompts carry the contract, temperature 0 and a growing cap', async () => {
      const pairs = tagPairs(30);
      const { calls } = useProvider(answerAll('unsure', 'no idea'));
      await service.reviewPairs(pairs, { kind: 'tags' });

      const system = calls[0].options.systemPrompt;
      assert.match(system, /JSON array and nothing else/);
      assert.match(system, /"verdict": "same" \| "different" \| "unsure"/);
      assert.match(system, /at most twelve words/);
      assert.match(system, /tags/, 'the kind is named');
      assert.ok(
        !/[äöüß]/i.test(system.replace(/Müller|Mueller/g, '')),
        'the prompt is English apart from the German examples'
      );
      assert.strictEqual(calls[0].options.temperature, 0);
      assert.strictEqual(
        calls[0].options.maxTokens,
        25 * service.TOKENS_PER_PAIR + service.TOKENS_OVERHEAD
      );
      assert.strictEqual(
        calls[1].options.maxTokens,
        5 * service.TOKENS_PER_PAIR + service.TOKENS_OVERHEAD,
        'the last, shorter batch asks for less'
      );

      const user = calls[0].prompt;
      assert.match(user, /^Kind: tags/m);
      assert.match(user, /"name":"Rechnung 0","documents":3/);
      assert.strictEqual(
        user.includes('"titles"'),
        false,
        'no context was handed in, so none is sent'
      );

      const correspondents = await service.reviewPairs(
        [
          {
            key: matcher.pairKey('correspondents', 1, 2),
            a: entity(1, 'Amazon', 4),
            b: entity(2, 'amazon', 1),
          },
        ],
        { kind: 'correspondents' }
      );
      assert.strictEqual(correspondents.verdicts.size, 1);
      assert.match(
        calls[calls.length - 1].options.systemPrompt,
        /correspondents/
      );
    });

    await test('An unconfigured provider refuses the whole review', async () => {
      AIServiceFactory.getService = () => ({
        client: null,
        async generateText() {
          throw new Error('should never be called');
        },
      });
      await assert.rejects(
        () => service.reviewPairs(tagPairs(1), { kind: 'tags' }),
        (error) => {
          assert.strictEqual(error.status, 409);
          assert.match(error.message, /not configured/);
          return true;
        }
      );
    });

    await test('A reason is trimmed and cut at two hundred characters', async () => {
      const pairs = tagPairs(1);
      useProvider((prompt) =>
        JSON.stringify(
          idsInPrompt(prompt).map((id) => ({
            id,
            verdict: 'same',
            reason: `   ${'x'.repeat(400)}   `,
          }))
        )
      );
      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.strictEqual(
        result.verdicts.get(pairs[0].key).reason.length,
        service.REASON_MAX_LENGTH
      );
    });

    // ----------------------------------------------------- provider options

    /**
     * Stubs the four provider services and hands back what each one sent.
     * The OpenAI-compatible three take a chat completion request, Ollama a
     * generate body; both are recorded as `sent`.
     */
    function useProviderStubs() {
      const openaiService = require('../services/openaiService');
      const ollamaService = require('../services/ollamaService');
      const customService = require('../services/customService');
      const azureService = require('../services/azureService');
      const sent = {};
      const chatClient = (name) => ({
        chat: {
          completions: {
            create: async (request) => {
              sent[name] = request;
              return {
                choices: [
                  { message: { content: 'answer' }, finish_reason: 'stop' },
                ],
                usage: {
                  prompt_tokens: 11,
                  completion_tokens: 7,
                  total_tokens: 18,
                },
              };
            },
          },
        },
      });
      openaiService.client = chatClient('openai');
      customService.client = chatClient('custom');
      azureService.client = chatClient('azure');
      ollamaService.client = {
        post: async (url, body) => {
          sent.ollama = body;
          return {
            data: { response: 'answer', prompt_eval_count: 11, eval_count: 7 },
          };
        },
      };
      return {
        sent,
        services: {
          openai: openaiService,
          ollama: ollamaService,
          custom: customService,
          azure: azureService,
        },
        restore() {
          openaiService.client = null;
          customService.client = null;
          azureService.client = null;
        },
      };
    }

    await test('Without options every provider sends what it sent before', async () => {
      const stub = useProviderStubs();
      try {
        for (const provider of Object.values(stub.services)) {
          assert.strictEqual(await provider.generateText('hello'), 'answer');
        }
        assert.deepStrictEqual(stub.sent.openai.messages, [
          { role: 'user', content: 'hello' },
        ]);
        assert.strictEqual(
          'max_tokens' in stub.sent.openai,
          false,
          'OpenAI sent no cap before, and still sends none'
        );
        assert.strictEqual(
          stub.sent.openai.temperature,
          config.aiTemperatureGeneration
        );
        assert.strictEqual(stub.sent.azure.temperature, 0.7);
        assert.strictEqual(
          stub.sent.azure.max_tokens,
          Number(config.responseTokens)
        );
        assert.strictEqual(
          stub.sent.custom.temperature,
          config.aiTemperatureGeneration
        );
        assert.strictEqual(
          stub.sent.custom.max_tokens,
          Number(config.responseTokens),
          'the clamp leaves a short prompt alone'
        );
        assert.strictEqual(
          stub.sent.ollama.options.num_predict,
          Number(config.responseTokens)
        );
        assert.match(stub.sent.ollama.system, /helpful assistant/);
        assert.strictEqual(
          stub.sent.ollama.options.temperature,
          config.aiTemperatureGeneration
        );
      } finally {
        stub.restore();
      }
    });

    await test('The options reach every provider the way its API spells them', async () => {
      const stub = useProviderStubs();
      const options = {
        systemPrompt: 'You judge names.',
        temperature: 0,
        maxTokens: 640,
      };
      try {
        for (const provider of Object.values(stub.services)) {
          assert.strictEqual(
            await provider.generateText('hello', options),
            'answer'
          );
        }
        for (const name of ['openai', 'custom', 'azure']) {
          assert.deepStrictEqual(
            stub.sent[name].messages,
            [
              { role: 'system', content: 'You judge names.' },
              { role: 'user', content: 'hello' },
            ],
            `${name}: the system prompt is a system message`
          );
          assert.strictEqual(stub.sent[name].temperature, 0, name);
          assert.strictEqual(stub.sent[name].max_tokens, 640, name);
        }
        assert.strictEqual(stub.sent.ollama.system, 'You judge names.');
        assert.strictEqual(stub.sent.ollama.options.temperature, 0);
        assert.strictEqual(stub.sent.ollama.options.num_predict, 640);
        assert.strictEqual(
          stub.services.openai.lastGenerateTextUsage.totalTokens,
          18,
          'the token count is left on the service, not in the return value'
        );
        assert.strictEqual(
          stub.services.ollama.lastGenerateTextUsage.totalTokens,
          18
        );
      } finally {
        stub.restore();
      }
    });

    // ---------------------------------------------------------------- scan

    /**
     * Four families of correspondents, deliberately chosen against the real
     * scoring tiers: one pair the scan finds on its own, two the scan only
     * finds below its threshold (the band the model is asked about) and one
     * of those dismissed. The scores are asserted, not assumed.
     */
    function seedArchive() {
      return useFake({
        correspondents: [
          { id: 1, name: 'Amazon' },
          { id: 2, name: 'amazon' },
          { id: 3, name: 'Vodafone Kundenservice' },
          { id: 4, name: 'Kundenservice Vodafone Nord' },
          { id: 5, name: 'Techniker Krankenkasse' },
          { id: 6, name: 'Krankenkasse Techniker Nord' },
          { id: 7, name: 'Stadtwerke Muenchen Energie' },
          { id: 8, name: 'Energie Stadtwerke Muenchen Nord' },
        ],
        documents: [
          { id: 100, title: 'Amazon order 2024-11', correspondent: 1 },
          { id: 101, title: 'amazon refund', correspondent: 2 },
          { id: 102, title: 'Vodafone contract change', correspondent: 3 },
          { id: 103, title: 'Vodafone invoice November', correspondent: 4 },
          { id: 104, title: 'TK contribution statement', correspondent: 5 },
          { id: 105, title: 'TK reimbursement', correspondent: 6 },
          { id: 106, title: 'Electricity bill', correspondent: 7 },
          { id: 107, title: 'Electricity meter reading', correspondent: 8 },
        ],
      });
    }

    const VERDICTS_BY_KEY = {
      'correspondents:1-2': ['same', 'only the case differs'],
      'correspondents:3-4': ['same', 'same Vodafone service desk'],
      'correspondents:5-6': ['different', 'two different offices'],
      'correspondents:7-8': ['same', 'should never be asked'],
    };

    function answerFromTable() {
      return (prompt) =>
        JSON.stringify(
          idsInPrompt(prompt).map((id) => ({
            id,
            verdict: VERDICTS_BY_KEY[id]?.[0] ?? 'unsure',
            reason: VERDICTS_BY_KEY[id]?.[1] ?? 'not in the table',
          }))
        );
    }

    await test('The fixture really scores where the review needs it to', () => {
      const band = (a, b) =>
        matcher.scorePair(a, b, 'correspondents')?.score ?? null;
      assert.strictEqual(band('Amazon', 'amazon'), 1);
      for (const [a, b] of [
        ['Vodafone Kundenservice', 'Kundenservice Vodafone Nord'],
        ['Techniker Krankenkasse', 'Krankenkasse Techniker Nord'],
        ['Stadtwerke Muenchen Energie', 'Energie Stadtwerke Muenchen Nord'],
      ]) {
        const score = band(a, b);
        assert.ok(
          score >= service.candidateFloor() && score < 0.95,
          `${a} / ${b} scores ${score}, which is not inside the candidate band`
        );
      }
    });

    await test('reviewScan judges the groups and the band, and builds candidate groups', async () => {
      seedArchive();
      await documentModel.addEntityMergeDismissals('correspondents', [
        {
          idA: 7,
          idB: 8,
          nameA: 'Stadtwerke Muenchen Energie',
          nameB: 'Energie Stadtwerke Muenchen Nord',
        },
      ]);
      const { calls } = useProvider(answerFromTable());

      const result = await service.reviewScan({
        kind: 'correspondents',
        threshold: 0.95,
      });

      assert.strictEqual(calls.length, 1, 'two pairs are one request');
      const asked = idsInPrompt(calls[0].prompt);
      assert.deepStrictEqual(
        [...asked].sort(),
        ['correspondents:3-4', 'correspondents:5-6'],
        'the two live candidates; the group pair is settled by a rule'
      );
      assert.strictEqual(
        asked.includes('correspondents:1-2'),
        false,
        'an exact-normalized pair is never sent to the model'
      );
      assert.strictEqual(
        asked.includes('correspondents:7-8'),
        false,
        'a dismissed pair is never sent to the model'
      );
      assert.match(
        calls[0].prompt,
        /"titles":\["Vodafone contract change"\]/,
        'document titles reach the model as context'
      );
      assert.match(
        calls[0].prompt,
        /"matched_by":"fuzzy","score":0\.\d+/,
        'and so does how the matcher linked the two names'
      );

      assert.deepStrictEqual(result.aiReview, {
        enabled: true,
        model: 'test-model',
        requests: 1,
        tokens: 100,
        judged: 2,
        candidates: 2,
        failedRequests: 0,
        retries: 0,
        batchSize: 2,
        targeted: false,
        groupsJudged: 1,
        groupsSkipped: 0,
        excerpts: 0,
        spellingRules: 1,
        escalated: 0,
      });
      assert.strictEqual(result.threshold, 0.95, 'the scan result is kept');
      assert.strictEqual(result.paperlessUrl, 'https://paperless.example');

      assert.strictEqual(result.groups.length, 2);
      const [scanGroup, candidateGroup] = result.groups;

      assert.strictEqual(scanGroup.source, 'scan');
      assert.deepStrictEqual(
        scanGroup.aiVerdict,
        ruleVerdict('exact-normalized', 'case-or-spacing'),
        'the rule settled the group, and says so'
      );
      const target = scanGroup.members.find(
        (member) => member.id === scanGroup.suggestedTargetId
      );
      assert.strictEqual(target.aiVerdict, null, 'the target judges nothing');
      const judgedMember = scanGroup.members.find(
        (member) => member.id !== scanGroup.suggestedTargetId
      );
      assert.deepStrictEqual(
        judgedMember.aiVerdict,
        ruleVerdict('exact-normalized', 'case-or-spacing')
      );

      assert.strictEqual(candidateGroup.source, 'ai-candidate');
      assert.deepStrictEqual(
        candidateGroup.members.map((member) => member.id).sort(),
        [3, 4]
      );
      assert.deepStrictEqual(candidateGroup.reasons, ['fuzzy']);
      assert.ok(
        candidateGroup.confidence < 0.95 &&
          candidateGroup.confidence >= service.candidateFloor(),
        'the matcher score survives into the group'
      );
      assert.deepStrictEqual(
        candidateGroup.aiVerdict,
        verdict('same', 'same Vodafone service desk')
      );
      assert.strictEqual(
        result.groups.some((group) =>
          group.members.some((member) => member.id === 5 || member.id === 6)
        ),
        false,
        'a candidate the model called different is not offered'
      );
    });

    await test('withTitles: false asks the model without document titles', async () => {
      seedArchive();
      const { calls } = useProvider(answerFromTable());
      await service.reviewScan({
        kind: 'correspondents',
        threshold: 0.95,
        includeDismissed: true,
        withTitles: false,
      });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(
        calls[0].prompt.includes('"titles"'),
        false,
        'no titles were asked for, so none were fetched'
      );
      assert.strictEqual(
        calls[0].prompt.includes('"filed_with"'),
        false,
        'and the neighbourhood is off with them'
      );
      assert.match(
        calls[0].prompt,
        /"name":"Vodafone Kundenservice","documents":1/
      );
    });

    await test('includeDismissed also hands the dismissed pair to the model', async () => {
      seedArchive();
      const { calls } = useProvider(answerFromTable());
      const result = await service.reviewScan({
        kind: 'correspondents',
        threshold: 0.95,
        includeDismissed: true,
      });
      const asked = idsInPrompt(calls[0].prompt);
      assert.strictEqual(asked.includes('correspondents:7-8'), true);
      assert.strictEqual(result.aiReview.judged, 3, 'three band pairs');
      assert.strictEqual(result.aiReview.spellingRules, 1, 'and one rule');
      assert.strictEqual(result.aiReview.candidates, 3);
      assert.strictEqual(
        result.groups.filter((group) => group.source === 'ai-candidate').length,
        2,
        'Vodafone and Stadtwerke were both confirmed'
      );

      const rows =
        await documentModel.listEntityMergeDismissals('correspondents');
      for (const row of rows) {
        await documentModel.removeEntityMergeDismissal(row.id);
      }
    });

    await test('The log says what the review did, and never a document title', async () => {
      seedArchive();
      useProvider(answerFromTable());
      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      try {
        await service.reviewScan({
          kind: 'correspondents',
          threshold: 0.95,
          includeDismissed: true,
        });
      } finally {
        console.log = realLog;
      }

      const review = lines.filter((line) => line.startsWith('[AI-REVIEW]'));
      const has = (pattern) =>
        assert.ok(
          review.some((line) => pattern.test(line)),
          `no [AI-REVIEW] line matches ${pattern}\n${review.join('\n')}`
        );
      has(
        /correspondents: threshold 0\.95, 1 scan group\(s\), 3 candidate\(s\) in the band, 1 pair\(s\) settled by a spelling rule, 3 pair\(s\) to judge, titles on, excerpts on for 3 spelling-only pair\(s\), 0 entity\/entities fetched, model test-model\./
      );
      has(
        /correspondents: batch size 3 of at most 25 \(context limit \d+ tokens\)/
      );
      has(/first batch ~\d+ prompt tokens, completion cap 560\./);
      has(
        /correspondents: request 1, 3 pair\(s\), ~\d+ prompt tokens, cap 560, \d+ms, 2 same \/ 1 different \/ 0 unsure\./
      );
      has(
        /review finished: 1 request\(s\) \(0 retry\/retries, 0 failed\), 100 token\(s\), 3 pair\(s\) judged, 3 candidate\(s\), 3 group\(s\) confirmed, in \d+ms\./
      );
      assert.ok(
        !lines.some((line) => /Amazon order|refund|contract change/.test(line)),
        'document titles are content and stay out of the log'
      );
    });

    await test('A switched-off review is refused with 409', async () => {
      const previous = config.duplicatesAiReview;
      config.duplicatesAiReview = false;
      try {
        await assert.rejects(
          () => service.reviewScan({ kind: 'tags' }),
          (error) => {
            assert.strictEqual(error.status, 409);
            assert.match(error.message, /switched off/);
            return true;
          }
        );
        assert.strictEqual(service.isEnabled(), false);
      } finally {
        config.duplicatesAiReview = previous;
      }
    });

    await test('Titles come from Paperless-ngx, and an error only means no context', async () => {
      const fake = seedArchive();
      const titles = await paperlessService.getRecentDocumentTitlesByEntity(
        'correspondents',
        1,
        3
      );
      assert.deepStrictEqual(titles, ['Amazon order 2024-11']);
      const call = fake.calls[fake.calls.length - 1];
      assert.strictEqual(call.path, '/documents/');
      assert.deepStrictEqual(call.params, {
        correspondent__id: 1,
        fields: 'id,title',
        ordering: '-created',
        page: 1,
        page_size: 3,
      });

      const tagTitles = await paperlessService.getRecentDocumentTitlesByEntity(
        'tags',
        1,
        3
      );
      assert.deepStrictEqual(tagTitles, [], 'no documents, no titles');

      paperlessService.client = {
        async get() {
          throw new Error('socket hang up');
        },
      };
      assert.deepStrictEqual(
        await paperlessService.getRecentDocumentTitlesByEntity(
          'correspondents',
          1
        ),
        [],
        'a failed read never throws'
      );
      assert.deepStrictEqual(
        await paperlessService.getRecentDocumentTitlesByEntity('nonsense', 1),
        [],
        'an unknown kind is refused quietly'
      );
    });

    // ------------------------------------------------------- the targeting

    /**
     * A ladder of four groups at 1, 0.98, 0.95 and 0.9 — the tiers of the
     * matcher, so the confidences are exact rather than approximately right —
     * plus one pair that only reaches the candidate band. This is the archive
     * the user is talking about: everything sits between 0.9 and 1, and they
     * want to ask about the top of it.
     */
    function seedLadder() {
      const names = [
        'Amazon',
        'amazon',
        'Mueller GmbH',
        'Müller GmbH',
        'Telekom',
        'Telekom GmbH',
        'Stadtwerke Muenchen',
        'Muenchen Stadtwerke',
        'Vodafone Kundenservice',
        'Kundenservice Vodafone Nord',
      ];
      return useFake({
        correspondents: names.map((name, index) => ({
          id: index + 1,
          name,
        })),
        documents: names.map((name, index) => ({
          id: 200 + index,
          title: `Letter ${index}`,
          correspondent: index + 1,
        })),
      });
    }

    /** The four group ids of the ladder, strongest first. */
    const LADDER = {
      exact: 'correspondents:1-2',
      umlaut: 'correspondents:3-4',
      legalForm: 'correspondents:5-6',
      tokenOrder: 'correspondents:7-8',
      band: 'correspondents:9-10',
    };

    /** Says "same" to every group pair and "different" to the band pair. */
    function answerLadder() {
      return (prompt) =>
        JSON.stringify(
          idsInPrompt(prompt).map((id) => ({
            id,
            verdict: id === LADDER.band ? 'different' : 'same',
            reason: 'from the fixture',
          }))
        );
    }

    /** Every id the model was shown, over all requests, sorted. */
    const askedIn = (calls) =>
      calls.flatMap((call) => idsInPrompt(call.prompt)).sort();

    /** The group of `id` in a review result. */
    const groupOf = (result, id) =>
      result.groups.find((group) => group.id === id);

    /** Asserts a group came back the way a scan produced it. */
    function assertUntouched(result, id) {
      const group = groupOf(result, id);
      assert.ok(group, `${id} is still in the result`);
      assert.strictEqual(group.source, 'scan', `${id} is a scan group`);
      assert.strictEqual(group.aiVerdict, null, `${id} has no verdict`);
      for (const member of group.members) {
        assert.strictEqual(
          member.aiVerdict,
          null,
          `${id}: no member carries a verdict`
        );
      }
    }

    await test('The ladder scores on the tiers the targeting tests assume', () => {
      seedLadder();
      const scores = [
        ['Amazon', 'amazon', 1],
        ['Mueller GmbH', 'Müller GmbH', 0.98],
        ['Telekom', 'Telekom GmbH', 0.95],
        ['Stadtwerke Muenchen', 'Muenchen Stadtwerke', 0.9],
      ];
      for (const [a, b, expected] of scores) {
        assert.strictEqual(
          matcher.scorePair(a, b, 'correspondents')?.score,
          expected,
          `${a} / ${b}`
        );
      }
      const band = matcher.scorePair(
        'Vodafone Kundenservice',
        'Kundenservice Vodafone Nord',
        'correspondents'
      );
      assert.ok(
        band.score >= service.candidateFloor() && band.score < 0.85,
        `the band pair scores ${band.score}`
      );
    });

    await test('groupIds judges the named groups and leaves the rest alone', async () => {
      seedLadder();
      const { calls } = useProvider(answerLadder());

      const result = await service.reviewScan({
        kind: 'correspondents',
        threshold: 0.85,
        withTitles: false,
        groupIds: [LADDER.exact, LADDER.tokenOrder],
      });

      assert.deepStrictEqual(
        askedIn(calls),
        [LADDER.tokenOrder, LADDER.band].sort(),
        'the named group a rule does not settle, and the band'
      );
      assert.strictEqual(
        result.groups.length,
        4,
        'every scan group is still there'
      );
      assert.deepStrictEqual(
        groupOf(result, LADDER.exact).aiVerdict,
        ruleVerdict('exact-normalized', 'case-or-spacing'),
        'the named exact group is settled without a request'
      );
      assert.deepStrictEqual(
        groupOf(result, LADDER.tokenOrder).members.map(
          (member) => member.aiVerdict?.verdict ?? null
        ),
        [null, 'same'],
        'the target judges nothing, the member carries the verdict'
      );
      assertUntouched(result, LADDER.umlaut);
      assertUntouched(result, LADDER.legalForm);

      assert.strictEqual(result.aiReview.targeted, true);
      assert.strictEqual(result.aiReview.groupsJudged, 2);
      assert.strictEqual(result.aiReview.groupsSkipped, 2);
      assert.strictEqual(result.aiReview.judged, 2, 'one group and the band');
      assert.strictEqual(result.aiReview.spellingRules, 1);
      assert.strictEqual(result.aiReview.candidates, 1);
    });

    await test('minConfidence judges only the groups that reach it', async () => {
      seedLadder();
      const { calls } = useProvider(answerLadder());

      const result = await service.reviewScan({
        kind: 'correspondents',
        threshold: 0.85,
        withTitles: false,
        minConfidence: 0.95,
      });

      assert.deepStrictEqual(
        askedIn(calls),
        [LADDER.band],
        '0.95 is reached by three groups, and a rule settles all three'
      );
      assertUntouched(result, LADDER.tokenOrder);
      assert.deepStrictEqual(
        groupOf(result, LADDER.legalForm).aiVerdict,
        ruleVerdict('legal-form', 'legal-form'),
        'the group sitting exactly on the bound is judged'
      );
      assert.deepStrictEqual(
        groupOf(result, LADDER.umlaut).aiVerdict,
        ruleVerdict('umlaut-variant', 'umlaut')
      );
      assert.strictEqual(result.aiReview.targeted, true);
      assert.strictEqual(result.aiReview.groupsJudged, 3);
      assert.strictEqual(result.aiReview.groupsSkipped, 1);
      assert.strictEqual(result.aiReview.spellingRules, 3);
      assert.strictEqual(result.aiReview.judged, 1, 'only the band pair');
    });

    await test('includeCandidates: false leaves the band out and reads no entity list', async () => {
      const fake = seedLadder();
      const { calls } = useProvider(answerLadder());

      const result = await service.reviewScan({
        kind: 'correspondents',
        threshold: 0.85,
        withTitles: false,
        includeCandidates: false,
      });

      assert.deepStrictEqual(
        askedIn(calls),
        [LADDER.tokenOrder],
        'the one group no rule settles, and no pair from the band'
      );
      assert.strictEqual(
        calls.some((call) => call.prompt.includes(LADDER.band)),
        false,
        'the band pair never reaches the model'
      );
      assert.strictEqual(result.aiReview.candidates, 0);
      assert.strictEqual(result.aiReview.targeted, true);
      assert.strictEqual(result.aiReview.groupsJudged, 4);
      assert.strictEqual(result.aiReview.groupsSkipped, 0);
      assert.strictEqual(
        result.groups.every((group) => group.source === 'scan'),
        true,
        'without a band there is nothing to build a candidate group from'
      );
      assert.strictEqual(
        fake.calls.filter((call) => call.path === '/correspondents/').length,
        1,
        'only the scan reads the correspondents; the review needs no second list'
      );
    });

    await test('groupIds and minConfidence both hold, unknown ids are ignored', async () => {
      seedLadder();
      const { calls } = useProvider(answerLadder());

      const result = await service.reviewScan({
        kind: 'correspondents',
        threshold: 0.85,
        withTitles: false,
        includeCandidates: false,
        groupIds: [
          LADDER.tokenOrder,
          LADDER.exact,
          'tags:99-100',
          'correspondents:404-405',
        ],
        minConfidence: 0.95,
      });

      assert.deepStrictEqual(
        askedIn(calls),
        [],
        'the named group below the confidence is left out with the rest, and a rule settles the other'
      );
      assert.deepStrictEqual(
        groupOf(result, LADDER.exact).aiVerdict,
        ruleVerdict('exact-normalized', 'case-or-spacing')
      );
      assertUntouched(result, LADDER.umlaut);
      assertUntouched(result, LADDER.legalForm);
      assertUntouched(result, LADDER.tokenOrder);
      assert.strictEqual(result.aiReview.groupsJudged, 1);
      assert.strictEqual(result.aiReview.groupsSkipped, 3);
      assert.strictEqual(result.aiReview.spellingRules, 1);
      assert.strictEqual(result.aiReview.requests, 0, 'nothing to ask about');

      const empty = await service.reviewScan({
        kind: 'correspondents',
        threshold: 0.85,
        withTitles: false,
        includeCandidates: false,
        groupIds: [],
      });
      assert.strictEqual(calls.length, 0, 'an empty selection asks nothing');
      assert.strictEqual(empty.groups.length, 4, 'and still returns the scan');
      for (const id of Object.values(LADDER)) {
        if (id === LADDER.band) continue;
        assertUntouched(empty, id);
      }
      assert.strictEqual(empty.aiReview.targeted, true);
      assert.strictEqual(empty.aiReview.groupsJudged, 0);
      assert.strictEqual(empty.aiReview.groupsSkipped, 4);
      assert.strictEqual(empty.aiReview.requests, 0);
    });

    await test('The log names the targeting, in the start line and in the totals', async () => {
      seedLadder();
      useProvider(answerLadder());
      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      try {
        await service.reviewScan({
          kind: 'correspondents',
          threshold: 0.85,
          withTitles: false,
          includeCandidates: false,
          groupIds: [LADDER.exact, LADDER.tokenOrder, 'correspondents:404-405'],
          minConfidence: 0.95,
        });
      } finally {
        console.log = realLog;
      }

      const review = lines.filter((line) => line.startsWith('[AI-REVIEW]'));
      const has = (pattern) =>
        assert.ok(
          review.some((line) => pattern.test(line)),
          `no [AI-REVIEW] line matches ${pattern}\n${review.join('\n')}`
        );
      has(
        /correspondents: threshold 0\.85, judging 1 of 4 group\(s\) \(min confidence 0\.95, 3 ids\), band skipped, 1 pair\(s\) settled by a spelling rule, 0 pair\(s\) to judge, titles off, excerpts on for 0 spelling-only pair\(s\), 0 entity\/entities fetched, model test-model\./
      );
      has(/1 of 3 group id\(s\) are not in this scan and were ignored\./);
      has(/1 group\(s\) judged, 3 skipped, in \d+ms\./);
    });

    await test('Without any of the three options the counters say "not targeted"', async () => {
      seedLadder();
      const { calls } = useProvider(answerLadder());

      const result = await service.reviewScan({
        kind: 'correspondents',
        threshold: 0.85,
        withTitles: false,
      });

      assert.deepStrictEqual(
        askedIn(calls),
        [LADDER.tokenOrder, LADDER.band].sort(),
        'everything the review ever asked about; three groups a rule settled'
      );
      assert.strictEqual(result.aiReview.targeted, false);
      assert.strictEqual(result.aiReview.groupsJudged, 4);
      assert.strictEqual(result.aiReview.groupsSkipped, 0);
      assert.strictEqual(result.aiReview.candidates, 1);
      assert.strictEqual(result.aiReview.spellingRules, 3);
    });

    // ------------------------------------------------------------ evidence

    /**
     * The archive the user actually ran into, as a fixture: one pair a
     * spelling distance links and meaning separates ("Kontoauszug" /
     * "Kontoumzug", and a second misspelling of the first name so one entity
     * sits in two pairs), one pair a strong tier links ("Versicherung" /
     * "Versicherungen", plural, 0.92) and one pair a rule settles outright
     * ("Rechnung" / "rechnung"). Every document carries content, because the
     * content is the evidence this section is about.
     */
    function seedSpelling() {
      return useFake({
        tags: [
          {
            id: 1,
            name: 'Kontoauszug',
            matching_algorithm: 1,
            match: 'kontoauszug',
          },
          { id: 2, name: 'Kontoumzug' },
          { id: 3, name: 'Kontoauszog' },
          { id: 4, name: 'Versicherung' },
          { id: 5, name: 'Versicherungen' },
          { id: 6, name: 'Rechnung' },
          { id: 7, name: 'rechnung' },
        ],
        correspondents: [
          { id: 20, name: 'Sparkasse Koeln' },
          { id: 21, name: 'Postbank' },
        ],
        documents: [
          {
            id: 100,
            title: 'Kontoauszug 03/2025',
            tags: [1],
            correspondent: 20,
            content:
              'Kontoauszug Nr. 3 vom 31.03.2025 Saldo alter Kontostand 1.204,55 EUR neuer Kontostand 980,12 EUR Buchungen im Zeitraum',
          },
          {
            id: 101,
            title: 'Kontoauszug 04/2025',
            tags: [1],
            correspondent: 20,
            content:
              'Kontoauszug Nr. 4 vom 30.04.2025 Saldo alter Kontostand 980,12 EUR neuer Kontostand 1.450,00 EUR',
          },
          {
            id: 102,
            title: 'Wechsel der Bankverbindung',
            tags: [2],
            correspondent: 21,
            content:
              'Kontoumzugsservice Wir erledigen den Wechsel Ihrer Bankverbindung fuer Sie. Ihre Zahlungspartner werden informiert.',
          },
          {
            id: 103,
            title: 'Auftrag Kontowechsel',
            tags: [2],
            correspondent: 21,
            content:
              'Kontoumzug Auftrag erteilt. Der Wechsel Ihrer Bankverbindung ist beauftragt.',
          },
          {
            id: 104,
            title: 'Kontoauszug 05/2025',
            tags: [3],
            correspondent: 20,
            content: 'Kontoauszug Nr. 5 vom 31.05.2025 Saldo neuer Kontostand',
          },
          {
            id: 105,
            title: 'Versicherungsschein',
            tags: [4],
            correspondent: 21,
            content: 'Versicherungsschein Haftpflicht Jahresbeitrag',
          },
          {
            id: 106,
            title: 'Beitragsrechnung Versicherung',
            tags: [5],
            correspondent: 21,
            content: 'Beitragsrechnung fuer Ihre Versicherung',
          },
          {
            id: 107,
            title: 'Rechnung 2024-11',
            tags: [6],
            correspondent: 21,
            content: 'Rechnung ueber 49,90 EUR',
          },
          {
            id: 108,
            title: 'rechnung kopie',
            tags: [7],
            correspondent: 21,
            content: 'Rechnung Kopie',
          },
        ],
      });
    }

    /** The excerpt reads a review made: the only ones that truncate content. */
    const excerptCalls = (fake) =>
      fake.calls.filter(
        (call) =>
          call.path === '/documents/' && call.params.truncate_content === true
      );

    /** The neighbourhood reads a review made, by the fields they ask for. */
    const neighbourCalls = (fake) =>
      fake.calls.filter(
        (call) =>
          call.path === '/documents/' &&
          (call.params.fields === 'id,correspondent' ||
            call.params.fields === 'id,tags')
      );

    await test('The spelling fixture scores on the tiers the evidence tests assume', () => {
      const score = (a, b) => matcher.scorePair(a, b, 'tags');
      assert.deepStrictEqual(score('Kontoauszug', 'Kontoumzug'), {
        score: 0.94,
        reason: 'fuzzy',
      });
      assert.deepStrictEqual(score('Kontoauszug', 'Kontoauszog'), {
        score: 0.94,
        reason: 'fuzzy',
      });
      assert.deepStrictEqual(score('Versicherung', 'Versicherungen'), {
        score: 0.92,
        reason: 'plural',
      });
      assert.deepStrictEqual(score('Rechnung', 'rechnung'), {
        score: 1,
        reason: 'exact-normalized',
      });
    });

    await test('The system prompt refuses a spelling distance as a reason on its own', async () => {
      const { calls } = useProvider(answerAll('different', 'two things'));
      await service.reviewPairs(tagPairs(1), { kind: 'tags' });
      const system = calls[0].options.systemPrompt;

      assert.match(
        system,
        /"Kontoauszug" \/ "Kontoumzug"/,
        'the pair the user ran into is in the rules'
      );
      assert.match(
        system,
        /A small spelling distance is never by itself a reason for "same"/
      );
      assert.match(
        system,
        /only when one of the two spellings is clearly not a word or a name of its own/,
        'a typo is only "same" when one spelling is not a word'
      );
      assert.match(
        system,
        /matched_by/,
        'the model is told what linked a pair'
      );
      assert.match(
        system,
        /"fuzzy", "prefix" and "token-order" mean nothing but spelling/
      );
      assert.match(system, /if excerpts are given, decide from them/);
      assert.match(system, /"basis": "<one word from the list below>"/);
      assert.match(system, /"confidence": "high" \| "low"/);
      for (const basis of service.VERDICT_BASES) {
        assert.ok(system.includes(basis), `the basis ${basis} is offered`);
      }
      assert.match(system, /filed_with/, 'and what the neighbourhood means');
      assert.ok(
        !/[äöüß]/i.test(system.replace(/Müller|Mueller/g, '')),
        'the prompt is English apart from the German examples'
      );
    });

    await test('basis and confidence are parsed, and anything else becomes null', async () => {
      const pairs = tagPairs(4);
      useProvider((prompt) => {
        const ids = idsInPrompt(prompt);
        return JSON.stringify([
          {
            id: ids[0],
            verdict: 'different',
            basis: 'Different-Thing',
            confidence: 'HIGH',
            reason: 'two accounts',
          },
          {
            id: ids[1],
            verdict: 'same',
            basis: 'vibes',
            confidence: 'medium',
            reason: 'looks alike',
          },
          { id: ids[2], verdict: 'unsure', reason: 'no idea' },
          {
            id: ids[3],
            verdict: 'same',
            basis: 'typo',
            confidence: 'low',
            reason: 'might be a word',
          },
        ]);
      });

      const result = await service.reviewPairs(pairs, { kind: 'tags' });
      assert.deepStrictEqual(
        result.verdicts.get(pairs[0].key),
        verdict('different', 'two accounts', {
          basis: 'different-thing',
          confidence: 'high',
        }),
        'case does not matter, the values do'
      );
      assert.deepStrictEqual(
        result.verdicts.get(pairs[1].key),
        verdict('same', 'looks alike'),
        'a basis and a confidence nobody knows are null, not an argument'
      );
      assert.deepStrictEqual(
        result.verdicts.get(pairs[2].key),
        verdict('unsure', 'no idea'),
        'an older model that names neither still answers'
      );
      assert.deepStrictEqual(
        result.verdicts.get(pairs[3].key),
        verdict('same', 'might be a word', {
          basis: 'typo',
          confidence: 'low',
        })
      );
    });

    await test('Excerpts are fetched for the spelling-only pairs, once per entity', async () => {
      const fake = seedSpelling();
      const { calls } = useProvider(
        answerAll('different', 'two different things')
      );
      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      let result;
      try {
        result = await service.reviewScan({ kind: 'tags', threshold: 0.85 });
      } finally {
        console.log = realLog;
      }

      assert.deepStrictEqual(
        askedIn(calls),
        ['tags:1-2', 'tags:1-3', 'tags:4-5'],
        'the two fuzzy pairs and the plural pair; the exact pair is settled'
      );

      const reads = excerptCalls(fake);
      assert.deepStrictEqual(
        reads.map((call) => call.params.tags__id__all).sort(),
        [1, 2, 3],
        'one read per entity of a spelling-only pair, and Kontoauszug sits in two of them'
      );
      assert.deepStrictEqual(reads[0].params, {
        tags__id__all: 1,
        fields: 'id,content',
        ordering: '-created',
        page: 1,
        page_size: 2,
        truncate_content: true,
      });
      assert.strictEqual(
        reads.some((call) => [4, 5, 6, 7].includes(call.params.tags__id__all)),
        false,
        'a plural pair and a settled pair are never worth a document read'
      );

      const prompt = calls[0].prompt;
      assert.match(prompt, /"matched_by":"fuzzy","score":0\.94/);
      assert.match(prompt, /"matched_by":"plural","score":0\.92/);
      assert.match(
        prompt,
        /"rule":\{"algorithm":"any","match":"kontoauszug"\}/
      );
      assert.match(prompt, /"excerpts":\["Kontoauszug Nr\. 3/);
      assert.match(prompt, /"excerpts":\["Kontoumzugsservice/);
      const pluralLine = prompt
        .split('\n')
        .find((line) => line.includes('tags:4-5'));
      assert.strictEqual(
        pluralLine.includes('"excerpts"'),
        false,
        'a pair a strong tier produced is judged on its names and titles'
      );

      assert.strictEqual(result.aiReview.excerpts, 3);
      assert.strictEqual(result.aiReview.spellingRules, 1);
      assert.strictEqual(result.aiReview.judged, 3);
      assert.strictEqual(result.aiReview.escalated, 0);

      const review = lines.filter((line) => line.startsWith('[AI-REVIEW]'));
      const has = (pattern) =>
        assert.ok(
          review.some((line) => pattern.test(line)),
          `no [AI-REVIEW] line matches ${pattern}\n${review.join('\n')}`
        );
      has(
        /tags: threshold 0\.85, 3 scan group\(s\), 0 candidate\(s\) in the band, 1 pair\(s\) settled by a spelling rule, 3 pair\(s\) to judge, titles on, excerpts on for 2 spelling-only pair\(s\), 3 entity\/entities fetched, model test-model\./
      );
      has(/tags: request 1, 3 pair\(s\), 2 with excerpts, ~\d+ prompt tokens/);
      assert.ok(
        !lines.some((line) => /Kontoauszug Nr\.|Bankverbindung/.test(line)),
        'document content is content and stays out of the log'
      );
    });

    await test('withExcerpts: false and the setting both read no document', async () => {
      const fake = seedSpelling();
      useProvider(answerAll('different', 'two different things'));
      const result = await service.reviewScan({
        kind: 'tags',
        threshold: 0.85,
        withExcerpts: false,
      });
      assert.strictEqual(excerptCalls(fake).length, 0, 'nothing was read');
      assert.strictEqual(result.aiReview.excerpts, 0);

      const switched = seedSpelling();
      const previous = config.duplicatesAiExcerpts;
      config.duplicatesAiExcerpts = false;
      try {
        assert.strictEqual(service.excerptsEnabled(), false);
        const off = await service.reviewScan({ kind: 'tags', threshold: 0.85 });
        assert.strictEqual(excerptCalls(switched).length, 0);
        assert.strictEqual(off.aiReview.excerpts, 0);
      } finally {
        config.duplicatesAiExcerpts = previous;
      }
    });

    await test('An excerpt is cut to the configured length and count', async () => {
      const fake = seedSpelling();
      const { calls } = useProvider(
        answerAll('different', 'two different things')
      );
      const previousChars = config.duplicatesAiExcerptChars;
      const previousDocuments = config.duplicatesAiExcerptDocuments;
      config.duplicatesAiExcerptChars = 40;
      config.duplicatesAiExcerptDocuments = 1;
      try {
        assert.strictEqual(service.excerptChars(), 40);
        assert.strictEqual(service.excerptDocuments(), 1);
        await service.reviewScan({ kind: 'tags', threshold: 0.85 });

        assert.ok(
          excerptCalls(fake).every((call) => call.params.page_size === 1),
          'the read asks for one document, not for two'
        );
        const excerpts = [
          ...calls[0].prompt.matchAll(/"excerpts":\[([^\]]*)\]/g),
        ].map((hit) => JSON.parse(`[${hit[1]}]`));
        assert.strictEqual(
          excerpts.length,
          4,
          'both entities of both fuzzy pairs, and Kontoauszug is in both'
        );
        for (const list of excerpts) {
          assert.strictEqual(list.length, 1, 'one excerpt per entity');
          assert.ok(
            list[0].length <= 40,
            `"${list[0]}" is longer than the configured 40 characters`
          );
          assert.strictEqual(
            list[0].trim(),
            list[0],
            'and it ends on a word, not in the middle of one'
          );
        }
      } finally {
        config.duplicatesAiExcerptChars = previousChars;
        config.duplicatesAiExcerptDocuments = previousDocuments;
      }
    });

    await test('Kontoauszug and Kontoumzug: the documents decide, and the page is told why', async () => {
      seedSpelling();
      const { calls } = useProvider((prompt) =>
        JSON.stringify(
          idsInPrompt(prompt).map((id) => ({
            id,
            verdict: id === 'tags:4-5' ? 'same' : 'different',
            basis: id === 'tags:4-5' ? 'plural' : 'different-thing',
            confidence: 'high',
            reason:
              id === 'tags:4-5'
                ? 'singular and plural'
                : 'statement of account versus account move',
          }))
        )
      );

      const grouped = await service.reviewScan({
        kind: 'tags',
        threshold: 0.85,
      });
      const group = grouped.groups.find((entry) => entry.id === 'tags:1-2-3');
      assert.strictEqual(group.suggestedTargetId, 1);
      const member = group.members.find((entry) => entry.id === 2);
      assert.deepStrictEqual(
        member.aiVerdict,
        verdict('different', 'statement of account versus account move', {
          basis: 'different-thing',
          confidence: 'high',
        }),
        'the member says what the model decided and on what basis'
      );
      assert.strictEqual(group.aiVerdict.verdict, 'different');
      assert.strictEqual(group.aiVerdict.basis, 'different-thing');

      // The same pair below the sensitivity: the band offers it, the model
      // rejects it, and no group is built from it.
      calls.length = 0;
      const banded = await service.reviewScan({
        kind: 'tags',
        threshold: 0.95,
      });
      assert.ok(
        askedIn(calls).includes('tags:1-2'),
        'the pair was offered as a candidate'
      );
      assert.strictEqual(
        banded.groups.some(
          (entry) =>
            entry.source === 'ai-candidate' &&
            entry.members.some((entity) => entity.id === 2)
        ),
        false,
        'a rejected candidate never becomes a group'
      );
      assert.strictEqual(
        banded.groups.some(
          (entry) =>
            entry.source === 'ai-candidate' &&
            entry.members.some((entity) => entity.id === 5)
        ),
        true,
        'while the plural pair the model confirmed does'
      );
    });

    await test('A pair a rule settles costs no request at all', async () => {
      const fake = seedSpelling();
      const { calls } = useProvider(() => {
        throw new Error('the model must not be asked about a settled pair');
      });
      const result = await service.reviewScan({
        kind: 'tags',
        threshold: 0.85,
        groupIds: ['tags:6-7'],
        includeCandidates: false,
      });

      assert.strictEqual(calls.length, 0, 'no provider call');
      assert.strictEqual(result.aiReview.requests, 0);
      assert.strictEqual(result.aiReview.judged, 0);
      assert.strictEqual(result.aiReview.spellingRules, 1);
      assert.strictEqual(
        fake.calls.filter((call) => call.path === '/documents/').length,
        0,
        'and no evidence is read for a pair nobody is asked about'
      );
      const group = result.groups.find((entry) => entry.id === 'tags:6-7');
      assert.deepStrictEqual(
        group.aiVerdict,
        ruleVerdict('exact-normalized', 'case-or-spacing')
      );
      assert.deepStrictEqual(
        group.members.map((member) => member.aiVerdict?.source ?? null),
        [null, 'spelling-rule']
      );
    });

    await test('The neighbourhood of an entity is read once and reaches the model', async () => {
      const fake = seedSpelling();
      const { calls } = useProvider(
        answerAll('different', 'two different things')
      );
      await service.reviewScan({ kind: 'tags', threshold: 0.85 });

      const reads = neighbourCalls(fake);
      assert.deepStrictEqual(
        reads.map((call) => call.params.tags__id__all).sort(),
        [1, 2, 3, 4, 5],
        'one read per judged entity, whatever number of pairs names it'
      );
      assert.deepStrictEqual(reads[0].params, {
        tags__id__all: 1,
        fields: 'id,correspondent',
        ordering: '-created',
        page: 1,
        page_size: 30,
      });
      assert.match(calls[0].prompt, /"filed_with":\["Sparkasse Koeln"\]/);
      assert.match(calls[0].prompt, /"filed_with":\["Postbank"\]/);
    });

    await test('An unsure pair without excerpts is asked again, with them', async () => {
      const fake = seedSpelling();
      const { calls } = useProvider((prompt, options, callNumber) =>
        JSON.stringify(
          idsInPrompt(prompt).map((id) => ({
            id,
            verdict: callNumber === 1 ? 'unsure' : 'same',
            basis: callNumber === 1 ? 'insufficient-evidence' : 'plural',
            confidence: callNumber === 1 ? 'low' : 'high',
            reason: callNumber === 1 ? 'the names alone' : 'the documents',
          }))
        )
      );
      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      let result;
      try {
        result = await service.reviewScan({ kind: 'tags', threshold: 0.85 });
      } finally {
        console.log = realLog;
      }

      assert.strictEqual(calls.length, 2, 'one round, then the escalation');
      assert.deepStrictEqual(
        idsInPrompt(calls[1].prompt),
        ['tags:4-5'],
        'only the unsure pair that had no excerpts is asked again'
      );
      assert.match(
        calls[1].prompt,
        /"excerpts":\["Versicherungsschein/,
        'and this time it comes with the documents'
      );
      assert.strictEqual(result.aiReview.escalated, 1);
      assert.strictEqual(result.aiReview.requests, 2);

      const plural = result.groups.find((entry) => entry.id === 'tags:4-5');
      assert.deepStrictEqual(
        plural.aiVerdict,
        verdict('same', 'the documents', {
          basis: 'plural',
          confidence: 'high',
        }),
        'the second answer replaces the first'
      );
      const fuzzy = result.groups.find((entry) => entry.id === 'tags:1-2-3');
      assert.strictEqual(
        fuzzy.aiVerdict.verdict,
        'unsure',
        'a pair that already had excerpts stays as it was answered'
      );
      assert.deepStrictEqual(
        excerptCalls(fake)
          .map((call) => call.params.tags__id__all)
          .sort(),
        [1, 2, 3, 4, 5],
        'the escalation read the two entities the first round did not'
      );
      assert.ok(
        lines.some((line) =>
          /escalated 1 of 1 unsure pair\(s\) with excerpts, 2 entity\/entities fetched\./.test(
            line
          )
        ),
        `no escalation line:\n${lines.join('\n')}`
      );
    });

    await test('An escalation that finds no document does not ask again', async () => {
      // The archive of somebody whose documents carry no text: the read
      // happens, it brings nothing, and nothing is asked a second time.
      useFake({
        tags: [
          { id: 4, name: 'Versicherung' },
          { id: 5, name: 'Versicherungen' },
        ],
        documents: [
          { id: 105, title: 'Scan 1', tags: [4] },
          { id: 106, title: 'Scan 2', tags: [5] },
        ],
      });
      const { calls } = useProvider(answerAll('unsure', 'the names alone'));
      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      let result;
      try {
        result = await service.reviewScan({ kind: 'tags', threshold: 0.85 });
      } finally {
        console.log = realLog;
      }

      assert.strictEqual(calls.length, 1, 'one round and no second one');
      assert.strictEqual(result.aiReview.escalated, 0);
      assert.strictEqual(result.aiReview.excerpts, 0);
      assert.ok(
        lines.some((line) =>
          /escalated 0 of 1 unsure pair\(s\) with excerpts/.test(line)
        ),
        `no escalation line:\n${lines.join('\n')}`
      );
    });

    await test('The batch is sized on the prompt the excerpts made, not on the names', async () => {
      const withoutEvidence = tagPairs(20).map((pair) => ({
        ...pair,
        matchedBy: 'fuzzy',
        score: 0.9,
      }));
      const filler =
        'Kontoauszug Nr. 3 vom 31.03.2025 Saldo alter Kontostand 1.204,55 EUR '.repeat(
          4
        );
      const withEvidence = withoutEvidence.map((pair) => ({
        ...pair,
        a: { ...pair.a, sampleExcerpts: [filler, filler] },
        b: { ...pair.b, sampleExcerpts: [filler, filler] },
      }));

      const previousLimit = process.env.TOKEN_LIMIT;
      process.env.TOKEN_LIMIT = '8000';
      try {
        useProvider(answerAll('same', 'same word'));
        const plain = await service.reviewPairs(withoutEvidence, {
          kind: 'tags',
        });
        const { calls } = useProvider(answerAll('same', 'same word'));
        const evidenced = await service.reviewPairs(withEvidence, {
          kind: 'tags',
        });

        assert.ok(
          evidenced.usage.batchSize < plain.usage.batchSize,
          `a batch of pairs with excerpts (${evidenced.usage.batchSize}) has to be smaller than one without (${plain.usage.batchSize})`
        );
        for (const call of calls) {
          const estimate = Math.ceil(
            `${call.options.systemPrompt}\n${call.prompt}`.length / 4
          );
          assert.ok(
            estimate + call.options.maxTokens + service.TOKENS_CONTEXT_MARGIN <=
              8000,
            `prompt ${estimate} + cap ${call.options.maxTokens} does not fit into 8000`
          );
        }
        assert.strictEqual(evidenced.verdicts.size, 20);
      } finally {
        if (previousLimit === undefined) delete process.env.TOKEN_LIMIT;
        else process.env.TOKEN_LIMIT = previousLimit;
      }
    });

    await test('The judge can run on its own model', async () => {
      seedSpelling();
      const { calls } = useProvider(answerAll('different', 'two things'));
      const previous = config.duplicatesAiModel;
      config.duplicatesAiModel = 'judge-model';
      try {
        assert.strictEqual(service.judgeModel(), 'judge-model');
        assert.strictEqual(service.modelName(), 'judge-model');
        const result = await service.reviewScan({
          kind: 'tags',
          threshold: 0.85,
          withTitles: false,
          withExcerpts: false,
        });
        assert.strictEqual(calls[0].options.model, 'judge-model');
        assert.strictEqual(result.aiReview.model, 'judge-model');
      } finally {
        config.duplicatesAiModel = previous;
      }

      assert.strictEqual(service.judgeModel(), '');
      assert.strictEqual(
        service.modelName(),
        'test-model',
        'without the setting the provider keeps its own model'
      );
      calls.length = 0;
      await service.reviewPairs(tagPairs(1), { kind: 'tags' });
      assert.strictEqual(
        'model' in calls[0].options,
        false,
        'and nothing is sent that was not sent before'
      );
    });

    await test('The model option reaches every provider the way its API spells it', async () => {
      const stub = useProviderStubs();
      try {
        for (const provider of Object.values(stub.services)) {
          await provider.generateText('hello', { model: 'judge-model' });
        }
        for (const name of ['openai', 'custom', 'azure']) {
          assert.strictEqual(
            stub.sent[name].model,
            'judge-model',
            `${name}: the request names the model it was told to use`
          );
        }
        assert.strictEqual(stub.sent.ollama.model, 'judge-model');

        for (const provider of Object.values(stub.services)) {
          await provider.generateText('hello', { model: '   ' });
        }
        assert.notStrictEqual(
          stub.sent.openai.model,
          '   ',
          'a blank model is no model'
        );
      } finally {
        stub.restore();
      }
    });

    await test('Document excerpts come from Paperless-ngx, bounded twice', async () => {
      const fake = seedSpelling();
      const excerpts = await paperlessService.getRecentDocumentExcerptsByEntity(
        'tags',
        1,
        { limit: 2, chars: 60 }
      );
      assert.strictEqual(excerpts.length, 2);
      for (const excerpt of excerpts) {
        assert.ok(excerpt.length <= 60, excerpt);
        assert.ok(excerpt.startsWith('Kontoauszug Nr.'));
      }
      const call = fake.calls[fake.calls.length - 1];
      assert.deepStrictEqual(call.params, {
        tags__id__all: 1,
        fields: 'id,content',
        ordering: '-created',
        page: 1,
        page_size: 2,
        truncate_content: true,
      });

      const ofCorrespondent =
        await paperlessService.getRecentDocumentExcerptsByEntity(
          'correspondents',
          21,
          { limit: 1, chars: 300 }
        );
      assert.strictEqual(ofCorrespondent.length, 1);
      assert.match(
        ofCorrespondent[0],
        /^Kontoumzugsservice Wir erledigen/,
        'a correspondent reads the same way a tag does'
      );

      paperlessService.client = {
        async get() {
          throw new Error('socket hang up');
        },
      };
      assert.deepStrictEqual(
        await paperlessService.getRecentDocumentExcerptsByEntity('tags', 1),
        [],
        'a failed read never throws'
      );
      assert.deepStrictEqual(
        await paperlessService.getRecentDocumentExcerptsByEntity('nonsense', 1),
        [],
        'an unknown kind is refused quietly'
      );
    });

    await test('A neighbourhood is the most frequent names, and never an exception', async () => {
      seedSpelling();
      assert.deepStrictEqual(
        await paperlessService.getEntityNeighbourhood('tags', 1, {
          documents: 30,
          limit: 3,
        }),
        ['Sparkasse Koeln'],
        'a tag is filed with the senders of its documents'
      );
      assert.deepStrictEqual(
        await paperlessService.getEntityNeighbourhood('correspondents', 20, {
          documents: 30,
          limit: 2,
        }),
        ['Kontoauszug', 'Kontoauszog'],
        'a correspondent is filed under the tags of its documents, most used first'
      );

      paperlessService.client = {
        async get() {
          throw new Error('socket hang up');
        },
      };
      assert.deepStrictEqual(
        await paperlessService.getEntityNeighbourhood('tags', 1),
        [],
        'a failed read never throws'
      );
      assert.deepStrictEqual(
        await paperlessService.getEntityNeighbourhood('nonsense', 1),
        [],
        'an unknown kind is refused quietly'
      );
    });
  } finally {
    AIServiceFactory.getService = realGetService;
    documentModel.closeDatabase();
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
