import type {
  MessageHub,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentEventSubscriptionStatus,
} from '@hyperneo/shared';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { validateGlobPattern, validateSource } from '../external-events/topic-validator';
import { composeLongHorizonSubscriptionPattern } from '../external-events/long-horizon-subscription-pattern';
import { getLongHorizonAgentTemplates } from '../space/agents/long-horizon-agent-templates';
import { getNextRunAt, isValidCronExpression } from '../space/schedule/cron-utils';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit, validateSlug } from '../space/slug';

function validateLongHorizonSubscriptionPattern(
  source: string,
  topic: string,
  options: { allowWildcardSource?: boolean } = {}
): string {
  if (source !== '*' || !options.allowWildcardSource) {
    const sourceValidation = validateSource(source);
    if (!sourceValidation.valid) throw new Error(sourceValidation.reason ?? 'invalid source');
  }
  const pattern = composeLongHorizonSubscriptionPattern(source, topic);
  const validation = validateGlobPattern(pattern);
  if (!validation.valid) throw new Error(validation.reason ?? 'invalid pattern');
  return pattern;
}

function resolveLongHorizonAgentCreateHandle(
  repo: SpaceLongHorizonAgentRepository,
  spaceAgentManager: SpaceAgentManager | undefined,
  spaceId: string,
  agentId: string,
  handle: string
): string {
  const normalized = slugifyWithinLimit(
    handle,
    reservedLongHorizonHandles(repo, spaceAgentManager, spaceId, agentId)
  );
  if (normalized !== handle) return normalized;

  const handleError = validateLongHorizonAgentHandle(
    repo,
    spaceAgentManager,
    spaceId,
    normalized,
    agentId
  );
  if (handleError) throw new Error(handleError);
  return normalized;
}

function validateLongHorizonAgentUpdateHandle(
  repo: SpaceLongHorizonAgentRepository,
  spaceAgentManager: SpaceAgentManager | undefined,
  spaceId: string,
  agentId: string,
  handle: string
): string {
  const trimmed = handle.trim();
  const handleError = validateLongHorizonAgentHandle(
    repo,
    spaceAgentManager,
    spaceId,
    trimmed,
    agentId,
    handle
  );
  if (handleError) throw new Error(handleError);
  return trimmed;
}

function validateLongHorizonAgentHandle(
  repo: SpaceLongHorizonAgentRepository,
  spaceAgentManager: SpaceAgentManager | undefined,
  spaceId: string,
  handle: string,
  excludeId: string,
  rawHandle = handle
): string | null {
  if (rawHandle !== handle) return 'Agent handle must not have leading or trailing whitespace';
  const slugError = validateSlug(handle);
  if (slugError) return `Invalid agent handle: ${slugError}`;
  if (
    RESERVED_SPACE_AGENT_HANDLES.includes(handle as (typeof RESERVED_SPACE_AGENT_HANDLES)[number])
  ) {
    return `Agent handle "${handle}" is reserved`;
  }
  const longHorizonOwner = repo.getByHandle(spaceId, handle);
  if (longHorizonOwner && longHorizonOwner.id !== excludeId) {
    return `An agent with handle "${handle}" already exists in this Space`;
  }
  const workerOwner = spaceAgentManager
    ?.listBySpaceId(spaceId)
    .find((agent) => agent.handle === handle && agent.id !== excludeId);
  if (workerOwner) return `An agent with handle "${handle}" already exists in this Space`;
  return null;
}

function reservedLongHorizonHandles(
  repo: SpaceLongHorizonAgentRepository,
  spaceAgentManager: SpaceAgentManager | undefined,
  spaceId: string,
  excludeId: string
): string[] {
  return [
    ...repo
      .listBySpaceId(spaceId)
      .filter((agent) => agent.id !== excludeId)
      .map((agent) => agent.handle),
    ...(spaceAgentManager
      ?.listBySpaceId(spaceId)
      .filter((agent) => agent.id !== excludeId)
      .map((agent) => agent.handle) ?? []),
    ...RESERVED_SPACE_AGENT_HANDLES,
  ];
}

function assertNoDuplicateLongHorizonSubscriptionPattern(
  repo: SpaceLongHorizonAgentRepository,
  agentId: string,
  source: string,
  topic: string,
  pattern: string,
  currentSubscriptionId?: string
): void {
  const duplicate = repo.listSubscriptions(agentId).find((subscription) => {
    if (subscription.id === currentSubscriptionId) return false;
    try {
      return (
        composeLongHorizonSubscriptionPattern(
          subscription.source,
          subscription.topic
        ).toLowerCase() === pattern.toLowerCase()
      );
    } catch {
      return false;
    }
  });
  if (duplicate) {
    throw new Error(
      `Subscription pattern duplicates existing subscription ${duplicate.id}: ${pattern}`
    );
  }
}

