import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { GoalForgeAutomationTriggerKind } from '@neokai/shared';
import type { SQLiteValue } from '../types';

export interface GoalAutomationCursor {
	id: string;
	spaceId: string;
	goalId: string;
	scopeId: string;
	triggerKind: GoalForgeAutomationTriggerKind;
	triggerKey: string;
	lastEvidenceCreatedAt: number | null;
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

	upsert(params: UpsertGoalAutomationCursorParams): GoalAutomationCursor {
		const existing = this.get(params.goalId, params.scopeId, params.triggerKind, params.triggerKey);
		if (!existing) return this.create(params);
		const sets: string[] = [];
		const values: SQLiteValue[] = [];
		const add = (column: string, value: SQLiteValue) => {
			sets.push(`${column} = ?`);
			values.push(value);
		};
		add('space_id', params.spaceId);
		add('scope_id', params.scopeId);
		if (params.lastEvidenceCreatedAt !== undefined) {
			add('last_evidence_created_at', params.lastEvidenceCreatedAt);
		}
		if (params.lastTaskCompletedAt !== undefined) {
			add('last_task_completed_at', params.lastTaskCompletedAt);
		}
		if (params.lastExternalEventId !== undefined) {
			add('last_external_event_id', params.lastExternalEventId);
		}
		if (params.lastEpisodeId !== undefined) add('last_episode_id', params.lastEpisodeId);
		if (params.lastFiredAt !== undefined) add('last_fired_at', params.lastFiredAt);
		if (params.metadata !== undefined) add('metadata_json', JSON.stringify(params.metadata));
		add('updated_at', Date.now());
		values.push(existing.id);
		this.db
			.prepare(`UPDATE goal_automation_cursors SET ${sets.join(', ')} WHERE id = ?`)
			.run(...values);
		return this.get(
			params.goalId,
			params.scopeId,
			params.triggerKind,
			params.triggerKey
		) as GoalAutomationCursor;
	}

	private create(params: UpsertGoalAutomationCursorParams): GoalAutomationCursor {
		const id = generateUUID();
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO goal_automation_cursors (
					id, space_id, goal_id, scope_id, trigger_kind, trigger_key,
					last_evidence_created_at, last_task_completed_at, last_external_event_id,
					last_episode_id, last_fired_at, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.spaceId,
				params.goalId,
				params.scopeId,
				params.triggerKind,
				params.triggerKey,
				params.lastEvidenceCreatedAt ?? null,
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
