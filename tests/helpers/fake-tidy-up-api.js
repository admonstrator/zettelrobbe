'use strict';

/**
 * A stand-in for the Tidy up API, for looking at the page in a real browser.
 *
 * The page talks to /api/tidy-up/* (routes/tidyUp.js) and to a handful of the
 * older /api/duplicates and /api/simplify routes. Neither can answer without
 * a Paperless-ngx instance and a model, so this serves the contract shapes
 * (schemas.js TidyUp*) from fixtures instead. The suggestions are built with
 * the real builders of services/tidyUpSuggestions.js and every sentence comes
 * from services/tidyUpWording.js, so the page is looked at with the words the
 * real API will send.
 *
 * Scenarios (what GET /api/tidy-up/runs/current answers):
 *   start                     no run yet (204)
 *   running                   a run halfway, 9 suggestions so far
 *   done                      a finished run, 14 open and 3 decided earlier
 *   failed-unreadable         done, one request answered unreadably (partialFailures)
 *   failed-budget             stopped at the token budget (failure)
 *   failed-unreachable        failed, the provider did not answer (failure)
 *   failed-thinking           failed, the model only reasoned (failure)
 *
 * Control (not part of the contract):
 *   POST /__fixture {scenario}   switch, and push the new snapshot to open streams
 *   GET  /__fixture              { scenario, requests } — every API call, newest last
 *   GET  /tidy-up?model=no&splits=no&counts=no&lastRun=no   the view's locals
 *
 * Usage:
 *   const fake = await startFakeTidyUpApi({ scenario: 'start' });
 *   await page.goto(fake.base + '/tidy-up');
 *   await fake.setScenario('done');
 *   await fake.close();
 */

const path = require('path');
const { EventEmitter } = require('events');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const express = require(path.join(REPO_ROOT, 'node_modules', 'express'));
const builders = require(path.join(REPO_ROOT, 'services', 'tidyUpSuggestions'));
const wording = require(path.join(REPO_ROOT, 'services', 'tidyUpWording'));

/* The shell partials read these; server.js sets them on app.locals. */
const SHELL_LOCALS = {
  theme: 'light',
  csrfToken: 'test-csrf',
  appVersion: 'test',
  appCommitSha: 'test',
  appPaperlessNgxVersion: 'test',
  appNodeVersion: 'test',
  appPlatform: 'test',
  appNodeEnv: 'test',
  appAiProvider: 'openai',
  appOcrProvider: 'mistral',
  appServerTimeUtc: 'test',
  appServerTimezone: 'test',
  appPaperlessApiUrl: 'test',
  appOllamaApiUrl: 'test',
  appOllamaModel: 'test',
  appCustomBaseUrl: 'test',
  appCustomModel: 'test',
  appAzureEndpoint: 'test',
  appAzureDeploymentName: 'test',
  appAzureApiVersion: 'test',
  appAnthropicModel: 'test',
  appAnthropicApiUrl: 'default',
  appMistralOcrModel: 'test',
  appScanInterval: 'test',
  appTokenLimit: 'test',
  appResponseTokens: 'test',
  appTrustProxy: 'test',
  appUseExistingData: 'no',
  appRestrictTags: 'no',
  appRestrictCorrespondents: 'no',
  appRestrictDocumentTypes: 'no',
  appDateFormat: 'DD.MM.YYYY',
  appOcrEnabled: false,
  appPaperlessTokenSet: false,
  appOpenAiKeySet: false,
  appCustomKeySet: false,
  appAzureKeySet: false,
  appAnthropicKeySet: false,
  appMistralKeySet: false,
  appApiKeySet: false,
};

const SCENARIOS = Object.freeze([
  'start',
  'running',
  'done',
  'failed-unreadable',
  'failed-budget',
  'failed-unreachable',
  'failed-thinking',
]);

const MODEL = 'qwen3:8b';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function member(id, name, documentCount, extra = {}) {
  return { id, name, documentCount, ...extra };
}

