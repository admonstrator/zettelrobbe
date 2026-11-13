/**
 * Reads and empties the `entity_name_mappings` table of a test database.
 *
 * models/document.js only writes this table (addEntityNameMapping, called by
 * the creation guard in services/paperlessService.js); nothing in the app
 * reads it any more. A test that wants to see what the guard recorded opens
 * the throwaway database itself through here, so the model carries no reader
 * that only tests call.
 *
 * `dataDir` is the `data` folder of the throwaway working directory, the one
 * models/document.js created `documents.db` in.
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

/** Rows models/document.js keeps; a `limit` above it changes nothing. */
const KEPT = 200;

/**
 * @template T
 * @param {string} dataDir
 * @param {(db: import('better-sqlite3').Database) => T} fn
 * @returns {T}
 */
function withDatabase(dataDir, fn) {
  const db = new Database(path.join(dataDir, 'documents.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * The newest mappings first, at most `limit`.
 *
 * @param {string} dataDir
 * @param {{ limit?: number }} [options]
 */
function listEntityNameMappings(dataDir, { limit = KEPT } = {}) {
  return withDatabase(dataDir, (db) =>
    db
      .prepare('SELECT * FROM entity_name_mappings ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Number(limit) || KEPT))
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        proposedName: row.proposed_name,
        targetId: row.target_id,
        targetName: row.target_name,
        reason: row.reason,
        score: Number(row.score) || 0,
        documentId: row.document_id ?? null,
        createdAt: row.created_at,
      }))
  );
}

/**
 * Deletes every mapping.
 *
 * @param {string} dataDir
 * @returns {number} rows removed
 */
function clearEntityNameMappings(dataDir) {
  return withDatabase(
    dataDir,
    (db) => db.prepare('DELETE FROM entity_name_mappings').run().changes
  );
}

module.exports = { listEntityNameMappings, clearEntityNameMappings };
