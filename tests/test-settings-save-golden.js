'use strict';

/**
 * Golden test of the settings surfaces: POST /settings, GET /settings,
 * GET /setup, POST /api/setup/complete and the .env export.
 *
 * Why this exists: the settings keys used to be kept by hand in five places,
 * and the save handler was some 1,200 lines of special cases. Before those were
 * replaced by one catalogue and a thin handler, this test recorded what every
 * surface did — the exact values handed to setupService.saveConfig(), the
 * response, whether a restart was requested, the warnings logged, and what the
 * pages were given to render — so the rewrite can be shown to change nothing.
 *
 * The recordings live in tests/fixtures/settings-golden.json. To re-record
 * after a deliberate behaviour change (and only then):
 *
 *   GOLDEN_RECORD=1 node tests/test-settings-save-golden.js
 *
 * Not part of the contract, and therefore normalised before comparing: the
 * order of keys inside an object, the order of restartKeys and lockedEnvKeys
 * (both are sets), the order of logged warnings, the app version and the
 * Anthropic model defaults (they change with releases, not with this code).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Read before the environment is cleared below.
const RECORD = process.env.GOLDEN_RECORD === '1';

// A clean, predictable environment: nothing from the shell running the test
// may leak into the recorded values.
const KEEP_ENV = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'SYSTEMROOT',
  'SystemRoot',
]);
for (const key of Object.keys(process.env)) {
  if (!KEEP_ENV.has(key)) delete process.env[key];
}
// Nothing is pinned by the container unless a scenario says so. config.js
// keeps this object and asks it on every call, so scenarios can change it.
const PINNED = {};
global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = PINNED;

const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'settings-golden.json');
const API_KEY = 'test-api-key';

/* ── The environment of a configured instance ─────────────────────────── */

const BASE_ENV = {
  PAPERLESS_API_URL: 'http://paperless.local:8000',
  PAPERLESS_API_TOKEN: 'stored-paperless-token',
  PAPERLESS_USERNAME: 'archivist',
  AI_PROVIDER: 'openai',
  OPENAI_API_KEY: 'stored-openai-key',
  OPENAI_MODEL: 'gpt-4o-mini',
  API_KEY,
  JWT_SECRET: 'test-jwt-secret-for-router-harness',
};

/* ── What the settings page submits when nothing was touched ──────────── */

const PAGE_BODY = {
  paperlessUrl: 'http://paperless.local:8000',
  paperlessPublicUrl: '',
  paperlessToken: '',
  paperlessUsername: 'archivist',
  aiProvider: 'openai',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  ollamaUrl: 'http://localhost:11434',
  ollamaApiKey: '',
  ollamaModel: 'llama3.2',
  ollamaThink: 'no',
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  azureEndpoint: '',
  azureApiKey: '',
  azureDeploymentName: '',
  azureApiVersion: '',
  anthropicApiKey: '',
  anthropicModel: 'claude-test-model',
  anthropicEffort: '',
  anthropicMaxTokens: '',
  anthropicStructuredOutput: 'yes',
  anthropicPromptCaching: 'yes',
  anthropicApiUrl: '',
  scanInterval: '*/30 * * * *',
  reconciliationEnabled: 'no',
  reconciliationInterval: '0 * * * *',
  systemPrompt: 'You are a document assistant.',
  showTags: 'no',
  tokenLimit: '128000',
  responseTokens: '1000',
  aiTemperatureAnalysis: '0.3',
  aiTemperatureGeneration: '0.7',
  tags: '',
  ignoreTags: '',
  removeInboxTagsAfterProcessing: 'no',
  removeTags: '',
  aiProcessedTag: 'no',
  aiTagName: 'ai-processed',
  usePromptTags: 'no',
  promptTags: '',
  useExistingData: 'no',
  activateTagging: 'yes',
  activateCorrespondents: 'yes',
  activateDocumentType: 'yes',
  activateTitle: 'yes',
  activateCustomFields: 'yes',
  customFields: '{"custom_fields":[]}',
  disableAutomaticProcessing: 'yes',
  duplicatesAiReview: 'yes',
  duplicatesAiModel: '',
  duplicatesAiReviewBatchSize: '25',
  duplicatesAiCandidateFloor: '0.6',
  duplicatesAiExcerpts: 'yes',
  duplicatesAiExcerptChars: '300',
  duplicatesAiExcerptDocuments: '2',
  duplicatesAiTokenBudget: '200000',
  duplicatesAiIdleStopSeconds: '60',
  duplicatesAiThinking: 'no',
  duplicatesAiRequestSeconds: '30',
  duplicatesAiConcurrency: '0',
  duplicatesAiVerdictMemoryDays: '90',
  duplicatesGuardNewNames: 'yes',
  duplicatesAiSweepNames: '300',
  simplifyTagsPerRequest: '50',
  simplifyVocabularySize: '25',
  restrictToExistingTags: 'no',
  restrictToExistingCorrespondents: 'no',
  restrictToExistingDocumentTypes: 'no',
  externalApiEnabled: 'no',
  externalApiUrl: '',
  externalApiMethod: 'GET',
  externalApiHeaders: '{}',
  externalApiBody: '{}',
  externalApiTimeout: '5000',
  externalApiTransform: '',
  externalApiAllowPrivateIps: 'no',
  tagCacheTTL: '300',
  mistralOcrEnabled: 'no',
  ocrProvider: 'mistral',
  ocrApiUrl: '',
  ocrApiKey: '',
  mistralApiKey: '',
  mistralOcrModel: 'mistral-ocr-latest',
  ocrValidationTimeout: '30',
  ocrPdfRenderEnabled: 'yes',
  ocrPdfRenderMaxPages: '10',
  ocrPdfRenderDpi: '150',
  ocrAutoProcessEnabled: 'no',
  ocrAutoProcessInterval: '*/15 * * * *',
  ocrAutoProcessBatchSize: '10',
  ocrAutoAnalyze: 'yes',
  globalRateLimitWindowMs: '900000',
  globalRateLimitMax: '1000',
  trustProxy: '',
  cookieSecureMode: 'auto',
  minContentLength: '10',
  maxPageCount: '0',
  ignoreTitlePatterns: '',
  ignoreRepeatedContent: 'yes',
  paperlessAiPort: '3000',
  logLevel: 'error',
  dateFormat: 'DD.MM.YYYY',
  oidcEnabled: 'no',
  oidcIssuerUrl: '',
  oidcClientId: '',
  oidcClientSecret: '',
  oidcAdminEmail: '',
  oidcRedirectUri: '',
  oidcScopes: 'openid profile email',
  oidcEmailClaim: 'email',
  oidcAllowUnverifiedEmail: 'no',
  oidcTokenAuthMethod: '',
  oidcButtonText: '',
  oidcButtonIcon: '',
  oidcButtonColor: '',
  oidcButtonTextColor: '',
};