export function setupSpaceLongHorizonAgentHandlers(
  messageHub: MessageHub,
  spaceManager: SpaceManager,
  repo: SpaceLongHorizonAgentRepository,
  spaceAgentManager?: SpaceAgentManager,
  runtimeService?: Pick<
    SpaceRuntimeService,
    | 'refreshLongHorizonAgentSubscriptions'
    | 'removeLongHorizonAgentSubscriptions'
    | 'refreshLongHorizonSubscription'
    | 'removeLongHorizonSubscription'
    | 'clearLongTermAgentSessionProvider'
  >,
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>
): void {
  const publishAgentCreated = async (agent: SpaceLongHorizonAgent): Promise<void> => {
    await internalEventBus
      ?.publish('spaceLongHorizonAgent.created', {
        sessionId: `space:${agent.spaceId}`,
        spaceId: agent.spaceId,
        agent,
      })
      .catch(() => {});
  };

  const publishAgentUpdated = async (agent: SpaceLongHorizonAgent): Promise<void> => {
    await internalEventBus
      ?.publish('spaceLongHorizonAgent.updated', {
        sessionId: `space:${agent.spaceId}`,
        spaceId: agent.spaceId,
        agent,
      })
      .catch(() => {});
  };

  const publishAgentDeleted = async (spaceId: string, agentId: string): Promise<void> => {
    await internalEventBus
      ?.publish('spaceLongHorizonAgent.deleted', {
        sessionId: `space:${spaceId}`,
        spaceId,
        agentId,
      })
      .catch(() => {});
  };

  messageHub.onRequest('spaceLongHorizonAgent.listBuiltInTemplates', async (data) => {
    const params = data as { spaceId: string };
    if (!params.spaceId) throw new Error('spaceId is required');
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);
    return { templates: getLongHorizonAgentTemplates() };
  });

  messageHub.onRequest('spaceLongHorizonAgent.list', async (data) => {
    const params = data as { spaceId: string };
    if (!params.spaceId) throw new Error('spaceId is required');
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);
    repo.ensureCoordinator(params.spaceId);
    return { agents: repo.listBySpaceId(params.spaceId) };
  });

  messageHub.onRequest('spaceLongHorizonAgent.create', async (data) => {
    const params = data as {
      id?: string;
      spaceId: string;
      handle: string;
      displayName?: string;
      templateKey?: string | null;
      instructions?: string;
      autonomyLevel?: number | null;
      model?: string | null;
      thinkingLevel?: string | null;
      provider?: string | null;
      settingSources?: SpaceLongHorizonAgent['settingSources'];
      toolPermissions?: Record<string, unknown>;
      status?: string;
    };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.handle) throw new Error('handle is required');
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);
    const handle = resolveLongHorizonAgentCreateHandle(
      repo,
      spaceAgentManager,
      params.spaceId,
      params.id ?? '',
      params.handle
    );
    const agent = repo.create({
      id: params.id,
      spaceId: params.spaceId,
      handle,
      displayName: params.displayName,
      templateKey: params.templateKey,
      instructions: params.instructions,
      autonomyLevel: params.autonomyLevel as 1 | 2 | 3 | 4 | 5 | null | undefined,
      model: params.model,
      thinkingLevel: params.thinkingLevel as SpaceLongHorizonAgent['thinkingLevel'],
      provider: params.provider,
      settingSources: params.settingSources,
      toolPermissions: params.toolPermissions,
      status: params.status as 'active' | 'paused' | 'disabled' | 'archived' | undefined,
    });
    await publishAgentCreated(agent);
    return { agent };
  });

  messageHub.onRequest('spaceLongHorizonAgent.update', async (data) => {
    const params = data as {
      agentId: string;
      spaceId?: string;
      handle?: string;
      displayName?: string;
      instructions?: string;
      autonomyLevel?: number | null;
      model?: string | null;
      thinkingLevel?: string | null;
      provider?: string | null;
      settingSources?: SpaceLongHorizonAgent['settingSources'];
      toolPermissions?: Record<string, unknown> | null;
      status?: string;
    };
    if (!params.agentId) throw new Error('agentId is required');
    const existing = repo.getById(params.agentId);
    if (!existing) throw new Error(`Agent not found: ${params.agentId}`);
    if (params.spaceId && existing.spaceId !== params.spaceId)
      throw new Error(`Agent ${params.agentId} does not belong to space ${params.spaceId}`);
    const handle =
      params.handle === undefined
        ? undefined
        : validateLongHorizonAgentUpdateHandle(
            repo,
            spaceAgentManager,
            existing.spaceId,
            params.agentId,
            params.handle
          );
    const agent = repo.update(params.agentId, {
      handle,
      displayName: params.displayName,
      instructions: params.instructions,
      autonomyLevel: params.autonomyLevel as 1 | 2 | 3 | 4 | 5 | null | undefined,
      model: params.model,
      thinkingLevel: params.thinkingLevel as SpaceLongHorizonAgent['thinkingLevel'],
      provider: params.provider,
      settingSources: params.settingSources,
      toolPermissions: params.toolPermissions,
      status: params.status as 'active' | 'paused' | 'disabled' | 'archived' | undefined,
    });
    if (!agent) throw new Error(`Agent not found: ${params.agentId}`);
    if (params.provider === null) {
      await runtimeService?.clearLongTermAgentSessionProvider(agent.spaceId, agent.id);
    }
    if (runtimeService) {
      const refresh = runtimeService.refreshLongHorizonAgentSubscriptions(agent.spaceId, agent.id);
      if (!refresh.success) throw new Error(refresh.error ?? 'Failed to refresh subscriptions');
    }
    await publishAgentUpdated(agent);
    return { agent };
  });

  messageHub.onRequest('spaceLongHorizonAgent.delete', async (data) => {
    const params = data as { agentId: string; spaceId?: string };
    if (!params.agentId) throw new Error('agentId is required');
    const existing = repo.getById(params.agentId);
    if (!existing) throw new Error(`Agent not found: ${params.agentId}`);
    if (params.spaceId && existing.spaceId !== params.spaceId)
      throw new Error(`Agent ${params.agentId} does not belong to space ${params.spaceId}`);
    runtimeService?.removeLongHorizonAgentSubscriptions(existing.spaceId, existing.id);
    repo.delete(params.agentId);
    await publishAgentDeleted(existing.spaceId, existing.id);
    return { success: true };
  });

  messageHub.onRequest('spaceLongHorizonAgent.listReminders', async (data) => {
    const params = data as { agentId: string };
    if (!params.agentId) throw new Error('agentId is required');
    return { reminders: repo.listReminders(params.agentId) };
  });

  messageHub.onRequest('spaceLongHorizonAgent.listReminderCounts', async (data) => {
    const params = data as { agentIds: string[] };
    if (!Array.isArray(params.agentIds)) throw new Error('agentIds is required');
    const counts: Record<string, number> = {};
    for (const agentId of params.agentIds) {
      const reminders = repo.listReminders(agentId);
      counts[agentId] = reminders.filter((r) => r.status === 'active').length;
    }
    return { counts };
  });

  messageHub.onRequest('spaceLongHorizonAgent.createReminder', async (data) => {
    const params = data as {
      spaceId: string;
      agentId: string;
      title: string;
      body?: string;
      triggerType: 'at' | 'cron';
      runAt?: number | null;
      cronExpression?: string | null;
      timezone?: string;
    };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.agentId) throw new Error('agentId is required');
    if (!params.title) throw new Error('title is required');
    if (!params.triggerType) throw new Error('triggerType is required');
    let nextRunAt: number | null = null;
    if (params.triggerType === 'at') {
      if (typeof params.runAt !== 'number') {
        throw new Error('runAt is required for triggerType "at"');
      }
      nextRunAt = params.runAt;
    } else {
      const expression = params.cronExpression;
      if (!expression) throw new Error('cronExpression is required for triggerType "cron"');
      if (!isValidCronExpression(expression)) {
        throw new Error(`Invalid cron expression: ${expression}`);
      }
      const timezone = params.timezone ?? 'UTC';
      const firstRunAt = getNextRunAt(expression, timezone);
      if (firstRunAt === null) {
        throw new Error(`Invalid timezone or cron expression for reminder: ${timezone}`);
      }
      nextRunAt = firstRunAt;
    }
    const reminder = repo.createReminder({
      spaceId: params.spaceId,
      agentId: params.agentId,
      title: params.title,
      body: params.body,
      triggerType: params.triggerType,
      runAt: params.runAt,
      cronExpression: params.cronExpression,
      timezone: params.timezone,
      nextRunAt,
    });
    return { reminder };
  });

  messageHub.onRequest('spaceLongHorizonAgent.deleteReminder', async (data) => {
    const params = data as { reminderId: string };
    if (!params.reminderId) throw new Error('reminderId is required');
    const existing = repo.getReminder(params.reminderId);
    if (!existing) throw new Error(`Reminder not found: ${params.reminderId}`);
    repo.deleteReminder(params.reminderId);
    return { success: true };
  });

  messageHub.onRequest('spaceLongHorizonAgent.listSubscriptions', async (data) => {
    const params = data as { agentId: string; spaceId?: string };
    if (!params.agentId) throw new Error('agentId is required');
    const agent = repo.getById(params.agentId);
    if (!agent) throw new Error(`Agent not found: ${params.agentId}`);
    if (params.spaceId && agent.spaceId !== params.spaceId) {
      throw new Error(`Agent ${params.agentId} does not belong to space ${params.spaceId}`);
    }
    return { subscriptions: repo.listSubscriptions(params.agentId) };
  });

  messageHub.onRequest('spaceLongHorizonAgent.createSubscription', async (data) => {
    const params = data as {
      spaceId: string;
      agentId: string;
      source: string;
      topic: string;
      filter?: Record<string, unknown>;
      status?: SpaceLongHorizonAgentEventSubscriptionStatus;
    };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.agentId) throw new Error('agentId is required');
    if (!params.source?.trim()) throw new Error('source is required');
    if (!params.topic?.trim()) throw new Error('topic is required');
    const source = params.source.trim();
    const topic = params.topic.trim();
    const pattern = validateLongHorizonSubscriptionPattern(source, topic);
    assertNoDuplicateLongHorizonSubscriptionPattern(repo, params.agentId, source, topic, pattern);
    const subscription = repo.createSubscription({
      spaceId: params.spaceId,
      agentId: params.agentId,
      source,
      topic,
      filter: params.filter,
      status: params.status,
    });
    const refresh = runtimeService?.refreshLongHorizonSubscription(
      subscription.spaceId,
      subscription.id
    );
    if (refresh && !refresh.success)
      throw new Error(refresh.error ?? 'Failed to refresh subscription');
    return { subscription };
  });

  messageHub.onRequest('spaceLongHorizonAgent.updateSubscription', async (data) => {
    const params = data as {
      subscriptionId: string;
      spaceId?: string;
      source?: string;
      topic?: string;
      filter?: Record<string, unknown>;
      status?: SpaceLongHorizonAgentEventSubscriptionStatus;
    };
    if (!params.subscriptionId) throw new Error('subscriptionId is required');
    if (params.source !== undefined && !params.source.trim()) throw new Error('source is required');
    if (params.topic !== undefined && !params.topic.trim()) throw new Error('topic is required');
    const existing = repo.getSubscription(params.subscriptionId);
    if (!existing) throw new Error(`Subscription not found: ${params.subscriptionId}`);
    if (params.spaceId && existing.spaceId !== params.spaceId) {
      throw new Error(
        `Subscription ${params.subscriptionId} does not belong to space ${params.spaceId}`
      );
    }
    const source = params.source?.trim() ?? existing.source;
    const topic = params.topic?.trim() ?? existing.topic;
    const pattern = validateLongHorizonSubscriptionPattern(source, topic, {
      allowWildcardSource: params.source === undefined && params.topic === undefined,
    });
    assertNoDuplicateLongHorizonSubscriptionPattern(
      repo,
      existing.agentId,
      source,
      topic,
      pattern,
      existing.id
    );
    const subscription = repo.updateSubscription(params.subscriptionId, {
      ...(params.source !== undefined ? { source } : {}),
      ...(params.topic !== undefined ? { topic } : {}),
      ...(params.filter !== undefined ? { filter: params.filter } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
    });
    if (!subscription) throw new Error(`Subscription not found: ${params.subscriptionId}`);
    const refresh = runtimeService?.refreshLongHorizonSubscription(
      subscription.spaceId,
      subscription.id
    );
    if (refresh && !refresh.success)
      throw new Error(refresh.error ?? 'Failed to refresh subscription');
    return { subscription };
  });

  messageHub.onRequest('spaceLongHorizonAgent.deleteSubscription', async (data) => {
    const params = data as { subscriptionId: string; spaceId?: string };
    if (!params.subscriptionId) throw new Error('subscriptionId is required');
    const existing = repo.getSubscription(params.subscriptionId);
    if (!existing) throw new Error(`Subscription not found: ${params.subscriptionId}`);
    if (params.spaceId && existing.spaceId !== params.spaceId) {
      throw new Error(
        `Subscription ${params.subscriptionId} does not belong to space ${params.spaceId}`
      );
    }
    runtimeService?.removeLongHorizonSubscription(existing.spaceId, existing.id);
    repo.deleteSubscription(params.subscriptionId);
    return { success: true };
  });
}
