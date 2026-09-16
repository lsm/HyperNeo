import { describe, it, expect, beforeEach } from 'bun:test';
import type {
  HookCallback,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import {
  createLoopDetectorHook,
  createLoopDetectorHooks,
} from '../../../../src/lib/agent/loop-detector-hook';

const signal = new AbortController().signal;

function makePreToolUse(
  tool_name: string,
  tool_input: Record<string, unknown>,
  overrides: Partial<PreToolUseHookInput> = {}
): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
    session_id: 'test-session',
    transcript_path: '/test/path',
    cwd: '/test/cwd',
    tool_use_id: 'test-id',
    ...overrides,
  };
}

function makePostToolUse(
  tool_name: string,
  tool_input: Record<string, unknown>,
  tool_response: unknown,
  overrides: Partial<PostToolUseHookInput> = {}
): PostToolUseHookInput {
  return {
    hook_event_name: 'PostToolUse',
    tool_name,
    tool_input,
    tool_response,
    session_id: 'test-session',
    transcript_path: '/test/path',
    cwd: '/test/cwd',
    tool_use_id: 'test-id',
    ...overrides,
  };
}

function makePostToolUseFailure(
  tool_name: string,
  tool_input: Record<string, unknown>,
  overrides: Partial<PostToolUseFailureHookInput> = {}
): PostToolUseFailureHookInput {
  return {
    hook_event_name: 'PostToolUseFailure',
    tool_name,
    tool_input,
    session_id: 'test-session',
    transcript_path: '/test/path',
    cwd: '/test/cwd',
    tool_use_id: 'test-id',
    error: 'boom',
    ...overrides,
  };
}

async function call(hook: HookCallback, input: PreToolUseHookInput) {
  return hook(input, 'test-id', { signal });
}

async function callPost(
  hook: HookCallback,
  input: PostToolUseHookInput | PostToolUseFailureHookInput
) {
  return hook(input, 'test-id', { signal });
}

