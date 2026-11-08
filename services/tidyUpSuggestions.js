'use strict';

/**
 * The shape of a suggestion on the Tidy up page, and how one is built from
 * what the existing services already produce.
 *
 * The page shows suggestions, not machinery: each one is a sentence a person
 * can accept or decline. This module turns the three sources into that one
 * shape —
 *
 * - a DuplicateGroup from the name matcher (and its AiVerdict, when the model
 *   was asked) becomes a `merge` suggestion;
 * - an unused tag or correspondent becomes a `delete` suggestion (several
 *   are presented together on the page, each stays one suggestion here);
 * - a TagOrderGroupMember from the Simplify order becomes a `split`, `merge`
 *   or `delete` suggestion.
 *
 * Pure module: no I/O, no model calls. The run service builds the list, the
 * route serves it, the page renders it; the sentences come from
 * services/tidyUpWording.js.
 */

const wording = require('./tidyUpWording');

/** What a suggestion proposes to do. */
const SUGGESTION_KINDS = Object.freeze({
  MERGE: 'merge',
  SPLIT: 'split',
  DELETE: 'delete',
});

/**
 * How sure the page is. `sure` comes up ticked for "Accept the sure ones";
 * `likely` is shown with Accept first; `unsure` ("Needs a look") is shown with
 * the evidence and no default.
 */
const CERTAINTY = Object.freeze({
  SURE: 'sure',
  LIKELY: 'likely',
  UNSURE: 'unsure',
});

/** The states a suggestion passes through. */
const SUGGESTION_STATUS = Object.freeze({
  OPEN: 'open',
  DONE: 'done', // accepted and carried out
  DECLINED: 'declined', // "Not the same" / "Keep the tag as it is"
  LATER: 'later', // hidden for this run
  FAILED: 'failed', // accepted, but Paperless-ngx refused
});

/**
 * Matcher reasons that settle a pair on their own (mirrors
 * entityNameMatcher.HARD_REASONS, kept literal so this module stays pure).
 */
const HARD_REASONS = Object.freeze([
  'exact-normalized',
  'umlaut-variant',
  'legal-form',
  'plural',
  'token-order',
]);

/**
 * @typedef {object} SuggestionEntity
 * @property {number} id
 * @property {string} name
 * @property {number} documentCount
 */

/**
 * @typedef {object} SuggestionEvidence
 * @property {Array<{id:number,name:string,documentCount:number,titles:string[],neighbours:string[]}>} sides
 *   one entry per name in question (two for a merge pair, one for a split or
 *   delete): a few document titles and the names usually filed with it
 */

/**
 * @typedef {object} SuggestionDetails
 * @property {string[]} rules        matcher reasons, strongest first
 * @property {number|null} confidence  matcher score 0..1
 * @property {object|null} verdict   the AiVerdict as the judge produced it
 * @property {'scan'|'ai-candidate'|'order'|'unused'} source
 * @property {string[]} warnings     GROUP_WARNINGS values, or order warnings
 */

/**
 * @typedef {object} Suggestion
 * @property {string} id            stable within a run: `<kind>:<entityKind>:<ids>`
 * @property {'merge'|'split'|'delete'} kind
 * @property {'tags'|'correspondents'} entityKind
 * @property {'sure'|'likely'|'unsure'} certainty
 * @property {string} headline      one plain sentence, e.g. "Merge Invoices into invoice"
 * @property {string} reason        one or two plain sentences saying why, and what moves
 * @property {SuggestionEntity[]} from   the names that go away (merge: sources; split/delete: the tag)
 * @property {SuggestionEntity|null} to  the name that stays (merge target), null otherwise
 * @property {string|null} typeName      split: the document type
 * @property {string[]} topicNames       split: the topic tags
 * @property {SuggestionEvidence|null} evidence
 * @property {SuggestionDetails} details
 * @property {'open'|'done'|'declined'|'later'|'failed'} status
 * @property {string|null} outcome  after done/failed: one line ("12 documents moved", the error)
 * @property {string|null} undoId   after done: the merge-log id that undoes it
 */

/**
 * How sure the page is about a duplicate group.
 *
 * - The model said `different`: unsure, whatever the spelling said; the page
 *   shows the evidence and lets the person decide.
 * - A hard spelling rule, or the model said `same` with high confidence: sure.
 * - The model said `same` with low confidence, or a prefix/token-order match
 *   without a verdict: likely.
 * - Everything else (fuzzy, semantic, unsure, a failed request): unsure.
 *
 * @param {{reasons?: string[], confidence?: number, aiVerdict?: object|null, warnings?: string[]}} group
 * @returns {'sure'|'likely'|'unsure'}
 */
