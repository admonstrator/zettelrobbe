/**
 * "Simplify tags": the service behind the page that turns compound tags into
 * a document type and topic tags.
 *
 * An archive that grew 1300 tags did not grow 1300 concepts. A tag such as
 * "Stromrechnung" presses two dimensions into one word: the kind of document
 * (an invoice) and what it is about (electricity). Paperless-ngx has a field
 * for the first, the document type, and tags for the second. This service
 * keeps a small target vocabulary of both, proposes for every tag what it
 * stands for, and applies the split the user confirmed: the documents get the
 * type and the topic tags, the compound tag is deleted, the merge log gets a
 * row with action 'split' that an undo can play back.
 *
 * Nothing here runs on its own. The vocabulary is the user's (the model may
 * propose it), every split is confirmed on the page, and the rule-based
 * decomposition works without any model at all.
 *
 * ## The contract (round 10)
 *
 * - The vocabulary lives in `tag_vocabulary` (models/document.js), read and
 *   written through getVocabulary() and saveVocabulary(). Entries of the
 *   dimension 'type' are document types, 'topic' entries are tags.
 * - Proposals live in `tag_split_proposals`, one per tag, and survive a
 *   reload. proposeSplits() replaces them; the user edits them one by one.
 * - applySplits() writes to Paperless-ngx and to the merge log (action
 *   'split', `details` per document), and duplicateMergeService.undo() hands
 *   a split row to undoSplit() here.
 * - The long-running pieces (the vocabulary proposal, the split proposals)
 *   run as a job of services/duplicateReviewJobService.js with their own
 *   runner and task name; they report progress through control.onProgress
 *   and honour control.signal like the judge does.
 *
 * The thin methods are implemented here; the ones that talk to the model or
 * to Paperless-ngx are the round's work and answer 501 until they land.
 */

'use strict';

const documentModel = require('../models/document');

/** The two dimensions a vocabulary entry can belong to. */
const DIMENSIONS = Object.freeze({ TYPE: 'type', TOPIC: 'topic' });
/** Where a proposal came from. */
const PROPOSAL_SOURCES = Object.freeze(['rule', 'model', 'user']);
/** What a proposal can be. */
const PROPOSAL_STATUSES = Object.freeze(['open', 'applied', 'skipped']);
/** The log action of a split, shared with duplicateMergeService and the page. */
const SPLIT_ACTION = 'split';
/** Proposals one apply call may take. */
const MAX_APPLY_TAGS = 200;
/** Prefix of every line this service writes to the app log. */
const LOG_PREFIX = '[SIMPLIFY]';

/** An error the routes turn into a status code and a message. */
class SimplifyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SimplifyError';
    this.status = status;
  }
}

function notImplemented(what) {
  return new SimplifyError(`${what} is not available yet`, 501);
}

class TagSimplifyService {
  /**
   * The vocabulary by dimension, in the user's order.
   *
   * @returns {Promise<{types: object[], topics: object[]}>} TagVocabulary
   */
  async getVocabulary() {
    const rows = await documentModel.getTagVocabulary();
    return {
      types: rows.filter((row) => row.dimension === DIMENSIONS.TYPE),
      topics: rows.filter((row) => row.dimension === DIMENSIONS.TOPIC),
    };
  }

  /**
   * Saves the vocabulary as the user edited it: names only, order kept,
   * blanks and repeats dropped. Paperless-ngx ids already known for a name
   * survive the save.
   *
   * @param {{types?: string[], topics?: string[], source?: 'model'|'user'}} body
   * @returns {Promise<{types: object[], topics: object[]}>} what was stored
   */
  async saveVocabulary(body = {}) {
    const names = (list) =>
      (Array.isArray(list) ? list : [])
        .map((name) => String(name ?? '').trim())
        .filter((name) => name !== '');
    const types = names(body.types);
    const topics = names(body.topics);
    for (const name of [...types, ...topics]) {
      if (name.length > 128) {
        throw new SimplifyError(
          `A vocabulary name is longer than 128 characters: "${name.slice(0, 40)}…"`,
          400
        );
      }
    }
    const source = body.source === 'model' ? 'model' : 'user';
    await documentModel.replaceTagVocabulary([
      ...types.map((name) => ({ dimension: DIMENSIONS.TYPE, name, source })),
      ...topics.map((name) => ({ dimension: DIMENSIONS.TOPIC, name, source })),
    ]);
    console.log(
      `${LOG_PREFIX} vocabulary saved: ${types.length} type(s), ${topics.length} topic(s).`
    );
    return this.getVocabulary();
  }

