const express = require('express');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const configFile = require('../config/config.js');
const { isAuthenticated } = require('./auth.js');
const { protectApiRoute } = require('../middleware/authGate');
const duplicateMergeService = require('../services/duplicateMergeService');
const entityNameMatcher = require('../services/entityNameMatcher');
const entityMatchAiService = require('../services/entityMatchAiService');
const tagSimplifyService = require('../services/tagSimplifyService');
const router = express.Router();

// ── Tidy up support: the few /api/duplicates and /api/simplify routes the ───
// Tidy up page (/tidy-up, routes/tidyUp.js) calls besides its own /api/tidy-up/*.
// Everything here runs on request only; nothing is scheduled and nothing
// touches the scan loop.

/** Who to record as the author of a merge or an undo. */
function duplicatesPerformedBy(req) {
  return req.user?.username || (req.user?.apiKey ? 'api-key' : null);
}

/** Maps a refusal from the merge service onto its HTTP status. */
function respondDuplicatesError(res, route, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  console.error(`[ERROR] ${route}:`, error?.message || error);
  return res.status(status).json({
    success: false,
    error: error?.message || 'Unexpected error',
  });
}

/** Reads an optional `kind` query parameter; throws the route's own 400. */
function readDuplicatesKind(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const kind = String(value);
  if (!entityNameMatcher.KIND_LIST.includes(kind)) {
    const error = new Error(`Unknown entity kind: ${kind}`);
    error.status = 400;
    throw error;
  }
  return kind;
}

/**
 * @swagger
 * /duplicates:
 *   get:
 *     summary: Former Duplicates page, now part of Tidy up
 *     description: |
 *       The Duplicates page was replaced by Tidy up (`/tidy-up`); this path
 *       redirects there permanently so bookmarks keep working.
 *     tags:
 *       - Navigation
 *       - Duplicates
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       301:
 *         description: Moved permanently to /tidy-up
 *       401:
 *         description: Not authenticated
 */
router.get('/duplicates', protectApiRoute, (req, res) =>
  res.redirect(301, '/tidy-up')
);

/**
 * @swagger
 * /api/duplicates/ai-review/memory:
 *   delete:
 *     summary: Forget every remembered verdict of the AI judge
 *     description: |
 *       The judge remembers what it decided about a pair of names for
 *       DUPLICATES_AI_VERDICT_MEMORY_DAYS, so the next review only asks about
 *       what is new. This empties that memory, which makes the next review ask
 *       about everything again — the thing to do after the model changed or
 *       after a verdict turned out to be wrong.
 *
 *       Local only: nothing in Paperless-ngx is touched, and no merge is
 *       undone or repeated.
 *     tags:
 *       - Duplicates
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: The memory is empty
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     removed:
 *                       type: integer
 *                       description: verdicts that were forgotten
 *                 message:
 *                   type: string
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.delete(
  '/api/duplicates/ai-review/memory',
  isAuthenticated,
  async (req, res) => {
    try {
      // The judge owns the memory and clears its own in-process caches with
      // it; without that method the table is the whole memory there is.
      const answer =
        typeof entityMatchAiService.forgetVerdicts === 'function'
          ? await entityMatchAiService.forgetVerdicts()
          : await documentModel.clearAiPairVerdicts();
      const removed =
        answer && typeof answer === 'object'
          ? Number(answer.removed) || 0
          : Number(answer) || 0;
      return res.json({
        success: true,
        data: { removed },
        message:
          removed > 0
            ? `${removed} remembered verdict(s) forgotten.`
            : 'There was nothing to forget.',
      });
    } catch (error) {
      return respondDuplicatesError(
        res,
        'DELETE /api/duplicates/ai-review/memory',
        error
      );
    }
  }
);

/**
 * @swagger
 * /api/duplicates/dismissals:
 *   get:
 *     summary: List the pairs marked as "not a duplicate"
 *     tags:
 *       - Duplicates
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: kind
 *         schema:
 *           type: string
 *           enum: [tags, correspondents]
 *     responses:
 *       200:
 *         description: Dismissed pairs, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/EntityMergeDismissal'
 *       400:
 *         description: Unknown kind
 *       401:
 *         description: Not authenticated
 */
