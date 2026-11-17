/**
 * Settings › Single sign-on: the connection test, copying the redirect URI and
 * the live preview of the login button.
 *
 * The fields themselves are ordinary members of the settings form and are
 * saved with it; nothing here writes configuration.
 */

const DEFAULT_BUTTON_TEXT = 'Sign in with SSO';
const CALLBACK_PATH = '/auth/oidc/callback';

/** The colour syntax services/oidcService.js accepts for the button. */
export function isSafeCssColor(value) {
  const text = String(value || '').trim();
  return (
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ||
    /^[a-z]{3,30}$/i.test(text) ||
    /^(?:rgb|rgba|hsl|hsla)\([0-9a-z.,%/\s]{1,60}\)$/i.test(text)
  );
}

/** Mirrors resolveButtonIcon() in services/oidcService.js. */
export function resolveButtonIcon(value) {
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
    // Not a URL; the login page shows the default icon then.
  }
  return { type: 'default' };
}

export default function settingsSso(root, { toast }) {
  const $ = (selector) => root.querySelector(selector);
  const field = (id) => document.getElementById(id);

  /* --- redirect URI -------------------------------------------------------- */
  const redirect = field('oidcRedirectUri');
  if (redirect && !redirect.dataset.detected) {
    // Rendered without the route's derived value: this page's own origin is
    // what the server derives from the same request.
    redirect.dataset.detected = `${window.location.origin}${CALLBACK_PATH}`;
    redirect.placeholder = redirect.dataset.detected;
  }

  const copyButton = $('[data-el="copy-redirect"]');
  if (copyButton && redirect) {
    copyButton.addEventListener('click', async () => {
      const value = redirect.value.trim() || redirect.dataset.detected || '';
      try {
        await navigator.clipboard.writeText(value);
        toast(`Copied ${value}`, { tone: 'ok' });
      } catch {
        // No clipboard (plain http, or permission refused): select the text so
        // it can be copied by hand.
        redirect.focus();
        if (!redirect.value) redirect.value = value;
        redirect.select();
        toast('Copy it from the selected field.', { tone: 'warn' });
      }
    });
  }

  /* --- connection test ------------------------------------------------------ */
  const testButton = $('[data-el="test"]');
  const testResult = $('[data-el="test-result"]');

  function showResult(tone, title, lines) {
    if (!testResult) return;
    const icon = tone === 'ok' ? 'i-check-circle' : 'i-alert';
    const box = document.createElement('div');
    box.className = `zr-alert zr-alert--${tone === 'ok' ? 'ok' : 'danger'}`;
    box.innerHTML = `<svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#${icon}"/></svg><div class="zr-alert__body"><div class="zr-alert__title"></div></div>`;
    box.querySelector('.zr-alert__title').textContent = title;
    const body = box.querySelector('.zr-alert__body');
    lines.forEach(([label, value]) => {
      const p = document.createElement('p');
      p.className = 'zr-sm';
      if (label) {
        const strong = document.createElement('span');
        strong.className = 'zr-strong';
        strong.textContent = `${label}: `;
        p.append(strong);
      }
      if (value) {
        const code = document.createElement(label ? 'code' : 'span');
        code.textContent = value;
        p.append(code);
      }
      body.append(p);
    });
    testResult.replaceChildren(box);
    testResult.classList.remove('hidden');
  }

  async function runTest() {
    const issuerUrl = (field('oidcIssuerUrl')?.value || '').trim();
    if (!issuerUrl) {
      showResult('danger', 'Nothing to test yet', [
        ['', 'Enter the issuer URL of your provider first.'],
      ]);
      field('oidcIssuerUrl')?.focus();
      return;
    }

    const payload = {
      issuerUrl,
      clientId: (field('oidcClientId')?.value || '').trim(),
      // Empty asks the server to use the stored secret, which it does only for
      // the issuer it was stored for.
      clientSecret: field('oidcClientSecret')?.value || '',
      tokenAuthMethod: field('oidcTokenAuthMethod')?.value || '',
      // The URI a login would send: the typed one, else the detected one.
      redirectUri:
        (redirect?.value || '').trim() || redirect?.dataset.detected || '',
    };

    const label = testButton.querySelector('span');
    const original = label ? label.textContent : '';
    testButton.disabled = true;
    testButton.querySelector('.zr-icon')?.classList.add('zr-icon--spin');
    if (label) label.textContent = 'Testing…';

    try {
      const response = await fetch('/api/settings/oidc/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const isJson = /application\/json/i.test(
        response.headers.get('content-type') || ''
      );
      const result = isJson ? await response.json().catch(() => null) : null;

      // An ended session answers with a redirect to /login, which fetch
      // follows: the reply is the login page, not JSON. session-guard.js
      // already sends the browser there; this only says why.
      if (
        response.redirected ||
        response.status === 401 ||
        (!result && response.ok)
      ) {
        showResult('danger', 'Session expired', [
          ['', 'Your session has ended. Sign in again and repeat the test.'],
        ]);
        return;
      }
      if (!result) {
        showResult('danger', 'The test could not run', [
          ['', `The server answered with HTTP ${response.status}.`],
        ]);
        return;
      }
      if (!response.ok || !result.success) {
        showResult('danger', 'The provider could not be used', [
          [
            '',
            result.error ||
              `The test failed with HTTP ${response.status}. Check the issuer URL.`,
          ],
        ]);
        return;
      }

      const data = result.data || {};
      const lines = [
        ['Issuer', data.issuer || issuerUrl],
        ['Token authentication', data.chosenAuthMethod || 'automatic'],
      ];
      if (
        Array.isArray(data.tokenAuthMethods) &&
        data.tokenAuthMethods.length
      ) {
        lines.push(['Provider offers', data.tokenAuthMethods.join(', ')]);
      }
      if (data.pkce === false) {
        lines.push([
          '',
          'The provider does not list PKCE (S256); sign-in still sends it.',
        ]);
      }
      showResult('ok', result.message || 'The provider answered', lines);
    } catch (error) {
      showResult('danger', 'The test could not run', [
        ['', error.message || 'The server did not answer.'],
      ]);
    } finally {
      testButton.disabled = false;
      testButton.querySelector('.zr-icon')?.classList.remove('zr-icon--spin');
      if (label) label.textContent = original;
    }
  }

  if (testButton) testButton.addEventListener('click', runTest);

  /* --- login button preview ------------------------------------------------- */
  const preview = $('[data-el="preview"]');
  const previewText = $('[data-el="preview-text"]');
  const previewImage = $('[data-el="preview-image"]');
  const previewDefaultIcon = $('[data-el="preview-default-icon"]');
  const previewFields = [
    'oidcButtonText',
    'oidcButtonIcon',
    'oidcButtonColor',
    'oidcButtonTextColor',
  ]
    .map(field)
    .filter(Boolean);

  function colourOf(id) {
    const value = (field(id)?.value || '').trim();
    return isSafeCssColor(value) ? value : '';
  }

  function paintSwatch(id) {
    const input = field(id);
    const swatch = root.querySelector(`[data-swatch-for="${id}"]`);
    if (!input || !swatch) return;
    const raw = input.value.trim();
    const valid = !raw || isSafeCssColor(raw);
    swatch.style.background = valid && raw ? raw : '';
    swatch.dataset.state = raw ? (valid ? 'set' : 'invalid') : 'empty';
    input.setAttribute('aria-invalid', valid ? 'false' : 'true');
  }

  function renderPreview() {
    if (!preview) return;
    const text =
      (field('oidcButtonText')?.value || '').trim().slice(0, 60) ||
      DEFAULT_BUTTON_TEXT;
    previewText.textContent = text;

    const icon = resolveButtonIcon(field('oidcButtonIcon')?.value);
    previewDefaultIcon.classList.toggle('hidden', icon.type !== 'default');
    previewImage.classList.toggle('hidden', icon.type !== 'image');
    if (icon.type === 'image') {
      previewImage.src = icon.src;
    } else {
      previewImage.removeAttribute('src');
    }

    const background = colourOf('oidcButtonColor');
    const foreground = colourOf('oidcButtonTextColor');
    if (background) preview.style.setProperty('--login-sso-bg', background);
    else preview.style.removeProperty('--login-sso-bg');
    if (foreground) preview.style.setProperty('--login-sso-fg', foreground);
    else preview.style.removeProperty('--login-sso-fg');

    paintSwatch('oidcButtonColor');
    paintSwatch('oidcButtonTextColor');
  }

  previewFields.forEach((input) => {
    input.addEventListener('input', renderPreview);
    input.addEventListener('change', renderPreview);
  });
  // A broken image URL falls back to nothing rather than a torn image icon.
  previewImage?.addEventListener('error', () =>
    previewImage.classList.add('hidden')
  );
  renderPreview();

  return {
    destroy() {
      if (testButton) testButton.removeEventListener('click', runTest);
    },
  };
}
