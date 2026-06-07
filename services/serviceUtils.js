const tiktoken = require('tiktoken');
const fs = require('fs').promises;
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { parseISO, isValid } = require('date-fns');

// Map non-OpenAI models to compatible OpenAI encodings or use estimation
function getCompatibleModel(model) {
    const openaiModels = [
        // GPT-4o family
        'gpt-4o', 'chatgpt-4o-latest', 'gpt-4o-mini', 'gpt-4o-audio-preview',
        'gpt-4o-audio-preview-2024-12-17', 'gpt-4o-audio-preview-2024-10-01',
        'gpt-4o-mini-audio-preview', 'gpt-4o-mini-audio-preview-2024-12-17',
        
        // GPT-4.1 family
        'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
        
        // GPT-3.5 family
        'gpt-3.5-turbo', 'gpt-3.5-turbo-16k', 'gpt-3.5-turbo-instruct',
        
        // GPT-4 family
        'gpt-4', 'gpt-4-32k', 'gpt-4-1106-preview', 'gpt-4-0125-preview',
        'gpt-4-turbo-2024-04-09', 'gpt-4-turbo', 'gpt-4-turbo-preview',
        
        // GPT-4.5 family
        'gpt-4.5-preview-2025-02-27', 'gpt-4.5-preview', 'gpt-4.5',
        
        // O-series models
        'o1', 'o1-2024-12-17', 'o1-preview', 'o1-mini', 'o3-mini', 'o3', 'o4-mini',
        
        // Legacy models that tiktoken might support
        'text-davinci-003', 'text-davinci-002'
    ];
    
    // If it's a known OpenAI model, return as-is
    if (openaiModels.some(openaiModel => model.includes(openaiModel))) {
        return model;
    }
    
    // For all other models (Llama, Claude, etc.), return null to use estimation
    return null;
}

// Estimate tokens for non-OpenAI models using character-based approximation
function estimateTokensForNonOpenAI(text) {
    // Rough approximation: 1 token ≈ 4 characters for most models
    // This is conservative and works reasonably well for Llama models
    return Math.ceil(text.length / 4);
}

// Calculate tokens for a given text
async function calculateTokens(text, model = process.env.OPENAI_MODEL || "gpt-4o-mini") {
    try {
        const compatibleModel = getCompatibleModel(model);
        
        if (!compatibleModel) {
            // Non-OpenAI model - use character-based estimation
            console.log(`[DEBUG] Using character-based token estimation for model: ${model}`);
            return estimateTokensForNonOpenAI(text);
        }
        
        // OpenAI model - use tiktoken
        const tokenizer = tiktoken.encoding_for_model(compatibleModel);
        const tokens = tokenizer.encode(text);
        const tokenCount = tokens.length;
        tokenizer.free();
        
        return tokenCount;
        
    } catch (error) {
        console.warn(`[WARNING] Tiktoken failed for model ${model}, falling back to character estimation:`, error.message);
        return estimateTokensForNonOpenAI(text);
    }
}

// Calculate total tokens for a system prompt and additional prompts
async function calculateTotalPromptTokens(systemPrompt, additionalPrompts = [], model = process.env.OPENAI_MODEL || "gpt-4o-mini") {
    let totalTokens = 0;

    // Count tokens for system prompt
    totalTokens += await calculateTokens(systemPrompt, model);

    // Count tokens for additional prompts
    for (const prompt of additionalPrompts) {
        if (prompt) { // Only count if prompt exists
            totalTokens += await calculateTokens(prompt, model);
        }
    }

    // Add tokens for message formatting (approximately 4 tokens per message)
    const messageCount = 1 + additionalPrompts.filter(p => p).length; // Count system + valid additional prompts
    totalTokens += messageCount * 4;

    return totalTokens;
}

