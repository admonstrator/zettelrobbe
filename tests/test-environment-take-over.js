'use strict';

/**
 * Test: Take over and Remove the stored copy, end to end
 *
 * POST /api/settings/environment/take-over stores the value in effect of a
 * setting the environment sets in Zettelrobbe's own stored settings, so that
 * its line can be deleted from docker-compose; /remove-copy undoes it. Both
 * run against the real routes and a throwaway data directory, once per config
 * mode, each mode in a process of its own: config/config.js takes its snapshot
 * of the environment when it first loads, the way a container start does.
 *
 * In each mode:
 *   1. Take over stores the value normalised as a save of the field would
 *      (a list as "a,b"), in runtime-overrides.json and, in legacy mode, in
 *      data/.env; the value in effect (process.env) stays as it was
 *   2. a secret is stored and never in a response
 *   3. a restart key is stored without a restart and without an exit
 *   4. a key that is no catalogue setting, or one the environment does not
 *      set, refuses the request and writes nothing; a value the field would
 *      refuse, or the old OCR timeout of 30000, is not stored and the answer
 *      says why
 *   5. the page shows the row as stored; an anonymous call is refused
 *   6. a settings save keeps the stored copies
 *   7. Remove the stored copy removes only a copy of the value in effect
 *   8. the next start: with the line still there the environment wins, and
 *      without it the stored value is the one in effect
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MARKER = 'TAKE-OVER-RESULT ';
const SECRET = 'sk-environment-secret-4711';

/** What the environment sets in every case. */
const ENVIRONMENT = {
  SCAN_INTERVAL: '*/5 * * * *',
  TAGS: 'inbox, todo',
  OPENAI_API_KEY: SECRET,
  PAPERLESS_AI_PORT: '3123',
  DUPLICATES_AI_REVIEW_BATCH_SIZE: '500',
  ACTIVATE_TAGGING: 'no',
  // The old form default: never taken over, the line is to be deleted.
  SETUP_OCR_VALIDATION_TIMEOUT_MS: '30000',
};

/** What was stored before the lines went into docker-compose. */
const STORED = { SCAN_INTERVAL: '0 * * * *', TRUST_PROXY: 'loopback' };

const MODES = {
  'runtime-first': {
    dataFiles: () => ({
      'runtime-overrides.json': JSON.stringify(STORED, null, 2),
    }),
  },
  legacy: {
    dataFiles: () => ({
      '.env': Object.entries(STORED)
        .map(([key, value]) => `${key}="${value}"`)
        .join('\n'),
    }),
  },
};

