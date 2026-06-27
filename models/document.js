// models/document.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { get } = require('http');

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

try {
  fs.accessSync(dataDir, fs.constants.W_OK);
} catch (error) {
  throw new Error(`Data directory is not writable: ${dataDir}. Check container volume permissions. Original error: ${error.message}`);
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

const insertOriginal = db.prepare(`
  INSERT INTO original_documents (document_id, title, tags, correspondent)
  VALUES (?, ?, ?, ?)
`);

const insertHistory = db.prepare(`
  INSERT INTO history_documents (document_id, tags, title, correspondent)
  VALUES (?, ?, ?, ?)
`);

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
      database.exec("ALTER TABLE history_documents ADD COLUMN custom_fields TEXT DEFAULT '[]'");
    }
  },
  {
    version: 2,
    description: 'Add document_type_name and language to history_documents; add document_type and language to original_documents',
    up: (database) => {
      database.exec('ALTER TABLE history_documents ADD COLUMN document_type_name TEXT DEFAULT NULL');
      database.exec('ALTER TABLE history_documents ADD COLUMN language TEXT DEFAULT NULL');
      database.exec('ALTER TABLE original_documents ADD COLUMN document_type INTEGER DEFAULT NULL');
      database.exec('ALTER TABLE original_documents ADD COLUMN language TEXT DEFAULT NULL');
    }
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
    }
  },
  {
    version: 4,
    description: 'Create failed_documents table for terminally failed processing items',
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
    }
  },
  {
    version: 5,
    description: 'Add MFA columns to users table',
    up: (database) => {
      const userColumns = database.prepare("PRAGMA table_info('users')").all();
      const hasMfaEnabled = userColumns.some((col) => col.name === 'mfa_enabled');
      const hasMfaSecret = userColumns.some((col) => col.name === 'mfa_secret');

      if (!hasMfaEnabled) {
        database.exec('ALTER TABLE users ADD COLUMN mfa_enabled INTEGER DEFAULT 0');
      }

      if (!hasMfaSecret) {
        database.exec('ALTER TABLE users ADD COLUMN mfa_secret TEXT DEFAULT NULL');
      }
    }
  },
  {
    version: 6,
    description: 'Add last_seen_changelog_version column to users table',
    up: (database) => {
      const userColumns = database.prepare("PRAGMA table_info('users')").all();
      const hasColumn = userColumns.some((col) => col.name === 'last_seen_changelog_version');
      if (!hasColumn) {
        database.exec('ALTER TABLE users ADD COLUMN last_seen_changelog_version TEXT DEFAULT NULL');
      }
    }
  },
  {
    version: 7,
    description: 'Deduplicate history_documents and enforce one entry per document_id',
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
      database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_history_documents_document_id ON history_documents(document_id)');
    }
  }
];

