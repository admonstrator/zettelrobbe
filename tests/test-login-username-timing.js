'use strict';

/**
 * Regression test for username enumeration through POST /login response time
 * (CWE-208).
 *
 * A known username used to cost one bcrypt comparison, an unknown one none at
 * all, so the unknown name answered in a few milliseconds and the real one
 * after the full bcrypt work (cost 15 for an account the setup wizard
 * created). A single timed request told an attacker whether a username exists.
 *
 * The unknown-username branch now runs the same bcrypt comparison against a
 * dummy hash with the stored account's cost. Measuring wall-clock time in CI
 * would be flaky, so the test counts bcrypt comparisons and checks their cost
 * instead.
 */

const assert = require('assert');
const path = require('path');
const bcrypt = require('bcryptjs');
const { mountRouter } = require('./helpers/mount-router');

const PASSWORD = 'correct-horse-battery';
const ROUNDS = 5;

let passed = 0;
let failed = 0;

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

(async () => {
  const harness = await mountRouter({});
  // Only the comparisons matter, not the markup.
  harness.app.engine('ejs', (filePath, _options, callback) =>
    callback(null, `view:${path.basename(filePath, '.ejs')}`)
  );
  await harness.documentModel.addUser(
    'admin',
    await bcrypt.hash(PASSWORD, ROUNDS)
  );

  const compared = [];
  const originalCompare = bcrypt.compare;
  bcrypt.compare = async (plain, hash) => {
    compared.push(hash);
    return originalCompare(plain, hash);
  };

  const login = (username, password) =>
    fetch(harness.base + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }).toString(),
      redirect: 'manual',
    });

  try {
    await test('an unknown username still runs one bcrypt comparison', async () => {
      compared.length = 0;
      const res = await login('nosuchuser', 'wrong-password');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(compared.length, 1);
    });

    await test("the dummy hash uses the stored account's cost", async () => {
      assert.strictEqual(bcrypt.getRounds(compared[0]), ROUNDS);
    });

    await test('a missing password does not skip the comparison', async () => {
      compared.length = 0;
      const res = await fetch(harness.base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=nosuchuser',
        redirect: 'manual',
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(compared.length, 1);
    });

    await test('a known username with a wrong password runs one comparison', async () => {
      compared.length = 0;
      const res = await login('admin', 'wrong-password');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(compared.length, 1);
    });

    await test('the correct password still signs in', async () => {
      const res = await login('admin', PASSWORD);
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.get('location'), '/dashboard');
    });
  } finally {
    bcrypt.compare = originalCompare;
    await harness.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
