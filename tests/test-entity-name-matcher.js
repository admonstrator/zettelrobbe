/**
 * Test: entity name matcher
 *
 * Covers the contract the merge service and the Duplicates page build against
 * (exports, group shape, warnings, sorting), the normalisation and the seven
 * scoring tiers with the archive names they were written for, the guards that
 * keep false positives out, the star clustering that refuses chains, and the
 * two properties the scan depends on: blocking finds exactly what scoring
 * every pair finds, and five thousand names are grouped in under two seconds.
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

const REASONS = matcher.MATCH_REASONS;

/** Pairs the archive really contains, with the tier each one has to hit. */
const MATCHES = [
  {
    a: 'Amazon',
    b: 'amazon ',
    kind: 'tags',
    score: 1,
    reason: REASONS.EXACT,
  },
  {
    a: 'Müller GmbH',
    b: 'Mueller GmbH',
    kind: 'correspondents',
    score: 0.98,
    reason: REASONS.UMLAUT,
  },
  {
    a: 'Müller GmbH',
    b: 'Mueller GmbH & Co. KG',
    kind: 'correspondents',
    score: 0.95,
    reason: REASONS.LEGAL_FORM,
  },
  {
    a: 'Deutsche Bank AG',
    b: 'Deutsche Bank',
    kind: 'correspondents',
    score: 0.95,
    reason: REASONS.LEGAL_FORM,
  },
  {
    a: 'Rechnung',
    b: 'Rechnungen',
    kind: 'tags',
    score: 0.92,
    reason: REASONS.PLURAL,
  },
  {
    a: 'Invoice',
    b: 'Invoices',
    kind: 'tags',
    score: 0.92,
    reason: REASONS.PLURAL,
  },
  {
    a: 'Deutsche Bank',
    b: 'Bank Deutsche',
    kind: 'correspondents',
    score: 0.9,
    reason: REASONS.TOKEN_ORDER,
  },
  {
    a: 'Amazon',
    b: 'Amazon EU S.a.r.l.',
    kind: 'correspondents',
    score: 0.85,
    reason: REASONS.PREFIX,
  },
  {
    a: 'Vodafone',
    b: 'Vodafon',
    kind: 'correspondents',
    score: 0.94,
    reason: REASONS.FUZZY,
  },
  {
    a: 'Telekom Deutschland GmbH',
    b: 'Deutsche Telekom',
    kind: 'correspondents',
    minScore: 0.75,
    reason: REASONS.FUZZY,
  },
];

/** Pairs that only look alike; none of them may ever score. */
const NON_MATCHES = [
  { a: 'Bank', b: 'Bahn', kind: 'correspondents' },
  { a: 'Deutsche Bank', b: 'Deutsche Post', kind: 'correspondents' },
  { a: 'Deutsche Bank', b: 'Deutsche Bahn', kind: 'correspondents' },
  { a: 'Rechnung', b: 'Rechnungswesen', kind: 'tags' },
  { a: 'Rechnungen', b: 'Rechnungswesen', kind: 'tags' },
  { a: 'AG', b: 'AOK', kind: 'correspondents' },
  { a: 'IT', b: 'ITK', kind: 'tags' },
  { a: 'Steuer', b: 'Stauer', kind: 'tags' },
];

// ── The contract ────────────────────────────────────────────────────────────

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

// ── normalizeName ───────────────────────────────────────────────────────────

test('normalizeName returns exactly the four contract fields', () => {
  const normalized = matcher.normalizeName('Müller GmbH', 'correspondents');
  assert.deepStrictEqual(Object.keys(normalized).sort(), [
    'asciiKey',
    'foldedKey',
    'key',
    'tokens',
  ]);
  assert.ok(Array.isArray(normalized.tokens));
});

test('key normalises unicode, case, padding and inner whitespace', () => {
  assert.strictEqual(
    matcher.normalizeName('  Deutsche   BANK\tAG ', 'correspondents').key,
    'deutsche bank ag'
  );
  // NFKC folds the compatibility forms and composes a decomposed umlaut.
  assert.strictEqual(
    matcher.normalizeName('Ｍüller', 'correspondents').key,
    matcher.normalizeName('Müller', 'correspondents').key
  );
});

test('asciiKey spells umlauts out before it drops the other diacritics', () => {
  const ascii = (name) =>
    matcher.normalizeName(name, 'correspondents').asciiKey;
  assert.strictEqual(ascii('Müller'), 'mueller');
  assert.strictEqual(ascii('Mueller'), 'mueller');
  assert.strictEqual(ascii('Muller'), 'muller');
  assert.strictEqual(ascii('Schäfer & Söhne'), 'schaefer & soehne');
  assert.strictEqual(ascii('Weiß'), 'weiss');
  assert.strictEqual(ascii('Café Crème'), 'cafe creme');
});

test('tokens split on punctuation and drop empty words', () => {
  assert.deepStrictEqual(
    matcher.normalizeName('Amazon EU S.a.r.l.', 'correspondents').tokens,
    ['amazon', 'eu', 's', 'a', 'r', 'l']
  );
  assert.deepStrictEqual(
    matcher.normalizeName('Müller-Meier & Co. (Nord)/Süd', 'correspondents')
      .tokens,
    ['mueller', 'meier', 'co', 'nord', 'sued']
  );
  assert.deepStrictEqual(matcher.normalizeName('...', 'tags').tokens, []);
});

