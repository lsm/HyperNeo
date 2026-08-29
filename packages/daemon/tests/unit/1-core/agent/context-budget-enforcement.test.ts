import { describe, expect, it, mock } from 'bun:test';
import type { ContextInfo, Session } from '@hyperneo/shared';
import {
  type ContextBudgetEnforcementInput,
  type ContextBudgetReevaluationInput,
  enforceContextBudget,
  enqueueBudgetCompaction,
  resolveBudgetThresholds,
  runContextBudgetDecision,
  runContextBudgetReevaluation,
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
  queueRunning?: boolean;
  processingStatus?: string;
  reason?: 'event-tick' | 'turn-end' | 'compact-boundary' | 'model-switch';
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
    isRunning: mock(() => overrides?.queueRunning ?? true),
  } as unknown as MessageQueue;
  const stateManager = {
    getIsCompacting: mock(() => false),
    getState: mock(() => ({
      phase: 'idle',
      status: overrides?.processingStatus ?? 'idle',
    })),
  } as unknown as ProcessingStateManager;

  const input: ContextBudgetEnforcementInput = {
    sessionId: 'enforcement-session',
    providerId: 'providerId' in (overrides ?? {}) ? overrides?.providerId : 'openrouter',
    reason: overrides?.reason ?? 'turn-end',
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

  it('enqueues a dormant /compact on a stopped queue for model-switch re-evaluation', () => {
    const { input, enqueue } = enforcementHarness({ queueRunning: false, reason: 'model-switch' });
    const outcome = enforceContextBudget(input);
    expect(outcome.compactionEnqueued).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('/compact', true, { durable: true, prepend: true });
  });

  it.each([
    ['native provider', { providerId: 'anthropic' }],
    ['acp provider', { providerId: 'acp' }],
    ['missing provider', { providerId: undefined }],
    ['limit recovery pending', { limitRecoveryPending: true }],
    ['user question outstanding', { processingStatus: 'waiting_for_input' }],
    ['queue shut down', { queueRunning: false }],
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

describe('reevaluate-context-budget pipeline', () => {
  function reevaluationHarness(resolveModelInfo: () => Promise<unknown>) {
    const session = {
      id: 'reevaluation-session',
      config: { model: 'switched-model', provider: 'openrouter' },
    } as unknown as Session;
    const trackerInfo = {
      model: 'old-model',
      totalUsed: 950_000,
      totalCapacity: 2_000_000,
      percentUsed: 47,
      breakdown: {},
      isAutoCompactEnabled: false,
    } as unknown as ContextInfo;
    const enqueue = mock(async () => 'compact-id');
    const removePendingInternalCompactions = mock(() => 0);
    const messageQueue = {
      enqueue,
      removePendingInternalCompactions,
      hasOutstandingInternalCompaction: mock(() => false),
      isRunning: mock(() => false),
    };
    const contextTracker = {
      isCoolingDown: mock(() => false),
      markCompactionTriggered: mock(() => {}),
      clearCompactionCooldown: mock(() => {}),
    };
    const stateManager = {
      getIsCompacting: mock(() => false),
      getState: mock(() => ({ phase: 'idle', status: 'idle' })),
    };
    const input: ContextBudgetReevaluationInput = {
      session,
      trackerInfo,
      resolveModelInfo: resolveModelInfo as ContextBudgetReevaluationInput['resolveModelInfo'],
      limitRecoveryPending: false,
      contextTracker: contextTracker as never,
      messageQueue: messageQueue as never,
      stateManager: stateManager as never,
      logger: new Logger('reevaluation-test'),
      resumePendingWork: mock(() => {}),
      clearPendingResume: mock(() => {}),
    };
    return { input, enqueue, removePendingInternalCompactions };
  }

  it('enqueues a dormant compaction through the enforcement pipeline on a stopped queue', async () => {
    const { input, enqueue } = reevaluationHarness(async () => ({
      id: 'switched-model',
      contextWindow: 1_000_000,
    }));
    const outcome = await runContextBudgetReevaluation(input);
    expect(outcome.compactionEnqueued).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('/compact', true, { durable: true, prepend: true });
  });

  it('halts when the model fence changes while the catalog resolves', async () => {
    const { input, enqueue } = reevaluationHarness(async () => {
      input.session.config.model = 'newer-switch';
      return { id: 'newer-switch', contextWindow: 1_000_000 };
    });
    const outcome = await runContextBudgetReevaluation(input);
    expect(outcome.compactionEnqueued).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('defers instead of deciding against stale capacity when the catalog is unresolved', async () => {
    const { input, enqueue, removePendingInternalCompactions } = reevaluationHarness(
      async () => null
    );
    const outcome = await runContextBudgetReevaluation(input);
    expect(outcome.compactionEnqueued).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(removePendingInternalCompactions).not.toHaveBeenCalled();
  });
});
