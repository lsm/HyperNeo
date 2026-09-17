import { createAuditOperations } from '../../audit/operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerAuditOperations(context: FamilyOperationContext): OperationDefinition[] {
  return createAuditOperations({
    auditLogRepo: new McpAuditLogRepository(context.deps.db.getDatabase()),
  });
}
