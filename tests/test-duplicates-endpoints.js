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
 * 13. The review as a job: start, current, read, the event stream and the
 *     stop, plus the synchronous route running through that same job
 * 14. The scan route asks the service for a fresh scan, never a cached one
 * 15. A merge may rename the survivor: `targetName` reaches the service
 *     trimmed, an unchanged or blank one is not sent at all, and a name no
 *     object could carry is a 400
 * 16. POST /api/duplicates/delete: what it refuses, what it hands to the
 *     service, and the partial answer that is a 200 with success: false
 * 17. The log says what a row recorded (`action`) and what a merge renamed
 *     (`targetRenamedFrom`)
 * 18. The names the creation guard mapped: the list and the way to forget it
 * 19. `semanticSweep` reaches the review as the boolean it is, or not at all
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
          withExcerpts: true,
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
          withExcerpts: true,
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
          withExcerpts: true,
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
          'withExcerpts',
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

    await test('POST /api/duplicates/ai-review reads withExcerpts the way it reads withTitles', async () => {
      const seen = [];
      entityMatchAiService.reviewScan = async (options) => {
        seen.push(options);
        return {
          ...reviewFixture(),
          aiReview: { ...reviewFixture().aiReview, excerpts: 4 },
        };
      };
      try {
        const off = await call('POST', '/api/duplicates/ai-review', {
          withExcerpts: false,
        });
        assert.strictEqual(off.status, 200);
        assert.strictEqual(seen[0].withExcerpts, false);

        await call('POST', '/api/duplicates/ai-review', {
          withExcerpts: 'false',
        });
        assert.strictEqual(
          seen[1].withExcerpts,
          false,
          'a form sends its checkbox as a string'
        );

        const on = await call('POST', '/api/duplicates/ai-review', {
          withExcerpts: true,
        });
        assert.strictEqual(seen[2].withExcerpts, true);
        assert.strictEqual(
          (await on.json()).data.aiReview.excerpts,
          4,
          'and the result says how many entries were read'
        );

        await call('POST', '/api/duplicates/ai-review', {
          withExcerpts: null,
        });
        assert.strictEqual(
          seen[3].withExcerpts,
          true,
          'a request that says nothing gets the evidence'
        );
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
      }
    });

    /* ── the review as a job ──────────────────────────────────────────────
       The same review, started and watched instead of waited for: the page
       needs a progress panel and a Stop button, and neither is possible
       through a single POST that answers when everything is over. The job
       itself has its own suite (tests/test-duplicate-review-job.js); what is
       pinned here is the wire format of the five routes around it. */

    const reviewJobs = require(
      path.join(REPO_ROOT, 'services', 'duplicateReviewJobService')
    );

    /**
     * Replaces the judge with one that waits for a gate, so a test can look
     * at a job while it runs.
     *
     * @param {(control: object) => object|Promise<object>} finish  what the
     *   judge returns once the gate opens
     * @returns {{open: () => void, seen: object}}
     */
    function gateJudge(finish) {
      let open = () => {};
      const opened = new Promise((resolve) => {
        open = resolve;
      });
      const seen = {};
      entityMatchAiService.reviewScan = async (options, control) => {
        seen.options = options;
        seen.control = control;
        await opened;
        return finish(control);
      };
      return { open, seen };
    }

    /**
     * Reads a server-sent event stream to its end.
     *
     * @param {string} id  the job to follow
     * @returns {Promise<{status: number, headers: Headers, events: object[],
     *   comments: number, closed: Promise<void>}>}
     */
    async function openEventStream(id) {
      const response = await fetch(
        `${harness.base}/api/duplicates/ai-review/jobs/${id}/events`,
        { headers: { 'x-api-key': API_KEY } }
      );
      const events = [];
      const state = { comments: 0 };
      if (!response.body) {
        return {
          status: response.status,
          headers: response.headers,
          events,
          state,
          closed: Promise.resolve(),
        };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const closed = (async () => {
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf('\n\n');
          while (cut !== -1) {
            const chunk = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            if (chunk.startsWith(':')) {
              state.comments += 1;
            } else if (chunk.startsWith('data: ')) {
              events.push(JSON.parse(chunk.slice(6)));
            }
            cut = buffer.indexOf('\n\n');
          }
        }
      })();
      return {
        status: response.status,
        headers: response.headers,
        events,
        state,
        closed,
      };
    }

    /** Waits until `check()` is true, or gives up; the events are async. */
    async function until(check, what) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for ${what}`);
    }

    await test('POST /api/duplicates/ai-review/jobs answers 202 with the job', async () => {
      reviewJobs.reset();
      const gate = gateJudge(() => reviewFixture());
      try {
        const response = await call('POST', '/api/duplicates/ai-review/jobs', {
          kind: 'tags',
          threshold: 0.9,
          withTitles: false,
        });
        assert.strictEqual(response.status, 202, 'a started job is accepted');
        const payload = await response.json();
        assert.strictEqual(payload.success, true);
        const job = payload.data.job;
        assert.ok(job.id, 'the job is named');
        assert.strictEqual(job.status, 'running');
        assert.strictEqual(job.hasResult, false);
        assert.strictEqual(job.progress.phase, 'starting');
        assert.strictEqual('controller' in job, false, 'no internals leak');
        // The options are the ones the synchronous route would have used.
        assert.deepStrictEqual(gate.seen.options, {
          kind: 'tags',
          threshold: 0.9,
          includeDismissed: false,
          withTitles: false,
          withExcerpts: true,
        });

        const second = await call('POST', '/api/duplicates/ai-review/jobs', {});
        assert.strictEqual(second.status, 409, 'one review at a time');
        const refusal = await second.json();
        assert.strictEqual(refusal.success, false);
        assert.match(refusal.error, /already running/);
        assert.strictEqual(
          refusal.data.job.id,
          job.id,
          'the refusal names the running job so a second tab can attach'
        );
      } finally {
        gate.open();
        await reviewJobs.wait(reviewJobs.current()?.id).catch(() => {});
        entityMatchAiService.reviewScan = realReviewScan;
        reviewJobs.reset();
      }
    });

    await test('POST /api/duplicates/ai-review/jobs validates like the synchronous route', async () => {
      reviewJobs.reset();
      entityMatchAiService.reviewScan = async () => {
        throw new Error('the route must refuse before a job is started');
      };
      try {
        for (const body of [
          { kind: 'documents' },
          { threshold: 2 },
          { groupIds: 'tags:1-2' },
        ]) {
          const response = await call(
            'POST',
            '/api/duplicates/ai-review/jobs',
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
        assert.strictEqual(
          reviewJobs.current(),
          null,
          'a refused request starts nothing'
        );
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
        reviewJobs.reset();
      }
    });

    await test('GET /api/duplicates/ai-review/jobs/current is null, then the running job', async () => {
      reviewJobs.reset();
      const empty = await call('GET', '/api/duplicates/ai-review/jobs/current');
      assert.strictEqual(empty.status, 200);
      const nothing = await empty.json();
      assert.strictEqual(nothing.success, true);
      assert.strictEqual(nothing.data.job, null, 'no review, no job');

      const gate = gateJudge(() => reviewFixture());
      try {
        const started = await call(
          'POST',
          '/api/duplicates/ai-review/jobs',
          {}
        );
        const id = (await started.json()).data.job.id;
        // Reading the job counts as watching: the idle stop must not end a
        // review a page is polling because its event stream broke.
        reviewJobs.current().watchedMs = Date.now() - 60000;
        const running = await call(
          'GET',
          '/api/duplicates/ai-review/jobs/current'
        );
        const payload = await running.json();
        assert.strictEqual(payload.data.job.id, id);
        assert.strictEqual(payload.data.job.status, 'running');
        assert.ok(
          Date.now() - reviewJobs.current().watchedMs < 2000,
          'the read touched the job'
        );
      } finally {
        gate.open();
        await reviewJobs.wait(reviewJobs.current()?.id).catch(() => {});
        entityMatchAiService.reviewScan = realReviewScan;
        reviewJobs.reset();
      }
    });

    await test('GET /api/duplicates/ai-review/jobs/:id carries the result once there is one', async () => {
      reviewJobs.reset();
      const unknown = await call(
        'GET',
        '/api/duplicates/ai-review/jobs/nope-nope'
      );
      assert.strictEqual(unknown.status, 404);
      assert.strictEqual((await unknown.json()).success, false);

      const gate = gateJudge(() => reviewFixture());
      try {
        const started = await call(
          'POST',
          '/api/duplicates/ai-review/jobs',
          {}
        );
        const id = (await started.json()).data.job.id;

        reviewJobs.current().watchedMs = Date.now() - 60000;
        const running = await call(
          'GET',
          `/api/duplicates/ai-review/jobs/${id}`
        );
        const before = await running.json();
        assert.strictEqual(before.data.job.status, 'running');
        assert.strictEqual(before.data.result, null, 'nothing to show yet');
        assert.ok(
          Date.now() - reviewJobs.current().watchedMs < 2000,
          'polling the job counts as watching it'
        );

        gate.open();
        await reviewJobs.wait(id);

        const finished = await call(
          'GET',
          `/api/duplicates/ai-review/jobs/${id}`
        );
        const after = await finished.json();
        assert.strictEqual(after.data.job.status, 'done');
        assert.strictEqual(after.data.job.hasResult, true);
        assert.strictEqual(after.data.result.aiReview.judged, 2);
        assert.strictEqual(after.data.result.groups.length, 2);
      } finally {
        gate.open();
        entityMatchAiService.reviewScan = realReviewScan;
        reviewJobs.reset();
      }
    });

    await test('The event stream sends the snapshot, progress and done, then ends', async () => {
      reviewJobs.reset();
      const gate = gateJudge((control) => {
        control.onProgress({
          phase: 'judging',
          message: 'Asking the model, request 1 of 4',
          requestsPlanned: 4,
          requestsDone: 1,
          pairsTotal: 40,
          pairsJudged: 10,
          tokens: 700,
        });
        return reviewFixture();
      });
      try {
        const started = await call(
          'POST',
          '/api/duplicates/ai-review/jobs',
          {}
        );
        const id = (await started.json()).data.job.id;
        const stream = await openEventStream(id);
        assert.strictEqual(stream.status, 200);
        assert.match(
          stream.headers.get('content-type') || '',
          /text\/event-stream/
        );
        assert.strictEqual(stream.headers.get('cache-control'), 'no-cache');
        assert.strictEqual(stream.headers.get('x-accel-buffering'), 'no');

        await until(
          () => stream.events.length > 0,
          'the snapshot of the running job'
        );
        assert.strictEqual(stream.events[0].type, 'progress');
        assert.strictEqual(stream.events[0].job.id, id);

        gate.open();
        await stream.closed;

        const types = stream.events.map((event) => event.type);
        assert.strictEqual(types[types.length - 1], 'done', 'done is the last');
        assert.strictEqual(
          types.filter((type) => type === 'done').length,
          1,
          'exactly one final event'
        );
        const judging = stream.events.find(
          (event) => event.job.progress.requestsDone === 1
        );
        assert.ok(judging, 'a progress event reported the first request');
        assert.strictEqual(judging.job.progress.requestsPlanned, 4);
        assert.strictEqual(judging.job.progress.tokens, 700);
        const final = stream.events[stream.events.length - 1];
        assert.strictEqual(final.job.status, 'done');
        assert.strictEqual(final.data.aiReview.judged, 2);
      } finally {
        gate.open();
        entityMatchAiService.reviewScan = realReviewScan;
        reviewJobs.reset();
      }
    });

    await test('The event stream of an unknown job is a 404 before any header', async () => {
      reviewJobs.reset();
      const response = await fetch(
        `${harness.base}/api/duplicates/ai-review/jobs/nope-nope/events`,
        { headers: { 'x-api-key': API_KEY } }
      );
      assert.strictEqual(response.status, 404);
      assert.match(
        response.headers.get('content-type') || '',
        /application\/json/,
        'a refusal is JSON, not a stream'
      );
      assert.strictEqual((await response.json()).success, false);
    });

    await test('POST /api/duplicates/ai-review/jobs/:id/stop ends the stream with the partial result', async () => {
      reviewJobs.reset();
      const unknown = await call(
        'POST',
        '/api/duplicates/ai-review/jobs/nope-nope/stop',
        {}
      );
      assert.strictEqual(unknown.status, 404);

      let aborted = null;
      // This judge waits for the stop rather than for a gate.
      entityMatchAiService.reviewScan = async (options, control) => {
        await new Promise((resolve) =>
          control.signal.addEventListener('abort', resolve, { once: true })
        );
        aborted = control.signal.aborted;
        const partial = reviewFixture();
        partial.aiReview.stopped = true;
        partial.aiReview.pairsNotJudged = 56;
        return partial;
      };
      try {
        const started = await call(
          'POST',
          '/api/duplicates/ai-review/jobs',
          {}
        );
        const id = (await started.json()).data.job.id;
        const stream = await openEventStream(id);
        await until(() => stream.events.length > 0, 'the snapshot');

        const stopped = await call(
          'POST',
          `/api/duplicates/ai-review/jobs/${id}/stop`,
          {}
        );
        assert.strictEqual(stopped.status, 200);
        const payload = await stopped.json();
        assert.strictEqual(payload.success, true);
        assert.strictEqual(payload.data.job.status, 'stopping');
        assert.strictEqual(payload.data.job.stopReason, 'user');

        await stream.closed;
        assert.strictEqual(aborted, true, 'the judge saw the aborted signal');
        const final = stream.events[stream.events.length - 1];
        assert.strictEqual(final.type, 'stopped');
        assert.strictEqual(final.job.stopReason, 'user');
        assert.strictEqual(final.data.aiReview.stopped, true);
        assert.strictEqual(
          final.data.aiReview.pairsNotJudged,
          56,
          'what it did judge comes home'
        );

        // Stopping what is over changes nothing and still answers the job.
        const again = await call(
          'POST',
          `/api/duplicates/ai-review/jobs/${id}/stop`,
          {}
        );
        assert.strictEqual(again.status, 200);
        assert.strictEqual((await again.json()).data.job.status, 'stopped');
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
        reviewJobs.reset();
      }
    });

    await test('A failed review streams failed with the message', async () => {
      reviewJobs.reset();
      entityMatchAiService.reviewScan = async () => {
        throw Object.assign(new Error('The AI review is switched off'), {
          status: 409,
        });
      };
      try {
        const started = await call(
          'POST',
          '/api/duplicates/ai-review/jobs',
          {}
        );
        assert.strictEqual(started.status, 202, 'the start itself succeeded');
        const id = (await started.json()).data.job.id;
        await reviewJobs.wait(id);
        // A subscriber that arrives after the end still gets the verdict.
        const stream = await openEventStream(id);
        await stream.closed;
        assert.strictEqual(stream.events.length, 1, 'only the final event');
        assert.strictEqual(stream.events[0].type, 'failed');
        assert.strictEqual(
          stream.events[0].error,
          'The AI review is switched off'
        );
        assert.strictEqual(stream.events[0].job.hasResult, false);
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
        reviewJobs.reset();
      }
    });

    await test('POST /api/duplicates/ai-review runs through the job and refuses a second one', async () => {
      reviewJobs.reset();
      const gate = gateJudge(() => reviewFixture());
      try {
        // The synchronous route waits for the job it started, so while it
        // waits the job routes see exactly that job.
        const pending = call('POST', '/api/duplicates/ai-review', {
          kind: 'tags',
        });
        await until(() => reviewJobs.isRunning(), 'the job of the old route');
        const busy = await call('POST', '/api/duplicates/ai-review', {});
        assert.strictEqual(busy.status, 409, 'still one review at a time');
        const refusal = await busy.json();
        assert.ok(refusal.data.job.id, 'the refusal names the running job');

        gate.open();
        const response = await pending;
        assert.strictEqual(response.status, 200);
        const payload = await response.json();
        assert.strictEqual(payload.success, true);
        assert.strictEqual(
          payload.data.aiReview.judged,
          2,
          'the body is what it always was'
        );
        assert.strictEqual(payload.data.groups.length, 2);
      } finally {
        gate.open();
        entityMatchAiService.reviewScan = realReviewScan;
        reviewJobs.reset();
      }
    });

    await test('POST /api/duplicates/ai-review answers a stopped review with what it reached', async () => {
      reviewJobs.reset();
      entityMatchAiService.reviewScan = async (options, control) => {
        control.onProgress({ phase: 'judging', requestsPlanned: 8 });
        control.stop('token-budget');
        const partial = reviewFixture();
        partial.aiReview.stopped = true;
        partial.aiReview.pairsNotJudged = 12;
        return partial;
      };
      try {
        const response = await call('POST', '/api/duplicates/ai-review', {});
        assert.strictEqual(response.status, 200, 'a stop is not an error');
        const payload = await response.json();
        assert.strictEqual(payload.success, true);
        assert.strictEqual(payload.data.aiReview.stopped, true);
        assert.strictEqual(payload.data.aiReview.stopReason, 'token-budget');
        assert.strictEqual(payload.data.aiReview.pairsNotJudged, 12);
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
        reviewJobs.reset();
      }
    });

    /* ── the scan asks for a fresh one ────────────────────────────────────
       The scan route is only ever reached because somebody pressed the
       button, so a cached answer would be the wrong one: what they want to
       see is the archive as it is now. */

    await test('GET /api/duplicates/scan asks the service for a fresh scan', async () => {
      const duplicateMergeService = require(
        path.join(REPO_ROOT, 'services', 'duplicateMergeService')
      );
      const realScan = duplicateMergeService.scan;
      const seen = [];
      duplicateMergeService.scan = async (options) => {
        seen.push(options);
        return {
          scannedAt: '2026-09-19T10:00:00.000Z',
          threshold: options.threshold,
          totals: { tags: 0, correspondents: null },
          dismissedPairs: 0,
          paperlessUrl: 'https://paperless.test',
          groups: [],
        };
      };
      try {
        const response = await call(
          'GET',
          '/api/duplicates/scan?kind=tags&threshold=0.9'
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(seen.length, 1, 'the route scanned once');
        assert.strictEqual(
          seen[0].fresh,
          true,
          'a scan the user asked for must not be answered from a cache'
        );
        // The options the route always passed are untouched by it.
        assert.strictEqual(seen[0].kind, 'tags');
        assert.strictEqual(seen[0].threshold, 0.9);
        assert.strictEqual(seen[0].includeDismissed, false);
      } finally {
        duplicateMergeService.scan = realScan;
      }
    });
    /* ── round 9: the name for the survivor ───────────────────────────────
       The rename is an option of the merge, not a second request. The route
       only has to hand it through and refuse a name no object could carry;
       what the merge service does with it is its own test. */

    await test('POST /api/duplicates/merge hands targetName to the service', async () => {
      const duplicateMergeService = require(
        path.join(REPO_ROOT, 'services', 'duplicateMergeService')
      );
      const realMerge = duplicateMergeService.merge;
      const seen = [];
      duplicateMergeService.merge = async (options) => {
        seen.push(options);
        return {
          mergeId: 1,
          kind: options.kind,
          target: { id: options.targetId, name: 'Amazon EU S.a.r.l.' },
          documentsMoved: 3,
          copiedMatchingRule: false,
          status: 'done',
          sources: [
            { id: 48, name: 'amazon', documentsMoved: 3, deleted: true },
          ],
        };
      };
      try {
        const renamed = await call('POST', '/api/duplicates/merge', {
          kind: 'tags',
          targetId: 12,
          sourceIds: [48],
          targetName: '  Amazon EU S.a.r.l.  ',
        });
        assert.strictEqual(renamed.status, 200);
        const payload = await renamed.json();
        assert.strictEqual(payload.success, true);
        assert.strictEqual(
          seen[0].targetName,
          'Amazon EU S.a.r.l.',
          'the name reaches the service trimmed'
        );

        // A merge that says nothing about the name must not carry one: the
        // service would otherwise rename the target to "undefined" or have to
        // guess what "no name" means.
        await call('POST', '/api/duplicates/merge', {
          kind: 'tags',
          targetId: 12,
          sourceIds: [48],
        });
        assert.ok(
          !('targetName' in seen[1]),
          'an unchanged name must not be sent at all'
        );

        // Blank is the same as absent — the page clears the field rather than
        // deleting it when the user changes their mind.
        await call('POST', '/api/duplicates/merge', {
          kind: 'tags',
          targetId: 12,
          sourceIds: [48],
          targetName: '   ',
        });
        assert.ok(
          !('targetName' in seen[2]),
          'a blank name must not reach the service as a rename'
        );
      } finally {
        duplicateMergeService.merge = realMerge;
      }
    });

    await test('POST /api/duplicates/merge refuses a name no object could carry', async () => {
      const duplicateMergeService = require(
        path.join(REPO_ROOT, 'services', 'duplicateMergeService')
      );
      const realMerge = duplicateMergeService.merge;
      let calls = 0;
      duplicateMergeService.merge = async () => {
        calls += 1;
        return { status: 'done', sources: [], target: {}, documentsMoved: 0 };
      };
      try {
        const cases = [
          { targetName: 'x'.repeat(129) },
          { targetName: 42 },
          { targetName: ['Amazon'] },
        ];
        for (const extra of cases) {
          const response = await call('POST', '/api/duplicates/merge', {
            kind: 'tags',
            targetId: 12,
            sourceIds: [48],
            ...extra,
          });
          assert.strictEqual(
            response.status,
            400,
            `expected 400 for ${JSON.stringify(extra)}`
          );
          const payload = await response.json();
          assert.strictEqual(payload.success, false);
          assert.ok(payload.error);
        }
        assert.strictEqual(calls, 0, 'a refused name must not start a merge');

        // Exactly at the limit is a name, not a refusal.
        const ok = await call('POST', '/api/duplicates/merge', {
          kind: 'tags',
          targetId: 12,
          sourceIds: [48],
          targetName: 'y'.repeat(128),
        });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(calls, 1);
      } finally {
        duplicateMergeService.merge = realMerge;
      }
    });

    /* ── round 9: deleting unused objects ─────────────────────────────────
       The service does the checking against Paperless-ngx; the route owns the
       validation and the "partial answers 200 with success: false" rule the
       merge route set. */

    await test('POST /api/duplicates/delete validates kind and ids', async () => {
      const duplicateMergeService = require(
        path.join(REPO_ROOT, 'services', 'duplicateMergeService')
      );
      const realDelete = duplicateMergeService.deleteUnused;
      let calls = 0;
      duplicateMergeService.deleteUnused = async () => {
        calls += 1;
        return { kind: 'tags', deleted: [], failed: [], logId: null };
      };
      try {
        const cases = [
          [{}, 'no body at all'],
          [{ ids: [1] }, 'no kind'],
          [{ kind: '', ids: [1] }, 'an empty kind'],
          [{ kind: 'document_types', ids: [1] }, 'an unknown kind'],
          [{ kind: 'tags' }, 'no ids'],
          [{ kind: 'tags', ids: [] }, 'an empty list'],
          [{ kind: 'tags', ids: 'all' }, 'ids that are not a list'],
          [{ kind: 'tags', ids: [1, 'two'] }, 'an id that is not a number'],
          [{ kind: 'tags', ids: [1, 0] }, 'a zero id'],
          [{ kind: 'tags', ids: [1, -3] }, 'a negative id'],
          [{ kind: 'tags', ids: [1, 2.5] }, 'a fractional id'],
        ];
        for (const [body, what] of cases) {
          const response = await call('POST', '/api/duplicates/delete', body);
          assert.strictEqual(response.status, 400, `expected 400 for ${what}`);
          const payload = await response.json();
          assert.strictEqual(payload.success, false);
          assert.ok(payload.error, `${what} must name its reason`);
        }
        assert.strictEqual(
          calls,
          0,
          'nothing may be deleted on a refused request'
        );
      } finally {
        duplicateMergeService.deleteUnused = realDelete;
      }
    });

    await test('POST /api/duplicates/delete takes 500 ids and refuses 501', async () => {
      const duplicateMergeService = require(
        path.join(REPO_ROOT, 'services', 'duplicateMergeService')
      );
      const realDelete = duplicateMergeService.deleteUnused;
      let seen = null;
      duplicateMergeService.deleteUnused = async (options) => {
        seen = options;
        return {
          kind: options.kind,
          deleted: options.ids.map((id) => ({ id, name: `tag-${id}` })),
          failed: [],
          logId: 7,
        };
      };
      try {
        const ids = Array.from({ length: 500 }, (_, index) => index + 1);
        const ok = await call('POST', '/api/duplicates/delete', {
          kind: 'tags',
          ids,
        });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(seen.ids.length, 500);
        assert.strictEqual(
          seen.performedBy,
          'api-key',
          'an API key request is recorded as api-key'
        );

        const tooMany = await call('POST', '/api/duplicates/delete', {
          kind: 'tags',
          ids: [...ids, 501],
        });
        assert.strictEqual(tooMany.status, 400);
        assert.match((await tooMany.json()).error, /500/);
      } finally {
        duplicateMergeService.deleteUnused = realDelete;
      }
    });

    await test('POST /api/duplicates/delete answers with the result and a message', async () => {
      const duplicateMergeService = require(
        path.join(REPO_ROOT, 'services', 'duplicateMergeService')
      );
      const realDelete = duplicateMergeService.deleteUnused;
      let seen = null;
      duplicateMergeService.deleteUnused = async (options) => {
        seen = options;
        return {
          kind: options.kind,
          deleted: [
            { id: 11, name: 'Old' },
            { id: 12, name: 'Older' },
          ],
          failed: [],
          logId: 42,
        };
      };
      try {
        const response = await call('POST', '/api/duplicates/delete', {
          kind: 'correspondents',
          ids: ['11', 12],
        });
        assert.strictEqual(response.status, 200);
        const payload = await response.json();
        assert.strictEqual(payload.success, true);
        assert.strictEqual(payload.data.logId, 42, 'the undo needs the log id');
        assert.strictEqual(payload.data.deleted.length, 2);
        assert.ok(payload.message, 'a message for the toast');
        assert.deepStrictEqual(
          seen.ids,
          [11, 12],
          'the ids reach the service as numbers, whatever the body carried'
        );
        assert.strictEqual(seen.kind, 'correspondents');
      } finally {
        duplicateMergeService.deleteUnused = realDelete;
      }
    });

    await test('A partial delete answers 200 with success: false', async () => {
      const duplicateMergeService = require(
        path.join(REPO_ROOT, 'services', 'duplicateMergeService')
      );
      const realDelete = duplicateMergeService.deleteUnused;
      duplicateMergeService.deleteUnused = async (options) => ({
        kind: options.kind,
        deleted: [{ id: 11, name: 'Old' }],
        failed: [{ id: 12, name: 'Busy', error: 'carries 3 documents' }],
        logId: 43,
      });
      try {
        const response = await call('POST', '/api/duplicates/delete', {
          kind: 'tags',
          ids: [11, 12],
        });
        assert.strictEqual(response.status, 200, 'the request itself worked');
        const payload = await response.json();
        assert.strictEqual(payload.success, false);
        assert.strictEqual(
          payload.data.deleted.length,
          1,
          'what was deleted is reported either way'
        );
        assert.strictEqual(payload.data.failed[0].error, 'carries 3 documents');
        assert.match(payload.message, /Only 1 of 2/);
      } finally {
        duplicateMergeService.deleteUnused = realDelete;
      }
    });

    await test('POST /api/duplicates/delete maps a refusal onto its status', async () => {
      const duplicateMergeService = require(
        path.join(REPO_ROOT, 'services', 'duplicateMergeService')
      );
      const realDelete = duplicateMergeService.deleteUnused;
      duplicateMergeService.deleteUnused = async () => {
        const error = new Error('A document scan is running');
        error.status = 409;
        throw error;
      };
      try {
        const response = await call('POST', '/api/duplicates/delete', {
          kind: 'tags',
          ids: [11],
        });
        assert.strictEqual(response.status, 409);
        const payload = await response.json();
        assert.strictEqual(payload.success, false);
        assert.match(payload.error, /scan is running/);
      } finally {
        duplicateMergeService.deleteUnused = realDelete;
      }

      const unauthenticated = await fetch(
        harness.base + '/api/duplicates/delete',
        {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'tags', ids: [11] }),
        }
      );
      assert.ok(
        unauthenticated.status === 401 || unauthenticated.status === 302,
        'the delete route must not answer without authentication'
      );
    });

    /* ── round 9: the log says what a row recorded ────────────────────────── */

    await test('GET /api/duplicates/log carries action and targetRenamedFrom', async () => {
      const mergeRowId = await harness.documentModel.addEntityMerge({
        kind: 'tags',
        targetId: 900,
        targetName: 'Amazon EU S.a.r.l.',
        sources: [{ id: 901, name: 'amazon', documentsMoved: 2 }],
        documentsMoved: 2,
        status: 'done',
        targetRenamedFrom: 'Amazon',
      });
      const deleteRowId = await harness.documentModel.addEntityMerge({
        kind: 'tags',
        targetId: 0,
        targetName: '',
        sources: [
          { id: 910, name: 'Leftover', snapshot: { name: 'Leftover' } },
          { id: 911, name: 'Also leftover' },
        ],
        documentsMoved: 0,
        status: 'done',
        action: 'delete',
      });
      assert.ok(mergeRowId > 0 && deleteRowId > 0);

      const response = await call('GET', '/api/duplicates/log?limit=100');
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      const rows = new Map(payload.data.map((row) => [row.id, row]));

      const renamed = rows.get(mergeRowId);
      assert.strictEqual(renamed.action, 'merge', 'a merge row says so');
      assert.strictEqual(
        renamed.targetRenamedFrom,
        'Amazon',
        'the page needs the old name to show "renamed from"'
      );

      const removed = rows.get(deleteRowId);
      assert.strictEqual(removed.action, 'delete');
      assert.strictEqual(
        removed.targetRenamedFrom,
        null,
        'a delete renamed nothing'
      );
      assert.strictEqual(removed.sources.length, 2);
      assert.strictEqual(removed.sources[0].name, 'Leftover');

      // Rows written before the log knew about actions are merges; the
      // column's default says so rather than leaving the page to guess.
      const plainId = await harness.documentModel.addEntityMerge({
        kind: 'tags',
        targetId: 920,
        targetName: 'Plain',
        sources: [{ id: 921, name: 'plain' }],
        documentsMoved: 1,
      });
      const again = await call('GET', '/api/duplicates/log?limit=100');
      const plain = (await again.json()).data.find((row) => row.id === plainId);
      assert.strictEqual(plain.action, 'merge');
      assert.strictEqual(plain.targetRenamedFrom, null);
    });

    /* ── round 9: the names the creation guard mapped ─────────────────────── */

    await test('GET /api/duplicates/mappings lists the newest first', async () => {
      const empty = await call('GET', '/api/duplicates/mappings');
      assert.strictEqual(empty.status, 200);
      const emptyPayload = await empty.json();
      assert.strictEqual(emptyPayload.success, true);
      assert.deepStrictEqual(
        emptyPayload.data,
        [],
        'an instance that never mapped a name answers with an empty list'
      );

      await harness.documentModel.addEntityNameMapping({
        kind: 'tags',
        proposedName: 'rechnungen',
        targetId: 12,
        targetName: 'Rechnung',
        reason: 'plural',
        score: 0.9,
        documentId: 4711,
      });
      await harness.documentModel.addEntityNameMapping({
        kind: 'correspondents',
        proposedName: 'Mueller GmbH',
        targetId: 13,
        targetName: 'Müller GmbH',
        reason: 'umlaut-variant',
        score: 0.97,
        documentId: null,
      });

      const response = await call('GET', '/api/duplicates/mappings');
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.data.length, 2);
      assert.strictEqual(
        payload.data[0].proposedName,
        'Mueller GmbH',
        'the newest mapping is the first one'
      );
      assert.strictEqual(payload.data[0].kind, 'correspondents');
      assert.strictEqual(payload.data[0].targetName, 'Müller GmbH');
      assert.strictEqual(payload.data[0].reason, 'umlaut-variant');
      assert.strictEqual(
        payload.data[0].documentId,
        null,
        'a mapping without a document says so instead of inventing one'
      );
      assert.strictEqual(payload.data[1].documentId, 4711);
      assert.ok(payload.data[1].createdAt, 'the row carries its timestamp');
    });

    await test('DELETE /api/duplicates/mappings forgets them and says how many', async () => {
      const response = await call('DELETE', '/api/duplicates/mappings');
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.data.removed, 2);
      assert.ok(payload.message);

      const after = await call('GET', '/api/duplicates/mappings');
      assert.deepStrictEqual((await after.json()).data, []);

      // Clearing an empty list is not an error; it is the same answer with a
      // zero, so a double click cannot produce a red toast.
      const again = await call('DELETE', '/api/duplicates/mappings');
      assert.strictEqual(again.status, 200);
      assert.strictEqual((await again.json()).data.removed, 0);

      const unauthenticated = await fetch(
        harness.base + '/api/duplicates/mappings',
        { redirect: 'manual' }
      );
      assert.ok(
        unauthenticated.status === 401 || unauthenticated.status === 302,
        'the mapping list must not answer without authentication'
      );
    });

    /* ── round 9: the semantic sweep is asked for, never assumed ──────────── */

    await test('POST /api/duplicates/ai-review passes semanticSweep on', async () => {
      const entityMatchAiService = require(
        path.join(REPO_ROOT, 'services', 'entityMatchAiService')
      );
      const realReviewScan = entityMatchAiService.reviewScan;
      const seen = [];
      entityMatchAiService.reviewScan = async (options) => {
        seen.push(options);
        return {
          scannedAt: '2026-09-19T10:00:00.000Z',
          threshold: options.threshold,
          totals: { tags: 0, correspondents: null },
          dismissedPairs: 0,
          groups: [],
          aiReview: {
            enabled: true,
            model: 'test-judge',
            requests: 2,
            judged: 0,
            candidates: 0,
            sweepRequests: 1,
            sweepProposals: 0,
          },
        };
      };
      try {
        const asked = await call('POST', '/api/duplicates/ai-review', {
          kind: 'tags',
          semanticSweep: true,
        });
        assert.strictEqual(asked.status, 200);
        assert.strictEqual(seen[0].semanticSweep, true);
        const payload = await asked.json();
        assert.strictEqual(payload.data.aiReview.sweepRequests, 1);

        // Off is a real answer and has to reach the service as one, or a
        // default further down could turn it back on.
        await call('POST', '/api/duplicates/ai-review', {
          kind: 'tags',
          semanticSweep: false,
        });
        assert.strictEqual(seen[1].semanticSweep, false);

        // A request that says nothing must not carry the option at all.
        await call('POST', '/api/duplicates/ai-review', { kind: 'tags' });
        assert.ok(
          !('semanticSweep' in seen[2]),
          'a review that was not asked for a sweep must not request one'
        );
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
        reviewJobs.reset();
      }
    });

    await test('POST /api/duplicates/ai-review refuses a semanticSweep that is not a boolean', async () => {
      const entityMatchAiService = require(
        path.join(REPO_ROOT, 'services', 'entityMatchAiService')
      );
      const realReviewScan = entityMatchAiService.reviewScan;
      let calls = 0;
      entityMatchAiService.reviewScan = async () => {
        calls += 1;
        return { groups: [], totals: {}, aiReview: {} };
      };
      try {
        for (const value of ['true', 'yes', 1, {}]) {
          for (const url of [
            '/api/duplicates/ai-review',
            '/api/duplicates/ai-review/jobs',
          ]) {
            const response = await call('POST', url, {
              kind: 'tags',
              semanticSweep: value,
            });
            assert.strictEqual(
              response.status,
              400,
              `${url} must refuse semanticSweep=${JSON.stringify(value)}`
            );
            const payload = await response.json();
            assert.strictEqual(payload.success, false);
            assert.match(payload.error, /semanticSweep/);
          }
        }
        assert.strictEqual(
          calls,
          0,
          'a refused option must not start a review'
        );
      } finally {
        entityMatchAiService.reviewScan = realReviewScan;
        reviewJobs.reset();
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
