'use strict';

/**
 * services/settingsCatalog.js is the one list of settings keys. Every other
 * list of keys either derives from it or is checked against it here:
 *
 *   - config/restartRequiredKeys.js derives from it
 *   - AI_OPTIONS in services/aiProviderRules.js: every key is in the catalogue
 *   - fieldMappings in public/js/settings.js: every key is in the catalogue,
 *     and every key the settings page shows has a mapping (with the few
 *     reasoned exceptions below)
 *   - every key is read by config/config.js, by the file its entry names, or
 *     is marked legacy
 *   - a default config/config.js spells out matches the catalogue's
 *
 * It also checks the shape of the entries and the parsers that are easy to
 * get wrong.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const catalog = require('../services/settingsCatalog');
const { AI_OPTIONS } = require('../services/aiProviderRules');
const {
  RESTART_REQUIRED_KEYS,
  isRestartRequiredKey,
  restartRequiredAmong,
} = require('../config/restartRequiredKeys');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

const TYPES = new Set([
  'string',
  'secret',
  'boolean',
  'integer',
  'number',
  'list',
  'enum',
  'url',
  'cron',
  'json',
]);

// Shown on the settings page without a fieldMappings line, and why.
const PAGE_KEYS_WITHOUT_MAPPING = {
  // Read by nothing any more; the page has no field for it.
  PROCESS_ONLY_NEW_DOCUMENTS: true,
  // Written through the mistralApiKey field, which maps to MISTRAL_API_KEY.
  OCR_API_KEY: true,
  // Baked into the Docker image, so the container never pins it.
  LOG_LEVEL: true,
};

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

const entries = catalog.getCatalog();
const keys = entries.map((entry) => entry.key);

test('every key appears once and has a well-formed entry', () => {
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate keys');
  for (const entry of entries) {
    assert.match(entry.key, /^[A-Z][A-Z0-9_]+$/, entry.key);
    assert.ok(TYPES.has(entry.type), `${entry.key}: type ${entry.type}`);
    assert.ok(
      typeof entry.default === 'string' || typeof entry.default === 'number',
      `${entry.key}: default`
    );
    assert.ok(
      entry.group === null || typeof entry.group === 'string',
      `${entry.key}: group`
    );
    for (const flag of ['secret', 'restart', 'page', 'save', 'wizard']) {
      assert.strictEqual(typeof entry[flag], 'boolean', `${entry.key}.${flag}`);
    }
    assert.strictEqual(
      entry.secret,
      entry.type === 'secret',
      `${entry.key}: secret follows the type`
    );
    assert.ok(Object.isFrozen(entry), `${entry.key} is frozen`);
    assert.strictEqual(catalog.getEntry(entry.key), entry);
  }
  assert.strictEqual(catalog.getEntry('NOT_A_SETTING'), undefined);
});

test('an entry with a parser names its form field and is part of a save', () => {
  for (const entry of entries.filter((item) => item.parse)) {
    assert.ok(entry.field, `${entry.key} has a field`);
    assert.ok(entry.save, `${entry.key} is carried by a save`);
  }
  const fields = entries.filter((item) => item.field).map((item) => item.field);
  assert.strictEqual(new Set(fields).size, fields.length, 'duplicate fields');
});

test('the restart list is the catalogue’s restart entries', () => {
  assert.deepStrictEqual(
    [...RESTART_REQUIRED_KEYS].sort(),
    catalog.restartKeys().sort()
  );
  for (const key of RESTART_REQUIRED_KEYS) {
    assert.ok(catalog.getEntry(key), `${key} is in the catalogue`);
  }
  assert.strictEqual(isRestartRequiredKey(' SCAN_INTERVAL '), true);
  assert.strictEqual(isRestartRequiredKey('AI_TEMPERATURE_ANALYSIS'), false);
  assert.deepStrictEqual(
    restartRequiredAmong(['LOG_LEVEL', 'TAGS', 'TRUST_PROXY']),
    ['LOG_LEVEL', 'TRUST_PROXY']
  );
});

test('every AI option is in the catalogue and on the settings page', () => {
  for (const option of AI_OPTIONS) {
    const entry = catalog.getEntry(option.key);
    assert.ok(entry, `${option.key} is in the catalogue`);
    assert.ok(entry.page, `${option.key} is shown on the settings page`);
  }
});

test('fieldMappings in public/js/settings.js agree with the catalogue', () => {
  const source = read('public/js/settings.js');
  const block = source.slice(
    source.indexOf('const fieldMappings = ['),
    source.indexOf('annotateEnvKeys(fieldMappings);')
  );
  const mapped = [...block.matchAll(/envKey: '([A-Z0-9_]+)'/g)].map(
    (match) => match[1]
  );
  assert.ok(mapped.length > 100, 'fieldMappings found');
  for (const key of mapped) {
    const entry = catalog.getEntry(key);
    assert.ok(entry, `fieldMappings key ${key} is in the catalogue`);
    assert.ok(entry.page, `fieldMappings key ${key} is shown on the page`);
  }
  const mappedSet = new Set(mapped);
  const unmapped = entries
    .filter((entry) => entry.page && !mappedSet.has(entry.key))
    .map((entry) => entry.key)
    .filter((key) => !PAGE_KEYS_WITHOUT_MAPPING[key]);
  assert.deepStrictEqual(
    unmapped,
    [],
    'page keys without a fieldMappings line'
  );
});

test('every key is read somewhere, or marked legacy', () => {
  const configSource = read('config/config.js');
  for (const entry of entries) {
    if (entry.readBy === 'legacy') continue;
    const file = entry.readBy || 'config/config.js';
    const source = file === 'config/config.js' ? configSource : read(file);
    assert.ok(
      source.includes(entry.key),
      `${entry.key} is not read by ${file}`
    );
  }
});

test('a default config/config.js spells out matches the catalogue', () => {
  const configSource = read('config/config.js');
  let compared = 0;
  for (const entry of entries) {
    const patterns = [
      new RegExp(`\\('${entry.key}',\\s*'([^']*)'`),
      new RegExp(`process\\.env\\.${entry.key}\\s*\\|\\|\\s*'([^']*)'`),
      new RegExp(`env\\('${entry.key}'\\)\\s*\\|\\|\\s*'([^']*)'`),
    ];
    for (const pattern of patterns) {
      const match = configSource.match(pattern);
      if (match) {
        assert.strictEqual(
          String(entry.default),
          match[1],
          `${entry.key}: catalogue default vs config/config.js`
        );
        compared += 1;
        break;
      }
    }
  }
  assert.ok(compared > 40, `compared ${compared} defaults`);
});

test('the .env export groups keep their titles and never carry JWT_SECRET', () => {
  const groups = catalog.exportGroups();
  assert.deepStrictEqual(
    groups.map((group) => group.title),
    [
      'Paperless-ngx connection',
      'Document processing',
      'AI provider',
      'AI behaviour',
      'Duplicates',
      'Simplify tags',
      'External API',
      'OCR fallback',
      'Server and security',
      'Single sign-on (OIDC)',
      'Maintenance',
      'Interface',
    ]
  );
  const exported = groups.flatMap((group) => group.keys);
  assert.strictEqual(new Set(exported).size, exported.length);
  assert.ok(!exported.includes('JWT_SECRET'));
  assert.ok(!catalog.getEntry('JWT_SECRET'), 'JWT_SECRET is no setting');
});

test('the secrets are the ones the settings page masks', () => {
  assert.deepStrictEqual(catalog.secretKeys().sort(), [
    'ANTHROPIC_API_KEY',
    'API_KEY',
    'AZURE_API_KEY',
    'CUSTOM_API_KEY',
    'MISTRAL_API_KEY',
    'OCR_API_KEY',
    'OIDC_CLIENT_SECRET',
    'OLLAMA_API_KEY',
    'OPENAI_API_KEY',
    'PAPERLESS_API_TOKEN',
  ]);
});

test('values from the environment follow the surface', () => {
  const env = { SETUP_VALIDATION_TIMEOUT_MS: '9000', TAGS: 'a, b' };
  assert.strictEqual(catalog.valueFromEnv('OPENAI_MODEL', {}), 'gpt-4o-mini');
  assert.strictEqual(catalog.valueFromEnv('OPENAI_MODEL', {}, 'save'), '');
  assert.strictEqual(
    catalog.valueFromEnv('PROCESS_ONLY_NEW_DOCUMENTS', {}, 'wizard'),
    'yes'
  );
  assert.strictEqual(catalog.valueFromEnv('AZURE_API_VERSION', {}), '');
  assert.strictEqual(
    catalog.valueFromEnv('SETUP_OCR_VALIDATION_TIMEOUT_MS', env),
    '9000',
    'falls back to SETUP_VALIDATION_TIMEOUT_MS'
  );
  assert.strictEqual(
    catalog.valueFromEnv('TOKEN_LIMIT', { TOKEN_LIMIT: '' }),
    128000
  );
  assert.throws(() => catalog.valueFromEnv('NOT_A_SETTING', {}));

  const page = catalog.defaultsFromEnv(
    { ...env, PAPERLESS_API_URL: 'http://p:8000/api' },
    'page'
  );
  assert.deepStrictEqual(page.TAGS, ['a', 'b']);
  assert.strictEqual(page.PAPERLESS_API_URL, 'http://p:8000');
  assert.ok(!('API_KEY' in page), 'the API key is not a page value');

  const save = catalog.defaultsFromEnv(
    { ...env, PAPERLESS_API_URL: 'http://p:8000/api' },
    'save'
  );
  assert.strictEqual(save.TAGS, 'a, b', 'a save keeps the stored string');
  assert.strictEqual(save.PAPERLESS_API_URL, 'http://p:8000/api');
  assert.ok('API_KEY' in save);
});

test('lists: arrays as they are, strings split, filtered, then trimmed', () => {
  assert.deepStrictEqual(catalog.normalizeList(undefined), []);
  assert.deepStrictEqual(catalog.normalizeList(''), []);
  assert.deepStrictEqual(catalog.normalizeList(42), []);
  assert.deepStrictEqual(catalog.normalizeList([' a ', '']), [' a ', '']);
  assert.deepStrictEqual(catalog.normalizeList(' a , ,b,,c '), [
    'a',
    '',
    'b',
    'c',
  ]);
});

test('the parsers of the simple fields', () => {
  const parse = (key, raw, current = catalog.getEntry(key).default) =>
    catalog.getEntry(key).parse(raw, current);

  assert.deepStrictEqual(parse('TOKEN_LIMIT', '128k'), {
    error: 'Invalid Token Limit. Expected a positive whole number.',
  });
  assert.deepStrictEqual(parse('TOKEN_LIMIT', ' 064000 '), { value: '64000' });
  assert.deepStrictEqual(parse('TOKEN_LIMIT', ''), {});
  assert.deepStrictEqual(parse('RESPONSE_TOKENS', '20abc'), { value: '20' });
  assert.deepStrictEqual(parse('AI_TEMPERATURE_ANALYSIS', '3', '0.4'), {
    value: '0.4',
    warning:
      '[WARN] Invalid AI_TEMPERATURE_ANALYSIS value: 3. Using fallback: 0.4',
  });
  assert.deepStrictEqual(parse('AI_TEMPERATURE_ANALYSIS', undefined), {});
  assert.deepStrictEqual(parse('DUPLICATES_AI_CANDIDATE_FLOOR', '0.777'), {
    value: '0.78',
  });
  assert.deepStrictEqual(parse('DUPLICATES_AI_REVIEW_BATCH_SIZE', '0'), {
    value: '1',
  });
  assert.deepStrictEqual(parse('DUPLICATES_AI_REVIEW_BATCH_SIZE', 'x', '40'), {
    value: '40',
  });
  assert.deepStrictEqual(parse('DUPLICATES_AI_REVIEW', 'maybe', 'no'), {
    value: 'no',
  });
  assert.deepStrictEqual(parse('OCR_PDF_RENDER_DPI', '20'), {
    value: '150',
    warning: '[WARN] Invalid OCR_PDF_RENDER_DPI value: 20. Using default: 150',
  });
  assert.deepStrictEqual(parse('OCR_AUTO_PROCESS_INTERVAL', 'soon'), {
    error:
      'Invalid OCR Processing Interval. Use cron syntax, for example */15 * * * *.',
  });
  assert.deepStrictEqual(parse('OCR_AUTO_PROCESS_INTERVAL', ' */5 * * * * '), {
    value: '*/5 * * * *',
  });
  assert.deepStrictEqual(parse('MAX_PAGE_COUNT', ''), { value: '0' });
  assert.deepStrictEqual(
    parse('MAX_PAGE_COUNT', '-1').error !== undefined,
    true
  );
  assert.deepStrictEqual(parse('ACTIVATE_TAGGING', undefined), { value: 'no' });
  assert.deepStrictEqual(parse('RESTRICT_TO_EXISTING_TAGS', 'true'), {
    value: 'no',
  });
  assert.deepStrictEqual(parse('IGNORE_REPEATED_CONTENT', 'false'), {
    value: 'yes',
  });
  assert.deepStrictEqual(parse('DATE_FORMAT', 'yyyy-mm-dd'), {
    value: 'YYYY-MM-DD',
  });
  assert.deepStrictEqual(parse('SYSTEM_PROMPT', 'a=b\r\nc'), {
    value: 'ab\\nc',
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
