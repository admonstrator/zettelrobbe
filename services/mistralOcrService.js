// services/mistralOcrService.js
//
// Mistral OCR Service – Downloads a document from Paperless-ngx as PDF,
// sends it to the Mistral OCR API (mistral-ocr-latest), and attempts to
// write the extracted markdown text back to Paperless-ngx via PATCH.
// Falls back to storing the OCR text locally in the ocr_queue table when
// the Paperless PATCH endpoint does not allow writing the content field.
//
// OCR_PROVIDER picks the engine: `mistral` (default), `ollama`/`custom` (a
// local vision model) or `anthropic` (a Claude model via the Messages API).

const axios = require('axios');
const { APIError } = require('@anthropic-ai/sdk');
const config = require('../config/config');
const PaperlessService = require('./paperlessService');
const popplerService = require('./popplerService');
const documentModel = require('../models/document');
const AIServiceFactory = require('./aiServiceFactory');
const documentProcessingService = require('./documentProcessingService');
const {
  isTimeoutError,
  buildTimeoutErrorMessage,
  stripTrailingSlashes,
} = require('./serviceUtils');
const {
  ANTHROPIC_DEFAULT_MODEL,
  anthropicThinkingParams,
  anthropicMaxTokens,
  createAnthropicClient,
  anthropicMessageText,
  mapAnthropicUsage,
  assertAnthropicCompleted,
} = require('./anthropicSupport');

// The instruction the vision OCR requests carry. OCR_PROMPT (container env
// or the settings page) replaces it; an empty value keeps this text, so an
// instance that never set it keeps sending exactly what it sent before.
const DEFAULT_OCR_TEXT_INSTRUCTION =
  'Perform OCR on this image. Return only the extracted text in plain text. Do not add explanations.';

// ── Claude OCR limits ──────────────────────────────────────────────────────
//
// The Messages API rejects a request body over 32 MB and an image over 10 MB
// (both measured as base64, which is what travels). Checking before sending
// turns a bare 413 into an error that says which limit was hit and what to do
// about it. Decimal megabytes on purpose: if the API means MiB, this errs on
// the safe side by a megabyte and a half.
const CLAUDE_OCR_MAX_REQUEST_BYTES = 32 * 1000 * 1000;
const CLAUDE_OCR_MAX_IMAGE_BYTES = 10 * 1000 * 1000;
// Room for everything in the request besides the document: the JSON around
// it and the instruction text.
const CLAUDE_OCR_REQUEST_RESERVE_BYTES = 64 * 1024;
const CLAUDE_OCR_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

// A transcript is as long as the document, so the completion cap has to be
// sized for the document rather than for a JSON answer. Every current model
// writes up to 128K tokens; 64000 also fits Claude Haiku 4.5, which stops at
// 64K, so one cap works whichever model the operator picks. It holds roughly
// a hundred dense pages; past it the answer is cut off, which fails the OCR
// run instead of writing half a document. Operators with longer documents
// raise ANTHROPIC_MAX_TOKENS, which OCR honours up to the 128K ceiling. Caps
// this large require streaming.
const CLAUDE_OCR_MAX_TOKENS = 64000;
const CLAUDE_OCR_MAX_TOKENS_CEILING = 128000;

// What the model answers for a page without any text. The empty-result guard
// in processQueueItem() then refuses to overwrite the document's content,
// instead of a sentence like "This page is blank." becoming its text.
const CLAUDE_OCR_NO_TEXT_MARKER = '[no text]';

const CLAUDE_OCR_INSTRUCTION = [
  'Transcribe all text in this document exactly as it is written, in reading order, page by page.',
  '- Keep the original language, spelling, numbers and punctuation. Do not translate, correct, summarize or explain anything.',
  '- Reproduce tables as Markdown tables. Keep headings, lists and paragraph breaks.',
  '- Include handwriting, stamps and filled-in form values where they are legible.',
  '- Write [illegible] where text cannot be read. Do not guess.',
  '- Answer with the transcript only: no introduction, no comments, no code fences.',
  `- If the document contains no readable text at all, answer with exactly ${CLAUDE_OCR_NO_TEXT_MARKER}`,
].join('\n');

/**
 * The media type Claude would be told, from a Content-Type value: parameters
 * dropped, lower-cased, the common `image/jpg` misspelling fixed.
 *
 * @param {unknown} mimeType
 * @returns {string}
 */
