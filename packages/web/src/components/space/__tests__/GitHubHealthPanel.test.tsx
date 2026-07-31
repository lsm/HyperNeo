// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, act } from '@testing-library/preact';

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    get getHubIfConnected() {
      return mockGetHubIfConnected;
    },
  },
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    get success() {
      return mockToastSuccess;
    },
    get error() {
      return mockToastError;
    },
  },
}));

vi.mock('../../ui/Button', () => ({
  Button: ({ children, onClick, type, loading, disabled }) => (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled || loading}
      data-loading={loading ? 'true' : 'false'}
    >
      {loading ? 'Loading...' : children}
    </button>
  ),
}));

vi.mock('../../ui/Spinner', () => ({
  Spinner: () => <span>spinner</span>,
}));

import { GitHubHealthPanel } from '../GitHubHealthPanel';

const baseSnapshot = {
  source: 'github',
  spaceId: 'space-1',
  // Recent so the polling-freshness check (round 13) does not flag it stale.
  timestamp: Date.now(),
  timestamp: 1_700_000_000_000,
  token: { configured: true, source: 'keychain', login: 'octocat' },
  polling: {
    globallyEnabled: true,
    intervalMs: 120_000,
    active: true,
    pollingRepoCount: 2,
    inaccessibleRepoCount: 0,
    partialErrorRepoCount: 0,
    lastPollAt: Date.now() - 60_000,
  },
  rateLimit: {
    limited: false,
    until: 0,
    fromRetryAfter: false,
    remaining: 4999,
    resetAt: 1_700_000_000_000 + 3_600_000,
    observedAt: 1_700_000_000_000,
  },
  webhook: {
    total: 2,
    configured: 2,
    active: 2,
    inactive: 0,
    unknown: 0,
    deliveryEnabled: true,
    lastWebhookAt: 1_700_000_000_000,
    lastCheckedAt: 1_700_000_000_000,
    errors: [],
  },
  reactions: { trackedPullRequests: 3, lastActivityAt: 1_700_000_000_000 },
  recentErrors: [],
  repositories: [
    {
      owner: 'acme',
      repo: 'widgets',
      enabled: true,
      webhookEnabled: true,
      webhookActive: true,
      webhookAutoRegistered: true,
      pollingEnabled: false,
      lastWebhookAt: null,
      lastPollAt: null,
      webhookLastError: null,
      lastPollError: null,
      lastPartialPollError: null,
      reactionTrackedPullRequests: 0,
    },
    {
      owner: 'acme',
      repo: 'gadgets',
      enabled: true,
      webhookEnabled: true,
      webhookActive: true,
      webhookAutoRegistered: true,
      pollingEnabled: false,
      lastWebhookAt: null,
      lastPollAt: null,
      webhookLastError: null,
      lastPollError: null,
      lastPartialPollError: null,
      reactionTrackedPullRequests: 0,
    },
  ],
};

function setupHealth(snapshot = baseSnapshot) {
  mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
  mockRequest.mockImplementation((method) => {
    if (method === 'space.github.health') return Promise.resolve(snapshot);
    if (method === 'space.github.pollOnce') return Promise.resolve({ count: 1 });
    if (method === 'space.github.autoConfigureWebhook') return Promise.resolve({});
    return Promise.resolve({});
  });
}