// Truncate text to fit within token limit
async function truncateToTokenLimit(text, maxTokens, model = process.env.OPENAI_MODEL || "gpt-4o-mini") {
    try {
        const compatibleModel = getCompatibleModel(model);
        
        if (!compatibleModel) {
            // Non-OpenAI model - use character-based estimation
            console.log(`[DEBUG] Using character-based truncation for model: ${model}`);
            
            const estimatedTokens = estimateTokensForNonOpenAI(text);
            
            if (estimatedTokens <= maxTokens) {
                return text;
            }
            
            // Truncate based on character estimation (conservative approach)
            const maxChars = maxTokens * 4; // 4 chars per token approximation
            const truncatedText = text.substring(0, maxChars);
            
            // Try to break at a word boundary if possible
            const lastSpaceIndex = truncatedText.lastIndexOf(' ');
            if (lastSpaceIndex > maxChars * 0.8) { // Only if we don't lose too much text
                return truncatedText.substring(0, lastSpaceIndex);
            }
            
            return truncatedText;
        }
        
        // OpenAI model - use tiktoken
        const tokenizer = tiktoken.encoding_for_model(compatibleModel);
        const tokens = tokenizer.encode(text);
      
        if (tokens.length <= maxTokens) {
            tokenizer.free();
            return text;
        }
      
        const truncatedTokens = tokens.slice(0, maxTokens);
        const truncatedText = tokenizer.decode(truncatedTokens);
        tokenizer.free();
        
        // No need for TextDecoder here, tiktoken.decode() returns a string
        return truncatedText;
        
    } catch (error) {
        console.warn(`[WARNING] Token truncation failed for model ${model}, falling back to character estimation:`, error.message);
        
        // Fallback to character-based estimation
        const estimatedTokens = estimateTokensForNonOpenAI(text);
        
        if (estimatedTokens <= maxTokens) {
            return text;
        }
        
        const maxChars = maxTokens * 4;
        const truncatedText = text.substring(0, maxChars);
        
        // Try to break at a word boundary if possible
        const lastSpaceIndex = truncatedText.lastIndexOf(' ');
        if (lastSpaceIndex > maxChars * 0.8) {
            return truncatedText.substring(0, lastSpaceIndex);
        }
        
        return truncatedText;
    }
}

// Write prompt and content to a file with size management
async function writePromptToFile(systemPrompt, truncatedContent, filePath = '/app/data/logs/prompt.txt', maxSize = 10 * 1024 * 1024) {
    try {
        // Ensure the logs directory exists
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        
        // Check file size and manage it
        try {
            const stats = await fs.stat(filePath);
            if (stats.size > maxSize) {
                await fs.unlink(filePath); // Delete the file if it exceeds max size
                console.log(`[DEBUG] Cleared log file ${filePath} due to size limit`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn('[WARNING] Error checking file size:', error);
            }
        }

        // Write the content with timestamp
        const timestamp = new Date().toISOString();
        const content = `\n=== ${timestamp} ===\nSYSTEM PROMPT:\n${systemPrompt}\n\nUSER CONTENT:\n${truncatedContent}\n\n`;
        
        await fs.appendFile(filePath, content);
    } catch (error) {
        console.error('[ERROR] Error writing to file:', error);
    }
}

const METADATA_ENDPOINTS = [
    '169.254.169.254', // AWS, GCP, Azure metadata
    'metadata.google.internal',
    'metadata.goog',
];

function stripIpv6Brackets(value) {
    return String(value || '').replace(/^\[|\]$/g, '');
}

function normalizeIpAddress(ipAddress) {
    const normalized = stripIpv6Brackets(String(ipAddress || '').trim().toLowerCase());
    const mappedIpv4Match = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);

    if (mappedIpv4Match) {
        return mappedIpv4Match[1];
    }

    return normalized;
}

function isValidIpv4Address(ipAddress) {
    const octets = ipAddress.split('.').map(Number);
    if (octets.length !== 4) {
        return false;
    }

    return octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255);
}

function isLoopbackIpv4Address(ipAddress) {
    if (!isValidIpv4Address(ipAddress)) {
        return false;
    }

    return Number(ipAddress.split('.')[0]) === 127;
}

function isLoopbackAddress(hostOrIp) {
    const normalized = normalizeIpAddress(hostOrIp);

    if (normalized === 'localhost' || normalized === '::1') {
        return true;
    }

    if (net.isIP(normalized) === 4) {
        return isLoopbackIpv4Address(normalized);
    }

    return false;
}

function isPrivateOrInternalIpv4Address(ipAddress) {
    if (!isValidIpv4Address(ipAddress)) {
        return false;
    }

    const [first, second] = ipAddress.split('.').map(Number);

    if (first === 10) {
        return true;
    }

    if (first === 172 && second >= 16 && second <= 31) {
        return true;
    }

    if (first === 192 && second === 168) {
        return true;
    }

    if (first === 169 && second === 254) {
        return true;
    }

    if (first === 127) {
        return true;
    }

    if (first === 0) {
        return true;
    }

    return false;
}

