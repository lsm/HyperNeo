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
  token: { configured: true, source: 'keychain', login: 'octocat' },
  polling: {
    globallyEnabled: true,
    intervalMs: 120_000,
    active: true,
    pollingRepoCount: 2,
    inaccessibleRepoCount: 0,
    partialErrorRepoCount: 0,
    neverPolledRepoCount: 0,
    stalePollingRepoCount: 0,
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
  reactions: { trackedPullRequests: 3, lastActivityAt: Date.now() - 60_000, staleRepoCount: 0 },
  recentErrors: [],
  recentErrorTotal: 0,
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

/** Repositories with no live webhook path (webhookLive is now derived per-repo). */
const deadWebhookRepos = baseSnapshot.repositories.map((r) => ({
  ...r,
  webhookEnabled: false,
  webhookActive: null,
  lastWebhookAt: null,
}));

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
      token: { configured: true, source: 'keychain', error: 'HTTP 401', authRejected: true },
      webhook: {
        ...baseSnapshot.webhook,
        active: 0,
        configured: 0,
        total: 2,
        lastWebhookAt: null,
      },
      repositories: deadWebhookRepos,
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

  it('shows Degraded (not Down) for a transient /user validation outage', async () => {
    // A timeout/network error validating /user is NOT a definitive credential
    // rejection. With accessible polling repos the path stays live (Degraded via
    // token.error), not Down.
    setupHealth({
      ...baseSnapshot,
      token: { configured: true, source: 'keychain', error: 'validation timed out' },
      repositories: deadWebhookRepos,
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
    expect(await findByText('Degraded')).toBeTruthy();
    expect(queryByText('Down')).toBeNull();
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

  it('shows Degraded when reaction polling is stale despite fresh primary polling', async () => {
    // Primary polling is fresh, but reactions have not been observed for well
    // past the interval (skipped for budget across cycles) — flag Degraded.
    setupHealth({
      ...baseSnapshot,
      webhook: { ...baseSnapshot.webhook, active: 0, configured: 0, total: 2 },
      repositories: deadWebhookRepos,
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 120_000,
        pollingRepoCount: 1,
      },
      reactions: {
        trackedPullRequests: 2,
        lastActivityAt: Date.now() - 60 * 60 * 1000,
        staleRepoCount: 1,
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

  it('shows Degraded when tracked PRs exist but reactions never succeeded', async () => {
    // lastActivityAt null with tracked PRs means the discovery cycle skipped
    // reactions (budget below the floor) — approvals are not being observed.
    setupHealth({
      ...baseSnapshot,
      webhook: { ...baseSnapshot.webhook, active: 0, configured: 0, total: 2 },
      repositories: deadWebhookRepos,
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 120_000,
        pollingRepoCount: 1,
      },
      reactions: { trackedPullRequests: 2, lastActivityAt: null, staleRepoCount: 1 },
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

  it('does not treat a disabled repo hook as a live webhook path', async () => {
    // The repositories rollup includes disabled rows for diagnostics; an
    // active hook on a disabled repo must not make webhookLive true.
    setupHealth({
      ...baseSnapshot,
      webhook: {
        ...baseSnapshot.webhook,
        active: 0,
        unknown: 0,
        inactive: 0,
        configured: 0,
        lastWebhookAt: null,
      },
      repositories: [
        {
          owner: 'acme',
          repo: 'widgets',
          enabled: false, // space disabled, but the hook was active
          webhookEnabled: true,
          webhookActive: true,
          webhookAutoRegistered: true,
          pollingEnabled: false,
          lastWebhookAt: Date.now() - 60_000,
          lastPollAt: null,
          webhookLastError: null,
          lastPollError: null,
          lastPartialPollError: null,
          reactionTrackedPullRequests: 0,
        },
      ],
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

  it('does not degrade a webhook-only space for a transient token validation error', async () => {
    // A webhook-only Space's inbound deliveries never use the PAT, so a /user
    // rate-limit/timeout (token.error) must not badge it Degraded.
    setupHealth({
      ...baseSnapshot,
      token: { configured: true, source: 'keychain', error: 'validation timed out' },
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
      repositories: [
        {
          owner: 'acme',
          repo: 'widgets',
          enabled: true,
          webhookEnabled: true,
          // Remotely confirmed inactive, but still carries stale delivery history.
          webhookActive: false,
          webhookAutoRegistered: true,
          pollingEnabled: false,
          lastWebhookAt: Date.now() - 60_000,
          lastPollAt: null,
          webhookLastError: null,
          lastPollError: null,
          lastPartialPollError: null,
          reactionTrackedPullRequests: 0,
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
      repositories: deadWebhookRepos,
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
      repositories: deadWebhookRepos,
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
      repositories: deadWebhookRepos,
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
      repositories: deadWebhookRepos,
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
      expect(mockRequest).toHaveBeenCalledWith(
        'space.github.pollOnce',
        { spaceId: 'space-1' },
        { timeout: expect.any(Number) }
      );
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
      expect(mockRequest).toHaveBeenCalledWith(
        'space.github.autoConfigureWebhook',
        {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        },
        { timeout: expect.any(Number) }
      );
      expect(mockRequest).toHaveBeenCalledWith(
        'space.github.autoConfigureWebhook',
        {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'gadgets',
        },
        { timeout: expect.any(Number) }
      );
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
      repositories: deadWebhookRepos,
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
      expect(mockRequest).toHaveBeenCalledWith(
        'space.github.autoConfigureWebhook',
        {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        },
        { timeout: expect.any(Number) }
      );
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

  it('notifies the parent via onBusyChange while re-registering webhooks', async () => {
    setupHealth();
    const onBusyChange = vi.fn();
    // Gate every re-register RPC on a single deferred so the in-action busy
    // state is observable before the (sequential) loop completes — resolving
    // the gate settles every call, current and future.
    let openGate: ((value: unknown) => void) | undefined;
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });
    mockRequest.mockImplementation((method) => {
      if (method === 'space.github.health') return Promise.resolve(baseSnapshot);
      if (method === 'space.github.autoConfigureWebhook') return gate.then(() => ({}));
      return Promise.resolve({});
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
        onBusyChange={onBusyChange}
      />
    );
    await findByText('Healthy');
    expect(onBusyChange).toHaveBeenCalledWith(null);

    fireEvent.click(await findByText('Re-register webhooks'));

    await waitFor(() => {
      expect(onBusyChange).toHaveBeenCalledWith('reregister');
    });

    // Opening the gate completes the loop and releases the action lock.
    await act(async () => {
      openGate?.({});
    });
    await waitFor(() => {
      expect(onBusyChange).toHaveBeenLastCalledWith(null);
    });
  });

  it('periodically refreshes the snapshot so time-dependent badges can transition', async () => {
    vi.useFakeTimers();
    try {
      setupHealth();
      const { findByText } = render(
        <GitHubHealthPanel
          spaceId="space-1"
          pollingCapabilityEnabled={true}
          webhooksCapabilityEnabled={true}
        />
      );
      await findByText('Healthy');
      const healthCalls = () =>
        mockRequest.mock.calls.filter((c) => c[0] === 'space.github.health').length;
      const afterMount = healthCalls();

      // Advance past the periodic refresh interval; a silent refresh fires
      // without an operator clicking Refresh, so a frozen Healthy snapshot can
      // move to Down/Degraded as freshness thresholds expire.
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(healthCalls()).toBeGreaterThan(afterMount);
      // The periodic refresh is lightweight so it does not trigger a /user
      // validation on every tick.
      const periodicCalls = mockRequest.mock.calls
        .filter((c) => c[0] === 'space.github.health')
        .slice(afterMount);
      expect(
        periodicCalls.some((c) => (c[1] as { lightweight?: boolean })?.lightweight === true)
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows Degraded when a manual webhook only has ancient delivery evidence', async () => {
    const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const snapshot = {
      ...baseSnapshot,
      timestamp: Date.now(),
      repositories: [
        {
          ...baseSnapshot.repositories[0],
          webhookAutoRegistered: false,
          webhookActive: null,
          lastWebhookAt: ancient,
          pollingEnabled: false,
        },
      ],
    };
    setupHealth(snapshot);
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Degraded')).toBeTruthy();
  });

  it('does not let a silent refresh strand a foreground load spinner', async () => {
    vi.useFakeTimers();
    try {
      let resolveForeground: ((value: unknown) => void) | undefined;
      const foreground = new Promise((resolve) => {
        resolveForeground = resolve;
      });
      let healthCall = 0;
      mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
      mockRequest.mockImplementation((method: string) => {
        if (method === 'space.github.health') {
          healthCall += 1;
          // The mount (foreground) load stalls; later periodic (silent) refreshes resolve.
          return healthCall === 1 ? foreground : Promise.resolve(baseSnapshot);
        }
        return Promise.resolve({});
      });
      const { queryByText } = render(
        <GitHubHealthPanel
          spaceId="space-1"
          pollingCapabilityEnabled={true}
          webhooksCapabilityEnabled={true}
        />
      );

      // Fire a silent refresh while the foreground load is still in flight.
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      // The foreground load resolves last; its loading flag must clear (the
      // silent refresh must not have superseded its generation and stranded it).
      await act(async () => {
        resolveForeground?.(baseSnapshot);
      });
      await waitFor(() => {
        // The Refresh button shows "Refresh" (not the loading label) once loading clears.
        expect(queryByText('Refresh')).toBeTruthy();
        expect(queryByText('Loading...')).toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows Degraded when an auto hook cached-active check is ancient', async () => {
    const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const snapshot = {
      ...baseSnapshot,
      timestamp: Date.now(),
      repositories: [
        {
          ...baseSnapshot.repositories[0],
          webhookActive: true,
          webhookAutoRegistered: true,
          webhookLastCheckedAt: ancient,
          lastWebhookAt: null,
          pollingEnabled: false,
        },
      ],
    };
    setupHealth(snapshot);
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    // No recent delivery and the cached active status was last checked long ago.
    expect(await findByText('Degraded')).toBeTruthy();
  });

  it('skips a silent refresh while a foreground load is in flight', async () => {
    vi.useFakeTimers();
    try {
      let resolveForeground: ((value: unknown) => void) | undefined;
      const foreground = new Promise((resolve) => {
        resolveForeground = resolve;
      });
      let healthCall = 0;
      mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
      mockRequest.mockImplementation((method: string) => {
        if (method === 'space.github.health') {
          healthCall += 1;
          // The mount (foreground) load stalls; later silent refreshes resolve.
          return healthCall === 1 ? foreground : Promise.resolve(baseSnapshot);
        }
        return Promise.resolve({});
      });
      render(
        <GitHubHealthPanel
          spaceId="space-1"
          pollingCapabilityEnabled={true}
          webhooksCapabilityEnabled={true}
        />
      );

      // The foreground load is in flight; firing the periodic timer must NOT
      // start a silent refresh (it would race the foreground).
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(healthCall).toBe(1);

      // Once the foreground completes, a later silent refresh proceeds.
      await act(async () => {
        resolveForeground?.(baseSnapshot);
      });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(healthCall).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat a never-successful poll as live', async () => {
    // Polling configured, but no poll has ever succeeded (lastPollAt null) — e.g.
    // every attempt rate-limited before any 200/304. Must not badge Healthy.
    setupHealth({
      ...baseSnapshot,
      polling: { ...baseSnapshot.polling, lastPollAt: null },
      repositories: deadWebhookRepos,
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

  it('keeps the last snapshot visible after a silent refresh failure', async () => {
    vi.useFakeTimers();
    try {
      let healthCall = 0;
      mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
      mockRequest.mockImplementation((method: string) => {
        if (method === 'space.github.health') {
          healthCall += 1;
          // Mount succeeds; the periodic (silent) refresh rejects.
          return healthCall === 1
            ? Promise.resolve(baseSnapshot)
            : Promise.reject(new Error('transient'));
        }
        return Promise.resolve({});
      });
      const { findByText, queryByText } = render(
        <GitHubHealthPanel
          spaceId="space-1"
          pollingCapabilityEnabled={true}
          webhooksCapabilityEnabled={true}
        />
      );
      await findByText('Healthy');

      // Fire the silent refresh; it rejects, but the retained snapshot must stay
      // visible (no error state blanking the badge/metrics).
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => {
        expect(queryByText('Healthy')).toBeTruthy();
      });
      expect(queryByText(/Failed to load health/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat polling as live when a repo has never been polled', async () => {
    // One repo polled fresh, another never reached GitHub (neverPolledRepoCount).
    // The aggregate lastPollAt (max) must not mask the never-polled repo.
    setupHealth({
      ...baseSnapshot,
      polling: { ...baseSnapshot.polling, neverPolledRepoCount: 1 },
      repositories: deadWebhookRepos,
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

  it('does not degrade for webhook failures when delivery is disabled', async () => {
    // Webhook capability intentionally off but polling healthy: cached inactive
    // hooks / errors must not degrade the badge.
    setupHealth({
      ...baseSnapshot,
      webhook: {
        ...baseSnapshot.webhook,
        deliveryEnabled: false,
        inactive: 1,
        errors: [{ owner: 'acme', repo: 'widgets', error: 'boom', at: null }],
      },
    });
    const { findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    expect(await findByText('Healthy')).toBeTruthy();
  });

  it('disables re-register while the snapshot is stale after a mutation', async () => {
    // Stall the nonce-triggered refresh so the snapshot stays stale.
    let resolveHealth: ((value: unknown) => void) | undefined;
    const stalledHealth = () =>
      new Promise((resolve) => {
        resolveHealth = resolve;
      });
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method: string) => {
      if (method === 'space.github.health') return stalledHealth();
      return Promise.resolve({});
    });
    const { rerender, findByText } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        refreshNonce={1}
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    // Resolve the mount fetch so the panel loads.
    await act(async () => {
      resolveHealth?.(baseSnapshot);
    });
    await findByText('Healthy');

    // A sibling mutation bumps the nonce; the refresh stalls → snapshot stale.
    mockRequest.mockImplementation((method: string) => {
      if (method === 'space.github.health') return stalledHealth();
      return Promise.resolve({});
    });
    rerender(
      <GitHubHealthPanel
        spaceId="space-1"
        refreshNonce={2}
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
      />
    );
    const btn = await findByText('Re-register webhooks');
    expect((btn.closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows Degraded when a polling repo is stale despite another being fresh', async () => {
    // One repo polled fresh, another's last successful poll is now ancient.
    // The aggregate lastPollAt (max) must not mask the stale repo.
    setupHealth({
      ...baseSnapshot,
      polling: { ...baseSnapshot.polling, stalePollingRepoCount: 1 },
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

  it('treats a polling-only space under a rate-limit cooldown as Degraded, not Down', async () => {
    // Polling is stale (ancient lastPollAt) and there is no webhook path, but an
    // active cooldown with a future reset explains the staleness — recoverable,
    // not broken.
    setupHealth({
      ...baseSnapshot,
      polling: { ...baseSnapshot.polling, lastPollAt: Date.now() - 60 * 60 * 1000 },
      rateLimit: {
        ...baseSnapshot.rateLimit,
        limited: true,
        until: Date.now() + 60_000,
        resetAt: Date.now() + 60_000,
      },
      repositories: deadWebhookRepos,
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

  it('releases the parent action lock when the panel unmounts mid-action', async () => {
    const onBusyChange = vi.fn();
    // Stall re-register so busy stays non-null at unmount.
    let openGate: ((value: unknown) => void) | undefined;
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method: string) => {
      if (method === 'space.github.health') return Promise.resolve(baseSnapshot);
      if (method === 'space.github.autoConfigureWebhook') return gate.then(() => ({}));
      return Promise.resolve({});
    });
    const { findByText, unmount } = render(
      <GitHubHealthPanel
        spaceId="space-1"
        pollingCapabilityEnabled={true}
        webhooksCapabilityEnabled={true}
        onBusyChange={onBusyChange}
      />
    );
    await findByText('Healthy');
    fireEvent.click(await findByText('Re-register webhooks'));
    await waitFor(() => {
      expect(onBusyChange).toHaveBeenCalledWith('reregister');
    });
    // Unmount mid-action: the effect cleanup must release the parent lock.
    unmount();
    expect(onBusyChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps a webhook-only Space Down under a rate-limit cooldown', async () => {
    // No polling path (pollingRepoCount 0) and a broken webhook. The daemon-wide
    // cooldown is an API/polling concept — it cannot explain or recover a broken
    // inbound webhook, so the Space must stay Down (not Degraded) until the
    // webhook is fixed, even while a cooldown is active.
    setupHealth({
      ...baseSnapshot,
      polling: { ...baseSnapshot.polling, pollingRepoCount: 0, lastPollAt: null },
      rateLimit: {
        ...baseSnapshot.rateLimit,
        limited: true,
        until: Date.now() + 60_000,
        resetAt: Date.now() + 60_000,
      },
      repositories: deadWebhookRepos,
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

  it('stays Down under a cooldown when polling is configured but disabled', async () => {
    // Polling repos exist (pollingRepoCount > 0) but the interval is 0, so
    // polling cannot resume after the cooldown — the cooldown does not make the
    // no-live-path Space recoverable.
    setupHealth({
      ...baseSnapshot,
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 0,
        pollingRepoCount: 1,
        lastPollAt: Date.now() - 60 * 60 * 1000,
      },
      rateLimit: {
        ...baseSnapshot.rateLimit,
        limited: true,
        until: Date.now() + 60_000,
        resetAt: Date.now() + 60_000,
      },
      repositories: deadWebhookRepos,
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

  it('does not degrade for cached polling errors while polling is disabled', async () => {
    // Healthy webhooks + polling configured but disabled (interval 0) with
    // cached inaccessible/partial errors. The disabled polling subsystem cannot
    // affect delivery, so the Space stays Healthy.
    setupHealth({
      ...baseSnapshot,
      polling: {
        ...baseSnapshot.polling,
        globallyEnabled: true,
        intervalMs: 0,
        inaccessibleRepoCount: 1,
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
    expect(await findByText('Healthy')).toBeTruthy();
    expect(queryByText('Degraded')).toBeNull();
  });

  it('degrades a mixed-mode Space when a polling repo has never been polled', async () => {
    // Live webhooks, but a configured polling repo has never reached GitHub.
    // The live webhook would otherwise hide the never-working polling path.
    setupHealth({
      ...baseSnapshot,
      polling: { ...baseSnapshot.polling, neverPolledRepoCount: 1 },
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

  it('stays Down under a cooldown when all polling repos are inaccessible', async () => {
    // Polling-only, every repo inaccessible, under a cooldown. The cooldown
    // cannot recover inaccessible repos, so it must not flip Down→Degraded.
    setupHealth({
      ...baseSnapshot,
      polling: {
        ...baseSnapshot.polling,
        pollingRepoCount: 1,
        inaccessibleRepoCount: 1,
        lastPollAt: Date.now() - 60 * 60 * 1000,
      },
      rateLimit: {
        ...baseSnapshot.rateLimit,
        limited: true,
        until: Date.now() + 60_000,
        resetAt: Date.now() + 60_000,
      },
      repositories: deadWebhookRepos,
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
});
