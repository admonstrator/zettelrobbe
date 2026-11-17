'use strict';

/**
 * Single sign-on on the settings page: what POST /settings stores and
 * refuses for the OIDC_* keys, what GET /settings hands the view, and the
 * provider test behind POST /api/settings/oidc/test.
 *
 * The login flow itself is covered by test-oidc-sso.js. Here two small fake
 * providers run on 127.0.0.1 (different ports, so different origins): each
 * serves a discovery document and a token endpoint that answers like a real
 * one to a made-up authorization code, invalid_client for wrong client
 * credentials and invalid_grant otherwise. They record every token request,
 * which is how the tests see where a stored secret went and which redirect
 * URI was sent. With a list of registered redirect URIs a provider also
 * answers invalid_client for any other one, like Authentik in strict mode.
 *
 * Covered:
 *   1. A save with the 14 form keys writes the 14 OIDC_* keys; switches
 *      become yes/no.
 *   2. An empty client secret keeps the stored one; a body without the
 *      oidc* keys keeps every stored value.
 *   3. Switched on but incomplete (issuer, client ID, admin e-mail, redirect
 *      URI, auth method, icon, colours) is refused with 400; switched off
 *      saves whatever was typed; a container-injected value counts.
 *   4. GET /settings passes oidcDetectedRedirectUri and oidcStatus.
 *   5. The test endpoint: success against a provider, invalid_client
 *      reported, unreachable provider reported, bad input refused with 400,
 *      unauthenticated refused, and the stored secret only reaches the
 *      configured issuer's origin. The probe carries the redirect URI a
 *      login would use (typed, else OIDC_REDIRECT_URI, else derived from the
 *      request), never one built from the issuer (issue #438).
 */

const assert = require('assert');
const http = require('http');
const { mountRouter } = require('./helpers/mount-router');

const API_KEY = 'test-api-key';
const CLIENT_ID = 'zettelrobbe';
const STORED_SECRET = 'stored-client-secret';

let passed = 0;
let failed = 0;

// A successful POST /settings schedules process.exit(0) five seconds later.
const realExit = process.exit.bind(process);
process.exit = () => {};

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed++;
  }
}

// ── Fake OpenID Connect provider ────────────────────────────────────────────

function startFakeProvider({ secret }) {
  const provider = {
    secret,
    authMethods: ['client_secret_basic', 'client_secret_post'],
    // Registered redirect URIs; null accepts any.
    redirectUris: null,
    tokenRequests: [],
    base: null,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, provider.base);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/realm/.well-known/openid-configuration') {
      return send(200, {
        issuer: `${provider.base}/realm`,
        authorization_endpoint: `${provider.base}/realm/authorize`,
        token_endpoint: `${provider.base}/realm/token`,
        jwks_uri: `${provider.base}/realm/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: provider.authMethods,
      });
    }

    if (url.pathname === '/realm/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(raw);
        let clientId = params.get('client_id');
        let clientSecret = params.get('client_secret');
        const authorization = req.headers.authorization || '';
        if (authorization.startsWith('Basic ')) {
          const decoded = Buffer.from(
            authorization.slice(6),
            'base64'
          ).toString();
          const separator = decoded.indexOf(':');
          clientId = decodeURIComponent(decoded.slice(0, separator));
          clientSecret = decodeURIComponent(decoded.slice(separator + 1));
        }
        provider.tokenRequests.push({
          clientId,
          clientSecret,
          authorization,
          grantType: params.get('grant_type'),
          redirectUri: params.get('redirect_uri'),
        });
        // Client authentication first (RFC 6749, 5.2), then the grant.
        if (clientId !== CLIENT_ID || clientSecret !== provider.secret) {
          return send(401, { error: 'invalid_client' });
        }
        // Authentik checks the redirect URI before the code and calls a
        // mismatch invalid_client.
        if (
          provider.redirectUris &&
          !provider.redirectUris.includes(params.get('redirect_uri'))
        ) {
          return send(400, { error: 'invalid_client' });
        }
        return send(400, { error: 'invalid_grant' });
      });
      return;
    }

    return send(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      provider.base = `http://127.0.0.1:${server.address().port}`;
      provider.issuer = `${provider.base}/realm`;
      provider.close = () => new Promise((done) => server.close(done));
      resolve(provider);
    });
  });
}

