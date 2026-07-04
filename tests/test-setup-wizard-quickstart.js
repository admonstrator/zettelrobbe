const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const setupJsPath = path.join(__dirname, '..', 'public', 'js', 'setup.js');

function createMockClassList() {
  const classes = new Set();
  return {
    add: (...items) => items.forEach((item) => classes.add(item)),
    remove: (...items) => items.forEach((item) => classes.delete(item)),
    toggle: (item, force) => {
      if (force === undefined ? !classes.has(item) : force) {
        classes.add(item);
        return true;
      }
      classes.delete(item);
      return false;
    },
    contains: (item) => classes.has(item)
  };
}

function createMockElement(id) {
  const listeners = {};
  return {
    id,
    value: '',
    checked: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    className: '',
    style: {},
    dataset: {},
    classList: createMockClassList(),
    appendChild: () => {},
    addEventListener: (event, handler) => {
      if (!listeners[event]) {
        listeners[event] = [];
      }
      listeners[event].push(handler);
    },
    dispatchEvent: (eventName) => {
      (listeners[eventName] || []).forEach((fn) => fn());
    },
    focus: () => {},
    select: () => {},
    setAttribute: () => {},
    removeAttribute: () => {}
  };
}

const elementIds = [
  'setupWizardForm',
  'setupProgressFill',
  'setupStepLabel',
  'adminUsername',
  'adminPassword',
  'confirmPassword',
  'passwordHint',
  'enableMfa',
  'mfaSetupPanel',
  'startMfaSetupBtn',
  'mfaProvisioningBox',
  'setupMfaQrImage',
  'setupMfaSecret',
  'setupMfaCode',
  'confirmMfaCodeBtn',
  'mfaStatusHint',
  'paperlessUrl',
  'paperlessUsername',
  'paperlessToken',
  'testPaperlessBtn',
  'paperlessTestState',
  'fetchMetadataBtn',
  'metadataLoadState',
  'documentsCount',
  'correspondentsCount',
  'tagsCount',
  'scanAllDocuments',
  'includeTag',
  'excludeTagInput',
  'addExcludeTagBtn',
  'excludeTagsContainer',
  'processedTag',
  'excludeProcessedTagBtn',
  'automaticScanEnabled',
  'scanInterval',
  'paperlessTagsDatalist',
  'aiPreset',
  'aiPresetHint',
  'aiProvider',
  'aiApiUrl',
  'aiToken',
  'aiModel',
  'fetchAiModelsBtn',
  'aiValidationTimeout',
  'testAiBtn',
  'aiTestState',
  'aiModeQuickstartBtn',
  'aiModeManualBtn',
  'aiQuickstartPanel',
  'aiManualPanel',
  'quickstartBaseUrl',
  'quickstartApiKey',
  'quickstartDetectBtn',
  'quickstartDetectState',
  'quickstartHint',
  'quickstartAiModel',
  'quickstartOcrModel',
  'quickstartEnableOcr',
  'quickstartOcrHint',
  'ocrQuickstartNotice',
  'mistralOcrEnabled',
  'mistralFields',
  'ocrProvider',
  'ocrApiUrl',
  'ocrApiUrlContainer',
  'ocrApiKeyContainer',
  'ocrApiKey',
  'mistralOcrModel',
  'fetchOcrModelsBtn',
  'ocrValidationTimeout',
  'testOcrBtn',
  'ocrTestState',
  'envPreview',
  'copyEnvPreviewBtn',
  'finalizeSetupBtn',
  'prevStepBtn',
  'nextStepBtn'
];

const elements = new Map(elementIds.map((id) => [id, createMockElement(id)]));

const steps = Array.from({ length: 7 }, (_unused, index) => ({
  dataset: { stepTitle: `Step ${index + 1}` },
  classList: createMockClassList(),
  style: {},
  disabled: false
}));

const detectionResponse = {
  success: true,
  detection: {
    flavor: 'lmstudio',
    aiProvider: 'custom',
    resolvedAiApiUrl: 'http://192.168.1.5:1234/v1',
    ocrProvider: 'custom',
    resolvedOcrApiUrl: 'http://192.168.1.5:1234/v1',
    models: [
      { id: 'qwen2.5-7b-instruct', capabilities: ['text'], state: 'loaded', source: 'lmstudio-api' },
      { id: 'minicpm-v', capabilities: ['text', 'vision'], state: 'not-loaded', source: 'lmstudio-api' },
      { id: 'nomic-embed-text', capabilities: ['embedding'], state: 'loaded', source: 'lmstudio-api' }
    ],
    textModels: ['qwen2.5-7b-instruct', 'minicpm-v'],
    visionModels: ['minicpm-v'],
    embeddingModels: ['nomic-embed-text'],
    suggestedAiModel: 'qwen2.5-7b-instruct',
    suggestedOcrModel: 'minicpm-v'
  },
  message: 'Detected LM Studio: 3 models (2 text, 1 vision, 1 embedding).'
};

let lastFetchUrl = null;
let lastFetchBody = null;

const mockFetch = async (url, options = {}) => {
  lastFetchUrl = url;
  lastFetchBody = options.body ? JSON.parse(options.body) : null;
  return {
    ok: true,
    json: async () => detectionResponse
  };
};

global.window = {
  __SETUP_BOOTSTRAP__: { config: {}, defaults: {}, aiProviderPresets: [] },
  fetch: mockFetch
};

// The wizard's request() helper calls the bare global fetch.
global.fetch = mockFetch;

global.document = {
  addEventListener: (_event, callback) => callback(),
  querySelectorAll: (selector) => (selector === '.setup-step' ? steps : []),
  querySelector: (selector) => {
    if (selector === 'meta[name="csrf-token"]') {
      return { getAttribute: () => '' };
    }
    return null;
  },
  getElementById: (id) => elements.get(id) || null,
  createElement: (tagName) => createMockElement(tagName)
};