test('foldedKey drops legal forms and articles for correspondents only', () => {
  const folded = (name, kind) => matcher.normalizeName(name, kind).foldedKey;
  assert.strictEqual(
    folded('Müller GmbH & Co. KG', 'correspondents'),
    'mueller'
  );
  assert.strictEqual(folded('Die Bank AG', 'correspondents'), 'bank');
  assert.strictEqual(
    folded('UG (haftungsbeschränkt) Meier', 'correspondents'),
    'meier'
  );
  assert.strictEqual(
    folded('Müller GmbH & Co. KG', 'tags'),
    'mueller gmbh co kg',
    'tags keep every word'
  );
});

test('A name made only of legal forms keeps them', () => {
  assert.strictEqual(
    matcher.normalizeName('GmbH', 'correspondents').foldedKey,
    'gmbh'
  );
  assert.strictEqual(
    matcher.normalizeName('GmbH & Co. KG', 'correspondents').foldedKey,
    'gmbh co kg'
  );
});

test('Tags fold the plural of their last word, English and German', () => {
  const folded = (name) => matcher.normalizeName(name, 'tags').foldedKey;
  assert.strictEqual(folded('Invoices'), folded('Invoice'));
  assert.strictEqual(folded('Parties'), 'party');
  assert.strictEqual(folded('Rechnungen'), 'rechnung');
  assert.strictEqual(folded('Steuern'), 'steuer');
  assert.strictEqual(folded('Briefe'), folded('Briefen'));
  assert.strictEqual(folded('Offene Rechnungen'), 'offene rechnung');
});

test('A plural is only folded when four characters survive', () => {
  const folded = (name) => matcher.normalizeName(name, 'tags').foldedKey;
  assert.strictEqual(folded('Ties'), 'ties', 'stem would be too short');
  assert.strictEqual(folded('Bees'), 'bees');
  assert.strictEqual(folded('Kosten'), 'kost', 'four characters are enough');
});

// ── The scoring tiers ───────────────────────────────────────────────────────

test('Every archive fixture hits its tier', () => {
  for (const item of MATCHES) {
    const result = matcher.scorePair(item.a, item.b, item.kind);
    assert.ok(result, `no match for ${item.a} / ${item.b}`);
    assert.strictEqual(
      result.reason,
      item.reason,
      `${item.a} / ${item.b}: reason`
    );
    if (item.score !== undefined) {
      assert.strictEqual(
        result.score,
        item.score,
        `${item.a} / ${item.b}: score ${result.score}`
      );
    } else {
      assert.ok(
        result.score >= item.minScore,
        `${item.a} / ${item.b}: ${result.score} < ${item.minScore}`
      );
    }
  }
});

test('Tier 1 and 2: the same name, spelled differently', () => {
  assert.deepStrictEqual(matcher.scorePair('Amazon', 'amazon ', 'tags'), {
    score: 1,
    reason: REASONS.EXACT,
  });
  assert.deepStrictEqual(
    matcher.scorePair('Müller GmbH', 'Mueller GmbH', 'correspondents'),
    { score: 0.98, reason: REASONS.UMLAUT }
  );
  assert.deepStrictEqual(
    matcher.scorePair('Stadtwerke München', 'Stadtwerke Muenchen', 'tags'),
    { score: 0.98, reason: REASONS.UMLAUT }
  );
});

test('Tier 3: the legal form of a correspondent makes no difference', () => {
  for (const [a, b] of [
    ['Müller GmbH', 'Mueller GmbH & Co. KG'],
    ['Deutsche Bank AG', 'Deutsche Bank'],
    ['Die Techniker Krankenkasse', 'Techniker Krankenkasse'],
    ['Autohaus Weber e.V.', 'Autohaus Weber'],
  ]) {
    const result = matcher.scorePair(a, b, 'correspondents');
    assert.ok(result, `no match for ${a} / ${b}`);
    assert.strictEqual(result.reason, REASONS.LEGAL_FORM, `${a} / ${b}`);
    assert.ok(result.score >= 0.95, `${a} / ${b}: ${result.score}`);
  }
});

test('Tier 4: a tag and its plural', () => {
  for (const [a, b] of [
    ['Rechnung', 'Rechnungen'],
    ['Invoice', 'Invoices'],
    ['Steuer', 'Steuern'],
    ['Offene Rechnung', 'Offene Rechnungen'],
  ]) {
    assert.deepStrictEqual(matcher.scorePair(a, b, 'tags'), {
      score: 0.92,
      reason: REASONS.PLURAL,
    });
  }
});

test('Tier 5: the same words in another order', () => {
  assert.deepStrictEqual(
    matcher.scorePair('Deutsche Bank', 'Bank Deutsche', 'correspondents'),
    { score: 0.9, reason: REASONS.TOKEN_ORDER }
  );
  assert.deepStrictEqual(
    matcher.scorePair('Müller-Meier', 'Meier Müller', 'correspondents'),
    { score: 0.9, reason: REASONS.TOKEN_ORDER }
  );
});

test('Tier 6: a whole name inside a longer one', () => {
  assert.deepStrictEqual(
    matcher.scorePair('Amazon', 'Amazon EU S.a.r.l.', 'correspondents'),
    { score: 0.85, reason: REASONS.PREFIX }
  );
  assert.deepStrictEqual(
    matcher.scorePair('Müller Meier', 'Rechtsanwalt Müller Meier', 'tags'),
    { score: 0.85, reason: REASONS.PREFIX },
    'a suffix counts as well'
  );
  assert.strictEqual(
    matcher.scorePair('Abo', 'Abo Zeitung Nord', 'tags'),
    null,
    'three characters are not enough on their own'
  );
});

