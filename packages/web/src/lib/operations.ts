import type { OperationName } from '@hyperneo/shared/types/operation-names';
import type { MessageHub, SpaceTask } from '@hyperneo/shared';

export function invokeOperation<T>(
  hub: MessageHub,
  name: OperationName,
  input?: unknown
): Promise<T> {
  return hub.request<T>('operation.invoke', { name, input });
}

export async function transitionTask(
  hub: MessageHub,
  input: { taskId: string; status: string; result?: string; expectedStatus?: string }
): Promise<SpaceTask> {
  const result = await invokeOperation<SpaceTask | string | null>(hub, 'task.transition', input);
  if (result === null) throw new Error(`Task ${input.taskId} is unavailable`);
  if (typeof result === 'string') {
    throw new Error(`Cannot move task ${input.taskId} to ${input.status}: ${result}`);
  }
  return result;
}

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
