import type { Database as BunDatabase } from 'bun:sqlite';

export function createEvolutionTables(db: BunDatabase): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS evolution_scopes (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			space_goal_id TEXT,
			kind TEXT NOT NULL
				CHECK(kind IN ('mission', 'project', 'campaign', 'workflow', 'custom')),
			name TEXT NOT NULL,
			objective TEXT NOT NULL,
			parent_scope_id TEXT,
			metric_definitions_json TEXT NOT NULL DEFAULT '[]',
			policy_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (space_goal_id) REFERENCES space_goals(id) ON DELETE SET NULL,
			FOREIGN KEY (parent_scope_id) REFERENCES evolution_scopes(id) ON DELETE SET NULL
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_scopes_space ON evolution_scopes(space_id, updated_at DESC)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_scopes_goal ON evolution_scopes(space_goal_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_scopes_parent ON evolution_scopes(parent_scope_id)`
	);

	db.exec(`
		CREATE TABLE IF NOT EXISTS evolution_evidence (
			id TEXT PRIMARY KEY,
			scope_id TEXT NOT NULL,
			kind TEXT NOT NULL
				CHECK(kind IN ('task', 'workflow_run', 'session', 'manual_note', 'metric_snapshot', 'task_result', 'artifact', 'error')),
			summary TEXT NOT NULL,
			source_id TEXT,
			metadata_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_evidence_scope_created ON evolution_evidence(scope_id, created_at DESC)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_evidence_source ON evolution_evidence(kind, source_id)`
	);

	db.exec(`
		CREATE TABLE IF NOT EXISTS evolution_episodes (
			id TEXT PRIMARY KEY,
			scope_id TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft'
				CHECK(status IN ('draft', 'accepted', 'dismissed')),
			title TEXT NOT NULL,
			time_window_json TEXT,
			evidence_ids_json TEXT NOT NULL DEFAULT '[]',
			outcome_summary TEXT NOT NULL DEFAULT '',
			findings_json TEXT NOT NULL DEFAULT '[]',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_episodes_scope_created ON evolution_episodes(scope_id, created_at DESC)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_episodes_scope_status ON evolution_episodes(scope_id, status, updated_at DESC)`
	);

	db.exec(`
		CREATE TABLE IF NOT EXISTS evolution_lessons (
			id TEXT PRIMARY KEY,
			scope_id TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'candidate'
				CHECK(status IN ('candidate', 'active', 'dismissed')),
			applies_to_json TEXT NOT NULL DEFAULT '[]',
			rule TEXT NOT NULL,
			why TEXT NOT NULL,
			evidence_episode_ids_json TEXT NOT NULL DEFAULT '[]',
			confidence REAL NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_lessons_scope_status ON evolution_lessons(scope_id, status, updated_at DESC)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_lessons_scope_confidence ON evolution_lessons(scope_id, confidence DESC)`
	);

	db.exec(`
		CREATE TABLE IF NOT EXISTS evolution_task_proposals (
			id TEXT PRIMARY KEY,
			scope_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			reason TEXT NOT NULL,
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			status TEXT NOT NULL DEFAULT 'proposed'
				CHECK(status IN ('proposed', 'accepted', 'dismissed', 'created')),
			evidence_episode_ids_json TEXT NOT NULL DEFAULT '[]',
			created_task_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE,
			FOREIGN KEY (created_task_id) REFERENCES space_tasks(id) ON DELETE SET NULL
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_task_proposals_scope_status ON evolution_task_proposals(scope_id, status, updated_at DESC)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_task_proposals_created_task ON evolution_task_proposals(created_task_id)`
	);

	db.exec(`
		CREATE TABLE IF NOT EXISTS evolution_metric_snapshots (
			id TEXT PRIMARY KEY,
			scope_id TEXT NOT NULL,
			captured_at INTEGER NOT NULL,
			values_json TEXT NOT NULL DEFAULT '{}',
			source TEXT NOT NULL,
			note TEXT,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_evolution_metric_snapshots_scope_captured ON evolution_metric_snapshots(scope_id, captured_at DESC)`
	);
}
