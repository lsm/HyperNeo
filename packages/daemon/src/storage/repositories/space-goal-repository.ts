import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';
import type {
  CreateSpaceGoalParams,
  SpaceGoal,
  SpaceGoalListParams,
  SpaceGoalMetrics,
  SpaceGoalStatus,
  UpdateSpaceGoalParams,
} from '@hyperneo/shared';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { SQLiteValue } from '../types.ts';

export class SpaceGoalRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {}

  listAllActive(): SpaceGoal[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_goals WHERE status = 'active' ORDER BY updated_at DESC, id DESC`
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToGoal(r));
  }

  create(params: CreateSpaceGoalParams): SpaceGoal {
    const id = generateUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_goals (
					id, space_id, title, description, status, type, priority, labels, metrics,
					summary, progress, next_steps, preferred_workflow_id, auto_trigger_next,
					pending_next_run, active_task_id, last_task_id, last_check_in_at,
					next_check_in_at, created_at, updated_at, completed_at, revision
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.spaceId,
        params.title,
        params.description ?? '',
        'active',
        params.type ?? 'one_shot',
        params.priority ?? 'normal',
        JSON.stringify(params.labels ?? []),
        JSON.stringify(params.metrics ?? {}),
        params.summary ?? '',
        clampProgress(params.progress ?? 0),
        JSON.stringify(params.nextSteps ?? []),
        params.preferredWorkflowId ?? null,
        params.autoTriggerNext ? 1 : 0,
        0,
        null,
        null,
        null,
        null,
        now,
        now,
        null,
        1
      );
    this.reactiveDb?.notifyChange('space_goals');
    return this.getById(id) as SpaceGoal;
  }

  getById(id: string): SpaceGoal | null {
    const row = this.db.prepare(`SELECT * FROM space_goals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToGoal(row) : null;
  }

  list(params: SpaceGoalListParams): SpaceGoal[] {
    const values: SQLiteValue[] = [params.spaceId];
    let where = `WHERE space_id = ?`;
    if (params.status) {
      where += ` AND status = ?`;
      values.push(params.status);
    } else if (!params.includeArchived) {
      where += ` AND status != 'archived'`;
    }
    const rows = this.db
      .prepare(`SELECT * FROM space_goals ${where} ORDER BY updated_at DESC, id DESC`)
      .all(...values) as Record<string, unknown>[];
    let goals = rows.map((r) => this.rowToGoal(r));
    if (params.label) {
      goals = goals.filter((goal) => goal.labels.includes(params.label as string));
    }
    if (params.search) {
      const q = params.search.toLowerCase();
      goals = goals.filter(
        (goal) => goal.title.toLowerCase().includes(q) || goal.description.toLowerCase().includes(q)
      );
    }
    return goals;
  }

  update(id: string, params: UpdateSpaceGoalParams): SpaceGoal | null {
    const sets: string[] = [];
    const values: SQLiteValue[] = [];
    const add = (column: string, value: SQLiteValue) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (params.title !== undefined) add('title', params.title);
    if (params.description !== undefined) add('description', params.description);
    if (params.status !== undefined) add('status', params.status);
    if (params.type !== undefined) add('type', params.type);
    if (params.priority !== undefined) add('priority', params.priority);
    if (params.labels !== undefined) add('labels', JSON.stringify(params.labels));
    if (params.metrics !== undefined) add('metrics', JSON.stringify(params.metrics));
    if (params.summary !== undefined) add('summary', params.summary);
    if (params.progress !== undefined) add('progress', clampProgress(params.progress));
    if (params.nextSteps !== undefined) add('next_steps', JSON.stringify(params.nextSteps));
    if (params.preferredWorkflowId !== undefined) {
      add('preferred_workflow_id', params.preferredWorkflowId ?? null);
    }
    if (params.autoTriggerNext !== undefined)
      add('auto_trigger_next', params.autoTriggerNext ? 1 : 0);
    if (params.pendingNextRun !== undefined) add('pending_next_run', params.pendingNextRun ? 1 : 0);
    if (params.activeTaskId !== undefined) add('active_task_id', params.activeTaskId ?? null);
    if (params.lastTaskId !== undefined) add('last_task_id', params.lastTaskId ?? null);
    if (params.lastCheckInAt !== undefined) add('last_check_in_at', params.lastCheckInAt ?? null);
    if (params.nextCheckInAt !== undefined) add('next_check_in_at', params.nextCheckInAt ?? null);
    if (params.completedAt !== undefined) add('completed_at', params.completedAt ?? null);

    const existingForStatus =
      params.status !== undefined && params.completedAt === undefined ? this.getById(id) : null;
    if (params.status === 'completed' && params.completedAt === undefined) {
      if (!existingForStatus?.completedAt) add('completed_at', Date.now());
    }
    if (
      params.status &&
      params.status !== 'completed' &&
      params.completedAt === undefined &&
      !(params.status === 'archived' && existingForStatus?.completedAt)
    ) {
      add('completed_at', null);
    }

    if (sets.length === 0) return this.getById(id);
    sets.push(`updated_at = ?`, `revision = revision + 1`);
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE space_goals SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    this.reactiveDb?.notifyChange('space_goals');
    return this.getById(id);
  }

  setTaskScheduleId(id: string, scheduleId: string | null): SpaceGoal | null {
    this.db
      .prepare(
        `UPDATE space_goals SET task_schedule_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
      )
      .run(scheduleId, Date.now(), id);
    this.reactiveDb?.notifyChange('space_goals');
    return this.getById(id);
  }

  claimActiveTask(goalId: string, taskId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE space_goals
				 SET active_task_id = ?, last_task_id = ?, pending_next_run = 0,
				     last_check_in_at = ?, updated_at = ?, revision = revision + 1
				 WHERE id = ? AND status = 'active' AND active_task_id IS NULL`
      )
      .run(taskId, taskId, Date.now(), Date.now(), goalId);
    if (result.changes > 0) this.reactiveDb?.notifyChange('space_goals');
    return result.changes > 0;
  }

  queueNextRun(goalId: string): SpaceGoal | null {
    return this.update(goalId, { pendingNextRun: true });
  }

  clearActiveTaskIfMatches(goalId: string, taskId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE space_goals
				 SET active_task_id = NULL, last_task_id = ?, updated_at = ?, revision = revision + 1
				 WHERE id = ? AND active_task_id = ?`
      )
      .run(taskId, Date.now(), goalId, taskId);
    if (result.changes > 0) this.reactiveDb?.notifyChange('space_goals');
    return result.changes > 0;
  }

  private rowToGoal(row: Record<string, unknown>): SpaceGoal {
    return {
      id: row.id as string,
      spaceId: row.space_id as string,
      title: row.title as string,
      description: (row.description as string) ?? '',
      status: row.status as SpaceGoalStatus,
      type: row.type as SpaceGoal['type'],
      priority: row.priority as SpaceGoal['priority'],
      labels: parseJson<string[]>(row.labels, []),
      metrics: parseJson<SpaceGoalMetrics>(row.metrics, {}),
      summary: (row.summary as string) ?? '',
      progress: (row.progress as number | null) ?? 0,
      nextSteps: parseJson<string[]>(row.next_steps, []),
      preferredWorkflowId: (row.preferred_workflow_id as string | null) ?? null,
      taskScheduleId: (row.task_schedule_id as string | null) ?? null,
      autoTriggerNext: row.auto_trigger_next === 1,
      pendingNextRun: row.pending_next_run === 1,
      activeTaskId: (row.active_task_id as string | null) ?? null,
      lastTaskId: (row.last_task_id as string | null) ?? null,
      lastCheckInAt: (row.last_check_in_at as number | null) ?? null,
      nextCheckInAt: (row.next_check_in_at as number | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      completedAt: (row.completed_at as number | null) ?? null,
      revision: (row.revision as number) ?? 0,
    };
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
