import type {
  SpaceLongHorizonAgentEventSubscription,
  SpaceLongHorizonAgentGoal,
  SpaceLongHorizonAgentReminder,
} from '@hyperneo/shared';

export function rowToGoalLink(row: Record<string, unknown>): SpaceLongHorizonAgentGoal {
  return {
    agentId: row.agent_id as string,
    goalId: row.goal_id as string,
    relationship: row.relationship as SpaceLongHorizonAgentGoal['relationship'],
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function rowToReminder(row: Record<string, unknown>): SpaceLongHorizonAgentReminder {
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

export function rowToSubscription(
  row: Record<string, unknown>
): SpaceLongHorizonAgentEventSubscription {
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

export function parseObject(value: unknown): Record<string, unknown> {
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
