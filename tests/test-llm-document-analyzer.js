/**
 * The DocumentAnalyzer on its own, every collaborator a fake.
 *
 * Step 6 of the LLM service refactoring (docs/llm-service-refactoring.md):
 * the four providers are composition roots over this one class, so the order
 * of its steps is the business logic of all four. The provider suites
 * (llm-analysis-result-contract, llm-provider-parity, ...) pin the outcome
 * through the real singletons; this one pins what the analyzer asks of its
 * collaborators, which those suites cannot see.
 */

const assert = require('assert');

process.env.SYSTEM_PROMPT = 'Analyse the document.';
process.env.USE_PROMPT_TAGS = 'no';
process.env.RESPONSE_TOKENS = '700';

const { DocumentAnalyzer } = require('../services/llm/documentAnalyzer');
const responseParser = require('../services/llm/responseParser');

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

const METRICS = { promptTokens: 9, completionTokens: 3, totalTokens: 12 };
const ANSWER = JSON.stringify({ tags: ['invoice'], correspondent: 'Telekom' });

/** An analyzer whose collaborators record what they were asked. */
function analyzer({ payload = ANSWER, ...overrides } = {}) {
  const calls = { complete: [], reserve: [], fit: [], prompt: [], cut: [] };
  const transport = {
    client: {},
    lastGenerateTextUsage: null,
    initialize() {},
    isReady() {
      return Boolean(this.client);
    },
    async complete(request) {
      calls.complete.push(request);
      if (payload instanceof Error) throw payload;
      return { payload, metrics: METRICS };
    },
    async generate(...args) {
      calls.generate = args;
      return 'generated';
    },
  };
  const subject = new DocumentAnalyzer({
    label: 'Fake',
    transport,
    tokenBudget: {
      async reserve(frame, extras, model) {
        calls.reserve.push({ frame, extras, model });
        return { availableTokens: 4 };
      },
      async fit(content, availableTokens) {
        calls.fit.push({ content, availableTokens });
        return content.slice(0, availableTokens);
      },
      count: (text) => text.length,
      cut: (text, maxTokens) => {
        calls.cut.push(maxTokens);
        return text.slice(0, maxTokens);
      },
    },
    promptLayout: {
      frame: (instructions) => `frame:${instructions}`,
      build: (instructions, content) => ({
        systemPrompt: `system:${instructions}`,
        userContent: `user:${content}`,
      }),
    },
    promptBuilder: {
      buildAnalysisPrompt(input) {
        calls.prompt.push(input);
        return { systemPrompt: 'instructions', promptTags: '' };
      },
    },
    responseParser,
    resolveModel: () => 'fake-model',
    checkStatus: async (provider) => ({ status: 'ok', provider }),
    clientNotReadyMessage: 'Fake client not initialized',
    cacheThumbnail: async () => false,
    ...overrides,
  });
  return { subject, transport, calls };
}

