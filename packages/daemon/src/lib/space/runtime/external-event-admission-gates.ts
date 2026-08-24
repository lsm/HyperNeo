import type { NodeExecution, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import type { ExternalEventPublishedPayload } from '../../external-events/external-event-service.ts';

export interface WorkflowTargetKey {
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
}

export type ExternalEventTaskDecision =
  | { action: 'deliver' }
  | { action: 'hold' }
  | { action: 'fail'; reason: string };

export const DEFAULT_EXTERNAL_EVENT_QUEUE_TTL_MS = 300_000;

function isExecutionForTarget(
  execution: NodeExecution,
  target: Pick<WorkflowTargetKey, 'workflowRunId' | 'nodeId' | 'agentName'>
): boolean {
  return (
    execution.workflowRunId === target.workflowRunId &&
    execution.workflowNodeId === target.nodeId &&
    execution.agentName === target.agentName
  );
}

export function resolveCurrentQueueableOrActiveExecution(
  executions: readonly NodeExecution[],
  target: Pick<WorkflowTargetKey, 'workflowRunId' | 'nodeId' | 'agentName'>
): NodeExecution | undefined {
  return executions
    .filter(
      (execution) => isExecutionForTarget(execution, target) && execution.status !== 'cancelled'
    )
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))[0];
}

export function resolveSubscriptionTarget<T extends WorkflowTargetKey>(
  executions: readonly NodeExecution[],
  target: T
): T & { sessionId?: string } {
  const current = resolveCurrentQueueableOrActiveExecution(executions, target);
  return current?.agentSessionId ? { ...target, sessionId: current.agentSessionId } : target;
}

export function resolveLiveDeliveryTarget<T extends WorkflowTargetKey>(
  executions: readonly NodeExecution[],
  target: T
): (T & { sessionId?: string }) | null {
  const current = resolveCurrentQueueableOrActiveExecution(executions, target);
  if (!current?.agentSessionId) return null;
  return { ...target, sessionId: current.agentSessionId };
}

export function hasTerminalExecutionForTarget(
  executions: readonly NodeExecution[],
  target: Pick<WorkflowTargetKey, 'agentName'>
): boolean {
  return executions.some(
    (execution) => execution.agentName === target.agentName && execution.status === 'cancelled'
  );
}

export function hasAnyExecutionForTarget(
  executions: readonly NodeExecution[],
  target: Pick<WorkflowTargetKey, 'agentName'>
): boolean {
  return executions.some((execution) => execution.agentName === target.agentName);
}

export function isWorkflowTargetOwnedBySpace(
  task: SpaceTask | null,
  run: SpaceWorkflowRun | null,
  spaceId: string
): boolean {
  return !!(
    task &&
    run &&
    task.spaceId === spaceId &&
    run.spaceId === spaceId &&
    task.workflowRunId === run.id
  );
}

export function prepareExternalEventTask(
  task: SpaceTask | null,
  run: SpaceWorkflowRun | null,
  event: ExternalEventPublishedPayload
): ExternalEventTaskDecision {
  if (!task || !run || !isWorkflowTargetOwnedBySpace(task, run, event.spaceId)) {
    return { action: 'fail', reason: 'invalid_target_ownership' };
  }
  if (task.status === 'cancelled' || task.status === 'archived' || task.status === 'done') {
    return { action: 'fail', reason: 'target_task_terminal' };
  }
  if (task.status === 'stopped') {
    return { action: 'hold' };
  }
  return { action: 'deliver' };
}

export function evaluateRequeueTaskLifecycle(
  task: SpaceTask | null,
  _event: { topic: string; source: string }
): string | null {
  if (!task) return 'invalid_target_ownership';
  if (task.status === 'cancelled' || task.status === 'archived' || task.status === 'done') {
    return 'target_task_terminal';
  }
  return null;
}

export function isPublishedExternalEventExpired(
  createdAt: number | undefined,
  now = Date.now(),
  ttlMs = DEFAULT_EXTERNAL_EVENT_QUEUE_TTL_MS
): boolean {
  if (createdAt === undefined) return false;
  return now - createdAt > ttlMs;
}

export function isQueuedExternalEventExpired(
  createdAt: number,
  now = Date.now(),
  ttlMs = DEFAULT_EXTERNAL_EVENT_QUEUE_TTL_MS
): boolean {
  return now - createdAt > ttlMs;
}

export function buildQueueKey(
  target: Pick<WorkflowTargetKey, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>
): string {
  return JSON.stringify([target.workflowRunId, target.taskId, target.nodeId, target.agentName]);
}
