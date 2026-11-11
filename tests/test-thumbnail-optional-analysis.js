/**
 * Thumbnail caching must not decide whether a document gets analysed.
 *
 * analyzeDocument() caches the document thumbnail for the UI, but the
 * thumbnail never enters the prompt — so every outcome of that side step has
 * to leave the analysis itself alone. Two ways it did not:
 *
 * 1. getThumbnailCachePath() ran outside the try block, so an id it rejects
 *    ('' after sanitizing, null, undefined) made analyzeDocument() *throw*
 *    instead of returning a result. The scan loop reads analysis.error and
 *    never expects a throw; POST /manual/analyze passed `id || []`, which is
 *    exactly such a value, and answered 500 for every request without an id.
 * 2. A thumbnail Paperless does not have returned `undefined` from
 *    analyzeDocument(), and every caller immediately reads `.document` on it.
 *
 * Ollama already treated the step as best effort (_handleThumbnailCaching
 * returns early on a falsy id); it is in here to keep the four providers from
 * drifting apart again.
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

const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('../services/thumbnailCachePaths');
const paperlessService = require('../services/paperlessService');
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

const ANSWER = {
  title: 'Telekom invoice July',
  correspondent: 'Telekom Deutschland GmbH',
  tags: ['invoice'],
  document_type: 'Rechnung',
  document_date: '2026-09-03',
  language: 'de',
};

const CHAT_ANSWER = {
  choices: [
    { message: { content: JSON.stringify(ANSWER) }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
};

const OLLAMA_ANSWER = {
  response: JSON.stringify(ANSWER),
  done_reason: 'stop',
  eval_count: 120,
  prompt_eval_count: 900,
};

const PROVIDERS = [
  {
    label: 'OpenAI',
    service: openaiService,
    stub: () => {
      openaiService.client = {
        chat: { completions: { create: async () => CHAT_ANSWER } },
      };
    },
  },
  {
    label: 'Azure',
    service: azureService,
    stub: () => {
      azureService.client = {
        chat: { completions: { create: async () => CHAT_ANSWER } },
      };
    },
  },
  {
    label: 'Custom',
    service: customService,
    stub: () => {
      customService.client = {
        chat: { completions: { create: async () => CHAT_ANSWER } },
      };
    },
  },
  {
    label: 'Ollama',
    service: ollamaService,
    stub: () => {
      ollamaService.client = { post: async () => ({ data: OLLAMA_ANSWER }) };
    },
  },
];

/** The document came back analysed, whatever the thumbnail step did. */
function assertAnalysed(analysis) {
  assert.ok(analysis, 'analyzeDocument returned nothing at all');
  assert.strictEqual(analysis.error, undefined);
  assert.strictEqual(
    analysis.document.correspondent,
    'Telekom Deutschland GmbH'
  );
  assert.deepStrictEqual(analysis.document.tags, ['invoice']);
}

const originalGetThumbnailImage = paperlessService.getThumbnailImage;
const writtenCachePaths = [];

(async () => {
  console.log('\n=== Thumbnail caching is optional for analysis ===');

  try {
    for (const { label, service, stub } of PROVIDERS) {
      /* --- ids the cache path helper rejects ----------------------------- */

      // `id || []` is what routes/setup.js used to hand over when the request
      // omitted one, and String([]) sanitizes to the empty string.
      for (const id of [[], undefined, null, '', '///']) {
        await check(
          `${label}: an unusable id (${JSON.stringify(id)}) still analyses`,
          async () => {
            stub();
            paperlessService.getThumbnailImage = async () => {
              throw new Error(
                'Paperless must not be called for an unusable id'
              );
            };
            assertAnalysed(
              await service.analyzeDocument('Rechnung', [], [], [], id)
            );
          }
        );
      }

      /* --- Paperless cannot supply the thumbnail ------------------------- */

      await check(
        `${label}: a thumbnail Paperless does not have still analyses`,
        async () => {
          stub();
          paperlessService.getThumbnailImage = async () => null;
          assertAnalysed(
            await service.analyzeDocument(
              'Rechnung',
              [],
              [],
              [],
              `thumbmissing${label}`
            )
          );
        }
      );

      await check(
        `${label}: a failing thumbnail fetch still analyses`,
        async () => {
          stub();
          paperlessService.getThumbnailImage = async () => {
            throw new Error('Paperless unreachable');
          };
          assertAnalysed(
            await service.analyzeDocument(
              'Rechnung',
              [],
              [],
              [],
              `thumbbroken${label}`
            )
          );
        }
      );

      /* --- the feature itself still works ------------------------------- */

      await check(
        `${label}: an available thumbnail is still written to the cache`,
        async () => {
          stub();
          paperlessService.getThumbnailImage = async () =>
            Buffer.from([0x89, 0x50, 0x4e, 0x47]);

          const id = `thumbok${label}`;
          const cachePath = getThumbnailCachePath(id);
          writtenCachePaths.push(cachePath);
          await fs.rm(cachePath, { force: true });

          assertAnalysed(
            await service.analyzeDocument('Rechnung', [], [], [], id)
          );
          await assert.doesNotReject(
            fs.access(cachePath),
            `expected a cached thumbnail at ${cachePath}`
          );
        }
      );
    }
  } finally {
    paperlessService.getThumbnailImage = originalGetThumbnailImage;
    for (const cachePath of writtenCachePaths) {
      await fs.rm(cachePath, { force: true });
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} thumbnail independence case(s) failed`);
    process.exit(1);
  }
  console.log(
    `\nAll thumbnail independence cases passed (cache dir: ${THUMBNAIL_CACHE_DIR})`
  );
})();
