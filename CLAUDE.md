# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Paperless-AI **next** — a community fork of clusterzx/paperless-ai. A Node.js/Express app that uses
LLMs (OpenAI, Ollama, Azure, Anthropic, or any OpenAI-compatible "custom" endpoint) plus optional OCR to auto-tag,
title, classify, and extract metadata for documents in a Paperless-ngx instance. Server-rendered EJS UI,
no frontend framework. Single SQLite database (better-sqlite3, WAL mode).

## Commands

> ⚠️ **`npm test` / `npm run test` does NOT run tests** — it starts the dev server via nodemon
> (`nodemon server.js`). This is a deliberate quirk of `package.json`.

```bash
# Run the dev server (auto-reload)
npm run test                       # = nodemon server.js
node server.js                     # plain run

# Tests (custom runner — plain node scripts, no jest/mocha)
npm run test:all                   # all tests          (node scripts/run-tests.js --all)
npm run test:list                  # list areas + tests
npm run test:area:security         # an area (auth|security|processing|routes|settings|tooling|…; --list shows all)
node scripts/run-tests.js --test ssrf-url-validation   # single test by name

# Lint / format
npx eslint .                       # flat config: eslint.config.mjs
npx prettier --check .             # .prettierrc.json + .prettierignore
npm run lint:css                   # stylelint over public/css/**/*.css
npm run typecheck                  # tsc --noEmit over the files listed in tsconfig.json

# Production (what Docker runs)
pm2-runtime ecosystem.config.js    # via start-services.sh

# Maintenance
npm run mfa:reset                  # reset MFA for a user
node scripts/regen-openapi.js      # regenerate OPENAPI/openapi.json from @swagger JSDoc
node scripts/route-proof.js snapshot|compare|openapi   # prove a route move changed nothing (see its header)
node tests/test-route-table.js --update                # regenerate the route table fixture after a deliberate route change
```

**Test gotcha:** several tests self-skip unless a server is reachable at `BASE_URL`
(default `http://localhost:3000`) and certain env vars are set — e.g. `rate-limiting`,
`thumbnail-auth-guard`, `scan-stop-flow` (needs `JWT_TOKEN` or `API_KEY`), `login-mfa-flow`
(needs `LOGIN_TEST_USERNAME`/`LOGIN_TEST_PASSWORD`). A "SKIPPED" result is not a failure. To run
the full server-dependent suite, start the server first, then run the tests against it.

## Architecture

**Entry point:** `server.js` — Express app, global middleware, CSRF, the cron wiring of the scan
(`services/scanService.js` holds the loop) and SSE progress streams. Routes live in `routes/`, request guards and limiters in
`middleware/`, everything else in the `services/` singletons.

**Service layer** (`services/`): every service with state or dependencies is a singleton —
`class Foo { ... }; module.exports = new Foo();`. Import and call directly; do not `new` them. Small
stateless helpers shared by several routers (`sessionCookie`, `userPresence`, `documentIdList`, …) export
plain functions instead.

**AI provider abstraction:** `services/aiProviderRules.js` is the single source of provider and
model knowledge: `PROVIDERS` (id, label, transport, connection keys), `resolveRules(provider, model)`
(may the request carry a temperature, which reasoning-effort dialect, how thinking is switched off,
the name of the completion cap, structured output, prompt caching), and `AI_OPTIONS`, the catalogue
the settings page renders its AI fields from (label, plain-language help, basic/advanced, which
providers show it). `services/aiServiceFactory.js` picks a service by transport
(`SERVICE_BY_TRANSPORT`): `openai` | `azure` | `custom` share `services/openaiCompatibleService.js`
(one instance per provider via `forProvider(id)`; `openaiService.js`, `azureService.js`,
`customService.js` are thin re-exports kept for their importers), `ollama` and `anthropic` have their
own transports. Every service implements `analyzeDocument(content, doc, existingTags, correspondents)`,
`generateText(prompt, options)` (options parsed in `services/aiGenerateOptions.js`) and `checkStatus()`,
reads `config` at call time and rebuilds its SDK client when key or URL change. To add an
OpenAI-compatible provider: an entry in `PROVIDERS`, a profile in `PROFILES` of
`openaiCompatibleService.js`, its config block in `config/config.js`; a new transport also needs an
entry in `SERVICE_BY_TRANSPORT`. Model-specific behaviour goes into `MODEL_FAMILIES` /
`PROVIDER_DEFAULTS` of the rules module, never into a service.

**Anthropic** is not OpenAI-compatible and has its own service (`services/anthropicService.js`). Per-model
traits (thinking, effort levels, cache minimums), the client factory, usage mapping and
the truncation/refusal check live in `services/anthropicSupport.js` and are shared with Claude OCR; never
send `temperature` to it or read `content[0]`. Its analysis prompt and JSON schema come from
`services/analysisPrompt.js`, which the OpenAI-compatible service uses too.