const page = (overrides) => ({ ...PAGE_BODY, ...overrides });

const OIDC_READY = {
  oidcEnabled: 'yes',
  oidcIssuerUrl: 'https://id.example.com/realms/home',
  oidcClientId: 'zettelrobbe',
  oidcClientSecret: 'typed-oidc-secret',
  oidcAdminEmail: 'admin@example.com',
  oidcRedirectUri: 'https://zr.example.com/auth/oidc/callback',
};

/* ── POST /settings ───────────────────────────────────────────────────── */

const SAVE_SCENARIOS = [
  { name: 'empty body', body: {} },
  { name: 'page save, nothing touched', body: page({}) },
  {
    name: 'page save on a fresh instance without saved values',
    unset: ['OPENAI_MODEL', 'PAPERLESS_USERNAME'],
    body: page({ paperlessUrl: '', openaiModel: '' }),
  },

  // Providers
  {
    name: 'openai with a typed key and model',
    body: page({ openaiKey: '  sk-typed  ', openaiModel: 'gpt-4.1' }),
  },
  {
    name: 'openai without any key',
    unset: ['OPENAI_API_KEY'],
    body: page({}),
  },
  {
    name: 'ollama full',
    body: page({
      aiProvider: 'ollama',
      ollamaUrl: 'http://gpu.local:11434',
      ollamaApiKey: ' ollama-key ',
      ollamaModel: 'qwen3:14b',
      ollamaThink: 'on',
    }),
  },
  {
    name: 'ollama keeps stored url and model, think false',
    env: {
      AI_PROVIDER: 'ollama',
      OLLAMA_API_URL: 'http://stored.local:11434',
      OLLAMA_MODEL: 'stored-model',
      OLLAMA_API_KEY: 'stored-ollama-key',
    },
    body: page({
      aiProvider: 'OLLAMA ',
      ollamaUrl: '',
      ollamaModel: '',
      ollamaThink: 'garbage',
    }),
  },
  {
    name: 'ollama without think field and without model',
    body: (() => {
      const body = page({ aiProvider: 'ollama', ollamaModel: '' });
      delete body.ollamaThink;
      return body;
    })(),
    unset: ['OLLAMA_MODEL'],
  },
  {
    name: 'custom full',
    body: page({
      aiProvider: 'custom',
      customBaseUrl: 'http://lmstudio.local:1234/v1',
      customApiKey: 'lm-key',
      customModel: 'qwen2.5-7b-instruct',
    }),
  },
  {
    name: 'custom keeps stored key, url and model',
    env: {
      CUSTOM_BASE_URL: 'http://stored-custom/v1',
      CUSTOM_MODEL: 'stored-custom-model',
      CUSTOM_API_KEY: 'stored-custom-key',
    },
    body: page({ aiProvider: 'custom' }),
  },
  {
    name: 'custom without url',
    body: page({ aiProvider: 'custom', customModel: 'm' }),
  },
  {
    name: 'azure full',
    body: page({
      aiProvider: 'azure',
      azureEndpoint: 'https://x.openai.azure.com',
      azureApiKey: 'az-key',
      azureDeploymentName: 'gpt4o',
      azureApiVersion: '2024-06-01',
    }),
  },
  {
    name: 'azure with stored key only',
    env: { AZURE_API_KEY: 'stored-az-key' },
    body: page({
      aiProvider: 'azure',
      azureEndpoint: 'https://x.openai.azure.com',
      azureDeploymentName: 'gpt4o',
    }),
  },
  {
    name: 'azure without key',
    body: page({
      aiProvider: 'azure',
      azureEndpoint: 'https://x.openai.azure.com',
      azureDeploymentName: 'gpt4o',
    }),
  },
  {
    name: 'anthropic full',
    body: page({
      aiProvider: 'anthropic',
      anthropicApiKey: ' sk-ant-typed ',
      anthropicModel: ' claude-opus-test ',
      anthropicEffort: ' HIGH ',
      anthropicMaxTokens: ' 012000 ',
      anthropicStructuredOutput: 'NO',
      anthropicPromptCaching: 'garbage',
      anthropicApiUrl: ' https://proxy.example.com/anthropic ',
    }),
  },
  {
    name: 'anthropic with stored key, effort and url field absent',
    env: {
      ANTHROPIC_API_KEY: 'stored-ant-key',
      ANTHROPIC_EFFORT: 'medium',
      ANTHROPIC_STRUCTURED_OUTPUT: 'no',
      ANTHROPIC_API_URL: 'https://stored-proxy.example.com',
    },
    body: (() => {
      const body = page({ aiProvider: 'anthropic', anthropicModel: '' });
      delete body.anthropicEffort;
      delete body.anthropicApiUrl;
      delete body.anthropicStructuredOutput;
      return body;
    })(),
  },
  {
    name: 'anthropic without key',
    body: page({ aiProvider: 'anthropic' }),
  },
  {
    name: 'anthropic invalid effort',
    body: page({
      aiProvider: 'anthropic',
      anthropicApiKey: 'k',
      anthropicEffort: 'extreme',
    }),
  },
  {
    name: 'anthropic invalid max tokens',
    body: page({
      aiProvider: 'anthropic',
      anthropicApiKey: 'k',
      anthropicMaxTokens: '16k',
    }),
  },
  {
    name: 'anthropic invalid url',
    body: page({
      aiProvider: 'anthropic',
      anthropicApiKey: 'k',
      anthropicApiUrl: 'ftp://proxy',
    }),
  },
  {
    name: 'unknown provider is stored as given',
    body: page({ aiProvider: 'Mystery' }),
  },

  // Secrets and the Paperless connection
  {
    name: 'masked secrets keep the stored values',
    env: {
      OCR_API_KEY: 'stored-ocr-key',
      MISTRAL_API_KEY: 'stored-mistral-key',
      OIDC_CLIENT_SECRET: 'stored-oidc-secret',
    },
    body: page({ mistralOcrEnabled: 'yes' }),
  },
  {
    name: 'paperless url changed and reachable',
    body: page({
      paperlessUrl: 'http://new-paperless:8000',
      paperlessToken: ' new-token ',
      paperlessPublicUrl: ' https://paperless.example.com ',
    }),
  },
  {
    name: 'paperless url changed and unreachable',
    paperlessValid: false,
    body: page({ paperlessUrl: 'http://bad-paperless:8000' }),
  },
  {
    name: 'paperless token typed for the same url',
    body: page({ paperlessToken: 'typed-token' }),
  },
  {
    name: 'stored url ending in /api is written back without it',
    env: { PAPERLESS_API_URL: 'http://paperless.local:8000/api' },
    body: page({}),
  },
  {
    name: 'paperless url omitted keeps the stored one',
    body: (() => {
      const body = page({ paperlessToken: 'typed-token' });
      delete body.paperlessUrl;
      delete body.paperlessPublicUrl;
      return body;
    })(),
  },

  // Lists
  {
    name: 'lists as comma strings with blanks and spaces',
    body: page({
      tags: ' inbox , ,scan,, todo ',
      ignoreTags: 'private,  ,',
      removeTags: ' new ,',
      promptTags: 'p1, p2 , ,p3',
      ignoreTitlePatterns: ' Invoice* , ,Scan_?? ',
    }),
  },
  {
    name: 'lists as arrays',
    body: page({
      tags: [' inbox ', 'scan', ''],
      ignoreTags: ['a', ' b'],
      removeTags: [],
      promptTags: ['x'],
      ignoreTitlePatterns: ['A*', ' B '],
    }),
  },
  {
    name: 'lists absent and empty prompt tags',
    body: (() => {
      const body = page({ promptTags: '' });
      delete body.tags;
      delete body.ignoreTags;
      delete body.removeTags;
      delete body.ignoreTitlePatterns;
      return body;
    })(),
    env: { TAGS: 'stored-a,stored-b', PROMPT_TAGS: 'kept' },
  },

  // Booleans
  {
    name: 'booleans as yes/no/true/false/on',
    body: page({
      removeInboxTagsAfterProcessing: 'ON',
      activateTagging: '',
      activateCorrespondents: 'no',
      activateDocumentType: true,
      activateTitle: 'false',
      restrictToExistingTags: 'on',
      restrictToExistingCorrespondents: 'true',
      restrictToExistingDocumentTypes: 'yes',
      externalApiEnabled: 'true',
      duplicatesAiReview: 'off',
      duplicatesAiExcerpts: '1',
      duplicatesAiThinking: 'TRUE',
      duplicatesGuardNewNames: 'maybe',
      reconciliationEnabled: ' YES ',
      ocrPdfRenderEnabled: 'true',
      ocrAutoProcessEnabled: 'Yes',
      ocrAutoAnalyze: 'NO',
      ignoreRepeatedContent: 'false',
      showTags: 'yes',
      aiProcessedTag: 'yes',
      usePromptTags: 'yes',
      useExistingData: 'yes',
      disableAutomaticProcessing: 'no',
    }),
  },
  {
    name: 'booleans absent',
    body: {
      removeInboxTagsAfterProcessing: 'false',
      ignoreRepeatedContent: 'no',
      externalApiEnabled: 'on',
      externalApiUrl: 'https://hook.example.com',
      externalApiAllowPrivateIps: 'yes',
    },
  },

  // OCR
  {
    name: 'mistral ocr with a typed key',
    body: page({
      mistralOcrEnabled: 'yes',
      ocrApiKey: ' mistral-typed ',
      ocrApiUrl: 'http://stale-url',
      mistralOcrModel: '',
    }),
  },
  {
    name: 'mistral ocr key from the legacy field',
    body: page({ mistralOcrEnabled: 'yes', mistralApiKey: 'legacy-field' }),
  },
  {
    name: 'mistral ocr enabled without any key',
    body: page({ mistralOcrEnabled: 'yes' }),
  },
  {
    name: 'invalid ocr provider',
    body: page({ ocrProvider: 'tesseract' }),
  },
  {
    name: 'ocr crosses from mistral to claude',
    env: {
      MISTRAL_OCR_ENABLED: 'yes',
      OCR_PROVIDER: 'mistral',
      OCR_API_KEY: 'stored-mistral-key',
      MISTRAL_API_KEY: 'stored-mistral-key',
      OCR_API_URL: 'http://old-ocr',
      ANTHROPIC_API_KEY: 'stored-ant-key',
    },
    body: page({
      mistralOcrEnabled: 'yes',
      ocrProvider: 'anthropic',
      ocrApiUrl: 'http://old-ocr',
      mistralOcrModel: 'mistral-ocr-latest',
    }),
  },
  {
    name: 'ocr crosses to claude with a new url and model',
    env: {
      OCR_PROVIDER: 'ollama',
      OCR_API_URL: 'http://ollama-ocr',
      OCR_API_KEY: 'stored-ollama-ocr',
    },
    body: page({
      mistralOcrEnabled: 'yes',
      ocrProvider: 'anthropic',
      ocrApiUrl: ' https://claude-proxy ',
      ocrApiKey: 'sk-ant-ocr',
      mistralOcrModel: 'claude-ocr-model',
    }),
  },
  {
    name: 'claude ocr with anthropic ai key typed',
    body: page({
      aiProvider: 'anthropic',
      anthropicApiKey: 'sk-ant-ai',
      mistralOcrEnabled: 'yes',
      ocrProvider: 'anthropic',
      mistralOcrModel: '',
    }),
  },
  {
    name: 'claude ocr without any anthropic key',
    body: page({ mistralOcrEnabled: 'yes', ocrProvider: 'anthropic' }),
  },
  {
    name: 'claude ocr borrows a saved anthropic key while openai is selected',
    env: { ANTHROPIC_API_KEY: 'saved-ant' },
    body: page({
      mistralOcrEnabled: 'yes',
      ocrProvider: 'anthropic',
      anthropicApiKey: 'typed-but-hidden',
    }),
  },
  {
    name: 'ocr crosses from claude to ollama',
    env: {
      OCR_PROVIDER: 'anthropic',
      OCR_API_KEY: 'stored-claude-ocr',
      MISTRAL_API_KEY: 'stored-mistral',
      OCR_API_URL: 'https://claude-proxy',
    },
    body: page({
      mistralOcrEnabled: 'yes',
      ocrProvider: 'ollama',
      ocrApiUrl: ' http://ollama:11434 ',
      mistralOcrModel: 'llava',
    }),
  },
  {
    name: 'claude ocr stays claude',
    env: {
      OCR_PROVIDER: 'anthropic',
      OCR_API_KEY: 'stored-claude-ocr',
      OCR_API_URL: 'https://claude-proxy',
      ANTHROPIC_MODEL: 'claude-env-model',
    },
    body: (() => {
      const body = page({
        mistralOcrEnabled: 'yes',
        ocrProvider: 'anthropic',
        ocrApiUrl: 'https://other-proxy',
        mistralOcrModel: '',
      });
      delete body.ocrProvider;
      return body;
    })(),
  },
  {
    name: 'ocr numbers out of range',
    body: page({
      ocrPdfRenderMaxPages: '99',
      ocrPdfRenderDpi: 'abc',
      ocrAutoProcessBatchSize: '0',
      ocrValidationTimeout: '45',
      tagCacheTTL: '30',
      ocrAutoProcessInterval: ' */5 * * * * ',
    }),
  },
  {
    name: 'ocr numbers in range and timeout clamped',
    body: page({
      ocrPdfRenderMaxPages: ' 50 ',
      ocrPdfRenderDpi: 72,
      ocrAutoProcessBatchSize: '100',
      ocrValidationTimeout: '99999',
      tagCacheTTL: '3600',
    }),
  },
  {
    name: 'ocr validation timeout empty keeps the stored one',
    env: { SETUP_VALIDATION_TIMEOUT_MS: '12000' },
    body: page({ ocrValidationTimeout: '' }),
  },
  {
    name: 'invalid ocr interval',
    body: page({ ocrAutoProcessInterval: 'every five minutes' }),
  },

  // Custom fields
  {
    name: 'custom fields as a string with currency',
    body: page({
      customFields: JSON.stringify({
        custom_fields: [
          { value: 'Amount', data_type: 'monetary', currency: 'EUR' },
          { value: 'Due', data_type: 'date', extra: 'dropped' },
        ],
      }),
    }),
  },
  {
    name: 'custom fields as an object',
    body: page({
      customFields: {
        custom_fields: [{ value: 'Note', data_type: 'string' }],
      },
    }),
  },
  {
    name: 'custom fields unreadable',
    body: page({ customFields: '{not json' }),
  },
  {
    name: 'custom fields absent',
    body: (() => {
      const body = page({});
      delete body.customFields;
      return body;
    })(),
  },
  {
    name: 'custom field type conflict on a new field',
    conflicts: [
      { name: 'Amount', paperlessType: 'string', configuredType: 'monetary' },
    ],
    body: page({
      customFields: JSON.stringify({
        custom_fields: [{ value: 'Amount', data_type: 'monetary' }],
      }),
    }),
  },
  {
    name: 'custom field type conflicts on two new fields',
    conflicts: [
      { name: 'A', paperlessType: 'string', configuredType: 'integer' },
      { name: 'B', paperlessType: 'date', configuredType: 'string' },
    ],
    body: page({
      customFields: JSON.stringify({
        custom_fields: [
          { value: 'A', data_type: 'integer' },
          { value: 'B', data_type: 'string' },
        ],
      }),
    }),
  },
  {
    name: 'custom field type conflict on a configured field only warns',
    env: {
      CUSTOM_FIELDS: JSON.stringify({
        custom_fields: [{ value: 'amount', data_type: 'monetary' }],
      }),
    },
    conflicts: [
      { name: 'Amount', paperlessType: 'string', configuredType: 'monetary' },
    ],
    body: page({
      customFields: JSON.stringify({
        custom_fields: [{ value: 'Amount', data_type: 'monetary' }],
      }),
    }),
  },
  {
    name: 'custom field types cannot be compared',
    conflicts: null,
    body: page({
      customFields: JSON.stringify({
        custom_fields: [{ value: 'X', data_type: 'string' }],
      }),
    }),
  },

  // Tidy up numbers
  {
    name: 'tidy-up numbers out of range are clamped',
    body: page({
      duplicatesAiModel: '  judge-model  ',
      duplicatesAiReviewBatchSize: '0',
      duplicatesAiCandidateFloor: '0.3',
      duplicatesAiExcerptChars: '9000',
      duplicatesAiExcerptDocuments: '2.6',
      duplicatesAiTokenBudget: '-5',
      duplicatesAiIdleStopSeconds: '99999',
      duplicatesAiRequestSeconds: '1',
      duplicatesAiConcurrency: '12',
      duplicatesAiVerdictMemoryDays: '400',
      duplicatesAiSweepNames: '10',
      simplifyTagsPerRequest: '5',
      simplifyVocabularySize: '1000',
    }),
  },
  {
    name: 'tidy-up numbers not numbers keep the current values',
    env: {
      DUPLICATES_AI_REVIEW_BATCH_SIZE: '40',
      DUPLICATES_AI_CANDIDATE_FLOOR: '0.8',
    },
    body: page({
      duplicatesAiReviewBatchSize: 'abc',
      duplicatesAiCandidateFloor: '',
      duplicatesAiExcerptChars: ' ',
      duplicatesAiTokenBudget: '1e3',
      duplicatesAiCandidateFloorUnused: 'x',
    }),
  },
  {
    name: 'tidy-up floor rounding',
    body: page({ duplicatesAiCandidateFloor: '0.777' }),
  },

  // General validation
  {
    name: 'token limit rejected',
    body: page({ tokenLimit: '128k' }),
  },
  {
    name: 'response tokens rejected',
    body: page({ responseTokens: '0' }),
  },
  {
    name: 'response tokens parsed leniently, token limit normalised',
    body: page({ responseTokens: ' 2048abc ', tokenLimit: ' 0064000 ' }),
  },
  {
    name: 'temperatures out of range and padded',
    body: page({
      aiTemperatureAnalysis: '3',
      aiTemperatureGeneration: ' 0.50 ',
    }),
  },
  {
    name: 'temperatures empty keep the current values',
    env: { AI_TEMPERATURE_ANALYSIS: '1.2' },
    body: page({ aiTemperatureAnalysis: '', aiTemperatureGeneration: 'x' }),
  },
  {
    name: 'cookie secure mode rejected',
    body: page({ cookieSecureMode: 'sometimes' }),
  },
  {
    name: 'page limit rejected',
    body: page({ maxPageCount: '-1' }),
  },
  {
    name: 'page limit empty and padded',
    body: page({ maxPageCount: ' 007 ', cookieSecureMode: ' ALWAYS ' }),
  },
  {
    name: 'page limit empty',
    body: page({ maxPageCount: '' }),
  },
  {
    name: 'log level rejected',
    body: page({ logLevel: 'verbose' }),
  },
  {
    name: 'date format normalised',
    body: page({ dateFormat: ' yyyy-mm-dd ' }),
  },
  {
    name: 'date format rejected',
    body: page({ dateFormat: 'MM/DD/YYYY' }),
  },
  {
    name: 'system prompt with line breaks and equals signs',
    body: page({ systemPrompt: 'Line one\r\nkey=value\nline three' }),
  },
  {
    name: 'first error wins: provider before token limit',
    unset: ['OPENAI_API_KEY'],
    body: page({ tokenLimit: '1k' }),
  },

  // Single sign-on
  {
    name: 'oidc switched on and complete',
    body: page({
      ...OIDC_READY,
      oidcScopes: '  openid   email  profile ',
      oidcTokenAuthMethod: ' CLIENT_SECRET_POST ',
      oidcButtonText:
        'Sign in with the very long name of our identity provider',
      oidcButtonIcon: '/icons/sso.svg',
      oidcButtonColor: '#1f6feb',
      oidcButtonTextColor: 'white',
      oidcAllowUnverifiedEmail: 'true',
    }),
  },
  {
    name: 'oidc switched on without issuer',
    body: page({ ...OIDC_READY, oidcIssuerUrl: '' }),
  },
  {
    name: 'oidc switched on with bad method, icon and colour',
    body: page({
      ...OIDC_READY,
      oidcTokenAuthMethod: 'magic',
      oidcButtonIcon: 'javascript:alert(1)',
      oidcButtonColor: 'url(x)',
    }),
  },
  {
    name: 'oidc switched off keeps a half-finished setup',
    body: page({ oidcEnabled: 'off', oidcIssuerUrl: 'not a url' }),
  },
  {
    name: 'oidc empty secret keeps the stored one',
    env: { OIDC_CLIENT_SECRET: 'stored-oidc-secret' },
    body: page({ ...OIDC_READY, oidcClientSecret: '  ' }),
  },
  {
    name: 'oidc pinned issuer wins over a typed one',
    pinned: { OIDC_ISSUER_URL: 'https://pinned-issuer.example.com' },
    env: { OIDC_ISSUER_URL: 'https://pinned-issuer.example.com' },
    body: page({ ...OIDC_READY, oidcIssuerUrl: '' }),
  },
  {
    name: 'oidc fields absent',
    body: { oidcEnabled: 'garbage' },
  },

  // Restarts
  {
    name: 'live key only does not restart',
    body: page({ aiTemperatureAnalysis: '0.9' }),
  },
  {
    name: 'trust proxy change restarts',
    body: page({ trustProxy: ' 1 ' }),
  },
  {
    name: 'several restart keys change',
    body: page({
      scanInterval: '0 * * * *',
      logLevel: 'debug',
      paperlessAiPort: '3100',
      globalRateLimitMax: '50',
      minContentLength: '20',
      disableAutomaticProcessing: 'no',
      reconciliationEnabled: 'yes',
      mistralOcrEnabled: 'yes',
      ocrApiKey: 'k',
    }),
  },
  {
    name: 'pinned restart key is never reported',
    pinned: { SCAN_INTERVAL: '5 4 * * *' },
    env: { SCAN_INTERVAL: '5 4 * * *' },
    body: page({ scanInterval: '0 * * * *' }),
  },
  {
    name: 'tag cache ttl change resets the cache',
    body: page({ tagCacheTTL: '600' }),
  },
  {
    name: 'missing api key is generated',
    unset: ['API_KEY'],
    body: page({}),
  },
];

