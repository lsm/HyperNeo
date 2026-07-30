/**
 * RPC handlers for long-horizon agents.
 *
 * - spaceLongHorizonAgent.listBuiltInTemplates
 * - spaceLongHorizonAgent.list
 * - spaceLongHorizonAgent.create
 * - spaceLongHorizonAgent.update
 * - spaceLongHorizonAgent.delete
 * - spaceLongHorizonAgent.listReminders
 * - spaceLongHorizonAgent.createReminder
 * - spaceLongHorizonAgent.deleteReminder
 */

import type {
  MessageHub,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentEventSubscriptionStatus,
} from '@hyperneo/shared';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import {
  KNOWN_SOURCES,
  validateGlobPattern,
  validateSource,
} from '../external-events/topic-validator';
import { getLongHorizonAgentTemplates } from '../space/agents/long-horizon-agent-templates';
import { getNextRunAt, isValidCronExpression } from '../space/schedule/cron-utils';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit, validateSlug } from '../space/slug';

function rejectSlashSeparatedGitHubAction(topic: string): never {
  throw new Error(
    `GitHub topic "${topic}" must use dotted entity actions like "pull_request/42.closed"`
  );
}

const GITHUB_EVENT_RESOURCES = new Set(['pull_request']);

function isGitHubEventResource(resource: string): boolean {
  return GITHUB_EVENT_RESOURCES.has(resource);
}

function ensureGitHubEventResource(topic: string, resource: string): void {
  if (resource === '*' || isGitHubEventResource(resource)) return;
  throw new Error(
    `GitHub topic "${topic}" uses unsupported resource "${resource}"; supported resources: pull_request`
  );
}

function splitDottedGitHubResource(segment: string): { resource: string; action: string } | null {
  const dotIndex = segment.indexOf('.');
  if (dotIndex <= 0 || dotIndex === segment.length - 1) return null;
  return { resource: segment.slice(0, dotIndex), action: segment.slice(dotIndex + 1) };
}

function rejectGitHubEntityPatternWithoutAction(topic: string): never {
  throw new Error(
    `GitHub topic "${topic}" must use dotted entity actions like "pull_request/42.opened"`
  );
}

function ensureGitHubEntityAction(topic: string, entityAction: string): void {
  if (entityAction === '*') return;
  const dotIndex = entityAction.indexOf('.');
  if (
    dotIndex <= 0 ||
    dotIndex === entityAction.length - 1 ||
    entityAction.indexOf('.', dotIndex + 1) !== -1
  ) {
    rejectGitHubEntityPatternWithoutAction(topic);
  }
}

