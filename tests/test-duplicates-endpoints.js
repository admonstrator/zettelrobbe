/**
 * Test: the /duplicates routes in routes/setup.js
 *
 * The page and the merge service only ever meet through these endpoints, so
 * this suite pins the wire format: which status a refusal produces, where
 * `success: false` arrives with status 200 (a partial merge is not a failed
 * request), and that the log endpoint pages the way a table expects.
 *
 * The router runs for real on a throwaway database (tests/helpers/mount-router)
 * with the in-memory Paperless-ngx stand-in behind it, so a merge here does
 * the same work it does in production — only the HTTP client is replaced.
 *
 * Covers:
 *  1. Neither the page nor an API route answers without authentication
 *  2. GET /api/duplicates/scan returns a DuplicateScanResult with groups
 *  3. GET /api/duplicates/scan validates kind and threshold
 *  3a. GET /api/duplicates/entities lists one kind, sorted, and refuses the rest
 *  4. POST /api/duplicates/merge merges and answers with the result shape
 *  5. A partial merge answers 200 with success: false
 *  6. Merge validation is 400, an unknown entry is 404
 *  7. POST /api/duplicates/log/:id/undo undoes and marks the entry
 *  8. Undoing twice is 409, an unknown merge is 404
 *  9. dismiss -> dismissals -> delete round trip, and the scan honours it
 * 10. GET /api/duplicates/log pages and reports recordsTotal
 * 11. POST /api/duplicates/ai-review validates, passes its options on and
 *     hands the reviewed result through unchanged
 * 12. The targeting (groupIds, minConfidence, includeCandidates) reaches the
 *     service unchanged, an untargeted request still carries nothing extra,
 *     and a malformed targeting option is a 400
 */

'use strict';

const assert = require('assert');
const path = require('path');

const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');
const { createFakePaperless } = require('./helpers/fake-paperless');

const API_KEY = 'test-api-key';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed += 1;
  }
}

/** The store the routes talk to; swapped per case. */
const paperless = { fake: createFakePaperless({}) };

function useFake(seed) {
  paperless.fake = createFakePaperless(seed);
  return paperless.fake;
}

/**
 * Entity methods the harness stubs out for every other test. Here the real
 * implementations have to run, so the instance-level stubs are removed and
 * the prototype takes over again.
 */
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
  'clearEntityCaches',
];

