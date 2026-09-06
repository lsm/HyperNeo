import { describe, expect, test } from 'bun:test';
import {
  continued,
  skipped,
  type RunTickCtx,
  type SpaceWorkflowRunTickDeps,
  type SpaceWorkflowRunTickOutcome,
  type StrandedExecutionRecoveryResult,
  type TickResult,
  type TickSkipReason,
} from '../../../../src/lib/space/runtime/run-tick-contract.ts';

const SKIP_REASONS: TickSkipReason[] = [
  'missing_run',
  'no_run_context',
  'rate_or_usage_limited',
  'task_stopped',
  'no_executions',
];

function makeDeps(): SpaceWorkflowRunTickDeps {
  return {} as SpaceWorkflowRunTickDeps;
}

describe('run-tick contract result helpers', () => {
  test('continued threads the ctx as the value arm', () => {
    const ctx = { runId: 'run-1', deps: makeDeps() };
    expect(continued(ctx)).toEqual({ value: ctx });
  });

  test('skipped resolves with the skip outcome for every reason', () => {
    for (const reason of SKIP_REASONS) {
      expect(skipped(reason)).toEqual({ reason: { action: 'skip', reason } });
    }
  });

  test('helpers never mix arms', () => {
    const ctx = { runId: 'run-1', deps: makeDeps() };
    const value = continued(ctx) as Record<string, unknown>;
    const reason = skipped('missing_run') as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['value']);
    expect(Object.keys(reason)).toEqual(['reason']);
  });

  test('contract types carry the documented shapes', () => {
    const ctx: RunTickCtx = { runId: 'run-1', deps: makeDeps() };
    const outcome: SpaceWorkflowRunTickOutcome = { action: 'ran_to_completion' };
    const recovery: StrandedExecutionRecoveryResult = {
      action: 'continue',
      tam: {} as never,
      blockedByCrash: false,
      preTickPendingIds: new Set<string>(),
    };
    const result: TickResult = continued(ctx);
    expect(outcome.action).toBe('ran_to_completion');
    expect(recovery.action).toBe('continue');
    expect(result).toEqual({ value: ctx });
  });
});
