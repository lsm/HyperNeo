// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { MentionToken, parseTextWithReferences } from '../MentionToken';
import type { ReferenceMetadata } from '@hyperneo/shared';

const mockCallIfConnected = vi.fn();

vi.mock('../../../hooks/useMessageHub', () => ({
  useMessageHub: () => ({
    isConnected: false,
    state: 'disconnected',
    getHub: () => null,
    request: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    call: vi.fn(),
    callIfConnected: mockCallIfConnected,
    subscribe: vi.fn(() => () => {}),
    waitForConnection: vi.fn(),
    onConnected: vi.fn(() => () => {}),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockCallIfConnected.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
});

describe('parseTextWithReferences', () => {
  describe('plain text', () => {
    it('returns a single text segment for plain text', () => {
      const result = parseTextWithReferences('Hello world', {});
      expect(result).toEqual([{ kind: 'text', content: 'Hello world' }]);
    });

    it('returns a single text segment for empty string', () => {
      const result = parseTextWithReferences('', {});
      expect(result).toEqual([]);
    });

    it('passes plain @ text as-is (no token)', () => {
      const result = parseTextWithReferences('Hello @user how are you', {});
      expect(result).toEqual([{ kind: 'text', content: 'Hello @user how are you' }]);
    });

    it('passes @ref without braces as plain text', () => {
      const result = parseTextWithReferences('see @ref plain text', {});
      expect(result).toEqual([{ kind: 'text', content: 'see @ref plain text' }]);
    });
  });

  describe('known reference types', () => {
    it('parses @ref{task:t-42} with metadata', () => {
      const metadata: ReferenceMetadata = {
        '@ref{task:t-42}': {
          type: 'task',
          id: 't-42',
          displayText: 'Fix login bug',
          status: 'open',
        },
      };
      const result = parseTextWithReferences('Fix @ref{task:t-42} now', metadata);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ kind: 'text', content: 'Fix ' });
      expect(result[1]).toMatchObject({
        kind: 'mention',
        refType: 'task',
        id: 't-42',
        displayText: 'Fix login bug',
        status: 'open',
      });
      expect(result[2]).toEqual({ kind: 'text', content: ' now' });
    });

    it('parses @ref{goal:g-7} with metadata', () => {
      const metadata: ReferenceMetadata = {
        '@ref{goal:g-7}': { type: 'goal', id: 'g-7', displayText: 'Ship v2' },
      };
      const result = parseTextWithReferences('Work on @ref{goal:g-7}', metadata);
      expect(result).toHaveLength(2);
      expect(result[1]).toMatchObject({ kind: 'mention', refType: 'goal', displayText: 'Ship v2' });
    });

    it('parses @ref{file:src/foo.ts} with metadata', () => {
      const metadata: ReferenceMetadata = {
        '@ref{file:src/foo.ts}': { type: 'file', id: 'src/foo.ts', displayText: 'src/foo.ts' },
      };
      const result = parseTextWithReferences('See @ref{file:src/foo.ts}', metadata);
      expect(result[1]).toMatchObject({ kind: 'mention', refType: 'file', id: 'src/foo.ts' });
    });

    it('parses @ref{folder:src} with metadata', () => {
      const metadata: ReferenceMetadata = {
        '@ref{folder:src}': { type: 'folder', id: 'src', displayText: 'src/' },
      };
      const result = parseTextWithReferences('Browse @ref{folder:src} please', metadata);
      expect(result[1]).toMatchObject({ kind: 'mention', refType: 'folder', displayText: 'src/' });
    });

    it('uses raw id as displayText when metadata is missing', () => {
      const result = parseTextWithReferences('Fix @ref{task:t-99}', {});
      expect(result[1]).toMatchObject({
        kind: 'mention',
        refType: 'task',
        id: 't-99',
        displayText: 't-99',
      });
    });

    it('parses multiple references in one message', () => {
      const metadata: ReferenceMetadata = {
        '@ref{task:t-1}': { type: 'task', id: 't-1', displayText: 'Task One' },
        '@ref{file:a.ts}': { type: 'file', id: 'a.ts', displayText: 'a.ts' },
      };
      const text = 'Do @ref{task:t-1} and see @ref{file:a.ts} for details';
      const result = parseTextWithReferences(text, metadata);
      expect(result).toHaveLength(5);
      expect(result[1]).toMatchObject({ kind: 'mention', refType: 'task' });
      expect(result[3]).toMatchObject({ kind: 'mention', refType: 'file' });
    });

    it('handles reference at start of text', () => {
      const metadata: ReferenceMetadata = {
        '@ref{task:t-1}': { type: 'task', id: 't-1', displayText: 'Task One' },
      };
      const result = parseTextWithReferences('@ref{task:t-1} is done', metadata);
      expect(result[0]).toMatchObject({ kind: 'mention', refType: 'task' });
      expect(result[1]).toEqual({ kind: 'text', content: ' is done' });
    });

    it('handles reference at end of text', () => {
      const metadata: ReferenceMetadata = {
        '@ref{task:t-1}': { type: 'task', id: 't-1', displayText: 'Task One' },
      };
      const result = parseTextWithReferences('Check @ref{task:t-1}', metadata);
      expect(result[0]).toEqual({ kind: 'text', content: 'Check ' });
      expect(result[1]).toMatchObject({ kind: 'mention', refType: 'task' });
    });

    it('handles adjacent references with no text between them', () => {
      const metadata: ReferenceMetadata = {
        '@ref{task:t-1}': { type: 'task', id: 't-1', displayText: 'T1' },
        '@ref{task:t-2}': { type: 'task', id: 't-2', displayText: 'T2' },
      };
      const result = parseTextWithReferences('@ref{task:t-1}@ref{task:t-2}', metadata);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ kind: 'mention', id: 't-1' });
      expect(result[1]).toMatchObject({ kind: 'mention', id: 't-2' });
    });
  });

  describe('unknown reference type', () => {
    it('renders unknown type as unknown-mention segment', () => {
      const result = parseTextWithReferences('See @ref{widget:w-1}', {});
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ kind: 'text', content: 'See ' });
      expect(result[1]).toEqual({ kind: 'unknown-mention', content: '@ref{widget:w-1}' });
    });

    it('does not emit status for unknown type', () => {
      const result = parseTextWithReferences('@ref{custom:abc}', {});
      expect(result[0]).toMatchObject({ kind: 'unknown-mention' });
      expect((result[0] as { kind: string }).kind).not.toBe('mention');
    });
  });

  describe('idempotency', () => {
    it('is safe to call multiple times on the same text (no shared regex state)', () => {
      const text = 'Fix @ref{task:t-1}';
      const metadata: ReferenceMetadata = {
        '@ref{task:t-1}': { type: 'task', id: 't-1', displayText: 'Task One' },
      };
      const result1 = parseTextWithReferences(text, metadata);
      const result2 = parseTextWithReferences(text, metadata);
      expect(result1).toEqual(result2);
    });
  });
});

