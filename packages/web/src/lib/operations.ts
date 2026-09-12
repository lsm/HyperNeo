import type { MessageHub } from '@hyperneo/shared';

export function invokeOperation<T>(hub: MessageHub, name: string, input?: unknown): Promise<T> {
  return hub.request<T>('operation.invoke', { name, input });
}