describe('LoopDetectorHook', () => {
  let hook: HookCallback;

  beforeEach(() => {
    hook = createLoopDetectorHook();
  });

  describe('Read — consecutive streak semantics', () => {
    it('passes through below the threshold', async () => {
      const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      expect(await call(hook, input)).toEqual({});
      expect(await call(hook, input)).toEqual({});
    });

    it('denies on the third consecutive identical Read', async () => {
      const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      await call(hook, input);
      await call(hook, input);
      const result = await call(hook, input);

      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
        },
      });
      const reason = (
        result as {
          hookSpecificOutput: { permissionDecisionReason: string };
        }
      ).hookSpecificOutput.permissionDecisionReason;
      expect(reason).toContain('Loop detected');
      expect(reason).toContain('Read');
      expect(reason).toContain('/abs/foo.ts');
      expect(reason).toContain('TodoWrite');
    });

    it('normalises relative file paths against cwd so ./foo and foo collide', async () => {
      const a = makePreToolUse('Read', { file_path: './foo.ts' }, { cwd: '/work' });
      const b = makePreToolUse('Read', { file_path: 'foo.ts' }, { cwd: '/work' });
      const c = makePreToolUse('Read', { file_path: '/work/foo.ts' }, { cwd: '/work' });

      expect(await call(hook, a)).toEqual({});
      expect(await call(hook, b)).toEqual({});
      const result = await call(hook, c);
      expect(result).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('a different tracked call in between resets the consecutive streak', async () => {
      const a = makePreToolUse('Read', { file_path: '/abs/a.ts' });
      const b = makePreToolUse('Read', { file_path: '/abs/b.ts' });
      expect(await call(hook, a)).toEqual({});
      expect(await call(hook, b)).toEqual({});
      expect(await call(hook, a)).toEqual({});
      expect(await call(hook, a)).toEqual({});
      const result = await call(hook, a);
      expect(result).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('treats different offsets as different keys (paginated reads not penalised)', async () => {
      const a = makePreToolUse('Read', { file_path: '/abs/foo.ts', offset: 0 });
      const b = makePreToolUse('Read', { file_path: '/abs/foo.ts', offset: 100 });
      for (let i = 0; i < 6; i++) {
        expect(await call(hook, i % 2 === 0 ? a : b)).toEqual({});
      }
    });

    it('continues to deny on every retry of the same key after a deny (until a different action)', async () => {
      const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      await call(hook, input);
      await call(hook, input);
      expect(await call(hook, input)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(await call(hook, input)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(await call(hook, input)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });

      const other = makePreToolUse('Read', { file_path: '/abs/other.ts' });
      expect(await call(hook, other)).toEqual({});
      expect(await call(hook, input)).toEqual({});
      expect(await call(hook, input)).toEqual({});
    });
  });

  describe('Grep / Glob', () => {
    it('uses a higher threshold (5) for Grep', async () => {
      const input = makePreToolUse('Grep', { pattern: 'TODO', path: 'src' });
      for (let i = 0; i < 4; i++) {
        expect(await call(hook, input)).toEqual({});
      }
      const result = await call(hook, input);
      expect(result).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('uses a higher threshold (5) for Glob', async () => {
      const input = makePreToolUse('Glob', { pattern: '**/*.ts' });
      for (let i = 0; i < 4; i++) {
        expect(await call(hook, input)).toEqual({});
      }
      const result = await call(hook, input);
      expect(result).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('treats key-order as identical for Grep args', async () => {
      const a = makePreToolUse('Grep', { pattern: 'TODO', path: 'src' });
      const b = makePreToolUse('Grep', { path: 'src', pattern: 'TODO' });
      for (let i = 0; i < 4; i++) {
        expect(await call(hook, i % 2 === 0 ? a : b)).toEqual({});
      }
      const result = await call(hook, a);
      expect(result).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });
  });

  describe('untracked tools', () => {
    it('does not deny on Bash via the legacy single-hook factory (no failure observer)', async () => {
      const input = makePreToolUse('Bash', { command: 'git status', description: 'status' });
      for (let i = 0; i < 20; i++) {
        expect(await call(hook, input)).toEqual({});
      }
    });

    it('passes through unknown tools without denying', async () => {
      const input = makePreToolUse('SomeRandomTool', { foo: 'bar' });
      for (let i = 0; i < 10; i++) {
        expect(await call(hook, input)).toEqual({});
      }
    });

    it('a Bash call DOES reset a tracked Read streak (different lastKey)', async () => {
      const read = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      const bash = makePreToolUse('Bash', { command: 'echo hi' });
      expect(await call(hook, read)).toEqual({});
      expect(await call(hook, bash)).toEqual({});
      expect(await call(hook, read)).toEqual({});
      expect(await call(hook, read)).toEqual({});
      expect(await call(hook, read)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('an untracked tool call breaks a denied streak (edit-then-read flow)', async () => {
      const read = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      const edit = makePreToolUse('Edit', {
        file_path: '/abs/foo.ts',
        old_string: 'a',
        new_string: 'b',
      });
      await call(hook, read);
      await call(hook, read);
      expect(await call(hook, read)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(await call(hook, edit)).toEqual({});
      expect(await call(hook, read)).toEqual({});
      expect(await call(hook, read)).toEqual({});
      expect(await call(hook, read)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('ignores non-PreToolUse events', async () => {
      const result = await hook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/abs/foo.ts' },
          tool_response: 'whatever',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/c',
          tool_use_id: 'x',
        } as unknown as PreToolUseHookInput,
        'x',
        { signal }
      );
      expect(result).toEqual({});
    });
  });

  describe('configuration', () => {
    it('respects a custom threshold', async () => {
      const customHook = createLoopDetectorHook({ thresholds: { Read: 2 } });
      const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      expect(await call(customHook, input)).toEqual({});
      const result = await call(customHook, input);
      expect(result).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('disables entirely when enabled=false', async () => {
      const offHook = createLoopDetectorHook({ enabled: false });
      const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      for (let i = 0; i < 10; i++) {
        expect(await call(offHook, input)).toEqual({});
      }
    });

    it('threshold overrides REPLACE the default tracked-tool set', async () => {
      const narrow = createLoopDetectorHook({ thresholds: { Read: 2 } });

      const read = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      expect(await call(narrow, read)).toEqual({});
      expect(await call(narrow, read)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });

      const grep = makePreToolUse('Grep', { pattern: 'TODO', path: 'src' });
      for (let i = 0; i < 50; i++) {
        expect(await call(narrow, grep)).toEqual({});
      }

      const glob = makePreToolUse('Glob', { pattern: '**/*.ts' });
      for (let i = 0; i < 50; i++) {
        expect(await call(narrow, glob)).toEqual({});
      }
    });

    it('omitting thresholds inherits the defaults wholesale', async () => {
      const inheritsDefaults = createLoopDetectorHook({ windowMs: 30_000 });
      const read = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      expect(await call(inheritsDefaults, read)).toEqual({});
      expect(await call(inheritsDefaults, read)).toEqual({});
      expect(await call(inheritsDefaults, read)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });
  });

  describe('per-(session, agent) isolation', () => {
    it("does not pollute one session's streak with another session's reads", async () => {
      const a = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { session_id: 'sess-A' });
      const b = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { session_id: 'sess-B' });
      expect(await call(hook, a)).toEqual({});
      expect(await call(hook, b)).toEqual({});
      expect(await call(hook, a)).toEqual({});
      expect(await call(hook, a)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(await call(hook, b)).toEqual({});
    });

    it('isolates main thread from subagent (different agent_id)', async () => {
      const main = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: undefined });
      const subagent = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: 'sub-1' });
      expect(await call(hook, subagent)).toEqual({});
      expect(await call(hook, subagent)).toEqual({});
      expect(await call(hook, main)).toEqual({});
      expect(await call(hook, main)).toEqual({});
      expect(await call(hook, main)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(await call(hook, subagent)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('isolates two subagents from each other', async () => {
      const subA = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: 'sub-A' });
      const subB = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: 'sub-B' });
      expect(await call(hook, subA)).toEqual({});
      expect(await call(hook, subB)).toEqual({});
      expect(await call(hook, subA)).toEqual({});
      expect(await call(hook, subB)).toEqual({});
      expect(await call(hook, subA)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(await call(hook, subB)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });
  });

  describe('sliding window', () => {
    it('resets the counter when the window expires', async () => {
      const shortWindowHook = createLoopDetectorHook({ windowMs: 1 });
      const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });

      expect(await call(shortWindowHook, input)).toEqual({});
      expect(await call(shortWindowHook, input)).toEqual({});
      await new Promise((r) => setTimeout(r, 5));
      expect(await call(shortWindowHook, input)).toEqual({});
    });

    it('enforces the window over the FULL streak duration (slow periodic retries are not penalised)', async () => {
      const original = Date.now;
      let now = 1_000_000;
      Date.now = () => now;
      try {
        const slowHook = createLoopDetectorHook({ windowMs: 5 });
        const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });

        expect(await call(slowHook, input)).toEqual({});
        now += 4;
        expect(await call(slowHook, input)).toEqual({});
        now += 4;
        expect(await call(slowHook, input)).toEqual({});
        now += 4;
        expect(await call(slowHook, input)).toEqual({});
      } finally {
        Date.now = original;
      }
    });

    it('still denies bursty repeats well within the window', async () => {
      const tightHook = createLoopDetectorHook({ windowMs: 60_000 });
      const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      await call(tightHook, input);
      await call(tightHook, input);
      expect(await call(tightHook, input)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });
  });

  describe('Bash dead-loop detection (PostToolUse hybrid)', () => {
    const FAILING_BASH = makePreToolUse('Bash', {
      command: 'ls -la .git/hooks 2>&1',
      description: 'List git hooks',
    });

    function makeBashSuccessResponse(): unknown {
      return {
        stdout: 'pre-commit\npre-push\n',
        stderr: '',
      };
    }

    async function recordBashFailure(
      postToolUseFailure: HookCallback,
      tool_input: Record<string, unknown>,
      overrides: Partial<PostToolUseFailureHookInput> = {}
    ) {
      await callPost(postToolUseFailure, makePostToolUseFailure('Bash', tool_input, overrides));
    }

    it('denies after 5 consecutive identical failing Bash commands', async () => {
      const { preToolUse, postToolUse, postToolUseFailure } = createLoopDetectorHooks();

      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, FAILING_BASH)).toEqual({});
        await recordBashFailure(
          postToolUseFailure,
          FAILING_BASH.tool_input as Record<string, unknown>
        );
      }
      expect(await call(preToolUse, FAILING_BASH)).toEqual({});
      await recordBashFailure(
        postToolUseFailure,
        FAILING_BASH.tool_input as Record<string, unknown>
      );

      const result = await call(preToolUse, FAILING_BASH);
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
        },
      });
      const reason = (result as { hookSpecificOutput: { permissionDecisionReason: string } })
        .hookSpecificOutput.permissionDecisionReason;
      expect(reason).toContain('Bash dead-loop detected');
      expect(reason).toContain('ls -la .git/hooks 2>&1');
    });

    it('does NOT deny when the same command succeeds repeatedly (legitimate polling)', async () => {
      const { preToolUse, postToolUse } = createLoopDetectorHooks();
      const cmd = makePreToolUse('Bash', { command: 'git status' });

      for (let i = 0; i < 20; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(
          postToolUse,
          makePostToolUse(
            'Bash',
            cmd.tool_input as Record<string, unknown>,
            makeBashSuccessResponse()
          )
        );
      }
    });

    it('does NOT deny when mixed success/failure (a single success clears the streak deny)', async () => {
      const { preToolUse, postToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const cmd = makePreToolUse('Bash', { command: 'bun test foo.test.ts' });

      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await recordBashFailure(postToolUseFailure, cmd.tool_input as Record<string, unknown>);
      }
      expect(await call(preToolUse, cmd)).toEqual({});
      await callPost(
        postToolUse,
        makePostToolUse(
          'Bash',
          cmd.tool_input as Record<string, unknown>,
          makeBashSuccessResponse()
        )
      );
      expect(await call(preToolUse, cmd)).toEqual({});
      await recordBashFailure(postToolUseFailure, cmd.tool_input as Record<string, unknown>);
      expect(await call(preToolUse, cmd)).toEqual({});
    });

    it('a different Bash command resets the streak (semantic streak reset)', async () => {
      const { preToolUse, postToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const a = makePreToolUse('Bash', { command: 'ls nonexistent-a 2>&1' });
      const b = makePreToolUse('Bash', { command: 'ls nonexistent-b 2>&1' });

      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, a)).toEqual({});
        await recordBashFailure(postToolUseFailure, a.tool_input as Record<string, unknown>);
      }
      expect(await call(preToolUse, b)).toEqual({});
      await recordBashFailure(postToolUseFailure, b.tool_input as Record<string, unknown>);
      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, a)).toEqual({});
        await recordBashFailure(postToolUseFailure, a.tool_input as Record<string, unknown>);
      }
      expect(await call(preToolUse, a)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('a non-Bash tool call also resets the Bash streak', async () => {
      const { preToolUse, postToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const bash = makePreToolUse('Bash', { command: 'ls bad 2>&1' });
      const read = makePreToolUse('Read', { file_path: '/abs/foo.ts' });

      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, bash)).toEqual({});
        await recordBashFailure(postToolUseFailure, bash.tool_input as Record<string, unknown>);
      }
      expect(await call(preToolUse, read)).toEqual({});
      expect(await call(preToolUse, bash)).toEqual({});
      await recordBashFailure(postToolUseFailure, bash.tool_input as Record<string, unknown>);
      for (let i = 0; i < 3; i++) {
        expect(await call(preToolUse, bash)).toEqual({});
        await recordBashFailure(postToolUseFailure, bash.tool_input as Record<string, unknown>);
      }
      expect(await call(preToolUse, bash)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('counts PostToolUseFailure as a failure outcome', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const cmd = makePreToolUse('Bash', { command: 'do-the-thing' });

      for (let i = 0; i < 5; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(
          postToolUseFailure,
          makePostToolUseFailure('Bash', cmd.tool_input as Record<string, unknown>)
        );
      }
      expect(await call(preToolUse, cmd)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('continues denying on every retry of the same failing command (loop is broken, not throttled)', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();

      for (let i = 0; i < 5; i++) {
        expect(await call(preToolUse, FAILING_BASH)).toEqual({});
        await recordBashFailure(
          postToolUseFailure,
          FAILING_BASH.tool_input as Record<string, unknown>
        );
      }
      expect(await call(preToolUse, FAILING_BASH)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(await call(preToolUse, FAILING_BASH)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(await call(preToolUse, FAILING_BASH)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('respects bash.enabled=false (no Bash deny ever)', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks({
        bash: { enabled: false, threshold: 5, failuresRequired: 5 },
      });

      for (let i = 0; i < 50; i++) {
        expect(await call(preToolUse, FAILING_BASH)).toEqual({});
        await recordBashFailure(
          postToolUseFailure,
          FAILING_BASH.tool_input as Record<string, unknown>
        );
      }
    });

    it('respects custom bash thresholds', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks({
        bash: { enabled: true, threshold: 2, failuresRequired: 2 },
      });

      expect(await call(preToolUse, FAILING_BASH)).toEqual({});
      await recordBashFailure(
        postToolUseFailure,
        FAILING_BASH.tool_input as Record<string, unknown>
      );
      expect(await call(preToolUse, FAILING_BASH)).toEqual({});
      await recordBashFailure(
        postToolUseFailure,
        FAILING_BASH.tool_input as Record<string, unknown>
      );
      expect(await call(preToolUse, FAILING_BASH)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('isolates Bash failure rings per (session, agent)', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const aPre = makePreToolUse('Bash', { command: 'ls bad 2>&1' }, { session_id: 'sess-A' });
      const bPre = makePreToolUse('Bash', { command: 'ls bad 2>&1' }, { session_id: 'sess-B' });

      for (let i = 0; i < 5; i++) {
        expect(await call(preToolUse, aPre)).toEqual({});
        await recordBashFailure(postToolUseFailure, aPre.tool_input as Record<string, unknown>, {
          session_id: 'sess-A',
        });
      }
      expect(await call(preToolUse, aPre)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, bPre)).toEqual({});
      }
    });

    it('PostToolUse hook ignores non-Bash tools', async () => {
      const { preToolUse, postToolUse } = createLoopDetectorHooks();
      await callPost(
        postToolUse,
        makePostToolUse('Read', { file_path: '/abs/foo.ts' }, { is_error: true, stderr: 'boom' })
      );
      const cmd = makePreToolUse('Bash', { command: 'true' });
      for (let i = 0; i < 6; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(
          postToolUse,
          makePostToolUse(
            'Bash',
            cmd.tool_input as Record<string, unknown>,
            makeBashSuccessResponse()
          )
        );
      }
    });

    it('strips `description` from the Bash fingerprint (reworded labels still loop-detect)', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const command = 'ls -la .git/hooks 2>&1';
      const descriptions = [
        'Check git hooks',
        'List hook files',
        'Inspect hook dir',
        'Show hooks',
        'View hooks dir',
        'Look at hooks',
      ];

      for (let i = 0; i < 5; i++) {
        const pre = makePreToolUse('Bash', { command, description: descriptions[i] });
        expect(await call(preToolUse, pre)).toEqual({});
        await recordBashFailure(postToolUseFailure, pre.tool_input as Record<string, unknown>);
      }
      const finalPre = makePreToolUse('Bash', { command, description: descriptions[5] });
      expect(await call(preToolUse, finalPre)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('does NOT count user/system interrupts as failures', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const cmd = makePreToolUse('Bash', { command: 'sleep 100' });
      const args = cmd.tool_input as Record<string, unknown>;

      for (let i = 0; i < 6; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(
          postToolUseFailure,
          makePostToolUseFailure('Bash', args, { is_interrupt: true })
        );
      }
    });

    it('counts non-interrupt PostToolUseFailure as a real failure', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const args = FAILING_BASH.tool_input as Record<string, unknown>;

      for (let i = 0; i < 5; i++) {
        expect(await call(preToolUse, FAILING_BASH)).toEqual({});
        await callPost(postToolUseFailure, makePostToolUseFailure('Bash', args));
      }
      expect(await call(preToolUse, FAILING_BASH)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('does NOT block legitimate retries after a long quiet period (stale rings expire)', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks({ windowMs: 50 });
      const cmd = makePreToolUse('Bash', { command: 'ls /nope' });
      const args = cmd.tool_input as Record<string, unknown>;

      for (let i = 0; i < 5; i++) {
        await call(preToolUse, cmd);
        await recordBashFailure(postToolUseFailure, args);
      }

      await new Promise((r) => setTimeout(r, 80));
      expect(await call(preToolUse, cmd)).toEqual({});
    });

    it('expires stale failure rings in lastNAllFailures even when the map stays small', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks({
        windowMs: 30,
        bash: { enabled: true, threshold: 2, failuresRequired: 2 },
      });
      const cmd = makePreToolUse('Bash', { command: 'flaky' });
      const args = cmd.tool_input as Record<string, unknown>;

      await call(preToolUse, cmd);
      await recordBashFailure(postToolUseFailure, args);
      await call(preToolUse, cmd);
      await recordBashFailure(postToolUseFailure, args);

      expect(await call(preToolUse, cmd)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(await call(preToolUse, cmd)).toEqual({});
      await recordBashFailure(postToolUseFailure, args);

      expect(await call(preToolUse, cmd)).toEqual({});
    });

    it('treats identical commands in different cwds as separate fingerprints', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const argsA = { command: 'git status' };
      const argsB = { command: 'git status' };

      for (let i = 0; i < 5; i++) {
        const pre = makePreToolUse('Bash', argsA, { cwd: '/repo-a' });
        await call(preToolUse, pre);
        await recordBashFailure(postToolUseFailure, argsA, { cwd: '/repo-a' });
      }
      expect(
        await call(preToolUse, makePreToolUse('Bash', argsA, { cwd: '/repo-a' }))
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });

      expect(await call(preToolUse, makePreToolUse('Bash', argsB, { cwd: '/repo-b' }))).toEqual({});
    });

    it('canonicalises optional Bash args so omitted vs explicit defaults collide', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const command = 'git status';

      for (let i = 0; i < 3; i++) {
        const pre = makePreToolUse('Bash', { command, run_in_background: false });
        expect(await call(preToolUse, pre)).toEqual({});
        await recordBashFailure(postToolUseFailure, pre.tool_input as Record<string, unknown>);
      }

      for (let i = 0; i < 2; i++) {
        const pre = makePreToolUse('Bash', { command });
        expect(await call(preToolUse, pre)).toEqual({});
        await recordBashFailure(postToolUseFailure, pre.tool_input as Record<string, unknown>);
      }

      expect(await call(preToolUse, makePreToolUse('Bash', { command }))).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });
  });

  describe('deny message content (characterization)', () => {
    function denyReason(result: unknown): string {
      return (result as { hookSpecificOutput: { permissionDecisionReason: string } })
        .hookSpecificOutput.permissionDecisionReason;
    }

    it('pins the exact generic loop recovery message', async () => {
      const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      await call(hook, input);
      await call(hook, input);
      const result = await call(hook, input);

      expect(denyReason(result)).toBe(
        'Loop detected: Read was called 3 times in a row with identical arguments (file_path=/abs/foo.ts).' +
          ' The result has not changed since the previous call. STOP re-running this tool — move on to the next step in your task.' +
          ' If you have a TodoWrite list, mark progress and proceed to the next item.' +
          ' If you genuinely need fresh data, perform a *different* action (edit a file, run a command, ask a question) before retrying.'
      );
    });

    it('pins the exact Bash dead-loop recovery message', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const cmd = makePreToolUse('Bash', {
        command: 'ls -la .git/hooks 2>&1',
        description: 'List git hooks',
      });

      for (let i = 0; i < 5; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(
          postToolUseFailure,
          makePostToolUseFailure('Bash', cmd.tool_input as Record<string, unknown>)
        );
      }
      const result = await call(preToolUse, cmd);

      expect(denyReason(result)).toBe(
        'Bash dead-loop detected: the same command was run 6 times in a row and the last 5 attempts all failed (command=ls -la .git/hooks 2>&1).' +
          ' Re-running the same failing command will not change the outcome. STOP and reconsider:' +
          ' (1) read the previous error output carefully,' +
          ' (2) inspect the relevant files or run a *different* diagnostic command,' +
          ' (3) only retry after you have changed something that could plausibly affect the outcome.' +
          ' If you are checking for a file or path, run a different probe (e.g. `ls` on the parent directory) instead of re-running the failing command.'
      );
    });
  });

  describe('argument summary rules (characterization)', () => {
    function denyReason(result: unknown): string {
      return (result as { hookSpecificOutput: { permissionDecisionReason: string } })
        .hookSpecificOutput.permissionDecisionReason;
    }

    it('summarises Grep args as pattern then path', async () => {
      const input = makePreToolUse('Grep', { pattern: 'TODO', path: 'src' });
      for (let i = 0; i < 4; i++) {
        await call(hook, input);
      }
      const result = await call(hook, input);
      expect(denyReason(result)).toContain('(pattern=TODO, path=src)');
    });

    it('excludes a stray path field from the Read summary', async () => {
      const input = makePreToolUse('Read', { file_path: '/abs/foo.ts', path: '/stray' });
      await call(hook, input);
      await call(hook, input);
      const result = await call(hook, input);
      const reason = denyReason(result);
      expect(reason).toContain('(file_path=/abs/foo.ts)');
      expect(reason).not.toContain('path=/stray');
    });

    it('falls back to a truncated JSON dump when no known arg fields exist', async () => {
      const jsonHook = createLoopDetectorHook({ thresholds: { WebFetch: 2 } });
      const input = makePreToolUse('WebFetch', { url: 'https://example.com' });
      expect(await call(jsonHook, input)).toEqual({});
      const result = await call(jsonHook, input);
      expect(denyReason(result)).toContain('({"url":"https://example.com"})');
    });

    it('truncates the Bash command in the summary to 160 chars', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const command = 'x'.repeat(200);
      const cmd = makePreToolUse('Bash', { command });

      for (let i = 0; i < 5; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(
          postToolUseFailure,
          makePostToolUseFailure('Bash', cmd.tool_input as Record<string, unknown>)
        );
      }
      const result = await call(preToolUse, cmd);
      const reason = denyReason(result);
      expect(reason).toContain(`command=${'x'.repeat(160)}`);
      expect(reason).not.toContain('x'.repeat(161));
    });

    it('truncates the joined candidate summary to 240 chars', async () => {
      const pattern = 'p'.repeat(300);
      const input = makePreToolUse('Grep', { pattern, path: 'src' });
      for (let i = 0; i < 4; i++) {
        await call(hook, input);
      }
      const result = await call(hook, input);
      const expected = `pattern=${pattern}, path=src`.slice(0, 240);
      expect(denyReason(result)).toContain(`(${expected}).`);
      expect(denyReason(result)).not.toContain(', path=src');
    });
  });

  describe('arg fingerprint similarity rules (characterization)', () => {
    it('treats nested objects with different key order as identical', async () => {
      const nestedHook = createLoopDetectorHook({ thresholds: { MyTool: 2 } });
      const a = makePreToolUse('MyTool', { opts: { x: 1, y: 2 } });
      const b = makePreToolUse('MyTool', { opts: { y: 2, x: 1 } });
      expect(await call(nestedHook, a)).toEqual({});
      expect(await call(nestedHook, b)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('treats arrays with different element order as different keys', async () => {
      const nestedHook = createLoopDetectorHook({ thresholds: { MyTool: 3 } });
      const a = makePreToolUse('MyTool', { opts: [1, 2] });
      const b = makePreToolUse('MyTool', { opts: [2, 1] });
      for (let i = 0; i < 6; i++) {
        expect(await call(nestedHook, i % 2 === 0 ? a : b)).toEqual({});
      }
    });

    it('does not normalise relative Read paths when cwd is absent', async () => {
      const a = makePreToolUse('Read', { file_path: 'foo.ts' }, { cwd: undefined });
      const b = makePreToolUse('Read', { file_path: './foo.ts' }, { cwd: undefined });
      for (let i = 0; i < 6; i++) {
        expect(await call(hook, i % 2 === 0 ? a : b)).toEqual({});
      }
      expect(await call(hook, a)).toEqual({});
      expect(await call(hook, a)).toEqual({});
      expect(await call(hook, a)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });
  });

  describe('window boundaries (characterization)', () => {
    it('treats a streak exactly windowMs old as still inside the window (inclusive)', async () => {
      const original = Date.now;
      let now = 1_000_000;
      Date.now = () => now;
      try {
        const boundaryHook = createLoopDetectorHook({ windowMs: 100 });
        const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });

        expect(await call(boundaryHook, input)).toEqual({});
        now += 50;
        expect(await call(boundaryHook, input)).toEqual({});
        now += 50;
        expect(await call(boundaryHook, input)).toMatchObject({
          hookSpecificOutput: { permissionDecision: 'deny' },
        });
      } finally {
        Date.now = original;
      }
    });

    it('resets a streak one millisecond past the window', async () => {
      const original = Date.now;
      let now = 1_000_000;
      Date.now = () => now;
      try {
        const boundaryHook = createLoopDetectorHook({ windowMs: 100 });
        const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });

        expect(await call(boundaryHook, input)).toEqual({});
        now += 50;
        expect(await call(boundaryHook, input)).toEqual({});
        now += 51;
        expect(await call(boundaryHook, input)).toEqual({});
      } finally {
        Date.now = original;
      }
    });

    it('keeps a failure ring exactly windowMs old (staleness is strictly greater)', async () => {
      const original = Date.now;
      let now = 1_000_000;
      Date.now = () => now;
      try {
        const { preToolUse, postToolUseFailure } = createLoopDetectorHooks({
          windowMs: 50,
          bash: { enabled: true, threshold: 1, failuresRequired: 2 },
        });
        const cmd = makePreToolUse('Bash', { command: 'flaky-cmd' });
        const args = cmd.tool_input as Record<string, unknown>;

        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(postToolUseFailure, makePostToolUseFailure('Bash', args));
        now += 50;
        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(postToolUseFailure, makePostToolUseFailure('Bash', args));
        expect(await call(preToolUse, cmd)).toMatchObject({
          hookSpecificOutput: { permissionDecision: 'deny' },
        });
      } finally {
        Date.now = original;
      }
    });

    it('expires a failure ring one millisecond past the window', async () => {
      const original = Date.now;
      let now = 1_000_000;
      Date.now = () => now;
      try {
        const { preToolUse, postToolUseFailure } = createLoopDetectorHooks({
          windowMs: 50,
          bash: { enabled: true, threshold: 1, failuresRequired: 2 },
        });
        const cmd = makePreToolUse('Bash', { command: 'flaky-cmd' });
        const args = cmd.tool_input as Record<string, unknown>;

        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(postToolUseFailure, makePostToolUseFailure('Bash', args));
        now += 51;
        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(postToolUseFailure, makePostToolUseFailure('Bash', args));
        expect(await call(preToolUse, cmd)).toEqual({});
      } finally {
        Date.now = original;
      }
    });
  });

  describe('Bash failure-ring semantics (characterization)', () => {
    async function fail(
      postToolUseFailure: HookCallback,
      tool_input: Record<string, unknown>
    ): Promise<void> {
      await callPost(postToolUseFailure, makePostToolUseFailure('Bash', tool_input));
    }

    async function succeed(
      postToolUse: HookCallback,
      tool_input: Record<string, unknown>
    ): Promise<void> {
      await callPost(postToolUse, makePostToolUse('Bash', tool_input, { stdout: 'ok' }));
    }

    it('does not deny when the streak threshold is met but the ring has fewer than failuresRequired outcomes', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks({
        bash: { enabled: true, threshold: 3, failuresRequired: 5 },
      });
      const cmd = makePreToolUse('Bash', { command: 'flaky-cmd' });
      const args = cmd.tool_input as Record<string, unknown>;

      for (let i = 0; i < 5; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await fail(postToolUseFailure, args);
      }
      expect(await call(preToolUse, cmd)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('a single success requires failuresRequired fresh failures before denying again (ring window)', async () => {
      const { preToolUse, postToolUse, postToolUseFailure } = createLoopDetectorHooks({
        bash: { enabled: true, threshold: 2, failuresRequired: 3 },
      });
      const cmd = makePreToolUse('Bash', { command: 'flaky-cmd' });
      const args = cmd.tool_input as Record<string, unknown>;

      for (let i = 0; i < 3; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await fail(postToolUseFailure, args);
      }
      expect(await call(preToolUse, cmd)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });

      await succeed(postToolUse, args);
      expect(await call(preToolUse, cmd)).toEqual({});
      await fail(postToolUseFailure, args);
      expect(await call(preToolUse, cmd)).toEqual({});
      await fail(postToolUseFailure, args);
      expect(await call(preToolUse, cmd)).toEqual({});
      await fail(postToolUseFailure, args);
      expect(await call(preToolUse, cmd)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('drops the oldest outcome once the ring exceeds failuresRequired', async () => {
      const { preToolUse, postToolUse, postToolUseFailure } = createLoopDetectorHooks({
        bash: { enabled: true, threshold: 2, failuresRequired: 2 },
      });
      const cmd = makePreToolUse('Bash', { command: 'flaky-cmd' });
      const args = cmd.tool_input as Record<string, unknown>;

      expect(await call(preToolUse, cmd)).toEqual({});
      await fail(postToolUseFailure, args);
      await succeed(postToolUse, args);
      expect(await call(preToolUse, cmd)).toEqual({});
      await fail(postToolUseFailure, args);
      expect(await call(preToolUse, cmd)).toEqual({});
      await fail(postToolUseFailure, args);
      expect(await call(preToolUse, cmd)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });
  });

  describe('config resolution (characterization)', () => {
    it('ignores a thresholds.Bash entry while bash.enabled is true (Bash never denies on successes)', async () => {
      const { preToolUse, postToolUse } = createLoopDetectorHooks({
        thresholds: { Bash: 2 },
      });
      const cmd = makePreToolUse('Bash', { command: 'git status' });
      const args = cmd.tool_input as Record<string, unknown>;

      for (let i = 0; i < 10; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(postToolUse, makePostToolUse('Bash', args, { stdout: 'ok' }));
      }
    });

    it('applies thresholds.Bash through the generic path when bash.enabled is false', async () => {
      const disabledBash = createLoopDetectorHook({
        thresholds: { Bash: 2 },
        bash: { enabled: false, threshold: 5, failuresRequired: 5 },
      });
      const input = makePreToolUse('Bash', { command: 'git status' });
      expect(await call(disabledBash, input)).toEqual({});
      const result = await call(disabledBash, input);
      expect(result).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      const reason = (result as { hookSpecificOutput: { permissionDecisionReason: string } })
        .hookSpecificOutput.permissionDecisionReason;
      expect(reason).toContain('Loop detected: Bash was called 2 times');
    });
  });
});
