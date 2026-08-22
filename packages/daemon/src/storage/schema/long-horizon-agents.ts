import type { Database as BunDatabase } from '../sqlite-compat';

export function createLongHorizonAgentTables(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_long_horizon_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			handle TEXT NOT NULL,
			display_name TEXT NOT NULL,
			template_key TEXT DEFAULT NULL,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'disabled', 'archived')),
			session_id TEXT DEFAULT NULL,
			instructions TEXT NOT NULL DEFAULT '',
			autonomy_level INTEGER DEFAULT NULL
				CHECK(autonomy_level IS NULL OR autonomy_level BETWEEN 1 AND 5),
			model TEXT DEFAULT NULL,
			thinking_level TEXT DEFAULT NULL,
			provider TEXT DEFAULT NULL,
			setting_sources TEXT DEFAULT NULL,
			tool_permissions_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_space_long_horizon_agents_handle ` +
      `ON space_long_horizon_agents(space_id, handle) WHERE status != 'archived'`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_long_horizon_agents_space_status ` +
      `ON space_long_horizon_agents(space_id, status)`
  );
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_long_horizon_agent_goals (
			agent_id TEXT NOT NULL,
			goal_id TEXT NOT NULL,
			relationship TEXT NOT NULL DEFAULT 'owner'
				CHECK(relationship IN ('owner', 'manager', 'watcher')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(agent_id, goal_id, relationship),
			FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE,
			FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_lh_agent_goals_goal ` +
      `ON space_long_horizon_agent_goals(goal_id)`
  );
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_long_horizon_agent_forge_scopes (
			agent_id TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			relationship TEXT NOT NULL DEFAULT 'owner'
				CHECK(relationship IN ('owner', 'manager', 'watcher')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(agent_id, scope_id, relationship),
			FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_lh_agent_scopes_scope ` +
      `ON space_long_horizon_agent_forge_scopes(scope_id)`
  );
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_long_horizon_agent_reminders (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			title TEXT NOT NULL,
			body TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'fired', 'cancelled')),
			trigger_type TEXT NOT NULL CHECK(trigger_type IN ('at', 'cron')),
			run_at INTEGER DEFAULT NULL,
			cron_expression TEXT DEFAULT NULL,
			timezone TEXT NOT NULL DEFAULT 'UTC',
			next_run_at INTEGER DEFAULT NULL,
			last_fired_at INTEGER DEFAULT NULL,
			created_by_session TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_lh_agent_reminders_due ` +
      `ON space_long_horizon_agent_reminders(status, next_run_at) WHERE status = 'active'`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_lh_agent_reminders_agent ` +
      `ON space_long_horizon_agent_reminders(agent_id, status)`
  );
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_long_horizon_agent_event_subscriptions (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			source TEXT NOT NULL,
			topic TEXT NOT NULL,
			filter_json TEXT NOT NULL DEFAULT '{}',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'disabled')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(space_id, agent_id, source, topic, filter_json),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_lh_agent_subscriptions_route ` +
      `ON space_long_horizon_agent_event_subscriptions(space_id, source, topic, status)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_lh_agent_subscriptions_agent ` +
      `ON space_long_horizon_agent_event_subscriptions(agent_id, status)`
  );
}
