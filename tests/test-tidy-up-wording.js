'use strict';

/**
 * services/tidyUpWording.js: every sentence the Tidy up page says, read the
 * way a person would read it.
 *
 * Cases:
 *  1. failureNotice() for every failure kind, with no context and with all of
 *     it (and the variants in between): no "undefined", no "NaN", no double
 *     spaces, no "0 pairs", no technical words, every body sentence ends with
 *     a full stop, titles are headlines without one
 *  2. stepDetail() for every step with no, zero and full counts
 *  3. unansweredReason() and the verdict clause of a failed request
 *  4. The suggestion sentences with one and with many documents
 *  5. recentChangeSentence() for merge, delete, split, rename, undone, a
 *     failed undo and a partial change
 */

const assert = require('assert');
const wording = require('../services/tidyUpWording');
const { FAILURE_KINDS } = require('../services/modelFailure');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed += 1;
  }
}

/** What no text a person reads may contain. */
function assertReadable(text, where) {
  const value = String(text);
  assert.ok(!/undefined|NaN|\bnull\b/.test(value), `${where}: "${value}"`);
  assert.ok(!/ {2}/.test(value), `${where}: double space in "${value}"`);
  assert.ok(
    !/(^|[^\d,.])0 (pairs?|tags?|documents?|requests?|names?|tokens?|correspondents?)\b/.test(
      value
    ),
    `${where}: a zero count in "${value}"`
  );
  assert.ok(
    !/json|parse|regex|stack/i.test(value),
    `${where}: technical words in "${value}"`
  );
  assert.ok(!/please|sorry|!/i.test(value), `${where}: tone in "${value}"`);
  assert.ok(!/\s[.,;]/.test(value), `${where}: space before punctuation`);
}

/** Every sentence ends with a full stop (a quote may close after it). */
function assertSentences(text, where) {
  assert.ok(String(text).trim() !== '', `${where}: empty`);
  assert.match(
    String(text),
    /\.$/,
    `${where}: "${text}" ends without a full stop`
  );
}

const FULL = {
  model: 'qwen3:8b',
  endpoint: 'Ollama at http://ollama:11434',
  provider: 'OpenAI',
  status: 401,
  pairsAffected: 9,
  tagsAffected: 50,
  pairsFine: 14,
  budget: 200000,
  pairs: 23,
  pairsJudged: 18,
  pairsLeft: 5,
  answerTokens: 1000,
  thinkingOn: true,
  stopReason: 'idle',
};

const VARIANTS = [
  {},
  FULL,
  { model: 'qwen3:8b' },
  { pairsAffected: 1, pairsFine: 1, pairsLeft: 1, pairs: 1, pairsJudged: 0 },
  { pairsAffected: 0, pairsFine: 0, budget: 0, answerTokens: 0, pairs: 0 },
  { pairsAffected: NaN, budget: 'lots', answerTokens: undefined, pairs: null },
  { tagsAffected: 1 },
  { status: 404, model: 'qwen3:8b' },
  { status: 429, provider: 'OpenAI' },
  { status: 403 },
  { stopReason: 'user' },
];

test('Every failure notice reads well with and without its counts', () => {
  for (const kind of Object.values(FAILURE_KINDS)) {
    for (const context of VARIANTS) {
      const where = `${kind} ${JSON.stringify(context)}`;
      const notice = wording.failureNotice(kind, context);
      assert.deepStrictEqual(
        Object.keys(notice).sort(),
        ['actions', 'body', 'settingsHint', 'title'],
        where
      );
      assertReadable(notice.title, `${where} title`);
      assert.ok(notice.title.length > 10, `${where}: title`);
      assert.ok(!/\.$/.test(notice.title), `${where}: a title is a headline`);
      assertReadable(notice.body, `${where} body`);
      assertSentences(notice.body, `${where} body`);
      assert.ok(notice.actions.length >= 1, `${where}: actions`);
      for (const action of notice.actions) {
        assert.match(action.key, /^[a-z-]+$/, where);
        assertReadable(action.label, `${where} action`);
        assert.ok(action.label.length > 2, where);
      }
      if (notice.settingsHint !== null) {
        assertReadable(notice.settingsHint, `${where} hint`);
      }
    }
  }
});

