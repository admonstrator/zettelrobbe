// services/mistralOcrService.js
//
// Mistral OCR Service – Downloads a document from Paperless-ngx as PDF,
// sends it to the Mistral OCR API (mistral-ocr-latest), and attempts to
// write the extracted markdown text back to Paperless-ngx via PATCH.
// Falls back to storing the OCR text locally in the ocr_queue table when
// the Paperless PATCH endpoint does not allow writing the content field.

const axios = require('axios');
const config = require('../config/config');
const PaperlessService = require('./paperlessService');
const documentModel = require('../models/document');
const AIServiceFactory = require('./aiServiceFactory');

class MistralOcrService {
  constructor() {
    this.activeDocumentIds = new Set();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  get apiKey() {
    return config.mistralOcr?.apiKey || process.env.MISTRAL_API_KEY || '';
  }

  get model() {
    return config.mistralOcr?.model || 'mistral-ocr-latest';
  }

  get provider() {
    const normalizedProvider = String(config.mistralOcr?.provider || 'mistral').trim().toLowerCase();
    return (normalizedProvider === 'ollama' || normalizedProvider === 'custom') ? 'ollama' : 'mistral';
  }

  get apiBase() {
    if (this.provider === 'ollama') {
      const ollamaDefault = config.ollama?.apiUrl || process.env.OLLAMA_API_URL || 'http://localhost:11434';
      return String(config.mistralOcr?.apiUrl || ollamaDefault).replace(/\/+$/, '');
    }

    return String(config.mistralOcr?.apiUrl || 'https://api.mistral.ai/v1').replace(/\/+$/, '');
  }

  isEnabled() {
    return config.mistralOcr?.enabled === 'yes';
  }

  isDocumentActivelyProcessing(documentId) {
    const normalizedDocumentId = Number(documentId);
    return Number.isInteger(normalizedDocumentId) && this.activeDocumentIds.has(normalizedDocumentId);
  }

  async recoverInterruptedJobs(logger = console) {
    const processingItems = await documentModel.getOcrQueue('processing');
    const recoverableItems = processingItems.filter(
      (item) => !this.isDocumentActivelyProcessing(item.document_id)
    );

    if (recoverableItems.length === 0) {
      logger.log('[OCR] No stale OCR queue items found at startup.');
      return {
        recovered: 0,
        documentIds: []
      };
    }

    const documentIds = recoverableItems.map((item) => item.document_id);
    const recovered = await documentModel.resetOcrQueueItemsToPending(documentIds);

    logger.warn(
      `[OCR] Recovered ${recovered} stale OCR queue item(s) stuck in processing: ${documentIds.join(', ')}`
    );

    return {
      recovered,
      documentIds
    };
  }

  // ── Core Methods ─────────────────────────────────────────────────────────

  /**
   * Download document from Paperless-ngx as a base64-encoded PDF/file.
   * @param {number} documentId
   * @returns {Promise<{base64: string, mimeType: string}>}
   */
  async downloadDocumentAsBase64(documentId) {
    PaperlessService.initialize();
    const response = await PaperlessService.client.get(
      `/documents/${documentId}/download/`,
      { responseType: 'arraybuffer' }
    );
    const mimeType = response.headers['content-type'] || 'application/pdf';
    const base64 = Buffer.from(response.data).toString('base64');
    return { base64, mimeType };
  }

  /**
   * Send a base64-encoded document to Mistral OCR and return concatenated markdown.
   * @param {string} base64 - base64-encoded document
   * @param {string} mimeType - MIME type of the document
   * @returns {Promise<string>} - Extracted text as markdown
   */
  async performOcr(base64, mimeType = 'application/pdf', documentId = null) {
    if (this.provider === 'ollama') {
      return this.performOcrWithOllama(base64, mimeType, documentId);
    }

    return this.performOcrWithMistral(base64, mimeType);
  }

  async performOcrWithMistral(base64, mimeType = 'application/pdf') {
    if (!this.apiKey) {
      throw new Error('MISTRAL_API_KEY is not configured');
    }

    const documentUrl = `data:${mimeType};base64,${base64}`;

    const response = await axios.post(
      `${this.apiBase}/ocr`,
      {
        model: this.model,
        document: {
          type: 'document_url',
          document_url: documentUrl
        },
        include_image_base64: false
      },
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000 // 2 minute timeout for large documents
      }
    );

    const pages = response.data?.pages || [];
    if (pages.length === 0) {
      throw new Error('Mistral OCR returned no pages');
    }

    return pages.map(p => p.markdown || '').join('\n\n').trim();
  }

