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
const popplerService = require('./popplerService');
const documentModel = require('../models/document');
const AIServiceFactory = require('./aiServiceFactory');
const { isTimeoutError, buildTimeoutErrorMessage } = require('./serviceUtils');

class MistralOcrService {
  constructor() {
    this.activeDocumentIds = new Set();
    this.detectedLocalApiBase = null;
    this.detectedLocalApiMode = null;
    this.localApiDetectionPromise = null;
    this.pdfRenderUnavailableLogged = false;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  get apiKey() {
    const configuredKey =
      config.mistralOcr?.apiKey || process.env.MISTRAL_API_KEY || '';
    if (configuredKey || this.provider !== 'ollama') {
      return configuredKey;
    }

    // Local OCR without a dedicated key: reuse the Ollama bearer token so a
    // token-protected Ollama host works for OCR without duplicate config.
    return process.env.OLLAMA_API_KEY || config.ollama?.apiKey || '';
  }

  get model() {
    return config.mistralOcr?.model || 'mistral-ocr-latest';
  }

  get provider() {
    const normalizedProvider = String(config.mistralOcr?.provider || 'mistral')
      .trim()
      .toLowerCase();
    return normalizedProvider === 'ollama' || normalizedProvider === 'custom'
      ? 'ollama'
      : 'mistral';
  }

  get apiBase() {
    if (this.provider === 'ollama') {
      const ollamaDefault =
        config.ollama?.apiUrl ||
        process.env.OLLAMA_API_URL ||
        'http://localhost:11434';
      return String(config.mistralOcr?.apiUrl || ollamaDefault).replace(
        /\/+$/,
        ''
      );
    }

    return String(
      config.mistralOcr?.apiUrl || 'https://api.mistral.ai/v1'
    ).replace(/\/+$/, '');
  }

  isEnabled() {
    return config.mistralOcr?.enabled === 'yes';
  }

  get ocrTimeoutMs() {
    const raw =
      process.env.SETUP_OCR_VALIDATION_TIMEOUT_MS ||
      process.env.SETUP_VALIDATION_TIMEOUT_MS ||
      '120000';
    const parsed = Number.parseInt(String(raw).trim(), 10);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 120000;
  }

  get pdfRenderEnabled() {
    return config.mistralOcr?.pdfRenderEnabled === 'yes';
  }

  get pdfRenderMaxPages() {
    const parsed = Number.parseInt(
      String(config.mistralOcr?.pdfRenderMaxPages ?? ''),
      10
    );
    if (!Number.isFinite(parsed)) {
      return 10;
    }
    return Math.min(Math.max(parsed, 1), 50);
  }

  get pdfRenderDpi() {
    const parsed = Number.parseInt(
      String(config.mistralOcr?.pdfRenderDpi ?? ''),
      10
    );
    if (!Number.isFinite(parsed)) {
      return 150;
    }
    return Math.min(Math.max(parsed, 72), 300);
  }

  isDocumentActivelyProcessing(documentId) {
    const normalizedDocumentId = Number(documentId);
    return (
      Number.isInteger(normalizedDocumentId) &&
      this.activeDocumentIds.has(normalizedDocumentId)
    );
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
        documentIds: [],
      };
    }

    const documentIds = recoverableItems.map((item) => item.document_id);
    const recovered =
      await documentModel.resetOcrQueueItemsToPending(documentIds);

    logger.warn(
      `[OCR] Recovered ${recovered} stale OCR queue item(s) stuck in processing: ${documentIds.join(', ')}`
    );

