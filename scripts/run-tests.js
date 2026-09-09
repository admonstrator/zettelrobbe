#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const STATUS_META = {
  PASSED: { color: COLORS.green, icon: '🟢' },
  SKIPPED: { color: COLORS.yellow, icon: '🟡' },
  FAILED: { color: COLORS.red, icon: '🔴' },
};

function colorize(text, color) {
  return `${color}${text}${COLORS.reset}`;
}

function formatStatus(status) {
  const meta = STATUS_META[status] || { color: COLORS.cyan, icon: '⚪' };
  return `${meta.icon} ${colorize(status, meta.color)}`;
}

const TESTS = {
  'dashboard-stats-cache': 'test-dashboard-stats-cache.js',
  'document-type-restriction': 'test-document-type-restriction.js',
  'effective-document-count-cache': 'test-effective-document-count-cache.js',
  'tag-cache-page-size': 'test-tag-cache-page-size.js',
  'failed-reset-all': 'test-failed-reset-all.js',
  'ignore-tags-filter': 'test-ignore-tags-filter.js',
  'injected-env-priority': 'test-injected-env-priority.js',
  'changelog-releases': 'test-changelog-releases.js',
  'date-format-config': 'test-date-format-config.js',
  'log-level-config': 'test-log-level-config.js',
  'log-level-logger': 'test-log-level-logger.js',
  'native-install-log-paths': 'test-native-install-log-paths.js',
  'update-check-service': 'test-update-check-service.js',
  'mobile-table-fallback': 'test-mobile-table-fallback.js',
  'form-control-styling': 'test-form-control-styling.js',
  'settings-tag-input-wiring': 'test-settings-tag-input-wiring.js',
  'icon-sizing': 'test-icon-sizing.js',
  'mobile-toolbar-grid': 'test-mobile-toolbar-grid.js',
  'playground-deprecation': 'test-playground-deprecation.js',
  'login-mfa-flow': 'test-login-mfa-flow.js',
  'ocr-fallback-ai-errors': 'test-ocr-fallback-ai-errors.js',
  'ocr-startup-recovery': 'test-ocr-startup-recovery.js',
  'ocr-auto-process': 'test-ocr-auto-process.js',
  'ocr-auto-analyze-toggle': 'test-ocr-auto-analyze-toggle.js',
  'ocr-queue-completion': 'test-ocr-queue-completion.js',
  'search-documents-exact-id': 'test-search-documents-exact-id.js',
  'document-metadata-batching': 'test-document-metadata-batching.js',
  'pr772-fix': 'test-pr772-fix.js',
  'ollama-response-limit': 'test-ollama-response-limit.js',
  'response-truncation-detection': 'test-response-truncation-detection.js',
  'ollama-temperature-wiring': 'test-ollama-temperature-wiring.js',
  'quickstart-model-classification': 'test-quickstart-model-classification.js',
  'quickstart-endpoint-protection': 'test-quickstart-endpoint-protection.js',
  'setup-wizard-quickstart': 'test-setup-wizard-quickstart.js',
  'settings-quickstart-persistence': 'test-settings-quickstart-persistence.js',
  'setup-preset-manual-reset': 'test-setup-preset-manual-reset.js',
  'rate-limiting': 'test-rate-limiting.js',
  'scan-stop-flow': 'test-scan-stop-flow.js',
  'scan-now-user-id-independence': 'test-scan-now-user-id-independence.js',
  'scanner-startup-resilience': 'test-scanner-startup-resilience.js',
  'paperless-unreachable-banner': 'test-paperless-unreachable-banner.js',
  'setup-auth-endpoint-protection': 'test-setup-auth-endpoint-protection.js',
  'setup-auth-middleware-guards': 'test-setup-auth-middleware-guards.js',
  'setup-remote-guard': 'test-setup-remote-guard.js',
  'thumbnail-auth-guard': 'test-thumbnail-auth-guard.js',
  'thumbnail-startup-migration': 'test-thumbnail-startup-migration.js',
  'restriction-service': 'test-restriction-service.js',
  'updated-service': 'test-updated-service.js',
  'prompt-existing-data-serialization':
    'test-prompt-existing-data-serialization.js',
  'restricted-document-types-placeholder':
    'test-restricted-document-types-placeholder.js',
  'ssrf-url-validation': 'test-ssrf-url-validation.js',
  'external-api-ssrf-block': 'test-external-api-ssrf-block.js',
  'ui-xss-hardening': 'test-ui-xss-hardening.js',
  'history-xss-hardening': 'test-history-xss-hardening.js',
  'ai-temperature-config': 'test-ai-temperature-config.js',
  'custom-field-monetary-normalization':
    'test-custom-field-monetary-normalization.js',
  'mistral-ocr-no-processed-on-update-failure':
    'test-mistral-ocr-no-processed-on-update-failure.js',
  'ocr-provider-lmstudio-compatible':
    'test-ocr-provider-lmstudio-compatible.js',
  'ocr-model-fetch-key': 'test-ocr-model-fetch-key.js',
  'mistral-ocr-image-payload': 'test-mistral-ocr-image-payload.js',
  'ocr-model-discovery-unfiltered': 'test-ocr-model-discovery-unfiltered.js',
  'ocr-provider-ollama': 'test-ocr-provider-ollama.js',
  'ocr-pdf-render-multipage': 'test-ocr-pdf-render-multipage.js',
  'ocr-pdf-render-fallback': 'test-ocr-pdf-render-fallback.js',
  'ocr-pdf-render-page-failure': 'test-ocr-pdf-render-page-failure.js',
  'poppler-render-real': 'test-poppler-render-real.js',
  'ollama-token-metrics': 'test-ollama-token-metrics.js',
  'reconciliation-service': 'test-reconciliation-service.js',
  'reset-local-overrides-password-guard':
    'test-reset-local-overrides-password-guard.js',
  'runtime-first-setup-state': 'test-runtime-first-setup-state.js',
  'settings-paperless-url-fallback': 'test-settings-paperless-url-fallback.js',
  'dashboard-layout-validation': 'test-dashboard-layout-validation.js',
  'env-export': 'test-env-export.js',
  'setup-bootstrap-security': 'test-setup-bootstrap-security.js',
  'setup-ocr-disabled-skip': 'test-setup-ocr-disabled-skip.js',
  'setup-route-security': 'test-setup-route-security.js',
  'setup-wizard-tag-default': 'test-setup-wizard-tag-default.js',
  'setupservice-ocr-validation': 'test-setupservice-ocr-validation.js',
  'csrf-token-refresh': 'test-csrf-token-refresh.js',
  'redirect-guard': 'test-redirect-guard.js',
  'thumbnail-cache-path-sanitization':
    'test-thumbnail-cache-path-sanitization.js',
  'url-base-validation': 'test-url-base-validation.js',
  'session-token-type': 'test-session-token-type.js',
  'setup-complete-guard': 'test-setup-complete-guard.js',
};

