/**
 * Test: the /simplify routes in routes/setup.js
 *
 * The page and the simplify service only ever meet through these endpoints,
 * so this suite pins the wire format: what a refusal produces, where
 * `success: false` arrives with status 200 (a partial apply is not a failed
 * request), how the two long-running steps reach the one review job, and what
 * the settings of the round store.
 *
 * The router runs for real on a throwaway database
 * (tests/helpers/mount-router). The service methods that talk to a model or
 * to Paperless-ngx are replaced per case — the services are singletons, so a
 * test hands in its own function and puts the real one back afterwards. What
 * is checked here is the route, not what the service does with the call.
 *
 * Covers:
 *  1. Neither the page nor an API route answers without authentication
 *  2. GET /simplify renders with the locals the page reads
 *  3. GET /api/simplify/vocabulary hands the stored vocabulary through
 *  4. PUT /api/simplify/vocabulary stores names, trims them, drops blanks
 *  5. PUT validates: not a list, too many names, a name that is too long,
 *     an entry that is not a string
 *  6. POST /api/simplify/vocabulary/propose starts a job with task vocabulary
 *  7. A second start while one runs is a 409 that names the running job
 *  8. GET /api/simplify/proposals lists, filters by status, refuses an
 *     unknown one
 *  9. POST /api/simplify/proposals/run starts a job with task splits
 * 10. PATCH /api/simplify/proposals/:tagId passes a valid patch through
 * 11. PATCH validates every field it accepts, and the id in the path
 * 12. PATCH lets the service's own refusals through with their status
 * 13. GET /api/simplify/proposals/:tagId/impact answers what the service says
 * 14. POST /api/simplify/apply validates tagIds
 * 15. Apply answers success: true when nothing failed
 * 16. Apply answers 200 with success: false when something did
 * 17. The four settings of the round: GET, POST, clamp, keep-previous, export
 */

'use strict';

const assert = require('assert');
const path = require('path');

const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

const API_KEY = 'test-api-key';

// server.js sets these on res.locals for every page; the harness does not run
// server.js, so the shell partials would throw on the first missing one.
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
  appMistralKeySet: false,
  appApiKeySet: false,
};

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

/** Replaces methods of a singleton for one case and puts them back after. */
async function withStubs(target, stubs, run) {
  const saved = new Map();
  Object.keys(stubs).forEach((key) => {
    saved.set(
      key,
      Object.prototype.hasOwnProperty.call(target, key)
        ? target[key]
        : undefined
    );
    target[key] = stubs[key];
  });
  try {
    return await run();
  } finally {
    saved.forEach((value, key) => {
      if (value === undefined) delete target[key];
      else target[key] = value;
    });
  }
}

