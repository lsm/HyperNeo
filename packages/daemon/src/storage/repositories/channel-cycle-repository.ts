/**
 * Channel Cycle Repository
 *
 * Persistence layer for per-channel cycle counters, keyed by `(run_id, channel_index)`.
 * Each backward (cyclic) channel in a workflow run has its own counter and cap.
 * The counter is atomically incremented via an UPSERT with a cap guard.
 */

import type { Database as BunDatabase } from '../sqlite-compat';

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
   * Zeros every channel cycle counter for a run in a single statement.
   *
   * The cap measures "consecutive autonomous cycles without human oversight", so
   * all channels reset together whenever the run regains human attention.
   *
   * @returns Number of rows updated (0 is valid — no cyclic channels yet).
   */
  resetAllForRun(runId: string): number {
    const result = this.db
      .prepare('UPDATE channel_cycles SET count = 0, updated_at = ? WHERE run_id = ?')
      .run(Date.now(), runId);
    return result.changes;
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