  /**
   * Asks the model for a vocabulary from the names of every tag: about
   * `config.simplifyVocabularySize` entries, types and topics, in chunks of
   * `config.duplicatesAiSweepNames` names per request. Runs as a job; the
   * result is a TagVocabulary the page shows for editing, not yet saved.
   *
   * @param {object} options
   * @param {object} control  { signal, onProgress, tokenBudget, stop, stopReason }
   * @returns {Promise<{types: string[], topics: string[], requests: number, tokens: number}>}
   */
  async proposeVocabulary(options = {}, control = {}) {
    void options;
    void control;
    throw notImplemented('The vocabulary proposal');
  }

  /**
   * Proposes, for every tag that is not itself in the vocabulary, the
   * document type and topic tags it stands for: first by rule
   * (entityNameMatcher.decomposeCompound against the vocabulary), then by
   * the model for the rest, `config.simplifyTagsPerRequest` names per
   * request with a few document titles as evidence. Replaces the stored
   * proposals. Runs as a job.
   *
   * @param {object} options  { fresh?: boolean }
   * @param {object} control
   * @returns {Promise<{proposals: number, byRule: number, byModel: number, requests: number, tokens: number}>}
   */
  async proposeSplits(options = {}, control = {}) {
    void options;
    void control;
    throw notImplemented('The split proposals');
  }

  /** @returns {Promise<object[]>} TagSplitProposal[], by name */
  async listProposals({ status = null } = {}) {
    return documentModel.listTagSplitProposals({ status });
  }

  /**
   * What the user changed on one proposal. A changed target marks the
   * proposal as the user's; `status` may only move between open and skipped.
   *
   * @param {number} tagId
   * @param {{typeName?: string|null, topicNames?: string[], overwriteType?: boolean, status?: 'open'|'skipped'}} patch
   * @returns {Promise<object>} the proposal as stored
   */
  async updateProposal(tagId, patch = {}) {
    const id = Number(tagId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new SimplifyError('Unknown tag', 404);
    }
    const current = await documentModel.getTagSplitProposal(id);
    if (!current) {
      throw new SimplifyError(`There is no proposal for tag ${id}`, 404);
    }
    if (current.status === 'applied') {
      throw new SimplifyError('This proposal was already applied', 409);
    }
    const next = {};
    if ('typeName' in patch) {
      const name = patch.typeName == null ? '' : String(patch.typeName).trim();
      next.typeName = name === '' ? null : name;
      next.source = 'user';
    }
    if ('topicNames' in patch) {
      if (!Array.isArray(patch.topicNames)) {
        throw new SimplifyError('topicNames must be a list of names', 400);
      }
      const seen = new Set();
      next.topicNames = patch.topicNames
        .map((name) => String(name ?? '').trim())
        .filter((name) => name !== '' && !seen.has(name) && seen.add(name));
      next.source = 'user';
    }
    if ('overwriteType' in patch) {
      next.overwriteType = patch.overwriteType === true;
    }
    if ('status' in patch) {
      if (patch.status !== 'open' && patch.status !== 'skipped') {
        throw new SimplifyError('status must be open or skipped', 400);
      }
      next.status = patch.status;
    }
    await documentModel.updateTagSplitProposal(id, next);
    return documentModel.getTagSplitProposal(id);
  }

  /**
   * Applies the proposals of the given tags, one after the other: the
   * vocabulary objects are created in Paperless-ngx where missing, the
   * documents of the tag get the topic tags and (where they carry none, or
   * always with overwriteType) the document type, the tag is deleted, one
   * merge-log row per tag records it with action 'split' and `details`.
   *
   * @param {{tagIds: number[], performedBy?: string|null}} request
   * @returns {Promise<{applied: object[], failed: object[]}>} TagSplitApplyResult
   */
  async applySplits(request = {}) {
    void request;
    throw notImplemented('Applying splits');
  }

  /**
   * Plays a split back from its log row: the compound tag is re-created
   * (new id), the documents get it back, the topic tags the split added are
   * removed from them, a document type the split set is restored to what
   * the document had, objects the split created are deleted again.
   *
   * @param {object} entry  the EntityMergeLogEntry with action 'split'
   * @param {{performedBy?: string|null}} [options]
   * @returns {Promise<object>} what duplicateMergeService.undo() returns for a merge
   */
  async undoSplit(entry, options = {}) {
    void entry;
    void options;
    throw notImplemented('Undoing a split');
  }
}

const tagSimplifyService = new TagSimplifyService();
tagSimplifyService.DIMENSIONS = DIMENSIONS;
tagSimplifyService.PROPOSAL_SOURCES = PROPOSAL_SOURCES;
tagSimplifyService.PROPOSAL_STATUSES = PROPOSAL_STATUSES;
tagSimplifyService.SPLIT_ACTION = SPLIT_ACTION;
tagSimplifyService.MAX_APPLY_TAGS = MAX_APPLY_TAGS;
tagSimplifyService.SimplifyError = SimplifyError;

module.exports = tagSimplifyService;
