// services/quickstartService.js
//
// Quickstart auto-detection service. Given a single base URL (e.g. an
// LM Studio or Ollama host), it probes the endpoint to determine the API
// flavor, lists the available models, and classifies them by capability
// (text / vision / embedding) so the UI can suggest suitable models for
// AI analysis and OCR without manual configuration.
//
// Classification is metadata-first with a name-heuristic fallback:
// - Ollama native:  POST /api/show per model -> capabilities array
// - LM Studio:      GET /api/v0/models -> type (llm|vlm|embeddings) + state
// - Generic OpenAI: GET /v1/models -> flat IDs, name heuristics only
//
// No result caching (unlike setupService's detection caches): detection is
// strictly button-triggered and users load/unload local models between
// clicks, so stale classifications would be confusing.

const axios = require('axios');
const setupService = require('./setupService');
const { validateApiUrl } = require('./serviceUtils');

const FLAVOR_PROBE_TIMEOUT_MS = 10000;
const OLLAMA_SHOW_TIMEOUT_MS = 5000;
const OLLAMA_SHOW_CONCURRENCY = 4;
const OLLAMA_MODEL_CAP = 50;
// Reserve headroom so the endpoint responds before the route-level
// validation timeout fires even when per-model lookups run long.
const CLASSIFICATION_DEADLINE_HEADROOM_MS = 1500;

class QuickstartService {
  constructor() {
    // Ordered: embedding hints are checked first because embedding models
    // must never be suggested; vision hints imply text capability (VLMs).
    this.embeddingNameHints = ['embed', 'bge', 'nomic-embed', 'text-embedding', 'minilm', 'gte-', 'e5-', 'rerank'];
    // Known accepted false positive: "gemma3:1b" (text-only variant) is
    // classified as vision. The suggestion is a dropdown default the user
    // can always override.
    this.visionNameHints = ['llava', 'bakllava', '-vl', 'vl-', 'vlm', 'vision', 'minicpm-v', 'moondream', 'pixtral', 'gemma3', 'internvl', 'smolvlm'];
    // Dedicated OCR models (e.g. Mistral's mistral-ocr-latest) classify as
    // plain ['text'] under classifyModelName - none of the vision hints
    // above match "ocr" naming. suggestModels() needs its own hint list so
    // these still get suggested as the default OCR model instead of being
    // invisible to the suggestion logic (see classifyModelName's untouched
    // hint lists; this only affects which text-capable model is suggested).
    this.ocrNameHints = ['ocr'];
  }

  // ── Classification helpers (pure, offline-testable) ──────────────────────

  classifyModelName(modelId) {
    const normalized = String(modelId || '').trim().toLowerCase();
    if (!normalized) {
      return ['text'];
    }

    if (this.embeddingNameHints.some((hint) => normalized.includes(hint))) {
      return ['embedding'];
    }

    if (this.visionNameHints.some((hint) => normalized.includes(hint))) {
      return ['text', 'vision'];
    }

    return ['text'];
  }

  classifyLmStudioEntry(entry) {
    const id = String(entry?.id || '').trim();
    const type = String(entry?.type || '').trim().toLowerCase();
    const state = String(entry?.state || '').trim().toLowerCase() || null;

    let capabilities;
    let source = 'lmstudio-api';
    if (type === 'llm') {
      capabilities = ['text'];
    } else if (type === 'vlm') {
      capabilities = ['text', 'vision'];
    } else if (type === 'embeddings') {
      capabilities = ['embedding'];
    } else {
      capabilities = this.classifyModelName(id);
      source = 'heuristic';
    }

    return { id, capabilities, state, source };
  }

  classifyOllamaShowPayload(modelName, payload) {
    const id = String(modelName || '').trim();
    const rawCapabilities = Array.isArray(payload?.capabilities) ? payload.capabilities : null;

    if (!rawCapabilities) {
      return { id, capabilities: this.classifyModelName(id), state: null, source: 'heuristic' };
    }

    const normalized = rawCapabilities.map((value) => String(value || '').trim().toLowerCase());
    let capabilities;
    if (normalized.includes('embedding')) {
      capabilities = ['embedding'];
    } else if (normalized.includes('vision')) {
      capabilities = ['text', 'vision'];
    } else if (normalized.includes('completion')) {
      capabilities = ['text'];
    } else {
      capabilities = this.classifyModelName(id);
      return { id, capabilities, state: null, source: 'heuristic' };
    }

    return { id, capabilities, state: null, source: 'ollama-show' };
  }

