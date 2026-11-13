// @ts-check
'use strict';

/**
 * The one list of settings keys.
 *
 * Every environment key the settings page shows, the settings save writes,
 * the setup wizard prefills or the .env export lists has exactly one entry
 * here. The surfaces derive their key lists from it:
 *
 *   - GET /settings shows the entries marked `page`, each with its default
 *   - POST /settings starts from the entries marked `save` (the values in
 *     effect) and runs the `parse` of every entry that has one
 *   - GET /setup prefills the entries marked `wizard`
 *   - the .env export lists the entries with a `group`, grouped in the order
 *     the groups first appear here
 *   - config/restartRequiredKeys.js is the entries marked `restart`
 *   - the settings page masks the entries marked `secret`
 *
 * Adding a setting therefore means: one entry here (with `field` and `parse`
 * when the page saves it), its `fieldMappings` line in public/js/settings.js,
 * and — for an AI option — its AI_OPTIONS entry. tests/test-settings-catalog.js
 * checks that those lists agree with this one.
 *
 * Entry order is the order of the .env export within a group. It also decides
 * which message a save reports first when several simple fields are invalid at
 * once.
 *
 * Nothing here reads process.env at load time: every helper takes the
 * environment as an argument, so a value saved on the settings page is seen
 * on the next call.
 */

const {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
} = require('./anthropicSupport');

/**
 * @typedef {'string'|'secret'|'boolean'|'integer'|'number'|'list'|'enum'|'url'|'cron'|'json'} SettingType
 */

/**
 * What a form value turns into. No `value` means "leave the setting as it is".
 *
 * @typedef {object} ParseResult
 * @property {unknown} [value] the value to save
 * @property {string} [error] refuses the whole save with this message (HTTP 400)
 * @property {string} [warning] logged, the save goes on
 */

/**
 * @callback SettingParser
 * @param {unknown} raw the form value (undefined when the body lacks the field)
 * @param {string|number} current the value in effect before the save
 * @returns {ParseResult}
 */

/**
 * @typedef {object} SettingEntry
 * @property {string} key environment variable
 * @property {SettingType} type
 * @property {string|number} default value the app uses when the variable is unset or empty
 * @property {string|null} group heading in the .env export; null = not exported
 * @property {boolean} secret masked on the settings page
 * @property {boolean} restart a change only takes effect after a restart
 * @property {boolean} page shown on the settings page (GET /settings)
 * @property {boolean} save carried by every settings save as the value in effect
 * @property {boolean} wizard prefilled by the setup wizard (GET /setup)
 * @property {string|number} [shownDefault] what the settings page and the wizard show when unset, where it differs from `default`
 * @property {string|number} [saveDefault] in-effect value a save assumes when unset, where it differs from `default`
 * @property {string|number} [wizardDefault] wizard value when unset, where it differs from `default`
 * @property {readonly string[]} [fallbackKeys] variables consulted, in order, when `key` is unset
 * @property {(value: unknown) => unknown} [view] how the pages show the value
 * @property {string} [field] settings form field that carries the value
 * @property {SettingParser} [parse] turns the form value into the value to save
 * @property {{ min: number, max: number, decimals?: number }} [range] clamping range of a number
 * @property {readonly string[]} [values] allowed values of an enum
 * @property {string} [readBy] the file that reads the key when config/config.js does not; 'legacy' when nothing does
 */

/* ── Form value parsers ───────────────────────────────────────────────── */

/**
 * Splits a list setting. Arrays are taken as they are; a string is split on
 * commas, every piece trimmed and then the empty ones dropped, so "a, ,b"
 * gives ['a', 'b'] and never an empty entry.
 *
 * @param {unknown} value
 * @returns {unknown[]}
 */
function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * The yes/no switches of the tidy-up options: the usual spellings, anything
 * else keeps the value in effect.
 *
 * @param {unknown} raw
 * @param {string|number} fallback
 * @returns {string}
 */
function sanitizeSwitch(raw, fallback) {
  const normalized = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (['yes', 'on', 'true', '1'].includes(normalized)) return 'yes';
  if (['no', 'off', 'false', '0'].includes(normalized)) return 'no';
  return String(fallback);
}

/**
 * The numbers of the tidy-up options: out of range is pulled into it, not a
 * number keeps the value in effect, so a cleared field cannot silently reset
 * the setting to its default.
 *
 * @param {unknown} raw
 * @param {string|number} fallback
 * @param {{ min: number, max: number, decimals?: number }} range
 * @returns {string}
 */
function clampNumber(raw, fallback, range) {
  const normalized = String(raw ?? '').trim();
  const parsed = Number.parseFloat(normalized);
  if (!normalized || !Number.isFinite(parsed)) {
    return String(fallback);
  }
  const clamped = Math.min(Math.max(parsed, range.min), range.max);
  return range.decimals
    ? String(Number(clamped.toFixed(range.decimals)))
    : String(Math.round(clamped));
}

/** @type {SettingParser} */
const truthyAsIs = (raw) => (raw ? { value: raw } : {});

/** @type {SettingParser} */
const trimmedString = (raw) =>
  typeof raw === 'string' ? { value: raw.trim() } : {};

/** @type {SettingParser} */
const nonEmptyTrimmedString = (raw) =>
  typeof raw === 'string' && raw.trim() ? { value: raw.trim() } : {};

/** @type {SettingParser} */
const yesNoString = (raw) => {
  if (typeof raw !== 'string') return {};
  const normalized = raw.trim().toLowerCase();
  return ['yes', 'no'].includes(normalized) ? { value: normalized } : {};
};

