/**
 * The transports: what each API family is sent, and what comes back.
 *
 * Step 5 of the LLM service refactoring (docs/llm-service-refactoring.md).
 * A transport owns exactly one thing — how to talk to one API family — and
 * never shapes an analysis result:
 *
 *   services/llm/transports/chatCompletionsTransport.js  openai, azure, custom
 *   services/llm/transports/ollamaGenerateTransport.js   Ollama /api/generate
 *
 * The first half pins each transport on its own with a fake client. The
 * second half checks that every provider's analysis request goes through its
 * transport and is mapped the way it was before: OpenAI omits the
 * temperature for o3-mini, Azure sends the configured analysis
 * temperature (Finding 7a, step 6), Ollama sends format, num_ctx,
 * num_predict and think:false unless OLLAMA_THINK is set.
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
delete process.env.OLLAMA_API_KEY;

const config = require('../config/config');
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('../services/thumbnailCachePaths');
const {
  ChatCompletionsTransport,
} = require('../services/llm/transports/chatCompletionsTransport');
const {
  OllamaGenerateTransport,
} = require('../services/llm/transports/ollamaGenerateTransport');
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
const DOCUMENT_ID = 'testLlmTransportMapping';

const ANSWER = JSON.stringify({
  title: 'Telekom invoice July',
  correspondent: 'Telekom Deutschland GmbH',
  tags: ['invoice'],
  document_type: 'Rechnung',
  document_date: '2026-09-03',
  language: 'de',
});

function completion(content = ANSWER, finishReason = 'stop') {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
  };
}

function fakeChatClient(requests, respond = async () => completion()) {
  return {
    chat: {
      completions: {
        create: async (request) => {
          requests.push(request);
          return respond(request);
        },
      },
    },
    models: { list: async () => ({ data: [] }) },
  };
}

function ollamaData(overrides = {}) {
  return {
    response: ANSWER,
    done_reason: 'stop',
    eval_count: 3,
    prompt_eval_count: 9,
    ...overrides,
  };
}

/** An axios-shaped client; `answers` are returned or thrown in turn. */
function fakeOllamaClient(answers, posts) {
  let next = 0;
  return {
    post: async (url, body, requestConfig) => {
      posts.push({ url, body, requestConfig });
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    get: async () => ({ status: 200, data: { models: [] } }),
  };
}

function axiosFailure(status, data) {
  const error = new Error(
    status ? `Request failed with status code ${status}` : 'socket hang up'
  );
  error.code = status ? 'ERR_BAD_RESPONSE' : 'ECONNRESET';
  if (status) error.response = { status, data };
  return error;
}

const ANALYSIS_REQUEST = {
  systemPrompt: 'You analyse documents.',
  userContent: 'Invoice from Telekom.',
  model: 'gpt-4',
  temperature: 0.2,
};

(async () => {
  console.log('\n=== LLM transport request mapping ===');

  /* --- ChatCompletionsTransport -------------------------------------------- */

  await check('chat: the client is created once, on first use', () => {
    let created = 0;
    const transport = new ChatCompletionsTransport({
      label: 'Fake',
      createClient: () => {
        created += 1;
        return fakeChatClient([]);
      },
    });
    assert.strictEqual(transport.isReady(), false);
    transport.initialize();
    transport.initialize();
    assert.strictEqual(created, 1);
    assert.strictEqual(transport.isReady(), true);
  });

  await check('chat: a factory without credentials leaves it not ready', () => {
    const transport = new ChatCompletionsTransport({
      label: 'Fake',
      createClient: () => null,
    });
    transport.initialize();
    assert.strictEqual(transport.isReady(), false);
    assert.strictEqual(transport.client, null);
  });

  await check('chat: sends a system and a user message', async () => {
    const requests = [];
    const transport = new ChatCompletionsTransport({
      label: 'Fake',
      createClient: () => fakeChatClient(requests),
    });
    transport.initialize();
    await transport.complete(ANALYSIS_REQUEST);
    assert.deepStrictEqual(requests, [
      {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You analyse documents.' },
          { role: 'user', content: 'Invoice from Telekom.' },
        ],
        temperature: 0.2,
      },
    ]);
  });

  await check('chat: an undefined temperature is not sent at all', async () => {
    const requests = [];
    const transport = new ChatCompletionsTransport({
      label: 'Fake',
      createClient: () => fakeChatClient(requests),
    });
    transport.initialize();
    await transport.complete({ ...ANALYSIS_REQUEST, temperature: undefined });
    assert.ok(!('temperature' in requests[0]), JSON.stringify(requests[0]));
  });

  await check('chat: returns the text and the usage as metrics', async () => {
    const transport = new ChatCompletionsTransport({
      label: 'Fake',
      createClient: () => fakeChatClient([]),
    });
    transport.initialize();
    const result = await transport.complete(ANALYSIS_REQUEST);
    assert.deepStrictEqual(result, {
      payload: ANSWER,
      metrics: { promptTokens: 9, completionTokens: 3, totalTokens: 12 },
    });
  });

  await check('chat: a cut-off answer is ai_response_truncated', async () => {
    const transport = new ChatCompletionsTransport({
      label: 'Fake',
      createClient: () =>
        fakeChatClient([], async () => completion('{"tags": [', 'length')),
    });
    transport.initialize();
    await assert.rejects(
      () => transport.complete(ANALYSIS_REQUEST),
      (error) => error.code === 'ai_response_truncated'
    );
  });

  await check(
    'chat: no content is "Invalid API response structure"',
    async () => {
      const transport = new ChatCompletionsTransport({
        label: 'Fake',
        createClient: () => fakeChatClient([], async () => ({ choices: [] })),
      });
      transport.initialize();
      await assert.rejects(
        () => transport.complete(ANALYSIS_REQUEST),
        (error) => error.message === 'Invalid API response structure'
      );
    }
  );

  await check(
    'chat: a provider may describe the missing content itself',
    async () => {
      const transport = new ChatCompletionsTransport({
        label: 'Fake',
        createClient: () => fakeChatClient([], async () => ({ choices: [] })),
        describeMissingContent: (response) =>
          `Invalid API response structure: ${response.choices.length} choices.`,
      });
      transport.initialize();
      await assert.rejects(
        () => transport.complete(ANALYSIS_REQUEST),
        (error) =>
          error.message === 'Invalid API response structure: 0 choices.'
      );
    }
  );

  /* --- OllamaGenerateTransport --------------------------------------------- */

  const ollamaTransport = (answers, posts, options = {}) =>
    new OllamaGenerateTransport({
      client: fakeOllamaClient(answers, posts),
      apiUrl: 'http://ollama.invalid:11434',
      model: 'llama3',
      retryDelayMs: 1,
      ...options,
    });

  const OLLAMA_REQUEST = {
    systemPrompt: 'system',
    userContent: 'prompt',
    temperature: 0.2,
    maxResponseTokens: 700,
    numCtx: 4096,
    schema: { type: 'object' },
  };

  await check('ollama: maps the request onto /api/generate', async () => {
    const posts = [];
    const previousThink = config.ollama.think;
    config.ollama.think = false;
    try {
      await ollamaTransport([{ data: ollamaData() }], posts).complete(
        OLLAMA_REQUEST
      );
    } finally {
      config.ollama.think = previousThink;
    }
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(
      posts[0].url,
      'http://ollama.invalid:11434/api/generate'
    );
    assert.deepStrictEqual(posts[0].body, {
      model: 'llama3',
      prompt: 'prompt',
      system: 'system',
      stream: false,
      format: { type: 'object' },
      options: {
        temperature: 0.2,
        top_p: 0.9,
        repeat_penalty: 1.1,
        top_k: 7,
        num_predict: 700,
        num_ctx: 4096,
      },
      think: false,
    });
    assert.deepStrictEqual(posts[0].requestConfig, {
      headers: { 'Content-Type': 'application/json' },
    });
  });

  await check('ollama: OLLAMA_THINK=true sends no think field', async () => {
    const posts = [];
    const previousThink = config.ollama.think;
    config.ollama.think = true;
    try {
      await ollamaTransport([{ data: ollamaData() }], posts).complete(
        OLLAMA_REQUEST
      );
    } finally {
      config.ollama.think = previousThink;
    }
    assert.ok(!('think' in posts[0].body), JSON.stringify(posts[0].body));
  });

  await check('ollama: an API key becomes a bearer header', async () => {
    const posts = [];
    process.env.OLLAMA_API_KEY = 'secret';
    try {
      await ollamaTransport([{ data: ollamaData() }], posts).complete(
        OLLAMA_REQUEST
      );
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
    assert.strictEqual(
      posts[0].requestConfig.headers.Authorization,
      'Bearer secret'
    );
  });

  await check(
    'ollama: returns the answer, its metrics and the raw data',
    async () => {
      const data = ollamaData();
      const result = await ollamaTransport([{ data }], []).complete(
        OLLAMA_REQUEST
      );
      assert.strictEqual(result.payload, ANSWER);
      assert.deepStrictEqual(result.metrics, {
        promptTokens: 9,
        completionTokens: 3,
        totalTokens: 12,
      });
      assert.strictEqual(result.raw, data);
    }
  );

  await check(
    'ollama: a 5xx is tried once more, and the second answer wins',
    async () => {
      const posts = [];
      const result = await ollamaTransport(
        [axiosFailure(500, { error: 'EOF' }), { data: ollamaData() }],
        posts
      ).complete(OLLAMA_REQUEST);
      assert.strictEqual(posts.length, 2);
      assert.strictEqual(result.payload, ANSWER);
    }
  );

  await check(
    'ollama: a 4xx is not retried and names the upstream cause',
    async () => {
      const posts = [];
      await assert.rejects(
        () =>
          ollamaTransport(
            [axiosFailure(404, { error: 'model "llama3" not found' })],
            posts
          ).complete(OLLAMA_REQUEST),
        (error) =>
          error.message ===
            'Ollama request failed (HTTP 404, attempt 1): model "llama3" not found' &&
          error.code === 'ERR_BAD_RESPONSE'
      );
      assert.strictEqual(posts.length, 1);
    }
  );

  await check(
    'ollama: no response at all is retried, then reported',
    async () => {
      const posts = [];
      await assert.rejects(
        () =>
          ollamaTransport([axiosFailure(null)], posts).complete(OLLAMA_REQUEST),
        (error) =>
          error.message ===
            'Ollama request failed (HTTP no response, attempt 2)' &&
          error.code === 'ECONNRESET'
      );
      assert.strictEqual(posts.length, 2);
    }
  );

  await check(
    'ollama: done_reason "length" is ai_response_truncated',
    async () => {
      await assert.rejects(
        () =>
          ollamaTransport(
            [{ data: ollamaData({ done_reason: 'length', eval_count: 700 }) }],
            []
          ).complete(OLLAMA_REQUEST),
        (error) =>
          error.code === 'ai_response_truncated' &&
          /Raise Response Tokens \(RESPONSE_TOKENS\) above 700/.test(
            error.message
          )
      );
    }
  );

  await check(
    'ollama: an empty HTTP body is "Invalid response from Ollama API"',
    async () => {
      await assert.rejects(
        () => ollamaTransport([{ data: null }], []).complete(OLLAMA_REQUEST),
        (error) => error.message === 'Invalid response from Ollama API'
      );
    }
  );

  /* --- every provider's analysis goes through its transport ---------------- */

  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  await fs.writeFile(getThumbnailCachePath(DOCUMENT_ID), 'thumbnail');
  Object.assign(config, { tokenLimit: 128000, responseTokens: 1000 });

  const analyse = (service) =>
    service.analyzeDocument('Invoice from Telekom.', [], [], [], DOCUMENT_ID);

  for (const [label, service, transportLabel] of [
    ['OpenAI', openaiService, 'OpenAI'],
    ['Azure', azureService, 'AzureOpenAI'],
    ['Custom', customService, 'Custom OpenAI'],
  ]) {
    await check(`${label}: owns a chat completions transport`, () => {
      assert.ok(service.transport instanceof ChatCompletionsTransport);
      assert.strictEqual(service.transport.label, transportLabel);
    });

    await check(`${label}: the client it is given is the transport's`, () => {
      const client = fakeChatClient([]);
      service.client = client;
      assert.strictEqual(service.transport.client, client);
      assert.strictEqual(service.client, client);
    });
  }

  await check('OpenAI: analysis sends AI_TEMPERATURE_ANALYSIS', async () => {
    const requests = [];
    openaiService.client = fakeChatClient(requests);
    const analysis = await analyse(openaiService);
    assert.strictEqual(analysis.error, undefined, analysis.error);
    assert.strictEqual(requests[0].model, 'gpt-4');
    assert.strictEqual(requests[0].temperature, config.aiTemperatureAnalysis);
    assert.deepStrictEqual(
      requests[0].messages.map((m) => m.role),
      ['system', 'user']
    );
  });

  await check(
    'OpenAI: analysis with o3-mini sends no temperature',
    async () => {
      const requests = [];
      openaiService.client = fakeChatClient(requests);
      process.env.OPENAI_MODEL = 'o3-mini';
      try {
        await analyse(openaiService);
      } finally {
        process.env.OPENAI_MODEL = 'gpt-4';
      }
      assert.strictEqual(requests[0].model, 'o3-mini');
      assert.ok(!('temperature' in requests[0]), JSON.stringify(requests[0]));
    }
  );

  // Finding 7h: the factory hands out openaiService for the openai provider
  // (and as its default) only, so OpenAI builds no client for Ollama or
  // Custom — those have composition roots of their own.
  await check(
    'OpenAI: builds an OpenAI client for the openai provider only (7h)',
    () => {
      const previousProvider = config.aiProvider;
      const build = (provider) => {
        config.aiProvider = provider;
        openaiService.client = null;
        openaiService.transport.initialize();
        return openaiService.client;
      };
      try {
        assert.match(build('openai').baseURL, /api\.openai\.com/);
        for (const provider of ['ollama', 'custom', 'azure', 'unknown']) {
          assert.strictEqual(build(provider), null, provider);
        }
      } finally {
        config.aiProvider = previousProvider;
        openaiService.client = null;
      }
    }
  );

  await check(
    'Azure: analysis sends AI_TEMPERATURE_ANALYSIS (7a)',
    async () => {
      const requests = [];
      azureService.client = fakeChatClient(requests);
      await analyse(azureService);
      assert.strictEqual(requests[0].model, 'test-deployment');
      assert.strictEqual(requests[0].temperature, config.aiTemperatureAnalysis);
    }
  );

  await check('Custom: analysis sends AI_TEMPERATURE_ANALYSIS', async () => {
    const requests = [];
    customService.client = fakeChatClient(requests);
    await analyse(customService);
    assert.strictEqual(requests[0].model, config.custom.model);
    assert.strictEqual(requests[0].temperature, config.aiTemperatureAnalysis);
  });

  await check(
    'Custom: keeps its detailed missing-content message',
    async () => {
      customService.client = fakeChatClient([], async () => ({ choices: [] }));
      const analysis = await analyse(customService);
      assert.strictEqual(
        analysis.error,
        'Invalid API response structure: missing choices[0].'
      );
    }
  );

  await check('Ollama: owns a generate transport', () => {
    assert.ok(ollamaService.transport instanceof OllamaGenerateTransport);
  });

  await check("Ollama: client, apiUrl and model are the transport's", () => {
    const client = fakeOllamaClient([{ data: ollamaData() }], []);
    const previous = {
      apiUrl: ollamaService.apiUrl,
      model: ollamaService.model,
    };
    ollamaService.client = client;
    ollamaService.apiUrl = 'http://elsewhere.invalid';
    ollamaService.model = 'other-model';
    try {
      assert.strictEqual(ollamaService.transport.client, client);
      assert.strictEqual(
        ollamaService.transport.apiUrl,
        'http://elsewhere.invalid'
      );
      assert.strictEqual(ollamaService.transport.model, 'other-model');
    } finally {
      Object.assign(ollamaService, previous);
    }
  });

  await check(
    'Ollama: analysis sends format, num_ctx and num_predict',
    async () => {
      const posts = [];
      ollamaService.client = fakeOllamaClient([{ data: ollamaData() }], posts);
      const analysis = await analyse(ollamaService);
      assert.strictEqual(analysis.error, undefined, analysis.error);
      const { body } = posts[0];
      assert.deepStrictEqual(body.format, ollamaService.documentAnalysisSchema);
      assert.strictEqual(body.model, ollamaService.model);
      assert.strictEqual(body.options.num_predict, 1000);
      assert.strictEqual(
        body.options.num_ctx,
        Math.min(Math.ceil(body.prompt.length / 2) + 1000, 128000)
      );
      assert.strictEqual(
        body.options.temperature,
        config.aiTemperatureAnalysis
      );
    }
  );

  /* --- generateText(): the shared half in the transport (step 5b) ---------- */

  const generationTransport = (respond, generation = {}) => {
    const requests = [];
    const calls = [];
    const transport = new ChatCompletionsTransport({
      label: 'Fake',
      createClient: () => ({
        chat: {
          completions: {
            create: async (request, requestOptions) => {
              requests.push(request);
              calls.push(requestOptions);
              return respond(request);
            },
          },
        },
      }),
      generation: {
        notReadyMessage: 'Fake client not initialized - missing API key',
        remedy: 'Raise Response Tokens (RESPONSE_TOKENS).',
        buildRequest: async (prompt) => ({
          model: 'fake-model',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
        }),
        ...generation,
      },
    });
    return { transport, requests, calls };
  };

  await check('chat generate: sends what the provider built', async () => {
    const { transport, requests, calls } = generationTransport(async () =>
      completion('<think>hm</think>The answer.')
    );
    const text = await transport.generate('hello');
    assert.strictEqual(text, 'The answer.');
    assert.deepStrictEqual(requests, [
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.7,
      },
    ]);
    assert.deepStrictEqual(calls, [undefined], 'no request options');
    assert.deepStrictEqual(transport.lastGenerateTextUsage, {
      promptTokens: 9,
      completionTokens: 3,
      totalTokens: 12,
      reasoningTokens: null,
    });
  });

  await check(
    'chat generate: a signal rides in the request options',
    async () => {
      const { transport, calls } = generationTransport(async () =>
        completion('ok')
      );
      const controller = new AbortController();
      await transport.generate('hello', { signal: controller.signal });
      assert.deepStrictEqual(calls, [{ signal: controller.signal }]);
    }
  );

  await check('chat generate: not ready names the provider', async () => {
    const transport = new ChatCompletionsTransport({
      label: 'Fake',
      createClient: () => null,
      generation: {
        notReadyMessage: 'Fake client not initialized - missing API key',
        buildRequest: async () => ({}),
      },
    });
    await assert.rejects(
      () => transport.generate('hello'),
      (error) =>
        error.message === 'Fake client not initialized - missing API key'
    );
  });

  await check(
    'chat generate: no text is "Invalid API response structure"',
    async () => {
      const { transport } = generationTransport(async () => completion(''));
      await assert.rejects(
        () => transport.generate('hello'),
        (error) => error.message === 'Invalid API response structure'
      );
    }
  );

  await check(
    'chat generate: a provider may describe the empty answer',
    async () => {
      const { transport } = generationTransport(async () => completion(''), {
        describeEmptyText: () => 'Invalid API response structure: empty.',
      });
      await assert.rejects(
        () => transport.generate('hello'),
        (error) => error.message === 'Invalid API response structure: empty.'
      );
    }
  );

  await check('chat generate: a cut-off answer keeps its prefix', async () => {
    const { transport } = generationTransport(async () =>
      completion('Half an ans', 'length')
    );
    await assert.rejects(
      () => transport.generate('hello'),
      (error) =>
        error.code === 'ai_response_truncated' &&
        error.partialText === 'Half an ans' &&
        /Raise Response Tokens/.test(error.message)
    );
  });

  await check(
    'ollama generate: maps the request onto /api/generate',
    async () => {
      const posts = [];
      const previousThink = config.ollama.think;
      config.ollama.think = false;
      let text;
      try {
        text = await ollamaTransport(
          [{ data: ollamaData({ response: '<think>x</think> Hi there. ' }) }],
          posts
        ).generate('hello', {}, { responseTokens: 300, numCtx: 2048 });
      } finally {
        config.ollama.think = previousThink;
      }
      assert.strictEqual(text, 'Hi there.');
      assert.deepStrictEqual(posts[0].body, {
        model: 'llama3',
        prompt: 'hello',
        system:
          "You are a helpful assistant. Generate a clear, concise, and informative response to the user's question or request.",
        stream: false,
        options: {
          temperature: config.aiTemperatureGeneration,
          top_p: 0.9,
          num_predict: 300,
          num_ctx: 2048,
        },
        think: false,
      });
    }
  );

  await check(
    'ollama generate: options override model, system, temperature, think',
    async () => {
      const posts = [];
      await ollamaTransport(
        [{ data: ollamaData({ response: 'ok' }) }],
        posts
      ).generate(
        'hello',
        {
          model: 'judge',
          systemPrompt: 'Be brief.',
          temperature: 0,
          reasoning: true,
        },
        { responseTokens: 300, numCtx: 2048 }
      );
      const { body } = posts[0];
      assert.strictEqual(body.model, 'judge');
      assert.strictEqual(body.system, 'Be brief.');
      assert.strictEqual(body.options.temperature, 0);
      assert.strictEqual(body.think, true);
    }
  );

  await check('ollama generate: records the usage it was told', async () => {
    const transport = ollamaTransport(
      [{ data: ollamaData({ response: 'ok' }) }],
      []
    );
    await transport.generate(
      'hello',
      {},
      { responseTokens: 300, numCtx: 2048 }
    );
    assert.deepStrictEqual(transport.lastGenerateTextUsage, {
      promptTokens: 9,
      completionTokens: 3,
      totalTokens: 12,
    });
  });

  await check(
    'ollama generate: a signal rides in the axios config',
    async () => {
      const posts = [];
      const controller = new AbortController();
      await ollamaTransport(
        [{ data: ollamaData({ response: 'ok' }) }],
        posts
      ).generate(
        'hello',
        { signal: controller.signal },
        { responseTokens: 300, numCtx: 2048 }
      );
      assert.strictEqual(posts[0].requestConfig.signal, controller.signal);
    }
  );

  await check(
    'ollama generate: reasoning false overrules OLLAMA_THINK',
    async () => {
      const posts = [];
      const previousThink = config.ollama.think;
      config.ollama.think = true;
      try {
        await ollamaTransport(
          [{ data: ollamaData({ response: 'ok' }) }],
          posts
        ).generate(
          'hello',
          { reasoning: false },
          { responseTokens: 300, numCtx: 2048 }
        );
      } finally {
        config.ollama.think = previousThink;
      }
      assert.strictEqual(posts[0].body.think, false);
    }
  );

  await check(
    'Custom: an empty generated answer says what came back',
    async () => {
      customService.client = fakeChatClient([], async () =>
        completion('', 'stop')
      );
      await assert.rejects(
        () => customService.generateText('hello'),
        (error) =>
          error.message.startsWith(
            'Invalid API response structure: the answer carried no text (finish_reason stop; the response begins {"choices"'
          )
      );
    }
  );

  /* --- every provider's generateText() goes through its transport ---------- */

  for (const [label, service] of [
    ['OpenAI', openaiService],
    ['Azure', azureService],
    ['Custom', customService],
    ['Ollama', ollamaService],
  ]) {
    await check(
      `${label}: generateText() is the transport's generate()`,
      async () => {
        const original = service.transport.generate;
        const seen = [];
        service.transport.generate = async function (...args) {
          seen.push(args);
          this.lastGenerateTextUsage = { totalTokens: 42 };
          return 'from the transport';
        };
        try {
          const text = await service.generateText('hello', { temperature: 0 });
          assert.strictEqual(text, 'from the transport');
          assert.strictEqual(seen.length, 1);
          assert.strictEqual(seen[0][0], 'hello');
          assert.deepStrictEqual(seen[0][1], { temperature: 0 });
          assert.deepStrictEqual(service.lastGenerateTextUsage, {
            totalTokens: 42,
          });
        } finally {
          service.transport.generate = original;
        }
      }
    );
  }

  await check(
    "Ollama: generateText() hands the service's numbers on",
    async () => {
      const original = ollamaService.transport.generate;
      let budget;
      ollamaService.transport.generate = async (prompt, options, numbers) => {
        budget = numbers;
        return 'ok';
      };
      try {
        Object.assign(config, { tokenLimit: 1000, responseTokens: 400 });
        await ollamaService.generateText('x'.repeat(2000), { maxTokens: 250 });
      } finally {
        ollamaService.transport.generate = original;
        Object.assign(config, { tokenLimit: 128000, responseTokens: 1000 });
      }
      assert.deepStrictEqual(budget, { responseTokens: 250, numCtx: 1000 });
    }
  );

  await fs.rm(getThumbnailCachePath(DOCUMENT_ID), { force: true });

  if (failed > 0) {
    console.error(`\n${failed} transport request mapping case(s) failed`);
    process.exit(1);
  }
  console.log('\nAll transport request mapping cases passed');
})();