/* ── GET /settings ────────────────────────────────────────────────────── */

const SETTINGS_PAGE_SCENARIOS = [
  {
    name: 'configured instance, defaults only',
    configured: true,
    saved: null,
  },
  {
    name: 'configured instance with values and a saved configuration',
    configured: true,
    env: {
      TAGS: ' inbox , ,scan,',
      IGNORE_TAGS: 'a,b',
      PROMPT_TAGS: '',
      IGNORE_TITLE_PATTERNS: 'Invoice*, Scan',
      REMOVE_TAGS_AFTER_PROCESSING: 'new',
      SETUP_VALIDATION_TIMEOUT_MS: '15000',
      TRUST_PROXY: '',
      OCR_API_KEY: 'ocr-secret',
      OIDC_CLIENT_SECRET: 'oidc-secret',
      ANTHROPIC_API_KEY: 'ant-secret',
      TOKEN_LIMIT: '64000',
      PROCESS_ONLY_NEW_DOCUMENTS: 'no',
      OLLAMA_THINK: 'true',
    },
    saved: {
      PAPERLESS_API_URL: 'http://saved-paperless:8000/api',
      TAGS: 'saved-a, ,saved-b',
      REMOVE_TAGS_AFTER_PROCESSING: ['x', 'y'],
      IGNORE_TITLE_PATTERNS: '',
      CUSTOM_EXTRA_KEY: 'extra',
      API_KEY: 'saved-api-key',
    },
  },
  {
    name: 'pinned keys are locked',
    configured: true,
    pinned: {
      SCAN_INTERVAL: '1',
      OPENAI_MODEL: '1',
      DUPLICATES_AI_MODEL: '1',
      LOG_LEVEL: '1',
      NOT_A_SETTING: '1',
    },
    saved: null,
  },
  {
    name: 'incomplete configuration shows the warning',
    configured: false,
    env: { PAPERLESS_AI_INITIAL_SETUP: 'yes' },
    unset: ['OPENAI_MODEL', 'AI_PROVIDER', 'PAPERLESS_API_URL'],
    saved: null,
  },
];