test('Tier 7: a typo and a reordered spelling variant', () => {
  const typo = matcher.scorePair('Vodafone', 'Vodafon', 'correspondents');
  assert.strictEqual(typo.reason, REASONS.FUZZY);
  assert.ok(typo.score >= 0.9, `expected >= 0.90, got ${typo.score}`);
  assert.ok(typo.score <= 0.94, 'fuzzy never reaches the strict preset');

  const reordered = matcher.scorePair(
    'Telekom Deutschland GmbH',
    'Deutsche Telekom',
    'correspondents'
  );
  assert.strictEqual(reordered.reason, REASONS.FUZZY);
  assert.ok(
    reordered.score >= matcher.SENSITIVITY.loose,
    `expected >= 0.75, got ${reordered.score}`
  );
});

test('The kind decides which folding applies', () => {
  const asTag = matcher.scorePair('Rechnung', 'Rechnungen', 'tags');
  const asCorrespondent = matcher.scorePair(
    'Rechnung',
    'Rechnungen',
    'correspondents'
  );
  assert.strictEqual(asTag.reason, REASONS.PLURAL);
  assert.strictEqual(
    asCorrespondent.reason,
    REASONS.FUZZY,
    'correspondents have no plural rule'
  );

  assert.strictEqual(
    matcher.scorePair('Müller GmbH', 'Müller', 'correspondents').reason,
    REASONS.LEGAL_FORM
  );
  assert.strictEqual(
    matcher.scorePair('Müller GmbH', 'Müller', 'tags').reason,
    REASONS.PREFIX,
    'tags know no legal forms'
  );
});

// ── The guards ──────────────────────────────────────────────────────────────

test('None of the look-alike pairs ever scores', () => {
  for (const item of NON_MATCHES) {
    assert.strictEqual(
      matcher.scorePair(item.a, item.b, item.kind),
      null,
      `${item.a} / ${item.b} should not match`
    );
  }
});

test('A name shorter than four characters only matches exactly', () => {
  assert.strictEqual(matcher.scorePair('AG', 'AOK', 'correspondents'), null);
  assert.strictEqual(matcher.scorePair('IT', 'ITK', 'tags'), null);
  assert.strictEqual(matcher.scorePair('KFZ', 'KFZ Meier', 'tags'), null);
  assert.deepStrictEqual(matcher.scorePair('AG', 'ag ', 'correspondents'), {
    score: 1,
    reason: REASONS.EXACT,
  });
  assert.deepStrictEqual(matcher.scorePair('Öl', 'Oel', 'tags'), {
    score: 0.98,
    reason: REASONS.UMLAUT,
  });
});

test('Names that share neither a prefix nor a token never go fuzzy', () => {
  // The decision behind "Steuer" / "Stauer": a typo in the first three
  // characters is not found, and Damerau-Levenshtein alone is not allowed to
  // pair two six-letter words. The same rule is what makes blocking exact.
  assert.strictEqual(matcher.scorePair('Steuer', 'Stauer', 'tags'), null);
  assert.strictEqual(matcher.scorePair('Bank', 'Bahn', 'correspondents'), null);
  assert.strictEqual(
    matcher.scorePair('Mayer', 'Maier', 'correspondents'),
    null
  );
  // A shared token of four characters is enough to look.
  assert.ok(
    matcher.scorePair('Telekom Nord', 'Telekom Nrod', 'correspondents')
  );
});

test('A word inside a longer word is not a duplicate', () => {
  assert.strictEqual(
    matcher.scorePair('Rechnung', 'Rechnungswesen', 'tags'),
    null
  );
  assert.strictEqual(
    matcher.scorePair('Bank', 'Bankverbindung Deutschland', 'correspondents'),
    null
  );
  assert.strictEqual(matcher.scorePair('Auto', 'Autohaus Meier', 'tags'), null);
  // Jaro-Winkler alone scores this pair 0.94 because of the long prefix.
  assert.strictEqual(
    matcher.scorePair('Rechnungen', 'Rechnungswesen', 'tags'),
    null
  );
  assert.ok(matcher.jaroWinkler('rechnungen', 'rechnungswesen') > 0.92);
});

test('Two names of the same shape need every word to fit', () => {
  assert.strictEqual(
    matcher.scorePair('Deutsche Bank', 'Deutsche Post', 'correspondents'),
    null
  );
  assert.strictEqual(
    matcher.scorePair('Deutsche Bank', 'Deutsche Bahn', 'correspondents'),
    null,
    'Jaro-Winkler alone would call this 0.97'
  );
  assert.strictEqual(
    matcher.scorePair('Stadtwerke Nord', 'Stadtwerke Süd', 'correspondents'),
    null
  );
});

test('Empty and blank names never match', () => {
  assert.strictEqual(matcher.scorePair('', '', 'tags'), null);
  assert.strictEqual(matcher.scorePair('   ', 'Amazon', 'tags'), null);
  assert.strictEqual(matcher.scorePair(null, undefined, 'tags'), null);
  assert.strictEqual(
    matcher.findDuplicateGroups(
      [entity(1, '  '), entity(2, ''), entity(3, 'Amazon')],
      { kind: 'tags' }
    ).length,
    0
  );
});