    return {
      recovered,
      documentIds,
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
   * Send a base64-encoded document to the configured OCR provider and return
   * the extracted text.
   * @param {string} base64 - base64-encoded document
   * @param {string} mimeType - MIME type of the document
   * @param {number|null} documentId - Paperless document ID (local provider only)
   * @param {{onPageProgress?: (pageNumber: number, pageCount: number) => void}} opts
   *   - progress hooks; only used by the local provider's PDF render path
   * @returns {Promise<string>} - Extracted text
   */
  async performOcr(
    base64,
    mimeType = 'application/pdf',
    documentId = null,
    opts = {}
  ) {
    if (this.provider === 'ollama') {
      return this.performOcrWithOllama(base64, mimeType, documentId, opts);
    }

    return this.performOcrWithMistral(base64, mimeType);
  }

  async performOcrWithMistral(base64, mimeType = 'application/pdf') {
    if (!this.apiKey) {
      throw new Error('MISTRAL_API_KEY is not configured');
    }

    const documentUrl = `data:${mimeType};base64,${base64}`;

    let response;
    try {
      response = await axios.post(
        `${this.apiBase}/ocr`,
        {
          model: this.model,
          document: {
            type: 'document_url',
            document_url: documentUrl,
          },
          include_image_base64: false,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: this.ocrTimeoutMs,
        }
      );
    } catch (error) {
      if (isTimeoutError(error)) {
        const timeoutMessage = buildTimeoutErrorMessage(
          'OCR',
          this.ocrTimeoutMs
        );
        console.error(
          `[TIMEOUT][OCR] Mistral OCR request timed out: ${error.message}`
        );
        throw new Error(timeoutMessage);
      }
      throw error;
    }

    const pages = response.data?.pages || [];
    if (pages.length === 0) {
      throw new Error('Mistral OCR returned no pages');
    }

    return pages
      .map((p) => p.markdown || '')
      .join('\n\n')
      .trim();
  }

  /**
   * OCR a document with a local vision model. Images are sent as-is; PDFs are
   * rendered to per-page images via poppler (pdftoppm) when enabled and
   * available, otherwise the Paperless first-page thumbnail is used.
   */
  async performOcrWithOllama(
    base64,
    mimeType = 'application/pdf',
    documentId = null,
    opts = {}
  ) {
    const normalizedMimeType = String(mimeType || '').toLowerCase();

    if (normalizedMimeType.startsWith('image/')) {
      return this._performLocalOcrOnImage(base64, mimeType);
    }

    if (normalizedMimeType.includes('pdf') && this.pdfRenderEnabled) {
      if (await popplerService.isAvailable()) {
        let rendered = null;
        try {
          rendered = await popplerService.renderPdfToImages(
            Buffer.from(base64, 'base64'),
            {
              maxPages: this.pdfRenderMaxPages,
              dpi: this.pdfRenderDpi,
            }
          );
        } catch (renderError) {
          console.warn(
            `[OCR] PDF page rendering failed for document ${documentId}: ${renderError.message} — falling back to thumbnail OCR`
          );
        }

        if (rendered) {
          return this._performOcrOnRenderedPages(rendered, documentId, opts);
        }
      } else if (!this.pdfRenderUnavailableLogged) {
        this.pdfRenderUnavailableLogged = true;
        console.warn(
          '[OCR] pdftoppm not found — multi-page PDF OCR disabled, falling back to first-page thumbnail. Install poppler-utils to enable it.'
        );
      }
    }

    // Non-PDF originals (e.g. office documents without an archived PDF) also
    // land here: pdftoppm cannot render them, so the thumbnail is the best
    // available image source.
    return this._performOcrOnThumbnail(documentId);
  }

  /**
   * OCR every rendered PDF page through the local vision model and join the
   * page texts. A failed page is skipped so one bad page cannot discard the
   * rest; if no page succeeds, the last error is thrown.
   * @param {{pages: Array<{base64: string, mimeType: string, pageNumber: number}>, totalPages: number|null, truncated: boolean}} rendered
   * @param {number|null} documentId - log context only
   * @param {{onPageProgress?: (pageNumber: number, pageCount: number) => void}} opts
   * @returns {Promise<string>}
   */
  async _performOcrOnRenderedPages(rendered, documentId, opts = {}) {
    const { pages, totalPages, truncated } = rendered;

    if (truncated) {
      console.warn(
        `[OCR] Document ${documentId}: rendered first ${pages.length} of ${totalPages ?? 'unknown'} page(s) (OCR_PDF_RENDER_MAX_PAGES=${this.pdfRenderMaxPages})`
      );
    }

    const pageTexts = [];
    let lastError = null;

    for (const [index, page] of pages.entries()) {
      if (typeof opts.onPageProgress === 'function') {
        opts.onPageProgress(index + 1, pages.length);
      }

      try {
        const pageText = await this._performLocalOcrOnImage(
          page.base64,
          page.mimeType
        );
        if (pageText) {
          pageTexts.push(pageText);
        }
      } catch (error) {
        // Skip the page without inserting placeholder text: the joined result
        // is written back to Paperless as document content.
        console.warn(
          `[OCR] Page ${index + 1}/${pages.length} failed for document ${documentId}: ${error.message} — skipping page`
        );
        lastError = error;
      }
    }

    if (pageTexts.length === 0) {
      throw (
        lastError ||
        new Error('Local OCR returned empty output for all rendered PDF pages')
      );
    }

    return pageTexts.join('\n\n');
  }

  /**
   * Single-image fallback: OCR the Paperless first-page thumbnail. Used when
   * PDF page rendering is disabled, unavailable, or failed.
   */
  async _performOcrOnThumbnail(documentId) {
    if (!Number.isInteger(Number(documentId))) {
      throw new Error(
        'Ollama OCR requires an image input or a valid document ID for thumbnail fallback'
      );
    }

    const thumbnailBuffer = await PaperlessService.getThumbnailImage(
      Number(documentId)
    );
    if (!thumbnailBuffer) {
      throw new Error('Could not fetch thumbnail image for Ollama OCR');
    }

    return this._performLocalOcrOnImage(
      thumbnailBuffer.toString('base64'),
      'image/png'
    );
  }

  /**
   * Run a single image through the local vision model, trying the
   * OpenAI-compatible and Ollama-native endpoints in the detected order.
   * @param {string} imageBase64
   * @param {string} imageMimeType
   * @returns {Promise<string>}
   */
  async _performLocalOcrOnImage(imageBase64, imageMimeType) {
    const normalizedApiBase = await this.resolveLocalOcrApiBase();
    const baseApiUrl = normalizedApiBase.replace(/\/v1$/i, '');
    const openAiApiUrl = /\/v1$/i.test(normalizedApiBase)
      ? normalizedApiBase
      : `${baseApiUrl}/v1`;
    const ollamaApiUrl = /\/v1$/i.test(normalizedApiBase)
      ? baseApiUrl
      : normalizedApiBase;
    const imageDataUrl = `data:${imageMimeType};base64,${imageBase64}`;
    const authHeaders = this.apiKey
      ? {
          Authorization: `Bearer ${this.apiKey}`,
        }
      : {};

    const ocrTimeoutMs = this.ocrTimeoutMs;
    const runOpenAiLikeRequest = async (targetApiUrl, imageUrlValue) =>
      axios.post(
        `${targetApiUrl}/chat/completions`,
        {
          model: this.model,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Perform OCR on this image. Return only the extracted text in plain text. Do not add explanations.',
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageUrlValue,
                  },
                },
              ],
            },
          ],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          timeout: ocrTimeoutMs,
        }
      );

    const runOpenAiLikeWithFallback = async (targetApiUrl) => {
      try {
        const response = await runOpenAiLikeRequest(targetApiUrl, imageDataUrl);
        return String(
          response.data?.choices?.[0]?.message?.content || ''
        ).trim();
      } catch (error) {
        const providerMessage = String(
          error?.response?.data?.error?.message ||
            error?.response?.data?.message ||
            error?.message ||
            ''
        ).toLowerCase();

        // Some OpenAI-compatible vision endpoints require raw base64 in image_url.url.
        if (
          providerMessage.includes('url') &&
          providerMessage.includes('base64') &&
          imageBase64
        ) {
          const response = await runOpenAiLikeRequest(
            targetApiUrl,
            imageBase64
          );
          return String(
            response.data?.choices?.[0]?.message?.content || ''
          ).trim();
        }

        throw error;
      }
    };

    const runOllamaLike = async (targetApiUrl) => {
      const response = await axios.post(
        `${targetApiUrl}/api/chat`,
        {
          model: this.model,
          stream: false,
          messages: [
            {
              role: 'user',
              content:
                'Perform OCR on this image. Return only the extracted text in plain text. Do not add explanations.',
              images: [imageBase64],
            },
          ],
          options: {
            temperature: 0,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          timeout: ocrTimeoutMs,
        }
      );

      return String(response.data?.message?.content || '').trim();
    };

    const requestStrategies =
      this.detectedLocalApiMode === 'openai'
        ? [
            () => runOpenAiLikeWithFallback(openAiApiUrl),
            () => runOllamaLike(ollamaApiUrl),
          ]
        : this.detectedLocalApiMode === 'ollama'
          ? [
              () => runOllamaLike(ollamaApiUrl),
              () => runOpenAiLikeWithFallback(openAiApiUrl),
            ]
          : [
              () => runOllamaLike(ollamaApiUrl),
              () => runOpenAiLikeWithFallback(openAiApiUrl),
            ];

    let ocrText = '';
    let lastError;
    for (const [index, strategy] of requestStrategies.entries()) {
      try {
        ocrText = await strategy();
        if (ocrText) {
          if (index === 0 && this.detectedLocalApiMode == null) {
            this.detectedLocalApiMode = /\/v1$/i.test(normalizedApiBase)
              ? 'openai'
              : 'ollama';
          } else if (index === 1) {
            this.detectedLocalApiMode =
              this.detectedLocalApiMode === 'openai' ? 'ollama' : 'openai';
          }
          break;
        }
      } catch (error) {
        if (isTimeoutError(error)) {
          console.error(
            `[TIMEOUT][OCR] Local OCR request timed out: ${error.message}`
          );
          lastError = new Error(buildTimeoutErrorMessage('OCR', ocrTimeoutMs));
          continue;
        }
        lastError = error;
      }
    }

    if (!ocrText && lastError) {
      throw lastError;
    }

    if (!ocrText) {
      throw new Error(`Local OCR returned empty output for ${imageMimeType}`);
    }

    return ocrText;
  }

  buildLocalOcrApiCandidates(apiBase) {
    const normalized = String(apiBase || '')
      .trim()
      .replace(/\/+$/, '');
    if (!normalized) {
      return [];
    }

    const baseUrl = normalized.replace(/\/v1$/i, '');
    const openAiUrl = /\/v1$/i.test(normalized) ? normalized : `${baseUrl}/v1`;

    // First candidate keeps user preference/order, second candidate is the alternate style.
    return /\/v1$/i.test(normalized)
      ? [
          { base: openAiUrl, mode: 'openai' },
          { base: baseUrl, mode: 'ollama' },
        ]
      : [
          { base: baseUrl, mode: 'ollama' },
          { base: openAiUrl, mode: 'openai' },
        ];
  }

  async probeLocalOcrCandidate(candidateBase, mode, authHeaders) {
    if (mode === 'openai') {
      const response = await axios.get(`${candidateBase}/models`, {
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        timeout: 10000,
      });
      return response.status === 200;
    }

    const response = await axios.get(`${candidateBase}/api/tags`, {
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      timeout: 10000,
    });
    return response.status === 200;
  }

  async persistDetectedLocalOcrApiBase(detectedBase) {
    const normalizedDetectedBase = String(detectedBase || '')
      .trim()
      .replace(/\/+$/, '');
    if (!normalizedDetectedBase) {
      return;
    }

    const currentApiUrl = String(process.env.OCR_API_URL || '')
      .trim()
      .replace(/\/+$/, '');
    if (currentApiUrl === normalizedDetectedBase) {
      return;
    }

    try {
      const setupService = require('./setupService');
      const currentConfig = (await setupService.loadConfig()) || {};
      await setupService.saveRuntimeOverrides({
        ...currentConfig,
        OCR_API_URL: normalizedDetectedBase,
      });

      process.env.OCR_API_URL = normalizedDetectedBase;
      if (config.mistralOcr && typeof config.mistralOcr === 'object') {
        config.mistralOcr.apiUrl = normalizedDetectedBase;
      }

      console.log(
        `[OCR] Auto-detected OCR API URL saved: ${normalizedDetectedBase}`
      );
    } catch (error) {
      console.warn(
        `[OCR] Could not persist auto-detected OCR API URL (${normalizedDetectedBase}): ${error.message}`
      );
    }
  }

  async resolveLocalOcrApiBase() {
    if (this.provider !== 'ollama') {
      return String(this.apiBase || '').replace(/\/+$/, '');
    }

    if (this.detectedLocalApiBase) {
      return this.detectedLocalApiBase;
    }

    if (this.localApiDetectionPromise) {
      return this.localApiDetectionPromise;
    }

    this.localApiDetectionPromise = (async () => {
      const configuredBase = String(this.apiBase || '').replace(/\/+$/, '');
      const authHeaders = this.apiKey
        ? { Authorization: `Bearer ${this.apiKey}` }
        : {};

      for (const candidate of this.buildLocalOcrApiCandidates(configuredBase)) {
        try {
          const ok = await this.probeLocalOcrCandidate(
            candidate.base,
            candidate.mode,
            authHeaders
          );
          if (!ok) {
            continue;
          }

          this.detectedLocalApiBase = candidate.base;
          this.detectedLocalApiMode = candidate.mode;
          await this.persistDetectedLocalOcrApiBase(candidate.base);
          return candidate.base;
        } catch {
          // Try next candidate.
        }
      }

      this.detectedLocalApiBase = configuredBase;
      this.detectedLocalApiMode = /\/v1$/i.test(configuredBase)
        ? 'openai'
        : 'ollama';
      return configuredBase;
    })();

    try {
      return await this.localApiDetectionPromise;
    } finally {
      this.localApiDetectionPromise = null;
    }
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
        content: ocrText,
      });
      console.log(
        `[OCR] Successfully wrote OCR text back to Paperless for document ${documentId}`
      );
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
      throw new Error(
        `Document ${normalizedDocumentId} is already being processed`
      );
    }

    this.activeDocumentIds.add(normalizedDocumentId);

    let fallbackTitle = `Document ${normalizedDocumentId}`;
    let terminalFailureRecorded = false;
    const recordTerminalFailure = async (reason, source = 'ocr') => {
      if (terminalFailureRecorded) return;
      await documentModel.addFailedDocument(
        normalizedDocumentId,
        fallbackTitle,
        reason,
        source
      );
      terminalFailureRecorded = true;
    };

    try {
      const queueItem =
        await documentModel.getOcrQueueItem(normalizedDocumentId);
      fallbackTitle = queueItem?.title || fallbackTitle;

      await documentModel.updateOcrQueueStatus(
        normalizedDocumentId,
        'processing'
      );

      // Step 1: Download
      emit(
        'download',
        `Downloading document ${normalizedDocumentId} from Paperless-ngx…`
      );
      let base64, mimeType;
      try {
        ({ base64, mimeType } =
          await this.downloadDocumentAsBase64(normalizedDocumentId));
      } catch (dlErr) {
        throw new Error(`Download failed: ${dlErr.message}`);
      }
      emit('download', `Download complete (${mimeType}).`);

      // Step 2: OCR
      const providerLabel =
        this.provider === 'ollama' ? 'Local OCR' : 'Mistral OCR';
      emit('ocr', `Sending document to ${providerLabel}…`);
      let ocrText;
      try {
        ocrText = await this.performOcr(
          base64,
          mimeType,
          normalizedDocumentId,
          {
            onPageProgress: (pageNumber, pageCount) =>
              emit('ocr', `OCR page ${pageNumber}/${pageCount}…`),
          }
        );
      } catch (ocrErr) {
        throw new Error(`${providerLabel} failed: ${ocrErr.message}`);
      }
      const previewLen = Math.min(ocrText.length, 120);
      emit('ocr', `OCR complete. Extracted ${ocrText.length} characters.`, {
        preview: ocrText.substring(0, previewLen),
      });

      // Step 3: Write back
      emit('writeback', 'Writing OCR text back to Paperless-ngx…');
      const wroteBack = await this.writeBackContent(
        normalizedDocumentId,
        ocrText
      );
      if (wroteBack) {
        emit('writeback', 'OCR text successfully written to Paperless-ngx.');
      } else {
        emit(
          'writeback',
          'Paperless-ngx does not allow writing content. OCR text stored locally.'
        );
      }

      // Persist result in queue
      await documentModel.updateOcrQueueStatus(
        normalizedDocumentId,
        'done',
        ocrText
      );

      let aiResult = null;
      if (autoAnalyze) {
        emit('ai', 'Starting AI analysis with OCR text…');
        try {
          aiResult = await this._runAiAnalysis(normalizedDocumentId, ocrText);
          emit('ai', 'AI analysis complete.');
        } catch (aiErr) {
          if (isTimeoutError(aiErr)) {
            console.error(
              `[TIMEOUT][AI] AI analysis timed out after OCR for document ${normalizedDocumentId}: ${aiErr.message}`
            );
          }
          await recordTerminalFailure('ai_failed_after_ocr', 'ai');
          await documentModel.updateOcrQueueStatus(
            normalizedDocumentId,
            'failed',
            ocrText
          );
          const aiErrorMessage = isTimeoutError(aiErr)
            ? buildTimeoutErrorMessage('AI')
            : aiErr.message;
          throw new Error(`AI analysis failed after OCR: ${aiErrorMessage}`);
        }
      }

      if (!autoAnalyze || aiResult) {
        await documentModel.resetFailedDocument(normalizedDocumentId);
      }

      emit('done', 'Processing finished successfully.');
      return { ocrText, wroteBack, aiAnalysis: aiResult };
    } catch (error) {
      if (isTimeoutError(error)) {
        console.error(
          `[TIMEOUT][OCR] OCR pipeline timed out for document ${normalizedDocumentId}: ${error.message}`
        );
      }
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
  async analyzeFromExistingOcrText(
    documentId,
    ocrText,
    progressCallback = null
  ) {
    const emit = (step, message, data = {}) => {
      if (progressCallback) progressCallback(step, message, data);
    };

    if (typeof ocrText !== 'string' || !ocrText.trim()) {
      throw new Error('No OCR text available for AI analysis');
    }

    emit(
      'ai',
      `Starting AI analysis for document ${documentId} using stored OCR text…`
    );
    try {
      const aiResult = await this._runAiAnalysis(documentId, ocrText);
      await documentModel.resetFailedDocument(documentId);
      emit('ai', 'AI analysis complete.');
      emit('done', 'AI-only processing finished successfully.');
      return aiResult;
    } catch (error) {
      if (isTimeoutError(error)) {
        console.error(
          `[TIMEOUT][AI] AI-only OCR analysis timed out for document ${documentId}: ${error.message}`
        );
      }
      const queueItem = await documentModel.getOcrQueueItem(documentId);
      const fallbackTitle = queueItem?.title || `Document ${documentId}`;
      await documentModel.addFailedDocument(
        documentId,
        fallbackTitle,
        'ai_failed_after_ocr',
        'ai'
      );
      const aiErrorMessage = isTimeoutError(error)
        ? buildTimeoutErrorMessage('AI')
        : error.message;
      emit('error', `AI analysis failed: ${aiErrorMessage}`);
      throw new Error(aiErrorMessage);
    }
  }

  /**
   * Run AI analysis on a document using OCR text (instead of Paperless content).
   * Mirrors the processDocument / buildUpdateData / saveDocumentChanges flow
   * from server.js but accepts pre-extracted text.
   * @private
   */
  async _runAiAnalysis(documentId, ocrText) {
    const [
      existingTags,
      existingCorrespondentList,
      existingDocumentTypes,
      originalData,
    ] = await Promise.all([
      PaperlessService.getTags(),
      PaperlessService.listCorrespondentsNames(),
      PaperlessService.listDocumentTypesNames(),
      PaperlessService.getDocument(documentId),
    ]);

    const existingTagNames = existingTags.map((t) => t.name);
    const correspondentNames = existingCorrespondentList.map((c) => c.name);
    const documentTypeNames = existingDocumentTypes.map((d) => d.name);

    // Truncate to 50 000 chars as in normal flow
    const contentForAi =
      ocrText.length > 50000 ? ocrText.substring(0, 50000) : ocrText;

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
    const config = require('../config/config');
    const options = {
      restrictToExistingTags: config.restrictToExistingTags === 'yes',
      restrictToExistingCorrespondents:
        config.restrictToExistingCorrespondents === 'yes',
      restrictToExistingDocumentTypes:
        config.restrictToExistingDocumentTypes === 'yes',
    };

    if (config.limitFunctions?.activateTagging !== 'no') {
      const { tagIds } = await PaperlessService.processTags(
        analysis.document.tags,
        options
      );
      updateData.tags = tagIds;
    }
    if (config.limitFunctions?.activateTitle !== 'no') {
      updateData.title = analysis.document.title || originalData.title;
    }
    updateData.created =
      analysis.document.document_date || originalData.created;
    if (
      config.limitFunctions?.activateDocumentType !== 'no' &&
      analysis.document.document_type
    ) {
      const dt = await PaperlessService.getOrCreateDocumentType(
        analysis.document.document_type,
        options
      );
      if (dt) updateData.document_type = dt.id;
    }
    if (
      config.limitFunctions?.activateCorrespondents !== 'no' &&
      analysis.document.correspondent
    ) {
      const corr = await PaperlessService.getOrCreateCorrespondent(
        analysis.document.correspondent,
        options
      );
      if (corr) updateData.correspondent = corr.id;
    }
    if (analysis.document.language) {
      updateData.language = analysis.document.language;
    }

    // Apply updates to Paperless
    const updatedDocument = await PaperlessService.updateDocument(
      documentId,
      updateData
    );
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
    await documentModel.addProcessedDocument(
      documentId,
      updateData.title || originalData.title
    );
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
