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
      'Removed RAG features to focus on core document management capabilities <a href="https://github.com/admonstrator/zettelrobbe/discussions/144">(see here)</a>',
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
      "Fix: Quickstart OCR detection now suggests and lists dedicated OCR models (e.g. Mistral's mistral-ocr-latest) instead of requiring vision-capable naming, in both the Setup Wizard and Settings page",
      'Fix: Setup wizard no longer leaves a stale AI provider selected when switching from Quickstart to manual AI configuration',
      'Fix: AI response/prompt log files resolve relative to the working directory on native (non-Docker) installs',
      'Improvement: Quickstart\'s "use this service for OCR" option is now a proper ON/OFF switch, matching the rest of the settings UI',
    ],
  },
  {
    version: 'v2026.08.01',
    entries: [
      'New: %RESTRICTED_DOCUMENT_TYPES% placeholder for custom system prompts - lists the existing document types, just like %RESTRICTED_TAGS% and %RESTRICTED_CORRESPONDENTS% already did',
      'Fix: Document scanning no longer stops permanently when Paperless-ngx is unreachable at startup - the schedule is armed regardless, retries during startup, and recovers on its own without a restart',
      'Fix: RECONCILIATION_ENABLED=no now actually disables automatic reconciliation',
      'Fix: Existing tags reach the AI as readable names again instead of "[object Object]" when a document is reprocessed via Rescan or the webhook - the model can match against them and stops creating near-duplicate tags',
      'Fix: The %RESTRICTED_TAGS% placeholder in custom system prompts no longer resolves to an empty list during regular scans, OCR fallback and the playground',
      'Improvement: The /health endpoint reports scanner state and answers 503 while document scanning is degraded, so monitoring can detect a stalled scan loop <a href="https://zettelrob.be/getting-started/monitoring/" target="_blank" rel="noopener">(see here)</a>',
      'Improvement: The dashboard shows a warning banner while document scanning is not working',
    ],
  },
  {
    version: 'v2026.08.02',
    entries: [
      'Fix: The dashboard now warns as soon as Paperless-ngx cannot be reached, instead of staying silent until three scan runs in a row have failed',
      'Fix: A rejected API token is reported as a credentials problem instead of "Paperless-ngx is not reachable"',
      'Fix: Giving up on the initial scan after a startup outage is counted as a failed run, so the dashboard and /health reflect it',
      'New: Paperless-ngx connectivity is probed every 60s independently of the scan loop, so outages surface between scans and with DISABLE_AUTOMATIC_PROCESSING=yes (configurable via PAPERLESS_PROBE_INTERVAL_SECONDS, 0 disables it)',
      'New: The OCR queue can be processed automatically on a schedule, running OCR and AI analysis without pressing "Process All Pending" - configurable under Settings &rarr; OCR',
      "New: Settings has a Changelog tab showing the full release history, so past release notes are readable after the What's New modal has been dismissed",
    ],
  },
  {
    version: 'v2026.08.03',
    entries: [
      'New: Dashboard widgets can be rearranged, resized and hidden in an explicit edit mode',
      'New: The date format is configurable between DD.MM.YYYY and YYYY-MM-DD under Settings &rarr; System &rarr; Display',
      'New: History rows can start OCR with AI analysis directly, and send a document to Reanalyze or Ignore',
      'Fix: The "Response Tokens" setting is applied as the AI response limit - Ollama was capped at 256 tokens regardless of it, which cut long answers off mid-sentence <a href="https://github.com/admonstrator/zettelrobbe/issues/263">(see here)</a>',
      'Fix: An AI answer that was cut off is reported as a failed document instead of being silently marked processed with nothing extracted',
      'Improvement: The dashboard serves its statistics from a cache instead of querying Paperless-ngx on every request',
      'Improvement: The tag cache is rebuilt in two requests instead of one per 25 tags, which could stall startup for a minute on large libraries',
    ],
  },
  {
    version: 'v2026.08.04',
    entries: [
      'Fix: "Scan now" no longer fails with an unexplained error when the configured Paperless username does not match a Paperless-ngx login name &mdash; the scan never needed that user ID <a href="https://github.com/admonstrator/zettelrobbe/issues/305">(see here)</a>',
      'Fix: Searching for a document by its Paperless-ngx ID finds it, instead of returning nothing unless the number happens to appear in the document text <a href="https://github.com/admonstrator/zettelrobbe/issues/304">(see here)</a>',
      'Fix: OCR model detection offers every discovered model instead of only those whose name looks like a vision model, so models such as gpt-4o are selectable again; vision models are still grouped on top as a recommendation <a href="https://github.com/admonstrator/zettelrobbe/issues/308">(see here)</a>',
      'Improvement: The Quickstart auto-detect block in Settings prefills the configured AI server URL, reuses a stored API key when the field is left empty, and states that its two fields drive the detection run only <a href="https://github.com/admonstrator/zettelrobbe/issues/306">(see here)</a>',
      'Removed: The Playground is deprecated and gone from the navigation; it will be removed entirely in a future release. Saved prompts live in the browser only &mdash; copy anything you want to keep <a href="https://github.com/admonstrator/zettelrobbe/issues/307">(see here)</a>',
    ],
  },
  {
    version: 'v2026.08.05',
    entries: [
      'Fix: The Add button and the Enter key work again in the Tags and Ignore Tags fields under Settings; pressing Enter added the tag instead of saving the configuration, and existing tags can be removed again <a href="https://github.com/admonstrator/zettelrobbe/issues/299">(see here)</a>',
      'Fix: The "AI analysis after OCR" switch on the OCR queue keeps its position instead of resetting every time the page is opened. It applies to the runs started there and is remembered per browser; the scheduled queue drain still follows Settings &rarr; OCR <a href="https://github.com/admonstrator/zettelrobbe/issues/300">(see here)</a>',
      'Fix: Mistral OCR receives images as images. The OCR connection test declared its test image a document, which Mistral rejects, so the test failed even with a valid API key and mistral-ocr-latest; OCR of image documents was affected the same way',
      'Fix: Settings labels show their "set through the environment" and "runtime override" markers again',
    ],
  },
  {
    version: 'v2026.09.01',
    entries: [
      'Security: Multi-factor authentication can no longer be bypassed with the password alone. The interim token issued between the password and the TOTP step was accepted as a full session by every guard. All existing sessions are signed out once after this update',
      'Security: The setup wizard stays closed once an administrator account exists. An incomplete configuration used to reopen it, and completing it again replaced the existing administrator and the Paperless-ngx connection without any login; a signed-in administrator is sent to Settings instead',
      'Security: API tokens and provider keys no longer end up in the log files. Error output is redacted before it is written, and a full disk no longer crashes the app through its own logging',
      'Fix: Reconciliation no longer deletes the local history and the "restore original" snapshots when Paperless-ngx answers incompletely or not at all. A run that cannot trust the answer is skipped and says why, including the manual reconciliation under Settings',
      'Fix: Rescanning a document that Paperless-ngx cannot deliver at that moment leaves its history and restore data untouched and reports it, instead of deleting them first and reporting success',
      'Fix: An OCR run that returns no text no longer replaces the document content in Paperless-ngx with an empty string; empty and cut-off OCR results count as failed',
      'Fix: Documents that just finished OCR and AI analysis are no longer queued for a second, paid OCR run by the scheduled scan. The scan also skips documents waiting for OCR and stands down while the automatic queue drain runs <a href="https://github.com/admonstrator/zettelrobbe/issues/322">(see here)</a>',
      'Fix: An invalid TOKEN_LIMIT such as "128k" no longer makes the AI analyse an empty document and invent metadata. It falls back to the default with a warning, and Settings rejects such a value',
      'Fix: Documents longer than the token budget are sent to OpenAI and Azure as text again. Truncation used to produce a request the providers rejected with "Invalid type for messages[1].content"',
      'Improvement: "Run OCR again" from the history queues a completed document for real, and the OCR queue responses count only documents that were actually queued',
      'Improvement: Dependencies updated to close the open security advisories (fast-uri, js-yaml, qs, @humanfs/node, colord)',
    ],
  },
  {
    version: 'v2026.09.02',
    entries: [
      'New: Duplicates finds tags and correspondents that mean the same thing (case, umlauts, legal forms, plurals, word order, typos) and merges them in Paperless-ngx. Unused ones can be deleted there too. Every merge and every deletion is logged and can be undone',
      'New: Simplify tags gives every tag one action: split it into a document type and topics ("Stromrechnung" becomes the type "Rechnung" and the tag "Strom"), merge it into another tag, keep it or delete it. Rules decide first, the model decides the rest, and every change can be undone',
      'Changed: Duplicates and Simplify tags are one page again. The assistant sits at the top and says what happens now, why, and how the tools below are used once it is done; the tools are there from the first second, dimmed until a result exists, and the proposal lands in them as ticks. The two modes and the switch between them are gone',
      'Changed: While a run goes, the page shows its steps, a sentence per step, what the model has answered so far (same, different, unsure) and one row per request that says what it read (pairs, names or tags)',
      'Changed: A pair only the model proposed (the synonym sweep) is never ticked on its own: it needs a second sign. Its "same" is no longer remembered for later runs either',
      'New: The model judges pairs on evidence (document titles, neighbouring tags, short excerpts) and can look for synonyms and translations. A run streams its progress, can be stopped, keeps to a token budget and remembers its verdicts',
      'New: Document analysis reuses an existing tag or correspondent instead of creating another spelling of it (DUPLICATES_GUARD_NEW_NAMES)',
      'New: Settings sections for Duplicates and Simplify tags',
    ],
  },
];

const latestRelease = RELEASES[RELEASES.length - 1];

// Entries are written as "New: ...", "Fix: ...", "Improvement: ..." and are
// split into a category and the text itself so the settings page can render
// them as labelled items. Anything without a known prefix becomes a 'note'.
const KNOWN_CATEGORIES = ['new', 'fix', 'improvement', 'removed', 'security'];

function categorizeEntry(entry) {
  const text = String(entry);
  const match = /^([a-z]+)\s*:\s*/i.exec(text);
  const category = match ? match[1].toLowerCase() : null;

  if (!category || !KNOWN_CATEGORIES.includes(category)) {
    return { category: 'note', text };
  }

  return { category, text: text.slice(match[0].length) };
}

// Newest release first — that is the order the settings page displays.
const releases = RELEASES.map((release) => ({
  version: release.version,
  entries: release.entries.map(categorizeEntry),
})).reverse();

module.exports = {
  version: latestRelease.version,
  entries: latestRelease.entries,
  releases,
  categorizeEntry,
};
