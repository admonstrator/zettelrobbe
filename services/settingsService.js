// @ts-check
'use strict';

/**
 * What a settings save, the settings page, the setup wizard and the .env
 * export make of the settings catalogue.
 *
 * Every function here is a pure function of its arguments (the request body,
 * the values in effect, the environment): no network, no file, no response.
 * The routes do the I/O — the custom field lookup, the Paperless-ngx
 * reachability check, saveConfig() — and call these in between, in the order
 * POST /settings has always checked things:
 *
 *   1. resolveOcrSettings()          OCR provider and key checks
 *   2. parseCustomFields()           then the route asks Paperless-ngx for type
 *      checkCustomFieldConflicts()   conflicts and refuses new ones
 *   3. resolvePaperlessConnection()  then the route tests a changed connection
 *   4. buildSettingsUpdate()         provider, every simple field, custom
 *                                    fields, OCR, single sign-on
 *   5. planSave()                    the merged values and the restart keys
 */

const settingsCatalog = require('./settingsCatalog');
const setupService = require('./setupService.js');
/* The helpers oidcService attaches to its export next to the instance. */
/**
 * @type {typeof import('./oidcService') & {
 *   TOKEN_AUTH_METHODS: string[],
 *   MAX_BUTTON_TEXT_LENGTH: number,
 *   isSafeCssColor: (value: string) => boolean,
 *   resolveButtonIcon: (value: string) => { type: string },
 * }}
 */
const oidcService = /** @type {any} */ (require('./oidcService'));
const configFile = require('../config/config.js');
const { restartRequiredAmong } = require('../config/restartRequiredKeys');
const {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_EFFORT_LEVELS,
} = require('./anthropicSupport');

/**
 * @typedef {Record<string, any>} SettingsBody the parsed request body
 * @typedef {Record<string, any>} SettingsValues env key -> value
 * @typedef {NodeJS.ProcessEnv|Record<string, string|undefined>} Env
 * @typedef {{ error: string, success?: false }} ErrorBody
 */

/** @param {unknown} value */
const hasValue = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The values in effect a save starts from: every `save` entry of the
 * catalogue, read from `env` with its defaults.
 *
 * @param {Env} [env]
 * @returns {SettingsValues}
 */
function currentSettings(env = process.env) {
  return settingsCatalog.defaultsFromEnv(env, 'save');
}

/* ── 1. OCR ───────────────────────────────────────────────────────────── */

/**
 * @typedef {object} OcrSettings
 * @property {string} provider the OCR provider after the save
 * @property {boolean} crossesClaude the provider changes to or from Claude
 * @property {boolean} hasTypedKey a key was typed into the form
 * @property {string} effectiveKey the key OCR will use
 * @property {number} validationTimeoutMs
 * @property {string} [error] refuses the save
 */

/**
 * The OCR provider, its key and the checks that refuse a save before
 * anything else is looked at.
 *
 * A stored OCR key belongs to the provider it was saved for. Claude OCR reads
 * OCR_API_KEY before the Anthropic AI key, and Mistral OCR reads it before
 * MISTRAL_API_KEY, so a key left behind when the provider crosses to or from
 * Claude would be sent to the wrong vendor (a 401 at best). Such a key is
 * cleared unless a new one is typed.
 *
 * @param {SettingsBody} body
 * @param {SettingsValues} current
 * @returns {OcrSettings}
 */
