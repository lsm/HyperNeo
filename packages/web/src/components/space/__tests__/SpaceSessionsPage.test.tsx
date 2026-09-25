import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceSessionRow } from '../../../lib/space-store';

const mockSessions = signal<SpaceSessionRow[]>([]);
const mockCreateAgent = vi.fn();
const mockIsAgentOwnedSession = vi.fn();
const mockArchiveSession = vi.fn();
const mockNavigate = vi.fn();
const mockToast = { success: vi.fn(), error: vi.fn() };

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      sessions: mockSessions,
      createAgent: mockCreateAgent,
      isAgentOwnedSession: mockIsAgentOwnedSession,
    };
  },
}));
vi.mock('../../../lib/api-helpers', () => ({
  archiveSession: (...args: unknown[]) => mockArchiveSession(...args),
}));
vi.mock('../../../lib/router', () => ({
  navigateToSpaceSession: (...args: unknown[]) => mockNavigate(...args),
}));
vi.mock('../../../lib/toast', () => ({
  toast: {
    success: (...a: unknown[]) => mockToast.success(...a),
    error: (...a: unknown[]) => mockToast.error(...a),
  },
}));
vi.mock('../../../lib/space-unread', () => ({
  getSpaceSessionUnreadCount: () => 0,
  spaceSessionLastSeen: signal(new Map()),
  syncSpaceSessionSeen: () => {},
}));

import { SpaceSessionsPage } from '../SpaceSessionsPage';

function row(id: string, extra: Partial<SpaceSessionRow> = {}): SpaceSessionRow {
  return { id, title: `Session ${id}`, status: 'active', lastActiveAt: 1, ...extra };
}

describe('SpaceSessionsPage', () => {
  beforeEach(() => {
    mockSessions.value = [];
    mockIsAgentOwnedSession.mockReturnValue(false);
    mockArchiveSession.mockResolvedValue({ success: true });
    mockCreateAgent.mockResolvedValue({ id: 'a1', displayName: 'Session s1' });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('converts an unowned session into an agent bound to that session', async () => {
    mockSessions.value = [row('s1')];
    render(<SpaceSessionsPage spaceId="space-1" />);

    fireEvent.click(screen.getByTestId('space-session-convert'));

    await waitFor(() =>
      expect(mockCreateAgent).toHaveBeenCalledWith({ displayName: 'Session s1', sessionId: 's1' })
    );
    expect(mockToast.success).toHaveBeenCalledWith('Converted into agent Session s1');
  });

  it('hides task-owned worker sessions entirely', () => {
    mockSessions.value = [row('direct-abc:session', { taskId: 't1' }), row('s1')];
    render(<SpaceSessionsPage spaceId="space-1" />);

    expect(screen.getAllByTestId('space-session-item')).toHaveLength(1);
    expect(screen.queryByText('Session direct-abc:session')).toBeNull();
  });

  it('offers no convert action for agent-owned sessions or clones', () => {
    mockIsAgentOwnedSession.mockImplementation((id: string) => id === 'owned');
    mockSessions.value = [row('owned'), row('clone', { parentSessionId: 'owned' })];
    render(<SpaceSessionsPage spaceId="space-1" />);

    expect(screen.queryByTestId('space-session-convert')).toBeNull();
    expect(screen.getAllByTestId('space-session-archive')).toHaveLength(2);
  });

  it('archives a session from its row and explains refusals', async () => {
    mockSessions.value = [row('s1')];
    mockArchiveSession.mockResolvedValueOnce({ success: false, reason: 'agent_primary_session' });
    render(<SpaceSessionsPage spaceId="space-1" />);

    fireEvent.click(screen.getByTestId('space-session-archive'));

    await waitFor(() => expect(mockArchiveSession).toHaveBeenCalledWith('s1', false));
    expect(mockToast.error).toHaveBeenCalledWith(
      'This session belongs to an agent; archive the agent instead'
    );
  });

  it('never force-archives: unmerged commits send the user to the chat', async () => {
    mockSessions.value = [row('s1')];
    mockArchiveSession.mockResolvedValueOnce({
      success: false,
      requiresConfirmation: true,
      commitStatus: { hasCommitsAhead: true, commits: ['abc'] },
    });
    render(<SpaceSessionsPage spaceId="space-1" />);

    fireEvent.click(screen.getByTestId('space-session-archive'));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Archive this session from its chat to review its unmerged commits first'
      )
    );
    expect(mockArchiveSession).toHaveBeenCalledTimes(1);
  });

  it('opens the session when the row is clicked', () => {
    mockSessions.value = [row('s1')];
    render(<SpaceSessionsPage spaceId="space-1" />);

    fireEvent.click(screen.getByTestId('space-session-open'));

    expect(mockNavigate).toHaveBeenCalledWith('space-1', 's1');
  });
});
