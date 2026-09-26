/**
 * Test: the AI-processed tag also reaches documents the model gave no tags for
 *
 * processTags() returned early when the tag list was empty or null, and the
 * block that applies the configured completion tag sits at the end of that
 * same function. Roughly one document in ten comes back from analysis with a
 * title, a correspondent, a type and a date but without a single subject tag,
 * and every one of those left Paperless-ngx without the "ai-processed" tag.
 * The operator saw documents that were plainly processed keep their "AI Queue"
 * tag, so the Paperless-ngx workflow waiting on the completion tag never ran
 * and the queue only ever grew.
 *
 * Covers:
 * 1. An empty tag array still applies the completion tag
 * 2. null instead of a list is the same case
 * 3. Subject tags and the completion tag arrive together
 * 4. The completion tag is applied once, even when it is also passed in
 * 5. ADD_AI_PROCESSED_TAG=no, or no name, means no tag
 * 6. RESTRICT_TO_EXISTING_TAGS=yes still creates the completion tag, because
 *    it is the app's own bookkeeping and not a proposal from the model
 * 7. A completion tag that cannot be created does not cost the other tags
 * 8. server.js no longer passes the completion tag in as a subject tag
 */

'use strict';

// The creation guard maps proposed names onto existing objects and reads the
// database to do so. It is not what this test is about, and it must not turn
// an offline test into one that needs data/documents.db.
process.env.DUPLICATES_GUARD_NEW_NAMES = 'no';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const paperlessService = require('../services/paperlessService');

const AI_TAG = 'ai-processed';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

/**
 * A Paperless-ngx that knows the given tags, answers name__iexact lookups and
 * hands out an id for everything it is asked to create.
 */
function createTagServer({ existing = [], failCreateFor = [] } = {}) {
  const tags = new Map();
  const created = [];
  let nextId = 1;

  for (const name of existing) {
    tags.set(name.toLowerCase(), { id: nextId, name });
    nextId += 1;
  }

  return {
    tags,
    created,
    defaults: { baseURL: 'http://paperless.test/api' },
    get: async (url, options = {}) => {
      const wanted = options?.params?.name__iexact;
      if (wanted) {
        const hit = tags.get(String(wanted).toLowerCase());
        return { data: { results: hit ? [hit] : [] } };
      }
      // The cache refresh reads the whole list.
      return {
        data: { count: tags.size, results: [...tags.values()], next: null },
      };
    },
    post: async (url, body) => {
      const name = body?.name;
      created.push(name);
      if (failCreateFor.includes(name)) {
        throw new Error(`Paperless-ngx refused to create "${name}"`);
      }
      const tag = { id: nextId, name };
      nextId += 1;
      tags.set(name.toLowerCase(), tag);
      return { data: tag };
    },
  };
}

async function withServer(server, fn) {
  const originalClient = paperlessService.client;
  paperlessService.client = server;
  paperlessService.tagCache.clear();
  paperlessService.lastTagRefresh = 0;
  try {
    return await fn();
  } finally {
    paperlessService.client = originalClient;
    paperlessService.tagCache.clear();
    paperlessService.lastTagRefresh = 0;
  }
}

function configure({ addTag = 'yes', tagName = AI_TAG, restrict = 'no' }) {
  process.env.ADD_AI_PROCESSED_TAG = addTag;
  process.env.AI_PROCESSED_TAG_NAME = tagName;
  process.env.RESTRICT_TO_EXISTING_TAGS = restrict;
}

function idOf(server, name) {
  const tag = server.tags.get(name.toLowerCase());
  assert.ok(tag, `the server never learned about the tag "${name}"`);
  return tag.id;
}