async function runMode(mode) {
  const results = [];
  const check = async (label, fn) => {
    try {
      await fn();
      results.push({ label: `${mode}: ${label}`, ok: true });
    } catch (error) {
      results.push({
        label: `${mode}: ${label}`,
        ok: false,
        error: error.stack || error.message,
      });
    }
  };
  const report = () =>
    process.stdout.write(`${MARKER}${JSON.stringify(results)}\n`);
  for (const level of ['log', 'info', 'warn', 'debug'])
    console[level] = () => {};

  const { mountRouter } = require('./helpers/mount-router');
  const harness = await mountRouter({
    env: { CONFIG_SOURCE_MODE: mode, ...ENVIRONMENT },
    dataFiles: MODES[mode].dataFiles(),
    user: { username: 'admin' },
    stub: ({ paperlessService }) => {
      paperlessService.findCustomFieldTypeConflicts = async () => [];
    },
  });

  const restarts = [];
  require('../services/restartService').requestRestart = () => {
    restarts.push(Date.now());
    return /** @type {any} */ (null);
  };
  const exits = [];
  const realExit = process.exit;
  process.exit = (code) => {
    exits.push(code);
  };

  const dataDir = path.join(harness.tmpDir, 'data');
  const overridesPath = path.join(dataDir, 'runtime-overrides.json');
  const envPath = path.join(dataDir, '.env');
  const readOverrides = () =>
    fs.existsSync(overridesPath)
      ? JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
      : {};
  const readEnvFile = () => {
    if (!fs.existsSync(envPath)) return {};
    return require('dotenv').parse(fs.readFileSync(envPath, 'utf8'));
  };
  /** What both stores hold for a key (data/.env only in legacy mode). */
  const storedEverywhere = (key) => {
    const values = [readOverrides()[key]];
    if (mode === 'legacy') values.push(readEnvFile()[key]);
    return values;
  };

  const request = async (method, url, body, headers = {}) => {
    const response = await fetch(harness.base + url, {
      method,
      headers: harness.authHeaders({
        'Content-Type': 'application/json',
        ...headers,
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    /** @returns {any} */
    const parse = () => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };
    return { status: response.status, text, json: parse() };
  };
  const takeOver = (keys) =>
    request('POST', '/api/settings/environment/take-over', { keys });
  const removeCopy = (keys) =>
    request('POST', '/api/settings/environment/remove-copy', { keys });

  try {
    await check(
      'the page lists the settings and the differing stored copy',
      async () => {
        const page = await request('GET', '/settings');
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('data-env-row="SCAN_INTERVAL"'));
        assert.match(
          page.text,
          /data-env-row="SCAN_INTERVAL" data-anchor="scanInterval" data-stored="different"/
        );
        assert.ok(!page.text.includes(SECRET), 'the secret');
      }
    );

    const before = { ...process.env };
    const first = await takeOver([
      'SCAN_INTERVAL',
      'TAGS',
      'OPENAI_API_KEY',
      'PAPERLESS_AI_PORT',
      'ACTIVATE_TAGGING',
    ]);
    await check('Take over stores the normalised values', () => {
      assert.strictEqual(first.status, 200, first.text);
      assert.strictEqual(first.json.success, true);
      assert.deepStrictEqual(first.json.data.stored, [
        'SCAN_INTERVAL',
        'TAGS',
        'OPENAI_API_KEY',
        'PAPERLESS_AI_PORT',
        'ACTIVATE_TAGGING',
      ]);
      assert.deepStrictEqual(first.json.data.refused, []);
      assert.match(first.json.message, /stored 5 settings/);
      assert.deepStrictEqual(
        storedEverywhere('SCAN_INTERVAL'),
        mode === 'legacy' ? ['*/5 * * * *', '*/5 * * * *'] : ['*/5 * * * *']
      );
      assert.ok(
        storedEverywhere('TAGS').every((value) => value === 'inbox,todo')
      );
      assert.ok(
        storedEverywhere('PAPERLESS_AI_PORT').every((value) => value === '3123')
      );
      assert.ok(
        storedEverywhere('ACTIVATE_TAGGING').every((value) => value === 'no'),
        'a switch as written'
      );
      const primary = mode === 'legacy' ? readEnvFile() : readOverrides();
      assert.strictEqual(primary.TRUST_PROXY, 'loopback', 'the rest stays');
    });
    await check('the values in effect do not change', () => {
      Object.keys(ENVIRONMENT).forEach((key) =>
        assert.strictEqual(process.env[key], before[key], key)
      );
      assert.strictEqual(
        process.env.TAGS,
        'inbox, todo',
        'not the stored spelling'
      );
    });
    await check('a secret is stored and never answered', () => {
      assert.ok(
        storedEverywhere('OPENAI_API_KEY').every((value) => value === SECRET)
      );
      assert.ok(!first.text.includes(SECRET));
    });
    await check('a restart key is stored without a restart or an exit', () => {
      assert.deepStrictEqual(restarts, []);
      assert.deepStrictEqual(exits, []);
    });

    const snapshot = JSON.stringify([readOverrides(), readEnvFile()]);
    await check(
      'a key that is no setting, or one the environment does not set, refuses the request',
      async () => {
        for (const keys of [
          ['NOT_A_SETTING'],
          ['TOKEN_LIMIT'],
          ['PATH'],
          ['SCAN_INTERVAL', 'TOKEN_LIMIT'],
        ]) {
          const refused = await takeOver(keys);
          assert.strictEqual(refused.status, 400, refused.text);
          assert.strictEqual(refused.json.success, false);
          assert.match(
            refused.json.error,
            /Not a setting the environment sets/
          );
        }
        for (const body of [{}, { keys: [] }, { keys: 'everything' }]) {
          const bad = await request(
            'POST',
            '/api/settings/environment/take-over',
            body
          );
          assert.strictEqual(bad.status, 400, bad.text);
        }
        const removeBad = await removeCopy(['TOKEN_LIMIT']);
        assert.strictEqual(removeBad.status, 400, removeBad.text);
        assert.strictEqual(
          JSON.stringify([readOverrides(), readEnvFile()]),
          snapshot,
          'nothing written'
        );
      }
    );
    await check(
      'a value the field would refuse is not stored, and the answer says why',
      async () => {
        const refused = await takeOver(['DUPLICATES_AI_REVIEW_BATCH_SIZE']);
        assert.strictEqual(refused.status, 422, refused.text);
        assert.strictEqual(refused.json.success, false);
        assert.match(refused.json.error, /turns 500 into 100/);
        assert.deepStrictEqual(refused.json.data.stored, []);
        assert.ok(!('DUPLICATES_AI_REVIEW_BATCH_SIZE' in readOverrides()));
        const timeout = await takeOver(['SETUP_OCR_VALIDATION_TIMEOUT_MS']);
        assert.strictEqual(timeout.status, 422, timeout.text);
        assert.match(timeout.json.error, /old default/);
        assert.ok(
          storedEverywhere('SETUP_OCR_VALIDATION_TIMEOUT_MS').every(
            (value) => value === undefined
          ),
          'the old OCR timeout'
        );
      }
    );
    await check(
      'Take over all stores what is left and skips what it cannot store',
      async () => {
        const all = await takeOver('all');
        assert.strictEqual(all.status, 200, all.text);
        const stored = all.json.data.stored;
        // The harness starts with a few settings of its own in the environment.
        assert.ok(stored.includes('PAPERLESS_API_URL'), stored.join(','));
        assert.ok(!stored.includes('SCAN_INTERVAL'), 'already stored');
        assert.ok(
          !stored.includes('DUPLICATES_AI_REVIEW_BATCH_SIZE'),
          'refused by its field'
        );
        assert.ok(
          !stored.includes('SETUP_OCR_VALIDATION_TIMEOUT_MS'),
          'the old OCR timeout'
        );
        assert.ok(!('SETUP_OCR_VALIDATION_TIMEOUT_MS' in readOverrides()));
        assert.deepStrictEqual(all.json.data.refused, []);
        const again = await takeOver('all');
        assert.strictEqual(again.status, 200, again.text);
        assert.deepStrictEqual(again.json.data.stored, []);
        assert.match(again.json.message, /Nothing to take over/);
        assert.deepStrictEqual(restarts, []);
        assert.deepStrictEqual(exits, []);
      }
    );
    await check('an anonymous call is refused', async () => {
      const anonymous = await fetch(
        `${harness.base}/api/settings/environment/take-over`,
        {
          method: 'POST',
          headers: harness.anonymousHeaders({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ keys: ['SCAN_INTERVAL'] }),
          redirect: 'manual',
        }
      );
      assert.strictEqual(anonymous.status, 302);
      assert.strictEqual(anonymous.headers.get('location'), '/login');
    });
    await check('the page shows the rows as stored', async () => {
      const page = await request('GET', '/settings');
      assert.match(
        page.text,
        /data-env-row="SCAN_INTERVAL" data-anchor="scanInterval" data-stored="same"/
      );
      assert.match(
        page.text,
        /data-env-row="TAGS" data-anchor="tags" data-stored="same"/
      );
      assert.match(
        page.text,
        /data-env-row="OPENAI_API_KEY" data-anchor="openaiKey" data-stored="same"/
      );
      assert.ok(!page.text.includes(SECRET));
    });

    const saved = await request('POST', '/settings', {
      aiTemperatureAnalysis: '0.4',
    });
    await check('a settings save keeps the stored copies', () => {
      assert.strictEqual(saved.status, 200, saved.text);
      assert.deepStrictEqual(saved.json.restartKeys, []);
      assert.strictEqual(readOverrides().AI_TEMPERATURE_ANALYSIS, '0.4');
      for (const [key, value] of [
        ['SCAN_INTERVAL', '*/5 * * * *'],
        ['TAGS', 'inbox,todo'],
        ['OPENAI_API_KEY', SECRET],
        ['PAPERLESS_AI_PORT', '3123'],
      ]) {
        assert.ok(
          storedEverywhere(key).every((stored) => stored === value),
          key
        );
      }
      assert.strictEqual(process.env.SCAN_INTERVAL, '*/5 * * * *');
    });

    await check(
      'Remove the stored copy removes a copy of the value in effect, nothing else',
      async () => {
        const removed = await removeCopy(['TAGS']);
        assert.strictEqual(removed.status, 200, removed.text);
        assert.deepStrictEqual(removed.json.data.removed, ['TAGS']);
        assert.ok(
          storedEverywhere('TAGS').every((value) => value === undefined)
        );
        assert.ok(
          storedEverywhere('SCAN_INTERVAL').every(
            (value) => value === '*/5 * * * *'
          )
        );
        assert.strictEqual(process.env.TAGS, 'inbox, todo');
        const again = await removeCopy(['TAGS']);
        assert.strictEqual(again.status, 422, again.text);
        assert.match(again.json.error, /Nothing is stored/);
        assert.deepStrictEqual(restarts, []);
      }
    );

    await check(
      'the next start: the environment wins while its line is there, the stored value without it',
      () => {
        const start = (environment) => {
          const child = spawnSync(
            process.execPath,
            [
              '-e',
              `require(${JSON.stringify(require.resolve('../config/config'))});` +
                'process.stdout.write(JSON.stringify(["SCAN_INTERVAL","OPENAI_API_KEY","PAPERLESS_AI_PORT","TRUST_PROXY"].map((k) => process.env[k] ?? null)));',
            ],
            {
              cwd: harness.tmpDir,
              env: {
                PATH: process.env.PATH || '',
                LOG_LEVEL: 'error',
                CONFIG_SOURCE_MODE: mode,
                ...environment,
              },
              encoding: 'utf8',
            }
          );
          assert.strictEqual(child.status, 0, child.stderr);
          return JSON.parse(child.stdout.trim().split('\n').pop());
        };
        assert.deepStrictEqual(
          start({
            SCAN_INTERVAL: '*/10 * * * *',
            OPENAI_API_KEY: 'sk-new',
            PAPERLESS_AI_PORT: '4000',
          }),
          ['*/10 * * * *', 'sk-new', '4000', 'loopback']
        );
        assert.deepStrictEqual(start({}), [
          '*/5 * * * *',
          SECRET,
          '3123',
          'loopback',
        ]);
      }
    );
  } finally {
    process.exit = realExit;
    await harness.close();
  }
  report();
}

function main() {
  let passed = 0;
  let failed = 0;
  for (const mode of Object.keys(MODES)) {
    console.log(`\nCONFIG_SOURCE_MODE=${mode}`);
    const child = spawnSync(process.execPath, [__filename, '--mode', mode], {
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        TMPDIR: process.env.TMPDIR || '',
      },
      encoding: 'utf8',
      timeout: 120000,
    });
    const line = (child.stdout || '')
      .split('\n')
      .find((entry) => entry.startsWith(MARKER));
    if (!line) {
      failed += 1;
      console.error(`❌  ${mode}: no result (exit ${child.status})`);
      console.error((child.stderr || child.stdout || '').slice(-3000));
      continue;
    }
    JSON.parse(line.slice(MARKER.length)).forEach((result) => {
      if (result.ok) {
        passed += 1;
        console.log(`✅  ${result.label}`);
      } else {
        failed += 1;
        console.error(`❌  ${result.label}`);
        console.error(`    ${result.error}`);
      }
    });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const modeIndex = process.argv.indexOf('--mode');
if (modeIndex > 0) {
  runMode(process.argv[modeIndex + 1]).then(
    () => process.exit(0),
    (error) => {
      process.stdout.write(
        `${MARKER}${JSON.stringify([{ label: 'the mode ran', ok: false, error: error.stack }])}\n`
      );
      process.exit(1);
    }
  );
} else {
  main();
}
