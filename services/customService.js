const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit,
  writePromptToFile,
  extractChatMessageContent,
  isTimeoutError,
  buildTimeoutErrorMessage
} = require('./serviceUtils');
const OpenAI = require('openai');
const config = require('../config/config');
const tiktoken = require('tiktoken');
const paperlessService = require('./paperlessService');
const fs = require('fs').promises;
const path = require('path');
const { THUMBNAIL_CACHE_DIR, getThumbnailCachePath } = require('./thumbnailCachePaths');
const RestrictionPromptService = require('./restrictionPromptService');
const responseLogPath = path.join('/app', 'data', 'logs', 'response.txt');
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
        normalized: sanitizedContent
      };
    } catch (_directParseError) {
      const extractedJson = this._extractFirstJsonValue(sanitizedContent);
      if (!extractedJson) {
        throw new Error('Invalid JSON response from API');
      }

      try {
        return {
          parsed: JSON.parse(extractedJson),
          normalized: extractedJson
        };
      } catch (_extractedParseError) {
        throw new Error('Invalid JSON response from API');
      }
    }
  }

  initialize() {
    if (!this.client && config.aiProvider === 'custom') {
      this.client = new OpenAI({
        baseURL: config.custom.apiUrl,
        // OpenAI-compatible SDKs require an apiKey value even when auth is disabled.
        apiKey: config.custom.apiKey || CUSTOM_PROVIDER_FALLBACK_API_KEY
      });
    }
  }

  async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], existingDocumentTypesList = [], id, customPrompt = null, options = {}) {
    const cachePath = getThumbnailCachePath(id);
    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

      if (!this.client) {
        throw new Error('Custom OpenAI client not initialized');
      }

      // Handle thumbnail caching
      try {
        await fs.access(cachePath);
        console.log('[DEBUG] Thumbnail already cached');
      } catch (err) {
        console.log('Thumbnail not cached, fetching from Paperless');

        const thumbnailData = await paperlessService.getThumbnailImage(id);

        if (!thumbnailData) {
          console.warn('Thumbnail not found');
          return;
        }

        await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
        await fs.writeFile(cachePath, thumbnailData);
      }

      // Format existing tags
      let existingTagsList = existingTags.join(', ');

      // Get external API data if available and validate it
      let externalApiData = options.externalApiData || null;
      let validatedExternalApiData = null;

      if (externalApiData) {
        try {
          validatedExternalApiData = await this._validateAndTruncateExternalApiData(externalApiData);
          console.log('[DEBUG] External API data validated and included');
        } catch (error) {
          console.warn('[WARNING] External API data validation failed:', error.message);
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
        console.error(`Failed to parse CUSTOM_FIELDS: ${error.message}`); console.debug(error);
        customFieldsObj = { custom_fields: [] };
      }

      // Generate custom fields template for the prompt
      const customFieldsTemplate = {};

      customFieldsObj.custom_fields.forEach((field, index) => {
        let valueHint;
        if (field.data_type === 'date') {
          valueHint = "Fill in the date in ISO 8601 format (YYYY-MM-DD) based on your analysis";
        } else if (field.data_type === 'boolean') {
          valueHint = "Fill in 'true' or 'false' based on your analysis";
        } else {
          valueHint = "Fill in the value based on your analysis";
        }
        customFieldsTemplate[index] = {
          field_name: field.value,
          value: valueHint
        };
      });

      // Convert template to string for replacement and wrap in custom_fields
      const customFieldsStr = '"custom_fields": ' + JSON.stringify(customFieldsTemplate, null, 2)
        .split('\n')
        .map(line => '    ' + line)  // Add proper indentation
        .join('\n');

      // Get system prompt based on configuration
      if (config.useExistingData === 'yes' && config.restrictToExistingTags === 'no' && config.restrictToExistingCorrespondents === 'no') {
        systemPrompt = `
        Pre-existing tags: ${existingTagsList}\n\n
        Pre-existing correspondents: ${existingCorrespondentList}\n\n
        Pre-existing document types: ${existingDocumentTypesList.join(', ')}\n\n
        ` + process.env.SYSTEM_PROMPT + '\n\n' + config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
        promptTags = '';
      } else {
        const mustHavePrompt = config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
        systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + mustHavePrompt;
        promptTags = '';
      }

      // Process placeholder replacements in system prompt
      systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
        systemPrompt,
        existingTags,
        existingCorrespondentList,
        existingDocumentTypesList,
        config
      );

      // Include validated external API data if available
      if (validatedExternalApiData) {
        systemPrompt += `\n\nAdditional context from external API:\n${validatedExternalApiData}`;
      }

      if (process.env.USE_PROMPT_TAGS === 'yes') {
        promptTags = process.env.PROMPT_TAGS;
        systemPrompt = `
        Take these tags and try to match one or more to the document content.\n\n
        ` + config.specialPromptPreDefinedTags;
      }

      // Custom prompt override if provided
      if (customPrompt) {
        console.log('[DEBUG] Replace system prompt with custom prompt');
        systemPrompt = customPrompt + '\n\n' + config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
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

      // Validate that we have positive available tokens
      if (availableTokens <= 0) {
        console.warn(`[WARNING] No available tokens for content. Reserved: ${reservedTokens}, Max: ${maxTokens}`);
        throw new Error('Token limit exceeded: prompt too large for available token limit');
      }

      console.log(`[DEBUG] Token calculation - Prompt: ${totalPromptTokens}, Reserved: ${reservedTokens}, Available: ${availableTokens}`);
      console.log(`[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`);
      console.log(`[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`);

      const truncatedContent = await truncateToTokenLimit(content, availableTokens, model);

      // console.log('######################################################################');
      // console.log(`[DEBUG] Content length: ${content.length}, Truncated content length: ${truncatedContent.length}`);
      // console.log(`[DEBUG] Truncated content: ${truncatedContent}`);
      // console.log(`[DEBUG] System prompt: ${systemPrompt}`);
      // console.log(`[DEBUG] Prompt tags: ${promptTags}`);
      // console.log(`[DEBUG] Model: ${model}`);
      // console.log(`[DEBUG] Custom fields: ${customFieldsStr}`);
      // console.log(`[DEBUG] Existing tags: ${existingTagsList}`);
      // console.log(`[DEBUG] Existing correspondents: ${existingCorrespondentList}`);
      // console.log(`[DEBUG] Custom prompt: ${customPrompt}`);
      // console.log(`[DEBUG] External API data: ${validatedExternalApiData}`);
      // console.log('######################################################################');


      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: truncatedContent
          }
        ],
        temperature: config.aiTemperatureAnalysis,
      });

      // Handle response
      //console.log(`MESSAGE: ${response?.choices?.[0]?.message?.content}`);
      const message = response?.choices?.[0]?.message;
      let jsonContent = extractChatMessageContent(message, 'Custom OpenAI');
      if (!jsonContent) {
        throw new Error('Invalid API response structure');
      }

      // Log token usage
      console.log(`[DEBUG] [${timestamp}] Custom OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      let parsedResponse;
      try {
        const parsedResult = this._parseJsonResponse(jsonContent);
        parsedResponse = parsedResult.parsed;
        jsonContent = parsedResult.normalized;
      } catch (error) {
        console.error(`Failed to parse JSON response: ${error.message}`); console.debug(error);
        throw error;
      }

      try {
        await fs.mkdir(path.dirname(responseLogPath), { recursive: true });
        await fs.appendFile(responseLogPath, `${jsonContent}\n`);
      } catch (logError) {
        console.warn('Failed to write AI response log:', logError.message);
      }

      // Validate response structure
      if (!parsedResponse || !Array.isArray(parsedResponse.tags) || (typeof parsedResponse.correspondent !== 'string' && parsedResponse.correspondent !== null)) {
        throw new Error('AI could not determine assignable metadata: no tags or correspondent found');
      }

      return {
        document: parsedResponse,
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length
      };
    } catch (error) {
      const normalizedMessage = isTimeoutError(error)
        ? buildTimeoutErrorMessage('AI')
        : error.message;

      if (isTimeoutError(error)) {
        console.error(`[TIMEOUT][AI] Custom provider request timed out: ${error.message}`);
      }

      console.error(`Failed to analyze document: ${normalizedMessage}`);
      console.debug(error);
      return {
        document: { tags: [], correspondent: null },
        metrics: null,
        error: normalizedMessage
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

    const dataString = typeof apiData === 'object'
      ? JSON.stringify(apiData, null, 2)
      : String(apiData);

    // Calculate tokens for the data
    const dataTokens = await calculateTokens(dataString, config.custom.model);

    if (dataTokens > maxTokens) {
      console.warn(`[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`);
      return await truncateToTokenLimit(dataString, maxTokens, config.custom.model);
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
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

      if (!this.client) {
        throw new Error('Custom OpenAI client not initialized - missing API key');
      }

      // Calculate total prompt tokens including musthavePrompt
      const totalPromptTokens = await calculateTotalPromptTokens(
        prompt + musthavePrompt // Combined system prompt
      );

      // Calculate available tokens
      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens);
      const availableTokens = maxTokens - reservedTokens;

      // Truncate content if necessary
      const truncatedContent = await truncateToTokenLimit(content, availableTokens);

      // Make API request
      const response = await this.client.chat.completions.create({
        model: config.custom.model,
        messages: [
          {
            role: "system",
            content: prompt + musthavePrompt
          },
          {
            role: "user",
            content: truncatedContent
          }
        ],
        temperature: config.aiTemperatureAnalysis,
      });

      // Handle response
      const message = response?.choices?.[0]?.message;
      let jsonContent = extractChatMessageContent(message, 'Custom OpenAI');
      if (!jsonContent) {
        throw new Error('Invalid API response structure');
      }

      // Log token usage
      console.log(`[DEBUG] [${timestamp}] Custom OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      let parsedResponse;
      try {
        const parsedResult = this._parseJsonResponse(jsonContent);
        parsedResponse = parsedResult.parsed;
        jsonContent = parsedResult.normalized;
      } catch (error) {
        console.error(`Failed to parse JSON response: ${error.message}`); console.debug(error);
        throw error;
      }

      // Validate response structure
      if (!parsedResponse || !Array.isArray(parsedResponse.tags) || (typeof parsedResponse.correspondent !== 'string' && parsedResponse.correspondent !== null)) {
        throw new Error('AI could not determine assignable metadata: no tags or correspondent found');
      }

      return {
        document: parsedResponse,
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length
      };
    } catch (error) {
      console.error(`Failed to analyze document: ${error.message}`);
      console.debug(error);
      return {
        document: { tags: [], correspondent: null },
        metrics: null,
        error: error.message
      };
    }
  }

  /**
   * Generate text based on a prompt
   * @param {string} prompt - The prompt to generate text from
   * @returns {Promise<string>} - The generated text
   */
  async generateText(prompt) {
    try {
      this.initialize();

      if (!this.client) {
        throw new Error('Custom OpenAI client not initialized - missing API key');
      }

      const model = config.custom.model;
      const maxContextTokens = Number(config.tokenLimit) || 128000;
      const desiredCompletionTokens = Number(config.responseTokens) || 1000;
      const promptTokens = await calculateTokens(prompt, model);
      const availableCompletionTokens = Math.max(1, maxContextTokens - promptTokens - 64);
      const maxCompletionTokens = Math.max(1, Math.min(desiredCompletionTokens, availableCompletionTokens));

      if (maxCompletionTokens < desiredCompletionTokens) {
        console.log(
          `[DEBUG] Clamped max_tokens for custom generateText from ${desiredCompletionTokens} to ${maxCompletionTokens} ` +
          `(context limit: ${maxContextTokens}, prompt tokens: ${promptTokens})`
        );
      }

      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: config.aiTemperatureGeneration,
        max_tokens: maxCompletionTokens
      });

      const generatedText = extractChatMessageContent(response?.choices?.[0]?.message, 'Custom OpenAI');
      if (!generatedText) {
        throw new Error('Invalid API response structure');
      }

      return generatedText;
    } catch (error) {
      console.error(`Error generating text with Custom OpenAI: ${error.message}`); console.debug(error);
      throw error;
    }
  }

  async checkStatus() {
    try {
      this.initialize();

      if (!this.client) {
        throw new Error('Custom OpenAI client not initialized - missing API key');
      }

      const model = config.custom.model;

      // Use token-free endpoint where supported by OpenAI-compatible providers.
      await this.client.models.list();

      return { status: 'ok', model: model };
    } catch (error) {
      console.error(`Error generating text with Custom OpenAI: ${error.message}`); console.debug(error);
      return { status: 'error', error: error.message };
    }
  }
}

module.exports = new CustomOpenAIService();
