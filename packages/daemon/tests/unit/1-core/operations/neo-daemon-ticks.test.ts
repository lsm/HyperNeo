import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service.ts';
import { SessionExternalEventStore } from '../../../../src/lib/external-events/session-external-event-store.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { readNeoDaemonCommits } from '../../../../src/lib/neo/daemon-commits.ts';
import {
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
      ['gh', 'api', `repos/lsm/HyperNeo/compare/${MERGE}...${RUNNING}`, '--include'],
      ['gh', 'api', `repos/lsm/HyperNeo/compare/${MERGE}...${old}`, '--include'],
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
