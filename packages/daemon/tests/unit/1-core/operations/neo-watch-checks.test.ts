import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk, NeoAskItem, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoRefState } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import { keepNeoCardPrReads } from '../../../../src/lib/neo/packs/coding/card-pr-claims.ts';
import { readNeoGithubRef } from '../../../../src/lib/neo/packs/coding/github-read.ts';
import { readNeoAskPackTicks, readNeoAskEventTicks } from '../../../../src/lib/neo/packs/index.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';
import {
  codingCardBase,
  judgeNeoWatchTicks,
  neoItemWatchUrls,
  neoWatchRefs,
  neoWatchTopics,
  readNeoWatchEventTicks,
  readNeoWatchTicks,
} from '../../../../src/lib/neo/packs/coding/watch-checks.ts';
import { codingPrMergedCheck } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const pull = (n: number, repo = 'lsm/HyperNeo') => `https://github.com/${repo}/pull/${n}`;
const issueUrl = (n: number) => `https://github.com/lsm/HyperNeo/issues/${n}`;
const item = (id: string, watch: string[], extra: Partial<NeoAskItem> = {}): NeoAskItem => ({
  id,
  text: `item ${id}`,
  state: 'pending',
  evidence: null,
  check: null,
  metBy: null,
  removed: false,
  addedAt: null,
  watch,
  ...extra,
});
const ask = (items: NeoAskItem[], id = 'a1'): NeoAsk => ({
  id,
  requestKey: `k-${id}`,
  projectId: null,
  originSessionId: 'neo:root',
  originMessageId: 'm0',
  title: 'Watch',
  ask: 'Land the fix',
  doneWhen: '',
  doneSource: 'human',
  status: 'open',
  outcome: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  settledAt: null,
  workIds: [],
  doneItems: items,
});
const prState = (n: number, state: NeoRefState['state'], repo?: string): NeoRefState => ({
  url: pull(n, repo),
  kind: 'pr',
  state,
  at: state === 'OPEN' ? null : 5_000,
  done: state === 'MERGED',
  closedBy: null,
});
const issueState = (n: number, extra: Partial<NeoRefState> = {}): NeoRefState => ({
  url: issueUrl(n),
  kind: 'issue',
  state: 'OPEN',
  at: null,
  done: false,
  closedBy: null,
  createdAt: 2_000,
  parent: null,
  ...extra,
});

describe('judgeNeoWatchTicks', () => {
  test('ticks an item only once every watched PR merged and every watched issue closed', () => {
    const watched = ask([
      item('i1', [pull(1), issueUrl(2)]),
      item('i2', [pull(3)]),
      item('i3', [pull(4)]),
      item('i4', [pull(1)], { state: 'reported' }),
    ]);
    const ticks = judgeNeoWatchTicks(watched, [
      prState(1, 'MERGED'),
      issueState(2, { state: 'CLOSED', done: true, closedBy: pull(1) }),
      prState(3, 'CLOSED'),
      prState(4, 'OPEN'),
    ]);
    expect(ticks).toEqual([
      {
        id: 'i1',
        evidence: `Watched: ${pull(1)} merged; ${issueUrl(2)} closed as completed by ${pull(1)}`,
      },
      { id: 'i4', evidence: `Watched: ${pull(1)} merged` },
    ]);
  });

  test('non-coding PR watches retain their settlement behavior regardless of merge time', () => {
    const watched = { ...ask([item('i1', [pull(1)])]), pack: 'life-admin' };
    for (const at of [null, watched.createdAt - 1, watched.createdAt]) {
      expect(judgeNeoWatchTicks(watched, [{ ...prState(1, 'MERGED'), at }])).toEqual([
        { id: 'i1', evidence: `Watched: ${pull(1)} merged` },
      ]);
    }
  });

  test('leaves met, removed, needs_you and unread items alone', () => {
    const watched = ask([
      item('i1', [pull(1)], { state: 'met' }),
      item('i2', [pull(1)], { removed: true }),
      item('i3', [pull(1)], { state: 'needs_you' }),
      item('i4', [pull(9)]),
    ]);
    expect(judgeNeoWatchTicks(watched, [prState(1, 'MERGED')])).toEqual([]);
  });

  test('matches a watched URL to its read whatever its path or case', () => {
    const watched = ask([item('i1', ['https://github.com/LSM/hyperneo/issues/7'])]);
    expect(judgeNeoWatchTicks(watched, [prState(7, 'MERGED')])).toEqual([
      { id: 'i1', evidence: `Watched: ${pull(7)} merged` },
    ]);
  });
});

