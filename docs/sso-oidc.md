# Single Sign-On with OpenID Connect

Zettelrobbe can sign you in through any standards-compliant OpenID Connect (OIDC) provider, for
example Authentik, Authelia, Keycloak, Kanidm, Pocket ID, Zitadel, Microsoft Entra ID or Google.
When it is configured, the login page shows an extra button next to the password form. One click
takes you to your provider and back into Zettelrobbe.

- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Setting it up](#setting-it-up)
- [Provider examples](#provider-examples)
- [Customizing the login button](#customizing-the-login-button)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

## How it works

Zettelrobbe has exactly one account: the administrator created by the setup wizard. Single sign-on
does not add users, it is a second way to sign in to that one account.

1. You click the SSO button. Zettelrobbe sends you to your provider using the standard
   authorization code flow with PKCE (S256), `state` and `nonce`.
2. You sign in at the provider, which sends you back to `/auth/oidc/callback`.
3. Zettelrobbe exchanges the code for tokens and validates the ID token (signature, issuer,
   audience, expiry, nonce).
4. It reads the e-mail address from the `email` claim (ID token, completed from the userinfo
   endpoint) and compares it with `OIDC_ADMIN_EMAIL`, ignoring upper and lower case.
5. If they match, you are signed in as the administrator, whatever your username is at the
   provider. Any other identity is refused.

Nothing is provider-specific. Endpoints, signing keys and the supported client authentication
methods come from the provider's discovery document (`/.well-known/openid-configuration`).

The password login keeps working next to SSO, so you can still get in when the provider is down.

## Configuration

Like every Zettelrobbe setting, SSO is configured through environment variables, usually in the
`environment:` section of your `docker-compose.yml`. Single sign-on only switches on when
`OIDC_ENABLED=yes` **and** the three required values are set. If one is missing or invalid, the
button stays hidden and the log says what is missing at startup:

```text
[WARN] OIDC_ENABLED=yes but single sign-on stays off: OIDC_ADMIN_EMAIL is missing or not an e-mail address.
```

### Required

| Variable           | Example                                               | Purpose                                                                                                    |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `OIDC_ENABLED`     | `yes`                                                 | Turns single sign-on on. Default `no`                                                                      |
| `OIDC_ISSUER_URL`  | `https://auth.example.com/application/o/zettelrobbe/` | The provider's issuer URL (see [Provider examples](#provider-examples)). The full discovery URL also works |
| `OIDC_CLIENT_ID`   | `zettelrobbe`                                         | Client ID of the application registered at the provider                                                    |
| `OIDC_ADMIN_EMAIL` | `you@example.com`                                     | Your e-mail address at the provider. Only the identity with this address can sign in                       |

### Usually needed

| Variable             | Default                  | Purpose                                                                                                                                     |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `OIDC_CLIENT_SECRET` | –                        | Client secret of a confidential client. Leave empty for a public client (PKCE is always used)                                               |
| `OIDC_REDIRECT_URI`  | derived from the request | The callback URL registered at the provider: `https://<your-zettelrobbe-host>/auth/oidc/callback`. Set it explicitly behind a reverse proxy |

### Optional

| Variable                 | Default                | Purpose                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OIDC_SCOPES`            | `openid profile email` | Requested scopes. `openid` is always added. Keep `email`, it carries the address                                                                                                                                                        |
| `OIDC_EMAIL_CLAIM`       | `email`                | Claim that holds the e-mail address, for providers that put it elsewhere                                                                                                                                                                |
| `OIDC_TOKEN_AUTH_METHOD` | automatic              | How the client authenticates at the token endpoint: `client_secret_basic`, `client_secret_post` or `none`. Automatic picks `none` without a secret, otherwise `client_secret_basic` unless the provider only lists `client_secret_post` |
| `OIDC_BUTTON_TEXT`       | `Sign in with SSO`     | Label of the login button (up to 60 characters)                                                                                                                                                                                         |
| `OIDC_BUTTON_ICON`       | key icon               | Icon on the button: an `https://` image URL, a path on this server such as `/favicon.png`, or `none`                                                                                                                                    |
| `OIDC_BUTTON_COLOR`      | theme default          | Background colour of the button: `#rrggbb`, `#rgb`, a colour name, `rgb(...)` or `hsl(...)`                                                                                                                                             |
| `OIDC_BUTTON_TEXT_COLOR` | theme default          | Text colour of the button, same formats                                                                                                                                                                                                 |

`OIDC_CLIENT_SECRET` is treated like the other secrets: it is masked in the settings page and in
logs.

## Setting it up

These steps work for every provider. The [examples](#provider-examples) below fill in the
provider-specific parts.

1. **Register an application at your provider.**
   - Flow: authorization code. Client type: confidential (with a secret) or public.
   - Redirect URI: `https://<your-zettelrobbe-host>/auth/oidc/callback`, exactly as the browser
     reaches Zettelrobbe.
   - Scopes: `openid profile email`.
2. **Restrict access at the provider.** Allow only your own user (or a group with only you in it)
   to use the application. See [Security notes](#security-notes).
3. **Add the variables to your compose file.**

   ```yaml
   services:
     zettelrobbe:
       environment:
         OIDC_ENABLED: 'yes'
         OIDC_ISSUER_URL: https://auth.example.com/application/o/zettelrobbe/
         OIDC_CLIENT_ID: zettelrobbe
         OIDC_CLIENT_SECRET: ${ZETTELROBBE_OIDC_CLIENT_SECRET}
         OIDC_REDIRECT_URI: https://zettelrobbe.example.com/auth/oidc/callback
         OIDC_ADMIN_EMAIL: you@example.com
         # Optional: make the button look like your provider
         OIDC_BUTTON_TEXT: Sign in with Authentik
         OIDC_BUTTON_COLOR: '#fd4b2d'
         OIDC_BUTTON_TEXT_COLOR: white
         # Behind a reverse proxy
         TRUST_PROXY: '1'
   ```

   Keep the secret out of the compose file by putting it in the `.env` file next to it, as shown
   with `${ZETTELROBBE_OIDC_CLIENT_SECRET}`.

4. **Recreate the container** (`docker compose up -d`) and check the log for
   `[INFO] Single sign-on enabled with issuer ...`.
5. **Open the login page.** The SSO button appears below the password form.

The setup wizard has to be finished first: SSO signs in to the administrator account, so that
account must exist.

## Provider examples

### Authentik

1. **Applications → Providers → Create → OAuth2/OpenID Provider.**
   - Authorization flow: the default explicit or implicit consent flow.
   - Client type: _Confidential_. Note the client ID and secret.
   - Redirect URIs: `Strict`, `https://zettelrobbe.example.com/auth/oidc/callback`.
   - Signing key: select a certificate (for example _authentik Self-signed Certificate_).
2. **Applications → Applications → Create.** Name it, choose a slug (for example `zettelrobbe`)
   and select the provider from step 1.
3. **Restrict access:** on the application, open _Policy / Group / User Bindings_ and bind your
   user or a group. Without a binding, every Authentik user may use the application.
4. Issuer URL: `https://<authentik-host>/application/o/<slug>/`. The provider's overview page
   shows it as _OpenID Configuration Issuer_.

### Authelia

Add a client to the Authelia configuration (Authelia 4.38 or later syntax):

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: 'zettelrobbe'
        client_name: 'Zettelrobbe'
        client_secret: '$pbkdf2-sha512$310000$...' # hashed secret
        public: false
        authorization_policy: 'two_factor'
        redirect_uris:
          - 'https://zettelrobbe.example.com/auth/oidc/callback'
        scopes: ['openid', 'profile', 'email']
        require_pkce: true
        pkce_challenge_method: 'S256'
        token_endpoint_auth_method: 'client_secret_basic'
```

Issuer URL: `https://<authelia-host>`. Restrict the client with an access control rule or a
dedicated authorization policy.

### Keycloak

1. In your realm: **Clients → Create client**, type _OpenID Connect_, client ID `zettelrobbe`.
2. Turn _Client authentication_ on and keep _Standard flow_ enabled.
3. _Valid redirect URIs_: `https://zettelrobbe.example.com/auth/oidc/callback`.
4. Copy the secret from the _Credentials_ tab.

Issuer URL: `https://<keycloak-host>/realms/<realm>`.

### Other providers

| Provider           | `OIDC_ISSUER_URL`                                    | Notes                                                                                                                                                         |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kanidm             | `https://<host>/oauth2/openid/<client-id>`           | The issuer is per client                                                                                                                                      |
| Pocket ID          | `https://<pocket-id-host>`                           |                                                                                                                                                               |
| Zitadel            | `https://<instance-domain>`                          |                                                                                                                                                               |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | `email` is an optional claim in Entra ID. Add it to the token configuration, or set `OIDC_EMAIL_CLAIM=preferred_username` when the UPN is your e-mail address |
| Google             | `https://accounts.google.com`                        |                                                                                                                                                               |

Any other provider works the same way as long as it publishes a discovery document and sends the
e-mail address in the ID token or from its userinfo endpoint.

## Customizing the login button

With no customization the button is a neutral secondary button reading _Sign in with SSO_ with a
key icon. Four variables change it:

```yaml
OIDC_BUTTON_TEXT: Sign in with Authentik
OIDC_BUTTON_ICON: https://auth.example.com/media/zettelrobbe-icon.svg
OIDC_BUTTON_COLOR: '#fd4b2d'
OIDC_BUTTON_TEXT_COLOR: white
```

- `OIDC_BUTTON_ICON` accepts an `http(s)` URL or a path on the Zettelrobbe server. `none` removes
  the icon. Anything else falls back to the key icon.
- The colours accept `#rgb`, `#rrggbb` (with optional alpha), colour names, `rgb(...)` and
  `hsl(...)`. Other values are ignored and the theme colour is used. Quote hex colours in YAML,
  because `#` starts a comment.

## Security notes

- **Whoever passes the check is the administrator.** Zettelrobbe only checks that the e-mail
  address equals `OIDC_ADMIN_EMAIL`. Many providers let users change their own e-mail address, so
  always restrict the application at the provider to your own account or a group with only you in
  it.
- **MFA belongs to the provider.** An SSO login does not ask for Zettelrobbe's own TOTP code.
  Enforce MFA at the provider instead.
- **Use HTTPS.** Plain-HTTP issuers work but log a warning. Use them only on a trusted network.
- **Logging out ends the Zettelrobbe session only.** Your session at the provider stays open, so
  the next click on the SSO button signs you in again without a password prompt. Log out at the
  provider as well on a shared computer.
- The sign-in transaction (state, nonce, PKCE verifier) lives in a signed, HTTP-only cookie that
  expires after 10 minutes and can never be used as a session.
- The SSO endpoints share the login rate limit (`LOGIN_RATE_LIMIT_MAX`).

## Troubleshooting

| Symptom                                                                     | Cause and fix                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No SSO button on the login page                                             | Check the startup log for `OIDC_ENABLED=yes but single sign-on stays off: ...` and set what it names                                                                                              |
| _Single sign-on is unavailable: the identity provider could not be reached_ | Zettelrobbe could not load the discovery document. Check `OIDC_ISSUER_URL` and that the container can reach the provider (DNS, firewall, certificates). The log has the exact error               |
| The provider reports an invalid or mismatched redirect URI                  | The redirect URI must match the registered one character for character, including `https://`. Set `OIDC_REDIRECT_URI` to the full URL, and behind a reverse proxy also `TRUST_PROXY`              |
| _Single sign-on failed_ after returning from the provider                   | The token exchange failed. With `invalid_client` in the log, set `OIDC_TOKEN_AUTH_METHOD` to the method registered at the provider, and check the client secret                                   |
| _The identity provider did not send the "email" claim_                      | Add `email` to `OIDC_SCOPES` and allow that scope for the client at the provider, or point `OIDC_EMAIL_CLAIM` at the claim that holds the address                                                 |
| _This account may not sign in to Zettelrobbe_                               | The e-mail address at the provider differs from `OIDC_ADMIN_EMAIL`. The log line `[FAILED LOGIN] OIDC sign-in refused for ...` shows the address the provider sent                                |
| _Your single sign-on session expired_                                       | More than 10 minutes passed at the provider, or the browser dropped the cookie. Start again from the login page. If it keeps happening behind HTTPS, check `COOKIE_SECURE_MODE` and `TRUST_PROXY` |
| _Zettelrobbe has no administrator account yet_                              | Finish the setup wizard first                                                                                                                                                                     |