test('Scores are symmetric and repeatable', () => {
  for (const item of [...MATCHES, ...NON_MATCHES]) {
    const forward = matcher.scorePair(item.a, item.b, item.kind);
    const backward = matcher.scorePair(item.b, item.a, item.kind);
    const again = matcher.scorePair(item.a, item.b, item.kind);
    assert.deepStrictEqual(
      forward,
      backward,
      `${item.a} / ${item.b} is not symmetric`
    );
    assert.deepStrictEqual(forward, again, `${item.a} / ${item.b} drifts`);
  }
});

test('The precomputed normalisations of the hot path change nothing', () => {
  for (const item of MATCHES) {
    const plain = matcher.scorePair(item.a, item.b, item.kind);
    const withHint = matcher.scorePair(item.a, item.b, item.kind, {
      a: matcher.normalizeName(item.a, item.kind),
      b: matcher.normalizeName(item.b, item.kind),
    });
    assert.deepStrictEqual(withHint, plain, `${item.a} / ${item.b}`);
  }
  assert.deepStrictEqual(
    matcher.scorePair('Amazon', 'amazon', 'tags', { a: null, b: undefined }),
    { score: 1, reason: REASONS.EXACT }
  );
});

// ── The sensitivity presets ─────────────────────────────────────────────────

test('The strict preset keeps every fuzzy and prefix pair out', () => {
  for (const item of MATCHES) {
    const result = matcher.scorePair(item.a, item.b, item.kind);
    const survives = result.score >= matcher.SENSITIVITY.strict;
    const expected = [
      REASONS.EXACT,
      REASONS.UMLAUT,
      REASONS.LEGAL_FORM,
    ].includes(item.reason);
    assert.strictEqual(
      survives,
      expected,
      `${item.a} / ${item.b} at strict: ${result.score}`
    );
  }
});

test('The loosest preset still refuses the look-alike pairs', () => {
  for (const item of NON_MATCHES) {
    const groups = matcher.findDuplicateGroups(
      [entity(1, item.a), entity(2, item.b)],
      { kind: item.kind, threshold: matcher.SENSITIVITY.loose }
    );
    assert.strictEqual(groups.length, 0, `${item.a} / ${item.b} at loose`);
  }
});

test('The threshold decides how much the scan offers', () => {
  const archive = [
    entity(1, 'Rechnung', { documentCount: 30 }),
    entity(2, 'rechnung', { documentCount: 4 }),
    entity(3, 'Rechnungen', { documentCount: 2 }),
    entity(4, 'Vodafone', { documentCount: 12 }),
    entity(5, 'Vodafon', { documentCount: 1 }),
  ];
  const count = (threshold) =>
    matcher
      .findDuplicateGroups(archive, { kind: 'tags', threshold })
      .reduce((sum, group) => sum + group.members.length, 0);
  assert.strictEqual(count(matcher.SENSITIVITY.strict), 2, 'only Rechnung');
  assert.strictEqual(count(matcher.SENSITIVITY.normal), 5, 'plus plural, typo');
  assert.strictEqual(count(matcher.SENSITIVITY.loose), 5);
});

// ── The string metrics ──────────────────────────────────────────────────────

test('Jaro-Winkler reproduces the published values', () => {
  const round = (value) => Number(value.toFixed(3));
  assert.strictEqual(round(matcher.jaroWinkler('martha', 'marhta')), 0.961);
  assert.strictEqual(round(matcher.jaroWinkler('dixon', 'dicksonx')), 0.813);
  assert.strictEqual(matcher.jaroWinkler('amazon', 'amazon'), 1);
  assert.strictEqual(matcher.jaroWinkler('amazon', ''), 0);
  assert.strictEqual(matcher.jaroWinkler('abc', 'xyz'), 0);
  assert.strictEqual(
    matcher.jaroWinkler('vodafone', 'vodafon'),
    matcher.jaroWinkler('vodafon', 'vodafone')
  );
});

test('Damerau-Levenshtein counts a swap as one edit', () => {
  assert.strictEqual(matcher.damerauLevenshtein('ca', 'ac'), 1);
  assert.strictEqual(matcher.damerauLevenshtein('vodafone', 'vodafon'), 1);
  assert.strictEqual(matcher.damerauLevenshtein('steuer', 'stauer'), 1);
  assert.strictEqual(matcher.damerauLevenshtein('amazon', 'amazon'), 0);
  assert.strictEqual(matcher.damerauLevenshtein('', 'bank'), 4);
  assert.strictEqual(matcher.damerauLevenshtein('kitten', 'sitting'), 3);
  assert.ok(
    matcher.damerauLevenshtein('kitten', 'sitting', 1) > 1,
    'the cutoff reports "further than that"'
  );
});

test('Dice compares bigrams', () => {
  assert.strictEqual(matcher.diceCoefficient('night', 'nacht'), 0.25);
  assert.strictEqual(matcher.diceCoefficient('amazon', 'amazon'), 1);
  assert.strictEqual(matcher.diceCoefficient('abc', 'xyz'), 0);
  assert.strictEqual(matcher.diceCoefficient('a', 'a'), 0, 'no bigrams at all');
});

// ── Clustering ──────────────────────────────────────────────────────────────

