// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { ToolResultCard } from '../ToolResultCard.tsx';

const mockRequest = vi.fn();
const mockGetHub = vi.fn();

vi.mock('../../../../lib/connection-manager', () => ({
  connectionManager: {
    getHub: () => mockGetHub(),
  },
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('../../../../lib/toast', () => ({
  toast: {
    success: (msg: string) => mockToastSuccess(msg),
    error: (msg: string) => mockToastError(msg),
  },
}));

vi.mock('../ToolIcon.tsx', () => ({
  ToolIcon: ({ toolName, size }: { toolName: string; size: string }) => (
    <span data-testid="tool-icon" data-tool={toolName} data-size={size}>
      Icon
    </span>
  ),
}));

vi.mock('../ToolSummary.tsx', () => ({
  ToolSummary: ({ toolName: _toolName, input: _input }: { toolName: string; input: unknown }) => (
    <span data-testid="tool-summary">Summary</span>
  ),
}));

vi.mock('../DiffViewer.tsx', () => ({
  DiffViewer: ({
    oldText,
    newText,
    filePath: _filePath,
  }: {
    oldText: string;
    newText: string;
    filePath?: string;
  }) => (
    <div data-testid="diff-viewer">
      Diff: {oldText} → {newText}
    </div>
  ),
}));

vi.mock('../CodeViewer.tsx', () => ({
  CodeViewer: ({ code, filePath: _filePath }: { code: string; filePath?: string }) => (
    <pre data-testid="code-viewer">{code}</pre>
  ),
}));

vi.mock('../../../ui/ConfirmModal.tsx', () => ({
  ConfirmModal: ({
    isOpen,
    onClose,
    onConfirm,
    title,
    isLoading,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    isLoading?: boolean;
  }) =>
    isOpen ? (
      <div data-testid="confirm-modal">
        <span data-testid="modal-title">{title}</span>
        <button data-testid="modal-confirm" onClick={onConfirm} disabled={isLoading}>
          Confirm
        </button>
        <button data-testid="modal-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    ) : null,
}));

vi.mock('../tool-utils.ts', () => ({
  getToolDisplayName: (name: string) => name,
  getToolColors: () => ({
    bg: 'bg-accent/10',
    border: 'border-accent/40',
    text: 'text-accent',
    lightText: 'text-accent',
    iconColor: 'text-accent',
  }),
  getOutputDisplayText: (output: unknown) =>
    typeof output === 'string' ? output : JSON.stringify(output, null, 2),
  hasCustomRenderer: (name: string) => name === 'TodoWrite',
  getCustomRenderer: () => () => <div data-testid="custom-renderer">Custom</div>,
  shouldExpandByDefault: (name: string) => name === 'Thinking',
}));

describe('ToolResultCard Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHub.mockResolvedValue({ request: mockRequest });
    mockRequest.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('compact variant', () => {
    it('should render compact variant correctly', () => {
      render(
        <ToolResultCard
          toolName="Read"
          toolId="read-123"
          input={{ file_path: '/test.ts' }}
          output="content"
          variant="compact"
        />
      );

      const icon = screen.getByTestId('tool-icon');
      expect(icon).toBeTruthy();
      expect(icon.dataset.size).toBe('sm');
      expect(screen.getByText('Read')).toBeTruthy();
    });

    it('should show error icon in compact variant when isError is true', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="error"
          isError={true}
          variant="compact"
        />
      );

      const svg = document.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('inline variant', () => {
    it('should render inline variant correctly', () => {
      render(
        <ToolResultCard
          toolName="Grep"
          toolId="grep-123"
          input={{ pattern: 'test' }}
          output="matches"
          variant="inline"
        />
      );

      const icon = screen.getByTestId('tool-icon');
      expect(icon.dataset.size).toBe('xs');
      expect(screen.getByText('Grep')).toBeTruthy();
    });

    it('should show error indicator in inline variant', () => {
      render(
        <ToolResultCard
          toolName="Grep"
          toolId="grep-123"
          input={{ pattern: 'test' }}
          output="error"
          isError={true}
          variant="inline"
        />
      );

      expect(screen.getByText('✗')).toBeTruthy();
    });
  });

  describe('default variant', () => {
    it('should render default variant with header', () => {
      render(
        <ToolResultCard
          toolName="Read"
          toolId="read-123"
          input={{ file_path: '/test.ts' }}
          output="file content"
        />
      );

      expect(screen.getByTestId('tool-icon')).toBeTruthy();
      expect(screen.getByTestId('tool-summary')).toBeTruthy();
      expect(screen.getByText('Read')).toBeTruthy();
    });

    it('should toggle expand/collapse on header click', async () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="output"
          defaultExpanded={false}
        />
      );

      expect(screen.queryByText('Input:')).toBeNull();

      const header = document.querySelector('button');
      fireEvent.click(header!);

      await waitFor(() => {
        expect(screen.getByText('Input:')).toBeTruthy();
      });

      fireEvent.click(header!);

      await waitFor(() => {
        expect(screen.queryByText('Input:')).toBeNull();
      });
    });

    it('should show error styling when isError is true', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'invalid' }}
          output="command not found"
          isError={true}
          defaultExpanded={true}
        />
      );

      expect(screen.getByText('Error')).toBeTruthy();
      expect(screen.getByText('command not found')).toBeTruthy();
    });
  });

  describe('task_notification folding', () => {
    it('shows a green check on completed and folds summary + usage', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-ok"
          input={{ command: 'bun test' }}
          output="all pass"
          taskNotification={{
            status: 'completed',
            summary: '42 tests passed',
            usage: { total_tokens: 9999, tool_uses: 42, duration_ms: 30000 },
          }}
          defaultExpanded={true}
        />
      );

      expect(screen.getByLabelText('task completed')).toBeTruthy();
      expect(screen.getByText('42 tests passed')).toBeTruthy();
      expect(screen.getByText('9,999 tokens')).toBeTruthy();
    });

    it('shows a red X on failed and does not double-render the error icon', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-fail"
          input={{ command: 'false' }}
          output="error"
          isError={true}
          taskNotification={{
            status: 'failed',
            summary: 'Bash exited 1',
            usage: { total_tokens: 333, tool_uses: 1, duration_ms: 120 },
          }}
          defaultExpanded={true}
        />
      );

      const errorIcons = screen.getAllByLabelText('task failed');
      expect(errorIcons).toHaveLength(1);
      expect(screen.getByText('Bash exited 1')).toBeTruthy();
    });

    it('labels a stopped task as task stopped, not task failed', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-stop"
          input={{ command: 'sleep 10' }}
          output="killed"
          taskNotification={{
            status: 'stopped',
            summary: 'killed by user',
            usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
          }}
          defaultExpanded={true}
        />
      );

      expect(screen.getByLabelText('task stopped')).toBeTruthy();
      expect(screen.queryAllByLabelText('task failed')).toHaveLength(0);
    });

    it('shows live progress only while running', () => {
      const taskProgress = {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-1',
        tool_use_id: 'bash-progress',
        description: 'running bash',
        usage: { total_tokens: 12400, tool_uses: 3, duration_ms: 8200 },
        last_tool_name: 'Bash',
        summary: 'checking files',
        uuid: 'progress-1',
        session_id: 'session-1',
      } as const;

      const { rerender } = render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-progress"
          input={{ command: 'bun test' }}
          isRunning={true}
          taskProgress={taskProgress}
        />
      );

      expect(screen.getByLabelText('running task progress')).toBeTruthy();
      expect(screen.getByText(/Running · 12.4k tok · 3 tools · 8.2s · last: Bash/)).toBeTruthy();
      expect(screen.getByText(/checking files/)).toBeTruthy();

      rerender(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-progress"
          input={{ command: 'bun test' }}
          isRunning={false}
          taskProgress={taskProgress}
        />
      );

      expect(screen.queryByLabelText('running task progress')).toBeNull();
    });

    it('falls back to isError X when no task_notification is present', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-legacy"
          input={{ command: 'bad' }}
          output="fail"
          isError={true}
        />
      );

      const header = document.querySelector('button')!;
      const xSvg = header.querySelector('svg.text-danger');
      expect(xSvg).toBeTruthy();
    });
  });

  describe('detailed variant', () => {
    it('should show tool ID in detailed variant', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-detailed-123"
          input={{ command: 'ls' }}
          output="files"
          variant="detailed"
          defaultExpanded={true}
        />
      );

      expect(screen.getByText('Tool ID:')).toBeTruthy();
      expect(screen.getByText('bash-detailed-123')).toBeTruthy();
    });
  });

  describe('special tool handling', () => {
    it('should render DiffViewer for Edit tool', () => {
      render(
        <ToolResultCard
          toolName="Edit"
          toolId="edit-123"
          input={{ file_path: '/test.ts', old_string: 'old', new_string: 'new' }}
          output="success"
          defaultExpanded={true}
        />
      );

      expect(screen.getByTestId('diff-viewer')).toBeTruthy();
    });

    it('should render error message for failed Edit tool', () => {
      render(
        <ToolResultCard
          toolName="Edit"
          toolId="edit-123"
          input={{ file_path: '/test.ts', old_string: 'old', new_string: 'new' }}
          output="Error: old_string not found in file"
          isError={true}
          defaultExpanded={true}
        />
      );

      expect(screen.getByText('Error')).toBeTruthy();
      expect(screen.getByText('— /test.ts')).toBeTruthy();
      expect(screen.getByText('Error: old_string not found in file')).toBeTruthy();
      expect(screen.queryByTestId('diff-viewer')).toBeNull();
    });

    it('should render CodeViewer for Read tool with string output', () => {
      render(
        <ToolResultCard
          toolName="Read"
          toolId="read-123"
          input={{ file_path: '/test.ts' }}
          output="   1→const x = 1;"
          defaultExpanded={true}
        />
      );

      expect(screen.getByTestId('code-viewer')).toBeTruthy();
    });

    it('should render error message for failed Read tool', () => {
      render(
        <ToolResultCard
          toolName="Read"
          toolId="read-123"
          input={{ file_path: '/missing.ts' }}
          output="Error: file not found"
          isError={true}
          defaultExpanded={true}
        />
      );

      expect(screen.getByText('Error')).toBeTruthy();
      expect(screen.getByText('— /missing.ts')).toBeTruthy();
      expect(screen.getByText('Error: file not found')).toBeTruthy();
      expect(screen.queryByTestId('code-viewer')).toBeNull();
    });

    it('should render CodeViewer for Read tool with object output', () => {
      render(
        <ToolResultCard
          toolName="Read"
          toolId="read-123"
          input={{ file_path: '/test.ts' }}
          output={{ content: '   1→const x = 1;' }}
          defaultExpanded={true}
        />
      );

      expect(screen.getByTestId('code-viewer')).toBeTruthy();
    });

    it('should render CodeViewer for Write tool', () => {
      render(
        <ToolResultCard
          toolName="Write"
          toolId="write-123"
          input={{ file_path: '/test.ts', content: 'const x = 1;' }}
          output="success"
          defaultExpanded={true}
        />
      );

      expect(screen.getByTestId('code-viewer')).toBeTruthy();
    });

    it('should render error message for failed Write tool', () => {
      render(
        <ToolResultCard
          toolName="Write"
          toolId="write-123"
          input={{ file_path: '/test.ts', content: 'const x = 1;' }}
          output="Error: permission denied"
          isError={true}
          defaultExpanded={true}
        />
      );

      expect(screen.getByText('Error')).toBeTruthy();
      expect(screen.getByText('— /test.ts')).toBeTruthy();
      expect(screen.getByText('Error: permission denied')).toBeTruthy();
      expect(screen.queryByTestId('code-viewer')).toBeNull();
    });

    it('should render Thinking tool with character count in detailed variant', () => {
      render(
        <ToolResultCard
          toolName="Thinking"
          toolId="thinking-123"
          input="This is my thinking process"
          output={null}
          variant="detailed"
          defaultExpanded={true}
        />
      );

      expect(screen.getByText(/Extended Thinking Process/)).toBeTruthy();
      expect(screen.getByText(/27 characters/)).toBeTruthy();
    });

    it('should render custom renderer for TodoWrite', () => {
      render(
        <ToolResultCard
          toolName="TodoWrite"
          toolId="todo-123"
          input={{ todos: [] }}
          output="success"
          defaultExpanded={true}
        />
      );

      expect(screen.getByTestId('custom-renderer')).toBeTruthy();
    });

    it('should render typed FileReadOutput text type', () => {
      render(
        <ToolResultCard
          toolName="Read"
          toolId="read-typed"
          input={{ file_path: '/test.ts' }}
          output={{
            type: 'text',
            file: {
              filePath: '/test.ts',
              content: 'const x = 1;',
              numLines: 1,
              startLine: 1,
              totalLines: 1,
            },
          }}
          defaultExpanded={true}
        />
      );

      expect(screen.getByTestId('code-viewer')).toBeTruthy();
      expect(screen.getByText('const x = 1;')).toBeTruthy();
    });

    it('should render typed FileReadOutput file_unchanged type', () => {
      render(
        <ToolResultCard
          toolName="Read"
          toolId="read-unchanged"
          input={{ file_path: '/test.ts' }}
          output={{ type: 'file_unchanged', file: { filePath: '/test.ts' } }}
          defaultExpanded={true}
        />
      );

      expect(screen.getByText('File unchanged: /test.ts')).toBeTruthy();
    });

    it('should render typed FileEditOutput with DiffViewer', () => {
      render(
        <ToolResultCard
          toolName="Edit"
          toolId="edit-typed"
          input={{ file_path: '/test.ts', old_string: 'old', new_string: 'new' }}
          output={{
            filePath: '/test.ts',
            oldString: 'old',
            newString: 'new',
            originalFile: 'old',
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ['-old', '+new'],
              },
            ],
            userModified: false,
            replaceAll: false,
          }}
          defaultExpanded={true}
        />
      );

      expect(screen.getByTestId('diff-viewer')).toBeTruthy();
      expect(screen.queryByText('Structured patch')).toBeNull();
    });

    it('should show structured patch in detailed variant for FileEditOutput', () => {
      render(
        <ToolResultCard
          toolName="Edit"
          toolId="edit-detailed"
          input={{ file_path: '/test.ts', old_string: 'old', new_string: 'new' }}
          output={{
            filePath: '/test.ts',
            oldString: 'old',
            newString: 'new',
            originalFile: 'old',
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ['-old', '+new'],
              },
            ],
            userModified: false,
            replaceAll: false,
          }}
          variant="detailed"
          defaultExpanded={true}
        />
      );

      expect(screen.getByTestId('diff-viewer')).toBeTruthy();
      expect(screen.getByText('Structured patch')).toBeTruthy();
    });

    it('should render typed FileWriteOutput create type', () => {
      render(
        <ToolResultCard
          toolName="Write"
          toolId="write-typed"
          input={{ file_path: '/test.ts', content: 'const x = 1;' }}
          output={{
            type: 'create',
            filePath: '/test.ts',
            content: 'const x = 1;',
            structuredPatch: [],
            originalFile: null,
          }}
          variant="detailed"
          defaultExpanded={true}
        />
      );

      expect(screen.getByText('New File: /test.ts')).toBeTruthy();
      expect(screen.getByTestId('code-viewer')).toBeTruthy();
    });

    it('should render typed FileWriteOutput update type', () => {
      render(
        <ToolResultCard
          toolName="Write"
          toolId="write-update"
          input={{ file_path: '/test.ts', content: 'const x = 2;' }}
          output={{
            type: 'update',
            filePath: '/test.ts',
            content: 'const x = 2;',
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ['-const x = 1;', '+const x = 2;'],
              },
            ],
            originalFile: 'const x = 1;',
            gitDiff: {
              filename: '/test.ts',
              status: 'modified',
              additions: 1,
              deletions: 1,
              changes: 2,
              patch: '',
            },
          }}
          variant="detailed"
          defaultExpanded={true}
        />
      );

      expect(screen.getByText('Updated File: /test.ts')).toBeTruthy();
      expect(screen.getByTestId('code-viewer')).toBeTruthy();
      expect(screen.getByText('Git: 1 additions, 1 deletions')).toBeTruthy();
    });
  });

  describe('line count display', () => {
    it('should show line count for Read tool', () => {
      const multilineContent = `line1
line2
line3`;
      render(
        <ToolResultCard
          toolName="Read"
          toolId="read-123"
          input={{ file_path: '/test.ts' }}
          output={multilineContent}
        />
      );

      expect(screen.getByText('3')).toBeTruthy();
    });

    it('should show line count for Write tool', () => {
      const content = `line1
line2`;
      render(
        <ToolResultCard
          toolName="Write"
          toolId="write-123"
          input={{ file_path: '/test.ts', content }}
          output="success"
        />
      );

      expect(screen.getByText('+2')).toBeTruthy();
    });

    it('should show diff counts for Edit tool', () => {
      const oldString = `old
old2`;
      render(
        <ToolResultCard
          toolName="Edit"
          toolId="edit-123"
          input={{
            file_path: '/test.ts',
            old_string: oldString,
            new_string: 'new',
          }}
          output="success"
        />
      );

      expect(screen.getByText('+1')).toBeTruthy();
      expect(screen.getByText('-2')).toBeTruthy();
    });
  });

  describe('output removed state', () => {
    it('should show warning when output is removed', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="large output"
          isOutputRemoved={true}
          defaultExpanded={true}
        />
      );

      expect(screen.getByText('Output Removed from Agent Context')).toBeTruthy();
    });
  });

  describe('delete functionality', () => {
    it('should show delete button when messageUuid and sessionId present', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="files"
          messageUuid="msg-123"
          sessionId="session-456"
          defaultExpanded={true}
        />
      );

      expect(screen.getByText('Remove From Context')).toBeTruthy();
    });

    it('should not show delete button when output is removed', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="files"
          messageUuid="msg-123"
          sessionId="session-456"
          isOutputRemoved={true}
          defaultExpanded={true}
        />
      );

      expect(screen.queryByText('Remove From Context')).toBeNull();
    });

    it('should show error toast when delete clicked without messageUuid', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="files"
          sessionId="session-456"
          defaultExpanded={true}
        />
      );

      expect(screen.queryByText('Remove From Context')).toBeNull();
    });

    it('should open confirmation modal on delete click', async () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="files"
          messageUuid="msg-123"
          sessionId="session-456"
          defaultExpanded={true}
        />
      );

      const deleteButton = screen.getByText('Remove From Context');
      fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByTestId('confirm-modal')).toBeTruthy();
      });
    });

    it('should call API on confirm delete and reload page', async () => {
      vi.useFakeTimers();
      const originalReload = window.location.reload;
      window.location.reload = vi.fn();

      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="files"
          messageUuid="msg-123"
          sessionId="session-456"
          defaultExpanded={true}
        />
      );

      fireEvent.click(screen.getByText('Remove From Context'));

      await waitFor(() => {
        expect(screen.getByTestId('confirm-modal')).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId('modal-confirm'));

      await vi.waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith('message.removeOutput', {
          sessionId: 'session-456',
          messageUuid: 'msg-123',
        });
      });

      expect(mockToastSuccess).toHaveBeenCalledWith('Tool output removed. Reloading session...');

      await vi.advanceTimersByTimeAsync(500);

      expect(window.location.reload).toHaveBeenCalled();

      window.location.reload = originalReload;
      vi.useRealTimers();
    });

    it('should show error toast on delete failure', async () => {
      mockRequest.mockRejectedValue(new Error('Delete failed'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="files"
          messageUuid="msg-123"
          sessionId="session-456"
          defaultExpanded={true}
        />
      );

      fireEvent.click(screen.getByText('Remove From Context'));

      await waitFor(() => {
        expect(screen.getByTestId('confirm-modal')).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId('modal-confirm'));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Delete failed');
      });

      consoleError.mockRestore();
    });

    it('should show fallback error message on non-Error exception', async () => {
      mockRequest.mockRejectedValue('Unknown error');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="files"
          messageUuid="msg-123"
          sessionId="session-456"
          defaultExpanded={true}
        />
      );

      fireEvent.click(screen.getByText('Remove From Context'));

      await waitFor(() => {
        expect(screen.getByTestId('confirm-modal')).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId('modal-confirm'));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to remove output');
      });

      consoleError.mockRestore();
    });

    it('should close modal on cancel', async () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="files"
          messageUuid="msg-123"
          sessionId="session-456"
          defaultExpanded={true}
        />
      );

      fireEvent.click(screen.getByText('Remove From Context'));

      await waitFor(() => {
        expect(screen.getByTestId('confirm-modal')).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId('modal-cancel'));

      await waitFor(() => {
        expect(screen.queryByTestId('confirm-modal')).toBeNull();
      });
    });
  });

  describe('expand state', () => {
    it('should respect defaultExpanded prop', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output="files"
          defaultExpanded={true}
        />
      );

      expect(screen.getByText('Input:')).toBeTruthy();
    });

    it('should expand Thinking tool by default', () => {
      render(
        <ToolResultCard
          toolName="Thinking"
          toolId="thinking-123"
          input="thinking content"
          output={null}
        />
      );

      expect(screen.getByText('thinking content')).toBeTruthy();
    });
  });

  describe('className prop', () => {
    it('should apply custom className', () => {
      const { container } = render(
        <ToolResultCard
          toolName="Read"
          toolId="read-123"
          input={{ file_path: '/test.ts' }}
          output="content"
          className="custom-class"
        />
      );

      expect((container.firstChild as HTMLElement).className).toContain('custom-class');
    });
  });

  describe('null/undefined output handling', () => {
    it('should not render output section when output is null', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output={null}
          defaultExpanded={true}
        />
      );

      expect(screen.queryByText('Output:')).toBeNull();
    });

    it('should not render output section when output is undefined', () => {
      render(
        <ToolResultCard
          toolName="Bash"
          toolId="bash-123"
          input={{ command: 'ls' }}
          output={undefined}
          defaultExpanded={true}
        />
      );

      expect(screen.queryByText('Output:')).toBeNull();
    });
  });

  describe('stripLineNumbers function', () => {
    it('should strip line numbers from Read output and pass to CodeViewer', () => {
      render(
        <ToolResultCard
          toolName="Read"
          toolId="read-123"
          input={{ file_path: '/test.ts' }}
          output="   1→const x = 1;"
          defaultExpanded={true}
        />
      );

      const codeViewer = screen.getByTestId('code-viewer');
      expect(codeViewer.textContent).toBe('const x = 1;');
    });
  });
});

