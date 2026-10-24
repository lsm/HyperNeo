import { SESSION_EVENT_SCOPE } from '../session-external-event-store.ts';
import type { ExternalEvent } from '../types.ts';
import {
  type GitHubPollingRepo,
  normalizeGitHubPollingRow,
  toExternalEvent,
} from './github-normalizer.ts';

export function normalizeSessionPrClosure(
  watched: GitHubPollingRepo,
  number: number,
  detail: Record<string, unknown>
): ExternalEvent | null {
  const at = typeof detail.closed_at === 'string' ? Date.parse(detail.closed_at) : NaN;
  if (detail.state !== 'closed' || detail.number !== number || !Number.isFinite(at) || at <= 0)
    return null;
  const normalized = normalizeGitHubPollingRow(watched, detail, 'pulls');
  if (!normalized) return null;
  const identity = `pull_request:${number}:closed:${at}`;
  return toExternalEvent(SESSION_EVENT_SCOPE, {
    ...normalized,
    action: 'closed',
    occurredAt: at,
    deliveryId: `poll:${identity}`,
    externalId: identity,
    dedupeKey: `${watched.owner}/${watched.repo}:${identity}`.toLowerCase(),
    payload: { ...normalized.payload, closedAt: detail.closed_at },
  });
}