/** @type {SettingParser} */
const listWhenPresent = (raw) =>
  raw !== undefined ? { value: normalizeList(raw) } : {};

/** @type {SettingParser} */
const switchWhenPresent = (raw, current) =>
  raw !== undefined ? { value: sanitizeSwitch(raw, current) } : {};

/**
 * @param {{ min: number, max: number, decimals?: number }} range
 * @returns {SettingParser}
 */
const clampedWhenPresent = (range) => (raw, current) =>
  raw !== undefined ? { value: clampNumber(raw, current, range) } : {};

/**
 * A checkbox: anything truthy is yes, a missing field is no.
 *
 * @type {SettingParser}
 */
const checkbox = (raw) => ({ value: raw ? 'yes' : 'no' });

/**
 * Only the literal 'on' or 'yes' is yes; a missing field is no.
 *
 * @type {SettingParser}
 */
const onOrYes = (raw) => ({
  value: raw === 'on' || raw === 'yes' ? 'yes' : 'no',
});

/**
 * Always written: the field, or `fallback` when it is empty or missing.
 *
 * @param {string} fallback
 * @returns {SettingParser}
 */
const alwaysOr = (fallback) => (raw) => ({ value: raw || fallback });

/**
 * A whole number in a range; anything else is replaced by `fallback` with a
 * warning.
 *
 * @param {string} key
 * @param {number} min
 * @param {number} max
 * @param {string} fallback
 * @returns {SettingParser}
 */
const intInRangeOrDefault = (key, min, max, fallback) => (raw) => {
  if (raw === undefined) return {};
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isNaN(parsed) && parsed >= min && parsed <= max) {
    return { value: parsed.toString() };
  }
  return {
    value: fallback,
    warning: `[WARN] Invalid ${key} value: ${raw}. Using default: ${fallback}`,
  };
};

/**
 * A temperature between 0 and 2; empty or invalid keeps the value in effect.
 *
 * @param {string} key
 * @returns {SettingParser}
 */
const temperature = (key) => (raw, current) => {
  if (raw === undefined) return {};
  const normalized = String(raw ?? '').trim();
  if (!normalized) return { value: current };
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    return {
      value: current,
      warning: `[WARN] Invalid ${key} value: ${normalized}. Using fallback: ${current}`,
    };
  }
  return { value: String(parsed) };
};

/**
 * Lazily required: node-cron is only needed while a save is parsed.
 *
 * @param {string} pattern
 * @returns {boolean}
 */
function isValidCron(pattern) {
  return require('node-cron').validate(pattern);
}

/** @param {unknown} value */
const stripApiSuffix = (value) => String(value).replace(/\/api$/, '');

/* ── The catalogue ────────────────────────────────────────────────────── */

/**
 * @typedef {Omit<Partial<SettingEntry>, 'key'> & { type: SettingType, default: string|number }} EntryOptions
 */

/** @type {string|null} */
let currentGroup = null;

/**
 * @param {string} key
 * @param {EntryOptions} options
 * @returns {SettingEntry}
 */
function setting(key, options) {
  return Object.freeze({
    key,
    group: currentGroup,
    secret: options.type === 'secret',
    restart: false,
    page: false,
    save: false,
    wizard: false,
    ...options,
  });
}

/**
 * A number of the tidy-up options: clamped into `range`, shown and saved.
 *
 * @param {string} key
 * @param {{ default: string, field: string, range: { min: number, max: number, decimals?: number } }} options
 * @returns {SettingEntry}
 */
function clampedSetting(key, { default: def, field, range }) {
  return setting(key, {
    type: range.decimals ? 'number' : 'integer',
    default: def,
    field,
    range,
    parse: clampedWhenPresent(range),
    page: true,
    save: true,
  });
}

/**
 * @param {string|null} title
 * @param {() => SettingEntry[]} build
 * @returns {SettingEntry[]}
 */
function section(title, build) {
  currentGroup = title;
  const entries = build();
  currentGroup = null;
  return entries;
}

/** The surfaces a key appears on: page, save, wizard. */
const PSW = { page: true, save: true, wizard: true };
const PS = { page: true, save: true };
const PAGE_ONLY = { page: true };
const NOT_EXPORTED = { group: null };

