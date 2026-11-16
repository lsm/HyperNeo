import type { ModelInfo } from '@hyperneo/shared';
import { describe, expect, test } from 'bun:test';
import { getCodexBridgeModelInfos } from '../../../../src/lib/providers/codex-models.ts';
import { chooseLine } from '../../../../src/lib/neo/pack-selection.ts';
import {
  CODING_WORK_KINDS,
  codingCandidateLine,
  codingStartAlternatives,
  rankCodingTargets,
} from '../../../../src/lib/neo/packs/coding/stage-lines.ts';
import { catalogModel, driverCodingLines } from '../../helpers/coding-lines.ts';

const place = { machine: 'fixture', name: 'Fixture' };
const catalog = [
  catalogModel('claude-opus-5-5', 'anthropic', 'Claude Opus 5.5'),
  catalogModel('glm-6', 'glm'),
  catalogModel('retired-1', 'anthropic', 'retired-1', false),
];
const hyperneo = { adapter: 'hyperneo', place, model: 'claude-opus-5-5', effort: 'high' };
const glm = { adapter: 'hyperneo', place, model: 'glm-6' };
const desktop = { adapter: 'codex-desktop', place, model: 'gpt-6' };
const claude = { adapter: 'claude-desktop', place, model: 'claude-opus-5-5' };
const opusLine = { provider: 'anthropic', model: 'claude-opus-5-5', harness: 'hyperneo' };
const held = { holds: [{ provider: 'anthropic', model: 'claude-opus-5-5', retryAt: 5_000 }] };
const heldText = `anthropic/claude-opus-5-5 via hyperneo: held until ${new Date(5_000).toISOString()}`;

describe('codingCandidateLine', () => {
  const lines = driverCodingLines(catalog);

  test('a hyperneo candidate resolves to the canonical model and provider the driver starts', async () => {
    expect((await codingCandidateLine(lines, hyperneo)).line).toEqual({
      ...opusLine,
      effort: 'high',
    });
    for (const model of ['claude-opus-5-5-alias', 'CLAUDE-OPUS-5-5', 'Claude Opus 5.5'])
      expect((await codingCandidateLine(lines, { ...hyperneo, model })).line).toEqual({
        ...opusLine,
        effort: 'high',
      });
    expect((await codingCandidateLine(lines, { ...glm, model: 'glm-6-alias' })).line.provider).toBe(
      'glm'
    );
  });

  test('an omitted model resolves to the default line, also with only an effort', async () => {
    expect((await codingCandidateLine(lines, { adapter: 'hyperneo' })).line).toEqual(opusLine);
    for (const effort of ['think24k', 'High', 'high'])
      expect((await codingCandidateLine(lines, { adapter: 'hyperneo', effort })).line).toEqual({
        ...opusLine,
        effort: 'high',
      });
  });

  test('a hyperneo model that is unknown or unavailable has no provider', async () => {
    expect(
      (await codingCandidateLine(lines, { ...hyperneo, model: 'unknown-9' })).line.provider
    ).toBe('');
    expect(
      (await codingCandidateLine(lines, { ...hyperneo, model: 'retired-1' })).line.provider
    ).toBe('');
  });
});