function resolveOcrSettings(body, current) {
  const typedKey = hasValue(body.ocrApiKey)
    ? String(body.ocrApiKey).trim()
    : String(body.mistralApiKey || '').trim();
  const hasTypedKey = hasValue(typedKey);
  const provider = String(body.ocrProvider || current.OCR_PROVIDER || 'mistral')
    .trim()
    .toLowerCase();
  const crossesClaude =
    (provider === 'anthropic') !==
    (String(current.OCR_PROVIDER || 'mistral')
      .trim()
      .toLowerCase() ===
      'anthropic');

  let storedKey;
  if (provider === 'anthropic') {
    storedKey = crossesClaude ? '' : current.OCR_API_KEY;
  } else {
    storedKey = crossesClaude
      ? current.MISTRAL_API_KEY
      : current.OCR_API_KEY || current.MISTRAL_API_KEY;
  }
  const effectiveKey = hasTypedKey ? typedKey : storedKey || '';

  const enabled = hasValue(body.mistralOcrEnabled)
    ? String(body.mistralOcrEnabled).trim().toLowerCase()
    : String(current.MISTRAL_OCR_ENABLED || 'no')
        .trim()
        .toLowerCase();

  const validationTimeoutMs = setupService.normalizeValidationTimeoutMs(
    hasValue(body.ocrValidationTimeout)
      ? Number.parseInt(String(body.ocrValidationTimeout).trim(), 10) * 1000
      : current.SETUP_OCR_VALIDATION_TIMEOUT_MS,
    30000
  );

  /** @type {OcrSettings} */
  const result = {
    provider,
    crossesClaude,
    hasTypedKey,
    effectiveKey,
    validationTimeoutMs,
  };

  if (!['mistral', 'custom', 'ollama', 'anthropic'].includes(provider)) {
    result.error =
      'Invalid OCR provider. Allowed values are mistral, custom and anthropic.';
    return result;
  }

  if (enabled === 'yes' && provider === 'mistral' && !effectiveKey) {
    result.error =
      'Mistral API key is required when OCR fallback is enabled with provider mistral.';
    return result;
  }

  // Claude OCR may borrow the Anthropic AI key, but only one that is saved:
  // a key typed into the hidden Anthropic block while another AI provider is
  // selected is not persisted.
  const anthropicAiKeyForOcr =
    String(body.aiProvider || current.AI_PROVIDER)
      .trim()
      .toLowerCase() === 'anthropic'
      ? hasValue(body.anthropicApiKey)
        ? String(body.anthropicApiKey).trim()
        : current.ANTHROPIC_API_KEY
      : current.ANTHROPIC_API_KEY;
  if (
    enabled === 'yes' &&
    provider === 'anthropic' &&
    !effectiveKey &&
    !anthropicAiKeyForOcr
  ) {
    result.error =
      'Claude OCR needs an Anthropic API key: enter one for OCR, or configure the Anthropic AI provider.';
  }
  return result;
}

/**
 * The OCR values of a save. Saving runs no live OCR test; the "Test OCR
 * Connection" button does that on demand.
 *
 * @param {SettingsBody} body
 * @param {SettingsValues} current
 * @param {OcrSettings} ocr
 * @param {SettingsValues} updates the values collected so far (for the Claude model)
 * @returns {SettingsValues}
 */
function buildOcrUpdate(body, current, ocr, updates) {
  /** @type {SettingsValues} */
  const values = {};
  if (body.mistralOcrEnabled)
    values.MISTRAL_OCR_ENABLED = body.mistralOcrEnabled;
  if (body.ocrProvider) {
    values.OCR_PROVIDER = String(body.ocrProvider).trim().toLowerCase();
  }

  const submittedUrl =
    typeof body.ocrApiUrl === 'string' ? body.ocrApiUrl.trim() : null;
  if (ocr.provider === 'mistral') {
    values.OCR_API_URL = '';
  } else if (ocr.provider === 'anthropic' && ocr.crossesClaude) {
    // For Claude OCR the URL is an optional proxy. The one stored for the
    // previous provider would be used as one, so only a URL that differs
    // from it counts as typed for Claude; empty falls back to
    // ANTHROPIC_API_URL.
    values.OCR_API_URL =
      submittedUrl && submittedUrl !== current.OCR_API_URL ? submittedUrl : '';
  } else if (submittedUrl !== null) {
    values.OCR_API_URL = submittedUrl;
  }

  if (ocr.hasTypedKey) {
    values.OCR_API_KEY = ocr.effectiveKey;
    // An Anthropic key must not land where Mistral OCR would read it.
    if (ocr.provider !== 'anthropic') {
      values.MISTRAL_API_KEY = ocr.effectiveKey;
    }
  } else if (ocr.crossesClaude) {
    values.OCR_API_KEY = '';
  }

  if (ocr.provider === 'anthropic') {
    // Stored as the model Claude OCR will run with, so the page shows it
    // instead of a leftover Mistral model name.
    if (body.mistralOcrModel || ocr.crossesClaude) {
      values.MISTRAL_OCR_MODEL = setupService.resolveAnthropicOcrModel(
        body.mistralOcrModel,
        updates.ANTHROPIC_MODEL || current.ANTHROPIC_MODEL
      );
    }
  } else if (body.mistralOcrModel) {
    values.MISTRAL_OCR_MODEL = body.mistralOcrModel;
  }

  values.SETUP_OCR_VALIDATION_TIMEOUT_MS = String(ocr.validationTimeoutMs);
  return values;
}

/* ── 2. Custom fields ─────────────────────────────────────────────────── */

/**
 * @typedef {{ value: unknown, data_type: unknown, currency?: unknown }} CustomField
 */

/**
 * The custom fields of a save, as a list. An unreadable value yields no
 * fields and the error that made it unreadable (the route logs it).
 *
 * @param {unknown} raw
 * @returns {{ fields: CustomField[], parseError?: unknown }}
 */
