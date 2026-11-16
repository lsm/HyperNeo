import { describe, expect, test } from 'bun:test';
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
    expect((await codingCandidateLine(lines, hyperneo)).line).toEqual(opusLine);
    for (const model of ['claude-opus-5-5-alias', 'CLAUDE-OPUS-5-5', 'Claude Opus 5.5'])
      expect((await codingCandidateLine(lines, { ...hyperneo, model })).line).toEqual(opusLine);
    expect((await codingCandidateLine(lines, { ...glm, model: 'glm-6-alias' })).line.provider).toBe(
      'glm'
    );
  });

  test('an omitted model resolves to the default line; effort is not part of the line and is kept as given', async () => {
    expect((await codingCandidateLine(lines, { adapter: 'hyperneo' })).line).toEqual(opusLine);
    for (const effort of ['think24k', 'High', 'high']) {
      const input: { adapter: string; model?: string; effort: string } = {
        adapter: 'hyperneo',
        effort,
      };
      const offer = await codingCandidateLine(lines, input);
      expect(offer).toEqual({
        line: opusLine,
        target: { adapter: 'hyperneo', model: 'claude-opus-5-5', effort },
      });
    }
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
  test('the dispatched start names the resolved model, so an idle worker on an excluded model is not reused', async () => {
    const rules = [
      { line: { provider: 'glm', model: 'glm-6' }, never: { kinds: ['coding.write'] } },
    ];
    const defaulted: { adapter: string; place: typeof place; model?: string } = {
      adapter: 'hyperneo',
      place,
    };
    const result = await rankCodingTargets(
      driverCodingLines(catalog, { rules }),
      'coding.write',
      codingStartAlternatives(defaulted, catalog),
      {}
    );
    if ('reason' in result) throw new Error(result.reason);
    expect(result.value.some((entry) => entry.model === 'glm-6')).toBe(false);
    expect(result.value[0]).toEqual({ adapter: 'hyperneo', place, model: 'claude-opus-5-5' });
    expect(result.sources[0]).toBe(defaulted);
  });

  test('a route naming an effort does not change the effort a start runs at', async () => {
    const routes = [{ kind: 'coding.write', lines: [{ ...opusLine, effort: 'max' }] }];
    expect(
      await rankCodingTargets(
        driverCodingLines(catalog, { routes }),
        'coding.write',
        [hyperneo],
        {}
      )
    ).toMatchObject({ value: [hyperneo] });
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

describe('rankCodingTargets with a copying ranker', () => {
  test('a ranker that returns copies of the lines still maps back to the targets', async () => {
    const lines = driverCodingLines(catalog);
    const copying = {
      ...lines,
      rank: async (...args: Parameters<typeof lines.rank>) => {
        const ranking = await lines.rank(...args);
        return { ...ranking, ranked: ranking.ranked.map((entry) => ({ line: { ...entry.line } })) };
      },
    };
    expect(await rankCodingTargets(copying, 'coding.write', [hyperneo, glm], {})).toMatchObject({
      value: [hyperneo, glm],
    });
  });
});

describe('rankCodingTargets with a model id two providers share', () => {
  test('a display name that selects the second provider is dispatched so it starts there, not on the first', async () => {
    const shared = [
      catalogModel('m-1', 'x', 'M X'),
      catalogModel('m-1', 'y', 'M Y'),
      catalogModel('n-1', 'z'),
    ];
    const target = { adapter: 'hyperneo', place, model: 'M Y' };
    const held = { holds: [{ provider: 'x', model: 'm-1', retryAt: 5_000 }] };
    const lines = driverCodingLines(shared, held);
    expect((await codingCandidateLine(lines, target)).line.provider).toBe('y');
    const result = await rankCodingTargets(lines, 'coding.write', [target], {});
    expect(result).toEqual({ value: [target], sources: [target], skipped: [] });
    if ('reason' in result) throw new Error(result.reason);
    const started = await lines.resolve(result.value[0]);
    expect(started?.ok && started.value.provider).toBe('y');
  });
});

describe('codingStartAlternatives with a shared id whose providers have their own names', () => {
  test('the second provider is offered by its name, and wins when the first is held', async () => {
    const shared = [
      catalogModel('m-1', 'x', 'M X'),
      catalogModel('m-1', 'y', 'M Y'),
      catalogModel('n-1', 'z'),
    ];
    const target = { adapter: 'hyperneo', place, model: 'n-1' };
    expect(codingStartAlternatives(target, shared).map((entry) => entry.model)).toEqual([
      'n-1',
      'm-1',
      'M Y',
    ]);
    const holds = [
      { provider: 'x', model: 'm-1', retryAt: 5_000 },
      { provider: 'z', model: 'n-1', retryAt: 5_000 },
    ];
    expect(
      await rankCodingTargets(
        driverCodingLines(shared, { holds }),
        'coding.write',
        codingStartAlternatives(target, shared),
        {}
      )
    ).toMatchObject({ value: [{ ...target, model: 'M Y' }] });
  });
});

describe('codingCandidateLine for a bare start whose default is the second provider of a shared id', () => {
  test('the start is pinned to a selector that still resolves to that provider', async () => {
    const shared = [catalogModel('m-1', 'x', 'M X'), catalogModel('m-1', 'y', 'M Y')];
    const lines = driverCodingLines(shared, {
      holds: [{ provider: 'x', model: 'm-1', retryAt: 5_000 }],
      defaultIndex: 1,
    });
    const bare: { adapter: string; place: typeof place; model?: string } = {
      adapter: 'hyperneo',
      place,
    };
    const offer = await codingCandidateLine(lines, bare);
    expect(offer).toEqual({
      line: { provider: 'y', model: 'm-1', harness: 'hyperneo' },
      target: { ...bare, model: 'M Y' },
    });
    const started = await lines.resolve(offer.target);
    expect(started?.ok && started.value.provider).toBe('y');
  });
});
