const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit,
  writePromptToFile,
  extractChatMessageContent
} = require('./serviceUtils');
const OpenAI = require('openai');
const config = require('../config/config');
const paperlessService = require('./paperlessService');
const fs = require('fs').promises;
const path = require('path');
const { THUMBNAIL_CACHE_DIR, getThumbnailCachePath } = require('./thumbnailCachePaths');
const { model } = require('./ollamaService');
const RestrictionPromptService = require('./restrictionPromptService');
const responseLogPath = path.join('/app', 'data', 'logs', 'response.txt');

class OpenAIService {
  constructor() {
    this.client = null;
  }

  initialize() {
    if (!this.client && config.aiProvider === 'ollama') {
      this.client = new OpenAI({
        baseURL: config.ollama.apiUrl + '/v1',
        // Ollama ignores the key unless the endpoint enforces auth (e.g. a
        // reverse proxy); the OpenAI SDK requires a non-empty value.
        apiKey: config.ollama.apiKey || 'ollama'
      });
    } else if (!this.client && config.aiProvider === 'custom') {
      this.client = new OpenAI({
        baseURL: config.custom.apiUrl,
        apiKey: config.custom.apiKey
      });
    } else if (!this.client && config.aiProvider === 'openai') {
      if (!this.client && config.openai.apiKey) {
        this.client = new OpenAI({
          apiKey: config.openai.apiKey
        });
      }
    }
  }

  async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], existingDocumentTypesList = [], id, customPrompt = null, options = {}) {
    const cachePath = getThumbnailCachePath(id);
    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

      if (!this.client) {
        throw new Error('OpenAI client not initialized');
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
      const model = process.env.OPENAI_MODEL;

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

      // Get system prompt and model
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

      if (customPrompt) {
        console.log('[DEBUG] Replace system prompt with custom prompt via WebHook');
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

      await writePromptToFile(systemPrompt, truncatedContent);

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
        ...(model !== 'o3-mini' && { temperature: config.aiTemperatureAnalysis }),
      });

      const message = response?.choices?.[0]?.message;
      let jsonContent = extractChatMessageContent(message, 'OpenAI');
      if (!jsonContent) {
        throw new Error('Invalid API response structure');
      }

      console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      // Strip <think>...</think> reasoning tags from models like Qwen3, DeepSeek-R1
      jsonContent = jsonContent.replace(/<think>[\s\S]*?<\/think>/g, '');
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
      } catch (error) {
        console.error(`Failed to parse JSON response: ${error.message}`); console.debug(error);
        // Check if the response indicates the content is too minimal or API can't process it
        if (jsonContent && (jsonContent.toLowerCase().includes("i'm sorry") ||
            jsonContent.toLowerCase().includes("i cannot") ||
            jsonContent.toLowerCase().includes("insufficient"))) {
          console.warn(`Document ${id} has insufficient content for analysis`);
          // Return a default structure instead of throwing to prevent retry loops
          return {
            document: {
              tags: [],
              correspondent: "Unknown",
              title: `Document ${id}`,
              document_date: new Date().toISOString().split('T')[0],
              document_type: "Document",
              language: "und"
            },
            metrics: mappedUsage,
            truncated: false,
            error: 'Insufficient content for AI analysis'
          };
        }
        throw new Error('Invalid JSON response from API');
      }

      try {
        await fs.mkdir(path.dirname(responseLogPath), { recursive: true });
        await fs.appendFile(responseLogPath, `${jsonContent}\n`);
      } catch (logError) {
        console.warn('Failed to write AI response log:', logError.message);
      }

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
    const dataTokens = await calculateTokens(dataString, process.env.OPENAI_MODEL);

    if (dataTokens > maxTokens) {
      console.warn(`[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`);
      return await truncateToTokenLimit(dataString, maxTokens, process.env.OPENAI_MODEL);
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
        throw new Error('OpenAI client not initialized - missing API key');
      }

      // Calculate total prompt tokens including musthavePrompt
      const totalPromptTokens = await calculateTotalPromptTokens(
        prompt + musthavePrompt // Combined system prompt
      );

      // Calculate available tokens
      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens); // Reserve for response
      const availableTokens = maxTokens - reservedTokens;

      // Truncate content if necessary
      const truncatedContent = await truncateToTokenLimit(content, availableTokens);
      const model = process.env.OPENAI_MODEL;
      // Make API request
      const response = await this.client.chat.completions.create({
        model: model,
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
        ...(model !== 'o3-mini' && { temperature: config.aiTemperatureAnalysis }),
      });

      // Handle response
      const message = response?.choices?.[0]?.message;
      let jsonContent = extractChatMessageContent(message, 'OpenAI');
      if (!jsonContent) {
        throw new Error('Invalid API response structure');
      }

      // Log token usage
      console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      // Strip <think>...</think> reasoning tags from models like Qwen3, DeepSeek-R1
      jsonContent = jsonContent.replace(/<think>[\s\S]*?<\/think>/g, '');
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
      } catch (error) {
        console.error(`Failed to parse JSON response: ${error.message}`); console.debug(error);
        // Check if the response indicates the content is too minimal or API can't process it
        if (jsonContent && (jsonContent.toLowerCase().includes("i'm sorry") ||
            jsonContent.toLowerCase().includes("i cannot") ||
            jsonContent.toLowerCase().includes("insufficient"))) {
          console.warn('Document has insufficient content for analysis');
          // Return a default structure instead of throwing to prevent retry loops
          return {
            document: {
              tags: [],
              correspondent: "Unknown",
              title: "Document",
              document_date: new Date().toISOString().split('T')[0],
              document_type: "Document",
              language: "und"
            },
            metrics: mappedUsage,
            truncated: false,
            error: 'Insufficient content for AI analysis'
          };
        }
        throw new Error('Invalid JSON response from API');
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
        throw new Error('OpenAI client not initialized - missing API key');
      }

      const model = process.env.OPENAI_MODEL || config.openai.model;

      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: config.aiTemperatureGeneration
      });

      const generatedText = extractChatMessageContent(response?.choices?.[0]?.message, 'OpenAI');
      if (!generatedText) {
        throw new Error('Invalid API response structure');
      }

      return generatedText;
    } catch (error) {
      console.error(`Error generating text with OpenAI: ${error.message}`); console.debug(error);
      throw error;
    }
  }

  async checkStatus() {
    // Use a token-free endpoint for connectivity/auth checks.
    try {
      this.initialize();

      if (!this.client) {
        throw new Error('OpenAI client not initialized - missing API key');
      }

      await this.client.models.list();
      return { status: 'ok', model: process.env.OPENAI_MODEL };
    } catch (error) {
      console.error(`Error checking OpenAI status: ${error.message}`); console.debug(error);
      return { status: 'error', error: error.message };
    }
  }
}

module.exports = new OpenAIService();