describe('rankCodingTargets', () => {
  test('a list without hyperneo candidates keeps coding order and is not ranked', async () => {
    const calls: string[] = [];
    expect(
      await rankCodingTargets(
        driverCodingLines(catalog, held, calls),
        'coding.review',
        [desktop, claude],
        {}
      )
    ).toMatchObject({ value: [desktop, claude], skipped: [] });
    expect(calls).toEqual([]);
  });

  test('hyperneo candidates are reordered within their own slots; external ones stay put', async () => {
    const routes = [{ kind: 'coding.write', lines: [{ provider: 'glm', model: 'glm-6' }] }];
    expect(
      await rankCodingTargets(
        driverCodingLines(catalog, { routes }),
        'coding.write',
        [hyperneo, desktop, glm, claude],
        {}
      )
    ).toMatchObject({ value: [glm, desktop, hyperneo, claude], skipped: [] });
  });

  test('a canonical hold catches an alias, case or display-name target', async () => {
    for (const model of ['claude-opus-5-5-alias', 'CLAUDE-OPUS-5-5', 'Claude Opus 5.5'])
      expect(
        await rankCodingTargets(
          driverCodingLines(catalog, held),
          'coding.write',
          [{ ...hyperneo, model }, glm],
          {}
        )
      ).toMatchObject({ value: [glm], skipped: [`${heldText}`] });
  });

  test('an effort spelled think24k or High meets a rule written for high; the nearest allowed effort is used', async () => {
    const rules = [{ line: { ...opusLine, effort: 'high' }, never: { kinds: ['coding.write'] } }];
    for (const effort of ['think24k', 'High'])
      expect(
        await rankCodingTargets(
          driverCodingLines(catalog, { rules }),
          'coding.write',
          [{ ...hyperneo, effort }, glm],
          {}
        )
      ).toMatchObject({
        value: [{ ...hyperneo, effort: 'medium' }, glm],
        skipped: ['anthropic/claude-opus-5-5 via hyperneo: excluded by a rule'],
      });
  });

  test('project rules apply to the scope: never excludes, only allows', async () => {
    const line = opusLine;
    const never = driverCodingLines(catalog, { rules: [{ line, never: { projects: ['p1'] } }] });
    const only = driverCodingLines(catalog, { rules: [{ line, only: { projects: ['p1'] } }] });
    expect(await rankCodingTargets(never, 'coding.write', [hyperneo], { projectId: 'p1' })).toEqual(
      {
        reason:
          'No usable model line for coding.write: anthropic/claude-opus-5-5 via hyperneo: excluded by a rule.',
      }
    );
    expect(
      await rankCodingTargets(only, 'coding.write', [hyperneo], { projectId: 'p1' })
    ).toMatchObject({
      value: [hyperneo],
      skipped: [],
    });
  });

  test('a refused hyperneo candidate is dropped; unknown models are not configured', async () => {
    expect(
      await rankCodingTargets(
        driverCodingLines(catalog, held),
        'coding.write',
        [hyperneo, desktop, { ...glm, model: 'unknown-9' }],
        {}
      )
    ).toMatchObject({
      value: [desktop],
      skipped: [heldText, 'unknown-9 via hyperneo: not configured'],
    });
  });

  test('when every candidate is refused, coding refuses with the skip reasons', async () => {
    expect(
      await rankCodingTargets(
        driverCodingLines(catalog, { ready: [] }),
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
    const off = {
      ...driverCodingLines(catalog),
      rank: (kind: string, candidates: Parameters<typeof chooseLine>[2], scope: object) =>
        chooseLine([], kind, candidates, scope),
    };
    expect(
      await rankCodingTargets(off, 'coding.write', [hyperneo, desktop, glm], {})
    ).toMatchObject({
      value: [hyperneo, desktop, glm],
      skipped: [],
    });
  });
});

describe('codingStartAlternatives', () => {
  test('a hyperneo start offers every usable catalog model after its own, at the same place', () => {
    expect(codingStartAlternatives(hyperneo, catalog)).toEqual([hyperneo, { ...hyperneo, ...glm }]);
    expect(codingStartAlternatives(desktop, catalog)).toEqual([desktop]);
  });

  test('a model id two providers share is offered once, as the line the driver starts', async () => {
    const shared = [catalogModel('m-1', 'x'), catalogModel('m-1', 'y'), catalogModel('n-1', 'z')];
    const target = { adapter: 'hyperneo', place, model: 'n-1' };
    expect(codingStartAlternatives(target, shared).map((entry) => entry.model)).toEqual([
      'n-1',
      'm-1',
    ]);
    const held = { holds: [{ provider: 'z', model: 'n-1', retryAt: 5_000 }] };
    expect(
      await rankCodingTargets(
        driverCodingLines(shared, held),
        'coding.write',
        codingStartAlternatives(target, shared),
        {}
      )
    ).toMatchObject({ value: [{ ...target, model: 'm-1' }] });
  });

  test('a remote start is left to its own daemon and never ranked here', async () => {
    const remote = { ...hyperneo, place: { ...place, daemon: 'other-host' } };
    const calls: string[] = [];
    expect(codingStartAlternatives(remote, catalog)).toEqual([remote]);
    expect(
      await rankCodingTargets(
        driverCodingLines(catalog, { ready: [] }, calls),
        'coding.write',
        [remote],
        {}
      )
    ).toMatchObject({ value: [remote], sources: [remote], skipped: [] });
    expect(calls).toEqual([]);
  });
});

describe('rankCodingTargets with an inherited start', () => {
  const route = (effort: string) => [
    { kind: 'coding.write', lines: [{ provider: 'glm', model: 'glm-6', effort }] },
  ];

  test('an omitted effort ranks as the inherited effort for rules and routes; the nearest allowed effort is used', async () => {
    const rules = [{ line: { ...opusLine, effort: 'high' }, never: { kinds: ['coding.write'] } }];
    const target = { adapter: 'hyperneo', place, model: 'claude-opus-5-5' };
    expect(
      await rankCodingTargets(
        driverCodingLines(catalog, { rules, effort: 'high' }),
        'coding.write',
        [target, glm],
        {}
      )
    ).toMatchObject({
      value: [
        { ...target, effort: 'medium' },
        { ...glm, effort: 'high' },
      ],
    });
    expect(
      await rankCodingTargets(
        driverCodingLines(catalog, { routes: route('high'), effort: 'high' }),
        'coding.write',
        [target, glm],
        {}
      )
    ).toMatchObject({
      value: [
        { ...glm, effort: 'high' },
        { ...target, effort: 'high' },
      ],
    });
  });

  test('the dispatched start names the resolved model, so an idle worker on an excluded model is not reused', async () => {
    const rules = [
      { line: { provider: 'glm', model: 'glm-6' }, never: { kinds: ['coding.write'] } },
    ];
    const defaulted: { adapter: string; place: typeof place; model?: string; effort?: string } = {
      adapter: 'hyperneo',
      place,
    };
    const result = await rankCodingTargets(
      driverCodingLines(catalog, { rules, effort: 'medium' }),
      'coding.write',
      codingStartAlternatives(defaulted, catalog),
      {}
    );
    if ('reason' in result) throw new Error(result.reason);
    expect(result.value.map((entry) => entry.model)).not.toContain('glm-6');
    expect(result.value[0]).toEqual({
      adapter: 'hyperneo',
      place,
      model: 'claude-opus-5-5',
      effort: 'medium',
    });
    expect(result.sources[0]).toBe(defaulted);
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

describe('rankCodingTargets with route effort', () => {
  const graded = [
    { ...catalogModel('claude-opus-5-5', 'anthropic'), effortLevels: ['low', 'medium', 'high'] },
    catalogModel('glm-6', 'glm'),
  ] as ModelInfo[];
  const target = { adapter: 'hyperneo', place, model: 'claude-opus-5-5' };

  test.each(['coding.write', 'coding.review', 'coding.verify'])(
    'a %s route naming high wins over the medium default and the target carries high',
    async (kind) => {
      const routes = [{ kind, lines: [{ ...opusLine, effort: 'high' }] }];
      const result = await rankCodingTargets(
        driverCodingLines(graded, { routes, effort: 'medium' }),
        kind,
        [target, glm],
        {}
      );
      expect(result).toMatchObject({
        value: [{ ...target, effort: 'high' }, glm],
        sources: [target, glm],
      });
    }
  );

  test('with no effort route the default effort stays first', async () => {
    expect(
      await rankCodingTargets(
        driverCodingLines(graded, { effort: 'medium' }),
        'coding.write',
        [target, glm],
        {}
      )
    ).toMatchObject({ value: [{ ...target, effort: 'medium' }, glm] });
  });
});

describe('rankCodingTargets with real catalog efforts', () => {
  test('a Codex model with no catalog effort list still offers the driver efforts a route can pick', async () => {
    const codex = getCodexBridgeModelInfos();
    const sol = { adapter: 'hyperneo', place, model: 'gpt-6.1-sol' };
    const line = { provider: 'anthropic-codex', model: 'gpt-6.1-sol' };
    const routes = [{ kind: 'coding.write', lines: [{ ...line, effort: 'high' }] }];
    expect(
      await rankCodingTargets(
        driverCodingLines(codex, { routes, effort: 'medium' }),
        'coding.write',
        [sol],
        {}
      )
    ).toMatchObject({ value: [{ ...sol, effort: 'high' }] });
    const rules = [{ line: { ...line, effort: 'medium' }, never: { kinds: ['coding.write'] } }];
    const result = await rankCodingTargets(
      driverCodingLines(codex, { rules, effort: 'medium' }),
      'coding.write',
      [sol],
      {}
    );
    expect(result).toMatchObject({ value: [{ ...sol, effort: 'low' }] });
  });

  test('catalog xhigh is offered in driver vocabulary and a route written as xhigh picks it', async () => {
    const opus = {
      ...catalogModel('claude-opus-5-5', 'anthropic'),
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    } as ModelInfo;
    const routes = [{ kind: 'coding.review', lines: [{ ...opusLine, effort: 'xhigh' }] }];
    expect(
      await rankCodingTargets(
        driverCodingLines([opus], { routes, effort: 'medium' }),
        'coding.review',
        [hyperneo],
        {}
      )
    ).toMatchObject({ value: [{ ...hyperneo, effort: 'extra high' }] });
  });
});

describe('rankCodingTargets with executed efforts', () => {
  const graded = (effortLevels: ModelInfo['effortLevels']) =>
    [{ ...catalogModel('claude-opus-5-5', 'anthropic'), effortLevels }] as ModelInfo[];
  const never = (efforts: string[]) =>
    efforts.map((effort) => ({
      line: { ...opusLine, effort },
      never: { kinds: ['coding.write'] },
    }));

  test('ultra on a model whose top level is max ranks as max, so a max rule catches it', async () => {
    const result = await rankCodingTargets(
      driverCodingLines(graded(['low', 'medium', 'high', 'max']), { rules: never(['max']) }),
      'coding.write',
      [{ ...hyperneo, effort: 'ultra' }],
      {}
    );
    expect(result).toMatchObject({
      value: [{ ...hyperneo, effort: 'high' }],
      skipped: ['anthropic/claude-opus-5-5 via hyperneo: excluded by a rule'],
    });
  });

  test('an inherited medium on a model without medium ranks as the low it runs at', async () => {
    const lines = driverCodingLines(graded(['low', 'high', 'max']), {
      rules: never(['low']),
      effort: 'medium',
    });
    const target = { adapter: 'hyperneo', place, model: 'claude-opus-5-5' };
    expect(await rankCodingTargets(lines, 'coding.write', [target], {})).toMatchObject({
      value: [{ ...target, effort: 'high' }],
    });
  });

  test('a route can select off, and off is the fallback when every effort is excluded', async () => {
    const routes = [{ kind: 'coding.write', lines: [{ ...opusLine, effort: 'off' }] }];
    const levels = graded(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(
      await rankCodingTargets(driverCodingLines(levels, { routes }), 'coding.write', [hyperneo], {})
    ).toMatchObject({ value: [{ ...hyperneo, effort: 'off' }] });
    expect(
      await rankCodingTargets(
        driverCodingLines(levels, { rules: never(['low', 'medium', 'high', 'xhigh', 'max']) }),
        'coding.write',
        [hyperneo],
        {}
      )
    ).toMatchObject({ value: [{ ...hyperneo, effort: 'off' }] });
  });
});
