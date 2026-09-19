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
      'New: Duplicates page finds tags and correspondents that mean the same thing (case, umlaut spellings, legal forms, singular/plural, word order, typos), says why and how sure it is, and merges each group into the survivor you pick through the Paperless-ngx API. Nothing runs on its own',
      'New: Every merge is logged locally and can be undone from the same page; restored objects get new ids in Paperless-ngx and documents that still carry the target move back',
      'New: Pairs marked as "not a duplicate" stay hidden on later scans until you show them again',
      'Improvement: History and Restore keep working for documents a merge touched; the local records follow the merge and the undo',
      'New: "Merge by hand" on the Duplicates page merges any tags or correspondents you pick yourself, with the same checks, log and undo as a scanned group',
      'New: "Ask the AI" on the Duplicates page lets your configured AI provider judge every proposed group and the near-misses below your sensitivity; verdicts and reasons appear beside the deterministic result, nothing merges by itself (DUPLICATES_AI_REVIEW, DUPLICATES_AI_REVIEW_BATCH_SIZE, DUPLICATES_AI_CANDIDATE_FLOOR)',
      'Improvement: Duplicates page merges several selected groups with one confirmation, one after the other, and reloads only the log at the end',
      'Fix: "Ask the AI" no longer fails on the completion token limit; batches are sized by the token budget, a cut-off answer is salvaged and the rest re-asked in smaller batches',
      'Improvement: The Duplicates feature writes readable log lines for scans, merges, undos and every model request; the dashboard refreshes once per burst of merges instead of once per merge',
      'New: Duplicates page sorts groups by confidence, documents, name or kind, selects every group at or above a chosen percentage in one move, and shows how the groups spread over the confidence bands',
      'New: "Ask the AI, then merge" reviews exactly the selected groups, shows the verdicts and reasons in one dialog with the confirmed ones pre-ticked, and merges what stays ticked; a custom scan threshold joins the three presets',
      'New: "AI proposal" on the Duplicates page scans, lets the model judge every group and near-miss, and opens one overview with only the sure matches pre-ticked; you deselect, nothing merges by itself',
      'Improvement: The AI judge no longer takes a small spelling distance as proof of a typo. Pairs settled by a spelling rule (case, umlauts, legal form) are pre-ticked without asking the model; for pairs linked by spelling alone it reads short excerpts of a couple of documents per entry, every judged entry brings its matching rule and the names it is usually filed with, unsure pairs are asked once more with excerpts, and every verdict names its basis and how sure the model is (DUPLICATES_AI_EXCERPTS, DUPLICATES_AI_EXCERPT_CHARS, DUPLICATES_AI_EXCERPT_DOCUMENTS)',
      'New: DUPLICATES_AI_MODEL lets the judge run on a stronger model of the configured provider while document analysis keeps its own',
      'Fix: The member tables of the group cards line up across cards; long names truncate instead of shifting the columns',
      'New: A "Duplicates" section on the settings page holds every setting of the feature: AI review on or off, the judge model, pairs per request, the candidate floor, excerpts and their length and count',
      'New: The AI review on the Duplicates page runs as a job you can watch and stop: a progress bar with the phase, requests and pairs done, tokens spent against the budget and the time left, a Stop button that keeps the verdicts already reached, and a page that re-attaches to a running review after a reload',
      'New: Two brakes for the AI review, both on the settings page: a token budget per review that stops it on its own (DUPLICATES_AI_TOKEN_BUDGET, default 200000, 0 = no limit) and an idle stop that ends a review nobody has been watching (DUPLICATES_AI_IDLE_STOP_SECONDS, default 60, 0 = never)',
      'Improvement: The judge plans every request before the first one, so the bar has a denominator and the estimate is known up front; the log says why a review stopped and what it cost',
      'Improvement: The AI judge measures your model on a small first request and then asks about as many pairs per request as fit into a chosen number of seconds (DUPLICATES_AI_REQUEST_SECONDS, default 30), remembers the measurement per model, and raises its answer limit before it halves a batch; a cut-off answer keeps the verdicts already in it',
      'New: The judge asks the model not to think unless you say so (DUPLICATES_AI_THINKING, default off): reasoning models spent the whole answer budget on their thoughts before the first verdict',
      'Improvement: The AI review streams the answers, so the progress bar moves inside a request, says when the model is thinking and how many answers have arrived; a review of a fresh scan no longer scans again',
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
