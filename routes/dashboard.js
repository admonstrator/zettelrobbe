'use strict';

/**
 * The dashboard: the page, its statistics, the document detail view and the
 * stored layout.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   GET   /dashboard              Main dashboard page
 *   GET   /api/dashboard/stats
 *   GET   /dashboard/doc/:id
 *   GET   /api/dashboard/layout   Read the authenticated user's dashboard configuration
 *   PUT   /api/dashboard/layout   Store or reset the authenticated user's dashboard configuration
 */

const express = require('express');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const configFile = require('../config/config.js');
const dashboardWidgets = require('../config/dashboardWidgets.js');
const { isAuthenticated } = require('./auth.js');
const dashboardStatsService = require('../services/dashboardStatsService');
const router = express.Router();

/* Dashboard storage format v1.
   ---------------------------
   The dashboard sends back the boards the user arranged:

     {
       version: 1,
       active: 'default',
       dashboards: [
         {
           slug: 'default',
           name: 'Dashboard',
           widgets: [{ id: 'task-runner', span: 12, rows: 0, hidden: false }]
         }
       ]
     }

   This blob goes straight into users.dashboard_layout, so the validator below
   is the only thing between a hostile payload and the database. It rejects
   whole configurations rather than repairing them: a payload it cannot vouch
   for is a bug or an attack, and storing the salvageable half of either is
   worse than a 400.

   Widget and dashboard ids are deliberately not checked against a list. The
   dashboard adds and renames cards, and a stale server-side list would silently
   drop a card's placement; the shape, the spans and the counts are what has to
   be trustworthy. Anything the browser no longer knows is ignored when the
   layout is applied.

   Two conventions run through the whole format:

   - Absent means "use the defaults". No stored config, an empty dashboards
     list, and a dashboard without widgets all say the same thing: render the
     cards the way the server shipped them, in registry order.
   - active is a pointer, not data. A slug that no longer resolves — a deleted
     board, a stale client — falls back to the first dashboard instead of
     failing the write. The arrangement is the valuable part, and landing on
     board one beats losing it to a 400 over a name. */
const DASHBOARD_WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const DASHBOARD_MAX_WIDGETS = 50;

const DASHBOARD_MIN_SPAN = 3;

const DASHBOARD_GRID_COLUMNS = 12;

const DASHBOARD_MIN_ROWS = 3;

const DASHBOARD_MAX_ROWS = 24;

const DASHBOARD_CONFIG_VERSION = 1;

const DASHBOARD_MAX_BOARDS = 10;

const DASHBOARD_MAX_NAME_LENGTH = 60;

const DASHBOARD_DEFAULT_SLUG = 'default';

/* Nothing stored: a valid v1 config that asks for the defaults. */
function emptyDashboardConfig() {
  return {
    version: DASHBOARD_CONFIG_VERSION,
    active: DASHBOARD_DEFAULT_SLUG,
    dashboards: [],
  };
}

/* One board's cards, cleaned. Returns null — not a partial list — as soon as
   anything is off, so a single bad card takes the whole write down with it. */
function normalizeDashboardWidgets(input) {
  if (!Array.isArray(input)) {
    return null;
  }
  if (input.length > DASHBOARD_MAX_WIDGETS) {
    return null;
  }

  const seen = new Set();
  const widgets = [];
  for (const entry of input) {
    const id = String(entry?.id || '').trim();
    if (!DASHBOARD_WIDGET_ID.test(id) || seen.has(id)) {
      return null;
    }
    seen.add(id);

    // span and rows are parsed rather than compared: they are read off DOM
    // datasets in the browser, where everything is a string.
    const span = Number.parseInt(entry?.span, 10);
    if (
      !Number.isInteger(span) ||
      span < DASHBOARD_MIN_SPAN ||
      span > DASHBOARD_GRID_COLUMNS
    ) {
      return null;
    }

    // Tile rows. 0 means "as tall as the content needs", which is the default
    // and the only value outside the 3..24 range a card may carry.
    const rows = Number.parseInt(entry?.rows, 10) || 0;
    if (
      rows !== 0 &&
      (rows < DASHBOARD_MIN_ROWS || rows > DASHBOARD_MAX_ROWS)
    ) {
      return null;
    }

    // hidden is a toggle, not data: absent, null or anything falsy means the
    // card is shown. Nothing to reject here, so nothing does.
    widgets.push({ id, span, rows, hidden: Boolean(entry?.hidden) });
  }

  return widgets;
}

/* "Give me the defaults back" arrives in two shapes: no boards at all, or the
   single board the reset button empties. Both clear the stored config. More
   than one board is left alone — an empty board among several is a named view
   that happens to show the default cards, and dropping its name would be the
   opposite of what the user asked for. */
function isDashboardResetRequest(input) {
  if (!input || !Array.isArray(input.dashboards)) {
    return false;
  }
  if (input.dashboards.length === 0) {
    return true;
  }
  return (
    input.dashboards.length === 1 &&
    Array.isArray(input.dashboards[0]?.widgets) &&
    input.dashboards[0].widgets.length === 0
  );
}

function normalizeDashboardConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  // Strict: version is written by our own code, never typed into a form, so a
  // string '1' is a bug worth surfacing rather than a value worth coercing.
  if (input.version !== DASHBOARD_CONFIG_VERSION) {
    return null;
  }
  if (!Array.isArray(input.dashboards)) {
    return null;
  }
  if (
    input.dashboards.length < 1 ||
    input.dashboards.length > DASHBOARD_MAX_BOARDS
  ) {
    return null;
  }

  const slugs = new Set();
  const dashboards = [];
  for (const entry of input.dashboards) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }

    // Slugs are ids, so they answer to the widget-id rules: lowercase, no
    // markup, short enough to live in a URL.
    const slug = String(entry.slug || '').trim();
    if (!DASHBOARD_WIDGET_ID.test(slug) || slugs.has(slug)) {
      return null;
    }
    slugs.add(slug);

    // The name is what the user typed, so it is trimmed first and then has to
    // still say something. It is escaped where it is rendered, not here.
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name.length < 1 || name.length > DASHBOARD_MAX_NAME_LENGTH) {
      return null;
    }

    // A board without widgets is the default arrangement under a name, so a
    // missing list is the same as an empty one. A non-array is not.
    const widgets = normalizeDashboardWidgets(
      entry.widgets === undefined || entry.widgets === null ? [] : entry.widgets
    );
    if (!widgets) {
      return null;
    }

    dashboards.push({ slug, name, widgets });
  }

  const requested = String(input.active || '').trim();
  const active = slugs.has(requested) ? requested : dashboards[0].slug;

  return { version: DASHBOARD_CONFIG_VERSION, active, dashboards };
}

/**
 * @swagger
 * /dashboard:
 *   get:
 *     summary: Main dashboard page
 *     description: |
 *       Renders the main dashboard page of the application with summary statistics and visualizations.
 *       The dashboard provides an overview of processed documents, system metrics, and important statistics
 *       about document processing including tag counts, correspondent counts, and token usage.
 *
 *       The page displays visualizations for document processing status, token distribution,
 *       processing time statistics, and document type categorization to help administrators
 *       understand system performance and document processing patterns.
 *     tags:
 *       - Navigation
 *       - System
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Dashboard page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the dashboard page
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/dashboard', isAuthenticated, async (req, res) => {
  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  let paperlessUrl = '';

  try {
    paperlessUrl = await paperlessService.getPublicBaseUrl();
  } catch (error) {
    console.warn(
      '[WARN] Could not resolve Paperless public URL for dashboard links:',
      error.message
    );
  }

  res.render('dashboard', {
    paperless_data: {
      tagCount: 0,
      correspondentCount: 0,
      documentCount: 0,
      processedDocumentCount: 0,
      ocrNeededCount: 0,
      failedCount: 0,
      queueBacklog: 0,
      processingEfficiencyRate: 0,
      failedRate: 0,
      processedToday: 0,
      processingTimeStats: [],
      tokenDistribution: [],
      documentTypes: [],
      tokenTrend: [],
      recentActivity: [],
      languageDistribution: [],
    },
    openai_data: {
      averagePromptTokens: 0,
      averageCompletionTokens: 0,
      averageTotalTokens: 0,
      tokensOverall: 0,
    },
    version,
    paperlessUrl,
    // The cards the view loops over. Which widgets ship, in which order and how
    // wide, is the registry's business — the view only renders what it is given.
    dashboardWidgets,
  });
});

// The payload itself is assembled in dashboardStatsService and cached there:
// this endpoint is polled by every open dashboard, and rebuilding it per
// request meant two Paperless-ngx round trips plus a dozen queries each time.
router.get('/api/dashboard/stats', isAuthenticated, async (req, res) => {
  try {
    const { payload, cachedAt } = await dashboardStatsService.getStats();
    res.json({ ...payload, cachedAt });
  } catch (error) {
    console.error('[ERROR] loading dashboard stats:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to load dashboard stats' });
  }
});

router.get('/dashboard/doc/:id', isAuthenticated, async (req, res) => {
  const docId = req.params.id;
  if (!docId) {
    return res.status(400).json({ error: 'Document ID is required' });
  }
  try {
    const paperlessPublicUrl = await paperlessService.getPublicBaseUrl();
    if (!paperlessPublicUrl) {
      return res
        .status(500)
        .json({ error: 'Paperless public URL is not configured' });
    }

    const redirectUrl = `${paperlessPublicUrl}/documents/${docId}/details`;
    console.log('Redirecting to Paperless-ngx URL:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

/**
 * @swagger
 * /api/dashboard/layout:
 *   get:
 *     summary: Read the authenticated user's dashboard configuration
 *     description: >
 *       Returns the stored configuration in storage format v1: the named
 *       dashboards the user arranged, each with its widgets in display order,
 *       and the slug of the active one. An empty dashboards list means nothing
 *       has been customised and every board renders in its default order — the
 *       same answer a user without a stored configuration gets.
 *     tags:
 *       - Dashboard
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: The stored configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     version:
 *                       type: integer
 *                       example: 1
 *                     active:
 *                       type: string
 *                       description: Slug of the dashboard currently shown
 *                       example: "default"
 *                     dashboards:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           slug:
 *                             type: string
 *                             example: "default"
 *                           name:
 *                             type: string
 *                             example: "Dashboard"
 *                           widgets:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 id:
 *                                   type: string
 *                                   example: "task-runner"
 *                                 span:
 *                                   type: integer
 *                                   description: Width in grid columns, 3 to 12
 *                                   example: 12
 *                                 rows:
 *                                   type: integer
 *                                   description: Height in tile rows, 3 to 24, or 0 for as tall as the content
 *                                   example: 0
 *                                 hidden:
 *                                   type: boolean
 *                                   example: false
 *       401:
 *         description: Not authenticated
 */
