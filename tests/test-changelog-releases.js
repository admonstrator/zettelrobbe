// Release history exposed to the settings page: entries must be split into a
// category and text, the newest release must come first, and the newest
// release version must stay in sync with PAPERLESS_AI_VERSION.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const changelog = require('../config/changelog');

const KNOWN_CATEGORIES = [
  'new',
  'fix',
  'improvement',
  'removed',
  'security',
  'note',
];

function readConfiguredVersion() {
  const configSource = fs.readFileSync(
    path.join(__dirname, '..', 'config', 'config.js'),
    'utf8'
  );
  const match = /PAPERLESS_AI_VERSION:\s*'([^']+)'/.exec(configSource);
  assert.ok(
    match,
    'PAPERLESS_AI_VERSION must be readable from config/config.js'
  );
  return match[1];
}

function testExistingModalApiIsUnchanged() {
  assert.strictEqual(
    typeof changelog.version,
    'string',
    'version must stay a string for /api/changelog/status'
  );
  assert.ok(
    Array.isArray(changelog.entries),
    'entries must stay an array for /api/changelog/status'
  );
  changelog.entries.forEach((entry) => {
    assert.strictEqual(
      typeof entry,
      'string',
      'the modal still expects raw strings, not categorized objects'
    );
  });
}

function testReleasesAreNewestFirst() {
  assert.ok(
    Array.isArray(changelog.releases) && changelog.releases.length > 0,
    'releases must be a non-empty array'
  );
  assert.strictEqual(
    changelog.releases[0].version,
    changelog.version,
    'the first release must be the latest one - the settings page renders in this order'
  );
}

function testLatestReleaseMatchesAppVersion() {
  assert.strictEqual(
    changelog.releases[0].version,
    readConfiguredVersion(),
    "the newest changelog block must match PAPERLESS_AI_VERSION - bumping one without the other leaves the What's New modal on a stale release"
  );
}

function testEveryEntryIsCategorized() {
  changelog.releases.forEach((release) => {
    assert.ok(
      typeof release.version === 'string' && release.version.length > 0,
      'every release needs a version'
    );
    assert.ok(
      Array.isArray(release.entries) && release.entries.length > 0,
      `release ${release.version} must have at least one entry`
    );

    release.entries.forEach((entry) => {
      assert.ok(
        KNOWN_CATEGORIES.includes(entry.category),
        `unexpected category "${entry.category}" in ${release.version}`
      );
      assert.ok(
        typeof entry.text === 'string' && entry.text.trim().length > 0,
        `empty entry text in ${release.version}`
      );
      assert.ok(
        !/^(new|fix|improvement|removed|security)\s*:/i.test(entry.text),
        `the category prefix must be stripped from the text in ${release.version}: "${entry.text}"`
      );
    });
  });
}

function testCategorizeEntry() {
  assert.deepStrictEqual(
    changelog.categorizeEntry('New: Something was added'),
    { category: 'new', text: 'Something was added' },
    'a New: prefix must map to the new category'
  );
  assert.deepStrictEqual(
    changelog.categorizeEntry('Fix: Something was broken'),
    { category: 'fix', text: 'Something was broken' },
    'a Fix: prefix must map to the fix category'
  );
  assert.deepStrictEqual(
    changelog.categorizeEntry('Improvement: Something got better'),
    { category: 'improvement', text: 'Something got better' },
    'an Improvement: prefix must map to the improvement category'
  );

  // Real entry from v2026.05.01 - reads like a category but has no colon.
  assert.deepStrictEqual(
    changelog.categorizeEntry('Removed RAG features to focus on core'),
    { category: 'note', text: 'Removed RAG features to focus on core' },
    'a missing colon must fall back to note with the text left intact'
  );
  assert.deepStrictEqual(
    changelog.categorizeEntry('Whatever: unknown prefix'),
    { category: 'note', text: 'Whatever: unknown prefix' },
    'an unknown prefix must fall back to note without stripping anything'
  );
}

function testEntryLinksSurviveCategorization() {
  const withLink =
    'New: Something <a href="https://example.com/x">(see here)</a>';
  assert.deepStrictEqual(
    changelog.categorizeEntry(withLink),
    {
      category: 'new',
      text: 'Something <a href="https://example.com/x">(see here)</a>',
    },
    'inline links must survive so the settings page can render them'
  );
}

function testModalShowsHighlightsAndSettingsTheFullList() {
  const latest = changelog.releases[0];
  assert.ok(
    changelog.entries.length <= latest.entries.length,
    'the modal list (highlights) must not be longer than the full list the settings page shows'
  );
  changelog.entries.forEach((entry) => {
    assert.notStrictEqual(
      changelog.categorizeEntry(entry).category,
      'note',
      `every modal entry of ${latest.version} needs a known category prefix: "${entry}"`
    );
  });
}

function run() {
  testExistingModalApiIsUnchanged();
  testReleasesAreNewestFirst();
  testLatestReleaseMatchesAppVersion();
  testEveryEntryIsCategorized();
  testCategorizeEntry();
  testEntryLinksSurviveCategorization();
  testModalShowsHighlightsAndSettingsTheFullList();

  console.log('PASS test-changelog-releases');
}

try {
  run();
} catch (error) {
  console.error('FAIL test-changelog-releases');
  console.error(error);
  process.exit(1);
}