global.Swal = {
  fire: async () => ({ isConfirmed: false }),
  update: () => {}
};

global.navigator = {
  clipboard: {
    writeText: async () => {}
  }
};

global.Headers = class Headers {};
global.setInterval = () => 1;
global.clearInterval = () => {};

const source = fs.readFileSync(setupJsPath, 'utf8');
vm.runInThisContext(source, { filename: setupJsPath });

const wizard = window.setupWizard;
assert.ok(wizard, 'Setup wizard should initialize');

// Fresh install (no AI_PROVIDER in config) defaults to quickstart mode
assert.strictEqual(wizard.quickstartState.mode, 'quickstart', 'Fresh install should default to quickstart mode');
assert.strictEqual(wizard.aiQuickstartPanel.classList.contains('hidden'), false, 'Quickstart panel should be visible');
assert.strictEqual(wizard.aiManualPanel.classList.contains('hidden'), true, 'Manual panel should be hidden');

// Mode toggle switches panels
wizard.setAiConfigMode('manual');
assert.strictEqual(wizard.aiQuickstartPanel.classList.contains('hidden'), true, 'Quickstart panel should hide in manual mode');
assert.strictEqual(wizard.aiManualPanel.classList.contains('hidden'), false, 'Manual panel should show in manual mode');
wizard.setAiConfigMode('quickstart');

// Detection populates selects and applies values to the hidden manual fields
wizard.quickstartBaseUrl.value = 'http://192.168.1.5:1234';
wizard.quickstartApiKey.value = 'test-key';

(async () => {
  await wizard.runQuickstartDetect();

  assert.strictEqual(lastFetchUrl, '/api/setup/quickstart/detect', 'Detect should call the quickstart endpoint');
  assert.strictEqual(lastFetchBody.baseUrl, 'http://192.168.1.5:1234');
  assert.strictEqual(lastFetchBody.apiKey, 'test-key');

  assert.strictEqual(wizard.quickstartState.detected, true, 'Detection state should be set');
  assert.strictEqual(wizard.quickstartAiModel.value, 'qwen2.5-7b-instruct', 'Suggested AI model should be selected');
  assert.strictEqual(wizard.quickstartOcrModel.value, 'minicpm-v', 'Suggested OCR model should be selected');
  assert.strictEqual(wizard.quickstartEnableOcr.checked, true, 'OCR checkbox should be checked when vision models exist');
  assert.strictEqual(wizard.quickstartEnableOcr.disabled, false, 'OCR checkbox should be enabled when vision models exist');

  // Hidden AI fields are synced
  assert.strictEqual(wizard.aiProvider.value, 'custom', 'AI provider should be applied');
  assert.strictEqual(wizard.aiApiUrl.value, 'http://192.168.1.5:1234/v1', 'AI API URL should be applied');
  assert.strictEqual(wizard.aiToken.value, 'test-key', 'AI token should be applied');
  assert.strictEqual(wizard.aiModel.value, 'qwen2.5-7b-instruct', 'AI model should be applied');

  // OCR fields are synced
  assert.strictEqual(wizard.mistralOcrEnabled.value, 'yes', 'OCR should be enabled');
  assert.strictEqual(wizard.ocrProvider.value, 'custom', 'OCR provider should be custom');
  assert.strictEqual(wizard.ocrApiUrl.value, 'http://192.168.1.5:1234/v1', 'OCR API URL should be applied');
  assert.strictEqual(wizard.ocrApiKey.value, 'test-key', 'OCR API key should be applied');
  assert.strictEqual(wizard.mistralOcrModel.value, 'minicpm-v', 'OCR model should be applied');
  assert.strictEqual(wizard.ocrQuickstartNotice.classList.contains('hidden'), false, 'OCR notice should be visible');

  // Env preview reflects the applied quickstart config
  const envPreview = wizard.buildEnvPreview();
  assert.ok(envPreview.includes('AI_PROVIDER=custom'), 'Env preview should contain the custom provider');
  assert.ok(envPreview.includes('CUSTOM_BASE_URL=http://192.168.1.5:1234/v1'), 'Env preview should contain the custom base URL');
  assert.ok(envPreview.includes('CUSTOM_MODEL=qwen2.5-7b-instruct'), 'Env preview should contain the AI model');
  assert.ok(envPreview.includes('MISTRAL_OCR_ENABLED=yes'), 'Env preview should enable OCR');
  assert.ok(envPreview.includes('OCR_PROVIDER=custom'), 'Env preview should use the custom OCR provider');
  assert.ok(envPreview.includes('MISTRAL_OCR_MODEL=minicpm-v'), 'Env preview should contain the OCR model');

  // Unchecking the OCR option reverts OCR enablement
  wizard.quickstartEnableOcr.checked = false;
  wizard.applyQuickstartToManualFields();
  assert.strictEqual(wizard.mistralOcrEnabled.value, 'no', 'Unchecking OCR should disable OCR again');
  assert.strictEqual(wizard.ocrQuickstartNotice.classList.contains('hidden'), true, 'OCR notice should hide when unchecked');

  // Idempotent re-apply must not reset a successful AI test
  wizard.quickstartEnableOcr.checked = true;
  wizard.applyQuickstartToManualFields();
  wizard.aiTestState.ran = true;
  wizard.aiTestState.success = true;
  wizard.applyQuickstartToManualFields();
  assert.strictEqual(wizard.aiTestState.success, true, 'Re-applying unchanged values must not reset the AI test state');

  console.log('✅ test-setup-wizard-quickstart passed');
})().catch((error) => {
  console.error('❌ test-setup-wizard-quickstart failed:', error.message);
  process.exit(1);
});
