import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration224(db: BunDatabase): void {
  if (!tableExists(db, 'node_executions')) return;
  if (!tableExists(db, 'space_long_horizon_agents')) return;
  if (!agentIdForeignKeyTargets(db, 'space_agents')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
			CREATE TABLE node_executions_m224_new (
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
				FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE SET NULL
			)
		`);

    db.exec(`
			INSERT INTO node_executions_m224_new
				(id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				 agent_session_id, status, result, data, created_at, started_at,
				 completed_at, updated_at, last_activity_at)
			SELECT
				id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				agent_session_id, status, result, data, created_at, started_at,
				completed_at, updated_at, last_activity_at
			FROM node_executions
		`);

    db.exec(`DROP TABLE node_executions`);
    db.exec(`ALTER TABLE node_executions_m224_new RENAME TO node_executions`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_node_executions_run ON node_executions(workflow_run_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_node_executions_node ON node_executions(workflow_run_id, workflow_node_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_node_executions_agent_session ON node_executions(agent_session_id)`
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_node_executions_unique_slot
			 ON node_executions(workflow_run_id, workflow_node_id, agent_name)`
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

function agentIdForeignKeyTargets(db: BunDatabase, targetTable: string): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(node_executions)`).all() as Array<{
    table: string;
    from: string;
  }>;
  return rows.some((row) => row.table === targetTable && row.from === 'agent_id');
}