async function main() {
  await test('A document the model gave no tags for still gets the completion tag', async () => {
    configure({});
    const server = createTagServer({ existing: [AI_TAG] });

    const result = await withServer(server, () =>
      paperlessService.processTags([])
    );

    assert.deepStrictEqual(
      result.tagIds,
      [idOf(server, AI_TAG)],
      'an empty tag list is still a processed document'
    );
    assert.deepStrictEqual(result.errors, [], 'nothing went wrong here');
  });

  await test('null instead of a tag list is the same case', async () => {
    configure({});
    const server = createTagServer({ existing: [AI_TAG] });

    const result = await withServer(server, () =>
      paperlessService.processTags(null)
    );

    assert.deepStrictEqual(
      result.tagIds,
      [idOf(server, AI_TAG)],
      'a missing tag list must not skip the completion tag either'
    );
  });

  await test('The completion tag is created when the instance does not have it yet', async () => {
    configure({});
    const server = createTagServer();

    const result = await withServer(server, () =>
      paperlessService.processTags([])
    );

    assert.deepStrictEqual(
      server.created,
      [AI_TAG],
      'the completion tag has to be created once'
    );
    assert.deepStrictEqual(result.tagIds, [idOf(server, AI_TAG)]);
  });

  await test('Subject tags and the completion tag arrive together', async () => {
    configure({});
    const server = createTagServer({ existing: ['Invoice', 'Bank', AI_TAG] });

    const result = await withServer(server, () =>
      paperlessService.processTags(['Invoice', 'Bank'])
    );

    assert.deepStrictEqual(
      [...result.tagIds].sort((a, b) => a - b),
      [
        idOf(server, 'Invoice'),
        idOf(server, 'Bank'),
        idOf(server, AI_TAG),
      ].sort((a, b) => a - b),
      'the subject tags must survive the completion tag'
    );
  });

  await test('The completion tag is applied once when it is also passed in', async () => {
    // This is the call site that runs with tagging deactivated: it used to
    // hand the completion tag to processTags() as an ordinary tag name.
    configure({});
    const server = createTagServer({ existing: [AI_TAG] });

    const result = await withServer(server, () =>
      paperlessService.processTags([AI_TAG])
    );

    assert.deepStrictEqual(
      result.tagIds,
      [idOf(server, AI_TAG)],
      'the document must not carry the completion tag twice'
    );
    assert.deepStrictEqual(
      server.created,
      [],
      'an existing completion tag is never created again'
    );
  });

  await test('ADD_AI_PROCESSED_TAG=no means no completion tag', async () => {
    configure({ addTag: 'no' });
    const server = createTagServer({ existing: ['Invoice'] });

    const empty = await withServer(server, () =>
      paperlessService.processTags([])
    );
    const withTags = await withServer(server, () =>
      paperlessService.processTags(['Invoice'])
    );

    assert.deepStrictEqual(empty.tagIds, [], 'the toggle is off');
    assert.deepStrictEqual(withTags.tagIds, [idOf(server, 'Invoice')]);
    assert.deepStrictEqual(
      server.created,
      [],
      'nothing may be created while the toggle is off'
    );
  });

  await test('An empty AI_PROCESSED_TAG_NAME means no completion tag', async () => {
    configure({ tagName: '' });
    const server = createTagServer();

    const result = await withServer(server, () =>
      paperlessService.processTags([])
    );

    assert.deepStrictEqual(result.tagIds, []);
    assert.deepStrictEqual(
      server.created,
      [],
      'a nameless tag must not be invented'
    );
  });

  await test('RESTRICT_TO_EXISTING_TAGS=yes still creates the completion tag', async () => {
    // The restriction keeps the model from inventing tags. The completion
    // tag is the app's own bookkeeping, so it is exempt.
    configure({ restrict: 'yes' });
    const server = createTagServer({ existing: ['Invoice'] });

    const result = await withServer(server, () =>
      paperlessService.processTags(['Invoice', 'Something the model made up'])
    );

    assert.deepStrictEqual(
      server.created,
      [AI_TAG],
      'only the completion tag may be created under the restriction'
    );
    assert.deepStrictEqual(
      [...result.tagIds].sort((a, b) => a - b),
      [idOf(server, 'Invoice'), idOf(server, AI_TAG)].sort((a, b) => a - b)
    );
    assert.strictEqual(
      result.errors.length,
      1,
      'the rejected proposal is reported'
    );
  });

  await test('A completion tag that cannot be created does not cost the other tags', async () => {
    configure({});
    const server = createTagServer({
      existing: ['Invoice'],
      failCreateFor: [AI_TAG],
    });

    const result = await withServer(server, () =>
      paperlessService.processTags(['Invoice'])
    );

    assert.deepStrictEqual(
      result.tagIds,
      [idOf(server, 'Invoice')],
      'the subject tags are written even when the completion tag fails'
    );
    assert.strictEqual(result.errors.length, 1, 'the failure is recorded');
    assert.strictEqual(result.errors[0].tagName, AI_TAG);
  });

  await test('server.js leaves the completion tag to processTags()', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'server.js'),
      'utf8'
    );

    assert.ok(
      !/addAIProcessedTags\s*\.split/.test(source),
      'the tagging-deactivated branch must not pass the completion tag in as a subject tag — processTags() applies it itself'
    );
    assert.ok(
      /processTags\(\s*\[\],\s*options\s*\)/.test(source),
      'the tagging-deactivated branch still has to call processTags() so the completion tag is applied'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exitCode = 1;
});
