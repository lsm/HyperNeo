import { describe, expect, it } from 'bun:test';

import type { ProviderLoadOutcome } from '../../../../src/lib/model-settlement-routing';
import {
  runSettleProviderLoadOutcome,
  type SettleProviderLoadOutcomeDeps,
} from '../../../../src/lib/model-settlement-pipeline';

function failure(providerId: string, errorKind: 'transient' | 'credential', message: string) {
  return { providerId, errorKind, message };
}

function fakeDeps(
  overrides?: Partial<SettleProviderLoadOutcomeDeps>
): SettleProviderLoadOutcomeDeps {
  const appliedSeq = new Map<string, number>();
  const failures = new Map<string, { errorKind: 'transient' | 'credential'; message: string }>();
  const retries = new Set<string>();
  const registry = new Set(overrides?.getProviderRegistry ? [] : ['anthropic', 'kimi', 'deepseek']);
  return {
    getProviderRegistry: () => ({ has: (providerId) => registry.has(providerId) }),
    getAllProviderFailures: () =>
      Array.from(failures.entries()).map(([providerId, record]) => ({
        providerId,
        ...record,
        firstRecordedAt: 0,
        lastRecordedAt: 0,
      })),
    removeProviderFailure: (providerId) => failures.delete(providerId),
    clearProviderRetry: (providerId) => {
      retries.delete(providerId);
    },
    setProviderAppliedSeq: (providerId, loadSeq) => {
      appliedSeq.set(providerId, loadSeq);
    },
    clearProviderFailure: (providerId) => failures.delete(providerId),
    getProviderFailure: (providerId) =>
      failures.has(providerId)
        ? { providerId, ...failures.get(providerId)!, firstRecordedAt: 0, lastRecordedAt: 0 }
        : undefined,
    armProviderRetry: (providerId) => {
      retries.add(providerId);
    },
    cancelProviderRetry: (providerId) => {
      retries.add(`${providerId}:canceled`);
    },
    recordClassifiedProviderFailure: (providerId, record) => {
      failures.set(providerId, record);
      return { ...record, firstRecordedAt: 0, lastRecordedAt: 0 };
    },
    emitProviderSettlement: () => {},
    ...overrides,
  };
}

function outcome(
  kind: ProviderLoadOutcome['kind'],
  providerId: string,
  fail?: ReturnType<typeof failure>
): ProviderLoadOutcome {
  if (kind === 'failed') {
    return { kind, providerId, models: [], failure: fail };
  }
  return { kind, providerId, models: [] };
}

