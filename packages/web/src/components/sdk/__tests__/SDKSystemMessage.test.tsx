// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render, fireEvent } from '@testing-library/preact';
import { SDKSystemMessage } from '../SDKSystemMessage';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';

const createUUID = (): UUID => crypto.randomUUID() as UUID;

function createInitMessage(
  overrides: Partial<Extract<SDKMessage, { type: 'system'; subtype: 'init' }>> = {}
): Extract<SDKMessage, { type: 'system' }> {
  return {
    type: 'system',
    subtype: 'init',
    agents: ['Explore', 'Plan'],
    apiKeySource: 'user',
    betas: [],
    claude_code_version: '1.2.3',
    cwd: '/home/user/project',
    tools: ['Read', 'Write', 'Bash', 'Glob', 'Grep'],
    mcp_servers: [
      { name: 'filesystem', status: 'connected' },
      { name: 'database', status: 'failed' },
    ],
    model: 'claude-3-5-sonnet-20241022',
    permissionMode: 'acceptEdits',
    slash_commands: ['help', 'clear', 'compact', 'context'],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: createUUID(),
    session_id: 'test-session',
    ...overrides,
  };
}

function createCompactBoundaryMessage(
  trigger: 'manual' | 'auto' = 'auto'
): Extract<SDKMessage, { type: 'system' }> {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger,
      pre_tokens: 150000,
    },
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