// ── Scenario helpers ────────────────────────────────────────────────────────

const OIDC_KEYS = [
  'OIDC_ENABLED',
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_ADMIN_EMAIL',
  'OIDC_REDIRECT_URI',
  'OIDC_SCOPES',
  'OIDC_EMAIL_CLAIM',
  'OIDC_ALLOW_UNVERIFIED_EMAIL',
  'OIDC_TOKEN_AUTH_METHOD',
  'OIDC_BUTTON_TEXT',
  'OIDC_BUTTON_ICON',
  'OIDC_BUTTON_COLOR',
  'OIDC_BUTTON_TEXT_COLOR',
];

function setOidcEnv(values) {
  OIDC_KEYS.forEach((key) => delete process.env[key]);
  Object.entries(values).forEach(([key, value]) => {
    process.env[key] = String(value);
  });
}

const injectedSnapshot = () => global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__;

function fullOidcBody(overrides = {}) {
  return {
    oidcEnabled: 'yes',
    oidcIssuerUrl: 'https://auth.example.com/application/o/zr/',
    oidcClientId: 'zr-client',
    oidcClientSecret: 'typed-secret',
    oidcAdminEmail: 'admin@example.com',
    oidcRedirectUri: 'https://zr.example.com/auth/oidc/callback',
    oidcScopes: 'openid   profile email groups',
    oidcEmailClaim: 'mail',
    oidcAllowUnverifiedEmail: 'on',
    oidcTokenAuthMethod: 'CLIENT_SECRET_POST',
    oidcButtonText: 'Sign in with Authentik',
    oidcButtonIcon: '/images/authentik.svg',
    oidcButtonColor: '#fd4b2d',
    oidcButtonTextColor: 'white',
    ...overrides,
  };
}