/** @type {ReadonlyArray<SettingEntry>} */
const CATALOG = Object.freeze([
  ...section('Paperless-ngx connection', () => [
    setting('PAPERLESS_API_URL', {
      type: 'url',
      default: 'http://localhost:8000',
      saveDefault: '',
      view: stripApiSuffix,
      field: 'paperlessUrl',
      // paperlessService builds its HTTP client once from these and keeps
      // the tag, correspondent and custom field ids it read from it.
      restart: true,
      ...PSW,
    }),
    setting('PAPERLESS_PUBLIC_URL', {
      type: 'url',
      default: '',
      field: 'paperlessPublicUrl',
      parse: trimmedString,
      readBy: 'services/paperlessService.js',
      ...PS,
    }),
    setting('PAPERLESS_API_TOKEN', {
      type: 'secret',
      default: '',
      field: 'paperlessToken',
      restart: true,
      ...PSW,
    }),
    setting('PAPERLESS_USERNAME', {
      type: 'string',
      default: '',
      field: 'paperlessUsername',
      parse: truthyAsIs,
      readBy: 'services/paperlessService.js',
      ...PSW,
    }),
    // The connectivity probe's setInterval is started once at boot.
    setting('PAPERLESS_PROBE_INTERVAL_SECONDS', {
      type: 'integer',
      default: '60',
      restart: true,
    }),
    setting('PAPERLESS_REQUEST_TIMEOUT_SECONDS', {
      type: 'integer',
      default: '30',
      restart: true,
    }),
    setting('STARTUP_PAPERLESS_RETRY_MINUTES', {
      type: 'integer',
      default: '30',
    }),
  ]),

  ...section('Document processing', () => [
    // Cron schedules registered at boot by startScanning() in server.js, and
    // the switches that decide whether each one is registered at all.
    setting('SCAN_INTERVAL', {
      type: 'cron',
      default: '*/30 * * * *',
      field: 'scanInterval',
      parse: truthyAsIs,
      restart: true,
      ...PSW,
    }),
    setting('DISABLE_AUTOMATIC_PROCESSING', {
      type: 'boolean',
      default: 'no',
      field: 'disableAutomaticProcessing',
      parse: truthyAsIs,
      restart: true,
      ...PSW,
    }),
    setting('PROCESS_PREDEFINED_DOCUMENTS', {
      type: 'boolean',
      default: 'no',
      field: 'showTags',
      parse: truthyAsIs,
      ...PSW,
    }),
    setting('TAGS', {
      type: 'list',
      default: '',
      field: 'tags',
      parse: listWhenPresent,
      ...PSW,
    }),
    setting('IGNORE_TAGS', {
      type: 'list',
      default: '',
      field: 'ignoreTags',
      parse: listWhenPresent,
      ...PSW,
    }),
    setting('REMOVE_INBOX_TAGS_AFTER_PROCESSING', {
      type: 'boolean',
      default: 'no',
      field: 'removeInboxTagsAfterProcessing',
      parse: (raw) =>
        raw === undefined
          ? {}
          : {
              value: ['yes', 'true', '1', 'on'].includes(
                String(raw).trim().toLowerCase()
              )
                ? 'yes'
                : 'no',
            },
      ...PSW,
    }),
    setting('REMOVE_TAGS_AFTER_PROCESSING', {
      type: 'list',
      default: '',
      field: 'removeTags',
      parse: listWhenPresent,
      ...PS,
    }),
    setting('ADD_AI_PROCESSED_TAG', {
      type: 'boolean',
      default: 'no',
      field: 'aiProcessedTag',
      parse: truthyAsIs,
      ...PSW,
    }),
    setting('AI_PROCESSED_TAG_NAME', {
      type: 'string',
      default: 'ai-processed',
      field: 'aiTagName',
      parse: truthyAsIs,
      ...PSW,
    }),
    // Live: services/documentPipeline.js reads it for every document, so a
    // saved value applies to the next one without a restart.
    setting('MIN_CONTENT_LENGTH', {
      type: 'integer',
      default: '10',
      field: 'minContentLength',
      parse: truthyAsIs,
      restart: false,
      ...PS,
    }),
    setting('MAX_PAGE_COUNT', {
      type: 'integer',
      default: '0',
      field: 'maxPageCount',
      parse: (raw) => {
        if (raw === undefined) return {};
        const pages = String(raw).trim();
        if (pages === '') return { value: '0' };
        if (/^\d+$/.test(pages)) {
          return { value: String(Number.parseInt(pages, 10)) };
        }
        return {
          error:
            'Invalid page limit. Use a whole number of pages, or 0 for no limit.',
        };
      },
      ...PS,
    }),
    setting('IGNORE_TITLE_PATTERNS', {
      type: 'list',
      default: '',
      field: 'ignoreTitlePatterns',
      parse: (raw) =>
        raw !== undefined ? { value: normalizeList(raw).join(',') } : {},
      ...PS,
    }),
    setting('IGNORE_REPEATED_CONTENT', {
      type: 'boolean',
      default: 'yes',
      field: 'ignoreRepeatedContent',
      parse: (raw) =>
        raw !== undefined ? { value: raw === 'no' ? 'no' : 'yes' } : {},
      ...PS,
    }),
    setting('USE_EXISTING_DATA', {
      type: 'boolean',
      default: 'no',
      field: 'useExistingData',
      parse: truthyAsIs,
      ...PSW,
    }),
    // Shown on the pages (the settings page with a single space when unset),
    // read by nothing any more.
    setting('PROCESS_ONLY_NEW_DOCUMENTS', {
      type: 'boolean',
      default: ' ',
      wizardDefault: 'yes',
      readBy: 'legacy',
      page: true,
      wizard: true,
      ...NOT_EXPORTED,
    }),
  ]),

  ...section('AI provider', () => [
    setting('AI_PROVIDER', {
      type: 'enum',
      default: 'openai',
      saveDefault: '',
      values: ['openai', 'ollama', 'custom', 'azure', 'anthropic'],
      field: 'aiProvider',
      ...PSW,
    }),
    setting('OPENAI_API_KEY', {
      type: 'secret',
      default: '',
      field: 'openaiKey',
      ...PSW,
    }),
    setting('OPENAI_MODEL', {
      type: 'string',
      default: 'gpt-4o-mini',
      saveDefault: '',
      field: 'openaiModel',
      readBy: 'services/openaiCompatibleService.js',
      ...PSW,
    }),
    setting('OLLAMA_API_URL', {
      type: 'url',
      default: 'http://localhost:11434',
      saveDefault: '',
      field: 'ollamaUrl',
      ...PSW,
    }),
    setting('OLLAMA_API_KEY', {
      type: 'secret',
      default: '',
      field: 'ollamaApiKey',
      ...PS,
    }),
    setting('OLLAMA_MODEL', {
      type: 'string',
      default: 'llama3.2',
      saveDefault: '',
      field: 'ollamaModel',
      ...PSW,
    }),
    setting('OLLAMA_THINK', {
      type: 'boolean',
      default: 'false',
      field: 'ollamaThink',
      ...PAGE_ONLY,
    }),
    setting('CUSTOM_BASE_URL', {
      type: 'url',
      default: '',
      field: 'customBaseUrl',
      ...PS,
    }),
    setting('CUSTOM_API_KEY', {
      type: 'secret',
      default: '',
      field: 'customApiKey',
      ...PS,
    }),
    setting('CUSTOM_MODEL', {
      type: 'string',
      default: '',
      field: 'customModel',
      ...PS,
    }),
    setting('AZURE_ENDPOINT', {
      type: 'url',
      default: '',
      field: 'azureEndpoint',
      ...PSW,
    }),
    setting('AZURE_API_KEY', {
      type: 'secret',
      default: '',
      field: 'azureApiKey',
      ...PSW,
    }),
    setting('AZURE_DEPLOYMENT_NAME', {
      type: 'string',
      default: '',
      field: 'azureDeploymentName',
      ...PSW,
    }),
    setting('AZURE_API_VERSION', {
      type: 'string',
      default: '2023-05-15',
      // The pages show an empty field and a save keeps it empty; the provider
      // then uses the default.
      shownDefault: '',
      saveDefault: '',
      field: 'azureApiVersion',
      ...PSW,
    }),
    setting('ANTHROPIC_API_KEY', {
      type: 'secret',
      default: '',
      field: 'anthropicApiKey',
      ...PSW,
    }),
    setting('ANTHROPIC_API_URL', {
      type: 'url',
      default: '',
      field: 'anthropicApiUrl',
      ...PSW,
    }),
    setting('ANTHROPIC_MODEL', {
      type: 'string',
      default: ANTHROPIC_DEFAULT_MODEL,
      field: 'anthropicModel',
      ...PSW,
    }),
    setting('ANTHROPIC_EFFORT', {
      type: 'enum',
      default: '',
      field: 'anthropicEffort',
      ...PS,
    }),
    setting('ANTHROPIC_MAX_TOKENS', {
      type: 'integer',
      default: String(ANTHROPIC_DEFAULT_MAX_TOKENS),
      field: 'anthropicMaxTokens',
      ...PS,
    }),
    setting('ANTHROPIC_STRUCTURED_OUTPUT', {
      type: 'boolean',
      default: 'yes',
      field: 'anthropicStructuredOutput',
      ...PS,
    }),
    setting('ANTHROPIC_PROMPT_CACHING', {
      type: 'boolean',
      default: 'yes',
      field: 'anthropicPromptCaching',
      ...PS,
    }),
  ]),

  ...section('AI behaviour', () => [
    setting('TOKEN_LIMIT', {
      type: 'integer',
      default: 128000,
      field: 'tokenLimit',
      // Stricter than Number.parseInt() on purpose: "128k" must not be read
      // as 128 and cap every prompt at 128 tokens.
      parse: (raw) => {
        if (!raw) return {};
        const normalized = String(raw).trim();
        if (!/^\d+$/.test(normalized) || Number(normalized) < 1) {
          return {
            error: 'Invalid Token Limit. Expected a positive whole number.',
          };
        }
        return { value: String(Number(normalized)) };
      },
      ...PSW,
    }),
    setting('RESPONSE_TOKENS', {
      type: 'integer',
      default: 1000,
      field: 'responseTokens',
      parse: (raw) => {
        if (!raw) return {};
        const parsed = Number.parseInt(String(raw).trim(), 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          return {
            error: 'Invalid Response Tokens. Expected a positive whole number.',
          };
        }
        return { value: String(parsed) };
      },
      ...PSW,
    }),
    setting('AI_TEMPERATURE_ANALYSIS', {
      type: 'number',
      default: '0.3',
      field: 'aiTemperatureAnalysis',
      parse: temperature('AI_TEMPERATURE_ANALYSIS'),
      ...PS,
    }),
    setting('AI_TEMPERATURE_GENERATION', {
      type: 'number',
      default: '0.7',
      field: 'aiTemperatureGeneration',
      parse: temperature('AI_TEMPERATURE_GENERATION'),
      ...PS,
    }),
    setting('SYSTEM_PROMPT', {
      type: 'string',
      default: '',
      field: 'systemPrompt',
      // Equals signs are dropped and line breaks stored as a literal \n.
      parse: (raw) =>
        raw
          ? {
              value: /** @type {string} */ (raw)
                .replace(/\r\n/g, '\n')
                .replace(/=/g, '')
                .replace(/\r\n/g, '\n')
                .replace(/\n/g, '\\n'),
            }
          : {},
      readBy: 'services/analysisPrompt.js',
      ...PSW,
    }),
    setting('USE_PROMPT_TAGS', {
      type: 'boolean',
      default: 'no',
      field: 'usePromptTags',
      parse: truthyAsIs,
      readBy: 'services/openaiCompatibleService.js',
      ...PSW,
      ...NOT_EXPORTED,
    }),
    setting('PROMPT_TAGS', {
      type: 'list',
      default: '',
      field: 'promptTags',
      parse: (raw) => (raw ? { value: normalizeList(raw) } : {}),
      ...PSW,
    }),
    setting('ACTIVATE_TAGGING', {
      type: 'boolean',
      default: 'yes',
      field: 'activateTagging',
      parse: checkbox,
      ...PS,
    }),
    setting('ACTIVATE_CORRESPONDENTS', {
      type: 'boolean',
      default: 'yes',
      field: 'activateCorrespondents',
      parse: checkbox,
      ...PS,
    }),
    setting('ACTIVATE_DOCUMENT_TYPE', {
      type: 'boolean',
      default: 'yes',
      field: 'activateDocumentType',
      parse: checkbox,
      ...PS,
    }),
    setting('ACTIVATE_TITLE', {
      type: 'boolean',
      default: 'yes',
      field: 'activateTitle',
      parse: checkbox,
      ...PS,
    }),
    setting('ACTIVATE_CUSTOM_FIELDS', {
      type: 'boolean',
      default: 'yes',
      field: 'activateCustomFields',
      parse: checkbox,
      ...PS,
    }),
    setting('CUSTOM_FIELDS', {
      type: 'json',
      default: '{"custom_fields":[]}',
      field: 'customFields',
      ...PS,
    }),
    setting('RESTRICT_TO_EXISTING_TAGS', {
      type: 'boolean',
      default: 'no',
      field: 'restrictToExistingTags',
      parse: onOrYes,
      ...PS,
    }),
    setting('RESTRICT_TO_EXISTING_CORRESPONDENTS', {
      type: 'boolean',
      default: 'no',
      field: 'restrictToExistingCorrespondents',
      parse: onOrYes,
      ...PS,
    }),
    setting('RESTRICT_TO_EXISTING_DOCUMENT_TYPES', {
      type: 'boolean',
      default: 'no',
      field: 'restrictToExistingDocumentTypes',
      parse: onOrYes,
      ...PS,
    }),
  ]),

  ...section('Duplicates', () => [
    setting('DUPLICATES_AI_REVIEW', {
      type: 'boolean',
      default: 'yes',
      field: 'duplicatesAiReview',
      parse: switchWhenPresent,
      ...PS,
    }),
    setting('DUPLICATES_AI_MODEL', {
      type: 'string',
      default: '',
      field: 'duplicatesAiModel',
      // Empty is meaningful: it hands the judge back to the provider's model.
      parse: trimmedString,
      ...PS,
    }),
    clampedSetting('DUPLICATES_AI_REVIEW_BATCH_SIZE', {
      default: '25',
      field: 'duplicatesAiReviewBatchSize',
      range: { min: 1, max: 100 },
    }),
    clampedSetting('DUPLICATES_AI_CANDIDATE_FLOOR', {
      default: '0.6',
      field: 'duplicatesAiCandidateFloor',
      range: { min: 0.5, max: 0.95, decimals: 2 },
    }),
    setting('DUPLICATES_AI_EXCERPTS', {
      type: 'boolean',
      default: 'yes',
      field: 'duplicatesAiExcerpts',
      parse: switchWhenPresent,
      ...PS,
    }),
    clampedSetting('DUPLICATES_AI_EXCERPT_CHARS', {
      default: '300',
      field: 'duplicatesAiExcerptChars',
      range: { min: 50, max: 500 },
    }),
    clampedSetting('DUPLICATES_AI_EXCERPT_DOCUMENTS', {
      default: '2',
      field: 'duplicatesAiExcerptDocuments',
      range: { min: 1, max: 5 },
    }),
    // The two brakes of a running review. Zero is meaningful for both: no
    // token limit, never stop an unwatched review.
    clampedSetting('DUPLICATES_AI_TOKEN_BUDGET', {
      default: '200000',
      field: 'duplicatesAiTokenBudget',
      range: { min: 0, max: 10000000 },
    }),
    clampedSetting('DUPLICATES_AI_IDLE_STOP_SECONDS', {
      default: '60',
      field: 'duplicatesAiIdleStopSeconds',
      range: { min: 0, max: 3600 },
    }),
    setting('DUPLICATES_AI_THINKING', {
      type: 'boolean',
      default: 'no',
      field: 'duplicatesAiThinking',
      parse: switchWhenPresent,
      ...PS,
    }),
    clampedSetting('DUPLICATES_AI_REQUEST_SECONDS', {
      default: '30',
      field: 'duplicatesAiRequestSeconds',
      range: { min: 5, max: 300 },
    }),
    // Zero is meaningful for both: the judge picks the lane count itself,
    // and no memory at all.
    clampedSetting('DUPLICATES_AI_CONCURRENCY', {
      default: '0',
      field: 'duplicatesAiConcurrency',
      range: { min: 0, max: 8 },
    }),
    clampedSetting('DUPLICATES_AI_VERDICT_MEMORY_DAYS', {
      default: '90',
      field: 'duplicatesAiVerdictMemoryDays',
      range: { min: 0, max: 365 },
    }),
    setting('DUPLICATES_GUARD_NEW_NAMES', {
      type: 'boolean',
      default: 'yes',
      field: 'duplicatesGuardNewNames',
      parse: switchWhenPresent,
      ...PS,
    }),
    clampedSetting('DUPLICATES_AI_SWEEP_NAMES', {
      default: '300',
      field: 'duplicatesAiSweepNames',
      range: { min: 50, max: 1000 },
    }),
  ]),

  ...section('Simplify tags', () => [
    clampedSetting('SIMPLIFY_TAGS_PER_REQUEST', {
      default: '50',
      field: 'simplifyTagsPerRequest',
      range: { min: 10, max: 200 },
    }),
    clampedSetting('SIMPLIFY_VOCABULARY_SIZE', {
      default: '25',
      field: 'simplifyVocabularySize',
      range: { min: 5, max: 100 },
    }),
  ]),

  ...section('External API', () => [
    setting('EXTERNAL_API_ENABLED', {
      type: 'boolean',
      default: 'no',
      field: 'externalApiEnabled',
      parse: onOrYes,
      ...PS,
    }),
    setting('EXTERNAL_API_URL', {
      type: 'url',
      default: '',
      field: 'externalApiUrl',
      parse: alwaysOr(''),
      ...PS,
    }),
    setting('EXTERNAL_API_METHOD', {
      type: 'enum',
      default: 'GET',
      field: 'externalApiMethod',
      parse: alwaysOr('GET'),
      ...PS,
    }),
    setting('EXTERNAL_API_HEADERS', {
      type: 'json',
      default: '{}',
      field: 'externalApiHeaders',
      parse: alwaysOr('{}'),
      ...PS,
    }),
    setting('EXTERNAL_API_BODY', {
      type: 'json',
      default: '{}',
      field: 'externalApiBody',
      parse: alwaysOr('{}'),
      ...PS,
    }),
    setting('EXTERNAL_API_TIMEOUT', {
      type: 'integer',
      default: '5000',
      field: 'externalApiTimeout',
      parse: alwaysOr('5000'),
      ...PS,
    }),
    setting('EXTERNAL_API_TRANSFORM', {
      type: 'string',
      default: '',
      field: 'externalApiTransform',
      parse: alwaysOr(''),
      ...PS,
    }),
    setting('EXTERNAL_API_ALLOW_PRIVATE_IPS', {
      type: 'boolean',
      default: 'no',
      field: 'externalApiAllowPrivateIps',
      parse: alwaysOr('no'),
      readBy: 'services/externalApiService.js',
      ...PS,
      ...NOT_EXPORTED,
    }),
  ]),

  ...section('OCR fallback', () => [
    setting('MISTRAL_OCR_ENABLED', {
      type: 'boolean',
      default: 'no',
      field: 'mistralOcrEnabled',
      restart: true,
      ...PSW,
    }),
    setting('OCR_PROVIDER', {
      type: 'enum',
      default: 'mistral',
      values: ['mistral', 'custom', 'ollama', 'anthropic'],
      field: 'ocrProvider',
      ...PSW,
    }),
    setting('OCR_API_URL', {
      type: 'url',
      default: '',
      field: 'ocrApiUrl',
      ...PSW,
    }),
    setting('OCR_API_KEY', {
      type: 'secret',
      default: '',
      field: 'ocrApiKey',
      ...PSW,
    }),
    setting('MISTRAL_API_KEY', {
      type: 'secret',
      default: '',
      field: 'mistralApiKey',
      ...PSW,
    }),
    setting('MISTRAL_OCR_MODEL', {
      type: 'string',
      default: 'mistral-ocr-latest',
      field: 'mistralOcrModel',
      ...PSW,
    }),
    setting('OCR_PDF_RENDER_ENABLED', {
      type: 'boolean',
      default: 'yes',
      field: 'ocrPdfRenderEnabled',
      parse: yesNoString,
      ...PS,
    }),
    setting('OCR_PDF_RENDER_MAX_PAGES', {
      type: 'integer',
      default: '10',
      field: 'ocrPdfRenderMaxPages',
      parse: intInRangeOrDefault('OCR_PDF_RENDER_MAX_PAGES', 1, 50, '10'),
      ...PS,
    }),
    setting('OCR_PDF_RENDER_DPI', {
      type: 'integer',
      default: '150',
      field: 'ocrPdfRenderDpi',
      parse: intInRangeOrDefault('OCR_PDF_RENDER_DPI', 72, 300, '150'),
      ...PS,
    }),
    setting('OCR_AUTO_PROCESS_ENABLED', {
      type: 'boolean',
      default: 'no',
      field: 'ocrAutoProcessEnabled',
      parse: yesNoString,
      restart: true,
      ...PS,
    }),
    setting('OCR_AUTO_PROCESS_INTERVAL', {
      type: 'cron',
      default: '*/15 * * * *',
      field: 'ocrAutoProcessInterval',
      // An invalid pattern makes cron.schedule() throw during startup, so it
      // is refused here instead of taking the app down on restart.
      parse: (raw) => {
        if (typeof raw !== 'string' || !raw.trim()) return {};
        const pattern = raw.trim();
        if (!isValidCron(pattern)) {
          return {
            error:
              'Invalid OCR Processing Interval. Use cron syntax, for example */15 * * * *.',
          };
        }
        return { value: pattern };
      },
      restart: true,
      ...PS,
    }),
    setting('OCR_AUTO_PROCESS_BATCH_SIZE', {
      type: 'integer',
      default: '10',
      field: 'ocrAutoProcessBatchSize',
      parse: intInRangeOrDefault('OCR_AUTO_PROCESS_BATCH_SIZE', 1, 100, '10'),
      ...PS,
    }),
    setting('OCR_AUTO_ANALYZE', {
      type: 'boolean',
      default: 'yes',
      field: 'ocrAutoAnalyze',
      parse: yesNoString,
      ...PS,
    }),
    setting('SETUP_OCR_VALIDATION_TIMEOUT_MS', {
      type: 'integer',
      default: '30000',
      fallbackKeys: ['SETUP_VALIDATION_TIMEOUT_MS'],
      field: 'ocrValidationTimeout',
      readBy: 'services/mistralOcrService.js',
      ...PSW,
    }),
    setting('SETUP_VALIDATION_TIMEOUT_MS', {
      type: 'integer',
      default: '30000',
      readBy: 'services/setupService.js',
      wizard: true,
      ...NOT_EXPORTED,
    }),
  ]),

  ...section('Server and security', () => [
    // Express app construction (server.js): app.listen(), app.set('trust
    // proxy'), the CSRF cookie options and the global rate limiter.
    setting('PAPERLESS_AI_PORT', {
      type: 'integer',
      default: '3000',
      field: 'paperlessAiPort',
      parse: truthyAsIs,
      restart: true,
      readBy: 'server.js',
      ...PS,
    }),
    setting('API_KEY', {
      type: 'secret',
      default: '',
      save: true,
    }),
    setting('TRUST_PROXY', {
      type: 'string',
      default: '',
      field: 'trustProxy',
      parse: trimmedString,
      restart: true,
      ...PS,
    }),
    setting('COOKIE_SECURE_MODE', {
      type: 'enum',
      default: 'auto',
      values: ['auto', 'always', 'never'],
      field: 'cookieSecureMode',
      parse: (raw) => {
        if (typeof raw !== 'string') return {};
        const mode = raw.trim().toLowerCase();
        return ['auto', 'always', 'never'].includes(mode)
          ? { value: mode }
          : {
              error:
                'Invalid Cookie Secure Mode. Allowed values: auto, always, never.',
            };
      },
      restart: true,
      ...PS,
    }),
    setting('GLOBAL_RATE_LIMIT_WINDOW_MS', {
      type: 'integer',
      default: '900000',
      field: 'globalRateLimitWindowMs',
      parse: truthyAsIs,
      restart: true,
      ...PS,
    }),
    setting('GLOBAL_RATE_LIMIT_MAX', {
      type: 'integer',
      default: '1000',
      field: 'globalRateLimitMax',
      parse: truthyAsIs,
      restart: true,
      ...PS,
    }),
    // The API docs routes are mounted or not at boot (server.js).
    setting('EXPOSE_API_DOCS', {
      type: 'boolean',
      default: 'no',
      restart: true,
    }),
    setting('CONFIG_SOURCE_MODE', {
      type: 'enum',
      default: 'runtime-first',
      values: ['runtime-first', 'legacy'],
    }),
  ]),

  ...section('Single sign-on (OIDC)', () => [
    setting('OIDC_ENABLED', {
      type: 'boolean',
      default: 'no',
      field: 'oidcEnabled',
      ...PAGE_ONLY,
    }),
    setting('OIDC_ISSUER_URL', {
      type: 'url',
      default: '',
      field: 'oidcIssuerUrl',
      ...PAGE_ONLY,
    }),
    setting('OIDC_CLIENT_ID', {
      type: 'string',
      default: '',
      field: 'oidcClientId',
      ...PAGE_ONLY,
    }),
    setting('OIDC_CLIENT_SECRET', {
      type: 'secret',
      default: '',
      field: 'oidcClientSecret',
      ...PAGE_ONLY,
    }),
    setting('OIDC_ADMIN_EMAIL', {
      type: 'string',
      default: '',
      field: 'oidcAdminEmail',
      ...PAGE_ONLY,
    }),
    setting('OIDC_REDIRECT_URI', {
      type: 'url',
      default: '',
      field: 'oidcRedirectUri',
      ...PAGE_ONLY,
    }),
    setting('OIDC_SCOPES', {
      type: 'string',
      default: 'openid profile email',
      field: 'oidcScopes',
      ...PAGE_ONLY,
    }),
    setting('OIDC_EMAIL_CLAIM', {
      type: 'string',
      default: 'email',
      field: 'oidcEmailClaim',
      ...PAGE_ONLY,
    }),
    setting('OIDC_ALLOW_UNVERIFIED_EMAIL', {
      type: 'boolean',
      default: 'no',
      field: 'oidcAllowUnverifiedEmail',
      ...PAGE_ONLY,
    }),
    setting('OIDC_TOKEN_AUTH_METHOD', {
      type: 'enum',
      default: '',
      field: 'oidcTokenAuthMethod',
      ...PAGE_ONLY,
    }),
    setting('OIDC_BUTTON_TEXT', {
      type: 'string',
      default: '',
      field: 'oidcButtonText',
      ...PAGE_ONLY,
    }),
    setting('OIDC_BUTTON_ICON', {
      type: 'string',
      default: '',
      field: 'oidcButtonIcon',
      ...PAGE_ONLY,
    }),
    setting('OIDC_BUTTON_COLOR', {
      type: 'string',
      default: '',
      field: 'oidcButtonColor',
      ...PAGE_ONLY,
    }),
    setting('OIDC_BUTTON_TEXT_COLOR', {
      type: 'string',
      default: '',
      field: 'oidcButtonTextColor',
      ...PAGE_ONLY,
    }),
  ]),

  ...section('Maintenance', () => [
    // Each logger takes its level when it is constructed.
    setting('LOG_LEVEL', {
      type: 'enum',
      default: 'info',
      values: ['debug', 'info', 'warn', 'error'],
      field: 'logLevel',
      parse: (raw) => {
        if (typeof raw !== 'string') return {};
        const level = raw.trim().toLowerCase();
        return ['debug', 'info', 'warn', 'error'].includes(level)
          ? { value: level }
          : {
              error:
                'Invalid Log Level. Allowed values: debug, info, warn, error.',
            };
      },
      restart: true,
      ...PS,
    }),
    setting('TAG_CACHE_TTL_SECONDS', {
      type: 'integer',
      default: '300',
      field: 'tagCacheTTL',
      parse: intInRangeOrDefault('TAG_CACHE_TTL_SECONDS', 60, 3600, '300'),
      ...PS,
    }),
    setting('RECONCILIATION_ENABLED', {
      type: 'boolean',
      default: 'yes',
      field: 'reconciliationEnabled',
      parse: yesNoString,
      restart: true,
      ...PS,
    }),
    setting('RECONCILIATION_INTERVAL', {
      type: 'cron',
      default: '0 * * * *',
      field: 'reconciliationInterval',
      parse: nonEmptyTrimmedString,
      restart: true,
      ...PS,
    }),
    setting('UPDATE_CHECK_ENABLED', { type: 'boolean', default: 'yes' }),
    setting('HEALTHCHECK_STRICT', { type: 'boolean', default: 'yes' }),
    setting('HEALTH_SCAN_FAILURE_THRESHOLD', {
      type: 'integer',
      default: '3',
    }),
    setting('ANONYMIZED_TELEMETRY', { type: 'boolean', default: '' }),
  ]),

  ...section('Interface', () => [
    setting('DATE_FORMAT', {
      type: 'enum',
      default: 'DD.MM.YYYY',
      values: ['DD.MM.YYYY', 'YYYY-MM-DD'],
      field: 'dateFormat',
      // Upper-cased first: an operator typing dd.mm.yyyy into the .env file
      // means the same thing the select does.
      parse: (raw) => {
        if (typeof raw !== 'string') return {};
        const format = raw.trim().toUpperCase();
        return ['DD.MM.YYYY', 'YYYY-MM-DD'].includes(format)
          ? { value: format }
          : {
              error:
                'Invalid Date Format. Allowed values: DD.MM.YYYY, YYYY-MM-DD.',
            };
      },
      ...PS,
    }),
  ]),
]);