test('The notices say what the mockup says, and name what they know', () => {
  const n = wording.failureNotice;
  assert.strictEqual(
    n('unreadable', { model: 'qwen3:8b' }).title,
    'qwen3:8b answered, but not in a form Zettelrobbe could read'
  );
  assert.strictEqual(
    n('unreadable', {}).title,
    'The model answered, but not in a form Zettelrobbe could read'
  );
  assert.strictEqual(
    n('budget', { budget: 200000 }).title,
    'Stopped after 200,000 tokens, the limit you set for one run'
  );
  assert.strictEqual(
    n('unreachable', { endpoint: 'Ollama at http://ollama:11434' }).title,
    'Ollama at http://ollama:11434 did not answer'
  );
  assert.strictEqual(
    n('thinking', { model: 'qwen3:8b', answerTokens: 1000 }).title,
    'qwen3:8b used all 1,000 answer tokens on its reasoning and never reached the verdicts'
  );
  assert.strictEqual(
    n('thinking', { answerTokens: 1000 }).actions[0].label,
    'Try again with 4,000 answer tokens'
  );
  assert.match(
    n('unreadable', { pairsAffected: 9, pairsFine: 14 }).body,
    /The 9 pairs it was asked about are marked "needs a look", so you can decide them yourself\. The other 14 pairs were answered fine\.$/
  );
  assert.match(
    n('unreadable', { pairsAffected: 1 }).body,
    /The pair it was asked about is marked "needs a look", so you can decide it yourself\.$/
  );
  assert.match(
    n('unreadable', { tagsAffected: 50 }).body,
    /The 50 tags it was asked about stay as they are\.$/
  );
  assert.match(
    n('budget', { pairs: 23, pairsJudged: 18, pairsLeft: 5 }).body,
    /^18 of 23 pairs were judged/
  );
  assert.strictEqual(
    n('budget', { pairsLeft: 5 }).actions[0].label,
    'Continue with the 5'
  );

  // rejected: the title names the provider, the body what to check.
  assert.strictEqual(
    n('rejected', { provider: 'OpenAI', status: 401 }).title,
    'OpenAI did not accept the API key'
  );
  assert.strictEqual(
    n('rejected', { provider: 'OpenAI', status: 429 }).title,
    'OpenAI says the quota or the rate limit is used up'
  );
  assert.strictEqual(
    n('rejected', { status: 404 }).title,
    'The AI provider does not know the model'
  );
  assert.match(
    n('rejected', { status: 404, model: 'qwen3:8b' }).body,
    /Check the model name \(qwen3:8b\)/
  );
  assert.match(
    n('rejected', {}).body,
    /Check the API key, the model name and the account's quota/
  );
  assert.strictEqual(n('rejected', {}).settingsHint, 'AI provider settings');
  assert.deepStrictEqual(n('rejected', {}).actions, [
    { key: 'retry', label: 'Try again' },
  ]);

  // stopped: a closed page says so.
  assert.strictEqual(
    n('stopped', { stopReason: 'idle' }).title,
    'Stopped because the page was closed'
  );
  assert.match(
    n('stopped', { stopReason: 'idle' }).body,
    /^Nobody was watching the run/
  );
  assert.strictEqual(n('stopped', {}).title, 'Stopped before the end');
  assert.strictEqual(n('nonsense', {}).title, 'The run could not finish');
});

