/**
 * Durable CRUD for runtime-registered workflow external-event subscriptions.
 *
 * The `SpaceRuntime` in-memory `TopicTrie` is a *derived index* over this
 * table — runtime registration/removal is write-through (table + trie), and
 * the trie is rebuilt from these rows on rehydrate. This is what lets an
 * agent-registered `dynamic` subscription (e.g. a coder subscribing to its own
 * PR via `subscribe_pr_events`) survive a daemon restart.
 *
 * See `space_workflow_event_subscriptions` (migration 185) for the schema and
 * the dedup keying rationale.
 */

import { generateUUID } from '@hyperneo/shared';
import { createWorkflowEventSubscriptionTables } from '../schema/workflow-event-subscriptions';
import type { Database as BunDatabase } from '../sqlite-compat';

/**
 * The persisted kind. Only `dynamic` subscriptions are stored — static template
 * interests are re-materialized from the workflow definition, so the table's
 * CHECK constrains this to `'dynamic'`.
 */
export type WorkflowSubscriptionKind = 'dynamic';

export interface SpaceWorkflowEventSubscription {
  id: string;
  spaceId: string;
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
  /** Original (preserved-casing) topic pattern. */
  topic: string;
  /** Lowercased topic — the dedup/conflict key, matches trie matching. */
  topicNormalized: string;
  subscriptionKind: WorkflowSubscriptionKind;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertWorkflowEventSubscriptionParams {
  spaceId: string;
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
  topic: string;
  subscriptionKind: WorkflowSubscriptionKind;
}

function normalizeTopic(topic: string): string {
  return topic.toLowerCase();
}

export class SpaceWorkflowEventSubscriptionRepository {
  constructor(private readonly db: BunDatabase) {}

  /**
   * Create the table if missing. Called by `SpaceRuntime` on construction so a
   * runtime built against a DB that has not yet run migrations still has the
   * table — mirrors `ToolContinuationRecoveryRepository.ensureSchema`.
   */
  ensureSchema(): void {
    createWorkflowEventSubscriptionTables(this.db);
  }

  /**
   * Insert or update a subscription keyed by (slot, topic_normalized, kind).
   * Idempotent — re-registering the same topic for the same slot touches
   * `updated_at` rather than creating a duplicate row, matching the trie's
   * remove-then-insert dedup. Returns void; callers that need the row read it
   * back via the list methods.
   */
  upsert(params: UpsertWorkflowEventSubscriptionParams): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_workflow_event_subscriptions (
					id, space_id, workflow_run_id, task_id, node_id, agent_name,
					topic, topic_normalized, subscription_kind, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(workflow_run_id, task_id, node_id, agent_name, topic_normalized, subscription_kind)
				DO UPDATE SET topic = excluded.topic, updated_at = excluded.updated_at`
      )
      .run(
        generateUUID(),
        params.spaceId,
        params.workflowRunId,
        params.taskId,
        params.nodeId,
        params.agentName,
        params.topic,
        normalizeTopic(params.topic),
        params.subscriptionKind,
        now,
        now
      );
  }

  /**
   * Remove a single subscription identified by its slot + topic + kind.
   * `topic` is matched case-insensitively. Used by `unregisterSubscription`.
   */
  deleteBySlotTopic(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string,
    topic: string,
    subscriptionKind: WorkflowSubscriptionKind
  ): void {
    this.db
      .prepare(
        `DELETE FROM space_workflow_event_subscriptions
		 WHERE workflow_run_id = ? AND task_id = ? AND node_id = ? AND agent_name = ?
		   AND topic_normalized = ? AND subscription_kind = ?`
      )
      .run(workflowRunId, taskId, nodeId, agentName, normalizeTopic(topic), subscriptionKind);
  }

  /** Remove every subscription for an agent slot (run + task + node + agent). */
  deleteBySlot(workflowRunId: string, taskId: string, nodeId: string, agentName: string): void {
    this.db
      .prepare(
        `DELETE FROM space_workflow_event_subscriptions
		 WHERE workflow_run_id = ? AND task_id = ? AND node_id = ? AND agent_name = ?`
      )
      .run(workflowRunId, taskId, nodeId, agentName);
  }

  /** Remove every subscription for a run (full teardown). */
  deleteByRun(workflowRunId: string): void {
    this.db
      .prepare(`DELETE FROM space_workflow_event_subscriptions WHERE workflow_run_id = ?`)
      .run(workflowRunId);
  }

  /** Remove every subscription for a task (noncanonical duplicate cleanup). */
  deleteByTask(taskId: string): void {
    this.db.prepare(`DELETE FROM space_workflow_event_subscriptions WHERE task_id = ?`).run(taskId);
  }

  /** All subscriptions for a space — drives the per-space trie rebuild. */
  listBySpace(spaceId: string): SpaceWorkflowEventSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_workflow_event_subscriptions
		 WHERE space_id = ? ORDER BY created_at ASC`
      )
      .all(spaceId) as Record<string, unknown>[];
    return rows.map(rowToSubscription);
  }
}

function rowToSubscription(row: Record<string, unknown>): SpaceWorkflowEventSubscription {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    workflowRunId: row.workflow_run_id as string,
    taskId: row.task_id as string,
    nodeId: row.node_id as string,
    agentName: row.agent_name as string,
    topic: row.topic as string,
    topicNormalized: row.topic_normalized as string,
    subscriptionKind: row.subscription_kind as WorkflowSubscriptionKind,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
