import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service.ts';
import { SessionExternalEventStore } from '../../../../src/lib/external-events/session-external-event-store.ts';
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
  test('reads only the check and the watch, never the words', () => {
    expect(neoDaemonTickPath(item('i', { check: 'coding.deployed', watch: [pull(1)] }))).toBe(
      'check'
    );
    expect(neoDaemonTickPath(item('i', { check: 'life-admin.confirmed' }))).toBe('check');
    expect(neoDaemonTickPath(item('i', { watch: [pull(1)] }))).toBe('watch');
    for (const text of ['Deployed to the iMac', 'lsm/HyperNeo#6700 merged', `${pull(3)} closed`])
      expect(neoDaemonTickPath(item('i', { text }))).toBe(null);
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