/* ── GET /setup ───────────────────────────────────────────────────────── */

const SETUP_PAGE_SCENARIOS = [
  {
    name: 'fresh instance',
    configured: false,
    unset: [
      'PAPERLESS_API_URL',
      'PAPERLESS_API_TOKEN',
      'AI_PROVIDER',
      'OPENAI_API_KEY',
      'OPENAI_MODEL',
    ],
    saved: null,
  },
  {
    name: 'environment configured, no users yet',
    configured: true,
    env: {
      TAGS: 'a, ,b',
      PROMPT_TAGS: 'p',
      SETUP_VALIDATION_TIMEOUT_MS: '9000',
      SCAN_INTERVAL: '0 */2 * * *',
      PROCESS_ONLY_NEW_DOCUMENTS: '',
      AZURE_API_VERSION: '2024-01-01',
    },
    saved: {
      PAPERLESS_API_URL: 'http://saved:8000/api',
      IGNORE_TAGS: 'x,y',
      EXTRA: 'kept',
    },
  },
];

/* ── POST /api/setup/complete ─────────────────────────────────────────── */

const SETUP_BASE = {
  adminUsername: ' admin ',
  adminPassword: 'correct horse battery',
  paperlessUrl: 'http://paperless.local:8000/api/',
  paperlessUsername: ' archivist ',
  paperlessToken: ' token ',
  paperlessTestPassed: 'yes',
  aiTestPassed: true,
  ocrTestPassed: 'true',
};

