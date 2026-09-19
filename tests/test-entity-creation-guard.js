/**
 * Test: the creation guard in services/paperlessService.js
 *
 * Document analysis proposes names, not ids. Before this guard existed, a
 * proposal of "Rechnungen" next to an archive that calls it "Rechnung" became
 * the 1360th tag, and the Duplicates page had to clean up afterwards what
 * should never have been created. The guard asks the matcher first: its hard
 * tiers (case, umlauts, legal form, plural, word order) are the same word in
 * another spelling and are used instead of a new object; prefix and fuzzy are
 * only logged, because "Kontoauszug" and "Kontoumzug" are two things.
 *
 * The Paperless-ngx side is the shared store (tests/helpers/fake-paperless.js),
 * the local side the real models/document.js on a throwaway database, so a
 * recorded mapping is a row that was really written.
 *
 * Covers:
 *  1. A hard match is used instead of created, recorded with the document id
 *     and logged
 *  2. A typo-like match creates the name and only logs a hint
 *  3. An inbox tag is never a candidate, however well the name matches
 *  4. A name that exists as it is never reaches the guard
 *  5. With the setting off nothing of this runs
 *  6. Restriction on plus a hard match maps instead of dropping
 *  7. Restriction on plus no match drops the name as before
 *  8. Correspondents: a hard match maps, with "correspondent" in the line
 *  9. Correspondents: a typo-like match creates and hints
 * 10. Correspondents: restriction on plus a hard match maps
 * 11. One list read per kind per minute, whatever the number of documents
 * 12. A name created in between is in the guard's list without a new read
 * 13. A mapping without a document says so
 * 14. A list that cannot be read leaves the old behaviour in place
 * 15. The record of mappings is capped, newest first
 */

'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { createFakePaperless } = require('./helpers/fake-paperless');

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

