/**
 * Test: the tag cache lifetime follows TAG_CACHE_TTL_SECONDS without a restart
 *
 * paperlessService.CACHE_LIFETIME read TAG_CACHE_TTL_SECONDS on its first use
 * and kept that value for the life of the process, although the setting's
 * catalogue entry has no restart flag and config/config.js reads every value
 * on every access. Only a save on the settings page reset it; any other change
 * of the variable was ignored until the next start.
 *
 * Covers:
 * 1. CACHE_LIFETIME follows the variable on every read, the default when it
 *    is unset
 * 2. ensureTagCache() refreshes a cache of a given age or keeps it, by the
 *    lifetime in effect at the time of the call
 * 3. the catalogue entry needs no restart
 */

'use strict';

const assert = require('assert');
const paperlessService = require('../services/paperlessService');
const settingsCatalog = require('../services/settingsCatalog');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

const KEY = 'TAG_CACHE_TTL_SECONDS';
const saved = process.env[KEY];

function setTtl(value) {
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
}

/** ensureTagCache() on a filled cache of `ageSeconds`; whether it refreshed. */
async function refreshesAtAge(ageSeconds) {
  const refreshes = [];
  const realRefresh = paperlessService.refreshTagCache;
  const realLog = console.log;
  paperlessService.refreshTagCache = async () => {
    refreshes.push(Date.now());
  };
  console.log = () => {};
  try {
    paperlessService.tagCache.set('inbox', { id: 1, name: 'Inbox' });
    paperlessService.lastTagRefresh = Date.now() - ageSeconds * 1000;
    await paperlessService.ensureTagCache();
    return refreshes.length > 0;
  } finally {
    paperlessService.refreshTagCache = realRefresh;
    console.log = realLog;
    paperlessService.tagCache.clear();
    paperlessService.lastTagRefresh = 0;
  }
}

(async () => {
  try {
    await test('CACHE_LIFETIME follows the variable on every read', () => {
      setTtl(undefined);
      assert.strictEqual(paperlessService.CACHE_LIFETIME, 300 * 1000);
      setTtl('60');
      assert.strictEqual(paperlessService.CACHE_LIFETIME, 60 * 1000);
      setTtl('900');
      assert.strictEqual(paperlessService.CACHE_LIFETIME, 900 * 1000);
      setTtl('');
      assert.strictEqual(paperlessService.CACHE_LIFETIME, 300 * 1000);
    });

    await test('the cache refreshes by the lifetime in effect at the call', async () => {
      setTtl('300');
      assert.strictEqual(
        await refreshesAtAge(120),
        false,
        'two minutes old, five minutes lifetime: kept'
      );
      setTtl('60');
      assert.strictEqual(
        await refreshesAtAge(120),
        true,
        'two minutes old, one minute lifetime: refreshed'
      );
      setTtl('600');
      assert.strictEqual(
        await refreshesAtAge(400),
        false,
        'six minutes old, ten minutes lifetime: kept'
      );
    });

    await test('the catalogue entry needs no restart', () => {
      const entry = settingsCatalog.getEntry(KEY);
      assert.ok(entry, 'catalogued');
      assert.ok(!entry.restart, 'restart: false');
    });
  } finally {
    setTtl(saved);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
