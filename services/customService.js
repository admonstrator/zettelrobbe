const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit,
  extractChatMessageContent,
  assertCompletionNotTruncated,
  isTimeoutError,
  buildTimeoutErrorMessage,
  toNameList,
} = require('./serviceUtils');
const {
  abortSignal,
  hasNumber,
  hasSystemPrompt,
  modelOverride,
  readCompletionUsage,
} = require('./aiGenerateOptions');
const OpenAI = require('openai');
const config = require('../config/config');
const paperlessService = require('./paperlessService');
const fs = require('fs').promises;
const path = require('path');
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('./thumbnailCachePaths');
const RestrictionPromptService = require('./restrictionPromptService');
const responseLogPath = path.join(
  process.cwd(),
  'data',
  'logs',
  'response.txt'
);
const CUSTOM_PROVIDER_FALLBACK_API_KEY = 'no-auth-required';

class CustomOpenAIService {
  constructor() {
    this.client = null;
    this.tokenizer = null;
  }

  _extractFirstJsonValue(text) {
    if (!text) {
      return null;
    }

    const starts = [];
    const firstObject = text.indexOf('{');
    const firstArray = text.indexOf('[');

    if (firstObject !== -1) {
      starts.push(firstObject);
    }
    if (firstArray !== -1) {
      starts.push(firstArray);
    }

    if (starts.length === 0) {
      return null;
    }

    const startIndex = Math.min(...starts);
    const opening = text[startIndex];
    const closing = opening === '{' ? '}' : ']';

    let depth = 0;
    let inString = false;
    let escaping = false;

    for (let i = startIndex; i < text.length; i += 1) {
      const char = text[i];

      if (inString) {
        if (escaping) {
          escaping = false;
        } else if (char === '\\') {
          escaping = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === opening) {
        depth += 1;
      } else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(startIndex, i + 1);
        }
      }
    }

