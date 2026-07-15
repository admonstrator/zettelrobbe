// What's New changelog entries for the update modal.
// Add a new release block at the END of RELEASES whenever you release and keep
// its `version` in sync with PAPERLESS_AI_VERSION in config.js. Only the
// latest release is shown in the modal; older blocks stay here as history.
// Each entry is displayed as one bullet point in the modal.

const RELEASES = [
  {
    version: 'v2026.05.01',
    entries: [
      "New: What's New modal shows release highlights after each update",
      'Removed RAG features to focus on core document management capabilities <a href="https://github.com/admonstrator/paperless-ai-next/discussions/144">(see here)</a>',
    ],
  },
  {
    version: 'v2026.05.02',
    entries: ['Fix: Fixed hardcoded temperature settings for Ollama API'],
  },
  {
    version: 'v2026.06.01',
    entries: [
      'New: Local OCR providers available for selection in OCR settings',
      'New: Added support for Ollama API token usage metrics in document history',
      'Improvement: Updated base URL validation',
    ],
  },
  {
    version: 'v2026.07.01',
    entries: [
      'Fix: OCR timeout',
      'Fix: Document handling for re-tagged documents',
    ],
  },
  {
    version: 'v2026.07.02',
    entries: [
      'New: Quickstart AI setup routine for AI / OCR',
      'New: Optional bearer token support for Ollama endpoints (OLLAMA_API_KEY)',
      'New: Ignored documents queue to permanently exclude documents from AI processing',
      'Fix: OCR processing timeout is configurable via SETUP_OCR_VALIDATION_TIMEOUT_MS',
      'Fix: Docker image build on npm 12 (better-sqlite3 native bindings)',
    ],
  },
  {
    version: 'v2026.07.03',
    entries: [
      'New: Multi-page PDF OCR for local vision models - PDF pages are rendered via poppler (pdftoppm) and sent page by page (OCR_PDF_RENDER_ENABLED, OCR_PDF_RENDER_MAX_PAGES, OCR_PDF_RENDER_DPI)',
      'Improvement: Saving settings no longer runs live AI/OCR connection tests - use the explicit test buttons to verify connectivity on demand',
      'Improvement: Settings page cleaned up - unified ON/OFF switches and clearer section grouping',
      'Fix: Reconciliation settings (RECONCILIATION_ENABLED, RECONCILIATION_INTERVAL) are now actually persisted when saved from the settings page',
      'Removed: Legacy data/.env migration notice on the settings page',
    ],
  },
];

const latestRelease = RELEASES[RELEASES.length - 1];

module.exports = {
  version: latestRelease.version,
  entries: latestRelease.entries,
};
