import type { McpAuditLogRepository } from '../../storage/repositories/mcp-audit-log-repository.ts';

interface AuditEntriesQuery {
  task_id?: string;
  session_id?: string;
  limit?: number;
  offset?: number;
}

export interface AuditEntryView {
  id: string;
  timestamp: number;
  agentName: string | null;
  sessionId: string | null;
  toolName: string;
  paramsSummary: string | null;
  spaceId: string | null;
  taskId: string | null;
  workflowRunId: string | null;
}

interface AuditEntriesPage {
  entries: AuditEntryView[];
  total: number;
  has_more: boolean;
}

export function queryAuditEntriesPage(
  auditLogRepo: McpAuditLogRepository,
  spaceId: string,
  args: AuditEntriesQuery
): AuditEntriesPage {
  const limit = Math.min(args.limit ?? 20, 100);
  const offset = args.offset ?? 0;
  let entries: ReturnType<typeof auditLogRepo.listBySpace>;
  let total: number;
  if (args.task_id) {
    entries = auditLogRepo.listByTaskAndSpace(args.task_id, spaceId, limit, offset);
    total = auditLogRepo.countByTaskAndSpace(args.task_id, spaceId);
  } else if (args.session_id) {
    entries = auditLogRepo.listBySessionAndSpace(args.session_id, spaceId, limit, offset);
    total = auditLogRepo.countBySessionAndSpace(args.session_id, spaceId);
  } else {
    entries = auditLogRepo.listBySpace(spaceId, limit, offset);
    total = auditLogRepo.countBySpace(spaceId);
  }
  return {
    entries: entries.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      agentName: e.agentName,
      sessionId: e.sessionId,
      toolName: e.toolName,
      paramsSummary: e.paramsSummary,
      spaceId: e.spaceId,
      taskId: e.taskId,
      workflowRunId: e.workflowRunId,
    })),
    total,
    has_more: offset + entries.length < total,
  };
}
