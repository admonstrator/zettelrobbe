'use strict';

/**
 * Regression test for information disclosure on GET /health (CWE-200).
 *
 * /health is public so container healthchecks and uptime monitors can reach
 * it. It used to return the whole scanner and Paperless-ngx snapshot to
 * anyone, including raw error messages such as
 * "connect ECONNREFUSED 172.18.0.2:8000" that name internal hosts and ports.
 * An unauthenticated caller now gets only `status` and `database`; a session
 * or the API key still gets the full payload.
 */

const assert = require('assert');
const jwt = require('jsonwebtoken');
const { mountRouter } = require('./helpers/mount-router');

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
  const sessionToken = jwt.sign(
    { id: 1, username: 'admin', typ: 'session' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  const challengeToken = jwt.sign(
    { id: 1, username: 'admin', challengeType: 'mfa-login' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );

  const health = (headers = {}) =>
    fetch(harness.base + '/health', { headers }).then(async (res) => ({
      status: res.status,
      body: await res.json(),
    }));

  try {
    await test('an anonymous caller gets only status and database', async () => {
      const { status, body } = await health();
      assert.ok(status === 200 || status === 503, `got HTTP ${status}`);
      assert.deepStrictEqual(Object.keys(body).sort(), ['database', 'status']);
    });

    await test('a wrong API key is treated as anonymous', async () => {
      const { body } = await health({ 'x-api-key': 'wrong-key' });
      assert.deepStrictEqual(Object.keys(body).sort(), ['database', 'status']);
    });

    await test('an MFA challenge token is treated as anonymous', async () => {
      const { body } = await health({ Cookie: `jwt=${challengeToken}` });
      assert.deepStrictEqual(Object.keys(body).sort(), ['database', 'status']);
    });

    await test('a session gets the scanner and Paperless-ngx details', async () => {
      const { body } = await health({ Cookie: `jwt=${sessionToken}` });
      assert.ok(body.scanner, 'scanner details expected');
      assert.ok(body.paperless, 'paperless details expected');
    });

    await test('the API key gets the scanner and Paperless-ngx details', async () => {
      const { body } = await health({ 'x-api-key': process.env.API_KEY });
      assert.ok(body.scanner, 'scanner details expected');
      assert.ok(body.paperless, 'paperless details expected');
    });

    await test('anonymous and authenticated callers see the same status', async () => {
      const anonymous = await health();
      const authenticated = await health({ 'x-api-key': process.env.API_KEY });
      assert.strictEqual(anonymous.status, authenticated.status);
      assert.strictEqual(anonymous.body.status, authenticated.body.status);
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
