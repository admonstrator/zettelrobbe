/**
 * MFA Login Flow Regression Test
 *
 * Validates:
 * - Step 1 credential login returns MFA challenge
 * - Invalid TOTP keeps user in MFA step
 * - Valid TOTP completes login and redirects to dashboard
 *
 * Usage:
 * 1) Start server
 * 2) Set LOGIN_TEST_USERNAME and LOGIN_TEST_PASSWORD
 * 3) Run: node tests/test-login-mfa-flow.js
 */

const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_USERNAME = process.env.LOGIN_TEST_USERNAME;
const TEST_PASSWORD = process.env.LOGIN_TEST_PASSWORD;
const TEST_SECRET = process.env.LOGIN_TEST_MFA_SECRET || 'JBSWY3DPEHPK3PXP';

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

function decodeBase32Secret(secret) {
  const normalized = String(secret || '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/[^A-Z2-7]/g, '');

  if (!normalized) {
    return null;
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';

  for (const char of normalized) {
    const value = alphabet.indexOf(char);
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

function generateTotpToken(secret, unixTimeSeconds) {
  const key = decodeBase32Secret(secret);
  if (!key) {
    throw new Error('Invalid MFA secret for TOTP generation');
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

function serializeForm(fields) {
  const payload = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    payload.set(key, String(value));
  }
  return payload.toString();
}

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'documents.db');
  return new Database(dbPath);
}

function ensureMfaColumns(database) {
  const columns = database
    .prepare("PRAGMA table_info('users')")
    .all()
    .map((row) => row.name);
  if (!columns.includes('mfa_enabled')) {
    database.exec('ALTER TABLE users ADD COLUMN mfa_enabled INTEGER DEFAULT 0');
  }
  if (!columns.includes('mfa_secret')) {
    database.exec('ALTER TABLE users ADD COLUMN mfa_secret TEXT DEFAULT NULL');
  }
}

/**
 * The login form's CSRF pair: the cookie GET /login sets and the token it
 * renders into the form. Every POST /login has to send both (double-submit
 * CSRF protection in server.js), or it is refused with 403.
 */
async function getLoginCsrf() {
  const page = await axios.get(`${BASE_URL}/login`, {
    validateStatus: () => true,
    maxRedirects: 0,
  });
  const cookie = extractCookieValue(
    page.headers['set-cookie'],
    'psai.x-csrf-token'
  );
  const match = String(page.data).match(/name="_csrf" value="([^"]+)"/);
  if (!cookie || !match) {
    throw new Error('GET /login did not hand out a CSRF cookie and token');
  }
  return { cookie, token: match[1] };
}

async function postLogin(fields, cookieHeader) {
  const csrf = await getLoginCsrf();
  const body = serializeForm({ ...fields, _csrf: csrf.token });
  return axios.post(`${BASE_URL}/login`, body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: [csrf.cookie, cookieHeader].filter(Boolean).join('; '),
    },
    validateStatus: () => true,
    maxRedirects: 0,
  });
}

function extractCookieValue(setCookieHeader, cookieName) {
  const entries = Array.isArray(setCookieHeader) ? setCookieHeader : [];
  for (const entry of entries) {
    if (entry.startsWith(`${cookieName}=`)) {
      return entry.split(';')[0];
    }
  }
  return null;
}

async function run() {
  console.log('\nMFA Login Flow Regression Test');
  console.log('='.repeat(46));

  if (!TEST_USERNAME || !TEST_PASSWORD) {
    console.log(
      'Skipped: set LOGIN_TEST_USERNAME and LOGIN_TEST_PASSWORD to run this test.'
    );
    process.exit(0);
  }

  const db = getDb();
  let originalRow = null;

  try {
    ensureMfaColumns(db);

    originalRow = db
      .prepare(
        'SELECT username, mfa_enabled, mfa_secret FROM users WHERE username = ?'
      )
      .get(TEST_USERNAME);
    if (!originalRow) {
      throw new Error(`User '${TEST_USERNAME}' not found`);
    }

    db.prepare(
      'UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE username = ?'
    ).run(TEST_SECRET, TEST_USERNAME);

    console.log('1) Submit credentials and expect MFA challenge...');
    const stepOneBody = {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      mfaStep: 0,
    };
    const stepOne = await postLogin(stepOneBody);

    if (stepOne.status !== 200) {
      throw new Error(
        `Expected HTTP 200 on step 1, received ${stepOne.status}`
      );
    }

    const mfaChallengeCookie = extractCookieValue(
      stepOne.headers['set-cookie'],
      'mfa_challenge'
    );
    if (!mfaChallengeCookie) {
      throw new Error('MFA challenge cookie missing after valid credentials');
    }

    if (!String(stepOne.data).includes('Authentication code')) {
      throw new Error('MFA step was not rendered after valid credentials');
    }

    console.log('2) Submit invalid MFA token and expect error page...');
    const invalidStepBody = {
      username: TEST_USERNAME,
      mfaStep: 1,
      mfaToken: '000000',
    };
    const invalidStep = await postLogin(invalidStepBody, mfaChallengeCookie);

    if (invalidStep.status !== 200) {
      throw new Error(
        `Expected HTTP 200 for invalid MFA token, received ${invalidStep.status}`
      );
    }

    if (!String(invalidStep.data).includes('Invalid authentication code')) {
      throw new Error(
        'Invalid MFA token did not show expected validation message'
      );
    }

    console.log('3) Submit valid MFA token and expect dashboard redirect...');
    const validToken = generateTotpToken(
      TEST_SECRET,
      Math.floor(Date.now() / 1000)
    );
    const validStepBody = {
      username: TEST_USERNAME,
      mfaStep: 1,
      mfaToken: validToken,
    };
    const validStep = await postLogin(validStepBody, mfaChallengeCookie);

    if (validStep.status !== 302) {
      throw new Error(
        `Expected HTTP 302 for valid MFA login, received ${validStep.status}`
      );
    }

    if (validStep.headers.location !== '/dashboard') {
      throw new Error(
        `Expected redirect to /dashboard, got '${validStep.headers.location || 'none'}'`
      );
    }

    const jwtCookie = extractCookieValue(
      validStep.headers['set-cookie'],
      'jwt'
    );
    if (!jwtCookie) {
      throw new Error('JWT cookie missing after successful MFA login');
    }

    console.log('PASS: MFA login flow behaves as expected.');
    process.exit(0);
  } catch (error) {
    console.error('FAIL:', error.message);
    process.exitCode = 1;
  } finally {
    if (originalRow) {
      db.prepare(
        'UPDATE users SET mfa_enabled = ?, mfa_secret = ? WHERE username = ?'
      ).run(
        originalRow.mfa_enabled || 0,
        originalRow.mfa_secret || null,
        originalRow.username
      );
    }

    db.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error('Fatal error:', error.message);
    process.exit(1);
  });
}