const AREAS = {
  auth: ['login-mfa-flow', 'rate-limiting', 'thumbnail-auth-guard'],
  ocr: [
    'ocr-fallback-ai-errors',
    'ocr-startup-recovery',
    'ocr-auto-process',
    'ocr-auto-analyze-toggle',
    'ocr-queue-completion',
    'search-documents-exact-id',
    'document-metadata-batching',
    'mistral-ocr-no-processed-on-update-failure',
    'ocr-provider-lmstudio-compatible',
    'ocr-model-fetch-key',
    'ocr-model-discovery-unfiltered',
    'mistral-ocr-image-payload',
    'ocr-provider-ollama',
    'ocr-pdf-render-multipage',
    'ocr-pdf-render-fallback',
    'ocr-pdf-render-page-failure',
    'poppler-render-real',
    'setup-ocr-disabled-skip',
    'setupservice-ocr-validation',
  ],
  observability: [
    'changelog-releases',
    'date-format-config',
    'log-level-config',
    'log-level-logger',
    'native-install-log-paths',
    'update-check-service',
    'mobile-table-fallback',
    'form-control-styling',
    'settings-tag-input-wiring',
    'icon-sizing',
    'mobile-toolbar-grid',
    'playground-deprecation',
  ],
  processing: [
    'dashboard-stats-cache',
    'document-type-restriction',
    'ignore-tags-filter',
    'effective-document-count-cache',
    'tag-cache-page-size',
    'failed-reset-all',
    'injected-env-priority',
    'ollama-response-limit',
    'response-truncation-detection',
    'ollama-temperature-wiring',
    'pr772-fix',
    'scan-stop-flow',
    'scan-now-user-id-independence',
    'scanner-startup-resilience',
    'paperless-unreachable-banner',
    'thumbnail-startup-migration',
    'ai-temperature-config',
    'custom-field-monetary-normalization',
    'ollama-token-metrics',
    'reconciliation-service',
    'settings-paperless-url-fallback',
  ],
  prompts: [
    'restriction-service',
    'updated-service',
    'prompt-existing-data-serialization',
    'restricted-document-types-placeholder',
  ],
  quickstart: [
    'quickstart-model-classification',
    'setup-wizard-quickstart',
    'quickstart-endpoint-protection',
    'settings-quickstart-persistence',
    'runtime-first-setup-state',
    'setup-wizard-tag-default',
    'setup-preset-manual-reset',
  ],
  security: [
    'setup-remote-guard',
    'setup-auth-middleware-guards',
    'setup-auth-endpoint-protection',
    'quickstart-endpoint-protection',
    'ssrf-url-validation',
    'external-api-ssrf-block',
    'csrf-token-refresh',
    'redirect-guard',
    'ui-xss-hardening',
    'history-xss-hardening',
    'reset-local-overrides-password-guard',
    'setup-bootstrap-security',
    'setup-route-security',
    'dashboard-layout-validation',
    'env-export',
    'thumbnail-cache-path-sanitization',
    'url-base-validation',
    'session-token-type',
    'setup-complete-guard',
  ],
};

