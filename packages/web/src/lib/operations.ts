import type { MessageHub } from '@hyperneo/shared';

export function invokeOperation<T>(hub: MessageHub, name: string, input?: unknown): Promise<T> {
  return hub.request<T>('operation.invoke', { name, input });
}

const TRANSITION_REJECTIONS = ['unsupported_status', 'invalid_transition', 'result_requires_done'];

export async function transitionTask<T>(
  hub: MessageHub,
  taskId: string,
  status: string
): Promise<T> {
  const result = await invokeOperation<T | string | null>(hub, 'task.transition', {
    taskId,
    status,
  });
  if (result === null) throw new Error(`Task ${taskId} is no longer available`);
  if (typeof result === 'string' && TRANSITION_REJECTIONS.includes(result))
    throw new Error(`Cannot move task ${taskId} to ${status}: ${result}`);
  return result as T;
}
