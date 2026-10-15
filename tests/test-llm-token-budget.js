/**
 * The two token budgets, each written once.
 *
 * Step 4 of the LLM service refactoring (docs/llm-service-refactoring.md).
 * openai, azure and custom carried the same reserve-then-truncate block:
 * tiktoken counts for the prompt, the configured answer reserved, the
 * document cut to what is left. It lives in
 * services/llm/tokenBudget/tiktokenBudget.js now. Ollama's arithmetic is a
 * different model on purpose (Finding 5) — 2 chars per token, num_ctx sized
 * as min(prompt + answer, TOKEN_LIMIT), the document fitted by characters —
 * and lives in services/llm/tokenBudget/charBudget.js. Both expose the same
 * reserve()/fit() pair, so the analyzer of step 6 can take either.
 *
 * The first half pins each budget on its own, the second half checks that
 * every provider spends the budget it was given.
 */

const assert = require('assert');
const fs = require('fs').promises;

process.env.AI_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'gpt-4';
process.env.AZURE_API_KEY = 'test-key';
process.env.AZURE_ENDPOINT = 'https://example.invalid';
process.env.AZURE_DEPLOYMENT_NAME = 'test-deployment';
process.env.CUSTOM_BASE_URL = 'https://example.invalid/v1';
process.env.CUSTOM_API_KEY = 'test-key';
process.env.CUSTOM_MODEL = 'test-model';
process.env.SYSTEM_PROMPT = 'Analyse the document.';
process.env.USE_PROMPT_TAGS = 'no';
delete process.env.CUSTOM_FIELDS;
delete process.env.CONTENT_MAX_LENGTH;

const config = require('../config/config');
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('../services/thumbnailCachePaths');
const {
  calculateTotalPromptTokens,
  truncateToTokenLimit,
} = require('../services/serviceUtils');
const tiktokenBudget = require('../services/llm/tokenBudget/tiktokenBudget');
const charBudget = require('../services/llm/tokenBudget/charBudget');
const openaiService = require('../services/openaiService');
const azureService = require('../services/azureService');
const customService = require('../services/customService');
const ollamaService = require('../services/ollamaService');

