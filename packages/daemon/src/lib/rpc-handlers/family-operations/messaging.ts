import { createNodeMessagingOperations } from '../../messaging/node-messaging-operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerMessagingOperations(
  context: FamilyOperationContext
): OperationDefinition[] {
  return createNodeMessagingOperations({
    nodeExecutionRepo: context.nodeExecutionRepo,
    runtimeForSession: (sessionId) => context.taskAgentManager.nodeMessagingRuntimeFor(sessionId),
  });
}
