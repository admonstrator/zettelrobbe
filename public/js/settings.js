//settings.js

class SettingsTabsManager {
    constructor() {
        this.buttons = Array.from(document.querySelectorAll('.settings-tab-button'));
        this.contents = Array.from(document.querySelectorAll('.settings-tab-content'));
        this.initialize();
    }

    initialize() {
        if (this.buttons.length === 0 || this.contents.length === 0) {
            return;
        }

        this.buttons.forEach((button) => {
            button.addEventListener('click', () => {
                const tabId = button.dataset.tab;
                this.activateTab(tabId);
            });
        });
    }

    activateTab(tabId) {
        this.buttons.forEach((button) => {
            const isActive = button.dataset.tab === tabId;
            button.classList.toggle('active', isActive);
            button.classList.toggle('border-blue-500', isActive);
            button.classList.toggle('border-transparent', !isActive);
        });

        this.contents.forEach((content) => {
            const isActive = content.id === tabId;
            content.classList.toggle('hidden', !isActive);
        });

        refreshSettingsHints();
    }
}

class FormManager {
    constructor() {
        this.form = document.getElementById('setupForm');
        this.aiProvider = document.getElementById('aiProvider');
        this.tokenLimit = document.getElementById('tokenLimit'); 
        this.responseTokens = document.getElementById('responseTokens'); 
        this.showTags = document.getElementById('showTags');
        this.aiProcessedTag = document.getElementById('aiProcessedTag');
        this.usePromptTags = document.getElementById('usePromptTags');
        this.systemPrompt = document.getElementById('systemPrompt');
        this.systemPromptBtn = document.getElementById('systemPromptBtn');
        this.disableAutomaticProcessing = document.getElementById('disableAutomaticProcessing');
        this.initialize();
    }

    initialize() {
        this.toggleProviderSettings();
        this.toggleTagsInput();
        this.handleDisableAutomaticProcessing();
        
        if (this.aiProvider) this.aiProvider.addEventListener('change', () => this.toggleProviderSettings());
        if (this.tokenLimit) this.tokenLimit.addEventListener('input', () => this.validateTokenLimit()); 
        if (this.responseTokens) this.responseTokens.addEventListener('input', () => this.validateResponseTokens()); 
        if (this.showTags) this.showTags.addEventListener('change', () => this.toggleTagsInput());
        if (this.aiProcessedTag) this.aiProcessedTag.addEventListener('change', () => this.toggleAiTagInput());
        if (this.usePromptTags) this.usePromptTags.addEventListener('change', () => this.togglePromptTagsInput());
        if (this.disableAutomaticProcessing) this.disableAutomaticProcessing.addEventListener('change', () => this.handleDisableAutomaticProcessing());
        
        this.initializePasswordToggles();

        if (this.usePromptTags && this.usePromptTags.value === 'yes') {
            this.disablePromptElements();
        }
        
        this.toggleAiTagInput();
        this.togglePromptTagsInput();
    }

    validateTokenLimit() {
        const value = parseInt(this.tokenLimit.value, 10);
        if (isNaN(value) || value < 1) {
            this.tokenLimit.setCustomValidity('Token Limit must be a positive integer.');
        } else {
            this.tokenLimit.setCustomValidity('');
        }
    }

    validateResponseTokens() {
        const value = parseInt(this.responseTokens.value, 10);
        if (isNaN(value) || value < 0) {
            this.responseTokens.setCustomValidity('Response tokens must be a non-negative integer.');
        } else {
            this.responseTokens.setCustomValidity('');
        }
    }

    handleDisableAutomaticProcessing() {
        if (!this.form || !this.disableAutomaticProcessing) {
            return;
        }

        // Create a hidden input if it doesn't exist
        let hiddenInput = document.getElementById('disableAutomaticProcessingValue');
        if (!hiddenInput) {
            hiddenInput = document.createElement('input');
            hiddenInput.type = 'hidden';
            hiddenInput.id = 'disableAutomaticProcessingValue';
            hiddenInput.name = 'disableAutomaticProcessing';
            this.form.appendChild(hiddenInput);
        }
        
        // Update the hidden input value based on checkbox state
        hiddenInput.value = this.disableAutomaticProcessing.checked ? 'yes' : 'no';
    }

    toggleProviderSettings() {
        if (!this.aiProvider) {
            return;
        }

        const provider = this.aiProvider.value;
        const openaiSettings = document.getElementById('openaiSettings');
        const ollamaSettings = document.getElementById('ollamaSettings');
        const customSettings = document.getElementById('customSettings');
        const azureSettings = document.getElementById('azureSettings');

        // Get all provider-specific fields
        const openaiKey = document.getElementById('openaiKey');
        const ollamaUrl = document.getElementById('ollamaUrl');
        const ollamaModel = document.getElementById('ollamaModel');
        const customBaseUrl = document.getElementById('customBaseUrl');
        const customApiKey = document.getElementById('customApiKey');
        const customModel = document.getElementById('customModel');
        const azureApiKey = document.getElementById('azureApiKey');
        const azureEndpoint = document.getElementById('azureEndpoint');
        const azureDeploymentName = document.getElementById('azureDeploymentName');
        const azureApiVersion = document.getElementById('azureApiVersion');

        // Restriction settings
        const restrictToExistingTags = document.getElementById('restrictToExistingTags');
        const restrictToExistingCorrespondents = document.getElementById('restrictToExistingCorrespondents');

        // External API settings
        const externalApiEnabled = document.getElementById('externalApiEnabled');
        const externalApiSettings = document.getElementById('externalApiSettings');
        const externalApiUrl = document.getElementById('externalApiUrl');
        const externalApiMethod = document.getElementById('externalApiMethod');
        const externalApiHeaders = document.getElementById('externalApiHeaders');
        const externalApiBody = document.getElementById('externalApiBody');
        const externalApiTimeout = document.getElementById('externalApiTimeout');
        const externalApiTransformationTemplate = document.getElementById('externalApiTransformationTemplate');
        
        
        if (!openaiSettings || !ollamaSettings || !customSettings || !azureSettings) {
            return;
        }

        // Hide all settings sections first
        openaiSettings.classList.add('hidden');
        ollamaSettings.classList.add('hidden');
        customSettings.classList.add('hidden');
        azureSettings.classList.add('hidden');
        
        // Reset all required fields
        openaiKey.required = false;
        ollamaUrl.required = false;
        ollamaModel.required = false;
        customBaseUrl.required = false;
        customApiKey.required = false;
        customModel.required = false;
        azureApiKey.required = false;
        azureEndpoint.required = false;
        azureDeploymentName.required = false;
        azureApiVersion.required = false;
        
        // Show and set required fields based on selected provider
        switch (provider) {
            case 'openai':
                openaiSettings.classList.remove('hidden');
                break;
            case 'ollama':
                ollamaSettings.classList.remove('hidden');
                ollamaUrl.required = true;
                ollamaModel.required = true;
                break;
            case 'custom':
                customSettings.classList.remove('hidden');
                customBaseUrl.required = true;
                customModel.required = true;
                break;
            case 'azure':
                azureSettings.classList.remove('hidden');
                azureEndpoint.required = true;
                azureDeploymentName.required = true;
                azureApiVersion.required = true;
                break;
        }

        refreshSettingsHints();
    }

    // Rest of the class methods remain the same
    toggleTagsInput() {
        if (!this.showTags) {
            return;
        }

        const showTags = this.showTags.value;
        const tagsInputSection = document.getElementById('tagsInputSection');
        const tagsInput = document.getElementById('tags');
        
        if (showTags === 'yes') {
            tagsInputSection.classList.remove('hidden');
        } else {
            if (tagsInput) tagsInput.value = '';
            tagsInputSection.classList.add('hidden');
        }
    }

    toggleAiTagInput() {
        if (!this.aiProcessedTag) {
            return;
        }

        const showAiTag = this.aiProcessedTag.value;
        const aiTagNameSection = document.getElementById('aiTagNameSection');
        
        if (showAiTag === 'yes') {
            aiTagNameSection.classList.remove('hidden');
        } else {
            aiTagNameSection.classList.add('hidden');
        }

        refreshSettingsHints();
    }

    togglePromptTagsInput() {
        if (!this.usePromptTags) {
            return;
        }

        const usePromptTags = this.usePromptTags.value;
        const promptTagsSection = document.getElementById('promptTagsSection');
        
        if (usePromptTags === 'yes') {
            promptTagsSection.classList.remove('hidden');
            this.disablePromptElements();
        } else {
            promptTagsSection.classList.add('hidden');
            this.enablePromptElements();
        }

        refreshSettingsHints();
    }

    disablePromptElements() {
        if (!this.systemPrompt || !this.systemPromptBtn) {
            return;
        }
        this.systemPrompt.disabled = true;
        this.systemPromptBtn.disabled = true;
        this.systemPrompt.classList.add('opacity-50', 'cursor-not-allowed');
        this.systemPromptBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }

    enablePromptElements() {
        if (!this.systemPrompt || !this.systemPromptBtn) {
            return;
        }
        this.systemPrompt.disabled = false;
        this.systemPromptBtn.disabled = false;
        this.systemPrompt.classList.remove('opacity-50', 'cursor-not-allowed');
        this.systemPromptBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }

    initializePasswordToggles() {
        document.querySelectorAll('[data-input]').forEach(toggle => {
            toggle.addEventListener('click', (e) => {
                const inputId = e.currentTarget.dataset.input;
                this.togglePassword(inputId);
            });
        });
    }

    togglePassword(inputId) {
        const input = document.getElementById(inputId);
        const icon = input.nextElementSibling.querySelector('i');
        
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.remove('fa-eye');
            icon.classList.add('fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.remove('fa-eye-slash');
            icon.classList.add('fa-eye');
        }
    }
}

// Tags Management
class TagsManager {
    constructor(
        tagInputId,
        tagsContainerId,
        tagsHiddenInputId
    ) {
        this.tagInput = document.getElementById(tagInputId); //'tagInput'
        this.tagsContainer = document.getElementById(tagsContainerId); // tagsContainer
        this.tagsHiddenInput = document.getElementById(tagsHiddenInputId); // tagsHiddenInput
        this.addTagButton = this.tagInput?.closest('.space-y-2')?.querySelector('button');
        
        if (this.tagInput && this.tagsContainer && this.addTagButton) {
            this.initialize();
            
            // Initialize existing tags with proper event handlers
            this.initializeExistingTags();
        }
    }

    initialize() {
        if (this.addTagButton) {
            this.addTagButton.addEventListener('click', () => this.addTag());
        }
        
        if (this.tagInput) {
            this.tagInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.addTag();
                }
            });
        }
    }

    initializeExistingTags() {
        const existingTags = this.tagsContainer.querySelectorAll('.bg-blue-100');
        existingTags.forEach(tagElement => {
            const removeButton = tagElement.querySelector('button');
            if (removeButton) {
                this.initializeTagRemoval(removeButton);
            }
        });
    }

    initializeTagRemoval(button) {
        button.addEventListener('click', async () => {
            const result = await Swal.fire({
                title: 'Remove Tag',
                text: 'Are you sure you want to remove this tag?',
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'Yes, remove it',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#d33',
                cancelButtonColor: '#3085d6',
                customClass: {
                    container: 'my-swal'
                }
            });

            if (result.isConfirmed) {
                const tagElement = button.closest('.bg-blue-100');
                if (tagElement) {
                    tagElement.remove();
                    this.updateHiddenInput();
                }
            }
        });
    }

    async addTag() {
        if (!this.tagInput) return;

        const tagText = this.tagInput.value.trim();
        const specialChars = /[,;:\n\r\\/]/;
        
        if (specialChars.test(tagText)) {
            await Swal.fire({
                title: 'Invalid Characters',
                text: 'Tags cannot contain commas, semi-colons, colons, or line breaks.',
                icon: 'warning',
                confirmButtonText: 'OK',
                confirmButtonColor: '#3085d6',
                customClass: {
                    container: 'my-swal'
                }
            });
            return;
        }

        if (tagText) {
            const tag = this.createTagElement(tagText);
            this.tagsContainer.appendChild(tag);
            this.updateHiddenInput();
            this.tagInput.value = '';
        }
    }

    createTagElement(text) {
        const tag = document.createElement('div');
        tag.className = 'bg-blue-100 text-blue-800 px-3 py-1 rounded-full flex items-center gap-2 animate-fade-in';
        
        const tagText = document.createElement('span');
        tagText.textContent = text;
        
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'hover:text-blue-600';
        removeButton.innerHTML = '<i class="fas fa-times"></i>';
        
        this.initializeTagRemoval(removeButton);

        tag.appendChild(tagText);
        tag.appendChild(removeButton);
        
        return tag;
    }

    updateHiddenInput() {
        if (!this.tagsHiddenInput || !this.tagsContainer) return;
        
        const tags = Array.from(this.tagsContainer.querySelectorAll('.bg-blue-100 span'))
            .map(span => span.textContent.trim())
            .filter(tag => tag); // Remove any empty tags
            
        this.tagsHiddenInput.value = tags.join(',');
    }
}

// Prompt Management
class PromptManager {
    constructor() {
        this.systemPrompt = document.getElementById('systemPrompt');
        this.exampleButton = document.getElementById('systemPromptBtn');
        this.initialize();
    }

    initialize() {
        this.exampleButton.addEventListener('click', () => this.prefillExample());
    }

