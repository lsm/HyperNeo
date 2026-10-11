import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  keepNeoSessionNoticeGroups,
  keepNeoSessionNotices,
  listNeoWatchedSessions,
  NEO_SESSION_GROUP_MS,
  NEO_SESSION_GROUPS_MAX,
  NEO_SESSION_NOTICES_MAX,
  NEO_SESSION_RUN_MS,
  neoSessionKey,
  neoSessionNoticeLine,
  planNeoSessionNotice,
  planNeoSessionNoticeGroup,
  planNeoSessionWatch,
  savedNeoSessionNoticeGroups,
  type NeoListedSession,
  type NeoSessionNotice,
  type NeoSessionSeen,
} from '../../../../src/lib/neo/session-watch.ts';
import type { PlaceGroup, WorkStatus } from '../../../../src/lib/drivers/types.ts';
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

const now = 10_000_000;
const ref = { adapter: 'codex-desktop', id: 't1' };
const work = (overrides: Partial<PlaceGroup['work'][number]> = {}): PlaceGroup['work'][number] => ({
  ref,
  title: 'Quiet-model research',
  place: { machine: 'laptop', folder: '/repo' },
  status: 'running',
  lastActivityAt: now - 1_000,
  link: 'codex://threads/t1',
  ...overrides,
});
const places = (items: PlaceGroup['work']): PlaceGroup[] => [
  {
    place: { machine: 'laptop', folder: '/repo' },
    lastActivityAt: now,
    openCount: items.length,
    archivedCount: 0,
    adapters: ['codex-desktop'],
    work: items,
  },
];
const session: NeoListedSession = {
  key: neoSessionKey(ref),
  ref,
  title: 'Quiet-model research',
  status: 'running',
  lastActivityAt: now - 1_000,
  link: 'codex://threads/t1',
};

describe('listNeoWatchedSessions', () => {
  test("lists the human's recent sessions, not Neo's cards or ones idle for a day", () => {
    const card = { adapter: 'codex-desktop', id: 'card' };
    expect(
      listNeoWatchedSessions(
        places([
          work(),
          work({ ref: card }),
          work({
            ref: { adapter: 'codex-desktop', id: 'old' },
            lastActivityAt: now - 25 * 3_600_000,
          }),
        ]),
        [card],
        now
      ).map((item) => item.key)
    ).toEqual([session.key]);
  });
});

describe('planNeoSessionWatch', () => {
  test('takes a first sighting as a baseline and reads only sessions that changed', () => {
    const seen = new Map<string, NeoSessionSeen>([
      ['same', { listed: 'running:1', status: 'running', runningSince: 0 }],
      [session.key, { listed: 'running:5', status: 'running', runningSince: 0 }],
    ]);
    const fresh = { ...session, key: 'fresh' };
    const same = { ...session, key: 'same', lastActivityAt: 1 };
    const plan = planNeoSessionWatch([fresh, same, session], seen, now);
    expect(plan.baseline).toEqual([
      [
        'fresh',
        { listed: `running:${session.lastActivityAt}`, status: 'running', runningSince: now },
      ],
    ]);
    expect(plan.reads.map((item) => item.key)).toEqual([session.key]);
  });
});

