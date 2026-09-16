import type { McpAuditLogRepository } from '../../storage/repositories/mcp-audit-log-repository.ts';
import type { ListAuditEntriesInput } from '../space/actions/node-agent-schemas.ts';
import type { ToolResult } from '../space/tools/tool-result.ts';
import { jsonResult } from '../space/tools/tool-result.ts';

interface ListAuditEntriesDeps {
  auditLogRepo?: McpAuditLogRepository;
  spaceId: string;
}

export function listAuditEntries(
  deps: ListAuditEntriesDeps,
  args: ListAuditEntriesInput
): ToolResult {
  const { auditLogRepo, spaceId } = deps;
  if (!auditLogRepo) {
    return jsonResult({ success: false, error: 'Audit log repository not available.' });
  }
  try {
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
    return jsonResult({
      success: true,
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ success: false, error: message });
  }
}