function group(kind, members, targetId, reasons, extra = {}) {
  return {
    id: `${kind}:${members.map((m) => m.id).join('-')}`,
    kind,
    confidence: extra.confidence ?? 0.97,
    reasons,
    suggestedTargetId: targetId,
    members,
    warnings: [],
    source: 'scan',
    aiVerdict: null,
    ...extra,
  };
}

function side(id, name, documentCount, titles, neighbours) {
  return { id, name, documentCount, titles, neighbours };
}

/**
 * The suggestions of a finished run: 14 open across every kind and
 * certainty, and three decided earlier (done, declined, later).
 */
function buildSuggestions() {
  const list = [];

  // Sure merges: spelling rules settle them.
  list.push(
    builders.fromDuplicateGroup(
      group(
        'tags',
        [member(11, 'invoice', 48), member(12, 'Invoices', 12)],
        11,
        ['plural']
      )
    )
  );
  list.push(
    builders.fromDuplicateGroup(
      group(
        'correspondents',
        [
          member(21, 'Acme Insurance Group', 28),
          member(22, 'ACME Insurance Group Ltd.', 3),
        ],
        21,
        ['legal-form', 'exact-normalized']
      )
    )
  );
  list.push(
    builders.fromDuplicateGroup(
      group(
        'correspondents',
        [
          member(23, 'Stadtwerke Mainz', 41),
          member(24, 'Stadtwerke Mainz GmbH', 6),
        ],
        23,
        ['legal-form']
      )
    )
  );
  list.push(
    builders.fromDuplicateGroup(
      group(
        'tags',
        [member(13, 'Steuer 2024', 17), member(14, 'steuer  2024', 2)],
        13,
        ['exact-normalized']
      )
    )
  );
  list.push(
    builders.fromDuplicateGroup(
      group(
        'tags',
        [
          member(15, 'Versicherung', 36),
          member(16, 'Versicherungen', 9),
          member(17, 'versicherung', 1),
        ],
        15,
        ['plural', 'exact-normalized']
      )
    )
  );

  // Likely: the model leans towards the same.
  list.push(
    builders.fromDuplicateGroup(
      group(
        'tags',
        [member(18, 'Auto', 22), member(19, 'KFZ', 7)],
        18,
        ['semantic'],
        {
          confidence: 0.71,
          source: 'ai-candidate',
          aiVerdict: {
            verdict: 'same',
            confidence: 'low',
            reason: 'KFZ is the German abbreviation for a motor vehicle',
            basis: 'abbreviation',
            source: 'model',
          },
        }
      )
    )
  );

  // Needs a look: the model says different, or cannot tell.
  list.push(
    builders.fromDuplicateGroup(
      group(
        'tags',
        [member(31, 'Kontoauszug', 64), member(32, 'Kontoumzug', 2)],
        31,
        ['fuzzy'],
        {
          confidence: 0.88,
          aiVerdict: {
            verdict: 'different',
            confidence: 'high',
            reason:
              'one is a bank statement, the other a change of bank account',
            basis: 'different-thing',
            source: 'model',
          },
        }
      ),
      {
        evidence: {
          sides: [
            side(
              31,
              'Kontoauszug',
              64,
              [
                'Kontoauszug 03/2026',
                'Kontoauszug 02/2026',
                'Kontoauszug 01/2026',
              ],
              ['Bank', 'Sparkasse']
            ),
            side(
              32,
              'Kontoumzug',
              2,
              ['Kontowechsel-Service Bestätigung', 'Umzug Girokonto Formular'],
              ['Bank', 'Umzug']
            ),
          ],
        },
      }
    )
  );
  list.push(
    builders.fromDuplicateGroup(
      group(
        'correspondents',
        [member(33, 'Amazon', 52), member(34, 'Amazon EU S.a.r.l.', 4)],
        33,
        ['prefix'],
        {
          confidence: 0.79,
          aiVerdict: {
            verdict: 'unsure',
            confidence: 'low',
            reason: 'the documents look alike but name different senders',
            basis: 'insufficient-evidence',
            source: 'model',
          },
        }
      ),
      {
        evidence: {
          sides: [
            side(
              33,
              'Amazon',
              52,
              ['Bestellung 302-114', 'Rechnung Kindle', 'Retoure 28-01'],
              ['Online', 'Rechnung']
            ),
            side(
              34,
              'Amazon EU S.a.r.l.',
              4,
              ['Rechnung Marketplace', 'Gutschrift'],
              ['Rechnung']
            ),
          ],
        },
      }
    )
  );

  // Splits.
  list.push(
    builders.fromOrderMember({
      tagId: 41,
      tagName: 'Rechnung Auto',
      documentCount: 14,
      action: 'split',
      typeName: 'Invoice',
      topicNames: ['Car'],
      source: 'model',
      confidence: 'high',
      reason: '',
    })
  );
  list.push(
    builders.fromOrderMember({
      tagId: 42,
      tagName: 'Vertrag Wohnung',
      documentCount: 5,
      action: 'split',
      typeName: 'Contract',
      topicNames: ['Home', 'Rent'],
      source: 'model',
      confidence: 'low',
      reason: '',
    })
  );

  // Unused tags.
  for (const [id, name] of [
    [51, 'test'],
    [52, 'alt'],
    [53, 'Neu 2'],
    [54, 'temp-import'],
  ]) {
    list.push(
      builders.fromUnusedEntity({ id, name, documentCount: 0 }, 'tags')
    );
  }

  // Decided earlier.
  const earlierDone = builders.fromDuplicateGroup(
    group('tags', [member(61, 'Arzt', 30), member(62, 'Ärzte', 4)], 61, [
      'umlaut-variant',
      'plural',
    ])
  );
  earlierDone.status = 'done';
  earlierDone.outcome = '4 documents moved';
  earlierDone.undoId = '901';
  const earlierDeclined = builders.fromDuplicateGroup(
    group('tags', [member(63, 'Bau', 8), member(64, 'Baum', 3)], 63, ['fuzzy'])
  );
  earlierDeclined.status = 'declined';
  const earlierLater = builders.fromUnusedEntity(
    { id: 71, name: 'Hausverwaltung Alt', documentCount: 0 },
    'correspondents'
  );
  earlierLater.status = 'later';
  list.push(earlierDone, earlierDeclined, earlierLater);
  return list;
}

