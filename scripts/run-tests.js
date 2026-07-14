#!/usr/bin/env node

const { spawnSync } = require('child_process');
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
  'document-type-restriction': 'test-document-type-restriction.js',
  'effective-document-count-cache': 'test-effective-document-count-cache.js',
  'failed-reset-all': 'test-failed-reset-all.js',
  'ignore-tags-filter': 'test-ignore-tags-filter.js',
  'injected-env-priority': 'test-injected-env-priority.js',
  'log-level-config': 'test-log-level-config.js',
  'log-level-logger': 'test-log-level-logger.js',
  'login-mfa-flow': 'test-login-mfa-flow.js',
  'ocr-fallback-ai-errors': 'test-ocr-fallback-ai-errors.js',
  'ocr-startup-recovery': 'test-ocr-startup-recovery.js',
  'pr772-fix': 'test-pr772-fix.js',
  'ollama-temperature-wiring': 'test-ollama-temperature-wiring.js',
  'quickstart-model-classification': 'test-quickstart-model-classification.js',
  'quickstart-endpoint-protection': 'test-quickstart-endpoint-protection.js',
  'setup-wizard-quickstart': 'test-setup-wizard-quickstart.js',
  'rate-limiting': 'test-rate-limiting.js',
  'scan-stop-flow': 'test-scan-stop-flow.js',
  'setup-auth-endpoint-protection': 'test-setup-auth-endpoint-protection.js',
  'setup-auth-middleware-guards': 'test-setup-auth-middleware-guards.js',
  'setup-remote-guard': 'test-setup-remote-guard.js',
  'thumbnail-auth-guard': 'test-thumbnail-auth-guard.js',
  'thumbnail-startup-migration': 'test-thumbnail-startup-migration.js',
  'restriction-service': 'test-restriction-service.js',
  'updated-service': 'test-updated-service.js',
  'ssrf-url-validation': 'test-ssrf-url-validation.js',
  'external-api-ssrf-block': 'test-external-api-ssrf-block.js',
  'ui-xss-hardening': 'test-ui-xss-hardening.js',
  'history-xss-hardening': 'test-history-xss-hardening.js',
};

const AREAS = {
  auth: ['login-mfa-flow', 'rate-limiting', 'thumbnail-auth-guard'],
  ocr: ['ocr-fallback-ai-errors', 'ocr-startup-recovery'],
  observability: ['log-level-config', 'log-level-logger'],
  processing: [
    'document-type-restriction',
    'ignore-tags-filter',
    'effective-document-count-cache',
    'failed-reset-all',
    'injected-env-priority',
    'ollama-temperature-wiring',
    'pr772-fix',
    'scan-stop-flow',
    'thumbnail-startup-migration',
  ],
  prompts: ['restriction-service', 'updated-service'],
  quickstart: [
    'quickstart-model-classification',
    'setup-wizard-quickstart',
    'quickstart-endpoint-protection',
  ],
  security: [
    'setup-remote-guard',
    'setup-auth-middleware-guards',
    'setup-auth-endpoint-protection',
    'quickstart-endpoint-protection',
    'ssrf-url-validation',
    'external-api-ssrf-block',
    'ui-xss-hardening',
    'history-xss-hardening',
  ],
};

function hasLoginCredentials() {
  return Boolean(
    process.env.LOGIN_TEST_USERNAME && process.env.LOGIN_TEST_PASSWORD
  );
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
  console.log('  node scripts/run-tests.js --area chat');
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
