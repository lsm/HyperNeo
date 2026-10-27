import { readHyperneoTurnEnds } from '../../../../src/storage/hyperneo-turn-ends-read.ts';
import { createClaudeCodeAdapter } from '../../../../src/lib/drivers/claude-code-adapter';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createFindWorkOperation,
  findLocally,
  combineFindResults,
  FIND_AGENT_RESULT_BUDGET_CHARS,
} from '../../../../src/lib/drivers/find-operation';
import {
  buildHyperneoGroups,
  createHyperneoAdapter,
  hyperneoWorkStatus,
  skipSpaceQuery,
} from '../../../../src/lib/drivers/hyperneo-adapter';
import { mergePlaceGroups } from '../../../../src/lib/drivers/places';
import type { PlaceGroup, WorkAdapter } from '../../../../src/lib/drivers/types';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { WorkChatMatch } from '../../../../src/storage/work-chat-search';

function group(machine: string, folder: string, adapter: string, at: number): PlaceGroup {
  return {
    place: { machine, folder, name: folder.split('/').pop() ?? folder },
    lastActivityAt: at,
    openCount: 1,
    archivedCount: 0,
    adapters: [adapter],
    work: [
      {
        ref: { adapter, id: `${adapter}-${at}` },
        title: `${adapter} work`,
        place: { machine, folder, name: folder.split('/').pop() ?? folder },
        status: 'running',
        lastActivityAt: at,
      },
    ],
  };
}

const chat = (sessionId: string | null, taskId: string | null = null): WorkChatMatch => ({
  kind: taskId ? 'task' : 'message',
  sessionId,
  taskId,
  hits: 1,
  lastHitAt: 1,
  score: 32.8,
  snippets: [
    { match: 'exact', messageId: 'm1', sessionId, role: 'assistant', at: 1, text: 'a hit' },
  ],
});

describe('combineFindResults', () => {
  test('open discovery excludes closed sessions while explicit history and id lookups retain them', () => {
    const sessions = group('laptop', '/focus/dolmen', 'claude-desktop', 10);
    sessions.work.push({
      ...sessions.work[0],
      ref: { adapter: 'claude-desktop', id: 'archived' },
      status: 'stopped',
    });
    const local = { groups: [sessions], unreachable: [] };
    const remote = { groups: [], unreachable: [] };
    const input = { includeClosed: false, limit: 20, localOnly: true };
    expect(
      combineFindResults(local, remote, input).places[0].work.map((item) => item.ref.id)
    ).toEqual(['claude-desktop-10']);
    expect(
      combineFindResults(local, remote, { ...input, includeClosed: true }).places[0].work
    ).toHaveLength(2);
    expect(
      combineFindResults(local, remote, { ...input, id: 'archived' }).places[0].work[0].ref.id
    ).toBe('archived');
  });

  test("the calling project's own place comes first even when text hits would push it past the limit", () => {
    const hits = [1, 2, 3].map((at) => group('laptop', `/qa/${at}`, 'claude-code', 100 + at));
    const own = group('laptop', '/focus/app', 'hyperneo', 1);
    const local = { groups: [...hits, own], unreachable: [] };
    const input = { includeClosed: false, limit: 2, localOnly: true };
    const remote = { groups: [], unreachable: [] };
    expect(
      combineFindResults(local, remote, input).places.map((place) => place.place.folder)
    ).toEqual(['/qa/3', '/qa/2']);
    expect(
      combineFindResults(
        local,
        remote,
        input,
        undefined,
        new Set(['laptop\u0000/focus/app'])
      ).places.map((place) => place.place.folder)
    ).toEqual(['/focus/app', '/qa/3']);
    expect(
      combineFindResults(
        local,
        remote,
        { ...input, id: 'claude-code-101' },
        undefined,
        new Set(['laptop\u0000/focus/app'])
      ).places.map((place) => place.place.folder)
    ).toEqual(['/qa/1']);
  });
});