router.get('/api/duplicates/dismissals', isAuthenticated, async (req, res) => {
  try {
    const kind = readDuplicatesKind(req.query.kind);
    const data = await documentModel.listEntityMergeDismissals(kind);
    return res.json({ success: true, data });
  } catch (error) {
    return respondDuplicatesError(res, 'GET /api/duplicates/dismissals', error);
  }
});

/**
 * @swagger
 * /api/duplicates/dismissals/{id}:
 *   delete:
 *     summary: Restore a pair marked as "not a duplicate"
 *     description: The pair is offered by the scan again from the next run on.
 *     tags:
 *       - Duplicates
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Pair restored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid id
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Unknown pair
 */
router.delete(
  '/api/duplicates/dismissals/:id',
  isAuthenticated,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid dismissal id' });
      }
      const removed = await documentModel.removeEntityMergeDismissal(id);
      if (!removed) {
        return res
          .status(404)
          .json({ success: false, error: `Dismissal ${id} does not exist` });
      }
      return res.json({
        success: true,
        message: 'The pair is offered again from the next scan on.',
      });
    } catch (error) {
      return respondDuplicatesError(
        res,
        'DELETE /api/duplicates/dismissals/:id',
        error
      );
    }
  }
);

/**
 * @swagger
 * /api/duplicates/log/{id}/undo:
 *   post:
 *     summary: Undo a logged merge
 *     description: |
 *       Re-creates every source the merge deleted — a same-named object that
 *       exists again is adopted instead — and hands back the documents that
 *       still carry the target. Documents that were changed since the merge
 *       are counted as skipped and left alone. The re-created objects get new
 *       ids in Paperless-ngx.
 *
 *       The answer carries `success: false` with status 200 when at least one
 *       source could not be restored.
 *     tags:
 *       - Duplicates
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: id of the merge log entry
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Undo finished (completely or partially)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/EntityMergeUndoResult'
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid id
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Unknown merge
 *       409:
 *         description: Already undone, or a document scan is running
 *       502:
 *         description: Paperless-ngx could not be reached
 */
router.post(
  '/api/duplicates/log/:id/undo',
  isAuthenticated,
  async (req, res) => {
    try {
      const mergeId = parseInt(req.params.id, 10);
      if (!Number.isInteger(mergeId) || mergeId <= 0) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid merge id' });
      }

      const data = await duplicateMergeService.undo(mergeId, {
        performedBy: duplicatesPerformedBy(req),
      });
      const restored = data.sources.filter(
        (source) => source.restoredId != null
      ).length;
      const documents = data.sources.reduce(
        (sum, source) => sum + source.documentsRestored,
        0
      );
      const message =
        data.status === 'undone'
          ? `${restored} entr${restored === 1 ? 'y' : 'ies'} restored, ${documents} document(s) moved back.`
          : `Only ${restored} of ${data.sources.length} entries could be restored. The rest is listed with its reason.`;

      return res.json({
        success: data.status !== 'undo_failed',
        data,
        message,
      });
    } catch (error) {
      return respondDuplicatesError(
        res,
        'POST /api/duplicates/log/:id/undo',
        error
      );
    }
  }
);

