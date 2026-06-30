// @ts-nocheck
/**
 * Tests for SessionListItem Component
 *
 * Tests the compact session list item with status indicators, worktree badge,
 * and archived status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/preact';
import { signal, computed } from '@preact/signals';
import type { Session, AgentProcessingState } from '@neokai/shared';

// Define signals after imports - use getters in vi.mock to defer evaluation
let mockStatuses: ReturnType<
  typeof signal<Map<string, { processingState: AgentProcessingState; hasUnread: boolean }>>
>;
let mockCurrentSessionId: ReturnType<typeof signal<string | null>>;

vi.mock('../../lib/session-status.ts', () => ({
  get allSessionStatuses() {
    return computed(() => mockStatuses.value);
  },
  getProcessingPhaseColor: (state: AgentProcessingState) => {
    if (state.status === 'idle' || state.status === 'interrupted') return null;
    if (state.status === 'queued') return { dot: 'bg-yellow-500', text: 'text-yellow-400' };
    if (state.status === 'processing') {
      switch (state.phase) {
        case 'thinking':
          return { dot: 'bg-blue-500', text: 'text-blue-400' };
        case 'streaming':
          return { dot: 'bg-green-500', text: 'text-green-400' };
        default:
          return { dot: 'bg-purple-500', text: 'text-purple-400' };
      }
    }
    return null;
  },
}));

vi.mock('../../lib/signals.ts', () => ({
  get currentSessionIdSignal() {
    return mockCurrentSessionId;
  },
}));

// Inline-rename dependencies (used by useSessionRename via the hooks index).
const renameMocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
  globalStoreUpdate: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../../lib/api-helpers', () => ({ updateSession: renameMocks.updateSession }));
vi.mock('../../lib/global-store', () => ({
  globalStore: { updateSession: renameMocks.globalStoreUpdate },
}));
vi.mock('../../lib/toast', () => ({ toast: { error: renameMocks.toastError } }));

// Initialize signals after mocks are set up
mockStatuses = signal<Map<string, { processingState: AgentProcessingState; hasUnread: boolean }>>(
  new Map()
);
mockCurrentSessionId = signal<string | null>(null);

import SessionListItem from '../SessionListItem';

describe('SessionListItem', () => {
  const mockSession: Session = {
    id: 'session-1',
    title: 'Test Session',
    status: 'active',
    workspacePath: '/test/path',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    metadata: {
      messageCount: 10,
      totalTokens: 5000,
      totalCost: 0.05,
    },
  };

  const mockOnSessionClick = vi.fn(() => {});
  const mockOnArchive = vi.fn(() => {});

  beforeEach(() => {
    cleanup();
    mockOnSessionClick.mockClear();
    mockOnArchive.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render session title', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const title = container.querySelector('h3');
      expect(title?.textContent).toBe('Test Session');
    });

    it('should render "New Session" when title is empty', () => {
      const sessionWithoutTitle = { ...mockSession, title: '' };
      const { container } = render(
        <SessionListItem session={sessionWithoutTitle} onSessionClick={mockOnSessionClick} />
      );

      const title = container.querySelector('h3');
      expect(title?.textContent).toBe('New Session');
    });

    it('does not render metadata in the compact row', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      expect(container.textContent).not.toContain('10');
      expect(container.textContent).not.toContain('5.0k');
      expect(container.textContent).not.toContain('$0.0500');
    });

    it('should render relative time', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // Should contain some time string (e.g., "just now", "1m ago", etc.)
      const text = container.textContent || '';
      expect(text.length).toBeGreaterThan(0);
    });

    it('should have correct data-testid', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const card = container.querySelector('[data-testid="session-card"]');
      expect(card).toBeTruthy();
    });

    it('should have correct data-session-id', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const card = container.querySelector('[data-session-id="session-1"]');
      expect(card).toBeTruthy();
    });
  });

  describe('Click Handling', () => {
    it('should call onSessionClick with session id when clicked', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(mockOnSessionClick).toHaveBeenCalledWith('session-1');
    });

    it('should call onSessionClick only once per click', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(mockOnSessionClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('Active State', () => {
    it('should have styling classes on button', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const button = container.querySelector('button')!;
      expect(button.className).toContain('transition-colors');
      expect(button.className).toContain('flex-1');
    });

    it('should have hover styling for inactive session', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const row = container.querySelector('[data-testid="session-row"]')!;
      expect(row.className).toContain('hover:bg-white/5');
    });
  });

  describe('Worktree Badge', () => {
    it('should show worktree icon when session has worktree', () => {
      const sessionWithWorktree = {
        ...mockSession,
        worktree: {
          path: '/worktree/path',
          branch: 'session/test-branch',
        },
      };
      const { container } = render(
        <SessionListItem session={sessionWithWorktree} onSessionClick={mockOnSessionClick} />
      );

      const worktreeIcon = container.querySelector('.text-green-400');
      expect(worktreeIcon).toBeTruthy();
    });

    it('should not show worktree icon when session has no worktree', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const worktreeIcon = container.querySelector('.text-green-400');
      expect(worktreeIcon).toBeNull();
    });

    it('should have correct title on worktree icon', () => {
      const sessionWithWorktree = {
        ...mockSession,
        worktree: {
          path: '/worktree/path',
          branch: 'session/test-branch',
        },
      };
      const { container } = render(
        <SessionListItem session={sessionWithWorktree} onSessionClick={mockOnSessionClick} />
      );

      const worktreeSpan = container.querySelector('[title="Worktree: session/test-branch"]');
      expect(worktreeSpan).toBeTruthy();
    });
  });

  describe('Archived Status', () => {
    it('should show archived icon when session is archived', () => {
      const archivedSession = { ...mockSession, status: 'archived' as const };
      const { container } = render(
        <SessionListItem session={archivedSession} onSessionClick={mockOnSessionClick} />
      );

      const archivedIcon = container.querySelector('.text-amber-600');
      expect(archivedIcon).toBeTruthy();
    });

    it('should have correct title on archived icon', () => {
      const archivedSession = { ...mockSession, status: 'archived' as const };
      const { container } = render(
        <SessionListItem session={archivedSession} onSessionClick={mockOnSessionClick} />
      );

      const archivedSpan = container.querySelector('[title="Archived session"]');
      expect(archivedSpan).toBeTruthy();
    });

    it('should not show archived icon for active sessions', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const archivedSpan = container.querySelector('[title="Archived session"]');
      expect(archivedSpan).toBeNull();
    });
  });

  describe('Metadata Handling', () => {
    it('should handle zero message count without rendering metadata', () => {
      const sessionWithNoMessages = {
        ...mockSession,
        metadata: { ...mockSession.metadata, messageCount: 0 },
      };
      const { container } = render(
        <SessionListItem session={sessionWithNoMessages} onSessionClick={mockOnSessionClick} />
      );

      expect(container.textContent).toContain('Test Session');
      expect(container.textContent).not.toContain('0');
    });

    it('should handle zero token count without rendering metadata', () => {
      const sessionWithNoTokens = {
        ...mockSession,
        metadata: { ...mockSession.metadata, totalTokens: 0 },
      };
      const { container } = render(
        <SessionListItem session={sessionWithNoTokens} onSessionClick={mockOnSessionClick} />
      );

      expect(container.textContent).toContain('Test Session');
      expect(container.textContent).not.toContain('0');
    });

    it('should handle zero cost without rendering metadata', () => {
      const sessionWithNoCost = {
        ...mockSession,
        metadata: { ...mockSession.metadata, totalCost: 0 },
      };
      const { container } = render(
        <SessionListItem session={sessionWithNoCost} onSessionClick={mockOnSessionClick} />
      );

      expect(container.textContent).toContain('Test Session');
      expect(container.textContent).not.toContain('$0.0000');
    });

    it('should handle large token counts without rendering metadata', () => {
      const sessionWithLargeTokens = {
        ...mockSession,
        metadata: { ...mockSession.metadata, totalTokens: 1500000 },
      };
      const { container } = render(
        <SessionListItem session={sessionWithLargeTokens} onSessionClick={mockOnSessionClick} />
      );

      expect(container.textContent).toContain('Test Session');
      expect(container.textContent).not.toContain('1500.0k');
    });
  });

  describe('Status Indicator', () => {
    beforeEach(() => {
      mockStatuses.value = new Map();
    });

    it('should not show indicator when no status exists', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // No status indicator should be present
      const indicator = container.querySelector('.animate-pulse');
      expect(indicator).toBeNull();
    });

    it('should not show indicator when status is idle', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'idle' }, hasUnread: false }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const indicator = container.querySelector('.animate-pulse');
      expect(indicator).toBeNull();
    });

    it('should show pulsing indicator when processing', () => {
      mockStatuses.value = new Map([
        [
          'session-1',
          { processingState: { status: 'processing', phase: 'thinking' }, hasUnread: false },
        ],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const pulsingIndicator = container.querySelector('.animate-pulse');
      expect(pulsingIndicator).toBeTruthy();
    });

    it('should show blue dot when thinking', () => {
      mockStatuses.value = new Map([
        [
          'session-1',
          { processingState: { status: 'processing', phase: 'thinking' }, hasUnread: false },
        ],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const blueDot = container.querySelector('.bg-blue-500');
      expect(blueDot).toBeTruthy();
    });

    it('should show green dot when streaming', () => {
      mockStatuses.value = new Map([
        [
          'session-1',
          { processingState: { status: 'processing', phase: 'streaming' }, hasUnread: false },
        ],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const greenDot = container.querySelector('.bg-green-500');
      expect(greenDot).toBeTruthy();
    });

    it('should show yellow dot when queued', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'queued' }, hasUnread: false }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const yellowDot = container.querySelector('.bg-yellow-500');
      expect(yellowDot).toBeTruthy();
    });

    it('should show static blue dot when has unread messages', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'idle' }, hasUnread: true }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // Should show blue unread dot
      const unreadDot = container.querySelector('.bg-blue-500');
      expect(unreadDot).toBeTruthy();

      // Should NOT be pulsing (static dot)
      const pulsingDot = container.querySelector('.animate-pulse');
      expect(pulsingDot).toBeNull();
    });

    it('should prioritize processing state over unread', () => {
      mockStatuses.value = new Map([
        [
          'session-1',
          { processingState: { status: 'processing', phase: 'streaming' }, hasUnread: true },
        ],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // Should show green streaming dot (processing takes priority)
      const streamingDot = container.querySelector('.bg-green-500');
      expect(streamingDot).toBeTruthy();

      // Should be pulsing
      const pulsingDot = container.querySelector('.animate-pulse');
      expect(pulsingDot).toBeTruthy();
    });

    it('should show ping animation when processing', () => {
      mockStatuses.value = new Map([
        [
          'session-1',
          { processingState: { status: 'processing', phase: 'thinking' }, hasUnread: false },
        ],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const pingAnimation = container.querySelector('.animate-ping');
      expect(pingAnimation).toBeTruthy();
    });

    it('should not show indicator for interrupted status', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'interrupted' }, hasUnread: false }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const indicator = container.querySelector('.animate-pulse');
      expect(indicator).toBeNull();
    });
  });

  describe('Active Session Styling', () => {
    beforeEach(() => {
      mockCurrentSessionId.value = null;
    });

    it('should have active styling when current session', () => {
      mockCurrentSessionId.value = 'session-1';

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const row = container.querySelector('[data-testid="session-row"]');
      const button = container.querySelector('[data-testid="session-card"]');
      expect(row?.className).toContain('bg-white/10');
      expect(button?.className).toContain('text-gray-100');
    });

    it('should have inactive styling when not current session', () => {
      mockCurrentSessionId.value = 'other-session';

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const row = container.querySelector('[data-testid="session-row"]');
      const button = container.querySelector('[data-testid="session-card"]');
      expect(row?.className).toContain('hover:bg-white/5');
      expect(row?.className).not.toContain('bg-white/10');
      expect(button?.className).toContain('text-gray-400');
    });
  });

  describe('Inline Rename', () => {
    beforeEach(() => {
      renameMocks.updateSession.mockReset();
      renameMocks.globalStoreUpdate.mockReset();
      renameMocks.toastError.mockReset();
      renameMocks.updateSession.mockResolvedValue(undefined);
    });

    it('enters edit mode with the current title seeded on double-click', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const title = container.querySelector('h3')!;
      fireEvent.dblClick(title);

      const input = container.querySelector(
        'input[data-testid="session-rename-input"]'
      ) as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.value).toBe('Test Session');
    });

    it('enters edit mode when the hover pencil is clicked', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      fireEvent.click(container.querySelector('[data-testid="session-rename"]')!);

      const input = container.querySelector('input[data-testid="session-rename-input"]');
      expect(input).toBeTruthy();
    });

    it('commits the new title on Enter and exits edit mode', async () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      fireEvent.click(container.querySelector('[data-testid="session-rename"]')!);
      const input = container.querySelector(
        'input[data-testid="session-rename-input"]'
      ) as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'Renamed' } });

      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' });
      });

      expect(renameMocks.updateSession).toHaveBeenCalledWith('session-1', {
        title: 'Renamed',
        metadata: { titleSetBy: 'user' },
      });
      expect(renameMocks.globalStoreUpdate).toHaveBeenCalledWith('session-1', {
        title: 'Renamed',
      });
      // Edit mode exited — input replaced by the row again.
      expect(container.querySelector('input[data-testid="session-rename-input"]')).toBeNull();
    });

    it('cancels and restores on Escape without committing', async () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      fireEvent.click(container.querySelector('[data-testid="session-rename"]')!);
      const input = container.querySelector(
        'input[data-testid="session-rename-input"]'
      ) as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'Discarded' } });

      await act(async () => {
        fireEvent.keyDown(input, { key: 'Escape' });
      });

      expect(renameMocks.updateSession).not.toHaveBeenCalled();
      // Row is restored (no input).
      expect(container.querySelector('input[data-testid="session-rename-input"]')).toBeNull();
      // Title is unchanged.
      expect(container.querySelector('h3')?.textContent).toBe('Test Session');
    });

    it('does not render the rename affordance for archived sessions', () => {
      const archivedSession = { ...mockSession, status: 'archived' as const };
      const { container } = render(
        <SessionListItem session={archivedSession} onSessionClick={mockOnSessionClick} />
      );

      expect(container.querySelector('[data-testid="session-rename"]')).toBeNull();
    });
  });
});
