/**
 * OidcService
 *
 * Single sign-on through any OpenID Connect provider (Authentik, Authelia,
 * Keycloak, Kanidm, Pocket ID, Zitadel, Entra ID, ...). It implements the
 * standard authorization code flow with PKCE, state and nonce, and nothing
 * provider-specific: endpoints and capabilities come from the provider's
 * discovery document.
 *
 * Zettelrobbe has exactly one account, the administrator created by the setup
 * wizard. SSO therefore does not provision or manage users: an identity whose
 * e-mail address equals OIDC_ADMIN_EMAIL signs in as that account, every
 * other identity is refused. Who may reach the application at all is decided
 * at the identity provider.
 *
 * The protocol work is delegated to openid-client, which validates the ID
 * token (signature, issuer, audience, expiry, nonce) and the PKCE exchange.
 */

const config = require('../config/config');

// Loaded on first use, not at startup: an install that never turns SSO on
// keeps running even on an image whose dependencies predate openid-client.
let openidClient = null;
function getOpenidClient() {
  if (!openidClient) {
    openidClient = require('openid-client');
  }
  return openidClient;
}

const CALLBACK_PATH = '/auth/oidc/callback';
const DISCOVERY_SUFFIX = '/.well-known/openid-configuration';
// Discovery and token requests should not leave a login hanging.
const REQUEST_TIMEOUT_SECONDS = 10;
const DEFAULT_BUTTON_TEXT = 'Sign in with SSO';
const MAX_BUTTON_TEXT_LENGTH = 60;

const TOKEN_AUTH_METHODS = [
  'client_secret_basic',
  'client_secret_post',
  'none',
];

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

/**
 * Light syntax check for an e-mail address: one "@", no whitespace, and a dot
 * in the domain. The address only has to be comparable with what the
 * provider sends.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isValidEmail(value) {
  const text = String(value ?? '').trim();
  return text.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/**
 * True for an absolute http(s) URL. A redirect URI without its scheme
 * ("app.example.com/auth/oidc/callback") is a common slip that every provider
 * rejects with a redirect URI error.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * The issuer URL to discover. Operators often paste the full discovery URL
 * instead of the issuer; its well-known suffix is removed.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeIssuerUrl(value) {
  const text = String(value || '').trim();
  return text.endsWith(DISCOVERY_SUFFIX)
    ? text.slice(0, -DISCOVERY_SUFFIX.length)
    : text;
}

/**
 * A colour for the login button, accepted only in plain CSS colour syntax:
 * #rgb / #rrggbb (with optional alpha), a named colour, or an rgb()/hsl()
 * function. Anything else is rejected because the value lands in a style
 * attribute.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isSafeCssColor(value) {
  const text = String(value || '').trim();
  return (
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ||
    /^[a-z]{3,30}$/i.test(text) ||
    /^(?:rgb|rgba|hsl|hsla)\([0-9a-z.,%/\s]{1,60}\)$/i.test(text)
  );
}

/**
 * The icon shown on the login button. Empty means the built-in key icon,
 * "none" hides it, and an http(s) URL or a same-origin path ("/logo.png")
 * shows that image. Anything else falls back to the built-in icon.
 *
 * @param {string} value
 * @returns {{ type: 'default'|'none'|'image', src?: string }}
 */
function resolveButtonIcon(value) {
  const text = String(value || '').trim();
  if (!text) return { type: 'default' };
  if (text.toLowerCase() === 'none') return { type: 'none' };
  if (/^\/(?!\/)\S*$/.test(text)) return { type: 'image', src: text };
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return { type: 'image', src: url.href };
    }
  } catch {
    // Not a URL; fall through to the default icon.
  }
  return { type: 'default' };
}

/**
 * Picks how the client authenticates at the token endpoint.
 *
 * OIDC_TOKEN_AUTH_METHOD wins when set. Without a client secret the client is
 * public ("none"). Otherwise client_secret_basic, the default of the OAuth 2.0
 * and OpenID Connect specifications, unless the provider's discovery document
 * lists only client_secret_post.
 *
 * @param {{ tokenAuthMethod: string, clientSecret: string }} settings
 * @param {{ token_endpoint_auth_methods_supported?: string[] }} serverMetadata
 * @returns {string}
 */
