import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  keepNeoSessionNoticeGroups,
  latestNeoSessionNoticeGroups,
  keepNeoSessionNotices,
  listNeoWatchedSessions,
  NEO_SESSION_GROUP_MS,
  NEO_SESSION_GROUPS_MAX,
  NEO_SESSION_NOTICES_MAX,
  NEO_SESSION_GROUP_NOTICES_MAX,
  neoSessionKey,
  neoSessionNoticeLine,
  planNeoSessionNotice,
  planNeoSessionNoticeGroup,
  planNeoSessionMutes,
  planNeoSessionWatch,
  NEO_SESSION_MUTES_MAX,
  savedNeoSessionNoticeGroups,
  type NeoListedSession,
  type NeoSessionNotice,
  type NeoSessionNoticeGroup,
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
const RUN_MS = 3 * 60_000;
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

  test("carries a Claude Code session's claude.ai page onto its notice", () => {
    const claude = { adapter: 'claude-desktop', id: 'c1' };
    const remoteLink = 'https://claude.ai/code/session_abc';
    const [listed] = listNeoWatchedSessions(
      places([work({ ref: claude, link: 'claude://claude.ai/epitaxy/c1', remoteLink })]),
      [],
      now
    );
    expect(listed?.remoteLink).toBe(remoteLink);
    const running: NeoSessionSeen = { listed: 'x', status: 'running' };
    expect(
      planNeoSessionNotice(listed!, running, { status: 'failed', lastInputAt: null }, now).notice
    ).toMatchObject({ link: 'claude://claude.ai/epitaxy/c1', remoteLink });
  });

  test('skips sessions the human muted', () => {
    expect(listNeoWatchedSessions(places([work()]), [], now, [session.key])).toEqual([]);
  });
});

