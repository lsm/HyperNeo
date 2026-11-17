// @ts-nocheck

import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetWorkspaceHistory,
  mockGetGitBranches,
  mockAddFolderToProject,
  mockListProviders,
  modelFixture,
} = vi.hoisted(() => ({
  mockGetWorkspaceHistory: vi.fn(),
  mockGetGitBranches: vi.fn(),
  mockAddFolderToProject: vi.fn(),
  mockListProviders: vi.fn(),
  modelFixture: { models: [] },
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
  listProviders: mockListProviders,
  getWorkspaceHistory: mockGetWorkspaceHistory,
  getGitBranches: mockGetGitBranches,
  addWorkspaceToHistory: vi.fn(),
  addFolderToProject: mockAddFolderToProject,
}));

vi.mock('../../hooks/useModelSwitcher.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  findDefaultModel: () => null,
  useModelSwitcher: () => ({
    availableModels: modelFixture.models,
    loading: false,
    reload: vi.fn(),
  }),
}));

vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHubIfConnected: () => null },
}));

import { newChatProjectSignal, workspaceHistoryVersionSignal } from '../../lib/signals';
import { SessionsPage } from '../SessionsPage';
import { createSession } from '../../lib/api-helpers.ts';

function folderChip() {
  return screen.getAllByText(
    (_, element) => element?.getAttribute('title') === '/code' || false
  )[0];
}

