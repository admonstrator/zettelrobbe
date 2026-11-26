// @ts-check
'use strict';

/**
 * Nested tags in Paperless-ngx, as far as Tidy up has to know about them.
 *
 * A tag may have a parent (`parent`, an id or null) and child tags
 * (`children`). Three things Paperless-ngx does with that tree decide what
 * Tidy up may do:
 *
 * - Deleting a tag deletes every tag below it, and the documents lose all of
 *   them. Tidy up therefore never deletes a tag that has child tags.
 * - Taking a tag off documents (bulk_edit `modify_tags`, `remove_tags`) also
 *   takes off every tag below it; adding one (`add_tags`) also adds every tag
 *   above it.
 * - Older Paperless-ngx versions have no `parent` or `children` at all. Then
 *   there is no tree, and everything here answers "no hierarchy".
 *
 * Pure module: no I/O. paperlessService reads the tags, this module answers
 * questions about the tree they form.
 */

/** Paperless-ngx refuses a tree deeper than this; also a guard against cycles. */
const MAX_DEPTH = 5;

/**
 * @param {unknown} value
 * @returns {number|null} a positive integer id, or null
 */
function idOf(value) {
  const raw =
    value && typeof value === 'object'
      ? /** @type {{id?: unknown}} */ (value).id
      : value;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * True when a raw Paperless-ngx tag carries the hierarchy fields at all.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
function hasHierarchyFields(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return 'parent' in raw || 'children' in raw;
}

/**
 * The parent id of a raw tag; null for a top-level tag or no hierarchy.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function parentIdOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return idOf(/** @type {{parent?: unknown}} */ (raw).parent);
}

/**
 * The ids of the direct child tags a raw tag lists, whether Paperless-ngx
 * sends them as nested objects or as plain ids. Null when the tag does not
 * list them (an older version, or a shape without `children`).
 *
 * @param {unknown} raw
 * @returns {number[]|null}
 */
function childIdsOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const children = /** @type {{children?: unknown}} */ (raw).children;
  if (!Array.isArray(children)) return null;
  /** @type {number[]} */
  const ids = [];
  for (const child of children) {
    const id = idOf(child);
    if (id != null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The tree as a map from tag id to parent id, built from EntityRecords
 * (which carry `parentId` when the instance knows the hierarchy).
 *
 * @param {Array<{id: number, parentId?: number|null}>} records
 * @returns {Map<number, number|null>}
 */
function parentMapOf(records) {
  /** @type {Map<number, number|null>} */
  const parentOf = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = idOf(record?.id);
    if (id == null) continue;
    parentOf.set(id, idOf(record?.parentId));
  }
  return parentOf;
}

/**
 * Every tag above one, nearest first.
 *
 * @param {number} tagId
 * @param {Map<number, number|null>} parentOf
 * @returns {number[]}
 */
function ancestorsOf(tagId, parentOf) {
  /** @type {number[]} */
  const ancestors = [];
  let current = parentOf.get(Number(tagId)) ?? null;
  while (
    current != null &&
    !ancestors.includes(current) &&
    current !== Number(tagId) &&
    ancestors.length < MAX_DEPTH
  ) {
    ancestors.push(current);
    current = parentOf.get(current) ?? null;
  }
  return ancestors;
}

/**
 * True when `tagId` sits somewhere below `ancestorId`.
 *
 * @param {number} tagId
 * @param {number} ancestorId
 * @param {Map<number, number|null>} parentOf
 * @returns {boolean}
 */
function isDescendantOf(tagId, ancestorId, parentOf) {
  return ancestorsOf(tagId, parentOf).includes(Number(ancestorId));
}

/**
 * Which of the tags a change wants to take off one document can go without
 * Paperless-ngx taking anything else with them.
 *
 * Removing a tag removes every tag below it as well. A candidate is safe
 * when every tag below it that the document carries is itself being removed;
 * the answer is the largest such set.
 *
 * @param {number[]} documentTags  what the document carries now
 * @param {number[]} candidates    what the change would like to remove
 * @param {Map<number, number|null>} parentOf
 * @returns {number[]} the candidates that can go, in the order given
 */
function removableTags(documentTags, candidates, parentOf) {
  const carried = new Set((documentTags || []).map(Number));
  const wanted = new Set(
    (candidates || []).map(Number).filter((id) => carried.has(id))
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of [...wanted]) {
      const blocked = [...carried].some(
        (tag) =>
          !wanted.has(tag) &&
          tag !== candidate &&
          isDescendantOf(tag, candidate, parentOf)
      );
      if (blocked) {
        wanted.delete(candidate);
        changed = true;
      }
    }
  }
  return [...new Set((candidates || []).map(Number))].filter((id) =>
    wanted.has(id)
  );
}

module.exports = {
  MAX_DEPTH,
  hasHierarchyFields,
  parentIdOf,
  childIdsOf,
  parentMapOf,
  ancestorsOf,
  isDescendantOf,
  removableTags,
};