function parseCustomFields(raw) {
  if (!raw) return { fields: [] };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const fields = /** @type {any} */ (parsed).custom_fields.map(
      (/** @type {any} */ field) => ({
        value: field.value,
        data_type: field.data_type,
        ...(field.currency && { currency: field.currency }),
      })
    );
    return { fields };
  } catch (error) {
    return { fields: [], parseError: error };
  }
}

/**
 * A field Paperless-ngx already has under another type is never created; the
 * existing one is used, and every value its type cannot hold is dropped. Such
 * fields are refused when they are added or changed. Entries that were
 * configured before only warn, so a mismatch in an operator-injected
 * CUSTOM_FIELDS cannot lock the page.
 *
 * @param {{ name: string, paperlessType: string, configuredType: string }[]|null} conflicts
 *   what Paperless-ngx reported; null when it could not be asked
 * @param {string} currentCustomFields the CUSTOM_FIELDS in effect
 * @returns {{ warnings: string[], error?: string }}
 */
function checkCustomFieldConflicts(conflicts, currentCustomFields) {
  if (conflicts === null) {
    return {
      warnings: [
        '[WARN] Could not compare custom field types with Paperless-ngx; saving without the check',
      ],
    };
  }
  if (conflicts.length === 0) return { warnings: [] };

  /**
   * @param {unknown} name
   * @param {unknown} type
   */
  const customFieldKey = (name, type) =>
    `${String(name || '').toLowerCase()}\u0000${type}`;
  let previousKeys = new Set();
  try {
    const previous = JSON.parse(currentCustomFields);
    previousKeys = new Set(
      (previous.custom_fields || []).map((/** @type {any} */ field) =>
        customFieldKey(field.value, field.data_type)
      )
    );
  } catch {
    // An unreadable previous value makes every entry count as new.
  }

  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const refused = [];
  for (const conflict of conflicts) {
    const describe = `Custom field "${conflict.name}" exists in Paperless-ngx with the type "${conflict.paperlessType}", not "${conflict.configuredType}".`;
    if (
      previousKeys.has(customFieldKey(conflict.name, conflict.configuredType))
    ) {
      warnings.push(`[WARN] ${describe}`);
    } else {
      refused.push(describe);
    }
  }

  if (refused.length === 0) return { warnings };
  const them = refused.length === 1 ? 'it' : 'them';
  return {
    warnings,
    error: `${refused.join(' ')} Remove ${them} and add ${them} again with the type Paperless-ngx has, or use another name.`,
  };
}

/* ── 3. The Paperless-ngx connection ──────────────────────────────────── */

/**
 * The connection a save ends up with. An omitted or empty URL or token keeps
 * the stored one; a new URL or a typed token has to be tested before saving.
 *
 * @param {SettingsBody} body
 * @param {SettingsValues} current
 * @returns {{ url: string, token: string, needsValidation: boolean, updates: SettingsValues }}
 */
function resolvePaperlessConnection(body, current) {
  const hasUrlInput = hasValue(body.paperlessUrl);
  const hasTokenInput = hasValue(body.paperlessToken);
  const currentUrl = String(current.PAPERLESS_API_URL || '').replace(
    /\/api$/,
    ''
  );
  const url = hasUrlInput ? body.paperlessUrl : currentUrl;
  const token = hasTokenInput
    ? body.paperlessToken.trim()
    : current.PAPERLESS_API_TOKEN;

  /** @type {SettingsValues} */
  const updates = {};
  if (hasUrlInput) updates.PAPERLESS_API_URL = url;
  if (hasTokenInput) updates.PAPERLESS_API_TOKEN = token;

  return {
    url,
    token,
    needsValidation: Boolean((url && url !== currentUrl) || hasTokenInput),
    updates,
  };
}

/* ── 4. The values of a save ──────────────────────────────────────────── */

/**
 * The AI provider and its connection. Saving runs no live AI test, only the
 * required-field checks; the test buttons verify connectivity on demand. The
 * fields of the providers not selected are not saved.
 *
 * @param {SettingsBody} body
 * @param {SettingsValues} current
 * @returns {{ updates: SettingsValues, error?: string }}
 */