/** @type {ReadonlyMap<string, SettingEntry>} */
const BY_KEY = new Map(CATALOG.map((entry) => [entry.key, entry]));

/* ── Lookups ──────────────────────────────────────────────────────────── */

/** @returns {ReadonlyArray<SettingEntry>} every entry, in catalogue order */
function getCatalog() {
  return CATALOG;
}

/**
 * @param {string} key
 * @returns {SettingEntry|undefined}
 */
function getEntry(key) {
  return BY_KEY.get(key);
}

/**
 * @param {string} key
 * @returns {SettingEntry}
 */
function requireEntry(key) {
  const entry = BY_KEY.get(key);
  if (!entry) throw new Error(`Unknown setting: ${key}`);
  return entry;
}

/** @returns {string[]} the keys whose change needs a restart */
function restartKeys() {
  return CATALOG.filter((entry) => entry.restart).map((entry) => entry.key);
}

/** @returns {string[]} the keys the settings page never echoes back */
function secretKeys() {
  return CATALOG.filter((entry) => entry.secret).map((entry) => entry.key);
}

/**
 * The .env export groups: titles in the order they first appear, keys in
 * catalogue order.
 *
 * @returns {{ title: string, keys: string[] }[]}
 */
function exportGroups() {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const entry of CATALOG) {
    if (!entry.group) continue;
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    /** @type {string[]} */ (groups.get(entry.group)).push(entry.key);
  }
  return [...groups].map(([title, keys]) => ({ title, keys }));
}

