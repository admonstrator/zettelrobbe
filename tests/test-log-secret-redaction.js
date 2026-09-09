/**
 * Test: credentials must never reach a log file
 *
 * Every console.* call in the process goes through Logger, which renders its
 * arguments with util.format. util.inspect of an axios error prints the whole
 * request configuration, `config.headers.Authorization` included — so a single
 * `console.log(error)` wrote the Paperless-ngx API token into data/logs/logs.txt
 * at the default log level, and provider keys at LOG_LEVEL=debug. Those are the
 * files users attach to bug reports.
 *
 * The same write path must also survive a broken sink: it used to let a full
 * disk turn console.log itself into an exception, so a logging problem crashed
 * whatever code happened to be logging.
 *
 * Covers:
 * 1. An Authorization header inside an inspected error object is redacted
 * 2. The current value of a secret environment variable is redacted wherever
 *    it appears
 * 3. `Bearer <token>` in free text is redacted, the scheme is kept
 * 4. Short or empty secret values are ignored (they would censor everything)
 * 5. Ordinary log lines are untouched
 * 6. A failing fs.appendFileSync does not propagate to the caller
 * 7. paperlessService renders an error bounded, without the object or its config
 * 8. "Token" as an ordinary word in prose is left alone
 * 9. "Token"/"Bearer" followed by a real credential is still redacted
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Logger = require('../services/loggerService');
const paperlessService = require('../services/paperlessService');

const PAPERLESS_TOKEN = 'pl-9f3c7a1d5e8b4c2a6d0f7e3b9a1c5d8e';
const OPENAI_KEY = 'sk-testonly-4f8a2c9e1b7d3a6f5e0c8b2d';
const SHORT_KEY = 'abc';

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

/**
 * Runs `emitLogs` with a Logger writing into a throwaway directory and returns
 * what ended up in the file. The console is restored before anything is
 * asserted, so the assertions themselves are not logged.
 *
 * @param {(logger: Logger) => void} emitLogs
 * @returns {string} the file contents
 */
function captureLog(emitLogs) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-log-redaction-'));
  const logFile = 'logs.txt';
  const logPath = path.join(tempDir, logFile);

  const logger = new Logger({
    logDir: tempDir,
    logFile,
    format: 'txt',
    timestamp: false,
    logLevel: 'debug',
  });

  try {
    emitLogs(logger);
  } finally {
    logger.restore();
  }

  const content = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8')
    : '';
  fs.rmSync(tempDir, { recursive: true, force: true });
  return content;
}

/** An axios error as the provider services actually hand it to console.*. */
function buildAxiosLikeError(message) {
  const error = new Error(message);
  error.name = 'AxiosError';
  error.code = 'ERR_BAD_REQUEST';
  error.config = {
    url: '/documents/42/',
    method: 'patch',
    headers: {
      Authorization: 'Token abc123secret',
      'Content-Type': 'application/json',
    },
  };
  error.response = {
    status: 403,
    data: { detail: 'Invalid token.' },
  };
  return error;
}

const previousEnv = {
  PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  API_KEY: process.env.API_KEY,
};

process.env.PAPERLESS_API_TOKEN = PAPERLESS_TOKEN;
process.env.OPENAI_API_KEY = OPENAI_KEY;
process.env.API_KEY = SHORT_KEY;

