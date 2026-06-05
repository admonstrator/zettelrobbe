const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { OpenAI } = require('openai');
const config = require('../config/config');
const AzureOpenAI = require('openai').AzureOpenAI;
const { validateApiUrl } = require('./serviceUtils');

const CUSTOM_PROVIDER_FALLBACK_API_KEY = 'no-auth-required';

class SetupService {
  constructor() {
    this.envPath = path.join(process.cwd(), 'data', '.env');
    this.runtimeOverridesPath = path.join(process.cwd(), 'data', 'runtime-overrides.json');
    this.configured = null; // Variable to store the configuration status

    const configuredTimeout = Number.parseInt(process.env.SETUP_VALIDATION_TIMEOUT_MS || '15000', 10);
    this.validationTimeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(Math.max(configuredTimeout, 1000), 120000)
      : 15000;
  }

  getValidationTimeoutMs() {
    return this.validationTimeoutMs;
  }

  async withValidationTimeout(promise, operationName) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${operationName} timed out after ${this.getValidationTimeoutMs()}ms`));
      }, this.getValidationTimeoutMs());
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  isLegacyConfigSourceMode() {
    return String(process.env.CONFIG_SOURCE_MODE || 'runtime-first').trim().toLowerCase() === 'legacy';
  }

  getRuntimeConfigurationSnapshot() {
    return {
      PAPERLESS_API_URL: process.env.PAPERLESS_API_URL || '',
      AI_PROVIDER: process.env.AI_PROVIDER || '',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      OLLAMA_API_URL: process.env.OLLAMA_API_URL || '',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || '',
      AZURE_ENDPOINT: process.env.AZURE_ENDPOINT || '',
      AZURE_API_KEY: process.env.AZURE_API_KEY || '',
      AZURE_DEPLOYMENT_NAME: process.env.AZURE_DEPLOYMENT_NAME || '',
      CUSTOM_BASE_URL: process.env.CUSTOM_BASE_URL || '',
      CUSTOM_MODEL: process.env.CUSTOM_MODEL || ''
    };
  }

  normalizeEnvironmentValue(value) {
    if (value == null) {
      return '';
    }

    if (Array.isArray(value)) {
      return value.map((entry) => String(entry ?? '').trim()).filter(Boolean).join(',');
    }

    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    return String(value);
  }

  encodeEnvValue(value) {
    // Quote values to prevent newline/equals injection in KEY=value format.
    return JSON.stringify(this.normalizeEnvironmentValue(value));
  }

  decodeEnvValue(value) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) {
      return '';
    }

    // Support values written as JSON-quoted strings.
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        const decoded = JSON.parse(trimmed);
        return decoded == null ? '' : String(decoded);
      } catch (_error) {
        return trimmed;
      }
    }

    // Compatibility with single-quoted env values.
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1);
    }

    return trimmed;
  }

  getSetupUrlValidationOptions() {
    const allowLocalhost = ['true', '1', 'yes', 'on'].includes(
      String(process.env.PAPERLESS_AI_SETUP_ALLOW_LOCALHOST || '').trim().toLowerCase()
    );

    return {
      allowPrivateIPs: true,
      allowLocalhost
    };
  }

  async loadRuntimeOverrides() {
    try {
      const content = await fs.readFile(this.runtimeOverridesPath, 'utf8');
      const parsed = JSON.parse(content);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Error loading runtime overrides:', error.message);
      }
      return {};
    }
  }

  filterProtectedInjectedConfig(configValues) {
    return Object.fromEntries(
      Object.entries(configValues || {}).filter(
        ([key]) => !config.isProtectedRuntimeEnvKey(key)
      )
    );
  }

  async saveRuntimeOverrides(configValues) {
    try {
      const dataDir = path.dirname(this.runtimeOverridesPath);
      await fs.mkdir(dataDir, { recursive: true });

      const persistentConfig = this.filterProtectedInjectedConfig(configValues);
      const normalizedConfig = Object.fromEntries(
        Object.entries(persistentConfig).map(([key, value]) => [key, value == null ? '' : String(value)])
      );

      await fs.writeFile(this.runtimeOverridesPath, JSON.stringify(normalizedConfig, null, 2));
    } catch (error) {
      console.error('Error saving runtime overrides:', error.message);
      throw error;
    }
  }

  async clearRuntimeOverrides() {
    try {
      await fs.unlink(this.runtimeOverridesPath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      console.error('Error clearing runtime overrides:', error.message);
      throw error;
    }
  }

  async loadConfig() {
    const runtimeOverrides = this.filterProtectedInjectedConfig(await this.loadRuntimeOverrides());

    if (!this.isLegacyConfigSourceMode()) {
      return Object.keys(runtimeOverrides).length > 0 ? runtimeOverrides : null;
    }

    try {
      const envContent = await fs.readFile(this.envPath, 'utf8');
      const configValues = {};
      envContent.split('\n').forEach((line) => {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
          return;
        }

        const separatorIndex = trimmedLine.indexOf('=');
        if (separatorIndex <= 0) {
          return;
        }

        const key = trimmedLine.slice(0, separatorIndex).trim();
        const value = trimmedLine.slice(separatorIndex + 1);
        if (!key) {
          return;
        }

        configValues[key] = this.decodeEnvValue(value);
      });
      return this.filterProtectedInjectedConfig({
        ...configValues,
        ...runtimeOverrides
      });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Error loading config:', error.message);
      }

      if (Object.keys(runtimeOverrides).length > 0) {
        return runtimeOverrides;
      }

      return null;
    }
  }

  async validatePaperlessConfig(url, token) {
    try {
      // Validate URL to prevent SSRF attacks
      // Allow private IPs since Paperless-ngx is typically deployed in a private network
      const urlValidation = await validateApiUrl(url, this.getSetupUrlValidationOptions());
      if (!urlValidation.valid) {
        console.error('Paperless URL validation error:', urlValidation.error);
        return false;
      }

      console.log('Validating Paperless config for:', url + '/api/documents/');
      const response = await axios.get(`${url}/api/documents/`, {
        headers: {
          'Authorization': `Token ${token}`
        }
      });
      return response.status === 200;
    } catch (error) {
      console.error('Paperless validation error:', error.message);
      return false;
    }
  }

  async validateApiPermissions(url, token) {
    // Validate URL first to prevent SSRF
    const urlValidation = await validateApiUrl(url, this.getSetupUrlValidationOptions());
    if (!urlValidation.valid) {
      console.error('API URL validation error:', urlValidation.error);
      return { success: false, message: `URL validation failed: ${urlValidation.error}` };
    }

    for (const endpoint of ['correspondents', 'tags', 'documents', 'document_types', 'custom_fields', 'users']) {
      try {
        console.log(`Validating API permissions for ${url}/api/${endpoint}/`);
        const response = await axios.get(`${url}/api/${endpoint}/`, {
          headers: {
            'Authorization': `Token ${token}`
          }
        });
        console.log(`API permissions validated for ${endpoint}, ${response.status}`);
        if (response.status !== 200) {
          console.error(`API permissions validation failed for ${endpoint}`);
          return { success: false, message: `API permissions validation failed for endpoint '/api/${endpoint}/'` };
        }
      } catch (error) {
        console.error(`API permissions validation failed for ${endpoint}:`, error.message);
        return { success: false, message: `API permissions validation failed for endpoint '/api/${endpoint}/'` };
      }
    }
    return { success: true, message: 'API permissions validated successfully' };
}


  async validateOpenAIConfig(apiKey) {
    if (config.CONFIGURED === false) {
      try {
        const openai = new OpenAI({ apiKey, timeout: this.getValidationTimeoutMs() });
        const response = await this.withValidationTimeout(
          openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "Test" }],
          }),
          'OpenAI validation'
        );
        const now = new Date();
        const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
        console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
        return response.choices && response.choices.length > 0;
      } catch (error) {
        console.error('OpenAI validation error:', error.message);
        return false;
      }
    }else{
      return true;
    }
  }

  async validateCustomConfig(url, apiKey, model) {
    // Validate URL to prevent SSRF attacks
    // Allow private IPs since custom AI services may be hosted internally
    const urlValidation = await validateApiUrl(url, this.getSetupUrlValidationOptions());
    if (!urlValidation.valid) {
      console.error('Custom AI URL validation error:', urlValidation.error);
      return false;
    }

    const customClientConfig = {
      baseURL: url,
      // OpenAI-compatible SDKs expect an apiKey option even for endpoints without auth.
      apiKey: apiKey || CUSTOM_PROVIDER_FALLBACK_API_KEY,
      model: model
    };
    console.log('Custom AI config:', {
      baseURL: customClientConfig.baseURL,
      apiKey: customClientConfig.apiKey ? '[REDACTED]' : '',
      model: customClientConfig.model
    });
    try {
      const openai = new OpenAI({ 
        apiKey: customClientConfig.apiKey,
        baseURL: customClientConfig.baseURL,
        timeout: this.getValidationTimeoutMs(),
      });
      const completion = await this.withValidationTimeout(
        openai.chat.completions.create({
          messages: [{ role: "user", content: "Test" }],
          model: customClientConfig.model,
        }),
        'Custom AI validation'
      );
      return completion.choices && completion.choices.length > 0;
    } catch (error) {
      console.error('Custom AI validation error:', error.message);
      return false;
    }
  }



  async validateOllamaConfig(url, model) {
    try {
      // Validate URL to prevent SSRF attacks
      // Allow private IPs since Ollama is typically hosted locally
      const urlValidation = await validateApiUrl(url, this.getSetupUrlValidationOptions());
      if (!urlValidation.valid) {
        console.error('Ollama URL validation error:', urlValidation.error);
        return false;
      }

      const response = await this.withValidationTimeout(
        axios.post(
          `${url}/api/generate`,
          {
            model: model || 'llama3.2',
            prompt: 'Test',
            stream: false
          },
          {
            timeout: this.getValidationTimeoutMs()
          }
        ),
        'Ollama validation'
      );
      return response.data && response.data.response;
    } catch (error) {
      console.error('Ollama validation error:', error.message);
      return false;
    }
  }

  async validateAzureConfig(apiKey, endpoint, deploymentName, apiVersion) {
    console.log('Endpoint: ', endpoint);
    
    // Validate Azure endpoint URL to prevent SSRF attacks
    if (endpoint) {
      const urlValidation = await validateApiUrl(endpoint, { allowPrivateIPs: false });
      if (!urlValidation.valid) {
        console.error('Azure endpoint URL validation error:', urlValidation.error);
        return false;
      }
    }

    if (config.CONFIGURED === false) {
      try {
        const openai = new AzureOpenAI({ apiKey: apiKey,
                endpoint: endpoint,
                deploymentName: deploymentName,
                apiVersion: apiVersion,
                timeout: this.getValidationTimeoutMs() });
        const response = await this.withValidationTimeout(
          openai.chat.completions.create({
            model: deploymentName,
            messages: [{ role: "user", content: "Test" }],
          }),
          'Azure validation'
        );
        const now = new Date();
        const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
        console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
        return response.choices && response.choices.length > 0;
      } catch (error) {
        console.error('OpenAI validation error:', error.message);
        return false;
      }
    }else{
      return true;
    }
  }

  extractOpenAiModelIds(payload) {
    const candidates = Array.isArray(payload?.data) ? payload.data : [];
    return candidates
      .map((entry) => String(entry?.id || '').trim())
      .filter(Boolean);
  }

  extractOllamaModelIds(payload) {
    const candidates = Array.isArray(payload?.models) ? payload.models : [];
    return candidates
      .map((entry) => String(entry?.name || '').trim())
      .filter(Boolean);
  }

  async fetchOpenAiCompatibleModels(apiUrl, apiKey = '', options = {}) {
    const normalizedApiUrl = String(apiUrl || '').replace(/\/+$/, '');
    const urlValidation = await validateApiUrl(normalizedApiUrl, options);
    if (!urlValidation.valid) {
      throw new Error(`Model URL validation failed: ${urlValidation.error}`);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await this.withValidationTimeout(
      axios.get(`${normalizedApiUrl}/models`, {
        headers,
        timeout: this.getValidationTimeoutMs()
      }),
      'OpenAI-compatible model discovery'
    );

    if (response.status !== 200) {
      return [];
    }

    return this.extractOpenAiModelIds(response.data);
  }

  async fetchOllamaModels(apiUrl, apiKey = '', options = {}) {
    const normalizedApiUrl = String(apiUrl || '').replace(/\/+$/, '');
    const urlValidation = await validateApiUrl(normalizedApiUrl, options);
    if (!urlValidation.valid) {
      throw new Error(`Model URL validation failed: ${urlValidation.error}`);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await this.withValidationTimeout(
      axios.get(`${normalizedApiUrl}/api/tags`, {
        headers,
        timeout: this.getValidationTimeoutMs()
      }),
      'Ollama model discovery'
    );

    if (response.status !== 200) {
      return [];
    }

    return this.extractOllamaModelIds(response.data);
  }

  dedupeModelIds(models = []) {
    const seen = new Set();
    const deduped = [];

    models.forEach((model) => {
      const normalized = String(model || '').trim();
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      deduped.push(normalized);
    });

    return deduped;
  }

  async discoverAiModels(options = {}) {
    const provider = String(options.provider || '').trim().toLowerCase();
    const apiUrl = String(options.apiUrl || '').trim();
    const apiKey = String(options.apiKey || '').trim();

    if (!provider || !['openai', 'ollama', 'custom', 'azure'].includes(provider)) {
      throw new Error('A valid AI provider is required for model discovery');
    }

    if (provider === 'azure') {
      return [];
    }

    if (provider === 'openai') {
      const targetUrl = (apiUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      return this.fetchOpenAiCompatibleModels(targetUrl, apiKey, { allowPrivateIPs: false, allowLocalhost: false });
    }

    if (!apiUrl) {
      throw new Error('API URL is required for model discovery');
    }

    if (provider === 'ollama') {
      const models = await this.fetchOllamaModels(apiUrl, apiKey, this.getSetupUrlValidationOptions());
      return this.dedupeModelIds(models);
    }

    const normalizedBase = apiUrl.replace(/\/+$/, '');
    const localValidationOptions = this.getSetupUrlValidationOptions();
    const isOpenAiLike = /\/v1$/i.test(normalizedBase);
    const attempts = isOpenAiLike
      ? [() => this.fetchOpenAiCompatibleModels(normalizedBase, apiKey, localValidationOptions)]
      : [
        () => this.fetchOllamaModels(normalizedBase, apiKey, localValidationOptions),
        () => this.fetchOpenAiCompatibleModels(normalizedBase, apiKey, localValidationOptions)
      ];

    const allModels = [];
    for (const attempt of attempts) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const models = await attempt();
        allModels.push(...models);
      } catch (_error) {
        // Try next provider flavor for custom endpoints.
      }
    }

    return this.dedupeModelIds(allModels);
  }

  async discoverOcrModels(options = {}) {
    const providerInput = String(options.provider || 'mistral').trim().toLowerCase();
    const provider = providerInput === 'custom' ? 'ollama' : providerInput;
    const apiUrl = String(options.apiUrl || '').trim();
    const apiKey = String(options.apiKey || '').trim();

    if (!['mistral', 'ollama'].includes(provider)) {
      throw new Error('A valid OCR provider is required for model discovery');
    }

    if (provider === 'mistral') {
      const targetUrl = (apiUrl || 'https://api.mistral.ai/v1').replace(/\/+$/, '');
      if (!apiKey) {
        throw new Error('API key is required for Mistral OCR model discovery');
      }

      return this.fetchOpenAiCompatibleModels(targetUrl, apiKey, { allowPrivateIPs: false, allowLocalhost: false });
    }

    const targetUrl = (apiUrl || 'http://localhost:11434').replace(/\/+$/, '');
    const validationOptions = this.getSetupUrlValidationOptions();
    const isOpenAiLike = /\/v1$/i.test(targetUrl);
    const attempts = isOpenAiLike
      ? [() => this.fetchOpenAiCompatibleModels(targetUrl, apiKey, validationOptions)]
      : [
        () => this.fetchOllamaModels(targetUrl, apiKey, validationOptions),
        () => this.fetchOpenAiCompatibleModels(targetUrl, apiKey, validationOptions)
      ];

    const allModels = [];
    for (const attempt of attempts) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const models = await attempt();
        allModels.push(...models);
      } catch (_error) {
        // Try next local provider flavor.
      }
    }

    return this.dedupeModelIds(allModels);
  }

  getOcrValidationToken() {
    return 'OCR-TEST-182730173401';
  }

  buildOcrValidationImageDataUrl(token) {
    const safeToken = String(token || this.getOcrValidationToken()).trim() || this.getOcrValidationToken();
    const fallbackToken = this.getOcrValidationToken();
    const normalizedToken = this.normalizeOcrValidationText(safeToken);
    const normalizedFallbackToken = this.normalizeOcrValidationText(fallbackToken);
    if (normalizedToken !== normalizedFallbackToken) {
      throw new Error('OCR validation image supports only the default validation token');
    }

    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAjcAAADyCAYAAACxkuSAAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAAEnQAABJ0Ad5mH3gAABH8SURBVHhe7d2NkeTEsgZQXMAGXMAHTMCG6wIe4AEeYAEW4AAO4AE+7Iskom7kzaeSqqReZsg+J6KC3elu/dTvJ6ln+eYLAEAj39QfAAD8mwk3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcLPojz/++PLTTz99+eGHH7588803/y3ffvvt3z/75Zdfvvz555/1Y9t+//33y/389ddf9WP/z88///w/n18p33333dY+VtR93C1xXK/ebtT1lV9//fXLjz/++Hfd5M/G3+Pn8fpZXcU+6n7vlmjTV4pjj+3Wur0S5xt99Pvvv//vsUX/HPWxKrYT74/9x+fHtnLdzjyt1zPjmPL774yLeG+02VE9/fbbb/XtW2KuWTmXUM99p5yNkXgtziW3XZxr9I1XzIWx7bHdVbHf//znP/8zXuPP8bOYw5+4O174GOu95k3FgKgT3VmJQbQzAQ4xUdQF9KxcLXR3wk0uMWE9nYBD3e7dUieU+vqdcjZxx7mvtkfUVSx8R54uwrlctfmOWATGolTr9kzUS17MjkoscFdjIMbVSv3GsR1t62m9Hon95CByVOKYVxbJlfOLxfvo3Fbk47xS97tTZmMk5rn63lyij5yF0yvRz/L2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GEBjH/mLrrmcTYpPFs161bXyLPuOV4WbOL44x91yNAmGfGchl2jn8dmj9phN9meetNNTu/uN99X6GGMh/lvHwdHiX+861jY5K2d1m4/tTmCqgSP+HONyNv7Orvzr+Ik/j3qq32s7u9NwJp/vjtzfZv3/TL1LOc5hzFW1j8yC4oqdc6x31KIvjmOqx7vy6PHI+HwcF5/fda95czHp1QF7VmLSuzOYY8DlCfGsxMC9Ck9PF838+Sh3J4Qzrwo3d8tZvRzdiTsrV4vvzNN2euLOfmfBL5fox0fBOz8SuVPO+nweo2fvO1PvOMzKSiioYemoRCi4M1eEnYU/y/3tKHyuiGNemRPjPXfPL+ye49HFaC13zznk8+LzW+s1/D1Z5d+qGGVcfcbif+dWZxYTQQzQmPTq1UZMuvHzo0XjyCsWzZ3vD93xmcPNECEnAmtt9/H56BN3F9Pwina66+5+YyxEndQ+GtuJ85n1k9reu+WsnnMome1/xRiDtb3HHdudbce26p2DGEc743hmd+Ef8l3ip8cQYyPOJYe4aIfYx1lbrbpzjtE+9W76q45pbG93vPAx1nsNAMC/gHADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC0ItwAAK0INwBAK8INANCKcAMAtCLcAACtCDcAQCvCDQDQinADALQi3AAArQg3AEArwg0A0IpwAwC08n+R60Y7CZHn/AAAAABJRU5ErkJggg==';

    return `data:image/png;base64,${pngBase64}`;
  }

  normalizeOcrValidationText(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  isExpectedOcrTokenPresent(value, expectedToken) {
    const normalizedOutput = this.normalizeOcrValidationText(value);
    const normalizedExpected = this.normalizeOcrValidationText(expectedToken);
    if (!normalizedOutput || !normalizedExpected) {
      return false;
    }

    return normalizedOutput.includes(normalizedExpected);
  }

  async runMistralOcrValidationRequest({ apiUrl, apiKey, model, imageDataUrl }) {
    const response = await this.withValidationTimeout(
      axios.post(
        `${apiUrl}/ocr`,
        {
          model,
          document: {
            type: 'document_url',
            document_url: imageDataUrl
          },
          include_image_base64: false
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: this.getValidationTimeoutMs()
        }
      ),
      'Mistral OCR content validation'
    );

    const pages = Array.isArray(response.data?.pages) ? response.data.pages : [];
    return pages.map((page) => String(page?.markdown || '')).join('\n').trim();
  }

  async runLocalOcrValidationRequest({ apiUrl, apiKey, model, imageDataUrl }) {
    const normalizedApiUrl = String(apiUrl || '').replace(/\/+$/, '');
    const headers = {
      'Content-Type': 'application/json'
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const prompt = 'Read the token in this image and return only that token without extra words.';
    const isOpenAiCompatible = /\/v1$/i.test(normalizedApiUrl);
    const imageBase64 = String(imageDataUrl || '').replace(/^data:image\/[^;]+;base64,/, '');

    const runOpenAiLikeRequest = async (imageUrlValue) => this.withValidationTimeout(
      axios.post(
        `${normalizedApiUrl}/chat/completions`,
        {
          model,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: prompt
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageUrlValue
                  }
                }
              ]
            }
          ]
        },
        {
          headers,
          timeout: this.getValidationTimeoutMs()
        }
      ),
      'Local OCR OpenAI-compatible content validation'
    );

    const response = isOpenAiCompatible
      ? await (async () => {
        try {
          return await runOpenAiLikeRequest(imageDataUrl);
        } catch (error) {
          const providerMessage = String(
            error?.response?.data?.error?.message
            || error?.response?.data?.message
            || error?.message
            || ''
          ).toLowerCase();

          // Some OpenAI-compatible vision endpoints require raw base64 in `image_url.url`.
          if (providerMessage.includes('url') && providerMessage.includes('base64') && imageBase64) {
            return runOpenAiLikeRequest(imageBase64);
          }

          throw error;
        }
      })()
      : await this.withValidationTimeout(
        axios.post(
          `${normalizedApiUrl}/api/chat`,
          {
            model,
            stream: false,
            messages: [
              {
                role: 'user',
                content: prompt,
                images: [imageBase64]
              }
            ],
            options: {
              temperature: 0
            }
          },
          {
            headers,
            timeout: this.getValidationTimeoutMs()
          }
        ),
        'Local OCR Ollama content validation'
      );

    return isOpenAiCompatible
      ? String(response.data?.choices?.[0]?.message?.content || '').trim()
      : String(response.data?.message?.content || '').trim();
  }

  async validateOcrConfig(options = {}) {
    const enabled = String(options.enabled || 'no').trim().toLowerCase() === 'yes';
    if (!enabled) {
      return true;
    }

    const providerInput = String(options.provider || 'mistral').trim().toLowerCase();
    const provider = providerInput === 'custom' ? 'ollama' : providerInput;
    const model = String(options.model || '').trim();
    const apiKey = String(options.apiKey || '').trim();
    const configuredApiUrl = String(options.apiUrl || '').trim();

    if (!['mistral', 'ollama'].includes(provider)) {
      console.error('OCR validation error: unsupported provider', provider);
      return false;
    }

    if (!model) {
      console.error('OCR validation error: missing OCR model');
      return false;
    }

    if (provider === 'mistral') {
      const apiUrl = (configuredApiUrl || 'https://api.mistral.ai/v1').replace(/\/+$/, '');
      if (!apiKey) {
        console.error('OCR validation error: missing Mistral API key');
        return false;
      }

      const urlValidation = await validateApiUrl(apiUrl, { allowPrivateIPs: false, allowLocalhost: false });
      if (!urlValidation.valid) {
        console.error('Mistral OCR URL validation error:', urlValidation.error);
        return false;
      }

      try {
        const modelsResponse = await this.withValidationTimeout(
          axios.get(`${apiUrl}/models`, {
            headers: {
              'Authorization': `Bearer ${apiKey}`
            },
            timeout: this.getValidationTimeoutMs()
          }),
          'Mistral OCR validation'
        );
        if (modelsResponse.status !== 200) {
          return false;
        }

        const token = this.getOcrValidationToken();
        const imageDataUrl = this.buildOcrValidationImageDataUrl(token);
        const ocrOutput = await this.runMistralOcrValidationRequest({
          apiUrl,
          apiKey,
          model,
          imageDataUrl
        });

        if (!this.isExpectedOcrTokenPresent(ocrOutput, token)) {
          console.error('Mistral OCR validation error: OCR output did not match expected token');
          return false;
        }

        return true;
      } catch (error) {
        console.error('Mistral OCR validation error:', error.message);
        return false;
      }
    }

    const apiUrl = (configuredApiUrl || 'http://localhost:11434').replace(/\/+$/, '');
    const urlValidation = await validateApiUrl(apiUrl, this.getSetupUrlValidationOptions());
    if (!urlValidation.valid) {
      console.error('Local OCR URL validation error:', urlValidation.error);
      return false;
    }

    const isOpenAiCompatible = /\/v1$/i.test(apiUrl);
    const targetUrl = isOpenAiCompatible
      ? `${apiUrl}/models`
      : `${apiUrl}/api/tags`;

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    try {
      const response = await this.withValidationTimeout(
        axios.get(targetUrl, {
          headers,
          timeout: this.getValidationTimeoutMs()
        }),
        isOpenAiCompatible ? 'Local OCR OpenAI-compatible validation' : 'Local OCR Ollama validation'
      );
      if (response.status !== 200) {
        return false;
      }

      const token = this.getOcrValidationToken();
      const imageDataUrl = this.buildOcrValidationImageDataUrl(token);
      const ocrOutput = await this.runLocalOcrValidationRequest({
        apiUrl,
        apiKey,
        model,
        imageDataUrl
      });

      if (!this.isExpectedOcrTokenPresent(ocrOutput, token)) {
        console.error('Local OCR validation error: OCR output did not match expected token');
        return false;
      }

      return true;
    } catch (error) {
      console.error('Local OCR validation error:', error.message);
      return false;
    }
  }

  async validateConfig(config) {
    // Validate Paperless config
    const paperlessApiUrl = (config.PAPERLESS_API_URL || '').replace(/\/+$/, '').replace(/\/api$/, '');
    const paperlessValid = await this.validatePaperlessConfig(
      paperlessApiUrl,
      config.PAPERLESS_API_TOKEN
    );
    
    if (!paperlessValid) {
      throw new Error('Invalid Paperless configuration');
    }

    // Validate AI provider config
    const aiProvider = config.AI_PROVIDER || 'openai';

    console.log('AI provider:', aiProvider);
    
    if (aiProvider === 'openai') {
      const openaiValid = await this.validateOpenAIConfig(config.OPENAI_API_KEY);
      if (!openaiValid) {
        throw new Error('Invalid OpenAI configuration');
      }
    } else if (aiProvider === 'ollama') {
      const ollamaValid = await this.validateOllamaConfig(
        config.OLLAMA_API_URL || 'http://localhost:11434',
        config.OLLAMA_MODEL
      );
      if (!ollamaValid) {
        throw new Error('Invalid Ollama configuration');
      }
    } else if (aiProvider === 'custom') {
      const customValid = await this.validateCustomConfig(
        config.CUSTOM_BASE_URL,
        config.CUSTOM_API_KEY,
        config.CUSTOM_MODEL
      );
      if (!customValid) {
        throw new Error('Invalid Custom AI configuration');
      }
    } else if (aiProvider === 'azure') {
      const azureValid = await this.validateAzureConfig(
        config.AZURE_API_KEY,
        config.AZURE_ENDPOINT,
        config.AZURE_DEPLOYMENT_NAME,
        config.AZURE_API_VERSION
      );
      if (!azureValid) {
        throw new Error('Invalid Azure configuration');
      }
    }


    return true;
  }

  async saveConfig(configValues, options = {}) {
    try {
      // Validate the new configuration before saving unless explicitly skipped
      if (!options.skipValidation) {
        await this.validateConfig(configValues);
      }

      const JSON_STANDARD_PROMPT = `
        Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:
        