const SETUP_COMPLETE_SCENARIOS = [
  {
    name: 'openai, all documents, no ocr',
    env: { PROMPT_TAGS: 'p1, ,p2', TOKEN_LIMIT: '64000' },
    unset: ['OPENAI_MODEL'],
    body: {
      ...SETUP_BASE,
      scanAllDocuments: 'yes',
      aiProvider: 'OpenAI',
      aiToken: 'sk-setup',
      aiModel: '',
    },
  },
  {
    name: 'ollama with tags and mistral ocr',
    body: {
      ...SETUP_BASE,
      includeTags: ['inbox', ' scan '],
      includeTag: 'extra',
      excludeTags: 'old, ,junk',
      processedTag: 'ai-done',
      removeInboxTagsAfterProcessing: 'yes',
      automaticScanEnabled: 'false',
      scanInterval: '  ',
      aiProvider: 'ollama',
      aiApiUrl: '',
      aiToken: '',
      aiModel: 'qwen3',
      mistralOcrEnabled: 'yes',
      ocrProvider: 'mistral',
      ocrApiUrl: 'http://ignored',
      mistralApiKey: 'mistral-setup',
      mistralOcrModel: '',
      setupValidationTimeoutMs: '5000',
    },
  },
  {
    name: 'anthropic with claude ocr',
    body: {
      ...SETUP_BASE,
      scanAllDocuments: true,
      aiProvider: 'anthropic',
      aiApiUrl: 'https://proxy.example.com',
      aiToken: 'sk-ant-setup',
      aiModel: 'claude-setup-model',
      mistralOcrEnabled: true,
      ocrProvider: 'anthropic',
      ocrApiUrl: ' https://ocr-proxy ',
      ocrApiKey: '',
      mistralOcrModel: 'pixtral',
      setupOcrValidationTimeoutMs: '999999999',
    },
  },
  {
    name: 'azure and custom ocr',
    body: {
      ...SETUP_BASE,
      scanAllDocuments: 'on',
      aiProvider: 'azure',
      aiApiUrl: 'https://x.openai.azure.com',
      aiToken: 'az',
      aiModel: 'gpt4o',
      aiAzureApiVersion: '',
      mistralOcrEnabled: 'yes',
      ocrProvider: 'custom',
      ocrApiUrl: 'http://lm:1234/v1',
      ocrApiKey: 'lm',
      mistralOcrModel: 'qwen-vl',
    },
  },
  {
    name: 'custom provider without anthropic url',
    body: {
      ...SETUP_BASE,
      scanAllDocuments: 'yes',
      aiProvider: 'custom',
      aiApiUrl: 'http://lm:1234/v1',
      aiToken: '',
      aiModel: 'qwen',
    },
  },
];