/* ── Values from the environment ──────────────────────────────────────── */

/**
 * @typedef {'page'|'save'|'wizard'} Surface
 */

/**
 * The value of a setting as one surface sees it: the variable (or its
 * fallbacks) when set and non-empty, otherwise the surface's default. No view
 * transformation is applied.
 *
 * @param {string} key
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @param {Surface} [surface]
 * @returns {string|number}
 */
function valueFromEnv(key, env = process.env, surface = 'page') {
  const entry = requireEntry(key);
  for (const name of [entry.key, ...(entry.fallbackKeys || [])]) {
    const value = env[name];
    if (value) return value;
  }
  if (surface === 'save' && entry.saveDefault !== undefined) {
    return entry.saveDefault;
  }
  if (surface === 'wizard' && entry.wizardDefault !== undefined) {
    return entry.wizardDefault;
  }
  if (surface !== 'save' && entry.shownDefault !== undefined) {
    return entry.shownDefault;
  }
  return entry.default;
}

/**
 * How the pages show a value: lists as arrays, plus the entry's own view.
 *
 * @param {SettingEntry} entry
 * @param {unknown} value
 * @returns {unknown}
 */
function toView(entry, value) {
  if (entry.type === 'list') return normalizeList(value);
  return entry.view ? entry.view(value) : value;
}

