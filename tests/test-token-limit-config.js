/**
 * Test: TOKEN_LIMIT parsing and the token-budget guard in the AI services
 *
 * config.tokenLimit used to be `process.env.TOKEN_LIMIT || 128000` — the raw
 * environment string. `TOKEN_LIMIT=128k` therefore made
 * `Number(config.tokenLimit)` NaN, so `availableTokens` was NaN, the
 * `availableTokens <= 0` guard did not fire (every comparison with NaN is
 * false), and truncateToTokenLimit() answered with an empty string. The model
 * received a document with no text, invented title, correspondent, tags and
 * date, and the app wrote them into Paperless-ngx without a single error.
 *
 * Covers:
 * 1. config.tokenLimit is a finite positive integer for every input, valid or
 *    not, with the documented fallback for the invalid ones
 * 2. The value survives the config module being reloaded from a clean cache
 * 3. With a non-finite budget, analyzeDocument() in the OpenAI, Azure and
 *    custom services returns the error result and never reaches the provider
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

const configModulePath = require.resolve('../config/config');
const FALLBACK = 128000;

const originalEnv = { ...process.env };
const originalCwd = process.cwd();

function restoreEnvironment() {
  process.env = originalEnv;
  delete require.cache[configModulePath];
}

function silenceConsole() {
  const saved = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const captured = [];
  const record =
    (stream) =>
    (...args) =>
      captured.push(`${stream} ${args.join(' ')}`);

  console.log = record('log');
  console.info = record('info');
  console.warn = record('warn');
  console.error = record('error');
  console.debug = record('debug');

  return {
    captured,
    restore: () => Object.assign(console, saved),
  };
}

/* Reloading the module reprints its whole startup banner, which would bury the
   test output; the captured lines are also how the warning is asserted. */