function certaintyFor(group) {
  const reasons = Array.isArray(group?.reasons) ? group.reasons : [];
  const verdict = group?.aiVerdict || null;
  const warnings = Array.isArray(group?.warnings) ? group.warnings : [];
  const blocked = warnings.some((w) =>
    ['no-permission', 'inbox-tag', 'configured-tag'].includes(w)
  );
  if (blocked) return CERTAINTY.UNSURE;
  if (verdict && verdict.verdict === 'different') return CERTAINTY.UNSURE;
  if (verdict && verdict.verdict === 'unsure') return CERTAINTY.UNSURE;
  if (verdict && verdict.verdict === 'same') {
    return verdict.confidence === 'high' ? CERTAINTY.SURE : CERTAINTY.LIKELY;
  }
  if (reasons.some((r) => HARD_REASONS.includes(r))) {
    // token-order alone is the weakest hard tier; sure only with a stronger one
    return reasons.every((r) => r === 'token-order')
      ? CERTAINTY.LIKELY
      : CERTAINTY.SURE;
  }
  if (reasons.includes('prefix')) return CERTAINTY.LIKELY;
  return CERTAINTY.UNSURE;
}

/**
 * How sure the page is about an order proposal (Simplify).
 *
 * @param {{source?: string, confidence?: string}} member
 * @returns {'sure'|'likely'|'unsure'}
 */
function certaintyForOrderMember(member) {
  if (member?.source === 'rule') return CERTAINTY.SURE;
  if (member?.source === 'user') return CERTAINTY.SURE;
  return member?.confidence === 'high' ? CERTAINTY.LIKELY : CERTAINTY.UNSURE;
}

/** @param {object} m  a DuplicateGroupMember  @returns {SuggestionEntity} */
function entityOf(m) {
  return {
    id: Number(m.id),
    name: String(m.name ?? ''),
    documentCount: Number(m.documentCount ?? m.document_count ?? 0) || 0,
  };
}

/**
 * A merge suggestion from a DuplicateGroup.
 *
 * @param {object} group  DuplicateGroup (with aiVerdict when judged)
 * @param {{evidence?: SuggestionEvidence|null}} [extra]
 * @returns {Suggestion}
 */
function fromDuplicateGroup(group, extra = {}) {
  const members = Array.isArray(group.members) ? group.members : [];
  const targetId = Number(group.suggestedTargetId);
  const target = members.find((m) => Number(m.id) === targetId) || members[0];
  const sources = members.filter((m) => m !== target);
  const to = target ? entityOf(target) : null;
  const from = sources.map(entityOf);
  const certainty = certaintyFor(group);
  const details = {
    rules: Array.isArray(group.reasons) ? [...group.reasons] : [],
    confidence: Number.isFinite(group.confidence) ? group.confidence : null,
    verdict: group.aiVerdict || null,
    source: group.source === 'ai-candidate' ? 'ai-candidate' : 'scan',
    warnings: Array.isArray(group.warnings) ? [...group.warnings] : [],
  };
  return {
    id: `merge:${group.kind}:${members
      .map((m) => m.id)
      .sort((a, b) => a - b)
      .join('-')}`,
    kind: SUGGESTION_KINDS.MERGE,
    entityKind: group.kind,
    certainty,
    headline: wording.mergeHeadline({ from, to, certainty }),
    reason: wording.mergeReason({
      entityKind: group.kind,
      rules: details.rules,
      verdict: details.verdict,
      from,
      to,
      certainty,
    }),
    from,
    to,
    typeName: null,
    topicNames: [],
    evidence: extra.evidence || null,
    details,
    status: SUGGESTION_STATUS.OPEN,
    outcome: null,
    undoId: null,
  };
}

/**
 * A delete suggestion for one unused tag or correspondent.
 *
 * @param {{id:number,name:string,documentCount?:number}} entity
 * @param {'tags'|'correspondents'} entityKind
 * @returns {Suggestion}
 */
