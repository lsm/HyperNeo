import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';
import type { GoalForgeAutomationTriggerKind } from '@hyperneo/shared';

export interface GoalAutomationCursor {
  id: string;
  spaceId: string;
  goalId: string;
  scopeId: string;
  triggerKind: GoalForgeAutomationTriggerKind;
  triggerKey: string;
  lastEvidenceCreatedAt: number | null;
  lastEvidenceId: string | null;
  lastTaskCompletedAt: number | null;
  lastExternalEventId: string | null;
  lastEpisodeId: string | null;
  lastFiredAt: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertGoalAutomationCursorParams {
  spaceId: string;
  goalId: string;
  scopeId: string;
  triggerKind: GoalForgeAutomationTriggerKind;
  triggerKey: string;
  lastEvidenceCreatedAt?: number | null;
  lastEvidenceId?: string | null;
  lastTaskCompletedAt?: number | null;
  lastExternalEventId?: string | null;
  lastEpisodeId?: string | null;
  lastFiredAt?: number | null;
  metadata?: Record<string, unknown>;
}

export class GoalAutomationCursorRepository {
  constructor(private db: BunDatabase) {}

  get(
    goalId: string,
    scopeId: string,
    triggerKind: GoalForgeAutomationTriggerKind,
    triggerKey: string
  ): GoalAutomationCursor | null {
    const row = this.db
      .prepare(
        `SELECT * FROM goal_automation_cursors
				 WHERE goal_id = ? AND scope_id = ? AND trigger_kind = ? AND trigger_key = ?`
      )
      .get(goalId, scopeId, triggerKind, triggerKey) as Record<string, unknown> | undefined;
    return row ? rowToCursor(row) : null;
  }

  getLatestForTriggerKind(
    goalId: string,
    scopeId: string,
    triggerKind: GoalForgeAutomationTriggerKind
  ): GoalAutomationCursor | null {
    const row = this.db
      .prepare(
        `SELECT * FROM goal_automation_cursors
					 WHERE goal_id = ? AND scope_id = ? AND trigger_kind = ?
					 ORDER BY COALESCE(last_evidence_created_at, 0) DESC, COALESCE(last_evidence_id, '') DESC, COALESCE(last_fired_at, 0) DESC, updated_at DESC
					 LIMIT 1`
      )
      .get(goalId, scopeId, triggerKind) as Record<string, unknown> | undefined;
    return row ? rowToCursor(row) : null;
  }

  upsert(params: UpsertGoalAutomationCursorParams): GoalAutomationCursor {
    const id = generateUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO goal_automation_cursors (
					id, space_id, goal_id, scope_id, trigger_kind, trigger_key,
					last_evidence_created_at, last_evidence_id, last_task_completed_at,
					last_external_event_id, last_episode_id, last_fired_at, metadata_json,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(goal_id, scope_id, trigger_kind, trigger_key) DO UPDATE SET
					space_id = excluded.space_id,
					scope_id = excluded.scope_id,
					last_evidence_created_at = CASE
						WHEN goal_automation_cursors.last_fired_at IS NULL
							OR excluded.last_fired_at >= goal_automation_cursors.last_fired_at
						THEN excluded.last_evidence_created_at
						ELSE goal_automation_cursors.last_evidence_created_at
					END,
					last_evidence_id = CASE
						WHEN goal_automation_cursors.last_fired_at IS NULL
							OR excluded.last_fired_at >= goal_automation_cursors.last_fired_at
						THEN excluded.last_evidence_id
						ELSE goal_automation_cursors.last_evidence_id
					END,
					last_task_completed_at = CASE
						WHEN goal_automation_cursors.last_fired_at IS NULL
							OR excluded.last_fired_at >= goal_automation_cursors.last_fired_at
						THEN excluded.last_task_completed_at
						ELSE goal_automation_cursors.last_task_completed_at
					END,
					last_external_event_id = CASE
						WHEN goal_automation_cursors.last_fired_at IS NULL
							OR excluded.last_fired_at >= goal_automation_cursors.last_fired_at
						THEN excluded.last_external_event_id
						ELSE goal_automation_cursors.last_external_event_id
					END,
					last_episode_id = CASE
						WHEN goal_automation_cursors.last_fired_at IS NULL
							OR excluded.last_fired_at >= goal_automation_cursors.last_fired_at
						THEN excluded.last_episode_id
						ELSE goal_automation_cursors.last_episode_id
					END,
					last_fired_at = CASE
						WHEN goal_automation_cursors.last_fired_at IS NULL
							OR excluded.last_fired_at >= goal_automation_cursors.last_fired_at
						THEN excluded.last_fired_at
						ELSE goal_automation_cursors.last_fired_at
					END,
					metadata_json = CASE
						WHEN goal_automation_cursors.last_fired_at IS NULL
							OR excluded.last_fired_at >= goal_automation_cursors.last_fired_at
						THEN excluded.metadata_json
						ELSE goal_automation_cursors.metadata_json
					END,
					updated_at = excluded.updated_at`
      )
      .run(
        id,
        params.spaceId,
        params.goalId,
        params.scopeId,
        params.triggerKind,
        params.triggerKey,
        params.lastEvidenceCreatedAt ?? null,
        params.lastEvidenceId ?? null,
        params.lastTaskCompletedAt ?? null,
        params.lastExternalEventId ?? null,
        params.lastEpisodeId ?? null,
        params.lastFiredAt ?? null,
        JSON.stringify(params.metadata ?? {}),
        now,
        now
      );
    return this.get(
      params.goalId,
      params.scopeId,
      params.triggerKind,
      params.triggerKey
    ) as GoalAutomationCursor;
  }
}

function rowToCursor(row: Record<string, unknown>): GoalAutomationCursor {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    goalId: row.goal_id as string,
    scopeId: row.scope_id as string,
    triggerKind: row.trigger_kind as GoalForgeAutomationTriggerKind,
    triggerKey: row.trigger_key as string,
    lastEvidenceCreatedAt: (row.last_evidence_created_at as number | null) ?? null,
    lastEvidenceId: (row.last_evidence_id as string | null) ?? null,
    lastTaskCompletedAt: (row.last_task_completed_at as number | null) ?? null,
    lastExternalEventId: (row.last_external_event_id as string | null) ?? null,
    lastEpisodeId: (row.last_episode_id as string | null) ?? null,
    lastFiredAt: (row.last_fired_at as number | null) ?? null,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
