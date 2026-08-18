import type { Database as BunDatabase } from '../sqlite-compat';

export const DEAD_LOOP_THRESHOLD = 15;

export const DEAD_LOOP_WINDOW_MS = 5 * 60 * 1000;

export interface CycleReservation {
  allowed: boolean;
  recentCount: number;
}

export class ChannelCycleRepository {
  constructor(private db: BunDatabase) {}

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
    if (typeof this.db.transaction === 'function') {
      return this.db.transaction(reserve)();
    }
    return reserve();
  }

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

  isDeadLoopReached(
    runId: string,
    channelIndex: number,
    now: number = Date.now(),
    threshold: number = DEAD_LOOP_THRESHOLD,
    windowMs: number = DEAD_LOOP_WINDOW_MS
  ): boolean {
    return this.countRecentCycleEvents(runId, channelIndex, now, windowMs) >= threshold;
  }

  countRecentCycleEvents(
    runId: string,
    channelIndex: number,
    now: number = Date.now(),
    windowMs: number = DEAD_LOOP_WINDOW_MS
  ): number {
    this.pruneOlder(runId, channelIndex, now - windowMs);
    return this.countInWindow(runId, channelIndex, now - windowMs, now);
  }

  resetAllForRun(runId: string): number {
    const result = this.db.prepare('DELETE FROM channel_cycle_events WHERE run_id = ?').run(runId);
    return result.changes;
  }

  pruneAllOldEvents(now: number = Date.now(), retentionMs: number = DEAD_LOOP_WINDOW_MS): number {
    const result = this.db
      .prepare('DELETE FROM channel_cycle_events WHERE sent_at < ?')
      .run(now - retentionMs);
    return result.changes;
  }

  private pruneOlder(runId: string, channelIndex: number, cutoff: number): void {
    this.db
      .prepare(
        'DELETE FROM channel_cycle_events WHERE run_id = ? AND channel_index = ? AND sent_at < ?'
      )
      .run(runId, channelIndex, cutoff);
  }

  private countInWindow(runId: string, channelIndex: number, since: number, now: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM channel_cycle_events WHERE run_id = ? AND channel_index = ? AND sent_at >= ? AND sent_at <= ?'
      )
      .get(runId, channelIndex, since, now) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}
