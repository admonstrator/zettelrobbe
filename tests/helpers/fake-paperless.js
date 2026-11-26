'use strict';

/**
 * In-memory stand-in for the part of the Paperless-ngx API the Duplicates
 * feature talks to: tags, correspondents, document types, the document list
 * and bulk_edit.
 *
 * It exists because the merge service is only interesting in the places where
 * Paperless-ngx answers something the code did not hope for — a source that
 * still has a document after the bulk edit, an object the token may not
 * change, a name that exists again when an undo wants to re-create it. A
 * hand-written mock per test cannot produce those consistently; a small store
 * that computes document_count from the documents it holds can.
 *
 * Two faces on the same store:
 *   fake.client  — drop-in for paperlessService.client (axios shaped)
 *   fake.handle  — the raw router, for a real http.createServer in front of it
 *
 * Deliberate fidelity to the real API:
 *   - names are case sensitive and unique; a POST or a rename onto a taken
 *     name gives 400
 *   - document_count is derived, never stored
 *   - `next` is an absolute URL on a different host, so any code that follows
 *     it instead of counting pages itself fails visibly here
 *   - user_can_change: false makes every write on that object answer 403
 *   - nested tags (seed.nestedTags, or any seed tag with a `parent`) behave
 *     like Paperless-ngx 3.5+: tags carry `parent` and `children`, deleting
 *     a tag deletes every tag below it, `modify_tags` takes the tags below a
 *     removed tag off as well and puts the tags above an added one on, and a
 *     `parent` that does not exist, makes a cycle or goes deeper than five
 *     levels is refused with 400. Without them tags have no such fields,
 *     like Paperless-ngx before 3.5.
 */

const DEFAULT_PAGE_SIZE = 25;
/** What Paperless-ngx leaves of a document's content for truncate_content=true. */
const TRUNCATED_CONTENT_LENGTH = 500;
const NEXT_HOST = 'http://paperless-public.invalid';

function httpError(status, data) {
  const error = new Error(
    `Request failed with status code ${status}: ${JSON.stringify(data)}`
  );
  error.isAxiosError = true;
  error.response = { status, data };
  return error;
}

function project(document, fields) {
  if (!fields) return { ...document };
  const wanted = String(fields)
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  const projected = {};
  for (const field of wanted) {
    if (field in document) projected[field] = document[field];
  }
  return projected;
}

/**
 * @param {object} [seed]
 * @param {object[]} [seed.tags]            { id, name, match?, matching_algorithm?, is_insensitive?, is_inbox_tag?, color?, owner?, user_can_change?, parent? }
 * @param {boolean} [seed.nestedTags] tags carry `parent`/`children` (Paperless-ngx 3.5+); on by
 *   itself when any seed tag names a `parent`
 * @param {object[]} [seed.correspondents]  { id, name, match?, ... }
 * @param {object[]} [seed.documentTypes]   { id, name, match?, ... }
 * @param {object[]} [seed.documents]       { id, title?, content?, tags?: number[], correspondent?: number|null, document_type?: number|null }
 * @param {Set<number>|number[]} [seed.bulkEditIgnores] document ids a bulk edit silently does not touch
 * @param {number} [seed.requestDelayMs] milliseconds every request waits before it is answered
 * @param {object} [seed.asyncBulkEdit] answer bulk_edit the way Paperless-ngx 3.5+ does: queue
 *   the edit, return a task_id, and apply it only once /tasks/ has been asked `runAfterPolls`
 *   times (default 2). `status` (default SUCCESS) is what the task ends with; FAILURE leaves the
 *   documents untouched, and `reason` (default 'worker said no') is why. `unlisted: true` never
 *   lists the task. /tasks/ answers like API version 10 (a page of results, lower-case status,
 *   the reason in `result_data`); `plainList: true` answers like version 9 (a plain array,
 *   capitals, the reason in `result`).
 * @returns {object} the stand-in
 */
