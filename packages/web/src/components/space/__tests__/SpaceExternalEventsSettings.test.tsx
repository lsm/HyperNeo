// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/preact';

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockListExternalEventDeliveries = vi.fn();
const mockGetExternalEventQueueHealth = vi.fn();

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

vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    get listExternalEventDeliveries() {
      return mockListExternalEventDeliveries;
    },
    get getExternalEventQueueHealth() {
      return mockGetExternalEventQueueHealth;
    },
  },
}));

vi.mock('../../ui/Button', () => ({
  Button: ({ children, onClick, type, loading, disabled }) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled || loading}>
      {loading ? 'Loading...' : children}
    </button>
  ),
}));

vi.mock('../../ui/CopyButton', () => ({
  CopyButton: ({ text, label }) => <button title={label}>{text}</button>,
}));

vi.mock('../../ui/Spinner', () => ({
  Spinner: () => <span>spinner</span>,
}));

vi.mock('../GitHubHealthPanel', () => ({
  GitHubHealthPanel: () => <div data-testid="github-health-panel-stub" />,
}));

import { SpaceExternalEventsSettings } from '../SpaceExternalEventsSettings';

const extensionResult = {
  extensions: [
    {
      source: 'github',
      status: 'started',
      config: {
        source: 'github',
        globallyEnabled: true,
        capabilities: { webhooks: true, polling: true, rpcConfig: true },
      },
    },
  ],
};

const pollingDisabledExtensionResult = {
  extensions: [
    {
      source: 'github',
      status: 'started',
      config: {
        source: 'github',
        globallyEnabled: true,
        capabilities: { webhooks: true, polling: false, rpcConfig: true },
      },
    },
  ],
};

const webhooksDisabledExtensionResult = {
  extensions: [
    {
      source: 'github',
      status: 'started',
      config: {
        source: 'github',
        globallyEnabled: true,
        capabilities: { webhooks: false, polling: true, rpcConfig: true },
      },
    },
  ],
};

const disabledExtensionResult = {
  extensions: [
    {
      source: 'github',
      status: 'stopped',
      config: {
        source: 'github',
        globallyEnabled: false,
        capabilities: { webhooks: true, polling: false, rpcConfig: true },
      },
    },
  ],
};

const rpcDisabledExtensionResult = {
  extensions: [
    {
      source: 'github',
      status: 'started',
      config: {
        source: 'github',
        globallyEnabled: true,
        capabilities: { webhooks: true, polling: false, rpcConfig: false },
      },
    },
  ],
};

const repoResult = {
  repositories: [
    {
      id: 'repo-1',
      owner: 'acme',
      repo: 'widgets',
      enabled: true,
      webhookEnabled: true,
      pollingEnabled: false,
      webhookSecret: 'configured',
      webhookRemoteId: null,
      webhookUrl: null,
      webhookAutoRegistered: false,
      webhookActive: null,
      webhookLastCheckedAt: null,
      webhookLastError: null,
      webhookConfiguredAt: null,
      lastWebhookAt: null,
      lastPollAt: null,
    },
  ],
};

const pollingOnlyRepoResult = {
  repositories: [
    {
      ...repoResult.repositories[0],
      webhookEnabled: false,
      pollingEnabled: true,
      webhookSecret: null,
    },
  ],
};

const deliveryResult = [
  {
    eventId: 'evt-1',
    deliveryKey: 'delivery-1',
    workflowRunId: 'run-1',
    taskId: 'task-1',
    nodeId: 'node-1',
    agentName: 'coder',
    state: 'failed',
    failureReason: 'agent session missing',
    deliveredAt: null,
    updatedAt: 1_700_000_003_000,
    event: {
      id: 'evt-1',
      spaceId: 'space-1',
      topic: 'github/acme/widgets/pull_request/42.review_submitted',
      occurredAt: 1_700_000_000_000,
      ingestedAt: 1_700_000_001_000,
      source: 'github',
      summary: 'PR #42 review submitted',
      payload: { number: 42, action: 'review_submitted' },
      dedupeKey: 'github:pr:42:review_submitted',
    },
    eventState: 'failed',
    eventCreatedAt: 1_700_000_001_000,
    eventUpdatedAt: 1_700_000_003_000,
  },
];

