const assert = require('assert');
const { CachedNameIdEnum } = require('../services/CachedNameIdEnum');

function createEnum(cacheTtl = () => 0) {
  return new CachedNameIdEnum('correspondent', '/correspondents/', cacheTtl);
}

function createClient(pages) {
  const calls = [];
  let pageIndex = 0;
  const client = {
    defaults: { baseURL: 'https://paperless.example/api' },
    get: async (url, options) => {
      calls.push({ url, options });
      const results = pages[pageIndex++] || [];
      const next =
        pageIndex < pages.length
          ? `https://paperless.example/api/page-${pageIndex}`
          : null;
      return { data: { results, next } };
    },
  };
  client.getCalls = () => calls;
  return client;
}

async function run() {
  await assert.rejects(
    () => createEnum().getCount(),
    /No client provided\./,
    'getCount should require a client'
  );

  const enumWithPages = createEnum();
  const pagedClient = createClient([
    [{ id: '1', name: 'Acme' }],
    [{ id: '2', name: 'Tax Office' }],
  ]);
  const refresh = enumWithPages.flush_cache(pagedClient);
  assert.strictEqual(typeof refresh.then, 'function');
  await refresh;
  assert.deepStrictEqual(enumWithPages.element_list, [
    { id: '1', name: 'Acme' },
    { id: '2', name: 'Tax Office' },
  ]);
  assert.deepStrictEqual(
    pagedClient.getCalls().map(({ url, options }) => [url, options]),
    [
      // page_size must ride in axios `params` — a flat property on the config
      // is dropped by real axios and the server answers with its default.
      ['/correspondents/', { params: { page_size: 100 } }],
      ['/page-1', { params: { page_size: 100 } }],
    ]
  );

  const exactClient = createClient([
    [
      { id: '1', name: 'Acme' },
      { id: '2', name: 'Tax Office' },
    ],
  ]);
  const exactEnum = createEnum();
  assert.deepStrictEqual(await exactEnum.getByName(exactClient, 'ACME'), {
    id: '1',
    name: 'Acme',
  });
  assert.deepStrictEqual(await exactEnum.getById(exactClient, '2'), {
    id: '2',
    name: 'Tax Office',
  });
  assert.strictEqual(await exactEnum.getByName(exactClient, 'Unknown'), null);
  assert.strictEqual(await exactEnum.getById(exactClient, 'missing'), null);

  // A near name that no text matcher catches stays unmatched. The enum has
  // no AI tier: it never had a provider method to call, and mapping names
  // onto existing entities by model judgement is Tidy up's job.
  const nearEnum = createEnum();
  const nearClient = createClient([[{ id: 42, name: 'Acme Corporation' }]]);
  assert.strictEqual(
    await nearEnum.getByName(nearClient, 'The Acme business'),
    null
  );
  assert.strictEqual(nearEnum.ai_service, undefined);
  assert.strictEqual(typeof nearEnum._findSemanticMatch, 'undefined');

  const missEnum = createEnum();
  const missClient = createClient([
    [{ id: '1', name: 'Old' }],
    [{ id: '2', name: 'New' }],
  ]);
  assert.deepStrictEqual(await missEnum.getByName(missClient, 'New'), {
    id: '2',
    name: 'New',
  });
  assert.strictEqual(missClient.getCalls().length, 2);

  const visitorEnum = createEnum();
  const visitorClient = createClient([
    [
      { id: '1', name: 'Acme' },
      { id: '2', name: 'Tax Office' },
    ],
  ]);
  const visited = [];
  const resultSet = await visitorEnum.visitAllContainedElements(
    visitorClient,
    (element, set) => {
      visited.push(element.name);
      set.add(element.id);
    }
  );
  assert.deepStrictEqual(visited, ['Acme', 'Tax Office']);
  assert.deepStrictEqual([...resultSet], ['1', '2']);
  assert.strictEqual(await visitorEnum.getCount(visitorClient), 2);

  await assert.rejects(
    () => createEnum().getByName(exactClient, undefined),
    /Mandatory argument name is undefined or null\./
  );
  await assert.rejects(
    () => createEnum().getByName(exactClient, null),
    /Mandatory argument name is undefined or null\./
  );
  await assert.rejects(
    () => createEnum().getById(exactClient, undefined),
    /Mandatory argument id is undefined or null\./
  );
  await assert.rejects(
    () => createEnum().getById(exactClient, null),
    /Mandatory argument id is undefined or null\./
  );

  const zeroIdEnum = createEnum();
  const zeroIdClient = createClient([[{ id: 0, name: 'Invalid' }]]);
  assert.strictEqual(await zeroIdEnum.getById(zeroIdClient, 0), null);
  assert.strictEqual(zeroIdClient.getCalls().length, 0);

  const substringEnum = createEnum();
  const substringClient = createClient([
    [{ id: 42, name: 'Acme Corporation' }],
  ]);
  assert.deepStrictEqual(
    await substringEnum.getByName(substringClient, 'Acme'),
    {
      id: 42,
      name: 'Acme Corporation',
    }
  );

  const refreshEnum = createEnum();
  let resolveRefresh;
  const refreshClient = {
    defaults: { baseURL: 'https://paperless.example/api' },
    getCalls: () => refreshCalls,
    get: async (...args) => {
      refreshCalls.push(args);
      await new Promise((resolve) => {
        resolveRefresh = resolve;
      });
      return { data: { results: [{ id: 7, name: 'Shared' }], next: null } };
    },
  };
  const refreshCalls = [];
  const firstRefresh = refreshEnum.flush_cache(refreshClient);
  const secondRefresh = refreshEnum.flush_cache(refreshClient);
  assert.strictEqual(firstRefresh, secondRefresh);
  resolveRefresh();
  await firstRefresh;
  assert.strictEqual(refreshCalls.length, 1);
  assert.strictEqual(await refreshEnum.getCount(refreshClient), 1);

  const expiringEnum = createEnum(() => 1);
  let expiringFetchNo = 0;
  const expiringCalls = [];
  const expiringClient = {
    defaults: { baseURL: 'https://paperless.example/api' },
    get: async (url, options) => {
      expiringCalls.push({ url, options });
      expiringFetchNo += 1;
      return {
        data: {
          results: [
            expiringFetchNo === 1
              ? { id: 1, name: 'First' }
              : { id: 2, name: 'Second' },
          ],
          next: null,
        },
      };
    },
    getCalls: () => expiringCalls,
  };
  await expiringEnum.getCount(expiringClient);
  assert.strictEqual(expiringClient.getCalls().length, 1);
  expiringEnum.cache_last_fetch_time = Date.now() - 10;
  assert.strictEqual(await expiringEnum.getCount(expiringClient), 1);
  assert.strictEqual(expiringClient.getCalls().length, 2);

  assert.throws(() => createEnum().flush_cache(), /No client provided\./);
  await assert.rejects(
    () => createEnum().getByName(null, 'Acme'),
    /No client provided\./
  );
  await assert.rejects(
    () => createEnum().getById(null, '1'),
    /No client provided\./
  );
  await assert.rejects(
    () => createEnum().visitAllContainedElements(null, () => {}),
    /No client provided\./
  );

  console.log('✅ test-cached-name-id-enum passed');
}

run().catch((error) => {
  console.error('❌ test-cached-name-id-enum failed:', error);
  process.exit(1);
});