describe('judgeNeoWatchTicks for coding.pr_merged', () => {
  const merged = { check: 'coding.pr_merged' };
  const bound = { ...merged, deliveredBy: 'card-a' };
  const base = (state: NeoRefState, branch: string | null) => ({
    ...state,
    base: branch,
    defaultBase: 'dev',
  });

  test('an issue closed as not planned or as a duplicate never ticks a watch item', () => {
    const watched = ask([item('i1', [issueUrl(2)]), item('i2', [issueUrl(3)], merged)]);
    expect(
      judgeNeoWatchTicks(watched, [
        issueState(2, { state: 'CLOSED', done: false, duplicate: true }),
        issueState(3, { state: 'CLOSED', done: false }),
      ])
    ).toEqual([]);
    expect(judgeNeoWatchTicks(watched, [issueState(2, { state: 'CLOSED', done: true })])).toEqual([
      { id: 'i1', evidence: `Watched: ${issueUrl(2)} closed as completed` },
    ]);
  });

  test('a merged outcome needs a merged PR, or an issue closed as completed by one', () => {
    const watched = ask([item('i1', [issueUrl(2)], merged), item('i2', [pull(4)], merged)]);
    expect(
      judgeNeoWatchTicks(watched, [
        issueState(2, { state: 'CLOSED', done: true }),
        prState(4, 'CLOSED'),
      ])
    ).toEqual([]);
    expect(
      judgeNeoWatchTicks(watched, [
        issueState(2, {
          state: 'CLOSED',
          done: true,
          closedBy: pull(1),
          defaultBase: 'dev',
          merges: [{ url: pull(1), base: 'dev', at: 5_000 }],
        }),
        prState(4, 'MERGED'),
      ])
    ).toEqual([
      { id: 'i1', evidence: `Watched: ${issueUrl(2)} closed as completed by ${pull(1)} into dev` },
      { id: 'i2', evidence: `Watched: ${pull(4)} merged` },
    ]);
  });

  test("a card's bound outcome needs a merge into its target base, or the default branch", () => {
    const watched = ask([item('i1', [issueUrl(2)], bound), item('i2', [pull(4)], bound)]);
    const closed = issueState(2, {
      state: 'CLOSED',
      done: true,
      closedBy: pull(1),
      merges: [
        { url: pull(1), base: 'feature', at: 5_000 },
        { url: pull(5), base: 'release', at: 5_000 },
      ],
    });
    expect(
      judgeNeoWatchTicks(
        watched,
        [base(closed, 'feature'), base(prState(4, 'MERGED'), 'dev')],
        undefined,
        undefined,
        () => 1_000
      )
    ).toEqual([{ id: 'i2', evidence: `Watched: ${pull(4)} merged into dev` }]);
    expect(
      judgeNeoWatchTicks(
        watched,
        [base(closed, 'feature'), base(prState(4, 'MERGED'), 'dev')],
        () => 'release',
        undefined,
        () => 1_000
      )
    ).toEqual([
      {
        id: 'i1',
        evidence: `Watched: ${issueUrl(2)} closed as completed by ${pull(5)} into release`,
      },
    ]);
    expect(judgeNeoWatchTicks(watched, [prState(4, 'MERGED')])).toEqual([]);
  });

  test("a card-bound outcome without a watch watches its card's recorded PRs", () => {
    const cardPrs = (workId: string) =>
      workId === 'card-a' ? [{ url: pull(9), state: 'MERGED' as const }] : [];
    expect(neoItemWatchUrls(item('i1', [], bound), cardPrs)).toEqual([pull(9)]);
    expect(neoItemWatchUrls(item('i1', [pull(4)], bound), cardPrs)).toEqual([pull(4)]);
    expect(neoItemWatchUrls(item('i1', [], { deliveredBy: 'card-a' }), cardPrs)).toEqual([]);
    const watched = ask([item('i1', [], bound)]);
    expect(neoWatchRefs(watched, cardPrs)).toEqual([{ owner: 'lsm', repo: 'HyperNeo', number: 9 }]);
    expect(neoWatchTopics(watched, cardPrs)).toHaveLength(1);
    expect(
      judgeNeoWatchTicks(
        watched,
        [base(prState(9, 'MERGED'), 'dev')],
        () => null,
        cardPrs,
        () => 1_000
      )
    ).toEqual([{ id: 'i1', evidence: `Watched: ${pull(9)} merged into dev` }]);
    expect(
      judgeNeoWatchTicks(
        watched,
        [base(prState(9, 'MERGED'), 'feature')],
        () => null,
        cardPrs,
        () => 1_000
      )
    ).toEqual([]);
  });

  test.each([null, 999, 1_000])('never accepts a PR merged at %s against kickoff 1000', (at) => {
    const watched = ask([item('i1', [pull(4)], bound)]);
    expect(
      judgeNeoWatchTicks(
        watched,
        [{ ...base(prState(4, 'MERGED'), 'dev'), at }],
        undefined,
        undefined,
        () => 1_000
      )
    ).toEqual([]);
    expect(
      judgeNeoWatchTicks(
        watched,
        [{ ...base(prState(4, 'MERGED'), 'dev'), at: 1_001 }],
        undefined,
        undefined,
        () => 1_000
      )
    ).toHaveLength(1);
    expect(judgeNeoWatchTicks(watched, [base(prState(4, 'MERGED'), 'dev')])).toEqual([]);
  });

  test('an issue closed now by an old merge does not count as new coding work', () => {
    const watched = ask([item('i1', [issueUrl(2)], bound)]);
    const state = issueState(2, {
      state: 'CLOSED',
      done: true,
      at: 9_000,
      closedBy: pull(1),
      defaultBase: 'dev',
      merges: [{ url: pull(1), base: 'dev', at: 999 }],
    });
    expect(judgeNeoWatchTicks(watched, [state], undefined, undefined, () => 1_000)).toEqual([]);
    const legacy = {
      ...watched,
      pack: 'coding',
      doneItems: [item('i1', [issueUrl(2)], { ...bound, check: null })],
    };
    expect(judgeNeoWatchTicks(legacy, [state], undefined, undefined, () => 1_000)).toEqual([]);
  });

  test('an unbound watch uses execution kickoff rather than the earlier proposal time', () => {
    const watched = { ...ask([item('i1', [pull(4)], merged)]), workIds: ['late-card'] };
    expect(
      judgeNeoWatchTicks(watched, [prState(4, 'MERGED')], undefined, undefined, () => 6_000)
    ).toEqual([]);
    expect(judgeNeoWatchTicks(watched, [prState(4, 'MERGED')])).toEqual([]);
    expect(
      judgeNeoWatchTicks(watched, [prState(4, 'MERGED')], undefined, undefined, () => 4_000)
    ).toHaveLength(1);
  });

  test('a late merge event independently reads the merge time instead of using wake time', async () => {
    const watched = ask([item('i1', [pull(4)], bound)]);
    const event = {
      id: 'late',
      topic: 'github/lsm/HyperNeo/pull_request/4.closed',
      summary: 'merged',
      occurredAt: 10_000,
      payload: { merged: true },
    };
    const read = vi.fn(async () => [{ ...base(prState(4, 'MERGED'), 'dev'), at: 999 }]);
    expect(
      await readNeoWatchEventTicks(watched, event as never, read, undefined, undefined, () => 1_000)
    ).toEqual([]);
    expect(read).toHaveBeenCalledWith([{ owner: 'lsm', repo: 'HyperNeo', number: 4 }]);
  });

  test('a merge event without its base ticks an unbound outcome but not a bound one', async () => {
    const watched = ask([item('i1', [pull(4)], merged), item('i2', [pull(4)], bound)]);
    const event = {
      id: 'e1',
      topic: 'github/lsm/HyperNeo/pull_request/4.closed',
      summary: 'merged',
      occurredAt: 6_000,
      payload: { merged: true },
    };
    expect(
      await readNeoWatchEventTicks(watched, event as never, async () => [prState(4, 'MERGED')])
    ).toEqual([{ id: 'i1', evidence: `Watched: ${pull(4)} merged (event e1: merged)` }]);
  });
});

