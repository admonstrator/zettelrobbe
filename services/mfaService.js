// @ts-check
'use strict';

/**
 * TOTP (RFC 6238) and the in-memory state of multi-factor sign-in.
 *
 * Sign-in, the settings page and the setup wizard all verify codes, and the
 * replay protection only works when they share one record of the codes
 * already accepted. Every Map here must therefore exist exactly once.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const documentModel = require('../models/document.js');

/** Cookie holding the short-lived challenge between password and code. */
const MFA_CHALLENGE_COOKIE = 'mfa_challenge';
/** Cookie holding the secret while a signed-in user enables MFA. */
const MFA_SETUP_COOKIE = 'mfa_setup';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * @param {unknown} secret - base32 text, padding and separators allowed
 * @returns {Buffer|null} the key bytes, or null when nothing usable is left
 */
function decodeBase32Secret(secret) {
  const normalized = String(secret || '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/[^A-Z2-7]/g, '');

  if (!normalized) {
    return null;
  }

  let bits = '';

  for (const char of normalized) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) {
      return null;
    }
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }

  return bytes.length > 0 ? Buffer.from(bytes) : null;
}

/**
 * @param {string} secret - base32 TOTP secret
 * @param {number} unixTimeSeconds - the moment the code is for
 * @returns {string|null} the code, or null for an unusable secret
 */
function generateTotpToken(secret, unixTimeSeconds) {
  const key = decodeBase32Secret(secret);
  if (!key) {
    return null;
  }

  const counter = Math.floor(unixTimeSeconds / TOTP_STEP_SECONDS);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * @param {number} [length] - number of base32 characters
 * @returns {string} a random base32 secret
 */
function generateBase32Secret(length = 32) {
  const bytes = crypto.randomBytes(length);
  let output = '';

  for (let i = 0; i < length; i += 1) {
    // The alphabet holds exactly 32 characters, so masking the low 5 bits maps
    // each random byte onto it uniformly instead of relying on a biased modulo.
    output += BASE32_ALPHABET[bytes[i] & 0x1f];
  }

  return output;
}

/**
 * @param {string} secret - base32 TOTP secret
 * @param {string} username - account label shown in the authenticator app
 * @returns {string} the otpauth:// URI an authenticator app scans
 */
function buildOtpAuthUri(secret, username) {
  const issuer = 'Zettelrobbe';
  const accountLabel = `${issuer}:${username}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });

  return `otpauth://totp/${encodeURIComponent(accountLabel)}?${params.toString()}`;
}

/**
 * Returns the TOTP time step the code belongs to, or null when the code does
 * not match any step inside the accepted window.
 *
 * @param {string} secret - base32 TOTP secret
 * @param {unknown} inputToken - the code the user typed
 * @returns {number|null}
 */
function findTotpStep(secret, inputToken) {
  const normalizedInput = String(inputToken || '').replace(/\s+/g, '');
  if (!/^\d{6,8}$/.test(normalizedInput)) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const unixTimeSeconds = now + offset * TOTP_STEP_SECONDS;
    const expected = generateTotpToken(secret, unixTimeSeconds);
    if (!expected || expected.length !== normalizedInput.length) {
      continue;
    }

    if (
      crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(normalizedInput)
      )
    ) {
      return Math.floor(unixTimeSeconds / TOTP_STEP_SECONDS);
    }
  }

  return null;
}

/**
 * Checks a code without consuming it.
 *
 * @param {string} secret - base32 TOTP secret
 * @param {unknown} inputToken - the code the user typed
 * @returns {boolean}
 */
function verifyTotpToken(secret, inputToken) {
  return findTotpStep(secret, inputToken) !== null;
}

/**
 * Last accepted TOTP time step per username. RFC 6238 section 5.2: once a
 * code has been accepted, the verifier must not accept it again. Kept in
 * memory: a restart forgets it, and the window it protects is 90 seconds.
 *
 * @type {Map<string, number>}
 */
const lastAcceptedTotpSteps = new Map();

/**
 * Verifies a TOTP code and consumes it, so the same code (or an older one)
 * is refused for that user until a newer time step comes up. For actions a
 * captured code must not be able to repeat: signing in, enabling and
 * disabling MFA.
 *
 * @param {string} username - the account the code is for
 * @param {string} secret - base32 TOTP secret
 * @param {unknown} inputToken - the code the user typed
 * @returns {boolean}
 */
