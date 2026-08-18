import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';

export interface McpAuditLogEntry {
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

export interface CreateMcpAuditLogParams {
  agentName?: string | null;
  sessionId?: string | null;
  toolName: string;
  paramsSummary?: string | null;
  spaceId?: string | null;
  taskId?: string | null;
  workflowRunId?: string | null;
}

export class McpAuditLogRepository {
  constructor(private db: BunDatabase) {}

  createEntry(params: CreateMcpAuditLogParams): McpAuditLogEntry {
    const id = generateUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO mcp_audit_log (id, timestamp, agent_name, session_id, tool_name, params_summary, space_id, task_id, workflow_run_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        now,
        params.agentName ?? null,
        params.sessionId ?? null,
        params.toolName,
        params.paramsSummary ?? null,
        params.spaceId ?? null,
        params.taskId ?? null,
        params.workflowRunId ?? null
      );

    return {
      id,
      timestamp: now,
      agentName: params.agentName ?? null,
      sessionId: params.sessionId ?? null,
      toolName: params.toolName,
      paramsSummary: params.paramsSummary ?? null,
      spaceId: params.spaceId ?? null,
      taskId: params.taskId ?? null,
      workflowRunId: params.workflowRunId ?? null,
    };
  }

  listBySpace(spaceId: string, limit = 100, offset = 0): McpAuditLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mcp_audit_log WHERE space_id = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(spaceId, limit, offset) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  listByTask(taskId: string, limit = 100, offset = 0): McpAuditLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mcp_audit_log WHERE task_id = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(taskId, limit, offset) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  listByTaskAndSpace(taskId: string, spaceId: string, limit = 100, offset = 0): McpAuditLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mcp_audit_log WHERE task_id = ? AND space_id = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(taskId, spaceId, limit, offset) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  listBySession(sessionId: string, limit = 100, offset = 0): McpAuditLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mcp_audit_log WHERE session_id = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(sessionId, limit, offset) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  listBySessionAndSpace(
    sessionId: string,
    spaceId: string,
    limit = 100,
    offset = 0
  ): McpAuditLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mcp_audit_log WHERE session_id = ? AND space_id = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(sessionId, spaceId, limit, offset) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  countBySpace(spaceId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM mcp_audit_log WHERE space_id = ?`)
      .get(spaceId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  countByTask(taskId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM mcp_audit_log WHERE task_id = ?`)
      .get(taskId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  countByTaskAndSpace(taskId: string, spaceId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM mcp_audit_log WHERE task_id = ? AND space_id = ?`)
      .get(taskId, spaceId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  countBySession(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM mcp_audit_log WHERE session_id = ?`)
      .get(sessionId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  countBySessionAndSpace(sessionId: string, spaceId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM mcp_audit_log WHERE session_id = ? AND space_id = ?`)
      .get(sessionId, spaceId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private rowToEntry(row: Record<string, unknown>): McpAuditLogEntry {
    return {
      id: row.id as string,
      timestamp: row.timestamp as number,
      agentName: (row.agent_name as string | null) ?? null,
      sessionId: (row.session_id as string | null) ?? null,
      toolName: row.tool_name as string,
      paramsSummary: (row.params_summary as string | null) ?? null,
      spaceId: (row.space_id as string | null) ?? null,
      taskId: (row.task_id as string | null) ?? null,
      workflowRunId: (row.workflow_run_id as string | null) ?? null,
    };
  }
}
