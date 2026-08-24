import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID, parseJson, parseJsonOptional } from '@hyperneo/shared';
import type {
  RoomGoal,
  GoalStatus,
  GoalPriority,
  MissionType,
  AutonomyLevel,
  MissionMetric,
  CronSchedule,
  MetricHistoryEntry,
  MissionExecution,
  MissionExecutionStatus,
} from '@hyperneo/shared/types/neo';
import type { SQLiteValue } from '../types.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { ShortIdAllocator } from '../../lib/short-id-allocator.ts';

export interface CreateGoalParams {
  roomId: string;
  title: string;
  description?: string;
  priority?: GoalPriority;
  missionType?: MissionType;
  autonomyLevel?: AutonomyLevel;
  structuredMetrics?: MissionMetric[];
  schedule?: CronSchedule;
  schedulePaused?: boolean;
  nextRunAt?: number;
  maxConsecutiveFailures?: number;
  maxPlanningAttempts?: number;
  consecutiveFailures?: number;
  replanCount?: number;
}

export interface UpdateGoalParams {
  title?: string;
  description?: string;
  status?: GoalStatus;
  priority?: GoalPriority;
  progress?: number;
  linkedTaskIds?: string[];
  metrics?: Record<string, number>;
  planning_attempts?: number;
  missionType?: MissionType;
  autonomyLevel?: AutonomyLevel;
  structuredMetrics?: MissionMetric[] | null;
  schedule?: CronSchedule | null;
  schedulePaused?: boolean;
  nextRunAt?: number | null;
  maxConsecutiveFailures?: number;
  maxPlanningAttempts?: number;
  consecutiveFailures?: number;
  replanCount?: number;
}

export interface CreateExecutionParams {
  goalId: string;
  executionNumber: number;
  startedAt?: number;
  taskIds?: string[];
}

export interface UpdateExecutionParams {
  status?: MissionExecutionStatus;
  completedAt?: number;
  resultSummary?: string;
  taskIds?: string[];
  planningAttempts?: number;
}

