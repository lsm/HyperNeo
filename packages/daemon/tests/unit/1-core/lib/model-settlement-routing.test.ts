import { describe, expect, it } from 'bun:test';

import type { ModelInfo } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import type { ProviderModelLoadResult } from '../../../../src/lib/model-service';
import {
  classifyProviderLoadOutcomes,
  decideProviderRetryAction,
  type ProviderLoadClassificationContext,
  type ProviderLoadOutcome,
  type ProviderRetryAction,
} from '../../../../src/lib/model-settlement-routing';

type ProviderSpec = { id: string; remote?: boolean };

type ResultSpec =
  | { status: 'loaded'; models: ModelInfo[] }
  | { status: 'unavailable' }
  | { status: 'failed'; models: ModelInfo[]; error?: unknown }
  | { status: 'rejected'; reason: unknown };

function model(id: string, provider: string): ModelInfo {
  return {
    id,
    name: id,
    alias: '',
    family: provider,
    provider,
    contextWindow: 128000,
    description: '',
    releaseDate: '',
    available: true,
  };
}

const sonnet = model('sonnet', 'anthropic');
const kimiCached = model('kimi-k2', 'kimi');
const deepseekFallback = model('deepseek-chat', 'deepseek');
const firstError = new Error('remote discovery failed first');
const secondError = new Error('remote discovery failed second');

function providers(specs: ProviderSpec[]): Pick<Provider, 'id' | 'listRemoteModels'>[] {
  return specs.map((spec) =>
    spec.remote ? { id: spec.id, listRemoteModels: async () => [] } : { id: spec.id }
  );
}

function results(specs: ResultSpec[]): PromiseSettledResult<ProviderModelLoadResult>[] {
  return specs.map((spec) => {
    if (spec.status === 'rejected') return { status: 'rejected' as const, reason: spec.reason };
    if (spec.status === 'unavailable') {
      return { status: 'fulfilled' as const, value: { status: 'unavailable', models: [] } };
    }
    if (spec.status === 'failed') {
      return {
        status: 'fulfilled' as const,
        value: { status: 'failed', models: spec.models, error: spec.error },
      };
    }
    return { status: 'fulfilled' as const, value: { status: 'loaded', models: spec.models } };
  });
}

const failedSpec = (error?: unknown, models: ModelInfo[] = []): ResultSpec => ({
  status: 'failed',
  models,
  error,
});

const loadOk = (providerId: string, models: ModelInfo[]): ProviderLoadOutcome => ({
  kind: 'loaded',
  providerId,
  models,
});

const loadUnavailable = (providerId: string): ProviderLoadOutcome => ({
  kind: 'unavailable',
  providerId,
  models: [],
});

const loadSuperseded = (providerId: string, models: ModelInfo[]): ProviderLoadOutcome => ({
  kind: 'superseded',
  providerId,
  models,
});

const loadFailed = (
  providerId: string,
  errorKind: 'transient' | 'credential',
  message: string,
  models: ModelInfo[] = []
): ProviderLoadOutcome => ({
  kind: 'failed',
  providerId,
  models,
  failure: { providerId, errorKind, message },
});

interface ClassifyRow {
  name: string;
  providerSpecs: ProviderSpec[];
  resultSpecs: ResultSpec[];
  loadSeq?: number;
  context?: ProviderLoadClassificationContext;
  expectedOutcomes: ProviderLoadOutcome[];
  expectedForced?: unknown;
}