/** The ids already found halfway through a run: what spelling settles. */
const RUNNING_IDS = Object.freeze([
  'merge:tags:11-12',
  'merge:correspondents:21-22',
  'merge:correspondents:23-24',
  'merge:tags:13-14',
  'merge:tags:15-16-17',
  'delete:tags:51',
  'delete:tags:52',
  'delete:tags:53',
  'delete:tags:54',
]);

function steps(states, details) {
  return wording.RUN_STEPS.map((step, i) => ({
    key: step.key,
    label: step.label,
    state: states[i],
    detail: details[i] || '',
  }));
}

const DONE_DETAILS = [
  wording.stepDetail('compare', { done: true, names: 550, sure: 9, open: 23 }),
  wording.stepDetail('evidence', { pairs: 23 }),
  wording.stepDetail('judge', {
    requestsDone: 6,
    requestsPlanned: 6,
    pairsJudged: 23,
    pairs: 23,
  }),
  '',
  '',
];

function failure(kind, ctx, technical, extra = {}) {
  return {
    kind,
    ...wording.failureNotice(kind, ctx),
    technical,
    pairsAffected: ctx.pairsAffected || 0,
    ...extra,
  };
}

/** The TidyUpRun of a scenario; `summary` is filled in by the caller. */
function runFor(scenario, options) {
  const base = {
    id: 'run-1',
    options: { askModel: true, suggestSplits: false, kind: 'all', ...options },
    model: MODEL,
    failure: null,
    partialFailures: [],
    startedAt: new Date(Date.now() - 95 * 1000).toISOString(),
    finishedAt: null,
  };
  const splitState = base.options.suggestSplits ? 'next' : 'skipped';
  switch (scenario) {
    case 'running':
      return {
        ...base,
        status: 'running',
        headline: wording.runHeadline('running'),
        steps: steps(
          ['done', 'done', 'now', splitState, 'next'],
          [
            wording.stepDetail('compare', {
              done: true,
              names: 550,
              sure: 9,
              open: 23,
            }),
            wording.stepDetail('evidence', { pairs: 23 }),
            wording.stepDetail('judge', {
              requestsDone: 3,
              requestsPlanned: 6,
              pairsJudged: 14,
              pairs: 23,
            }),
            '',
            '',
          ]
        ),
        progress: {
          percent: 58,
          etaText: 'About a minute left',
          costText: '38,400 tokens of your 200,000 budget',
          tokens: 38400,
          tokenBudget: 200000,
        },
      };
    case 'stopping':
      return {
        ...runFor('running', options),
        status: 'stopping',
        headline: wording.runHeadline('stopping'),
      };
    case 'failed-budget':
      return {
        ...base,
        status: 'stopped',
        headline: wording.runHeadline('stopped'),
        steps: steps(['done', 'done', 'done', 'skipped', 'done'], DONE_DETAILS),
        progress: {
          percent: 100,
          etaText: null,
          costText: '200,000 tokens of your 200,000 budget',
          tokens: 200000,
          tokenBudget: 200000,
        },
        failure: failure(
          'budget',
          { budget: 200000, pairsJudged: 15, pairs: 23, pairsLeft: 8 },
          'stopReason=token-budget · tokens=200,412 · budget=200,000'
        ),
        finishedAt: new Date().toISOString(),
      };
    case 'failed-unreachable':
      return {
        ...base,
        status: 'failed',
        headline: wording.runHeadline('failed'),
        steps: steps(['done', 'done', 'now', 'skipped', 'next'], DONE_DETAILS),
        progress: {
          percent: 40,
          etaText: null,
          costText: null,
          tokens: 0,
          tokenBudget: 200000,
        },
        failure: failure(
          'unreachable',
          { model: MODEL, endpoint: 'Ollama at http://ollama:11434' },
          'connect ECONNREFUSED 172.18.0.4:11434 · POST http://ollama:11434/api/chat'
        ),
        finishedAt: new Date().toISOString(),
      };
    case 'failed-thinking':
      return {
        ...base,
        status: 'failed',
        headline: wording.runHeadline('failed'),
        steps: steps(['done', 'done', 'now', 'skipped', 'next'], DONE_DETAILS),
        progress: {
          percent: 45,
          etaText: null,
          costText: '6,000 tokens of your 200,000 budget',
          tokens: 6000,
          tokenBudget: 200000,
        },
        failure: failure(
          'thinking',
          { model: MODEL, answerTokens: 1000 },
          'done_reason=length · eval_count=1000 · thinking=3,912 chars · content empty'
        ),
        finishedAt: new Date().toISOString(),
      };
    case 'failed-unreadable':
      return {
        ...base,
        status: 'done',
        headline: wording.runHeadline('done'),
        steps: steps(['done', 'done', 'done', 'skipped', 'done'], DONE_DETAILS),
        progress: {
          percent: 100,
          etaText: null,
          costText: '61,200 tokens of your 200,000 budget',
          tokens: 61200,
          tokenBudget: 200000,
        },
        partialFailures: [
          failure(
            'unreadable',
            { model: MODEL, pairsAffected: 4, pairsFine: 19 },
            'request 4 of 6 · the answer contained no JSON array · answer began: "Let me look at each pair in turn…"'
          ),
        ],
        finishedAt: new Date().toISOString(),
      };
    default: {
      const status = scenario === 'stopped' ? 'stopped' : 'done';
      return {
        ...base,
        status,
        headline: wording.runHeadline(status),
        steps: steps(['done', 'done', 'done', 'skipped', 'done'], DONE_DETAILS),
        progress: {
          percent: 100,
          etaText: null,
          costText: '61,200 tokens of your 200,000 budget',
          tokens: 61200,
          tokenBudget: 200000,
        },
        finishedAt: new Date().toISOString(),
      };
    }
  }
}

