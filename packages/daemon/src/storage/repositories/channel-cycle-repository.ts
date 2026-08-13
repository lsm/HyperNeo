/**
 * Channel Cycle Repository
 *
 * Persistence layer for rate-based dead-loop detection on cyclic (backward)
 * workflow channels, keyed by `(run_id, channel_index)`.
 *
 * ## Dead-loop detection (rate-based)
 *
 * A runaway tight ping-pong between two agents — the only thing worth
 * blocking — is detected as a **rate**: more than {@link DEAD_LOOP_THRESHOLD}
 * traversals of the same cyclic channel within a rolling
 * {@link DEAD_LOOP_WINDOW_MS} window. Each traversal is one timestamped row in
 * `channel_cycle_events`. A genuine extended review spread over hours can never
 * accumulate that many traversals inside a single short window, so it never
 * trips. The per-window count is recomputed (and old rows pruned) on every
 * check.
 *
 * `channelCycleRepo.reserveCycleEvent` is the authoritative gate: it prunes,
 * counts, and conditionally inserts in one synchronous sequence, so concurrent
 * agent sessions sharing this table cannot both pass at the threshold (the
 * check and the insert are not separated by an `await`).
 *
 * The legacy lifetime `channel_cycles` table (migration 69) is retained in the
 * schema for backward-compatibility with in-flight runs but is no longer read
 * or written by any code path — a lifetime count must not block a long review.
 */

import type { Database as BunDatabase } from '../sqlite-compat';

/**
 * Maximum cyclic-channel traversals permitted within the rolling window before
 * the channel is considered in a dead loop. With the default of 15, the 16th
 * traversal inside the window trips the cap. A real inter-agent round trip
 * (LLM turn + tool use + reply) takes well over a minute, so no legitimate
 * exchange can approach this rate; only a runaway loop can.
 */
export const DEAD_LOOP_THRESHOLD = 15;

/**
 * Rolling window (ms) over which traversals are counted for dead-loop
 * detection. Default 5 minutes.
 */
export const DEAD_LOOP_WINDOW_MS = 5 * 60 * 1000;

/** Outcome of an attempted cyclic-channel traversal reservation. */
export interface CycleReservation {
  /** `true` when the traversal was recorded (below the dead-loop threshold). */
  allowed: boolean;
  /** Traversals within the window after this reservation attempt. */
  recentCount: number;
}

export class ChannelCycleRepository {
  constructor(private db: BunDatabase) {}

  /**
   * Authoritative dead-loop gate. Prunes out-of-window events, counts the
   * remainder, and — only when the count is below `threshold` — inserts a new
   * event for this traversal. Returns whether the traversal was allowed.
   *
   * The prune + count + conditional-insert sequence is synchronous (no `await`
   * between the statements), so on a single shared SQLite connection it is
   * atomic with respect to other agent sessions: two concurrent sends cannot
   * both observe a sub-threshold count and both record. It is additionally
   * wrapped in a transaction for explicitness.
   */
  reserveCycleEvent(
    runId: string,
    channelIndex: number,
    now: number = Date.now(),
    threshold: number = DEAD_LOOP_THRESHOLD,
    windowMs: number = DEAD_LOOP_WINDOW_MS
  ): CycleReservation {
    const reserve = (): CycleReservation => {
      this.pruneOlder(runId, channelIndex, now - windowMs);
      const recentCount = this.countInWindow(runId, channelIndex, now - windowMs, now);
      if (recentCount >= threshold) return { allowed: false, recentCount };
      this.db
        .prepare(
          'INSERT INTO channel_cycle_events (run_id, channel_index, sent_at) VALUES (?, ?, ?)'
        )
        .run(runId, channelIndex, now);
      return { allowed: true, recentCount: recentCount + 1 };
    };
    // db.transaction is a no-op-safe wrapper on bun:sqlite; on the shared
    // connection it makes the prune+count+insert visibly atomic.
    if (typeof this.db.transaction === 'function') {
      return this.db.transaction(reserve)();
    }
    return reserve();
  }

