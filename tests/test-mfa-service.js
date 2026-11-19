'use strict';

/**
 * services/mfaService.js holds the TOTP helpers and the in-memory MFA state
 * that sign-in, the settings page and the setup wizard share.
 *
 *   1. setup-wizard challenges expire after SETUP_MFA_CHALLENGE_TTL_MS
 *   2. a consumed code is refused a second time for the same user (replay),
 *      while a plain verification does not consume it
 *   3. the module is a single instance: every require sees the same Maps
 */

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
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

async function main() {
  // mfaService loads models/document.js, which opens data/documents.db in
  // the current directory.
  const previousCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-mfa-service-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  process.chdir(tmpDir);

  try {
    const mfa = require('../services/mfaService');
    const {
      SETUP_MFA_CHALLENGE_TTL_MS,
      setupMfaChallenges,
      cleanupExpiredSetupMfaChallenges,
    } = mfa;

    await test('setup challenges older than the TTL are dropped', () => {
      const now = 1_700_000_000_000;
      setupMfaChallenges.clear();
      const base = { username: 'admin', secret: 'X', verified: false };
      setupMfaChallenges.set('expired', {
        ...base,
        createdAt: now - SETUP_MFA_CHALLENGE_TTL_MS - 1,
      });
      setupMfaChallenges.set('at-limit', {
        ...base,
        createdAt: now - SETUP_MFA_CHALLENGE_TTL_MS,
      });
      setupMfaChallenges.set('fresh', { ...base, createdAt: now - 1000 });

      cleanupExpiredSetupMfaChallenges(now);

      assert.deepStrictEqual(
        [...setupMfaChallenges.keys()].sort(),
        ['at-limit', 'fresh'],
        'only the challenge past the TTL is removed'
      );
      setupMfaChallenges.clear();
    });

    await test('the TTL is ten minutes', () => {
      assert.strictEqual(SETUP_MFA_CHALLENGE_TTL_MS, 10 * 60 * 1000);
    });

    await test('without a clock argument the current time is used', () => {
      setupMfaChallenges.clear();
      setupMfaChallenges.set('old', {
        username: 'admin',
        secret: 'X',
        verified: true,
        createdAt: Date.now() - SETUP_MFA_CHALLENGE_TTL_MS - 5000,
      });
      setupMfaChallenges.set('new', {
        username: 'admin',
        secret: 'X',
        verified: true,
        createdAt: Date.now(),
      });
      cleanupExpiredSetupMfaChallenges();
      assert.deepStrictEqual([...setupMfaChallenges.keys()], ['new']);
      setupMfaChallenges.clear();
    });

    await test('a consumed code cannot be used again by the same user', () => {
      const secret = mfa.generateBase32Secret();
      const code = mfa.generateTotpToken(secret, Math.floor(Date.now() / 1000));
      assert.ok(code && /^\d{6}$/.test(code), 'a six-digit code');

      assert.strictEqual(mfa.verifyTotpToken(secret, code), true);
      assert.strictEqual(
        mfa.verifyTotpToken(secret, code),
        true,
        'verifying alone does not consume the code'
      );
      assert.strictEqual(mfa.consumeTotpToken('Alice', secret, code), true);
      assert.strictEqual(
        mfa.consumeTotpToken('alice', secret, code),
        false,
        'the same code is refused again, whatever the case of the name'
      );
      assert.strictEqual(
        mfa.consumeTotpToken('bob', secret, code),
        true,
        'another account keeps its own record'
      );
    });

    await test('a wrong or malformed code is refused', () => {
      const secret = mfa.generateBase32Secret();
      assert.strictEqual(mfa.verifyTotpToken(secret, 'abcdef'), false);
      assert.strictEqual(mfa.verifyTotpToken(secret, ''), false);
      assert.strictEqual(mfa.consumeTotpToken('carol', secret, '12'), false);
    });

    await test('the otpauth URI names issuer, digits and period', () => {
      const uri = mfa.buildOtpAuthUri('ABCDEFGH', 'admin');
      assert.ok(uri.startsWith('otpauth://totp/Zettelrobbe%3Aadmin?'));
      const params = new URLSearchParams(uri.split('?')[1]);
      assert.strictEqual(params.get('secret'), 'ABCDEFGH');
      assert.strictEqual(params.get('issuer'), 'Zettelrobbe');
      assert.strictEqual(params.get('digits'), '6');
      assert.strictEqual(params.get('period'), '30');
    });

    await test('every require sees the same challenge store', () => {
      const again = require('../services/mfaService');
      assert.strictEqual(again.setupMfaChallenges, setupMfaChallenges);
    });
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exitCode = 1;
});
