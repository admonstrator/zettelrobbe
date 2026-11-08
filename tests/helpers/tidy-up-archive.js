'use strict';

/**
 * One small archive for the Tidy up tests, and the harness around it: the
 * router mounted over a fake Paperless-ngx (tests/helpers/fake-paperless.js)
 * with the real entity methods, and the OpenAI-compatible provider pointed at
 * a fake chat endpoint (tests/helpers/fake-openai.js) that answers the judge
 * and the order from one script.
 *
 * The archive has one of everything a run turns into a suggestion:
 *   - invoice / Invoices            plural, a rule settles it (sure)
 *   - Steuerberater / Steuerberatr  a typo the model is unsure about
 *   - Kontoauszug / Kontoumzug      below the threshold; the model says different
 *   - Bank / Banks                  plural, but declined earlier (dismissed)
 *   - Old stuff                     a tag nobody uses
 *   - Posteingang                   the inbox tag, never on any list
 *   - Stromrechnung                 a compound tag the vocabulary splits
 *   - ACME GmbH / ACME              the same company, one with a legal form
 */

const path = require('path');
const { createFakePaperless } = require('./fake-paperless');
const { createFakeOpenAI } = require('./fake-openai');
const { mountRouter, REPO_ROOT } = require('./mount-router');

const TAGS = Object.freeze({
  invoice: 1,
  invoices: 2,
  kontoauszug: 3,
  kontoumzug: 4,
  oldStuff: 5,
  bank: 6,
  banks: 7,
  inbox: 8,
  steuerberater: 9,
  steuerberatr: 12,
  stromrechnung: 13,
});

const CORRESPONDENTS = Object.freeze({ acmeGmbh: 20, acme: 21 });

function seed() {
  return {
    tags: [
      { id: TAGS.invoice, name: 'invoice' },
      { id: TAGS.invoices, name: 'Invoices' },
      { id: TAGS.kontoauszug, name: 'Kontoauszug' },
      { id: TAGS.kontoumzug, name: 'Kontoumzug' },
      { id: TAGS.oldStuff, name: 'Old stuff' },
      { id: TAGS.bank, name: 'Bank' },
      { id: TAGS.banks, name: 'Banks' },
      { id: TAGS.inbox, name: 'Posteingang', is_inbox_tag: true },
      { id: TAGS.steuerberater, name: 'Steuerberater' },
      { id: TAGS.steuerberatr, name: 'Steuerberatr' },
      { id: TAGS.stromrechnung, name: 'Stromrechnung' },
    ],
    correspondents: [
      { id: CORRESPONDENTS.acmeGmbh, name: 'ACME GmbH' },
      { id: CORRESPONDENTS.acme, name: 'ACME' },
    ],
    documents: [
      {
        id: 101,
        title: 'Invoice 2026-01',
        tags: [TAGS.invoice],
        correspondent: CORRESPONDENTS.acmeGmbh,
      },
      {
        id: 102,
        title: 'Invoice 2026-02',
        tags: [TAGS.invoice],
        correspondent: CORRESPONDENTS.acme,
      },
      { id: 103, title: 'Invoice 2025-12', tags: [TAGS.invoices] },
      { id: 104, title: 'Statement January', tags: [TAGS.kontoauszug] },
      { id: 105, title: 'Statement February', tags: [TAGS.kontoauszug] },
      { id: 106, title: 'Moving the account', tags: [TAGS.kontoumzug] },
      { id: 107, title: 'Bank letter', tags: [TAGS.bank] },
      { id: 108, title: 'Bank fees', tags: [TAGS.banks] },
      { id: 109, title: 'Tax return 2025', tags: [TAGS.steuerberater] },
      { id: 110, title: 'Tax advice fee', tags: [TAGS.steuerberater] },
      { id: 111, title: 'Tax advisor letter', tags: [TAGS.steuerberatr] },
      { id: 112, title: 'Electricity bill', tags: [TAGS.stromrechnung] },
      { id: 113, title: 'Electricity bill 2', tags: [TAGS.stromrechnung] },
    ],
  };
}

/**
 * What the fake model answers, to whichever question: the judge keeps the
 * items whose id is a pair of its request, the order the items whose id is a
 * tag of its request, and both drop the rest.
 */
