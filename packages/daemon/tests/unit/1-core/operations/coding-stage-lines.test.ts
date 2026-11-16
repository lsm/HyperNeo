import { describe, expect, test } from 'bun:test';
import type { ModelInfo } from '@hyperneo/shared';
import { chooseLine } from '../../../../src/lib/neo/pack-selection.ts';
import type { NeoLine, NeoLineScope } from '../../../../src/lib/neo/pack-contract.ts';
import { type LineHold, rankLines } from '../../../../src/lib/neo/packs/model-routing/rank.ts';
import {
  CODING_WORK_KINDS,
  codingCandidateLine,
  rankCodingTargets,
} from '../../../../src/lib/neo/packs/coding/stage-lines.ts';

const place = { machine: 'fixture', name: 'Fixture' };
const model = (id: string, provider: string, available = true): ModelInfo => ({
  id,
  name: id,
  alias: `${id}-alias`,
  family: 'opus',
  provider,
  contextWindow: 200_000,
  description: id,
  releaseDate: '2026-01-01',
  available,
});
const catalog = [
  model('claude-opus-5-5', 'anthropic'),
  model('glm-6', 'glm'),
  model('retired-1', 'anthropic', false),
];
const hyperneo = { adapter: 'hyperneo', place, model: 'claude-opus-5-5', effort: 'high' };
const glm = { adapter: 'hyperneo', place, model: 'glm-6' };
const desktop = { adapter: 'codex-desktop', place, model: 'gpt-6' };
const ranker =
  (holds: LineHold[] = [], ready = ['anthropic', 'glm']) =>
  async (kind: string, candidates: readonly NeoLine[], scope: NeoLineScope) =>
    rankLines({
      kind,
      candidates,
      scope,
      prefs: { routes: [], rules: [] },
      holds,
      usage: {},
      availability: Object.fromEntries(ready.map((id) => [id, 'ready' as const])),
      now: 1_000,
    });

describe('codingCandidateLine', () => {
  test('a hyperneo candidate takes its provider from the model catalog', () => {
    expect(codingCandidateLine(hyperneo, catalog)).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      harness: 'hyperneo',
      effort: 'high',
    });
    expect(codingCandidateLine({ ...glm, model: 'glm-6-alias' }, catalog).provider).toBe('glm');
  });

  test('a desktop or CLI candidate uses its adapter id as the provider', () => {
    expect(codingCandidateLine(desktop, catalog)).toEqual({
      provider: 'codex-desktop',
      model: 'gpt-6',
      harness: 'codex-desktop',
    });
  });

  test('a hyperneo model that is unknown or unavailable has no provider', () => {
    expect(codingCandidateLine({ ...hyperneo, model: 'unknown-9' }, catalog).provider).toBe('');
    expect(codingCandidateLine({ ...hyperneo, model: 'retired-1' }, catalog).provider).toBe('');
  });
});

describe('rankCodingTargets', () => {
  const lines = (rank: ReturnType<typeof ranker>) => ({ rank, models: () => catalog });

  test('with no ranking pack the targets keep coding order', async () => {
    const pass = {
      rank: (kind: string, c: readonly NeoLine[], s: NeoLineScope) => chooseLine([], kind, c, s),
      models: () => catalog,
    };
    expect(await rankCodingTargets(pass, 'coding.review', [desktop, hyperneo], {})).toEqual({
      value: [desktop, hyperneo],
      skipped: [],
    });
  });

  test('ties keep coding order and a held line is skipped with its reason', async () => {
    const held = lines(
      ranker([{ provider: 'anthropic', model: 'claude-opus-5-5', retryAt: 5_000 }])
    );
    expect(await rankCodingTargets(lines(ranker()), 'coding.write', [hyperneo, glm], {})).toEqual({
      value: [hyperneo, glm],
      skipped: [],
    });
    expect(await rankCodingTargets(held, 'coding.write', [hyperneo, glm], {})).toEqual({
      value: [glm],
      skipped: [
        `anthropic/claude-opus-5-5 via hyperneo: held until ${new Date(5_000).toISOString()}`,
      ],
    });
  });

  test('an unknown model is skipped as not configured, and nothing usable refuses with the reasons', async () => {
    const result = await rankCodingTargets(
      lines(ranker()),
      'coding.verify',
      [{ ...hyperneo, model: 'unknown-9' }, desktop],
      { repo: 'synthetic/repo' }
    );
    expect(result).toEqual({
      reason:
        'No usable model line for coding.verify: unknown-9 via hyperneo: not configured; codex-desktop/gpt-6 via codex-desktop: not configured.',
    });
  });
});

describe('CODING_WORK_KINDS', () => {
  test('coding declares its three kinds of work for routes', () => {
    expect(CODING_WORK_KINDS.map((kind) => kind.id)).toEqual([
      'coding.write',
      'coding.review',
      'coding.verify',
    ]);
  });
});
