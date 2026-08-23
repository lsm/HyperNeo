import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID, isRateOrUsageLimited } from '@hyperneo/shared';
import type {
  SpaceTask,
  SpaceBlockReason,
  SpaceTaskStatus,
  InternalCreateSpaceTaskParams,
  InternalUpdateSpaceTaskParams,
} from '@hyperneo/shared';
import type { TaskRestriction } from '@hyperneo/shared/types/neo';
import type { ReactiveDatabase } from '../reactive-database';
import type { SQLiteValue } from '../types';

export class SpaceTaskRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {}

  private hasMessageSearchIndex(): boolean {
    try {
      const row = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE name = 'message_search_content'`)
        .get();
      return !!row;
    } catch {
      return false;
    }
  }

  private tableExists(tableName: string): boolean {
    try {
      const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(tableName);
      return !!row;
    } catch {
      return false;
    }
  }

  private upsertTaskSearchRow(taskId: string): void {
    if (!this.hasMessageSearchIndex()) return;
    const row = this.db
      .prepare(
        `SELECT id, space_id, task_number, title, description, updated_at
				 FROM space_tasks WHERE id = ?`
      )
      .get(taskId) as
      | {
          id: string;
          space_id: string;
          task_number: number;
          title: string;
          description: string;
          updated_at: number;
        }
      | undefined;
    this.deleteTaskSearchRow(taskId);
    if (!row) return;
    const body = `${row.title} ${row.description}`.trim();
    if (!body) return;
    this.db
      .prepare(
        `INSERT INTO message_search_content (
					kind, source_id, task_id, space_id, task_number, title, body, timestamp
				) VALUES ('task', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.id, row.space_id, row.task_number, row.title, body, row.updated_at);
  }

  private deleteTaskSearchRow(taskId: string): void {
    if (!this.hasMessageSearchIndex()) return;
    this.db
      .prepare(`DELETE FROM message_search_content WHERE kind = 'task' AND source_id = ?`)
      .run(taskId);
  }

  private deleteTaskMessageSearchRows(taskId: string): void {
    if (!this.hasMessageSearchIndex()) return;
    this.db.prepare(`DELETE FROM message_search_content WHERE task_id = ?`).run(taskId);
    if (this.tableExists('message_search_pending')) {
      this.db
        .prepare(
          `DELETE FROM message_search_pending
           WHERE message_id IN (SELECT id FROM sdk_messages WHERE task_id = ?)`
        )
        .run(taskId);
    }
  }

  private deleteTaskMessageRows(taskId: string): void {
    if (!this.hasMessageSearchIndex()) return;
    this.db
      .prepare(`DELETE FROM message_search_content WHERE kind = 'message' AND task_id = ?`)
      .run(taskId);
  }

  private archiveTerminalTaskWorkerSessions(taskId: string): void {
    if (!this.tableExists('sessions')) return;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.id
         FROM sessions s
         LEFT JOIN space_tasks t ON t.id = ?
         WHERE s.status != 'archived'
           AND COALESCE(s.type, 'worker') NOT IN ('room_chat', 'space_chat', 'spaces_global')
           AND (
             s.task_id = ?
             OR s.id = t.task_agent_session_id
             OR s.id LIKE ('space:%:task:' || ? || ':%')
           )`
      )
      .all(taskId, taskId, taskId) as Array<{ id: string }>;
    if (rows.length === 0) return;

    const archivedAt = new Date().toISOString();
    const updateSession = this.db.prepare(
      `UPDATE sessions
       SET status = 'archived',
           archived_at = COALESCE(archived_at, ?)
       WHERE id = ?`
    );
    const deleteSearchRows = this.hasMessageSearchIndex()
      ? this.db.prepare(
          `DELETE FROM message_search_content WHERE kind = 'message' AND session_id = ?`
        )
      : null;
    const tx = this.db.transaction((sessionIds: string[]) => {
      for (const sessionId of sessionIds) {
        updateSession.run(archivedAt, sessionId);
        deleteSearchRows?.run(sessionId);
      }
    });
    tx(rows.map((row) => row.id));
  }

  private deleteExpiredTerminalTaskMessageRows(taskId: string): void {
    if (!this.hasMessageSearchIndex()) return;
    this.db
      .prepare(
        `DELETE FROM message_search_content
				 WHERE kind = 'message'
				   AND task_id = ?
				   AND EXISTS (
					 SELECT 1
					 FROM space_tasks st
					 WHERE st.id = message_search_content.task_id
					   AND st.status IN ('done', 'cancelled', 'completed')
					   AND COALESCE(st.completed_at, st.updated_at, 0) < unixepoch('now', '-30 days') * 1000
				   )`
      )
      .run(taskId);
  }

  createTask(params: InternalCreateSpaceTaskParams): SpaceTask {
    return this.createTaskWithId(generateUUID(), params);
  }

  createTaskWithId(id: string, params: InternalCreateSpaceTaskParams): SpaceTask {
    const now = Date.now();

    const insertTx = this.db.transaction(() => {
      const nextNumber = (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(task_number), 0) + 1 AS next FROM space_tasks WHERE space_id = ?`
          )
          .get(params.spaceId) as { next: number }
      ).next;

      const initialStatus = params.status ?? 'open';
      this.db
        .prepare(
          `INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, labels, workflow_run_id, preferred_workflow_id, created_by_task_id, goal_id, evolution_scope_id, depends_on, task_agent_session_id, created_by, created_by_session, created_by_task_schedule_id, created_at, updated_at, terminal_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          params.spaceId,
          nextNumber,
          params.title,
          params.description ?? '',
          initialStatus,
          params.priority ?? 'normal',
          JSON.stringify(params.labels ?? []),
          params.workflowRunId ?? null,
          params.preferredWorkflowId ?? null,
          params.createdByTaskId ?? null,
          params.goalId ?? null,
          params.evolutionScopeId ?? null,
          JSON.stringify(params.dependsOn ?? []),
          params.taskAgentSessionId ?? null,
          params.createdBy ?? null,
          params.createdBySession ?? null,
          params.createdByTaskScheduleId ?? null,
          now,
          now,
          isTerminalStatus(initialStatus) ? 1 : 0
        );
    });

    insertTx();
    this.upsertTaskSearchRow(id);
    this.reactiveDb?.notifyChange('space_tasks');

    return this.getTask(id)!;
  }

  getTask(id: string): SpaceTask | null {
    const stmt = this.db.prepare(`SELECT * FROM space_tasks WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToSpaceTask(row);
  }

  getTasksByIds(ids: string[]): SpaceTask[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM space_tasks WHERE id IN (${placeholders})`)
      .all(...ids) as Record<string, unknown>[];
    return rows.map((row) => this.rowToSpaceTask(row));
  }

  listBySpace(spaceId: string, includeArchived = false, limit?: number, offset = 0): SpaceTask[] {
    let query = `SELECT * FROM space_tasks WHERE space_id = ?`;
    if (!includeArchived) {
      query += ` AND status != 'archived'`;
    }
    query += ` ORDER BY updated_at DESC, id DESC`;
    if (limit && limit > 0) {
      query += ` LIMIT ? OFFSET ?`;
      const stmt = this.db.prepare(query);
      const rows = stmt.all(spaceId, limit, offset) as Record<string, unknown>[];
      return rows.map((r) => this.rowToSpaceTask(r));
    }
    const stmt = this.db.prepare(query);
    const rows = stmt.all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  listByGoal(
    spaceId: string,
    goalId: string,
    params: {
      status?: SpaceTaskStatus;
      limit?: number;
      before?: number;
      beforeId?: string;
    } = {}
  ): { tasks: SpaceTask[]; total: number; hasMore: boolean } {
    const limit = Math.max(1, Math.min(100, Math.trunc(params.limit ?? 20)));
    const cursorId =
      typeof params.beforeId === 'string' && params.beforeId.length > 0 ? params.beforeId : null;
    const scopeWhere: string[] = [`goal_id = ?`, `space_id = ?`];
    const scopeBind: SQLiteValue[] = [goalId, spaceId];
    if (params.status) {
      scopeWhere.push(`status = ?`);
      scopeBind.push(params.status);
    } else {
      scopeWhere.push(`status != 'archived'`);
    }
    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM space_tasks WHERE ${scopeWhere.join(' AND ')}`)
      .get(...scopeBind) as { count: number } | undefined;
    const total = countRow?.count ?? 0;
    const pageWhere = [...scopeWhere];
    const pageBind = [...scopeBind];
    if (params.before !== undefined) {
      if (cursorId) {
        pageWhere.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
        pageBind.push(params.before, params.before, cursorId);
      } else {
        pageWhere.push(`created_at < ?`);
        pageBind.push(params.before);
      }
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM space_tasks WHERE ${pageWhere.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(...pageBind, limit + 1) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const tasks = rows.slice(0, limit).map((r) => this.rowToSpaceTask(r));
    return { tasks, total, hasMore };
  }

  hasApprovedTaskForWorkflow(workflowId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM space_tasks t
         JOIN space_workflow_runs r ON r.id = t.workflow_run_id
         WHERE r.workflow_id = ? AND t.status = 'approved'
         LIMIT 1`
      )
      .get(workflowId);
    return row !== undefined && row !== null;
  }

  listByWorkflowRun(workflowRunId: string): SpaceTask[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_tasks WHERE workflow_run_id = ? AND status != 'archived' ORDER BY created_at ASC`
    );
    const rows = stmt.all(workflowRunId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  listByWorkflowRunIncludingArchived(workflowRunId: string): SpaceTask[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_tasks WHERE workflow_run_id = ? ORDER BY created_at ASC`
    );
    const rows = stmt.all(workflowRunId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  listByWorkflowRunIdsIncludingArchived(workflowRunIds: string[]): SpaceTask[] {
    if (workflowRunIds.length === 0) return [];
    const placeholders = workflowRunIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM space_tasks WHERE workflow_run_id IN (${placeholders}) ORDER BY created_at ASC`
      )
      .all(...workflowRunIds) as Record<string, unknown>[];
    return rows.map((row) => this.rowToSpaceTask(row));
  }

  listStandaloneBySpace(spaceId: string, includeArchived = false): SpaceTask[] {
    let query = `SELECT * FROM space_tasks WHERE space_id = ? AND workflow_run_id IS NULL`;
    if (!includeArchived) {
      query += ` AND status != 'archived'`;
    }
    query += ` ORDER BY updated_at DESC`;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  listByStatus(spaceId: string, status: SpaceTaskStatus, limit?: number, offset = 0): SpaceTask[] {
    let query = `SELECT * FROM space_tasks WHERE space_id = ? AND status = ? ORDER BY updated_at DESC, id DESC`;
    if (limit && limit > 0) {
      query += ` LIMIT ? OFFSET ?`;
      const stmt = this.db.prepare(query);
      const rows = stmt.all(spaceId, status, limit, offset) as Record<string, unknown>[];
      return rows.map((r) => this.rowToSpaceTask(r));
    }
    const stmt = this.db.prepare(query);
    const rows = stmt.all(spaceId, status) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  listRateLimitedBySpace(spaceId: string): SpaceTask[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_tasks WHERE space_id = ? AND status IN ('rate_limited', 'usage_limited') ORDER BY updated_at DESC, id DESC`
    );
    const rows = stmt.all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  listBySpaceAndStatus(
    spaceId: string,
    status: SpaceTaskStatus,
    blockReason: SpaceBlockReason | null | undefined,
    limit?: number,
    offset = 0,
    blockReasonNotIn?: SpaceBlockReason[]
  ): { tasks: SpaceTask[]; total: number } {
    if (blockReason !== undefined && blockReasonNotIn && blockReasonNotIn.length > 0) {
      throw new Error('blockReason and blockReasonNotIn are mutually exclusive');
    }

    const filterParams: SQLiteValue[] = [spaceId, status];
    let where = `WHERE space_id = ? AND status = ?`;
    if (blockReason !== undefined) {
      if (blockReason === null) {
        where += ` AND block_reason IS NULL`;
      } else {
        where += ` AND block_reason = ?`;
        filterParams.push(blockReason);
      }
    } else if (blockReasonNotIn && blockReasonNotIn.length > 0) {
      const placeholders = blockReasonNotIn.map(() => '?').join(', ');
      where += ` AND (block_reason IS NULL OR block_reason NOT IN (${placeholders}))`;
      for (const reason of blockReasonNotIn) filterParams.push(reason);
    }

    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM space_tasks ${where}`)
      .get(...filterParams) as { total: number } | undefined;
    const total = countRow?.total ?? 0;

    let pageQuery = `SELECT * FROM space_tasks ${where} ORDER BY updated_at DESC, id DESC`;
    const pageParams: SQLiteValue[] = [...filterParams];
    if (limit && limit > 0) {
      pageQuery += ` LIMIT ? OFFSET ?`;
      pageParams.push(limit, offset);
    }

    const rows = this.db.prepare(pageQuery).all(...pageParams) as Record<string, unknown>[];
    return { tasks: rows.map((r) => this.rowToSpaceTask(r)), total };
  }

  countBySpace(spaceId: string, status?: SpaceTaskStatus, includeArchived = false): number {
    let query = `SELECT COUNT(*) as count FROM space_tasks WHERE space_id = ?`;
    const params: SQLiteValue[] = [spaceId];
    if (!includeArchived && status !== 'archived') {
      query += ` AND status != 'archived'`;
    }
    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }
    const stmt = this.db.prepare(query);
    const row = stmt.get(...params) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  updateTask(id: string, params: InternalUpdateSpaceTaskParams): SpaceTask | null {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.title !== undefined) {
      fields.push('title = ?');
      values.push(params.title);
    }
    if (params.description !== undefined) {
      fields.push('description = ?');
      values.push(params.description);
    }
    if (params.status !== undefined) {
      fields.push('status = ?');
      values.push(params.status);

      if (params.status === 'in_progress') {
        fields.push('started_at = ?');
        values.push(Date.now());
        if (params.completedAt === undefined) {
          fields.push('completed_at = ?');
          values.push(null);
        }
      } else if (params.status === 'open') {
        if (params.completedAt === undefined) {
          fields.push('completed_at = ?');
          values.push(null);
        }
      } else if (
        params.status === 'done' ||
        params.status === 'blocked' ||
        params.status === 'cancelled'
      ) {
        fields.push('completed_at = ?');
        values.push(Date.now());
      } else if (params.status === 'archived') {
        fields.push('archived_at = ?');
        values.push(Date.now());
      }
      if (isTerminalStatus(params.status)) {
        fields.push(
          `terminal_generation = terminal_generation + CASE WHEN status = ? THEN 0 ELSE 1 END`
        );
        values.push(params.status);
      }
    }
    if (params.priority !== undefined) {
      fields.push('priority = ?');
      values.push(params.priority);
    }
    if (params.labels !== undefined) {
      fields.push('labels = ?');
      values.push(JSON.stringify(params.labels));
    }
    if (params.workflowRunId !== undefined) {
      fields.push('workflow_run_id = ?');
      values.push(params.workflowRunId ?? null);
    }
    if (params.preferredWorkflowId !== undefined) {
      fields.push('preferred_workflow_id = ?');
      values.push(params.preferredWorkflowId ?? null);
    }
    if (params.goalId !== undefined) {
      fields.push('goal_id = ?');
      values.push(params.goalId ?? null);
    }
    if (params.evolutionScopeId !== undefined) {
      fields.push('evolution_scope_id = ?');
      values.push(params.evolutionScopeId ?? null);
    }
    if (params.workflowModelOverrides !== undefined) {
      fields.push('workflow_model_overrides = ?');
      values.push(
        params.workflowModelOverrides ? JSON.stringify(params.workflowModelOverrides) : null
      );
    }
    if (params.createdByTaskId !== undefined) {
      fields.push('created_by_task_id = ?');
      values.push(params.createdByTaskId ?? null);
    }
    if (params.result !== undefined) {
      fields.push('result = ?');
      values.push(params.result ?? null);
    }
    if (params.dependsOn !== undefined) {
      fields.push('depends_on = ?');
      values.push(JSON.stringify(params.dependsOn));
    }
    if (params.activeSession !== undefined) {
      fields.push('active_session = ?');
      values.push(params.activeSession ?? null);
    }
    if (
      params.activeSession === undefined &&
      (params.status === 'done' ||
        params.status === 'blocked' ||
        params.status === 'cancelled' ||
        params.status === 'archived')
    ) {
      fields.push('active_session = ?');
      values.push(null);
    }
    if (
      params.restrictions === undefined &&
      params.status !== undefined &&
      !isRateOrUsageLimited(params.status)
    ) {
      fields.push('restrictions = ?');
      values.push(null);
    }
    if (params.taskAgentSessionId !== undefined) {
      fields.push('task_agent_session_id = ?');
      values.push(params.taskAgentSessionId ?? null);
    }
    if (params.startedAt !== undefined) {
      fields.push('started_at = ?');
      values.push(params.startedAt ?? null);
    }
    if (params.completedAt !== undefined) {
      fields.push('completed_at = ?');
      values.push(params.completedAt ?? null);
    }
    if (params.archivedAt !== undefined) {
      fields.push('archived_at = ?');
      values.push(params.archivedAt ?? null);
    }
    if (params.blockReason !== undefined) {
      fields.push('block_reason = ?');
      values.push(params.blockReason ?? null);
    }
    if (params.approvalSource !== undefined) {
      fields.push('approval_source = ?');
      values.push(params.approvalSource ?? null);
    }
    if (params.approvalReason !== undefined) {
      fields.push('approval_reason = ?');
      values.push(params.approvalReason ?? null);
    }
    if (params.approvedAt !== undefined) {
      fields.push('approved_at = ?');
      values.push(params.approvedAt ?? null);
    }
    if (params.pendingCheckpointType !== undefined) {
      fields.push('pending_checkpoint_type = ?');
      values.push(params.pendingCheckpointType ?? null);
    }
    if (params.pendingCompletionSubmittedByNodeId !== undefined) {
      fields.push('pending_completion_submitted_by_node_id = ?');
      values.push(params.pendingCompletionSubmittedByNodeId ?? null);
    }
    if (params.pendingCompletionSubmittedAt !== undefined) {
      fields.push('pending_completion_submitted_at = ?');
      values.push(params.pendingCompletionSubmittedAt ?? null);
    }
    if (params.pendingCompletionReason !== undefined) {
      fields.push('pending_completion_reason = ?');
      values.push(params.pendingCompletionReason ?? null);
    }
    if (params.reportedStatus !== undefined) {
      fields.push('reported_status = ?');
      values.push(params.reportedStatus ?? null);
    }
    if (params.reportedSummary !== undefined) {
      fields.push('reported_summary = ?');
      values.push(params.reportedSummary ?? null);
    }
    if (params.postApprovalSessionId !== undefined) {
      fields.push('post_approval_session_id = ?');
      values.push(params.postApprovalSessionId ?? null);
    }
    if (params.postApprovalStartedAt !== undefined) {
      fields.push('post_approval_started_at = ?');
      values.push(params.postApprovalStartedAt ?? null);
    }
    if (params.postApprovalBlockedReason !== undefined) {
      fields.push('post_approval_blocked_reason = ?');
      values.push(params.postApprovalBlockedReason ?? null);
    }
    if (params.postApprovalSourceNodeId !== undefined) {
      fields.push('post_approval_source_node_id = ?');
      values.push(params.postApprovalSourceNodeId ?? null);
    }
    if (params.restrictions !== undefined) {
      fields.push('restrictions = ?');
      values.push(params.restrictions ? JSON.stringify(params.restrictions) : null);
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(Date.now());
      values.push(id);
      const stmt = this.db.prepare(`UPDATE space_tasks SET ${fields.join(', ')} WHERE id = ?`);
      stmt.run(...values);
      this.upsertTaskSearchRow(id);
      if (params.status === 'archived') {
        this.deleteTaskMessageRows(id);
      } else if (params.status !== undefined || params.completedAt !== undefined) {
        this.deleteExpiredTerminalTaskMessageRows(id);
      }
      if (
        params.status === 'done' ||
        params.status === 'cancelled' ||
        params.status === 'archived'
      ) {
        this.archiveTerminalTaskWorkerSessions(id);
      }

      this.reactiveDb?.notifyChange('space_tasks');
    }

    return this.getTask(id);
  }

  casStatus(
    taskId: string,
    expected: SpaceTaskStatus | readonly SpaceTaskStatus[],
    next: SpaceTaskStatus
  ): 'won' | 'superseded' {
    const expectedStatuses = Array.isArray(expected) ? [...expected] : [expected];
    if (expectedStatuses.length === 0) return 'superseded';
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const sets = ['status = ?'];
    const values: SQLiteValue[] = [next];
    if (isTerminalStatus(next)) {
      sets.push(
        `terminal_generation = terminal_generation + CASE WHEN status = ? THEN 0 ELSE 1 END`
      );
      values.push(next);
    }
    const result = this.db
      .prepare(
        `UPDATE space_tasks SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`
      )
      .run(...values, taskId, ...expectedStatuses);
    return result.changes > 0 ? 'won' : 'superseded';
  }

  casStatusWithPayload(
    taskId: string,
    expected: SpaceTaskStatus | readonly SpaceTaskStatus[],
    next: SpaceTaskStatus,
    payload: { restrictions: TaskRestriction | null }
  ): 'won' | 'superseded' {
    const expectedStatuses = Array.isArray(expected) ? [...expected] : [expected];
    if (expectedStatuses.length === 0) return 'superseded';
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const now = Date.now();
    const sets = ['status = ?', 'restrictions = ?', 'updated_at = ?'];
    const values: SQLiteValue[] = [
      next,
      payload.restrictions ? JSON.stringify(payload.restrictions) : null,
      now,
    ];
    if (next === 'in_progress') {
      sets.push('started_at = ?', 'completed_at = ?');
      values.push(now, null);
    }
    if (isTerminalStatus(next)) {
      sets.push(
        `terminal_generation = terminal_generation + CASE WHEN status = ? THEN 0 ELSE 1 END`
      );
      values.push(next);
    }
    const result = this.db
      .prepare(
        `UPDATE space_tasks SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`
      )
      .run(...values, taskId, ...expectedStatuses);
    if (result.changes === 0) return 'superseded';
    this.upsertTaskSearchRow(taskId);
    this.deleteExpiredTerminalTaskMessageRows(taskId);
    this.reactiveDb?.notifyChange('space_tasks');
    return 'won';
  }

  reserveSpawnForTick(
    taskId: string,
    allowedStatuses: readonly SpaceTaskStatus[]
  ): 'won' | 'superseded' {
    if (allowedStatuses.length === 0) return 'superseded';
    const placeholders = allowedStatuses.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE space_tasks
         SET spawn_reservation_token = ?
         WHERE id = ?
           AND status IN (${placeholders})
           AND spawn_reservation_token IS NULL`
      )
      .run(generateUUID(), taskId, ...allowedStatuses);
    return result.changes > 0 ? 'won' : 'superseded';
  }

  releaseSpawnReservation(taskId: string): void {
    this.db
      .prepare(`UPDATE space_tasks SET spawn_reservation_token = NULL WHERE id = ?`)
      .run(taskId);
  }

  clearAllSpawnReservations(): void {
    this.db.prepare(`UPDATE space_tasks SET spawn_reservation_token = NULL`).run();
  }

  archiveTask(id: string): SpaceTask | null {
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE space_tasks SET status = 'archived', archived_at = ?, updated_at = ?,
        terminal_generation = terminal_generation + CASE WHEN status = 'archived' THEN 0 ELSE 1 END
       WHERE id = ?`
    );
    stmt.run(now, now, id);
    this.upsertTaskSearchRow(id);
    this.deleteTaskMessageRows(id);
    this.archiveTerminalTaskWorkerSessions(id);
    this.reactiveDb?.notifyChange('space_tasks');
    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM space_tasks WHERE id = ?`);
    const result = stmt.run(id);
    if (result.changes > 0) {
      this.deleteTaskMessageSearchRows(id);
      this.reactiveDb?.notifyChange('space_tasks');
    }
    return result.changes > 0;
  }

  deleteTasksForSpace(spaceId: string): void {
    const rows = this.db
      .prepare(`SELECT id FROM space_tasks WHERE space_id = ?`)
      .all(spaceId) as Array<{
      id: string;
    }>;
    this.db.prepare(`DELETE FROM space_tasks WHERE space_id = ?`).run(spaceId);
    for (const row of rows) this.deleteTaskMessageSearchRows(row.id);
    this.reactiveDb?.notifyChange('space_tasks');
  }

  promoteDraftTasksByCreator(createdByTaskId: string): number {
    const rows = this.db
      .prepare(`SELECT id FROM space_tasks WHERE created_by_task_id = ? AND status = 'draft'`)
      .all(createdByTaskId) as Array<{ id: string }>;
    const result = this.db
      .prepare(
        `UPDATE space_tasks SET status = 'open', updated_at = ? WHERE created_by_task_id = ? AND status = 'draft'`
      )
      .run(Date.now(), createdByTaskId);
    if (result.changes > 0) {
      for (const row of rows) this.upsertTaskSearchRow(row.id);
      this.reactiveDb?.notifyChange('space_tasks');
    }
    return result.changes;
  }

  listActive(): SpaceTask[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_tasks WHERE status IN ('in_progress', 'review', 'blocked', 'approved')`
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  listActiveWithTaskAgentSession(): SpaceTask[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_tasks WHERE status IN ('in_progress', 'review', 'blocked', 'approved') AND task_agent_session_id IS NOT NULL`
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  getTaskBySessionId(sessionId: string): SpaceTask | null {
    const stmt = this.db.prepare(
      `SELECT * FROM space_tasks WHERE task_agent_session_id = ? LIMIT 1`
    );
    const row = stmt.get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSpaceTask(row);
  }

  getTaskByNumber(spaceId: string, taskNumber: number): SpaceTask | null {
    const row = this.db
      .prepare(`SELECT * FROM space_tasks WHERE space_id = ? AND task_number = ?`)
      .get(spaceId, taskNumber) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSpaceTask(row);
  }

  getDraftTasksByCreator(createdByTaskId: string): SpaceTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_tasks WHERE created_by_task_id = ? AND status = 'open' ORDER BY created_at ASC`
      )
      .all(createdByTaskId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  private rowToSpaceTask(row: Record<string, unknown>): SpaceTask {
    const rawWorkflowModelOverrides = row.workflow_model_overrides as string | null | undefined;
    let workflowModelOverrides: Record<string, string> | undefined;
    if (rawWorkflowModelOverrides) {
      try {
        const parsed = JSON.parse(rawWorkflowModelOverrides) as Record<string, unknown>;
        workflowModelOverrides = Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        );
      } catch {
        workflowModelOverrides = undefined;
      }
    }
    return {
      id: row.id as string,
      spaceId: row.space_id as string,
      taskNumber: (row.task_number as number | null) ?? 0,
      title: row.title as string,
      description: (row.description as string) ?? '',
      status: row.status as SpaceTask['status'],
      priority: row.priority as SpaceTask['priority'],
      labels: JSON.parse((row.labels as string | null) ?? '[]') as string[],
      workflowRunId: (row.workflow_run_id as string | null) ?? undefined,
      preferredWorkflowId: (row.preferred_workflow_id as string | null) ?? undefined,
      createdByTaskId: (row.created_by_task_id as string | null) ?? undefined,
      createdBy: (row.created_by as string | null) ?? undefined,
      createdBySession: (row.created_by_session as string | null) ?? undefined,
      createdByTaskScheduleId: (row.created_by_task_schedule_id as string | null) ?? undefined,
      goalId: (row.goal_id as string | null) ?? undefined,
      evolutionScopeId: (row.evolution_scope_id as string | null) ?? undefined,
      workflowModelOverrides,
      result: (row.result as string | null) ?? null,
      dependsOn: JSON.parse((row.depends_on as string | null) ?? '[]') as string[],
      activeSession: (row.active_session as 'worker' | 'leader' | null) ?? null,
      taskAgentSessionId: (row.task_agent_session_id as string | null) ?? undefined,
      archivedAt: (row.archived_at as number | null) ?? null,
      blockReason: (row.block_reason as SpaceTask['blockReason']) ?? null,
      approvalSource: (row.approval_source as SpaceTask['approvalSource']) ?? null,
      approvalReason: (row.approval_reason as string | null) ?? null,
      approvedAt: (row.approved_at as number | null) ?? null,
      pendingCheckpointType:
        (row.pending_checkpoint_type as SpaceTask['pendingCheckpointType']) ?? null,
      pendingCompletionSubmittedByNodeId:
        (row.pending_completion_submitted_by_node_id as string | null) ?? null,
      pendingCompletionSubmittedAt: (row.pending_completion_submitted_at as number | null) ?? null,
      pendingCompletionReason: (row.pending_completion_reason as string | null) ?? null,
      reportedStatus: (row.reported_status as SpaceTask['reportedStatus']) ?? null,
      reportedSummary: (row.reported_summary as string | null) ?? null,
      postApprovalSessionId: (row.post_approval_session_id as string | null) ?? null,
      postApprovalStartedAt: (row.post_approval_started_at as number | null) ?? null,
      postApprovalBlockedReason: (row.post_approval_blocked_reason as string | null) ?? null,
      postApprovalSourceNodeId: (row.post_approval_source_node_id as string | null) ?? null,
      restrictions: parseRestrictions(row.restrictions),
      createdAt: row.created_at as number,
      startedAt: (row.started_at as number | null) ?? null,
      completedAt: (row.completed_at as number | null) ?? null,
      updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
      terminalGeneration: (row.terminal_generation as number) ?? 0,
    };
  }
}

function isTerminalStatus(status: SpaceTaskStatus): boolean {
  return (
    status === 'done' || status === 'blocked' || status === 'cancelled' || status === 'archived'
  );
}

function parseRestrictions(raw: unknown): TaskRestriction | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as TaskRestriction;
    if (
      parsed &&
      (parsed.type === 'rate_limit' || parsed.type === 'usage_limit') &&
      typeof parsed.resetAt === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
