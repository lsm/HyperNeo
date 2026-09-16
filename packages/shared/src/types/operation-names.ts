export const OPERATION_NAMES = [
  'externalEvent.get',
  'externalEvent.listDeliveries',
  'externalEvent.listSubscriptions',
  'externalEvent.subscribe',
  'externalEvent.unsubscribe',
  'message.send',
  'operations.describe',
  'operations.list',
  'session.message.send',
  'subscribe_pr_events',
  'task.archive',
  'task.cancel',
  'task.complete',
  'task.create',
  'task.dependencies.set',
  'task.get',
  'task.list',
  'task.members.list',
  'task.message.send',
  'task.resolvePendingCompletion',
  'task.setPreferredWorkflow',
  'task.start',
  'task.submitForReview',
  'task.transition',
  'task.update',
] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];

export function isOperationName(value: string): value is OperationName {
  return (OPERATION_NAMES as readonly string[]).includes(value);
}
