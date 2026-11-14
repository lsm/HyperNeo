// @ts-nocheck

import { signal } from '@preact/signals';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetWorkspaceHistory, mockGetGitBranches } = vi.hoisted(() => ({
  mockGetWorkspaceHistory: vi.fn(),
  mockGetGitBranches: vi.fn(),
}));

vi.mock('../../lib/state.ts', () => ({
  connectionState: signal('connected'),
  globalSettings: signal(null),
  sessions: signal([]),
}));

vi.mock('../../lib/router.ts', () => ({
  navigateToSession: vi.fn(),
}));

vi.mock('../../lib/api-helpers.ts', () => ({
  createSession: vi.fn(),
  getWorkspaceHistory: mockGetWorkspaceHistory,
  getGitBranches: mockGetGitBranches,
  addWorkspaceToHistory: vi.fn(),
}));

vi.mock('../../hooks/useModelSwitcher.ts', () => ({
  findDefaultModel: () => null,
  useModelSwitcher: () => ({ availableModels: [], loading: false, reload: vi.fn() }),
}));

vi.mock('../../components/ModelPicker.tsx', () => ({
  ModelPicker: () => null,
}));

import { newChatProjectSignal } from '../../lib/signals';
import { SessionsPage } from '../SessionsPage';

function folderChip() {
  return screen.getByText((_, element) => element?.getAttribute('title') === '/code' || false);
}

describe('SessionsPage', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    newChatProjectSignal.value = null;
    mockGetWorkspaceHistory.mockResolvedValue([
      { path: '/code', lastUsedAt: 1, useCount: 1 },
      { path: '/other', lastUsedAt: 1, useCount: 1 },
    ]);
    mockGetGitBranches.mockResolvedValue({ isGitRepo: false, branches: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('opens with the folder a sidebar project asked for', async () => {
    newChatProjectSignal.value = '/code';
    render(<SessionsPage />);
    await waitFor(() => expect(folderChip().textContent).toContain('code'));
    expect(newChatProjectSignal.value).toBeNull();
  });

  it('switches an open new-session page to the requested folder', async () => {
    render(<SessionsPage />);
    expect(screen.getAllByText('No folder').length).toBeGreaterThan(0);
    newChatProjectSignal.value = '/code';
    await waitFor(() => expect(folderChip().textContent).toContain('code'));
  });
});
