import type { ExternalEventEssenceEntry } from './deferred-event-digest.ts';
import type { ExternalEvent } from './types.ts';

export function essenceEntryFromExternalEvent(
  event: ExternalEvent
): ExternalEventEssenceEntry | null {
  if (typeof event.id !== 'string' || event.id.length === 0) return null;
  if (typeof event.topic !== 'string' || event.topic.length === 0) return null;
  const payload = event.payload;
  const eventType = essenceString(payload, 'eventType');
  const repoOwner = essenceString(payload, 'repoOwner');
  const repoName = essenceString(payload, 'repoName');
  const essence: Record<string, unknown> = { eventId: event.id, topic: event.topic };
  setEssenceField(essence, 'eventType', eventType);
  setEssenceField(essence, 'action', essenceString(payload, 'action'));
  setEssenceField(essence, 'actor', essenceString(payload, 'actor'));
  setEssenceField(essence, 'repo', repoOwner && repoName ? `${repoOwner}/${repoName}` : undefined);
  setEssenceField(essence, 'prNumber', essencePrNumber(payload));
  setEssenceField(essence, 'prUrl', essenceString(payload, 'prUrl'));
  setEssenceField(essence, 'externalUrl', essenceScalar(event.externalUrl));
  setEssenceField(essence, 'occurredAt', essenceScalar(event.occurredAt));
  setEssenceField(essence, 'body', essenceString(payload, 'body'));
  copyEssenceFields(essence, payload, ['title', 'commentId', 'reviewId']);
  if (eventType === 'pull_request_review_comment') {
    copyEssenceFields(essence, payload, ['path', 'line', 'inReplyToId']);
  } else if (eventType === 'pull_request_review_thread') {
    copyEssenceFields(essence, payload, ['threadId', 'path', 'line']);
  } else if (eventType === 'pull_request_review') {
    copyEssenceFields(essence, payload, ['state']);
  } else if (eventType === 'pull_request') {
    copyEssenceFields(essence, payload, ['state', 'merged', 'mergedAt', 'draft']);
  } else if (eventType === 'check_run' || event.topic.endsWith('.check_failed')) {
    copyEssenceFields(essence, payload, ['checkName', 'conclusion']);
  } else if (eventType === 'status') {
    copyEssenceFields(essence, payload, ['state', 'description', 'context']);
  } else if (eventType === 'check_suite' || event.topic.endsWith('.suite_failed')) {
    copyEssenceFields(essence, payload, ['conclusion']);
  } else if (eventType === 'deployment') {
    copyEssenceFields(essence, payload, ['environment', 'description']);
  } else if (eventType === 'deployment_status') {
    copyEssenceFields(essence, payload, ['state', 'environment', 'description']);
  } else if (eventType === 'branch_protection_rule') {
    copyEssenceFields(essence, payload, [
      'ruleName',
      'adminEnforced',
      'requiredApprovingReviewCount',
      'requireCodeOwnerReview',
      'requiredConversationResolutionLevel',
      'strictRequiredStatusChecksPolicy',
    ]);
    copyEssenceStructuredFields(essence, payload, ['requiredStatusChecks', 'changedFields']);
  }
  for (const [field, value] of Object.entries(essenceScopeFromTopic(event.topic))) {
    if (essence[field] === undefined) essence[field] = value;
  }
  return essence as unknown as ExternalEventEssenceEntry;
}

function setEssenceField(essence: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) essence[key] = value;
}

function essenceString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function essencePrNumber(payload: Record<string, unknown>): number | undefined {
  const value = payload.prNumber;
  if (typeof value !== 'number' || value === 0 || !Number.isFinite(value)) return undefined;
  return value;
}

function essenceScalar(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  return undefined;
}

function copyEssenceFields(
  essence: Record<string, unknown>,
  payload: Record<string, unknown>,
  keys: string[]
): void {
  for (const key of keys) {
    const value = essenceScalar(payload[key]);
    if (value !== undefined) essence[key] = value;
  }
}

function copyEssenceStructuredFields(
  essence: Record<string, unknown>,
  payload: Record<string, unknown>,
  keys: string[]
): void {
  for (const key of keys) {
    const value = payload[key];
    if (value !== null && typeof value === 'object') essence[key] = value;
  }
}

function essenceScopeFromTopic(topic: string): {
  repo?: string;
  prNumber?: number;
  prUrl?: string;
} {
  const segments = topic.split('/');
  if (segments.length < 5 || segments[0] !== 'github') return {};
  const owner = segments[1] ?? '';
  const repoName = segments[2] ?? '';
  const resource = segments[3] ?? '';
  const entity = (segments[4] ?? '').split('.')[0] ?? '';
  const prNumber = /^\d+$/.test(entity) ? Number(entity) : undefined;
  return {
    ...(owner && repoName ? { repo: `${owner}/${repoName}` } : {}),
    ...(resource === 'pull_request' && prNumber !== undefined
      ? { prNumber, prUrl: `https://github.com/${owner}/${repoName}/pull/${prNumber}` }
      : {}),
  };
}
