'use strict';

/**
 * Duplicate merge service: the Duplicates page's whole backend.
 *
 * Three jobs, all on request, none of them automatic:
 *   scan()   — load tags or correspondents, hand them to the matcher, return groups
 *   merge()  — move the documents of the sources onto the target and delete the sources
 *   undo()   — re-create the deleted sources from the local log and move the documents back
 *
 * Two rules run through everything here. First: an object that still has
 * documents is never deleted — the move is verified against Paperless-ngx
 * before the DELETE, and a source that fails verification is reported instead
 * of forced. Second: everything an undo needs is written to the local log
 * *before* it can become unreachable, because after the DELETE the source no
 * longer exists anywhere else — its name, its matching rule, the documents it
 * had and, for tags, which of those documents already carried the target.
 *
 * The code is kind-neutral: `kind` is 'tags' or 'correspondents' and is also
 * the Paperless-ngx path segment, so document types can follow later without
 * a second implementation.
 */

const paperlessService = require('./paperlessService');
const documentModel = require('../models/document');
const dashboardStatsService = require('./dashboardStatsService');
const entityNameMatcher = require('./entityNameMatcher');

const { KINDS, KIND_LIST, DEFAULT_THRESHOLD, MATCHING_ALGORITHM_NONE } =
  entityNameMatcher;

/** `kind` value the routes accept for "scan both". */
const KIND_ALL = 'all';

/**
 * A refusal the route can map onto an HTTP status. Everything the user can
 * provoke — a bad request, a missing object, a running scan, an unreachable
 * Paperless-ngx — arrives at the route as one of these, so the route never has
 * to guess what went wrong.
 */
