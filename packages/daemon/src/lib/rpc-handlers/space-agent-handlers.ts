import type {
  CreateSpaceAgentTemplateParams,
  MessageHub,
  SpaceLongHorizonAgentEventSubscriptionStatus,
  UpdateSpaceAgentTemplateParams,
} from '@hyperneo/shared';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import { isReservedAgentHandle } from '../space/agent-handle.ts';
import { composeLongHorizonSubscriptionPattern } from '../external-events/long-horizon-subscription-pattern.ts';
import { validateGlobPattern, validateSource } from '../external-events/topic-validator.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { getLongHorizonAgentTemplates } from '../space/agents/long-horizon-agent-templates.ts';
import type { OwnedAgentLookup } from '../space/agents/unified-agent-events.ts';
import { SpaceAgentTemplateManager } from '../space/managers/space-agent-template-manager.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import { getNextRunAt, isValidCronExpression } from '../space/schedule/cron-utils.ts';

type UnifiedSpaceAgentRuntimeService = Pick<
  SpaceRuntimeService,
  | 'refreshLongHorizonAgentSubscriptions'
  | 'removeLongHorizonAgentSubscriptions'
  | 'refreshLongHorizonSubscription'
  | 'removeLongHorizonSubscription'
  | 'clearLongTermAgentSessionProvider'
>;

interface UnifiedSpaceAgentMethodDeps {
  spaceManager: SpaceManager;
  repo: SpaceLongHorizonAgentRepository;
  templateManager?: SpaceAgentTemplateManager;
  ownedAgents?: OwnedAgentLookup;
  runtimeService?: UnifiedSpaceAgentRuntimeService;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
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

export function registerUnifiedSpaceAgentMethods(
  messageHub: MessageHub,
  deps: UnifiedSpaceAgentMethodDeps
): void {
  const method = (name: string): string => `spaceAgent.${name}`;
  const templateManager = deps.templateManager;

  messageHub.onRequest(method('listBuiltInTemplates'), async (data) => {
    const params = data as { spaceId: string };
    if (!params.spaceId) throw new Error('spaceId is required');
    const space = await deps.spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);
    return {
      templates: getLongHorizonAgentTemplates().filter(
        (template) => !isReservedAgentHandle(template.handle)
      ),
    };
  });

  const requireTemplateSpace = async (spaceId: string | undefined): Promise<string> => {
    if (!spaceId) throw new Error('spaceId is required');
    const space = await deps.spaceManager.getSpace(spaceId);
    if (!space) throw new Error(`Space not found: ${spaceId}`);
    return spaceId;
  };

  if (templateManager) {
    messageHub.onRequest(method('listTemplates'), async (data) => {
      const spaceId = await requireTemplateSpace((data as { spaceId?: string }).spaceId);
      return { templates: templateManager.listIn(spaceId) };
    });

    messageHub.onRequest(method('createTemplate'), async (data) => {
      const params = data as { spaceId?: string } & CreateSpaceAgentTemplateParams;
      const spaceId = await requireTemplateSpace(params.spaceId);
      if (!params.key) throw new Error('key is required');
      if (!params.handle) throw new Error('handle is required');
      const result = await templateManager.createIn(spaceId, params);
      if (!result.ok) throw new Error(result.error);
      return { template: result.value };
    });

    messageHub.onRequest(method('updateTemplate'), async (data) => {
      const params = data as { spaceId?: string; key: string } & UpdateSpaceAgentTemplateParams;
      const spaceId = await requireTemplateSpace(params.spaceId);
      if (!params.key) throw new Error('key is required');
      const { key, spaceId: _spaceId, ...updates } = params;
      const result = await templateManager.updateIn(spaceId, key, updates);
      if (!result.ok) throw new Error(result.error);
      return { template: result.value };
    });

    messageHub.onRequest(method('deleteTemplate'), async (data) => {
      const params = data as { spaceId?: string; key: string; expectedVersion?: number };
      const spaceId = await requireTemplateSpace(params.spaceId);
      if (!params.key) throw new Error('key is required');
      const result = templateManager.deleteIn(spaceId, params.key, params.expectedVersion);
      if (!result.ok) throw new Error(result.error);
      return { success: true };
    });
  }

