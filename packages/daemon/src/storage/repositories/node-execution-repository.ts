import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';
import type {
  NodeExecution,
  NodeExecutionStatus,
  CreateNodeExecutionParams,
  UpdateNodeExecutionParams,
} from '@hyperneo/shared';
import type { SQLiteValue } from '../types.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';

export class NodeExecutionRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {}

  private notify(): void {
    this.reactiveDb?.notifyChange('node_executions');
  }

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
    const inserted = this.getById(id);
    if (inserted) {
      return inserted;
    }

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

  getById(id: string): NodeExecution | null {
    const row = this.db.prepare(`SELECT * FROM node_executions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;
    return this.rowToNodeExecution(row);
  }

  listByWorkflowRun(workflowRunId: string): NodeExecution[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM node_executions WHERE workflow_run_id = ? ORDER BY created_at ASC, id ASC`
      )
      .all(workflowRunId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNodeExecution(r));
  }

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

  update(id: string, params: UpdateNodeExecutionParams): NodeExecution | null {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.status !== undefined) {
      fields.push('status = ?');
      values.push(params.status);

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

  updateStatus(id: string, status: NodeExecutionStatus): NodeExecution | null {
    return this.update(id, { status });
  }

  casExecutionStatus(
    id: string,
    expected: NodeExecutionStatus | readonly NodeExecutionStatus[],
    next: NodeExecutionStatus,
    payload: {
      agentSessionId?: string | null;
      startedAt?: number | null;
      completedAt?: number | null;
    } = {},
    guards: { expectAgentSessionId?: string | null } = {}
  ): 'won' | 'superseded' {
    const expectedStatuses = Array.isArray(expected) ? [...expected] : [expected];
    if (expectedStatuses.length === 0) return 'superseded';
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const sets = ['status = ?', 'updated_at = ?'];
    const values: SQLiteValue[] = [next, Date.now()];
    if (payload.agentSessionId !== undefined) {
      sets.push('agent_session_id = ?');
      values.push(payload.agentSessionId);
    }
    if (payload.startedAt !== undefined) {
      sets.push('started_at = ?');
      values.push(payload.startedAt);
    }
    if (payload.completedAt !== undefined) {
      sets.push('completed_at = ?');
      values.push(payload.completedAt);
    }
    let predicate = `id = ? AND status IN (${placeholders})`;
    if (guards.expectAgentSessionId !== undefined) {
      predicate += ' AND agent_session_id IS ?';
    }
    const result = this.db
      .prepare(`UPDATE node_executions SET ${sets.join(', ')} WHERE ${predicate}`)
      .run(
        ...values,
        id,
        ...expectedStatuses,
        ...(guards.expectAgentSessionId !== undefined ? [guards.expectAgentSessionId] : [])
      );
    if (result.changes === 0) return 'superseded';
    this.notify();
    return 'won';
  }

  updateSessionId(id: string, agentSessionId: string | null): NodeExecution | null {
    return this.update(id, { agentSessionId });
  }

  touchLastActivity(id: string, at: number = Date.now()): void {
    this.db.prepare(`UPDATE node_executions SET last_activity_at = ? WHERE id = ?`).run(at, id);
    this.notify();
  }

  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM node_executions WHERE id = ?`).run(id);
    if (result.changes > 0) this.notify();
    return result.changes > 0;
  }

  getByAgentSessionId(agentSessionId: string): NodeExecution | null {
    return this.listByAgentSessionId(agentSessionId)[0] ?? null;
  }

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

  deleteByWorkflowRun(workflowRunId: string): void {
    this.db.prepare(`DELETE FROM node_executions WHERE workflow_run_id = ?`).run(workflowRunId);
    this.notify();
  }

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