describe('mergePlaceGroups', () => {
  test('merges one folder on one machine across adapters, newest first', () => {
    const merged = mergePlaceGroups(
      [
        group('laptop', '/focus/dolmen', 'codex-desktop', 10),
        group('laptop', '/focus/dolmen', 'claude-desktop', 30),
        group('imac', '/focus/dolmen', 'hyperneo', 20),
      ],
      10
    );
    expect(merged.map((g) => [g.place.machine, g.adapters, g.openCount])).toEqual([
      ['laptop', ['claude-desktop', 'codex-desktop'], 2],
      ['imac', ['hyperneo'], 1],
    ]);
    expect(merged[0].work.map((w) => w.lastActivityAt)).toEqual([30, 10]);
  });

  test('orders places by their best search score before recency, across daemons', () => {
    const scored = (g: PlaceGroup, score: number) => ({
      ...g,
      work: g.work.map((w) => ({ ...w, score })),
    });
    const merged = mergePlaceGroups(
      [
        group('imac', '/focus/new', 'hyperneo', 50),
        scored(group('laptop', '/focus/old', 'hyperneo', 10), 30),
        scored(group('imac', '/focus/mid', 'hyperneo', 20), 32),
      ],
      10
    );
    expect(merged.map((g) => g.place.name)).toEqual(['mid', 'old', 'new']);
  });

  test('puts work with a search score first, highest score first', () => {
    const [scored] = mergePlaceGroups(
      [
        group('laptop', '/focus/dolmen', 'claude-desktop', 30),
        group('laptop', '/focus/dolmen', 'hyperneo', 10),
      ].map((g, index) => ({
        ...g,
        work: g.work.map((w) => (index === 1 ? { ...w, score: 30 } : w)),
      })),
      10
    );
    expect(scored.work.map((w) => [w.lastActivityAt, w.score])).toEqual([
      [10, 30],
      [30, undefined],
    ]);
  });
});

describe('hyperneoWorkStatus', () => {
  test.each([
    ['active', 'processing', 'running'],
    ['active', 'queued', 'queued'],
    ['active', 'waiting_for_input', 'needs_you'],
    ['pending_worktree_choice', null, 'needs_you'],
    ['active', 'rate_limit_cooldown', 'queued'],
    ['active', 'interrupted', 'stopped'],
    ['active', 'interrupted_by_restart', 'queued'],
    ['archived', 'interrupted_by_restart', 'stopped'],
    ['active', 'idle', 'done'],
    ['ended', 'idle', 'stopped'],
  ] as const)('%s with %s is %s', (status, processing, expected) => {
    expect(hyperneoWorkStatus(status, processing)).toBe(expected);
  });
});

describe('buildHyperneoGroups', () => {
  const places = [
    {
      folder: '/focus/dolmen',
      openCount: 1,
      archivedCount: 2,
      known: 0,
      lastActiveAt: '2026-10-04T10:00:00.000Z',
    },
    {
      folder: '/focus/superpipe',
      openCount: 0,
      archivedCount: 3,
      known: 1,
      lastActiveAt: '2026-09-24T01:00:00.000Z',
    },
    {
      folder: '/projects/superpipe/worktrees/a1',
      openCount: 0,
      archivedCount: 1,
      known: 0,
      lastActiveAt: '2026-08-20T01:00:00.000Z',
    },
  ];
  const sessions = [
    {
      id: 's1',
      title: 'lakehouse loader',
      status: 'active',
      folder: '/focus/dolmen',
      processing: 'processing',
      lastActiveAt: '2026-10-04T10:00:00.000Z',
    },
  ];
  const query = { includeClosed: false, limit: 20 };

  test('returns open and remembered places without text, not folders holding only closed work', () => {
    const groups = buildHyperneoGroups(places, sessions, query, { machine: 'imac' }, new Map());
    expect(groups.map((g) => [g.place.name, g.work.length, g.archivedCount])).toEqual([
      ['dolmen', 1, 2],
      ['superpipe', 0, 3],
    ]);
    expect(groups[0].work[0]).toMatchObject({
      ref: { adapter: 'hyperneo', id: 's1' },
      status: 'running',
      link: '/session/s1',
    });
  });

  test('lists a folder holding only closed work when closed work is asked for', () => {
    expect(
      buildHyperneoGroups(
        places,
        sessions,
        { ...query, includeClosed: true },
        { machine: 'imac' },
        new Map()
      ).map((g) => g.place.name)
    ).toEqual(['dolmen', 'superpipe', 'a1']);
  });

  test('matches a place by name even when nothing in it is open', () => {
    const groups = buildHyperneoGroups(
      places,
      sessions,
      { ...query, text: 'superpipe' },
      { machine: 'imac' },
      new Map()
    );
    expect(groups.map((g) => g.place.name)).toEqual(['superpipe']);
  });

  test('matches work by full-text hits and titles', () => {
    expect(
      buildHyperneoGroups(
        places,
        sessions,
        { ...query, text: 'zzz' },
        { machine: 'imac' },
        new Map([['s1', chat('s1')]])
      ).flatMap((g) => g.work)
    ).toEqual([
      expect.objectContaining({
        ref: { adapter: 'hyperneo', id: 's1' },
        score: 32.8,
        hits: 1,
        lastHitAt: 1,
        snippets: [
          {
            match: 'exact',
            at: 1,
            role: 'assistant',
            text: 'a hit',
            handle: { sessionId: 's1', messageId: 'm1' },
          },
        ],
      }),
    ]);
    expect(
      buildHyperneoGroups(
        places,
        sessions,
        { ...query, text: 'loader' },
        { machine: 'imac' },
        new Map()
      ).flatMap((g) => g.work.map((w) => w.ref.id))
    ).toEqual(['s1']);
  });
});