// Tests intentionally excluded from the auto-discovery drift check below.
// Keep empty unless a tests/test-*.js file exists that must NOT be run by the
// runner (e.g. a shared helper). Prefer registering real tests in TESTS.
const INTENTIONALLY_UNREGISTERED = new Set([]);

// Guard against registry drift: every tests/test-*.js must be registered in
// TESTS (or explicitly excluded above). Without this, a newly added test file
// silently never runs in CI. Returns the list of unregistered file names.
function findUnregisteredTests() {
  const testsDir = path.join(__dirname, '..', 'tests');
  let entries;
  try {
    entries = fs.readdirSync(testsDir);
  } catch {
    return [];
  }

  const registered = new Set(Object.values(TESTS));
  return entries
    .filter((name) => /^test-.*\.js$/.test(name))
    .filter(
      (name) => !registered.has(name) && !INTENTIONALLY_UNREGISTERED.has(name)
    )
    .sort();
}

function hasLoginCredentials() {
  return Boolean(
    process.env.LOGIN_TEST_USERNAME && process.env.LOGIN_TEST_PASSWORD
  );
}

function checkPdftoppmAvailability() {
  // Only a missing/inaccessible binary counts as unavailable; poppler's `-v`
  // exit code is not reliable across versions.
  const result = spawnSync('pdftoppm', ['-v'], { timeout: 5000 });
  return !result.error;
}

function checkHttpAvailability(baseUrl, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      resolve(false);
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: '/health',
        method: 'GET',
        timeout: timeoutMs,
      },
      () => {
        resolve(true);
      }
    );

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function getSkipReason(testName) {
  if (testName === 'login-mfa-flow' && !hasLoginCredentials()) {
    return 'missing LOGIN_TEST_USERNAME/LOGIN_TEST_PASSWORD';
  }

  if (testName === 'poppler-render-real' && !checkPdftoppmAvailability()) {
    return 'pdftoppm not installed';
  }

  if (testName === 'rate-limiting') {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const reachable = await checkHttpAvailability(baseUrl);
    if (!reachable) {
      return `server not reachable at ${baseUrl}`;
    }
  }

  if (testName === 'thumbnail-auth-guard') {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const reachable = await checkHttpAvailability(baseUrl);
    if (!reachable) {
      return `server not reachable at ${baseUrl}`;
    }
  }

  if (testName === 'scan-stop-flow') {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const reachable = await checkHttpAvailability(baseUrl);
    if (!reachable) {
      return `server not reachable at ${baseUrl}`;
    }

    const hasToken = Boolean(process.env.JWT_TOKEN);
    const hasApiKey = Boolean(
      process.env.API_KEY || process.env.PAPERLESS_AI_API_KEY
    );
    if (!hasToken && !hasApiKey) {
      return 'missing JWT_TOKEN or API_KEY/PAPERLESS_AI_API_KEY';
    }
  }

  if (
    testName === 'setup-auth-endpoint-protection' ||
    testName === 'quickstart-endpoint-protection'
  ) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const reachable = await checkHttpAvailability(baseUrl);
    if (!reachable) {
      return `server not reachable at ${baseUrl}`;
    }
  }

  return null;
}

