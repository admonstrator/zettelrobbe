/**
 * Test Script for ReconciliationService
 *
 * Tests the following scenarios:
 * 1. Stale ID detection (IDs in DB but not in Paperless-ngx)
 * 2. Null / invalid document_id safety (guard against corrupted rows)
 * 3. Duplicate-run guard (isReconciling flag)
 * 4. Scan-wait / queue behaviour
 * 5. Empty result (no stale entries)
 * 6. All entries stale
 * 7. Paperless-ngx API failure (graceful degradation)
 * 8. isReconciling reset after run
 * 9. getAllDocuments called with applyFilters:false (IGNORE_TAGS must not affect reconciliation)
 *
 * The cases from "Real ReconciliationService" downwards load the actual
 * singleton instead of the stand-in above, and cover the vetoes that keep an
 * incomplete Paperless-ngx answer from deleting local records:
 * 10. A 502 on page 2 of the document list deletes nothing
 * 11. A refused connection on page 1 deletes nothing
 * 12. A rejected token deletes nothing (and never asks for the list)
 * 13. An empty document list deletes nothing
 * 14. A list sharing no id with the local tables deletes nothing
 * 15. A complete list still removes exactly the stale ids
 * 16. getAllDocuments is asked for the unfiltered list, strictly
 */

'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌  ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers to create lightweight in-process stubs (no I/O)
//
// makeService() below is a stand-in that reimplements the stale-ID arithmetic
// rather than loading services/reconciliationService.js. It still documents
// what that arithmetic must produce, but it deliberately does NOT carry the
// vetoes the real service gained (connection probe, strict document list,
// empty-list and all-stale refusals) — see "Real ReconciliationService" at the
// bottom of this file, which exercises the actual singleton for those.
// ──────────────────────────────────────────────────────────────────────────────

