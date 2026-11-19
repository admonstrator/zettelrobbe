// What's New changelog entries for the update modal.
// Add a new release block at the END of RELEASES whenever you release and keep
// its `version` in sync with PAPERLESS_AI_VERSION in config.js. Only the
// latest release is shown in the modal; older blocks stay here as history.
// `entries` is the full list the settings page shows. A release may also carry
// `highlights`, the short list for end users the modal shows instead; without
// it the modal shows `entries`.

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
  {
    version: 'v2026.10.01',
    entries: [
      'New: Anthropic (Claude) as AI provider. Settings and the setup wizard take an API key and list the Claude models it can use; Claude Haiku 5.5 is the default. The analysis comes back as structured output, and prompt caching keeps the repeated instructions cheap',
      'New: Claude as OCR provider. It reads PDFs and images directly and uses the API key and model of the AI provider unless OCR has its own',
      'Fix: Saving the settings no longer signs everybody out. The restart after a save created a new sign-in key, so every open session ended, and a page left open only showed vague errors such as "Model discovery failed". A session that ends now sends the page to the login screen',
      'Fix: The manual tagging page uses the current design again. Its buttons, cards, document preview and tag chips were still built on styles that no longer exist',
      'New: Single sign-on with any OpenID Connect provider (Authentik, Keycloak, Entra ID and others). Contributed by <a href="https://github.com/krauseerl">@krauseerl</a> in <a href="https://github.com/admonstrator/zettelrobbe/pull/372">#372</a>. E-mail addresses the provider marks as unverified are refused unless OIDC_ALLOW_UNVERIFIED_EMAIL=yes',
      'New: Single sign-on can be set up on the settings page, including a "Test connection" button. Values set by the container stay locked there',
      'Improvement: The settings page shows one topic at a time, grouped in a sidebar, with a search field and a save bar that counts unsaved changes across all topics',
      'Improvement: The Claude model is picked from a dropdown filled by "Fetch Models", like every other model',
      'Security: The login no longer reveals whether a username exists, a two-factor code is accepted only once, and the health endpoint keeps scanner and Paperless-ngx details behind authentication. Contributed by <a href="https://github.com/krauseerl">@krauseerl</a>',
    ],
  },
  {
    version: 'v2026.10.03',
    entries: [
      'Security: The SSRF check now recognises IPv4-mapped IPv6 answers in every spelling.',
      'Security: The container image now requires Node.js 26.12.1 or newer, which closes the Brotli remote-code-execution flaw and the TLS certificate hostname bypasses of the October 2026 Node.js release.',
      'Security: Updated dependencies to newer versions',
      'Fix: A Paperless-ngx URL written as an IPv6 literal is accepted instead of failing',
      'New: Skip rules keep documents away from OCR and AI - see details in the settings page',
    ],
  },
  {
    version: 'v2026.11.01',
    entries: [
      'New: Tidy up replaces Duplicates and Simplify tags: one page with suggestions in plain sentences (merge, split, delete), each with its reason and evidence; you accept or decline, and every change can be undone',
      'New: Sure, Likely and Needs a look instead of percentages; the details sit behind a disclosure',
      'New: Model failures are explained in plain words, with what to do next',
      'New: The inbox tag and named tags can be removed once a document is done (Settings → Tag Filters, also in the setup wizard)',
      'New: AI settings show the essentials; everything else is behind Advanced options with an explanation',
      'New: Saving settings restarts only when a changed value needs it; the page waits for the new server instead of reloading into a 502',
      'Improvement: The settings page no longer talks about environment variables; a pinned value is a disabled field with a note',
      'Improvement: Ollama thinking mode can be switched on the settings page',
      'Improvement: OpenAI, Azure and compatible endpoints share one service with per-model rules; GPT-5 and o-series models get the right request shape',
      'Removed: The Duplicates and Simplify tags pages (/duplicates and /simplify redirect to /tidy-up) and the Local Overrides section',
    ],
  },
  {
    version: 'v2026.11.02',
    highlights: [
      'New: Password-protected PDFs in the OCR queue can be unlocked, one by one with a typed password or all at once with a password list under Settings → OCR fallback (needs Paperless-ngx 3.0 or later)',
      'New: The prompt sent to the OCR model can be edited under Settings → OCR fallback',
      'New: The Manual page handles the hard cases: PDF preview, Run OCR, unlock a password-protected PDF, edit every field, delete, and step through work lists (unprocessed, failed, OCR queue, locked, ignored)',
      'Fix: A document the AI failed on three times goes to the failed list instead of being analysed again in every scan',
      'Fix: A document is no longer analysed twice when the scan and the webhook reach it at the same time',
      'Fix: The settings side list highlights the open topic again',
      'Improvement: Plus technical changes under the hood. The full list is in <a href="/settings#changelog">Settings → Changelog</a>',
    ],
    entries: [
      'New: Password-protected PDFs in the OCR queue can be unlocked, one by one with a typed password or all at once with a password list stored under Settings → OCR fallback. Paperless-ngx 3.0 or later removes the password and keeps the document as a new version of itself; on older versions such documents are marked as password protected and no longer cost a failed OCR call',
      'New: The prompt sent to the OCR model can be edited under Settings → OCR fallback, with a button to return to the built-in one (not shown for Mistral, which takes no prompt)',
      'New: The Manual page shows the document as a PDF preview or as text, runs OCR without writing anything unreviewed, unlocks a password-protected PDF, edits title, correspondent, document type, date and tags with the AI proposal under each field, deletes a document in Paperless-ngx, and steps through work lists (unprocessed, failed, OCR queue, locked, ignored). History, Failed, OCR queue and Ignored link to it',
      'Security: A session token is accepted only in an "Authorization: Bearer" header, and the routes reachable without login are matched on whole path segments',
      'Improvement: Updated dependencies (Anthropic and OpenAI SDKs, csrf-csrf, express-rate-limit, openid-client)',
      'Fix: The scan and the webhook no longer analyse the same document twice when they reach it at the same time',
      'Fix: A document the AI failed on three times goes to the failed list, where it can be reset, instead of being analysed again in later scans',
      'Fix: The webhook and a manual rescan protect a document like the scan does: no second OCR run for a document already in the OCR queue, and the same failure reasons and timeout hints',
      'Fix: A rescan leaves a document alone while it waits for OCR instead of deleting its local data; with OCR switched off, documents left in the OCR queue are processed again',
      'Fix: The external API is asked once per scan instead of once per document',
      'Fix: The settings side list highlights the open topic again',
      'Fix: An OCR key set by the container (OCR_API_KEY or MISTRAL_API_KEY) locks its field, changing the log level shows the restart note, and a Paperless-ngx URL that differs only by a trailing /api or slash no longer restarts the server',
      'Fix: Pressing Enter in a dialog confirms it instead of cancelling',
      'Improvement: Saving the minimum content length takes effect without a restart',
      'Improvement: The server routes are split into one module per feature; nothing changes on the pages',
      'Removed: The /api/duplicates and /api/simplify endpoints Tidy up does not use (the few it still calls remain)',
    ],
  },
  {
    version: 'v2026.11.03',
    highlights: [
      'New: One list to choose the AI provider, with Mistral added and "Other OpenAI-compatible server" for everything else',
      'New: Thinking effort for OpenAI, Azure and OpenAI-compatible servers under Settings → AI provider → Advanced options',
      'Fix: Mistral works as AI provider, also with its reasoning models (Magistral), and Tidy up no longer fails there',
      'Fix: The OCR test of Quickstart auto-detect passes for Mistral OCR models',
      'Improvement: Action needed for DeepSeek, GLM and other non-Qwen models behind vLLM, llama.cpp or LM Studio: switch on "Switch thinking through the chat template" (Settings → Tidy up → Advanced options), or they keep thinking in Tidy up',
      'Improvement: Plus technical changes under the hood. The full list is in <a href="/settings#changelog">Settings → Changelog</a>',
    ],
    entries: [
      'New: The AI provider is one list: OpenAI, Anthropic (Claude), Azure OpenAI, Mistral, IONOS, Ollama, LM Studio and "Other OpenAI-compatible server". Picking Mistral, IONOS or LM Studio fills in address and model; the setup wizard uses the same list. The second "AI Provider" field behind "Manual custom configuration" is gone',
      'New: Thinking effort (low, medium, high) for OpenAI, Azure and OpenAI-compatible servers. Empty sends nothing; OpenAI gets it only for the models that take it (gpt-5, o-series)',
      'New: "Switch thinking through the chat template" under Tidy up, for OpenAI-compatible servers: sends chat_template_kwargs to any model when Tidy up switches thinking off',
      'Improvement: Action needed: chat_template_kwargs now goes to Qwen models only, unless the new switch is on. If you run DeepSeek, GLM or another non-Qwen reasoning model behind vLLM, llama.cpp or LM Studio and Tidy up should not let it think, switch it on (Settings → Tidy up → Advanced options)',
      'Fix: Mistral answered 422 to Tidy up because of chat_template_kwargs <a href="https://github.com/admonstrator/zettelrobbe/issues/373">(see here)</a>',
      'Fix: The answers of Mistral reasoning models (Magistral), which arrive as parts with the thinking included, are read correctly',
      'Fix: Quickstart auto-detect in the settings tested a Mistral OCR model as a chat model and failed; it now tests it the way the OCR fallback Test button does',
      'Improvement: The fields of an OpenAI-compatible server are called Server address, API key and Model',
    ],
  },
  {
    version: 'v2026.11.04',
    entries: [
      'New: OCR before the first analysis (Settings → OCR fallback): send every document, or only documents with a tag such as needs-ocr, through OCR before the AI reads them, instead of analysing poor text first. Off by default; each document gets at most one OCR run. With a paid OCR service "every document" bills one run per document <a href="https://github.com/admonstrator/zettelrobbe/discussions/280">(see here)</a>',
      'New: The dashboard card "Processing status" shows the last scan, the next scheduled scan with a countdown and the schedule in words <a href="https://github.com/admonstrator/zettelrobbe/discussions/363">(see here)</a>',
      'New: After an update the welcome dialog says so at the top and names the version you came from',
      'Improvement: A password-protected PDF is analysed as soon as Paperless-ngx has stored the unlocked version, instead of waiting for the next scheduled scan',
      'Improvement: The version number on the About page opens the welcome dialog again',
      'New: Settings open on a Quick start: the six decisions Zettelrobbe needs, each with its current value, changed in place',
      'Improvement: Settings topics keep to a readable column, and every switch shows On or Off right next to it instead of at the far edge of the window',
      'Improvement: Every label and hint on the settings page says what the setting does to a document. The switches for title, tags, correspondent, document type and custom fields moved to "What the AI fills in", and the prompt has its own topic',
      'Improvement: "Find a setting" in the topic list searches all settings and marks the matches',
      'Improvement: Every list of values (tags, title patterns, sign-on scopes, the Tidy up vocabulary) is entered as removable pills; pasting "a, b, c" makes three',
      'Fix: With Ollama the answer of the external API now reaches the prompt; before, the model got "[object Promise]" instead',
      'Fix: The transform path of the external API is applied: a path such as data.items[0].name sends only that part of the answer to the model. If the field still holds the old JavaScript function, clear it',
      'Fix: The OCR timeout has one default, the 120 seconds OCR always waited. The form showed 30 and wrote 30 on every save; if a slow local OCR model times out, check the field under Settings, OCR',
      'Fix: With "Tag analysed documents" on and no tag name set, documents get the tag ai-processed, as the page always showed. An empty name still means no tag',
      'Fix: The external API follows at most five redirects and checks each one with the same rule as the address you entered. Your configured headers go only to that address',
      'Fix: An OCR timeout of 30 seconds that older versions saved as the form default is raised to 120 seconds once. Any other value stays, and 30 seconds you set afterwards stay too',
      'New: Settings, System, "Set by the environment" lists every setting your docker-compose file decides. "Take over" stores a value in Zettelrobbe, so the line can be deleted from docker-compose and the field edited here',
      'Improvement: The settings page has one scrollbar and is made of the same cards as the other pages: the topic list is a card, and every section is a card with its title in the head. The groups of the topic list fold, every switch says what it does, and a field ends at the same right edge as its card',
      'Improvement: The save bar of the settings page appears only when something changed, names the changed settings and never lies over a field',
      'Improvement: Every page starts at the same point under the top bar and keeps the same distance between its cards. On Manual the search card no longer touches the cards below it',
      'Removed: The Paperless-ngx user name and the slider "Generation creativity". Zettelrobbe signs in with the API token alone, and nothing used the slider since the document chat was removed. PAPERLESS_USERNAME and AI_TEMPERATURE_GENERATION are ignored and can be deleted from docker-compose',
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
  entries: latestRelease.highlights || latestRelease.entries,
  releases,
  categorizeEntry,
};
