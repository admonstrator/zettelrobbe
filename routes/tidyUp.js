'use strict';

/**
 * The Tidy up page and its API.
 *
 * One page replaces /duplicates and /simplify: it shows suggestions (merge
 * two names, split a compound tag, delete unused names), each a sentence
 * with a reason, and the person accepts or declines. The heavy lifting stays
 * where it is — entityNameMatcher, entityMatchAiService,
 * duplicateReviewJobService, duplicateMergeService, tagSimplifyService — this
 * router only runs them as one job and presents the result as suggestions
 * (services/tidyUpSuggestions.js, services/tidyUpWording.js).
 *
 * The run, its suggestions and the decisions live in
 * services/tidyUpRunService.js; the handlers here read the request, call it
 * and answer in the shapes of schemas.js (TidyUpRun, TidyUpSuggestion,
 * TidyUpFailure, TidyUpSummary).
 *
 * API, all under isAuthenticated (session cookie or API key):
 *
 *   GET  /tidy-up                         the page
 *   GET  /duplicates, GET /simplify       301 → /tidy-up (in routes/setup.js)
 *   POST /api/tidy-up/runs                start a run {askModel, suggestSplits, kind}
 *   GET  /api/tidy-up/runs/current        the running or last run (TidyUpRun), 204 when none
 *   GET  /api/tidy-up/runs/:id            one run
 *   GET  /api/tidy-up/runs/:id/events     SSE: run snapshots as they change
 *   POST /api/tidy-up/runs/:id/stop       stop, keep what was found
 *   GET  /api/tidy-up/suggestions         the suggestions of the current run + summary
 *   POST /api/tidy-up/suggestions/decide  {ids, decision: accept|decline|later, edits?}
 *   POST /api/tidy-up/suggestions/undo    {batchId} undo everything a decide call did
 *   GET  /api/tidy-up/recent              recent changes with undo (merge log, newest first)
 */

const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('./auth');
const config = require('../config/config');
const tidyUpRunService = require('../services/tidyUpRunService');

/** How often an open event stream writes a comment line to stay open. */
const KEEP_ALIVE_MS = 15 * 1000;

/** Answers a refusal of the run service with its status, anything else 500. */
function respondError(res, route, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  // A 501 is a sentence for the person, not a fault of the server.
  if (status >= 500 && status !== 501)
    console.error(`[ERROR] ${route}:`, error?.message || error);
  return res.status(status).json({
    success: false,
    error: error?.message || 'Unexpected error',
    ...(error?.data !== undefined
      ? { data: error.data }
      : error?.run
        ? { data: error.run }
        : {}),
  });
}

/** The run of a path id, or the 404 answered; null when it was. */
function findRun(res, id) {
  const run = tidyUpRunService.get(id);
  if (!run) {
    res
      .status(404)
      .json({ success: false, error: 'This run is unknown or has expired' });
    return null;
  }
  return run;
}

/**
 * @swagger
 * /tidy-up:
 *   get:
 *     summary: The Tidy up page
 *     tags: [Tidy up]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: HTML
 */