    prefillExample() {
        const examplePrompt = `You are a personalized document analyzer. Your task is to analyze documents and extract relevant information.

Analyze the document content and extract the following information into a structured JSON object:

1. title: Create a concise, meaningful title for the document
2. correspondent: Identify the sender/institution but do not include addresses
3. tags: Select up to 4 relevant thematic tags
4. document_date: Extract the document date (format: YYYY-MM-DD)
5. document_type: Determine a precise type that classifies the document (e.g. Invoice, Contract, Employer, Information and so on)
6. language: Determine the document language (e.g. "de" or "en")
      
Important rules for the analysis:

For tags:
- FIRST check the existing tags before suggesting new ones
- Use only relevant categories
- Maximum 4 tags per document, less if sufficient (at least 1)
- Avoid generic or too specific tags
- Use only the most important information for tag creation
- The output language is the one used in the document! IMPORTANT!

For the title:
- Short and concise, NO ADDRESSES
- Contains the most important identification features
- For invoices/orders, mention invoice/order number if available
- The output language is the one used in the document! IMPORTANT!

For the correspondent:
- Identify the sender or institution
  When generating the correspondent, always create the shortest possible form of the company name (e.g. "Amazon" instead of "Amazon EU SARL, German branch")

For the document date:
- Extract the date of the document
- Use the format YYYY-MM-DD
- If multiple dates are present, use the most relevant one

For the language:
- Determine the document language
- Use language codes like "de" for German or "en" for English
- If the language is not clear, use "und" as a placeholder`;

        this.systemPrompt.value = examplePrompt;
    }
}

function initializeCoreSettings() {
    const settingsTabsManager = new SettingsTabsManager();
    const formManager = new FormManager();
    const tagsManager = new TagsManager('tagInput', 'tagsContainer', 'tags');
    const ignoreTagsManager = new TagsManager('ignoreTagInput', 'ignoreTagsContainer', 'ignoreTags');
    const promptTagsManager = new TagsManager('promptTagInput', 'promptTagsContainer', 'promptTags');
    const promptManager = new PromptManager();
}

