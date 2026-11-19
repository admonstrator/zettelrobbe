'use strict';

/**
 * Test: a removed setting does not disturb an installation that still has it
 *
 * A setting leaves the settings catalogue, the page and the code that read
 * it, but its key stays wherever an operator or an older version put it:
 *
 *   - in docker-compose `environment:` (the container starts with it)
 *   - in data/runtime-overrides.json (every settings save wrote it)
 *   - in a legacy data/.env, which runtime-first mode migrates into the
 *     overrides once, and which CONFIG_SOURCE_MODE=legacy keeps reading
 *
 * Nothing reads the key any more, and the config layer has no list of known
 * keys, so it neither warns about one nor refuses to start. A settings save
 * writes the catalogue's keys (plus JWT_SECRET and OIDC_*), so the next save
 * drops a stored value from runtime-overrides.json and, in legacy mode, from
 * data/.env. A key the container injects is never written anywhere. The
 * renamed data/.env.migrated is a backup nobody reads and keeps it.
 *
 * Every case runs in a process of its own, the way a container start does:
 * config/config.js reads the files and takes its snapshot of the environment
 * when it first loads. In each case:
 *
 *   1. the app starts: the config loads and the routes mount
 *   2. GET /settings renders, without the field and without the key
 *   3. POST /settings with a body that still carries the field (an old page,
 *      an API user) answers 200, saves, and ignores the field
 *   4. the save leaves the key out of what it writes
 *   5. the .env export does not print the key
 *   6. nothing logs the key: not at start, not on any request, not in two
 *      rounds of requests
 *   7. the process after the save (the restart) starts, and only the
 *      container's own copy of the key is left in its environment
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** The removed settings: env key, the form field that carried it, a value. */
const REMOVED = [
  {
    key: 'AI_TEMPERATURE_GENERATION',
    field: 'aiTemperatureGeneration',
    value: '1.3',
  },
];

const CASES = {
  compose: {
    title: 'the key in docker-compose environment:',
    env: {},
    injected: true,
  },
  overrides: {
    title: 'the key in data/runtime-overrides.json',
    env: {},
    dataFiles: () => ({
      'runtime-overrides.json': JSON.stringify(
        Object.fromEntries(REMOVED.map(({ key, value }) => [key, value])),
        null,
        2
      ),
    }),
  },
  'legacy-env-migrated': {
    title: 'the key in a legacy data/.env, runtime-first mode',
    env: {},
    dataFiles: () => ({
      '.env': REMOVED.map(({ key, value }) => `${key}="${value}"`).join('\n'),
    }),
  },
  'legacy-env-legacy-mode': {
    title: 'the key in a legacy data/.env, CONFIG_SOURCE_MODE=legacy',
    env: { CONFIG_SOURCE_MODE: 'legacy' },
    dataFiles: () => ({
      '.env': REMOVED.map(({ key, value }) => `${key}="${value}"`).join('\n'),
    }),
  },
};

const MARKER = 'REMOVED-SETTINGS-RESULT ';

/* ── One case, in a process of its own ───────────────────────────────── */

