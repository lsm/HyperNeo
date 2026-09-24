import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { createEvolutionOperations } from '../../evolution/operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerEvolutionOperations(
  context: FamilyOperationContext
): OperationDefinition[] {
  return createEvolutionOperations({
    getSession: (sessionId) => context.deps.db.getSession(sessionId),
    longHorizonAgentRepo: context.longHorizonAgentRepo,
    hasDirectWorkerProvenance: context.hasDirectWorkerProvenance,
    resolveDirectWorker: context.resolveDirectWorker,
    nodeExecutionRepo: context.nodeExecutionRepo,
    taskRepo: context.spaceTaskRepo,
    workflowRunRepo: context.spaceWorkflowRunRepo,
    scopeService: context.evolutionScopeService,
    episodeService: context.evolutionEpisodeService,
    getGoal: (goalId) => context.spaceGoalService.getGoal(goalId),
    db: context.deps.db.getDatabase(),
    goalRepo: context.spaceGoalRepo,
    scheduleService: context.scheduleService,
    audit: (entry) =>
      new McpAuditLogRepository(context.deps.db.getDatabase()).createEntry({
        agentName: entry.caller.agentName,
        sessionId: entry.caller.sessionId,
        toolName: entry.toolName,
        paramsSummary: JSON.stringify(entry.paramsSummary),
        spaceId: entry.spaceId,
        taskId: entry.taskId,
      }),
  });
}
