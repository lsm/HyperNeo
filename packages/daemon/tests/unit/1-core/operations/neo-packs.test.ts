import { describe, expect, test } from 'bun:test';
import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoEvidence } from '../../../../src/lib/neo/evidence.ts';
import {
  cachedNeoCardPrRead,
  codingPrMergedCheck,
  createCodingPack,
  neoCardPrsFresh,
  readNeoCardPrs,
} from '../../../../src/lib/neo/packs/coding/pack.ts';
import { createLifeAdminPack } from '../../../../src/lib/neo/packs/life-admin/pack.ts';
import { planNeoCardPrCandidates } from '../../../../src/lib/neo/packs/coding/card-pr-claims.ts';
import type { NeoWorkPrRow } from '../../../../src/lib/neo/packs/coding/neo-work-pr-repository.ts';
import {
  NEO_DEFAULT_PACKS,
  neoPackEvidenceOrNone,
  neoPackBriefs,
  neoPackAskCardEvidence,
  neoPackChecks,
  neoPackFragment,
  neoPacks,
  planNeoPackTicks,
  readNeoPackEvidence,
  requireNeoAskPack,
  requireNeoEvidenceRefresh,
  requireNeoPackTickable,
} from '../../../../src/lib/neo/packs/index.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';

const pack = (id: string, describe = id): NeoPack => ({ id, describe, instructions: () => null });

describe('neoPackBriefs', () => {
  test('lists the enabled built-in packs by default', () => {
    expect(neoPackBriefs(NEO_DEFAULT_PACKS)).toEqual([
      {
        id: 'coding',
        describe: 'Software work in git repositories: pull requests, CI, review and merging.',
      },
    ]);
  });

  test('keeps only installed packs the enable list names', () => {
    const briefs = neoPackBriefs(['coding', 'legal-review'], [{ id: 'coding', describe: 'code' }]);
    expect(briefs.map((brief) => brief.id)).toEqual(['coding']);
  });
});

describe('requireNeoAskPack', () => {
  const enabled = [pack('coding')];

  test('a generic ask passes without a pack', () => {
    expect(requireNeoAskPack(undefined, enabled)).toEqual({ value: null });
  });

  test('an enabled pack passes', () => {
    expect(requireNeoAskPack('coding', enabled)).toEqual({ value: 'coding' });
  });

  test('a pack the enable list does not name is refused with the enabled ids', () => {
    const refused = requireNeoAskPack('legal-review', enabled);
    expect(refused).toEqual({
      reason: {
        ok: false,
        reason:
          'pack_not_enabled: "legal-review" is not an enabled pack (enabled: coding). Open the ask without pack, or enable the pack first.',
      },
    });
  });
});

describe('neoPackFragment', () => {
  const ask = { pack: 'coding' } as NeoAsk;
  const speaking = (id: string): NeoPack => ({
    id,
    describe: id,
    instructions: () => `${id} guidance`,
  });

  test('returns the pack instructions an ask names', () => {
    expect(neoPackFragment(ask, [speaking('coding'), speaking('other')])).toEqual({
      id: 'coding',
      instructions: 'coding guidance',
    });
  });

  test('an ask without a pack or a pack without instructions has no fragment', () => {
    expect(neoPackFragment({ ...ask, pack: null }, [speaking('coding')])).toBeNull();
    expect(neoPackFragment(null, [speaking('coding')])).toBeNull();
    expect(neoPackFragment(undefined, [speaking('coding')])).toBeNull();
    expect(neoPackFragment(ask, [pack('coding')])).toBeNull();
    expect(neoPackFragment(ask, [speaking('unknown')])).toBeNull();
  });
});

describe('coding pack instructions', () => {
  test('carry the moved coding guidance', () => {
    const coding = createCodingPack({
      prCandidates: async (work, stored) =>
        planNeoCardPrCandidates({
          report: work.report,
          brief: '',
          branch: [],
          stored: stored?.prs ?? [],
        }),
      claims: { forUrls: () => [], replace: () => {}, drop: () => {} },
      runningPrUrls: async () => [],
      cardReports: () => [],
      readPrs: async () => [],
      workPrs: { get: () => null, recordFailedRead: () => {} },
      record: () => null,
    });
    expect(coding.instructions(null)).toBe(NEO_PACK_CODING_INSTRUCTIONS);
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('merged to the');
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('git remote');
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('own worktree');
  });
});