function isPrivateOrInternalIpv6Address(ipAddress) {
    const normalized = normalizeIpAddress(ipAddress);
    const ipVersion = net.isIP(normalized);

    if (ipVersion !== 6) {
        return false;
    }

    if (normalized === '::1' || normalized === '::') {
        return true;
    }

    if (/^fe[89ab][0-9a-f]/i.test(normalized)) {
        return true;
    }

    if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
        return true;
    }

    return false;
}

function isPrivateOrInternalIpAddress(hostOrIp) {
    const normalized = normalizeIpAddress(hostOrIp);
    const ipVersion = net.isIP(normalized);

    if (ipVersion === 4) {
        return isPrivateOrInternalIpv4Address(normalized);
    }

    if (ipVersion === 6) {
        return isPrivateOrInternalIpv6Address(normalized);
    }

    return false;
}

async function resolveHostnameAddresses(hostname) {
    if (net.isIP(hostname)) {
        return { success: true, addresses: [hostname] };
    }

    const [ipv4Result, ipv6Result] = await Promise.allSettled([
        dns.resolve4(hostname),
        dns.resolve6(hostname),
    ]);

    const addresses = [];

    if (ipv4Result.status === 'fulfilled' && Array.isArray(ipv4Result.value)) {
        addresses.push(...ipv4Result.value);
    }

    if (ipv6Result.status === 'fulfilled' && Array.isArray(ipv6Result.value)) {
        addresses.push(...ipv6Result.value);
    }

    if (addresses.length === 0) {
        return { success: false, error: 'Hostname could not be resolved' };
    }

    return { success: true, addresses };
}

/**
 * Validates a URL string to prevent Server-Side Request Forgery (SSRF) attacks.
 * 
 * @param {string} urlString - The URL string to validate
 * @param {Object} options - Validation options
 * @param {boolean} options.allowPrivateIPs - Allow private IP addresses (default: false)
 * @param {boolean} options.allowLocalhost - Allow localhost/loopback addresses (default: false)
 * @param {string[]} options.allowedProtocols - Allowed protocols (default: ['http:', 'https:'])
 * @returns {Promise<{ valid: boolean, url?: URL, error?: string }>} Validation result with parsed URL if valid
 */
async function validateUrl(urlString, options = {}) {
    const {
        allowPrivateIPs = false,
        allowLocalhost = false,
        allowedProtocols = ['http:', 'https:']
    } = options;

    if (!urlString || typeof urlString !== 'string') {
        return { valid: false, error: 'URL must be a non-empty string' };
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(urlString);
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }

    // Validate protocol
    if (!allowedProtocols.includes(parsedUrl.protocol)) {
        return { valid: false, error: `Protocol ${parsedUrl.protocol} is not allowed` };
    }

    const hostname = parsedUrl.hostname.toLowerCase();

    if (METADATA_ENDPOINTS.some(endpoint => hostname === endpoint || hostname.endsWith('.' + endpoint))) {
        return { valid: false, error: 'Cloud metadata endpoints are not allowed' };
    }

    const resolution = await resolveHostnameAddresses(hostname);
    if (!resolution.success) {
        return { valid: false, error: resolution.error };
    }

    const resolvedAddresses = resolution.addresses.map(normalizeIpAddress);

    // Always block cloud metadata IPs.
    if (resolvedAddresses.includes('169.254.169.254')) {
        return { valid: false, error: 'Cloud metadata endpoints are not allowed' };
    }

    // Block localhost and loopback by default, even when private networks are allowed.
    if (!allowLocalhost) {
        if (isLoopbackAddress(hostname) || resolvedAddresses.some(isLoopbackAddress)) {
            return { valid: false, error: 'Localhost addresses are not allowed' };
        }
    }

    // Block private networks unless explicitly allowed.
    if (!allowPrivateIPs && resolvedAddresses.some(isPrivateOrInternalIpAddress)) {
        return { valid: false, error: 'Private IP addresses are not allowed' };
    }

    return { valid: true, url: parsedUrl };
}

/**
 * Validates an API URL for external service communication.
 * This is a wrapper around validateUrl with settings appropriate for API calls.
 * 
 * @param {string} urlString - The URL string to validate
 * @param {Object} options - Additional options
 * @param {boolean} options.allowPrivateIPs - Allow private IP addresses for internal services (default: false)
 * @param {boolean} options.allowLocalhost - Allow localhost/loopback addresses (default: false)
 * @returns {Promise<{ valid: boolean, url?: URL, error?: string }>} Validation result
 */