test('Chaining is refused: Invoice, Invoices, Invoicing', () => {
  const groups = matcher.findDuplicateGroups(
    [
      entity(1, 'Invoice', { documentCount: 40 }),
      entity(2, 'Invoices', { documentCount: 12 }),
      entity(3, 'Invoicing', { documentCount: 3 }),
    ],
    { kind: 'tags' }
  );
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(
    groups[0].members.map((m) => m.name),
    ['Invoice', 'Invoices'],
    'Invoicing is nobody’s duplicate'
  );
});

test('A member that only reaches the group through another one is dropped', () => {
  // Vodafon matches Vodafone, Vodafone matches Vodaphone, Vodafon and
  // Vodaphone do not match each other. The target is Vodafon, so Vodaphone
  // cannot ride along.
  assert.ok(matcher.scorePair('Vodafon', 'Vodafone', 'correspondents'));
  assert.ok(matcher.scorePair('Vodafone', 'Vodaphone', 'correspondents'));
  assert.strictEqual(
    matcher.scorePair('Vodafon', 'Vodaphone', 'correspondents'),
    null
  );
  const groups = matcher.findDuplicateGroups(
    [
      entity(1, 'Vodafon', { documentCount: 90 }),
      entity(2, 'Vodafone', { documentCount: 20 }),
      entity(3, 'Vodaphone', { documentCount: 5 }),
    ],
    { kind: 'correspondents' }
  );
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].id, 'correspondents:1-2');
  assert.deepStrictEqual(
    groups[0].members.map((m) => m.id),
    [1, 2]
  );
});

test('A component splits into two groups when the target does not reach everyone', () => {
  const groups = matcher.findDuplicateGroups(
    [
      entity(1, 'Vodafon', { documentCount: 90 }),
      entity(2, 'Vodafone', { documentCount: 20 }),
      entity(3, 'Vodaphone', { documentCount: 19 }),
      entity(4, 'Vodaphone ', { documentCount: 18 }),
    ],
    { kind: 'correspondents' }
  );
  assert.strictEqual(groups.length, 2);
  assert.deepStrictEqual(
    groups.map((group) => group.id),
    ['correspondents:3-4', 'correspondents:1-2'],
    'the exact pair is more confident and comes first'
  );
});

test('suggestTarget prefers an inbox tag, documents, a rule, then the lowest id', () => {
  assert.strictEqual(
    matcher.suggestTarget([
      entity(1, 'a', { documentCount: 99 }),
      entity(2, 'b', { documentCount: 1, isInboxTag: true }),
    ]),
    2
  );
  assert.strictEqual(
    matcher.suggestTarget([
      entity(1, 'a', { documentCount: 3 }),
      entity(2, 'b', { documentCount: 30 }),
    ]),
    2
  );
  assert.strictEqual(
    matcher.suggestTarget([
      entity(1, 'a', { documentCount: 5 }),
      entity(2, 'b', { documentCount: 5, matchingAlgorithm: 1, match: 'b' }),
    ]),
    2
  );
  assert.strictEqual(
    matcher.suggestTarget([
      entity(7, 'a', { documentCount: 5 }),
      entity(3, 'b', { documentCount: 5 }),
    ]),
    3
  );
  assert.strictEqual(
    matcher.suggestTarget([
      entity(1, 'a', { matchingAlgorithm: 1, match: '   ' }),
      entity(2, 'b', { matchingAlgorithm: 0, match: 'b' }),
    ]),
    1,
    'an empty rule does not count, so the lowest id wins'
  );
});

test('Groups are sorted by confidence and then by documents', () => {
  const groups = matcher.findDuplicateGroups(
    [
      entity(1, 'Amazon', { documentCount: 2 }),
      entity(2, 'amazon', { documentCount: 1 }),
      entity(3, 'Rechnung', { documentCount: 100 }),
      entity(4, 'Rechnungen', { documentCount: 90 }),
      entity(5, 'Otto', { documentCount: 500 }),
      entity(6, 'otto', { documentCount: 400 }),
    ],
    { kind: 'tags' }
  );
  assert.deepStrictEqual(
    groups.map((group) => group.id),
    ['tags:5-6', 'tags:1-2', 'tags:3-4']
  );
  assert.deepStrictEqual(
    groups.map((group) => group.confidence),
    [1, 1, 0.92]
  );
});

test('A group of more than eight members is flagged', () => {
  const members = [];
  for (let i = 1; i <= 9; i += 1) {
    members.push(entity(i, i % 2 === 0 ? 'Amazon' : 'amazon'));
  }
  const [group] = matcher.findDuplicateGroups(members, { kind: 'tags' });
  assert.strictEqual(group.members.length, 9);
  assert.ok(group.warnings.includes(matcher.GROUP_WARNINGS.LARGE_GROUP));
});

test('Dismissing one pair keeps the rest of the group together', () => {
  const archive = [
    entity(1, 'Amazon', { documentCount: 30 }),
    entity(2, 'amazon', { documentCount: 20 }),
    entity(3, 'AMAZON', { documentCount: 10 }),
  ];
  const groups = matcher.findDuplicateGroups(archive, {
    kind: 'tags',
    dismissedPairs: [matcher.pairKey('tags', 1, 3)],
  });
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(
    groups[0].members.map((m) => m.id),
    [1, 2]
  );
});

