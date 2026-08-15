// @ts-nocheck
/**
 * Tests for SessionListItem Component
 *
 * Tests the compact session list item with status indicators, double-click
 * rename, hover archive action, and archived status.
 */

import type { AgentProcessingState, Session } from '@hyperneo/shared';
import { computed, signal } from '@preact/signals';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Define signals after imports - use getters in vi.mock to defer evaluation
let mockStatuses: ReturnType<
  typeof signal<Map<string, { processingState: AgentProcessingState; unreadCount: number }>>
>;

// The currentSessionIdSignal instance must exist during the import phase:
// connection-manager reads it at module-eval time (reached transitively via
// useSessionRename → session-store), before this file's body assigns anything.
const signalMocks = vi.hoisted(() => ({ currentSessionId: null as unknown }));
vi.mock('../../lib/signals.ts', async () => {
  const { signal } = await import('@preact/signals');
  signalMocks.currentSessionId ??= signal<string | null>(null);
  return {
    get currentSessionIdSignal() {
      return signalMocks.currentSessionId;
    },
    // connection-manager exposes this at module-eval time; a plain signal is
    // enough for the import chain to resolve.
    slashCommandsSignal: signal<string[]>([]),
  };
});

vi.mock('../../lib/session-status.ts', () => ({
  get allSessionStatuses() {
    return computed(() => mockStatuses.value);
  },
}));

// Inline-rename dependencies (used by useSessionRename via the hooks index).
const renameMocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
  globalStoreUpdate: vi.fn(),
  spaceStoreUpdate: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../../lib/api-helpers', () => ({ updateSession: renameMocks.updateSession }));
vi.mock('../../lib/global-store', () => ({
  globalStore: { updateSession: renameMocks.globalStoreUpdate },
}));
vi.mock('../../lib/space-store', () => ({
  spaceStore: { updateSession: renameMocks.spaceStoreUpdate },
}));
vi.mock('../../lib/toast', () => ({ toast: { error: renameMocks.toastError } }));

// Initialize signals after mocks are set up
mockStatuses = signal<Map<string, { processingState: AgentProcessingState; unreadCount: number }>>(
  new Map()
);
// currentSessionIdSignal's instance lives in signalMocks (created inside the
// mock factory); expose it under the name tests mutate directly.
const mockCurrentSessionId = signalMocks.currentSessionId as ReturnType<
  typeof signal<string | null>
>;

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

  describe('Worktree Indicator', () => {
    // The green worktree-branch icon was removed from the row — worktree is now
    // the default new-chat mode, so the indicator was always-on noise. The
    // branch name remains visible in the Session info panel.
    it('does not render a worktree indicator even when the session has a worktree', () => {
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

      expect(container.querySelector('.text-green-400')).toBeNull();
      expect(container.querySelector('[title^="Worktree:"]')).toBeNull();
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

    it('should not show an indicator when no status exists', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // No status dot (labeled StatusDot exposes role="img") and no unread badge.
      expect(container.querySelector('[role="img"]')).toBeNull();
      expect(container.querySelector('.bg-blue-600')).toBeNull();
    });

    it('should show a static lifecycle dot when idle and read', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'idle' }, unreadCount: 0 }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // active lifecycle -> success (green) tone, static (no pulse)
      expect(container.querySelector('.bg-green-500')).toBeTruthy();
      expect(container.querySelector('.animate-pulse')).toBeNull();
    });

    it('should show a pulsing indicator when processing', () => {
      mockStatuses.value = new Map([
        [
          'session-1',
          { processingState: { status: 'processing', phase: 'thinking' }, unreadCount: 0 },
        ],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      expect(container.querySelector('.animate-pulse')).toBeTruthy();
    });

    it('should show a blue dot when thinking', () => {
      mockStatuses.value = new Map([
        [
          'session-1',
          { processingState: { status: 'processing', phase: 'thinking' }, unreadCount: 0 },
        ],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // thinking phase -> info (blue) tone
      expect(container.querySelector('.bg-blue-500')).toBeTruthy();
    });

    it('should show a green dot when streaming', () => {
      mockStatuses.value = new Map([
        [
          'session-1',
          { processingState: { status: 'processing', phase: 'streaming' }, unreadCount: 0 },
        ],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // streaming phase -> success (green) tone
      expect(container.querySelector('.bg-green-500')).toBeTruthy();
    });

    it('should show a yellow dot when queued', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'queued' }, unreadCount: 0 }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // queued -> progress (yellow) tone
      expect(container.querySelector('.bg-yellow-500')).toBeTruthy();
    });

    it('should show a blue unread badge with the count when there are unseen messages', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'idle' }, unreadCount: 3 }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // UnreadBadge uses bg-blue-600 and renders the numeric count.
      const badge = container.querySelector('.bg-blue-600');
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toContain('3');

      // Static — no pulse.
      expect(container.querySelector('.animate-pulse')).toBeNull();
    });

    it('should prioritize processing state over unread', () => {
      mockStatuses.value = new Map([
        [
          'session-1',
          { processingState: { status: 'processing', phase: 'streaming' }, unreadCount: 5 },
        ],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // Streaming dot (success/green) wins over the unread badge.
      expect(container.querySelector('.bg-green-500')).toBeTruthy();
      expect(container.querySelector('.animate-pulse')).toBeTruthy();
      // No unread badge rendered while processing.
      expect(container.querySelector('.bg-blue-600')).toBeNull();
    });

    it('should not pulse for interrupted status', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'interrupted' }, unreadCount: 0 }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // interrupted is "at rest" -> falls through to the static lifecycle dot.
      expect(container.querySelector('.animate-pulse')).toBeNull();
    });

    it('should fall through to the lifecycle dot for an unrecognized processing status', () => {
      // Persisted processingState JSON is only cast to the union at the type
      // level, so a legacy/unknown status can reach the indicator. It must not
      // be treated as actively processing (which would pulse a misleading dot
      // and suppress the badge/lifecycle dot) — it falls through to the at-rest
      // path, matching the foundation's unknown-status → idle fallback.
      mockStatuses.value = new Map([
        [
          'session-1',
          {
            processingState: { status: 'schema-v9-running' } as unknown as AgentProcessingState,
            unreadCount: 0,
          },
        ],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // No pulse; falls through to the static active lifecycle dot (green).
      expect(container.querySelector('.animate-pulse')).toBeNull();
      expect(container.querySelector('.bg-green-500')).toBeTruthy();
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
      renameMocks.spaceStoreUpdate.mockReset();
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

    it('does not render an inline rename pencil button', () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      // Rename is via double-click only; the hover pencil was removed.
      expect(container.querySelector('[data-testid="session-rename"]')).toBeNull();
    });

    it('commits the new title on Enter and exits edit mode', async () => {
      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      fireEvent.dblClick(container.querySelector('h3')!);
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

      fireEvent.dblClick(container.querySelector('h3')!);
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

    it('hides the hover action (archive) for archived sessions', () => {
      const archivedSession = { ...mockSession, status: 'archived' as const };
      const { container } = render(
        <SessionListItem session={archivedSession} onSessionClick={mockOnSessionClick} />
      );

      // No row actions render for archived sessions.
      expect(container.querySelector('[data-testid="session-archive"]')).toBeNull();
    });
  });
});
