import { createInactivityOperations } from '../../external-events/inactivity-operations.ts';
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
    ...createSubscriptionOperations({
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
    ...createInactivityOperations({
      configRepo: context.spaceAgentInactivityConfigRepo,
      claimRepo: context.spaceAgentInactivityClaimRepo,
      runNow: (spaceId, agentId) =>
        context.spaceRuntimeService.runInactivityScanNow(spaceId, agentId),
      getSession: (sessionId) => context.deps.db.getSession(sessionId),
      taskRepo: context.spaceTaskRepo,
      nodeExecutionRepo: context.nodeExecutionRepo,
      longHorizonAgentRepo: context.longHorizonAgentRepo,
    }),
  ];
}
