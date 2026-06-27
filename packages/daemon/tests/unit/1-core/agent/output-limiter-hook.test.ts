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

      // Verify the command has smart truncation
      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const updatedInput = (
          result.hookSpecificOutput as { updatedInput: Record<string, unknown> }
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

      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
        },
      });
    });

    it('should preserve the original exit status when wrapping Bash commands', async () => {
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

      const result = await hook(input, 'test-id', { signal: mockSignal });

      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const updatedInput = (
          result.hookSpecificOutput as unknown as {
            updatedInput: Record<string, unknown>;
          }
        ).updatedInput;
        expect(updatedInput.command).toContain('exit_code=$?');
        expect(updatedInput.command).toContain('exit $exit_code');
      } else {
        throw new Error('Expected hookSpecificOutput in result');
      }
    });

    it('should capture both stdout and stderr into the temp file', async () => {
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

      const result = await hook(input, 'test-id', { signal: mockSignal });

      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const updatedInput = (
          result.hookSpecificOutput as unknown as {
            updatedInput: Record<string, unknown>;
          }
        ).updatedInput;
        // Redirect both stdout and stderr into the temp file, not stderr to original stdout.
        expect(updatedInput.command).toContain('> "$tmpfile" 2>&1');
        expect(updatedInput.command).not.toMatch(/\)\s*2>&1\s*>\s*"\$tmpfile"/);
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
          command: 'pwd',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      expect(result).toEqual({});
    });

    it('should wrap ls commands (ls -R can produce large output)', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'ls -R',
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
          updatedInput: {
            command: expect.stringContaining('tmpfile=$(mktemp)'),
          },
        },
      });
    });

    it('should not skip compound commands that have a head pipe in one segment', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'grep foo file | head -n 5; cat huge.log',
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
          updatedInput: {
            command: expect.stringContaining('tmpfile=$(mktemp)'),
          },
        },
      });
    });

    it('should not wrap directory-changing commands (cd breaks in subshell)', async () => {
      const cdInput: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'cd packages/daemon',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      expect(await hook(cdInput, 'test-id', { signal: mockSignal })).toEqual({});
    });

    it('should still wrap compound cd commands (cd pkg && bun test)', async () => {
      const compoundInput: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'cd packages/daemon && bun test',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(compoundInput, 'test-id', { signal: mockSignal });
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            command: expect.stringContaining('tmpfile=$(mktemp)'),
          },
        },
      });
    });

    it('should not wrap background commands (run_in_background)', async () => {
      const bgInput: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'make dev',
          run_in_background: true,
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      expect(await hook(bgInput, 'test-id', { signal: mockSignal })).toEqual({});
    });

    it('should enforce byte caps on head/tail output', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'cat large-file.json',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });
      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const cmd = (result.hookSpecificOutput as { updatedInput: Record<string, unknown> })
          .updatedInput.command as string;
        // head portion is piped through head -c to cap bytes
        expect(cmd).toContain('head -n 100 "$tmpfile" | head -c 20000');
        // tail portion is piped through tail -c to cap bytes
        expect(cmd).toContain('tail -n 200 "$tmpfile" | tail -c 40000');
      } else {
        throw new Error('Expected hookSpecificOutput in result');
      }
    });

    it('should not wrap commands matching excluded command prefixes', async () => {
      const gitHook = createOutputLimiterHook({
        enabled: true,
        bash: { excludedCommandPrefixes: ['git'] },
      });

      const gitInput: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'git fetch origin',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      expect(await gitHook(gitInput, 'test-id', { signal: mockSignal })).toEqual({});

      const nonGitInput: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'bun test',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id-2',
      };

      const result = await gitHook(nonGitInput, 'test-id-2', { signal: mockSignal });
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            command: expect.stringContaining('tmpfile=$(mktemp)'),
          },
        },
      });
    });

    it('should wrap git commands by default (no sandbox exclusion auto-pass)', async () => {
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

      const result = await hook(input, 'test-id', { signal: mockSignal });
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            command: expect.stringContaining('tmpfile=$(mktemp)'),
          },
        },
      });
    });

    it('should preserve heredoc delimiters by inserting a newline before the closing paren', async () => {
      const heredocInput: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: "cat <<'EOF'\nhello\nEOF",
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(heredocInput, 'test-id', { signal: mockSignal });

      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const updatedInput = (
          result.hookSpecificOutput as { updatedInput: Record<string, unknown> }
        ).updatedInput;
        const cmd = updatedInput.command as string;
        // The subshell opens with a newline after `(` and closes with a
        // newline before `)` so a trailing `EOF` delimiter stays on its
        // own line and is recognised by the shell.
        expect(cmd).toContain('(\n');
        expect(cmd).toContain('\n) > "$tmpfile"');
        expect(cmd).toContain('\nEOF\n');
      } else {
        throw new Error('Expected hookSpecificOutput in result');
      }
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

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            file_path: '/test/large-file.txt',
            limit: 1000,
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

    it('should map legacy read.maxChars to maxLines', async () => {
      const legacyHook = createOutputLimiterHook({
        enabled: true,
        read: { maxChars: 5000 },
      });

      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: {
          file_path: '/test/file.txt',
        },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await legacyHook(input, 'test-id', { signal: mockSignal });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            file_path: '/test/file.txt',
            limit: 100, // 5000 chars / 50 chars per line
          },
        },
      });
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

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            pattern: 'TODO',
            path: '/test',
            head_limit: 250,
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

  describe('Configuration', () => {
    it('should respect custom limits', async () => {
      const customHook = createOutputLimiterHook({
        enabled: true,
        bash: {
          headLines: 250,
          tailLines: 250,
        },
        read: {
          maxLines: 500,
        },
        grep: {
          maxMatches: 250,
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

      const readInput: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/test/file.txt' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id-2',
      };
      const readResult = await customHook(readInput, 'test-id-2', { signal: mockSignal });
      expect(readResult).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            file_path: '/test/file.txt',
            limit: 500,
          },
        },
      });
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

      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
        },
      });
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
