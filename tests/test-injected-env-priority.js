const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const configModulePath = require.resolve('../config/config');
const setupServiceModulePath = require.resolve('../services/setupService');

const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const originalSnapshot = global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__;

function resetModule(modulePath) {
  delete require.cache[modulePath];
}

async function main() {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'paperless-ai-env-priority-')
  );
  const dataDir = path.join(tempDir, 'data');
  const envFilePath = path.join(dataDir, '.env');
  const migratedEnvFilePath = path.join(dataDir, '.env.migrated');
  const runtimeOverridesPath = path.join(dataDir, 'runtime-overrides.json');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    envFilePath,
    [
      'COOKIE_SECURE_MODE="always"',
      'TRUST_PROXY="false"',
      'CUSTOM_BASE_URL="http://env.example"',
    ].join('\n') + '\n',
    'utf8'
  );
  fs.writeFileSync(
    runtimeOverridesPath,
    JSON.stringify(
      {
        COOKIE_SECURE_MODE: 'always',
        TRUST_PROXY: 'false',
        LOG_LEVEL: 'debug',
        CUSTOM_BASE_URL: 'http://override.example',
      },
      null,
      2
    ),
    'utf8'
  );

  process.chdir(tempDir);
  process.env = {
    // Simulate a clean container env: only what a docker-compose operator would set.
    // Deliberately lean — no Dockerfile-baked defaults, no internal framework vars.
    COOKIE_SECURE_MODE: 'never',
    TRUST_PROXY: 'loopback',
    LOG_LEVEL: 'warn',
    CONFIG_SOURCE_MODE: 'runtime-first',
    // Simulate node-internal and other system vars that should not be treated as locked.
    PATH: originalEnv.PATH || '',
  };
  delete process.env.CUSTOM_BASE_URL;
  delete global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__;

  resetModule(configModulePath);
  resetModule(setupServiceModulePath);

  require(configModulePath);

  assert.ok(
    fs.existsSync(migratedEnvFilePath),
    'Expected legacy data/.env to be migrated to data/.env.migrated in runtime-first mode'
  );
  assert.ok(
    !fs.existsSync(envFilePath),
    'Expected data/.env to be removed after migration in runtime-first mode'
  );

  assert.strictEqual(
    process.env.COOKIE_SECURE_MODE,
    'never',
    'Expected injected COOKIE_SECURE_MODE to win over runtime overrides'
  );
  assert.strictEqual(
    process.env.TRUST_PROXY,
    'loopback',
    'Expected injected TRUST_PROXY to win over runtime overrides'
  );
  assert.strictEqual(
    process.env.LOG_LEVEL,
    'debug',
    'Expected non-protected LOG_LEVEL to remain overridable'
  );
  assert.strictEqual(
    process.env.CUSTOM_BASE_URL,
    'http://override.example',
    'Expected non-injected runtime override to be applied'
  );

  const setupService = require(setupServiceModulePath);
  const loadedConfig = await setupService.loadConfig();

  assert.ok(
    !Object.prototype.hasOwnProperty.call(loadedConfig, 'COOKIE_SECURE_MODE'),
    'Expected loadConfig to hide persisted COOKIE_SECURE_MODE when it is managed by injected env'
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(loadedConfig, 'TRUST_PROXY'),
    'Expected loadConfig to hide persisted TRUST_PROXY when it is managed by injected env'
  );
  assert.strictEqual(
    loadedConfig.LOG_LEVEL,
    'debug',
    'Expected loadConfig to keep non-protected runtime overrides'
  );
  assert.strictEqual(
    loadedConfig.CUSTOM_BASE_URL,
    'http://override.example',
    'Expected loadConfig to keep non-protected persisted values'
  );

  await setupService.saveConfig(
    {
      COOKIE_SECURE_MODE: 'auto',
      TRUST_PROXY: 'false',
      LOG_LEVEL: 'error',
      CUSTOM_BASE_URL: 'http://persisted.example',
      PAPERLESS_API_URL: 'http://paperless.example',
      PAPERLESS_API_TOKEN: 'token',
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-4o-mini',
    },
    { skipValidation: true }
  );

  const persistedOverrides = JSON.parse(
    fs.readFileSync(runtimeOverridesPath, 'utf8')
  );

  assert.ok(
    !fs.existsSync(envFilePath),
    'Expected saveConfig not to recreate data/.env in runtime-first mode'
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(
      persistedOverrides,
      'COOKIE_SECURE_MODE'
    ),
    'Expected injected COOKIE_SECURE_MODE to be excluded from runtime-overrides.json'
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(persistedOverrides, 'TRUST_PROXY'),
    'Expected injected TRUST_PROXY to be excluded from runtime-overrides.json'
  );
  assert.strictEqual(
    persistedOverrides.LOG_LEVEL,
    'error',
    'Expected non-protected LOG_LEVEL to remain in runtime-overrides.json'
  );
  assert.strictEqual(
    persistedOverrides.CUSTOM_BASE_URL,
    'http://persisted.example',
    'Expected non-injected CUSTOM_BASE_URL to remain in runtime-overrides.json'
  );
  assert.strictEqual(
    process.env.COOKIE_SECURE_MODE,
    'never',
    'Expected injected COOKIE_SECURE_MODE to remain unchanged after saveConfig'
  );
  assert.strictEqual(
    process.env.TRUST_PROXY,
    'loopback',
    'Expected injected TRUST_PROXY to remain unchanged after saveConfig'
  );
  assert.strictEqual(
    process.env.LOG_LEVEL,
    'error',
    'Expected non-protected LOG_LEVEL to update process.env'
  );
  assert.strictEqual(
    process.env.CUSTOM_BASE_URL,
    'http://persisted.example',
    'Expected non-injected CUSTOM_BASE_URL to update process.env'
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
}

main()
  .then(() => {
    console.log(
      '[PASS] Docker-operator-injected env vars (snapshot-based) keep priority over runtime overrides and persisted settings'
    );
  })
  .catch((error) => {
    console.error(
      '[FAIL] Injected environment priority test failed:',
      error.message
    );
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;

    if (typeof originalSnapshot === 'undefined') {
      delete global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__;
    } else {
      global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = originalSnapshot;
    }

    resetModule(configModulePath);
    resetModule(setupServiceModulePath);
  });
