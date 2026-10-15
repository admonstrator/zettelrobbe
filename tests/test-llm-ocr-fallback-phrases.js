/**
 * The OCR fallback phrases, pinned end to end (Finding 4).
 *
 * Safety net for the LLM service refactoring (docs/llm-service-refactoring.md,
 * step 1). server.js:774-821 decides whether a failed analysis goes to the OCR
 * queue by matching analysis.error against a fixed list of **substrings** in
 * shouldQueueForOcrOnAiError(), and picks the queue reason with
 * classifyOcrQueueReasonFromAiError() (services/serviceUtils.js:812-861).
 *
 * Nothing enforces that link today. Reword a message inside a provider service
 * and the analysis still fails, the log still looks right, and the document
 * silently stops reaching OCR. That is the regression this test exists to
 * catch, so it asserts the full chain per provider:
 *
 *     stub a failing client
 *       -> analyzeDocument() returns analysis.error
 *       -> shouldQueueForOcrOnAiError(analysis.error) is true
 *       -> classifyOcrQueueReasonFromAiError(analysis.error) is the right reason
 *
 * The matcher's own vocabulary is checked separately, so a phrase deleted from
 * the list is caught even if no provider happens to produce it.
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
  shouldQueueForOcrOnAiError,
  classifyOcrQueueReasonFromAiError,
} = require('../services/serviceUtils');
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

/** Own id so the seeded thumbnail cannot collide with a real cached document. */
const DOCUMENT_ID = 'testllmocrphrases';

/** Enough text that no provider takes an "insufficient content" shortcut. */
const CONTENT = 'Invoice from Telekom Deutschland GmbH. '.repeat(20);

/**
 * Every marker shouldQueueForOcrOnAiError() knows, with the reason
 * classifyOcrQueueReasonFromAiError() derives from it. Copied out deliberately
 * rather than imported: importing the list would make the test agree with
 * whatever the source says, which is the opposite of pinning it.
 */
const MARKERS = [
  ['insufficient content for ai analysis', 'ai_insufficient_content'],
  ['invalid response structure', 'ai_invalid_response_structure'],
  ['could not determine assignable metadata', 'ai_invalid_response_structure'],
  ['invalid json response from api', 'ai_invalid_json'],
  ['invalid api response structure', 'ai_invalid_api_response_structure'],
];

function stubClient(service, respond) {
  service.client = {
    chat: { completions: { create: respond } },
    models: { list: async () => ({ data: [] }) },
  };
}

function stubOllamaClient(respond) {
  ollamaService.client = {
    post: respond,
    get: async () => ({ status: 200, data: { models: [] } }),
  };
}

function openAiCompatibleProvider(label, service) {
  return {
    label,
    service,
    /** Answers with `content`, which the service then tries to parse. */
    answer: (content) =>
      stubClient(service, async () => ({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 900,
          completion_tokens: 120,
          total_tokens: 1020,
        },
      })),
    /** Answers with a payload that has no choices array at all. */
    answerMalformed: () => stubClient(service, async () => ({ usage: {} })),
  };
}

const PROVIDERS = [
  openAiCompatibleProvider('OpenAI', openaiService),
  openAiCompatibleProvider('Azure', azureService),
  openAiCompatibleProvider('Custom', customService),
  {
    label: 'Ollama',
    service: ollamaService,
    answer: (content) =>
      stubOllamaClient(async () => ({
        data: {
          response: content,
          done_reason: 'stop',
          eval_count: 120,
          prompt_eval_count: 900,
        },
      })),
    answerMalformed: () => stubOllamaClient(async () => ({ data: {} })),
  },
];

const analyse = (service, content = CONTENT) =>
  service.analyzeDocument(content, [], [], [], DOCUMENT_ID);

/**
 * The assertion that matters: whatever the service worded, the scan loop must
 * still route the document to OCR under the expected reason.
 */
const assertRoutesToOcr = (analysis, expectedReason) => {
  assert.ok(analysis, 'analyzeDocument returned nothing at all');
  assert.strictEqual(
    typeof analysis.error,
    'string',
    'no error message to match against'
  );
  assert.ok(
    shouldQueueForOcrOnAiError(analysis.error),
    `"${analysis.error}" no longer matches any OCR fallback marker`
  );
  assert.strictEqual(
    classifyOcrQueueReasonFromAiError(analysis.error),
    expectedReason,
    `"${analysis.error}" classified as the wrong queue reason`
  );
};

