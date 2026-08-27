// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();
const mockCreate = vi.fn();

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    get getHubIfConnected() {
      return mockGetHubIfConnected;
    },
  },
}));

vi.mock('../../ui/Modal', () => ({
  Modal: ({ isOpen, children, title, onClose }) => {
    if (!isOpen) return null;
    return (
      <div role="dialog" aria-label={title}>
        <button onClick={onClose} aria-label="Close modal">
          X
        </button>
        {children}
      </div>
    );
  },
}));

vi.mock('../../ui/Button', () => ({
  Button: ({ children, onClick }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

import { useSpaceWorkspaceChoice } from '../SpaceWorkspacePicker';
import { connectionState } from '../../../lib/state';
import type { SpaceWorkspace } from '@hyperneo/shared';

function makeWorkspace(overrides: Partial<SpaceWorkspace> = {}): SpaceWorkspace {
  return {
    id: 'ws-1',
    spaceId: 'space-1',
    path: '/projects/main',
    label: 'Main repo',
    isPrimary: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const SECONDARY = makeWorkspace({
  id: 'ws-2',
  path: '/projects/docs',
  label: 'Docs',
  isPrimary: false,
});

function Probe({
  spaceId,
  fallbackPath,
  scope,
}: {
  spaceId: string;
  fallbackPath?: string | null;
  scope?: string;
}) {
  const { chooseWorkspace, dialog } = useSpaceWorkspaceChoice(spaceId, fallbackPath, scope);
  return (
    <div>
      <button
        data-testid="probe-create"
        onClick={() => chooseWorkspace((workspacePath) => mockCreate(workspacePath))}
      >
        create
      </button>
      {dialog}
    </div>
  );
}

function stubRegistry(handler: (params: { spaceId?: string }) => SpaceWorkspace[]) {
  mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
  mockRequest.mockImplementation((method: string, params: { spaceId?: string }) => {
    if (method === 'space.workspace.list') return Promise.resolve(handler(params));
    return Promise.resolve({});
  });
}

const initialConnectionState = connectionState.value;

describe('SpaceWorkspacePicker', () => {
  beforeEach(() => {
    cleanup();
    mockRequest.mockReset();
    mockGetHubIfConnected.mockReset();
    mockCreate.mockReset();
    connectionState.value = 'connected';
  });

  afterEach(() => {
    cleanup();
    connectionState.value = initialConnectionState;
  });

  it('sources options from the registry primary-first and flows the selection into createSession', async () => {
    stubRegistry(() => [SECONDARY, makeWorkspace()]);
    const { getByTestId, getAllByTestId, getByText } = render(
      <Probe spaceId="space-1" fallbackPath="/projects/main" />
    );
    fireEvent.click(getByTestId('probe-create'));

    const options = await waitFor(() => {
      const found = getAllByTestId('space-workspace-option');
      expect(found.length).toBe(2);
      return found;
    });
    expect(mockRequest).toHaveBeenCalledWith('space.workspace.list', { spaceId: 'space-1' });
    expect(options[0].textContent).toContain('Main repo');
    expect(options[0].textContent).toContain('Primary');
    expect(options[0].textContent).toContain('/projects/main');
    expect(options[1].textContent).toContain('Docs');
    expect(mockCreate).not.toHaveBeenCalled();

    fireEvent.click(getByText('Docs'));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/docs');
    });
    expect(document.querySelector('[data-testid="space-workspace-options"]')).toBeNull();
  });

  it('waits for the registry to settle before offering the workspace choice', async () => {
    let resolveList: (list: SpaceWorkspace[]) => void = () => {};
    const listPromise = new Promise<SpaceWorkspace[]>((resolve) => {
      resolveList = resolve;
    });
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method: string) =>
      method === 'space.workspace.list' ? listPromise : Promise.resolve({})
    );

    const { getByTestId, getByText } = render(
      <Probe spaceId="space-1" fallbackPath="/projects/main" />
    );
    fireEvent.click(getByTestId('probe-create'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="space-workspace-options"]')).toBeNull();

    resolveList([makeWorkspace(), SECONDARY]);
    await waitFor(() => {
      expect(getByTestId('space-workspace-options')).toBeTruthy();
    });
    fireEvent.click(getByText('Docs'));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/docs');
    });
  });

  it('coalesces a burst of clicks while the registry lookup is pending', async () => {
    let resolveList: (list: SpaceWorkspace[]) => void = () => {};
    const listPromise = new Promise<SpaceWorkspace[]>((resolve) => {
      resolveList = resolve;
    });
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method: string) =>
      method === 'space.workspace.list' ? listPromise : Promise.resolve({})
    );

    const { getByTestId } = render(<Probe spaceId="space-1" fallbackPath="/projects/main" />);
    fireEvent.click(getByTestId('probe-create'));
    fireEvent.click(getByTestId('probe-create'));
    fireEvent.click(getByTestId('probe-create'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockCreate).not.toHaveBeenCalled();

    resolveList([makeWorkspace()]);
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
    expect(mockCreate).toHaveBeenCalledWith('/projects/main');
  });

  it('cancels a pending choice when unmounted before the registry settles', async () => {
    let resolveList: (list: SpaceWorkspace[]) => void = () => {};
    const listPromise = new Promise<SpaceWorkspace[]>((resolve) => {
      resolveList = resolve;
    });
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method: string) =>
      method === 'space.workspace.list' ? listPromise : Promise.resolve({})
    );

    const { getByTestId, unmount } = render(
      <Probe spaceId="space-1" fallbackPath="/projects/main" />
    );
    fireEvent.click(getByTestId('probe-create'));
    unmount();
    resolveList([makeWorkspace()]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refetches the registry when starting a choice, picking up mutations from other clients', async () => {
    stubRegistry(() => [makeWorkspace()]);
    const { getByTestId } = render(<Probe spaceId="space-1" fallbackPath="/projects/main" />);
    fireEvent.click(getByTestId('probe-create'));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/main');
    });
    expect(document.querySelector('[data-testid="space-workspace-options"]')).toBeNull();
    mockCreate.mockClear();

    stubRegistry(() => [makeWorkspace(), SECONDARY]);
    fireEvent.click(getByTestId('probe-create'));
    await waitFor(() => {
      expect(getByTestId('space-workspace-options')).toBeTruthy();
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not hang when the connection drops while a refresh lookup is pending', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method: string) =>
      method === 'space.workspace.list' ? new Promise(() => {}) : Promise.resolve({})
    );

    const { getByTestId } = render(<Probe spaceId="space-1" fallbackPath="/projects/main" />);
    fireEvent.click(getByTestId('probe-create'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    connectionState.value = 'disconnected';
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/main');
    });
  });

  it('cancels a pending choice when the choice scope changes', async () => {
    let resolveList: (list: SpaceWorkspace[]) => void = () => {};
    const listPromise = new Promise<SpaceWorkspace[]>((resolve) => {
      resolveList = resolve;
    });
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method: string) =>
      method === 'space.workspace.list' ? listPromise : Promise.resolve({})
    );

    const { getByTestId, rerender } = render(
      <Probe spaceId="space-1" fallbackPath="/projects/main" scope="space-1:sessions" />
    );
    fireEvent.click(getByTestId('probe-create'));
    rerender(<Probe spaceId="space-1" fallbackPath="/projects/main" scope="space-1:overview" />);

    resolveList([makeWorkspace(), SECONDARY]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockCreate).not.toHaveBeenCalled();

    rerender(<Probe spaceId="space-1" fallbackPath="/projects/main" scope="space-1:sessions" />);
    expect(document.querySelector('[data-testid="space-workspace-options"]')).toBeNull();

    fireEvent.click(getByTestId('probe-create'));
    await waitFor(() => {
      expect(getByTestId('space-workspace-options')).toBeTruthy();
    });
  });

  it('resets the cached options and picker state when the space changes', async () => {
    stubRegistry((params) => (params.spaceId === 'space-1' ? [makeWorkspace(), SECONDARY] : []));
    const { getByTestId, rerender } = render(
      <Probe spaceId="space-1" fallbackPath="/projects/main" />
    );
    fireEvent.click(getByTestId('probe-create'));
    await waitFor(() => {
      expect(getByTestId('space-workspace-options')).toBeTruthy();
    });

    rerender(<Probe spaceId="space-2" fallbackPath="/projects/other" />);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="space-workspace-options"]')).toBeNull();
    });
    fireEvent.click(getByTestId('probe-create'));
    expect(mockCreate).not.toHaveBeenCalledWith(undefined);
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/other');
    });
    expect(mockCreate).not.toHaveBeenCalledWith('/projects/docs');
    expect(mockCreate).not.toHaveBeenCalledWith('/projects/main');
  });

  it('refetches registry options after reconnection', async () => {
    connectionState.value = 'disconnected';
    mockGetHubIfConnected.mockReturnValue(null);
    const { getByTestId, getByText } = render(
      <Probe spaceId="space-1" fallbackPath="/projects/main" />
    );
    fireEvent.click(getByTestId('probe-create'));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/main');
    });
    mockCreate.mockClear();

    connectionState.value = 'connected';
    stubRegistry(() => [makeWorkspace(), SECONDARY]);
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.workspace.list', { spaceId: 'space-1' });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    fireEvent.click(getByTestId('probe-create'));
    await waitFor(() => {
      expect(getByTestId('space-workspace-options')).toBeTruthy();
    });
    fireEvent.click(getByText('Docs'));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/docs');
    });
  });

  it('waits for a pending reconnect lookup instead of reusing the stale fallback', async () => {
    connectionState.value = 'disconnected';
    mockGetHubIfConnected.mockReturnValue(null);
    const { getByTestId, getByText } = render(
      <Probe spaceId="space-1" fallbackPath="/projects/main" />
    );
    fireEvent.click(getByTestId('probe-create'));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/main');
    });
    mockCreate.mockClear();

    let resolveList: (list: SpaceWorkspace[]) => void = () => {};
    const listPromise = new Promise<SpaceWorkspace[]>((resolve) => {
      resolveList = resolve;
    });
    connectionState.value = 'connected';
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockImplementation((method: string) =>
      method === 'space.workspace.list' ? listPromise : Promise.resolve({})
    );

    fireEvent.click(getByTestId('probe-create'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="space-workspace-options"]')).toBeNull();

    resolveList([makeWorkspace(), SECONDARY]);
    await waitFor(() => {
      expect(getByTestId('space-workspace-options')).toBeTruthy();
    });
    fireEvent.click(getByText('Docs'));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/docs');
    });
  });

  it('creates directly with the primary workspace when only one is registered', async () => {
    stubRegistry(() => [makeWorkspace()]);
    const { getByTestId } = render(<Probe spaceId="space-1" fallbackPath="/projects/main" />);
    fireEvent.click(getByTestId('probe-create'));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/main');
    });
    expect(document.querySelector('[data-testid="space-workspace-options"]')).toBeNull();
  });

  it('falls back to the space primary path when the registry fails', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockRejectedValue(new Error('registry unavailable'));
    const { getByTestId } = render(<Probe spaceId="space-1" fallbackPath="/projects/main" />);
    fireEvent.click(getByTestId('probe-create'));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/main');
    });
    expect(document.querySelector('[data-testid="space-workspace-options"]')).toBeNull();
  });
});