function createFakePaperless(seed = {}) {
  const state = {
    tags: new Map(),
    correspondents: new Map(),
    // "Simplify tags" writes the kind of a document into its document type,
    // so the third object kind behaves like the other two here.
    document_types: new Map(),
    documents: new Map(),
    // Every request the code made, for assertions about paging and batching.
    calls: [],
    bulkEditIgnores: new Set(
      Array.isArray(seed.bulkEditIgnores)
        ? seed.bulkEditIgnores
        : [...(seed.bulkEditIgnores || [])]
    ),
    nextId: 1000,
    /** Queued bulk edits by task id (seed.asyncBulkEdit only). */
    tasks: new Map(),
    nextTaskNumber: 1,
    /** Requests being answered right now, and the most there ever were. */
    inFlight: 0,
    maxInFlight: 0,
  };

  /**
   * A request that takes time, so a caller reading several pages at once can
   * be told apart from one reading them in a row: `maxInFlight` says how many
   * overlapped, and the wall clock says what that saved.
   */
  const requestDelayMs = Number(seed.requestDelayMs) || 0;
  async function answer(fn) {
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (requestDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
      }
      return fn();
    } finally {
      state.inFlight -= 1;
    }
  }

  /** Paperless-ngx 3.5+ tag tree: on when asked for or when a seed tag has a parent. */
  const nestedTags =
    seed.nestedTags === true ||
    (seed.tags || []).some((tag) => tag && 'parent' in tag);

  const addEntity = (kind, raw) => {
    const entity = {
      id: Number(raw.id),
      slug: String(raw.name || '').toLowerCase(),
      name: String(raw.name),
      match: raw.match ?? '',
      matching_algorithm: Number(raw.matching_algorithm) || 0,
      is_insensitive: raw.is_insensitive !== false,
      owner: raw.owner ?? null,
      user_can_change: raw.user_can_change !== false,
    };
    if (kind === 'tags') {
      entity.color = raw.color ?? '#a6cee3';
      entity.text_color = raw.text_color ?? '#000000';
      entity.is_inbox_tag = Boolean(raw.is_inbox_tag);
      if (nestedTags) {
        entity.parent = raw.parent == null ? null : Number(raw.parent);
      }
    } else if (kind === 'correspondents') {
      entity.last_correspondence = raw.last_correspondence ?? null;
    }
    state[kind].set(entity.id, entity);
    if (entity.id >= state.nextId) state.nextId = entity.id + 1;
    return entity;
  };

  for (const tag of seed.tags || []) addEntity('tags', tag);
  for (const correspondent of seed.correspondents || []) {
    addEntity('correspondents', correspondent);
  }
  for (const documentType of seed.documentTypes || []) {
    addEntity('document_types', documentType);
  }
  for (const document of seed.documents || []) {
    state.documents.set(Number(document.id), {
      id: Number(document.id),
      title: document.title ?? `Document ${document.id}`,
      content: document.content == null ? '' : String(document.content),
      tags: (document.tags || []).map(Number),
      correspondent:
        document.correspondent == null ? null : Number(document.correspondent),
      document_type:
        document.document_type == null ? null : Number(document.document_type),
    });
  }

  const documentCount = (kind, id) =>
    [...state.documents.values()].filter((document) => {
      if (kind === 'tags') return document.tags.includes(id);
      if (kind === 'document_types') return document.document_type === id;
      return document.correspondent === id;
    }).length;

  /** The tags directly below one (nested tags only). */
  const childrenOf = (id) =>
    [...state.tags.values()].filter((tag) => tag.parent === id);

  /** Every tag below one, nearest first. */
  const descendantsOf = (id) => {
    const found = [];
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const child of childrenOf(current)) {
        if (found.includes(child.id) || child.id === id) continue;
        found.push(child.id);
        queue.push(child.id);
      }
    }
    return found;
  };

  /** Every tag above one, nearest first. */
  const ancestorsOf = (id) => {
    const found = [];
    let current = state.tags.get(id)?.parent ?? null;
    while (current != null && !found.includes(current) && current !== id) {
      found.push(current);
      current = state.tags.get(current)?.parent ?? null;
    }
    return found;
  };

  /**
   * Why a tag may not hang below `parentId`, or null when it may: the
   * parent must exist, must not be the tag or one below it, and the tree
   * must stay at most five levels deep.
   */
  const parentRefusal = (tagId, parentId) => {
    if (parentId == null) return null;
    if (!state.tags.has(parentId)) {
      return `Invalid pk "${parentId}" - object does not exist.`;
    }
    if (
      tagId != null &&
      (parentId === tagId || descendantsOf(tagId).includes(parentId))
    ) {
      return 'Cannot set a descendant as parent.';
    }
    const below = tagId == null ? 0 : subtreeHeight(tagId);
    if (ancestorsOf(parentId).length + 2 + below > 5) {
      return 'Maximum nesting depth exceeded.';
    }
    return null;
  };

  /** Levels below a tag: 0 for a leaf. */
  const subtreeHeight = (id) => {
    const children = childrenOf(id);
    if (children.length === 0) return 0;
    return 1 + Math.max(...children.map((child) => subtreeHeight(child.id)));
  };

  const serialize = (kind, entity) => {
    const data = {
      ...entity,
      document_count: documentCount(kind, entity.id),
    };
    if (kind === 'tags' && nestedTags) {
      // Nested objects, the way Paperless-ngx 3.5+ answers.
      data.children = childrenOf(entity.id).map((child) =>
        serialize('tags', child)
      );
    }
    return data;
  };

  const paginate = (items, params, buildPath) => {
    const pageSize = Number(params.page_size) || DEFAULT_PAGE_SIZE;
    const page = Number(params.page) || 1;
    const start = (page - 1) * pageSize;
    const slice = items.slice(start, start + pageSize);
    const hasNext = start + pageSize < items.length;
    return {
      count: items.length,
      // Absolute, and on the public host: code that follows this link instead
      // of asking for page n+1 itself leaves the configured instance.
      next: hasNext ? `${NEXT_HOST}${buildPath(page + 1)}` : null,
      previous: null,
      results: slice,
    };
  };

  /**
   * The router. `rawPath` is relative to /api, e.g. '/tags/' or
   * '/documents/', and may carry its own query string.
   *
   * @returns {{status:number, data:any}}
   */
  function handle(method, rawPath, rawParams = {}, body = {}) {
    state.calls.push({ method, path: rawPath, params: rawParams, body });
    const verb = String(method).toLowerCase();
    // Some callers spell their query into the URL rather than into `params`
    // (the tag cache does). Route on the path, and read both the same way.
    const [path, query] = String(rawPath).split('?');
    const params = { ...rawParams };
    for (const [key, value] of new URLSearchParams(query || '')) {
      if (!(key in params)) params[key] = value;
    }

    const entityMatch =
      /^\/(tags|correspondents|document_types)\/(?:(\d+)\/)?$/.exec(path);
    if (entityMatch) {
      const kind = entityMatch[1];
      const id = entityMatch[2] ? Number(entityMatch[2]) : null;

      if (verb === 'get' && id === null) {
        let items = [...state[kind].values()];
        if (params.name__iexact != null) {
          const wanted = String(params.name__iexact).toLowerCase();
          items = items.filter(
            (entity) => entity.name.toLowerCase() === wanted
          );
        }
        // What getOrCreateDocumentType() asks with, and the exact `name` its
        // retry after a unique-constraint error falls back to.
        if (params.name__icontains != null) {
          const wanted = String(params.name__icontains).toLowerCase();
          items = items.filter((entity) =>
            entity.name.toLowerCase().includes(wanted)
          );
        }
        if (params.name != null) {
          const wanted = String(params.name);
          items = items.filter((entity) => entity.name === wanted);
        }
        if (params.ordering === 'name') {
          items.sort((a, b) => a.name.localeCompare(b.name));
        }
        return {
          status: 200,
          data: paginate(
            items.map((entity) => serialize(kind, entity)),
            params,
            (page) => `/api/${kind}/?page=${page}`
          ),
        };
      }

      if (verb === 'get') {
        const entity = state[kind].get(id);
        if (!entity) throw httpError(404, { detail: 'Not found.' });
        return { status: 200, data: serialize(kind, entity) };
      }

      if (verb === 'post') {
        const name = String(body?.name ?? '');
        if (name === '') {
          throw httpError(400, { name: ['This field may not be blank.'] });
        }
        const taken = [...state[kind].values()].some(
          (entity) => entity.name === name
        );
        if (taken) {
          throw httpError(400, {
            name: [`${kind} with this name already exists.`],
          });
        }
        if (body?.owner != null && seed.rejectOwnerOnCreate) {
          throw httpError(400, { owner: ['Invalid owner.'] });
        }
        if (kind === 'tags' && nestedTags && body?.parent != null) {
          const refusal = parentRefusal(null, Number(body.parent));
          if (refusal) throw httpError(400, { parent: [refusal] });
        }
        const created = addEntity(kind, { ...body, id: state.nextId });
        return { status: 201, data: serialize(kind, created) };
      }

      if (verb === 'patch') {
        const entity = state[kind].get(id);
        if (!entity) throw httpError(404, { detail: 'Not found.' });
        if (!entity.user_can_change) {
          throw httpError(403, {
            detail: 'You do not have permission to perform this action.',
          });
        }
        // A rename runs into the same unique constraint a create does.
        if (body?.name != null) {
          const taken = [...state[kind].values()].some(
            (other) => other.id !== id && other.name === String(body.name)
          );
          if (taken) {
            throw httpError(400, {
              name: [`${kind} with this name already exists.`],
            });
          }
        }
        const parentChanged =
          kind === 'tags' &&
          nestedTags &&
          body &&
          'parent' in body &&
          (body.parent == null ? null : Number(body.parent)) !== entity.parent;
        if (parentChanged) {
          const parentId = body.parent == null ? null : Number(body.parent);
          const refusal = parentRefusal(id, parentId);
          if (refusal) throw httpError(400, { parent: [refusal] });
        }
        Object.assign(entity, body);
        if (parentChanged) {
          entity.parent = body.parent == null ? null : Number(body.parent);
          // Paperless-ngx queues a task that gives the tag's documents the
          // new parent (and what is above it); here it happens at once.
          const above = ancestorsOf(id);
          for (const document of state.documents.values()) {
            if (!document.tags.includes(id)) continue;
            document.tags = [...new Set([...document.tags, ...above])];
          }
        }
        return { status: 200, data: serialize(kind, entity) };
      }

      if (verb === 'delete') {
        const entity = state[kind].get(id);
        if (!entity) throw httpError(404, { detail: 'Not found.' });
        if (!entity.user_can_change) {
          throw httpError(403, {
            detail: 'You do not have permission to perform this action.',
          });
        }
        if (kind === 'tags' && nestedTags) {
          // on_delete=CASCADE: everything below goes too, and so does every
          // document's link to it. Since 3.5 the delete is refused when the
          // token may not delete one of those.
          const below = descendantsOf(id);
          if (
            below.some((childId) => !state.tags.get(childId).user_can_change)
          ) {
            throw httpError(403, {
              detail: 'You do not have permission to perform this action.',
            });
          }
          const gone = new Set([id, ...below]);
          for (const childId of below) state.tags.delete(childId);
          for (const document of state.documents.values()) {
            document.tags = document.tags.filter((tagId) => !gone.has(tagId));
          }
          state.cascadeDeleted = [...(state.cascadeDeleted || []), ...below];
        }
        state[kind].delete(id);
        return { status: 204, data: null };
      }
    }

    if (path === '/documents/' && verb === 'get') {
      let items = [...state.documents.values()];
      if (params.tags__id__all != null) {
        const tagId = Number(params.tags__id__all);
        items = items.filter((document) => document.tags.includes(tagId));
      }
      if (params.correspondent__id != null) {
        const correspondentId = Number(params.correspondent__id);
        items = items.filter(
          (document) => document.correspondent === correspondentId
        );
      }
      if (params.document_type__id != null) {
        const typeId = Number(params.document_type__id);
        items = items.filter((document) => document.document_type === typeId);
      }
      if (params.id__in != null) {
        const wanted = new Set(
          String(params.id__in)
            .split(',')
            .map((value) => Number(value.trim()))
        );
        items = items.filter((document) => wanted.has(document.id));
      }
      items.sort((a, b) => a.id - b.id);
      // Documented list parameter: the answer carries only the beginning of
      // each content. Code that asks for it must still bound the result
      // itself, which is what the cut below makes visible.
      const truncated =
        params.truncate_content === true ||
        String(params.truncate_content) === 'true';
      return {
        status: 200,
        data: paginate(
          items.map((document) => {
            const projected = project(document, params.fields);
            if (truncated && typeof projected.content === 'string') {
              projected.content = projected.content.slice(
                0,
                TRUNCATED_CONTENT_LENGTH
              );
            }
            return projected;
          }),
          params,
          (page) => `/api/documents/?page=${page}`
        ),
      };
    }

    if (path === '/documents/bulk_edit/' && verb === 'post') {
      const ids = (body?.documents || []).map(Number);
      const missing = ids.filter((id) => !state.documents.has(id));
      if (missing.length > 0) {
        throw httpError(400, {
          documents: [`Some documents do not exist: ${missing.join(', ')}`],
        });
      }
      if (
        !['modify_tags', 'set_correspondent', 'set_document_type'].includes(
          body.method
        )
      ) {
        throw httpError(400, {
          method: [`Unsupported method: ${body.method}`],
        });
      }
      const apply = () => applyBulkEdit(ids, body);
      if (seed.asyncBulkEdit) {
        const taskId = `task-${state.nextTaskNumber++}`;
        state.tasks.set(taskId, { apply, polls: 0, status: 'PENDING' });
        return { status: 200, data: { result: 'OK', task_id: taskId } };
      }
      apply();
      return { status: 200, data: { result: 'OK' } };
    }

    if (path === '/tasks/' && verb === 'get') {
      const options = seed.asyncBulkEdit || {};
      const task = state.tasks.get(String(params.task_id));
      let listed = [];
      if (task && !options.unlisted) {
        task.polls += 1;
        if (
          task.status === 'PENDING' &&
          task.polls >= (options.runAfterPolls ?? 2)
        ) {
          task.status = String(options.status || 'SUCCESS').toUpperCase();
          if (task.status === 'SUCCESS') task.apply();
        }
        const failedTask = task.status === 'FAILURE';
        const reason = options.reason ?? 'worker said no';
        listed = [
          options.plainList
            ? {
                task_id: String(params.task_id),
                status: task.status,
                result: failedTask ? reason : null,
              }
            : {
                task_id: String(params.task_id),
                status: task.status.toLowerCase(),
                result_data: failedTask
                  ? { error_type: 'ValueError', error_message: reason }
                  : null,
              },
        ];
      }
      return {
        status: 200,
        data: options.plainList
          ? listed
          : { count: listed.length, next: null, results: listed },
      };
    }

    if (path === '/ui_settings/' && verb === 'get') {
      return { status: 200, data: { settings: {} } };
    }

    throw httpError(404, { detail: `No route for ${verb} ${path}` });
  }

  /** What a bulk edit does to the documents, at once or when its task runs. */
  function applyBulkEdit(ids, body) {
    for (const id of ids) {
      if (state.bulkEditIgnores.has(id)) continue;
      const document = state.documents.get(id);
      if (!document) continue;
      if (body.method === 'modify_tags') {
        let add = (body.parameters?.add_tags || []).map(Number);
        const remove = new Set(
          (body.parameters?.remove_tags || []).map(Number)
        );
        if (nestedTags) {
          // bulk_edit.modify_tags: a removed tag takes the tags below it
          // along, an added one brings the tags above it; the removal runs
          // first.
          for (const tagId of [...remove]) {
            for (const below of descendantsOf(tagId)) remove.add(below);
          }
          add = [
            ...new Set(add.flatMap((tagId) => [tagId, ...ancestorsOf(tagId)])),
          ];
        }
        document.tags = nestedTags
          ? [
              ...new Set([
                ...document.tags.filter((tagId) => !remove.has(tagId)),
                ...add,
              ]),
            ]
          : [...new Set([...document.tags, ...add])].filter(
              (tagId) => !remove.has(tagId)
            );
      } else if (body.method === 'set_correspondent') {
        const value = body.parameters?.correspondent;
        document.correspondent = value == null ? null : Number(value);
      } else if (body.method === 'set_document_type') {
        const value = body.parameters?.document_type;
        document.document_type = value == null ? null : Number(value);
      }
    }
  }

  /** axios-shaped client; every 4xx/5xx is thrown the way axios throws it. */
  const client = {
    defaults: { baseURL: 'http://paperless.test/api' },
    async get(url, config = {}) {
      return answer(() => handle('get', url, config.params || {}));
    },
    async post(url, body) {
      return answer(() => handle('post', url, {}, body));
    },
    async patch(url, body) {
      return answer(() => handle('patch', url, {}, body));
    },
    async put(url, body) {
      return answer(() => handle('put', url, {}, body));
    },
    async delete(url) {
      return answer(() => handle('delete', url, {}));
    },
  };

  return {
    state,
    client,
    handle,
    /** Every request path the code made, for paging and batching assertions. */
    calls: state.calls,
    tag: (id) => state.tags.get(Number(id)),
    correspondent: (id) => state.correspondents.get(Number(id)),
    documentType: (id) => state.document_types.get(Number(id)),
    document: (id) => state.documents.get(Number(id)),
    tagNames: () => [...state.tags.values()].map((tag) => tag.name),
    correspondentNames: () =>
      [...state.correspondents.values()].map((entity) => entity.name),
    documentTypeNames: () =>
      [...state.document_types.values()].map((entity) => entity.name),
  };
}

module.exports = {
  createFakePaperless,
  DEFAULT_PAGE_SIZE,
  TRUNCATED_CONTENT_LENGTH,
};
