// services/documentsService.js
const paperlessService = require('./paperlessService');

class DocumentsService {
  constructor() {
    // No local cache needed - using centralized cache in paperlessService
  }

  async getTagNames(tagIds = []) {
    const uniqueTagIds = [...new Set((Array.isArray(tagIds) ? tagIds : []).map(id => Number(id)).filter(Number.isInteger))];
    if (uniqueTagIds.length === 0) {
      return {};
    }

    const tagEntries = await Promise.all(uniqueTagIds.map(async (tagId) => {
      const tagName = await paperlessService.getTagNameById(tagId);
      return [tagId, tagName || 'Unknown'];
    }));

    return Object.fromEntries(tagEntries);
  }

  async getCorrespondentNames(correspondentIds = []) {
    const uniqueCorrespondentIds = [...new Set((Array.isArray(correspondentIds) ? correspondentIds : []).map(id => Number(id)).filter(Number.isInteger))];
    if (uniqueCorrespondentIds.length === 0) {
      return {};
    }

    const correspondentEntries = await Promise.all(uniqueCorrespondentIds.map(async (correspondentId) => {
      const correspondent = await paperlessService.getCorrespondentNameById(correspondentId);
      return [correspondentId, correspondent?.name || 'Unknown'];
    }));

    return Object.fromEntries(correspondentEntries);
  }

  async getDocumentsWithMetadata(limit = 16) {
    const safeLimit = Number.isInteger(Number(limit)) ? Math.max(1, Math.min(Number(limit), 200)) : 16;
    const documents = await paperlessService.getRecentDocumentsWithMetadata(safeLimit);

    const tagIds = documents.flatMap((document) => Array.isArray(document.tags) ? document.tags : []);
    const correspondentIds = documents
      .map((document) => Number(document.correspondent))
      .filter(Number.isInteger);

    const [tagNames, correspondentNames] = await Promise.all([
      this.getTagNames(tagIds),
      this.getCorrespondentNames(correspondentIds)
    ]);

    const paperlessUrl = await paperlessService.getPublicBaseUrl();

    return {
      documents,
      tagNames,
      correspondentNames,
      paperlessUrl
    };
  }

}

module.exports = new DocumentsService();