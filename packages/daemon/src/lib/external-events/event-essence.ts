/**
 * External event essence formatting.
 *
 * The injected "essence" is the lean, actionable projection of an
 * `ExternalEvent` that a workflow agent actually sees. It is the lean counterpart
 * to `get_external_event`, which returns the complete record (including
 * `rawPayload`) on demand. The contract this module enforces:
 *
 * - Comment / review-comment / thread events carry the FULL body text (never the
 *   truncated `summary`) plus reply/resolve handles when present.
 * - The raw source payload (`rawPayload`) is intentionally NOT projected into the
 *   essence — it stays reachable only through `get_external_event(eventId)`.
 *
 * Extracted as a pure function so the essence boundary is directly testable;
 * `SpaceRuntime` delegates here when injecting published events into sessions.
 */

import type { ExternalEventPublishedPayload } from './external-event-service';

/**
 * Render the lean essence for an injected external-event message.
 *
 * @returns a pretty-printed JSON string (the injected message body).
 */
export function formatExternalEventEssence(event: ExternalEventPublishedPayload): string {
  const payload = event.payload;
  const eventType = externalEventString(payload, 'eventType');
  const action = externalEventString(payload, 'action');
  const repoOwner = externalEventString(payload, 'repoOwner');
  const repoName = externalEventString(payload, 'repoName');
  const essence: Record<string, unknown> = {
    type: 'external_event',
    eventId: event.eventId,
    topic: event.topic,
    eventType,
    action,
    actor: externalEventString(payload, 'actor'),
    repo: repoOwner && repoName ? `${repoOwner}/${repoName}` : undefined,
    prNumber: externalEventNumber(payload, 'prNumber'),
    prUrl: externalEventString(payload, 'prUrl'),
    externalUrl: event.externalUrl,
    occurredAt: event.occurredAt,
    body: externalEventString(payload, 'body'),
  };

  copyExternalEventFields(essence, payload, [
    'title',
    'replyHandle',
    'replyUrl',
    'resolveHandle',
    'resolveThreadId',
    'commentId',
    'commentNodeId',
    'reviewId',
    'reviewNodeId',
  ]);

  if (eventType === 'pull_request_review_comment') {
    copyExternalEventFields(essence, payload, [
      'path',
      'line',
      'side',
      'startLine',
      'startSide',
      'originalLine',
      'originalSide',
      'inReplyToId',
      'pullRequestReviewId',
    ]);
  } else if (eventType === 'pull_request_review_thread') {
    copyExternalEventFields(essence, payload, [
      'threadId',
      'path',
      'line',
      'side',
      'startLine',
      'startSide',
      'originalLine',
      'originalSide',
      'originalStartLine',
    ]);
  } else if (eventType === 'pull_request_review') {
    copyExternalEventFields(essence, payload, ['state', 'submittedAt']);
  } else if (eventType === 'pull_request') {
    copyExternalEventFields(essence, payload, ['state', 'headSha', 'merged', 'mergedAt', 'draft']);
  } else if (eventType === 'check_run' || event.topic.endsWith('.check_failed')) {
    copyExternalEventFields(essence, payload, [
      'checkName',
      'conclusion',
      'runUrl',
      'status',
      'headSha',
    ]);
  } else if (eventType === 'status') {
    copyExternalEventFields(essence, payload, [
      'state',
      'description',
      'targetUrl',
      'context',
      'sha',
      'statusId',
    ]);
  } else if (eventType === 'check_suite' || event.topic.endsWith('.suite_failed')) {
    copyExternalEventFields(essence, payload, ['conclusion', 'headSha', 'app']);
  } else if (eventType === 'deployment') {
    copyExternalEventFields(essence, payload, [
      'deploymentId',
      'environment',
      'ref',
      'sha',
      'task',
      'description',
    ]);
  } else if (eventType === 'deployment_status') {
    copyExternalEventFields(essence, payload, [
      'deploymentStatusId',
      'state',
      'environment',
      'description',
      'targetUrl',
      'environmentUrl',
      'logUrl',
      'ref',
      'sha',
      'deploymentId',
    ]);
  }

  return JSON.stringify(omitUndefinedExternalEventFields(essence), null, 2);
}

function externalEventString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function externalEventNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
}

function copyExternalEventFields(
  target: Record<string, unknown>,
  payload: Record<string, unknown>,
  keys: string[]
): void {
  for (const key of keys) {
    const value = payload[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (value !== null && typeof value === 'object')
    ) {
      target[key] = value;
    }
  }
}

function omitUndefinedExternalEventFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
