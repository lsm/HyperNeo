type ExternalEventDeliveryTier = 'digest' | 'direct';

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

export type DirectSteerEventClass = 'review' | 'check' | 'merge_conflict';

const DIRECT_STEER_REVIEW_VERDICT_STATES: ReadonlySet<string> = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
]);

const DIRECT_STEER_NON_FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
  'cancelled',
  'canceled',
  'skipped',
  'success',
  'neutral',
]);

interface DirectSteerClassificationInput {
  topic: string;
  state?: string;
  actor?: string;
  conclusion?: string;
}

function isBotActorLogin(actor: string | undefined): boolean {
  return typeof actor === 'string' && actor.endsWith('[bot]');
}

export function classifyExternalEventDirectSteer(
  input: DirectSteerClassificationInput
): DirectSteerEventClass | null {
  const suffix = externalEventTopicSuffix(input.topic);
  if (suffix === 'review_submitted') {
    return DIRECT_STEER_REVIEW_VERDICT_STATES.has(input.state ?? '') ? 'review' : null;
  }
  if (suffix === 'review_comment_polled') {
    return isBotActorLogin(input.actor) ? 'review' : null;
  }
  if (suffix === 'check_failed') {
    return DIRECT_STEER_NON_FAILURE_CONCLUSIONS.has(input.conclusion ?? '') ? null : 'check';
  }
  if (suffix === 'merge_conflict') {
    return 'merge_conflict';
  }
  return null;
}
