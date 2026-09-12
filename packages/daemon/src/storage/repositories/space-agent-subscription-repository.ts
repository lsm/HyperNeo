import type {
  CreateSpaceLongHorizonAgentSubscriptionParams,
  SpaceLongHorizonAgentEventSubscription,
  UpdateSpaceLongHorizonAgentSubscriptionParams,
} from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SpaceAgentRepository } from './space-agent-repository.ts';

export class SpaceAgentSubscriptionRepository {
  constructor(
    private db: BunDatabase,
    private agents: Pick<SpaceAgentRepository, 'getById'>
  ) {}

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

  private requireAgentInSpace(agentId: string, spaceId: string): void {
    const agent = this.agents.getById(agentId);
    if (!agent) throw new Error(`Long-horizon agent not found: ${agentId}`);
    if (agent.spaceId !== spaceId) {
      throw new Error(`Long-horizon agent ${agentId} does not belong to space ${spaceId}`);
    }
  }
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
