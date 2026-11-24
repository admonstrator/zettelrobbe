const assert = require('assert');

const configModulePath = require.resolve('../config/config');
const ollamaServiceModulePath = require.resolve('../services/ollamaService');
const axiosModulePath = require.resolve('axios');

const originalEnv = { ...process.env };
const originalAxiosExport = require.cache[axiosModulePath]?.exports;

function restoreEnvironment() {
  process.env = originalEnv;
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
  const capturedRequests = [];

  const axiosMock = {
    create() {
      return {
        post: async (_url, requestBody) => {
          capturedRequests.push(requestBody);

          return {
            data: {
              response: {
                tags: [],
                correspondent: null,
                title: '',
                document_date: '',
                document_type: '',
                language: '',
              },
            },
          };
        },
      };
    },
  };

  try {
    process.env.AI_TEMPERATURE_ANALYSIS = '0.2';
    // Removed setting: an older installation may still have it set, and it
    // must not reach a request.
    process.env.AI_TEMPERATURE_GENERATION = '1.1';

    const ollamaService = loadOllamaServiceWithAxiosMock(axiosMock);

    await ollamaService._callOllamaAPI('prompt', 'system', 512, {
      type: 'object',
    });

    ollamaService._calculatePromptTokenCount = () => 12;
    ollamaService._calculateNumCtx = () => 1024;
    await ollamaService.generateText('hello');
    await ollamaService.generateText('hello', { temperature: 0.6 });

    assert.strictEqual(
      capturedRequests.length,
      3,
      'Expected three outgoing Ollama requests'
    );
    assert.strictEqual(
      capturedRequests[0].options.temperature,
      0.2,
      'Expected analysis request temperature to use AI_TEMPERATURE_ANALYSIS'
    );
    assert.strictEqual(
      capturedRequests[1].options.temperature,
      0,
      'Expected a generation request without a temperature of its own to ask with 0'
    );
    assert.strictEqual(
      capturedRequests[2].options.temperature,
      0.6,
      "Expected a generation request to use the caller's temperature"
    );
  } finally {
    restoreEnvironment();
  }
}

main()
  .then(() => {
    console.log(
      "[PASS] Ollama temperature wiring: the analysis uses AI_TEMPERATURE_ANALYSIS, generateText() the caller's value or 0"
    );
  })
  .catch((error) => {
    console.error(
      '[FAIL] Ollama temperature wiring test failed:',
      error.message
    );
    process.exitCode = 1;
  });
