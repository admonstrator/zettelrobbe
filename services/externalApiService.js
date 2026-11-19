const axios = require('axios');
const config = require('../config/config');
const { validateApiUrl } = require('./serviceUtils');

/*
 * EXTERNAL_API_TRANSFORM is a path into the JSON answer: names separated by
 * dots, a list position in brackets, such as `data.items[0].name`, or
 * `[0].name` when the answer itself is a list. Upstream the setting held
 * JavaScript for new Function(); this fork never runs code from it. The value
 * is matched against PATH_PATTERN and walked step by step over the answer's
 * own properties, so it cannot reach a prototype or call anything.
 */

/** A path with more steps than this is refused. */
const MAX_TRANSFORM_DEPTH = 10;
const NAME = '[\\p{L}\\p{N}_-]+';
const PATH_PATTERN = new RegExp(
  `^(?:${NAME}|\\[\\d+\\])(?:\\.${NAME}|\\[\\d+\\])*$`,
  'u'
);
const STEP_PATTERN = new RegExp(`\\[(\\d+)\\]|(${NAME})`, 'gu');
/*
 * Never a step, not even as an own key: JSON.parse turns a "__proto__" in an
 * answer into an own property.
 */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The steps of a transform path, or null when the value is not a path.
 *
 * @param {string} path - trimmed
 * @returns {Array<string|number>|null}
 */
function parsePath(path) {
  if (!PATH_PATTERN.test(path)) {
    return null;
  }
  return Array.from(path.matchAll(STEP_PATTERN), (match) =>
    match[1] !== undefined ? Number(match[1]) : match[2]
  );
}

/**
 * Follows the steps through the answer. A name step reads an own property of
 * an object or list, an index step an entry of a list; anything else is no
 * match.
 *
 * @param {unknown} data - the parsed answer
 * @param {Array<string|number>} steps
 * @returns {{ found: boolean, value?: unknown }}
 */
function walkPath(data, steps) {
  let current = data;
  for (const step of steps) {
    if (current === null || typeof current !== 'object') {
      return { found: false };
    }
    if (typeof step === 'number') {
      if (!Array.isArray(current) || step >= current.length) {
        return { found: false };
      }
    } else if (
      BLOCKED_KEYS.has(step) ||
      !Object.prototype.hasOwnProperty.call(current, step)
    ) {
      return { found: false };
    }
    current = current[step];
  }
  return { found: true, value: current };
}

/**
 * The part of the answer EXTERNAL_API_TRANSFORM points to.
 *
 * The whole answer when the setting is empty, when it is not a path (the
 * JavaScript an upstream installation may still hold, for one) and when the
 * path matches nothing. That is what every installation got while the setting
 * was never read, so a value that does not fit keeps that behaviour and says
 * so in the log.
 *
 * @param {unknown} data - the parsed answer
 * @param {unknown} transform - EXTERNAL_API_TRANSFORM
 * @returns {unknown}
 */
function applyTransform(data, transform) {
  const path = typeof transform === 'string' ? transform.trim() : '';
  if (!path) {
    return data;
  }

  const steps = parsePath(path);
  if (!steps) {
    console.warn(
      '[WARNING] EXTERNAL_API_TRANSFORM is not a path such as data.items[0].name, so the whole answer goes into the prompt'
    );
    return data;
  }
  if (steps.length > MAX_TRANSFORM_DEPTH) {
    console.warn(
      `[WARNING] EXTERNAL_API_TRANSFORM has more than ${MAX_TRANSFORM_DEPTH} steps, so the whole answer goes into the prompt`
    );
    return data;
  }

  const { found, value } = walkPath(data, steps);
  if (!found) {
    console.warn(
      `[WARNING] EXTERNAL_API_TRANSFORM "${path}" matches nothing in the answer, so the whole answer goes into the prompt`
    );
    return data;
  }
  return value;
}

/*
 * Redirects. Left to itself, axios follows up to 21 of them and checks none:
 * a public endpoint could send the request on to a private address, localhost
 * or the cloud metadata service, and a custom header such as X-Api-Key went
 * along to whatever host a redirect named. So the service follows them itself.
 * Every hop has to pass validateApiUrl with the options the entered address
 * got, before a request goes to it; an https request never continues over
 * plain http; and the configured headers go only to the origin the user
 * entered.
 */

/** Redirects followed at most; the next one is refused. */
const MAX_REDIRECTS = 5;
/** The answers that send the request on to the address in Location. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A redirect the service does not follow. */
class RedirectRefusedError extends Error {
  /**
   * @param {string} address - as addressForLog() prints it
   * @param {string} reason
   */
  constructor(address, reason) {
    super(`redirect to ${address} refused: ${reason}`);
    this.name = 'RedirectRefusedError';
  }
}

/**
 * An address for a log line: without user name, password, query string and
 * fragment, which can carry a key.
 *
 * @param {URL} url
 * @returns {string}
 */
function addressForLog(url) {
  const shown = new URL(url.href);
  shown.username = '';
  shown.password = '';
  shown.search = '';
  shown.hash = '';
  return shown.href;
}

/**
 * Sends the request and follows its redirects as described above. One
 * timeout covers the whole chain, as it did while axios followed.
 *
 * @param {{ method: string, url: string, headers: unknown, timeout: number, data?: unknown }} request
 * @param {boolean} allowPrivateIPs - EXTERNAL_API_ALLOW_PRIVATE_IPS, as for the entered address
 * @returns {Promise<{ status: number, data: unknown }>} the answer that is not a redirect
 */
