'use strict';

/**
 * Entity name matcher: finds tags or correspondents whose names mean the same
 * thing, so the Duplicates page can offer them for a merge.
 *
 * Pure module: no I/O, no Paperless-ngx calls, no dependencies. Everything the
 * merge service, the routes and the page have to agree on lives here: the
 * kinds, the match reasons, the group warnings, the sensitivity presets and
 * the shape of a group. The merge service loads the entities, hands them in
 * and passes the groups on unchanged.
 *
 * Nothing here guesses with an AI model. Every score comes from a rule that
 * can be named on the page ("why does it think these are the same?").
 *
 * ## Normalisation (normalizeName)
 *
 * | field       | how it is built                                                                   |
 * | ----------- | --------------------------------------------------------------------------------- |
 * | `key`       | NFKC, trimmed, lowercased, runs of whitespace collapsed to one space               |
 * | `asciiKey`  | `key` with ae/oe/ue/ss for ä/ö/ü/ß, then every remaining diacritic dropped (NFD)   |
 * | `tokens`    | words of `asciiKey`, split on whitespace and `& _ / - . , ' " ( ) + : ;`           |
 * | `foldedKey` | `tokens` after kind folding, joined by one space                                   |
 *
 * Kind folding: correspondents lose legal-form and article tokens (gmbh, ag,
 * kg, ..., the, die, der, das) as long as one token survives; tags fold the
 * plural of their last token (ies→y, es→, s→, en→, n→, e→) as long as the stem
 * keeps four characters. So "Müller", "Mueller" and "Muller" become "mueller",
 * "mueller" and "muller", and "Rechnungen" folds onto "Rechnung".
 *
 * ## Scoring tiers (scorePair, strongest first)
 *
 * | # | condition                                                            | score       | reason           |
 * | - | -------------------------------------------------------------------- | ----------- | ---------------- |
 * | 1 | `key` equal                                                          | 1.00        | exact-normalized |
 * | 2 | `asciiKey` equal                                                     | 0.98        | umlaut-variant   |
 * | 3 | `foldedKey` equal, correspondents, a legal form or article was dropped| 0.95        | legal-form       |
 * | 4 | `foldedKey` equal, tags, a plural was folded                         | 0.92        | plural           |
 * | 5 | same token multiset                                                  | 0.90        | token-order      |
 * | 6 | one token list is a whole-token prefix or suffix of the other,        | 0.85        | prefix           |
 * |   | and the shorter one has ≥ 6 characters or ≥ 2 tokens                 |             |                  |
 * | 7 | fuzzy on `asciiKey`, best of the four measures below                 | 0.75 – 0.94 | fuzzy            |
 *
 * Tier 7 measures (all symmetric, all capped at 0.94 so a fuzzy pair never
 * survives the strict preset of 0.95):
 *
 * - Jaro-Winkler ≥ 0.92, names of comparable length (ratio ≥ 0.75) → the
 *   Jaro-Winkler value.
 * - Damerau-Levenshtein ≤ 1 for `asciiKey` length ≥ 5, ≤ 2 for length ≥ 10 →
 *   max(0.90, 1 − distance / length).
 * - Character-bigram Dice ≥ 0.85, both names multi-token → Dice × 0.95.
 * - Token-wise Jaro-Winkler for multi-token names with the same number of
 *   folded tokens: every token pairs with a token of the other name at
 *   ≥ 0.90 → mean of the pairs × 0.95. This is the tier that finds
 *   "Telekom Deutschland GmbH" next to "Deutsche Telekom"; the three measures
 *   above all look at the whole string and miss a reordered spelling variant.
 *
 * ## Guards (why the matcher stays quiet)
 *
 * - An `asciiKey` shorter than 4 characters only ever matches through tiers
 *   1 and 2. Otherwise "AG", "IT" or "KFZ" would pair with half the archive.
 * - Tiers 6 and 7 only look at pairs that share the first three characters of
 *   `asciiKey` or share a folded token of at least 4 characters. This is the
 *   same rule the blocking in findDuplicateGroups uses, which is what makes
 *   blocking a pure speed-up: it can never drop a pair that would have scored.
 * - When both names have the same number of folded tokens (≥ 2), tier 7 first
 *   pairs those tokens; if one pair stays below 0.90 the whole tier is
 *   refused. Without it Jaro-Winkler would happily call "Deutsche Bank" and
 *   "Deutsche Bahn" the same name (0.97 on the whole string).
 * - Jaro-Winkler needs a length ratio of 0.75, so a word that merely starts
 *   like a much longer one stays out: "Rechnung" and "Rechnungswesen" are two
 *   different tags, and so are "Rechnungen" and "Rechnungswesen".
 * - Tier 7 is refused when one `asciiKey` is a string prefix of a much longer
 *   one (length ratio < 0.5). A belt-and-braces rule: with the thresholds
 *   above none of the four measures can reach that far anyway.
 * - Tags never match correspondents. The kind is an argument of every call and
 *   there is no cross-kind entry point.
 *
 * ## Known trade-offs
 *
 * - A typo inside the first three characters is not found: "Steuer" and
 *   "Stauer" share no prefix and no token, so they never pair — at any
 *   sensitivity. Deliberate: Damerau-Levenshtein alone would call every
 *   six-letter word with one changed character a duplicate.
 * - Plural folding is blind to meaning. When an archive really contains both
 *   "Kosten" and "Kost" as tags, they are offered as a pair (score 0.92) and
 *   the user has to dismiss them. Folding only fires when the stem keeps four
 *   characters, which keeps the worst of it out.
 * - The legal-form list is a list, not a grammar. "Deutsche Bank AG" and
 *   "Deutsche Bank" are the same correspondent; "AS Roma" and "Roma" would be
 *   too ("as" is on the list). Rare enough, and visible on the page.
 * - Scores are tuned for German and English names. Other languages fall back
 *   to tiers 1, 2, 5, 6 and the fuzzy measures.
 *
 * Clustering never chains: every member of a group has to score against the
 * group's suggested target directly, otherwise "Invoice" -> "Invoices" ->
 * "Invoicing" would collapse into one group through the middle name.
 */

