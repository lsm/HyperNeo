import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk, NeoAskItem, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoRefState } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import { keepNeoCardPrReads } from '../../../../src/lib/neo/packs/coding/card-pr-claims.ts';
import { readNeoGithubRef } from '../../../../src/lib/neo/packs/coding/github-read.ts';
import { readNeoAskPackTicks } from '../../../../src/lib/neo/packs/index.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';
import {
  judgeNeoWatchTicks,
  neoWatchRefs,
  readNeoWatchTicks,
} from '../../../../src/lib/neo/packs/coding/watch-checks.ts';
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

describe('readNeoAskPackTicks', () => {
  test('reads watch ticks from every pack, also on an ask under another pack', async () => {
    const pack = (id: string, extra: Partial<NeoPack>): NeoPack =>
      ({ id, describe: id, instructions: () => null, ...extra }) as NeoPack;
    const coding = pack('coding', {
      readAskTicks: async () => [{ id: 'i1', evidence: 'issue' }],
      readAskWatchTicks: async () => [
        { id: 'i1', evidence: 'watched' },
        { id: 'i2', evidence: 'watched' },
      ],
    });
    const life = pack('life-admin', { readAskTicks: async () => [{ id: 'i3', evidence: 'life' }] });
    const warn = vi.fn();
    expect(
      await readNeoAskPackTicks([coding, life], { ...ask([]), pack: 'life-admin' }, [], warn)
    ).toEqual([
      { id: 'i1', evidence: 'watched' },
      { id: 'i2', evidence: 'watched' },
      { id: 'i3', evidence: 'life' },
    ]);
    expect(await readNeoAskPackTicks([coding], ask([]), [], warn)).toEqual([
      { id: 'i1', evidence: 'issue' },
      { id: 'i2', evidence: 'watched' },
    ]);
    expect(warn).not.toHaveBeenCalled();
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
      prState(67, 'MERGED', 'lsm/neo-ios'),
      prState(6647, 'MERGED'),
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
