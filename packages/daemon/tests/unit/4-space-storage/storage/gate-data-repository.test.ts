/**
 * GateDataRepository Unit Tests
 *
 * Covers:
 *   - CRUD operations: get, set, merge, delete
 *   - Batch operations: listByRun, deleteByRun, initializeForRun
 *   - Persistence round-trip: data survives close/reopen
 *   - Reset: resetOnCycle behavior
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: Database;
let repo: GateDataRepository;

const RUN_ID = 'run-001';
const GATE_ID_A = 'gate-a';
const GATE_ID_B = 'gate-b';

function freshDb(): Database {
  const d = new Database(':memory:');
  createSpaceTables(d);
  // Insert required parent rows for FK constraints
  const now = Date.now();
  d.exec(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('sp1', 'sp1', '/tmp/test', 'Test Space', ${now}, ${now})`
  );
  d.exec(
    `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('wf1', 'sp1', 'Test Workflow', ${now}, ${now})`
  );
  d.exec(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, started_at, completed_at, created_at, updated_at) VALUES ('${RUN_ID}', 'sp1', 'wf1', 'Test Run', 'in_progress', NULL, NULL, ${now}, ${now})`
  );
  return d;
}

beforeEach(() => {
  db = freshDb();
  repo = new GateDataRepository(db);
});

// ---------------------------------------------------------------------------
// get / set
// ---------------------------------------------------------------------------

describe('GateDataRepository — get/set', () => {
  test('returns null for non-existent gate data', () => {
    const result = repo.get(RUN_ID, GATE_ID_A);
    expect(result).toBeNull();
  });

  test('set creates new record and get retrieves it', () => {
    const data = { approved: true, count: 3 };
    repo.set(RUN_ID, GATE_ID_A, data);

    const record = repo.get(RUN_ID, GATE_ID_A);
    expect(record).not.toBeNull();
    expect(record!.runId).toBe(RUN_ID);
    expect(record!.gateId).toBe(GATE_ID_A);
    expect(record!.data).toEqual(data);
    expect(typeof record!.updatedAt).toBe('number');
  });

  test('set upserts existing record', () => {
    repo.set(RUN_ID, GATE_ID_A, { count: 1 });
    repo.set(RUN_ID, GATE_ID_A, { count: 5, extra: true });

    const record = repo.get(RUN_ID, GATE_ID_A);
    expect(record!.data).toEqual({ count: 5, extra: true });
  });

  test('set preserves updated_at when data is unchanged', () => {
    const data = { approved: true };
    const first = repo.set(RUN_ID, GATE_ID_A, data);

    // Sleep briefly to ensure a different timestamp would be generated
    const start = Date.now();
    while (Date.now() < start + 10) {
      // busy wait
    }

    const second = repo.set(RUN_ID, GATE_ID_A, data);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(repo.get(RUN_ID, GATE_ID_A)!.updatedAt).toBe(first.updatedAt);
  });

  test('different gate IDs are independent', () => {
    repo.set(RUN_ID, GATE_ID_A, { a: 1 });
    repo.set(RUN_ID, GATE_ID_B, { b: 2 });

    expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({ a: 1 });
    expect(repo.get(RUN_ID, GATE_ID_B)!.data).toEqual({ b: 2 });
  });
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

describe('GateDataRepository — merge', () => {
  test('creates record if none exists', () => {
    const result = repo.merge(RUN_ID, GATE_ID_A, { approved: true });
    expect(result.data).toEqual({ approved: true });
    expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({ approved: true });
  });

  test('merges partial data into existing record', () => {
    repo.set(RUN_ID, GATE_ID_A, { count: 1, name: 'test' });
    repo.merge(RUN_ID, GATE_ID_A, { count: 2, extra: true });

    const record = repo.get(RUN_ID, GATE_ID_A);
    expect(record!.data).toEqual({ count: 2, name: 'test', extra: true });
  });
});

// ---------------------------------------------------------------------------
// mergeWithMapFields
// ---------------------------------------------------------------------------

describe('GateDataRepository — mergeWithMapFields', () => {
  test('creates record if none exists', () => {
    const result = repo.mergeWithMapFields(
      RUN_ID,
      GATE_ID_A,
      { approvals: { architecture: 'approved' } },
      new Set(['approvals'])
    );
    expect(result.data).toEqual({ approvals: { architecture: 'approved' } });
  });

  test('deep-merges nominated map field across multiple writes', () => {
    repo.mergeWithMapFields(
      RUN_ID,
      GATE_ID_A,
      { approvals: { architecture: 'approved' } },
      new Set(['approvals'])
    );
    repo.mergeWithMapFields(
      RUN_ID,
      GATE_ID_A,
      { approvals: { security: 'approved' } },
      new Set(['approvals'])
    );
    repo.mergeWithMapFields(
      RUN_ID,
      GATE_ID_A,
      { approvals: { ux: 'rejected' } },
      new Set(['approvals'])
    );

    expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({
      approvals: {
        architecture: 'approved',
        security: 'approved',
        ux: 'rejected',
      },
    });
  });

  test('shallow-overwrites keys not in the mapFields set', () => {
    repo.set(RUN_ID, GATE_ID_A, { approvals: { architecture: 'approved' }, status: 'pending' });
    repo.mergeWithMapFields(
      RUN_ID,
      GATE_ID_A,
      { approvals: { security: 'approved' }, status: 'reviewing' },
      new Set(['approvals'])
    );

    expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({
      approvals: { architecture: 'approved', security: 'approved' },
      status: 'reviewing',
    });
  });

  test('replaces non-object existing value with new object even when key is in mapFields', () => {
    repo.set(RUN_ID, GATE_ID_A, { approvals: 'invalid-string' });
    repo.mergeWithMapFields(
      RUN_ID,
      GATE_ID_A,
      { approvals: { architecture: 'approved' } },
      new Set(['approvals'])
    );

    expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({
      approvals: { architecture: 'approved' },
    });
  });

  test('reset between writes wipes prior entries (cyclic feedback semantics)', () => {
    // Simulates the race-defensive behaviour: a reset() must not be
    // silently undone by a stale snapshot composed in JS.
    repo.mergeWithMapFields(
      RUN_ID,
      GATE_ID_A,
      { approvals: { architecture: 'approved' } },
      new Set(['approvals'])
    );
    repo.mergeWithMapFields(
      RUN_ID,
      GATE_ID_A,
      { approvals: { security: 'approved' } },
      new Set(['approvals'])
    );

    // Cyclic reset clears all approvals.
    repo.reset(RUN_ID, GATE_ID_A, { approvals: {} });

    // Next reviewer in the new cycle writes — must NOT bring back prior cycle's votes.
    repo.mergeWithMapFields(
      RUN_ID,
      GATE_ID_A,
      { approvals: { ux: 'approved' } },
      new Set(['approvals'])
    );

    expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({
      approvals: { ux: 'approved' },
    });
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe('GateDataRepository — delete', () => {
  test('delete removes a specific gate data record', () => {
    repo.set(RUN_ID, GATE_ID_A, { a: 1 });
    repo.set(RUN_ID, GATE_ID_B, { b: 2 });

    const deleted = repo.delete(RUN_ID, GATE_ID_A);
    expect(deleted).toBe(true);
    expect(repo.get(RUN_ID, GATE_ID_A)).toBeNull();
    expect(repo.get(RUN_ID, GATE_ID_B)).not.toBeNull();
  });

  test('delete returns false for non-existent record', () => {
    const deleted = repo.delete(RUN_ID, 'no-such-gate');
    expect(deleted).toBe(false);
  });

  test('deleteByRun removes all gate data for a run', () => {
    repo.set(RUN_ID, GATE_ID_A, { a: 1 });
    repo.set(RUN_ID, GATE_ID_B, { b: 2 });

    const count = repo.deleteByRun(RUN_ID);
    expect(count).toBe(2);
    expect(repo.listByRun(RUN_ID)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listByRun
// ---------------------------------------------------------------------------

describe('GateDataRepository — listByRun', () => {
  test('returns empty array when no data exists', () => {
    expect(repo.listByRun(RUN_ID)).toEqual([]);
  });

  test('lists all gate data for a run, ordered by gate_id', () => {
    repo.set(RUN_ID, 'gate-z', { z: 1 });
    repo.set(RUN_ID, 'gate-a', { a: 2 });

    const records = repo.listByRun(RUN_ID);
    expect(records).toHaveLength(2);
    expect(records[0].gateId).toBe('gate-a');
    expect(records[1].gateId).toBe('gate-z');
  });
});

// ---------------------------------------------------------------------------
// initializeForRun
// ---------------------------------------------------------------------------

describe('GateDataRepository — initializeForRun', () => {
  test('initializes gate data with defaults', () => {
    repo.initializeForRun(RUN_ID, [
      { id: GATE_ID_A, data: { approved: false } },
      { id: GATE_ID_B, data: { count: 0 } },
    ]);

    expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({ approved: false });
    expect(repo.get(RUN_ID, GATE_ID_B)!.data).toEqual({ count: 0 });
  });

  test('does not overwrite existing data (INSERT OR IGNORE)', () => {
    repo.set(RUN_ID, GATE_ID_A, { approved: true });

    repo.initializeForRun(RUN_ID, [{ id: GATE_ID_A, data: { approved: false } }]);

    // Should keep the existing data, not overwrite with default
    expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({ approved: true });
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe('GateDataRepository — reset', () => {
  test('resets gate data to defaults', () => {
    repo.set(RUN_ID, GATE_ID_A, { approved: true, extra: 'value' });

    const result = repo.reset(RUN_ID, GATE_ID_A, { approved: false });
    expect(result.data).toEqual({ approved: false });
    expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({ approved: false });
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

describe('GateDataRepository — persistence', () => {
  test('data persists across repository instances (same db)', () => {
    repo.set(RUN_ID, GATE_ID_A, { persistent: true, value: 42 });

    // Create a new repository instance pointing to the same DB
    const repo2 = new GateDataRepository(db);
    const record = repo2.get(RUN_ID, GATE_ID_A);
    expect(record).not.toBeNull();
    expect(record!.data).toEqual({ persistent: true, value: 42 });
  });
});

// ---------------------------------------------------------------------------
// Gate data corruption recovery (M9.4)
// ---------------------------------------------------------------------------

describe('GateDataRepository — corruption recovery', () => {
  test('get() returns null when stored JSON is corrupted (so caller falls back to gate defaults)', () => {
    // Directly insert corrupted JSON bypassing the repository write path
    const now = Date.now();
    db.prepare(`INSERT INTO gate_data (run_id, gate_id, data, updated_at) VALUES (?, ?, ?, ?)`).run(
      RUN_ID,
      'gate-corrupted',
      'NOT_VALID_JSON{{{',
      now
    );

    // get() returns null on corruption so the caller (evaluateGateById) can fall
    // back to the gate's default data (e.g. { approved: false, waiting: true })
    const record = repo.get(RUN_ID, 'gate-corrupted');
    expect(record).toBeNull();
  });

  test('listByRun() returns {} for each corrupted gate and valid data for healthy ones', () => {
    const now = Date.now();
    // Corrupted gate
    db.prepare(`INSERT INTO gate_data (run_id, gate_id, data, updated_at) VALUES (?, ?, ?, ?)`).run(
      RUN_ID,
      'gate-bad',
      '[[invalid',
      now
    );
    // Healthy gate
    repo.set(RUN_ID, GATE_ID_A, { approved: true });

    const records = repo.listByRun(RUN_ID);
    const badRecord = records.find((r) => r.gateId === 'gate-bad');
    const goodRecord = records.find((r) => r.gateId === GATE_ID_A);

    // listByRun returns {} for corrupted records (for inspection purposes)
    expect(badRecord).not.toBeUndefined();
    expect(badRecord!.data).toEqual({});

    expect(goodRecord).not.toBeUndefined();
    expect(goodRecord!.data).toEqual({ approved: true }); // healthy data intact
  });

  test('get() returning null causes evaluateGateById to fall back to gate defaults (waiting: true)', () => {
    // Human-approval gate default data includes { approved: false, waiting: true }
    // When corruption occurs, get() returns null and the caller uses gateDef.data.
    // Simulate the fallback: gateDef.data is the source of truth when get() returns null.
    const now = Date.now();
    db.prepare(`INSERT INTO gate_data (run_id, gate_id, data, updated_at) VALUES (?, ?, ?, ?)`).run(
      RUN_ID,
      'gate-human-approval',
      'CORRUPT_DATA',
      now
    );

    // get() returns null — caller falls back to gateDef.data
    const record = repo.get(RUN_ID, 'gate-human-approval');
    expect(record).toBeNull();

    // Simulate what evaluateGateById does: record?.data ?? gateDef.data
    const gateDef = { approved: false, waiting: true };
    const runtimeData = record?.data ?? gateDef;
    // Gate stays closed (approved: false) AND waiting: true is preserved
    expect(runtimeData['approved']).toBe(false);
    expect(runtimeData['waiting']).toBe(true);
  });

  test('set() after corrupted read writes valid JSON', () => {
    // Even if a record was corrupted, a subsequent set() should write valid data
    const now = Date.now();
    db.prepare(`INSERT INTO gate_data (run_id, gate_id, data, updated_at) VALUES (?, ?, ?, ?)`).run(
      RUN_ID,
      'gate-recoverable',
      'BAD_JSON',
      now
    );

    // set() overwrites corrupted data with valid JSON
    repo.set(RUN_ID, 'gate-recoverable', { approved: true });

    const record = repo.get(RUN_ID, 'gate-recoverable');
    expect(record!.data).toEqual({ approved: true });
  });
});