function selectTokenAuthMethod(settings, serverMetadata) {
  const configured = String(settings.tokenAuthMethod || '')
    .trim()
    .toLowerCase();
  if (configured) {
    if (!TOKEN_AUTH_METHODS.includes(configured)) {
      throw new Error(
        `Unsupported OIDC_TOKEN_AUTH_METHOD "${configured}". Use one of: ${TOKEN_AUTH_METHODS.join(', ')}.`
      );
    }
    return configured;
  }

  if (!settings.clientSecret) {
    return 'none';
  }

  const supported = serverMetadata?.token_endpoint_auth_methods_supported;
  if (
    Array.isArray(supported) &&
    !supported.includes('client_secret_basic') &&
    supported.includes('client_secret_post')
  ) {
    return 'client_secret_post';
  }
  return 'client_secret_basic';
}

/**
 * The scopes to request, always including "openid".
 *
 * @param {{ scopes: string }} settings
 * @returns {string}
 */
function resolveScopes(settings) {
  const scopes = String(settings.scopes || '')
    .split(/\s+/)
    .filter(Boolean);
  if (!scopes.includes('openid')) {
    scopes.unshift('openid');
  }
  return scopes.join(' ');
}

function buildClientAuthentication(client, method, clientSecret) {
  if (method === 'none') return client.None();
  if (!clientSecret) {
    throw new Error(
      `OIDC_TOKEN_AUTH_METHOD=${method} needs OIDC_CLIENT_SECRET to be set.`
    );
  }
  return method === 'client_secret_post'
    ? client.ClientSecretPost(clientSecret)
    : client.ClientSecretBasic(clientSecret);
}

class OidcService {
  constructor() {
    this._clientConfigPromise = null;
    this._clientConfigKey = null;
  }

  /** @returns {ReturnType<typeof config.getOidcConfig>} */
  getSettings() {
    return config.getOidcConfig();
  }

  /**
   * What is missing or invalid in the configuration. Empty when SSO is off or
   * fully configured.
   *
   * @returns {string[]}
   */
  getConfigErrors() {
    const settings = this.getSettings();
    if (!settings.enabled) return [];

    const errors = [];
    try {
      const issuer = new URL(normalizeIssuerUrl(settings.issuerUrl));
      if (issuer.protocol !== 'https:' && issuer.protocol !== 'http:') {
        errors.push('OIDC_ISSUER_URL must be an http(s) URL');
      }
    } catch {
      errors.push('OIDC_ISSUER_URL is missing or not a URL');
    }
    if (!settings.clientId) {
      errors.push('OIDC_CLIENT_ID is missing');
    }
    if (settings.redirectUri && !isAbsoluteHttpUrl(settings.redirectUri)) {
      errors.push(
        'OIDC_REDIRECT_URI must be an absolute URL starting with https:// or http://'
      );
    }
    if (!isValidEmail(settings.adminEmail)) {
      errors.push('OIDC_ADMIN_EMAIL is missing or not an e-mail address');
    }
    return errors;
  }

  /**
   * True when SSO is switched on and completely configured. A half-configured
   * provider is treated as off rather than shown as a button that can only
   * fail; logStatus() tells the operator why.
   *
   * @returns {boolean}
   */
  isEnabled() {
    return this.getSettings().enabled && this.getConfigErrors().length === 0;
  }

  /**
   * Logs once at startup whether SSO is active and, when it is switched on
   * but incomplete, what is missing.
   */
  logStatus() {
    const settings = this.getSettings();
    if (!settings.enabled) return;
    const errors = this.getConfigErrors();
    if (errors.length > 0) {
      console.warn(
        `[WARN] OIDC_ENABLED=yes but single sign-on stays off: ${errors.join('; ')}.`
      );
      return;
    }
    console.log(
      `[INFO] Single sign-on enabled with issuer ${normalizeIssuerUrl(settings.issuerUrl)}`
    );
  }

  /**
   * What the login page needs to render the SSO button.
   *
   * @returns {{ enabled: boolean, text: string, icon: { type: string, src?: string }, style: string }}
   */
  getLoginButton() {
    const settings = this.getSettings();
    const text =
      settings.buttonText.slice(0, MAX_BUTTON_TEXT_LENGTH) ||
      DEFAULT_BUTTON_TEXT;
    const style = [];
    if (isSafeCssColor(settings.buttonColor)) {
      style.push(`--login-sso-bg: ${settings.buttonColor}`);
    }
    if (isSafeCssColor(settings.buttonTextColor)) {
      style.push(`--login-sso-fg: ${settings.buttonTextColor}`);
    }
    return {
      enabled: this.isEnabled(),
      text,
      icon: resolveButtonIcon(settings.buttonIcon),
      style: style.join('; '),
    };
  }

