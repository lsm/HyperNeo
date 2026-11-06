import { McpAuditLogRepository } from '../../../../daemon/src/storage/repositories/mcp-audit-log-repository.ts';
import { createGoalOperations } from '../../goals/operations.ts';
import type { OperationDefinition } from '../../../../daemon/src/lib/operations/registry.ts';
import type { SpaceFamilyContext } from './space-context.ts';

export function registerGoalOperations(context: SpaceFamilyContext): OperationDefinition[] {
  return createGoalOperations({
    goalService: context.spaceGoalService,
    longHorizonAgentRepo: context.longHorizonAgentRepo,
    hasDirectWorkerProvenance: context.hasDirectWorkerProvenance,
    resolveDirectWorker: context.resolveDirectWorker,
    nodeExecutionRepo: context.nodeExecutionRepo,
    taskRepo: context.spaceTaskRepo,
    goalScopeRepo: context.spaceAgentGoalScopeRepo,
    getSession: (sessionId) => context.deps.db.getSession(sessionId),
    auditLogRepo: new McpAuditLogRepository(context.deps.db.getDatabase()),
  });
}
