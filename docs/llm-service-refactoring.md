# LLM Service Refactoring

**Status: superseded** (2026-11-11). This fork collapsed the four provider services (OpenAI,
Azure, Custom, Ollama) onto one `DocumentAnalyzer` under `services/llm/` (refactoring steps 1-8,
finished 2026-10-15). Upstream consolidated the same services on its own in v2026.11.02
(`b8fa4de`, `ef2e27d`), and the merge `8ae5718` kept upstream's design so the fork stays
mergeable; `services/llm/` and its tests are gone. The full plan and its step-by-step record are in
the history of this file (`git show d511101:docs/llm-service-refactoring.md`) and in the commit
bodies of the steps.

This document keeps what is still true: the contracts every provider has to honour, where each
provider stands against them, and what is left to do.

## What the code looks like now

| Provider              | Implementation                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openai, azure, custom | `services/openaiCompatibleService.js` — one class, one profile per provider (`forProvider(id)`); `openaiService.js` etc. are one-line re-exports                                                                                                   |
| anthropic             | `services/anthropicService.js` over the Messages API, rules in `anthropicSupport.js`                                                                                                                                                               |
| ollama                | `services/ollamaService.js` — its own analysis path over `/api/generate`                                                                                                                                                                           |
| shared                | `analysisPrompt.js` (prompt and parser; OpenAI family and Anthropic), `aiProviderRules.js` (per-model request rules), `modelFailure.js` (failure kinds), `aiGenerateOptions.js` (`generateText()` options), `thumbnailCache.js`, `serviceUtils.js` |

`AIServiceFactory.getService()` is the only door: the scan loop (`server.js:869`), the OCR queue
(`services/mistralOcrService.js:1499`), the history re-run (`routes/setup.js:3273`, `:3283`) and
`POST /manual/analyze` (`routes/setup.js:8308`) all go through it. `services/manualService.js` is
gone on both sides.

### Against the goals of the refactoring

| Goal                                          | Now                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Business logic once                           | Partly. Once for the OpenAI family; prompt and parser shared with Anthropic. Ollama builds its prompt (`CUSTOM_FIELDS` block three times), parses and shapes on its own. |
| A new provider is one adapter                 | For an OpenAI-compatible API: one profile plus an `aiProviderRules` entry. Any other API: a whole service.                                                               |
| Seams testable without `require.cache` tricks | No. Tests assign `service.client` or talk to fake servers (`tests/helpers/fake-openai.js`, `fake-ollama.js`, `fake-anthropic.js`).                                       |
| Consistent errors and result shape            | For the OpenAI family and Anthropic. Ollama since `2ac678f` for refusals, broken answers and empty payloads; see the table below for the rest.                           |
| Delegation over inheritance                   | Yes, no `extends`.                                                                                                                                                       |

## The contracts every provider has to honour

### 1. The result

```js
{ document: { tags, correspondent, title, document_type, document_date, language, custom_fields },
  metrics: { promptTokens, completionTokens, totalTokens } | null,
  truncated: boolean,
  error?: string,
  errorCode?: string }
```

The consumers listed above hand `document` to `documentProcessingService.buildUpdateData()`, the
single write-back. Narrowing `document` drops title, type, date, language or custom fields
silently — `buildUpdateData()` simply stops setting them. (Ollama's sanitize path did exactly
that until `2ac678f`.)

### 2. `analyzeDocument()` never throws, and its error phrases are load-bearing

Failures come back in `error`/`errorCode`. The scan loop routes them to the OCR queue through
`shouldQueueForOcrOnAiError()` / `classifyOcrQueueReasonFromAiError()`
(`services/serviceUtils.js:991`, `:1016`), which match on **exact phrases**:

- `'insufficient content for ai analysis'` → `ai_insufficient_content`
- `'invalid json response from api'` → `ai_invalid_json`
- `'invalid response structure'` and `'could not determine assignable metadata'` →
  `ai_invalid_response_structure`
- `'invalid api response structure'` → `ai_invalid_api_response_structure`

Rewording a thrown message silently disables the OCR fallback for it. `error.code =
'ai_response_truncated'` (`serviceUtils.js:936`, `ollamaService.js:887`) has the same status.
A `return;` (an `undefined` analysis) breaks every consumer; upstream's
`openaiCompatibleService` had one on a missing thumbnail until the merge.

Guards: `ocr-fallback-ai-errors` (the classifier), `response-truncation-detection` (all four
providers, driven through `analyzeDocument()`), `ollama-analysis-contract`,
`openai-compatible-service`, `thumbnail-optional-analysis`. The fork's `llm-ocr-fallback-phrases`,
which checked every provider's messages against the markers, went with `services/llm/`; nothing
replaces it for the OpenAI family yet (see Follow-ups).

### 3. Ollama's context arithmetic

```js
_calculatePromptTokenCount(prompt); // ollamaService.js:632 — Math.ceil(prompt.length / 2)
_calculateNumCtx(promptTokens, resp); // ollamaService.js:645 — min(prompt + answer, TOKEN_LIMIT)
_fitContentToContext(content, n); // ollamaService.js:360 — the same /2 estimate
```