describe('SessionsPage', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    modelFixture.models = [];
    mockListProviders.mockResolvedValue({ providers: [] });
    newChatProjectSignal.value = null;
    workspaceHistoryVersionSignal.value = 0;
    mockGetWorkspaceHistory.mockResolvedValue([
      { path: '/code', lastUsedAt: 1, useCount: 1 },
      { path: '/other', lastUsedAt: 1, useCount: 1 },
    ]);
    mockGetGitBranches.mockResolvedValue({ isGitRepo: false, branches: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('omits persisted thinking for an OXAP provider', async () => {
    modelFixture.models = [
      {
        id: 'codex',
        name: 'Codex model',
        alias: 'codex',
        provider: 'anthropic-codex',
        available: true,
      },
      {
        id: 'sonnet',
        name: 'Sonnet model',
        alias: 'sonnet',
        provider: 'anthropic',
        available: true,
      },
    ];
    mockListProviders.mockResolvedValue({
      providers: [
        { providerId: 'anthropic-codex', configJson: JSON.stringify({ harness: 'oxap-codex' }) },
        { providerId: 'anthropic' },
      ],
    });
    vi.mocked(localStorage.getItem).mockReturnValue(
      JSON.stringify({
        model: { id: 'codex', provider: 'anthropic-codex' },
        thinkingLevel: 'off',
      })
    );
    vi.mocked(createSession).mockReturnValue(new Promise(() => {}));
    render(<SessionsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose model and thinking' }));
    await waitFor(() => expect(screen.queryByRole('slider')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Sonnet model/ }));
    await waitFor(() => expect(screen.getByRole('slider')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Codex model/ }));
    await waitFor(() => expect(screen.queryByRole('slider')).toBeNull());
    fireEvent.input(screen.getByPlaceholderText('Ask anything to start a new chat...'), {
      target: { value: 'Hello' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start chat' }).disabled).toBe(false)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith({
        config: { model: 'codex', provider: 'anthropic-codex' },
      })
    );
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('keeps the thinking control and sends the persisted selection for SDK providers', async () => {
    modelFixture.models = [
      {
        id: 'sonnet',
        name: 'Sonnet model',
        alias: 'sonnet',
        provider: 'anthropic',
        available: true,
      },
    ];
    mockListProviders.mockResolvedValue({ providers: [{ providerId: 'anthropic' }] });
    vi.mocked(localStorage.getItem).mockReturnValue(
      JSON.stringify({
        model: { id: 'sonnet', provider: 'anthropic' },
        thinkingLevel: 'off',
      })
    );
    vi.mocked(createSession).mockReturnValue(new Promise(() => {}));
    render(<SessionsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose model and thinking' }));
    expect(screen.getByRole('slider')).toBeTruthy();
    fireEvent.input(screen.getByPlaceholderText('Ask anything to start a new chat...'), {
      target: { value: 'Hello' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start chat' }).disabled).toBe(false)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith({
        config: { model: 'sonnet', provider: 'anthropic', thinkingLevel: 'off' },
      })
    );
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
    expect(workspaceHistoryVersionSignal.value).toBe(1);
    expect(folderChip().textContent).toContain('code');
  });

  it('adds the folder to the project whose menu opened the form after the sidebar switches', async () => {
    newChatProjectSignal.value = '/code';
    render(<SessionsPage />);
    await waitFor(() => expect(folderChip().textContent).toContain('code'));
    fireEvent.click(folderChip());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add folder to code…' }));
    newChatProjectSignal.value = '/other';
    await waitFor(() =>
      expect(
        screen.getAllByText((_, element) => element?.getAttribute('title') === '/other' || false)[0]
          .textContent
      ).toContain('other')
    );
    expect(screen.getByText(/Adds a folder to code/)).toBeTruthy();
    fireEvent.input(screen.getByPlaceholderText('Folder path'), {
      target: { value: '/assets' },
    });
    mockAddFolderToProject.mockResolvedValue(undefined);
    fireEvent.submit(screen.getByPlaceholderText('Folder path').closest('form'));
    await waitFor(() => expect(mockAddFolderToProject).toHaveBeenCalledWith('/code', '/assets'));
    expect(mockAddFolderToProject).not.toHaveBeenCalledWith('/other', '/assets');
  });

  it('names the project a folder belongs to, not the folder itself', async () => {
    const project = { id: 'p1', name: 'Product', folders: ['/code', '/docs'] };
    mockGetWorkspaceHistory.mockResolvedValue(
      project.folders.map((path) => ({ path, lastUsedAt: 1, useCount: 1, project }))
    );
    newChatProjectSignal.value = '/docs';
    render(<SessionsPage />);
    const chip = await screen.findByText((_, element) =>
      Boolean(element?.getAttribute('title') === '/docs')
    );
    fireEvent.click(chip);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add folder to Product…' }));
    expect(screen.getByText(/Adds a folder to Product\./)).toBeTruthy();
  });

  it('reloads the folder list when the sidebar changes projects', async () => {
    newChatProjectSignal.value = '/code';
    render(<SessionsPage />);
    await waitFor(() => expect(folderChip().textContent).toContain('code'));
    mockGetWorkspaceHistory.mockResolvedValue([
      { path: '/code', lastUsedAt: 1, useCount: 1 },
      { path: '/added-elsewhere', lastUsedAt: 2, useCount: 1 },
    ]);
    workspaceHistoryVersionSignal.value += 1;
    fireEvent.click(
      await screen.findByText((_, element) => Boolean(element?.getAttribute('title') === '/code'))
    );
    expect(await screen.findByRole('menuitem', { name: 'added-elsewhere' })).toBeTruthy();
  });

  it('refuses a folder form whose project was removed while it was open', async () => {
    mockGetWorkspaceHistory.mockResolvedValue([
      { path: '/code', lastUsedAt: 1, useCount: 1 },
      { path: '/gone', lastUsedAt: 1, useCount: 1 },
    ]);
    newChatProjectSignal.value = '/gone';
    render(<SessionsPage />);
    const goneChip = await screen.findByText((_, element) =>
      Boolean(element?.getAttribute('title') === '/gone')
    );
    fireEvent.click(goneChip);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add folder to gone…' }));
    mockGetWorkspaceHistory.mockResolvedValue([{ path: '/code', lastUsedAt: 1, useCount: 1 }]);
    workspaceHistoryVersionSignal.value += 1;
    await waitFor(() => expect(mockGetWorkspaceHistory).toHaveBeenCalledTimes(2));
    fireEvent.input(screen.getByPlaceholderText('Folder path'), { target: { value: '/assets' } });
    fireEvent.submit(screen.getByPlaceholderText('Folder path').closest('form'));
    expect(await screen.findByText(/gone is no longer a project/)).toBeTruthy();
    expect(mockAddFolderToProject).not.toHaveBeenCalled();
  });

  it('refuses the form when the removed project was the only one', async () => {
    mockGetWorkspaceHistory.mockResolvedValue([{ path: '/gone', lastUsedAt: 1, useCount: 1 }]);
    newChatProjectSignal.value = '/gone';
    render(<SessionsPage />);
    const goneChip = await screen.findByText((_, element) =>
      Boolean(element?.getAttribute('title') === '/gone')
    );
    fireEvent.click(goneChip);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add folder to gone…' }));
    mockGetWorkspaceHistory.mockResolvedValue([]);
    workspaceHistoryVersionSignal.value += 1;
    await waitFor(() => expect(mockGetWorkspaceHistory).toHaveBeenCalledTimes(2));
    fireEvent.input(screen.getByPlaceholderText('Folder path'), { target: { value: '/assets' } });
    fireEvent.submit(screen.getByPlaceholderText('Folder path').closest('form'));
    expect(await screen.findByText(/gone is no longer a project/)).toBeTruthy();
    expect(mockAddFolderToProject).not.toHaveBeenCalled();
  });

  it('refuses the form when the project was removed before the page reloaded', async () => {
    mockGetWorkspaceHistory.mockResolvedValue([
      { path: '/code', lastUsedAt: 1, useCount: 1 },
      { path: '/gone', lastUsedAt: 1, useCount: 1 },
    ]);
    newChatProjectSignal.value = '/gone';
    render(<SessionsPage />);
    const goneChip = await screen.findByText((_, element) =>
      Boolean(element?.getAttribute('title') === '/gone')
    );
    fireEvent.click(goneChip);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add folder to gone…' }));
    mockGetWorkspaceHistory.mockResolvedValue([{ path: '/code', lastUsedAt: 1, useCount: 1 }]);
    fireEvent.input(screen.getByPlaceholderText('Folder path'), { target: { value: '/assets' } });
    fireEvent.submit(screen.getByPlaceholderText('Folder path').closest('form'));
    expect(await screen.findByText(/gone is no longer a project/)).toBeTruthy();
    expect(mockAddFolderToProject).not.toHaveBeenCalled();
  });

  it('refuses when the current list cannot be read and the last one lacks the project', async () => {
    mockGetWorkspaceHistory.mockResolvedValue([
      { path: '/code', lastUsedAt: 1, useCount: 1 },
      { path: '/gone', lastUsedAt: 1, useCount: 1 },
    ]);
    newChatProjectSignal.value = '/gone';
    render(<SessionsPage />);
    const goneChip = await screen.findByText((_, element) =>
      Boolean(element?.getAttribute('title') === '/gone')
    );
    fireEvent.click(goneChip);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add folder to gone…' }));
    mockGetWorkspaceHistory.mockResolvedValueOnce([{ path: '/code', lastUsedAt: 1, useCount: 1 }]);
    workspaceHistoryVersionSignal.value += 1;
    await waitFor(() => expect(mockGetWorkspaceHistory).toHaveBeenCalledTimes(2));
    mockGetWorkspaceHistory.mockRejectedValueOnce(new Error('Disconnected'));
    fireEvent.input(screen.getByPlaceholderText('Folder path'), { target: { value: '/assets' } });
    fireEvent.submit(screen.getByPlaceholderText('Folder path').closest('form'));
    expect(await screen.findByText(/Could not check its project for this folder/)).toBeTruthy();
    expect(mockAddFolderToProject).not.toHaveBeenCalled();
  });

  it('still adds a folder when the history never loaded', async () => {
    mockGetWorkspaceHistory.mockRejectedValue(new Error('Disconnected'));
    newChatProjectSignal.value = '/code';
    render(<SessionsPage />);
    await waitFor(() =>
      expect(
        screen.getAllByText((_, element) => Boolean(element?.getAttribute('title') === '/code'))[0]
      ).toBeTruthy()
    );
    fireEvent.click(
      screen.getAllByText((_, element) => Boolean(element?.getAttribute('title') === '/code'))[0]
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add folder to code…' }));
    fireEvent.input(screen.getByPlaceholderText('Folder path'), { target: { value: '/assets' } });
    mockAddFolderToProject.mockResolvedValue(undefined);
    fireEvent.submit(screen.getByPlaceholderText('Folder path').closest('form'));
    await waitFor(() => expect(mockAddFolderToProject).toHaveBeenCalledWith('/code', '/assets'));
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