try {
  test('Authorization header of an inspected axios error is redacted', () => {
    const content = captureLog(() => {
      console.log(buildAxiosLikeError('Request failed with status code 403'));
    });

    assert.ok(
      !content.includes('abc123secret'),
      'the Authorization header value must not reach the log file'
    );
    assert.ok(
      content.includes('[redacted]'),
      'the redaction placeholder should mark what was removed'
    );
    assert.ok(
      content.includes('403'),
      'the diagnostically useful parts must survive'
    );
  });

  test('Secret environment values are redacted wherever they appear', () => {
    const content = captureLog(() => {
      console.error(
        `[ERROR] paperless said no for ${PAPERLESS_TOKEN} using ${OPENAI_KEY}`
      );
      console.debug(`GET https://paperless.test/api/?token=${PAPERLESS_TOKEN}`);
    });

    assert.ok(
      !content.includes(PAPERLESS_TOKEN),
      'PAPERLESS_API_TOKEN must not reach the log file'
    );
    assert.ok(
      !content.includes(OPENAI_KEY),
      'OPENAI_API_KEY must not reach the log file'
    );
  });

  test('Bearer and Token schemes are kept, their credentials are not', () => {
    const content = captureLog(() => {
      console.log('sent header Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      console.log("headers: { 'x-api-key': 'live-key-value-1234567890' }");
    });

    assert.ok(
      !content.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'),
      'a bearer credential must not reach the log file'
    );
    assert.ok(
      content.toLowerCase().includes('bearer'),
      'the scheme itself is useful and should stay'
    );
    assert.ok(
      !content.includes('live-key-value-1234567890'),
      'an x-api-key value must not reach the log file'
    );
  });

  test('Very short secret values are ignored', () => {
    const content = captureLog(() => {
      console.log('the alphabet starts with abc and continues');
    });

    assert.ok(
      content.includes('the alphabet starts with abc and continues'),
      `a ${SHORT_KEY.length}-character API_KEY must not censor ordinary text`
    );
  });

  test('Ordinary log lines are untouched', () => {
    const content = captureLog(() => {
      console.log('[DEBUG] Fetched page 3, got 100 documents.');
    });

    assert.ok(
      content.includes('[DEBUG] Fetched page 3, got 100 documents.'),
      'a line without secrets must be written verbatim'
    );
    assert.ok(
      !content.includes('[redacted]'),
      'a line without secrets must not be redacted'
    );
  });

  test('A failing log write does not propagate to the caller', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-log-broken-'));
    const realAppendFileSync = fs.appendFileSync;
    const logger = new Logger({
      logDir: tempDir,
      logFile: 'logs.txt',
      format: 'txt',
      timestamp: false,
      logLevel: 'debug',
    });

    const reports = [];
    logger.originalConsole.error = (...args) => reports.push(args.join(' '));

    try {
      fs.appendFileSync = () => {
        const error = new Error('ENOSPC: no space left on device');
        error.code = 'ENOSPC';
        throw error;
      };

      assert.doesNotThrow(() => {
        console.log('first line after the disk filled up');
        console.log('second line after the disk filled up');
      }, 'console.log must not throw when the log file cannot be written');
    } finally {
      fs.appendFileSync = realAppendFileSync;
      logger.restore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    assert.strictEqual(
      reports.length,
      1,
      'the broken sink should be reported exactly once, not per line'
    );
    assert.ok(
      reports[0].includes('not writable'),
      'the report should say what is wrong'
    );
  });

  test('Token as an ordinary word in prose is left alone', () => {
    // Both lines are logged verbatim by the provider services on every run;
    // redacting them would hide the numbers they exist for.
    const content = captureLog(() => {
      console.log('[DEBUG] Token calculation - Prompt: 192, Reserved: 1192');
      console.warn('[WARNING] Token truncation failed for model gpt-4o');
    });

    assert.ok(
      content.includes('Token calculation - Prompt: 192, Reserved: 1192'),
      'a token-count line must survive intact'
    );
    assert.ok(
      content.includes('Token truncation failed for model gpt-4o'),
      'a token-truncation warning must survive intact'
    );
    assert.ok(
      !content.includes('[redacted]'),
      'neither prose line may be redacted'
    );
  });

  test('Token and Bearer followed by a real credential are redacted', () => {
    const content = captureLog(() => {
      console.log('Token 3f9c0a1b2d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a');
      console.log('Bearer eyJhbGciOi.abc.def');
    });

    assert.ok(
      !content.includes('3f9c0a1b2d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a'),
      'a hex credential behind Token must not reach the log file'
    );
    assert.ok(
      !content.includes('eyJhbGciOi.abc.def'),
      'a credential behind Bearer must not reach the log file, digits or not'
    );
    assert.ok(
      content.includes('Token [redacted]') &&
        content.includes('Bearer [redacted]'),
      'both schemes should stay readable with the credential blanked'
    );
  });

  test('paperlessService renders an error without its config or object', () => {
    const rendered = paperlessService.describeHttpError(
      buildAxiosLikeError('Request failed with status code 403')
    );

    assert.ok(
      !rendered.includes('abc123secret'),
      'the Authorization header must not be part of the rendered error'
    );
    assert.ok(
      !rendered.includes('headers'),
      'error.config must not be rendered at all'
    );
    assert.ok(
      rendered.includes('status=403'),
      'the HTTP status is the useful part and must survive'
    );
    assert.ok(
      rendered.includes('code=ERR_BAD_REQUEST'),
      'the transport code is the useful part and must survive'
    );
    assert.ok(
      rendered.includes('Invalid token.'),
      'the response body explains the failure and must survive'
    );
  });

  test('paperlessService bounds a huge response body', () => {
    const error = new Error('Request failed with status code 500');
    error.response = { status: 500, data: 'x'.repeat(5000) };

    const rendered = paperlessService.describeHttpError(error);

    assert.ok(
      rendered.length < 1000,
      `a 5000-character body must be truncated, got ${rendered.length} characters`
    );
    assert.ok(
      rendered.includes('[truncated]'),
      'the truncation must be visible in the log line'
    );
  });
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
