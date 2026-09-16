import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { Logger } from '../../logger.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { createSessionOperations } from '../../session/operations.ts';
import { resolveSessionSpaceId } from '../../space/runtime/space-caller-scope.ts';
import type { FamilyOperationContext } from './context.ts';

const log = new Logger('session-operations');

export function registerSessionOperations(context: FamilyOperationContext): OperationDefinition[] {
  const scopeDeps = {
    getSession: (sessionId: string) => context.deps.db.getSession(sessionId),
    taskRepo: context.spaceTaskRepo,
    nodeExecutionRepo: context.nodeExecutionRepo,
    longHorizonAgentRepo: context.longHorizonAgentRepo,
  };
  return createSessionOperations({
    getDatabase: () => context.deps.db.getDatabase(),
    getLiveSession: (sessionId) =>
      context.taskAgentManager?.getCachedAgentSessionById(sessionId) ??
      context.deps.sessionManager.getCachedSession(sessionId) ??
      null,
    getSession: scopeDeps.getSession,
    sessionSpaceId: (session) => resolveSessionSpaceId(session, scopeDeps),
    audit: (entry) => {
      try {
        new McpAuditLogRepository(context.deps.db.getDatabase()).createEntry({
          sessionId: entry.caller.sessionId,
          agentName: entry.caller.agentName,
          toolName: entry.toolName,
          spaceId: entry.spaceId,
          paramsSummary: JSON.stringify(entry.paramsSummary),
        });
      } catch (err) {
        log.warn('session audit write failed:', err);
      }
    },
  });
}
