import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { createAgentSubscriptionOperations } from '../../external-events/agent-subscription-operations.ts';
import { createNodeAgentRestoreOperation } from '../../external-events/node-agent-restore-operation.ts';
import { createExternalEventOperations } from '../../external-events/operations.ts';
import { createSubscriptionOperations } from '../../external-events/subscription-operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerExternalEventOperations(
  context: FamilyOperationContext
): OperationDefinition[] {
  return [
    ...createExternalEventOperations({
      eventStore: context.deps.externalEventStore,
      getSession: (sessionId) => context.deps.db.getSession(sessionId),
      taskRepo: context.spaceTaskRepo,
      nodeExecutionRepo: context.nodeExecutionRepo,
      longHorizonAgentRepo: context.longHorizonAgentRepo,
    }),
    ...createAgentSubscriptionOperations({
      subscriptionRepo: context.spaceAgentSubscriptionRepo,
      refreshSubscription: (spaceId, subscriptionId) =>
        context.spaceRuntimeService.refreshLongHorizonSubscription(spaceId, subscriptionId),
      removeSubscription: (spaceId, subscriptionId) =>
        context.spaceRuntimeService.removeLongHorizonSubscription(spaceId, subscriptionId),
      auditLogRepo: new McpAuditLogRepository(context.deps.db.getDatabase()),
      getSession: (sessionId) => context.deps.db.getSession(sessionId),
      taskRepo: context.spaceTaskRepo,
      nodeExecutionRepo: context.nodeExecutionRepo,
      longHorizonAgentRepo: context.longHorizonAgentRepo,
    }),
    ...createSubscriptionOperations({
      subscriptionRepo: context.spaceAgentSubscriptionRepo,
      refreshSubscription: (spaceId, subscriptionId) =>
        context.spaceRuntimeService.refreshLongHorizonSubscription(spaceId, subscriptionId),
      removeSubscription: (spaceId, subscriptionId) =>
        context.spaceRuntimeService.removeLongHorizonSubscription(spaceId, subscriptionId),
      auditLogRepo: new McpAuditLogRepository(context.deps.db.getDatabase()),
      registerSubscription: (slot, topicPattern) =>
        context.spaceRuntimeService.registerSubscription(
          slot.workflowRunId,
          slot.taskId,
          slot.nodeId,
          slot.agentName,
          topicPattern
        ),
      unregisterSubscription: (slot, topicPattern) =>
        context.spaceRuntimeService.unregisterSubscription(
          slot.workflowRunId,
          slot.taskId,
          slot.nodeId,
          slot.agentName,
          topicPattern
        ),
      listRunSubscriptions: (workflowRunId, spaceId, nodeId) =>
        context.spaceRuntimeService.listSubscriptions(workflowRunId, spaceId, nodeId),
      resolvePrimaryLinkUrl: (workflowRunId) =>
        context.artifactProfile.resolvePrimaryLinkUrl(workflowRunId),
      getSession: (sessionId) => context.deps.db.getSession(sessionId),
      taskRepo: context.spaceTaskRepo,
      nodeExecutionRepo: context.nodeExecutionRepo,
      longHorizonAgentRepo: context.longHorizonAgentRepo,
    }),
    createNodeAgentRestoreOperation({
      restoreNodeAgent: (sessionId, reason) =>
        context.taskAgentManager.restoreNodeAgentSession(sessionId, reason),
      getSession: (sessionId) => context.deps.db.getSession(sessionId),
      taskRepo: context.spaceTaskRepo,
      nodeExecutionRepo: context.nodeExecutionRepo,
      longHorizonAgentRepo: context.longHorizonAgentRepo,
    }),
  ];
}
