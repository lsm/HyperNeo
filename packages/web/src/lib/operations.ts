import type { MessageHub, SpaceTask } from '@hyperneo/shared';

export function invokeOperation<T>(hub: MessageHub, name: string, input?: unknown): Promise<T> {
  return hub.request<T>('operation.invoke', { name, input });
}

export async function transitionTask(
  hub: MessageHub,
  input: { taskId: string; status: string; result?: string }
): Promise<SpaceTask> {
  const result = await invokeOperation<SpaceTask | string | null>(hub, 'task.transition', input);
  if (result === null) throw new Error(`Task ${input.taskId} is unavailable`);
  if (typeof result === 'string') {
    throw new Error(`Cannot move task ${input.taskId} to ${input.status}: ${result}`);
  }
  return result;
}
