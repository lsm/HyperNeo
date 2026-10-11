import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import {
  beatsNeoPrClaim,
  keepNeoCardPrReads,
  planNeoCardPrCandidates,
  planNeoCardPrOwnership,
  type NeoPrClaimRow,
} from '../../../../src/lib/neo/packs/coding/card-pr-claims.ts';
import { NeoWorkPrClaimRepository } from '../../../../src/lib/neo/packs/coding/neo-work-pr-claim-repository.ts';
import { readNeoCardPrs } from '../../../../src/lib/neo/packs/coding/pack.ts';
import type { NeoWorkPrRow } from '../../../../src/lib/neo/packs/coding/neo-work-pr-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

const pull = (n: number) => `https://github.com/lsm/HyperNeo/pull/${n}`;
const claim = (overrides: Partial<NeoPrClaimRow>): NeoPrClaimRow => ({
  workId: 'other',
  urlKey: pull(1).toLowerCase(),
  claim: 'mentioned',
  claimedAt: 100,
  cardCreatedAt: 10,
  ...overrides,
});
const pr = (n: number, createdAt?: number): NeoWorkPr => ({
  url: pull(n),
  state: 'OPEN',
  checks: 'passing',
  review: 'none',
  ...(createdAt === undefined ? {} : { createdAt }),
});

describe('planNeoCardPrCandidates', () => {
  test('marks branch PRs, PRs the brief names, and PRs only the report mentions', () => {
    expect(
      planNeoCardPrCandidates({
        report: `Opened ${pull(1)}; see also ${pull(2)} and ${pull(3)}.`,
        brief: `Address the review on ${pull(2)}.`,
        branch: [pull(1).toUpperCase()],
        stored: [{ url: pull(4) }],
      })
    ).toEqual([
      { url: pull(4), claim: 'mentioned' },
      { url: pull(2), claim: 'named' },
      { url: pull(1), claim: 'branch' },
      { url: pull(3), claim: 'mentioned' },
    ]);
  });
});

describe('beatsNeoPrClaim', () => {
  const mention = { claim: 'mentioned' as const, claimedAt: 100, cardCreatedAt: 10 };
  test.each<[string, Partial<NeoPrClaimRow>, Partial<NeoPrClaimRow>, boolean]>([
    ['a branch claim beats a mention', { claim: 'branch', claimedAt: 500 }, {}, true],
    ['a named claim beats a mention', { claim: 'named', claimedAt: 500 }, {}, true],
    ['an earlier mention beats a later one', { claimedAt: 50 }, {}, true],
    ['a later mention does not', { claimedAt: 150 }, {}, false],
    ['a same-time mention from an older card does', { cardCreatedAt: 5 }, {}, true],
    [
      'two branch claims go to the older card',
      { claim: 'branch', cardCreatedAt: 5 },
      { claim: 'branch' },
      true,
    ],
    ['a mention never beats a named claim', { claimedAt: 1 }, { claim: 'named' }, false],
  ])('%s', (_label, rival, own, beats) => {
    expect(beatsNeoPrClaim({ ...mention, ...rival }, { ...mention, ...own })).toBe(beats);
  });
});

describe('planNeoCardPrOwnership', () => {
  const card = { id: 'me', createdAt: 20 } as Pick<NeoWork, 'id' | 'createdAt'>;
  test('two cards that mention both PRs keep only the one on their own branch', () => {
    const rivals = [claim({ urlKey: pull(2).toLowerCase(), claim: 'branch' })];
    expect(
      planNeoCardPrOwnership(
        card,
        [
          { url: pull(1), claim: 'branch' },
          { url: pull(2), claim: 'mentioned' },
        ],
        rivals,
        300
      )
    ).toEqual([{ url: pull(1), claim: 'branch', claimedAt: 300, claimed: false }]);
  });

  test('keeps its own earlier claim, at its strongest, against a later mention', () => {
    const rows = [
      claim({ workId: 'me', claim: 'branch', claimedAt: 40 }),
      claim({ claimedAt: 60, cardCreatedAt: 5 }),
    ];
    expect(planNeoCardPrOwnership(card, [{ url: pull(1), claim: 'mentioned' }], rows, 300)).toEqual(
      [{ url: pull(1), claim: 'branch', claimedAt: 40, claimed: true }]
    );
  });
});

