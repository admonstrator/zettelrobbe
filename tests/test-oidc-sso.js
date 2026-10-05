'use strict';

/**
 * Single sign-on through OpenID Connect (routes/oidc.js, services/oidcService.js).
 *
 * A fake provider runs on localhost and behaves like Authentik: an issuer with
 * a path and a trailing slash, a discovery document, RS256 ID tokens and a
 * userinfo endpoint. The token endpoint checks the PKCE verifier, the client
 * secret and the redirect URI, so a regression in any of them fails the happy
 * path.
 *
 * Covered:
 *   1. The login page offers the SSO button only when OIDC is fully
 *      configured, and carries its customization.
 *   2. /auth/oidc/login redirects with PKCE (S256), state and nonce.
 *   3. The callback signs the administrator in when the e-mail matches
 *      OIDC_ADMIN_EMAIL, whatever the username at the provider.
 *   4. Wrong state, a missing transaction cookie, a provider error and a
 *      different e-mail are all refused.
 *   5. The transaction cookie is not a session and a session is not a
 *      transaction.
 *   6. Provider differences: token endpoint auth methods, issuer spelling.
 *   7. The pure helpers on their own.
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

const CLIENT_ID = 'zettelrobbe';
const CLIENT_SECRET = 'test-client-secret-value';

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

// ── Fake OpenID Connect provider ────────────────────────────────────────────

function startFakeProvider() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'k1',
    use: 'sig',
    alg: 'RS256',
  };

  const provider = {
    issuer: null,
    // What the next login at the provider should return.
    user: {
      sub: 'u-1',
      preferred_username: 'andy',
      email: 'andy@example.com',
      email_verified: false,
    },
    // Claims the ID token leaves out and only userinfo carries.
    userinfoOnly: [],
    // code -> authorization request parameters
    codes: new Map(),
    lastTokenRequest: null,
    // Advertised in discovery and enforced at the token endpoint, the way
    // Authelia only accepts the method registered for the client.
    authMethods: ['client_secret_basic', 'client_secret_post'],
    lastAuthMethod: null,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, provider.base);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/application/o/zr/.well-known/openid-configuration') {
      return send(200, {
        issuer: provider.issuer,
        authorization_endpoint: `${provider.base}/application/o/authorize/`,
        token_endpoint: `${provider.base}/application/o/token/`,
        userinfo_endpoint: `${provider.base}/application/o/userinfo/`,
        end_session_endpoint: `${provider.base}/application/o/zr/end-session/`,
        jwks_uri: `${provider.base}/application/o/zr/jwks/`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: provider.authMethods,
      });
    }

    if (url.pathname === '/application/o/zr/jwks/') {
      return send(200, { keys: [jwk] });
    }

    if (url.pathname === '/application/o/token/' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(raw);
        provider.lastTokenRequest = params;

        // RFC 6749 2.3.1: Basic credentials are form-urlencoded, then base64.
        let clientId = params.get('client_id');
        let clientSecret = params.get('client_secret');
        let method = clientSecret ? 'client_secret_post' : 'none';
        const authorization = req.headers.authorization || '';
        if (authorization.startsWith('Basic ')) {
          const decoded = Buffer.from(
            authorization.slice(6),
            'base64'
          ).toString();
          const separator = decoded.indexOf(':');
          clientId = decodeURIComponent(decoded.slice(0, separator));
          clientSecret = decodeURIComponent(decoded.slice(separator + 1));
          method = 'client_secret_basic';
        }
        provider.lastAuthMethod = method;
        if (!provider.authMethods.includes(method)) {
          return send(401, { error: 'invalid_client' });
        }
        const grant = provider.codes.get(params.get('code'));
        provider.codes.delete(params.get('code'));
        if (!grant) return send(400, { error: 'invalid_grant' });

        const challenge = crypto
          .createHash('sha256')
          .update(params.get('code_verifier') || '')
          .digest('base64url');
        if (
          clientId !== CLIENT_ID ||
          clientSecret !== CLIENT_SECRET ||
          params.get('redirect_uri') !== grant.redirectUri ||
          challenge !== grant.codeChallenge
        ) {
          return send(400, { error: 'invalid_grant' });
        }

        // Like Authentik with "include claims in id_token" off: some claims
        // only arrive through userinfo.
        const idClaims = { ...grant.user };
        provider.userinfoOnly.forEach((claim) => delete idClaims[claim]);
        const idToken = jwt.sign(
          { ...idClaims, nonce: grant.nonce },
          privateKey.export({ format: 'pem', type: 'pkcs1' }),
          {
            algorithm: 'RS256',
            keyid: 'k1',
            issuer: provider.issuer,
            audience: CLIENT_ID,
            expiresIn: '5m',
          }
        );
        return send(200, {
          access_token: `at-${grant.user.sub}`,
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        });
      });
      return undefined;
    }

    if (url.pathname === '/application/o/userinfo/') {
      return send(200, provider.lastUser);
    }

    res.writeHead(404);
    return res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      provider.base = `http://127.0.0.1:${server.address().port}`;
      provider.issuer = `${provider.base}/application/o/zr/`;
      provider.close = () => new Promise((r) => server.close(r));
      resolve(provider);
    });
  });
}

/** Plays the provider's authorization endpoint: approves and issues a code. */
function approveAtProvider(provider, authorizeUrl) {
  const url = new URL(authorizeUrl);
  const code = crypto.randomBytes(8).toString('hex');
  provider.lastUser = { ...provider.user };
  provider.codes.set(code, {
    user: provider.lastUser,
    nonce: url.searchParams.get('nonce'),
    redirectUri: url.searchParams.get('redirect_uri'),
    codeChallenge: url.searchParams.get('code_challenge'),
  });
  return { code, state: url.searchParams.get('state') };
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
    if (match && match[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

(async () => {
  const provider = await startFakeProvider();

  const oidcEnv = {
    OIDC_ENABLED: 'yes',
    OIDC_ISSUER_URL: provider.issuer,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_ADMIN_EMAIL: 'Andy@Example.com',
    OIDC_BUTTON_TEXT: 'Sign in with Authentik',
    LOGIN_RATE_LIMIT_MAX: '1000',
  };
  const harness = await mountRouter({ env: oidcEnv });

  // Mounted after the setup router, the reverse of server.js, so this also
  // proves the setup router lets /auth/oidc through without a session.
  const oidcRouter = require(path.join(REPO_ROOT, 'routes', 'oidc.js'));
  harness.app.use(oidcRouter);

  // Views render as their name plus the locals under test.
  harness.app.engine('ejs', (filePath, options, callback) =>
    callback(
      null,
      JSON.stringify({
        view: path.basename(filePath, '.ejs'),
        error: options.error || null,
        sso: options.sso || null,
      })
    )
  );

  const secret = process.env.JWT_SECRET;
  await harness.documentModel.addUser('admin', await bcrypt.hash('pw', 4));

  const get = (routePath, cookie) =>
    fetch(harness.base + routePath, {
      headers: cookie ? { Cookie: cookie } : {},
      redirect: 'manual',
    });

  /** Runs /auth/oidc/login and the provider step; returns what the callback needs. */
  async function beginLogin() {
    const res = await get('/auth/oidc/login');
    assert.strictEqual(res.status, 302, `login start returned ${res.status}`);
    const tx = cookieValue(res, 'zr_oidc_tx');
    assert.ok(tx, 'transaction cookie is set');
    const location = res.headers.get('location');
    return { location, tx, ...approveAtProvider(provider, location) };
  }

  // ── 1. Login page ─────────────────────────────────────────────────────────
  await test('login page offers the SSO button with its configured text', async () => {
    const body = JSON.parse(await (await get('/login')).text());
    assert.strictEqual(body.view, 'login');
    assert.strictEqual(body.sso.enabled, true);
    assert.strictEqual(body.sso.text, 'Sign in with Authentik');
    assert.deepStrictEqual(body.sso.icon, { type: 'default' });
    assert.strictEqual(body.sso.style, '');
  });

  await test('button colours and icon come from the environment', async () => {
    process.env.OIDC_BUTTON_COLOR = '#fd4b2d';
    process.env.OIDC_BUTTON_TEXT_COLOR = 'white';
    process.env.OIDC_BUTTON_ICON = 'https://auth.example.com/static/logo.svg';
    try {
      const body = JSON.parse(await (await get('/login')).text());
      assert.strictEqual(
        body.sso.style,
        '--login-sso-bg: #fd4b2d; --login-sso-fg: white'
      );
      assert.deepStrictEqual(body.sso.icon, {
        type: 'image',
        src: 'https://auth.example.com/static/logo.svg',
      });
    } finally {
      delete process.env.OIDC_BUTTON_COLOR;
      delete process.env.OIDC_BUTTON_TEXT_COLOR;
      delete process.env.OIDC_BUTTON_ICON;
    }
  });

  await test('without OIDC_ADMIN_EMAIL the button is hidden and the routes are gone', async () => {
    delete process.env.OIDC_ADMIN_EMAIL;
    try {
      const body = JSON.parse(await (await get('/login')).text());
      assert.strictEqual(body.sso.enabled, false);
      assert.strictEqual((await get('/auth/oidc/login')).status, 404);
    } finally {
      process.env.OIDC_ADMIN_EMAIL = 'Andy@Example.com';
    }
  });

  // ── 2. Authorization request ──────────────────────────────────────────────
  await test('/auth/oidc/login redirects with PKCE S256, state, nonce and scopes', async () => {
    const { location } = await beginLogin();
    const url = new URL(location);
    assert.strictEqual(
      url.origin + url.pathname,
      `${provider.base}/application/o/authorize/`
    );
    assert.strictEqual(url.searchParams.get('client_id'), CLIENT_ID);
    assert.strictEqual(url.searchParams.get('response_type'), 'code');
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.ok(url.searchParams.get('state'));
    assert.ok(url.searchParams.get('nonce'));
    assert.strictEqual(url.searchParams.get('scope'), 'openid profile email');
    assert.strictEqual(
      url.searchParams.get('redirect_uri'),
      `${harness.base}/auth/oidc/callback`
    );
  });

  // ── 3. Happy path ─────────────────────────────────────────────────────────
  let oidcSession = null;
  await test('callback signs the administrator in when the e-mail matches', async () => {
    const { tx, code, state } = await beginLogin();
    const res = await get(
      `/auth/oidc/callback?code=${code}&state=${state}`,
      `zr_oidc_tx=${tx}`
    );
    assert.strictEqual(res.status, 302, await res.text());
    assert.strictEqual(res.headers.get('location'), '/dashboard');
    oidcSession = cookieValue(res, 'jwt');
    const payload = jwt.verify(oidcSession, secret);
    assert.strictEqual(payload.typ, 'session');
    // The provider's username is "andy"; the local account is "admin".
    assert.strictEqual(payload.username, 'admin');
    assert.strictEqual(
      provider.lastTokenRequest.get('grant_type'),
      'authorization_code'
    );
  });

  await test('the SSO session opens a protected page', async () => {
    const res = await get('/dashboard', `jwt=${oidcSession}`);
    assert.notStrictEqual(res.status, 302, 'must not bounce to /login');
  });

  // ── 4. Refusals ───────────────────────────────────────────────────────────
  await test('a mismatched state is refused', async () => {
    const { tx, code } = await beginLogin();
    const res = await get(
      `/auth/oidc/callback?code=${code}&state=forged`,
      `zr_oidc_tx=${tx}`
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(cookieValue(res, 'jwt'), null);
  });

  await test('a callback without the transaction cookie is refused', async () => {
    const { code, state } = await beginLogin();
    const res = await get(`/auth/oidc/callback?code=${code}&state=${state}`);
    assert.strictEqual(res.status, 400);
    assert.match(JSON.parse(await res.text()).error, /expired/);
  });

  await test('a provider error response is refused', async () => {
    const { tx, state } = await beginLogin();
    const res = await get(
      `/auth/oidc/callback?error=access_denied&state=${state}`,
      `zr_oidc_tx=${tx}`
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(cookieValue(res, 'jwt'), null);
  });

  await test('an identity with another e-mail is refused', async () => {
    provider.user = {
      sub: 'u-2',
      preferred_username: 'admin',
      email: 'mallory@example.com',
    };
    try {
      const { tx, code, state } = await beginLogin();
      const res = await get(
        `/auth/oidc/callback?code=${code}&state=${state}`,
        `zr_oidc_tx=${tx}`
      );
      assert.strictEqual(res.status, 403);
      assert.match(JSON.parse(await res.text()).error, /OIDC_ADMIN_EMAIL/);
      assert.strictEqual(cookieValue(res, 'jwt'), null);
    } finally {
      provider.user = {
        sub: 'u-1',
        preferred_username: 'andy',
        email: 'andy@example.com',
      };
    }
  });

  await test('an e-mail that only userinfo carries is used', async () => {
    provider.userinfoOnly = ['email'];
    try {
      const { tx, code, state } = await beginLogin();
      const res = await get(
        `/auth/oidc/callback?code=${code}&state=${state}`,
        `zr_oidc_tx=${tx}`
      );
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.get('location'), '/dashboard');
    } finally {
      provider.userinfoOnly = [];
    }
  });

  // ── 5. Token separation ───────────────────────────────────────────────────
  await test('the transaction cookie is not accepted as a session', async () => {
    const { tx } = await beginLogin();
    const res = await get('/dashboard', `jwt=${tx}`);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/login');
  });

  await test('a session token is not accepted as a transaction', async () => {
    const { code, state } = await beginLogin();
    const res = await get(
      `/auth/oidc/callback?code=${code}&state=${state}`,
      `zr_oidc_tx=${oidcSession}`
    );
    assert.strictEqual(res.status, 400);
  });

  // ── 6. Options ────────────────────────────────────────────────────────────
  await test('with OIDC disabled the routes are gone and the button is hidden', async () => {
    process.env.OIDC_ENABLED = 'no';
    try {
      assert.strictEqual((await get('/auth/oidc/login')).status, 404);
      assert.strictEqual(
        (await get('/auth/oidc/callback?code=x&state=y')).status,
        404
      );
      const body = JSON.parse(await (await get('/login')).text());
      assert.strictEqual(body.sso.enabled, false);
    } finally {
      process.env.OIDC_ENABLED = 'yes';
    }
  });

  // ── 6b. Provider differences ──────────────────────────────────────────────
  const oidcServiceForReset = require(
    path.join(REPO_ROOT, 'services', 'oidcService.js')
  );
  const resetDiscovery = () => {
    oidcServiceForReset._clientConfigPromise = null;
    oidcServiceForReset._clientConfigKey = null;
  };
  async function fullLogin() {
    const { tx, code, state } = await beginLogin();
    return get(
      `/auth/oidc/callback?code=${code}&state=${state}`,
      `zr_oidc_tx=${tx}`
    );
  }
  await test('client_secret_basic is the default when the provider offers it', async () => {
    resetDiscovery();
    provider.authMethods = ['client_secret_basic'];
    try {
      const res = await fullLogin();
      assert.strictEqual(res.status, 302);
      assert.strictEqual(provider.lastAuthMethod, 'client_secret_basic');
    } finally {
      provider.authMethods = ['client_secret_basic', 'client_secret_post'];
      resetDiscovery();
    }
  });

  await test('client_secret_post is used when it is all the provider lists', async () => {
    resetDiscovery();
    provider.authMethods = ['client_secret_post'];
    try {
      const res = await fullLogin();
      assert.strictEqual(res.status, 302);
      assert.strictEqual(provider.lastAuthMethod, 'client_secret_post');
    } finally {
      provider.authMethods = ['client_secret_basic', 'client_secret_post'];
      resetDiscovery();
    }
  });

  await test('OIDC_TOKEN_AUTH_METHOD overrides the automatic choice', async () => {
    process.env.OIDC_TOKEN_AUTH_METHOD = 'client_secret_post';
    try {
      const res = await fullLogin();
      assert.strictEqual(res.status, 302);
      assert.strictEqual(provider.lastAuthMethod, 'client_secret_post');
    } finally {
      delete process.env.OIDC_TOKEN_AUTH_METHOD;
    }
  });

  await test('an unknown OIDC_TOKEN_AUTH_METHOD fails the login start', async () => {
    process.env.OIDC_TOKEN_AUTH_METHOD = 'private_key_jwt';
    try {
      const res = await get('/auth/oidc/login');
      assert.strictEqual(res.status, 502);
    } finally {
      delete process.env.OIDC_TOKEN_AUTH_METHOD;
    }
  });

  await test('an issuer without the trailing slash the provider uses still works', async () => {
    process.env.OIDC_ISSUER_URL = provider.issuer.replace(/\/$/, '');
    try {
      const res = await fullLogin();
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.get('location'), '/dashboard');
    } finally {
      process.env.OIDC_ISSUER_URL = provider.issuer;
    }
  });

  await test('the full discovery URL is accepted as OIDC_ISSUER_URL', async () => {
    process.env.OIDC_ISSUER_URL = `${provider.issuer}.well-known/openid-configuration`;
    try {
      const res = await fullLogin();
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.get('location'), '/dashboard');
    } finally {
      process.env.OIDC_ISSUER_URL = provider.issuer;
    }
  });

  await test('an issuer that differs by more than a slash is refused', async () => {
    process.env.OIDC_ISSUER_URL = `${provider.base}/application/o/zr/other/`;
    try {
      const res = await get('/auth/oidc/login');
      assert.strictEqual(res.status, 502);
    } finally {
      process.env.OIDC_ISSUER_URL = provider.issuer;
    }
  });

  // ── 7. Helpers ────────────────────────────────────────────────────────────
  const oidcService = require(
    path.join(REPO_ROOT, 'services', 'oidcService.js')
  );
  const users = [{ id: 1, username: 'admin' }];

  await test('authorize() compares the e-mail case-insensitively', async () => {
    const result = oidcService.authorize(
      { email: ' ANDY@example.com ' },
      users
    );
    assert.strictEqual(result.user && result.user.id, 1);
  });

  await test('authorize() refuses when the e-mail claim is missing', async () => {
    const result = oidcService.authorize({ sub: 'x' }, users);
    assert.strictEqual(result.user, null);
    assert.match(result.error, /"email" claim/);
  });

  await test('authorize() reads OIDC_EMAIL_CLAIM', async () => {
    process.env.OIDC_EMAIL_CLAIM = 'upn';
    try {
      const result = oidcService.authorize({ upn: 'andy@example.com' }, users);
      assert.strictEqual(result.user && result.user.id, 1);
    } finally {
      delete process.env.OIDC_EMAIL_CLAIM;
    }
  });

  await test('authorize() refuses before the setup created the account', async () => {
    const result = oidcService.authorize({ email: 'andy@example.com' }, []);
    assert.strictEqual(result.user, null);
    assert.match(result.error, /setup/);
  });

  await test('getConfigErrors() names every missing setting', async () => {
    const saved = { ...process.env };
    process.env.OIDC_ISSUER_URL = '';
    process.env.OIDC_CLIENT_ID = '';
    process.env.OIDC_ADMIN_EMAIL = 'not-an-address';
    try {
      const errors = oidcService.getConfigErrors().join(' | ');
      assert.match(errors, /OIDC_ISSUER_URL/);
      assert.match(errors, /OIDC_CLIENT_ID/);
      assert.match(errors, /OIDC_ADMIN_EMAIL/);
    } finally {
      process.env.OIDC_ISSUER_URL = saved.OIDC_ISSUER_URL;
      process.env.OIDC_CLIENT_ID = saved.OIDC_CLIENT_ID;
      process.env.OIDC_ADMIN_EMAIL = saved.OIDC_ADMIN_EMAIL;
    }
  });

  await test('a redirect URI without its scheme keeps SSO off', async () => {
    process.env.OIDC_REDIRECT_URI = 'app.example.com/auth/oidc/callback';
    try {
      assert.match(
        oidcService.getConfigErrors().join(' | '),
        /OIDC_REDIRECT_URI/
      );
      assert.strictEqual(oidcService.isEnabled(), false);
      process.env.OIDC_REDIRECT_URI =
        'https://app.example.com/auth/oidc/callback';
      assert.deepStrictEqual(oidcService.getConfigErrors(), []);
    } finally {
      delete process.env.OIDC_REDIRECT_URI;
    }
  });

  await test('resolveScopes() always includes openid', async () => {
    assert.strictEqual(
      oidcService.resolveScopes({ scopes: 'openid profile email' }),
      'openid profile email'
    );
    assert.strictEqual(
      oidcService.resolveScopes({ scopes: 'profile email' }),
      'openid profile email'
    );
  });

  await test('isSafeCssColor() accepts colours and rejects anything else', async () => {
    [
      '#fff',
      '#fd4b2dcc',
      'white',
      'rgb(253, 75, 45)',
      'hsl(9 98% 58%)',
    ].forEach((value) => assert.ok(oidcService.isSafeCssColor(value), value));
    [
      'red; background: url(x)',
      'url(https://x)',
      'expression(alert(1))',
      '#ff"',
      '',
    ].forEach((value) => assert.ok(!oidcService.isSafeCssColor(value), value));
  });

  await test('resolveButtonIcon() accepts URLs and paths, "none" hides it', async () => {
    const icon = oidcService.resolveButtonIcon;
    assert.deepStrictEqual(icon(''), { type: 'default' });
    assert.deepStrictEqual(icon('none'), { type: 'none' });
    assert.deepStrictEqual(icon('/favicon.png'), {
      type: 'image',
      src: '/favicon.png',
    });
    assert.deepStrictEqual(icon('javascript:alert(1)'), { type: 'default' });
    assert.deepStrictEqual(icon('//evil.example/x.png'), { type: 'default' });
  });

  await harness.close();
  await provider.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