/* ── The .env export ──────────────────────────────────────────────────── */

const ENV_EXPORT_SCENARIOS = [
  {
    name: 'a configured instance with values that need quoting',
    env: {
      SYSTEM_PROMPT: 'You are "careful" # always',
      TAGS: 'a,b',
      OLLAMA_MODEL: 'llama3.1:8b',
      OIDC_ENABLED: 'yes',
      OIDC_CLIENT_SECRET: 'secret with space',
      DATE_FORMAT: 'YYYY-MM-DD',
      EXPOSE_API_DOCS: 'yes',
      ANONYMIZED_TELEMETRY: 'no',
      PAPERLESS_PROBE_INTERVAL_SECONDS: '30',
      DUPLICATES_AI_MODEL: '',
      NOT_EXPORTED: 'x',
      USE_PROMPT_TAGS: 'yes',
    },
  },
];

/* ── Running and recording ────────────────────────────────────────────── */

const VOLATILE = [];

function normalizeVolatile(value) {
  if (Array.isArray(value)) return value.map(normalizeVolatile);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeVolatile(entry),
      ])
    );
  }
  for (const [actual, placeholder] of VOLATILE) {
    if (value === actual) return placeholder;
  }
  return value;
}

const sortedCopy = (list) => (Array.isArray(list) ? [...list].sort() : list);