function buildProviderUpdate(body, current) {
  /** @type {SettingsValues} */
  const updates = {};
  if (!body.aiProvider) return { updates };

  const provider = String(body.aiProvider).trim().toLowerCase();
  updates.AI_PROVIDER = provider;

  /**
   * The typed key, or the stored one when the field was left empty.
   *
   * @param {string} field
   * @param {string} key
   */
  const secret = (field, key) => {
    const typed = hasValue(body[field]);
    return { typed, value: typed ? body[field].trim() : current[key] };
  };

  if (provider === 'openai') {
    const key = secret('openaiKey', 'OPENAI_API_KEY');
    if (!key.value) {
      return {
        updates,
        error: 'OpenAI API key is required when OpenAI provider is selected.',
      };
    }
    if (key.typed) updates.OPENAI_API_KEY = key.value;
    if (body.openaiModel) updates.OPENAI_MODEL = body.openaiModel;
  } else if (provider === 'ollama') {
    if (
      !(body.ollamaUrl || current.OLLAMA_API_URL) ||
      !(body.ollamaModel || current.OLLAMA_MODEL)
    ) {
      return {
        updates,
        error:
          'Ollama URL and model are required when Ollama provider is selected.',
      };
    }
    const key = secret('ollamaApiKey', 'OLLAMA_API_KEY');
    if (body.ollamaUrl) updates.OLLAMA_API_URL = body.ollamaUrl;
    if (key.typed) updates.OLLAMA_API_KEY = key.value;
    if (body.ollamaModel) updates.OLLAMA_MODEL = body.ollamaModel;
    // The switch arrives as the settings-switch partial's yes/no;
    // config.ollama.think only counts the literal 'true'.
    if (body.ollamaThink !== undefined) {
      updates.OLLAMA_THINK = ['yes', 'on', 'true', '1'].includes(
        String(body.ollamaThink ?? '')
          .trim()
          .toLowerCase()
      )
        ? 'true'
        : 'false';
    }
  } else if (provider === 'custom') {
    if (
      !(body.customBaseUrl || current.CUSTOM_BASE_URL) ||
      !(body.customModel || current.CUSTOM_MODEL)
    ) {
      return {
        updates,
        error:
          'Custom provider URL and model are required when custom provider is selected.',
      };
    }
    const key = secret('customApiKey', 'CUSTOM_API_KEY');
    if (key.typed) updates.CUSTOM_API_KEY = key.value;
    if (body.customBaseUrl) updates.CUSTOM_BASE_URL = body.customBaseUrl;
    if (body.customModel) updates.CUSTOM_MODEL = body.customModel;
  } else if (provider === 'azure') {
    const key = secret('azureApiKey', 'AZURE_API_KEY');
    if (
      !(body.azureEndpoint || current.AZURE_ENDPOINT) ||
      !key.value ||
      !(body.azureDeploymentName || current.AZURE_DEPLOYMENT_NAME)
    ) {
      return {
        updates,
        error:
          'Azure endpoint, API key and deployment name are required when Azure provider is selected.',
      };
    }
    if (body.azureEndpoint) updates.AZURE_ENDPOINT = body.azureEndpoint;
    if (key.typed) updates.AZURE_API_KEY = key.value;
    if (body.azureDeploymentName) {
      updates.AZURE_DEPLOYMENT_NAME = body.azureDeploymentName;
    }
    if (body.azureApiVersion) updates.AZURE_API_VERSION = body.azureApiVersion;
  } else if (provider === 'anthropic') {
    const anthropic = buildAnthropicUpdate(body, current);
    if (anthropic.error) return { updates, error: anthropic.error };
    Object.assign(updates, anthropic.updates);
  }

  return { updates };
}

/**
 * The Anthropic block of a save.
 *
 * @param {SettingsBody} body
 * @param {SettingsValues} current
 * @returns {{ updates: SettingsValues, error?: string }}
 */
