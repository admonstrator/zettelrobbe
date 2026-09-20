// models/document.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

try {
  fs.accessSync(dataDir, fs.constants.W_OK);
} catch (error) {
  throw new Error(
    `Data directory is not writable: ${dataDir}. Check container volume permissions. Original error: ${error.message}`,
    { cause: error }
  );
}

// Initialize database with WAL mode for better performance
const db = new Database(path.join(dataDir, 'documents.db'), {
  //verbose: console.log
});
db.pragma('journal_mode = WAL');

// Create tables
const createTableMain = db.prepare(`
  CREATE TABLE IF NOT EXISTS processed_documents (
    id INTEGER PRIMARY KEY,
    document_id INTEGER UNIQUE,
    title TEXT,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
createTableMain.run();

const createTableMetrics = db.prepare(`
  CREATE TABLE IF NOT EXISTS openai_metrics (
    id INTEGER PRIMARY KEY,
    document_id INTEGER,
    promptTokens INTEGER,
    completionTokens INTEGER,
    totalTokens INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
createTableMetrics.run();

const createTableHistory = db.prepare(`
  CREATE TABLE IF NOT EXISTS history_documents (
    id INTEGER PRIMARY KEY,
    document_id INTEGER,
    tags TEXT,
    title TEXT,
    correspondent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
createTableHistory.run();

const createOriginalDocuments = db.prepare(`
  CREATE TABLE IF NOT EXISTS original_documents (
    id INTEGER PRIMARY KEY,
    document_id INTEGER,
    title TEXT,
    tags TEXT,
    correspondent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
createOriginalDocuments.run();

const userTable = db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
userTable.run();

// Prepare statements for better performance
const insertDocument = db.prepare(`
  INSERT INTO processed_documents (document_id, title) 
  VALUES (?, ?)
  ON CONFLICT(document_id) DO UPDATE SET
    last_updated = CURRENT_TIMESTAMP
  WHERE document_id = ?
`);

const findDocument = db.prepare(
  'SELECT * FROM processed_documents WHERE document_id = ?'
);

const insertMetrics = db.prepare(`
  INSERT INTO openai_metrics (document_id, promptTokens, completionTokens, totalTokens)
  VALUES (?, ?, ?, ?)
`);

// The dashboard only needs the aggregates, never the rows. COALESCE keeps rows
// with a missing token count in the denominator, which is what the previous
// JavaScript reduce did when it added `undefined` as 0.
const selectMetricsSummary = db.prepare(`
  SELECT
    COUNT(*) as sampleCount,
    AVG(COALESCE(promptTokens, 0)) as avgPromptTokens,
    AVG(COALESCE(completionTokens, 0)) as avgCompletionTokens,
    AVG(COALESCE(totalTokens, 0)) as avgTotalTokens,
    COALESCE(SUM(COALESCE(totalTokens, 0)), 0) as totalTokensOverall
  FROM openai_metrics
`);

const emptyMetricsSummary = () => ({
  averagePromptTokens: 0,
  averageCompletionTokens: 0,
  averageTotalTokens: 0,
  tokensOverall: 0,
});

const insertUser = db.prepare(`
  INSERT INTO users (username, password)
  VALUES (?, ?)
`);

// Add these prepared statements with your other ones at the top
const getHistoryDocumentsCount = db.prepare(`
  SELECT COUNT(*) as count FROM history_documents
`);

const getPaginatedHistoryDocuments = db.prepare(`
  SELECT * FROM history_documents 
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

// Prepared statement for filtered/sorted history with pagination
const getHistoryPaginatedFiltered = db.prepare(`
  SELECT * FROM history_documents
  WHERE 1=1
    AND (? = '' OR title LIKE ? OR correspondent LIKE ?)
    AND (? = '' OR tags LIKE ?)
    AND (? = '' OR correspondent = ?)
  ORDER BY 
    CASE WHEN ? = 'document_id' AND ? = 'asc' THEN document_id END ASC,
    CASE WHEN ? = 'document_id' AND ? = 'desc' THEN document_id END DESC,
    CASE WHEN ? = 'title' AND ? = 'asc' THEN title END ASC,
    CASE WHEN ? = 'title' AND ? = 'desc' THEN title END DESC,
    CASE WHEN ? = 'correspondent' AND ? = 'asc' THEN correspondent END ASC,
    CASE WHEN ? = 'correspondent' AND ? = 'desc' THEN correspondent END DESC,
    CASE WHEN ? = 'created_at' AND ? = 'asc' THEN created_at END ASC,
    CASE WHEN ? = 'created_at' AND ? = 'desc' THEN created_at END DESC,
    created_at DESC
  LIMIT ? OFFSET ?
`);

const getHistoryCountFiltered = db.prepare(`
  SELECT COUNT(*) as count FROM history_documents
  WHERE 1=1
    AND (? = '' OR title LIKE ? OR correspondent LIKE ?)
    AND (? = '' OR tags LIKE ?)
    AND (? = '' OR correspondent = ?)
`);

const getDistinctCorrespondents = db.prepare(`
  SELECT DISTINCT correspondent FROM history_documents
  WHERE correspondent IS NOT NULL AND correspondent != ''
  ORDER BY correspondent
`);

const createProcessingStatus = db.prepare(`
  CREATE TABLE IF NOT EXISTS processing_status (
    id INTEGER PRIMARY KEY,
    document_id INTEGER UNIQUE,
    title TEXT,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT
  );
`);
createProcessingStatus.run();

// ─── DB Migration System ──────────────────────────────────────────────────────
// Uses SQLite PRAGMA user_version to track schema version.
// Each migration runs exactly once and is applied in order.
// To add a new migration: append an entry to MIGRATIONS with the next version number.
const MIGRATIONS = [
  {
    version: 1,
    description: 'Add custom_fields column to history_documents',
    up: (database) => {
      database.exec(
        "ALTER TABLE history_documents ADD COLUMN custom_fields TEXT DEFAULT '[]'"
      );
    },
  },
  {
    version: 2,
    description:
      'Add document_type_name and language to history_documents; add document_type and language to original_documents',
    up: (database) => {
      database.exec(
        'ALTER TABLE history_documents ADD COLUMN document_type_name TEXT DEFAULT NULL'
      );
      database.exec(
        'ALTER TABLE history_documents ADD COLUMN language TEXT DEFAULT NULL'
      );
      database.exec(
        'ALTER TABLE original_documents ADD COLUMN document_type INTEGER DEFAULT NULL'
      );
      database.exec(
        'ALTER TABLE original_documents ADD COLUMN language TEXT DEFAULT NULL'
      );
    },
  },
  {
    version: 3,
    description: 'Create ocr_queue table for Mistral OCR processing',
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ocr_queue (
          id INTEGER PRIMARY KEY,
          document_id INTEGER UNIQUE,
          title TEXT,
          reason TEXT DEFAULT 'manual',
          status TEXT DEFAULT 'pending',
          ocr_text TEXT DEFAULT NULL,
          added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          processed_at DATETIME DEFAULT NULL
        )
      `);
    },
  },
  {
    version: 4,
    description:
      'Create failed_documents table for terminally failed processing items',
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS failed_documents (
          id INTEGER PRIMARY KEY,
          document_id INTEGER UNIQUE,
          title TEXT,
          failed_reason TEXT,
          source TEXT DEFAULT 'ai',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: 5,
    description: 'Add MFA columns to users table',
    up: (database) => {
      const userColumns = database.prepare("PRAGMA table_info('users')").all();
      const hasMfaEnabled = userColumns.some(
        (col) => col.name === 'mfa_enabled'
      );
      const hasMfaSecret = userColumns.some((col) => col.name === 'mfa_secret');

      if (!hasMfaEnabled) {
        database.exec(
          'ALTER TABLE users ADD COLUMN mfa_enabled INTEGER DEFAULT 0'
        );
      }

      if (!hasMfaSecret) {
        database.exec(
          'ALTER TABLE users ADD COLUMN mfa_secret TEXT DEFAULT NULL'
        );
      }
    },
  },
  {
    version: 6,
    description: 'Add last_seen_changelog_version column to users table',
    up: (database) => {
      const userColumns = database.prepare("PRAGMA table_info('users')").all();
      const hasColumn = userColumns.some(
        (col) => col.name === 'last_seen_changelog_version'
      );
      if (!hasColumn) {
        database.exec(
          'ALTER TABLE users ADD COLUMN last_seen_changelog_version TEXT DEFAULT NULL'
        );
      }
    },
  },
  {
    version: 7,
    description:
      'Deduplicate history_documents and enforce one entry per document_id',
    up: (database) => {
      // Remove duplicate history rows that accumulated because addToHistory()
      // used a plain INSERT with no uniqueness on document_id. Keep only the
      // newest row (highest id) per document_id; no document is lost.
      database.exec(`
        DELETE FROM history_documents
        WHERE id NOT IN (
          SELECT MAX(id) FROM history_documents GROUP BY document_id
        )
      `);
      // Prevent future duplicates and enable the UPSERT in addToHistory().
      database.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_history_documents_document_id ON history_documents(document_id)'
      );
    },
  },
  {
    version: 8,
    description:
      'Create ignored_documents table for user-permanently-ignored documents',
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ignored_documents (
          id INTEGER PRIMARY KEY,
          document_id INTEGER UNIQUE,
          title TEXT,
          reason TEXT DEFAULT 'manual',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: 9,
    description: 'Add dashboard_layout column to users table',
    up: (database) => {
      const userColumns = database.prepare("PRAGMA table_info('users')").all();
      const hasColumn = userColumns.some(
        (col) => col.name === 'dashboard_layout'
      );
      if (!hasColumn) {
        database.exec(
          'ALTER TABLE users ADD COLUMN dashboard_layout TEXT DEFAULT NULL'
        );
      }
    },
  },
  {
    version: 10,
    description: 'Add wrote_back column to ocr_queue',
    up: (database) => {
      // Records whether the OCR text reached Paperless-ngx. A finished item
      // whose text was accepted is deleted from the queue, so from here on a
      // surviving 'done' row means the text exists nowhere but here. Rows that
      // completed before this migration keep NULL: their outcome was never
      // recorded and cannot be reconstructed without asking Paperless-ngx for
      // every one of them.
      const queueColumns = database
        .prepare("PRAGMA table_info('ocr_queue')")
        .all();
      const hasColumn = queueColumns.some((col) => col.name === 'wrote_back');
      if (!hasColumn) {
        database.exec(
          'ALTER TABLE ocr_queue ADD COLUMN wrote_back INTEGER DEFAULT NULL'
        );
      }
    },
  },
  {
    version: 11,
    description:
      'Create entity_merges and entity_merge_dismissals for the Duplicates page',
    up: (database) => {
      // One row per merge run. The JSON columns carry everything an undo
      // needs: the objects a merge deletes no longer exist in Paperless-ngx
      // afterwards, so their names, matching rules and document lists have
      // to be kept here.
      database.exec(`
        CREATE TABLE IF NOT EXISTS entity_merges (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL,
          target_id INTEGER NOT NULL,
          target_name TEXT NOT NULL,
          target_before TEXT DEFAULT NULL,
          sources TEXT NOT NULL DEFAULT '[]',
          documents_moved INTEGER NOT NULL DEFAULT 0,
          copied_matching_rule INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'done',
          performed_by TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          undone_at DATETIME DEFAULT NULL,
          undo_result TEXT DEFAULT NULL
        )
      `);
      // Pairs the user marked as "not a duplicate". Stored with the lower id
      // first so the same pair can only exist once whichever way it was sent.
      database.exec(`
        CREATE TABLE IF NOT EXISTS entity_merge_dismissals (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL,
          id_a INTEGER NOT NULL,
          id_b INTEGER NOT NULL,
          name_a TEXT DEFAULT NULL,
          name_b TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(kind, id_a, id_b)
        )
      `);
    },
  },
  {
    version: 12,
    description:
      'Duplicates round 9: merge log actions and renames, name mappings, AI calibration',
    up: (database) => {
      // A log row is a merge unless it says otherwise: deleting unused
      // objects goes through the same log so it can be undone the same way.
      database.exec(
        "ALTER TABLE entity_merges ADD COLUMN action TEXT NOT NULL DEFAULT 'merge'"
      );
      // The target's name before a merge renamed it, so an undo can put it
      // back; null when the merge did not rename.
      database.exec(
        'ALTER TABLE entity_merges ADD COLUMN target_renamed_from TEXT DEFAULT NULL'
      );
      // Every time document analysis proposed a name and the guard used an
      // existing object instead. Kept short (the newest rows) and shown on
      // the Duplicates page, so a wrong mapping can be noticed.
      database.exec(`
        CREATE TABLE IF NOT EXISTS entity_name_mappings (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL,
          proposed_name TEXT NOT NULL,
          target_id INTEGER NOT NULL,
          target_name TEXT NOT NULL,
          reason TEXT NOT NULL,
          score REAL NOT NULL DEFAULT 0,
          document_id INTEGER DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // What the AI judge measured about a model, so the first review after
      // a restart is already sized.
      database.exec(`
        CREATE TABLE IF NOT EXISTS ai_calibration (
          model TEXT NOT NULL,
          thinking INTEGER NOT NULL DEFAULT 0,
          tokens_per_pair REAL DEFAULT NULL,
          tokens_per_second REAL DEFAULT NULL,
          largest_completion INTEGER NOT NULL DEFAULT 0,
          measured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (model, thinking)
        )
      `);
    },
  },
  {
    version: 13,
    description:
      'Duplicates round 10: split rows in the merge log, the tag vocabulary, split proposals, remembered verdicts',
    up: (database) => {
      // What a split did, per document, so an undo can put exactly that back:
      // the tags it added and the document type it set. Null for merges and
      // deletes, which carry everything in sources.
      database.exec(
        'ALTER TABLE entity_merges ADD COLUMN details TEXT DEFAULT NULL'
      );
      // The target vocabulary of "Simplify tags": document types (dimension
      // 'type') and topic tags (dimension 'topic') the archive should end up
      // with. paperless_id is filled once the object exists in Paperless-ngx.
      database.exec(`
        CREATE TABLE IF NOT EXISTS tag_vocabulary (
          id INTEGER PRIMARY KEY,
          dimension TEXT NOT NULL,
          name TEXT NOT NULL,
          paperless_id INTEGER DEFAULT NULL,
          source TEXT NOT NULL DEFAULT 'user',
          position INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (dimension, name)
        )
      `);
      // One proposal per tag: which document type and which topic tags the
      // tag stands for. Kept until the next run replaces them, so the user
      // can work through a long list over several sessions.
      database.exec(`
        CREATE TABLE IF NOT EXISTS tag_split_proposals (
          tag_id INTEGER PRIMARY KEY,
          tag_name TEXT NOT NULL,
          document_count INTEGER NOT NULL DEFAULT 0,
          type_name TEXT DEFAULT NULL,
          topic_names TEXT NOT NULL DEFAULT '[]',
          source TEXT NOT NULL DEFAULT 'rule',
          confidence TEXT DEFAULT NULL,
          reason TEXT DEFAULT NULL,
          documents_with_type INTEGER NOT NULL DEFAULT 0,
          overwrite_type INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // What the AI judge decided about a pair of names, so the next review
      // does not ask the same question again while both names are unchanged.
      database.exec(`
        CREATE TABLE IF NOT EXISTS ai_pair_verdicts (
          kind TEXT NOT NULL,
          pair_key TEXT NOT NULL,
          name_a TEXT NOT NULL,
          name_b TEXT NOT NULL,
          verdict TEXT NOT NULL,
          basis TEXT DEFAULT NULL,
          confidence TEXT DEFAULT NULL,
          reason TEXT DEFAULT NULL,
          model TEXT DEFAULT NULL,
          judged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (kind, pair_key)
        )
      `);
    },
  },
];

/** Newest rows the name-mapping list keeps; older ones are pruned on insert. */
const ENTITY_NAME_MAPPINGS_KEEP = 200;

function runMigrations(database) {
  const currentVersion = database.pragma('user_version', { simple: true });
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    console.log(`[DB Migration] Schema is up to date at v${currentVersion}`);
    return;
  }

  for (const migration of pending) {
    console.log(
      `[DB Migration] Running migration v${migration.version}: ${migration.description}`
    );
    const applyMigration = database.transaction(() => {
      migration.up(database);
      database.pragma(`user_version = ${migration.version}`);
    });
    applyMigration();
    console.log(
      `[DB Migration] Migration v${migration.version} completed successfully`
    );
  }
}

runMigrations(db);
// ─────────────────────────────────────────────────────────────────────────────

// Add with your other prepared statements
const upsertProcessingStatus = db.prepare(`
  INSERT INTO processing_status (document_id, title, status)
  VALUES (?, ?, ?)
  ON CONFLICT(document_id) DO UPDATE SET
    status = excluded.status,
    start_time = CURRENT_TIMESTAMP
  WHERE document_id = excluded.document_id
`);

const clearProcessingStatus = db.prepare(`
  DELETE FROM processing_status WHERE document_id = ?
`);

const getActiveProcessing = db.prepare(`
  SELECT * FROM processing_status 
  WHERE start_time >= datetime('now', '-30 seconds')
  ORDER BY start_time DESC LIMIT 1
`);

// Rows of entity_merges carry JSON columns; every reader gets them parsed and
// in camelCase so the route can hand them to the page as they are.
function parseJsonColumn(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseEntityMergeRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    targetName: row.target_name,
    targetBefore: parseJsonColumn(row.target_before, null),
    sources: parseJsonColumn(row.sources, []),
    documentsMoved: row.documents_moved,
    copiedMatchingRule: Boolean(row.copied_matching_rule),
    status: row.status,
    performedBy: row.performed_by,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
    undoResult: parseJsonColumn(row.undo_result, null),
    action: row.action || 'merge',
    targetRenamedFrom: row.target_renamed_from ?? null,
    details: parseJsonColumn(row.details, null),
  };
}

/** Actions a merge-log row can record. */
const ENTITY_MERGE_ACTIONS = ['merge', 'delete', 'split'];

function parseTagVocabularyRow(row) {
  return {
    id: row.id,
    dimension: row.dimension,
    name: row.name,
    paperlessId: row.paperless_id ?? null,
    source: row.source || 'user',
    position: Number(row.position) || 0,
    createdAt: row.created_at,
  };
}

function parseTagSplitProposalRow(row) {
  return {
    tagId: row.tag_id,
    tagName: row.tag_name,
    documentCount: Number(row.document_count) || 0,
    typeName: row.type_name ?? null,
    topicNames: parseJsonColumn(row.topic_names, []),
    source: row.source || 'rule',
    confidence: row.confidence ?? null,
    reason: row.reason ?? null,
    documentsWithType: Number(row.documents_with_type) || 0,
    overwriteType: Boolean(row.overwrite_type),
    status: row.status || 'open',
    updatedAt: row.updated_at,
  };
}

function parseAiPairVerdictRow(row) {
  return {
    kind: row.kind,
    pairKey: row.pair_key,
    nameA: row.name_a,
    nameB: row.name_b,
    verdict: row.verdict,
    basis: row.basis ?? null,
    confidence: row.confidence ?? null,
    reason: row.reason ?? null,
    model: row.model ?? null,
    judgedAt: row.judged_at,
  };
}

function parseEntityNameMappingRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    proposedName: row.proposed_name,
    targetId: row.target_id,
    targetName: row.target_name,
    reason: row.reason,
    score: Number(row.score) || 0,
    documentId: row.document_id ?? null,
    createdAt: row.created_at,
  };
}