/** Waits until `check()` is true, or gives up; the jobs are asynchronous. */
async function until(check, what) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const savedConfigs = [];
  const harness = await mountRouter({
    env: {
      DUPLICATES_AI_CONCURRENCY: '2',
      DUPLICATES_AI_VERDICT_MEMORY_DAYS: '45',
      SIMPLIFY_TAGS_PER_REQUEST: '70',
      SIMPLIFY_VOCABULARY_SIZE: '35',
    },
    stub: ({ setupService }) => {
      // The real saveConfig writes the merged configuration onto process.env
      // and touches the data directory; only the first half matters here.
      setupService.saveConfig = async (config) => {
        savedConfigs.push(config);
        Object.entries(config).forEach(([key, value]) => {
          process.env[key] = String(value);
        });
      };
    },
  });

  Object.assign(harness.app.locals, SHELL_LOCALS);

  const tagSimplifyService = require(
    path.join(REPO_ROOT, 'services', 'tagSimplifyService')
  );
  const reviewJobs = require(
    path.join(REPO_ROOT, 'services', 'duplicateReviewJobService')
  );

  const call = (method, url, body) =>
    fetch(harness.base + url, {
      method,
      redirect: 'manual',
      headers: {
        'x-api-key': API_KEY,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const lastSaved = () => savedConfigs[savedConfigs.length - 1];

  // POST /settings schedules process.exit(0) five seconds after a save.
  const realExit = process.exit.bind(process);
  process.exit = () => {};

  try {
    await test('Neither the page nor an API route answers without authentication', async () => {
      for (const url of [
        '/simplify',
        '/api/simplify/vocabulary',
        '/api/simplify/proposals',
      ]) {
        const anonymous = await fetch(harness.base + url, {
          redirect: 'manual',
        });
        assert.strictEqual(anonymous.status, 302, `${url} -> /login`);
        assert.strictEqual(anonymous.headers.get('location'), '/login');
      }
      // The page needs a session, an API key is not enough — the same guard
      // /duplicates uses.
      const withApiKey = await call('GET', '/simplify');
      assert.strictEqual(withApiKey.status, 401);
    });

    await test('GET /simplify renders with the locals the page reads', async () => {
      const entityMatchAiService = require(
        path.join(REPO_ROOT, 'services', 'entityMatchAiService')
      );
      const jwt = require(path.join(REPO_ROOT, 'node_modules', 'jsonwebtoken'));
      // protectApiRoute wants a session, so the case mints one rather than
      // settling for the redirect.
      const session = jwt.sign(
        { username: 'tester', typ: 'session' },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      );
      const openPage = () =>
        fetch(harness.base + '/simplify', {
          redirect: 'manual',
          headers: { Cookie: `jwt=${session}` },
        });

      await withStubs(
        entityMatchAiService,
        { isEnabled: () => true },
        async () => {
          const response = await openPage();
          assert.strictEqual(response.status, 200, 'the page must render');
          const html = await response.text();
          assert.ok(
            html.includes(
              'Turn compound tags into a document type and topic tags. Nothing here runs on its own.'
            ),
            'the head sentence of the page is missing'
          );
          assert.ok(
            html.includes('id="simProposeVocabularyBtn"'),
            'the model-backed proposal must be offered while the AI is on'
          );
          assert.ok(
            html.includes('id="simVocabulary"') &&
              html.includes('id="simProposals"'),
            'both sections of the page must be rendered'
          );
        }
      );

      await withStubs(
        entityMatchAiService,
        { isEnabled: () => false },
        async () => {
          const response = await openPage();
          assert.strictEqual(response.status, 200);
          const html = await response.text();
          assert.ok(
            !html.includes('id="simProposeVocabularyBtn"'),
            'without the AI the page must not offer a model proposal'
          );
          assert.ok(
            html.includes('id="simProposeSplitsBtn"'),
            'the rule pass works without a model and stays on the page'
          );
        }
      );

      const routes = harness.router.stack
        .filter((layer) => layer.route)
        .map((layer) => layer.route.path);
      assert.ok(routes.includes('/simplify'), 'the page route is mounted');
      assert.ok(
        routes.includes('/api/simplify/vocabulary') &&
          routes.includes('/api/simplify/vocabulary/propose') &&
          routes.includes('/api/simplify/proposals') &&
          routes.includes('/api/simplify/proposals/run') &&
          routes.includes('/api/simplify/proposals/:tagId') &&
          routes.includes('/api/simplify/proposals/:tagId/impact') &&
          routes.includes('/api/simplify/apply'),
        'every route of the page is mounted under /api/simplify'
      );
    });

    await test('GET /api/simplify/vocabulary hands the stored vocabulary through', async () => {
      const empty = await call('GET', '/api/simplify/vocabulary');
      assert.strictEqual(empty.status, 200);
      const emptyPayload = await empty.json();
      assert.strictEqual(emptyPayload.success, true);
      assert.deepStrictEqual(emptyPayload.data, { types: [], topics: [] });

      await harness.documentModel.replaceTagVocabulary([
        { dimension: 'type', name: 'Rechnung', source: 'model' },
        { dimension: 'topic', name: 'Strom' },
      ]);
      const response = await call('GET', '/api/simplify/vocabulary');
      const payload = await response.json();
      assert.deepStrictEqual(
        payload.data.types.map((row) => row.name),
        ['Rechnung']
      );
      assert.deepStrictEqual(
        payload.data.topics.map((row) => row.name),
        ['Strom']
      );
      assert.strictEqual(payload.data.types[0].dimension, 'type');
      assert.strictEqual(payload.data.types[0].source, 'model');
      assert.strictEqual(payload.data.topics[0].paperlessId, null);
    });

    await test('PUT /api/simplify/vocabulary stores names, trimmed and without blanks', async () => {
      const response = await call('PUT', '/api/simplify/vocabulary', {
        types: ['Rechnung', '  Brief  ', ''],
        topics: ['Strom', 'Auto'],
      });
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.strictEqual(payload.success, true);
      assert.deepStrictEqual(
        payload.data.types.map((row) => row.name),
        ['Rechnung', 'Brief'],
        'a name is trimmed, a blank entry is dropped, the order is kept'
      );
      assert.deepStrictEqual(
        payload.data.topics.map((row) => row.name),
        ['Strom', 'Auto']
      );
      assert.match(payload.message, /2 document type\(s\), 2 topic\(s\)/);

      // A missing dimension is an empty one, not a reason to refuse.
      const onlyTypes = await call('PUT', '/api/simplify/vocabulary', {
        types: ['Rechnung'],
      });
      assert.strictEqual(onlyTypes.status, 200);
      const onlyPayload = await onlyTypes.json();
      assert.deepStrictEqual(onlyPayload.data.topics, []);
    });

    await test('PUT /api/simplify/vocabulary refuses what is not a list of names', async () => {
      const bodies = [
        { types: 'Rechnung' },
        { topics: { name: 'Strom' } },
        { types: [{ name: 'Rechnung' }] },
        { topics: [1, 2, 3] },
        { types: ['x'.repeat(129)] },
        { topics: Array.from({ length: 201 }, (_, i) => `t${i}`) },
      ];
      for (const body of bodies) {
        const response = await call('PUT', '/api/simplify/vocabulary', body);
        assert.strictEqual(
          response.status,
          400,
          `expected 400 for ${JSON.stringify(body).slice(0, 60)}`
        );
        const payload = await response.json();
        assert.strictEqual(payload.success, false);
        assert.ok(payload.error, 'a reason is given');
      }
      // Exactly 200 is still allowed; the cap is a ceiling, not a limit below.
      const atCap = await call('PUT', '/api/simplify/vocabulary', {
        topics: Array.from({ length: 200 }, (_, i) => `t${i}`),
      });
      assert.strictEqual(atCap.status, 200);
      // …and a name of exactly 128 characters, too.
      const longName = await call('PUT', '/api/simplify/vocabulary', {
        types: ['x'.repeat(128)],
      });
      assert.strictEqual(longName.status, 200);

      // Put the vocabulary the later cases expect back in place.
      await call('PUT', '/api/simplify/vocabulary', {
        types: ['Rechnung', 'Brief'],
        topics: ['Strom', 'Auto'],
      });
    });

    await test('POST /api/simplify/vocabulary/propose starts a job with task vocabulary', async () => {
      reviewJobs.reset();
      let open = () => {};
      const opened = new Promise((resolve) => {
        open = resolve;
      });
      const seen = {};
      await withStubs(
        tagSimplifyService,
        {
          proposeVocabulary: async (options, control) => {
            seen.options = options;
            seen.control = control;
            await opened;
            return { types: ['Rechnung'], topics: ['Strom'], requests: 1 };
          },
        },
        async () => {
          const response = await call(
            'POST',
            '/api/simplify/vocabulary/propose',
            {}
          );
          assert.strictEqual(response.status, 202, 'a started job is accepted');
          const payload = await response.json();
          assert.strictEqual(payload.success, true);
          const job = payload.data.job;
          assert.ok(job.id, 'the job is named');
          assert.strictEqual(job.status, 'running');
          assert.strictEqual(
            job.task,
            'vocabulary',
            'the page tells the two tasks apart by this field'
          );
          assert.strictEqual('controller' in job, false, 'no internals leak');

          await until(() => seen.control, 'the runner to be called');
          assert.strictEqual(typeof seen.control.onProgress, 'function');
          assert.ok(seen.control.signal, 'the runner can be aborted');

          // The page reads the proposal off the job's result route.
          const second = await call(
            'POST',
            '/api/simplify/vocabulary/propose',
            {}
          );
          assert.strictEqual(second.status, 409, 'one job at a time');
          const refusal = await second.json();
          assert.strictEqual(refusal.success, false);
          assert.match(refusal.error, /already running/);
          assert.strictEqual(
            refusal.data.job.id,
            job.id,
            'the refusal names the running job so a second tab can attach'
          );

          // A split run cannot jump the queue either: it is the same job.
          const splits = await call('POST', '/api/simplify/proposals/run', {});
          assert.strictEqual(splits.status, 409);

          open();
          await reviewJobs.wait(job.id);
          const result = await call(
            'GET',
            `/api/duplicates/ai-review/jobs/${job.id}/result`
          );
          assert.strictEqual(result.status, 200);
          const resultPayload = await result.json();
          assert.deepStrictEqual(resultPayload.data.types, ['Rechnung']);
          assert.deepStrictEqual(resultPayload.data.topics, ['Strom']);
        }
      );
      reviewJobs.reset();
    });

    await test('GET /api/simplify/proposals lists and filters by status', async () => {
      await harness.documentModel.replaceTagSplitProposals([
        {
          tagId: 9,
          tagName: 'Stromrechnung',
          documentCount: 12,
          typeName: 'Rechnung',
          topicNames: ['Strom'],
          source: 'rule',
          confidence: 'high',
          reason: 'compound of Rechnung and Strom',
          documentsWithType: 3,
        },
        {
          tagId: 4,
          tagName: 'Autorechnung',
          documentCount: 3,
          typeName: 'Rechnung',
          topicNames: ['Auto'],
          source: 'model',
          confidence: 'low',
          status: 'skipped',
        },
      ]);

      const all = await call('GET', '/api/simplify/proposals');
      assert.strictEqual(all.status, 200);
      const allPayload = await all.json();
      assert.strictEqual(allPayload.success, true);
      assert.deepStrictEqual(
        allPayload.data.map((row) => row.tagName),
        ['Autorechnung', 'Stromrechnung'],
        'the list comes by name'
      );
      const strom = allPayload.data.find((row) => row.tagId === 9);
      assert.deepStrictEqual(strom.topicNames, ['Strom']);
      assert.strictEqual(strom.documentsWithType, 3);
      assert.strictEqual(strom.overwriteType, false);
      assert.strictEqual(strom.status, 'open');

      const open = await call('GET', '/api/simplify/proposals?status=open');
      const openPayload = await open.json();
      assert.deepStrictEqual(
        openPayload.data.map((row) => row.tagId),
        [9]
      );
      const skipped = await call(
        'GET',
        '/api/simplify/proposals?status=skipped'
      );
      assert.deepStrictEqual(
        (await skipped.json()).data.map((row) => row.tagId),
        [4]
      );
      const applied = await call(
        'GET',
        '/api/simplify/proposals?status=applied'
      );
      assert.deepStrictEqual((await applied.json()).data, []);

      for (const status of ['done', 'OPEN', 'all']) {
        const bad = await call(
          'GET',
          `/api/simplify/proposals?status=${status}`
        );
        assert.strictEqual(bad.status, 400, `expected 400 for ${status}`);
        const badPayload = await bad.json();
        assert.strictEqual(badPayload.success, false);
        assert.match(badPayload.error, /status/i);
      }
    });

    await test('POST /api/simplify/proposals/run starts a job with task splits', async () => {
      reviewJobs.reset();
      const seen = {};
      await withStubs(
        tagSimplifyService,
        {
          proposeSplits: async (options) => {
            seen.options = options;
            return { proposals: 2, byRule: 1, byModel: 1, requests: 1 };
          },
        },
        async () => {
          const response = await call('POST', '/api/simplify/proposals/run', {
            fresh: true,
          });
          assert.strictEqual(response.status, 202);
          const payload = await response.json();
          const job = payload.data.job;
          assert.strictEqual(job.task, 'splits');
          await reviewJobs.wait(job.id);
          assert.strictEqual(
            seen.options.fresh,
            true,
            'the one option of the run reaches the service'
          );
          assert.strictEqual(seen.options.task, 'splits');

          // Anything but `fresh: true` is a run over everything again.
          reviewJobs.reset();
          const plain = await call('POST', '/api/simplify/proposals/run', {});
          const plainJob = (await plain.json()).data.job;
          await reviewJobs.wait(plainJob.id);
          assert.strictEqual(seen.options.fresh, false);
        }
      );
      reviewJobs.reset();
    });

    await test('PATCH /api/simplify/proposals/:tagId passes a patch through', async () => {
      const response = await call('PATCH', '/api/simplify/proposals/9', {
        typeName: '  Brief  ',
        topicNames: ['Strom', 'Energie', 'Strom'],
        overwriteType: true,
      });
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.data.typeName, 'Brief');
      assert.deepStrictEqual(payload.data.topicNames, ['Strom', 'Energie']);
      assert.strictEqual(payload.data.overwriteType, true);
      assert.strictEqual(
        payload.data.source,
        'user',
        'a changed target is the user’s, whoever proposed it first'
      );

      // Only what the patch names changes.
      const statusOnly = await call('PATCH', '/api/simplify/proposals/9', {
        status: 'skipped',
      });
      const statusPayload = await statusOnly.json();
      assert.strictEqual(statusPayload.data.status, 'skipped');
      assert.strictEqual(statusPayload.data.typeName, 'Brief');

      // null clears the type: a tag that encodes no document type at all.
      const cleared = await call('PATCH', '/api/simplify/proposals/9', {
        typeName: null,
        status: 'open',
      });
      const clearedPayload = await cleared.json();
      assert.strictEqual(clearedPayload.data.typeName, null);
      assert.strictEqual(clearedPayload.data.status, 'open');
    });

    await test('PATCH /api/simplify/proposals/:tagId validates every field', async () => {
      const bodies = [
        { typeName: 12 },
        { typeName: ['Rechnung'] },
        { typeName: 'x'.repeat(129) },
        { topicNames: 'Strom' },
        { topicNames: [7] },
        { overwriteType: 'yes' },
        { overwriteType: 1 },
        { status: 'applied' },
        { status: 'done' },
      ];
      for (const body of bodies) {
        const response = await call('PATCH', '/api/simplify/proposals/9', body);
        assert.strictEqual(
          response.status,
          400,
          `expected 400 for ${JSON.stringify(body).slice(0, 40)}`
        );
        const payload = await response.json();
        assert.strictEqual(payload.success, false);
        assert.ok(payload.error);
      }

      for (const id of ['0', '-3', 'abc']) {
        const response = await call(
          'PATCH',
          `/api/simplify/proposals/${id}`,
          {}
        );
        assert.strictEqual(response.status, 400, `expected 400 for id ${id}`);
      }

      // The service's own refusals keep their status: an unknown tag is a
      // 404, an applied proposal a 409.
      const unknown = await call('PATCH', '/api/simplify/proposals/9999', {
        status: 'skipped',
      });
      assert.strictEqual(unknown.status, 404);
      assert.strictEqual((await unknown.json()).success, false);

      await harness.documentModel.updateTagSplitProposal(4, {
        status: 'applied',
      });
      const appliedRow = await call('PATCH', '/api/simplify/proposals/4', {
        status: 'open',
      });
      assert.strictEqual(appliedRow.status, 409);
      await harness.documentModel.updateTagSplitProposal(4, {
        status: 'skipped',
      });
    });

    await test('GET /api/simplify/proposals/:tagId/impact answers what the service says', async () => {
      await withStubs(
        tagSimplifyService,
        {
          proposalImpact: async (tagId) => ({
            tagId,
            tagName: 'Stromrechnung',
            documents: 12,
            typeSet: 9,
            typeKept: 3,
          }),
        },
        async () => {
          const response = await call(
            'GET',
            '/api/simplify/proposals/9/impact'
          );
          assert.strictEqual(response.status, 200);
          const payload = await response.json();
          assert.strictEqual(payload.success, true);
          assert.deepStrictEqual(payload.data, {
            tagId: 9,
            tagName: 'Stromrechnung',
            documents: 12,
            typeSet: 9,
            typeKept: 3,
          });

          const bad = await call('GET', '/api/simplify/proposals/0/impact');
          assert.strictEqual(bad.status, 400);
        }
      );

      // A refusal of the service keeps its status here as well.
      await withStubs(
        tagSimplifyService,
        {
          proposalImpact: async () => {
            const error = new Error('There is no proposal for tag 9');
            error.status = 404;
            throw error;
          },
        },
        async () => {
          const response = await call(
            'GET',
            '/api/simplify/proposals/9/impact'
          );
          assert.strictEqual(response.status, 404);
        }
      );
    });

    await test('POST /api/simplify/apply validates tagIds', async () => {
      const bodies = [
        {},
        { tagIds: [] },
        { tagIds: 'nine' },
        { tagIds: [0] },
        { tagIds: [-1] },
        { tagIds: [1.5] },
        { tagIds: ['9'] },
        { tagIds: Array.from({ length: 201 }, (_, i) => i + 1) },
      ];
      let calls = 0;
      await withStubs(
        tagSimplifyService,
        {
          applySplits: async () => {
            calls += 1;
            return { applied: [], failed: [] };
          },
        },
        async () => {
          for (const body of bodies) {
            const response = await call('POST', '/api/simplify/apply', body);
            assert.strictEqual(
              response.status,
              400,
              `expected 400 for ${JSON.stringify(body).slice(0, 40)}`
            );
            const payload = await response.json();
            assert.strictEqual(payload.success, false);
            assert.match(payload.error, /tagIds/);
          }
          assert.strictEqual(
            calls,
            0,
            'a refused body must not reach the service'
          );
          // Exactly 200 is the ceiling, not one over it.
          const atCap = await call('POST', '/api/simplify/apply', {
            tagIds: Array.from({ length: 200 }, (_, i) => i + 1),
          });
          assert.strictEqual(atCap.status, 200);
        }
      );
    });

    await test('POST /api/simplify/apply answers success when nothing failed', async () => {
      const seen = {};
      await withStubs(
        tagSimplifyService,
        {
          applySplits: async (request) => {
            seen.request = request;
            return {
              applied: [
                {
                  tagId: 9,
                  tagName: 'Stromrechnung',
                  logId: 5,
                  documentsUpdated: 12,
                  typeSet: 9,
                  typeKept: 3,
                },
              ],
              failed: [],
            };
          },
        },
        async () => {
          const response = await call('POST', '/api/simplify/apply', {
            tagIds: [9],
          });
          assert.strictEqual(response.status, 200);
          const payload = await response.json();
          assert.strictEqual(payload.success, true);
          assert.strictEqual(payload.data.applied.length, 1);
          assert.strictEqual(payload.data.applied[0].logId, 5);
          assert.match(payload.message, /1 tag\(s\) split, 12 document\(s\)/);
          assert.deepStrictEqual(seen.request.tagIds, [9]);
          assert.strictEqual(
            seen.request.performedBy,
            'api-key',
            'the log records who asked for the split'
          );
        }
      );
    });

    await test('A partial apply is a 200 with success: false', async () => {
      await withStubs(
        tagSimplifyService,
        {
          applySplits: async () => ({
            applied: [
              {
                tagId: 9,
                tagName: 'Stromrechnung',
                logId: 6,
                documentsUpdated: 4,
              },
            ],
            failed: [
              { tagId: 4, tagName: 'Autorechnung', error: 'Tag 4 is gone' },
            ],
          }),
        },
        async () => {
          const response = await call('POST', '/api/simplify/apply', {
            tagIds: [9, 4],
          });
          assert.strictEqual(
            response.status,
            200,
            'a partial run is a finished request, not a server error'
          );
          const payload = await response.json();
          assert.strictEqual(payload.success, false);
          assert.strictEqual(
            payload.data.applied.length,
            1,
            'what did work is in the answer either way'
          );
          assert.strictEqual(payload.data.failed[0].error, 'Tag 4 is gone');
          assert.match(payload.message, /Only 1 of 2 tags/);
        }
      );

      // A refusal of the service keeps its status: 501 while the round's
      // service work has not landed, 502 when Paperless-ngx is unreachable.
      await withStubs(
        tagSimplifyService,
        {
          applySplits: async () => {
            const error = new Error('Applying splits is not available yet');
            error.status = 501;
            throw error;
          },
        },
        async () => {
          const response = await call('POST', '/api/simplify/apply', {
            tagIds: [9],
          });
          assert.strictEqual(response.status, 501);
          const payload = await response.json();
          assert.strictEqual(payload.success, false);
          assert.match(payload.error, /not available/);
        }
      );
    });

    await test('GET /settings shows the four settings of the round', async () => {
      const response = await fetch(harness.base + '/settings', {
        redirect: 'manual',
        headers: { 'x-api-key': API_KEY },
      });
      assert.strictEqual(response.status, 200);
      const html = await response.text();
      [
        ['duplicatesAiConcurrency', '2'],
        ['duplicatesAiVerdictMemoryDays', '45'],
        ['simplifyTagsPerRequest', '70'],
        ['simplifyVocabularySize', '35'],
      ].forEach(([input, value]) => {
        assert.ok(
          html.includes(`name="${input}"`),
          `${input} must be part of the settings form`
        );
        assert.ok(
          html.includes(`id="${input}" name="${input}" min=`),
          `${input} must be a number field`
        );
        assert.ok(
          html.includes(`value="${value}"`),
          `${input} must show what is configured now (${value})`
        );
      });
      assert.ok(
        html.includes('id="sec-simplify"'),
        'the Simplify tags section must be on the page'
      );
    });

    await test('POST /settings stores, clamps and keeps the four settings', async () => {
      const stored = await fetch(harness.base + '/settings', {
        method: 'POST',
        headers: {
          'x-api-key': API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          duplicatesAiConcurrency: '5',
          duplicatesAiVerdictMemoryDays: '10',
          simplifyTagsPerRequest: '150',
          simplifyVocabularySize: '12',
        }),
      });
      assert.strictEqual(stored.status, 200, await stored.text());
      const saved = lastSaved();
      assert.strictEqual(saved.DUPLICATES_AI_CONCURRENCY, '5');
      assert.strictEqual(saved.DUPLICATES_AI_VERDICT_MEMORY_DAYS, '10');
      assert.strictEqual(saved.SIMPLIFY_TAGS_PER_REQUEST, '150');
      assert.strictEqual(saved.SIMPLIFY_VOCABULARY_SIZE, '12');

      const post = (body) =>
        fetch(harness.base + '/settings', {
          method: 'POST',
          headers: {
            'x-api-key': API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

      const clamped = await post({
        duplicatesAiConcurrency: '40',
        duplicatesAiVerdictMemoryDays: '4000',
        simplifyTagsPerRequest: '2',
        simplifyVocabularySize: '1000',
      });
      assert.strictEqual(clamped.status, 200, await clamped.text());
      const bounds = lastSaved();
      assert.strictEqual(bounds.DUPLICATES_AI_CONCURRENCY, '8');
      assert.strictEqual(bounds.DUPLICATES_AI_VERDICT_MEMORY_DAYS, '365');
      assert.strictEqual(bounds.SIMPLIFY_TAGS_PER_REQUEST, '10');
      assert.strictEqual(bounds.SIMPLIFY_VOCABULARY_SIZE, '100');

      const kept = await post({
        duplicatesAiConcurrency: 'lots',
        simplifyTagsPerRequest: '',
      });
      assert.strictEqual(kept.status, 200, await kept.text());
      assert.strictEqual(
        lastSaved().DUPLICATES_AI_CONCURRENCY,
        '8',
        'a value that is not a number keeps what the last save stored'
      );
      assert.strictEqual(
        lastSaved().SIMPLIFY_TAGS_PER_REQUEST,
        '10',
        'a cleared field keeps what the last save stored'
      );

      const exported = await fetch(harness.base + '/api/settings/env-file', {
        headers: { 'x-api-key': API_KEY },
      });
      const env = (await exported.json()).data.env;
      assert.ok(env.includes('# Simplify tags'));
      [
        'DUPLICATES_AI_CONCURRENCY=',
        'DUPLICATES_AI_VERDICT_MEMORY_DAYS=',
        'SIMPLIFY_TAGS_PER_REQUEST=',
        'SIMPLIFY_VOCABULARY_SIZE=',
      ].forEach((key) => {
        assert.ok(env.includes(key), `${key} must be exported`);
      });
    });
  } finally {
    process.exit = realExit;
    reviewJobs.reset();
    await harness.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
