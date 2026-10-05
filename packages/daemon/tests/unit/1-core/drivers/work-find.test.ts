import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { mergePlaceGroups } from '../../../../src/lib/drivers/places';
import {
  buildHyperneoGroups,
  createHyperneoAdapter,
  hyperneoWorkStatus,
} from '../../../../src/lib/drivers/hyperneo-adapter';
import { createFindWorkOperation } from '../../../../src/lib/drivers/find-operation';
import type { PlaceGroup, WorkAdapter } from '../../../../src/lib/drivers/types';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

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
});

describe('hyperneoWorkStatus', () => {
  test.each([
    ['active', 'processing', 'running'],
    ['active', 'queued', 'queued'],
    ['active', 'waiting_for_input', 'needs_you'],
    ['pending_worktree_choice', null, 'needs_you'],
    ['active', 'rate_limit_cooldown', 'queued'],
    ['active', 'interrupted', 'stopped'],
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
    const groups = buildHyperneoGroups(places, sessions, query, { machine: 'imac' }, new Set());
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
        new Set()
      ).map((g) => g.place.name)
    ).toEqual(['dolmen', 'superpipe', 'a1']);
  });

  test('matches a place by name even when nothing in it is open', () => {
    const groups = buildHyperneoGroups(
      places,
      sessions,
      { ...query, text: 'superpipe' },
      { machine: 'imac' },
      new Set()
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
        new Set(['s1'])
      ).flatMap((g) => g.work.map((w) => w.ref.id))
    ).toEqual(['s1']);
    expect(
      buildHyperneoGroups(
        places,
        sessions,
        { ...query, text: 'loader' },
        { machine: 'imac' },
        new Set()
      ).flatMap((g) => g.work.map((w) => w.ref.id))
    ).toEqual(['s1']);
  });

  test('leaves Spaces to the space adapter', () => {
    expect(
      buildHyperneoGroups(
        places,
        sessions,
        { ...query, spaceId: 'sp' },
        { machine: 'imac' },
        new Set()
      )
    ).toEqual([]);
  });
});

describe('hyperneo adapter against the sessions table', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, workspace_path TEXT, main_repo_path TEXT,
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

  test('groups its own sessions by project root and adds folders from workspace history', async () => {
    const adapter = createHyperneoAdapter({
      db: () => db,
      machine: 'imac',
      searchSessionIds: () => new Set(),
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
