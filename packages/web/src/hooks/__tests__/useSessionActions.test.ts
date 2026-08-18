// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { Session } from '@hyperneo/shared';
import { useSessionActions } from '../useSessionActions.ts';

const mockConnectionState = signal<'connected' | 'disconnected' | 'connecting'>('connected');

vi.mock('../../lib/state', () => ({
  connectionState: {
    get value() {
      return mockConnectionState.value;
    },
  },
}));

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => mockGetHubIfConnected(),
  },
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('../../lib/toast', () => ({
  toast: {
    success: (msg: string) => mockToastSuccess(msg),
    error: (msg: string) => mockToastError(msg),
  },
}));

const mockDeleteSession = vi.fn();
const mockListSessions = vi.fn();
const mockArchiveSession = vi.fn();
const mockResetSessionQuery = vi.fn();

vi.mock('../../lib/api-helpers', () => ({
  deleteSession: (sessionId: string) => mockDeleteSession(sessionId),
  listSessions: () => mockListSessions(),
  archiveSession: (sessionId: string, force: boolean) => mockArchiveSession(sessionId, force),
  resetSessionQuery: (sessionId: string) => mockResetSessionQuery(sessionId),
}));

const { mockCurrentSessionIdSignal, mockSessionsSignal } = vi.hoisted(() => ({
  mockCurrentSessionIdSignal: { value: 'session-1' as string | null },
  mockSessionsSignal: { value: [] as Session[] },
}));

vi.mock('../../lib/signals', () => ({
  currentSessionIdSignal: mockCurrentSessionIdSignal,
  sessionsSignal: mockSessionsSignal,
}));