function consumeTotpToken(username, secret, inputToken) {
  const step = findTotpStep(secret, inputToken);
  if (step === null) {
    return false;
  }

  const key = String(username || '').toLowerCase();
  const lastStep = lastAcceptedTotpSteps.get(key);
  if (lastStep !== undefined && step <= lastStep) {
    return false;
  }

  lastAcceptedTotpSteps.set(key, step);
  return true;
}

/**
 * @param {{ mfa_enabled?: unknown, mfaEnabled?: unknown }|null|undefined} user
 * @returns {boolean}
 */
function isMfaEnabledForUser(user) {
  return Boolean(user && (user.mfa_enabled || user.mfaEnabled));
}

/* Cost the setup wizard hashes the administrator password with. */
const ADMIN_PASSWORD_BCRYPT_ROUNDS = 15;

/**
 * One dummy hash per bcrypt cost, created on first use.
 *
 * @type {Map<number, Promise<string>>}
 */
const dummyPasswordHashes = new Map();

/**
 * Spends the same bcrypt work on a failed username lookup as on a real
 * password check, so the response time no longer tells an attacker whether
 * the username exists (CWE-208). The dummy hash uses the cost of the stored
 * account when there is one, because the comparison time grows with it.
 *
 * @param {unknown} password - the submitted password
 * @returns {Promise<void>}
 */
async function spendPasswordCheckTime(password) {
  let rounds = ADMIN_PASSWORD_BCRYPT_ROUNDS;
  try {
    const users = await documentModel.getUsers();
    const storedHash = users?.[0]?.password;
    if (storedHash) {
      rounds = bcrypt.getRounds(storedHash);
    }
  } catch {
    // Keep the default cost.
  }

  let dummyHash = dummyPasswordHashes.get(rounds);
  if (!dummyHash) {
    dummyHash = bcrypt.hash(crypto.randomBytes(32).toString('hex'), rounds);
    dummyPasswordHashes.set(rounds, dummyHash);
  }

  try {
    await bcrypt.compare(String(password ?? ''), await dummyHash);
  } catch {
    // Only the elapsed time matters here.
  }
}

/** How long a setup-wizard MFA challenge stays usable. */
const SETUP_MFA_CHALLENGE_TTL_MS = 10 * 60 * 1000;

/**
 * @typedef {object} SetupMfaChallenge
 * @property {string} username - the administrator name the code was set up for
 * @property {string} secret - base32 TOTP secret
 * @property {boolean} verified - the user has confirmed one code
 * @property {number} createdAt - epoch milliseconds
 */

/**
 * MFA challenges of the setup wizard, by challenge id. The wizard creates one,
 * confirms it and consumes it in POST /api/setup/complete.
 *
 * @type {Map<string, SetupMfaChallenge>}
 */
const setupMfaChallenges = new Map();

/**
 * Drops every setup challenge older than SETUP_MFA_CHALLENGE_TTL_MS.
 *
 * @param {number} [now] - epoch milliseconds; tests pass a fixed clock
 * @returns {void}
 */
function cleanupExpiredSetupMfaChallenges(now = Date.now()) {
  for (const [challengeId, challenge] of setupMfaChallenges.entries()) {
    if (now - challenge.createdAt > SETUP_MFA_CHALLENGE_TTL_MS) {
      setupMfaChallenges.delete(challengeId);
    }
  }
}

module.exports = {
  MFA_CHALLENGE_COOKIE,
  MFA_SETUP_COOKIE,
  TOTP_STEP_SECONDS,
  TOTP_DIGITS,
  ADMIN_PASSWORD_BCRYPT_ROUNDS,
  SETUP_MFA_CHALLENGE_TTL_MS,
  setupMfaChallenges,
  decodeBase32Secret,
  generateTotpToken,
  generateBase32Secret,
  buildOtpAuthUri,
  findTotpStep,
  verifyTotpToken,
  consumeTotpToken,
  isMfaEnabledForUser,
  spendPasswordCheckTime,
  cleanupExpiredSetupMfaChallenges,
};