const classifyTable: ClassifyRow[] = [
  {
    name: 'credential-pattern failures classify as credential',
    providerSpecs: [{ id: 'deepseek' }],
    resultSpecs: [failedSpec(new Error('HTTP 401 unauthorized'), [deepseekFallback])],
    expectedOutcomes: [
      loadFailed('deepseek', 'credential', 'HTTP 401 unauthorized', [deepseekFallback]),
    ],
  },
  {
    name: 'failed provider without an error records no failure',
    providerSpecs: [{ id: 'deepseek' }],
    resultSpecs: [failedSpec(undefined, [deepseekFallback])],
    expectedOutcomes: [{ kind: 'failed', providerId: 'deepseek', models: [deepseekFallback] }],
  },
  {
    name: 'rejected results are skipped entirely',
    providerSpecs: [{ id: 'anthropic' }, { id: 'kimi' }],
    resultSpecs: [
      { status: 'rejected', reason: new Error('boom') },
      { status: 'loaded', models: [kimiCached] },
    ],
    expectedOutcomes: [loadOk('kimi', [kimiCached])],
  },
  {
    name: 'superseded provider contributes only its cached slice',
    providerSpecs: [{ id: 'anthropic' }],
    resultSpecs: [{ status: 'loaded', models: [sonnet] }],
    loadSeq: 3,
    context: { appliedSeq: new Map([['anthropic', 5]]), cachedModels: [sonnet, kimiCached] },
    expectedOutcomes: [loadSuperseded('anthropic', [sonnet])],
  },
  {
    name: 'applied seq equal to the load seq is not superseded',
    providerSpecs: [{ id: 'anthropic' }],
    resultSpecs: [{ status: 'loaded', models: [sonnet] }],
    loadSeq: 3,
    context: { appliedSeq: new Map([['anthropic', 3]]) },
    expectedOutcomes: [loadOk('anthropic', [sonnet])],
  },
  {
    name: 'superseded provider without cached models yields an empty slice',
    providerSpecs: [{ id: 'anthropic' }],
    resultSpecs: [{ status: 'loaded', models: [sonnet] }],
    loadSeq: 3,
    context: { appliedSeq: new Map([['anthropic', 5]]) },
    expectedOutcomes: [loadSuperseded('anthropic', [])],
  },
  {
    name: 'mixed fan-out preserves provider order across kinds',
    providerSpecs: [{ id: 'anthropic' }, { id: 'kimi' }, { id: 'deepseek' }, { id: 'glm' }],
    resultSpecs: [
      { status: 'loaded', models: [sonnet] },
      { status: 'rejected', reason: new Error('boom') },
      failedSpec(new Error('timeout'), [deepseekFallback]),
      { status: 'unavailable' },
    ],
    loadSeq: 4,
    context: { appliedSeq: new Map([['anthropic', 9]]), cachedModels: [sonnet, kimiCached] },
    expectedOutcomes: [
      loadSuperseded('anthropic', [sonnet]),
      loadFailed('deepseek', 'transient', 'timeout', [deepseekFallback]),
      loadUnavailable('glm'),
    ],
  },
  {
    name: 'forced remote failure surfaces the discovery error',
    providerSpecs: [{ id: 'kimi', remote: true }],
    resultSpecs: [failedSpec(firstError)],
    context: { forceRemote: true },
    expectedOutcomes: [loadFailed('kimi', 'transient', 'remote discovery failed first')],
    expectedForced: firstError,
  },
  {
    name: 'first forced remote failure wins',
    providerSpecs: [
      { id: 'kimi', remote: true },
      { id: 'glm', remote: true },
    ],
    resultSpecs: [failedSpec(firstError), failedSpec(secondError)],
    context: { forceRemote: true },
    expectedOutcomes: [
      loadFailed('kimi', 'transient', 'remote discovery failed first'),
      loadFailed('glm', 'transient', 'remote discovery failed second'),
    ],
    expectedForced: firstError,
  },
  {
    name: 'forced error skips a failed provider without remote listing',
    providerSpecs: [{ id: 'deepseek' }, { id: 'kimi', remote: true }],
    resultSpecs: [failedSpec(firstError, [deepseekFallback]), failedSpec(secondError)],
    context: { forceRemote: true },
    expectedOutcomes: [
      loadFailed('deepseek', 'transient', 'remote discovery failed first', [deepseekFallback]),
      loadFailed('kimi', 'transient', 'remote discovery failed second'),
    ],
    expectedForced: secondError,
  },
  {
    name: 'no forced discovery error without forceRemote',
    providerSpecs: [{ id: 'kimi', remote: true }],
    resultSpecs: [failedSpec(firstError)],
    expectedOutcomes: [loadFailed('kimi', 'transient', 'remote discovery failed first')],
  },
  {
    name: 'no forced discovery error for a failed provider without an error',
    providerSpecs: [{ id: 'kimi', remote: true }],
    resultSpecs: [failedSpec()],
    context: { forceRemote: true },
    expectedOutcomes: [{ kind: 'failed', providerId: 'kimi', models: [] }],
  },
];

describe('classifyProviderLoadOutcomes decision table', () => {
  for (const row of classifyTable) {
    it(row.name, () => {
      const classification = classifyProviderLoadOutcomes(
        results(row.resultSpecs),
        providers(row.providerSpecs),
        row.loadSeq ?? 1,
        row.context
      );
      expect(classification.outcomes).toEqual(row.expectedOutcomes);
      expect(classification.forcedDiscoveryError).toBe(row.expectedForced);
    });
  }
});

describe('decideProviderRetryAction decision table', () => {
  const retryTable: {
    name: string;
    outcome: ProviderLoadOutcome;
    expected: ProviderRetryAction;
  }[] = [
    {
      name: 'loaded clears failure and retry state',
      outcome: loadOk('anthropic', []),
      expected: 'clear',
    },
    {
      name: 'superseded keeps retry state untouched',
      outcome: loadSuperseded('anthropic', []),
      expected: 'keep',
    },
    {
      name: 'unavailable keeps retry state untouched',
      outcome: loadUnavailable('anthropic'),
      expected: 'keep',
    },
    {
      name: 'transient failure arms the retry timer',
      outcome: loadFailed('deepseek', 'transient', 'timeout'),
      expected: 'arm',
    },
    {
      name: 'credential failure cancels the retry timer',
      outcome: loadFailed('deepseek', 'credential', 'HTTP 401'),
      expected: 'cancel',
    },
    {
      name: 'failed without a recorded failure keeps retry state',
      outcome: { kind: 'failed', providerId: 'deepseek', models: [] },
      expected: 'keep',
    },
  ];

  for (const row of retryTable) {
    it(row.name, () => {
      expect(decideProviderRetryAction(row.outcome)).toBe(row.expected);
    });
  }
});
