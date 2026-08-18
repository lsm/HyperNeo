import { describe, it, expect, beforeEach } from 'bun:test';
import {
  createOutputLimiterPreHook,
  createOutputLimiterPostHook,
} from '../../../../src/lib/agent/output-limiter-hook';
import type {
  PostToolUseHookInput,
  PreToolUseHookInput,
  HookCallback,
} from '@anthropic-ai/claude-agent-sdk';

const mockSignal = new AbortController().signal;

describe('OutputLimiterHook', () => {
  describe('PreToolUse (Read/Grep limit injection)', () => {
    let hook: HookCallback;

    beforeEach(() => {
      hook = createOutputLimiterPreHook({ enabled: true });
    });

    it('should inject limit on Read calls without one', async () => {
      const result = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/test/file.txt' },
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
        },
        't1',
        { signal: mockSignal }
      );

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { file_path: '/test/file.txt', limit: 1000 },
        },
      });
    });

    it('should not modify Read calls with a positive limit within cap', async () => {
      const result = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/f', limit: 500 },
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
        },
        't1',
        { signal: mockSignal }
      );

      expect(result).toEqual({});
    });

    it('should clamp Read limit above the cap', async () => {
      const result = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/f', limit: 5000 },
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
        },
        't1',
        { signal: mockSignal }
      );

      expect(result).toMatchObject({
        hookSpecificOutput: {
          updatedInput: { file_path: '/f', limit: 1000 },
        },
      });
    });

    it('should treat Read limit=0 as uncapped and inject the cap', async () => {
      const result = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/f', limit: 0 },
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
        },
        't1',
        { signal: mockSignal }
      );

      expect(result).toMatchObject({
        hookSpecificOutput: {
          updatedInput: { file_path: '/f', limit: 1000 },
        },
      });
    });

    it('should inject head_limit on Grep calls without one', async () => {
      const result = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Grep',
          tool_input: { pattern: 'TODO', path: '/src' },
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
        },
        't1',
        { signal: mockSignal }
      );

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { pattern: 'TODO', path: '/src', head_limit: 250 },
        },
      });
    });

    it('should not modify Grep with positive head_limit within cap', async () => {
      const result = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Grep',
          tool_input: { pattern: 'TODO', head_limit: 100 },
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
        },
        't1',
        { signal: mockSignal }
      );

      expect(result).toEqual({});
    });

    it('should clamp Grep head_limit=0 (unlimited)', async () => {
      const result = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Grep',
          tool_input: { pattern: 'TODO', head_limit: 0 },
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
        },
        't1',
        { signal: mockSignal }
      );

      expect(result).toMatchObject({
        hookSpecificOutput: {
          updatedInput: { pattern: 'TODO', head_limit: 250 },
        },
      });
    });

    it('should not touch Bash or other tools', async () => {
      for (const tool of ['Bash', 'Write', 'Edit', 'Glob']) {
        const result = await hook(
          {
            hook_event_name: 'PreToolUse',
            tool_name: tool,
            tool_input: { command: 'ls' },
            tool_use_id: 't1',
            session_id: 's',
            transcript_path: '/t',
            cwd: '/c',
          },
          't1',
          { signal: mockSignal }
        );
        expect(result).toEqual({});
      }
    });

    it('should skip when disabled', async () => {
      const disabled = createOutputLimiterPreHook({ enabled: false });
      const result = await disabled(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/f' },
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
        },
        't1',
        { signal: mockSignal }
      );
      expect(result).toEqual({});
    });

    it('should map legacy read.maxChars to maxLines', async () => {
      const legacy = createOutputLimiterPreHook({ enabled: true, read: { maxChars: 5000 } });
      const result = await legacy(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/f' },
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
        },
        't1',
        { signal: mockSignal }
      );
      expect(result).toMatchObject({
        hookSpecificOutput: { updatedInput: { file_path: '/f', limit: 100 } },
      });
    });
  });

  describe('PostToolUse (Bash output truncation)', () => {
    let hook: HookCallback;

    beforeEach(() => {
      hook = createOutputLimiterPostHook({ enabled: true });
    });

    function makeBashPost(stdout: string, stderr = ''): PostToolUseHookInput {
      return {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'test' },
        tool_response: { stdout, stderr, interrupted: false },
        tool_use_id: 't1',
        session_id: 's',
        transcript_path: '/t',
        cwd: '/c',
      };
    }

    it('should return {} for small output', async () => {
      const result = await hook(makeBashPost('line1\nline2\nline3'), 't1', { signal: mockSignal });
      expect(result).toEqual({});
    });

    it('should truncate large stdout via updatedToolOutput', async () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
      const stdout = lines.join('\n');

      const result = await hook(makeBashPost(stdout), 't1', { signal: mockSignal });

      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
        },
      });

      const output = (
        result as {
          hookSpecificOutput: { updatedToolOutput: { stdout: string; stderr: string } };
        }
      ).hookSpecificOutput.updatedToolOutput;

      expect(output.stdout).toContain('line 0');
      expect(output.stdout).toContain('line 499');
      expect(output.stdout).toContain('Truncated');
      expect(output.stdout).not.toContain('line 250');
    });

    it('should truncate large stderr separately', async () => {
      const stdout = 'ok';
      const stderr = Array.from({ length: 500 }, (_, i) => `err ${i}`).join('\n');

      const result = await hook(makeBashPost(stdout, stderr), 't1', { signal: mockSignal });

      const output = (
        result as {
          hookSpecificOutput: { updatedToolOutput: { stdout: string; stderr: string } };
        }
      ).hookSpecificOutput.updatedToolOutput;

      expect(output.stdout).toBe('ok');
      expect(output.stderr).toContain('Truncated');
      expect(output.stderr).toContain('err 0');
      expect(output.stderr).toContain('err 499');
    });

    it('should preserve non-stdout/stderr fields in updatedToolOutput', async () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
      const result = await hook(makeBashPost(lines), 't1', { signal: mockSignal });

      const output = (
        result as {
          hookSpecificOutput: { updatedToolOutput: Record<string, unknown> };
        }
      ).hookSpecificOutput.updatedToolOutput;

      expect(output.interrupted).toBe(false);
    });

    it('should ignore non-Bash tools', async () => {
      const result = await hook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/f' },
          tool_response: 'x'.repeat(100000),
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
        },
        't1',
        { signal: mockSignal }
      );
      expect(result).toEqual({});
    });

    it('should skip when disabled', async () => {
      const disabled = createOutputLimiterPostHook({ enabled: false });
      const result = await disabled(makeBashPost('x'.repeat(100000)), 't1', { signal: mockSignal });
      expect(result).toEqual({});
    });

    it('should respect custom headLines/tailLines', async () => {
      const custom = createOutputLimiterPostHook({
        enabled: true,
        bash: { headLines: 10, tailLines: 10 },
      });
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');

      const result = await custom(makeBashPost(lines), 't1', { signal: mockSignal });
      const output = (
        result as {
          hookSpecificOutput: { updatedToolOutput: { stdout: string } };
        }
      ).hookSpecificOutput.updatedToolOutput;

      expect(output.stdout).toContain('line 0');
      expect(output.stdout).toContain('line 49');
      expect(output.stdout).not.toContain('line 20');
    });

    it('should handle missing stdout/stderr gracefully', async () => {
      const result = await hook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'test' },
          tool_response: {},
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
        },
        't1',
        { signal: mockSignal }
      );
      expect(result).toEqual({});
    });
  });
});
