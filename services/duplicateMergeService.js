'use strict';

/**
 * Duplicate merge service: the Duplicates page's whole backend.
 *
 * Four jobs, all on request, none of them automatic:
 *   scan()          — load tags or correspondents, hand them to the matcher, return groups
 *   merge()         — move the documents of the sources onto the target and delete the sources
 *   deleteUnused()  — delete objects that carry no document, through the same log
 *   undo()          — re-create what a merge or a delete removed and move the documents back
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
 *
 * ## The scan cache
 *
 * A scan of a real archive reads every tag and every correspondent and scores
 * them against each other; on the user's instance that is 1359 tags and 13
 * seconds. Three of those inside a minute — the page's scan, the AI
 * proposal's, the review job's — are two scans too many, so `scan()` keeps
 * its last result per set of options for SCAN_CACHE_MS and answers the next
 * identical request from it. Only a merge, an undo or a dismissal changes
 * what a scan would see: each of them empties the cache, and a dismissal
 * taken back through the route is caught by a fingerprint of the stored
 * pairs. `scan({ fresh: true })` — what the page's Scan button sends — skips
 * the cache entirely.
 *
 * ## What it says while it works
 *
 * Every step writes one line to the app log with the prefix [DUPLICATES], the
 * way [RECONCILIATION] does: what a scan looked at and found, what a merge did
 * to each source, what an undo brought back. Tag and correspondent names are
 * part of those lines because they are what the operator is looking for;
 * document titles never are, because they are content.
 */

const paperlessService = require('./paperlessService');
const documentModel = require('../models/document');
const dashboardStatsService = require('./dashboardStatsService');
const entityNameMatcher = require('./entityNameMatcher');

const { KINDS, KIND_LIST, DEFAULT_THRESHOLD, MATCHING_ALGORITHM_NONE } =
  entityNameMatcher;

/** `kind` value the routes accept for "scan both". */
const KIND_ALL = 'all';

/** Prefix of every line this service writes to the app log. */
const LOG_PREFIX = '[DUPLICATES]';

/**
 * How long the dashboard rebuild waits for the next write before it runs.
 *
 * Merging a scan's worth of groups is a burst of single merges from the page,
 * and every one of them used to fire a refresh — each of which reads the
 * counts back out of Paperless-ngx. One refresh after the last write of the
 * burst says the same thing at a fraction of the cost. The entity caches are
 * not part of this: they are dropped immediately, because the next request
 * must not be answered from them.
 */
const DASHBOARD_REFRESH_DEBOUNCE_MS = 2000;

/**
 * How long a scan result answers the next identical request.
 *
 * Asking the model about a scan used to cost three scans of the same archive
 * inside a minute: the one the page ran, the one the AI proposal ran and the
 * one the review job ran, 13 seconds and 1359 tags each time. Nothing can
 * have changed in between — a merge, an undo or a dismissal is the only thing
 * that changes what a scan sees, and each of those drops the cache. The page
 * asks for a fresh scan anyway (`fresh: true`), so the button still means
 * "look again"; everything that runs off the back of that scan reuses it.
 */
const SCAN_CACHE_MS = 60 * 1000;

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

