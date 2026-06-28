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

      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const updatedInput = (
          result.hookSpecificOutput as { updatedInput: Record<string, unknown> }
        ).updatedInput;
        expect(updatedInput.command).toContain('tmpfile=$(mktemp)');
        expect(updatedInput.command).toContain('head -n 100');
        expect(updatedInput.command).toContain('tail -n 200');
        expect(updatedInput.command).toContain('Truncated');
        expect(updatedInput.command).toContain('rm -f "$tmpfile"');
        expect(updatedInput.description).toContain('first 100 + last 200 lines');
      } else {
        throw new Error('Expected hookSpecificOutput in result');
      }
    });

    it('should preserve the original exit status when wrapping Bash commands', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git diff HEAD~1' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const cmd = (result.hookSpecificOutput as { updatedInput: Record<string, unknown> })
          .updatedInput.command as string;
        expect(cmd).toContain('exit_code=$?');
        expect(cmd).toContain('exit $exit_code');
      }
    });

    it('should capture both stdout and stderr into the temp file', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git diff HEAD~1' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const cmd = (result.hookSpecificOutput as { updatedInput: Record<string, unknown> })
          .updatedInput.command as string;
        expect(cmd).toContain('> "$tmpfile" 2>&1');
      }
    });

    it('should use a subshell to isolate exit/set -e from the wrapper', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo before; set -e; false' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const cmd = (result.hookSpecificOutput as { updatedInput: Record<string, unknown> })
          .updatedInput.command as string;
        // Subshell so exit/set -e only kills the subshell, not the wrapper
        expect(cmd).toContain('(\n');
        expect(cmd).toContain('\n) > "$tmpfile" 2>&1');
        // Cleanup runs after the subshell
        expect(cmd).toContain('rm -f "$tmpfile"');
      }
    });

    it('should capture and replay cwd changes from the subshell', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cd packages/daemon && bun test' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const cmd = (result.hookSpecificOutput as { updatedInput: Record<string, unknown> })
          .updatedInput.command as string;
        // Subshell writes pwd to cwdfile
        expect(cmd).toContain('pwd >| "$cwdfile"');
        // Wrapper replays cwd after truncation
        expect(cmd).toContain('newcwd=$(cat "$cwdfile"');
        expect(cmd).toContain('cd "$newcwd"');
      }
    });

    it('should wrap commands that already have head/tail (stderr still uncapped)', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git log | head -n 100' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });
      // No longer skipped — stderr from `git log` can still overflow
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command: expect.stringContaining('tmpfile=$(mktemp)') },
        },
      });
    });

    it('should not modify short commands (pwd, which, whoami)', async () => {
      for (const cmd of ['pwd', 'which', 'whoami']) {
        const input: PreToolUseHookInput = {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: cmd },
          session_id: 'test-session',
          transcript_path: '/test/path',
          cwd: '/test/cwd',
          tool_use_id: 'test-id',
        };
        expect(await hook(input, 'test-id', { signal: mockSignal })).toEqual({});
      }
    });

    it('should wrap echo commands (command substitution can expand)', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo "$(cat huge.log)"' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command: expect.stringContaining('tmpfile=$(mktemp)') },
        },
      });
    });

    it('should wrap ls commands (ls -R can produce large output)', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls -R' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command: expect.stringContaining('tmpfile=$(mktemp)') },
        },
      });
    });

    it('should not wrap pure cd commands', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cd packages/daemon' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      expect(await hook(input, 'test-id', { signal: mockSignal })).toEqual({});
    });

    it('should still wrap compound cd commands (cd pkg && bun test)', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cd packages/daemon && bun test' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command: expect.stringContaining('tmpfile=$(mktemp)') },
        },
      });
    });

    it('should not wrap background commands (run_in_background)', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'make dev', run_in_background: true },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      expect(await hook(input, 'test-id', { signal: mockSignal })).toEqual({});
    });

    it('should enforce byte caps on head/tail output', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cat large-file.json' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });
      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const cmd = (result.hookSpecificOutput as { updatedInput: Record<string, unknown> })
          .updatedInput.command as string;
        expect(cmd).toContain('head -n 100 "$tmpfile" | head -c 20000');
        expect(cmd).toContain('tail -n 200 "$tmpfile" | tail -c 40000');
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
        tool_input: { command: 'git fetch origin' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      expect(await gitHook(gitInput, 'test-id', { signal: mockSignal })).toEqual({});
    });

    it('should strip quoted env var prefixes before exclusion checks', async () => {
      const gitHook = createOutputLimiterHook({
        enabled: true,
        bash: { excludedCommandPrefixes: ['git'] },
      });

      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: "GIT_SSH_COMMAND='ssh -i key' git fetch" },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      // Quoted env var is stripped, so `git` is recognised as excluded
      expect(await gitHook(input, 'test-id', { signal: mockSignal })).toEqual({});
    });

    it('should wrap git commands by default (no sandbox exclusion auto-pass)', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git diff HEAD~1' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command: expect.stringContaining('tmpfile=$(mktemp)') },
        },
      });
    });

    it('should preserve heredoc delimiters via newlines in the subshell', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: "cat <<'EOF'\nhello\nEOF" },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const cmd = (result.hookSpecificOutput as { updatedInput: Record<string, unknown> })
          .updatedInput.command as string;
        expect(cmd).toContain('(\n');
        expect(cmd).toContain('\nEOF\n');
      }
    });
  });

  describe('Read tool limiting', () => {
    it('should add limit parameter to Read calls without existing limits', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/test/large-file.txt' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          updatedInput: { file_path: '/test/large-file.txt', limit: 1000 },
        },
      });
    });

    it('should not modify Read calls that already have a positive limit within cap', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/test/file.txt', limit: 500 },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      expect(await hook(input, 'test-id', { signal: mockSignal })).toEqual({});
    });

    it('should clamp Read limit above the configured cap', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/test/file.txt', limit: 5000 },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          updatedInput: { file_path: '/test/file.txt', limit: 1000 },
        },
      });
    });

    it('should map legacy read.maxChars to maxLines', async () => {
      const legacyHook = createOutputLimiterHook({
        enabled: true,
        read: { maxChars: 5000 },
      });

      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/test/file.txt' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await legacyHook(input, 'test-id', { signal: mockSignal });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          updatedInput: { file_path: '/test/file.txt', limit: 100 },
        },
      });
    });
  });

  describe('Grep tool limiting', () => {
    it('should add head_limit parameter to Grep calls', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'TODO', path: '/test' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          updatedInput: { pattern: 'TODO', path: '/test', head_limit: 250 },
        },
      });
    });

    it('should not modify Grep calls with positive head_limit within cap', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'TODO', head_limit: 100 },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      expect(await hook(input, 'test-id', { signal: mockSignal })).toEqual({});
    });

    it('should clamp Grep head_limit=0 (unlimited) to the configured cap', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'TODO', head_limit: 0 },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          updatedInput: { pattern: 'TODO', head_limit: 250 },
        },
      });
    });

    it('should clamp Grep head_limit above the configured cap', async () => {
      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'TODO', head_limit: 1000 },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await hook(input, 'test-id', { signal: mockSignal });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          updatedInput: { pattern: 'TODO', head_limit: 250 },
        },
      });
    });
  });

  describe('Configuration', () => {
    it('should respect custom limits', async () => {
      const customHook = createOutputLimiterHook({
        enabled: true,
        bash: { headLines: 250, tailLines: 250 },
        read: { maxLines: 500 },
        grep: { maxMatches: 250 },
        excludeTools: [],
      });

      const bashInput: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git log --oneline' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await customHook(bashInput, 'test-id', { signal: mockSignal });
      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const cmd = (result.hookSpecificOutput as { updatedInput: Record<string, unknown> })
          .updatedInput.command as string;
        expect(cmd).toContain('head -n 250');
        expect(cmd).toContain('tail -n 250');
      }
    });

    it('should skip processing when disabled', async () => {
      const disabledHook = createOutputLimiterHook({ enabled: false });

      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git diff HEAD~1' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      expect(await disabledHook(input, 'test-id', { signal: mockSignal })).toEqual({});
    });

    it('should deep-merge partial config with defaults', async () => {
      const partialHook = createOutputLimiterHook({
        enabled: true,
        bash: { headLines: 50 },
      });

      const input: PreToolUseHookInput = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git log --oneline' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      const result = await partialHook(input, 'test-id', { signal: mockSignal });
      if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
        const cmd = (result.hookSpecificOutput as { updatedInput: Record<string, unknown> })
          .updatedInput.command as string;
        expect(cmd).toContain('head -n 50');
        expect(cmd).toContain('tail -n 200');
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
        tool_input: { command: 'git log --all' },
        session_id: 'test-session',
        transcript_path: '/test/path',
        cwd: '/test/cwd',
        tool_use_id: 'test-id',
      };

      expect(await excludeHook(input, 'test-id', { signal: mockSignal })).toEqual({});
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