function createStatusMessage(
  status: 'compacting' | null = 'compacting'
): Extract<SDKMessage, { type: 'system' }> {
  return {
    type: 'system',
    subtype: 'status',
    status,
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

function createHookResponseMessage(): Extract<SDKMessage, { type: 'system' }> {
  return {
    type: 'system',
    subtype: 'hook_response',
    hook_name: 'pre-commit',
    hook_event: 'PreToolUse',
    stdout: 'Hook executed successfully\nAll checks passed',
    stderr: '',
    exit_code: 0,
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

function createHookResponseWithError(): Extract<SDKMessage, { type: 'system' }> {
  return {
    type: 'system',
    subtype: 'hook_response',
    hook_name: 'validate',
    hook_event: 'PostToolUse',
    stdout: '',
    stderr: 'Validation failed: missing required field',
    exit_code: 1,
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

function createModelRefusalFallbackMessage(): Extract<SDKMessage, { type: 'system' }> {
  return {
    type: 'system',
    subtype: 'model_refusal_fallback',
    trigger: 'refusal',
    direction: 'retry',
    original_model: 'claude-opus-4-5',
    fallback_model: 'claude-sonnet-4-5',
    request_id: 'req-1',
    content: 'Retried with fallback model',
    retracted_message_uuids: ['original-message'],
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

describe('SDKSystemMessage', () => {
  describe('System Init Message', () => {
    it('should render session started header', () => {
      const message = createInitMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Session Started');
    });

    it('should show simplified model name', () => {
      const message = createInitMessage({
        model: 'claude-3-5-sonnet-20241022',
      });
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('3-5-sonnet-20241022');
    });

    it('should show permission mode', () => {
      const message = createInitMessage({ permissionMode: 'acceptEdits' });
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('acceptEdits');
    });

    it('should be expandable', () => {
      const message = createInitMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button');
      expect(button).toBeTruthy();
    });

    it('should show working directory when expanded', () => {
      const message = createInitMessage({ cwd: '/home/user/project' });
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Working Directory');
      expect(container.textContent).toContain('/home/user/project');
    });

    it('should show tools when expanded', () => {
      const message = createInitMessage({ tools: ['Read', 'Write', 'Bash'] });
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Tools (3)');
      expect(container.textContent).toContain('Read');
      expect(container.textContent).toContain('Write');
      expect(container.textContent).toContain('Bash');
    });

    it('should show MCP servers when expanded', () => {
      const message = createInitMessage({
        mcp_servers: [
          { name: 'filesystem', status: 'connected' },
          { name: 'database', status: 'failed' },
        ],
      });
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('MCP Servers (2)');
      expect(container.textContent).toContain('filesystem');
      expect(container.textContent).toContain('connected');
      expect(container.textContent).toContain('database');
      expect(container.textContent).toContain('failed');
    });

    it('should show slash commands when expanded', () => {
      const message = createInitMessage({
        slash_commands: ['help', 'clear', 'compact'],
      });
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Slash Commands (3)');
      expect(container.textContent).toContain('/help');
      expect(container.textContent).toContain('/clear');
      expect(container.textContent).toContain('/compact');
    });

    it('should show agents when present and expanded', () => {
      const message = createInitMessage({ agents: ['Explore', 'Plan'] });
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Agents (2)');
      expect(container.textContent).toContain('Explore');
      expect(container.textContent).toContain('Plan');
    });

    it('should show API key source and output style when expanded', () => {
      const message = createInitMessage({
        apiKeySource: 'project',
        output_style: 'streaming',
      });
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('API Key Source: project');
      expect(container.textContent).toContain('Output: streaming');
    });

    it('should have indigo color scheme', () => {
      const message = createInitMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('[class*="bg-cat-indigo/10"]')).toBeTruthy();
    });
  });

  describe('Compact Boundary Message', () => {
    it('should render compact header', () => {
      const message = createCompactBoundaryMessage('auto');
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Compact');
    });

    it('should show trigger type (Auto/Manual)', () => {
      const autoMessage = createCompactBoundaryMessage('auto');
      const { container: autoContainer } = render(<SDKSystemMessage message={autoMessage} />);
      expect(autoContainer.textContent).toContain('Auto');

      const manualMessage = createCompactBoundaryMessage('manual');
      const { container: manualContainer } = render(<SDKSystemMessage message={manualMessage} />);
      expect(manualContainer.textContent).toContain('Manual');
    });

    it('should show pre-compaction token count', () => {
      const message = createCompactBoundaryMessage('auto');
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('150,000 tokens');
    });

    it('should be expandable to show metadata', () => {
      const message = createCompactBoundaryMessage('auto');
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Metadata');
      expect(container.textContent).toContain('trigger');
      expect(container.textContent).toContain('pre_tokens');
    });

    it('should have yellow/amber color scheme', () => {
      const message = createCompactBoundaryMessage('auto');
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('[class*="bg-warning/10"]')).toBeTruthy();
    });
  });

  describe('Status Message', () => {
    it('should render compacting status', () => {
      const message = createStatusMessage('compacting');
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Compact Boundary');
    });

    it('should return null for null status', () => {
      const message = createStatusMessage(null);
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should have yellow color scheme for compacting', () => {
      const message = createStatusMessage('compacting');
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('.text-warning')).toBeTruthy();
    });
  });

  describe('Hook Response Message', () => {
    it('should render hook name and event in collapsed header', () => {
      const message = createHookResponseMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('pre-commit');
      expect(container.textContent).toContain('PreToolUse');
    });

    it('should show truncated stdout summary in collapsed header', () => {
      const message = createHookResponseMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Hook executed successfully');
    });

    it('should be collapsed by default — stdout body hidden', () => {
      const message = createHookResponseMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).not.toContain('All checks passed');
    });

    it('should expand to show full stdout', () => {
      const message = createHookResponseMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Hook executed successfully');
      expect(container.textContent).toContain('All checks passed');
    });

    it('should expand to show stderr in red', () => {
      const message = createHookResponseWithError();
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Validation failed');
      expect(container.querySelector('.text-danger-soft')).toBeTruthy();
    });

    it('should expand to show exit code', () => {
      const message = createHookResponseMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Exit code: 0');
    });

    it('should have slate color scheme', () => {
      const message = createHookResponseMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('.bg-surface-raised')).toBeTruthy();
    });

    it('should show error indicator for non-zero exit code', () => {
      const message = createHookResponseWithError();
      const { container } = render(<SDKSystemMessage message={message} />);

      const errorSvg = container.querySelector('.text-danger');
      expect(errorSvg).toBeTruthy();
    });

    it('should toggle expand/collapse', () => {
      const message = createHookResponseMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;

      expect(container.textContent).not.toContain('All checks passed');

      fireEvent.click(button);
      expect(container.textContent).toContain('All checks passed');

      fireEvent.click(button);
      expect(container.querySelector('.p-3.border-t')).toBeFalsy();
    });
  });

  describe('Operational System Messages', () => {
    it('should render model refusal fallback messages', () => {
      const message = createModelRefusalFallbackMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Model fallback');
      expect(container.textContent).toContain('Retried with fallback model');
      expect(container.textContent).toContain('claude-opus-4-5');
      expect(container.textContent).toContain('claude-sonnet-4-5');
    });

    it('should render api refusal metadata on fallback messages', () => {
      const message = {
        ...createModelRefusalFallbackMessage(),
        api_refusal_category: 'refusal_engine',
        api_refusal_explanation: 'The request was refused by the refusal engine',
      };
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('[data-testid="api-refusal-category"]')).toBeTruthy();
      expect(container.textContent).toContain('refusal_engine');
      expect(container.querySelector('[data-testid="api-refusal-explanation"]')).toBeTruthy();
      expect(container.textContent).toContain('The request was refused by the refusal engine');
    });

    it('should omit api refusal metadata when absent', () => {
      const message = createModelRefusalFallbackMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('[data-testid="api-refusal-category"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="api-refusal-explanation"]')).toBeFalsy();
    });

    it('should ignore blank api refusal metadata', () => {
      const message = {
        ...createModelRefusalFallbackMessage(),
        api_refusal_category: '  ',
        api_refusal_explanation: null,
      };
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('[data-testid="api-refusal-category"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="api-refusal-explanation"]')).toBeFalsy();
    });

    it('should render informational messages', () => {
      const message = {
        type: 'system',
        subtype: 'informational',
        content: 'Hook blocked continuation',
        level: 'warning',
        prevent_continuation: true,
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Info: warning');
      expect(container.textContent).toContain('Hook blocked continuation');
      expect(container.textContent).toContain('Continuation stopped');
    });

    it('should suppress info-level informational messages in normal chat', () => {
      const message = {
        type: 'system',
        subtype: 'informational',
        content: 'Internal transcript note',
        level: 'info',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).not.toContain('Internal transcript note');
      expect(container.innerHTML).toBe('');
    });

    it('should render worker shutdown messages only for live tail rows', () => {
      const message = {
        type: 'system',
        subtype: 'worker_shutting_down',
        reason: 'host_exit',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const stale = render(<SDKSystemMessage message={message} />);
      expect(stale.container.textContent).not.toContain('Worker shutting down');

      const { container } = render(<SDKSystemMessage message={message} isLiveTail={true} />);

      expect(container.textContent).toContain('Worker shutting down');
      expect(container.textContent).toContain('host_exit');
    });
  });

  describe('Permission Denied Message', () => {
    it('should render permission denied card', () => {
      const message = {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        decision_reason_type: 'classifier',
        decision_reason: 'Unsafe command detected',
        message: 'Command denied for safety reasons',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Permission denied');
      expect(container.textContent).toContain('Bash');
      expect(container.textContent).toContain('Unsafe command detected');
      expect(container.textContent).toContain('Command denied for safety reasons');
    });

    it('should have rose color scheme', () => {
      const message = {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        message: 'Denied',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('[class*="border-cat-rose/40"]')).toBeTruthy();
    });
  });

  describe('Task Notification Message', () => {
    it('should render completed task with usage', () => {
      const message = {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        status: 'completed' as const,
        output_file: '/output.txt',
        summary: 'Task completed successfully',
        usage: {
          total_tokens: 15000,
          tool_uses: 8,
          duration_ms: 5000,
        },
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Task completed');
      expect(container.textContent).toContain('Task completed successfully');
      expect(container.textContent).toContain('15,000 tokens');
      expect(container.textContent).toContain('8 tool uses');
      expect(container.textContent).toContain('5.0s');
    });

    it('should render failed task', () => {
      const message = {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        status: 'failed' as const,
        output_file: '/output.txt',
        summary: 'Task failed: timeout',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Task failed');
      expect(container.textContent).toContain('Task failed: timeout');
    });

    it('should have green color for completed, red for failed', () => {
      const completed = {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        status: 'completed' as const,
        output_file: '/output.txt',
        summary: 'Done',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container: completedContainer } = render(<SDKSystemMessage message={completed} />);
      expect(completedContainer.querySelector('[class*="border-success/40"]')).toBeTruthy();

      const failed = {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        status: 'failed' as const,
        output_file: '/output.txt',
        summary: 'Failed',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container: failedContainer } = render(<SDKSystemMessage message={failed} />);
      expect(failedContainer.querySelector('[class*="border-danger/40"]')).toBeTruthy();
    });
  });

  describe('Memory Recall Message', () => {
    it('should render memory recall card with item count', () => {
      const message = {
        type: 'system',
        subtype: 'memory_recall',
        mode: 'select' as const,
        memories: [
          { path: '/project/memory/conventions.md', scope: 'project' },
          { path: '/project/memory/architecture.md', scope: 'project' },
        ],
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Memory recalled');
      expect(container.textContent).toContain('(2 items)');
    });

    it('should be expandable to show memory paths', () => {
      const message = {
        type: 'system',
        subtype: 'memory_recall',
        mode: 'select' as const,
        memories: [
          { path: '/project/memory/conventions.md', scope: 'project' },
          { path: '/user/memory/preferences.md', scope: 'personal' },
        ],
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('/project/memory/conventions.md');
      expect(container.textContent).toContain('project');
      expect(container.textContent).toContain('/user/memory/preferences.md');
      expect(container.textContent).toContain('personal');
    });

    it('should have violet color scheme', () => {
      const message = {
        type: 'system',
        subtype: 'memory_recall',
        mode: 'select' as const,
        memories: [{ path: '/memory/file.md', scope: 'project' }],
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('[class*="border-cat-violet/40"]')).toBeTruthy();
    });
  });

  describe('Local Command Output Message', () => {
    it('should render command output as plaintext', () => {
      const message = {
        type: 'system',
        subtype: 'local_command_output',
        content: 'Line 1\nLine 2\nLine 3',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Line 1');
      expect(container.textContent).toContain('Line 2');
      expect(container.textContent).toContain('Line 3');
    });

    it('should preserve whitespace formatting', () => {
      const message = {
        type: 'system',
        subtype: 'local_command_output',
        content: '  Indented line\n\nDouble newline',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('  Indented line');
      expect(container.textContent).toContain('Double newline');
    });

    it('should have slate color scheme', () => {
      const message = {
        type: 'system',
        subtype: 'local_command_output',
        content: 'Test output',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('.border-line')).toBeTruthy();
    });
  });

  describe('Notification Message', () => {
    it('should render notification with text', () => {
      const message = {
        type: 'system',
        subtype: 'notification',
        key: 'test-note',
        text: 'This is a notification',
        priority: 'medium' as const,
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('This is a notification');
    });

    it('should use priority-based colors', () => {
      const low = {
        type: 'system',
        subtype: 'notification',
        key: 'low',
        text: 'Low priority',
        priority: 'low' as const,
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container: lowContainer } = render(<SDKSystemMessage message={low} />);
      expect(lowContainer.querySelector('[class*="border-accent/40"]')).toBeTruthy();

      const high = {
        type: 'system',
        subtype: 'notification',
        key: 'high',
        text: 'High priority',
        priority: 'high' as const,
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container: highContainer } = render(<SDKSystemMessage message={high} />);
      expect(highContainer.querySelector('.border-warning-soft')).toBeTruthy();
    });

    it('should use custom color when provided', () => {
      const message = {
        type: 'system',
        subtype: 'notification',
        key: 'custom',
        text: 'Custom color',
        priority: 'medium' as const,
        color: 'border-purple-200 bg-cat-purple/10 text-purple-900',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('.border-purple-200')).toBeTruthy();
    });
  });

  describe('Files Persisted Message', () => {
    it('should render when there are failures', () => {
      const message = {
        type: 'system',
        subtype: 'files_persisted',
        files: [{ filename: 'saved.txt', file_id: 'file-1' }],
        failed: [
          { filename: 'failed.txt', error: 'Permission denied' },
          { filename: 'error.txt', error: 'Disk full' },
        ],
        processed_at: '2024-01-01T00:00:00Z',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('File persistence failed');
      expect(container.textContent).toContain('2 files');
      expect(container.textContent).toContain('failed to persist');
      expect(container.textContent).toContain('failed.txt');
      expect(container.textContent).toContain('Permission denied');
      expect(container.textContent).toContain('error.txt');
      expect(container.textContent).toContain('Disk full');
    });

    it('should return null when all files persisted successfully', () => {
      const message = {
        type: 'system',
        subtype: 'files_persisted',
        files: [{ filename: 'saved.txt', file_id: 'file-1' }],
        failed: [],
        processed_at: '2024-01-01T00:00:00Z',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should have red color scheme', () => {
      const message = {
        type: 'system',
        subtype: 'files_persisted',
        files: [],
        failed: [{ filename: 'failed.txt', error: 'Error' }],
        processed_at: '2024-01-01T00:00:00Z',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('[class*="border-danger/40"]')).toBeTruthy();
    });
  });

  describe('Plugin Install Message', () => {
    it('should render failed plugin install', () => {
      const message = {
        type: 'system',
        subtype: 'plugin_install',
        status: 'failed' as const,
        name: 'test-plugin',
        error: 'Failed to download plugin',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('test-plugin');
      expect(container.textContent).toContain('installation failed');
      expect(container.textContent).toContain('Failed to download plugin');
    });

    it('should render completed plugin install', () => {
      const message = {
        type: 'system',
        subtype: 'plugin_install',
        status: 'completed' as const,
        name: 'test-plugin',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('test-plugin');
      expect(container.textContent).toContain('installed');
    });

    it('should return null for started status', () => {
      const message = {
        type: 'system',
        subtype: 'plugin_install',
        status: 'started' as const,
        name: 'test-plugin',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should return null for installed status (per-plugin success noise)', () => {
      const message = {
        type: 'system',
        subtype: 'plugin_install',
        status: 'installed' as const,
        name: 'test-plugin',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should have green color for completed, red for failed', () => {
      const completed = {
        type: 'system',
        subtype: 'plugin_install',
        status: 'completed' as const,
        name: 'test-plugin',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container: completedContainer } = render(<SDKSystemMessage message={completed} />);
      expect(completedContainer.querySelector('[class*="border-success/40"]')).toBeTruthy();

      const failed = {
        type: 'system',
        subtype: 'plugin_install',
        status: 'failed' as const,
        name: 'test-plugin',
        error: 'Error',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container: failedContainer } = render(<SDKSystemMessage message={failed} />);
      expect(failedContainer.querySelector('[class*="border-danger/40"]')).toBeTruthy();
    });
  });

  describe('Hidden System Subtypes', () => {
    it('should return null for session_state_changed', () => {
      const message = {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'requires_action',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should return null for commands_changed', () => {
      const message = {
        type: 'system',
        subtype: 'commands_changed',
        commands: [
          { name: 'help', description: 'Show help', argumentHint: '' },
          { name: 'status', description: 'Show status', argumentHint: '' },
        ],
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('renders hook_started as a running card', () => {
      const message = {
        type: 'system',
        subtype: 'hook_started',
        hook_name: 'pre-commit',
        hook_event: 'PreToolUse',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('[aria-label="hook running"]')).toBeTruthy();
      expect(container.textContent).toContain('pre-commit');
      expect(container.textContent).toContain('PreToolUse');
    });

    it('renders hook_progress as a running card with stdout summary', () => {
      const message = {
        type: 'system',
        subtype: 'hook_progress',
        hook_name: 'pre-commit',
        hook_event: 'PreToolUse',
        stdout: 'Progress...',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.querySelector('[aria-label="hook running"]')).toBeTruthy();
      expect(container.textContent).toContain('Progress...');
    });

    it('should return null for task_started', () => {
      const message = {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        description: 'Test task',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should return null for task_progress', () => {
      const message = {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        description: 'Progress update',
        usage: { total_tokens: 1000, tool_uses: 2, duration_ms: 100 },
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should return null for task_updated', () => {
      const message = {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        patch: { status: 'running' },
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should return null for mirror_error', () => {
      const message = {
        type: 'system',
        subtype: 'mirror_error',
        error: 'Mirror failed',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should return null for elicitation_complete', () => {
      const message = {
        type: 'system',
        subtype: 'elicitation_complete',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });
  });

  describe('Unknown System Subtype', () => {
    it('should return null for unknown subtypes', () => {
      const message = {
        type: 'system',
        subtype: 'unknown_subtype',
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });
  });

  describe('Expand/Collapse Behavior', () => {
    it('should toggle init message details', () => {
      const message = createInitMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;

      expect(container.textContent).not.toContain('Working Directory');

      fireEvent.click(button);
      expect(container.textContent).toContain('Working Directory');

      fireEvent.click(button);
      expect(container.querySelector('.mt-3.pt-3')).toBeFalsy();
    });

    it('should toggle compact boundary metadata', () => {
      const message = createCompactBoundaryMessage('auto');
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;

      expect(container.textContent).not.toContain('Metadata');

      fireEvent.click(button);
      expect(container.textContent).toContain('Metadata');

      fireEvent.click(button);
      const expandedSection = container.querySelector('.p-3.border-t');
      expect(expandedSection).toBeFalsy();
    });
  });

  describe('Chevron Rotation', () => {
    it('should rotate chevron when expanded', () => {
      const message = createInitMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      const svg = container.querySelectorAll('svg')[1];

      expect(svg?.className.baseVal || svg?.getAttribute('class')).not.toContain('rotate-180');

      fireEvent.click(button);
      const rotatedSvg = container.querySelectorAll('svg')[1];
      expect(rotatedSvg?.className.baseVal || rotatedSvg?.getAttribute('class')).toContain(
        'rotate-180'
      );
    });
  });
});
