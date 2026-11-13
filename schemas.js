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
 *     EntityRecord:
 *       type: object
 *       description: |
 *         One tag or correspondent as the Duplicates feature reads it — the
 *         Paperless-ngx object in camelCase, with nothing added. A
 *         DuplicateGroupMember is this record plus its score inside a group.
 *       properties:
 *         id:
 *           type: integer
 *           example: 12
 *         name:
 *           type: string
 *           example: Amazon EU S.a.r.l.
 *         documentCount:
 *           type: integer
 *           example: 41
 *         matchingAlgorithm:
 *           type: integer
 *           description: Paperless-ngx matching_algorithm, 0 = none
 *           example: 1
 *         match:
 *           type: string
 *           example: amazon
 *         isInsensitive:
 *           type: boolean
 *         owner:
 *           type: integer
 *           nullable: true
 *         userCanChange:
 *           type: boolean
 *           description: false when the API token may not modify the object
 *         isInboxTag:
 *           type: boolean
 *           description: tags only
 *         color:
 *           type: string
 *           nullable: true
 *           description: tags only
 *         lastCorrespondence:
 *           type: string
 *           nullable: true
 *           description: correspondents only
 *
 *     DuplicateGroupMember:
 *       type: object
 *       description: One tag or correspondent inside a duplicate group
 *       properties:
 *         id:
 *           type: integer
 *           example: 12
 *         name:
 *           type: string
 *           example: Amazon EU S.a.r.l.
 *         documentCount:
 *           type: integer
 *           example: 41
 *         matchingAlgorithm:
 *           type: integer
 *           description: Paperless-ngx matching_algorithm, 0 = none
 *           example: 1
 *         match:
 *           type: string
 *           example: amazon
 *         isInsensitive:
 *           type: boolean
 *         owner:
 *           type: integer
 *           nullable: true
 *         userCanChange:
 *           type: boolean
 *           description: false when the API token may not modify the object
 *         isInboxTag:
 *           type: boolean
 *           description: tags only
 *         color:
 *           type: string
 *           nullable: true
 *           description: tags only
 *         lastCorrespondence:
 *           type: string
 *           nullable: true
 *           description: correspondents only
 *         scoreToTarget:
 *           type: number
 *           description: 1 for the suggested target itself
 *           example: 0.92
 *         reason:
 *           type: string
 *           nullable: true
 *           enum: [exact-normalized, umlaut-variant, legal-form, plural, token-order, prefix, fuzzy]
 *         aiVerdict:
 *           $ref: '#/components/schemas/AiVerdict'
 *
 *     DuplicateGroup:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: kind plus the member ids in ascending order
 *           example: "tags:12-48-97"
 *         kind:
 *           type: string
 *           enum: [tags, correspondents]
 *         confidence:
 *           type: number
 *           description: lowest scoreToTarget in the group
 *           example: 0.92
 *         reasons:
 *           type: array
 *           items:
 *             type: string
 *         suggestedTargetId:
 *           type: integer
 *           example: 12
 *         members:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/DuplicateGroupMember'
 *         warnings:
 *           type: array
 *           items:
 *             type: string
 *             enum: [inbox-tag, configured-tag, no-permission, has-matching-rule, owner-differs, large-group]
 *         source:
 *           type: string
 *           enum: [scan, ai-candidate]
 *           description: present in an AI review result; ai-candidate groups scored below the threshold and were confirmed by the model
 *         aiVerdict:
 *           $ref: '#/components/schemas/AiVerdict'
 *
 *     DuplicateScanResult:
 *       type: object
 *       properties:
 *         scannedAt:
 *           type: string
 *           format: date-time
 *         threshold:
 *           type: number
 *           example: 0.85
 *         totals:
 *           type: object
 *           properties:
 *             tags:
 *               type: integer
 *               description: tags loaded from Paperless-ngx (null when not scanned)
 *               nullable: true
 *             correspondents:
 *               type: integer
 *               nullable: true
 *         groups:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/DuplicateGroup'
 *         dismissedPairs:
 *           type: integer
 *           description: pairs hidden because the user marked them as not duplicates
 *         paperlessUrl:
 *           type: string
 *           nullable: true
 *           description: public Paperless-ngx base URL the page links its entries to
 *           example: https://paperless.example.org
 *         unused:
 *           type: object
 *           description: objects of the scanned kinds that carry no document; inbox and configured tags are never listed
 *           properties:
 *             tags:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/EntityRecord'
 *             correspondents:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/EntityRecord'
 *
 *     EntityMergeRequest:
 *       type: object
 *       required:
 *         - kind
 *         - targetId
 *         - sourceIds
 *       properties:
 *         kind:
 *           type: string
 *           enum: [tags, correspondents]
 *         targetId:
 *           type: integer
 *           description: the object that survives
 *           example: 12
 *         sourceIds:
 *           type: array
 *           description: objects whose documents move to the target and which are deleted afterwards
 *           items:
 *             type: integer
 *           example: [48, 97]
 *         targetName:
 *           type: string
 *           description: a new name for the target, applied before the merge; empty or absent keeps its name
 *         copyMatchingRule:
 *           type: boolean
 *           description: copy a source's matching rule to the target when the target has none
 *           default: false
 *
 *     EntityMergeSourceResult:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         name:
 *           type: string
 *         documentsMoved:
 *           type: integer
 *         deleted:
 *           type: boolean
 *           description: false when the source was skipped or the merge stopped before deleting it
 *         error:
 *           type: string
 *           nullable: true
 *
 *     EntityMergeResult:
 *       type: object
 *       properties:
 *         mergeId:
 *           type: integer
 *           nullable: true
 *           description: id of the log entry, usable for an undo
 *         kind:
 *           type: string
 *           enum: [tags, correspondents]
 *         target:
 *           type: object
 *           properties:
 *             id:
 *               type: integer
 *             name:
 *               type: string
 *         documentsMoved:
 *           type: integer
 *         copiedMatchingRule:
 *           type: boolean
 *         status:
 *           type: string
 *           enum: [done, partial]
 *         sources:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/EntityMergeSourceResult'
 *
 *     EntityMergeLogEntry:
 *       type: object
 *       description: One merge as recorded locally, with everything an undo needs
 *       properties:
 *         id:
 *           type: integer
 *         kind:
 *           type: string
 *           enum: [tags, correspondents]
 *         targetId:
 *           type: integer
 *         targetName:
 *           type: string
 *         targetBefore:
 *           type: object
 *           nullable: true
 *           description: the target's matching rule before the merge
 *         sources:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: integer
 *               name:
 *                 type: string
 *               snapshot:
 *                 type: object
 *                 description: the source object as it was before deletion
 *               documentIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *               documentsAlreadyOnTarget:
 *                 type: array
 *                 description: tags only; documents that carried the target before the merge
 *                 items:
 *                   type: integer
 *               documentsMoved:
 *                 type: integer
 *               deleted:
 *                 type: boolean
 *               copiedMatchingRule:
 *                 type: boolean
 *                 description: true on the one source whose matching rule was copied to the target
 *               error:
 *                 type: string
 *                 nullable: true
 *         documentsMoved:
 *           type: integer
 *         copiedMatchingRule:
 *           type: boolean
 *         status:
 *           type: string
 *           enum: [done, partial, undone, undo_failed]
 *         performedBy:
 *           type: string
 *           nullable: true
 *         createdAt:
 *           type: string
 *           format: date-time
 *         undoneAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         undoResult:
 *           $ref: '#/components/schemas/EntityMergeUndoResult'
 *         action:
 *           type: string
 *           enum: [merge, delete, split]
 *           description: what the row records; a delete row lists the removed objects as its sources and can be undone like a merge
 *         details:
 *           type: object
 *           nullable: true
 *           description: |
 *             What a split did, per document, so an undo can put exactly that
 *             back: the topic tags it added and the document type it set.
 *             Null for merges and deletes.
 *           properties:
 *             typeName:
 *               type: string
 *               nullable: true
 *             typeId:
 *               type: integer
 *               nullable: true
 *             topicTagIds:
 *               type: array
 *               items:
 *                 type: integer
 *             createdTypeId:
 *               type: integer
 *               nullable: true
 *               description: a document type the split created, deleted again by the undo
 *             createdTagIds:
 *               type: array
 *               items:
 *                 type: integer
 *               description: topic tags the split created, deleted again by the undo
 *             documents:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   addedTagIds:
 *                     type: array
 *                     items:
 *                       type: integer
 *                   previousTypeId:
 *                     type: integer
 *                     nullable: true
 *                   typeSet:
 *                     type: boolean
 *         targetRenamedFrom:
 *           type: string
 *           nullable: true
 *           description: the target's name before this merge renamed it; null when it did not
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
 *     DuplicateAiReviewRequest:
 *       type: object
 *       properties:
 *         kind:
 *           type: string
 *           enum: [tags, correspondents, all]
 *           default: all
 *         threshold:
 *           type: number
 *           example: 0.85
 *         includeDismissed:
 *           type: boolean
 *           default: false
 *         withTitles:
 *           type: boolean
 *           default: true
 *           description: give the model a few recent document titles per entity as context
 *         groupIds:
 *           type: array
 *           description: judge only these groups of the scan (ids as the scan returned them); other groups come back without a verdict
 *           items:
 *             type: string
 *         minConfidence:
 *           type: number
 *           description: judge only groups whose confidence is at least this value (0.5 to 1); combined with groupIds both must hold
 *           example: 0.95
 *         includeCandidates:
 *           type: boolean
 *           default: true
 *           description: false skips the band of near-misses below the threshold, so only scan groups are judged
 *         withExcerpts:
 *           type: boolean
 *           default: true
 *           description: give the model short content excerpts of a couple of documents per entity for pairs the matcher linked by spelling alone
 *         semanticSweep:
 *           type: boolean
 *           default: false
 *           description: let the model see the names of each kind and propose groups the string matcher cannot (synonyms, translations); the proposals are judged with evidence like the band
 *
 *     DuplicateAiReviewResult:
 *       allOf:
 *         - $ref: '#/components/schemas/DuplicateScanResult'
 *         - type: object
 *           properties:
 *             aiReview:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                 model:
 *                   type: string
 *                   nullable: true
 *                 requests:
 *                   type: integer
 *                 tokens:
 *                   type: integer
 *                   nullable: true
 *                 judged:
 *                   type: integer
 *                   description: pairs the model was asked about
 *                 candidates:
 *                   type: integer
 *                   description: pairs from the wider band the model was shown
 *                 failedRequests:
 *                   type: integer
 *                   description: model requests that answered nothing usable; their pairs are marked unsure
 *                 failures:
 *                   type: array
 *                   description: one entry per failed request, with its kind (a single pair that did not fit the token limit is one too)
 *                   items:
 *                     $ref: '#/components/schemas/ModelFailure'
 *                 retries:
 *                   type: integer
 *                   description: extra requests made because an answer was cut off at the token limit and the batch was re-asked in smaller pieces
 *                 batchSize:
 *                   type: integer
 *                   description: pairs per request actually used after sizing by the token budget
 *                 targeted:
 *                   type: boolean
 *                   description: true when groupIds, minConfidence or includeCandidates narrowed the review
 *                 groupsJudged:
 *                   type: integer
 *                   description: scan groups the model was asked about
 *                 groupsSkipped:
 *                   type: integer
 *                   description: scan groups returned without a verdict because the targeting left them out
 *                 excerpts:
 *                   type: integer
 *                   description: entities whose document excerpts were fetched as evidence
 *                 escalated:
 *                   type: integer
 *                   description: pairs the model called unsure that were asked once more with excerpts
 *                 spellingRules:
 *                   type: integer
 *                   description: pairs settled by the matcher's hard tiers (exact, umlaut, legal form) without asking the model
 *                 stopped:
 *                   type: boolean
 *                   description: true when the review ended before every pair was judged; the verdicts it did reach are in the groups
 *                 stopReason:
 *                   type: string
 *                   nullable: true
 *                   enum: [user, token-budget, idle]
 *                   description: why a stopped review ended; null when it ran through
 *                 pairsNotJudged:
 *                   type: integer
 *                   description: pairs that were due but never reached the model because the review stopped
 *                 sweepRequests:
 *                   type: integer
 *                   description: model requests the semantic sweep made (names only)
 *                 sweepProposals:
 *                   type: integer
 *                   description: pairs the sweep proposed that the string matcher had not; they were judged with evidence like any candidate
 *                 verdictsReused:
 *                   type: integer
 *                   description: pairs answered from the judge's memory of earlier verdicts instead of a model request
 *                 concurrency:
 *                   type: integer
 *                   description: model requests the review kept in flight at once
 *
 *     AiReviewProgress:
 *       type: object
 *       description: Where a running review is. Every field is present; a count that is not known yet is null.
 *       properties:
 *         phase:
 *           type: string
 *           enum: [starting, scanning, evidence, sweeping, warming-up, judging, escalating, finishing]
 *         message:
 *           type: string
 *           description: one line for the page, e.g. "Asking the model, request 3 of 8"
 *         kind:
 *           type: string
 *           nullable: true
 *           enum: [tags, correspondents]
 *           description: the kind being worked on, null between kinds
 *         requestsDone:
 *           type: integer
 *         requestsPlanned:
 *           type: integer
 *           nullable: true
 *           description: requests the plan expects for the whole review; grows when a cut-off answer is re-asked in halves
 *         pairsJudged:
 *           type: integer
 *         pairsTotal:
 *           type: integer
 *           nullable: true
 *           description: pairs the review will ask about across all kinds
 *         tokens:
 *           type: integer
 *           nullable: true
 *           description: tokens spent so far, prompt and completion
 *         tokenBudget:
 *           type: integer
 *           nullable: true
 *           description: the configured ceiling for this review; null when there is none
 *         estimatedTokens:
 *           type: integer
 *           nullable: true
 *           description: what the plan expects the whole review to cost, known once the batches are sized
 *         elapsedMs:
 *           type: integer
 *         etaMs:
 *           type: integer
 *           nullable: true
 *           description: the remaining time the request rate so far suggests; null before the first request answered
 *         excerpts:
 *           type: integer
 *         escalated:
 *           type: integer
 *         spellingRules:
 *           type: integer
 *         failedRequests:
 *           type: integer
 *         retries:
 *           type: integer
 *         requestPairs:
 *           type: integer
 *           nullable: true
 *           description: pairs in the request that is being answered right now; null between requests
 *         requestAnswers:
 *           type: integer
 *           description: verdicts that have arrived so far in the current request, read off the streamed answer
 *         requestTokens:
 *           type: integer
 *           nullable: true
 *           description: completion tokens the current request has produced so far, streamed or estimated
 *         thinking:
 *           type: boolean
 *           description: true while the model is writing reasoning rather than its answer
 *         batchSize:
 *           type: integer
 *           nullable: true
 *           description: pairs per request the judge is using now; changes once after the warm-up measured the model
 *         calibrated:
 *           type: boolean
 *           description: true once the batch size and the answer cap come from a measurement of this model rather than from defaults
 *         concurrency:
 *           type: integer
 *           nullable: true
 *           description: model requests kept in flight at once
 *         inFlight:
 *           type: integer
 *           description: model requests waiting for an answer right now
 *         verdictsReused:
 *           type: integer
 *           description: pairs answered from remembered verdicts so far
 *         tally:
 *           type: object
 *           nullable: true
 *           description: what the model has answered so far; null until it answered
 *           properties:
 *             same:
 *               type: integer
 *             different:
 *               type: integer
 *             unsure:
 *               type: integer
 *         thinkingTokens:
 *           type: integer
 *           nullable: true
 *           description: reasoning tokens of the current request so far, estimated from the reasoning text; null when the model wrote none
 *
 *     AiReviewJob:
 *       type: object
 *       description: One AI review running on the server, or the last one that finished. There is at most one at a time.
 *       properties:
 *         task:
 *           type: string
 *           enum: [review, vocabulary, splits, order, apply]
 *           description: what the job runs; the Simplify tags page starts the vocabulary, splits, order and apply tasks through the same runner
 *         id:
 *           type: string
 *         status:
 *           type: string
 *           enum: [running, stopping, done, stopped, failed]
 *         options:
 *           $ref: '#/components/schemas/DuplicateAiReviewRequest'
 *         startedAt:
 *           type: string
 *           format: date-time
 *         finishedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         stopReason:
 *           type: string
 *           nullable: true
 *           enum: [user, token-budget, idle]
 *         progress:
 *           $ref: '#/components/schemas/AiReviewProgress'
 *         error:
 *           type: string
 *           nullable: true
 *           description: the message of a failed review
 *         hasResult:
 *           type: boolean
 *           description: true when the job carries a DuplicateAiReviewResult (done, or stopped with partial verdicts)
 *         failure:
 *           nullable: true
 *           description: why the job did not end as done; set for a failed job, a stop at the token budget (kind budget) and a stop because the page was closed (kind stopped), null otherwise
 *           allOf:
 *             - $ref: '#/components/schemas/ModelFailure'
 *         partialFailures:
 *           type: array
 *           description: the requests that failed while the job went on, one entry per kind with the affected counts summed
 *           items:
 *             $ref: '#/components/schemas/ModelFailure'
 *
 *     ModelFailure:
 *       type: object
 *       description: A model failure sorted into a kind a person can be told about (services/modelFailure.js)
 *       properties:
 *         kind:
 *           type: string
 *           enum: [unreadable, budget, unreachable, thinking, rejected, paperless, stopped, unknown]
 *         message:
 *           type: string
 *           description: the raw message, for the Details disclosure only
 *         model:
 *           type: string
 *           nullable: true
 *         endpoint:
 *           type: string
 *           nullable: true
 *         status:
 *           type: integer
 *           nullable: true
 *           description: the HTTP status the provider answered with, when there was one
 *         pairsAffected:
 *           type: integer
 *           description: pairs left "needs a look" by it (judge requests)
 *         tagsAffected:
 *           type: integer
 *           description: tags left as they are by it (split and order requests)
 *         namesAffected:
 *           type: integer
 *           description: names a vocabulary or sweep request did not read
 *         request:
 *           type: object
 *           description: where the failed request sat in its run; on a single request only
 *           properties:
 *             index:
 *               type: integer
 *               nullable: true
 *             total:
 *               type: integer
 *               nullable: true
 *         requests:
 *           type: integer
 *           description: on a collapsed entry (partialFailures), how many failed requests it stands for
 *
 *     AiReviewJobEvent:
 *       type: object
 *       description: One server-sent event of a review job. The stream ends after done, stopped or failed.
 *       properties:
 *         type:
 *           type: string
 *           enum: [progress, done, stopped, failed]
 *         job:
 *           $ref: '#/components/schemas/AiReviewJob'
 *         data:
 *           description: the DuplicateAiReviewResult on done and on stopped (partial); absent otherwise
 *           $ref: '#/components/schemas/DuplicateAiReviewResult'
 *         error:
 *           type: string
 *           nullable: true
 *
 *     EntityDeleteRequest:
 *       type: object
 *       required:
 *         - kind
 *         - ids
 *       properties:
 *         kind:
 *           type: string
 *           enum: [tags, correspondents]
 *         ids:
 *           type: array
 *           description: unused objects to delete; an object that carries a document by now is refused, not deleted
 *           items:
 *             type: integer
 *
 *     EntityDeleteResult:
 *       type: object
 *       properties:
 *         kind:
 *           type: string
 *         deleted:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: integer
 *               name:
 *                 type: string
 *         failed:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: integer
 *               name:
 *                 type: string
 *               error:
 *                 type: string
 *         logId:
 *           type: integer
 *           nullable: true
 *           description: the merge-log row (action delete) that an undo re-creates the objects from
 *
 *     EntityNameMapping:
 *       type: object
 *       description: document analysis proposed a name and the creation guard used an existing object instead
 *       properties:
 *         id:
 *           type: integer
 *         kind:
 *           type: string
 *           enum: [tags, correspondents]
 *         proposedName:
 *           type: string
 *         targetId:
 *           type: integer
 *         targetName:
 *           type: string
 *         reason:
 *           type: string
 *           description: the matcher tier that linked the names
 *         score:
 *           type: number
 *         documentId:
 *           type: integer
 *           nullable: true
 *         createdAt:
 *           type: string
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
 *     TagSplitProposal:
 *       type: object
 *       description: What one tag stands for, as proposed by a rule, the model or the user
 *       properties:
 *         tagId:
 *           type: integer
 *         tagName:
 *           type: string
 *         documentCount:
 *           type: integer
 *         action:
 *           type: string
 *           enum: [split, merge, keep, delete]
 *           description: what the proposed order does with the tag; split covers a type, topics or both
 *         mergeInto:
 *           type: string
 *           nullable: true
 *           description: the name of the tag this one merges into; only with action merge
 *         typeName:
 *           type: string
 *           nullable: true
 *           description: the document type the tag encodes, null when it encodes none
 *         topicNames:
 *           type: array
 *           items:
 *             type: string
 *         source:
 *           type: string
 *           enum: [rule, model, user]
 *         confidence:
 *           type: string
 *           nullable: true
 *           enum: [high, low]
 *         reason:
 *           type: string
 *           nullable: true
 *         documentsWithType:
 *           type: integer
 *           description: documents of the tag that already carry a different document type; they keep it unless overwriteType is set
 *         overwriteType:
 *           type: boolean
 *         status:
 *           type: string
 *           enum: [open, accepted, applied, skipped]
 *         updatedAt:
 *           type: string
 *     TagSplitProposalPatch:
 *       type: object
 *       description: What the user may change on a proposal
 *       properties:
 *         typeName:
 *           type: string
 *           nullable: true
 *         topicNames:
 *           type: array
 *           items:
 *             type: string
 *         overwriteType:
 *           type: boolean
 *         action:
 *           type: string
 *           enum: [split, merge, keep, delete]
 *         mergeInto:
 *           type: string
 *           nullable: true
 *         status:
 *           type: string
 *           enum: [open, accepted, skipped]
 *     TagOrderGroupMember:
 *       type: object
 *       description: One tag inside a group of the proposed order
 *       properties:
 *         tagId:
 *           type: integer
 *         tagName:
 *           type: string
 *         documentCount:
 *           type: integer
 *         action:
 *           type: string
 *           enum: [split, merge, keep, delete]
 *         typeName:
 *           type: string
 *           nullable: true
 *         topicNames:
 *           type: array
 *           items:
 *             type: string
 *         mergeInto:
 *           type: string
 *           nullable: true
 *         source:
 *           type: string
 *           enum: [rule, model, user]
 *         confidence:
 *           type: string
 *           nullable: true
 *           enum: [high, low]
 *         reason:
 *           type: string
 *           nullable: true
 *         status:
 *           type: string
 *           enum: [open, accepted, applied, skipped]
 *     TagOrderGroup:
 *       type: object
 *       description: One group of the proposed order, the unit the user accepts or skips
 *       properties:
 *         key:
 *           type: string
 *           description: type:Rechnung, topic:Strom, merge:Amazon, keep or delete
 *         kind:
 *           type: string
 *           enum: [type, topic, merge, keep, delete]
 *         name:
 *           type: string
 *           nullable: true
 *           description: the document type, topic or merge target; null for keep and delete
 *         tags:
 *           type: integer
 *           description: member tags
 *         documents:
 *           type: integer
 *           description: documents the members carry, summed
 *         open:
 *           type: integer
 *         accepted:
 *           type: integer
 *         applied:
 *           type: integer
 *         skipped:
 *           type: integer
 *         members:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/TagOrderGroupMember'
 *     TagOrderGroups:
 *       type: object
 *       properties:
 *         groups:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/TagOrderGroup'
 *         tags:
 *           type: integer
 *           description: proposals in total
 *         open:
 *           type: integer
 *         accepted:
 *           type: integer
 *         applied:
 *           type: integer
 *         skipped:
 *           type: integer
 *     TagOrderProposeRequest:
 *       type: object
 *       properties:
 *         vocabulary:
 *           type: string
 *           enum: [propose, keep]
 *           default: propose
 *           description: propose lets the model build the vocabulary from the tag names; keep uses the saved one
 *     TagGroupDecisionRequest:
 *       type: object
 *       required:
 *         - decision
 *       properties:
 *         decision:
 *           type: string
 *           enum: [accept, skip, reopen]
 *     TagOrderApplyRequest:
 *       type: object
 *       properties:
 *         groupKey:
 *           type: string
 *           nullable: true
 *           description: apply the accepted members of one group; omitted, every accepted proposal is applied
 *     TagOrderApplyResult:
 *       type: object
 *       properties:
 *         applied:
 *           type: array
 *           description: splits and deletes, as TagSplitApplyResult.applied lists them
 *           items:
 *             type: object
 *         merged:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               tagId:
 *                 type: integer
 *               tagName:
 *                 type: string
 *               targetId:
 *                 type: integer
 *               targetName:
 *                 type: string
 *               logId:
 *                 type: integer
 *               documentsUpdated:
 *                 type: integer
 *         failed:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               tagId:
 *                 type: integer
 *               tagName:
 *                 type: string
 *               error:
 *                 type: string
 *         stopped:
 *           type: boolean
 *     TagSplitImpact:
 *       type: object
 *       description: What applying one proposal would do to the documents of the tag
 *       properties:
 *         tagId:
 *           type: integer
 *         tagName:
 *           type: string
 *         documents:
 *           type: integer
 *           description: documents that carry the tag and would get the topics
 *         withType:
 *           type: integer
 *           description: documents that carry any document type today
 *         withDifferentType:
 *           type: integer
 *           description: documents whose type differs from the proposed one
 *         typeId:
 *           type: integer
 *           nullable: true
 *           description: the proposed type's id in Paperless-ngx, null when it does not exist yet
 *         typeSet:
 *           type: integer
 *           description: documents whose document type the apply would set
 *         typeKept:
 *           type: integer
 *           description: documents that would keep a differing type (0 with overwriteType)
 *
 *     TagSplitApplyRequest:
 *       type: object
 *       required: [tagIds]
 *       properties:
 *         tagIds:
 *           type: array
 *           items:
 *             type: integer
 *           description: proposals to apply, by tag id; at most 200 per call
 *     TagSplitApplyResult:
 *       type: object
 *       properties:
 *         applied:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               tagId:
 *                 type: integer
 *               tagName:
 *                 type: string
 *               action:
 *                 type: string
 *                 enum: [split, delete]
 *                 description: a delete is a split with no targets; the documents lose the tag
 *               logId:
 *                 type: integer
 *               documentsUpdated:
 *                 type: integer
 *               typeSet:
 *                 type: integer
 *                 description: documents whose document type was set
 *               typeKept:
 *                 type: integer
 *                 description: documents that kept a differing document type
 *         failed:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               tagId:
 *                 type: integer
 *               tagName:
 *                 type: string
 *               error:
 *                 type: string
 *     EntityMergeDismissRequest:
 *       type: object
 *       required:
 *         - kind
 *         - ids
 *       properties:
 *         kind:
 *           type: string
 *           enum: [tags, correspondents]
 *         ids:
 *           type: array
 *           description: every pair among these ids is stored as "not a duplicate"
 *           items:
 *             type: integer
 *           minItems: 2
 *         names:
 *           type: object
 *           description: optional id -> name map, stored with the pairs so the list stays readable
 *           additionalProperties:
 *             type: string
 *           example: { "12": "Amazon", "48": "amazon" }
 *
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
