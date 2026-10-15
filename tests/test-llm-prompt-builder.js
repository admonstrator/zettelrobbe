/**
 * The analysis prompt, built once for all four providers.
 *
 * Step 2 of the LLM service refactoring (docs/llm-service-refactoring.md).
 * The %CUSTOMFIELDS% block and the prompt cascade after it — pre-existing
 * data, mustHavePrompt, restriction placeholders, external API data,
 * USE_PROMPT_TAGS and the webhook's custom prompt — used to be copied into
 * every provider service, six times in all. They now live in
 * services/llm/customFieldsTemplate.js and services/llm/promptBuilder.js.
 *
 * The first half pins what the builder produces. The second half checks that
 * every provider really sends what the builder produced, so a provider that
 * keeps a private copy, or drops part of the builder's output, fails here.
 *
 * One drift is resolved on the way and pinned as such: Ollama called its async
 * _validateAndTruncateExternalApiData() without awaiting it and sent
 * "[object Promise]" instead of the external API data.
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

const config = require('../config/config');
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('../services/thumbnailCachePaths');
const {
  buildCustomFieldsBlock,
} = require('../services/llm/customFieldsTemplate');
const { buildAnalysisPrompt } = require('../services/llm/promptBuilder');
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
const DOCUMENT_ID = 'testLlmPromptBuilder';

const SYSTEM_PROMPT =
  'Analyse the document. Tags: %RESTRICTED_TAGS% | Correspondents: %RESTRICTED_CORRESPONDENTS% | Types: %RESTRICTED_DOCUMENT_TYPES%';

const CUSTOM_FIELDS = JSON.stringify({
  custom_fields: [
    { value: 'Due date', data_type: 'date' },
    { value: 'Paid', data_type: 'boolean' },
    { value: 'Amount', data_type: 'monetary' },
  ],
});

// Both shapes reach the services (issue #262): entity objects and plain names.
const TAGS = [
  { id: 1, name: 'invoice' },
  { id: 2, name: 'contract' },
];
const CORRESPONDENTS = [{ id: 7, name: 'Acme Corp' }];
const DOCUMENT_TYPES = ['Offer', 'Notice'];

const ANSWER = JSON.stringify({
  title: 'Telekom invoice July',
  correspondent: 'Telekom Deutschland GmbH',
  tags: ['invoice'],
  document_type: 'Rechnung',
  document_date: '2026-09-03',
  language: 'de',
});

const SETTINGS = {
  env: ['SYSTEM_PROMPT', 'CUSTOM_FIELDS', 'USE_PROMPT_TAGS', 'PROMPT_TAGS'],
  config: [
    'useExistingData',
    'restrictToExistingTags',
    'restrictToExistingCorrespondents',
  ],
};

/** Puts every setting the prompt reads into a known state for one case. */
function arrange({ env = {}, settings = {} } = {}) {
  const values = {
    SYSTEM_PROMPT,
    CUSTOM_FIELDS,
    USE_PROMPT_TAGS: 'no',
    PROMPT_TAGS: '',
    ...env,
  };
  for (const key of SETTINGS.env) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  Object.assign(
    config,
    {
      useExistingData: 'no',
      restrictToExistingTags: 'no',
      restrictToExistingCorrespondents: 'no',
    },
    settings
  );
}

function build(overrides = {}) {
  return buildAnalysisPrompt({
    existingTags: TAGS,
    existingCorrespondentList: CORRESPONDENTS,
    existingDocumentTypesList: DOCUMENT_TYPES,
    ...overrides,
  });
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
  ['OpenAI', openaiService],
  ['Azure', azureService],
  ['Custom', customService],
];

/** The system message a chat provider sends for one analysis. */
async function chatSystemPrompt(service, customPrompt = null, options = {}) {
  const requests = [];
  recordingChatClient(service, requests);
  const analysis = await service.analyzeDocument(
    'Document body text.',
    TAGS,
    CORRESPONDENTS,
    DOCUMENT_TYPES,
    DOCUMENT_ID,
    customPrompt,
    options
  );
  assert.strictEqual(analysis.error, undefined, 'the analysis succeeded');
  assert.strictEqual(requests.length, 1, 'one request was sent');
  const system = requests[0].messages.find((m) => m.role === 'system');
  assert.ok(system, 'the request carries a system message');
  return system.content;
}

