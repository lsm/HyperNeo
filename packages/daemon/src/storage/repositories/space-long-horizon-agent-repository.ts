import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	CreateSpaceLongHorizonAgentParams,
	CreateSpaceLongHorizonAgentReminderParams,
	CreateSpaceLongHorizonAgentSubscriptionParams,
	SpaceAgentAutonomyLevel,
	SpaceLongHorizonAgent,
	SpaceLongHorizonAgentEventSubscription,
	SpaceLongHorizonAgentForgeScope,
	SpaceLongHorizonAgentGoal,
	SpaceLongHorizonAgentReminder,
	SpaceLongHorizonAgentStatus,
	UpdateSpaceLongHorizonAgentParams,
} from '@neokai/shared';
import type { SQLiteValue } from '../types';

const DEFAULT_TOOL_PERMISSIONS: Record<string, never> = {};

export class SpaceLongHorizonAgentRepository {
	constructor(private db: BunDatabase) {}

	create(params: CreateSpaceLongHorizonAgentParams): SpaceLongHorizonAgent {
		const id = params.id ?? generateUUID();
		const now = Date.now();
		const displayName = params.displayName ?? params.handle;

		this.db
			.prepare(
				`INSERT INTO space_long_horizon_agents (
					id, space_id, handle, display_name, template_key, status, session_id,
					instructions, autonomy_level, tool_permissions_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.spaceId,
				params.handle,
				displayName,
				params.templateKey ?? null,
				params.status ?? 'active',
				params.sessionId ?? null,
				params.instructions ?? '',
				params.autonomyLevel ?? null,
				JSON.stringify(params.toolPermissions ?? DEFAULT_TOOL_PERMISSIONS),
				now,
				now
			);

		return this.getById(id) as SpaceLongHorizonAgent;
	}

	getById(id: string): SpaceLongHorizonAgent | null {
		const row = this.db.prepare(`SELECT * FROM space_long_horizon_agents WHERE id = ?`).get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? rowToAgent(row) : null;
	}

	getByHandle(spaceId: string, handle: string): SpaceLongHorizonAgent | null {
		const row = this.db
			.prepare(
				`SELECT * FROM space_long_horizon_agents WHERE space_id = ? AND handle = ? AND status != 'archived'`
			)
			.get(spaceId, handle) as Record<string, unknown> | undefined;
		return row ? rowToAgent(row) : null;
	}

	getCoordinator(spaceId: string): SpaceLongHorizonAgent | null {
		return this.getByHandle(spaceId, 'coordinator');
	}

	ensureCoordinator(spaceId: string): SpaceLongHorizonAgent {
		const existingById = this.getById(coordinatorLongHorizonAgentId(spaceId));
		if (existingById) {
			if (existingById.status === 'archived') {
				return this.update(existingById.id, { status: 'active' }) as SpaceLongHorizonAgent;
			}
			return existingById;
		}

		const existingByHandle = this.getCoordinator(spaceId);
		if (existingByHandle) return existingByHandle;

		return this.create({
			id: coordinatorLongHorizonAgentId(spaceId),
			spaceId,
			handle: 'coordinator',
			displayName: 'Coordinator',
			templateKey: 'coordinator.default',
			status: 'active',
			sessionId: coordinatorSessionId(spaceId),
			instructions: 'Coordinate goals, tasks, reminders, event subscriptions, and Space activity.',
		});
	}

	listBySpaceId(spaceId: string): SpaceLongHorizonAgent[] {
		const rows = this.db
			.prepare(`SELECT * FROM space_long_horizon_agents WHERE space_id = ? ORDER BY created_at ASC`)
			.all(spaceId) as Record<string, unknown>[];
		return rows.map(rowToAgent);
	}

	update(id: string, params: UpdateSpaceLongHorizonAgentParams): SpaceLongHorizonAgent | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.handle !== undefined) {
			fields.push('handle = ?');
			values.push(params.handle);
		}
		if (params.displayName !== undefined) {
			fields.push('display_name = ?');
			values.push(params.displayName);
		}
		if (params.templateKey !== undefined) {
			fields.push('template_key = ?');
			values.push(params.templateKey ?? null);
		}
		if (params.status !== undefined) {
			fields.push('status = ?');
			values.push(params.status);
		}
		if (params.sessionId !== undefined) {
			fields.push('session_id = ?');
			values.push(params.sessionId ?? null);
		}
		if (params.instructions !== undefined) {
			fields.push('instructions = ?');
			values.push(params.instructions);
		}
		if (params.autonomyLevel !== undefined) {
			fields.push('autonomy_level = ?');
			values.push(params.autonomyLevel ?? null);
		}
		if (params.toolPermissions !== undefined) {
			fields.push('tool_permissions_json = ?');
			values.push(JSON.stringify(params.toolPermissions ?? DEFAULT_TOOL_PERMISSIONS));
		}

		if (fields.length === 0) return this.getById(id);

		fields.push('updated_at = ?');
		values.push(Date.now(), id);
		this.db
			.prepare(`UPDATE space_long_horizon_agents SET ${fields.join(', ')} WHERE id = ?`)
			.run(...values);
		return this.getById(id);
	}

	delete(id: string): void {
		this.db.prepare(`DELETE FROM space_long_horizon_agents WHERE id = ?`).run(id);
	}

	assignGoal(
		agentId: string,
		goalId: string,
		relationship: SpaceLongHorizonAgentGoal['relationship'] = 'owner'
	): void {
		const agent = this.requireAgent(agentId);
		this.requireMatchingSpace('space_goals', goalId, agent.spaceId, 'Goal');
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO space_long_horizon_agent_goals (agent_id, goal_id, relationship, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(agent_id, goal_id, relationship) DO UPDATE SET updated_at = excluded.updated_at`
			)
			.run(agentId, goalId, relationship, now, now);
	}