test('Every step detail reads well with no, zero and full counts', () => {
  const contexts = [
    {},
    { done: true },
    {
      done: true,
      names: 0,
      sure: 0,
      open: 0,
      pairs: 0,
      requestsDone: 0,
      requestsPlanned: 0,
      pairsJudged: 0,
      tags: 0,
      suggestions: 0,
    },
    {
      done: true,
      names: 550,
      sure: 9,
      open: 23,
      pairs: 23,
      requestsDone: 3,
      requestsPlanned: 6,
      pairsJudged: 14,
      tags: 31,
      suggestions: 14,
      model: 'qwen3:8b',
    },
    {
      names: 1,
      sure: 1,
      open: 1,
      pairs: 1,
      requestsPlanned: 1,
      tags: 1,
      suggestions: 1,
      done: true,
    },
    { names: NaN, pairs: 'x', requestsPlanned: undefined, model: 'qwen3:8b' },
  ];
  for (const step of wording.RUN_STEPS) {
    for (const context of contexts) {
      const detail = wording.stepDetail(step.key, context);
      assert.strictEqual(typeof detail, 'string');
      assertReadable(detail, `${step.key} ${JSON.stringify(context)}`);
      assert.ok(!/^ · | · $/.test(detail), `${step.key}: dangling separator`);
    }
  }
  const full = contexts[3];
  assert.strictEqual(
    wording.stepDetail('compare', full),
    "550 names · 9 sure matches · 23 pairs spelling can't settle"
  );
  assert.strictEqual(
    wording.stepDetail('judge', full),
    'request 3 of 6 · 14 of 23 pairs answered'
  );
  assert.strictEqual(
    wording.stepDetail('judge', { requestsPlanned: 6 }),
    '6 requests planned'
  );
  assert.strictEqual(
    wording.stepDetail('judge', { model: 'qwen3:8b' }),
    'with qwen3:8b'
  );
  assert.strictEqual(
    wording.stepDetail('compare', contexts[4]),
    "1 name · 1 sure match · 1 pair spelling can't settle"
  );
  assert.strictEqual(wording.stepDetail('evidence', {}), 'from Paperless-ngx');
  assert.strictEqual(wording.stepDetail('split', { tags: 31 }), '31 tags');
  assert.strictEqual(
    wording.stepDetail('sort', { suggestions: 14 }),
    '14 suggestions'
  );
  assert.strictEqual(wording.stepDetail('compare', {}), '');
});

test('A pair whose request failed says so, in words', () => {
  for (const kind of Object.values(FAILURE_KINDS)) {
    const reason = wording.unansweredReason(kind);
    assertReadable(reason, kind);
    assertSentences(reason, kind);
    assert.match(reason, /decide this one yourself\.$/, kind);
  }
  assert.strictEqual(
    wording.unansweredReason('nope'),
    wording.unansweredReason('unknown')
  );
  const failedVerdict = {
    verdict: 'unsure',
    reason: wording.unansweredReason('thinking'),
    source: 'model',
    failureKind: 'thinking',
  };
  assert.strictEqual(
    wording.verdictClause(failedVerdict),
    'The model spent its answer on reasoning and gave no verdict; decide this one yourself.',
    'no "the model could not tell" for a model that never answered'
  );
  assert.strictEqual(
    wording.verdictClause({ verdict: 'unsure', reason: '', source: 'model' }),
    'The model could not tell from how they are used.'
  );
  assert.strictEqual(
    wording.verdictClause({
      verdict: 'same',
      confidence: 'high',
      reason: 'same word',
      source: 'model',
    }),
    'The model looked at how both are used and says they are the same. Same word.'
  );
  assert.strictEqual(
    wording.verdictClause({ verdict: 'same', source: 'spelling-rule' }),
    ''
  );
  // The model's own reason is a sentence of its own: capitalised, one stop.
  assert.strictEqual(
    wording.verdictClause({
      verdict: 'different',
      reason: 'one is a bank statement, the other a letter about moving..',
      source: 'model',
    }),
    'The model looked at how both are used and thinks they are different. One is a bank statement, the other a letter about moving.'
  );
  assert.match(
    wording.mergeReason({ modelReason: 'same company', from: [], to: null }),
    /^Same company\.$/
  );
  assert.match(
    wording.splitReason({
      from: [{ name: 'x', documentCount: 2 }],
      modelReason: 'two jobs in one tag',
    }),
    /^Two jobs in one tag\. /
  );
  assert.match(
    wording.deleteReason({
      from: [{ name: 'x' }],
      entityKind: 'tags',
      modelReason: 'never used',
    }),
    /^Never used\. /
  );
});

