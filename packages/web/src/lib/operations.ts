import type { OperationName } from '@hyperneo/shared/types/operation-names';
import type { MessageHub } from '@hyperneo/shared';

export function invokeOperation<T>(
  hub: MessageHub,
  name: OperationName,
  input?: unknown,
  options?: { timeout?: number }
): Promise<T> {
  return options
    ? hub.request<T>('operation.invoke', { name, input }, options)
    : hub.request<T>('operation.invoke', { name, input });
}

export type OperationRejection = { accepted: false; reason: string; detail?: string };

export function requireAccepted<T>(
  result: T | OperationRejection,
  message: (rejection: OperationRejection) => string = (rejection) =>
    rejection.detail ?? rejection.reason
): T {
  if (
    typeof result === 'object' &&
    result !== null &&
    'accepted' in result &&
    result.accepted === false
  )
    throw new Error(message(result));
  return result as T;
}
