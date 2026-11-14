// @ts-nocheck

import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetWorkspaceHistory,
  mockGetGitBranches,
  mockAddWorkspaceToHistory,
  mockCreateSession,
} = vi.hoisted(() => ({
  mockGetWorkspaceHistory: vi.fn(),
  mockGetGitBranches: vi.fn(),
  mockAddWorkspaceToHistory: vi.fn(),
  mockCreateSession: vi.fn(),
}));

vi.mock('../../lib/api-helpers.ts', () => ({
  getWorkspaceHistory: mockGetWorkspaceHistory,
  getGitBranches: mockGetGitBranches,
  addWorkspaceToHistory: mockAddWorkspaceToHistory,
  createSession: mockCreateSession,
}));

vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => null,
  },
}));

vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'disconnected' },
  globalSettings: { value: null },
  sessions: { value: [] },
}));

vi.mock('../../lib/toast.ts', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../components/ui/MobileMenuButton.tsx', () => ({
  MobileMenuButton: () => null,
}));

vi.mock('../../components/ModelPicker.tsx', () => ({
  ModelPicker: () => <div data-testid="model-picker" />,
}));

vi.mock('../../hooks/useModelSwitcher.ts', () => ({
  useModelSwitcher: () => ({
    currentModel: '',
    currentModelInfo: null,
    availableModels: [],
    switching: false,
    loading: false,
    switchModel: vi.fn(),
    reload: vi.fn(),
  }),
  findDefaultModel: () => null,
}));

import { pendingNewChatProjectSignal } from '../../lib/signals';
import { SessionsPage } from '../SessionsPage';

describe('SessionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingNewChatProjectSignal.value = null;
    mockGetWorkspaceHistory.mockResolvedValue([]);
    mockGetGitBranches.mockResolvedValue({
      isGitRepo: true,
      gitRoot: '/code',
      currentBranch: 'dev',
      defaultBranch: 'dev',
      branches: ['dev'],
      isDirty: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('opens with the project a sidebar new-session button asked for', async () => {
    render(<SessionsPage />);
    expect(screen.getByTitle('No folder')).toBeTruthy();

    pendingNewChatProjectSignal.value = '/workspace/product';

    await waitFor(() => expect(screen.getByTitle('/workspace/product')).toBeTruthy());
    expect(screen.getByText('product')).toBeTruthy();
    expect(pendingNewChatProjectSignal.value).toBeNull();
  });

  it('keeps the folder choice when no sidebar request is pending', async () => {
    render(<SessionsPage />);

    await waitFor(() => expect(screen.getByTitle('No folder')).toBeTruthy());
    expect(mockGetGitBranches).not.toHaveBeenCalled();
  });
});