const findOnly = {
  handoff: async () => ({ kind: 'enqueued' as const, id: 'mb1' }),
  sessions: {
    create: async () => 'new',
    chooseWorktree: async () => {},
    announce: () => {},
    interrupt: () => false,
    model: () => null,
    resolveModel: async () => null,
  },
  neoFolder: () => '/data/Neo',
  folderExists: () => true,
  makeFolder: () => {},
  homeDir: '/Users/test',
};

describe('skipSpaceQuery', () => {
  test('leaves Spaces to the space adapter without reading anything', async () => {
    expect(skipSpaceQuery({ includeClosed: false, limit: 20, spaceId: 'sp' })).toEqual({
      reason: [],
    });
    const adapter = createHyperneoAdapter({
      readTurnEnds: async () => {
        throw new Error('read turn reports');
      },
      db: () => {
        throw new Error('read the database');
      },
      machine: 'imac',
      searchChats: async () => {
        throw new Error('searched messages');
      },
      ...findOnly,
    });
    expect(
      await adapter.find({ includeClosed: true, limit: 20, spaceId: 'sp', text: 'x' })
    ).toEqual([]);
  });
});

describe('hyperneo adapter against the sessions table', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, workspace_path TEXT, main_repo_path TEXT, metadata TEXT,
      status TEXT, last_active_at TEXT, processing_state TEXT, type TEXT, space_id TEXT, room_id TEXT)`);
    db.exec(`CREATE TABLE workspace_history (path TEXT, last_used_at INTEGER)`);
    const insert =
      db.prepare(`INSERT INTO sessions (id, title, workspace_path, main_repo_path, status,
      last_active_at, processing_state, type, space_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(
      's1',
      'loader',
      '/focus/dolmen/.claude/worktrees/a',
      '/focus/dolmen',
      'active',
      '2026-10-04T10:00:00.000Z',
      '{"status":"processing"}',
      'worker',
      null
    );
    insert.run(
      's2',
      'old',
      '/focus/dolmen',
      null,
      'archived',
      '2026-09-01T10:00:00.000Z',
      null,
      'worker',
      null
    );
    insert.run(
      's3',
      'space work',
      '/focus/dev',
      null,
      'active',
      '2026-10-04T11:00:00.000Z',
      null,
      'worker',
      'space-1'
    );
    insert.run(
      'neo:root',
      'Neo',
      null,
      null,
      'active',
      '2026-10-04T12:00:00.000Z',
      null,
      'worker',
      null
    );
    insert.run(
      's4',
      'room',
      '/focus/rooms',
      null,
      'active',
      '2026-10-04T09:00:00.000Z',
      null,
      'leader',
      null
    );
    db.exec(`INSERT INTO sessions (id, title, workspace_path, status, last_active_at, type, room_id)
      VALUES ('g1', 'General Agent', '/focus/rooms/g1', 'active', '2026-10-04T08:00:00.000Z', 'general', 'room-1')`);
    db.prepare(`INSERT INTO workspace_history VALUES (?, ?)`).run(
      '/focus/fresh',
      Date.parse('2026-10-03T00:00:00.000Z')
    );
  });
  afterEach(() => db.close());

  test('keeps every open session when closed ones are added', async () => {
    const closed =
      db.prepare(`INSERT INTO sessions (id, title, workspace_path, status, last_active_at, type)
      VALUES (?, 'old', '/focus/dolmen', 'archived', ?, 'worker')`);
    for (let n = 0; n < 600; n++)
      closed.run(`x${n}`, `2026-10-05T00:00:${String(n % 60).padStart(2, '0')}.${n}Z`);
    const adapter = createHyperneoAdapter({
      readTurnEnds: async (id, since) => readHyperneoTurnEnds(db, id, since),
      db: () => db,
      machine: 'imac',
      searchChats: async () => [],
      ...findOnly,
    });
    const groups = await adapter.find({ includeClosed: true, limit: 20, text: 'loader' });
    expect(groups.flatMap((g) => g.work.map((w) => w.ref.id))).toEqual(['s1']);
  });

  test('groups its own sessions by project root and adds folders from workspace history', async () => {
    const adapter = createHyperneoAdapter({
      readTurnEnds: async (id, since) => readHyperneoTurnEnds(db, id, since),
      db: () => db,
      machine: 'imac',
      searchChats: async () => [],
      handoff: async () => ({ kind: 'enqueued', id: 'mb1' }),
      sessions: {
        create: async () => 'new',
        chooseWorktree: async () => {},
        announce: () => {},
        interrupt: () => false,
        model: () => null,
        resolveModel: async () => null,
      },
      neoFolder: () => '/data/Neo',
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: '/Users/test',
    });
    const groups = await adapter.find({ includeClosed: false, limit: 20 });
    expect(
      groups.map((g) => [g.place.folder, g.openCount, g.archivedCount, g.work.map((w) => w.ref.id)])
    ).toEqual([
      ['/focus/dolmen', 1, 1, ['s1']],
      ['/focus/fresh', 0, 0, []],
    ]);
  });
});

