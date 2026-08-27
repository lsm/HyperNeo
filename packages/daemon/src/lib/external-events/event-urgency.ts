export type ExternalEventUrgency = 'immediate' | 'queued';

export interface ExternalEventUrgencyInput {
  topic: string;
  payload: Record<string, unknown>;
}

const IMMEDIATE_REVIEW_VERDICT_STATES: ReadonlySet<string> = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
]);

const QUEUED_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  'cancelled',
  'canceled',
  'skipped',
  'success',
  'neutral',
]);

function payloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function topicAction(topic: string): string {
  const dot = topic.lastIndexOf('.');
  return dot === -1 ? topic : topic.slice(dot + 1);
}

function isBotActorLogin(login: string): boolean {
  return login.endsWith('[bot]');
}

export function classifyUrgency(event: ExternalEventUrgencyInput): ExternalEventUrgency {
  const action = topicAction(event.topic);
  if (action === 'review_submitted') {
    return IMMEDIATE_REVIEW_VERDICT_STATES.has(payloadString(event.payload, 'state'))
      ? 'immediate'
      : 'queued';
  }
  if (action === 'review_comment_polled') {
    return isBotActorLogin(payloadString(event.payload, 'actor')) ? 'immediate' : 'queued';
  }
  if (action === 'check_failed') {
    return QUEUED_CHECK_CONCLUSIONS.has(payloadString(event.payload, 'conclusion'))
      ? 'queued'
      : 'immediate';
  }
  if (action === 'merge_conflict') return 'immediate';
  return 'queued';
}
