const path = require('path');
const fs = require('fs');
const currentDir = decodeURIComponent(process.cwd());
const envPath = path.join(currentDir, 'data', '.env');
const migratedEnvPath = path.join(currentDir, 'data', '.env.migrated');
const runtimeOverridesPath = path.join(
  currentDir,
  'data',
  'runtime-overrides.json'
);
const CONFIG_SOURCE_MODE = String(
  process.env.CONFIG_SOURCE_MODE || 'runtime-first'
)
  .trim()
  .toLowerCase();
const LEGACY_CONFIG_SOURCE_MODE = 'legacy';
// Keys baked into the Dockerfile image via ENV — these are image defaults,
// not operator-injected values, so they must never be treated as locked.
const DOCKERFILE_BAKED_KEYS = new Set([
  'NODE_ENV',
  'LOG_LEVEL',
  'ANONYMIZED_TELEMETRY',
  'PAPERLESS_AI_COMMIT_SHA',
]);
const LOG_LEVEL_WEIGHTS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const VALID_LOG_LEVELS = Object.keys(LOG_LEVEL_WEIGHTS);

/* The date formats the interface offers. A locale's own idea of the order is
   deliberately not among them: the dates sit in dense table cells without a
   label, and an unadorned 08/09 has to mean one thing whoever is reading. Both
   formats pad the month and day to two digits for the same reason — a column of
   15.08.2026 and 3.9.2026 does not scan. */
const VALID_DATE_FORMATS = ['DD.MM.YYYY', 'YYYY-MM-DD'];
const DEFAULT_DATE_FORMAT = 'DD.MM.YYYY';

const normalizeDateFormat = (value) => {
  if (!value) {
    return DEFAULT_DATE_FORMAT;
  }

  const normalized = String(value).trim().toUpperCase();
  return VALID_DATE_FORMATS.includes(normalized)
    ? normalized
    : DEFAULT_DATE_FORMAT;
};

const normalizeLogLevel = (value) => {
  if (!value) {
    return 'info';
  }

  const normalized = String(value).trim().toLowerCase();
  return VALID_LOG_LEVELS.includes(normalized) ? normalized : 'info';
};

const shouldLogAtStartup = (currentLevel, messageLevel) => {
  const currentWeight =
    LOG_LEVEL_WEIGHTS[currentLevel] || LOG_LEVEL_WEIGHTS.info;
  const messageWeight =
    LOG_LEVEL_WEIGHTS[messageLevel] || LOG_LEVEL_WEIGHTS.info;
  return messageWeight >= currentWeight;
};

const startupLog = (currentLevel, level, ...args) => {
  if (!shouldLogAtStartup(currentLevel, level)) {
    return;
  }

  if (level === 'error') {
    console.error(...args);
    return;
  }

  if (level === 'warn') {
    console.warn(...args);
    return;
  }

  if (level === 'debug') {
    console.debug(...args);
    return;
  }

  console.info(...args);
};

// A key is "protected" (operator-injected via docker-compose environment:) when
// it was present in process.env at startup AND is not a Dockerfile image default.
const isProtectedRuntimeEnvKey = (key) => {
  const k = String(key || '').trim();
  if (DOCKERFILE_BAKED_KEYS.has(k)) return false;
  const snapshot = global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ || {};
  return Object.prototype.hasOwnProperty.call(snapshot, k);
};

if (!global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__) {
  global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = { ...process.env };
}

