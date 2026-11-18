// @ts-nocheck

import type { Session, WorkspaceHistoryEntry } from '@hyperneo/shared';
import { computed, signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockNavigateToSession,
  mockNavigateToSessions,
  mockGetWorkspaceHistory,
  mockListSystemProjects,
  mockFindProjectWork,
  mockForgetSystemProject,
  mockAddWorkspaceToHistory,
  mockRemoveWorkspaceFromHistory,
  mockArchiveSession,
  mockGetHubIfConnected,
  mockHubRequest,
  mockToastError,
  mockToastSuccess,
  mockGetCollapsedProjects,
  mockSetCollapsedProjects,
} = vi.hoisted(() => ({
  mockNavigateToSession: vi.fn(),
  mockNavigateToSessions: vi.fn(),
  mockGetWorkspaceHistory: vi.fn(),
  mockListSystemProjects: vi.fn(),
  mockFindProjectWork: vi.fn(),
  mockForgetSystemProject: vi.fn(),
  mockAddWorkspaceToHistory: vi.fn(),
  mockRemoveWorkspaceFromHistory: vi.fn(),
  mockArchiveSession: vi.fn(),
  mockGetHubIfConnected: vi.fn(),
  mockHubRequest: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockGetCollapsedProjects: vi.fn(),
  mockSetCollapsedProjects: vi.fn(),
}));

let mockSessionsSignal: ReturnType<typeof signal<Session[]>>;
let mockSessionStatusesSignal: ReturnType<typeof signal<Map<string, unknown>>>;

vi.mock('../../lib/state.ts', () => ({
  get sessions() {
    return computed(() => mockSessionsSignal.value);
  },
}));

vi.mock('../../lib/router.ts', () => ({
  navigateToSession: mockNavigateToSession,
  navigateToSessions: mockNavigateToSessions,
}));

vi.mock('../../lib/api-helpers.ts', () => ({
  getWorkspaceHistory: mockGetWorkspaceHistory,
  listSystemProjects: mockListSystemProjects,
  findProjectWork: mockFindProjectWork,
  forgetSystemProject: mockForgetSystemProject,
  addWorkspaceToHistory: mockAddWorkspaceToHistory,
  removeWorkspaceFromHistory: mockRemoveWorkspaceFromHistory,
  archiveSession: mockArchiveSession,
}));

vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: mockGetHubIfConnected,
  },
}));

vi.mock('../../lib/toast.ts', () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
  },
}));

vi.mock('../../lib/sidebar-prefs.ts', () => ({
  getCollapsedProjects: mockGetCollapsedProjects,
  setCollapsedProjects: mockSetCollapsedProjects,
}));

vi.mock('../../lib/session-status.ts', () => ({
  get allSessionStatuses() {
    return mockSessionStatusesSignal;
  },
}));

vi.mock('../../components/ArchiveConfirmDialog.tsx', () => ({
  ArchiveConfirmDialog: () => <div data-testid="archive-confirm-dialog" />,
}));

mockSessionsSignal = signal<Session[]>([]);
mockSessionStatusesSignal = signal(new Map());

import {
  currentSessionIdSignal,
  newChatProjectSignal,
  workspaceHistoryVersionSignal,
} from '../../lib/signals';
import { SessionsSidebar } from '../SessionsSidebar';

function createMockSession(
  id: string,
  title: string,
  workspacePath: string | null = null,
  status: 'active' | 'archived' = 'active'
): Session {
  return {
    id,
    title,
    status,
    workspacePath,
    createdAt: '2026-05-16T12:00:00.000Z',
    lastActiveAt: '2026-05-16T12:00:00.000Z',
    metadata: {
      messageCount: 10,
      totalTokens: 5000,
      totalCost: 0.05,
    },
  };
}

function createHistory(path: string, lastUsedAt = 1): WorkspaceHistoryEntry {
  return {
    path,
    lastUsedAt,
    useCount: 1,
  };
}