**Token handling:** `services/serviceUtils.js` — `calculateTokens()` (tiktoken for OpenAI, ÷3 char
estimate for `claude-*`, ÷4 otherwise) and `truncateToTokenLimit()`. Also holds AI-error → OCR-fallback classification
helpers used by the scan loop.

**Prompt restrictions:** `services/restrictionPromptService.js` replaces placeholders like
`%RESTRICTED_TAGS%`, `%RESTRICTED_CORRESPONDENTS%`, `%RESTRICTED_DOCUMENT_TYPES%`, `%CUSTOMFIELDS%`
in prompts. The base prompts live in `config/config.js` (`specialPromptPreDefinedTags`,
`mustHavePrompt`). Entity lists reach the services as either `[{ id, name }]` or `['name']` —
normalize them with `toNameList()` from `services/serviceUtils.js` instead of joining them directly.

**OCR:** `services/mistralOcrService.js` — provider can be `mistral`, `ollama` (native `/api/chat`
vision), OpenAI-compatible `/v1`, or `anthropic` (Claude reads PDFs and images natively). OCR is a fallback path when AI analysis fails on low-text docs.

**Database:** `models/document.js` — better-sqlite3 at `data/documents.db`, WAL mode, prepared
statements throughout. Key tables: `processed_documents`, `history_documents` (server-side paginated
via SQL `LIMIT/OFFSET`, not in-memory), `openai_metrics`, `original_documents`, `users`.
Schema migrations run at startup via `services/startupMigrations.js`.

**Paperless-ngx I/O:** `services/paperlessService.js` fetches documents and posts results back
(`updateDocument()`). Tags are cached with a TTL (`TAG_CACHE_TTL_SECONDS`, default 300s) to cut API calls.

**Reconciliation:** `services/reconciliationService.js` — cron job (`RECONCILIATION_INTERVAL`) that
cleans up records for documents deleted in Paperless-ngx.

**Tidy up (tags and correspondents):** one page, `/tidy-up` (`routes/tidyUp.js`, mounted before
`routes/index.js`; `/duplicates` and `/simplify` redirect to it), shows _suggestions_ a person accepts or
declines: merge two names, split a compound tag into a document type and topics, delete unused names.
`services/tidyUpRunService.js` runs one job (task `tidy-up` in `duplicateReviewJobService`) over the
existing machinery — `entityNameMatcher` (spelling tiers), `entityMatchAiService.reviewScan()` (the
model judges pairs spelling cannot settle, with document titles as evidence), `tagSimplifyService`
(the split proposals), `duplicateMergeService` (merge, delete, dismiss, undo, the merge log) — and
builds the list with `services/tidyUpSuggestions.js` (the one shape; certainty sure/likely/unsure:
a `different` verdict beats any spelling rule, an unanswered pair keeps its rule capped at likely).
Every sentence the page says lives in `services/tidyUpWording.js`; model failures get a kind in
`services/modelFailure.js` (unreadable, budget, unreachable, thinking, rejected, paperless) at the
place they happen, and the page tells what happened, what it means and what to do. Percentages and
rule names appear only inside a card's Details. The page (`views/tidy-up.ejs`,
`public/js/modules/tidy-up*.js`) talks to `/api/tidy-up/*` plus the few `/api/duplicates/*` and
`/api/simplify/*` endpoints it still calls (vocabulary, dismissals, AI review memory, undo), which live in
`routes/tidyUpSupport.js`; the rest of that legacy API was removed. Decisions are carried out at once
(Accept = merge/split/delete now, one Undo per batch); a run's suggestions live in memory until the
next run.

**Routes:** one router per feature, flat in `routes/` (swagger-jsdoc reads `./routes/*.js`, not
subfolders). `server.js` mounts `routes/oidc.js`, `routes/tidyUp.js`, then `routes/index.js`, which runs
the two router-wide guards from `middleware/authGate.js` once — `remoteSetupGuard` (setup only from
localhost while it is open) and `authGate` (no session → /login, except the frozen `PUBLIC_ROUTES`,
matched on whole path segments) — and then mounts the feature routers at `/` in a fixed order: login,
documents, history, maintenance, settings, scan, setupWizard, settingsConnections, manual, dashboard,
settingsMfa, system, ocr, queues, tidyUpSupport. Rules: mount at `/` with full paths (a mount path
strips `req.path` and breaks `isPublicPath`); no pathless `router.use` in a feature router; every
non-public route also carries its own guard (`isAuthenticated` or `protectApiRoute`), enforced by
identity in `tests/test-route-guard-coverage.js`. Who is calling is decided only in
`middleware/caller.js` (`resolveCaller()`: apiKey, session, none, invalid, misconfigured; constant-time
API key comparison); every guard, limiter key and CSRF hook is built from it with a declared policy
(`POLICIES` in `middleware/authGate.js`), and `tests/test-caller-resolver.js` fails on any other copy; a helper used by one feature lives at the top of its file, a
helper shared by several goes to `services/`. `tests/test-route-table.js` pins every route with its
guard chain, `tests/test-route-shadowing.js` the cross-router order. `schemas.js` holds shared swagger
schemas.

