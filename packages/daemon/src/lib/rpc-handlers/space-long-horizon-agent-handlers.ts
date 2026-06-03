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
} from '@neokai/shared';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository';
import {
  KNOWN_SOURCES,
  validateGlobPattern,
  validateSource,
} from '../external-events/topic-validator';
import { getLongHorizonAgentTemplates } from '../space/agents/long-horizon-agent-templates';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';

function rejectSlashSeparatedGitHubAction(topic: string): never {
  throw new Error(
    `GitHub topic "${topic}" must use dotted entity actions like "pull_request/42.closed"`
  );
}

function splitDottedGitHubResource(segment: string): { resource: string; action: string } | null {
  const dotIndex = segment.indexOf('.');
  if (dotIndex <= 0 || dotIndex === segment.length - 1) return null;
  return { resource: segment.slice(0, dotIndex), action: segment.slice(dotIndex + 1) };
}

function composeGitHubSubscriptionPattern(source: string, topic: string): string {
  const segments = topic.split('/');
  if (segments[0] === source && segments.length === 6) rejectSlashSeparatedGitHubAction(topic);
  if (segments[0] === source && segments.length === 5) return topic;
  if (segments[0] === source && segments.length === 4) {
    const dotted = splitDottedGitHubResource(segments[3] ?? '');
    if (dotted)
      return `${source}/${segments[1]}/${segments[2]}/${dotted.resource}/*.${dotted.action}`;
    return `${topic}/*`;
  }
  if (segments[0] === source && segments.length === 2) {
    const resource = segments[1] ?? '';
    const dotted = splitDottedGitHubResource(resource);
    if (dotted) return `${source}/*/*/${dotted.resource}/*.${dotted.action}`;
    return `${source}/*/*/${resource}/*`;
  }
  if (segments.length === 5) rejectSlashSeparatedGitHubAction(topic);
  if (segments.length === 4) return `${source}/${topic}`;
  if (segments.length === 3) {
    const dotted = splitDottedGitHubResource(segments[2] ?? '');
    if (dotted)
      return `${source}/${segments[0]}/${segments[1]}/${dotted.resource}/*.${dotted.action}`;
    return `${source}/${topic}/*`;
  }
  if (segments.length === 1) {
    const dotted = splitDottedGitHubResource(topic);
    if (dotted) return `${source}/*/*/${dotted.resource}/*.${dotted.action}`;
    return `${source}/*/*/${topic}/*`;
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
      segments.length === 4 || (segments[0] === trimmedSource && segments.length === 4);
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
        composeLongHorizonSubscriptionPattern(subscription.source, subscription.topic) === pattern
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
  runtimeService?: Pick<
    SpaceRuntimeService,
    | 'refreshLongHorizonAgentSubscriptions'
    | 'removeLongHorizonAgentSubscriptions'
    | 'refreshLongHorizonSubscription'
    | 'removeLongHorizonSubscription'
  >
): void {
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
    };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.handle) throw new Error('handle is required');
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);
    const agent = repo.create({
      id: params.id,
      spaceId: params.spaceId,
      handle: params.handle,
      displayName: params.displayName,
      templateKey: params.templateKey,
      instructions: params.instructions,
      autonomyLevel: params.autonomyLevel as 1 | 2 | 3 | 4 | 5 | null | undefined,
      model: params.model,
      thinkingLevel: params.thinkingLevel as SpaceLongHorizonAgent['thinkingLevel'],
      provider: params.provider,
      settingSources: params.settingSources,
      toolPermissions: params.toolPermissions,
    });
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
    if (params.spaceId) {
      const existing = repo.getById(params.agentId);
      if (!existing) throw new Error(`Agent not found: ${params.agentId}`);
      if (existing.spaceId !== params.spaceId)
        throw new Error(`Agent ${params.agentId} does not belong to space ${params.spaceId}`);
    }
    const agent = repo.update(params.agentId, {
      handle: params.handle,
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
    const reminder = repo.createReminder({
      spaceId: params.spaceId,
      agentId: params.agentId,
      title: params.title,
      body: params.body,
      triggerType: params.triggerType,
      runAt: params.runAt,
      cronExpression: params.cronExpression,
      timezone: params.timezone,
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