async function main() {
  const harness = await mountRouter({
    stub: ({ paperlessService }) => {
      for (const method of REAL_ENTITY_METHODS) {
        delete paperlessService[method];
      }
      // One client that always forwards to the store of the current case.
      paperlessService.client = {
        defaults: { baseURL: 'http://paperless.test/api' },
        get: (url, config = {}) =>
          paperless.fake.handle('get', url, config.params || {}),
        post: (url, body) => paperless.fake.handle('post', url, {}, body),
        patch: (url, body) => paperless.fake.handle('patch', url, {}, body),
        delete: (url) => paperless.fake.handle('delete', url, {}),
      };
      paperlessService.getPublicBaseUrl = async () => 'https://paperless.test';
      const dashboardStatsService = require(
        path.join(REPO_ROOT, 'services', 'dashboardStatsService')
      );
      dashboardStatsService.refresh = async () => ({});
    },
  });

  const call = (method, url, body) =>
    fetch(harness.base + url, {
      method,
      redirect: 'manual',
      headers: {
        'x-api-key': API_KEY,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  try {
    await test('Neither the page nor an API route answers without authentication', async () => {
      const anonymous = await fetch(harness.base + '/api/duplicates/scan', {
        redirect: 'manual',
      });
      assert.strictEqual(anonymous.status, 302, 'no credentials -> /login');
      assert.strictEqual(anonymous.headers.get('location'), '/login');

      const anonymousEntities = await fetch(
        harness.base + '/api/duplicates/entities?kind=tags',
        { redirect: 'manual' }
      );
      assert.strictEqual(anonymousEntities.status, 302);
      assert.strictEqual(anonymousEntities.headers.get('location'), '/login');

      const anonymousPage = await fetch(harness.base + '/duplicates', {
        redirect: 'manual',
      });
      assert.strictEqual(anonymousPage.status, 302);
      assert.strictEqual(anonymousPage.headers.get('location'), '/login');

      // The page needs a session, an API key is not enough — same guard the
      // other pages use.
      const withApiKey = await call('GET', '/duplicates');
      assert.strictEqual(withApiKey.status, 401);
    });

    await test('GET /api/duplicates/scan returns groups, totals and the URL', async () => {
      useFake({
        tags: [
          { id: 1, name: 'Amazon' },
          { id: 2, name: 'amazon' },
          { id: 3, name: 'Bank' },
        ],
        correspondents: [{ id: 10, name: 'Müller GmbH' }],
        documents: [
          { id: 100, tags: [1] },
          { id: 101, tags: [2] },
        ],
      });

      const response = await call('GET', '/api/duplicates/scan?kind=all');
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.strictEqual(payload.success, true);
      assert.deepStrictEqual(payload.data.totals, {
        tags: 3,
        correspondents: 1,
      });
      assert.strictEqual(payload.data.threshold, 0.85);
      assert.strictEqual(payload.data.paperlessUrl, 'https://paperless.test');
      assert.strictEqual(payload.data.dismissedPairs, 0);
      assert.strictEqual(payload.data.groups.length, 1);

      const group = payload.data.groups[0];
      assert.strictEqual(group.kind, 'tags');
      assert.strictEqual(group.id, 'tags:1-2');
      assert.strictEqual(group.suggestedTargetId, 1, 'more documents wins');
      assert.strictEqual(group.confidence, 1);
      assert.deepStrictEqual(group.reasons, ['exact-normalized']);
      assert.strictEqual(group.members.length, 2);
      assert.strictEqual(group.members[0].id, 1, 'the target comes first');
      assert.strictEqual(group.members[0].scoreToTarget, 1);
      assert.strictEqual(group.members[1].reason, 'exact-normalized');

      const single = await call('GET', '/api/duplicates/scan?kind=tags');
      const singlePayload = await single.json();
      assert.deepStrictEqual(singlePayload.data.totals, {
        tags: 3,
        correspondents: null,
      });
    });

    await test('GET /api/duplicates/scan validates kind and threshold', async () => {
      for (const query of [
        '?kind=document_types',
        '?threshold=0.2',
        '?threshold=2',
        '?threshold=abc',
      ]) {
        const response = await call('GET', `/api/duplicates/scan${query}`);
        assert.strictEqual(response.status, 400, `expected 400 for ${query}`);
        const payload = await response.json();
        assert.strictEqual(payload.success, false);
        assert.ok(payload.error, 'a reason is given');
      }
    });

    await test('GET /api/duplicates/entities lists one kind, sorted by name', async () => {
      // The list endpoint is the only one that does nothing but pass records
      // through, so the sort is the whole behaviour worth pinning. The store
      // behind the harness already answers `ordering=name` case sensitively,
      // which is exactly what must not decide the order here.
      const unsorted = [
        { id: 3, name: 'amazon', documentCount: 2, userCanChange: true },
        { id: 1, name: 'Zürich', documentCount: 9, userCanChange: false },
        { id: 2, name: 'Amazon', documentCount: 41, userCanChange: true },
      ];
      harness.paperlessService.listEntities = async () => [...unsorted];
      try {
        const response = await call(
          'GET',
          '/api/duplicates/entities?kind=tags'
        );
        assert.strictEqual(response.status, 200);
        const payload = await response.json();
        assert.strictEqual(payload.success, true);
        assert.deepStrictEqual(
          payload.data.map((record) => record.name),
          ['Amazon', 'amazon', 'Zürich'],
          'case decides nothing, the id breaks the tie'
        );
        assert.deepStrictEqual(payload.data[0], {
          id: 2,
          name: 'Amazon',
          documentCount: 41,
          userCanChange: true,
        });
      } finally {
        delete harness.paperlessService.listEntities;
      }
    });

    await test('GET /api/duplicates/entities needs a known kind', async () => {
      for (const query of ['', '?kind=', '?kind=all', '?kind=document_types']) {
        const response = await call('GET', `/api/duplicates/entities${query}`);
        assert.strictEqual(response.status, 400, `expected 400 for "${query}"`);
        const payload = await response.json();
        assert.strictEqual(payload.success, false);
        assert.ok(payload.error, 'a reason is given');
      }
    });

    await test('GET /api/duplicates/entities answers 502 when Paperless-ngx is unreachable', async () => {
      harness.paperlessService.listEntities = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), {
          code: 'ECONNREFUSED',
        });
      };
      try {
        const response = await call(
          'GET',
          '/api/duplicates/entities?kind=correspondents'
        );
        assert.strictEqual(response.status, 502);
        const payload = await response.json();
        assert.strictEqual(payload.success, false);
        assert.match(
          payload.error,
          /ECONNREFUSED/,
          'the reason survives into the answer'
        );
      } finally {
        delete harness.paperlessService.listEntities;
      }
    });

    let mergeId = null;
    await test('POST /api/duplicates/merge merges and answers with the result', async () => {
      const fake = useFake({
        tags: [
          { id: 12, name: 'Invoices' },
          { id: 48, name: 'invoices' },
        ],
        documents: [
          { id: 200, tags: [48] },
          { id: 201, tags: [48, 12] },
        ],
      });

      const response = await call('POST', '/api/duplicates/merge', {
        kind: 'tags',
        targetId: 12,
        sourceIds: [48],
        copyMatchingRule: false,
      });
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.data.status, 'done');
      assert.strictEqual(payload.data.documentsMoved, 2);
      assert.deepStrictEqual(payload.data.target, { id: 12, name: 'Invoices' });
      assert.strictEqual(payload.data.sources[0].deleted, true);
      assert.ok(payload.message, 'a message for the toast');
      assert.strictEqual(fake.tag(48), undefined);
      mergeId = payload.data.mergeId;
      assert.ok(Number.isInteger(mergeId) && mergeId > 0);

      const performedBy =
        await harness.documentModel.getEntityMergeById(mergeId);
      assert.strictEqual(
        performedBy.performedBy,
        'api-key',
        'an API key request is recorded as api-key'
      );
    });

    await test('POST /api/duplicates/log/:id/undo undoes the merge', async () => {
      const fake = paperless.fake;
      const response = await call(
        'POST',
        `/api/duplicates/log/${mergeId}/undo`
      );
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.data.status, 'undone');
      const restoredId = payload.data.sources[0].restoredId;
      assert.ok(restoredId > 0);
      assert.strictEqual(fake.tag(restoredId).name, 'invoices');
      assert.deepStrictEqual(fake.document(200).tags, [restoredId]);
      assert.deepStrictEqual(
        fake.document(201).tags.sort((a, b) => a - b),
        [12, restoredId].sort((a, b) => a - b)
      );

      const again = await call('POST', `/api/duplicates/log/${mergeId}/undo`);
      assert.strictEqual(again.status, 409, 'a second undo is refused');
      const unknown = await call('POST', '/api/duplicates/log/999999/undo');
      assert.strictEqual(unknown.status, 404);
      const invalid = await call('POST', '/api/duplicates/log/abc/undo');
      assert.strictEqual(invalid.status, 400);
    });

    await test('A partial merge answers 200 with success: false', async () => {
      const fake = useFake({
        tags: [
          { id: 20, name: 'Receipts' },
          { id: 21, name: 'receipts' },
        ],
        documents: [
          { id: 300, tags: [21] },
          { id: 301, tags: [21] },
        ],
        bulkEditIgnores: [301],
      });

      const response = await call('POST', '/api/duplicates/merge', {
        kind: 'tags',
        targetId: 20,
        sourceIds: [21],
      });
      assert.strictEqual(response.status, 200, 'the request itself worked');
      const payload = await response.json();
      assert.strictEqual(payload.success, false);
      assert.strictEqual(payload.data.status, 'partial');
      assert.strictEqual(payload.data.sources[0].deleted, false);
      assert.ok(fake.tag(21), 'the source survives');
    });

    await test('Merge validation is 400, an unknown entry is 404', async () => {
      useFake({
        tags: [
          { id: 30, name: 'Health' },
          { id: 31, name: 'health' },
        ],
      });

      const cases = [
        [{ kind: 'document_types', targetId: 30, sourceIds: [31] }, 400],
        [{ kind: 'tags', targetId: 30, sourceIds: [] }, 400],
        [{ kind: 'tags', targetId: 30, sourceIds: [30] }, 400],
        [{}, 400],
        [{ kind: 'tags', targetId: 30, sourceIds: [4711] }, 404],
        [{ kind: 'tags', targetId: 4711, sourceIds: [31] }, 404],
      ];
      for (const [body, status] of cases) {
        const response = await call('POST', '/api/duplicates/merge', body);
        assert.strictEqual(
          response.status,
          status,
          `expected ${status} for ${JSON.stringify(body)}`
        );
        const payload = await response.json();
        assert.strictEqual(payload.success, false);
        assert.ok(payload.error);
      }
    });

    await test('dismiss -> dismissals -> delete, and the scan honours it', async () => {
      useFake({
        tags: [
          { id: 40, name: 'Travel' },
          { id: 41, name: 'travel' },
        ],
      });

      const dismissed = await call('POST', '/api/duplicates/dismiss', {
        kind: 'tags',
        ids: [40, 41],
        names: { 40: 'Travel', 41: 'travel' },
      });
      assert.strictEqual(dismissed.status, 200);
      const dismissPayload = await dismissed.json();
      assert.strictEqual(dismissPayload.success, true);
      assert.strictEqual(dismissPayload.data.dismissed, 1);

      const again = await call('POST', '/api/duplicates/dismiss', {
        kind: 'tags',
        ids: [41, 40],
      });
      assert.strictEqual(
        (await again.json()).data.dismissed,
        0,
        'the same pair is not stored twice, whichever way round'
      );

      const tooFew = await call('POST', '/api/duplicates/dismiss', {
        kind: 'tags',
        ids: [40],
      });
      assert.strictEqual(tooFew.status, 400);

      const list = await call('GET', '/api/duplicates/dismissals?kind=tags');
      assert.strictEqual(list.status, 200);
      const listPayload = await list.json();
      assert.strictEqual(listPayload.data.length, 1);
      assert.strictEqual(listPayload.data[0].idA, 40);
      assert.strictEqual(listPayload.data[0].nameA, 'Travel');
      assert.strictEqual(listPayload.data[0].nameB, 'travel');

      const hidden = await call('GET', '/api/duplicates/scan?kind=tags');
      const hiddenPayload = await hidden.json();
      assert.strictEqual(hiddenPayload.data.groups.length, 0);
      assert.strictEqual(hiddenPayload.data.dismissedPairs, 1);

      const shown = await call(
        'GET',
        '/api/duplicates/scan?kind=tags&includeDismissed=true'
      );
      assert.strictEqual((await shown.json()).data.groups.length, 1);

      const badKind = await call('GET', '/api/duplicates/dismissals?kind=nope');
      assert.strictEqual(badKind.status, 400);

      const removed = await call(
        'DELETE',
        `/api/duplicates/dismissals/${listPayload.data[0].id}`
      );
      assert.strictEqual(removed.status, 200);
      assert.strictEqual((await removed.json()).success, true);

      const removedAgain = await call(
        'DELETE',
        `/api/duplicates/dismissals/${listPayload.data[0].id}`
      );
      assert.strictEqual(removedAgain.status, 404);

      const back = await call('GET', '/api/duplicates/scan?kind=tags');
      assert.strictEqual((await back.json()).data.groups.length, 1);
    });

    await test('GET /api/duplicates/log pages and reports recordsTotal', async () => {
      const before = await call('GET', '/api/duplicates/log?limit=100');
      const beforePayload = await before.json();
      const existing = beforePayload.recordsTotal;

      useFake({
        correspondents: [
          { id: 50, name: 'Amazon' },
          { id: 51, name: 'amazon' },
          { id: 52, name: 'AMAZON' },
        ],
        documents: [{ id: 400, correspondent: 51 }],
      });
      await call('POST', '/api/duplicates/merge', {
        kind: 'correspondents',
        targetId: 50,
        sourceIds: [51],
      });
      await call('POST', '/api/duplicates/merge', {
        kind: 'correspondents',
        targetId: 50,
        sourceIds: [52],
      });

      const page = await call('GET', '/api/duplicates/log?limit=1&offset=0');
      assert.strictEqual(page.status, 200);
      const payload = await page.json();
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.recordsTotal, existing + 2);
      assert.strictEqual(payload.data.length, 1);
      assert.strictEqual(payload.data[0].kind, 'correspondents');
      assert.ok(payload.data[0].createdAt, 'the row carries its timestamp');
      assert.ok(
        Array.isArray(payload.data[0].sources),
        'the JSON column arrives parsed'
      );

      const second = await call('GET', '/api/duplicates/log?limit=1&offset=1');
      const secondPayload = await second.json();
      assert.notStrictEqual(
        secondPayload.data[0].id,
        payload.data[0].id,
        'the offset moves'
      );

      const filtered = await call(
        'GET',
        '/api/duplicates/log?kind=correspondents&limit=100'
      );
      assert.strictEqual((await filtered.json()).recordsTotal, 2);

      const capped = await call('GET', '/api/duplicates/log?limit=5000');
      assert.strictEqual(
        capped.status,
        200,
        'the limit is capped, not refused'
      );

      const badKind = await call('GET', '/api/duplicates/log?kind=nope');
      assert.strictEqual(badKind.status, 400);
    });

    /* ── the AI review ────────────────────────────────────────────────────
       The judge itself lives in services/entityMatchAiService.js and has its
       own suite; what the route owns is the validation, the options it hands
       over and the statuses it maps back, so the service is stubbed here. */

    const entityMatchAiService = require(
      path.join(REPO_ROOT, 'services', 'entityMatchAiService')
    );
    const realReviewScan = entityMatchAiService.reviewScan;

    /** Verdicts and a candidate group, the way a finished review answers. */
    function reviewFixture() {
      return {
        scannedAt: '2026-09-18T10:00:00.000Z',
        threshold: 0.85,
        totals: { tags: 42, correspondents: null },
        dismissedPairs: 0,
        paperlessUrl: 'https://paperless.test',
        groups: [
          {
            id: 'tags:1-2',
            kind: 'tags',
            confidence: 0.92,
            reasons: ['fuzzy'],
            suggestedTargetId: 1,
            warnings: [],
            source: 'scan',
            aiVerdict: { verdict: 'same', reason: 'Only the case differs.' },
            members: [
              { id: 1, name: 'Invoices', scoreToTarget: 1, aiVerdict: null },
              {
                id: 2,
                name: 'invoices',
                scoreToTarget: 0.92,
                reason: 'fuzzy',
                aiVerdict: {
                  verdict: 'same',
                  reason: 'Only the case differs.',
                },
              },
            ],
          },
          {
            id: 'tags:7-9',
            kind: 'tags',
            confidence: 0.71,
            reasons: ['prefix'],
            suggestedTargetId: 7,
            warnings: [],
            source: 'ai-candidate',
            aiVerdict: { verdict: 'unsure', reason: 'Could be two things.' },
            members: [
              { id: 7, name: 'Bank', scoreToTarget: 1, aiVerdict: null },
              {
                id: 9,
                name: 'Bankauszug',
                scoreToTarget: 0.71,
                reason: 'prefix',
                aiVerdict: {
                  verdict: 'unsure',
                  reason: 'Could be two things.',
                },
              },
            ],
          },
        ],
        aiReview: {
          enabled: true,
          model: 'a-model',
          requests: 2,
          tokens: 1840,
          judged: 2,
          candidates: 1,
          failedRequests: 0,
          targeted: false,
          groupsJudged: 1,
          groupsSkipped: 0,
        },
      };
    }

    await test('POST /api/duplicates/ai-review needs authentication', async () => {
      const anonymous = await fetch(
        harness.base + '/api/duplicates/ai-review',
        {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }
      );
      assert.strictEqual(anonymous.status, 302, 'no credentials -> /login');
      assert.strictEqual(anonymous.headers.get('location'), '/login');
    });

    await test('POST /api/duplicates/ai-review validates kind and threshold', async () => {
      entityMatchAiService.reviewScan = async () => {
        throw new Error('the route must refuse before the service is asked');
      };
      try {
        for (const body of [
          { kind: 'documents' },
          { kind: 'document_types' },
          { threshold: 2 },
          { threshold: 0.2 },
          { threshold: 'abc' },
        ]) {
          const response = await call(
            'POST',
            '/api/duplicates/ai-review',
            body
          );
          assert.strictEqual(
            response.status,
            400,
            `expected 400 for ${JSON.stringify(body)}`
          );
          const payload = await response.json();
          assert.strictEqual(payload.success, false);
          assert.ok(payload.error, 'a reason is given');
        }
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
      }
    });

    await test('POST /api/duplicates/ai-review maps a switched-off review to 409', async () => {
      entityMatchAiService.reviewScan = async () => {
        throw Object.assign(new Error('The AI review is switched off'), {
          status: 409,
        });
      };
      try {
        const response = await call('POST', '/api/duplicates/ai-review', {});
        assert.strictEqual(response.status, 409);
        const payload = await response.json();
        assert.strictEqual(payload.success, false);
        assert.match(payload.error, /switched off/);
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
      }
    });

    await test('POST /api/duplicates/ai-review answers with verdicts and candidates', async () => {
      const seen = [];
      entityMatchAiService.reviewScan = async (options) => {
        seen.push(options);
        return reviewFixture();
      };
      try {
        const response = await call('POST', '/api/duplicates/ai-review', {
          kind: 'tags',
          threshold: 0.9,
          includeDismissed: true,
          withTitles: false,
        });
        assert.strictEqual(response.status, 200);
        const payload = await response.json();
        assert.strictEqual(payload.success, true);
        assert.deepStrictEqual(seen[0], {
          kind: 'tags',
          threshold: 0.9,
          includeDismissed: true,
          withTitles: false,
        });

        assert.strictEqual(payload.data.aiReview.judged, 2);
        assert.strictEqual(payload.data.aiReview.model, 'a-model');
        assert.strictEqual(payload.data.aiReview.failedRequests, 0);
        assert.strictEqual(payload.data.groups.length, 2);
        assert.strictEqual(payload.data.groups[0].source, 'scan');
        assert.strictEqual(payload.data.groups[0].aiVerdict.verdict, 'same');
        assert.strictEqual(payload.data.groups[1].source, 'ai-candidate');
        assert.strictEqual(
          payload.data.groups[1].members[1].aiVerdict.verdict,
          'unsure',
          'a member carries its own verdict'
        );

        // An empty body is the whole contract of the defaults: everything but
        // the titles is what the scan route defaults to, and the titles are on.
        const defaults = await call('POST', '/api/duplicates/ai-review', {});
        assert.strictEqual(defaults.status, 200);
        assert.deepStrictEqual(seen[1], {
          kind: 'all',
          threshold: 0.85,
          includeDismissed: false,
          withTitles: true,
        });
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
      }
    });

    await test('POST /api/duplicates/ai-review hands the targeting to the service unchanged', async () => {
      const seen = [];
      entityMatchAiService.reviewScan = async (options) => {
        seen.push(options);
        return {
          ...reviewFixture(),
          aiReview: {
            ...reviewFixture().aiReview,
            targeted: true,
            groupsJudged: 2,
            groupsSkipped: 38,
          },
        };
      };
      try {
        const response = await call('POST', '/api/duplicates/ai-review', {
          kind: 'tags',
          groupIds: ['tags:1-2', 'tags:7-9'],
          minConfidence: 0.95,
          includeCandidates: false,
        });
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(seen[0], {
          kind: 'tags',
          threshold: 0.85,
          includeDismissed: false,
          withTitles: true,
          groupIds: ['tags:1-2', 'tags:7-9'],
          minConfidence: 0.95,
          includeCandidates: false,
        });

        const payload = await response.json();
        assert.strictEqual(payload.data.aiReview.targeted, true);
        assert.strictEqual(payload.data.aiReview.groupsJudged, 2);
        assert.strictEqual(payload.data.aiReview.groupsSkipped, 38);

        // An untargeted request must reach the service the way it did before
        // the targeting existed: no keys it did not ask for.
        await call('POST', '/api/duplicates/ai-review', { kind: 'tags' });
        assert.deepStrictEqual(Object.keys(seen[1]).sort(), [
          'includeDismissed',
          'kind',
          'threshold',
          'withTitles',
        ]);

        // includeCandidates: true is a request the page makes explicitly.
        await call('POST', '/api/duplicates/ai-review', {
          includeCandidates: true,
          groupIds: [],
        });
        assert.strictEqual(seen[2].includeCandidates, true);
        assert.deepStrictEqual(seen[2].groupIds, []);
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
      }
    });

    await test('POST /api/duplicates/ai-review refuses a malformed targeting option', async () => {
      entityMatchAiService.reviewScan = async () => {
        throw new Error('the route must refuse before the service is asked');
      };
      try {
        for (const body of [
          { groupIds: 'tags:1-2' },
          { groupIds: { 0: 'tags:1-2' } },
          { groupIds: ['tags:1-2', 7] },
          { groupIds: ['tags:1-2', '  '] },
          { groupIds: new Array(501).fill('tags:1-2') },
          { minConfidence: 2 },
          { minConfidence: 0.2 },
          { minConfidence: 'high' },
          { includeCandidates: 'false' },
          { includeCandidates: 0 },
        ]) {
          const response = await call(
            'POST',
            '/api/duplicates/ai-review',
            body
          );
          assert.strictEqual(
            response.status,
            400,
            `expected 400 for ${JSON.stringify(body).slice(0, 80)}`
          );
          const payload = await response.json();
          assert.strictEqual(payload.success, false);
          assert.ok(payload.error, 'a reason is given');
        }
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
      }
    });

    await test('POST /api/duplicates/ai-review takes 500 group ids and refuses 501', async () => {
      const seen = [];
      entityMatchAiService.reviewScan = async (options) => {
        seen.push(options);
        return reviewFixture();
      };
      try {
        const ids = Array.from(
          { length: 500 },
          (_, index) => `tags:${index}-${index + 1}`
        );
        const ok = await call('POST', '/api/duplicates/ai-review', {
          groupIds: ids,
        });
        assert.strictEqual(ok.status, 200, '500 ids are still a request');
        assert.strictEqual(seen[0].groupIds.length, 500);

        const tooMany = await call('POST', '/api/duplicates/ai-review', {
          groupIds: [...ids, 'tags:500-501'],
        });
        assert.strictEqual(tooMany.status, 400);
        assert.match((await tooMany.json()).error, /500/);
        assert.strictEqual(seen.length, 1, 'the service was asked once');
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
      }
    });
  } finally {
    await harness.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