function buildAnthropicUpdate(body, current) {
  /** @type {SettingsValues} */
  const updates = {};
  const hasKeyInput = hasValue(body.anthropicApiKey);
  const key = hasKeyInput
    ? body.anthropicApiKey.trim()
    : current.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      updates,
      error:
        'Anthropic API key is required when the Anthropic provider is selected.',
    };
  }

  // Empty is a value of its own: it leaves the effort to the model. Anything
  // else must be a level the provider knows, because the API rejects unknown
  // ones on every request of a scan.
  const effort =
    body.anthropicEffort === undefined
      ? current.ANTHROPIC_EFFORT
      : String(body.anthropicEffort ?? '')
          .trim()
          .toLowerCase();
  if (effort && !ANTHROPIC_EFFORT_LEVELS.includes(effort)) {
    return {
      updates,
      error: `Invalid Anthropic effort. Allowed values are ${ANTHROPIC_EFFORT_LEVELS.join(', ')}, or empty for the model default.`,
    };
  }

  // Same strictness as Token Limit: "16k" must not be read as 16.
  const maxTokens = String(body.anthropicMaxTokens ?? '').trim();
  if (maxTokens && (!/^\d+$/.test(maxTokens) || Number(maxTokens) < 1)) {
    return {
      updates,
      error: 'Invalid Anthropic max tokens. Expected a positive whole number.',
    };
  }

  const apiUrl =
    typeof body.anthropicApiUrl === 'string'
      ? body.anthropicApiUrl.trim()
      : null;
  if (apiUrl) {
    /** @type {URL|null} */
    let parsed;
    try {
      parsed = new URL(apiUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      return {
        updates,
        error:
          'Invalid Anthropic API URL. Expected an http(s) URL, or leave it empty for api.anthropic.com.',
      };
    }
  }

  // The switches arrive as the hidden yes/no inputs of the settings-switch
  // partial; anything else keeps the stored value.
  /**
   * @param {unknown} raw
   * @param {unknown} fallback
   */
  const yesNoOr = (raw, fallback) => {
    const normalized = String(raw ?? '')
      .trim()
      .toLowerCase();
    return ['yes', 'no'].includes(normalized) ? normalized : String(fallback);
  };

  if (hasKeyInput) updates.ANTHROPIC_API_KEY = key;
  updates.ANTHROPIC_MODEL =
    String(body.anthropicModel || '').trim() ||
    current.ANTHROPIC_MODEL ||
    ANTHROPIC_DEFAULT_MODEL;
  updates.ANTHROPIC_EFFORT = effort;
  if (maxTokens) updates.ANTHROPIC_MAX_TOKENS = String(Number(maxTokens));
  updates.ANTHROPIC_STRUCTURED_OUTPUT = yesNoOr(
    body.anthropicStructuredOutput,
    current.ANTHROPIC_STRUCTURED_OUTPUT
  );
  updates.ANTHROPIC_PROMPT_CACHING = yesNoOr(
    body.anthropicPromptCaching,
    current.ANTHROPIC_PROMPT_CACHING
  );
  if (apiUrl !== null) updates.ANTHROPIC_API_URL = apiUrl;
  return { updates };
}

/**
 * Runs the `parse` of every catalogue entry that has one, in catalogue
 * order, and stops at the first refusal.
 *
 * @param {SettingsBody} body
 * @param {SettingsValues} current
 * @returns {{ updates: SettingsValues, warnings: string[], error?: string }}
 */
function buildFieldUpdates(body, current) {
  /** @type {SettingsValues} */
  const updates = {};
  /** @type {string[]} */
  const warnings = [];
  for (const entry of settingsCatalog.getCatalog()) {
    if (!entry.parse || !entry.field) continue;
    const result = entry.parse(body[entry.field], current[entry.key]);
    if (result.warning) warnings.push(result.warning);
    if (result.error) return { updates, warnings, error: result.error };
    if ('value' in result) updates[entry.key] = result.value;
  }
  return { updates, warnings };
}

/* Single sign-on fields of the settings page: form field -> OIDC_* key. */
const OIDC_GROUP = 'Single sign-on (OIDC)';

/**
 * Turns the single sign-on fields of a settings save into OIDC_* values and
 * checks the result. A field the body does not carry keeps what is stored,
 * so a client that predates the section still saves. An empty client secret
 * keeps the stored one, like every other secret on the page.
 *
 * The checks only run when single sign-on ends up switched on, and they look
 * at what will be in force after the save: a value injected by the container
 * wins over a typed one, because saveConfig() never writes over it. Switched
 * off, whatever was typed is saved, so a half-finished setup can be parked.
 *
 * @param {SettingsBody} body
 * @param {Env} [env] the environment in effect
 * @param {(key: string) => boolean} [isProtected] whether the container pins a key
 * @returns {{ updates: SettingsValues, error?: undefined }|{ error: string, updates?: undefined }}
 */
