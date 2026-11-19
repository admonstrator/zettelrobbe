'use strict';

/**
 * A stored OCR timeout of exactly 30000 ms becomes the default once, on the
 * first start with this version (startup migration CFG-OCR-TIMEOUT-001).
 *
 * Before 2b53422 the settings form, the setup wizard and every save wrote
 * SETUP_OCR_VALIDATION_TIMEOUT_MS=30000 whether anyone chose it or not, and
 * since 1572d36 the same key governs document OCR, which had waited 120
 * seconds. 2b53422 fixed the default for the future; a value already written
 * stayed at 30 seconds.
 *
 * Runs in a temporary directory with the real config, setupService, startup
 * migration runner and OCR service. config/config.js is loaded again for
 * every case, so the stored files reach process.env the way they do at a
 * start, and the environment snapshot decides which keys the container sets.
 *
 * Cases:
 *   1. runtime overrides: 30000 and "30000" are raised; 30001, 45000, an
 *      empty value, a missing key and a missing file stay as they were
 *   2. the fallback key SETUP_VALIDATION_TIMEOUT_MS is not touched
 *   3. legacy data/.env: raised there; another value stays
 *   4. set by the environment: nothing is written, one log line for 30000,
 *      none for another value
 *   5. once: 30000 set again after the raise stays, across a restart
 *   6. the running OCR service waits the raised value without a restart
 *   7. the log line reaches both log files
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = 'SETUP_OCR_VALIDATION_TIMEOUT_MS';
const FALLBACK_KEY = 'SETUP_VALIDATION_TIMEOUT_MS';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  [FAIL] ${name}: ${error.stack || error.message}`);
  }
}

/** A logger for runStartupMigrations() that keeps every line. */
function lineLogger() {
  const lines = [];
  const keep =
    (level) =>
    (...args) =>
      lines.push({ level, text: args.join(' ') });
  return {
    lines,
    texts: () => lines.map((line) => line.text),
    log: keep('info'),
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    debug: keep('debug'),
  };
}

