/**
 * Handoff Cycle Repository
 *
 * Persistence layer for per-transition cycle counters, keyed by
 * `(run_id, transition_key)`. A `transition_key` is a stable composite identifier
 * composed by the runtime (e.g. `${sourceNodeId}/${transitionId}`) that uniquely
 * names one declared {@link HandoffTransition} occurrence within a run.
 *
 * Mirrors `ChannelCycleRepository`'s model: each cyclic handoff transition in a
 * workflow run has its own counter and cap, atomically incremented via an UPSERT
 * with a cap guard. Cyclicity is inferred from graph topology at runtime
 * (see `isCyclicHandoff`); only cyclic transitions are subject to `maxCycles`.
 */

import type { Database as BunDatabase } from '../sqlite-compat';

export interface HandoffCycleRecord {
  runId: string;
  transitionKey: string;
  count: number;
  maxCycles: number;
  updatedAt: number;
}

export class HandoffCycleRepository {
  constructor(private db: BunDatabase) {}

  /**
   * Returns the cycle record for a specific transition in a run, or null if none exists.
   */
  get(runId: string, transitionKey: string): HandoffCycleRecord | null {
    const row = this.db
      .prepare('SELECT * FROM handoff_cycles WHERE run_id = ? AND transition_key = ?')
      .get(runId, transitionKey) as HandoffCycleRow | null;
    return row ? rowToRecord(row) : null;
  }

  /**
   * True when the counter has already reached the supplied `maxCycles` cap.
   * Read-only pre-check used to block a handoff BEFORE activation/delivery.
   */
  isCapReached(runId: string, transitionKey: string, maxCycles: number): boolean {
    const record = this.get(runId, transitionKey);
    if (!record) return false;
    // Compare against the supplied cap (not the persisted max_cycles) so raising
    // the cap unblocks an in-flight run already at the old limit.
    return record.count >= maxCycles;
  }

  /**
   * Atomically increments the cycle counter for a transition.
   *
   * On first call for a (run, transition) pair, inserts a new row with count=1.
   * On subsequent calls, increments only if the current count is below the
   * supplied `maxCycles` (not the persisted `max_cycles`), so raising the cap
   * unblocks an in-flight run already at the old limit.
   *
   * @returns `true` if the counter was incremented, `false` if the cap was reached.
   */
  increment(runId: string, transitionKey: string, maxCycles: number): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO handoff_cycles (run_id, transition_key, count, max_cycles, updated_at)
				 VALUES (?, ?, 1, ?, ?)
				 ON CONFLICT (run_id, transition_key)
				 DO UPDATE SET count = count + 1, max_cycles = ?, updated_at = ?
				 WHERE count < ?`
      )
      .run(runId, transitionKey, maxCycles, now, maxCycles, now, maxCycles);
    return result.changes > 0;
  }

  /**
   * Resets the cycle counter for a specific transition back to 0.
   */
  reset(runId: string, transitionKey: string): void {
    this.db
      .prepare(
        'UPDATE handoff_cycles SET count = 0, updated_at = ? WHERE run_id = ? AND transition_key = ?'
      )
      .run(Date.now(), runId, transitionKey);
  }

  /**
   * Zeros every handoff cycle counter for a run in a single statement.
   *
   * The cap measures "consecutive autonomous cycles without human oversight", so
   * all transitions reset together whenever the run regains human attention
   * (mirrors `ChannelCycleRepository.resetAllForRun`).
   *
   * @returns Number of rows updated (0 is valid — no cyclic transitions yet).
   */
  resetAllForRun(runId: string): number {
    const result = this.db
      .prepare('UPDATE handoff_cycles SET count = 0, updated_at = ? WHERE run_id = ?')
      .run(Date.now(), runId);
    return result.changes;
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface HandoffCycleRow {
  run_id: string;
  transition_key: string;
  count: number;
  max_cycles: number;
  updated_at: number;
}

function rowToRecord(row: HandoffCycleRow): HandoffCycleRecord {
  return {
    runId: row.run_id,
    transitionKey: row.transition_key,
    count: row.count,
    maxCycles: row.max_cycles,
    updatedAt: row.updated_at,
  };
}