function loadConfigWithTokenLimit(value) {
  delete require.cache[configModulePath];

  if (typeof value === 'undefined') {
    delete process.env.TOKEN_LIMIT;
  } else {
    process.env.TOKEN_LIMIT = String(value);
  }

  const console_ = silenceConsole();
  try {
    return { config: require('../config/config'), output: console_.captured };
  } finally {
    console_.restore();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 1 + 2: the parsed value
// ──────────────────────────────────────────────────────────────────────────────

/* "128k" is the interesting one: it is what a human writes for 128000, it is
   what broke the installation the audit reproduced, and a lenient parseInt()
   would silently turn it into a 128-token context window rather than reject
   it. */
const CASES = [
  { input: '128k', expected: FALLBACK, warns: true, why: 'unit suffix' },
  { input: 'abc', expected: FALLBACK, warns: true, why: 'not a number' },
  { input: '0', expected: FALLBACK, warns: true, why: 'zero' },
  { input: '-5', expected: FALLBACK, warns: true, why: 'negative' },
  // An unset or blank variable is the normal case, not a misconfiguration.
  { input: '', expected: FALLBACK, warns: false, why: 'empty' },
  { input: undefined, expected: FALLBACK, warns: false, why: 'unset' },
  { input: '8000', expected: 8000, warns: false, why: 'valid 8k limit' },
  { input: '128000', expected: 128000, warns: false, why: 'valid 128k limit' },
];

async function testConfigParsing() {
  await test('config.tokenLimit is always a finite positive integer', () => {
    for (const { input, why } of CASES) {
      const { config } = loadConfigWithTokenLimit(input);

      assert.ok(
        Number.isFinite(config.tokenLimit),
        `TOKEN_LIMIT=${String(input)} (${why}) produced a non-finite tokenLimit: ${config.tokenLimit}`
      );
      assert.ok(
        config.tokenLimit > 0,
        `TOKEN_LIMIT=${String(input)} (${why}) produced a non-positive tokenLimit: ${config.tokenLimit}`
      );
      assert.ok(
        Number.isInteger(config.tokenLimit),
        `TOKEN_LIMIT=${String(input)} (${why}) produced a non-integer tokenLimit: ${config.tokenLimit}`
      );
      // The old code handed the raw string through; every consumer then had to
      // remember to call Number() on it.
      assert.strictEqual(
        typeof config.tokenLimit,
        'number',
        `TOKEN_LIMIT=${String(input)} (${why}) must be a number, not a ${typeof config.tokenLimit}`
      );
    }
  });

  await test('invalid values fall back and valid ones are parsed', () => {
    for (const { input, expected, why } of CASES) {
      const { config } = loadConfigWithTokenLimit(input);

      assert.strictEqual(
        config.tokenLimit,
        expected,
        `TOKEN_LIMIT=${String(input)} (${why}) expected ${expected}, got ${config.tokenLimit}`
      );
    }
  });

  await test('a rejected value is reported instead of silently replaced', () => {
    for (const { input, warns, why } of CASES) {
      const { output } = loadConfigWithTokenLimit(input);
      const warnings = output.filter(
        (line) => line.startsWith('warn ') && line.includes('TOKEN_LIMIT')
      );

      if (warns) {
        assert.strictEqual(
          warnings.length,
          1,
          `TOKEN_LIMIT=${String(input)} (${why}) must warn exactly once, got ${warnings.length}`
        );
        assert.match(
          warnings[0],
          new RegExp(`Invalid TOKEN_LIMIT value.*Falling back to ${FALLBACK}`),
          `Unexpected warning for TOKEN_LIMIT=${String(input)}: ${warnings[0]}`
        );
      } else {
        assert.strictEqual(
          warnings.length,
          0,
          `TOKEN_LIMIT=${String(input)} (${why}) must not warn, got: ${warnings.join(' | ')}`
        );
      }
    }
  });

  await test('a broken TOKEN_LIMIT never yields a NaN token budget', () => {
    const { config } = loadConfigWithTokenLimit('128k');
    // This is the exact expression the three services evaluate.
    const availableTokens =
      Number(config.tokenLimit) - (500 + Number(config.responseTokens));

    assert.ok(
      Number.isFinite(availableTokens),
      `availableTokens must stay finite, got ${availableTokens}`
    );
    assert.ok(
      availableTokens > 0,
      `availableTokens must stay positive, got ${availableTokens}`
    );
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 3: the guard in the services
//
// Loaded in a throwaway working directory: the thumbnail cache path and the
// prompt log are both resolved against process.cwd() at require time.
// ──────────────────────────────────────────────────────────────────────────────

const SERVICES = [
  { name: 'openai', modulePath: '../services/openaiService' },
  { name: 'azure', modulePath: '../services/azureService' },
  { name: 'custom', modulePath: '../services/customService' },
];

async function testServiceGuards() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'token-limit-test-'));
  const documentId = 1;

  try {
    fs.mkdirSync(path.join(sandbox, 'data', 'thumb-cache'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(sandbox, 'data', 'logs'), { recursive: true });
    // Satisfies the thumbnail cache check without any Paperless-ngx call.
    fs.writeFileSync(
      path.join(sandbox, 'data', 'thumb-cache', `${documentId}.png`),
      ''
    );

    process.chdir(sandbox);

    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    process.env.CUSTOM_FIELDS = JSON.stringify({ custom_fields: [] });
    process.env.USE_PROMPT_TAGS = 'no';
    delete process.env.TOKEN_LIMIT;

    for (const { name, modulePath } of SERVICES) {
      await test(`${name}: a non-finite budget fails before the provider is called`, async () => {
        const resolved = require.resolve(modulePath);
        delete require.cache[configModulePath];
        delete require.cache[
          require.resolve('../services/thumbnailCachePaths')
        ];
        delete require.cache[resolved];

        // Reloading config reprints its startup banner; the service is
        // loaded in the same quiet window so it sees that same instance.
        const loading = silenceConsole();
        let config;
        let service;
        try {
          config = require('../config/config');
          service = require(modulePath);
        } finally {
          loading.restore();
        }

        // What TOKEN_LIMIT=128k used to leave behind. The parser now
        // prevents it; the guard is the second line of defence for a value
        // that reaches the service some other way.
        config.tokenLimit = NaN;

        let clientCalls = 0;
        service.client = {
          chat: {
            completions: {
              create: async () => {
                clientCalls++;
                throw new Error('The provider must not be reached');
              },
            },
          },
        };

        const console_ = silenceConsole();
        let result;
        try {
          result = await service.analyzeDocument(
            'A long enough document body to be worth analysing.',
            [],
            [],
            [],
            documentId
          );
        } finally {
          console_.restore();
          delete require.cache[resolved];
        }

        assert.ok(result, 'analyzeDocument() must return a result object');
        assert.match(
          String(result.error),
          /Token limit exceeded/,
          `Expected the existing "Token limit exceeded" error, got: ${result.error}`
        );
        assert.deepStrictEqual(
          result.document,
          { tags: [], correspondent: null },
          'The error result must keep its established shape'
        );
        assert.strictEqual(
          result.metrics,
          null,
          'A failed analysis must not report metrics'
        );
        assert.strictEqual(
          clientCalls,
          0,
          'The provider must not be called with an empty document'
        );
      });
    }
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

(async () => {
  try {
    await testConfigParsing();
    await testServiceGuards();
  } finally {
    restoreEnvironment();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