The `/2` divisor is deliberate: German and CJK text tokenises at about two characters per token,
not four. `_fitContentToContext()` shortens the document to what TOKEN_LIMIT leaves after the
prompt and the reserved answer, because Ollama silently clamps `num_ctx` to the model's real window
and the answer is then cut off mid-JSON on exactly the long documents. The three have to agree.
Guards: `ollama-response-limit`, `ollama-token-metrics`.

`_callOllamaAPI()` (`ollamaService.js:702`) retries a 5xx or a dropped connection once and
reports the backend's own error body (`_wrapOllamaRequestError()`, `:817`); guard:
`ollama-upstream-error`.

## Where the providers still differ

Rows from the plan's Finding 7, against the code after `2ac678f`.

| #   | Topic                                                  | OpenAI family                               | Anthropic                               | Ollama                                                                          |
| --- | ------------------------------------------------------ | ------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| a   | Temperature follows the configuration                  | yes, where `aiProviderRules` allows it      | never sent                              | yes, where `aiProviderRules` allows it                                          |
| b/j | Thumbnail caching is best effort                       | yes (`thumbnailCache.js`)                   | own copy, best effort                   | yes (`thumbnailCache.js`)                                                       |
| c   | A refusal is insufficient content                      | yes (`isRefusalAnswer()`)                   | `stop_reason: "refusal"` → `ai_refused` | yes, since `2ac678f`                                                            |
| d   | JSON parser                                            | `parseAnalysisAnswer()` (brace matcher)     | `parseAnalysisAnswer()`                 | **own**: greedy `\{[\s\S]*\}` plus a sanitizer                                  |
| e   | Timeouts normalised (`isTimeoutError()`)               | yes                                         | yes                                     | **no** — the axios message passes through                                       |
| i   | Thumbnail cached inside `analyzeDocument()`            | yes                                         | yes                                     | yes                                                                             |
| k   | A broken answer (no tag list, odd correspondent) fails | yes                                         | yes                                     | yes, since `2ac678f`                                                            |
| l   | An empty payload carries an OCR marker                 | yes                                         | yes                                     | yes, since `2ac678f`; `generateText()` keeps "Invalid response from Ollama API" |
| m   | "socket hang up" counts as a timeout                   | **yes** — via `isTimeoutError()`, undecided | **yes**, undecided                      | no (row e)                                                                      |

An answer that found nothing — no tags and no correspondent — is a success on every provider; row
k is about the answer's structure, not its content.

## Follow-ups

- **Ollama onto `analysisPrompt.js`** (rows d, and the triple `CUSTOM_FIELDS` block): the last
  provider with its own prompt and parser. Check first that the prompt stays byte-identical where
  it should, or record the difference; `ollama-response-limit` and `ollama-token-metrics` pin the
  arithmetic around it.
- **Ollama timeouts** (row e) and **"socket hang up"** (row m): decide whether a dropped
  connection is a timeout, then apply the same rule to all providers. Ollama already retries it
  once (`ollama-upstream-error`).
- **A phrase guard for every provider**: what `llm-ocr-fallback-phrases` did — every message an
  `analyzeDocument()` can return checked against the OCR markers — now exists only for Ollama
  (`ollama-analysis-contract`).
- **Thumbnail caching inside `analyzeDocument()`** (row i): the thumbnail never enters the prompt.
  One `cacheThumbnail(id)` call per provider now, so hoisting it to the caller is small.
- **`CachedNameIdEnum` calls a method no provider has**: `_findSemanticMatch()`
  (`services/CachedNameIdEnum.js:176`) calls `ai_service.generateAnswer()`, which exists only in
  test stubs. The call throws, is caught and returns "no match", so tag, correspondent and document
  type lookup falls back to its text matchers. Point it at `generateText(prompt, options)` (one AI
  call per unmatched name) or drop the AI tier.
- **Relocating tests into `tests/services/`** needs `findUnregisteredTests()` in
  `scripts/run-tests.js` to read `tests/` recursively first, or moved tests silently leave the CI
  guard.
- **Upstream PR**: the Ollama fixes (`2ac678f`, and the ports of `a8d12f9`, `11381fe`, `4580e4f`
  in the merge) are fork-only and would apply to upstream unchanged.

## Notes for whoever works on this code next

- **Seams the tests rely on**: `service.client` is assigned directly (OpenAI family, Anthropic,
  Ollama); `lastGenerateTextUsage` is read and set; Ollama's `apiUrl`, `model`, `_buildPrompt()`,
  `_callOllamaAPI()`, `_extractOllamaMetrics()`, `_calculatePromptTokenCount()` and
  `_calculateNumCtx()` are called or stubbed. `ollama-upstream-error` patches the global
  `setTimeout`.
- **Verify like this**: a full `node scripts/run-tests.js --all` fails a number of tests for
  reasons unrelated to the code on some machines (temp-dir permissions on Windows, line endings,
  shell environment variables such as `ANTHROPIC_BASE_URL`). Never judge a run by its count:
  compare against the parent commit, and compare the ✅/❌ lines of each test, not only its exit
  code — a test that fails on an EPERM at the end can hide a real failure in its cases. After an
  upstream merge that bumps `package.json`, install the new lockfile before comparing.
