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
 * 42. A watched review is planned in full before the first request: scan,
 *     evidence per kind, one judging report with the whole denominator, then
 *     a report per answered request and a finishing one
 * 43. Two kinds are one plan, and the evidence of both is read before the
 *     first request
 * 44. A cut-off answer adds its halves to the plan in its own report; a
 *     failed request still moves the bar
 * 45. The escalation reports its phase and raises the plan before it asks
 * 46. A stop between requests: one request made, the pairs nobody asked
 *     about have no verdict and cannot become a group, the rule verdicts
 *     stay, and the log says what it cost
 * 47. A stop in flight is not a failed request and fills nothing with unsure
 * 48. The token budget stops the review itself and says so
 * 49. A provider that reports no usage is measured, so the counter and the
 *     budget work for it too
 * 50. An already aborted signal makes no request and reads no band
 * 51. Without a control the review is what it always was, and a report never
 *     carries what the job derives
 * 52. All four providers hand a signal on and send nothing new without one
 * 53. Thinking is off on every judge request unless the setting says so
 * 54. The first request of an unmeasured review is a warm-up of four pairs
 *     with its own cap, announced under its own phase
 * 55. The sizing math: a fixed usage and duration give a batch size and a cap,
 *     the request seconds scale them, the context window bounds them, and a
 *     second measurement is smoothed against the first
 * 56. The warm-up settles the plan, the estimate and `calibrated`
 * 57. A measurement is reused by the next review of the same model, not
 *     across the thinking switch, and resetCalibration drops it
 * 58. A warm-up that does not fit even with the whole window ends the review
 *     with a message naming the two switches that can fix it
 * 59. The cut-off text of a truncated request is salvaged and counted
 * 60. A streamed request reports thinking, then the answers as they arrive,
 *     and clears itself in the report that counts it; an unwatched review
 *     does not ask the provider to stream at all
 * 61. A review reuses the scan the page just made
 * 62. The semantic sweep: names only, chunked by the setting, with its own
 *     system prompt; an archive above the limit is skipped and says why
 * 63. A proposal becomes a candidate pair with the reason semantic, a score
 *     of 0.5 and the sweep's basis and reason as a hint in the judging prompt
 * 64. A confirmed proposal is a group at fifty per cent, a rejected one is
 *     nothing; a proposal the review already knows is never made twice
 * 65. A pair of the sweep always carries excerpts; the counters, the log line
 *     and the sweeping phase; a cut-off sweep answer is salvaged, one that
 *     salvaged nothing is re-asked with a raised cap, and the token budget
 *     stops a review inside its sweep
 * 66. Without the option no sweep request is made at all
 * 67. The calibration survives a restart: it is loaded from ai_calibration
 *     into a fresh review, saved after every measurement, and resetCalibration
 *     and forgetCalibration clear memory and table alike
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
  const duplicateMergeService = require('../services/duplicateMergeService');

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
    // Every case starts from an unmeasured model; what a review learns is
    // kept on the singleton and would otherwise reach the next one.
    service.resetCalibration();
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
    // A new archive is exactly what the scan cache must not answer for; in
    // production a merge, an undo or a dismissal drops it the same way.
    duplicateMergeService.invalidateScanCache();
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
        [8, 8, 4, 4, 2, 2, 4, 4, 2, 2],
        'every size is asked twice: once, then once with twice the cap, and ' +
          'only then halved. This provider truncates on the pair count, so ' +
          'the raised cap never helps it; a real one that ran out of room ' +
          'answers the second request and the halving never happens.'
      );
      assert.strictEqual(result.verdicts.size, 8, 'every pair has a verdict');
      assert.ok(
        [...result.verdicts.values()].every((v) => v.verdict === 'same'),
        'and it is the verdict the model gave, not "unsure"'
      );
      assert.strictEqual(result.usage.requests, 10);
      assert.strictEqual(
        result.usage.retries,
        9,
        'every re-ask is a retry, the first request is not'
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
      assert.strictEqual(
        result.usage.requests,
        2,
        'one pair is not split, but it is asked again with twice the cap'
      );
      assert.strictEqual(result.usage.retries, 1);
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
      // What the SDK was handed beside the body, and what axios was handed
      // beside the URL: where a signal travels.
      const sentOptions = {};
      const chatClient = (name) => ({
        chat: {
          completions: {
            create: async (request, requestOptions) => {
              sent[name] = request;
              sentOptions[name] = requestOptions;
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
        post: async (url, body, requestConfig) => {
          sent.ollama = body;
          sentOptions.ollama = requestConfig;
          return {
            data: { response: 'answer', prompt_eval_count: 11, eval_count: 7 },
          };
        },
      };
      return {
        sent,
        sentOptions,
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
        // A review nobody stopped says so, and says it every time: the three
        // fields are on every result, not only on a stopped one.
        stopped: false,
        stopReason: null,
        pairsNotJudged: 0,
        // A review that did not sweep made no sweep request and proposed
        // no pair; both numbers are on every result all the same.
        sweepRequests: 0,
        sweepProposals: 0,
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
      has(
        /first batch ~\d+ prompt tokens, completion cap 560 — provisional, the model has not been measured yet\./
      );
      // The one request of this review is the warm-up, so it carries the
      // warm-up's own cap rather than the plan's estimate.
      has(
        /correspondents: request 1, 3 pair\(s\), ~\d+ prompt tokens, cap 1500, \d+ms, 2 same \/ 1 different \/ 0 unsure\./
      );
      has(
        /review finished: 1 request\(s\) \(0 retry\/retries, 0 failed\), 100 token\(s\), 3 pair\(s\) planned, 3 candidate\(s\), 3 group\(s\) confirmed, in \d+ms\./
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
    // ------------------------------------ watching, stopping, token budget

    /**
     * A stand-in for the control object of the review job: it records every
     * progress patch, it aborts the way the job aborts, and it knows why it
     * was stopped, the way the job tells the judge.
     */
    function useControl(options = {}) {
      const controller = new AbortController();
      const patches = [];
      const stops = [];
      let reason = options.reason ?? null;
      const control = {
        signal: controller.signal,
        tokenBudget: options.tokenBudget ?? null,
        onProgress: (patch) => patches.push({ ...patch }),
        stop: (given) => {
          stops.push(given);
          reason = given;
          controller.abort();
        },
        stopReason: () => reason,
      };
      return {
        control,
        patches,
        stops,
        /** What the job does when the user presses stop. */
        abort(why = 'user') {
          reason = why;
          controller.abort();
        },
        /** The reports of one phase, in order. */
        ofPhase: (phase) => patches.filter((patch) => patch.phase === phase),
        /** The report of every answered request: the ones that count one. */
        requests: () =>
          patches.filter((patch) => patch.requestsDone !== undefined),
        /** The reports from inside a request the provider streamed. */
        streams: () =>
          patches.filter(
            (patch) =>
              patch.requestsDone === undefined &&
              patch.requestPairs !== undefined &&
              patch.phase === undefined
          ),
      };
    }

    /** Runs `fn` with `size` pairs per model request. */
    async function withBatchSize(size, fn) {
      const previous = config.duplicatesAiReviewBatchSize;
      config.duplicatesAiReviewBatchSize = size;
      try {
        return await fn();
      } finally {
        config.duplicatesAiReviewBatchSize = previous;
      }
    }

    /**
     * Runs `fn` with a model that has already been measured, so the review
     * starts sized and spends no request on a warm-up.
     */
    async function withCalibration(
      { tokensPerPair = 100, tokensPerSecond = 30, thinking = false },
      fn
    ) {
      service.calibration.set('test-model', {
        tokensPerPair,
        tokensPerSecond,
        thinking,
        measuredAt: Date.now(),
      });
      try {
        return await fn();
      } finally {
        service.resetCalibration();
      }
    }

    /** The three band pairs of seedArchive(), asked one per request. */
    const BAND_REVIEW = {
      kind: 'correspondents',
      threshold: 0.95,
      includeDismissed: true,
    };

    await test('A watched review is planned in full before the first request', async () => {
      seedArchive();
      const watch = useControl();
      let phasesAtFirstRequest = null;
      const { calls } = useProvider((prompt) => {
        if (phasesAtFirstRequest === null) {
          phasesAtFirstRequest = watch.patches.map((patch) => patch.phase);
        }
        return answerFromTable()(prompt);
      });

      const result = await withBatchSize(1, () =>
        service.reviewScan(BAND_REVIEW, watch.control)
      );

      assert.strictEqual(calls.length, 3, 'three pairs, one per request');
      assert.deepStrictEqual(
        phasesAtFirstRequest,
        ['scanning', 'evidence', 'evidence', 'warming-up'],
        'the scan, both evidence reads and the whole plan happened first, ' +
          'and the first request is the warm-up'
      );
      const planned = watch.ofPhase('warming-up');
      assert.strictEqual(planned.length, 1, 'the plan is reported once');
      assert.strictEqual(planned[0].requestsPlanned, 3);
      assert.strictEqual(planned[0].pairsTotal, 3);
      assert.strictEqual(planned[0].spellingRules, 1);
      assert.strictEqual(planned[0].calibrated, false);
      assert.strictEqual(planned[0].batchSize, 1, 'one pair per request here');
      assert.strictEqual(planned[0].message, service.WARMUP_MESSAGE);
      assert.ok(
        planned[0].estimatedTokens >=
          3 * (service.TOKENS_PER_PAIR + service.TOKENS_OVERHEAD),
        `the estimate covers the whole review, not one kind: ${planned[0].estimatedTokens}`
      );

      const answered = watch.requests();
      assert.deepStrictEqual(
        answered.map((patch) => patch.requestsDone),
        [1, 2, 3]
      );
      assert.deepStrictEqual(
        answered.map((patch) => patch.pairsJudged),
        [1, 2, 3]
      );
      assert.deepStrictEqual(
        answered.map((patch) => patch.tokens),
        [100, 200, 300],
        'the running total of the review, never a delta'
      );
      assert.deepStrictEqual(
        answered.map((patch) => patch.message),
        [
          'Asking the model, request 2 of 3',
          'Asking the model, request 3 of 3',
          'Waiting for the last answer…',
        ]
      );
      assert.deepStrictEqual(
        answered.map((patch) => patch.kind),
        ['correspondents', 'correspondents', 'correspondents']
      );
      assert.strictEqual(
        answered[0].phase,
        'judging',
        'the warm-up answer is what moves the page on'
      );
      const last = watch.patches[watch.patches.length - 1];
      assert.strictEqual(last.phase, 'finishing');
      assert.strictEqual(last.message, 'Building the groups…');

      assert.strictEqual(result.aiReview.stopped, false);
      assert.strictEqual(result.aiReview.stopReason, null);
      assert.strictEqual(result.aiReview.pairsNotJudged, 0);
      assert.strictEqual(result.aiReview.requests, 3);
    });

    await test('Two kinds are one plan, made before the first request', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Rechnung' },
          { id: 2, name: 'Rechnungen' },
        ],
        correspondents: [
          { id: 10, name: 'Vodafone Kundenservice' },
          { id: 11, name: 'Kundenservice Vodafone Nord' },
        ],
        documents: [
          { id: 100, title: 'Invoice A', tags: [1], correspondent: 10 },
          { id: 101, title: 'Invoice B', tags: [2], correspondent: 11 },
        ],
      });
      const watch = useControl();
      let phasesAtFirstRequest = null;
      const { calls } = useProvider((prompt) => {
        if (phasesAtFirstRequest === null) {
          phasesAtFirstRequest = watch.patches.map((patch) => patch.phase);
        }
        return answerAll('same', 'two spellings')(prompt);
      });

      const result = await withBatchSize(1, () =>
        service.reviewScan({ kind: 'all', threshold: 0.95 }, watch.control)
      );

      assert.strictEqual(calls.length, 2, 'one pair per kind');
      assert.strictEqual(phasesAtFirstRequest[0], 'scanning');
      assert.strictEqual(
        phasesAtFirstRequest[phasesAtFirstRequest.length - 1],
        'warming-up'
      );
      assert.ok(
        phasesAtFirstRequest.filter((phase) => phase === 'evidence').length >=
          2,
        `both kinds read their evidence before the first request: ${phasesAtFirstRequest.join(', ')}`
      );
      assert.deepStrictEqual(
        [...new Set(watch.ofPhase('evidence').map((patch) => patch.kind))],
        ['tags', 'correspondents'],
        'and each report says which kind it is reading for'
      );
      const planned = watch.ofPhase('warming-up');
      assert.strictEqual(planned.length, 1);
      assert.strictEqual(
        planned[0].requestsPlanned,
        2,
        'the denominator counts both kinds'
      );
      assert.strictEqual(planned[0].pairsTotal, 2);
      assert.deepStrictEqual(
        watch.requests().map((patch) => patch.kind),
        ['tags', 'correspondents']
      );
      assert.strictEqual(result.aiReview.stopped, false);
    });

    await test('A cut-off answer raises the plan in the report of its own request', async () => {
      seedArchive();
      const watch = useControl();
      const { calls } = useProvider((prompt, options, callNumber) =>
        callNumber === 1 ? truncationError() : answerFromTable()(prompt)
      );

      // Measured already, so this is an ordinary request that doubles its
      // cap; the warm-up asks for the whole window instead.
      await withCalibration({}, () =>
        withBatchSize(3, () => service.reviewScan(BAND_REVIEW, watch.control))
      );

      assert.deepStrictEqual(
        calls.map((call) => idsInPrompt(call.prompt).length),
        [3, 3],
        'the cut-off batch of three is re-asked whole, with twice the cap'
      );
      assert.strictEqual(
        calls[0].options.maxTokens,
        Math.ceil(100 * 3 * service.CAP_SAFETY_FACTOR) + service.TOKENS_OVERHEAD
      );
      assert.strictEqual(
        calls[1].options.maxTokens,
        calls[0].options.maxTokens * 2,
        'the cap doubled'
      );
      assert.strictEqual(watch.ofPhase('judging')[0].requestsPlanned, 1);
      const answered = watch.requests();
      assert.deepStrictEqual(
        answered.map((patch) => patch.requestsPlanned),
        [2, 2],
        'the raised retry was added to the plan in the report of its own request'
      );
      assert.deepStrictEqual(
        answered.map((patch) => patch.requestsDone),
        [1, 2],
        'so the bar never goes backwards in per cent'
      );
      assert.deepStrictEqual(
        answered.map((patch) => patch.pairsJudged),
        [0, 3],
        'the request that only raised the cap settled nothing itself'
      );
      assert.deepStrictEqual(
        answered.map((patch) => patch.retries),
        [0, 1]
      );
      assert.deepStrictEqual(
        answered.map((patch) => patch.failedRequests),
        [0, 0],
        'a truncation is not a failure'
      );
    });

    await test('A raised cap that bought nothing halves the batch', async () => {
      seedArchive();
      const watch = useControl();
      const lines = [];
      const { calls } = useProvider((prompt, options, callNumber) =>
        callNumber <= 2 ? truncationError() : answerFromTable()(prompt)
      );
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      try {
        // Already measured, so the first request is an ordinary one: the
        // warm-up has a rule of its own when it cannot fit.
        await withCalibration({}, () =>
          withBatchSize(3, () => service.reviewScan(BAND_REVIEW, watch.control))
        );
      } finally {
        console.log = realLog;
      }

      assert.deepStrictEqual(
        calls.map((call) => idsInPrompt(call.prompt).length),
        [3, 3, 2, 1],
        'once, once with twice the cap, and only then as two halves'
      );
      const answered = watch.requests();
      assert.deepStrictEqual(
        answered.map((patch) => patch.requestsDone),
        [1, 2, 3, 4]
      );
      assert.deepStrictEqual(
        answered.map((patch) => patch.requestsPlanned),
        [2, 4, 4, 4],
        'the raise adds one request to the plan, the halving adds its two halves'
      );
      assert.ok(
        lines.some((line) => /raising the cap from \d+ to \d+/.test(line)),
        `no raise line:\n${lines.join('\n')}`
      );
      assert.ok(
        lines.some((line) =>
          /a raised cap did not help, halving into 2 \+ 1/.test(line)
        ),
        `no halving line:\n${lines.join('\n')}`
      );
    });

    await test('A failed request still moves the bar', async () => {
      seedArchive();
      const watch = useControl();
      useProvider((prompt, options, callNumber) =>
        callNumber === 1
          ? new Error('socket hang up')
          : answerFromTable()(prompt)
      );

      const result = await withBatchSize(1, () =>
        service.reviewScan(BAND_REVIEW, watch.control)
      );

      const answered = watch.requests();
      assert.deepStrictEqual(
        answered.map((patch) => patch.requestsDone),
        [1, 2, 3],
        'a request that failed is a request the review is done with'
      );
      assert.deepStrictEqual(
        answered.map((patch) => patch.failedRequests),
        [1, 1, 1]
      );
      assert.strictEqual(result.aiReview.failedRequests, 1);
      assert.strictEqual(result.aiReview.stopped, false);
      assert.strictEqual(
        result.aiReview.pairsNotJudged,
        0,
        'a failed batch is answered — with unsure — not left open'
      );
    });

    await test('The escalation reports its phase and raises the plan', async () => {
      seedSpelling();
      const watch = useControl();
      const { calls } = useProvider((prompt, options, callNumber) =>
        JSON.stringify(
          idsInPrompt(prompt).map((id) => ({
            id,
            verdict: callNumber === 1 ? 'unsure' : 'same',
            reason: callNumber === 1 ? 'the names alone' : 'the documents',
          }))
        )
      );

      const result = await service.reviewScan(
        { kind: 'tags', threshold: 0.85 },
        watch.control
      );

      assert.strictEqual(calls.length, 2, 'one round, then the escalation');
      assert.strictEqual(watch.ofPhase('judging')[0].requestsPlanned, 1);
      const escalating = watch.ofPhase('escalating');
      assert.strictEqual(escalating.length, 1);
      assert.strictEqual(escalating[0].kind, 'tags');
      assert.strictEqual(escalating[0].escalated, 1);
      assert.strictEqual(
        escalating[0].requestsPlanned,
        2,
        'the second round is added to the plan before it is asked'
      );
      assert.strictEqual(
        escalating[0].message,
        'Asking once more about 1 unsure pairs, with excerpts…'
      );
      assert.strictEqual(
        escalating[0].pairsTotal,
        watch.ofPhase('judging')[0].pairsTotal + 1,
        'a pair asked twice is due twice, so the bar cannot overtake itself'
      );
      const answered = watch.requests();
      assert.strictEqual(answered[answered.length - 1].requestsPlanned, 2);
      assert.strictEqual(answered[answered.length - 1].requestsDone, 2);
      assert.strictEqual(result.aiReview.escalated, 1);
      assert.strictEqual(result.aiReview.stopped, false);
    });

    await test('A stop between requests keeps the verdicts and asks nothing more', async () => {
      seedArchive();
      const watch = useControl();
      const { calls } = useProvider((prompt, options, callNumber) => {
        const answer = answerFromTable()(prompt);
        // The job aborts while the review is between two requests.
        if (callNumber === 1) watch.abort('user');
        return answer;
      });
      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      let result;
      try {
        result = await withBatchSize(1, () =>
          service.reviewScan(BAND_REVIEW, watch.control)
        );
      } finally {
        console.log = realLog;
      }

      assert.strictEqual(calls.length, 1, 'the second request is never made');
      assert.strictEqual(result.aiReview.stopped, true);
      assert.strictEqual(
        result.aiReview.stopReason,
        null,
        'the judge knows that it stopped, the job knows why'
      );
      assert.strictEqual(result.aiReview.pairsNotJudged, 2);
      assert.strictEqual(result.aiReview.requests, 1);
      assert.strictEqual(result.aiReview.failedRequests, 0);
      assert.strictEqual(watch.requests().length, 1);

      const scanGroup = result.groups.find((group) => group.source === 'scan');
      assert.deepStrictEqual(
        scanGroup.aiVerdict,
        ruleVerdict('exact-normalized', 'case-or-spacing'),
        'what a rule settled survives the stop'
      );
      assert.strictEqual(
        result.groups.some((group) => group.aiVerdict?.verdict === 'unsure'),
        false,
        'a pair nobody asked about has no verdict at all; unsure is the model’s word'
      );

      const answeredKey = idsInPrompt(calls[0].prompt)[0];
      const candidateGroups = result.groups.filter(
        (group) => group.source === 'ai-candidate'
      );
      assert.strictEqual(
        candidateGroups.length,
        VERDICTS_BY_KEY[answeredKey][0] === 'same' ? 1 : 0,
        'only a pair the model answered can become a group'
      );
      for (const key of Object.keys(VERDICTS_BY_KEY)) {
        if (key === answeredKey) continue;
        const [a, b] = key
          .split(':')[1]
          .split('-')
          .map((id) => Number(id));
        assert.strictEqual(
          candidateGroups.some((group) =>
            group.members.some((member) => member.id === a || member.id === b)
          ),
          false,
          `${key} was never asked, so it is not offered as a group`
        );
      }
      assert.ok(
        lines.some((line) =>
          /review stopped \(user\): 1 of 3 request\(s\) made, 2 pair\(s\) not judged, 100 token\(s\)\./.test(
            line
          )
        ),
        `no stop line:\n${lines.join('\n')}`
      );
    });

    await test('A stop while a request is in flight is not a failed request', async () => {
      seedArchive();
      const watch = useControl();
      const { calls } = useProvider(async (prompt, options, callNumber) => {
        if (callNumber > 1) return answerFromTable()(prompt);
        // The provider that waits, the way a real one waits for a model:
        // the stop arrives while this request is open.
        watch.abort('user');
        await new Promise((resolve) => setImmediate(resolve));
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        return error;
      });

      const result = await withBatchSize(1, () =>
        service.reviewScan(BAND_REVIEW, watch.control)
      );

      assert.strictEqual(calls.length, 1);
      assert.ok(
        calls[0].options.signal instanceof AbortSignal,
        'the request carried the signal it died on'
      );
      assert.strictEqual(
        result.aiReview.failedRequests,
        0,
        'an aborted request is a stop, not a failure'
      );
      assert.strictEqual(result.aiReview.retries, 0);
      assert.strictEqual(result.aiReview.stopped, true);
      assert.strictEqual(
        result.aiReview.pairsNotJudged,
        3,
        'not one pair was answered'
      );
      assert.strictEqual(
        watch.requests().length,
        0,
        'an answer that never came is not a request done'
      );
      assert.strictEqual(
        result.groups.some((group) => group.aiVerdict?.verdict === 'unsure'),
        false
      );
      assert.strictEqual(
        result.groups.filter((group) => group.source === 'ai-candidate').length,
        0
      );
    });

    await test('The token budget stops the review itself', async () => {
      seedArchive();
      const watch = useControl({ tokenBudget: 100 });
      const { calls } = useProvider(answerFromTable());
      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      let result;
      try {
        result = await withBatchSize(1, () =>
          service.reviewScan(BAND_REVIEW, watch.control)
        );
      } finally {
        console.log = realLog;
      }

      assert.strictEqual(calls.length, 1, 'the first answer spent the budget');
      assert.deepStrictEqual(
        watch.stops,
        ['token-budget'],
        'the judge tells the job why it is stopping'
      );
      assert.strictEqual(result.aiReview.stopped, true);
      assert.strictEqual(result.aiReview.pairsNotJudged, 2);
      assert.ok(
        lines.some((line) =>
          /token budget 100 reached after 1 request\(s\) \(100 tokens\)\./.test(
            line
          )
        ),
        `no budget line:\n${lines.join('\n')}`
      );
      assert.ok(
        lines.some((line) =>
          /review stopped \(token-budget\): 1 of 3 request\(s\) made, 2 pair\(s\) not judged, 100 token\(s\)\./.test(
            line
          )
        ),
        `no stop line:\n${lines.join('\n')}`
      );
    });

    await test('A provider that reports no usage is measured instead', async () => {
      const calls = [];
      const provider = {
        client: {},
        lastGenerateTextUsage: null,
        async generateText(prompt, options) {
          calls.push({ prompt, options });
          return answerFromTable()(prompt);
        },
      };
      AIServiceFactory.getService = () => provider;

      seedArchive();
      const watch = useControl();
      const result = await withBatchSize(1, () =>
        service.reviewScan(BAND_REVIEW, watch.control)
      );

      const tokens = watch.requests().map((patch) => patch.tokens);
      assert.strictEqual(tokens.length, 3);
      assert.ok(
        tokens[0] > 0,
        `the page's counter never stays at null after a request: ${tokens[0]}`
      );
      assert.ok(
        tokens[0] < tokens[1] && tokens[1] < tokens[2],
        `and it keeps climbing: ${tokens.join(', ')}`
      );
      assert.strictEqual(
        result.aiReview.tokens,
        null,
        'what the provider did not report is not invented in the summary'
      );

      // The same provider against a budget: the estimate is what brakes it.
      seedArchive();
      calls.length = 0;
      const braked = useControl({ tokenBudget: 1 });
      const stopped = await withBatchSize(1, () =>
        service.reviewScan(BAND_REVIEW, braked.control)
      );
      assert.strictEqual(
        calls.length,
        1,
        'the budget bites without a usage report'
      );
      assert.deepStrictEqual(braked.stops, ['token-budget']);
      assert.strictEqual(stopped.aiReview.stopped, true);
    });

    await test('A signal that is already aborted costs nothing at all', async () => {
      seedArchive();
      const watch = useControl();
      watch.abort('user');
      const { calls } = useProvider(answerFromTable());

      const result = await service.reviewScan(BAND_REVIEW, watch.control);

      assert.strictEqual(calls.length, 0, 'not one request');
      assert.strictEqual(result.aiReview.requests, 0);
      assert.strictEqual(result.aiReview.stopped, true);
      assert.strictEqual(
        result.aiReview.candidates,
        0,
        'the band was not even read'
      );
      const scanGroup = result.groups.find((group) => group.source === 'scan');
      assert.deepStrictEqual(
        scanGroup.aiVerdict,
        ruleVerdict('exact-normalized', 'case-or-spacing'),
        'the scan and the verdicts a rule settled still come back'
      );
      assert.strictEqual(
        result.groups.filter((group) => group.source === 'ai-candidate').length,
        0
      );
    });

    await test('A review without a control is the review it always was', async () => {
      seedArchive();
      const { calls } = useProvider(answerFromTable());
      const result = await service.reviewScan(BAND_REVIEW);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(
        'signal' in calls[0].options,
        false,
        'nothing can stop it, so nothing is sent to stop'
      );
      assert.strictEqual(result.aiReview.stopped, false);
      assert.strictEqual(result.aiReview.stopReason, null);
      assert.strictEqual(result.aiReview.pairsNotJudged, 0);

      // An empty control is the same thing: there is nobody to report to.
      seedArchive();
      const empty = await service.reviewScan(BAND_REVIEW, {});
      assert.strictEqual(empty.aiReview.stopped, false);
      assert.strictEqual(empty.aiReview.pairsNotJudged, 0);
    });

    await test('A report is what the judge knows, and nothing the job derives', async () => {
      seedArchive();
      const watch = useControl();
      useProvider(answerFromTable());
      await withBatchSize(1, () =>
        service.reviewScan(BAND_REVIEW, watch.control)
      );
      assert.ok(watch.patches.length >= 5);
      for (const patch of watch.patches) {
        assert.strictEqual(
          'elapsedMs' in patch,
          false,
          'the job measures the time, the judge does not'
        );
        assert.strictEqual('etaMs' in patch, false);
        assert.strictEqual('tokenBudget' in patch, false);
        assert.strictEqual(typeof patch.message, 'string');
        assert.notStrictEqual(patch.message, '');
      }
    });

    await test('Every provider hands the signal on, and sends nothing new without one', async () => {
      const stub = useProviderStubs();
      const controller = new AbortController();
      try {
        for (const provider of Object.values(stub.services)) {
          assert.strictEqual(
            await provider.generateText('hello', {
              signal: controller.signal,
            }),
            'answer'
          );
        }
        for (const name of ['openai', 'custom', 'azure']) {
          assert.strictEqual(
            stub.sentOptions[name]?.signal,
            controller.signal,
            `${name}: the SDK gets the signal in its request options`
          );
        }
        assert.strictEqual(stub.sentOptions.ollama.signal, controller.signal);
        assert.ok(
          stub.sentOptions.ollama.headers,
          'and axios keeps the headers it always sent'
        );

        for (const provider of Object.values(stub.services)) {
          assert.strictEqual(await provider.generateText('hello'), 'answer');
        }
        for (const name of ['openai', 'custom', 'azure']) {
          assert.strictEqual(
            stub.sentOptions[name],
            undefined,
            `${name}: no signal, no second argument`
          );
        }
        assert.strictEqual(
          'signal' in stub.sentOptions.ollama,
          false,
          'and no signal in the request config'
        );
      } finally {
        stub.restore();
      }
    });

    // ------------------------------------- measuring the model, and sizing

    /**
     * A provider that behaves the way a streaming one behaves: it reports
     * while it writes, it may think first, it reports its usage, and it can
     * be made to run out of room with the text it managed to write on the
     * error.
     */
    function useStreamingProvider(options = {}) {
      const {
        completionTokens = 600,
        thinkingTokens = 0,
        answerChunks = 2,
        truncateWhen = () => false,
        partialText = null,
        respond = null,
      } = options;
      const calls = [];
      service.resetCalibration();
      const provider = {
        client: {},
        lastGenerateTextUsage: null,
        async generateText(prompt, requestOptions) {
          const callNumber = calls.length + 1;
          calls.push({ prompt, options: requestOptions });
          const ids = idsInPrompt(prompt);
          const verdicts = ids.map((id) => ({
            id,
            verdict: 'same',
            reason: 'two spellings',
          }));
          const report = requestOptions?.onProgress;
          if (report && thinkingTokens > 0) {
            report({
              text: '',
              thinking: true,
              completionTokens: thinkingTokens,
              done: false,
            });
          }
          // The answer as it grows: `answerChunks` reports, each one carrying
          // the verdicts that have been written so far.
          for (let step = 1; step <= answerChunks && report; step += 1) {
            const written = Math.ceil((verdicts.length * step) / answerChunks);
            report({
              text: JSON.stringify(verdicts.slice(0, written)),
              thinking: false,
              completionTokens:
                thinkingTokens +
                Math.round(
                  ((completionTokens - thinkingTokens) * step) / answerChunks
                ),
              done: step === answerChunks,
            });
          }
          provider.lastGenerateTextUsage = {
            promptTokens: 100,
            completionTokens,
            totalTokens: 100 + completionTokens,
          };
          if (truncateWhen(callNumber, ids.length)) {
            const error = new Error('the answer hit a token limit');
            error.code = 'ai_response_truncated';
            if (partialText !== null) error.partialText = partialText(ids);
            throw error;
          }
          return respond ? respond(prompt, ids) : JSON.stringify(verdicts);
        },
      };
      AIServiceFactory.getService = () => provider;
      return { provider, calls };
    }

    /** Runs `fn` with a given DUPLICATES_AI_REQUEST_SECONDS. */
    function withRequestSecondsSync(seconds, fn) {
      const previous = config.duplicatesAiRequestSeconds;
      config.duplicatesAiRequestSeconds = seconds;
      try {
        return fn();
      } finally {
        config.duplicatesAiRequestSeconds = previous;
      }
    }

    /** Runs `fn` with the judge's thinking switch in a given position. */
    async function withThinking(on, fn) {
      const previous = config.duplicatesAiThinking;
      config.duplicatesAiThinking = on;
      try {
        return await fn();
      } finally {
        config.duplicatesAiThinking = previous;
      }
    }

    await test('Thinking is off on every request, and on when asked for', async () => {
      const pairs = tagPairs(2);
      const { calls } = useProvider(answerAll('same', 'two spellings'));
      await service.reviewPairs(pairs, { kind: 'tags' });
      // Without a sizer there is no review, and nothing to think about.
      assert.strictEqual(calls[0].options.reasoning, false);

      seedArchive();
      const review = useProvider(answerFromTable());
      await service.reviewScan(BAND_REVIEW);
      assert.ok(review.calls.length > 0);
      assert.ok(
        review.calls.every((call) => call.options.reasoning === false),
        'a judge does not think unless the operator asked it to'
      );

      seedArchive();
      const thinking = useProvider(answerFromTable());
      await withThinking(true, () => service.reviewScan(BAND_REVIEW));
      assert.ok(
        thinking.calls.every((call) => call.options.reasoning === true),
        'and it does when DUPLICATES_AI_THINKING says so'
      );
    });

    await test('The first request of an unmeasured review is a small warm-up', async () => {
      useFake({
        tags: Array.from({ length: 20 }, (_, index) => ({
          id: index + 1,
          name: index % 2 === 0 ? `Beleg ${index}` : `Belege ${index - 1}`,
        })),
        documents: [],
      });
      const { calls } = useStreamingProvider({ completionTokens: 600 });
      const watch = useControl();

      await service.reviewScan(
        { kind: 'tags', threshold: 0.85, withTitles: false },
        watch.control
      );

      assert.ok(calls.length >= 2, 'more pairs than one warm-up holds');
      assert.strictEqual(
        idsInPrompt(calls[0].prompt).length,
        service.WARMUP_PAIRS,
        'the first request asks about four pairs and no more'
      );
      assert.strictEqual(
        calls[0].options.maxTokens,
        Math.max(
          Number(config.responseTokens),
          service.TOKENS_PER_PAIR * service.WARMUP_PAIRS +
            service.TOKENS_OVERHEAD,
          service.WARMUP_MIN_CAP
        ),
        'with the warm-up cap, not the flat estimate'
      );
      const announced = watch.ofPhase('warming-up');
      assert.strictEqual(announced.length, 1);
      assert.strictEqual(announced[0].message, service.WARMUP_MESSAGE);
      assert.strictEqual(announced[0].calibrated, false);
      assert.strictEqual(announced[0].batchSize, service.WARMUP_PAIRS);
    });

    await test('A measured answer sizes the next request and its cap', () => {
      service.resetCalibration();
      const sizer = service._sizer();
      sizer.maxSize = 25;
      const changed = withRequestSecondsSync(30, () =>
        service._measure(
          { sizer },
          {
            pairs: 4,
            completionTokens: 600,
            elapsedMs: 20000,
            truncated: false,
            warmingUp: true,
          }
        )
      );

      assert.strictEqual(changed, true, 'the size changed with the answer');
      assert.strictEqual(sizer.tokensPerPair, 150, '600 tokens over 4 pairs');
      assert.strictEqual(sizer.tokensPerSecond, 30, '600 tokens in 20 seconds');
      assert.strictEqual(sizer.calibrated, true);
      assert.strictEqual(
        withRequestSecondsSync(30, () => service._sizeFor(sizer, 25)),
        6,
        'floor(30 s × 30 tokens/s ÷ 150 tokens per pair)'
      );
      assert.strictEqual(
        service._capFor(sizer, 6),
        Math.ceil(150 * 6 * 1.5) + service.TOKENS_OVERHEAD,
        'the cap carries half a verdict of headroom per pair'
      );
      assert.strictEqual(service._capFor(sizer, 6), 1550);
      assert.deepStrictEqual(
        {
          ...service.calibration.get('test-model'),
          measuredAt: null,
        },
        {
          tokensPerPair: 150,
          tokensPerSecond: 30,
          largestCompletion: 600,
          thinking: false,
          measuredAt: null,
        },
        'and it is remembered for the next review'
      );
      service.resetCalibration();
    });

    await test('The operator decides how long a request may take', () => {
      service.resetCalibration();
      const sizer = service._sizer();
      sizer.tokensPerPair = 150;
      sizer.tokensPerSecond = 30;
      assert.strictEqual(
        withRequestSecondsSync(60, () => service._sizeFor(sizer, 25)),
        12,
        'twice the seconds, twice the pairs'
      );
      assert.strictEqual(
        withRequestSecondsSync(1, () => service._sizeFor(sizer, 25)),
        1,
        'and never less than one pair, however impatient the setting'
      );
      assert.strictEqual(
        withRequestSecondsSync(1, () => service.requestSeconds()),
        5,
        'a request shorter than five seconds is not worth the round trip'
      );
      assert.strictEqual(
        withRequestSecondsSync(0, () => service.requestSeconds()),
        30,
        'and an unset value is the default'
      );
    });

    await test('A second measurement is smoothed against the first', () => {
      service.resetCalibration();
      const sizer = service._sizer();
      sizer.maxSize = 25;
      const measure = (completionTokens, elapsedMs, pairs) =>
        service._measure(
          { sizer },
          {
            pairs,
            completionTokens,
            elapsedMs,
            truncated: false,
            warmingUp: false,
          }
        );
      measure(600, 20000, 4);
      assert.strictEqual(sizer.tokensPerPair, 150);
      assert.strictEqual(sizer.tokensPerSecond, 30);
      // Half the fresh number, half the one before it.
      measure(500, 10000, 5);
      assert.strictEqual(sizer.tokensPerPair, 125, '(150 + 100) / 2');
      assert.strictEqual(sizer.tokensPerSecond, 40, '(30 + 50) / 2');
      assert.strictEqual(sizer.measurements, 2);
      service.resetCalibration();
    });

    await test('The context window bounds the measured size and cap', () => {
      service.resetCalibration();
      const sizer = service._sizer();
      sizer.tokensPerPair = 150;
      sizer.tokensPerSecond = 30;
      assert.strictEqual(
        withRequestSecondsSync(30, () => service._sizeFor(sizer, 3)),
        3,
        'the measurement affords six pairs, the window allows three'
      );
      const previous = process.env.TOKEN_LIMIT;
      process.env.TOKEN_LIMIT = '4000';
      try {
        const budget = service._capForRequest(sizer, 6, 3000);
        assert.strictEqual(
          budget.bound,
          4000 - 3000 - service.TOKENS_CONTEXT_MARGIN,
          'prompt + cap + margin fit into the window'
        );
        assert.strictEqual(budget.cap, budget.bound);
        assert.strictEqual(
          budget.atBound,
          true,
          'so there is no more room to give this request'
        );
        const roomy = service._capForRequest(sizer, 6, 200);
        assert.strictEqual(roomy.cap, service._capFor(sizer, 6));
        assert.strictEqual(roomy.atBound, false);
      } finally {
        if (previous === undefined) delete process.env.TOKEN_LIMIT;
        else process.env.TOKEN_LIMIT = previous;
      }
      service.resetCalibration();
    });

    await test('The warm-up settles the plan and the estimate', async () => {
      useFake({
        tags: Array.from({ length: 20 }, (_, index) => ({
          id: index + 1,
          name: index % 2 === 0 ? `Beleg ${index}` : `Belege ${index - 1}`,
        })),
        documents: [],
      });
      const { calls } = useStreamingProvider({ completionTokens: 600 });
      const watch = useControl();

      await service.reviewScan(
        { kind: 'tags', threshold: 0.85, withTitles: false },
        watch.control
      );

      const answered = watch.requests();
      assert.ok(answered.length >= 2);
      assert.strictEqual(
        answered[0].calibrated,
        true,
        'the first answer is a measurement'
      );
      assert.strictEqual(answered[0].phase, 'judging');
      assert.ok(
        answered[0].batchSize >= 1,
        'and it names the size of the requests that follow'
      );
      const left = answered[0].pairsTotal - service.WARMUP_PAIRS;
      const second = idsInPrompt(calls[1].prompt).length;
      assert.strictEqual(
        second,
        Math.min(answered[0].batchSize, left),
        'which is the size the next request really has, or what is left'
      );
      assert.strictEqual(
        calls[1].options.maxTokens,
        Math.ceil(150 * second * service.CAP_SAFETY_FACTOR) +
          service.TOKENS_OVERHEAD,
        'with the cap the measurement asks for'
      );
      assert.strictEqual(
        answered[0].requestsPlanned,
        answered[0].requestsDone +
          Math.ceil(
            (answered[0].pairsTotal - service.WARMUP_PAIRS) /
              answered[0].batchSize
          ),
        'the denominator is re-derived from what the model turned out to cost'
      );
      assert.ok(
        answered[0].estimatedTokens > 0,
        'and so is the estimate of what the rest will cost'
      );
    });

    await test('A calibration is reused by the next review and skips the warm-up', async () => {
      seedArchive();
      const first = useStreamingProvider({ completionTokens: 600 });
      await withBatchSize(2, () => service.reviewScan(BAND_REVIEW));
      assert.strictEqual(
        idsInPrompt(first.calls[0].prompt).length,
        2,
        'the warm-up is bounded by the batch size as well'
      );
      const measured = service.calibration.get('test-model');
      assert.ok(measured, 'the review left a measurement behind');
      assert.strictEqual(measured.thinking, false);

      // A second review of the same model: no warm-up, sized from memory.
      seedArchive();
      const calls = [];
      const provider = {
        client: {},
        lastGenerateTextUsage: { completionTokens: 600, totalTokens: 700 },
        async generateText(prompt) {
          calls.push(prompt);
          return JSON.stringify(
            idsInPrompt(prompt).map((id) => ({
              id,
              verdict: 'same',
              reason: 'two spellings',
            }))
          );
        },
      };
      AIServiceFactory.getService = () => provider;
      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      const watch = useControl();
      try {
        await withBatchSize(3, () =>
          service.reviewScan(BAND_REVIEW, watch.control)
        );
      } finally {
        console.log = realLog;
      }

      assert.strictEqual(watch.ofPhase('warming-up').length, 0, 'no warm-up');
      assert.strictEqual(watch.ofPhase('judging').length, 1);
      assert.strictEqual(watch.ofPhase('judging')[0].calibrated, true);
      assert.strictEqual(calls.length, 1, 'all three pairs in one request');
      assert.ok(
        lines.some((line) =>
          /calibrated from a previous review: \d+ tokens per pair, \d+ tokens\/s, thinking off\./.test(
            line
          )
        ),
        `no calibration line:\n${lines.join('\n')}`
      );
      service.resetCalibration();
    });

    await test('A measurement taken with thinking on is not reused with it off', async () => {
      service.resetCalibration();
      await withThinking(true, async () => {
        seedArchive();
        useStreamingProvider({ completionTokens: 600 });
        await withBatchSize(2, () => service.reviewScan(BAND_REVIEW));
      });
      const stored = service.calibration.get('test-model');
      assert.strictEqual(stored.thinking, true);

      // The same model, the other switch: the measurement says nothing.
      seedArchive();
      const { calls } = useStreamingProvider({ completionTokens: 600 });
      const watch = useControl();
      await withBatchSize(3, () =>
        service.reviewScan(BAND_REVIEW, watch.control)
      );
      assert.strictEqual(
        watch.ofPhase('warming-up').length,
        1,
        'so the review measures again'
      );
      assert.strictEqual(
        idsInPrompt(calls[0].prompt).length,
        3,
        'a warm-up, bounded by the batch size of this review'
      );
      assert.strictEqual(
        service.calibration.get('test-model').thinking,
        false,
        'and what it measured replaces what was stored'
      );
      service.resetCalibration();
    });

    await test('resetCalibration makes the next review measure again', async () => {
      seedArchive();
      useStreamingProvider({ completionTokens: 600 });
      await withBatchSize(2, () => service.reviewScan(BAND_REVIEW));
      assert.strictEqual(service.calibration.size, 1);
      service.resetCalibration();
      assert.strictEqual(service.calibration.size, 0);

      seedArchive();
      useStreamingProvider({ completionTokens: 600 });
      const watch = useControl();
      await withBatchSize(3, () =>
        service.reviewScan(BAND_REVIEW, watch.control)
      );
      assert.strictEqual(watch.ofPhase('warming-up').length, 1);
    });

    await test('A warm-up that does not fit ends the review with something to do', async () => {
      seedArchive();
      const { calls } = useStreamingProvider({
        completionTokens: 3200,
        truncateWhen: () => true,
        partialText: () => '[',
      });

      await assert.rejects(
        () => withBatchSize(3, () => service.reviewScan(BAND_REVIEW)),
        (error) => {
          assert.strictEqual(error.status, 409);
          assert.match(
            error.message,
            /do not fit the token limit even for 3 pair\(s\)/
          );
          assert.match(error.message, /DUPLICATES_AI_THINKING/);
          assert.match(error.message, /TOKEN_LIMIT/);
          return true;
        }
      );
      assert.strictEqual(
        calls.length,
        2,
        'once, once with the whole window, and then it says so'
      );
      assert.strictEqual(
        calls[1].options.maxTokens > calls[0].options.maxTokens,
        true,
        'the second attempt had everything the window could give'
      );
      service.resetCalibration();
    });

    await test('The text a cut-off request wrote is salvaged and counted', async () => {
      seedArchive();
      const watch = useControl();
      const { calls } = useStreamingProvider({
        completionTokens: 900,
        truncateWhen: (callNumber) => callNumber === 1,
        // Two of the three verdicts arrived before the model ran out of room.
        partialText: (ids) =>
          '[' +
          ids
            .slice(0, 2)
            .map((id) =>
              JSON.stringify({ id, verdict: 'same', reason: 'two spellings' })
            )
            .join(',') +
          `,{"id":"${ids[2]}","verd`,
      });

      const result = await withCalibration({}, () =>
        withBatchSize(3, () => service.reviewScan(BAND_REVIEW, watch.control))
      );

      assert.deepStrictEqual(
        calls.map((call) => idsInPrompt(call.prompt).length),
        [3, 1],
        'what was salvaged is not asked again; only the missing pair is'
      );
      const answered = watch.requests();
      assert.deepStrictEqual(
        answered.map((patch) => patch.pairsJudged),
        [2, 3],
        'the two salvaged verdicts count as judged in their own report'
      );
      assert.strictEqual(result.aiReview.pairsNotJudged, 0);
      assert.strictEqual(
        result.aiReview.failedRequests,
        0,
        'a salvaged truncation is not a failure'
      );
      assert.strictEqual(result.aiReview.retries, 1);
    });

    await test('A streamed request reports thinking, answers, and clears itself', async () => {
      seedArchive();
      const previousInterval = service.progressIntervalMs;
      service.progressIntervalMs = 0;
      const watch = useControl();
      const { calls } = useStreamingProvider({
        completionTokens: 900,
        thinkingTokens: 640,
        answerChunks: 3,
      });
      try {
        await withCalibration({}, () =>
          withBatchSize(3, () => service.reviewScan(BAND_REVIEW, watch.control))
        );
      } finally {
        service.progressIntervalMs = previousInterval;
      }

      assert.strictEqual(calls.length, 1, 'three pairs in one request');
      assert.strictEqual(
        typeof calls[0].options.onProgress,
        'function',
        'a watched review asks the provider to stream'
      );
      const streams = watch.streams();
      assert.strictEqual(streams.length, 4, 'one thinking report, three more');
      assert.deepStrictEqual(
        streams.map((patch) => patch.thinking),
        [true, false, false, false]
      );
      assert.strictEqual(
        streams[0].message,
        'The model is thinking… (640 tokens so far)'
      );
      assert.strictEqual(streams[0].requestTokens, 640);
      assert.strictEqual(streams[0].requestAnswers, 0);
      assert.deepStrictEqual(
        streams.slice(1).map((patch) => patch.requestAnswers),
        [1, 2, 3],
        'the verdicts that have fully arrived, counted off the text'
      );
      assert.deepStrictEqual(
        streams.map((patch) => patch.requestPairs),
        [3, 3, 3, 3]
      );
      assert.strictEqual(
        streams[3].message,
        'Asking the model, request 1 of 1 · 3 of 3 answers'
      );
      assert.strictEqual(
        streams[3].tokens,
        900,
        'the review total plus what this request has produced'
      );

      const answered = watch.requests();
      assert.strictEqual(answered.length, 1);
      assert.strictEqual(answered[0].requestPairs, null);
      assert.strictEqual(answered[0].requestAnswers, 0);
      assert.strictEqual(answered[0].requestTokens, null);
      assert.strictEqual(answered[0].thinking, false);
      assert.strictEqual(
        answered[0].tokens,
        1000,
        'and the provider’s own number replaces the running one'
      );
    });

    await test('An unwatched review does not ask the provider to stream', async () => {
      seedArchive();
      const { calls } = useStreamingProvider({ completionTokens: 600 });
      await withBatchSize(3, () => service.reviewScan(BAND_REVIEW));
      assert.ok(calls.length > 0);
      assert.ok(
        calls.every((call) => call.options.onProgress === undefined),
        'with nobody to report to, the plain request says the same thing'
      );
      service.resetCalibration();
    });

    await test('A review reuses the scan the page just made', async () => {
      const fake = seedArchive();
      const scanCalls = () =>
        fake.calls.filter((call) => call.path === '/correspondents/').length;

      // What the page does when the user presses Scan.
      await duplicateMergeService.scan({ ...BAND_REVIEW, fresh: true });
      const afterPage = scanCalls();
      assert.ok(afterPage > 0, 'the page read the correspondents');

      useStreamingProvider({ completionTokens: 600 });
      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      try {
        await withBatchSize(3, () => service.reviewScan(BAND_REVIEW));
      } finally {
        console.log = realLog;
      }

      assert.ok(
        lines.some((line) => /scan served from cache \(age \d+s\)/.test(line)),
        `the review scanned again:\n${lines.join('\n')}`
      );
      assert.strictEqual(
        lines.some((line) => /scan started/.test(line)),
        false,
        'and said so instead of the start and finish lines'
      );
      service.resetCalibration();
    });

    await test('The cap never drops below the largest answer seen, so a small batch after a thinking one is not starved', async () => {
      // A thinking model pays a fixed price per request: 737 tokens for four
      // pairs is 184 per pair, and a one-pair request sized by pairs alone
      // (184 × 1.5 + 200 = 476) is cut off by the same 600 tokens of thought.
      service.resetCalibration();
      const sizer = service._sizer();
      const context = { sizer };
      service._measure(context, {
        completionTokens: 737,
        elapsedMs: 3768,
        pairs: 4,
        warmingUp: true,
      });
      assert.strictEqual(sizer.largestCompletion, 737);
      const floor = Math.ceil(737 * service.CAP_FLOOR_FACTOR);
      assert.strictEqual(
        service._capFor(sizer, 1),
        floor,
        'the floor wins for one pair'
      );
      assert.ok(
        service._capFor(sizer, 20) > floor,
        'a big batch is still sized by its pairs'
      );
      const remembered = service.calibration.get(sizer.model);
      assert.strictEqual(
        remembered.largestCompletion,
        737,
        'and the floor is remembered'
      );
      const next = service._sizer();
      assert.strictEqual(
        next.largestCompletion,
        737,
        'a later review starts with it'
      );
      service.resetCalibration();
    });

    // ------------------------------------------ the semantic sweep (round 9)

    /**
     * The user prompt of a sweep request. The judge's says "Pairs:", the
     * sweep's says "Names:", and nothing else in a prompt looks like either.
     */
    function isSweepPrompt(prompt) {
      return /^Names: \d+$/m.test(String(prompt));
    }

    /** The ids and names one sweep request carried, in order. */
    function namesInPrompt(prompt) {
      return [
        ...String(prompt).matchAll(/\{"id":"(\d+)","name":"([^"]*)"\}/g),
      ].map((hit) => ({ id: Number(hit[1]), name: hit[2] }));
    }

    /** The error every provider raises when it runs out of room. */
    function truncation(partialText) {
      const error = new Error('the answer hit a token limit');
      error.code = 'ai_response_truncated';
      if (partialText != null) error.partialText = partialText;
      return error;
    }

    /**
     * A provider that answers both questions of a swept review: `groups`
     * answers a sweep request (an array, a string, or an Error to throw),
     * `verdict` answers every judged pair.
     */
    function useSweepProvider({
      groups = () => [],
      verdict = () => 'same',
      reason = 'one thing in two languages',
    } = {}) {
      const sweeps = [];
      const judged = [];
      service.resetCalibration();
      const provider = {
        client: {},
        lastGenerateTextUsage: null,
        async generateText(prompt, options) {
          provider.lastGenerateTextUsage = { totalTokens: 100 };
          if (isSweepPrompt(prompt)) {
            sweeps.push({ prompt, options });
            const answer = await groups(
              namesInPrompt(prompt),
              sweeps.length,
              options
            );
            if (answer instanceof Error) throw answer;
            return typeof answer === 'string' ? answer : JSON.stringify(answer);
          }
          judged.push({ prompt, options });
          return JSON.stringify(
            idsInPrompt(prompt).map((id) => ({
              id,
              verdict: verdict(id),
              reason,
            }))
          );
        },
      };
      AIServiceFactory.getService = () => provider;
      return { provider, sweeps, judged };
    }

    /** Runs `fn` with a given DUPLICATES_AI_SWEEP_NAMES. */
    async function withSweepNames(names, fn) {
      const previous = config.duplicatesAiSweepNames;
      config.duplicatesAiSweepNames = names;
      try {
        return await fn();
      } finally {
        config.duplicatesAiSweepNames = previous;
      }
    }

    /** Runs `fn` with console.log captured, and returns the lines. */
    async function withLoggedLines(fn) {
      const lines = [];
      const realLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      try {
        await fn();
      } finally {
        console.log = realLog;
      }
      return lines;
    }

    /**
     * Six tags no string matcher will ever link: two pairs that are one thing
     * in two languages, and two names that are merely related. Every tag
     * carries a document with content, because a pair the sweep proposed is
     * judged on the documents.
     */
    function seedSemantic() {
      return useFake({
        tags: [
          { id: 1, name: 'Rechnung' },
          { id: 2, name: 'Invoice' },
          { id: 3, name: 'Kontoauszug' },
          { id: 4, name: 'Bank statement' },
          { id: 5, name: 'Auto' },
          { id: 6, name: 'Versicherung' },
        ],
        correspondents: [{ id: 20, name: 'Sparkasse Koeln' }],
        documents: [
          {
            id: 100,
            title: 'Rechnung 2025-04',
            tags: [1],
            correspondent: 20,
            content: 'Rechnung Nr. 4711 Betrag 120,00 EUR zahlbar bis',
          },
          {
            id: 101,
            title: 'Invoice 2025-05',
            tags: [2],
            correspondent: 20,
            content: 'Invoice No. 4712 amount due 120.00 EUR payable by',
          },
          {
            id: 102,
            title: 'Kontoauszug 03/2025',
            tags: [3],
            correspondent: 20,
            content: 'Kontoauszug Nr. 3 Saldo neuer Kontostand 980,12 EUR',
          },
          {
            id: 103,
            title: 'Bank statement 04/2025',
            tags: [4],
            correspondent: 20,
            content: 'Bank statement No. 4 closing balance 1,450.00 EUR',
          },
          {
            id: 104,
            title: 'Fahrzeugschein',
            tags: [5],
            correspondent: 20,
            content: 'Zulassungsbescheinigung Teil I Fahrzeug',
          },
          {
            id: 105,
            title: 'Haftpflicht',
            tags: [6],
            correspondent: 20,
            content: 'Versicherungsschein Haftpflicht Jahresbeitrag',
          },
        ],
      });
    }

    /** The review every sweep case runs, over the six tags above. */
    const SWEEP_REVIEW = {
      kind: 'tags',
      threshold: 0.95,
      semanticSweep: true,
    };

    /** Answers one sweep request with the two translation pairs. */
    const TWO_TRANSLATIONS = () => [
      { ids: ['1', '2'], basis: 'translation', reason: 'German and English' },
      {
        ids: ['3', '4'],
        basis: 'translation',
        reason: 'the same bank document',
      },
    ];

    await test('The fixture of the sweep is invisible to the string matcher', async () => {
      seedSemantic();
      const scan = await duplicateMergeService.scan({
        kind: 'tags',
        threshold: 0.95,
        fresh: true,
      });
      assert.deepStrictEqual(scan.groups, [], 'no group is found by spelling');
      const entities = await paperlessService.listEntities('tags');
      assert.deepStrictEqual(
        matcher.findCandidatePairs(entities, {
          kind: 'tags',
          floor: service.candidateFloor(),
          threshold: 0.95,
          limit: 100,
        }),
        [],
        'and nothing lands in the band either'
      );
    });

    await test('The sweep shows the model names only, in chunks of the setting', async () => {
      const entities = [];
      for (let index = 1; index <= 120; index += 1) {
        entities.push(entity(index, `Name ${index}`, index));
      }
      const calls = [];
      const provider = {
        client: {},
        lastGenerateTextUsage: { totalTokens: 50 },
        async generateText(prompt, options) {
          calls.push({ prompt, options });
          return '[]';
        },
      };

      await withSweepNames(50, () =>
        service._sweepKind('tags', entities, {
          known: new Set(),
          dismissed: new Set(),
          service: provider,
          tracker: null,
          sizer: null,
        })
      );

      assert.deepStrictEqual(
        calls.map((call) => namesInPrompt(call.prompt).length),
        [50, 50, 20],
        'one request per chunk of the setting'
      );
      assert.deepStrictEqual(namesInPrompt(calls[0].prompt)[0], {
        id: 1,
        name: 'Name 1',
      });
      assert.match(calls[0].prompt, /^Kind: tags\nNames: 50\n\[/);
      assert.strictEqual(
        /"documents"|"titles"|"excerpts"|Pairs:/.test(calls[0].prompt),
        false,
        'a sweep carries ids and names and nothing else'
      );
      const system = calls[0].options.systemPrompt;
      assert.match(system, /"ids": \["<id>", "<id>"\]/);
      assert.match(system, /"translation" \| "synonym" \| "abbreviation"/);
      assert.match(system, /nothing that is merely related/);
      assert.match(system, /nothing that differs only in how it is written/);
      assert.strictEqual(calls[0].options.temperature, 0);
      assert.strictEqual(calls[0].options.reasoning, false);
      assert.ok(calls[0].options.maxTokens > 0);
    });

    await test('The sweep never reads fewer than fifty names per request', async () => {
      await withSweepNames(10, () => {
        assert.strictEqual(service.sweepNames(), service.MIN_SWEEP_NAMES);
      });
      await withSweepNames(300, () => {
        assert.strictEqual(service.sweepNames(), 300);
      });
    });

    await test('A kind with more names than a sweep reads is skipped, and says why', async () => {
      const entities = [];
      for (let index = 1; index <= service.SWEEP_MAX_NAMES + 1; index += 1) {
        entities.push(entity(index, `Name ${index}`, 0));
      }
      const provider = {
        client: {},
        async generateText() {
          throw new Error('the sweep must not ask about an archive this large');
        },
      };
      let swept = null;
      const lines = await withLoggedLines(async () => {
        swept = await service._sweepKind('tags', entities, {
          known: new Set(),
          dismissed: new Set(),
          service: provider,
          tracker: null,
          sizer: null,
        });
      });
      assert.deepStrictEqual(swept.pairs, []);
      assert.strictEqual(swept.usage.requests, 0);
      assert.ok(
        lines.some((line) =>
          new RegExp(
            `sweep: tags, 5001 names is more than the ${service.SWEEP_MAX_NAMES}`
          ).test(line)
        ),
        `no skip line:\n${lines.join('\n')}`
      );
    });

    await test('A proposal becomes a pair the judge sees with the sweep’s own hint', async () => {
      seedSemantic();
      const { sweeps, judged } = useSweepProvider({
        groups: TWO_TRANSLATIONS,
      });

      const result = await service.reviewScan(SWEEP_REVIEW);

      assert.strictEqual(sweeps.length, 1, 'six names are one sweep request');
      assert.strictEqual(judged.length, 1, 'and two proposals one request');
      assert.deepStrictEqual(idsInPrompt(judged[0].prompt).sort(), [
        'tags:1-2',
        'tags:3-4',
      ]);
      assert.match(judged[0].prompt, /"matched_by":"semantic","score":0\.5/);
      assert.match(
        judged[0].prompt,
        /"sweep_basis":"translation","sweep_reason":"German and English"/
      );
      assert.match(
        judged[0].options.systemPrompt,
        /"matched_by":"semantic" is a pair nothing in the spelling links/,
        'and the judge is told what such a pair is'
      );
      assert.strictEqual(result.aiReview.sweepRequests, 1);
      assert.strictEqual(result.aiReview.sweepProposals, 2);
      assert.strictEqual(result.aiReview.judged, 2);
      assert.strictEqual(
        result.aiReview.candidates,
        0,
        'the band is empty here; the pairs of the sweep are counted on their own'
      );
      assert.strictEqual(
        result.aiReview.requests,
        2,
        'the sweep and the judge'
      );
    });

    await test('A same verdict on a proposal builds a semantic group at fifty per cent', async () => {
      seedSemantic();
      useSweepProvider({ groups: TWO_TRANSLATIONS });

      const result = await service.reviewScan(SWEEP_REVIEW);

      assert.strictEqual(result.groups.length, 2);
      const [first] = result.groups;
      assert.strictEqual(first.source, 'ai-candidate');
      assert.deepStrictEqual(first.reasons, ['semantic']);
      assert.strictEqual(first.confidence, service.SEMANTIC_SCORE);
      assert.deepStrictEqual(
        result.groups
          .flatMap((group) => group.members.map((member) => member.id))
          .sort((x, y) => x - y),
        [1, 2, 3, 4]
      );
      assert.deepStrictEqual(
        first.aiVerdict,
        verdict('same', 'one thing in two languages')
      );
      const member = first.members.find(
        (one) => one.id !== first.suggestedTargetId
      );
      assert.strictEqual(member.scoreToTarget, service.SEMANTIC_SCORE);
      assert.strictEqual(member.reason, 'semantic');
    });

    await test('A proposal the model then calls different becomes no group', async () => {
      seedSemantic();
      const { judged } = useSweepProvider({
        groups: () => [
          { ids: ['5', '6'], basis: 'synonym', reason: 'both about the car' },
        ],
        verdict: () => 'different',
        reason: 'a car is not an insurance',
      });

      const result = await service.reviewScan(SWEEP_REVIEW);

      assert.strictEqual(judged.length, 1, 'the proposal was judged');
      assert.deepStrictEqual(result.groups, [], 'and it did not survive it');
      assert.strictEqual(result.aiReview.sweepProposals, 1);
    });

    await test('A pair in a group, in the band or dismissed is not proposed again', async () => {
      seedArchive();
      await documentModel.addEntityMergeDismissals('correspondents', [
        {
          idA: 7,
          idB: 8,
          nameA: 'Stadtwerke Muenchen Energie',
          nameB: 'Energie Stadtwerke Muenchen Nord',
        },
      ]);
      const { sweeps, judged } = useSweepProvider({
        groups: () => [
          { ids: ['1', '2'], basis: 'synonym', reason: 'already one group' },
          { ids: ['3', '4'], basis: 'synonym', reason: 'already a candidate' },
          { ids: ['7', '8'], basis: 'synonym', reason: 'already dismissed' },
          { ids: ['5', '7'], basis: 'synonym', reason: 'this one is new' },
        ],
        verdict: (id) => (id === 'correspondents:5-7' ? 'unsure' : 'same'),
      });

      const result = await service.reviewScan({
        kind: 'correspondents',
        threshold: 0.95,
        semanticSweep: true,
      });

      assert.strictEqual(sweeps.length, 1);
      assert.strictEqual(
        result.aiReview.sweepProposals,
        1,
        'three of the four proposals were already known'
      );
      const asked = judged.flatMap((call) => idsInPrompt(call.prompt));
      assert.ok(
        asked.includes('correspondents:5-7'),
        'and the one new pair is judged'
      );
      assert.strictEqual(
        asked.filter((id) => id === 'correspondents:3-4').length,
        1,
        'the band pair is asked once, as the band pair it already was'
      );
      assert.strictEqual(asked.includes('correspondents:7-8'), false);
      assert.strictEqual(asked.includes('correspondents:1-2'), false);
    });

    await test('A pair the sweep proposed always carries document excerpts', async () => {
      seedSemantic();
      const { judged } = useSweepProvider({ groups: TWO_TRANSLATIONS });

      const result = await service.reviewScan(SWEEP_REVIEW);

      assert.match(judged[0].prompt, /"excerpts":\["Rechnung Nr\. 4711/);
      assert.match(judged[0].prompt, /"excerpts":\["Invoice No\. 4712/);
      assert.strictEqual(
        result.aiReview.excerpts,
        4,
        'one read per entity of the two proposals'
      );
    });

    await test('The sweep counts its requests and its pairs, and says so in one line', async () => {
      seedSemantic();
      useSweepProvider({ groups: TWO_TRANSLATIONS });
      let result = null;
      const lines = await withLoggedLines(async () => {
        result = await service.reviewScan(SWEEP_REVIEW);
      });

      assert.strictEqual(result.aiReview.sweepRequests, 1);
      assert.strictEqual(result.aiReview.sweepProposals, 2);
      assert.ok(
        lines.some((line) =>
          /sweep: tags, 6 names in 1 request\(s\), 2 group\(s\) proposed, 2 new pair\(s\) to judge\./.test(
            line
          )
        ),
        `no sweep line:\n${lines.join('\n')}`
      );
      assert.strictEqual(
        lines.some((line) => /Rechnung 2025-04/.test(line)),
        false,
        'and no document title ever reaches the log'
      );
    });

    await test('Without the option nothing of the sweep runs', async () => {
      seedSemantic();
      const { sweeps, judged } = useSweepProvider({
        groups: TWO_TRANSLATIONS,
      });

      const result = await service.reviewScan({
        kind: 'tags',
        threshold: 0.95,
      });

      assert.strictEqual(sweeps.length, 0, 'no sweep request');
      assert.strictEqual(judged.length, 0, 'and nothing to judge');
      assert.strictEqual(result.aiReview.sweepRequests, 0);
      assert.strictEqual(result.aiReview.sweepProposals, 0);
      assert.deepStrictEqual(result.groups, []);

      const off = await service.reviewScan({
        ...SWEEP_REVIEW,
        semanticSweep: false,
      });
      assert.strictEqual(off.aiReview.sweepRequests, 0, 'and false is off');
    });

    await test('The sweep is asked for by a checkbox, so its string counts too', async () => {
      seedSemantic();
      const { sweeps } = useSweepProvider({ groups: TWO_TRANSLATIONS });

      const result = await service.reviewScan({
        ...SWEEP_REVIEW,
        semanticSweep: 'true',
      });

      assert.strictEqual(sweeps.length, 1, 'a checked box is a checked box');
      assert.strictEqual(result.aiReview.sweepProposals, 2);
    });

    await test('The sweep reports its own phase and is in the plan before it asks', async () => {
      seedSemantic();
      const watch = useControl();
      let plannedAtFirstSweep = null;
      const { sweeps } = useSweepProvider({
        groups: (names, callNumber, options) => {
          if (callNumber === 1) {
            plannedAtFirstSweep = watch.patches
              .filter((patch) => patch.requestsPlanned != null)
              .map((patch) => patch.requestsPlanned);
            // What the provider reports while it writes the answer.
            options.onProgress({
              text: '',
              thinking: true,
              completionTokens: 64,
              done: false,
            });
          }
          return TWO_TRANSLATIONS();
        },
      });

      await service.reviewScan(SWEEP_REVIEW, watch.control);

      assert.strictEqual(
        typeof sweeps[0].options.onProgress,
        'function',
        'a watched sweep asks the provider to stream'
      );
      assert.ok(sweeps[0].options.signal, 'and can be stopped mid-request');
      const streamed = watch.streams();
      assert.strictEqual(streamed.length, 1, 'the one report it was given');
      assert.strictEqual(streamed[0].thinking, true);
      assert.strictEqual(streamed[0].requestTokens, 64);
      assert.strictEqual(
        streamed[0].message,
        'The model is thinking… (64 tokens so far)'
      );
      const sweeping = watch.ofPhase('sweeping');
      assert.ok(sweeping.length >= 2, 'the announcement and the answer');
      assert.strictEqual(sweeping[0].kind, 'tags');
      assert.strictEqual(
        sweeping[0].message,
        'Asking the model for synonyms and translations among 6 tag names…'
      );
      assert.deepStrictEqual(
        plannedAtFirstSweep,
        [1],
        'the one sweep request was in the plan before it was made'
      );
      const answered = sweeping.filter((patch) => patch.requestsDone === 1);
      assert.strictEqual(answered.length, 1, 'and the answer counts a request');
      assert.strictEqual(answered[0].tokens, 100);
      assert.strictEqual(
        answered[0].message,
        'The sweep is done, gathering the evidence…',
        'the judging requests of this kind are not in the plan yet'
      );
    });

    await test('A cut-off sweep answer keeps the groups the model managed to write', async () => {
      seedSemantic();
      const { sweeps, judged } = useSweepProvider({
        groups: () =>
          truncation(
            '[{"ids":["1","2"],"basis":"translation","reason":"German and English"},' +
              '{"ids":["3","4"],"basis":"trans'
          ),
      });

      const result = await service.reviewScan(SWEEP_REVIEW);

      assert.strictEqual(sweeps.length, 1, 'a salvaged answer is not re-asked');
      assert.strictEqual(result.aiReview.sweepProposals, 1);
      assert.deepStrictEqual(idsInPrompt(judged[0].prompt), ['tags:1-2']);
      assert.strictEqual(result.aiReview.failedRequests, 0);
    });

    await test('A sweep answer that salvaged nothing is asked once more with a raised cap', async () => {
      seedSemantic();
      const { sweeps } = useSweepProvider({
        groups: (names, callNumber) =>
          callNumber === 1 ? truncation('[') : TWO_TRANSLATIONS(),
      });

      const result = await service.reviewScan(SWEEP_REVIEW);

      assert.strictEqual(sweeps.length, 2, 'the same names, once more');
      assert.ok(
        sweeps[1].options.maxTokens > sweeps[0].options.maxTokens,
        'with more room to answer in'
      );
      assert.strictEqual(result.aiReview.sweepRequests, 2);
      assert.strictEqual(result.aiReview.sweepProposals, 2);
    });

    await test('A sweep that answers nothing usable costs its own request and no more', async () => {
      seedSemantic();
      const warnings = [];
      const realWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));
      let result;
      try {
        useSweepProvider({ groups: () => 'I would rather not.' });
        result = await service.reviewScan(SWEEP_REVIEW);
      } finally {
        console.warn = realWarn;
      }

      assert.strictEqual(result.aiReview.sweepRequests, 1);
      assert.strictEqual(result.aiReview.sweepProposals, 0);
      assert.strictEqual(result.aiReview.failedRequests, 1);
      assert.deepStrictEqual(result.groups, []);
      assert.ok(
        warnings.some((line) => /sweep tags: .* — failed:/.test(line)),
        `no warning:\n${warnings.join('\n')}`
      );
    });

    await test('The token budget stops a review inside its sweep', async () => {
      seedSemantic();
      const watch = useControl({ tokenBudget: 50 });
      const { sweeps, judged } = useSweepProvider({
        groups: TWO_TRANSLATIONS,
      });

      const result = await service.reviewScan(SWEEP_REVIEW, watch.control);

      assert.strictEqual(sweeps.length, 1, 'the one request it had paid for');
      assert.strictEqual(judged.length, 0, 'nothing was judged after it');
      assert.deepStrictEqual(watch.stops, ['token-budget']);
      assert.strictEqual(result.aiReview.stopped, true);
      assert.strictEqual(result.aiReview.sweepRequests, 1);
      assert.deepStrictEqual(result.groups, [], 'and nothing became a group');
    });

    await test('Without the band the names are still read, for the sweep', async () => {
      const fake = seedSemantic();
      const { sweeps } = useSweepProvider({ groups: TWO_TRANSLATIONS });

      const result = await service.reviewScan({
        ...SWEEP_REVIEW,
        includeCandidates: false,
      });

      assert.strictEqual(sweeps.length, 1);
      assert.strictEqual(
        namesInPrompt(sweeps[0].prompt).length,
        6,
        'the sweep bought the entity read the band would have paid for'
      );
      assert.ok(fake.calls.some((call) => call.path === '/tags/'));
      assert.strictEqual(result.aiReview.sweepProposals, 2);
      assert.strictEqual(result.aiReview.targeted, true);
    });

    // ------------------------------- the calibration that survives a restart

    await test('A calibration in the table is loaded and skips the warm-up', async () => {
      seedSemantic();
      useSweepProvider({ groups: TWO_TRANSLATIONS });
      // What an earlier process measured, in the table and nowhere else.
      assert.strictEqual(service.calibration.size, 0);
      await documentModel.saveAiCalibration({
        model: 'test-model',
        thinking: false,
        tokensPerPair: 90,
        tokensPerSecond: 45,
        largestCompletion: 512,
      });

      const watch = useControl();
      const lines = await withLoggedLines(() =>
        service.reviewScan(SWEEP_REVIEW, watch.control)
      );

      assert.strictEqual(watch.ofPhase('warming-up').length, 0, 'no warm-up');
      assert.strictEqual(watch.ofPhase('judging').length, 1);
      assert.strictEqual(watch.ofPhase('judging')[0].calibrated, true);
      assert.ok(
        lines.some((line) =>
          /calibrated from a previous review: 90 tokens per pair, 45 tokens\/s, thinking off\./.test(
            line
          )
        ),
        `no calibration line:\n${lines.join('\n')}`
      );
      const loaded = service.calibration.get('test-model');
      assert.strictEqual(loaded.tokensPerPair, 90);
      assert.strictEqual(loaded.largestCompletion, 512);
    });

    await test('A stored measurement of the other thinking switch is not loaded', async () => {
      seedSemantic();
      useSweepProvider({ groups: () => [] });
      await documentModel.saveAiCalibration({
        model: 'test-model',
        thinking: true,
        tokensPerPair: 90,
        tokensPerSecond: 45,
        largestCompletion: 512,
      });

      const watch = useControl();
      await service.reviewScan(SWEEP_REVIEW, watch.control);

      assert.strictEqual(
        service.calibration.has('test-model'),
        false,
        'the row of the other switch says nothing about this review'
      );
      assert.ok(watch.ofPhase('sweeping').length > 0, 'the sweep still ran');
    });

    await test('What a review measures is written to the table', async () => {
      seedArchive();
      useStreamingProvider({ completionTokens: 600 });
      assert.strictEqual(
        (await documentModel.getAiCalibration('test-model', false))
          ?.tokensPerPair ?? null,
        null,
        'the reset of the provider emptied the row'
      );

      await withBatchSize(2, () => service.reviewScan(BAND_REVIEW));
      await service.lastCalibrationSave;

      const stored = await documentModel.getAiCalibration('test-model', false);
      const measured = service.calibration.get('test-model');
      assert.ok(stored, 'the table has a row for this model');
      assert.strictEqual(stored.tokensPerPair, measured.tokensPerPair);
      assert.strictEqual(stored.tokensPerSecond, measured.tokensPerSecond);
      assert.strictEqual(stored.largestCompletion, measured.largestCompletion);
      assert.strictEqual(
        (await documentModel.getAiCalibration('test-model', true))
          ?.tokensPerPair ?? null,
        null,
        'and nothing under the other switch'
      );
    });

    await test('resetCalibration forgets the measurement in memory and in the table', async () => {
      seedArchive();
      useStreamingProvider({ completionTokens: 600 });
      await withBatchSize(2, () => service.reviewScan(BAND_REVIEW));
      await service.lastCalibrationSave;
      assert.ok(
        (await documentModel.getAiCalibration('test-model', false))
          .tokensPerPair > 0
      );

      await service.resetCalibration();

      assert.strictEqual(service.calibration.size, 0);
      assert.strictEqual(
        (await documentModel.getAiCalibration('test-model', false))
          .tokensPerPair,
        null,
        'and the row measures nothing any more'
      );

      // Which is what the next review sees: a model it has to measure again.
      seedArchive();
      const { calls } = useStreamingProvider({ completionTokens: 600 });
      const watch = useControl();
      await withBatchSize(3, () =>
        service.reviewScan(BAND_REVIEW, watch.control)
      );
      assert.strictEqual(watch.ofPhase('warming-up').length, 1);
      assert.ok(calls.length > 0);
    });

    await test('forgetCalibration drops one model, in memory and in the table', async () => {
      seedArchive();
      useStreamingProvider({ completionTokens: 600 });
      await withBatchSize(2, () => service.reviewScan(BAND_REVIEW));
      await service.lastCalibrationSave;
      service.calibration.set('another-model', {
        tokensPerPair: 10,
        tokensPerSecond: 10,
        largestCompletion: 10,
        thinking: false,
        measuredAt: Date.now(),
      });

      await service.forgetCalibration('test-model');

      assert.strictEqual(service.calibration.has('test-model'), false);
      assert.strictEqual(
        service.calibration.has('another-model'),
        true,
        'and nothing else is touched'
      );
      assert.strictEqual(
        (await documentModel.getAiCalibration('test-model', false))
          .tokensPerPair,
        null
      );
      await service.resetCalibration();
    });

    await test('The three yes/no switches read the strings config.js hands over', async () => {
      // parseEnvBoolean() normalises the environment to 'yes' / 'no'; a
      // reader that asks Boolean() or === true takes 'no' for on, or never
      // sees a 'yes'. The user's DUPLICATES_AI_THINKING=yes was ignored so.
      const previous = {
        review: config.duplicatesAiReview,
        excerpts: config.duplicatesAiExcerpts,
        thinking: config.duplicatesAiThinking,
      };
      try {
        config.duplicatesAiReview = 'no';
        assert.strictEqual(
          service.isEnabled(),
          false,
          "'no' switches the review off"
        );
        config.duplicatesAiReview = 'yes';
        assert.strictEqual(service.isEnabled(), true, "'yes' switches it on");
        config.duplicatesAiReview = true;
        assert.strictEqual(
          service.isEnabled(),
          true,
          'a boolean from a test counts too'
        );

        config.duplicatesAiExcerpts = 'no';
        assert.strictEqual(
          service.excerptsEnabled(),
          false,
          "'no' switches the excerpts off"
        );
        config.duplicatesAiExcerpts = 'yes';
        assert.strictEqual(service.excerptsEnabled(), true);

        config.duplicatesAiThinking = 'yes';
        assert.strictEqual(
          service.thinkingEnabled(),
          true,
          "'yes' lets the judge think"
        );
        config.duplicatesAiThinking = 'no';
        assert.strictEqual(service.thinkingEnabled(), false);
        config.duplicatesAiThinking = false;
        assert.strictEqual(service.thinkingEnabled(), false);
      } finally {
        config.duplicatesAiReview = previous.review;
        config.duplicatesAiExcerpts = previous.excerpts;
        config.duplicatesAiThinking = previous.thinking;
      }
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
