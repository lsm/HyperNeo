import { describe, test, expect } from 'bun:test';
import { createPostApprovalOnlyValidator } from '../../../../src/lib/space/runtime/built-in-validators/post-approval-only-validator';
import type { HookExecutorContext } from '../../../../src/lib/space/runtime/hook-executor';

function makeContext(overrides: Partial<HookExecutorContext> = {}): HookExecutorContext {
  return {
    workspacePath: '/tmp',
    runId: 'run-1',
    hookId: 'stable-qa-coding-to-qa-post-approval',
    methodName: 'send_message',
    params: { target: 'QA', message: 'blocked', data: { reason: 'merge_blocked' } },
    nodeId: 'node-coding',
    nodeName: 'Coding',
    sessionId: 'sess-1',
    taskId: 'task-1',
    hookLocalState: {},
    currentArtifacts: [],
    permittedExternalLookups: [],
    ...overrides,
  };
}

describe('post_approval_only validator', () => {
  test('allows a merge_blocked report while the task is approved (pr_url matches frozen)', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(
      makeContext({
        taskStatus: 'approved',
        frozenPrUrl: 'https://github.com/acme/corp/pull/42',
        params: {
          target: 'QA',
          message: 'blocked',
          data: { reason: 'merge_blocked', pr_url: 'https://github.com/acme/corp/pull/42' },
        },
      })
    );
    expect(result.type).toBe('allow');
  });

  test('allows a merge_fix_pushed report while the task is approved (pr_url matches frozen)', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(
      makeContext({
        taskStatus: 'approved',
        frozenPrUrl: 'https://github.com/acme/corp/pull/42',
        params: {
          target: 'QA',
          message: 'pushed fix',
          data: {
            reason: 'merge_fix_pushed',
            pr_url: 'https://github.com/acme/corp/pull/42',
          },
        },
      })
    );
    expect(result.type).toBe('allow');
  });

  test('blocks an approved merge report with NO pr_url (omission is not safe)', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(
      makeContext({
        taskStatus: 'approved',
        frozenPrUrl: 'https://github.com/acme/corp/pull/42',
        params: { target: 'QA', message: 'blocked', data: { reason: 'merge_blocked' } },
      })
    );
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('must carry data.pr_url');
  });

  test('blocks a merge report while the task is in_progress (spoof guard)', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(makeContext({ taskStatus: 'in_progress' }));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('post-approval only');
  });

  test('blocks any send when taskStatus is undefined (fails closed)', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(makeContext());
    expect(result.type).toBe('block');
  });

  test('blocks an approved task without a merge reason', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(
      makeContext({
        taskStatus: 'approved',
        params: { target: 'QA', message: 'handoff', data: {} },
      })
    );
    expect(result.type).toBe('block');
  });

  test('blocks an approved task with an unrelated reason', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(
      makeContext({
        taskStatus: 'approved',
        params: { target: 'QA', message: 'hi', data: { reason: 'initial_handoff' } },
      })
    );
    expect(result.type).toBe('block');
  });

  test('reads reason from rawParams when bounded params.data is truncated', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(
      makeContext({
        taskStatus: 'approved',
        frozenPrUrl: 'https://github.com/acme/corp/pull/42',
        params: { target: 'QA', message: 'blocked', data: '[truncated: large data field omitted]' },
        rawParams: {
          target: 'QA',
          message: 'blocked',
          data: {
            reason: 'merge_blocked',
            pr_url: 'https://github.com/acme/corp/pull/42',
          },
        },
      })
    );
    expect(result.type).toBe('allow');
  });

  test('a non-string reason does not exempt', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(
      makeContext({
        taskStatus: 'approved',
        params: { target: 'QA', message: 'hi', data: { reason: 42 } },
      })
    );
    expect(result.type).toBe('block');
  });

  test('missing data object does not exempt', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(
      makeContext({
        taskStatus: 'approved',
        params: { target: 'QA', message: 'hi' },
      })
    );
    expect(result.type).toBe('block');
  });

  test('allows a blocker whose pr_url matches the frozen reviewed PR', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(
      makeContext({
        taskStatus: 'approved',
        frozenPrUrl: 'https://github.com/acme/corp/pull/42',
        params: {
          target: 'QA',
          message: 'blocked',
          data: { reason: 'merge_blocked', pr_url: 'https://github.com/acme/corp/pull/42' },
        },
      })
    );
    expect(result.type).toBe('allow');
  });

  test('blocks a blocker whose pr_url differs from the frozen reviewed PR', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(
      makeContext({
        taskStatus: 'approved',
        frozenPrUrl: 'https://github.com/acme/corp/pull/42',
        params: {
          target: 'QA',
          message: 'blocked',
          data: { reason: 'merge_blocked', pr_url: 'https://github.com/acme/corp/pull/999' },
        },
      })
    );
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('does not match');
  });

  test('fails closed when a pr_url is supplied but no frozen identity exists', async () => {
    const validator = createPostApprovalOnlyValidator();
    const result = await validator(
      makeContext({
        taskStatus: 'approved',
        params: {
          target: 'QA',
          message: 'blocked',
          data: { reason: 'merge_blocked', pr_url: 'https://github.com/acme/corp/pull/42' },
        },
      })
    );
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('no frozen reviewed PR identity');
  });
});