  messageHub.onRequest(method('listReminderCounts'), async (data) => {
    const params = data as { agentIds: string[] };
    if (!Array.isArray(params.agentIds)) throw new Error('agentIds is required');
    const counts: Record<string, number> = {};
    for (const agentId of params.agentIds) {
      const reminders = deps.repo.listReminders(agentId);
      counts[agentId] = reminders.filter((r) => r.status === 'active').length;
    }
    return { counts };
  });

  messageHub.onRequest(method('createReminder'), async (data) => {
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
    const reminder = deps.repo.createReminder({
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

  messageHub.onRequest(method('deleteReminder'), async (data) => {
    const params = data as { reminderId: string };
    if (!params.reminderId) throw new Error('reminderId is required');
    const existing = deps.repo.getReminder(params.reminderId);
    if (!existing) throw new Error(`Reminder not found: ${params.reminderId}`);
    deps.repo.deleteReminder(params.reminderId);
    return { success: true };
  });

  messageHub.onRequest(method('listSubscriptions'), async (data) => {
    const params = data as { agentId: string; spaceId?: string };
    if (!params.agentId) throw new Error('agentId is required');
    const agent = deps.repo.getById(params.agentId);
    if (!agent) throw new Error(`Agent not found: ${params.agentId}`);
    if (params.spaceId && agent.spaceId !== params.spaceId) {
      throw new Error(`Agent ${params.agentId} does not belong to space ${params.spaceId}`);
    }
    return { subscriptions: deps.repo.listSubscriptions(params.agentId) };
  });

  messageHub.onRequest(method('createSubscription'), async (data) => {
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
    assertNoDuplicateLongHorizonSubscriptionPattern(
      deps.repo,
      params.agentId,
      source,
      topic,
      pattern
    );
    const subscription = deps.repo.createSubscription({
      spaceId: params.spaceId,
      agentId: params.agentId,
      source,
      topic,
      filter: params.filter,
      status: params.status,
    });
    const refresh = deps.runtimeService?.refreshLongHorizonSubscription(
      subscription.spaceId,
      subscription.id
    );
    if (refresh && !refresh.success)
      throw new Error(refresh.error ?? 'Failed to refresh subscription');
    return { subscription };
  });

  messageHub.onRequest(method('updateSubscription'), async (data) => {
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
    const existing = deps.repo.getSubscription(params.subscriptionId);
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
      deps.repo,
      existing.agentId,
      source,
      topic,
      pattern,
      existing.id
    );
    const subscription = deps.repo.updateSubscription(params.subscriptionId, {
      ...(params.source !== undefined ? { source } : {}),
      ...(params.topic !== undefined ? { topic } : {}),
      ...(params.filter !== undefined ? { filter: params.filter } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
    });
    if (!subscription) throw new Error(`Subscription not found: ${params.subscriptionId}`);
    const refresh = deps.runtimeService?.refreshLongHorizonSubscription(
      subscription.spaceId,
      subscription.id
    );
    if (refresh && !refresh.success)
      throw new Error(refresh.error ?? 'Failed to refresh subscription');
    return { subscription };
  });

  messageHub.onRequest(method('deleteSubscription'), async (data) => {
    const params = data as { subscriptionId: string; spaceId?: string };
    if (!params.subscriptionId) throw new Error('subscriptionId is required');
    const existing = deps.repo.getSubscription(params.subscriptionId);
    if (!existing) throw new Error(`Subscription not found: ${params.subscriptionId}`);
    if (params.spaceId && existing.spaceId !== params.spaceId) {
      throw new Error(
        `Subscription ${params.subscriptionId} does not belong to space ${params.spaceId}`
      );
    }
    deps.runtimeService?.removeLongHorizonSubscription(existing.spaceId, existing.id);
    deps.repo.deleteSubscription(params.subscriptionId);
    return { success: true };
  });
}

export function setupSpaceAgentHandlers(
  messageHub: MessageHub,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  spaceManager: SpaceManager,
  longHorizonAgentRepo: SpaceLongHorizonAgentRepository,
  runtimeService?: UnifiedSpaceAgentRuntimeService,
  templateManager?: SpaceAgentTemplateManager,
  ownedAgents?: OwnedAgentLookup
): void {
  const deps: UnifiedSpaceAgentMethodDeps = {
    spaceManager,
    repo: longHorizonAgentRepo,
    templateManager,
    runtimeService,
    internalEventBus,
    ownedAgents,
  };

  registerUnifiedSpaceAgentMethods(messageHub, deps);
}