describe('planNeoSessionNotice', () => {
  const running: NeoSessionSeen = {
    listed: 'x',
    status: 'running',
    runningSince: now - NEO_SESSION_RUN_MS,
  };
  const read = (status: WorkStatus, lastInputAt: number | null = null) => ({ status, lastInputAt });
  test.each<[string, NeoSessionSeen, ReturnType<typeof read> | null, string | null]>([
    ['a session that now needs the human', running, read('needs_you'), 'needs_you'],
    ['a session that failed', running, read('failed'), 'failed'],
    ['a long run that finished', running, read('done'), 'finished'],
    ['a short run that finished', { ...running, runningSince: now - 60_000 }, read('done'), null],
    ['a session the human just wrote to', running, read('needs_you', now - 30_000), null],
    [
      'a session already needing the human',
      { ...running, status: 'needs_you' },
      read('needs_you'),
      null,
    ],
    ['a session that could not be read', running, null, null],
  ])('%s', (_label, prior, detail, kind) => {
    expect(planNeoSessionNotice(session, prior, detail, now).notice?.kind ?? null).toBe(kind);
  });

  test('keeps what it saw when the status read failed, so the next pass reads again', () => {
    expect(planNeoSessionNotice(session, running, null, now)).toEqual({
      seen: running,
      notice: null,
    });
  });

  test('holds a notice the human may be answering, and reads the session again next pass', () => {
    const planned = planNeoSessionNotice(session, running, read('needs_you', now - 30_000), now);
    expect(planned).toEqual({ seen: running, notice: null });
  });

  test('keeps when a run started while it goes on', () => {
    const idle: NeoSessionSeen = { listed: 'x', status: 'done', runningSince: null };
    const started = planNeoSessionNotice(session, idle, read('running'), now).seen;
    expect(started.runningSince).toBe(now);
    expect(planNeoSessionNotice(session, started, read('running'), now + 5).seen.runningSince).toBe(
      now
    );
  });
});

describe('keepNeoSessionNotices', () => {
  test('keeps the most recent notices only', () => {
    const notice = (at: number): NeoSessionNotice => ({ ...session, kind: 'finished', at });
    const kept = keepNeoSessionNotices(
      Array.from({ length: NEO_SESSION_NOTICES_MAX }, (_, index) => notice(index)),
      [notice(99)]
    );
    expect(kept).toHaveLength(NEO_SESSION_NOTICES_MAX);
    expect(kept.at(-1)?.at).toBe(99);
    expect(kept[0].at).toBe(1);
  });
});

const notice = (at: number, overrides: Partial<NeoSessionNotice> = {}): NeoSessionNotice => ({
  key: session.key,
  ref,
  title: 'Quiet-model research',
  kind: 'finished',
  at,
  link: 'codex://threads/t1',
  ...overrides,
});

describe('neoSessionNoticeLine', () => {
  test('names the app, the session and what happened, with Open only when it can be opened', () => {
    expect(
      neoSessionNoticeLine([
        notice(now),
        notice(now, {
          ref: { adapter: 'claude-desktop', id: 'c1' },
          title: 'Auth fix',
          kind: 'needs_you',
          link: undefined,
        }),
      ])
    ).toBe('Codex · Quiet-model research finished · Open; Claude · Auth fix needs you');
  });

  test('shows the first five and counts the rest', () => {
    const line = neoSessionNoticeLine(Array.from({ length: 7 }, (_, index) => notice(index)));
    expect(line.split('; ')).toHaveLength(6);
    expect(line.endsWith('; 2 more')).toBe(true);
  });
});

describe('planNeoSessionNoticeGroup', () => {
  test('notices within a minute of the last one join the open group', () => {
    const first = notice(now);
    const second = notice(now + NEO_SESSION_GROUP_MS - 1, { kind: 'failed' });
    expect(planNeoSessionNoticeGroup([first], [second], second.at)).toEqual({
      open: [first, second],
      closed: null,
    });
  });

  test('a minute without a new notice closes the group, and a new notice opens the next one', () => {
    const first = notice(now);
    const later = notice(now + NEO_SESSION_GROUP_MS, { kind: 'failed' });
    expect(planNeoSessionNoticeGroup([first], [later], later.at)).toEqual({
      open: [later],
      closed: {
        id: `neo-session-notices:${now}:${session.key}`,
        at: now,
        line: 'Codex · Quiet-model research finished · Open',
        notices: [first],
      },
    });
  });

  test('a group that would pass the notice cap closes early and the new notices start the next', () => {
    const open = Array.from({ length: NEO_SESSION_NOTICES_MAX }, (_, index) => notice(now + index));
    const added = [notice(now + 30, { kind: 'failed' })];
    const grouped = planNeoSessionNoticeGroup(open, added, now + 30);
    expect(grouped.open).toEqual(added);
    expect(grouped.closed?.notices).toEqual(open);
  });

  test('nothing open and nothing new leaves nothing to close', () => {
    expect(planNeoSessionNoticeGroup([], [], now)).toEqual({ open: [], closed: null });
  });
});

