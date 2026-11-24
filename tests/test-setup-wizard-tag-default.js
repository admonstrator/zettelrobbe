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
    contains: (item) => classes.has(item),
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
    removeAttribute: () => {},
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
  'paperlessToken',
  'testPaperlessBtn',
  'paperlessTestState',
  'metadataLoadState',
  'documentsCount',
  'correspondentsCount',
  'tagsCount',
  'scanAllDocuments',
  'includeTag',
  'includeTagsSection',
  'addIncludeTagBtn',
  'includeTagsContainer',
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
  'nextStepBtn',
];

const elements = new Map(elementIds.map((id) => [id, createMockElement(id)]));

const steps = Array.from({ length: 7 }, (_unused, index) => ({
  dataset: { stepTitle: `Step ${index + 1}` },
  classList: createMockClassList(),
  style: {},
  disabled: false,
}));

global.window = {
  __SETUP_BOOTSTRAP__: { config: {}, defaults: {}, aiProviderPresets: [] },
  fetch: async () => ({}),
};

global.document = {
  addEventListener: (_event, callback) => callback(),
  querySelectorAll: (selector) => (selector === '.zr-steppane' ? steps : []),
  querySelector: (selector) => {
    if (selector === 'meta[name="csrf-token"]') {
      return { getAttribute: () => '' };
    }
    return null;
  },
  getElementById: (id) => elements.get(id) || null,
  createElement: (tagName) => createMockElement(tagName),
};

global.Swal = {
  fire: async () => ({ isConfirmed: false }),
  update: () => {},
  close: () => {},
};

global.navigator = {
  clipboard: {
    writeText: async () => {},
  },
};

global.Headers = class Headers {};
global.setInterval = () => 1;
global.clearInterval = () => {};

const source = fs.readFileSync(setupJsPath, 'utf8');
vm.runInThisContext(source, { filename: setupJsPath });

assert.ok(window.setupWizard, 'Setup wizard should initialize');
assert.strictEqual(
  window.setupWizard.scanAllDocuments.checked,
  false,
  'Fresh setup should default to include-tag mode'
);
assert.strictEqual(
  window.setupWizard.includeTag.disabled,
  false,
  'Include tag input should stay enabled by default'
);

// Verify reactive behavior: toggling the checkbox hides/shows the whole block.
// An include filter is ignored while scan-all is on, so the field is taken away
// rather than left sitting there disabled next to a live Add button.
window.setupWizard.scanAllDocuments.checked = true;
window.setupWizard.scanAllDocuments.dispatchEvent('change');
assert.strictEqual(
  window.setupWizard.includeTag.disabled,
  true,
  'Tag field should be disabled when scan-all is checked'
);
assert.ok(
  window.setupWizard.includeTagsSection.classList.contains('hidden'),
  'Include tag section should be hidden when scan-all is checked'
);
assert.strictEqual(
  window.setupWizard.addIncludeTagBtn.disabled,
  true,
  'Add button should be disabled when scan-all is checked'
);

window.setupWizard.scanAllDocuments.checked = false;
window.setupWizard.scanAllDocuments.dispatchEvent('change');
assert.strictEqual(
  window.setupWizard.includeTag.disabled,
  false,
  'Tag field should re-enable when scan-all is unchecked'
);
assert.ok(
  !window.setupWizard.includeTagsSection.classList.contains('hidden'),
  'Include tag section should reappear when scan-all is unchecked'
);

// Verify loading an existing config with PROCESS_PREDEFINED_DOCUMENTS=no marks scan-all as checked
window.__SETUP_BOOTSTRAP__ = {
  config: { PROCESS_PREDEFINED_DOCUMENTS: 'no' },
  defaults: {},
  aiProviderPresets: [],
};
window.setupWizard.config = { PROCESS_PREDEFINED_DOCUMENTS: 'no' };
window.setupWizard.populateInitialValues();
assert.strictEqual(
  window.setupWizard.scanAllDocuments.checked,
  true,
  'PROCESS_PREDEFINED_DOCUMENTS=no should result in scan-all checked'
);
// Re-entering setup with an existing config must apply the switch too, otherwise
// the wizard shows "scan all" while still offering the include field.
assert.strictEqual(
  window.setupWizard.includeTag.disabled,
  true,
  'populateInitialValues should apply the scan-all state to the field'
);
assert.ok(
  window.setupWizard.includeTagsSection.classList.contains('hidden'),
  'populateInitialValues should hide the include section when scan-all is on'
);

console.log('✅ test-setup-wizard-tag-default passed');