export class GoalRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb: ReactiveDatabase,
    private shortIdAllocator?: ShortIdAllocator
  ) {}

  createGoal(params: CreateGoalParams): RoomGoal {
    const id = generateUUID();
    const now = Date.now();
    const shortId = this.shortIdAllocator?.allocate('goal', params.roomId) ?? null;

    const stmt = this.db.prepare(
      `INSERT INTO goals (
				id, room_id, title, description, status, priority, progress, linked_task_ids,
				metrics, created_at, updated_at,
				mission_type, autonomy_level, schedule, schedule_paused, next_run_at,
				structured_metrics, max_consecutive_failures, max_planning_attempts, consecutive_failures,
				replan_count, short_id
			)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      id,
      params.roomId,
      params.title,
      params.description ?? '',
      'active',
      params.priority ?? 'normal',
      0,
      '[]',
      '{}',
      now,
      now,
      params.missionType ?? 'one_shot',
      params.autonomyLevel ?? 'supervised',
      params.schedule ? JSON.stringify(params.schedule) : null,
      params.schedulePaused ? 1 : 0,
      params.nextRunAt ?? null,
      params.structuredMetrics ? JSON.stringify(params.structuredMetrics) : null,
      params.maxConsecutiveFailures ?? 3,
      params.maxPlanningAttempts ?? 0,
      params.consecutiveFailures ?? 0,
      params.replanCount ?? 0,
      shortId
    );

    this.reactiveDb.notifyChange('goals');
    return this.getGoalDirect(id)!;
  }

  private getGoalDirect(id: string): RoomGoal | null {
    const stmt = this.db.prepare(`SELECT * FROM goals WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToGoal(row);
  }

  getGoal(id: string): RoomGoal | null {
    const goal = this.getGoalDirect(id);
    if (!goal) return null;
    if (!goal.shortId && this.shortIdAllocator) {
      const shortId = this.shortIdAllocator.allocate('goal', goal.roomId);
      this.db.prepare(`UPDATE goals SET short_id = ? WHERE id = ?`).run(shortId, id);
      return { ...goal, shortId };
    }
    return goal;
  }

  getGoalByShortId(roomId: string, shortId: string): RoomGoal | null {
    const stmt = this.db.prepare(`SELECT * FROM goals WHERE room_id = ? AND short_id = ?`);
    const row = stmt.get(roomId, shortId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToGoal(row);
  }

  listGoals(roomId?: string | null, status?: GoalStatus): RoomGoal[] {
    let query = `SELECT * FROM goals`;
    const params: SQLiteValue[] = [];
    let hasWhere = false;

    if (roomId) {
      query += ` WHERE room_id = ?`;
      params.push(roomId);
      hasWhere = true;
    }

    if (status) {
      query += hasWhere ? ` AND status = ?` : ` WHERE status = ?`;
      params.push(status);
      hasWhere = true;
    }

    query += ` ORDER BY priority DESC, created_at ASC`;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => {
      const goal = this.rowToGoal(row);
      if (!goal.shortId && this.shortIdAllocator) {
        const shortId = this.shortIdAllocator.allocate('goal', goal.roomId);
        this.db.prepare(`UPDATE goals SET short_id = ? WHERE id = ?`).run(shortId, goal.id);
        return { ...goal, shortId };
      }
      return goal;
    });
  }

  updateGoal(id: string, params: UpdateGoalParams): RoomGoal | null {
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

      if (params.status === 'completed') {
        fields.push('completed_at = ?');
        values.push(Date.now());
      }
    }
    if (params.priority !== undefined) {
      fields.push('priority = ?');
      values.push(params.priority);
    }
    if (params.progress !== undefined) {
      fields.push('progress = ?');
      values.push(params.progress);
    }
    if (params.linkedTaskIds !== undefined) {
      fields.push('linked_task_ids = ?');
      values.push(JSON.stringify(params.linkedTaskIds));
    }
    if (params.metrics !== undefined) {
      fields.push('metrics = ?');
      values.push(JSON.stringify(params.metrics));
    }
    if (params.planning_attempts !== undefined) {
      fields.push('planning_attempts = ?');
      values.push(params.planning_attempts);
    }
    if (params.missionType !== undefined) {
      fields.push('mission_type = ?');
      values.push(params.missionType);
    }
    if (params.autonomyLevel !== undefined) {
      fields.push('autonomy_level = ?');
      values.push(params.autonomyLevel);
    }
    if (params.structuredMetrics !== undefined) {
      fields.push('structured_metrics = ?');
      values.push(
        params.structuredMetrics !== null ? JSON.stringify(params.structuredMetrics) : null
      );
    }
    if (params.schedule !== undefined) {
      fields.push('schedule = ?');
      values.push(params.schedule !== null ? JSON.stringify(params.schedule) : null);
    }
    if (params.schedulePaused !== undefined) {
      fields.push('schedule_paused = ?');
      values.push(params.schedulePaused ? 1 : 0);
    }
    if (params.nextRunAt !== undefined) {
      fields.push('next_run_at = ?');
      values.push(params.nextRunAt);
    }
    if (params.maxConsecutiveFailures !== undefined) {
      fields.push('max_consecutive_failures = ?');
      values.push(params.maxConsecutiveFailures);
    }
    if (params.maxPlanningAttempts !== undefined) {
      fields.push('max_planning_attempts = ?');
      values.push(params.maxPlanningAttempts);
    }
    if (params.consecutiveFailures !== undefined) {
      fields.push('consecutive_failures = ?');
      values.push(params.consecutiveFailures);
    }
    if (params.replanCount !== undefined) {
      fields.push('replan_count = ?');
      values.push(params.replanCount);
    }

    if (fields.length === 0) {
      return this.getGoal(id);
    }

    fields.push('updated_at = ?');
    values.push(Date.now());

    values.push(id);

    const stmt = this.db.prepare(`UPDATE goals SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    this.reactiveDb.notifyChange('goals');
    return this.getGoal(id);
  }

  deleteGoal(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM goals WHERE id = ?`);
    const result = stmt.run(id);
    if (result.changes > 0) {
      this.reactiveDb.notifyChange('goals');
      return true;
    }
    return false;
  }

  linkTaskToGoal(goalId: string, taskId: string): RoomGoal | null {
    const goal = this.getGoal(goalId);
    if (!goal) return null;

    const linkedTaskIds = [...new Set([...goal.linkedTaskIds, taskId])];
    return this.updateGoal(goalId, { linkedTaskIds });
  }

  linkTaskToExecution(goalId: string, executionId: string, taskId: string): RoomGoal | null {
    return this.db.transaction(() => {
      const execRow = this.db
        .prepare(`SELECT task_ids FROM mission_executions WHERE id = ? AND goal_id = ?`)
        .get(executionId, goalId) as { task_ids: string } | undefined;
      if (!execRow) return null;

      const execTaskIds: string[] = JSON.parse(execRow.task_ids);
      if (!execTaskIds.includes(taskId)) {
        execTaskIds.push(taskId);
      }
      this.db
        .prepare(`UPDATE mission_executions SET task_ids = ? WHERE id = ?`)
        .run(JSON.stringify(execTaskIds), executionId);

      const goal = this.getGoal(goalId);
      if (!goal) return null;
      const goalTaskIds = [...new Set([...goal.linkedTaskIds, taskId])];
      return this.updateGoal(goalId, { linkedTaskIds: goalTaskIds });
    })();
  }

  unlinkTaskFromGoal(goalId: string, taskId: string): RoomGoal | null {
    const goal = this.getGoal(goalId);
    if (!goal) return null;

    const linkedTaskIds = goal.linkedTaskIds.filter((id) => id !== taskId);
    return this.updateGoal(goalId, { linkedTaskIds });
  }

  getGoalsForTask(taskId: string): RoomGoal[] {
    const stmt = this.db.prepare(`
			SELECT g.*
			FROM goals g, json_each(g.linked_task_ids) AS task_id
			WHERE task_id.value = ?
			ORDER BY g.created_at ASC
		`);
    const rows = stmt.all(taskId) as Record<string, unknown>[];
    return rows.map((row) => {
      const goal = this.rowToGoal(row);
      if (!goal.shortId && this.shortIdAllocator) {
        const shortId = this.shortIdAllocator.allocate('goal', goal.roomId);
        this.db.prepare(`UPDATE goals SET short_id = ? WHERE id = ?`).run(shortId, goal.id);
        return { ...goal, shortId };
      }
      return goal;
    });
  }

  getActiveGoalCount(roomId: string): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM goals WHERE room_id = ? AND status IN ('active', 'needs_human')`
    );
    const row = stmt.get(roomId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  insertMetricHistory(
    goalId: string,
    metricName: string,
    value: number,
    recordedAt?: number
  ): MetricHistoryEntry {
    const id = generateUUID();
    const ts = recordedAt ?? Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `INSERT INTO mission_metric_history (id, goal_id, metric_name, value, recorded_at)
				 VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, goalId, metricName, value, ts);

    return { metricName, value, recordedAt: ts };
  }

  queryMetricHistory(
    goalId: string,
    opts: {
      metricName?: string;
      fromTs?: number;
      toTs?: number;
      limit?: number;
    } = {}
  ): MetricHistoryEntry[] {
    let query = `SELECT metric_name, value, recorded_at FROM mission_metric_history WHERE goal_id = ?`;
    const params: SQLiteValue[] = [goalId];

    if (opts.metricName) {
      query += ` AND metric_name = ?`;
      params.push(opts.metricName);
    }
    if (opts.fromTs !== undefined) {
      query += ` AND recorded_at >= ?`;
      params.push(opts.fromTs);
    }
    if (opts.toTs !== undefined) {
      query += ` AND recorded_at <= ?`;
      params.push(opts.toTs);
    }

    query += ` ORDER BY recorded_at ASC`;

    if (opts.limit !== undefined) {
      query += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = this.db.prepare(query).all(...params) as Array<{
      metric_name: string;
      value: number;
      recorded_at: number;
    }>;

    return rows.map((r) => ({
      metricName: r.metric_name,
      value: r.value,
      recordedAt: r.recorded_at,
    }));
  }

  getNextExecutionNumber(goalId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(execution_number) as max_num FROM mission_executions WHERE goal_id = ?`)
      .get(goalId) as { max_num: number | null } | undefined;
    const maxNum = row?.max_num ?? 0;
    return maxNum + 1;
  }

  clearLinkedTaskIds(goalId: string): RoomGoal | null {
    return this.updateGoal(goalId, { linkedTaskIds: [] });
  }

  atomicStartExecution(goalId: string, nextRunAt?: number): MissionExecution {
    return this.db.transaction(() => {
      const executionNumber = this.getNextExecutionNumber(goalId);

      const goalUpdates: UpdateGoalParams = {
        linkedTaskIds: [],
        planning_attempts: 0,
      };
      if (nextRunAt !== undefined) {
        goalUpdates.nextRunAt = nextRunAt;
      }
      this.updateGoal(goalId, goalUpdates);

      return this.insertExecution({ goalId, executionNumber });
    })();
  }

  insertExecution(params: CreateExecutionParams): MissionExecution {
    const id = generateUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `INSERT INTO mission_executions
				 (id, goal_id, execution_number, started_at, status, task_ids, planning_attempts)
				 VALUES (?, ?, ?, ?, 'running', ?, 0)`
      )
      .run(
        id,
        params.goalId,
        params.executionNumber,
        params.startedAt ?? now,
        JSON.stringify(params.taskIds ?? [])
      );

    return this.getExecution(id)!;
  }

  getExecution(id: string): MissionExecution | null {
    const row = this.db.prepare(`SELECT * FROM mission_executions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToExecution(row);
  }

  listExecutions(goalId: string, limit?: number): MissionExecution[] {
    let query = `SELECT * FROM mission_executions WHERE goal_id = ? ORDER BY execution_number DESC`;
    const params: SQLiteValue[] = [goalId];
    if (limit !== undefined) {
      query += ` LIMIT ?`;
      params.push(limit);
    }
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToExecution(r));
  }

  updateExecution(id: string, params: UpdateExecutionParams): MissionExecution | null {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.status !== undefined) {
      fields.push('status = ?');
      values.push(params.status);
    }
    if (params.completedAt !== undefined) {
      fields.push('completed_at = ?');
      values.push(params.completedAt);
    }
    if (params.resultSummary !== undefined) {
      fields.push('result_summary = ?');
      values.push(params.resultSummary);
    }
    if (params.taskIds !== undefined) {
      fields.push('task_ids = ?');
      values.push(JSON.stringify(params.taskIds));
    }
    if (params.planningAttempts !== undefined) {
      fields.push('planning_attempts = ?');
      values.push(params.planningAttempts);
    }

    if (fields.length === 0) return this.getExecution(id);

    values.push(id);
    this.db
      .prepare(`UPDATE mission_executions SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);
    return this.getExecution(id);
  }

  getActiveExecution(goalId: string): MissionExecution | null {
    const row = this.db
      .prepare(`SELECT * FROM mission_executions WHERE goal_id = ? AND status = 'running' LIMIT 1`)
      .get(goalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToExecution(row);
  }

  private rowToGoal(row: Record<string, unknown>): RoomGoal {
    return {
      id: row.id as string,
      roomId: row.room_id as string,
      shortId: (row.short_id as string | null) ?? undefined,
      title: row.title as string,
      description: row.description as string,
      status: row.status as GoalStatus,
      priority: row.priority as GoalPriority,
      progress: row.progress as number,
      linkedTaskIds: parseJson<string[]>((row.linked_task_ids as string | null) ?? '[]', []),
      metrics: parseJson<Record<string, number>>((row.metrics as string | null) ?? '{}', {}),
      planning_attempts: (row.planning_attempts as number | null) ?? 0,
      goal_review_attempts: (row.goal_review_attempts as number | null) ?? 0,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      completedAt: (row.completed_at as number | null) ?? undefined,
      missionType: (row.mission_type as MissionType | null) ?? 'one_shot',
      autonomyLevel: (row.autonomy_level as AutonomyLevel | null) ?? 'supervised',
      structuredMetrics: parseJsonOptional<MissionMetric[]>(
        row.structured_metrics as string | null
      ),
      schedule: parseJsonOptional<CronSchedule>(row.schedule as string | null),
      schedulePaused: row.schedule_paused === 1,
      nextRunAt: (row.next_run_at as number | null) ?? undefined,
      maxConsecutiveFailures: (row.max_consecutive_failures as number | null) ?? 3,
      maxPlanningAttempts: (row.max_planning_attempts as number | null) ?? 0,
      consecutiveFailures: (row.consecutive_failures as number | null) ?? 0,
      replanCount: (row.replan_count as number | null) ?? undefined,
    };
  }

  private rowToExecution(row: Record<string, unknown>): MissionExecution {
    return {
      id: row.id as string,
      goalId: row.goal_id as string,
      executionNumber: row.execution_number as number,
      startedAt: row.started_at as number,
      completedAt: (row.completed_at as number | null) ?? undefined,
      status: row.status as MissionExecutionStatus,
      resultSummary: (row.result_summary as string | null) ?? undefined,
      taskIds: JSON.parse(row.task_ids as string) as string[],
      planningAttempts: (row.planning_attempts as number | null) ?? 0,
    };
  }
}

export function getEffectiveMaxPlanningAttempts(
  goal: RoomGoal,
  roomConfig?: Record<string, unknown>
): number {
  if (
    goal.maxPlanningAttempts !== undefined &&
    Number.isInteger(goal.maxPlanningAttempts) &&
    goal.maxPlanningAttempts > 0
  ) {
    return goal.maxPlanningAttempts;
  }

  if (roomConfig !== undefined) {
    const retries = roomConfig['maxPlanningRetries'];
    if (typeof retries === 'number' && Number.isInteger(retries) && retries >= 0) {
      return retries + 1;
    }
  }

  return 2;
}
