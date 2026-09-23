import type {
  EvolutionScope,
  GoalEvolutionAutomationEventSubscription,
  GoalEvolutionAutomationPolicy,
} from '@hyperneo/shared';
import type { ExternalEventPublishedPayload } from '../external-events/external-event-service.ts';

export const DEFAULT_COMPLETED_TASK_THRESHOLD = 10;

export function readAutomationPolicyForScope(
  scope: EvolutionScope | null | undefined
): GoalEvolutionAutomationPolicy {
  return normalizePolicy(scope?.policy.automation);
}

export function readCompletedTaskThreshold(policy: GoalEvolutionAutomationPolicy): number | null {
  if (policy.completedTaskAutomationEnabled === false) return null;
  const threshold = policy.completedTaskThreshold;
  if (threshold === undefined) return DEFAULT_COMPLETED_TASK_THRESHOLD;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return null;
  const normalized = Math.floor(threshold);
  return normalized > 0 ? normalized : null;
}

export function findMatchingSubscription(
  subscriptions: GoalEvolutionAutomationEventSubscription[] | undefined,
  event: ExternalEventPublishedPayload
): GoalEvolutionAutomationEventSubscription | null {
  for (const subscription of subscriptions ?? []) {
    if (subscription.source && subscription.source !== event.source) continue;
    if (!topicMatches(subscription.topic, event.topic)) continue;
    if (!filterMatches(subscription.filter, event.payload)) continue;
    return subscription;
  }
  return null;
}

function normalizePolicy(value: unknown): GoalEvolutionAutomationPolicy {
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

function normalizeSubscription(value: unknown): GoalEvolutionAutomationEventSubscription[] {
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

function filterMatches(
  filter: Record<string, string | number | boolean | null> | undefined,
  payload: Record<string, unknown>
): boolean {
  if (!filter) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (payload[key] !== expected) return false;
  }
  return true;
}
