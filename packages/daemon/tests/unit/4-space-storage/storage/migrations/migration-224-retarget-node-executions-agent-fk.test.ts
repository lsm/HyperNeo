import { describe, expect, test } from 'bun:test';
import { runMigration224 } from '../../../../../src/storage/schema/m224-retarget-node-executions-agent-fk.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';

interface ForeignKeyRow {
  id: number;
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE space_workflow_runs (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE space_agents (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE space_long_horizon_agents (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      handle TEXT NOT NULL,
      display_name TEXT NOT NULL,
      template_key TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      instructions TEXT NOT NULL DEFAULT '',
      tool_permissions_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE node_executions (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      workflow_node_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      agent_id TEXT,
      agent_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'in_progress', 'idle', 'done', 'waiting_rebind', 'blocked', 'cancelled')),
      result TEXT,
      data TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL,
      last_activity_at INTEGER,
      FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES space_agents(id) ON DELETE SET NULL
    )
  `);
  db.exec(`CREATE INDEX idx_node_executions_run ON node_executions(workflow_run_id)`);
  db.exec(
    `CREATE INDEX idx_node_executions_node ON node_executions(workflow_run_id, workflow_node_id)`
  );
  db.exec(`CREATE INDEX idx_node_executions_agent_session ON node_executions(agent_session_id)`);
  db.exec(
    `CREATE UNIQUE INDEX idx_node_executions_unique_slot
       ON node_executions(workflow_run_id, workflow_node_id, agent_name)`
  );
  return db;
}

function seedRun(db: BunDatabase, runId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
     VALUES ('space-1', 'space-1', '/tmp/ws', 'Space 1', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at)
     VALUES (?, 'space-1', 'wf-1', 'Run 1', 1, 1)`
  ).run(runId);
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, created_at, updated_at)
     VALUES ('agent-1', 'space-1', 'Coder', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO space_long_horizon_agents
       (id, space_id, handle, display_name, template_key, status, instructions, tool_permissions_json, created_at, updated_at)
     VALUES ('agent-1', 'space-1', 'agent-1', 'Coder', 'migration.legacy_space_agent', 'active', '', '{}', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO node_executions
       (id, workflow_run_id, workflow_node_id, agent_name, agent_id, agent_session_id,
        status, result, data, created_at, started_at, completed_at, updated_at, last_activity_at)
     VALUES (?, ?, 'node-1', 'coder', 'agent-1', 'sess-1',
        'in_progress', 'partial', '{"k":1}', 10, 11, NULL, 13, 14)`
  ).run('exec-1', runId);
}

function foreignKeys(db: BunDatabase): ForeignKeyRow[] {
  return db.prepare(`PRAGMA foreign_key_list(node_executions)`).all() as ForeignKeyRow[];
}

function indexNames(db: BunDatabase): string[] {
  return (db.prepare(`PRAGMA index_list(node_executions)`).all() as Array<{ name: string }>).map(
    (row) => row.name
  );
}

describe('runMigration224', () => {
  test('retargets the agent_id foreign key to space_long_horizon_agents preserving rows', () => {
    const db = makeDb();
    seedRun(db, 'run-1');

    runMigration224(db);

    const fks = foreignKeys(db).filter((fk) => fk.from === 'agent_id');
    expect(fks).toHaveLength(1);
    expect(fks[0].table).toBe('space_long_horizon_agents');
    expect(fks[0].to).toBe('id');
    expect(fks[0].on_delete).toBe('SET NULL');

    const row = db.prepare(`SELECT * FROM node_executions WHERE id = 'exec-1'`).get() as Record<
      string,
      unknown
    >;
    expect(row.agent_id).toBe('agent-1');
    expect(row.agent_session_id).toBe('sess-1');
    expect(row.status).toBe('in_progress');
    expect(row.result).toBe('partial');
    expect(row.data).toBe('{"k":1}');
    expect(row.created_at).toBe(10);
    expect(row.started_at).toBe(11);
    expect(row.updated_at).toBe(13);
    expect(row.last_activity_at).toBe(14);

    expect(indexNames(db)).toEqual(
      expect.arrayContaining([
        'idx_node_executions_run',
        'idx_node_executions_node',
        'idx_node_executions_agent_session',
        'idx_node_executions_unique_slot',
      ])
    );
    db.close();
  });

  test('enforces the retargeted foreign key: deleting the unified row nulls agent_id', () => {
    const db = makeDb();
    seedRun(db, 'run-1');
    runMigration224(db);

    db.prepare(`DELETE FROM space_long_horizon_agents WHERE id = 'agent-1'`).run();

    const row = db
      .prepare(`SELECT agent_id FROM node_executions WHERE id = 'exec-1'`)
      .get() as Record<string, unknown>;
    expect(row.agent_id).toBeNull();
    db.close();
  });

  test('is idempotent: a second run leaves the retargeted schema unchanged', () => {
    const db = makeDb();
    seedRun(db, 'run-1');
    runMigration224(db);

    expect(() => runMigration224(db)).not.toThrow();

    const fks = foreignKeys(db).filter((fk) => fk.from === 'agent_id');
    expect(fks).toHaveLength(1);
    expect(fks[0].table).toBe('space_long_horizon_agents');
    const row = db.prepare(`SELECT COUNT(*) AS n FROM node_executions`).get() as { n: number };
    expect(row.n).toBe(1);
    db.close();
  });

  test('skips when node_executions is missing', () => {
    const db = new BunDatabase(':memory:');
    expect(() => runMigration224(db)).not.toThrow();
    db.close();
  });
});
