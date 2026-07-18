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
  'quickstartSaveRow',
  'quickstartSaveBtn',
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

global.window = {
  __SETUP_BOOTSTRAP__: { config: {}, defaults: {}, aiProviderPresets: [] },
  fetch: async () => ({})
};

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
  update: () => {},
  close: () => {}
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

// Manual mode from a clean start already yields 'custom'
assert.strictEqual(wizard.aiProvider.value, 'custom', 'Fresh manual mode should default aiProvider to custom');

// Selecting a named preset (e.g. OpenAI) sets the hidden aiProvider field
const openAiPreset = {
  id: 'openai',
  label: 'OpenAI (ChatGPT)',
  provider: 'openai',
  apiUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  tokenPlaceholder: 'sk-...'
};
wizard.applyPreset(openAiPreset);
assert.strictEqual(wizard.aiProvider.value, 'openai', 'Selecting the OpenAI preset should set aiProvider to openai');
assert.strictEqual(wizard.aiApiUrl.value, 'https://api.openai.com/v1');

// Switching back to "Manual custom configuration" (preset === null) must reset aiProvider
wizard.applyPreset(null);
assert.strictEqual(
  wizard.aiProvider.value,
  'custom',
  'Switching back to manual configuration must reset the stale aiProvider value to custom'
);
assert.ok(
  wizard.aiPresetHint.textContent.includes('Manual mode'),
  'Manual mode hint should be shown after clearing the preset'
);

console.log('✅ test-setup-preset-manual-reset passed');