function initializeFormHandlers() {
    const settingsBootstrap = window.__SETTINGS_BOOTSTRAP__ || {};
    const aiProviderPresets = Array.isArray(settingsBootstrap.aiProviderPresets) ? settingsBootstrap.aiProviderPresets : [];

    const aiPresetSelect = document.getElementById('aiPreset');
    const aiPresetHint = document.getElementById('aiPresetHint');
    const aiProviderSelect = document.getElementById('aiProvider');
    const ollamaUrlInput = document.getElementById('ollamaUrl');
    const ollamaApiKeyInput = document.getElementById('ollamaApiKey');
    const ollamaModelInput = document.getElementById('ollamaModel');
    const customBaseUrlInput = document.getElementById('customBaseUrl');
    const customApiKeyInput = document.getElementById('customApiKey');
    const customModelInput = document.getElementById('customModel');
    const fetchAiModelsBtn = document.getElementById('fetchAiModelsBtn');
    const fetchCustomAiModelsBtn = document.getElementById('fetchCustomAiModelsBtn');

    const ocrEnabledSelect = document.getElementById('mistralOcrEnabled');
    const ocrFieldsContainer = document.getElementById('ocrFieldsContainer');
    const ocrProviderSelect = document.getElementById('ocrProvider');
    const ocrApiUrlContainer = document.getElementById('ocrApiUrlContainer');
    const ocrApiKeyContainer = document.getElementById('ocrApiKeyContainer');
    const ocrApiUrlInput = document.getElementById('ocrApiUrl');
    const ocrApiKeyInput = document.getElementById('ocrApiKey');
    const ocrModelInput = document.getElementById('mistralOcrModel');
    const ocrValidationTimeoutInput = document.getElementById('ocrValidationTimeout');
    const fetchOcrModelsBtn = document.getElementById('fetchOcrModelsBtn');
    const testOcrBtn = document.getElementById('testOcrBtn');
    const ocrTestState = document.getElementById('ocrTestState');

    const setButtonLoading = (button, loading, loadingText = 'Loading...') => {
        if (!button) return;
        if (loading) {
            if (!button.dataset.originalHtml) {
                button.dataset.originalHtml = button.innerHTML;
            }
            button.disabled = true;
            button.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${loadingText}</span>`;
            return;
        }

        button.disabled = false;
        if (button.dataset.originalHtml) {
            button.innerHTML = button.dataset.originalHtml;
        }
    };

    const populateModelSelect = (selectElement, models, placeholder = 'Select model') => {
        if (!selectElement) return;
        selectElement.innerHTML = '';

        const emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.textContent = placeholder;
        selectElement.appendChild(emptyOption);

        const uniqueModels = Array.from(new Set((Array.isArray(models) ? models : [])
            .map((model) => String(model || '').trim())
            .filter(Boolean)));

        uniqueModels.forEach((model) => {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model;
            selectElement.appendChild(option);
        });

        selectElement.value = uniqueModels.length > 0 ? uniqueModels[0] : '';
    };

    const fetchModels = async (url, payload) => {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) {
            throw new Error(result.error || result.message || 'Model discovery failed');
        }

        return {
            models: Array.isArray(result.models) ? result.models : [],
            resolvedApiUrl: String(result.resolvedApiUrl || '').trim()
        };
    };

    const getCurrentAiFormValues = () => {
        const provider = String(aiProviderSelect?.value || '').trim().toLowerCase();
        if (provider === 'openai') {
            return {
                provider,
                apiUrl: 'https://api.openai.com/v1',
                model: String(document.getElementById('openaiModel')?.value || '').trim()
            };
        }
        if (provider === 'ollama') {
            return {
                provider,
                apiUrl: String(ollamaUrlInput?.value || '').trim().replace(/\/+$/, ''),
                model: String(ollamaModelInput?.value || '').trim()
            };
        }
        if (provider === 'azure') {
            return {
                provider,
                apiUrl: String(document.getElementById('azureEndpoint')?.value || '').trim().replace(/\/+$/, ''),
                model: String(document.getElementById('azureDeploymentName')?.value || '').trim()
            };
        }

        return {
            provider: 'custom',
            apiUrl: String(customBaseUrlInput?.value || '').trim().replace(/\/+$/, ''),
            model: String(customModelInput?.value || '').trim()
        };
    };

    const findMatchingAiPreset = () => {
        const current = getCurrentAiFormValues();
        return aiProviderPresets.find((preset) => {
            const presetProvider = String(preset.provider || '').trim().toLowerCase();
            const presetApiUrl = String(preset.apiUrl || '').trim().replace(/\/+$/, '');
            const presetModel = String(preset.model || '').trim();
            return presetProvider === current.provider
                && presetApiUrl === current.apiUrl
                && presetModel === current.model;
        }) || null;
    };

    const applyAiPresetToSettings = (preset) => {
        if (!preset) {
            if (aiPresetHint) {
                aiPresetHint.textContent = 'Manual mode: choose provider and enter values yourself.';
            }
            return;
        }

        const provider = String(preset.provider || 'custom').trim().toLowerCase();
        if (aiProviderSelect) {
            aiProviderSelect.value = provider;
            aiProviderSelect.dispatchEvent(new Event('change'));
        }

        if (provider === 'openai') {
            const openaiModel = document.getElementById('openaiModel');
            if (openaiModel && preset.model) {
                if (!Array.from(openaiModel.options).some((option) => option.value === preset.model)) {
                    const option = document.createElement('option');
                    option.value = preset.model;
                    option.textContent = preset.model;
                    openaiModel.appendChild(option);
                }
                openaiModel.value = preset.model;
            }
        } else if (provider === 'ollama') {
            if (ollamaUrlInput) ollamaUrlInput.value = String(preset.apiUrl || '').trim();
            if (ollamaModelInput) ollamaModelInput.value = String(preset.model || '').trim();
        } else if (provider === 'custom') {
            if (customBaseUrlInput) customBaseUrlInput.value = String(preset.apiUrl || '').trim();
            if (customModelInput) customModelInput.value = String(preset.model || '').trim();
            if (customApiKeyInput) {
                customApiKeyInput.placeholder = preset.tokenPlaceholder || customApiKeyInput.placeholder;
            }
        } else if (provider === 'azure') {
            const azureEndpoint = document.getElementById('azureEndpoint');
            const azureDeploymentName = document.getElementById('azureDeploymentName');
            if (azureEndpoint) azureEndpoint.value = String(preset.apiUrl || '').trim();
            if (azureDeploymentName) azureDeploymentName.value = String(preset.model || '').trim();
        }

        if (aiPresetHint) {
            aiPresetHint.textContent = `Preset "${preset.label}" selected.`;
        }
    };

    const refreshAiPresetSelection = () => {
        if (!aiPresetSelect) {
            return;
        }

        const matchingPreset = findMatchingAiPreset();
        if (matchingPreset) {
            aiPresetSelect.value = matchingPreset.id;
            if (aiPresetHint) {
                aiPresetHint.textContent = `Preset "${matchingPreset.label}" selected.`;
            }
            return;
        }

        aiPresetSelect.value = '';
        if (aiPresetHint) {
            aiPresetHint.textContent = 'Manual mode: choose provider and enter values yourself.';
        }
    };

    const initAiPresets = () => {
        if (!aiPresetSelect) {
            return;
        }

        aiPresetSelect.innerHTML = '';
        const customOption = document.createElement('option');
        customOption.value = '';
        customOption.textContent = 'Manual custom configuration';
        aiPresetSelect.appendChild(customOption);

        aiProviderPresets.forEach((preset) => {
            const option = document.createElement('option');
            option.value = String(preset.id || '');
            option.textContent = String(preset.label || preset.id || 'Preset');
            aiPresetSelect.appendChild(option);
        });

        refreshAiPresetSelection();
        aiPresetSelect.addEventListener('change', () => {
            const selectedPreset = aiProviderPresets.find((entry) => String(entry.id || '') === aiPresetSelect.value) || null;
            applyAiPresetToSettings(selectedPreset);
        });
    };

    initAiPresets();

    [
        aiProviderSelect,
        ollamaUrlInput,
        ollamaModelInput,
        customBaseUrlInput,
        customModelInput,
        document.getElementById('openaiModel'),
        document.getElementById('azureEndpoint'),
        document.getElementById('azureDeploymentName')
    ].forEach((element) => {
        if (element) {
            element.addEventListener('change', () => refreshAiPresetSelection());
            element.addEventListener('input', () => refreshAiPresetSelection());
        }
    });

    const isTimeoutMessage = (message) => {
        const normalized = String(message || '').toLowerCase();
        return normalized.includes('timeout')
            || normalized.includes('timed out')
            || normalized.includes('[timeout]');
    };

    const buildTimeoutUiMessage = (scope, timeoutMs, originalMessage = '') => {
        const normalizedScope = String(scope || 'Request').trim();
        const timeoutPart = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
            ? ` after ${Number(timeoutMs)}ms`
            : '';
        const original = String(originalMessage || '').trim();
        return original
            ? `${normalizedScope} timed out${timeoutPart}. Please check provider availability and increase timeout if needed. Original error: ${original}`
            : `${normalizedScope} timed out${timeoutPart}. Please check provider availability and increase timeout if needed.`;
    };

    const getTimeoutAwareErrorDetails = (scope, error, timeoutMs) => {
        const rawMessage = String(error?.message || error || 'Request failed');
        if (!isTimeoutMessage(rawMessage)) {
            return {
                isTimeout: false,
                message: rawMessage
            };
        }

        return {
            isTimeout: true,
            message: buildTimeoutUiMessage(scope, timeoutMs, rawMessage)
        };
    };

    if (fetchAiModelsBtn) {
        fetchAiModelsBtn.addEventListener('click', async () => {
            const provider = String(aiProviderSelect?.value || 'ollama').toLowerCase();
            const apiUrl = String(ollamaUrlInput?.value || '').trim();

            if (provider !== 'ollama') {
                await Swal.fire({ icon: 'info', title: 'Switch provider', text: 'Use this button with AI Provider set to Ollama.' });
                return;
            }

            if (!apiUrl) {
                await Swal.fire({ icon: 'warning', title: 'Missing URL', text: 'Please enter the Ollama API URL first.' });
                return;
            }

            setButtonLoading(fetchAiModelsBtn, true);
            try {
                const result = await fetchModels('/api/settings/ai/models', {
                    aiProvider: provider,
                    apiUrl,
                    token: String(ollamaApiKeyInput?.value || '').trim()
                });
                const models = result.models;

                if (result.resolvedApiUrl && ollamaUrlInput) {
                    ollamaUrlInput.value = result.resolvedApiUrl;
                }

                populateModelSelect(ollamaModelInput, models, 'Select Ollama model');
                const resolvedInfo = result.resolvedApiUrl ? `\nResolved API URL: ${result.resolvedApiUrl}` : '';
                await Swal.fire({
                    icon: 'success',
                    title: 'Models loaded',
                    text: `${models.length > 0 ? `Found ${models.length} model(s).` : 'No models found.'}${resolvedInfo}`
                });
                refreshAiPresetSelection();
            } catch (error) {
                const errorDetails = getTimeoutAwareErrorDetails('AI model discovery', error, null);
                await Swal.fire({
                    icon: 'error',
                    title: errorDetails.isTimeout ? 'AI timeout reached' : 'Loading failed',
                    text: errorDetails.message
                });
            } finally {
                setButtonLoading(fetchAiModelsBtn, false);
            }
        });
    }

    if (fetchCustomAiModelsBtn) {
        fetchCustomAiModelsBtn.addEventListener('click', async () => {
            const provider = String(aiProviderSelect?.value || 'custom').toLowerCase();
            const apiUrl = String(customBaseUrlInput?.value || '').trim();
            const token = String(customApiKeyInput?.value || '').trim();

            if (provider !== 'custom') {
                await Swal.fire({ icon: 'info', title: 'Switch provider', text: 'Use this button with AI Provider set to Custom.' });
                return;
            }

            if (!apiUrl) {
                await Swal.fire({ icon: 'warning', title: 'Missing URL', text: 'Please enter the custom base URL first.' });
                return;
            }

            setButtonLoading(fetchCustomAiModelsBtn, true);
            try {
                const result = await fetchModels('/api/settings/ai/models', {
                    aiProvider: provider,
                    apiUrl,
                    token
                });
                const models = result.models;

                if (result.resolvedApiUrl && customBaseUrlInput) {
                    customBaseUrlInput.value = result.resolvedApiUrl;
                }

                populateModelSelect(customModelInput, models, 'Select custom model');
                const resolvedInfo = result.resolvedApiUrl ? `\nResolved API URL: ${result.resolvedApiUrl}` : '';
                await Swal.fire({
                    icon: 'success',
                    title: 'Models loaded',
                    text: `${models.length > 0 ? `Found ${models.length} model(s).` : 'No models found.'}${resolvedInfo}`
                });
                refreshAiPresetSelection();
            } catch (error) {
                const errorDetails = getTimeoutAwareErrorDetails('AI model discovery', error, null);
                await Swal.fire({
                    icon: 'error',
                    title: errorDetails.isTimeout ? 'AI timeout reached' : 'Loading failed',
                    text: errorDetails.message
                });
            } finally {
                setButtonLoading(fetchCustomAiModelsBtn, false);
            }
        });
    }

    const setOcrTestPill = (state, text) => {
        if (!ocrTestState) return;
        ocrTestState.textContent = text;
        ocrTestState.className = 'setup-pill';
        if (state === 'success') {
            ocrTestState.classList.add('setup-pill-success');
        } else if (state === 'error') {
            ocrTestState.classList.add('setup-pill-error');
        } else if (state === 'loading') {
            ocrTestState.classList.add('setup-pill-loading');
        }
    };

    const normalizeOcrProviderForApi = (provider) => {
        const normalized = String(provider || 'mistral').toLowerCase();
        return normalized === 'custom' ? 'custom' : 'mistral';
    };

    const normalizeOcrApiUrlForProvider = (provider, rawUrl) => {
        const normalizedProvider = normalizeOcrProviderForApi(provider);
        if (normalizedProvider === 'mistral') {
            return '';
        }

        return String(rawUrl || '').trim();
    };

    const getOcrValidationTimeoutMs = () => {
        const rawSeconds = Number.parseInt(String(ocrValidationTimeoutInput?.value || '30').trim(), 10);
        const normalizedSeconds = Number.isFinite(rawSeconds) ? Math.min(Math.max(rawSeconds, 1), 7200) : 30;
        return normalizedSeconds * 1000;
    };

    const toggleOcrFields = () => {
        if (!ocrEnabledSelect || !ocrProviderSelect) return;

        const enabled = ocrEnabledSelect.value === 'yes';
        const provider = String(ocrProviderSelect.value || 'mistral').toLowerCase();

        if (ocrFieldsContainer) {
            ocrFieldsContainer.classList.toggle('hidden', !enabled);
        }

        if (ocrApiKeyContainer) {
            ocrApiKeyContainer.classList.toggle('hidden', !enabled);
        }

        if (ocrApiUrlContainer) {
            ocrApiUrlContainer.classList.toggle('hidden', !enabled || provider !== 'custom');
        }

        if (testOcrBtn) {
            testOcrBtn.disabled = !enabled;
        }
    };

    if (ocrProviderSelect) {
        const initialProvider = String(ocrProviderSelect.value || 'mistral').toLowerCase();
        if (initialProvider === 'ollama') {
            ocrProviderSelect.value = 'custom';
        }

        ocrProviderSelect.addEventListener('change', () => {
            toggleOcrFields();
            setOcrTestPill('default', 'Not tested');
        });
    }

    if (ocrEnabledSelect) {
        ocrEnabledSelect.addEventListener('change', () => {
            toggleOcrFields();
            setOcrTestPill('default', 'Not tested');
        });
    }

    const quickstartUrlInput = document.getElementById('settingsQuickstartUrl');
    const quickstartApiKeyInput = document.getElementById('settingsQuickstartApiKey');
    const quickstartDetectBtn = document.getElementById('settingsQuickstartDetectBtn');
    const quickstartStateLabel = document.getElementById('settingsQuickstartState');
    const quickstartResults = document.getElementById('settingsQuickstartResults');
    const quickstartHint = document.getElementById('settingsQuickstartHint');
    const quickstartAiModelSelect = document.getElementById('settingsQuickstartAiModel');
    const quickstartOcrModelSelect = document.getElementById('settingsQuickstartOcrModel');
    const quickstartEnableOcrCheckbox = document.getElementById('settingsQuickstartEnableOcr');
    const quickstartApplyBtn = document.getElementById('settingsQuickstartApplyBtn');
    const quickstartApplyHint = document.getElementById('settingsQuickstartApplyHint');
    let quickstartDetection = null;

    if (quickstartDetectBtn) {
        quickstartDetectBtn.addEventListener('click', async () => {
            const baseUrl = String(quickstartUrlInput?.value || '').trim();
            if (!baseUrl) {
                await Swal.fire({ icon: 'warning', title: 'URL required', text: 'Enter the base URL of your AI server first.' });
                return;
            }

            setButtonLoading(quickstartDetectBtn, true, 'Detecting...');
            if (quickstartStateLabel) {
                quickstartStateLabel.textContent = 'Detecting...';
            }

            try {
                const response = await fetch('/api/settings/quickstart/detect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        baseUrl,
                        apiKey: String(quickstartApiKeyInput?.value || '').trim()
                    })
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || !result.success) {
                    throw new Error(result.error || result.message || 'Quickstart detection failed');
                }

                quickstartDetection = result.detection || null;
                const textModels = Array.isArray(quickstartDetection?.textModels) ? quickstartDetection.textModels : [];
                const visionModels = Array.isArray(quickstartDetection?.visionModels) ? quickstartDetection.visionModels : [];

                populateModelSelect(quickstartAiModelSelect, textModels, textModels.length > 0 ? 'Select AI model' : 'No text-capable models found');
                if (quickstartDetection?.suggestedAiModel && quickstartAiModelSelect) {
                    quickstartAiModelSelect.value = quickstartDetection.suggestedAiModel;
                }

                populateModelSelect(quickstartOcrModelSelect, visionModels, visionModels.length > 0 ? 'Select OCR model' : 'No vision-capable models found');
                if (quickstartDetection?.suggestedOcrModel && quickstartOcrModelSelect) {
                    quickstartOcrModelSelect.value = quickstartDetection.suggestedOcrModel;
                }

                if (quickstartEnableOcrCheckbox) {
                    quickstartEnableOcrCheckbox.disabled = visionModels.length === 0;
                    quickstartEnableOcrCheckbox.checked = visionModels.length > 0;
                }

                if (quickstartHint) {
                    quickstartHint.textContent = result.message || 'Detection complete.';
                }
                if (quickstartResults) {
                    quickstartResults.classList.remove('hidden');
                }
                if (quickstartStateLabel) {
                    quickstartStateLabel.textContent = 'Detected';
                }
                if (quickstartApplyHint) {
                    quickstartApplyHint.textContent = '';
                }
            } catch (error) {
                quickstartDetection = null;
                if (quickstartResults) {
                    quickstartResults.classList.add('hidden');
                }
                if (quickstartStateLabel) {
                    quickstartStateLabel.textContent = 'Detection failed';
                }
                const errorDetails = getTimeoutAwareErrorDetails('Quickstart detection', error, null);
                await Swal.fire({
                    icon: 'error',
                    title: errorDetails.isTimeout ? 'Detection timeout reached' : 'Detection failed',
                    text: errorDetails.message
                });
            } finally {
                setButtonLoading(quickstartDetectBtn, false);
            }
        });
    }

    const applyQuickstartDetectionToForm = async () => {
        if (!quickstartDetection) {
            await Swal.fire({ icon: 'warning', title: 'Detection required', text: 'Run detection first.' });
            return null;
        }

        const selectedAiModel = String(quickstartAiModelSelect?.value || '').trim();
        if (!selectedAiModel) {
            await Swal.fire({ icon: 'warning', title: 'No AI model selected', text: 'Choose an AI model before applying.' });
            return null;
        }

        const detectedProvider = quickstartDetection.aiProvider === 'ollama' ? 'ollama' : 'custom';
        const quickstartKey = String(quickstartApiKeyInput?.value || '').trim();

        if (aiProviderSelect) {
            aiProviderSelect.value = detectedProvider;
            aiProviderSelect.dispatchEvent(new Event('change'));
        }

        if (detectedProvider === 'ollama') {
            if (ollamaUrlInput) ollamaUrlInput.value = String(quickstartDetection.resolvedAiApiUrl || '').trim();
            if (ollamaApiKeyInput) ollamaApiKeyInput.value = quickstartKey;
            populateModelSelect(ollamaModelInput, [selectedAiModel], 'Select Ollama model');
            if (ollamaModelInput) ollamaModelInput.value = selectedAiModel;
        } else {
            if (customBaseUrlInput) customBaseUrlInput.value = String(quickstartDetection.resolvedAiApiUrl || '').trim();
            if (customApiKeyInput) customApiKeyInput.value = quickstartKey;
            populateModelSelect(customModelInput, [selectedAiModel], 'Select custom model');
            if (customModelInput) customModelInput.value = selectedAiModel;
        }

        const applyOcr = Boolean(quickstartEnableOcrCheckbox?.checked);
        const selectedOcrModel = String(quickstartOcrModelSelect?.value || '').trim();
        let appliedOcr = false;

        if (applyOcr && selectedOcrModel) {
            if (ocrEnabledSelect) ocrEnabledSelect.value = 'yes';
            if (ocrProviderSelect) ocrProviderSelect.value = 'custom';
            if (ocrApiUrlInput) ocrApiUrlInput.value = String(quickstartDetection.resolvedOcrApiUrl || '').trim();
            if (ocrApiKeyInput) ocrApiKeyInput.value = quickstartKey;
            if (ocrModelInput) {
                populateModelSelect(ocrModelInput, [selectedOcrModel], 'Select OCR model');
                ocrModelInput.value = selectedOcrModel;
            }
            toggleOcrFields();
            setOcrTestPill('default', 'Not tested');
            appliedOcr = true;
        }

        refreshAiPresetSelection();

        return {
            provider: detectedProvider,
            aiApiUrl: String(quickstartDetection.resolvedAiApiUrl || '').trim(),
            aiModel: selectedAiModel,
            apiKey: quickstartKey,
            appliedOcr,
            ocrApiUrl: String(quickstartDetection.resolvedOcrApiUrl || '').trim(),
            ocrModel: selectedOcrModel
        };
    };

    if (quickstartApplyBtn) {
        quickstartApplyBtn.addEventListener('click', async () => {
            const applied = await applyQuickstartDetectionToForm();
            if (!applied) {
                return;
            }

            if (quickstartApplyHint) {
                quickstartApplyHint.textContent = applied.appliedOcr
                    ? 'AI and OCR fields were prefilled — review the OCR tab, then save.'
                    : 'AI fields were prefilled — review, then save.';
            }
        });
    }

    const setQuickstartTestRowState = (rowId, state, text) => {
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
    };

    const toggleModelTestOverlay = (visible, statusText = '') => {
        const overlay = document.getElementById('modelTestOverlay');
        if (overlay) {
            overlay.classList.toggle('hidden', !visible);
        }

        const status = document.getElementById('modelTestOverlayStatus');
        if (status && statusText) {
            status.textContent = statusText;
        }
    };

    const runQuickstartModelTest = async (url, payload, scope) => {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(result.error || result.message || `${scope} test failed`);
            }
            return { success: Boolean(result.success), message: result.message || '' };
        } catch (error) {
            const errorDetails = getTimeoutAwareErrorDetails(scope, error, null);
            return { success: false, message: errorDetails.message };
        }
    };

    const quickstartSaveBtn = document.getElementById('settingsQuickstartSaveBtn');
    if (quickstartSaveBtn) {
        quickstartSaveBtn.addEventListener('click', async () => {
            const applied = await applyQuickstartDetectionToForm();
            if (!applied) {
                return;
            }

            setQuickstartTestRowState('modelTestAiRow', 'pending', `AI model "${applied.aiModel}": testing...`);
            setQuickstartTestRowState(
                'modelTestOcrRow',
                applied.appliedOcr ? 'pending' : 'skipped',
                applied.appliedOcr ? `OCR model "${applied.ocrModel}": waiting...` : 'OCR fallback disabled — test skipped.'
            );
            toggleModelTestOverlay(true, 'Validating the selected models against your AI server…');

            const aiResult = await runQuickstartModelTest('/api/settings/ai/test', {
                aiProvider: applied.provider,
                apiUrl: applied.aiApiUrl,
                token: applied.apiKey,
                model: applied.aiModel
            }, 'AI connection test');
            setQuickstartTestRowState(
                'modelTestAiRow',
                aiResult.success ? 'success' : 'error',
                aiResult.success ? `AI model "${applied.aiModel}": connection valid` : `AI model "${applied.aiModel}": test failed`
            );

            let ocrResult = { success: true, message: '' };
            if (applied.appliedOcr) {
                setQuickstartTestRowState('modelTestOcrRow', 'pending', `OCR model "${applied.ocrModel}": testing...`);
                ocrResult = await runQuickstartModelTest('/api/settings/ocr/test', {
                    enabled: true,
                    provider: 'custom',
                    apiUrl: applied.ocrApiUrl,
                    apiKey: applied.apiKey,
                    model: applied.ocrModel,
                    setupOcrValidationTimeoutMs: getOcrValidationTimeoutMs()
                }, 'OCR connection test');
                setQuickstartTestRowState(
                    'modelTestOcrRow',
                    ocrResult.success ? 'success' : 'error',
                    ocrResult.success ? `OCR model "${applied.ocrModel}": connection valid` : `OCR model "${applied.ocrModel}": test failed`
                );
                if (ocrResult.success) {
                    setOcrTestPill('success', 'Connection valid');
                } else {
                    setOcrTestPill('error', 'Test failed');
                }
            }

            // Keep the final row states visible for a moment before moving on.
            await new Promise((resolve) => setTimeout(resolve, 900));
            toggleModelTestOverlay(false);

            if (!aiResult.success || !ocrResult.success) {
                const failures = [];
                if (!aiResult.success) {
                    failures.push(`AI model "${applied.aiModel}": ${aiResult.message || 'test failed'}`);
                }
                if (!ocrResult.success) {
                    failures.push(`OCR model "${applied.ocrModel}": ${ocrResult.message || 'test failed'}`);
                }

                await Swal.fire({
                    icon: 'error',
                    title: 'Model test failed',
                    text: `${failures.join('\n')}\n\nAdjust the model selection and try again.`
                });
                return;
            }

            const settingsForm = document.getElementById('setupForm');
            if (settingsForm) {
                settingsForm.requestSubmit();
            }
        });
    }

    if (testOcrBtn) {
        testOcrBtn.addEventListener('click', async () => {
            const enabled = ocrEnabledSelect?.value === 'yes';
            if (!enabled) {
                setOcrTestPill('success', 'Disabled (skipped)');
                return;
            }

            const payload = {
                enabled: true,
                provider: normalizeOcrProviderForApi(ocrProviderSelect?.value || 'mistral'),
                apiUrl: normalizeOcrApiUrlForProvider(ocrProviderSelect?.value || 'mistral', ocrApiUrlInput?.value),
                apiKey: String(ocrApiKeyInput?.value || '').trim(),
                model: String(ocrModelInput?.value || '').trim() || 'mistral-ocr-latest',
                setupOcrValidationTimeoutMs: getOcrValidationTimeoutMs()
            };

            const originalHtml = testOcrBtn.innerHTML;
            testOcrBtn.disabled = true;
            testOcrBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Testing...</span>';
            setOcrTestPill('loading', 'Testing...');

            try {
                const response = await fetch('/api/settings/ocr/test', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.error || result.message || 'OCR test failed');
                }

                if (result.resolvedApiUrl && ocrApiUrlInput) {
                    ocrApiUrlInput.value = String(result.resolvedApiUrl).trim();
                }

                setOcrTestPill('success', 'Connection valid');
                await Swal.fire({
                    icon: 'success',
                    title: 'OCR test successful',
                    text: result.message || 'OCR provider is reachable.'
                });
            } catch (error) {
                const errorDetails = getTimeoutAwareErrorDetails('OCR response', error, payload.setupOcrValidationTimeoutMs);
                setOcrTestPill('error', errorDetails.isTimeout ? 'Timeout reached' : 'Test failed');
                await Swal.fire({
                    icon: 'error',
                    title: errorDetails.isTimeout ? 'OCR timeout reached' : 'OCR test failed',
                    text: errorDetails.message
                });
            } finally {
                testOcrBtn.disabled = ocrEnabledSelect?.value !== 'yes';
                testOcrBtn.innerHTML = originalHtml;
            }
        });
    }

    if (fetchOcrModelsBtn) {
        fetchOcrModelsBtn.addEventListener('click', async () => {
            const provider = normalizeOcrProviderForApi(ocrProviderSelect?.value || 'mistral');
            const apiUrl = normalizeOcrApiUrlForProvider(provider, ocrApiUrlInput?.value);
            const apiKey = String(ocrApiKeyInput?.value || '').trim();

            if (provider === 'mistral' && !apiKey) {
                await Swal.fire({ icon: 'warning', title: 'Missing API key', text: 'Mistral OCR requires an API key to load models.' });
                return;
            }

            setButtonLoading(fetchOcrModelsBtn, true);
            try {
                const response = await fetch('/api/settings/ocr/models', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        provider,
                        apiUrl,
                        apiKey,
                        setupOcrValidationTimeoutMs: getOcrValidationTimeoutMs()
                    })
                });

                const result = await response.json().catch(() => ({}));
                if (!response.ok || !result.success) {
                    throw new Error(result.error || result.message || 'Model discovery failed');
                }

                if (result.resolvedApiUrl && ocrApiUrlInput) {
                    ocrApiUrlInput.value = String(result.resolvedApiUrl).trim();
                }

                const models = Array.isArray(result.models) ? result.models : [];
                populateModelSelect(ocrModelInput, models, 'Select OCR model');
                await Swal.fire({ icon: 'success', title: 'OCR models loaded', text: models.length > 0 ? `Found ${models.length} model(s).` : 'No models found.' });
            } catch (error) {
                const errorDetails = getTimeoutAwareErrorDetails('OCR model discovery', error, getOcrValidationTimeoutMs());
                await Swal.fire({
                    icon: 'error',
                    title: errorDetails.isTimeout ? 'OCR timeout reached' : 'Loading failed',
                    text: errorDetails.message
                });
            } finally {
                setButtonLoading(fetchOcrModelsBtn, false);
            }
        });
    }

    toggleOcrFields();

    const restartOverlay = document.getElementById('restartOverlay');
    const restartOverlayStatus = document.getElementById('restartOverlayStatus');
    const restartOverlayBar = document.getElementById('restartOverlayBar');
    const restartOverlayPercent = document.getElementById('restartOverlayPercent');
    const restartOverlayActions = document.getElementById('restartOverlayActions');
    const restartOverlayReloadBtn = document.getElementById('restartOverlayReloadBtn');
    const restartOverlayRetryBtn = document.getElementById('restartOverlayRetryBtn');

    let restartProgressInterval = null;

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function formatBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        if (safeBytes === 0) {
            return '0 B';
        }

        const unitIndex = Math.min(Math.floor(Math.log(safeBytes) / Math.log(1024)), units.length - 1);
        const value = safeBytes / (1024 ** unitIndex);
        return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
    }

    function renderThumbnailCacheStats(stats) {
        const fileCountEl = document.getElementById('thumbnailCacheFileCount');
        const totalSizeEl = document.getElementById('thumbnailCacheTotalSize');

        if (!fileCountEl || !totalSizeEl) {
            return;
        }

        const count = Number(stats?.fileCount || 0);
        const bytes = Number(stats?.totalBytes || 0);
        fileCountEl.textContent = String(count);
        totalSizeEl.textContent = stats?.totalSizeHuman || formatBytes(bytes);
    }

    async function refreshThumbnailCacheStats() {
        const refreshBtn = document.getElementById('refreshThumbnailCacheStatsBtn');

        try {
            if (refreshBtn) {
                refreshBtn.disabled = true;
            }

            const response = await fetch('/api/settings/thumbnail-cache', {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.error || 'Failed to load thumbnail cache stats');
            }

            renderThumbnailCacheStats(result.data || {});
        } catch (error) {
            console.error('Error loading thumbnail cache stats:', error);
            renderThumbnailCacheStats({ fileCount: 0, totalBytes: 0, totalSizeHuman: 'n/a' });
        } finally {
            if (refreshBtn) {
                refreshBtn.disabled = false;
            }
        }
    }

    function setRestartProgress(percent, message) {
        const clamped = Math.max(0, Math.min(100, Math.floor(percent)));
        if (restartOverlayBar) {
            restartOverlayBar.style.width = `${clamped}%`;
        }
        if (restartOverlayPercent) {
            restartOverlayPercent.textContent = `${clamped}%`;
        }
        if (restartOverlayStatus && message) {
            restartOverlayStatus.textContent = message;
        }
    }

    function showRestartOverlay(initialMessage) {
        if (!restartOverlay) return;
        restartOverlay.classList.remove('hidden');
        if (restartOverlayActions) {
            restartOverlayActions.classList.add('hidden');
        }
        setRestartProgress(6, initialMessage || 'Saving changes and waiting for server health check…');
    }

    function stopRestartProgressInterval() {
        if (restartProgressInterval) {
            clearInterval(restartProgressInterval);
            restartProgressInterval = null;
        }
    }

    function startRestartProgressInterval() {
        stopRestartProgressInterval();
        restartProgressInterval = setInterval(() => {
            const currentPercent = Number((restartOverlayBar?.style.width || '6').replace('%', '')) || 6;
            if (currentPercent >= 92) {
                return;
            }
            const nextStep = currentPercent + Math.max(1, Math.floor(Math.random() * 6));
            setRestartProgress(Math.min(92, nextStep));
        }, 1200);
    }

    async function isServerHealthy() {
        const response = await fetch('/health', {
            method: 'GET',
            cache: 'no-store',
            headers: {
                Accept: 'application/json'
            }
        });

        if (!response.ok) {
            return false;
        }

        const payload = await response.json().catch(() => null);
        return !payload || payload.status === 'healthy';
    }

    async function waitForServerRecovery() {
        const timeoutMs = 180000;
        const startedAt = Date.now();
        setRestartProgress(12, 'Restart in progress… checking server health.');
        startRestartProgressInterval();

        while (Date.now() - startedAt < timeoutMs) {
            await delay(1800);
            try {
                const healthy = await isServerHealthy();
                if (healthy) {
                    stopRestartProgressInterval();
                    setRestartProgress(100, 'Server is back. Reloading page…');
                    await delay(500);
                    window.location.reload();
                    return;
                }
            } catch (error) {
                // Ignore network errors while server is restarting
            }
        }

        stopRestartProgressInterval();
        setRestartProgress(95, 'Still waiting for server. You can retry the health check or reload manually.');
        if (restartOverlayActions) {
            restartOverlayActions.classList.remove('hidden');
        }
    }

    if (restartOverlayReloadBtn) {
        restartOverlayReloadBtn.addEventListener('click', () => {
            window.location.reload();
        });
    }

    if (restartOverlayRetryBtn) {
        restartOverlayRetryBtn.addEventListener('click', async () => {
            if (restartOverlayActions) {
                restartOverlayActions.classList.add('hidden');
            }
            await waitForServerRecovery();
        });
    }

    // Clear Tag Cache Button Handler
    const clearTagCacheBtn = document.getElementById('clearTagCacheBtn');
    if (clearTagCacheBtn) {
        clearTagCacheBtn.addEventListener('click', async () => {
            const btn = clearTagCacheBtn;
            const icon = document.getElementById('clearCacheIcon');
            const originalHTML = btn.innerHTML;
            
            try {
                // Disable button and show loading state
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Clearing Cache...';
                
                const response = await fetch('/api/settings/clear-tag-cache', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                const result = await response.json();
                
                if (result.success) {
                    await Swal.fire({
                        icon: 'success',
                        title: 'Cache Cleared!',
                        text: result.message || 'Tag cache has been cleared successfully.',
                        timer: 2000,
                        showConfirmButton: false
                    });
                } else {
                    throw new Error(result.error || 'Failed to clear cache');
                }
            } catch (error) {
                console.error('Error clearing tag cache:', error);
                await Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: error.message || 'Failed to clear tag cache. Please try again.'
                });
            } finally {
                // Restore button state
                btn.disabled = false;
                btn.innerHTML = originalHTML;
            }
        });
    }

    const refreshThumbnailCacheStatsBtn = document.getElementById('refreshThumbnailCacheStatsBtn');
    if (refreshThumbnailCacheStatsBtn) {
        refreshThumbnailCacheStatsBtn.addEventListener('click', async () => {
            await refreshThumbnailCacheStats();
        });
    }

    const clearThumbnailCacheBtn = document.getElementById('clearThumbnailCacheBtn');
    if (clearThumbnailCacheBtn) {
        clearThumbnailCacheBtn.addEventListener('click', async () => {
            const confirmResult = await Swal.fire({
                icon: 'warning',
                title: 'Clear thumbnail cache?',
                text: 'This will delete all locally cached thumbnail previews. They will be downloaded again when needed.',
                showCancelButton: true,
                confirmButtonColor: '#d33',
                cancelButtonColor: '#3085d6',
                confirmButtonText: 'Yes, clear thumbnail cache'
            });

            if (!confirmResult.isConfirmed) {
                return;
            }

            const originalHtml = clearThumbnailCacheBtn.innerHTML;

            try {
                clearThumbnailCacheBtn.disabled = true;
                clearThumbnailCacheBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Clearing...';

                const response = await fetch('/api/settings/thumbnail-cache/clear', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.error || 'Failed to clear thumbnail cache');
                }

                renderThumbnailCacheStats(result.remaining || {});

                await Swal.fire({
                    icon: 'success',
                    title: 'Thumbnail cache cleared',
                    text: result.message || `Removed ${result.removedFiles || 0} files.`
                });
            } catch (error) {
                console.error('Error clearing thumbnail cache:', error);
                await Swal.fire({
                    icon: 'error',
                    title: 'Action failed',
                    text: error.message || 'Failed to clear thumbnail cache.'
                });
            } finally {
                clearThumbnailCacheBtn.disabled = false;
                clearThumbnailCacheBtn.innerHTML = originalHtml;
                await refreshThumbnailCacheStats();
            }
        });
    }

    refreshThumbnailCacheStats();

    const resetLocalOverridesBtn = document.getElementById('resetLocalOverridesBtn');
    if (resetLocalOverridesBtn) {
        resetLocalOverridesBtn.addEventListener('click', async () => {
            const confirmResult = await Swal.fire({
                icon: 'warning',
                title: 'Reset local runtime overrides?',
                text: 'This removes local overrides. Container-managed environment values are applied after restart.',
                input: 'password',
                inputLabel: 'Confirm with your current password',
                inputPlaceholder: 'Enter current password',
                inputAttributes: {
                    autocapitalize: 'off',
                    autocorrect: 'off',
                    autocomplete: 'current-password'
                },
                inputValidator: (value) => {
                    if (!value || !String(value).trim()) {
                        return 'Current password is required.';
                    }
                    return null;
                },
                showCancelButton: true,
                confirmButtonColor: '#d33',
                cancelButtonColor: '#3085d6',
                confirmButtonText: 'Yes, reset overrides'
            });

            if (!confirmResult.isConfirmed) {
                return;
            }

            const currentPassword = String(confirmResult.value || '').trim();

            const originalHtml = resetLocalOverridesBtn.innerHTML;
            try {
                resetLocalOverridesBtn.disabled = true;
                resetLocalOverridesBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Resetting...';

                const response = await fetch('/api/settings/reset-local-overrides', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ currentPassword })
                });

                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.error || 'Failed to reset local runtime overrides');
                }

                await Swal.fire({
                    icon: 'success',
                    title: 'Local overrides reset',
                    text: result.message || 'Local runtime overrides were removed. Restart the container to apply injected environment values.'
                });

                showRestartOverlay();
                await waitForServerRecovery();
            } catch (error) {
                await Swal.fire({
                    icon: 'error',
                    title: 'Reset failed',
                    text: error.message
                });
            } finally {
                resetLocalOverridesBtn.disabled = false;
                resetLocalOverridesBtn.innerHTML = originalHtml;
            }
        });
    }

    // Force Reconcile Button Handler
    const forceReconcileBtn = document.getElementById('forceReconcileBtn');
    if (forceReconcileBtn) {
        forceReconcileBtn.addEventListener('click', async () => {
            const btn = forceReconcileBtn;
            const resultDiv = document.getElementById('reconcileResult');
            const originalHtml = btn.innerHTML;

            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running...';
            if (resultDiv) {
                resultDiv.className = 'mt-3';
                resultDiv.innerHTML = '<span class="text-sm text-gray-500"><i class="fas fa-spinner fa-spin mr-1"></i> Reconciliation in progress...</span>';
            }

            try {
                await new Promise((resolve, reject) => {
                    const eventSource = new EventSource('/api/settings/reconcile-history');
                    // Workaround: EventSource only supports GET. Use fetch for POST SSE.
                    // Actually the endpoint is POST - close EventSource and use fetch instead.
                    eventSource.close();
                    resolve();
                });

                // Use fetch with streaming for the POST SSE endpoint
                const response = await fetch('/api/settings/reconcile-history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (!response.ok) {
                    throw new Error(`Server error: ${response.status}`);
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let lastEvent = null;
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n\n');
                    buffer = lines.pop();
                    for (const chunk of lines) {
                        const match = chunk.match(/^data:\s*(.+)$/m);
                        if (match) {
                            try { lastEvent = JSON.parse(match[1]); } catch (_) {}
                        }
                    }
                }

                if (lastEvent && lastEvent.type === 'complete') {
                    if (resultDiv) {
                        if (lastEvent.skipped) {
                            resultDiv.innerHTML = '<span class="text-sm text-yellow-600"><i class="fas fa-exclamation-triangle mr-1"></i> Skipped: a scan or reconciliation is already in progress.</span>';
                        } else if (lastEvent.removed > 0) {
                            resultDiv.innerHTML = `<span class="text-sm text-green-600"><i class="fas fa-check-circle mr-1"></i> Removed ${lastEvent.removed} stale entr${lastEvent.removed === 1 ? 'y' : 'ies'} in ${lastEvent.durationMs}ms.</span>`;
                        } else {
                            resultDiv.innerHTML = '<span class="text-sm text-green-600"><i class="fas fa-check-circle mr-1"></i> No stale entries found.</span>';
                        }
                    }
                } else if (lastEvent && lastEvent.type === 'error') {
                    throw new Error(lastEvent.error || 'Reconciliation failed.');
                }
            } catch (error) {
                console.error('Error during reconciliation:', error);
                if (resultDiv) {
                    resultDiv.innerHTML = `<span class="text-sm text-red-600"><i class="fas fa-times-circle mr-1"></i> ${error.message || 'Reconciliation failed.'}</span>`;
                }
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        });
    }

    // Form submission handler
    const setupForm = document.getElementById('setupForm');
    if (!setupForm) {
        return;
    }
    setupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const submitBtn = setupForm.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

        try {

            const formData = new FormData(setupForm);
            //remove from formData.systemPrompt all ` chars
            if (formData.get('systemPrompt')) {
                formData.set('systemPrompt', formData.get('systemPrompt').replace(/`/g, ''));
            }

            const validateTemperature = (fieldName, envKey) => {
                const rawValue = String(formData.get(fieldName) || '').trim();
                if (!rawValue) {
                    return;
                }

                const parsed = Number.parseFloat(rawValue);
                if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
                    throw new Error(`${envKey} must be a number between 0.0 and 2.0.`);
                }
            };

            validateTemperature('aiTemperatureAnalysis', 'AI_TEMPERATURE_ANALYSIS');
            validateTemperature('aiTemperatureGeneration', 'AI_TEMPERATURE_GENERATION');

            const resolveModels = async (url, payload) => {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const result = await response.json().catch(() => ({}));
                if (!response.ok || !result.success) {
                    return { models: [], resolvedApiUrl: '' };
                }

                return {
                    models: Array.isArray(result.models) ? result.models : [],
                    resolvedApiUrl: String(result.resolvedApiUrl || '').trim()
                };
            };

            const aiProvider = String(formData.get('aiProvider') || '').trim().toLowerCase();
            if (aiProvider === 'ollama' && !String(formData.get('ollamaModel') || '').trim()) {
                const discovery = await resolveModels('/api/settings/ai/models', {
                    aiProvider: 'ollama',
                    apiUrl: String(formData.get('ollamaUrl') || '').trim(),
                    token: String(formData.get('ollamaApiKey') || '').trim()
                });
                const models = discovery.models;
                if (discovery.resolvedApiUrl) {
                    formData.set('ollamaUrl', discovery.resolvedApiUrl);
                    const urlInput = document.getElementById('ollamaUrl');
                    if (urlInput) urlInput.value = discovery.resolvedApiUrl;
                }
                if (models.length > 0) {
                    formData.set('ollamaModel', models[0]);
                    const input = document.getElementById('ollamaModel');
                    if (input) input.value = models[0];
                }
            }

            if (aiProvider === 'custom' && !String(formData.get('customModel') || '').trim()) {
                const discovery = await resolveModels('/api/settings/ai/models', {
                    aiProvider: 'custom',
                    apiUrl: String(formData.get('customBaseUrl') || '').trim(),
                    token: String(formData.get('customApiKey') || '').trim()
                });
                const models = discovery.models;
                if (discovery.resolvedApiUrl) {
                    formData.set('customBaseUrl', discovery.resolvedApiUrl);
                    const urlInput = document.getElementById('customBaseUrl');
                    if (urlInput) urlInput.value = discovery.resolvedApiUrl;
                }
                if (models.length > 0) {
                    formData.set('customModel', models[0]);
                    const input = document.getElementById('customModel');
                    if (input) input.value = models[0];
                }
            }

            const ocrEnabled = String(formData.get('mistralOcrEnabled') || 'no').trim().toLowerCase() === 'yes';
            const ocrProvider = String(formData.get('ocrProvider') || 'mistral').trim().toLowerCase();
            const ocrTimeoutSeconds = Number.parseInt(String(formData.get('ocrValidationTimeout') || '30').trim(), 10);
            if (!Number.isFinite(ocrTimeoutSeconds) || ocrTimeoutSeconds < 1 || ocrTimeoutSeconds > 7200) {
                throw new Error('OCR timeout must be between 1 and 7200 seconds.');
            }
            if (ocrEnabled && !String(formData.get('mistralOcrModel') || '').trim()) {
                const payload = {
                    provider: ocrProvider,
                    apiUrl: normalizeOcrApiUrlForProvider(ocrProvider, formData.get('ocrApiUrl')),
                    apiKey: String(formData.get('ocrApiKey') || '').trim(),
                    setupOcrValidationTimeoutMs: getOcrValidationTimeoutMs()
                };

                const response = await fetch('/api/settings/ocr/models', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const result = await response.json().catch(() => ({}));
                const models = (!response.ok || !result.success)
                    ? []
                    : (Array.isArray(result.models) ? result.models : []);

                if (result.resolvedApiUrl) {
                    const resolvedApiUrl = String(result.resolvedApiUrl).trim();
                    formData.set('ocrApiUrl', resolvedApiUrl);
                    const input = document.getElementById('ocrApiUrl');
                    if (input) input.value = resolvedApiUrl;
                }

                if (models.length > 0) {
                    formData.set('mistralOcrModel', models[0]);
                    const input = document.getElementById('mistralOcrModel');
                    if (input) input.value = models[0];
                }
            }

            // Keep behavior consistent with setup: mistral provider should not reuse stale local OCR URLs.
            formData.set('ocrApiUrl', normalizeOcrApiUrlForProvider(ocrProvider, formData.get('ocrApiUrl')));

            const response = await fetch('/settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(Object.fromEntries(formData))
            });

            const result = await response.json();

            if (result.success) {
                await Swal.fire({
                    icon: 'success',
                    title: 'Success!',
                    text: result.message,
                    timer: 2000,
                    showConfirmButton: false
                });

                if (result.restart) {
                    showRestartOverlay('Restarting service… waiting for health checks to pass.');
                    await waitForServerRecovery();
                }
            } else {
                throw new Error(result.error || 'An unknown error occurred');
            }
        } catch (error) {
            await Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.message
            });
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    });
}

function normalizeSystemPromptNewlines() {
    const systemPromptTextarea = document.getElementById('systemPrompt');
    if (systemPromptTextarea) {
        systemPromptTextarea.value = systemPromptTextarea.value.replace(/\\n/g, '\n');
    }
}

function mapPublicUrlSourceToLabel(source) {
    const sourceMap = {
        manual_override: 'Manual override',
        paperless_api: 'Paperless API',
        api_url_fallback: 'API URL fallback',
        unavailable: 'Unavailable'
    };

    return sourceMap[source] || 'Unknown';
}

async function refreshDetectedPublicUrlStatus() {
    const valueElement = document.getElementById('paperlessDetectedUrlValue');
    const metaElement = document.getElementById('paperlessDetectedUrlMeta');
    const refreshButton = document.getElementById('refreshPublicUrlDetection');

    if (!valueElement || !metaElement) {
        return;
    }

    if (refreshButton) {
        refreshButton.disabled = true;
    }

    valueElement.textContent = 'Loading…';
    metaElement.textContent = 'Resolving public URL…';

    try {
        const response = await fetch('/api/settings/paperless-public-url');
        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error || 'Failed to resolve public URL');
        }

        valueElement.textContent = result.publicUrl || 'Not available';
        metaElement.textContent = `Source: ${mapPublicUrlSourceToLabel(result.source)}`;
    } catch (error) {
        valueElement.textContent = 'Not available';
        metaElement.textContent = `Error: ${error.message}`;
    } finally {
        if (refreshButton) {
            refreshButton.disabled = false;
        }
    }
}

function initializePublicUrlStatus() {
    const refreshButton = document.getElementById('refreshPublicUrlDetection');
    if (refreshButton) {
        refreshButton.addEventListener('click', () => {
            refreshDetectedPublicUrlStatus();
        });
    }

    refreshDetectedPublicUrlStatus();
}

class URLValidator {
    constructor() {
        this.urlInput = document.getElementById('paperlessUrl');
        this.isShowingError = false;
        this.initialize();
    }

    initialize() {
        this.urlInput.addEventListener('blur', () => this.validateURL());
    }

    async validateURL() {
        if (this.isShowingError) return;

        try {
            if (!this.urlInput.value) return;
            const url = new URL(this.urlInput.value);

            if (!['http:', 'https:'].includes(url.protocol)) {
                throw new Error('The URL must start with http:// or https://');
            }

            // Prüfe auf zusätzliche Pfade oder Parameter
            if (url.pathname !== '/' || url.search || url.hash) {
                throw new Error('The URL must not contain any paths, parameters, or trailing slashes after the port.');
            }

            // Automatische Formatierung der URL
            const formattedUrl = `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`;
            if (this.urlInput.value !== formattedUrl) {
                this.urlInput.value = formattedUrl;
            }

        } catch (error) {
            this.isShowingError = true;
            const result = await Swal.fire({
                icon: 'warning',
                title: 'Invalid URL',
                text: error.message,
                showCancelButton: true,
                confirmButtonText: 'Confirm anyway',
                cancelButtonText: 'Fix it',
                customClass: {
                    container: 'z-50'
                }
            });

            this.isShowingError = false;
            if (result.isDismissed) {
                this.sanitizeURL();
            }
        }
    }

    sanitizeURL() {
        try {
            if (!this.urlInput.value) return;
            const url = new URL(this.urlInput.value);
            this.urlInput.value = `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`;
        } catch (error) {
            Swal.fire({
                icon: 'error',
                title: 'Invalid URL',
                text: 'Please enter a valid URL. ( http[s]://your-paperless-instance:8000 )',
                customClass: {
                    container: 'z-50'
                }
            });
        }
    }
}

const TOOLTIP_CARD_STYLES = 'background:#ffffff;color:#111827;border:1px solid #d1d5db;border-radius:8px;';
const REGISTERED_TOOLTIP_INSTANCES = [];
let tooltipResizeListenerAttached = false;

function getSettingsTooltipPlacement() {
    return window.innerWidth < 768 ? 'bottom' : 'right';
}

function createReadableTooltipContent(innerHtml, padding = '10px 12px') {
    return `<div style="${TOOLTIP_CARD_STYLES}padding:${padding};line-height:1.45;">${innerHtml}</div>`;
}

function getReadableTooltipOptions(overrides = {}) {
    return {
        allowHTML: true,
        placement: getSettingsTooltipPlacement(),
        interactive: true,
        trigger: 'mouseenter focus click',
        theme: 'light-border',
        touch: 'hold',
        appendTo: () => document.body,
        ...overrides
    };
}

function normalizeTooltipInstances(instances) {
    if (!instances) {
        return [];
    }

    if (Array.isArray(instances)) {
        return instances.filter((instance) => instance && typeof instance.setProps === 'function');
    }

    return typeof instances.setProps === 'function' ? [instances] : [];
}

function refreshAllTooltipPlacements() {
    const placement = getSettingsTooltipPlacement();
    REGISTERED_TOOLTIP_INSTANCES.forEach((instance) => {
        instance.setProps({ placement });
    });
}

function registerTooltipInstances(instances) {
    const normalizedInstances = normalizeTooltipInstances(instances);
    if (normalizedInstances.length === 0) {
        return;
    }

    normalizedInstances.forEach((instance) => {
        if (!REGISTERED_TOOLTIP_INSTANCES.includes(instance)) {
            REGISTERED_TOOLTIP_INSTANCES.push(instance);
        }
    });

    if (!tooltipResizeListenerAttached) {
        window.addEventListener('resize', refreshAllTooltipPlacements);
        tooltipResizeListenerAttached = true;
    }
}

// Tooltip System
class TooltipManager {
    constructor() {
        this.initialize();
    }

    initialize() {
        this.tooltipInstance = tippy('#urlHelp', getReadableTooltipOptions({
            content: this.getTooltipContent(),
            maxWidth: 450,
            trigger: 'mouseenter click',
            zIndex: 40,
        }));
        registerTooltipInstances(this.tooltipInstance);
    }

    getTooltipContent() {
        return createReadableTooltipContent(`
                <h3 style="font-size:16px;font-weight:700;margin-bottom:8px;">API URL Configuration</h3>
                
                <div style="margin-bottom:10px;">
                    <p>The URL should follow this format:</p>
                    <code style="display:block;padding:8px;background:#f3f4f6;border-radius:6px;color:#111827;">
                        http://your-host:8000
                    </code>
                </div>
                
                <div style="margin-bottom:10px;">
                    <p style="font-weight:600;">Important Notes:</p>
                    <ul style="padding-left:18px;margin-top:4px;">
                        <li>Must start with <u>http://</u> or <u>https://</u></li>
                        <li>Contains <strong>host/IP</strong> and optionally a <strong>port</strong></li>
                        <li>No additional paths or parameters</li>
                    </ul>
                </div>

                <div style="margin-bottom:10px;">
                    <p style="font-weight:600;">Docker Network Configuration:</p>
                    <ul style="padding-left:18px;margin-top:4px;">
                        <li>Using <strong>localhost</strong> or <strong>127.0.0.1</strong> won't work in Docker bridge mode</li>
                        <li>Use your machine's local IP (e.g., <code>192.168.1.x</code>) instead</li>
                        <li>Or use the Docker container name if both services are in the same network</li>
                    </ul>
                </div>

                <div style="margin-bottom:10px;">
                    <p style="font-weight:600;">Examples:</p>
                    <ul style="list-style:none;padding-left:0;margin-top:4px;">
                        <li>🔸 Local IP: <code>http://192.168.1.100:8000</code></li>
                        <li>🔸 Container: <code>http://paperless-ngx:8000</code></li>
                        <li>🔸 Remote: <code>http://paperless.domain.com</code></li>
                    </ul>
                </div>

                <p style="font-size:12px;font-style:italic;margin-top:8px;">The /api endpoint will be added automatically.</p>
        `, '12px');
    }
}

class SettingsHintManager {
    getHintTriggerClasses() {
        return [
            'inline-flex',
            'items-center',
            'justify-center',
            'ml-2',
            'text-blue-700',
            'hover:text-blue-900',
            'focus:outline-none',
            'focus:ring-2',
            'focus:ring-blue-600',
            'rounded-full',
            'transition-colors'
        ];
    }

    constructor() {
        this.initializeTagCacheHint();
        this.refresh();
    }

    getHintRows() {
        return Array.from(document.querySelectorAll('#setupForm p.text-xs.text-gray-500'));
    }

    findAssociatedLabel(hint) {
        const container = hint.closest('.space-y-2') || hint.parentElement;
        if (!container) {
            return null;
        }

        const directLabels = Array.from(container.querySelectorAll('label'));
        if (directLabels.length > 0) {
            return directLabels[0];
        }

        let sibling = hint.previousElementSibling;
        while (sibling) {
            if (sibling.matches && sibling.matches('label')) {
                return sibling;
            }

            if (sibling.querySelector) {
                const nestedLabel = sibling.querySelector('label');
                if (nestedLabel) {
                    return nestedLabel;
                }
            }

            sibling = sibling.previousElementSibling;
        }

        return null;
    }

    findFallbackAnchor(hint) {
        const container = hint.closest('.space-y-2') || hint.parentElement;
        if (!container) {
            return null;
        }

        return container.querySelector('input, select, textarea, button') || container;
    }

    ensureHintTriggers() {
        const hintRows = this.getHintRows();
        const tooltipTargets = [];

        hintRows.forEach((hint) => {
            const label = this.findAssociatedLabel(hint);

            const fallbackAnchor = label ? null : this.findFallbackAnchor(hint);
            if (!label && !fallbackAnchor) {
                return;
            }

            if (label && label.querySelector('.setting-hint-trigger')) {
                hint.classList.add('hidden');
                return;
            }

            if (!label && hint.parentElement?.querySelector('.setting-hint-trigger[data-hint-fallback="true"]')) {
                hint.classList.add('hidden');
                return;
            }

            const trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.className = `setting-hint-trigger ${this.getHintTriggerClasses().join(' ')}`;
            trigger.setAttribute('aria-label', 'Show setting hint');
            trigger.style.width = '1.125rem';
            trigger.style.height = '1.125rem';
            trigger.style.minWidth = '1.125rem';
            trigger.style.minHeight = '1.125rem';
            trigger.innerHTML = '<i class="fas fa-circle-question" style="font-size:0.875rem;line-height:1;"></i>';
            trigger.dataset.hintContent = hint.innerHTML;
            trigger.dataset.hintFallback = label ? 'false' : 'true';

            if (label) {
                if (!label.classList.contains('flex')) {
                    label.classList.add('flex', 'items-center');
                }

                label.appendChild(trigger);
            } else if (fallbackAnchor.matches && fallbackAnchor.matches('input, select, textarea, button')) {
                fallbackAnchor.insertAdjacentElement('afterend', trigger);
            } else {
                fallbackAnchor.appendChild(trigger);
            }

            hint.classList.add('hidden');
            tooltipTargets.push(trigger);
        });

        return tooltipTargets;
    }

    bindHintTooltips(tooltipTargets) {
        if (!Array.isArray(tooltipTargets) || tooltipTargets.length === 0) {
            return;
        }

        const hintTooltipInstances = tippy(tooltipTargets, getReadableTooltipOptions({
            maxWidth: 360,
            content(reference) {
                return createReadableTooltipContent(reference.dataset.hintContent || '', '8px 10px');
            }
        }));
        registerTooltipInstances(hintTooltipInstances);
    }

    refresh() {
        const tooltipTargets = this.ensureHintTriggers();
        this.bindHintTooltips(tooltipTargets);

        const unboundTriggers = Array.from(document.querySelectorAll('.setting-hint-trigger')).filter(
            (trigger) => !trigger._tippy
        );
        this.bindHintTooltips(unboundTriggers);
    }

    initialize() {
        this.refresh();
        this.initializeTagCacheHint();
    }

    initializeTagCacheHint() {
        const tagCacheTTLHelp = document.getElementById('tagCacheTTLHelp');
        if (!tagCacheTTLHelp) {
            return;
        }

        const urlHelp = document.getElementById('urlHelp');
        if (urlHelp) {
            urlHelp.classList.remove('text-gray-400', 'hover:text-gray-600');
            urlHelp.classList.add(...this.getHintTriggerClasses());
            urlHelp.style.width = '1.125rem';
            urlHelp.style.height = '1.125rem';
            urlHelp.style.minWidth = '1.125rem';
            urlHelp.style.minHeight = '1.125rem';

            const urlHelpIcon = urlHelp.querySelector('i');
            if (urlHelpIcon) {
                urlHelpIcon.style.fontSize = '0.875rem';
                urlHelpIcon.style.lineHeight = '1';
            }
        }

        tagCacheTTLHelp.classList.remove('text-gray-400', 'hover:text-gray-600');
        tagCacheTTLHelp.classList.add(...this.getHintTriggerClasses());
        tagCacheTTLHelp.style.width = '1.125rem';
        tagCacheTTLHelp.style.height = '1.125rem';
        tagCacheTTLHelp.style.minWidth = '1.125rem';
        tagCacheTTLHelp.style.minHeight = '1.125rem';

        const tagCacheIcon = tagCacheTTLHelp.querySelector('i');
        if (tagCacheIcon) {
            tagCacheIcon.style.fontSize = '0.875rem';
            tagCacheIcon.style.lineHeight = '1';
        }

        const tagCacheTooltipInstance = tippy(tagCacheTTLHelp, getReadableTooltipOptions({
            maxWidth: 420,
            content: createReadableTooltipContent(`
                    <p style="margin-bottom:8px;">Controls how long tags are cached before refreshing from Paperless-ngx.</p>
                    <ul style="padding-left:18px; margin:0 0 8px 0;">
                        <li><strong>60-180s:</strong> fresher data, more API calls</li>
                        <li><strong>300s (recommended):</strong> balanced</li>
                        <li><strong>600-3600s:</strong> fewer API calls, slower visibility of new tags</li>
                    </ul>
                    <p style="font-size:12px;">Good cache settings can reduce Paperless tag API calls significantly during batch processing.</p>
            `)
        }));
        registerTooltipInstances(tagCacheTooltipInstance);
    }
}

function initializeTooltipAndValidation() {
    const urlValidator = new URLValidator();
    const tooltipManager = new TooltipManager();
    settingsHintManager = new SettingsHintManager();
    initializeSettingsHintObserver();
    scheduleSettingsHintsRefresh();
}

let settingsHintManager = null;
let settingsHintObserver = null;
let settingsHintRefreshScheduled = false;

function refreshSettingsHints() {
    if (!settingsHintManager) {
        return;
    }

    settingsHintManager.refresh();
}

function scheduleSettingsHintsRefresh() {
    if (settingsHintRefreshScheduled) {
        return;
    }

    settingsHintRefreshScheduled = true;
    requestAnimationFrame(() => {
        settingsHintRefreshScheduled = false;
        refreshSettingsHints();
    });
}

function initializeSettingsHintObserver() {
    if (settingsHintObserver) {
        return;
    }

    const setupForm = document.getElementById('setupForm');
    if (!setupForm) {
        return;
    }

    settingsHintObserver = new MutationObserver(() => {
        scheduleSettingsHintsRefresh();
    });

    settingsHintObserver.observe(setupForm, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden']
    });
}

function initializeRuntimeOverridePills() {
    const resetLocalOverridesBtn = document.getElementById('resetLocalOverridesBtn');
    let parsedOverrideKeys = [];
    let parsedOverrideDetails = {};
    let parsedLockedEnvKeys = [];
    let parsedLockedEnvDetails = {};

    if (resetLocalOverridesBtn?.dataset?.runtimeOverrideKeys) {
        try {
            parsedOverrideKeys = JSON.parse(resetLocalOverridesBtn.dataset.runtimeOverrideKeys);
        } catch (error) {
            console.warn('Failed to parse runtime override keys:', error);
        }
    }

    if (resetLocalOverridesBtn?.dataset?.runtimeOverrideDetails) {
        try {
            parsedOverrideDetails = JSON.parse(resetLocalOverridesBtn.dataset.runtimeOverrideDetails);
        } catch (error) {
            console.warn('Failed to parse runtime override details:', error);
        }
    }

    if (resetLocalOverridesBtn?.dataset?.lockedEnvKeys) {
        try {
            parsedLockedEnvKeys = JSON.parse(resetLocalOverridesBtn.dataset.lockedEnvKeys);
        } catch (error) {
            console.warn('Failed to parse locked environment keys:', error);
        }
    }

    if (resetLocalOverridesBtn?.dataset?.lockedEnvDetails) {
        try {
            parsedLockedEnvDetails = JSON.parse(resetLocalOverridesBtn.dataset.lockedEnvDetails);
        } catch (error) {
            console.warn('Failed to parse locked environment details:', error);
        }
    }

    const overrideKeys = new Set(Array.isArray(parsedOverrideKeys) ? parsedOverrideKeys : []);
    const lockedEnvKeys = new Set(Array.isArray(parsedLockedEnvKeys) ? parsedLockedEnvKeys : []);
    if (overrideKeys.size === 0 && lockedEnvKeys.size === 0) {
        return;
    }

    const escapeHtml = (value) => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const fieldMappings = [
        { selector: '#paperlessUrl', envKey: 'PAPERLESS_API_URL' },
        { selector: '#paperlessPublicUrl', envKey: 'PAPERLESS_PUBLIC_URL' },
        { selector: '#paperlessToken', envKey: 'PAPERLESS_API_TOKEN' },
        { selector: '#paperlessUsername', envKey: 'PAPERLESS_USERNAME' },
        { selector: '#scanInterval', envKey: 'SCAN_INTERVAL' },
        { selector: '#useExistingData', envKey: 'USE_EXISTING_DATA' },
        { selector: '#showTags', envKey: 'PROCESS_PREDEFINED_DOCUMENTS' },
        { selector: '#ignoreTagInput', envKey: 'IGNORE_TAGS' },
        { selector: '#disableAutomaticProcessing', envKey: 'DISABLE_AUTOMATIC_PROCESSING' },
        { selector: '#aiProvider', envKey: 'AI_PROVIDER' },
        { selector: '#openaiKey', envKey: 'OPENAI_API_KEY' },
        { selector: '#openaiModel', envKey: 'OPENAI_MODEL' },
        { selector: '#ollamaUrl', envKey: 'OLLAMA_API_URL' },
        { selector: '#ollamaApiKey', envKey: 'OLLAMA_API_KEY' },
        { selector: '#ollamaModel', envKey: 'OLLAMA_MODEL' },
        { selector: '#customBaseUrl', envKey: 'CUSTOM_BASE_URL' },
        { selector: '#customApiKey', envKey: 'CUSTOM_API_KEY' },
        { selector: '#customModel', envKey: 'CUSTOM_MODEL' },
        { selector: '#azureEndpoint', envKey: 'AZURE_ENDPOINT' },
        { selector: '#azureApiKey', envKey: 'AZURE_API_KEY' },
        { selector: '#azureDeploymentName', envKey: 'AZURE_DEPLOYMENT_NAME' },
        { selector: '#azureApiVersion', envKey: 'AZURE_API_VERSION' },
        { selector: '#tokenLimit', envKey: 'TOKEN_LIMIT' },
        { selector: '#responseTokens', envKey: 'RESPONSE_TOKENS' },
        { selector: '#aiTemperatureAnalysis', envKey: 'AI_TEMPERATURE_ANALYSIS' },
        { selector: '#aiTemperatureGeneration', envKey: 'AI_TEMPERATURE_GENERATION' },
        { selector: '#aiProcessedTag', envKey: 'ADD_AI_PROCESSED_TAG' },
        { selector: '#aiTagName', envKey: 'AI_PROCESSED_TAG_NAME' },
        { selector: '#usePromptTags', envKey: 'USE_PROMPT_TAGS' },
        { selector: '#systemPrompt', envKey: 'SYSTEM_PROMPT' },
        { selector: '#restrictToExistingTags', envKey: 'RESTRICT_TO_EXISTING_TAGS' },
        { selector: '#restrictToExistingCorrespondents', envKey: 'RESTRICT_TO_EXISTING_CORRESPONDENTS' },
        { selector: '#restrictToExistingDocumentTypes', envKey: 'RESTRICT_TO_EXISTING_DOCUMENT_TYPES' },
        { selector: '#externalApiEnabled', envKey: 'EXTERNAL_API_ENABLED' },
        { selector: '#externalApiUrl', envKey: 'EXTERNAL_API_URL' },
        { selector: '#externalApiMethod', envKey: 'EXTERNAL_API_METHOD' },
        { selector: '#externalApiHeaders', envKey: 'EXTERNAL_API_HEADERS' },
        { selector: '#externalApiBody', envKey: 'EXTERNAL_API_BODY' },
        { selector: '#externalApiTimeout', envKey: 'EXTERNAL_API_TIMEOUT' },
        { selector: '#externalApiTransform', envKey: 'EXTERNAL_API_TRANSFORM' },
        { selector: '#activateTagging', envKey: 'ACTIVATE_TAGGING' },
        { selector: '#activateCorrespondents', envKey: 'ACTIVATE_CORRESPONDENTS' },
        { selector: '#activateDocumentType', envKey: 'ACTIVATE_DOCUMENT_TYPE' },
        { selector: '#activateTitle', envKey: 'ACTIVATE_TITLE' },
        { selector: '#activateCustomFields', envKey: 'ACTIVATE_CUSTOM_FIELDS' },
        { selector: '#customFieldsJson', envKey: 'CUSTOM_FIELDS' },
        { selector: '#mistralOcrEnabled', envKey: 'MISTRAL_OCR_ENABLED' },
        { selector: '#ocrProvider', envKey: 'OCR_PROVIDER' },
        { selector: '#ocrApiUrl', envKey: 'OCR_API_URL' },
        { selector: '#mistralApiKey', envKey: 'MISTRAL_API_KEY' },
        { selector: '#mistralOcrModel', envKey: 'MISTRAL_OCR_MODEL' },
        { selector: '#ocrValidationTimeout', envKey: 'SETUP_OCR_VALIDATION_TIMEOUT_MS', transform: (value) => String(Math.min(Math.max(Number.parseInt(String(value || '30').trim(), 10) || 30, 1), 7200) * 1000) },
        { selector: '#tagCacheTTL', envKey: 'TAG_CACHE_TTL_SECONDS' },
        { selector: '#globalRateLimitWindowMs', envKey: 'GLOBAL_RATE_LIMIT_WINDOW_MS' },
        { selector: '#globalRateLimitMax', envKey: 'GLOBAL_RATE_LIMIT_MAX' },
        { selector: '#trustProxy', envKey: 'TRUST_PROXY' },
        { selector: '#cookieSecureMode', envKey: 'COOKIE_SECURE_MODE' },
        { selector: '#minContentLength', envKey: 'MIN_CONTENT_LENGTH' },
        { selector: '#paperlessAiPort', envKey: 'PAPERLESS_AI_PORT' },
        { selector: '#externalApiAllowPrivateIps', envKey: 'EXTERNAL_API_ALLOW_PRIVATE_IPS' }
    ];

    const pills = [];

    fieldMappings.forEach(({ selector, envKey }) => {
        const fieldElement = document.querySelector(selector);
        if (!fieldElement) {
            return;
        }

        const container = fieldElement.closest('.space-y-2') || fieldElement.parentElement?.closest('.space-y-2');
        if (!container) {
            return;
        }

        const targetLabel = container.querySelector(`label[for="${fieldElement.id}"]`) || container.querySelector('label');
        if (!targetLabel) {
            return;
        }

        if (!targetLabel.classList.contains('flex')) {
            targetLabel.classList.add('flex', 'items-center', 'gap-2', 'flex-wrap');
        }

        if (overrideKeys.has(envKey) && !targetLabel.querySelector('.override-pill')) {
            const pill = document.createElement('span');
            pill.className = 'override-pill inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 cursor-help';
            pill.textContent = 'Overwritten';
            const overrideDetails = parsedOverrideDetails[envKey] || {};
            const injectedValue = overrideDetails.injected || '[unknown]';
            const overrideValue = overrideDetails.override || '[unknown]';
            pill.setAttribute('data-tooltip', [
                '<div style="font-size:12px;">',
                `<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(envKey)}</div>`,
                `<div><strong>.env:</strong> <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace;word-break:break-all;">${escapeHtml(injectedValue)}</span></div>`,
                `<div><strong>Override:</strong> <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace;word-break:break-all;">${escapeHtml(overrideValue)}</span></div>`,
                '</div>'
            ].join(''));
            targetLabel.appendChild(pill);
            pills.push(pill);
        }

        if (lockedEnvKeys.has(envKey)) {
            fieldElement.disabled = true;
            fieldElement.setAttribute('aria-disabled', 'true');
            fieldElement.classList.add('bg-gray-100', 'text-gray-500', 'cursor-not-allowed', 'opacity-70');

            if (!targetLabel.querySelector('.locked-pill')) {
                const lockedPill = document.createElement('span');
                lockedPill.className = 'locked-pill inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-200 text-slate-700 cursor-help';
                lockedPill.textContent = 'Managed by ENV';
                const lockedDetails = parsedLockedEnvDetails[envKey] || {};
                const managedValue = lockedDetails.managed || '[unknown]';
                lockedPill.setAttribute('data-tooltip', [
                    '<div style="font-size:12px;">',
                    `<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(envKey)}</div>`,
                    `<div><strong>Managed value:</strong> <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace;word-break:break-all;">${escapeHtml(managedValue)}</span></div>`,
                    '<div style="margin-top:4px;">Change this value in your container environment and restart the service.</div>',
                    '</div>'
                ].join(''));
                targetLabel.appendChild(lockedPill);
                pills.push(lockedPill);
            }

            let lockedHelpText = container.querySelector('.locked-env-help');
            if (!lockedHelpText) {
                lockedHelpText = document.createElement('p');
                lockedHelpText.className = 'locked-env-help text-xs text-slate-500';
                lockedHelpText.textContent = 'Managed by container environment. Change it in Docker Compose or your container environment, then restart the service.';
                container.appendChild(lockedHelpText);
            }
        }
    });

    if (pills.length > 0 && typeof tippy === 'function') {
        const instances = tippy(pills, getReadableTooltipOptions({
            maxWidth: 360,
            content(reference) {
                return createReadableTooltipContent(reference.getAttribute('data-tooltip') || 'Overwritten by local runtime settings.');
            }
        }));
        registerTooltipInstances(instances);
    }
}