function buildOidcSettingsUpdate(
  body,
  env = process.env,
  isProtected = configFile.isProtectedRuntimeEnvKey
) {
  /** @type {SettingsValues} */
  const updates = {};
  for (const entry of settingsCatalog.getCatalog()) {
    if (entry.group !== OIDC_GROUP || !entry.field) continue;
    const envKey = entry.key;
    const raw = body?.[entry.field];
    if (raw === undefined || raw === null) continue;
    if (entry.type === 'boolean') {
      const normalized = String(raw).trim().toLowerCase();
      if (['yes', 'on', 'true', '1'].includes(normalized)) {
        updates[envKey] = 'yes';
      } else if (['no', 'off', 'false', '0', ''].includes(normalized)) {
        updates[envKey] = 'no';
      }
      continue;
    }
    if (entry.secret) {
      const secret = String(raw).trim();
      if (secret) updates[envKey] = secret;
      continue;
    }
    let value = String(raw).trim();
    if (envKey === 'OIDC_SCOPES') value = value.split(/\s+/).join(' ');
    if (envKey === 'OIDC_TOKEN_AUTH_METHOD') value = value.toLowerCase();
    if (envKey === 'OIDC_BUTTON_TEXT') {
      value = value.slice(0, oidcService.MAX_BUTTON_TEXT_LENGTH);
    }
    updates[envKey] = value;
  }

  /** @param {string} envKey */
  const effective = (envKey) =>
    String(
      !isProtected(envKey) && envKey in updates
        ? updates[envKey]
        : env[envKey] || ''
    ).trim();

  const enabled = ['yes', 'true', '1', 'on'].includes(
    effective('OIDC_ENABLED').toLowerCase()
  );
  if (!enabled) {
    return { updates };
  }

  const errors = oidcService.getConfigErrors({
    enabled,
    issuerUrl: effective('OIDC_ISSUER_URL'),
    clientId: effective('OIDC_CLIENT_ID'),
    redirectUri: effective('OIDC_REDIRECT_URI'),
    adminEmail: effective('OIDC_ADMIN_EMAIL'),
  });
  const tokenAuthMethod = effective('OIDC_TOKEN_AUTH_METHOD').toLowerCase();
  if (
    tokenAuthMethod &&
    !oidcService.TOKEN_AUTH_METHODS.includes(tokenAuthMethod)
  ) {
    errors.push(
      `OIDC_TOKEN_AUTH_METHOD must be empty (automatic) or one of ${oidcService.TOKEN_AUTH_METHODS.join(', ')}`
    );
  }
  const buttonIcon = effective('OIDC_BUTTON_ICON');
  if (
    buttonIcon &&
    oidcService.resolveButtonIcon(buttonIcon).type === 'default'
  ) {
    errors.push(
      'OIDC_BUTTON_ICON must be empty, "none", an https:// URL or a path starting with /'
    );
  }
  for (const envKey of ['OIDC_BUTTON_COLOR', 'OIDC_BUTTON_TEXT_COLOR']) {
    const color = effective(envKey);
    if (color && !oidcService.isSafeCssColor(color)) {
      errors.push(
        `${envKey} must be a CSS colour such as #1f6feb, a colour name, or rgb()/hsl()`
      );
    }
  }

  if (errors.length > 0) {
    return {
      error: `Single sign-on is switched on but cannot work: ${errors.join('; ')}. Fix these or switch single sign-on off.`,
    };
  }
  return { updates };
}

/**
 * Every value a settings save writes, after the OCR, custom field and
 * Paperless-ngx checks have passed. The first refusal wins, in this order:
 * the AI provider, the simple fields (catalogue order), single sign-on.
 *
 * @param {SettingsBody} body
 * @param {SettingsValues} current
 * @param {{ ocr: OcrSettings, paperless: { updates: SettingsValues }, customFields: CustomField[], env?: Env, isProtected?: (key: string) => boolean }} context
 * @returns {{ updates: SettingsValues, warnings: string[], error?: ErrorBody }}
 */
function buildSettingsUpdate(body, current, context) {
  /** @type {SettingsValues} */
  const updates = { ...context.paperless.updates };
  /** @type {string[]} */
  const warnings = [];

  const provider = buildProviderUpdate(body, current);
  if (provider.error) {
    return { updates, warnings, error: { error: provider.error } };
  }
  Object.assign(updates, provider.updates);

  const fields = buildFieldUpdates(body, current);
  warnings.push(...fields.warnings);
  if (fields.error) {
    return { updates, warnings, error: { error: fields.error } };
  }
  Object.assign(updates, fields.updates);

  if (context.customFields.length > 0 || body.customFields) {
    updates.CUSTOM_FIELDS = JSON.stringify({
      custom_fields: context.customFields,
    });
  }

  Object.assign(updates, buildOcrUpdate(body, current, context.ocr, updates));

  // Single sign-on last, so an incomplete provider is reported only when
  // everything else on the page is fine.
  const oidc = buildOidcSettingsUpdate(body, context.env, context.isProtected);
  if (oidc.error !== undefined) {
    return { updates, warnings, error: { success: false, error: oidc.error } };
  }
  Object.assign(updates, oidc.updates);

  return { updates, warnings };
}

/* ── 5. Merging and restarts ──────────────────────────────────────────── */

/**
 * The values a save writes and the keys whose change needs a restart.
 *
 * Compared against the values in effect — `current` fills in the defaults the
 * form submits for keys nobody has set — and before saveConfig() writes the
 * values onto the environment. Keys the container pins are never reported.
 *
 * @param {SettingsValues} current
 * @param {SettingsValues} updates
 * @param {Env} [env]
 * @returns {{ merged: SettingsValues, changedKeys: string[], restartKeys: string[] }}
 */
