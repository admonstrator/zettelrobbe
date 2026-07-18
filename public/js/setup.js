/* global Swal */
class SetupWizard {
    constructor() {
        this.bootstrap = window.__SETUP_BOOTSTRAP__ || {};
        this.config = this.bootstrap.config || {};
        this.defaults = this.bootstrap.defaults || {};
        this.presets = Array.isArray(this.bootstrap.aiProviderPresets) ? this.bootstrap.aiProviderPresets : [];

        this.steps = Array.from(document.querySelectorAll('.setup-step'));
        this.stepLabel = document.getElementById('setupStepLabel');
        this.progressFill = document.getElementById('setupProgressFill');
        this.prevBtn = document.getElementById('prevStepBtn');
        this.nextBtn = document.getElementById('nextStepBtn');

        this.currentStep = 0;
        this.includeTags = [];
        this.excludeTags = [];

        this.mfaState = {
            challengeId: '',
            verified: false,
            setupStarted: false
        };

        this.paperlessTestState = {
            ran: false,
            success: false,
            allowFailure: false
        };

        this.aiTestState = {
            ran: false,
            success: false,
            allowFailure: false
        };

        this.ocrTestState = {
            ran: false,
            success: false,
            allowFailure: false
        };

        this.metadataState = {
            loaded: false,
            tagNames: []
        };

        this.quickstartState = {
            mode: 'manual',
            detected: false,
            detection: null,
            ocrApplied: false
        };

        this.bindElements();
        this.initialize();
    }

    bindElements() {
        this.form = document.getElementById('setupWizardForm');

        this.adminUsername = document.getElementById('adminUsername');
        this.adminPassword = document.getElementById('adminPassword');
        this.confirmPassword = document.getElementById('confirmPassword');
        this.passwordHint = document.getElementById('passwordHint');

        this.enableMfa = document.getElementById('enableMfa');
        this.mfaSetupPanel = document.getElementById('mfaSetupPanel');
        this.startMfaSetupBtn = document.getElementById('startMfaSetupBtn');
        this.mfaProvisioningBox = document.getElementById('mfaProvisioningBox');
        this.setupMfaQrImage = document.getElementById('setupMfaQrImage');
        this.setupMfaSecret = document.getElementById('setupMfaSecret');
        this.setupMfaCode = document.getElementById('setupMfaCode');
        this.confirmMfaCodeBtn = document.getElementById('confirmMfaCodeBtn');
        this.mfaStatusHint = document.getElementById('mfaStatusHint');

        this.paperlessUrl = document.getElementById('paperlessUrl');
        this.paperlessUsername = document.getElementById('paperlessUsername');
        this.paperlessToken = document.getElementById('paperlessToken');
        this.testPaperlessBtn = document.getElementById('testPaperlessBtn');
        this.paperlessTestStatePill = document.getElementById('paperlessTestState');

        this.fetchMetadataBtn = document.getElementById('fetchMetadataBtn');
        this.metadataLoadStatePill = document.getElementById('metadataLoadState');
        this.documentsCount = document.getElementById('documentsCount');
        this.correspondentsCount = document.getElementById('correspondentsCount');
        this.tagsCount = document.getElementById('tagsCount');
        this.scanAllDocuments = document.getElementById('scanAllDocuments');
        this.includeTag = document.getElementById('includeTag');
        this.addIncludeTagBtn = document.getElementById('addIncludeTagBtn');
        this.includeTagsContainer = document.getElementById('includeTagsContainer');
        this.excludeTagInput = document.getElementById('excludeTagInput');
        this.addExcludeTagBtn = document.getElementById('addExcludeTagBtn');
        this.excludeTagsContainer = document.getElementById('excludeTagsContainer');
        this.processedTag = document.getElementById('processedTag');
        this.automaticScanEnabled = document.getElementById('automaticScanEnabled');
        this.scanInterval = document.getElementById('scanInterval');
        this.paperlessTagsDatalist = document.getElementById('paperlessTagsDatalist');

        this.aiPreset = document.getElementById('aiPreset');
        this.aiPresetHint = document.getElementById('aiPresetHint');
        this.aiProvider = document.getElementById('aiProvider');
        this.aiApiUrl = document.getElementById('aiApiUrl');
        this.aiToken = document.getElementById('aiToken');
        this.aiModel = document.getElementById('aiModel');
        this.fetchAiModelsBtn = document.getElementById('fetchAiModelsBtn');
        this.aiValidationTimeout = document.getElementById('aiValidationTimeout');
        this.testAiBtn = document.getElementById('testAiBtn');
        this.aiTestStatePill = document.getElementById('aiTestState');

        this.aiModeQuickstartBtn = document.getElementById('aiModeQuickstartBtn');
        this.aiModeManualBtn = document.getElementById('aiModeManualBtn');
        this.aiQuickstartPanel = document.getElementById('aiQuickstartPanel');
        this.aiManualPanel = document.getElementById('aiManualPanel');
        this.quickstartBaseUrl = document.getElementById('quickstartBaseUrl');
        this.quickstartApiKey = document.getElementById('quickstartApiKey');
        this.quickstartDetectBtn = document.getElementById('quickstartDetectBtn');
        this.quickstartDetectStatePill = document.getElementById('quickstartDetectState');
        this.quickstartHint = document.getElementById('quickstartHint');
        this.quickstartAiModel = document.getElementById('quickstartAiModel');
        this.quickstartOcrModel = document.getElementById('quickstartOcrModel');
        this.quickstartEnableOcr = document.getElementById('quickstartEnableOcr');
        this.quickstartOcrHint = document.getElementById('quickstartOcrHint');
        this.quickstartSaveRow = document.getElementById('quickstartSaveRow');
        this.quickstartSaveBtn = document.getElementById('quickstartSaveBtn');
        this.ocrQuickstartNotice = document.getElementById('ocrQuickstartNotice');

        this.mistralOcrEnabled = document.getElementById('mistralOcrEnabled');
        this.mistralFields = document.getElementById('mistralFields');
        this.ocrProvider = document.getElementById('ocrProvider');
        this.ocrApiUrl = document.getElementById('ocrApiUrl');
        this.ocrApiUrlContainer = document.getElementById('ocrApiUrlContainer');
        this.ocrApiKeyContainer = document.getElementById('ocrApiKeyContainer');
        this.ocrApiKey = document.getElementById('ocrApiKey');
        this.mistralOcrModel = document.getElementById('mistralOcrModel');
        this.fetchOcrModelsBtn = document.getElementById('fetchOcrModelsBtn');
        this.ocrValidationTimeout = document.getElementById('ocrValidationTimeout');
        this.testOcrBtn = document.getElementById('testOcrBtn');
        this.ocrTestStatePill = document.getElementById('ocrTestState');

        this.envPreview = document.getElementById('envPreview');
        this.copyEnvPreviewBtn = document.getElementById('copyEnvPreviewBtn');
        this.finalizeSetupBtn = document.getElementById('finalizeSetupBtn');
    }

    initialize() {
        this.installFetchCsrfInterceptor();
        this.populateInitialValues();
        this.populateAiPresets();
        this.bindEvents();
        this.renderIncludeTags();
        this.renderExcludeTags();
        this.updateMfaPanelVisibility();
        this.toggleIncludeTagField();
        this.toggleMistralFields();
        // Fresh installs start in quickstart mode; existing configs open in
        // manual mode so their loaded values stay visible.
        this.setAiConfigMode(this.config.AI_PROVIDER ? 'manual' : 'quickstart');
        this.showStep(0);
    }

