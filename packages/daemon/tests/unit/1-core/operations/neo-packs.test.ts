import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import type { NeoWorkPrRow } from '../../../../src/lib/neo/packs/coding/neo-work-pr-repository.ts';
import {
  NEO_DEFAULT_PACKS,
  neoPacks,
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