test('Reasons are listed once, strongest first', () => {
  const [group] = matcher.findDuplicateGroups(
    [
      entity(1, 'Rechnung', { documentCount: 50 }),
      entity(2, 'rechnung', { documentCount: 9 }),
      entity(3, 'Rechnungen', { documentCount: 8 }),
      entity(4, 'RECHNUNGEN', { documentCount: 7 }),
    ],
    { kind: 'tags' }
  );
  assert.deepStrictEqual(group.reasons, [REASONS.EXACT, REASONS.PLURAL]);
  assert.strictEqual(group.confidence, 0.92);
  assert.strictEqual(group.id, 'tags:1-2-3-4');
});

// ── Blocking and speed ──────────────────────────────────────────────────────

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const STEMS = [
  'Amazon',
  'Telekom',
  'Vodafone',
  'Deutsche Bank',
  'Stadtwerke München',
  'Finanzamt',
  'Allianz',
  'Müller',
  'Schäfer',
  'Mayer',
  'Techniker Krankenkasse',
  'Otto',
  'Zalando',
  'Lufthansa',
  'Deutsche Bahn',
  'Sparkasse Köln',
  'Versicherung Nord',
  'Rechtsanwalt Weber',
  'Autohaus Grün',
  'Energie Süd',
  'Hausverwaltung',
  'Krankenhaus Bethanien',
  'Uni Bremen',
  'Apotheke am Markt',
  'Bäckerei Schmitt',
  'Elektro Fischer',
  'Immobilien Koch',
  'Reisebüro Meier',
  'Stadt Hamburg',
  'Landkreis Harburg',
  'Netflix',
  'Spotify',
  'Google Ireland',
  'Microsoft Deutschland',
  'Apple Distribution',
  'Ikea',
  'Obi Baumarkt',
  'Rewe Markt',
  'Edeka Zentrale',
  'Congstar',
];
const LEGAL_FORMS = [
  'GmbH',
  'AG',
  'GmbH & Co. KG',
  'e.V.',
  'SE',
  'S.a.r.l.',
  'Ltd.',
  '',
];
const PLACES = [
  '',
  '',
  'Deutschland',
  'Nord',
  'Süd',
  'Berlin',
  'Hamburg',
  'EU',
];

function withTypo(value, random) {
  const index = Math.floor(random() * (value.length - 2)) + 1;
  const mode = Math.floor(random() * 3);
  if (mode === 0) return value.slice(0, index) + value.slice(index + 1);
  if (mode === 1) {
    return (
      value.slice(0, index) +
      value[index + 1] +
      value[index] +
      value.slice(index + 2)
    );
  }
  return value.slice(0, index) + value[index] + value.slice(index);
}

/** An archive that drifted: suffixes, legal forms, umlaut spellings, typos. */
function generateArchive(count, seed) {
  const random = randomSource(seed);
  const entities = [];
  for (let i = 0; i < count; i += 1) {
    let name = STEMS[Math.floor(random() * STEMS.length)];
    const place = PLACES[Math.floor(random() * PLACES.length)];
    if (place) name += ` ${place}`;
    const legal = LEGAL_FORMS[Math.floor(random() * LEGAL_FORMS.length)];
    if (legal) name += ` ${legal}`;
    const roll = random();
    if (roll < 0.15) name = withTypo(name, random);
    else if (roll < 0.3) {
      name = name.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
    } else if (roll < 0.4) name = name.toLowerCase();
    entities.push(
      entity(i + 1, name, { documentCount: Math.floor(random() * 80) })
    );
  }
  return entities;
}

test('Blocking finds exactly what scoring every pair finds', () => {
  const entities = generateArchive(300, 20260918);
  for (const kind of matcher.KIND_LIST) {
    for (const threshold of Object.values(matcher.SENSITIVITY)) {
      const blocked = matcher.findDuplicateGroups(entities, {
        kind,
        threshold,
      });
      const pairwise = matcher.findDuplicateGroups(entities, {
        kind,
        threshold,
        candidateStrategy: 'pairwise',
      });
      assert.ok(blocked.length > 0, `${kind} @ ${threshold}: nothing found`);
      assert.deepStrictEqual(
        blocked,
        pairwise,
        `${kind} @ ${threshold}: blocking differs from the reference`
      );
    }
  }
});