const KINDS = Object.freeze({
  TAGS: 'tags',
  CORRESPONDENTS: 'correspondents',
});
const KIND_LIST = Object.freeze(Object.values(KINDS));

/** Why two names were considered the same, strongest tier first. */
const MATCH_REASONS = Object.freeze({
  EXACT: 'exact-normalized',
  UMLAUT: 'umlaut-variant',
  LEGAL_FORM: 'legal-form',
  PLURAL: 'plural',
  TOKEN_ORDER: 'token-order',
  PREFIX: 'prefix',
  FUZZY: 'fuzzy',
});

/** Things the page shows on a group before the user merges it. */
const GROUP_WARNINGS = Object.freeze({
  INBOX_TAG: 'inbox-tag',
  CONFIGURED_TAG: 'configured-tag',
  NO_PERMISSION: 'no-permission',
  HAS_MATCHING_RULE: 'has-matching-rule',
  OWNER_DIFFERS: 'owner-differs',
  LARGE_GROUP: 'large-group',
});

/** Sensitivity presets the page offers; the value is the score threshold. */
const SENSITIVITY = Object.freeze({
  strict: 0.95,
  normal: 0.85,
  loose: 0.75,
});
const DEFAULT_THRESHOLD = SENSITIVITY.normal;

/** Groups larger than this are flagged: they usually mean over-matching. */
const LARGE_GROUP_SIZE = 8;

/** Paperless-ngx `matching_algorithm` value meaning "no automatic matching". */
const MATCHING_ALGORITHM_NONE = 0;

/** Lowest score findCandidatePairs reports when nothing else is asked for. */
const DEFAULT_CANDIDATE_FLOOR = 0.6;

/** How many candidate pairs findCandidatePairs hands back at most. */
const DEFAULT_CANDIDATE_LIMIT = 400;

/** Score of every tier; the file header explains what each one means. */
const TIER_SCORES = Object.freeze({
  EXACT: 1,
  UMLAUT: 0.98,
  LEGAL_FORM: 0.95,
  PLURAL: 0.92,
  TOKEN_ORDER: 0.9,
  PREFIX: 0.85,
});

/** Everything tier 7 needs; see the header table. */
const FUZZY = Object.freeze({
  JARO_WINKLER_MIN: 0.92,
  DISTANCE_LENGTH_1: 5,
  DISTANCE_LENGTH_2: 10,
  DISTANCE_FLOOR: 0.9,
  DICE_MIN: 0.85,
  DICE_FACTOR: 0.95,
  TOKEN_MIN: 0.9,
  TOKEN_FACTOR: 0.95,
  MIN: 0.75,
  MAX: 0.94,
  /**
   * Jaro-Winkler is only trusted between names of comparable length. Below
   * 0.6 it cannot reach JARO_WINKLER_MIN at all; the value is higher because
   * a long common prefix would otherwise pair two different words
   * ("Rechnungen" / "Rechnungswesen" scores 0.94 on Jaro-Winkler alone). A
   * short name inside a longer one is the prefix tier's job.
   */
  LENGTH_RATIO_MIN: 0.75,
  /** Below this length ratio Dice cannot reach DICE_MIN. */
  DICE_LENGTH_RATIO_MIN: 0.7,
  /** A short name inside a much longer one is never a fuzzy match. */
  PREFIX_RATIO_MIN: 0.5,
});

/** Shorter names only match through tiers 1 and 2. */
const MIN_FUZZY_KEY_LENGTH = 4;
/** Tier 6 needs this many characters when the shorter name is one token. */
const MIN_PREFIX_LENGTH = 6;
/** A folded plural has to keep this many characters. */
const MIN_PLURAL_STEM_LENGTH = 4;
/** Blocking and the tier 6/7 guard compare this many leading characters. */
const BLOCK_PREFIX_LENGTH = 3;
/** A token has to be this long to make two names candidates for tiers 6/7. */
const MIN_BLOCK_TOKEN_LENGTH = 4;

/** Legal forms and articles dropped from correspondent names. */
const LEGAL_FORM_TOKENS = new Set([
  'gmbh',
  'ag',
  'kg',
  'ug',
  'ohg',
  'gbr',
  'ev',
  'e',
  'v',
  'mbh',
  'co',
  'cokg',
  'inc',
  'llc',
  'ltd',
  'plc',
  'corp',
  'sa',
  'sarl',
  'srl',
  'bv',
  'nv',
  'oy',
  'ab',
  'as',
  'spa',
  'se',
  'the',
  'die',
  'der',
  'das',
  'haftungsbeschraenkt',
]);

/** Plural endings of the last tag token, tried in this order. */
const PLURAL_RULES = Object.freeze([
  ['ies', 'y'],
  ['es', ''],
  ['s', ''],
  ['en', ''],
  ['n', ''],
  ['e', ''],
]);

