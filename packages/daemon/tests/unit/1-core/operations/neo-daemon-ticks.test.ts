import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  NEO_WORK_CLOSED_BY_DAEMON,
  planNeoCardDaemonSettle,
  requireNeoCardDaemonUnsettled,
} from '../../../../src/lib/neo/card-settle.ts';
import type { NeoEvidence } from '../../../../src/lib/neo/evidence.ts';
import type { NeoRefState } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import {
  judgeNeoDeployTick,
  neoDeployTargets,
  parseNeoDeployChange,
  readNeoDeployTicks,
  type NeoDeployReaders,
} from '../../../../src/lib/neo/packs/coding/deploy-checks.ts';
import {
  neoCardIssueRef,
  readNeoCardIssueEvidence,
} from '../../../../src/lib/neo/packs/coding/issue-checks.ts';
import {
  neoWatchEventState,
  neoWatchTopics,
  readNeoWatchEventTicks,
} from '../../../../src/lib/neo/packs/coding/watch-checks.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import {
  createDaemonBuildOperation,
  readKnownDaemonBuilds,
  type DaemonBuild,
  type DaemonBuildDeps,
} from '../../../../src/lib/remote-daemons/build-operation.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const pull = (n: number) => `https://github.com/lsm/HyperNeo/pull/${n}`;
const issue = (n: number) => `https://github.com/lsm/HyperNeo/issues/${n}`;
const MERGE = 'a'.repeat(40);
const AHEAD = 'b'.repeat(40);
const BEHIND = 'c'.repeat(40);

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
const ask = (id: string, items: NeoAskItem[]): NeoAsk => ({
  id,
  requestKey: `k-${id}`,
  concernId: null,
  originSessionId: 'neo:root',
  originMessageId: 'm0',
  title: 'Ship it',
  ask: 'Ship the fix',
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
const build = (daemonId: string, commit: string | null, self = false): DaemonBuild => ({
  daemonId,
  self,
  version: '1.0.0',
  commit,
});
const readers = (daemons: DaemonBuild[], merged: string | null = MERGE): NeoDeployReaders => ({
  readDaemons: vi.fn(async () => daemons),
  readChangeCommit: vi.fn(async () => merged),
  readContains: vi.fn(async (_change, _sha, running: string) =>
    running === AHEAD ? true : running === BEHIND ? false : null
  ),
});
const prClosed = (n: number, merged: boolean, action = 'closed'): ExternalEvent => ({
  id: `evt-${n}`,
  spaceId: 'session',
  topic: `github/lsm/hyperneo/pull_request/${n}.${action}`,
  occurredAt: 9_000,
  ingestedAt: 9_000,
  source: 'github',
  sourceEventId: `delivery-${n}`,
  dedupeKey: `lsm/hyperneo:pull_request:${n}:closed`,
  summary: `PR #${n} closed`,
  externalUrl: pull(n),
  payload: { merged, state: 'closed', prUrl: pull(n) },
});

describe('parseNeoDeployChange', () => {
  test('reads a pull request or commit URL, and nothing else', () => {
    expect(parseNeoDeployChange(pull(9))).toMatchObject({ owner: 'lsm', pr: 9, sha: null });
    expect(
      parseNeoDeployChange(`https://github.com/lsm/HyperNeo/commit/${MERGE.slice(0, 12)}`)
    ).toMatchObject({ pr: null, sha: MERGE.slice(0, 12) });
    expect(parseNeoDeployChange(issue(9))).toBeNull();
  });
});

describe('neoDeployTargets', () => {
  const daemons = [build('laptop', AHEAD, true), build('imac', AHEAD)];
  test('defaults to every known daemon and matches named ones whatever their case', () => {
    expect(neoDeployTargets({ deploy: { change: pull(1) } }, daemons)).toEqual({ value: daemons });
    expect(neoDeployTargets({ deploy: { change: pull(1), daemons: ['iMac'] } }, daemons)).toEqual({
      value: [daemons[1]],
    });
    expect(neoDeployTargets({ deploy: { change: pull(1), daemons: ['tts'] } }, daemons)).toEqual({
      reason: ['tts'],
    });
  });
});

describe('judgeNeoDeployTick', () => {
  test('ticks only when every target runs a commit containing the change', () => {
    const deploy = item('i1', { deploy: { change: pull(9) } });
    const targets = [build('laptop', AHEAD, true), build('imac', BEHIND)];
    const change = { url: pull(9), sha: MERGE };
    expect(
      judgeNeoDeployTick(
        deploy,
        change,
        targets,
        new Map([
          [AHEAD, true],
          [BEHIND, false],
        ])
      )
    ).toBeNull();
    expect(judgeNeoDeployTick(deploy, change, [targets[0]], new Map([[AHEAD, true]]))).toEqual({
      id: 'i1',
      evidence: `Running ${pull(9)} (aaaaaaa) on laptop at bbbbbbb, read back by the daemon.`,
    });
    expect(judgeNeoDeployTick(deploy, change, [], new Map())).toBeNull();
  });
});

describe('readNeoDeployTicks', () => {
  test('ticks a deploy item once both daemons run the merged change', async () => {
    const shipped = ask('deploy-both', [item('i1', { deploy: { change: pull(9) } })]);
    const read = readers([build('laptop', AHEAD, true), build('imac', MERGE)]);
    expect(await readNeoDeployTicks(shipped, read, 10_000)).toEqual([
      {
        id: 'i1',
        evidence: `Running ${pull(9)} (aaaaaaa) on laptop at bbbbbbb, imac at aaaaaaa, read back by the daemon.`,
      },
    ]);
    expect(read.readContains).toHaveBeenCalledTimes(1);
    expect(await readNeoDeployTicks(shipped, read, 60_000)).toEqual([]);
    expect(read.readDaemons).toHaveBeenCalledTimes(1);
  });

  test('leaves the item pending while a daemon is behind, unreachable, or the PR is unmerged', async () => {
    const pending = (id: string) => ask(id, [item('i1', { deploy: { change: pull(9) } })]);
    expect(
      await readNeoDeployTicks(
        pending('deploy-behind'),
        readers([build('laptop', AHEAD, true), build('imac', BEHIND)]),
        10_000
      )
    ).toEqual([]);
    expect(
      await readNeoDeployTicks(
        pending('deploy-down'),
        readers([build('laptop', AHEAD, true), build('imac', null)]),
        10_000
      )
    ).toEqual([]);
    const unmerged = readers([build('laptop', AHEAD, true)], null);
    expect(await readNeoDeployTicks(pending('deploy-open'), unmerged, 10_000)).toEqual([]);
    expect(unmerged.readContains).not.toHaveBeenCalled();
  });

  test('checks only the daemons the item names', async () => {
    const named = ask('deploy-named', [
      item('i1', { deploy: { change: pull(9), daemons: ['laptop'] } }),
    ]);
    expect(
      await readNeoDeployTicks(
        named,
        readers([build('laptop', AHEAD, true), build('imac', BEHIND)]),
        10_000
      )
    ).toMatchObject([{ id: 'i1' }]);
  });
});

describe('readKnownDaemonBuilds', () => {
  const deps = (invoke: DaemonBuildDeps['registry']['invoke']): DaemonBuildDeps => ({
    self: { name: 'laptop', version: '1.0.0', commit: AHEAD },
    registry: { list: () => [{ daemonId: 'imac', url: 'ws://imac' }], invoke },
  });

  test('reads this daemon and each remote, saying why a remote has no commit', async () => {
    const invoke = vi.fn(async () => ({
      kind: 'read',
      daemons: [build('imac.local', MERGE, true)],
    }));
    expect(await readKnownDaemonBuilds(deps(invoke))).toEqual([
      build('laptop', AHEAD, true),
      build('imac', MERGE),
    ]);
    expect(invoke).toHaveBeenCalledWith(
      'imac',
      'daemon.build',
      { remotes: false },
      {
        timeoutMs: 5000,
      }
    );
    const down = await readKnownDaemonBuilds(
      deps(async () => {
        throw new Error('connect refused');
      })
    );
    expect(down[1]).toMatchObject({
      daemonId: 'imac',
      commit: null,
      reason: 'unreachable: connect refused',
    });
    expect(await readKnownDaemonBuilds(deps(invoke), false)).toHaveLength(1);
  });
});

describe('createDaemonBuildOperation', () => {
  test('answers RPC and Neo callers and refuses other agents', async () => {
    const registry = createOperationRegistry([
      createDaemonBuildOperation({
        self: { name: 'laptop', version: '1.0.0', commit: 'unknown' },
        registry: { list: () => [], invoke: vi.fn() },
      }),
    ]);
    expect(
      await invokeOperation(registry, 'daemon.build', {}, { source: 'rpc', principal: 'local' })
    ).toEqual({
      kind: 'completed',
      value: { kind: 'read', daemons: [{ ...build('laptop', null, true) }] },
    });
    expect(
      await invokeOperation(
        registry,
        'daemon.build',
        {},
        { source: 'mcp', sessionId: 's1', role: 'workflow_worker' }
      )
    ).toEqual({ kind: 'completed', value: { kind: 'rejected', reason: 'daemon_build_forbidden' } });
  });
});

describe('neoWatchEventState', () => {
  test('reads a merged or closed PR from its closed event, and ignores other events', () => {
    expect(neoWatchEventState(prClosed(7, true))).toMatchObject({
      url: 'https://github.com/lsm/hyperneo/pull/7',
      state: 'MERGED',
      done: true,
      event: 'evt-7',
    });
    expect(neoWatchEventState(prClosed(7, false))).toMatchObject({ state: 'CLOSED', done: false });
    expect(neoWatchEventState(prClosed(7, true, 'review_submitted'))).toBeNull();
  });
});

describe('neoWatchTopics', () => {
  test('follows the pull requests an ask watches', () => {
    expect(neoWatchTopics(ask('topics', [item('i1', { watch: [pull(7), issue(8)] })]))).toEqual([
      'github/lsm/HyperNeo/pull_request/7.*',
      'github/lsm/HyperNeo/pull_request/8.*',
    ]);
  });
});

describe('readNeoWatchEventTicks', () => {
  test('ticks an item on the merge event, citing it, and reads its other watched refs', async () => {
    const watched = ask('event-ticks', [
      item('i1', { watch: [pull(7)] }),
      item('i2', { watch: [pull(7), issue(8)] }),
      item('i3', { watch: [pull(9)] }),
    ]);
    const closedIssue: NeoRefState = {
      url: issue(8),
      kind: 'issue',
      state: 'CLOSED',
      at: 8_000,
      done: true,
      closedBy: null,
    };
    const read = vi.fn(async () => [closedIssue]);
    expect(await readNeoWatchEventTicks(watched, prClosed(7, true), read)).toEqual([
      {
        id: 'i1',
        evidence: 'Watched: https://github.com/lsm/hyperneo/pull/7 merged (event evt-7)',
      },
      {
        id: 'i2',
        evidence: `Watched: https://github.com/lsm/hyperneo/pull/7 merged (event evt-7); ${issue(8)} closed as completed`,
      },
    ]);
    expect(read).toHaveBeenCalledWith([
      { owner: 'lsm', repo: 'HyperNeo', number: 8 },
      { owner: 'lsm', repo: 'HyperNeo', number: 9 },
    ]);
    expect(await readNeoWatchEventTicks(watched, prClosed(7, false), read)).toEqual([]);
    expect(await readNeoWatchEventTicks(watched, prClosed(5, true), read)).toEqual([]);
  });
});

describe('planNeoCardDaemonSettle', () => {
  const done = (key: string): NeoEvidence => ({
    key,
    state: 'done',
    summary: 'merged, checks passing, review approved',
    blockers: [],
  });
  const card = { status: 'reported' as const, report: 'Merged it.' };
  const read = (evidence: NeoEvidence[], daemonRead = true) => ({
    read: {
      evidence,
      read: { ok: true, okAt: 1 },
      ...(daemonRead ? { daemonRead: true as const } : {}),
    },
  });

  test('settles a reported card once everything the daemon read is done', () => {
    expect(planNeoCardDaemonSettle(card, read([done(pull(1)), done(pull(2))]))).toEqual({
      report: `${NEO_WORK_CLOSED_BY_DAEMON}${pull(1)} merged, checks passing, review approved; ${pull(2)} merged, checks passing, review approved.\n\nMerged it.`,
    });
  });

  test("leaves a card to Neo when evidence is open, unread, the agent's word, or the card is live", () => {
    const open: NeoEvidence = { ...done(pull(2)), state: 'waiting' };
    expect(planNeoCardDaemonSettle(card, read([done(pull(1)), open]))).toBeNull();
    expect(planNeoCardDaemonSettle(card, read([]))).toBeNull();
    expect(planNeoCardDaemonSettle(card, { read: null })).toBeNull();
    expect(planNeoCardDaemonSettle(card, read([done('confirmation:1')], false))).toBeNull();
    expect(
      planNeoCardDaemonSettle({ ...card, status: 'queued' }, read([done(pull(1))]))
    ).toBeNull();
    expect(
      planNeoCardDaemonSettle(
        { ...card, report: 'Closed as done by the user.' },
        read([done(pull(1))])
      )
    ).toBeNull();
  });
});

describe('requireNeoCardDaemonUnsettled', () => {
  test('stops the done check only for a settled card', () => {
    expect(requireNeoCardDaemonUnsettled(null, 'goal')).toEqual({ value: 'goal' });
    expect(requireNeoCardDaemonUnsettled({ report: 'x' }, 'goal')).toEqual({
      reason: 'daemon_settled',
    });
  });
});

describe('readNeoCardIssueEvidence', () => {
  const work = (instruction: string): Pick<NeoWork, 'status' | 'instruction'> => ({
    status: 'reported',
    instruction,
  });

  test('reads the one issue a card names, as done once it closed as completed', async () => {
    expect(neoCardIssueRef(work(`Fix ${issue(4)} and ${issue(5)}.`))).toBeNull();
    const closed: NeoRefState = {
      url: issue(4),
      kind: 'issue',
      state: 'CLOSED',
      at: 5_000,
      done: true,
      closedBy: pull(10),
    };
    expect(
      await readNeoCardIssueEvidence(work(`Fix ${issue(4)}.`), async () => [closed], 7)
    ).toEqual({
      evidence: [
        {
          key: issue(4),
          state: 'done',
          summary: `closed as completed by ${pull(10)}`,
          blockers: [],
        },
      ],
      read: { ok: true, okAt: 7 },
      daemonRead: true,
    });
    expect(
      await readNeoCardIssueEvidence(
        work(`Fix ${issue(4)}.`),
        async () => [{ ...closed, state: 'OPEN', done: false }],
        7
      )
    ).toBeNull();
  });
});

describe('NeoService daemon ticks', () => {
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
    Object.assign(service, { deliver: async () => {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    db.close();
  });

  const open = (id: string, items: Parameters<typeof service.askRecords.open>[1]) =>
    service.askRecords.open(
      {
        id,
        requestKey: `k-${id}`,
        concernId: null,
        originSessionId: 'neo:root',
        originMessageId: 'm0',
        title: 'Ship',
        ask: 'Ship the fix',
        doneWhen: '- deployed',
        doneSource: 'human',
      },
      items
    )!;

  test('refreshDriverWork ticks a deploy item met by the daemon from its readback', async () => {
    const opened = open('svc-deploy', [
      { text: 'Running on both daemons', check: null, deploy: { change: pull(6705) } },
    ]);
    service.readDeploy = readers([build('laptop', AHEAD, true), build('imac', MERGE)]);
    await service.refreshDriverWork();
    expect(service.askRecords.get(opened.id)?.doneItems?.[0]).toMatchObject({
      state: 'met',
      metBy: 'daemon',
      evidence: expect.stringContaining('read back by the daemon'),
    });
  });

  test('a merge event ticks a watched item at once and the ask follows its topic', async () => {
    const opened = open('svc-event', [{ text: 'PR merged', check: null, watch: [pull(7)] }]);
    expect(service.followedTopics()).toContain('github/lsm/HyperNeo/pull_request/7.*');
    const event = prClosed(7, true);
    Object.assign(service, {
      sessionEvents: { getById: (id: string) => (id === event.id ? { event } : null) },
    });
    const tick = (
      service as unknown as { tickAsksOnEvent: (p: { eventId: string }) => Promise<unknown> }
    ).tickAsksOnEvent;
    await tick({ eventId: event.id });
    expect(service.askRecords.get(opened.id)?.doneItems?.[0]).toMatchObject({
      state: 'met',
      metBy: 'daemon',
      evidence: 'Watched: https://github.com/lsm/hyperneo/pull/7 merged (event evt-7)',
    });
  });
});