### UI layer ("zr")

There is no frontend framework and no build step — `public/` is served as written. What replaced
Tailwind/FontAwesome is a small in-house system whose rules are not obvious from any single file:

**CSS cascade layers are the whole design.** `public/css/tokens.css` opens with the order —
`@layer tokens, base, shell, components, modules, pages, utilities` — and every rule in every file
sits in one of them. A later layer beats an earlier one _regardless of specificity_, so a component
overrides a base primitive with a plain single-class selector, `pages/*.css` beats the framework, and
the colour utilities beat everything. Two consequences worth knowing before editing: a rule written
in the wrong file silently loses (or wins) no matter how specific it is, and every file must stay
layered — one unlayered rule would outrank the lot. Only two link positions in `head-start.ejs` are
load-bearing: tokens.css first, and buttons.css before forms.css.

**Page behaviour is one ES module per job.** `public/js/zr.js` is the kernel: theme, drawer, rail,
active nav, the toast, and a registry that imports `public/js/modules/<name>.js` for each
`data-module="<name>"` it finds. A page therefore costs its own modules and nothing else. Classic
scripts (`public/js/*.js`) cannot import ES modules — they reach the kernel through
`window.__zrToast` / `window.zrDialog` (see `failed.js` for the six-line adapter) and must never
build their own toast host.

**Settings page:** the AI provider and Tidy up sections render their fields from `AI_OPTIONS`
(`aiOptions` local); each section has one closed "Advanced options" disclosure
(`public/js/modules/settings-advanced.js` remembers the choice per browser), and options carry
`data-providers` so they follow the provider switch. Every settings key has one entry in
`services/settingsCatalog.js` (page, save, wizard prefill, .env export group, secret, restart, its
`parse`); `services/settingsService.js` turns a form body into an update with it, and `POST /settings`
is a thin route over that. A new setting is a catalogue entry plus its `fieldMappings` line in
`public/js/settings.js` (and an `AI_OPTIONS` entry for an AI option), not hand-written markup;
`tests/test-settings-catalog.js` checks the lists agree, `tests/test-settings-save-golden.js` pins the
save for ~100 form bodies (`GOLDEN_RECORD=1` re-records after a deliberate change).

**Conventions that bite if missed:** icons are `<symbol>`s in `public/icons.svg`, referenced with
`<use href="/icons.svg#i-name">` — there is no icon font, so `querySelector('i')` finds nothing;
`.hidden` is a deliberate `!important` class that JS toggles ~100×; `/styleguide` (dev builds only,
authenticated) renders every component once and is the place to check before inventing a class.

**Verifying UI work:** the app cannot be opened without a database and a Paperless-ngx instance, so
UI changes are reviewed with a throwaway Express server that renders the EJS views with mock locals
and mock API endpoints. Review list pages _with rows_ — a migration bug once hid in the queue tables
because they were only ever looked at empty.

### Document processing flow (services/scanService.js)

1. `node-cron` fires on `config.scanInterval` (cron syntax, default `*/30 * * * *`).
2. `scanService.scanDocuments()` pulls candidates from Paperless-ngx.
3. Each document goes through `services/documentPipeline.js` `processDocument()`, which the webhook
   queue and a manual rescan (`services/webhookQueueService.js`) share. They protect a document the
   same way (OCR guards, ignore list first, "complete" only after write-back); the few deliberate
   differences are named in `CALLER_PROFILES`. A document is analysed by one caller at a time
   (`claim()`/`release()`), is left alone while OCR reads it (`isWaitingForOcr()`, only while OCR is
   on), and the external API is asked once per run. Its `retryTracker` caps scan attempts (max 3);
   the limit puts the document on the failed list.
4. Skip rules (`services/skipRuleService.js`: `MAX_PAGE_COUNT`, `IGNORE_TITLE_PATTERNS`, text fingerprint of
   ignored docs) move a doc to the ignored list before any OCR or AI call; the webhook applies them too,
   a manual rescan does not. Unignoring a doc exempts it from the rules.
5. Docs below `MIN_CONTENT_LENGTH` (default 10) are skipped or routed to OCR.
6. If `PROCESS_PREDEFINED_DOCUMENTS=yes`, only docs whose tags match the `TAGS` env var are processed.
7. The factory's AI service analyzes; results are written back via `paperlessService.updateDocument()`.
   `services/scanControl.js` holds the scan state and the start/stop levers routes use mid-scan.

