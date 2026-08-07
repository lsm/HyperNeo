/**
 * Pending Agent Message Repository
 *
 * Persistent FIFO queue for Task Agent → peer agent (node agent or Space Agent)
 * messages that could not be delivered immediately because the target session
 * was not yet active. Rows are drained on target activation, during rehydration
 * after daemon restart, and by a periodic sweep.
 *
 * Design goals:
 *   - Ordered delivery per `(workflow_run_id, target_agent_name)` via `created_at`
 *   - Idempotency: pending `(workflow_run_id, target_agent_name, idempotency_key)`
 *     rows are de-duped; terminal historical rows do not suppress later resends
 *   - Bounded retries: each failed delivery increments `attempts` and records
 *     `last_error`; once `attempts >= max_attempts`, the row is moved to
 *     `status = 'failed'` and no longer drained
 *   - TTL: `expires_at` is checked on drain; expired rows move to `status = 'expired'`
 *   - Observability: callers emit `space.pendingMessage.queued` /
 *     `space.pendingMessage.delivered` events — the repo itself is silent
 *
 * Lifecycle statuses:
 *   pending   — queued, awaiting delivery
 *   delivered — delivered once; drained from future sweeps
 *   expired   — never delivered within TTL; kept as a historical record
 *   failed    — exceeded `max_attempts`; kept as a historical record
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import type { ReactiveDatabase } from '../reactive-database';

export type PendingMessageTargetKind = 'node_agent' | 'space_agent';
export type PendingMessageStatus = 'pending' | 'delivered' | 'expired' | 'failed';

/** Default TTL for a queued message when the caller doesn't pass `expiresAt`. */
export const DEFAULT_PENDING_MESSAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** Default retention window before pending rows are considered too stale to deliver. */
export const DEFAULT_PENDING_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Default maximum pending rows kept per `(workflow_run_id, target_agent_name)`. */
export const DEFAULT_PENDING_MESSAGE_MAX_PER_TARGET = 50;
/** Default retry cap for delivery attempts. */
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
}

export interface EnqueuePendingMessageInput {
  workflowRunId: string;
  spaceId: string;
  /** Main task ID the Task Agent is orchestrating (optional — null for Space Agent escalations not tied to a specific task). */
  taskId?: string | null;
  /** Source agent slot name (defaults to `'task-agent'`). */
  sourceAgentName?: string;
  targetKind: PendingMessageTargetKind;
  targetAgentName: string;
  message: string;
  /**
   * Persisted workflow node ID the message was sent to. Scopes the queue drain
   * so two unstarted nodes reusing an agent slot name don't cross-receive.
   * Null for callers that don't know the node (e.g. agent→agent routing).
   */
  workflowNodeId?: string | null;
  /** Optional idempotency key. If set and a row already exists with the same `(workflowRunId, targetAgentName, idempotencyKey)`, the existing row is returned. */
  idempotencyKey?: string | null;
  /** Optional TTL in ms from now; defaults to DEFAULT_PENDING_MESSAGE_TTL_MS. */
  ttlMs?: number;
  /** Optional absolute expiry in ms — takes precedence over ttlMs. */
  expiresAt?: number;
  /** Optional max attempts cap (defaults to DEFAULT_PENDING_MESSAGE_MAX_ATTEMPTS). */
  maxAttempts?: number;
}

export interface EnqueueResult {
  record: PendingAgentMessageRecord;
  /** True when this was a pre-existing row matched by idempotency key; false when a new row was inserted. */
  deduped: boolean;
}

export interface PendingMessageRetentionOptions {
  runId?: string | null;
  now?: number;
  retentionMs?: number;
  maxPerTarget?: number;
  includeExpiresAt?: boolean;
}

export class PendingAgentMessageRepository {
  constructor(
    private db: BunDatabase,
    private readonly reactiveDb?: ReactiveDatabase
  ) {}

  /**
   * Notify LiveQuery consumers that pending_agent_messages changed. This
   * repository writes via raw SQL (bypassing the reactive proxy), so without
   * these notifications task timelines (which surface queued human messages)
   * go stale until an unrelated watched-table write.
   */
  private notify(): void {
    this.reactiveDb?.notifyChange('pending_agent_messages');
  }

  /**
   * Insert a new pending message, or return the existing pending row if the
   * `(workflowRunId, targetAgentName, idempotencyKey)` tuple already exists
   * (when `idempotencyKey` is set). Delivered/failed/expired rows are historical
   * and do not suppress legitimate later resends with the same message text.
   */
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

    this.db
      .prepare(
        `INSERT INTO pending_agent_messages (
					id, workflow_run_id, space_id, task_id,
					source_agent_name, target_kind, target_agent_name,
					message, workflow_node_id, idempotency_key,
					attempts, max_attempts,
					last_attempt_at, last_error,
					status, delivered_at, delivered_session_id,
					expires_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, 'pending', NULL, NULL, ?, ?)`
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
        now
      );
    this.notify();

