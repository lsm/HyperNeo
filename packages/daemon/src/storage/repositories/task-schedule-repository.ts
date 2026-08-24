import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';
import type {
  TaskSchedule,
  TaskScheduleStatus,
  TaskScheduleTriggerType,
  SpaceTaskPriority,
} from '@hyperneo/shared';

export interface CreateTaskScheduleParams {
  spaceId: string;
  title: string;
  description?: string;
  priority?: SpaceTaskPriority;
  preferredWorkflowId?: string | null;
  labels?: string[];
  metadata?: Record<string, unknown>;
  triggerType: TaskScheduleTriggerType;
  cronExpression?: string | null;
  runAt?: number | null;
  timezone?: string;
  nextRunAt?: number | null;
  createdByAgent?: string | null;
  createdBySession?: string | null;
  goalId?: string | null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface UpdateTaskScheduleParams {
  title?: string;
  description?: string;
  priority?: SpaceTaskPriority;
  preferredWorkflowId?: string | null;
  labels?: string[];
  cronExpression?: string | null;
  runAt?: number | null;
  timezone?: string;
  nextRunAt?: number | null;
}

export class TaskScheduleRepository {
  constructor(private db: BunDatabase) {}

  create(params: CreateTaskScheduleParams): TaskSchedule {
    const id = generateUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO task_schedules (
					id, space_id, title, description, priority, preferred_workflow_id,
					labels, metadata_json, trigger_type, cron_expression, run_at, timezone,
					next_run_at, last_run_at, last_created_task_id, pending_job_id,
					status, created_by_agent, created_by_session, goal_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.spaceId,
        params.title,
        params.description ?? '',
        params.priority ?? 'normal',
        params.preferredWorkflowId ?? null,
        JSON.stringify(params.labels ?? []),
        JSON.stringify(params.metadata ?? {}),
        params.triggerType,
        params.cronExpression ?? null,
        params.runAt ?? null,
        params.timezone ?? 'UTC',
        params.nextRunAt ?? null,
        null,
        null,
        null,
        'active',
        params.createdByAgent ?? null,
        params.createdBySession ?? null,
        params.goalId ?? null,
        now,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): TaskSchedule | null {
    const row = this.db.prepare(`SELECT * FROM task_schedules WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToSchedule(row) : null;
  }

  listBySpace(spaceId: string, status?: TaskScheduleStatus): TaskSchedule[] {
    let query = `SELECT * FROM task_schedules WHERE space_id = ?`;
    const params: (string | number)[] = [spaceId];
    if (status !== undefined) {
      query += ` AND status = ?`;
      params.push(status);
    }
    query += ` ORDER BY created_at DESC`;
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSchedule(r));
  }

  listByGoal(goalId: string, status?: TaskScheduleStatus): TaskSchedule[] {
    let query = `SELECT * FROM task_schedules WHERE goal_id = ?`;
    const params: (string | number)[] = [goalId];
    if (status !== undefined) {
      query += ` AND status = ?`;
      params.push(status);
    }
    query += ` ORDER BY created_at DESC`;
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSchedule(r));
  }

  listActiveDue(now: number, limit = 100): TaskSchedule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_schedules
				 WHERE status = 'active'
				   AND next_run_at IS NOT NULL
				   AND next_run_at <= ?
				   AND pending_job_id IS NULL
				 ORDER BY next_run_at ASC
				 LIMIT ?`
      )
      .all(now, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSchedule(r));
  }

  listActiveWithPendingJob(): TaskSchedule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_schedules
				 WHERE status = 'active' AND pending_job_id IS NOT NULL`
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToSchedule(r));
  }

  listActiveBySpace(spaceId: string): TaskSchedule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_schedules
				 WHERE status = 'active' AND space_id = ?`
      )
      .all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSchedule(r));
  }

  update(id: string, params: UpdateTaskScheduleParams): TaskSchedule | null {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [now];

    if (params.title !== undefined) {
      sets.push('title = ?');
      values.push(params.title);
    }
    if (params.description !== undefined) {
      sets.push('description = ?');
      values.push(params.description);
    }
    if (params.priority !== undefined) {
      sets.push('priority = ?');
      values.push(params.priority);
    }
    if ('preferredWorkflowId' in params) {
      sets.push('preferred_workflow_id = ?');
      values.push(params.preferredWorkflowId ?? null);
    }
    if (params.labels !== undefined) {
      sets.push('labels = ?');
      values.push(JSON.stringify(params.labels));
    }
    if ('cronExpression' in params) {
      sets.push('cron_expression = ?');
      values.push(params.cronExpression ?? null);
    }
    if ('runAt' in params) {
      sets.push('run_at = ?');
      values.push(params.runAt ?? null);
    }
    if (params.timezone !== undefined) {
      sets.push('timezone = ?');
      values.push(params.timezone);
    }
    if ('nextRunAt' in params) {
      sets.push('next_run_at = ?');
      values.push(params.nextRunAt ?? null);
    }

    if (sets.length === 1) return this.getById(id);

    values.push(id);
    this.db.prepare(`UPDATE task_schedules SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  }

  updatePendingJobId(id: string, pendingJobId: string | null): void {
    this.db
      .prepare(`UPDATE task_schedules SET pending_job_id = ?, updated_at = ? WHERE id = ?`)
      .run(pendingJobId, Date.now(), id);
  }

  updateStatus(id: string, status: TaskScheduleStatus): void {
    this.db
      .prepare(`UPDATE task_schedules SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  updateAfterFire(
    id: string,
    opts: {
      lastCreatedTaskId: string;
      lastRunAt: number;
      nextRunAt: number | null;
      status: TaskScheduleStatus;
      pendingJobId: string | null;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE task_schedules
				 SET last_created_task_id = ?, last_run_at = ?, next_run_at = ?,
				     status = ?, pending_job_id = ?, updated_at = ?
				 WHERE id = ?`
      )
      .run(
        opts.lastCreatedTaskId,
        opts.lastRunAt,
        opts.nextRunAt,
        opts.status,
        opts.pendingJobId,
        Date.now(),
        id
      );
  }

  updateAfterFireIfPending(
    id: string,
    expectedPendingJobId: string,
    opts: {
      lastCreatedTaskId: string | null;
      lastRunAt: number;
      nextRunAt: number | null;
      status: TaskScheduleStatus;
      pendingJobId: string | null;
    }
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_schedules
				 SET last_created_task_id = ?, last_run_at = ?, next_run_at = ?,
				     status = ?, pending_job_id = ?, updated_at = ?
				 WHERE id = ? AND pending_job_id = ?`
      )
      .run(
        opts.lastCreatedTaskId,
        opts.lastRunAt,
        opts.nextRunAt,
        opts.status,
        opts.pendingJobId,
        Date.now(),
        id,
        expectedPendingJobId
      );
    return result.changes > 0;
  }

  pauseIfPending(
    id: string,
    expectedStatus: TaskScheduleStatus,
    expectedPendingJobId: string | null
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_schedules
				 SET status = 'paused', pending_job_id = NULL, updated_at = ?
				 WHERE id = ? AND status = ? AND pending_job_id IS ?`
      )
      .run(Date.now(), id, expectedStatus, expectedPendingJobId);
    return result.changes > 0;
  }

  resumeIfPaused(
    id: string,
    opts: {
      nextRunAt: number | null;
      pendingJobId: string | null;
      status: TaskScheduleStatus;
    }
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_schedules
				 SET next_run_at = ?, pending_job_id = ?, status = ?, updated_at = ?
				 WHERE id = ? AND status = 'paused'`
      )
      .run(opts.nextRunAt, opts.pendingJobId, opts.status, Date.now(), id);
    return result.changes > 0;
  }

  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM task_schedules WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  deleteIfPending(id: string, expectedPendingJobId: string | null): boolean {
    const result = this.db
      .prepare(`DELETE FROM task_schedules WHERE id = ? AND pending_job_id IS ?`)
      .run(id, expectedPendingJobId);
    return result.changes > 0;
  }

  private rowToSchedule(row: Record<string, unknown>): TaskSchedule {
    return {
      id: row.id as string,
      spaceId: row.space_id as string,
      title: row.title as string,
      description: (row.description as string) ?? '',
      priority: (row.priority as SpaceTaskPriority) ?? 'normal',
      preferredWorkflowId: (row.preferred_workflow_id as string | null) ?? null,
      labels: parseJson<string[]>(row.labels, []),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      triggerType: row.trigger_type as TaskScheduleTriggerType,
      cronExpression: (row.cron_expression as string | null) ?? null,
      runAt: (row.run_at as number | null) ?? null,
      timezone: (row.timezone as string) ?? 'UTC',
      nextRunAt: (row.next_run_at as number | null) ?? null,
      lastRunAt: (row.last_run_at as number | null) ?? null,
      lastCreatedTaskId: (row.last_created_task_id as string | null) ?? null,
      pendingJobId: (row.pending_job_id as string | null) ?? null,
      status: row.status as TaskScheduleStatus,
      createdByAgent: (row.created_by_agent as string | null) ?? null,
      createdBySession: (row.created_by_session as string | null) ?? null,
      goalId: (row.goal_id as string | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