function planSave(current, updates, env = process.env) {
  const merged = { ...current, ...updates };
  const changedKeys = setupService.changedConfigKeys(merged, {
    ...env,
    ...current,
  });
  return {
    merged,
    changedKeys,
    restartKeys: restartRequiredAmong(changedKeys),
  };
}

/* ── Pages ────────────────────────────────────────────────────────────── */

/**
 * The configuration a settings page or the setup wizard renders: the
 * surface's settings from `env` with their defaults, the app version, then
 * the saved configuration on top.
 *
 * @param {'page'|'wizard'} surface
 * @param {Env} env
 * @param {Record<string, unknown>|null} saved the runtime overrides, if any
 * @param {string} version
 * @returns {Record<string, unknown>}
 */
function pageConfig(surface, env, saved, version) {
  const config = {
    ...settingsCatalog.defaultsFromEnv(env, surface),
    PAPERLESS_AI_VERSION: version || ' ',
  };
  return saved
    ? { ...config, ...settingsCatalog.viewSavedConfig(saved, surface) }
    : config;
}

/* ── The setup wizard ─────────────────────────────────────────────────── */

/**
 * @typedef {object} InitialSetupInput
 * @property {string} paperlessUrl
 * @property {string} paperlessToken
 * @property {string} paperlessUsername
 * @property {string} aiProvider
 * @property {string} aiApiUrl
 * @property {string} aiToken
 * @property {string} aiModel
 * @property {string} aiAzureApiVersion
 * @property {string} scanInterval
 * @property {boolean} scanAllDocuments
 * @property {string[]} tagsForProcessing
 * @property {string[]} excludeTags
 * @property {string} processedTag
 * @property {boolean} removeInboxTagsAfterProcessing
 * @property {boolean} automaticScanEnabled
 * @property {boolean} mistralOcrEnabled
 * @property {string} ocrProvider
 * @property {string} ocrApiUrl
 * @property {string} ocrApiKey
 * @property {string} mistralOcrModel
 * @property {number} setupValidationTimeoutMs
 * @property {number} setupOcrValidationTimeoutMs
 * @property {string} apiKey
 * @property {string} jwtSecret
 */

/**
 * The configuration the setup wizard saves. What the wizard does not ask for
 * comes from the environment, with the catalogue's defaults.
 *
 * @param {InitialSetupInput} input
 * @param {Env} [env]
 * @returns {SettingsValues}
 */
