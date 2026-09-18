'use strict';

/**
 * In-memory stand-in for the part of the Paperless-ngx API the Duplicates
 * feature talks to: tags, correspondents, the document list and bulk_edit.
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
 *   - names are case sensitive and unique, POST with a taken name gives 400
 *   - document_count is derived, never stored
 *   - `next` is an absolute URL on a different host, so any code that follows
 *     it instead of counting pages itself fails visibly here
 *   - user_can_change: false makes every write on that object answer 403
 */

const DEFAULT_PAGE_SIZE = 25;
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
 * @param {object[]} [seed.tags]            { id, name, match?, matching_algorithm?, is_insensitive?, is_inbox_tag?, color?, owner?, user_can_change? }
 * @param {object[]} [seed.correspondents]  { id, name, match?, ... }
 * @param {object[]} [seed.documents]       { id, title?, tags?: number[], correspondent?: number|null }
 * @param {Set<number>|number[]} [seed.bulkEditIgnores] document ids a bulk edit silently does not touch
 * @returns {object} the stand-in
 */
function createFakePaperless(seed = {}) {
  const state = {
    tags: new Map(),
    correspondents: new Map(),
    documents: new Map(),
    // Every request the code made, for assertions about paging and batching.
    calls: [],
    bulkEditIgnores: new Set(
      Array.isArray(seed.bulkEditIgnores)
        ? seed.bulkEditIgnores
        : [...(seed.bulkEditIgnores || [])]
    ),
    nextId: 1000,
  };

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
    } else {
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
  for (const document of seed.documents || []) {
    state.documents.set(Number(document.id), {
      id: Number(document.id),
      title: document.title ?? `Document ${document.id}`,
      tags: (document.tags || []).map(Number),
      correspondent:
        document.correspondent == null ? null : Number(document.correspondent),
    });
  }

  const documentCount = (kind, id) =>
    [...state.documents.values()].filter((document) =>
      kind === 'tags'
        ? document.tags.includes(id)
        : document.correspondent === id
    ).length;

  const serialize = (kind, entity) => ({
    ...entity,
    document_count: documentCount(kind, entity.id),
  });

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
   * The router. `path` is relative to /api, e.g. '/tags/' or '/documents/'.
   *
   * @returns {{status:number, data:any}}
   */
  function handle(method, path, params = {}, body = {}) {
    state.calls.push({ method, path, params, body });
    const verb = String(method).toLowerCase();

    const entityMatch = /^\/(tags|correspondents)\/(?:(\d+)\/)?$/.exec(path);
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
        Object.assign(entity, body);
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
      if (params.id__in != null) {
        const wanted = new Set(
          String(params.id__in)
            .split(',')
            .map((value) => Number(value.trim()))
        );
        items = items.filter((document) => wanted.has(document.id));
      }
      items.sort((a, b) => a.id - b.id);
      return {
        status: 200,
        data: paginate(
          items.map((document) => project(document, params.fields)),
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
      for (const id of ids) {
        if (state.bulkEditIgnores.has(id)) continue;
        const document = state.documents.get(id);
        if (body.method === 'modify_tags') {
          const add = (body.parameters?.add_tags || []).map(Number);
          const remove = new Set(
            (body.parameters?.remove_tags || []).map(Number)
          );
          document.tags = [...new Set([...document.tags, ...add])].filter(
            (tagId) => !remove.has(tagId)
          );
        } else if (body.method === 'set_correspondent') {
          const value = body.parameters?.correspondent;
          document.correspondent = value == null ? null : Number(value);
        } else {
          throw httpError(400, {
            method: [`Unsupported method: ${body.method}`],
          });
        }
      }
      return { status: 200, data: { result: 'OK' } };
    }

    if (path === '/ui_settings/' && verb === 'get') {
      return { status: 200, data: { settings: {} } };
    }

    throw httpError(404, { detail: `No route for ${verb} ${path}` });
  }

  /** axios-shaped client; every 4xx/5xx is thrown the way axios throws it. */
  const client = {
    defaults: { baseURL: 'http://paperless.test/api' },
    async get(url, config = {}) {
      return handle('get', url, config.params || {});
    },
    async post(url, body) {
      return handle('post', url, {}, body);
    },
    async patch(url, body) {
      return handle('patch', url, {}, body);
    },
    async put(url, body) {
      return handle('put', url, {}, body);
    },
    async delete(url) {
      return handle('delete', url, {});
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
    document: (id) => state.documents.get(Number(id)),
    tagNames: () => [...state.tags.values()].map((tag) => tag.name),
    correspondentNames: () =>
      [...state.correspondents.values()].map((entity) => entity.name),
  };
}

module.exports = { createFakePaperless, DEFAULT_PAGE_SIZE };
