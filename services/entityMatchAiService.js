'use strict';

/**
 * AI review for the Duplicates page: the configured AI provider judges pairs
 * of tag or correspondent names the matcher is not sure about, on request.
 *
 * Contract skeleton. The vocabulary (verdicts, group sources), the shape of a
 * verdict and the two entry points are fixed here; the page and its route
 * are built against them. `reviewPairs` answers "unsure" for everything
 * until the real implementation lands, so the whole chain can be wired and
 * exercised before a model is involved.
 *
 * Design rules that must survive the implementation:
 * - Nothing runs on its own. A review happens when the user asks for one.
 * - The model never merges. It answers same / different / unsure per pair,
 *   with one short reason; the user decides.
 * - Every name the model returns is validated against the names it was
 *   given; anything else is dropped.
 * - The deterministic matcher stays the source of candidates. The model only
 *   sees pairs the matcher produced (groups and the wider candidate band).
 */

const config = require('../config/config');

const AI_VERDICTS = Object.freeze({
  SAME: 'same',
  DIFFERENT: 'different',
  UNSURE: 'unsure',
});
const AI_VERDICT_LIST = Object.freeze(Object.values(AI_VERDICTS));

/** Where a group in an AI review result came from. */
const GROUP_SOURCES = Object.freeze({
  SCAN: 'scan',
  AI_CANDIDATE: 'ai-candidate',
});

/**
 * @typedef {object} AiVerdict
 * @property {'same'|'different'|'unsure'} verdict
 * @property {string} reason   one short sentence from the model, '' when none
 */

/**
 * @typedef {object} AiReviewEntity
 * @property {number} id
 * @property {string} name
 * @property {number} [documentCount]
 * @property {string[]} [sampleTitles]  a few recent document titles for context
 */

/**
 * @typedef {object} AiReviewPair
 * @property {string} key     pairKey() of the two ids
 * @property {AiReviewEntity} a
 * @property {AiReviewEntity} b
 */

/**
 * @typedef {object} AiReviewUsage
 * @property {number} requests        model requests made
 * @property {number|null} tokens     total tokens when the provider reports them
 */

/**
 * @typedef {object} AiReviewPairsResult
 * @property {Map<string, AiVerdict>} verdicts   keyed by pair key; every pair gets one
 * @property {string|null} model
 * @property {AiReviewUsage} usage
 */

/**
 * @typedef {object} AiReviewOptions
 * @property {'tags'|'correspondents'|'all'} [kind]
 * @property {number} [threshold]
 * @property {boolean} [includeDismissed]
 * @property {boolean} [withTitles]   fetch a few document titles per entity as context
 */

/**
 * Reduces the verdicts of a group's members (each judged against the target)
 * to one verdict for the group: any "different" wins, otherwise all "same"
 * is "same", otherwise "unsure". The reason is the first one that decided it.
 *
 * @param {Array<AiVerdict|null|undefined>} verdicts
 * @returns {AiVerdict}
 */
function aggregateVerdict(verdicts) {
  const list = (Array.isArray(verdicts) ? verdicts : []).filter(Boolean);
  if (list.length === 0) {
    return { verdict: AI_VERDICTS.UNSURE, reason: '' };
  }
  const different = list.find((v) => v.verdict === AI_VERDICTS.DIFFERENT);
  if (different) {
    return { verdict: AI_VERDICTS.DIFFERENT, reason: different.reason || '' };
  }
  if (list.every((v) => v.verdict === AI_VERDICTS.SAME)) {
    return { verdict: AI_VERDICTS.SAME, reason: list[0].reason || '' };
  }
  const unsure = list.find((v) => v.verdict === AI_VERDICTS.UNSURE);
  return { verdict: AI_VERDICTS.UNSURE, reason: unsure?.reason || '' };
}

class EntityMatchAiService {
  /**
   * Whether the page should offer the review at all: the setting is on and
   * an AI provider is configured.
   *
   * @returns {boolean}
   */
  isEnabled() {
    const runtimeConfig = require('../config/config');
    return (
      Boolean(runtimeConfig.duplicatesAiReview) &&
      Boolean(runtimeConfig.aiProvider)
    );
  }

  /**
   * Asks the model about every pair and returns one verdict per pair.
   * Placeholder: answers "unsure" for everything without contacting a model.
   *
   * @param {AiReviewPair[]} pairs
   * @param {{kind:'tags'|'correspondents'}} options
   * @returns {Promise<AiReviewPairsResult>}
   */
  async reviewPairs(pairs, options = {}) {
    void options;
    const verdicts = new Map();
    for (const pair of Array.isArray(pairs) ? pairs : []) {
      verdicts.set(pair.key, {
        verdict: AI_VERDICTS.UNSURE,
        reason: 'AI review is not implemented yet',
      });
    }
    return { verdicts, model: null, usage: { requests: 0, tokens: null } };
  }

  /**
   * Runs a scan, adds the wider candidate band, has the model judge every
   * pair (group members against their target, and the candidates) and
   * returns the scan result with verdicts attached.
   *
   * Placeholder: returns the plain scan with `aiVerdict: null` on every
   * group and member, `source: 'scan'`, and an empty `aiReview` block.
   *
   * @param {AiReviewOptions} options
   * @returns {Promise<object>} DuplicateAiReviewResult (see schemas.js)
   */
  async reviewScan(options = {}) {
    const duplicateMergeService = require('./duplicateMergeService');
    const scan = await duplicateMergeService.scan(options);
    return {
      ...scan,
      groups: (scan.groups || []).map((group) => ({
        ...group,
        source: GROUP_SOURCES.SCAN,
        aiVerdict: null,
        members: (group.members || []).map((member) => ({
          ...member,
          aiVerdict: null,
        })),
      })),
      aiReview: {
        enabled: this.isEnabled(),
        model: null,
        requests: 0,
        tokens: null,
        judged: 0,
        candidates: 0,
      },
    };
  }
}

const entityMatchAiService = new EntityMatchAiService();
entityMatchAiService.AI_VERDICTS = AI_VERDICTS;
entityMatchAiService.AI_VERDICT_LIST = AI_VERDICT_LIST;
entityMatchAiService.GROUP_SOURCES = GROUP_SOURCES;
entityMatchAiService.aggregateVerdict = aggregateVerdict;
entityMatchAiService.batchSize = () => {
  const size = Number(config.duplicatesAiReviewBatchSize);
  return Number.isInteger(size) && size > 0 ? size : 25;
};
entityMatchAiService.candidateFloor = () => {
  const floor = Number(config.duplicatesAiCandidateFloor);
  return Number.isFinite(floor) && floor > 0 && floor < 1 ? floor : 0.6;
};

module.exports = entityMatchAiService;
