import type { SpaceAgent, SpaceAgentTemplate } from '@hyperneo/shared';
import { composeLongHorizonSubscriptionPattern } from '../../external-events/long-horizon-subscription-pattern.ts';
import { validateGlobPattern, validateSource } from '../../external-events/topic-validator.ts';
import { getNextRunAt } from '../schedule/cron-utils.ts';

export interface TemplateExtrasStore {
  upsertSubscription(params: {
    spaceId: string;
    agentId: string;
    source: string;
    topic: string;
    filter: Record<string, unknown>;
    status: 'active';
  }): { id: string };
  deleteSubscription(subscriptionId: string): void;
  createReminder(params: {
    spaceId: string;
    agentId: string;
    title: string;
    body: string;
    triggerType: 'at' | 'cron';
    cronExpression: string | null;
    timezone: string;
    nextRunAt: number | null;
    status: 'active';
  }): unknown;
}

export interface TemplateExtrasDeps {
  store: TemplateExtrasStore;
  refreshSubscription?(spaceId: string, subscriptionId: string): { success: boolean };
}

export function isSeedableSubscription(source: string, topic: string): boolean {
  try {
    if (!validateSource(source).valid) return false;
    return validateGlobPattern(composeLongHorizonSubscriptionPattern(source, topic)).valid;
  } catch {
    return false;
  }
}

export function seedTemplateSubscriptions(
  deps: TemplateExtrasDeps,
  agent: SpaceAgent,
  template: SpaceAgentTemplate
): void {
  for (const subscription of template.suggestedEventSubscriptions ?? []) {
    if (!isSeedableSubscription(subscription.source, subscription.topic)) continue;
    const stored = deps.store.upsertSubscription({
      spaceId: agent.spaceId,
      agentId: agent.id,
      source: subscription.source,
      topic: subscription.topic,
      filter: subscription.filter ?? {},
      status: 'active',
    });
    const refresh = deps.refreshSubscription?.(agent.spaceId, stored.id);
    if (refresh && !refresh.success) deps.store.deleteSubscription(stored.id);
  }
}

export function seedTemplateReminders(
  deps: TemplateExtrasDeps,
  agent: SpaceAgent,
  template: SpaceAgentTemplate
): void {
  for (const reminder of template.reminderDefaults ?? []) {
    const timezone = reminder.timezone ?? 'UTC';
    deps.store.createReminder({
      spaceId: agent.spaceId,
      agentId: agent.id,
      title: reminder.title,
      body: reminder.body,
      triggerType: reminder.triggerType,
      cronExpression: reminder.cronExpression,
      timezone,
      nextRunAt:
        reminder.triggerType === 'cron' && reminder.cronExpression
          ? getNextRunAt(reminder.cronExpression, timezone)
          : null,
      status: 'active',
    });
  }
}

export function buildTemplateExtrasSeeder(
  deps: TemplateExtrasDeps
): (agent: SpaceAgent, template: SpaceAgentTemplate) => void {
  return (agent, template) => {
    seedTemplateSubscriptions(deps, agent, template);
    seedTemplateReminders(deps, agent, template);
  };
}
