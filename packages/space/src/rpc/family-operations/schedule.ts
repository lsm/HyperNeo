import { McpAuditLogRepository } from '../../../../daemon/src/storage/repositories/mcp-audit-log-repository.ts';
import { Logger } from '../../../../daemon/src/lib/logger.ts';
import type { OperationDefinition } from '../../../../daemon/src/lib/operations/registry.ts';
import { createScheduleOperations } from '../../../../daemon/src/lib/schedule/operations.ts';
import { resolveSessionSpaceId } from '../../../../daemon/src/lib/session-resolution/space-caller-scope.ts';
import type { SpaceFamilyContext } from './space-context.ts';

const log = new Logger('schedule-operations');

export function registerScheduleOperations(context: SpaceFamilyContext): OperationDefinition[] {
  const scopeDeps = {
    getSession: (sessionId: string) => context.deps.db.getSession(sessionId),
    taskRepo: context.spaceTaskRepo,
    nodeExecutionRepo: context.nodeExecutionRepo,
    longHorizonAgentRepo: context.longHorizonAgentRepo,
    hasDirectWorkerProvenance: context.hasDirectWorkerProvenance,
    resolveDirectWorker: context.resolveDirectWorker,
  };
  return createScheduleOperations({
    schedules: context.scheduleService,
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
        log.warn('schedule audit write failed:', err);
      }
    },
  });
}
