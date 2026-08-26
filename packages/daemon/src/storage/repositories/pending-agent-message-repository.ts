import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';
import type { ReactiveDatabase } from '../reactive-database.ts';

export type PendingMessageTargetKind = 'node_agent' | 'space_agent';
export type PendingMessageStatus = 'pending' | 'delivered' | 'expired' | 'failed';

export const DEFAULT_PENDING_MESSAGE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_PENDING_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PENDING_MESSAGE_MAX_PER_TARGET = 50;
export const DEFAULT_PENDING_MESSAGE_MAX_ATTEMPTS = 5;

export interface PendingAgentMessageRecord {
  id: string;
  workflowRunId: string;
  spaceId: string;
  taskId: string | null;
  sourceAgentName: string;
  targetKind: PendingMessageTargetKind;
  targetAgentName: string;
  message: string;
  workflowNodeId: string | null;
  idempotencyKey: string | null;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  status: PendingMessageStatus;
  deliveredAt: number | null;
  deliveredSessionId: string | null;
  expiresAt: number;
  createdAt: number;
  deliveryMode: 'immediate' | 'defer' | null;
}

export interface EnqueuePendingMessageInput {
  workflowRunId: string;
  spaceId: string;
  taskId?: string | null;
  sourceAgentName?: string;
  targetKind: PendingMessageTargetKind;
  targetAgentName: string;
  message: string;
  workflowNodeId?: string | null;
  idempotencyKey?: string | null;
  ttlMs?: number;
  expiresAt?: number;
  maxAttempts?: number;
  deliveryMode?: 'immediate' | 'defer';
}

export interface EnqueueResult {
  record: PendingAgentMessageRecord;
  deduped: boolean;
}

export interface PendingMessageRetentionOptions {
  runId?: string | null;
  now?: number;
  retentionMs?: number;
  maxPerTarget?: number;
  includeExpiresAt?: boolean;
  excludeIds?: string[];
}

export class PendingAgentMessageRepository {
  constructor(
    private db: BunDatabase,
    private readonly reactiveDb?: ReactiveDatabase
  ) {}

  private notify(): void {
    this.reactiveDb?.notifyChange('pending_agent_messages');
  }

  enqueue(input: EnqueuePendingMessageInput): EnqueueResult {
    const idempotencyKey = input.idempotencyKey ?? null;

    if (idempotencyKey !== null) {
      const existing = this.findByIdempotencyKey(
        input.workflowRunId,
        input.targetAgentName,
        idempotencyKey
      );
      if (existing) {
        return { record: existing, deduped: true };
      }
    }

    const now = Date.now();
    const expiresAt = input.expiresAt ?? now + (input.ttlMs ?? DEFAULT_PENDING_MESSAGE_TTL_MS);
    const id = generateUUID();
    const sourceAgentName = input.sourceAgentName ?? 'task-agent';
    const maxAttempts = input.maxAttempts ?? DEFAULT_PENDING_MESSAGE_MAX_ATTEMPTS;
    const deliveryMode = input.deliveryMode ?? null;

    this.db
      .prepare(
        `INSERT INTO pending_agent_messages (
					id, workflow_run_id, space_id, task_id,
					source_agent_name, target_kind, target_agent_name,
					message, workflow_node_id, idempotency_key,
					attempts, max_attempts,
					last_attempt_at, last_error,
					status, delivered_at, delivered_session_id,
					expires_at, created_at, delivery_mode
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, 'pending', NULL, NULL, ?, ?, ?)`
      )
      .run(
        id,
        input.workflowRunId,
        input.spaceId,
        input.taskId ?? null,
        sourceAgentName,
        input.targetKind,
        input.targetAgentName,
        input.message,
        input.workflowNodeId ?? null,
        idempotencyKey,
        maxAttempts,
        expiresAt,
        now,
        deliveryMode
      );
    this.notify();

    const record = this.getById(id);
    if (!record) {
      throw new Error(`PendingAgentMessageRepository: failed to read back row ${id}`);
    }
    return { record, deduped: false };
  }

  getById(id: string): PendingAgentMessageRecord | null {
    const row = this.db
      .prepare('SELECT * FROM pending_agent_messages WHERE id = ?')
      .get(id) as PendingMessageRow | null;
    return row ? rowToRecord(row) : null;
  }

