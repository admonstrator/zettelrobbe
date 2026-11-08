'use strict';

/**
 * Contract test for services/aiProviderRules.js and
 * config/restartRequiredKeys.js: the shape every consumer relies on.
 */
const assert = require('assert');
const rules = require('../services/aiProviderRules');
const restart = require('../config/restartRequiredKeys');

function run() {
  // Providers
  assert.deepStrictEqual([...rules.PROVIDER_IDS].sort(), [
    'anthropic',
    'azure',
    'custom',
    'ollama',
    'openai',
  ]);
  assert.strictEqual(rules.normalizeProvider(' Ollama '), 'ollama');
  assert.strictEqual(rules.normalizeProvider('nope'), 'openai');
  assert.strictEqual(rules.transportFor('azure'), 'openai-compatible');
  assert.strictEqual(rules.transportFor('anthropic'), 'anthropic');

  // Request rules: transport defaults
  const openai = rules.resolveRules('openai', 'gpt-4o-mini');
  assert.strictEqual(openai.temperature, true);
  assert.strictEqual(openai.reasoningEffort, null);
  assert.strictEqual(openai.maxTokensParam, 'max_tokens');

  const anthropic = rules.resolveRules('anthropic', 'claude-haiku-5-5');
  assert.strictEqual(anthropic.temperature, false);
  assert.strictEqual(anthropic.promptCaching, true);
  assert.strictEqual(anthropic.structuredOutput, 'anthropic');

  const ollama = rules.resolveRules('ollama', 'llama3.2');
  assert.strictEqual(ollama.maxTokensParam, 'num_predict');
  assert.strictEqual(ollama.thinkingSwitch, 'ollama');

  // Request rules: model families
  const gpt5 = rules.resolveRules('openai', 'gpt-5-mini');
  assert.strictEqual(gpt5.temperature, false);
  assert.strictEqual(gpt5.reasoningEffort, 'openai');
  assert.strictEqual(gpt5.maxTokensParam, 'max_completion_tokens');

  const o3 = rules.resolveRules('azure', 'o3-mini');
  assert.strictEqual(o3.reasoningEffort, 'openai');

  const gptOss = rules.resolveRules('custom', 'openai/gpt-oss-20b');
  assert.strictEqual(gptOss.reasoningEffort, 'compatible');

  const customGpt5 = rules.resolveRules('custom', 'gpt-5');
  assert.strictEqual(customGpt5.reasoningEffort, 'compatible');

  const qwen = rules.resolveRules('custom', 'qwen3:8b');
  assert.strictEqual(qwen.thinkingSwitch, 'chat_template');

  // Additions: the effort value, the prompt switch, the default cap.
  assert.strictEqual(gpt5.reasoningOffEffort, 'minimal');
  assert.strictEqual(o3.reasoningOffEffort, 'low');
  assert.strictEqual(o3.temperature, false, 'the o-series takes none');
  assert.strictEqual(o3.maxTokensParam, 'max_completion_tokens');
  assert.strictEqual(gptOss.reasoningOffEffort, 'low');
  assert.strictEqual(
    customGpt5.reasoningOffEffort,
    'low',
    'the compatible dialect knows no minimal'
  );
  assert.strictEqual(
    customGpt5.maxTokensParam,
    'max_tokens',
    'gateways behind custom take the cap as max_tokens'
  );
  assert.strictEqual(qwen.thinkingPromptSwitch, '/no_think');
  assert.strictEqual(openai.thinkingPromptSwitch, null);
  assert.strictEqual(
    rules.resolveRules('custom', 'llama-3.3-70b').thinkingSwitch,
    'chat_template',
    'custom sends the chat template switch for every model'
  );
  assert.strictEqual(
    rules.resolveRules('custom', 'llama-3.3-70b').thinkingPromptSwitch,
    null
  );
  for (const provider of ['openai', 'azure']) {
    const qwenHosted = rules.resolveRules(provider, 'qwen3-32b');
    assert.strictEqual(qwenHosted.thinkingSwitch, null, provider);
    assert.strictEqual(qwenHosted.thinkingPromptSwitch, null, provider);
    assert.strictEqual(
      rules.resolveRules(provider, 'gpt-oss-120b').reasoningEffort,
      null,
      `${provider}: never sent reasoning_effort for gpt-oss`
    );
  }
  assert.strictEqual(openai.defaultCompletionCap, false);
  assert.strictEqual(o3.defaultCompletionCap, true, 'Azure caps by default');
  assert.strictEqual(qwen.defaultCompletionCap, true);
  assert.strictEqual(ollama.defaultCompletionCap, true);
  assert.strictEqual(ollama.temperature, true);
  assert.strictEqual(anthropic.reasoningOffEffort, null);
  // The aiGenerateOptions helpers read the same table.
  const generateOptions = require('../services/aiGenerateOptions');
  assert.strictEqual(
    generateOptions.reasoningEffortForOpenAi('gpt-5-mini'),
    'minimal'
  );
  assert.strictEqual(
    generateOptions.reasoningEffortForOpenAi('o4-mini'),
    'low'
  );
  assert.strictEqual(
    generateOptions.reasoningEffortForOpenAi('gpt-oss-120b'),
    null
  );
  assert.strictEqual(generateOptions.reasoningEffortForOpenAi('gpt-4o'), null);
  assert.strictEqual(generateOptions.reasoningEffortForOpenAi(''), null);
  for (const model of ['gpt-oss-120b', 'gpt-5-mini', 'o3-mini']) {
    assert.strictEqual(
      generateOptions.reasoningEffortForCompatible(model),
      'low',
      model
    );
  }
  assert.strictEqual(
    generateOptions.reasoningEffortForCompatible('qwen3:8b'),
    null
  );

  // An unknown model gets the transport default, never a throw.
  assert.strictEqual(rules.resolveRules('openai', '').temperature, true);
  assert.strictEqual(
    rules.resolveRules(undefined, undefined).transport,
    'openai-compatible'
  );

  // Every resolved object carries every field.
  const fields = [
    'transport',
    'temperature',
    'reasoningEffort',
    'thinkingSwitch',
    'structuredOutput',
    'promptCaching',
    'maxTokensParam',
    'streaming',
    'reasoningOffEffort',
    'thinkingPromptSwitch',
    'defaultCompletionCap',
  ];
  for (const provider of rules.PROVIDER_IDS) {
    const resolved = rules.resolveRules(provider, 'anything');
    for (const field of fields) {
      assert.ok(field in resolved, `${provider}: missing ${field}`);
    }
  }

  // Settings catalogue
  assert.ok(rules.AI_OPTIONS.length >= 8);
  const keys = new Set();
  for (const option of rules.AI_OPTIONS) {
    assert.match(option.key, /^[A-Z0-9_]+$/);
    assert.ok(!keys.has(option.key), `duplicate option ${option.key}`);
    keys.add(option.key);
    assert.ok(option.label.trim());
    assert.ok(option.help.trim().length > 40, `${option.key}: help too short`);
    assert.ok(['basic', 'advanced'].includes(option.level));
    assert.ok(
      option.providers === null ||
        option.providers.every((id) => rules.PROVIDER_IDS.includes(id))
    );
  }
  assert.ok(
    rules.optionsFor('anthropic').some((o) => o.key === 'ANTHROPIC_EFFORT')
  );
  assert.ok(
    !rules.optionsFor('openai').some((o) => o.key === 'ANTHROPIC_EFFORT')
  );
  assert.ok(
    !rules
      .optionsFor('anthropic')
      .some((o) => o.key === 'AI_TEMPERATURE_ANALYSIS'),
    'Claude ignores temperature, so the option must not be offered'
  );
  assert.ok(
    rules.optionsFor('openai', 'advanced').every((o) => o.level === 'advanced')
  );

  // Restart keys
  assert.ok(restart.isRestartRequiredKey('PAPERLESS_AI_PORT'));
  assert.ok(!restart.isRestartRequiredKey('AI_TEMPERATURE_ANALYSIS'));
  assert.deepStrictEqual(
    restart.restartRequiredAmong(['OPENAI_MODEL', 'TRUST_PROXY', 'X']),
    ['TRUST_PROXY']
  );

  console.log('[PASS] ai-provider-rules');
}

run();
