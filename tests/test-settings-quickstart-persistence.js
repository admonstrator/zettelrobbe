/**
 * The "Quickstart auto-detect" block on the settings page looked broken.
 *
 * Its two inputs carry no name attribute, so they are never part of the
 * settings POST and nothing about them is stored — by design, they drive one
 * detection run and what gets saved is whatever the user applies to the AI and
 * OCR fields below. The page never said so, so after a restart the block
 * simply looked like it had forgotten everything (issue #306). Worse, the
 * detect route took the key field at face value, so leaving it empty — the
 * normal case, since a saved secret is never rendered back into a password
 * input — ran the detection with no key at all.
 *
 * A saved key still must not reach the HTML. So the URL is prefilled from the
 * configured AI server, the key field says it is configured, and the route
 * resolves the stored one. That is the same contract the AI and OCR key fields
 * on this page already follow.
 *
 * Two conditions bound that substitution, and both are load-bearing. The key
 * is resolved for the configured provider, so a CUSTOM_API_KEY left behind by
 * a provider switch is not sent to an Ollama host. And it is only substituted
 * when the request targets that provider's own server, so an endpoint that
 * accepts an arbitrary baseUrl cannot be used to read a secret the page
 * deliberately never renders.
 *
 * The resolvers are read out of the route file rather than copied, so this
 * test cannot keep passing after the real ones change.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readRouteSources } = require('./helpers/route-sources');

const routeSource = readRouteSources();

const VIEW_FILE = path.join(__dirname, '..', 'views', 'settings.ejs');
const viewSource = fs.readFileSync(VIEW_FILE, 'utf8');

// ── The stored key stands in for an empty field ──────────────────────────────

function extract(name, declaration) {
  const start = routeSource.indexOf(declaration);
  assert.ok(
    start !== -1,
    `Could not find ${name} in the route modules — did it move or get renamed?`
  );
  const end = routeSource.indexOf('\n}', start);
  assert.ok(end > start, `Could not delimit ${name}`);
  return routeSource.slice(start, end + 2);
}

// resolveSettingsQuickstartApiKey leans on both of these, so all three come
// out of the route file together.
const resolveSettingsQuickstartApiKey = new Function(
  `${extract('resolveStoredAiToken', 'function resolveStoredAiToken')}
   ${extract('isSameQuickstartHost', 'function isSameQuickstartHost')}
   ${extract('resolveSettingsQuickstartApiKey', 'function resolveSettingsQuickstartApiKey')}
   return resolveSettingsQuickstartApiKey;`
)();

const CONFIGURED = 'http://192.168.1.5:1234';
const ELSEWHERE = 'https://attacker.example';

const savedEnv = {
  AI_PROVIDER: process.env.AI_PROVIDER,
  CUSTOM_API_KEY: process.env.CUSTOM_API_KEY,
  CUSTOM_BASE_URL: process.env.CUSTOM_BASE_URL,
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
  OLLAMA_API_URL: process.env.OLLAMA_API_URL,
};

try {
  // ── Custom provider ────────────────────────────────────────────────────────
  process.env.AI_PROVIDER = 'custom';
  process.env.CUSTOM_BASE_URL = CONFIGURED;
  process.env.CUSTOM_API_KEY = 'stored-custom-key';
  // Left behind by an earlier provider switch — must never be reached for.
  process.env.OLLAMA_API_URL = 'http://192.168.2.100:11434';
  process.env.OLLAMA_API_KEY = 'stored-ollama-key';

  assert.strictEqual(
    resolveSettingsQuickstartApiKey(CONFIGURED, 'typed-key'),
    'typed-key',
    'A key typed into the field must win over the stored one'
  );
  assert.strictEqual(
    resolveSettingsQuickstartApiKey(ELSEWHERE, '  typed-key  '),
    'typed-key',
    'A typed key is honoured whatever the target, and is trimmed'
  );
  assert.strictEqual(
    resolveSettingsQuickstartApiKey(CONFIGURED, ''),
    'stored-custom-key',
    'An empty field must fall back to the stored key of the configured provider'
  );
  assert.strictEqual(
    resolveSettingsQuickstartApiKey(CONFIGURED, undefined),
    'stored-custom-key',
    'A missing field behaves like an empty one'
  );
  assert.strictEqual(
    resolveSettingsQuickstartApiKey(CONFIGURED, '   '),
    'stored-custom-key',
    'A whitespace-only field counts as empty'
  );

  // Same server, written the way the Quickstart field accepts it.
  assert.strictEqual(
    resolveSettingsQuickstartApiKey('http://192.168.1.5:1234/v1/', ''),
    'stored-custom-key',
    'A /v1 suffix and a trailing slash still name the configured server'
  );

  // The exfiltration case: any other host gets nothing.
  assert.strictEqual(
    resolveSettingsQuickstartApiKey(ELSEWHERE, ''),
    '',
    'A stored key must never be forwarded to a host the caller names — the settings page keeps saved secrets out of the DOM on purpose'
  );
  assert.strictEqual(
    resolveSettingsQuickstartApiKey('http://192.168.1.5:9999', ''),
    '',
    'A different port is a different server'
  );
  assert.strictEqual(
    resolveSettingsQuickstartApiKey('not a url', ''),
    '',
    'An unparseable target matches nothing'
  );
  assert.strictEqual(
    resolveSettingsQuickstartApiKey('', ''),
    '',
    'A missing target matches nothing'
  );

  // ── Ollama provider ────────────────────────────────────────────────────────
  process.env.AI_PROVIDER = 'ollama';
  assert.strictEqual(
    resolveSettingsQuickstartApiKey('http://192.168.2.100:11434', ''),
    'stored-ollama-key',
    'An Ollama setup must fall back to its own stored key'
  );
  assert.strictEqual(
    resolveSettingsQuickstartApiKey(CONFIGURED, ''),
    '',
    'The custom key must not be sent to the Ollama host, or vice versa — a stale key from a provider switch would 401 and leak'
  );

  // ── Providers with no local server ─────────────────────────────────────────
  process.env.AI_PROVIDER = 'openai';
  assert.strictEqual(
    resolveSettingsQuickstartApiKey(CONFIGURED, ''),
    '',
    'OpenAI and Azure have no Quickstart-detectable server, so nothing is substituted'
  );

  // ── Nothing stored ─────────────────────────────────────────────────────────
  process.env.AI_PROVIDER = 'custom';
  delete process.env.CUSTOM_API_KEY;
  assert.strictEqual(
    resolveSettingsQuickstartApiKey(CONFIGURED, ''),
    '',
    'With nothing stored the detection runs without a key, as before'
  );
} finally {
  Object.entries(savedEnv).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
}

// ── The settings route uses it; setup must not ───────────────────────────────

const settingsRouteStart = routeSource.indexOf(
  "'/api/settings/quickstart/detect'"
);
assert.ok(settingsRouteStart !== -1, 'Settings quickstart route not found');
const settingsRouteBody = routeSource.slice(
  settingsRouteStart,
  routeSource.indexOf('\n);', settingsRouteStart)
);
assert.ok(
  /resolveSettingsQuickstartApiKey\(\s*req\.body\?\.baseUrl,\s*req\.body\?\.apiKey\s*\)/.test(
    settingsRouteBody
  ),
  'POST /api/settings/quickstart/detect must resolve the stored key for an empty field, and must pass the target URL so the resolver can refuse a host that is not the configured one'
);

const setupRouteStart = routeSource.indexOf("'/api/setup/quickstart/detect'");
assert.ok(setupRouteStart !== -1, 'Setup quickstart route not found');
const setupRouteBody = routeSource.slice(
  setupRouteStart,
  routeSource.indexOf('\n);', setupRouteStart)
);
assert.ok(
  !setupRouteBody.includes('resolveSettingsQuickstartApiKey'),
  'The setup wizard has no stored configuration to fall back on and must keep taking the field at face value'
);

// ── The block explains itself and prefills what it safely can ────────────────

const sectionStart = viewSource.indexOf('id="sec-quickstart-auto-detect"');
assert.ok(
  sectionStart !== -1,
  'Could not find the Quickstart auto-detect section in views/settings.ejs'
);
const section = viewSource.slice(
  sectionStart,
  viewSource.indexOf('id="settingsQuickstartResults"', sectionStart)
);

assert.ok(
  /id="settingsQuickstartUrl"[^>]*value="<%=\s*quickstartUrl\s*%>"/.test(
    section
  ),
  'The AI server URL must be prefilled so the block is not blank after a restart'
);
assert.ok(
  /const quickstartUrl\s*=[\s\S]*?quickstartProvider === 'ollama'[\s\S]*?quickstartProvider === 'custom'/.test(
    section
  ),
  'The prefill must key on config.AI_PROVIDER: config.OLLAMA_API_URL carries a http://localhost:11434 default and is never empty, so a first-non-empty fallback hands every OpenAI or Azure install a localhost URL it never configured'
);

const keyField = section.slice(
  section.indexOf('id="settingsQuickstartApiKey"')
);
assert.ok(
  /placeholder="<%=\s*quickstartKeyStored \?/.test(keyField),
  'The API key field must say when a key is already configured'
);
assert.ok(
  /const quickstartKeyStored\s*=[\s\S]*?quickstartProvider === 'ollama'[\s\S]*?quickstartProvider === 'custom'/.test(
    section
  ),
  'Whether a key is stored must be read for the configured provider, matching what the route will actually substitute'
);
assert.ok(
  !/id="settingsQuickstartApiKey"[^>]*value="<%/.test(section),
  'The API key must never be rendered into the page — the settings page deliberately blanks every secret before render'
);
assert.ok(
  /drive the detection run only/.test(section),
  'The block must state that these fields are not saved'
);

console.log('PASS test-settings-quickstart-persistence');