describe('neoPacks', () => {
  const coding = pack('coding');
  const legal = pack('legal-review');
  test.each<[string, NeoPack[], string[], string[]]>([
    ['the built-in coding pack by default', [], NEO_DEFAULT_PACKS, ['coding']],
    ['a file pack once enabled', [legal], ['coding', 'legal-review'], ['coding', 'legal-review']],
    ['nothing that is not enabled', [legal], ['coding'], ['coding']],
    [
      'the built-in pack over a file pack with its id',
      [pack('coding', 'copy')],
      ['coding'],
      ['coding'],
    ],
  ])('keeps %s', (_label, filePacks, enabled, ids) => {
    const packs = neoPacks({ builtins: [coding], filePacks, enabled });
    expect(packs.map((item) => item.id)).toEqual(ids);
    expect(packs[0]).toBe(coding);
  });
});

describe('readEvidence', () => {
  const pr: NeoWorkPr = {
    url: 'https://github.com/lsm/HyperNeo/pull/1',
    state: 'OPEN',
    checks: 'passing',
    review: 'approved',
  };
  const row = (prs: NeoWorkPr[], readOkAt: number): NeoWorkPrRow => ({
    workId: 'w1',
    prs,
    revision: 1,
    readAt: readOkAt,
    readOkAt,
  });
  const work = (report: string | null) => ({ id: 'w1', report }) as NeoWork;
  const setup = (stored: NeoWorkPrRow | null, read: NeoWorkPr[] | null) => {
    const failed: number[] = [];
    const recorded: NeoWorkPr[][] = [];
    const coding = createCodingPack({
      prCandidates: async (work, stored) =>
        planNeoCardPrCandidates({
          report: work.report,
          brief: '',
          branch: [],
          stored: stored?.prs ?? [],
        }),
      claims: { forUrls: () => [], replace: () => {}, drop: () => {} },
      runningPrUrls: async () => [],
      cardReports: () => [],
      readPrs: async () => read,
      workPrs: { get: () => stored, recordFailedRead: (_id, at) => failed.push(at) },
      record: (_id, prs) => {
        recorded.push([...prs]);
        return row([...prs], 50);
      },
    });
    return { coding, failed, recorded };
  };

  test('reads the pull requests a report names and records them as evidence', async () => {
    const { coding, recorded } = setup(null, [pr]);
    expect(await coding.readEvidence?.(work(`Opened ${pr.url}.`))).toEqual({
      evidence: [expect.objectContaining({ key: pr.url, state: 'ready' })],
      read: { ok: true, okAt: 50 },
    });
    expect(recorded).toEqual([[pr]]);
  });

  test('falls back to the stored state when the read fails', async () => {
    const { coding, failed } = setup(row([pr], 10), null);
    expect(await coding.readEvidence?.(work(null))).toEqual({
      evidence: [expect.objectContaining({ key: pr.url })],
      read: { ok: false, okAt: 10 },
    });
    expect(failed).toHaveLength(1);
  });

  test('has no evidence for a card with no pull requests', async () => {
    expect(await setup(null, [pr]).coding.readEvidence?.(work('No PR yet.'))).toBeNull();
  });
});

describe('readNeoPackEvidence', () => {
  test('keeps the other packs evidence when one pack fails to read', async () => {
    const evidence = { key: 'pr/1', state: 'ready' as const, summary: 'approved', blockers: [] };
    const warned: string[] = [];
    const read = await readNeoPackEvidence(
      [
        { ...pack('broken'), readEvidence: async () => Promise.reject(new Error('mcp down')) },
        pack('knowledge'),
        {
          ...pack('coding'),
          readEvidence: async () => ({ evidence: [evidence], read: { ok: true, okAt: 7 } }),
        },
      ],
      { id: 'w1' } as NeoWork,
      (id) => warned.push(id)
    );
    expect(read).toEqual({ evidence: [evidence], read: { ok: true, okAt: 7 } });
    expect(warned).toEqual(['broken']);
  });
});

const merged: NeoEvidence = {
  key: 'https://github.com/lsm/HyperNeo/pull/1',
  state: 'done',
  summary: 'merged',
  blockers: [],
};
const open: NeoEvidence = {
  ...merged,
  key: 'https://github.com/lsm/HyperNeo/pull/2',
  state: 'pending',
  summary: 'open',
};
const item = (overrides: Partial<NeoAskItem> = {}): NeoAskItem => ({
  id: 'i1',
  text: 'Fix merged to dev',
  state: 'pending',
  evidence: null,
  check: 'coding.pr_merged',
  metBy: null,
  removed: false,
  addedAt: null,
  ...overrides,
});