  async performOcrWithOllama(base64, mimeType = 'application/pdf', documentId = null) {
    let imageBase64 = base64;
    let imageMimeType = mimeType;

    if (!String(mimeType).toLowerCase().startsWith('image/')) {
      if (!Number.isInteger(Number(documentId))) {
        throw new Error('Ollama OCR requires an image input or a valid document ID for thumbnail fallback');
      }

      const thumbnailBuffer = await PaperlessService.getThumbnailImage(Number(documentId));
      if (!thumbnailBuffer) {
        throw new Error('Could not fetch thumbnail image for Ollama OCR');
      }

      imageBase64 = thumbnailBuffer.toString('base64');
      imageMimeType = 'image/png';
    }

    const normalizedApiBase = String(this.apiBase || '').replace(/\/+$/, '');
    const isOpenAiCompatible = /\/v1$/i.test(normalizedApiBase);
    const imageDataUrl = `data:${imageMimeType};base64,${imageBase64}`;
    const authHeaders = this.apiKey
      ? {
        'Authorization': `Bearer ${this.apiKey}`
      }
      : {};

    const response = isOpenAiCompatible
      ? await axios.post(
        `${normalizedApiBase}/chat/completions`,
        {
          model: this.model,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Perform OCR on this image. Return only the extracted text in plain text. Do not add explanations.'
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageDataUrl
                  }
                }
              ]
            }
          ]
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders
          },
          timeout: 120000
        }
      )
      : await axios.post(
        `${normalizedApiBase}/api/chat`,
        {
          model: this.model,
          stream: false,
          messages: [
            {
              role: 'user',
              content: 'Perform OCR on this image. Return only the extracted text in plain text. Do not add explanations.',
              images: [imageBase64]
            }
          ],
          options: {
            temperature: 0
          }
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders
          },
          timeout: 120000
        }
      );

    const ocrText = isOpenAiCompatible
      ? String(response.data?.choices?.[0]?.message?.content || '').trim()
      : String(response.data?.message?.content || '').trim();
    if (!ocrText) {
      throw new Error(`Local OCR returned empty output for ${imageMimeType}`);
    }

    return ocrText;
  }

  /**
   * Attempt to write OCR text back to Paperless-ngx via PATCH.
   * Returns true if successful, false if Paperless rejected the write
   * (in which case the caller should store the text locally).
   * @param {number} documentId
   * @param {string} ocrText
   * @returns {Promise<boolean>}
   */
  async writeBackContent(documentId, ocrText) {
    try {
      PaperlessService.initialize();
      await PaperlessService.client.patch(`/documents/${documentId}/`, {
        content: ocrText
      });
      console.log(`[OCR] Successfully wrote OCR text back to Paperless for document ${documentId}`);
      return true;
    } catch (error) {
      const status = error.response?.status;
      console.warn(
        `[OCR] Could not write OCR text to Paperless for document ${documentId} ` +
        `(HTTP ${status || 'unknown'}). Text stored locally only.`
      );
      return false;
    }
  }

  /**
   * Full OCR pipeline for a single queue item.
   * Emits progress events via the optional progressCallback(step, message).
   *
   * Steps: 'download' | 'ocr' | 'writeback' | 'ai' | 'done' | 'error'
   *
   * @param {number} documentId
   * @param {object} opts
   * @param {boolean} [opts.autoAnalyze=false] - Run AI analysis after OCR
   * @param {Function} [opts.progressCallback] - (step, message, data?) => void
   * @returns {Promise<{ocrText: string, wroteBack: boolean, aiAnalysis?: object}>}
   */
  async processQueueItem(documentId, opts = {}) {
    const { autoAnalyze = false, progressCallback = null } = opts;
    const normalizedDocumentId = Number(documentId);
    const emit = (step, message, data = {}) => {
      if (progressCallback) progressCallback(step, message, data);
    };

    if (!Number.isInteger(normalizedDocumentId) || normalizedDocumentId <= 0) {
      throw new Error('Invalid OCR document ID');
    }

    if (this.isDocumentActivelyProcessing(normalizedDocumentId)) {
      throw new Error(`Document ${normalizedDocumentId} is already being processed`);
    }

    this.activeDocumentIds.add(normalizedDocumentId);

    let fallbackTitle = `Document ${normalizedDocumentId}`;
    let terminalFailureRecorded = false;
    const recordTerminalFailure = async (reason, source = 'ocr') => {
      if (terminalFailureRecorded) return;
      await documentModel.addFailedDocument(normalizedDocumentId, fallbackTitle, reason, source);
      terminalFailureRecorded = true;
    };

    try {
      const queueItem = await documentModel.getOcrQueueItem(normalizedDocumentId);
      fallbackTitle = queueItem?.title || fallbackTitle;

      await documentModel.updateOcrQueueStatus(normalizedDocumentId, 'processing');

      // Step 1: Download
      emit('download', `Downloading document ${normalizedDocumentId} from Paperless-ngx…`);
      let base64, mimeType;
      try {
        ({ base64, mimeType } = await this.downloadDocumentAsBase64(normalizedDocumentId));
      } catch (dlErr) {
        throw new Error(`Download failed: ${dlErr.message}`);
      }
      emit('download', `Download complete (${mimeType}).`);

      // Step 2: OCR
      const providerLabel = this.provider === 'ollama' ? 'Local OCR' : 'Mistral OCR';
      emit('ocr', `Sending document to ${providerLabel}…`);
      let ocrText;
      try {
        ocrText = await this.performOcr(base64, mimeType, normalizedDocumentId);
      } catch (ocrErr) {
        throw new Error(`${providerLabel} failed: ${ocrErr.message}`);
      }
      const previewLen = Math.min(ocrText.length, 120);
      emit('ocr', `OCR complete. Extracted ${ocrText.length} characters.`, {
        preview: ocrText.substring(0, previewLen)
      });

      // Step 3: Write back
      emit('writeback', 'Writing OCR text back to Paperless-ngx…');
      const wroteBack = await this.writeBackContent(normalizedDocumentId, ocrText);
      if (wroteBack) {
        emit('writeback', 'OCR text successfully written to Paperless-ngx.');
      } else {
        emit('writeback', 'Paperless-ngx does not allow writing content. OCR text stored locally.');
      }

      // Persist result in queue
      await documentModel.updateOcrQueueStatus(normalizedDocumentId, 'done', ocrText);

      let aiResult = null;
      if (autoAnalyze) {
        emit('ai', 'Starting AI analysis with OCR text…');
        try {
          aiResult = await this._runAiAnalysis(normalizedDocumentId, ocrText);
          emit('ai', 'AI analysis complete.');
        } catch (aiErr) {
          await recordTerminalFailure('ai_failed_after_ocr', 'ai');
          await documentModel.updateOcrQueueStatus(normalizedDocumentId, 'failed', ocrText);
          throw new Error(`AI analysis failed after OCR: ${aiErr.message}`);
        }
      }

      if (!autoAnalyze || aiResult) {
        await documentModel.resetFailedDocument(normalizedDocumentId);
      }

      emit('done', 'Processing finished successfully.');
      return { ocrText, wroteBack, aiAnalysis: aiResult };

    } catch (error) {
      await documentModel.updateOcrQueueStatus(normalizedDocumentId, 'failed');
      await recordTerminalFailure('ocr_failed', 'ocr');
      emit('error', error.message);
      throw error;
    } finally {
      this.activeDocumentIds.delete(normalizedDocumentId);
    }
  }

  /**
   * Run AI analysis only, using existing OCR text.
   * Does not trigger any OCR download/API calls.
   *
   * @param {number} documentId
   * @param {string} ocrText
   * @param {Function} [progressCallback] - (step, message, data?) => void
   * @returns {Promise<object>} AI analysis result
   */
  async analyzeFromExistingOcrText(documentId, ocrText, progressCallback = null) {
    const emit = (step, message, data = {}) => {
      if (progressCallback) progressCallback(step, message, data);
    };

    if (typeof ocrText !== 'string' || !ocrText.trim()) {
      throw new Error('No OCR text available for AI analysis');
    }

    emit('ai', `Starting AI analysis for document ${documentId} using stored OCR text…`);
    try {
      const aiResult = await this._runAiAnalysis(documentId, ocrText);
      await documentModel.resetFailedDocument(documentId);
      emit('ai', 'AI analysis complete.');
      emit('done', 'AI-only processing finished successfully.');
      return aiResult;
    } catch (error) {
      const queueItem = await documentModel.getOcrQueueItem(documentId);
      const fallbackTitle = queueItem?.title || `Document ${documentId}`;
      await documentModel.addFailedDocument(documentId, fallbackTitle, 'ai_failed_after_ocr', 'ai');
      emit('error', `AI analysis failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Run AI analysis on a document using OCR text (instead of Paperless content).
   * Mirrors the processDocument / buildUpdateData / saveDocumentChanges flow
   * from server.js but accepts pre-extracted text.
   * @private
   */
  async _runAiAnalysis(documentId, ocrText) {
    const [existingTags, existingCorrespondentList, existingDocumentTypes, originalData] = await Promise.all([
      PaperlessService.getTags(),
      PaperlessService.listCorrespondentsNames(),
      PaperlessService.listDocumentTypesNames(),
      PaperlessService.getDocument(documentId)
    ]);

    const existingTagNames = existingTags.map(t => t.name);
    const correspondentNames = existingCorrespondentList.map(c => c.name);
    const documentTypeNames = existingDocumentTypes.map(d => d.name);

    // Truncate to 50 000 chars as in normal flow
    const contentForAi = ocrText.length > 50000 ? ocrText.substring(0, 50000) : ocrText;

    const aiService = AIServiceFactory.getService();
    const analysis = await aiService.analyzeDocument(
      contentForAi,
      existingTagNames,
      correspondentNames,
      documentTypeNames,
      documentId
    );

    if (analysis.error) {
      throw new Error(analysis.error);
    }

    // Build update data (simplified – reuse paperlessService helpers)
    const updateData = {};
    const { validateCustomFieldValue } = require('./serviceUtils');
    const config = require('../config/config');
    const options = {
      restrictToExistingTags: config.restrictToExistingTags === 'yes',
      restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes',
      restrictToExistingDocumentTypes: config.restrictToExistingDocumentTypes === 'yes'
    };

    if (config.limitFunctions?.activateTagging !== 'no') {
      const { tagIds } = await PaperlessService.processTags(analysis.document.tags, options);
      updateData.tags = tagIds;
    }
    if (config.limitFunctions?.activateTitle !== 'no') {
      updateData.title = analysis.document.title || originalData.title;
    }
    updateData.created = analysis.document.document_date || originalData.created;
    if (config.limitFunctions?.activateDocumentType !== 'no' && analysis.document.document_type) {
      const dt = await PaperlessService.getOrCreateDocumentType(analysis.document.document_type, options);
      if (dt) updateData.document_type = dt.id;
    }
    if (config.limitFunctions?.activateCorrespondents !== 'no' && analysis.document.correspondent) {
      const corr = await PaperlessService.getOrCreateCorrespondent(analysis.document.correspondent, options);
      if (corr) updateData.correspondent = corr.id;
    }
    if (analysis.document.language) {
      updateData.language = analysis.document.language;
    }

    // Apply updates to Paperless
    const updatedDocument = await PaperlessService.updateDocument(documentId, updateData);
    if (!updatedDocument) {
      throw new Error(`Paperless update failed for document ${documentId}`);
    }

    // Persist metrics & history
    if (analysis.metrics) {
      await documentModel.addOpenAIMetrics(
        documentId,
        analysis.metrics.promptTokens,
        analysis.metrics.completionTokens,
        analysis.metrics.totalTokens
      );
    }
    await documentModel.addProcessedDocument(documentId, updateData.title || originalData.title);
    await documentModel.addToHistory(
      documentId,
      updateData.tags || [],
      updateData.title || originalData.title,
      analysis.document.correspondent,
      null,
      analysis.document.document_type || null,
      analysis.document.language || null
    );

    return analysis;
  }
}

module.exports = new MistralOcrService();
