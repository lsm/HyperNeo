import type { NodeMessagingDependencies } from '../../messaging/node-messaging-context.ts';
import { createNodeMessagingOperations } from '../../messaging/node-messaging-operations.ts';
import { createNodeSendMessageOperation } from '../../messaging/node-send-message.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

function nodeMessagingDependencies(context: FamilyOperationContext): NodeMessagingDependencies {
  return {
    nodeExecutionRepo: context.nodeExecutionRepo,
    runtimeForSession: (sessionId) => context.taskAgentManager.nodeMessagingRuntimeFor(sessionId),
    getSession: (sessionId) => context.deps.db.getSession(sessionId),
  };
}

export function registerMessagingOperations(
  context: FamilyOperationContext
): OperationDefinition[] {
  return createNodeMessagingOperations(nodeMessagingDependencies(context));
}

export function createNodeSendMessageArm(context: FamilyOperationContext): OperationDefinition {
  return createNodeSendMessageOperation(nodeMessagingDependencies(context));
}