describe('GitHubHealthPanel', () => {
  beforeEach(() => {
    cleanup();
    mockRequest.mockReset();
    mockGetHubIfConnected.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
  });
  afterEach(() => cleanup());

  it('renders the consolidated health snapshot', async () => {
    setupHealth();
    const { findByText, getByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );

    expect(await findByText('Healthy')).toBeTruthy();
    expect(getByText('octocat')).toBeTruthy();
    expect(getByText('(keychain)')).toBeTruthy();
    expect(getByText('2m')).toBeTruthy(); // polling interval
    expect(getByText('4,999')).toBeTruthy(); // rate-limit remaining
    expect(getByText('2 active')).toBeTruthy(); // webhooks
    expect(getByText(/3 PR\(s\)/)).toBeTruthy(); // reactions
    expect(mockRequest).toHaveBeenCalledWith('space.github.health', { spaceId: 'space-1' });
  });

  it('shows Degraded when an inactive webhook is present', async () => {
    setupHealth({
      ...baseSnapshot,
      webhook: { ...baseSnapshot.webhook, active: 1, inactive: 1 },
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Degraded')).toBeTruthy();
  });

  it('shows Down for a polling-only space whose token is rejected', async () => {
    // token.configured is true but /user rejected it (401), so the token is not
    // a functioning polling credential — polling cannot publish. The space must
    // read Down, not Degraded.
    setupHealth({
      ...baseSnapshot,
      token: { configured: true, source: 'keychain', error: 'HTTP 401' },
      webhook: {
        ...baseSnapshot.webhook,
        active: 0,
        configured: 0,
        total: 2,
        lastWebhookAt: null,
      },
      polling: { ...baseSnapshot.polling, pollingRepoCount: 1 },
    });
    const { findByText, queryByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Down')).toBeTruthy();
    expect(queryByText('Degraded')).toBeNull();
  });

  it('counts unauthenticated public-repo polling as live (no PAT)', async () => {
    // No token, but public repos are accessible (inaccessibleRepoCount 0):
    // unauthenticated polling still publishes, so the space is not Down.
    setupHealth({
      ...baseSnapshot,
      token: { configured: false, source: 'none' },
      webhook: {
        ...baseSnapshot.webhook,
        active: 0,
        configured: 0,
        total: 2,
        lastWebhookAt: null,
      },
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 120_000,
        pollingRepoCount: 1,
        inaccessibleRepoCount: 0,
      },
    });
    const { findByText, queryByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Healthy')).toBeTruthy();
    expect(queryByText('Down')).toBeNull();
  });

  it('shows Degraded when a polling repo has a partial-access error', async () => {
    // A repo that reached some endpoints but not others still publishes, so it
    // is a live path (not Down) but a Degraded signal.
    setupHealth({
      ...baseSnapshot,
      webhook: {
        ...baseSnapshot.webhook,
        active: 0,
        configured: 0,
        total: 2,
        lastWebhookAt: null,
      },
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 120_000,
        pollingRepoCount: 1,
        inaccessibleRepoCount: 0,
        partialErrorRepoCount: 1,
      },
    });
    const { findByText, queryByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Degraded')).toBeTruthy();
    expect(queryByText('Down')).toBeNull();
  });

  it('does not mark a webhook-only space Degraded for a daemon-wide rate limit', async () => {
    // The GitHub API cooldown is daemon-wide; a webhook-only Space's inbound
    // deliveries do not use the API, so it must stay Healthy while rate-limited.
    setupHealth({
      ...baseSnapshot,
      webhook: { ...baseSnapshot.webhook, active: 1 },
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 120_000,
        pollingRepoCount: 0,
      },
      rateLimit: {
        ...baseSnapshot.rateLimit,
        limited: true,
        until: Date.now() + 60_000,
      },
    });
    const { findByText, queryByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Healthy')).toBeTruthy();
    expect(queryByText('Degraded')).toBeNull();
  });

  it('does not revive a remotely-inactive hook from stale delivery history', async () => {
    // The hook delivered previously but a later check confirmed it inactive
    // (webhookActive false → counts as `inactive`, not `unknown`); the stale
    // lastWebhookAt must not make webhookLive true.
    setupHealth({
      ...baseSnapshot,
      webhook: {
        ...baseSnapshot.webhook,
        active: 0,
        unknown: 0,
        inactive: 1,
        configured: 1,
        lastWebhookAt: Date.now() - 60_000,
      },
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 120_000,
        pollingRepoCount: 0,
      },
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Down')).toBeTruthy();
  });

  it('treats a polling path with an ancient lastPollAt as not live (Down)', async () => {
    // A stalled scheduled request leaves an ancient lastPollAt with no further
    // delivery; the polling path must not count as live.
    setupHealth({
      ...baseSnapshot,
      webhook: {
        ...baseSnapshot.webhook,
        active: 0,
        configured: 0,
        total: 2,
        lastWebhookAt: null,
      },
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 120_000,
        pollingRepoCount: 1,
        // Older than 3 intervals (and the 5 min floor) → stale.
        lastPollAt: Date.now() - 60 * 60 * 1000,
      },
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Down')).toBeTruthy();
  });

  it('disables Poll now when the Space has no polling repositories', async () => {
    setupHealth({
      ...baseSnapshot,
      polling: { ...baseSnapshot.polling, pollingRepoCount: 0 },
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    await findByText('Healthy');
    expect(await findByText('Poll now')).toHaveProperty('disabled', true);
  });

  it('shows Down when there is no working delivery path', async () => {
    // Token present but neither polling nor webhooks are live.
    setupHealth({
      ...baseSnapshot,
      webhook: {
        ...baseSnapshot.webhook,
        active: 0,
        configured: 0,
        total: 2,
        lastWebhookAt: null,
      },
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 0,
        pollingRepoCount: 0,
      },
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Down')).toBeTruthy();
  });

  it('does not badge Down a webhook-only space without a token', async () => {
    // Inbound webhook delivery verifies the stored secret and needs no PAT, so a
    // webhook-only space stays up even with the token removed.
    setupHealth({
      ...baseSnapshot,
      token: { configured: false, source: 'none' },
      webhook: { ...baseSnapshot.webhook, active: 1 },
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 120_000,
        pollingRepoCount: 0,
      },
    });
    const { findByText, queryByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Healthy')).toBeTruthy();
    expect(queryByText('Down')).toBeNull();
  });

  it('counts a delivering manual webhook as a delivery path', async () => {
    // Manual hooks never get a remote active status, so a manual-webhook-only
    // space relies on successful delivery (lastWebhookAt) as the live signal.
    // A manual hook is `unknown` (webhookActive null), not `active`.
    setupHealth({
      ...baseSnapshot,
      webhook: { ...baseSnapshot.webhook, active: 0, unknown: 1, configured: 1 },
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 120_000,
        pollingRepoCount: 0,
      },
    });
    const { findByText, queryByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Healthy')).toBeTruthy();
    expect(queryByText('Down')).toBeNull();
  });

  it('treats webhooks capability off as no delivery path', async () => {
    // With delivery disabled the handler ignores every delivery, so active hooks
    // are not a working path even with polling unavailable.
    setupHealth({
      ...baseSnapshot,
      webhook: { ...baseSnapshot.webhook, deliveryEnabled: false },
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 0,
        pollingRepoCount: 0,
      },
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Down')).toBeTruthy();
  });

  it('shows Down when polling repos exist but the global poll interval is 0', async () => {
    // Polling rows survive interval=0, but the timer is stopped, so a polling-
    // only space must not be badged Healthy while its Polling metric is Disabled.
    setupHealth({
      ...baseSnapshot,
      webhook: {
        ...baseSnapshot.webhook,
        active: 0,
        configured: 0,
        total: 2,
        lastWebhookAt: null,
      },
      polling: { ...baseSnapshot.polling, globallyEnabled: true, intervalMs: 0 },
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Down')).toBeTruthy();
  });

  it('renders recent webhook and delivery errors', async () => {
    setupHealth({
      ...baseSnapshot,
      webhook: {
        ...baseSnapshot.webhook,
        active: 1,
        inactive: 1,
        errors: [{ owner: 'acme', repo: 'gadgets', error: 'GitHub webhook is disabled', at: null }],
      },
      recentErrors: [
        {
          eventId: 'evt-1',
          deliveryKey: 'delivery-1',
          topic: 'github/acme/widgets/pull_request/42.opened',
          agentName: 'coder',
          failureReason: 'agent session missing',
          updatedAt: 1_700_000_003_000,
          occurredAt: 1_700_000_000_000,
        },
      ],
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('GitHub webhook is disabled')).toBeTruthy();
    expect(await findByText('agent session missing')).toBeTruthy();
  });

  it('tests event delivery via Poll now', async () => {
    setupHealth();
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    await findByText('Healthy');

    fireEvent.click(await findByText('Poll now'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.pollOnce', { spaceId: 'space-1' });
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Poll complete: 1 event(s) published');
    });
  });

  it('re-registers every webhook-enabled repository', async () => {
    setupHealth();
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    await findByText('Healthy');

    fireEvent.click(await findByText('Re-register webhooks'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      expect(mockRequest).toHaveBeenCalledWith('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'gadgets',
      });
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Re-registered 2 webhook(s)');
    });
  });

  it('disables Poll now when polling capability is off', async () => {
    setupHealth();
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={false}
        webhooksCapabilityEnabled={true}
      />
    );
    await findByText('Healthy');
    expect(await findByText('Poll now')).toHaveProperty('disabled', true);
  });

  it('disables Poll now when the global poll interval is 0', async () => {
    setupHealth({
      ...baseSnapshot,
      polling: { ...baseSnapshot.polling, globallyEnabled: true, intervalMs: 0 },
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    await findByText('Healthy');
    expect(await findByText('Poll now')).toHaveProperty('disabled', true);
  });

  it('shows Down for a polling-only space whose repos are all inaccessible', async () => {
    // A valid-but-unauthorized PAT returns 403/404 on every endpoint; with all
    // polling repos inaccessible there is no live delivery path.
    setupHealth({
      ...baseSnapshot,
      webhook: {
        ...baseSnapshot.webhook,
        active: 0,
        configured: 0,
        total: 2,
        lastWebhookAt: null,
      },
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 120_000,
        pollingRepoCount: 1,
        inaccessibleRepoCount: 1,
      },
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Down')).toBeTruthy();
  });

  it('disables Re-register when no webhook-enabled repositories exist', async () => {
    setupHealth({
      ...baseSnapshot,
      repositories: [
        { ...baseSnapshot.repositories[0], webhookEnabled: false },
        { ...baseSnapshot.repositories[1], webhookEnabled: false },
      ],
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    await findByText('Healthy');
    expect(await findByText('Re-register webhooks')).toHaveProperty('disabled', true);
  });

  it('excludes manually-configured webhooks from bulk re-registration', async () => {
    // A manual hook (webhookAutoRegistered: false) must not be sent to
    // autoConfigureWebhook, which would create a second remote hook and orphan
    // the original behind a replaced secret.
    setupHealth({
      ...baseSnapshot,
      repositories: [
        baseSnapshot.repositories[0], // auto-registered
        { ...baseSnapshot.repositories[1], webhookAutoRegistered: false }, // manual
      ],
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    await findByText('Healthy');

    fireEvent.click(await findByText('Re-register webhooks'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Re-registered 1 webhook(s)');
    });
    expect(mockRequest).not.toHaveBeenCalledWith('space.github.autoConfigureWebhook', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'gadgets',
    });
  });

  it('clears busy even if the space changes mid-action', async () => {
    let resolvePoll!: (value: { count: number }) => void;
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'space.github.health') return Promise.resolve(baseSnapshot);
      if (method === 'space.github.pollOnce') {
        return new Promise((resolve) => {
          resolvePoll = resolve;
        });
      }
      return Promise.resolve({});
    });
    const view = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    await view.findByText('Healthy');
    fireEvent.click(await view.findByText('Poll now'));
    // Poll now is in flight (busy) — navigate to another space on the same
    // component instance, then let the old space's poll resolve.
    view.rerender(
      <GitHubHealthPanel
        spaceId="space-2"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    act(() => resolvePoll({ count: 1 }));

    await waitFor(() => {
      expect(view.getByText('Poll now')).toHaveProperty('disabled', false);
    });
  });

  it('locks actions while the parent settings are disabled', async () => {
    setupHealth();
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
        disabled={true}
      />
    );
    await findByText('Healthy');
    expect(await findByText('Poll now')).toHaveProperty('disabled', true);
    expect(await findByText('Re-register webhooks')).toHaveProperty('disabled', true);
    expect(await findByText('Refresh')).toHaveProperty('disabled', true);
  });

  it('renders the webhook check age as elapsed time, not "now ago"', async () => {
    setupHealth({
      ...baseSnapshot,
      webhook: { ...baseSnapshot.webhook, lastCheckedAt: Date.now() - 3 * 3600 * 1000 },
    });
    const { findByText, queryByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText(/checked 3h ago/)).toBeTruthy();
    expect(queryByText(/checked now ago/)).toBeNull();
  });

  it('disables re-register while a new space health snapshot is loading', async () => {
    let resolveSpace2Health!: (value: unknown) => void;
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method, data) => {
      if (method === 'space.github.health') {
        if ((data as { spaceId?: string })?.spaceId === 'space-2') {
          return new Promise((resolve) => {
            resolveSpace2Health = resolve;
          });
        }
        return Promise.resolve(baseSnapshot); // space-1 loads immediately
      }
      return Promise.resolve({});
    });

    const view = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    await view.findByText('Healthy');

    // Navigate to space-2; its health is still pending, so the stale space-1
    // snapshot must NOT keep re-register enabled against the new space.
    view.rerender(
      <GitHubHealthPanel
        spaceId="space-2"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    await waitFor(() => {
      expect(view.getByText('Re-register webhooks')).toHaveProperty('disabled', true);
    });

    // Once space-2's snapshot arrives (with auto-managed hooks), it re-enables.
    act(() =>
      resolveSpace2Health({
        ...baseSnapshot,
        spaceId: 'space-2',
      })
    );
    await waitFor(() => {
      expect(view.getByText('Re-register webhooks')).toHaveProperty('disabled', false);
    });
  });

  it('surfaces a load error when the health RPC fails', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockRejectedValue(new Error('boom'));
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText(/Failed to load health: boom/)).toBeTruthy();
  });
});
