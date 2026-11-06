import { McpAuditLogRepository } from '../../../../daemon/src/storage/repositories/mcp-audit-log-repository.ts';
import { createArtifactOperations } from '../../../../daemon/src/lib/artifacts/artifact-operations.ts';
import type { OperationDefinition } from '../../../../daemon/src/lib/operations/registry.ts';
import type { SpaceFamilyContext } from './space-context.ts';

export function registerArtifactOperations(context: SpaceFamilyContext): OperationDefinition[] {
  return createArtifactOperations({
    nodeExecutionRepo: context.nodeExecutionRepo,
    artifactRepo: context.artifactRepo,
    auditLogRepo: new McpAuditLogRepository(context.deps.db.getDatabase()),
    getSession: (sessionId) => context.deps.db.getSession(sessionId),
  });
}
