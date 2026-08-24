import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function createWorkflowEventSubscriptionTables(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_event_subscriptions (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			workflow_run_id TEXT NOT NULL,
			task_id TEXT NOT NULL,
			node_id TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			topic TEXT NOT NULL,
			topic_normalized TEXT NOT NULL,
			-- Only 'dynamic' subscriptions are persisted here (static template
			-- interests are re-materialized from the workflow definition), so the
			-- kind is fixed to 'dynamic'. The column is retained for schema clarity.
			subscription_kind TEXT NOT NULL DEFAULT 'dynamic'
				CHECK(subscription_kind = 'dynamic'),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(workflow_run_id, task_id, node_id, agent_name, topic_normalized, subscription_kind),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE,
			-- A hard-deleted task (SpaceTaskManager/GoalService deleteTask, which
			-- skips clearTaskInterests) would otherwise orphan its row, which
			-- rehydrate then re-inserts forever. Cascade like the other two FKs.
			FOREIGN KEY (task_id) REFERENCES space_tasks(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_wf_event_subs_space ` +
      `ON space_workflow_event_subscriptions(space_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_wf_event_subs_run ` +
      `ON space_workflow_event_subscriptions(workflow_run_id, subscription_kind)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_wf_event_subs_task ` +
      `ON space_workflow_event_subscriptions(task_id, subscription_kind)`
  );
}
