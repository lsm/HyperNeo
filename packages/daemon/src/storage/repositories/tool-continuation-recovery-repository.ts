import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';

export type ToolContinuationStatus =
  | 'active'
  | 'waiting_rebind'
  | 'rebound'
  | 'failed'
  | 'expired'
  | 'consumed';

export type ContinuationInboxStatus = 'pending' | 'rebound' | 'failed' | 'expired';

export interface ToolContinuationRecord {
  toolUseId: string;
  sessionId: string;
  executionId: string | null;
  workflowRunId: string | null;
  status: ToolContinuationStatus;
  attempts409: number;
  recoveryReason: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface ContinuationInboxRecord {
  id: string;
  toolUseId: string;
  sessionId: string;
  executionId: string | null;
  workflowRunId: string | null;
  status: ContinuationInboxStatus;
  requestJson: string;
  recoveryReason: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface ToolContinuationOwner {
  executionId: string | null;
  workflowRunId: string | null;
}

export class ToolContinuationRecoveryRepository {
  constructor(private readonly db: BunDatabase) {}

  ensureSchema(): void {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS tool_continuation_recovery (
				tool_use_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				execution_id TEXT,
				workflow_run_id TEXT,
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'waiting_rebind', 'rebound', 'failed', 'expired', 'consumed')),
				attempts_409 INTEGER NOT NULL DEFAULT 0,
				recovery_reason TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			)
		`);
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS tool_continuation_inbox (
				id TEXT PRIMARY KEY,
				tool_use_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				execution_id TEXT,
				workflow_run_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'rebound', 'failed', 'expired')),
				request_json TEXT NOT NULL,
				recovery_reason TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			)
		`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tool_continuation_recovery_session
			 ON tool_continuation_recovery(session_id, status, expires_at)`
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tool_continuation_recovery_execution
			 ON tool_continuation_recovery(execution_id, status, expires_at)`
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tool_continuation_inbox_execution
			 ON tool_continuation_inbox(execution_id, status, expires_at)`
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tool_continuation_inbox_tool
			 ON tool_continuation_inbox(tool_use_id, status, expires_at)`
    );
  }

  resolveOwnerBySession(sessionId: string): ToolContinuationOwner {
    const row = this.db
      .prepare(
        `SELECT id, workflow_run_id
				 FROM node_executions
				 WHERE agent_session_id = ?
				 ORDER BY
				   CASE status
				     WHEN 'in_progress' THEN 0
				     WHEN 'waiting_rebind' THEN 1
				     WHEN 'blocked' THEN 2
				     WHEN 'pending' THEN 3
				     ELSE 4
				   END,
				   updated_at DESC,
				   created_at DESC
				 LIMIT 1`
      )
      .get(sessionId) as { id: string; workflow_run_id: string } | undefined;
    return {
      executionId: row?.id ?? null,
      workflowRunId: row?.workflow_run_id ?? null,
    };
  }

  recordToolUse(params: {
    toolUseId: string;
    sessionId: string;
    ttlMs: number;
    owner?: ToolContinuationOwner;
  }): ToolContinuationRecord {
    const now = Date.now();
    const owner = params.owner ?? this.resolveOwnerBySession(params.sessionId);
    const expiresAt = now + params.ttlMs;
    this.db
      .prepare(
        `INSERT INTO tool_continuation_recovery
				   (tool_use_id, session_id, execution_id, workflow_run_id, status,
				    attempts_409, recovery_reason, created_at, updated_at, expires_at)
				 VALUES (?, ?, ?, ?, 'active', 0, NULL, ?, ?, ?)
				 ON CONFLICT(tool_use_id) DO UPDATE SET
				   session_id = excluded.session_id,
				   execution_id = excluded.execution_id,
				   workflow_run_id = excluded.workflow_run_id,
				   status = 'active',
				   attempts_409 = 0,
				   recovery_reason = NULL,
				   updated_at = excluded.updated_at,
				   expires_at = excluded.expires_at`
      )
      .run(
        params.toolUseId,
        params.sessionId,
        owner.executionId,
        owner.workflowRunId,
        now,
        now,
        expiresAt
      );
    return this.getToolUse(params.toolUseId)!;
  }

  getToolUse(toolUseId: string): ToolContinuationRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM tool_continuation_recovery WHERE tool_use_id = ?`)
      .get(toolUseId) as Record<string, unknown> | undefined;
    return row ? this.rowToToolContinuation(row) : null;
  }

  markConsumed(toolUseId: string): void {
    this.updateToolUseStatus(toolUseId, 'consumed', 'tool_result delivered to live bridge session');
  }

  markWaitingRebind(toolUseId: string, reason: string): ToolContinuationRecord | null {
    const existing = this.getToolUse(toolUseId);
    if (!existing || !canMarkWaitingRebind(existing.status)) {
      return null;
    }
    const updated = this.updateToolUseStatus(toolUseId, 'waiting_rebind', reason);
    if (updated?.executionId) {
      this.markExecutionWaitingRebind(updated.executionId, reason);
    }
    return updated;
  }

  queueContinuation(params: {
    toolUseId: string;
    sessionId: string;
    requestBody: unknown;
    reason: string;
    ttlMs: number;
  }): { inbox: ContinuationInboxRecord; mapping: ToolContinuationRecord | null } {
    const now = Date.now();
    let mapping = this.getToolUse(params.toolUseId);
    if (mapping && isRecoverableToolUseStatus(mapping.status)) {
      mapping = this.markWaitingRebind(params.toolUseId, params.reason);
    } else {
      mapping = null;
    }
    const owner =
      mapping ??
      ({
        executionId: null,
        workflowRunId: null,
        expiresAt: now + params.ttlMs,
      } as const);
    const id = generateUUID();
    this.db
      .prepare(
        `INSERT INTO tool_continuation_inbox
				   (id, tool_use_id, session_id, execution_id, workflow_run_id, status,
				    request_json, recovery_reason, created_at, updated_at, expires_at)
				 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.toolUseId,
        params.sessionId,
        owner.executionId,
        owner.workflowRunId,
        JSON.stringify(params.requestBody),
        params.reason,
        now,
        now,
        owner.expiresAt
      );
    return { inbox: this.getInbox(id)!, mapping };
  }

  increment409(toolUseId: string, reason: string): ToolContinuationRecord | null {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE tool_continuation_recovery
				 SET attempts_409 = attempts_409 + 1,
				     recovery_reason = ?,
				     updated_at = ?
				 WHERE tool_use_id = ?
				   AND status IN ('active', 'waiting_rebind')
				   AND expires_at >= ?`
      )
      .run(reason, now, toolUseId, now);
    if (result.changes === 0) return null;
    return this.getToolUse(toolUseId);
  }

  failToolUse(toolUseId: string, reason: string): ToolContinuationRecord | null {
    const existing = this.getToolUse(toolUseId);
    if (!existing || !isRecoverableToolUseStatus(existing.status)) {
      return null;
    }
    const updated = this.updateToolUseStatus(toolUseId, 'failed', reason);
    if (updated?.executionId) {
      this.markExecutionBlocked(updated.executionId, reason);
    }
    this.db
      .prepare(
        `UPDATE tool_continuation_inbox
				 SET status = 'failed', recovery_reason = ?, updated_at = ?
				 WHERE tool_use_id = ? AND status = 'pending'`
      )
      .run(reason, Date.now(), toolUseId);
    return updated;
  }

  listPendingInboxForExecution(executionId: string): ContinuationInboxRecord[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM tool_continuation_inbox
				 WHERE execution_id = ? AND status = 'pending' AND expires_at >= ?
				 ORDER BY created_at ASC, id ASC`
      )
      .all(executionId, now) as Record<string, unknown>[];
    return rows.map((row) => this.rowToInbox(row));
  }

  listPendingInboxForSession(sessionId: string): ContinuationInboxRecord[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM tool_continuation_inbox
				 WHERE session_id = ? AND status = 'pending' AND expires_at >= ?
				 ORDER BY created_at ASC, id ASC`
      )
      .all(sessionId, now) as Record<string, unknown>[];
    return rows.map((row) => this.rowToInbox(row));
  }

  hasActiveToolUseForExecution(executionId: string, graceMs = 0): boolean {
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT 1
				 FROM tool_continuation_recovery
				 WHERE execution_id = ?
				   AND status IN ('active', 'waiting_rebind')
				   AND expires_at + ? >= ?
				 LIMIT 1`
      )
      .get(executionId, graceMs, now) as Record<string, unknown> | undefined;
    return !!row;
  }

  markInboxReboundForExecution(executionId: string, reason: string): number {
    const result = this.db
      .prepare(
        `UPDATE tool_continuation_inbox
				 SET status = 'rebound', recovery_reason = ?, updated_at = ?
				 WHERE execution_id = ? AND status = 'pending'`
      )
      .run(reason, Date.now(), executionId);
    this.db
      .prepare(
        `UPDATE tool_continuation_recovery
				 SET status = 'rebound', recovery_reason = ?, updated_at = ?
				 WHERE execution_id = ? AND status = 'waiting_rebind'`
      )
      .run(reason, Date.now(), executionId);
    return result.changes;
  }

  markExpired(now = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE tool_continuation_recovery
				 SET status = 'expired', recovery_reason = COALESCE(recovery_reason, 'TTL expired'),
				     updated_at = ?
				 WHERE status IN ('active', 'waiting_rebind') AND expires_at < ?`
      )
      .run(now, now);
    this.db
      .prepare(
        `UPDATE tool_continuation_inbox
				 SET status = 'expired', recovery_reason = COALESCE(recovery_reason, 'TTL expired'),
				     updated_at = ?
				 WHERE status = 'pending' AND expires_at < ?`
      )
      .run(now, now);
    return result.changes;
  }

  markExecutionWaitingRebind(executionId: string, reason: string): void {
    const now = Date.now();
    const row = this.db.prepare(`SELECT data FROM node_executions WHERE id = ?`).get(executionId) as
      | { data: string | null }
      | undefined;
    const data = parseExecutionData(row?.data);
    data.orphanedToolContinuation = {
      ...(isRecord(data.orphanedToolContinuation) ? data.orphanedToolContinuation : {}),
      state: 'waiting_rebind',
      reason,
      updatedAt: now,
    };
    this.db
      .prepare(
        `UPDATE node_executions
				 SET status = 'waiting_rebind',
				     result = ?,
				     data = ?,
				     completed_at = NULL,
				     updated_at = ?
				 WHERE id = ? AND status IN ('in_progress', 'pending', 'waiting_rebind')`
      )
      .run(reason, JSON.stringify(data), now, executionId);
  }

  private markExecutionBlocked(executionId: string, reason: string): void {
    const now = Date.now();
    const row = this.db.prepare(`SELECT data FROM node_executions WHERE id = ?`).get(executionId) as
      | { data: string | null }
      | undefined;
    const data = parseExecutionData(row?.data);
    data.orphanedToolContinuation = {
      ...(isRecord(data.orphanedToolContinuation) ? data.orphanedToolContinuation : {}),
      state: 'failed',
      reason,
      updatedAt: now,
    };
    this.db
      .prepare(
        `UPDATE node_executions
				 SET status = 'blocked',
				     result = ?,
				     data = ?,
				     agent_session_id = NULL,
				     completed_at = ?,
				     updated_at = ?
				 WHERE id = ? AND status IN ('in_progress', 'pending', 'waiting_rebind', 'blocked')`
      )
      .run(reason, JSON.stringify(data), now, now, executionId);
  }

  private updateToolUseStatus(
    toolUseId: string,
    status: ToolContinuationStatus,
    reason: string
  ): ToolContinuationRecord | null {
    this.db
      .prepare(
        `UPDATE tool_continuation_recovery
				 SET status = ?, recovery_reason = ?, updated_at = ?
				 WHERE tool_use_id = ?`
      )
      .run(status, reason, Date.now(), toolUseId);
    return this.getToolUse(toolUseId);
  }

  private getInbox(id: string): ContinuationInboxRecord | null {
    const row = this.db.prepare(`SELECT * FROM tool_continuation_inbox WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToInbox(row) : null;
  }

  private rowToToolContinuation(row: Record<string, unknown>): ToolContinuationRecord {
    return {
      toolUseId: row.tool_use_id as string,
      sessionId: row.session_id as string,
      executionId: (row.execution_id as string | null) ?? null,
      workflowRunId: (row.workflow_run_id as string | null) ?? null,
      status: row.status as ToolContinuationStatus,
      attempts409: row.attempts_409 as number,
      recoveryReason: (row.recovery_reason as string | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      expiresAt: row.expires_at as number,
    };
  }

  private rowToInbox(row: Record<string, unknown>): ContinuationInboxRecord {
    return {
      id: row.id as string,
      toolUseId: row.tool_use_id as string,
      sessionId: row.session_id as string,
      executionId: (row.execution_id as string | null) ?? null,
      workflowRunId: (row.workflow_run_id as string | null) ?? null,
      status: row.status as ContinuationInboxStatus,
      requestJson: row.request_json as string,
      recoveryReason: (row.recovery_reason as string | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      expiresAt: row.expires_at as number,
    };
  }
}

function parseExecutionData(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isRecoverableToolUseStatus(status: ToolContinuationStatus): boolean {
  return status === 'active' || status === 'waiting_rebind';
}

function canMarkWaitingRebind(status: ToolContinuationStatus): boolean {
  return isRecoverableToolUseStatus(status) || status === 'expired';
}