/**
 * @swagger
 * /api/duplicates/ai-review/estimate:
 *   get:
 *     summary: What the next AI review would cost, before it starts
 *     description: |
 *       Answers the question the page asks before it spends anything: how
 *       many requests, how many tokens, how long. Nothing here asks a model
 *       and nothing scans — the page calls this again on every move of a
 *       lever, so it may only read what is already there.
 *
 *       A scan is a walk over every tag and every correspondent of the
 *       archive, so this never starts one. It answers from the scan the merge
 *       service still holds for these options, and when there is none it
 *       answers `needsScan: true` with `items: 0` and `basis: "guess"` — the
 *       page then says "scan first, then I can tell you" instead of showing a
 *       number nobody measured.
 *
 *       `basis` says where the numbers come from: `run` a finished review of
 *       this archive, `model` what the judge measured about this model,
 *       `guess` neither. `requests` is the judging pass alone; `extra` names
 *       what comes on top — the requests a semantic sweep would add, and the
 *       entities whose documents would be read for excerpts, which are reads
 *       of Paperless-ngx rather than model requests.
 *
 *       `items` counts the pairs of the scan's groups that the model would be
 *       asked about. A review that also asks about the candidate band asks
 *       about more: the band needs the entity list, and reading it is exactly
 *       the cost this endpoint exists to avoid.
 *     tags:
 *       - Duplicates
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: kind
 *         schema:
 *           type: string
 *           enum: [tags, correspondents, all]
 *         description: What the review would look at; `all` by default
 *       - in: query
 *         name: threshold
 *         schema:
 *           type: number
 *           minimum: 0
 *           maximum: 1
 *         description: The sensitivity the scan was made with
 *       - in: query
 *         name: sweep
 *         schema:
 *           type: integer
 *           enum: [0, 1]
 *         description: The semantic sweep is on
 *       - in: query
 *         name: excerpts
 *         schema:
 *           type: integer
 *           enum: [0, 1]
 *         description: Document excerpts are read as evidence
 *     responses:
 *       200:
 *         description: What the review would cost
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   allOf:
 *                     - $ref: '#/components/schemas/AiRunEstimate'
 *                     - type: object
 *                       properties:
 *                         model:
 *                           type: string
 *                           nullable: true
 *                         thinking:
 *                           type: boolean
 *                         groups:
 *                           type: integer
 *                           description: scan groups the review would judge
 *                         pairs:
 *                           type: integer
 *                           description: |
 *                             every pair of those groups — what the model is
 *                             asked about plus what a spelling rule settled
 *                         needsScan:
 *                           type: boolean
 *                           description: no cached scan answers for these options
 *                         extra:
 *                           type: object
 *                           properties:
 *                             sweepRequests:
 *                               type: integer
 *                             excerptReads:
 *                               type: integer
 *       400:
 *         description: Unknown kind, or a threshold outside [0, 1]
 *       401:
 *         description: Not authenticated
 *       503:
 *         description: |
 *           The AI review is switched off (DUPLICATES_AI_REVIEW), or no AI
 *           provider is configured; the message names which of the two
 *       500:
 *         description: Server error
 */
router.get(
  '/api/duplicates/ai-review/estimate',
  isAuthenticated,
  async (req, res) => {
    try {
      const kind = String(req.query.kind || duplicateMergeService.KIND_ALL);
      const knownKinds = [
        duplicateMergeService.KIND_ALL,
        ...entityNameMatcher.KIND_LIST,
      ];
      if (!knownKinds.includes(kind)) {
        return res
          .status(400)
          .json({ success: false, error: `Unknown entity kind: ${kind}` });
      }
      const rawThreshold = req.query.threshold;
      const threshold =
        rawThreshold === undefined || rawThreshold === ''
          ? entityNameMatcher.DEFAULT_THRESHOLD
          : Number(rawThreshold);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        return res.status(400).json({
          success: false,
          error: 'threshold must be a number between 0 and 1',
        });
      }

      const refusal = aiReviewRefusal();
      if (refusal) {
        return res.status(503).json({ success: false, error: refusal });
      }

      const data = await entityMatchAiService.estimateReview({
        kind,
        threshold,
        sweep: readQueryFlag(req.query.sweep, false),
        excerpts: readQueryFlag(req.query.excerpts, true),
      });
      return res.json({ success: true, data });
    } catch (error) {
      return respondDuplicatesError(
        res,
        'GET /api/duplicates/ai-review/estimate',
        error
      );
    }
  }
);

/**
 * Why the estimate may not be answered, or null when it may.
 *
 * The page hides its model-backed buttons when the feature is off, so this
 * is the belt rather than the braces — but it has to name which of the two it
 * is, because "switch it on" and "configure a provider" are different things
 * to do.
 *
 * @returns {string|null}
 */
