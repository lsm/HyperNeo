/**
 * Handoff Cycle Repository
 *
 * Persistence layer for per-transition cycle counters, keyed by
 * `(run_id, transition_key)`. A `transition_key` is a stable composite identifier
 * composed by the runtime as `${encodeURIComponent(sourceNodeId)}/${encodeURIComponent(transitionId)}`
 * (both parts URI-encoded so a literal '/' in an id can't collide with the
 * delimiter) that uniquely names one declared {@link HandoffTransition}
 * occurrence within a run.
 *
 * Mirrors `ChannelCycleRepository`'s model: each cyclic handoff transition in a
 * workflow run has its own counter and cap, atomically incremented via an UPSERT
 * with a cap guard. Cyclicity is inferred from graph topology at runtime
 * (see `isCyclicHandoff`); only cyclic transitions are subject to `maxCycles`.
 *
 * Reservations are epoch-tagged: a human-touch reset bumps every row's `epoch`,
 * so a refund for a pre-reset reservation is a no-op (its epoch no longer
 * matches) and cannot decrement a different handoff's post-reset reservation —
 * preventing the configured cap from being exceeded across a reset boundary.
 */

import type { Database as BunDatabase } from '../sqlite-compat';

export interface HandoffCycleRecord {
  runId: string;
  transitionKey: string;
  count: number;
  maxCycles: number;
  epoch: number;
  updatedAt: number;
}

/** Outcome of a {@link HandoffCycleRepository.increment} reservation attempt. */
export interface HandoffCycleReservation {
  /** `true` if a cycle was reserved (counter incremented), `false` if the cap was reached. */
  reserved: boolean;
  /** Epoch the reservation was made at; pass to {@link HandoffCycleRepository.decrement} to refund. */
  epoch: number;
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
   * Atomically reserves a cycle for a transition.
   *
   * On first call for a (run, transition) pair, inserts a new row with count=1.
   * On subsequent calls, increments only if the current count is below the
   * supplied `maxCycles` (not the persisted `max_cycles`), so raising the cap
   * unblocks an in-flight run already at the old limit.
   *
   * @returns whether a cycle was reserved, plus the row's current epoch (pass it
   * to {@link decrement} for a safe refund).
   */
  increment(runId: string, transitionKey: string, maxCycles: number): HandoffCycleReservation {
    const now = Date.now();
    // One atomic statement both reserves the cycle and returns the epoch the
    // reservation landed at. RETURNING yields the row only when a write actually
    // occurred — on the cap (count >= maxCycles) the WHERE clause no-ops, no row
    // is returned, and reserved is false. Reading the epoch from the SAME
    // statement (instead of a separate get()) closes the reset race where
    // resetAllForRun could bump the epoch between the UPSERT and the read,
    // which would let a later refund identify the wrong reservation.
    const row = this.db
      .prepare(
        `INSERT INTO handoff_cycles (run_id, transition_key, count, max_cycles, epoch, updated_at)
				 VALUES (?, ?, 1, ?, 0, ?)
				 ON CONFLICT (run_id, transition_key)
				 DO UPDATE SET count = count + 1, max_cycles = ?, updated_at = ?
				 WHERE count < ?
				 RETURNING epoch`
      )
      .get(runId, transitionKey, maxCycles, now, maxCycles, now, maxCycles) as
      | { epoch: number }
      | undefined;
    if (!row) return { reserved: false, epoch: 0 };
    return { reserved: true, epoch: row.epoch };
  }

  /**
   * Refund one previously-reserved cycle, but only if the row's epoch still
   * matches `reservedEpoch`. A human-touch reset bumps the epoch, so a refund
   * for a pre-reset reservation becomes a no-op and cannot erase a different
   * handoff's post-reset reservation. Floored at 0; no-op when no row matches.
   */
  decrement(runId: string, transitionKey: string, reservedEpoch: number): void {
    this.db
      .prepare(
        'UPDATE handoff_cycles SET count = count - 1, updated_at = ? WHERE run_id = ? AND transition_key = ? AND epoch = ? AND count > 0'
      )
      .run(Date.now(), runId, transitionKey, reservedEpoch);
  }

  /**
   * Resets the cycle counter for a specific transition back to 0 (epoch unchanged).
   */
  reset(runId: string, transitionKey: string): void {
    this.db
      .prepare(
        'UPDATE handoff_cycles SET count = 0, updated_at = ? WHERE run_id = ? AND transition_key = ?'
      )
      .run(Date.now(), runId, transitionKey);
  }

  /**
   * Zeros every handoff cycle counter for a run AND bumps its epoch.
   *
   * The cap measures "consecutive autonomous cycles without human oversight", so
   * all transitions reset together whenever the run regains human attention
   * (mirrors `ChannelCycleRepository.resetAllForRun`). Bumping the epoch also
   * invalidates in-flight reservations from before the reset, so their refunds
   * can't decrement the fresh post-reset counters.
   *
   * @returns Number of rows updated (0 is valid — no cyclic transitions yet).
   */
  resetAllForRun(runId: string): number {
    const result = this.db
      .prepare(
        'UPDATE handoff_cycles SET count = 0, epoch = epoch + 1, updated_at = ? WHERE run_id = ?'
      )
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
  epoch: number;
  updated_at: number;
}

function rowToRecord(row: HandoffCycleRow): HandoffCycleRecord {
  return {
    runId: row.run_id,
    transitionKey: row.transition_key,
    count: row.count,
    maxCycles: row.max_cycles,
    epoch: row.epoch,
    updatedAt: row.updated_at,
  };
}
