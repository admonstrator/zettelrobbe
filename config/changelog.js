// What's New changelog entries for the update modal.
// Update `version` to match PAPERLESS_AI_VERSION in config.js whenever you release.
// Each entry in `entries` is displayed as one bullet point in the modal.

module.exports = {
  version: 'v2026.05.01',
  entries: [
    'New: What\'s New modal shows release highlights after each update',
    'Removed RAG features to focus on core document management capabilities <a href="https://github.com/admonstrator/paperless-ai-next/discussions/144">(see here)</a>',
  ],
  version: 'v2026.05.02',
  entries: [
    'Fix: Fixed hardcoded temperature settings for Ollama API',
  ],
  version: 'v2026.06.01',
  entries: [
    'New: Local OCR providers available for selection in OCR settings',
    'New: Added support for Ollama API token usage metrics in document history',
    'Improvement: Updated base URL validation'
  ],
  version: 'v2026.07.01',
  entries: [
    'Fix: OCR timeout',
    'Fix: Document handling for re-tagged documents',
  ],
  version: 'v2026.07.02',
  entries: [
    'New: Quickstart AI setup routine for AI / OCR',
    'New: Optional bearer token support for Ollama endpoints (OLLAMA_API_KEY)',
    'New: Ignored documents queue to permanently exclude documents from AI processing',
    'Fix: OCR processing timeout is configurable via SETUP_OCR_VALIDATION_TIMEOUT_MS',
    'Fix: Docker image build on npm 12 (better-sqlite3 native bindings)',
  ],
};
