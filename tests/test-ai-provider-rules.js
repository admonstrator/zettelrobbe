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

  // The GPT-6 family: max_completion_tokens and no temperature wherever it
  // is served, the custom provider included; `none` only where OpenAI
  // documents it, and never `minimal`.
  for (const [provider, model, offEffort] of [
    ['openai', 'gpt-6-luna', 'none'],
    ['openai', 'gpt-6-sol', 'none'],
    ['openai', 'gpt-6.1-terra', 'none'],
    ['openai', 'gpt-6-astra', 'low'],
    ['openai', 'gpt-6.1-sol', 'low'],
    ['openai', 'gpt-6-luna-pro', 'low'],
    ['azure', 'gpt-6-luna', 'none'],
    ['custom', 'gpt-6-luna', 'low'],
    ['custom', 'openai/gpt-6-luna', 'low'],
    ['custom', 'openai/gpt-6.1-sol', 'low'],
  ]) {
    const gpt6 = rules.resolveRules(provider, model);
    const label = `${provider} ${model}`;
    assert.strictEqual(gpt6.maxTokensParam, 'max_completion_tokens', label);
    assert.strictEqual(gpt6.temperature, false, label);
    assert.strictEqual(gpt6.reasoningOffEffort, offEffort, label);
    assert.strictEqual(gpt6.effortSetting, true, label);
    assert.strictEqual(
      gpt6.reasoningEffort,
      provider === 'custom' ? 'compatible' : 'openai',
      label
    );
  }
  for (const model of ['gpt-60-mini', 'gpt-5.6-luna', 'gpt-4o-mini']) {
    assert.notStrictEqual(
      rules.resolveRules('openai', model).reasoningOffEffort,
      'none',
      `${model} is not a GPT-6 model`
    );
  }
  assert.strictEqual(
    rules.resolveRules('openai', 'gpt-60-mini').maxTokensParam,
    'max_tokens'
  );

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
    null,
    'custom sends the chat template switch to Qwen only, unasked'
  );
  assert.strictEqual(
    rules.resolveRules('custom', 'llama-3.3-70b', { templateSwitch: true })
      .thinkingSwitch,
    'chat_template',
    'DUPLICATES_AI_TEMPLATE_SWITCH sends it to any model'
  );
  for (const provider of ['openai', 'azure', 'ollama', 'anthropic']) {
    assert.notStrictEqual(
      rules.resolveRules(provider, 'llama-3.3-70b', { templateSwitch: true })
        .thinkingSwitch,
      'chat_template',
      `${provider}: the switch is a custom-provider setting`
    );
  }

  // Where the operator's AI_REASONING_EFFORT may go.
  assert.deepStrictEqual(rules.REASONING_EFFORT_LEVELS, [
    'low',
    'medium',
    'high',
  ]);
  for (const [provider, model, expected] of [
    ['openai', 'gpt-5-mini', true],
    ['openai', 'o3-mini', true],
    ['openai', 'gpt-4o-mini', false],
    ['azure', 'my-deployment', true],
    ['custom', 'magistral-medium-latest', true],
    ['custom', 'llama-3.3-70b', true],
    ['ollama', 'qwen3:8b', false],
    ['anthropic', 'claude-sonnet-5-5', false],
  ]) {
    assert.strictEqual(
      rules.resolveRules(provider, model).effortSetting,
      expected,
      `${provider} ${model}`
    );
  }
  assert.strictEqual(
    rules.resolveRules('custom', 'llama-3.3-70b').thinkingPromptSwitch,
    null
  );
  for (const model of ['mistral-large-latest', 'magistral-medium-latest']) {
    assert.strictEqual(
      rules.resolveRules('custom', model).thinkingSwitch,
      null,
      `${model}: Mistral's API rejects chat_template_kwargs (#373)`
    );
  }
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
