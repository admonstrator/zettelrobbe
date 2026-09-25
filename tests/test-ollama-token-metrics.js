const assert = require('assert');

const configModulePath = require.resolve('../config/config');
const ollamaServiceModulePath = require.resolve('../services/ollamaService');
const axiosModulePath = require.resolve('axios');

const originalAxiosExport = require.cache[axiosModulePath]?.exports;

function restoreModules() {
  delete require.cache[configModulePath];
  delete require.cache[ollamaServiceModulePath];
  delete require.cache[axiosModulePath];

  if (typeof originalAxiosExport !== 'undefined') {
    require.cache[axiosModulePath] = {
      id: axiosModulePath,
      filename: axiosModulePath,
      loaded: true,
      exports: originalAxiosExport,
    };
  }
}

function loadOllamaServiceWithAxiosMock(axiosMock) {
  delete require.cache[configModulePath];
  delete require.cache[ollamaServiceModulePath];
  delete require.cache[axiosModulePath];

  require.cache[axiosModulePath] = {
    id: axiosModulePath,
    filename: axiosModulePath,
    loaded: true,
    exports: axiosMock,
  };

  return require('../services/ollamaService');
}

async function main() {
  const payloads = [
    {
      response: {
        tags: ['invoice'],
        correspondent: 'ACME',
        title: 'Invoice',
        document_date: '2026-01-01',
        document_type: 'Invoice',
        language: 'en',
      },
      prompt_eval_count: 4913,
      eval_count: 84,
    },
  ];

  const axiosMock = {
    create() {
      return {
        post: async () => ({ data: payloads.shift() }),
      };
    },
  };

  try {
    const ollamaService = loadOllamaServiceWithAxiosMock(axiosMock);

    const analysis = await ollamaService.analyzeDocument(
      'content',
      [],
      [],
      [],
      '123'
    );
    assert.deepStrictEqual(
      analysis.metrics,
      { promptTokens: 4913, completionTokens: 84, totalTokens: 4997 },
      'Expected analyzeDocument to map Ollama token counters'
    );

    const fallbackMetrics = ollamaService._extractOllamaMetrics({});
    assert.deepStrictEqual(
      fallbackMetrics,
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      'Expected safe zero fallback when counters are missing'
    );
  } finally {
    restoreModules();
  }
}

main()
  .then(() => {
    console.log('[PASS] Ollama token metrics are mapped from API counters');
  })
  .catch((error) => {
    console.error('[FAIL] Ollama token metrics test failed:', error.message);
    process.exitCode = 1;
  });