// Custom Fields Management
function initializeCustomFieldsManagement() {
    // External API settings toggle
    const externalApiEnabled = document.getElementById('externalApiEnabled');
    const externalApiSettings = document.getElementById('externalApiSettings');
    
    if (externalApiEnabled && externalApiSettings) {
        externalApiEnabled.addEventListener('change', function() {
            if (this.checked) {
                externalApiSettings.classList.remove('hidden');
            } else {
                externalApiSettings.classList.add('hidden');
            }
        });
    }
    
    const fieldsList = document.getElementById('customFieldsList');
    if (fieldsList) {
        // Initialize Sortable
        new Sortable(fieldsList, {
            animation: 150,
            handle: '.cursor-move',
            onEnd: updateCustomFieldsJson
        });

        // Add initial theme classes based on current theme
        const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
        if (isDarkMode) {
            updateThemeClasses(true);
        }
    }

    // Initialize type selection
    const typeSelect = document.getElementById('newFieldType');
    if (typeSelect) {
        typeSelect.addEventListener('change', toggleCurrencySelect);
        // Initial currency select visibility
        toggleCurrencySelect();
    }

    // Initialize name input
    const nameInput = document.getElementById('newFieldName');
    if (nameInput) {
        nameInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addCustomField();
            }
        });
    }

    // Observer for theme changes
    const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            if (mutation.attributeName === 'data-theme') {
                const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
                updateThemeClasses(isDark);
            }
        });
    });

    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme']
    });
}