    return null;
  }

  _parseJsonResponse(rawContent) {
    const sanitizedContent = String(rawContent || '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/g, '')
      .trim();

    try {
      return {
        parsed: JSON.parse(sanitizedContent),
        normalized: sanitizedContent,
      };
    } catch (directParseError) {
      const extractedJson = this._extractFirstJsonValue(sanitizedContent);
      if (!extractedJson) {
        throw new Error('Invalid JSON response from API', {
          cause: directParseError,
        });
      }

      try {
        return {
          parsed: JSON.parse(extractedJson),
          normalized: extractedJson,
        };
      } catch (extractedParseError) {
        throw new Error('Invalid JSON response from API', {
          cause: extractedParseError,
        });
      }
    }
  }

  initialize() {
    if (!this.client && config.aiProvider === 'custom') {
      this.client = new OpenAI({
        baseURL: config.custom.apiUrl,
        // OpenAI-compatible SDKs require an apiKey value even when auth is disabled.
        apiKey: config.custom.apiKey || CUSTOM_PROVIDER_FALLBACK_API_KEY,
      });
    }
  }

  async analyzeDocument(
    content,
    existingTags = [],
    existingCorrespondentList = [],
    existingDocumentTypesList = [],
    id,
    customPrompt = null,
    options = {}
  ) {
    const cachePath = getThumbnailCachePath(id);
    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', {
        dateStyle: 'short',
        timeStyle: 'short',
      });

      if (!this.client) {
        throw new Error('Custom OpenAI client not initialized');
      }

      // Handle thumbnail caching
      try {
        await fs.access(cachePath);
        console.log('[DEBUG] Thumbnail already cached');
      } catch {
        console.log('Thumbnail not cached, fetching from Paperless');

        const thumbnailData = await paperlessService.getThumbnailImage(id);

        if (!thumbnailData) {
          console.warn('Thumbnail not found');
          return;
        }

        await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
        await fs.writeFile(cachePath, thumbnailData);
      }

      // Format existing data - callers may hand over entity objects or plain names
      const existingTagNames = toNameList(existingTags).join(', ');
      const existingCorrespondentNames = toNameList(
        existingCorrespondentList
      ).join(', ');
      const existingDocumentTypeNames = toNameList(
        existingDocumentTypesList
      ).join(', ');

      // Get external API data if available and validate it
      let externalApiData = options.externalApiData || null;
      let validatedExternalApiData = null;

      if (externalApiData) {
        try {
          validatedExternalApiData =
            await this._validateAndTruncateExternalApiData(externalApiData);
          console.log('[DEBUG] External API data validated and included');
        } catch (error) {
          console.warn(
            '[WARNING] External API data validation failed:',
            error.message
          );
          validatedExternalApiData = null;
        }
      }

      let systemPrompt = '';
      let promptTags = '';
      const model = config.custom.model;

      // Parse CUSTOM_FIELDS from environment variable
      let customFieldsObj;
      try {
        customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
      } catch (error) {
        console.error(`Failed to parse CUSTOM_FIELDS: ${error.message}`);
        console.debug(error);
        customFieldsObj = { custom_fields: [] };
      }

      // Generate custom fields template for the prompt
      const customFieldsTemplate = {};

      customFieldsObj.custom_fields.forEach((field, index) => {
        let valueHint;
        if (field.data_type === 'date') {
          valueHint =
            'Fill in the date in ISO 8601 format (YYYY-MM-DD) based on your analysis';
        } else if (field.data_type === 'boolean') {
          valueHint = "Fill in 'true' or 'false' based on your analysis";
        } else {
          valueHint = 'Fill in the value based on your analysis';
        }
        customFieldsTemplate[index] = {
          field_name: field.value,
          value: valueHint,
        };
      });

      // Convert template to string for replacement and wrap in custom_fields
      const customFieldsStr =
        '"custom_fields": ' +
        JSON.stringify(customFieldsTemplate, null, 2)
          .split('\n')
          .map((line) => '    ' + line) // Add proper indentation
          .join('\n');

      // Get system prompt based on configuration
      if (
        config.useExistingData === 'yes' &&
        config.restrictToExistingTags === 'no' &&
        config.restrictToExistingCorrespondents === 'no'
      ) {
        systemPrompt =
          `
        Pre-existing tags: ${existingTagNames}\n\n
        Pre-existing correspondents: ${existingCorrespondentNames}\n\n
        Pre-existing document types: ${existingDocumentTypeNames}\n\n
        ` +
          process.env.SYSTEM_PROMPT +
          '\n\n' +
          config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
        promptTags = '';
      } else {
        const mustHavePrompt = config.mustHavePrompt.replace(
          '%CUSTOMFIELDS%',
          customFieldsStr
        );
        systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + mustHavePrompt;
        promptTags = '';
      }

      // Process placeholder replacements in system prompt
      systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
        systemPrompt,
        existingTags,
        existingCorrespondentList,
        existingDocumentTypesList
      );

      // Include validated external API data if available
      if (validatedExternalApiData) {
        systemPrompt += `\n\nAdditional context from external API:\n${validatedExternalApiData}`;
      }

      if (process.env.USE_PROMPT_TAGS === 'yes') {
        promptTags = process.env.PROMPT_TAGS;
        systemPrompt =
          `
        Take these tags and try to match one or more to the document content.\n\n
        ` + config.specialPromptPreDefinedTags;
      }

      // Custom prompt override if provided
      if (customPrompt) {
        console.log('[DEBUG] Replace system prompt with custom prompt');
        systemPrompt =
          customPrompt +
          '\n\n' +
          config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
      }

      // Calculate tokens AFTER all prompt modifications are complete
      const totalPromptTokens = await calculateTotalPromptTokens(
        systemPrompt,
        process.env.USE_PROMPT_TAGS === 'yes' ? [promptTags] : [],
        model
      );

      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens);
      const availableTokens = maxTokens - reservedTokens;

      // Validate that we have positive available tokens. A non-finite budget
      // is the same failure: it slips past a bare `<= 0` and truncates the
      // document down to nothing instead of stopping.
      if (!Number.isFinite(availableTokens) || availableTokens <= 0) {
        console.warn(
          `[WARNING] No available tokens for content. Reserved: ${reservedTokens}, Max: ${maxTokens}`
        );
        throw new Error(
          'Token limit exceeded: prompt too large for available token limit'
        );
      }

      console.log(
        `[DEBUG] Token calculation - Prompt: ${totalPromptTokens}, Reserved: ${reservedTokens}, Available: ${availableTokens}`
      );
      console.log(
        `[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`
      );
      console.log(
        `[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`
      );

      const truncatedContent = await truncateToTokenLimit(
        content,
        availableTokens,
        model
      );

      // console.log('######################################################################');
      // console.log(`[DEBUG] Content length: ${content.length}, Truncated content length: ${truncatedContent.length}`);
      // console.log(`[DEBUG] Truncated content: ${truncatedContent}`);
      // console.log(`[DEBUG] System prompt: ${systemPrompt}`);
      // console.log(`[DEBUG] Prompt tags: ${promptTags}`);
      // console.log(`[DEBUG] Model: ${model}`);
      // console.log(`[DEBUG] Custom fields: ${customFieldsStr}`);
      // console.log(`[DEBUG] Existing tags: ${existingTagNames}`);
      // console.log(`[DEBUG] Existing correspondents: ${existingCorrespondentNames}`);
      // console.log(`[DEBUG] Custom prompt: ${customPrompt}`);
      // console.log(`[DEBUG] External API data: ${validatedExternalApiData}`);
      // console.log('######################################################################');

      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: truncatedContent,
          },
        ],
        temperature: config.aiTemperatureAnalysis,
      });

      // Handle response
      //console.log(`MESSAGE: ${response?.choices?.[0]?.message?.content}`);
      assertCompletionNotTruncated(
        response,
        'Custom OpenAI',
        'Reduce the number of custom fields the prompt asks for, or use a model with a larger completion limit.'
      );
      const message = response?.choices?.[0]?.message;
      let jsonContent = extractChatMessageContent(message, 'Custom OpenAI');
      if (!jsonContent) {
        throw new Error('Invalid API response structure');
      }

      // Log token usage
      console.log(`[DEBUG] [${timestamp}] Custom OpenAI request sent`);
      console.log(
        `[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`
      );

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      };

      let parsedResponse;
      try {
        const parsedResult = this._parseJsonResponse(jsonContent);
        parsedResponse = parsedResult.parsed;
        jsonContent = parsedResult.normalized;
      } catch (error) {
        console.error(`Failed to parse JSON response: ${error.message}`);
        console.debug(error);
        throw error;
      }

      try {
        await fs.mkdir(path.dirname(responseLogPath), { recursive: true });
        await fs.appendFile(responseLogPath, `${jsonContent}\n`);
      } catch (logError) {
        console.warn('Failed to write AI response log:', logError.message);
      }

      // Validate response structure
      if (
        !parsedResponse ||
        !Array.isArray(parsedResponse.tags) ||
        (typeof parsedResponse.correspondent !== 'string' &&
          parsedResponse.correspondent !== null)
      ) {
        throw new Error(
          'AI could not determine assignable metadata: no tags or correspondent found'
        );
      }

      return {
        document: parsedResponse,
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length,
      };
    } catch (error) {
      const normalizedMessage = isTimeoutError(error)
        ? buildTimeoutErrorMessage('AI')
        : error.message;

      if (isTimeoutError(error)) {
        console.error(
          `[TIMEOUT][AI] Custom provider request timed out: ${error.message}`
        );
      }

      console.error(`Failed to analyze document: ${normalizedMessage}`);
      console.debug(error);
      return {
        document: { tags: [], correspondent: null },
        metrics: null,
        error: normalizedMessage,
        // Undefined for everything that is not one of ours; the scan loop
        // falls back to its generic reason then.
        errorCode: error.code,
      };
    }
  }

  /**
   * Validate and truncate external API data to prevent token overflow
   * @param {any} apiData - The external API data to validate
   * @param {number} maxTokens - Maximum tokens allowed for external data (default: 500)
   * @returns {string} - Validated and potentially truncated data string
   */
  async _validateAndTruncateExternalApiData(apiData, maxTokens = 500) {
    if (!apiData) {
      return null;
    }

    const dataString =
      typeof apiData === 'object'
        ? JSON.stringify(apiData, null, 2)
        : String(apiData);

    // Calculate tokens for the data
    const dataTokens = await calculateTokens(dataString, config.custom.model);

    if (dataTokens > maxTokens) {
      console.warn(
        `[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`
      );
      return await truncateToTokenLimit(
        dataString,
        maxTokens,
        config.custom.model
      );
    }

    console.log(`[DEBUG] External API data validated: ${dataTokens} tokens`);
    return dataString;
  }

  async analyzePlayground(content, prompt) {
    const musthavePrompt = `
    Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:  
        {
          "title": "xxxxx",
          "correspondent": "xxxxxxxx",
          "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
          "document_date": "YYYY-MM-DD",
          "language": "en/de/es/..."
        }`;

    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', {
        dateStyle: 'short',
        timeStyle: 'short',
      });

      if (!this.client) {
        throw new Error(
          'Custom OpenAI client not initialized - missing API key'
        );
      }

      // Calculate total prompt tokens including musthavePrompt
      const totalPromptTokens = await calculateTotalPromptTokens(
        prompt + musthavePrompt // Combined system prompt
      );

      // Calculate available tokens
      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens);
      const availableTokens = maxTokens - reservedTokens;

      // The same guard analyzeDocument() uses: a broken token limit must fail
      // loudly instead of silently truncating the content down to nothing.
      if (!Number.isFinite(availableTokens) || availableTokens <= 0) {
        console.warn(
          `[WARNING] No available tokens for content. Reserved: ${reservedTokens}, Max: ${maxTokens}`
        );
        throw new Error(
          'Token limit exceeded: prompt too large for available token limit'
        );
      }

      // Truncate content if necessary
      const truncatedContent = await truncateToTokenLimit(
        content,
        availableTokens
      );

      // Make API request
      const response = await this.client.chat.completions.create({
        model: config.custom.model,
        messages: [
          {
            role: 'system',
            content: prompt + musthavePrompt,
          },
          {
            role: 'user',
            content: truncatedContent,
          },
        ],
        temperature: config.aiTemperatureAnalysis,
      });

      // Handle response
      assertCompletionNotTruncated(
        response,
        'Custom OpenAI',
        'Reduce the number of custom fields the prompt asks for, or use a model with a larger completion limit.'
      );
      const message = response?.choices?.[0]?.message;
      let jsonContent = extractChatMessageContent(message, 'Custom OpenAI');
      if (!jsonContent) {
        throw new Error('Invalid API response structure');
      }

      // Log token usage
      console.log(`[DEBUG] [${timestamp}] Custom OpenAI request sent`);
      console.log(
        `[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`
      );

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      };

      let parsedResponse;
      try {
        const parsedResult = this._parseJsonResponse(jsonContent);
        parsedResponse = parsedResult.parsed;
        jsonContent = parsedResult.normalized;
      } catch (error) {
        console.error(`Failed to parse JSON response: ${error.message}`);
        console.debug(error);
        throw error;
      }

      // Validate response structure
      if (
        !parsedResponse ||
        !Array.isArray(parsedResponse.tags) ||
        (typeof parsedResponse.correspondent !== 'string' &&
          parsedResponse.correspondent !== null)
      ) {
        throw new Error(
          'AI could not determine assignable metadata: no tags or correspondent found'
        );
      }

      return {
        document: parsedResponse,
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length,
      };
    } catch (error) {
      console.error(`Failed to analyze document: ${error.message}`);
      console.debug(error);
      return {
        document: { tags: [], correspondent: null },
        metrics: null,
        error: error.message,
        // Undefined for everything that is not one of ours; the scan loop
        // falls back to its generic reason then.
        errorCode: error.code,
      };
    }
  }

  /**
   * Generate text based on a prompt
   * @param {string} prompt - The prompt to generate text from
   * @param {object} [options] - Optional overrides for this one call
   * @param {string} [options.systemPrompt] - Sent as the system message
   * @param {number} [options.temperature] - Overrides AI_TEMPERATURE_GENERATION
   * @param {number} [options.maxTokens] - Overrides RESPONSE_TOKENS, still clamped
   * @param {AbortSignal} [options.signal] - Cancels the request in flight
   * @returns {Promise<string>} - The generated text
   */
  async generateText(prompt, options = {}) {
    try {
      this.initialize();

      if (!this.client) {
        throw new Error(
          'Custom OpenAI client not initialized - missing API key'
        );
      }

      const model = modelOverride(options) || config.custom.model;
      const maxContextTokens = Number(config.tokenLimit) || 128000;
      const desiredCompletionTokens =
        hasNumber(options.maxTokens) && options.maxTokens > 0
          ? Math.floor(options.maxTokens)
          : Number(config.responseTokens) || 1000;
      const promptTokens = await calculateTokens(prompt, model);
      const availableCompletionTokens = Math.max(
        1,
        maxContextTokens - promptTokens - 64
      );
      const maxCompletionTokens = Math.max(
        1,
        Math.min(desiredCompletionTokens, availableCompletionTokens)
      );

      if (maxCompletionTokens < desiredCompletionTokens) {
        console.log(
          `[DEBUG] Clamped max_tokens for custom generateText from ${desiredCompletionTokens} to ${maxCompletionTokens} ` +
            `(context limit: ${maxContextTokens}, prompt tokens: ${promptTokens})`
        );
      }

      const messages = [];
      if (hasSystemPrompt(options)) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const request = {
        model: model,
        messages,
        temperature: hasNumber(options.temperature)
          ? options.temperature
          : config.aiTemperatureGeneration,
        max_tokens: maxCompletionTokens,
      };

      this.lastGenerateTextUsage = null;
      // The second argument is the SDK's request option bag; a caller that
      // brought no signal gets the call it always got.
      const signal = abortSignal(options);
      const response = signal
        ? await this.client.chat.completions.create(request, { signal })
        : await this.client.chat.completions.create(request);
      this.lastGenerateTextUsage = readCompletionUsage(response);

      assertCompletionNotTruncated(
        response,
        'Custom OpenAI',
        'Raise Response Tokens (RESPONSE_TOKENS).'
      );

      const generatedText = extractChatMessageContent(
        response?.choices?.[0]?.message,
        'Custom OpenAI'
      );
      if (!generatedText) {
        throw new Error('Invalid API response structure');
      }

      return generatedText;
    } catch (error) {
      console.error(
        `Error generating text with Custom OpenAI: ${error.message}`
      );
      console.debug(error);
      throw error;
    }
  }

  async checkStatus() {
    try {
      this.initialize();

      if (!this.client) {
        throw new Error(
          'Custom OpenAI client not initialized - missing API key'
        );
      }

      const model = config.custom.model;

      // Use token-free endpoint where supported by OpenAI-compatible providers.
      await this.client.models.list();

      return { status: 'ok', model: model };
    } catch (error) {
      console.error(
        `Error generating text with Custom OpenAI: ${error.message}`
      );
      console.debug(error);
      return { status: 'error', error: error.message };
    }
  }
}

module.exports = new CustomOpenAIService();