const migrateLegacyEnvFileToRuntimeOverrides = (currentLevel) => {
  try {
    if (!fs.existsSync(envPath)) {
      return;
    }

    const rawEnvContent = fs.readFileSync(envPath, 'utf8');
    const parsedLegacyEnv = require('dotenv').parse(rawEnvContent);
    if (!parsedLegacyEnv || typeof parsedLegacyEnv !== 'object') {
      return;
    }

    let existingOverrides = {};
    if (fs.existsSync(runtimeOverridesPath)) {
      try {
        const rawOverrides = fs.readFileSync(runtimeOverridesPath, 'utf8');
        const parsedOverrides = JSON.parse(rawOverrides);
        if (parsedOverrides && typeof parsedOverrides === 'object') {
          existingOverrides = parsedOverrides;
        }
      } catch (error) {
        startupLog(
          currentLevel,
          'warn',
          '[WARN] Failed to parse existing runtime overrides before migration:',
          error.message
        );
      }
    }

    let hasChanges = false;
    const mergedOverrides = { ...existingOverrides };
    Object.entries(parsedLegacyEnv).forEach(([key, value]) => {
      if (isProtectedRuntimeEnvKey(key)) {
        return;
      }

      if (Object.prototype.hasOwnProperty.call(mergedOverrides, key)) {
        return;
      }

      const normalizedValue = value == null ? '' : String(value);
      if (!normalizedValue.trim()) {
        return;
      }

      mergedOverrides[key] = normalizedValue;
      hasChanges = true;
    });

    if (hasChanges) {
      fs.mkdirSync(path.dirname(runtimeOverridesPath), { recursive: true });
      fs.writeFileSync(
        runtimeOverridesPath,
        JSON.stringify(mergedOverrides, null, 2)
      );
      startupLog(
        currentLevel,
        'info',
        '[INFO] Migrated legacy data/.env values to runtime overrides.'
      );
    }

    fs.renameSync(envPath, migratedEnvPath);
    startupLog(
      currentLevel,
      'warn',
      '[WARN] data/.env has been migrated and renamed to data/.env.migrated.'
    );
  } catch (error) {
    startupLog(
      currentLevel,
      'warn',
      '[WARN] Failed to migrate legacy data/.env:',
      error.message
    );
  }
};

if (CONFIG_SOURCE_MODE === LEGACY_CONFIG_SOURCE_MODE) {
  require('dotenv').config({ path: envPath });
} else {
  migrateLegacyEnvFileToRuntimeOverrides('info');
}

const applyRuntimeOverrides = () => {
  try {
    if (!fs.existsSync(runtimeOverridesPath)) {
      return;
    }

    const content = fs.readFileSync(runtimeOverridesPath, 'utf8');
    const overrides = JSON.parse(content);

    if (!overrides || typeof overrides !== 'object') {
      return;
    }

    Object.entries(overrides).forEach(([key, value]) => {
      if (isProtectedRuntimeEnvKey(key)) return;
      const normalizedValue = value == null ? '' : String(value);
      if (!normalizedValue.trim()) return;
      process.env[key] = normalizedValue;
    });
  } catch (error) {
    console.error('Failed to apply runtime overrides:', error.message);
  }
};

applyRuntimeOverrides();

const requestedLogLevel = process.env.LOG_LEVEL;
const logLevel = normalizeLogLevel(requestedLogLevel);
if (
  requestedLogLevel &&
  String(requestedLogLevel).trim().toLowerCase() !== logLevel
) {
  console.warn(
    `[WARN] Invalid LOG_LEVEL "${requestedLogLevel}". Falling back to "info".`
  );
}
process.env.LOG_LEVEL = logLevel;

/* Written back onto the environment so the settings view and the .env export,
   which both read process.env directly, show the value the app actually renders
   with rather than the typo an operator left behind. */
const requestedDateFormat = process.env.DATE_FORMAT;
const dateFormat = normalizeDateFormat(requestedDateFormat);
if (
  requestedDateFormat &&
  String(requestedDateFormat).trim().toUpperCase() !== dateFormat
) {
  startupLog(
    logLevel,
    'warn',
    `[WARN] Invalid DATE_FORMAT "${requestedDateFormat}". Falling back to "${dateFormat}".`
  );
}
process.env.DATE_FORMAT = dateFormat;

if (CONFIG_SOURCE_MODE === LEGACY_CONFIG_SOURCE_MODE) {
  startupLog(logLevel, 'debug', 'Loading legacy .env from:', envPath);
} else {
  startupLog(logLevel, 'debug', 'Running in runtime-first config mode.');
}
startupLog(logLevel, 'debug', 'Runtime overrides path:', runtimeOverridesPath);

// Helper function to parse boolean-like env vars
const parseEnvBoolean = (value, defaultValue = 'yes') => {
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' ||
    value === '1' ||
    value.toLowerCase() === 'yes'
    ? 'yes'
    : 'no';
};

