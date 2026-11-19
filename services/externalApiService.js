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

/**
 * Service for fetching data from external APIs to enrich AI prompts
 */
class ExternalApiService {
  /**
   * Fetch data from the configured external API: one request, no retry.
   * @returns {Promise<unknown>} the answer, or the part EXTERNAL_API_TRANSFORM
   *   picks from it (a number or boolean as text); null when the feature is
   *   off, the address is refused, or the call fails or times out, and the
   *   analysis then runs without it
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

      // Make the request
      const response = await axios(options);
      const data = applyTransform(response.data, transform);

      // A number or a boolean goes into the prompt as text. As a value, 0 and
      // false would read as "no data" further on and never reach the model.
      if (typeof data === 'number' || typeof data === 'boolean') {
        return String(data);
      }
      return data;
    } catch (error) {
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
