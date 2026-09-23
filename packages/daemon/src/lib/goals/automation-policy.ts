import type {
  EvolutionScope,
  GoalForgeAutomationEventSubscription,
  GoalForgeAutomationPolicy,
} from '@hyperneo/shared';
import { eventMatchesFilter } from '../external-events/event-filter.ts';
import type { ExternalEventPublishedPayload } from '../external-events/external-event-service.ts';

export const DEFAULT_COMPLETED_TASK_THRESHOLD = 10;

export function readAutomationPolicyForScope(
  scope: EvolutionScope | null | undefined
): GoalForgeAutomationPolicy {
  return normalizePolicy(scope?.policy.automation);
}

export function readCompletedTaskThreshold(policy: GoalForgeAutomationPolicy): number | null {
  if (policy.completedTaskAutomationEnabled === false) return null;
  const threshold = policy.completedTaskThreshold;
  if (threshold === undefined) return DEFAULT_COMPLETED_TASK_THRESHOLD;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return null;
  const normalized = Math.floor(threshold);
  return normalized > 0 ? normalized : null;
}

export function findMatchingSubscription(
  subscriptions: GoalForgeAutomationEventSubscription[] | undefined,
  event: ExternalEventPublishedPayload
): GoalForgeAutomationEventSubscription | null {
  for (const subscription of subscriptions ?? []) {
    if (subscription.source && subscription.source !== event.source) continue;
    if (!topicMatches(subscription.topic, event.topic)) continue;
    if (!eventMatchesFilter(subscription.filter, event.payload)) continue;
    return subscription;
  }
  return null;
}

function normalizePolicy(value: unknown): GoalForgeAutomationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    completedTaskThreshold:
      typeof record.completedTaskThreshold === 'number' ? record.completedTaskThreshold : undefined,
    completedTaskAutomationEnabled:
      typeof record.completedTaskAutomationEnabled === 'boolean'
        ? record.completedTaskAutomationEnabled
        : undefined,
    selfNagCronExpression:
      typeof record.selfNagCronExpression === 'string'
        ? record.selfNagCronExpression.trim()
        : undefined,
    selfNagTimezone:
      typeof record.selfNagTimezone === 'string' ? record.selfNagTimezone.trim() : undefined,
    eventSubscriptions: Array.isArray(record.eventSubscriptions)
      ? record.eventSubscriptions.flatMap((item) => normalizeSubscription(item))
      : undefined,
    maxEvidencePerEpisode:
      typeof record.maxEvidencePerEpisode === 'number' ? record.maxEvidencePerEpisode : undefined,
  };
}

function normalizeSubscription(value: unknown): GoalForgeAutomationEventSubscription[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.topic !== 'string' || !record.topic.trim()) return [];
  const filter =
    record.filter && typeof record.filter === 'object' && !Array.isArray(record.filter)
      ? (record.filter as Record<string, string | number | boolean | null>)
      : undefined;
  return [
    {
      topic: record.topic.trim(),
      source:
        typeof record.source === 'string' && record.source.trim()
          ? record.source.trim()
          : undefined,
      filter,
    },
  ];
}

function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic || pattern === '*') return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(topic);
}