function makeService({
  paperlessDocs,
  processedDocs,
  scanRunning = false,
  deleteDelay = 0,
} = {}) {
  const deleted = [];

  // Minimal stubs that match the real module interfaces
  const paperlessService = {
    async getAllDocuments() {
      return paperlessDocs;
    },
  };

  const documentModel = {
    async getProcessedDocuments() {
      return processedDocs;
    },
    async deleteDocumentsIdList(ids) {
      if (deleteDelay) await new Promise((r) => setTimeout(r, deleteDelay));
      ids.forEach((id) => deleted.push(id));
    },
  };

  // Build the service with injected dependencies via module internals
  // We load the module fresh each time by constructing it manually.
  const { ReconciliationService } = (() => {
    'use strict';
    class ReconciliationService {
      constructor(pSvc, dModel) {
        this._paperlessService = pSvc;
        this._documentModel = dModel;
        this.isReconciling = false;
      }

      _getScanControl() {
        return global.__paperlessAiScanControl || { running: scanRunning };
      }

      async _waitForScanIdle(timeoutMs = 100) {
        const deadline = Date.now() + timeoutMs;
        while (this._getScanControl().running) {
          if (Date.now() >= deadline) return false;
          await new Promise((r) => setTimeout(r, 10));
        }
        return true;
      }

      async reconcileAllDocuments() {
        if (this.isReconciling) {
          return { skipped: true, removed: 0, durationMs: 0 };
        }
        const ready = await this._waitForScanIdle();
        if (!ready) return { skipped: true, removed: 0, durationMs: 0 };

        this.isReconciling = true;
        const startMs = Date.now();
        try {
          let paperlessDocs_;
          try {
            paperlessDocs_ = await this._paperlessService.getAllDocuments({
              applyFilters: false,
            });
          } catch {
            return {
              skipped: true,
              removed: 0,
              durationMs: Date.now() - startMs,
            };
          }

          const validIdSet = new Set(
            paperlessDocs_
              .map((d) => d.id)
              .filter((id) => Number.isInteger(id) && id > 0)
          );

          let processedDocs_;
          try {
            processedDocs_ = await this._documentModel.getProcessedDocuments();
          } catch {
            return {
              skipped: true,
              removed: 0,
              durationMs: Date.now() - startMs,
            };
          }

          const staleIds = processedDocs_
            .map((d) => d.document_id)
            .filter((id) => {
              if (!id || !Number.isInteger(Number(id)) || Number(id) <= 0)
                return false;
              return !validIdSet.has(Number(id));
            });

          if (staleIds.length === 0) {
            return {
              skipped: false,
              removed: 0,
              durationMs: Date.now() - startMs,
            };
          }

          try {
            await this._documentModel.deleteDocumentsIdList(staleIds);
          } catch {
            return {
              skipped: false,
              removed: 0,
              durationMs: Date.now() - startMs,
            };
          }

          return {
            skipped: false,
            removed: staleIds.length,
            durationMs: Date.now() - startMs,
          };
        } finally {
          this.isReconciling = false;
        }
      }
    }
    return { ReconciliationService };
  })();

  const svc = new ReconciliationService(paperlessService, documentModel);
  return { svc, deleted };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n🧪  ReconciliationService – Unit Tests');
  console.log('='.repeat(60));

  // 1. No stale entries
  await testAsync('No stale entries returns removed=0', async () => {
    const { svc, deleted } = makeService({
      paperlessDocs: [{ id: 1 }, { id: 2 }, { id: 3 }],
      processedDocs: [
        { document_id: 1 },
        { document_id: 2 },
        { document_id: 3 },
      ],
    });
    const result = await svc.reconcileAllDocuments();
    assert.strictEqual(result.removed, 0, 'removed should be 0');
    assert.strictEqual(result.skipped, false, 'skipped should be false');
    assert.strictEqual(deleted.length, 0, 'nothing should be deleted');
  });

  // 2. Some stale entries
  await testAsync(
    'Stale entries are detected and passed to delete',
    async () => {
      const { svc, deleted } = makeService({
        paperlessDocs: [{ id: 1 }, { id: 3 }],
        processedDocs: [
          { document_id: 1 },
          { document_id: 2 },
          { document_id: 3 },
          { document_id: 4 },
        ],
      });
      const result = await svc.reconcileAllDocuments();
      assert.strictEqual(result.removed, 2, 'should remove 2 stale entries');
      assert.ok(deleted.includes(2), 'id 2 should be deleted');
      assert.ok(deleted.includes(4), 'id 4 should be deleted');
    }
  );

  // 3. All entries stale
  await testAsync(
    'Stale arithmetic: all entries stale are all detected',
    async () => {
      const { svc, deleted } = makeService({
        paperlessDocs: [],
        processedDocs: [{ document_id: 10 }, { document_id: 20 }],
      });
      const result = await svc.reconcileAllDocuments();
      assert.strictEqual(result.removed, 2, 'should remove all 2 entries');
      assert.strictEqual(deleted.length, 2);
    }
  );

  // 4. Invalid / null document_id rows are skipped safely
  await testAsync(
    'Null and invalid document_ids do not cause errors',
    async () => {
      const { svc } = makeService({
        paperlessDocs: [{ id: 5 }],
        processedDocs: [
          { document_id: null },
          { document_id: undefined },
          { document_id: 0 },
          { document_id: -1 },
          { document_id: 'abc' },
          { document_id: 5 },
        ],
      });
      const result = await svc.reconcileAllDocuments();
      assert.strictEqual(
        result.removed,
        0,
        'valid id 5 exists in paperless; nulls/invalids are filtered'
      );
      assert.strictEqual(result.skipped, false);
    }
  );

  // 5. Duplicate-run guard (isReconciling)
  await testAsync(
    'Concurrent call is skipped while first run is active',
    async () => {
      const { svc } = makeService({
        paperlessDocs: [{ id: 1 }],
        processedDocs: [{ document_id: 1 }],
      });
      // Simulate an already-running reconciliation
      svc.isReconciling = true;
      const result = await svc.reconcileAllDocuments();
      assert.strictEqual(result.skipped, true, 'should be skipped');
      svc.isReconciling = false; // cleanup
    }
  );

  // 6. isReconciling is reset to false after a successful run
  await testAsync('isReconciling is reset to false after run', async () => {
    const { svc } = makeService({
      paperlessDocs: [{ id: 1 }],
      processedDocs: [{ document_id: 1 }],
    });
    await svc.reconcileAllDocuments();
    assert.strictEqual(svc.isReconciling, false, 'flag should be cleared');
  });

  // 7. Scan-wait timeout causes skipped result
  await testAsync(
    'Scan still running after timeout causes skipped',
    async () => {
      // Override getScanControl to always return running=true
      const { svc } = makeService({
        paperlessDocs: [],
        processedDocs: [],
        scanRunning: true,
      });
      // _waitForScanIdle has a 100ms timeout in the test version
      const result = await svc.reconcileAllDocuments();
      assert.strictEqual(
        result.skipped,
        true,
        'should skip because scan never finished'
      );
    }
  );

  // 8. Paperless-ngx fetch error causes skipped result (graceful degradation)
  await testAsync(
    'Paperless-ngx API failure causes skipped=true not a throw',
    async () => {
      const { svc } = makeService({
        paperlessDocs: null, // will be overridden
        processedDocs: [],
      });
      svc._paperlessService = {
        async getAllDocuments() {
          throw new Error('Network error');
        },
      };
      const result = await svc.reconcileAllDocuments();
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(
        svc.isReconciling,
        false,
        'flag should be cleared even after error'
      );
    }
  );

  // 9. getAllDocuments must be called with applyFilters:false (fix for issue #111)
  await testAsync(
    'reconcileAllDocuments calls getAllDocuments with applyFilters:false',
    async () => {
      let capturedOptions;
      const { svc } = makeService({
        paperlessDocs: [{ id: 1 }, { id: 2 }],
        processedDocs: [{ document_id: 1 }, { document_id: 2 }],
      });
      // Override getAllDocuments to capture the options argument
      svc._paperlessService = {
        async getAllDocuments(options) {
          capturedOptions = options;
          return [{ id: 1 }, { id: 2 }];
        },
      };
      await svc.reconcileAllDocuments();
      assert.ok(
        capturedOptions && capturedOptions.applyFilters === false,
        'getAllDocuments must be called with { applyFilters: false } so IGNORE_TAGS does not delete history'
      );
    }
  );

  // 10. Documents excluded by IGNORE_TAGS are NOT treated as stale
  // This simulates the bug described in issue #111:
  // After a full run, IGNORE_TAGS is set so getAllDocuments (with filters)
  // would return 0 docs. With the fix, reconciliation always gets the
  // full list and treats nothing as stale.
  await testAsync(
    'IGNORE_TAGS filter does not cause previously-processed docs to be deleted',
    async () => {
      // Simulate: 5 docs were processed, IGNORE_TAGS is now active.
      // Without the fix, a filtered getAllDocuments would return 0 docs → all 5 stale.
      // With the fix, getAllDocuments is called with applyFilters:false → all 5 valid.
      const allDocs = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
      const processedDocs = allDocs.map((d) => ({ document_id: d.id }));

      const { svc, deleted } = makeService({
        paperlessDocs: allDocs,
        processedDocs,
      });

      // Simulate what happens when applyFilters:false is respected:
      // getAllDocuments ignores IGNORE_TAGS and returns the full list.
      // (The stub in makeService already ignores options and returns paperlessDocs.)
      const result = await svc.reconcileAllDocuments();

      assert.strictEqual(
        result.removed,
        0,
        'No documents should be removed when all exist in Paperless'
      );
      assert.strictEqual(
        deleted.length,
        0,
        'History must remain intact when IGNORE_TAGS changes scan scope'
      );
    }
  );

  // ──────────────────────────────────────────────────────────────────────────────
  // Real ReconciliationService — the vetoes that keep a bad answer from deleting
  //
  // These load services/reconciliationService.js itself, with the real
  // paperlessService.getAllDocuments() walking a fake HTTP client. The hourly
  // cron used to wipe processed_documents, history_documents and
  // original_documents whenever Paperless-ngx failed on any page: getAllDocuments
  // broke out of its loop and returned the pages it already had, and everything
  // behind the failed page looked deleted.
  // ──────────────────────────────────────────────────────────────────────────────

  const PAPERLESS_BASE_URL = 'http://paperless.test/api';

  /**
   * A Paperless-ngx that pages /documents/ and can fail on a chosen page.
   *
   * @param {object} options
   * @param {Array<Array<{id: number}>>} options.pages - one array of documents per page
   * @param {number|null} [options.failOnPage] - page number that answers with an error
   * @param {Error|null} [options.failWith] - the error that page throws (default: a 502)
   * @param {boolean} [options.connectionOk] - what the /users/ probe answers
   */
  function createPaperlessClient({
    pages,
    failOnPage = null,
    failWith = null,
    connectionOk = true,
  }) {
    const requestedPages = [];

    const httpError = (status, message) => {
      const error = new Error(message);
      error.response = { status, data: { detail: message } };
      return error;
    };

    return {
      requestedPages,
      defaults: { baseURL: PAPERLESS_BASE_URL },
      get: async (url, options = {}) => {
        if (url.startsWith('/users/')) {
          if (!connectionOk) {
            throw httpError(401, 'Invalid token.');
          }
          return { status: 200, data: { results: [{ id: 1 }] } };
        }

        const page = Number(options.params?.page) || 1;
        requestedPages.push(page);

        if (failOnPage !== null && page === failOnPage) {
          throw failWith || httpError(502, 'Bad Gateway');
        }

        const results = pages[page - 1] || [];
        return {
          status: 200,
          data: {
            results,
            next:
              page < pages.length
                ? `${PAPERLESS_BASE_URL}/documents/?page=${page + 1}`
                : null,
          },
        };
      },
    };
  }

  /**
   * Loads the real reconciliation singleton with the real paperlessService (its
   * client replaced) and a fake document model, so nothing opens a database.
   */
  function loadRealReconciliationService({ client, processedDocs }) {
    const paperlessPath = require.resolve('../services/paperlessService');
    const documentModelPath = require.resolve('../models/document');
    const reconciliationPath =
      require.resolve('../services/reconciliationService');

    const paperlessService = require('../services/paperlessService');
    paperlessService.client = client;

    const deleted = [];
    require.cache[documentModelPath] = {
      id: documentModelPath,
      filename: documentModelPath,
      loaded: true,
      exports: {
        async getProcessedDocuments() {
          return processedDocs;
        },
        async deleteDocumentsIdList(ids) {
          ids.forEach((id) => deleted.push(id));
        },
      },
    };
    require.cache[paperlessPath] = {
      id: paperlessPath,
      filename: paperlessPath,
      loaded: true,
      exports: paperlessService,
    };

    delete require.cache[reconciliationPath];
    const service = require('../services/reconciliationService');
    return { service, deleted, paperlessService };
  }

  // 11. A page that fails mid-walk must delete nothing
  await testAsync('Real service: a 502 on page 2 deletes nothing', async () => {
    const client = createPaperlessClient({
      pages: [[{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }], [{ id: 5 }]],
      failOnPage: 2,
    });
    const { service, deleted } = loadRealReconciliationService({
      client,
      processedDocs: [
        { document_id: 1 },
        { document_id: 3 },
        { document_id: 5 },
      ],
    });

    const result = await service.reconcileAllDocuments();

    assert.strictEqual(
      deleted.length,
      0,
      'a partial document list must delete nothing'
    );
    assert.strictEqual(
      result.skipped,
      true,
      'the run must report itself as skipped'
    );
    assert.strictEqual(result.removed, 0, 'nothing may be counted as removed');
    assert.strictEqual(
      result.reason,
      'document_list_incomplete',
      'the reason must name the incomplete list'
    );
  });

  // 12. A refused connection on page 1 must delete nothing
  await testAsync(
    'Real service: ECONNREFUSED on page 1 deletes nothing',
    async () => {
      const refused = new Error('connect ECONNREFUSED 127.0.0.1:8000');
      refused.code = 'ECONNREFUSED';
      const client = createPaperlessClient({
        pages: [[{ id: 1 }, { id: 2 }]],
        failOnPage: 1,
        failWith: refused,
      });
      const { service, deleted } = loadRealReconciliationService({
        client,
        processedDocs: [{ document_id: 1 }, { document_id: 2 }],
      });

      const result = await service.reconcileAllDocuments();

      assert.strictEqual(
        deleted.length,
        0,
        'an unreachable Paperless-ngx must delete nothing'
      );
      assert.strictEqual(
        result.skipped,
        true,
        'the run must report itself as skipped'
      );
      assert.strictEqual(
        result.reason,
        'document_list_incomplete',
        'the reason must name the incomplete list'
      );
    }
  );

  // 13. An unauthorized instance is not an empty archive
  await testAsync(
    'Real service: a rejected token deletes nothing',
    async () => {
      const client = createPaperlessClient({
        pages: [[{ id: 1 }]],
        connectionOk: false,
      });
      const { service, deleted } = loadRealReconciliationService({
        client,
        processedDocs: [{ document_id: 1 }, { document_id: 2 }],
      });

      const result = await service.reconcileAllDocuments();

      assert.strictEqual(
        deleted.length,
        0,
        'an unauthorized instance must delete nothing'
      );
      assert.strictEqual(
        result.reason,
        'paperless_unavailable',
        'the reason must name the unusable instance'
      );
      assert.strictEqual(
        client.requestedPages.length,
        0,
        'the document list must not even be requested'
      );
    }
  );

  // 14. An empty document list is refused, not obeyed
  await testAsync(
    'Real service: an empty document list deletes nothing',
    async () => {
      const client = createPaperlessClient({ pages: [[]] });
      const { service, deleted } = loadRealReconciliationService({
        client,
        processedDocs: [{ document_id: 1 }, { document_id: 2 }],
      });

      const result = await service.reconcileAllDocuments();

      assert.strictEqual(
        deleted.length,
        0,
        'an empty list must never wipe the local tables'
      );
      assert.strictEqual(
        result.skipped,
        true,
        'the run must report itself as skipped'
      );
      assert.strictEqual(
        result.reason,
        'empty_document_list',
        'the reason must name the empty list'
      );
    }
  );

  // 15. A list that shares no id with the local tables is refused
  await testAsync(
    'Real service: an all-stale result deletes nothing',
    async () => {
      const client = createPaperlessClient({
        pages: [[{ id: 900 }, { id: 901 }]],
      });
      const { service, deleted } = loadRealReconciliationService({
        client,
        processedDocs: [{ document_id: 1 }, { document_id: 2 }],
      });

      const result = await service.reconcileAllDocuments();

      assert.strictEqual(
        deleted.length,
        0,
        'wiping every tracked document at once must be refused'
      );
      assert.strictEqual(
        result.skipped,
        true,
        'the run must report itself as skipped'
      );
      assert.strictEqual(
        result.reason,
        'all_tracked_documents_stale',
        'the reason must name the all-stale result'
      );
    }
  );

  // 16. The happy path still removes exactly the stale ids
  await testAsync(
    'Real service: a complete list removes exactly the stale ids',
    async () => {
      const client = createPaperlessClient({
        pages: [[{ id: 1 }, { id: 2 }], [{ id: 3 }]],
      });
      const { service, deleted } = loadRealReconciliationService({
        client,
        processedDocs: [
          { document_id: 1 },
          { document_id: 2 },
          { document_id: 3 },
          { document_id: 42 },
          { document_id: 43 },
        ],
      });

      const result = await service.reconcileAllDocuments();

      assert.strictEqual(
        result.skipped,
        false,
        'a complete list must not be skipped'
      );
      assert.strictEqual(
        result.removed,
        2,
        'exactly the two stale ids must be removed'
      );
      assert.deepStrictEqual(
        deleted.sort((a, b) => a - b),
        [42, 43],
        'only the stale ids may be deleted'
      );
      assert.deepStrictEqual(
        client.requestedPages,
        [1, 2],
        'both pages must have been walked'
      );
    }
  );

  // 17. Reconciliation must ask for the unfiltered list, strictly
  await testAsync(
    'Real service: getAllDocuments is called with applyFilters:false and strict:true',
    async () => {
      const client = createPaperlessClient({ pages: [[{ id: 1 }, { id: 2 }]] });
      const { service, paperlessService } = loadRealReconciliationService({
        client,
        processedDocs: [{ document_id: 1 }],
      });

      let capturedOptions = null;
      const realGetAllDocuments = paperlessService.getAllDocuments;
      paperlessService.getAllDocuments = async (options) => {
        capturedOptions = options;
        return [{ id: 1 }, { id: 2 }];
      };

      try {
        await service.reconcileAllDocuments();
      } finally {
        paperlessService.getAllDocuments = realGetAllDocuments;
      }

      assert.ok(capturedOptions, 'getAllDocuments must be called');
      assert.strictEqual(
        capturedOptions.applyFilters,
        false,
        'IGNORE_TAGS must not narrow the reference set'
      );
      assert.strictEqual(
        capturedOptions.strict,
        true,
        'a partial list must be an error, not a shorter archive'
      );
    }
  );

  // ──────────────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
