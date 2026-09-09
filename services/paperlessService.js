// services/paperlessService.js
const axios = require('axios');
const config = require('../config/config');
const { parse, isValid, parseISO, format } = require('date-fns');
const {
  validateUrlAgainstBase,
  stripTrailingSlashes,
  createRedirectGuard,
} = require('./serviceUtils');

/** Timeout for the connectivity probe so a hanging host cannot stall a scan. */
const CONNECTION_PROBE_TIMEOUT_MS = 10000;

/** Used when PAPERLESS_REQUEST_TIMEOUT_SECONDS is unset or unreadable. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Page size for the tag cache refresh.
 *
 * Deliberately larger than the 100 the document reads here use. The tag cache
 * is an all-or-nothing read that every tag lookup in the app waits on, and
 * Paperless-ngx pages at 25 unless asked otherwise — an instance with 1331 tags
 * therefore spent 54 sequential round trips and 42 seconds rebuilding it, with
 * the dashboard statistics among the callers queued behind it. Tags are small
 * objects, so a page of them costs little. DRF clamps to its own max_page_size
 * rather than rejecting, so asking for more than a server allows is safe.
 */
const TAG_PAGE_SIZE = 1000;

/** How much of a Paperless-ngx error body may reach a log line. */
const ERROR_BODY_LOG_LIMIT = 500;

/**
 * Renders an error for a log line without the parts that carry credentials.
 *
 * `console.log(error)` on an axios error runs the object through util.inspect,
 * which prints `config.headers.Authorization` verbatim — that is how the
 * Paperless-ngx API token ended up in data/logs/logs.txt at the default log
 * level, in the very files users attach to bug reports. Only the message, the
 * transport code, the HTTP status and a bounded excerpt of the response body
 * are diagnostically useful; the error object itself and `error.config` never
 * are, so they are not rendered at all.
 *
 * @param {unknown} error
 * @returns {string} a single-line, bounded description
 */
function describeHttpError(error) {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const parts = [];
  if (error.message) {
    parts.push(`message=${error.message}`);
  }
  if (error.code) {
    parts.push(`code=${error.code}`);
  }

  const status = error.response?.status;
  if (status !== undefined && status !== null) {
    parts.push(`status=${status}`);
  }

  const data = error.response?.data;
  if (data !== undefined && data !== null) {
    let body;
    try {
      body = typeof data === 'string' ? data : JSON.stringify(data);
    } catch {
      body = '[unserializable response body]';
    }
    if (body) {
      parts.push(
        `body=${
          body.length > ERROR_BODY_LOG_LIMIT
            ? `${body.slice(0, ERROR_BODY_LOG_LIMIT)}…[truncated]`
            : body
        }`
      );
    }
  }

  return parts.length > 0 ? parts.join(' ') : 'unknown error';
}

/**
 * The deadline every request through `this.client` carries.
 *
 * Axios' own default is no timeout, and only checkConnection() ever set one —
 * so a host that accepted the connection without answering (a Paperless-ngx
 * container still booting, typically right after a restart) left the caller
 * waiting forever. That was survivable for a scan, which runs again on the next
 * tick, but not for the dashboard statistics: their single-flight slot is
 * handed to every later reader, so one pending call took the endpoint down
 * until the process was restarted.
 *
 * Read per client build rather than at module load, so a value changed through
 * the settings page applies on the next reconnect.
 */
