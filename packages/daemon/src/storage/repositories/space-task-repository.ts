/**
 * Space Task Repository
 *
 * Repository for SpaceTask CRUD operations.
 */

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

  /**
   * Remove both the task-kind row and any message-kind projection rows linked
   * to this task. Hard-deleting a task FK-cascades its `sdk_messages` rows, so
   * the message search projection must be cleaned up to avoid orphaned hits.
   */
  private deleteTaskMessageSearchRows(taskId: string): void {
    if (!this.hasMessageSearchIndex()) return;
    this.db.prepare(`DELETE FROM message_search_content WHERE task_id = ?`).run(taskId);
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
             (json_valid(s.session_context) AND json_extract(s.session_context, '$.taskId') = ?)
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

  /**
   * Create a new space task
   */
  createTask(params: InternalCreateSpaceTaskParams): SpaceTask {
    return this.createTaskWithId(generateUUID(), params);
  }

  createTaskWithId(id: string, params: InternalCreateSpaceTaskParams): SpaceTask {
    const now = Date.now();

    // Wrap SELECT MAX + INSERT in an explicit transaction to prevent concurrent
    // requests from computing the same task_number. SQLite serialises write
    // transactions, so the UNIQUE index is the safety net, but the transaction
    // ensures correctness without relying on constraint errors.
    const insertTx = this.db.transaction(() => {
      const nextNumber = (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(task_number), 0) + 1 AS next FROM space_tasks WHERE space_id = ?`
          )
          .get(params.spaceId) as { next: number }
      ).next;

      this.db
        .prepare(
          `INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, labels, workflow_run_id, preferred_workflow_id, created_by_task_id, goal_id, evolution_scope_id, depends_on, task_agent_session_id, created_by, created_by_session, created_by_task_schedule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          params.spaceId,
          nextNumber,
          params.title,
          params.description ?? '',
          params.status ?? 'open',
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
          now
        );
    });

    insertTx();
    this.upsertTaskSearchRow(id);
    this.reactiveDb?.notifyChange('space_tasks');

    return this.getTask(id)!;
  }

  /**
   * Get a task by ID
   */
  getTask(id: string): SpaceTask | null {
    const stmt = this.db.prepare(`SELECT * FROM space_tasks WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToSpaceTask(row);
  }

  /**
   * Batch-fetch tasks by id in a single round-trip. Missing ids are omitted
   * (callers should not assume a 1:1 correspondence with the input). Used to
   * collapse N+1 lookups in EvolutionScopeService.buildPreflightContext.
   */
  getTasksByIds(ids: string[]): SpaceTask[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM space_tasks WHERE id IN (${placeholders})`)
      .all(...ids) as Record<string, unknown>[];
    return rows.map((row) => this.rowToSpaceTask(row));
  }

  /**
   * List tasks for a space, with optional status filter and pagination.
   * When limit is not provided (or 0), returns all matching tasks (unbounded).
   */
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

  /**
   * List tasks for a workflow run
   */
  listByWorkflowRun(workflowRunId: string): SpaceTask[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_tasks WHERE workflow_run_id = ? AND status != 'archived' ORDER BY created_at ASC`
    );
    const rows = stmt.all(workflowRunId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  /**
   * List tasks for a workflow run, INCLUDING archived tasks.
   *
   * Archive is the authoritative tombstone for a task: once archived, no
   * further inter-agent messages or node activations are permitted for the
   * run. Callers that enforce that tombstone (e.g. `ChannelRouter`) must be
   * able to see the archived task to throw the correct error — they cannot
   * rely on `listByWorkflowRun()`, which filters archived tasks out.
   */
  listByWorkflowRunIncludingArchived(workflowRunId: string): SpaceTask[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_tasks WHERE workflow_run_id = ? ORDER BY created_at ASC`
    );
    const rows = stmt.all(workflowRunId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  /**
   * Batch equivalent of listByWorkflowRunIncludingArchived across many runs in
   * one round-trip. Tasks are ordered by created_at ASC globally, so grouping
   * by workflow_run_id preserves each run's within-run ordering. Missing run
   * ids simply contribute no rows.
   */
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

  /**
   * List standalone tasks for a space (tasks with no workflowRunId).
   * The SQL-level filter avoids fetching workflow tasks that would be discarded by the caller.
   */
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

  /**
   * List tasks by status within a space, with optional pagination.
   * When limit is not provided (or 0), returns all matching tasks (unbounded).
   */
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

  /**
   * List tasks paused on a rate/usage limit (`rate_limited` / `usage_limited`)
   * within a space. Used by the runtime tick loop to auto-resume tasks whose
   * reset time has passed — including across daemon restarts (the resume is
   * driven off the persisted `restrictions.resetAt`, not an in-memory timer).
   */
  listRateLimitedBySpace(spaceId: string): SpaceTask[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_tasks WHERE space_id = ? AND status IN ('rate_limited', 'usage_limited') ORDER BY updated_at DESC, id DESC`
    );
    const rows = stmt.all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  /**
   * List tasks by status within a space, optionally filtered by block reason,
   * paginated, returning both the page of tasks and the total count.
   *
   * Used by the UI Tasks view to render a single status group (e.g.
   * "In Progress") with Prev/Next pagination buttons. The total is computed
   * with a separate `COUNT(*)` so the caller can render "Showing X–Y of Z" and
   * disable Next when the offset reaches the end of the page list.
   *
   * @param spaceId         Space scope.
   * @param status          Status to filter on (required — pagination is per-group).
   * @param blockReason     Optional block_reason filter — used by the Action tab to
   *                        match the "Needs Input" / "Gate Pending" buckets.
   *                        Tri-state: `undefined` ignores the column, `null`
   *                        matches rows with no reason set, a value matches
   *                        exactly. Mutually exclusive with `blockReasonNotIn`.
   * @param blockReasonNotIn Optional negative block_reason filter — used by the
   *                        Action tab's generic "Blocked" bucket to include
   *                        every blocked row whose reason is NOT one of the
   *                        attention-required values, mirroring the original
   *                        client-side filter.
   * @param limit           Page size (defaults to all matching when 0/undefined).
   * @param offset          Page offset.
   */
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
        // Explicit null filter: no block reason. Used to render the generic
        // "Blocked" bucket distinctly from the attention-required ones.
        where += ` AND block_reason IS NULL`;
      } else {
        where += ` AND block_reason = ?`;
        filterParams.push(blockReason);
      }
    } else if (blockReasonNotIn && blockReasonNotIn.length > 0) {
      // IS NULL union with NOT IN — without it SQLite would discard rows
      // where block_reason is NULL because `NULL NOT IN (...)` yields NULL,
      // and we want unset-reason blocked rows to land in the generic bucket.
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

  /**
   * Count tasks for a space, optionally filtered by status.
   * Excludes archived by default, unless status is explicitly 'archived'.
   */
  countBySpace(spaceId: string, status?: SpaceTaskStatus, includeArchived = false): number {
    let query = `SELECT COUNT(*) as count FROM space_tasks WHERE space_id = ?`;
    const params: SQLiteValue[] = [spaceId];
    // When the caller explicitly filters by 'archived', include archived rows
    // even if includeArchived is false — the status filter is the intent.
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

  /**
   * Update a task with partial updates
   */
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
        // Always stamp started_at on entry to in_progress, including re-entries from
        // blocked or cancelled. This records when the most recent work began,
        // not when the task was originally created.
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
    // Auto-clear active_session when task reaches a terminal status
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
    // Auto-clear a stale rate/usage-limit restriction when the task leaves the
    // paused statuses via any path that doesn't set `restrictions` explicitly
    // (e.g. a manual setTaskStatus to in_progress/cancelled/done). The runtime
    // resume path sets restrictions:null itself; this is the backstop so a
    // paused task can't keep a stale resume-at blob after manual intervention.
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
    // Post-approval columns (PR 1/5 of the post-approval refactor — no
    // runtime consumer yet; PR 2 wires them up).
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
      // `expectedStatuses` makes the status guard part of the UPDATE itself:
      // `UPDATE … WHERE id = ? AND status IN (…)` is a single atomic SQL
      // statement, so a concurrent writer that changes the status between the
      // caller's read and this write causes a 0-row update instead of a lost
      // update. (Codex P1: an in-JS check followed by a plain `WHERE id = ?`
      // always leaves an interleaving window.)
      let statusGuard = '';
      if (params.expectedStatuses !== undefined) {
        // Fail closed on an empty list: "no status is acceptable" must mean
        // the update matches nothing — building `IN ()` instead would be a
        // SQL syntax error, and skipping the guard would be fail-open.
        if (params.expectedStatuses.length === 0) {
          return null;
        }
        const placeholders = params.expectedStatuses.map(() => '?').join(', ');
        statusGuard = ` AND status IN (${placeholders})`;
        values.push(...params.expectedStatuses);
      }
      const stmt = this.db.prepare(
        `UPDATE space_tasks SET ${fields.join(', ')} WHERE id = ?${statusGuard}`
      );
      const result = stmt.run(...values);
      if (params.expectedStatuses !== undefined && result.changes === 0) {
        // The row's status no longer matches — the caller raced a concurrent
        // transition. Return null so the manager surfaces a clear error.
        return null;
      }
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

  /**
   * Archive a task by setting status to 'archived' and archived_at timestamp.
   * status = 'archived' is the canonical source of truth; archived_at is a derived timestamp.
   */
  archiveTask(id: string): SpaceTask | null {
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE space_tasks SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`
    );
    stmt.run(now, now, id);
    this.upsertTaskSearchRow(id);
    this.deleteTaskMessageRows(id);
    this.archiveTerminalTaskWorkerSessions(id);
    this.reactiveDb?.notifyChange('space_tasks');
    return this.getTask(id);
  }

  /**
   * Delete a task by ID
   */
  deleteTask(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM space_tasks WHERE id = ?`);
    const result = stmt.run(id);
    if (result.changes > 0) {
      this.deleteTaskMessageSearchRows(id);
      this.reactiveDb?.notifyChange('space_tasks');
    }
    return result.changes > 0;
  }

  /**
   * Delete all tasks for a space
   */
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

  /**
   * Promote draft tasks created by a planning task (legacy method, kept for API compatibility)
   */
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

  /**
   * List all tasks that have an active Task Agent session.
   *
   * Returns tasks with status `in_progress`, `review`, `blocked`, or `approved`
   * that have a non-null `task_agent_session_id`. Used by
   * `TaskAgentManager.rehydrate()` on daemon restart to find Task Agent
   * sessions that need to be restarted.
   *
   * Status inclusions:
   * - `'in_progress'` — actively being worked on; obvious rehydrate target.
   * - `'review'` — workflow agents finished but a human/auto reviewer must
   *   approve. The Task Agent session is still live: it owns the sub-session
   *   map (coder/reviewer/etc.) and is the only path that can re-attach the
   *   in-process `node-agent` / `space-agent-tools` MCP servers to those
   *   sub-sessions after a daemon restart. Excluding `'review'` here was the
   *   root cause of task #126: a coder/reviewer sub-session waiting for review
   *   while the parent task waited in `'review'` lost both MCP servers across
   *   a daemon restart, so `send_message` silently failed with
   *   "No such tool available".
   * - `'blocked'` — task awaits human input but the Task Agent session must
   *   stay live so unblocking messages reach it.
   * - `'approved'` — the Task Agent can still be live while the post-approval
   *   sub-session runs; `mark_complete` may transition the task back to
   *   `in_progress` or to `done`, and the UI's `spaceTaskActivity.byTask`
   *   LiveQuery depends on the session being rehydrated in-memory.
   *
   * Tasks in `'done'`/`'cancelled'`/`'archived'`/`'open'` are excluded:
   * terminal states have their sessions torn down, and `'open'` tasks have
   * no Task Agent yet.
   */
  /** List all tasks with non-terminal statuses (in_progress, review, blocked, approved). */
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

  /**
   * Get a task by its Task Agent session ID
   */
  getTaskBySessionId(sessionId: string): SpaceTask | null {
    const stmt = this.db.prepare(
      `SELECT * FROM space_tasks WHERE task_agent_session_id = ? LIMIT 1`
    );
    const row = stmt.get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSpaceTask(row);
  }

  /**
   * Get a task by its space-scoped numeric ID
   */
  getTaskByNumber(spaceId: string, taskNumber: number): SpaceTask | null {
    const row = this.db
      .prepare(`SELECT * FROM space_tasks WHERE space_id = ? AND task_number = ?`)
      .get(spaceId, taskNumber) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSpaceTask(row);
  }

  /**
   * Get open tasks created by a specific planning task
   */
  getDraftTasksByCreator(createdByTaskId: string): SpaceTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_tasks WHERE created_by_task_id = ? AND status = 'open' ORDER BY created_at ASC`
      )
      .all(createdByTaskId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpaceTask(r));
  }

  /**
   * Convert a database row to a SpaceTask object
   */
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
      // Post-approval columns (PR 1/5 — schema only).
      postApprovalSessionId: (row.post_approval_session_id as string | null) ?? null,
      postApprovalStartedAt: (row.post_approval_started_at as number | null) ?? null,
      postApprovalBlockedReason: (row.post_approval_blocked_reason as string | null) ?? null,
      postApprovalSourceNodeId: (row.post_approval_source_node_id as string | null) ?? null,
      restrictions: parseRestrictions(row.restrictions),
      createdAt: row.created_at as number,
      startedAt: (row.started_at as number | null) ?? null,
      completedAt: (row.completed_at as number | null) ?? null,
      updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
    };
  }
}

/**
 * Parse a `restrictions` JSON blob into a `TaskRestriction`, or null when the
 * task is not paused. Defensive against malformed/missing JSON.
 */
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
