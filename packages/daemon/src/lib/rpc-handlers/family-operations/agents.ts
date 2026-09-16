import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { createAgentOperations } from '../../agents/operations.ts';
import {
  publishSpaceAgentV2Mirror,
  publishUnifiedAgentCreated,
} from '../../agents/unified-agent-events.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerAgentOperations(context: FamilyOperationContext): OperationDefinition[] {
  return createAgentOperations({
    getSession: (sessionId) => context.deps.db.getSession(sessionId),
    longHorizonAgentRepo: context.longHorizonAgentRepo,
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
    getGoalSpace: (goalId) => context.spaceGoalService.getGoal(goalId)?.spaceId ?? null,
    getForgeScopeSpace: (scopeId) =>
      context.evolutionScopeService.getScope(scopeId)?.spaceId ?? null,
    goalScopeRepo: context.spaceAgentGoalScopeRepo,
    publishGoalOwnerChanged: (spaceId, goalId, sessionId) => {
      context.deps.internalEventBus
        .publish('spaceGoal.ownerChanged', { sessionId, spaceId, goalId })
        .catch(() => {});
    },
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
