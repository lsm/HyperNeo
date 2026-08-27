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

import { useSpaceWorkspaceChoice, useSpaceWorkspaceOptions } from '../SpaceWorkspacePicker';
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

function Probe({ spaceId, fallbackPath }: { spaceId: string; fallbackPath?: string | null }) {
  const options = useSpaceWorkspaceOptions(spaceId, fallbackPath);
  const { chooseWorkspace, dialog } = useSpaceWorkspaceChoice(spaceId, fallbackPath);
  return (
    <div>
      <span data-testid="probe-option-count">{options.length}</span>
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

function stubRegistry(workspaces: SpaceWorkspace[]) {
  mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
  mockRequest.mockImplementation((method: string) => {
    if (method === 'space.workspace.list') return Promise.resolve(workspaces);
    return Promise.resolve({});
  });
}

describe('SpaceWorkspacePicker', () => {
  beforeEach(() => {
    cleanup();
    mockRequest.mockReset();
    mockGetHubIfConnected.mockReset();
    mockCreate.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('sources options from the registry primary-first and flows the selection into createSession', async () => {
    stubRegistry([
      makeWorkspace({ id: 'ws-2', path: '/projects/docs', label: 'Docs', isPrimary: false }),
      makeWorkspace(),
    ]);
    const { getByTestId, getAllByTestId, getByText } = render(
      <Probe spaceId="space-1" fallbackPath="/projects/main" />
    );
    await waitFor(() => {
      expect(getByTestId('probe-option-count').textContent).toBe('2');
    });
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

  it('creates directly with the primary workspace when only one is registered', async () => {
    stubRegistry([makeWorkspace()]);
    const { getByTestId } = render(<Probe spaceId="space-1" fallbackPath="/projects/main" />);
    await waitFor(() => {
      expect(getByTestId('probe-option-count').textContent).toBe('1');
    });
    fireEvent.click(getByTestId('probe-create'));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/main');
    });
    expect(document.querySelector('[data-testid="space-workspace-options"]')).toBeNull();
  });

  it('falls back to the space primary path when the registry is unavailable', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockRejectedValue(new Error('registry unavailable'));
    const { getByTestId } = render(<Probe spaceId="space-1" fallbackPath="/projects/main" />);
    fireEvent.click(getByTestId('probe-create'));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('/projects/main');
    });
  });
});
