import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service.ts';
import {
  SESSION_EVENT_SCOPE,
  SessionExternalEventStore,
} from '../../../../src/lib/external-events/session-external-event-store.ts';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  planNeoDaemonCardSettle,
  requireNeoCardTurn,
} from '../../../../src/lib/neo/card-settle.ts';
import { readNeoDaemonCommits } from '../../../../src/lib/neo/daemon-commits.ts';
import { neoDaemonTickPath } from '../../../../src/lib/neo/needs-you.ts';
import {
  judgeNeoDeployCheck,
  planNeoDeployChecks,
  readGithubDeploys,
  type NeoDeployRead,
} from '../../../../src/lib/neo/packs/coding/deploy-checks.ts';
import {
  isNeoWatchItem,
  neoWatchEventMerge,
  neoWatchTopics,
  readNeoWatchEventTicks,
} from '../../../../src/lib/neo/packs/coding/watch-checks.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const pull = (n: number, repo = 'lsm/HyperNeo') => `https://github.com/${repo}/pull/${n}`;
const MERGE = 'a'.repeat(40);
const RUNNING = 'b'.repeat(40);
const item = (id: string, extra: Partial<NeoAskItem> = {}): NeoAskItem => ({
  id,
  text: `item ${id}`,
  state: 'pending',
  evidence: null,
  check: null,
  metBy: null,
  removed: false,
  addedAt: null,
  ...extra,
});
const ask = (items: NeoAskItem[], id = 'a1'): NeoAsk => ({
  id,
  requestKey: `k-${id}`,
  projectId: null,
  originSessionId: 'neo:root',
  originMessageId: 'm0',
  title: 'Ship it',
  ask: 'Land and deploy the fix',
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
const prEvent = (n: number, action: string, payload: Record<string, unknown>): ExternalEvent => ({
  id: `event-${n}-${action}`,
  spaceId: SESSION_EVENT_SCOPE,
  source: 'github',
  topic: `github/lsm/hyperneo/pull_request/${n}.${action}`,
  dedupeKey: `lsm/hyperneo:${n}:${action}`,
  occurredAt: 9_000,
  ingestedAt: 9_000,
  summary: `PR #${n} ${action}`,
  payload: { prUrl: pull(n), prNumber: n, ...payload },
});

describe('neoWatchEventMerge', () => {
  test('reads a merge from a PR event, never from a close without merge or another resource', () => {
    expect(neoWatchEventMerge(prEvent(7, 'closed', { merged: true }))).toMatchObject({
      url: 'https://github.com/lsm/hyperneo/pull/7',
      state: 'MERGED',
      done: true,
    });
    expect(neoWatchEventMerge(prEvent(7, 'closed', { merged: false }))).toBe(null);
    expect(
      neoWatchEventMerge({
        ...prEvent(7, 'created', { merged: true }),
        topic: 'github/lsm/hyperneo/check_run/7.created',
      })
    ).toBe(null);
  });
});

describe('readNeoWatchEventTicks', () => {
  test('ticks an item on its PR merge event, citing the event, once its other refs settled', async () => {
    const watched = ask([
      item('i1', { watch: [pull(7)] }),
      item('i2', { watch: [pull(7), pull(8)] }),
      item('i3', { watch: [pull(9)] }),
    ]);
    const reads: unknown[] = [];
    const ticks = await readNeoWatchEventTicks(
      watched,
      prEvent(7, 'closed', { merged: true }),
      async (refs) => {
        reads.push(refs);
        return [{ url: pull(8), kind: 'pr', state: 'OPEN', at: null, done: false, closedBy: null }];
      }
    );
    expect(ticks).toEqual([
      { id: 'i1', evidence: `Watched: ${pull(7)} merged (event event-7-closed: PR #7 closed)` },
    ]);
    expect(reads).toEqual([[{ owner: 'lsm', repo: 'HyperNeo', number: 8 }]]);
  });

  test('reads nothing for an event no live item watches or one that is not a merge', async () => {
    const reader = mock(async () => []);
    const watched = ask([item('i1', { watch: [pull(7)] })]);
    expect(
      await readNeoWatchEventTicks(watched, prEvent(8, 'closed', { merged: true }), reader)
    ).toEqual([]);
    expect(await readNeoWatchEventTicks(watched, prEvent(7, 'closed', {}), reader)).toEqual([]);
    expect(reader).not.toHaveBeenCalled();
  });
});

describe('neoWatchTopics', () => {
  test('follows the watched PRs of open items, never issues, met items or deploy items', () => {
    expect(
      neoWatchTopics(
        ask([
          item('i1', { watch: [pull(7), 'https://github.com/lsm/HyperNeo/issues/3'] }),
          item('i2', { watch: [pull(8)], state: 'met' }),
          item('i3', { watch: [pull(9)], check: 'coding.deployed' }),
        ])
      )
    ).toEqual(['github/lsm/HyperNeo/pull_request/7.*']);
    expect(isNeoWatchItem(item('i3', { watch: [pull(9)], check: 'coding.deployed' }))).toBe(false);
  });
});

describe('deploy checks', () => {
  const deployItem = (extra: Partial<NeoAskItem> = {}) =>
    item('i1', { check: 'coding.deployed', ...extra });
  const read = (daemons: NeoDeployRead['daemons'], mergeCommit: string | null = MERGE) => ({
    prs: [{ url: pull(7), mergeCommit }],
    daemons,
  });

  test("checks a deploy item's watched PRs, else the ask's card PRs", () => {
    expect(
      planNeoDeployChecks(ask([deployItem({ watch: [pull(7)] })]), [pull(8)]).map(
        (plan) => plan.urls
      )
    ).toEqual([[pull(7)]]);
    expect(
      planNeoDeployChecks(ask([deployItem()]), [pull(8), pull(8)]).map((plan) => plan.urls)
    ).toEqual([[pull(8)]]);
    expect(planNeoDeployChecks(ask([deployItem({ state: 'met' })]), [pull(8)])).toEqual([]);
  });

  test('is met only when every daemon runs a commit containing every merge', () => {
    const plan = { item: deployItem(), urls: [pull(7)] };
    const laptop = { daemon: 'm5', commit: RUNNING, contains: [MERGE] };
    expect(judgeNeoDeployCheck(plan, read([laptop, { ...laptop, daemon: 'tts' }]))).toEqual({
      id: 'i1',
      evidence: `Deployed: ${pull(7)} (aaaaaaaaaa) runs on m5 at bbbbbbbbbb, tts at bbbbbbbbbb`,
    });
    expect(
      judgeNeoDeployCheck(plan, read([laptop, { daemon: 'tts', commit: null, contains: [] }]))
    ).toBe(null);
    expect(
      judgeNeoDeployCheck(plan, read([laptop, { daemon: 'tts', commit: RUNNING, contains: [] }]))
    ).toBe(null);
    expect(judgeNeoDeployCheck(plan, read([laptop], null))).toBe(null);
    expect(judgeNeoDeployCheck(plan, read([]))).toBe(null);
  });

  test('reads the merge commit and asks GitHub whether each running commit contains it', async () => {
    const calls: string[][] = [];
    const spawn = ((args: string[]) => {
      calls.push(args);
      const body =
        args[1] === 'pr'
          ? { state: 'MERGED', mergeCommit: { oid: MERGE } }
          : {
              status: args[2].endsWith(RUNNING) ? 'ahead' : 'behind',
            };
      return {
        stdout: new Response(JSON.stringify(body)).body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as unknown as SpawnFn;
    const old = 'c'.repeat(40);
    const deployed = await readGithubDeploys(
      [pull(7123)],
      async () => [
        { daemon: 'm5', commit: RUNNING },
        { daemon: 'tts', commit: old },
        { daemon: 'gone', commit: null },
      ],
      spawn
    );
    expect(deployed).toEqual({
      prs: [{ url: pull(7123), mergeCommit: MERGE }],
      daemons: [
        { daemon: 'm5', commit: RUNNING, contains: [MERGE] },
        { daemon: 'tts', commit: old, contains: [] },
        { daemon: 'gone', commit: null, contains: [] },
      ],
    });
    expect(calls.map((args) => args.slice(0, 4))).toEqual([
      ['gh', 'pr', 'view', pull(7123)],
      ['gh', 'api', `repos/lsm/HyperNeo/compare/${MERGE}...${RUNNING}`],
      ['gh', 'api', `repos/lsm/HyperNeo/compare/${MERGE}...${old}`],
    ]);
  });
});

describe('readNeoDaemonCommits', () => {
  test('reads this daemon and every attached one; one that cannot answer runs nothing known', async () => {
    const remotes = {
      list: () => [
        { daemonId: 'tts', url: 'ws://tts' },
        { daemonId: 'down', url: 'ws://down' },
        { daemonId: 'odd', url: 'ws://odd' },
      ],
      request: mock(async (daemonId: string) => {
        if (daemonId === 'down') throw new Error('unreachable');
        return { system: { commit: daemonId === 'tts' ? RUNNING : 'unknown' } };
      }),
    };
    expect(await readNeoDaemonCommits({ name: 'm5', commit: MERGE }, remotes)).toEqual([
      { daemon: 'm5', commit: MERGE },
      { daemon: 'tts', commit: RUNNING },
      { daemon: 'down', commit: null },
      { daemon: 'odd', commit: null },
    ]);
    expect(remotes.request.mock.calls[0]).toEqual([
      'tts',
      'state.global.snapshot',
      { includeSessions: false },
      { timeoutMs: 5000 },
    ]);
  });
});

describe('neoDaemonTickPath', () => {
  test('names how the daemon reads an item, or null when only Neo or the human can', () => {
    expect(neoDaemonTickPath(item('i', { check: 'coding.deployed', watch: [pull(1)] }))).toBe(
      'check'
    );
    expect(neoDaemonTickPath(item('i', { watch: [pull(1)] }))).toBe('watch');
    expect(neoDaemonTickPath(item('i', { text: 'Deployed to the iMac' }))).toBe(
      'needs_deploy_check'
    );
    expect(neoDaemonTickPath(item('i', { text: 'lsm/HyperNeo#6700 merged' }))).toBe('needs_watch');
    expect(neoDaemonTickPath(item('i', { text: `${pull(3)} closed` }))).toBe('needs_watch');
    expect(neoDaemonTickPath(item('i', { text: 'Installed on the iPhone via TestFlight' }))).toBe(
      null
    );
    expect(neoDaemonTickPath(item('i', { text: 'The copy reads well' }))).toBe(null);
    expect(neoDaemonTickPath(item('i', { check: 'life-admin.confirmed' }))).toBe(null);
  });
});

describe('planNeoDaemonCardSettle', () => {
  const merged = {
    evidence: [{ key: pull(7), state: 'done' as const, summary: 'merged', blockers: [] }],
    read: { ok: true, okAt: 1 },
  };
  const waiting = ask([
    item('i1', { state: 'met' }),
    item('i2', { watch: [pull(8)] }),
    item('i3', { question: 'Did it work?' }),
  ]);

  test('closes a merged card when every open item waits on the daemon or the human', () => {
    const settle = planNeoDaemonCardSettle({ report: 'Merged it.' }, merged, waiting);
    expect(settle).toEqual({
      report: `Closed as done by the daemon: ${pull(7)} merged.\n\nMerged it.`,
    });
    expect(requireNeoCardTurn(settle, 'goal')).toEqual({ reason: 'daemon_settled' });
  });

  test('leaves the card to Neo while it is unmerged, unread, a deploy or a judgement is open, or nothing is', () => {
    const cases: [typeof merged | null, NeoAsk | null][] = [
      [{ ...merged, evidence: [{ ...merged.evidence[0], state: 'ready' }] }, waiting],
      [{ ...merged, read: { ok: false, okAt: 1 } }, waiting],
      [null, waiting],
      [merged, ask([item('i1', { check: 'coding.deployed' })])],
      [merged, ask([item('i1', { text: 'Docs updated' })])],
      [merged, ask([item('i1', { state: 'met' })])],
      [merged, null],
    ];
    for (const [read, current] of cases) {
      const settle = planNeoDaemonCardSettle({ report: null }, read, current);
      expect(settle).toEqual({ report: null });
      expect(requireNeoCardTurn(settle, 'goal')).toEqual({ value: 'goal' });
    }
  });
});

describe('Neo ask event ticks', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let service: NeoService;
  let publisher: ExternalEventService;

  beforeEach(async () => {
    db = await createTestDb();
    db.createSession(createTestSession('neo:root'));
    bus = new InternalEventBus<DaemonInternalEventMap>();
    service = new NeoService(
      db,
      { createSession: mock(), getSessionAsync: mock() } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      bus
    );
    publisher = new ExternalEventService(new SessionExternalEventStore(db.getDatabase()), bus);
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  function openWatch(id: string) {
    return service.askRecords.open(
      {
        id,
        requestKey: `k-${id}`,
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'm0',
        title: 'Land it',
        ask: 'Land the fix',
        doneWhen: '- merged',
        doneSource: 'human',
      },
      [{ text: 'Fix merged', check: null, watch: [pull(7)] }]
    )!;
  }

  test('follows the watched PR so its events reach the daemon', async () => {
    openWatch('a-follow');
    const watched: string[] = [];
    service.watchExternalTopic = async (topic) => {
      watched.push(topic);
    };
    service.readRefStates = async () => [];
    Object.assign(service, { deliver: async () => {} });
    expect(service.followedTopics()).toEqual(['github/lsm/HyperNeo/pull_request/7.*']);
    await service.refreshDriverWork();
    await service.refreshDriverWork();
    expect(watched).toEqual(['github/lsm/HyperNeo/pull_request/7.*']);
  });

  test('follows a PR again when a later ask watches it after the first stopped', async () => {
    const first = openWatch('a-first');
    const watched: string[] = [];
    service.watchExternalTopic = async (topic) => {
      watched.push(topic);
    };
    service.readRefStates = async () => [];
    Object.assign(service, { deliver: async () => {} });
    await service.refreshDriverWork();
    service.askRecords.tickItem(
      first.id,
      { id: 'i1', state: 'met', evidence: 'merged', metBy: 'daemon' },
      Date.now()
    );
    await service.refreshDriverWork();
    expect(service.followedTopics()).toEqual([]);
    openWatch('a-again');
    await service.refreshDriverWork();
    expect(watched).toEqual([
      'github/lsm/HyperNeo/pull_request/7.*',
      'github/lsm/HyperNeo/pull_request/7.*',
    ]);
  });

  test('ticks the watched item met on its merge event, without a read', async () => {
    const opened = openWatch('a-event');
    const reader = mock(async () => []);
    service.readRefStates = reader;
    await publisher.publish(prEvent(7, 'closed', { merged: true }));
    expect(service.askRecords.get(opened.id)?.doneItems?.[0]).toMatchObject({
      state: 'met',
      metBy: 'daemon',
      evidence: `Watched: ${pull(7)} merged (event event-7-closed: PR #7 closed)`,
    });
    expect(reader).not.toHaveBeenCalled();
  });

  test('a close without merge leaves the item pending', async () => {
    const opened = openWatch('a-closed');
    await publisher.publish(prEvent(7, 'closed', { merged: false, state: 'closed' }));
    expect(service.askRecords.get(opened.id)?.doneItems?.[0].state).toBe('pending');
  });
});
