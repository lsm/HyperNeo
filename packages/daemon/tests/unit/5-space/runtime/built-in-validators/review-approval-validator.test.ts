/**
 * Unit tests for reviewApprovalValidator.
 *
 * Covers: vote extraction, threshold activation, concurrent vote deep-merge,
 * rejection reset, codex timeout, and boolean/map vote styles.
 */

import { describe, test, expect } from 'bun:test';
import { reviewApprovalValidator } from '../../../../../src/lib/space/runtime/built-in-validators/review-approval-validator';
import type { HookExecutorContext } from '../../../../../src/lib/space/runtime/hook-executor';

function makeCtx(overrides: Partial<HookExecutorContext> = {}): HookExecutorContext {
  return {
    workspacePath: '/tmp',
    runId: 'run-1',
    hookId: 'hook-1',
    methodName: 'send_message',
    params: {},
    nodeId: 'node-review',
    nodeName: 'Review',
    sessionId: 'sess-1',
    taskId: 'task-1',
    hookLocalState: {},
    currentArtifacts: [],
    permittedExternalLookups: [],
    ...overrides,
  };
}

describe('reviewApprovalValidator', () => {
  test('blocks and records vote when threshold not met', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { arch: 'approved' } } },
      templateData: { threshold: 2 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('1/2');
    expect((result as { state?: Record<string, unknown> }).state).toEqual({
      approvals: { arch: 'approved' },
    });
  });

  test('allows when threshold is met', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { sec: 'approved' } } },
      hookLocalState: { approvals: { arch: 'approved' } },
      templateData: { threshold: 2 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('2/2');
  });

  test('deep-merges votes without overwriting prior entries', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { ux: 'approved' } } },
      hookLocalState: { approvals: { arch: 'approved', sec: 'approved' } },
      templateData: { threshold: 4 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('block');
    const state = (result as { state?: Record<string, unknown> }).state;
    expect(state?.approvals).toEqual({
      arch: 'approved',
      sec: 'approved',
      ux: 'approved',
    });
  });

  test('resets state on rejection when resetOnRejection is true', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { arch: 'rejected' } } },
      hookLocalState: { approvals: { sec: 'approved', ux: 'approved' } },
      templateData: { threshold: 4, resetOnRejection: true },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('rejected');
    expect((result as { state?: Record<string, unknown> }).state).toEqual({
      approvals: {},
    });
  });

  test('does not reset on rejection when resetOnRejection is false', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { arch: 'rejected' } } },
      hookLocalState: { approvals: { sec: 'approved' } },
      templateData: { threshold: 4, resetOnRejection: false },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('block');
    const state = (result as { state?: Record<string, unknown> }).state;
    expect(state?.approvals).toEqual({
      arch: 'rejected',
      sec: 'approved',
    });
  });

  test('handles boolean-style approval', async () => {
    const ctx = makeCtx({
      params: { data: { approved: true } },
      templateData: { threshold: 1 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('1/1');
  });

  test('counts only matching vote values', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { arch: 'approved', sec: 'pending' } } },
      hookLocalState: { approvals: { ux: 'approved' } },
      templateData: { threshold: 3 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('2/3');
  });

  test('uses templateData defaults when unspecified', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { arch: 'approved' } } },
      // no templateData → threshold 1, voteKey 'approvals', voteMatch 'approved'
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('allow');
  });

  test('starts codex timeout on first threshold hit', async () => {
    const ctx = makeCtx({
      params: { data: { approved: true } },
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('codex');
    const state = (result as { state?: Record<string, unknown> }).state;
    expect(state?._codex_started_at).toBeTypeOf('number');
  });

  test('allows after codex timeout elapsed', async () => {
    const now = Date.now();
    const ctx = makeCtx({
      params: { data: { approved: true } },
      hookLocalState: { _codex_started_at: now - 700_000 }, // 700s ago, timeout 600s
      templateData: { threshold: 1, requireCodex: true, codexTimeoutMs: 600_000 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('timed out');
  });

  test('allows immediately when codex already approved', async () => {
    const ctx = makeCtx({
      params: { data: { approved: true } },
      hookLocalState: { approvals: { _codex_status: 'approved' } },
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('codex approval');
  });

  test('persists partial votes even when blocked', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { a: 'approved' } } },
      hookLocalState: {},
      templateData: { threshold: 3 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { state?: Record<string, unknown> }).state).toEqual({
      approvals: { a: 'approved' },
    });
  });
});