test('The suggestion sentences count right and end right', () => {
  for (const [key, clauses] of Object.entries(wording.RULE_CLAUSES)) {
    for (const clause of Object.values(clauses)) {
      assertReadable(clause, key);
      assertSentences(clause, key);
    }
  }
  const to = { id: 1, name: 'invoice', documentCount: 240 };
  assert.match(
    wording.mergeReason({
      entityKind: 'tags',
      rules: ['plural'],
      from: [{ name: 'Invoices', documentCount: 1 }],
      to,
    }),
    /1 document moves to invoice, which already has 240 documents\.$/
  );
  assert.match(
    wording.mergeReason({
      entityKind: 'tags',
      rules: [],
      from: [{ name: 'x' }],
      to: { name: 'y' },
    }),
    /^No documents move to y, which already has none\.$/
  );
  assert.match(
    wording.splitReason({
      from: [{ name: 'Rechnung Auto', documentCount: 1 }],
      typeName: 'Rechnung',
      topicNames: ['Auto'],
    }),
    /1 document gets the new names/
  );
  assert.match(
    wording.splitReason({
      from: [{ name: 'x', documentCount: 0 }],
      typeName: 'Rechnung',
    }),
    /No document carries the tag yet/
  );
  assert.strictEqual(
    wording.deleteHeadline({ from: [], entityKind: 'tags' }),
    'Delete the tags nobody uses'
  );
  for (const text of [
    wording.mergeReason({}),
    wording.splitReason({}),
    wording.deleteReason({}),
    wording.deleteReason({
      from: [{ name: 'a' }, { name: 'b' }],
      entityKind: 'correspondents',
    }),
  ]) {
    assertReadable(text, text);
  }
});

test('recentChangeSentence: one row of the merge log in a sentence', () => {
  const row = (extra) => ({
    id: 1,
    kind: 'tags',
    targetId: 1,
    targetName: 'invoice',
    sources: [{ id: 2, name: 'Invoices', documentsMoved: 12 }],
    documentsMoved: 12,
    status: 'done',
    action: 'merge',
    targetRenamedFrom: null,
    undoneAt: null,
    ...extra,
  });
  const cases = [
    [row(), 'Merged Invoices into invoice · 12 documents moved', 'done', true],
    [
      row({
        sources: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
        documentsMoved: 1,
      }),
      'Merged A, B and C into invoice · 1 document moved',
      'done',
      true,
    ],
    [
      row({ targetRenamedFrom: 'Invoice' }),
      'Merged Invoices into invoice (formerly Invoice) · 12 documents moved',
      'done',
      true,
    ],
    [
      row({ documentsMoved: 0 }),
      'Merged Invoices into invoice · no documents moved',
      'done',
      true,
    ],
    [
      row({
        action: 'delete',
        targetName: '',
        sources: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
        documentsMoved: 0,
      }),
      'Deleted 4 unused tags',
      'done',
      true,
    ],
    [
      row({
        action: 'delete',
        kind: 'correspondents',
        targetName: '',
        sources: [{ name: 'Old Bank' }],
      }),
      'Deleted the unused correspondent Old Bank',
      'done',
      true,
    ],
    [
      row({
        action: 'split',
        targetId: 0,
        targetName: 'Rechnung + Auto',
        sources: [{ name: 'Rechnung Auto' }],
      }),
      'Split Rechnung Auto into Rechnung + Auto',
      'done',
      true,
    ],
    [
      row({
        action: 'rename',
        targetName: 'Deutsche Telekom',
        sources: [],
        targetRenamedFrom: 'Telekom',
      }),
      'Renamed Telekom to Deutsche Telekom',
      'done',
      true,
    ],
    [
      row({
        sources: [],
        targetName: 'Deutsche Telekom',
        targetRenamedFrom: 'Telekom',
      }),
      'Renamed Telekom to Deutsche Telekom',
      'done',
      true,
    ],
    [
      row({ status: 'undone', undoneAt: '2026-11-08T09:12:00Z' }),
      'Merged Invoices into invoice · 12 documents moved · undone',
      'undone',
      false,
    ],
    [
      row({ status: 'undo_failed' }),
      'Merged Invoices into invoice · 12 documents moved · undo failed',
      'failed',
      true,
    ],
    [
      row({
        action: 'split',
        status: 'partial',
        targetName: 'Rechnung',
        sources: [{ name: 'Rechnung Auto' }],
      }),
      'Split Rechnung Auto into Rechnung · partly done',
      'partial',
      true,
    ],
  ];
  for (const [entry, sentence, status, canUndo] of cases) {
    const said = wording.recentChangeSentence(entry);
    assert.strictEqual(said.sentence, sentence);
    assert.strictEqual(said.status, status, sentence);
    assert.strictEqual(said.canUndo, canUndo, sentence);
    assert.strictEqual(
      said.segments.map((s) => s.text).join(''),
      said.sentence
    );
    assertReadable(said.sentence, sentence);
  }
  const named = wording
    .recentChangeSentence(row())
    .segments.filter((s) => s.name);
  assert.deepStrictEqual(
    named.map((s) => s.text),
    ['Invoices', 'invoice'],
    'the names are marked, so the page can set them in bold'
  );
  for (const odd of [
    null,
    {},
    { action: 'split' },
    { action: 'delete' },
    { action: 'rename' },
  ]) {
    assertReadable(
      wording.recentChangeSentence(odd).sentence,
      JSON.stringify(odd)
    );
  }
});