class MfaSettingsManager {
    constructor() {
        this.section = document.getElementById('mfaSettingsSection');
        if (!this.section) {
            return;
        }

        this.available = this.section.dataset.mfaAvailable === 'yes';
        this.enabled = this.section.dataset.mfaEnabled === 'yes';
        this.username = this.section.dataset.mfaUsername || '';

        this.statusBadge = document.getElementById('mfaStatusBadge');
        this.currentPasswordInput = document.getElementById('mfaCurrentPassword');
        this.tokenInput = document.getElementById('mfaToken');
        this.tokenHint = document.getElementById('mfaTokenHint');
        this.secretInput = document.getElementById('mfaSecretKey');
        this.uriInput = document.getElementById('mfaOtpAuthUri');
        this.qrImage = document.getElementById('mfaQrImage');
        this.provisioningBox = document.getElementById('mfaProvisioningBox');
        this.resultMessage = document.getElementById('mfaResultMessage');
        this.verifyBtnLabel = document.getElementById('mfaVerifyBtnLabel');
        this.copySecretBtn = document.getElementById('mfaCopySecretBtn');
        this.downloadQrBtn = document.getElementById('mfaDownloadQrBtn');

        this.enableBtn = document.getElementById('mfaEnableBtn');
        this.verifyBtn = document.getElementById('mfaVerifyBtn');
        this.disableBtn = document.getElementById('mfaDisableBtn');

        this.setupReady = false;
        this.invalidTotpAttempts = 0;

        this.initialize();
    }

