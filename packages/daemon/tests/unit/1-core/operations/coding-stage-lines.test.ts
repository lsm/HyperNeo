import { describe, expect, test } from 'bun:test';
import type { ModelInfo } from '@hyperneo/shared';
import { chooseLine } from '../../../../src/lib/neo/pack-selection.ts';
import type { NeoLine, NeoLineScope } from '../../../../src/lib/neo/pack-contract.ts';
import { type LineHold, rankLines } from '../../../../src/lib/neo/packs/model-routing/rank.ts';
import {
  type CodingLines,
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
const claude = { adapter: 'claude-desktop', place, model: 'claude-opus-5-5' };
const ranker =
  (holds: LineHold[] = [], ready = ['anthropic', 'glm'], first?: NeoLine) =>
  async (kind: string, candidates: readonly NeoLine[], scope: NeoLineScope) =>
    rankLines({
      kind,
      candidates,
      scope,
      prefs: { routes: first ? [{ kind, lines: [first] }] : [], rules: [] },
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

  test('a hyperneo model that is unknown or unavailable has no provider', () => {
    expect(codingCandidateLine({ ...hyperneo, model: 'unknown-9' }, catalog).provider).toBe('');
    expect(codingCandidateLine({ ...hyperneo, model: 'retired-1' }, catalog).provider).toBe('');
  });
});

describe('rankCodingTargets', () => {
  const lines = (rank: CodingLines['rank']): CodingLines => ({ rank, models: () => catalog });
  const glmFirst = { provider: 'glm', model: 'glm-6' };

  test('a list without hyperneo candidates keeps coding order and is not ranked', async () => {
    const calls: string[] = [];
    const rank: CodingLines['rank'] = async (kind, candidates, scope) => {
      calls.push(kind);
      return ranker()(kind, candidates, scope);
    };
    expect(await rankCodingTargets(lines(rank), 'coding.review', [desktop, claude], {})).toEqual({
      value: [desktop, claude],
      skipped: [],
    });
    expect(calls).toEqual([]);
  });

  test('hyperneo candidates are reordered within their own slots; external ones stay put', async () => {
    expect(
      await rankCodingTargets(
        lines(ranker([], undefined, glmFirst)),
        'coding.write',
        [hyperneo, desktop, glm, claude],
        {}
      )
    ).toEqual({ value: [glm, desktop, hyperneo, claude], skipped: [] });
  });

  test('a refused hyperneo candidate is dropped with its reason; unknown models are not configured', async () => {
    const held = ranker([{ provider: 'anthropic', model: 'claude-opus-5-5', retryAt: 5_000 }]);
    expect(
      await rankCodingTargets(
        lines(held),
        'coding.write',
        [hyperneo, desktop, { ...glm, model: 'unknown-9' }],
        {}
      )
    ).toEqual({
      value: [desktop],
      skipped: [
        `anthropic/claude-opus-5-5 via hyperneo: held until ${new Date(5_000).toISOString()}`,
        'unknown-9 via hyperneo: not configured',
      ],
    });
  });

  test('when every candidate is refused, coding refuses with the skip reasons', async () => {
    expect(
      await rankCodingTargets(
        lines(ranker([], [])),
        'coding.verify',
        [hyperneo, { ...glm, model: 'unknown-9' }],
        { repo: 'synthetic/repo' }
      )
    ).toEqual({
      reason:
        'No usable model line for coding.verify: anthropic/claude-opus-5-5 via hyperneo: not configured; unknown-9 via hyperneo: not configured.',
    });
  });

  test('with the routing pack off, chooseLine passes candidates through and order is unchanged', async () => {
    const off = lines((kind, candidates, scope) => chooseLine([], kind, candidates, scope));
    expect(await rankCodingTargets(off, 'coding.write', [hyperneo, desktop, glm], {})).toEqual({
      value: [hyperneo, desktop, glm],
      skipped: [],
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