describe('codingPrMergedCheck', () => {
  const confirmation: NeoEvidence = {
    key: 'confirmation:<msg-1>',
    state: 'done',
    summary: 'orders@amazon.com',
    blockers: [],
  };
  test.each<[string, NeoEvidence[], ReturnType<typeof codingPrMergedCheck>]>([
    [
      'every tracked pull request merged',
      [merged],
      { value: 'Merged: https://github.com/lsm/HyperNeo/pull/1' },
    ],
    ['one still open', [merged, open], { reason: 'not_merged' }],
    ['no pull requests', [], { reason: 'not_merged' }],
    ['only another pack evidence, all done', [confirmation], { reason: 'not_merged' }],
  ])('%s', (_label, evidence, gate) => {
    expect(codingPrMergedCheck(item(), evidence)).toEqual(gate);
  });
});

describe('neoPackChecks', () => {
  test('takes each kind from the first pack that defines it', () => {
    const first = () => ({ value: 'first' });
    const second = () => ({ value: 'second' });
    const checks = neoPackChecks([
      { ...pack('coding'), checks: { 'coding.pr_merged': first } },
      { ...pack('other'), checks: { 'coding.pr_merged': second, 'other.filed': second } },
    ]);
    expect(checks).toEqual({ 'coding.pr_merged': first, 'other.filed': second });
  });
});

describe('planNeoPackTicks', () => {
  const ask = (items: NeoAskItem[], status: NeoAsk['status'] = 'open') =>
    ({ id: 'a1', status, doneItems: items }) as NeoAsk;
  const checks = { 'coding.pr_merged': codingPrMergedCheck };
  test.each<[string, NeoAsk | null, NeoEvidence[], ReturnType<typeof planNeoPackTicks>]>([
    [
      'a merged item on a live ask',
      ask([item()]),
      [merged],
      [{ id: 'i1', evidence: 'Merged: https://github.com/lsm/HyperNeo/pull/1' }],
    ],
    [
      'a waiting ask too',
      ask([item()], 'waiting'),
      [merged],
      [{ id: 'i1', evidence: 'Merged: https://github.com/lsm/HyperNeo/pull/1' }],
    ],
    ['an item already met', ask([item({ state: 'met' })]), [merged], []],
    ['a removed item', ask([item({ removed: true })]), [merged], []],
    ['an item with no check', ask([item({ check: null })]), [merged], []],
    ['a pull request still open', ask([item()]), [merged, open], []],
    ['a settled ask', ask([item()], 'achieved'), [merged], []],
    ['a card with no ask', null, [merged], []],
  ])('%s', (_label, current, evidence, ticks) => {
    expect(planNeoPackTicks(current, evidence, checks)).toEqual(ticks);
  });
});

describe('requireNeoPackTickable', () => {
  const ask = (items: NeoAskItem[], status: NeoAsk['status'] = 'open') =>
    ({ id: 'a1', status, doneItems: items }) as NeoAsk;
  test.each<[string, NeoAsk | null, boolean]>([
    ['a live ask with an unmet checked item', ask([item()]), true],
    ['a waiting ask too', ask([item({ state: 'needs_you' })], 'waiting'), true],
    ['an ask settled meanwhile', ask([item()], 'achieved'), false],
    ['an ask whose checked items are met', ask([item({ state: 'met' })]), false],
    ['an ask with only unchecked items', ask([item({ check: null })]), false],
    ['an ask gone', null, false],
  ])('%s', (_label, current, tickable) => {
    expect(requireNeoPackTickable({ ask: current })).toEqual(
      tickable ? { value: current } : { reason: null }
    );
  });
});