/**
 * Every setting one surface carries, read from `env` with its defaults:
 *
 *   - 'page': what GET /settings shows (lists as arrays)
 *   - 'wizard': what GET /setup prefills (lists as arrays)
 *   - 'save': the values in effect a settings save starts from (as stored)
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @param {Surface} [surface]
 * @returns {Record<string, unknown>}
 */
function defaultsFromEnv(env = process.env, surface = 'page') {
  /** @type {Record<string, unknown>} */
  const values = {};
  for (const entry of CATALOG) {
    if (!entry[surface]) continue;
    const value = valueFromEnv(entry.key, env, surface);
    values[entry.key] = surface === 'save' ? value : toView(entry, value);
  }
  return values;
}

/**
 * Applies the pages' view to a saved configuration (runtime overrides): the
 * Paperless URL without /api, and every list of the surface as an array —
 * also a list the saved configuration lacks, which then shows empty.
 *
 * @param {Record<string, unknown>} saved
 * @param {'page'|'wizard'} surface
 * @returns {Record<string, unknown>} the same object
 */
function viewSavedConfig(saved, surface) {
  if (saved.PAPERLESS_API_URL) {
    saved.PAPERLESS_API_URL = stripApiSuffix(saved.PAPERLESS_API_URL);
  }
  for (const entry of CATALOG) {
    if (entry[surface] && entry.type === 'list') {
      saved[entry.key] = normalizeList(saved[entry.key]);
    }
  }
  return saved;
}

module.exports = {
  getCatalog,
  getEntry,
  restartKeys,
  secretKeys,
  exportGroups,
  valueFromEnv,
  defaultsFromEnv,
  viewSavedConfig,
  normalizeList,
  sanitizeSwitch,
  clampNumber,
};
