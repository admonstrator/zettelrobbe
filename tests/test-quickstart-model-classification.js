const assert = require('assert');

const quickstartService = require('../services/quickstartService');

// ── classifyModelName heuristics ─────────────────────────────────────────────

const heuristicCases = [
  // Vision models (imply text capability)
  ['llava:13b', ['text', 'vision']],
  ['bakllava', ['text', 'vision']],
  ['qwen2.5-vl-7b', ['text', 'vision']],
  ['minicpm-v', ['text', 'vision']],
  ['moondream', ['text', 'vision']],
  ['pixtral-12b', ['text', 'vision']],
  ['gemma3:4b', ['text', 'vision']],
  ['llama3.2-vision:11b', ['text', 'vision']],
  ['internvl2-8b', ['text', 'vision']],
  ['smolvlm-instruct', ['text', 'vision']],
  // Embedding models (excluded from suggestions)
  ['nomic-embed-text', ['embedding']],
  ['bge-m3', ['embedding']],
  ['text-embedding-3-small', ['embedding']],
  ['all-minilm', ['embedding']],
  ['gte-large', ['embedding']],
  ['e5-mistral-7b', ['embedding']],
  ['jina-reranker-v2', ['embedding']],
  // Text models
  ['qwen2.5-7b-instruct', ['text']],
  ['mistral:7b', ['text']],
  ['llama3.2', ['text']],
  ['phi4', ['text']]
];

heuristicCases.forEach(([modelId, expected]) => {
  assert.deepStrictEqual(
    quickstartService.classifyModelName(modelId),
    expected,
    `classifyModelName('${modelId}') should return ${JSON.stringify(expected)}`
  );
});

// Documented accepted false positive: text-only gemma3 variant reads as vision.
assert.deepStrictEqual(quickstartService.classifyModelName('gemma3:1b'), ['text', 'vision']);

// ── classifyLmStudioEntry ────────────────────────────────────────────────────

const vlmEntry = quickstartService.classifyLmStudioEntry({ id: 'qwen2-vl-7b', type: 'vlm', state: 'loaded' });
assert.deepStrictEqual(vlmEntry.capabilities, ['text', 'vision'], 'LM Studio vlm type should map to text+vision');
assert.strictEqual(vlmEntry.state, 'loaded', 'LM Studio state should be carried through');
assert.strictEqual(vlmEntry.source, 'lmstudio-api');

const llmEntry = quickstartService.classifyLmStudioEntry({ id: 'qwen2.5-7b-instruct', type: 'llm', state: 'not-loaded' });
assert.deepStrictEqual(llmEntry.capabilities, ['text']);
assert.strictEqual(llmEntry.state, 'not-loaded');

const embeddingsEntry = quickstartService.classifyLmStudioEntry({ id: 'nomic-embed-text-v1.5', type: 'embeddings', state: 'loaded' });
assert.deepStrictEqual(embeddingsEntry.capabilities, ['embedding'], 'LM Studio embeddings type should be excluded');

const unknownTypeEntry = quickstartService.classifyLmStudioEntry({ id: 'llava-1.6', type: 'future-type', state: null });
assert.deepStrictEqual(unknownTypeEntry.capabilities, ['text', 'vision'], 'Unknown LM Studio type should fall back to name heuristic');
assert.strictEqual(unknownTypeEntry.source, 'heuristic');

// ── classifyOllamaShowPayload ────────────────────────────────────────────────

const ollamaVision = quickstartService.classifyOllamaShowPayload('llava:13b', { capabilities: ['completion', 'vision'] });
assert.deepStrictEqual(ollamaVision.capabilities, ['text', 'vision'], 'Ollama vision capability should map to text+vision');
assert.strictEqual(ollamaVision.source, 'ollama-show');

const ollamaText = quickstartService.classifyOllamaShowPayload('mistral:7b', { capabilities: ['completion'] });
assert.deepStrictEqual(ollamaText.capabilities, ['text']);
assert.strictEqual(ollamaText.source, 'ollama-show');

const ollamaEmbedding = quickstartService.classifyOllamaShowPayload('nomic-embed-text', { capabilities: ['embedding'] });
assert.deepStrictEqual(ollamaEmbedding.capabilities, ['embedding']);

const ollamaMissingCapabilities = quickstartService.classifyOllamaShowPayload('llava:13b', {});
assert.deepStrictEqual(ollamaMissingCapabilities.capabilities, ['text', 'vision'], 'Missing capabilities should fall back to name heuristic');
assert.strictEqual(ollamaMissingCapabilities.source, 'heuristic');

// ── suggestModels ────────────────────────────────────────────────────────────

// Loaded beats not-loaded
const loadedBeatsUnloaded = quickstartService.suggestModels([
  { id: 'model-a-instruct', capabilities: ['text'], state: 'not-loaded', parameterSize: null },
  { id: 'model-b', capabilities: ['text'], state: 'loaded', parameterSize: null }
]);
assert.strictEqual(loadedBeatsUnloaded.suggestedAiModel, 'model-b', 'A loaded model should beat an unloaded instruct model');

// instruct beats plain (same state)
const instructBeatsPlain = quickstartService.suggestModels([
  { id: 'plain-model', capabilities: ['text'], state: null, parameterSize: null },
  { id: 'tuned-model-instruct', capabilities: ['text'], state: null, parameterSize: null }
]);
assert.strictEqual(instructBeatsPlain.suggestedAiModel, 'tuned-model-instruct', 'An instruct model should beat a plain model');

