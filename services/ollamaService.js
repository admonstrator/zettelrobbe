const { writePromptToFile, toNameList } = require('./serviceUtils');
const { hasNumber, hasSystemPrompt } = require('./aiGenerateOptions');
const axios = require('axios');
const config = require('../config/config');
const fs = require('fs').promises;
const paperlessService = require('./paperlessService');
const os = require('os');
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('./thumbnailCachePaths');
const RestrictionPromptService = require('./restrictionPromptService');

/**
 * Service for document analysis using Ollama
 */
class OllamaService {
  /**
   * Initialize the Ollama service
   */
  constructor() {
    this.apiUrl = config.ollama.apiUrl;
    this.model = config.ollama.model;
    this.client = axios.create({
      timeout: 1800000, // 30 minutes timeout
    });

    // JSON schema for document analysis output
    this.documentAnalysisSchema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        correspondent: { type: 'string' },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
        document_type: { type: 'string' },
        document_date: { type: 'string' },
        language: { type: 'string' },
        custom_fields: {
          type: 'object',
          additionalProperties: true,
        },
      },
      required: [
        'title',
        'correspondent',
        'tags',
        'document_type',
        'document_date',
        'language',
      ],
    };

    // Schema for playground analysis (simpler version)
    this.playgroundSchema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        correspondent: { type: 'string' },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
        document_type: { type: 'string' },
        document_date: { type: 'string' },
        language: { type: 'string' },
      },
      required: [
        'title',
        'correspondent',
        'tags',
        'document_type',
        'document_date',
        'language',
      ],
    };
  }

  /**
   * Analyze a document and extract metadata
   * @param {string} content - Document content
   * @param {Array} existingTags - List of existing tags
   * @param {Array} existingCorrespondentList - List of existing correspondents
   * @param {string} id - Document ID
   * @param {string} customPrompt - Custom prompt (optional)
   * @returns {Object} Analysis results
   */
  async analyzeDocument(
    content,
    existingTags = [],
    existingCorrespondentList = [],
    existingDocumentTypesList = [],
    id,
    customPrompt = null,
    options = {}
  ) {
    try {
      // Truncate content if needed
      content = this._truncateContent(content);

      // Cache thumbnail
      await this._handleThumbnailCaching(id);

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

      // Build prompt
      let prompt;
      if (!customPrompt) {
        prompt = this._buildPrompt(
          content,
          existingTags,
          existingCorrespondentList,
          existingDocumentTypesList,
          options
        );
      } else {
        // Parse CUSTOM_FIELDS for custom prompt
        let customFieldsObj;
        try {
          customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
        } catch (error) {
          console.error(`Failed to parse CUSTOM_FIELDS: ${error.message}`);
          console.debug(error);
          customFieldsObj = { custom_fields: [] };
        }

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

        const customFieldsStr =
          '"custom_fields": ' +
          JSON.stringify(customFieldsTemplate, null, 2)
            .split('\n')
            .map((line) => '    ' + line)
            .join('\n');

        prompt =
          customPrompt +
          '\n\n' +
          config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr) +
          '\n\n' +
          JSON.stringify(content);
        console.log('[DEBUG] Ollama Service started with custom prompt');
      }

      // Generate custom fields for the prompt
      const customFieldsStr = this._generateCustomFieldsTemplate();

      // Generate system prompt
      const systemPrompt = this._generateSystemPrompt(customFieldsStr);

      // Calculate context window size
      const promptTokenCount = this._calculatePromptTokenCount(prompt);
      const numCtx = this._calculateNumCtx(
        promptTokenCount,
        Number(config.responseTokens)
      );

      console.log(
        `[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`
      );
      console.log(
        `[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`
      );

      // Call Ollama API
      const response = await this._callOllamaAPI(
        prompt,
        systemPrompt,
        numCtx,
        this.documentAnalysisSchema
      );

      // Process response
      const parsedResponse = this._processOllamaResponse(response);
      const metrics = this._extractOllamaMetrics(response);

      // Check for missing data
      if (
        parsedResponse.tags.length === 0 &&
        parsedResponse.correspondent === null
      ) {
        console.warn(
          'No tags or correspondent found in response from Ollama for Document. Please review your prompt or switch to OpenAI for better results.'
        );
      }

      // Log the prompt and response
      await this._logPromptAndResponse(prompt, parsedResponse);

      // Return results in consistent format
      return {
        document: parsedResponse,
        metrics,
        truncated: false,
      };
    } catch (error) {
      console.error(`Error analyzing document with Ollama: ${error.message}`);
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
   * Analyze a document in playground mode
   * @param {string} content - Document content
   * @param {string} prompt - User-provided prompt
   * @returns {Object} Analysis results
   */
  async analyzePlayground(content, prompt) {
    try {
      // Calculate context window size — include both prompt and content
      const fullPrompt = prompt + '\n\n' + JSON.stringify(content);
      const promptTokenCount = this._calculatePromptTokenCount(fullPrompt);
      const numCtx = this._calculateNumCtx(
        promptTokenCount,
        Number(config.responseTokens)
      );

      // Generate playground system prompt (simpler than full analysis)
      const systemPrompt = this._generatePlaygroundSystemPrompt();

      // Call Ollama API
      const response = await this._callOllamaAPI(
        fullPrompt,
        systemPrompt,
        numCtx,
        this.playgroundSchema
      );

      // Process response
      const parsedResponse = this._processOllamaResponse(response);
      const metrics = this._extractOllamaMetrics(response);

      // Check for missing data
      if (
        parsedResponse.tags.length === 0 &&
        parsedResponse.correspondent === null
      ) {
        console.warn(
          'No tags or correspondent found in response from Ollama for Document. Please review your prompt or switch to OpenAI for better results.'
        );
      }

      // Return results in consistent format
      return {
        document: parsedResponse,
        metrics,
        truncated: false,
      };
    } catch (error) {
      console.error(`Error analyzing document with Ollama: ${error.message}`);
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
   * Truncate content to maximum length if specified
   * @param {string} content - Content to truncate
   * @returns {string} Truncated content
   */
  _truncateContent(content) {
    try {
      if (process.env.CONTENT_MAX_LENGTH) {
        console.log(
          'Truncating content to max length:',
          process.env.CONTENT_MAX_LENGTH
        );
        return content.substring(0, process.env.CONTENT_MAX_LENGTH);
      }
    } catch (error) {
      console.error(`Error truncating content: ${error.message}`);
      console.debug(error);
    }
    return content;
  }

  /**
   * Build prompt from content and existing data
   * @param {string} content - Document content
   * @param {Array} existingTags - List of existing tags
   * @param {Array} existingCorrespondent - List of existing correspondents
   * @param {Array} existingDocumentTypes - List of existing document types
   * @returns {string} Formatted prompt
   */
  _buildPrompt(
    content,
    existingTags = [],
    existingCorrespondent = [],
    existingDocumentTypes = [],
    options = {}
  ) {
    let systemPrompt;

    // Validate that existingCorrespondent is an array and handle if it's not
    const correspondentList = Array.isArray(existingCorrespondent)
      ? existingCorrespondent
      : [];

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
      // Format existing data - callers may hand over entity objects or plain names
      const existingTagsList = toNameList(existingTags).join(', ');
      const existingCorrespondentList =
        toNameList(correspondentList).join(', ');
      const existingDocumentTypesList = toNameList(existingDocumentTypes).join(
        ', '
      );

      systemPrompt =
        `
            Pre-existing tags: ${existingTagsList}\n\n
            Pre-existing correspondents: ${existingCorrespondentList}\n\n
            Pre-existing document types: ${existingDocumentTypesList}\n\n
            ` +
        process.env.SYSTEM_PROMPT +
        '\n\n' +
        config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
    } else {
      const mustHavePrompt = config.mustHavePrompt.replace(
        '%CUSTOMFIELDS%',
        customFieldsStr
      );
      systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + mustHavePrompt;
    }

    // Get validated external API data if available
    let validatedExternalApiData = null;
    if (options.externalApiData) {
      try {
        validatedExternalApiData = this._validateAndTruncateExternalApiData(
          options.externalApiData
        );
        console.log('[DEBUG] External API data validated and included');
      } catch (error) {
        console.warn(
          '[WARNING] External API data validation failed:',
          error.message
        );
        validatedExternalApiData = null;
      }
    }

    // Process placeholder replacements in system prompt
    systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
      systemPrompt,
      existingTags,
      correspondentList,
      existingDocumentTypes
    );

    // Include validated external API data if available
    if (validatedExternalApiData) {
      systemPrompt += `\n\nAdditional context from external API:\n${validatedExternalApiData}`;
    }

    if (process.env.USE_PROMPT_TAGS === 'yes') {
      systemPrompt =
        `
            Take these tags and try to match one or more to the document content.\n\n
            ` + config.specialPromptPreDefinedTags;
    }

    return `${systemPrompt}
        ${JSON.stringify(content)}
        `;
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

    // Calculate tokens for the data (conservative 2 chars/token for non-English)
    const dataTokens = Math.ceil(dataString.length / 2);

    if (dataTokens > maxTokens) {
      console.warn(
        `[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`
      );
      // Simple truncation based on character count
      const maxChars = maxTokens * 2;
      return dataString.substring(0, maxChars);
    }

    console.log(`[DEBUG] External API data validated: ${dataTokens} tokens`);
    return dataString;
  }

  /**
   * Generate custom fields template for prompts
   * @returns {string} Custom fields template as a string
   */
  _generateCustomFieldsTemplate() {
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
    return (
      '"custom_fields": ' +
      JSON.stringify(customFieldsTemplate, null, 2)
        .split('\n')
        .map((line) => '    ' + line) // Add proper indentation
        .join('\n')
    );
  }

  /**
   * Generate system prompt for document analysis
   * @param {string} customFieldsStr - Custom fields as a string
   * @returns {string} System prompt
   */
  _generateSystemPrompt(customFieldsStr) {
    let systemPromptTemplate = `
            You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions. 
            YOU MUSTNOT: Ask for additional information or clarification, or ask questions about the document, or ask for additional context.
            YOU MUSTNOT: Return a response without the desired JSON format.
            YOU MUST: Return the result EXCLUSIVELY as a JSON object. The Tags, Title and Document_Type MUST be in the language that is used in the document.:
            IMPORTANT: The custom_fields are optional and can be left out if not needed, only try to fill out the values if you find a matching information in the document.
            Do not change the value of field_name, only fill out the values. If the field is about money only add the number without currency and always use a . for decimal places.
            {
                "title": "xxxxx",
                "correspondent": "xxxxxxxx",
                "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
                "document_type": "Invoice/Contract/...",
                "document_date": "YYYY-MM-DD",
                "language": "en/de/es/...",
                %CUSTOMFIELDS%
            }
            ALWAYS USE THE INFORMATION TO FILL OUT THE JSON OBJECT. DO NOT ASK BACK QUESTIONS.
        `;

    return systemPromptTemplate.replace('%CUSTOMFIELDS%', customFieldsStr);
  }

  /**
   * Generate system prompt for playground analysis
   * @returns {string} System prompt
   */
  _generatePlaygroundSystemPrompt() {
    return `
            You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions. 
            YOU MUSTNOT: Ask for additional information or clarification, or ask questions about the document, or ask for additional context.
            YOU MUSTNOT: Return a response without the desired JSON format.
            YOU MUST: Analyze the document content and extract the following information into this structured JSON format and only this format!:         {
            "title": "xxxxx",
            "correspondent": "xxxxxxxx",
            "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
            "document_type": "Invoice/Contract/...",
            "document_date": "YYYY-MM-DD",
            "language": "en/de/es/..."
            }
            ALWAYS USE THE INFORMATION TO FILL OUT THE JSON OBJECT. DO NOT ASK BACK QUESTIONS.
        `;
  }

  /**
   * Calculate prompt token count
   * @param {string} prompt - Prompt text
   * @returns {number} Estimated token count
   */
  _calculatePromptTokenCount(prompt) {
    // Use conservative 2 chars/token estimate to avoid truncation
    // with non-English models (CJK, German, etc.) where tokenization
    // produces roughly 2 chars per token instead of ~4 for English
    return Math.ceil(prompt.length / 2);
  }

  /**
   * Calculate context window size for Ollama
   * @param {number} promptTokenCount - Token count for prompt
   * @param {number} expectedResponseTokens - Expected response token count
   * @returns {number} Context window size
   */
  _calculateNumCtx(promptTokenCount, expectedResponseTokens) {
    const totalTokenUsage = promptTokenCount + expectedResponseTokens;
    const maxCtxLimit = Number(config.tokenLimit);

    const numCtx = Math.min(totalTokenUsage, maxCtxLimit);

    console.log('Prompt Token Count:', promptTokenCount);
    console.log('Expected Response Tokens:', expectedResponseTokens);
    console.log('Dynamic calculated num_ctx:', numCtx);

    return numCtx;
  }

  /**
   * Get available system memory
   * @returns {Object} Object with totalMemoryMB and freeMemoryMB
   */
  async _getAvailableMemory() {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const totalMemoryMB = (totalMemory / (1024 * 1024)).toFixed(0);
    const freeMemoryMB = (freeMemory / (1024 * 1024)).toFixed(0);
    return { totalMemoryMB, freeMemoryMB };
  }

  /**
   * Handle thumbnail caching for documents
   * @param {string} id - Document ID
   */
  async _handleThumbnailCaching(id) {
    if (!id) return;

    const cachePath = getThumbnailCachePath(id);
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
  }

  /**
   * Build request headers, adding bearer auth when an API key is set.
   * The key is read at request time so runtime config changes apply
   * without re-instantiating the singleton.
   * @returns {Object} Headers object
   */
  _buildRequestHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OLLAMA_API_KEY || config.ollama.apiKey || '';
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  /**
   * Call Ollama API
   * @param {string} prompt - Prompt text
   * @param {string} systemPrompt - System prompt
   * @param {number} numCtx - Context window size
   * @param {Object} schema - Response schema
   * @returns {Object} Ollama API response
   */
  async _callOllamaAPI(prompt, systemPrompt, numCtx, schema) {
    // The same number _calculateNumCtx() already reserved room for. It used to
    // be a hardcoded 256 while the reservation followed the setting, so the
    // context held space for an answer the model was then forbidden to write.
    const numPredict = Number(config.responseTokens);
    const requestBody = {
      model: this.model,
      prompt: prompt,
      system: systemPrompt,
      stream: false,
      format: schema,
      options: {
        temperature: config.aiTemperatureAnalysis,
        top_p: 0.9,
        repeat_penalty: 1.1,
        top_k: 7,
        num_predict: numPredict,
        num_ctx: numCtx,
      },
    };

    // Disable thinking for reasoning models (e.g. Qwen3, DeepSeek-R1)
    // unless explicitly enabled via OLLAMA_THINK=true
    if (!config.ollama.think) {
      requestBody.think = false;
    }

    const response = await this.client.post(
      `${this.apiUrl}/api/generate`,
      requestBody,
      {
        headers: this._buildRequestHeaders(),
      }
    );

    if (!response.data) {
      throw new Error('Invalid response from Ollama API');
    }

    this._assertNotTruncated(response.data, numPredict, numCtx);

    return response.data;
  }

  /**
   * A generation Ollama had to cut short comes back with done_reason "length".
   * What it returns is a prefix, and for structured output that means JSON
   * without its closing braces — which no amount of sanitizing recovers, so
   * there is nothing to do with it but say so.
   *
   * Two different limits produce the same done_reason and want opposite fixes:
   * num_predict is the response budget, but the context window can leave less
   * room than that, and then raising Response Tokens changes nothing. The
   * message names whichever one actually bit.
   *
   * @param {Object} responseData - Ollama /api/generate response
   * @param {number} numPredict - response token limit that was sent
   * @param {number} numCtx - context window that was sent
   */
  _assertNotTruncated(responseData, numPredict, numCtx) {
    const evalCount = Number(responseData?.eval_count) || 0;
    const promptEvalCount = Number(responseData?.prompt_eval_count) || 0;

    // done_reason is the direct signal. Reaching the limit exactly is the
    // fallback for an Ollama old enough not to send one.
    const stoppedOnLength =
      responseData?.done_reason === 'length' ||
      (!responseData?.done_reason && numPredict > 0 && evalCount >= numPredict);

    if (!stoppedOnLength) {
      return;
    }

    /* Which limit bit is read off the count itself rather than guessed from
       the context arithmetic: reaching num_predict exactly is the response
       budget, stopping short of it means the context filled up first. The
       arithmetic route was tried and got it backwards — _calculateNumCtx sizes
       the window from an estimate of the prompt (length / 4), so comparing it
       against the real prompt_eval_count blames the context for a run that
       generated its full budget. */
    const error =
      evalCount >= numPredict
        ? new Error(
            `Ollama stopped generating after ${evalCount} tokens, which is the configured response limit. Raise Response Tokens (RESPONSE_TOKENS) above ${numPredict}.`
          )
        : new Error(
            `Ollama stopped generating after ${evalCount} of ${numPredict} response tokens: the ${numCtx}-token context window was full, ${promptEvalCount} of it prompt. Raise Token Limit (TOKEN_LIMIT) or shorten the document.`
          );

    /* Carried as a code rather than matched out of the message later. The
       phrase-matching in serviceUtils classifies errors that arrive from
       elsewhere and have no better handle; this one is raised right here, so
       rewording it should not silently reclassify the failure. */
    error.code = 'ai_response_truncated';
    throw error;
  }

  /**
   * Process Ollama API response
   * @param {Object} responseData - Ollama API response data
   * @returns {Object} Parsed response
   */
  _processOllamaResponse(responseData) {
    // Check if we got a structured response or need to parse from text
    if (responseData.response && typeof responseData.response === 'object') {
      // We got a structured response directly
      console.log('Using structured output response');
      return {
        tags: Array.isArray(responseData.response.tags)
          ? responseData.response.tags
          : [],
        correspondent: responseData.response.correspondent || null,
        title: responseData.response.title || null,
        document_date: responseData.response.document_date || null,
        document_type: responseData.response.document_type || null,
        language: responseData.response.language || null,
        custom_fields: responseData.response.custom_fields || null,
      };
    } else if (responseData.response) {
      // Fall back to parsing from text response
      console.log('Falling back to text response parsing');
      return this._parseResponse(responseData.response);
    } else {
      throw new Error('No response data from Ollama API');
    }
  }

  /**
   * Extract token usage metrics from an Ollama /api/generate response.
   * @param {Object} responseData - Ollama API response data
   * @returns {{promptTokens:number, completionTokens:number, totalTokens:number}}
   */
  _extractOllamaMetrics(responseData) {
    const promptTokens = Number(responseData?.prompt_eval_count) || 0;
    const completionTokens = Number(responseData?.eval_count) || 0;

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  /**
   * Parse text response to extract JSON
   * @param {string} response - Response text
   * @returns {Object} Parsed object
   */
  /* Every exit from here either returns something the caller can use or
     throws. It used to hand back { tags: [], correspondent: null } on each of
     its three failure paths, which is indistinguishable from a model that
     genuinely found nothing — so a document whose answer could not be read at
     all was written back untouched and then marked processed, never to be
     looked at again. openaiService has thrown at the same point all along. */
  _parseResponse(response) {
    try {
      // Find JSON in response using regex
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        /* Worded to carry the marker serviceUtils already classifies, so a
           document whose answer was unreadable takes the same OCR fallback it
           takes under OpenAI. Truncation deliberately does not — see
           _assertNotTruncated, where a second pass cannot help. */
        throw new Error(
          'Invalid JSON response from API: no JSON object in the answer'
        );
      }

      let jsonStr = jsonMatch[0];
      console.log('Extracted JSON String:', jsonStr);

      try {
        // Attempt to parse the JSON
        const result = JSON.parse(jsonStr);

        // Validate and return the result
        return {
          tags: Array.isArray(result.tags) ? result.tags : [],
          correspondent: result.correspondent || null,
          title: result.title || null,
          document_date: result.document_date || null,
          document_type: result.document_type || null,
          language: result.language || null,
          custom_fields: result.custom_fields || null,
        };
      } catch (jsonError) {
        console.warn('Error parsing JSON from response:', jsonError.message);
        console.warn('Attempting to sanitize the JSON...');

        // Sanitize the JSON
        jsonStr = this._sanitizeJsonString(jsonStr);

        try {
          const sanitizedResult = JSON.parse(jsonStr);
          return {
            tags: Array.isArray(sanitizedResult.tags)
              ? sanitizedResult.tags
              : [],
            correspondent: sanitizedResult.correspondent || null,
            title: sanitizedResult.title || null,
            document_date: sanitizedResult.document_date || null,
            language: sanitizedResult.language || null,
          };
        } catch {
          console.error(
            'Final JSON parsing failed after sanitization. This happens when the JSON structure is too complex or invalid. That indicates an issue with the generated JSON string by Ollama. Switch to OpenAI for better results or fine tune your prompt.'
          );
          throw new Error(
            `Invalid JSON response from API, unreadable even after sanitizing: ${jsonError.message}`
          );
        }
      }
    } catch (error) {
      console.error('Error parsing Ollama response:', error.message);
      throw error;
    }
  }

  /**
   * Sanitize a JSON string
   * @param {string} jsonStr - JSON string to sanitize
   * @returns {string} Sanitized JSON string
   */
  _sanitizeJsonString(jsonStr) {
    return jsonStr
      .replace(/,\s*}/g, '}') // Remove trailing commas before closing braces
      .replace(/,\s*]/g, ']') // Remove trailing commas before closing brackets
      .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":'); // Ensure property names are quoted
  }

  /**
   * Log prompt and response to file
   * @param {string} prompt - Prompt text
   * @param {Object} response - Response object
   */
  async _logPromptAndResponse(prompt, response) {
    const content =
      '================================================================================' +
      prompt +
      '\n\n' +
      JSON.stringify(response) +
      '\n\n' +
      '================================================================================\n\n';

    await writePromptToFile(content);
  }

  /**
   * Generate text based on a prompt
   * @param {string} prompt - The prompt to generate text from
   * @param {object} [options] - Optional overrides for this one call
   * @param {string} [options.systemPrompt] - Replaces the generic system prompt
   * @param {number} [options.temperature] - Overrides AI_TEMPERATURE_GENERATION
   * @param {number} [options.maxTokens] - Overrides RESPONSE_TOKENS (num_predict)
   * @returns {Promise<string>} - The generated text
   */
  async generateText(prompt, options = {}) {
    try {
      const responseTokens =
        hasNumber(options.maxTokens) && options.maxTokens > 0
          ? Math.floor(options.maxTokens)
          : Number(config.responseTokens);

      // Calculate context window size based on prompt length
      const promptTokenCount = this._calculatePromptTokenCount(prompt);
      const numCtx = this._calculateNumCtx(promptTokenCount, responseTokens);

      // Simple system prompt for text generation; a caller that knows the job
      // better (the Duplicates review) brings its own.
      const systemPrompt = hasSystemPrompt(options)
        ? options.systemPrompt
        : `You are a helpful assistant. Generate a clear, concise, and informative response to the user's question or request.`;

      // Call Ollama API without enforcing a specific response format
      const generateTextBody = {
        model: this.model,
        prompt: prompt,
        system: systemPrompt,
        stream: false,
        options: {
          temperature: hasNumber(options.temperature)
            ? options.temperature
            : config.aiTemperatureGeneration,
          top_p: 0.9,
          // The line above reserves the same number in the context; a
          // constant here would have the same quarrel with it that the
          // analysis path had.
          num_predict: responseTokens,
          num_ctx: numCtx,
        },
      };

      // Disable thinking for reasoning models (e.g. Qwen3, DeepSeek-R1)
      // unless explicitly enabled via OLLAMA_THINK=true
      if (!config.ollama.think) {
        generateTextBody.think = false;
      }

      const response = await this.client.post(
        `${this.apiUrl}/api/generate`,
        generateTextBody,
        {
          headers: this._buildRequestHeaders(),
        }
      );

      if (!response.data || !response.data.response) {
        throw new Error('Invalid response from Ollama API');
      }

      // Ollama reports its token counts on the answer itself; the callers
      // that care (the Duplicates review) read them off the service after
      // the call, so the return value stays a plain string.
      const promptTokens = Number(response.data.prompt_eval_count);
      const completionTokens = Number(response.data.eval_count);
      this.lastGenerateTextUsage =
        Number.isFinite(promptTokens) || Number.isFinite(completionTokens)
          ? {
              promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
              completionTokens: Number.isFinite(completionTokens)
                ? completionTokens
                : null,
              totalTokens:
                (Number.isFinite(promptTokens) ? promptTokens : 0) +
                (Number.isFinite(completionTokens) ? completionTokens : 0),
            }
          : null;

      return response.data.response;
    } catch (error) {
      this.lastGenerateTextUsage = null;
      console.error(`Error generating text with Ollama: ${error.message}`);
      console.debug(error);
      throw error;
    }
  }

  /**
   * Check if the Ollama service is running
   * @returns {Promise<boolean>} - True if the service is running, false otherwise
   */
  async checkStatus() {
    // use ollama status endpoint
    try {
      const response = await this.client.get(`${this.apiUrl}/api/ps`, {
        headers: this._buildRequestHeaders(),
      });
      if (response.status === 200) {
        const data = response.data;
        // Ensure data is an array and has at least one model
        let modelName = null;
        if (Array.isArray(data.models) && data.models.length > 0) {
          modelName = data.models[0].name;
        }
        console.log('Ollama model name:', modelName);
        return { status: 'ok', model: modelName };
      }
    } catch (error) {
      console.error(`Error checking Ollama service status: ${error.message}`);
      console.debug(error);
    }
    return { status: 'error' };
  }
}

module.exports = new OllamaService();