function setupRequests() {
  mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
  mockRequest.mockImplementation((method) => {
    if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
    if (method === 'space.github.listConfig') {
      return Promise.resolve({ spaceId: 'space-1', source: 'github', enabled: true, settings: {} });
    }
    if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
    return Promise.resolve({});
  });
}

describe('SpaceExternalEventsSettings', () => {
  beforeEach(() => {
    cleanup();
    mockRequest.mockReset();
    mockGetHubIfConnected.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockListExternalEventDeliveries.mockReset();
    mockListExternalEventDeliveries.mockResolvedValue([]);
    mockGetExternalEventQueueHealth.mockReset();
    mockGetExternalEventQueueHealth.mockResolvedValue(null);
  });

  afterEach(() => cleanup());

  it('loads extension status, webhook URL, and watched repositories', async () => {
    setupRequests();
    const { findByText, getAllByText, getByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    expect(await findByText('github')).toBeTruthy();
    expect(getByText('started')).toBeTruthy();
    expect(getByText('acme/widgets')).toBeTruthy();
    expect(getAllByText(/webhook\/github\/space/)).toHaveLength(2);
    expect(mockRequest).toHaveBeenCalledWith('externalEvents.extensions.list', {});
    expect(mockRequest).toHaveBeenCalledWith('space.github.listConfig', { spaceId: 'space-1' });
    expect(mockRequest).toHaveBeenCalledWith('space.github.listWatchedRepos', {
      spaceId: 'space-1',
    });
  });

  it('keeps globally disabled GitHub manageable without calling GitHub RPCs', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list')
        return Promise.resolve(disabledExtensionResult);
      return Promise.reject(new Error('METHOD_NOT_FOUND'));
    });

    const { findByText, queryByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);

    expect(await findByText('github')).toBeTruthy();
    expect(await findByText('stopped')).toBeTruthy();
    expect(queryByText('acme/widgets')).toBeNull();
    expect(mockRequest).not.toHaveBeenCalledWith('space.github.listConfig', expect.anything());
    expect(mockRequest).not.toHaveBeenCalledWith(
      'space.github.listWatchedRepos',
      expect.anything()
    );
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('disables GitHub controls when RPC config capability is disabled', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list')
        return Promise.resolve(rpcDisabledExtensionResult);
      return Promise.reject(new Error('METHOD_NOT_FOUND'));
    });

    const { findByText, getByPlaceholderText, getByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );

    expect(await findByText('github')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')[1]).toHaveProperty('disabled', true);
    expect(getByPlaceholderText('owner/repository')).toHaveProperty('disabled', true);
    expect(getByPlaceholderText('Webhook secret (optional)')).toHaveProperty('disabled', true);
    expect(getByText('Add watch')).toHaveProperty('disabled', true);
    expect(mockRequest).not.toHaveBeenCalledWith('space.github.listConfig', expect.anything());
    expect(mockRequest).not.toHaveBeenCalledWith(
      'space.github.listWatchedRepos',
      expect.anything()
    );
  });

  it('shows delivery log rows and payload detail', async () => {
    setupRequests();
    mockListExternalEventDeliveries.mockResolvedValue(deliveryResult);
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);

    expect(await findByText('github/acme/widgets/pull_request/42.review_submitted')).toBeTruthy();
    expect(screen.getAllByText('failed')).toHaveLength(2);
    expect(getByText('agent session missing')).toBeTruthy();
    fireEvent.click(getByText('PR #42 review submitted'));
    expect(getByText('Payload')).toBeTruthy();
    expect(getByText(/"number": 42/)).toBeTruthy();
    expect(mockListExternalEventDeliveries).toHaveBeenCalledWith({
      spaceId: 'space-1',
      status: '',
      agentName: undefined,
    });
  });

  it('filters deliveries by status and agent', async () => {
    setupRequests();
    const { findByText, getByLabelText, getByPlaceholderText, getByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    await findByText('Event delivery log');

    fireEvent.change(getByLabelText('Delivery status'), { target: { value: 'failed' } });
    await waitFor(() => {
      expect(mockListExternalEventDeliveries).toHaveBeenCalledWith({
        spaceId: 'space-1',
        status: 'failed',
        agentName: undefined,
      });
    });

    fireEvent.input(getByPlaceholderText('filter agent'), { target: { value: 'coder' } });
    fireEvent.click(getByText('Apply'));
    await waitFor(() => {
      expect(mockListExternalEventDeliveries).toHaveBeenCalledWith({
        spaceId: 'space-1',
        status: 'failed',
        agentName: 'coder',
      });
    });
  });

  it('toggles space enablement', async () => {
    setupRequests();
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('github');

    fireEvent.click(getByText('Enabled for this space'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.disable', { spaceId: 'space-1' });
    });
  });

  it('treats missing space config as enabled by default', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') return Promise.resolve(null);
      if (method === 'space.github.listWatchedRepos') return Promise.resolve({ repositories: [] });
      return Promise.resolve({});
    });
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('github');

    fireEvent.click(getByText('Enabled for this space'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.disable', { spaceId: 'space-1' });
    });
  });

  it('updates repository toggles', async () => {
    setupRequests();
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('acme/widgets');

    fireEvent.click(getByText('Polling'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        enabled: true,
        webhookEnabled: true,
        pollingEnabled: true,
      });
    });
  });

  it('ignores stale refresh responses when the space changes', async () => {
    let resolveRepos!: (value: { repositories: typeof repoResult.repositories }) => void;
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method, params) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: params.spaceId,
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos' && params.spaceId === 'space-1') {
        return new Promise((resolve) => {
          resolveRepos = resolve;
        });
      }
      if (method === 'space.github.listWatchedRepos') {
        return Promise.resolve({
          repositories: [{ ...repoResult.repositories[0], id: 'repo-2', owner: 'beta' }],
        });
      }
      return Promise.resolve({});
    });

    const view = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await waitFor(() => expect(resolveRepos).toBeTypeOf('function'));
    view.rerender(<SpaceExternalEventsSettings spaceId="space-2" />);
    resolveRepos(repoResult);

    expect(await view.findByText('beta/widgets')).toBeTruthy();
    await waitFor(() => {
      expect(view.queryByText('acme/widgets')).toBeNull();
    });
  });

  it('does not refresh from stale action closures after the space changes', async () => {
    let resolveDisable!: (value: unknown) => void;
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method, params) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: params.spaceId,
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') {
        return Promise.resolve({
          repositories: [
            {
              ...repoResult.repositories[0],
              owner: params.spaceId === 'space-1' ? 'acme' : 'beta',
            },
          ],
        });
      }
      if (method === 'space.github.disable') {
        return new Promise((resolve) => {
          resolveDisable = resolve;
        });
      }
      return Promise.resolve({});
    });

    const view = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    expect(await view.findByText('acme/widgets')).toBeTruthy();
    fireEvent.click(view.getByText('Enabled for this space'));
    await waitFor(() => expect(resolveDisable).toBeTypeOf('function'));
    view.rerender(<SpaceExternalEventsSettings spaceId="space-2" />);
    expect(await view.findByText('beta/widgets')).toBeTruthy();

    const callCountBeforeStaleResolve = mockRequest.mock.calls.length;
    resolveDisable({});

    await waitFor(() => {
      expect(mockRequest.mock.calls.length).toBe(callCountBeforeStaleResolve);
    });
    expect(view.queryByText('acme/widgets')).toBeNull();
  });

  it('shows connection errors when disconnected', async () => {
    mockGetHubIfConnected.mockReturnValue(null);

    render(<SpaceExternalEventsSettings spaceId="space-1" />);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Not connected to server');
    });
  });

  it('clears stale space-scoped data when disconnected', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      return Promise.resolve({});
    });
    const view = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    expect(await view.findByText('acme/widgets')).toBeTruthy();

    mockGetHubIfConnected.mockReturnValue(null);
    view.rerender(<SpaceExternalEventsSettings spaceId="space-2" />);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Not connected to server');
      expect(view.queryByText('acme/widgets')).toBeNull();
    });
  });

  it('clears busy state after stale action closures complete', async () => {
    let resolveDisable!: (value: unknown) => void;
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method, params) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: params.spaceId,
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.disable') {
        return new Promise((resolve) => {
          resolveDisable = resolve;
        });
      }
      return Promise.resolve({});
    });

    const view = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await view.findByText('acme/widgets');
    fireEvent.click(view.getByText('Enabled for this space'));
    await waitFor(() => expect(resolveDisable).toBeTypeOf('function'));
    view.rerender(<SpaceExternalEventsSettings spaceId="space-2" />);
    resolveDisable({});

    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[1]).toHaveProperty('disabled', false);
    });
  });

  it('clears stale space-scoped data when loading fails', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      return Promise.resolve({});
    });
    const view = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    expect(await view.findByText('acme/widgets')).toBeTruthy();

    mockRequest.mockRejectedValue(new Error('boom'));
    view.rerender(<SpaceExternalEventsSettings spaceId="space-2" />);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to load external event sources: boom');
      expect(view.queryByText('acme/widgets')).toBeNull();
    });
  });

  it('toggles global enablement', async () => {
    setupRequests();
    const { findByText, getAllByRole } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('github');

    fireEvent.click(getAllByRole('checkbox')[0]);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('externalEvents.extensions.setGlobalEnabled', {
        source: 'github',
        enabled: false,
      });
    });
  });

  it('adds repository watches with webhooks when a secret is provided', async () => {
    setupRequests();
    const { findByText, getByPlaceholderText, getByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    await findByText('github');

    fireEvent.input(getByPlaceholderText('owner/repository'), { target: { value: 'foo/bar' } });
    fireEvent.input(getByPlaceholderText('Webhook secret (optional)'), {
      target: { value: 'secret' },
    });
    fireEvent.click(getByText('Add watch'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'foo',
        repo: 'bar',
        webhookSecret: 'secret',
        webhookEnabled: true,
        pollingEnabled: false,
      });
    });
  });

  it('adds repository watches with polling when no webhook secret is provided and the space already has polling active', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: { pollingIntent: true },
        });
      }
      if (method === 'space.github.listWatchedRepos') {
        return Promise.resolve(pollingOnlyRepoResult);
      }
      return Promise.resolve({});
    });
    const { findByText, getByPlaceholderText, getByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    await findByText('github');

    fireEvent.input(getByPlaceholderText('owner/repository'), { target: { value: 'foo/bar' } });
    fireEvent.click(getByText('Add watch'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'foo',
        repo: 'bar',
        webhookSecret: undefined,
        webhookEnabled: false,
        pollingEnabled: true,
      });
    });
  });

  it('allows the first polling-only watch after enabling polling in a space with no polling rows', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: { pollingIntent: true },
        });
      }
      if (method === 'space.github.listWatchedRepos') {
        return Promise.resolve({ repositories: [] });
      }
      return Promise.resolve({});
    });
    const { findByText, getByPlaceholderText, getByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    await findByText('github');

    fireEvent.input(getByPlaceholderText('owner/repository'), { target: { value: 'foo/bar' } });
    fireEvent.click(getByText('Add watch'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'foo',
        repo: 'bar',
        webhookSecret: undefined,
        webhookEnabled: false,
        pollingEnabled: true,
      });
    });
  });

  it('requires a webhook secret when space polling is off even if daemon-wide capability is on', async () => {
    setupRequests();
    const { findByText, getByPlaceholderText, getByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    await findByText('github');

    fireEvent.input(getByPlaceholderText('owner/repository'), { target: { value: 'foo/bar' } });
    fireEvent.click(getByText('Add watch'));

    expect(
      await findByText('Webhook secret is required because polling is disabled for this space')
    ).toBeTruthy();
    expect(mockRequest).not.toHaveBeenCalledWith('space.github.watchRepo', expect.anything());
  });

  it('requires a webhook secret when polling capability is disabled', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') {
        return Promise.resolve(pollingDisabledExtensionResult);
      }
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve({ repositories: [] });
      return Promise.resolve({});
    });
    const { findByText, getByPlaceholderText, getByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    await findByText('github');

    fireEvent.input(getByPlaceholderText('owner/repository'), { target: { value: 'foo/bar' } });
    fireEvent.click(getByText('Add watch'));

    expect(
      await findByText('Webhook secret is required because polling is disabled for this space')
    ).toBeTruthy();
    expect(mockRequest).not.toHaveBeenCalledWith('space.github.watchRepo', expect.anything());
  });

  it('disables auto-configure controls when webhook capability is disabled', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') {
        return Promise.resolve(webhooksDisabledExtensionResult);
      }
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') {
        return Promise.resolve({
          repositories: [{ ...repoResult.repositories[0], webhookRemoteId: 123 }],
        });
      }
      return Promise.resolve({});
    });
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('acme/widgets');

    expect(getByText('Auto-configure')).toHaveProperty('disabled', true);
    expect(getByText('Auto-configure webhook')).toHaveProperty('disabled', true);
    expect(getByText('Check webhook')).toHaveProperty('disabled', true);
  });

  it('auto-configures new repositories without a manual secret when polling is disabled', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') {
        return Promise.resolve(pollingDisabledExtensionResult);
      }
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve({ repositories: [] });
      return Promise.resolve({});
    });
    const { findByText, getByPlaceholderText, getByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    await findByText('github');

    fireEvent.input(getByPlaceholderText('owner/repository'), { target: { value: 'foo/bar' } });
    fireEvent.click(getByText('Auto-configure'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'foo',
        repo: 'bar',
      });
    });
    expect(mockRequest).not.toHaveBeenCalledWith('space.github.watchRepo', expect.anything());
  });

  it('blocks repo toggles that remove every working delivery mode', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(pollingOnlyRepoResult);
      return Promise.resolve({});
    });
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('acme/widgets');

    fireEvent.click(getByText('Polling'));

    expect(mockToastError).toHaveBeenCalledWith(
      'Repository watch needs webhooks with a secret or polling enabled'
    );
    expect(mockRequest).not.toHaveBeenCalledWith('space.github.watchRepo', expect.anything());
  });

  it('disables repo polling toggles when polling capability is disabled', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') {
        return Promise.resolve(pollingDisabledExtensionResult);
      }
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      return Promise.resolve({});
    });
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('acme/widgets');

    expect(screen.getAllByRole('checkbox').at(-1)).toHaveProperty('disabled', true);
  });

  it('auto-configures webhooks for watched repositories', async () => {
    setupRequests();
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('acme/widgets');

    fireEvent.click(getByText('Auto-configure webhook'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Configured GitHub webhook for acme/widgets');
    });
  });

  it('checks auto-configured webhook status', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') {
        return Promise.resolve({
          repositories: [
            { ...repoResult.repositories[0], webhookRemoteId: 123, webhookActive: true },
          ],
        });
      }
      if (method === 'space.github.checkWebhook') {
        return Promise.resolve({
          watchedRepo: { ...repoResult.repositories[0], webhookRemoteId: 123, webhookActive: true },
        });
      }
      return Promise.resolve({});
    });
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('webhook active');

    fireEvent.click(getByText('Check webhook'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.checkWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('GitHub webhook is active for acme/widgets');
  });

  it('reports inactive auto-configured webhook status', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') {
        return Promise.resolve({
          repositories: [
            { ...repoResult.repositories[0], webhookRemoteId: 123, webhookActive: false },
          ],
        });
      }
      if (method === 'space.github.checkWebhook') {
        return Promise.resolve({
          watchedRepo: {
            ...repoResult.repositories[0],
            webhookRemoteId: 123,
            webhookActive: false,
            webhookLastError: 'GitHub webhook URL does not match this HyperNeo endpoint',
          },
        });
      }
      return Promise.resolve({});
    });
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('webhook inactive');

    fireEvent.click(getByText('Check webhook'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'GitHub webhook is inactive for acme/widgets: GitHub webhook URL does not match this HyperNeo endpoint'
      );
    });
    expect(mockToastSuccess).not.toHaveBeenCalledWith('GitHub webhook is active for acme/widgets');
  });

  it('disables row actions during webhook setup', async () => {
    let resolveAutoConfigure!: (value: unknown) => void;
    setupRequests();
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.autoConfigureWebhook') {
        return new Promise((resolve) => {
          resolveAutoConfigure = resolve;
        });
      }
      return Promise.resolve({});
    });
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('acme/widgets');

    fireEvent.click(getByText('Auto-configure webhook'));
    await waitFor(() => expect(resolveAutoConfigure).toBeTypeOf('function'));

    expect(getByText('Remove')).toHaveProperty('disabled', true);
    expect(getByText('Enabled').closest('label')?.querySelector('input')).toHaveProperty(
      'disabled',
      true
    );
    resolveAutoConfigure({});
  });

  it('shows auto-configure webhook errors', async () => {
    setupRequests();
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.autoConfigureWebhook') {
        return Promise.reject(new Error('GITHUB_TOKEN is required to configure GitHub webhooks'));
      }
      return Promise.resolve({});
    });
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('acme/widgets');

    fireEvent.click(getByText('Auto-configure webhook'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Failed to configure webhook for acme/widgets: GITHUB_TOKEN is required to configure GitHub webhooks'
      );
    });
  });

  it('removes watched repositories', async () => {
    setupRequests();
    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('acme/widgets');

    fireEvent.click(getByText('Remove'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.unwatchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
    });
  });

  it('shows the GitHub connection card when RPC config is enabled', async () => {
    setupRequests();
    const { findByTestId } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    expect(await findByTestId('github-connection-card')).toBeTruthy();
  });

  it('hides the GitHub connection card when RPC config is disabled', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list')
        return Promise.resolve(rpcDisabledExtensionResult);
      return Promise.resolve({});
    });
    const { queryByTestId } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await waitFor(() => {
      expect(queryByTestId('github-connection-card')).toBeNull();
    });
  });

  it('saves a token through the keychain RPC and refreshes status', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    let statusCalls = 0;
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.getTokenStatus') {
        statusCalls++;
        if (statusCalls === 1) return Promise.resolve({ configured: false, source: 'none' });
        return Promise.resolve({
          configured: true,
          source: 'keychain',
          login: 'octocat',
        });
      }
      if (method === 'space.github.setToken') return Promise.resolve({ success: true });
      return Promise.resolve({});
    });

    const { findByPlaceholderText, getByText, findByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    await findByText('github');

    const input = await findByPlaceholderText('ghp_…');
    fireEvent.input(input, { target: { value: 'ghp_saved_token_value' } });
    fireEvent.click(getByText('Save token'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.setToken', {
        token: 'ghp_saved_token_value',
      });
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('GitHub token saved to keychain');
    });
    expect(await findByText('octocat')).toBeTruthy();
  });

  it('disconnects a configured token', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true)
    );
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    let cleared = false;
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.getTokenStatus') {
        if (cleared) return Promise.resolve({ configured: false, source: 'none' });
        return Promise.resolve({
          configured: true,
          source: 'keychain',
          login: 'octocat',
        });
      }
      if (method === 'space.github.clearToken') {
        cleared = true;
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({});
    });

    const { findByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('octocat');

    fireEvent.click(await findByText('Disconnect'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.clearToken', {});
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('GitHub token removed');
    });
    vi.unstubAllGlobals();
  });

  it('toggles space-level polling capability through RPC', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    let pollingEnabled = false;
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') {
        return Promise.resolve({
          extensions: [
            {
              source: 'github',
              status: 'started',
              config: {
                source: 'github',
                globallyEnabled: true,
                capabilities: {
                  webhooks: true,
                  polling: pollingEnabled,
                  rpcConfig: true,
                },
              },
            },
          ],
        });
      }
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.getTokenStatus') {
        return Promise.resolve({ configured: false, source: 'none' });
      }
      if (method === 'space.github.setPollingEnabled') {
        pollingEnabled = true;
        return Promise.resolve({ spaceId: 'space-1', pollingEnabled: true });
      }
      return Promise.resolve({});
    });

    const { findByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    const checkbox = await findByText('Polling for this space (daemon-wide capability)');

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.setPollingEnabled', {
        spaceId: 'space-1',
        enabled: true,
      });
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(
        'GitHub polling enabled (daemon-wide capability)'
      );
    });
  });

  it('reports daemon-wide capability in the polling checkbox label', async () => {
    setupRequests();
    const { findByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    expect(await findByText('Polling for this space (daemon-wide capability)')).toBeTruthy();
  });

  it('prompts for confirmation before overwriting an existing keychain token', async () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.getTokenStatus') {
        return Promise.resolve({
          configured: true,
          source: 'keychain',
          login: 'octocat',
        });
      }
      return Promise.resolve({});
    });

    const { findByText, getByText, getByPlaceholderText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    await findByText('octocat');

    fireEvent.click(getByText('Replace token'));
    const input = getByPlaceholderText('ghp_…');
    fireEvent.input(input, { target: { value: 'ghp_replacement_token_value' } });
    fireEvent.click(getByText('Replace token'));

    expect(confirmSpy).toHaveBeenCalledWith('Replace the existing daemon-wide GitHub token?');
    expect(mockRequest).not.toHaveBeenCalledWith('space.github.setToken', {
      token: 'ghp_replacement_token_value',
    });
    vi.unstubAllGlobals();
  });

  it('overwrites the keychain token after user confirms', async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.getTokenStatus') {
        return Promise.resolve({
          configured: true,
          source: 'keychain',
          login: 'octocat',
        });
      }
      if (method === 'space.github.setToken') return Promise.resolve({ success: true });
      return Promise.resolve({});
    });

    const { findByText, getByText, getByPlaceholderText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    await findByText('octocat');

    fireEvent.click(getByText('Replace token'));
    fireEvent.input(getByPlaceholderText('ghp_…'), {
      target: { value: 'ghp_replacement_token_value' },
    });
    fireEvent.click(getByText('Replace token'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.github.setToken', {
        token: 'ghp_replacement_token_value',
      });
    });
    vi.unstubAllGlobals();
  });

  it('confirms before disconnecting an existing keychain token', async () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.getTokenStatus') {
        return Promise.resolve({
          configured: true,
          source: 'keychain',
          login: 'octocat',
        });
      }
      return Promise.resolve({});
    });

    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('octocat');

    fireEvent.click(getByText('Disconnect'));

    expect(confirmSpy).toHaveBeenCalledWith(
      'Remove the daemon-wide GitHub token from the keychain?'
    );
    expect(mockRequest).not.toHaveBeenCalledWith('space.github.clearToken', {});
    vi.unstubAllGlobals();
  });

  it('warns about auto-registered hooks in other spaces before disconnecting', async () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve({ repositories: [] });
      if (method === 'space.github.getTokenStatus') {
        return Promise.resolve({
          configured: true,
          source: 'keychain',
          login: 'octocat',
          autoRegisteredHookCount: 3,
        });
      }
      return Promise.resolve({});
    });

    const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    await findByText('octocat');

    fireEvent.click(getByText('Disconnect'));

    expect(confirmSpy).toHaveBeenCalledWith(
      'Remove the daemon-wide GitHub token from the keychain? 3 auto-registered webhook(s) across all spaces may become unmanageable until a token is restored.'
    );
    expect(mockRequest).not.toHaveBeenCalledWith('space.github.clearToken', {});
    vi.unstubAllGlobals();
  });

  it('renders an error state when getTokenStatus RPC fails', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.getTokenStatus') {
        return Promise.reject(new Error('credential store offline'));
      }
      return Promise.resolve({});
    });

    const { findByTestId, queryByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    expect(await findByTestId('github-token-status-error')).toBeTruthy();
    expect(queryByText('Checking token status…')).toBeNull();
  });

  it('does not block the panel while token status loads', async () => {
    let resolveTokenStatus!: (value: { configured: boolean; source: string }) => void;
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.getTokenStatus') {
        return new Promise((resolve) => {
          resolveTokenStatus = resolve;
        });
      }
      return Promise.resolve({});
    });

    const { findByText, queryByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
    expect(await findByText('acme/widgets')).toBeTruthy();
    expect(queryByText('Loading external event sources…')).toBeNull();
    resolveTokenStatus({ configured: false, source: 'none' });
  });

  it('renders an invalid-token state when getTokenStatus returns an error', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.getTokenStatus') {
        return Promise.resolve({
          configured: true,
          source: 'keychain',
          login: 'octocat',
          error: 'HTTP 401',
        });
      }
      return Promise.resolve({});
    });

    const { findByText, findByTestId, queryByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    expect(await findByText('Token invalid')).toBeTruthy();
    expect(await findByTestId('github-token-invalid-error')).toBeTruthy();
    expect(await findByText('Replace invalid token')).toBeTruthy();
    expect(queryByText('Connected')).toBeNull();
  });

  it('disables connection card controls when the panel is disabled', async () => {
    setupRequests();
    const { findByText } = render(<SpaceExternalEventsSettings spaceId="space-1" disabled />);
    const checkbox = await findByText('Polling for this space (daemon-wide capability)');
    const pollingInput = checkbox.closest('label')?.querySelector('input');
    expect(pollingInput).toHaveProperty('disabled', true);
  });

  it('confirms before shadowing an env-sourced token with a keychain token', async () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method) => {
      if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
      if (method === 'space.github.listConfig') {
        return Promise.resolve({
          spaceId: 'space-1',
          source: 'github',
          enabled: true,
          settings: {},
        });
      }
      if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
      if (method === 'space.github.getTokenStatus') {
        return Promise.resolve({
          configured: true,
          source: 'env',
          login: 'env-user',
          error: 'HTTP 401',
        });
      }
      return Promise.resolve({});
    });

    const { findByPlaceholderText, getByText } = render(
      <SpaceExternalEventsSettings spaceId="space-1" />
    );
    const input = await findByPlaceholderText('ghp_…');
    fireEvent.input(input, { target: { value: 'ghp_replacement_token_value' } });
    fireEvent.click(getByText('Save token'));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/GITHUB_TOKEN env var/));
    expect(mockRequest).not.toHaveBeenCalledWith('space.github.setToken', {
      token: 'ghp_replacement_token_value',
    });
    vi.unstubAllGlobals();
  });
});
