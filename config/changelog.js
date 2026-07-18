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
      'New: Multi-page PDF OCR for local vision models - PDF pages are rendered via poppler (pdftoppm) and sent page by page',
      'Improvement: Saving settings no longer runs live AI/OCR connection tests - use the explicit test buttons to verify connectivity on demand',
      'Improvement: Settings page cleaned up - unified ON/OFF switches and clearer section grouping',
      'Fix: Reconciliation settings are now actually persisted when saved from the settings page',
      'Removed: Legacy data/.env migration notice on the settings page',
    ],
  },
  {
    version: 'v2026.07.04',
    entries: [
      'Fix: Quickstart OCR detection now suggests and lists dedicated OCR models (e.g. Mistral\'s mistral-ocr-latest) instead of requiring vision-capable naming, in both the Setup Wizard and Settings page',
      'Fix: Setup wizard no longer leaves a stale AI provider selected when switching from Quickstart to manual AI configuration',
      'Fix: AI response/prompt log files resolve relative to the working directory on native (non-Docker) installs',
      'Improvement: Quickstart\'s "use this service for OCR" option is now a proper ON/OFF switch, matching the rest of the settings UI',
    ],
  },
];

const latestRelease = RELEASES[RELEASES.length - 1];

module.exports = {
  version: latestRelease.version,
  entries: latestRelease.entries,
};
