/**
 * ChannelCycleRepository Unit Tests
 *
 * Covers the rate-based dead-loop detection API:
 *   - reserveCycleEvent: authoritative atomic gate (prune + count + conditional insert)
 *   - recordCycleEvent: unconditional traversal record (recovery path)
 *   - countRecentCycleEvents / isDeadLoopReached: read-only windowed count
 *   - resetAllForRun: human-touch reset (clears event history, lifts a block)
 *   - pruneAllOldEvents: cross-run GC for abandoned/stalled runs
 *
 * Uses an in-memory SQLite DB seeded with the full migration chain so FK
 * constraints (channel_cycle_events.run_id → space_workflow_runs.id) match
 * production.
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

// A fixed "now" and a 5-minute window keep the rate tests deterministic without
// depending on real wall-clock time.
const NOW = 1_700_000_000_000;
const WINDOW = 5 * 60 * 1000;

describe('ChannelCycleRepository — reserveCycleEvent (authoritative gate)', () => {
  test('allows and records traversals below the threshold', () => {
    let reservation;
    for (let i = 0; i < 15; i++) {
      reservation = repo.reserveCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
      expect(reservation.allowed).toBe(true);
    }
    expect(reservation!.recentCount).toBe(15);
  });

  test('blocks the traversal that would exceed the threshold (no insert)', () => {
    for (let i = 0; i < 15; i++) repo.reserveCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    // The 16th attempt within the window is blocked and records nothing.
    const blocked = repo.reserveCycleEvent(RUN_ID_A, 1, NOW + 15_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.recentCount).toBe(15);
    // Still exactly 15 recorded — the blocked attempt inserted no row.
    expect(repo.countRecentCycleEvents(RUN_ID_A, 1, NOW + 15_000, WINDOW)).toBe(15);
  });

  test('a genuine extended review spread over hours never trips', () => {
    // 30 review round-trips on the same channel, each an hour apart — far more
    // than any lifetime cap allowed, but spread over a whole day. The rolling
    // 5-minute window must only ever see one at a time.
    for (let i = 0; i < 30; i++) {
      const t = NOW + i * 60 * 60 * 1000;
      expect(repo.reserveCycleEvent(RUN_ID_A, 1, t).allowed).toBe(true);
    }
  });

  test('is isolated per channel index and per run', () => {
    for (let i = 0; i < 15; i++) repo.reserveCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    expect(repo.reserveCycleEvent(RUN_ID_A, 1, NOW + 15_000).allowed).toBe(false);
    // Different channel on the same run, and the same channel on a different
    // run, are both still allowed.
    expect(repo.reserveCycleEvent(RUN_ID_A, 2, NOW + 15_000).allowed).toBe(true);
    expect(repo.reserveCycleEvent(RUN_ID_B, 1, NOW + 15_000).allowed).toBe(true);
  });
});

describe('ChannelCycleRepository — windowed counting & pruning', () => {
  test('countRecentCycleEvents only counts traversals inside the window', () => {
    repo.recordCycleEvent(RUN_ID_A, 1, NOW - 60 * 60 * 1000); // an hour ago
    repo.recordCycleEvent(RUN_ID_A, 1, NOW - 30 * 60 * 1000); // 30 min ago
    repo.recordCycleEvent(RUN_ID_A, 1, NOW - 60_000); // inside
    repo.recordCycleEvent(RUN_ID_A, 1, NOW - 10_000); // inside
    expect(repo.countRecentCycleEvents(RUN_ID_A, 1, NOW, WINDOW)).toBe(2);
  });

  test('counting prunes events older than the window (bounded growth)', () => {
    for (let i = 0; i < 40; i++) repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000); // 40s span
    // Counting 6 minutes later prunes the whole burst (all older than 5 min).
    expect(repo.countRecentCycleEvents(RUN_ID_A, 1, NOW + 6 * 60 * 1000, WINDOW)).toBe(0);
  });

  test('isDeadLoopReached flips at the threshold', () => {
    for (let i = 0; i < 14; i++) repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 14_000)).toBe(false);
    repo.recordCycleEvent(RUN_ID_A, 1, NOW + 14_000);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 15_000)).toBe(true);
  });

  test('uses package defaults (15 / 5min) when threshold/window omitted', () => {
    for (let i = 0; i < 14; i++) repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 14_000)).toBe(false);
    repo.recordCycleEvent(RUN_ID_A, 1, NOW + 14_000);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 15_000)).toBe(true);
  });
});

describe('ChannelCycleRepository — resetAllForRun (human touch)', () => {
  test('clears the rate-window history and lifts a dead-loop block', () => {
    for (let i = 0; i < 15; i++) repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 15_000)).toBe(true);

    const deleted = repo.resetAllForRun(RUN_ID_A);
    expect(deleted).toBe(15);
    expect(repo.countRecentCycleEvents(RUN_ID_A, 1, NOW + 15_000, WINDOW)).toBe(0);
    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 15_000)).toBe(false);
    // The channel is deliverable again after the reset.
    expect(repo.reserveCycleEvent(RUN_ID_A, 1, NOW + 15_000).allowed).toBe(true);
  });

  test('does not affect other workflow runs', () => {
    for (let i = 0; i < 15; i++) repo.recordCycleEvent(RUN_ID_A, 1, NOW + i * 1000);
    for (let i = 0; i < 15; i++) repo.recordCycleEvent(RUN_ID_B, 1, NOW + i * 1000);

    repo.resetAllForRun(RUN_ID_A);

    expect(repo.isDeadLoopReached(RUN_ID_A, 1, NOW + 15_000)).toBe(false);
    expect(repo.isDeadLoopReached(RUN_ID_B, 1, NOW + 15_000)).toBe(true);
  });

  test('returns 0 when nothing is recorded for the run', () => {
    expect(repo.resetAllForRun(RUN_ID_A)).toBe(0);
  });
});

describe('ChannelCycleRepository — pruneAllOldEvents (cross-run GC)', () => {
  test('deletes events older than the retention cutoff across all runs', () => {
    // Run A: recent events (kept). Run B: stale events (GC'd).
    repo.recordCycleEvent(RUN_ID_A, 1, NOW - 60_000);
    repo.recordCycleEvent(RUN_ID_B, 1, NOW - 2 * WINDOW); // 10 min ago
    repo.recordCycleEvent(RUN_ID_B, 2, NOW - 3 * WINDOW); // 15 min ago

    const deleted = repo.pruneAllOldEvents(NOW);
    expect(deleted).toBe(2);
    expect(repo.countRecentCycleEvents(RUN_ID_A, 1, NOW, WINDOW)).toBe(1);
    expect(repo.countRecentCycleEvents(RUN_ID_B, 1, NOW, WINDOW)).toBe(0);
    expect(repo.countRecentCycleEvents(RUN_ID_B, 2, NOW, WINDOW)).toBe(0);
  });

  test('returns 0 when nothing is stale', () => {
    repo.recordCycleEvent(RUN_ID_A, 1, NOW - 60_000);
    expect(repo.pruneAllOldEvents(NOW)).toBe(0);
  });
});
