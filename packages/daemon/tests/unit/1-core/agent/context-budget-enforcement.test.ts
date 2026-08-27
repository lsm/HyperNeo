import { describe, expect, it, mock } from 'bun:test';
import type { ContextInfo } from '@hyperneo/shared';
import {
  type ContextBudgetEnforcementInput,
  enforceContextBudget,
  enqueueBudgetCompaction,
  resolveBudgetThresholds,
  runContextBudgetDecision,
} from '../../../../src/lib/agent/context-budget-enforcement';
import type { ContextTracker } from '../../../../src/lib/agent/context-tracker';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import { Logger } from '../../../../src/lib/logger';

function enforcementHarness(overrides?: {
  providerId?: string;
  totalUsed?: number;
  totalCapacity?: number;
  clearedDeadCompaction?: boolean;
  limitRecoveryPending?: boolean;
  isCoolingDown?: boolean;
  compactionOutstanding?: boolean;
}) {
  const contextInfo = {
    totalUsed: overrides?.totalUsed ?? 950_000,
    totalCapacity: overrides?.totalCapacity ?? 1_000_000,
    percentUsed: 95,
    breakdown: {},
    isAutoCompactEnabled: true,
  } as unknown as ContextInfo;
  const markCompactionTriggered = mock(() => {});
  const clearCompactionCooldown = mock(() => {});
  const contextTracker = {
    isCoolingDown: mock(() => overrides?.isCoolingDown ?? false),
    markCompactionTriggered,
    clearCompactionCooldown,
  } as unknown as ContextTracker;
  const enqueue = mock(async () => 'compact-id');
  const messageQueue = {
    enqueue,
    hasOutstandingInternalCompaction: mock(() => overrides?.compactionOutstanding ?? false),
  } as unknown as MessageQueue;
  const stateManager = {
    getIsCompacting: mock(() => false),
    getState: mock(() => ({ phase: 'idle' })),
  } as unknown as ProcessingStateManager;

  const input: ContextBudgetEnforcementInput = {
    sessionId: 'enforcement-session',
    providerId: overrides?.providerId ?? 'openrouter',
    reason: 'turn-end',
    contextInfo,
    fallbackContextWindow: 262_144,
    clearedDeadCompaction: overrides?.clearedDeadCompaction ?? false,
    limitRecoveryPending: overrides?.limitRecoveryPending ?? false,
    contextTracker,
    messageQueue,
    stateManager,
    logger: new Logger('enforcement-test'),
  };
  return { input, enqueue, markCompactionTriggered };
}

describe('enforce-context-budget stages', () => {
  it('resolveBudgetThresholds keys the budget to the reported capacity', () => {
    const { input } = enforcementHarness();
    const ctx = resolveBudgetThresholds({
      ...input,
      budgetKey: 0,
      decision: null,
      compactionEnqueued: false,
    });
    expect(ctx.budgetKey).toBe(900_000);
  });

  it('resolveBudgetThresholds falls back to the configured window when capacity is zero', () => {
    const { input } = enforcementHarness({ totalCapacity: 0 });
    const ctx = resolveBudgetThresholds({
      ...input,
      budgetKey: 0,
      decision: null,
      compactionEnqueued: false,
    });
    expect(ctx.budgetKey).toBe(235_929);
  });

  it('runContextBudgetDecision delegates to the decision pipeline', () => {
    const { input } = enforcementHarness();
    const ctx = runContextBudgetDecision({
      ...input,
      budgetKey: 900_000,
      decision: null,
      compactionEnqueued: false,
    });
    expect(ctx.decision).toEqual({ action: 'compact', reason: 'over_threshold_sdk_unknown' });
  });

  it('enqueueBudgetCompaction marks the cooldown and enqueues a durable prepended /compact', async () => {
    const { input, enqueue, markCompactionTriggered } = enforcementHarness();
    const ctx = enqueueBudgetCompaction({
      ...input,
      budgetKey: 900_000,
      decision: { action: 'compact', reason: 'over_threshold_sdk_unknown' },
      compactionEnqueued: false,
    });
    expect(ctx.compactionEnqueued).toBe(true);
    expect(markCompactionTriggered).toHaveBeenCalledWith(900_000);
    expect(enqueue).toHaveBeenCalledWith('/compact', true, { durable: true, prepend: true });
  });
});

describe('enforce-context-budget pipeline', () => {
  it('enqueues a durable prepended /compact when the budget is exceeded', () => {
    const { input, enqueue, markCompactionTriggered } = enforcementHarness();
    const outcome = enforceContextBudget(input);
    expect(outcome.compactionEnqueued).toBe(true);
    expect(markCompactionTriggered).toHaveBeenCalledWith(900_000);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['native provider', { providerId: 'anthropic' }],
    ['acp provider', { providerId: 'acp' }],
    ['missing provider', { providerId: undefined }],
    ['limit recovery pending', { limitRecoveryPending: true }],
    ['cleared dead compaction', { clearedDeadCompaction: true }],
    ['outstanding compaction', { compactionOutstanding: true }],
    ['below threshold', { totalUsed: 50_000 }],
    ['cooldown active', { isCoolingDown: true }],
  ])('halts without enqueueing for %s', (_label, overrides) => {
    const { input, enqueue } = enforcementHarness(overrides);
    const outcome = enforceContextBudget(input);
    expect(outcome.compactionEnqueued).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
