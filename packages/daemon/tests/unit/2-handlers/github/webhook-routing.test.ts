import { describe, expect, it } from 'bun:test';
import type { GitHubPollingRepo } from '../../../../src/lib/external-events/github/github-normalizer';
import type { GitHubWatchedRepo } from '../../../../src/lib/external-events/github/github-repository';
import {
  admittedWatchedRepos,
  classifyPrResolutionOutcome,
  routeWebhookKind,
  webhookDenialResponse,
  type WebhookDenial,
} from '../../../../src/lib/external-events/github/webhook-routing';

function watched(
  overrides: { spaceId: string; owner: string; repo: string } & Partial<GitHubWatchedRepo>
): GitHubWatchedRepo {
  return { enabled: true, ...overrides } as GitHubWatchedRepo;
}

describe('routeWebhookKind', () => {
  it('routes event types to status, deployment-family, or generic', () => {
    expect(routeWebhookKind('status')).toBe('status');
    expect(routeWebhookKind('deployment')).toBe('deployment-family');
    expect(routeWebhookKind('deployment_status')).toBe('deployment-family');
    expect(routeWebhookKind('pull_request')).toBe('generic');
    expect(routeWebhookKind('')).toBe('generic');
  });
});

describe('admittedWatchedRepos', () => {
  it('filters by repo match, enablement, space enablement, and case-insensitivity', () => {
    const repo: GitHubPollingRepo = { owner: 'Acme', repo: 'Widgets' };
    const spaces: Record<string, boolean> = { 'space-1': true, 'space-2': false };
    const rows = [
      watched({ spaceId: 'space-1', owner: 'acme', repo: 'widgets' }),
      watched({ spaceId: 'space-2', owner: 'acme', repo: 'widgets' }),
      watched({ spaceId: 'space-1', owner: 'acme', repo: 'widgets', enabled: false }),
      watched({ spaceId: 'space-1', owner: 'acme', repo: 'gadgets' }),
      watched({ spaceId: 'space-unknown', owner: 'ACME', repo: 'WIDGETS' }),
    ];
    const admitted = admittedWatchedRepos(rows, repo, (spaceId) => spaces[spaceId] ?? true);
    expect(admitted.map((r) => r.spaceId)).toEqual(['space-1', 'space-unknown']);
  });
});

describe('classifyPrResolutionOutcome', () => {
  it('classifies PR resolution into the four ordered outcomes', () => {
    const cases: [number[], boolean, boolean, string][] = [
      [[7], false, false, 'publish'],
      [[], false, false, 'ignore-no-pull-request'],
      [[], true, false, 'fail-resolution'],
      [[7], true, true, 'fail-rate-limited'],
    ];
    for (const [prNumbers, resolutionFailed, rateLimited, expected] of cases) {
      expect(classifyPrResolutionOutcome({ prNumbers, resolutionFailed, rateLimited })).toBe(
        expected
      );
    }
  });
});

describe('webhookDenialResponse', () => {
  const deliveryId = 'delivery-123';

  it('produces the exact status and body for all denials', () => {
    const cases: [WebhookDenial, { status: number; body: Record<string, unknown> }][] = [
      [{ reason: 'not_started' }, { status: 503, body: { error: 'GitHub extension not started' } }],
      [
        { reason: 'missing_signature' },
        { status: 401, body: { error: 'Missing signature header' } },
      ],
      [
        { reason: 'missing_event_headers' },
        { status: 400, body: { error: 'Missing GitHub event headers' } },
      ],
      [{ reason: 'invalid_signature' }, { status: 401, body: { error: 'Invalid signature' } }],
      [
        { reason: 'extension_disabled' },
        { status: 202, body: { message: 'Event ignored', reason: 'github_extension_disabled' } },
      ],
      [{ reason: 'invalid_json' }, { status: 400, body: { error: 'Invalid JSON payload' } }],
      [
        { reason: 'repo_not_watched' },
        { status: 404, body: { error: 'Repository is not watched' } },
      ],
      [
        { reason: 'ignored', deliveryId },
        { status: 202, body: { message: 'Event ignored', deliveryId } },
      ],
      [
        { reason: 'admission_empty', deliveryId },
        { status: 200, body: { message: 'Webhook received', deliveryId, spaces: 0 } },
      ],
      [
        { reason: 'inactive', deliveryId },
        { status: 202, body: { message: 'Event ignored', deliveryId, reason: 'inactive' } },
      ],
      [
        { reason: 'no_pull_request', deliveryId },
        { status: 202, body: { message: 'Event ignored', deliveryId, reason: 'no_pull_request' } },
      ],
      [
        { reason: 'rate_limited', deliveryId, kind: 'deployment' },
        {
          status: 503,
          body: { error: 'Deployment PR resolution skipped — rate limited', deliveryId },
        },
      ],
      [
        { reason: 'resolution_failed', deliveryId, kind: 'deployment' },
        { status: 503, body: { error: 'Deployment PR resolution failed', deliveryId } },
      ],
      [
        { reason: 'rate_limited', deliveryId, kind: 'status' },
        { status: 503, body: { error: 'Status PR resolution skipped — rate limited', deliveryId } },
      ],
    ];
    for (const [denial, expected] of cases) {
      expect(webhookDenialResponse(denial)).toEqual(expected);
    }
  });
});