(async () => {
  const calls = {
    saved: [],
    validations: [],
    conflictQueries: [],
    createdFields: [],
    restarts: 0,
    users: [],
    rendered: null,
  };
  const scenarioState = { paperlessValid: true, conflicts: [], saved: null };

  const harness = await mountRouter({
    env: BASE_ENV,
    stub: ({ setupService, paperlessService, documentModel }) => {
      setupService.saveConfig = async (config, options) => {
        calls.saved.push({
          config: JSON.parse(JSON.stringify(config)),
          options: options || null,
        });
      };
      setupService.validatePaperlessConfig = async (url, token) => {
        calls.validations.push([url, token]);
        return scenarioState.paperlessValid;
      };
      setupService.loadConfig = async () =>
        scenarioState.saved ? { ...scenarioState.saved } : null;
      setupService.getSetupState = async () => 'partial';
      paperlessService.findCustomFieldTypeConflicts = async (fields) => {
        calls.conflictQueries.push(JSON.parse(JSON.stringify(fields)));
        return scenarioState.conflicts;
      };
      paperlessService.createCustomFieldSafely = async (...args) => {
        calls.createdFields.push(args);
      };
      documentModel.addUser = async (username, hash) => {
        calls.users.push([username, hash]);
        return true;
      };
    },
  });

  const restartService = require('../services/restartService');
  restartService.requestRestart = () => {
    calls.restarts += 1;
    return /** @type {any} */ (null);
  };
  restartService.exit = () => {
    throw new Error('the golden test must never exit');
  };
  const bcrypt = require(path.join(REPO_ROOT, 'node_modules', 'bcryptjs'));
  bcrypt.hash = async () => 'hashed-password';

  const configFile = require('../config/config');
  const anthropicSupport = require('../services/anthropicSupport');
  VOLATILE.push(
    [configFile.PAPERLESS_AI_VERSION, '<PAPERLESS_AI_VERSION>'],
    [anthropicSupport.ANTHROPIC_DEFAULT_MODEL, '<ANTHROPIC_DEFAULT_MODEL>'],
    [
      String(anthropicSupport.ANTHROPIC_DEFAULT_MAX_TOKENS),
      '<ANTHROPIC_DEFAULT_MAX_TOKENS>',
    ]
  );

  harness.app.response.render = function captureRender(view, locals) {
    calls.rendered = { view, locals };
    this.json({ rendered: view });
  };

  const AFTER_MOUNT = { ...process.env };
  const paperlessService = harness.paperlessService;

  function prepare(scenario, { configured = true } = {}) {
    for (const key of Object.keys(process.env)) {
      if (!(key in AFTER_MOUNT)) delete process.env[key];
    }
    Object.assign(process.env, AFTER_MOUNT);
    for (const key of scenario.unset || []) delete process.env[key];
    Object.assign(process.env, scenario.env || {});
    for (const key of Object.keys(PINNED)) delete PINNED[key];
    Object.assign(PINNED, scenario.pinned || {});
    scenarioState.paperlessValid = scenario.paperlessValid !== false;
    scenarioState.conflicts =
      scenario.conflicts === undefined ? [] : scenario.conflicts;
    scenarioState.saved = scenario.saved || null;
    harness.setupService.isConfigured = async () => configured;
    calls.saved = [];
    calls.validations = [];
    calls.conflictQueries = [];
    calls.createdFields = [];
    calls.restarts = 0;
    calls.users = [];
    calls.rendered = null;
    paperlessService._cacheTTL = 'cached';
  }

  async function withCapturedLogs(fn) {
    const warnings = [];
    const errors = [];
    const realWarn = console.warn;
    const realError = console.error;
    const realLog = console.log;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    console.error = (...args) => errors.push(String(args[0]));
    console.log = () => {};
    try {
      await fn();
    } finally {
      console.warn = realWarn;
      console.error = realError;
      console.log = realLog;
    }
    return { warnings: warnings.sort(), errors: errors.sort() };
  }

  // A session as well as the API key: the scenario without an API key still
  // has to get past the guards.
  const jwt = require(path.join(REPO_ROOT, 'node_modules', 'jsonwebtoken'));
  const sessionToken = jwt.sign(
    { id: 1, username: 'golden', typ: 'session' },
    BASE_ENV.JWT_SECRET
  );

  async function request(method, url, body) {
    const response = await fetch(harness.base + url, {
      method,
      redirect: 'manual',
      headers: {
        'x-api-key': API_KEY,
        Authorization: `Bearer ${sessionToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { nonJson: text.slice(0, 200) };
    }
    return { status: response.status, json };
  }

  // Every save payload is recorded as its difference from the payload of the
  // untouched page save, which is recorded in full: a scenario then shows
  // exactly what it changed, and the fixture stays readable.
  let referencePayload = null;
  const diffFromReference = (config) => {
    if (!referencePayload) return config;
    const differs = {};
    for (const [key, value] of Object.entries(config)) {
      if (
        JSON.stringify(value) !== JSON.stringify(referencePayload[key]) ||
        !(key in referencePayload)
      ) {
        differs[key] = value;
      }
    }
    const missing = Object.keys(referencePayload).filter(
      (key) => !(key in config)
    );
    return { differsFromReference: differs, missingFromReference: missing };
  };

  const recorded = {
    referencePayload: {},
    save: {},
    settingsPage: {},
    setupPage: {},
    setupComplete: {},
    envExport: {},
  };

  {
    prepare({ body: PAGE_BODY });
    await withCapturedLogs(async () => {
      await request('POST', '/settings', PAGE_BODY);
    });
    referencePayload = calls.saved[0].config;
    recorded.referencePayload = {
      'page save, nothing touched': normalizeVolatile(referencePayload),
    };
  }

  for (const scenario of SAVE_SCENARIOS) {
    prepare(scenario);
    let result;
    const logs = await withCapturedLogs(async () => {
      result = await request('POST', '/settings', scenario.body);
    });
    const response = { ...result.json };
    if (Array.isArray(response.restartKeys)) {
      response.restartKeys = sortedCopy(response.restartKeys);
    }
    const saved = calls.saved.map((entry) => {
      const config = { ...entry.config };
      // A generated key is random; only its shape is recorded.
      if (scenario.unset?.includes('API_KEY') && config.API_KEY) {
        config.API_KEY = /^[0-9a-f]{128}$/.test(config.API_KEY)
          ? '<generated 128 hex>'
          : config.API_KEY;
      }
      return { config: diffFromReference(config), options: entry.options };
    });
    recorded.save[scenario.name] = normalizeVolatile({
      status: result.status,
      response,
      saved,
      restartRequested: calls.restarts,
      paperlessValidations: calls.validations,
      customFieldConflictQueries: calls.conflictQueries,
      createdCustomFields: calls.createdFields,
      tagCacheReset: paperlessService._cacheTTL === null,
      warnings: logs.warnings,
      errors: logs.errors,
    });
  }

  for (const scenario of SETTINGS_PAGE_SCENARIOS) {
    prepare(scenario, { configured: scenario.configured });
    let result;
    await withCapturedLogs(async () => {
      result = await request('GET', '/settings');
    });
    const locals = calls.rendered?.locals || {};
    recorded.settingsPage[scenario.name] = normalizeVolatile({
      status: result.status,
      view: calls.rendered?.view || null,
      config: locals.config,
      configuredSecrets: locals.configuredSecrets,
      lockedEnvKeys: sortedCopy(locals.lockedEnvKeys),
      restartRequiredKeys: sortedCopy(locals.restartRequiredKeys),
      success: locals.success ?? null,
      settingsError: locals.settingsError ?? null,
      mfaSettings: locals.mfaSettings,
    });
  }

  for (const scenario of SETUP_PAGE_SCENARIOS) {
    prepare(scenario, { configured: scenario.configured });
    let result;
    await withCapturedLogs(async () => {
      result = await request('GET', '/setup');
    });
    const locals = calls.rendered?.locals || {};
    recorded.setupPage[scenario.name] = normalizeVolatile({
      status: result.status,
      view: calls.rendered?.view || null,
      config: locals.config,
      success: locals.success ?? null,
      error: locals.error ?? null,
      defaults: locals.defaults,
    });
  }

  for (const scenario of SETUP_COMPLETE_SCENARIOS) {
    prepare(scenario, { configured: true });
    let result;
    const logs = await withCapturedLogs(async () => {
      result = await request('POST', '/api/setup/complete', scenario.body);
    });
    recorded.setupComplete[scenario.name] = normalizeVolatile({
      status: result.status,
      response: result.json,
      saved: calls.saved,
      users: calls.users,
      restartRequested: calls.restarts,
      warnings: logs.warnings,
      errors: logs.errors,
    });
  }

  for (const scenario of ENV_EXPORT_SCENARIOS) {
    prepare(scenario);
    const result = await request('GET', '/api/settings/env-file');
    const data = { ...(result.json.data || {}) };
    delete data.generatedAt;
    recorded.envExport[scenario.name] = {
      status: result.status,
      success: result.json.success,
      data,
    };
  }

  await harness.close();

  // What a fixture can hold: undefined becomes null, as it does on disk.
  const actual = JSON.parse(JSON.stringify(recorded));

  if (RECORD) {
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`Recorded ${FIXTURE_PATH}`);
    process.exit(0);
  }

  const expected = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  let passed = 0;
  let failed = 0;
  for (const section of Object.keys(expected)) {
    for (const name of Object.keys(expected[section])) {
      try {
        assert.deepStrictEqual(actual[section][name], expected[section][name]);
        passed += 1;
      } catch (error) {
        failed += 1;
        console.error(`❌  ${section} › ${name}`);
        console.error(
          `    ${error.message.split('\n').slice(0, 40).join('\n    ')}`
        );
      }
    }
    for (const name of Object.keys(actual[section])) {
      if (!(name in expected[section])) {
        failed += 1;
        console.error(`❌  ${section} › ${name}: no recording`);
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
