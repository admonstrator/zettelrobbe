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
 * The contract below is complete; handlers marked NOT IMPLEMENTED answer
 * 501 until the run service lands. The page codes against the shapes in
 * schemas.js (TidyUpRun, TidyUpSuggestion, TidyUpFailure, TidyUpSummary).
 *
 * API, all under isAuthenticated (session cookie or API key):
 *
 *   GET  /tidy-up                         the page
 *   GET  /duplicates, GET /simplify       301 → /tidy-up
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

const NOT_IMPLEMENTED = (res) =>
  res
    .status(501)
    .json({ success: false, error: 'Tidy up is not wired up yet' });

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
    return res.render('tidy-up', {
      version: config.PAPERLESS_AI_VERSION || ' ',
      // Whether the model paths are offered at all; a run never asks the
      // model unless the person ticks it.
      modelAvailable: false,
      modelLabel: '',
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
 *       409:
 *         description: A run is already going
 */
router.post('/api/tidy-up/runs', isAuthenticated, (req, res) =>
  NOT_IMPLEMENTED(res)
);

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
router.get('/api/tidy-up/runs/current', isAuthenticated, (req, res) =>
  NOT_IMPLEMENTED(res)
);

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
router.get('/api/tidy-up/runs/:id', isAuthenticated, (req, res) =>
  NOT_IMPLEMENTED(res)
);

/**
 * @swagger
 * /api/tidy-up/runs/{id}/events:
 *   get:
 *     summary: Run snapshots as server-sent events
 *     description: |
 *       Each event is `data: <TidyUpRun as JSON>`; the stream ends after the
 *       event whose status is done, stopped or failed.
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
 */
router.get('/api/tidy-up/runs/:id/events', isAuthenticated, (req, res) =>
  NOT_IMPLEMENTED(res)
);

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
 */
router.post('/api/tidy-up/runs/:id/stop', isAuthenticated, (req, res) =>
  NOT_IMPLEMENTED(res)
);

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
 */
router.get('/api/tidy-up/suggestions', isAuthenticated, (req, res) =>
  NOT_IMPLEMENTED(res)
);

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
 */
router.post('/api/tidy-up/suggestions/decide', isAuthenticated, (req, res) =>
  NOT_IMPLEMENTED(res)
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
 *         description: What was undone
 */
router.post('/api/tidy-up/suggestions/undo', isAuthenticated, (req, res) =>
  NOT_IMPLEMENTED(res)
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
router.get('/api/tidy-up/recent', isAuthenticated, (req, res) =>
  NOT_IMPLEMENTED(res)
);

module.exports = router;