/** Everything that separates two words of a name. */
const TOKEN_SEPARATOR = /[\s&_/\-.,'"()+:;]+/;

/**
 * @typedef {object} EntityRecord
 * @property {number} id
 * @property {string} name
 * @property {number} documentCount
 * @property {number} matchingAlgorithm  Paperless-ngx matching_algorithm; 0 = none
 * @property {string} match              Paperless-ngx match expression ('' when none)
 * @property {boolean} isInsensitive
 * @property {number|null} owner         Paperless-ngx owner user id, null = unowned
 * @property {boolean} userCanChange     false when the API token may not modify it
 * @property {boolean} [isInboxTag]      tags only
 * @property {string|null} [color]       tags only
 * @property {string|null} [lastCorrespondence]  correspondents only
 */

/**
 * @typedef {EntityRecord & {
 *   scoreToTarget: number,
 *   reason: (string|null)
 * }} DuplicateGroupMember
 * scoreToTarget is 1 and reason null for the suggested target itself.
 */

/**
 * @typedef {object} DuplicateGroup
 * @property {string} id                  `${kind}:${member ids ascending, joined by '-'}`
 * @property {'tags'|'correspondents'} kind
 * @property {number} confidence          lowest scoreToTarget among the members
 * @property {string[]} reasons           distinct MATCH_REASONS values, strongest first
 * @property {number} suggestedTargetId
 * @property {DuplicateGroupMember[]} members  target first, then documentCount desc, then id
 * @property {string[]} warnings          GROUP_WARNINGS values
 */

/**
 * @typedef {object} MatchOptions
 * @property {'tags'|'correspondents'} kind
 * @property {number} [threshold]                  score a pair needs; default DEFAULT_THRESHOLD
 * @property {Iterable<string>} [dismissedPairs]   pairKey() values the user marked as "not a duplicate"
 * @property {Iterable<string>} [configuredTagNames]  tag names the Zettelrobbe settings refer to
 * @property {'blocking'|'pairwise'} [candidateStrategy]  how candidate pairs are found;
 *   'blocking' (default) buckets the names first, 'pairwise' scores every pair. Both
 *   return the same groups; 'pairwise' is the reference the tests compare against.
 */

/**
 * @typedef {object} CandidateOptions
 * @property {'tags'|'correspondents'} kind
 * @property {number} [floor]       lowest score a pair needs; default DEFAULT_CANDIDATE_FLOOR
 * @property {number} [threshold]   score the scan already offers; default DEFAULT_THRESHOLD
 * @property {Iterable<string>} [dismissedPairs]
 * @property {number} [limit]       default DEFAULT_CANDIDATE_LIMIT
 * @property {'blocking'|'pairwise'} [candidateStrategy]
 */

/**
 * @typedef {object} CandidatePair
 * @property {string} key      pairKey() of the two ids
 * @property {EntityRecord} a  the entity with the lower id
 * @property {EntityRecord} b  the other one
 * @property {number} score    floor <= score < threshold
 * @property {string} reason   MATCH_REASONS value that produced the score
 */

/**
 * @typedef {object} NormalizedName
 * @property {string} key        lowercased, trimmed, whitespace collapsed
 * @property {string} asciiKey   key with umlauts transliterated and diacritics removed
 * @property {string[]} tokens   words of asciiKey, punctuation stripped
 * @property {string} foldedKey  key after kind-specific folding (legal forms, plural)
 */

/**
 * Stable key for a pair of ids inside one kind, independent of order.
 *
 * @param {'tags'|'correspondents'} kind
 * @param {number} idA
 * @param {number} idB
 * @returns {string}
 */
function pairKey(kind, idA, idB) {
  const a = Number(idA);
  const b = Number(idB);
  return a < b ? `${kind}:${a}-${b}` : `${kind}:${b}-${a}`;
}

/** ä/ö/ü/ß first, then whatever diacritics are left. */
function toAsciiKey(key) {
  return key
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC');
}

/** Folds the plural of one tag token; returns the token when nothing fits. */
function foldPlural(token) {
  for (const [suffix, replacement] of PLURAL_RULES) {
    if (token.length <= suffix.length || !token.endsWith(suffix)) continue;
    const stem = token.slice(0, token.length - suffix.length) + replacement;
    if (stem.length >= MIN_PLURAL_STEM_LENGTH) return stem;
  }
  return token;
}

/**
 * Builds everything the scorer needs from one name. Superset of
 * NormalizedName; the extra fields stay inside this module.
 */
function prepareName(name, kind) {
  const key = String(name ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const asciiKey = toAsciiKey(key);
  const tokens = asciiKey.split(TOKEN_SEPARATOR).filter(Boolean);

  let foldedTokens = tokens;
  let droppedLegalForm = false;
  let foldedPlural = false;
  if (kind === KINDS.CORRESPONDENTS && tokens.length > 0) {
    const kept = tokens.filter((token) => !LEGAL_FORM_TOKENS.has(token));
    if (kept.length > 0 && kept.length < tokens.length) {
      foldedTokens = kept;
      droppedLegalForm = true;
    }
  } else if (kind === KINDS.TAGS && tokens.length > 0) {
    const last = tokens[tokens.length - 1];
    const stem = foldPlural(last);
    if (stem !== last) {
      foldedTokens = tokens.slice(0, -1).concat(stem);
      foldedPlural = true;
    }
  }

  const sortedTokens = [...tokens].sort();
  return {
    key,
    asciiKey,
    tokens,
    foldedKey: foldedTokens.join(' '),
    foldedTokens,
    foldedTokenSet: new Set(foldedTokens),
    sortedKey: sortedTokens.join(' '),
    blockPrefix: asciiKey.slice(0, BLOCK_PREFIX_LENGTH),
    droppedLegalForm,
    foldedPlural,
    bigrams: null,
    charCodes: null,
    tokenCodes: null,
  };
}

/**
 * Normalizes a name for comparison.
 *
 * @param {string} name
 * @param {'tags'|'correspondents'} kind
 * @returns {NormalizedName}
 */
function normalizeName(name, kind) {
  const prepared = prepareName(name, kind);
  return {
    key: prepared.key,
    asciiKey: prepared.asciiKey,
    tokens: [...prepared.tokens],
    foldedKey: prepared.foldedKey,
  };
}

// Scratch buffers for the string metrics. The module is synchronous and the
// metrics never call each other, so one set of buffers is enough; scanning a
// few thousand names would otherwise spend most of its time in the allocator.
let scratchMatchedA = new Uint8Array(64);
let scratchMatchedB = new Uint8Array(64);

function scratchFor(which, length) {
  if (which === 0) {
    if (scratchMatchedA.length < length) {
      scratchMatchedA = new Uint8Array(Math.max(length, 64));
    }
    scratchMatchedA.fill(0, 0, length);
    return scratchMatchedA;
  }
  if (scratchMatchedB.length < length) {
    scratchMatchedB = new Uint8Array(Math.max(length, 64));
  }
  scratchMatchedB.fill(0, 0, length);
  return scratchMatchedB;
}

/**
 * Jaro similarity of two strings, 0 (nothing in common) to 1 (equal).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function jaro(a, b) {
  const lengthA = a.length;
  const lengthB = b.length;
  if (lengthA === 0 || lengthB === 0) return 0;
  if (a === b) return 1;

  const window = Math.max(0, Math.floor(Math.max(lengthA, lengthB) / 2) - 1);
  const matchedA = scratchFor(0, lengthA);
  const matchedB = scratchFor(1, lengthB);
  let matches = 0;

  for (let i = 0; i < lengthA; i += 1) {
    const start = i > window ? i - window : 0;
    const end = Math.min(i + window + 1, lengthB);
    const charA = a.charCodeAt(i);
    for (let j = start; j < end; j += 1) {
      if (matchedB[j] || charA !== b.charCodeAt(j)) continue;
      matchedA[i] = 1;
      matchedB[j] = 1;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < lengthA; i += 1) {
    if (!matchedA[i]) continue;
    while (!matchedB[k]) k += 1;
    if (a.charCodeAt(i) !== b.charCodeAt(k)) transpositions += 1;
    k += 1;
  }

  return (
    (matches / lengthA +
      matches / lengthB +
      (matches - transpositions / 2) / matches) /
    3
  );
}

/**
 * Jaro-Winkler similarity: Jaro with a bonus for a common prefix of up to
 * four characters. No boost threshold, so the value is monotone in Jaro.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function jaroWinkler(a, b) {
  const score = jaro(a, b);
  if (score <= 0 || score >= 1) return score;
  const maxPrefix = Math.min(4, a.length, b.length);
  let prefix = 0;
  while (prefix < maxPrefix && a.charCodeAt(prefix) === b.charCodeAt(prefix)) {
    prefix += 1;
  }
  return score + prefix * 0.1 * (1 - score);
}

let scratchRows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)];
let scratchScores = new Float64Array(16);

/**
 * Damerau-Levenshtein distance, restricted variant (optimal string
 * alignment): insert, delete, substitute and swap two neighbours.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} [maxDistance] stop early; the result is then only
 *   guaranteed to be correct while it stays at or below maxDistance.
 * @returns {number}
 */
function damerauLevenshtein(a, b, maxDistance = Infinity) {
  const lengthA = a.length;
  const lengthB = b.length;
  if (lengthA === 0) return lengthB;
  if (lengthB === 0) return lengthA;
  if (Math.abs(lengthA - lengthB) > maxDistance) return maxDistance + 1;

  if (scratchRows[0].length <= lengthB) {
    const size = lengthB + 1;
    scratchRows = [
      new Int32Array(size),
      new Int32Array(size),
      new Int32Array(size),
    ];
  }
  let beforePrevious = scratchRows[0];
  let previous = scratchRows[1];
  let current = scratchRows[2];
  beforePrevious.fill(0, 0, lengthB + 1);
  for (let j = 0; j <= lengthB; j += 1) previous[j] = j;

  for (let i = 1; i <= lengthA; i += 1) {
    current[0] = i;
    let rowMin = i;
    const charA = a.charCodeAt(i - 1);
    const previousCharA = i > 1 ? a.charCodeAt(i - 2) : -1;
    for (let j = 1; j <= lengthB; j += 1) {
      const charB = b.charCodeAt(j - 1);
      const cost = charA === charB ? 0 : 1;
      let value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        charA === b.charCodeAt(j - 2) &&
        previousCharA === charB
      ) {
        value = Math.min(value, beforePrevious[j - 2] + cost);
      }
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    const spare = beforePrevious;
    beforePrevious = previous;
    previous = current;
    current = spare;
  }
  return previous[lengthB];
}

/** Counts the character bigrams of a string. */
function bigramCounts(value) {
  const counts = new Map();
  let total = 0;
  for (let i = 0; i + 1 < value.length; i += 1) {
    const bigram = value.slice(i, i + 2);
    counts.set(bigram, (counts.get(bigram) || 0) + 1);
    total += 1;
  }
  return { counts, total };
}

function diceFromCounts(a, b) {
  if (a.total === 0 || b.total === 0) return 0;
  const [small, large] = a.counts.size <= b.counts.size ? [a, b] : [b, a];
  let shared = 0;
  for (const [bigram, count] of small.counts) {
    const other = large.counts.get(bigram);
    if (other) shared += Math.min(count, other);
  }
  return (2 * shared) / (a.total + b.total);
}

/**
 * Sørensen-Dice coefficient over character bigrams, 0 to 1.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function diceCoefficient(a, b) {
  return diceFromCounts(bigramCounts(a), bigramCounts(b));
}

function bigramsOf(prepared) {
  if (!prepared.bigrams) prepared.bigrams = bigramCounts(prepared.asciiKey);
  return prepared.bigrams;
}

/** Sorted character codes of a string. */
function sortedCharCodes(value) {
  const codes = new Uint16Array(value.length);
  for (let i = 0; i < value.length; i += 1) codes[i] = value.charCodeAt(i);
  codes.sort();
  return codes;
}

/** Sorted character codes of asciiKey, kept on the prepared name. */
function charCodesOf(prepared) {
  if (!prepared.charCodes) {
    prepared.charCodes = sortedCharCodes(prepared.asciiKey);
  }
  return prepared.charCodes;
}

/** Sorted character codes of every folded token, kept on the prepared name. */
function tokenCodesOf(prepared) {
  if (!prepared.tokenCodes) {
    prepared.tokenCodes = prepared.foldedTokens.map(sortedCharCodes);
  }
  return prepared.tokenCodes;
}

/** Size of the character multiset two sorted code lists have in common. */
function commonCharacters(codesA, codesB) {
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < codesA.length && j < codesB.length) {
    if (codesA[i] === codesB[j]) {
      shared += 1;
      i += 1;
      j += 1;
    } else if (codesA[i] < codesB[j]) i += 1;
    else j += 1;
  }
  return shared;
}

/**
 * Upper bound for Jaro-Winkler from the shared characters alone: no pair can
 * match more characters than it has in common. Used to skip the metric.
 */
function jaroWinklerCeiling(shared, lengthA, lengthB) {
  return 0.6 + 0.2 * (shared / lengthA + shared / lengthB);
}

/**
 * Jaro-Winkler of two tokens, skipped when the lengths or the characters the
 * two tokens have in common already rule a match at TOKEN_MIN out. A skipped
 * pair returns 0: it can never be part of a pairing that survives.
 */
function tokenSimilarity(a, b, codesA, codesB) {
  if (a === b) return 1;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  // JW >= TOKEN_MIN needs a length ratio of at least (TOKEN_MIN - 0.8) / 0.2.
  if (shorter / longer < (FUZZY.TOKEN_MIN - 0.8) / 0.2) return 0;
  const shared = commonCharacters(codesA, codesB);
  if (jaroWinklerCeiling(shared, a.length, b.length) < FUZZY.TOKEN_MIN) {
    return 0;
  }
  return jaroWinkler(a, b);
}

/**
 * Pairs the tokens of two equally long token lists greedily by Jaro-Winkler,
 * strongest pair first, and only when every token finds a partner at
 * TOKEN_MIN. The tie-break only looks at the two token strings, so the result
 * does not depend on the argument order.
 *
 * @returns {{min:number, mean:number}|null} null when no pairing reaches
 *   TOKEN_MIN for every token.
 */
function pairTokens(a, b) {
  const tokensA = a.foldedTokens;
  const tokensB = b.foldedTokens;
  const codesA = tokenCodesOf(a);
  const codesB = tokenCodesOf(b);
  const count = tokensA.length;
  if (scratchScores.length < count * count) {
    scratchScores = new Float64Array(count * count);
  }
  const scores = scratchScores;
  for (let i = 0; i < count; i += 1) {
    let best = 0;
    for (let j = 0; j < count; j += 1) {
      const score = tokenSimilarity(
        tokensA[i],
        tokensB[j],
        codesA[i],
        codesB[j]
      );
      scores[i * count + j] = score;
      if (score > best) best = score;
    }
    // No assignment can beat the best partner of this token.
    if (best < FUZZY.TOKEN_MIN) return null;
  }

  const usedA = new Uint8Array(count);
  const usedB = new Uint8Array(count);
  let sum = 0;
  let min = 1;
  for (let step = 0; step < count; step += 1) {
    let bestScore = -1;
    let bestTie = '';
    let bestA = -1;
    let bestB = -1;
    for (let i = 0; i < count; i += 1) {
      if (usedA[i]) continue;
      for (let j = 0; j < count; j += 1) {
        if (usedB[j]) continue;
        const score = scores[i * count + j];
        if (score < bestScore) continue;
        const tie =
          tokensA[i] < tokensB[j]
            ? `${tokensA[i]} ${tokensB[j]}`
            : `${tokensB[j]} ${tokensA[i]}`;
        if (score > bestScore || tie < bestTie) {
          bestScore = score;
          bestTie = tie;
          bestA = i;
          bestB = j;
        }
      }
    }
    if (bestScore < FUZZY.TOKEN_MIN) return null;
    usedA[bestA] = 1;
    usedB[bestB] = 1;
    sum += bestScore;
    if (bestScore < min) min = bestScore;
  }
  return { min, mean: sum / count };
}

/**
 * Tier 6/7 guard and blocking rule in one place: two names are only compared
 * by prefix or fuzzily when they share the first three characters or a folded
 * token of at least four characters.
 */
function shareBlock(a, b) {
  if (a.blockPrefix === b.blockPrefix) return true;
  for (const token of a.foldedTokens) {
    if (token.length >= MIN_BLOCK_TOKEN_LENGTH && b.foldedTokenSet.has(token)) {
      return true;
    }
  }
  return false;
}

/** True when one token list is a whole-token prefix or suffix of the other. */
function isTokenPrefixOrSuffix(shorter, longer) {
  let prefix = true;
  let suffix = true;
  const offset = longer.length - shorter.length;
  for (let i = 0; i < shorter.length; i += 1) {
    if (shorter[i] !== longer[i]) prefix = false;
    if (shorter[i] !== longer[offset + i]) suffix = false;
    if (!prefix && !suffix) return false;
  }
  return true;
}

/** Tier 7. Returns the best of the four fuzzy measures, or null. */
function fuzzyScore(a, b) {
  const lengthA = a.asciiKey.length;
  const lengthB = b.asciiKey.length;
  const maxLength = Math.max(lengthA, lengthB);
  const minLength = Math.min(lengthA, lengthB);
  const ratio = minLength / maxLength;

  if (
    ratio < FUZZY.PREFIX_RATIO_MIN &&
    (a.asciiKey.startsWith(b.asciiKey) || b.asciiKey.startsWith(a.asciiKey))
  ) {
    return null;
  }

  let best = 0;
  const tokenCount = a.foldedTokens.length;
  if (tokenCount >= 2 && tokenCount === b.foldedTokens.length) {
    const paired = pairTokens(a, b);
    if (!paired) return null;
    best = paired.mean * FUZZY.TOKEN_FACTOR;
  }

  let allowedDistance = 0;
  if (maxLength >= FUZZY.DISTANCE_LENGTH_2) allowedDistance = 2;
  else if (maxLength >= FUZZY.DISTANCE_LENGTH_1) allowedDistance = 1;

  const tryWinkler = ratio >= FUZZY.LENGTH_RATIO_MIN;
  const tryDistance =
    allowedDistance > 0 && Math.abs(lengthA - lengthB) <= allowedDistance;
  const tryDice =
    a.tokens.length > 1 &&
    b.tokens.length > 1 &&
    ratio >= FUZZY.DICE_LENGTH_RATIO_MIN;

  if (tryWinkler || tryDistance || tryDice) {
    // The characters the two names share bound all three measures from above,
    // and counting them is much cheaper than running them.
    const shared = commonCharacters(charCodesOf(a), charCodesOf(b));

    if (
      tryWinkler &&
      jaroWinklerCeiling(shared, lengthA, lengthB) >= FUZZY.JARO_WINKLER_MIN
    ) {
      const winkler = jaroWinkler(a.asciiKey, b.asciiKey);
      if (winkler >= FUZZY.JARO_WINKLER_MIN && winkler > best) best = winkler;
    }

    // Every character without a partner costs at least one edit.
    if (tryDistance && maxLength - shared <= allowedDistance) {
      const distance = damerauLevenshtein(
        a.asciiKey,
        b.asciiKey,
        allowedDistance
      );
      if (distance <= allowedDistance) {
        const score = Math.max(FUZZY.DISTANCE_FLOOR, 1 - distance / maxLength);
        if (score > best) best = score;
      }
    }

    // A shared bigram needs a shared character to start with.
    if (tryDice && (2 * shared) / (lengthA + lengthB - 2) >= FUZZY.DICE_MIN) {
      const dice = diceFromCounts(bigramsOf(a), bigramsOf(b));
      if (dice >= FUZZY.DICE_MIN) {
        const score = dice * FUZZY.DICE_FACTOR;
        if (score > best) best = score;
      }
    }
  }

  if (best < FUZZY.MIN) return null;
  return {
    score: Math.min(best, FUZZY.MAX),
    reason: MATCH_REASONS.FUZZY,
  };
}

/** The tier ladder; both arguments come from prepareName. */
function scorePrepared(a, b, kind) {
  if (!a.key || !b.key) return null;
  if (a.key === b.key) {
    return { score: TIER_SCORES.EXACT, reason: MATCH_REASONS.EXACT };
  }
  if (a.asciiKey === b.asciiKey) {
    return { score: TIER_SCORES.UMLAUT, reason: MATCH_REASONS.UMLAUT };
  }
  if (
    a.asciiKey.length < MIN_FUZZY_KEY_LENGTH ||
    b.asciiKey.length < MIN_FUZZY_KEY_LENGTH
  ) {
    return null;
  }
  if (a.foldedKey === b.foldedKey && a.foldedKey !== '') {
    if (
      kind === KINDS.CORRESPONDENTS &&
      (a.droppedLegalForm || b.droppedLegalForm)
    ) {
      return {
        score: TIER_SCORES.LEGAL_FORM,
        reason: MATCH_REASONS.LEGAL_FORM,
      };
    }
    if (kind === KINDS.TAGS && (a.foldedPlural || b.foldedPlural)) {
      return { score: TIER_SCORES.PLURAL, reason: MATCH_REASONS.PLURAL };
    }
  }
  if (a.sortedKey === b.sortedKey && a.sortedKey !== '') {
    return {
      score: TIER_SCORES.TOKEN_ORDER,
      reason: MATCH_REASONS.TOKEN_ORDER,
    };
  }
  if (!shareBlock(a, b)) return null;

  const swap = a.tokens.length > b.tokens.length;
  const shorter = swap ? b.tokens : a.tokens;
  const longer = swap ? a.tokens : b.tokens;
  if (
    shorter.length > 0 &&
    shorter.length < longer.length &&
    (shorter.length >= 2 || shorter[0].length >= MIN_PREFIX_LENGTH) &&
    isTokenPrefixOrSuffix(shorter, longer)
  ) {
    return { score: TIER_SCORES.PREFIX, reason: MATCH_REASONS.PREFIX };
  }

  return fuzzyScore(a, b);
}

/** Accepts the prepared objects of the hot path as well as bare names. */
function usePrepared(candidate, name, kind) {
  if (candidate && typeof candidate === 'object' && candidate.foldedTokenSet) {
    return candidate;
  }
  return prepareName(name, kind);
}

/**
 * Scores two names. Returns the strongest tier that applies, or null when
 * the names have nothing in common the matcher recognises.
 *
 * @param {string} nameA
 * @param {string} nameB
 * @param {'tags'|'correspondents'} kind
 * @param {{a?: object, b?: object}} [prepared] normalisations of the two names
 *   from an earlier call, used by findDuplicateGroups; anything unusable is
 *   simply recomputed.
 * @returns {{score:number, reason:string}|null}
 */
function scorePair(nameA, nameB, kind, prepared) {
  const a = usePrepared(prepared && prepared.a, nameA, kind);
  const b = usePrepared(prepared && prepared.b, nameB, kind);
  return scorePrepared(a, b, kind);
}

function hasMatchingRule(entity) {
  return (
    Number(entity.matchingAlgorithm) !== MATCHING_ALGORITHM_NONE &&
    String(entity.match ?? '').trim() !== ''
  );
}

/**
 * Picks the member the others should be merged into: an inbox tag always,
 * otherwise the one with the most documents, then the one that has a
 * matching rule, then the oldest (lowest id).
 *
 * @param {EntityRecord[]} members
 * @returns {number} id of the suggested target
 */
function suggestTarget(members) {
  const ranked = [...members].sort((x, y) => {
    const inbox = Number(Boolean(y.isInboxTag)) - Number(Boolean(x.isInboxTag));
    if (inbox !== 0) return inbox;
    const docs =
      (Number(y.documentCount) || 0) - (Number(x.documentCount) || 0);
    if (docs !== 0) return docs;
    const rule = Number(hasMatchingRule(y)) - Number(hasMatchingRule(x));
    if (rule !== 0) return rule;
    return Number(x.id) - Number(y.id);
  });
  return Number(ranked[0].id);
}

function collectWarnings(kind, members, target, configuredTagNames, normalize) {
  const warnings = [];
  if (members.some((m) => m.isInboxTag)) {
    warnings.push(GROUP_WARNINGS.INBOX_TAG);
  }
  if (
    kind === KINDS.TAGS &&
    configuredTagNames.size > 0 &&
    members.some((m) => configuredTagNames.has(normalize(m.name).key))
  ) {
    warnings.push(GROUP_WARNINGS.CONFIGURED_TAG);
  }
  if (members.some((m) => m.userCanChange === false)) {
    warnings.push(GROUP_WARNINGS.NO_PERMISSION);
  }
  if (
    !hasMatchingRule(target) &&
    members.some((m) => m.id !== target.id && hasMatchingRule(m))
  ) {
    warnings.push(GROUP_WARNINGS.HAS_MATCHING_RULE);
  }
  if (new Set(members.map((m) => m.owner ?? null)).size > 1) {
    warnings.push(GROUP_WARNINGS.OWNER_DIFFERS);
  }
  if (members.length > LARGE_GROUP_SIZE) {
    warnings.push(GROUP_WARNINGS.LARGE_GROUP);
  }
  return warnings;
}

/**
 * Splits one connected component into star-shaped groups: pick the target,
 * keep every member that scores against it directly, hand the rest back for
 * another round. Members that match nothing directly are dropped.
 */
function buildGroups(kind, component, edges, configuredTagNames, normalize) {
  const groups = [];
  let pool = component;
  while (pool.length >= 2) {
    const targetId = suggestTarget(pool);
    const target = pool.find((m) => Number(m.id) === targetId);
    const kept = [];
    const rest = [];
    for (const member of pool) {
      if (member === target) continue;
      const edge = edges.get(pairKey(kind, member.id, target.id));
      if (edge) {
        kept.push({
          ...member,
          scoreToTarget: edge.score,
          reason: edge.reason,
        });
      } else {
        rest.push(member);
      }
    }
    if (kept.length > 0) {
      kept.sort(
        (x, y) =>
          (Number(y.documentCount) || 0) - (Number(x.documentCount) || 0) ||
          Number(x.id) - Number(y.id)
      );
      const members = [{ ...target, scoreToTarget: 1, reason: null }, ...kept];
      const reasons = [...kept]
        .sort((x, y) => y.scoreToTarget - x.scoreToTarget)
        .map((m) => m.reason)
        .filter((reason, index, list) => list.indexOf(reason) === index);
      groups.push({
        id: `${kind}:${members
          .map((m) => Number(m.id))
          .sort((x, y) => x - y)
          .join('-')}`,
        kind,
        confidence: Math.min(...kept.map((m) => m.scoreToTarget)),
        reasons,
        suggestedTargetId: targetId,
        members,
        warnings: collectWarnings(
          kind,
          members,
          target,
          configuredTagNames,
          normalize
        ),
      });
    }
    pool = rest;
  }
  return groups;
}

/**
 * Hands every pair that could possibly score to the callback. Names are
 * bucketed by the keys of tiers 1 to 5 and, for tiers 6 and 7, by the first
 * three characters of asciiKey and by every folded token of at least four
 * characters — the same rule scorePrepared uses as its guard, so a pair that
 * would have scored is never missed.
 */
function forEachCandidatePair(prepared, visit) {
  const total = prepared.length;
  const buckets = new Map();
  /** @type {Array<number[][]>} the buckets every name sits in */
  const membership = new Array(total);

  const put = (key, index) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(index);
    membership[index].push(bucket);
  };

  for (let index = 0; index < total; index += 1) {
    const item = prepared[index];
    membership[index] = [];
    if (!item.key) continue;
    put(`0${item.key}`, index);
    put(`1${item.asciiKey}`, index);
    put(`2${item.foldedKey}`, index);
    put(`3${item.sortedKey}`, index);
    if (item.asciiKey.length < MIN_FUZZY_KEY_LENGTH) continue;
    put(`4${item.blockPrefix}`, index);
    for (const token of item.foldedTokenSet) {
      if (token.length >= MIN_BLOCK_TOKEN_LENGTH) put(`5${token}`, index);
    }
  }

  // One stamp per name keeps every pair to a single visit without a set of
  // millions of pair keys.
  const stamp = new Int32Array(total).fill(-1);
  for (let index = 0; index < total; index += 1) {
    for (const bucket of membership[index]) {
      for (let k = 0; k < bucket.length; k += 1) {
        const other = bucket[k];
        if (other <= index || stamp[other] === index) continue;
        stamp[other] = index;
        visit(index, other);
      }
    }
  }
}