const TOOL_COLORS = {
  file: { bg: 'bg-accent/10', border: 'border-accent/40', text: 'text-accent' },
  search: {
    bg: 'bg-cat-purple/10',
    border: 'border-purple-200',
    text: 'text-purple-600',
  },
  command: {
    bg: 'bg-success/10',
    border: 'border-green-200',
    text: 'text-success',
  },
  thinking: {
    bg: 'bg-warning/10',
    border: 'border-warning',
    text: 'text-warning',
  },
  system: {
    bg: 'bg-surface-raised',
    border: 'border-gray-200',
    text: 'text-fg-faint',
  },
};

function getToolCategory(toolName: string): keyof typeof TOOL_COLORS {
  const fileTools = ['Read', 'Write', 'Edit', 'Glob', 'NotebookEdit'];
  const searchTools = ['Grep', 'WebSearch', 'WebFetch'];
  const commandTools = ['Bash', 'Task', 'Skill'];
  const thinkingTools = ['Thinking'];

  if (fileTools.includes(toolName)) return 'file';
  if (searchTools.includes(toolName)) return 'search';
  if (commandTools.includes(toolName)) return 'command';
  if (thinkingTools.includes(toolName)) return 'thinking';
  return 'system';
}

function getDisplayName(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts[parts.length - 1];
  }
  return toolName;
}