describe('work.find operation', () => {
  const local: WorkAdapter = {
    id: 'hyperneo',
    capabilities: ['find'],
    find: () => [group('imac', '/focus/dolmen', 'hyperneo', 20)],
  };
  const broken: WorkAdapter = {
    id: 'broken',
    capabilities: ['find'],
    find: () => {
      throw new Error('store unavailable');
    },
  };

  function registry(invoke: (daemonId: string, name: string, input: unknown) => Promise<unknown>) {
    return createOperationRegistry([
      createFindWorkOperation({
        adapters: () => [local, broken],
        remote: { list: () => [{ daemonId: 'laptop' }, { daemonId: 'gone' }], invoke },
      }),
    ]);
  }

  test('merges local and attached daemons, stamps remote refs and reports what could not answer', async () => {
    const calls: unknown[] = [];
    const outcome = await invokeOperation(
      registry(async (daemonId, name, input) => {
        calls.push({ daemonId, name, input });
        if (daemonId === 'gone') throw new Error('unreachable');
        return { places: [group('laptop', '/focus/dolmen', 'codex-desktop', 30)], unreachable: [] };
      }),
      'work.find',
      {},
      { source: 'mcp', sessionId: 'neo:root' }
    );
    expect(outcome.kind).toBe('completed');
    const value =
      outcome.kind === 'completed'
        ? (outcome.value as { places: PlaceGroup[]; unreachable: unknown[] })
        : null;
    expect(value?.places.map((g) => [g.place.machine, g.work[0].ref])).toEqual([
      ['laptop', { adapter: 'codex-desktop', id: 'codex-desktop-30', daemon: 'laptop' }],
      ['imac', { adapter: 'hyperneo', id: 'hyperneo-20' }],
    ]);
    expect(value?.unreachable).toEqual([
      { source: 'broken', reason: 'store unavailable' },
      { source: 'gone', reason: 'unreachable' },
    ]);
    expect(calls).toContainEqual(
      expect.objectContaining({
        daemonId: 'laptop',
        name: 'work.find',
        input: expect.objectContaining({ localOnly: true }),
      })
    );
  });

  test("keeps an agent's reply small and says more was left out, while the app gets the full budget", async () => {
    const many: WorkAdapter = {
      id: 'hyperneo',
      capabilities: ['find'],
      find: () =>
        Array.from({ length: 50 }, (_, n) => group('imac', `/focus/project-${n}`, 'hyperneo', n)),
    };
    const ops = createOperationRegistry([
      createFindWorkOperation({
        adapters: () => [many],
        remote: { list: () => [], invoke: async () => ({}) },
      }),
    ]);
    const read = async (caller: OperationCaller) => {
      const outcome = await invokeOperation(ops, 'work.find', { limit: 50 }, caller);
      return outcome.kind === 'completed'
        ? (outcome.value as { places: PlaceGroup[]; more?: boolean })
        : null;
    };
    const agent = await read({ source: 'mcp', sessionId: 'neo:root' });
    expect(JSON.stringify(agent?.places).length).toBeLessThanOrEqual(
      FIND_AGENT_RESULT_BUDGET_CHARS
    );
    expect(agent?.more).toBe(true);
    const app = await read({ source: 'rpc' });
    expect(app?.places.length).toBeGreaterThan(agent?.places.length ?? 0);
  });

  test('looks work up by its ref id, closed or not, beyond the default place limit', async () => {
    const queries: unknown[] = [];
    const many: WorkAdapter = {
      id: 'hyperneo',
      capabilities: ['find'],
      find: (query) => {
        queries.push(query);
        return Array.from({ length: 40 }, (_, n) =>
          group('imac', `/focus/project-${n}`, 'hyperneo', n)
        );
      },
    };
    const ops = createOperationRegistry([
      createFindWorkOperation({
        adapters: () => [many],
        remote: { list: () => [], invoke: async () => ({}) },
      }),
    ]);
    const outcome = await invokeOperation(
      ops,
      'work.find',
      { id: 'hyperneo-3' },
      { source: 'rpc' }
    );
    const places =
      outcome.kind === 'completed' ? (outcome.value as { places: PlaceGroup[] }).places : [];
    expect(places.map((place) => place.work.map((item) => item.ref.id))).toEqual([['hyperneo-3']]);
    expect(queries).toEqual([expect.objectContaining({ includeClosed: true, limit: 50 })]);
  });

  test('asks other daemons while the local sources are still answering', async () => {
    let remoteAsked: () => void = () => {};
    const asked = new Promise<boolean>((resolve) => {
      remoteAsked = () => resolve(true);
    });
    const waiting: WorkAdapter = {
      id: 'hyperneo',
      capabilities: ['find'],
      find: async () => {
        const overlapped = await Promise.race([
          asked,
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
        ]);
        return overlapped ? [group('imac', '/focus/dolmen', 'hyperneo', 20)] : [];
      },
    };
    const ops = createOperationRegistry([
      createFindWorkOperation({
        adapters: () => [waiting],
        remote: {
          list: () => [{ daemonId: 'laptop' }],
          invoke: async () => {
            remoteAsked();
            return { places: [], unreachable: [] };
          },
        },
      }),
    ]);
    const outcome = await invokeOperation(ops, 'work.find', {}, { source: 'rpc' });
    expect(
      outcome.kind === 'completed' ? (outcome.value as { places: PlaceGroup[] }).places : []
    ).toHaveLength(1);
  });

  test('does not ask other daemons when called with localOnly', async () => {
    let asked = false;
    await invokeOperation(
      registry(async () => {
        asked = true;
        return { places: [], unreachable: [] };
      }),
      'work.find',
      { localOnly: true },
      { source: 'rpc' }
    );
    expect(asked).toBe(false);
  });
});

