const path = require('path');
const fs = require('fs');
const currentDir = decodeURIComponent(process.cwd());
const envPath = path.join(currentDir, 'data', '.env');
const migratedEnvPath = path.join(currentDir, 'data', '.env.migrated');
const runtimeOverridesPath = path.join(currentDir, 'data', 'runtime-overrides.json');
const CONFIG_SOURCE_MODE = String(process.env.CONFIG_SOURCE_MODE || 'runtime-first').trim().toLowerCase();
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
  error: 40
};
const VALID_LOG_LEVELS = Object.keys(LOG_LEVEL_WEIGHTS);

const normalizeLogLevel = (value) => {
  if (!value) {
    return 'info';
  }

  const normalized = String(value).trim().toLowerCase();
  return VALID_LOG_LEVELS.includes(normalized) ? normalized : 'info';
};

const shouldLogAtStartup = (currentLevel, messageLevel) => {
  const currentWeight = LOG_LEVEL_WEIGHTS[currentLevel] || LOG_LEVEL_WEIGHTS.info;
  const messageWeight = LOG_LEVEL_WEIGHTS[messageLevel] || LOG_LEVEL_WEIGHTS.info;
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
        startupLog(currentLevel, 'warn', '[WARN] Failed to parse existing runtime overrides before migration:', error.message);
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
      fs.writeFileSync(runtimeOverridesPath, JSON.stringify(mergedOverrides, null, 2));
      startupLog(currentLevel, 'info', '[INFO] Migrated legacy data/.env values to runtime overrides.');
    }

    fs.renameSync(envPath, migratedEnvPath);
    startupLog(currentLevel, 'warn', '[WARN] data/.env has been migrated and renamed to data/.env.migrated.');
  } catch (error) {
    startupLog(currentLevel, 'warn', '[WARN] Failed to migrate legacy data/.env:', error.message);
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
if (requestedLogLevel && String(requestedLogLevel).trim().toLowerCase() !== logLevel) {
  console.warn(`[WARN] Invalid LOG_LEVEL "${requestedLogLevel}". Falling back to "info".`);
}
process.env.LOG_LEVEL = logLevel;
if (CONFIG_SOURCE_MODE === LEGACY_CONFIG_SOURCE_MODE) {
  startupLog(logLevel, 'debug', 'Loading legacy .env from:', envPath);
} else {
  startupLog(logLevel, 'debug', 'Running in runtime-first config mode.');
}
startupLog(logLevel, 'debug', 'Runtime overrides path:', runtimeOverridesPath);

// Helper function to parse boolean-like env vars
const parseEnvBoolean = (value, defaultValue = 'yes') => {
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes' ? 'yes' : 'no';
};

const parseTemperature = (value, defaultValue, envKey) => {
  const normalizedValue = String(value ?? '').trim();
  if (!normalizedValue) {
    return defaultValue;
  }

  const parsed = Number.parseFloat(normalizedValue);
  if (!Number.isFinite(parsed)) {
    startupLog(logLevel, 'warn', `[WARN] Invalid ${envKey} value "${normalizedValue}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }

  if (parsed < 0 || parsed > 2) {
    startupLog(logLevel, 'warn', `[WARN] Out-of-range ${envKey} value "${normalizedValue}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }

  return parsed;
};

const getApiKey = () => process.env.API_KEY || process.env.PAPERLESS_AI_API_KEY || '';
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
  const mode = String(process.env.COOKIE_SECURE_MODE || 'auto').trim().toLowerCase();
  if (mode === 'always' || mode === 'never' || mode === 'auto') {
    return mode;
  }

  return 'auto';
};

// Initialize limit functions with defaults
const limitFunctions = {
  activateTagging: parseEnvBoolean(process.env.ACTIVATE_TAGGING, 'yes'),
  activateCorrespondents: parseEnvBoolean(process.env.ACTIVATE_CORRESPONDENTS, 'yes'),
  activateDocumentType: parseEnvBoolean(process.env.ACTIVATE_DOCUMENT_TYPE, 'yes'),
  activateTitle: parseEnvBoolean(process.env.ACTIVATE_TITLE, 'yes'),
  activateCustomFields: parseEnvBoolean(process.env.ACTIVATE_CUSTOM_FIELDS, 'yes')
};

// Initialize AI restrictions with defaults
const aiRestrictions = {
  restrictToExistingTags: parseEnvBoolean(process.env.RESTRICT_TO_EXISTING_TAGS, 'no'),
  restrictToExistingCorrespondents: parseEnvBoolean(process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS, 'no'),
  restrictToExistingDocumentTypes: parseEnvBoolean(process.env.RESTRICT_TO_EXISTING_DOCUMENT_TYPES, 'no')
};

startupLog(logLevel, 'debug', 'Loaded restriction settings:', {
  RESTRICT_TO_EXISTING_TAGS: aiRestrictions.restrictToExistingTags,
  RESTRICT_TO_EXISTING_CORRESPONDENTS: aiRestrictions.restrictToExistingCorrespondents,
  RESTRICT_TO_EXISTING_DOCUMENT_TYPES: aiRestrictions.restrictToExistingDocumentTypes
});

// Initialize external API configuration
const externalApiConfig = {
  enabled: parseEnvBoolean(process.env.EXTERNAL_API_ENABLED, 'no'),
  url: process.env.EXTERNAL_API_URL || '',
  method: process.env.EXTERNAL_API_METHOD || 'GET',
  headers: process.env.EXTERNAL_API_HEADERS || '{}',
  body: process.env.EXTERNAL_API_BODY || '{}',
  timeout: parseInt(process.env.EXTERNAL_API_TIMEOUT || '5000', 10),
  transformationTemplate: process.env.EXTERNAL_API_TRANSFORM || ''
};

startupLog(logLevel, 'info', 'Configuration loaded:', {
  LOG_LEVEL: logLevel,
  AI_PROVIDER: process.env.AI_PROVIDER || 'openai',
  SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
  PAPERLESS_API_URL: process.env.PAPERLESS_API_URL,
  PAPERLESS_API_TOKEN: '******',
  LIMIT_FUNCTIONS: limitFunctions,
  AI_RESTRICTIONS: aiRestrictions,
  EXTERNAL_API: externalApiConfig.enabled === 'yes' ? 'enabled' : 'disabled'
});

module.exports = {
  PAPERLESS_AI_VERSION: 'v2026.05.01',
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
  disableAutomaticProcessing: process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
  exposeApiDocs: parseEnvBoolean(process.env.EXPOSE_API_DOCS, 'no'),
  globalRateLimitWindowMs: parseInt(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || '900000', 10),
  globalRateLimitMax: parseInt(process.env.GLOBAL_RATE_LIMIT_MAX || '1000', 10),
  predefinedMode: process.env.PROCESS_PREDEFINED_DOCUMENTS,
  ignoreTags: process.env.IGNORE_TAGS || '',
  tokenLimit: process.env.TOKEN_LIMIT || 128000,
  responseTokens: process.env.RESPONSE_TOKENS || 1000,
  aiTemperatureAnalysis: parseTemperature(process.env.AI_TEMPERATURE_ANALYSIS, 0.3, 'AI_TEMPERATURE_ANALYSIS'),
  aiTemperatureGeneration: parseTemperature(process.env.AI_TEMPERATURE_GENERATION, 0.7, 'AI_TEMPERATURE_GENERATION'),
  addAIProcessedTag: process.env.ADD_AI_PROCESSED_TAG || 'no',
  addAIProcessedTags: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
  // AI restrictions config
  restrictToExistingTags: aiRestrictions.restrictToExistingTags,
  restrictToExistingCorrespondents: aiRestrictions.restrictToExistingCorrespondents,
  restrictToExistingDocumentTypes: aiRestrictions.restrictToExistingDocumentTypes,
  // External API config
  externalApiConfig: externalApiConfig,
  paperless: {
    apiUrl: (process.env.PAPERLESS_API_URL || '').replace(/\/+$/, '').replace(/\/api$/i, ''),
    apiToken: process.env.PAPERLESS_API_TOKEN
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY
  },
  ollama: {
    apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2',
    // Strict opt-in: only literal "true" enables thinking mode.
    think: String(process.env.OLLAMA_THINK || '').trim().toLowerCase() === 'true'
  },
  custom: {
    apiUrl: process.env.CUSTOM_BASE_URL || '',
    apiKey: process.env.CUSTOM_API_KEY || '',
    model: process.env.CUSTOM_MODEL || ''
  },
  azure: {
    apiKey: process.env.AZURE_API_KEY || '',
    endpoint: process.env.AZURE_ENDPOINT || '',
    deploymentName: process.env.AZURE_DEPLOYMENT_NAME || '',
    apiVersion: process.env.AZURE_API_VERSION || '2023-05-15'
  },
  mistralOcr: {
    enabled: parseEnvBoolean(process.env.MISTRAL_OCR_ENABLED, 'no'),
    apiKey: process.env.MISTRAL_API_KEY || '',
    model: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest'
  },
  customFields: process.env.CUSTOM_FIELDS || '',
  aiProvider: process.env.AI_PROVIDER || 'openai',
  scanInterval: process.env.SCAN_INTERVAL || '*/30 * * * *',
  // Reconciliation: periodic cleanup of stale documents deleted in Paperless-ngx
  reconciliationInterval: process.env.RECONCILIATION_INTERVAL || '0 * * * *',
  reconciliationEnabled: parseEnvBoolean(process.env.RECONCILIATION_ENABLED, 'yes'),
  useExistingData: process.env.USE_EXISTING_DATA || 'no',
  // Cache configuration (in seconds)
  // Recommended: 300 (5 min) for balanced performance, 60-900 (1-15 min) for custom needs
  tagCacheTTL: parseInt(process.env.TAG_CACHE_TTL_SECONDS || '300', 10),
  // Add limit functions to config
  limitFunctions: {
    activateTagging: limitFunctions.activateTagging,
    activateCorrespondents: limitFunctions.activateCorrespondents,
    activateDocumentType: limitFunctions.activateDocumentType,
    activateTitle: limitFunctions.activateTitle,
    activateCustomFields: limitFunctions.activateCustomFields
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
