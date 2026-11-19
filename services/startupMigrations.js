const fs = require('fs').promises;
const path = require('path');
const { LEGACY_PUBLIC_THUMBNAIL_CACHE_DIR } = require('./thumbnailCachePaths');

const STARTUP_MIGRATION_STATE_PATH = path.join(
  process.cwd(),
  'data',
  'migrations',
  'startup-migrations.json'
);

const STARTUP_MIGRATION_STEPS = [
  {
    id: 'SEC-THUMB-001',
    description: 'Remove legacy thumbnail cache files from public/images',
    // Keep this step contract stable so it can be reused by a future centralized update routine.
    run: runLegacyPublicThumbnailCacheCleanup,
  },
];

function createEmptyMigrationState() {
  return {
    schemaVersion: 1,
    completed: {},
  };
}

async function loadMigrationState(logger = console) {
  try {
    const content = await fs.readFile(STARTUP_MIGRATION_STATE_PATH, 'utf8');
    const parsed = JSON.parse(content);

    if (!parsed || typeof parsed !== 'object') {
      return createEmptyMigrationState();
    }

    return {
      schemaVersion: Number.isInteger(parsed.schemaVersion)
        ? parsed.schemaVersion
        : 1,
      completed:
        parsed.completed && typeof parsed.completed === 'object'
          ? parsed.completed
          : {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(
        '[MIGRATION] Failed to load startup migration state:',
        error.message
      );
    }
    return createEmptyMigrationState();
  }
}

async function saveMigrationState(state, logger = console) {
  try {
    await fs.mkdir(path.dirname(STARTUP_MIGRATION_STATE_PATH), {
      recursive: true,
    });
    await fs.writeFile(
      STARTUP_MIGRATION_STATE_PATH,
      JSON.stringify(state, null, 2),
      'utf8'
    );
    return true;
  } catch (error) {
    logger.warn(
      '[MIGRATION] Failed to persist startup migration state:',
      error.message
    );
    return false;
  }
}

async function runLegacyPublicThumbnailCacheCleanup(logger = console) {
  let entries;

  try {
    entries = await fs.readdir(LEGACY_PUBLIC_THUMBNAIL_CACHE_DIR, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        legacyCacheFound: false,
        removedFiles: 0,
        failedFiles: 0,
        removedLegacyDirectory: false,
      };
    }

    throw error;
  }

  const legacyFiles = entries
    .filter((entry) => entry.isFile() && /^\d+\.png$/i.test(entry.name))
    .map((entry) => path.join(LEGACY_PUBLIC_THUMBNAIL_CACHE_DIR, entry.name));

  let removedFiles = 0;
  let failedFiles = 0;

  for (const filePath of legacyFiles) {
    try {
      await fs.unlink(filePath);
      removedFiles += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        failedFiles += 1;
        logger.warn(
          `[MIGRATION] Failed to remove legacy thumbnail cache file ${filePath}:`,
          error.message
        );
      }
    }
  }

  let removedLegacyDirectory = false;
  try {
    const remainingEntries = await fs.readdir(
      LEGACY_PUBLIC_THUMBNAIL_CACHE_DIR
    );
    if (remainingEntries.length === 0) {
      await fs.rm(LEGACY_PUBLIC_THUMBNAIL_CACHE_DIR, {
        recursive: false,
        force: false,
      });
      removedLegacyDirectory = true;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(
        '[MIGRATION] Failed to remove legacy thumbnail cache directory:',
        error.message
      );
    }
  }

  return {
    legacyCacheFound: legacyFiles.length > 0,
    removedFiles,
    failedFiles,
    removedLegacyDirectory,
  };
}

async function runStartupMigrations(logger = console) {
  const state = await loadMigrationState(logger);
  const summary = [];

  for (const step of STARTUP_MIGRATION_STEPS) {
    if (state.completed[step.id]) {
      logger.log(`[MIGRATION] ${step.id} already applied, skipping.`);
      summary.push({ id: step.id, status: 'skipped' });
      continue;
    }

    logger.log(`[MIGRATION] Running ${step.id}: ${step.description}`);

    try {
      const result = await step.run(logger);
      state.completed[step.id] = {
        appliedAt: new Date().toISOString(),
        result,
      };

      await saveMigrationState(state, logger);

      logger.log(
        `[MIGRATION] ${step.id} applied. Removed files: ${result.removedFiles || 0}, failed files: ${result.failedFiles || 0}.`
      );

      summary.push({ id: step.id, status: 'applied', result });
    } catch (error) {
      logger.warn(`[MIGRATION] ${step.id} failed:`, error.message);
      summary.push({ id: step.id, status: 'failed', error: error.message });
    }
  }

  return summary;
}

module.exports = {
  STARTUP_MIGRATION_STATE_PATH,
  STARTUP_MIGRATION_STEPS,
  runStartupMigrations,
};
