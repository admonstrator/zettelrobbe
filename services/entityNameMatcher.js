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
 * Scoring works in tiers (see scorePair). The clustering below never chains:
 * every member of a group has to score against the group's suggested target
 * directly, otherwise "Invoice" -> "Invoices" -> "Invoicing" would collapse
 * into one group through the middle name.
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
 */

/**
 * @typedef {object} NormalizedName
 * @property {string} key        lowercased, trimmed, whitespace collapsed
 * @property {string} asciiKey   key with umlauts transliterated and diacritics removed
 * @property {string[]} tokens   words of the key, punctuation stripped
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

/**
 * Normalizes a name for comparison.
 *
 * @param {string} name
 * @param {'tags'|'correspondents'} kind
 * @returns {NormalizedName}
 */
function normalizeName(name, kind) {
  void kind;
  const key = String(name ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const tokens = key.split(' ').filter(Boolean);
  return { key, asciiKey: key, tokens, foldedKey: key };
}

/**
 * Scores two names. Returns the strongest tier that applies, or null when
 * the names have nothing in common the matcher recognises.
 *
 * @param {string} nameA
 * @param {string} nameB
 * @param {'tags'|'correspondents'} kind
 * @returns {{score:number, reason:string}|null}
 */
function scorePair(nameA, nameB, kind) {
  const a = normalizeName(nameA, kind);
  const b = normalizeName(nameB, kind);
  if (!a.key || !b.key) return null;
  if (a.key === b.key) {
    return { score: 1, reason: MATCH_REASONS.EXACT };
  }
  return null;
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

function collectWarnings(kind, members, target, configuredTagNames) {
  const warnings = [];
  if (members.some((m) => m.isInboxTag)) {
    warnings.push(GROUP_WARNINGS.INBOX_TAG);
  }
  if (
    kind === KINDS.TAGS &&
    configuredTagNames.size > 0 &&
    members.some((m) => configuredTagNames.has(normalizeName(m.name, kind).key))
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
function buildGroups(kind, component, edges, configuredTagNames) {
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
        warnings: collectWarnings(kind, members, target, configuredTagNames),
      });
    }
    pool = rest;
  }
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
  const configuredTagNames = new Set(
    [...(options.configuredTagNames || [])].map(
      (name) => normalizeName(name, kind).key
    )
  );

  const records = (Array.isArray(entities) ? entities : [])
    .filter((e) => e && Number.isInteger(Number(e.id)) && e.name != null)
    .map((e) => ({ ...e, id: Number(e.id) }));

  // Union-find over the pairs above the threshold.
  const parent = new Map(records.map((r) => [r.id, r.id]));
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const union = (a, b) => parent.set(find(a), find(b));

  /** @type {Map<string, {score:number, reason:string}>} */
  const edges = new Map();
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const key = pairKey(kind, records[i].id, records[j].id);
      if (dismissed.has(key)) continue;
      const result = scorePair(records[i].name, records[j].name, kind);
      if (!result || result.score < threshold) continue;
      edges.set(key, result);
      union(records[i].id, records[j].id);
    }
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
    groups.push(...buildGroups(kind, component, edges, configuredTagNames));
  }

  const documents = (group) =>
    group.members.reduce((sum, m) => sum + (Number(m.documentCount) || 0), 0);
  groups.sort(
    (x, y) => y.confidence - x.confidence || documents(y) - documents(x)
  );
  return groups;
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
  pairKey,
  normalizeName,
  scorePair,
  suggestTarget,
  findDuplicateGroups,
};
