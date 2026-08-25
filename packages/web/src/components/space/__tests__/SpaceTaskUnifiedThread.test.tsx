// @ts-nocheck

import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceTaskUnifiedThread } from '../SpaceTaskUnifiedThread';

let mockRows = [];
let mockIsLoading = false;
let mockIsReconnecting = false;

let lastAutoScrollMessageCount;
let lastAutoScrollResetKey;

vi.mock('../../../hooks/useSpaceTaskMessages', () => ({
  useSpaceTaskMessages: () => ({
    rows: mockRows,
    isLoading: mockIsLoading,
    isReconnecting: mockIsReconnecting,
  }),
}));

vi.mock('../../../hooks/useAutoScroll', () => ({
  useAutoScroll: (opts) => {
    lastAutoScrollMessageCount = opts.messageCount;
    lastAutoScrollResetKey = opts.resetKey;
    return { showScrollButton: false, scrollToBottom: () => {}, isNearBottom: true };
  },
}));

vi.mock('../../chat/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

function makeRow(
  id: string,
  label: string,
  message: unknown,
  createdAt: number,
  sessionId = 'space:space-1:task:task-1'
) {
  return {
    id,
    sessionId,
    kind: 'task_agent',
    role: 'task',
    label,
    taskId: 'task-1',
    taskTitle: 'Task One',
    messageType: typeof message === 'object' ? (message as any).type : 'assistant',
    content: JSON.stringify(message),
    createdAt,
  };
}

function makeMinimalRows() {
  return [
    makeRow(
      'u1',
      'Task Agent',
      {
        type: 'user',
        uuid: 'u1',
        session_id: 'space:space-1:task:task-1',
        message: { content: 'Initial ask' },
      },
      1
    ),
    makeRow(
      'a1',
      'Task Agent',
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'old-1' }] } },
      2
    ),
    makeRow(
      'a2',
      'Coder Agent',
      { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'old-2' }] } },
      3
    ),
  ];
}

