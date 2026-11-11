/**
 * Truncation detection on the OpenAI-compatible providers (issue #263).
 *
 * Ollama reports a generation it had to cut short as done_reason "length";
 * OpenAI, Azure and the custom endpoint call the same event finish_reason
 * "length". Neither was read anywhere in the codebase, so a cut-off answer
 * surfaced as "Invalid JSON response from API" a few lines later — and sent
 * the document to the OCR queue, which re-reads the PDF and re-runs the same
 * request against the same limit.
 *
 * analyzeDocument() is exercised per provider: the scan loop reads
 * analysis.errorCode, so a service that raises the right error but drops the
 * code on the way out records a generic failure and loses the OCR decision.
 * The provider client is the only collaborator stubbed; the thumbnail cache is
 * pre-seeded so the analysis path reaches the client without a Paperless call.
 */

const assert = require('assert');
const fs = require('fs').promises;

process.env.AI_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'gpt-4';
process.env.SYSTEM_PROMPT = 'Analyse the document.';

const { assertCompletionNotTruncated } = require('../services/serviceUtils');
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('../services/thumbnailCachePaths');
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

const COMPLETE_ANSWER = JSON.stringify({
  title: 'Telekom invoice July',
  correspondent: 'Telekom Deutschland GmbH',
  tags: ['invoice'],
  document_type: 'Rechnung',
  document_date: '2026-09-03',
  language: 'de',
});

// A prefix of the answer above: valid JSON right up to the point it stops.
const CUT_OFF_ANSWER = COMPLETE_ANSWER.slice(0, -12);

// Own id so the seeded thumbnail cannot collide with a real cached document.
const DOCUMENT_ID = 'test263truncation';

// The response limit the services read from config.responseTokens; eval_count
// reaching it is what tells Ollama's guard which limit bit.
const RESPONSE_TOKENS = 1000;

function completion(finishReason, content = COMPLETE_ANSWER) {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 900, completion_tokens: 1000, total_tokens: 1900 },
  };
}

/** Replaces the SDK client with one that answers whatever the case needs. */
function stubClient(service, response) {
  service.client = {
    chat: { completions: { create: async () => response } },
    models: { list: async () => ({ data: [] }) },
  };
}

/** Same for Ollama, which answers over axios instead of an SDK. */
function stubOllamaClient(responseData) {
  ollamaService.client = {
    post: async () => ({ data: responseData }),
    get: async () => ({ status: 200, data: { models: [] } }),
  };
}

/**
 * Per-provider arrangements for the same two events. Kept as thunks so each
 * case re-stubs immediately before it runs and cannot inherit a stale client.
 */
function openAiCompatibleProvider(label, service) {
  return {
    label,
    service,
    arrangeCutOff: () =>
      stubClient(service, completion('length', CUT_OFF_ANSWER)),
    arrangeComplete: () => stubClient(service, completion('stop')),
  };
}

const PROVIDERS = [
  openAiCompatibleProvider('OpenAI', openaiService),
  openAiCompatibleProvider('Azure', azureService),
  openAiCompatibleProvider('Custom', customService),
  {
    label: 'Ollama',
    service: ollamaService,
    arrangeCutOff: () =>
      stubOllamaClient({
        response: CUT_OFF_ANSWER,
        done_reason: 'length',
        eval_count: RESPONSE_TOKENS,
        prompt_eval_count: 900,
      }),
    arrangeComplete: () =>
      stubOllamaClient({
        response: COMPLETE_ANSWER,
        done_reason: 'stop',
        eval_count: 120,
        prompt_eval_count: 900,
      }),
  },
];

(async () => {
  console.log('\n=== Response truncation detection ===');

  /* --- the shared guard ------------------------------------------------- */

  await check('finish_reason "length" is rejected with a code', () => {
    assert.throws(
      () =>
        assertCompletionNotTruncated(completion('length'), 'OpenAI', 'Do X.'),
      (error) => {
        assert.strictEqual(error.code, 'ai_response_truncated');
        assert.match(error.message, /OpenAI/);
        assert.match(error.message, /1000 tokens/);
        assert.match(error.message, /Do X\./);
        return true;
      }
    );
  });

  await check('a natural stop passes through untouched', () => {
    assert.doesNotThrow(() =>
      assertCompletionNotTruncated(completion('stop'), 'OpenAI', 'Do X.')
    );
    // Providers that report nothing at all must not be treated as truncated.
    assert.doesNotThrow(() =>
      assertCompletionNotTruncated({ choices: [{}] }, 'OpenAI', 'Do X.')
    );
    assert.doesNotThrow(() =>
      assertCompletionNotTruncated(undefined, 'OpenAI', 'Do X.')
    );
  });

  await check('the message survives a provider that omits usage', () => {
    assert.throws(
      () =>
        assertCompletionNotTruncated(
          { choices: [{ finish_reason: 'length' }] },
          'Custom OpenAI',
          'Do X.'
        ),
      /Custom OpenAI stopped generating because/
    );
  });

  /* --- each provider actually consults it ------------------------------- */

  /* Pre-seed the thumbnail cache so analyzeDocument() gets past its caching
     step without reaching Paperless. Ollama skips the step entirely once the
     file is there, the OpenAI-compatible three take their fs.access() hit. */
  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  await fs.writeFile(
    getThumbnailCachePath(DOCUMENT_ID),
    Buffer.from([0x89, 0x50, 0x4e, 0x47])
  );

  /* The failure shape the scan loop branches on: no metadata to write back,
     no metrics to record, and the code that decides OCR fallback. Asserted
     rather than read out of the source, so it survives the code moving. */
  const assertReportsCutOff = (analysis) => {
    assert.strictEqual(analysis.errorCode, 'ai_response_truncated');
    assert.match(analysis.error, /stopped generating/);
    assert.deepStrictEqual(analysis.document, {
      tags: [],
      correspondent: null,
    });
    assert.strictEqual(analysis.metrics, null);
  };

  for (const { label, service, arrangeCutOff, arrangeComplete } of PROVIDERS) {
    await check(
      `${label}: analyzeDocument reports a cut-off answer with its code`,
      async () => {
        // Truncated JSON would otherwise fail to parse and be blamed on the model.
        arrangeCutOff();
        const analysis = await service.analyzeDocument(
          'Rechnung',
          [],
          [],
          [],
          DOCUMENT_ID
        );
        assertReportsCutOff(analysis);
      }
    );

    await check(
      `${label}: analyzeDocument passes a complete answer through`,
      async () => {
        arrangeComplete();
        const analysis = await service.analyzeDocument(
          'Rechnung',
          [],
          [],
          [],
          DOCUMENT_ID
        );
        assert.strictEqual(analysis.error, undefined);
        assert.strictEqual(analysis.errorCode, undefined);
        assert.strictEqual(
          analysis.document.correspondent,
          'Telekom Deutschland GmbH'
        );
      }
    );
  }

  await fs.rm(getThumbnailCachePath(DOCUMENT_ID), { force: true });

  if (failed > 0) {
    console.error(`\n${failed} truncation detection case(s) failed`);
    process.exit(1);
  }
  console.log('\nAll truncation detection cases passed');
})();