/** The reference strategy: every pair, no buckets. */
function forEachPair(prepared, visit) {
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) visit(i, j);
  }
}

/**
 * Memoised normalisation for one run: the hot loops ask for the same name
 * again and again, and prepareName is the most expensive part of a scan.
 */
function createNormalizer(kind) {
  const cache = new Map();
  return (name) => {
    const cached = cache.get(name);
    if (cached) return cached;
    const fresh = prepareName(name, kind);
    cache.set(name, fresh);
    return fresh;
  };
}

/** Everything with a usable id and a name, with the id coerced to a number. */
function toRecords(entities) {
  return (Array.isArray(entities) ? entities : [])
    .filter((e) => e && Number.isInteger(Number(e.id)) && e.name != null)
    .map((e) => ({ ...e, id: Number(e.id) }));
}

/** The two ids of a pairKey() of this kind; null when it is not one. */
function pairIdsFromKey(kind, key) {
  const prefix = `${kind}:`;
  if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
  const parts = key.slice(prefix.length).split('-');
  if (parts.length !== 2) return null;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  return [a, b];
}

/**
 * The second half of a scan: the edges decide the components, every component
 * is split into star-shaped groups and the groups are sorted.
 */
function groupsFromEdges(kind, records, edges, configuredTagNames, normalize) {
  const byId = new Map(records.map((record) => [record.id, record]));

  const parent = new Map(records.map((r) => [r.id, r.id]));
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  for (const key of edges.keys()) {
    const ids = pairIdsFromKey(kind, key);
    if (!ids || !byId.has(ids[0]) || !byId.has(ids[1])) continue;
    union(ids[0], ids[1]);
  }

  const components = new Map();
  for (const record of records) {
    const root = find(record.id);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(record);
  }

  const groups = [];
  for (const component of components.values()) {
    if (component.length < 2) continue;
    groups.push(
      ...buildGroups(kind, component, edges, configuredTagNames, normalize)
    );
  }

  const documents = (group) =>
    group.members.reduce((sum, m) => sum + (Number(m.documentCount) || 0), 0);
  groups.sort(
    (x, y) => y.confidence - x.confidence || documents(y) - documents(x)
  );
  return groups;
}