describe('SpaceTaskUnifiedThread', () => {
  beforeEach(() => {
    cleanup();
    mockRows = makeMinimalRows();
    mockIsLoading = false;
    mockIsReconnecting = false;
  });

  afterEach(() => cleanup());

  it('renders MinimalThreadFeed with one turn per agent block', () => {
    render(<SpaceTaskUnifiedThread taskId="task-1" />);

    expect(screen.getByTestId('space-task-event-feed-minimal')).toBeTruthy();
    expect(screen.getAllByTestId('minimal-thread-turn').length).toBeGreaterThan(0);
  });

  it('reports the actual scroll container to the parent', () => {
    const onScrollerChange = vi.fn();
    render(<SpaceTaskUnifiedThread taskId="task-1" onScrollerChange={onScrollerChange} />);

    const scroller = screen.getByTestId('space-task-unified-thread').firstElementChild;
    expect(scroller).toBeInstanceOf(HTMLDivElement);
    expect(onScrollerChange).toHaveBeenCalledWith(scroller);
  });

  it('applies bottom scroll padding to the scroll container', () => {
    render(
      <SpaceTaskUnifiedThread
        taskId="task-1"
        bottomInsetClass="pb-44 sm:pb-36"
        bottomScrollPaddingClass="scroll-pb-44 sm:scroll-pb-36"
      />
    );

    const scroller = screen.getByTestId('space-task-unified-thread').firstElementChild!;
    expect(scroller.className).toContain('pb-44 sm:pb-36');
    expect(scroller.className).toContain('scroll-pb-44 sm:scroll-pb-36');
  });

  it('does not render the legacy floating agent-name tag', () => {
    render(<SpaceTaskUnifiedThread taskId="task-1" />);
    expect(screen.queryByTestId('agent-name-tag')).toBeNull();
  });

  it('shows loading state when loading', () => {
    mockIsLoading = true;
    mockRows = [];
    render(<SpaceTaskUnifiedThread taskId="task-1" />);
    expect(screen.getByText('Loading task thread…')).toBeTruthy();
  });

  it('shows reconnecting state when reconnecting', () => {
    mockIsReconnecting = true;
    mockRows = [];
    render(<SpaceTaskUnifiedThread taskId="task-1" />);
    expect(screen.getByText('Reconnecting task thread…')).toBeTruthy();
  });

  it('shows empty state when no rows', () => {
    mockRows = [];
    render(<SpaceTaskUnifiedThread taskId="task-1" />);
    expect(screen.getByText('No task-agent activity yet.')).toBeTruthy();
  });

  describe('useAutoScroll messageCount during task switch', () => {
    it('passes messageCount 0 (not stale rows.length) while loading', () => {
      mockIsLoading = true;
      mockRows = makeMinimalRows();
      render(<SpaceTaskUnifiedThread taskId="task-2" />);
      expect(lastAutoScrollMessageCount).toBe(0);
      expect(lastAutoScrollResetKey).toBe('task-2');
    });

    it('passes messageCount 0 while reconnecting', () => {
      mockIsReconnecting = true;
      mockRows = makeMinimalRows();
      render(<SpaceTaskUnifiedThread taskId="task-1" />);
      expect(lastAutoScrollMessageCount).toBe(0);
    });

    it('passes a positive content version when not loading or reconnecting', () => {
      mockRows = makeMinimalRows();
      render(<SpaceTaskUnifiedThread taskId="task-1" />);
      expect(lastAutoScrollMessageCount).toBeGreaterThan(0);
    });

    it('increments messageCount when the window advances at a constant row count', () => {
      mockRows = makeMinimalRows();
      const { rerender } = render(<SpaceTaskUnifiedThread taskId="task-1" />);
      const before = lastAutoScrollMessageCount;
      const windowSize = mockRows.length;
      expect(before).toBeGreaterThan(0);

      const advanced = [
        ...mockRows.slice(1),
        makeRow(
          'a-new',
          'Task Agent',
          { type: 'assistant', message: { content: [{ type: 'text', text: 'newest' }] } },
          4000
        ),
      ];
      expect(advanced).toHaveLength(windowSize);
      mockRows = advanced;
      rerender(<SpaceTaskUnifiedThread taskId="task-1" />);

      expect(lastAutoScrollMessageCount).toBe(before + 1);
    });
  });

  describe('rate-limit cooldown banner', () => {
    it('renders a pinned countdown + Retry/Cancel banner per cooldown member', () => {
      const retryAt = Date.now() + 60_000;
      render(
        <SpaceTaskUnifiedThread
          taskId="task-1"
          cooldownBannerMembers={[
            {
              sessionId: 'worker-1',
              label: 'Coder Agent',
              retryCount: 2,
              maxRetries: 5,
              retryAt,
            },
          ]}
        />
      );

      const banner = screen.getByTestId('space-thread-cooldown-banner');
      expect(banner).toBeTruthy();
      expect(banner.textContent).toContain('Coder Agent');
      expect(screen.getByText('Retry Now')).toBeTruthy();
      expect(screen.getByText('Cancel')).toBeTruthy();
    });

    it('does not render the banner stack when there are no cooldown members', () => {
      render(<SpaceTaskUnifiedThread taskId="task-1" />);
      expect(screen.queryByTestId('space-task-thread-banner-stack')).toBeNull();
    });
  });

  describe('provider auth-error banner', () => {
    it('renders a re-authenticate affordance per auth-error member', () => {
      render(
        <SpaceTaskUnifiedThread
          taskId="task-1"
          authErrorBannerMembers={[
            {
              sessionId: 'worker-1',
              label: 'Coder Agent',
              message: 'Anthropic authentication failed.',
              providerId: 'anthropic',
            },
          ]}
        />
      );

      const banner = screen.getByTestId('space-thread-auth-error-banner');
      expect(banner).toBeTruthy();
      expect(banner.textContent).toContain('Coder Agent');
      expect(banner.textContent).toContain('Anthropic authentication failed.');
      expect(screen.getByText('Re-authenticate Anthropic')).toBeTruthy();
    });
  });
});
