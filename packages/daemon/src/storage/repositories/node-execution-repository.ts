/**
 * NodeExecutionRepository
 *
 * Repository for NodeExecution CRUD operations.
 *
 * Records the execution of a single agent slot within a workflow run's node.
 * One row is created per (workflowRunId, workflowNodeId, agentName) triple.
 * This separates workflow-internal state from the user-facing SpaceTask.
 *
 * Table: node_executions
 *   - FK to space_workflow_runs ON DELETE CASCADE
 *   - FK to space_agents ON DELETE SET NULL
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import type {
  NodeExecution,
  NodeExecutionStatus,
  CreateNodeExecutionParams,
  UpdateNodeExecutionParams,
} from '@hyperneo/shared';
import type { SQLiteValue } from '../types';
import type { ReactiveDatabase } from '../reactive-database';

export class NodeExecutionRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {}

  /**
   * Notify the LiveQuery layer that node_executions changed. No-op when no
   * reactive db is wired (e.g. tests). Called by every write path so
   * `nodeExecutions.byRun` subscribers — including the lastActivityAt liveness
   * signal — re-evaluate on activity/state writes, not just on full refetch.
   */
  private notify(): void {
    this.reactiveDb?.notifyChange('node_executions');
  }

  /**
   * Create a new node execution record.
   * Throws on constraint violations (e.g., duplicate UNIQUE key).
   */
  create(params: CreateNodeExecutionParams): NodeExecution {
    const id = generateUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO node_executions
				    (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				     agent_session_id, status, result, data, created_at, started_at,
				     completed_at, updated_at, last_activity_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.workflowRunId,
        params.workflowNodeId,
        params.agentName,
        params.agentId ?? null,
        params.agentSessionId ?? null,
        params.status ?? 'pending',
        null,
        null,
        now,
        null,
        null,
        now,
        null
      );

    this.notify();
    return this.getById(id)!;
  }

  /**
   * Create a node execution record, ignoring if a duplicate already exists.
   *
   * Uses INSERT OR IGNORE to handle concurrent activateNode() calls gracefully.
   * If a record with the same (workflow_run_id, workflow_node_id, agent_name)
   * already exists (UNIQUE constraint), the insert is silently skipped and
   * the existing record is returned.
   *
   * @returns The newly created record, or the existing record if a duplicate was found.
   */
  createOrIgnore(params: CreateNodeExecutionParams): NodeExecution {
    const id = generateUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT OR IGNORE INTO node_executions
					    (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
					     agent_session_id, status, result, data, created_at, started_at,
					     completed_at, updated_at, last_activity_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.workflowRunId,
        params.workflowNodeId,
        params.agentName,
        params.agentId ?? null,
        params.agentSessionId ?? null,
        params.status ?? 'pending',
        null,
        null,
        now,
        null,
        null,
        now,
        null
      );

    this.notify();
    // If the insert was ignored (duplicate), return the existing record.
    const inserted = this.getById(id);
    if (inserted) {
      return inserted;
    }

    // Duplicate — find the existing record by unique key.
    const existing = this.db
      .prepare(
        `SELECT * FROM node_executions
				        WHERE workflow_run_id = ? AND workflow_node_id = ? AND agent_name = ?
				        ORDER BY created_at ASC LIMIT 1`
      )
      .get(params.workflowRunId, params.workflowNodeId, params.agentName) as
      | Record<string, unknown>
      | undefined;

    if (existing) {
      return this.rowToNodeExecution(existing);
    }
    const fallback = this.getById(id);
    if (fallback) return fallback;
    throw new Error(
      `node_execution record not found after INSERT OR IGNORE for (${params.workflowRunId}, ${params.workflowNodeId}, ${params.agentName})`
    );
  }

  /**
   * Get a node execution by ID
   */
  getById(id: string): NodeExecution | null {
    const row = this.db.prepare(`SELECT * FROM node_executions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;
    return this.rowToNodeExecution(row);
  }

  /**
   * List all node executions for a workflow run
   */
  listByWorkflowRun(workflowRunId: string): NodeExecution[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM node_executions WHERE workflow_run_id = ? ORDER BY created_at ASC, id ASC`
      )
      .all(workflowRunId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNodeExecution(r));
  }

  /**
   * List node executions for a specific node within a workflow run
   */
  listByNode(workflowRunId: string, workflowNodeId: string): NodeExecution[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM node_executions
				        WHERE workflow_run_id = ? AND workflow_node_id = ?
				        ORDER BY created_at ASC, id ASC`
      )
      .all(workflowRunId, workflowNodeId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNodeExecution(r));
  }

  /**
   * Update a node execution with partial updates
   */
  update(id: string, params: UpdateNodeExecutionParams): NodeExecution | null {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.status !== undefined) {
      fields.push('status = ?');
      values.push(params.status);

      // Auto-stamp timestamps only when the caller does NOT provide
      // an explicit value — avoids duplicate SET entries in the SQL.
      if (params.status === 'in_progress' && params.startedAt === undefined) {
        fields.push('started_at = ?');
        values.push(Date.now());
      } else if (
        (params.status === 'idle' ||
          params.status === 'blocked' ||
          params.status === 'cancelled') &&
        params.completedAt === undefined
      ) {
        fields.push('completed_at = ?');
        values.push(Date.now());
      }
    }
    if (params.agentSessionId !== undefined) {
      fields.push('agent_session_id = ?');
      values.push(params.agentSessionId ?? null);
    }
    if (params.result !== undefined) {
      fields.push('result = ?');
      values.push(params.result ?? null);
    }
    if (params.data !== undefined) {
      fields.push('data = ?');
      values.push(params.data !== null ? JSON.stringify(params.data) : null);
    }
    if (params.startedAt !== undefined) {
      fields.push('started_at = ?');
      values.push(params.startedAt ?? null);
    }
    if (params.completedAt !== undefined) {
      fields.push('completed_at = ?');
      values.push(params.completedAt ?? null);
    }
    if (params.lastActivityAt !== undefined) {
      fields.push('last_activity_at = ?');
      values.push(params.lastActivityAt ?? null);
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(Date.now());
      values.push(id);
      this.db
        .prepare(`UPDATE node_executions SET ${fields.join(', ')} WHERE id = ?`)
        .run(...values);
      this.notify();
    }

    return this.getById(id);
  }

  /**
   * Update only the status of a node execution, with automatic timestamp stamping.
   */
  updateStatus(id: string, status: NodeExecutionStatus): NodeExecution | null {
    return this.update(id, { status });
  }

  /**
   * Reset an in-flight execution to the clean-recovery shape:
   * `{status: 'pending', result: null, agentSessionId: null}`.
   *
   * The blank session binding is the point — processRunTick scans pending
   * executions WITH an agentSessionId and would route a stale binding through
   * the crash-retry path (incrementing taskCrashCounts). A blank binding makes
   * the pending row a clean non-crash recovery that the spawn path re-drives
   * from scratch.
   *
   * Used by the clean-recovery resets: `recoverRateLimitedTasks` (passed rate
   * cap), `SpaceRuntime.parkInFlightExecutionsForSpace` (space stop), and the
   * transient spawn-abort catch in `TaskAgentManager` (space stopped
   * mid-spawn). Note: the alive-stuck restart uses a different shape (it
   * keeps a result message and nulls startedAt), so it stays on `update`.
   */
  resetForCleanRecovery(id: string): NodeExecution | null {
    return this.update(id, {
      status: 'pending',
      result: null,
      agentSessionId: null,
    });
  }

  /**
   * Update the agent session ID for a node execution.
   * Used when an agent sub-session is created or cleared.
   */
  updateSessionId(id: string, agentSessionId: string | null): NodeExecution | null {
    return this.update(id, { agentSessionId });
  }

  /**
   * Record observed agent activity by advancing `last_activity_at` ONLY.
   *
   * This is the high-frequency path used by the agent-activity signal sources
   * (SDK tool-call/tool-result, peer-message delivery, PR commit push). It
   * deliberately does NOT touch `updated_at`, which retains its "last runtime
   * state-write" semantic — the two columns measure different things and must
   * not be coupled. Silent no-op for an unknown id (activity for a torn-down or
   * not-yet-created row is dropped rather than thrown).
   */
  touchLastActivity(id: string, at: number = Date.now()): void {
    this.db.prepare(`UPDATE node_executions SET last_activity_at = ? WHERE id = ?`).run(at, id);
    this.notify();
  }

  /**
   * Delete a node execution by ID
   */
  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM node_executions WHERE id = ?`).run(id);
    if (result.changes > 0) this.notify();
    return result.changes > 0;
  }

  /**
   * Find a node execution by its agent session ID.
   * Returns the most relevant active/latest match or null if none exists.
   *
   * A long-lived named agent session can be reused across multiple workflow
   * node executions. Prefer active executions so runtime MCP self-heal rebuilds
   * node-agent with the current node context rather than an older completed row.
   */
  getByAgentSessionId(agentSessionId: string): NodeExecution | null {
    return this.listByAgentSessionId(agentSessionId)[0] ?? null;
  }

  /**
   * List node executions bound to an agent session, with active/latest rows first.
   */
  listByAgentSessionId(agentSessionId: string): NodeExecution[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM node_executions
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
				   created_at DESC,
				   id DESC`
      )
      .all(agentSessionId) as Record<string, unknown>[];

    return rows.map((row) => this.rowToNodeExecution(row));
  }

  /**
   * Delete all node executions for a workflow run
   */
  deleteByWorkflowRun(workflowRunId: string): void {
    this.db.prepare(`DELETE FROM node_executions WHERE workflow_run_id = ?`).run(workflowRunId);
    this.notify();
  }

  /**
   * Convert a database row to a NodeExecution object
   */
  private rowToNodeExecution(row: Record<string, unknown>): NodeExecution {
    const rawData = row.data as string | null | undefined;
    let parsedData: Record<string, unknown> | null = null;
    if (rawData) {
      try {
        parsedData = JSON.parse(rawData) as Record<string, unknown>;
      } catch {
        parsedData = null;
      }
    }
    return {
      id: row.id as string,
      workflowRunId: row.workflow_run_id as string,
      workflowNodeId: row.workflow_node_id as string,
      agentName: row.agent_name as string,
      agentId: (row.agent_id as string | null) ?? null,
      agentSessionId: (row.agent_session_id as string | null) ?? null,
      status: row.status as NodeExecutionStatus,
      result: (row.result as string | null) ?? null,
      data: parsedData,
      createdAt: row.created_at as number,
      startedAt: (row.started_at as number | null) ?? null,
      completedAt: (row.completed_at as number | null) ?? null,
      updatedAt: row.updated_at as number,
      lastActivityAt: (row.last_activity_at as number | null) ?? null,
    };
  }
}