test('activitySentence: what a decide or undo is doing, in a sentence', () => {
  const current = (headline, kind = 'merge') => ({
    id: 'x',
    ids: ['x'],
    kind,
    headline,
  });
  const cases = [
    [
      {
        kind: 'accept',
        total: 9,
        done: 1,
        current: current('Merge Invoices into invoice'),
      },
      'Merging Invoices into invoice… 2 of 9',
    ],
    [
      {
        kind: 'accept',
        total: 1,
        done: 0,
        current: current('Merge Invoices into invoice'),
      },
      'Merging Invoices into invoice…',
    ],
    [
      {
        kind: 'accept',
        total: 2,
        done: 0,
        current: current('Are Steuerberatr and Steuerberater the same thing?'),
      },
      'Merging Steuerberatr into Steuerberater… 1 of 2',
    ],
    [
      {
        kind: 'accept',
        total: 3,
        done: 2,
        current: current(
          'Split Rechnung Auto into a type and a topic',
          'split'
        ),
      },
      'Splitting Rechnung Auto into a type and a topic… 3 of 3',
    ],
    [
      {
        kind: 'accept',
        total: 4,
        done: 0,
        current: current('Delete 4 tags nobody uses', 'delete'),
      },
      'Deleting 4 tags nobody uses… 1 of 4',
    ],
    [
      {
        kind: 'accept',
        total: 2,
        done: 1,
        current: current(
          'Turn Vertrag into the document type Contract',
          'split'
        ),
      },
      'Turning Vertrag into the document type Contract… 2 of 2',
    ],
    [
      { kind: 'accept', total: 5, done: 5, current: null },
      'Carrying out 5 changes… 5 of 5',
    ],
    [
      {
        kind: 'decline',
        total: 1,
        done: 0,
        current: current('Merge A into B'),
      },
      'Declining…',
    ],
    [
      {
        kind: 'decline',
        total: 3,
        done: 1,
        current: current('Merge A into B'),
      },
      'Declining 3 suggestions… 2 of 3',
    ],
    [
      { kind: 'undo', total: 9, done: 3, current: current('Merge A into B') },
      'Undoing 9 changes… 4 of 9',
    ],
    [{ kind: 'undo', total: 1, done: 0, current: null }, 'Undoing the change…'],
  ];
  for (const [activity, expected] of cases) {
    assert.strictEqual(wording.activitySentence(activity), expected);
  }
  assert.strictEqual(wording.activitySentence(null), '');
  for (const odd of [
    {},
    { kind: 'accept' },
    { kind: 'accept', total: 0, done: 0, current: { headline: '' } },
    { kind: 'undo', total: 'x', done: null },
    { kind: 'rename', total: 2 },
  ]) {
    const said = wording.activitySentence(odd);
    assert.ok(said.length > 0, JSON.stringify(odd));
    assertReadable(said, JSON.stringify(odd));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