function modelAnswer() {
  const pair = (a, b) => `tags:${Math.min(a, b)}-${Math.max(a, b)}`;
  return JSON.stringify([
    {
      id: pair(TAGS.invoice, TAGS.invoices),
      verdict: 'same',
      basis: 'titles',
      confidence: 'high',
      reason: 'both hold invoices',
    },
    {
      id: pair(TAGS.steuerberater, TAGS.steuerberatr),
      verdict: 'unsure',
      basis: 'name',
      confidence: 'low',
      reason: 'the titles do not settle it',
    },
    {
      id: pair(TAGS.kontoauszug, TAGS.kontoumzug),
      verdict: 'different',
      basis: 'titles',
      confidence: 'high',
      reason: 'statements are not a move of the account',
    },
    ...Object.values(TAGS).map((id) => ({
      id: String(id),
      action: 'keep',
      reason: 'as it is',
    })),
  ]);
}

/** Entity methods the harness stubs; the real ones read the fake. */
const REAL_ENTITY_METHODS = [
  'listEntities',
  'getEntity',
  'findEntityByExactName',
  'createEntity',
  'updateEntity',
  'deleteEntity',
  'getDocumentIdsByEntity',
  'getDocumentsByIds',
  'bulkEditDocuments',
  'getRecentDocumentTitlesByEntity',
  'getRecentDocumentExcerptsByEntity',
  'getEntityNeighbourhood',
  'clearEntityCaches',
];

/**
 * Mounts the router over a fresh copy of the archive and a fake model.
 *
 * @returns {Promise<{harness, fake, fakeOpenAI, reset: () => object, services: object, store: {fake: object, writeDelayMs: number}, close: () => Promise<void>}>}
 */
async function mountArchive({ env = {} } = {}) {
  // writeDelayMs: every write to the fake Paperless-ngx (POST, PUT, PATCH,
  // DELETE) waits this long first, so a test can watch a decide at work.
  const store = { fake: createFakePaperless(seed()), writeDelayMs: 0 };
  const slow = async (call) => {
    if (store.writeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, store.writeDelayMs));
    }
    return call();
  };
  const fakeOpenAI = await createFakeOpenAI({
    chunks: [{ content: modelAnswer() }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
  const harness = await mountRouter({
    env: {
      OPENAI_MODEL: 'fake-model',
      DUPLICATES_AI_REVIEW: 'yes',
      DUPLICATES_AI_CONCURRENCY: '1',
      ...env,
    },
    stub: ({ paperlessService }) => {
      for (const method of REAL_ENTITY_METHODS) {
        delete paperlessService[method];
      }
      paperlessService.client = {
        defaults: { baseURL: 'http://paperless.test/api' },
        get: (url, config = {}) =>
          store.fake.handle('get', url, config.params || {}),
        post: (url, body) =>
          slow(() => store.fake.handle('post', url, {}, body)),
        put: (url, body) => slow(() => store.fake.handle('put', url, {}, body)),
        patch: (url, body) =>
          slow(() => store.fake.handle('patch', url, {}, body)),
        delete: (url) => slow(() => store.fake.handle('delete', url, {})),
      };
      const dashboardStatsService = require(
        path.join(REPO_ROOT, 'services', 'dashboardStatsService')
      );
      dashboardStatsService.refresh = async () => ({});
    },
  });

  const OpenAI = require(path.join(REPO_ROOT, 'node_modules', 'openai'));
  const service = (name) => require(path.join(REPO_ROOT, 'services', name));
  const services = {
    runs: service('tidyUpRunService'),
    jobs: service('duplicateReviewJobService'),
    merges: service('duplicateMergeService'),
    judge: service('entityMatchAiService'),
    simplify: service('tagSimplifyService'),
    paperless: service('paperlessService'),
    openai: service('openaiService'),
  };
  services.openai.client = new OpenAI({
    apiKey: 'test',
    baseURL: fakeOpenAI.baseURL,
    maxRetries: 0,
    timeout: 15000,
  });
  services.merges.dashboardRefreshDebounceMs = 0;

  /** A fresh archive, no run, no cached scan, no remembered verdicts. */
  const reset = async () => {
    store.fake = createFakePaperless(seed());
    store.writeDelayMs = 0;
    services.jobs.reset();
    services.runs.reset();
    services.merges.invalidateScanCache();
    services.paperless.clearEntityCaches?.();
    services.judge.resetCalibration();
    await services.judge.forgetVerdicts();
    fakeOpenAI.reset();
    return store.fake;
  };

  return {
    harness,
    fakeOpenAI,
    services,
    store,
    reset,
    async close() {
      services.jobs.reset();
      await harness.close();
      await fakeOpenAI.close();
    },
  };
}

module.exports = {
  TAGS,
  CORRESPONDENTS,
  seed,
  modelAnswer,
  mountArchive,
};
