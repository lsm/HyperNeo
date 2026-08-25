import { generateUUID } from '@hyperneo/shared';
import { createWorkflowEventSubscriptionTables } from '../schema/workflow-event-subscriptions.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

export type WorkflowSubscriptionKind = 'dynamic';

export interface SpaceWorkflowEventSubscription {
  id: string;
  spaceId: string;
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
  topic: string;
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

  ensureSchema(): void {
    createWorkflowEventSubscriptionTables(this.db);
  }

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

  deleteBySlot(workflowRunId: string, taskId: string, nodeId: string, agentName: string): void {
    this.db
      .prepare(
        `DELETE FROM space_workflow_event_subscriptions
		 WHERE workflow_run_id = ? AND task_id = ? AND node_id = ? AND agent_name = ?`
      )
      .run(workflowRunId, taskId, nodeId, agentName);
  }

  deleteByRun(workflowRunId: string): void {
    this.db
      .prepare(`DELETE FROM space_workflow_event_subscriptions WHERE workflow_run_id = ?`)
      .run(workflowRunId);
  }

  deleteByTask(taskId: string): void {
    this.db.prepare(`DELETE FROM space_workflow_event_subscriptions WHERE task_id = ?`).run(taskId);
  }

  listByRun(workflowRunId: string): SpaceWorkflowEventSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_workflow_event_subscriptions
		 WHERE workflow_run_id = ? ORDER BY created_at ASC`
      )
      .all(workflowRunId) as Record<string, unknown>[];
    return rows.map(rowToSubscription);
  }

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