/** Runs fn with the console silenced. */
function silently(fn) {
  const real = { ...console };
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    console[method] = () => {};
  }
  try {
    return fn();
  } finally {
    Object.assign(console, real);
  }
}

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-ocr-timeout-'));
  const dataDir = path.join(tempRoot, 'data');
  const overridesPath = path.join(dataDir, 'runtime-overrides.json');
  const envPath = path.join(dataDir, '.env');
  const savedEnv = {
    [KEY]: process.env[KEY],
    [FALLBACK_KEY]: process.env[FALLBACK_KEY],
    CONFIG_SOURCE_MODE: process.env.CONFIG_SOURCE_MODE,
    LOG_LEVEL: process.env.LOG_LEVEL,
  };
  const savedSnapshot = global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__;

  process.chdir(tempRoot);
  fs.mkdirSync(dataDir, { recursive: true });
  delete process.env[KEY];
  delete process.env[FALLBACK_KEY];
  delete process.env.CONFIG_SOURCE_MODE;
  process.env.LOG_LEVEL = 'info';
  // Nothing comes from the container unless a case says so.
  global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = {};

  const configPath = require.resolve('../config/config');
  silently(() => require(configPath));
  const {
    runStartupMigrations,
    STARTUP_MIGRATION_STATE_PATH,
  } = require('../services/startupMigrations');
  const {
    DEFAULT_OCR_TIMEOUT_MS,
    ocrTimeoutMsFromEnv,
  } = require('../services/ocrTimeout');
  const dotenv = require('dotenv');

  /**
   * One start of the app: the stored files and the container environment as
   * given, config/config.js loaded again so it applies them to process.env.
   */
  function start({
    mode = 'runtime-first',
    overrides,
    envFile,
    injected,
  } = {}) {
    if (mode === 'legacy') {
      process.env.CONFIG_SOURCE_MODE = 'legacy';
    } else {
      delete process.env.CONFIG_SOURCE_MODE;
    }
    if (overrides !== undefined) {
      fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2));
    }
    if (envFile !== undefined) {
      fs.writeFileSync(envPath, envFile);
    }
    delete process.env[KEY];
    delete process.env[FALLBACK_KEY];
    global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = {};
    if (injected !== undefined) {
      process.env[KEY] = injected;
      global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__[KEY] = injected;
    }
    delete require.cache[configPath];
    silently(() => require(configPath));
  }

  /** A fresh installation directory: no stored values, no migration state. */
  function reset() {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const readOverrides = () =>
    fs.existsSync(overridesPath)
      ? JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
      : undefined;
  const readEnvFile = () =>
    fs.existsSync(envPath)
      ? dotenv.parse(fs.readFileSync(envPath, 'utf8'))
      : undefined;
  const raisedLines = (logger) =>
    logger.texts().filter((text) => /OCR timeout raised/.test(text));

  /** The migration's own entry in a summary. */
  const stepOf = (summary) =>
    summary.find((step) => step.id === 'CFG-OCR-TIMEOUT-001');

  try {
    console.log('\n=== Stored OCR timeout of 30 seconds ===');

    // ── 1. runtime overrides ──────────────────────────────────────────────

    for (const stored of [30000, '30000']) {
      await test(`runtime overrides: ${JSON.stringify(stored)} is raised to the default`, async () => {
        reset();
        start({
          overrides: { [KEY]: stored, PAPERLESS_API_URL: 'http://p:8000' },
        });
        assert.strictEqual(
          String(process.env[KEY]),
          '30000',
          'loaded at start'
        );

        const logger = lineLogger();
        const step = stepOf(await runStartupMigrations(logger));
        assert.strictEqual(step.status, 'applied');

        assert.deepStrictEqual(readOverrides(), {
          [KEY]: String(DEFAULT_OCR_TIMEOUT_MS),
          PAPERLESS_API_URL: 'http://p:8000',
        });
        assert.strictEqual(process.env[KEY], String(DEFAULT_OCR_TIMEOUT_MS));
        const lines = raisedLines(logger);
        assert.strictEqual(lines.length, 1, logger.texts().join(' | '));
        assert.ok(
          lines[0].includes('from 30 to 120 seconds') &&
            lines[0].includes('old default'),
          lines[0]
        );
      });
    }

    const untouched = [
      ['30001', { [KEY]: '30001' }],
      ['45000', { [KEY]: '45000' }],
      ['an empty value', { [KEY]: '' }],
      ['a missing key', { PAPERLESS_API_URL: 'http://p:8000' }],
      ['a missing file', undefined],
    ];
    for (const [label, overrides] of untouched) {
      await test(`runtime overrides: ${label} stays as it was`, async () => {
        reset();
        start({ overrides });
        const fileBefore = fs.existsSync(overridesPath)
          ? fs.readFileSync(overridesPath, 'utf8')
          : null;
        const envBefore = process.env[KEY];

        const logger = lineLogger();
        const step = stepOf(await runStartupMigrations(logger));
        assert.strictEqual(step.status, 'applied', 'it ran, and counts as run');

        const fileAfter = fs.existsSync(overridesPath)
          ? fs.readFileSync(overridesPath, 'utf8')
          : null;
        assert.strictEqual(fileAfter, fileBefore, 'the file is unchanged');
        assert.strictEqual(process.env[KEY], envBefore);
        assert.deepStrictEqual(raisedLines(logger), []);
      });
    }

    // ── 2. the fallback key ───────────────────────────────────────────────

    await test(`${FALLBACK_KEY} is not touched`, async () => {
      reset();
      start({ overrides: { [FALLBACK_KEY]: '30000' } });
      const logger = lineLogger();
      await runStartupMigrations(logger);
      assert.deepStrictEqual(readOverrides(), { [FALLBACK_KEY]: '30000' });
      assert.strictEqual(process.env[FALLBACK_KEY], '30000');
      assert.strictEqual(process.env[KEY], undefined);
      assert.deepStrictEqual(raisedLines(logger), []);
    });

    // ── 3. legacy data/.env ───────────────────────────────────────────────

    await test('legacy data/.env: 30000 is raised in the file and the process', async () => {
      reset();
      start({
        mode: 'legacy',
        envFile: `PAPERLESS_API_URL="http://p:8000"\n${KEY}="30000"`,
      });
      assert.strictEqual(process.env[KEY], '30000', 'loaded at start');

      const logger = lineLogger();
      await runStartupMigrations(logger);

      const envFile = readEnvFile();
      assert.strictEqual(envFile[KEY], String(DEFAULT_OCR_TIMEOUT_MS));
      assert.strictEqual(envFile.PAPERLESS_API_URL, 'http://p:8000');
      assert.notStrictEqual(readOverrides()?.[KEY], '30000');
      assert.strictEqual(process.env[KEY], String(DEFAULT_OCR_TIMEOUT_MS));
      assert.strictEqual(raisedLines(logger).length, 1);
    });

    await test('legacy data/.env: 45000 stays', async () => {
      reset();
      const content = `PAPERLESS_API_URL="http://p:8000"\n${KEY}="45000"`;
      start({ mode: 'legacy', envFile: content });
      await runStartupMigrations(lineLogger());
      assert.strictEqual(fs.readFileSync(envPath, 'utf8'), content);
      assert.strictEqual(fs.existsSync(overridesPath), false);
      assert.strictEqual(process.env[KEY], '45000');
    });

    // ── 4. set by the environment ─────────────────────────────────────────

    await test('set by the environment to 30000: nothing written, one line that says what to do', async () => {
      reset();
      start({ injected: '30000' });
      const logger = lineLogger();
      const step = stepOf(await runStartupMigrations(logger));
      assert.strictEqual(step.status, 'applied');

      assert.strictEqual(process.env[KEY], '30000');
      assert.strictEqual(fs.existsSync(overridesPath), false);
      assert.strictEqual(fs.existsSync(envPath), false);
      assert.deepStrictEqual(raisedLines(logger), []);

      const notes = logger.lines.filter((line) => line.text.includes(KEY));
      assert.strictEqual(notes.length, 1, logger.texts().join(' | '));
      assert.strictEqual(notes[0].level, 'warn');
      for (const part of [
        '30000',
        'environment',
        'old default',
        '120000',
        'Remove',
      ]) {
        assert.ok(notes[0].text.includes(part), `${part}: ${notes[0].text}`);
      }
    });

    await test('set by the environment to 30000 with 30000 in the overrides too: the file is left alone', async () => {
      reset();
      start({ injected: '30000', overrides: { [KEY]: '30000' } });
      const before = fs.readFileSync(overridesPath, 'utf8');
      await runStartupMigrations(lineLogger());
      assert.strictEqual(fs.readFileSync(overridesPath, 'utf8'), before);
      assert.strictEqual(process.env[KEY], '30000');
    });

    await test('set by the environment to another value: no line', async () => {
      reset();
      start({ injected: '45000' });
      const logger = lineLogger();
      await runStartupMigrations(logger);
      assert.strictEqual(process.env[KEY], '45000');
      assert.deepStrictEqual(
        logger.texts().filter((text) => text.includes(KEY)),
        []
      );
    });

    // ── 5. once ───────────────────────────────────────────────────────────

    await test('once: 30 seconds chosen after the raise stay, also after a restart', async () => {
      reset();
      start({ overrides: { [KEY]: '30000' } });
      await runStartupMigrations(lineLogger());
      assert.strictEqual(readOverrides()[KEY], String(DEFAULT_OCR_TIMEOUT_MS));
      assert.ok(fs.existsSync(STARTUP_MIGRATION_STATE_PATH), 'marker written');

      // The user sets 30 seconds on the settings page, then restarts.
      start({ overrides: { [KEY]: '30000' } });
      const logger = lineLogger();
      const step = stepOf(await runStartupMigrations(logger));
      assert.strictEqual(step.status, 'skipped');
      assert.strictEqual(readOverrides()[KEY], '30000');
      assert.strictEqual(process.env[KEY], '30000');
      assert.deepStrictEqual(raisedLines(logger), []);

      start({ overrides: readOverrides() });
      assert.strictEqual(process.env[KEY], '30000', 'after another restart');
      assert.strictEqual(
        stepOf(await runStartupMigrations(lineLogger())).status,
        'skipped'
      );
    });

    // ── 6. the running process ────────────────────────────────────────────

    await test('the OCR service waits the raised value from the first request, without a restart', async () => {
      reset();
      start({ overrides: { [KEY]: '30000' } });
      // Loaded before the migration runs, as server.js loads it.
      const ocrService = silently(() =>
        require('../services/mistralOcrService')
      );
      assert.strictEqual(ocrService.ocrTimeoutMs, 30000);

      await runStartupMigrations(lineLogger());

      assert.strictEqual(ocrService.ocrTimeoutMs, DEFAULT_OCR_TIMEOUT_MS);
      assert.strictEqual(
        ocrTimeoutMsFromEnv(process.env),
        DEFAULT_OCR_TIMEOUT_MS
      );
    });

    // ── 7. both log files ─────────────────────────────────────────────────

    await test('the line reaches logs.html and logs.txt', async () => {
      reset();
      start({ overrides: { [KEY]: '30000' } });
      const Logger = require('../services/loggerService');
      const logDir = path.join(dataDir, 'logs');
      const real = { ...console };
      for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
        console[method] = () => {};
      }
      // As server.js creates them: each one takes over console.
      const htmlLogger = new Logger({
        logFile: 'logs.html',
        logDir,
        format: 'html',
        timestamp: true,
      });
      const txtLogger = new Logger({
        logFile: 'logs.txt',
        logDir,
        format: 'txt',
        timestamp: true,
      });
      try {
        await runStartupMigrations(console);
      } finally {
        txtLogger.restore();
        htmlLogger.restore();
        Object.assign(console, real);
      }
      const html = fs.readFileSync(path.join(logDir, 'logs.html'), 'utf8');
      const txt = fs.readFileSync(path.join(logDir, 'logs.txt'), 'utf8');
      assert.match(txt, /OCR timeout raised from 30 to 120 seconds/);
      assert.match(
        html.replace(/&nbsp;/g, ' '),
        /OCR timeout raised from 30 to 120 seconds/
      );
    });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = savedSnapshot;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[FAIL] OCR timeout migration test crashed:', error);
  process.exitCode = 1;
});
