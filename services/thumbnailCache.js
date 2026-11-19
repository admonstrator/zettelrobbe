// @ts-check
'use strict';

/**
 * The thumbnail cache in data/thumb-cache: filling it for the UI while a
 * document is analysed, its size, clearing it, and dropping the thumbnails of
 * documents that are processed again. The paths themselves come from
 * thumbnailCachePaths.js.
 */

const fs = require('fs').promises;
const path = require('path');
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('./thumbnailCachePaths');

/** A cached thumbnail is named `<document id>.png`; nothing else is touched. */
const THUMBNAIL_FILE_PATTERN = /^\d+\.png$/i;

/**
 * @param {unknown} error
 * @returns {string|undefined} the Node error code, if any
 */
function errorCode(error) {
  return /** @type {NodeJS.ErrnoException} */ (error)?.code;
}

/**
 * @param {unknown} error
 * @returns {string} the error message, if any
 */
function errorMessage(error) {
  return /** @type {Error} */ (error)?.message;
}

/**
 * @param {number} bytes
 * @returns {string} e.g. "1.50 MB"
 */
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safeBytes === 0) {
    return '0 B';
  }

  const unitIndex = Math.min(
    Math.floor(Math.log(safeBytes) / Math.log(1024)),
    units.length - 1
  );
  const value = safeBytes / 1024 ** unitIndex;
  const decimals = unitIndex === 0 ? 0 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

/**
 * @returns {Promise<{ fileCount: number, totalBytes: number, totalSizeHuman: string }>}
 */
async function getThumbnailCacheStats() {
  try {
    const entries = await fs.readdir(THUMBNAIL_CACHE_DIR, {
      withFileTypes: true,
    });
    let fileCount = 0;
    let totalBytes = 0;

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      if (!THUMBNAIL_FILE_PATTERN.test(entry.name)) {
        continue;
      }

      const filePath = path.join(THUMBNAIL_CACHE_DIR, entry.name);
      try {
        const stat = await fs.stat(filePath);
        totalBytes += stat.size;
        fileCount += 1;
      } catch (statError) {
        console.warn(
          `[WARN] Failed to read thumbnail cache file stats for ${filePath}:`,
          errorMessage(statError)
        );
      }
    }

    return {
      fileCount,
      totalBytes,
      totalSizeHuman: formatBytes(totalBytes),
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {
        fileCount: 0,
        totalBytes: 0,
        totalSizeHuman: '0 B',
      };
    }
    throw error;
  }
}

/**
 * @returns {Promise<{ removedFiles: number, freedBytes: number, freedSizeHuman: string }>}
 */
async function clearThumbnailCache() {
  try {
    const entries = await fs.readdir(THUMBNAIL_CACHE_DIR, {
      withFileTypes: true,
    });
    let removedFiles = 0;
    let freedBytes = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !THUMBNAIL_FILE_PATTERN.test(entry.name)) {
        continue;
      }

      const filePath = path.join(THUMBNAIL_CACHE_DIR, entry.name);
      let fileSize = 0;

      try {
        const stat = await fs.stat(filePath);
        fileSize = stat.size;
      } catch (statError) {
        if (errorCode(statError) !== 'ENOENT') {
          console.warn(
            `[WARN] Failed to stat thumbnail file before delete ${filePath}:`,
            errorMessage(statError)
          );
        }
      }

      try {
        await fs.unlink(filePath);
        removedFiles += 1;
        freedBytes += fileSize;
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== 'ENOENT') {
          console.warn(
            `[WARN] Failed to delete thumbnail cache file ${filePath}:`,
            errorMessage(unlinkError)
          );
        }
      }
    }

    return {
      removedFiles,
      freedBytes,
      freedSizeHuman: formatBytes(freedBytes),
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {
        removedFiles: 0,
        freedBytes: 0,
        freedSizeHuman: '0 B',
      };
    }
    throw error;
  }
}

/**
 * Deletes the cached thumbnails of the given documents. Ids that are not
 * plain positive numbers are ignored.
 *
 * @param {unknown} ids - document ids
 * @returns {Promise<{ removedFiles: number, removedIds: string[] }>}
 */
async function removeThumbnailCacheForDocumentIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { removedFiles: 0, removedIds: [] };
  }

  const normalizedIds = ids
    .map((id) => String(id).trim())
    .filter((id) => /^\d+$/.test(id));

  if (normalizedIds.length === 0) {
    return { removedFiles: 0, removedIds: [] };
  }

  let removedFiles = 0;
  /** @type {string[]} */
  const removedIds = [];

  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });

  for (const id of normalizedIds) {
    const thumbnailPath = path.join(THUMBNAIL_CACHE_DIR, `${id}.png`);
    try {
      await fs.unlink(thumbnailPath);
      removedFiles += 1;
      removedIds.push(id);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        console.warn(
          '[WARN] Failed to delete cached thumbnail %s:',
          thumbnailPath,
          errorMessage(error)
        );
      }
    }
  }

  return { removedFiles, removedIds };
}

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
      `[WARNING] Skipping thumbnail cache for document ${JSON.stringify(id)}: ${errorMessage(error)}`
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
    console.warn(`[WARNING] Thumbnail caching failed: ${errorMessage(error)}`);
    return false;
  }
}

module.exports = {
  cacheThumbnail,
  formatBytes,
  getThumbnailCacheStats,
  clearThumbnailCache,
  removeThumbnailCacheForDocumentIds,
};
