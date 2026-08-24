export type ExternalEventDeliveryTier = 'digest' | 'direct';

export const EXTERNAL_EVENT_TOPIC_TIERS: Readonly<Record<string, ExternalEventDeliveryTier>> = {
  review_comment_polled: 'digest',
  check_failed: 'digest',
  polled: 'digest',
  comment_polled: 'digest',
  reaction_added: 'digest',
};

export function externalEventTopicSuffix(topic: string): string {
  const dot = topic.lastIndexOf('.');
  return dot === -1 ? topic : topic.slice(dot + 1);
}

export function classifyExternalEventTier(topic: string): ExternalEventDeliveryTier {
  return EXTERNAL_EVENT_TOPIC_TIERS[externalEventTopicSuffix(topic)] ?? 'digest';
}