  /**
   * Discovers the provider once and reuses the result. The cache is keyed on
   * the settings it was built from, so changed settings take effect, and a
   * failed discovery is not cached, so a provider that was down at the first
   * attempt is retried on the next login.
   *
   * @returns {Promise<import('openid-client').Configuration>}
   */
  async getClientConfig() {
    const settings = this.getSettings();
    const key = JSON.stringify([
      settings.issuerUrl,
      settings.clientId,
      settings.clientSecret,
      settings.tokenAuthMethod,
    ]);

    if (this._clientConfigPromise && this._clientConfigKey === key) {
      return this._clientConfigPromise;
    }

    this._clientConfigKey = key;
    this._clientConfigPromise = this._buildClientConfig(settings).catch(
      (error) => {
        if (this._clientConfigKey === key) {
          this._clientConfigPromise = null;
          this._clientConfigKey = null;
        }
        throw error;
      }
    );

    return this._clientConfigPromise;
  }

  /**
   * Reads the provider's discovery document and builds the client from it.
   *
   * @param {ReturnType<typeof config.getOidcConfig>} settings
   * @returns {Promise<import('openid-client').Configuration>}
   */
  async _buildClientConfig(settings) {
    const client = getOpenidClient();
    const issuer = new URL(normalizeIssuerUrl(settings.issuerUrl));
    const insecure = issuer.protocol === 'http:';
    const options = { timeout: REQUEST_TIMEOUT_SECONDS };
    if (insecure) {
      // Plain HTTP is only acceptable on a trusted network, but homelab
      // providers sometimes run that way behind the same reverse proxy.
      console.warn(
        '[WARN] OIDC_ISSUER_URL uses plain HTTP. Use HTTPS unless the provider is only reachable on a trusted network.'
      );
      options.execute = [client.allowInsecureRequests];
    }

    const serverMetadata = await this._discover(
      client,
      issuer,
      settings,
      options
    );
    const authMethod = selectTokenAuthMethod(settings, serverMetadata);

    const clientConfig = new client.Configuration(
      serverMetadata,
      settings.clientId,
      undefined,
      buildClientAuthentication(client, authMethod, settings.clientSecret)
    );
    clientConfig.timeout = REQUEST_TIMEOUT_SECONDS;
    if (insecure) {
      client.allowInsecureRequests(clientConfig);
    }
    return clientConfig;
  }

  /**
   * Runs discovery and returns the provider metadata. OpenID Connect demands
   * that the configured issuer equals the advertised one character for
   * character, and providers disagree on the trailing slash (Authentik has
   * one, Keycloak and Authelia do not). A mismatch that is only that slash is
   * retried with the provider's spelling instead of failing the login.
   *
   * @returns {Promise<object>}
   */
  async _discover(client, issuer, settings, options) {
    try {
      const discovered = await client.discovery(
        issuer,
        settings.clientId,
        undefined,
        undefined,
        options
      );
      return discovered.serverMetadata();
    } catch (error) {
      const advertised = error?.cause?.body?.issuer;
      const differsOnlyBySlash =
        error?.code === 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED' &&
        typeof advertised === 'string' &&
        stripTrailingSlash(advertised) === stripTrailingSlash(issuer.href);
      if (!differsOnlyBySlash) {
        throw error;
      }
      const discovered = await client.discovery(
        new URL(advertised),
        settings.clientId,
        undefined,
        undefined,
        options
      );
      return discovered.serverMetadata();
    }
  }

  /**
   * The redirect URI registered with the provider. OIDC_REDIRECT_URI wins;
   * otherwise it is derived from the request, which honours TRUST_PROXY for
   * the protocol and host when the app runs behind a reverse proxy.
   *
   * @param {import('express').Request} req
   * @returns {string}
   */
  resolveRedirectUri(req) {
    const settings = this.getSettings();
    if (settings.redirectUri) {
      return settings.redirectUri;
    }
    return `${req.protocol}://${req.get('host')}${CALLBACK_PATH}`;
  }

