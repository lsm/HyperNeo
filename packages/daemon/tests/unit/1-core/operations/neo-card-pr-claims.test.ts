import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import {
  beatsNeoPrClaim,
  hasNeoUnattachedOpenedPrs,
  keepNeoCardPrReads,
  neoCardOpenedPrs,
  neoCardPrWindow,
  keepNeoUnbeatenPrs,
  neoPrMatchScore,
  planNeoCardPrCandidates,
  planNeoCardPrOwnership,
  planNeoPrCedes,
  scoreNeoCardPrs,
  type NeoPrClaim,
  type NeoPrClaimRow,
} from '../../../../src/lib/neo/packs/coding/card-pr-claims.ts';
import { NeoWorkPrClaimRepository } from '../../../../src/lib/neo/packs/coding/neo-work-pr-claim-repository.ts';
import { readNeoCardPrs } from '../../../../src/lib/neo/packs/coding/pack.ts';
import {
  NeoWorkPrRepository,
  type NeoWorkPrRow,
} from '../../../../src/lib/neo/packs/coding/neo-work-pr-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { runMigration380 } from '../../../../src/storage/schema/m380-neo-work-follows.ts';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat.ts';

const pull = (n: number) => `https://github.com/lsm/HyperNeo/pull/${n}`;
const claim = (overrides: Partial<NeoPrClaimRow>): NeoPrClaimRow => ({
  workId: 'other',
  urlKey: pull(1).toLowerCase(),
  claim: 'mentioned',
  claimedAt: 100,
  cardCreatedAt: 10,
  score: 1,
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
  test('keeps report-named PRs explicit alongside follows and inferred stored PRs', () => {
    expect(
      planNeoCardPrCandidates({
        report: `Opened ${pull(1)}; see also ${pull(2)} and ${pull(3)}.`,
        follows: pull(2),
        branch: [pull(1).toUpperCase()],
        stored: [{ url: pull(4) }],
      })
    ).toEqual([
      { url: pull(2), claim: 'named' },
      { url: pull(1), claim: 'named' },
      { url: pull(3), claim: 'named' },
      { url: pull(4), claim: 'mentioned' },
    ]);
  });
});

describe('report candidates with legacy rejections', () => {
  test('includes report PRs even when the stored legacy candidates fill their read batch', () => {
    const candidates = planNeoCardPrCandidates({
      report: pull(102),
      branch: [],
      stored: Array.from({ length: 9 }, (_, index) => ({ url: pull(index + 1) })),
      window: { start: 10, end: 20 },
    });
    expect(candidates[0]).toMatchObject({ url: pull(102), claim: 'named' });
  });
});

describe('planNeoCardPrCandidates with resolved refs', () => {
  test('a PR the report cites by number is named', () => {
    expect(
      planNeoCardPrCandidates({
        report: 'CI on #6440.',
        branch: [],
        stored: [],
        mentioned: [pull(6440)],
      })
    ).toEqual([{ url: pull(6440), claim: 'named' }]);
  });
});

describe('neoPrMatchScore', () => {
  const startup = {
    title: 'fix(desktop): get past the startup splash',
    branch: 'fix/desktop-startup-daemon-attach',
  };
  test.each<[string, string, { title?: string; branch?: string }, number]>([
    ['counts words the card and the PR share', 'Desktop startup hangs', startup, 2],
    ['ignores case, plurals and punctuation', 'DESKTOP Icons!', { title: 'desktop icon' }, 2],
    [
      'scores one for a single shared word, so two cards with it tie',
      'desktop app',
      { title: 'desktop thing' },
      1,
    ],
    ['gives an all-filler title nothing', 'fix the chore', { title: 'fix: the chore for this' }, 0],
    ['gives a PR without a title or branch nothing', 'Desktop startup', {}, 0],
  ])('%s', (_label, card, pr, score) => {
    expect(neoPrMatchScore(card, pr)).toBe(score);
  });
});

describe('scoreNeoCardPrs', () => {
  test('scores only mentions this read fetched, keeping earlier scores otherwise', () => {
    const card = { title: 'Desktop icons', instruction: 'Refresh the icons.' };
    const item = (n: number, overrides = {}) => ({
      url: pull(n),
      claim: 'mentioned' as const,
      claimedAt: 1,
      claimed: false,
      score: null,
      ...overrides,
    });
    expect(
      scoreNeoCardPrs(
        card,
        [item(1), item(2, { claim: 'branch' }), item(3, { score: 4 })],
        [
          { ...pr(1), title: 'Regenerate desktop icons' },
          { ...pr(2), title: 'Desktop icons' },
        ]
      ).map((owned) => owned.score)
    ).toEqual([2, null, 4]);
  });
});

