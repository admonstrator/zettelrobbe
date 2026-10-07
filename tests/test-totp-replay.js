'use strict';

/**
 * Regression test for TOTP code replay (RFC 6238 section 5.2, CWE-294).
 *
 * The MFA step of POST /login accepted the same six-digit code any number of
 * times while it stayed inside the ±1 step window, so a code read off a
 * shoulder, a screen share or a phishing page could open a second session for
 * up to 90 seconds after the user's own sign-in. The verifier now remembers
 * the last accepted time step per user and refuses that step and older ones.
 *
 * Covered here:
 *   1. A code that signed in once is refused on a second sign-in.
 *   2. The code of the next time step is still accepted afterwards.
 *   3. A wrong code is refused without consuming anything.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const { mountRouter } = require('./helpers/mount-router');

const PASSWORD = 'correct-horse-battery';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

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

/** RFC 6238 code for SECRET at the given time step. */
function totpForStep(step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of SECRET) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(code % 1000000).padStart(6, '0');
}

function setCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

function cookieValue(response, name) {
  for (const cookie of setCookies(response)) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(cookie);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

(async () => {
  const harness = await mountRouter({});
  harness.app.engine('ejs', (filePath, _options, callback) =>
    callback(null, `view:${path.basename(filePath, '.ejs')}`)
  );
  await harness.documentModel.addUser('admin', await bcrypt.hash(PASSWORD, 4));
  await harness.documentModel.setUserMfaSettings('admin', true, SECRET);

  const post = (body, cookie) =>
    fetch(harness.base + '/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new URLSearchParams(body).toString(),
      redirect: 'manual',
    });

  // Password step, then the MFA step with the given code. Returns the
  // response of the MFA step.
  async function signIn(code) {
    const passwordStep = await post({ username: 'admin', password: PASSWORD });
    const challenge = cookieValue(passwordStep, 'mfa_challenge');
    assert.ok(challenge, 'the password step must hand out an MFA challenge');
    return post({ mfaStep: '1', mfaToken: code }, `mfa_challenge=${challenge}`);
  }

  // The current step and the next one: both stay inside the accepted ±1
  // window even if the clock crosses a step boundary while the test runs.
  const currentStep = Math.floor(Date.now() / 1000 / 30);
  const olderCode = totpForStep(currentStep);
  const newerCode = totpForStep(currentStep + 1);

  try {
    await test('a wrong code is refused', async () => {
      const wrong = olderCode === '000000' ? '000001' : '000000';
      const res = await signIn(wrong);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(cookieValue(res, 'jwt'), null);
    });

    await test('a valid code signs in once', async () => {
      const res = await signIn(olderCode);
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.get('location'), '/dashboard');
      assert.ok(cookieValue(res, 'jwt'), 'a session cookie must be set');
    });

    await test('the same code is refused on a second sign-in', async () => {
      const res = await signIn(olderCode);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(cookieValue(res, 'jwt'), null);
    });

    await test('the code of a newer time step is still accepted', async () => {
      const res = await signIn(newerCode);
      assert.strictEqual(res.status, 302);
      assert.ok(cookieValue(res, 'jwt'), 'a session cookie must be set');
    });
  } finally {
    await harness.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