	listGoals(agentId: string): SpaceLongHorizonAgentGoal[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_long_horizon_agent_goals WHERE agent_id = ? ORDER BY created_at ASC`
			)
			.all(agentId) as Record<string, unknown>[];
		return rows.map(rowToGoalLink);
	}

	assignForgeScope(
		agentId: string,
		scopeId: string,
		relationship: SpaceLongHorizonAgentForgeScope['relationship'] = 'owner'
	): void {
		const agent = this.requireAgent(agentId);
		this.requireMatchingSpace('evolution_scopes', scopeId, agent.spaceId, 'Forge scope');
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO space_long_horizon_agent_forge_scopes (agent_id, scope_id, relationship, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(agent_id, scope_id, relationship) DO UPDATE SET updated_at = excluded.updated_at`
			)
			.run(agentId, scopeId, relationship, now, now);
	}

	listForgeScopes(agentId: string): SpaceLongHorizonAgentForgeScope[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_long_horizon_agent_forge_scopes WHERE agent_id = ? ORDER BY created_at ASC`
			)
			.all(agentId) as Record<string, unknown>[];
		return rows.map(rowToForgeScopeLink);
	}

	createReminder(params: CreateSpaceLongHorizonAgentReminderParams): SpaceLongHorizonAgentReminder {
		this.requireAgentInSpace(params.agentId, params.spaceId);
		const id = generateUUID();
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO space_long_horizon_agent_reminders (
					id, space_id, agent_id, title, body, status, trigger_type, run_at, cron_expression,
					timezone, next_run_at, last_fired_at, created_by_session, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.spaceId,
				params.agentId,
				params.title,
				params.body ?? '',
				params.status ?? 'active',
				params.triggerType,
				params.runAt ?? null,
				params.cronExpression ?? null,
				params.timezone ?? 'UTC',
				params.nextRunAt ?? null,
				params.lastFiredAt ?? null,
				params.createdBySession ?? null,
				now,
				now
			);
		return this.getReminder(id) as SpaceLongHorizonAgentReminder;
	}

	getReminder(id: string): SpaceLongHorizonAgentReminder | null {
		const row = this.db
			.prepare(`SELECT * FROM space_long_horizon_agent_reminders WHERE id = ?`)
			.get(id) as Record<string, unknown> | undefined;
		return row ? rowToReminder(row) : null;
	}

	listReminders(agentId: string): SpaceLongHorizonAgentReminder[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_long_horizon_agent_reminders WHERE agent_id = ? ORDER BY created_at ASC`
			)
			.all(agentId) as Record<string, unknown>[];
		return rows.map(rowToReminder);
	}

	createSubscription(
		params: CreateSpaceLongHorizonAgentSubscriptionParams
	): SpaceLongHorizonAgentEventSubscription {
		this.requireAgentInSpace(params.agentId, params.spaceId);
		const id = generateUUID();
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO space_long_horizon_agent_event_subscriptions (
					id, space_id, agent_id, source, topic, filter_json, status, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.spaceId,
				params.agentId,
				params.source,
				params.topic,
				JSON.stringify(params.filter ?? {}),
				params.status ?? 'active',
				now,
				now
			);
		return this.getSubscription(id) as SpaceLongHorizonAgentEventSubscription;
	}

	getSubscription(id: string): SpaceLongHorizonAgentEventSubscription | null {
		const row = this.db
			.prepare(`SELECT * FROM space_long_horizon_agent_event_subscriptions WHERE id = ?`)
			.get(id) as Record<string, unknown> | undefined;
		return row ? rowToSubscription(row) : null;
	}

	listSubscriptions(agentId: string): SpaceLongHorizonAgentEventSubscription[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_long_horizon_agent_event_subscriptions WHERE agent_id = ? ORDER BY created_at ASC`
			)
			.all(agentId) as Record<string, unknown>[];
		return rows.map(rowToSubscription);
	}

	private requireAgent(agentId: string): SpaceLongHorizonAgent {
		const agent = this.getById(agentId);
		if (!agent) throw new Error(`Long-horizon agent not found: ${agentId}`);
		return agent;
	}

	private requireAgentInSpace(agentId: string, spaceId: string): SpaceLongHorizonAgent {
		const agent = this.requireAgent(agentId);
		if (agent.spaceId !== spaceId) {
			throw new Error(`Long-horizon agent ${agentId} does not belong to space ${spaceId}`);
		}
		return agent;
	}

	private requireMatchingSpace(
		tableName: 'space_goals' | 'evolution_scopes',
		id: string,
		spaceId: string,
		label: string
	): void {
		const row = this.db.prepare(`SELECT space_id FROM ${tableName} WHERE id = ?`).get(id) as
			| { space_id: string }
			| undefined;
		if (!row) throw new Error(`${label} not found: ${id}`);
		if (row.space_id !== spaceId) {
			throw new Error(`${label} ${id} does not belong to space ${spaceId}`);
		}
	}
}

export function coordinatorSessionId(spaceId: string): string {
	return `space:chat:${spaceId}`;
}

export function coordinatorLongHorizonAgentId(spaceId: string): string {
	return `space-lh-agent:coordinator:${spaceId}`;
}

function rowToAgent(row: Record<string, unknown>): SpaceLongHorizonAgent {
	return {
		id: row.id as string,
		spaceId: row.space_id as string,
		handle: row.handle as string,
		displayName: row.display_name as string,
		templateKey: (row.template_key as string | null) ?? null,
		status: row.status as SpaceLongHorizonAgentStatus,
		sessionId: (row.session_id as string | null) ?? null,
		instructions: (row.instructions as string | null) ?? '',
		autonomyLevel: (row.autonomy_level as SpaceAgentAutonomyLevel | null) ?? null,
		toolPermissions: parseObject(row.tool_permissions_json),
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number,
	};
}

function rowToGoalLink(row: Record<string, unknown>): SpaceLongHorizonAgentGoal {
	return {
		agentId: row.agent_id as string,
		goalId: row.goal_id as string,
		relationship: row.relationship as SpaceLongHorizonAgentGoal['relationship'],
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number,
	};
}

function rowToForgeScopeLink(row: Record<string, unknown>): SpaceLongHorizonAgentForgeScope {
	return {
		agentId: row.agent_id as string,
		scopeId: row.scope_id as string,
		relationship: row.relationship as SpaceLongHorizonAgentForgeScope['relationship'],
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number,
	};
}

function rowToReminder(row: Record<string, unknown>): SpaceLongHorizonAgentReminder {
	return {
		id: row.id as string,
		spaceId: row.space_id as string,
		agentId: row.agent_id as string,
		title: row.title as string,
		body: (row.body as string | null) ?? '',
		status: row.status as SpaceLongHorizonAgentReminder['status'],
		triggerType: row.trigger_type as SpaceLongHorizonAgentReminder['triggerType'],
		runAt: (row.run_at as number | null) ?? null,
		cronExpression: (row.cron_expression as string | null) ?? null,
		timezone: row.timezone as string,
		nextRunAt: (row.next_run_at as number | null) ?? null,
		lastFiredAt: (row.last_fired_at as number | null) ?? null,
		createdBySession: (row.created_by_session as string | null) ?? null,
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number,
	};
}

function rowToSubscription(row: Record<string, unknown>): SpaceLongHorizonAgentEventSubscription {
	return {
		id: row.id as string,
		spaceId: row.space_id as string,
		agentId: row.agent_id as string,
		source: row.source as string,
		topic: row.topic as string,
		filter: parseObject(row.filter_json),
		status: row.status as SpaceLongHorizonAgentEventSubscription['status'],
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number,
	};
}

function parseObject(value: unknown): Record<string, unknown> {
	if (typeof value !== 'string' || value.length === 0) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
