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
import { validateGlobPattern, validateSource } from '../external-events/topic-validator';
import { getLongHorizonAgentTemplates } from '../space/agents/long-horizon-agent-templates';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';

function composeLongHorizonSubscriptionPattern(source: string, topic: string): string {
  const trimmedSource = source.trim();
  const trimmedTopic = topic.trim();
  if (!trimmedSource || trimmedTopic.startsWith(`${trimmedSource}/`)) return trimmedTopic;
  if (trimmedSource === 'github') {
    const segments = trimmedTopic.split('/');
    if (trimmedTopic.startsWith('*/*/') || segments.length >= 4)
      return `${trimmedSource}/${trimmedTopic}`;
    return `${trimmedSource}/*/*/${trimmedTopic}`;
  }
  return `${trimmedSource}/${trimmedTopic}`;
}

function validateLongHorizonSubscriptionPattern(source: string, topic: string): void {
  const sourceValidation = validateSource(source);
  if (!sourceValidation.valid) throw new Error(sourceValidation.reason ?? 'invalid source');
  const validation = validateGlobPattern(composeLongHorizonSubscriptionPattern(source, topic));
  if (!validation.valid) throw new Error(validation.reason ?? 'invalid pattern');
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
      spaceId: string;
      handle: string;
      displayName?: string;
      templateKey?: string | null;
      instructions?: string;
      autonomyLevel?: number | null;
      model?: string | null;
      thinkingLevel?: string | null;
    };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.handle) throw new Error('handle is required');
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);
    const agent = repo.create({
      spaceId: params.spaceId,
      handle: params.handle,
      displayName: params.displayName,
      templateKey: params.templateKey,
      instructions: params.instructions,
      autonomyLevel: params.autonomyLevel as 1 | 2 | 3 | 4 | 5 | null | undefined,
      model: params.model,
      thinkingLevel: params.thinkingLevel as SpaceLongHorizonAgent['thinkingLevel'],
    });
    return { agent };
  });

  messageHub.onRequest('spaceLongHorizonAgent.update', async (data) => {
    const params = data as {
      agentId: string;
      spaceId?: string;
      displayName?: string;
      instructions?: string;
      autonomyLevel?: number | null;
      model?: string | null;
      thinkingLevel?: string | null;
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
      displayName: params.displayName,
      instructions: params.instructions,
      autonomyLevel: params.autonomyLevel as 1 | 2 | 3 | 4 | 5 | null | undefined,
      model: params.model,
      thinkingLevel: params.thinkingLevel as SpaceLongHorizonAgent['thinkingLevel'],
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
    validateLongHorizonSubscriptionPattern(source, topic);
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
    validateLongHorizonSubscriptionPattern(source, topic);
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
