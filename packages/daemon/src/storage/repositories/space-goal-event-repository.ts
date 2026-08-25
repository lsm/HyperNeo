import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';
import type {
  CreateSpaceGoalEventParams,
  SpaceGoalEvent,
  SpaceGoalEventDiff,
  SpaceGoalEventListParams,
  SpaceGoalEventSnapshot,
  SpaceGoalEventSource,
  SpaceGoalEventType,
} from '@hyperneo/shared';
import type { ReactiveDatabase } from '../reactive-database.ts';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class SpaceGoalEventRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {}

  create(params: CreateSpaceGoalEventParams): SpaceGoalEvent {
    const id = generateUUID();
    const createdAt = params.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO space_goal_events (
					id, space_id, goal_id, event_type, source, source_task_id, source_session_id,
					previous_state, new_state, diff, note, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.spaceId,
        params.goalId,
        params.eventType,
        params.source,
        params.sourceTaskId ?? null,
        params.sourceSessionId ?? null,
        stringifyNullable(params.previousState),
        stringifyNullable(params.newState),
        stringifyNullable(params.diff),
        params.note ?? null,
        createdAt
      );
    this.reactiveDb?.notifyChange('space_goal_events');
    return this.getById(id) as SpaceGoalEvent;
  }

  getById(id: string): SpaceGoalEvent | null {
    const row = this.db.prepare(`SELECT * FROM space_goal_events WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEvent(row) : null;
  }

  listByGoal(goalId: string, params: SpaceGoalEventListParams = {}): SpaceGoalEvent[] {
    const limit = normalizeLimit(params.limit);
    const cursorId = normalizeCursorId(params.beforeId);
    const rows = params.before
      ? cursorId
        ? (this.db
            .prepare(
              `SELECT * FROM space_goal_events WHERE goal_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(goalId, params.before, params.before, cursorId, limit) as Record<
            string,
            unknown
          >[])
        : (this.db
            .prepare(
              `SELECT * FROM space_goal_events WHERE goal_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(goalId, params.before, limit) as Record<string, unknown>[])
      : (this.db
          .prepare(
            `SELECT * FROM space_goal_events WHERE goal_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
          )
          .all(goalId, limit) as Record<string, unknown>[]);
    return rows.map(rowToEvent);
  }

  listBySpace(spaceId: string, params: SpaceGoalEventListParams = {}): SpaceGoalEvent[] {
    const limit = normalizeLimit(params.limit);
    const cursorId = normalizeCursorId(params.beforeId);
    const rows = params.before
      ? cursorId
        ? (this.db
            .prepare(
              `SELECT * FROM space_goal_events WHERE space_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(spaceId, params.before, params.before, cursorId, limit) as Record<
            string,
            unknown
          >[])
        : (this.db
            .prepare(
              `SELECT * FROM space_goal_events WHERE space_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(spaceId, params.before, limit) as Record<string, unknown>[])
      : (this.db
          .prepare(
            `SELECT * FROM space_goal_events WHERE space_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
          )
          .all(spaceId, limit) as Record<string, unknown>[]);
    return rows.map(rowToEvent);
  }
}

function rowToEvent(row: Record<string, unknown>): SpaceGoalEvent {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    goalId: row.goal_id as string,
    eventType: row.event_type as SpaceGoalEventType,
    source: row.source as SpaceGoalEventSource,
    sourceTaskId: (row.source_task_id as string | null) ?? null,
    sourceSessionId: (row.source_session_id as string | null) ?? null,
    previousState: parseJson<SpaceGoalEventSnapshot>(row.previous_state, null),
    newState: parseJson<SpaceGoalEventSnapshot>(row.new_state, null),
    diff: parseJson<SpaceGoalEventDiff>(row.diff, null),
    note: (row.note as string | null) ?? null,
    createdAt: row.created_at as number,
  };
}

function stringifyNullable(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function parseJson<T>(value: unknown, fallback: T | null): T | null {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit as number)));
}

function normalizeCursorId(id: string | undefined): string | null {
  return typeof id === 'string' && id.length > 0 ? id : null;
}