function fromUnusedEntity(entity, entityKind) {
  const e = entityOf(entity);
  return {
    id: `delete:${entityKind}:${e.id}`,
    kind: SUGGESTION_KINDS.DELETE,
    entityKind,
    certainty: CERTAINTY.SURE,
    headline: wording.deleteHeadline({ from: [e], entityKind }),
    reason: wording.deleteReason({ from: [e], entityKind }),
    from: [e],
    to: null,
    typeName: null,
    topicNames: [],
    evidence: null,
    details: {
      rules: [],
      confidence: null,
      verdict: null,
      source: 'unused',
      warnings: [],
    },
    status: SUGGESTION_STATUS.OPEN,
    outcome: null,
    undoId: null,
  };
}

/**
 * A suggestion from one member of the Simplify order. `keep` members produce
 * nothing (null): keeping a tag is not a suggestion.
 *
 * @param {object} member  TagOrderGroupMember
 * @param {{mergeTarget?: SuggestionEntity|null}} [extra]  the tag `mergeInto` names
 * @returns {Suggestion|null}
 */
function fromOrderMember(member, extra = {}) {
  if (!member || member.action === 'keep') return null;
  const tag = {
    id: Number(member.tagId),
    name: String(member.tagName ?? ''),
    documentCount: Number(member.documentCount ?? 0) || 0,
  };
  const certainty = certaintyForOrderMember(member);
  const details = {
    rules: [],
    confidence: null,
    verdict: null,
    source: 'order',
    warnings: [],
  };
  const base = {
    entityKind: 'tags',
    certainty,
    from: [tag],
    evidence: null,
    details,
    status: SUGGESTION_STATUS.OPEN,
    outcome: null,
    undoId: null,
  };
  if (member.action === 'split') {
    const typeName = member.typeName || null;
    const topicNames = Array.isArray(member.topicNames)
      ? [...member.topicNames]
      : [];
    return {
      ...base,
      id: `split:tags:${tag.id}`,
      kind: SUGGESTION_KINDS.SPLIT,
      headline: wording.splitHeadline({ from: [tag], typeName, topicNames }),
      reason: wording.splitReason({
        from: [tag],
        typeName,
        topicNames,
        modelReason: member.reason || '',
      }),
      to: null,
      typeName,
      topicNames,
    };
  }
  if (member.action === 'merge') {
    const to = extra.mergeTarget || {
      id: 0,
      name: String(member.mergeInto ?? ''),
      documentCount: 0,
    };
    return {
      ...base,
      id: `merge:tags:${tag.id}-${to.id || to.name}`,
      kind: SUGGESTION_KINDS.MERGE,
      headline: wording.mergeHeadline({ from: [tag], to, certainty }),
      reason: wording.mergeReason({
        entityKind: 'tags',
        rules: [],
        verdict: null,
        from: [tag],
        to,
        certainty,
        modelReason: member.reason || '',
      }),
      to,
      typeName: null,
      topicNames: [],
    };
  }
  // delete
  return {
    ...base,
    id: `delete:tags:${tag.id}`,
    kind: SUGGESTION_KINDS.DELETE,
    headline: wording.deleteHeadline({ from: [tag], entityKind: 'tags' }),
    reason: wording.deleteReason({
      from: [tag],
      entityKind: 'tags',
      modelReason: member.reason || '',
    }),
    to: null,
    typeName: null,
    topicNames: [],
  };
}

/**
 * The counts the page shows at the top and on its filter chips.
 *
 * @param {Suggestion[]} list
 * @returns {{total:number, open:number, sure:number, likely:number, unsure:number, merge:number, split:number, delete:number, done:number, declined:number, later:number, failed:number}}
 */
function summarize(list) {
  const out = {
    total: 0,
    open: 0,
    sure: 0,
    likely: 0,
    unsure: 0,
    merge: 0,
    split: 0,
    delete: 0,
    done: 0,
    declined: 0,
    later: 0,
    failed: 0,
  };
  for (const s of Array.isArray(list) ? list : []) {
    out.total += 1;
    if (s.status === SUGGESTION_STATUS.OPEN) {
      out.open += 1;
      out[s.certainty] += 1;
      out[s.kind] += 1;
    } else if (s.status in out) {
      out[s.status] += 1;
    }
  }
  return out;
}

module.exports = {
  SUGGESTION_KINDS,
  CERTAINTY,
  SUGGESTION_STATUS,
  HARD_REASONS,
  certaintyFor,
  certaintyForOrderMember,
  fromDuplicateGroup,
  fromUnusedEntity,
  fromOrderMember,
  summarize,
};