    const record = this.getById(id);
    if (!record) {
      throw new Error(`PendingAgentMessageRepository: failed to read back row ${id}`);
    }
    return { record, deduped: false };
  }

  /** Fetch a single row by primary key. */
  getById(id: string): PendingAgentMessageRecord | null {
    const row = this.db
      .prepare('SELECT * FROM pending_agent_messages WHERE id = ?')
      .get(id) as PendingMessageRow | null;
    return row ? rowToRecord(row) : null;
  }

  /** Find a pending row by its idempotency tuple. Returns null if none matches or if `idempotencyKey` is empty. */
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

  /**
   * List pending (still-deliverable) rows for a specific target in a run, oldest first.
   * Expired rows are NOT filtered here — callers use `expireStale()` first (or check
   * `expiresAt` before delivery) to move expired rows to `status = 'expired'`.
   */
  listPendingForTarget(
    workflowRunId: string,
    targetAgentName: string,
    workflowNodeId?: string | null
  ): PendingAgentMessageRecord[] {
    // When a node ID is given, scope to that node so two unstarted nodes
    // reusing an agent slot name don't drain each other's queued messages.
    // Rows without a node ID (older callers / agent→agent) are returned for
    // every node only when no node filter is supplied.
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

  /** List all pending rows for a run, oldest first. Used by periodic sweepers. */
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

  /** List rows for a run by status, oldest first. Used by repair/escalation paths. */
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

  /** List pending rows for a space, oldest first. Used by space-scoped actor registry lookups. */
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

  /** List all pending rows across every run, oldest first. Used by the global sweeper. */
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

  /**
   * Mark a row as successfully delivered.
   * Records the session ID the message was delivered to and stamps `delivered_at`.
   */
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

  /**
   * Record a failed delivery attempt.
   * Increments `attempts`; if the new count reaches `max_attempts`, the row
   * status is set to `'failed'` so it is no longer drained.
   */
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

  /** Mark a pending row as failed without consuming additional retry ticks. */
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

  /**
   * Sweep expired rows in a run — any pending row with `expires_at <= now`
   * is moved to `status = 'expired'`. Returns the number of rows updated.
   * Pass `runId = null` to sweep across all runs.
   */
  expireStale(runId: string | null = null): number {
    const now = Date.now();
    const stmt =
      runId === null
        ? this.db.prepare(
            `UPDATE pending_agent_messages
						 SET status = 'expired'
						 WHERE status = 'pending' AND expires_at <= ?`
          )
        : this.db.prepare(
            `UPDATE pending_agent_messages
						 SET status = 'expired'
						 WHERE status = 'pending' AND expires_at <= ? AND workflow_run_id = ?`
          );
    const result = runId === null ? stmt.run(now) : stmt.run(now, runId);
    if (result.changes > 0) this.notify();
    return result.changes;
  }

  /**
   * Enforce queue retention so pending rows cannot grow without bound.
   * Rows older than `retentionMs` or beyond `maxPerTarget` for their
   * `(workflow_run_id, target_agent_name)` queue are moved to `expired`.
   */
  enforceRetention(options: PendingMessageRetentionOptions = {}): number {
    const runId = options.runId ?? null;
    const now = options.now ?? Date.now();
    const retentionMs = options.retentionMs ?? DEFAULT_PENDING_MESSAGE_RETENTION_MS;
    const maxPerTarget = options.maxPerTarget ?? DEFAULT_PENDING_MESSAGE_MAX_PER_TARGET;
    const includeExpiresAt = options.includeExpiresAt ?? true;

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
							 WHERE status = 'pending' AND ${ttlPredicate}`
          )
        : this.db.prepare(
            `UPDATE pending_agent_messages
							 SET status = 'expired'
							 WHERE status = 'pending'
							   AND ${ttlPredicate}
							   AND workflow_run_id = ?`
          );
    const ttlParams = includeExpiresAt ? [expireBefore, now] : [expireBefore];
    changes += (runId === null ? ttlStmt.run(...ttlParams) : ttlStmt.run(...ttlParams, runId))
      .changes;

    if (maxPerTarget < 1) {
      const capStmt =
        runId === null
          ? this.db.prepare(
              `UPDATE pending_agent_messages
								 SET status = 'expired'
								 WHERE status = 'pending'`
            )
          : this.db.prepare(
              `UPDATE pending_agent_messages
								 SET status = 'expired'
								 WHERE status = 'pending' AND workflow_run_id = ?`
            );
      changes += (runId === null ? capStmt.run() : capStmt.run(runId)).changes;
      return changes;
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
							              PARTITION BY workflow_run_id, target_agent_name
							              ORDER BY created_at DESC, rowid DESC
							            ) AS queue_rank
							     FROM pending_agent_messages
							     WHERE status = 'pending'
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
							              PARTITION BY workflow_run_id, target_agent_name
							              ORDER BY created_at DESC, rowid DESC
							            ) AS queue_rank
							     FROM pending_agent_messages
							     WHERE status = 'pending' AND workflow_run_id = ?
							   )
							   WHERE queue_rank > ?
							 )`
          );
    changes += (runId === null ? capStmt.run(maxPerTarget) : capStmt.run(runId, maxPerTarget))
      .changes;
    if (changes > 0) this.notify();
    return changes;
  }

  /**
   * Delete all terminal (expired, failed, delivered) rows for a run.
   * Pending rows are preserved so in-flight delivery can proceed.
   *
   * Used by task recovery to clear stale expired/failed handoffs that would
   * otherwise re-block the run on the next tick.
   */
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

  /**
   * Delete all rows for a run regardless of status. Used when a workflow run is
   * deleted (FK also cascades, but this gives callers an explicit path).
   */
  deleteByRun(workflowRunId: string): number {
    const result = this.db
      .prepare('DELETE FROM pending_agent_messages WHERE workflow_run_id = ?')
      .run(workflowRunId);
    if (result.changes > 0) this.notify();
    return result.changes;
  }

  /** Test helper / diagnostics: list all rows for a run regardless of status. */
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

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

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
  };
}
