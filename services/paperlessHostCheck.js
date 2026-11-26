// @ts-check
'use strict';

/**
 * Recognises a Paperless-ngx that refuses the host name Zettelrobbe uses.
 *
 * Since Paperless-ngx 3.5.0 (#14735) setting PAPERLESS_URL or
 * PAPERLESS_ALLOWED_HOSTS limits Django's ALLOWED_HOSTS to those names (plus
 * localhost, 127.0.0.1 and [::1], and the host of PAPERLESS_URL). Zettelrobbe
 * usually reaches Paperless-ngx by a Docker-internal name such as
 * `paperless:8000`, which is in neither, so Django raises DisallowedHost before
 * any view runs and answers every request with HTTP 400. Without this check
 * that reads as "check the address and token".
 *
 * The signal, in order of strength:
 *   1. status 400 on a plain GET: a GET without a body cannot fail validation;
 *   2. a body that is not JSON: Django REST framework answers its own 400s in
 *      JSON, Django's error handler does not;
 *   3. the body is one of Django's two DisallowedHost pages: the production
 *      page `<title>Bad Request (400)</title>` (django/views/defaults.py
 *      bad_request(), Paperless-ngx ships no 400.html and sets no handler400)
 *      or, with PAPERLESS_DEBUG, the technical page that names the exception.
 * The third point keeps a proxy's own 400 page (nginx says
 * "400 Bad Request") from being mistaken for it.
 */

/** Django's default 400 page title, verbatim from bad_request(). */
const DJANGO_BAD_REQUEST_TITLE = /<title>\s*Bad Request \(400\)\s*<\/title>/i;

/** The technical page PAPERLESS_DEBUG renders (HTML or plain text). */
const DJANGO_DEBUG_DISALLOWED_HOST = /DisallowedHost|Invalid HTTP_HOST header/;

/**
 * @typedef {object} RefusedHost
 * @property {string} host      what the request was addressed to, port included (`paperless:8000`)
 * @property {string} hostname  what goes into PAPERLESS_ALLOWED_HOSTS (`paperless`): Django compares without the port
 */

/**
 * The host and host name of a URL, or null when it does not parse.
 *
 * @param {string|undefined|null} url
 * @returns {RefusedHost|null}
 */
function hostOfUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url));
    if (!parsed.host) return null;
    return { host: parsed.host, hostname: parsed.hostname };
  } catch {
    return null;
  }
}

/**
 * The response body as text, or null when it is (or parsed as) JSON.
 *
 * @param {unknown} data
 * @returns {string|null}
 */
function bodyText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return null;
}

/**
 * Whether a response is Django's answer to a refused host name.
 *
 * @param {{ status?: number|null, contentType?: string|null, body?: unknown }} response
 * @returns {boolean}
 */
function isDisallowedHostResponse({ status, contentType, body }) {
  if (status !== 400) return false;
  if (contentType && /json/i.test(String(contentType))) return false;
  const text = bodyText(body);
  if (text === null) return false;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  return (
    DJANGO_BAD_REQUEST_TITLE.test(text) ||
    DJANGO_DEBUG_DISALLOWED_HOST.test(text)
  );
}

/**
 * The URL whose host an axios request went to, read from its config: the
 * request's own URL when it is absolute, otherwise the client's baseURL. Only
 * the host is used, so the path is not joined.
 *
 * @param {any} config
 * @returns {string|null}
 */
function requestUrlOf(config) {
  if (!config || typeof config !== 'object') return null;
  const url = typeof config.url === 'string' ? config.url : '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
  return typeof config.baseURL === 'string' ? config.baseURL : null;
}

/**
 * The refused host when an axios error is Paperless-ngx refusing our host
 * name, otherwise null. A token problem (401/403), a timeout, a refused
 * connection or a validation error (JSON 400) all give null.
 *
 * @param {unknown} error       what axios threw
 * @param {string} [requestUrl] the URL asked, when the error carries no config
 * @returns {RefusedHost|null}
 */
function refusedHostFromError(error, requestUrl) {
  if (!error || typeof error !== 'object') return null;
  const err = /** @type {any} */ (error);
  const response = err.response;
  if (!response) return null;

  const method = err.config?.method;
  if (method && String(method).toLowerCase() !== 'get') return null;

  const headers = response.headers || {};
  const contentType =
    typeof headers.get === 'function'
      ? headers.get('content-type')
      : headers['content-type'];
  if (
    !isDisallowedHostResponse({
      status: response.status,
      contentType: contentType == null ? null : String(contentType),
      body: response.data,
    })
  ) {
    return null;
  }

  return (
    hostOfUrl(requestUrlOf(err.config)) ||
    hostOfUrl(requestUrl) || {
      host: 'the host name Zettelrobbe uses',
      hostname: '',
    }
  );
}

/**
 * What to tell a person, in one place for the setup wizard, the settings page,
 * the log and the dashboard banner.
 *
 * @param {RefusedHost} refused
 * @returns {string}
 */
function hostNotAllowedMessage(refused) {
  const name = refused.hostname || refused.host;
  return (
    `Paperless-ngx refused requests for ${refused.host} (HTTP 400). ` +
    'Since version 3.5 it only answers host names it is set up for: ' +
    `add ${name} to PAPERLESS_ALLOWED_HOSTS in the Paperless-ngx configuration ` +
    'and restart Paperless-ngx.'
  );
}

module.exports = {
  isDisallowedHostResponse,
  refusedHostFromError,
  hostNotAllowedMessage,
  hostOfUrl,
};