async function validateApiUrl(urlString, options = {}) {
    return validateUrl(urlString, {
        allowPrivateIPs: options.allowPrivateIPs || false,
        allowLocalhost: options.allowLocalhost || false,
        allowedProtocols: ['http:', 'https:']
    });
}

/**
 * Validates that a URL belongs to a known/configured base URL.
 * This helps prevent SSRF when processing URLs from API responses.
 * 
 * @param {string} urlToValidate - The URL to validate
 * @param {string} expectedBaseUrl - The expected base URL that should match
 * @returns {{ valid: boolean, relativePath?: string, error?: string }} Validation result
 */
function validateUrlAgainstBase(urlToValidate, expectedBaseUrl) {
    if (!urlToValidate || typeof urlToValidate !== 'string') {
        return { valid: false, error: 'URL must be a non-empty string' };
    }
    if (!expectedBaseUrl || typeof expectedBaseUrl !== 'string') {
        return { valid: false, error: 'Base URL must be a non-empty string' };
    }

    let parsedUrl, parsedBase;
    try {
        parsedUrl = new URL(urlToValidate);
        parsedBase = new URL(expectedBaseUrl);
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }

    if (
        parsedUrl.protocol !== parsedBase.protocol ||
        parsedUrl.hostname.toLowerCase() !== parsedBase.hostname.toLowerCase()
    ) {
        return { valid: false, error: 'URL origin does not match expected base URL' };
    }

    // Extract the relative path (removing the base path if present)
    let relativePath = parsedUrl.pathname;
    if (parsedBase.pathname && parsedBase.pathname !== '/') {
        if (relativePath.startsWith(parsedBase.pathname)) {
            relativePath = relativePath.substring(parsedBase.pathname.length);
        }
    }

    // Ensure path starts with /
    if (!relativePath.startsWith('/')) {
        relativePath = '/' + relativePath;
    }

    return { 
        valid: true, 
        relativePath: relativePath + parsedUrl.search 
    };
}

/**
 * Validate and normalize a custom field value based on its Paperless-ngx data_type.
 *
 * @param {string} fieldName - Field name (used in log messages)
 * @param {*}      rawValue  - Raw value from the AI response
 * @param {string} dataType  - Paperless-ngx data_type ('date', 'boolean', ...)
 * @returns {{ skip: boolean, value?: *, warn?: string }}
 *   skip=true  → caller should skip this field (optional warn message attached)
 *   skip=false → caller should use the returned `value`
 */
function validateCustomFieldValue(fieldName, rawValue, dataType) {
    const strValue = String(rawValue).trim();

    if (dataType === 'date') {
        // Require exactly YYYY-MM-DD *and* a real calendar date (e.g. rejects 2024-02-30)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(strValue) || !isValid(parseISO(strValue))) {
            return {
                skip: true,
                warn: `[WARN] Custom field "${fieldName}" has invalid date value "${strValue}", skipping`
            };
        }
        return { skip: false, value: strValue };
    }

    if (dataType === 'boolean') {
        const raw = strValue.toLowerCase();
        if (['true', 'yes', '1'].includes(raw)) return { skip: false, value: true };
        if (['false', 'no', '0'].includes(raw)) return { skip: false, value: false };
        return {
            skip: true,
            warn: `[WARN] Custom field "${fieldName}" has invalid boolean value "${strValue}", skipping`
        };
    }

    if (dataType === 'monetary') {
        // Normalize common AI formatting artefacts: spaces and thousand separators.
        // Examples: "EUR 4,550.00" -> "EUR4550.00", "4,550.00" -> "4550.00".
        const normalizedValue = strValue.replace(/\s+/g, '').replace(/,/g, '');

        if (!/\d/.test(normalizedValue)) {
            return {
                skip: true,
                warn: `[WARN] Custom field "${fieldName}" has invalid monetary value "${strValue}", skipping`
            };
        }

        return { skip: false, value: normalizedValue };
    }

    // Paperless-ngx enforces a 128-character limit on STRING custom fields
    if (dataType === 'string' && strValue.length > 128) {
        return {
            skip: true,
            warn: `[WARN] Custom field "${fieldName}" value exceeds 128 characters (${strValue.length}), skipping`
        };
    }

    // All other types: pass the string through unchanged
    return { skip: false, value: strValue };
}

