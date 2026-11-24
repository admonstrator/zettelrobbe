const fs = require('fs').promises;
const path = require('path');
const { LEGACY_PUBLIC_THUMBNAIL_CACHE_DIR } = require('./thumbnailCachePaths');
const config = require('../config/config');
const setupService = require('./setupService');
const {
  DEFAULT_OCR_TIMEOUT_MS,
  OLD_FORM_OCR_TIMEOUT_MS,
  isOldFormOcrTimeout,
} = require('./ocrTimeout');

const OCR_TIMEOUT_KEY = 'SETUP_OCR_VALIDATION_TIMEOUT_MS';
/** Milliseconds as whole seconds, for a log line. */
const seconds = (ms) => Math.round(ms / 1000);

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
  {
    id: 'CFG-OCR-TIMEOUT-001',
    description: `Raise a stored OCR timeout of ${seconds(OLD_FORM_OCR_TIMEOUT_MS)} seconds, the old form default, to ${seconds(DEFAULT_OCR_TIMEOUT_MS)} seconds`,
    run: runOcrTimeoutRaise,
    // A raise has its own line, which says what happened.
    summarize: (result) => {
      if (result.raised) return '';
      return result.setByEnvironment
        ? 'The environment sets the OCR timeout, left as it is.'
        : 'No stored OCR timeout to raise.';
    },
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

/**
 * CFG-OCR-TIMEOUT-001: a stored OCR timeout of exactly 30000 ms becomes the
 * default (services/ocrTimeout.js).
 *
 * Before 2b53422 the settings form, the setup wizard and every save wrote
 * SETUP_OCR_VALIDATION_TIMEOUT_MS=30000, chosen or not, and since 1572d36 the
 * key also governs document OCR, which had waited 120 seconds. Like every
 * step here it runs once, so 30 seconds set after it stay.
 *
 * The value is read and written where a save keeps it (setupService):
 * data/runtime-overrides.json, in legacy mode data/.env as well, and
 * process.env, so the first OCR request after the start waits the default.
 * A value the environment sets is left alone, as every save leaves it; for
 * 30000 the log says what to do. SETUP_VALIDATION_TIMEOUT_MS, the key OCR
 * falls back to, is not touched.
 *
 * @param {Console} logger
 * @returns {Promise<{ raised: boolean, setByEnvironment?: boolean }>}
 */
async function runOcrTimeoutRaise(logger = console) {
  const oldSeconds = seconds(OLD_FORM_OCR_TIMEOUT_MS);

  if (config.isProtectedRuntimeEnvKey(OCR_TIMEOUT_KEY)) {
    if (isOldFormOcrTimeout(process.env[OCR_TIMEOUT_KEY])) {
      logger.warn(
        `[WARN] ${OCR_TIMEOUT_KEY}=${OLD_FORM_OCR_TIMEOUT_MS} is set by the environment, so OCR waits ${oldSeconds} seconds per request. ` +
          `${OLD_FORM_OCR_TIMEOUT_MS} was the old default of the settings form; the default is now ${DEFAULT_OCR_TIMEOUT_MS}. ` +
          `Remove the variable from the environment (docker-compose environment:) to get the default, or keep it if you want ${oldSeconds} seconds.`
      );
    }
    return { raised: false, setByEnvironment: true };
  }

  const stored = (await setupService.loadConfig()) || {};
  if (!isOldFormOcrTimeout(stored[OCR_TIMEOUT_KEY])) {
    return { raised: false };
  }

  await setupService.updateConfigValues({
    [OCR_TIMEOUT_KEY]: String(DEFAULT_OCR_TIMEOUT_MS),
  });
  logger.log(
    `[INFO] OCR timeout raised from ${oldSeconds} to ${seconds(DEFAULT_OCR_TIMEOUT_MS)} seconds: ` +
      `${oldSeconds} was the old default of the settings form, and every save wrote it down. ` +
      `To keep ${oldSeconds} seconds, set it again under Settings > OCR > OCR timeout.`
  );
  return { raised: true };
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

      const detail =
        typeof step.summarize === 'function'
          ? step.summarize(result)
          : `Removed files: ${result.removedFiles || 0}, failed files: ${result.failedFiles || 0}.`;
      logger.log(
        `[MIGRATION] ${step.id} applied.${detail ? ` ${detail}` : ''}`
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
