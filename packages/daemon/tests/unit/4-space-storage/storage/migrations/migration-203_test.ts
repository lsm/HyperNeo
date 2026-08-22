import { Database as BunDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runMigration203 } from '../../../../../src/storage/schema/migrations.ts';

interface OwnerRow {
  agent_id: string;
  goal_id: string;
  relationship: string;
}

function ownerRows(db: BunDatabase): OwnerRow[] {
  return db
    .prepare(`SELECT agent_id, goal_id, relationship FROM space_long_horizon_agent_goals`)
    .all() as OwnerRow[];
}

function seedPreM203Schema(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE space_long_horizon_agent_goals (
      agent_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      relationship TEXT NOT NULL DEFAULT 'owner'
        CHECK(relationship IN ('owner', 'manager', 'watcher')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(agent_id, goal_id, relationship)
    );
  `);
}

function insertOwner(
  db: BunDatabase,
  agentId: string,
  goalId: string,
  createdAt: number,
  relationship: string = 'owner'
): void {
  db.prepare(
    `INSERT INTO space_long_horizon_agent_goals (agent_id, goal_id, relationship, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(agentId, goalId, relationship, createdAt, createdAt);
}

describe('Migration 203: single-owner reconciliation + unique index', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-203',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  test('keeps the earliest owner and deletes duplicate owners for the same goal', () => {
    seedPreM203Schema(db);
    insertOwner(db, 'agent-late', 'goal-1', 200);
    insertOwner(db, 'agent-early', 'goal-1', 100);
    insertOwner(db, 'agent-only', 'goal-2', 150);

    runMigration203(db);

    const rows = ownerRows(db);
    const goal1Owners = rows.filter((r) => r.goal_id === 'goal-1' && r.relationship === 'owner');
    expect(goal1Owners).toHaveLength(1);
    expect(goal1Owners[0].agent_id).toBe('agent-early');
    expect(rows.some((r) => r.goal_id === 'goal-2' && r.agent_id === 'agent-only')).toBe(true);
  });

  test('ties on created_at break by lexicographically smallest agent id', () => {
    seedPreM203Schema(db);
    insertOwner(db, 'agent-z', 'goal-1', 100);
    insertOwner(db, 'agent-a', 'goal-1', 100);

    runMigration203(db);

    const owners = ownerRows(db).filter(
      (r) => r.goal_id === 'goal-1' && r.relationship === 'owner'
    );
    expect(owners).toHaveLength(1);
    expect(owners[0].agent_id).toBe('agent-a');
  });

  test('leaves manager/watcher rows untouched', () => {
    seedPreM203Schema(db);
    insertOwner(db, 'agent-owner', 'goal-1', 100);
    insertOwner(db, 'agent-manager', 'goal-1', 150, 'manager');
    insertOwner(db, 'agent-watcher', 'goal-1', 160, 'watcher');

    runMigration203(db);

    const rows = ownerRows(db);
    expect(rows.filter((r) => r.goal_id === 'goal-1')).toHaveLength(3);
    expect(rows.some((r) => r.relationship === 'manager')).toBe(true);
    expect(rows.some((r) => r.relationship === 'watcher')).toBe(true);
  });

  test('adds a partial unique index so a second owner insert is rejected', () => {
    seedPreM203Schema(db);
    insertOwner(db, 'agent-a', 'goal-1', 100);
    runMigration203(db);

    expect(() => insertOwner(db, 'agent-b', 'goal-1', 200)).toThrow(/UNIQUE/i);
    expect(() => insertOwner(db, 'agent-a', 'goal-2', 100)).not.toThrow();
    expect(() => insertOwner(db, 'agent-b', 'goal-1', 200, 'manager')).not.toThrow();
  });

  test('is a no-op when space_long_horizon_agent_goals does not exist', () => {
    expect(() => runMigration203(db)).not.toThrow();
  });
});
