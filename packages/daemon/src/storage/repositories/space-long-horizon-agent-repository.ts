import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import {
  decideGoalOwnerResolution,
  type GoalOwnerAgentState,
  type GoalOwnerResolutionDecision,
} from '../../lib/space/goals/goal-owner-resolution';
import type {
  CreateSpaceLongHorizonAgentParams,
  CreateSpaceLongHorizonAgentReminderParams,
  CreateSpaceLongHorizonAgentSubscriptionParams,
  UpdateSpaceLongHorizonAgentSubscriptionParams,
  SpaceAgentAutonomyLevel,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentEventSubscription,
  SpaceLongHorizonAgentForgeScope,
  SpaceLongHorizonAgentGoal,
  SpaceLongHorizonAgentReminder,
  SpaceLongHorizonAgentStatus,
  UpdateSpaceLongHorizonAgentParams,
} from '@hyperneo/shared';
import { getLongHorizonAgentTemplate } from '../../lib/space/agents/long-horizon-agent-templates';
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
					instructions, autonomy_level, model, thinking_level, provider, setting_sources,
					tool_permissions_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        params.model ?? null,
        params.thinkingLevel ?? null,
        params.provider ?? null,
        params.settingSources === undefined ? null : JSON.stringify(params.settingSources),
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

    const template = getLongHorizonAgentTemplate('coordinator.default');

    return this.create({
      id: coordinatorLongHorizonAgentId(spaceId),
      spaceId,
      handle: template?.handle ?? 'coordinator',
      displayName: template?.displayName ?? 'Coordinator',
      templateKey: template?.key ?? 'coordinator.default',
      status: 'active',
      sessionId: coordinatorSessionId(spaceId),
      instructions:
        template?.instructions ??
        'Coordinate goals, tasks, reminders, event subscriptions, and Space activity.',
      autonomyLevel: template?.suggestedAutonomyLevel,
      toolPermissions: template?.toolPermissions,
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
    if (params.model !== undefined) {
      fields.push('model = ?');
      values.push(params.model ?? null);
    }
    if (params.thinkingLevel !== undefined) {
      fields.push('thinking_level = ?');
      values.push(params.thinkingLevel ?? null);
    }
    if (params.provider !== undefined) {
      fields.push('provider = ?');
      values.push(params.provider ?? null);
    }
    if (params.settingSources !== undefined) {
      fields.push('setting_sources = ?');
      values.push(params.settingSources === null ? null : JSON.stringify(params.settingSources));
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
    this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT space_id FROM space_long_horizon_agents WHERE id = ?`)
        .get(id) as { space_id: string } | null;
      const hasInbox = !!this.db
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'space_agent_inbox_messages'`
        )
        .get();
      const hasSiblingWorker =
        row != null &&
        !!this.db
          .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'space_agents'`)
          .get()
          ? !!this.db
              .prepare(`SELECT 1 FROM space_agents WHERE id = ? AND space_id = ?`)
              .get(id, row.space_id)
          : false;
      if (hasInbox && !hasSiblingWorker) {
        this.db.prepare(`DELETE FROM space_agent_inbox_messages WHERE target_agent_id = ?`).run(id);
      }
      this.db.prepare(`DELETE FROM space_long_horizon_agents WHERE id = ?`).run(id);
    })();
  }

  assignGoal(
    agentId: string,
    goalId: string,
    relationship: SpaceLongHorizonAgentGoal['relationship'] = 'owner'
  ): void {
    const agent = this.requireAgent(agentId);
    this.requireMatchingSpace('space_goals', goalId, agent.spaceId, 'Goal');
    const now = Date.now();
    const replace = this.db.transaction(() => {
      if (relationship === 'owner') {
        this.db
          .prepare(
            `DELETE FROM space_long_horizon_agent_goals WHERE goal_id = ? AND relationship = 'owner'`
          )
          .run(goalId);
      }
      this.db
        .prepare(
          `INSERT INTO space_long_horizon_agent_goals (agent_id, goal_id, relationship, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(agent_id, goal_id, relationship) DO UPDATE SET updated_at = excluded.updated_at`
        )
        .run(agentId, goalId, relationship, now, now);
    });
    replace();
  }

  listGoals(agentId: string): SpaceLongHorizonAgentGoal[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_long_horizon_agent_goals WHERE agent_id = ? ORDER BY created_at ASC`
      )
      .all(agentId) as Record<string, unknown>[];
    return rows.map(rowToGoalLink);
  }

  listGoalAssignments(goalId: string): SpaceLongHorizonAgentGoal[] {
    const rows = this.db
      .prepare(`SELECT * FROM space_long_horizon_agent_goals WHERE goal_id = ?`)
      .all(goalId) as Record<string, unknown>[];
    return rows.map(rowToGoalLink);
  }

  deleteGoalAssignment(agentId: string, goalId: string): void {
    this.db
      .prepare(`DELETE FROM space_long_horizon_agent_goals WHERE agent_id = ? AND goal_id = ?`)
      .run(agentId, goalId);
  }

  deleteGoalAssignmentByRelationship(
    agentId: string,
    goalId: string,
    relationship: SpaceLongHorizonAgentGoal['relationship']
  ): void {
    this.db
      .prepare(
        `DELETE FROM space_long_horizon_agent_goals WHERE agent_id = ? AND goal_id = ? AND relationship = ?`
      )
      .run(agentId, goalId, relationship);
  }

  getPrimaryGoalOwner(goalId: string, spaceId: string): GoalOwnerResolutionDecision {
    const assignments = this.listGoalAssignments(goalId);
    const candidates = assignments
      .filter((a) => a.relationship === 'owner')
      .map((a) => ({ agentId: a.agentId, relationship: a.relationship, createdAt: a.createdAt }));
    const agentStates: Record<string, GoalOwnerAgentState> = {};
    for (const candidate of candidates) {
      const agent = this.getById(candidate.agentId);
      if (!agent) {
        agentStates[candidate.agentId] = { state: 'missing' };
      } else if (agent.spaceId !== spaceId) {
        agentStates[candidate.agentId] = { state: 'missing' };
      } else {
        agentStates[candidate.agentId] = { state: agent.status };
      }
    }
    const coordinator = this.getCoordinator(spaceId);
    return decideGoalOwnerResolution({
      candidates,
      agentStates,
      coordinatorAgentId: coordinator?.id ?? null,
    });
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

  deleteForgeScopeAssignment(agentId: string, scopeId: string): void {
    this.db
      .prepare(
        `DELETE FROM space_long_horizon_agent_forge_scopes WHERE agent_id = ? AND scope_id = ?`
      )
      .run(agentId, scopeId);
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

  listDueReminders(
    now: number,
    limit = 100,
    excludeIds: string[] = []
  ): SpaceLongHorizonAgentReminder[] {
    const excludeClause =
      excludeIds.length > 0 ? `AND r.id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';
    const rows = this.db
      .prepare(
        `SELECT r.* FROM space_long_horizon_agent_reminders r
           INNER JOIN space_long_horizon_agents a ON a.id = r.agent_id
           INNER JOIN spaces s ON s.id = r.space_id
           WHERE r.status = 'active' AND r.next_run_at IS NOT NULL AND r.next_run_at <= ?
             AND a.status = 'active'
             AND s.status = 'active' AND s.paused = 0 AND s.stopped = 0
             ${excludeClause}
           ORDER BY r.next_run_at ASC
           LIMIT ?`
      )
      .all(now, ...excludeIds, limit) as Record<string, unknown>[];
    return rows.map(rowToReminder);
  }

  advanceReminderAfterFire(
    id: string,
    expectedNextRunAt: number,
    updates: {
      status: SpaceLongHorizonAgentReminder['status'];
      nextRunAt: number | null;
      lastFiredAt: number;
    }
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE space_long_horizon_agent_reminders
            SET status = ?, next_run_at = ?, last_fired_at = ?, updated_at = ?
            WHERE id = ? AND status = 'active' AND next_run_at = ?`
      )
      .run(
        updates.status,
        updates.nextRunAt,
        updates.lastFiredAt,
        Date.now(),
        id,
        expectedNextRunAt
      );
    return result.changes > 0;
  }

  listActiveRemindersWithNullNextRunAt(): SpaceLongHorizonAgentReminder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_long_horizon_agent_reminders
           WHERE status = 'active' AND next_run_at IS NULL`
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToReminder);
  }

  setReminderNextRunAt(id: string, nextRunAt: number): void {
    this.db
      .prepare(
        `UPDATE space_long_horizon_agent_reminders SET next_run_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(nextRunAt, Date.now(), id);
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

  upsertSubscription(
    params: CreateSpaceLongHorizonAgentSubscriptionParams
  ): SpaceLongHorizonAgentEventSubscription {
    this.requireAgentInSpace(params.agentId, params.spaceId);
    const now = Date.now();
    const filterJson = JSON.stringify(params.filter ?? {});
    const existing = this.getSubscriptionByRoute(
      params.spaceId,
      params.agentId,
      params.source,
      params.topic
    );
    if (existing) {
      this.db
        .prepare(
          `UPDATE space_long_horizon_agent_event_subscriptions
             SET filter_json = ?, status = ?, updated_at = ?
             WHERE id = ?`
        )
        .run(filterJson, params.status ?? 'active', now, existing.id);
      return this.getSubscription(existing.id) as SpaceLongHorizonAgentEventSubscription;
    }
    const id = generateUUID();
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
        filterJson,
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

  getSubscriptionByRoute(
    spaceId: string,
    agentId: string,
    source: string,
    topic: string
  ): SpaceLongHorizonAgentEventSubscription | null {
    const row = this.db
      .prepare(
        `SELECT * FROM space_long_horizon_agent_event_subscriptions
           WHERE space_id = ? AND agent_id = ? AND source = ? AND topic = ?
           ORDER BY created_at ASC
           LIMIT 1`
      )
      .get(spaceId, agentId, source, topic) as Record<string, unknown> | undefined;
    return row ? rowToSubscription(row) : null;
  }

  deleteReminder(id: string): void {
    this.db.prepare(`DELETE FROM space_long_horizon_agent_reminders WHERE id = ?`).run(id);
  }

  listSubscriptions(agentId: string): SpaceLongHorizonAgentEventSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_long_horizon_agent_event_subscriptions WHERE agent_id = ? ORDER BY created_at ASC`
      )
      .all(agentId) as Record<string, unknown>[];
    return rows.map(rowToSubscription);
  }

  updateSubscription(
    subscriptionId: string,
    params: UpdateSpaceLongHorizonAgentSubscriptionParams
  ): SpaceLongHorizonAgentEventSubscription | null {
    const existing = this.getSubscription(subscriptionId);
    if (!existing) return null;
    const nextSource = params.source ?? existing.source;
    const nextTopic = params.topic ?? existing.topic;
    const nextFilter = params.filter ?? existing.filter;
    const nextStatus = params.status ?? existing.status;
    this.db
      .prepare(
        `UPDATE space_long_horizon_agent_event_subscriptions
           SET source = ?, topic = ?, filter_json = ?, status = ?, updated_at = ?
           WHERE id = ?`
      )
      .run(
        nextSource,
        nextTopic,
        JSON.stringify(nextFilter),
        nextStatus,
        Date.now(),
        subscriptionId
      );
    return this.getSubscription(subscriptionId);
  }

  deleteSubscription(subscriptionId: string): void {
    this.db
      .prepare(`DELETE FROM space_long_horizon_agent_event_subscriptions WHERE id = ?`)
      .run(subscriptionId);
  }

  listActiveSubscriptionsBySpace(spaceId: string): SpaceLongHorizonAgentEventSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_long_horizon_agent_event_subscriptions
				 WHERE space_id = ? AND status = 'active' ORDER BY created_at ASC`
      )
      .all(spaceId) as Record<string, unknown>[];
    return rows.map(rowToSubscription);
  }

  deleteSubscriptionByRoute(spaceId: string, agentId: string, source: string, topic: string): void {
    this.db
      .prepare(
        `DELETE FROM space_long_horizon_agent_event_subscriptions
           WHERE space_id = ? AND agent_id = ? AND source = ? AND topic = ?`
      )
      .run(spaceId, agentId, source, topic);
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
    model: (row.model as string | null) ?? null,
    thinkingLevel: (row.thinking_level as SpaceLongHorizonAgent['thinkingLevel']) ?? null,
    provider: (row.provider as string | null) ?? null,
    settingSources: row.setting_sources
      ? (JSON.parse(row.setting_sources as string) as SpaceLongHorizonAgent['settingSources'])
      : null,
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
