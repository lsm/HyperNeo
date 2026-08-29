import type { GitHubPollingRepo } from './github-normalizer.ts';
import type { GitHubWatchedRepo } from './github-repository.ts';

export type WebhookKind = 'status' | 'deployment-family' | 'generic';

export function routeWebhookKind(eventType: string): WebhookKind {
  if (eventType === 'status') return 'status';
  if (eventType === 'deployment' || eventType === 'deployment_status') return 'deployment-family';
  return 'generic';
}

export function admittedWatchedRepos(
  watched: GitHubWatchedRepo[],
  repo: GitHubPollingRepo,
  isSpaceEnabled: (spaceId: string) => boolean
): GitHubWatchedRepo[] {
  const owner = repo.owner.toLowerCase();
  const repoName = repo.repo.toLowerCase();
  return watched.filter(
    (r) =>
      r.enabled &&
      r.owner.toLowerCase() === owner &&
      r.repo.toLowerCase() === repoName &&
      isSpaceEnabled(r.spaceId)
  );
}

export type PrResolutionOutcome =
  | 'publish'
  | 'ignore-no-pull-request'
  | 'fail-rate-limited'
  | 'fail-resolution';

export function classifyPrResolutionOutcome(args: {
  prNumbers: number[];
  resolutionFailed: boolean;
  rateLimited: boolean;
}): PrResolutionOutcome {
  if (args.rateLimited) return 'fail-rate-limited';
  if (args.resolutionFailed) return 'fail-resolution';
  if (args.prNumbers.length === 0) return 'ignore-no-pull-request';
  return 'publish';
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export type WebhookDenial =
  | { reason: 'not_started' }
  | { reason: 'missing_signature' }
  | { reason: 'missing_event_headers' }
  | { reason: 'invalid_signature' }
  | { reason: 'extension_disabled' }
  | { reason: 'invalid_json' }
  | { reason: 'ignored'; deliveryId: string }
  | { reason: 'repo_not_watched' }
  | { reason: 'admission_empty'; deliveryId: string }
  | { reason: 'inactive'; deliveryId: string }
  | { reason: 'no_pull_request'; deliveryId: string }
  | { reason: 'rate_limited'; deliveryId: string; kind: 'status' | 'deployment' }
  | { reason: 'resolution_failed'; deliveryId: string; kind: 'status' | 'deployment' };

export function webhookDenialResponse(denial: WebhookDenial): WebhookResponse {
  switch (denial.reason) {
    case 'not_started':
      return { status: 503, body: { error: 'GitHub extension not started' } };
    case 'missing_signature':
      return { status: 401, body: { error: 'Missing signature header' } };
    case 'missing_event_headers':
      return { status: 400, body: { error: 'Missing GitHub event headers' } };
    case 'invalid_signature':
      return { status: 401, body: { error: 'Invalid signature' } };
    case 'extension_disabled':
      return {
        status: 202,
        body: { message: 'Event ignored', reason: 'github_extension_disabled' },
      };
    case 'invalid_json':
      return { status: 400, body: { error: 'Invalid JSON payload' } };
    case 'ignored':
      return { status: 202, body: { message: 'Event ignored', deliveryId: denial.deliveryId } };
    case 'repo_not_watched':
      return { status: 404, body: { error: 'Repository is not watched' } };
    case 'admission_empty':
      return {
        status: 200,
        body: { message: 'Webhook received', deliveryId: denial.deliveryId, spaces: 0 },
      };
    case 'inactive':
      return {
        status: 202,
        body: { message: 'Event ignored', deliveryId: denial.deliveryId, reason: 'inactive' },
      };
    case 'no_pull_request':
      return {
        status: 202,
        body: {
          message: 'Event ignored',
          deliveryId: denial.deliveryId,
          reason: 'no_pull_request',
        },
      };
    case 'rate_limited': {
      const label = denial.kind === 'status' ? 'Status' : 'Deployment';
      return {
        status: 503,
        body: {
          error: `${label} PR resolution skipped — rate limited`,
          deliveryId: denial.deliveryId,
        },
      };
    }
    case 'resolution_failed': {
      const label = denial.kind === 'status' ? 'Status' : 'Deployment';
      return {
        status: 503,
        body: { error: `${label} PR resolution failed`, deliveryId: denial.deliveryId },
      };
    }
  }
}
