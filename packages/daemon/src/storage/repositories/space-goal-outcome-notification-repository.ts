import { generateUUID } from '@hyperneo/shared';
import type {
  SpaceGoalOutcomeNotification,
  SpaceGoalOutcomeNotificationPayload,
  SpaceGoalOutcomeNotificationStatus,
} from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat';

export interface CreateGoalOutcomeNotificationParams {
  spaceId: string;
  goalId: string;
  taskId: string;
  terminalGeneration: number;
  goalRevision: number;
  payload: SpaceGoalOutcomeNotificationPayload;
}

export class SpaceGoalOutcomeNotificationRepository {
  constructor(private db: BunDatabase) {}

  create(params: CreateGoalOutcomeNotificationParams): SpaceGoalOutcomeNotification {
    const id = generateUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO space_goal_outcome_notifications (
					id, space_id, goal_id, task_id, terminal_generation, goal_revision,
					status, payload_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(
        id,
        params.spaceId,
        params.goalId,
        params.taskId,
        params.terminalGeneration,
        params.goalRevision,
        JSON.stringify(params.payload),
        now,
        now
      );
    const row = this.db
      .prepare(
        `SELECT * FROM space_goal_outcome_notifications WHERE goal_id = ? AND task_id = ? AND terminal_generation = ?`
      )
      .get(params.goalId, params.taskId, params.terminalGeneration) as Record<string, unknown>;
    return row ? rowToNotification(row) : this.getById(id)!;
  }

  getById(id: string): SpaceGoalOutcomeNotification | null {
    const row = this.db
      .prepare(`SELECT * FROM space_goal_outcome_notifications WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToNotification(row) : null;
  }

  listPending(): SpaceGoalOutcomeNotification[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_goal_outcome_notifications
				 WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1000`
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToNotification);
  }

  listPendingByGoal(goalId: string): SpaceGoalOutcomeNotification[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_goal_outcome_notifications
				 WHERE goal_id = ? AND status = 'pending' ORDER BY created_at ASC`
      )
      .all(goalId) as Record<string, unknown>[];
    return rows.map(rowToNotification);
  }

  listByTask(taskId: string): SpaceGoalOutcomeNotification[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_goal_outcome_notifications
					 WHERE task_id = ? ORDER BY created_at ASC`
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToNotification);
  }

  supersedeForTask(taskId: string): number {
    const result = this.db
      .prepare(
        `UPDATE space_goal_outcome_notifications
				 SET status = 'superseded', updated_at = ?
				 WHERE task_id = ? AND status = 'pending'`
      )
      .run(Date.now(), taskId);
    return result.changes;
  }

  supersedeForTaskOlderThan(taskId: string, terminalGeneration: number): number {
    const result = this.db
      .prepare(
        `UPDATE space_goal_outcome_notifications
					 SET status = 'superseded', updated_at = ?
					 WHERE task_id = ? AND status = 'pending' AND terminal_generation < ?`
      )
      .run(Date.now(), taskId, terminalGeneration);
    return result.changes;
  }

  updateStatus(
    id: string,
    status: SpaceGoalOutcomeNotificationStatus
  ): SpaceGoalOutcomeNotification | null {
    this.db
      .prepare(
        `UPDATE space_goal_outcome_notifications SET status = ?, updated_at = ? WHERE id = ?`
      )
      .run(status, Date.now(), id);
    return this.getById(id);
  }

  countByGoal(goalId: string, status: SpaceGoalOutcomeNotificationStatus): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM space_goal_outcome_notifications WHERE goal_id = ? AND status = ?`
      )
      .get(goalId, status) as { count: number };
    return row?.count ?? 0;
  }
}

function rowToNotification(row: Record<string, unknown>): SpaceGoalOutcomeNotification {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    goalId: row.goal_id as string,
    taskId: row.task_id as string,
    terminalGeneration: (row.terminal_generation as number) ?? 0,
    goalRevision: (row.goal_revision as number) ?? 0,
    status: row.status as SpaceGoalOutcomeNotificationStatus,
    payload: parsePayload(row.payload_json),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function parsePayload(raw: unknown): SpaceGoalOutcomeNotificationPayload {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { summary: '', taskStatus: 'done', taskTitle: '', goalTitle: '' };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SpaceGoalOutcomeNotificationPayload>;
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      taskStatus: parsed.taskStatus ?? 'done',
      taskTitle: typeof parsed.taskTitle === 'string' ? parsed.taskTitle : '',
      goalTitle: typeof parsed.goalTitle === 'string' ? parsed.goalTitle : '',
    };
  } catch {
    return { summary: '', taskStatus: 'done', taskTitle: '', goalTitle: '' };
  }
}