/** The singular noun a log line uses for a kind. */
function entityNoun(kind) {
  return kind === KINDS.CORRESPONDENTS ? 'correspondent' : 'tag';
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
  constructor() {
    /** The pending dashboard rebuild, or null when none is waiting. */
    this._dashboardRefreshTimer = null;
    /** Overridable so a test does not have to wait two seconds. */
    this.dashboardRefreshDebounceMs = DASHBOARD_REFRESH_DEBOUNCE_MS;
    /**
     * The last scan per set of options: key -> { result, at }. Small by
     * construction — three kinds times a handful of thresholds — and emptied
     * by every write, so it never holds more than a minute of scans.
     *
     * @type {Map<string, {result: object, at: number}>}
     */
    this._scanCache = new Map();
    /** Overridable so a test does not have to wait a minute. */
    this.scanCacheMs = SCAN_CACHE_MS;
  }

  /**
   * Forgets every cached scan. Called by everything that changes what a scan
   * would see — a merge, an undo, a dismissal and the restore of one — and by
   * the tests between two archives.
   */
  invalidateScanCache() {
    this._scanCache.clear();
  }

  /** One line in the app log, at info level, like [RECONCILIATION] writes. */
  _log(message) {
    console.log(`${LOG_PREFIX} ${message}`);
  }

  /**
   * Drops the entity caches now and asks for the dashboard numbers to be
   * rebuilt once the writes have stopped for `dashboardRefreshDebounceMs`.
   *
   * The timer is unref'd: a pending refresh must not keep a test process or a
   * shutting-down server alive.
   *
   * @param {string} what  'merge' or 'undo', for the error message
   */
  _afterWrite(what) {
    paperlessService.clearEntityCaches();
    this.invalidateScanCache();

    if (this._dashboardRefreshTimer) {
      clearTimeout(this._dashboardRefreshTimer);
    }
    this._dashboardRefreshTimer = setTimeout(
      () => {
        this._dashboardRefreshTimer = null;
        dashboardStatsService.refresh().catch((error) => {
          console.error(
            `[ERROR] refreshing dashboard statistics after a ${what}:`,
            error?.message || error
          );
        });
      },
      Number(this.dashboardRefreshDebounceMs) || 0
    );
    if (typeof this._dashboardRefreshTimer.unref === 'function') {
      this._dashboardRefreshTimer.unref();
    }
  }

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
   * True when a tag is one the settings refer to by name, compared the way
   * the group warnings compare it: through the matcher's normalisation, so a
   * setting that says "AI-Processed" also protects the tag "ai processed".
   *
   * @param {string[]} configuredTagNames
   * @param {string} name
   * @returns {boolean}
   */
  _isConfiguredTagName(configuredTagNames, name) {
    if (!Array.isArray(configuredTagNames) || configuredTagNames.length === 0) {
      return false;
    }
    const key = entityNameMatcher.normalizeName(name, KINDS.TAGS).key;
    return configuredTagNames.some(
      (configured) =>
        entityNameMatcher.normalizeName(configured, KINDS.TAGS).key === key
    );
  }

  /**
   * The objects of one kind that carry no document at all, sorted by name.
   *
   * These are what the Duplicates page offers for deletion, so everything
   * that must not be deleted is filtered out here rather than at the moment
   * of the DELETE: the inbox tag (Paperless-ngx routes new documents through
   * it), a tag the Zettelrobbe settings name (deleting it breaks the
   * setting), and anything the API token may not change. deleteUnused()
   * checks the same three again against a fresh read, because a scan is a
   * picture of a minute ago.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {object[]} entities  EntityRecord objects
   * @param {string[]} configuredTagNames
   * @returns {object[]}
   */
  _unusedEntities(kind, entities, configuredTagNames) {
    const isTag = kind === KINDS.TAGS;
    return (Array.isArray(entities) ? entities : [])
      .filter((entity) => {
        if (Number(entity?.documentCount) !== 0) return false;
        if (entity?.userCanChange === false) return false;
        if (isTag && entity?.isInboxTag) return false;
        if (isTag && this._isConfiguredTagName(configuredTagNames, entity.name))
          return false;
        return true;
      })
      .sort((a, b) => {
        const byName = String(a?.name ?? '').localeCompare(
          String(b?.name ?? ''),
          undefined,
          { sensitivity: 'base' }
        );
        return byName !== 0 ? byName : Number(a?.id) - Number(b?.id);
      });
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
   * What the dismissed pairs looked like when a scan was cached: how many
   * there are per kind and the highest id among them.
   *
   * The service invalidates the cache itself on every write it makes, but a
   * dismissal can also be taken back through the route, which talks to the
   * model directly. The ids are an autoincrement column, so a row that was
   * added or removed since changes the count or the maximum, and a scan built
   * without it is not served. One local SELECT per kind, against a scan of
   * the whole archive.
   *
   * @param {string[]} kinds
   * @param {boolean} includeDismissed  when true the rows do not matter
   * @returns {Promise<string>}
   */
  async _dismissalFingerprint(kinds, includeDismissed) {
    if (includeDismissed) return 'included';
    const parts = [];
    for (const one of kinds) {
      const rows = await documentModel.listEntityMergeDismissals(one);
      let highest = 0;
      for (const row of rows) {
        highest = Math.max(highest, Number(row.id) || 0);
      }
      parts.push(`${one}:${rows.length}:${highest}`);
    }
    return parts.join('|');
  }

  /**
   * Finds groups of tags or correspondents that look like duplicates.
   *
   * A result is kept for `scanCacheMs` and answers the next request with the
   * same three options, because nothing but a merge, an undo or a dismissal
   * can change what a scan sees: every one of those empties the cache, and a
   * dismissal taken back behind this service's back is caught by the
   * fingerprint above. `fresh: true` is what the page's own Scan button
   * sends: it skips the cache and refills it.
   *
   * @param {object} [options]
   * @param {'tags'|'correspondents'|'all'} [options.kind]
   * @param {number} [options.threshold]
   * @param {boolean} [options.includeDismissed] show pairs marked "not a duplicate" again
   * @param {boolean} [options.fresh] scan the archive again, whatever is cached
   * @returns {Promise<object>} DuplicateScanResult
   */
  async scan({
    kind = KIND_ALL,
    threshold = DEFAULT_THRESHOLD,
    includeDismissed = false,
    fresh = false,
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

    const cacheKey = `${kind}|${effectiveThreshold}|${includeDismissed ? 1 : 0}`;
    if (fresh !== true) {
      const cached = this._scanCache.get(cacheKey);
      const age = cached ? Date.now() - cached.at : Infinity;
      if (
        cached &&
        age < (Number(this.scanCacheMs) || 0) &&
        cached.dismissals ===
          (await this._dismissalFingerprint(kinds, includeDismissed))
      ) {
        this._log(`scan served from cache (age ${Math.round(age / 1000)}s).`);
        // A shallow copy, so a caller that adds a field of its own — the AI
        // review adds `aiReview` — does not write it into the cache.
        return { ...cached.result };
      }
    }

    const startedAt = Date.now();
    this._log(
      `scan started: ${kinds.join(', ')}, threshold ${effectiveThreshold}, ` +
        `dismissed pairs ${includeDismissed ? 'included' : 'hidden'}.`
    );

    const configuredTagNames = this._configuredTagNames();
    const totals = { tags: null, correspondents: null };
    const groups = [];
    const unused = { tags: [], correspondents: [] };
    let dismissedPairs = 0;

    for (const one of kinds) {
      let entities;
      try {
        entities = await paperlessService.listEntities(one);
      } catch (error) {
        throw this._asPaperlessError(error, `loading the ${one}`);
      }
      totals[one] = entities.length;
      unused[one] = this._unusedEntities(one, entities, configuredTagNames);

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

    const result = {
      scannedAt: new Date().toISOString(),
      threshold: effectiveThreshold,
      totals,
      groups,
      dismissedPairs,
      paperlessUrl: await this._publicBaseUrl(),
      unused,
    };
    this._scanCache.set(cacheKey, {
      result,
      at: Date.now(),
      dismissals: await this._dismissalFingerprint(kinds, includeDismissed),
    });
    this._log(
      `scan finished: ${kinds.map((one) => `${totals[one]} ${one}`).join(', ')}, ` +
        `${groups.length} group(s), ${dismissedPairs} dismissed pair(s) hidden, ` +
        `in ${Date.now() - startedAt}ms.`
    );
    return { ...result };
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
   * Renames the merge target.
   *
   * The survivor of "Rechnung" and "rechnungen" is often neither spelling,
   * and renaming it afterwards would mean a second trip through the page. It
   * happens before anything moves on purpose: a name that is already taken
   * answers 400, and at that point nothing has been touched yet, so the
   * refusal costs nothing. The one exception is a name held by a source of
   * this very merge — see merge() — which is renamed to once that source is
   * gone, because refusing "call the survivor Amazon" while deleting the
   * "Amazon" next to it would be refusing the obvious.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {object} target  the raw object, renamed in place on success
   * @param {string|null|undefined} targetName
   * @param {string} [when] how the log line ends
   * @returns {Promise<string|null>} the name before the rename, null when it kept it
   */
  async _renameTarget(kind, target, targetName, when = 'before the merge') {
    const wanted = targetName == null ? '' : String(targetName).trim();
    const before = String(target?.name ?? '');
    if (wanted === '' || wanted === before) {
      return null;
    }
    const id = Number(target.id);
    if (target?.user_can_change === false) {
      throw new MergeValidationError(
        `The API token may not rename the ${kind} entry ${id}`,
        403
      );
    }
    let updated;
    try {
      updated = await paperlessService.updateEntity(kind, id, { name: wanted });
    } catch (error) {
      if (error?.response?.status === 400) {
        throw new MergeValidationError(
          `The name "${wanted}" is already taken in Paperless-ngx; nothing was merged`,
          409
        );
      }
      throw this._asPaperlessError(error, 'renaming the merge target');
    }
    target.name = String(updated?.name ?? wanted);
    this._log(
      `renamed ${entityNoun(kind)} ${id} "${before}" to "${target.name}" ${when}.`
    );
    return before;
  }

  /**
   * Points the local records at the target's new name. History stores the
   * correspondent by name, so every row naming the old one follows the
   * rename, not only the rows of this merge.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {number} targetId
   * @param {string} fromName
   * @param {string} toName
   */
  async _renameInLocalRecords(kind, targetId, fromName, toName) {
    if (kind !== KINDS.CORRESPONDENTS) return;
    await documentModel.replaceEntityInLocalRecords(kind, {
      fromId: targetId,
      toId: targetId,
      fromName,
      toName,
      documentIds: null,
    });
  }

  /**
   * Moves the documents of every source onto the target and deletes the
   * sources afterwards, one source after the other.
   *
   * @param {object} request
   * @param {'tags'|'correspondents'} request.kind
   * @param {number} request.targetId
   * @param {number[]} request.sourceIds
   * @param {string} [request.targetName] a new name for the target, applied before the merge
   * @param {boolean} [request.copyMatchingRule]
   * @param {string|null} [request.performedBy]
   * @returns {Promise<object>} EntityMergeResult
   */
  async merge({
    kind,
    targetId,
    sourceIds,
    targetName = null,
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

    // A name one of the sources currently holds is not a clash, it is the
    // point: "amazon" survives and should be spelled "Amazon" from now on.
    // Paperless-ngx only frees that name once the source is deleted, so that
    // one rename waits for the end of the merge; every other rename happens
    // first, where a refusal still costs nothing because nothing has moved.
    const wantedName = targetName == null ? '' : String(targetName).trim();
    const heldBySource =
      wantedName !== '' &&
      sources.some((source) => String(source.name) === wantedName);
    let targetRenamedFrom = null;
    if (!heldBySource) {
      targetRenamedFrom = await this._renameTarget(kind, target, wantedName);
      if (targetRenamedFrom != null) {
        await this._renameInLocalRecords(
          kind,
          targetNumericId,
          targetRenamedFrom,
          target.name
        );
      }
    }

    const startedAt = Date.now();
    this._log(
      `merge started: ${kind}, target ${targetNumericId} "${target.name}", ` +
        `source(s) ${sources.map((source) => Number(source.id)).join(', ')}.`
    );

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
        this._log(
          `merge ${kind} ${detail.id} "${detail.name}": skipped, the API token may not change it.`
        );
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
          this._log(
            `merge ${kind} ${detail.id} "${detail.name}": ${documentIds.length} document(s) found, ` +
              `${detail.documentsMoved} moved, ${remaining.length} still on the source, not deleted.`
          );
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
          this._log(
            `merge ${kind} ${detail.id} "${detail.name}": ${documentIds.length} document(s) found, ` +
              `${detail.documentsMoved} moved, source empty, but it was already gone in Paperless-ngx.`
          );
          continue;
        }

        await documentModel.replaceEntityInLocalRecords(kind, {
          fromId: detail.id,
          toId: targetNumericId,
          fromName: detail.name,
          toName: target.name,
          documentIds,
        });
        this._log(
          `merge ${kind} ${detail.id} "${detail.name}": ${documentIds.length} document(s) found, ` +
            `${detail.documentsMoved} moved, source empty, deleted` +
            `${detail.copiedMatchingRule ? ', matching rule copied to the target' : ''}.`
        );
      } catch (error) {
        console.error(
          `[ERROR] merging ${kind} ${detail.id} into ${targetNumericId}:`,
          error?.message || error
        );
        detail.error = error?.message || 'unknown error';
      }
    }

    // The rename that waited for its name to be freed. The documents have
    // moved by now, so a failure here is reported rather than thrown: the
    // merge itself stands, and the target simply kept its name.
    if (heldBySource) {
      const stillThere = details.some(
        (detail) => String(detail.name) === wantedName && !detail.deleted
      );
      if (stillThere) {
        this._log(
          `${entityNoun(kind)} ${targetNumericId} kept its name "${target.name}": ` +
            `the source called "${wantedName}" was not deleted.`
        );
      } else {
        try {
          targetRenamedFrom = await this._renameTarget(
            kind,
            target,
            wantedName,
            'after the merge'
          );
          if (targetRenamedFrom != null) {
            await this._renameInLocalRecords(
              kind,
              targetNumericId,
              targetRenamedFrom,
              target.name
            );
          }
        } catch (error) {
          this._log(
            `${entityNoun(kind)} ${targetNumericId} kept its name "${target.name}": ` +
              `${error?.message || 'unknown error'}.`
          );
        }
      }
    }

    const documentsMoved = details.reduce(
      (sum, detail) => sum + detail.documentsMoved,
      0
    );
    const status = details.every((detail) => detail.deleted)
      ? 'done'
      : 'partial';

    this._afterWrite('merge');

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
      targetRenamedFrom,
    });

    this._log(
      `merge finished: status ${status}, ${documentsMoved} document(s) moved, ` +
        `log id ${mergeId}, in ${Date.now() - startedAt}ms.`
    );

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
   * Gives the target the name it had before the merge renamed it.
   *
   * Only when it still carries the name the merge gave it: a name the user
   * has changed since is theirs, and an undo that overwrote it would be a
   * surprise. Anything that stops the rename is logged and left alone — the
   * documents matter more than the spelling.
   *
   * @param {object} entry  the merge log row
   * @param {object|null} targetNow  the target as Paperless-ngx has it now
   * @returns {Promise<boolean>} true when the old name is back
   */
  async _revertTargetName(entry, targetNow) {
    const before = entry?.targetRenamedFrom;
    if (before == null) return false;
    const kind = entry.kind;
    const targetId = Number(entry.targetId);
    const noun = entityNoun(kind);
    if (!targetNow) {
      this._log(
        `undo ${noun} ${targetId}: it is gone in Paperless-ngx, the name "${before}" was not restored.`
      );
      return false;
    }
    if (String(targetNow.name) !== String(entry.targetName)) {
      this._log(
        `undo ${noun} ${targetId}: it is called "${targetNow.name}" and no longer ` +
          `"${entry.targetName}", so the name was left alone.`
      );
      return false;
    }
    try {
      await paperlessService.updateEntity(kind, targetId, { name: before });
    } catch (error) {
      this._log(
        `undo ${noun} ${targetId}: the name "${before}" could not be restored ` +
          `(${error?.message || 'unknown error'}).`
      );
      return false;
    }
    if (kind === KINDS.CORRESPONDENTS) {
      await documentModel.replaceEntityInLocalRecords(kind, {
        fromId: targetId,
        toId: targetId,
        fromName: entry.targetName,
        toName: before,
        documentIds: null,
      });
    }
    this._log(
      `undo ${noun} ${targetId}: renamed "${entry.targetName}" back to "${before}".`
    );
    return true;
  }

  /**
   * Undoes a logged merge: every deleted source comes back and takes the
   * documents it still qualifies for with it. A row of a deleteUnused() call
   * takes the same path with nothing to move: the objects are re-created and
   * that is the whole undo.
   *
   * @param {number} mergeId
   * @param {object} [options]
   * @param {string|null} [options.performedBy]
   * @returns {Promise<object>} EntityMergeUndoResult
   */
  async undo(mergeId, { performedBy = null } = {}) {
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
    if (entry.action === 'split') {
      // A split is undone by the service that made it; the log row is shared.
      return require('./tagSimplifyService').undoSplit(entry, { performedBy });
    }

    const kind = entry.kind;
    const isDelete = entry.action === 'delete';
    const targetId = Number(entry.targetId);
    let targetNow = null;
    if (!isDelete) {
      try {
        targetNow = await paperlessService.getEntity(kind, targetId);
      } catch (error) {
        throw this._asPaperlessError(error, 'reading the merge target');
      }
    }

    const deletedSources = (
      Array.isArray(entry.sources) ? entry.sources : []
    ).filter((source) => source.deleted);

    const startedAt = Date.now();
    this._log(
      isDelete
        ? `undo started: delete ${id}, ${kind}, ${deletedSources.length} deleted object(s).`
        : `undo started: merge ${id}, ${kind}, target ${targetId} "${entry.targetName}", ` +
            `${deletedSources.length} deleted source(s).`
    );

    // The name goes back first: a merge that renamed the target to what a
    // source was called would otherwise make that source impossible to
    // re-create, because Paperless-ngx keeps names unique.
    const renamedBack = await this._revertTargetName(entry, targetNow);
    const effectiveEntry = renamedBack
      ? { ...entry, targetName: entry.targetRenamedFrom }
      : entry;

    const sources = [];
    for (const source of deletedSources) {
      const restored = await this._restoreSource(kind, effectiveEntry, source);
      sources.push(restored);
      this._log(
        restored.error
          ? `undo ${kind} "${restored.name}": ${restored.error}.`
          : `undo ${kind} "${restored.name}": restored as ${restored.restoredId} ` +
              `(${restored.adoptedExisting ? 'adopted an existing entry' : 'created'}), ` +
              `${restored.documentsRestored} document(s) restored, ${restored.documentsSkipped} skipped.`
      );
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

    // "undone" only when every source is back *and* took its documents with
    // it. A source that was re-created but whose documents could not be moved
    // back keeps the merge retryable: the next undo adopts the re-created
    // entry by name and moves the rest.
    const status = sources.every(
      (source) => source.restoredId != null && source.error == null
    )
      ? 'undone'
      : 'undo_failed';
    const undoResult = { status, revertedMatchingRule, performedBy, sources };

    this._afterWrite('undo');

    await documentModel.updateEntityMergeUndo(id, { status, undoResult });
    this._log(
      `undo finished: status ${status}, matching rule ${
        revertedMatchingRule ? 'reverted' : 'left alone'
      }, in ${Date.now() - startedAt}ms.`
    );
    return undoResult;
  }

  /**
   * Deletes tags or correspondents that carry no document.
   *
   * A scan is a picture of a minute ago, so nothing here trusts it: every id
   * is read again, and an object that has meanwhile been given a document, is
   * the inbox tag, is named by the settings, may not be changed by the token
   * or is already gone is refused with a reason instead of deleted. The call
   * writes one row to the merge log with a snapshot of everything it removed,
   * which is what undo() re-creates them from — the same code path a merge's
   * sources take, because a deleted object is a deleted object.
   *
   * @param {object} request
   * @param {'tags'|'correspondents'} request.kind
   * @param {number[]} request.ids
   * @param {string|null} [request.performedBy]
   * @returns {Promise<object>} EntityDeleteResult
   */
  async deleteUnused({ kind, ids, performedBy = null }) {
    if (!KIND_LIST.includes(kind)) {
      throw new MergeValidationError(`Unknown entity kind: ${kind}`, 400);
    }
    const numeric = Array.isArray(ids) ? ids.map(Number) : [];
    if (numeric.length === 0 || !numeric.every(isPositiveInteger)) {
      throw new MergeValidationError(
        'ids must be at least one positive integer',
        400
      );
    }
    this._assertScanIdle();

    const unique = [...new Set(numeric)];
    const configuredTagNames =
      kind === KINDS.TAGS ? this._configuredTagNames() : [];
    const startedAt = Date.now();
    this._log(`delete started: ${kind}, ${unique.length} object(s) requested.`);

    const deleted = [];
    const failed = [];
    const details = [];

    for (const id of unique) {
      let raw;
      try {
        raw = await paperlessService.getEntity(kind, id);
      } catch (error) {
        failed.push({
          id,
          name: '',
          error: `could not be read: ${error?.message || 'unknown error'}`,
        });
        continue;
      }
      if (!raw) {
        failed.push({
          id,
          name: '',
          error: 'It does not exist in Paperless-ngx any more',
        });
        continue;
      }
      const name = String(raw.name ?? '');
      if (raw.user_can_change === false) {
        failed.push({ id, name, error: 'The API token may not change it' });
        continue;
      }
      if (kind === KINDS.TAGS && raw.is_inbox_tag) {
        failed.push({ id, name, error: 'It is an inbox tag' });
        continue;
      }
      if (
        kind === KINDS.TAGS &&
        this._isConfiguredTagName(configuredTagNames, name)
      ) {
        failed.push({ id, name, error: 'The settings refer to this tag' });
        continue;
      }

      let documentIds;
      try {
        documentIds = await paperlessService.getDocumentIdsByEntity(kind, id);
      } catch (error) {
        failed.push({
          id,
          name,
          error: `its documents could not be counted: ${
            error?.message || 'unknown error'
          }`,
        });
        continue;
      }
      if (documentIds.length > 0) {
        failed.push({
          id,
          name,
          error: `${documentIds.length} document(s) carry it by now`,
        });
        continue;
      }

      try {
        const removed = await paperlessService.deleteEntity(kind, id);
        if (!removed) {
          failed.push({
            id,
            name,
            error: 'It was already gone in Paperless-ngx',
          });
          continue;
        }
      } catch (error) {
        failed.push({
          id,
          name,
          error: `it was not deleted: ${error?.message || 'unknown error'}`,
        });
        continue;
      }

      deleted.push({ id, name });
      // The same shape a merge stores for a source, so _restoreSource() can
      // bring it back without knowing which of the two wrote the row.
      details.push({
        id,
        name,
        snapshot: snapshotOf(kind, raw),
        documentIds: [],
        documentsAlreadyOnTarget: [],
        documentsMoved: 0,
        deleted: true,
        error: null,
      });
    }

    this._afterWrite('delete');

    let logId = null;
    if (deleted.length > 0) {
      logId = await documentModel.addEntityMerge({
        kind,
        // A delete has no survivor; the row is about its sources alone.
        targetId: 0,
        targetName: '',
        targetBefore: null,
        sources: details,
        documentsMoved: 0,
        copiedMatchingRule: false,
        status: failed.length === 0 ? 'done' : 'partial',
        performedBy,
        action: 'delete',
      });
      this._log(
        `deleted ${deleted.length} unused ${entityNoun(kind)}(s): ` +
          `${deleted.map((entry) => entry.name).join(', ')}.`
      );
    }
    this._log(
      `delete finished: ${deleted.length} deleted, ${failed.length} refused, ` +
        `log id ${logId}, in ${Date.now() - startedAt}ms.`
    );

    return { kind, deleted, failed, logId };
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
    const stored = await documentModel.addEntityMergeDismissals(kind, pairs);
    // A dismissed pair is a pair the next scan hides, so what is cached is
    // out of date the moment this row exists.
    this.invalidateScanCache();
    this._log(
      `dismissed: ${kind}, ${stored} new pair(s) stored from ${unique.length} entries ` +
        `(${pairs.length} pair(s) in the request).`
    );
    return stored;
  }

  /**
   * Takes back one "not a duplicate": the pair may show up in a scan again.
   *
   * The route may also call documentModel.removeEntityMergeDismissal()
   * directly; this wrapper exists because the cached scans have to go with
   * the row, and only this service knows about them.
   *
   * @param {number} dismissalId  the id of the stored pair
   * @returns {Promise<boolean>} true when a row was removed
   */
  async restoreDismissal(dismissalId) {
    const removed = await documentModel.removeEntityMergeDismissal(
      Number(dismissalId)
    );
    if (removed) {
      this.invalidateScanCache();
      this._log(`dismissal ${Number(dismissalId)} restored.`);
    }
    return Boolean(removed);
  }

  /**
   * Every tag or correspondent of the instance, sorted by name.
   *
   * This is what the "Merge by hand" module picks from: a merge the user
   * decided on themselves needs the whole list, not the groups a scan
   * proposed. Nothing is filtered and nothing is scored here — the records
   * arrive exactly as paperlessService built them, so the page can show the
   * document count, the matching rule and the permission flag it needs to
   * warn about before the merge.
   *
   * The sort is case-insensitive on purpose: "Amazon" and "amazon" are two
   * different objects in Paperless-ngx and belong next to each other in a
   * list whose whole point is finding them.
   *
   * @param {'tags'|'correspondents'} kind
   * @returns {Promise<object[]>} EntityRecord objects, sorted by name
   */
  async listEntities(kind) {
    if (!KIND_LIST.includes(kind)) {
      throw new MergeValidationError(`Unknown entity kind: ${kind}`, 400);
    }

    let entities;
    try {
      entities = await paperlessService.listEntities(kind);
    } catch (error) {
      throw this._asPaperlessError(error, `loading the ${kind}`);
    }

    return [...entities].sort((a, b) => {
      const byName = String(a?.name ?? '').localeCompare(
        String(b?.name ?? ''),
        undefined,
        { sensitivity: 'base' }
      );
      // Two names that differ only in case compare equal; the id then decides,
      // so the same instance always answers in the same order.
      return byName !== 0 ? byName : Number(a?.id) - Number(b?.id);
    });
  }

  /**
   * The tag names the Zettelrobbe settings refer to, and whether one of them
   * is meant by a given name.
   *
   * The same two questions the scan asks itself, in public: "Simplify tags"
   * must not offer to split a tag a setting names, for the same reason the
   * Duplicates page must not offer to merge or delete one.
   *
   * @returns {string[]}
   */
  configuredTagNames() {
    return this._configuredTagNames();
  }

  /**
   * @param {string[]} configuredTagNames  what configuredTagNames() returned
   * @param {string} name
   * @returns {boolean}
   */
  isConfiguredTagName(configuredTagNames, name) {
    return this._isConfiguredTagName(configuredTagNames, name);
  }

  /**
   * What every write to Paperless-ngx has to do afterwards: drop the entity
   * caches and the cached scans now, and ask for the dashboard numbers once
   * the writes have stopped. Public because "Simplify tags" writes through
   * its own service and must not leave a stale scan behind either.
   *
   * @param {string} what  'split' or 'undo', for the error message
   */
  afterWrite(what) {
    this._afterWrite(what);
  }
}

const duplicateMergeService = new DuplicateMergeService();
// Exposed on the singleton so the routes can map a refusal onto its status
// without requiring a second module.
duplicateMergeService.MergeValidationError = MergeValidationError;
duplicateMergeService.KIND_ALL = KIND_ALL;
duplicateMergeService.DASHBOARD_REFRESH_DEBOUNCE_MS =
  DASHBOARD_REFRESH_DEBOUNCE_MS;
duplicateMergeService.SCAN_CACHE_MS = SCAN_CACHE_MS;

module.exports = duplicateMergeService;
