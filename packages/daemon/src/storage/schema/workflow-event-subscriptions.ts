import type { Database as BunDatabase } from '../sqlite-compat';

/**
 * Durable store for runtime-registered workflow external-event subscriptions.
 *
 * The in-memory `TopicTrie` in `SpaceRuntime` is a *derived index* over this
 * table: every runtime subscription (workflow-template `static` interests and
 * agent-registered `dynamic` interests) is written through here, and the trie
 * is rebuilt from these rows on daemon rehydrate. Without this table, ad-hoc
 * `dynamic` subscriptions (e.g. a coder subscribing to its own PR via
 * `subscribe_pr_events`) lived only in the trie and were silently lost on
 * daemon restart.
 *
 * Keying: a subscription is uniquely identified by its agent slot
 * (workflow_run_id + task_id + node_id + agent_name), the (case-insensitive)
 * topic pattern, and the subscription kind. `topic` preserves the original
 * casing; `topic_normalized` (lowercased) is the dedup/conflict key so that
 * `GitHub/Foo` and `github/foo` collapse to one row — matching the trie's
 * case-insensitive segment matching and the existing remove-then-insert dedup.
 */
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
			subscription_kind TEXT NOT NULL DEFAULT 'dynamic'
				CHECK(subscription_kind IN ('static', 'dynamic')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(workflow_run_id, task_id, node_id, agent_name, topic_normalized, subscription_kind),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
  // Per-space rebuild on rehydrate (mirrors long-horizon subscription lookup).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_wf_event_subs_space ` +
      `ON space_workflow_event_subscriptions(space_id)`
  );
  // Run-scoped teardown / static-interest refresh.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_wf_event_subs_run ` +
      `ON space_workflow_event_subscriptions(workflow_run_id, subscription_kind)`
  );
  // Task-scoped cleanup (clearTaskInterests*).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_wf_event_subs_task ` +
      `ON space_workflow_event_subscriptions(task_id, subscription_kind)`
  );
}
