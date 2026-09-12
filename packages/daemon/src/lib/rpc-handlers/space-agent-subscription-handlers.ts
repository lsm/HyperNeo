import type { MessageHub, SpaceLongHorizonAgentEventSubscriptionStatus } from '@hyperneo/shared';
import type { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository.ts';
import type { SpaceAgentSubscriptionRepository } from '../../storage/repositories/space-agent-subscription-repository.ts';
import { composeLongHorizonSubscriptionPattern } from '../external-events/long-horizon-subscription-pattern.ts';
import { validateGlobPattern, validateSource } from '../external-events/topic-validator.ts';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';

const METHOD_PREFIX = 'spaceAgentSubscription';

type SubscriptionRuntimeService = Pick<
  SpaceRuntimeService,
  'refreshLongHorizonSubscription' | 'removeLongHorizonSubscription'
>;

export interface SpaceAgentSubscriptionDeps {
  subscriptions: SpaceAgentSubscriptionRepository;
  agents: Pick<SpaceAgentRepository, 'getById'>;
  runtimeService?: SubscriptionRuntimeService;
}

function validateSubscriptionPattern(
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

function assertNoDuplicateSubscriptionPattern(
  repo: Pick<SpaceAgentSubscriptionRepository, 'listSubscriptions'>,
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

export function setupSpaceAgentSubscriptionHandlers(
  messageHub: MessageHub,
  deps: SpaceAgentSubscriptionDeps
): void {
  const method = (name: string): string => `${METHOD_PREFIX}.${name}`;

  messageHub.onRequest(method('list'), async (data) => {
    const params = data as { agentId: string; spaceId?: string };
    if (!params.agentId) throw new Error('agentId is required');
    const agent = deps.agents.getById(params.agentId);
    if (!agent) throw new Error(`Agent not found: ${params.agentId}`);
    if (params.spaceId && agent.spaceId !== params.spaceId) {
      throw new Error(`Agent ${params.agentId} does not belong to space ${params.spaceId}`);
    }
    return { subscriptions: deps.subscriptions.listSubscriptions(params.agentId) };
  });

  messageHub.onRequest(method('create'), async (data) => {
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
    const pattern = validateSubscriptionPattern(source, topic);
    assertNoDuplicateSubscriptionPattern(
      deps.subscriptions,
      params.agentId,
      source,
      topic,
      pattern
    );
    const subscription = deps.subscriptions.createSubscription({
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

  messageHub.onRequest(method('update'), async (data) => {
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
    const existing = deps.subscriptions.getSubscription(params.subscriptionId);
    if (!existing) throw new Error(`Subscription not found: ${params.subscriptionId}`);
    if (params.spaceId && existing.spaceId !== params.spaceId) {
      throw new Error(
        `Subscription ${params.subscriptionId} does not belong to space ${params.spaceId}`
      );
    }
    const source = params.source?.trim() ?? existing.source;
    const topic = params.topic?.trim() ?? existing.topic;
    const pattern = validateSubscriptionPattern(source, topic, {
      allowWildcardSource: params.source === undefined && params.topic === undefined,
    });
    assertNoDuplicateSubscriptionPattern(
      deps.subscriptions,
      existing.agentId,
      source,
      topic,
      pattern,
      existing.id
    );
    const subscription = deps.subscriptions.updateSubscription(params.subscriptionId, {
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

  messageHub.onRequest(method('delete'), async (data) => {
    const params = data as { subscriptionId: string; spaceId?: string };
    if (!params.subscriptionId) throw new Error('subscriptionId is required');
    const existing = deps.subscriptions.getSubscription(params.subscriptionId);
    if (!existing) throw new Error(`Subscription not found: ${params.subscriptionId}`);
    if (params.spaceId && existing.spaceId !== params.spaceId) {
      throw new Error(
        `Subscription ${params.subscriptionId} does not belong to space ${params.spaceId}`
      );
    }
    deps.runtimeService?.removeLongHorizonSubscription(existing.spaceId, existing.id);
    deps.subscriptions.deleteSubscription(params.subscriptionId);
    return { success: true };
  });
}