/**
 * Finds groups of entities that look like duplicates of each other.
 *
 * @param {EntityRecord[]} entities
 * @param {MatchOptions} options
 * @returns {DuplicateGroup[]} sorted by confidence desc, then by documents desc
 */
function findDuplicateGroups(entities, options) {
  const kind = options?.kind;
  if (!KIND_LIST.includes(kind)) {
    throw new Error(`Unknown entity kind: ${kind}`);
  }
  const threshold = Number.isFinite(options.threshold)
    ? options.threshold
    : DEFAULT_THRESHOLD;
  const dismissed = new Set(options.dismissedPairs || []);

  const normalize = createNormalizer(kind);
  const configuredTagNames = new Set(
    [...(options.configuredTagNames || [])].map((name) => normalize(name).key)
  );

  const records = toRecords(entities);
  const prepared = records.map((record) => normalize(record.name));

  /** @type {Map<string, {score:number, reason:string}>} */
  const edges = new Map();
  const visit = (i, j) => {
    const result = scorePrepared(prepared[i], prepared[j], kind);
    if (!result || result.score < threshold) return;
    const key = pairKey(kind, records[i].id, records[j].id);
    if (dismissed.has(key)) return;
    edges.set(key, result);
  };
  const walk =
    options.candidateStrategy === 'pairwise'
      ? forEachPair
      : forEachCandidatePair;
  walk(prepared, visit);

  return groupsFromEdges(kind, records, edges, configuredTagNames, normalize);
}

