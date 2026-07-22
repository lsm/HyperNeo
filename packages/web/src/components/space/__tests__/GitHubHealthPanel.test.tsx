// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';

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
  timestamp: 1_700_000_000_000,
  token: { configured: true, source: 'keychain', login: 'octocat' },
  polling: {
    globallyEnabled: true,
    intervalMs: 120_000,
    active: true,
    pollingRepoCount: 2,
    lastPollAt: 1_700_000_000_000,
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
      pollingEnabled: false,
      lastWebhookAt: null,
      lastPollAt: null,
      webhookLastError: null,
      reactionTrackedPullRequests: 0,
    },
    {
      owner: 'acme',
      repo: 'gadgets',
      enabled: true,
      webhookEnabled: true,
      webhookActive: true,
      pollingEnabled: false,
      lastWebhookAt: null,
      lastPollAt: null,
      webhookLastError: null,
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

  it('shows Down when the token is not configured', async () => {
    setupHealth({
      ...baseSnapshot,
      token: { configured: false, source: 'none' },
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