  findByIdempotencyKey(
    workflowRunId: string,
    targetAgentName: string,
    idempotencyKey: string
  ): PendingAgentMessageRecord | null {
    if (!idempotencyKey) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM pending_agent_messages
				 WHERE workflow_run_id = ? AND target_agent_name = ? AND idempotency_key = ? AND status = 'pending'
				 ORDER BY created_at ASC, rowid ASC
				 LIMIT 1`
      )
      .get(workflowRunId, targetAgentName, idempotencyKey) as PendingMessageRow | null;
    return row ? rowToRecord(row) : null;
  }

  listPendingForTarget(
    workflowRunId: string,
    targetAgentName: string,
    workflowNodeId?: string | null
  ): PendingAgentMessageRecord[] {
    const rows =
      workflowNodeId === undefined || workflowNodeId === null
        ? (this.db
            .prepare(
              `SELECT * FROM pending_agent_messages
					 WHERE workflow_run_id = ? AND target_agent_name = ? AND status = 'pending'
					 ORDER BY created_at ASC, rowid ASC`
            )
            .all(workflowRunId, targetAgentName) as PendingMessageRow[])
        : (this.db
            .prepare(
              `SELECT * FROM pending_agent_messages
					 WHERE workflow_run_id = ? AND target_agent_name = ? AND status = 'pending'
					   AND (workflow_node_id = ? OR workflow_node_id IS NULL)
					 ORDER BY created_at ASC, rowid ASC`
            )
            .all(workflowRunId, targetAgentName, workflowNodeId) as PendingMessageRow[]);
    return rows.map(rowToRecord);
  }

  listPendingForRun(workflowRunId: string): PendingAgentMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_agent_messages
				 WHERE workflow_run_id = ? AND status = 'pending'
				 ORDER BY created_at ASC, rowid ASC`
      )
      .all(workflowRunId) as PendingMessageRow[];
    return rows.map(rowToRecord);
  }

  listByRunAndStatus(
    workflowRunId: string,
    status: PendingMessageStatus
  ): PendingAgentMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_agent_messages
				 WHERE workflow_run_id = ? AND status = ?
				 ORDER BY created_at ASC, rowid ASC`
      )
      .all(workflowRunId, status) as PendingMessageRow[];
    return rows.map(rowToRecord);
  }

  listPendingForSpace(spaceId: string): PendingAgentMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_agent_messages
				 WHERE space_id = ? AND status = 'pending'
				 ORDER BY created_at ASC, rowid ASC`
      )
      .all(spaceId) as PendingMessageRow[];
    return rows.map(rowToRecord);
  }

  listAllPending(): PendingAgentMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_agent_messages
				 WHERE status = 'pending'
				 ORDER BY created_at ASC, rowid ASC`
      )
      .all() as PendingMessageRow[];
    return rows.map(rowToRecord);
  }

  markDelivered(id: string, sessionId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE pending_agent_messages
				 SET status = 'delivered',
				     delivered_at = ?,
				     delivered_session_id = ?,
				     last_attempt_at = ?,
				     last_error = NULL
				 WHERE id = ? AND status = 'pending'`
      )
      .run(now, sessionId, now, id);
    this.notify();
  }

  markLateDeadLetter(id: string, sentinel: string): PendingAgentMessageRecord | null {
    const now = Date.now();
    const updated = this.db
      .prepare(
        `UPDATE pending_agent_messages
				 SET attempts = attempts + 1,
				     last_attempt_at = ?,
				     last_error = ?,
				     status = CASE
				       WHEN attempts + 1 >= max_attempts THEN 'failed'
				       ELSE status
				     END
				 WHERE id = ? AND status = 'pending'
				   AND (last_error IS NULL OR last_error <> ?)`
      )
      .run(now, sentinel, id, sentinel);
    if (updated.changes > 0) this.notify();
    return this.getById(id);
  }

  clearLateDeadLetter(id: string): void {
    this.db
      .prepare(
        `UPDATE pending_agent_messages
				 SET last_error = NULL
				 WHERE id = ? AND last_error IS NOT NULL`
      )
      .run(id);
    this.notify();
  }

  deferExpiration(ids: string[], ttlMs = DEFAULT_PENDING_MESSAGE_TTL_MS): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(
        `UPDATE pending_agent_messages
				 SET expires_at = ?
				 WHERE id IN (${placeholders}) AND status = 'pending'`
      )
      .run(Date.now() + ttlMs, ...ids);
    this.notify();
  }

  rescopeTarget(id: string, targetAgentName: string, workflowNodeId: string): void {
    const tx = this.db.transaction(() => {
      const row = this.getById(id);
      if (!row || row.status !== 'pending') return;
      if (row.idempotencyKey != null) {
        const conflict = this.db
          .prepare(
            `SELECT 1 FROM pending_agent_messages
					 WHERE workflow_run_id = ? AND target_agent_name = ? AND idempotency_key = ?
					   AND status = 'pending' AND id != ? LIMIT 1`
          )
          .get(row.workflowRunId, targetAgentName, row.idempotencyKey, id);
        if (conflict) {
          this.db.prepare(`DELETE FROM pending_agent_messages WHERE id = ?`).run(id);
          return;
        }
      }
      this.db
        .prepare(
          `UPDATE pending_agent_messages
				 SET target_agent_name = ?,
				     workflow_node_id = ?
				 WHERE id = ? AND status = 'pending'`
        )
        .run(targetAgentName, workflowNodeId, id);
    });
    tx();
    this.notify();
  }

  markAttemptFailed(id: string, error: string): PendingAgentMessageRecord | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE pending_agent_messages
				 SET attempts = attempts + 1,
				     last_attempt_at = ?,
				     last_error = ?,
				     status = CASE
				       WHEN attempts + 1 >= max_attempts THEN 'failed'
				       ELSE status
				     END
				 WHERE id = ? AND status = 'pending'`
      )
      .run(now, error, id);
    this.notify();
    return this.getById(id);
  }

  markFailed(id: string, error: string): PendingAgentMessageRecord | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE pending_agent_messages
				 SET status = 'failed',
				     last_attempt_at = ?,
				     last_error = ?
				 WHERE id = ? AND status = 'pending'`
      )
      .run(now, error, id);
    this.notify();
    return this.getById(id);
  }

  expireStale(runId: string | null = null, excludeIds: string[] = []): number {
    const now = Date.now();
    const excludePredicate =
      excludeIds.length > 0 ? ` AND id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';
    const stmt =
      runId === null
        ? this.db.prepare(
            `UPDATE pending_agent_messages
						 SET status = 'expired'
						 WHERE status = 'pending' AND expires_at <= ?${excludePredicate}`
          )
        : this.db.prepare(
            `UPDATE pending_agent_messages
						 SET status = 'expired'
						 WHERE status = 'pending' AND expires_at <= ?${excludePredicate}
						   AND workflow_run_id = ?`
          );
    const result =
      runId === null ? stmt.run(now, ...excludeIds) : stmt.run(now, ...excludeIds, runId);
    if (result.changes > 0) this.notify();
    return result.changes;
  }

  enforceRetention(options: PendingMessageRetentionOptions = {}): number {
    const runId = options.runId ?? null;
    const now = options.now ?? Date.now();
    const retentionMs = options.retentionMs ?? DEFAULT_PENDING_MESSAGE_RETENTION_MS;
    const maxPerTarget = options.maxPerTarget ?? DEFAULT_PENDING_MESSAGE_MAX_PER_TARGET;
    const includeExpiresAt = options.includeExpiresAt ?? true;
    const excludeIds = options.excludeIds ?? [];
    const excludePredicate =
      excludeIds.length > 0 ? ` AND id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';

    let changes = 0;
    const expireBefore = now - retentionMs;
    const ttlPredicate = includeExpiresAt
      ? '(created_at <= ? OR expires_at <= ?)'
      : 'created_at <= ?';
    const ttlStmt =
      runId === null
        ? this.db.prepare(
            `UPDATE pending_agent_messages
							 SET status = 'expired'
							 WHERE status = 'pending' AND ${ttlPredicate}${excludePredicate}`
          )
        : this.db.prepare(
            `UPDATE pending_agent_messages
							 SET status = 'expired'
							 WHERE status = 'pending'
							   AND ${ttlPredicate}${excludePredicate}
							   AND workflow_run_id = ?`
          );
    const ttlParams = includeExpiresAt ? [expireBefore, now] : [expireBefore];
    changes += (
      runId === null
        ? ttlStmt.run(...ttlParams, ...excludeIds)
        : ttlStmt.run(...ttlParams, ...excludeIds, runId)
    ).changes;

    if (maxPerTarget < 1) {
      const capStmt =
        runId === null
          ? this.db.prepare(
              `UPDATE pending_agent_messages
								 SET status = 'expired'
								 WHERE status = 'pending'${excludePredicate}`
            )
          : this.db.prepare(
              `UPDATE pending_agent_messages
								 SET status = 'expired'
								 WHERE status = 'pending'${excludePredicate} AND workflow_run_id = ?`
            );
      changes += (runId === null ? capStmt.run(...excludeIds) : capStmt.run(...excludeIds, runId))
        .changes;
    }

    const capStmt =
      runId === null
        ? this.db.prepare(
            `UPDATE pending_agent_messages
							 SET status = 'expired'
							 WHERE rowid IN (
							   SELECT rowid FROM (
							     SELECT rowid,
							            ROW_NUMBER() OVER (
							              PARTITION BY workflow_run_id, target_agent_name, workflow_node_id
							              ORDER BY created_at DESC, rowid DESC
							            ) AS queue_rank
							     FROM pending_agent_messages
							     WHERE status = 'pending'${excludePredicate}
							   )
							   WHERE queue_rank > ?
							 )`
          )
        : this.db.prepare(
            `UPDATE pending_agent_messages
							 SET status = 'expired'
							 WHERE rowid IN (
							   SELECT rowid FROM (
							     SELECT rowid,
							            ROW_NUMBER() OVER (
							              PARTITION BY workflow_run_id, target_agent_name, workflow_node_id
							              ORDER BY created_at DESC, rowid DESC
							            ) AS queue_rank
							     FROM pending_agent_messages
							     WHERE status = 'pending'${excludePredicate} AND workflow_run_id = ?
							   )
							   WHERE queue_rank > ?
							 )`
          );
    changes += (
      runId === null
        ? capStmt.run(...excludeIds, maxPerTarget)
        : capStmt.run(...excludeIds, runId, maxPerTarget)
    ).changes;
    if (changes > 0) this.notify();
    return changes;
  }

  clearTerminalForRun(workflowRunId: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM pending_agent_messages
				 WHERE workflow_run_id = ? AND status IN ('expired', 'failed', 'delivered')`
      )
      .run(workflowRunId);
    if (result.changes > 0) this.notify();
    return result.changes;
  }

  deleteByRun(workflowRunId: string): number {
    const result = this.db
      .prepare('DELETE FROM pending_agent_messages WHERE workflow_run_id = ?')
      .run(workflowRunId);
    if (result.changes > 0) this.notify();
    return result.changes;
  }

  listAllForRun(workflowRunId: string): PendingAgentMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_agent_messages
				 WHERE workflow_run_id = ?
				 ORDER BY created_at ASC, rowid ASC`
      )
      .all(workflowRunId) as PendingMessageRow[];
    return rows.map(rowToRecord);
  }
}

interface PendingMessageRow {
  id: string;
  workflow_run_id: string;
  space_id: string;
  task_id: string | null;
  source_agent_name: string;
  target_kind: PendingMessageTargetKind;
  target_agent_name: string;
  message: string;
  workflow_node_id: string | null;
  idempotency_key: string | null;
  attempts: number;
  max_attempts: number;
  last_attempt_at: number | null;
  last_error: string | null;
  status: PendingMessageStatus;
  delivered_at: number | null;
  delivered_session_id: string | null;
  expires_at: number;
  created_at: number;
  delivery_mode: 'immediate' | 'defer' | null;
}

function rowToRecord(row: PendingMessageRow): PendingAgentMessageRecord {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    spaceId: row.space_id,
    taskId: row.task_id,
    sourceAgentName: row.source_agent_name,
    targetKind: row.target_kind,
    targetAgentName: row.target_agent_name,
    message: row.message,
    workflowNodeId: row.workflow_node_id ?? null,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastAttemptAt: row.last_attempt_at,
    lastError: row.last_error,
    status: row.status,
    deliveredAt: row.delivered_at,
    deliveredSessionId: row.delivered_session_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    deliveryMode: row.delivery_mode ?? null,
  };
}