  /**
   * Records a cyclic-channel traversal unconditionally. Used by the restart
   * recovery path, which has already gated on `isDeadLoopReached` before
   * activating. Also prunes out-of-window events to bound table growth.
   */
  recordCycleEvent(
    runId: string,
    channelIndex: number,
    now: number = Date.now(),
    windowMs: number = DEAD_LOOP_WINDOW_MS
  ): void {
    this.pruneOlder(runId, channelIndex, now - windowMs);
    this.db
      .prepare('INSERT INTO channel_cycle_events (run_id, channel_index, sent_at) VALUES (?, ?, ?)')
      .run(runId, channelIndex, now);
  }

  /**
   * Returns `true` when the cyclic channel is currently in a dead loop:
   * traversals within the rolling window have reached `threshold`. Read-only
   * (besides pruning out-of-window rows); use for non-mutating checks such as
   * `canDeliver`. Delivery itself must use {@link reserveCycleEvent}.
   */
  isDeadLoopReached(
    runId: string,
    channelIndex: number,
    now: number = Date.now(),
    threshold: number = DEAD_LOOP_THRESHOLD,
    windowMs: number = DEAD_LOOP_WINDOW_MS
  ): boolean {
    return this.countRecentCycleEvents(runId, channelIndex, now, windowMs) >= threshold;
  }

  /**
   * Number of cyclic-channel traversals recorded within the rolling window
   * `[now - windowMs, now]`, after pruning anything older.
   */
  countRecentCycleEvents(
    runId: string,
    channelIndex: number,
    now: number = Date.now(),
    windowMs: number = DEAD_LOOP_WINDOW_MS
  ): number {
    this.pruneOlder(runId, channelIndex, now - windowMs);
    return this.countInWindow(runId, channelIndex, now - windowMs, now);
  }

  /**
   * Clears the rate-window history for every channel in a run. This is the
   * human-touch reset: after it, the per-window count is 0, so a human message
   * lifts any active dead-loop block. Returns the number of events deleted
   * (0 is valid — nothing to reset).
   */
  resetAllForRun(runId: string): number {
    const result = this.db.prepare('DELETE FROM channel_cycle_events WHERE run_id = ?').run(runId);
    return result.changes;
  }

  /**
   * Garbage-collects events older than `now - retentionMs` across ALL runs.
   * Called periodically (e.g. from `recoverStalledRuns`) so abandoned/stalled
   * runs whose channels are never traversed again still have their history
   * bounded. Returns the number of rows deleted.
   *
   * The DELETE filters on `sent_at` alone (a full scan of `channel_cycle_events`
   * without the `(run_id, channel_index, sent_at)` index). That is intentional:
   * the table is bounded to ~`threshold` rows per active channel per window by
   * the lazy pruning on every traversal, so the scan stays cheap.
   */
  pruneAllOldEvents(now: number = Date.now(), retentionMs: number = DEAD_LOOP_WINDOW_MS): number {
    const result = this.db
      .prepare('DELETE FROM channel_cycle_events WHERE sent_at < ?')
      .run(now - retentionMs);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Deletes events for a (run, channel) older than `cutoff` (exclusive). */
  private pruneOlder(runId: string, channelIndex: number, cutoff: number): void {
    this.db
      .prepare(
        'DELETE FROM channel_cycle_events WHERE run_id = ? AND channel_index = ? AND sent_at < ?'
      )
      .run(runId, channelIndex, cutoff);
  }

  /**
   * Counts events for a (run, channel) within `[since, now]` (no pruning). The
   * upper bound excludes future-dated rows (host clock moving backward across a
   * restart, or events written under a later clock) so the channel recovers
   * after the window instead of staying blocked until the clock catches up.
   */
  private countInWindow(runId: string, channelIndex: number, since: number, now: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM channel_cycle_events WHERE run_id = ? AND channel_index = ? AND sent_at >= ? AND sent_at <= ?'
      )
      .get(runId, channelIndex, since, now) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}
