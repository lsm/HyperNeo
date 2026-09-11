import { describe, expect, test } from 'bun:test';
import { runMigration245 } from '../../../../../src/storage/schema/m245-reminder-space-index';
import { Database } from '../../../../../src/storage/sqlite-compat';

const REMINDER_QUERY = `SELECT agent_id, COUNT(*) AS reminder_count
   FROM space_long_horizon_agent_reminders
   WHERE space_id = ? AND status = 'active'
   GROUP BY agent_id`;

function createRemindersTable(db: Database): void {
  db.exec(`CREATE TABLE space_long_horizon_agent_reminders (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    run_at INTEGER,
    cron_expression TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    next_run_at INTEGER,
    last_fired_at INTEGER,
    created_by_session TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX idx_space_lh_agent_reminders_due
    ON space_long_horizon_agent_reminders(status, next_run_at) WHERE status = 'active'`);
  db.exec(`CREATE INDEX idx_space_lh_agent_reminders_agent
    ON space_long_horizon_agent_reminders(agent_id, status)`);
}

function planFor(db: Database): string {
  const steps = db.prepare(`EXPLAIN QUERY PLAN ${REMINDER_QUERY}`).all('space-1') as {
    detail: string;
  }[];
  return steps.map((step) => step.detail).join(' | ');
}

describe('migration 245', () => {
  test('creates the Space-scoped active reminder index', () => {
    const db = new Database(':memory:');
    createRemindersTable(db);

    runMigration245(db);

    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_space_lh_agent_reminders_space_active') as { sql: string } | undefined;
    expect(index?.sql).toContain('(space_id, agent_id)');
    expect(index?.sql).toContain("status = 'active'");
  });

  test('the Space count query stops scanning other Spaces', () => {
    const db = new Database(':memory:');
    createRemindersTable(db);
    expect(planFor(db)).toContain('idx_space_lh_agent_reminders_due');
    expect(planFor(db)).toContain('TEMP B-TREE');

    runMigration245(db);

    const plan = planFor(db);
    expect(plan).toContain('idx_space_lh_agent_reminders_space_active');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  test('is a no-op when the reminders table does not exist', () => {
    const db = new Database(':memory:');

    expect(() => runMigration245(db)).not.toThrow();
  });

  test('runs twice without failing', () => {
    const db = new Database(':memory:');
    createRemindersTable(db);

    runMigration245(db);

    expect(() => runMigration245(db)).not.toThrow();
  });
});
