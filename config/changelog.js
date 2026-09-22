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
      'New: A Duplicates page finds tags and correspondents that mean the same thing (case, umlaut spellings, legal forms, singular and plural, word order, small typos), says why and how sure it is, and merges each group into the survivor you pick through the Paperless-ngx API. Nothing runs on its own',
      'New: Every merge is logged locally and can be undone from the same page; restored objects get new ids in Paperless-ngx and their documents follow. Pairs marked as "not a duplicate" stay hidden on later scans until you show them again',
      'New: "Merge by hand" merges any tags or correspondents you pick yourself; several selected groups merge with one confirmation; groups sort by confidence, documents, name or kind, and one click selects every group at or above a chosen percentage',
      'New: "Ask the AI" lets your configured AI provider judge every group and near-miss on evidence (document titles, neighbouring tags and short excerpts) instead of spelling distance alone; "AI proposal" does all of that in one click and opens one overview with only the confirmed groups ticked',
      'New: The AI review runs as a job you can watch and stop: a progress bar with the phase, requests and pairs done, tokens spent against a budget and the time left, a Stop button that keeps the verdicts already reached, and a page that re-attaches to a running review after a reload',
      'New: The judge measures your model on a small first request, sizes every later request to a chosen number of seconds (DUPLICATES_AI_REQUEST_SECONDS), streams the answers so the bar moves inside a request, and keeps the measurement across restarts. Reasoning models think only on request (DUPLICATES_AI_THINKING, default off)',
      'New: "Let the AI look at the whole list" proposes synonyms, translations and abbreviations the spelling matcher cannot see; the proposals are judged with evidence like every other candidate (DUPLICATES_AI_SWEEP_NAMES)',
      'New: Document analysis no longer creates a near-duplicate of an existing tag or correspondent: a name that is the same word in another spelling uses the existing object, and every such mapping is listed on the Duplicates page with a link to the document (DUPLICATES_GUARD_NEW_NAMES, default on)',
      'New: An "Unused" section on the Duplicates page lists tags and correspondents without documents; delete them with one confirmation, undo re-creates them from the log',
      'New: A merge can name its survivor; the log remembers the old name and undo restores it',
      'New: A "Duplicates" section on the settings page holds every setting of the feature: the AI review on or off, a separate judge model (DUPLICATES_AI_MODEL), pairs per request, the candidate floor, excerpts, a token budget per review (DUPLICATES_AI_TOKEN_BUDGET) and an idle stop for reviews nobody is watching (DUPLICATES_AI_IDLE_STOP_SECONDS)',
      'Improvement: History and Restore keep working for documents a merge touched; the local records follow the merge and the undo',
      'Improvement: The Duplicates feature writes readable log lines for scans, merges, undos and every model request, and reads the tag and correspondent lists from Paperless-ngx in parallel',
      'New: A "Simplify tags" page next to Duplicates splits compound tags into a document type and topic tags: "Stromrechnung" becomes the document type "Rechnung" plus the tag "Strom". The model proposes a vocabulary of types and topics from your tag names (SIMPLIFY_VOCABULARY_SIZE, SIMPLIFY_TAGS_PER_REQUEST), you edit and save it, the proposals come by rule first and by the model second, and nothing is applied until you tick it',
      'New: A split fills the document type where none is set and keeps a different one; the confirmation says how many documents keep theirs, and a per-tag "overwrite type" switch sets it everywhere. Every split is logged with what it did per document and can be undone from the Duplicates page',
      'New: Document analysis decomposes a new compound tag name against the saved vocabulary instead of creating it, and the mapping is listed on the Duplicates page',
      'Improvement: The AI review treats the thinking a model does as a fixed cost per request instead of shrinking the batch, runs requests side by side (DUPLICATES_AI_CONCURRENCY, automatic: one for Ollama, three for hosted providers) and remembers every verdict so an unchanged pair is not asked again (DUPLICATES_AI_VERDICT_MEMORY_DAYS, default 90); "Forget remembered verdicts" clears the memory',
      'Improvement: Reasoning models that ignore the thinking switch are asked for low reasoning effort where their model family supports it',
      'Improvement: The document type field of the "Simplify tags" vocabulary is a searchable drop-down over the document types Paperless-ngx already has, with document counts, cached like the tags and a Reload next to it; an empty vocabulary offers to take over the existing types with one click, and a typed topic that is an existing tag says so',
      'New: "Propose a new order" on the Simplify tags page hands the model every tag and every document type in one job: it proposes the vocabulary itself and sorts each tag into one of four actions (split into a document type and topics, merge into another tag, keep, delete). The page shows the result as groups per document type, topic and merge target plus the keep and delete buckets; you accept or skip a group, take single tags out, and apply a group or everything accepted with one confirmation. Splits, merges and deletions are logged and undoable from the Duplicates page; the table of single proposals stays as the detail view',
      'New: Both review pages read as a proposal instead of a table: what a run found is sorted into baskets — what a rule settled, what the model is sure about, what needs a word from you, and what stays as it is — and every line is a sentence with its document count and the reason, not a row of nine columns. The old group cards and tables are still there behind a toggle',
      "New: The basket that needs answers opens one decision per screen: both names or the tag and what it would become, the document counts, the matching rules, sample documents, the model's own sentence, and three buttons with Enter, Esc and L. A shortcut takes the obvious ones in one go, the footer counts what you decided and undoes the last one",
      'New: Nothing model-backed starts without saying what it costs. A dialog before every run says in one sentence what it asks about, shows how long it takes as one number with the token split underneath, says where those numbers come from or that they are a guess, and promises that nothing is written while it runs. What you can change to make it cheaper is folded away under Options, and an option that would save nothing is not offered',
      'New: While a run works the page says what it is doing in two words, how far it is, and three numbers: how long it has been going, how much of the work is done and what it has spent against the estimate, with the tokens split into the question, the answer and the model thinking to itself. Under it every request of the last handful with what it cost and how it ended — including the one in flight, and one that thought for tokens and answered nothing. The ceiling that would end the run is named in the dialog beforehand and again once the run is near it',
      'New: Every button that writes says what it writes before it is pressed: how many documents change, how many objects are deleted, whether a model is asked, and whether it can be undone. Applying a plan runs as a live checklist, three at a time, with a failed step shown red and retryable',
      'New: What each finished run cost is written down (requests, prompt, answer and reasoning tokens, seconds), so the next estimate is measured instead of guessed; a stopped run counts too. The Simplify run can skip tags you already decided on and tags below a document count',
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