/**
 * The pairs the scan did not offer: everything that scores at least `floor`
 * but stays below `threshold`. The AI review looks at this band — the matcher
 * found a reason for these names, it just did not find enough of one.
 *
 * Same blocking and the same memoised normalisation as findDuplicateGroups,
 * so a pair that could score is never missed and a scan of a large archive
 * does not pay for the names twice.
 *
 * @param {EntityRecord[]} entities
 * @param {CandidateOptions} options
 * @returns {CandidatePair[]} score desc, then key; at most `limit` entries
 */
function findCandidatePairs(entities, options = {}) {
  const kind = options?.kind;
  if (!KIND_LIST.includes(kind)) {
    throw new Error(`Unknown entity kind: ${kind}`);
  }
  const threshold = Number.isFinite(options.threshold)
    ? options.threshold
    : DEFAULT_THRESHOLD;
  const floor = Number.isFinite(options.floor)
    ? options.floor
    : DEFAULT_CANDIDATE_FLOOR;
  const limit =
    Number.isInteger(options.limit) && options.limit >= 0
      ? options.limit
      : DEFAULT_CANDIDATE_LIMIT;
  const dismissed = new Set(options.dismissedPairs || []);

  const normalize = createNormalizer(kind);
  const records = toRecords(entities);
  const prepared = records.map((record) => normalize(record.name));

  /** @type {CandidatePair[]} */
  const candidates = [];
  const visit = (i, j) => {
    const result = scorePrepared(prepared[i], prepared[j], kind);
    if (!result || result.score < floor || result.score >= threshold) return;
    const key = pairKey(kind, records[i].id, records[j].id);
    if (dismissed.has(key)) return;
    const [a, b] =
      records[i].id < records[j].id
        ? [records[i], records[j]]
        : [records[j], records[i]];
    candidates.push({ key, a, b, score: result.score, reason: result.reason });
  };
  const walk =
    options.candidateStrategy === 'pairwise'
      ? forEachPair
      : forEachCandidatePair;
  walk(prepared, visit);

  candidates.sort(
    (x, y) => y.score - x.score || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)
  );
  return candidates.slice(0, limit);
}

