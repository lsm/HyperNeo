/**
 * Migration 89 Tests — Strip reserved writer keywords from persisted gates.
 *
 * Migration 89 rewrites legacy `writers: ['human']` / `writers: ['reviewer']`
 * on `approved` gate fields to `writers: []`, matching the structural
 * external-only semantics introduced by PR #1505.
 *
 * Covers:
 *  - Legacy ['human'] on approved fields → []
 *  - Legacy ['reviewer'] on approved fields → []
 *  - Mixed writers ['reviewer', 'Coding'] on approved → ['Coding']
 *  - Non-approved fields are untouched (e.g. multi-reviewer `votes` field
 *    keeps its agent name `'reviewer'`)
 *  - Workflows with NULL gates are skipped
 *  - Idempotency
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration89 } from '../../../../../src/storage/schema/migrations.ts';

function readGates(db: BunDatabase, id: string): unknown {
  const row = db.prepare(`SELECT gates FROM space_workflows WHERE id = ?`).get(id) as
    | { gates: string | null }
    | undefined;
  return row?.gates ? JSON.parse(row.gates) : null;
}

function insertWorkflow(db: BunDatabase, id: string, gates: unknown): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflows (id, space_id, name, gates, tags, created_at, updated_at)
		 VALUES (?, ?, ?, ?, '[]', ?, ?)`
  ).run(id, 'sp-1', `WF ${id}`, gates === null ? null : JSON.stringify(gates), now, now);
}

describe('Migration 89: Strip reserved writer keywords from gates', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-89', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 's', '/ws', 'Space', now, now);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("approved field with writers: ['human'] → writers: []", () => {
    insertWorkflow(db, 'wf-1', [
      {
        id: 'g-1',
        name: 'plan-approval',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['human'],
            check: { op: '==', value: true },
          },
        ],
      },
    ]);

    runMigration89(db);

    const gates = readGates(db, 'wf-1') as Array<{ fields: Array<{ writers: string[] }> }>;
    expect(gates[0].fields[0].writers).toEqual([]);
  });

  test("approved field with writers: ['reviewer'] → writers: []", () => {
    insertWorkflow(db, 'wf-1', [
      {
        id: 'g-1',
        name: 'review-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['reviewer'],
            check: { op: '==', value: true },
          },
        ],
      },
    ]);

    runMigration89(db);

    const gates = readGates(db, 'wf-1') as Array<{ fields: Array<{ writers: string[] }> }>;
    expect(gates[0].fields[0].writers).toEqual([]);
  });

  test('approved field with mixed writers retains non-keyword entries', () => {
    insertWorkflow(db, 'wf-1', [
      {
        id: 'g-1',
        name: 'mixed-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['reviewer', 'Coding'],
            check: { op: '==', value: true },
          },
        ],
      },
    ]);

    runMigration89(db);

    const gates = readGates(db, 'wf-1') as Array<{ fields: Array<{ writers: string[] }> }>;
    expect(gates[0].fields[0].writers).toEqual(['Coding']);
  });

  test('non-approved fields are untouched (agent name "reviewer" preserved)', () => {
    insertWorkflow(db, 'wf-1', [
      {
        id: 'g-1',
        name: 'votes-gate',
        fields: [
          { name: 'votes', type: 'object', writers: ['reviewer'], check: { op: 'exists' } },
          {
            name: 'approved',
            type: 'boolean',
            writers: ['human'],
            check: { op: '==', value: true },
          },
        ],
      },
    ]);

    runMigration89(db);

    const gates = readGates(db, 'wf-1') as Array<{
      fields: Array<{ name: string; writers: string[] }>;
    }>;
    expect(gates[0].fields[0].writers).toEqual(['reviewer']);
    expect(gates[0].fields[1].writers).toEqual([]);
  });

  test('workflows with NULL gates are skipped', () => {
    insertWorkflow(db, 'wf-1', null);

    expect(() => runMigration89(db)).not.toThrow();

    expect(readGates(db, 'wf-1')).toBeNull();
  });

  test('idempotent — running twice yields the same result', () => {
    insertWorkflow(db, 'wf-1', [
      {
        id: 'g-1',
        name: 'gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['human'],
            check: { op: '==', value: true },
          },
        ],
      },
    ]);

    runMigration89(db);
    runMigration89(db);

    const gates = readGates(db, 'wf-1') as Array<{ fields: Array<{ writers: string[] }> }>;
    expect(gates[0].fields[0].writers).toEqual([]);
  });
});
