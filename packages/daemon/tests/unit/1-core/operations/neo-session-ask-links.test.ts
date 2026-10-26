import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import type { PlaceGroup, WorkStatus } from '../../../../src/lib/drivers/types.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import {
  keepNeoSessionPrs,
  NEO_SESSION_PR_READS_MAX,
  NEO_SESSION_PR_RECHECK_MS,
  planNeoSessionPrReads,
} from '../../../../src/lib/neo/session-ask-links.ts';
import { type NeoListedSession, neoSessionKey } from '../../../../src/lib/neo/session-watch.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const pr = (number: number) => `https://github.com/lsm/HyperNeo/pull/${number}`;
const listed = (id: string, overrides: Partial<NeoListedSession> = {}): NeoListedSession => ({
  key: neoSessionKey({ adapter: 'codex-desktop', id }),
  ref: { adapter: 'codex-desktop', id },
  title: id,
  status: 'running',
  lastActivityAt: 1,
  link: `codex://threads/${id}`,
  ...overrides,
});

describe('planNeoSessionPrReads', () => {
  test('reads sessions with no known PRs, those needing the human first, within a bound', () => {
    const sessions = [
      listed('known'),
      listed('reading'),
      listed('old', { lastActivityAt: 1 }),
      listed('new', { lastActivityAt: 5 }),
      listed('stuck', { status: 'needs_you', lastActivityAt: 0 }),
    ];
    const checked = new Map([[sessions[0]!.key, 100]]);
    const plan = planNeoSessionPrReads(
      sessions,
      new Map([[sessions[0]!.key, []]]),
      [sessions[1]!],
      checked,
      100
    );
    expect(plan.map((session) => session.title)).toEqual(['stuck', 'new', 'old']);
    const many = Array.from({ length: NEO_SESSION_PR_READS_MAX + 3 }, (_, i) => listed(`s${i}`));
    expect(planNeoSessionPrReads(many, new Map(), [], new Map(), 0)).toHaveLength(
      NEO_SESSION_PR_READS_MAX
    );
  });

  test('reads every known session again after a while, so later PRs are found too', () => {
    const empty = listed('empty');
    const found = listed('found');
    const known = new Map([
      [empty.key, []],
      [found.key, ['https://github.com/o/r/pull/1']],
    ]);
    const checked = new Map([
      [empty.key, 0],
      [found.key, 0],
    ]);
    expect(planNeoSessionPrReads([empty, found], known, [], checked, 1)).toEqual([]);
    expect(
      planNeoSessionPrReads([empty, found], known, [], checked, NEO_SESSION_PR_RECHECK_MS).map(
        (session) => session.title
      )
    ).toEqual(['empty', 'found']);
  });
});

describe('keepNeoSessionPrs', () => {
  test('adds what a read found to what was known, once per PR', () => {
    const kept = keepNeoSessionPrs(
      new Map([['a', [pr(1)]]]),
      new Map([
        ['a', [pr(1).toUpperCase(), pr(2)]],
        ['b', []],
      ])
    );
    expect(kept).toEqual(
      new Map([
        ['a', [pr(1).toUpperCase(), pr(2)]],
        ['b', []],
      ])
    );
  });
});

describe('ReturnType<typeof createNeoService> session ask links', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: ReturnType<typeof createNeoService>;
  let sessions: PlaceGroup['work'];
  let status: { status: WorkStatus; lastActivityAt: number; openedPrs?: string[] };
  const events: Array<[string, unknown]> = [];
  const ref = { adapter: 'codex-desktop', id: 't1' };
  const key = neoSessionKey(ref);
  const human = { source: 'rpc' as const, principal: 'local' as const };
  const invoke = (name: string, input: unknown) =>
    invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, human);
  const watch = async (state: WorkStatus, at: number, openedPrs: string[]) => {
    sessions = [
      {
        ref,
        title: 'Ship the fix',
        place: { machine: 'laptop', folder: '/repo', name: 'repo' },
        status: state,
        lastActivityAt: at,
        link: 'codex://threads/t1',
      },
    ];
    status = { status: state, lastActivityAt: at, openedPrs };
    await service.refreshDriverWork();
  };
  const notices = () => events.filter(([name]) => name === 'neo.session.notice');

  beforeEach(async () => {
    db = await createTestDb();
    await db.createSession(createTestSession('neo:root'));
    events.length = 0;
    sessions = [];
    status = { status: 'running', lastActivityAt: 0 };
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.find',
        description: 'test find',
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async () => ({
          places: [
            {
              place: { machine: 'laptop', folder: '/repo', name: 'repo' },
              lastActivityAt: Date.now(),
              openCount: sessions.length,
              archivedCount: 0,
              adapters: ['codex-desktop'],
              work: sessions,
            },
          ],
          unreachable: [],
        }),
      }),
      defineOperation({
        name: 'work.status',
        description: 'test status',
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async (input: Record<string, unknown>) =>
          (input.ref as { id?: string }).id === 't1'
            ? { ok: true, value: status }
            : { ok: false, reason: 'not_found', detail: 'gone' },
      }),
    ]);
    service = createNeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      {
        event: mock((name: string, payload: unknown) => {
          events.push([name, payload]);
        }),
      } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.readPrs = async () => [];
    service.readRefStates = async () => [];
    service.readBranchPrs = async () => [];
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    await db.createSession(createTestSession('neo:inbox'));
    service.repo.saveProject({ id: 'inbox', title: 'Inbox', summary: '', context: '' }, 0);
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  test('a PR a session without a todo opened gets that session as its ledger owner', async () => {
    const raw = db.getDatabase();
    raw
      .prepare(
        "UPDATE neo_pack_preferences SET value_json = ? WHERE pack = 'coding' AND key = 'watchedRepos'"
      )
      .run(JSON.stringify([pr(12).split('/').slice(3, 5).join('/').toLowerCase()]));
    raw
      .prepare(
        `INSERT INTO pack_coding_pr_ledger (repo, number, title, branch, head, state, state_since, read_at)
         VALUES (?, 12, 'Fix', 'b', 'h', 'waiting_review', 1, 1)`
      )
      .run(pr(12).split('/').slice(3, 5).join('/').toLowerCase());
    await watch('running', Date.now() - 1_000, [pr(12)]);
    expect(raw.prepare('SELECT owner FROM pack_coding_pr_ledger').get()).toEqual({
      owner: JSON.stringify(ref),
    });
    await watch('running', Date.now() - 500, []);
    expect(raw.prepare('SELECT owner FROM pack_coding_pr_ledger').get()).toEqual({
      owner: JSON.stringify(ref),
    });
  });
});
