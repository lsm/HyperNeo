import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { createArtifactOperations } from '../../artifacts/artifact-operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerArtifactOperations(context: FamilyOperationContext): OperationDefinition[] {
  return createArtifactOperations({
    nodeExecutionRepo: context.nodeExecutionRepo,
    artifactRepo: context.artifactRepo,
    auditLogRepo: new McpAuditLogRepository(context.deps.db.getDatabase()),
    getSession: (sessionId) => context.deps.db.getSession(sessionId),
  });
}
