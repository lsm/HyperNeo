import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import {
  type AgentTemplateOperationDependencies,
  createAgentTemplateOperations,
} from '../../agents/agent-template-operations.ts';
import type { CreateAgentDependencies } from '../../agents/create-agent-operation.ts';
import { reminderOccurrenceIsClaimed } from '../../agents/reminder-delivery-registry.ts';
import { createAgentOperations } from '../../agents/operations.ts';
import {
  publishSpaceAgentV2Mirror,
  publishUnifiedAgentCreated,
  publishUnifiedAgentUpdated,
} from '../../agents/unified-agent-events.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerAgentOperations(context: FamilyOperationContext): OperationDefinition[] {
  const publishAgentCreated: CreateAgentDependencies['publishAgentCreated'] = (
    agent,
    sessionId
  ) => {
    void publishUnifiedAgentCreated(context.deps.internalEventBus, agent, sessionId);
    void publishSpaceAgentV2Mirror(
      context.deps.internalEventBus,
      context.spaceAgentRepo,
      agent.spaceId,
      agent.id,
      'created'
    );
  };
  const audit: AgentTemplateOperationDependencies['audit'] = (
    operationName,
    summary,
    caller,
    spaceId
  ) => {
    new McpAuditLogRepository(context.deps.db.getDatabase()).createEntry({
      sessionId: caller.sessionId,
      agentName: caller.agentName,
      toolName: operationName,
      spaceId,
      paramsSummary: JSON.stringify(summary),
    });
  };
  return [
    ...createAgentOperations({
      getSession: (sessionId) => context.deps.db.getSession(sessionId),
      longHorizonAgentRepo: context.longHorizonAgentRepo,
      reminderRepo: context.spaceAgentReminderRepo,
      occurrenceIsClaimed: (spaceId, agentId, idempotencyKey) =>
        reminderOccurrenceIsClaimed(context.deps.db, spaceId, agentId, idempotencyKey),
      taskRepo: context.spaceTaskRepo,
      nodeExecutionRepo: context.nodeExecutionRepo,
      publishAgentCreated,
      publishAgentUpdated: (agent, sessionId) => {
        void publishUnifiedAgentUpdated(context.deps.internalEventBus, agent, sessionId);
        void publishSpaceAgentV2Mirror(
          context.deps.internalEventBus,
          context.spaceAgentRepo,
          agent.spaceId,
          agent.id,
          'updated'
        );
      },
      refreshAgentSubscriptions: (spaceId, agentId) =>
        context.spaceRuntimeService.refreshLongHorizonAgentSubscriptions(spaceId, agentId),
      clearAgentSessionProvider: (spaceId, agentId) =>
        context.spaceRuntimeService.clearLongTermAgentSessionProvider(spaceId, agentId),
      ensureAgentSession: (spaceId, agentId) =>
        context.spaceRuntimeService.ensureAgentSession(spaceId, agentId),
      getGoalSpace: (goalId) => context.spaceGoalService.getGoal(goalId)?.spaceId ?? null,
      getForgeScopeSpace: (scopeId) =>
        context.evolutionScopeService.getScope(scopeId)?.spaceId ?? null,
      goalScopeRepo: context.spaceAgentGoalScopeRepo,
      publishGoalOwnerChanged: (spaceId, goalId, sessionId) => {
        context.deps.internalEventBus
          .publish('spaceGoal.ownerChanged', { sessionId, spaceId, goalId })
          .catch(() => {});
      },
      audit,
    }),
    ...createAgentTemplateOperations({
      getDatabase: () => context.deps.db.getDatabase(),
      getSession: (sessionId) => context.deps.db.getSession(sessionId),
      longHorizonAgentRepo: context.longHorizonAgentRepo,
      templateManager: context.spaceAgentTemplateManager,
      subscriptionRepo: context.spaceAgentSubscriptionRepo,
      reminderRepo: context.spaceAgentReminderRepo,
      refreshSubscription: (spaceId, subscriptionId) =>
        context.spaceRuntimeService.refreshLongHorizonSubscription(spaceId, subscriptionId),
      getSpaceAutonomyLevel: async (spaceId) => {
        const space = await context.deps.spaceManager.getSpace(spaceId);
        return space?.autonomyLevel ?? 1;
      },
      publishAgentCreated,
      audit,
    }),
  ];
}
