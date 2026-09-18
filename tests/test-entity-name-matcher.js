/**
 * Test: entity name matcher contract
 *
 * Contract placeholder from the phase's contract commit. It pins the exports
 * and the group shape the merge service and the Duplicates page build
 * against, using the naive exact-match scorer the skeleton ships with. The
 * matcher agent replaces this file with the full suite (normalisation tiers,
 * false-positive guards, clustering, performance) and keeps these cases green.
 */

'use strict';

const assert = require('assert');
const matcher = require('../services/entityNameMatcher');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

function entity(id, name, extra = {}) {
  return {
    id,
    name,
    documentCount: 0,
    matchingAlgorithm: 0,
    match: '',
    isInsensitive: true,
    owner: null,
    userCanChange: true,
    ...extra,
  };
}

test('The contract exports exist', () => {
  for (const key of [
    'KINDS',
    'KIND_LIST',
    'MATCH_REASONS',
    'GROUP_WARNINGS',
    'SENSITIVITY',
    'DEFAULT_THRESHOLD',
    'pairKey',
    'normalizeName',
    'scorePair',
    'suggestTarget',
    'findDuplicateGroups',
  ]) {
    assert.ok(key in matcher, `missing export ${key}`);
  }
  assert.deepStrictEqual(matcher.KIND_LIST, ['tags', 'correspondents']);
  assert.strictEqual(matcher.SENSITIVITY.normal, matcher.DEFAULT_THRESHOLD);
});

test('pairKey is order independent and kind scoped', () => {
  assert.strictEqual(matcher.pairKey('tags', 9, 3), 'tags:3-9');
  assert.strictEqual(matcher.pairKey('tags', 3, 9), 'tags:3-9');
  assert.notStrictEqual(
    matcher.pairKey('tags', 3, 9),
    matcher.pairKey('correspondents', 3, 9)
  );
});

test('Case, surrounding and inner whitespace do not keep two names apart', () => {
  const result = matcher.scorePair('  Amazon ', 'AMAZON', 'tags');
  assert.ok(result, 'expected a match');
  assert.strictEqual(result.score, 1);
  assert.strictEqual(result.reason, matcher.MATCH_REASONS.EXACT);
  assert.strictEqual(matcher.scorePair('Amazon', 'Bank', 'tags'), null);
});

test('A group names its target, carries scores and reasons and is sorted', () => {
  const groups = matcher.findDuplicateGroups(
    [
      entity(3, 'invoices', { documentCount: 2 }),
      entity(1, 'Invoices', { documentCount: 10 }),
      entity(2, 'INVOICES', {
        documentCount: 5,
        matchingAlgorithm: 1,
        match: 'inv',
      }),
      entity(4, 'Receipts', { documentCount: 50 }),
    ],
    { kind: 'tags' }
  );
  assert.strictEqual(groups.length, 1);
  const [group] = groups;
  assert.strictEqual(group.id, 'tags:1-2-3');
  assert.strictEqual(group.kind, 'tags');
  assert.strictEqual(group.suggestedTargetId, 1, 'most documents wins');
  assert.strictEqual(group.confidence, 1);
  assert.deepStrictEqual(group.reasons, [matcher.MATCH_REASONS.EXACT]);
  assert.deepStrictEqual(
    group.members.map((m) => m.id),
    [1, 2, 3],
    'target first, then by documents'
  );
  assert.strictEqual(group.members[0].scoreToTarget, 1);
  assert.strictEqual(group.members[0].reason, null);
  assert.strictEqual(group.members[1].scoreToTarget, 1);
  assert.deepStrictEqual(group.warnings, [
    matcher.GROUP_WARNINGS.HAS_MATCHING_RULE,
  ]);
});

test('Dismissed pairs are left out', () => {
  const groups = matcher.findDuplicateGroups(
    [entity(1, 'Amazon'), entity(2, 'amazon')],
    { kind: 'tags', dismissedPairs: [matcher.pairKey('tags', 2, 1)] }
  );
  assert.strictEqual(groups.length, 0);
});

test('Warnings name inbox tags, configured tags, permissions and owners', () => {
  const groups = matcher.findDuplicateGroups(
    [
      entity(1, 'ai-processed', { isInboxTag: false, owner: 1 }),
      entity(2, 'AI-Processed', {
        isInboxTag: true,
        owner: 2,
        userCanChange: false,
      }),
    ],
    { kind: 'tags', configuredTagNames: ['ai-processed'] }
  );
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].suggestedTargetId, 2, 'the inbox tag survives');
  assert.deepStrictEqual(groups[0].warnings, [
    matcher.GROUP_WARNINGS.INBOX_TAG,
    matcher.GROUP_WARNINGS.CONFIGURED_TAG,
    matcher.GROUP_WARNINGS.NO_PERMISSION,
    matcher.GROUP_WARNINGS.OWNER_DIFFERS,
  ]);
});

test('An unknown kind is rejected', () => {
  assert.throws(() =>
    matcher.findDuplicateGroups([], { kind: 'document_types' })
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