function buildInitialSetupConfig(input, env = process.env) {
  /** @param {string} key */
  const fromEnv = (key) => settingsCatalog.valueFromEnv(key, env, 'page');
  /** @param {string} key */
  const defaultOf = (key) =>
    /** @type {import('./settingsCatalog').SettingEntry} */ (
      settingsCatalog.getEntry(key)
    ).default;

  /** @type {SettingsValues} */
  const config = {
    PAPERLESS_API_URL: input.paperlessUrl,
    PAPERLESS_API_TOKEN: input.paperlessToken,
    PAPERLESS_USERNAME: input.paperlessUsername,
    AI_PROVIDER: input.aiProvider,
    SCAN_INTERVAL: input.scanInterval,
    PROCESS_PREDEFINED_DOCUMENTS: input.scanAllDocuments ? 'no' : 'yes',
    TAGS: input.tagsForProcessing,
    IGNORE_TAGS: input.excludeTags,
    ADD_AI_PROCESSED_TAG: input.processedTag ? 'yes' : 'no',
    AI_PROCESSED_TAG_NAME:
      input.processedTag || defaultOf('AI_PROCESSED_TAG_NAME'),
    REMOVE_INBOX_TAGS_AFTER_PROCESSING: input.removeInboxTagsAfterProcessing
      ? 'yes'
      : 'no',
    DISABLE_AUTOMATIC_PROCESSING: input.automaticScanEnabled ? 'no' : 'yes',
    TOKEN_LIMIT: fromEnv('TOKEN_LIMIT'),
    RESPONSE_TOKENS: fromEnv('RESPONSE_TOKENS'),
    USE_PROMPT_TAGS: fromEnv('USE_PROMPT_TAGS'),
    PROMPT_TAGS: settingsCatalog.normalizeList(env.PROMPT_TAGS),
    USE_EXISTING_DATA: fromEnv('USE_EXISTING_DATA'),
    API_KEY: input.apiKey,
    JWT_SECRET: input.jwtSecret,
    PAPERLESS_AI_INITIAL_SETUP: 'yes',
    ACTIVATE_TAGGING: fromEnv('ACTIVATE_TAGGING'),
    ACTIVATE_CORRESPONDENTS: fromEnv('ACTIVATE_CORRESPONDENTS'),
    ACTIVATE_DOCUMENT_TYPE: fromEnv('ACTIVATE_DOCUMENT_TYPE'),
    ACTIVATE_TITLE: fromEnv('ACTIVATE_TITLE'),
    ACTIVATE_CUSTOM_FIELDS: fromEnv('ACTIVATE_CUSTOM_FIELDS'),
    CUSTOM_FIELDS: fromEnv('CUSTOM_FIELDS'),
    MISTRAL_OCR_ENABLED: input.mistralOcrEnabled ? 'yes' : 'no',
    OCR_PROVIDER: input.ocrProvider,
    OCR_API_URL: input.ocrApiUrl,
    OCR_API_KEY: input.ocrApiKey,
    // An Anthropic key must not land where Mistral OCR would read it.
    MISTRAL_API_KEY: input.ocrProvider === 'anthropic' ? '' : input.ocrApiKey,
    MISTRAL_OCR_MODEL: input.mistralOcrModel,
    SETUP_VALIDATION_TIMEOUT_MS: String(input.setupValidationTimeoutMs),
    SETUP_OCR_VALIDATION_TIMEOUT_MS: String(input.setupOcrValidationTimeoutMs),
  };

  const { aiProvider, aiApiUrl, aiToken, aiModel } = input;
  if (aiProvider === 'openai') {
    config.OPENAI_API_KEY = aiToken;
    config.OPENAI_MODEL = aiModel || defaultOf('OPENAI_MODEL');
  } else if (aiProvider === 'ollama') {
    config.OLLAMA_API_URL = aiApiUrl || defaultOf('OLLAMA_API_URL');
    config.OLLAMA_API_KEY = aiToken;
    config.OLLAMA_MODEL = aiModel || defaultOf('OLLAMA_MODEL');
  } else if (aiProvider === 'azure') {
    config.AZURE_ENDPOINT = aiApiUrl;
    config.AZURE_API_KEY = aiToken;
    config.AZURE_DEPLOYMENT_NAME = aiModel;
    config.AZURE_API_VERSION = input.aiAzureApiVersion;
  } else if (aiProvider === 'anthropic') {
    config.ANTHROPIC_API_KEY = aiToken;
    config.ANTHROPIC_MODEL = aiModel || defaultOf('ANTHROPIC_MODEL');
    // Only a proxy needs one; leaving it out keeps api.anthropic.com.
    if (aiApiUrl) config.ANTHROPIC_API_URL = aiApiUrl;
  } else {
    config.CUSTOM_BASE_URL = aiApiUrl;
    config.CUSTOM_API_KEY = aiToken;
    config.CUSTOM_MODEL = aiModel;
  }
  return config;
}

/* ── The .env export ──────────────────────────────────────────────────── */

/**
 * A value only needs quoting when it carries something a .env parser would
 * otherwise eat — whitespace, a comment marker or a quote of its own.
 *
 * @param {unknown} value
 * @returns {string}
 */
function quoteEnvValue(value) {
  const text = String(value);
  if (!/[\s"'#]/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The running configuration as a .env file, grouped the way the settings
 * page is. It exports what an operator needs to reproduce the instance
 * elsewhere: the catalogue's exported keys that are set, not a dump of the
 * environment (which also holds the container's own variables). JWT_SECRET
 * is deliberately absent — a fresh instance mints its own.
 *
 * @param {Env} [env]
 * @returns {{ env: string, count: number }}
 */
function buildEnvExport(env = process.env) {
  /** @type {string[]} */
  const lines = [];
  let count = 0;

  settingsCatalog.exportGroups().forEach((group) => {
    const present = group.keys.filter(
      (key) => env[key] !== undefined && String(env[key]).length > 0
    );
    if (present.length === 0) return;

    if (lines.length > 0) lines.push('');
    lines.push(`# ${group.title}`);
    present.forEach((key) => {
      lines.push(`${key}=${quoteEnvValue(env[key])}`);
      count += 1;
    });
  });

  return { env: lines.join('\n'), count };
}

module.exports = {
  currentSettings,
  resolveOcrSettings,
  buildOcrUpdate,
  parseCustomFields,
  checkCustomFieldConflicts,
  resolvePaperlessConnection,
  buildProviderUpdate,
  buildAnthropicUpdate,
  buildFieldUpdates,
  buildOidcSettingsUpdate,
  buildSettingsUpdate,
  planSave,
  pageConfig,
  buildInitialSetupConfig,
  quoteEnvValue,
  buildEnvExport,
};