describe('work.find session', () => {
  const titled = (id: string, title: string) => {
    const base = group('laptop', '/focus/neo-ios', 'claude-desktop', 1);
    return { ...base.work[0], ref: { adapter: 'claude-desktop', id }, title };
  };
  const desktop = (titles: [string, string][], seen: unknown[] = []): WorkAdapter => ({
    id: 'claude-desktop',
    capabilities: ['find'],
    find: (query) => {
      seen.push(query.text);
      return Promise.resolve([
        {
          ...group('laptop', '/focus/neo-ios', 'claude-desktop', 1),
          work: titles.map(([id, title]) => titled(id, title)),
        },
      ]);
    },
  });
  const find = async (adapter: WorkAdapter, session: string) => {
    const outcome = await invokeOperation(
      createOperationRegistry([
        createFindWorkOperation({
          adapters: () => [adapter],
          remote: { list: () => [], invoke: async () => ({}) },
        }),
      ]),
      'work.find',
      { session },
      { source: 'mcp', sessionId: 'neo:root' }
    );
    return outcome.kind === 'completed'
      ? (outcome.value as {
          places: PlaceGroup[];
          session?: { name: string; match: string; near?: { ref: unknown; title: string }[] };
        })
      : null;
  };
  const ids = (places: PlaceGroup[] | undefined) =>
    (places ?? []).flatMap((place) => place.work.map((item) => item.ref.id));

  test('resolves a named session by exact title only, never by a looser hit', async () => {
    const seen: unknown[] = [];
    const found = await find(
      desktop(
        [
          ['coordinator', 'Neo iOS app'],
          ['worker', 'iOS-2'],
        ],
        seen
      ),
      ' ios-2 '
    );
    expect(seen).toEqual(['ios-2']);
    expect(found?.session?.match).toBe('exact');
    expect(ids(found?.places)).toEqual(['worker']);
  });

  test('lists every candidate when the name is ambiguous, and reports a miss with near titles', async () => {
    const twins = await find(
      desktop([
        ['a', 'iOS-2'],
        ['b', 'ios-2'],
      ]),
      'iOS-2'
    );
    expect(twins?.session?.match).toBe('ambiguous');
    expect(ids(twins?.places)).toEqual(['a', 'b']);
    const missed = await find(desktop([['coordinator', 'Neo iOS app']]), 'iOS');
    expect(missed?.session).toEqual({
      name: 'iOS',
      match: 'none',
      near: [
        {
          ref: { adapter: 'claude-desktop', id: 'coordinator' },
          title: 'Neo iOS app',
          worker: {
            id: 'coordinator',
            adapter: 'claude-desktop',
            name: 'Neo iOS app',
            label: 'Claude · Neo iOS app',
          },
        },
      ],
    });
    expect(missed?.places).toEqual([]);
  });

  test('judges the match before the place limit cuts the result', () => {
    const places = Array.from({ length: 25 }, (_, n) =>
      group('laptop', `/focus/p${n}`, 'claude-desktop', 100 - n)
    );
    const named = (n: number) => ({
      ...places[n],
      work: [{ ...places[n].work[0], title: 'iOS-2' }],
    });
    const input = { session: 'iOS-2', includeClosed: false, limit: 20, localOnly: true };
    const empty = { groups: [], unreachable: [] };
    const late = combineFindResults(
      { groups: [...places.slice(0, 24), named(24)], unreachable: [] },
      empty,
      input
    );
    expect(late.session?.match).toBe('exact');
    expect(late.places.map((place) => place.place.folder)).toEqual(['/focus/p24']);
    const twins = combineFindResults(
      { groups: [named(0), ...places.slice(1, 24), named(24)], unreachable: [] },
      empty,
      input
    );
    expect(twins.session?.match).toBe('ambiguous');
    expect(twins.places).toHaveLength(2);
  });
});

