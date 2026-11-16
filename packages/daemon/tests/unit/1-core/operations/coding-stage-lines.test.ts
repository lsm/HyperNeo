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
    expect(await codingCandidateLine(lines, hyperneo)).toEqual({ ...opusLine, effort: 'high' });
    for (const model of ['claude-opus-5-5-alias', 'CLAUDE-OPUS-5-5', 'Claude Opus 5.5'])
      expect(await codingCandidateLine(lines, { ...hyperneo, model })).toEqual({
        ...opusLine,
        effort: 'high',
      });
    expect((await codingCandidateLine(lines, { ...glm, model: 'glm-6-alias' })).provider).toBe(
      'glm'
    );
  });

  test('an omitted model resolves to the default line, also with only an effort', async () => {
    expect(await codingCandidateLine(lines, { adapter: 'hyperneo' })).toEqual(opusLine);
    for (const effort of ['think24k', 'High', 'high'])
      expect(await codingCandidateLine(lines, { adapter: 'hyperneo', effort })).toEqual({
        ...opusLine,
        effort: 'high',
      });
  });

  test('a hyperneo model that is unknown or unavailable has no provider', async () => {
    expect((await codingCandidateLine(lines, { ...hyperneo, model: 'unknown-9' })).provider).toBe(
      ''
    );
    expect((await codingCandidateLine(lines, { ...hyperneo, model: 'retired-1' })).provider).toBe(
      ''
    );
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
    ).toEqual({ value: [desktop, claude], skipped: [] });
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
    ).toEqual({ value: [glm, desktop, hyperneo, claude], skipped: [] });
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
      ).toEqual({ value: [glm], skipped: [`${heldText}`] });
  });

  test('an effort spelled think24k or High meets a rule written for high', async () => {
    const rules = [{ line: { ...opusLine, effort: 'high' }, never: { kinds: ['coding.write'] } }];
    for (const effort of ['think24k', 'High'])
      expect(
        await rankCodingTargets(
          driverCodingLines(catalog, { rules }),
          'coding.write',
          [{ ...hyperneo, effort }, glm],
          {}
        )
      ).toEqual({
        value: [glm],
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
    expect(await rankCodingTargets(only, 'coding.write', [hyperneo], { projectId: 'p1' })).toEqual({
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
    ).toEqual({ value: [desktop], skipped: [heldText, 'unknown-9 via hyperneo: not configured'] });
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
    expect(await rankCodingTargets(off, 'coding.write', [hyperneo, desktop, glm], {})).toEqual({
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