test('Five thousand correspondents are grouped in under two seconds', () => {
  const entities = generateArchive(5000, 4711);
  const started = process.hrtime.bigint();
  const groups = matcher.findDuplicateGroups(entities, {
    kind: 'correspondents',
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(
    `    5000 correspondents -> ${groups.length} groups in ${elapsed.toFixed(0)} ms`
  );
  assert.ok(groups.length > 0, 'expected groups in a drifted archive');
  assert.ok(elapsed < 2000, `took ${elapsed.toFixed(0)} ms, budget is 2000 ms`);
});

test('Five thousand tags stay in the same order of magnitude', () => {
  // Tags keep their legal forms, so "gmbh" alone puts a quarter of this
  // archive into one bucket - the worst case the blocking has to survive.
  // The budget is wider than the one above because this is the harder shape,
  // not the one the scan is measured on.
  const entities = generateArchive(5000, 1337);
  const started = process.hrtime.bigint();
  const groups = matcher.findDuplicateGroups(entities, { kind: 'tags' });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(
    `    5000 tags -> ${groups.length} groups in ${elapsed.toFixed(0)} ms`
  );
  assert.ok(elapsed < 3000, `took ${elapsed.toFixed(0)} ms, budget is 3000 ms`);
});

// ---------------------------------------------------------------------------
// The candidate band and the exposed group builder. Both exist for the AI
// review: it needs the pairs the scan did not offer, and it needs to turn the
// ones a model confirmed into the same groups the scan would have built.

/** Every pair in [floor, threshold), scored one by one. The reference. */
function bruteForceCandidates(entities, kind, floor, threshold) {
  const pairs = [];
  for (let i = 0; i < entities.length; i += 1) {
    for (let j = i + 1; j < entities.length; j += 1) {
      const result = matcher.scorePair(
        entities[i].name,
        entities[j].name,
        kind
      );
      if (!result || result.score < floor || result.score >= threshold) {
        continue;
      }
      const [a, b] =
        entities[i].id < entities[j].id
          ? [entities[i], entities[j]]
          : [entities[j], entities[i]];
      pairs.push({
        key: matcher.pairKey(kind, a.id, b.id),
        a,
        b,
        score: result.score,
        reason: result.reason,
      });
    }
  }
  pairs.sort(
    (x, y) => y.score - x.score || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)
  );
  return pairs;
}

test('findCandidatePairs finds exactly what scoring every pair finds', () => {
  const entities = generateArchive(300, 20260918);
  let total = 0;
  for (const kind of matcher.KIND_LIST) {
    for (const threshold of Object.values(matcher.SENSITIVITY)) {
      const expected = bruteForceCandidates(entities, kind, 0.6, threshold);
      const actual = matcher.findCandidatePairs(entities, {
        kind,
        floor: 0.6,
        threshold,
        limit: 100000,
      });
      assert.deepStrictEqual(
        actual,
        expected,
        `${kind} @ ${threshold}: the blocked band differs from the reference`
      );
      total += actual.length;
    }
  }
  assert.ok(total > 0, 'the generated archive has to fill the band somewhere');
});

test('The band stops where the scan starts and where the floor ends', () => {
  const entities = generateArchive(300, 20260918);
  const pairs = matcher.findCandidatePairs(entities, {
    kind: 'correspondents',
    floor: 0.6,
    threshold: 0.95,
    limit: 100000,
  });
  assert.ok(pairs.length > 0, 'expected candidates below the strict preset');
  for (const pair of pairs) {
    assert.ok(
      pair.score >= 0.6 && pair.score < 0.95,
      `${pair.key} scores ${pair.score}, which is outside the band`
    );
    assert.strictEqual(
      pair.key,
      matcher.pairKey('correspondents', pair.a.id, pair.b.id)
    );
    assert.ok(pair.a.id < pair.b.id, 'a is the lower id');
  }
  const offered = matcher.findDuplicateGroups(entities, {
    kind: 'correspondents',
    threshold: 0.95,
  });
  const inGroups = new Set();
  for (const group of offered) {
    for (const member of group.members) {
      for (const other of group.members) {
        if (member.id !== other.id) {
          inGroups.add(matcher.pairKey('correspondents', member.id, other.id));
        }
      }
    }
  }
  assert.ok(
    pairs.every((pair) => !inGroups.has(pair.key)),
    'a pair the scan already offers is not a candidate'
  );
});

test('Candidates are sorted by score, then by key, and cut to the limit', () => {
  const entities = generateArchive(300, 20260918);
  const all = matcher.findCandidatePairs(entities, {
    kind: 'tags',
    floor: 0.6,
    threshold: 0.95,
    limit: 100000,
  });
  assert.ok(all.length > 5, 'need a few candidates to sort');
  for (let index = 1; index < all.length; index += 1) {
    const previous = all[index - 1];
    const current = all[index];
    assert.ok(
      previous.score > current.score ||
        (previous.score === current.score && previous.key < current.key),
      `${previous.key} and ${current.key} are out of order`
    );
  }
  const cut = matcher.findCandidatePairs(entities, {
    kind: 'tags',
    floor: 0.6,
    threshold: 0.95,
    limit: 5,
  });
  assert.strictEqual(cut.length, 5, 'the limit cuts the list');
  assert.deepStrictEqual(cut, all.slice(0, 5), 'and keeps the strongest');
  assert.strictEqual(
    matcher.findCandidatePairs(entities, {
      kind: 'tags',
      floor: 0.6,
      threshold: 0.95,
      limit: 0,
    }).length,
    0
  );
});

test('A dismissed candidate never comes back and an unknown kind is refused', () => {
  const entities = [
    entity(1, 'Vodafone Kundenservice'),
    entity(2, 'Kundenservice Vodafone Nord'),
    entity(3, 'Techniker Krankenkasse'),
    entity(4, 'Krankenkasse Techniker Nord'),
  ];
  const options = {
    kind: 'correspondents',
    floor: 0.6,
    threshold: 0.95,
  };
  const all = matcher.findCandidatePairs(entities, options);
  assert.deepStrictEqual(
    all.map((pair) => pair.key).sort(),
    ['correspondents:1-2', 'correspondents:3-4'],
    'both reordered names are candidates below the strict preset'
  );
  const hidden = matcher.findCandidatePairs(entities, {
    ...options,
    dismissedPairs: ['correspondents:1-2'],
  });
  assert.deepStrictEqual(
    hidden.map((pair) => pair.key),
    ['correspondents:3-4']
  );
  assert.throws(
    () => matcher.findCandidatePairs(entities, { kind: 'document_types' }),
    /Unknown entity kind/
  );
});

test('The default floor and limit are the ones the AI review counts on', () => {
  assert.strictEqual(matcher.DEFAULT_CANDIDATE_FLOOR, 0.6);
  assert.strictEqual(matcher.DEFAULT_CANDIDATE_LIMIT, 400);
  const many = [];
  for (let id = 1; id <= 60; id += 1) {
    many.push(entity(id, `Rechnung ${id} Strom`));
    many.push(entity(id + 1000, `Strom Rechnung ${id} Nord`));
  }
  const capped = matcher.findCandidatePairs(many, {
    kind: 'tags',
    threshold: 0.95,
  });
  assert.ok(capped.length <= 400, 'the default limit holds');
});

test('buildGroupsFromEdges builds what findDuplicateGroups builds', () => {
  const entities = generateArchive(300, 20260918);
  const configuredTagNames = ['ai-processed', 'Rechnung'];
  for (const kind of matcher.KIND_LIST) {
    for (const threshold of Object.values(matcher.SENSITIVITY)) {
      const edges = [];
      for (let i = 0; i < entities.length; i += 1) {
        for (let j = i + 1; j < entities.length; j += 1) {
          const result = matcher.scorePair(
            entities[i].name,
            entities[j].name,
            kind
          );
          if (!result || result.score < threshold) continue;
          edges.push({
            key: matcher.pairKey(kind, entities[i].id, entities[j].id),
            score: result.score,
            reason: result.reason,
          });
        }
      }
      const built = matcher.buildGroupsFromEdges(kind, entities, edges, {
        configuredTagNames,
      });
      const scanned = matcher.findDuplicateGroups(entities, {
        kind,
        threshold,
        configuredTagNames,
      });
      assert.deepStrictEqual(
        built,
        scanned,
        `${kind} @ ${threshold}: the exposed builder differs from the scan`
      );
    }
  }
});

test('buildGroupsFromEdges ignores edges it has no entities for', () => {
  const entities = [
    entity(1, 'Vodafone Kundenservice', { documentCount: 9 }),
    entity(2, 'Kundenservice Vodafone Nord', { documentCount: 2 }),
  ];
  const groups = matcher.buildGroupsFromEdges(
    'correspondents',
    entities,
    [
      { key: 'correspondents:1-2', score: 0.8, reason: 'fuzzy' },
      { key: 'correspondents:1-77', score: 0.9, reason: 'fuzzy' },
      { key: 'nonsense', score: 0.9, reason: 'fuzzy' },
    ],
    {}
  );
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].id, 'correspondents:1-2');
  assert.strictEqual(groups[0].suggestedTargetId, 1, 'more documents wins');
  assert.strictEqual(groups[0].confidence, 0.8, 'the given score is the one');
  assert.deepStrictEqual(groups[0].reasons, ['fuzzy']);
  assert.throws(
    () => matcher.buildGroupsFromEdges('document_types', entities, []),
    /Unknown entity kind/
  );
});