describe('Claude history identity refresh', () => {
  test('keeps a historical search title when the owner is unavailable without claiming a current name', async () => {
    const source = group('synthetic', '/synthetic', 'claude-code', 1);
    source.work[0].title = 'Historical heron plan';
    const result = await findLocally(
      [
        {
          id: 'claude-code',
          capabilities: ['find', 'status'],
          find: () => [source],
          status: async () => ({ ok: false, reason: 'not_found', detail: 'No live owner' }),
        },
      ],
      { includeClosed: false, limit: 20 }
    );
    expect(result.groups[0].work[0]).toMatchObject({
      title: 'Historical heron plan',
      worker: {
        adapter: 'claude-code',
        id: 'claude-code-1',
        name: null,
        label: 'Claude · claude-code-1',
      },
    });
  });

  test('one discovery read serves a concurrent history batch and the next batch reads again', async () => {
    let reads = 0;
    const adapter = createClaudeCodeAdapter({
      machine: 'synthetic',
      desktopSessions: async () => new Set(),
      searchChats: async () =>
        Array.from({ length: 10 }, (_, i) => ({
          ...chat(`history-${i}`),
          kind: 'claude' as const,
        })),
      liveSessions: async () => {
        reads++;
        await new Promise((done) => setTimeout(done, 0));
        return [];
      },
    });
    const query = { text: 'history', includeClosed: false, limit: 20 };
    const first = await findLocally([adapter], query);
    expect(first.groups.flatMap((group) => group.work)).toHaveLength(10);
    expect(reads).toBe(1);
    await findLocally([adapter], query);
    expect(reads).toBe(2);
  });
});