    installFetchCsrfInterceptor() {
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
            let [resource, options] = args;
            options = options || {};
            const method = String(options.method || 'GET').toUpperCase();
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
                const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
                if (token) {
                    if (!options.headers) {
                        options.headers = {};
                    }
                    if (options.headers instanceof Headers) {
                        if (!options.headers.has('X-CSRF-Token')) {
                            options.headers.append('X-CSRF-Token', token);
                        }
                    } else if (!options.headers['X-CSRF-Token']) {
                        options.headers['X-CSRF-Token'] = token;
                    }
                }
            }
            return originalFetch(resource, options);
        };
    }

    populateInitialValues() {
        this.adminUsername.value = this.config.username || '';
        this.scanInterval.value = this.config.SCAN_INTERVAL || this.defaults.scanInterval || '*/30 * * * *';
        this.scanAllDocuments.checked = this.config.PROCESS_PREDEFINED_DOCUMENTS === 'no';
        this.includeTags = Array.isArray(this.config.TAGS) ? this.config.TAGS.slice() : [];
        this.includeTag.value = '';
        this.excludeTags = Array.isArray(this.config.IGNORE_TAGS) ? this.config.IGNORE_TAGS.slice() : [];

        const mistralEnabled = this.config.MISTRAL_OCR_ENABLED === 'yes';
        this.mistralOcrEnabled.value = mistralEnabled ? 'yes' : 'no';
        const rawOcrProvider = (this.config.OCR_PROVIDER || 'mistral').toLowerCase();
        this.ocrProvider.value = rawOcrProvider === 'ollama' ? 'custom' : rawOcrProvider;
        this.ocrApiUrl.value = this.config.OCR_API_URL || '';
        this.setModelSelectOptions(this.mistralOcrModel, [this.config.MISTRAL_OCR_MODEL || 'mistral-ocr-latest'], 'Select OCR model');
        this.mistralOcrModel.value = this.config.MISTRAL_OCR_MODEL || 'mistral-ocr-latest';
        this.ocrValidationTimeout.value = this.getOcrValidationTimeoutSeconds();
        this.processedTag.value = this.config.AI_PROCESSED_TAG_NAME || 'ai-processed';
        this.aiValidationTimeout.value = this.getAiValidationTimeoutSeconds();

        const provider = String(this.config.AI_PROVIDER || 'custom').trim().toLowerCase();
        this.aiProvider.value = provider;

        if (provider === 'openai') {
            this.aiApiUrl.value = this.config.OPENAI_API_URL || 'https://api.openai.com/v1';
            this.setModelSelectOptions(this.aiModel, [this.config.OPENAI_MODEL || 'gpt-4o-mini'], 'Select model');
            this.aiModel.value = this.config.OPENAI_MODEL || 'gpt-4o-mini';
            this.aiToken.value = this.config.OPENAI_API_KEY || '';
        } else if (provider === 'ollama') {
            this.aiApiUrl.value = this.config.OLLAMA_API_URL || 'http://localhost:11434';
            this.setModelSelectOptions(this.aiModel, [this.config.OLLAMA_MODEL || 'llama3.2'], 'Select model');
            this.aiModel.value = this.config.OLLAMA_MODEL || 'llama3.2';
            this.aiToken.value = this.config.OLLAMA_API_KEY || '';
        } else if (provider === 'azure') {
            this.aiApiUrl.value = this.config.AZURE_ENDPOINT || '';
            this.setModelSelectOptions(this.aiModel, [this.config.AZURE_DEPLOYMENT_NAME || ''], 'Select model');
            this.aiModel.value = this.config.AZURE_DEPLOYMENT_NAME || '';
            this.aiToken.value = this.config.AZURE_API_KEY || '';
        } else {
            this.aiProvider.value = 'custom';
            this.aiApiUrl.value = this.config.CUSTOM_BASE_URL || '';
            this.setModelSelectOptions(this.aiModel, [this.config.CUSTOM_MODEL || ''], 'Select model');
            this.aiModel.value = this.config.CUSTOM_MODEL || '';
            this.aiToken.value = this.config.CUSTOM_API_KEY || '';
        }
    }

    findMatchingPreset() {
        const provider = String(this.aiProvider.value || '').trim().toLowerCase();
        const apiUrl = String(this.aiApiUrl.value || '').trim().replace(/\/+$/, '');
        const model = String(this.aiModel.value || '').trim();

        return this.presets.find((preset) => {
            const presetProvider = String(preset.provider || '').trim().toLowerCase();
            const presetApiUrl = String(preset.apiUrl || '').trim().replace(/\/+$/, '');
            const presetModel = String(preset.model || '').trim();
            return presetProvider === provider && presetApiUrl === apiUrl && presetModel === model;
        }) || null;
    }

    getNormalizedTimeoutSeconds(rawValue, fallbackMs = 30000) {
        const parsed = Number.parseInt(String(rawValue || '').trim(), 10);
        const normalizedMs = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1000), 7200000) : fallbackMs;
        return String(Math.round(normalizedMs / 1000));
    }

    getAiValidationTimeoutSeconds() {
        return this.getNormalizedTimeoutSeconds(this.config.SETUP_VALIDATION_TIMEOUT_MS || '30000');
    }

    getOcrValidationTimeoutSeconds() {
        return this.getNormalizedTimeoutSeconds(
            this.config.SETUP_OCR_VALIDATION_TIMEOUT_MS || this.config.SETUP_VALIDATION_TIMEOUT_MS || '30000'
        );
    }

    getTimeoutMs(inputElement, fallbackSeconds = 30) {
        const rawSeconds = Number.parseInt(String(inputElement?.value || String(fallbackSeconds)).trim(), 10);
        const normalizedSeconds = Number.isFinite(rawSeconds) ? Math.min(Math.max(rawSeconds, 1), 7200) : 30;
        return normalizedSeconds * 1000;
    }

    getAiValidationTimeoutMs() {
        return this.getTimeoutMs(this.aiValidationTimeout, 30);
    }

    getOcrValidationTimeoutMs() {
        return this.getTimeoutMs(this.ocrValidationTimeout, 30);
    }

    populateAiPresets() {
        this.aiPreset.innerHTML = '';

        const customOption = document.createElement('option');
        customOption.value = '';
        customOption.textContent = 'Manual custom configuration';
        this.aiPreset.appendChild(customOption);

        this.presets.forEach((preset) => {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = preset.label;
            this.aiPreset.appendChild(option);
        });

        const matchingPreset = this.findMatchingPreset();
        if (matchingPreset) {
            this.aiPreset.value = matchingPreset.id;
            this.aiPresetHint.textContent = `Preset "${matchingPreset.label}" selected.`;
        } else {
            this.aiPreset.value = '';
            this.aiPresetHint.textContent = 'Manual mode: choose provider and enter values yourself. Token is optional for custom endpoints.';
        }
    }

    bindEvents() {
        this.prevBtn.addEventListener('click', () => this.goToPreviousStep());
        this.nextBtn.addEventListener('click', () => this.goToNextStep());
        this.setModelSelectOptions(this.aiModel, [], 'Select model');

        this.adminPassword.addEventListener('input', () => this.updatePasswordHint());
        this.confirmPassword.addEventListener('input', () => this.updatePasswordHint());

        this.enableMfa.addEventListener('change', () => this.updateMfaPanelVisibility());
        if (this.startMfaSetupBtn) {
            this.startMfaSetupBtn.addEventListener('click', () => this.startMfaSetup());
        }
        this.confirmMfaCodeBtn.addEventListener('click', () => this.confirmMfaCode());

        this.scanAllDocuments.addEventListener('change', () => this.toggleIncludeTagField());
        if (this.addIncludeTagBtn) {
            this.addIncludeTagBtn.addEventListener('click', () => this.addIncludeTag(this.includeTag.value));
        }
        if (this.includeTag) {
            this.includeTag.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') {
                    return;
                }

                event.preventDefault();
                this.addIncludeTag(this.includeTag.value);
            });
        }

        if (this.addExcludeTagBtn) {
            this.addExcludeTagBtn.addEventListener('click', () => this.addExcludeTag(this.excludeTagInput.value));
        }
        if (this.excludeTagInput) {
            this.excludeTagInput.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') {
                    return;
                }
                event.preventDefault();
                this.addExcludeTag(this.excludeTagInput.value);
            });
        }

        this.testPaperlessBtn.addEventListener('click', () => this.testPaperlessConnection());
        this.fetchMetadataBtn.addEventListener('click', () => this.loadPaperlessMetadata());

        this.testAiBtn.addEventListener('click', () => this.testAiConnection());
        if (this.fetchAiModelsBtn) {
            this.fetchAiModelsBtn.addEventListener('click', () => this.fetchAiModels());
        }
        if (this.aiPreset) {
            this.aiPreset.addEventListener('change', () => {
                const preset = this.presets.find((entry) => entry.id === this.aiPreset.value) || null;
                this.applyPreset(preset);
            });
        }

        if (this.aiModeQuickstartBtn) {
            this.aiModeQuickstartBtn.addEventListener('click', () => this.setAiConfigMode('quickstart'));
        }
        if (this.aiModeManualBtn) {
            this.aiModeManualBtn.addEventListener('click', () => this.setAiConfigMode('manual'));
        }
        if (this.quickstartDetectBtn) {
            this.quickstartDetectBtn.addEventListener('click', () => this.runQuickstartDetect());
        }
        if (this.quickstartAiModel) {
            this.quickstartAiModel.addEventListener('change', () => this.applyQuickstartToManualFields());
        }
        if (this.quickstartOcrModel) {
            this.quickstartOcrModel.addEventListener('change', () => this.applyQuickstartToManualFields());
        }
        if (this.quickstartEnableOcr) {
            this.quickstartEnableOcr.addEventListener('change', () => this.applyQuickstartToManualFields());
        }
        if (this.quickstartSaveBtn) {
            this.quickstartSaveBtn.addEventListener('click', () => this.runQuickstartSaveFlow());
        }

        this.mistralOcrEnabled.addEventListener('change', () => this.toggleMistralFields());
        this.ocrProvider.addEventListener('change', () => this.toggleMistralFields());
        this.testOcrBtn.addEventListener('click', () => this.testOcrConnection());
        if (this.fetchOcrModelsBtn) {
            this.fetchOcrModelsBtn.addEventListener('click', () => this.fetchOcrModels());
        }

        this.copyEnvPreviewBtn.addEventListener('click', () => this.copyEnvPreview());
        this.finalizeSetupBtn.addEventListener('click', () => this.finalizeSetup());
    }

    setModelSelectOptions(selectElement, values, emptyLabel = 'Select model') {
        if (!selectElement) {
            return;
        }

        selectElement.innerHTML = '';
        const normalizedValues = (Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean);

        const emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.textContent = emptyLabel;
        emptyOption.selected = normalizedValues.length === 0;
        selectElement.appendChild(emptyOption);

        const unique = Array.from(new Set(normalizedValues));
        unique.forEach((value) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            selectElement.appendChild(option);
        });

        selectElement.value = unique.length > 0 ? unique[0] : '';
    }

    getPopupThemeOptions() {
        return {
            customClass: {
                popup: 'setup-swal-popup',
                title: 'setup-swal-title',
                htmlContainer: 'setup-swal-html',
                actions: 'setup-swal-actions',
                confirmButton: 'setup-swal-confirm',
                cancelButton: 'setup-swal-cancel'
            },
            buttonsStyling: false,
            backdrop: 'rgba(2, 6, 23, 0.72)'
        };
    }

    showPopup(options = {}) {
        return Swal.fire({
            ...this.getPopupThemeOptions(),
            ...options
        });
    }

    isTimeoutMessage(message) {
        const normalized = String(message || '').toLowerCase();
        return normalized.includes('timeout')
            || normalized.includes('timed out')
            || normalized.includes('[timeout]');
    }

    buildTimeoutUiMessage(scope, timeoutMs, originalMessage = '') {
        const normalizedScope = String(scope || 'Request').trim();
        const timeoutPart = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
            ? ` after ${Number(timeoutMs)}ms`
            : '';
        const original = String(originalMessage || '').trim();
        return original
            ? `${normalizedScope} timed out${timeoutPart}. Please check provider availability and increase timeout if needed. Original error: ${original}`
            : `${normalizedScope} timed out${timeoutPart}. Please check provider availability and increase timeout if needed.`;
    }

    getOperationErrorDetails(scope, error, timeoutMs) {
        const rawMessage = String(error?.message || error || 'Request failed');
        if (!this.isTimeoutMessage(rawMessage)) {
            return {
                isTimeout: false,
                message: rawMessage
            };
        }

        return {
            isTimeout: true,
            message: this.buildTimeoutUiMessage(scope, timeoutMs, rawMessage)
        };
    }

    showStep(index) {
        if (index < 0 || index >= this.steps.length) {
            return;
        }

        this.steps.forEach((stepElement, stepIndex) => {
            stepElement.classList.toggle('is-active', stepIndex === index);
        });

        this.currentStep = index;
        this.prevBtn.disabled = index === 0;
        this.nextBtn.classList.toggle('hidden', index === this.steps.length - 1);

        const progressPercent = ((index + 1) / this.steps.length) * 100;
        this.progressFill.style.width = `${progressPercent}%`;

        const stepTitle = this.steps[index].dataset.stepTitle || `Step ${index + 1}`;
        this.stepLabel.textContent = `Step ${index + 1} of ${this.steps.length}: ${stepTitle}`;

        if (index === this.steps.length - 1) {
            this.renderEnvPreview();
        }
    }

    async goToNextStep() {
        const canContinue = await this.validateStepBeforeContinue(this.currentStep);
        if (!canContinue) {
            return;
        }

        this.showStep(this.currentStep + 1);
    }

    goToPreviousStep() {
        this.showStep(this.currentStep - 1);
    }

    updatePasswordHint() {
        const password = this.adminPassword.value;
        const confirmPassword = this.confirmPassword.value;

        if (!password) {
            this.passwordHint.textContent = 'Use at least 8 characters.';
            this.passwordHint.className = 'setup-hint';
            return;
        }

        if (password.length < 8) {
            this.passwordHint.textContent = 'Password is too short.';
            this.passwordHint.className = 'setup-hint setup-hint-error';
            return;
        }

        if (confirmPassword && password !== confirmPassword) {
            this.passwordHint.textContent = 'Passwords do not match.';
            this.passwordHint.className = 'setup-hint setup-hint-error';
            return;
        }

        this.passwordHint.textContent = 'Password looks good.';
        this.passwordHint.className = 'setup-hint setup-hint-success';
    }

    updateMfaPanelVisibility() {
        const enabled = this.enableMfa.value === 'yes';
        this.mfaSetupPanel.classList.toggle('hidden', !enabled);
        if (!enabled) {
            this.mfaState.challengeId = '';
            this.mfaState.verified = false;
            this.mfaState.setupStarted = false;
            this.mfaStatusHint.textContent = '';
            this.mfaStatusHint.className = 'setup-hint';
            this.mfaProvisioningBox.classList.add('hidden');
        }
    }

    toggleIncludeTagField() {
        const scanAll = this.scanAllDocuments.checked;
        this.includeTag.disabled = scanAll;
        if (scanAll) {
            this.includeTag.value = '';
        }
    }

    getEffectiveIncludeTags() {
        return Array.from(new Set(
            (Array.isArray(this.includeTags) ? this.includeTags : [])
                .map((value) => String(value || '').trim())
                .filter(Boolean)
        ));
    }

    addIncludeTag(value) {
        const normalized = String(value || '').trim();
        if (!normalized) {
            return;
        }

        if (!this.includeTags.includes(normalized)) {
            this.includeTags.push(normalized);
            this.renderIncludeTags();
        }

        this.includeTag.value = '';
    }

    removeIncludeTag(tag) {
        this.includeTags = this.includeTags.filter((entry) => entry !== tag);
        this.renderIncludeTags();
    }

    renderIncludeTags() {
        if (!this.includeTagsContainer) {
            return;
        }

        this.includeTagsContainer.innerHTML = '';
        const tags = this.getEffectiveIncludeTags();

        if (tags.length === 0) {
            const hint = document.createElement('p');
            hint.className = 'setup-hint';
            hint.textContent = 'No include tags selected.';
            this.includeTagsContainer.appendChild(hint);
            return;
        }

        tags.forEach((tag) => {
            const chip = document.createElement('div');
            chip.className = 'bg-blue-100 text-blue-800 px-3 py-1 rounded-full flex items-center gap-2';
            chip.innerHTML = `<span>${tag}</span>`;

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'hover:text-blue-600';
            removeBtn.innerHTML = '<i class="fas fa-times"></i>';
            removeBtn.addEventListener('click', () => this.removeIncludeTag(tag));

            chip.appendChild(removeBtn);
            this.includeTagsContainer.appendChild(chip);
        });
    }

    toggleMistralFields() {
        const enabled = this.mistralOcrEnabled.value === 'yes';
        this.mistralFields.classList.toggle('hidden', !enabled);

        const provider = (this.ocrProvider.value || 'mistral').toLowerCase();
        if (this.ocrApiKeyContainer) {
            this.ocrApiKeyContainer.classList.toggle('hidden', !enabled);
        }

        if (this.ocrApiUrlContainer) {
            this.ocrApiUrlContainer.classList.toggle('hidden', provider !== 'custom' || !enabled);
        }
    }

    normalizeOcrApiUrlForProvider(provider, rawUrl) {
        const normalizedProvider = String(provider || 'mistral').toLowerCase();
        if (normalizedProvider === 'mistral') {
            return '';
        }

        return String(rawUrl || '').trim();
    }

    async testOcrConnection() {
        const payload = {
            enabled: this.mistralOcrEnabled.value === 'yes',
            provider: (this.ocrProvider.value || 'mistral').toLowerCase(),
            apiUrl: this.normalizeOcrApiUrlForProvider(this.ocrProvider.value, this.ocrApiUrl.value),
            apiKey: this.ocrApiKey.value.trim(),
            model: this.mistralOcrModel.value.trim() || 'mistral-ocr-latest',
            setupOcrValidationTimeoutMs: this.getOcrValidationTimeoutMs()
        };

        if (!payload.enabled) {
            this.setPillState(this.ocrTestStatePill, 'success', 'Disabled (skipped)');
            this.ocrTestState.ran = true;
            this.ocrTestState.success = true;
            return;
        }

        this.setButtonLoading(this.testOcrBtn, true, 'Testing...');
        this.setPillState(this.ocrTestStatePill, 'loading', 'Testing...');

        try {
            const result = await this.request('/api/setup/ocr/test', payload);
            this.ocrTestState.ran = true;
            this.ocrTestState.success = Boolean(result.success);

            if (result.resolvedApiUrl && this.ocrApiUrl) {
                this.ocrApiUrl.value = String(result.resolvedApiUrl).trim();
            }

            if (result.success) {
                this.setPillState(this.ocrTestStatePill, 'success', 'Connection valid');
                await this.showPopup({ icon: 'success', title: 'OCR test successful', text: result.message || 'OCR provider is reachable.' });
            } else {
                this.setPillState(this.ocrTestStatePill, 'error', 'Test failed');
                await this.showPopup({ icon: 'error', title: 'OCR test failed', text: result.message || 'OCR connection test failed.' });
            }
        } catch (error) {
            const errorDetails = this.getOperationErrorDetails('OCR response', error, payload.setupOcrValidationTimeoutMs);
            this.ocrTestState.ran = true;
            this.ocrTestState.success = false;
            this.setPillState(this.ocrTestStatePill, 'error', errorDetails.isTimeout ? 'Timeout reached' : 'Test failed');
            await this.showPopup({
                icon: 'error',
                title: errorDetails.isTimeout ? 'OCR timeout reached' : 'OCR test failed',
                text: errorDetails.message
            });
        } finally {
            this.setButtonLoading(this.testOcrBtn, false);
        }
    }

    setPillState(element, type, text) {
        element.textContent = text;
        element.className = 'setup-pill';
        if (type === 'success') {
            element.classList.add('setup-pill-success');
        } else if (type === 'error') {
            element.classList.add('setup-pill-error');
        } else if (type === 'loading') {
            element.classList.add('setup-pill-loading');
        }
    }

    setButtonLoading(button, loading, loadingText) {
        if (loading) {
            if (!button.dataset.originalHtml) {
                button.dataset.originalHtml = button.innerHTML;
            }
            button.disabled = true;
            button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${loadingText}`;
            return;
        }

        button.disabled = false;
        if (button.dataset.originalHtml) {
            button.innerHTML = button.dataset.originalHtml;
        }
    }

    async request(url, payload) {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload || {})
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || 'Request failed');
        }

        return result;
    }

    async startMfaSetup() {
        const username = this.adminUsername.value.trim();
        if (!username) {
            await this.showPopup({ icon: 'warning', title: 'Username required', text: 'Please complete username first.' });
            return;
        }

        this.setButtonLoading(this.startMfaSetupBtn, true, 'Generating...');
        try {
            const result = await this.request('/api/setup/mfa/setup', { username });
            this.mfaState.challengeId = result.challengeId;
            this.mfaState.setupStarted = true;
            this.mfaState.verified = false;

            this.setupMfaSecret.value = result.secret || '';
            this.setupMfaQrImage.src = result.qrDataUrl || '';
            this.setupMfaQrImage.classList.toggle('hidden', !result.qrDataUrl);
            this.mfaProvisioningBox.classList.remove('hidden');

            this.mfaStatusHint.textContent = 'Scan the QR code and confirm with a current authentication code.';
            this.mfaStatusHint.className = 'setup-hint';
        } catch (error) {
            await this.showPopup({ icon: 'error', title: 'MFA setup failed', text: error.message });
        } finally {
            this.setButtonLoading(this.startMfaSetupBtn, false);
        }
    }

    async confirmMfaCode() {
        if (!this.mfaState.challengeId) {
            await this.showPopup({ icon: 'warning', title: 'Setup not started', text: 'Generate a QR code first.' });
            return;
        }

        const token = this.setupMfaCode.value.trim();
        if (!token) {
            await this.showPopup({ icon: 'warning', title: 'Code required', text: 'Enter your authenticator code.' });
            return;
        }

        this.setButtonLoading(this.confirmMfaCodeBtn, true, 'Validating...');
        try {
            await this.request('/api/setup/mfa/confirm', {
                challengeId: this.mfaState.challengeId,
                token
            });
            this.mfaState.verified = true;
            this.mfaStatusHint.textContent = 'MFA confirmed. You can continue.';
            this.mfaStatusHint.className = 'setup-hint setup-hint-success';
            this.setupMfaCode.value = '';
        } catch (error) {
            this.mfaState.verified = false;
            this.mfaStatusHint.textContent = error.message;
            this.mfaStatusHint.className = 'setup-hint setup-hint-error';
        } finally {
            this.setButtonLoading(this.confirmMfaCodeBtn, false);
        }
    }

    async testPaperlessConnection() {
        const payload = {
            paperlessUrl: this.paperlessUrl.value.trim(),
            paperlessToken: this.paperlessToken.value.trim()
        };

        if (!payload.paperlessUrl || !payload.paperlessToken) {
            await this.showPopup({ icon: 'warning', title: 'Missing values', text: 'Enter Paperless URL and token first.' });
            return;
        }

        this.setButtonLoading(this.testPaperlessBtn, true, 'Testing...');
        this.setPillState(this.paperlessTestStatePill, 'loading', 'Testing...');

        try {
            const result = await this.request('/api/setup/paperless/test', payload);
            this.paperlessTestState.ran = true;
            this.paperlessTestState.success = Boolean(result.success);
            this.paperlessTestState.allowFailure = false;

            if (result.success) {
                this.setPillState(this.paperlessTestStatePill, 'success', 'Connection valid');
                await this.showPopup({ icon: 'success', title: 'Paperless test successful', text: result.message || 'Connection and permissions look good.' });
            } else {
                this.setPillState(this.paperlessTestStatePill, 'error', 'Test failed');
                await this.showPopup({ icon: 'error', title: 'Paperless test failed', text: result.message || 'Connection test failed.' });
            }
        } catch (error) {
            this.paperlessTestState.ran = true;
            this.paperlessTestState.success = false;
            this.setPillState(this.paperlessTestStatePill, 'error', 'Test failed');
            await this.showPopup({ icon: 'error', title: 'Paperless test failed', text: error.message });
        } finally {
            this.setButtonLoading(this.testPaperlessBtn, false);
        }
    }

    async loadPaperlessMetadata() {
        const payload = {
            paperlessUrl: this.paperlessUrl.value.trim(),
            paperlessToken: this.paperlessToken.value.trim()
        };

        if (!payload.paperlessUrl || !payload.paperlessToken) {
            await this.showPopup({ icon: 'warning', title: 'Missing values', text: 'Enter and test Paperless credentials first.' });
            return;
        }

        this.setButtonLoading(this.fetchMetadataBtn, true, 'Loading...');
        this.setPillState(this.metadataLoadStatePill, 'loading', 'Loading...');

        try {
            const result = await this.request('/api/setup/paperless/metadata', payload);
            const metadata = result.metadata || {};

            this.documentsCount.textContent = String(metadata.documents ?? '-');
            this.correspondentsCount.textContent = String(metadata.correspondents ?? '-');
            this.tagsCount.textContent = String(metadata.tags ?? '-');

            this.metadataState.loaded = true;
            this.metadataState.tagNames = Array.isArray(result.tagNames) ? result.tagNames : [];

            this.fillTagDatalist();
            this.setPillState(this.metadataLoadStatePill, 'success', 'Loaded');
        } catch (error) {
            this.metadataState.loaded = false;
            this.setPillState(this.metadataLoadStatePill, 'error', 'Load failed');
            await this.showPopup({ icon: 'error', title: 'Metadata loading failed', text: error.message });
        } finally {
            this.setButtonLoading(this.fetchMetadataBtn, false);
        }
    }

    fillTagDatalist() {
        this.paperlessTagsDatalist.innerHTML = '';
        this.metadataState.tagNames.forEach((tagName) => {
            const option = document.createElement('option');
            option.value = tagName;
            this.paperlessTagsDatalist.appendChild(option);
        });
    }

    getEffectiveExcludeTags() {
        const processedTag = String(this.processedTag?.value || '').trim();
        const normalizedManualTags = (Array.isArray(this.excludeTags) ? this.excludeTags : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean);

        if (!processedTag) {
            return Array.from(new Set(normalizedManualTags));
        }

        return Array.from(new Set([...normalizedManualTags, processedTag]));
    }

    addExcludeTag(value) {
        const normalized = String(value || '').trim();
        if (!normalized) {
            return;
        }

        if (!this.excludeTags.includes(normalized)) {
            this.excludeTags.push(normalized);
            this.renderExcludeTags();
        }

        this.excludeTagInput.value = '';
    }

    removeExcludeTag(tag) {
        this.excludeTags = this.excludeTags.filter((entry) => entry !== tag);
        this.renderExcludeTags();
    }

    renderExcludeTags() {
        this.excludeTagsContainer.innerHTML = '';

        if (this.excludeTags.length === 0) {
            const hint = document.createElement('p');
            hint.className = 'setup-hint';
            hint.textContent = 'No excluded tags selected.';
            this.excludeTagsContainer.appendChild(hint);
            return;
        }

        this.excludeTags.forEach((tag) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'setup-chip';
            chip.innerHTML = `<span>${tag}</span><i class="fas fa-xmark"></i>`;
            chip.addEventListener('click', () => this.removeExcludeTag(tag));
            this.excludeTagsContainer.appendChild(chip);
        });
    }

    applyPreset(preset) {
        if (!preset) {
            this.aiPresetHint.textContent = 'Manual mode: choose provider and enter values yourself. Token is optional for custom endpoints.';
            return;
        }

        this.aiProvider.value = preset.provider || 'custom';
        this.aiApiUrl.value = preset.apiUrl || '';
        this.aiModel.value = preset.model || '';
        this.aiToken.placeholder = preset.tokenPlaceholder || 'Enter API token if required';
        this.aiPresetHint.textContent = `Preset "${preset.label}" selected.${this.aiProvider.value === 'custom' ? ' Token can stay empty if your endpoint allows anonymous access.' : ''}`;
    }

    setAiConfigMode(mode) {
        const normalizedMode = mode === 'quickstart' ? 'quickstart' : 'manual';
        this.quickstartState.mode = normalizedMode;

        if (this.aiQuickstartPanel) {
            this.aiQuickstartPanel.classList.toggle('hidden', normalizedMode !== 'quickstart');
        }
        if (this.aiManualPanel) {
            this.aiManualPanel.classList.toggle('hidden', normalizedMode !== 'manual');
        }
        if (this.aiModeQuickstartBtn) {
            this.aiModeQuickstartBtn.setAttribute('aria-pressed', normalizedMode === 'quickstart' ? 'true' : 'false');
        }
        if (this.aiModeManualBtn) {
            this.aiModeManualBtn.setAttribute('aria-pressed', normalizedMode === 'manual' ? 'true' : 'false');
        }
    }

    async runQuickstartDetect() {
        const baseUrl = String(this.quickstartBaseUrl?.value || '').trim();
        if (!baseUrl) {
            await this.showPopup({ icon: 'warning', title: 'URL required', text: 'Enter the base URL of your AI server first.' });
            return;
        }

        const payload = {
            baseUrl,
            apiKey: String(this.quickstartApiKey?.value || '').trim(),
            setupValidationTimeoutMs: this.getAiValidationTimeoutMs()
        };

        this.setButtonLoading(this.quickstartDetectBtn, true, 'Detecting...');
        this.setPillState(this.quickstartDetectStatePill, 'loading', 'Detecting...');

        try {
            const result = await this.request('/api/setup/quickstart/detect', payload);
            const detection = result.detection || {};

            this.quickstartState.detected = true;
            this.quickstartState.detection = detection;

            const textModels = Array.isArray(detection.textModels) ? detection.textModels : [];
            // Every detected model that isn't embedding-only is a valid OCR
            // candidate (textModels already excludes embedding-only models -
            // see quickstartService.classifyModelName). Rather than also
            // gating on the vision name-heuristic (which can miss real
            // OCR-capable models with unfamiliar names, e.g. dedicated OCR
            // models), offer the full list here and let the user pick; a
            // heuristic "suggested" default is still pre-selected below.
            const ocrCandidateModels = textModels;

            this.setModelSelectOptions(this.quickstartAiModel, textModels, textModels.length > 0 ? 'Select AI model' : 'No text-capable models found');
            this.quickstartAiModel.disabled = textModels.length === 0;
            if (detection.suggestedAiModel) {
                this.quickstartAiModel.value = detection.suggestedAiModel;
            }

            this.setModelSelectOptions(this.quickstartOcrModel, ocrCandidateModels, ocrCandidateModels.length > 0 ? 'Select OCR model' : 'No models found');
            this.quickstartOcrModel.disabled = ocrCandidateModels.length === 0;
            if (detection.suggestedOcrModel) {
                this.quickstartOcrModel.value = detection.suggestedOcrModel;
            }

            const hasOcrCandidateModels = ocrCandidateModels.length > 0;
            this.quickstartEnableOcr.disabled = !hasOcrCandidateModels;
            this.quickstartEnableOcr.checked = hasOcrCandidateModels;
            if (this.quickstartOcrHint) {
                this.quickstartOcrHint.classList.toggle('hidden', hasOcrCandidateModels);
                this.quickstartOcrHint.textContent = hasOcrCandidateModels
                    ? ''
                    : 'No models found — OCR fallback stays disabled.';
            }

            if (this.quickstartHint) {
                this.quickstartHint.classList.remove('hidden');
                this.quickstartHint.textContent = result.message || 'Detection complete.';
            }

            this.setPillState(this.quickstartDetectStatePill, 'success', 'Detected');
            if (this.quickstartSaveRow) {
                this.quickstartSaveRow.classList.toggle('hidden', textModels.length === 0);
            }
            this.applyQuickstartToManualFields();
        } catch (error) {
            const errorDetails = this.getOperationErrorDetails('Quickstart detection', error, payload.setupValidationTimeoutMs);
            this.quickstartState.detected = false;
            this.quickstartState.detection = null;
            if (this.quickstartSaveRow) {
                this.quickstartSaveRow.classList.add('hidden');
            }
            this.setPillState(this.quickstartDetectStatePill, 'error', errorDetails.isTimeout ? 'Timeout reached' : 'Detection failed');
            await this.showPopup({
                icon: 'error',
                title: errorDetails.isTimeout ? 'Detection timeout reached' : 'Detection failed',
                text: errorDetails.message
            });
        } finally {
            this.setButtonLoading(this.quickstartDetectBtn, false);
        }
    }

    applyQuickstartToManualFields() {
        const detection = this.quickstartState.detection;
        if (!detection) {
            return;
        }

        const selectedAiModel = String(this.quickstartAiModel?.value || '').trim();
        const quickstartKey = String(this.quickstartApiKey?.value || '').trim();

        const aiValuesChanged = this.aiProvider.value !== (detection.aiProvider || 'custom')
            || this.aiApiUrl.value !== (detection.resolvedAiApiUrl || '')
            || this.aiToken.value !== quickstartKey
            || (selectedAiModel && this.aiModel.value !== selectedAiModel);

        this.aiProvider.value = detection.aiProvider || 'custom';
        this.aiApiUrl.value = detection.resolvedAiApiUrl || '';
        this.aiToken.value = quickstartKey;
        if (selectedAiModel) {
            this.setModelSelectOptions(this.aiModel, [selectedAiModel], 'Select model');
            this.aiModel.value = selectedAiModel;
        }

        // Changed values invalidate a previous AI connection test; an
        // idempotent re-apply (e.g. during finalize re-validation) must not.
        if (aiValuesChanged) {
            this.aiTestState.ran = false;
            this.aiTestState.success = false;
            this.setPillState(this.aiTestStatePill, '', 'Not tested');
        }

        const enableOcr = Boolean(this.quickstartEnableOcr?.checked);
        const selectedOcrModel = String(this.quickstartOcrModel?.value || '').trim();

        if (enableOcr && selectedOcrModel) {
            this.mistralOcrEnabled.value = 'yes';
            this.ocrProvider.value = detection.ocrProvider || 'custom';
            this.ocrApiUrl.value = detection.resolvedOcrApiUrl || '';
            this.ocrApiKey.value = quickstartKey;
            this.setModelSelectOptions(this.mistralOcrModel, [selectedOcrModel], 'Select OCR model');
            this.mistralOcrModel.value = selectedOcrModel;
            this.quickstartState.ocrApplied = true;

            if (this.ocrQuickstartNotice) {
                this.ocrQuickstartNotice.classList.remove('hidden');
                this.ocrQuickstartNotice.textContent = `OCR was prefilled by Quickstart (model "${selectedOcrModel}" via ${detection.resolvedOcrApiUrl || 'detected endpoint'}). Adjust below if needed.`;
            }
        } else if (this.quickstartState.ocrApplied) {
            // The user unchecked the OCR option after a previous apply.
            this.mistralOcrEnabled.value = 'no';
            this.quickstartState.ocrApplied = false;
            if (this.ocrQuickstartNotice) {
                this.ocrQuickstartNotice.classList.add('hidden');
                this.ocrQuickstartNotice.textContent = '';
            }
        }

        this.toggleMistralFields();
    }

    setModelTestRowState(rowId, state, text) {
        const row = document.getElementById(rowId);
        if (!row) {
            return;
        }

        const iconPresets = {
            pending: { className: 'fas fa-spinner fa-spin', color: '' },
            success: { className: 'fas fa-circle-check', color: '#16a34a' },
            error: { className: 'fas fa-circle-xmark', color: '#dc2626' },
            skipped: { className: 'fas fa-circle-minus', color: '#94a3b8' }
        };
        const preset = iconPresets[state] || iconPresets.pending;

        row.innerHTML = '';
        const icon = document.createElement('i');
        icon.className = preset.className;
        if (preset.color) {
            icon.style.color = preset.color;
        }
        row.appendChild(icon);
        row.appendChild(document.createTextNode(` ${text}`));
    }

    toggleModelTestOverlay(visible, statusText = '') {
        const overlay = document.getElementById('modelTestOverlay');
        if (overlay) {
            overlay.classList.toggle('hidden', !visible);
        }

        const status = document.getElementById('modelTestOverlayStatus');
        if (status && statusText) {
            status.textContent = statusText;
        }
    }

    async runSilentAiTest() {
        const payload = {
            aiProvider: this.aiProvider.value.trim().toLowerCase(),
            apiUrl: this.aiApiUrl.value.trim(),
            token: this.aiToken.value.trim(),
            model: this.aiModel.value.trim(),
            setupValidationTimeoutMs: this.getAiValidationTimeoutMs()
        };

        try {
            const result = await this.request('/api/setup/ai/test', payload);
            this.aiTestState.ran = true;
            this.aiTestState.success = Boolean(result.success);

            if (result.resolvedApiUrl && this.aiApiUrl) {
                this.aiApiUrl.value = String(result.resolvedApiUrl).trim();
            }

            this.setPillState(this.aiTestStatePill, result.success ? 'success' : 'error', result.success ? 'Connection valid' : 'Test failed');
            return { success: Boolean(result.success), message: result.message || '' };
        } catch (error) {
            const errorDetails = this.getOperationErrorDetails('AI response', error, payload.setupValidationTimeoutMs);
            this.aiTestState.ran = true;
            this.aiTestState.success = false;
            this.setPillState(this.aiTestStatePill, 'error', errorDetails.isTimeout ? 'Timeout reached' : 'Test failed');
            return { success: false, message: errorDetails.message };
        }
    }

    async runSilentOcrTest() {
        const payload = {
            enabled: this.mistralOcrEnabled.value === 'yes',
            provider: (this.ocrProvider.value || 'mistral').toLowerCase(),
            apiUrl: this.normalizeOcrApiUrlForProvider(this.ocrProvider.value, this.ocrApiUrl.value),
            apiKey: this.ocrApiKey.value.trim(),
            model: this.mistralOcrModel.value.trim() || 'mistral-ocr-latest',
            setupOcrValidationTimeoutMs: this.getOcrValidationTimeoutMs()
        };

        try {
            const result = await this.request('/api/setup/ocr/test', payload);
            this.ocrTestState.ran = true;
            this.ocrTestState.success = Boolean(result.success);

            if (result.resolvedApiUrl && this.ocrApiUrl) {
                this.ocrApiUrl.value = String(result.resolvedApiUrl).trim();
            }

            this.setPillState(this.ocrTestStatePill, result.success ? 'success' : 'error', result.success ? 'Connection valid' : 'Test failed');
            return { success: Boolean(result.success), message: result.message || '' };
        } catch (error) {
            const errorDetails = this.getOperationErrorDetails('OCR response', error, payload.setupOcrValidationTimeoutMs);
            this.ocrTestState.ran = true;
            this.ocrTestState.success = false;
            this.setPillState(this.ocrTestStatePill, 'error', errorDetails.isTimeout ? 'Timeout reached' : 'Test failed');
            return { success: false, message: errorDetails.message };
        }
    }

    async runQuickstartSaveFlow() {
        if (this.quickstartState.mode !== 'quickstart' || !this.quickstartState.detected) {
            await this.showPopup({ icon: 'warning', title: 'Detection required', text: 'Run "Detect models" first.' });
            return;
        }

        const aiModel = String(this.quickstartAiModel?.value || '').trim();
        if (!aiModel) {
            await this.showPopup({ icon: 'warning', title: 'No AI model selected', text: 'Choose an AI model first.' });
            return;
        }

        this.applyQuickstartToManualFields();

        const ocrEnabled = this.mistralOcrEnabled.value === 'yes';
        const ocrModel = String(this.mistralOcrModel?.value || '').trim();

        this.setModelTestRowState('modelTestAiRow', 'pending', `AI model "${aiModel}": testing...`);
        this.setModelTestRowState(
            'modelTestOcrRow',
            ocrEnabled ? 'pending' : 'skipped',
            ocrEnabled ? `OCR model "${ocrModel}": waiting...` : 'OCR fallback disabled — test skipped.'
        );
        this.toggleModelTestOverlay(true, 'Validating the selected models against your AI server…');

        const aiResult = await this.runSilentAiTest();
        this.setModelTestRowState(
            'modelTestAiRow',
            aiResult.success ? 'success' : 'error',
            aiResult.success ? `AI model "${aiModel}": connection valid` : `AI model "${aiModel}": test failed`
        );

        let ocrResult = { success: true, message: '' };
        if (ocrEnabled) {
            this.setModelTestRowState('modelTestOcrRow', 'pending', `OCR model "${ocrModel}": testing...`);
            ocrResult = await this.runSilentOcrTest();
            this.setModelTestRowState(
                'modelTestOcrRow',
                ocrResult.success ? 'success' : 'error',
                ocrResult.success ? `OCR model "${ocrModel}": connection valid` : `OCR model "${ocrModel}": test failed`
            );
        }

        // Keep the final row states visible for a moment before moving on.
        await new Promise((resolve) => setTimeout(resolve, 900));
        this.toggleModelTestOverlay(false);

        if (!aiResult.success || !ocrResult.success) {
            const failures = [];
            if (!aiResult.success) {
                failures.push(`AI model "${aiModel}": ${aiResult.message || 'test failed'}`);
            }
            if (!ocrResult.success) {
                failures.push(`OCR model "${ocrModel}": ${ocrResult.message || 'test failed'}`);
            }

            await this.showPopup({
                icon: 'error',
                title: 'Model test failed',
                text: `${failures.join('\n')}\n\nAdjust the model selection and try again.`
            });
            return;
        }

        await this.finalizeSetup({ skipConfirm: true });
    }

    fillDatalist(datalistElement, values) {
        if (!datalistElement) {
            return;
        }

        datalistElement.innerHTML = '';
        (Array.isArray(values) ? values : []).forEach((value) => {
            const option = document.createElement('option');
            option.value = String(value || '').trim();
            if (option.value) {
                datalistElement.appendChild(option);
            }
        });
    }

    async fetchAiModels(silent = false) {
        const payload = {
            aiProvider: this.aiProvider.value.trim().toLowerCase(),
            apiUrl: this.aiApiUrl.value.trim(),
            token: this.aiToken.value.trim(),
            setupValidationTimeoutMs: this.getAiValidationTimeoutMs()
        };

        if (!payload.aiProvider) {
            if (!silent) {
                await this.showPopup({ icon: 'warning', title: 'Provider missing', text: 'Select an AI provider first.' });
            }
            return [];
        }

        if (!['openai', 'azure'].includes(payload.aiProvider) && !payload.apiUrl) {
            if (!silent) {
                await this.showPopup({ icon: 'warning', title: 'API URL missing', text: 'Enter API URL first.' });
            }
            return [];
        }

        this.setButtonLoading(this.fetchAiModelsBtn, true, 'Loading...');
        try {
            const result = await this.request('/api/setup/ai/models', payload);
            const models = Array.isArray(result.models) ? result.models : [];

            if (result.resolvedApiUrl && this.aiApiUrl) {
                this.aiApiUrl.value = String(result.resolvedApiUrl).trim();
            }

            this.setModelSelectOptions(this.aiModel, models, 'Select model');

            if (!silent) {
                const resolvedInfo = result.resolvedApiUrl
                    ? `\nResolved API URL: ${String(result.resolvedApiUrl).trim()}`
                    : '';
                await this.showPopup({
                    icon: models.length > 0 ? 'success' : 'info',
                    title: 'AI models loaded',
                    text: `${result.message || (models.length > 0 ? 'Models discovered successfully.' : 'No models found.')}${resolvedInfo}`
                });
            }

            return models;
        } catch (error) {
            const errorDetails = this.getOperationErrorDetails('AI model discovery', error, payload.setupValidationTimeoutMs);
            if (!silent) {
                await this.showPopup({
                    icon: 'error',
                    title: errorDetails.isTimeout ? 'AI timeout reached' : 'Failed to load AI models',
                    text: errorDetails.message
                });
            }
            return [];
        } finally {
            this.setButtonLoading(this.fetchAiModelsBtn, false);
        }
    }

    async fetchOcrModels(silent = false) {
        const payload = {
            provider: (this.ocrProvider.value || 'mistral').toLowerCase(),
            apiUrl: this.normalizeOcrApiUrlForProvider(this.ocrProvider.value, this.ocrApiUrl.value),
            apiKey: this.ocrApiKey.value.trim(),
            setupOcrValidationTimeoutMs: this.getOcrValidationTimeoutMs()
        };

        if (payload.provider === 'mistral' && !payload.apiKey) {
            if (!silent) {
                await this.showPopup({ icon: 'warning', title: 'API key missing', text: 'Mistral OCR requires an API key to discover models.' });
            }
            return [];
        }

        this.setButtonLoading(this.fetchOcrModelsBtn, true, 'Loading...');
        try {
            const result = await this.request('/api/setup/ocr/models', payload);
            const models = Array.isArray(result.models) ? result.models : [];

            if (result.resolvedApiUrl && this.ocrApiUrl) {
                this.ocrApiUrl.value = String(result.resolvedApiUrl).trim();
            }

            this.setModelSelectOptions(this.mistralOcrModel, models, 'Select OCR model');

            if (!silent) {
                await this.showPopup({
                    icon: models.length > 0 ? 'success' : 'info',
                    title: 'OCR models loaded',
                    text: result.message || (models.length > 0 ? 'OCR models discovered successfully.' : 'No OCR models found.')
                });
            }

            return models;
        } catch (error) {
            const errorDetails = this.getOperationErrorDetails('OCR model discovery', error, payload.setupOcrValidationTimeoutMs);
            if (!silent) {
                await this.showPopup({
                    icon: 'error',
                    title: errorDetails.isTimeout ? 'OCR timeout reached' : 'Failed to load OCR models',
                    text: errorDetails.message
                });
            }
            return [];
        } finally {
            this.setButtonLoading(this.fetchOcrModelsBtn, false);
        }
    }

    async testAiConnection() {
        if (!this.aiModel.value.trim()) {
            await this.fetchAiModels(true);
        }

        const payload = {
            aiProvider: this.aiProvider.value.trim().toLowerCase(),
            apiUrl: this.aiApiUrl.value.trim(),
            token: this.aiToken.value.trim(),
            model: this.aiModel.value.trim(),
            setupValidationTimeoutMs: this.getAiValidationTimeoutMs()
        };

        if (!payload.aiProvider || !payload.model || !payload.apiUrl) {
            await this.showPopup({ icon: 'warning', title: 'Missing values', text: 'Provider, API URL, and model are required.' });
            return;
        }

        this.setButtonLoading(this.testAiBtn, true, 'Testing...');
        this.setPillState(this.aiTestStatePill, 'loading', 'Testing...');

        try {
            const result = await this.request('/api/setup/ai/test', payload);
            this.aiTestState.ran = true;
            this.aiTestState.success = Boolean(result.success);
            this.aiTestState.allowFailure = false;

            if (result.resolvedApiUrl && this.aiApiUrl) {
                this.aiApiUrl.value = String(result.resolvedApiUrl).trim();
            }

            if (result.success) {
                this.setPillState(this.aiTestStatePill, 'success', 'Connection valid');
                const resolvedInfo = result.resolvedApiUrl
                    ? `\nResolved API URL: ${String(result.resolvedApiUrl).trim()}`
                    : '';
                await this.showPopup({
                    icon: 'success',
                    title: 'AI test successful',
                    text: `${result.message || 'AI provider is reachable.'}${resolvedInfo}`
                });
            } else {
                this.setPillState(this.aiTestStatePill, 'error', 'Test failed');
                await this.showPopup({ icon: 'error', title: 'AI test failed', text: result.message || 'AI connection test failed.' });
            }
        } catch (error) {
            const errorDetails = this.getOperationErrorDetails('AI response', error, payload.setupValidationTimeoutMs);
            this.aiTestState.ran = true;
            this.aiTestState.success = false;
            this.setPillState(this.aiTestStatePill, 'error', errorDetails.isTimeout ? 'Timeout reached' : 'Test failed');
            await this.showPopup({
                icon: 'error',
                title: errorDetails.isTimeout ? 'AI timeout reached' : 'AI test failed',
                text: errorDetails.message
            });
        } finally {
            this.setButtonLoading(this.testAiBtn, false);
        }
    }

    async validateStepBeforeContinue(stepIndex) {
        if (stepIndex === 0) {
            const username = this.adminUsername.value.trim();
            const password = this.adminPassword.value;
            const confirmPassword = this.confirmPassword.value;

            if (!username || !password || !confirmPassword) {
                await this.showPopup({ icon: 'warning', title: 'Required fields', text: 'Please fill all account fields.' });
                return false;
            }

            if (password.length < 8) {
                await this.showPopup({ icon: 'warning', title: 'Password too short', text: 'Use at least 8 characters.' });
                return false;
            }

            if (password !== confirmPassword) {
                await this.showPopup({ icon: 'warning', title: 'Password mismatch', text: 'The two password fields must match.' });
                return false;
            }

            return true;
        }

        if (stepIndex === 1) {
            if (this.enableMfa.value === 'yes' && !this.mfaState.verified) {
                await this.showPopup({ icon: 'warning', title: 'MFA not confirmed', text: 'Generate QR code and validate one code before continuing.' });
                return false;
            }
            return true;
        }

        if (stepIndex === 2) {
            if (!this.paperlessUrl.value.trim() || !this.paperlessUsername.value.trim() || !this.paperlessToken.value.trim()) {
                await this.showPopup({ icon: 'warning', title: 'Missing values', text: 'Paperless URL, username, and token are required.' });
                return false;
            }

            if (this.paperlessTestState.success) {
                return true;
            }

            const title = this.paperlessTestState.ran ? 'Paperless test failed' : 'Paperless test not run';
            const text = this.paperlessTestState.ran
                ? 'The Paperless test failed. Do you want to continue anyway?'
                : 'No Paperless test has been run. Continue anyway?';

            const result = await this.showPopup({
                icon: 'warning',
                title,
                text,
                showCancelButton: true,
                confirmButtonText: 'Continue anyway',
                cancelButtonText: 'Go back'
            });

            this.paperlessTestState.allowFailure = result.isConfirmed;
            return result.isConfirmed;
        }

        if (stepIndex === 3) {
            if (!this.metadataState.loaded) {
                const result = await this.showPopup({
                    icon: 'warning',
                    title: 'Metadata not loaded',
                    text: 'You have not loaded metadata yet. Continue anyway?',
                    showCancelButton: true,
                    confirmButtonText: 'Continue anyway',
                    cancelButtonText: 'Go back'
                });

                if (!result.isConfirmed) {
                    return false;
                }
            }

            if (!this.scanAllDocuments.checked && this.getEffectiveIncludeTags().length === 0) {
                await this.showPopup({
                    icon: 'warning',
                    title: 'Include tag required',
                    text: 'Select at least one include tag or enable "Always scan all documents".'
                });
                return false;
            }

            return true;
        }

        if (stepIndex === 4) {
            const timeoutSeconds = Number.parseInt(String(this.aiValidationTimeout.value || '30').trim(), 10);
            if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) {
                await this.showPopup({ icon: 'warning', title: 'Invalid timeout', text: 'Timeout must be between 1 and 120 seconds.' });
                return false;
            }

            if (this.quickstartState.mode === 'quickstart') {
                if (!this.quickstartState.detected) {
                    await this.showPopup({ icon: 'warning', title: 'Detection required', text: 'Run "Detect models" and choose an AI model first, or switch to manual configuration.' });
                    return false;
                }

                if (!String(this.quickstartAiModel?.value || '').trim()) {
                    await this.showPopup({ icon: 'warning', title: 'No AI model selected', text: 'No text-capable model is selected. Choose one or configure manually.' });
                    return false;
                }

                // Re-sync the hidden fields before the shared checks below.
                this.applyQuickstartToManualFields();
            }

            if (!this.aiModel.value.trim()) {
                await this.fetchAiModels(true);
            }

            if (!this.aiProvider.value.trim() || !this.aiApiUrl.value.trim() || !this.aiModel.value.trim()) {
                await this.showPopup({ icon: 'warning', title: 'Missing values', text: 'Provider, API URL, and model are required.' });
                return false;
            }

            const provider = this.aiProvider.value.trim().toLowerCase();
            const tokenRequired = provider === 'openai' || provider === 'azure';
            if (tokenRequired && !this.aiToken.value.trim()) {
                await this.showPopup({ icon: 'warning', title: 'Token required', text: `Token is required for provider ${provider}.` });
                return false;
            }

            if (this.aiTestState.success) {
                return true;
            }

            const result = await this.showPopup({
                icon: 'warning',
                title: this.aiTestState.ran ? 'AI test failed' : 'AI test not run',
                text: this.aiTestState.ran
                    ? 'The AI test failed. Do you want to continue anyway?'
                    : 'No AI test has been run. Continue anyway?',
                showCancelButton: true,
                confirmButtonText: 'Continue anyway',
                cancelButtonText: 'Go back'
            });

            this.aiTestState.allowFailure = result.isConfirmed;
            return result.isConfirmed;
        }

        if (stepIndex === 5) {
            const ocrTimeoutSeconds = Number.parseInt(String(this.ocrValidationTimeout?.value || '30').trim(), 10);
            if (!Number.isFinite(ocrTimeoutSeconds) || ocrTimeoutSeconds < 1 || ocrTimeoutSeconds > 120) {
                await this.showPopup({ icon: 'warning', title: 'Invalid OCR timeout', text: 'OCR timeout must be between 1 and 120 seconds.' });
                return false;
            }

            const provider = (this.ocrProvider.value || 'mistral').toLowerCase();
            if (this.mistralOcrEnabled.value === 'yes' && provider === 'mistral' && !this.ocrApiKey.value.trim()) {
                await this.showPopup({ icon: 'warning', title: 'Mistral API key required', text: 'Enter the Mistral API key or disable OCR fallback.' });
                return false;
            }

            if (this.mistralOcrEnabled.value === 'yes' && !this.mistralOcrModel.value.trim()) {
                await this.fetchOcrModels(true);
            }

            if (!['mistral', 'custom'].includes(provider)) {
                await this.showPopup({ icon: 'warning', title: 'Invalid OCR provider', text: 'Choose either mistral or custom for OCR fallback.' });
                return false;
            }
            return true;
        }

        return true;
    }

    buildEnvPreview() {
        const preview = [];
        const provider = this.aiProvider.value.trim().toLowerCase();

        preview.push(`PAPERLESS_API_URL=${this.paperlessUrl.value.trim().replace(/\/+$/, '').replace(/\/api$/, '')}`);
        preview.push(`PAPERLESS_API_TOKEN=${this.paperlessToken.value.trim()}`);
        preview.push(`PAPERLESS_USERNAME=${this.paperlessUsername.value.trim()}`);
        preview.push(`PROCESS_PREDEFINED_DOCUMENTS=${this.scanAllDocuments.checked ? 'no' : 'yes'}`);
        preview.push(`TAGS=${this.scanAllDocuments.checked ? '' : this.getEffectiveIncludeTags().join(',')}`);
        preview.push(`IGNORE_TAGS=${this.getEffectiveExcludeTags().join(',')}`);
        preview.push(`ADD_AI_PROCESSED_TAG=${this.processedTag.value.trim() ? 'yes' : 'no'}`);
        preview.push(`AI_PROCESSED_TAG_NAME=${this.processedTag.value.trim() || 'ai-processed'}`);
        preview.push(`DISABLE_AUTOMATIC_PROCESSING=${this.automaticScanEnabled.value === 'yes' ? 'no' : 'yes'}`);
        preview.push(`SCAN_INTERVAL=${this.scanInterval.value.trim() || '*/30 * * * *'}`);
        preview.push(`AI_PROVIDER=${provider}`);

        if (provider === 'openai') {
            preview.push(`OPENAI_API_KEY=${this.aiToken.value.trim()}`);
            preview.push(`OPENAI_MODEL=${this.aiModel.value.trim()}`);
        } else if (provider === 'ollama') {
            preview.push(`OLLAMA_API_URL=${this.aiApiUrl.value.trim()}`);
            preview.push(`OLLAMA_API_KEY=${this.aiToken.value.trim()}`);
            preview.push(`OLLAMA_MODEL=${this.aiModel.value.trim()}`);
        } else if (provider === 'azure') {
            preview.push(`AZURE_ENDPOINT=${this.aiApiUrl.value.trim()}`);
            preview.push(`AZURE_API_KEY=${this.aiToken.value.trim()}`);
            preview.push(`AZURE_DEPLOYMENT_NAME=${this.aiModel.value.trim()}`);
            preview.push('AZURE_API_VERSION=2023-05-15');
        } else {
            preview.push(`CUSTOM_BASE_URL=${this.aiApiUrl.value.trim()}`);
            preview.push(`CUSTOM_API_KEY=${this.aiToken.value.trim()}`);
            preview.push(`CUSTOM_MODEL=${this.aiModel.value.trim()}`);
        }

        preview.push(`SETUP_VALIDATION_TIMEOUT_MS=${this.getAiValidationTimeoutMs()}`);
        preview.push(`SETUP_OCR_VALIDATION_TIMEOUT_MS=${this.getOcrValidationTimeoutMs()}`);

        preview.push(`MISTRAL_OCR_ENABLED=${this.mistralOcrEnabled.value === 'yes' ? 'yes' : 'no'}`);
        const normalizedOcrProvider = (this.ocrProvider.value || 'mistral').toLowerCase();
        preview.push(`OCR_PROVIDER=${normalizedOcrProvider === 'custom' ? 'custom' : 'mistral'}`);
        preview.push(`OCR_API_URL=${this.normalizeOcrApiUrlForProvider(normalizedOcrProvider, this.ocrApiUrl.value)}`);
        preview.push(`OCR_API_KEY=${this.ocrApiKey.value.trim()}`);
        preview.push(`MISTRAL_OCR_MODEL=${this.mistralOcrModel.value.trim() || 'mistral-ocr-latest'}`);

        return preview.join('\n');
    }

    renderEnvPreview() {
        this.envPreview.value = this.buildEnvPreview();
    }

    async copyEnvPreview() {
        this.renderEnvPreview();
        try {
            await navigator.clipboard.writeText(this.envPreview.value);
            await this.showPopup({ icon: 'success', title: 'Copied', text: 'Environment keys copied to clipboard.' });
        } catch {
            this.envPreview.select();
            document.execCommand('copy');
            await this.showPopup({ icon: 'success', title: 'Copied', text: 'Environment keys copied to clipboard.' });
        }
    }

    buildFinalizePayload() {
        return {
            adminUsername: this.adminUsername.value.trim(),
            adminPassword: this.adminPassword.value,
            enableMfa: this.enableMfa.value === 'yes',
            mfaChallengeId: this.mfaState.challengeId,
            paperlessUrl: this.paperlessUrl.value.trim(),
            paperlessUsername: this.paperlessUsername.value.trim(),
            paperlessToken: this.paperlessToken.value.trim(),
            scanAllDocuments: this.scanAllDocuments.checked,
            includeTag: this.getEffectiveIncludeTags()[0] || '',
            includeTags: this.getEffectiveIncludeTags(),
            excludeTags: this.getEffectiveExcludeTags(),
            processedTag: this.processedTag.value.trim(),
            automaticScanEnabled: this.automaticScanEnabled.value === 'yes',
            scanInterval: this.scanInterval.value.trim(),
            aiProvider: this.aiProvider.value.trim().toLowerCase(),
            aiApiUrl: this.aiApiUrl.value.trim(),
            aiToken: this.aiToken.value.trim(),
            aiModel: this.aiModel.value.trim(),
            setupValidationTimeoutMs: this.getAiValidationTimeoutMs(),
            setupOcrValidationTimeoutMs: this.getOcrValidationTimeoutMs(),
            allowFailedPaperlessTest: this.paperlessTestState.allowFailure,
            allowFailedAiTest: this.aiTestState.allowFailure,
            mistralOcrEnabled: this.mistralOcrEnabled.value === 'yes',
            ocrProvider: (this.ocrProvider.value || 'mistral').toLowerCase(),
            ocrApiUrl: this.normalizeOcrApiUrlForProvider(this.ocrProvider.value, this.ocrApiUrl.value),
            ocrApiKey: this.ocrApiKey.value.trim(),
            mistralOcrModel: this.mistralOcrModel.value.trim() || 'mistral-ocr-latest'
        };
    }

    async finalizeSetup(options = {}) {
        const validations = [];
        for (let index = 0; index <= 5; index += 1) {
            const valid = await this.validateStepBeforeContinue(index);
            if (!valid) {
                validations.push(index);
                break;
            }
        }

        if (validations.length > 0) {
            this.showStep(validations[0]);
            return;
        }

        this.renderEnvPreview();

        // Quickstart save flow already confirmed intent via its own button.
        if (!options.skipConfirm) {
            const confirm = await this.showPopup({
                icon: 'question',
                title: 'Finalize setup?',
                text: 'This writes your .env configuration and restarts the container.',
                showCancelButton: true,
                confirmButtonText: 'Finalize now',
                cancelButtonText: 'Cancel'
            });

            if (!confirm.isConfirmed) {
                return;
            }
        }

        this.setButtonLoading(this.finalizeSetupBtn, true, 'Finalizing...');

        try {
            const payload = this.buildFinalizePayload();
            const result = await this.request('/api/setup/complete', payload);
            const postRestartRedirectTarget = result.redirectTo || '/login';

            if (result.envPreview) {
                this.envPreview.value = result.envPreview;
            }

            await this.showPopup({
                icon: 'success',
                title: 'Setup saved',
                text: result.message || 'Setup completed successfully.',
                timer: 1800,
                showConfirmButton: false
            });

            if (result.restart) {
                let countdown = 5;
                await this.showPopup({
                    icon: 'info',
                    title: 'Restarting',
                    text: `Container restart in ${countdown} seconds...`,
                    showConfirmButton: false,
                    allowOutsideClick: false,
                    didOpen: () => {
                        const intervalId = setInterval(() => {
                            countdown -= 1;
                            if (countdown < 0) {
                                clearInterval(intervalId);
                                window.location.href = postRestartRedirectTarget;
                                return;
                            }

                            Swal.update({
                                text: `Container restart in ${countdown} seconds...`
                            });
                        }, 1000);
                    }
                });
            }
        } catch (error) {
            await this.showPopup({ icon: 'error', title: 'Finalize failed', text: error.message });
        } finally {
            this.setButtonLoading(this.finalizeSetupBtn, false);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.setupWizard = new SetupWizard();
});
