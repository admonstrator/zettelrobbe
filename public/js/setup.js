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
        this.excludeTagInput = document.getElementById('excludeTagInput');
        this.addExcludeTagBtn = document.getElementById('addExcludeTagBtn');
        this.excludeTagsContainer = document.getElementById('excludeTagsContainer');
        this.processedTag = document.getElementById('processedTag');
        this.excludeProcessedTagBtn = document.getElementById('excludeProcessedTagBtn');
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
        this.renderExcludeTags();
        this.updateMfaPanelVisibility();
        this.toggleIncludeTagField();
        this.toggleMistralFields();
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
        this.includeTag.value = Array.isArray(this.config.TAGS) && this.config.TAGS.length > 0 ? this.config.TAGS[0] : '';
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
        const normalizedMs = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1000), 120000) : fallbackMs;
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
        const normalizedSeconds = Number.isFinite(rawSeconds) ? Math.min(Math.max(rawSeconds, 1), 120) : 30;
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

            if (!this.scanAllDocuments.checked && !this.includeTag.value.trim()) {
                await this.showPopup({
                    icon: 'warning',
                    title: 'Include tag required',
                    text: 'Select an include tag or enable "Always scan all documents".'
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
        preview.push(`TAGS=${this.scanAllDocuments.checked ? '' : this.includeTag.value.trim()}`);
        preview.push(`IGNORE_TAGS=${this.excludeTags.join(',')}`);
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
        } catch (_error) {
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
            includeTag: this.includeTag.value.trim(),
            excludeTags: this.excludeTags,
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

    async finalizeSetup() {
        const validations = [];
        for (let index = 0; index <= 5; index += 1) {
            // eslint-disable-next-line no-await-in-loop
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
