// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/preact';

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockListExternalEventDeliveries = vi.fn();

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

  it('adds repository watches with polling when no webhook secret is provided', async () => {
    setupRequests();
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
      await findByText('Webhook secret is required because polling is disabled for GitHub')
    ).toBeTruthy();
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
        webhookUrl: expect.stringMatching(/^http:\/\/localhost:\d+\/webhook\/github\/space$/),
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
});