module.exports = {
  async addProcessedDocument(documentId, title) {
    try {
      // Bei UNIQUE constraint failure wird der existierende Eintrag aktualisiert
      const result = insertDocument.run(documentId, title, documentId);
      if (result.changes > 0) {
        console.log(
          `[DEBUG] Document ${title} ${result.lastInsertRowid ? 'added to' : 'updated in'} processed_documents`
        );
        return true;
      }
      return false;
    } catch (error) {
      // Log error but don't throw
      console.error('[ERROR] adding document:', error);
      return false;
    }
  },

  async addOpenAIMetrics(
    documentId,
    promptTokens,
    completionTokens,
    totalTokens
  ) {
    try {
      const result = insertMetrics.run(
        documentId,
        promptTokens,
        completionTokens,
        totalTokens
      );
      if (result.changes > 0) {
        console.log(`[DEBUG] Metrics added for document ${documentId}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[ERROR] adding metrics:', error);
      return false;
    }
  },

  /**
   * Token averages and the overall total, aggregated by SQLite.
   *
   * Replaces `getMetrics()`, which materialized every openai_metrics row just
   * so the dashboard could reduce over it four times. The table grows with
   * every processed document; these four numbers do not.
   */
  async getMetricsSummary() {
    try {
      const row = selectMetricsSummary.get();
      if (!row || !row.sampleCount) {
        return emptyMetricsSummary();
      }

      return {
        // Rounded here rather than in SQL so the values stay bit-for-bit what
        // Math.round() produced before.
        averagePromptTokens: Math.round(row.avgPromptTokens || 0),
        averageCompletionTokens: Math.round(row.avgCompletionTokens || 0),
        averageTotalTokens: Math.round(row.avgTotalTokens || 0),
        tokensOverall: Number(row.totalTokensOverall || 0),
      };
    } catch (error) {
      console.error('[ERROR] getting metrics summary:', error);
      return emptyMetricsSummary();
    }
  },

  async getProcessedDocuments() {
    try {
      return db.prepare('SELECT * FROM processed_documents').all();
    } catch (error) {
      console.error('[ERROR] getting processed documents:', error);
      return [];
    }
  },

  async getProcessedDocumentsCount() {
    try {
      return db
        .prepare('SELECT COUNT(*) FROM processed_documents')
        .pluck()
        .get();
    } catch (error) {
      console.error('[ERROR] getting processed documents count:', error);
      return 0;
    }
  },

  async isDocumentProcessed(documentId) {
    try {
      const row = findDocument.get(documentId);
      return !!row;
    } catch (error) {
      console.error('[ERROR] checking document:', error);
      // Im Zweifelsfall true zurückgeben, um doppelte Verarbeitung zu vermeiden
      return true;
    }
  },

  async saveOriginalData(
    documentId,
    tags,
    correspondent,
    title,
    documentType = null,
    language = null
  ) {
    try {
      const tagsString = JSON.stringify(tags); // Konvertiere Array zu String
      // Explicitly cast IDs to integer before storage to avoid SQLite TEXT-affinity
      // converting JS floats (e.g. 593.0) to '593.0' instead of '593'.
      const correspondentInt =
        correspondent != null ? parseInt(correspondent, 10) || null : null;
      const documentTypeInt =
        documentType != null ? parseInt(documentType, 10) || null : null;
      const result = db
        .prepare(
          `
        INSERT INTO original_documents (document_id, title, tags, correspondent, document_type, language)
        VALUES (?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          documentId,
          title,
          tagsString,
          correspondentInt,
          documentTypeInt,
          language ?? null
        );
      if (result.changes > 0) {
        console.log(`[DEBUG] Original data for document ${title} saved`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[ERROR] saving original data:', error);
      return false;
    }
  },

  async addToHistory(
    documentId,
    tagIds,
    title,
    correspondent,
    customFields = null,
    documentTypeName = null,
    language = null
  ) {
    try {
      const tagIdsString = JSON.stringify(tagIds); // Konvertiere Array zu String
      const customFieldsString = customFields
        ? JSON.stringify(customFields)
        : '[]';
      const result = db
        .prepare(
          `
        INSERT INTO history_documents (document_id, tags, title, correspondent, custom_fields, document_type_name, language)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          tags = excluded.tags,
          title = excluded.title,
          correspondent = excluded.correspondent,
          custom_fields = excluded.custom_fields,
          document_type_name = excluded.document_type_name,
          language = excluded.language
      `
        )
        .run(
          documentId,
          tagIdsString,
          title,
          correspondent,
          customFieldsString,
          documentTypeName ?? null,
          language ?? null
        );
      if (result.changes > 0) {
        console.log(`[DEBUG] Document ${title} added to history`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[ERROR] adding to history:', error);
      return false;
    }
  },

  async getHistoryByDocumentId(documentId) {
    try {
      return db
        .prepare(
          'SELECT * FROM history_documents WHERE document_id = ? ORDER BY id DESC LIMIT 1'
        )
        .get(documentId);
    } catch (error) {
      console.error('[ERROR] getting history by document ID:', error);
      return null;
    }
  },

  async getMetricsByDocumentId(documentId) {
    try {
      return db
        .prepare(
          'SELECT * FROM openai_metrics WHERE document_id = ? ORDER BY id DESC LIMIT 1'
        )
        .get(documentId);
    } catch (error) {
      console.error('[ERROR] getting metrics by document ID:', error);
      return null;
    }
  },

  async getHistory(id) {
    //check if id is provided else get all history
    if (id) {
      try {
        //only one document with id exists
        return db
          .prepare('SELECT * FROM history_documents WHERE document_id = ?')
          .get(id);
      } catch (error) {
        console.error('[ERROR] getting history for id:', id, error);
        return [];
      }
    } else {
      try {
        return db.prepare('SELECT * FROM history_documents').all();
      } catch (error) {
        console.error('[ERROR] getting history for id:', id, error);
        return [];
      }
    }
  },

  async getOriginalData(id) {
    //check if id is provided else get all original data
    if (id) {
      try {
        //only one document with id exists
        return db
          .prepare('SELECT * FROM original_documents WHERE document_id = ?')
          .get(id);
      } catch (error) {
        console.error('[ERROR] getting original data for id:', id, error);
        return [];
      }
    } else {
      try {
        return db.prepare('SELECT * FROM original_documents').all();
      } catch (error) {
        console.error('[ERROR] getting original data for id:', id, error);
        return [];
      }
    }
  },

  async getAllOriginalData() {
    try {
      return db.prepare('SELECT * FROM original_documents').all();
    } catch (error) {
      console.error('[ERROR] getting original data:', error);
      return [];
    }
  },

  async getAllHistory() {
    try {
      return db.prepare('SELECT * FROM history_documents').all();
    } catch (error) {
      console.error('[ERROR] getting history:', error);
      return [];
    }
  },

  async getHistoryDocumentsCount() {
    try {
      const result = getHistoryDocumentsCount.get();
      return result.count;
    } catch (error) {
      console.error('[ERROR] getting history documents count:', error);
      return 0;
    }
  },

  async getPaginatedHistory(limit, offset) {
    try {
      return getPaginatedHistoryDocuments.all(limit, offset);
    } catch (error) {
      console.error('[ERROR] getting paginated history:', error);
      return [];
    }
  },

  async getHistoryPaginated({
    search = '',
    tagFilter = '',
    correspondentFilter = '',
    sortColumn = 'created_at',
    sortDir = 'desc',
    limit = 10,
    offset = 0,
  }) {
    try {
      // Prepare search pattern
      const searchPattern = search ? `%${search}%` : '';
      const tagPattern = tagFilter ? `%"${tagFilter}"%` : '';

      // Execute query with all parameters
      const docs = getHistoryPaginatedFiltered.all(
        searchPattern,
        searchPattern,
        searchPattern, // search in title and correspondent
        tagPattern,
        tagPattern, // tag filter
        correspondentFilter,
        correspondentFilter, // correspondent exact match
        sortColumn,
        sortDir, // 1st sort option
        sortColumn,
        sortDir, // 2nd sort option
        sortColumn,
        sortDir, // 3rd sort option
        sortColumn,
        sortDir, // 4th sort option
        sortColumn,
        sortDir, // 5th sort option
        sortColumn,
        sortDir, // 6th sort option
        sortColumn,
        sortDir, // 7th sort option
        sortColumn,
        sortDir, // 8th sort option
        limit,
        offset
      );

      return docs;
    } catch (error) {
      console.error('[ERROR] getting paginated filtered history:', error);
      return [];
    }
  },

  async getHistoryCountFiltered({
    search = '',
    tagFilter = '',
    correspondentFilter = '',
  }) {
    try {
      const searchPattern = search ? `%${search}%` : '';
      const tagPattern = tagFilter ? `%"${tagFilter}"%` : '';

      const result = getHistoryCountFiltered.get(
        searchPattern,
        searchPattern,
        searchPattern,
        tagPattern,
        tagPattern,
        correspondentFilter,
        correspondentFilter
      );

      return result.count;
    } catch (error) {
      console.error('[ERROR] getting filtered history count:', error);
      return 0;
    }
  },

  async getDistinctCorrespondents() {
    try {
      const results = getDistinctCorrespondents.all();
      return results.map((row) => row.correspondent).filter(Boolean);
    } catch (error) {
      console.error('[ERROR] getting distinct correspondents:', error);
      return [];
    }
  },

  async deleteAllDocuments() {
    try {
      db.prepare('DELETE FROM processed_documents').run();
      console.log('[DEBUG] All processed_documents deleted');
      db.prepare('DELETE FROM history_documents').run();
      console.log('[DEBUG] All history_documents deleted');
      db.prepare('DELETE FROM original_documents').run();
      console.log('[DEBUG] All original_documents deleted');
      return true;
    } catch (error) {
      console.error('[ERROR] deleting documents:', error);
      return false;
    }
  },

  async deleteDocumentsIdList(idList) {
    try {
      console.log('[DEBUG] Received idList:', idList);

      const ids = Array.isArray(idList) ? idList : idList?.ids || [];

      if (!Array.isArray(ids) || ids.length === 0) {
        console.error('[ERROR] Invalid input: must provide an array of ids');
        return false;
      }

      // Convert string IDs to integers
      const numericIds = ids.map((id) => parseInt(id, 10));

      const placeholders = numericIds.map(() => '?').join(', ');
      const query = `DELETE FROM processed_documents WHERE document_id IN (${placeholders})`;
      const query2 = `DELETE FROM history_documents WHERE document_id IN (${placeholders})`;
      const query3 = `DELETE FROM original_documents WHERE document_id IN (${placeholders})`;
      console.log('[DEBUG] Executing SQL query:', query);
      console.log('[DEBUG] Executing SQL query:', query2);
      console.log('[DEBUG] Executing SQL query:', query3);
      console.log('[DEBUG] With parameters:', numericIds);

      const stmt = db.prepare(query);
      const stmt2 = db.prepare(query2);
      const stmt3 = db.prepare(query3);
      const result = stmt.run(numericIds);
      const result2 = stmt2.run(numericIds);
      const result3 = stmt3.run(numericIds);

      console.log('[DEBUG] SQL result:', result);
      console.log('[DEBUG] SQL result:', result2);
      console.log('[DEBUG] SQL result:', result3);
      console.log(
        `[DEBUG] Documents with IDs ${numericIds.join(', ')} deleted`
      );
      return true;
    } catch (error) {
      console.error('[ERROR] deleting documents:', error);
      return false;
    }
  },

  async addUser(username, password) {
    try {
      // Lösche alle vorhandenen Benutzer
      const deleteResult = db.prepare('DELETE FROM users').run();
      console.log(`[DEBUG] ${deleteResult.changes} existing users deleted`);

      // Füge den neuen Benutzer hinzu
      const result = insertUser.run(username, password);
      if (result.changes > 0) {
        console.log(`[DEBUG] User ${username} added`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[ERROR] adding user:', error);
      return false;
    }
  },

  async getUser(username) {
    try {
      return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    } catch (error) {
      console.error('[ERROR] getting user:', error);
      return [];
    }
  },

  async getUsers() {
    try {
      return db.prepare('SELECT * FROM users').all();
    } catch (error) {
      console.error('[ERROR] getting users:', error);
      return [];
    }
  },

  async setUserMfaSettings(username, enabled, secret = null) {
    try {
      const result = db
        .prepare(
          'UPDATE users SET mfa_enabled = ?, mfa_secret = ? WHERE username = ?'
        )
        .run(enabled ? 1 : 0, secret, username);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] updating user MFA settings:', error);
      return false;
    }
  },

  async getLastSeenChangelogVersion(username) {
    try {
      const row = db
        .prepare(
          'SELECT last_seen_changelog_version FROM users WHERE username = ?'
        )
        .get(username);
      return row ? row.last_seen_changelog_version : null;
    } catch (error) {
      console.error('[ERROR] getting last seen changelog version:', error);
      return null;
    }
  },

  async setLastSeenChangelogVersion(username, version) {
    try {
      const result = db
        .prepare(
          'UPDATE users SET last_seen_changelog_version = ? WHERE username = ?'
        )
        .run(version, username);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] setting last seen changelog version:', error);
      return false;
    }
  },

  /* The dashboard grid the user arranged, stored as the JSON string the route
     validated. Malformed rows return null so the dashboard falls back to the
     order the markup ships with. */
  async getDashboardLayout(username) {
    try {
      const row = db
        .prepare('SELECT dashboard_layout FROM users WHERE username = ?')
        .get(username);
      if (!row || !row.dashboard_layout) {
        return null;
      }
      return JSON.parse(row.dashboard_layout);
    } catch (error) {
      console.error('[ERROR] getting dashboard layout:', error);
      return null;
    }
  },

  /* Passing null clears the layout, which is how "reset to default" works. */
  async setDashboardLayout(username, layout) {
    try {
      const result = db
        .prepare('UPDATE users SET dashboard_layout = ? WHERE username = ?')
        .run(layout === null ? null : JSON.stringify(layout), username);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] setting dashboard layout:', error);
      return false;
    }
  },

  async getProcessingTimeStats() {
    try {
      return db
        .prepare(
          `
        SELECT 
          strftime('%H', processed_at) as hour,
          COUNT(*) as count
        FROM processed_documents 
        WHERE date(processed_at) = date('now')
        GROUP BY hour
        ORDER BY hour
      `
        )
        .all();
    } catch (error) {
      console.error('[ERROR] getting processing time stats:', error);
      return [];
    }
  },

  async getTokenDistribution() {
    try {
      return db
        .prepare(
          `
        SELECT 
          CASE 
            WHEN totalTokens < 1000 THEN '0-1k'
            WHEN totalTokens < 2000 THEN '1k-2k'
            WHEN totalTokens < 3000 THEN '2k-3k'
            WHEN totalTokens < 4000 THEN '3k-4k'
            WHEN totalTokens < 5000 THEN '4k-5k'
            ELSE '5k+'
          END as range,
          COUNT(*) as count
        FROM openai_metrics
        GROUP BY range
        ORDER BY range
      `
        )
        .all();
    } catch (error) {
      console.error('[ERROR] getting token distribution:', error);
      return [];
    }
  },

  /**
   * Document type distribution for the dashboard chart.
   *
   * This used to read `substr(title, 1, instr(title || ' ', ' ') - 1)` from
   * processed_documents — the first word of the title. That happens to look
   * plausible for "Invoice 2026-0041 …" and turns into noise for everything
   * else, and it was never the document type. history_documents carries the
   * type the AI actually assigned, written on every processed document.
   *
   * Not limited: the caller groups the tail itself and needs the full set to
   * report how much it grouped.
   */
  async getDocumentTypeStats() {
    try {
      return db
        .prepare(
          `
        SELECT
          COALESCE(NULLIF(TRIM(document_type_name), ''), 'Unclassified') as type,
          COUNT(*) as count
        FROM history_documents
        GROUP BY COALESCE(NULLIF(TRIM(document_type_name), ''), 'Unclassified')
        ORDER BY count DESC, type ASC
      `
        )
        .all();
    } catch (error) {
      console.error('[ERROR] getting document type stats:', error);
      return [];
    }
  },

  async getTokenTrend(days = 7) {
    try {
      const safeDays = Math.max(1, Number(days) || 7);
      const dayOffset = `-${safeDays - 1} days`;
      return db
        .prepare(
          `
        SELECT
          date(created_at, 'localtime') as day,
          COUNT(*) as documents,
          SUM(totalTokens) as totalTokens
        FROM openai_metrics
        WHERE date(created_at, 'localtime') >= date('now', 'localtime', ?)
        GROUP BY day
        ORDER BY day ASC
      `
        )
        .all(dayOffset);
    } catch (error) {
      console.error('[ERROR] getting token trend:', error);
      return [];
    }
  },

  async getRecentHistoryDocuments(limit = 4) {
    try {
      const safeLimit = Math.max(1, Math.min(20, Number(limit) || 6));
      return db
        .prepare(
          `
        SELECT
          document_id as documentId,
          title,
          correspondent,
          created_at as createdAt,
          language
        FROM history_documents
        ORDER BY created_at DESC
        LIMIT ?
      `
        )
        .all(safeLimit);
    } catch (error) {
      console.error('[ERROR] getting recent history documents:', error);
      return [];
    }
  },

  async getLanguageDistribution(limit = 5) {
    try {
      const safeLimit = Math.max(1, Math.min(10, Number(limit) || 5));
      return db
        .prepare(
          `
        SELECT
          COALESCE(NULLIF(language, ''), 'Unknown') as language,
          COUNT(*) as count
        FROM history_documents
        GROUP BY COALESCE(NULLIF(language, ''), 'Unknown')
        ORDER BY count DESC
        LIMIT ?
      `
        )
        .all(safeLimit);
    } catch (error) {
      console.error('[ERROR] getting language distribution:', error);
      return [];
    }
  },

  async setProcessingStatus(documentId, title, status) {
    try {
      if (status === 'complete') {
        const result = clearProcessingStatus.run(documentId);
        return result.changes > 0;
      } else {
        const result = upsertProcessingStatus.run(documentId, title, status);
        return result.changes > 0;
      }
    } catch (error) {
      console.error('[ERROR] updating processing status:', error);
      return false;
    }
  },

  async getCurrentProcessingStatus() {
    try {
      const active = getActiveProcessing.get();

      // Get last processed document with explicit UTC time
      const lastProcessed = db
        .prepare(
          `
          SELECT 
              document_id, 
              title, 
              datetime(processed_at) as processed_at 
          FROM processed_documents 
          ORDER BY processed_at DESC 
          LIMIT 1`
        )
        .get();

      const processedToday = db
        .prepare(
          `
          SELECT COUNT(*) as count 
          FROM processed_documents 
          WHERE date(processed_at) = date('now', 'localtime')`
        )
        .get();

      return {
        currentlyProcessing: active
          ? {
              documentId: active.document_id,
              title: active.title,
              startTime: active.start_time,
              status: active.status,
            }
          : null,
        lastProcessed: lastProcessed
          ? {
              documentId: lastProcessed.document_id,
              title: lastProcessed.title,
              processed_at: lastProcessed.processed_at,
            }
          : null,
        processedToday: processedToday.count,
        isProcessing: !!active,
      };
    } catch (error) {
      console.error('[ERROR] getting current processing status:', error);
      return {
        currentlyProcessing: null,
        lastProcessed: null,
        processedToday: 0,
        isProcessing: false,
      };
    }
  },

  // Utility method to close the database connection
  /**
   * Records that document analysis proposed a name and the guard used an
   * existing object instead. Keeps the newest ENTITY_NAME_MAPPINGS_KEEP rows.
   *
   * @returns {Promise<number|null>} the row id, null on a database error
   */
  async addEntityNameMapping({
    kind,
    proposedName,
    targetId,
    targetName,
    reason,
    score = 0,
    documentId = null,
  }) {
    try {
      const insert = db.prepare(`
        INSERT INTO entity_name_mappings
          (kind, proposed_name, target_id, target_name, reason, score, document_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const prune = db.prepare(`
        DELETE FROM entity_name_mappings
        WHERE id NOT IN (
          SELECT id FROM entity_name_mappings ORDER BY id DESC LIMIT ?
        )
      `);
      const run = db.transaction(() => {
        const result = insert.run(
          kind,
          String(proposedName),
          Number(targetId),
          String(targetName),
          String(reason),
          Number(score) || 0,
          documentId == null ? null : Number(documentId)
        );
        prune.run(ENTITY_NAME_MAPPINGS_KEEP);
        return Number(result.lastInsertRowid);
      });
      return run();
    } catch (error) {
      console.error('[ERROR] recording entity name mapping:', error);
      return null;
    }
  },

  /** The newest mappings first, at most `limit` (default: everything kept). */
  async listEntityNameMappings({ limit = ENTITY_NAME_MAPPINGS_KEEP } = {}) {
    try {
      return db
        .prepare('SELECT * FROM entity_name_mappings ORDER BY id DESC LIMIT ?')
        .all(Math.max(1, Number(limit) || ENTITY_NAME_MAPPINGS_KEEP))
        .map(parseEntityNameMappingRow);
    } catch (error) {
      console.error('[ERROR] listing entity name mappings:', error);
      return [];
    }
  },

  /** Forgets every mapping. @returns {Promise<number>} rows removed */
  async clearEntityNameMappings() {
    try {
      return db.prepare('DELETE FROM entity_name_mappings').run().changes;
    } catch (error) {
      console.error('[ERROR] clearing entity name mappings:', error);
      return 0;
    }
  },

  /**
   * What the judge measured about a model, or null when nothing was saved.
   *
   * @param {string} model
   * @param {boolean} thinking
   * @returns {Promise<{tokensPerPair:number|null, tokensPerSecond:number|null, largestCompletion:number, measuredAt:string}|null>}
   */
  async getAiCalibration(model, thinking) {
    try {
      const row = db
        .prepare(
          'SELECT * FROM ai_calibration WHERE model = ? AND thinking = ?'
        )
        .get(String(model), thinking ? 1 : 0);
      return row
        ? {
            tokensPerPair: row.tokens_per_pair ?? null,
            tokensPerSecond: row.tokens_per_second ?? null,
            largestCompletion: Number(row.largest_completion) || 0,
            measuredAt: row.measured_at,
          }
        : null;
    } catch (error) {
      console.error('[ERROR] reading AI calibration:', error);
      return null;
    }
  },

  /** Stores or replaces the measurement of one model and thinking switch. */
  async saveAiCalibration({
    model,
    thinking,
    tokensPerPair = null,
    tokensPerSecond = null,
    largestCompletion = 0,
  }) {
    try {
      db.prepare(
        `
        INSERT INTO ai_calibration
          (model, thinking, tokens_per_pair, tokens_per_second, largest_completion, measured_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(model, thinking) DO UPDATE SET
          tokens_per_pair = excluded.tokens_per_pair,
          tokens_per_second = excluded.tokens_per_second,
          largest_completion = excluded.largest_completion,
          measured_at = CURRENT_TIMESTAMP
      `
      ).run(
        String(model),
        thinking ? 1 : 0,
        tokensPerPair == null ? null : Number(tokensPerPair),
        tokensPerSecond == null ? null : Number(tokensPerSecond),
        Math.max(0, Math.round(Number(largestCompletion) || 0))
      );
      return true;
    } catch (error) {
      console.error('[ERROR] saving AI calibration:', error);
      return false;
    }
  },

  closeDatabase() {
    return new Promise((resolve, reject) => {
      try {
        db.close();
        console.log('[DEBUG] Database closed successfully');
        resolve();
      } catch (error) {
        console.error('[ERROR] closing database:', error);
        reject(error);
      }
    });
  },

  // ─── OCR Queue Methods ────────────────────────────────────────────────────

  /**
   * Puts a document into the OCR queue, or moves an existing row back to
   * pending.
   *
   * The return value says whether a pending row exists *because of this call*:
   * true when the row was inserted, or reset from pending, failed or — for a
   * request the user made — from done; false when the OCR worker is busy with
   * the row, when an automatic caller met a row that is already done, and when
   * skipIfProcessed refused the document. Callers log "queued for OCR" on that
   * value, so a false positive is a lie in the operator's log.
   *
   * @param {number} documentId Paperless-ngx document id
   * @param {string} title document title, shown in the queue view
   * @param {string} [reason='manual'] 'manual' is a run the user asked for and
   *   re-queues a finished document; every other value marks automatic
   *   queueing from a processing pipeline
   * @param {object} [options]
   * @param {boolean} [options.skipIfProcessed=false] refuse a document that is
   *   already in processed_documents. The check sits inside the same statement
   *   as the insert, so a document whose OCR run finishes while the scan is
   *   still making its Paperless-ngx calls cannot slip through and buy a
   *   second OCR run (issue #322).
   * @returns {Promise<boolean>} true only when this call left a pending row
   */
  async addToOcrQueue(documentId, title, reason = 'manual', options = {}) {
    const { skipIfProcessed = false } = options || {};
    const isManualRequest = reason === 'manual';

    try {
      // One statement, so the processed_documents lookup and the insert cannot
      // be interleaved. The SELECT needs its WHERE clause even when nothing is
      // being skipped: SQLite requires one to tell the upsert's ON apart from
      // the ON of a join.
      const result = db
        .prepare(
          `
        INSERT INTO ocr_queue (document_id, title, reason, status)
        SELECT ?, ?, ?, 'pending'
        WHERE ? = 0
           OR NOT EXISTS (SELECT 1 FROM processed_documents WHERE document_id = ?)
        ON CONFLICT(document_id) DO UPDATE SET
          title = excluded.title,
          reason = excluded.reason,
          ocr_text = CASE WHEN ocr_queue.status = 'done' THEN NULL ELSE ocr_queue.ocr_text END,
          status = 'pending',
          added_at = CURRENT_TIMESTAMP
        WHERE ocr_queue.status IN ('pending', 'failed')
           OR (ocr_queue.status = 'done' AND ? = 1)
      `
        )
        .run(
          documentId,
          title,
          reason,
          skipIfProcessed ? 1 : 0,
          documentId,
          isManualRequest ? 1 : 0
        );
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] adding to OCR queue:', error);
      return false;
    }
  },

  async getOcrQueue(status = null) {
    try {
      if (status) {
        return db
          .prepare(
            'SELECT * FROM ocr_queue WHERE status = ? ORDER BY added_at DESC'
          )
          .all(status);
      }
      return db.prepare('SELECT * FROM ocr_queue ORDER BY added_at DESC').all();
    } catch (error) {
      console.error('[ERROR] getting OCR queue:', error);
      return [];
    }
  },

  async getOcrQueuePaginated({
    search = '',
    statusFilter = '',
    limit = 10,
    offset = 0,
  }) {
    try {
      const searchPattern = search ? `%${search}%` : '%';
      const docs = db
        .prepare(
          `
        SELECT * FROM ocr_queue
        WHERE (title LIKE ? OR CAST(document_id AS TEXT) LIKE ?)
          AND (? = '' OR status = ?)
        ORDER BY added_at DESC
        LIMIT ? OFFSET ?
      `
        )
        .all(
          searchPattern,
          searchPattern,
          statusFilter,
          statusFilter,
          limit,
          offset
        );
      const countRow = db
        .prepare(
          `
        SELECT COUNT(*) as count FROM ocr_queue
        WHERE (title LIKE ? OR CAST(document_id AS TEXT) LIKE ?)
          AND (? = '' OR status = ?)
      `
        )
        .get(searchPattern, searchPattern, statusFilter, statusFilter);
      return { docs, total: countRow.count };
    } catch (error) {
      console.error('[ERROR] getting paginated OCR queue:', error);
      return { docs: [], total: 0 };
    }
  },

  async getOcrQueueItem(documentId) {
    try {
      return db
        .prepare('SELECT * FROM ocr_queue WHERE document_id = ?')
        .get(documentId);
    } catch (error) {
      console.error('[ERROR] getting OCR queue item:', error);
      return null;
    }
  },

  // wroteBack stays null when the caller has nothing to say about the
  // write-back, which is every call that is not the end of an OCR run. COALESCE
  // then keeps whatever the run before recorded instead of erasing it.
  async updateOcrQueueStatus(
    documentId,
    status,
    ocrText = null,
    wroteBack = null
  ) {
    try {
      const wroteBackValue =
        wroteBack === null || wroteBack === undefined
          ? null
          : wroteBack
            ? 1
            : 0;
      const result = db
        .prepare(
          `
        UPDATE ocr_queue SET
          status = ?,
          ocr_text = COALESCE(?, ocr_text),
          wrote_back = COALESCE(?, wrote_back),
          processed_at = CASE WHEN ? IN ('done', 'failed') THEN CURRENT_TIMESTAMP ELSE processed_at END
        WHERE document_id = ?
      `
        )
        .run(status, ocrText, wroteBackValue, status, documentId);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] updating OCR queue status:', error);
      return false;
    }
  },

  async resetOcrQueueItemsToPending(documentIds) {
    try {
      const normalizedIds = Array.isArray(documentIds)
        ? documentIds
            .map((documentId) => Number(documentId))
            .filter(
              (documentId) => Number.isInteger(documentId) && documentId > 0
            )
        : [];

      if (normalizedIds.length === 0) {
        return 0;
      }

      const resetItem = db.prepare(`
        UPDATE ocr_queue SET
          status = 'pending',
          processed_at = NULL
        WHERE document_id = ?
          AND status = 'processing'
      `);

      const resetMany = db.transaction((ids) => {
        let changes = 0;
        for (const documentId of ids) {
          changes += resetItem.run(documentId).changes;
        }
        return changes;
      });

      return resetMany(normalizedIds);
    } catch (error) {
      console.error('[ERROR] resetting OCR queue items to pending:', error);
      return 0;
    }
  },

  async removeFromOcrQueue(documentId) {
    try {
      const result = db
        .prepare('DELETE FROM ocr_queue WHERE document_id = ?')
        .run(documentId);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] removing from OCR queue:', error);
      return false;
    }
  },

  async getOcrQueueDocumentIds() {
    try {
      const rows = db
        .prepare(
          "SELECT document_id FROM ocr_queue WHERE status IN ('pending', 'processing')"
        )
        .all();
      return rows.map((r) => r.document_id);
    } catch (error) {
      console.error('[ERROR] getting OCR queue document IDs:', error);
      return [];
    }
  },

  async getOcrQueueCount() {
    try {
      return db
        .prepare(
          "SELECT COUNT(*) as count FROM ocr_queue WHERE status = 'pending'"
        )
        .get().count;
    } catch (error) {
      console.error('[ERROR] getting OCR queue count:', error);
      return 0;
    }
  },

  async getOcrFailedCount() {
    try {
      return db
        .prepare(
          "SELECT COUNT(*) as count FROM ocr_queue WHERE status = 'failed'"
        )
        .get().count;
    } catch (error) {
      console.error('[ERROR] getting OCR failed count:', error);
      return 0;
    }
  },

  async getFailedProcessingCount() {
    try {
      return db
        .prepare(
          "SELECT COUNT(*) as count FROM processing_status WHERE status = 'failed'"
        )
        .get().count;
    } catch (error) {
      console.error('[ERROR] getting processing failed count:', error);
      return 0;
    }
  },

  async addFailedDocument(
    documentId,
    title,
    failedReason = 'unknown_failure',
    source = 'ai'
  ) {
    try {
      const result = db
        .prepare(
          `
        INSERT INTO failed_documents (document_id, title, failed_reason, source)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          title = excluded.title,
          failed_reason = excluded.failed_reason,
          source = excluded.source,
          updated_at = CURRENT_TIMESTAMP
      `
        )
        .run(documentId, title, failedReason, source);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] adding failed document:', error);
      return false;
    }
  },

  async isDocumentFailed(documentId) {
    try {
      const row = db
        .prepare('SELECT 1 FROM failed_documents WHERE document_id = ?')
        .get(documentId);
      return !!row;
    } catch (error) {
      console.error('[ERROR] checking failed document:', error);
      return false;
    }
  },

  async getFailedDocumentsPaginated({ search = '', limit = 10, offset = 0 }) {
    try {
      const searchPattern = search ? `%${search}%` : '%';
      const docs = db
        .prepare(
          `
        SELECT * FROM failed_documents
        WHERE (title LIKE ? OR CAST(document_id AS TEXT) LIKE ? OR failed_reason LIKE ? OR source LIKE ?)
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `
        )
        .all(
          searchPattern,
          searchPattern,
          searchPattern,
          searchPattern,
          limit,
          offset
        );

      const countRow = db
        .prepare(
          `
        SELECT COUNT(*) as count FROM failed_documents
        WHERE (title LIKE ? OR CAST(document_id AS TEXT) LIKE ? OR failed_reason LIKE ? OR source LIKE ?)
      `
        )
        .get(searchPattern, searchPattern, searchPattern, searchPattern);

      return { docs, total: countRow.count };
    } catch (error) {
      console.error('[ERROR] getting paginated failed documents:', error);
      return { docs: [], total: 0 };
    }
  },

  async resetFailedDocument(documentId) {
    try {
      const result = db
        .prepare('DELETE FROM failed_documents WHERE document_id = ?')
        .run(documentId);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] resetting failed document:', error);
      return false;
    }
  },

  async resetAllFailedDocuments() {
    try {
      const resetAll = db.transaction(() => {
        const rows = db
          .prepare('SELECT document_id FROM failed_documents')
          .all();
        if (!rows.length) {
          return 0;
        }

        const documentIds = rows.map((row) => row.document_id);
        const deleteFailedResult = db
          .prepare('DELETE FROM failed_documents')
          .run();

        const placeholders = documentIds.map(() => '?').join(', ');
        db.prepare(
          `DELETE FROM processing_status WHERE document_id IN (${placeholders})`
        ).run(...documentIds);

        return deleteFailedResult.changes;
      });

      return resetAll();
    } catch (error) {
      console.error('[ERROR] resetting all failed documents:', error);
      return 0;
    }
  },

  async getProcessingStatusByDocumentId(documentId) {
    try {
      const row = db
        .prepare('SELECT * FROM processing_status WHERE document_id = ?')
        .get(documentId);
      return row || null;
    } catch (error) {
      console.error('[ERROR] getting processing status for document:', error);
      return null;
    }
  },

  async clearProcessingStatusByDocumentId(documentId) {
    try {
      const result = clearProcessingStatus.run(documentId);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] clearing processing status for document:', error);
      return false;
    }
  },

  async addIgnoredDocument(documentId, title, reason = 'manual') {
    try {
      const result = db
        .prepare(
          `
        INSERT INTO ignored_documents (document_id, title, reason)
        VALUES (?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          title = excluded.title,
          reason = excluded.reason
      `
        )
        .run(documentId, title, reason);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] adding ignored document:', error);
      return false;
    }
  },

  async removeIgnoredDocument(documentId) {
    try {
      const result = db
        .prepare('DELETE FROM ignored_documents WHERE document_id = ?')
        .run(documentId);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] removing ignored document:', error);
      return false;
    }
  },

  async isDocumentIgnored(documentId) {
    try {
      const row = db
        .prepare('SELECT 1 FROM ignored_documents WHERE document_id = ?')
        .get(documentId);
      return !!row;
    } catch (error) {
      console.error('[ERROR] checking ignored document:', error);
      return false;
    }
  },

  async getIgnoredDocumentsPaginated({ search = '', limit = 25, offset = 0 }) {
    try {
      const searchPattern = search ? `%${search}%` : '%';
      const docs = db
        .prepare(
          `
        SELECT * FROM ignored_documents
        WHERE (title LIKE ? OR CAST(document_id AS TEXT) LIKE ? OR reason LIKE ?)
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `
        )
        .all(searchPattern, searchPattern, searchPattern, limit, offset);

      const countRow = db
        .prepare(
          `
        SELECT COUNT(*) as count FROM ignored_documents
        WHERE (title LIKE ? OR CAST(document_id AS TEXT) LIKE ? OR reason LIKE ?)
      `
        )
        .get(searchPattern, searchPattern, searchPattern);

      return { docs, total: countRow.count };
    } catch (error) {
      console.error('[ERROR] getting paginated ignored documents:', error);
      return { docs: [], total: 0 };
    }
  },

  async getIgnoredCount() {
    try {
      const row = db
        .prepare('SELECT COUNT(*) as count FROM ignored_documents')
        .get();
      return row?.count || 0;
    } catch (error) {
      console.error('[ERROR] getting ignored documents count:', error);
      return 0;
    }
  },

  async clearAllIgnoredDocuments() {
    try {
      const result = db.prepare('DELETE FROM ignored_documents').run();
      return result.changes;
    } catch (error) {
      console.error('[ERROR] clearing all ignored documents:', error);
      return 0;
    }
  },

  // ── Entity merges (Duplicates page) ───────────────────────────────────────
  // Records of tag / correspondent merges and the pairs the user dismissed.
  // The merge service writes here; the Duplicates page reads the log and
  // asks for an undo through the service, never through these methods alone.

  async addEntityMerge({
    kind,
    targetId,
    targetName,
    targetBefore = null,
    sources = [],
    documentsMoved = 0,
    copiedMatchingRule = false,
    status = 'done',
    performedBy = null,
    action = 'merge',
    targetRenamedFrom = null,
    details = null,
  }) {
    try {
      const result = db
        .prepare(
          `
        INSERT INTO entity_merges
          (kind, target_id, target_name, target_before, sources, documents_moved,
           copied_matching_rule, status, performed_by, action, target_renamed_from, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          kind,
          targetId,
          targetName,
          targetBefore == null ? null : JSON.stringify(targetBefore),
          JSON.stringify(Array.isArray(sources) ? sources : []),
          Number(documentsMoved) || 0,
          copiedMatchingRule ? 1 : 0,
          status,
          performedBy,
          ENTITY_MERGE_ACTIONS.includes(action) ? action : 'merge',
          targetRenamedFrom == null ? null : String(targetRenamedFrom),
          details == null ? null : JSON.stringify(details)
        );
      return Number(result.lastInsertRowid);
    } catch (error) {
      console.error('[ERROR] recording entity merge:', error);
      return null;
    }
  },

  /* --- Simplify tags: the vocabulary ------------------------------------ */

  /**
   * The target vocabulary of "Simplify tags": document types (dimension
   * 'type') and topic tags (dimension 'topic') in the order the user keeps
   * them. Empty until a vocabulary was saved.
   *
   * @returns {Promise<Array<{id:number, dimension:string, name:string, paperlessId:number|null, source:string, position:number, createdAt:string}>>}
   */
  async getTagVocabulary() {
    try {
      return db
        .prepare(
          'SELECT * FROM tag_vocabulary ORDER BY dimension, position, id'
        )
        .all()
        .map(parseTagVocabularyRow);
    } catch (error) {
      console.error('[ERROR] reading the tag vocabulary:', error);
      return [];
    }
  },

  /**
   * Replaces the whole vocabulary in one transaction. Entries keep the order
   * given (position per dimension); a name repeated in one dimension is kept
   * once; a paperlessId already known for a name survives when the caller
   * does not pass one.
   *
   * @param {Array<{dimension:'type'|'topic', name:string, paperlessId?:number|null, source?:'model'|'user'}>} entries
   * @returns {Promise<number>} rows stored
   */
  async replaceTagVocabulary(entries) {
    const rows = Array.isArray(entries) ? entries : [];
    try {
      const known = new Map(
        db
          .prepare('SELECT dimension, name, paperless_id FROM tag_vocabulary')
          .all()
          .map((row) => [`${row.dimension}\u0000${row.name}`, row.paperless_id])
      );
      const store = db.transaction(() => {
        db.prepare('DELETE FROM tag_vocabulary').run();
        const insert = db.prepare(
          'INSERT INTO tag_vocabulary (dimension, name, paperless_id, source, position) VALUES (?, ?, ?, ?, ?)'
        );
        const seen = new Set();
        const positions = { type: 0, topic: 0 };
        let stored = 0;
        for (const entry of rows) {
          const dimension = entry?.dimension === 'type' ? 'type' : 'topic';
          const name = String(entry?.name ?? '').trim();
          if (name === '') continue;
          const key = `${dimension}\u0000${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const paperlessId =
            entry.paperlessId == null
              ? (known.get(key) ?? null)
              : Number(entry.paperlessId);
          insert.run(
            dimension,
            name,
            paperlessId,
            entry.source === 'model' ? 'model' : 'user',
            positions[dimension]++
          );
          stored += 1;
        }
        return stored;
      });
      return store();
    } catch (error) {
      console.error('[ERROR] replacing the tag vocabulary:', error);
      return 0;
    }
  },

  /** Records the Paperless-ngx id of a vocabulary entry once the object exists. */
  async setTagVocabularyPaperlessId(id, paperlessId) {
    try {
      const result = db
        .prepare('UPDATE tag_vocabulary SET paperless_id = ? WHERE id = ?')
        .run(paperlessId == null ? null : Number(paperlessId), Number(id));
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] updating a vocabulary entry:', error);
      return false;
    }
  },

  /* --- Simplify tags: split proposals ----------------------------------- */

  /**
   * Replaces every proposal with the rows of a fresh run, in one transaction.
   *
   * @param {Array<{tagId:number, tagName:string, documentCount?:number, typeName?:string|null, topicNames?:string[], source?:string, confidence?:string|null, reason?:string|null, documentsWithType?:number, overwriteType?:boolean, status?:string}>} rows
   * @returns {Promise<number>} rows stored
   */
  async replaceTagSplitProposals(rows) {
    const list = Array.isArray(rows) ? rows : [];
    try {
      const store = db.transaction(() => {
        db.prepare('DELETE FROM tag_split_proposals').run();
        const insert = db.prepare(
          `INSERT INTO tag_split_proposals
             (tag_id, tag_name, document_count, type_name, topic_names, source, confidence, reason, documents_with_type, overwrite_type, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        let stored = 0;
        for (const row of list) {
          const tagId = Number(row?.tagId);
          if (!Number.isInteger(tagId) || tagId <= 0) continue;
          insert.run(
            tagId,
            String(row.tagName ?? ''),
            Number(row.documentCount) || 0,
            row.typeName == null ? null : String(row.typeName),
            JSON.stringify(Array.isArray(row.topicNames) ? row.topicNames : []),
            row.source || 'rule',
            row.confidence ?? null,
            row.reason ?? null,
            Number(row.documentsWithType) || 0,
            row.overwriteType ? 1 : 0,
            row.status || 'open'
          );
          stored += 1;
        }
        return stored;
      });
      return store();
    } catch (error) {
      console.error('[ERROR] replacing the split proposals:', error);
      return 0;
    }
  },

  /** @returns {Promise<object[]>} proposals, optionally of one status, by name */
  async listTagSplitProposals({ status = null } = {}) {
    try {
      const where = status ? 'WHERE status = ?' : '';
      const params = status ? [status] : [];
      return db
        .prepare(
          `SELECT * FROM tag_split_proposals ${where} ORDER BY tag_name COLLATE NOCASE`
        )
        .all(...params)
        .map(parseTagSplitProposalRow);
    } catch (error) {
      console.error('[ERROR] reading the split proposals:', error);
      return [];
    }
  },

  /** @returns {Promise<object|null>} */
  async getTagSplitProposal(tagId) {
    try {
      const row = db
        .prepare('SELECT * FROM tag_split_proposals WHERE tag_id = ?')
        .get(Number(tagId));
      return row ? parseTagSplitProposalRow(row) : null;
    } catch (error) {
      console.error('[ERROR] reading a split proposal:', error);
      return null;
    }
  },

  /**
   * Changes what the user edited on a proposal: the targets, the overwrite
   * switch, the status. Fields not in the patch stay.
   *
   * @param {number} tagId
   * @param {{typeName?:string|null, topicNames?:string[], overwriteType?:boolean, status?:string, source?:string, reason?:string|null, confidence?:string|null}} patch
   * @returns {Promise<boolean>} true when a row changed
   */
  async updateTagSplitProposal(tagId, patch = {}) {
    const sets = [];
    const params = [];
    if ('typeName' in patch) {
      sets.push('type_name = ?');
      params.push(patch.typeName == null ? null : String(patch.typeName));
    }
    if ('topicNames' in patch) {
      sets.push('topic_names = ?');
      params.push(
        JSON.stringify(Array.isArray(patch.topicNames) ? patch.topicNames : [])
      );
    }
    if ('overwriteType' in patch) {
      sets.push('overwrite_type = ?');
      params.push(patch.overwriteType ? 1 : 0);
    }
    if ('status' in patch) {
      sets.push('status = ?');
      params.push(String(patch.status));
    }
    if ('source' in patch) {
      sets.push('source = ?');
      params.push(String(patch.source));
    }
    if ('reason' in patch) {
      sets.push('reason = ?');
      params.push(patch.reason == null ? null : String(patch.reason));
    }
    if ('confidence' in patch) {
      sets.push('confidence = ?');
      params.push(patch.confidence == null ? null : String(patch.confidence));
    }
    if (sets.length === 0) return false;
    sets.push('updated_at = CURRENT_TIMESTAMP');
    try {
      const result = db
        .prepare(
          `UPDATE tag_split_proposals SET ${sets.join(', ')} WHERE tag_id = ?`
        )
        .run(...params, Number(tagId));
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] updating a split proposal:', error);
      return false;
    }
  },

  /** @returns {Promise<number>} rows removed */
  async clearTagSplitProposals() {
    try {
      return db.prepare('DELETE FROM tag_split_proposals').run().changes;
    } catch (error) {
      console.error('[ERROR] clearing the split proposals:', error);
      return 0;
    }
  },

  /* --- The judge's memory of verdicts ----------------------------------- */

  /**
   * Stored verdicts for some pairs of one kind. Keys not stored are simply
   * absent from the answer.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {string[]} pairKeys
   * @returns {Promise<object[]>}
   */
  async getAiPairVerdicts(kind, pairKeys) {
    const keys = Array.isArray(pairKeys) ? pairKeys.filter(Boolean) : [];
    if (keys.length === 0) return [];
    try {
      const rows = [];
      const select = db.prepare(
        'SELECT * FROM ai_pair_verdicts WHERE kind = ? AND pair_key = ?'
      );
      for (const key of keys) {
        const row = select.get(kind, String(key));
        if (row) rows.push(parseAiPairVerdictRow(row));
      }
      return rows;
    } catch (error) {
      console.error('[ERROR] reading remembered verdicts:', error);
      return [];
    }
  },

  /**
   * Remembers one verdict; a pair asked again replaces its row.
   *
   * @param {{kind:string, pairKey:string, nameA:string, nameB:string, verdict:string, basis?:string|null, confidence?:string|null, reason?:string|null, model?:string|null}} entry
   * @returns {Promise<boolean>}
   */
  async saveAiPairVerdict(entry) {
    try {
      db.prepare(
        `INSERT INTO ai_pair_verdicts
           (kind, pair_key, name_a, name_b, verdict, basis, confidence, reason, model, judged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (kind, pair_key) DO UPDATE SET
           name_a = excluded.name_a, name_b = excluded.name_b, verdict = excluded.verdict,
           basis = excluded.basis, confidence = excluded.confidence, reason = excluded.reason,
           model = excluded.model, judged_at = CURRENT_TIMESTAMP`
      ).run(
        String(entry.kind),
        String(entry.pairKey),
        String(entry.nameA ?? ''),
        String(entry.nameB ?? ''),
        String(entry.verdict),
        entry.basis ?? null,
        entry.confidence ?? null,
        entry.reason ?? null,
        entry.model ?? null
      );
      return true;
    } catch (error) {
      console.error('[ERROR] remembering a verdict:', error);
      return false;
    }
  },

  /** Forgets verdicts older than the given days. @returns {Promise<number>} rows removed */
  async pruneAiPairVerdicts(maxAgeDays) {
    const days = Number(maxAgeDays);
    if (!Number.isFinite(days) || days <= 0) return 0;
    try {
      return db
        .prepare(
          "DELETE FROM ai_pair_verdicts WHERE judged_at < datetime('now', ?)"
        )
        .run(`-${Math.floor(days)} days`).changes;
    } catch (error) {
      console.error('[ERROR] pruning remembered verdicts:', error);
      return 0;
    }
  },

  /** @returns {Promise<number>} rows removed */
  async clearAiPairVerdicts() {
    try {
      return db.prepare('DELETE FROM ai_pair_verdicts').run().changes;
    } catch (error) {
      console.error('[ERROR] clearing remembered verdicts:', error);
      return 0;
    }
  },

  /** @returns {Promise<number>} */
  async countAiPairVerdicts() {
    try {
      return Number(
        db.prepare('SELECT COUNT(*) AS n FROM ai_pair_verdicts').get().n
      );
    } catch (error) {
      console.error('[ERROR] counting remembered verdicts:', error);
      return 0;
    }
  },

  async getEntityMerges({ limit = 25, offset = 0, kind = null } = {}) {
    try {
      const where = kind ? 'WHERE kind = ?' : '';
      const params = kind ? [kind] : [];
      const rows = db
        .prepare(
          `SELECT * FROM entity_merges ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset)
        .map(parseEntityMergeRow);
      const countRow = db
        .prepare(`SELECT COUNT(*) AS count FROM entity_merges ${where}`)
        .get(...params);
      return { rows, total: countRow?.count || 0 };
    } catch (error) {
      console.error('[ERROR] listing entity merges:', error);
      return { rows: [], total: 0 };
    }
  },

  async getEntityMergeById(id) {
    try {
      const row = db
        .prepare('SELECT * FROM entity_merges WHERE id = ?')
        .get(id);
      return row ? parseEntityMergeRow(row) : null;
    } catch (error) {
      console.error('[ERROR] reading entity merge:', error);
      return null;
    }
  },

  /**
   * Records the outcome of an undo attempt. `undone_at` is only stamped when
   * the undo succeeded, so a failed attempt leaves the row undoable.
   */
  async updateEntityMergeUndo(id, { status, undoResult = null }) {
    try {
      const result = db
        .prepare(
          `
        UPDATE entity_merges
        SET status = ?,
            undo_result = ?,
            undone_at = CASE WHEN ? = 'undone' THEN CURRENT_TIMESTAMP ELSE undone_at END
        WHERE id = ?
      `
        )
        .run(
          status,
          undoResult == null ? null : JSON.stringify(undoResult),
          status,
          id
        );
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] updating entity merge undo state:', error);
      return false;
    }
  },

  /**
   * @param {'tags'|'correspondents'} kind
   * @param {Array<{idA:number,idB:number,nameA?:string,nameB?:string}>} pairs
   * @returns {Promise<number>} pairs newly stored (already known pairs are ignored)
   */
  async addEntityMergeDismissals(kind, pairs) {
    try {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO entity_merge_dismissals (kind, id_a, id_b, name_a, name_b)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insertAll = db.transaction((items) => {
        let inserted = 0;
        for (const pair of items) {
          const a = Number(pair.idA);
          const b = Number(pair.idB);
          if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue;
          const [low, high, lowName, highName] =
            a < b
              ? [a, b, pair.nameA ?? null, pair.nameB ?? null]
              : [b, a, pair.nameB ?? null, pair.nameA ?? null];
          inserted += insert.run(kind, low, high, lowName, highName).changes;
        }
        return inserted;
      });
      return insertAll(Array.isArray(pairs) ? pairs : []);
    } catch (error) {
      console.error('[ERROR] storing entity merge dismissals:', error);
      return 0;
    }
  },

  async listEntityMergeDismissals(kind = null) {
    try {
      const where = kind ? 'WHERE kind = ?' : '';
      const params = kind ? [kind] : [];
      return db
        .prepare(
          `SELECT * FROM entity_merge_dismissals ${where} ORDER BY id DESC`
        )
        .all(...params)
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          idA: row.id_a,
          idB: row.id_b,
          nameA: row.name_a,
          nameB: row.name_b,
          createdAt: row.created_at,
        }));
    } catch (error) {
      console.error('[ERROR] listing entity merge dismissals:', error);
      return [];
    }
  },

  async removeEntityMergeDismissal(id) {
    try {
      const result = db
        .prepare('DELETE FROM entity_merge_dismissals WHERE id = ?')
        .run(id);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] removing entity merge dismissal:', error);
      return false;
    }
  },

  /**
   * Points the local records at another tag or correspondent after a merge
   * (source -> target) or an undo (target -> re-created source).
   *
   * The two tables disagree on what they store: history_documents keeps tag
   * ids and the correspondent *name*, original_documents keeps tag ids and
   * the correspondent *id*. Both are rewritten here so the History page and
   * the Restore action keep working for documents the merge touched.
   *
   * @param {'tags'|'correspondents'} kind
   * @param {object} change
   * @param {number} change.fromId
   * @param {number} change.toId
   * @param {string} [change.fromName]  correspondents only
   * @param {string} [change.toName]    correspondents only
   * @param {number[]|null} [change.documentIds]  limit the rewrite to these documents; null = every row
   * @returns {Promise<{historyRows:number, originalRows:number}>}
   */
  async replaceEntityInLocalRecords(
    kind,
    { fromId, toId, fromName = null, toName = null, documentIds = null }
  ) {
    const from = Number(fromId);
    const to = Number(toId);
    const scope =
      Array.isArray(documentIds) && documentIds.length > 0
        ? new Set(documentIds.map(Number))
        : null;
    const inScope = (documentId) => !scope || scope.has(Number(documentId));

    try {
      if (kind === 'tags') {
        const rewriteTags = db.transaction((table) => {
          const rows = db
            .prepare(`SELECT id, document_id, tags FROM ${table}`)
            .all();
          const update = db.prepare(
            `UPDATE ${table} SET tags = ? WHERE id = ?`
          );
          let changed = 0;
          for (const row of rows) {
            if (!inScope(row.document_id)) continue;
            let ids;
            try {
              ids = JSON.parse(row.tags || '[]');
            } catch {
              continue;
            }
            if (!Array.isArray(ids)) continue;
            const numeric = ids.map((value) => parseInt(value, 10));
            if (!numeric.includes(from)) continue;
            const rewritten = [
              ...new Set(numeric.map((id) => (id === from ? to : id))),
            ].filter((id) => Number.isInteger(id));
            update.run(JSON.stringify(rewritten), row.id);
            changed += 1;
          }
          return changed;
        });
        return {
          historyRows: rewriteTags('history_documents'),
          originalRows: rewriteTags('original_documents'),
        };
      }

      if (kind === 'correspondents') {
        const rewriteCorrespondent = db.transaction(() => {
          let historyRows = 0;
          let originalRows = 0;
          if (fromName != null && toName != null) {
            const rows = db
              .prepare(
                'SELECT id, document_id FROM history_documents WHERE correspondent = ?'
              )
              .all(fromName);
            const update = db.prepare(
              'UPDATE history_documents SET correspondent = ? WHERE id = ?'
            );
            for (const row of rows) {
              if (!inScope(row.document_id)) continue;
              historyRows += update.run(toName, row.id).changes;
            }
          }
          const originals = db
            .prepare(
              'SELECT id, document_id FROM original_documents WHERE CAST(correspondent AS INTEGER) = ?'
            )
            .all(from);
          const updateOriginal = db.prepare(
            'UPDATE original_documents SET correspondent = ? WHERE id = ?'
          );
          for (const row of originals) {
            if (!inScope(row.document_id)) continue;
            originalRows += updateOriginal.run(to, row.id).changes;
          }
          return { historyRows, originalRows };
        });
        return rewriteCorrespondent();
      }

      return { historyRows: 0, originalRows: 0 };
    } catch (error) {
      console.error('[ERROR] rewriting local records after merge:', error);
      return { historyRows: 0, originalRows: 0 };
    }
  },
};