(async () => {
  console.log('\n=== LLM OCR fallback phrases ===');

  /* --- the matcher's own vocabulary -------------------------------------- */

  await check('every marker still triggers the fallback', () => {
    for (const [marker, reason] of MARKERS) {
      assert.ok(
        shouldQueueForOcrOnAiError(marker),
        `marker dropped from shouldQueueForOcrOnAiError: "${marker}"`
      );
      assert.strictEqual(
        classifyOcrQueueReasonFromAiError(marker),
        reason,
        `marker reclassified: "${marker}"`
      );
    }
  });

  await check(
    'markers match case-insensitively inside longer sentences',
    () => {
      // Services word these as sentences, not as bare markers.
      assert.ok(
        shouldQueueForOcrOnAiError(
          'AI could not determine assignable metadata: no tags or correspondent found'
        )
      );
      assert.strictEqual(
        classifyOcrQueueReasonFromAiError(
          'AI could not determine assignable metadata: no tags or correspondent found'
        ),
        'ai_invalid_response_structure'
      );
    }
  );

  await check('an unrelated failure does not reach the OCR queue', () => {
    // A dead provider must not be retried as an OCR job.
    assert.strictEqual(shouldQueueForOcrOnAiError('socket hang up'), false);
    assert.strictEqual(shouldQueueForOcrOnAiError(''), false);
    assert.strictEqual(shouldQueueForOcrOnAiError(undefined), false);
    assert.strictEqual(
      classifyOcrQueueReasonFromAiError('socket hang up'),
      'ai_failed_unknown'
    );
  });

  /* --- the providers still produce them ---------------------------------- */

  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  await fs.writeFile(
    getThumbnailCachePath(DOCUMENT_ID),
    Buffer.from([0x89, 0x50, 0x4e, 0x47])
  );

  for (const { label, service, answer } of PROVIDERS) {
    await check(
      `${label}: an unparseable answer routes to OCR as invalid JSON`,
      async () => {
        answer('the model apologised instead of answering');
        assertRoutesToOcr(await analyse(service), 'ai_invalid_json');
      }
    );
  }

  for (const { label, service, answerMalformed } of PROVIDERS.filter(
    (p) => p.label !== 'Ollama'
  )) {
    await check(
      `${label}: a payload with no choices routes to OCR`,
      async () => {
        answerMalformed();
        assertRoutesToOcr(
          await analyse(service),
          'ai_invalid_api_response_structure'
        );
      }
    );
  }

  /* Pinned as it is today so the divergence is visible. Ollama words an empty
     payload "No response data from Ollama API", which matches no marker, so
     the document is never queued for OCR while the other three are. When the
     refactor unifies the wording this case starts failing — fold it into the
     loop above then. */
  await check(
    'Ollama: an empty payload does NOT route to OCR (known drift)',
    async () => {
      const ollama = PROVIDERS.find((p) => p.label === 'Ollama');
      ollama.answerMalformed();
      const analysis = await analyse(ollama.service);

      assert.match(analysis.error, /No response data from Ollama API/);
      assert.strictEqual(
        shouldQueueForOcrOnAiError(analysis.error),
        false,
        'Ollama now reaches OCR here — unify the wording and update this case'
      );
    }
  );

  /* Finding 7c: all four providers implement the "insufficient content"
     early return — an unparseable answer containing "i'm sorry" / "i cannot"
     / "insufficient" routes to OCR under that reason, not as invalid JSON. */
  for (const { label, service, answer } of PROVIDERS) {
    await check(
      `${label}: a refusal routes to OCR as insufficient content`,
      async () => {
        answer("I'm sorry, there is insufficient text to analyse.");
        assertRoutesToOcr(await analyse(service), 'ai_insufficient_content');
      }
    );
  }

  /* All four providers raise "could not determine assignable metadata",
     so every one of them routes the document to OCR as an invalid
     response structure. */
  for (const { label, service, answer } of PROVIDERS) {
    await check(
      `${label}: an answer without metadata routes to OCR`,
      async () => {
        answer(JSON.stringify({ note: 'nothing usable here' }));
        assertRoutesToOcr(
          await analyse(service),
          'ai_invalid_response_structure'
        );
      }
    );
  }

  await fs.rm(getThumbnailCachePath(DOCUMENT_ID), { force: true });

  if (failed) {
    console.error(`\n${failed} OCR fallback phrase case(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll OCR fallback phrase cases passed');
})();