async function runCase(name) {
  const spec = CASES[name];
  const results = [];
  const logs = [];
  const check = async (label, fn) => {
    try {
      await fn();
      results.push({ label, ok: true });
    } catch (error) {
      results.push({ label, ok: false, error: error.message });
    }
  };

  // Everything the process logs from here on, startup included.
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    console[level] = (...args) => logs.push(args.map(String).join(' '));
  }
  const report = () =>
    process.stdout.write(`${MARKER}${JSON.stringify({ results, logs })}\n`);

  const injected = spec.injected
    ? Object.fromEntries(REMOVED.map(({ key, value }) => [key, value]))
    : {};

  let harness;
  await check('the app starts', async () => {
    const { mountRouter } = require('./helpers/mount-router');
    harness = await mountRouter({
      env: { LOG_LEVEL: 'debug', ...spec.env, ...injected },
      dataFiles: spec.dataFiles ? spec.dataFiles() : {},
      user: { username: 'admin' },
      stub: ({ paperlessService }) => {
        paperlessService.findCustomFieldTypeConflicts = async () => [];
      },
    });
  });
  if (!harness) {
    report();
    return;
  }

  const restarts = [];
  require('../services/restartService').requestRestart = () => {
    restarts.push(Date.now());
    return /** @type {any} */ (null);
  };

  const dataDir = path.join(harness.tmpDir, 'data');
  const overridesPath = path.join(dataDir, 'runtime-overrides.json');
  const readOverrides = () =>
    fs.existsSync(overridesPath)
      ? JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
      : {};

  const fetchJson = async (url, init = {}) => {
    const response = await fetch(harness.base + url, {
      ...init,
      headers: harness.authHeaders(init.headers || {}),
    });
    const text = await response.text();
    return { status: response.status, text };
  };

  const requests = async () => {
    const page = await fetchJson('/settings');
    const exported = await fetchJson('/api/settings/env-file');
    return { page, exported };
  };

  try {
    await check('the key is in the environment the app runs with', () => {
      REMOVED.forEach(({ key, value }) =>
        assert.strictEqual(process.env[key], value, key)
      );
      if (name === 'overrides' || name === 'legacy-env-migrated') {
        const stored = readOverrides();
        REMOVED.forEach(({ key, value }) =>
          assert.strictEqual(stored[key], value, `${key} in the overrides`)
        );
      }
    });

    const first = await requests();
    await check('GET /settings renders without the field', () => {
      assert.strictEqual(first.page.status, 200, first.page.text.slice(0, 200));
      assert.ok(first.page.text.includes('id="setupForm"'), 'the form');
      REMOVED.forEach(({ key, field }) => {
        assert.ok(!first.page.text.includes(key), `the page names ${key}`);
        assert.ok(!first.page.text.includes(`"${field}"`), `field ${field}`);
      });
    });
    await check('the .env export does not print the key', () => {
      assert.strictEqual(first.exported.status, 200);
      const { data } = JSON.parse(first.exported.text);
      assert.ok(data.env.includes('# AI provider'), 'the export has content');
      REMOVED.forEach(({ key }) =>
        assert.ok(!data.env.includes(key), `${key} is exported`)
      );
    });

    const body = {
      aiTemperatureAnalysis: '0.4',
      ...Object.fromEntries(REMOVED.map(({ field, value }) => [field, value])),
    };
    const saved = await fetchJson('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await check(
      'POST /settings with the old field saves and ignores it',
      () => {
        assert.strictEqual(saved.status, 200, saved.text);
        const json = JSON.parse(saved.text);
        assert.strictEqual(json.success, true);
        assert.deepStrictEqual(json.restartKeys, []);
        assert.strictEqual(restarts.length, 0);
        assert.strictEqual(readOverrides().AI_TEMPERATURE_ANALYSIS, '0.4');
      }
    );
    await check('the save leaves the key out of what it writes', () => {
      const stored = readOverrides();
      REMOVED.forEach(({ key }) =>
        assert.ok(!(key in stored), `${key} in runtime-overrides.json`)
      );
      if (spec.env.CONFIG_SOURCE_MODE === 'legacy') {
        const envFile = fs.readFileSync(path.join(dataDir, '.env'), 'utf8');
        assert.ok(envFile.includes('AI_TEMPERATURE_ANALYSIS="0.4"'));
        REMOVED.forEach(({ key }) =>
          assert.ok(!envFile.includes(key), `${key} in data/.env`)
        );
      }
      if (name === 'legacy-env-migrated') {
        // The migration's backup is never read again; it keeps what it had.
        assert.ok(!fs.existsSync(path.join(dataDir, '.env')));
        assert.ok(fs.existsSync(path.join(dataDir, '.env.migrated')));
      }
    });

    const second = await requests();
    await check('a second round renders and exports the same way', () => {
      assert.strictEqual(second.page.status, 200);
      assert.strictEqual(second.exported.status, 200);
      REMOVED.forEach(({ key }) => {
        assert.ok(!second.page.text.includes(key));
        assert.ok(!second.exported.text.includes(key));
      });
    });

    await check('the restart starts without the stored key', () => {
      const keys = JSON.stringify(REMOVED.map(({ key }) => key));
      const restart = spawnSync(
        process.execPath,
        [
          '-e',
          `require(${JSON.stringify(require.resolve('../config/config'))});` +
            `process.stdout.write(JSON.stringify(${keys}.map((k) => process.env[k] ?? null)));`,
        ],
        {
          cwd: harness.tmpDir,
          env: {
            PATH: process.env.PATH || '',
            LOG_LEVEL: 'debug',
            ...spec.env,
            ...injected,
          },
          encoding: 'utf8',
        }
      );
      assert.strictEqual(restart.status, 0, restart.stderr);
      REMOVED.forEach(({ key }) => {
        assert.ok(!restart.stderr.includes(key), restart.stderr);
      });
      const values = JSON.parse(restart.stdout.trim().split('\n').pop());
      // The container's copy stays in its own environment; nothing reads it.
      const expected = REMOVED.map(({ value }) =>
        spec.injected ? value : null
      );
      assert.deepStrictEqual(values, expected);
    });
  } finally {
    await harness.close();
  }

  await check('nothing logged the key', () => {
    // The capture works: GET /settings logs this line on every request.
    assert.ok(
      logs.filter((line) => line.startsWith('Current config TAGS')).length >= 2,
      'the requests were not logged'
    );
    const named = logs.filter((line) =>
      REMOVED.some(
        ({ key, field }) => line.includes(key) || line.includes(field)
      )
    );
    assert.deepStrictEqual(named, []);
  });
  report();
}

/* ── The parent: one process per case ───────────────────────────────── */

function main() {
  let passed = 0;
  let failed = 0;
  for (const name of Object.keys(CASES)) {
    console.log(`\n${CASES[name].title}`);
    const child = spawnSync(process.execPath, [__filename, '--case', name], {
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
      console.error(`❌  ${name}: no result (exit ${child.status})`);
      console.error((child.stderr || child.stdout || '').slice(-2000));
      continue;
    }
    const { results } = JSON.parse(line.slice(MARKER.length));
    results.forEach((result) => {
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

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const caseIndex = process.argv.indexOf('--case');
if (caseIndex > 0) {
  runCase(process.argv[caseIndex + 1]).then(
    () => process.exit(0),
    (error) => {
      process.stdout.write(
        `${MARKER}${JSON.stringify({
          results: [{ label: 'the case ran', ok: false, error: error.stack }],
          logs: [],
        })}\n`
      );
      process.exit(1);
    }
  );
} else {
  main();
}