    initialize() {
        if (!this.available) {
            return;
        }

        this.enableBtn?.addEventListener('click', () => this.enableMfa());
        this.verifyBtn?.addEventListener('click', () => this.verifyCode());
        this.disableBtn?.addEventListener('click', () => this.disableMfa());
        this.copySecretBtn?.addEventListener('click', () => this.copySecret());
        this.downloadQrBtn?.addEventListener('click', () => this.downloadQr());
        this.tokenInput?.addEventListener('input', () => this.clearTokenHint());

        this.refreshStatus();
        this.renderState();
    }

    setMessage(type, text) {
        if (!this.resultMessage) {
            return;
        }

        this.resultMessage.className = 'rounded-lg p-3 text-sm';
        if (type === 'success') {
            this.resultMessage.classList.add('theme-alert-success', 'border');
        } else if (type === 'error') {
            this.resultMessage.classList.add('theme-alert-error', 'border');
        } else {
            this.resultMessage.classList.add('bg-blue-50', 'text-blue-800', 'border', 'border-blue-200');
        }

        this.resultMessage.textContent = text;
        this.resultMessage.classList.remove('hidden');
    }

    clearMessage() {
        if (this.resultMessage) {
            this.resultMessage.classList.add('hidden');
        }
    }

    setTokenHint(type, text) {
        if (!this.tokenHint) {
            return;
        }

        this.tokenHint.className = 'text-xs';
        if (type === 'error') {
            this.tokenHint.classList.add('text-red-600');
            this.tokenInput?.classList.add('border-red-500', 'focus:border-red-500', 'focus:ring-red-500');
            this.tokenInput?.classList.remove('border-gray-300', 'focus:border-blue-500', 'focus:ring-blue-500');
        } else if (type === 'success') {
            this.tokenHint.classList.add('text-green-600');
            this.tokenInput?.classList.remove('border-red-500', 'focus:border-red-500', 'focus:ring-red-500');
            this.tokenInput?.classList.add('border-green-500', 'focus:border-green-500', 'focus:ring-green-500');
            this.tokenInput?.classList.remove('border-gray-300', 'focus:border-blue-500', 'focus:ring-blue-500');
        } else {
            this.tokenHint.classList.add('text-gray-500');
            this.tokenInput?.classList.remove('border-red-500', 'focus:border-red-500', 'focus:ring-red-500');
            this.tokenInput?.classList.remove('border-green-500', 'focus:border-green-500', 'focus:ring-green-500');
            this.tokenInput?.classList.add('border-gray-300', 'focus:border-blue-500', 'focus:ring-blue-500');
        }

        this.tokenHint.textContent = text;
        this.tokenHint.classList.remove('hidden');
    }