describe('keepNeoSessionNoticeGroups', () => {
  test('keeps the most recent closed groups only', () => {
    const group = (at: number) => ({ id: String(at), at, line: '', notices: [] });
    const kept = keepNeoSessionNoticeGroups(
      Array.from({ length: NEO_SESSION_GROUPS_MAX }, (_, index) => group(index)),
      group(99)
    );
    expect(kept).toHaveLength(NEO_SESSION_GROUPS_MAX);
    expect(kept.at(-1)?.at).toBe(99);
    expect(keepNeoSessionNoticeGroups(kept, null)).toEqual(kept);
  });
});

describe('savedNeoSessionNoticeGroups', () => {
  test('reads the group off each saved row and skips rows without one', () => {
    const group = { id: 'g1', at: now, line: 'Codex · x finished', notices: [notice(now)] };
    expect(
      savedNeoSessionNoticeGroups([{ group }, { group: { id: 'g2' } }, null, { type: 'system' }])
    ).toEqual([group]);
  });
});

describe('getLatestSDKMessagesByType', () => {
  test('returns the newest rows of one subtype, oldest first', async () => {
    const db = await createTestDb();
    try {
      db.createSession(createTestSession('neo:root'));
      const repo = db.getSDKMessageRepo();
      for (const id of ['g1', 'g2', 'g3'])
        repo.saveSDKMessage('neo:root', {
          type: 'system',
          subtype: 'session_notices',
          uuid: id,
          session_id: 'neo:root',
        } as never);
      const ids = repo
        .getLatestSDKMessagesByType('neo:root', 'system', 'session_notices', 2)
        .map((row) => (row as { uuid?: string }).uuid);
      expect(ids).toEqual(['g2', 'g3']);
    } finally {
      db.close();
    }
  });
});

