/**
 * "Fetch OCR models" must not refuse a key it cannot see.
 *
 * The key can sit in three places: the form field, the saved configuration, or
 * the environment. Only the server sees the latter two — a saved key is never
 * echoed back into a password field, and an injected one was never in the form.
 * Both pages used to refuse an empty field on their own and report it as
 * "Missing API key", so an instance configured through MISTRAL_API_KEY could
 * never load its model list.
 *
 * The resolver is read out of the route file rather than copied, so this test
 * cannot keep passing after the real one changes.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readRouteSources } = require('./helpers/route-sources');

const source = readRouteSources();

const start = source.indexOf('function resolveOcrApiKey');
assert.ok(
  start !== -1,
  'Could not find resolveOcrApiKey in the route modules — did it move or get renamed?'
);
const end = source.indexOf('\n}', start);
const resolveOcrApiKey = new Function(
  `${source.slice(start, end + 2)}\nreturn resolveOcrApiKey;`
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

const originalOcr = process.env.OCR_API_KEY;
const originalMistral = process.env.MISTRAL_API_KEY;
const restore = () => {
  if (originalOcr === undefined) delete process.env.OCR_API_KEY;
  else process.env.OCR_API_KEY = originalOcr;
  if (originalMistral === undefined) delete process.env.MISTRAL_API_KEY;
  else process.env.MISTRAL_API_KEY = originalMistral;
};

console.log('\n=== OCR model discovery: key resolution ===');

check('what the operator typed wins', () => {
  process.env.OCR_API_KEY = 'from-env';
  assert.strictEqual(
    resolveOcrApiKey('typed-in-the-form'),
    'typed-in-the-form'
  );
});

check('an empty field falls back to OCR_API_KEY', () => {
  process.env.OCR_API_KEY = 'from-ocr-var';
  delete process.env.MISTRAL_API_KEY;
  assert.strictEqual(resolveOcrApiKey(''), 'from-ocr-var');
  assert.strictEqual(resolveOcrApiKey(undefined), 'from-ocr-var');
  // Whitespace is what a cleared field actually leaves behind.
  assert.strictEqual(resolveOcrApiKey('   '), 'from-ocr-var');
});

check('MISTRAL_API_KEY is the second source', () => {
  delete process.env.OCR_API_KEY;
  process.env.MISTRAL_API_KEY = 'from-mistral-var';
  assert.strictEqual(resolveOcrApiKey(''), 'from-mistral-var');
});

check('nothing anywhere resolves to empty, not to a placeholder', () => {
  delete process.env.OCR_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  assert.strictEqual(resolveOcrApiKey(''), '');
});

restore();

/* --- neither page may refuse on its own ------------------------------- */

const settingsSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'settings.js'),
  'utf8'
);
const wizardSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'setup.js'),
  'utf8'
);

check('the settings page no longer blocks on an empty field', () => {
  assert.ok(
    !settingsSource.includes('Mistral OCR requires an API key to load models'),
    'the client-side refusal is back in settings.js'
  );
});

check('the setup wizard no longer blocks on an empty field', () => {
  assert.ok(
    !wizardSource.includes(
      'Mistral OCR requires an API key to discover models'
    ),
    'the client-side refusal is back in setup.js'
  );
});

check('every OCR route resolves the key before using it', () => {
  // /api/setup/ocr/models, /api/settings/ocr/test and
  // /api/settings/ocr/models. The wizard was the one passing req.body.apiKey
  // straight through; the settings test endpoint always resolved. Since
  // Claude OCR joined, the routes go through resolveOcrApiKeyForProvider(),
  // which hands every other provider to resolveOcrApiKey() unchanged.
  const calls = (
    source.match(
      /resolveOcrApiKeyForProvider\(\s*req\.body\?\.provider,\s*req\.body\?\.apiKey,\s*req\.body\?\.apiUrl \|\| req\.body\?\.anthropicApiUrl\s*\)/g
    ) || []
  ).length;
  assert.strictEqual(
    calls,
    3,
    `expected 3 resolved call sites, found ${calls}`
  );
});

if (failed > 0) {
  console.error(`\n${failed} OCR key resolution case(s) failed`);
  process.exit(1);
}
console.log('\nAll OCR key resolution cases passed');
