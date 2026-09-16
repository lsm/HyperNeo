import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { createAgentOperations } from '../../agents/operations.ts';
import {
  publishSpaceAgentV2Mirror,
  publishUnifiedAgentCreated,
  publishUnifiedAgentUpdated,
} from '../../agents/unified-agent-events.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerAgentOperations(context: FamilyOperationContext): OperationDefinition[] {
  return createAgentOperations({
    getSession: (sessionId) => context.deps.db.getSession(sessionId),
    longHorizonAgentRepo: context.longHorizonAgentRepo,
    reminderRepo: context.spaceAgentReminderRepo,
    taskRepo: context.spaceTaskRepo,
    nodeExecutionRepo: context.nodeExecutionRepo,
    publishAgentCreated: (agent, sessionId) => {
      void publishUnifiedAgentCreated(context.deps.internalEventBus, agent, sessionId);
      void publishSpaceAgentV2Mirror(
        context.deps.internalEventBus,
        context.spaceAgentRepo,
        agent.spaceId,
        agent.id,
        'created'
      );
    },
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
    audit: (operationName, summary, caller, spaceId) => {
      new McpAuditLogRepository(context.deps.db.getDatabase()).createEntry({
        sessionId: caller.sessionId,
        agentName: caller.agentName,
        toolName: operationName,
        spaceId,
        paramsSummary: JSON.stringify(summary),
      });
    },
  });
}