function composeGitHubSubscriptionPattern(source: string, topic: string): string {
  const segments = topic.split('/');
  const isSourcePrefixed = segments[0] === source;
  const resourceSegments = isSourcePrefixed ? segments.slice(1) : segments;
  const firstResourceSegment = resourceSegments[0] ?? '';
  const firstDottedResource = splitDottedGitHubResource(firstResourceSegment);

  if (isSourcePrefixed && segments.length === 6) rejectSlashSeparatedGitHubAction(topic);
  if (!isSourcePrefixed && segments.length === 5) rejectSlashSeparatedGitHubAction(topic);
  if (resourceSegments.length > 4) {
    throw new Error(
      `GitHub topic "${topic}" must match supported shape "owner/repo/pull_request/<id>.<action>"`
    );
  }
  if (isSourcePrefixed && segments.length === 5) {
    ensureGitHubEventResource(topic, segments[3] ?? '');
    ensureGitHubEntityAction(topic, segments[4] ?? '');
    return topic;
  }
  if (resourceSegments.length === 4) {
    ensureGitHubEventResource(topic, resourceSegments[2] ?? '');
    ensureGitHubEntityAction(topic, resourceSegments[3] ?? '');
    return `${source}/${resourceSegments.join('/')}`;
  }
  if (isSourcePrefixed && resourceSegments.length === 3) {
    const [first, second, third] = resourceSegments;
    if (isGitHubEventResource(first ?? '')) {
      ensureGitHubEntityAction(topic, `${second}.${third}`);
      return `${source}/*/*/${first}/${second}.${third}`;
    }
    if (isGitHubEventResource(second ?? '')) {
      ensureGitHubEntityAction(topic, third ?? '');
      return `${source}/${source}/${first}/${second}/${third}`;
    }
  }
  if (resourceSegments.length === 3) {
    const [owner, repo, resource] = resourceSegments;
    const dotted = splitDottedGitHubResource(resource ?? '');
    if (dotted) {
      ensureGitHubEventResource(topic, dotted.resource);
      return `${source}/${owner}/${repo}/${dotted.resource}/*.${dotted.action}`;
    }
    if (!isGitHubEventResource(resource ?? '')) rejectSlashSeparatedGitHubAction(topic);
    return `${source}/${owner}/${repo}/${resource}/*`;
  }
  if (resourceSegments.length === 2) {
    const [resource, entityAction] = resourceSegments;
    if (!isGitHubEventResource(resource ?? '')) {
      const dottedEntityAction = splitDottedGitHubResource(entityAction ?? '');
      if (isSourcePrefixed && dottedEntityAction) {
        ensureGitHubEventResource(topic, dottedEntityAction.resource);
        return `${source}/${source}/${resource}/${dottedEntityAction.resource}/*.${dottedEntityAction.action}`;
      }
      if (isSourcePrefixed && isGitHubEventResource(entityAction ?? '')) {
        return `${source}/${source}/${resource}/${entityAction}/*`;
      }
      throw new Error(
        `GitHub topic "${topic}" must include a resource segment like "owner/repo/pull_request"`
      );
    }
    ensureGitHubEntityAction(topic, entityAction ?? '');
    return `${source}/*/*/${resource}/${entityAction}`;
  }
  if (resourceSegments.length === 1) {
    if (firstDottedResource) {
      ensureGitHubEventResource(topic, firstDottedResource.resource);
      return `${source}/*/*/${firstDottedResource.resource}/*.${firstDottedResource.action}`;
    }
    ensureGitHubEventResource(topic, firstResourceSegment);
    return `${source}/*/*/${firstResourceSegment}/*`;
  }
  return `${source}/*/*/${topic}`;
}

function composeLongHorizonSubscriptionPattern(source: string, topic: string): string {
  const trimmedSource = source.trim();
  const trimmedTopic = topic.trim();
  if (!trimmedSource) return trimmedTopic;
  const topicSource = trimmedTopic.split('/')[0] ?? '';
  if (trimmedSource === 'github') {
    const segments = trimmedTopic.split('/');
    const isOwnerRepoShorthand =
      segments.length === 3 ||
      segments.length === 4 ||
      (segments[0] === trimmedSource && (segments.length === 3 || segments.length === 4));
    if (isOwnerRepoShorthand || topicSource === trimmedSource) {
      return composeGitHubSubscriptionPattern(trimmedSource, trimmedTopic);
    }
  } else if (topicSource === trimmedSource) {
    return trimmedTopic;
  }
  const normalizedTopicSource = topicSource.toLowerCase();
  if (
    normalizedTopicSource === trimmedSource.toLowerCase() ||
    KNOWN_SOURCES.has(normalizedTopicSource)
  ) {
    throw new Error(`Topic source "${topicSource}" does not match source "${trimmedSource}"`);
  }
  if (trimmedSource === 'github')
    return composeGitHubSubscriptionPattern(trimmedSource, trimmedTopic);
  return `${trimmedSource}/${trimmedTopic}`;
}

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
    // Seed coordinator for spaces that predate the long-horizon agents feature.
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
    // Seed nextRunAt so the reminder-fire scanner can select the row — its
    // due-query filters on `next_run_at IS NOT NULL`. Without this the column
    // defaults to NULL and the reminder never fires.
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