  /**
   * Builds the provider's authorization URL and the values the callback must
   * check it against.
   *
   * @param {import('express').Request} req
   * @returns {Promise<{ url: string, transaction: { state: string, nonce: string, codeVerifier: string, redirectUri: string } }>}
   */
  async startLogin(req) {
    const client = getOpenidClient();
    const settings = this.getSettings();
    const clientConfig = await this.getClientConfig();
    const redirectUri = this.resolveRedirectUri(req);

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    const url = client.buildAuthorizationUrl(clientConfig, {
      redirect_uri: redirectUri,
      scope: resolveScopes(settings),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    return {
      url: url.href,
      transaction: { state, nonce, codeVerifier, redirectUri },
    };
  }

  /**
   * Exchanges the authorization code and returns the user's claims: the
   * validated ID token claims, completed from the userinfo endpoint where the
   * provider offers one (some providers keep the e-mail out of the ID token).
   *
   * @param {URLSearchParams|string} callbackQuery - the query string the provider redirected back with
   * @param {{ state: string, nonce: string, codeVerifier: string, redirectUri: string }} transaction
   * @returns {Promise<object>}
   */
  async completeLogin(callbackQuery, transaction) {
    const client = getOpenidClient();
    const clientConfig = await this.getClientConfig();

    // Rebuild the callback URL from the redirect URI that was sent to the
    // provider rather than from the incoming request: openid-client sends
    // this URL (minus the query) as redirect_uri in the token request, and it
    // must match the authorization request exactly, whatever a reverse proxy
    // did to the Host header in between.
    const currentUrl = new URL(transaction.redirectUri);
    currentUrl.search = new URLSearchParams(callbackQuery).toString();

    const tokens = await client.authorizationCodeGrant(
      clientConfig,
      currentUrl,
      {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      }
    );

    const idClaims = tokens.claims() || {};
    let userInfo = {};
    if (clientConfig.serverMetadata().userinfo_endpoint) {
      try {
        userInfo = await client.fetchUserInfo(
          clientConfig,
          tokens.access_token,
          idClaims.sub
        );
      } catch (error) {
        // The ID token alone may be enough; userinfo only adds claims.
        console.warn(
          '[WARN] OIDC userinfo request failed, continuing with ID token claims:',
          error.message
        );
      }
    }

    // The ID token is authoritative for anything it carries.
    return { ...userInfo, ...idClaims };
  }

  /**
   * Decides whether an identity may sign in. Pure: it only looks at the
   * claims and the given list of local users.
   *
   * The e-mail claim (OIDC_EMAIL_CLAIM, default "email") must equal
   * OIDC_ADMIN_EMAIL, ignoring case. The identity then signs in as the one
   * local account, whatever its username.
   *
   * @param {object} claims - the user's claims from completeLogin()
   * @param {Array<{ id: number, username: string }>} users - local accounts
   * @returns {{ user: object|null, email: string|null, error: string|null }}
   */
  authorize(claims, users) {
    const settings = this.getSettings();
    const value = claims ? claims[settings.emailClaim] : undefined;
    const email = typeof value === 'string' && value.trim() ? value.trim() : '';

    if (!email) {
      return {
        user: null,
        email: null,
        error: `The identity provider did not send the "${settings.emailClaim}" claim. Request the "email" scope (OIDC_SCOPES) or set OIDC_EMAIL_CLAIM.`,
      };
    }

    if (email.toLowerCase() !== settings.adminEmail.toLowerCase()) {
      return {
        user: null,
        email,
        error:
          'This account may not sign in to Zettelrobbe. Its e-mail address does not match OIDC_ADMIN_EMAIL.',
      };
    }

    const user = Array.isArray(users) && users.length > 0 ? users[0] : null;
    if (!user) {
      return {
        user: null,
        email,
        error:
          'Zettelrobbe has no administrator account yet. Finish the setup first.',
      };
    }

    return { user, email, error: null };
  }
}

module.exports = new OidcService();
module.exports.CALLBACK_PATH = CALLBACK_PATH;
module.exports.isValidEmail = isValidEmail;
module.exports.isSafeCssColor = isSafeCssColor;
module.exports.normalizeIssuerUrl = normalizeIssuerUrl;
module.exports.resolveButtonIcon = resolveButtonIcon;
module.exports.resolveScopes = resolveScopes;
module.exports.selectTokenAuthMethod = selectTokenAuthMethod;