    clearTokenHint() {
        if (this.tokenHint) {
            this.tokenHint.classList.add('hidden');
        }
        this.tokenInput?.classList.remove('border-red-500', 'focus:border-red-500', 'focus:ring-red-500');
        this.tokenInput?.classList.remove('border-green-500', 'focus:border-green-500', 'focus:ring-green-500');
        this.tokenInput?.classList.add('border-gray-300', 'focus:border-blue-500', 'focus:ring-blue-500');
    }

    isInvalidTotpError(error) {
        return /invalid authentication code/i.test(String(error?.message || ''));
    }

    getMfaTroubleshootingUrl() {
        return 'https://paperless-ai-next.admon.me/getting-started/troubleshooting/#mfa-lockout-recovery';
    }

    handleInvalidTotpAttempt() {
        this.invalidTotpAttempts += 1;

        if (this.invalidTotpAttempts >= 3) {
            const troubleshootingUrl = this.getMfaTroubleshootingUrl();
            this.setTokenHint(
                'error',
                `Invalid or expired code (${this.invalidTotpAttempts} attempts). Recovery guide: ${troubleshootingUrl}`
            );
            this.setMessage(
                'error',
                `Authentication code is invalid. See troubleshooting: ${troubleshootingUrl}`
            );
            return;
        }

        this.setTokenHint('error', 'Invalid or expired code. Wait for the next code and check your device time.');
    }