function runMigrations(database) {
  const currentVersion = database.pragma('user_version', { simple: true });
  const pending = MIGRATIONS.filter(m => m.version > currentVersion);

  if (pending.length === 0) {
    console.log(`[DB Migration] Schema is up to date at v${currentVersion}`);
    return;
  }

  for (const migration of pending) {
    console.log(`[DB Migration] Running migration v${migration.version}: ${migration.description}`);
    const applyMigration = database.transaction(() => {
      migration.up(database);
      database.pragma(`user_version = ${migration.version}`);
    });
    applyMigration();
    console.log(`[DB Migration] Migration v${migration.version} completed successfully`);
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


module.exports = {
  async addProcessedDocument(documentId, title) {
    try {
      // Bei UNIQUE constraint failure wird der existierende Eintrag aktualisiert
      const result = insertDocument.run(documentId, title, documentId);
      if (result.changes > 0) {
        console.log(`[DEBUG] Document ${title} ${result.lastInsertRowid ? 'added to' : 'updated in'} processed_documents`);
        return true;
      }
      return false;
    } catch (error) {
      // Log error but don't throw
      console.error('[ERROR] adding document:', error);
      return false;
    }
  },

  async addOpenAIMetrics(documentId, promptTokens, completionTokens, totalTokens) {
    try {
      const result = insertMetrics.run(documentId, promptTokens, completionTokens, totalTokens);
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

  async getMetrics() {
    try {
      return db.prepare('SELECT * FROM openai_metrics').all();
    } catch (error) {
      console.error('[ERROR] getting metrics:', error);
      return [];
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
      return db.prepare('SELECT COUNT(*) FROM processed_documents').pluck().get();
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

  async saveOriginalData(documentId, tags, correspondent, title, documentType = null, language = null) {
    try {
      const tagsString = JSON.stringify(tags); // Konvertiere Array zu String
      // Explicitly cast IDs to integer before storage to avoid SQLite TEXT-affinity
      // converting JS floats (e.g. 593.0) to '593.0' instead of '593'.
      const correspondentInt = correspondent != null ? parseInt(correspondent, 10) || null : null;
      const documentTypeInt  = documentType  != null ? parseInt(documentType,  10) || null : null;
      const result = db.prepare(`
        INSERT INTO original_documents (document_id, title, tags, correspondent, document_type, language)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(documentId, title, tagsString, correspondentInt, documentTypeInt, language ?? null);
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

  async addToHistory(documentId, tagIds, title, correspondent, customFields = null, documentTypeName = null, language = null) {
    try {
      const tagIdsString = JSON.stringify(tagIds); // Konvertiere Array zu String
      const customFieldsString = customFields ? JSON.stringify(customFields) : '[]';
      const result = db.prepare(`
        INSERT INTO history_documents (document_id, tags, title, correspondent, custom_fields, document_type_name, language)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          tags = excluded.tags,
          title = excluded.title,
          correspondent = excluded.correspondent,
          custom_fields = excluded.custom_fields,
          document_type_name = excluded.document_type_name,
          language = excluded.language
      `).run(documentId, tagIdsString, title, correspondent, customFieldsString, documentTypeName ?? null, language ?? null);
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
      return db.prepare('SELECT * FROM history_documents WHERE document_id = ? ORDER BY id DESC LIMIT 1').get(documentId);
    } catch (error) {
      console.error('[ERROR] getting history by document ID:', error);
      return null;
    }
  },

  async getMetricsByDocumentId(documentId) {
    try {
      return db.prepare('SELECT * FROM openai_metrics WHERE document_id = ? ORDER BY id DESC LIMIT 1').get(documentId);
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
        return db.prepare('SELECT * FROM history_documents WHERE document_id = ?').get(id);
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
        return db.prepare('SELECT * FROM original_documents WHERE document_id = ?').get(id);
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

  async getHistoryPaginated({ search = '', tagFilter = '', correspondentFilter = '', sortColumn = 'created_at', sortDir = 'desc', limit = 10, offset = 0 }) {
    try {
      // Prepare search pattern
      const searchPattern = search ? `%${search}%` : '';
      const tagPattern = tagFilter ? `%"${tagFilter}"%` : '';
      
      // Execute query with all parameters
      const docs = getHistoryPaginatedFiltered.all(
        searchPattern, searchPattern, searchPattern, // search in title and correspondent
        tagPattern, tagPattern, // tag filter
        correspondentFilter, correspondentFilter, // correspondent exact match
        sortColumn, sortDir, // 1st sort option
        sortColumn, sortDir, // 2nd sort option
        sortColumn, sortDir, // 3rd sort option
        sortColumn, sortDir, // 4th sort option
        sortColumn, sortDir, // 5th sort option
        sortColumn, sortDir, // 6th sort option
        sortColumn, sortDir, // 7th sort option
        sortColumn, sortDir, // 8th sort option
        limit, offset
      );
      
      return docs;
    } catch (error) {
      console.error('[ERROR] getting paginated filtered history:', error);
      return [];
    }
  },

  async getHistoryCountFiltered({ search = '', tagFilter = '', correspondentFilter = '' }) {
    try {
      const searchPattern = search ? `%${search}%` : '';
      const tagPattern = tagFilter ? `%"${tagFilter}"%` : '';
      
      const result = getHistoryCountFiltered.get(
        searchPattern, searchPattern, searchPattern,
        tagPattern, tagPattern,
        correspondentFilter, correspondentFilter
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
      return results.map(row => row.correspondent).filter(Boolean);
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
  
      const ids = Array.isArray(idList) ? idList : (idList?.ids || []);
  
      if (!Array.isArray(ids) || ids.length === 0) {
        console.error('[ERROR] Invalid input: must provide an array of ids');
        return false;
      }
  
      // Convert string IDs to integers
      const numericIds = ids.map(id => parseInt(id, 10));
  
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
      console.log(`[DEBUG] Documents with IDs ${numericIds.join(', ')} deleted`);
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
      const result = db.prepare(
        'UPDATE users SET mfa_enabled = ?, mfa_secret = ? WHERE username = ?'
      ).run(enabled ? 1 : 0, secret, username);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] updating user MFA settings:', error);
      return false;
    }
  },

  async getLastSeenChangelogVersion(username) {
    try {
      const row = db.prepare('SELECT last_seen_changelog_version FROM users WHERE username = ?').get(username);
      return row ? row.last_seen_changelog_version : null;
    } catch (error) {
      console.error('[ERROR] getting last seen changelog version:', error);
      return null;
    }
  },

  async setLastSeenChangelogVersion(username, version) {
    try {
      const result = db.prepare(
        'UPDATE users SET last_seen_changelog_version = ? WHERE username = ?'
      ).run(version, username);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] setting last seen changelog version:', error);
      return false;
    }
  },

  async getProcessingTimeStats() {
    try {
      return db.prepare(`
        SELECT 
          strftime('%H', processed_at) as hour,
          COUNT(*) as count
        FROM processed_documents 
        WHERE date(processed_at) = date('now')
        GROUP BY hour
        ORDER BY hour
      `).all();
    } catch (error) {
      console.error('[ERROR] getting processing time stats:', error);
      return [];
    }
  },
  
  async  getTokenDistribution() {
    try {
      return db.prepare(`
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
      `).all();
    } catch (error) {
      console.error('[ERROR] getting token distribution:', error);
      return [];
    }
  },
  
  async getDocumentTypeStats() {
    try {
      return db.prepare(`
        SELECT 
          substr(title, 1, instr(title || ' ', ' ') - 1) as type,
          COUNT(*) as count
        FROM processed_documents
        GROUP BY type
      `).all();
    } catch (error) {
      console.error('[ERROR] getting document type stats:', error);
      return [];
    }
},

  async getTokenTrend(days = 7) {
    try {
      const safeDays = Math.max(1, Number(days) || 7);
      const dayOffset = `-${safeDays - 1} days`;
      return db.prepare(`
        SELECT
          date(created_at, 'localtime') as day,
          COUNT(*) as documents,
          SUM(totalTokens) as totalTokens
        FROM openai_metrics
        WHERE date(created_at, 'localtime') >= date('now', 'localtime', ?)
        GROUP BY day
        ORDER BY day ASC
      `).all(dayOffset);
    } catch (error) {
      console.error('[ERROR] getting token trend:', error);
      return [];
    }
  },

  async getRecentHistoryDocuments(limit = 4) {
    try {
      const safeLimit = Math.max(1, Math.min(20, Number(limit) || 6));
      return db.prepare(`
        SELECT
          document_id as documentId,
          title,
          correspondent,
          created_at as createdAt,
          language
        FROM history_documents
        ORDER BY created_at DESC
        LIMIT ?
      `).all(safeLimit);
    } catch (error) {
      console.error('[ERROR] getting recent history documents:', error);
      return [];
    }
  },

  async getLanguageDistribution(limit = 5) {
    try {
      const safeLimit = Math.max(1, Math.min(10, Number(limit) || 5));
      return db.prepare(`
        SELECT
          COALESCE(NULLIF(language, ''), 'Unknown') as language,
          COUNT(*) as count
        FROM history_documents
        GROUP BY COALESCE(NULLIF(language, ''), 'Unknown')
        ORDER BY count DESC
        LIMIT ?
      `).all(safeLimit);
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
      const lastProcessed = db.prepare(`
          SELECT 
              document_id, 
              title, 
              datetime(processed_at) as processed_at 
          FROM processed_documents 
          ORDER BY processed_at DESC 
          LIMIT 1`
      ).get();

      const processedToday = db.prepare(`
          SELECT COUNT(*) as count 
          FROM processed_documents 
          WHERE date(processed_at) = date('now', 'localtime')`
      ).get();

      return {
          currentlyProcessing: active ? {
              documentId: active.document_id,
              title: active.title,
              startTime: active.start_time,
              status: active.status
          } : null,
          lastProcessed: lastProcessed ? {
              documentId: lastProcessed.document_id,
              title: lastProcessed.title,
              processed_at: lastProcessed.processed_at
          } : null,
          processedToday: processedToday.count,
          isProcessing: !!active
      };
  } catch (error) {
      console.error('[ERROR] getting current processing status:', error);
      return {
          currentlyProcessing: null,
          lastProcessed: null,
          processedToday: 0,
          isProcessing: false
      };
  }
},


  // Utility method to close the database connection
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

  async addToOcrQueue(documentId, title, reason = 'manual') {
    try {
      const result = db.prepare(`
        INSERT INTO ocr_queue (document_id, title, reason, status)
        VALUES (?, ?, ?, 'pending')
        ON CONFLICT(document_id) DO UPDATE SET
          title = excluded.title,
          reason = excluded.reason,
          status = CASE WHEN status = 'done' THEN 'done' ELSE 'pending' END,
          added_at = CASE WHEN status = 'done' THEN added_at ELSE CURRENT_TIMESTAMP END
        WHERE status != 'processing'
      `).run(documentId, title, reason);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] adding to OCR queue:', error);
      return false;
    }
  },

  async getOcrQueue(status = null) {
    try {
      if (status) {
        return db.prepare('SELECT * FROM ocr_queue WHERE status = ? ORDER BY added_at DESC').all(status);
      }
      return db.prepare('SELECT * FROM ocr_queue ORDER BY added_at DESC').all();
    } catch (error) {
      console.error('[ERROR] getting OCR queue:', error);
      return [];
    }
  },

  async getOcrQueuePaginated({ search = '', statusFilter = '', limit = 10, offset = 0 }) {
    try {
      const searchPattern = search ? `%${search}%` : '%';
      const docs = db.prepare(`
        SELECT * FROM ocr_queue
        WHERE (title LIKE ? OR CAST(document_id AS TEXT) LIKE ?)
          AND (? = '' OR status = ?)
        ORDER BY added_at DESC
        LIMIT ? OFFSET ?
      `).all(searchPattern, searchPattern, statusFilter, statusFilter, limit, offset);
      const countRow = db.prepare(`
        SELECT COUNT(*) as count FROM ocr_queue
        WHERE (title LIKE ? OR CAST(document_id AS TEXT) LIKE ?)
          AND (? = '' OR status = ?)
      `).get(searchPattern, searchPattern, statusFilter, statusFilter);
      return { docs, total: countRow.count };
    } catch (error) {
      console.error('[ERROR] getting paginated OCR queue:', error);
      return { docs: [], total: 0 };
    }
  },

  async getOcrQueueItem(documentId) {
    try {
      return db.prepare('SELECT * FROM ocr_queue WHERE document_id = ?').get(documentId);
    } catch (error) {
      console.error('[ERROR] getting OCR queue item:', error);
      return null;
    }
  },

  async updateOcrQueueStatus(documentId, status, ocrText = null) {
    try {
      const result = db.prepare(`
        UPDATE ocr_queue SET
          status = ?,
          ocr_text = COALESCE(?, ocr_text),
          processed_at = CASE WHEN ? IN ('done', 'failed') THEN CURRENT_TIMESTAMP ELSE processed_at END
        WHERE document_id = ?
      `).run(status, ocrText, status, documentId);
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
          .filter((documentId) => Number.isInteger(documentId) && documentId > 0)
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
      const result = db.prepare('DELETE FROM ocr_queue WHERE document_id = ?').run(documentId);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] removing from OCR queue:', error);
      return false;
    }
  },

  async getOcrQueueCount() {
    try {
      return db.prepare("SELECT COUNT(*) as count FROM ocr_queue WHERE status = 'pending'").get().count;
    } catch (error) {
      console.error('[ERROR] getting OCR queue count:', error);
      return 0;
    }
  },

  async getOcrFailedCount() {
    try {
      return db.prepare("SELECT COUNT(*) as count FROM ocr_queue WHERE status = 'failed'").get().count;
    } catch (error) {
      console.error('[ERROR] getting OCR failed count:', error);
      return 0;
    }
  },

  async getFailedProcessingCount() {
    try {
      return db.prepare("SELECT COUNT(*) as count FROM processing_status WHERE status = 'failed'").get().count;
    } catch (error) {
      console.error('[ERROR] getting processing failed count:', error);
      return 0;
    }
  },

  async addFailedDocument(documentId, title, failedReason = 'unknown_failure', source = 'ai') {
    try {
      const result = db.prepare(`
        INSERT INTO failed_documents (document_id, title, failed_reason, source)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          title = excluded.title,
          failed_reason = excluded.failed_reason,
          source = excluded.source,
          updated_at = CURRENT_TIMESTAMP
      `).run(documentId, title, failedReason, source);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] adding failed document:', error);
      return false;
    }
  },

  async isDocumentFailed(documentId) {
    try {
      const row = db.prepare('SELECT 1 FROM failed_documents WHERE document_id = ?').get(documentId);
      return !!row;
    } catch (error) {
      console.error('[ERROR] checking failed document:', error);
      return false;
    }
  },

  async getFailedDocumentsPaginated({ search = '', limit = 10, offset = 0 }) {
    try {
      const searchPattern = search ? `%${search}%` : '%';
      const docs = db.prepare(`
        SELECT * FROM failed_documents
        WHERE (title LIKE ? OR CAST(document_id AS TEXT) LIKE ? OR failed_reason LIKE ? OR source LIKE ?)
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `).all(searchPattern, searchPattern, searchPattern, searchPattern, limit, offset);

      const countRow = db.prepare(`
        SELECT COUNT(*) as count FROM failed_documents
        WHERE (title LIKE ? OR CAST(document_id AS TEXT) LIKE ? OR failed_reason LIKE ? OR source LIKE ?)
      `).get(searchPattern, searchPattern, searchPattern, searchPattern);

      return { docs, total: countRow.count };
    } catch (error) {
      console.error('[ERROR] getting paginated failed documents:', error);
      return { docs: [], total: 0 };
    }
  },

  async resetFailedDocument(documentId) {
    try {
      const result = db.prepare('DELETE FROM failed_documents WHERE document_id = ?').run(documentId);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] resetting failed document:', error);
      return false;
    }
  },

  async resetAllFailedDocuments() {
    try {
      const resetAll = db.transaction(() => {
        const rows = db.prepare('SELECT document_id FROM failed_documents').all();
        if (!rows.length) {
          return 0;
        }

        const documentIds = rows.map((row) => row.document_id);
        const deleteFailedResult = db.prepare('DELETE FROM failed_documents').run();

        const placeholders = documentIds.map(() => '?').join(', ');
        db.prepare(`DELETE FROM processing_status WHERE document_id IN (${placeholders})`).run(...documentIds);

        return deleteFailedResult.changes;
      });

      return resetAll();
    } catch (error) {
      console.error('[ERROR] resetting all failed documents:', error);
      return 0;
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
  }
};
