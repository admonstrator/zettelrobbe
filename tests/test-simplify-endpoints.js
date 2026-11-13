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
 * to Paperless-ngx are replaced per case: the services are singletons, so a
 * test hands in its own function and puts the real one back afterwards. What
 * is checked here is the route, not what the service does with the call.
 *
 * Covers:
 *  1. Neither the page nor an API route answers without authentication
 *  2. GET /simplify redirects (301) to /tidy-up, the page that replaced it
 *  3. GET /api/simplify/vocabulary hands the stored vocabulary through
 *  4. PUT /api/simplify/vocabulary stores names, trims them, drops blanks
 *  5. PUT validates: not a list, too many names, a name that is too long,
 *     an entry that is not a string
 *  5a. GET /api/simplify/document-types lists them sorted and marked,
 *     reads past the cache on fresh=1, and answers 502 when Paperless-ngx
 *     cannot be reached
 *  6. The four settings of the round: GET, POST, clamp, keep-previous, export
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

  const reviewJobs = require(
    path.join(REPO_ROOT, 'services', 'duplicateReviewJobService')
  );
  const paperlessService = require(
    path.join(REPO_ROOT, 'services', 'paperlessService')
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
        '/api/simplify/document-types',
      ]) {
        const anonymous = await fetch(harness.base + url, {
          redirect: 'manual',
        });
        assert.strictEqual(anonymous.status, 302, `${url} -> /login`);
        assert.strictEqual(anonymous.headers.get('location'), '/login');
      }
      // The page needs a session, an API key is not enough, the same guard
      // /duplicates uses.
      const withApiKey = await call('GET', '/simplify');
      assert.strictEqual(withApiKey.status, 401);
    });

    await test('GET /simplify moves to Tidy up', async () => {
      const jwt = require(path.join(REPO_ROOT, 'node_modules', 'jsonwebtoken'));
      // protectApiRoute wants a session, so the case mints one rather than
      // settling for the redirect to /login.
      const session = jwt.sign(
        { username: 'tester', typ: 'session' },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      );
      // The page was replaced by /tidy-up; a bookmark lands there.
      const response = await fetch(harness.base + '/simplify', {
        redirect: 'manual',
        headers: { Cookie: `jwt=${session}` },
      });
      assert.strictEqual(response.status, 301);
      assert.strictEqual(response.headers.get('location'), '/tidy-up');

      const routes = harness.router.stack
        .filter((layer) => layer.route)
        .map((layer) => layer.route.path);
      assert.ok(routes.includes('/simplify'), 'the page route is mounted');
      assert.ok(
        routes.includes('/api/simplify/vocabulary') &&
          routes.includes('/api/simplify/document-types'),
        'the routes the Tidy up page calls are mounted under /api/simplify'
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

    await test('GET /api/simplify/document-types lists them, marked and sorted', async () => {
      // The vocabulary of the case before is in place: Rechnung, Brief.
      const filledAt = Date.UTC(2026, 8, 20, 8, 55, 0);
      await withStubs(
        paperlessService,
        {
          listDocumentTypesCached: async () => [
            { id: 9, name: 'vertrag', documentCount: 3 },
            { id: 7, name: 'Rechnung', documentCount: 128 },
            { id: 8, name: 'Brief', documentCount: 64 },
            { id: 10, name: 'Vertrag', documentCount: 31 },
          ],
          documentTypeCacheFilledAt: () => filledAt,
        },
        async () => {
          const response = await call('GET', '/api/simplify/document-types');
          assert.strictEqual(response.status, 200);
          const payload = await response.json();
          assert.strictEqual(payload.success, true);
          assert.deepStrictEqual(
            payload.data.types.map((row) => row.name),
            ['Brief', 'Rechnung', 'vertrag', 'Vertrag'],
            'sorted by name, case-insensitively, the id breaking a tie'
          );
          assert.strictEqual(payload.data.total, 4);
          assert.strictEqual(
            payload.data.cachedAt,
            new Date(filledAt).toISOString(),
            'the page is told how old its choices are'
          );
          const marked = payload.data.types.filter((row) => row.inVocabulary);
          assert.deepStrictEqual(
            marked.map((row) => row.name),
            ['Brief', 'Rechnung'],
            'only a name the saved vocabulary holds is marked'
          );
          // Names are case sensitive in Paperless-ngx, and so is the mark.
          const lower = payload.data.types.find(
            (row) => row.name === 'vertrag'
          );
          assert.strictEqual(lower.inVocabulary, false);
          assert.strictEqual(lower.documentCount, 3);
          assert.strictEqual(lower.id, 9);
        }
      );

      // Nothing cached yet: the page gets null rather than 1970.
      await withStubs(
        paperlessService,
        {
          listDocumentTypesCached: async () => [],
          documentTypeCacheFilledAt: () => 0,
        },
        async () => {
          const response = await call('GET', '/api/simplify/document-types');
          const payload = await response.json();
          assert.deepStrictEqual(payload.data.types, []);
          assert.strictEqual(payload.data.total, 0);
          assert.strictEqual(payload.data.cachedAt, null);
        }
      );
    });

    await test('fresh=1 reaches the service past the cache', async () => {
      const asked = [];
      await withStubs(
        paperlessService,
        {
          listDocumentTypesCached: async (options) => {
            asked.push(options);
            return [];
          },
          documentTypeCacheFilledAt: () => 0,
        },
        async () => {
          await call('GET', '/api/simplify/document-types');
          await call('GET', '/api/simplify/document-types?fresh=1');
          await call('GET', '/api/simplify/document-types?fresh=true');
          await call('GET', '/api/simplify/document-types?fresh=0');
          await call('GET', '/api/simplify/document-types?fresh=please');
        }
      );
      assert.deepStrictEqual(
        asked.map((options) => options.fresh),
        [false, true, true, false, false],
        'only 1, true and yes read past the cache'
      );
    });

    await test('A service that cannot reach Paperless-ngx answers 502', async () => {
      await withStubs(
        paperlessService,
        {
          listDocumentTypesCached: async () => {
            throw new Error('connect ECONNREFUSED 10.0.0.9:8000');
          },
        },
        async () => {
          const response = await call('GET', '/api/simplify/document-types');
          assert.strictEqual(response.status, 502);
          const payload = await response.json();
          assert.strictEqual(payload.success, false);
          assert.match(
            payload.error,
            /Paperless-ngx could not be reached/,
            'the message must name what could not be reached'
          );
          assert.match(payload.error, /ECONNREFUSED/, 'and why');
        }
      );

      // A refusal that already carries a status keeps it.
      await withStubs(
        paperlessService,
        {
          listDocumentTypesCached: async () => {
            const error = new Error('The Paperless-ngx API is not configured');
            error.status = 409;
            throw error;
          },
        },
        async () => {
          const response = await call('GET', '/api/simplify/document-types');
          assert.strictEqual(response.status, 409);
          const payload = await response.json();
          assert.strictEqual(payload.success, false);
          assert.strictEqual(
            payload.error,
            'The Paperless-ngx API is not configured'
          );
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
        html.includes('id="sec-tidy-up"'),
        'the Tidy up section must be on the page'
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
