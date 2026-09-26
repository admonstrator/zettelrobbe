// services/documentsService.js
const paperlessService = require('./paperlessService');

class DocumentsService {
  constructor() {
    // No local cache needed - using centralized cache in paperlessService
  }

  /**
   * Collect unique, positive integer IDs from a mixed list.
   * `Number(null)` is 0, so an unfiltered `Number.isInteger` check would turn
   * documents without a correspondent into a lookup for the non-existent ID 0.
   */
  static normalizeIds(ids) {
    const normalized = new Set();
    for (const rawId of Array.isArray(ids) ? ids : []) {
      const id = typeof rawId === 'object' ? Number(rawId?.id) : Number(rawId);
      if (Number.isInteger(id) && id > 0) {
        normalized.add(id);
      }
    }
    return [...normalized];
  }

  /**
   * Unresolved IDs are omitted instead of being filled with a placeholder:
   * the consumers (omnibox result pills) already substitute
   * their own label, and a placeholder would otherwise be rendered as a real
   * tag named "Unknown".
   */
  async getTagNames(tagIds = []) {
    const uniqueTagIds = DocumentsService.normalizeIds(tagIds);
    if (uniqueTagIds.length === 0) {
      return {};
    }

    return paperlessService.getTagNamesByIds(uniqueTagIds);
  }

  async getCorrespondentNames(correspondentIds = []) {
    const uniqueCorrespondentIds =
      DocumentsService.normalizeIds(correspondentIds);
    if (uniqueCorrespondentIds.length === 0) {
      return {};
    }

    return paperlessService.getCorrespondentNamesByIds(uniqueCorrespondentIds);
  }

  async getDocumentsWithMetadata(limit = 16, query = '', mode = 'all') {
    const safeLimit = Number.isInteger(Number(limit))
      ? Math.max(1, Math.min(Number(limit), 200))
      : 16;
    const normalizedQuery = String(query || '').trim();

    const documents = normalizedQuery
      ? await paperlessService.searchDocuments(normalizedQuery, safeLimit, mode)
      : await paperlessService.getRecentDocumentsWithMetadata(safeLimit);

    const tagIds = documents.flatMap((document) =>
      Array.isArray(document.tags) ? document.tags : []
    );
    const correspondentIds = documents.map(
      (document) => document.correspondent
    );

    const [tagNames, correspondentNames] = await Promise.all([
      this.getTagNames(tagIds),
      this.getCorrespondentNames(correspondentIds),
    ]);

    const paperlessUrl = await paperlessService.getPublicBaseUrl();

    return {
      documents,
      tagNames,
      correspondentNames,
      paperlessUrl,
    };
  }
}

module.exports = new DocumentsService();