function printUsage() {
  console.log(
    'Usage: node scripts/run-tests.js [--all] [--area <name>] [--test <name>] [--list]'
  );
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/run-tests.js --all');
  console.log('  node scripts/run-tests.js --area security');
  console.log('  node scripts/run-tests.js --test document-type-restriction');
  console.log('');
  console.log('Areas:', Object.keys(AREAS).join(', '));
  console.log('Tests:', Object.keys(TESTS).join(', '));
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    list: false,
    all: false,
    area: null,
    test: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--list') {
      parsed.list = true;
      continue;
    }

    if (arg === '--all') {
      parsed.all = true;
      continue;
    }

    if (arg === '--area') {
      parsed.area = args[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg === '--test') {
      parsed.test = args[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    console.error(`Unknown argument: ${arg}`);
    printUsage();
    process.exit(1);
  }

  return parsed;
}

function resolveSelection(parsed) {
  if (parsed.list) {
    console.log('Areas:');
    Object.entries(AREAS).forEach(([area, tests]) => {
      console.log(`- ${area}: ${tests.join(', ')}`);
    });
    console.log('');
    console.log('Tests:');
    Object.keys(TESTS).forEach((testName) => {
      console.log(`- ${testName}`);
    });
    process.exit(0);
  }

  if (parsed.test) {
    if (!TESTS[parsed.test]) {
      console.error(`Unknown test: ${parsed.test}`);
      printUsage();
      process.exit(1);
    }
    return [parsed.test];
  }

  if (parsed.area) {
    if (!AREAS[parsed.area]) {
      console.error(`Unknown area: ${parsed.area}`);
      printUsage();
      process.exit(1);
    }
    return [...AREAS[parsed.area]];
  }

  if (parsed.all) {
    return Object.keys(TESTS);
  }

  printUsage();
  process.exit(1);
}

async function runTest(testName) {
  const fileName = TESTS[testName];
  const filePath = path.join(__dirname, '..', 'tests', fileName);

  const skipReason = await getSkipReason(testName);
  if (skipReason) {
    console.log(`\n[SKIP] ${testName} -> ${fileName} (${skipReason})`);
    return {
      testName,
      fileName,
      code: 0,
      skipped: true,
      skipReason,
    };
  }

  console.log(`\n[TEST] ${testName} -> ${fileName}`);
  const result = spawnSync(process.execPath, [filePath], {
    stdio: 'inherit',
    env: process.env,
  });

  return {
    testName,
    fileName,
    code: typeof result.status === 'number' ? result.status : 1,
    skipped: false,
    skipReason: null,
  };
}

async function main() {
  const parsed = parseArgs(process.argv);

  // On the full-suite run (the CI path) fail loudly if any test file is not
  // registered, so new tests can never silently drop out of CI coverage.
  if (parsed.all) {
    const unregistered = findUnregisteredTests();
    if (unregistered.length > 0) {
      console.error(
        `[REGISTRY] ${unregistered.length} test file(s) are not registered in TESTS ` +
          `(add them, or list in INTENTIONALLY_UNREGISTERED):`
      );
      unregistered.forEach((name) => console.error(`- ${name}`));
      process.exit(1);
    }
  }

  const selectedTests = resolveSelection(parsed);
  const failures = [];
  const skipped = [];
  const passed = [];
  const statusRows = [];

  for (const testName of selectedTests) {
    const runResult = await runTest(testName);
    if (runResult.skipped) {
      skipped.push(runResult);
      statusRows.push({
        testName: runResult.testName,
        status: 'SKIPPED',
        detail: runResult.skipReason,
      });
      continue;
    }

    if (runResult.code !== 0) {
      failures.push(runResult);
      statusRows.push({
        testName: runResult.testName,
        status: 'FAILED',
        detail: `exit=${runResult.code}`,
      });
      continue;
    }

    passed.push(runResult);
    statusRows.push({
      testName: runResult.testName,
      status: 'PASSED',
      detail: 'passed',
    });
  }

  console.log('\n========================================');
  console.log(colorize('[STATUS] Test summary:', COLORS.cyan));
  statusRows.forEach((row) => {
    console.log(
      `- [${formatStatus(row.status)}] ${row.testName} (${row.detail})`
    );
  });

  console.log('');
  console.log(
    `[COUNT] ${formatStatus('PASSED')}=${passed.length} ${formatStatus('SKIPPED')}=${skipped.length} ${formatStatus('FAILED')}=${failures.length}`
  );

  if (skipped.length > 0) {
    console.log(`[SKIPPED] ${skipped.length} test(s):`);
    skipped.forEach((entry) => {
      console.log(`- ${entry.testName} (${entry.skipReason})`);
    });
  }

  if (failures.length === 0) {
    console.log(
      `[RESULT] All runnable tests passed (${selectedTests.length - skipped.length}/${selectedTests.length}).`
    );
    process.exit(0);
  }

  console.log(
    `[RESULT] ${failures.length} of ${selectedTests.length} test(s) failed:`
  );
  failures.forEach((failure) => {
    console.log(
      `- ${failure.testName} (${failure.fileName}) exit=${failure.code}`
    );
  });
  process.exit(1);
}

main().catch((error) => {
  console.error('[FATAL] test runner failed:', error.message);
  process.exit(1);
});
