// @ts-nocheck
/**
 * SDKSystemMessage Component Tests
 *
 * Tests system message rendering for init, compact_boundary, status, and hook_response
 */
import { describe, it, expect } from 'vitest';

import { render, fireEvent } from '@testing-library/preact';
import { SDKSystemMessage } from '../SDKSystemMessage';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';

// Helper to create a valid UUID
const createUUID = (): UUID => crypto.randomUUID() as UUID;

// Factory functions for test messages
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

      // Should strip "claude-" prefix
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

      expect(container.querySelector('.bg-indigo-50, .dark\\:bg-indigo-900\\/20')).toBeTruthy();
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

      expect(container.querySelector('.bg-yellow-50, .dark\\:bg-yellow-900\\/20')).toBeTruthy();
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

      // Yellow text for compacting status
      expect(container.querySelector('.text-yellow-600, .text-yellow-400')).toBeTruthy();
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

      // First line of stdout shown as summary in header
      expect(container.textContent).toContain('Hook executed successfully');
    });

    it('should be collapsed by default — stdout body hidden', () => {
      const message = createHookResponseMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      // Full stdout (second line) should not be visible until expanded
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
      // Error text should have red styling
      expect(container.querySelector('.text-red-700, .text-red-300')).toBeTruthy();
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

      expect(container.querySelector('.bg-slate-50, .dark\\:bg-slate-900\\/30')).toBeTruthy();
    });

    it('should show error indicator for non-zero exit code', () => {
      const message = createHookResponseWithError();
      const { container } = render(<SDKSystemMessage message={message} />);

      // Should have error X icon in header
      const errorSvg = container.querySelector('.text-red-500');
      expect(errorSvg).toBeTruthy();
    });

    it('should toggle expand/collapse', () => {
      const message = createHookResponseMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;

      // Initially collapsed — no full stdout body
      expect(container.textContent).not.toContain('All checks passed');

      // Expand
      fireEvent.click(button);
      expect(container.textContent).toContain('All checks passed');

      // Collapse
      fireEvent.click(button);
      expect(container.querySelector('.p-3.border-t')).toBeFalsy();
    });
  });

  describe('Operational System Messages', () => {
    it('should render thinking token updates', () => {
      const message = {
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 12345,
        estimated_tokens_delta: 678,
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Thinking tokens');
      expect(container.textContent).toContain('12,345 estimated tokens');
      expect(container.textContent).toContain('+678');
    });

    it('should render session state changes', () => {
      const message = {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'requires_action',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Session state');
      expect(container.textContent).toContain('requires_action');
    });

    it('should render command list changes', () => {
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

      expect(container.textContent).toContain('Commands changed');
      expect(container.textContent).toContain('2 slash commands available');
      expect(container.textContent).toContain('/help');
      expect(container.textContent).toContain('/status');
    });

    it('should render model refusal fallback messages', () => {
      const message = createModelRefusalFallbackMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Model fallback');
      expect(container.textContent).toContain('Retried with fallback model');
      expect(container.textContent).toContain('claude-opus-4-5');
      expect(container.textContent).toContain('claude-sonnet-4-5');
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

    it('should render worker shutdown messages', () => {
      const message = {
        type: 'system',
        subtype: 'worker_shutting_down',
        reason: 'host_exit',
        uuid: createUUID(),
        session_id: 'test-session',
      } as Extract<SDKMessage, { type: 'system' }>;

      const { container } = render(<SDKSystemMessage message={message} />);

      expect(container.textContent).toContain('Worker shutting down');
      expect(container.textContent).toContain('host_exit');
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

      // Initially collapsed
      expect(container.textContent).not.toContain('Working Directory');

      // Expand
      fireEvent.click(button);
      expect(container.textContent).toContain('Working Directory');

      // Collapse
      fireEvent.click(button);
      expect(container.querySelector('.mt-3.pt-3')).toBeFalsy();
    });

    it('should toggle compact boundary metadata', () => {
      const message = createCompactBoundaryMessage('auto');
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;

      // Initially collapsed
      expect(container.textContent).not.toContain('Metadata');

      // Expand
      fireEvent.click(button);
      expect(container.textContent).toContain('Metadata');

      // Collapse
      fireEvent.click(button);
      // Expanded section should be hidden
      const expandedSection = container.querySelector('.p-3.border-t');
      expect(expandedSection).toBeFalsy();
    });
  });

  describe('Chevron Rotation', () => {
    it('should rotate chevron when expanded', () => {
      const message = createInitMessage();
      const { container } = render(<SDKSystemMessage message={message} />);

      const button = container.querySelector('button')!;
      const svg = container.querySelectorAll('svg')[1]; // Second SVG is the chevron

      // Initially not rotated
      expect(svg?.className.baseVal || svg?.getAttribute('class')).not.toContain('rotate-180');

      // After click, should be rotated
      fireEvent.click(button);
      const rotatedSvg = container.querySelectorAll('svg')[1];
      expect(rotatedSvg?.className.baseVal || rotatedSvg?.getAttribute('class')).toContain(
        'rotate-180'
      );
    });
  });
});