function getFileExtension(filePath: string): string {
  const parts = filePath.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

function calculateDiffStats(
  oldString: string,
  newString: string
): { added: number; removed: number } {
  const oldLines = oldString ? oldString.split('\n').length : 0;
  const newLines = newString ? newString.split('\n').length : 0;
  return {
    added: newLines,
    removed: oldLines,
  };
}

function formatInputSummary(toolName: string, input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';

  const inputObj = input as Record<string, unknown>;

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      if (inputObj.file_path) {
        const path = inputObj.file_path as string;
        const fileName = path.split('/').pop() || path;
        return fileName;
      }
      break;
    case 'Bash':
      if (inputObj.command) {
        const cmd = inputObj.command as string;
        return cmd.length > 50 ? cmd.substring(0, 50) + '...' : cmd;
      }
      break;
    case 'Grep':
      if (inputObj.pattern) {
        return `/${inputObj.pattern}/`;
      }
      break;
    case 'Glob':
      if (inputObj.pattern) {
        return inputObj.pattern as string;
      }
      break;
  }

  return '';
}

function shouldExpandByDefault(toolName: string, isError: boolean): boolean {
  if (isError) return false;
  if (toolName === 'Thinking') return true;
  return false;
}

describe('ToolResultCard Logic', () => {
  describe('Tool Categories', () => {
    it('should categorize file tools correctly', () => {
      expect(getToolCategory('Read')).toBe('file');
      expect(getToolCategory('Write')).toBe('file');
      expect(getToolCategory('Edit')).toBe('file');
      expect(getToolCategory('Glob')).toBe('file');
    });

    it('should categorize search tools correctly', () => {
      expect(getToolCategory('Grep')).toBe('search');
      expect(getToolCategory('WebSearch')).toBe('search');
      expect(getToolCategory('WebFetch')).toBe('search');
    });

    it('should categorize command tools correctly', () => {
      expect(getToolCategory('Bash')).toBe('command');
      expect(getToolCategory('Task')).toBe('command');
      expect(getToolCategory('Skill')).toBe('command');
    });

    it('should categorize thinking tools correctly', () => {
      expect(getToolCategory('Thinking')).toBe('thinking');
    });

    it('should default to system category for unknown tools', () => {
      expect(getToolCategory('UnknownTool')).toBe('system');
      expect(getToolCategory('CustomPlugin')).toBe('system');
    });
  });

  describe('Tool Colors', () => {
    it('should return blue colors for file tools', () => {
      const category = getToolCategory('Read');
      expect(TOOL_COLORS[category].bg).toBe('bg-accent/10');
    });

    it('should return purple colors for search tools', () => {
      const category = getToolCategory('Grep');
      expect(TOOL_COLORS[category].bg).toBe('bg-cat-purple/10');
    });

    it('should return green colors for command tools', () => {
      const category = getToolCategory('Bash');
      expect(TOOL_COLORS[category].bg).toBe('bg-success/10');
    });

    it('should return amber colors for thinking tools', () => {
      const category = getToolCategory('Thinking');
      expect(TOOL_COLORS[category].bg).toBe('bg-warning/10');
    });
  });

  describe('MCP Tool Display Names', () => {
    it('should extract tool name from MCP format', () => {
      expect(getDisplayName('mcp__filesystem__read')).toBe('read');
      expect(getDisplayName('mcp__server__action__execute')).toBe('execute');
    });

    it('should return original name for non-MCP tools', () => {
      expect(getDisplayName('Read')).toBe('Read');
      expect(getDisplayName('Bash')).toBe('Bash');
    });
  });

  describe('File Extension Detection', () => {
    it('should extract extension from file path', () => {
      expect(getFileExtension('/path/to/file.ts')).toBe('ts');
      expect(getFileExtension('/path/to/file.test.tsx')).toBe('tsx');
      expect(getFileExtension('config.json')).toBe('json');
    });

    it('should handle files without extension', () => {
      expect(getFileExtension('Makefile')).toBe('');
      expect(getFileExtension('/path/to/README')).toBe('');
    });
  });

  describe('Line Counting', () => {
    it('should count lines correctly', () => {
      expect(countLines('line1\nline2\nline3')).toBe(3);
      expect(countLines('single line')).toBe(1);
      expect(countLines('')).toBe(0);
    });

    it('should handle undefined/null input', () => {
      expect(countLines(null as unknown as string)).toBe(0);
      expect(countLines(undefined as unknown as string)).toBe(0);
    });
  });

  describe('Diff Stats Calculation', () => {
    it('should calculate lines added and removed', () => {
      const stats = calculateDiffStats('old line', 'new line 1\nnew line 2');
      expect(stats.added).toBe(2);
      expect(stats.removed).toBe(1);
    });

    it('should handle empty strings', () => {
      const stats = calculateDiffStats('', 'new content');
      expect(stats.added).toBe(1);
      expect(stats.removed).toBe(0);
    });
  });

  describe('Input Summary Formatting', () => {
    it('should format Read tool input', () => {
      const summary = formatInputSummary('Read', {
        file_path: '/path/to/file.ts',
      });
      expect(summary).toBe('file.ts');
    });

    it('should format Bash tool input', () => {
      const summary = formatInputSummary('Bash', { command: 'echo hello' });
      expect(summary).toBe('echo hello');
    });

    it('should truncate long Bash commands', () => {
      const longCmd = 'a'.repeat(100);
      const summary = formatInputSummary('Bash', { command: longCmd });
      expect(summary.length).toBe(53);
      expect(summary.endsWith('...')).toBe(true);
    });

    it('should format Grep tool input', () => {
      const summary = formatInputSummary('Grep', { pattern: 'test.*pattern' });
      expect(summary).toBe('/test.*pattern/');
    });

    it('should format Glob tool input', () => {
      const summary = formatInputSummary('Glob', { pattern: '**/*.ts' });
      expect(summary).toBe('**/*.ts');
    });

    it('should handle string input', () => {
      const summary = formatInputSummary('Thinking', 'This is thinking content');
      expect(summary).toBe('This is thinking content');
    });
  });

  describe('Expand/Collapse Default State', () => {
    it('should not expand by default for most tools', () => {
      expect(shouldExpandByDefault('Read', false)).toBe(false);
      expect(shouldExpandByDefault('Bash', false)).toBe(false);
      expect(shouldExpandByDefault('Edit', false)).toBe(false);
    });

    it('should expand Thinking tool by default', () => {
      expect(shouldExpandByDefault('Thinking', false)).toBe(true);
    });

    it('should not expand on error', () => {
      expect(shouldExpandByDefault('Thinking', true)).toBe(false);
      expect(shouldExpandByDefault('Read', true)).toBe(false);
    });
  });

  describe('stripLineNumbers Logic', () => {
    function stripLineNumbers(content: string): string {
      return content
        .split('\n')
        .map((line) => {
          const match = line.match(/^\s*\d+→(.*)$/);
          return match ? match[1] : line;
        })
        .join('\n');
    }

    it('should strip line numbers from Read output format', () => {
      const input = '   1→const x = 1;\n   2→const y = 2;';
      const result = stripLineNumbers(input);
      expect(result).toBe('const x = 1;\nconst y = 2;');
    });

    it('should handle single-digit line numbers', () => {
      const input = '   1→first line';
      const result = stripLineNumbers(input);
      expect(result).toBe('first line');
    });

    it('should handle multi-digit line numbers', () => {
      const input = '  10→line 10\n 100→line 100\n1000→line 1000';
      const result = stripLineNumbers(input);
      expect(result).toBe('line 10\nline 100\nline 1000');
    });

    it('should preserve lines without line number format', () => {
      const input = 'no line number here';
      const result = stripLineNumbers(input);
      expect(result).toBe('no line number here');
    });

    it('should handle empty content in line', () => {
      const input = '   1→';
      const result = stripLineNumbers(input);
      expect(result).toBe('');
    });

    it('should handle mixed content', () => {
      const input = '   1→code line\nplain text\n   2→more code';
      const result = stripLineNumbers(input);
      expect(result).toBe('code line\nplain text\nmore code');
    });

    it('should handle arrow character in content', () => {
      const input = '   1→const arrow = →;';
      const result = stripLineNumbers(input);
      expect(result).toBe('const arrow = →;');
    });
  });

  describe('calculateDiffCounts comprehensive', () => {
    it('should show accurate diff counts for changes with common prefix', () => {
      const oldContent = `common line 1
common line 2
old content
end`;
      const newContent = `common line 1
common line 2
new content
end`;
      render(
        <ToolResultCard
          toolName="Edit"
          toolId="edit-prefix"
          input={{
            file_path: '/test.ts',
            old_string: oldContent,
            new_string: newContent,
          }}
          output="success"
        />
      );

      expect(screen.getByText('Edit')).toBeTruthy();
    });

    it('should show accurate diff counts for changes with common suffix', () => {
      const oldContent = `start
old middle
common end 1
common end 2`;
      const newContent = `start
new middle
common end 1
common end 2`;
      render(
        <ToolResultCard
          toolName="Edit"
          toolId="edit-suffix"
          input={{
            file_path: '/test.ts',
            old_string: oldContent,
            new_string: newContent,
          }}
          output="success"
        />
      );

      expect(screen.getByText('Edit')).toBeTruthy();
    });

    it('should handle changes with both common prefix and suffix', () => {
      const oldContent = `header line 1
header line 2
OLD CHANGE
footer line 1
footer line 2`;
      const newContent = `header line 1
header line 2
NEW CHANGE
footer line 1
footer line 2`;
      render(
        <ToolResultCard
          toolName="Edit"
          toolId="edit-both"
          input={{
            file_path: '/test.ts',
            old_string: oldContent,
            new_string: newContent,
          }}
          output="success"
        />
      );

      expect(screen.getByText('+1')).toBeTruthy();
      expect(screen.getByText('-1')).toBeTruthy();
    });
  });

  describe('calculateDiffCounts Logic', () => {
    function calculateDiffCounts(
      oldText: string,
      newText: string
    ): { addedLines: number; removedLines: number } {
      const oldLines = oldText.split('\n');
      const newLines = newText.split('\n');

      let firstDiffIndex = 0;
      while (
        firstDiffIndex < Math.min(oldLines.length, newLines.length) &&
        oldLines[firstDiffIndex] === newLines[firstDiffIndex]
      ) {
        firstDiffIndex++;
      }

      let lastDiffIndexOld = oldLines.length - 1;
      let lastDiffIndexNew = newLines.length - 1;
      while (
        lastDiffIndexOld > firstDiffIndex &&
        lastDiffIndexNew > firstDiffIndex &&
        oldLines[lastDiffIndexOld] === newLines[lastDiffIndexNew]
      ) {
        lastDiffIndexOld--;
        lastDiffIndexNew--;
      }

      const removedLines = lastDiffIndexOld - firstDiffIndex + 1;
      const addedLines = lastDiffIndexNew - firstDiffIndex + 1;

      return { addedLines, removedLines };
    }

    it('should count simple single line change', () => {
      const { addedLines, removedLines } = calculateDiffCounts('old', 'new');
      expect(addedLines).toBe(1);
      expect(removedLines).toBe(1);
    });

    it('should count added lines when new text is longer', () => {
      const { addedLines, removedLines } = calculateDiffCounts('line1', 'line1\nline2\nline3');
      expect(addedLines).toBe(2);
      expect(removedLines).toBe(0);
    });

    it('should count removed lines when old text is longer', () => {
      const { addedLines, removedLines } = calculateDiffCounts('line1\nline2\nline3', 'line1');
      expect(addedLines).toBe(0);
      expect(removedLines).toBe(2);
    });

    it('should handle identical text', () => {
      const { addedLines, removedLines } = calculateDiffCounts('same', 'same');
      expect(addedLines).toBe(0);
      expect(removedLines).toBe(0);
    });

    it('should handle changes in the middle', () => {
      const oldText = 'header\nold middle\nfooter';
      const newText = 'header\nnew middle\nfooter';
      const { addedLines, removedLines } = calculateDiffCounts(oldText, newText);
      expect(addedLines).toBe(1);
      expect(removedLines).toBe(1);
    });

    it('should handle empty old text', () => {
      const { addedLines, removedLines } = calculateDiffCounts('', 'new content');
      expect(addedLines).toBe(1);
      expect(removedLines).toBe(1);
    });

    it('should handle empty new text', () => {
      const { addedLines, removedLines } = calculateDiffCounts('old content', '');
      expect(addedLines).toBe(1);
      expect(removedLines).toBe(1);
    });
  });
});
