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
 *  4. POST /api/duplicates/merge merges and answers with the result shape
 *  5. A partial merge answers 200 with success: false
 *  6. Merge validation is 400, an unknown entry is 404
 *  7. POST /api/duplicates/log/:id/undo undoes and marks the entry
 *  8. Undoing twice is 409, an unknown merge is 404
 *  9. dismiss -> dismissals -> delete round trip, and the scan honours it
 * 10. GET /api/duplicates/log pages and reports recordsTotal
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