        {
          "title": "xxxxx",
          "correspondent": "xxxxxxxx",
          "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
          "document_date": "YYYY-MM-DD",
          "language": "en/de/es/..."
        }`;

      // Ensure data directory exists
      const dataDir = path.dirname(this.envPath);
      await fs.mkdir(dataDir, { recursive: true });

      const persistentConfig = this.filterProtectedInjectedConfig(configValues);

      if (this.isLegacyConfigSourceMode()) {
        const envContent = Object.entries(persistentConfig)
          .map(([key, value]) => `${key}=${this.encodeEnvValue(value)}`)
          .join('\n');

        await fs.writeFile(this.envPath, envContent);
      }

      await this.saveRuntimeOverrides(configValues);
      
      // Reload environment variables
      Object.entries(persistentConfig).forEach(([key, value]) => {
        process.env[key] = this.normalizeEnvironmentValue(value);
      });
    } catch (error) {
      console.error('Error saving config:', error.message);
      throw error;
    }
  }

  hasRequiredConfiguration(config) {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const paperlessApiUrl = String(config.PAPERLESS_API_URL || '').trim();
    const aiProvider = String(config.AI_PROVIDER || '').trim().toLowerCase();
    if (!paperlessApiUrl || !aiProvider) {
      return false;
    }

    if (aiProvider === 'openai') {
      return Boolean(String(config.OPENAI_API_KEY || '').trim());
    }

    if (aiProvider === 'ollama') {
      return Boolean(String(config.OLLAMA_API_URL || '').trim()) && Boolean(String(config.OLLAMA_MODEL || '').trim());
    }

    if (aiProvider === 'azure') {
      return Boolean(String(config.AZURE_ENDPOINT || '').trim())
        && Boolean(String(config.AZURE_API_KEY || '').trim())
        && Boolean(String(config.AZURE_DEPLOYMENT_NAME || '').trim());
    }

    if (aiProvider === 'custom') {
      return Boolean(String(config.CUSTOM_BASE_URL || '').trim()) && Boolean(String(config.CUSTOM_MODEL || '').trim());
    }

    return false;
  }

  async isDatabaseHealthy() {
    try {
      // Attempt a non-intrusive read from the users table to validate database health
      const documentModel = require('../models/document.js');
      const users = await documentModel.getUsers();
      // If we can query without error, database is healthy
      return Array.isArray(users);
    } catch (error) {
      console.error('[SECURITY] Database health check failed:', error.message);
      return false;
    }
  }

  async getSetupState() {
    try {
      if (this.isLegacyConfigSourceMode()) {
        // Legacy mode depends on data/.env as the persisted source.
        try {
          await fs.access(this.envPath, fs.constants.F_OK);
        } catch {
          return 'first-run';
        }
      }

      // Runtime-first mode derives configuration from runtime env + overrides.
      const config = await this.loadConfig();
      const effectiveConfig = {
        ...this.getRuntimeConfigurationSnapshot(),
        ...(config || {})
      };
      const isConfigComplete = this.hasRequiredConfiguration(effectiveConfig);

      if (!isConfigComplete) {
        return 'partial';
      }

      // Configuration is complete, check database health
      const dbHealthy = await this.isDatabaseHealthy();

      if (!dbHealthy) {
        console.warn('[SECURITY] Setup state: degraded (config exists, database unhealthy)');
        return 'degraded';
      }

      // All checks passed
      return 'configured';
    } catch (error) {
      console.error('[SECURITY] Error determining setup state:', error.message);
      // Conservative: treat unexpected errors as degraded
      return 'degraded';
    }
  }

  async isConfigured() {
    if (this.configured !== null) {
      return this.configured;
    }

    try {
      if (this.isLegacyConfigSourceMode()) {
        try {
          await fs.access(this.envPath, fs.constants.F_OK);
        } catch (_err) {
          console.log('No .env file found. Starting setup process...');
          this.configured = false;
          return false;
        }
      }

      const config = await this.loadConfig();
      const effectiveConfig = {
        ...this.getRuntimeConfigurationSnapshot(),
        ...(config || {})
      };
      if (!this.hasRequiredConfiguration(effectiveConfig)) {
        console.log('Required configuration is incomplete. Starting setup process...');
        this.configured = false;
        return false;
      }

      this.configured = true;
      return true;
    } catch (error) {
      console.error('Error checking initial configuration:', error.message);
      this.configured = false;
      return false;
    }
  }
}

module.exports = new SetupService();