describe('SessionsSidebar', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockSessionsSignal.value = [];
    mockSessionStatusesSignal.value = new Map();
    mockGetWorkspaceHistory.mockResolvedValue([]);
    mockListSystemProjects.mockResolvedValue([]);
    mockFindProjectWork.mockResolvedValue(false);
    mockForgetSystemProject.mockResolvedValue(undefined);
    mockAddWorkspaceToHistory.mockImplementation(async (path: string) => createHistory(path, 2));
    mockRemoveWorkspaceFromHistory.mockResolvedValue(true);
    mockArchiveSession.mockResolvedValue({ success: true });
    mockHubRequest.mockResolvedValue({ path: '/workspace/new-project' });
    mockGetHubIfConnected.mockReturnValue({ request: mockHubRequest });
    mockGetCollapsedProjects.mockReturnValue(new Set());
    newChatProjectSignal.value = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('opens a new session in the project folder from the project plus button', async () => {
    const project = { id: 'p1', name: 'Product', folders: ['/code', '/docs'] };
    const history = project.folders.map((path) => ({ ...createHistory(path), project }));
    mockSessionsSignal.value = [
      createMockSession('code', 'Code chat', '/code'),
      createMockSession('docs', 'Docs chat', '/docs'),
    ];
    mockGetWorkspaceHistory.mockResolvedValue(history);
    render(<SessionsSidebar />);
    await waitFor(() => expect(screen.getAllByTestId('project-group-header')).toHaveLength(1));
    expect(screen.getByText('Code chat')).toBeTruthy();
    expect(screen.getByText('Docs chat')).toBeTruthy();
    expect(screen.getByText('/code')).toBeTruthy();
    expect(screen.getByText('/docs')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add folder/ })).toBeNull();
    const plus = screen.getByRole('button', { name: 'New session in Product' });
    expect(plus.getAttribute('title')).toBe('New session');
    fireEvent.click(plus);
    expect(mockNavigateToSessions).toHaveBeenCalledTimes(1);
    expect(newChatProjectSignal.value).toBe('/code');
    expect(screen.queryByTestId('add-project-form')).toBeNull();
  });

  it('shows a folder added elsewhere under its project', async () => {
    const project = { id: 'p1', name: 'Product', folders: ['/code', '/docs'] };
    mockGetWorkspaceHistory.mockResolvedValue(
      project.folders.map((path) => ({ ...createHistory(path), project }))
    );
    render(<SessionsSidebar />);
    await waitFor(() => expect(screen.getByText('/docs')).toBeTruthy());
    const expanded = { ...project, folders: [...project.folders, '/assets'] };
    mockGetWorkspaceHistory.mockResolvedValue(
      expanded.folders.map((path) => ({ ...createHistory(path), project: expanded }))
    );
    workspaceHistoryVersionSignal.value += 1;
    expect(await screen.findByText('/assets')).toBeTruthy();
    expect(screen.getAllByTestId('project-group-header')).toHaveLength(1);
  });

  it('refreshes the sidebar after a partial project removal failure and retries only remaining folders', async () => {
    const project = { id: 'p1', name: 'Product', folders: ['/code', '/docs'] };
    mockGetWorkspaceHistory.mockResolvedValue(
      project.folders.map((path) => ({ ...createHistory(path), project }))
    );
    render(<SessionsSidebar />);
    await waitFor(() => expect(screen.getByText('/code')).toBeTruthy());
    const remaining = { ...project, folders: ['/docs'] };
    mockGetWorkspaceHistory.mockResolvedValue([{ ...createHistory('/docs'), project: remaining }]);
    mockRemoveWorkspaceFromHistory
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('Disconnected'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove project Product' }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Failed to remove project'));
    await waitFor(() => expect(screen.queryByText('/code')).toBeNull());
    expect(mockGetWorkspaceHistory).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Remove project Product' })).toBeTruthy();
    mockRemoveWorkspaceFromHistory.mockClear();
    mockGetWorkspaceHistory.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove project Product' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove project Product' })).toBeNull()
    );
    expect(mockRemoveWorkspaceFromHistory.mock.calls).toEqual([['/docs']]);
  });

  it('reports a refused history removal', async () => {
    mockGetWorkspaceHistory.mockResolvedValue([createHistory('/code')]);
    mockRemoveWorkspaceFromHistory.mockResolvedValue(false);
    render(<SessionsSidebar />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove project code' }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Failed to remove project'));
  });

  it('archives every open chat after confirmation and then removes the project', async () => {
    mockSessionsSignal.value = [
      createMockSession('open-1', 'Review one', '/workspace/neo-read'),
      createMockSession('open-2', 'Review two', '/workspace/neo-read'),
      createMockSession('old', 'Old review', '/workspace/neo-read', 'archived'),
    ];
    mockGetWorkspaceHistory.mockResolvedValue([createHistory('/workspace/neo-read')]);
    render(<SessionsSidebar />);
    await waitFor(() => expect(mockGetWorkspaceHistory).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Remove project neo-read' }));
    expect(screen.getByText(/This archives 2 chats in this project/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('project-remove-confirm')).toBeNull();
    expect(mockArchiveSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove project neo-read' }));
    fireEvent.click(screen.getByTestId('project-remove-confirm'));

    await waitFor(() =>
      expect(mockRemoveWorkspaceFromHistory).toHaveBeenCalledWith('/workspace/neo-read')
    );
    expect(mockArchiveSession.mock.calls).toEqual([['open-1'], ['open-2']]);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('keeps the project when a chat needs its own archive decision', async () => {
    mockSessionsSignal.value = [
      createMockSession('clean', 'Clean', '/workspace/neo-read'),
      createMockSession('dirty', 'Dirty', '/workspace/neo-read'),
    ];
    mockArchiveSession
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, requiresConfirmation: true, commitStatus: {} });
    render(<SessionsSidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove project neo-read' }));
    fireEvent.click(screen.getByTestId('project-remove-confirm'));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        '1 chat still needs to be archived one by one before the project can be removed'
      )
    );
    expect(mockArchiveSession).toHaveBeenCalledTimes(2);
    expect(mockRemoveWorkspaceFromHistory).not.toHaveBeenCalled();
    expect(screen.queryByTestId('project-remove-confirm')).toBeNull();
  });

  it('shows every system project, including ones without chats', async () => {
    mockSessionsSignal.value = [createMockSession('chat', 'Review', '/code/neo-read')];
    mockListSystemProjects.mockResolvedValue([
      {
        id: 'p-read',
        name: 'Neo Read',
        folders: ['/code/neo-read', '/code/neo-read-2'],
        updatedAt: 1,
      },
      { id: 'p-idle', name: 'Idle', folders: ['/code/idle'], updatedAt: 2 },
      { id: 'p-section', name: 'Section', folders: [], updatedAt: 3 },
    ]);
    render(<SessionsSidebar />);

    await waitFor(() => expect(screen.getAllByTestId('project-group-header')).toHaveLength(3));
    const names = screen.getAllByTestId('project-group-header').map((row) => row.textContent);
    expect(names).toEqual(['Neo Read', 'Section', 'Idle']);
    expect(screen.getByText('Review')).toBeTruthy();
    expect(screen.queryByText('neo-read')).toBeNull();
    expect(screen.getAllByText('No chats')).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Remove project Neo Read' }).hasAttribute('disabled')
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Remove project Idle' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New session in Idle' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New session in Section' })).toBeNull();
  });

  it('keeps the empty-project control available across unrelated session updates', async () => {
    mockListSystemProjects.mockImplementation(async () => [
      {
        id: 'idle',
        name: 'Idle',
        folders: [],
        updatedAt: 2,
        hasSessions: false,
        unknownWork: false,
      },
    ]);
    render(<SessionsSidebar />);
    const remove = await screen.findByRole('button', { name: 'Remove project Idle' });
    await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false));
    expect(mockFindProjectWork).toHaveBeenCalledTimes(1);
    mockSessionsSignal.value = [createMockSession('chat', 'Other', '/code/other')];
    await screen.findByText('Other');
    await waitFor(() => expect(mockListSystemProjects.mock.calls.length).toBeGreaterThan(1));
    expect(remove.hasAttribute('disabled')).toBe(false);
    expect(mockFindProjectWork).toHaveBeenCalledTimes(1);
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole('button', { name: 'Forget project' }));
    await waitFor(() => expect(mockForgetSystemProject).toHaveBeenCalledWith('idle'));
  });

  it('checks work again after a project stops reporting chats', async () => {
    let hasSessions = false;
    mockListSystemProjects.mockImplementation(async () => [
      {
        id: 'idle',
        name: 'Idle',
        folders: ['/code/idle'],
        updatedAt: 2,
        hasSessions,
        unknownWork: false,
      },
    ]);
    render(<SessionsSidebar />);
    const remove = await screen.findByRole('button', { name: 'Remove project Idle' });
    await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false));
    hasSessions = true;
    mockSessionsSignal.value = [createMockSession('one', 'Other', '/code/other')];
    await waitFor(() =>
      expect(remove.getAttribute('title')).toBe('Project has chats, including archived chats')
    );
    hasSessions = false;
    mockSessionsSignal.value = [createMockSession('two', 'Other', '/code/other')];
    await waitFor(() => expect(mockFindProjectWork).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false));
  });

  it('refuses when a project has work that cannot be checked', async () => {
    mockListSystemProjects.mockResolvedValue([
      {
        id: 'remote',
        name: 'Remote',
        folders: [],
        updatedAt: 1,
        hasSessions: false,
        unknownWork: true,
      },
    ]);
    render(<SessionsSidebar />);
    const remove = await screen.findByRole('button', { name: 'Remove project Remote' });
    expect(remove.hasAttribute('disabled')).toBe(true);
    expect(remove.getAttribute('title')).toBe('Cannot check all work for this project');
  });

  it('adds no empty duplicate when a sidebar project already owns the folders', async () => {
    const project = { id: 'p1', name: 'Product', folders: ['/code'] };
    mockGetWorkspaceHistory.mockResolvedValue([{ ...createHistory('/code'), project }]);
    mockListSystemProjects.mockResolvedValue([
      { id: 'n1', name: 'Product mirror', folders: ['/code'], updatedAt: 5 },
    ]);
    mockSessionsSignal.value = [createMockSession('chat', 'Code chat', '/code')];
    render(<SessionsSidebar />);

    await waitFor(() => expect(mockListSystemProjects).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Product')).toBeTruthy());
    expect(screen.getAllByTestId('project-group-header')).toHaveLength(1);
    expect(screen.queryByText('Product mirror')).toBeNull();
    expect(screen.queryByText('No chats')).toBeNull();
  });

  it('renders the empty chats state', () => {
    render(<SessionsSidebar />);

    expect(screen.getByText('No chats yet')).toBeTruthy();
    expect(screen.getByText('Start a new chat to begin.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy();
  });

  it('opens the new chat landing from the New chat row', () => {
    const onSessionSelect = vi.fn();
    render(<SessionsSidebar onSessionSelect={onSessionSelect} />);

    fireEvent.click(screen.getByTestId('new-chat-button'));

    expect(mockNavigateToSessions).toHaveBeenCalledTimes(1);
    expect(onSessionSelect).toHaveBeenCalledTimes(1);
  });

  it('groups workspace sessions under projects and keeps loose sessions under Chats', () => {
    mockSessionsSignal.value = [
      createMockSession('project-chat', 'Project Chat', '/workspace/hyperneo'),
      createMockSession('loose-chat', 'Loose Chat'),
    ];

    render(<SessionsSidebar />);

    expect(screen.getByText('Projects')).toBeTruthy();
    expect(screen.getByText('hyperneo')).toBeTruthy();
    expect(screen.getByText('Project Chat')).toBeTruthy();
    expect(screen.getByText('Chats')).toBeTruthy();
    expect(screen.getByText('Loose Chat')).toBeTruthy();
  });

  it('nests clones under their parent, marks returned ones, and lists orphans as roots', () => {
    const parent = createMockSession('parent', 'Parent Chat', '/workspace/hyperneo');
    const returned = {
      ...createMockSession('clone-1', 'Parent Chat · 分身', '/workspace/hyperneo'),
      parentSessionId: 'parent',
      metadata: { messageCount: 0, clone: { returnedAt: '2026-09-24T00:00:00.000Z' } },
    };
    const open = {
      ...createMockSession('clone-2', 'Parent Chat · 分身', '/workspace/hyperneo'),
      parentSessionId: 'parent',
      lastActiveAt: '2026-05-17T12:00:00.000Z',
    };
    const orphan = { ...createMockSession('orphan', 'Orphan'), parentSessionId: 'gone' };
    mockSessionsSignal.value = [parent, returned, open, orphan];

    render(<SessionsSidebar />);

    expect(screen.getAllByTestId('session-card')).toHaveLength(2);
    fireEvent.click(
      screen.getByRole('button', { name: 'Show child conversations for Parent Chat' })
    );
    const cards = screen.getAllByTestId('session-card').map((card) => card.textContent);
    expect(cards).toEqual(['Parent Chat', 'Parent Chat 2', 'Parent Chat 3✓', 'Orphan']);
    expect(screen.queryByTestId('session-clone-glyph')).toBeNull();
    expect(screen.getAllByTestId('session-clone-returned')).toHaveLength(1);
    expect(screen.queryByTestId('session-spawn')).toBeNull();
  });

  it('collapses ungrouped child conversations while keeping the selected child visible', () => {
    mockSessionsSignal.value = [
      createMockSession('parent', 'Parent'),
      { ...createMockSession('child', 'Child'), parentSessionId: 'parent' },
      { ...createMockSession('sibling', 'Sibling'), parentSessionId: 'parent' },
    ];
    currentSessionIdSignal.value = 'child';
    render(<SessionsSidebar />);
    expect(screen.getByText('Child')).toBeTruthy();
    expect(screen.queryByText('Sibling')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show child conversations for Parent' }));
    expect(screen.getByText('Sibling')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide child conversations for Parent' }));
    expect(screen.getByText('Child')).toBeTruthy();
    expect(screen.queryByText('Sibling')).toBeNull();
    expect(mockNavigateToSession).not.toHaveBeenCalled();
    currentSessionIdSignal.value = null;
  });

  it('signals unread output from collapsed children without showing counts or spawn actions', () => {
    mockSessionsSignal.value = [
      createMockSession('parent', 'Parent'),
      { ...createMockSession('child', 'Child'), parentSessionId: 'parent' },
    ];
    mockSessionStatusesSignal.value = new Map([
      ['child', { processingState: { status: 'idle' }, unreadCount: 42 }],
    ]);
    render(<SessionsSidebar />);
    expect(screen.getByRole('img', { name: 'Has updates' })).toBeTruthy();
    expect(screen.queryByText('42')).toBeNull();
    expect(screen.queryByTestId('session-spawn')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show child conversations for Parent' }));
    expect(screen.getByRole('img', { name: '42 unread messages' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Has updates' })).toBeNull();
  });

  it('navigates when a session row is selected', () => {
    const onSessionSelect = vi.fn();
    mockSessionsSignal.value = [
      createMockSession('session-1', 'Project Chat', '/workspace/hyperneo'),
    ];

    render(<SessionsSidebar onSessionSelect={onSessionSelect} />);

    fireEvent.click(screen.getByTestId('session-card'));

    expect(mockNavigateToSession).toHaveBeenCalledWith('session-1');
    expect(onSessionSelect).toHaveBeenCalledTimes(1);
  });

  it('loads workspace history so empty projects can be shown', async () => {
    mockGetWorkspaceHistory.mockResolvedValue([createHistory('/workspace/empty-project')]);

    render(<SessionsSidebar />);

    expect(await screen.findByText('empty-project')).toBeTruthy();
    expect(screen.getByText('No chats')).toBeTruthy();
  });

  it('adds a project from a daemon-machine path', async () => {
    mockSessionsSignal.value = [
      createMockSession('session-1', 'Project Chat', '/workspace/hyperneo'),
    ];

    render(<SessionsSidebar />);
    fireEvent.click(screen.getByTestId('add-project-button'));
    fireEvent.input(screen.getByTestId('add-project-path-input'), {
      target: { value: '/workspace/new-project' },
    });
    fireEvent.submit(screen.getByTestId('add-project-form'));

    await waitFor(() =>
      expect(mockAddWorkspaceToHistory).toHaveBeenCalledWith('/workspace/new-project')
    );
    expect(await screen.findByText('new-project')).toBeTruthy();
  });

  it('adds the first project before any chats exist', async () => {
    render(<SessionsSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Projects section' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    fireEvent.input(screen.getByTestId('add-project-path-input'), {
      target: { value: '/workspace/first-project' },
    });
    fireEvent.submit(screen.getByTestId('add-project-form'));

    expect(await screen.findByText('first-project')).toBeTruthy();
    expect(mockAddWorkspaceToHistory).toHaveBeenCalledWith('/workspace/first-project');
  });

  it('collapses projects and loose chats independently', () => {
    mockSessionsSignal.value = [
      createMockSession('project-chat', 'Project Chat', '/workspace/hyperneo'),
      createMockSession('loose-chat', 'Loose Chat'),
    ];
    render(<SessionsSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Projects section' }));

    expect(screen.queryByText('Project Chat')).toBeNull();
    expect(screen.getByText('Loose Chat')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Chats section' }));
    expect(screen.queryByText('Loose Chat')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Projects section' }));
    expect(screen.getByText('Project Chat')).toBeTruthy();
  });

  it('uses native browsing from the add-project control when available', async () => {
    mockSessionsSignal.value = [
      createMockSession('session-1', 'Project Chat', '/workspace/hyperneo'),
    ];
    Object.defineProperty(window, 'isTauri', { value: true, configurable: true });

    try {
      render(<SessionsSidebar />);
      fireEvent.click(screen.getByTestId('add-project-button'));

      await waitFor(() =>
        expect(mockHubRequest).toHaveBeenCalledWith('dialog.pickFolder', undefined, {
          timeout: expect.any(Number),
        })
      );
      expect(mockAddWorkspaceToHistory).toHaveBeenCalledWith('/workspace/new-project');
    } finally {
      Reflect.deleteProperty(window, 'isTauri');
    }
  });

  it('archives a chat after the inline confirmation click', async () => {
    mockSessionsSignal.value = [
      createMockSession('session-1', 'Archivable', '/workspace/hyperneo'),
    ];

    render(<SessionsSidebar />);
    fireEvent.click(screen.getByTestId('session-archive'));
    fireEvent.click(screen.getByTestId('session-archive-confirm'));

    await waitFor(() =>
      expect(mockArchiveSession).toHaveBeenCalledWith('session-1', false, undefined)
    );
    expect(mockToastSuccess).toHaveBeenCalledWith('Chat archived');
  });

  it('asks what to do with clones before archiving a parent', async () => {
    mockSessionsSignal.value = [createMockSession('parent', 'Parent', '/workspace/hyperneo')];
    mockArchiveSession
      .mockResolvedValueOnce({
        success: false,
        reason: 'has_clones',
        clones: [{ id: 'c1', title: 'Parent · 分身' }],
      })
      .mockResolvedValueOnce({ success: true });

    render(<SessionsSidebar />);
    fireEvent.click(screen.getByTestId('session-archive'));
    fireEvent.click(screen.getByTestId('session-archive-confirm'));

    const dialog = await screen.findByTestId('clone-choice-dialog');
    expect(dialog.textContent).toContain('Parent');
    expect(dialog.textContent).not.toContain('分身');
    fireEvent.click(screen.getByTestId('clone-choice-cascade'));

    await waitFor(() =>
      expect(mockArchiveSession).toHaveBeenLastCalledWith('parent', false, 'cascade')
    );
    expect(mockToastSuccess).toHaveBeenCalledWith('Chat archived');
  });
});
