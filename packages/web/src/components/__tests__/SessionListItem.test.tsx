// @ts-nocheck

import type { AgentProcessingState, Session } from '@hyperneo/shared';
import { computed, signal } from '@preact/signals';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockStatuses: ReturnType<
  typeof signal<Map<string, { processingState: AgentProcessingState; unreadCount: number }>>
>;

const signalMocks = vi.hoisted(() => ({ currentSessionId: null as unknown }));
vi.mock('../../lib/signals.ts', async () => {
  const { signal } = await import('@preact/signals');
  signalMocks.currentSessionId ??= signal<string | null>(null);
  return {
    get currentSessionIdSignal() {
      return signalMocks.currentSessionId;
    },
    slashCommandsSignal: signal<string[]>([]),
  };
});

vi.mock('../../lib/session-status.ts', () => ({
  get allSessionStatuses() {
    return computed(() => mockStatuses.value);
  },
}));

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

mockStatuses = signal<Map<string, { processingState: AgentProcessingState; unreadCount: number }>>(
  new Map()
);
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
      expect(row.className).toContain('hover:bg-fill-soft');
    });
  });

  describe('Worktree Indicator', () => {
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

      expect(container.querySelector('.text-success')).toBeNull();
      expect(container.querySelector('[title^="Worktree:"]')).toBeNull();
    });
  });

  describe('Archived Status', () => {
    it('should show archived icon when session is archived', () => {
      const archivedSession = { ...mockSession, status: 'archived' as const };
      const { container } = render(
        <SessionListItem session={archivedSession} onSessionClick={mockOnSessionClick} />
      );

      const archivedIcon = container.querySelector('.text-warning');
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

      expect(container.querySelector('[role="img"]')).toBeNull();
      expect(container.querySelector('.bg-accent-hover')).toBeNull();
    });

    it('should show a static lifecycle dot when idle and read', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'idle' }, unreadCount: 0 }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      expect(container.querySelector('.bg-success')).toBeTruthy();
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

      expect(container.querySelector('.bg-accent')).toBeTruthy();
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

      expect(container.querySelector('.bg-success')).toBeTruthy();
    });

    it('should show a yellow dot when queued', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'queued' }, unreadCount: 0 }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      expect(container.querySelector('.bg-warning')).toBeTruthy();
    });

    it('should show a blue unread badge with the count when there are unseen messages', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'idle' }, unreadCount: 3 }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const badge = container.querySelector('.bg-accent-hover');
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toContain('3');

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

      expect(container.querySelector('.bg-success')).toBeTruthy();
      expect(container.querySelector('.animate-pulse')).toBeTruthy();
      expect(container.querySelector('.bg-accent-hover')).toBeNull();
    });

    it('should not pulse for interrupted status', () => {
      mockStatuses.value = new Map([
        ['session-1', { processingState: { status: 'interrupted' }, unreadCount: 0 }],
      ]);

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      expect(container.querySelector('.animate-pulse')).toBeNull();
    });

    it('should fall through to the lifecycle dot for an unrecognized processing status', () => {
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

      expect(container.querySelector('.animate-pulse')).toBeNull();
      expect(container.querySelector('.bg-success')).toBeTruthy();
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
      expect(row?.className).toContain('bg-fill');
      expect(button?.className).toContain('text-fg');
    });

    it('should have inactive styling when not current session', () => {
      mockCurrentSessionId.value = 'other-session';

      const { container } = render(
        <SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
      );

      const row = container.querySelector('[data-testid="session-row"]');
      const button = container.querySelector('[data-testid="session-card"]');
      expect(row?.className).toContain('hover:bg-fill-soft');
      expect(row?.className.split(' ')).not.toContain('bg-fill');
      expect(button?.className).toContain('text-fg-muted');
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
      expect(container.querySelector('input[data-testid="session-rename-input"]')).toBeNull();
      expect(container.querySelector('h3')?.textContent).toBe('Test Session');
    });

    it('hides the hover action (archive) for archived sessions', () => {
      const archivedSession = { ...mockSession, status: 'archived' as const };
      const { container } = render(
        <SessionListItem session={archivedSession} onSessionClick={mockOnSessionClick} />
      );

      expect(container.querySelector('[data-testid="session-archive"]')).toBeNull();
    });
  });
});
