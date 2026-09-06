import { describe, expect, test } from 'bun:test';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration235 } from '../../../../../src/storage/schema/m235-expire-legacy-pending-agent-messages.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';

const LEGACY_TABLE = 'pending_agent_messages';

function makeLegacyPendingDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.exec(`
    CREATE TABLE ${LEGACY_TABLE} (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_agent_name TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      last_attempt_at INTEGER
    )
  `);
  db.prepare(
    `INSERT INTO ${LEGACY_TABLE} (id, workflow_run_id, space_id, target_kind, target_agent_name, message, status)
     VALUES (?, 'run-1', 'space-1', 'node_agent', 'reviewer', 'queued before upgrade', 'pending')`
  ).run('pending-1');
  db.prepare(
    `INSERT INTO ${LEGACY_TABLE} (id, workflow_run_id, space_id, target_kind, target_agent_name, message, status)
     VALUES (?, 'run-1', 'space-1', 'node_agent', 'coder', 'already delivered', 'delivered')`
  ).run('delivered-1');
  return db;
}

function rowById(db: BunDatabase, id: string): { status: string; last_error: string | null } {
  return db.prepare(`SELECT status, last_error FROM ${LEGACY_TABLE} WHERE id = ?`).get(id) as {
    status: string;
    last_error: string | null;
  };
}

describe('Migration 235: expire legacy pending_agent_messages rows', () => {
  test('settles surviving pending rows as expired with a deploy note', () => {
    const db = makeLegacyPendingDb();
    runMigration235(db);

    const settled = rowById(db, 'pending-1');
    expect(settled.status).toBe('expired');
    expect(settled.last_error).toBe(
      'dropped at deploy: pending_agent_messages queue removed (W3c)'
    );

    expect(rowById(db, 'delivered-1').status).toBe('delivered');
    db.close();
  });

  test('is idempotent and skips databases without the legacy table', () => {
    const db = makeLegacyPendingDb();
    runMigration235(db);
    runMigration235(db);
    expect(rowById(db, 'pending-1').status).toBe('expired');
    db.close();

    const fresh = new BunDatabase(':memory:');
    fresh.exec('PRAGMA foreign_keys = ON');
    runMigrations(fresh, () => {});
    runMigration235(fresh);
    expect(
      fresh
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(LEGACY_TABLE)
    ).toBeUndefined();
    fresh.close();
  });
});
