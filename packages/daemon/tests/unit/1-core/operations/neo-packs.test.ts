import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoEvidence } from '../../../../src/lib/neo/evidence.ts';
import {
  codingPrMergedCheck,
  createCodingPack,
} from '../../../../src/lib/neo/packs/coding/pack.ts';
import type { NeoWorkPrRow } from '../../../../src/lib/neo/packs/coding/neo-work-pr-repository.ts';
import {
  NEO_DEFAULT_PACKS,
  neoPackChecks,
  neoPacks,
  planNeoPackTicks,
  readNeoPackEvidence,
} from '../../../../src/lib/neo/packs/index.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';

const pack = (id: string, describe = id): NeoPack => ({ id, describe, instructions: () => null });

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
    delivered: null,
    deliveredAt: null,
    reminded: null,
    readAt: readOkAt,
    readOkAt,
  });
  const work = (report: string | null) => ({ id: 'w1', report }) as NeoWork;
  const setup = (stored: NeoWorkPrRow | null, read: NeoWorkPr[] | null) => {
    const failed: number[] = [];
    const recorded: NeoWorkPr[][] = [];
    const coding = createCodingPack({
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

const merged: NeoEvidence = { key: 'pr/1', state: 'done', summary: 'merged', blockers: [] };
const open: NeoEvidence = { ...merged, key: 'pr/2', state: 'pending', summary: 'open' };
const item = (overrides: Partial<NeoAskItem> = {}): NeoAskItem => ({
  id: 'i1',
  text: 'Fix merged to dev',
  state: 'pending',
  evidence: null,
  check: 'pr_merged',
  metBy: null,
  removed: false,
  addedAt: null,
  ...overrides,
});

describe('codingPrMergedCheck', () => {
  test.each<[string, NeoEvidence[], ReturnType<typeof codingPrMergedCheck>]>([
    ['every tracked pull request merged', [merged], { value: 'Merged: pr/1' }],
    ['one still open', [merged, open], { reason: 'not_merged' }],
    ['no pull requests', [], { reason: 'not_merged' }],
  ])('%s', (_label, evidence, gate) => {
    expect(codingPrMergedCheck(item(), evidence)).toEqual(gate);
  });
});

describe('neoPackChecks', () => {
  test('takes each kind from the first pack that defines it', () => {
    const first = () => ({ value: 'first' });
    const second = () => ({ value: 'second' });
    const checks = neoPackChecks([
      { ...pack('coding'), checks: { pr_merged: first } },
      { ...pack('other'), checks: { pr_merged: second, filed: second } },
    ]);
    expect(checks).toEqual({ pr_merged: first, filed: second });
  });
});

describe('planNeoPackTicks', () => {
  const ask = (items: NeoAskItem[], status: NeoAsk['status'] = 'open') =>
    ({ id: 'a1', status, doneItems: items }) as NeoAsk;
  const checks = { pr_merged: codingPrMergedCheck };
  test.each<[string, NeoAsk | null, NeoEvidence[], ReturnType<typeof planNeoPackTicks>]>([
    [
      'a merged item on a live ask',
      ask([item()]),
      [merged],
      [{ id: 'i1', evidence: 'Merged: pr/1' }],
    ],
    [
      'a waiting ask too',
      ask([item()], 'waiting'),
      [merged],
      [{ id: 'i1', evidence: 'Merged: pr/1' }],
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