describe('runSettleProviderLoadOutcome', () => {
  it('marks loaded and unavailable providers as applied', () => {
    const result = runSettleProviderLoadOutcome(fakeDeps(), {
      outcomes: [outcome('loaded', 'anthropic'), outcome('unavailable', 'kimi')],
      loadSeq: 3,
    });
    expect(result.appliedProviderIds).toEqual(['anthropic', 'kimi']);
  });

  it('clears failure and retry for loaded providers', () => {
    const deps = fakeDeps();
    const emitted: string[] = [];
    deps.emitProviderSettlement = (ids) => emitted.push(...ids);
    deps.recordClassifiedProviderFailure('anthropic', failure('anthropic', 'transient', 'timeout'));
    const result = runSettleProviderLoadOutcome(deps, {
      outcomes: [outcome('loaded', 'anthropic')],
      loadSeq: 1,
    });
    expect(deps.getProviderFailure('anthropic')).toBeUndefined();
    expect(result.clearedProviderIds).toEqual(['anthropic']);
    expect(emitted).toEqual(['anthropic']);
  });

  it('arms retries for transient failures and records them', () => {
    const result = runSettleProviderLoadOutcome(fakeDeps(), {
      outcomes: [outcome('failed', 'deepseek', failure('deepseek', 'transient', 'timeout'))],
      loadSeq: 2,
    });
    expect(result.armedProviderIds).toEqual(['deepseek']);
    expect(result.recordedFailures).toEqual([failure('deepseek', 'transient', 'timeout')]);
    expect(result.appliedProviderIds).toEqual(['deepseek']);
  });

  it('cancels retries for credential failures and records them', () => {
    const result = runSettleProviderLoadOutcome(fakeDeps(), {
      outcomes: [outcome('failed', 'deepseek', failure('deepseek', 'credential', 'HTTP 401'))],
      loadSeq: 2,
    });
    expect(result.canceledProviderIds).toEqual(['deepseek']);
    expect(result.recordedFailures).toEqual([failure('deepseek', 'credential', 'HTTP 401')]);
  });

  it('arms retry for unavailable providers with an existing transient failure', () => {
    const deps = fakeDeps();
    deps.recordClassifiedProviderFailure('kimi', failure('kimi', 'transient', 'timeout'));
    const result = runSettleProviderLoadOutcome(deps, {
      outcomes: [outcome('unavailable', 'kimi')],
      loadSeq: 2,
    });
    expect(result.appliedProviderIds).toEqual(['kimi']);
    expect(result.armedProviderIds).toEqual(['kimi']);
  });

  it('leaves superseded providers untouched', () => {
    const deps = fakeDeps();
    deps.recordClassifiedProviderFailure('anthropic', failure('anthropic', 'transient', 'timeout'));
    const result = runSettleProviderLoadOutcome(deps, {
      outcomes: [outcome('superseded', 'anthropic')],
      loadSeq: 1,
    });
    expect(result.appliedProviderIds).toEqual([]);
    expect(result.armedProviderIds).toEqual([]);
    expect(result.clearedProviderIds).toEqual([]);
    expect(result.recordedFailures).toEqual([]);
    expect(deps.getProviderFailure('anthropic')).toBeDefined();
  });

  it('cleans up orphan failures for providers no longer in the registry', () => {
    const emitted: string[] = [];
    const deps = fakeDeps({
      getProviderRegistry: () => ({ has: (providerId) => providerId !== 'removed' }),
      emitProviderSettlement: (ids) => emitted.push(...ids),
    });
    deps.recordClassifiedProviderFailure('removed', failure('removed', 'transient', 'timeout'));
    runSettleProviderLoadOutcome(deps, { outcomes: [], loadSeq: 1 });
    expect(deps.getProviderFailure('removed')).toBeUndefined();
    expect(emitted).toEqual([]);
  });

  it('does not record failures or arm for providers not in the registry', () => {
    const result = runSettleProviderLoadOutcome(
      fakeDeps({
        getProviderRegistry: () => ({ has: (providerId) => providerId !== 'deepseek' }),
      }),
      {
        outcomes: [outcome('failed', 'deepseek', failure('deepseek', 'transient', 'timeout'))],
        loadSeq: 1,
      }
    );
    expect(result.recordedFailures).toEqual([]);
    expect(result.armedProviderIds).toEqual([]);
    expect(result.appliedProviderIds).toEqual([]);
  });

  it('emits settlement for all changed providers', () => {
    const emitted: string[] = [];
    const result = runSettleProviderLoadOutcome(
      fakeDeps({
        emitProviderSettlement: (ids) => emitted.push(...ids),
      }),
      {
        outcomes: [
          outcome('loaded', 'anthropic'),
          outcome('unavailable', 'kimi'),
          outcome('failed', 'deepseek', failure('deepseek', 'transient', 'timeout')),
        ],
        loadSeq: 4,
      }
    );
    expect(emitted).toEqual(['anthropic', 'kimi', 'deepseek']);
    expect(result.emitted).toBe(true);
  });

  it('returns an empty result when there are no outcomes', () => {
    const result = runSettleProviderLoadOutcome(fakeDeps(), { outcomes: [], loadSeq: 1 });
    expect(result.appliedProviderIds).toEqual([]);
    expect(result.armedProviderIds).toEqual([]);
    expect(result.canceledProviderIds).toEqual([]);
    expect(result.clearedProviderIds).toEqual([]);
    expect(result.recordedFailures).toEqual([]);
    expect(result.emitted).toBe(false);
  });

  it('does not emit when no providers changed', () => {
    const emitted: string[] = [];
    const result = runSettleProviderLoadOutcome(
      fakeDeps({
        emitProviderSettlement: (ids) => emitted.push(...ids),
      }),
      { outcomes: [], loadSeq: 1 }
    );
    expect(emitted).toEqual([]);
    expect(result.emitted).toBe(false);
  });
});
