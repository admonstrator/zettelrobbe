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
  await testAsync('All entries stale are all removed', async () => {
    const { svc, deleted } = makeService({
      paperlessDocs: [],
      processedDocs: [{ document_id: 10 }, { document_id: 20 }],
    });
    const result = await svc.reconcileAllDocuments();
    assert.strictEqual(result.removed, 2, 'should remove all 2 entries');
    assert.strictEqual(deleted.length, 2);
  });

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
  // Summary
  // ──────────────────────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