describe('useSessionActions', () => {
  const defaultSession: Session = {
    id: 'session-1',
    title: 'Test Session',
    status: 'active',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    workspacePath: '/test',
    config: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockConnectionState.value = 'connected';
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({ success: true });
    mockDeleteSession.mockResolvedValue({});
    mockListSessions.mockResolvedValue({ sessions: [] });
    mockArchiveSession.mockResolvedValue({ success: true });
    mockResetSessionQuery.mockResolvedValue({ success: true });
    mockCurrentSessionIdSignal.value = 'session-1';
    mockSessionsSignal.value = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize with default state', () => {
      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      expect(result.current.archiving).toBe(false);
      expect(result.current.resettingAgent).toBe(false);
      expect(result.current.archiveConfirmDialog).toBeNull();
    });

    it('should provide all action handlers', () => {
      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      expect(typeof result.current.handleDeleteSession).toBe('function');
      expect(typeof result.current.handleArchiveClick).toBe('function');
      expect(typeof result.current.handleConfirmArchive).toBe('function');
      expect(typeof result.current.handleCancelArchive).toBe('function');
      expect(typeof result.current.handleResetAgent).toBe('function');
      expect(typeof result.current.handleExportChat).toBe('function');
    });
  });

  describe('handleDeleteSession', () => {
    it('should delete session successfully', async () => {
      const onDeleteModalClose = vi.fn();
      const updatedSessions = [{ id: 'session-2', title: 'Other Session' }];
      mockListSessions.mockResolvedValue({ sessions: updatedSessions });

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose,
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleDeleteSession();
      });

      expect(onDeleteModalClose).toHaveBeenCalled();
      expect(mockDeleteSession).toHaveBeenCalledWith('session-1');
      expect(mockListSessions).toHaveBeenCalled();
      expect(mockSessionsSignal.value).toEqual(updatedSessions);
      expect(mockToastSuccess).toHaveBeenCalledWith('Session deleted');

      await act(async () => {
        vi.runAllTimers();
      });

      expect(mockCurrentSessionIdSignal.value).toBeNull();
    });

    it('should handle delete error with Error instance', async () => {
      const onDeleteModalClose = vi.fn();
      mockDeleteSession.mockRejectedValue(new Error('Delete failed'));

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose,
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleDeleteSession();
      });

      expect(onDeleteModalClose).not.toHaveBeenCalled();
      expect(mockToastError).toHaveBeenCalledWith('Delete failed');
    });

    it('should handle delete error with non-Error exception', async () => {
      const onDeleteModalClose = vi.fn();
      mockDeleteSession.mockRejectedValue('Unknown error');

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose,
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleDeleteSession();
      });

      expect(mockToastError).toHaveBeenCalledWith('Failed to delete session');
    });
  });

  describe('handleArchiveClick', () => {
    it('should archive session without confirmation', async () => {
      const updatedSessions = [{ id: 'session-2' }];
      mockArchiveSession.mockResolvedValue({ success: true });
      mockListSessions.mockResolvedValue({ sessions: updatedSessions });

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleArchiveClick();
      });

      expect(mockArchiveSession).toHaveBeenCalledWith('session-1', false);
      expect(mockToastSuccess).toHaveBeenCalledWith('Session archived successfully');
      expect(mockSessionsSignal.value).toEqual(updatedSessions);
      expect(result.current.archiving).toBe(false);
    });

    it('should show confirmation dialog when required', async () => {
      mockArchiveSession.mockResolvedValue({
        requiresConfirmation: true,
        commitStatus: { uncommittedChanges: true, aheadOfRemote: 2 },
      });

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleArchiveClick();
      });

      expect(result.current.archiveConfirmDialog).toEqual({
        show: true,
        commitStatus: { uncommittedChanges: true, aheadOfRemote: 2 },
      });
      expect(mockToastSuccess).not.toHaveBeenCalled();
    });

    it('should handle archive error with Error instance', async () => {
      mockArchiveSession.mockRejectedValue(new Error('Archive failed'));

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleArchiveClick();
      });

      expect(mockToastError).toHaveBeenCalledWith('Archive failed');
      expect(result.current.archiving).toBe(false);
    });

    it('should handle archive error with non-Error exception', async () => {
      mockArchiveSession.mockRejectedValue('Unknown error');

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleArchiveClick();
      });

      expect(mockToastError).toHaveBeenCalledWith('Failed to archive session');
    });

    it('should set archiving state during operation', async () => {
      mockArchiveSession.mockResolvedValue({ success: true });

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      expect(result.current.archiving).toBe(false);

      await act(async () => {
        await result.current.handleArchiveClick();
      });

      expect(result.current.archiving).toBe(false);
      expect(mockArchiveSession).toHaveBeenCalledWith('session-1', false);
    });
  });

  describe('handleConfirmArchive', () => {
    it('should confirm archive successfully', async () => {
      const updatedSessions = [{ id: 'session-2' }];
      mockArchiveSession.mockResolvedValue({ success: true, commitsRemoved: 3 });
      mockListSessions.mockResolvedValue({ sessions: updatedSessions });

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleConfirmArchive();
      });

      expect(mockArchiveSession).toHaveBeenCalledWith('session-1', true);
      expect(mockToastSuccess).toHaveBeenCalledWith('Session archived (3 commits removed)');
      expect(result.current.archiveConfirmDialog).toBeNull();
      expect(mockSessionsSignal.value).toEqual(updatedSessions);
    });

    it('should handle confirm archive error with Error instance', async () => {
      mockArchiveSession.mockRejectedValue(new Error('Confirm failed'));

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleConfirmArchive();
      });

      expect(mockToastError).toHaveBeenCalledWith('Confirm failed');
      expect(result.current.archiving).toBe(false);
    });

    it('should handle confirm archive error with non-Error exception', async () => {
      mockArchiveSession.mockRejectedValue('Unknown error');

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleConfirmArchive();
      });

      expect(mockToastError).toHaveBeenCalledWith('Failed to archive session');
    });

    it('should not update sessions if result.success is false', async () => {
      mockArchiveSession.mockResolvedValue({ success: false });

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleConfirmArchive();
      });

      expect(mockToastSuccess).not.toHaveBeenCalled();
      expect(mockListSessions).not.toHaveBeenCalled();
    });
  });

  describe('handleCancelArchive', () => {
    it('should clear archive confirm dialog', () => {
      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      act(() => {
        result.current.handleCancelArchive();
      });

      expect(result.current.archiveConfirmDialog).toBeNull();
    });
  });

  describe('handleResetAgent', () => {
    it('should reset agent successfully', async () => {
      const onStateReset = vi.fn();

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset,
        })
      );

      await act(async () => {
        await result.current.handleResetAgent();
      });

      expect(mockResetSessionQuery).toHaveBeenCalledWith('session-1');
      expect(mockToastSuccess).toHaveBeenCalledWith('Agent reset successfully.');
      expect(onStateReset).toHaveBeenCalled();
      expect(result.current.resettingAgent).toBe(false);
    });

    it('should handle reset agent failure', async () => {
      mockResetSessionQuery.mockResolvedValue({ success: false, error: 'Reset failed' });

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleResetAgent();
      });

      expect(mockToastError).toHaveBeenCalledWith('Reset failed');
    });

    it('should handle reset agent failure without error message', async () => {
      mockResetSessionQuery.mockResolvedValue({ success: false });

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleResetAgent();
      });

      expect(mockToastError).toHaveBeenCalledWith('Failed to reset agent');
    });

    it('should not reset when disconnected', async () => {
      mockConnectionState.value = 'disconnected';

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleResetAgent();
      });

      expect(mockToastError).toHaveBeenCalledWith('Not connected to server');
      expect(mockResetSessionQuery).not.toHaveBeenCalled();
    });

    it('should handle no hub connection (resetSessionQuery throws)', async () => {
      mockResetSessionQuery.mockRejectedValue(new Error('Not connected to server'));

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleResetAgent();
      });

      expect(mockToastError).toHaveBeenCalledWith('Not connected to server');
    });

    it('should handle reset agent exception with Error instance', async () => {
      mockResetSessionQuery.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleResetAgent();
      });

      expect(mockToastError).toHaveBeenCalledWith('Network error');
      expect(result.current.resettingAgent).toBe(false);
    });

    it('should handle reset agent exception with non-Error', async () => {
      mockResetSessionQuery.mockRejectedValue('Unknown error');

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleResetAgent();
      });

      expect(mockToastError).toHaveBeenCalledWith('Failed to reset agent');
    });

    it('should set resettingAgent state during operation', async () => {
      let resolveCall: (value: unknown) => void;
      const callPromise = new Promise((resolve) => {
        resolveCall = resolve;
      });
      mockResetSessionQuery.mockImplementation(() => callPromise);

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      act(() => {
        result.current.handleResetAgent();
      });

      await waitFor(() => {
        expect(result.current.resettingAgent).toBe(true);
      });

      await act(async () => {
        resolveCall!({ success: true });
      });

      await waitFor(() => {
        expect(result.current.resettingAgent).toBe(false);
      });
    });
  });

  describe('handleExportChat', () => {
    it('should call export API successfully', async () => {
      mockRequest.mockResolvedValue({ markdown: '# Test Chat\n\nContent here' });

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleExportChat();
      });

      expect(mockRequest).toHaveBeenCalledWith('session.export', {
        sessionId: 'session-1',
        format: 'markdown',
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('Chat exported!');
    });

    it('should not export when disconnected', async () => {
      mockConnectionState.value = 'disconnected';

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleExportChat();
      });

      expect(mockToastError).toHaveBeenCalledWith('Not connected to server');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('should handle no hub connection', async () => {
      mockGetHubIfConnected.mockReturnValue(null);

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleExportChat();
      });

      expect(mockToastError).toHaveBeenCalledWith('Not connected to server');
    });

    it('should handle export error', async () => {
      mockRequest.mockRejectedValue(new Error('Export failed'));

      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.handleExportChat();
      });

      expect(mockToastError).toHaveBeenCalledWith('Failed to export chat');
    });
  });

  describe('function stability', () => {
    it('should return stable handleCancelArchive reference', () => {
      const { result, rerender } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: defaultSession,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      const firstHandleCancelArchive = result.current.handleCancelArchive;

      rerender();

      expect(result.current.handleCancelArchive).toBe(firstHandleCancelArchive);
    });

    it('should update handlers when sessionId changes', () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) =>
          useSessionActions({
            sessionId,
            session: defaultSession,
            onDeleteModalClose: vi.fn(),
            onStateReset: vi.fn(),
          }),
        { initialProps: { sessionId: 'session-1' } }
      );

      const firstHandleDeleteSession = result.current.handleDeleteSession;

      rerender({ sessionId: 'session-2' });

      expect(result.current.handleDeleteSession).not.toBe(firstHandleDeleteSession);
    });
  });

  describe('null session handling', () => {
    it('should handle null session', () => {
      const { result } = renderHook(() =>
        useSessionActions({
          sessionId: 'session-1',
          session: null,
          onDeleteModalClose: vi.fn(),
          onStateReset: vi.fn(),
        })
      );

      expect(result.current.archiving).toBe(false);
      expect(result.current.resettingAgent).toBe(false);
    });
  });
});