function recentFixture() {
  const today = new Date();
  today.setHours(9, 12, 0, 0);
  const yesterday = new Date(today.getTime() - 86400000);
  yesterday.setHours(18, 40, 0, 0);
  return [
    {
      id: '903',
      when: today.toISOString(),
      sentence: 'Merged Invoices into invoice · 12 documents moved',
      status: 'done',
      canUndo: true,
    },
    {
      id: '902',
      when: yesterday.toISOString(),
      sentence: 'Deleted the tag Neu · no documents',
      status: 'done',
      canUndo: true,
    },
    {
      id: '901',
      when: new Date(today.getTime() - 3 * 86400000).toISOString(),
      sentence: 'Merged Ärzte into Arzt · 4 documents moved',
      status: 'undone',
      canUndo: false,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {{scenario?: string, port?: number}} [options]
 * @returns {Promise<{base: string, app: object, state: object, setScenario: (s: string) => void, close: () => Promise<void>}>}
 */
async function startFakeTidyUpApi(options = {}) {
  const events = new EventEmitter();
  const state = {
    scenario: options.scenario || 'start',
    options: {},
    suggestions: buildSuggestions(),
    batches: new Map(),
    recent: recentFixture(),
    dismissals: [
      { id: 7, kind: 'tags', idA: 63, nameA: 'Bau', idB: 64, nameB: 'Baum' },
      {
        id: 8,
        kind: 'correspondents',
        idA: 81,
        nameA: 'Post',
        idB: 82,
        nameB: 'Postbank',
      },
    ],
    vocabulary: {
      types: ['Invoice', 'Contract', 'Letter', 'Statement', 'Receipt'].map(
        (name, i) => ({
          id: i + 1,
          dimension: 'type',
          name,
          paperlessId: i < 2 ? i + 100 : null,
          source: 'model',
          position: i,
        })
      ),
      topics: ['Car', 'Home', 'Rent', 'Health', 'Tax'].map((name, i) => ({
        id: i + 20,
        dimension: 'topic',
        name,
        paperlessId: null,
        source: 'model',
        position: i,
      })),
    },
    requests: [],
  };

  const visible = () => {
    if (state.scenario === 'start') return [];
    if (state.scenario === 'running' || state.scenario === 'stopping') {
      return state.suggestions.filter((s) => RUNNING_IDS.includes(s.id));
    }
    return state.suggestions;
  };
  const currentRun = () => {
    if (state.scenario === 'start') return null;
    const run = runFor(state.scenario, state.options);
    run.summary = builders.summarize(visible());
    return run;
  };

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(REPO_ROOT, 'views'));
  Object.assign(app.locals, SHELL_LOCALS);
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api/')) {
      state.requests.push({
        method: req.method,
        path: req.path,
        body: req.body || null,
      });
    }
    next();
  });
  app.use(express.static(path.join(REPO_ROOT, 'public')));

  app.get('/tidy-up', (req, res) => {
    const off = (key) => req.query[key] === 'no';
    res.render('tidy-up', {
      version: 'test',
      modelAvailable: !off('model'),
      modelLabel: MODEL,
      splitsAvailable: !off('model') && !off('splits'),
      counts: off('counts') ? undefined : { tags: 412, correspondents: 138 },
      lastRun: off('lastRun')
        ? null
        : {
            when: new Date(Date.now() - 3 * 86400000).toISOString(),
            accepted: 11,
          },
    });
  });

  app.get('/__fixture', (_req, res) => {
    res.json({ scenario: state.scenario, requests: state.requests });
  });
  app.post('/__fixture', (req, res) => {
    setScenario(String(req.body?.scenario || 'start'));
    res.json({ scenario: state.scenario });
  });

  app.get('/api/csrf-token', (_req, res) =>
    res.json({ csrfToken: 'test-csrf' })
  );

  /* --- runs --------------------------------------------------------- */
  app.post('/api/tidy-up/runs', (req, res) => {
    if (state.scenario === 'running') {
      return res
        .status(409)
        .json({ success: false, error: 'A run is already going' });
    }
    state.options = {
      askModel: req.body?.askModel !== false,
      suggestSplits: req.body?.suggestSplits === true,
      kind: req.body?.kind || 'all',
    };
    state.suggestions = buildSuggestions();
    state.scenario = 'running';
    return res.status(202).json({ success: true, data: currentRun() });
  });
  app.get('/api/tidy-up/runs/current', (_req, res) => {
    const run = currentRun();
    if (!run) return res.status(204).end();
    return res.json({ success: true, data: run });
  });
  app.get('/api/tidy-up/runs/:id', (req, res) => {
    const run = currentRun();
    if (!run || run.id !== req.params.id) {
      return res.status(404).json({ success: false, error: 'Unknown run' });
    }
    return res.json({ success: true, data: run });
  });
  app.get('/api/tidy-up/runs/:id/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = () => {
      const run = currentRun();
      if (!run) return;
      res.write(`data: ${JSON.stringify(run)}\n\n`);
      if (['done', 'stopped', 'failed'].includes(run.status)) {
        events.off('change', send);
        res.end();
      }
    };
    events.on('change', send);
    req.on('close', () => events.off('change', send));
    send();
  });
  app.post('/api/tidy-up/runs/:id/stop', (_req, res) => {
    setScenario('stopping');
    // Stopping takes a moment on the real server too.
    setTimeout(() => {
      if (state.scenario !== 'stopping') return;
      state.suggestions = state.suggestions.filter((s) =>
        RUNNING_IDS.includes(s.id)
      );
      state.scenario = 'stopped';
      events.emit('change');
    }, 300);
    return res.json({ success: true, data: currentRun() });
  });

  /* --- suggestions -------------------------------------------------- */
  const suggestionsPayload = () => ({
    runId: state.scenario === 'start' ? null : 'run-1',
    summary: builders.summarize(visible()),
    suggestions: visible(),
  });
  app.get('/api/tidy-up/suggestions', (_req, res) => {
    res.json({ success: true, data: suggestionsPayload() });
  });
  let batchCounter = 0;
  app.post('/api/tidy-up/suggestions/decide', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const decision = req.body?.decision;
    if (
      !['accept', 'decline', 'later'].includes(decision) ||
      ids.length === 0
    ) {
      return res
        .status(400)
        .json({ success: false, error: 'ids and decision are required' });
    }
    const batchId = decision === 'accept' ? `batch-${++batchCounter}` : null;
    const before = [];
    for (const id of ids) {
      const s = state.suggestions.find((x) => x.id === id);
      if (!s) continue;
      before.push({ ...s });
      if (decision === 'accept') {
        // One suggestion refuses, so the failed line can be looked at.
        if (s.id === 'merge:correspondents:33-34' && s.status !== 'failed') {
          s.status = 'failed';
          s.outcome =
            'Paperless-ngx refused the change: you may not edit Amazon EU S.a.r.l.';
          continue;
        }
        s.status = 'done';
        const moved = s.from.reduce((n, e) => n + (e.documentCount || 0), 0);
        s.outcome =
          s.kind === 'delete'
            ? 'deleted'
            : `${wording.documents(moved).replace(/^./, (c) => c.toUpperCase())} moved`;
        s.undoId = String(1000 + batchCounter);
        s.batchId = batchId;
      } else {
        s.status = decision === 'decline' ? 'declined' : 'later';
      }
    }
    if (batchId) state.batches.set(batchId, before);
    return res.json({
      success: true,
      data: { batchId, ...suggestionsPayload() },
    });
  });
  app.post('/api/tidy-up/suggestions/undo', (req, res) => {
    const before = state.batches.get(req.body?.batchId);
    if (!before)
      return res.status(404).json({ success: false, error: 'Unknown batch' });
    for (const old of before) {
      const i = state.suggestions.findIndex((x) => x.id === old.id);
      if (i >= 0) state.suggestions[i] = old;
    }
    state.batches.delete(req.body.batchId);
    return res.json({
      success: true,
      data: { undone: before.length, ...suggestionsPayload() },
    });
  });
  app.get('/api/tidy-up/recent', (_req, res) => {
    res.json({ success: true, data: state.recent });
  });

  /* --- the older routes the page reuses ------------------------------ */
  app.post('/api/duplicates/log/:id/undo', (req, res) => {
    const row = state.recent.find((r) => r.id === req.params.id);
    if (row) {
      row.status = 'undone';
      row.canUndo = false;
    }
    for (const s of state.suggestions) {
      if (s.undoId === req.params.id && s.status === 'done') {
        s.status = 'open';
        s.outcome = null;
        s.undoId = null;
      }
    }
    res.json({ success: true, message: 'Undone' });
  });
  app.get('/api/duplicates/dismissals', (_req, res) => {
    res.json({ success: true, data: state.dismissals });
  });
  app.delete('/api/duplicates/dismissals/:id', (req, res) => {
    state.dismissals = state.dismissals.filter(
      (d) => String(d.id) !== req.params.id
    );
    res.json({ success: true, message: 'Restored' });
  });
  app.delete('/api/duplicates/ai-review/memory', (_req, res) => {
    res.json({ success: true, data: { removed: 37 } });
  });
  app.get('/api/duplicates/ai-review/estimate', (_req, res) => {
    if (state.scenario === 'failed-unreachable') {
      return res.status(503).json({
        success: false,
        error: 'Ollama at http://ollama:11434 did not answer',
      });
    }
    return res.json({
      success: true,
      data: { model: MODEL, requests: 6, items: 23, needsScan: false },
    });
  });
  app.get('/api/simplify/vocabulary', (_req, res) => {
    res.json({ success: true, data: state.vocabulary });
  });
  app.put('/api/simplify/vocabulary', (req, res) => {
    const names = (list) =>
      Array.isArray(list) ? list.map(String).filter(Boolean) : [];
    state.vocabulary = {
      types: names(req.body?.types).map((name, i) => ({
        id: i + 1,
        dimension: 'type',
        name,
        paperlessId: null,
        source: 'user',
        position: i,
      })),
      topics: names(req.body?.topics).map((name, i) => ({
        id: i + 50,
        dimension: 'topic',
        name,
        paperlessId: null,
        source: 'user',
        position: i,
      })),
    };
    res.json({ success: true, data: state.vocabulary, message: 'Saved' });
  });
  app.get('/api/simplify/document-types', (_req, res) => {
    res.json({
      success: true,
      data: {
        types: [
          { id: 100, name: 'Invoice', documentCount: 120, inVocabulary: true },
          { id: 101, name: 'Contract', documentCount: 18, inVocabulary: true },
          { id: 102, name: 'Bescheid', documentCount: 9, inVocabulary: false },
        ],
        total: 3,
        cachedAt: null,
      },
    });
  });

  /** Switches the scenario; every scenario but stopping starts from fresh suggestions. */
  function setScenario(scenario) {
    if (scenario !== 'stopping' && scenario !== 'done') {
      state.suggestions = buildSuggestions();
      state.batches.clear();
    }
    state.scenario = scenario;
    events.emit('change');
  }

  const server = await new Promise((resolve) => {
    const s = app.listen(options.port || 0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function close() {
    events.removeAllListeners();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  return { base, app, state, setScenario, close };
}

module.exports = {
  startFakeTidyUpApi,
  buildSuggestions,
  SCENARIOS,
  SHELL_LOCALS,
  RUNNING_IDS,
};

if (require.main === module) {
  const port = Number(process.argv[2]) || 3202;
  startFakeTidyUpApi({ port, scenario: process.argv[3] || 'start' }).then(
    (fake) => console.log(`fake Tidy up API on ${fake.base}/tidy-up`)
  );
}
