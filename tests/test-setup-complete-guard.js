'use strict';

/**
 * Regression test for the setup takeover, plus the TOKEN_LIMIT front door.
 *
 * Takeover: isInitialSetupOpen() used to reopen the wizard whenever the
 * configuration was incomplete - after "Reset local overrides", a lost data
 * volume, or any emptied required value. An unauthenticated
 * POST /api/setup/complete then replaced the existing MFA-protected
 * administrator (addUser() runs DELETE FROM users first) and repointed
 * PAPERLESS_API_URL. The wizard is now tied to the users table alone.
 *
 * Covered here:
 *   1. An empty instance can still complete setup (the guard does not block).
 *   2. With an administrator present, POST /api/setup/complete answers 403
 *      before it validates or writes anything, and the user row survives.
 *   3. With an administrator present and an incomplete configuration, an
 *      authenticated request goes to /settings instead of the closed wizard,
 *      and GET /setup never serves the wizard.
 *   4. POST /settings rejects a TOKEN_LIMIT that is not a positive integer -
 *      "128k" used to be stored verbatim and reached the AI services as NaN.
 *
 * Stubbed: setupService.saveConfig (so no configuration is written) and
 * process.exit (POST /settings schedules a restart five seconds after a
 * successful save).
 */

const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { mountRouter } = require('./helpers/mount-router');

const ADMIN_ERROR =
  'An administrator account already exists. Sign in and use /settings instead.';
const TOKEN_LIMIT_ERROR =
  'Invalid Token Limit. Expected a positive whole number.';

let passed = 0;
let failed = 0;

const realExit = process.exit.bind(process);
const exitCalls = [];
process.exit = (code) => {
  exitCalls.push(code);
};

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌  ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function finish() {
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit = realExit;
  realExit(failed > 0 ? 1 : 0);
}

(async () => {
  const savedConfigs = [];
  const harness = await mountRouter({
    configured: false,
    // The handler reads the current setting straight from the environment, and
    // saveConfig is stubbed out below, so pin it to something recognisable.
    env: { TOKEN_LIMIT: '99000' },
    stub: ({ setupService }) => {
      setupService.saveConfig = async (config) => {
        savedConfigs.push(config);
      };
    },
  });
  // The guards are what is under test, not the markup: the real templates need
  // res.locals that only server.js sets, so every view renders as its name.
  harness.app.engine('ejs', (filePath, _options, callback) =>
    callback(null, `view:${path.basename(filePath, '.ejs')}`)
  );

  const { documentModel, setupService } = harness;
  const completeSetup = () =>
    fetch(harness.base + '/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

  // ── 1. Empty instance: the wizard stays open ──────────────────────────────
  await test('an empty instance is not blocked by the administrator guard', async () => {
    assert.strictEqual(
      (await documentModel.getUsers()).length,
      0,
      'precondition: no users'
    );

    const res = await completeSetup();
    assert.notStrictEqual(res.status, 403, 'the guard must not fire yet');
    assert.strictEqual(
      res.status,
      400,
      'an empty body must fail input validation instead'
    );
    assert.strictEqual(
      (await documentModel.getUsers()).length,
      0,
      'a rejected request must not create a user'
    );
  });

  // ── 2. Administrator present: the wizard is closed for good ───────────────
  await documentModel.addUser('admin', await bcrypt.hash('setup-password', 4));
  const adminBefore = await documentModel.getUser('admin');

  await test('POST /api/setup/complete answers 403 once an administrator exists', async () => {
    const res = await completeSetup();
    assert.strictEqual(res.status, 403);

    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error, ADMIN_ERROR);
  });

  await test('the existing administrator row is untouched', async () => {
    const users = await documentModel.getUsers();
    assert.strictEqual(users.length, 1, 'the admin must not be deleted');

    const adminAfter = await documentModel.getUser('admin');
    assert.strictEqual(adminAfter.id, adminBefore.id);
    assert.strictEqual(adminAfter.username, adminBefore.username);
    assert.strictEqual(
      adminAfter.password,
      adminBefore.password,
      'the password hash must not be replaced'
    );
    assert.strictEqual(
      savedConfigs.length,
      0,
      'no configuration may be written by a refused setup'
    );
  });

  // ── 3. Incomplete configuration with an administrator ─────────────────────
  const sessionToken = jwt.sign(
    { id: adminBefore.id, username: 'admin', typ: 'session' },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  await test('an authenticated request with an incomplete configuration goes to /settings', async () => {
    assert.strictEqual(
      await setupService.isConfigured(),
      false,
      'precondition: configuration is incomplete'
    );

    const res = await fetch(harness.base + '/dashboard', {
      headers: { Cookie: `jwt=${sessionToken}` },
      redirect: 'manual',
    });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(
      res.headers.get('location'),
      '/settings',
      'the closed wizard must not be the destination'
    );
  });

  await test('GET /setup never serves the wizard once an administrator exists', async () => {
    const anonymous = await fetch(harness.base + '/setup', {
      redirect: 'manual',
    });
    assert.strictEqual(anonymous.status, 302);
    assert.strictEqual(anonymous.headers.get('location'), '/login');

    const signedIn = await fetch(harness.base + '/setup', {
      headers: { Cookie: `jwt=${sessionToken}` },
      redirect: 'manual',
    });
    assert.strictEqual(signedIn.status, 302);
    assert.strictEqual(signedIn.headers.get('location'), '/settings');
  });

  await test('GET /settings still renders in that state', async () => {
    const res = await fetch(harness.base + '/settings', {
      headers: { Cookie: `jwt=${sessionToken}` },
      redirect: 'manual',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'view:settings');
  });

  // ── 4. TOKEN_LIMIT validation in POST /settings ───────────────────────────
  const postSettings = (body) =>
    fetch(harness.base + '/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `jwt=${sessionToken}`,
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });

  for (const value of ['128k', 'abc', '-5', '0', '12.5', '1e5']) {
    await test(`POST /settings rejects TOKEN_LIMIT ${JSON.stringify(value)}`, async () => {
      const before = savedConfigs.length;
      const res = await postSettings({ tokenLimit: value });

      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(await res.json(), { error: TOKEN_LIMIT_ERROR });
      assert.strictEqual(
        savedConfigs.length,
        before,
        'a rejected value must store nothing'
      );
    });
  }

  await test('POST /settings stores a valid TOKEN_LIMIT', async () => {
    const res = await postSettings({ tokenLimit: ' 60000 ' });
    assert.strictEqual(res.status, 200);

    const stored = savedConfigs[savedConfigs.length - 1];
    assert.strictEqual(stored.TOKEN_LIMIT, '60000');
  });

  await test('POST /settings leaves an absent TOKEN_LIMIT alone', async () => {
    const res = await postSettings({ scanInterval: '*/15 * * * *' });
    assert.strictEqual(res.status, 200);

    const stored = savedConfigs[savedConfigs.length - 1];
    assert.strictEqual(stored.SCAN_INTERVAL, '*/15 * * * *');
    assert.strictEqual(
      String(stored.TOKEN_LIMIT),
      '99000',
      'the setting already in force must survive an unrelated save'
    );
  });

  await harness.close();
  finish();
})().catch((error) => {
  console.error('❌  Fatal error:', error);
  process.exit = realExit;
  realExit(1);
});