describe('MentionToken', () => {
  describe('rendering', () => {
    it('renders a token with the correct display text', () => {
      const { container } = render(
        <MentionToken refType="task" id="t-42" displayText="Fix login bug" />
      );
      expect(container.textContent).toContain('Fix login bug');
    });

    it('renders with data-ref-type attribute', () => {
      const { container } = render(<MentionToken refType="goal" id="g-7" displayText="Ship v2" />);
      const token = container.querySelector('[data-testid="mention-token"]');
      expect(token?.getAttribute('data-ref-type')).toBe('goal');
    });

    it('renders with data-ref-id attribute', () => {
      const { container } = render(
        <MentionToken refType="file" id="src/foo.ts" displayText="foo.ts" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      expect(token?.getAttribute('data-ref-id')).toBe('src/foo.ts');
    });

    it('shows type label for task', () => {
      const { container } = render(<MentionToken refType="task" id="t-1" displayText="My Task" />);
      expect(container.textContent).toContain('task');
    });

    it('shows type label for goal', () => {
      const { container } = render(<MentionToken refType="goal" id="g-1" displayText="My Goal" />);
      expect(container.textContent).toContain('goal');
    });

    it('shows type label for file', () => {
      const { container } = render(<MentionToken refType="file" id="f.ts" displayText="f.ts" />);
      expect(container.textContent).toContain('file');
    });

    it('shows type label for folder', () => {
      const { container } = render(<MentionToken refType="folder" id="src" displayText="src/" />);
      expect(container.textContent).toContain('folder');
    });
  });

  describe('hover popover', () => {
    it('does not show popover before hover', () => {
      const { container } = render(
        <MentionToken refType="task" id="t-1" displayText="Task" sessionId="s1" />
      );
      expect(container.querySelector('[data-testid="mention-token-popover"]')).toBeNull();
    });

    it('shows popover on mouse enter', async () => {
      const { container } = render(
        <MentionToken refType="task" id="t-1" displayText="Task" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        expect(container.querySelector('[data-testid="mention-token-popover"]')).toBeTruthy();
      });
    });

    it('hides popover on mouse leave', async () => {
      const { container } = render(
        <MentionToken refType="task" id="t-1" displayText="Task" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);
      await waitFor(() => {
        expect(container.querySelector('[data-testid="mention-token-popover"]')).toBeTruthy();
      });
      fireEvent.mouseLeave(token!);
      expect(container.querySelector('[data-testid="mention-token-popover"]')).toBeNull();
    });

    it('calls reference.resolve RPC on first hover when sessionId is provided', async () => {
      mockCallIfConnected.mockResolvedValue({ resolved: null });

      const { container } = render(
        <MentionToken refType="task" id="t-42" displayText="Task" sessionId="session-123" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        expect(mockCallIfConnected).toHaveBeenCalledWith(
          'reference.resolve',
          expect.objectContaining({ sessionId: 'session-123', type: 'task', id: 't-42' })
        );
      });
    });

    it('does not call RPC when sessionId is absent', async () => {
      const { container } = render(<MentionToken refType="task" id="t-1" displayText="Task" />);
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await new Promise((r) => setTimeout(r, 20));
      expect(mockCallIfConnected).not.toHaveBeenCalled();
    });

    it('does not call RPC again on second hover (result is cached)', async () => {
      mockCallIfConnected.mockResolvedValue({
        resolved: {
          type: 'task',
          id: 't-1',
          data: { title: 'Fix login', status: 'open' },
        },
      });

      const { container } = render(
        <MentionToken refType="task" id="t-1" displayText="Task" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');

      fireEvent.mouseEnter(token!);
      await waitFor(() => {
        expect(mockCallIfConnected).toHaveBeenCalledTimes(1);
      });
      fireEvent.mouseLeave(token!);

      fireEvent.mouseEnter(token!);
      await new Promise((r) => setTimeout(r, 20));
      expect(mockCallIfConnected).toHaveBeenCalledTimes(1);
    });

    it('shows resolved task data in popover', async () => {
      mockCallIfConnected.mockResolvedValue({
        resolved: {
          type: 'task',
          id: 't-1',
          data: { title: 'Fix login bug', status: 'open' },
        },
      });

      const { container } = render(
        <MentionToken refType="task" id="t-1" displayText="Task" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        const popover = container.querySelector('[data-testid="mention-token-popover"]');
        expect(popover?.textContent).toContain('Fix login bug');
        expect(popover?.textContent).toContain('open');
      });
    });

    it('shows resolved goal data in popover', async () => {
      mockCallIfConnected.mockResolvedValue({
        resolved: {
          type: 'goal',
          id: 'g-1',
          data: { title: 'Ship v2', status: 'active' },
        },
      });

      const { container } = render(
        <MentionToken refType="goal" id="g-1" displayText="Goal" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        const popover = container.querySelector('[data-testid="mention-token-popover"]');
        expect(popover?.textContent).toContain('Ship v2');
      });
    });

    it('shows resolved file data in popover', async () => {
      mockCallIfConnected.mockResolvedValue({
        resolved: {
          type: 'file',
          id: 'src/foo.ts',
          data: { path: 'src/foo.ts', size: 2048, binary: false, truncated: false },
        },
      });

      const { container } = render(
        <MentionToken refType="file" id="src/foo.ts" displayText="foo.ts" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        const popover = container.querySelector('[data-testid="mention-token-popover"]');
        expect(popover?.textContent).toContain('src/foo.ts');
        expect(popover?.textContent).toContain('2 KB');
      });
    });

    it('shows binary file indicator in popover', async () => {
      mockCallIfConnected.mockResolvedValue({
        resolved: {
          type: 'file',
          id: 'img.png',
          data: { path: 'img.png', size: 4096, binary: true, truncated: false },
        },
      });

      const { container } = render(
        <MentionToken refType="file" id="img.png" displayText="img.png" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        const popover = container.querySelector('[data-testid="mention-token-popover"]');
        expect(popover?.textContent).toContain('Binary file');
      });
    });

    it('shows resolved folder data in popover', async () => {
      mockCallIfConnected.mockResolvedValue({
        resolved: {
          type: 'folder',
          id: 'src',
          data: {
            path: 'src',
            entries: [
              { name: 'foo.ts', path: 'src/foo.ts', type: 'file' },
              { name: 'bar.ts', path: 'src/bar.ts', type: 'file' },
            ],
          },
        },
      });

      const { container } = render(
        <MentionToken refType="folder" id="src" displayText="src/" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        const popover = container.querySelector('[data-testid="mention-token-popover"]');
        expect(popover?.textContent).toContain('src');
        expect(popover?.textContent).toContain('2 entries');
      });
    });

    it('shows "Not found" when resolved is null', async () => {
      mockCallIfConnected.mockResolvedValue({ resolved: null });

      const { container } = render(
        <MentionToken refType="task" id="t-999" displayText="t-999" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        const popover = container.querySelector('[data-testid="mention-token-popover"]');
        expect(popover?.textContent).toContain('Not found');
      });
    });

    it('shows "Failed to load" on RPC error', async () => {
      mockCallIfConnected.mockRejectedValue(new Error('Network error'));

      const { container } = render(
        <MentionToken refType="task" id="t-1" displayText="Task" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        const popover = container.querySelector('[data-testid="mention-token-popover"]');
        expect(popover?.textContent).toContain('Failed to load');
      });
    });

    it('shows idle state info when no sessionId provided', async () => {
      const { container } = render(<MentionToken refType="task" id="t-1" displayText="Task" />);
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        const popover = container.querySelector('[data-testid="mention-token-popover"]');
        expect(popover?.textContent).toContain('task/t-1');
      });
    });

    it('shows truncated indicator in file popover', async () => {
      mockCallIfConnected.mockResolvedValue({
        resolved: {
          type: 'file',
          id: 'big.ts',
          data: { path: 'big.ts', size: 60000, binary: false, truncated: true },
        },
      });

      const { container } = render(
        <MentionToken refType="file" id="big.ts" displayText="big.ts" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        const popover = container.querySelector('[data-testid="mention-token-popover"]');
        expect(popover?.textContent).toContain('truncated');
      });
    });
  });

  describe('deleted entity visual state', () => {
    it('applies faded strikethrough styling when status is not_found', () => {
      const { container } = render(
        <MentionToken refType="task" id="t-999" displayText="Deleted Task" status="not_found" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      expect(token?.className).toContain('opacity-50');
      expect(token?.className).toContain('line-through');
    });

    it('sets data-not-found attribute when status is not_found', () => {
      const { container } = render(
        <MentionToken refType="task" id="t-999" displayText="Deleted Task" status="not_found" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      expect(token?.getAttribute('data-not-found')).toBe('true');
    });

    it('does not apply deleted styling when status is present and found', () => {
      const { container } = render(
        <MentionToken refType="task" id="t-1" displayText="Task" status="open" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      expect(token?.className).not.toContain('opacity-50');
      expect(token?.className).not.toContain('line-through');
      expect(token?.getAttribute('data-not-found')).toBeNull();
    });

    it('does not apply deleted styling when no status is provided', () => {
      const { container } = render(<MentionToken refType="task" id="t-1" displayText="Task" />);
      const token = container.querySelector('[data-testid="mention-token"]');
      expect(token?.className).not.toContain('opacity-50');
      expect(token?.className).not.toContain('line-through');
    });

    it('applies faded strikethrough styling when RPC resolve returns null', async () => {
      mockCallIfConnected.mockResolvedValue({ resolved: null });

      const { container } = render(
        <MentionToken refType="task" id="t-999" displayText="Deleted Task" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');

      expect(token?.className).not.toContain('opacity-50');

      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        expect(token?.className).toContain('opacity-50');
        expect(token?.className).toContain('line-through');
        expect(token?.getAttribute('data-not-found')).toBe('true');
      });
    });

    it('does not apply deleted styling when RPC resolve returns entity data', async () => {
      mockCallIfConnected.mockResolvedValue({
        resolved: { type: 'task', id: 't-1', data: { title: 'Task', status: 'open' } },
      });

      const { container } = render(
        <MentionToken refType="task" id="t-1" displayText="Task" sessionId="s1" />
      );
      const token = container.querySelector('[data-testid="mention-token"]');
      fireEvent.mouseEnter(token!);

      await waitFor(() => {
        expect(token?.className).not.toContain('opacity-50');
        expect(token?.className).not.toContain('line-through');
        expect(token?.getAttribute('data-not-found')).toBeNull();
      });
    });
  });
});
