/**
 * Test: the /api/duplicates routes the Tidy up page still calls
 *
 * Tidy up talks to /api/tidy-up/*; these are the few older routes it also
 * uses: undo of a merge, the dismissed pairs, the judge's memory and the
 * cost estimate (the estimate has its own cases in test-ai-run-cost.js).
 * This suite pins their wire format: which status a refusal produces and
 * what an undo does to the store behind it.
 *
 * The router runs for real on a throwaway database (tests/helpers/mount-router)
 * with the in-memory Paperless-ngx stand-in behind it, so an undo here does
 * the same work it does in production: only the HTTP client is replaced.
 *
 * Covers:
 *  1. Neither the page redirect nor an API route answers without authentication
 *  2. POST /api/duplicates/log/:id/undo undoes and marks the entry, undoing
 *     twice is 409, an unknown merge is 404
 *  3. GET /api/duplicates/dismissals lists, DELETE .../:id takes one back
 *  4. DELETE /api/duplicates/ai-review/memory empties the judge's memory
 */

'use strict';

const assert = require('assert');
const path = require('path');

const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');
const { createFakePaperless } = require('./helpers/fake-paperless');

const duplicateMergeService = require(
  path.join(REPO_ROOT, 'services', 'duplicateMergeService')
);
const entityMatchAiService = require(
  path.join(REPO_ROOT, 'services', 'entityMatchAiService')
);

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
    await test('Neither the page redirect nor an API route answers without authentication', async () => {
      const anonymous = await fetch(
        harness.base + '/api/duplicates/dismissals',
        { redirect: 'manual' }
      );
      assert.strictEqual(anonymous.status, 302, 'no credentials -> /login');
      assert.strictEqual(anonymous.headers.get('location'), '/login');

      const anonymousUndo = await fetch(
        harness.base + '/api/duplicates/log/1/undo',
        { method: 'POST', redirect: 'manual' }
      );
      assert.strictEqual(anonymousUndo.status, 302);
      assert.strictEqual(anonymousUndo.headers.get('location'), '/login');

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

    await test('POST /api/duplicates/log/:id/undo undoes the merge', async () => {
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
      // The merge route is gone; the merge itself is the service's work.
      const merged = await duplicateMergeService.merge({
        kind: 'tags',
        targetId: 12,
        sourceIds: [48],
        copyMatchingRule: false,
        performedBy: 'api-key',
      });
      const mergeId = merged.mergeId;
      assert.ok(Number.isInteger(mergeId) && mergeId > 0);
      assert.strictEqual(fake.tag(48), undefined);

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

    await test('dismissals: list, filter by kind, take one back', async () => {
      useFake({
        tags: [
          { id: 40, name: 'Travel' },
          { id: 41, name: 'travel' },
        ],
      });

      // The dismiss route is gone; the service writes the pair.
      const dismissed = await duplicateMergeService.dismiss({
        kind: 'tags',
        ids: [40, 41],
        names: { 40: 'Travel', 41: 'travel' },
      });
      assert.strictEqual(dismissed, 1);

      const list = await call('GET', '/api/duplicates/dismissals?kind=tags');
      assert.strictEqual(list.status, 200);
      const listPayload = await list.json();
      assert.strictEqual(listPayload.data.length, 1);
      assert.strictEqual(listPayload.data[0].idA, 40);
      assert.strictEqual(listPayload.data[0].nameA, 'Travel');
      assert.strictEqual(listPayload.data[0].nameB, 'travel');

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

      const back = await call('GET', '/api/duplicates/dismissals?kind=tags');
      assert.strictEqual((await back.json()).data.length, 0);
    });

    await test('DELETE /api/duplicates/ai-review/memory empties the memory and counts it', async () => {
      const empty = await call('DELETE', '/api/duplicates/ai-review/memory');
      assert.strictEqual(empty.status, 200);
      const emptyPayload = await empty.json();
      assert.strictEqual(emptyPayload.success, true);
      assert.strictEqual(
        emptyPayload.data.removed,
        0,
        'an instance that never judged anything has nothing to forget'
      );
      assert.match(emptyPayload.message, /nothing to forget/i);

      await harness.documentModel.saveAiPairVerdict({
        kind: 'tags',
        pairKey: '1-2',
        nameA: 'Rechnung',
        nameB: 'Rechnungen',
        verdict: 'same',
        model: 'test',
      });
      await harness.documentModel.saveAiPairVerdict({
        kind: 'tags',
        pairKey: '3-4',
        nameA: 'Brief',
        nameB: 'Briefe',
        verdict: 'same',
        model: 'test',
      });

      const response = await call('DELETE', '/api/duplicates/ai-review/memory');
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.data.removed, 2, 'both verdicts are gone');
      assert.strictEqual(
        await harness.documentModel.countAiPairVerdicts(),
        0,
        'the table is empty afterwards'
      );

      // The judge owns the memory when it can; the route then reports what
      // the judge says rather than counting rows itself.
      const realForget = entityMatchAiService.forgetVerdicts;
      entityMatchAiService.forgetVerdicts = async () => 7;
      try {
        const viaJudge = await call(
          'DELETE',
          '/api/duplicates/ai-review/memory'
        );
        const judged = await viaJudge.json();
        assert.strictEqual(judged.data.removed, 7);
      } finally {
        if (realForget === undefined)
          delete entityMatchAiService.forgetVerdicts;
        else entityMatchAiService.forgetVerdicts = realForget;
      }

      const anonymous = await fetch(
        harness.base + '/api/duplicates/ai-review/memory',
        { method: 'DELETE', redirect: 'manual' }
      );
      assert.strictEqual(anonymous.status, 302, 'no credentials -> /login');
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
