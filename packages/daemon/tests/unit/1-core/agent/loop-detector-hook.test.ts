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
      // Read(a) -> Read(b) -> Read(a) -> Read(a) should NOT deny:
      // only two Read(a) calls are consecutive.
      expect(await call(hook, a)).toEqual({});
      expect(await call(hook, b)).toEqual({});
      expect(await call(hook, a)).toEqual({});
      expect(await call(hook, a)).toEqual({});
      // One more identical Read(a) makes it three in a row — denies.
      const result = await call(hook, a);
      expect(result).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('treats different offsets as different keys (paginated reads not penalised)', async () => {
      const a = makePreToolUse('Read', { file_path: '/abs/foo.ts', offset: 0 });
      const b = makePreToolUse('Read', { file_path: '/abs/foo.ts', offset: 100 });
      // Alternating offsets — never two in a row of the same key.
      for (let i = 0; i < 6; i++) {
        expect(await call(hook, i % 2 === 0 ? a : b)).toEqual({});
      }
    });

    it('continues to deny on every retry of the same key after a deny (until a different action)', async () => {
      const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      await call(hook, input);
      await call(hook, input);
      // First deny.
      expect(await call(hook, input)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      // Repeated identical retries keep denying — the loop is broken,
      // not just throttled.
      expect(await call(hook, input)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(await call(hook, input)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });

      // A different action resets the streak; the next identical Read passes.
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
      // `createLoopDetectorHook` produces only the PreToolUse callback;
      // without the paired PostToolUse hook recording outcomes, the Bash
      // failure ring stays empty and the persistent-failure precondition
      // is never satisfied — so even 20 identical Bash calls pass through.
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
      // Read, Bash (different lastKey, counts as a different action wrt
      // the Read streak), Read, Read — must NOT deny. The Bash call
      // overwrote lastKey so we are only on the 2nd consecutive Read here.
      expect(await call(hook, read)).toEqual({});
      expect(await call(hook, bash)).toEqual({});
      expect(await call(hook, read)).toEqual({});
      expect(await call(hook, read)).toEqual({});
      // One more identical Read makes it three in a row — denies.
      expect(await call(hook, read)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('an untracked tool call breaks a denied streak (edit-then-read flow)', async () => {
      // Real-world recovery flow: agent reads X three times and gets
      // denied; agent edits X (untracked tool); next read of X must
      // pass because the edit IS the "different action" the recovery
      // message asked for.
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
      // Corrective action via an untracked tool.
      expect(await call(hook, edit)).toEqual({});
      // Streak reset — next two Reads pass.
      expect(await call(hook, read)).toEqual({});
      expect(await call(hook, read)).toEqual({});
      // Third in a row again denies, as expected.
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
      // Caller asked to track only Read at 2. Grep and Glob must NOT be
      // tracked, even though defaults include them.
      const narrow = createLoopDetectorHook({ thresholds: { Read: 2 } });

      // Read still triggers at 2.
      const read = makePreToolUse('Read', { file_path: '/abs/foo.ts' });
      expect(await call(narrow, read)).toEqual({});
      expect(await call(narrow, read)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });

      // Grep is no longer tracked at all — even 50 identical calls pass.
      const grep = makePreToolUse('Grep', { pattern: 'TODO', path: 'src' });
      for (let i = 0; i < 50; i++) {
        expect(await call(narrow, grep)).toEqual({});
      }

      // Glob likewise.
      const glob = makePreToolUse('Glob', { pattern: '**/*.ts' });
      for (let i = 0; i < 50; i++) {
        expect(await call(narrow, glob)).toEqual({});
      }
    });

    it('omitting thresholds inherits the defaults wholesale', async () => {
      const inheritsDefaults = createLoopDetectorHook({ windowMs: 30_000 });
      // Read still triggers at the default 3.
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
      // Two reads in sess-A interleaved with one read in sess-B. The
      // sess-A streak must stay at 2 (no deny) because sess-B should
      // not contribute.
      expect(await call(hook, a)).toEqual({});
      expect(await call(hook, b)).toEqual({});
      expect(await call(hook, a)).toEqual({});
      // One more makes sess-A's third consecutive — should deny.
      expect(await call(hook, a)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      // sess-B should still be on count=1 (only one read) — no deny.
      expect(await call(hook, b)).toEqual({});
    });

    it('isolates main thread from subagent (different agent_id)', async () => {
      const main = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: undefined });
      const subagent = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: 'sub-1' });
      // Subagent reads the same file twice — no deny, its own ledger.
      expect(await call(hook, subagent)).toEqual({});
      expect(await call(hook, subagent)).toEqual({});
      // Main thread also reads twice — independent of subagent.
      expect(await call(hook, main)).toEqual({});
      expect(await call(hook, main)).toEqual({});
      // Main's 3rd read triggers main's deny only.
      expect(await call(hook, main)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      // Subagent's 3rd read independently triggers its own deny.
      expect(await call(hook, subagent)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('isolates two subagents from each other', async () => {
      const subA = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: 'sub-A' });
      const subB = makePreToolUse('Read', { file_path: '/abs/foo.ts' }, { agent_id: 'sub-B' });
      // Two reads each, interleaved. Neither should deny.
      expect(await call(hook, subA)).toEqual({});
      expect(await call(hook, subB)).toEqual({});
      expect(await call(hook, subA)).toEqual({});
      expect(await call(hook, subB)).toEqual({});
      // subA's 3rd consecutive in its own scope. subB has 2 reads then
      // a subA in between in the GLOBAL stream — but per-(session,agent)
      // isolation means subB's streak is 2. So neither denies on this
      // next subA call (subA streak = 3 here).
      expect(await call(hook, subA)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      // subB is still on 2 — one more makes 3 in its own scope.
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
      // Wait so the window expires before the third call.
      await new Promise((r) => setTimeout(r, 5));
      // Third call is treated as the first in a new window — no deny.
      expect(await call(shortWindowHook, input)).toEqual({});
    });

    it('enforces the window over the FULL streak duration (slow periodic retries are not penalised)', async () => {
      // Fake `Date.now` so we can simulate calls spaced 4ms apart with a
      // 5ms window. Streak duration grows past 5ms on the 3rd call, so
      // it must reset to 1 — matching "N within window" semantics, not
      // "no gap > windowMs".
      const original = Date.now;
      let now = 1_000_000;
      Date.now = () => now;
      try {
        const slowHook = createLoopDetectorHook({ windowMs: 5 });
        const input = makePreToolUse('Read', { file_path: '/abs/foo.ts' });

        // t = 0: streak count = 1
        expect(await call(slowHook, input)).toEqual({});
        // t = 4: gap is 4 (<= 5), streak duration is 4 (<= 5) → count = 2
        now += 4;
        expect(await call(slowHook, input)).toEqual({});
        // t = 8: gap is 4 (<= 5) BUT streak duration is 8 (> 5).
        // Old "max-gap" logic would advance to count = 3 and deny.
        // Correct "window over full duration" logic resets to 1.
        now += 4;
        expect(await call(slowHook, input)).toEqual({});
        // t = 12: gap 4, duration 4 since reset → count = 2, no deny.
        now += 4;
        expect(await call(slowHook, input)).toEqual({});
      } finally {
        Date.now = original;
      }
    });

    it('still denies bursty repeats well within the window', async () => {
      // Sanity check that a tight burst (much less than windowMs apart)
      // continues to deny — the previous test must not have over-corrected.
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

    // With the new design, PostToolUse always records success.
    // Failures are delivered via PostToolUseFailure. Tests that need
    // to simulate a failing Bash call use this helper to fire the
    // failure hook.
    async function recordBashFailure(
      postToolUseFailure: HookCallback,
      tool_input: Record<string, unknown>,
      overrides: Partial<PostToolUseFailureHookInput> = {}
    ) {
      await callPost(postToolUseFailure, makePostToolUseFailure('Bash', tool_input, overrides));
    }

    it('denies after 5 consecutive identical failing Bash commands', async () => {
      const { preToolUse, postToolUse, postToolUseFailure } = createLoopDetectorHooks();

      // Calls 1..4 — under threshold, no deny.
      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, FAILING_BASH)).toEqual({});
        await recordBashFailure(
          postToolUseFailure,
          FAILING_BASH.tool_input as Record<string, unknown>
        );
      }
      // Call 5 — threshold hit AND last 5 outcomes all failures (wait,
      // only 4 recorded so far; the 5th PreToolUse fires before its own
      // PostToolUseFailure). We need 5 failures recorded before the 6th
      // call can deny. Confirm 5th call passes through.
      expect(await call(preToolUse, FAILING_BASH)).toEqual({});
      await recordBashFailure(
        postToolUseFailure,
        FAILING_BASH.tool_input as Record<string, unknown>
      );

      // Call 6 — now 5 failures in the ring; deny fires.
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
      // `git status` polling: agent keeps re-running the same command,
      // and each call succeeds. Must not deny — Bash output can
      // legitimately differ across successful calls.
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
      // Flaky test scenario: 4 failures, 1 success, then a failure. The
      // success purges the failure ring so even the streak count of 6
      // does not satisfy "last 5 all failures."
      const { preToolUse, postToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const cmd = makePreToolUse('Bash', { command: 'bun test foo.test.ts' });

      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await recordBashFailure(postToolUseFailure, cmd.tool_input as Record<string, unknown>);
      }
      // 5th call: streak is 5 but ring only has 4 failures. No deny.
      expect(await call(preToolUse, cmd)).toEqual({});
      await callPost(
        postToolUse,
        makePostToolUse(
          'Bash',
          cmd.tool_input as Record<string, unknown>,
          makeBashSuccessResponse()
        )
      );
      // 6th call: streak is 6, ring has [F,F,F,F,S] → not all failures, no deny.
      expect(await call(preToolUse, cmd)).toEqual({});
      await recordBashFailure(postToolUseFailure, cmd.tool_input as Record<string, unknown>);
      // 7th call: ring is [F,F,F,S,F] → still not all failures, no deny.
      expect(await call(preToolUse, cmd)).toEqual({});
    });

    it('a different Bash command resets the streak (semantic streak reset)', async () => {
      // 4 failing `cmd-A`, then 1 `cmd-B`, then 5 failing `cmd-A`. Even
      // though there are 9 failures of cmd-A total, the streak reset by
      // cmd-B means the consecutive count starts over.
      const { preToolUse, postToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const a = makePreToolUse('Bash', { command: 'ls nonexistent-a 2>&1' });
      const b = makePreToolUse('Bash', { command: 'ls nonexistent-b 2>&1' });

      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, a)).toEqual({});
        await recordBashFailure(postToolUseFailure, a.tool_input as Record<string, unknown>);
      }
      // Interleave a different Bash command.
      expect(await call(preToolUse, b)).toEqual({});
      await recordBashFailure(postToolUseFailure, b.tool_input as Record<string, unknown>);
      // Streak for a was reset. We need 5 more consecutive a calls to
      // rebuild the streak. The 5th passes, then the 6th gets denied
      // (because the ring still has 5 a-failures from before — the
      // failure ring is independent of streak resets, but the streak
      // counter starts over so deny only fires when count >= 5).
      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, a)).toEqual({});
        await recordBashFailure(postToolUseFailure, a.tool_input as Record<string, unknown>);
      }
      // 5th a in the new streak — streak is 5, ring has ≥5 failures. Deny.
      expect(await call(preToolUse, a)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('a non-Bash tool call also resets the Bash streak', async () => {
      const { preToolUse, postToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const bash = makePreToolUse('Bash', { command: 'ls bad 2>&1' });
      const read = makePreToolUse('Read', { file_path: '/abs/foo.ts' });

      // 4 failing Bash.
      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, bash)).toEqual({});
        await recordBashFailure(postToolUseFailure, bash.tool_input as Record<string, unknown>);
      }
      // Read in between — resets Bash streak.
      expect(await call(preToolUse, read)).toEqual({});
      // Bash again — streak is 1, no deny even though failure ring has 4.
      expect(await call(preToolUse, bash)).toEqual({});
      await recordBashFailure(postToolUseFailure, bash.tool_input as Record<string, unknown>);
      // 4 more consecutive Bash → streak is 5, failures ring has 5 → deny.
      for (let i = 0; i < 3; i++) {
        expect(await call(preToolUse, bash)).toEqual({});
        await recordBashFailure(postToolUseFailure, bash.tool_input as Record<string, unknown>);
      }
      expect(await call(preToolUse, bash)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('counts PostToolUseFailure as a failure outcome', async () => {
      // SDK-level errors (hook crash, sandbox kill) come via the
      // PostToolUseFailure event, not PostToolUse. These must also be
      // counted as failures so a wedged tool path can still be denied.
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
      // Three identical retries — each denied. Importantly, the ring
      // has 5 failures and stays that way until the streak resets via a
      // different action.
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
      // Lower threshold and failuresRequired to 2 for ease of testing.
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks({
        bash: { enabled: true, threshold: 2, failuresRequired: 2 },
      });

      // 1st call: pre passes, then record failure.
      expect(await call(preToolUse, FAILING_BASH)).toEqual({});
      await recordBashFailure(
        postToolUseFailure,
        FAILING_BASH.tool_input as Record<string, unknown>
      );
      // 2nd call: streak=2 but ring only has 1. No deny yet.
      expect(await call(preToolUse, FAILING_BASH)).toEqual({});
      await recordBashFailure(
        postToolUseFailure,
        FAILING_BASH.tool_input as Record<string, unknown>
      );
      // 3rd call: streak=3, ring=[F,F]. Deny.
      expect(await call(preToolUse, FAILING_BASH)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('isolates Bash failure rings per (session, agent)', async () => {
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const aPre = makePreToolUse('Bash', { command: 'ls bad 2>&1' }, { session_id: 'sess-A' });
      const bPre = makePreToolUse('Bash', { command: 'ls bad 2>&1' }, { session_id: 'sess-B' });

      // Build a fully-loaded failure ring in sess-A.
      for (let i = 0; i < 5; i++) {
        expect(await call(preToolUse, aPre)).toEqual({});
        await recordBashFailure(postToolUseFailure, aPre.tool_input as Record<string, unknown>, {
          session_id: 'sess-A',
        });
      }
      // One more in sess-A — deny.
      expect(await call(preToolUse, aPre)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      // In sess-B the failure ring is empty for that fingerprint, so
      // even repeated calls do not deny on the first hits.
      for (let i = 0; i < 4; i++) {
        expect(await call(preToolUse, bPre)).toEqual({});
      }
    });

    it('PostToolUse hook ignores non-Bash tools', async () => {
      const { preToolUse, postToolUse } = createLoopDetectorHooks();
      // Recording a fake failure for Read should NOT pollute Bash's ring.
      await callPost(
        postToolUse,
        makePostToolUse('Read', { file_path: '/abs/foo.ts' }, { is_error: true, stderr: 'boom' })
      );
      // Now run 5 successful Bash calls — should still pass on the 6th.
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
      // Regression test for review feedback: the model frequently
      // rewords the non-semantic `description` field between retries
      // ("Check git hooks" → "List hook files"). Including description
      // in the fingerprint would defeat the detector — every retry
      // would look like a fresh command. We strip it.
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

      // Six failing calls, each with a different description but the
      // same command. Despite the differing descriptions, all six must
      // fingerprint to the same key, build a streak, accumulate
      // failures, and deny on the 6th attempt (5 failures recorded
      // from the first 5 attempts).
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
      // PostToolUseFailure with is_interrupt=true means a human (or
      // concurrent action) cancelled the call before it completed. The
      // command itself didn't fail — counting interrupts would let a
      // user who repeatedly hits stop poison the ring and block their
      // own legitimate retries.
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const cmd = makePreToolUse('Bash', { command: 'sleep 100' });
      const args = cmd.tool_input as Record<string, unknown>;

      // Fire 6 PreToolUse → interrupted-PostToolUseFailure pairs. Even
      // though the streak builds to 6, the failure ring should remain
      // empty (interrupts are not failures), so no deny fires.
      for (let i = 0; i < 6; i++) {
        expect(await call(preToolUse, cmd)).toEqual({});
        await callPost(
          postToolUseFailure,
          makePostToolUseFailure('Bash', args, { is_interrupt: true })
        );
      }
    });

    it('counts non-interrupt PostToolUseFailure as a real failure', async () => {
      // Sanity check: the interrupt skip is conditional, not blanket.
      // A non-interrupt failure (hook crash, sandbox kill) still gets
      // recorded and contributes to the failure ring.
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const args = FAILING_BASH.tool_input as Record<string, unknown>;

      for (let i = 0; i < 5; i++) {
        expect(await call(preToolUse, FAILING_BASH)).toEqual({});
        await callPost(
          postToolUseFailure,
          makePostToolUseFailure('Bash', args /* no is_interrupt */)
        );
      }
      expect(await call(preToolUse, FAILING_BASH)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });

    it('does NOT block legitimate retries after a long quiet period (stale rings expire)', async () => {
      // The bashFailures map is opportunistically pruned of entries
      // older than the sliding window. Behaviourally, a fingerprint
      // whose recorded failures all predate the streak's first call
      // must not be honoured: the streak itself resets when the
      // window expires (see Pre callback), so the deny path cannot
      // reach the ring. This test guards that lifecycle: 5 failures
      // followed by a long quiet period followed by a fresh attempt
      // MUST pass through, not deny.
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks({ windowMs: 50 });
      const cmd = makePreToolUse('Bash', { command: 'ls /nope' });
      const args = cmd.tool_input as Record<string, unknown>;

      // Record 5 failures.
      for (let i = 0; i < 5; i++) {
        await call(preToolUse, cmd);
        await recordBashFailure(postToolUseFailure, args);
      }

      // Wait past the sliding window. The next PreToolUse call sees a
      // stale streak (firstSeenMs older than windowMs) and resets the
      // streak counter to 1. nextCount < threshold ⇒ no deny.
      await new Promise((r) => setTimeout(r, 80));
      expect(await call(preToolUse, cmd)).toEqual({});
    });

    it('expires stale failure rings in lastNAllFailures even when the map stays small', async () => {
      // Regression test for review feedback: opportunistic size-gated
      // eviction (size > 256) means small workloads keep their rings
      // forever. Without time-based gating in lastNAllFailures, stale
      // failures from outside the window could still leak into a
      // deny decision. We now check ring age at lookup time and drop
      // stale rings unconditionally — verify the ring is empty after
      // the window elapses, even with a single fingerprint in the
      // map.
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks({
        windowMs: 30,
        // Tight thresholds so the streak path is short and the ring
        // reach is exercised quickly.
        bash: { enabled: true, threshold: 2, failuresRequired: 2 },
      });
      const cmd = makePreToolUse('Bash', { command: 'flaky' });
      const args = cmd.tool_input as Record<string, unknown>;

      // 2 failures fill the ring AND build the streak to 2.
      await call(preToolUse, cmd);
      await recordBashFailure(postToolUseFailure, args);
      await call(preToolUse, cmd);
      await recordBashFailure(postToolUseFailure, args);

      // Confirm the deny path would fire right now.
      expect(await call(preToolUse, cmd)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });

      // Wait past the window. Streak resets in Pre callback (firstSeenMs
      // stale), AND the ring is stale. A SINGLE fresh failure must not
      // be enough to deny: streak count = 1 (< threshold=2). On the
      // second fresh failure, the streak hits threshold but the ring
      // must already have been time-evicted so we don't carry yesterday's
      // failures forward.
      await new Promise((r) => setTimeout(r, 50));

      // First post-cooldown call: passes (streak just reset to 1).
      expect(await call(preToolUse, cmd)).toEqual({});
      await recordBashFailure(postToolUseFailure, args);

      // Second post-cooldown call: streak reaches 2. Ring now has 1
      // fresh failure (the stale ring was evicted at lookup time and
      // the post hook wrote a single fresh entry). length=1 < required=2,
      // so the deny does NOT fire — exactly the behaviour the
      // sliding-window contract promises.
      expect(await call(preToolUse, cmd)).toEqual({});
    });

    it('treats identical commands in different cwds as separate fingerprints', async () => {
      // Regression test for review feedback: `git status` in repo-A and
      // `git status` in repo-B are semantically different runs. Failure
      // streaks must not carry between them. Otherwise switching
      // between worktrees would inherit prior failure state and
      // trigger false denies for commands that are only textually
      // identical.
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const argsA = { command: 'git status' };
      const argsB = { command: 'git status' };

      // 6 failures in repo-A — would normally deny.
      for (let i = 0; i < 5; i++) {
        const pre = makePreToolUse('Bash', argsA, { cwd: '/repo-a' });
        await call(preToolUse, pre);
        await recordBashFailure(postToolUseFailure, argsA, { cwd: '/repo-a' });
      }
      // Sanity: 6th call in repo-A denies.
      expect(
        await call(preToolUse, makePreToolUse('Bash', argsA, { cwd: '/repo-a' }))
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });

      // First call in repo-B with the same command text must pass —
      // fresh fingerprint, no streak, no failures.
      expect(await call(preToolUse, makePreToolUse('Bash', argsB, { cwd: '/repo-b' }))).toEqual({});
    });

    it('canonicalises optional Bash args so omitted vs explicit defaults collide', async () => {
      // Regression test for review feedback: semantically equivalent
      // calls like omitted `run_in_background` vs `run_in_background:
      // false` must hash to the same key. Otherwise the model can
      // evade the detector by toggling optional default-valued fields
      // between retries.
      const { preToolUse, postToolUseFailure } = createLoopDetectorHooks();
      const command = 'git status';

      // 3 failures with explicit run_in_background=false.
      for (let i = 0; i < 3; i++) {
        const pre = makePreToolUse('Bash', { command, run_in_background: false });
        expect(await call(preToolUse, pre)).toEqual({});
        await recordBashFailure(postToolUseFailure, pre.tool_input as Record<string, unknown>);
      }

      // 2 failures with omitted run_in_background — must fingerprint to
      // the SAME key because the canonicalised default is false.
      for (let i = 0; i < 2; i++) {
        const pre = makePreToolUse('Bash', { command });
        expect(await call(preToolUse, pre)).toEqual({});
        await recordBashFailure(postToolUseFailure, pre.tool_input as Record<string, unknown>);
      }

      // 6th call (same command, streak=6, ring has 5 failures) → deny.
      expect(await call(preToolUse, makePreToolUse('Bash', { command }))).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });
  });
});