describe('readNeoCardPrs', () => {
  const url = 'https://github.com/lsm/HyperNeo/pull/1';
  const open: NeoWorkPr = { url, state: 'OPEN', checks: 'pending', review: 'none' };
  const stored = {
    workId: 'w1',
    prs: [open],
    revision: 1,
    readAt: 0,
    readOkAt: 0,
  } as NeoWorkPrRow;
  const work = { id: 'w1', report: `Opened ${url}.` } as NeoWork;
  const harness = (read: NeoWorkPr[] | null) => {
    const calls = { reads: 0, failed: [] as number[], recorded: [] as NeoWorkPr[][] };
    return {
      calls,
      deps: {
        readPrs: async () => {
          calls.reads++;
          return read;
        },
        prCandidates: async () => [{ url, claim: 'mentioned' as const }],
        claims: {
          forUrls: () => [
            {
              workId: 'w1',
              urlKey: url.toLowerCase(),
              claim: 'mentioned' as const,
              claimedAt: 0,
              cardCreatedAt: 0,
              score: 1,
            },
          ],
          replace: () => {},
          drop: () => {},
        },
        workPrs: {
          get: () => stored,
          list: () => [],
          recordFailedRead: (_id: string, at: number) => calls.failed.push(at),
        },
        record: (_id: string, prs: readonly NeoWorkPr[]) => {
          calls.recorded.push([...prs]);
          return { ...stored, prs: [...prs], revision: 2, readAt: 5, readOkAt: 5 };
        },
      },
    };
  };

  test('skips a read the card made moments ago', async () => {
    const { deps, calls } = harness([open]);
    expect(await readNeoCardPrs(deps, work, { ...stored, readAt: 10, readOkAt: 10 }, 20)).toEqual({
      row: { ...stored, readAt: 10, readOkAt: 10 },
      ok: true,
    });
    expect(calls.reads).toBe(0);
  });

  test('records a fresh read, or marks a failed one and keeps what was stored', async () => {
    const merged: NeoWorkPr = { ...open, state: 'MERGED' };
    const fresh = harness([merged]);
    expect(await readNeoCardPrs(fresh.deps, work, stored, 10 * 60_000)).toMatchObject({
      row: { prs: [merged] },
      ok: true,
    });
    const failed = harness(null);
    expect(await readNeoCardPrs(failed.deps, work, stored, 10 * 60_000)).toEqual({
      row: stored,
      ok: false,
    });
    expect(failed.calls.failed).toEqual([10 * 60_000]);
  });

  test('keeps a stored PR a partial read missed without claiming it', async () => {
    const second = 'https://github.com/lsm/HyperNeo/pull/2';
    const replaced: { url: string; claim: string }[][] = [];
    const recorded: NeoWorkPr[][] = [];
    const { deps } = harness(null);
    const result = await readNeoCardPrs(
      {
        ...deps,
        readPrs: async () => [{ ...open, url: second, createdAt: 50 }],
        prCandidates: async () => [
          { url, claim: 'mentioned' as const },
          { url: second, claim: 'mentioned' as const },
        ],
        claims: {
          forUrls: () => [],
          replace: (_id: string, claims: readonly { url: string; claim: string }[]) =>
            replaced.push([...claims]),
          drop: () => {},
        },
        record: (_id: string, prs: readonly NeoWorkPr[]) => {
          recorded.push([...prs]);
          return { ...stored, prs: [...prs] };
        },
      },
      { ...work, createdAt: 10 } as NeoWork,
      stored,
      10 * 60_000
    );
    expect(replaced.at(-1)?.map((claim) => [claim.url, claim.claim])).toEqual([
      [second, 'mentioned'],
    ]);
    expect(recorded.at(-1)?.map((pr) => pr.url)).toEqual([second, url]);
    expect(result.ok).toBe(true);
  });
});

describe('neoCardPrsFresh', () => {
  const url = 'https://github.com/lsm/HyperNeo/pull/1';
  const row = {
    workId: 'w1',
    prs: [{ url, state: 'OPEN', checks: 'pending', review: 'none' }],
    revision: 1,
    delivered: null,
    deliveredAt: null,
    reminded: null,
    readAt: 10,
    readOkAt: 10,
  } as NeoWorkPrRow;
  const owned = (claimed: boolean) => ({
    owned: [{ url, claim: 'mentioned' as const, claimedAt: 0, claimed, score: 1 }],
  });

  test.each([
    ['a claimed PR read moments ago', row, owned(true), 20, false, true],
    ['an owned PR not yet claimed', row, owned(false), 20, false, false],
    ['a read that has gone stale', row, owned(true), 10 * 60_000, false, false],
    ['a card with no stored read', null, owned(true), 20, false, false],
    ['a forced read', row, owned(true), 20, true, false],
    [
      'an unscored mention outside the startup pass',
      row,
      { owned: [{ url, claim: 'mentioned' as const, claimedAt: 0, claimed: true, score: null }] },
      20,
      false,
      true,
    ],
  ])('%s', (_name, stored, plan, now, force, fresh) => {
    expect(neoCardPrsFresh({ row: stored }, plan, now, force)).toBe(fresh);
  });
});

describe('cachedNeoCardPrRead', () => {
  test('a cached read is ok unless the last read failed', () => {
    const row = {
      workId: 'w1',
      prs: [],
      revision: 1,
      delivered: null,
      deliveredAt: null,
      reminded: null,
      readAt: 10,
      readOkAt: 10,
    } as NeoWorkPrRow;
    expect(cachedNeoCardPrRead(row)).toEqual({ row, ok: true });
    expect(cachedNeoCardPrRead({ ...row, readAt: 20 })).toEqual({
      row: { ...row, readAt: 20 },
      ok: false,
    });
    expect(cachedNeoCardPrRead(null)).toEqual({ row: null, ok: true });
  });
});

