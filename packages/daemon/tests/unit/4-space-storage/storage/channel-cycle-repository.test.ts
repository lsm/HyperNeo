/**
 * ChannelCycleRepository Unit Tests
 *
 * Covers:
 *   - incrementCycleCount: insert, update, cap-guard (existing behavior)
 *   - reset: per-channel reset (existing behavior)
 *   - resetAllForRun: new human-touch reset that zeroes every channel counter
 *     for a workflow run in a single statement (Task #101)
 *
 * Uses an in-memory SQLite DB seeded with the full migration chain so FK
 * constraints (channel_cycles.run_id → space_workflow_runs.id) match production.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { ChannelCycleRepository } from '../../../../src/storage/repositories/channel-cycle-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

let db: Database;
let repo: ChannelCycleRepository;

const RUN_ID_A = 'run-cyc-A';
const RUN_ID_B = 'run-cyc-B';

function freshDb(): Database {
  const d = new Database(':memory:');
  createSpaceTables(d);
  const now = Date.now();
  d.exec(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('sp1', 'sp1', '/tmp/test', 'Test Space', ${now}, ${now})`
  );
  d.exec(
    `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('wf1', 'sp1', 'Test Workflow', ${now}, ${now})`
  );
  d.exec(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, started_at, completed_at, created_at, updated_at) VALUES ('${RUN_ID_A}', 'sp1', 'wf1', 'Run A', 'in_progress', NULL, NULL, ${now}, ${now})`
  );
  d.exec(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, started_at, completed_at, created_at, updated_at) VALUES ('${RUN_ID_B}', 'sp1', 'wf1', 'Run B', 'in_progress', NULL, NULL, ${now}, ${now})`
  );
  return d;
}

beforeEach(() => {
  db = freshDb();
  repo = new ChannelCycleRepository(db);
});

describe('ChannelCycleRepository — incrementCycleCount', () => {
  test('inserts a new row with count=1 on first call', () => {
    const ok = repo.incrementCycleCount(RUN_ID_A, 0, 5);
    expect(ok).toBe(true);
    const rec = repo.get(RUN_ID_A, 0);
    expect(rec).not.toBeNull();
    expect(rec!.count).toBe(1);
    expect(rec!.maxCycles).toBe(5);
  });

  test('increments existing row while under cap', () => {
    repo.incrementCycleCount(RUN_ID_A, 0, 5);
    repo.incrementCycleCount(RUN_ID_A, 0, 5);
    expect(repo.get(RUN_ID_A, 0)!.count).toBe(2);
  });

  test('returns false and does not increment when cap is reached', () => {
    repo.incrementCycleCount(RUN_ID_A, 0, 2);
    repo.incrementCycleCount(RUN_ID_A, 0, 2);
    const third = repo.incrementCycleCount(RUN_ID_A, 0, 2);
    expect(third).toBe(false);
    expect(repo.get(RUN_ID_A, 0)!.count).toBe(2);
  });

  test('unblocks a capped run when the supplied cap is raised above the persisted one', () => {
    // Drive a channel to its cap of 6 (persisted max_cycles = 6).
    for (let i = 0; i < 6; i++) repo.incrementCycleCount(RUN_ID_A, 0, 6);
    expect(repo.get(RUN_ID_A, 0)).toEqual(expect.objectContaining({ count: 6, maxCycles: 6 }));

    // At the old cap, further increments at cap=6 are rejected.
    expect(repo.incrementCycleCount(RUN_ID_A, 0, 6)).toBe(false);

    // Cap raised 6 → 50 (e.g. a template re-stamp). The increment guard must
    // compare against the SUPPLIED cap, not the stale persisted max_cycles —
    // otherwise an in-flight run blocked at the old limit can never resume.
    // This is the motivating case for raising the Fullstack QA Loop cap.
    expect(repo.incrementCycleCount(RUN_ID_A, 0, 50)).toBe(true);
    expect(repo.get(RUN_ID_A, 0)).toEqual(expect.objectContaining({ count: 7, maxCycles: 50 }));
  });
});

describe('ChannelCycleRepository — reset (single channel)', () => {
  test('zeros count for a specific (run, channel) pair only', () => {
    repo.incrementCycleCount(RUN_ID_A, 0, 5);
    repo.incrementCycleCount(RUN_ID_A, 0, 5);
    repo.incrementCycleCount(RUN_ID_A, 1, 5);

    repo.reset(RUN_ID_A, 0);

    expect(repo.get(RUN_ID_A, 0)!.count).toBe(0);
    expect(repo.get(RUN_ID_A, 1)!.count).toBe(1); // untouched
  });
});

describe('ChannelCycleRepository — resetAllForRun (human touch)', () => {
  test('zeros count for every channel in the given run', () => {
    repo.incrementCycleCount(RUN_ID_A, 0, 5);
    repo.incrementCycleCount(RUN_ID_A, 0, 5);
    repo.incrementCycleCount(RUN_ID_A, 1, 5);
    repo.incrementCycleCount(RUN_ID_A, 2, 5);

    const rowsReset = repo.resetAllForRun(RUN_ID_A);

    expect(rowsReset).toBe(3);
    expect(repo.get(RUN_ID_A, 0)!.count).toBe(0);
    expect(repo.get(RUN_ID_A, 1)!.count).toBe(0);
    expect(repo.get(RUN_ID_A, 2)!.count).toBe(0);
  });

  test('allows subsequent increments after reset (budget is refreshed)', () => {
    repo.incrementCycleCount(RUN_ID_A, 0, 2);
    repo.incrementCycleCount(RUN_ID_A, 0, 2);
    // Cap reached — next increment would return false.
    expect(repo.incrementCycleCount(RUN_ID_A, 0, 2)).toBe(false);

    repo.resetAllForRun(RUN_ID_A);

    // After reset, the cap guard allows more increments.
    expect(repo.incrementCycleCount(RUN_ID_A, 0, 2)).toBe(true);
    expect(repo.incrementCycleCount(RUN_ID_A, 0, 2)).toBe(true);
    expect(repo.get(RUN_ID_A, 0)!.count).toBe(2);
  });

  test('does not affect other workflow runs', () => {
    repo.incrementCycleCount(RUN_ID_A, 0, 5);
    repo.incrementCycleCount(RUN_ID_B, 0, 5);
    repo.incrementCycleCount(RUN_ID_B, 0, 5);

    repo.resetAllForRun(RUN_ID_A);

    expect(repo.get(RUN_ID_A, 0)!.count).toBe(0);
    expect(repo.get(RUN_ID_B, 0)!.count).toBe(2); // untouched
  });

  test('returns 0 when no channel rows exist for the run (human touch before any cyclic traversal)', () => {
    const rowsReset = repo.resetAllForRun(RUN_ID_A);
    expect(rowsReset).toBe(0);
  });

  test('updates updated_at when a row is reset', async () => {
    repo.incrementCycleCount(RUN_ID_A, 0, 5);
    const before = repo.get(RUN_ID_A, 0)!.updatedAt;

    // Yield so Date.now() has a chance to advance (1ms resolution on most platforms).
    await new Promise((resolve) => setTimeout(resolve, 2));

    repo.resetAllForRun(RUN_ID_A);

    const after = repo.get(RUN_ID_A, 0)!.updatedAt;
    expect(after).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// Rate-based dead-loop detection (primary gate) — channel_cycle_events
// ---------------------------------------------------------------------------

describe('ChannelCycleRepository — rate-based dead-loop detection', () => {
  // A fixed "now" and a 5-minute window keep these tests deterministic without
  // depending on real wall-clock time.
  const NOW = 1_700_000_000_000;
  const WINDOW = 5 * 60 * 1000;

  test('recordCycleEvent stores timestamped traversals', () => {
    repo.recordCycleEvent(RUN_ID_A, 1, NOW);
    repo.recordCycleEvent(RUN_ID_A, 1, NOW + 1000);
    expect(repo.countRecentCycleEvents(RUN_ID_A, 1, NOW + 2000, WINDOW)).toBe(2);
  });

  test('countRecentCycleEvents only counts traversals inside the window', () => {
    // Two traversals well outside the window (an hour ago) ...
    repo.recordCycleEvent(RUN_ID_A, 1, NOW - 60 * 60 * 1000);
    repo.recordCycleEvent(RUN_ID_A, 1, NOW - 30 * 60 * 1000);
    // ... and three inside it.
    repo.recordCycleEvent(RUN_ID_A, 1, NOW - 60_000);
    repo.recordCycleEvent(RUN_ID_A, 1, NOW - 30_000);
    repo.recordCycleEvent(RUN_ID_A, 1, NOW - 10_000);

    expect(repo.countRecentCycleEvents(RUN_ID_A, 1, NOW, WINDOW)).toBe(3);
  });

  test('a genuine extended review spread over hours never trips the threshold', () => {
    // Simulate 30 review round-trips on the same channel, each an hour apart —
    // far more than the lifetime cap ever allowed, but spread over a whole day.
    // The rolling 5-minute window must only ever see at most one at a time.
    for (let i = 0; i < 30; i++) {
      const t = NOW + i * 60 * 60 * 1000;
      repo.recordCycleEvent(RUN_ID_A, 1, t);
      // At every point in time, the windowed count stays tiny.
      expect(repo.isDeadLoopReached(RUN_ID_A, 1, t, 15, WINDOW)).toBe(false);
    }
  });

  test('a tight ping-pong within the window trips the threshold', () => {
    // 15 rapid traversals inside the window. After the 15th, the next attempt
    // is blocked (the threshold is met).
    for (let i = 0; i < 15; i++) {
      repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    }
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 15_000, 15, WINDOW)).toBe(true);
  });

  test('isDeadLoopReached is false below the threshold', () => {
    for (let i = 0; i < 14; i++) {
      repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    }
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 14_000, 15, WINDOW)).toBe(false);
  });

  test('counting prunes events older than the window (bounded growth)', () => {
    for (let i = 0; i < 40; i++) {
      repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000); // 40s span
    }
    // Counting at NOW + 6min prunes everything older than 5min and returns
    // only the tail of the burst still inside the window.
    const count = repo.countRecentCycleEvents(RUN_ID_A, 1, NOW + 6 * 60 * 1000, WINDOW);
    expect(count).toBe(0);
  });

  test('rate tracking is isolated per channel index', () => {
    for (let i = 0; i < 15; i++) repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 15_000, 15, WINDOW)).toBe(true);
    // A different channel on the same run is unaffected.
    expect(repo.countRecentCycleEvents(RUN_ID_A, 2, NOW + 15_000, WINDOW)).toBe(0);
    expect(repo.isDeadLoopReached(RUN_ID_A, 2, NOW + 15_000, 15, WINDOW)).toBe(false);
  });

  test('rate tracking is isolated per run', () => {
    for (let i = 0; i < 15; i++) repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 15_000, 15, WINDOW)).toBe(true);
    expect(repo.isDeadLoopReached(RUN_ID_B, 1, NOW + 15_000, 15, WINDOW)).toBe(false);
  });

  test('resetAllForRun (human touch) clears the rate-window history and lifts a dead-loop block', () => {
    for (let i = 0; i < 15; i++) repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 15_000, 15, WINDOW)).toBe(true);

    repo.resetAllForRun(RUN_ID_A);

    expect(repo.countRecentCycleEvents(RUN_ID_A, 1, NOW + 15_000, WINDOW)).toBe(0);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 15_000, 15, WINDOW)).toBe(false);
    // Other runs are untouched.
    for (let i = 0; i < 15; i++) repo.recordCycleEvent(RUN_ID_B, 1, NOW + i * 1000);
    expect(repo.isDeadLoopReached(RUN_ID_B, 1, NOW + 15_000, 15, WINDOW)).toBe(true);
  });

  test('uses package defaults when threshold/window omitted', () => {
    // Sanity: defaults are the documented 15 / 5min.
    for (let i = 0; i < 14; i++) repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 14_000)).toBe(false);
    repo.recordCycleEvent(RUN_ID_A, 1, NOW + 14_000);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 15_000)).toBe(true);
  });
});
