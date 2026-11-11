const fs = require('fs').promises;
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('./thumbnailCachePaths');

/**
 * Cache a document's Paperless-ngx thumbnail for the UI.
 *
 * Best effort by contract: the thumbnail never enters the AI prompt, so no
 * outcome of this step may decide whether the document gets analysed. All four
 * AI services used to let it decide, each in its own way — an id that
 * getThumbnailCachePath() rejects threw straight out of analyzeDocument()
 * (which the scan loop does not expect, and which answered 500 on every
 * POST /manual/analyze without an id), a thumbnail Paperless did not have
 * returned `undefined` from it, and an unreachable Paperless turned into an
 * analysis failure. One implementation for all four keeps them from drifting
 * apart again.
 *
 * @param {string|number} id - Paperless-ngx document ID
 * @returns {Promise<boolean>} true when a thumbnail is cached afterwards
 */
async function cacheThumbnail(id) {
  let cachePath;
  try {
    cachePath = getThumbnailCachePath(id);
  } catch (error) {
    console.warn(
      `[WARNING] Skipping thumbnail cache for document ${JSON.stringify(id)}: ${error.message}`
    );
    return false;
  }

  try {
    await fs.access(cachePath);
    console.log('[DEBUG] Thumbnail already cached');
    return true;
  } catch {
    console.log('Thumbnail not cached, fetching from Paperless');
  }

  try {
    // Required here rather than at module load: paperlessService reaches back
    // into aiServiceFactory, and the AI services are what call this.
    const paperlessService = require('./paperlessService');
    const thumbnailData = await paperlessService.getThumbnailImage(id);

    if (!thumbnailData) {
      console.warn('Thumbnail not found');
      return false;
    }

    await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
    await fs.writeFile(cachePath, thumbnailData);
    return true;
  } catch (error) {
    console.warn(`[WARNING] Thumbnail caching failed: ${error.message}`);
    return false;
  }
}

module.exports = { cacheThumbnail };
