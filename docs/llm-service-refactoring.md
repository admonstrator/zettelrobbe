# LLM Service Refactoring Plan

**Status: done** (2026-10-15) — steps 1-8, and step 9 except the live smoke run. The four
provider services are composition roots of one `DocumentAnalyzer` (`services/llm/`),
`POST /manual/analyze` goes through `AIServiceFactory`, and `services/manualService.js` is gone.
What is left is listed under Out of Scope / Follow-ups. The plan is kept as the record of why the
code looks the way it does; the commit bodies hold the details of each step.

Measured against the expected benefits: the four services shrank from 2783 lines to four one-line
re-exports and `manualService.js` (284 lines) is gone, while `services/llm/` holds 2636 lines. The
saving is smaller than the ~2000 lines expected: the remaining code carries JSDoc, and the checks
that now apply to every provider — the refusal check (7c), the metadata check (7k), the field
defaults — each existed in one service before.

## The Goal

Four provider services offer the same business service through different AI APIs. Implement the
business logic **once** and keep the API-specific parts in thin, injected adapters.

In scope: `openaiService.js`, `azureService.js`, `customService.js`, `ollamaService.js`, and the
removal of `manualService.js` (see Finding 1 — it is dead code).

Rules for this work:

- Apply TDD.
- Adhere to the conventions in `/CLAUDE.md` (English only, singleton services, `{ success, data }`
  API shape, OpenAPI kept in sync, commit body as the single source of truth).
- Prefer **delegation over inheritance**. No abstract base class, no `extends`.
- New tests must be symmetrical to the existing tests and registered in the test runner.

### Expected Benefits

- Single point of business logic (prompt building, token budgeting, parsing, result shaping).
- Easier maintenance and extension — a new provider is one adapter plus one composition root.
- Better test coverage: injected collaborators make the seams testable without `require.cache` tricks.
- Centralized, consistent error handling and result shaping.
- Removal of ~2000 lines of near-duplicate code across four services.

---

## Validation Against the Source Code

The following was verified against the working tree. Each finding constrains the design that follows.
Line numbers were re-checked after the merge of upstream v2026.09.03 (merge `9d337d2`).

### 1. `manualService.js` is dead code

A repo-wide search across all file types finds **no reference** to `services/manualService.js`
(no `require`, no route, no view, no test). Refactoring it in isolation changes nothing at runtime.

The duplication that the "manual" business service actually suffers from lives in
`routes/setup.js`, which switches on `process.env.AI_PROVIDER` inline over the four _dedicated_
singletons:

- `routes/setup.js:7477-7543` — `POST /manual/analyze`, four-way switch (`:7495-7537`) calling
  `analyzeDocument()`.