async function requestCheckingRedirects(request, allowPrivateIPs) {
  const enteredOrigin = new URL(request.url).origin;
  const deadline = Date.now() + request.timeout;
  let { method, url, data } = request;

  for (let redirects = 0; ; redirects += 1) {
    const current = new URL(url);
    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0) {
      throw new Error(`timeout of ${request.timeout}ms exceeded`);
    }

    const options = {
      method,
      url,
      headers: current.origin === enteredOrigin ? request.headers : {},
      timeout: timeLeft,
      maxRedirects: 0,
      validateStatus: (status) =>
        (status >= 200 && status < 300) || REDIRECT_STATUSES.has(status),
    };
    if (data !== undefined) {
      options.data = data;
    }

    const response = await axios(options);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers?.location;
    if (!location) {
      // What axios reports for an answer it does not accept.
      const error = new Error(
        `Request failed with status code ${response.status}`
      );
      error.response = response;
      throw error;
    }

    let target;
    try {
      target = new URL(String(location), url);
    } catch {
      throw new RedirectRefusedError(String(location), 'Not a valid address');
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new RedirectRefusedError(
        addressForLog(target),
        `More than ${MAX_REDIRECTS} redirects in a row`
      );
    }
    if (current.protocol === 'https:' && target.protocol === 'http:') {
      throw new RedirectRefusedError(
        addressForLog(target),
        'An https request does not continue over http'
      );
    }
    const check = await validateApiUrl(target.href, { allowPrivateIPs });
    if (!check.valid) {
      throw new RedirectRefusedError(addressForLog(target), check.error);
    }

    // As axios did: 301 and 302 turn a POST into a GET, 303 turns anything
    // but GET and HEAD into a GET. The body stays behind.
    const verb = String(method).toUpperCase();
    if (
      ((response.status === 301 || response.status === 302) &&
        verb === 'POST') ||
      (response.status === 303 && verb !== 'GET' && verb !== 'HEAD')
    ) {
      method = 'GET';
      data = undefined;
    }
    console.debug(`[DEBUG] External API redirects to ${addressForLog(target)}`);
    url = target.href;
  }
}

/**
 * Service for fetching data from external APIs to enrich AI prompts
 */
class ExternalApiService {
  /**
   * Fetch data from the configured external API: one request, no retry.
   * @returns {Promise<unknown>} the answer, or the part EXTERNAL_API_TRANSFORM
   *   picks from it (a number or boolean as text); null when the feature is
   *   off, the address or one of its redirects is refused, or the call fails
   *   or times out, and the analysis then runs without it
   */
  async fetchData() {
    try {
      // Check if external API integration is enabled
      if (
        !config.externalApiConfig ||
        config.externalApiConfig.enabled !== 'yes'
      ) {
        console.log('[DEBUG] External API integration is disabled');
        return null;
      }

      // EXTERNAL_API_TRANSFORM reaches config as transformationTemplate, the
      // name upstream gave it. This used to read `transform`, which config
      // never had, so the setting was ignored.
      const {
        url,
        method = 'GET',
        headers = {},
        body = {},
        timeout = 5000,
        transformationTemplate: transform,
      } = config.externalApiConfig;

      if (!url) {
        console.error('[ERROR] External API URL not configured');
        return null;
      }

      // Validate URL to prevent SSRF attacks
      // Note: allowPrivateIPs is set based on environment - administrators may need internal APIs
      const allowPrivateIPs =
        process.env.EXTERNAL_API_ALLOW_PRIVATE_IPS === 'yes';
      const urlValidation = await validateApiUrl(url, { allowPrivateIPs });
      if (!urlValidation.valid) {
        console.error(
          `[ERROR] External API URL validation failed: ${urlValidation.error}`
        );
        return null;
      }

      console.log(`[DEBUG] Fetching data from external API: ${url}`);

      // Parse headers if they're a string
      let parsedHeaders = headers;
      if (typeof headers === 'string') {
        try {
          parsedHeaders = JSON.parse(headers);
        } catch (error) {
          console.error(
            '[ERROR] Failed to parse external API headers:',
            error.message
          );
          parsedHeaders = {};
        }
      }

      // Parse body if it's a string
      let parsedBody = body;
      if (typeof body === 'string' && (method === 'POST' || method === 'PUT')) {
        try {
          parsedBody = JSON.parse(body);
        } catch (error) {
          console.error(
            '[ERROR] Failed to parse external API body:',
            error.message
          );
          parsedBody = {};
        }
      }

      // Configure request options
      const options = {
        method,
        url,
        headers: parsedHeaders,
        timeout: parseInt(timeout) || 5000,
      };

      // Add request body for POST/PUT requests
      if (method === 'POST' || method === 'PUT') {
        options.data = parsedBody;
      }

      // Make the request; every redirect passes the same check as the URL
      const response = await requestCheckingRedirects(options, allowPrivateIPs);
      const data = applyTransform(response.data, transform);

      // A number or a boolean goes into the prompt as text. As a value, 0 and
      // false would read as "no data" further on and never reach the model.
      if (typeof data === 'number' || typeof data === 'boolean') {
        return String(data);
      }
      return data;
    } catch (error) {
      if (error instanceof RedirectRefusedError) {
        console.error(`[ERROR] External API ${error.message}`);
        return null;
      }
      console.error(
        '[ERROR] Failed to fetch data from external API:',
        error.message
      );
      if (error.response) {
        console.error(
          '[ERROR] API Response:',
          error.response.status,
          error.response.data
        );
      }
      return null;
    }
  }
}

module.exports = new ExternalApiService();