(async () => {
  console.log('\n=== LLM DocumentAnalyzer ===');

  await check('the request is laid out, budgeted and sent once', async () => {
    const { subject, calls } = analyzer({
      analysisTemperature: (model) => (model === 'fake-model' ? 0.4 : 1),
      responseSchema: { type: 'object' },
      contextWindow: (text, responseTokens) => text.length + responseTokens,
    });
    const result = await subject.analyzeDocument('abcdefgh', [], [], [], 1);

    assert.strictEqual(result.error, undefined, result.error);
    assert.deepStrictEqual(calls.reserve, [
      { frame: 'frame:instructions', extras: [], model: 'fake-model' },
    ]);
    assert.deepStrictEqual(calls.complete, [
      {
        systemPrompt: 'system:instructions',
        userContent: 'user:abcd',
        model: 'fake-model',
        temperature: 0.4,
        maxResponseTokens: 700,
        schema: { type: 'object' },
        numCtx: 'user:abcd'.length + 700,
      },
    ]);
  });

  await check('a success is default-shaped and knows it was cut', async () => {
    const { subject } = analyzer();
    const result = await subject.analyzeDocument('abcdefgh', [], [], [], 1);
    assert.deepStrictEqual(result, {
      document: {
        tags: ['invoice'],
        correspondent: 'Telekom',
        title: null,
        document_date: null,
        document_type: null,
        language: null,
        custom_fields: null,
      },
      metrics: METRICS,
      truncated: true,
    });
  });

  await check('without a context window no numCtx is sent', async () => {
    const { subject, calls } = analyzer();
    await subject.analyzeDocument('abc', [], [], [], 1);
    assert.strictEqual(calls.complete[0].numCtx, undefined);
    assert.strictEqual(calls.complete[0].schema, null);
  });

  await check(
    'the metadata check sees the answer before the defaults',
    async () => {
      const { subject } = analyzer({ payload: '{"title": "only a title"}' });
      const result = await subject.analyzeDocument('abc', [], [], [], 1);
      assert.match(result.error, /could not determine assignable metadata/);
      assert.deepStrictEqual(result.document, {
        tags: [],
        correspondent: null,
      });
    }
  );

  await check('a refusal returns the placeholder with its tokens', async () => {
    const { subject } = analyzer({ payload: "I'm sorry, I cannot." });
    const result = await subject.analyzeDocument('abc', [], [], [], 7);
    assert.strictEqual(result.error, 'Insufficient content for AI analysis');
    assert.strictEqual(result.document.title, 'Document 7');
    assert.deepStrictEqual(result.metrics, METRICS);
  });

  await check(
    'a refusal phrase inside readable JSON is no refusal',
    async () => {
      const { subject } = analyzer({
        payload: JSON.stringify({
          tags: ['insufficient funds'],
          correspondent: null,
        }),
      });
      const result = await subject.analyzeDocument('abc', [], [], [], 1);
      assert.strictEqual(result.error, undefined, result.error);
      assert.deepStrictEqual(result.document.tags, ['insufficient funds']);
    }
  );

  await check('without a client nothing is sent', async () => {
    const { subject, transport, calls } = analyzer();
    transport.client = null;
    const result = await subject.analyzeDocument('abc', [], [], [], 1);
    assert.strictEqual(result.error, 'Fake client not initialized');
    assert.strictEqual(calls.complete.length, 0);
  });

  await check(
    'a transport failure is returned, reworded by the provider',
    async () => {
      const failure = new Error('socket hang up');
      failure.code = 'ECONNRESET';
      const { subject } = analyzer({
        payload: failure,
        describeFailure: (error) => `reworded: ${error.message}`,
      });
      const result = await subject.analyzeDocument('abc', [], [], [], 1);
      assert.deepStrictEqual(result, {
        document: { tags: [], correspondent: null },
        metrics: null,
        error: 'reworded: socket hang up',
        errorCode: 'ECONNRESET',
      });
    }
  );

  await check(
    'the provider cut comes first and does not count as truncation',
    async () => {
      const { subject, calls } = analyzer({
        prepareContent: (content) => content.slice(0, 3),
      });
      const result = await subject.analyzeDocument('abcdefgh', [], [], [], 1);
      assert.strictEqual(calls.fit[0].content, 'abc');
      assert.strictEqual(result.truncated, false);
    }
  );

  await check('external API data is cut to its token share', async () => {
    const { subject, calls } = analyzer();
    await subject.analyzeDocument('abc', [], [], [], 1, null, {
      externalApiData: 'x'.repeat(600),
    });
    assert.deepStrictEqual(calls.cut, [500]);
    assert.strictEqual(calls.prompt[0].externalApiData, 'x'.repeat(500));
  });

  await check('the custom prompt reaches the prompt builder', async () => {
    const { subject, calls } = analyzer();
    await subject.analyzeDocument('abc', ['t'], ['c'], ['d'], 1, 'Custom.');
    assert.deepStrictEqual(calls.prompt[0], {
      existingTags: ['t'],
      existingCorrespondentList: ['c'],
      existingDocumentTypesList: ['d'],
      externalApiData: null,
      customPrompt: 'Custom.',
    });
  });

  await check('generateText() is handed on as it came', async () => {
    const { subject, calls } = analyzer();
    const options = { maxTokens: 5 };
    assert.strictEqual(await subject.generateText('hi', options), 'generated');
    assert.deepStrictEqual(calls.generate, ['hi', options]);
  });

  await check(
    'generateText() gets its sizes where the provider sizes the context',
    async () => {
      const { subject, calls } = analyzer({
        contextWindow: (text, responseTokens) =>
          text.length * 100 + responseTokens,
      });
      await subject.generateText('hi', { maxTokens: 50.9 });
      assert.deepStrictEqual(calls.generate[2], {
        responseTokens: 50,
        numCtx: 250,
      });
      await subject.generateText('hi');
      assert.deepStrictEqual(calls.generate[2], {
        responseTokens: 700,
        numCtx: 900,
      });
    }
  );

  await check(
    'checkStatus() runs the provider probe on the provider',
    async () => {
      const { subject } = analyzer();
      const status = await subject.checkStatus();
      assert.strictEqual(status.provider, subject);
    }
  );

  await check('client and lastGenerateTextUsage are the transport’s', () => {
    const { subject, transport } = analyzer();
    const client = {};
    subject.client = client;
    subject.lastGenerateTextUsage = METRICS;
    assert.strictEqual(transport.client, client);
    assert.strictEqual(transport.lastGenerateTextUsage, METRICS);
  });

  if (failed > 0) {
    console.error(`\n${failed} DocumentAnalyzer case(s) failed`);
    process.exit(1);
  }
  console.log('\nAll DocumentAnalyzer cases passed');
})();