test('bestMatch() finds the existing entity a new name is a hard match of', () => {
  const entities = [
    entity(1, 'Rechnung', { documentCount: 12 }),
    entity(2, 'Versicherung', { documentCount: 4 }),
    entity(3, 'Müller GmbH', { documentCount: 2 }),
    entity(4, 'Kontoauszug', { documentCount: 9 }),
  ];
  const plural = matcher.bestMatch('Rechnungen', entities, { kind: 'tags' });
  assert.strictEqual(plural.entity.id, 1);
  assert.strictEqual(plural.reason, 'plural');
  assert.ok(plural.score >= 0.9);

  const umlaut = matcher.bestMatch('mueller gmbh', entities, {
    kind: 'correspondents',
  });
  assert.strictEqual(umlaut.entity.id, 3);
  assert.ok(matcher.HARD_REASONS.includes(umlaut.reason), umlaut.reason);

  const typo = matcher.bestMatch('Kontoumzug', entities, { kind: 'tags' });
  assert.strictEqual(typo.entity.id, 4, 'the closest name is still reported');
  assert.strictEqual(
    matcher.HARD_REASONS.includes(typo.reason),
    false,
    'but a typo-like link is not a hard reason'
  );

  assert.strictEqual(
    matcher.bestMatch('Kontoumzug', entities, { kind: 'tags', minScore: 0.95 }),
    null,
    'minScore filters'
  );
  assert.strictEqual(
    matcher.bestMatch('Steuer', entities, { kind: 'tags' }),
    null
  );
  assert.strictEqual(matcher.bestMatch('', entities, { kind: 'tags' }), null);
  assert.strictEqual(matcher.bestMatch('x', [], { kind: 'tags' }), null);
  assert.throws(
    () => matcher.bestMatch('x', entities, { kind: 'document_types' }),
    /Unknown entity kind/
  );
});

test('bestMatch() prefers the entity with more documents among equal scores', () => {
  const entities = [
    entity(7, 'amazon', { documentCount: 2 }),
    entity(8, 'AMAZON', { documentCount: 30 }),
  ];
  const best = matcher.bestMatch('Amazon', entities, { kind: 'tags' });
  assert.strictEqual(best.entity.id, 8);
  assert.strictEqual(best.reason, 'exact-normalized');
});

test('The hard reasons are the five tiers above prefix, and semantic is a known reason', () => {
  assert.deepStrictEqual(
    [...matcher.HARD_REASONS],
    [
      'exact-normalized',
      'umlaut-variant',
      'legal-form',
      'plural',
      'token-order',
    ]
  );
  assert.strictEqual(matcher.MATCH_REASONS.SEMANTIC, 'semantic');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
