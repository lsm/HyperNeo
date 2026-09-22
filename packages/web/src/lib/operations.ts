import type { OperationName } from '@hyperneo/shared/types/operation-names';
import type { MessageHub, SpaceTask } from '@hyperneo/shared';

export function invokeOperation<T>(
  hub: MessageHub,
  name: OperationName,
  input?: unknown
): Promise<T> {
  return hub.request<T>('operation.invoke', { name, input });
}

const TRANSITION_REJECTION_MESSAGES: Record<string, string> = {
  space_at_task_capacity:
    'This Space is already running as many tasks as it allows. Stop or finish a running task, or raise the Space task limit, then try again.',
  archive_active_run:
    'This task belongs to a workflow run that is still going. Cancel the run first — archiving now would leave it stranded.',
};

export async function transitionTask(
  hub: MessageHub,
  input: { taskId: string; status: string; result?: string; expectedStatus?: string }
): Promise<TaskTransitionResult> {
  const result = await invokeOperation<
    TaskTransitionResult | { accepted: false; reason: string } | string | null
  >(hub, 'task.transition', input);
  if (result === null) throw new Error(`Task ${input.taskId} is unavailable`);
  if (typeof result === 'string') {
    const friendly = TRANSITION_REJECTION_MESSAGES[result];
    if (friendly) throw new Error(friendly);
    throw new Error(`Cannot move task ${input.taskId} to ${input.status}: ${result}`);
  }
  if ('accepted' in result && !result.accepted) {
    throw new Error(`Cannot move task ${input.taskId} to ${input.status}: ${result.reason}`);
  }
  return result;
}

export type TaskTransitionResult = SpaceTask | { accepted: true; jobId: string | null };

export async function editTaskMetadata(
  hub: MessageHub,
  input: {
    taskId: string;
    title?: string;
    description?: string;
    priority?: SpaceTask['priority'];
    labels?: string[];
  }
): Promise<SpaceTask> {
  const result = await invokeOperation<SpaceTask | null>(hub, 'task.update', input);
  if (result === null) throw new Error(`Task ${input.taskId} is unavailable`);
  return result;
}

const PREFERRED_WORKFLOW_REJECTIONS: Record<string, string> = {
  workflow_locked: 'the task has already started',
  workflow_not_found: 'that workflow is not available in this space',
  workflow_disabled: 'that workflow is disabled',
};

export async function setPreferredWorkflow(
  hub: MessageHub,
  input: { taskId: string; workflowId: string | null }
): Promise<SpaceTask> {
  const result = await invokeOperation<SpaceTask | string | null>(
    hub,
    'task.setPreferredWorkflow',
    input
  );
  if (result === null) throw new Error(`Task ${input.taskId} is unavailable`);
  if (typeof result === 'string') {
    const detail = PREFERRED_WORKFLOW_REJECTIONS[result] ?? result;
    throw new Error(`Cannot change the workflow for task ${input.taskId}: ${detail}`);
  }
  return result;
}
