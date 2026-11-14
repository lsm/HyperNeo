// @ts-nocheck

import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetWorkspaceHistory, mockGetGitBranches, mockAddFolderToProject } = vi.hoisted(() => ({
  mockGetWorkspaceHistory: vi.fn(),
  mockGetGitBranches: vi.fn(),
  mockAddFolderToProject: vi.fn(),
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
  addFolderToProject: mockAddFolderToProject,
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
  return screen.getAllByText(
    (_, element) => element?.getAttribute('title') === '/code' || false
  )[0];
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

  it('adds a folder to the selected project from the folder menu', async () => {
    newChatProjectSignal.value = '/code';
    render(<SessionsPage />);
    await waitFor(() => expect(folderChip().textContent).toContain('code'));
    expect(screen.queryByRole('menuitem', { name: /Add folder/ })).toBeNull();
    fireEvent.click(folderChip());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add folder to code…' }));
    fireEvent.input(screen.getByPlaceholderText('Folder path'), { target: { value: '/assets' } });
    mockAddFolderToProject.mockResolvedValue(undefined);
    fireEvent.submit(screen.getByPlaceholderText('Folder path').closest('form'));
    await waitFor(() => expect(mockAddFolderToProject).toHaveBeenCalledWith('/code', '/assets'));
    await waitFor(() => expect(screen.queryByPlaceholderText('Folder path')).toBeNull());
    expect(folderChip().textContent).toContain('code');
  });

  it('keeps the folder form open with the reason when the daemon refuses', async () => {
    newChatProjectSignal.value = '/code';
    render(<SessionsPage />);
    await waitFor(() => expect(folderChip().textContent).toContain('code'));
    fireEvent.click(folderChip());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add folder to code…' }));
    fireEvent.input(screen.getByPlaceholderText('Folder path'), { target: { value: '/taken' } });
    mockAddFolderToProject.mockRejectedValue(
      new Error('Folder already belongs to another project.')
    );
    fireEvent.submit(screen.getByPlaceholderText('Folder path').closest('form'));
    expect(await screen.findByText('Folder already belongs to another project.')).toBeTruthy();
    expect(screen.getByPlaceholderText('Folder path')).toBeTruthy();
  });
});
