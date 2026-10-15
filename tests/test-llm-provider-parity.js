/**
 * The same answer gives the same result on all four providers, and the
 * four are one DocumentAnalyzer each behind a re-export.
 *
 * Step 6 of the LLM service refactoring (docs/llm-service-refactoring.md,
 * "Done means"): once the four providers share one DocumentAnalyzer, an
 * answer must come back byte-identical from each of them — the document, the
 * metrics, the truncation flag and, for a failure, the error and its code.
 * Every stub reports the same token counts, so a difference anywhere in the
 * result is a difference in the analysis itself.
 *
 * Deliberately left out, because step 6 keeps them as they are (the plan's
 * "Not decided" list): transport failures, where only Custom normalizes a
 * timeout (rows e/m), and an empty payload, which Ollama words "No response
 * data from Ollama API" (row l).
 */

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');

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

const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('../services/thumbnailCachePaths');

const { DocumentAnalyzer } = require('../services/llm/documentAnalyzer');

const PROVIDERS = {
  OpenAI: require('../services/openaiService'),
  Azure: require('../services/azureService'),
  Custom: require('../services/customService'),
  Ollama: require('../services/ollamaService'),
};

/** The module each provider's legacy path re-exports. */
const ROOTS = {
  OpenAI: ['openaiService', 'openaiProvider'],
  Azure: ['azureService', 'azureProvider'],
  Custom: ['customService', 'customProvider'],
  Ollama: ['ollamaService', 'ollamaProvider'],
};

/** Own id so the seeded thumbnail cannot collide with a real cached document. */
const DOCUMENT_ID = 'testLlmProviderParity';

/** Short enough that no provider cuts it. */
const CONTENT = 'Invoice from Telekom Deutschland GmbH, July 2026.';

/** The answer text every provider receives, by case. */
const ANSWERS = [
  [
    'a complete answer',
    JSON.stringify({
      title: 'Telekom invoice July',
      correspondent: 'Telekom Deutschland GmbH',
      tags: ['invoice', 'telecom'],
      document_type: 'Invoice',
      document_date: '2026-07-31',
      language: 'en',
      custom_fields: [{ field_name: 'Amount', value: '49.99' }],
    }),
  ],
  [
    'a partial answer',
    JSON.stringify({ tags: ['invoice'], correspondent: 'Telekom' }),
  ],
  [
    'an answer with an invented field',
    JSON.stringify({ tags: ['invoice'], correspondent: null, mood: 'calm' }),
  ],
  [
    'an answer that found nothing',
    JSON.stringify({ tags: [], correspondent: null }),
  ],
  ['an answer without metadata', JSON.stringify({ title: 'Telekom' })],
  [
    'tags given as a string',
    JSON.stringify({ tags: 'invoice', correspondent: 'Telekom' }),
  ],
  [
    'an answer in a code fence',
    '```json\n' + JSON.stringify({ tags: ['a'], correspondent: 'C' }) + '\n```',
  ],
  [
    'an answer after a reasoning block',
    '<think>Looks like an invoice.</think>' +
      JSON.stringify({ tags: ['a'], correspondent: 'C' }),
  ],
  ['an answer with a trailing comma', '{"tags": ["a"], "correspondent": "C",}'],
  ['a refusal', "I'm sorry, I cannot analyse this document."],
  ['no JSON at all', 'The document is a scanned letter.'],
  ['an object cut off mid-way', '{"title": "Telekom", "tags": ["inv'],
];

/** Every provider answers `text` and reports 9 + 3 tokens. */
function answerWith(label, text) {
  if (label === 'Ollama') {
    PROVIDERS.Ollama.client = {
      post: async () => ({
        data: {
          response: text,
          done_reason: 'stop',
          prompt_eval_count: 9,
          eval_count: 3,
        },
      }),
      get: async () => ({ status: 200, data: { models: [] } }),
    };
    return;
  }
  PROVIDERS[label].client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        }),
      },
    },
    models: { list: async () => ({ data: [] }) },
  };
}

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

(async () => {
  console.log('\n=== LLM provider parity ===');

  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  await fs.writeFile(
    getThumbnailCachePath(DOCUMENT_ID),
    Buffer.from([0x89, 0x50, 0x4e, 0x47])
  );

  /* The structure behind the parity: one analyzer, four composition roots,
     and the old module paths as plain re-exports. */
  for (const [label, [service, provider]] of Object.entries(ROOTS)) {
    await check(`${label}: a DocumentAnalyzer behind a re-export`, async () => {
      assert.ok(PROVIDERS[label] instanceof DocumentAnalyzer);
      assert.strictEqual(
        PROVIDERS[label],
        require(`../services/llm/providers/${provider}`)
      );
      const source = await fs.readFile(
        path.join(__dirname, '..', 'services', `${service}.js`),
        'utf8'
      );
      const code = source.replace(/^\/\/.*$/gm, '').trim();
      assert.strictEqual(
        code,
        `module.exports = require('./llm/providers/${provider}');`
      );
    });
  }

  for (const [name, text] of ANSWERS) {
    await check(`${name}: byte-identical on all four`, async () => {
      const results = {};
      for (const label of Object.keys(PROVIDERS)) {
        answerWith(label, text);
        results[label] = JSON.stringify(
          await PROVIDERS[label].analyzeDocument(
            CONTENT,
            [],
            [],
            [],
            DOCUMENT_ID
          )
        );
      }
      for (const label of Object.keys(PROVIDERS)) {
        assert.strictEqual(
          results[label],
          results.OpenAI,
          `${label} differs from OpenAI`
        );
      }
    });
  }

  await fs.rm(getThumbnailCachePath(DOCUMENT_ID), { force: true });

  if (failed > 0) {
    console.error(`\n${failed} provider parity case(s) failed`);
    process.exit(1);
  }
  console.log('\nAll provider parity cases passed');
})();
