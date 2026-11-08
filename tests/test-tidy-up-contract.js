'use strict';

/**
 * Contract test for the Tidy up page: the suggestion shape, the wording, the
 * failure kinds and the router being mounted. The page and the run service
 * are built against exactly this.
 */
const assert = require('assert');
const path = require('path');
const suggestions = require('../services/tidyUpSuggestions');
const wording = require('../services/tidyUpWording');
const failure = require('../services/modelFailure');
const { mountRouter } = require('./helpers/mount-router');

/* The shell partials read these from app.locals; server.js sets them. */
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

const SUGGESTION_KEYS = [
  'id',
  'kind',
  'entityKind',
  'certainty',
  'headline',
  'reason',
  'from',
  'to',
  'typeName',
  'topicNames',
  'evidence',
  'details',
  'status',
  'outcome',
  'undoId',
];

function group(overrides = {}) {
  return {
    id: 'tags:1-2',
    kind: 'tags',
    confidence: 0.92,
    reasons: ['plural', 'exact-normalized'],
    suggestedTargetId: 1,
    members: [
      { id: 1, name: 'invoice', documentCount: 240 },
      { id: 2, name: 'Invoices', documentCount: 12 },
    ],
    warnings: [],
    ...overrides,
  };
}

async function run() {
  // --- certainty -----------------------------------------------------
  assert.strictEqual(suggestions.certaintyFor(group()), 'sure');
  assert.strictEqual(
    suggestions.certaintyFor(group({ reasons: ['token-order'] })),
    'likely'
  );
  assert.strictEqual(
    suggestions.certaintyFor(group({ reasons: ['prefix'], confidence: 0.85 })),
    'likely'
  );
  assert.strictEqual(
    suggestions.certaintyFor(group({ reasons: ['fuzzy'], confidence: 0.8 })),
    'unsure'
  );
  assert.strictEqual(
    suggestions.certaintyFor(
      group({
        reasons: ['fuzzy'],
        aiVerdict: { verdict: 'same', confidence: 'high', source: 'model' },
      })
    ),
    'sure'
  );
  assert.strictEqual(
    suggestions.certaintyFor(
      group({
        reasons: ['fuzzy'],
        aiVerdict: { verdict: 'same', confidence: 'low', source: 'model' },
      })
    ),
    'likely'
  );
  assert.strictEqual(
    suggestions.certaintyFor(
      group({
        reasons: ['exact-normalized'],
        aiVerdict: {
          verdict: 'different',
          confidence: 'high',
          source: 'model',
        },
      })
    ),
    'unsure',
    'a different verdict beats a sure spelling rule'
  );
  assert.strictEqual(
    suggestions.certaintyFor(group({ warnings: ['no-permission'] })),
    'unsure'
  );

  // --- merge suggestion ---------------------------------------------
  const merge = suggestions.fromDuplicateGroup(group());
  assert.deepStrictEqual(
    Object.keys(merge).sort(),
    [...SUGGESTION_KEYS].sort()
  );
  assert.strictEqual(merge.kind, 'merge');
  assert.strictEqual(merge.id, 'merge:tags:1-2');
  assert.strictEqual(merge.to.name, 'invoice');
  assert.strictEqual(merge.from[0].name, 'Invoices');
  assert.strictEqual(merge.headline, 'Merge Invoices into invoice');
  assert.match(merge.reason, /Same word in singular and plural\./);
  assert.match(
    merge.reason,
    /12 documents move to invoice, which already has 240 documents\./
  );
  assert.ok(!/\d+ ?%/.test(merge.reason), 'no percentage in a sentence');
  assert.ok(!/exact-normalized|plural\b(?!\.)/.test(merge.headline));
  assert.strictEqual(merge.status, 'open');
  assert.deepStrictEqual(merge.details.rules, ['plural', 'exact-normalized']);

  const unsurePair = suggestions.fromDuplicateGroup(
    group({
      reasons: ['fuzzy'],
      confidence: 0.8,
      members: [
        { id: 3, name: 'Kontoauszug', documentCount: 86 },
        { id: 4, name: 'Kontoumzug', documentCount: 3 },
      ],
      suggestedTargetId: 3,
      aiVerdict: {
        verdict: 'different',
        confidence: 'high',
        reason:
          'one holds bank statements, the other letters about moving an account',
        source: 'model',
      },
    })
  );
  assert.strictEqual(unsurePair.certainty, 'unsure');
  assert.strictEqual(
    unsurePair.headline,
    'Are Kontoumzug and Kontoauszug the same thing?'
  );
  assert.match(unsurePair.reason, /usually a typo/);
  assert.match(unsurePair.reason, /thinks they are different/);

  // --- delete and split ---------------------------------------------
  const del = suggestions.fromUnusedEntity(
    { id: 9, name: 'tmp', documentCount: 0 },
    'tags'
  );
  assert.strictEqual(del.kind, 'delete');
  assert.strictEqual(del.certainty, 'sure');
  assert.strictEqual(del.headline, 'Delete the tag tmp');

  const split = suggestions.fromOrderMember({
    tagId: 7,
    tagName: 'Rechnung Auto',
    documentCount: 31,
    action: 'split',
    typeName: 'Rechnung',
    topicNames: ['Auto'],
    source: 'model',
    confidence: 'high',
    reason: '',
  });
  assert.strictEqual(split.kind, 'split');
  assert.strictEqual(split.certainty, 'likely');
  assert.strictEqual(
    split.headline,
    'Split Rechnung Auto into a type and a topic'
  );
  assert.match(
    split.reason,
    /what the document is \(Rechnung\) and what it is about \(Auto\)/
  );
  assert.strictEqual(
    suggestions.fromOrderMember({ tagId: 1, tagName: 'x', action: 'keep' }),
    null
  );
  const ruleSplit = suggestions.fromOrderMember({
    tagId: 8,
    tagName: 'Vertrag Strom',
    documentCount: 2,
    action: 'split',
    typeName: 'Vertrag',
    topicNames: ['Strom'],
    source: 'rule',
    confidence: 'high',
  });
  assert.strictEqual(ruleSplit.certainty, 'sure');

  // --- summary ------------------------------------------------------
  const summary = suggestions.summarize([
    merge,
    unsurePair,
    del,
    split,
    { ...del, id: 'x', status: 'done' },
  ]);
  assert.strictEqual(summary.total, 5);
  assert.strictEqual(summary.open, 4);
  assert.strictEqual(summary.sure, 2);
  assert.strictEqual(summary.unsure, 1);
  assert.strictEqual(summary.likely, 1);
  assert.strictEqual(summary.merge, 2);
  assert.strictEqual(summary.done, 1);

  // --- evidence and order (added with the run service) ---------------
  const evidence = suggestions.evidenceFromMembers(
    [
      { id: 4, name: 'Kontoumzug', documentCount: 1, titles: ['Moving'] },
      {
        id: 3,
        name: 'Kontoauszug',
        documentCount: 2,
        titles: ['A', 'B', 'C', 'D'],
        neighbours: ['Bank', '', 'Sparkasse'],
      },
    ],
    3
  );
  assert.deepStrictEqual(
    evidence.sides.map((side) => side.name),
    ['Kontoauszug', 'Kontoumzug'],
    'the proposed survivor comes first'
  );
  assert.deepStrictEqual(evidence.sides[0].titles, ['A', 'B', 'C']);
  assert.deepStrictEqual(evidence.sides[0].neighbours, ['Bank', 'Sparkasse']);
  assert.deepStrictEqual(evidence.sides[1].neighbours, []);
  assert.deepStrictEqual(Object.keys(evidence.sides[1]).sort(), [
    'documentCount',
    'id',
    'name',
    'neighbours',
    'titles',
  ]);
  const ordered = suggestions.sortSuggestions([del, split, unsurePair, merge]);
  assert.deepStrictEqual(
    ordered.map((s) => s.kind),
    ['merge', 'merge', 'split', 'delete']
  );
  assert.strictEqual(ordered[0].certainty, 'sure', 'sure merges first');

  // --- wording -------------------------------------------------------
  assert.strictEqual(wording.certaintyLabel('unsure'), 'Needs a look');
  for (const key of Object.keys(wording.RULE_CLAUSES)) {
    assert.ok(wording.ruleClause([key], 'tags').length > 20, key);
    assert.ok(wording.ruleClause([key], 'correspondents').length > 20, key);
  }
  assert.strictEqual(wording.ruleClause(['nope'], 'tags'), '');
  assert.deepStrictEqual(
    wording.RUN_STEPS.map((s) => s.key),
    ['compare', 'evidence', 'judge', 'split', 'sort']
  );
  assert.match(
    wording.stepDetail('compare', {
      done: true,
      names: 550,
      sure: 9,
      open: 23,
    }),
    /550 names · 9 sure matches · 23 pairs/
  );
  assert.strictEqual(
    wording.runHeadline('running'),
    'Looking for suggestions…'
  );

  for (const kind of Object.values(failure.FAILURE_KINDS)) {
    const notice = wording.failureNotice(kind, {
      model: 'qwen3:8b',
      pairsAffected: 9,
      pairsFine: 14,
      budget: 200000,
      pairsLeft: 5,
      pairs: 23,
      pairsJudged: 18,
      answerTokens: 1000,
      endpoint: 'Ollama at http://ollama:11434',
    });
    assert.ok(notice.title.length > 10, kind);
    assert.ok(notice.body.length > 20, kind);
    assert.ok(
      Array.isArray(notice.actions) && notice.actions.length >= 1,
      kind
    );
    assert.ok(
      !/json/i.test(notice.title + notice.body),
      `${kind}: no JSON talk in a notice`
    );
  }
  assert.match(
    wording.failureNotice('unreadable', { model: 'qwen3:8b', pairsAffected: 9 })
      .title,
    /qwen3:8b answered, but not in a form/
  );

  // --- failure classification ---------------------------------------
  const c = failure.classifyFailure;
  assert.strictEqual(
    c(new Error('the answer contained no JSON array')).kind,
    'unreadable'
  );
  assert.strictEqual(
    c(new Error('the model answered nothing')).kind,
    'unreadable'
  );
  assert.strictEqual(
    c(new Error('connect ECONNREFUSED 172.18.0.4:11434')).kind,
    'unreachable'
  );
  assert.strictEqual(c(new Error('Request timed out')).kind, 'unreachable');
  assert.strictEqual(
    c(Object.assign(new Error('x'), { status: 401 })).kind,
    'rejected'
  );
  assert.strictEqual(
    c(Object.assign(new Error('x'), { status: 503 })).kind,
    'unreachable'
  );
  assert.strictEqual(
    c('anything', { stopReason: 'token-budget' }).kind,
    'budget'
  );
  assert.strictEqual(c('anything', { stopReason: 'user' }).kind, 'stopped');
  assert.strictEqual(
    c(failure.tagFailure(new Error('weird'), 'thinking')).kind,
    'thinking'
  );
  assert.strictEqual(
    c(new Error('Paperless-ngx returned 500')).kind,
    'paperless'
  );
  assert.strictEqual(
    c(new Error('Paperless-ngx could not be reached: ECONNREFUSED')).kind,
    'paperless'
  );
  assert.strictEqual(c(new Error('something odd')).kind, 'unknown');
  assert.strictEqual(c(new Error('boom')).message, 'boom');

  // --- router mounted -----------------------------------------------
  const h = await mountRouter({ env: {} });
  Object.assign(h.app.locals, SHELL_LOCALS);
  try {
    const headers = { 'x-api-key': 'test-api-key' };
    const page = await fetch(h.base + '/tidy-up', { headers });
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-tidy-page/);
    const api = await fetch(h.base + '/api/tidy-up/suggestions', { headers });
    assert.ok(
      [200, 501].includes(api.status),
      `suggestions answered ${api.status}`
    );
    const anon = await fetch(h.base + '/api/tidy-up/suggestions', {
      redirect: 'manual',
    });
    assert.ok(
      [401, 403, 302].includes(anon.status),
      `unauthenticated got ${anon.status}`
    );
  } finally {
    await h.close();
  }

  // --- the three modules stay pure ----------------------------------
  for (const file of ['tidyUpSuggestions', 'tidyUpWording', 'modelFailure']) {
    const src = require('fs').readFileSync(
      path.join(__dirname, '..', 'services', `${file}.js`),
      'utf8'
    );
    assert.ok(
      !/require\('(axios|openai|\.\/paperlessService|\.\.\/models)/.test(src),
      `${file} must not do I/O`
    );
  }

  console.log('[PASS] tidy-up-contract');
}

run().catch((error) => {
  console.error('[FAIL] tidy-up-contract', error);
  process.exit(1);
});