describe('keepNeoCardPrReads', () => {
  const card = { createdAt: 100 } as Pick<NeoWork, 'createdAt'>;
  const owned = (n: number, overrides = {}) => ({
    url: pull(n),
    claim: 'mentioned' as const,
    claimedAt: 200,
    claimed: false,
    ...overrides,
  });
  test('a new mention stays only if the PR was opened after the card started', () => {
    expect(
      keepNeoCardPrReads(
        card,
        [
          owned(1),
          owned(2),
          owned(3),
          owned(4),
          owned(5, { claim: 'named' }),
          owned(6, { claimed: true }),
        ],
        [pr(1, 50), pr(2, 150), pr(3), pr(5, 50), pr(6, 50)]
      ).map((item) => item.url)
    ).toEqual([pull(2), pull(3), pull(5), pull(6)]);
  });
});

describe('NeoWorkPrClaimRepository', () => {
  test('replaces one card’s claims and lists every card’s claims on a PR', async () => {
    const db = await createTestDb();
    try {
      const raw = db.getDatabase();
      for (const [id, at] of [
        ['a', 10],
        ['b', 20],
      ] as const)
        raw
          .prepare(
            `INSERT INTO neo_work(id, request_key, origin_session_id, title, instruction, status, created_at, updated_at)
             VALUES (?, ?, 'root', 'T', 'I', 'queued', ?, ?)`
          )
          .run(id, `key-${id}`, at, at);
      const repo = new NeoWorkPrClaimRepository(raw);
      repo.replace('a', [
        { url: pull(1), claim: 'branch', claimedAt: 1 },
        { url: pull(2), claim: 'mentioned', claimedAt: 2 },
      ]);
      repo.replace('b', [{ url: pull(2).toUpperCase(), claim: 'mentioned', claimedAt: 3 }]);
      repo.replace('a', [{ url: pull(1), claim: 'branch', claimedAt: 9 }]);
      expect(repo.forUrls([pull(1), pull(2)])).toEqual(
        expect.arrayContaining([
          {
            workId: 'a',
            urlKey: pull(1).toLowerCase(),
            claim: 'branch',
            claimedAt: 1,
            cardCreatedAt: 10,
          },
          {
            workId: 'b',
            urlKey: pull(2).toLowerCase(),
            claim: 'mentioned',
            claimedAt: 3,
            cardCreatedAt: 20,
          },
        ])
      );
      expect(repo.forUrls([pull(1), pull(2)])).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

describe('readNeoCardPrs', () => {
  test('drops a stored PR another card owns without reading it again', async () => {
    const stored = {
      workId: 'me',
      prs: [pr(1), pr(2)],
      revision: 1,
      delivered: null,
      deliveredAt: null,
      reminded: null,
      readAt: 1_000,
      readOkAt: 1_000,
    } as NeoWorkPrRow;
    const recorded: NeoWorkPr[][] = [];
    const replaced: unknown[] = [];
    let reads = 0;
    const result = await readNeoCardPrs(
      {
        readPrs: async () => {
          reads++;
          return [];
        },
        prCandidates: async () => [
          { url: pull(1), claim: 'mentioned' },
          { url: pull(2), claim: 'mentioned' },
        ],
        claims: {
          forUrls: () => [
            claim({ workId: 'me', urlKey: pull(1).toLowerCase(), claimedAt: 5 }),
            claim({ workId: 'me', urlKey: pull(2).toLowerCase(), claimedAt: 5 }),
            claim({ urlKey: pull(2).toLowerCase(), claim: 'branch' }),
          ],
          replace: (_id, claims) => replaced.push(claims),
        },
        workPrs: { get: () => stored, list: () => [], recordFailedRead: () => {} },
        record: (_id, prs) => {
          recorded.push([...prs]);
          return { ...stored, prs: [...prs], revision: 2 };
        },
      },
      { id: 'me', createdAt: 0, report: null } as NeoWork,
      stored,
      1_100
    );
    expect(reads).toBe(0);
    expect(recorded).toEqual([[pr(1)]]);
    expect(replaced).toEqual([[{ url: pull(1), claim: 'mentioned', claimedAt: 5, claimed: true }]]);
    expect(result).toEqual({ row: { ...stored, prs: [pr(1)], revision: 2 }, ok: true });
  });
});