The second switch, `POST /manual/playground` over `analyzePlayground()`, is gone: upstream removed
the Playground (#359), and the merge took that over, including the local `analyzePlayground()` in
`ollamaService.js`.

Further evidence that `manualService.js` was abandoned rather than maintained:

- `services/manualService.js:270` calls `this._parseResponse(...)`, a method that **does not exist**
  on `ManualService` (it exists only on `OllamaService`). The Ollama path throws `TypeError` on any
  non-object response.
- `existingTagsList` is computed and never used in all four methods
  (`manualService.js:52`, `:110`, `:166`) — would fail `no-unused-vars` under `eslint.config.mjs`.
- `manualService.js:273-276` contains German user-facing strings
  (`'Die Analyse hat zu lange gedauert...'`), violating the English-only rule in `/CLAUDE.md`.
- It is the only service exporting a **class** (`module.exports = ManualService;`) instead of a
  singleton, contrary to the documented service-layer convention.
- Its Ollama path never sends the document content at all — `prompt` is just
  `process.env.SYSTEM_PROMPT` (`manualService.js:218`).

**Decision (carried out in step 7):** delete `services/manualService.js` as part of this work and point
`POST /manual/analyze` at `AIServiceFactory.getService()`. Do not port its behavior — it is worse
than the dedicated services on every axis: no token budgeting, no content truncation, no restriction
placeholders, no structured output, no retry, no metrics.

### 2. Scale and shape of the real duplication

| Service            | Lines | Relationship                                    |
| ------------------ | ----- | ----------------------------------------------- |
| `openaiService.js` | 550   | ~90 % identical to azure/custom                 |
| `azureService.js`  | 568   | ~90 % identical to openai/custom                |
| `customService.js` | 698   | ~90 % identical, plus the strongest JSON parser |
| `ollamaService.js` | 1231  | genuinely different transport and token model   |

The largest duplicated block is **prompt construction**: the
`CUSTOM_FIELDS` → `customFieldsTemplate` → `%CUSTOMFIELDS%` block appears **six times**
(`openaiService.js:125-160`, `azureService.js:143-178`, `customService.js:219-254`,
`ollamaService.js:128-160` in `analyzeDocument()`, `:348-383` in `_buildPrompt()` and `:499-534` in
`_generateCustomFieldsTemplate()`), followed each time by the same
`useExistingData` / `mustHavePrompt` / `RestrictionPromptService` / `USE_PROMPT_TAGS` /
`customPrompt` cascade.

A seam drawn only at the API call would leave that block untouched. Prompt construction therefore
has to be a first-class collaborator of its own, not a side effect of the transport.

### 3. The result contract that must be preserved

Produced by all four services and consumed by three call sites:

```js
{ document: { tags, correspondent, title, document_type, document_date, language, custom_fields },
  metrics: { promptTokens, completionTokens, totalTokens } | null,
  truncated: boolean,
  error?: string,
  errorCode?: string }
```

Consumers: `server.js:854-890` (`processDocument()`), `services/mistralOcrService.js:1027-1052`
(`_runAiAnalysis()`), `routes/setup.js:3135-3165` (`processDocument()`) and `POST /manual/analyze`
(`routes/setup.js:7495-7537`), which returns the result as JSON. The first three hand `document` to
`documentProcessingService.buildUpdateData()`, which since the merge is the single write-back for
scan, queue and OCR. Any narrowing of `document` drops title, document type, date, language or
custom fields silently — `buildUpdateData()` simply stops setting those fields.

### 4. The error contract is load-bearing and phrase-matched — it must be preserved verbatim

`analyzeDocument()` **never throws**; it returns the failure in `error`/`errorCode`.
`server.js:870-890` (and `routes/setup.js:3160`) then routes the document to the OCR queue based on
`shouldQueueForOcrOnAiError()` / `classifyOcrQueueReasonFromAiError()`
(`services/serviceUtils.js:847-900`), which match on **exact phrases**:

- `'insufficient content for ai analysis'`
- `'invalid response structure'`
- `'could not determine assignable metadata'`
- `'invalid json response from api'`
- `'invalid api response structure'`

Rewording any of these silently disables OCR fallback. Guarded by the `ocr-fallback-ai-errors`,
`response-truncation-detection` and `llm-ocr-fallback-phrases` tests. The
`error.code = 'ai_response_truncated'` marker (`serviceUtils.js:834`, `ollamaService.js:791`) has the
same status.

This already happened once: `38a5352` replaced Custom's "Invalid API response structure" with
detailed messages ("API response is missing choices."), and `llm-ocr-fallback-phrases` went red.
`355ac29` keeps the detail behind the phrase ("Invalid API response structure: missing choices.").

Consequence for the design: `analyzeDocument()` keeps its non-throwing contract. A version that
throws on, say, a missing `SYSTEM_PROMPT` would take down the scan loop instead of queueing the
document.

### 5. The Ollama context arithmetic must be preserved exactly

Two separate functions, easily conflated:

```js
// ollamaService.js:568-570 — conservative 2 chars/token, deliberate and documented
_calculatePromptTokenCount(prompt) {
  return Math.ceil(prompt.length / 2);
}

// ollamaService.js:581-588 — tokens, with the answer reserved
_calculateNumCtx(promptTokenCount, expectedResponseTokens) {
  return Math.min(promptTokenCount + expectedResponseTokens, Number(config.tokenLimit));
}
```

The `/2` divisor exists because non-English tokenization (CJK, German) produces roughly two
characters per token instead of ~4; `manualService.js:234` used `/4` and would truncate those
documents. Centralizing the estimators must **preserve `/2` for Ollama**, not unify the divisors.

`_fitContentToContext()` (`ollamaService.js:290-320`) uses the same `/2` estimate by construction, so
the two agree. Whatever holds this arithmetic after the refactor has to keep that property.

### 6. The transport seam needs a wide signature

Ollama's transport needs `(prompt, systemPrompt, numCtx, schema)` (`ollamaService.js:678`), sends
`format: schema` for structured output, computes `num_ctx`/`num_predict`, carries a bounded retry for
transient failures (`:643-735`, `_wrapOllamaRequestError()` at `:664`), and inspects `done_reason`
for truncation (`:739-795`). Its response may arrive as a **JS object** rather than a string
(`_processOllamaResponse()`, `:803`).

A single-string `callAPI(prompt)` cannot carry any of that, which is why `CompletionRequest` below is
a record rather than a string.

`generateText(prompt, options)` widened the seam further with the merge. The Duplicates and
"Simplify tags" features (`entityMatchAiService.js`, `tagSimplifyService.js`) call it with options
that `services/aiGenerateOptions.js` reads the same way for all four providers: `systemPrompt`,
`temperature` (where `0` is a value), a completion cap, a model override, an abort signal,
reasoning on/off and a progress handler that streams partial text (`ai-provider-streaming` test).
Upstream already unified the option parsing; what is still per provider is how each option reaches
the API. The transport contract has to carry all of it, or the generation path regresses for those
features.

### 7. behavioral drift between the four services — each item needs an explicit decision

The refactor collapses four implementations into one, which forces a choice wherever they differ
today. These are the actual bugs the work will surface:

| #   | Drift                                                                                                                            | Location                                                                                                                                                                         | Proposed resolution                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | ~~Azure hardcodes `temperature: 0.3` while openai/custom use `config.aiTemperatureAnalysis`~~ **resolved**                       | was `azureService.js:286`                                                                                                                                                        | Done in step 6: analysis follows `config.aiTemperatureAnalysis`, `generateText()` defaults to `config.aiTemperatureGeneration`; pinned by `llm-azure-temperature-wiring`.                                                         |
| b   | ~~`return;` (undefined!) when a thumbnail is missing — callers then read `.document` of `undefined`~~ **resolved**               | was `openaiService.js:87`, `azureService.js:76`, `customService.js:171`                                                                                                          | Fixed ahead of the refactor together with row j — same statement block, same root cause. See the note below the table.                                                                                                            |
| c   | ~~"Insufficient content" early return exists only in OpenAI~~ **resolved**                                                       | was `openaiService.js:310-332`                                                                                                                                                   | Done in step 6: `isInsufficientContentAnswer()` in `responseParser.js`, applied by the `DocumentAnalyzer` after a failed parse, so all four report `ai_insufficient_content`.                                                     |
| d   | ~~Three different JSON parsers~~ **resolved**                                                                                    | `customService.js:35-126` (brace-matched, strongest) vs. `openaiService.js:299-334` / `azureService.js:286-298` (naive strip) vs. `ollamaService.js:977-1053` (regex + sanitize) | Done in step 3: `services/llm/responseParser.js` — custom's brace matcher, `<think>` stripping, Ollama's repair and object passthrough.                                                                                           |
| e   | Only custom normalizes timeouts                                                                                                  | `customService.js:428-436`                                                                                                                                                       | Apply `isTimeoutError`/`buildTimeoutErrorMessage` for all providers.                                                                                                                                                              |
| f   | `generateText` option handling — **mostly resolved upstream**                                                                    | `services/aiGenerateOptions.js`, used by all four `generateText()` implementations                                                                                               | Upstream unified how options are read (completion cap, temperature, system prompt, model, abort, reasoning, progress). Keep `aiGenerateOptions.js` as the shared reader; the transports only map the result onto their own knobs. |
| g   | `checkStatus` differs by nature                                                                                                  | openai/custom `models.list()`; Azure REST GET; `ollamaService.js:1210` `/api/ps`                                                                                                 | Not business logic. Each composition root hands its probe to the analyzer unchanged (step 6); nothing calls it, so step 8 decides whether it stays.                                                                               |
| h   | Unreachable branches in `openaiService.initialize()` for providers `ollama` and `custom`                                         | `openaiService.js:46-60`                                                                                                                                                         | `aiServiceFactory` never routes those providers here. Since step 7 the factory is the only module that requires `openaiService` outside the tests. Verify, then drop.                                                             |
| i   | Thumbnail caching sits inside `analyzeDocument` although the thumbnail never enters the prompt                                   | all four                                                                                                                                                                         | Still out of scope as a _placement_ question, but the four copies are now one call to `services/thumbnailCache.js`. Moving it out of `analyzeDocument` is a one-line change once a caller wants it.                               |
| j   | ~~`getThumbnailCachePath(id)` runs **outside** the try block, so an invalid id makes `analyzeDocument` throw~~ **resolved**      | was `openaiService.js:63`, `azureService.js:52`, `customService.js:147`                                                                                                          | Fixed ahead of the refactor. See the note below the table.                                                                                                                                                                        |
| k   | ~~An answer with neither tags nor a correspondent is a **failure** on three providers and a **success** on Ollama~~ **resolved** | was `ollamaService.js:223`                                                                                                                                                       | Done in step 6: the analyzer runs `assertAssignableMetadata()` on the parsed answer, before `withDocumentDefaults()`, for all four.                                                                                               |
| l   | An empty provider payload is worded "No response data from Ollama API", which matches **no** OCR marker                          | `ollamaService.js:821` vs. `openaiService.js`, `azureService.js`, `customService.js`                                                                                             | The other three say "Invalid API response structure", which `shouldQueueForOcrOnAiError()` matches. Unify the wording on the shared phrase, or add this one to the marker list.                                                   |
| m   | Custom classifies `socket hang up` as a timeout and replaces the message                                                         | `customService.js:331`                                                                                                                                                           | Consequence of row e: `isTimeoutError()` swallows the original text into "AI response timeout reached…". Decide deliberately whether a dropped connection is a timeout when the handling is unified.                              |

Rows k and l were found by writing the step-1 safety net, not by reading the code — both are
silent: the analysis "succeeds", the log looks plausible, and the document simply never reaches
OCR. Both are pinned as-is in the new tests and marked as known drift, so the case starts failing
the moment the refactor unifies the path. That is deliberate: it forces whoever unifies it to
update the expectation rather than to not notice. Row k was unified in step 6 and its case flipped;
row l is still pinned as drift.

**Rows b and j were fixed before the refactor started.** They shared one root cause — a best-effort
side effect written as a blocking precondition — and sat within three lines of each other, so
fixing one alone would have left the other a line away. Writing the test first showed the drift was
also wider than row j claimed: Ollama's `!id` guard misses truthy-but-unusable ids such as `[]` and
`'///'`, and its `_handleThumbnailCaching` swallowed a failing fetch but still lost the analysis, so
all four providers were affected, not three.

The fix consolidates the four copies into `services/thumbnailCache.js`, whose `cacheThumbnail(id)`
is best-effort by construction: it never throws and never short-circuits its caller, it returns a
boolean, and an unusable id, a missing thumbnail or an unreachable Paperless each produce a warning
and `false`. Ollama's `_handleThumbnailCaching()` is gone. `tests/test-thumbnail-optional-analysis.js`
(32 cases, registered under `processing`) pins the contract for all four providers: whatever the
thumbnail does, `analyzeDocument` returns a full analysis.

### 8. Moving tests into `tests/services/` would break the CI drift guard

`findUnregisteredTests()` (`scripts/run-tests.js:233-249`) reads `tests/` **non-recursively** and
matches `/^test-.*\.js$/`. Any test moved into `tests/services/` silently leaves the guard, which is
exactly the failure mode that guard exists to prevent. Registration itself would still work
(`path.join(__dirname, '..', 'tests', 'services/test-x.js')` is portable), but the discovery walk
must be made recursive in the same change.

Additionally, moving every test that covers production code in `services/` would relocate a large set
of files unrelated to this refactor (`restriction-service`, `updated-service`,
`reconciliation-service`, the `ollama-*` and `ocr-*` families, …). That is churn that hides the
refactor in the diff. **Deferred to a separate PR** (see Out of Scope).

---

## Target Architecture

### Design principle: composition, not inheritance

One **concrete** business-logic class holds injected collaborators. There is no base class and
nothing `extends` anything. A provider is a _composition root_: it wires collaborators together and
exports the singleton facade.

```
services/llm/
  documentAnalyzer.js            the single business-logic implementation (concrete, never subclassed)
  promptBuilder.js               systemPrompt + user content assembly (replaces 6 duplicates)
  customFieldsTemplate.js        the %CUSTOMFIELDS% block
  responseParser.js              raw text|object -> document object
  analysisResult.js              buildSuccess() / buildFailure() — the one place the result shape lives
  tokenBudget/
    tiktokenBudget.js            openai/azure/custom: calculateTotalPromptTokens + truncateToTokenLimit
    charBudget.js                ollama: /2 estimate + _fitContentToContext
  transports/
    chatCompletionsTransport.js  OpenAI SDK, AzureOpenAI SDK, custom base URL — messages[]
    ollamaGenerateTransport.js   axios /api/generate, format schema, num_ctx/num_predict, retry
  providers/
    openaiProvider.js            composition root + singleton facade
    azureProvider.js
    customProvider.js
    ollamaProvider.js
```

The existing module paths stay as one-line re-exports
(`services/openaiService.js` → `module.exports = require('./llm/providers/openaiProvider');`) so that
`aiServiceFactory.js`, `routes/setup.js`, `server.js` and `mistralOcrService.js` need no change and
the diff stays reviewable. The four re-export shims can be collapsed in a later cleanup.

### The delegation contracts

Written as JSDoc typedefs in `services/llm/contracts.js`; enforced by tests, not by a base class.

```js
/**
 * @typedef {Object} CompletionRequest
 * @property {string}  systemPrompt
 * @property {string}  userContent
 * @property {string}  model
 * @property {number}  temperature
 * @property {number}  maxResponseTokens
 * @property {Object|null} schema           structured-output schema; null for chat transports
 * @property {'analysis'|'generation'} purpose
 */

/**
 * @typedef {Object} CompletionResult
 * @property {string|Object} payload        raw assistant text, or the object Ollama may return
 * @property {{promptTokens:number, completionTokens:number, totalTokens:number}|null} metrics
 */

/**
 * A transport owns exactly one thing: how to talk to one API family.
 * It throws on transport failure and on provider-reported truncation
 * (error.code === 'ai_response_truncated'); it never shapes an AnalysisResult.
 *
 * @typedef {Object} LlmTransport
 * @property {string} label                             'OpenAI' | 'AzureOpenAI' | 'Custom OpenAI' | 'Ollama'
 * @property {() => void} initialize                    lazy client construction, idempotent
 * @property {() => boolean} isReady
 * @property {(req: CompletionRequest) => Promise<CompletionResult>} complete
 * @property {() => Promise<{status:string, model?:string, error?:string}>} checkStatus
 */

/**
 * @typedef {Object} TokenBudget
 * @property {(systemPrompt:string, extraPrompts?:string[], model?:string) => Promise<{totalPromptTokens:number, reservedTokens:number, availableTokens:number}>} reserve
 * @property {(content:string, availableTokens:number, model?:string) => Promise<string>} fit
 */
```

`maxResponseTokens` is what each transport maps to its own knob: `max_tokens` for the chat
transports, `num_predict` plus a `num_ctx` sized by `min(promptTokens + maxResponseTokens, tokenLimit)`
for Ollama. That mapping is the only place the Ollama context arithmetic lives, and it keeps
Finding 5's formula intact.

### DocumentAnalyzer — the single business logic

```js
class DocumentAnalyzer {
  /**
   * @param {Object} deps
   * @param {LlmTransport} deps.transport
   * @param {TokenBudget}  deps.tokenBudget
   * @param {Object}       deps.promptBuilder
   * @param {Object}       deps.responseParser
   * @param {() => string} deps.resolveModel      provider-specific model lookup
   * @param {Object}       [deps.thumbnailCache]  injected for testability
   */
  constructor({ transport, tokenBudget, promptBuilder, responseParser, resolveModel, thumbnailCache }) { ... }

  async analyzeDocument(content, existingTags = [], existingCorrespondentList = [],
                        existingDocumentTypesList = [], id, customPrompt = null, options = {}) { ... }

  async generateText(prompt, options = {}) { ... }   // options as read by aiGenerateOptions.js
  checkStatus() { return this.transport.checkStatus(); }
}
```

Every collaborator arrives through the constructor. That is what makes the tests cheap: a fake
transport is an object literal with a `complete()`, so no `require.cache` surgery and no network.

### Provider composition root (example)

```js
// services/llm/providers/azureProvider.js
const DocumentAnalyzer = require('../documentAnalyzer');
const ChatCompletionsTransport = require('../transports/chatCompletionsTransport');
const tiktokenBudget = require('../tokenBudget/tiktokenBudget');
const promptBuilder = require('../promptBuilder');
const responseParser = require('../responseParser');
const config = require('../../../config/config');

module.exports = new DocumentAnalyzer({
  transport: new ChatCompletionsTransport({
    label: 'AzureOpenAI',
    createClient: () =>
      new (require('openai').AzureOpenAI)({
        apiKey: config.azure.apiKey,
        endpoint: config.azure.endpoint,
        deploymentName: config.azure.deploymentName,
        apiVersion: config.azure.apiVersion,
      }),
    checkStatus: azureDeploymentProbe, // the REST GET from azureService.js:574
  }),
  tokenBudget: tiktokenBudget,
  promptBuilder,
  responseParser,
  resolveModel: () => process.env.AZURE_DEPLOYMENT_NAME,
});
```

Adding a fifth provider is: one `createClient`, one `resolveModel`, one `checkStatus` probe. No new
business logic, no subclass.

### Why not the base-class variant

An abstract base class with a `callAPI()` override per provider forces Ollama's four extra
parameters, its object-shaped response, its retry loop and its char-based token model either into the
base class (where they are dead weight for three providers) or into an override that reimplements the
template method (which is the duplication we started with). Injecting a transport keeps Ollama's
peculiarities inside `ollamaGenerateTransport.js` and out of everyone else's way.

---

## Test Strategy

House style: plain node scripts under `tests/`, `require('assert')`, one `main()`, `[PASS]`/`[FAIL]`
and `process.exitCode = 1`. No test framework is introduced — the runner executes each file with
`spawnSync(process.execPath, [filePath])` (`scripts/run-tests.js:471`), so framework globals are not
available. Model for service tests: `tests/test-ollama-temperature-wiring.js`, including its
`require.cache` injection helper (`:26-39`).

The seam under test is the real one:
`analyzeDocument(content, existingTags, existingCorrespondentList, existingDocumentTypesList, id, customPrompt, options)`.

Because collaborators are injected, most tests need no module mocking at all — construct a
`DocumentAnalyzer` with a fake transport:

```js
const fakeTransport = {
  label: 'Fake',
  initialize() {},
  isReady: () => true,
  calls: [],
  async complete(request) {
    this.calls.push(request);
    return {
      payload: JSON.stringify({
        tags: ['tag1'],
        correspondent: 'John Doe',
        title: 't',
        document_type: 'Invoice',
        document_date: '2026-01-01',
        language: 'en',
      }),
      metrics: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  },
  async checkStatus() {
    return { status: 'ok' };
  },
};
```

Planned tests (each registered in `TESTS` in `scripts/run-tests.js` and in an `AREAS` entry):

| Test name                             | Asserts                                                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm-response-parser`                 | code fences stripped; `<think>…</think>` stripped; brace-matched extraction from surrounding prose; trailing-comma/unquoted-key sanitize fallback; unparseable input throws with the exact phrase `Invalid JSON response from API`                                  |
| `llm-analysis-result-contract`        | success returns `{document, metrics, truncated}`; failure returns `{document:{tags:[],correspondent:null}, metrics:null, error, errorCode}` and **never throws**                                                                                                    |
| `llm-ocr-fallback-phrases`            | every phrase in `shouldQueueForOcrOnAiError` is still produced by the refactored paths — the regression guard for Finding 4                                                                                                                                         |
| `llm-prompt-builder`                  | `%CUSTOMFIELDS%` rendering for date/boolean/other; `useExistingData` branch; `USE_PROMPT_TAGS` override; `customPrompt` override; restriction placeholders delegated to `RestrictionPromptService`; external API data appended                                      |
| `llm-token-budget`                    | `tiktokenBudget.reserve` throws `Token limit exceeded: …` when `availableTokens <= 0`; `charBudget` uses the `/2` divisor and `min(promptTokens + responseTokens, tokenLimit)` for `num_ctx` — Finding 5                                                            |
| `llm-transport-request-mapping`       | chat transports send `messages[]` with system+user and omit `temperature` for `o3-mini`; Ollama transport sends `format`, `num_ctx`, `num_predict`, `think:false` unless `OLLAMA_THINK=true`                                                                        |
| `llm-azure-temperature-wiring`        | Azure analysis requests carry `config.aiTemperatureAnalysis`, not a hardcoded `0.3` — Finding 7a                                                                                                                                                                    |
| ~~`llm-missing-thumbnail-continues`~~ | **already delivered** as `tests/test-thumbnail-optional-analysis.js` (Findings 7b/7j). Keep it green through the refactor instead of writing a new one; it exercises `analyzeDocument` end to end, so the composition roots must keep calling `cacheThumbnail(id)`. |
| `llm-provider-parity`                 | all four composition roots expose `analyzeDocument`/`generateText`/`checkStatus` and, given the same fake transport payload, produce byte-identical `document` objects                                                                                              |

Existing tests that must stay green without modification (they are the real acceptance criteria):
`ocr-fallback-ai-errors`, `response-truncation-detection`, `ollama-response-limit`,
`ollama-upstream-error`, `ollama-temperature-wiring`, `ollama-token-metrics`,
`prompt-existing-data-serialization`, `restriction-service`, `restricted-document-types-placeholder`,
`document-type-restriction`, `ai-temperature-config`, `ai-provider-streaming`.
(`playground-deprecation` was retired upstream together with the Playground, #359.)

Repo hygiene for every step:

- Register each new test in `TESTS`; run `node scripts/run-tests.js --all` — the registry drift check
  only runs on `--all`.
- `npx eslint <changed>`, `npx prettier --check <changed>` — CI lints the files touched by the PR.

---

## Implementation Steps

Each step ends with a green `node scripts/run-tests.js --all`. Steps 1-2 are pure preparation and
carry no behavioral risk; the risk starts at step 4.

1. ~~**Freeze the contract in tests first (TDD).**~~ **Done.** `llm-analysis-result-contract`
   (32 cases) and `llm-ocr-fallback-phrases` (15 cases) cover all four providers and are green
   against the **current** services — which is what makes them a regression net rather than a
   description of the new code. Both are mutation-verified: rewording an OCR marker in
   `serviceUtils.js` fails five cases, dropping `errorCode: error.code` from `openaiService.js`
   fails one. They stub only the provider client and pre-seed the thumbnail cache, so no network
   and no `require.cache` tricks. They also produced Findings 7k, 7l and 7m.

   Two things they deliberately do **not** pin: the wording of a failure message (Custom and Ollama
   both rewrite it — rows e/m and the retry wrapper), and the phrases the OCR matcher owns, which
   are copied into the test rather than imported. Importing that list would make the test agree
   with whatever the source says, which is the opposite of pinning it.

2. ~~**Extract `customFieldsTemplate.js` and `promptBuilder.js`**~~ **Done.**
   `services/llm/customFieldsTemplate.js` (`buildCustomFieldsBlock()`) and
   `services/llm/promptBuilder.js` (`buildAnalysisPrompt()` → `{ systemPrompt, promptTags }`) replace
   the six copies. `llm-prompt-builder` (27 cases) pins the cascade and checks that every provider
   sends what the builder built. `ollamaService._buildPrompt()` stays as a thin wrapper, because
   `prompt-existing-data-serialization` and `restricted-document-types-placeholder` call it.

   Verified by recording the requests of all four providers for eight prompt scenarios before and
   after: the 24 requests of openai/azure/custom are byte-identical. Ollama differs in two
   deliberate ways. Its two fixed text blocks are now indented with 8 spaces instead of 12, like
   the other three; the wording is unchanged. And it sends the external API data instead of
   `[object Promise]`: its `_validateAndTruncateExternalApiData()` was `async` but never awaited
   by either caller. It awaited nothing itself, so it is synchronous now.

   Not changed on purpose: a `CUSTOM_FIELDS` that parses but has no `custom_fields` array still
   throws inside `buildCustomFieldsBlock()` (and so fails the analysis), as all six copies did.
   Ollama still ignores `PROMPT_TAGS` as user content; the chat providers only use it for the
   token count.

3. ~~**Extract `responseParser.js`**~~ **Done.** `services/llm/responseParser.js`
   (`parseAnalysisResponse()` → `{ parsed, normalized }`, plus `stripResponseWrapping()`) replaces
   custom's `_extractFirstJsonValue`/`_parseJsonResponse`, the inline strip-and-parse of openai and
   azure, and Ollama's `_parseResponse`/`_sanitizeJsonString`. Order: an object passes through,
   `<think>` blocks and fences (any case) are stripped, the text is parsed as it stands, then each
   **top-level** `{...}` is tried as written and repaired. An unreadable object is skipped whole, so
   a nested `custom_fields` entry is never mistaken for the answer — on Ollama that would have been
   a silent success (row k). Every failure starts with "Invalid JSON response from API".
   `llm-response-parser` (57 cases) sends seven readable and three unreadable answers through the
   parser and through all four providers.

   Against the services before this step 12 provider cases failed, which is Finding 7d measured:
   OpenAI and Azure could not read an upper-case fence, prose around the object, a trailing comma
   or prose plus braces in a string; Custom could not read a trailing comma; Ollama could not read
   a `<think>` block or prose after the object, and its repair branch **dropped `document_type`
   and `custom_fields`** from an answer it did repair. All of those now read the same everywhere.

   Deliberately not moved: the field defaults Ollama applies (`tags` → `[]`, the rest → `null`)
   stay in `_processOllamaResponse()`, now for both the object and the text path. They are result
   shaping and belong to `analysisResult.js` in step 4, so the parser returns the object as read
   rather than the "document object" the target architecture lists. OpenAI's "insufficient
   content" early return still runs only on a failed parse, on the stripped text. Row l ("No
   response data from Ollama API") is untouched and still pinned as drift.

4. ~~**Extract `analysisResult.js`** and the two `tokenBudget` strategies~~ **Done.**
   `services/llm/tokenBudget/tiktokenBudget.js` replaces the reserve-then-truncate block that was
   byte-identical in openai, azure and custom. `services/llm/tokenBudget/charBudget.js` holds
   Ollama's arithmetic (Finding 5): `estimateTokens()` with the `/2` divisor, `numCtx()` as
   `min(prompt + answer, TOKEN_LIMIT)`, and `reserve()`/`fit()` in place of
   `_fitContentToContext()`, which is gone. Both budgets expose `reserve()` → `{ totalPromptTokens,
reservedTokens, availableTokens }` and `fit(content, availableTokens)`; the char budget's
   `reserve()` takes the prompt prefix alone, since it has no model and no extra messages to count.
   `_calculatePromptTokenCount()`/`_calculateNumCtx()` stay as one-line wrappers because
   `ollama-temperature-wiring` stubs them; `generateText()` reaches the char budget through them.

   `services/llm/analysisResult.js` is the one place the result shape lives: `buildSuccess()`,
   `buildFailure(error, message?)` (Custom passes its normalized timeout text),
   `buildInsufficientContent()` (OpenAI only, row c), `assertAssignableMetadata()` (the three chat
   providers; Ollama's row k is untouched and still pinned) and `withDocumentDefaults()` (Ollama's
   field defaults; whether the chat providers adopt them is the parity decision of step 6).

   `llm-token-budget` (23 cases) pins both budgets and that every provider spends the one it was
   given. Its provider half was green against the services before this step, which is the
   point of a pure extraction. `llm-analysis-result-contract` gained a case for OpenAI's
   insufficient-content placeholder, which was pinned nowhere before. Mutation-checked:
   divisor `/4`, a dropped answer reservation, a provider that fits to a larger budget, a dropped
   `errorCode`, a dropped placeholder field and a dropped `custom_fields` default each fail a case.

   One log fixed on the way: Ollama's "exceeds the context budget" debug line was written in single
   quotes and printed `${text.length}` literally.

5. **Introduce the transports.** `chatCompletionsTransport.js` covering openai/azure/custom, and
   `ollamaGenerateTransport.js` carrying the retry, `format`, `num_ctx`/`num_predict` and
   `done_reason` truncation check moved verbatim from `ollamaService.js`. Cover with
   `llm-transport-request-mapping`. Landed in two commits, because `generateText()` brings
   streaming, abort, three reasoning dialects and per-provider defaults the analysis call has
   none of:
   - ~~**5a — the analysis request.**~~ **Done.** Each service owns a `transport`; `client`
     (and Ollama's `apiUrl`/`model`) are accessors onto it, so the many tests that replace
     `service.client` keep working unchanged. The chat transport takes a `createClient()`
     factory — OpenAI's still carries the unreachable branches of row h, removed in step 8 — and
     an optional `describeMissingContent()`, which is how Custom keeps its detailed
     "Invalid API response structure: missing choices[0]." (355ac29). Per-provider temperature
     stays with the provider: OpenAI passes `undefined` for o3-mini, which the transport omits;
     Azure still passes 0.3 and is pinned as such until step 6 (row a). The Ollama transport gets
     the axios client handed in, because `ollama-temperature-wiring` mocks axios for the service
     module; `_callOllamaAPI()`, `_assertNotTruncated()`, `_extractOllamaMetrics()` and
     `_buildRequestHeaders()` are one-line delegations, the first and third because tests call
     them. `num_ctx` is still computed by the service and handed in; moving it behind the
     transport is step 6. `llm-transport-request-mapping` (31 cases) pins both transports with
     fake clients and every provider's analysis request; six mutations each fail a case.
   - ~~**5b — `generateText()`**~~ **Done.** The chat transport's `generate()` holds what the
     three `generateText()` copies shared: abort and progress handling, the streamed and the plain
     call, `lastGenerateTextUsage`, reasoning stripping, the cut-off check with `partialText`, and
     the abort normalization. What differs stays with the provider, as one
     `_buildGenerationRequest()` each — moved verbatim: OpenAI caps `max_tokens` only on request;
     Azure always caps at RESPONSE_TOKENS and defaults to temperature 0.7; Custom clamps to the
     context window and speaks three reasoning dialects (Qwen's `/no_think`,
     `chat_template_kwargs`, `reasoning_effort`). Hooks: `streamUsage()` (Azure's API-version
     gate for `stream_options`) and `describeEmptyText()` (Custom's "the answer carried no
     text …"). Ollama's `generate()` and its NDJSON stream reader moved into
     `ollamaGenerateTransport.js` verbatim; the service still sizes `num_predict`/`num_ctx`
     through `_calculatePromptTokenCount()`/`_calculateNumCtx()` and hands them in.
     `lastGenerateTextUsage` is an accessor onto the transport on all four services.
     `llm-transport-request-mapping` grew to 48 cases. Of eight mutations on the generation path,
     three survived the existing suite — Custom's empty-answer message, Ollama's `reasoning`
     override of OLLAMA_THINK, and Ollama's abort signal — and are pinned now.

     **Not moved: `checkStatus()`** (row g). Nothing in the repository calls it — no route, no
     view, no service, no test. It stays in the four services untouched; step 6 decides whether the
     composition roots expose it at all or whether it is dropped with the dead branches of step 8.

6. ~~**Introduce `documentAnalyzer.js`** and the four composition roots~~ **Done.** Built on upstream
   v2026.10.01 (merged first, `8dd6121`), in this order, every commit green and tagged
   `refactor-step-6-checkpoint-<n>-…`:
   - **The decisions first, on the four separate services**, each with a test that failed before
     and passes after (decided by the maintainer on 2026-10-11):
     - **7a** — Azure analysis sends `config.aiTemperatureAnalysis` (was 0.3), `generateText()`
       defaults to `config.aiTemperatureGeneration` (was 0.7); `llm-azure-temperature-wiring`.
     - **7k** — an answer without assignable metadata is a failure on all four, checked on the
       parsed answer before `withDocumentDefaults()`; `{ tags: [], correspondent: null }` still
       passes. Ollama now reaches the OCR queue for it.
     - **Field defaults** — every success is shaped by `withDocumentDefaults()`: the seven fields,
       unknown ones dropped. Safe for the write-back (`buildUpdateData()` falls back to the
       document's own title/date and skips nulls).
     - **7c** — `isInsufficientContentAnswer()` (`responseParser.js`): a refusal that does not parse
       returns `buildInsufficientContent()` on all four (OCR reason `ai_insufficient_content`).
       `llm-response-parser` checks that its unreadable answers contain none of the phrases.
   - **Then the parity pinned**: `llm-provider-parity` sends twelve answers to all four providers
     and compares the JSON of the results byte for byte. It passed before the structural commits
     and had to stay green through them; it also checks that each service is a `DocumentAnalyzer`
     behind a one-line re-export.
   - **Then the structure, in three commits** (OpenAI + Azure, Custom, Ollama).
     `services/llm/documentAnalyzer.js` holds `analyzeDocument()`; `generateText()` and
     `checkStatus()` delegate. The constructor differs from the sketch under Target Architecture
     where the code demanded it: a `promptLayout` (`services/llm/promptLayout.js`) says how
     instructions and document become one request — the chat providers send the instructions as
     the system message, Ollama puts them in the prompt and sends a system prompt of its own; the
     token budgets gained `count()`/`cut()` for the external API data; the optional
     `analysisTemperature` (OpenAI leaves it out for o3-mini), `responseSchema`, `contextWindow`
     (Ollama's `num_ctx`, sized through the singleton's `_calculate*()` seams on both paths),
     `prepareContent` (Ollama's `CONTENT_MAX_LENGTH`) and `describeFailure` (Custom's timeout
     wording, rows e/m) carry what is a provider's own. `checkStatus` is the provider's old probe,
     moved unchanged (row g). The four `services/*Service.js` are one-line re-exports.
     A request probe compared the outgoing request bodies and results of all four providers with
     the state before the structural commits in eight scenarios (plain, custom prompt, external
     API data, `USE_PROMPT_TAGS`, `USE_EXISTING_DATA`, `CONTENT_MAX_LENGTH`, cut to `TOKEN_LIMIT`,
     refusal): byte-identical. What changed is logging only: Custom writes `prompt.txt` like the
     other chat providers, Ollama writes `prompt.txt` before the request and `response.txt` after
     it, and a failed analysis names its provider.
   - **Kept as is, as decided:** row e/m (timeout normalization only on Custom), row l ("No
     response data from Ollama API", now raised by the Ollama transport, still matches no OCR
     marker), Ollama's `CONTENT_MAX_LENGTH` cut.
   - `tests/test-llm-document-analyzer.js` pins the analyzer with fake collaborators. The
     `refactor-step-6` branch (PR #1) was used where it held up: its 7a/7k/defaults/7c test changes
     and the refusal helper. Its analyzer covered OpenAI only and its parity test compared method
     signatures, so neither was taken over.

7. ~~**Delete `services/manualService.js`** and repoint `POST /manual/analyze` at
   `AIServiceFactory.getService()`~~ **Done**, in two commits:
   - **The route.** The five-branch switch on `process.env.AI_PROVIDER` is one call to
     `AIServiceFactory.getService().analyzeDocument()` with the `id` as sent (no `|| []`). As decided
     by the maintainer on 2026-10-15, `documentModel.addOpenAIMetrics()` runs for every provider
     whenever the analysis returned `metrics` and the request carried an `id` — the Anthropic
     branch's rule — and the API is unchanged: `id` stays optional, no new field, no new status.
     That guard also removes the OpenAI branch's unguarded `metrics.promptTokens`, so a failed
     analysis answers 200 with its failure record instead of a 500 TypeError. The four provider
     imports of `routes/setup.js` were unused afterwards and are gone.

     One consequence that was not a decision of its own: the provider is now picked as the scan
     loop picks it (`config.aiProvider`, OpenAI when unset or unknown), so the old 500 "AI provider
     not configured" no longer exists. The swagger block was corrected to what the route returns:
     the 200 references `AnalysisResult` (`schemas.js`, previously unreferenced; it gained
     `truncated` and `errorCode`, and `metrics`/`correspondent` are nullable), `existingTags` is
     documented as accepted but not read — the route takes all three lists from Paperless-ngx —
     and the 500 text no longer names the removed branch. `OPENAPI/openapi.json` regenerated.

     `manual-analyze-route` (9 cases) mounts the real router (`tests/helpers/mount-router`) and
     replaces only each provider's `analyzeDocument()` and the metrics store. Four cases failed
     before the change; restoring `id || []`, dropping the metrics guard or the id guard each
     fails one. On Windows the test ends red after its cases pass, because the harness cannot
     remove its temp directory (EPERM), like `duplicates-endpoints`.

   - **The dead file.** `services/manualService.js` (284 lines) is deleted; `git grep manualService`
     finds only this plan.

8. ~~**Verify Finding 7h**~~ **Done.** Verified unreachable: since step 7 the only non-test module
   that requires `openaiService` is `aiServiceFactory.js`, which hands it out for `openai` and as
   the default for an unknown provider only, and no production code changes `config.aiProvider` at
   runtime. `createClient()` in `services/llm/providers/openaiProvider.js` no longer builds an
   Ollama (`<OLLAMA_API_URL>/v1`) or a Custom client; it builds one for `openai` with an API key and
   returns `null` otherwise. One case in `llm-transport-request-mapping` pins that — it failed
   before the change (an Ollama client for `ollama`).
9. ~~**Full verification.**~~ **Done, except the live smoke run.** See "Final verification" below.

---

## Final verification

On 2026-10-15, at the commit that moved this document to `docs/`:

- `node scripts/run-tests.js --all`: 112 passed, 7 skipped, 23 failed. The failed tests are the same list as on the
  commit before step 7 (`0a7a2f8`) plus `manual-analyze-route`, whose nine cases pass and which
  fails only because `tests/helpers/mount-router.js` cannot remove its temp directory on Windows
  (EPERM) — the reason `duplicates-endpoints` fails there too. The rest of that list is
  environmental on the Windows development machine (temp-dir EPERM/EBUSY, native crashes, CRLF
  in the working copy, the shell's `ANTHROPIC_BASE_URL`).
- ESLint, Prettier and stylelint on every file the branch changes against upstream `main`, the
  way CI selects them: clean.
- `node scripts/regen-openapi.js` + `git diff --exit-code OPENAPI/openapi.json`: no drift.
- **Not done: a manual smoke run** of `/manual/analyze` and a scan cycle against a real
  Paperless-ngx and a real provider. No test exercises a live API, and none was available here.
  Do this before the release that carries the refactoring: one document per configured provider
  through the scan, one through the manual page, and check the token metrics appear for it.

## Notes for whoever works on this code next

- **Read first:** `/CLAUDE.md`, the Findings and done notes above, `services/llm/documentAnalyzer.js`,
  `services/llm/promptLayout.js` and one composition root, e.g.
  `services/llm/providers/azureProvider.js`. A new chat-completions provider is one composition
  root plus a factory case.
- **Seams the tests rely on — keep them on the four exported singletons:** `service.client` is
  replaced directly by many tests; `lastGenerateTextUsage` is read and set; `service.transport` is
  inspected and its `generate` stubbed. Ollama's `apiUrl`, `model`, `documentAnalysisSchema`,
  `_buildPrompt()`, `_callOllamaAPI(prompt, system, numCtx, schema)`, `_extractOllamaMetrics()`,
  `_calculatePromptTokenCount()` and `_calculateNumCtx()` are called or stubbed; they live on the
  singleton in `ollamaProvider.js`. `ollama-temperature-wiring` mocks axios through
  `require.cache` and loads `services/ollamaService.js` first in a fresh process, so the client is
  created with the mock. `ollama-upstream-error` patches the global `setTimeout`.
- **The factory is the only door.** No route or service requires a provider singleton directly;
  `POST /manual/analyze` and the scan loop both call `AIServiceFactory.getService()`.
- **Router tests:** `tests/helpers/mount-router.js` mounts the real `routes/setup.js` on a throwaway
  database; `tests/test-manual-analyze-route.js` is the smallest example. On Windows its `close()`
  fails with EPERM on the temp directory — expected there; the cases themselves pass.
- **Verify like this:** `node scripts/run-tests.js --all` takes about ten minutes. Some tests
  fail for reasons unrelated to the code, depending on the machine (native crashes, temp-dir
  permissions, line endings, environment variables of the shell). Never judge a run by its count:
  run the suite on the parent commit as well and compare the lists of failed tests. Back every new
  test with a mutation check: break the code it guards, see it fail, restore.

## Out of Scope / Follow-ups

- **Relocating tests into `tests/services/`.** Needs `findUnregisteredTests()` made recursive first
  (Finding 8) and would bury this refactor in rename noise. Separate PR.
- **Thumbnail caching inside `analyzeDocument`** (Finding 7i): the thumbnail is fetched, written to
  disk and never used in the prompt. Behavior preserved here; worth its own issue. It is now a
  single `cacheThumbnail(id)` call per provider rather than four inline copies, so hoisting it to
  the caller is a small change whenever someone wants to make it.
- **Vision/multimodal analysis**, which is presumably why the thumbnail is cached at all.
- **`CachedNameIdEnum`'s semantic match calls a method no provider has.** `_findSemanticMatch()`
  (`services/CachedNameIdEnum.js`) calls `ai_service.generateAnswer()`, which exists only in
  test stubs. The call throws, is caught and returns "no match", so tag/correspondent/document type
  lookup silently falls back to its text matchers. Step 6 settled the contract — `generateText(prompt,
options)` is the same on all four, the Anthropic provider included — so either point it there
  (it would then cost an AI call per unmatched name), or drop the AI tier.
- **A structured-output (`response_format`/`format`) path for the chat transports** to match what
  Ollama already does. Would likely remove most of `responseParser`, but it is a behavior change
  needing its own validation against real providers.
- **The Anthropic provider** (`services/anthropicService.js`, upstream v2026.10.01) arrived after
  the plan and is not one of the four. It keeps its own `analyzeDocument()` over the Messages API,
  with its own prompt and parser (`services/analysisPrompt.js`), structured output and prompt
  caching. It already fails an answer without metadata with the same message (7k), but passes the
  parsed answer on without the field defaults and has no refusal detection (7c). Making it a fifth
  composition root needs a Messages transport and a decision on those two differences.
- **`services/llm/contracts.js`** with the typedefs of "The delegation contracts" was not written;
  the constructor JSDoc of `DocumentAnalyzer` and the transports document the shapes instead.
- ~~**This plan document's location.**~~ Moved from `services/ManualServiceRefactoring.md` to
  `docs/llm-service-refactoring.md` at the end of the refactoring; `services/` holds services.

## Risks

| Risk                                                                         | Mitigation                                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| OCR fallback silently stops working because an error phrase changed          | `llm-ocr-fallback-phrases` written in step 1, before any code moves                                                                   |
| A caller reads a field that the unified `document` object no longer carries  | `llm-provider-parity` compares full objects; `server.js:854`, `mistralOcrService.js:1027`, `routes/setup.js:3135` reviewed explicitly |
| Ollama's token arithmetic subtly changes and long documents start truncating | `charBudget` keeps the `/2` divisor and the real `num_ctx` formula; `ollama-response-limit` and `ollama-token-metrics` guard it       |
| No test exercises a real provider API                                        | Step 9 keeps a manual smoke run against at least one live provider in the acceptance criteria                                         |
| The refactor lands as one unreviewable diff                                  | Steps 2-6 are individually green and individually landable                                                                            |