describe('planNeoSessionMutes', () => {
  test('mutes a key once, unmutes it, and keeps only the newest mutes', () => {
    expect(planNeoSessionMutes(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(planNeoSessionMutes(['a', 'b'], 'a', true)).toEqual(['b', 'a']);
    expect(planNeoSessionMutes(['a', 'b'], 'a', false)).toEqual(['b']);
    const full = Array.from({ length: NEO_SESSION_MUTES_MAX }, (_, index) => `k${index}`);
    expect(planNeoSessionMutes(full, 'new', true)).toHaveLength(NEO_SESSION_MUTES_MAX);
    expect(planNeoSessionMutes(full, 'new', true).at(-1)).toBe('new');
  });
});

describe('planNeoSessionWatch', () => {
  test('takes a first sighting as a baseline and reads only sessions that changed', () => {
    const seen = new Map<string, NeoSessionSeen>([
      ['same', { listed: 'running:1', status: 'running' }],
      [session.key, { listed: 'running:5', status: 'running' }],
    ]);
    const fresh = { ...session, key: 'fresh' };
    const same = { ...session, key: 'same', lastActivityAt: 1 };
    const plan = planNeoSessionWatch([fresh, same, session], seen);
    expect(plan.baseline).toEqual([
      ['fresh', { listed: `running:${session.lastActivityAt}`, status: 'running' }],
    ]);
    expect(plan.reads.map((item) => item.key)).toEqual([session.key]);
  });
});

describe('planNeoSessionNotice', () => {
  const running: NeoSessionSeen = { listed: 'x', status: 'running' };
  const read = (status: WorkStatus, lastInputAt: number | null = null) => ({ status, lastInputAt });
  test.each<[string, NeoSessionSeen, ReturnType<typeof read> | null, string | null]>([
    ['a session that now needs the human', running, read('needs_you'), 'needs_you'],
    ['a session that failed', running, read('failed'), 'failed'],
    ['a session that went idle', running, read('done'), null],
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
    ).toEqual({
      line: 'Codex · Quiet-model research finished · Open; Claude · Auth fix needs you',
      lineCodes: [
        {
          code: 'notice.session.finished.open',
          params: { app: 'Codex', title: 'Quiet-model research' },
        },
        { code: 'notice.session.needsYou', params: { app: 'Claude', title: 'Auth fix' } },
      ],
    });
  });

  test('shows the first five and counts the rest', () => {
    const { line, lineCodes } = neoSessionNoticeLine(
      Array.from({ length: 7 }, (_, index) => notice(index))
    );
    expect(line.split('; ')).toHaveLength(6);
    expect(line.endsWith('; 2 more')).toBe(true);
    expect(lineCodes.at(-1)).toEqual({ code: 'notice.more', params: { count: '2' } });
  });
});

describe('planNeoSessionNoticeGroup', () => {
  test('notices within a minute of the last one join the open group', () => {
    const first = notice(now);
    const second = notice(now + NEO_SESSION_GROUP_MS - 1, { kind: 'failed' });
    expect(planNeoSessionNoticeGroup([first], [second], second.at)).toEqual({
      open: [first, second],
      closed: [],
    });
  });

  test('a minute without a new notice closes the group, and a new notice opens the next one', () => {
    const first = notice(now);
    const later = notice(now + NEO_SESSION_GROUP_MS, { kind: 'failed' });
    expect(planNeoSessionNoticeGroup([first], [later], later.at)).toEqual({
      open: [later],
      closed: [
        {
          id: `neo-session-notices:${now}:${session.key}`,
          at: now,
          line: 'Codex · Quiet-model research finished · Open',
          lineCodes: [
            {
              code: 'notice.session.finished.open',
              params: { app: 'Codex', title: 'Quiet-model research' },
            },
          ],
          notices: [first],
        },
      ],
    });
  });

  test('a group that would pass the notice cap closes early and the new notices start the next', () => {
    const open = Array.from({ length: NEO_SESSION_GROUP_NOTICES_MAX }, (_, index) =>
      notice(now + index)
    );
    const added = [notice(now + 30, { kind: 'failed' })];
    const grouped = planNeoSessionNoticeGroup(open, added, now + 30);
    expect(grouped.open).toEqual(added);
    expect(grouped.closed.map((group) => group.notices)).toEqual([open]);
  });

  test('a burst larger than one group splits into full groups and keeps every notice', () => {
    const added = Array.from({ length: 65 }, (_, index) =>
      notice(now, { key: `codex-desktop::t${index}` })
    );
    const grouped = planNeoSessionNoticeGroup([], added, now);
    expect(grouped.closed.map((group) => group.notices.length)).toEqual([30, 30]);
    expect(new Set(grouped.closed.map((group) => group.id)).size).toBe(2);
    expect([...grouped.closed.flatMap((group) => group.notices), ...grouped.open]).toEqual(added);
  });

  test('nothing open and nothing new leaves nothing to close', () => {
    expect(planNeoSessionNoticeGroup([], [], now)).toEqual({ open: [], closed: [] });
  });
});

describe('latestNeoSessionNoticeGroups', () => {
  const at = (key: string, kind: NeoSessionNotice['kind'], time: number): NeoSessionNotice => ({
    key,
    ref: { adapter: 'codex-desktop', id: key },
    title: key,
    kind,
    at: time,
  });
  const group = (id: string, notices: NeoSessionNotice[]): NeoSessionNoticeGroup => ({
    id,
    at: notices[0]!.at,
    line: notices.map((item) => item.key).join('; '),
    notices,
  });

  test('shows each session once, in its newest notice, and drops groups left empty', () => {
    const shown = latestNeoSessionNoticeGroups([
      group('g1', [at('a', 'needs_you', 1), at('b', 'failed', 2)]),
      group('g2', [at('a', 'failed', 3)]),
      group('g3', [at('c', 'needs_you', 4), at('c', 'failed', 5)]),
    ]);
    expect(shown.map((item) => [item.id, item.notices.map((n) => `${n.key}:${n.kind}`)])).toEqual([
      ['g1', ['b:failed']],
      ['g2', ['a:failed']],
      ['g3', ['c:failed']],
    ]);
    expect(shown[0]!.line).toBe('Codex · b failed');
  });

  test('hides a session whose newest notice is a saved finished one', () => {
    const shown = latestNeoSessionNoticeGroups([
      group('g1', [at('a', 'needs_you', 1), at('b', 'needs_you', 2)]),
      group('g2', [at('a', 'finished', 3), at('c', 'finished', 4)]),
    ]);
    expect(shown.map((item) => [item.id, item.notices.map((n) => n.key)])).toEqual([['g1', ['b']]]);
  });

  test('keeps a group untouched when none of its sessions comes again', () => {
    const only = group('g1', [at('a', 'needs_you', 1)]);
    expect(latestNeoSessionNoticeGroups([only])).toEqual([only]);
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
    const badNotice = { ...group, id: 'g3', notices: [{ key: 'k', kind: 'finished' }] };
    expect(
      savedNeoSessionNoticeGroups([
        { group },
        { group: { id: 'g2' } },
        { group: badNotice },
        null,
        { type: 'system' },
      ])
    ).toEqual([group]);
  });
});

describe('getLatestSDKMessagesByType', () => {
  test('returns the newest rows of one subtype, oldest first', async () => {
    const db = await createTestDb();
    try {
      await db.createSession(createTestSession('neo:root'));
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

  test('seeks the subtype instead of reading every system row of the session', async () => {
    const db = await createTestDb();
    try {
      await db.createSession(createTestSession('neo:root'));
      const repo = db.getSDKMessageRepo();
      for (let i = 0; i < 3000; i++)
        repo.saveSDKMessage('neo:root', {
          type: 'system',
          subtype: i % 2 ? 'status' : 'session_state_changed',
          uuid: `s${i}`,
          session_id: 'neo:root',
        } as never);
      for (const id of ['g1', 'g2', 'g3'])
        repo.saveSDKMessage('neo:root', {
          type: 'system',
          subtype: 'session_notices',
          uuid: id,
          session_id: 'neo:root',
        } as never);
      const raw = db.getDatabase();
      const prepare = raw.prepare.bind(raw);
      let selection = '';
      raw.prepare = ((sql: string) => {
        if (sql.includes('body_selection AS MATERIALIZED')) selection = sql;
        return prepare(sql);
      }) as typeof raw.prepare;
      const ids = repo
        .getLatestSDKMessagesByType('neo:root', 'system', 'session_notices', 2)
        .map((row) => (row as { uuid?: string }).uuid);
      raw.prepare = prepare;
      const plan = (
        prepare(`EXPLAIN QUERY PLAN ${selection}`).all(
          'neo:root',
          'system',
          'session_notices',
          2
        ) as { detail: string }[]
      ).map((row) => row.detail);
      expect(ids).toEqual(['g2', 'g3']);
      expect(plan.some((detail) => /message_subtype_norm=\?/.test(detail))).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('refreshDriverWork', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: ReturnType<typeof createNeoService>;
  let listed: PlaceGroup['work'];
  let unreachable: { source: string; reason: string }[];
  let more: boolean;
  let status: { status: WorkStatus; lastActivityAt: number; recentInputs?: unknown[] };
  let hold: Promise<void> = Promise.resolve();
  const events: Array<[string, unknown]> = [];

  beforeEach(async () => {
    db = await createTestDb();
    await db.createSession(createTestSession('neo:root'));
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
        execute: async () => {
          await hold;
          return { ok: true, value: status };
        },
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
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    await db.createSession(createTestSession('neo:inbox'));
    service.repo.saveProject({ id: 'inbox', title: 'Inbox', summary: '', context: '' }, 0);
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  test('keeps what it saw when a listing comes back partial', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      listed = [work({ lastActivityAt: clock - 1_000 })];
      await service.refreshDriverWork();
      clock += RUN_MS;
      listed = [];
      unreachable = [{ source: 'codex-desktop', reason: 'locked' }];
      await service.refreshDriverWork();
      unreachable = [];
      more = true;
      await service.refreshDriverWork();
      more = false;
      listed = [work({ status: 'failed', lastActivityAt: clock - 1_000 })];
      status = { status: 'failed', lastActivityAt: clock - 1_000 };
      await service.refreshDriverWork();
      expect(events.filter(([name]) => name === 'neo.session.notice')).toHaveLength(1);
    } finally {
      time.mockRestore();
    }
  });

  test('tells once when a session the human runs fails', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      listed = [work({ lastActivityAt: clock - 1_000 })];
      await service.refreshDriverWork();
      expect(events.filter(([name]) => name === 'neo.session.notice')).toEqual([]);

      clock += RUN_MS;
      listed = [work({ status: 'failed', lastActivityAt: clock - 1_000 })];
      status = { status: 'failed', lastActivityAt: clock - 1_000 };
      await service.refreshDriverWork();
      const notices = events.filter(([name]) => name === 'neo.session.notice');
      expect(notices).toEqual([
        [
          'neo.session.notice',
          expect.objectContaining({ kind: 'failed', title: 'Quiet-model research' }),
        ],
      ]);
      expect(service.sessionNotices).toHaveLength(1);

      await service.refreshDriverWork();
      expect(events.filter(([name]) => name === 'neo.session.notice')).toHaveLength(1);
    } finally {
      time.mockRestore();
    }
  });

  const openFinishedGroup = async (advance: (ms: number) => void, at: () => number) => {
    listed = [work({ lastActivityAt: at() - 1_000 })];
    await service.refreshDriverWork();
    advance(RUN_MS);
    listed = [work({ status: 'failed', lastActivityAt: at() - 1_000 })];
    status = { status: 'failed', lastActivityAt: at() - 1_000 };
    await service.refreshDriverWork();
    advance(NEO_SESSION_GROUP_MS);
  };

  test('overlapping refreshes close a group only once', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      await openFinishedGroup(
        (ms) => {
          clock += ms;
        },
        () => clock
      );
      await Promise.all([service.refreshDriverWork(), service.refreshDriverWork()]);
      expect(events.filter(([name]) => name === 'neo.session.notices')).toHaveLength(1);
      expect(db.getSDKMessagesByType('neo:root', 'system', 'session_notices')).toEqual([
        expect.objectContaining({ content: 'Codex · Quiet-model research failed · Open' }),
      ]);
    } finally {
      time.mockRestore();
    }
  });

  test('a watch still reading at shutdown lands its notices in the saved group', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      listed = [work({ lastActivityAt: clock - 1_000 })];
      await service.refreshDriverWork();
      clock += RUN_MS;
      listed = [work({ status: 'failed', lastActivityAt: clock - 1_000 })];
      status = { status: 'failed', lastActivityAt: clock - 1_000 };
      let release = () => {};
      hold = new Promise((resolve) => {
        release = resolve;
      });
      const refreshing = service.refreshDriverWork();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const disposing = service.dispose();
      release();
      await Promise.all([refreshing, disposing]);
      expect(db.getSDKMessagesByType('neo:root', 'system', 'session_notices')).toEqual([
        expect.objectContaining({
          group: expect.objectContaining({
            notices: [expect.objectContaining({ kind: 'failed' })],
          }),
        }),
      ]);
    } finally {
      hold = Promise.resolve();
      time.mockRestore();
    }
  });

  test('a watch still running at shutdown posts nothing after Neo stops', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      await openFinishedGroup(
        (ms) => {
          clock += ms;
        },
        () => clock
      );
      await service.dispose();
      const saved = db.getSDKMessagesByType('neo:root', 'system', 'session_notices');
      events.length = 0;
      await service.refreshDriverWork();
      expect(events.filter(([name]) => name === 'neo.session.notices')).toEqual([]);
      expect(db.getSDKMessagesByType('neo:root', 'system', 'session_notices')).toEqual(saved);
    } finally {
      time.mockRestore();
    }
  });

  test('a group whose row could not be saved is neither kept nor announced', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      await openFinishedGroup(
        (ms) => {
          clock += ms;
        },
        () => clock
      );
      const save = spyOn(db.getSDKMessageRepo(), 'saveSDKMessage').mockReturnValue(false);
      await service.refreshDriverWork();
      save.mockRestore();
      expect(events.filter(([name]) => name === 'neo.session.notices')).toEqual([]);
      expect(service.sessionNoticeGroups).toEqual([]);
    } finally {
      time.mockRestore();
    }
  });

  test('a session that fails while Neo is down still gets its notice after a restart', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      listed = [work({ lastActivityAt: clock - 1_000 })];
      await service.refreshDriverWork();
      service.dispose();
      clock += RUN_MS;
      listed = [work({ status: 'failed', lastActivityAt: clock - 1_000 })];
      status = { status: 'failed', lastActivityAt: clock - 1_000 };
      const announced: string[] = [];
      const restarted = createNeoService(
        db,
        service.sessions,
        {
          event: mock((name: string) => {
            announced.push(name);
          }),
        } as unknown as MessageHub,
        new InternalEventBus<DaemonInternalEventMap>()
      );
      try {
        await restarted.refreshDriverWork();
        expect(announced.filter((name) => name === 'neo.session.notice')).toHaveLength(1);
        expect(restarted.sessionNotices).toEqual([expect.objectContaining({ kind: 'failed' })]);
      } finally {
        restarted.dispose();
      }
    } finally {
      time.mockRestore();
    }
  });

  test('a failed save of what the watcher saw still announces the notice, and the next pass saves', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    const table = db.getDatabase();
    try {
      listed = [work({ lastActivityAt: clock - 1_000 })];
      await service.refreshDriverWork();
      table.exec('ALTER TABLE neo_session_seen RENAME TO neo_session_seen_away');
      clock += RUN_MS;
      listed = [work({ status: 'failed', lastActivityAt: clock - 1_000 })];
      status = { status: 'failed', lastActivityAt: clock - 1_000 };
      await service.refreshDriverWork();
      expect(events.filter(([name]) => name === 'neo.session.notice')).toHaveLength(1);
      table.exec('ALTER TABLE neo_session_seen_away RENAME TO neo_session_seen');
      await service.refreshDriverWork();
      expect(table.prepare('SELECT status FROM neo_session_seen').all()).toEqual([
        { status: 'failed' },
      ]);
    } finally {
      time.mockRestore();
    }
  });

  test('a group still open at shutdown is saved, and a restart reads it back', async () => {
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      listed = [work({ lastActivityAt: clock - 1_000 })];
      await service.refreshDriverWork();
      clock += RUN_MS;
      listed = [work({ status: 'failed', lastActivityAt: clock - 1_000 })];
      status = { status: 'failed', lastActivityAt: clock - 1_000 };
      await service.refreshDriverWork();
      expect(db.getSDKMessagesByType('neo:root', 'system', 'session_notices')).toEqual([]);

      service.dispose();
      expect(db.getSDKMessagesByType('neo:root', 'system', 'session_notices')).toHaveLength(1);
      const restarted = createNeoService(
        db,
        {
          getOperationRegistry: () => createOperationRegistry([]),
          updateSession: async (id: string, updates: Parameters<typeof db.updateSession>[1]) => {
            await db.updateSession(id, updates);
          },
        } as unknown as SessionManager,
        { event: mock(() => {}) } as unknown as MessageHub,
        new InternalEventBus<DaemonInternalEventMap>()
      );
      try {
        await restarted.recover();
        expect(restarted.sessionNoticeGroups).toEqual([
          expect.objectContaining({ notices: [expect.objectContaining({ kind: 'failed' })] }),
        ]);
      } finally {
        restarted.dispose();
      }
    } finally {
      time.mockRestore();
    }
  });

  test('a muted session sends no notice until it is unmuted', async () => {
    const human = { source: 'rpc' as const, principal: 'local' as const };
    const invoke = (name: string, input: unknown) =>
      invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, human);
    let clock = Date.now();
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      expect(await invoke('neo.session.mute', { key: session.key, muted: true })).toMatchObject({
        value: { ok: true, mutedSessions: [session.key] },
      });
      const snapshot = await invoke('neo.snapshot', {});
      expect('value' in snapshot && snapshot.value).toMatchObject({
        mutedSessions: [session.key],
      });
      listed = [work({ lastActivityAt: clock - 1_000 })];
      await service.refreshDriverWork();
      clock += RUN_MS;
      listed = [work({ status: 'failed', lastActivityAt: clock - 1_000 })];
      status = { status: 'failed', lastActivityAt: clock - 1_000 };
      await service.refreshDriverWork();
      expect(events.filter(([name]) => name === 'neo.session.notice')).toEqual([]);

      await invoke('neo.session.mute', { key: session.key, muted: false });
      listed = [work({ lastActivityAt: clock - 500 })];
      status = { status: 'running', lastActivityAt: clock - 500 };
      await service.refreshDriverWork();
      clock += RUN_MS;
      listed = [work({ status: 'failed', lastActivityAt: clock - 1_000 })];
      status = { status: 'failed', lastActivityAt: clock - 1_000 };
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
      clock += RUN_MS;
      listed = [work({ status: 'failed', lastActivityAt: clock - 1_000 })];
      status = { status: 'failed', lastActivityAt: clock - 1_000 };
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
              line: 'Codex · Quiet-model research failed · Open',
              notices: [expect.objectContaining({ kind: 'failed' })],
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
        }
      );
      expect('value' in snapshot && snapshot.value).toMatchObject({
        sessionNoticeGroups: [
          expect.objectContaining({
            notices: [
              expect.objectContaining({
                worker: { id: 't1', adapter: 'codex-desktop', name: null, label: 'Codex · t1' },
                title: 't1',
              }),
            ],
          }),
        ],
      });
      expect('value' in snapshot && snapshot.value).not.toHaveProperty('sessionNotices');

      const restarted = createNeoService(
        db,
        {
          getOperationRegistry: () => createOperationRegistry([]),
          updateSession: async (id: string, updates: Parameters<typeof db.updateSession>[1]) => {
            await db.updateSession(id, updates);
          },
        } as unknown as SessionManager,
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