router.get('/api/dashboard/layout', isAuthenticated, async (req, res) => {
  try {
    const username = req.user && req.user.username;
    if (!username) {
      return res.json({ success: true, data: emptyDashboardConfig() });
    }

    const stored = await documentModel.getDashboardLayout(username);
    // What was stored was validated on the way in, so it is handed back as it
    // is. Only the shape is checked: this is an unreleased feature, and a blob
    // in an older shape is a development leftover that should quietly fall back
    // to the defaults rather than reach the browser.
    const dashboardConfig =
      stored &&
      stored.version === DASHBOARD_CONFIG_VERSION &&
      Array.isArray(stored.dashboards)
        ? stored
        : emptyDashboardConfig();

    return res.json({ success: true, data: dashboardConfig });
  } catch (error) {
    console.error('[ERROR] GET /api/dashboard/layout:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to load dashboard layout' });
  }
});

/**
 * @swagger
 * /api/dashboard/layout:
 *   put:
 *     summary: Store or reset the authenticated user's dashboard configuration
 *     description: >
 *       Takes a complete configuration in storage format v1 and replaces the
 *       stored one; there is no partial update. Up to 10 dashboards, each with
 *       a slug, a name of 1 to 60 characters and up to 50 widgets in display
 *       order. Widget spans are 3 to 12 grid columns; rows are 3 to 24 tile
 *       rows, or 0 for a card that is as tall as its content. A dashboard
 *       without widgets shows the default arrangement under its own name.
 *
 *       Two payloads reset instead of storing: an empty dashboards array, and a
 *       single dashboard whose widgets array is empty. Both clear the stored
 *       configuration, so every board returns to its default order. Emptying
 *       one board out of several does not reset — that board simply shows the
 *       defaults and keeps its name.
 *
 *       If active names a dashboard that is not in the payload it is replaced
 *       with the first dashboard's slug rather than rejecting the write.
 *     tags:
 *       - Dashboard
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               version:
 *                 type: integer
 *                 enum: [1]
 *                 example: 1
 *               active:
 *                 type: string
 *                 description: Slug of the dashboard to show
 *                 example: "default"
 *               dashboards:
 *                 type: array
 *                 maxItems: 10
 *                 items:
 *                   type: object
 *                   required:
 *                     - slug
 *                     - name
 *                   properties:
 *                     slug:
 *                       type: string
 *                       pattern: "^[a-z0-9][a-z0-9-]{0,39}$"
 *                       example: "default"
 *                     name:
 *                       type: string
 *                       minLength: 1
 *                       maxLength: 60
 *                       example: "Dashboard"
 *                     widgets:
 *                       type: array
 *                       maxItems: 50
 *                       items:
 *                         type: object
 *                         required:
 *                           - id
 *                           - span
 *                         properties:
 *                           id:
 *                             type: string
 *                             pattern: "^[a-z0-9][a-z0-9-]{0,39}$"
 *                             example: "task-runner"
 *                           span:
 *                             type: integer
 *                             minimum: 3
 *                             maximum: 12
 *                             example: 12
 *                           rows:
 *                             type: integer
 *                             description: 3 to 24 tile rows, or 0 for as tall as the content
 *                             example: 0
 *                           hidden:
 *                             type: boolean
 *                             default: false
 *     responses:
 *       200:
 *         description: Configuration stored or reset
 *       400:
 *         description: Malformed configuration
 *       401:
 *         description: Not authenticated
 */
router.put(
  '/api/dashboard/layout',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const username = req.user && req.user.username;
      if (!username) {
        return res.json({ success: true, message: 'No user to store against' });
      }

      // Nothing arranged is not stored as "an empty arrangement": the row is
      // cleared, so the dashboard falls back to the registry order.
      if (isDashboardResetRequest(req.body)) {
        await documentModel.setDashboardLayout(username, null);
        return res.json({
          success: true,
          data: emptyDashboardConfig(),
          message: 'Dashboard layout reset',
        });
      }

      const dashboardConfig = normalizeDashboardConfig(req.body);
      if (!dashboardConfig) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid dashboard layout' });
      }

      await documentModel.setDashboardLayout(username, dashboardConfig);
      return res.json({
        success: true,
        data: dashboardConfig,
        message: 'Dashboard layout saved',
      });
    } catch (error) {
      console.error('[ERROR] PUT /api/dashboard/layout:', error);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to save dashboard layout' });
    }
  }
);

module.exports = router;