  // ── Suggestion logic (deterministic; stable tie-break = list order) ──────

  parseParameterSizeBillions(rawValue) {
    const parsed = Number.parseFloat(String(rawValue || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  suggestModels(classifiedModels = []) {
    const textCandidates = classifiedModels.filter((model) => model.capabilities.includes('text'));
    const visionCandidates = classifiedModels.filter((model) => model.capabilities.includes('vision'));
    const ocrNameCandidates = textCandidates.filter(
      (model) => this.ocrNameHints.some((hint) => model.id.toLowerCase().includes(hint))
    );

    let suggestedAiModel = null;
    let bestAiScore = -1;
    textCandidates.forEach((model) => {
      const normalizedId = model.id.toLowerCase();
      let score = 0;
      if (model.state === 'loaded') {
        score += 2;
      }
      if (normalizedId.includes('instruct') || normalizedId.includes('chat')) {
        score += 1;
      }
      if (!model.capabilities.includes('vision')) {
        score += 1;
      }
      if (score > bestAiScore) {
        bestAiScore = score;
        suggestedAiModel = model.id;
      }
    });

    // Embedding-only hosts get no AI suggestion; a vision-only host can
    // still analyze text, so fall back to the first vision model.
    if (!suggestedAiModel && visionCandidates.length > 0) {
      suggestedAiModel = visionCandidates[0].id;
    }

    // Dedicated OCR models (named "*ocr*") are purpose-built for this and
    // take priority over generic vision models when present.
    const ocrCandidates = ocrNameCandidates.length > 0 ? ocrNameCandidates : visionCandidates;

    let suggestedOcrModel = null;
    let bestOcrScore = -1;
    let bestOcrSize = Number.POSITIVE_INFINITY;
    ocrCandidates.forEach((model) => {
      const score = model.state === 'loaded' ? 2 : 0;
      const size = this.parseParameterSizeBillions(model.parameterSize);
      const effectiveSize = size == null ? Number.POSITIVE_INFINITY : size;
      // Prefer higher score; on ties prefer the smaller model (cheaper
      // vision models are perfectly adequate for OCR).
      if (score > bestOcrScore || (score === bestOcrScore && effectiveSize < bestOcrSize)) {
        bestOcrScore = score;
        bestOcrSize = effectiveSize;
        suggestedOcrModel = model.id;
      }
    });

    return { suggestedAiModel, suggestedOcrModel };
  }

  // ── URL handling ──────────────────────────────────────────────────────────

  normalizeBaseUrls(baseUrl) {
    const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
      return null;
    }

    const bareBaseUrl = trimmed.replace(/\/v1$/i, '');
    return {
      bareBaseUrl,
      versionedBaseUrl: `${bareBaseUrl}/v1`
    };
  }

  buildRequestHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  // Which OCR provider to default the wizard to. This is deliberately not a
  // per-model capability guess (those can miss real OCR-capable models with
  // unfamiliar names); it only checks the one endpoint this codebase already
  // knows has a dedicated /ocr path (see
  // setupService.getMistralUrlValidationOptions). The "OCR fallback" wizard
  // step always lets the user override this before finishing setup.
  resolveOcrProviderDefault(bareBaseUrl) {
    const normalized = String(bareBaseUrl || '').trim().toLowerCase();
    return normalized.includes('api.mistral.ai') ? 'mistral' : 'custom';
  }

  buildLoopbackBlockedError(validationError) {
    return new Error(
      `URL validation failed: ${validationError} — localhost URLs are blocked by default. `
      + 'Use your machine\'s LAN IP or host.docker.internal instead, or set '
      + 'PAPERLESS_AI_SETUP_ALLOW_LOCALHOST=true to allow loopback addresses.'
    );
  }

  // ── Probing ───────────────────────────────────────────────────────────────

  async probeApiFlavor(bareBaseUrl, versionedBaseUrl, apiKey, probeTimeoutMs) {
    const headers = this.buildRequestHeaders(apiKey);
    const requestConfig = { headers, timeout: probeTimeoutMs };

    const [ollamaResult, lmStudioResult, openAiResult] = await Promise.allSettled([
      axios.get(`${bareBaseUrl}/api/tags`, requestConfig),
      axios.get(`${bareBaseUrl}/api/v0/models`, requestConfig),
      axios.get(`${versionedBaseUrl}/models`, requestConfig)
    ]);

    // Priority: ollama > lmstudio > openai-compatible. The richest metadata
    // source wins; Ollama and LM Studio both also serve /v1/models.
    if (ollamaResult.status === 'fulfilled' && Array.isArray(ollamaResult.value?.data?.models)) {
      return { flavor: 'ollama', payload: ollamaResult.value.data };
    }

    if (lmStudioResult.status === 'fulfilled') {
      const rawData = lmStudioResult.value?.data;
      const entries = Array.isArray(rawData?.data) ? rawData.data : (Array.isArray(rawData) ? rawData : []);
      // Require the LM Studio-specific "type" field so a generic server that
      // happens to answer on /api/v0/models is not misclassified.
      if (entries.length > 0 && entries.every((entry) => typeof entry?.type === 'string')) {
        return { flavor: 'lmstudio', payload: entries };
      }
    }

    if (openAiResult.status === 'fulfilled' && Array.isArray(openAiResult.value?.data?.data)) {
      return { flavor: 'openai-compatible', payload: openAiResult.value.data };
    }

    return null;
  }

  async mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    const runNext = async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    };

    const poolSize = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: poolSize }, () => runNext()));
    return results;
  }

  async classifyOllamaModels(bareBaseUrl, tagsPayload, apiKey, deadlineTimestamp) {
    const headers = this.buildRequestHeaders(apiKey);
    const entries = (Array.isArray(tagsPayload?.models) ? tagsPayload.models : [])
      .slice(0, OLLAMA_MODEL_CAP)
      .map((entry) => ({
        name: String(entry?.name || '').trim(),
        parameterSize: String(entry?.details?.parameter_size || '').trim()
      }))
      .filter((entry) => entry.name);

    return this.mapWithConcurrency(entries, OLLAMA_SHOW_CONCURRENCY, async (entry) => {
      // Past the soft deadline, skip the network call and degrade to the
      // name heuristic so the overall request stays within budget.
      if (Date.now() >= deadlineTimestamp) {
        return {
          id: entry.name,
          capabilities: this.classifyModelName(entry.name),
          state: null,
          source: 'heuristic',
          parameterSize: entry.parameterSize || null
        };
      }

      try {
        const response = await axios.post(
          `${bareBaseUrl}/api/show`,
          { model: entry.name },
          { headers, timeout: OLLAMA_SHOW_TIMEOUT_MS }
        );
        const classified = this.classifyOllamaShowPayload(entry.name, response.data);
        classified.parameterSize = entry.parameterSize || null;
        return classified;
      } catch {
        // A single failing model (e.g. corrupt manifest) must never fail
        // the whole detection; fall back to the name heuristic.
        return {
          id: entry.name,
          capabilities: this.classifyModelName(entry.name),
          state: null,
          source: 'heuristic',
          parameterSize: entry.parameterSize || null
        };
      }
    });
  }

  classifyLmStudioModels(entries) {
    return entries
      .map((entry) => {
        const classified = this.classifyLmStudioEntry(entry);
        classified.parameterSize = null;
        return classified;
      })
      .filter((model) => model.id);
  }

  classifyOpenAiCompatibleModels(payload) {
    const ids = (Array.isArray(payload?.data) ? payload.data : [])
      .map((entry) => String(entry?.id || '').trim())
      .filter(Boolean);

    return ids.map((id) => ({
      id,
      capabilities: this.classifyModelName(id),
      state: null,
      source: 'heuristic',
      parameterSize: null
    }));
  }

  // ── Main entry ────────────────────────────────────────────────────────────

  async detectAndClassify(options = {}) {
    const startTime = Date.now();
    const apiKey = String(options.apiKey || '').trim();
    const urls = this.normalizeBaseUrls(options.baseUrl);

    if (!urls) {
      throw new Error('A base URL is required for quickstart detection');
    }

    const validationOptions = setupService.getSetupUrlValidationOptions();
    const urlValidation = await validateApiUrl(urls.bareBaseUrl, validationOptions);
    if (!urlValidation.valid) {
      const isLoopback = /localhost|127\.0\.0\.1|\[?::1\]?/i.test(urls.bareBaseUrl);
      if (isLoopback && !validationOptions.allowLocalhost) {
        throw this.buildLoopbackBlockedError(urlValidation.error);
      }
      throw new Error(`URL validation failed: ${urlValidation.error}`);
    }

    const overallTimeoutMs = setupService.getValidationTimeoutMs();
    const probeTimeoutMs = Math.min(FLAVOR_PROBE_TIMEOUT_MS, overallTimeoutMs);

    const probeResult = await this.probeApiFlavor(
      urls.bareBaseUrl,
      urls.versionedBaseUrl,
      apiKey,
      probeTimeoutMs
    );

    if (!probeResult) {
      throw new Error(
        'No compatible API found at this URL. Checked Ollama (/api/tags), '
        + 'LM Studio (/api/v0/models) and OpenAI-compatible (/v1/models) endpoints.'
      );
    }

    let models;
    if (probeResult.flavor === 'ollama') {
      const elapsedMs = Date.now() - startTime;
      const deadlineTimestamp = startTime
        + Math.max(3000, overallTimeoutMs - elapsedMs - CLASSIFICATION_DEADLINE_HEADROOM_MS);
      models = await this.classifyOllamaModels(urls.bareBaseUrl, probeResult.payload, apiKey, deadlineTimestamp);
    } else if (probeResult.flavor === 'lmstudio') {
      models = this.classifyLmStudioModels(probeResult.payload);
    } else {
      models = this.classifyOpenAiCompatibleModels(probeResult.payload);
    }

    const textModels = models.filter((m) => m.capabilities.includes('text')).map((m) => m.id);
    const visionModels = models.filter((m) => m.capabilities.includes('vision')).map((m) => m.id);
    const embeddingModels = models.filter((m) => m.capabilities.includes('embedding')).map((m) => m.id);
    const { suggestedAiModel, suggestedOcrModel } = this.suggestModels(models);

    const isOllama = probeResult.flavor === 'ollama';
    return {
      flavor: probeResult.flavor,
      aiProvider: isOllama ? 'ollama' : 'custom',
      resolvedAiApiUrl: isOllama ? urls.bareBaseUrl : urls.versionedBaseUrl,
      ocrProvider: this.resolveOcrProviderDefault(urls.bareBaseUrl),
      resolvedOcrApiUrl: isOllama ? urls.bareBaseUrl : urls.versionedBaseUrl,
      models: models.map((m) => ({
        id: m.id,
        capabilities: m.capabilities,
        state: m.state,
        source: m.source
      })),
      textModels,
      visionModels,
      embeddingModels,
      suggestedAiModel,
      suggestedOcrModel
    };
  }

  buildDetectionSummaryMessage(detection) {
    const flavorLabels = {
      ollama: 'Ollama',
      lmstudio: 'LM Studio',
      'openai-compatible': 'an OpenAI-compatible API'
    };
    const label = flavorLabels[detection.flavor] || detection.flavor;
    const total = detection.models.length;
    const parts = [
      `${detection.textModels.length} text`,
      `${detection.visionModels.length} vision`,
      `${detection.embeddingModels.length} embedding`
    ];
    return `Detected ${label}: ${total} model${total === 1 ? '' : 's'} (${parts.join(', ')}).`;
  }
}

module.exports = new QuickstartService();
