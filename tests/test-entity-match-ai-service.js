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
      const same = { verdict: 'same', reason: 'same company' };
      const different = { verdict: 'different', reason: 'other bank' };
      const unsure = { verdict: 'unsure', reason: 'not enough context' };
      assert.deepStrictEqual(service.aggregateVerdict([same, same]), same);
      assert.deepStrictEqual(
        service.aggregateVerdict([same, different]),
        different
      );
      assert.deepStrictEqual(service.aggregateVerdict([same, unsure]), unsure);
      assert.deepStrictEqual(service.aggregateVerdict([]), {
        verdict: 'unsure',
        reason: '',
      });
      assert.deepStrictEqual(service.aggregateVerdict([null, same]), same);
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
        assert.deepStrictEqual(result.verdicts.get(pair.key), {
          verdict: verdicts[index],
          reason: `reason ${index}`,
        });
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
      assert.deepStrictEqual(result.verdicts.get(pairs[0].key), {
        verdict: 'same',
        reason: 'plural of the same word',
      });
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
      assert.deepStrictEqual(result.verdicts.get(pairs[0].key), {
        verdict: 'unsure',
        reason: 'unrecognised verdict',
      });
      assert.deepStrictEqual(result.verdicts.get(pairs[1].key), {
        verdict: 'different',
        reason: 'two topics',
      });
      assert.deepStrictEqual(result.verdicts.get(pairs[2].key), {
        verdict: 'unsure',
        reason: 'no answer from the model',
      });
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
        assert.deepStrictEqual(result.verdicts.get(key), {
          verdict: 'unsure',
          reason: 'socket hang up',
        });
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
      assert.deepStrictEqual(result.verdicts.get(pairs[0].key), {
        verdict: 'unsure',
        reason: service.SINGLE_PAIR_TRUNCATION_REASON,
      });
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
      assert.deepStrictEqual(result.verdicts.get(pairs[0].key), {
        verdict: 'same',
        reason: 'two spellings',
      });
      assert.deepStrictEqual(result.verdicts.get(pairs[1].key), {
        verdict: 'same',
        reason: 'two spellings',
      });
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

      assert.strictEqual(calls.length, 1, 'three pairs are one request');
      const asked = idsInPrompt(calls[0].prompt);
      assert.deepStrictEqual(
        [...asked].sort(),
        ['correspondents:1-2', 'correspondents:3-4', 'correspondents:5-6'],
        'the group pair and the two live candidates'
      );
      assert.strictEqual(
        asked.includes('correspondents:7-8'),
        false,
        'a dismissed pair is never sent to the model'
      );
      assert.match(
        calls[0].prompt,
        /"titles":\["Amazon order 2024-11"\]/,
        'document titles reach the model as context'
      );

      assert.deepStrictEqual(result.aiReview, {
        enabled: true,
        model: 'test-model',
        requests: 1,
        tokens: 100,
        judged: 3,
        candidates: 2,
        failedRequests: 0,
        retries: 0,
        batchSize: 3,
      });
      assert.strictEqual(result.threshold, 0.95, 'the scan result is kept');
      assert.strictEqual(result.paperlessUrl, 'https://paperless.example');

      assert.strictEqual(result.groups.length, 2);
      const [scanGroup, candidateGroup] = result.groups;

      assert.strictEqual(scanGroup.source, 'scan');
      assert.deepStrictEqual(scanGroup.aiVerdict, {
        verdict: 'same',
        reason: 'only the case differs',
      });
      const target = scanGroup.members.find(
        (member) => member.id === scanGroup.suggestedTargetId
      );
      assert.strictEqual(target.aiVerdict, null, 'the target judges nothing');
      const judgedMember = scanGroup.members.find(
        (member) => member.id !== scanGroup.suggestedTargetId
      );
      assert.deepStrictEqual(judgedMember.aiVerdict, {
        verdict: 'same',
        reason: 'only the case differs',
      });

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
      assert.deepStrictEqual(candidateGroup.aiVerdict, {
        verdict: 'same',
        reason: 'same Vodafone service desk',
      });
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
      assert.match(calls[0].prompt, /"name":"Amazon","documents":1/);
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
      assert.strictEqual(result.aiReview.judged, 4);
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
        /correspondents: threshold 0\.95, 1 scan group\(s\), 3 candidate\(s\) in the band, 4 pair\(s\) to judge\./
      );
      has(
        /correspondents: batch size 4 of at most 25 \(context limit \d+ tokens\)/
      );
      has(/first batch ~\d+ prompt tokens, completion cap 680\./);
      has(
        /correspondents: request 1, 4 pair\(s\), ~\d+ prompt tokens, cap 680, \d+ms, 3 same \/ 1 different \/ 0 unsure\./
      );
      has(
        /review finished: 1 request\(s\) \(0 retry\/retries, 0 failed\), 100 token\(s\), 4 pair\(s\) judged, 3 candidate\(s\), 3 group\(s\) confirmed, in \d+ms\./
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