router.get('/tidy-up', isAuthenticated, async (req, res) => {
  try {
    // modelAvailable: whether the model paths are offered at all (a run
    // never asks the model unless the person ticks it); modelLabel,
    // splitsAvailable, counts {tags, correspondents} and lastRun
    // {when, accepted}|null. Paperless-ngx being unreachable shows zeros.
    const locals = await tidyUpRunService.pageLocals();
    return res.render('tidy-up', {
      version: config.PAPERLESS_AI_VERSION || ' ',
      ...locals,
    });
  } catch (error) {
    console.error('[ERROR] GET /tidy-up:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/tidy-up/runs:
 *   post:
 *     summary: Start a Tidy up run
 *     description: |
 *       Compares every name by spelling, optionally asks the model about the
 *       pairs spelling cannot settle and about compound tags, and turns the
 *       result into suggestions. One run at a time (409 while one runs).
 *     tags: [Tidy up, API]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TidyUpRunRequest'
 *     responses:
 *       202:
 *         description: The run, started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/TidyUpRun' }
 *       400:
 *         description: A field of the request has the wrong type or value
 *       409:
 *         description: |
 *           A run is already going (`data` is that run), or another clean-up
 *           job of the old pages is running (`data` absent)
 *       501:
 *         description: The `action` (retry-larger, test-connection) is not wired up yet; `error` says what to do instead
 */
router.post('/api/tidy-up/runs', isAuthenticated, (req, res) => {
  try {
    const run = tidyUpRunService.start(req.body || {});
    return res
      .status(202)
      .json({ success: true, data: tidyUpRunService.toJSON(run) });
  } catch (error) {
    return respondError(res, 'POST /api/tidy-up/runs', error);
  }
});

/**
 * @swagger
 * /api/tidy-up/runs/current:
 *   get:
 *     summary: The running or most recent run
 *     tags: [Tidy up, API]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: The run
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/TidyUpRun' }
 *       204:
 *         description: No run yet
 */
router.get('/api/tidy-up/runs/current', isAuthenticated, (req, res) => {
  try {
    const run = tidyUpRunService.current();
    if (!run) return res.status(204).end();
    tidyUpRunService.touch(run);
    return res.json({ success: true, data: tidyUpRunService.toJSON(run) });
  } catch (error) {
    return respondError(res, 'GET /api/tidy-up/runs/current', error);
  }
});

/**
 * @swagger
 * /api/tidy-up/runs/{id}:
 *   get:
 *     summary: One run
 *     tags: [Tidy up, API]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The run
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/TidyUpRun' }
 *       404:
 *         description: Unknown or expired run
 */
router.get('/api/tidy-up/runs/:id', isAuthenticated, (req, res) => {
  try {
    const run = findRun(res, req.params.id);
    if (!run) return undefined;
    tidyUpRunService.touch(run);
    return res.json({ success: true, data: tidyUpRunService.toJSON(run) });
  } catch (error) {
    return respondError(res, 'GET /api/tidy-up/runs/:id', error);
  }
});

/**
 * @swagger
 * /api/tidy-up/runs/{id}/events:
 *   get:
 *     summary: Run snapshots as server-sent events
 *     description: |
 *       Each event is `data: <TidyUpRun as JSON>`, at most four a second;
 *       the stream ends after the event whose status is done, stopped or
 *       failed. A run that is already over sends that one event at once.
 *       Following the stream counts as watching the run (the idle stop).
 *       While the run is going, a decide or undo call also sends a snapshot
 *       whenever its `activity` changes (same event, the `activity` field).
 *     tags: [Tidy up, API]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: text/event-stream
 *       404:
 *         description: Unknown or expired run
 */
router.get('/api/tidy-up/runs/:id/events', isAuthenticated, (req, res) => {
  const run = findRun(res, req.params.id);
  if (!run) return undefined;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });

  let ended = false;
  let heartbeat = null;
  let unfollow = () => {};
  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unfollow();
  };
  // At most four snapshots a second; the last one (done, stopped or failed)
  // is sent at once and ends the stream.
  unfollow = tidyUpRunService.follow(req.params.id, (snapshot, final) => {
    if (ended) return;
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    if (res.flush) res.flush();
    if (!final) return;
    ended = true;
    cleanup();
    res.end();
  });

  heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
    if (res.flush) res.flush();
  }, KEEP_ALIVE_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  req.on('close', () => {
    if (ended) return;
    ended = true;
    cleanup();
  });
  return undefined;
});

/**
 * @swagger
 * /api/tidy-up/runs/{id}/stop:
 *   post:
 *     summary: Stop a run and keep what was found
 *     tags: [Tidy up, API]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The run, stopping or stopped
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/TidyUpRun' }
 *       404:
 *         description: Unknown or expired run
 */
router.post('/api/tidy-up/runs/:id/stop', isAuthenticated, (req, res) => {
  try {
    if (!findRun(res, req.params.id)) return undefined;
    const run = tidyUpRunService.stop(req.params.id);
    return res.json({ success: true, data: tidyUpRunService.toJSON(run) });
  } catch (error) {
    return respondError(res, 'POST /api/tidy-up/runs/:id/stop', error);
  }
});

/**
 * @swagger
 * /api/tidy-up/suggestions:
 *   get:
 *     summary: The suggestions of the current run
 *     tags: [Tidy up, API]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Suggestions and their summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     runId: { type: string, nullable: true }
 *                     summary: { $ref: '#/components/schemas/TidyUpSummary' }
 *                     suggestions:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/TidyUpSuggestion' }
 *                     activity:
 *                       allOf:
 *                         - $ref: '#/components/schemas/TidyUpActivity'
 *                       nullable: true
 *                       description: what a decide or undo call is writing right now; null when idle
 */
