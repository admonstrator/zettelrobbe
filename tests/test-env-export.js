/**
 * Guards the .env export behind GET /api/settings/env-file.
 *
 * The export puts the instance's configuration on screen, tokens included, so
 * what it must never do is widen that set on its own: JWT_SECRET stays out, and
 * a variable nobody listed does not travel just because it sits in the
 * environment. The quoting matters too — a system prompt with spaces has to
 * come back as one value, not three.
 *
 * The functions are read out of the route file rather than copied, so this test
 * cannot keep passing after the real ones change.
 */

const assert = require('assert');
const { readRouteSources } = require('./helpers/route-sources');

const source = readRouteSources();

const start = source.indexOf('const ENV_EXPORT_GROUPS');
const end = source.indexOf('\n}', source.indexOf('function buildEnvExport'));
assert.ok(
  start !== -1 && end !== -1 && end > start,
  'Could not find buildEnvExport in the route modules — did it move or get renamed?'
);

const buildEnvExport = new Function(
  `${source.slice(start, end + 2)}\nreturn buildEnvExport;`
)();

let failed = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${label}: ${error.message}`);
  }
};

check('groups what it exports and skips empty groups', () => {
  const { env } = buildEnvExport({
    PAPERLESS_API_URL: 'https://paperless.example.com',
    LOG_LEVEL: 'info',
  });
  assert.ok(env.includes('# Paperless-ngx connection'), 'connection heading');
  assert.ok(env.includes('# Maintenance'), 'maintenance heading');
  assert.ok(!env.includes('# AI provider'), 'no heading without values');
  assert.ok(!env.includes('# OCR fallback'), 'no heading without values');
});

check('counts only the variables it emitted', () => {
  const { env, count } = buildEnvExport({
    PAPERLESS_API_URL: 'https://paperless.example.com',
    OLLAMA_MODEL: 'llama3.1:8b',
    SOMETHING_ELSE: 'ignored',
  });
  assert.strictEqual(count, 2);
  assert.strictEqual(env.split('\n').filter((l) => l.includes('=')).length, 2);
});

check('never exports JWT_SECRET', () => {
  const { env } = buildEnvExport({
    JWT_SECRET: 'do-not-leak-me',
    PAPERLESS_API_URL: 'https://paperless.example.com',
  });
  assert.ok(!env.includes('JWT_SECRET'), 'key absent');
  assert.ok(!env.includes('do-not-leak-me'), 'value absent');
});

check('ignores variables that are not on the list', () => {
  const { env, count } = buildEnvExport({
    HOME: '/root',
    PATH: '/usr/bin',
    NODE_ENV: 'production',
    AWS_SECRET_ACCESS_KEY: 'nope',
    npm_config_cache: '/tmp',
  });
  assert.strictEqual(count, 0);
  assert.strictEqual(env, '');
});

check('skips variables that are set but empty', () => {
  const { env, count } = buildEnvExport({
    PAPERLESS_API_URL: '',
    PAPERLESS_USERNAME: 'zettelrobbe',
  });
  assert.strictEqual(count, 1);
  assert.ok(!env.includes('PAPERLESS_API_URL'));
});

check('quotes values a .env parser would otherwise split or truncate', () => {
  const { env } = buildEnvExport({
    SYSTEM_PROMPT: 'Analyse the document # carefully',
    SCAN_INTERVAL: '*/30 * * * *',
    OPENAI_MODEL: 'gpt-4o-mini',
  });
  assert.ok(
    env.includes('SYSTEM_PROMPT="Analyse the document # carefully"'),
    'spaces and a hash are quoted'
  );
  assert.ok(env.includes('SCAN_INTERVAL="*/30 * * * *"'), 'cron is quoted');
  assert.ok(
    env.includes('OPENAI_MODEL=gpt-4o-mini'),
    'a plain value stays bare'
  );
});

check('escapes a quote inside a value', () => {
  const { env } = buildEnvExport({ SYSTEM_PROMPT: 'Say "hello" politely' });
  assert.ok(env.includes('SYSTEM_PROMPT="Say \\"hello\\" politely"'));
});

check('emits every group when everything is configured', () => {
  const { env } = buildEnvExport({
    PAPERLESS_API_URL: 'https://paperless.example.com',
    SCAN_INTERVAL: '0 * * * *',
    AI_PROVIDER: 'openai',
    TOKEN_LIMIT: '128000',
    EXTERNAL_API_ENABLED: 'yes',
    MISTRAL_OCR_ENABLED: 'yes',
    API_KEY: 'abc',
    LOG_LEVEL: 'debug',
    DATE_FORMAT: 'YYYY-MM-DD',
  });
  [
    '# Paperless-ngx connection',
    '# Document processing',
    '# AI provider',
    '# AI behaviour',
    '# External API',
    '# OCR fallback',
    '# Server and security',
    '# Maintenance',
    '# Interface',
  ].forEach((heading) => assert.ok(env.includes(heading), heading));
});

if (failed > 0) {
  console.error(`\n${failed} env export case(s) failed`);
  process.exit(1);
}

console.log('\nAll env export cases passed');