function normalizeClaudeOcrMediaType(mimeType) {
  const mediaType = String(mimeType || 'application/pdf')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return mediaType === 'image/jpg' ? 'image/jpeg' : mediaType;
}

/** A byte count as decimal megabytes with one decimal, for messages. */
function formatMegabytes(bytes) {
  return (bytes / 1000 / 1000).toFixed(1);
}

/** Whether a base64 PDF leaves no room for the rest of a Messages request. */
function exceedsClaudeOcrRequestLimit(base64Length) {
  return (
    base64Length + CLAUDE_OCR_REQUEST_RESERVE_BYTES >
    CLAUDE_OCR_MAX_REQUEST_BYTES
  );
}

function claudeOcrInputError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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
    if (this.provider === 'anthropic') {
      // Not config.mistralOcr.apiKey: it falls back to MISTRAL_API_KEY, and a
      // Mistral key left over from an earlier setup must never be sent to the
      // Claude API. A dedicated OCR key wins, else the AI provider's key.
      return (
        String(process.env.OCR_API_KEY || '').trim() ||
        config.anthropic?.apiKey ||
        process.env.ANTHROPIC_API_KEY ||
        ''
      );
    }

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
    if (this.provider === 'anthropic') {
      // MISTRAL_OCR_MODEL is the OCR model field for every provider, and it
      // defaults to mistral-ocr-latest, which the Claude API would answer
      // with a 404. Only a Claude model name in it counts; otherwise OCR uses
      // the model the AI provider is configured with. Proxies sometimes
      // prefix the name (anthropic.claude-…, anthropic/claude-…).
      const ocrModel = String(config.mistralOcr?.model || '').trim();
      return /(?:^|[./])claude-/i.test(ocrModel)
        ? ocrModel
        : config.anthropic?.model || ANTHROPIC_DEFAULT_MODEL;
    }

    return config.mistralOcr?.model || 'mistral-ocr-latest';
  }

  get provider() {
    const normalizedProvider = String(config.mistralOcr?.provider || 'mistral')
      .trim()
      .toLowerCase();
    if (normalizedProvider === 'anthropic') {
      return 'anthropic';
    }
    return normalizedProvider === 'ollama' || normalizedProvider === 'custom'
      ? 'ollama'
      : 'mistral';
  }

  /** The provider's name in progress messages and errors. */
  get providerLabel() {
    if (this.provider === 'ollama') return 'Local OCR';
    if (this.provider === 'anthropic') return 'Claude OCR';
    return 'Mistral OCR';
  }

  /**
   * The completion cap for one Claude OCR request: CLAUDE_OCR_MAX_TOKENS, or
   * ANTHROPIC_MAX_TOKENS when the operator raised it above that, never more
   * than the 128K output ceiling of the current models.
   */
  get anthropicOcrMaxTokens() {
    const configured = Number(config.anthropic?.maxTokens) || 0;
    return Math.min(
      Math.max(CLAUDE_OCR_MAX_TOKENS, configured),
      CLAUDE_OCR_MAX_TOKENS_CEILING
    );
  }

  get apiBase() {
    if (this.provider === 'anthropic') {
      // OCR_API_URL only when the operator set one (a proxy used for OCR
      // alone); otherwise the AI provider's ANTHROPIC_API_URL. Empty means
      // api.anthropic.com.
      return stripTrailingSlashes(
        String(
          config.mistralOcr?.apiUrl || config.anthropic?.apiUrl || ''
        ).trim()
      );
    }

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

  /**
   * The configured OCR_PROMPT, or '' when the operator left the field empty.
   * '' means 'use the provider's own instruction', which keeps every
   * provider's built-in wording intact and lets each request site pick its
   * own fallback instead of one shared text overriding all of them.
   */
  get ocrPromptOverride() {
    return String(config.mistralOcr?.prompt ?? '').trim();
  }

  get ocrTextInstruction() {
    return this.ocrPromptOverride || DEFAULT_OCR_TEXT_INSTRUCTION;
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
   *   - progress hooks; only used by the PDF render paths (local provider, and
   *     Claude for a PDF over its request limit)
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

    if (this.provider === 'anthropic') {
      return this.performOcrWithAnthropic(base64, mimeType, documentId, opts);
    }

    return this.performOcrWithMistral(base64, mimeType);
  }

  /* Mistral's /v1/ocr takes PDFs and office formats as `document_url` and
     images as `image_url`. Everything went out as `document_url`, which is
     correct for the PDF default but rejected for the image types the OCR
     queue also feeds in (a page rendered by poppler, or a document stored as
     PNG/JPEG in Paperless-ngx). */
  buildMistralOcrDocument(dataUrl, mimeType) {
    return /^image\//i.test(String(mimeType || ''))
      ? { type: 'image_url', image_url: dataUrl }
      : { type: 'document_url', document_url: dataUrl };
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
          document: this.buildMistralOcrDocument(documentUrl, mimeType),
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
        throw new Error(timeoutMessage, { cause: error });
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
   * OCR with the configured Claude model (OCR_PROVIDER=anthropic).
   *
   * A PDF goes to Claude whole, as one document; Claude reads its text layer
   * and its page images together. Only a PDF over the 32 MB request limit
   * takes another route: the poppler rendering the local provider uses, one
   * page image per request, because a page image is far smaller than the
   * PDF around it. Without poppler that PDF fails with the limit named.
   *
   * @param {string} base64
   * @param {string} mimeType
   * @param {number|null} documentId - log context for the render path
   * @param {{onPageProgress?: (pageNumber: number, pageCount: number) => void}} opts
   * @returns {Promise<string>}
   */
  async performOcrWithAnthropic(
    base64,
    mimeType = 'application/pdf',
    documentId = null,
    opts = {}
  ) {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error(
        'Claude OCR needs an API key: set ANTHROPIC_API_KEY, or OCR_API_KEY for a key used only for OCR'
      );
    }

    const request = {
      apiKey,
      apiUrl: this.apiBase,
      model: this.model,
      timeoutMs: this.ocrTimeoutMs,
      maxTokens: this.anthropicOcrMaxTokens,
      instruction: this.ocrPromptOverride,
    };

    if (
      normalizeClaudeOcrMediaType(mimeType) === 'application/pdf' &&
      exceedsClaudeOcrRequestLimit(String(base64 || '').length)
    ) {
      return this._performAnthropicOcrOnRenderedPdf(
        base64,
        documentId,
        opts,
        request
      );
    }

    return this.runAnthropicOcr({ ...request, base64, mimeType });
  }

  /**
   * The fallback for a PDF too large for one Claude request: render its pages
   * with poppler (same OCR_PDF_RENDER_* settings as local OCR) and transcribe
   * each page image on its own.
   */
  async _performAnthropicOcrOnRenderedPdf(base64, documentId, opts, request) {
    const limit = `The PDF is ${formatMegabytes(String(base64).length)} MB as base64; Claude accepts at most ${formatMegabytes(CLAUDE_OCR_MAX_REQUEST_BYTES)} MB per request`;

    if (!this.pdfRenderEnabled) {
      throw claudeOcrInputError(
        `${limit}. Enable OCR_PDF_RENDER_ENABLED to send it page by page instead.`,
        'claude_ocr_too_large'
      );
    }
    if (!(await popplerService.isAvailable())) {
      throw claudeOcrInputError(
        `${limit}. Install poppler-utils (pdftoppm) to send it page by page instead.`,
        'claude_ocr_too_large'
      );
    }

    console.warn(
      `[OCR] Document ${documentId}: ${limit} — sending up to ${this.pdfRenderMaxPages} rendered page(s) as images instead`
    );
    const rendered = await popplerService.renderPdfToImages(
      Buffer.from(base64, 'base64'),
      { maxPages: this.pdfRenderMaxPages, dpi: this.pdfRenderDpi }
    );

    return this._performOcrOnRenderedPages(rendered, documentId, opts, {
      label: 'Claude OCR',
      ocrImage: (pageBase64, pageMimeType) =>
        this.runAnthropicOcr({
          ...request,
          base64: pageBase64,
          mimeType: pageMimeType,
        }),
    });
  }

  /**
   * OCR one document with a Claude model (OCR_PROVIDER=anthropic).
   *
   * Takes every connection detail as an argument so the setup validation can
   * try a key and model before they are saved; performOcr() passes the
   * configured ones. Nothing here reads config.
   *
   * One Messages request: the document block (PDF) or image block first, the
   * transcription instruction after it. Thinking is turned down as far as the
   * model allows — copying text needs none, and thinking tokens count toward
   * the cap. The answer is streamed because a transcript can run far past the
   * size a non-streaming request may wait for.
   *
   * A cut-off or declined answer throws (assertAnthropicCompleted), so the
   * caller fails the OCR run exactly as it does for a truncated local OCR
   * page instead of writing part of a document back to Paperless-ngx.
   *
   * @param {object} params
   * @param {string} params.apiKey
   * @param {string} [params.apiUrl] - proxy only; empty means api.anthropic.com
   * @param {string} params.model
   * @param {string} params.base64 - the document, base64-encoded (a data URL
   *   is accepted too)
   * @param {string} params.mimeType - application/pdf or an image type
   * @param {number} [params.timeoutMs] - how long the request may go without
   *   progress: until the answer starts, and between two streamed events
   * @param {number} [params.maxTokens] - completion cap; default 64000
   * @param {string} [params.instruction] - OCR_PROMPT when configured; empty
   *   keeps the built-in Claude transcription instruction
   * @returns {Promise<string>} the transcribed text; empty for a document
   *   without readable text
   */
  async runAnthropicOcr({
    apiKey,
    apiUrl = '',
    model,
    base64,
    mimeType,
    timeoutMs,
    maxTokens,
    instruction = '',
  } = {}) {
    const key = String(apiKey || '').trim();
    if (!key) {
      throw new Error('Claude OCR needs an API key');
    }

    const source = this._prepareClaudeOcrSource(base64, mimeType);
    const modelName = String(model || '').trim() || ANTHROPIC_DEFAULT_MODEL;
    const cap = anthropicMaxTokens(maxTokens, CLAUDE_OCR_MAX_TOKENS);

    const params = {
      model: modelName,
      max_tokens: cap,
      ...anthropicThinkingParams(modelName, { reasoning: false }),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: source.blockType,
              source: {
                type: 'base64',
                media_type: source.mediaType,
                data: source.data,
              },
            },
            { type: 'text', text: instruction || CLAUDE_OCR_INSTRUCTION },
          ],
        },
      ],
    };

    const client = createAnthropicClient({ apiKey: key, apiUrl, timeoutMs });
    const message = await this._streamClaudeOcr(client, params, timeoutMs);

    const usage = mapAnthropicUsage(message?.usage);
    if (usage) {
      console.log(
        `[OCR] Claude OCR (${modelName}): ${usage.promptTokens} input / ${usage.completionTokens} output tokens`
      );
    }

    assertAnthropicCompleted(
      message,
      'Claude OCR',
      cap < CLAUDE_OCR_MAX_TOKENS_CEILING
        ? `The transcript needs more room: raise ANTHROPIC_MAX_TOKENS (up to ${CLAUDE_OCR_MAX_TOKENS_CEILING}) or split the document.`
        : 'The transcript is longer than one answer can be; split the document into smaller parts.'
    );

    const text = anthropicMessageText(message);
    return text.toLowerCase() === CLAUDE_OCR_NO_TEXT_MARKER ? '' : text;
  }

  /**
   * The document as a Messages content source, or an error naming the limit
   * it breaks. Checked here rather than left to the API so the setup
   * validation and the OCR queue both get a message that says what to do.
   *
   * @param {string} base64
   * @param {string} mimeType
   * @returns {{blockType: 'document'|'image', mediaType: string, data: string}}
   */
  _prepareClaudeOcrSource(base64, mimeType) {
    let data = String(base64 || '');
    let declaredType = mimeType;
    const dataUrl = /^data:([^;,]+);base64,/i.exec(data);
    if (dataUrl) {
      data = data.slice(dataUrl[0].length);
      declaredType = declaredType || dataUrl[1];
    }
    // The API wants base64 without line breaks; MIME-style wrapped input
    // would be rejected.
    if (/\s/.test(data)) {
      data = data.replace(/\s+/g, '');
    }
    if (!data) {
      throw claudeOcrInputError(
        'Claude OCR received an empty document',
        'claude_ocr_empty_input'
      );
    }

    const mediaType = normalizeClaudeOcrMediaType(declaredType);

    if (mediaType === 'application/pdf') {
      if (exceedsClaudeOcrRequestLimit(data.length)) {
        throw claudeOcrInputError(
          `The PDF is ${formatMegabytes(data.length)} MB as base64; Claude accepts at most ${formatMegabytes(CLAUDE_OCR_MAX_REQUEST_BYTES)} MB per request.`,
          'claude_ocr_too_large'
        );
      }
      return { blockType: 'document', mediaType, data };
    }

    if (CLAUDE_OCR_IMAGE_TYPES.has(mediaType)) {
      if (data.length > CLAUDE_OCR_MAX_IMAGE_BYTES) {
        throw claudeOcrInputError(
          `The image is ${formatMegabytes(data.length)} MB as base64; Claude accepts at most ${formatMegabytes(CLAUDE_OCR_MAX_IMAGE_BYTES)} MB per image.`,
          'claude_ocr_too_large'
        );
      }
      return { blockType: 'image', mediaType, data };
    }

    // Paperless-ngx serves its archived PDF when it has one, so this is an
    // original it could not convert (TIFF, office formats, …).
    throw claudeOcrInputError(
      `Claude OCR cannot read ${mediaType} files; it accepts PDF, PNG, JPEG, GIF and WebP. ` +
        'Paperless-ngx has no archived PDF of this document to send instead.',
      'claude_ocr_unsupported_type'
    );
  }

  /**
   * Streams one Messages request and returns the final message.
   *
   * The SDK's own timeout only covers the wait for the response headers; a
   * stream that stalls after them would hold the queue item in 'processing'
   * for good. So a watchdog aborts the request once it has gone `timeoutMs`
   * without progress — before it starts, or between two events — and a long
   * transcript that keeps arriving is never cut short.
   */
  async _streamClaudeOcr(client, params, timeoutMs) {
    const stream = client.messages.stream(params);
    let stalled = false;
    const watchdog =
      typeof timeoutMs === 'number' && timeoutMs > 0
        ? setTimeout(() => {
            stalled = true;
            stream.abort();
          }, timeoutMs)
        : null;
    if (watchdog) {
      const touch = () => watchdog.refresh();
      stream.on('connect', touch).on('streamEvent', touch);
    }

    try {
      return await stream.finalMessage();
    } catch (error) {
      if (stalled || isTimeoutError(error)) {
        console.error(
          `[TIMEOUT][OCR] Claude OCR request timed out: ${error.message}`
        );
        throw new Error(buildTimeoutErrorMessage('OCR', timeoutMs), {
          cause: error,
        });
      }
      throw this._describeClaudeApiError(error);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  /**
   * An API error as one readable line. The SDK puts the whole JSON error body
   * into its message; the queue and the setup wizard show this text as is.
   */
  _describeClaudeApiError(error) {
    if (!(error instanceof APIError) || !error.status) {
      return error;
    }
    const body = error.error?.error;
    const type = body?.type ? ` (${body.type})` : '';
    const detail = body?.message || error.message;
    const hint =
      error.status === 413
        ? ` Claude accepts at most ${formatMegabytes(CLAUDE_OCR_MAX_REQUEST_BYTES)} MB per request.`
        : '';
    return new Error(
      `Claude API answered HTTP ${error.status}${type}: ${detail}${hint}`,
      { cause: error }
    );
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
   * OCR every rendered PDF page through the local vision model (or the
   * engine `pageOcr` names) and join the page texts. A failed page is skipped
   * so one bad page cannot discard the rest; if no page succeeds, the last
   * error is thrown.
   * @param {{pages: Array<{base64: string, mimeType: string, pageNumber: number}>, totalPages: number|null, truncated: boolean}} rendered
   * @param {number|null} documentId - log context only
   * @param {{onPageProgress?: (pageNumber: number, pageCount: number) => void}} opts
   * @param {{label?: string, ocrImage?: (base64: string, mimeType: string) => Promise<string>}} [pageOcr]
   *   - the engine for one page image and its name in errors; local OCR by default
   * @returns {Promise<string>}
   */
  async _performOcrOnRenderedPages(
    rendered,
    documentId,
    opts = {},
    {
      label = 'Local OCR',
      ocrImage = (imageBase64, imageMimeType) =>
        this._performLocalOcrOnImage(imageBase64, imageMimeType),
    } = {}
  ) {
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
        const pageText = await ocrImage(page.base64, page.mimeType);
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
        new Error(`${label} returned empty output for all rendered PDF pages`)
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
   * Rejects a vision response that stopped at the token limit.
   *
   * Both local endpoints report this the same way: OpenAI-compatible servers
   * set `choices[0].finish_reason` to `length`, Ollama sets `done_reason`.
   * The text that comes back is a page cut off mid-sentence, and the caller
   * writes its result into the Paperless-ngx `content` field — so accepting it
   * would replace a document's text with a fragment. A truncated answer is an
   * error, and the strategy loop can fall back to the other endpoint.
   *
   * @param {unknown} finishReason - the provider's stop reason
   * @param {string} endpointLabel - which endpoint answered, for the message
   * @throws {Error} when the response was cut short
   */
  _assertLocalOcrNotTruncated(finishReason, endpointLabel) {
    if (String(finishReason || '').toLowerCase() === 'length') {
      throw new Error(
        `${endpointLabel} OCR response was cut off at the token limit (stop reason "length"); ` +
          'refusing to use a truncated page as document text'
      );
    }
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
                  text: this.ocrTextInstruction,
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

    const readOpenAiLikeText = (response) => {
      this._assertLocalOcrNotTruncated(
        response?.data?.choices?.[0]?.finish_reason,
        'OpenAI-compatible'
      );
      return String(response.data?.choices?.[0]?.message?.content || '').trim();
    };

    const runOpenAiLikeWithFallback = async (targetApiUrl) => {
      try {
        const response = await runOpenAiLikeRequest(targetApiUrl, imageDataUrl);
        return readOpenAiLikeText(response);
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
          return readOpenAiLikeText(response);
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
              content: this.ocrTextInstruction,
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

      this._assertLocalOcrNotTruncated(response?.data?.done_reason, 'Ollama');
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
        throw new Error(`Download failed: ${dlErr.message}`, {
          cause: dlErr,
        });
      }
      emit('download', `Download complete (${mimeType}).`);

      // Step 2: OCR
      const providerLabel = this.providerLabel;
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
        throw new Error(`${providerLabel} failed: ${ocrErr.message}`, {
          cause: ocrErr,
        });
      }

      // The write-back below PATCHes this string into the Paperless-ngx
      // `content` field, which already holds whatever Paperless-ngx extracted
      // itself. An empty or blank result — a page without recognisable text, a
      // degraded provider — would therefore not add text but erase it, with no
      // copy anywhere to restore from. Nothing to write is a failed OCR run,
      // not a successful one, so it stops here and the item stays in the queue
      // as failed for a retry with different settings.
      ocrText = typeof ocrText === 'string' ? ocrText : String(ocrText ?? '');
      if (ocrText.trim().length === 0) {
        throw new Error(
          'OCR returned no text; refusing to overwrite document content'
        );
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

      // Persist the result before the AI step, not after: if the process dies
      // mid-analysis, the startup recovery finds a 'done' row holding its text
      // instead of a 'pending' one, and the retry costs no second OCR call.
      await documentModel.updateOcrQueueStatus(
        normalizedDocumentId,
        'done',
        ocrText,
        wroteBack
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
          throw new Error(`AI analysis failed after OCR: ${aiErrorMessage}`, {
            cause: aiErr,
          });
        }
      }

      if (!autoAnalyze || aiResult) {
        await documentModel.resetFailedDocument(normalizedDocumentId);
      }

      // The queue holds outstanding work, so a row that has none left is
      // removed rather than kept as a receipt. Both conditions carry weight:
      //
      // - wroteBack: Paperless-ngx now holds the text, which makes the local
      //   copy redundant. A refused write-back leaves this row as the only
      //   place the text exists, so it stays and keeps saying so.
      // - aiResult: the analysis is what puts the document into
      //   processed_documents, and that record is what stops the scan loop
      //   from queueing it for OCR a second time. Without it, deleting the row
      //   would drop the only memory that this document was ever OCR'd, and an
      //   AI error that keeps recurring would buy OCR again on every scan.
      //
      // An OCR-only run therefore keeps its row on purpose — the document has
      // its text but still awaits analysis, which is outstanding work, and the
      // row offers exactly that action.
      if (wroteBack && aiResult) {
        await documentModel.removeFromOcrQueue(normalizedDocumentId);
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
      throw new Error(aiErrorMessage, { cause: error });
    }
  }

  /**
   * Run AI analysis on a document using OCR text (instead of Paperless content).
   * Mirrors processDocument from server.js but accepts pre-extracted text;
   * the write-back is the same documentProcessingService the scan uses.
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

    const updateData = await documentProcessingService.buildUpdateData(
      analysis,
      originalData
    );
    await documentProcessingService.saveDocumentChanges(
      documentId,
      updateData,
      analysis,
      originalData
    );

    return analysis;
  }
}

module.exports = new MistralOcrService();