/** Runs `fn` with console.log and console.warn captured. */
async function withLog(fn) {
  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

function duplicateLines(lines) {
  return lines.filter((line) => line.startsWith('[DUPLICATES]'));
}

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-guard-'));
  process.chdir(tempRoot);

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PAPERLESS_API_URL = 'http://127.0.0.1:9';
  process.env.PAPERLESS_API_TOKEN = 'test-token';
  process.env.ADD_AI_PROCESSED_TAG = 'no';
  delete process.env.RESTRICT_TO_EXISTING_TAGS;
  delete process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS;

  const documentModel = require('../models/document');
  const paperlessService = require('../services/paperlessService');
  const config = require('../config/config');

  config.duplicatesGuardNewNames = 'yes';

  /** A fresh archive, with every cache the guard could read from dropped. */
  function useFake(seed) {
    const fake = createFakePaperless(seed);
    paperlessService.client = fake.client;
    paperlessService.clearTagCache();
    paperlessService.correspondentNameCache.clear();
    paperlessService.lastCorrespondentRefresh = 0;
    paperlessService._invalidateGuardEntities();
    return fake;
  }

  /** Requests listEntities made, per kind: the guard's own list reads. */
  function listReads(fake, kind) {
    return fake.calls.filter(
      (call) => call.path === `/${kind}/` && call.params?.ordering === 'name'
    ).length;
  }

  async function clearMappings() {
    await documentModel.clearEntityNameMappings();
  }

  try {
    await test('A hard match is used instead of created, recorded and logged', async () => {
      const fake = useFake({
        tags: [
          { id: 7, name: 'Rechnung' },
          { id: 8, name: 'Bank' },
        ],
        documents: [{ id: 123, tags: [7] }],
      });
      await clearMappings();

      const { value, lines } = await withLog(() =>
        paperlessService.processTags(['Rechnungen'], { documentId: 123 })
      );

      assert.deepStrictEqual(value.tagIds, [7], 'the existing tag is used');
      assert.deepStrictEqual(value.errors, []);
      assert.deepStrictEqual(
        fake.tagNames().sort(),
        ['Bank', 'Rechnung'],
        'nothing was created in Paperless-ngx'
      );

      const mappings = await documentModel.listEntityNameMappings();
      assert.strictEqual(mappings.length, 1);
      assert.deepStrictEqual(
        {
          kind: mappings[0].kind,
          proposedName: mappings[0].proposedName,
          targetId: mappings[0].targetId,
          targetName: mappings[0].targetName,
          reason: mappings[0].reason,
          score: mappings[0].score,
          documentId: mappings[0].documentId,
        },
        {
          kind: 'tags',
          proposedName: 'Rechnungen',
          targetId: 7,
          targetName: 'Rechnung',
          reason: 'plural',
          score: 0.92,
          documentId: 123,
        },
        'the mapping is recorded with everything the page shows'
      );

      assert.ok(
        duplicateLines(lines).some(
          (line) =>
            line ===
            '[DUPLICATES] mapped tag "Rechnungen" to existing "Rechnung" (plural, 0.92) for document 123.'
        ),
        `no mapping line:\n${duplicateLines(lines).join('\n')}`
      );
    });

    await test('A typo-like match creates the name and only logs a hint', async () => {
      const fake = useFake({
        tags: [{ id: 30, name: 'Kontoauszug' }],
      });
      await clearMappings();

      const { value, lines } = await withLog(() =>
        paperlessService.processTags(['Kontoumzug'], { documentId: 5 })
      );

      assert.strictEqual(value.tagIds.length, 1);
      assert.notStrictEqual(value.tagIds[0], 30, 'a new tag, not the old one');
      assert.ok(
        fake.tagNames().includes('Kontoumzug'),
        'the proposed name was created'
      );
      assert.deepStrictEqual(
        await documentModel.listEntityNameMappings(),
        [],
        'a hint is not a mapping and is not recorded'
      );
      assert.ok(
        duplicateLines(lines).some(
          (line) =>
            line ===
            '[DUPLICATES] created tag "Kontoumzug" although "Kontoauszug" is close (fuzzy, 0.94); not mapped.'
        ),
        `no hint line:\n${duplicateLines(lines).join('\n')}`
      );
    });

    await test('An inbox tag is never what a proposal is mapped onto', async () => {
      const fake = useFake({
        tags: [
          // A hard match of the proposal below, and the inbox tag: without
          // the exception the guard would hand the document straight back to
          // the inbox.
          { id: 35, name: 'Posteingänge', is_inbox_tag: true },
          { id: 36, name: 'Bank' },
        ],
      });
      await clearMappings();

      const { value, lines } = await withLog(() =>
        paperlessService.processTags(['Posteingaenge'], { documentId: 37 })
      );

      assert.notStrictEqual(
        value.tagIds[0],
        35,
        'a document that was just analyzed must not land in the inbox again'
      );
      assert.ok(fake.tagNames().includes('Posteingaenge'));
      assert.deepStrictEqual(await documentModel.listEntityNameMappings(), []);
      assert.deepStrictEqual(
        duplicateLines(lines),
        [],
        'not even a hint: the inbox tag is not a candidate at all'
      );
    });

    await test('A name that exists as it is never reaches the guard', async () => {
      useFake({ tags: [{ id: 40, name: 'Rechnung' }] });
      await clearMappings();

      const { value, lines } = await withLog(() =>
        paperlessService.processTags(['rechnung'], { documentId: 9 })
      );

      assert.deepStrictEqual(value.tagIds, [40], 'found by name, case aside');
      assert.deepStrictEqual(await documentModel.listEntityNameMappings(), []);
      assert.deepStrictEqual(
        duplicateLines(lines),
        [],
        'the guard says nothing about a tag that was simply found'
      );
    });

    await test('With the setting off the name is created as before', async () => {
      const fake = useFake({ tags: [{ id: 50, name: 'Rechnung' }] });
      await clearMappings();
      config.duplicatesGuardNewNames = 'no';
      let result;
      let lines;
      try {
        ({ value: result, lines } = await withLog(() =>
          paperlessService.processTags(['Rechnungen'], { documentId: 1 })
        ));
      } finally {
        config.duplicatesGuardNewNames = 'yes';
      }

      assert.notStrictEqual(result.tagIds[0], 50);
      assert.ok(fake.tagNames().includes('Rechnungen'));
      assert.deepStrictEqual(await documentModel.listEntityNameMappings(), []);
      assert.deepStrictEqual(
        duplicateLines(lines),
        [],
        'the guard is silent when it is switched off'
      );
      assert.strictEqual(
        listReads(fake, 'tags'),
        0,
        'and it reads nothing either'
      );
    });

    await test('Restriction on plus a hard match maps instead of dropping', async () => {
      const fake = useFake({ tags: [{ id: 60, name: 'Rechnung' }] });
      await clearMappings();

      const { value } = await withLog(() =>
        paperlessService.processTags(['Rechnungen'], {
          restrictToExistingTags: true,
          documentId: 61,
        })
      );

      assert.deepStrictEqual(
        value.tagIds,
        [60],
        'a mapped tag is an existing tag'
      );
      assert.deepStrictEqual(value.errors, []);
      assert.deepStrictEqual(fake.tagNames(), ['Rechnung']);
      assert.strictEqual(
        (await documentModel.listEntityNameMappings()).length,
        1
      );
    });

    await test('Restriction on plus no match drops the name as before', async () => {
      const fake = useFake({ tags: [{ id: 70, name: 'Rechnung' }] });
      await clearMappings();

      const { value } = await withLog(() =>
        paperlessService.processTags(['Gartenarbeit'], {
          restrictToExistingTags: true,
          documentId: 71,
        })
      );

      assert.deepStrictEqual(value.tagIds, []);
      assert.strictEqual(value.errors.length, 1);
      assert.strictEqual(
        value.errors[0].error,
        'Tag does not exist and restrictions are enabled'
      );
      assert.deepStrictEqual(fake.tagNames(), ['Rechnung']);
      assert.deepStrictEqual(await documentModel.listEntityNameMappings(), []);
    });

    await test('Correspondents: a hard match maps and says "correspondent"', async () => {
      const fake = useFake({
        correspondents: [
          { id: 80, name: 'Müller GmbH' },
          { id: 81, name: 'Stadtwerke' },
        ],
      });
      await clearMappings();

      const { value, lines } = await withLog(() =>
        paperlessService.getOrCreateCorrespondent('Mueller GmbH', {
          documentId: 777,
        })
      );

      assert.deepStrictEqual(value, { id: 80, name: 'Müller GmbH' });
      assert.deepStrictEqual(
        fake.correspondentNames().sort(),
        ['Müller GmbH', 'Stadtwerke'],
        'nothing was created'
      );
      const mappings = await documentModel.listEntityNameMappings();
      assert.strictEqual(mappings.length, 1);
      assert.strictEqual(mappings[0].kind, 'correspondents');
      assert.strictEqual(mappings[0].reason, 'umlaut-variant');
      assert.strictEqual(mappings[0].documentId, 777);
      assert.ok(
        duplicateLines(lines).some(
          (line) =>
            line ===
            '[DUPLICATES] mapped correspondent "Mueller GmbH" to existing "Müller GmbH" (umlaut-variant, 0.98) for document 777.'
        ),
        `no mapping line:\n${duplicateLines(lines).join('\n')}`
      );
    });

    await test('Correspondents: a typo-like match creates and hints', async () => {
      const fake = useFake({
        correspondents: [{ id: 90, name: 'Amazon EU' }],
      });
      await clearMappings();

      const { value, lines } = await withLog(() =>
        paperlessService.getOrCreateCorrespondent('Amazon EU S.a.r.l.', {
          documentId: 91,
        })
      );

      assert.notStrictEqual(value.id, 90);
      assert.ok(fake.correspondentNames().includes('Amazon EU S.a.r.l.'));
      assert.deepStrictEqual(await documentModel.listEntityNameMappings(), []);
      assert.ok(
        duplicateLines(lines).some(
          (line) =>
            line ===
            '[DUPLICATES] created correspondent "Amazon EU S.a.r.l." although "Amazon EU" is close (prefix, 0.85); not mapped.'
        ),
        `no hint line:\n${duplicateLines(lines).join('\n')}`
      );
    });

    await test('Correspondents: restriction on plus a hard match maps', async () => {
      const fake = useFake({
        correspondents: [{ id: 100, name: 'Telekom Deutschland' }],
      });
      await clearMappings();

      const { value } = await withLog(() =>
        paperlessService.getOrCreateCorrespondent('Telekom Deutschland GmbH', {
          restrictToExistingCorrespondents: true,
          documentId: 101,
        })
      );

      assert.deepStrictEqual(value, { id: 100, name: 'Telekom Deutschland' });
      assert.deepStrictEqual(fake.correspondentNames(), [
        'Telekom Deutschland',
      ]);
      const mappings = await documentModel.listEntityNameMappings();
      assert.strictEqual(mappings[0].reason, 'legal-form');
    });

    await test('One list read per kind per minute, whatever the number of documents', async () => {
      const fake = useFake({
        correspondents: [{ id: 110, name: 'Müller GmbH' }],
      });
      await clearMappings();

      await withLog(async () => {
        for (let documentId = 1; documentId <= 6; documentId += 1) {
          await paperlessService.getOrCreateCorrespondent('Mueller GmbH', {
            documentId,
          });
        }
      });

      assert.strictEqual(
        listReads(fake, 'correspondents'),
        1,
        'the guard read the correspondents once for six documents'
      );
      assert.strictEqual(
        (await documentModel.listEntityNameMappings()).length,
        6,
        'every document still gets its own record'
      );
    });

    await test('A name created in between is in the guard list without a new read', async () => {
      const fake = useFake({
        correspondents: [{ id: 120, name: 'Stadtwerke' }],
      });
      await clearMappings();

      const { lines } = await withLog(async () => {
        // Nothing matches this, so it is created ...
        const created = await paperlessService.getOrCreateCorrespondent(
          'Telekom Deutschland',
          { documentId: 1 }
        );
        assert.ok(created.id > 0);
        // ... and the next document's proposal must find it.
        const mapped = await paperlessService.getOrCreateCorrespondent(
          'Telekom Deutschland GmbH',
          { documentId: 2 }
        );
        assert.strictEqual(
          mapped.id,
          created.id,
          'the freshly created correspondent is what the guard mapped onto'
        );
      });

      assert.strictEqual(
        listReads(fake, 'correspondents'),
        1,
        'and it did not read the list again to learn about it'
      );
      assert.strictEqual(
        fake.correspondentNames().length,
        2,
        'no second Telekom'
      );
      assert.ok(
        duplicateLines(lines).some((line) =>
          /mapped correspondent "Telekom Deutschland GmbH"/.test(line)
        )
      );
    });

    await test('A mapping without a document says so', async () => {
      useFake({ tags: [{ id: 130, name: 'Rechnung' }] });
      await clearMappings();

      const { lines } = await withLog(() =>
        paperlessService.processTags(['Rechnungen'])
      );

      assert.ok(
        duplicateLines(lines).some(
          (line) =>
            line ===
            '[DUPLICATES] mapped tag "Rechnungen" to existing "Rechnung" (plural, 0.92) for no document.'
        ),
        `no mapping line:\n${duplicateLines(lines).join('\n')}`
      );
      const mappings = await documentModel.listEntityNameMappings();
      assert.strictEqual(mappings[0].documentId, null);
    });

    await test('A list that cannot be read leaves the old behaviour in place', async () => {
      const fake = useFake({
        correspondents: [{ id: 140, name: 'Müller GmbH' }],
      });
      await clearMappings();
      const realGet = fake.client.get;
      fake.client.get = async (url, options = {}) => {
        if (url === '/correspondents/' && options.params?.ordering === 'name') {
          throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
        }
        return realGet(url, options);
      };

      let result;
      let lines;
      try {
        ({ value: result, lines } = await withLog(() =>
          paperlessService.getOrCreateCorrespondent('Mueller GmbH', {
            documentId: 141,
          })
        ));
      } finally {
        fake.client.get = realGet;
      }

      assert.notStrictEqual(
        result.id,
        140,
        'without the list the guard cannot map, so the name is created'
      );
      assert.deepStrictEqual(await documentModel.listEntityNameMappings(), []);
      assert.ok(
        duplicateLines(lines).some((line) =>
          /the creation guard could not read the correspondents: /.test(line)
        ),
        `no warning line:\n${duplicateLines(lines).join('\n')}`
      );
    });

    await test('The record of mappings is capped, newest first', async () => {
      await clearMappings();
      for (let i = 1; i <= 205; i += 1) {
        await documentModel.addEntityNameMapping({
          kind: 'tags',
          proposedName: `Proposal ${i}`,
          targetId: 1,
          targetName: 'Target',
          reason: 'plural',
          score: 0.92,
          documentId: i,
        });
      }
      const mappings = await documentModel.listEntityNameMappings();
      assert.strictEqual(mappings.length, 200, 'the model prunes the oldest');
      assert.strictEqual(mappings[0].proposedName, 'Proposal 205');
      assert.strictEqual(mappings[199].proposedName, 'Proposal 6');
      await clearMappings();
    });
  } finally {
    try {
      documentModel.closeDatabase();
    } catch {
      // A failing case may have closed it already.
    }
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
