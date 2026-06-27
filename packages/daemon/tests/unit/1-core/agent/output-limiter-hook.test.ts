import { describe, it, expect, beforeEach } from 'bun:test';
import { createOutputLimiterHook } from '../../../../src/lib/agent/output-limiter-hook';
import type { PreToolUseHookInput, HookCallback } from '@anthropic-ai/claude-agent-sdk';

describe('OutputLimiterHook', () => {
  let hook: HookCallback;
  const mockSignal = new AbortController().signal;

  beforeEach(() => {
    hook = createOutputLimiterHook({ enabled: true });
  });

  describe('Bash tool limiting', () => {
    it('should add smart truncation to bash commands without existing limits', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'git diff HEAD~1',
          description: 'Show git diff',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });

      // Verify the command has smart truncation
      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const updatedInput = (
          result.hookSpecificOutput as unknown as {
            updatedInput: Record<string, unknown>;
          }
        ).updatedInput;
        expect(updatedInput.command).toContain('tmpfile=$(mktemp)');
        expect(updatedInput.command).toContain('head -n 100');
        expect(updatedInput.command).toContain('tail -n 200');
        expect(updatedInput.command).toContain('Truncated');
        expect(updatedInput.command).toContain('rm -f "$tmpfile"');

        // Verify description
        expect(updatedInput.description).toContain('first 100 + last 200 lines');
      } else {
        throw new Error('Expected hookSpecificOutput in result');
      }
    });

    it('should not modify commands that already have head limiting', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'git log | head -n 100',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      expect(result).toEqual({});
    });

    it('should not modify short commands', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'ls',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      expect(result).toEqual({});
    });
  });

  describe('Read tool limiting', () => {
    it('should add limit parameter to Read calls without existing limits', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: {
          file_path: '/test/large-file.txt',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: {
            file_path: '/test/large-file.txt',
            limit: 1000, // 50000 chars / 50 chars per line
          },
        },
      });
    });

    it('should not modify Read calls that already have limit', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: {
          file_path: '/test/file.txt',
          limit: 500,
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      expect(result).toEqual({});
    });
  });

  describe('Grep tool limiting', () => {
    it('should add head_limit parameter to Grep calls', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: {
          pattern: 'TODO',
          path: '/test',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: {
            pattern: 'TODO',
            path: '/test',
            head_limit: 500,
          },
        },
      });
    });

    it('should not modify Grep calls with existing head_limit', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: {
          pattern: 'TODO',
          head_limit: 100,
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      expect(result).toEqual({});
    });
  });

  describe('Glob tool limiting', () => {
    it('should add head_limit to Glob calls', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Glob',
        tool_input: {
          pattern: '**/*.ts',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: {
            pattern: '**/*.ts',
            head_limit: 1000,
          },
        },
      });
    });
  });

  describe('Configuration', () => {
    it('should respect custom limits', async () => {
      const customHook = createOutputLimiterHook({
        enabled: true,
        bash: {
          headLines: 250,
          tailLines: 250,
        },
        read: {
          maxChars: 25000,
        },
        grep: {
          maxMatches: 250,
        },
        glob: {
          maxFiles: 500,
        },
        excludeTools: [],
      });

      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'git log --oneline',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await customHook(input, 'test-id', { signal: mockSignal });

      // Verify custom limits are applied
      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const updatedInput = (
          result.hookSpecificOutput as unknown as {
            updatedInput: Record<string, unknown>;
          }
        ).updatedInput;
        expect(updatedInput.command).toContain('head -n 250');
        expect(updatedInput.command).toContain('tail -n 250');
      } else {
        throw new Error('Expected hookSpecificOutput in result');
      }
    });

    it('should skip processing when disabled', async () => {
      const disabledHook = createOutputLimiterHook({ enabled: false });

      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'git diff HEAD~1',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await disabledHook(input, 'test-id', {
        signal: mockSignal,
      });

      expect(result).toEqual({});
    });

    it('should deep-merge partial config with defaults', async () => {
      const partialHook = createOutputLimiterHook({
        enabled: true,
        bash: { headLines: 50 },
      });

      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'git log --oneline',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await partialHook(input, 'test-id', { signal: mockSignal });

      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });

      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const updatedInput = (
          result.hookSpecificOutput as unknown as {
            updatedInput: Record<string, unknown>;
          }
        ).updatedInput;
        // custom headLines wins
        expect(updatedInput.command).toContain('head -n 50');
        // tailLines falls back to default
        expect(updatedInput.command).toContain('tail -n 200');
      } else {
        throw new Error('Expected hookSpecificOutput in result');
      }
    });

    it('should exclude specified tools', async () => {
      const excludeHook = createOutputLimiterHook({
        enabled: true,
        excludeTools: ['Bash'],
      });

      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'git log --all',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await excludeHook(input, 'test-id', {
        signal: mockSignal,
      });

      expect(result).toEqual({});
    });
  });

  describe('Hook event filtering', () => {
    it('should only process PreToolUse events', async () => {
      const postInput = {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo test' },
        tool_response: 'test',
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(postInput as unknown as PreToolUseHookInput, 'test-id', {
        signal: mockSignal,
      });

      expect(result).toEqual({});
    });
  });
});