    setLoading(button, loading, loadingText) {
        if (!button) {
            return;
        }

        if (loading) {
            if (!button.dataset.originalHtml) {
                button.dataset.originalHtml = button.innerHTML;
            }
            button.disabled = true;
            button.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${loadingText}</span>`;
            return;
        }

        button.disabled = false;
        if (button.dataset.originalHtml) {
            button.innerHTML = button.dataset.originalHtml;
        }
    }

    renderState() {
        if (!this.available) {
            return;
        }

        if (this.statusBadge) {
            this.statusBadge.textContent = this.enabled ? 'Enabled' : 'Disabled';
            this.statusBadge.className = `px-2 py-1 rounded-full text-xs font-semibold ${
                this.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'
            }`;
        }

        if (this.disableBtn) {
            this.disableBtn.disabled = !this.enabled;
        }

        if (this.enableBtn) {
            this.enableBtn.disabled = this.enabled;
        }

        if (this.verifyBtn) {
            this.verifyBtn.disabled = !this.enabled && !this.setupReady;
        }

        if (this.verifyBtnLabel) {
            this.verifyBtnLabel.textContent = this.enabled ? 'Validate Code' : 'Validate & Activate';
        }

        if (this.provisioningBox) {
            this.provisioningBox.classList.toggle('hidden', !this.setupReady || this.enabled);
        }

        if (this.copySecretBtn) {
            this.copySecretBtn.disabled = !this.setupReady || this.enabled;
        }

        if (this.downloadQrBtn) {
            this.downloadQrBtn.disabled = !this.setupReady || this.enabled || !this.qrImage?.src;
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

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Request failed.');
        }

        return data;
    }

    getCurrentPassword() {
        return String(this.currentPasswordInput?.value || '').trim();
    }

    getCurrentToken() {
        return String(this.tokenInput?.value || '').trim();
    }

    async refreshStatus() {
        if (!this.available) {
            return;
        }

        try {
            const response = await fetch('/api/settings/mfa/status');
            const result = await response.json();
            if (response.ok && result.success) {
                this.enabled = Boolean(result.enabled);
                this.username = result.username || this.username;
            }
        } catch (error) {
            console.warn('Unable to refresh MFA status:', error);
        } finally {
            this.renderState();
        }
    }

    async startSetup() {
        const password = this.getCurrentPassword();
        this.clearMessage();
        this.clearTokenHint();

        if (!password) {
            this.setMessage('error', 'Enter your current password to start MFA setup.');
            return;
        }

        this.setLoading(this.enableBtn, true, 'Starting...');
        try {
            const result = await this.request('/api/settings/mfa/setup', {
                currentPassword: password
            });

            if (this.secretInput) {
                this.secretInput.value = result.secret || '';
            }
            if (this.uriInput) {
                this.uriInput.value = result.otpauthUri || '';
            }
            if (this.qrImage) {
                this.qrImage.src = result.qrDataUrl || '';
                this.qrImage.classList.toggle('hidden', !result.qrDataUrl);
            }
            this.setupReady = true;
            this.setMessage('info', 'Setup started. Scan the QR code and then use Validate & Activate with your code.');
        } catch (error) {
            this.setupReady = false;
            if (this.qrImage) {
                this.qrImage.removeAttribute('src');
                this.qrImage.classList.add('hidden');
            }
            this.setMessage('error', error.message);
        } finally {
            this.setLoading(this.enableBtn, false);
            this.renderState();
        }
    }

    async enableMfa() {
        await this.startSetup();
    }

    async verifyCode() {
        const password = this.getCurrentPassword();
        const token = this.getCurrentToken();
        this.clearMessage();
        this.clearTokenHint();

        if (!token) {
            this.setMessage('error', 'Enter an authenticator code to validate.');
            this.setTokenHint('error', 'Please enter the 6-digit code from your authenticator app.');
            return;
        }

        if (!this.enabled && !this.setupReady) {
            this.setMessage('error', 'Click Enable MFA first to start setup and generate a QR code.');
            return;
        }

        this.setLoading(this.verifyBtn, true, 'Validating...');
        try {
            if (!this.enabled) {
                if (!password) {
                    this.setMessage('error', 'Enter your current password to complete activation.');
                    return;
                }

                const result = await this.request('/api/settings/mfa/enable', {
                    currentPassword: password,
                    token
                });
                this.enabled = true;
                this.setupReady = false;
                if (this.secretInput) {
                    this.secretInput.value = '';
                }
                if (this.uriInput) {
                    this.uriInput.value = '';
                }
                if (this.qrImage) {
                    this.qrImage.removeAttribute('src');
                    this.qrImage.classList.add('hidden');
                }
                if (this.tokenInput) {
                    this.tokenInput.value = '';
                }
                this.invalidTotpAttempts = 0;
                this.setTokenHint('success', 'Code accepted. MFA is now active.');
                this.setMessage('success', result.message || 'MFA enabled successfully.');
            } else {
                const result = await this.request('/api/settings/mfa/verify', { token });
                this.invalidTotpAttempts = 0;
                this.setTokenHint('success', 'Code is valid.');
                this.setMessage('success', result.message || 'Authentication code is valid.');
            }
        } catch (error) {
            if (this.isInvalidTotpError(error)) {
                this.handleInvalidTotpAttempt();
            } else {
                this.setTokenHint('error', 'Validation failed. Please try again.');
            }
            if (this.invalidTotpAttempts < 3 || !this.isInvalidTotpError(error)) {
                this.setMessage('error', error.message);
            }
        } finally {
            this.setLoading(this.verifyBtn, false);
            this.renderState();
        }
    }

    async disableMfa() {
        const password = this.getCurrentPassword();
        const token = this.getCurrentToken();
        this.clearMessage();
        this.clearTokenHint();

        if (!password || !token) {
            this.setMessage('error', 'Current password and authenticator code are required to disable MFA.');
            return;
        }

        const confirmResult = await Swal.fire({
            icon: 'warning',
            title: 'Disable MFA?',
            text: 'Your account will no longer require a TOTP code at login.',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            cancelButtonColor: '#3085d6',
            confirmButtonText: 'Disable MFA'
        });

        if (!confirmResult.isConfirmed) {
            return;
        }

        this.setLoading(this.disableBtn, true, 'Disabling...');
        try {
            const result = await this.request('/api/settings/mfa/disable', {
                currentPassword: password,
                token
            });
            this.invalidTotpAttempts = 0;
            this.enabled = false;
            this.setupReady = false;
            if (this.secretInput) {
                this.secretInput.value = '';
            }
            if (this.uriInput) {
                this.uriInput.value = '';
            }
            if (this.qrImage) {
                this.qrImage.removeAttribute('src');
                this.qrImage.classList.add('hidden');
            }
            if (this.tokenInput) {
                this.tokenInput.value = '';
            }
            this.setMessage('success', result.message || 'MFA disabled.');
        } catch (error) {
            if (this.isInvalidTotpError(error)) {
                this.handleInvalidTotpAttempt();
                if (this.invalidTotpAttempts >= 3) {
                    return;
                }
            }
            this.setMessage('error', error.message);
        } finally {
            this.setLoading(this.disableBtn, false);
            this.renderState();
        }
    }

    async copySecret() {
        this.clearMessage();

        if (!this.setupReady || this.enabled) {
            this.setMessage('error', 'Start MFA setup first to copy the secret.');
            return;
        }

        const secret = String(this.secretInput?.value || '').trim();
        if (!secret) {
            this.setMessage('error', 'No secret key available to copy.');
            return;
        }

        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(secret);
            } else {
                this.secretInput?.focus();
                this.secretInput?.select();
                const copied = document.execCommand('copy');
                if (!copied) {
                    throw new Error('Copy command was not accepted by the browser.');
                }
                this.secretInput?.setSelectionRange(0, 0);
                this.secretInput?.blur();
            }

            this.setMessage('success', 'Secret key copied to clipboard.');
        } catch (error) {
            this.setMessage('error', error.message || 'Unable to copy the secret key.');
        }
    }

    downloadQr() {
        this.clearMessage();

        if (!this.setupReady || this.enabled) {
            this.setMessage('error', 'Start MFA setup first to download the QR code.');
            return;
        }

        const qrDataUrl = String(this.qrImage?.src || '').trim();
        if (!qrDataUrl) {
            this.setMessage('error', 'No QR code available to download.');
            return;
        }

        try {
            const fileBase = this.username || 'paperless-ai-user';
            const fileName = `${fileBase}-mfa-qr.png`;
            const link = document.createElement('a');
            link.href = qrDataUrl;
            link.download = fileName;
            link.rel = 'noopener';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            this.setMessage('success', 'QR code downloaded.');
        } catch (error) {
            this.setMessage('error', error.message || 'Unable to download the QR code.');
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    normalizeSystemPromptNewlines();
    initializeCoreSettings();
    initializeFormHandlers();
    initializeTooltipAndValidation();
    initializeRuntimeOverridePills();
    initializePublicUrlStatus();
    initializeCustomFieldsManagement();
    new MfaSettingsManager();
});

function updateThemeClasses(isDark) {
    // Update custom field items
    const items = document.querySelectorAll('.custom-field-item');
    items.forEach(item => {
        // Background and border
        item.classList.toggle('bg-white', !isDark);
        item.classList.toggle('bg-gray-800', isDark);
        item.classList.toggle('border-gray-200', !isDark);
        item.classList.toggle('border-gray-700', isDark);

        // Text colors
        const title = item.querySelector('p.font-medium');
        if (title) {
            title.classList.toggle('text-gray-900', !isDark);
            title.classList.toggle('text-gray-100', isDark);
        }

        const subtitle = item.querySelector('p.text-sm');
        if (subtitle) {
            subtitle.classList.toggle('text-gray-500', !isDark);
            subtitle.classList.toggle('text-gray-400', isDark);
        }
    });

    // Update form inputs and selects
    const inputs = document.querySelectorAll('input:not([type="hidden"]), select');
    inputs.forEach(input => {
        input.classList.toggle('bg-white', !isDark);
        input.classList.toggle('bg-gray-800', isDark);
        input.classList.toggle('text-gray-900', !isDark);
        input.classList.toggle('text-gray-100', isDark);
        input.classList.toggle('border-gray-300', !isDark);
        input.classList.toggle('border-gray-600', isDark);
    });
}

function toggleCurrencySelect() {
    const fieldType = document.getElementById('newFieldType').value;
    const currencySelect = document.getElementById('currencyCode');
    
    if (fieldType === 'monetary') {
        currencySelect.classList.remove('hidden');
    } else {
        currencySelect.classList.add('hidden');
    }
}

function updateCustomFieldsJson() {
    const fieldItems = document.querySelectorAll('.custom-field-item');
    const fields = Array.from(fieldItems).map(item => {
        const fieldName = item.querySelector('p.font-medium').textContent;
        const typeText = item.querySelector('p.text-sm').textContent;
        const data_type = typeText.split('Type: ')[1].split(' ')[0];
        const currency = typeText.includes('(') ? typeText.split('(')[1].split(')')[0] : null;
        
        const field = {
            value: fieldName,
            data_type: data_type
        };
        
        if (currency) {
            field.currency = currency;
        }
        
        return field;
    });
    
    document.getElementById('customFieldsJson').value = JSON.stringify({
        custom_fields: fields
    });
}

function createFieldElement(fieldName, data_type, currency = null) {
    const div = document.createElement('div');
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    
    div.className = `custom-field-item flex items-center gap-2 p-3 rounded-lg border hover:border-blue-500 transition-colors ${
        isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
    }`;
    
    let typeDisplay = `Type: ${data_type}`;
    if (data_type === 'monetary' && currency) {
        typeDisplay += ` (${currency})`;
    }
    
    div.innerHTML = `
        <div class="cursor-move text-gray-400">
            <i class="fas fa-grip-vertical"></i>
        </div>
        <div class="flex-1">
            <p class="font-medium ${isDark ? 'text-gray-100' : 'text-gray-900'}">${fieldName}</p>
            <p class="text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}">${typeDisplay}</p>
        </div>
        <button type="button" 
                onclick="removeCustomField(this)"
                class="text-gray-400 hover:text-red-500 transition-colors">
            <i class="fas fa-trash"></i>
        </button>
    `;
    
    return div;
}

function addCustomField() {
    const nameInput = document.getElementById('newFieldName');
    const typeSelect = document.getElementById('newFieldType');
    const currencySelect = document.getElementById('currencyCode');
    const fieldsList = document.getElementById('customFieldsList');
    
    const fieldName = nameInput.value.trim();
    const data_type = typeSelect.value;
    const currency = data_type === 'monetary' ? currencySelect.value : null;
    
    if (!fieldName) {
        Swal.fire({
            icon: 'warning',
            title: 'Invalid Field Name',
            text: 'Please enter a field name'
        });
        return;
    }
    
    // Check for duplicates
    const existingFields = Array.from(fieldsList.querySelectorAll('p.font-medium'))
        .map(p => p.textContent);
    
    if (existingFields.includes(fieldName)) {
        Swal.fire({
            icon: 'warning',
            title: 'Duplicate Field',
            text: 'A field with this name already exists'
        });
        return;
    }
    
    const fieldElement = createFieldElement(fieldName, data_type, currency);
    fieldsList.appendChild(fieldElement);
    
    // Reset inputs
    nameInput.value = '';
    
    // Update hidden input
    updateCustomFieldsJson();
}

function removeCustomField(button) {
    const fieldItem = button.closest('.custom-field-item');
    Swal.fire({
        title: 'Delete Field?',
        text: 'Are you sure you want to delete this custom field?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'Yes, delete it!'
    }).then((result) => {
        if (result.isConfirmed) {
            fieldItem.remove();
            updateCustomFieldsJson();
        }
    });
}

// Clear Tag Cache Button Handler (PERF-002)
// duplicate clearTagCache handler removed (handled in main submit/event block above)