/**
 * Builds groups from edges somebody else decided on — the AI review confirms
 * pairs below the threshold and hands them in here. Star clustering, target
 * rule, member order, confidence, reasons, id and warnings are the ones
 * findDuplicateGroups produces; only the edges come from outside.
 *
 * @param {'tags'|'correspondents'} kind
 * @param {EntityRecord[]} entities   every entity the edges may name
 * @param {Iterable<{key:string, score:number, reason:string}>|Map<string, {score:number, reason:string}>} edges
 * @param {{configuredTagNames?: Iterable<string>}} [options]
 * @returns {DuplicateGroup[]} sorted by confidence desc, then by documents desc
 */
function buildGroupsFromEdges(kind, entities, edges, options = {}) {
  if (!KIND_LIST.includes(kind)) {
    throw new Error(`Unknown entity kind: ${kind}`);
  }
  const normalize = createNormalizer(kind);
  const configuredTagNames = new Set(
    [...(options.configuredTagNames || [])].map((name) => normalize(name).key)
  );

  /** @type {Map<string, {score:number, reason:string}>} */
  const edgeMap = new Map();
  if (edges instanceof Map) {
    for (const [key, edge] of edges) {
      edgeMap.set(key, { score: edge.score, reason: edge.reason });
    }
  } else {
    for (const edge of edges || []) {
      if (!edge || typeof edge.key !== 'string') continue;
      edgeMap.set(edge.key, { score: edge.score, reason: edge.reason });
    }
  }

  return groupsFromEdges(
    kind,
    toRecords(entities),
    edgeMap,
    configuredTagNames,
    normalize
  );
}

module.exports = {
  KINDS,
  KIND_LIST,
  MATCH_REASONS,
  GROUP_WARNINGS,
  SENSITIVITY,
  DEFAULT_THRESHOLD,
  LARGE_GROUP_SIZE,
  MATCHING_ALGORITHM_NONE,
  TIER_SCORES,
  FUZZY,
  DEFAULT_CANDIDATE_FLOOR,
  DEFAULT_CANDIDATE_LIMIT,
  pairKey,
  normalizeName,
  scorePair,
  suggestTarget,
  findDuplicateGroups,
  findCandidatePairs,
  buildGroupsFromEdges,
  jaro,
  jaroWinkler,
  damerauLevenshtein,
  diceCoefficient,
};