const parseTemperature = (value, defaultValue, envKey) => {
  const normalizedValue = String(value ?? '').trim();
  if (!normalizedValue) {
    return defaultValue;
  }

  const parsed = Number.parseFloat(normalizedValue);
  if (!Number.isFinite(parsed)) {
    startupLog(
      logLevel,
      'warn',
      `[WARN] Invalid ${envKey} value "${normalizedValue}". Falling back to ${defaultValue}.`
    );
    return defaultValue;
  }

  if (parsed < 0 || parsed > 2) {
    startupLog(
      logLevel,
      'warn',
      `[WARN] Out-of-range ${envKey} value "${normalizedValue}". Falling back to ${defaultValue}.`
    );
    return defaultValue;
  }

  return parsed;
};

/* Token counts arrive as unvalidated environment strings and used to be read
   with a bare Number() at each of the nine call sites. That was harmless while
   the value only ever entered an addition — a NaN reservation just made the
   context window NaN, which Ollama ignores. It stopped being harmless once the
   value became a generation limit: "num_predict": null is a typo away. */
const parseTokenCount = (value, defaultValue, envKey) => {
  const normalizedValue = String(value ?? '').trim();
  if (!normalizedValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(normalizedValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    startupLog(
      logLevel,
      'warn',
      `[WARN] Invalid ${envKey} value "${normalizedValue}". Falling back to ${defaultValue}.`
    );
    return defaultValue;
  }

  return parsed;
};

/* parseTokenCount() hands anything Number.parseInt() can start reading to the
   caller, so "128k" — a plausible shorthand for 128000 — parses as 128. For a
   response budget that only shortens the answer, but for the context window it
   silently shrinks the whole budget to 128 tokens and every document fails
   with "Token limit exceeded". Reject trailing garbage before delegating. */
const parseStrictTokenCount = (value, defaultValue, envKey) => {
  const normalizedValue = String(value ?? '').trim();

  if (normalizedValue && !/^[+-]?\d+$/.test(normalizedValue)) {
    startupLog(
      logLevel,
      'warn',
      `[WARN] Invalid ${envKey} value "${normalizedValue}". Falling back to ${defaultValue}.`
    );
    return defaultValue;
  }

  return parseTokenCount(normalizedValue, defaultValue, envKey);
};

const getApiKey = () =>
  process.env.API_KEY || process.env.PAPERLESS_AI_API_KEY || '';
const getJwtSecret = () => process.env.JWT_SECRET || '';

const getTrustProxy = () => {
  const trustProxy = process.env.TRUST_PROXY;

  if (typeof trustProxy === 'undefined' || trustProxy === '') {
    return false;
  }

  const normalized = trustProxy.toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  if (/^\d+$/.test(trustProxy)) {
    return parseInt(trustProxy, 10);
  }

  return trustProxy;
};

const getCookieSecureMode = () => {
  const mode = String(process.env.COOKIE_SECURE_MODE || 'auto')
    .trim()
    .toLowerCase();
  if (mode === 'always' || mode === 'never' || mode === 'auto') {
    return mode;
  }

  return 'auto';
};

// Initialize limit functions with defaults
const limitFunctions = {
  activateTagging: parseEnvBoolean(process.env.ACTIVATE_TAGGING, 'yes'),
  activateCorrespondents: parseEnvBoolean(
    process.env.ACTIVATE_CORRESPONDENTS,
    'yes'
  ),
  activateDocumentType: parseEnvBoolean(
    process.env.ACTIVATE_DOCUMENT_TYPE,
    'yes'
  ),
  activateTitle: parseEnvBoolean(process.env.ACTIVATE_TITLE, 'yes'),
  activateCustomFields: parseEnvBoolean(
    process.env.ACTIVATE_CUSTOM_FIELDS,
    'yes'
  ),
};

// Initialize AI restrictions with defaults
const aiRestrictions = {
  restrictToExistingTags: parseEnvBoolean(
    process.env.RESTRICT_TO_EXISTING_TAGS,
    'no'
  ),
  restrictToExistingCorrespondents: parseEnvBoolean(
    process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS,
    'no'
  ),
  restrictToExistingDocumentTypes: parseEnvBoolean(
    process.env.RESTRICT_TO_EXISTING_DOCUMENT_TYPES,
    'no'
  ),
};

startupLog(logLevel, 'debug', 'Loaded restriction settings:', {
  RESTRICT_TO_EXISTING_TAGS: aiRestrictions.restrictToExistingTags,
  RESTRICT_TO_EXISTING_CORRESPONDENTS:
    aiRestrictions.restrictToExistingCorrespondents,
  RESTRICT_TO_EXISTING_DOCUMENT_TYPES:
    aiRestrictions.restrictToExistingDocumentTypes,
});

// Initialize external API configuration
const externalApiConfig = {
  enabled: parseEnvBoolean(process.env.EXTERNAL_API_ENABLED, 'no'),
  url: process.env.EXTERNAL_API_URL || '',
  method: process.env.EXTERNAL_API_METHOD || 'GET',
  headers: process.env.EXTERNAL_API_HEADERS || '{}',
  body: process.env.EXTERNAL_API_BODY || '{}',
  timeout: parseInt(process.env.EXTERNAL_API_TIMEOUT || '5000', 10),
  transformationTemplate: process.env.EXTERNAL_API_TRANSFORM || '',
};

startupLog(logLevel, 'info', 'Configuration loaded:', {
  LOG_LEVEL: logLevel,
  AI_PROVIDER: process.env.AI_PROVIDER || 'openai',
  SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
  PAPERLESS_API_URL: process.env.PAPERLESS_API_URL,
  PAPERLESS_API_TOKEN: '******',
  LIMIT_FUNCTIONS: limitFunctions,
  AI_RESTRICTIONS: aiRestrictions,
  EXTERNAL_API: externalApiConfig.enabled === 'yes' ? 'enabled' : 'disabled',
});

module.exports = {
  PAPERLESS_AI_VERSION: 'v2026.09.01',
  CONFIGURED: false,
  configSourceMode: CONFIG_SOURCE_MODE,
  getApiKey,
  getJwtSecret,
  getTrustProxy,
  getCookieSecureMode,
  isProtectedRuntimeEnvKey,
  get apiKey() {
    return getApiKey();
  },
  get jwtSecret() {
    return getJwtSecret();
  },
  get trustProxy() {
    return getTrustProxy();
  },
  get cookieSecureMode() {
    return getCookieSecureMode();
  },
  logLevel,
  // How every date in the interface is rendered. The browser gets it through a
  // <meta> tag in the shell, so one setting covers server-rendered pages and
  // the tables the page scripts build alike.
  dateFormat,
  validDateFormats: VALID_DATE_FORMATS,
  disableAutomaticProcessing: process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
  exposeApiDocs: parseEnvBoolean(process.env.EXPOSE_API_DOCS, 'no'),
  // Contacts api.github.com once a day to compare release tags. Set to `no` in
  // air-gapped installations or wherever the outbound call is unwanted.
  updateCheckEnabled: parseEnvBoolean(process.env.UPDATE_CHECK_ENABLED, 'yes'),
  globalRateLimitWindowMs: parseInt(
    process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || '900000',
    10
  ),
  globalRateLimitMax: parseInt(process.env.GLOBAL_RATE_LIMIT_MAX || '1000', 10),
  predefinedMode: process.env.PROCESS_PREDEFINED_DOCUMENTS,
  ignoreTags: process.env.IGNORE_TAGS || '',
  // The context window the provider is told to respect. Read through the
  // strict parser: a NaN here used to travel all the way into
  // truncateToTokenLimit(), which then sent the model an empty document.
  tokenLimit: parseStrictTokenCount(
    process.env.TOKEN_LIMIT,
    128000,
    'TOKEN_LIMIT'
  ),
  // How many tokens a provider may spend on its answer. Reserved in the
  // context window and, where the provider offers a knob for it, sent as the
  // generation limit — num_predict for Ollama, max_tokens for the rest.
  responseTokens: parseTokenCount(
    process.env.RESPONSE_TOKENS,
    1000,
    'RESPONSE_TOKENS'
  ),
  // Minimum extracted-text length before a document is sent to AI analysis.
  // Documents below this are skipped or routed to OCR fallback. Default 10.
  minContentLength: parseInt(process.env.MIN_CONTENT_LENGTH || '10', 10),
  aiTemperatureAnalysis: parseTemperature(
    process.env.AI_TEMPERATURE_ANALYSIS,
    0.3,
    'AI_TEMPERATURE_ANALYSIS'
  ),
  aiTemperatureGeneration: parseTemperature(
    process.env.AI_TEMPERATURE_GENERATION,
    0.7,
    'AI_TEMPERATURE_GENERATION'
  ),
  addAIProcessedTag: process.env.ADD_AI_PROCESSED_TAG || 'no',
  addAIProcessedTags: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
  // Duplicates page: the configured AI provider may judge candidate pairs on
  // request ("Ask the AI"). `no` hides the button; nothing runs on its own
  // either way. The batch size is pairs per model request; the floor is the
  // lowest matcher score a pair needs to be shown to the model at all.
  duplicatesAiReview: parseEnvBoolean(process.env.DUPLICATES_AI_REVIEW, 'yes'),
  duplicatesAiReviewBatchSize: parseInt(
    process.env.DUPLICATES_AI_REVIEW_BATCH_SIZE || '25',
    10
  ),
  duplicatesAiCandidateFloor: parseFloat(
    process.env.DUPLICATES_AI_CANDIDATE_FLOOR || '0.6'
  ),
  // Evidence for the judge beyond names and titles: a short excerpt of the
  // content of a couple of documents per entity, only for pairs the matcher
  // linked by spelling alone (typo-like distance, prefix, word order). That
  // is where a name pair such as "Kontoauszug" / "Kontoumzug" reads like a
  // typo but means two different things.
  duplicatesAiExcerpts: parseEnvBoolean(
    process.env.DUPLICATES_AI_EXCERPTS,
    'yes'
  ),
  duplicatesAiExcerptChars: parseInt(
    process.env.DUPLICATES_AI_EXCERPT_CHARS || '300',
    10
  ),
  duplicatesAiExcerptDocuments: parseInt(
    process.env.DUPLICATES_AI_EXCERPT_DOCUMENTS || '2',
    10
  ),
  // Optional: a stronger model of the configured provider for the judge
  // only. Empty means the provider's configured model.
  duplicatesAiModel: (process.env.DUPLICATES_AI_MODEL || '').trim(),
  // The two brakes of a running review. The token budget is the most one
  // review may spend across all its requests before it stops itself (0 = no
  // limit); the idle stop ends a review nobody has been watching for that
  // many seconds (0 = never), so a closed tab cannot leave the model running.
  duplicatesAiTokenBudget: parseInt(
    process.env.DUPLICATES_AI_TOKEN_BUDGET || '200000',
    10
  ),
  duplicatesAiIdleStopSeconds: parseInt(
    process.env.DUPLICATES_AI_IDLE_STOP_SECONDS || '60',
    10
  ),
  // How the judge talks to the model. Thinking (the reasoning a model such
  // as Qwen3 or DeepSeek-R1 writes before its answer) is off by default: it
  // spends the whole answer budget before the first verdict and the judge
  // gets evidence instead. The request seconds are the length one model
  // request should take; the judge measures the model on a small first
  // request and sizes every later one to fit.
  duplicatesAiThinking: parseEnvBoolean(
    process.env.DUPLICATES_AI_THINKING,
    'no'
  ),
  duplicatesAiRequestSeconds: parseInt(
    process.env.DUPLICATES_AI_REQUEST_SECONDS || '30',
    10
  ),
  // Drift is prevented where it starts: when document analysis proposes a
  // tag or correspondent whose name is a hard match of an existing one
  // (case, umlauts, legal form, plural, word order), the existing one is
  // used and the mapping is recorded for the Duplicates page. A typo-like
  // match is only logged; the name is still created.
  duplicatesGuardNewNames: parseEnvBoolean(
    process.env.DUPLICATES_GUARD_NEW_NAMES,
    'yes'
  ),
  // The semantic sweep shows the model the names of one kind, this many per
  // request, and asks for groups the string matcher cannot see (synonyms,
  // translations). Off unless the page asks for it.
  duplicatesAiSweepNames: parseInt(
    process.env.DUPLICATES_AI_SWEEP_NAMES || '300',
    10
  ),
  // AI restrictions config
  restrictToExistingTags: aiRestrictions.restrictToExistingTags,
  restrictToExistingCorrespondents:
    aiRestrictions.restrictToExistingCorrespondents,
  restrictToExistingDocumentTypes:
    aiRestrictions.restrictToExistingDocumentTypes,
  // External API config
  externalApiConfig: externalApiConfig,
  paperless: {
    apiUrl: (process.env.PAPERLESS_API_URL || '')
      .replace(/\/+$/, '')
      .replace(/\/api$/i, ''),
    apiToken: process.env.PAPERLESS_API_TOKEN,
    // Deadline for every single Paperless-ngx request. Axios ships with no
    // timeout at all, so a host that accepts the connection and then goes
    // quiet — a Paperless-ngx container that is still booting, which is
    // exactly what a restart looks like — left the request pending for the
    // lifetime of the process. Set to 0 to restore the unlimited behaviour.
    requestTimeoutSeconds: parseInt(
      process.env.PAPERLESS_REQUEST_TIMEOUT_SECONDS || '30',
      10
    ),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  ollama: {
    apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    apiKey: process.env.OLLAMA_API_KEY || '',
    model: process.env.OLLAMA_MODEL || 'llama3.2',
    // Strict opt-in: only literal "true" enables thinking mode.
    think:
      String(process.env.OLLAMA_THINK || '')
        .trim()
        .toLowerCase() === 'true',
  },
  custom: {
    apiUrl: process.env.CUSTOM_BASE_URL || '',
    apiKey: process.env.CUSTOM_API_KEY || '',
    model: process.env.CUSTOM_MODEL || '',
  },
  azure: {
    apiKey: process.env.AZURE_API_KEY || '',
    endpoint: process.env.AZURE_ENDPOINT || '',
    deploymentName: process.env.AZURE_DEPLOYMENT_NAME || '',
    apiVersion: process.env.AZURE_API_VERSION || '2023-05-15',
  },
  mistralOcr: {
    enabled: parseEnvBoolean(process.env.MISTRAL_OCR_ENABLED, 'no'),
    provider: String(
      process.env.OCR_PROVIDER || process.env.MISTRAL_OCR_PROVIDER || 'mistral'
    )
      .trim()
      .toLowerCase(),
    apiUrl: (
      process.env.OCR_API_URL ||
      process.env.MISTRAL_OCR_API_URL ||
      ''
    ).trim(),
    apiKey: process.env.OCR_API_KEY || process.env.MISTRAL_API_KEY || '',
    model: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest',
    // PDF page rendering for local vision OCR (poppler pdftoppm); the Mistral
    // provider handles PDFs natively and ignores these settings.
    pdfRenderEnabled: parseEnvBoolean(
      process.env.OCR_PDF_RENDER_ENABLED,
      'yes'
    ),
    pdfRenderMaxPages: parseInt(
      process.env.OCR_PDF_RENDER_MAX_PAGES || '10',
      10
    ),
    pdfRenderDpi: parseInt(process.env.OCR_PDF_RENDER_DPI || '150', 10),
    // Automatic draining of the OCR queue. Without it the queue is only
    // emptied by hand via "Process All Pending" on the /ocr page.
    autoProcessEnabled: parseEnvBoolean(
      process.env.OCR_AUTO_PROCESS_ENABLED,
      'no'
    ),
    autoProcessInterval:
      process.env.OCR_AUTO_PROCESS_INTERVAL || '*/15 * * * *',
    autoProcessBatchSize: parseInt(
      process.env.OCR_AUTO_PROCESS_BATCH_SIZE || '10',
      10
    ),
    // Run AI analysis right after OCR. Defaults to yes because a failed
    // content write-back leaves the OCR text local-only, where a regular
    // scan would never pick it up.
    autoAnalyze: parseEnvBoolean(process.env.OCR_AUTO_ANALYZE, 'yes'),
  },
  customFields: process.env.CUSTOM_FIELDS || '',
  aiProvider: process.env.AI_PROVIDER || 'openai',
  scanInterval: process.env.SCAN_INTERVAL || '*/30 * * * *',
  // Reconciliation: periodic cleanup of stale documents deleted in Paperless-ngx
  reconciliationInterval: process.env.RECONCILIATION_INTERVAL || '0 * * * *',
  reconciliationEnabled: parseEnvBoolean(
    process.env.RECONCILIATION_ENABLED,
    'yes'
  ),
  useExistingData: process.env.USE_EXISTING_DATA || 'no',
  // Startup behaviour when Paperless-ngx is not reachable yet (e.g. both
  // containers starting at the same time). The scan scheduler is armed
  // regardless; this only controls how long the initial scan keeps retrying.
  startup: {
    paperlessRetryMinutes: parseInt(
      process.env.STARTUP_PAPERLESS_RETRY_MINUTES || '30',
      10
    ),
  },
  // Health reporting: /health reflects scanner health, not just the database.
  // strict=yes makes /health answer 503 while the scanner is degraded so the
  // Docker healthcheck and monitoring can detect a stalled scan loop.
  health: {
    strict: parseEnvBoolean(process.env.HEALTHCHECK_STRICT, 'yes'),
    scanFailureThreshold: parseInt(
      process.env.HEALTH_SCAN_FAILURE_THRESHOLD || '3',
      10
    ),
    // Standalone Paperless-ngx connectivity probe, independent of the scan
    // loop. Without it the dashboard could only learn about an outage on the
    // next scan tick — up to a full SCAN_INTERVAL late, or never when
    // DISABLE_AUTOMATIC_PROCESSING=yes. Set to 0 to switch the probe off.
    paperlessProbeIntervalSeconds: parseInt(
      process.env.PAPERLESS_PROBE_INTERVAL_SECONDS || '60',
      10
    ),
  },
  // Cache configuration (in seconds)
  // Recommended: 300 (5 min) for balanced performance, 60-900 (1-15 min) for custom needs
  tagCacheTTL: parseInt(process.env.TAG_CACHE_TTL_SECONDS || '300', 10),
  // How long the assembled dashboard statistics payload stays valid. The
  // dashboard polls its stats endpoint, so without this every poll of every
  // open tab paid for two Paperless-ngx round trips and a dozen queries. The
  // scan loop invalidates the cache as it processes documents, so a low value
  // buys little beyond faster reaction to changes made outside this app.
  statsCacheTTL: parseInt(process.env.STATS_CACHE_TTL_SECONDS || '60', 10),
  // Add limit functions to config
  limitFunctions: {
    activateTagging: limitFunctions.activateTagging,
    activateCorrespondents: limitFunctions.activateCorrespondents,
    activateDocumentType: limitFunctions.activateDocumentType,
    activateTitle: limitFunctions.activateTitle,
    activateCustomFields: limitFunctions.activateCustomFields,
  },
  specialPromptPreDefinedTags: `You are a document analysis AI. You will analyze the document. 
  You take the main information to associate tags with the document. 
  You will also find the correspondent of the document (Sender not receiver). Also you find a meaningful and short title for the document.
  You are given a list of tags: ${process.env.PROMPT_TAGS}
  Only use the tags from the list and try to find the best fitting tags.
  You do not ask for additional information, you only use the information given in the document.
  
  Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:
  {
    "title": "xxxxx",
    "correspondent": "xxxxxxxx",
    "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
    "document_date": "YYYY-MM-DD",
    "language": "en/de/es/..."
  }`,
  mustHavePrompt: `  Return the result EXCLUSIVELY as a JSON object. The Tags, Title and Document_Type MUST be in the language that is used in the document.:
  IMPORTANT: The custom_fields are optional and can be left out if not needed, only try to fill out the values if you find a matching information in the document.
  Do not change the value of field_name, only fill out the values. If the field is about money only add the number without currency and always use a . for decimal places.
  {
    "title": "xxxxx",
    "correspondent": "xxxxxxxx",
    "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
    "document_type": "Invoice/Contract/...",
    "document_date": "YYYY-MM-DD",
    "language": "en/de/es/...",
    %CUSTOMFIELDS%
  }`,
};
