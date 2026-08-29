import { describe, expect, it } from 'bun:test';

import type { ProviderLoadFailure } from '../../../../src/lib/model-service';
import type { ProviderLoadOutcome } from '../../../../src/lib/model-settlement-routing';
import {
  runSettleProviderLoadOutcome,
  type SettleProviderLoadOutcomeDeps,
} from '../../../../src/lib/model-settlement-pipeline';

type TestCase = {
  name: string;
  overrides?: Partial<SettleProviderLoadOutcomeDeps>;
  pre?: (deps: SettleProviderLoadOutcomeDeps) => void;
  outcomes: ProviderLoadOutcome[];
  applied?: string[];
  cleared?: string[];
  armed?: string[];
  canceled?: string[];
  recorded?: ProviderLoadFailure[];
  emitted?: string[];
  post?: (deps: SettleProviderLoadOutcomeDeps, emitted: string[]) => void;
};

function failure(
  providerId: string,
  errorKind: 'transient' | 'credential',
  message: string
): ProviderLoadFailure {
  return { providerId, errorKind, message };
}

function fakeDeps(
  overrides?: Partial<SettleProviderLoadOutcomeDeps>
): SettleProviderLoadOutcomeDeps {
  const failures = new Map<string, ProviderLoadFailure>();
  const registry = new Set(overrides?.getProviderRegistry ? [] : ['anthropic', 'kimi', 'deepseek']);
  return {
    getProviderRegistry: () => ({ has: (providerId) => registry.has(providerId) }),
    getAllProviderFailures: () =>
      Array.from(failures.values()).map((record) => ({
        ...record,
        firstRecordedAt: 0,
        lastRecordedAt: 0,
      })),
    removeProviderFailure: (providerId) => failures.delete(providerId),
    clearProviderRetry: () => {},
    setProviderAppliedSeq: () => {},
    clearProviderFailure: (providerId) => failures.delete(providerId),
    getProviderFailure: (providerId) =>
      failures.has(providerId)
        ? { ...failures.get(providerId)!, firstRecordedAt: 0, lastRecordedAt: 0 }
        : undefined,
    armProviderRetry: () => {},
    cancelProviderRetry: () => {},
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
  fail?: ProviderLoadFailure
): ProviderLoadOutcome {
  if (kind === 'failed') return { kind, providerId, models: [], failure: fail };
  return { kind, providerId, models: [] };
}

const cases: TestCase[] = [
  {
    name: 'loaded providers are applied and cleared; unavailable providers are not applied but arm retry',
    pre: (deps) =>
      deps.recordClassifiedProviderFailure('kimi', failure('kimi', 'transient', 'timeout')),
    outcomes: [
      outcome('loaded', 'anthropic'),
      outcome('unavailable', 'kimi'),
      outcome('failed', 'deepseek', failure('deepseek', 'transient', 'timeout')),
    ],
    applied: ['anthropic', 'deepseek'],
    cleared: ['anthropic'],
    armed: ['kimi', 'deepseek'],
    recorded: [failure('deepseek', 'transient', 'timeout')],
    emitted: ['anthropic', 'deepseek', 'kimi'],
  },
  {
    name: 'credential failures are recorded and canceled',
    outcomes: [outcome('failed', 'deepseek', failure('deepseek', 'credential', 'HTTP 401'))],
    applied: ['deepseek'],
    canceled: ['deepseek'],
    recorded: [failure('deepseek', 'credential', 'HTTP 401')],
    emitted: ['deepseek'],
  },
  {
    name: 'superseded providers are left untouched',
    pre: (deps) =>
      deps.recordClassifiedProviderFailure(
        'anthropic',
        failure('anthropic', 'transient', 'timeout')
      ),
    outcomes: [outcome('superseded', 'anthropic')],
    post: (deps) => expect(deps.getProviderFailure('anthropic')).toBeDefined(),
  },
  {
    name: 'orphan failures are cleaned and empty outcomes return an empty result',
    overrides: {
      getProviderRegistry: () => ({ has: (providerId) => providerId !== 'removed' }),
    },
    pre: (deps) =>
      deps.recordClassifiedProviderFailure('removed', failure('removed', 'transient', 'timeout')),
    outcomes: [],
    post: (deps, emitted) => {
      expect(deps.getProviderFailure('removed')).toBeUndefined();
      expect(emitted).toEqual([]);
    },
  },
  {
    name: 'failed providers not in the registry are skipped',
    overrides: {
      getProviderRegistry: () => ({ has: (providerId) => providerId !== 'deepseek' }),
    },
    outcomes: [outcome('failed', 'deepseek', failure('deepseek', 'transient', 'timeout'))],
  },
  {
    name: 'empty outcomes return an empty result',
    outcomes: [],
  },
];

describe('runSettleProviderLoadOutcome', () => {
  for (const c of cases) {
    it(c.name, () => {
      const emitted: string[] = [];
      const deps = fakeDeps(c.overrides);
      deps.emitProviderSettlement = (ids) => emitted.push(...ids);
      c.pre?.(deps);
      const result = runSettleProviderLoadOutcome(deps, { outcomes: c.outcomes, loadSeq: 1 });
      expect(result.appliedProviderIds).toEqual(c.applied ?? []);
      expect(result.clearedProviderIds).toEqual(c.cleared ?? []);
      expect(result.armedProviderIds).toEqual(c.armed ?? []);
      expect(result.canceledProviderIds).toEqual(c.canceled ?? []);
      expect(result.recordedFailures).toEqual(c.recorded ?? []);
      expect(result.emitted).toBe((c.emitted ?? []).length > 0);
      expect(emitted).toEqual(c.emitted ?? []);
      c.post?.(deps, emitted);
    });
  }
});
