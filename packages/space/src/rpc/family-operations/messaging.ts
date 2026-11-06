import { createNodeMessagingOperations } from '../../../../daemon/src/lib/messaging/node-messaging-operations.ts';
import type { OperationDefinition } from '../../../../daemon/src/lib/operations/registry.ts';
import type { SpaceFamilyContext } from './space-context.ts';

export function registerMessagingOperations(context: SpaceFamilyContext): OperationDefinition[] {
  return createNodeMessagingOperations({
    nodeExecutionRepo: context.nodeExecutionRepo,
    runtimeForSession: (sessionId) => context.taskAgentManager.nodeMessagingRuntimeFor(sessionId),
    getSession: (sessionId) => context.deps.db.getSession(sessionId),
  });
}