/** The prompt Ollama sends for one analysis. */
async function ollamaPrompt(customPrompt = null, options = {}) {
  const requests = [];
  recordingOllamaClient(requests);
  const analysis = await ollamaService.analyzeDocument(
    'Document body text.',
    TAGS,
    CORRESPONDENTS,
    DOCUMENT_TYPES,
    DOCUMENT_ID,
    customPrompt,
    options
  );
  assert.strictEqual(analysis.error, undefined, 'the analysis succeeded');
  assert.strictEqual(requests.length, 1, 'one request was sent');
  return requests[0].prompt;
}

(async () => {
  console.log('\n=== LLM prompt builder ===');

  /* --- the %CUSTOMFIELDS% block ------------------------------------------ */

  await check('the custom fields block gives each data type its hint', () => {
    arrange();
    const block = buildCustomFieldsBlock();
    assert.ok(block.startsWith('"custom_fields": '), block);
    assert.match(block, /"field_name": "Due date"/);
    assert.match(
      block,
      /"value": "Fill in the date in ISO 8601 format \(YYYY-MM-DD\) based on your analysis"/
    );
    assert.match(block, /"field_name": "Paid"/);
    assert.match(
      block,
      /"value": "Fill in 'true' or 'false' based on your analysis"/
    );
    assert.match(block, /"field_name": "Amount"/);
    assert.match(block, /"value": "Fill in the value based on your analysis"/);
  });

  await check(
    'the custom fields block is indented to sit inside the JSON example',
    () => {
      arrange();
      const lines = buildCustomFieldsBlock().split('\n');
      assert.strictEqual(lines[0], '"custom_fields":     {');
      assert.strictEqual(lines[1], '      "0": {');
      assert.strictEqual(lines[lines.length - 1], '    }');
    }
  );

  await check(
    'unreadable or missing CUSTOM_FIELDS yield an empty block',
    () => {
      for (const value of ['{not json', undefined]) {
        arrange({ env: { CUSTOM_FIELDS: value } });
        assert.strictEqual(buildCustomFieldsBlock(), '"custom_fields":     {}');
      }
    }
  );

  /* --- the cascade ------------------------------------------------------- */

  await check(
    'by default: SYSTEM_PROMPT, then mustHavePrompt with the block',
    () => {
      arrange();
      const { systemPrompt, promptTags } = build();
      assert.ok(systemPrompt.startsWith('Analyse the document.'), systemPrompt);
      assert.ok(
        systemPrompt.includes(
          config.mustHavePrompt
            .replace('%CUSTOMFIELDS%', buildCustomFieldsBlock())
            .slice(0, 60)
        ),
        'mustHavePrompt follows the system prompt'
      );
      assert.ok(!systemPrompt.includes('%CUSTOMFIELDS%'));
      assert.ok(!systemPrompt.includes('Pre-existing tags'));
      assert.strictEqual(promptTags, '');
    }
  );

  await check('USE_EXISTING_DATA lists what Paperless-ngx already has', () => {
    arrange({ settings: { useExistingData: 'yes' } });
    const { systemPrompt } = build();
    assert.ok(systemPrompt.includes('Pre-existing tags: invoice, contract'));
    assert.ok(systemPrompt.includes('Pre-existing correspondents: Acme Corp'));
    assert.ok(
      systemPrompt.includes('Pre-existing document types: Offer, Notice')
    );
    assert.ok(!systemPrompt.includes('[object Object]'));
    assert.ok(
      systemPrompt.indexOf('Pre-existing tags') <
        systemPrompt.indexOf('Analyse the document.'),
      'the existing data comes before the system prompt'
    );
  });

  await check('a restriction switches the existing-data block off', () => {
    for (const restriction of [
      'restrictToExistingTags',
      'restrictToExistingCorrespondents',
    ]) {
      arrange({ settings: { useExistingData: 'yes', [restriction]: 'yes' } });
      assert.ok(
        !build().systemPrompt.includes('Pre-existing tags'),
        restriction
      );
    }
  });

  await check('restriction placeholders resolve to the existing names', () => {
    arrange();
    const { systemPrompt } = build();
    assert.ok(systemPrompt.includes('Tags: invoice, contract |'), systemPrompt);
    assert.ok(systemPrompt.includes('Correspondents: Acme Corp |'));
    assert.ok(systemPrompt.includes('Types: Offer, Notice'));
    assert.ok(!systemPrompt.includes('%RESTRICTED_'));
  });

  await check(
    'external API data is appended after the placeholders are resolved',
    () => {
      arrange();
      const { systemPrompt } = build({
        externalApiData: 'IBAN DE00, see %RESTRICTED_TAGS%',
      });
      assert.ok(
        systemPrompt.endsWith(
          '\n\nAdditional context from external API:\nIBAN DE00, see %RESTRICTED_TAGS%'
        ),
        systemPrompt
      );
    }
  );

  await check(
    'USE_PROMPT_TAGS replaces the prompt and hands out PROMPT_TAGS',
    () => {
      arrange({
        env: { USE_PROMPT_TAGS: 'yes', PROMPT_TAGS: 'invoice, bank' },
      });
      const { systemPrompt, promptTags } = build({
        externalApiData: 'ignored',
      });
      assert.ok(
        systemPrompt.includes(
          'Take these tags and try to match one or more to the document content.'
        )
      );
      assert.ok(systemPrompt.endsWith(config.specialPromptPreDefinedTags));
      assert.ok(!systemPrompt.includes('Analyse the document.'));
      assert.ok(!systemPrompt.includes('ignored'));
      assert.strictEqual(promptTags, 'invoice, bank');
    }
  );

  await check(
    'a custom prompt wins over everything, mustHavePrompt still follows',
    () => {
      arrange({
        env: { USE_PROMPT_TAGS: 'yes', PROMPT_TAGS: 'invoice' },
        settings: { useExistingData: 'yes' },
      });
      const { systemPrompt, promptTags } = build({
        customPrompt: 'Webhook prompt.',
        externalApiData: 'ignored',
      });
      assert.strictEqual(
        systemPrompt,
        'Webhook prompt.\n\n' +
          config.mustHavePrompt.replace(
            '%CUSTOMFIELDS%',
            buildCustomFieldsBlock()
          )
      );
      assert.strictEqual(
        promptTags,
        'invoice',
        'the tag list is still reported'
      );
    }
  );

  /* --- every provider sends what the builder built ------------------------ */

  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  await fs.writeFile(
    getThumbnailCachePath(DOCUMENT_ID),
    Buffer.from([0x89, 0x50, 0x4e, 0x47])
  );

  const PROVIDER_CASES = [
    ['by default', {}, {}],
    ['with existing data', { settings: { useExistingData: 'yes' } }, {}],
    ['with a custom prompt', {}, { customPrompt: 'Webhook prompt.' }],
    [
      'with external API data',
      {},
      { externalApiData: { iban: 'DE00', note: 'x' } },
    ],
  ];

  for (const [label, service] of CHAT_PROVIDERS) {
    for (const [name, arrangement, input] of PROVIDER_CASES) {
      await check(
        `${label}: the system message is the builder's ${name}`,
        async () => {
          arrange(arrangement);
          const sent = await chatSystemPrompt(
            service,
            input.customPrompt ?? null,
            input.externalApiData
              ? { externalApiData: input.externalApiData }
              : {}
          );
          const expected = build({
            customPrompt: input.customPrompt ?? null,
            externalApiData: input.externalApiData
              ? JSON.stringify(input.externalApiData, null, 2)
              : null,
          }).systemPrompt;
          assert.strictEqual(sent, expected);
        }
      );
    }
  }

  for (const [name, arrangement, input] of PROVIDER_CASES) {
    await check(
      `Ollama: the prompt starts with the builder's ${name}`,
      async () => {
        arrange(arrangement);
        const sent = await ollamaPrompt(
          input.customPrompt ?? null,
          input.externalApiData
            ? { externalApiData: input.externalApiData }
            : {}
        );
        const expected = build({
          customPrompt: input.customPrompt ?? null,
          externalApiData: input.externalApiData
            ? JSON.stringify(input.externalApiData, null, 2)
            : null,
        }).systemPrompt;
        assert.ok(sent.startsWith(expected), `sent:\n${sent}`);
        assert.ok(
          sent.includes('"Document body text."'),
          'the content follows'
        );
      }
    );
  }

  await check(
    'Ollama: external API data is the data, not "[object Promise]"',
    async () => {
      arrange();
      const sent = await ollamaPrompt(null, {
        externalApiData: { iban: 'DE00' },
      });
      assert.ok(!sent.includes('[object Promise]'), sent);
      assert.ok(sent.includes('"iban": "DE00"'), sent);
    }
  );

  await fs.rm(getThumbnailCachePath(DOCUMENT_ID), { force: true });

  if (failed > 0) {
    console.error(`\n${failed} prompt builder case(s) failed`);
    process.exit(1);
  }
  console.log('\nAll prompt builder cases passed');
})();
