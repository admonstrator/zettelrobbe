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
 *         message:
 *           type: string
 *           description: Additional status information (for non-healthy states)
 *           example: "Document scan failed 3 time(s) in a row: connect ECONNREFUSED 172.18.0.2:8000"
 *         scanner:
 *           $ref: '#/components/schemas/ScannerHealth'
 *         paperless:
 *           $ref: '#/components/schemas/PaperlessHealth'
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
 */

// This file only contains JSDoc comments for Swagger schema definitions
// No actual code is needed