describe('beatsNeoPrClaim', () => {
  const mention = { claim: 'mentioned' as const, claimedAt: 100, cardCreatedAt: 10, score: 1 };
  type Ranked = Partial<{
    claim: NeoPrClaim;
    claimedAt: number;
    cardCreatedAt: number;
    score: number | null;
  }>;
  test.each<[string, Ranked, Ranked, boolean]>([
    ['a branch claim beats a mention', { claim: 'branch', claimedAt: 500 }, {}, true],
    ['a named claim beats a mention', { claim: 'named', claimedAt: 500 }, {}, true],
    ['an earlier mention beats a later one', { claimedAt: 50 }, {}, true],
    ['a later mention does not', { claimedAt: 150 }, {}, false],
    ['a better-matching mention beats an earlier one', { claimedAt: 150, score: 2 }, {}, true],
    ['a worse-matching mention loses even when earlier', { claimedAt: 50, score: 0 }, {}, false],
    ['an unscored mention beats no mention', { claimedAt: 50, score: null }, {}, false],
    ['a mention not yet scored is not beaten', { claimedAt: 50 }, { score: null }, false],
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

describe('keepNeoUnbeatenPrs', () => {
  const card = { id: 'me', createdAt: 20 };
  const mention = {
    url: pull(2),
    claim: 'mentioned' as const,
    claimedAt: 100,
    claimed: false,
    score: 1,
  };
  const key = pull(2).toLowerCase();
  test.each<[string, NeoPrClaimRow[], number]>([
    ['no rival', [], 1],
    ['a rival branch claim beats a mention', [claim({ urlKey: key, claim: 'branch' })], 0],
    ['a later rival mention does not', [claim({ urlKey: key, claimedAt: 200 })], 1],
    [
      'a later rival that matches better does',
      [claim({ urlKey: key, claimedAt: 200, score: 3 })],
      0,
    ],
    ['a rival rejection does not', [claim({ urlKey: key, claim: 'rejected' })], 1],
    ['my own row is not a rival', [claim({ workId: 'me', urlKey: key, claim: 'branch' })], 1],
  ])('%s', (_label, claims, kept) => {
    const { owned, beaten } = keepNeoUnbeatenPrs(card, [mention], claims);
    expect([owned.length, beaten.length]).toEqual([kept, 1 - kept]);
  });
});

describe('planNeoPrCedes', () => {
  const key = pull(2).toLowerCase();
  const mine = claim({ workId: 'me', urlKey: key, claim: 'branch', cardCreatedAt: 20 });
  test.each<[string, NeoPrClaimRow[], string[]]>([
    ['a weaker claim elsewhere is ceded', [mine, claim({ urlKey: key })], ['other']],
    [
      'a stronger claim elsewhere is kept',
      [{ ...mine, claim: 'mentioned' }, claim({ urlKey: key, claim: 'branch' })],
      [],
    ],
    ['a rejection elsewhere is left alone', [mine, claim({ urlKey: key, claim: 'rejected' })], []],
    ['a claim on another PR is left alone', [mine, claim({})], []],
    [
      'nothing is ceded to a rejection of my own',
      [{ ...mine, claim: 'rejected' }, claim({ urlKey: key })],
      [],
    ],
  ])('%s', (_label, claims, ceded) => {
    expect(planNeoPrCedes({ id: 'me' }, claims).map((row) => row.workId)).toEqual(ceded);
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
    ).toEqual([{ url: pull(1), claim: 'branch', claimedAt: 300, claimed: false, score: null }]);
  });

  test('a mention it rejected before stays rejected unless the brief or branch now claims it', () => {
    const rows = [claim({ workId: 'me', claim: 'rejected', claimedAt: 40 })];
    expect(planNeoCardPrOwnership(card, [{ url: pull(1), claim: 'mentioned' }], rows, 300)).toEqual(
      []
    );
    expect(planNeoCardPrOwnership(card, [{ url: pull(1), claim: 'named' }], rows, 300)).toEqual([
      { url: pull(1), claim: 'named', claimedAt: 300, claimed: false, score: null },
    ]);
  });

  test('another card’s rejected mention is no claim at all', () => {
    const rows = [claim({ claim: 'rejected', claimedAt: 1 })];
    expect(planNeoCardPrOwnership(card, [{ url: pull(1), claim: 'mentioned' }], rows, 300)).toEqual(
      [{ url: pull(1), claim: 'mentioned', claimedAt: 300, claimed: false, score: null }]
    );
  });

  test('keeps its own earlier claim, at its strongest, against a later mention', () => {
    const rows = [
      claim({ workId: 'me', claim: 'branch', claimedAt: 40 }),
      claim({ claimedAt: 60, cardCreatedAt: 5 }),
    ];
    expect(planNeoCardPrOwnership(card, [{ url: pull(1), claim: 'mentioned' }], rows, 300)).toEqual(
      [{ url: pull(1), claim: 'branch', claimedAt: 40, claimed: true, score: 1 }]
    );
  });
});

describe('keepNeoCardPrReads', () => {
  const card: Pick<NeoWork, 'createdAt' | 'title' | 'instruction'> = {
    createdAt: 100,
    title: 'Fix it',
    instruction: 'Fix the bug.',
  };
  const owned = (n: number, overrides = {}) => ({
    url: pull(n),
    claim: 'mentioned' as const,
    claimedAt: 200,
    claimed: false,
    score: null,
    ...overrides,
  });
  test('a new mention of a finished PR stays only if the PR was opened after the card started', () => {
    const sorted = keepNeoCardPrReads(
      card,
      [
        owned(1),
        owned(2),
        owned(3),
        owned(4),
        owned(5, { claim: 'named' }),
        owned(6, { claimed: true }),
      ],
      [{ ...pr(1, 50), state: 'MERGED' }, pr(2, 150), pr(3), pr(5, 50), pr(6, 50)]
    );
    const urls = (items: { url: string }[]) => items.map((item) => item.url);
    expect(urls(sorted.kept)).toEqual([pull(2), pull(3), pull(5), pull(6)]);
    expect(urls(sorted.rejected)).toEqual([pull(1)]);
    expect(urls(sorted.pending)).toEqual([pull(4)]);
  });

  test('an open PR the report names stays even when the session opened it before the card', () => {
    const merged = { ...pr(1, 50), state: 'MERGED' as const };
    const closed = { ...pr(3, 50), state: 'CLOSED' as const };
    const sorted = keepNeoCardPrReads(
      card,
      [owned(1), owned(2), owned(3)],
      [merged, pr(2, 50), closed]
    );
    expect(sorted.kept.map((item) => item.url)).toEqual([pull(2)]);
    expect(sorted.rejected.map((item) => item.url)).toEqual([pull(1), pull(3)]);
  });

  test('a card that names its issue keeps only the mentioned PRs that refer to it, even ones it claimed before', () => {
    const named = { createdAt: 100, title: 'Drive #6587', instruction: 'Finish #6587.' } as Pick<
      NeoWork,
      'createdAt' | 'title' | 'instruction'
    >;
    const sorted = keepNeoCardPrReads(
      named,
      [owned(6607), owned(6624), owned(6601, { claimed: true }), owned(6626, { claim: 'named' })],
      [
        { ...pr(6607, 150), refs: [6587, 6002] },
        { ...pr(6624, 150), refs: [6610] },
        { ...pr(6601, 150), refs: [6596] },
      ]
    );
    expect(sorted.kept.map((item) => item.url)).toEqual([pull(6607), pull(6626)]);
    expect(sorted.rejected.map((item) => item.url)).toEqual([pull(6624), pull(6601)]);
  });

  test('a PR the card names by its own number, or one that names no issue, is related', () => {
    const named = { createdAt: 100, title: 'Land #6632', instruction: 'Merge it.' } as Pick<
      NeoWork,
      'createdAt' | 'title' | 'instruction'
    >;
    const sorted = keepNeoCardPrReads(
      named,
      [owned(6632), owned(6640), owned(6641)],
      [{ ...pr(6632, 150), refs: [6002] }, pr(6640, 150), { ...pr(6641, 150), refs: [6610] }]
    );
    expect(sorted.kept.map((item) => item.url)).toEqual([pull(6632), pull(6640)]);
    expect(sorted.rejected.map((item) => item.url)).toEqual([pull(6641)]);
  });

  test('a new mention this read could not fetch stays unclaimed until a read dates it', () => {
    const sorted = keepNeoCardPrReads(card, [owned(4), owned(1)], [pr(1, 150)]);
    expect(sorted.kept.map((item) => item.url)).toEqual([pull(1)]);
    expect(sorted.pending.map((item) => item.url)).toEqual([pull(4)]);
  });
});

describe('PRs the worker session opened', () => {
  const card = { id: 'me', createdAt: 100, title: 'Fix it', instruction: 'Fix it.' };

  test('count as the worker’s own claim, newest first', () => {
    expect(
      planNeoCardPrCandidates({
        report: `Opened ${pull(9)}.`,
        branch: [],
        opened: [pull(7), pull(8), pull(9)],
        stored: [],
      })
    ).toEqual([
      { url: pull(9), claim: 'named' },
      { url: pull(8), claim: 'opened' },
      { url: pull(7), claim: 'opened' },
    ]);
    expect(
      planNeoCardPrCandidates({
        report: null,
        branch: [],
        opened: [pull(5), pull(6), pull(7)],
        stored: [],
      }).map((item) => item.url)
    ).toEqual([pull(7), pull(6), pull(5)]);
    expect(neoCardOpenedPrs(Array.from({ length: 10 }, (_, n) => pull(n + 1)))).toEqual(
      [10, 9, 8, 7, 6, 5, 4, 3].map(pull)
    );
  });

  test('attach while open, and an old finished one from before the card is rejected for good', () => {
    const opened = (n: number) => ({
      url: pull(n),
      claim: 'opened' as const,
      claimedAt: 200,
      claimed: false,
      score: null,
    });
    const sorted = keepNeoCardPrReads(
      card,
      [opened(1), opened(2), opened(3)],
      [pr(1, 50), { ...pr(2, 50), state: 'MERGED' }, { ...pr(3, 150), state: 'MERGED' }]
    );
    expect(sorted.kept.map((item) => item.url)).toEqual([pull(1), pull(3)]);
    expect(sorted.rejected.map((item) => item.url)).toEqual([pull(2)]);
    const rows = [claim({ workId: 'me', urlKey: pull(2).toLowerCase(), claim: 'rejected' })];
    expect(planNeoCardPrOwnership(card, [{ url: pull(2), claim: 'opened' }], rows, 300)).toEqual(
      []
    );
  });

  test('one the card follows stays named, so an old merged one still attaches', () => {
    const [candidate] = planNeoCardPrCandidates({
      report: null,
      follows: pull(4),
      branch: [],
      opened: [pull(4)],
      stored: [],
    });
    expect(candidate).toEqual({ url: pull(4), claim: 'named' });
    const owned = { ...candidate, claimedAt: 200, claimed: false, score: null };
    expect(
      keepNeoCardPrReads(card, [owned], [{ ...pr(4, 50), state: 'MERGED' }]).kept
    ).toHaveLength(1);
  });

  test('are read again only when one is not on the card yet', () => {
    expect(hasNeoUnattachedOpenedPrs([pull(1)], [{ url: pull(1).toUpperCase() }])).toBe(false);
    expect(hasNeoUnattachedOpenedPrs([pull(1), pull(2)], [{ url: pull(1) }])).toBe(true);
    expect(hasNeoUnattachedOpenedPrs([], [])).toBe(false);
  });
});

describe('a PR its worker session subscribes to', () => {
  test('is named by the card like its follow, once', () => {
    const candidates = planNeoCardPrCandidates({
      window: { start: 0, end: null },
      report: null,
      follows: pull(5),
      subscribed: [pull(5), pull(6)],
      branch: [],
      stored: [],
    });
    expect(candidates.map((item) => [item.url, item.claim])).toEqual([
      [pull(5), 'named'],
      [pull(6), 'named'],
    ]);
  });

  test('stays named once its subscription ends and only the stored PR names it', () => {
    const card = { id: 'card', createdAt: 100, title: 'Ship', instruction: 'Ship it' };
    const scope = { window: { start: 0, end: null }, onBranch: false };
    const owned = planNeoCardPrOwnership(
      card,
      [{ url: pull(5), claim: 'mentioned', scope }],
      [claim({ workId: 'card', urlKey: pull(5).toLowerCase(), claim: 'named' })],
      300
    );
    expect(owned.map((item) => item.claim)).toEqual(['named']);
    expect(keepNeoCardPrReads(card, owned, [pr(5)]).kept.map((item) => item.url)).toEqual([
      pull(5),
    ]);
  });
});

describe('a PR the card follows', () => {
  const follower = { id: 'follow-up', createdAt: 300 };
  const opener = {
    workId: 'opener',
    urlKey: pull(5).toLowerCase(),
    claim: 'branch' as const,
    claimedAt: 100,
    cardCreatedAt: 100,
    score: null,
    scoped: true,
  };

  test('is kept by a later card while the card that opened it keeps its own claim', () => {
    const candidates = planNeoCardPrCandidates({
      report: null,
      follows: pull(5),
      branch: [],
      stored: [],
    });
    const owned = planNeoCardPrOwnership(follower, candidates, [opener], 400);
    expect(owned.map((item) => [item.url, item.claim])).toEqual([[pull(5), 'named']]);
    expect(keepNeoUnbeatenPrs(follower, owned, [opener]).beaten).toEqual([]);
    expect(
      planNeoPrCedes(follower, [opener, { ...opener, workId: follower.id, claim: 'named' }])
    ).toEqual([]);
  });

  test('is tracked by its canonical URL, without query or fragment', () => {
    expect(
      planNeoCardPrCandidates({
        report: null,
        follows: `${pull(5)}/files?tab=files#diff`,
        branch: [],
        stored: [],
      })
    ).toEqual([{ url: pull(5), claim: 'named' }]);
  });

  test('is ignored when the followed URL is not a pull request', () => {
    expect(
      planNeoCardPrCandidates({
        report: null,
        follows: 'https://github.com/lsm/HyperNeo/issues/7049',
        branch: [],
        stored: [],
      })
    ).toEqual([]);
  });

  test('never takes a PR from another card through its follow', () => {
    const followed = { ...opener, workId: 'follow-up', claim: 'named' as const, cardCreatedAt: 50 };
    const owned = planNeoCardPrOwnership(
      { id: 'opener', createdAt: 100 },
      [{ url: pull(5), claim: 'branch' }],
      [followed],
      400
    );
    expect(owned.map((item) => item.url)).toEqual([pull(5)]);
  });
});

describe('NeoWorkPrClaimRepository', () => {
  test('replaces one card’s claims, stores an opened PR as a branch claim, and lists every card’s claims on a PR', async () => {
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
      repo.replace('b', [
        { url: pull(2), claim: 'mentioned', claimedAt: 3 },
        { url: pull(3), claim: 'rejected', claimedAt: 4 },
      ]);
      repo.replace('b', [{ url: pull(2), claim: 'mentioned', claimedAt: 3 }]);
      expect(repo.forUrls([pull(3)])).toEqual([
        {
          workId: 'b',
          urlKey: pull(3).toLowerCase(),
          claim: 'rejected',
          claimedAt: 4,
          cardCreatedAt: 20,
          score: null,
        },
      ]);
      repo.replace('a', [{ url: pull(1), claim: 'opened', claimedAt: 9 }]);
      expect(repo.forUrls([pull(1), pull(2)])).toEqual(
        expect.arrayContaining([
          {
            workId: 'a',
            urlKey: pull(1).toLowerCase(),
            claim: 'branch',
            claimedAt: 1,
            cardCreatedAt: 10,
            score: null,
          },
          {
            workId: 'b',
            urlKey: pull(2).toLowerCase(),
            claim: 'mentioned',
            claimedAt: 3,
            cardCreatedAt: 20,
            score: null,
          },
        ])
      );
      expect(repo.forUrls([pull(1), pull(2)])).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

describe('NeoWorkPrClaimRepository settled cards', () => {
  test('lists cards with stored PRs and no claims, and drops one claim', async () => {
    const db = await createTestDb();
    try {
      const raw = db.getDatabase();
      for (const id of ['a', 'b', 'c'])
        raw
          .prepare(
            `INSERT INTO neo_work(id, request_key, origin_session_id, title, instruction, status, created_at, updated_at)
             VALUES (?, ?, 'root', 'T', 'I', 'reported', 1, 1)`
          )
          .run(id, `key-${id}`);
      const prs = new NeoWorkPrRepository(raw);
      prs.record('a', [pr(1)], 1);
      prs.record('b', [pr(2)], 1);
      prs.record('c', [], 1);
      const repo = new NeoWorkPrClaimRepository(raw);
      repo.replace('b', [
        { url: pull(2), claim: 'branch', claimedAt: 1 },
        { url: pull(3), claim: 'mentioned', claimedAt: 1 },
      ]);
      expect(repo.cardsToReclaim()).toEqual(['a', 'b']);
      repo.drop('b', pull(2).toLowerCase(), 'mentioned');
      repo.drop('b', pull(3).toLowerCase(), 'mentioned');
      expect(repo.cardsToReclaim()).toEqual(['a', 'b']);
      expect(repo.forUrls([pull(2), pull(3)]).map((row) => row.urlKey)).toEqual([
        pull(2).toLowerCase(),
      ]);
    } finally {
      db.close();
    }
  });

  test('also lists a card with no claims whose report cites a PR by number', async () => {
    const db = await createTestDb();
    try {
      const raw = db.getDatabase();
      for (const [id, report] of [
        ['bare', 'Waiting on CI for #6403.'],
        ['words', 'Pushed the fix; nothing to cite.'],
      ])
        raw
          .prepare(
            `INSERT INTO neo_work(id, request_key, origin_session_id, title, instruction, status, report, created_at, updated_at)
             VALUES (?, ?, 'root', 'T', 'I', 'reported', ?, 1, 1)`
          )
          .run(id, `key-${id}`, report);
      expect(new NeoWorkPrClaimRepository(raw).cardsToReclaim()).toEqual(['bare']);
    } finally {
      db.close();
    }
  });
});

describe('NeoWorkPrRepository.replacePrs', () => {
  test('changes the stored PRs without stamping a read', async () => {
    const db = await createTestDb();
    try {
      const raw = db.getDatabase();
      raw
        .prepare(
          `INSERT INTO neo_work(id, request_key, origin_session_id, title, instruction, status, created_at, updated_at)
           VALUES ('w1', 'k1', 'root', 'T', 'I', 'reported', 1, 1)`
        )
        .run();
      const repo = new NeoWorkPrRepository(raw);
      repo.record('w1', [pr(1), pr(2)], 100);
      repo.recordFailedRead('w1', 200);
      const after = repo.replacePrs('w1', [pr(1)]);
      expect(after).toMatchObject({ prs: [pr(1)], revision: 2, readAt: 200, readOkAt: 100 });
    } finally {
      db.close();
    }
  });
});

describe('readNeoCardPrs', () => {
  test('rejects a mention of a merged PR older than the card once, then stops reading it', async () => {
    const rows: NeoPrClaimRow[] = [];
    let reads = 0;
    const deps = {
      readPrs: async () => {
        reads++;
        return [{ ...pr(7, 5), state: 'MERGED' as const }];
      },
      prCandidates: async () => [{ url: pull(7), claim: 'mentioned' as const }],
      claims: {
        forUrls: () => rows,
        replace: (
          _id: string,
          claims: readonly { url: string; claim: NeoPrClaimRow['claim']; claimedAt: number }[]
        ) => {
          rows.splice(
            0,
            rows.length,
            ...claims.map((item) =>
              claim({
                workId: 'me',
                urlKey: item.url.toLowerCase(),
                claim: item.claim,
                claimedAt: item.claimedAt,
              })
            )
          );
        },
        drop: () => {},
      },
      workPrs: { get: () => null, list: () => [], recordFailedRead: () => {} },
      record: () => null,
    };
    const card = { id: 'me', createdAt: 10, report: `See ${pull(7)}.` } as NeoWork;
    await readNeoCardPrs(deps, card, null, 1_000);
    expect(rows.map((row) => row.claim)).toEqual(['rejected']);
    await readNeoCardPrs(deps, card, null, 2_000);
    expect(reads).toBe(1);
  });

  test('drops a stored PR another card owns without reading it again', async () => {
    const stored = {
      workId: 'me',
      prs: [pr(1), pr(2)],
      revision: 1,
      readAt: 1_000,
      readOkAt: 1_000,
    } as NeoWorkPrRow;
    const recorded: NeoWorkPr[][] = [];
    const readFlags: (boolean | undefined)[] = [];
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
          drop: () => {},
        },
        workPrs: { get: () => stored, list: () => [], recordFailedRead: () => {} },
        record: (_id, prs, _before, read) => {
          recorded.push([...prs]);
          readFlags.push(read);
          return { ...stored, prs: [...prs], revision: 2 };
        },
      },
      { id: 'me', createdAt: 0, report: null } as NeoWork,
      stored,
      1_100
    );
    expect(reads).toBe(0);
    expect(recorded).toEqual([[pr(1)]]);
    expect(readFlags).toEqual([false]);
    expect(replaced).toEqual([
      [{ url: pull(1), claim: 'mentioned', claimedAt: 5, claimed: true, score: 1 }],
    ]);
    expect(result).toEqual({ row: { ...stored, prs: [pr(1)], revision: 2 }, ok: true });
  });

  test('a card that wins a PR takes it out of the losing card before dropping its claim', async () => {
    const theirs: NeoWorkPrRow = {
      workId: 'other',
      prs: [pr(1), pr(2)],
      revision: 1,
      readAt: 1,
      readOkAt: 1,
    };
    const dropped: string[][] = [];
    const recorded: [string, NeoWorkPr[], boolean | undefined][] = [];
    const rows = [claim({ urlKey: pull(2).toLowerCase() })];
    await readNeoCardPrs(
      {
        readPrs: async () => [pr(2, 50)],
        prCandidates: async () => [{ url: pull(2), claim: 'branch' }],
        claims: {
          forUrls: () => rows,
          replace: (_id, claims) =>
            rows.push(
              ...claims.map((item) =>
                claim({
                  workId: 'me',
                  urlKey: item.url.toLowerCase(),
                  claim: item.claim,
                  cardCreatedAt: 20,
                })
              )
            ),
          drop: (workId, urlKey, held) => dropped.push([workId, urlKey, held]),
        },
        workPrs: {
          get: (id) => (id === 'other' ? theirs : null),
          list: () => [],
          recordFailedRead: () => {},
        },
        record: (id, prs, _before, read) => {
          recorded.push([id, [...prs], read]);
          if (id === 'other') expect(dropped).toEqual([]);
          return id === 'me' ? { ...theirs, workId: 'me', prs: [...prs] } : null;
        },
      },
      { id: 'me', createdAt: 20, report: null } as NeoWork,
      null,
      1_000
    );
    expect(dropped).toEqual([['other', pull(2).toLowerCase(), 'mentioned']]);
    expect(recorded.at(-1)).toEqual(['other', [pr(1)], false]);
  });

  test('a read rejects a mention of a PR a rival won while it was reading', async () => {
    const rival = claim({ urlKey: pull(2).toLowerCase(), claim: 'branch' });
    let lookups = 0;
    const replaced: unknown[][] = [];
    const recorded: NeoWorkPr[][] = [];
    await readNeoCardPrs(
      {
        readPrs: async () => [pr(2, 50)],
        prCandidates: async () => [{ url: pull(2), claim: 'mentioned' }],
        claims: {
          forUrls: () => (lookups++ === 0 ? [] : [rival]),
          replace: (_id, claims) => replaced.push([...claims]),
          drop: () => {},
        },
        workPrs: { get: () => null, list: () => [], recordFailedRead: () => {} },
        record: (_id, prs) => {
          recorded.push([...prs]);
          return null;
        },
      },
      { id: 'me', createdAt: 20, report: null } as NeoWork,
      null,
      1_000
    );
    expect(replaced.map((claims) => claims.map((item) => (item as NeoPrClaimRow).claim))).toEqual([
      ['rejected'],
    ]);
    expect(recorded).toEqual([[]]);
  });

  test('two cards in one session that mention both PRs each keep the one matching their task', async () => {
    const rows: NeoPrClaimRow[] = [];
    const prs = [
      {
        ...pr(64, 50),
        title: 'fix(desktop): get past the startup splash and surface failures',
        branch: 'fix/desktop-startup-daemon-attach',
      },
      {
        ...pr(65, 60),
        title: 'chore(desktop): regenerate app icons from the HyperNeo favicon',
        branch: 'chore/desktop-icon-refresh',
      },
    ];
    const stored = new Map<string, NeoWorkPr[]>();
    const deps = {
      readPrs: async () => prs,
      prCandidates: async () => [
        { url: pull(64), claim: 'mentioned' as const },
        { url: pull(65), claim: 'mentioned' as const },
      ],
      claims: {
        forUrls: () => rows,
        replace: (
          workId: string,
          claims: readonly {
            url: string;
            claim: NeoPrClaimRow['claim'];
            claimedAt: number;
            score?: number | null;
          }[]
        ) => {
          rows.splice(0, rows.length, ...rows.filter((row) => row.workId !== workId));
          rows.push(
            ...claims.map((item) =>
              claim({
                workId,
                urlKey: item.url.toLowerCase(),
                claim: item.claim,
                claimedAt: item.claimedAt,
                cardCreatedAt: workId === 'startup' ? 10 : 20,
                score: item.score ?? null,
              })
            )
          );
        },
        drop: (workId: string, urlKey: string) =>
          rows.splice(
            rows.findIndex((row) => row.workId === workId && row.urlKey === urlKey),
            1
          ),
      },
      workPrs: {
        get: (id: string) =>
          stored.has(id) ? ({ workId: id, prs: stored.get(id) } as NeoWorkPrRow) : null,
        list: () => [],
        recordFailedRead: () => {},
      },
      record: (id: string, next: readonly NeoWorkPr[]) => {
        stored.set(id, [...next]);
        return { workId: id, prs: [...next] } as NeoWorkPrRow;
      },
    };
    const startup = {
      id: 'startup',
      createdAt: 10,
      title: 'Desktop startup',
      instruction: 'The desktop app hangs on the startup splash; attach to the daemon.',
      report: null,
    } as NeoWork;
    const icons = {
      id: 'icons',
      createdAt: 20,
      title: 'Desktop icons',
      instruction: 'Refresh the desktop app icons from the favicon.',
      report: null,
    } as NeoWork;
    await readNeoCardPrs(deps, startup, null, 1_000);
    await readNeoCardPrs(deps, icons, null, 2_000);
    expect(stored.get('startup')?.map((item) => item.url)).toEqual([pull(64)]);
    expect(stored.get('icons')?.map((item) => item.url)).toEqual([pull(65)]);
  });

  test('the startup pass reads a settled card once to score its mention', async () => {
    const merged = { ...pr(64, 50), state: 'MERGED' as const, title: 'Desktop startup splash' };
    const replaced: { claim: string; score?: number | null }[][] = [];
    let reads = 0;
    await readNeoCardPrs(
      {
        readPrs: async () => {
          reads++;
          return [merged];
        },
        prCandidates: async () => [{ url: pull(64), claim: 'mentioned' }],
        claims: {
          forUrls: () => [
            claim({ workId: 'me', urlKey: pull(64).toLowerCase(), claimedAt: 5, score: null }),
          ],
          replace: (_id, claims) => replaced.push([...claims]),
          drop: () => {},
        },
        workPrs: {
          get: () => null,
          list: () => [],
          recordFailedRead: () => {},
        },
        record: (_id, prs) => ({ workId: 'me', prs: [...prs] }) as NeoWorkPrRow,
      },
      {
        id: 'me',
        createdAt: 10,
        title: 'Desktop startup',
        instruction: '',
        report: null,
      } as NeoWork,
      {
        workId: 'me',
        prs: [{ ...pr(64), state: 'MERGED' }],
        revision: 1,
        readAt: 900,
        readOkAt: 900,
      },
      1_000,
      true
    );
    expect(reads).toBe(1);
    expect(replaced.map((claims) => claims.map((item) => [item.claim, item.score]))).toEqual([
      [['mentioned', 2]],
    ]);
  });
});

describe('runMigration380', () => {
  test('adds follows once and drops PRs parsed from card text, claims and receipts alike', () => {
    const db = new Sqlite(':memory:');
    db.exec(
      `CREATE TABLE neo_work (id TEXT PRIMARY KEY);
       CREATE TABLE neo_work_pr_claims (work_id TEXT, url_key TEXT, claim TEXT);
       CREATE TABLE neo_work_prs (work_id TEXT PRIMARY KEY, prs_json TEXT)`
    );
    db.prepare('INSERT INTO neo_work_pr_claims VALUES (?, ?, ?), (?, ?, ?)').run(
      'a',
      pull(4).toLowerCase(),
      'named',
      'a',
      pull(5).toLowerCase(),
      'branch'
    );
    db.prepare('INSERT INTO neo_work_prs VALUES (?, ?)').run(
      'a',
      JSON.stringify([{ url: pull(4) }, { url: pull(5) }])
    );
    runMigration380(db);
    runMigration380(db);
    const columns = db.prepare('PRAGMA table_info(neo_work)').all() as { name: string }[];
    expect(columns.filter((column) => column.name === 'follows')).toHaveLength(1);
    expect(db.prepare('SELECT claim FROM neo_work_pr_claims').all()).toEqual([{ claim: 'branch' }]);
    expect(
      JSON.parse(
        (db.prepare('SELECT prs_json AS prs FROM neo_work_prs').get() as { prs: string }).prs
      )
    ).toEqual([{ url: pull(5) }]);
  });
});

describe('NeoRepository.proposeWork', () => {
  test('stores the PR a card follows', async () => {
    const db = await createTestDb();
    try {
      const work = new NeoRepository(db.getDatabase()).proposeWork({
        id: 'card',
        requestKey: 'key',
        projectId: null,
        originSessionId: 'neo:root',
        title: 'Address review on PR 5',
        instruction: 'Address the review.',
        follows: pull(5),
      });
      expect(work.follows).toBe(pull(5));
    } finally {
      db.close();
    }
  });
});

describe('explicit report ownership', () => {
  test('a prior branch claim cannot downgrade a report-named PR into competing ownership', () => {
    const candidates = planNeoCardPrCandidates({
      report: pull(102),
      branch: [],
      stored: [],
      window: { start: 10, end: 20 },
    });
    const rows = [
      claim({ workId: 'me', urlKey: pull(102).toLowerCase(), claim: 'branch', scoped: true }),
      claim({ urlKey: pull(102).toLowerCase(), claim: 'branch', cardCreatedAt: 1, scoped: true }),
    ];
    expect(
      planNeoCardPrOwnership({ id: 'me', createdAt: 10 }, candidates, rows, 30)[0]
    ).toMatchObject({ claim: 'named', url: pull(102) });
  });
});

describe('card lifetime PR recovery', () => {
  const kickoff = Date.parse('2026-10-17T00:00:00Z');
  const ended = Date.parse('2026-10-17T00:52:17Z');
  const ios = (number: number) => `https://github.com/lsm/neo-ios/pull/${number}`;

  test('uses the original kickoff through completion, not the last follow-up', () => {
    const work = { createdAt: kickoff - 1000, updatedAt: ended, status: 'reported' as const };
    expect(neoCardPrWindow(work, kickoff)).toEqual({ start: kickoff, end: ended });
    expect(neoCardPrWindow({ ...work, status: 'queued' }, kickoff)).toEqual({
      start: kickoff,
      end: null,
    });
    expect(neoCardPrWindow(work, null).start).toBe(work.createdAt);
  });

  test('reclaims 16152bb9 report PRs across branches and keeps old reference PRs rejected', async () => {
    const db = await createTestDb();
    try {
      const raw = db.getDatabase();
      raw
        .prepare(
          `INSERT INTO neo_work(id,request_key,origin_session_id,title,instruction,status,report,created_at,updated_at,started_at)
         VALUES ('16152bb9','ios-v2','root','iOS ask cards','Use #101 as reference','reported',?, ?, ?, ?)`
        )
        .run(`Merged ${ios(102)} and ${ios(103)}.`, kickoff - 1000, ended, kickoff);
      const work = new NeoRepository(raw).getWork('16152bb9')!;
      const claims = new NeoWorkPrClaimRepository(raw);
      claims.replace(
        work.id,
        [101, 102, 103].map((number) => ({
          url: ios(number),
          claim: 'rejected' as const,
          claimedAt: ended,
        }))
      );
      const workPrs = new NeoWorkPrRepository(raw);
      workPrs.record(work.id, [], ended);
      expect(claims.cardsToReclaim()).toContain(work.id);
      const reads = [101, 102, 103].map((number) => ({
        ...pr(number),
        url: ios(number),
        state: 'MERGED' as const,
        createdAt:
          number === 101
            ? kickoff - 1000
            : Date.parse(number === 102 ? '2026-10-17T00:09:46Z' : '2026-10-17T00:24:39Z'),
        branch: number === 102 ? 'ask-card-step-rows' : 'ask-card-answered-details',
      }));
      const result = await readNeoCardPrs(
        {
          claims,
          workPrs,
          prCandidates: async () =>
            planNeoCardPrCandidates({
              window: neoCardPrWindow(work, new NeoRepository(raw).workStartedAt(work.id)),
              report: work.report,
              branch: [ios(103)],
              stored: claims.rejectedUrls(work.id),
            }),
          readPrs: async () => reads,
          record: (id, prs) => workPrs.record(id, prs, ended + 1000),
        },
        work,
        workPrs.get(work.id),
        ended + 1000,
        true
      );
      expect(result.row?.prs.map((item) => item.url)).toEqual([ios(102), ios(103)]);
      expect(claims.forUrls([ios(102), ios(103)]).map((row) => row.claim)).toEqual([
        'named',
        'named',
      ]);
      expect(claims.forUrls([ios(101)])[0]).toMatchObject({ claim: 'rejected', scoped: true });
      expect(claims.cardsToReclaim()).not.toContain(work.id);
    } finally {
      db.close();
    }
  });
});
