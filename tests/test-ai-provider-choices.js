'use strict';

/**
 * The one provider list of the settings page and the setup wizard
 * (services/aiFormOptions.js): every provider can be chosen, the named
 * OpenAI-compatible services share the custom provider, "Other
 * OpenAI-compatible server" closes the list, and a stored configuration maps
 * back to its entry by provider and address.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadAiProviderPresets,
  matchProviderChoice,
} = require('../services/aiFormOptions');

async function withPresetsFile(content, run) {
  const originalCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-choices-'));
  fs.mkdirSync(path.join(root, 'config'));
  if (content !== null) {
    fs.writeFileSync(
      path.join(root, 'config', 'ai-provider-presets.json'),
      JSON.stringify(content)
    );
  }
  process.chdir(root);
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.warn = warn;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const shipped = await loadAiProviderPresets();
  const ids = shipped.map((entry) => entry.id);
  for (const provider of ['openai', 'anthropic', 'azure', 'ollama']) {
    assert.ok(
      shipped.some((entry) => entry.provider === provider),
      `${provider} can be chosen`
    );
  }
  assert.ok(ids.includes('mistral'), 'Mistral is in the list');
  const mistral = shipped.find((entry) => entry.id === 'mistral');
  assert.strictEqual(mistral.provider, 'custom');
  assert.strictEqual(mistral.apiUrl, 'https://api.mistral.ai/v1');
  const last = shipped[shipped.length - 1];
  assert.deepStrictEqual(
    [last.id, last.provider, last.apiUrl, last.label],
    ['custom', 'custom', '', 'Other OpenAI-compatible server'],
    '"Other" closes the list'
  );
  assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique');

  // A file of its own still offers every provider and one "Other".
  const own = await withPresetsFile(
    {
      presets: [
        {
          id: 'vllm',
          label: 'Our vLLM',
          provider: 'custom',
          apiUrl: 'http://gpu:8000/v1',
        },
        { id: 'blank', label: 'Blank custom', provider: 'custom', apiUrl: '' },
        { id: 'oa', label: 'OpenAI', provider: 'openai', apiUrl: '' },
      ],
    },
    loadAiProviderPresets
  );
  assert.deepStrictEqual(
    own.map((entry) => entry.id),
    [
      'vllm',
      'oa',
      'anthropic-default',
      'azure-default',
      'ollama-local',
      'custom',
    ]
  );
  const missing = await withPresetsFile(null, loadAiProviderPresets);
  assert.deepStrictEqual(
    missing.map((entry) => entry.id),
    ids,
    'without a file the built-in list applies'
  );

  // A stored configuration finds its entry.
  const match = (provider, url) =>
    matchProviderChoice(shipped, provider, url)?.id;
  assert.strictEqual(match('anthropic', ''), 'anthropic-default');
  assert.strictEqual(
    match('azure', 'https://x.openai.azure.com'),
    'azure-default'
  );
  assert.strictEqual(match('custom', 'https://api.mistral.ai/v1/'), 'mistral');
  assert.strictEqual(
    match('custom', ' http://127.0.0.1:1234/v1 '),
    'lmstudio-local'
  );
  assert.strictEqual(match('custom', 'http://gpu:8000/v1'), 'custom');
  assert.strictEqual(match('custom', ''), 'custom');
  assert.strictEqual(match('', ''), undefined, 'no provider, no entry');

  console.log('[PASS] ai-provider-choices');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
