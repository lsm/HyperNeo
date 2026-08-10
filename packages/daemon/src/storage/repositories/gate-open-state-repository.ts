/**
 * Gate Open State Repository
 *
 * Persistence layer for the gate-open cache, keyed by `(run_id, gate_id)`.
 * When a gate evaluates to `open: true`, the router records the workflow's
 * `updatedAt` timestamp so subsequent calls skip re-evaluation. On daemon
 * restart, the persisted state survives and avoids redundant re-evaluations.
 *
 * If the workflow definition changes (different `updatedAt`), the cached
 * entry is considered stale and the gate is re-evaluated.
 */

import type { Database as BunDatabase } from '../sqlite-compat';

/** Result of checking whether a gate is cached open. */
export interface GateOpenState {
  open: boolean;
  /** The `workflow.updatedAt` timestamp when the gate was cached open. */
  workflowUpdatedAt?: number;
}

export class GateOpenStateRepository {
  constructor(private db: BunDatabase) {}

  /**
   * Record that a gate has been opened for a given run.
   * Stores the workflow's `updatedAt` timestamp for staleness detection.
   */
  markOpened(runId: string, gateId: string, workflowUpdatedAt: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO gate_open_state (run_id, gate_id, opened_workflow_updated_at, opened_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(run_id, gate_id) DO UPDATE SET
				   opened_workflow_updated_at = excluded.opened_workflow_updated_at,
				   opened_at = excluded.opened_at`
      )
      .run(runId, gateId, workflowUpdatedAt, now);
  }

  /**
   * Check whether a gate is cached open for a given run.
   * Returns `{ open: true, workflowUpdatedAt }` if a record exists,
   * or `{ open: false }` otherwise.
   */
  isOpen(runId: string, gateId: string): GateOpenState {
    const row = this.db
      .prepare(
        'SELECT opened_workflow_updated_at FROM gate_open_state WHERE run_id = ? AND gate_id = ?'
      )
      .get(runId, gateId) as Record<string, unknown> | undefined;
    if (!row) return { open: false };
    return { open: true, workflowUpdatedAt: row.opened_workflow_updated_at as number };
  }

  /**
   * Clear the cached open state for a single gate in a run.
   * Used when `resetOnCycle` resets a gate's data.
   * Returns true if a record was deleted.
   */
  clearOpened(runId: string, gateId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM gate_open_state WHERE run_id = ? AND gate_id = ?')
      .run(runId, gateId);
    return result.changes > 0;
  }

  /**
   * Clear all cached open state for a workflow run.
   * Used when a run reaches a terminal status (done/cancelled),
   * when the parent task is archived, or when a terminal run is reopened.
   * Returns the number of records deleted.
   */
  clearOpenedByRun(runId: string): number {
    const result = this.db.prepare('DELETE FROM gate_open_state WHERE run_id = ?').run(runId);
    return result.changes;
  }

  /**
   * List every gate currently cached open for a run, with its stored fingerprint. Used by
   * the Phase-1 read-cutover backfill to re-key persisted entries to the version-stable
   * fingerprint basis so they survive the cutover without re-evaluation.
   */
  listOpenedByRun(runId: string): Array<{ gateId: string; workflowUpdatedAt: number }> {
    const rows = this.db
      .prepare('SELECT gate_id, opened_workflow_updated_at FROM gate_open_state WHERE run_id = ?')
      .all(runId) as Array<{ gate_id: string; opened_workflow_updated_at: number }>;
    return rows.map((r) => ({
      gateId: r.gate_id,
      workflowUpdatedAt: r.opened_workflow_updated_at,
    }));
  }

  /**
   * List every persisted gate-open entry across all runs. Used by the Phase-1 read-cutover
   * startup sweep to re-key entries whose run is pinned to the version-stable fingerprint
   * basis — so a backfilled in-flight run's cache survives the cutover, and a crash between
   * pin and re-key is recovered on the next boot.
   */
  listAllOpenEntries(): Array<{ runId: string; gateId: string; workflowUpdatedAt: number }> {
    const rows = this.db
      .prepare('SELECT run_id, gate_id, opened_workflow_updated_at FROM gate_open_state')
      .all() as Array<{ run_id: string; gate_id: string; opened_workflow_updated_at: number }>;
    return rows.map((r) => ({
      runId: r.run_id,
      gateId: r.gate_id,
      workflowUpdatedAt: r.opened_workflow_updated_at,
    }));
  }
}