class MergeValidationError extends Error {
  /**
   * @param {string} message
   * @param {number} [status] HTTP status the route should answer with
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'MergeValidationError';
    this.status = status;
  }
}

/** Splits a comma separated settings value into trimmed, non-empty names. */
function splitNames(value) {
  return String(value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** True when a raw Paperless-ngx object carries a usable matching rule. */
function hasMatchingRule(raw) {
  return (
    Number(raw?.matching_algorithm) !== MATCHING_ALGORITHM_NONE &&
    String(raw?.match ?? '').trim() !== ''
  );
}

/** The three fields that make up a matching rule, in Paperless-ngx spelling. */
function matchingRuleOf(raw) {
  return {
    match: raw?.match ?? '',
    matching_algorithm: Number(raw?.matching_algorithm) || 0,
    is_insensitive: Boolean(raw?.is_insensitive),
  };
}

function sameMatchingRule(a, b) {
  return (
    String(a?.match ?? '') === String(b?.match ?? '') &&
    Number(a?.matching_algorithm) === Number(b?.matching_algorithm) &&
    Boolean(a?.is_insensitive) === Boolean(b?.is_insensitive)
  );
}

/**
 * Everything an undo needs from a source object, in Paperless-ngx spelling so
 * it can be handed to createEntity() unchanged years later.
 */
function snapshotOf(kind, raw) {
  const snapshot = {
    name: raw?.name ?? '',
    ...matchingRuleOf(raw),
    owner: raw?.owner ?? null,
  };
  if (kind === KINDS.TAGS) {
    snapshot.color = raw?.color ?? null;
    snapshot.text_color = raw?.text_color ?? null;
    snapshot.is_inbox_tag = Boolean(raw?.is_inbox_tag);
  }
  return snapshot;
}

/** The payload that re-creates a source from its snapshot. */
function createPayloadFrom(kind, snapshot) {
  const payload = {
    name: snapshot?.name ?? '',
    match: snapshot?.match ?? '',
    matching_algorithm: Number(snapshot?.matching_algorithm) || 0,
    is_insensitive: Boolean(snapshot?.is_insensitive),
  };
  if (kind === KINDS.TAGS) {
    if (snapshot?.color) payload.color = snapshot.color;
    if (snapshot?.text_color) payload.text_color = snapshot.text_color;
    payload.is_inbox_tag = Boolean(snapshot?.is_inbox_tag);
  }
  if (snapshot?.owner != null) {
    payload.owner = snapshot.owner;
  }
  return payload;
}

class DuplicateMergeService {
  /**
   * True while the document scan holds the loop. A merge during a scan would
   * race the scan's own writes, so it is refused rather than queued.
   *
   * @returns {boolean}
   */
  _isScanRunning() {
    return Boolean(global.__paperlessAiScanControl?.running);
  }

  _assertScanIdle() {
    if (this._isScanRunning()) {
      throw new MergeValidationError(
        'A document scan is running. Wait until it has finished.',
        409
      );
    }
  }

  /**
   * Tag names the Zettelrobbe settings themselves refer to. Merging one of
   * these away silently breaks the setting, so the matcher flags a group that
   * contains one.
   *
   * The configuration is re-required here, the way paperlessService does for
   * its cache TTL, so a value changed through the settings page counts on the
   * next scan instead of on the next restart.
   *
   * @returns {string[]}
   */
  _configuredTagNames() {
    const runtimeConfig = require('../config/config');
    const names = [];
    if (String(runtimeConfig.addAIProcessedTag ?? '').toLowerCase() === 'yes') {
      names.push(...splitNames(runtimeConfig.addAIProcessedTags));
    }
    names.push(...splitNames(runtimeConfig.ignoreTags));
    names.push(...splitNames(process.env.TAGS));
    return [...new Set(names)];
  }

  /**
   * Wraps a Paperless-ngx failure so the route answers 502 instead of 500.
   * A refusal this service raised itself passes through untouched.
   */
  _asPaperlessError(error, what) {
    if (error instanceof MergeValidationError) {
      return error;
    }
    return new MergeValidationError(
      `Paperless-ngx could not be reached while ${what}: ${
        error?.message || 'unknown error'
      }`,
      502
    );
  }

  /** The Paperless-ngx URL the page links its objects to; null when unknown. */
  async _publicBaseUrl() {
    try {
      const url = await paperlessService.getPublicBaseUrl();
      return url || null;
    } catch {
      // A missing link target must never fail a scan.
      return null;
    }
  }

  /**
   * Finds groups of tags or correspondents that look like duplicates.
   *
   * @param {object} [options]
   * @param {'tags'|'correspondents'|'all'} [options.kind]
   * @param {number} [options.threshold]
   * @param {boolean} [options.includeDismissed] show pairs marked "not a duplicate" again
   * @returns {Promise<object>} DuplicateScanResult
   */
  async scan({
    kind = KIND_ALL,
    threshold = DEFAULT_THRESHOLD,
    includeDismissed = false,
  } = {}) {
    const kinds = kind === KIND_ALL ? [...KIND_LIST] : [kind];
    for (const one of kinds) {
      if (!KIND_LIST.includes(one)) {
        throw new MergeValidationError(`Unknown entity kind: ${kind}`, 400);
      }
    }
    const effectiveThreshold = Number.isFinite(Number(threshold))
      ? Number(threshold)
      : DEFAULT_THRESHOLD;

    const configuredTagNames = this._configuredTagNames();
    const totals = { tags: null, correspondents: null };
    const groups = [];
    let dismissedPairs = 0;

    for (const one of kinds) {
      let entities;
      try {
        entities = await paperlessService.listEntities(one);
      } catch (error) {
        throw this._asPaperlessError(error, `loading the ${one}`);
      }
      totals[one] = entities.length;

      let dismissed = [];
      if (!includeDismissed) {
        const rows = await documentModel.listEntityMergeDismissals(one);
        dismissed = rows.map((row) =>
          entityNameMatcher.pairKey(one, row.idA, row.idB)
        );
        dismissedPairs += dismissed.length;
      }

      groups.push(
        ...entityNameMatcher.findDuplicateGroups(entities, {
          kind: one,
          threshold: effectiveThreshold,
          dismissedPairs: dismissed,
          configuredTagNames: one === KINDS.TAGS ? configuredTagNames : [],
        })
      );
    }

    return {
      scannedAt: new Date().toISOString(),
      threshold: effectiveThreshold,
      totals,
      groups,
      dismissedPairs,
      paperlessUrl: await this._publicBaseUrl(),
    };
  }

  /**
   * Validates a merge request and loads the objects it names.
   *
   * @returns {Promise<{target: object, sources: object[]}>} raw Paperless-ngx objects
   */
  async _prepareMerge({ kind, targetId, sourceIds }) {
    if (!KIND_LIST.includes(kind)) {
      throw new MergeValidationError(`Unknown entity kind: ${kind}`, 400);
    }
    const target = Number(targetId);
    if (!isPositiveInteger(target)) {
      throw new MergeValidationError(
        'targetId must be a positive integer',
        400
      );
    }
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      throw new MergeValidationError('sourceIds must not be empty', 400);
    }
    const sources = sourceIds.map(Number);
    if (!sources.every(isPositiveInteger)) {
      throw new MergeValidationError(
        'sourceIds must be positive integers',
        400
      );
    }
    if (new Set(sources).size !== sources.length) {
      throw new MergeValidationError('sourceIds must not repeat an id', 400);
    }
    if (sources.includes(target)) {
      throw new MergeValidationError(
        'The target cannot be one of the sources',
        400
      );
    }
    this._assertScanIdle();

    let targetObject;
    const sourceObjects = [];
    try {
      targetObject = await paperlessService.getEntity(kind, target);
      if (!targetObject) {
        throw new MergeValidationError(
          `The ${kind} entry ${target} does not exist in Paperless-ngx`,
          404
        );
      }
      for (const sourceId of sources) {
        const sourceObject = await paperlessService.getEntity(kind, sourceId);
        if (!sourceObject) {
          throw new MergeValidationError(
            `The ${kind} entry ${sourceId} does not exist in Paperless-ngx`,
            404
          );
        }
        sourceObjects.push(sourceObject);
      }
    } catch (error) {
      throw this._asPaperlessError(error, `reading the ${kind} to merge`);
    }

    return { target: targetObject, sources: sourceObjects };
  }

  /**
   * Moves the documents of every source onto the target and deletes the
   * sources afterwards, one source after the other.
   *
   * @param {object} request
   * @param {'tags'|'correspondents'} request.kind
   * @param {number} request.targetId
   * @param {number[]} request.sourceIds
   * @param {boolean} [request.copyMatchingRule]
   * @param {string|null} [request.performedBy]
   * @returns {Promise<object>} EntityMergeResult
   */
  async merge({
    kind,
    targetId,
    sourceIds,
    copyMatchingRule = false,
    performedBy = null,
  }) {
    const { target, sources } = await this._prepareMerge({
      kind,
      targetId,
      sourceIds,
    });
    const targetNumericId = Number(targetId);
    const targetBefore = matchingRuleOf(target);
    let copiedMatchingRule = false;

    const details = [];
    for (const source of sources) {
      const detail = {
        id: Number(source.id),
        name: source.name,
        snapshot: snapshotOf(kind, source),
        documentIds: [],
        documentsAlreadyOnTarget: [],
        documentsMoved: 0,
        deleted: false,
        error: null,
      };
      details.push(detail);

      if (
        target.user_can_change === false ||
        source.user_can_change === false
      ) {
        detail.error = 'no permission';
        continue;
      }

      try {
        const documentIds = await paperlessService.getDocumentIdsByEntity(
          kind,
          detail.id
        );
        detail.documentIds = documentIds;

        // Tags only: an undo must not strip the target from documents that
        // already carried it before the merge, so remember them now — after
        // the move the two are indistinguishable.
        if (kind === KINDS.TAGS && documentIds.length > 0) {
          const documents = await paperlessService.getDocumentsByIds(
            documentIds,
            'id,tags'
          );
          detail.documentsAlreadyOnTarget = documents
            .filter(
              (document) =>
                Array.isArray(document?.tags) &&
                document.tags.map(Number).includes(targetNumericId)
            )
            .map((document) => Number(document.id));
        }

        if (documentIds.length > 0) {
          if (kind === KINDS.TAGS) {
            await paperlessService.bulkEditDocuments(
              documentIds,
              'modify_tags',
              { add_tags: [targetNumericId], remove_tags: [detail.id] }
            );
          } else {
            await paperlessService.bulkEditDocuments(
              documentIds,
              'set_correspondent',
              { correspondent: targetNumericId }
            );
          }
          detail.documentsMoved = documentIds.length;
        }

        // Never delete an object that still has documents. Paperless-ngx is
        // the only authority on that, so it is asked again rather than
        // trusted to have applied the bulk edit.
        const remaining = await paperlessService.getDocumentIdsByEntity(
          kind,
          detail.id
        );
        if (remaining.length > 0) {
          detail.error = `${remaining.length} document(s) still carry this entry, it was not deleted`;
          continue;
        }

        if (
          copyMatchingRule &&
          !copiedMatchingRule &&
          !hasMatchingRule(target) &&
          hasMatchingRule(source)
        ) {
          await paperlessService.updateEntity(
            kind,
            targetNumericId,
            matchingRuleOf(source)
          );
          copiedMatchingRule = true;
          detail.copiedMatchingRule = true;
        }

        detail.deleted = await paperlessService.deleteEntity(kind, detail.id);
        if (!detail.deleted) {
          detail.error = 'The entry was already gone in Paperless-ngx';
          continue;
        }

        await documentModel.replaceEntityInLocalRecords(kind, {
          fromId: detail.id,
          toId: targetNumericId,
          fromName: detail.name,
          toName: target.name,
          documentIds,
        });
      } catch (error) {
        console.error(
          `[ERROR] merging ${kind} ${detail.id} into ${targetNumericId}:`,
          error?.message || error
        );
        detail.error = error?.message || 'unknown error';
      }
    }

    const documentsMoved = details.reduce(
      (sum, detail) => sum + detail.documentsMoved,
      0
    );
    const status = details.every((detail) => detail.deleted)
      ? 'done'
      : 'partial';

    paperlessService.clearEntityCaches();
    dashboardStatsService.refresh().catch((error) => {
      console.error(
        '[ERROR] refreshing dashboard statistics after a merge:',
        error?.message || error
      );
    });

    // Written even for a partial merge: the sources that *were* deleted exist
    // nowhere else any more, and without this row they cannot be undone.
    const mergeId = await documentModel.addEntityMerge({
      kind,
      targetId: targetNumericId,
      targetName: target.name,
      targetBefore,
      sources: details,
      documentsMoved,
      copiedMatchingRule,
      status,
      performedBy,
    });

    return {
      mergeId,
      kind,
      target: { id: targetNumericId, name: target.name },
      documentsMoved,
      copiedMatchingRule,
      status,
      sources: details.map((detail) => ({
        id: detail.id,
        name: detail.name,
        documentsMoved: detail.documentsMoved,
        deleted: detail.deleted,
        error: detail.error,
      })),
    };
  }

  /**
   * Re-creates a source and hands it back the documents it still qualifies
   * for. The new object gets a new id in Paperless-ngx; a same-named object
   * that exists again is adopted instead of created a second time.
   *
   * @returns {Promise<object>} one entry of EntityMergeUndoResult.sources
   */
  async _restoreSource(kind, entry, source) {
    const restored = {
      originalId: Number(source.id),
      name: source?.snapshot?.name ?? source.name,
      restoredId: null,
      adoptedExisting: false,
      documentsRestored: 0,
      documentsSkipped: 0,
      error: null,
    };
    const targetId = Number(entry.targetId);
    const documentIds = Array.isArray(source.documentIds)
      ? source.documentIds.map(Number)
      : [];

    try {
      const candidate = await paperlessService.findEntityByExactName(
        kind,
        restored.name
      );
      // The lookup is case insensitive, and the whole point of this merge was
      // that the two names only differ in case — so undoing "amazon" into
      // "Amazon" finds the *target* and would hand it its own documents back
      // under a new name. The survivor is never the object being restored.
      const existing =
        candidate && Number(candidate.id) !== targetId ? candidate : null;
      if (existing) {
        restored.restoredId = Number(existing.id);
        restored.adoptedExisting = true;
      } else {
        const payload = createPayloadFrom(kind, source.snapshot);
        let created;
        try {
          created = await paperlessService.createEntity(kind, payload);
        } catch (error) {
          const status = error?.response?.status;
          if (payload.owner != null && (status === 400 || status === 403)) {
            // Setting the owner is refused for some tokens; the object itself
            // matters more than who owns it.
            const { owner, ...withoutOwner } = payload;
            void owner;
            created = await paperlessService.createEntity(kind, withoutOwner);
          } else {
            throw error;
          }
        }
        restored.restoredId = Number(created?.id);
      }
    } catch (error) {
      restored.error = `could not restore: ${error?.message || 'unknown error'}`;
      restored.documentsSkipped = documentIds.length;
      return restored;
    }

    if (!isPositiveInteger(restored.restoredId)) {
      restored.error = 'Paperless-ngx did not return an id for the new entry';
      restored.restoredId = null;
      restored.documentsSkipped = documentIds.length;
      return restored;
    }

    try {
      // Only documents that still exist and still carry the target may be
      // moved back; everything else was changed after the merge and is left
      // alone.
      const documents =
        documentIds.length > 0
          ? await paperlessService.getDocumentsByIds(
              documentIds,
              'id,tags,correspondent'
            )
          : [];
      const qualifying = documents
        .filter((document) =>
          kind === KINDS.TAGS
            ? Array.isArray(document?.tags) &&
              document.tags.map(Number).includes(targetId)
            : Number(document?.correspondent) === targetId
        )
        .map((document) => Number(document.id));

      restored.documentsRestored = qualifying.length;
      restored.documentsSkipped = documentIds.length - qualifying.length;

      if (qualifying.length > 0) {
        if (kind === KINDS.TAGS) {
          const alreadyOnTarget = new Set(
            (Array.isArray(source.documentsAlreadyOnTarget)
              ? source.documentsAlreadyOnTarget
              : []
            ).map(Number)
          );
          const loseTarget = qualifying.filter(
            (documentId) => !alreadyOnTarget.has(documentId)
          );
          if (loseTarget.length === qualifying.length) {
            await paperlessService.bulkEditDocuments(
              qualifying,
              'modify_tags',
              {
                add_tags: [restored.restoredId],
                remove_tags: [targetId],
              }
            );
          } else {
            await paperlessService.bulkEditDocuments(
              qualifying,
              'modify_tags',
              {
                add_tags: [restored.restoredId],
                remove_tags: [],
              }
            );
            if (loseTarget.length > 0) {
              await paperlessService.bulkEditDocuments(
                loseTarget,
                'modify_tags',
                { add_tags: [], remove_tags: [targetId] }
              );
            }
          }
          await documentModel.replaceEntityInLocalRecords(kind, {
            fromId: targetId,
            toId: restored.restoredId,
            fromName: entry.targetName,
            toName: restored.name,
            documentIds: loseTarget,
          });
        } else {
          await paperlessService.bulkEditDocuments(
            qualifying,
            'set_correspondent',
            { correspondent: restored.restoredId }
          );
          await documentModel.replaceEntityInLocalRecords(kind, {
            fromId: targetId,
            toId: restored.restoredId,
            fromName: entry.targetName,
            toName: restored.name,
            documentIds: qualifying,
          });
        }
      }
    } catch (error) {
      restored.error = `documents were not moved back: ${
        error?.message || 'unknown error'
      }`;
    }

    return restored;
  }

  /**
   * Undoes a logged merge: every deleted source comes back and takes the
   * documents it still qualifies for with it.
   *
   * @param {number} mergeId
   * @param {object} [options]
   * @param {string|null} [options.performedBy]
   * @returns {Promise<object>} EntityMergeUndoResult
   */
  async undo(mergeId, { performedBy = null } = {}) {
    void performedBy;
    const id = Number(mergeId);
    if (!isPositiveInteger(id)) {
      throw new MergeValidationError('Unknown merge', 404);
    }
    const entry = await documentModel.getEntityMergeById(id);
    if (!entry) {
      throw new MergeValidationError(`Merge ${id} does not exist`, 404);
    }
    if (entry.status === 'undone') {
      throw new MergeValidationError('This merge was already undone', 409);
    }
    this._assertScanIdle();

    const kind = entry.kind;
    const targetId = Number(entry.targetId);
    let targetNow;
    try {
      targetNow = await paperlessService.getEntity(kind, targetId);
    } catch (error) {
      throw this._asPaperlessError(error, 'reading the merge target');
    }

    const deletedSources = (
      Array.isArray(entry.sources) ? entry.sources : []
    ).filter((source) => source.deleted);

    const sources = [];
    for (const source of deletedSources) {
      sources.push(await this._restoreSource(kind, entry, source));
    }

    let revertedMatchingRule = false;
    if (entry.copiedMatchingRule && entry.targetBefore && targetNow) {
      const donors = deletedSources.filter(
        (source) => source.copiedMatchingRule
      );
      const candidates = donors.length > 0 ? donors : deletedSources;
      const stillCopied = candidates.some((source) =>
        sameMatchingRule(matchingRuleOf(targetNow), source.snapshot)
      );
      if (stillCopied) {
        try {
          await paperlessService.updateEntity(
            kind,
            targetId,
            entry.targetBefore
          );
          revertedMatchingRule = true;
        } catch (error) {
          console.error(
            `[ERROR] reverting the copied matching rule of ${kind} ${targetId}:`,
            error?.message || error
          );
        }
      }
    }

    const status = sources.every((source) => source.restoredId != null)
      ? 'undone'
      : 'undo_failed';
    const undoResult = { status, revertedMatchingRule, sources };

    paperlessService.clearEntityCaches();
    dashboardStatsService.refresh().catch((error) => {
      console.error(
        '[ERROR] refreshing dashboard statistics after an undo:',
        error?.message || error
      );
    });

    await documentModel.updateEntityMergeUndo(id, { status, undoResult });
    return undoResult;
  }

  /**
   * Stores every pair among the given ids as "not a duplicate".
   *
   * @param {object} request
   * @param {'tags'|'correspondents'} request.kind
   * @param {number[]} request.ids
   * @param {Record<string,string>} [request.names] id -> name, stored for the list
   * @returns {Promise<number>} pairs newly stored
   */
  async dismiss({ kind, ids, names = {} }) {
    if (!KIND_LIST.includes(kind)) {
      throw new MergeValidationError(`Unknown entity kind: ${kind}`, 400);
    }
    const numeric = Array.isArray(ids) ? ids.map(Number) : [];
    if (numeric.length < 2 || !numeric.every(isPositiveInteger)) {
      throw new MergeValidationError(
        'ids must be at least two positive integers',
        400
      );
    }
    const unique = [...new Set(numeric)];
    if (unique.length < 2) {
      throw new MergeValidationError(
        'ids must name two different entries',
        400
      );
    }

    const nameOf = (entityId) => {
      const value = names?.[entityId] ?? names?.[String(entityId)];
      return value == null ? null : String(value);
    };

    const pairs = [];
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        pairs.push({
          idA: unique[i],
          idB: unique[j],
          nameA: nameOf(unique[i]),
          nameB: nameOf(unique[j]),
        });
      }
    }
    return documentModel.addEntityMergeDismissals(kind, pairs);
  }
}

const duplicateMergeService = new DuplicateMergeService();
// Exposed on the singleton so the routes can map a refusal onto its status
// without requiring a second module.
duplicateMergeService.MergeValidationError = MergeValidationError;
duplicateMergeService.KIND_ALL = KIND_ALL;

module.exports = duplicateMergeService;