describe('codingPrMergedCheck', () => {
  test('a bound outcome is never met from the ask-wide card PRs, only from its watch', () => {
    const done = [{ key: pull(1), state: 'done' as const, summary: 'merged', blockers: [] }];
    expect(codingPrMergedCheck(item('i1', [], { deliveredBy: 'card-a' }), done)).toEqual({
      reason: 'watch_required',
    });
    expect(codingPrMergedCheck(item('i1', []), done)).toEqual({ reason: 'watch_required' });
  });
});

describe('codingCardBase', () => {
  test("reads a start card's preparation target and ignores HEAD and other verbs", () => {
    const start = (target?: unknown) => ({
      verb: 'start',
      preparationParameters: target === undefined ? undefined : { target },
    });
    expect(codingCardBase(start('release'))).toBe('release');
    expect(codingCardBase(start('HEAD'))).toBeNull();
    expect(codingCardBase(start())).toBeNull();
    expect(codingCardBase({ verb: 'send' })).toBeNull();
    expect(codingCardBase(null)).toBeNull();
  });
});

describe('readNeoWatchTicks', () => {
  test('reads the watched refs of open items at most every two minutes', async () => {
    const watched = ask([item('i1', [pull(1), pull(1)]), item('i2', [])], 'a-read');
    expect(neoWatchRefs(watched)).toEqual([{ owner: 'lsm', repo: 'HyperNeo', number: 1 }]);
    const read = vi.fn(async () => [prState(1, 'MERGED')]);
    expect(await readNeoWatchTicks(watched, read, 10_000)).toEqual([
      { id: 'i1', evidence: `Watched: ${pull(1)} merged` },
    ]);
    expect(await readNeoWatchTicks(watched, read, 60_000)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await readNeoWatchTicks(ask([item('i1', [])], 'a-none'), read, 10_000)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('neoWatchRefs', () => {
  test('reads at most twenty refs per ask', () => {
    const many = Array.from({ length: 12 }, (_, n) =>
      item(`i${n}`, [pull(n * 10 + 1), pull(n * 10 + 2)])
    );
    expect(neoWatchRefs(ask(many))).toHaveLength(20);
  });
});

describe('readNeoWatchTicks for a card-bound merge', () => {
  test("reads at once when the card's PR is first recorded merged, then throttles again", async () => {
    const bound = item('i1', [], { check: 'coding.pr_merged', deliveredBy: 'card-a' });
    const watched = ask([bound], 'a-card-merge');
    let recorded: 'OPEN' | 'MERGED' = 'OPEN';
    const cardPrs = () => [{ url: pull(9), state: recorded }];
    const read = vi.fn(async () => [{ ...prState(9, recorded), base: 'dev', defaultBase: 'dev' }]);
    expect(await readNeoWatchTicks(watched, read, 10_000, undefined, cardPrs, () => 1_000)).toEqual(
      []
    );
    recorded = 'MERGED';
    expect(await readNeoWatchTicks(watched, read, 11_000, undefined, cardPrs, () => 1_000)).toEqual(
      [{ id: 'i1', evidence: `Watched: ${pull(9)} merged into dev` }]
    );
    expect(await readNeoWatchTicks(watched, read, 12_000, undefined, cardPrs, () => 1_000)).toEqual(
      []
    );
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('readNeoAskPackTicks', () => {
  test('reads watch ticks from every pack, also on an ask under another pack', async () => {
    const pack = (id: string, extra: Partial<NeoPack>): NeoPack =>
      ({ id, describe: id, instructions: () => null, ...extra }) as NeoPack;
    const coding = pack('coding', {
      askTickChecks: ['coding.issue_filed'],
      readAskTicks: async () => [{ id: 'i1', evidence: 'issue' }],
      readAskWatchTicks: async () => [
        { id: 'i1', evidence: 'watched' },
        { id: 'i2', evidence: 'watched' },
      ],
    });
    const life = pack('life-admin', {
      askTickChecks: ['life-admin.confirmed'],
      readAskTicks: async () => [{ id: 'i3', evidence: 'life' }],
    });
    const current = ask([
      item('i1', [pull(1)], { check: 'coding.issue_filed' }),
      item('i2', [pull(2)]),
      item('i3', [], { check: 'life-admin.confirmed' }),
    ]);
    const warn = vi.fn();
    expect(
      await readNeoAskPackTicks([coding, life], { ...current, pack: 'life-admin' }, [], warn)
    ).toEqual([
      { id: 'i1', evidence: 'watched' },
      { id: 'i2', evidence: 'watched' },
      { id: 'i3', evidence: 'life' },
    ]);
    expect(await readNeoAskPackTicks([coding], current, [], warn)).toEqual([
      { id: 'i1', evidence: 'issue' },
      { id: 'i2', evidence: 'watched' },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("keeps the owning pack's watch tick for an item it checks without a watch", async () => {
    const coding = {
      id: 'coding',
      describe: 'coding',
      instructions: () => null,
      checks: { 'coding.pr_merged': () => ({ reason: 'watch_required' }) },
      readAskWatchTicks: async () => [{ id: 'i1', evidence: 'merged' }],
    } as unknown as NeoPack;
    const life = {
      id: 'life-admin',
      describe: 'life',
      instructions: () => null,
      readAskWatchTicks: async () => [{ id: 'i1', evidence: 'foreign' }],
    } as unknown as NeoPack;
    const current = ask([item('i1', [], { check: 'coding.pr_merged', deliveredBy: 'card-a' })]);
    expect(await readNeoAskPackTicks([coding, life], current, [], vi.fn())).toEqual([
      { id: 'i1', evidence: 'merged' },
    ]);
  });

  test('dispatches only declared readers and filters unsupported and foreign ticks', async () => {
    const ticks = ['i1', 'i2', 'i3'].map((id) => ({ id, evidence: id }));
    const read = vi.fn(async () => ticks);
    const loaded: NeoPack = {
      id: 'legal',
      describe: 'Legal',
      instructions: () => null,
      askTickChecks: ['legal.filed'],
      readAskTicks: read,
      readAskWatchTicks: async () => ticks,
    };
    const current = ask([
      item('i1', [], { check: 'legal.filed' }),
      item('i2', [pull(2)], { check: 'unloaded.filed' }),
      item('i3', [], { check: 'other.filed' }),
    ]);
    const other: NeoPack = {
      id: 'other',
      describe: 'Other',
      instructions: () => null,
      checks: { 'other.filed': () => ({ value: 'other' }) },
    };
    expect(await readNeoAskPackTicks([loaded, other], current, [], vi.fn())).toEqual([ticks[0]]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      await readNeoAskPackTicks([{ ...loaded, askTickChecks: [] }, other], current, [], vi.fn())
    ).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('readNeoAskEventTicks', () => {
  test('an event cannot tick a kind whose registration was unloaded, even with a watch', async () => {
    const loaded: NeoPack = {
      id: 'legal',
      describe: 'Legal',
      instructions: () => null,
      checks: { 'legal.filed': () => ({ value: 'filed' }) },
      readAskEventTicks: async () => [{ id: 'i1', evidence: 'filed' }],
    };
    const current = ask([item('i1', [pull(1)], { check: 'legal.filed' })]);
    const event = {
      id: 'e1',
      spaceId: '',
      topic: 'legal.filed',
      occurredAt: 1,
      ingestedAt: 1,
      source: 'legal',
      summary: 'Filed',
      payload: {},
      dedupeKey: 'e1',
    };
    expect(await readNeoAskEventTicks([loaded], current, event, vi.fn())).toEqual([
      { id: 'i1', evidence: 'filed' },
    ]);
    expect(
      await readNeoAskEventTicks([{ ...loaded, checks: {} }], current, event, vi.fn())
    ).toEqual([]);
  });
});

describe('readNeoGithubRef', () => {
  const detail: NeoWorkPr = {
    url: pull(5),
    state: 'OPEN',
    checks: 'failing',
    review: 'changes_requested',
    title: 'fix: it',
    blockers: ['1 unresolved review thread'],
  };

  test('returns a PR with its checks, review verdict and blockers', async () => {
    const readPrs = vi.fn(async () => [detail]);
    const result = await readNeoGithubRef(
      { readRefStates: async () => [prState(5, 'OPEN')], readPrs },
      issueUrl(5)
    );
    expect(readPrs).toHaveBeenCalledWith([pull(5)]);
    expect(result).toEqual({
      ok: true,
      kind: 'pr',
      url: pull(5),
      state: 'OPEN',
      checks: 'failing',
      review: 'changes_requested',
      blockers: ['1 unresolved review thread'],
      title: 'fix: it',
    });
  });

  test('returns an issue with how it closed, without a PR read', async () => {
    const readPrs = vi.fn(async () => []);
    const result = await readNeoGithubRef(
      {
        readRefStates: async () => [
          issueState(6, {
            state: 'CLOSED',
            done: false,
            duplicate: true,
            parent: { url: issueUrl(6002), at: null },
          }),
        ],
        readPrs,
      },
      issueUrl(6)
    );
    expect(readPrs).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      kind: 'issue',
      url: issueUrl(6),
      state: 'CLOSED',
      closedAs: 'duplicate',
      closedBy: null,
      parent: issueUrl(6002),
    });
  });

  test('refuses a URL that is not a GitHub ref, and says when GitHub could not be read', async () => {
    const readers = { readRefStates: vi.fn(async () => []), readPrs: vi.fn(async () => []) };
    expect(await readNeoGithubRef(readers, 'https://example.com/x')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not_a_ref'),
    });
    expect(readers.readRefStates).not.toHaveBeenCalled();
    expect(await readNeoGithubRef(readers, pull(8))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unreadable'),
    });
  });

  test('says a PR is unreadable when its checks and review could not be read', async () => {
    const result = await readNeoGithubRef(
      { readRefStates: async () => [prState(9, 'OPEN')], readPrs: async () => null },
      pull(9)
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('unreadable') });
  });
});

describe('keepNeoCardPrReads', () => {
  const card = { createdAt: 1_000, title: 'Fix network outages', instruction: 'Fix it.' };
  const mentioned = (n: number) => ({
    url: pull(n),
    claim: 'mentioned' as const,
    claimedAt: 1_500,
    claimed: false,
    score: null,
  });

  test('a PR the report names attaches once read when it is current', () => {
    const prs: NeoWorkPr[] = [
      {
        url: pull(6651),
        state: 'OPEN',
        checks: 'pending',
        review: 'none',
        createdAt: 3_000,
        refs: [6650],
      },
      { url: pull(6600), state: 'MERGED', checks: 'passing', review: 'none', createdAt: 500 },
    ];
    const sorted = keepNeoCardPrReads(card, [mentioned(6651), mentioned(6600)], prs);
    expect(sorted.kept.map((entry) => entry.url)).toEqual([pull(6651)]);
    expect(sorted.rejected.map((entry) => entry.url)).toEqual([pull(6600)]);
  });
});

describe('refreshDriverWork watch ticks', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  beforeEach(async () => {
    db = await createTestDb();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession('neo:root'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    db.close();
  });

  test('stores an item watch list and ticks it met by the daemon when the PRs merge', async () => {
    const opened = service.askRecords.open(
      {
        id: 'a-watch',
        requestKey: 'k-watch',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'm0',
        title: 'Thumbnails',
        ask: 'Land the thumbnail PRs',
        doneWhen: '- both PRs merged\n- deployed',
        doneSource: 'human',
      },
      [
        { text: 'both PRs merged', check: null, watch: [pull(67, 'lsm/neo-ios'), pull(6647)] },
        { text: 'deployed', check: null },
      ]
    )!;
    expect(opened.doneItems?.[0].watch).toEqual([pull(67, 'lsm/neo-ios'), pull(6647)]);
    expect(opened.doneItems?.[1].watch).toBeUndefined();
    service.readRefStates = async () => [
      { ...prState(67, 'MERGED', 'lsm/neo-ios'), at: Date.now() + 1 },
      { ...prState(6647, 'MERGED'), at: Date.now() + 1 },
    ];
    Object.assign(service, { deliver: async () => {} });
    await service.refreshDriverWork();
    expect(service.askRecords.get(opened.id)?.doneItems?.[0]).toMatchObject({
      state: 'met',
      metBy: 'daemon',
      verifiedDefinitionHash: service.askRecords.revisionPolicy.definitionHash(
        opened.doneItems![0]
      ),
      evidence: `Watched: ${pull(67, 'lsm/neo-ios')} merged; ${pull(6647)} merged`,
    });
  });

  test("a card-bound merge item settles the ask in the sweep that reads the card's PR merged", async () => {
    const card = service.repo.proposeWork({
      id: 'card-merge',
      requestKey: 'k-card-merge',
      projectId: null,
      originSessionId: 'neo:root',
      originMessageId: 'm0',
      title: 'Fix the login bug',
      instruction: 'Fix it and open a PR.',
    })!;
    const opened = service.askRecords.open(
      {
        id: 'a-card-merge',
        requestKey: 'k-a-card-merge',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'm0',
        title: 'Fix the login bug',
        ask: 'Fix the login bug',
        doneWhen: '- merged',
        doneSource: 'human',
      },
      [{ text: 'fix merged', check: 'coding.pr_merged', deliveredBy: card.id }]
    )!;
    const queued = service.repo.transitionWork(card.id, card, {
      status: 'queued',
      sessionId: 'w1',
    })!;
    service.repo.transitionWork(card.id, queued, {
      status: 'reported',
      report: `Merged ${pull(7200)}`,
    });
    service.workPrs.record(
      card.id,
      [{ url: pull(7200), state: 'MERGED', checks: 'passing', review: 'approved' }],
      Date.now()
    );
    const read = vi.fn(async () => [
      { ...prState(7200, 'MERGED'), at: Date.now() + 1, base: 'dev', defaultBase: 'dev' },
    ]);
    service.readRefStates = read;
    Object.assign(service, { deliver: async () => {}, refreshWorkPrs: async () => {} });
    await service.refreshDriverWork();
    expect(service.askRecords.get(opened.id)).toMatchObject({
      status: 'achieved',
      doneItems: [
        { state: 'met', metBy: 'daemon', evidence: `Watched: ${pull(7200)} merged into dev` },
      ],
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('does not verify a changed watch definition from an in-flight read', async () => {
    const opened = service.askRecords.open(
      {
        id: 'a-watch-race',
        requestKey: 'k-watch-race',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'm0',
        title: 'Merge the fix',
        ask: 'Land the fix',
        doneWhen: '- merged',
        doneSource: 'human',
      },
      [{ text: 'merged', check: null, watch: [pull(7100)] }]
    )!;
    service.readRefStates = async () => {
      service.askRecords.editItems(
        opened.id,
        { add: [], remove: [], track: [{ itemId: 'i1', check: null, watch: [pull(7101)] }] },
        Date.now()
      );
      return [prState(7100, 'MERGED')];
    };
    Object.assign(service, { deliver: async () => {} });
    await service.refreshDriverWork();
    expect(service.askRecords.get(opened.id)).toMatchObject({
      revision: 1,
      doneItems: [
        {
          watch: [pull(7101)],
          state: 'pending',
          evidence: null,
          verifiedDefinitionHash: null,
        },
      ],
    });
  });
});