// Dedicated text model beats VLM for AI suggestion; VLM suggested for OCR
const mixed = quickstartService.suggestModels([
  { id: 'vlm-model', capabilities: ['text', 'vision'], state: null, parameterSize: null },
  { id: 'text-model', capabilities: ['text'], state: null, parameterSize: null }
]);
assert.strictEqual(mixed.suggestedAiModel, 'text-model', 'A dedicated text model should be preferred for AI analysis');
assert.strictEqual(mixed.suggestedOcrModel, 'vlm-model', 'The vision model should be suggested for OCR');

// Embeddings never suggested
const embeddingOnly = quickstartService.suggestModels([
  { id: 'nomic-embed-text', capabilities: ['embedding'], state: 'loaded', parameterSize: null }
]);
assert.strictEqual(embeddingOnly.suggestedAiModel, null, 'Embedding models must never be suggested for AI');
assert.strictEqual(embeddingOnly.suggestedOcrModel, null, 'Embedding models must never be suggested for OCR');

// No vision models -> null OCR suggestion
const textOnly = quickstartService.suggestModels([
  { id: 'mistral:7b', capabilities: ['text'], state: null, parameterSize: null }
]);
assert.strictEqual(textOnly.suggestedOcrModel, null, 'No vision model should yield a null OCR suggestion');

// Vision-only host: VLM falls back as AI suggestion
const visionOnly = quickstartService.suggestModels([
  { id: 'llava:13b', capabilities: ['text', 'vision'], state: null, parameterSize: null }
]);
assert.strictEqual(visionOnly.suggestedAiModel, 'llava:13b', 'A vision-capable model should back-fill the AI suggestion');
assert.strictEqual(visionOnly.suggestedOcrModel, 'llava:13b', 'The same model may be both suggestions');

// OCR tie-break: smaller parameter size wins on equal score
const sizeTieBreak = quickstartService.suggestModels([
  { id: 'llava:34b', capabilities: ['text', 'vision'], state: null, parameterSize: '34B' },
  { id: 'llava:7b', capabilities: ['text', 'vision'], state: null, parameterSize: '7.2B' }
]);
assert.strictEqual(sizeTieBreak.suggestedOcrModel, 'llava:7b', 'Smaller vision models should win the OCR tie-break');

// Deterministic order: first candidate wins on full tie
const stableOrder = quickstartService.suggestModels([
  { id: 'first-model', capabilities: ['text'], state: null, parameterSize: null },
  { id: 'second-model', capabilities: ['text'], state: null, parameterSize: null }
]);
assert.strictEqual(stableOrder.suggestedAiModel, 'first-model', 'Ties should resolve to server list order');

// Empty input
const empty = quickstartService.suggestModels([]);
assert.strictEqual(empty.suggestedAiModel, null);
assert.strictEqual(empty.suggestedOcrModel, null);

// ── normalizeBaseUrls ────────────────────────────────────────────────────────

assert.deepStrictEqual(
  quickstartService.normalizeBaseUrls('http://192.168.1.5:1234/v1/'),
  { bareBaseUrl: 'http://192.168.1.5:1234', versionedBaseUrl: 'http://192.168.1.5:1234/v1' },
  'Trailing slash and /v1 suffix should be normalized'
);
assert.deepStrictEqual(
  quickstartService.normalizeBaseUrls('http://host:11434'),
  { bareBaseUrl: 'http://host:11434', versionedBaseUrl: 'http://host:11434/v1' }
);
assert.strictEqual(quickstartService.normalizeBaseUrls('   '), null, 'Blank input should return null');

// ── resolveOcrProviderDefault ────────────────────────────────────────────────
// Regression coverage for issue #236: the OCR dropdown must never be gated on
// the vision name-heuristic (a dedicated OCR model like Mistral's
// `mistral-ocr-latest` matches no vision hint and would classify as
// ['text'] below, exactly like a plain chat model). Only the OCR
// *provider* default is host-based, and only for the one endpoint this
// codebase already special-cases elsewhere (services/setupService.js
// getMistralUrlValidationOptions).

assert.deepStrictEqual(
  quickstartService.classifyModelName('mistral-ocr-latest'),
  ['text'],
  'A dedicated OCR model with an unfamiliar name must not be silently excluded from the OCR dropdown just because it fails the vision heuristic'
);

assert.strictEqual(
  quickstartService.resolveOcrProviderDefault('https://api.mistral.ai'),
  'mistral',
  'The detected Mistral API host should default the OCR provider to the dedicated Mistral OCR path'
);
assert.strictEqual(
  quickstartService.resolveOcrProviderDefault('https://api.mistral.ai/v1'),
  'mistral',
  'A versioned Mistral URL should still resolve to the mistral OCR provider default'
);
assert.strictEqual(
  quickstartService.resolveOcrProviderDefault('http://192.168.1.5:1234'),
  'custom',
  'A local/non-Mistral host should default to the custom (chat-completions) OCR provider'
);
assert.strictEqual(
  quickstartService.resolveOcrProviderDefault(''),
  'custom',
  'A blank host should fall back to the custom OCR provider default'
);

console.log('✅ test-quickstart-model-classification passed');
