/**
 * @swagger
 * components:
 *   securitySchemes:
 *     BearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *       description: |
 *         JWT-based authentication for web app users. The token is obtained by authenticating via the login endpoint.
 *
 *         ### How to authenticate:
 *         1. Send a POST request to `/login` with your username and password
 *         2. The server will respond with a JWT token (also set as a cookie in browsers)
 *         3. Include this token in the `Authorization` header as `Bearer {token}`
 *
 *         Example:
 *         ```
 *         Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *         ```
 *
 *         JWT tokens are valid for 24 hours after issuance.
 *
 *     ApiKeyAuth:
 *       type: apiKey
 *       in: header
 *       name: x-api-key
 *       description: |
 *         API key authentication for programmatic access. The API key can be generated or regenerated using the /api/key-regenerate endpoint.
 *
 *         ### How to authenticate:
 *         1. Access the API key from your application settings
 *         2. Include the API key in the `x-api-key` HTTP header for all requests
 *
 *         Example:
 *         ```
 *         x-api-key: 7c1f3f5e2b0a9d8c6e4b2a1d3f5e8c9b2a1d3f5e
 *         ```
 *
 *         API keys do not expire unless regenerated.
 */

/**
 * @swagger
 * tags:
 *   - name: Authentication
 *     description: User authentication and authorization endpoints, including login, logout, and token management
 *   - name: Documents
 *     description: Document management and processing endpoints for interacting with Paperless-ngx documents
 *   - name: History
 *     description: Document processing history and tracking of AI-generated metadata
 *   - name: Navigation
 *     description: General navigation endpoints for the web interface
 *   - name: System
 *     description: System configuration, health checks, and administrative functions
 *   - name: Setup
 *     description: Application setup and configuration endpoints
 *   - name: Metadata
 *     description: Endpoints for managing document metadata like tags, correspondents, and document types
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *           example: Error resetting documents
 *
 *     User:
 *       type: object
 *       required:
 *         - username
 *         - password
 *       properties:
 *         username:
 *           type: string
 *           description: User's username
 *           example: admin
 *         password:
 *           type: string
 *           format: password
 *           description: User's password (will be hashed)
 *           example: securePassword123
 *         id:
 *           type: integer
 *           description: User ID (auto-generated)
 *           example: 1
 *           readOnly: true
 *
 *     LoginRequest:
 *       type: object
 *       required:
 *         - username
 *         - password
 *       properties:
 *         username:
 *           type: string
 *           description: User's username
 *           example: admin
 *         password:
 *           type: string
 *           format: password
 *           description: User's password
 *           example: securePassword123
 *
 *     LoginResponse:
 *       type: object
 *       properties:
 *         token:
 *           type: string
 *           description: JWT token for authentication
 *           example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *         expiresIn:
 *           type: string
 *           description: Token expiration time
 *           example: 24h
 *
 *     Document:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Document ID
 *           example: 123
 *         title:
 *           type: string
 *           description: Document title
 *           example: Invoice #12345
 *         tags:
 *           type: array
 *           items:
 *             type: integer
 *           description: Array of tag IDs
 *           example: [1, 4, 7]
 *         correspondent:
 *           type: integer
 *           description: Correspondent ID
 *           example: 5
 *         created:
 *           type: string
 *           format: date-time
 *           description: Document creation date
 *           example: 2023-12-15T10:30:00Z
 *         document_type:
 *           type: integer
 *           description: Document type ID
 *           example: 2
 *         content:
 *           type: string
 *           description: Document text content
 *           example: "This is an invoice from Company XYZ..."
 *         language:
 *           type: string
 *           description: Document language code
 *           example: en
 *         custom_fields:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/CustomField'
 *           description: Custom field values for the document
 *
 *     DocumentUpdateRequest:
 *       type: object
 *       properties:
 *         title:
 *           type: string
 *           description: New document title
 *           example: Updated Invoice #12345
 *         tags:
 *           type: array
 *           items:
 *             type: integer
 *           description: Array of tag IDs
 *           example: [1, 4, 7]
 *         correspondent:
 *           type: integer
 *           description: Correspondent ID
 *           example: 5
 *         document_type:
 *           type: integer
 *           description: Document type ID
 *           example: 2
 *         language:
 *           type: string
 *           description: Document language code
 *           example: en
 *         custom_fields:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/CustomField'
 *           description: Custom field values for the document
 *
 *     CustomField:
 *       type: object
 *       required:
 *         - field
 *         - value
 *       properties:
 *         field:
 *           type: integer
 *           description: Custom field ID
 *           example: 3
 *         value:
 *           type: string
 *           description: Custom field value
 *           example: "123.45"
 *
 *     AnalysisResult:
 *       type: object
 *       properties:
 *         document:
 *           type: object
 *           properties:
 *             title:
 *               type: string
 *               description: Suggested document title
 *               example: Invoice from ABC Corporation
 *             tags:
 *               type: array
 *               items:
 *                 type: string
 *               description: Suggested tags
 *               example: ["invoice", "utilities", "2023"]
 *             correspondent:
 *               type: string
 *               description: Suggested correspondent name
 *               example: ABC Corporation
 *             document_type:
 *               type: string
 *               description: Suggested document type
 *               example: Invoice
 *             document_date:
 *               type: string
 *               format: date-time
 *               description: Extracted document date
 *               example: 2023-12-15T00:00:00Z
 *             language:
 *               type: string
 *               description: Detected document language
 *               example: en
 *             custom_fields:
 *               type: object
 *               additionalProperties:
 *                 type: object
 *                 properties:
 *                   field_name:
 *                     type: string
 *                     description: Custom field name
 *                     example: invoice_amount
 *                   value:
 *                     type: string
 *                     description: Custom field value
 *                     example: "123.45"
 *         metrics:
 *           type: object
 *           properties:
 *             promptTokens:
 *               type: integer
 *               description: Number of tokens in the prompt
 *               example: 450
 *             completionTokens:
 *               type: integer
 *               description: Number of tokens in the completion
 *               example: 120
 *             totalTokens:
 *               type: integer
 *               description: Total tokens used
 *               example: 570
 *         error:
 *           type: string
 *           description: Error message if analysis failed
 *           example: null
 *
 *     Tag:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Tag ID
 *           example: 5
 *         name:
 *           type: string
 *           description: Tag name
 *           example: Invoice
 *         color:
 *           type: string
 *           description: Tag color (hex code)
 *           example: "#FF5733"
 *         match:
 *           type: string
 *           enum: [ANY, ALL, LITERAL, REGEX]
 *           description: Tag matching algorithm
 *           example: ANY
 *
 *     HistoryItem:
 *       type: object
 *       properties:
 *         document_id:
 *           type: integer
 *           description: Document ID
 *           example: 123
 *         title:
 *           type: string
 *           description: Document title
 *           example: Invoice #12345
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Date and time when the processing occurred
 *           example: 2023-12-15T10:30:00Z
 *         tags:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Tag'
 *         correspondent:
 *           type: string
 *           description: Document correspondent name
 *           example: Acme Corp
 *         link:
 *           type: string
 *           description: Link to the document in Paperless-ngx
 *           example: http://paperless.example.com/documents/123/
 *
 *     HistoryResponse:
 *       type: object
 *       properties:
 *         draw:
 *           type: integer
 *           description: DataTables draw counter echo
 *           example: 1
 *         recordsTotal:
 *           type: integer
 *           description: Total number of records in database
 *           example: 100
 *         recordsFiltered:
 *           type: integer
 *           description: Number of records after filtering
 *           example: 25
 *         data:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/HistoryItem'
 *
 *     APIKeyResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: string
 *           description: The newly generated API key
 *           example: 7c1f3f5e2b0a9d8c6e4b2a1d3f5e8c9b2a1d3f5e
 *
 *     HealthResponse:
 *       type: object
 *       properties:
 *         status:
 *           type: string
 *           enum: [healthy, degraded, database_error, error]
 *           description: |
 *             Overall system health. `degraded` means the database is fine but
 *             the document scanner cannot work (scheduler not armed, or repeated
 *             failed runs, e.g. an unreachable Paperless-ngx).
 *           example: healthy
 *         database:
 *           type: string
 *           description: Result of the local database check
 *           example: ok
 *         bootId:
 *           type: string
 *           description: |
 *             Random id drawn when the process started. It changes with every
 *             restart, so a client waiting for one polls until it differs.
 *           example: 3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17
 *         startedAt:
 *           type: string
 *           format: date-time
 *           description: When the process started
 *         message:
 *           type: string
 *           description: Additional status information (for non-healthy states). Authenticated callers only.
 *           example: "Document scan failed 3 time(s) in a row: connect ECONNREFUSED 172.18.0.2:8000"
 *         scanner:
 *           description: Authenticated callers only.
 *           allOf:
 *             - $ref: '#/components/schemas/ScannerHealth'
 *         paperless:
 *           description: Authenticated callers only.
 *           allOf:
 *             - $ref: '#/components/schemas/PaperlessHealth'
 *
 *     ScannerHealth:
 *       type: object
 *       description: State of the periodic document scan loop
 *       properties:
 *         automaticProcessingEnabled:
 *           type: boolean
 *           description: False when DISABLE_AUTOMATIC_PROCESSING=yes
 *           example: true
 *         armed:
 *           type: boolean
 *           description: Whether the scan cron job is scheduled
 *           example: true
 *         running:
 *           type: boolean
 *           description: Whether a scan is currently in progress
 *           example: false
 *         scanInterval:
 *           type: string
 *           nullable: true
 *           description: Cron expression the scheduler was armed with
 *           example: "0 * * * *"
 *         lastRunStartedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         lastRunFinishedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         lastRunSource:
 *           type: string
 *           nullable: true
 *           description: Trigger of the last run (initial, scheduler, api-manual, ...)
 *           example: scheduler
 *         lastRunStatus:
 *           type: string
 *           nullable: true
 *           enum: [ok, paperless_unreachable, error]
 *           example: ok
 *         lastSuccessfulRunAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         consecutiveFailures:
 *           type: integer
 *           description: Number of consecutive failed scan runs
 *           example: 0
 *         failureThreshold:
 *           type: integer
 *           description: Failures required before the scanner counts as degraded
 *           example: 3
 *         degraded:
 *           type: boolean
 *           example: false
 *         lastError:
 *           type: string
 *           nullable: true
 *           description: Error message of the last failed run
 *
 *     PaperlessHealth:
 *       type: object
 *       description: |
 *         Result of the most recent Paperless-ngx connectivity probe. The probe
 *         runs on every scan and additionally every
 *         `PAPERLESS_PROBE_INTERVAL_SECONDS` (default 60s), so the result stays
 *         current even while no scan is running.
 *       properties:
 *         reachable:
 *           type: boolean
 *           nullable: true
 *           description: |
 *             Whether the host answered at all. Null until the first probe has
 *             run. A rejected API token still counts as reachable — check
 *             `usable` to decide whether Paperless-ngx can actually be used.
 *           example: true
 *         authorized:
 *           type: boolean
 *           nullable: true
 *           description: Whether the API token was accepted (not 401/403)
 *           example: true
 *         usable:
 *           type: boolean
 *           nullable: true
 *           description: Reachable *and* authorized — what the scan loop needs
 *           example: true
 *         status:
 *           type: integer
 *           nullable: true
 *           description: HTTP status of the probe, null when no response arrived
 *           example: 200
 *         lastCheckedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         error:
 *           type: string
 *           nullable: true
 *           example: "connect ECONNREFUSED 172.18.0.2:8000"
 *
 *     EntityMergeUndoResult:
 *       type: object
 *       nullable: true
 *       properties:
 *         status:
 *           type: string
 *           enum: [undone, undo_failed]
 *         revertedMatchingRule:
 *           type: boolean
 *         performedBy:
 *           type: string
 *           nullable: true
 *           description: who asked for the undo (username, or api-key)
 *         sources:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               originalId:
 *                 type: integer
 *               name:
 *                 type: string
 *               restoredId:
 *                 type: integer
 *                 nullable: true
 *                 description: the re-created object's new id, or the id of a same-named object that existed again
 *               adoptedExisting:
 *                 type: boolean
 *                 description: true when a same-named object existed again and was reused instead of created
 *               documentsRestored:
 *                 type: integer
 *               documentsSkipped:
 *                 type: integer
 *                 description: documents that no longer exist or no longer carry the target
 *               error:
 *                 type: string
 *                 nullable: true
 *
 *     AiVerdict:
 *       type: object
 *       nullable: true
 *       description: What the AI provider said about a pair or a group; null when nothing was asked
 *       properties:
 *         verdict:
 *           type: string
 *           enum: [same, different, unsure]
 *         reason:
 *           type: string
 *           description: one short sentence from the model
 *         basis:
 *           type: string
 *           nullable: true
 *           description: the rule the model applied; one of case-or-spacing, umlaut, legal-form, plural, abbreviation, translation, synonym, typo, different-thing, different-topic, insufficient-evidence, or null when the model gave none
 *         confidence:
 *           type: string
 *           nullable: true
 *           enum: [high, low]
 *           description: how sure the model is; the page ticks a pair the model calls same only with high
 *         source:
 *           type: string
 *           nullable: true
 *           enum: [model, spelling-rule]
 *           description: spelling-rule when the matcher's hard tier settled the pair and the model was not asked
 *         remembered:
 *           type: boolean
 *           nullable: true
 *           description: true when the verdict came from the judge's memory of an earlier review instead of a request
 *         unanswered:
 *           type: boolean
 *           nullable: true
 *           description: true when nobody judged the pair - the request failed or left it out; the page lets the spelling rule stand
 *         failureKind:
 *           type: string
 *           nullable: true
 *           enum: [unreadable, budget, unreachable, thinking, rejected, paperless, stopped, unknown]
 *           description: present only on an unsure verdict whose request failed; its reason then says so in plain words
 *
 *     TagVocabularyEntry:
 *       type: object
 *       description: One entry of the target vocabulary of "Simplify tags"
 *       properties:
 *         id:
 *           type: integer
 *         dimension:
 *           type: string
 *           enum: [type, topic]
 *           description: type is a document type, topic is a tag
 *         name:
 *           type: string
 *         paperlessId:
 *           type: integer
 *           nullable: true
 *           description: the document type or tag in Paperless-ngx once it exists
 *         source:
 *           type: string
 *           enum: [model, user]
 *         position:
 *           type: integer
 *     TagVocabulary:
 *       type: object
 *       description: The vocabulary the archive should end up with, by dimension
 *       properties:
 *         types:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/TagVocabularyEntry'
 *         topics:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/TagVocabularyEntry'
 *     TagVocabularyRequest:
 *       type: object
 *       description: The vocabulary as the user saves it; names only, order kept
 *       properties:
 *         types:
 *           type: array
 *           items:
 *             type: string
 *         topics:
 *           type: array
 *           items:
 *             type: string
 *     TagVocabularyDocumentType:
 *       type: object
 *       description: |
 *         One document type of the Paperless-ngx instance, as the picker on
 *         the "Simplify tags" page offers it.
 *       properties:
 *         id:
 *           type: integer
 *           description: The id in Paperless-ngx
 *           example: 7
 *         name:
 *           type: string
 *           description: The name, exactly as Paperless-ngx spells it
 *           example: Rechnung
 *         documentCount:
 *           type: integer
 *           description: How many documents carry this type
 *           example: 128
 *         inVocabulary:
 *           type: boolean
 *           description: |
 *             True when the saved vocabulary holds a document type of exactly
 *             this name. Names in Paperless-ngx are case sensitive, so the
 *             comparison is too.
 *           example: true
 *     EntityMergeDismissal:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         kind:
 *           type: string
 *           enum: [tags, correspondents]
 *         idA:
 *           type: integer
 *         idB:
 *           type: integer
 *         nameA:
 *           type: string
 *           nullable: true
 *         nameB:
 *           type: string
 *           nullable: true
 *         createdAt:
 *           type: string
 *           format: date-time
 *
 *     AiRunEstimate:
 *       type: object
 *       description: |
 *         What a model-backed run will cost before it starts, plus what the
 *         last run of the same task actually cost. `basis` says where the
 *         numbers come from: `run` a finished run of this task, `model` the
 *         judge's measurement of this model, `guess` neither — the page says
 *         so rather than pretending.
 *       properties:
 *         items:
 *           type: integer
 *           description: items the model would be asked about
 *           example: 1145
 *         itemsByRule:
 *           type: integer
 *           description: items a rule settles without the model
 *           example: 42
 *         batchSize:
 *           type: integer
 *           example: 50
 *         requests:
 *           type: integer
 *           example: 23
 *         lanes:
 *           type: integer
 *           description: requests in flight at once
 *           example: 3
 *         seconds:
 *           type: integer
 *           example: 372
 *         basis:
 *           type: string
 *           enum: [run, model, guess]
 *         measuredAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         tokens:
 *           type: object
 *           properties:
 *             total:
 *               type: integer
 *               example: 1410000
 *             prompt:
 *               type: integer
 *             completion:
 *               type: integer
 *             thinking:
 *               type: integer
 *         lastRun:
 *           nullable: true
 *           allOf:
 *             - $ref: '#/components/schemas/AiRunStats'
 *
 *     AiRunStats:
 *       type: object
 *       description: What one finished run of a model-backed task cost.
 *       properties:
 *         task:
 *           type: string
 *           enum: [order, review, vocabulary, splits]
 *         model:
 *           type: string
 *           nullable: true
 *         thinking:
 *           type: boolean
 *         status:
 *           type: string
 *           enum: [done, stopped, failed]
 *         items:
 *           type: integer
 *         itemsByRule:
 *           type: integer
 *         requests:
 *           type: integer
 *         failedRequests:
 *           type: integer
 *         promptTokens:
 *           type: integer
 *           nullable: true
 *         completionTokens:
 *           type: integer
 *           nullable: true
 *         thinkingTokens:
 *           type: integer
 *           nullable: true
 *         seconds:
 *           type: number
 *         finishedAt:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     TidyUpRunRequest:
 *       type: object
 *       properties:
 *         askModel:
 *           type: boolean
 *           default: true
 *           description: ask the configured model about the pairs spelling cannot settle; ignored when no provider is configured
 *         suggestSplits:
 *           type: boolean
 *           default: false
 *           description: also ask the model which compound tags to split into a document type and topics (the Simplify order)
 *         kind:
 *           type: string
 *           enum: [tags, correspondents, all]
 *           default: all
 *         action:
 *           type: string
 *           nullable: true
 *           enum: [retry, continue, retry-affected, retry-larger, test-connection]
 *           description: |
 *             the key of the failure-notice action that started this run;
 *             `continue` and `retry-affected` ask the model only about the
 *             groups the previous run left as "needs a look" and carry the
 *             rest over; `retry-larger` and `test-connection` answer 501
 *         answerTokens:
 *           type: integer
 *           nullable: true
 *           description: a larger answer cap for retry-larger (not wired up yet)
 *     TidyUpStep:
 *       type: object
 *       description: one line of the run's progress list; keys and labels come from tidyUpWording.RUN_STEPS
 *       properties:
 *         key:
 *           type: string
 *           enum: [compare, evidence, judge, split, sort]
 *         label:
 *           type: string
 *         state:
 *           type: string
 *           enum: [done, now, next, skipped]
 *         detail:
 *           type: string
 *           description: the numbers next to the step, e.g. 550 names · 9 sure matches · 23 pairs spelling cannot settle
 *     TidyUpFailure:
 *       type: object
 *       description: present when the run failed or a part of it did; everything the notice needs
 *       properties:
 *         kind:
 *           type: string
 *           enum: [unreadable, budget, unreachable, thinking, rejected, paperless, stopped, unknown]
 *         title:
 *           type: string
 *         body:
 *           type: string
 *         actions:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               key:
 *                 type: string
 *                 description: retry | retry-affected | retry-larger | continue | decide-myself | test-connection
 *               label:
 *                 type: string
 *         settingsHint:
 *           type: string
 *           nullable: true
 *           description: the label of a link to /settings#tidy-up, null for none
 *         technical:
 *           type: string
 *           description: the raw message and request context, for the Details disclosure
 *         pairsAffected:
 *           type: integer
 *           description: pairs that ended as "needs a look" because of this failure
 *     TidyUpRun:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         status:
 *           type: string
 *           enum: [running, stopping, done, stopped, failed]
 *         headline:
 *           type: string
 *           description: tidyUpWording.runHeadline(status)
 *         options:
 *           $ref: '#/components/schemas/TidyUpRunRequest'
 *         steps:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/TidyUpStep'
 *         progress:
 *           type: object
 *           properties:
 *             percent:
 *               type: integer
 *             etaText:
 *               type: string
 *               nullable: true
 *               description: e.g. About a minute left
 *             costText:
 *               type: string
 *               nullable: true
 *               description: e.g. 38,400 tokens of your 200,000 budget
 *             tokens:
 *               type: integer
 *             tokenBudget:
 *               type: integer
 *               nullable: true
 *         model:
 *           type: string
 *           nullable: true
 *           description: the model label shown in sentences, e.g. "Claude Haiku"
 *         failure:
 *           allOf:
 *             - $ref: '#/components/schemas/TidyUpFailure'
 *           nullable: true
 *         partialFailures:
 *           type: array
 *           description: failures of single requests the run survived (their pairs are "needs a look")
 *           items:
 *             $ref: '#/components/schemas/TidyUpFailure'
 *         summary:
 *           $ref: '#/components/schemas/TidyUpSummary'
 *         startedAt:
 *           type: string
 *           format: date-time
 *         finishedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         activity:
 *           allOf:
 *             - $ref: '#/components/schemas/TidyUpActivity'
 *           nullable: true
 *           description: what a decide or undo call is writing right now; null when idle
 *     TidyUpActivity:
 *       type: object
 *       description: |
 *         A decide or undo call while it writes to Paperless-ngx, one
 *         suggestion (or undo entry) after the other. GET /api/tidy-up/suggestions
 *         and the run's event stream carry it; a 409 of decide or undo names it.
 *       properties:
 *         kind:
 *           type: string
 *           enum: [accept, decline, undo]
 *         batchId:
 *           type: string
 *           nullable: true
 *           description: the batch an accept creates, or the batch an undo takes back; null for a decline
 *         total:
 *           type: integer
 *           description: suggestions to carry out or decline, or undo entries to take back
 *         done:
 *           type: integer
 *           description: how many of them are finished
 *         current:
 *           type: object
 *           nullable: true
 *           description: the suggestion in flight; several when unused names are deleted in one call
 *           properties:
 *             id: { type: string }
 *             ids:
 *               type: array
 *               items: { type: string }
 *             kind:
 *               type: string
 *               enum: [merge, split, delete]
 *             headline: { type: string }
 *         startedAt:
 *           type: string
 *           format: date-time
 *         sentence:
 *           type: string
 *           description: tidyUpWording.activitySentence, e.g. Merging Invoices into invoice… 2 of 9
 *     TidyUpEntity:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         name:
 *           type: string
 *         documentCount:
 *           type: integer
 *     TidyUpEvidenceSide:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         name:
 *           type: string
 *         documentCount:
 *           type: integer
 *         titles:
 *           type: array
 *           items:
 *             type: string
 *           description: up to three document titles
 *         neighbours:
 *           type: array
 *           items:
 *             type: string
 *           description: the names usually filed with this one
 *     TidyUpSuggestion:
 *       type: object
 *       description: one sentence a person accepts or declines; built by services/tidyUpSuggestions.js
 *       properties:
 *         id:
 *           type: string
 *         kind:
 *           type: string
 *           enum: [merge, split, delete]
 *         entityKind:
 *           type: string
 *           enum: [tags, correspondents]
 *         certainty:
 *           type: string
 *           enum: [sure, likely, unsure]
 *         headline:
 *           type: string
 *           description: e.g. Merge Invoices into invoice, or for an unsure pair the question Are Kontoauszug and Kontoumzug the same thing?
 *         reason:
 *           type: string
 *           description: why, in plain words, and what moves
 *         from:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/TidyUpEntity'
 *         to:
 *           allOf:
 *             - $ref: '#/components/schemas/TidyUpEntity'
 *           nullable: true
 *         typeName:
 *           type: string
 *           nullable: true
 *         topicNames:
 *           type: array
 *           items:
 *             type: string
 *         evidence:
 *           type: object
 *           nullable: true
 *           properties:
 *             sides:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/TidyUpEvidenceSide'
 *         details:
 *           type: object
 *           description: what the Details disclosure shows; never in the sentence
 *           properties:
 *             rules:
 *               type: array
 *               items:
 *                 type: string
 *             confidence:
 *               type: number
 *               nullable: true
 *             verdict:
 *               allOf:
 *                 - $ref: '#/components/schemas/AiVerdict'
 *               nullable: true
 *             source:
 *               type: string
 *               enum: [scan, ai-candidate, order, unused]
 *             warnings:
 *               type: array
 *               items:
 *                 type: string
 *         status:
 *           type: string
 *           enum: [open, done, declined, later, failed]
 *         outcome:
 *           type: string
 *           nullable: true
 *           description: after done or failed, one line, e.g. 12 documents moved
 *         undoId:
 *           type: string
 *           nullable: true
 *           description: the merge-log id that undoes it
 *     TidyUpSummary:
 *       type: object
 *       properties:
 *         total: { type: integer }
 *         open: { type: integer }
 *         sure: { type: integer }
 *         likely: { type: integer }
 *         unsure: { type: integer }
 *         merge: { type: integer }
 *         split: { type: integer }
 *         delete: { type: integer }
 *         done: { type: integer }
 *         declined: { type: integer }
 *         later: { type: integer }
 *         failed: { type: integer }
 *     TidyUpDecisionRequest:
 *       type: object
 *       required: [ids, decision]
 *       properties:
 *         ids:
 *           type: array
 *           items:
 *             type: string
 *         decision:
 *           type: string
 *           enum: [accept, decline, later]
 *         edits:
 *           type: object
 *           description: per suggestion id, changes to apply before accepting
 *           additionalProperties:
 *             type: object
 *             properties:
 *               keepId:
 *                 type: integer
 *                 description: merge - the member that should survive instead of the proposed target
 *               targetName:
 *                 type: string
 *                 description: merge - a new name for the survivor
 *               typeName:
 *                 type: string
 *                 nullable: true
 *               topicNames:
 *                 type: array
 *                 items:
 *                   type: string
 *               memberIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: delete - only these of the grouped unused names
 *     TidyUpRecentChange:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         when:
 *           type: string
 *           format: date-time
 *         sentence:
 *           type: string
 *           description: e.g. Merged Invoices into invoice · 12 documents moved
 *         status:
 *           type: string
 *           enum: [done, partial, failed, undone]
 *         canUndo:
 *           type: boolean
 */

// This file only contains JSDoc comments for Swagger schema definitions
// No actual code is needed