let failed = 0;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${label}: ${error.message}`);
  }
};

/** Own id so the seeded thumbnail cannot collide with a real cached document. */
const DOCUMENT_ID = 'testLlmTokenBudget';

const CHAT_LIMIT_MESSAGE =
  'Token limit exceeded: prompt too large for available token limit';

const ANSWER = JSON.stringify({
  title: 'Telekom invoice July',
  correspondent: 'Telekom Deutschland GmbH',
  tags: ['invoice'],
  document_type: 'Rechnung',
  document_date: '2026-09-03',
  language: 'de',
});

/** The success document every provider shapes to the seven fields. */
const DEFAULT_DOCUMENT = {
  tags: ['invoice'],
  correspondent: 'Telekom Deutschland GmbH',
  title: 'Telekom invoice July',
  document_date: '2026-09-03',
  document_type: 'Rechnung',
  language: 'de',
  custom_fields: null,
};

/** Field defaults for all four (step 6): the success comes back default-shaped. */
function assertDefaultDocument(analysis) {
  assert.deepStrictEqual(
    analysis.document,
    DEFAULT_DOCUMENT,
    'the success document carries the seven default-shaped fields'
  );
}

/** Long enough that every limit below has to cut it. */
const LONG_CONTENT = 'Invoice from Telekom Deutschland GmbH, July. '.repeat(
  400
);

function limits(tokenLimit, responseTokens) {
  Object.assign(config, { tokenLimit, responseTokens });
}

/* --- the providers, each with a client that records what it was sent ----- */

function recordingChatClient(service, requests) {
  service.client = {
    chat: {
      completions: {
        create: async (request) => {
          requests.push(request);
          return {
            choices: [{ message: { content: ANSWER }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
          };
        },
      },
    },
    models: { list: async () => ({ data: [] }) },
  };
}

function recordingOllamaClient(requests) {
  ollamaService.client = {
    post: async (url, body) => {
      requests.push(body);
      return {
        data: {
          response: ANSWER,
          done_reason: 'stop',
          eval_count: 3,
          prompt_eval_count: 9,
        },
      };
    },
    get: async () => ({ status: 200, data: { models: [] } }),
  };
}

const CHAT_PROVIDERS = [
  ['OpenAI', openaiService, () => process.env.OPENAI_MODEL],
  ['Azure', azureService, () => process.env.AZURE_DEPLOYMENT_NAME],
  ['Custom', customService, () => config.custom.model],
];

async function analyzeRecorded(service, content, record) {
  const requests = [];
  record(requests);
  const analysis = await service.analyzeDocument(
    content,
    [],
    [],
    [],
    DOCUMENT_ID
  );
  return { analysis, requests };
}

(async () => {
  console.log('\n=== LLM token budget ===');

  /* --- tiktokenBudget ----------------------------------------------------- */

  await check(
    'tiktoken: reserve counts the prompt and the answer',
    async () => {
      limits(4000, 500);
      const prompt = 'Analyse the document and answer in JSON.';
      const budget = await tiktokenBudget.reserve(
        prompt,
        ['extra tags'],
        'gpt-4'
      );
      const counted = await calculateTotalPromptTokens(
        prompt,
        ['extra tags'],
        'gpt-4'
      );
      assert.deepStrictEqual(budget, {
        totalPromptTokens: counted,
        reservedTokens: counted + 500,
        availableTokens: 4000 - counted - 500,
      });
    }
  );

  await check('tiktoken: no room left is "Token limit exceeded"', async () => {
    limits(100, 100);
    await assert.rejects(
      () => tiktokenBudget.reserve('Analyse.', [], 'gpt-4'),
      (error) => error.message === CHAT_LIMIT_MESSAGE
    );
  });

  await check('tiktoken: a broken limit is refused, not spent', async () => {
    for (const [tokenLimit, responseTokens] of [
      [Number.NaN, 100],
      [4000, Number.NaN],
      [undefined, 100],
    ]) {
      limits(tokenLimit, responseTokens);
      await assert.rejects(
        () => tiktokenBudget.reserve('Analyse.', [], 'gpt-4'),
        (error) => error.message === CHAT_LIMIT_MESSAGE
      );
    }
  });

  await check('tiktoken: fit is truncateToTokenLimit', async () => {
    assert.strictEqual(
      await tiktokenBudget.fit(LONG_CONTENT, 50, 'gpt-4'),
      await truncateToTokenLimit(LONG_CONTENT, 50, 'gpt-4')
    );
    assert.strictEqual(await tiktokenBudget.fit('short', 50, 'gpt-4'), 'short');
  });

  /* --- charBudget (Finding 5) --------------------------------------------- */

  await check('char: two characters make one token, rounded up', () => {
    assert.strictEqual(charBudget.estimateTokens(''), 0);
    assert.strictEqual(charBudget.estimateTokens('a'), 1);
    assert.strictEqual(charBudget.estimateTokens('abcd'), 2);
    assert.strictEqual(charBudget.estimateTokens('abcde'), 3);
  });

  await check('char: num_ctx is min(prompt + answer, TOKEN_LIMIT)', () => {
    limits(8192, 1000);
    assert.strictEqual(charBudget.numCtx(2000, 1000), 3000);
    assert.strictEqual(charBudget.numCtx(7500, 1000), 8192);
  });

  await check(
    'char: reserve leaves TOKEN_LIMIT - answer - prompt/2',
    async () => {
      limits(8192, 1000);
      const budget = await charBudget.reserve('x'.repeat(301));
      assert.deepStrictEqual(budget, {
        totalPromptTokens: 151,
        reservedTokens: 1151,
        availableTokens: 8192 - 1151,
      });
    }
  );

  await check('char: no room left is "Token limit exceeded"', async () => {
    limits(1000, 900);
    await assert.rejects(
      () => charBudget.reserve('x'.repeat(200)),
      /^Error: Token limit exceeded: the prompt alone does not fit the configured TOKEN_LIMIT/
    );
  });

  await check('char: a broken limit leaves the document whole', async () => {
    limits(Number.NaN, 1000);
    const budget = await charBudget.reserve('x'.repeat(200));
    assert.strictEqual(budget.availableTokens, Infinity);
    assert.strictEqual(
      await charBudget.fit(LONG_CONTENT, budget.availableTokens),
      LONG_CONTENT
    );
  });

  await check(
    'char: fit cuts to two characters per available token',
    async () => {
      assert.strictEqual(
        await charBudget.fit(LONG_CONTENT, 100),
        LONG_CONTENT.slice(0, 200)
      );
      assert.strictEqual(await charBudget.fit('short', 100), 'short');
    }
  );

  await check('char: fit measures a non-string document as JSON', async () => {
    const doc = { text: 'x'.repeat(500) };
    const cut = await charBudget.fit(doc, 50);
    assert.strictEqual(cut, JSON.stringify(doc).slice(0, 100));
    // One that fits comes back as it was handed in, not as its JSON.
    const small = { a: 1 };
    assert.strictEqual(await charBudget.fit(small, 50), small);
  });

  /* --- every provider spends the budget it was given ---------------------- */

  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  await fs.writeFile(getThumbnailCachePath(DOCUMENT_ID), 'thumbnail');

  for (const [label, service, model] of CHAT_PROVIDERS) {
    const record = (requests) => recordingChatClient(service, requests);

    await check(
      `${label}: the document is cut to the tiktoken budget`,
      async () => {
        limits(600, 200);
        const { analysis, requests } = await analyzeRecorded(
          service,
          LONG_CONTENT,
          record
        );
        assert.strictEqual(analysis.error, undefined, analysis.error);
        assert.strictEqual(requests.length, 1);
        const system = requests[0].messages.find((m) => m.role === 'system');
        const user = requests[0].messages.find((m) => m.role === 'user');
        const budget = await tiktokenBudget.reserve(
          system.content,
          [],
          model()
        );
        assert.strictEqual(
          user.content,
          await tiktokenBudget.fit(
            LONG_CONTENT,
            budget.availableTokens,
            model()
          )
        );
        assert.strictEqual(analysis.truncated, true);
        assertDefaultDocument(analysis);
      }
    );

    await check(`${label}: a document that fits is sent whole`, async () => {
      limits(8000, 200);
      const { analysis, requests } = await analyzeRecorded(
        service,
        'Short invoice.',
        record
      );
      const user = requests[0].messages.find((m) => m.role === 'user');
      assert.strictEqual(user.content, 'Short invoice.');
      assert.strictEqual(analysis.truncated, false);
      assertDefaultDocument(analysis);
    });

    await check(`${label}: no room left fails before any request`, async () => {
      limits(100, 100);
      const { analysis, requests } = await analyzeRecorded(
        service,
        LONG_CONTENT,
        record
      );
      assert.strictEqual(analysis.error, CHAT_LIMIT_MESSAGE);
      assert.strictEqual(requests.length, 0);
    });
  }

  await check('Ollama: the document is cut to the char budget', async () => {
    limits(2000, 500);
    const { analysis, requests } = await analyzeRecorded(
      ollamaService,
      LONG_CONTENT,
      recordingOllamaClient
    );
    assert.strictEqual(analysis.error, undefined, analysis.error);
    const prompt = requests[0].prompt;
    // The prompt ends with the fitted document as a JSON string literal.
    const start = prompt.indexOf('"Invoice from');
    const sentContent = JSON.parse(prompt.slice(start).trim());
    const prefix = prompt.slice(0, start - '\n        '.length);
    const budget = await charBudget.reserve(prefix + '\n        ');
    assert.ok(sentContent.length < LONG_CONTENT.length, 'the document was cut');
    assert.ok(
      sentContent.length <= budget.availableTokens * 2,
      `${sentContent.length} chars sent for ${budget.availableTokens} tokens`
    );
    assert.strictEqual(analysis.truncated, true);
  });

  await check(
    'Ollama: num_ctx is min(prompt/2 + answer, TOKEN_LIMIT)',
    async () => {
      limits(2000, 500);
      const { requests } = await analyzeRecorded(
        ollamaService,
        'Short invoice.',
        recordingOllamaClient
      );
      const { prompt, options } = requests[0];
      assert.strictEqual(
        options.num_ctx,
        Math.min(Math.ceil(prompt.length / 2) + 500, 2000)
      );
      assert.strictEqual(options.num_predict, 500);
    }
  );

  await check('Ollama: no room left fails before any request', async () => {
    limits(600, 500);
    const { analysis, requests } = await analyzeRecorded(
      ollamaService,
      LONG_CONTENT,
      recordingOllamaClient
    );
    assert.match(analysis.error || '', /^Token limit exceeded/);
    assert.strictEqual(requests.length, 0);
  });

  await fs.rm(getThumbnailCachePath(DOCUMENT_ID), { force: true });

  if (failed > 0) {
    console.error(`\n${failed} token budget case(s) failed`);
    process.exit(1);
  }
  console.log('\nAll token budget cases passed');
})();