function requestTimeoutMs() {
  const runtimeConfig = require('../config/config');
  const seconds = Number(runtimeConfig.paperless?.requestTimeoutSeconds);
  // Negative or unreadable is a typo, not a request to wait forever. 0 is the
  // documented opt-out and is what axios itself reads as "no timeout".
  if (!Number.isFinite(seconds) || seconds < 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return seconds * 1000;
}

class PaperlessService {
  constructor() {
    this.client = null;
    this.tagCache = new Map();
    this.customFieldCache = new Map();
    this.correspondentNameCache = new Map();
    this.lastTagRefresh = 0;
    this.lastCorrespondentRefresh = 0;
    this._supportsCorrespondentIdIn = null;
    this._refreshPromise = null;
    this._effectiveCountCache = null;
    this._effectiveCountCacheTtlMs = 60 * 1000;
    this._supportsTagsIdNone = null;
    this._publicBaseUrlCache = {
      value: null,
      source: null,
      expiresAt: 0,
    };
    this._publicBaseUrlCacheTtlMs = 5 * 60 * 1000;
    // Dynamic cache lifetime from config (default: 5 minutes)
    // Lazy load to avoid circular dependency
    this._cacheTTL = null;
  }

  get CACHE_LIFETIME() {
    if (this._cacheTTL === null) {
      // Re-require config at runtime to pick up dynamic configuration values without shadowing the top-level import
      const runtimeConfig = require('../config/config');
      this._cacheTTL = (runtimeConfig.tagCacheTTL || 300) * 1000; // Convert to milliseconds
    }
    return this._cacheTTL;
  }

  initialize() {
    if (!this.client && config.paperless.apiUrl && config.paperless.apiToken) {
      const baseUrl = stripTrailingSlashes(config.paperless.apiUrl);
      this.client = axios.create({
        baseURL: baseUrl + '/api',
        headers: {
          Authorization: `Token ${config.paperless.apiToken}`,
          'Content-Type': 'application/json',
        },
        timeout: requestTimeoutMs(),
        // Requests carry the Paperless API token, so redirects must not leave
        // the configured host.
        beforeRedirect: createRedirectGuard(() => baseUrl),
      });
    }
  }

  _normalizePublicBaseUrl(urlValue) {
    if (!urlValue || typeof urlValue !== 'string') {
      return null;
    }

    try {
      const parsedUrl = new URL(urlValue.trim());
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return null;
      }

      let basePath = stripTrailingSlashes(parsedUrl.pathname);
      basePath = basePath.replace(/\/api$/, '');

      return `${parsedUrl.origin}${basePath}`;
    } catch {
      return null;
    }
  }

  _extractPublicBaseUrlCandidate(settingsPayload) {
    if (!settingsPayload || typeof settingsPayload !== 'object') {
      return null;
    }

    const preferredKeys = new Set([
      'public_url',
      'site_url',
      'external_url',
      'app_url',
      'base_url',
      'paperless_url',
    ]);

    const pending = [settingsPayload];
    const visited = new Set();

    while (pending.length > 0) {
      const current = pending.shift();
      if (!current || typeof current !== 'object') {
        continue;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      for (const [key, value] of Object.entries(current)) {
        if (
          preferredKeys.has(String(key).toLowerCase()) &&
          typeof value === 'string'
        ) {
          const normalized = this._normalizePublicBaseUrl(value);
          if (normalized) {
            return normalized;
          }
        }

        if (value && typeof value === 'object') {
          pending.push(value);
        }
      }
    }

    return null;
  }

  async _discoverPublicBaseUrlFromApi() {
    this.initialize();
    if (!this.client) {
      return null;
    }

    const discoveryEndpoints = ['/ui_settings/', '/config/'];
    for (const endpoint of discoveryEndpoints) {
      try {
        const response = await this.client.get(endpoint);
        const discoveredUrl = this._extractPublicBaseUrlCandidate(
          response?.data
        );
        if (discoveredUrl) {
          return discoveredUrl;
        }
      } catch (error) {
        console.debug(
          `[DEBUG] public URL discovery failed on ${endpoint}: ${error.message}`
        );
      }
    }

    return null;
  }

  _getConfiguredPublicBaseUrlFallback() {
    const configuredApiUrl =
      this.client?.defaults?.baseURL ||
      config.paperless.apiUrl ||
      process.env.PAPERLESS_API_URL ||
      '';

    return this._normalizePublicBaseUrl(configuredApiUrl);
  }

  async getPublicBaseUrlDetails(options = {}) {
    const { forceRefresh = false } = options;
    const now = Date.now();

    if (
      !forceRefresh &&
      this._publicBaseUrlCache.value &&
      now < this._publicBaseUrlCache.expiresAt
    ) {
      return {
        url: this._publicBaseUrlCache.value,
        source: this._publicBaseUrlCache.source || 'api_url_fallback',
      };
    }

    const manualOverrideUrl = this._normalizePublicBaseUrl(
      process.env.PAPERLESS_PUBLIC_URL || ''
    );

    let resolvedPublicUrl;
    let source = 'unavailable';

    if (manualOverrideUrl) {
      resolvedPublicUrl = manualOverrideUrl;
      source = 'manual_override';
    } else {
      const discoveredPublicUrl = await this._discoverPublicBaseUrlFromApi();
      const fallbackPublicUrl = this._getConfiguredPublicBaseUrlFallback();
      resolvedPublicUrl = discoveredPublicUrl || fallbackPublicUrl || '';

      if (discoveredPublicUrl) {
        source = 'paperless_api';
      } else if (fallbackPublicUrl) {
        source = 'api_url_fallback';
      }
    }

    this._publicBaseUrlCache = {
      value: resolvedPublicUrl,
      source,
      expiresAt: now + this._publicBaseUrlCacheTtlMs,
    };

    return {
      url: resolvedPublicUrl,
      source,
    };
  }

  async getPublicBaseUrl(options = {}) {
    const details = await this.getPublicBaseUrlDetails(options);
    return details.url;
  }

  /**
   * Safely extract relative path from a pagination URL, validating against the base URL.
   * This prevents SSRF attacks by ensuring the URL origin matches the expected base.
   *
   * @param {string} nextUrl - The next URL from API response
   * @returns {string|null} The relative path if valid, null otherwise
   */
  _safeExtractRelativePath(nextUrl) {
    if (!nextUrl || !this.client?.defaults?.baseURL) {
      return null;
    }

    const validation = validateUrlAgainstBase(
      nextUrl,
      this.client.defaults.baseURL
    );
    if (!validation.valid) {
      console.error(`[ERROR] URL validation failed: ${validation.error}`);
      return null;
    }

    return validation.relativePath;
  }

  async getThumbnailImage(documentId) {
    this.initialize();
    try {
      const response = await this.client.get(
        `/documents/${documentId}/thumb/`,
        {
          responseType: 'arraybuffer',
        }
      );

      if (response.data && response.data.byteLength > 0) {
        return Buffer.from(response.data);
      }

      console.warn(`[DEBUG] No thumbnail data for document ${documentId}`);
      return null;
    } catch (error) {
      console.error(
        '[ERROR] fetching thumbnail for document %s:',
        documentId,
        error.message
      );
      if (error.response) {
        console.log('[ERROR] status:', error.response.status);
        console.log('[ERROR] headers:', error.response.headers);
      }
      return null; // Behalten Sie das return null bei, damit der Prozess weiterlaufen kann
    }
  }

  // Aktualisiert den Tag-Cache, wenn er älter als CACHE_LIFETIME ist
  async ensureTagCache() {
    const now = Date.now();
    const cacheAge = now - this.lastTagRefresh;
    if (this.tagCache.size === 0 || cacheAge > this.CACHE_LIFETIME) {
      if (this._refreshPromise) {
        return this._refreshPromise;
      }
      const ttlSeconds = Math.floor(this.CACHE_LIFETIME / 1000);
      // A cache that was never filled has no age and no expiry. Dating it from
      // the epoch reported "age: 1786738904s ... expired at: 1970-01-01" on
      // every cold start, which reads as a clock problem rather than a first
      // run.
      console.log(
        this.lastTagRefresh === 0
          ? `[DEBUG] Tag cache empty, building it (TTL: ${ttlSeconds}s)`
          : `[DEBUG] Tag cache expired (age: ${Math.floor(cacheAge / 1000)}s, TTL: ${ttlSeconds}s, expired at: ${new Date(
              this.lastTagRefresh + this.CACHE_LIFETIME
            ).toISOString()})`
      );
      // No race condition: synchronous code is never preempted in Node.js's
      // event loop, so no other call can reach here between the check above
      // and the assignment below.
      this._refreshPromise = this.refreshTagCache().finally(() => {
        this._refreshPromise = null;
      });
      return this._refreshPromise;
    }
  }

  /**
   * Manually clear the tag cache.
   * Useful for forcing a refresh after external tag modifications.
   */
  clearTagCache() {
    console.log('[DEBUG] Manually clearing tag cache...');
    this.tagCache.clear();
    this.lastTagRefresh = 0;
    console.log('[DEBUG] Tag cache cleared.');
  }

  // Lädt alle existierenden Tags
  async refreshTagCache() {
    try {
      console.log('[DEBUG] Refreshing tag cache...');
      this.tagCache.clear();
      // The page size only has to be asked for once: Paperless-ngx builds its
      // `next` link from the request URL, so every following page carries it.
      let nextUrl = `/tags/?page_size=${TAG_PAGE_SIZE}`;
      while (nextUrl) {
        const response = await this.client.get(nextUrl);

        // Validate response structure
        if (!response?.data?.results) {
          console.error(
            '[ERROR] Invalid response structure from API:',
            response?.data
          );
          break;
        }

        response.data.results.forEach((tag) => {
          this.tagCache.set(tag.name.toLowerCase(), tag);
        });

        // Safely extract relative path from next URL to prevent SSRF
        if (response.data.next) {
          nextUrl = this._safeExtractRelativePath(response.data.next);
          if (nextUrl) {
            console.log('[DEBUG] Next page URL:', nextUrl);
          }
        } else {
          nextUrl = null;
        }
      }
      this.lastTagRefresh = Date.now();
      console.log(
        `[DEBUG] Tag cache refreshed. Found ${this.tagCache.size} tags.`
      );
    } catch (error) {
      console.error('[ERROR] refreshing tag cache:', error.message);
      throw error;
    }
  }

  async initializeWithCredentials(apiUrl, apiToken) {
    const baseUrl = stripTrailingSlashes(apiUrl);
    this.client = axios.create({
      baseURL: baseUrl + '/api',
      headers: {
        Authorization: `Token ${apiToken}`,
        'Content-Type': 'application/json',
      },
      timeout: requestTimeoutMs(),
      beforeRedirect: createRedirectGuard(() => baseUrl),
    });

    // Test the connection
    try {
      await this.client.get('/');
      return true;
    } catch (error) {
      console.error(
        '[ERROR] Failed to initialize with credentials:',
        error.message
      );
      this.client = null;
      return false;
    }
  }

  async createCustomFieldSafely(fieldName, fieldType, default_currency) {
    try {
      // Try to create the field first
      const response = await this.client.post('/custom_fields/', {
        name: fieldName,
        data_type: fieldType,
        extra_data: {
          default_currency: default_currency || null,
        },
      });
      const newField = response.data;
      console.log(
        `[DEBUG] Successfully created custom field "${fieldName}" with ID ${newField.id}`
      );
      this.customFieldCache.set(fieldName.toLowerCase(), newField);
      return newField;
    } catch (error) {
      if (error.response?.status === 400) {
        await this.refreshCustomFieldCache();
        const existingField = await this.findExistingCustomField(fieldName);
        if (existingField) {
          return existingField;
        }
      }
      throw error; // When couldn't find the field, rethrow the error
    }
  }

  async getExistingCustomFields(documentId) {
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      console.log(
        '[DEBUG] Document response custom fields:',
        response.data.custom_fields
      );
      return response.data.custom_fields || [];
    } catch (error) {
      console.error('[ERROR] fetching document %s:', documentId, error.message);
      return [];
    }
  }

  async findExistingCustomField(fieldName) {
    const normalizedName = fieldName.toLowerCase();

    const cachedField = this.customFieldCache.get(normalizedName);
    if (cachedField) {
      console.log(
        `[DEBUG] Found custom field "${fieldName}" in cache with ID ${cachedField.id}`
      );
      return cachedField;
    }

    try {
      const response = await this.client.get('/custom_fields/', {
        params: {
          name__iexact: normalizedName, // Case-insensitive exact match
        },
      });

      if (response.data.results.length > 0) {
        const foundField = response.data.results[0];
        console.log(
          `[DEBUG] Found existing custom field "${fieldName}" via API with ID ${foundField.id}`
        );
        this.customFieldCache.set(normalizedName, foundField);
        return foundField;
      }
    } catch (error) {
      console.warn(
        '[ERROR] searching for custom field "%s":',
        fieldName,
        error.message
      );
    }

    return null;
  }

  async refreshCustomFieldCache() {
    try {
      console.log('[DEBUG] Refreshing custom field cache...');
      this.customFieldCache.clear();
      let nextUrl = '/custom_fields/';
      while (nextUrl) {
        const response = await this.client.get(nextUrl);

        // Validate response structure
        if (!response?.data?.results) {
          console.error(
            '[ERROR] Invalid response structure from API:',
            response?.data
          );
          break;
        }

        response.data.results.forEach((field) => {
          this.customFieldCache.set(field.name.toLowerCase(), field);
        });

        // Safely extract relative path from next URL to prevent SSRF
        if (response.data.next) {
          nextUrl = this._safeExtractRelativePath(response.data.next);
          if (nextUrl) {
            console.log('[DEBUG] Next page URL:', nextUrl);
          }
        } else {
          nextUrl = null;
        }
      }
      this.lastCustomFieldRefresh = Date.now();
      console.log(
        `[DEBUG] Custom field cache refreshed. Found ${this.customFieldCache.size} fields.`
      );
    } catch (error) {
      console.error('[ERROR] refreshing custom field cache:', error.message);
      throw error;
    }
  }

  async findExistingTag(tagName) {
    const normalizedName = tagName.toLowerCase();

    // 1. Zuerst im Cache suchen
    const cachedTag = this.tagCache.get(normalizedName);
    if (cachedTag) {
      console.log(
        `[DEBUG] Found tag "${tagName}" in cache with ID ${cachedTag.id}`
      );
      return cachedTag;
    }

    // 2. Direkte API-Suche
    try {
      const response = await this.client.get('/tags/', {
        params: {
          name__iexact: normalizedName, // Case-insensitive exact match
        },
      });

      if (response.data.results.length > 0) {
        const foundTag = response.data.results[0];
        console.log(
          `[DEBUG] Found existing tag "${tagName}" via API with ID ${foundTag.id}`
        );
        this.tagCache.set(normalizedName, foundTag);
        return foundTag;
      }
    } catch (error) {
      console.warn('[ERROR] searching for tag "%s":', tagName, error.message);
    }

    return null;
  }

  async createTagSafely(tagName) {
    const normalizedName = tagName.toLowerCase();

    try {
      // Versuche zuerst, den Tag zu erstellen
      const response = await this.client.post('/tags/', { name: tagName });
      const newTag = response.data;
      console.log(
        `[DEBUG] Successfully created tag "${tagName}" with ID ${newTag.id}`
      );
      this.tagCache.set(normalizedName, newTag);
      // Invalidate cache after creating new tag to ensure consistency
      this.lastTagRefresh = 0;
      return newTag;
    } catch (error) {
      if (error.response?.status === 400) {
        // Bei einem 400er Fehler könnte der Tag bereits existieren
        // Aktualisiere den Cache und suche erneut
        await this.refreshTagCache();

        // Suche nochmal nach dem Tag
        const existingTag = await this.findExistingTag(tagName);
        if (existingTag) {
          return existingTag;
        }
      }
      throw error; // Wenn wir den Tag nicht finden konnten, werfen wir den Fehler weiter
    }
  }

  async processTags(tagNames, options = {}) {
    try {
      this.initialize();
      await this.ensureTagCache();

      // Check if we should restrict to existing tags
      // Explicitly check options first, then env var
      const restrictToExistingTags =
        options.restrictToExistingTags === true ||
        (options.restrictToExistingTags === undefined &&
          process.env.RESTRICT_TO_EXISTING_TAGS === 'yes');

      // Input validation
      if (!tagNames) {
        console.warn('[DEBUG] No tags provided to processTags');
        return { tagIds: [], errors: [] };
      }

      // Convert to array if string is passed
      const tagsArray =
        typeof tagNames === 'string'
          ? [tagNames]
          : Array.isArray(tagNames)
            ? tagNames
            : [];

      if (tagsArray.length === 0) {
        console.warn('[DEBUG] No valid tags to process');
        return { tagIds: [], errors: [] };
      }

      const tagIds = [];
      const errors = [];
      const processedTags = new Set(); // Prevent duplicates

      console.log(
        `[DEBUG] Processing tags with restrictToExistingTags=${restrictToExistingTags}`
      );

      // Process regular tags
      for (const tagName of tagsArray) {
        if (!tagName || typeof tagName !== 'string') {
          console.warn(`[DEBUG] Skipping invalid tag name: ${tagName}`);
          errors.push({ tagName, error: 'Invalid tag name' });
          continue;
        }

        const normalizedName = tagName.toLowerCase().trim();

        // Skip empty or already processed tags
        if (!normalizedName || processedTags.has(normalizedName)) {
          continue;
        }

        try {
          // Search for existing tag first
          let tag = await this.findExistingTag(tagName);

          // If no existing tag found and restrictions are not enabled, create new one
          if (!tag && !restrictToExistingTags) {
            tag = await this.createTagSafely(tagName);
          } else if (!tag && restrictToExistingTags) {
            console.log(
              `[DEBUG] Tag "${tagName}" does not exist and restrictions are enabled, skipping`
            );
            errors.push({
              tagName,
              error: 'Tag does not exist and restrictions are enabled',
            });
            continue;
          }

          if (tag && tag.id) {
            tagIds.push(tag.id);
            processedTags.add(normalizedName);
          }
        } catch (error) {
          console.error('[ERROR] processing tag "%s":', tagName, error.message);
          errors.push({ tagName, error: error.message });
        }
      }

      // Add AI-Processed tag if enabled
      if (
        process.env.ADD_AI_PROCESSED_TAG === 'yes' &&
        process.env.AI_PROCESSED_TAG_NAME
      ) {
        try {
          const aiTagName = process.env.AI_PROCESSED_TAG_NAME;
          let aiTag = await this.findExistingTag(aiTagName);

          if (!aiTag) {
            aiTag = await this.createTagSafely(aiTagName);
          }

          if (aiTag && aiTag.id) {
            tagIds.push(aiTag.id);
          }
        } catch (error) {
          console.error(
            `[ERROR] processing AI tag "${process.env.AI_PROCESSED_TAG_NAME}":`,
            error.message
          );
          errors.push({
            tagName: process.env.AI_PROCESSED_TAG_NAME,
            error: error.message,
          });
        }
      }

      return {
        tagIds: [...new Set(tagIds)], // Remove any duplicates
        errors,
      };
    } catch (error) {
      console.error('[ERROR] in processTags:', describeHttpError(error));
      throw new Error(`[ERROR] Failed to process tags: ${error.message}`, {
        cause: error,
      });
    }
  }

  async getTags() {
    this.initialize();
    if (!this.client) {
      console.error('[DEBUG] Client not initialized');
      return [];
    }

    // Use cached tags if available and not expired
    await this.ensureTagCache();
    return Array.from(this.tagCache.values());
  }

  /**
   * Fetch tags directly from API, bypassing cache.
   * Use only when fresh data is absolutely required.
   * @deprecated Use getTags() instead for better performance
   */
  async fetchTagsFromApi() {
    this.initialize();
    if (!this.client) {
      console.error('[DEBUG] Client not initialized');
      return [];
    }

    let tags = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const params = {
          page,
          page_size: 100, // Maximale Seitengröße für effizientes Laden
          ordering: 'name', // Optional: Sortierung nach Namen
        };

        const response = await this.client.get('/tags/', { params });

        if (!response?.data?.results || !Array.isArray(response.data.results)) {
          console.error(`[DEBUG] Invalid API response on page ${page}`);
          break;
        }

        tags = tags.concat(response.data.results);
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `[DEBUG] Fetched page ${page - 1}, got ${response.data.results.length} tags. ` +
            `[DEBUG] Total so far: ${tags.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`[ERRRO] fetching tags page ${page}:`, error.message);
        if (error.response) {
          console.error('[DEBUG] Response status:', error.response.status);
          console.error('[DEBUG] Response data:', error.response.data);
        }
        break;
      }
    }

    return tags;
  }

  /**
   * `strict` decides what a failed lookup means to the caller.
   *
   * Returning 0 is right where the number is one line of an overview that is
   * worth showing anyway. It is wrong for the dashboard statistics: a zero
   * there is indistinguishable from an empty Paperless-ngx, so an unreachable
   * backend was cached and served as "you have no documents" for a full TTL —
   * with none of the staleness the page is built to report. Those callers pass
   * `strict` and get the error, so the build fails and the cache stays empty.
   *
   * @param {{strict?: boolean}} [options]
   * @returns {Promise<number>}
   */
  async getTagCount({ strict = false } = {}) {
    this.initialize();
    try {
      const response = await this.client.get('/tags/', {
        params: { count: true },
      });
      return response.data.count;
    } catch (error) {
      console.error('[ERROR] fetching tag count:', error.message);
      if (strict) throw error;
      return 0;
    }
  }

  /**
   * @param {{strict?: boolean}} [options] see getTagCount()
   * @returns {Promise<number>}
   */
  async getCorrespondentCount({ strict = false } = {}) {
    this.initialize();
    try {
      const response = await this.client.get('/correspondents/', {
        params: { count: true },
      });
      return response.data.count;
    } catch (error) {
      console.error('[ERROR] fetching correspondent count:', error.message);
      if (strict) throw error;
      return 0;
    }
  }

  async getDocumentCount() {
    this.initialize();
    try {
      const response = await this.client.get('/documents/', {
        params: { count: true },
      });
      return response.data.count;
    } catch (error) {
      console.error('[ERROR] fetching document count:', error.message);
      return 0;
    }
  }

  async getDocumentCountByParams(params = {}) {
    this.initialize();
    try {
      const response = await this.client.get('/documents/', {
        params: {
          count: true,
          ...params,
        },
      });

      return Number(response?.data?.count || 0);
    } catch (error) {
      console.error('[ERROR] fetching filtered document count:', error.message);
      throw error;
    }
  }

  async listCorrespondentsNames() {
    this.initialize();
    let allCorrespondents = [];
    let page = 1;
    let hasNextPage = true;

    try {
      while (hasNextPage) {
        const response = await this.client.get('/correspondents/', {
          params: {
            fields: 'id,name',
            count: true,
            page: page,
            page_size: 100,
          },
        });

        const { results, next } = response.data;

        // Füge die Ergebnisse der aktuellen Seite hinzu
        allCorrespondents = allCorrespondents.concat(
          results.map((correspondent) => ({
            name: correspondent.name,
            id: correspondent.id,
            document_count: correspondent.document_count,
          }))
        );

        // Prüfe, ob es eine nächste Seite gibt
        hasNextPage = next !== null;
        page++;

        // Optional: Füge eine kleine Verzögerung hinzu, um die API nicht zu überlasten
        if (hasNextPage) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      return allCorrespondents;
    } catch (error) {
      console.error('[ERROR] fetching correspondent names:', error.message);
      return [];
    }
  }

  async listDocumentTypesNames() {
    this.initialize();
    let allDocumentTypes = [];
    let page = 1;
    let hasNextPage = true;

    try {
      while (hasNextPage) {
        const response = await this.client.get('/document_types/', {
          params: {
            fields: 'id,name',
            count: true,
            page: page,
          },
        });

        const { results, next } = response.data;

        allDocumentTypes = allDocumentTypes.concat(
          results.map((docType) => ({
            name: docType.name,
            id: docType.id,
          }))
        );

        hasNextPage = next !== null;
        page++;

        if (hasNextPage) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      return allDocumentTypes;
    } catch (error) {
      console.error('[ERROR] fetching document type names:', error.message);
      return [];
    }
  }

  async listTagNames() {
    this.initialize();
    let allTags = [];
    let currentPage = 1;
    let hasMorePages = true;

    try {
      while (hasMorePages) {
        const response = await this.client.get('/tags/', {
          params: {
            fields: 'name',
            count: true,
            page: currentPage,
            page_size: 100, // Sie können die Seitengröße nach Bedarf anpassen
          },
        });

        // Füge die Tags dieser Seite zum Gesamtergebnis hinzu
        allTags = allTags.concat(
          response.data.results.map((tag) => ({
            name: tag.name,
            document_count: tag.document_count,
          }))
        );

        // Prüfe, ob es weitere Seiten gibt
        hasMorePages = response.data.next !== null;
        currentPage++;
      }

      return allTags;
    } catch (error) {
      console.error('[DEBUG] Error fetching tag names:', error.message);
      return [];
    }
  }

  parseTagList(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return [...new Set(value.map((tag) => `${tag}`.trim()).filter(Boolean))];
    }
    if (typeof value === 'string') {
      return [
        ...new Set(
          value
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean)
        ),
      ];
    }
    return [];
  }

  async resolveTagIdsByName(tagNames) {
    const normalizedTagNames = this.parseTagList(tagNames);
    if (normalizedTagNames.length === 0) {
      return [];
    }

    await this.ensureTagCache();
    const resolvedTagIds = new Set();

    for (const tagName of normalizedTagNames) {
      const tag = await this.findExistingTag(tagName);
      if (tag && Number.isInteger(Number(tag.id))) {
        resolvedTagIds.add(Number(tag.id));
      }
    }

    return [...resolvedTagIds];
  }

  filterDocumentsByExcludedTagIds(documents, excludedTagIds) {
    if (
      !Array.isArray(documents) ||
      documents.length === 0 ||
      excludedTagIds.length === 0
    ) {
      return documents;
    }

    const excludedTagSet = new Set(
      excludedTagIds.map((id) => Number(id)).filter(Number.isInteger)
    );
    if (excludedTagSet.size === 0) {
      return documents;
    }

    return documents.filter((document) => {
      if (!Array.isArray(document.tags) || document.tags.length === 0) {
        return true;
      }

      const hasExcludedTag = document.tags.some((tag) => {
        const normalizedTagId =
          typeof tag === 'object' ? Number(tag?.id) : Number(tag);
        return (
          Number.isInteger(normalizedTagId) &&
          excludedTagSet.has(normalizedTagId)
        );
      });

      return !hasExcludedTag;
    });
  }

  /**
   * Fetches the document list, one page of 100 at a time.
   *
   * `strict` decides what an incomplete answer means to the caller. The scan
   * loop can live with a short list — it runs again on the next tick — so the
   * default stays tolerant: a failed page ends the walk and whatever was
   * collected so far is returned. Reconciliation cannot: it reads the absence
   * of a document as "deleted in Paperless-ngx" and removes the local history,
   * so a 502 on page 2 or a refused connection used to look like a shrunken
   * archive and wiped rows for documents that were never gone. Those callers
   * pass `strict: true` and get an error instead of a half list: on a page
   * error, on a malformed page and on an unconfigured client.
   *
   * @param {object} [options]
   * @param {boolean} [options.applyFilters=true] - honour IGNORE_TAGS and PROCESS_PREDEFINED_DOCUMENTS/TAGS
   * @param {string} [options.fields] - comma-separated Paperless-ngx field list
   * @param {boolean} [options.strict=false] - throw instead of returning a partial list
   * @returns {Promise<Array<object>>}
   */
  async getAllDocuments(options = {}) {
    const strict = options.strict === true;

    this.initialize();
    if (!this.client) {
      console.error('[DEBUG] Client not initialized');
      if (strict) {
        throw new Error(
          'Paperless-ngx client is not configured; refusing to report an empty document list'
        );
      }
      return [];
    }

    // When applyFilters is explicitly false (e.g. called by reconciliation),
    // skip IGNORE_TAGS and PROCESS_PREDEFINED_DOCUMENTS/TAGS filters so that
    // reconciliation always compares against the true Paperless-ngx document
    // set rather than the currently-configured scan scope.
    const applyFilters = options.applyFilters !== false;

    let documents = [];
    let page = 1;
    let hasMore = true;
    const shouldFilterByTags =
      applyFilters && process.env.PROCESS_PREDEFINED_DOCUMENTS === 'yes';
    const includeTagNames = applyFilters
      ? this.parseTagList(process.env.TAGS)
      : [];
    const excludeTagNames = applyFilters
      ? this.parseTagList(process.env.IGNORE_TAGS)
      : [];
    let includeTagIds = [];
    let excludeTagIds = [];

    // Vorverarbeitung der Include-Tags, wenn Filter aktiv ist
    if (shouldFilterByTags) {
      if (includeTagNames.length === 0) {
        console.warn(
          '[DEBUG] PROCESS_PREDEFINED_DOCUMENTS is set to yes but no TAGS are defined'
        );
        return [];
      }

      includeTagIds = await this.resolveTagIdsByName(includeTagNames);

      if (includeTagIds.length === 0) {
        console.warn('[DEBUG] None of the specified tags were found');
        return [];
      }

      console.log(
        '[DEBUG] Filtering documents for include tag IDs:',
        includeTagIds
      );
    }

    if (excludeTagNames.length > 0) {
      excludeTagIds = await this.resolveTagIdsByName(excludeTagNames);
      if (excludeTagIds.length === 0) {
        console.warn(
          '[DEBUG] IGNORE_TAGS configured but no matching tags were found'
        );
      } else {
        console.log('[DEBUG] Excluding documents with tag IDs:', excludeTagIds);
      }
    }

    while (hasMore) {
      try {
        const params = {
          page,
          page_size: 100,
          fields:
            options.fields ||
            'id,title,created,created_date,added,tags,correspondent',
          ordering: 'id',
        };

        // Füge Tag-Filter hinzu, wenn Tags definiert sind
        if (shouldFilterByTags && includeTagIds.length > 0) {
          params.tags__id__in = includeTagIds.join(',');
        }

        const response = await this.client.get('/documents/', { params });

        if (!response?.data?.results || !Array.isArray(response.data.results)) {
          console.error(`[DEBUG] Invalid API response on page ${page}`);
          if (strict) {
            throw new Error(
              `Paperless-ngx returned a malformed document list on page ${page}`
            );
          }
          break;
        }

        documents = documents.concat(response.data.results);

        // `next` is only read as a boolean here, and deliberately not validated
        // against the configured base URL: behind a reverse proxy Paperless-ngx
        // builds it from the public host (https://paperless.example.com/…)
        // while this app talks to http://paperless:8000. The walk pages by
        // number, so a foreign-looking link costs nothing — rejecting it would
        // make strict callers abort forever on exactly those installations.
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `[DEBUG] Fetched page ${page - 1}, got ${response.data.results.length} documents. ` +
            `[DEBUG] Total so far: ${documents.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        if (strict) {
          throw error;
        }
        console.error(
          `[ERROR]  fetching documents page ${page}:`,
          error.message
        );
        if (error.response) {
          console.error('[ERROR] Response status:', error.response.status);
        }
        break;
      }
    }

    const filteredDocuments = this.filterDocumentsByExcludedTagIds(
      documents,
      excludeTagIds
    );
    if (excludeTagIds.length > 0) {
      console.log(
        `[DEBUG] Exclude filter removed ${documents.length - filteredDocuments.length} documents. ` +
          `[DEBUG] Remaining: ${filteredDocuments.length}`
      );
    }

    console.log(
      `[DEBUG] Finished fetching. Found ${filteredDocuments.length} documents after filtering.`
    );
    return filteredDocuments;
  }

  /**
   * Stores a computed effective document count and returns it, so every exit
   * of getEffectiveDocumentCount() populates the cache the same way.
   *
   * @param {string} cacheKey
   * @param {number} count
   * @returns {number} the count that was cached
   */
  cacheEffectiveCount(cacheKey, count) {
    this._effectiveCountCache = {
      key: cacheKey,
      count,
      expiresAt: Date.now() + this._effectiveCountCacheTtlMs,
    };
    return count;
  }

  /**
   * @param {{strict?: boolean}} [options] see getTagCount()
   * @returns {Promise<number>}
   */
  async getEffectiveDocumentCount({ strict = false } = {}) {
    const shouldFilterByTags =
      process.env.PROCESS_PREDEFINED_DOCUMENTS === 'yes';
    const includeTagNames = this.parseTagList(process.env.TAGS);
    const excludeTagNames = this.parseTagList(process.env.IGNORE_TAGS);
    const cacheKey = JSON.stringify({
      shouldFilterByTags,
      includeTagNames,
      excludeTagNames,
    });

    if (
      this._effectiveCountCache &&
      this._effectiveCountCache.key === cacheKey &&
      this._effectiveCountCache.expiresAt > Date.now()
    ) {
      return this._effectiveCountCache.count;
    }

    let includeTagIds = [];
    let excludeTagIds = [];

    // "Nothing matches" is a result like any other and must be cached too —
    // otherwise these two paths re-resolve the tag list on every call, which is
    // exactly the per-request Paperless traffic the cache exists to avoid.
    if (shouldFilterByTags) {
      if (includeTagNames.length === 0) {
        return this.cacheEffectiveCount(cacheKey, 0);
      }

      includeTagIds = await this.resolveTagIdsByName(includeTagNames);
      if (includeTagIds.length === 0) {
        return this.cacheEffectiveCount(cacheKey, 0);
      }
    }

    if (excludeTagNames.length > 0) {
      excludeTagIds = await this.resolveTagIdsByName(excludeTagNames);
    }

    const baseCountParams = {};
    if (shouldFilterByTags && includeTagIds.length > 0) {
      baseCountParams.tags__id__in = includeTagIds.join(',');
    }

    try {
      let effectiveCount;

      if (excludeTagIds.length > 0 && this._supportsTagsIdNone !== false) {
        try {
          effectiveCount = await this.getDocumentCountByParams({
            ...baseCountParams,
            tags__id__none: excludeTagIds.join(','),
          });
          this._supportsTagsIdNone = true;
        } catch (error) {
          if (error?.response?.status === 400) {
            this._supportsTagsIdNone = false;
          } else {
            throw error;
          }
        }
      }

      if (typeof effectiveCount !== 'number') {
        if (excludeTagIds.length === 0) {
          effectiveCount = await this.getDocumentCountByParams(baseCountParams);
        } else {
          const processableDocuments = await this.getAllDocuments({
            fields: 'id,tags',
          });
          effectiveCount = processableDocuments.length;
        }
      }

      return this.cacheEffectiveCount(cacheKey, effectiveCount);
    } catch (error) {
      console.error(
        '[ERROR] fetching effective document count:',
        error.message
      );
      if (strict) throw error;
      return 0;
    }
  }

  async getAllDocumentIdsScan() {
    /**
     * Get all Document IDs from the Paperless API.
     *
     * @returns    An array of all Document IDs.
     * @throws     An error if the request fails.
     * @note       This method is used to get all Document IDs for further processing.
     */
    this.initialize();
    if (!this.client) {
      console.error('[DEBUG] Client not initialized');
      return [];
    }

    let documents = [];
    let page = 1;
    let hasMore = true;
    const shouldFilterByTags =
      process.env.PROCESS_PREDEFINED_DOCUMENTS === 'yes';
    let tagIds = [];

    // Vorverarbeitung der Tags, wenn Filter aktiv ist
    if (shouldFilterByTags) {
      if (!process.env.TAGS) {
        console.warn(
          '[DEBUG] PROCESS_PREDEFINED_DOCUMENTS is set to yes but no TAGS are defined'
        );
        return [];
      }

      // Hole die Tag-IDs für die definierten Tags
      const tagNames = process.env.TAGS.split(',').map((tag) => tag.trim());
      await this.ensureTagCache();

      for (const tagName of tagNames) {
        const tag = await this.findExistingTag(tagName);
        if (tag) {
          tagIds.push(tag.id);
        }
      }

      if (tagIds.length === 0) {
        console.warn('[DEBUG] None of the specified tags were found');
        return [];
      }

      console.log('[DEBUG] Filtering documents for tag IDs:', tagIds);
    }

    while (hasMore) {
      try {
        const params = {
          page,
          page_size: 100,
          fields: 'id',
          ordering: 'id',
        };

        const response = await this.client.get('/documents/', { params });

        if (!response?.data?.results || !Array.isArray(response.data.results)) {
          console.error(`[ERROR] Invalid API response on page ${page}`);
          break;
        }

        documents = documents.concat(response.data.results);
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `[DEBUG] Fetched page ${page - 1}, got ${response.data.results.length} documents. ` +
            `[DEBUG] Total so far: ${documents.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(
          `[ERROR] fetching documents page ${page}:`,
          error.message
        );
        if (error.response) {
          console.error('[DEBUG] Response status:', error.response.status);
        }
        break;
      }
    }

    console.log(
      `[DEBUG] Finished fetching. Found ${documents.length} documents.`
    );
    return documents;
  }

  /**
   * Normalize a mixed list of IDs into unique, positive integers.
   * Guards against `Number(null) === 0`, which would otherwise turn documents
   * without a correspondent into a lookup for the non-existent ID 0.
   */
  _normalizeEntityIds(ids) {
    if (!Array.isArray(ids)) {
      return [];
    }

    const normalized = new Set();
    for (const rawId of ids) {
      const id = typeof rawId === 'object' ? Number(rawId?.id) : Number(rawId);
      if (Number.isInteger(id) && id > 0) {
        normalized.add(id);
      }
    }

    return [...normalized];
  }

  /**
   * Resolve tag IDs to names using the shared tag cache.
   *
   * The cache is keyed by tag name, so the reverse lookup is built on the fly.
   * This costs at most one paginated refresh per CACHE_LIFETIME instead of one
   * detail request per tag.
   *
   * @param   tagIds  Tag IDs to resolve.
   * @returns         A plain object mapping tag ID to tag name.
   */
  async getTagNamesByIds(tagIds = []) {
    this.initialize();
    const uniqueTagIds = this._normalizeEntityIds(tagIds);
    if (uniqueTagIds.length === 0 || !this.client) {
      return {};
    }

    try {
      await this.ensureTagCache();
    } catch (error) {
      console.error('[ERROR] resolving tag names from cache:', error.message);
      return {};
    }

    const namesById = new Map();
    for (const tag of this.tagCache.values()) {
      const id = Number(tag?.id);
      if (Number.isInteger(id) && typeof tag?.name === 'string') {
        namesById.set(id, tag.name);
      }
    }

    const resolved = {};
    for (const tagId of uniqueTagIds) {
      const name = namesById.get(tagId);
      if (name) {
        resolved[tagId] = name;
      }
    }

    return resolved;
  }

  /**
   * Resolve correspondent IDs to names, batching every cache miss into a single
   * filtered list request instead of one detail request per correspondent.
   *
   * @param   correspondentIds  Correspondent IDs to resolve.
   * @returns                   A plain object mapping correspondent ID to name.
   */
  async getCorrespondentNamesByIds(correspondentIds = []) {
    this.initialize();
    const uniqueIds = this._normalizeEntityIds(correspondentIds);
    if (uniqueIds.length === 0 || !this.client) {
      return {};
    }

    // The cache holds a whole generation of names; drop it once it is stale
    // rather than tracking a timestamp per entry.
    if (Date.now() - this.lastCorrespondentRefresh > this.CACHE_LIFETIME) {
      this.correspondentNameCache.clear();
      this.lastCorrespondentRefresh = Date.now();
    }

    const missingIds = uniqueIds.filter(
      (id) => !this.correspondentNameCache.has(id)
    );

    if (missingIds.length > 0) {
      await this._loadCorrespondentNames(missingIds);
    }

    const resolved = {};
    for (const id of uniqueIds) {
      const name = this.correspondentNameCache.get(id);
      if (name) {
        resolved[id] = name;
      }
    }

    return resolved;
  }

  /**
   * Populate the correspondent name cache for the given IDs.
   * Prefers the `id__in` filter and falls back to a full listing when the
   * Paperless-ngx instance does not support it.
   */
  async _loadCorrespondentNames(missingIds) {
    let loaded;

    if (this._supportsCorrespondentIdIn === false) {
      loaded = await this._primeCorrespondentNameCache();
    } else {
      loaded = true;
      for (let index = 0; index < missingIds.length; index += 100) {
        const chunk = missingIds.slice(index, index + 100);
        const applied = await this._fetchCorrespondentNameChunk(chunk);
        if (!applied) {
          // `id__in` is unsupported or failed - load everything once instead.
          loaded = await this._primeCorrespondentNameCache();
          break;
        }
      }

      if (loaded && this._supportsCorrespondentIdIn !== false) {
        this._supportsCorrespondentIdIn = true;
      }
    }

    // Only remember misses when the lookup itself worked. A transient network
    // error must not poison the cache for a whole TTL generation.
    if (!loaded) {
      return;
    }

    // Cache the misses too, otherwise an ID Paperless-ngx cannot resolve is
    // looked up again on every single search - which in the fallback path
    // means listing all correspondents over and over.
    for (const id of missingIds) {
      if (!this.correspondentNameCache.has(id)) {
        this.correspondentNameCache.set(id, null);
      }
    }
  }

  /**
   * Fetch one batch of correspondent names via `id__in`.
   * @returns true when the filter was honoured, false when the caller must fall back.
   */
  async _fetchCorrespondentNameChunk(chunk) {
    const requestedIds = new Set(chunk);

    try {
      const response = await this.client.get('/correspondents/', {
        params: {
          id__in: chunk.join(','),
          page_size: chunk.length,
          fields: 'id,name',
        },
      });

      const results = response?.data?.results;
      if (!Array.isArray(results)) {
        return false;
      }

      // Unknown query params are silently ignored by Paperless-ngx, which would
      // return an arbitrary page of correspondents instead of the requested
      // ones. Any unexpected ID means the filter was not applied.
      const filterHonoured = results.every((correspondent) =>
        requestedIds.has(Number(correspondent?.id))
      );
      if (!filterHonoured) {
        console.warn(
          '[DEBUG] Paperless-ngx ignored the correspondent id__in filter, falling back to a full listing'
        );
        this._supportsCorrespondentIdIn = false;
        return false;
      }

      for (const correspondent of results) {
        const id = Number(correspondent?.id);
        if (Number.isInteger(id) && typeof correspondent?.name === 'string') {
          this.correspondentNameCache.set(id, correspondent.name);
        }
      }

      return true;
    } catch (error) {
      console.error(
        '[ERROR] fetching correspondent names by id:',
        error.message
      );
      return false;
    }
  }

  /**
   * Load every correspondent name into the cache in one paginated sweep.
   * Used as the fallback path so a single search never fans out into one
   * request per correspondent.
   *
   * @returns true when the listing produced entries. `listCorrespondentsNames()`
   *          swallows its own errors and returns an empty array, so an empty
   *          result is treated as inconclusive rather than as a success.
   */
  async _primeCorrespondentNameCache() {
    try {
      const correspondents = await this.listCorrespondentsNames();
      let cached = 0;
      for (const correspondent of correspondents) {
        const id = Number(correspondent?.id);
        if (Number.isInteger(id) && typeof correspondent?.name === 'string') {
          this.correspondentNameCache.set(id, correspondent.name);
          cached += 1;
        }
      }
      return cached > 0;
    } catch (error) {
      console.error('[ERROR] priming correspondent name cache:', error.message);
      return false;
    }
  }

  async getCorrespondentNameById(correspondentId) {
    /**
     * Get the Name of a Correspondent by its ID.
     *
     * @param   id  The id of the correspondent.
     * @returns    An object holding the correspondent name, or null.
     */
    const id = Number(correspondentId);
    if (!Number.isInteger(id) || id < 1) {
      return null;
    }

    const names = await this.getCorrespondentNamesByIds([id]);
    return names[id] ? { id, name: names[id] } : null;
  }

  async getTagNameById(tagId) {
    /**
     * Get the Name of a Tag by its ID.
     *
     * @param   id  The id of the tag.
     * @returns    The name of the tag.
     */
    const id = Number(tagId);
    if (!Number.isInteger(id) || id < 1) {
      return null;
    }

    const names = await this.getTagNamesByIds([id]);
    return names[id] || null;
  }

  async getDocumentsWithTitleTagsCorrespondentCreated() {
    /**
     * Get all documents with metadata (title, tags, correspondent, created date).
     *
     * @returns    An array of documents with metadata.
     * @throws     An error if the request fails.
     * @note       This method is used to get all documents with metadata for further processing
     */

    this.initialize();
    try {
      const response = await this.client.get('/documents/', {
        params: {
          fields: 'id,title,tags,correspondent,created',
        },
      });
      return response.data.results;
    } catch (error) {
      console.error('[ERROR] fetching documents with metadata:', error.message);
      return [];
    }
  }

  async getRecentDocumentsWithMetadata(limit = 16) {
    this.initialize();

    const safeLimit = Number.isInteger(Number(limit))
      ? Math.max(1, Math.min(Number(limit), 100))
      : 16;

    try {
      const response = await this.client.get('/documents/', {
        params: {
          fields: 'id,title,tags,correspondent,created',
          page: 1,
          page_size: safeLimit,
          ordering: '-created',
        },
      });

      if (!Array.isArray(response?.data?.results)) {
        return [];
      }

      return response.data.results;
    } catch (error) {
      console.error(
        '[ERROR] fetching recent documents with metadata:',
        error.message
      );
      return [];
    }
  }

  async searchDocuments(query, limit = 100, mode = 'all') {
    this.initialize();
    if (!this.client) {
      console.error('[DEBUG] Client not initialized');
      return [];
    }

    const safeLimit = Number.isInteger(Number(limit))
      ? Math.max(1, Math.min(Number(limit), 200))
      : 100;
    const normalizedQuery = String(query || '').trim();
    const documentFields = 'id,title,tags,correspondent,created';

    try {
      // Explicit ID mode: exact lookup via GET /documents/{id}/
      if (mode === 'id') {
        const doc = await this._findDocumentById(
          normalizedQuery,
          documentFields
        );
        return doc ? [doc] : [];
      }

      const params = {
        fields: documentFields,
        page: 1,
        page_size: safeLimit,
        ordering: '-created',
      };

      if (mode === 'title') {
        params.title__icontains = normalizedQuery;
      } else if (mode === 'tags') {
        const tagIds = await this._findTagIdsByPartialName(normalizedQuery);
        if (!tagIds.length) return [];
        params.tags__id__in = tagIds.join(',');
      } else if (mode === 'correspondent') {
        const corrIds =
          await this._findCorrespondentIdsByPartialName(normalizedQuery);
        if (!corrIds.length) return [];
        params.correspondent__id__in = corrIds.join(',');
      } else {
        params.query = normalizedQuery;
      }

      // The default scope runs the Paperless-ngx full-text search, which reads
      // titles and content but never the document ID — so typing an ID found
      // nothing on every selector without an explicit ID scope. Look the ID up
      // alongside the search whenever the term could be one, and put the exact
      // hit first. The lookup is started here rather than awaited so it
      // overlaps the search and costs no wall-clock time; it resolves to null
      // instead of rejecting, so the search keeps its own error handling.
      const idLookup =
        mode === 'all'
          ? this._findDocumentById(normalizedQuery, documentFields)
          : null;

      let results = [];
      try {
        let response;
        try {
          response = await this.client.get('/documents/', { params });
        } catch (error) {
          // Full-text search needs the Paperless-ngx search index and rejects
          // malformed query syntax. Keep the selector usable by retrying with a
          // plain title filter instead of returning nothing.
          if (mode !== 'all') {
            throw error;
          }

          console.warn(
            `[DEBUG] Full-text document search failed (${error.message}), retrying with a title filter`
          );

          const fallbackParams = { ...params };
          delete fallbackParams.query;
          fallbackParams.title__icontains = normalizedQuery;
          response = await this.client.get('/documents/', {
            params: fallbackParams,
          });
        }

        results = Array.isArray(response?.data?.results)
          ? response.data.results
          : [];
      } catch (error) {
        // A broken search index takes both attempts down with it. An exact ID
        // hit does not depend on the index and is the answer the user asked
        // for, so it must survive the failure rather than be discarded on the
        // way out.
        if (mode !== 'all') {
          throw error;
        }

        console.error('[ERROR] searching documents:', error.message);
      }

      const idMatch = idLookup ? await idLookup : null;
      if (!idMatch) {
        return results;
      }

      // An exact ID hit is what the user asked for, so it leads — and it is
      // filtered out of the search results rather than appearing twice.
      return [
        idMatch,
        ...results.filter((doc) => doc?.id !== idMatch.id),
      ].slice(0, safeLimit);
    } catch (error) {
      console.error('[ERROR] searching documents:', error.message);
      return [];
    }
  }

  /* Exact document lookup shared by the ID scope and the default scope. Returns
     null for anything that is not a plain positive integer without hitting
     Paperless-ngx at all, and for a document that does not exist. A 404 is an
     ordinary answer here — only a real transport or server failure is logged. */
  async _findDocumentById(query, documentFields) {
    const normalizedQuery = String(query || '').trim();
    const id = Number.parseInt(normalizedQuery, 10);
    if (!Number.isInteger(id) || id < 1 || String(id) !== normalizedQuery) {
      return null;
    }

    try {
      // Request only the selector fields so the document content, which can be
      // megabytes on scanned files, is not transferred.
      const response = await this.client.get(`/documents/${id}/`, {
        params: { fields: documentFields },
      });
      const doc = response?.data;
      if (!doc || doc.id == null) {
        return null;
      }

      return {
        id: doc.id,
        title: doc.title,
        tags: doc.tags,
        correspondent: doc.correspondent,
        created: doc.created || doc.created_date || doc.added || null,
      };
    } catch (error) {
      if (error?.response?.status !== 404) {
        console.error(`[ERROR] searching document by id ${id}:`, error.message);
      }
      return null;
    }
  }

  async _findTagIdsByPartialName(query) {
    try {
      const response = await this.client.get('/tags/', {
        params: { name__icontains: query, page_size: 50 },
      });
      return (response.data?.results || []).map((t) => t.id);
    } catch (error) {
      console.error('[ERROR] searching tags by name:', error.message);
      return [];
    }
  }

  async _findCorrespondentIdsByPartialName(query) {
    try {
      const response = await this.client.get('/correspondents/', {
        params: { name__icontains: query, page_size: 50 },
      });
      return (response.data?.results || []).map((c) => c.id);
    } catch (error) {
      console.error('[ERROR] searching correspondents by name:', error.message);
      return [];
    }
  }

  // Aktualisierte getDocuments Methode
  async getDocuments() {
    return this.getAllDocuments();
  }

  async getDocumentContent(documentId) {
    this.initialize();
    const response = await this.client.get(`/documents/${documentId}/`);
    return response.data.content;
  }

  async getDocument(documentId) {
    this.initialize();
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      return response.data;
    } catch (error) {
      console.error('[ERROR] fetching document %s:', documentId, error.message);
      throw error;
    }
  }

  async searchForCorrespondentById(id) {
    try {
      const response = await this.client.get('/correspondents/', {
        params: {
          id: id,
        },
      });

      const results = response.data.results;

      if (results.length === 0) {
        console.log(`[DEBUG] No correspondent with "${id}" found`);
        return null;
      }

      if (results.length > 1) {
        console.log(`[DEBUG] Multiple correspondents found:`);
        results.forEach((c) => {
          console.log(`- ID: ${c.id}, Name: ${c.name}`);
        });
        return results;
      }

      // Genau ein Ergebnis gefunden
      return {
        id: results[0].id,
        name: results[0].name,
      };
    } catch (error) {
      console.error(
        '[ERROR] while seraching for existing correspondent:',
        error.message
      );
      throw error;
    }
  }

  async searchForExistingCorrespondent(correspondent) {
    try {
      const response = await this.client.get('/correspondents/', {
        params: {
          name__icontains: correspondent,
        },
      });

      const results = response.data.results;

      if (results.length === 0) {
        console.log(
          `[DEBUG] No correspondent with name "${correspondent}" found`
        );
        return null;
      }

      // Check for exact match in the results - thanks to @skius for the hint!
      const exactMatch = results.find(
        (c) => c.name.toLowerCase() === correspondent.toLowerCase()
      );
      if (exactMatch) {
        console.log(
          `[DEBUG] Found exact match for correspondent "${correspondent}" with ID ${exactMatch.id}`
        );
        return {
          id: exactMatch.id,
          name: exactMatch.name,
        };
      }

      // No exact match found, return null
      console.log(`[DEBUG] No exact match found for "${correspondent}"`);
      return null;
    } catch (error) {
      console.error(
        '[ERROR] while searching for existing correspondent:',
        error.message
      );
      throw error;
    }
  }

  async getOrCreateCorrespondent(name, options = {}) {
    this.initialize();

    // Check if we should restrict to existing correspondents
    // Explicitly check options first, then env var
    const restrictToExistingCorrespondents =
      options.restrictToExistingCorrespondents === true ||
      (options.restrictToExistingCorrespondents === undefined &&
        process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS === 'yes');

    console.log(
      `[DEBUG] Processing correspondent with restrictToExistingCorrespondents=${restrictToExistingCorrespondents}`
    );

    try {
      // Search for the correspondent
      const existingCorrespondent =
        await this.searchForExistingCorrespondent(name);
      console.log(
        '[DEBUG] Response Correspondent Search: ',
        existingCorrespondent
      );

      if (existingCorrespondent) {
        console.log(
          `[DEBUG] Found existing correspondent "${name}" with ID ${existingCorrespondent.id}`
        );
        return existingCorrespondent;
      }

      // If we're restricting to existing correspondents and none was found, return null
      if (restrictToExistingCorrespondents) {
        console.log(
          `[DEBUG] Correspondent "${name}" does not exist and restrictions are enabled, returning null`
        );
        return null;
      }

      // Create new correspondent only if restrictions are not enabled
      try {
        const createResponse = await this.client.post('/correspondents/', {
          name: name,
        });
        console.log(
          `[DEBUG] Created new correspondent "${name}" with ID ${createResponse.data.id}`
        );
        return createResponse.data;
      } catch (createError) {
        if (
          createError.response?.status === 400 &&
          createError.response?.data?.error?.includes('unique constraint')
        ) {
          // Race condition check - another process might have created it
          const retryResponse = await this.client.get('/correspondents/', {
            params: { name: name },
          });

          const justCreatedCorrespondent = retryResponse.data.results.find(
            (c) => c.name.toLowerCase() === name.toLowerCase()
          );

          if (justCreatedCorrespondent) {
            console.log(
              `[DEBUG] Retrieved correspondent "${name}" after constraint error with ID ${justCreatedCorrespondent.id}`
            );
            return justCreatedCorrespondent;
          }
        }
        throw createError;
      }
    } catch (error) {
      console.error(
        '[ERROR] Failed to process correspondent "%s":',
        name,
        error.message
      );
      throw error;
    }
  }

  async searchForExistingDocumentType(documentType) {
    try {
      const response = await this.client.get('/document_types/', {
        params: {
          name__icontains: documentType,
        },
      });

      const results = response.data.results;

      if (results.length === 0) {
        console.log(
          `[DEBUG] No document type with name "${documentType}" found`
        );
        return null;
      }

      // Check for exact match in the results
      const exactMatch = results.find(
        (dt) => dt.name.toLowerCase() === documentType.toLowerCase()
      );
      if (exactMatch) {
        console.log(
          `[DEBUG] Found exact match for document type "${documentType}" with ID ${exactMatch.id}`
        );
        return {
          id: exactMatch.id,
          name: exactMatch.name,
        };
      }

      // No exact match found, return null
      console.log(`[DEBUG] No exact match found for "${documentType}"`);
      return null;
    } catch (error) {
      console.error(
        '[ERROR] while searching for existing document type:',
        error.message
      );
      throw error;
    }
  }

  async getOrCreateDocumentType(name, options = {}) {
    this.initialize();

    // Explicit option value wins; otherwise fall back to env config.
    const restrictToExistingDocumentTypes =
      options.restrictToExistingDocumentTypes === true ||
      (options.restrictToExistingDocumentTypes === undefined &&
        process.env.RESTRICT_TO_EXISTING_DOCUMENT_TYPES === 'yes');

    console.log(
      `[DEBUG] Processing document type with restrictToExistingDocumentTypes=${restrictToExistingDocumentTypes}`
    );

    try {
      // Suche nach existierendem document_type
      const existingDocType = await this.searchForExistingDocumentType(name);
      console.log('[DEBUG] Response Document Type Search: ', existingDocType);

      if (existingDocType) {
        console.log(
          `[DEBUG] Found existing document type "${name}" with ID ${existingDocType.id}`
        );
        return existingDocType;
      }

      if (restrictToExistingDocumentTypes) {
        console.log(
          `[DEBUG] Document type "${name}" does not exist and restrictions are enabled, returning null`
        );
        return null;
      }

      // Erstelle neuen document_type
      try {
        const createResponse = await this.client.post('/document_types/', {
          name: name,
          matching_algorithm: 1, // 1 = ANY
          match: '', // Optional: Kann später angepasst werden
          is_insensitive: true,
        });
        console.log(
          `[DEBUG] Created new document type "${name}" with ID ${createResponse.data.id}`
        );
        return createResponse.data;
      } catch (createError) {
        if (
          createError.response?.status === 400 &&
          createError.response?.data?.error?.includes('unique constraint')
        ) {
          // Race condition check
          const retryResponse = await this.client.get('/document_types/', {
            params: { name: name },
          });

          const justCreatedDocType = retryResponse.data.results.find(
            (dt) => dt.name.toLowerCase() === name.toLowerCase()
          );

          if (justCreatedDocType) {
            console.log(
              `[DEBUG] Retrieved document type "${name}" after constraint error with ID ${justCreatedDocType.id}`
            );
            return justCreatedDocType;
          }
        }
        throw createError;
      }
    } catch (error) {
      console.error(
        `[ERROR] Failed to process document type "${name}":`,
        error.message
      );
      throw error;
    }
  }

  async removeUnusedTagsFromDocument(documentId, keepTagIds) {
    this.initialize();
    if (!this.client) return;

    try {
      console.log(
        '[DEBUG] Removing unused tags from document %s, keeping tags:',
        documentId,
        keepTagIds
      );

      // Hole aktuelles Dokument
      const currentDoc = await this.getDocument(documentId);

      // Finde Tags die entfernt werden sollen (die nicht in keepTagIds sind)
      const tagsToRemove = currentDoc.tags.filter(
        (tagId) => !keepTagIds.includes(tagId)
      );

      if (tagsToRemove.length === 0) {
        console.log('[DEBUG] No tags to remove');
        return currentDoc;
      }

      // Update das Dokument mit nur den zu behaltenden Tags
      const updateData = {
        tags: keepTagIds,
      };

      // Führe das Update durch
      await this.client.patch(`/documents/${documentId}/`, updateData);
      console.log(
        `[DEBUG] Successfully removed ${tagsToRemove.length} tags from document ${documentId}`
      );

      return await this.getDocument(documentId);
    } catch (error) {
      console.error(
        '[ERROR] Error removing unused tags from document %s:',
        documentId,
        error.message
      );
      throw error;
    }
  }

  async getTagTextFromId(tagId) {
    this.initialize();
    try {
      const response = await this.client.get(`/tags/${tagId}/`);
      return response.data.name;
    } catch (error) {
      console.error(
        `[ERROR] fetching tag text for ID ${tagId}:`,
        error.message
      );
      return null;
    }
  }

  /**
   * Lightweight probe against the configured Paperless-ngx instance.
   *
   * Used by the startup retry loop and by every scan run: most read helpers in
   * this service swallow transport errors and return empty results, which makes
   * an unreachable Paperless indistinguishable from "nothing to do". This call
   * makes that distinction explicit and never throws.
   *
   * @returns {Promise<{reachable: boolean, authorized: boolean, status: number|null, error: string|null}>}
   *   reachable: an HTTP response was received (the host answered).
   *   authorized: the API token is accepted (not 401/403).
   */
  async checkConnection() {
    this.initialize();

    if (!this.client) {
      return {
        reachable: false,
        authorized: false,
        status: null,
        error: 'Paperless-ngx client is not configured',
      };
    }

    try {
      const response = await this.client.get('/users/', {
        params: { current_user: true, page_size: 1 },
        timeout: CONNECTION_PROBE_TIMEOUT_MS,
      });

      return {
        reachable: true,
        authorized: true,
        status: response.status || 200,
        error: null,
      };
    } catch (error) {
      const status = error.response?.status ?? null;

      // A status code means the host answered, so it is reachable — only the
      // credentials or permissions may be wrong. Without a status the request
      // never got through, so authorization is unknown and reported as false.
      return {
        reachable: status !== null,
        authorized: status !== null && status !== 401 && status !== 403,
        status,
        error: error.message || 'Unknown connection error',
      };
    }
  }

  /* Resolving the own user ID used to hinge entirely on PAPERLESS_USERNAME
     matching a name in the response, and returned null without a word when it
     did not — a configured display name, a case difference or a token whose
     user cannot list other users all ended in the same silent null. The
     configured name still wins when it matches; a single-entry response is
     taken at face value (that is what current_user=true asks for), and the
     dead end says why. */
  async getOwnUserID() {
    this.initialize();
    try {
      const response = await this.client.get('/users/', {
        params: {
          current_user: true,
          full_perms: true,
        },
      });

      const users = Array.isArray(response?.data?.results)
        ? response.data.results
        : [];
      if (users.length === 0) {
        console.warn(
          '[WARN] Could not resolve own user ID: Paperless-ngx returned no users.'
        );
        return null;
      }

      const configuredUsername = String(
        process.env.PAPERLESS_USERNAME || ''
      ).trim();
      const matched = configuredUsername
        ? users.find(
            (user) =>
              String(user?.username || '')
                .trim()
                .toLowerCase() === configuredUsername.toLowerCase()
          )
        : null;

      if (matched?.id != null) {
        console.log(`[DEBUG] Found own user ID: ${matched.id}`);
        return matched.id;
      }

      if (users.length === 1 && users[0]?.id != null) {
        console.log(
          `[DEBUG] Found own user ID: ${users[0].id} (current user, no PAPERLESS_USERNAME match)`
        );
        return users[0].id;
      }

      console.warn(
        `[WARN] Could not resolve own user ID: ${users.length} user(s) returned and none matches ` +
          `PAPERLESS_USERNAME (${configuredUsername || 'not set'}).`
      );
      return null;
    } catch (error) {
      console.error('[ERROR] fetching own user ID:', error.message);
      return null;
    }
  }
  //Remove if not needed?
  async getOwnerOfDocument(documentId) {
    this.initialize();
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      return response.data.owner;
    } catch (error) {
      console.error(
        `[ERROR] fetching owner of document ${documentId}:`,
        error.message
      );
      return null;
    }
  }

  // Checks if the document is accessable by the current user
  async getPermissionOfDocument(documentId) {
    this.initialize();
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      return response.data.user_can_change;
    } catch (error) {
      console.error(
        `[ERROR] No Permission to edit document ${documentId}:`,
        error.message
      );
      return null;
    }
  }

  async updateDocument(documentId, updates) {
    this.initialize();
    if (!this.client) return;
    try {
      const currentDoc = await this.getDocument(documentId);

      if (updates.tags) {
        console.log(
          '[DEBUG] Current tags for document %s:',
          documentId,
          currentDoc.tags
        );
        console.log(`[DEBUG] Adding new tags:`, updates.tags);
        console.log(`[DEBUG] Current correspondent:`, currentDoc.correspondent);
        console.log(`[DEBUG] New correspondent:`, updates.correspondent);

        const combinedTags = [
          ...new Set([...currentDoc.tags, ...updates.tags]),
        ];
        updates.tags = combinedTags;

        console.log(`[DEBUG] Combined tags:`, combinedTags);
      }

      if (
        updates.correspondent === null ||
        updates.correspondent === undefined
      ) {
        // Keep existing correspondent when no new value is provided
        delete updates.correspondent;
      }

      let updateData;
      // Remove null/undefined dates before processing
      if (updates.created === null || updates.created === undefined) {
        delete updates.created;
      }
      try {
        if (updates.created) {
          let dateObject;

          dateObject = parseISO(updates.created);

          if (!isValid(dateObject)) {
            dateObject = parse(updates.created, 'dd.MM.yyyy', new Date());
            if (!isValid(dateObject)) {
              dateObject = parse(updates.created, 'dd-MM-yyyy', new Date());
            }
          }

          if (!isValid(dateObject)) {
            console.warn(
              `[WARN] Invalid date format: ${updates.created}, skipping date update`
            );
            delete updates.created;
          } else if (dateObject > new Date()) {
            console.warn(
              `[WARN] AI returned future date ${format(dateObject, 'yyyy-MM-dd')}, skipping date update`
            );
            delete updates.created;
          } else {
            updates.created = format(dateObject, 'yyyy-MM-dd');
          }

          updateData = { ...updates };
        } else {
          updateData = { ...updates };
        }
      } catch (error) {
        console.warn('[WARN] Error parsing date:', error.message);
        console.warn('[DEBUG] Received Date:', updates);
        delete updates.created;
        updateData = { ...updates };
      }

      // // Handle custom fields update
      // if (updateData.custom_fields) {
      //   console.log('[DEBUG] Custom fields update detected');
      //   try {
      //     // First, delete existing custom fields
      //     console.log(`[DEBUG] Deleting existing custom fields for document ${documentId}`);
      //     await this.client.delete(`/documents/${documentId}/custom_fields/`);
      //   } catch (error) {
      //     // If deletion fails, try updating with empty array first
      //     console.warn('[WARN] Could not delete custom fields, trying to clear them:', error.message);
      //     await this.client.patch(`/documents/${documentId}/`, { custom_fields: [] });
      //   }
      // }

      // Validate title length before sending to API
      if (updateData.title && updateData.title.length > 128) {
        updateData.title = updateData.title.substring(0, 124) + '…';
        console.warn(
          `[WARN] Title truncated to 128 characters for document ${documentId}`
        );
      }

      console.log('[DEBUG] Final update data:', updateData);
      await this.client.patch(`/documents/${documentId}/`, updateData);
      console.log(
        '[SUCCESS] Updated document %s with:',
        documentId,
        updateData
      );
      return await this.getDocument(documentId);
    } catch (error) {
      console.error(
        '[ERROR] updating document %s: %s',
        documentId,
        describeHttpError(error)
      );
      return null;
    }
  }

  /**
   * Restore a document to its original state (before AI processing).
   * Unlike updateDocument(), this method does NOT merge tags or skip correspondents —
   * it sends the original values directly as an exact PATCH.
   * @param {number} documentId
   * @param {{ tags?: number[], title?: string, correspondent?: number|null, documentType?: number|null, language?: string|null }} original
   */
  async restoreDocument(documentId, original) {
    this.initialize();
    if (!this.client) return null;
    try {
      const patch = {};
      if (Array.isArray(original.tags)) patch.tags = original.tags;
      if (original.title != null) patch.title = original.title;
      if (original.correspondent !== undefined)
        patch.correspondent = original.correspondent;
      if (original.documentType !== undefined)
        patch.document_type = original.documentType;
      if (original.language != null) patch.language = original.language;

      console.log(
        `[DEBUG] Restoring document ${documentId} to original state:`,
        patch
      );
      await this.client.patch(`/documents/${documentId}/`, patch);
      console.log(`[SUCCESS] Restored document ${documentId}`);
      return await this.getDocument(documentId);
    } catch (error) {
      console.error(`[ERROR] restoring document ${documentId}:`, error.message);
      return null;
    }
  }
}

const paperlessService = new PaperlessService();
// Exposed on the singleton so tests can assert what a logged error looks like
// without reaching into the module scope.
paperlessService.describeHttpError = describeHttpError;

module.exports = paperlessService;