describe('refreshDriverWork', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let listed: PlaceGroup['work'];
  let unreachable: { source: string; reason: string }[];
  let more: boolean;
  let status: { status: WorkStatus; lastActivityAt: number; recentInputs?: unknown[] };
  const events: Array<[string, unknown]> = [];

  beforeEach(async () => {
    db = await createTestDb();
    db.createSession(createTestSession('neo:root'));
    events.length = 0;
    listed = [];
    unreachable = [];
    more = false;
    status = { status: 'running', lastActivityAt: 0 };
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.find',
        description: 'test find',
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async () => ({ places: places(listed), unreachable, ...(more ? { more } : {}) }),
      }),
      defineOperation({
        name: 'work.status',
        description: 'test status',
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async () => ({ ok: true, value: status }),
      }),
    ]);
    service = new NeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      {
        event: mock((name: string, payload: unknown) => {
          events.push([name, payload]);
        }),
      } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', concernId: null });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  test("skips a session Neo's live card drives, and watches it again once the card is cancelled", async () => {
    const { work: card } = service.driverTargets.propose(
      service.repo,
      {
        id: 'w-card',
        requestKey: 'root:card',
        concernId: null,
        originSessionId: 'neo:root',
        title: 'Card',
        instruction: 'Do it.',
      },
      { verb: 'send', ref }
    );
    service.driverTargets.recordRef(card.id, ref);
    const queued = service.repo.transitionWork(card.id, card, { status: 'queued' })!;
    expect(service.driverTargets.cardRefs(0)).toEqual([{ workId: card.id, ref }]);
    service.repo.transitionWork(card.id, queued, { status: 'cancelled' });
    expect(service.driverTargets.cardRefs(0)).toEqual([]);
  });

  test('keeps what it saw when a listing comes back partial', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      listed = [work({ lastActivityAt: clock - 1_000 })];
      await service.refreshDriverWork();
      clock += NEO_SESSION_RUN_MS;
      listed = [];
      unreachable = [{ source: 'codex-desktop', reason: 'locked' }];
      await service.refreshDriverWork();
      unreachable = [];
      more = true;
      await service.refreshDriverWork();
      more = false;
      listed = [work({ status: 'done', lastActivityAt: clock - 1_000 })];
      status = { status: 'done', lastActivityAt: clock - 1_000 };
      await service.refreshDriverWork();
      expect(events.filter(([name]) => name === 'neo.session.notice')).toHaveLength(1);
    } finally {
      time.mockRestore();
    }
  });

  test('tells once when a session the human runs finishes a long run', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      listed = [work({ lastActivityAt: clock - 1_000 })];
      await service.refreshDriverWork();
      expect(events.filter(([name]) => name === 'neo.session.notice')).toEqual([]);

      clock += NEO_SESSION_RUN_MS;
      listed = [work({ status: 'done', lastActivityAt: clock - 1_000 })];
      status = { status: 'done', lastActivityAt: clock - 1_000 };
      await service.refreshDriverWork();
      const notices = events.filter(([name]) => name === 'neo.session.notice');
      expect(notices).toEqual([
        [
          'neo.session.notice',
          expect.objectContaining({ kind: 'finished', title: 'Quiet-model research' }),
        ],
      ]);
      expect(service.sessionNotices).toHaveLength(1);

      await service.refreshDriverWork();
      expect(events.filter(([name]) => name === 'neo.session.notice')).toHaveLength(1);
    } finally {
      time.mockRestore();
    }
  });

  test('a minute after the last notice, posts its group once to the Neo conversation', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      listed = [work({ lastActivityAt: clock - 1_000 })];
      await service.refreshDriverWork();
      clock += NEO_SESSION_RUN_MS;
      listed = [work({ status: 'done', lastActivityAt: clock - 1_000 })];
      status = { status: 'done', lastActivityAt: clock - 1_000 };
      await service.refreshDriverWork();
      expect(events.filter(([name]) => name === 'neo.session.notices')).toEqual([]);

      clock += NEO_SESSION_GROUP_MS;
      await service.refreshDriverWork();
      await service.refreshDriverWork();
      const groups = events.filter(([name]) => name === 'neo.session.notices');
      expect(groups).toEqual([
        [
          'neo.session.notices',
          {
            group: expect.objectContaining({
              line: 'Codex · Quiet-model research finished · Open',
              notices: [expect.objectContaining({ kind: 'finished' })],
            }),
          },
        ],
      ]);
      expect(service.sessionNoticeGroups).toHaveLength(1);
      expect(db.getSDKMessagesByType('neo:root', 'system', 'session_notices')).toEqual([
        expect.objectContaining({
          uuid: service.sessionNoticeGroups[0].id,
          group: service.sessionNoticeGroups[0],
        }),
      ]);
      const snapshot = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.snapshot',
        {},
        {
          source: 'mcp',
          sessionId: 'neo:root',
          role: 'neo',
          neoTurn: { messageId: 'm1', human: true, isLive: () => true },
        }
      );
      expect('value' in snapshot && snapshot.value).toMatchObject({
        sessionNoticeGroups: service.sessionNoticeGroups,
      });
      expect('value' in snapshot && snapshot.value).not.toHaveProperty('sessionNotices');

      const restarted = new NeoService(
        db,
        { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
        { event: mock(() => {}) } as unknown as MessageHub,
        new InternalEventBus<DaemonInternalEventMap>()
      );
      try {
        await restarted.recover();
        expect(restarted.sessionNoticeGroups).toEqual(service.sessionNoticeGroups);
      } finally {
        restarted.dispose();
      }
    } finally {
      time.mockRestore();
    }
  });
});