/**
 * Decide whether an AI error should trigger OCR queue fallback.
 *
 * @param {string} errorMessage - Error message returned by AI analysis
 * @returns {boolean}
 */
function shouldQueueForOcrOnAiError(errorMessage) {
    if (typeof errorMessage !== 'string' || !errorMessage.trim()) {
        return false;
    }

    const normalizedError = errorMessage.toLowerCase();
    const ocrRelevantErrorMarkers = [
        'insufficient content for ai analysis',
        'invalid response structure',
        'could not determine assignable metadata',
        'invalid json response from api',
        'invalid api response structure'
    ];

    return ocrRelevantErrorMarkers.some(marker => normalizedError.includes(marker));
}

/**
 * Classify OCR queue reason from an AI error message.
 *
 * @param {string} errorMessage - Error message returned by AI analysis
 * @returns {string} OCR queue reason code
 */
function classifyOcrQueueReasonFromAiError(errorMessage) {
    if (typeof errorMessage !== 'string' || !errorMessage.trim()) {
        return 'ai_failed_unknown';
    }

    const normalizedError = errorMessage.toLowerCase();

    if (normalizedError.includes('insufficient content for ai analysis')) {
        return 'ai_insufficient_content';
    }
    if (normalizedError.includes('invalid json response from api')) {
        return 'ai_invalid_json';
    }
    if (normalizedError.includes('invalid response structure')) {
        return 'ai_invalid_response_structure';
    }
    if (normalizedError.includes('could not determine assignable metadata')) {
        return 'ai_invalid_response_structure';
    }
    if (normalizedError.includes('invalid api response structure')) {
        return 'ai_invalid_api_response_structure';
    }

    return 'ai_failed_unknown';
}

/**
 * Detect whether an error or message indicates a request timeout.
 *
 * @param {unknown} errorOrMessage
 * @returns {boolean}
 */
function isTimeoutError(errorOrMessage) {
    const message = typeof errorOrMessage === 'string'
        ? errorOrMessage
        : String(errorOrMessage?.message || '');
    const code = String(errorOrMessage?.code || '').toUpperCase();
    const normalizedMessage = message.toLowerCase();

    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || code === 'ABORT_ERR') {
        return true;
    }

    const timeoutMarkers = [
        'timed out',
        'timeout',
        'request aborted',
        'aborted',
        'deadline exceeded',
        'socket hang up'
    ];

    return timeoutMarkers.some((marker) => normalizedMessage.includes(marker));
}

/**
 * Build a normalized timeout error message for OCR/AI operations.
 *
 * @param {'AI'|'OCR'|string} scope
 * @param {number|null} timeoutMs
 * @returns {string}
 */
function buildTimeoutErrorMessage(scope, timeoutMs = null) {
    const normalizedScope = String(scope || 'Request').trim().toUpperCase();
    const suffix = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? ` after ${Number(timeoutMs)}ms`
        : '';

    return `${normalizedScope} response timeout reached${suffix}. Please check provider availability and timeout settings.`;
}

/**
 * Extracts assistant message content from OpenAI-compatible responses.
 * Falls back to extracting JSON from reasoning_content when content is empty.
 *
 * @param {Object} message - Assistant message object
 * @param {string} providerLabel - Provider label for warning logs
 * @returns {string} Extracted content or empty string
 */
function extractChatMessageContent(message, providerLabel = 'OpenAI-compatible') {
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    if (content) {
        return content;
    }

    const reasoningContent = typeof message?.reasoning_content === 'string' ? message.reasoning_content.trim() : '';
    if (!reasoningContent) {
        return '';
    }

    const jsonMatch = reasoningContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        console.warn(`[WARN] [${providerLabel}] Empty message.content, using JSON extracted from reasoning_content.`);
        return jsonMatch[0].trim();
    }

    console.warn(`[WARN] [${providerLabel}] Empty message.content and no JSON found in reasoning_content.`);
    return '';
}

module.exports = {
    calculateTokens,
    calculateTotalPromptTokens,
    truncateToTokenLimit,
    writePromptToFile,
    validateUrl,
    validateApiUrl,
    validateUrlAgainstBase,
    validateCustomFieldValue,
    shouldQueueForOcrOnAiError,
    classifyOcrQueueReasonFromAiError,
    extractChatMessageContent,
    isTimeoutError,
    buildTimeoutErrorMessage
};