function aiReviewRefusal() {
  // The same reading the judge uses: `Boolean('no')` is true, which is the
  // trap this spelling exists to avoid.
  const on =
    configFile.duplicatesAiReview === true ||
    String(configFile.duplicatesAiReview ?? '')
      .trim()
      .toLowerCase() === 'yes';
  if (!on) {
    return 'The AI review is switched off (DUPLICATES_AI_REVIEW)';
  }
  if (!configFile.aiProvider) {
    return 'No AI provider is configured';
  }
  return null;
}

/**
 * Reads a `0`/`1` query flag the estimate endpoint uses for its
 * switches. Absent is the default the caller names, not `false`: an estimate
 * that quietly turned the excerpts off would promise a cheaper run than the
 * one the button starts.
 *
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function readQueryFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

// ── Simplify tags: the vocabulary the Tidy up page edits ────────────────────

/** Entries one dimension of the vocabulary may hold. */
const MAX_VOCABULARY_ENTRIES = 200;

/** A vocabulary name is a name; Paperless-ngx stops well before this. */
const MAX_VOCABULARY_NAME_LENGTH = 128;

/** The route's own 400, worded like the ones of the Duplicates block. */
function simplifyBadRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * Reads one dimension of a TagVocabularyRequest: a list of names, trimmed,
 * blanks dropped. Anything that is not a list of short strings is the route's
 * own 400 rather than something the service has to guess about.
 *
 * @param {unknown} value
 * @param {string} field  the name the refusal quotes
 * @returns {string[]}
 */
function readVocabularyNames(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw simplifyBadRequest(`${field} must be an array of names`);
  }
  if (value.length > MAX_VOCABULARY_ENTRIES) {
    throw simplifyBadRequest(
      `${field} must not hold more than ${MAX_VOCABULARY_ENTRIES} names`
    );
  }
  const names = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw simplifyBadRequest(`every entry of ${field} must be a string`);
    }
    const name = entry.trim();
    if (name.length > MAX_VOCABULARY_NAME_LENGTH) {
      throw simplifyBadRequest(
        `every name of ${field} must be at most ${MAX_VOCABULARY_NAME_LENGTH} characters`
      );
    }
    if (name !== '') names.push(name);
  }
  return names;
}

/**
 * @swagger
 * /simplify:
 *   get:
 *     summary: Former Simplify tags page, now part of Tidy up
 *     description: |
 *       The Simplify tags page was replaced by Tidy up (`/tidy-up`), where
 *       splitting compound tags is one option of a run; this path redirects
 *       there permanently.
 *     tags:
 *       - Navigation
 *       - Simplify
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       301:
 *         description: Moved permanently to /tidy-up
 *       401:
 *         description: Not authenticated
 */
router.get('/simplify', protectApiRoute, (req, res) =>
  res.redirect(301, '/tidy-up')
);