(async () => {
  const providerA = await startFakeProvider({ secret: STORED_SECRET });
  const providerB = await startFakeProvider({ secret: 'secret-of-b' });
  const savedConfigs = [];

  const harness = await mountRouter({
    stub: ({ setupService }) => {
      // Like the real saveConfig: carry what the body did not name, then put
      // the result onto process.env. No files, no restart.
      setupService.saveConfig = async (config) => {
        const carried = setupService.withSessionSecret(config);
        savedConfigs.push(carried);
        Object.entries(carried).forEach(([key, value]) => {
          if (key.startsWith('OIDC_')) process.env[key] = String(value);
        });
      };
    },
  });

  const request = (method, route, body, headers = { 'x-api-key': API_KEY }) =>
    fetch(harness.base + route, {
      method,
      redirect: 'manual',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const lastSaved = () => savedConfigs[savedConfigs.length - 1];

  try {
    // ── 1. Save writes the keys ─────────────────────────────────────────────
    await test('save with the 14 form keys writes the 14 OIDC_* keys', async () => {
      setOidcEnv({});
      const before = savedConfigs.length;
      const response = await request('POST', '/settings', fullOidcBody());
      const body = await response.json();
      assert.strictEqual(response.status, 200, JSON.stringify(body));
      assert.strictEqual(body.success, true);
      assert.strictEqual(savedConfigs.length, before + 1);
      const saved = lastSaved();
      assert.deepStrictEqual(
        Object.fromEntries(OIDC_KEYS.map((key) => [key, saved[key]])),
        {
          OIDC_ENABLED: 'yes',
          OIDC_ISSUER_URL: 'https://auth.example.com/application/o/zr/',
          OIDC_CLIENT_ID: 'zr-client',
          OIDC_CLIENT_SECRET: 'typed-secret',
          OIDC_ADMIN_EMAIL: 'admin@example.com',
          OIDC_REDIRECT_URI: 'https://zr.example.com/auth/oidc/callback',
          OIDC_SCOPES: 'openid profile email groups',
          OIDC_EMAIL_CLAIM: 'mail',
          OIDC_ALLOW_UNVERIFIED_EMAIL: 'yes',
          OIDC_TOKEN_AUTH_METHOD: 'client_secret_post',
          OIDC_BUTTON_TEXT: 'Sign in with Authentik',
          OIDC_BUTTON_ICON: '/images/authentik.svg',
          OIDC_BUTTON_COLOR: '#fd4b2d',
          OIDC_BUTTON_TEXT_COLOR: 'white',
        }
      );
    });

    await test('switches map to yes/no and the button text is cut to 60 characters', async () => {
      setOidcEnv({ OIDC_ENABLED: 'yes', OIDC_ALLOW_UNVERIFIED_EMAIL: 'yes' });
      const response = await request('POST', '/settings', {
        oidcEnabled: 'off',
        oidcAllowUnverifiedEmail: 'no',
        oidcButtonText: 'x'.repeat(80),
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(lastSaved().OIDC_ENABLED, 'no');
      assert.strictEqual(lastSaved().OIDC_ALLOW_UNVERIFIED_EMAIL, 'no');
      assert.strictEqual(lastSaved().OIDC_BUTTON_TEXT, 'x'.repeat(60));
    });

    // ── 2. Stored values survive ────────────────────────────────────────────
    await test('an empty client secret keeps the stored one', async () => {
      setOidcEnv({ OIDC_CLIENT_SECRET: STORED_SECRET });
      const response = await request(
        'POST',
        '/settings',
        fullOidcBody({ oidcClientSecret: '' })
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(lastSaved().OIDC_CLIENT_SECRET, STORED_SECRET);
    });

    await test('a body without the oidc* keys leaves every stored value', async () => {
      const stored = {
        OIDC_ENABLED: 'yes',
        OIDC_ISSUER_URL: 'https://auth.example.com/',
        OIDC_CLIENT_ID: 'kept',
        OIDC_CLIENT_SECRET: STORED_SECRET,
        OIDC_ADMIN_EMAIL: 'kept@example.com',
        OIDC_BUTTON_COLOR: '#123456',
      };
      setOidcEnv(stored);
      const response = await request('POST', '/settings', {
        scanInterval: '*/30 * * * *',
      });
      assert.strictEqual(response.status, 200);
      Object.entries(stored).forEach(([key, value]) => {
        assert.strictEqual(lastSaved()[key], value, key);
      });
    });

    // ── 3. Validation ───────────────────────────────────────────────────────
    const refusals = [
      [
        'issuer URL that is not http(s)',
        { oidcIssuerUrl: 'ftp://auth.example.com' },
        'OIDC_ISSUER_URL',
      ],
      ['missing issuer URL', { oidcIssuerUrl: '' }, 'OIDC_ISSUER_URL'],
      ['empty client ID', { oidcClientId: '  ' }, 'OIDC_CLIENT_ID'],
      ['invalid admin e-mail', { oidcAdminEmail: 'admin' }, 'OIDC_ADMIN_EMAIL'],
      [
        'redirect URI without scheme',
        { oidcRedirectUri: 'zr.example.com/auth/oidc/callback' },
        'OIDC_REDIRECT_URI',
      ],
      [
        'unknown token auth method',
        { oidcTokenAuthMethod: 'private_key_jwt' },
        'OIDC_TOKEN_AUTH_METHOD',
      ],
      [
        'unusable button icon',
        { oidcButtonIcon: 'javascript:alert(1)' },
        'OIDC_BUTTON_ICON',
      ],
      [
        'unsafe button colour',
        { oidcButtonColor: 'red; background:url(x)' },
        'OIDC_BUTTON_COLOR',
      ],
    ];
    for (const [label, overrides, key] of refusals) {
      await test(`switched on: ${label} is refused with 400`, async () => {
        setOidcEnv({});
        const before = savedConfigs.length;
        const response = await request(
          'POST',
          '/settings',
          fullOidcBody(overrides)
        );
        const body = await response.json();
        assert.strictEqual(response.status, 400);
        assert.strictEqual(body.success, false);
        assert.ok(body.error.includes(key), body.error);
        assert.strictEqual(savedConfigs.length, before, 'nothing saved');
      });
    }

    await test('switched on through the stored value, an incomplete body is refused', async () => {
      setOidcEnv({ OIDC_ENABLED: 'yes' });
      const response = await request('POST', '/settings', {
        oidcClientId: 'only-this',
      });
      assert.strictEqual(response.status, 400);
    });

    await test('switched off: whatever was typed is saved', async () => {
      setOidcEnv({});
      const response = await request(
        'POST',
        '/settings',
        fullOidcBody({
          oidcEnabled: 'no',
          oidcIssuerUrl: 'auth.example.com',
          oidcClientId: '',
          oidcAdminEmail: 'not yet',
        })
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(lastSaved().OIDC_ENABLED, 'no');
      assert.strictEqual(lastSaved().OIDC_ISSUER_URL, 'auth.example.com');
      assert.strictEqual(lastSaved().OIDC_ADMIN_EMAIL, 'not yet');
    });

    await test('a container-injected value is what the check sees', async () => {
      setOidcEnv({ OIDC_CLIENT_ID: 'injected-client' });
      injectedSnapshot().OIDC_CLIENT_ID = 'injected-client';
      try {
        const response = await request(
          'POST',
          '/settings',
          fullOidcBody({ oidcClientId: '' })
        );
        assert.strictEqual(response.status, 200);
      } finally {
        delete injectedSnapshot().OIDC_CLIENT_ID;
      }
    });

    // ── 4. GET /settings locals ─────────────────────────────────────────────
    await test('GET /settings passes oidcDetectedRedirectUri and oidcStatus', async () => {
      setOidcEnv({ OIDC_ENABLED: 'yes', OIDC_ISSUER_URL: providerA.issuer });
      const response_ = harness.app.response;
      const originalRender = response_.render;
      let locals = null;
      response_.render = function (view, options) {
        locals = options;
        this.json({ view });
      };
      try {
        const response = await request('GET', '/settings', undefined, {
          'x-api-key': API_KEY,
          'x-forwarded-proto': 'https',
        });
        assert.strictEqual(response.status, 200);
      } finally {
        response_.render = originalRender;
      }
      assert.ok(locals, 'the settings view was rendered');
      const host = new URL(harness.base).host;
      assert.strictEqual(
        locals.oidcDetectedRedirectUri,
        `http://${host}/auth/oidc/callback`
      );
      assert.strictEqual(locals.oidcStatus.enabled, true);
      assert.ok(
        locals.oidcStatus.errors.some((e) => e.includes('OIDC_CLIENT_ID')),
        JSON.stringify(locals.oidcStatus)
      );
      assert.ok(
        locals.oidcStatus.errors.some((e) => e.includes('OIDC_ADMIN_EMAIL'))
      );

      setOidcEnv({});
      response_.render = function (view, options) {
        locals = options;
        this.json({ view });
      };
      try {
        await request('GET', '/settings');
      } finally {
        response_.render = originalRender;
      }
      assert.deepStrictEqual(locals.oidcStatus, { enabled: false, errors: [] });
    });

    // ── 5. Test endpoint ────────────────────────────────────────────────────
    const testProvider = (body, headers) =>
      request('POST', '/api/settings/oidc/test', body, headers);

    await test('test endpoint: success against a provider with a typed secret', async () => {
      setOidcEnv({});
      providerB.tokenRequests.length = 0;
      const response = await testProvider({
        issuerUrl: `${providerB.issuer}/.well-known/openid-configuration`,
        clientId: CLIENT_ID,
        clientSecret: 'secret-of-b',
        tokenAuthMethod: '',
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.success, true, JSON.stringify(body));
      assert.deepStrictEqual(body.data, {
        issuer: providerB.issuer,
        tokenAuthMethods: ['client_secret_basic', 'client_secret_post'],
        chosenAuthMethod: 'client_secret_basic',
        pkce: true,
      });
      assert.ok(body.message);
      assert.strictEqual(providerB.tokenRequests.length, 1);
      assert.strictEqual(
        providerB.tokenRequests[0].clientSecret,
        'secret-of-b'
      );
    });

    await test('test endpoint: honours the chosen auth method', async () => {
      providerB.tokenRequests.length = 0;
      const response = await testProvider({
        issuerUrl: providerB.issuer,
        clientId: CLIENT_ID,
        clientSecret: 'secret-of-b',
        tokenAuthMethod: 'client_secret_post',
      });
      const body = await response.json();
      assert.strictEqual(body.success, true, JSON.stringify(body));
      assert.strictEqual(body.data.chosenAuthMethod, 'client_secret_post');
      assert.strictEqual(providerB.tokenRequests[0].authorization, '');
    });

    await test('test endpoint: wrong credentials are reported as invalid_client', async () => {
      const response = await testProvider({
        issuerUrl: providerB.issuer,
        clientId: CLIENT_ID,
        clientSecret: 'wrong',
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.success, false);
      assert.ok(body.error.includes('invalid_client'), body.error);
    });

    await test('test endpoint: an unreachable provider is reported, not thrown', async () => {
      const response = await testProvider({
        issuerUrl: 'http://127.0.0.1:9/realm',
        clientId: CLIENT_ID,
        clientSecret: 'x',
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.success, false);
      assert.ok(body.error.includes('discovery'), body.error);
    });

    await test('test endpoint: invalid input is refused with 400', async () => {
      for (const body of [
        { issuerUrl: 'ftp://auth.example.com', clientId: CLIENT_ID },
        { issuerUrl: 'auth.example.com', clientId: CLIENT_ID },
        { issuerUrl: providerB.issuer, clientId: ' ' },
        {
          issuerUrl: providerB.issuer,
          clientId: CLIENT_ID,
          tokenAuthMethod: 'private_key_jwt',
        },
        {
          issuerUrl: providerB.issuer,
          clientId: CLIENT_ID,
          tokenAuthMethod: 'client_secret_basic',
        },
        {
          issuerUrl: providerB.issuer,
          clientId: CLIENT_ID,
          clientSecret: 'secret-of-b',
          redirectUri: 'zettelrobbe.example.com/auth/oidc/callback',
        },
      ]) {
        const response = await testProvider(body);
        const answer = await response.json();
        assert.strictEqual(response.status, 400, JSON.stringify(body));
        assert.strictEqual(answer.success, false);
        assert.ok(answer.error);
      }
    });

    await test('test endpoint: unauthenticated requests are refused', async () => {
      const response = await testProvider(
        { issuerUrl: providerB.issuer, clientId: CLIENT_ID },
        {}
      );
      // The router's authentication guard answers every unauthenticated
      // request, API or page, with a redirect to the login page.
      assert.strictEqual(response.status, 302);
      assert.strictEqual(response.headers.get('location'), '/login');
    });

    await test('test endpoint: an empty secret uses the stored one for the configured issuer', async () => {
      setOidcEnv({
        OIDC_ISSUER_URL: providerA.issuer,
        OIDC_CLIENT_SECRET: STORED_SECRET,
      });
      providerA.tokenRequests.length = 0;
      const response = await testProvider({
        issuerUrl: providerA.issuer,
        clientId: CLIENT_ID,
        clientSecret: '',
      });
      const body = await response.json();
      assert.strictEqual(body.success, true, JSON.stringify(body));
      assert.strictEqual(body.data.chosenAuthMethod, 'client_secret_basic');
      assert.strictEqual(
        providerA.tokenRequests[0].clientSecret,
        STORED_SECRET
      );
    });

    await test('test endpoint: the stored secret never goes to another issuer origin', async () => {
      setOidcEnv({
        OIDC_ISSUER_URL: providerA.issuer,
        OIDC_CLIENT_SECRET: STORED_SECRET,
      });
      providerB.tokenRequests.length = 0;
      const response = await testProvider({
        issuerUrl: providerB.issuer,
        clientId: CLIENT_ID,
      });
      const body = await response.json();
      // Provider B wants its own secret, so a test without one fails there.
      assert.strictEqual(body.success, false);
      assert.ok(body.error.includes('invalid_client'), body.error);
      assert.ok(providerB.tokenRequests.length > 0);
      providerB.tokenRequests.forEach((entry) => {
        assert.notStrictEqual(entry.clientSecret, STORED_SECRET);
        assert.ok(!entry.authorization, 'no Basic credentials');
      });
    });

    // Issue #438: the probe must carry the redirect URI a login would use.
    const REGISTERED_REDIRECT =
      'https://zettelrobbe.example.com/auth/oidc/callback';

    await test('test endpoint: sends the typed redirect URI to a strict provider', async () => {
      setOidcEnv({});
      providerB.redirectUris = [REGISTERED_REDIRECT];
      providerB.tokenRequests.length = 0;
      try {
        const response = await testProvider({
          issuerUrl: providerB.issuer,
          clientId: CLIENT_ID,
          clientSecret: 'secret-of-b',
          redirectUri: ` ${REGISTERED_REDIRECT} `,
        });
        const body = await response.json();
        assert.strictEqual(body.success, true, JSON.stringify(body));
        assert.strictEqual(providerB.tokenRequests.length, 1);
        assert.strictEqual(
          providerB.tokenRequests[0].redirectUri,
          REGISTERED_REDIRECT
        );
      } finally {
        providerB.redirectUris = null;
      }
    });

    await test('test endpoint: without a typed redirect URI it sends OIDC_REDIRECT_URI', async () => {
      setOidcEnv({ OIDC_REDIRECT_URI: REGISTERED_REDIRECT });
      providerB.redirectUris = [REGISTERED_REDIRECT];
      providerB.tokenRequests.length = 0;
      try {
        const response = await testProvider({
          issuerUrl: providerB.issuer,
          clientId: CLIENT_ID,
          clientSecret: 'secret-of-b',
          redirectUri: '',
        });
        const body = await response.json();
        assert.strictEqual(body.success, true, JSON.stringify(body));
        assert.strictEqual(
          providerB.tokenRequests[0].redirectUri,
          REGISTERED_REDIRECT
        );
      } finally {
        providerB.redirectUris = null;
      }
    });

    await test('test endpoint: with no redirect URI anywhere it sends the one derived from the request', async () => {
      setOidcEnv({});
      providerB.tokenRequests.length = 0;
      const response = await testProvider({
        issuerUrl: providerB.issuer,
        clientId: CLIENT_ID,
        clientSecret: 'secret-of-b',
      });
      const body = await response.json();
      assert.strictEqual(body.success, true, JSON.stringify(body));
      assert.strictEqual(
        providerB.tokenRequests[0].redirectUri,
        `${harness.base}/auth/oidc/callback`
      );
      assert.notStrictEqual(
        providerB.tokenRequests[0].redirectUri,
        `${providerB.base}/auth/oidc/callback`,
        'never the issuer origin'
      );
    });

    await test('test endpoint: an unregistered redirect URI is named in the error', async () => {
      setOidcEnv({});
      providerB.redirectUris = [REGISTERED_REDIRECT];
      try {
        const response = await testProvider({
          issuerUrl: providerB.issuer,
          clientId: CLIENT_ID,
          clientSecret: 'secret-of-b',
          redirectUri: 'https://other.example.com/auth/oidc/callback',
        });
        const body = await response.json();
        assert.strictEqual(response.status, 200);
        assert.strictEqual(body.success, false);
        assert.ok(body.error.includes('invalid_client'), body.error);
        assert.ok(
          body.error.includes('https://other.example.com/auth/oidc/callback'),
          body.error
        );
      } finally {
        providerB.redirectUris = null;
      }
    });
  } finally {
    await providerA.close();
    await providerB.close();
    await harness.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  realExit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  realExit(1);
});
