/**
 * Channel Cycle Repository
 *
 * Persistence layer for per-channel cycle tracking, keyed by
 * `(run_id, channel_index)`. Each backward (cyclic) channel in a workflow run
 * has its own state.
 *
 * ## Dead-loop detection (rate-based, primary gate)
 *
 * A runaway tight ping-pong between two agents — the only thing worth blocking
 * — is detected as a **rate**: more than {@link DEAD_LOOP_THRESHOLD} traversals
 * of the same cyclic channel within a rolling {@link DEAD_LOOP_WINDOW_MS}
 * window. This is recorded as one row per traversal in `channel_cycle_events`.
 * A genuine extended review spread over hours can never accumulate that many
 * traversals inside a single short window, so it never trips. The per-window
 * count is recomputed (and old rows pruned) on every check.
 *
 * ## Lifetime counter (`channel_cycles`, observability only)
 *
 * The legacy `channel_cycles` table keeps a lifetime traversal count per
 * channel. It is retained for observability and backward-compatibility with
 * in-flight runs, but it is **no longer a blocking gate** — a long review must
 * not be blocked merely for doing many rounds over time. Both stores are reset
 * together on human touch (see {@link resetAllForRun}).
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

export interface ChannelCycleRecord {
  runId: string;
  channelIndex: number;
  count: number;
  maxCycles: number;
  updatedAt: number;
}

export class ChannelCycleRepository {
  constructor(private db: BunDatabase) {}

  /**
   * Returns the cycle record for a specific channel in a run, or null if none exists.
   */
  get(runId: string, channelIndex: number): ChannelCycleRecord | null {
    const row = this.db
      .prepare('SELECT * FROM channel_cycles WHERE run_id = ? AND channel_index = ?')
      .get(runId, channelIndex) as ChannelCycleRow | null;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Returns all cycle records for a given run, keyed by channel index.
   */
  getAllForRun(runId: string): Map<number, ChannelCycleRecord> {
    const rows = this.db
      .prepare('SELECT * FROM channel_cycles WHERE run_id = ?')
      .all(runId) as ChannelCycleRow[];
    const map = new Map<number, ChannelCycleRecord>();
    for (const row of rows) {
      const record = rowToRecord(row);
      map.set(record.channelIndex, record);
    }
    return map;
  }

  /**
   * Atomically increments the cycle counter for a channel.
   *
   * On first call for a (run, channel) pair, inserts a new row with count=1.
   * On subsequent calls, increments only if the current count is below the
   * supplied `maxCycles` (not the persisted `max_cycles`), so raising the cap
   * unblocks an in-flight run already at the old limit.
   *
   * @returns `true` if the counter was incremented, `false` if the cap was reached.
   */
  incrementCycleCount(runId: string, channelIndex: number, maxCycles: number): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO channel_cycles (run_id, channel_index, count, max_cycles, updated_at)
				 VALUES (?, ?, 1, ?, ?)
				 ON CONFLICT (run_id, channel_index)
				 DO UPDATE SET count = count + 1, max_cycles = ?, updated_at = ?
				 WHERE count < ?`
      )
      .run(runId, channelIndex, maxCycles, now, maxCycles, now, maxCycles);
    return result.changes > 0;
  }

  /**
   * Resets the cycle counter for a specific channel back to 0.
   */
  reset(runId: string, channelIndex: number): void {
    this.db
      .prepare(
        'UPDATE channel_cycles SET count = 0, updated_at = ? WHERE run_id = ? AND channel_index = ?'
      )
      .run(Date.now(), runId, channelIndex);
  }

  /**
   * Zeros every channel cycle counter for a run in a single statement, and
   * clears the rate-window event history for the run.
   *
   * Both the lifetime counter and the rate window measure "autonomous agent
   * cycles without human oversight", so they reset together whenever the run
   * regains human attention. Clearing the event history is what makes a human
   * touch lift a dead-loop block: after reset, the per-window count is 0.
   *
   * @returns Number of `channel_cycles` rows updated (0 is valid — no cyclic
   * channels yet). Event-row deletions are not counted here to preserve the
   * existing return-value contract used for telemetry.
   */
  resetAllForRun(runId: string): number {
    const result = this.db
      .prepare('UPDATE channel_cycles SET count = 0, updated_at = ? WHERE run_id = ?')
      .run(Date.now(), runId);
    // Clear the rate-window event history so a human touch lifts any active
    // dead-loop block on this run.
    this.db.prepare('DELETE FROM channel_cycle_events WHERE run_id = ?').run(runId);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Rate-based dead-loop detection (primary gate)
  // -------------------------------------------------------------------------

  /**
   * Records one cyclic-channel traversal as a timestamped event in
   * `channel_cycle_events`. Call this AFTER a successful delivery/re-activation
   * on a cyclic channel so the next traversal's rate check can see it.
   *
   * Also opportunistically prunes events older than the window so the table
   * stays bounded over a long-running run.
   */
  recordCycleEvent(runId: string, channelIndex: number, now: number = Date.now()): void {
    this.pruneCycleEvents(runId, channelIndex, now);
    this.db
      .prepare('INSERT INTO channel_cycle_events (run_id, channel_index, sent_at) VALUES (?, ?, ?)')
      .run(runId, channelIndex, now);
  }

  /**
   * Removes cyclic-channel events older than `now - windowMs`. Called as part
   * of counting so the rate signal always reflects only the current window.
   */
  pruneCycleEvents(
    runId: string,
    channelIndex: number,
    now: number = Date.now(),
    windowMs: number = DEAD_LOOP_WINDOW_MS
  ): void {
    this.db
      .prepare(
        'DELETE FROM channel_cycle_events WHERE run_id = ? AND channel_index = ? AND sent_at < ?'
      )
      .run(runId, channelIndex, now - windowMs);
  }

  /**
   * Returns the number of cyclic-channel traversals recorded within the rolling
   * window `[now - windowMs, now]`, after pruning anything older. This is the
   * rate-based dead-loop signal.
   */
  countRecentCycleEvents(
    runId: string,
    channelIndex: number,
    now: number = Date.now(),
    windowMs: number = DEAD_LOOP_WINDOW_MS
  ): number {
    this.pruneCycleEvents(runId, channelIndex, now, windowMs);
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM channel_cycle_events WHERE run_id = ? AND channel_index = ? AND sent_at >= ?'
      )
      .get(runId, channelIndex, now - windowMs) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Returns `true` when the cyclic channel is in a dead loop: the number of
   * traversals within the rolling window has reached `threshold`. The upcoming
   * traversal (the one that would exceed the threshold) should be blocked.
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
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface ChannelCycleRow {
  run_id: string;
  channel_index: number;
  count: number;
  max_cycles: number;
  updated_at: number;
}

function rowToRecord(row: ChannelCycleRow): ChannelCycleRecord {
  return {
    runId: row.run_id,
    channelIndex: row.channel_index,
    count: row.count,
    maxCycles: row.max_cycles,
    updatedAt: row.updated_at,
  };
}