/**
 * @swagger
 * /api/simplify/vocabulary:
 *   get:
 *     summary: The target vocabulary of document types and topic tags
 *     description: |
 *       The couple of dozen concepts the archive should end up with, in the
 *       order the user put them in. Local only: these are names, not objects
 *       in Paperless-ngx — an entry gets its `paperlessId` when a split first
 *       needs the object.
 *     tags:
 *       - Simplify
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: The stored vocabulary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/TagVocabulary'
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 *   put:
 *     summary: Replace the target vocabulary
 *     description: |
 *       Stores the vocabulary as the user edited it: names only, the order
 *       kept, blanks and repeats dropped. The ids a name already has in
 *       Paperless-ngx survive the save. A list that is not a list of at most
 *       200 names of at most 128 characters each is refused with 400.
 *     tags:
 *       - Simplify
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TagVocabularyRequest'
 *     responses:
 *       200:
 *         description: What was stored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/TagVocabulary'
 *                 message:
 *                   type: string
 *       400:
 *         description: A list is too long, or holds something that is not a name
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get('/api/simplify/vocabulary', isAuthenticated, async (req, res) => {
  try {
    const data = await tagSimplifyService.getVocabulary();
    return res.json({ success: true, data });
  } catch (error) {
    return respondDuplicatesError(res, 'GET /api/simplify/vocabulary', error);
  }
});

router.put('/api/simplify/vocabulary', isAuthenticated, async (req, res) => {
  try {
    const body = req.body || {};
    const types = readVocabularyNames(body.types, 'types');
    const topics = readVocabularyNames(body.topics, 'topics');
    const data = await tagSimplifyService.saveVocabulary({ types, topics });
    return res.json({
      success: true,
      data,
      message: `Vocabulary saved: ${data.types.length} document type(s), ${data.topics.length} topic(s).`,
    });
  } catch (error) {
    return respondDuplicatesError(res, 'PUT /api/simplify/vocabulary', error);
  }
});

/**
 * @swagger
 * /api/simplify/document-types:
 *   get:
 *     summary: The document types Paperless-ngx already has
 *     description: |
 *       What the "Document type" field of the vocabulary offers. Read-only and
 *       cached: the list is refreshed when it is empty, when it is older than
 *       TAG_CACHE_TTL_SECONDS or when `fresh` asks for it, and every write
 *       that creates or deletes a document type empties it, so a type a split
 *       just created is listed at once.
 *
 *       `inVocabulary` says which of them the saved vocabulary already holds;
 *       the page marks those rows and does not add them a second time.
 *     tags:
 *       - Simplify
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: fresh
 *         required: false
 *         description: 1, true or yes reads past the cache
 *         schema:
 *           type: string
 *           example: '1'
 *     responses:
 *       200:
 *         description: The document types, sorted by name
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     types:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TagVocabularyDocumentType'
 *                     total:
 *                       type: integer
 *                       example: 8
 *                     cachedAt:
 *                       type: string
 *                       nullable: true
 *                       format: date-time
 *                       description: When the cached list was built; null while nothing was read yet
 *       401:
 *         description: Not authenticated
 *       502:
 *         description: Paperless-ngx could not be reached
 */
router.get(
  '/api/simplify/document-types',
  isAuthenticated,
  async (req, res) => {
    try {
      const fresh = ['1', 'true', 'yes'].includes(
        String(req.query.fresh ?? '').toLowerCase()
      );
      const records = await paperlessService.listDocumentTypesCached({ fresh });
      const vocabulary = await tagSimplifyService.getVocabulary();
      // Names are case sensitive in Paperless-ngx, so "Rechnung" and
      // "rechnung" are two types and only one of them is in the vocabulary.
      const known = new Set(vocabulary.types.map((row) => String(row.name)));
      const types = records
        .map((record) => ({
          id: Number(record.id),
          name: String(record.name ?? ''),
          documentCount: Number(record.documentCount) || 0,
          inVocabulary: known.has(String(record.name ?? '')),
        }))
        .sort((a, b) => {
          const byName = a.name.localeCompare(b.name, undefined, {
            sensitivity: 'base',
          });
          // Two names that differ only in case compare equal; the id then
          // decides, so the same instance always answers in the same order.
          return byName !== 0 ? byName : a.id - b.id;
        });
      const filledAt = paperlessService.documentTypeCacheFilledAt();
      return res.json({
        success: true,
        data: {
          types,
          total: types.length,
          cachedAt: filledAt ? new Date(filledAt).toISOString() : null,
        },
      });
    } catch (error) {
      // paperlessService throws what axios threw, which carries no status of
      // its own; the page must be able to tell "unreachable" from "broken".
      const failure = Number.isInteger(error?.status)
        ? error
        : Object.assign(
            new Error(
              `Paperless-ngx could not be reached while listing the document types: ${
                error?.message || 'unknown error'
              }`
            ),
            { status: 502 }
          );
      return respondDuplicatesError(
        res,
        'GET /api/simplify/document-types',
        failure
      );
    }
  }
);

module.exports = router;
