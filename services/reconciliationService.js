/**
 * ReconciliationService
 *
 * Periodically diffs the Paperless-ngx document list against the local AI
 * database tables (processed_documents, history_documents, original_documents)
 * and removes entries for documents that have been deleted in Paperless-ngx.
 *
 * The service is intentionally decoupled from the scan cycle so it can run
 * on its own schedule (RECONCILIATION_INTERVAL) without blocking or duplicating
 * scan logic.  If a scan is in progress when reconciliation is triggered the
 * service waits for the scan to finish before proceeding.
 */

const paperlessService = require('./paperlessService');
const documentModel = require('../models/document');

/** Maximum time (ms) to wait for an active scan to complete before giving up. */
const SCAN_WAIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** Polling interval (ms) while waiting for a scan to finish. */
const SCAN_POLL_INTERVAL_MS = 2000;

class ReconciliationService {
  constructor() {
    /** Whether a reconciliation run is currently in progress. */
    this.isReconciling = false;
  }

  /**
   * Returns the shared scan-control object written by server.js.
   * Accessing it lazily avoids circular-require issues at module load time.
   * @returns {{ running: boolean }}
   */
  _getScanControl() {
    return global.__paperlessAiScanControl || { running: false };
  }

  /**
   * Waits until the active document scan has finished (or the timeout expires).
   * @returns {Promise<boolean>} true if the scan finished within the timeout, false if timed out.
   */
  async _waitForScanIdle() {
    const deadline = Date.now() + SCAN_WAIT_TIMEOUT_MS;
    while (this._getScanControl().running) {
      if (Date.now() >= deadline) {
        console.warn(
          '[RECONCILIATION] Timed out waiting for scan to finish. Skipping this run.'
        );
        return false;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, SCAN_POLL_INTERVAL_MS)
      );
    }
    return true;
  }

  /**
   * Performs a full reconciliation pass:
   * 1. Confirms Paperless-ngx is reachable and the token is accepted.
   * 2. Fetches all current document IDs from Paperless-ngx, strictly.
   * 3. Compares them with the IDs stored in processed_documents.
   * 4. Deletes stale entries (across all three AI-DB tables) via
   *    deleteDocumentsIdList(), which already handles processed_documents,
   *    history_documents, and original_documents in a single call.
   *
   * Every step before the delete is a veto. This pass is the only thing in the
   * app that removes local records on its own, and the record it removes from
   * original_documents is the only copy of a document's pre-AI state — so an
   * answer that merely looks like an empty archive must never be acted upon.
   * A run that vetoes returns `skipped: true` with a `reason`, and the next
   * scheduled run reconciles again once Paperless-ngx answers properly.
   *
   * @returns {Promise<{skipped: boolean, removed: number, durationMs: number, reason?: string}>}
   */
  async reconcileAllDocuments() {
    if (this.isReconciling) {
      console.debug(
        '[RECONCILIATION] Already running. Skipping duplicate trigger.'
      );
      return {
        skipped: true,
        removed: 0,
        durationMs: 0,
        reason: 'already_running',
      };
    }

    // Queue: wait for an active scan to complete first.
    const ready = await this._waitForScanIdle();
    if (!ready) {
      return {
        skipped: true,
        removed: 0,
        durationMs: 0,
        reason: 'scan_in_progress',
      };
    }

    this.isReconciling = true;
    const startMs = Date.now();

    try {
      console.debug('[RECONCILIATION] Starting reconciliation pass...');

      // A probe before the list: an unreachable host or a rejected token turns
      // every following read into "no documents", which is indistinguishable
      // from an emptied archive once the ids are in a Set.
      let connection;
      try {
        connection = await paperlessService.checkConnection();
      } catch (err) {
        console.warn(
          `[RECONCILIATION] Connection check failed: ${err.message}. Skipping this run.`
        );
        return {
          skipped: true,
          removed: 0,
          durationMs: Date.now() - startMs,
          reason: 'connection_check_failed',
        };
      }

      if (!connection?.reachable || !connection?.authorized) {
        console.warn(
          `[RECONCILIATION] Paperless-ngx is not usable (reachable=${!!connection?.reachable}, ` +
            `authorized=${!!connection?.authorized}, status=${connection?.status ?? 'none'}). Skipping this run.`
        );
        return {
          skipped: true,
          removed: 0,
          durationMs: Date.now() - startMs,
          reason: 'paperless_unavailable',
        };
      }

      // --- Fetch valid document IDs from Paperless-ngx ---
      // Use applyFilters: false so that IGNORE_TAGS / PROCESS_PREDEFINED_DOCUMENTS
      // scan-scope settings do not affect the reconciliation reference set.
      // Reconciliation must compare against the full Paperless-ngx document list,
      // not the narrowed scan scope — otherwise documents excluded by IGNORE_TAGS
      // would be wrongly treated as deleted and removed from history.
      let paperlessDocs;
      try {
        console.debug(
          '[RECONCILIATION] Fetching unfiltered document list (bypassing IGNORE_TAGS/TAGS scan filters)'
        );
        // strict: a partial list is not a shorter archive. Without it a 502 on
        // page 2 delivered the pages fetched so far, and everything behind the
        // failed page was deleted as stale.
        paperlessDocs = await paperlessService.getAllDocuments({
          applyFilters: false,
          strict: true,
        });
      } catch (err) {
        console.error(
          `[RECONCILIATION] Failed to fetch documents from Paperless-ngx: ${err.message}`
        );
        return {
          skipped: true,
          removed: 0,
          durationMs: Date.now() - startMs,
          reason: 'document_list_incomplete',
        };
      }

      if (!Array.isArray(paperlessDocs) || paperlessDocs.length === 0) {
        console.warn(
          '[RECONCILIATION] Paperless-ngx reported no documents at all. ' +
            'Refusing to treat that as a deletion of the entire archive. Skipping this run.'
        );
        return {
          skipped: true,
          removed: 0,
          durationMs: Date.now() - startMs,
          reason: 'empty_document_list',
        };
      }

      // Build a Set of valid, positive integer IDs for O(1) lookups.
      const validIdSet = new Set(
        paperlessDocs
          .map((d) => d.id)
          .filter((id) => Number.isInteger(id) && id > 0)
      );

      // --- Fetch locally tracked processed documents ---
      let processedDocs;
      try {
        processedDocs = await documentModel.getProcessedDocuments();
      } catch (err) {
        console.error(
          `[RECONCILIATION] Failed to read processed_documents: ${err.message}`
        );
        return {
          skipped: true,
          removed: 0,
          durationMs: Date.now() - startMs,
          reason: 'processed_documents_unreadable',
        };
      }

      // --- Find stale IDs (in AI DB but no longer in Paperless-ngx) ---
      const trackedIds = processedDocs
        .map((d) => d.document_id)
        .filter((id) => {
          if (!id || !Number.isInteger(Number(id)) || Number(id) <= 0) {
            console.warn(
              `[RECONCILIATION] Skipping invalid document_id: ${id}`
            );
            return false;
          }
          return true;
        });

      const staleIds = trackedIds.filter((id) => !validIdSet.has(Number(id)));

      if (staleIds.length === 0) {
        const durationMs = Date.now() - startMs;
        console.debug(
          `[RECONCILIATION] No stale entries found. (${durationMs}ms)`
        );
        return { skipped: false, removed: 0, durationMs };
      }

      // A run in which not one tracked document is still present is the shape
      // every remaining failure mode takes — a list from the wrong instance, a
      // token scoped to a different user, an answer that parsed but held
      // foreign ids. A genuine "the user emptied the archive" looks identical
      // from here, so it is deferred to a human rather than acted on: nothing
      // is deleted and the counts say what was seen. The cost is that an
      // archive whose every processed document really was deleted has to be
      // cleaned up by hand; that is the cheaper mistake of the two.
      if (staleIds.length === trackedIds.length) {
        console.warn(
          `[RECONCILIATION] All ${trackedIds.length} tracked documents would be deleted at once ` +
            `(Paperless-ngx returned ${validIdSet.size} document ids). This looks like a bad answer, ` +
            'not an emptied archive. Refusing to delete; remove the entries manually if they really are gone.'
        );
        return {
          skipped: true,
          removed: 0,
          durationMs: Date.now() - startMs,
          reason: 'all_tracked_documents_stale',
        };
      }

      // --- Delete stale entries from all three AI-DB tables ---
      try {
        await documentModel.deleteDocumentsIdList(staleIds);
      } catch (err) {
        console.error(
          `[RECONCILIATION] Failed to delete stale entries: ${err.message}`
        );
        return {
          skipped: false,
          removed: 0,
          durationMs: Date.now() - startMs,
          reason: 'delete_failed',
        };
      }

      const durationMs = Date.now() - startMs;
      console.info(
        `[RECONCILIATION] Removed ${staleIds.length} stale entries in ${durationMs}ms.`
      );
      return { skipped: false, removed: staleIds.length, durationMs };
    } finally {
      this.isReconciling = false;
    }
  }
}

module.exports = new ReconciliationService();