router.get('/api/tidy-up/suggestions', isAuthenticated, (req, res) => {
  try {
    return res.json({ success: true, data: tidyUpRunService.suggestionsOf() });
  } catch (error) {
    return respondError(res, 'GET /api/tidy-up/suggestions', error);
  }
});

/**
 * @swagger
 * /api/tidy-up/suggestions/decide:
 *   post:
 *     summary: Accept, decline or postpone suggestions
 *     description: |
 *       `accept` carries the change out at once (merge, split, delete) and
 *       returns each suggestion as done or failed with its outcome; `decline`
 *       records a "not the same" so later runs leave the pair alone (for a
 *       split or delete: hides it for this run); `later` hides it for this
 *       run. `edits` lets a split's type or topics, or a merge's surviving
 *       name, be changed before accepting.
 *     tags: [Tidy up, API]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TidyUpDecisionRequest'
 *     responses:
 *       200:
 *         description: The suggestions after the decision, and a batch id for undo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     batchId: { type: string, nullable: true }
 *                     summary: { $ref: '#/components/schemas/TidyUpSummary' }
 *                     suggestions:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/TidyUpSuggestion' }
 *       400:
 *         description: ids missing or empty, or an unknown decision
 *       404:
 *         description: No run yet, or an id that is not a suggestion of it
 *       409:
 *         description: |
 *           Something is already being written. `data.activity` is what this
 *           page's decide or undo call is doing (TidyUpActivity); it is null
 *           when another request (a merge from the API or an older page)
 *           holds Paperless-ngx, and `error` says so.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 error: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     activity:
 *                       allOf:
 *                         - $ref: '#/components/schemas/TidyUpActivity'
 *                       nullable: true
 */
router.post(
  '/api/tidy-up/suggestions/decide',
  isAuthenticated,
  async (req, res) => {
    try {
      const data = await tidyUpRunService.decide(req.body || {}, req.user);
      return res.json({ success: true, data });
    } catch (error) {
      return respondError(res, 'POST /api/tidy-up/suggestions/decide', error);
    }
  }
);

/**
 * @swagger
 * /api/tidy-up/suggestions/undo:
 *   post:
 *     summary: Undo everything one decide call changed
 *     tags: [Tidy up, API]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [batchId]
 *             properties:
 *               batchId: { type: string }
 *     responses:
 *       200:
 *         description: |
 *           What was undone. `success` is false when an entry could not be
 *           undone completely; it is listed in `failed` and the batch stays.
 *           The suggestions it covered are open again, with the ids of the
 *           re-created names.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     batchId: { type: string }
 *                     undone:
 *                       type: array
 *                       items: { type: string }
 *                       description: merge-log ids that were undone
 *                     failed:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           undoId: { type: string }
 *                           error: { type: string }
 *                     summary: { $ref: '#/components/schemas/TidyUpSummary' }
 *                     suggestions:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/TidyUpSuggestion' }
 *       400:
 *         description: batchId missing
 *       404:
 *         description: Unknown batch, or one that was already undone
 *       409:
 *         description: |
 *           Something is already being written. `data.activity` is what this
 *           page's decide or undo call is doing (TidyUpActivity); it is null
 *           when another request (a merge from the API or an older page)
 *           holds Paperless-ngx, and `error` says so.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 error: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     activity:
 *                       allOf:
 *                         - $ref: '#/components/schemas/TidyUpActivity'
 *                       nullable: true
 */
router.post(
  '/api/tidy-up/suggestions/undo',
  isAuthenticated,
  async (req, res) => {
    try {
      const data = await tidyUpRunService.undo(req.body || {}, req.user);
      return res.json({ success: data.failed.length === 0, data });
    } catch (error) {
      return respondError(res, 'POST /api/tidy-up/suggestions/undo', error);
    }
  }
);

/**
 * @swagger
 * /api/tidy-up/recent:
 *   get:
 *     summary: Recent changes with their undo
 *     tags: [Tidy up, API]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Merge-log entries, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/TidyUpRecentChange' }
 */
router.get('/api/tidy-up/recent', isAuthenticated, async (req, res) => {
  try {
    return res.json({ success: true, data: await tidyUpRunService.recent() });
  } catch (error) {
    return respondError(res, 'GET /api/tidy-up/recent', error);
  }
});

module.exports = router;
