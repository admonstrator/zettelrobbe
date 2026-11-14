// @ts-check
'use strict';

/**
 * Maintenance of the thumbnail cache in data/thumb-cache: its size, clearing
 * it, and dropping the thumbnails of documents that are processed again.
 * The paths themselves come from thumbnailCachePaths.js.
 */

const fs = require('fs').promises;
const path = require('path');
const { THUMBNAIL_CACHE_DIR } = require('./thumbnailCachePaths');

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

module.exports = {
  formatBytes,
  getThumbnailCacheStats,
  clearThumbnailCache,
  removeThumbnailCacheForDocumentIds,
};
