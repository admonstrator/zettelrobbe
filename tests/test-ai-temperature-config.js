const assert = require('assert');

const configModulePath = require.resolve('../config/config');
const originalEnv = { ...process.env };

function loadConfigWithTemperatures(analysisValue, generationValue) {
  delete require.cache[configModulePath];

  if (typeof analysisValue === 'undefined') {
    delete process.env.AI_TEMPERATURE_ANALYSIS;
  } else {
    process.env.AI_TEMPERATURE_ANALYSIS = String(analysisValue);
  }

  if (typeof generationValue === 'undefined') {
    delete process.env.AI_TEMPERATURE_GENERATION;
  } else {
    process.env.AI_TEMPERATURE_GENERATION = String(generationValue);
  }

  return require('../config/config');
}

function restoreEnvironment() {
  process.env = originalEnv;
  delete require.cache[configModulePath];
}

try {
  let config = loadConfigWithTemperatures(undefined, undefined);
  assert.strictEqual(
    config.aiTemperatureAnalysis,
    0.3,
    'Expected default analysis temperature to be 0.3'
  );

  config = loadConfigWithTemperatures('1', '0');
  assert.strictEqual(
    config.aiTemperatureAnalysis,
    1,
    'Expected valid analysis temperature to be parsed'
  );

  config = loadConfigWithTemperatures('2.0', '1.8');
  assert.strictEqual(
    config.aiTemperatureAnalysis,
    2,
    'Expected max allowed analysis temperature to be accepted'
  );

  config = loadConfigWithTemperatures('-0.1', '2.1');
  assert.strictEqual(
    config.aiTemperatureAnalysis,
    0.3,
    'Expected out-of-range analysis temperature to fall back'
  );

  config = loadConfigWithTemperatures('abc', '');
  assert.strictEqual(
    config.aiTemperatureAnalysis,
    0.3,
    'Expected invalid analysis temperature to fall back'
  );

  // AI_TEMPERATURE_GENERATION was removed: an installation may still have it
  // set, even to a value the old parser refused, and the config neither
  // offers it nor warns about it.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    process.env.LOG_LEVEL = 'debug';
    config = loadConfigWithTemperatures('0.5', 'not-a-number');
  } finally {
    console.warn = realWarn;
  }
  assert.strictEqual(
    config.aiTemperatureAnalysis,
    0.5,
    'Expected the analysis temperature to be unaffected by the removed key'
  );
  assert.ok(
    !('aiTemperatureGeneration' in config),
    'Expected no generation temperature getter'
  );
  assert.deepStrictEqual(
    warnings.filter((line) => line.includes('AI_TEMPERATURE_GENERATION')),
    [],
    'Expected no warning about the removed key'
  );

  restoreEnvironment();
  console.log(
    '[PASS] AI temperature config parsing and fallback checks passed'
  );
} catch (error) {
  restoreEnvironment();
  console.error('[FAIL] AI temperature config test failed:', error.message);
  process.exit(1);
}
