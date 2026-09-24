import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { createGoalOperations } from '../../goals/operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerGoalOperations(context: FamilyOperationContext): OperationDefinition[] {
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