describe('neoPackAskCardEvidence', () => {
  const pr = 'https://github.com/lsm/HyperNeo/pull/42';
  const works = [
    {
      id: 'w1',
      status: 'reported',
      report: 'Confirmation: id=<msg-1>; from=orders@amazon.com',
      createdAt: 0,
    },
  ] as NeoWork[];
  const packs = [
    createCodingPack({
      readPrs: async () => [],
      prCandidates: async () => [],
      claims: { forUrls: () => [], replace: () => {}, drop: () => {} },
      runningPrUrls: async () => [],
      cardReports: () => [],
      readRefStates: async () => [],
      workPrs: {
        get: () => null,
        list: () =>
          [{ workId: 'w1', prs: [{ url: pr, state: 'MERGED' }] }] as unknown as NeoWorkPrRow[],
        recordFailedRead: () => {},
      },
      record: () => null,
    }),
    createLifeAdminPack(),
  ];
  const keys = (pack: string | null) =>
    neoPackAskCardEvidence(packs, { pack, workIds: ['w1'] } as NeoAsk, works).map(
      (item) => item.key
    );

  test('a packed ask reads only its own pack card evidence', () => {
    expect(keys('coding')).toEqual([pr]);
    expect(keys('life-admin')).toEqual(['confirmation:<msg-1>']);
    expect(keys(null)).toEqual([pr, 'confirmation:<msg-1>']);
  });
});

describe('requireNeoEvidenceRefresh', () => {
  const refresh = (
    overrides: Partial<{ status: string; report: string | null; updatedAt: number }> = {}
  ) => ({
    work: { status: 'reported', report: 'the work', updatedAt: 5 * 60_000, ...overrides },
  });
  const due = { readAt: 0 };
  const fresh = { readAt: 19 * 60_000 };

  test.each<[string, ReturnType<typeof refresh>, object, unknown]>([
    [
      'a due pull request row',
      refresh(),
      { goal: true, session: true, row: due, packEvidence: false, toldAt: null },
      { value: expect.objectContaining({ row: due }) },
    ],
    [
      'a card whose ask pack reads evidence, with no pull request row',
      refresh(),
      { goal: true, session: true, row: null, packEvidence: true, toldAt: null },
      { value: expect.objectContaining({ row: null }) },
    ],
    [
      'a pack card told recently whose report has not changed',
      refresh(),
      { goal: true, session: true, row: null, packEvidence: true, toldAt: 19 * 60_000 },
      { reason: 'not_due' },
    ],
    [
      'a pack card whose report changed after it was told',
      refresh({ updatedAt: 21 * 60_000 }),
      { goal: true, session: true, row: null, packEvidence: true, toldAt: 19 * 60_000 },
      { value: expect.objectContaining({ row: null }) },
    ],
    [
      'a card with neither a row nor an evidence-reading pack',
      refresh(),
      { goal: true, session: true, row: null, packEvidence: false, toldAt: null },
      { reason: 'not_due' },
    ],
    [
      'a pack card without a goal',
      refresh(),
      { goal: false, session: true, row: null, packEvidence: true, toldAt: null },
      { reason: 'not_due' },
    ],
    [
      'a pack card whose origin session is gone',
      refresh(),
      { goal: true, session: false, row: null, packEvidence: true, toldAt: null },
      { reason: 'not_due' },
    ],
    [
      'a pack card still working',
      refresh({ status: 'queued' }),
      { goal: true, session: true, row: null, packEvidence: true, toldAt: null },
      { reason: 'not_due' },
    ],
    [
      'a row not yet due with no evidence-reading pack',
      refresh(),
      { goal: true, session: true, row: fresh, packEvidence: false, toldAt: null },
      { reason: 'not_due' },
    ],
  ])('admits %s', (_label, current, card, gate) => {
    expect(requireNeoEvidenceRefresh(current, card as never, 20 * 60_000, 'closed: done')).toEqual(
      gate
    );
  });
});

describe('neoPackEvidenceOrNone', () => {
  test('stands in an empty read unless a pack failed to read the card', () => {
    const read = { evidence: [], read: { ok: false, okAt: 1 } };
    expect(neoPackEvidenceOrNone(read, true, 50)).toBe(read);
    expect(neoPackEvidenceOrNone(null, true, 50)).toBe(null);
    expect(neoPackEvidenceOrNone(null, false, 50)).toEqual({
      evidence: [],
      read: { ok: true, okAt: 50 },
    });
  });
});