## Configuration system (important)

Config is centralized in `config/config.js` and read entirely from environment variables — **there is no
config object you set in code; everything is an env var.** Its exported values are getters that read
`process.env` on every access, so a value saved on the settings page applies to the next call without
a restart. Do not cache a config value in a module constant or a service constructor.

- **runtime-first mode (default):** legacy `data/.env` is migrated once into `data/runtime-overrides.json`
  (and `.env` renamed to `.env.migrated`). Runtime overrides are applied onto `process.env` at load, and
  `setupService.saveConfig()` writes both the file and `process.env`.
  Set `CONFIG_SOURCE_MODE=legacy` to keep using `data/.env` directly.
- **Operator-injected env wins:** keys present in `process.env` at startup (docker-compose `environment:`)
  are "protected" and are never overwritten by runtime overrides — except Dockerfile-baked defaults
  (`NODE_ENV`, `LOG_LEVEL`, `ANONYMIZED_TELEMETRY`, `PAPERLESS_AI_COMMIT_SHA`). The settings page does not
  explain this; a pinned field is simply disabled with "Set by the environment (KEY)." and the `.env`
  export under System → Export is the one expert surface.
- **Restarts:** the catalogue entries marked `restart: true` (read through
  `config/restartRequiredKeys.js`) are the keys something reads once at boot (port, proxy
  and cookie flags, rate limiter, cron schedules and their switches, the Paperless client, log level).
  `POST /settings` answers `{ restart, restartKeys }` and exits only when one of them changed; the page
  shows its restart note from the same list (`data-restart-keys` on `#setupForm`, `data-env-key` on
  each field). `GET /health` carries a per-process `bootId`; the restart overlay reloads only when it
  sees a new one. When you make a boot-time consumer read live, set its entry to `restart: false`.
- Booleans use `parseEnvBoolean()` — accepts `yes/no`, `true/false`, `1/0`.
- Feature toggles: `activate*` (tagging/correspondents/documentType/title/customFields).
  AI restrictions: `restrictToExisting*`.
- App version string lives in `PAPERLESS_AI_VERSION` in `config/config.js`.

## Type checking

No build step and no `.ts` sources: types are JSDoc, checked by `tsc --noEmit` (`npm run typecheck`).
A file is checked only when it starts with `// @ts-check` **and** is listed in `tsconfig.json` `files`
(strict mode); new modules join that way, legacy files stay out until someone types them. The same list
drives an `eslint-plugin-jsdoc` block, so malformed JSDoc in a typed file fails lint.

## CI

Every PR runs `.github/workflows/ci.yml`: ESLint, Prettier and stylelint on the **files changed in
the PR** (the legacy codebase is not fully clean yet — anything you touch must pass), the type check,
the offline test suite (`node scripts/run-tests.js --all`), and an OpenAPI drift check
(`regen-openapi.js` + `git diff`).
PRs touching Docker/dependency manifests additionally trigger `docker-check.yml` (build-only).
`security-audit.yml` runs `npm audit` weekly on a schedule.

## Conventions (enforced)

- **English only**, everywhere: code, comments, commits, PRs, UI strings, docs. No German/mixed content
  in any repo file. (Note: respond to the user in their language, but write repo content in English.)
- **OpenAPI sync is mandatory:** any change to an API endpoint/response must also update the `@swagger`
  JSDoc in `server.js`/`routes/*.js`/`schemas.js`, and `OPENAPI/openapi.json` must be regenerated
  (`node scripts/regen-openapi.js`). Don't land API changes with the spec out of sync.
- **Branches:** `{type}-{number}-{short-description}` (e.g. `next-123-improve-history-modal`).
- **Commit message = single source of truth for fix docs.** Do NOT add changelog/fix Markdown files.
  Put the full record in the commit body with sections: Background / Changes / Testing / Impact /
  Upstream Status.
- **Error logging:** user-facing operations log to both `htmlLogger` and `txtLogger` (see top of
  `server.js`). Wrap async routes in try/catch; return meaningful status codes.
- **API responses:** `{ success: true, data, message }` / `{ success: false, error }`.
- **SSE:** set `X-Accel-Buffering: no` and call `res.flush()` after each `res.write(...)`.
- **DataTables endpoints** expect `{ data, recordsTotal, recordsFiltered }`.
- **Stylelint guards the stylesheets:** duplicate selectors, duplicate properties and unquoted font
  names fail the build. The duplicate check scopes per `@layer` block, so keep one layer block per
  file. `no-descending-specificity` is off — it is structurally at odds with cascade layers.

## Docs

In-repo docs are intentionally minimal. Full architecture/config/API reference lives in the separate
docs repo (Astro + Starlight): https://github.com/admonstrator/paperless-ai-next-docs →
https://zettelrob.be/
