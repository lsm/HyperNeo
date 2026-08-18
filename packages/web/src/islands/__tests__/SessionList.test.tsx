// @ts-nocheck

import type { Session, WorkspaceHistoryEntry } from '@hyperneo/shared';
import { computed, signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockNavigateToSession,
  mockNavigateToSessions,
  mockGetWorkspaceHistory,
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
    mockAddWorkspaceToHistory.mockImplementation(async (path: string) => createHistory(path, 2));
    mockRemoveWorkspaceFromHistory.mockResolvedValue({ success: true });
    mockArchiveSession.mockResolvedValue({ success: true });
    mockHubRequest.mockResolvedValue({ path: '/workspace/new-project' });
    mockGetHubIfConnected.mockReturnValue({ request: mockHubRequest });
    mockGetCollapsedProjects.mockReturnValue(new Set());
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the empty chats state', () => {
    render(<SessionsSidebar />);

    expect(screen.getByText('No chats yet')).toBeTruthy();
    expect(screen.getByText('Start a new chat to begin.')).toBeTruthy();
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

    await waitFor(() => expect(mockArchiveSession).toHaveBeenCalledWith('session-1', false));
    expect(mockToastSuccess).toHaveBeenCalledWith('Chat archived');
  });
});
