import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildSpaceGroups,
  createSpaceAdapter,
  spaceAgentWorkStatus,
  spaceTaskWorkStatus,
  spaceWorkRefForSession,
} from '../../../../src/lib/drivers/space-adapter';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { WorkChatMatch } from '../../../../src/storage/work-chat-search';

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

describe('spaceAgentWorkStatus', () => {
  test('reads closed and paused agents first, then the session like a HyperNeo chat', () => {
    expect(spaceAgentWorkStatus({ status: 'archived', processing: 'processing' })).toBe('stopped');
    expect(spaceAgentWorkStatus({ status: 'paused', processing: null })).toBe('needs_you');
    expect(spaceAgentWorkStatus({ status: 'active', processing: 'processing' })).toBe('running');
    expect(spaceAgentWorkStatus({ status: 'active', processing: 'rate_limit_cooldown' })).toBe(
      'queued'
    );
    expect(spaceAgentWorkStatus({ status: 'active', processing: 'interrupted' })).toBe('stopped');
    expect(spaceAgentWorkStatus({ status: 'active', processing: null })).toBe('done');
  });
});

describe('spaceTaskWorkStatus', () => {
  test.each([
    ['draft', 'queued'],
    ['rate_limited', 'queued'],
    ['in_progress', 'running'],
    ['approved', 'running'],
    ['review', 'needs_you'],
    ['blocked', 'needs_you'],
    ['done', 'done'],
    ['cancelled', 'stopped'],
  ] as const)('%s is %s', (status, expected) => {
    expect(spaceTaskWorkStatus(status)).toBe(expected);
  });
});

describe('buildSpaceGroups', () => {
  const space = (id: string, name: string, open = 1) => ({
    id,
    name,
    folder: `/focus/${name}`,
    open,
    openCount: 1,
    archivedCount: 0,
    lastActiveAt: 10,
  });
  const spaces = [space('sp1', 'dev-neokai'), space('sp2', 'ops'), space('sp3', 'old', 0)];
  const tasks = [
    {
      id: 't1',
      spaceId: 'sp1',
      taskNumber: 2008,
      title: 'Fix font size',
      status: 'in_progress',
      updatedAt: 10,
    },
  ];
  const query = { includeClosed: false, limit: 20 };

  test('lists open Spaces with their tasks, including Spaces with none', () => {
    const groups = buildSpaceGroups(spaces, tasks, query, { machine: 'imac' }, new Map());
    expect(groups.map((g) => [g.place.name, g.work.map((w) => w.title)])).toEqual([
      ['dev-neokai', ['#2008 Fix font size']],
      ['ops', []],
    ]);
    expect(groups[0].work[0]).toMatchObject({
      ref: { adapter: 'space', id: 't1' },
      place: { spaceId: 'sp1' },
      status: 'running',
      link: '/space/sp1/task/t1',
    });
  });

  test('matches tasks by number, title or full-text hit and Spaces by name', () => {
    const names = (text: string, hits: string[] = []) =>
      buildSpaceGroups(
        spaces,
        tasks,
        { ...query, text },
        { machine: 'imac' },
        new Map(hits.map((id) => [id, chat(null, id)]))
      ).map((g) => [g.place.name, g.work.length]);
    expect(names('2008')).toEqual([['dev-neokai', 1]]);
    expect(names('font')).toEqual([['dev-neokai', 1]]);
    expect(names('zzz', ['t1'])).toEqual([['dev-neokai', 1]]);
    expect(names('ops')).toEqual([['ops', 0]]);
  });

  test('narrows to one Space or to the Space working in a folder', () => {
    expect(
      buildSpaceGroups(spaces, tasks, { ...query, spaceId: 'sp2' }, { machine: 'imac' }, new Map())
    ).toHaveLength(1);
    expect(
      buildSpaceGroups(
        spaces,
        tasks,
        { ...query, folder: '/focus/dev-neokai' },
        { machine: 'imac' },
        new Map()
      ).map((g) => g.place.spaceId)
    ).toEqual(['sp1']);
  });
});

describe('space adapter against the space tables', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT, workspace_path TEXT, status TEXT,
      stopped INTEGER, updated_at INTEGER)`);
    db.exec(`CREATE TABLE space_tasks (id TEXT PRIMARY KEY, space_id TEXT, task_number INTEGER,
      title TEXT, status TEXT, updated_at INTEGER)`);
    db.exec(`CREATE TABLE space_long_horizon_agents (id TEXT PRIMARY KEY, space_id TEXT,
      handle TEXT, display_name TEXT, status TEXT, session_id TEXT, updated_at INTEGER)`);
    db.exec(
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, processing_state TEXT, last_active_at TEXT)`
    );
    db.exec(`INSERT INTO spaces VALUES ('sp1', 'dev-neokai', '/focus/dev-neokai', 'active', 0, 5),
      ('sp2', 'gone', '/focus/gone', 'archived', 0, 50)`);
    db.exec(`INSERT INTO space_tasks VALUES ('t1', 'sp1', 1, 'open one', 'review', 20),
      ('t2', 'sp1', 2, 'finished', 'done', 30), ('t3', 'sp1', 3, 'old', 'archived', 1)`);
  });
  afterEach(() => db.close());

  test('keeps every open task when closed tasks are added', async () => {
    const insert = db.prepare(`INSERT INTO space_tasks VALUES (?, 'sp1', ?, 'closed', 'done', ?)`);
    for (let n = 0; n < 600; n++) insert.run(`c${n}`, 100 + n, 1000 + n);
    const adapter = createSpaceAdapter({
      db: () => db,
      machine: 'imac',
      searchChats: async () => [],
      tasks: {
        create: async () => ({ reason: 'unused' }),
        cancel: async () => ({ reason: 'unused' }),
        message: async () => ({ reason: 'unused' }),
        messageAgent: async () => ({ reason: 'unused' }),
      },
    });
    const [group] = await adapter.find({ includeClosed: true, limit: 20, text: 'open one' });
    expect(group.work.map((w) => w.ref.id)).toEqual(['t1']);
  });

  test('finds an old closed task by text even when a busier Space has more recent ones', async () => {
    db.exec(`INSERT INTO spaces VALUES ('sp3', 'busy', '/focus/busy', 'active', 0, 5)`);
    const insert = db.prepare(`INSERT INTO space_tasks VALUES (?, 'sp3', ?, 'routine', 'done', ?)`);
    for (let n = 0; n < 600; n++) insert.run(`c${n}`, 100 + n, 1000 + n);
    const adapter = createSpaceAdapter({
      db: () => db,
      machine: 'imac',
      searchChats: async (text) => (text === 'parser' ? [chat('w2', 't2')] : []),
      tasks: {
        create: async () => ({ reason: 'unused' }),
        cancel: async () => ({ reason: 'unused' }),
        message: async () => ({ reason: 'unused' }),
        messageAgent: async () => ({ reason: 'unused' }),
      },
    });
    const find = (text?: string) => adapter.find({ includeClosed: true, limit: 20, text });
    expect((await find('finished')).flatMap((g) => g.work.map((w) => w.ref.id))).toEqual(['t2']);
    expect((await find('parser')).flatMap((g) => g.work.map((w) => w.ref.id))).toEqual(['t2']);
    const busy = (await find()).find((g) => g.place.spaceId === 'sp3');
    expect(busy?.work).toHaveLength(20);
  });

  test('returns active Spaces with open tasks and counts, newest activity first', async () => {
    const adapter = createSpaceAdapter({
      db: () => db,
      machine: 'imac',
      searchChats: async () => [],
      tasks: {
        create: async () => ({ reason: 'unused' }),
        cancel: async () => ({ reason: 'unused' }),
        message: async () => ({ reason: 'unused' }),
        messageAgent: async () => ({ reason: 'unused' }),
      },
    });
    const groups = await adapter.find({ includeClosed: false, limit: 20 });
    expect(
      groups.map((g) => [
        g.place.name,
        g.openCount,
        g.archivedCount,
        g.lastActivityAt,
        g.work.map((w) => w.ref.id),
      ])
    ).toEqual([['dev-neokai', 1, 1, 30, ['t1']]]);
  });

  test('lists active and paused Space agents with their live state and reports one', async () => {
    db.exec(`INSERT INTO sessions VALUES ('s1', '{"status":"processing"}', 'not a date'),
      ('s2', 'not json', '1970-01-01T00:00:00.100Z')`);
    db.exec(`INSERT INTO space_long_horizon_agents VALUES
      ('a1', 'sp1', 'ui-ux', 'Designer', 'active', 's1', 40),
      ('a2', 'sp1', 'docs', 'Writer', 'paused', 's2', 35),
      ('a3', 'sp1', 'old', 'Retired', 'archived', NULL, 50)`);
    const adapter = createSpaceAdapter({
      db: () => db,
      machine: 'imac',
      searchChats: async (text) => (text === '16px' ? [chat('s1')] : []),
      tasks: {
        create: async () => ({ reason: 'unused' }),
        cancel: async () => ({ reason: 'unused' }),
        message: async () => ({ reason: 'unused' }),
        messageAgent: async () => ({ reason: 'unused' }),
      },
    });
    const [group] = await adapter.find({ includeClosed: false, limit: 20 });
    expect(group.work.map((w) => [w.ref.id, w.title, w.status])).toEqual([
      ['agent:a2', '@docs Writer', 'needs_you'],
      ['agent:a1', '@ui-ux Designer', 'running'],
      ['t1', '#1 open one', 'needs_you'],
    ]);
    const [designer] = await adapter.find({ includeClosed: false, limit: 20, text: 'designer' });
    expect(designer.work.map((w) => w.ref.id)).toEqual(['agent:a1']);
    const [byChat] = await adapter.find({ includeClosed: false, limit: 20, text: '16px' });
    expect(byChat.work.map((w) => w.ref.id)).toEqual(['agent:a1']);
    expect(await adapter.status?.({ adapter: 'space', id: 'agent:a3' })).toEqual({
      ok: true,
      value: {
        ref: { adapter: 'space', id: 'agent:a3' },
        title: '@old Retired',
        place: { machine: 'imac', spaceId: 'sp1', name: 'dev-neokai' },
        status: 'stopped',
        lastActivityAt: 50,
        link: '/space/sp1/agent/old',
      },
    });
    expect(await adapter.status?.({ adapter: 'space', id: 'agent:nope' })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('spaceWorkRefForSession', () => {
  test('names the one task or agent that owns a session, and nothing when unclear', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE space_long_horizon_agents (id TEXT, session_id TEXT);
      CREATE TABLE space_tasks (id TEXT, task_agent_session_id TEXT, workflow_run_id TEXT);
      CREATE TABLE node_executions (workflow_run_id TEXT, agent_session_id TEXT);
      INSERT INTO space_long_horizon_agents VALUES ('ops', 's-agent');
      INSERT INTO space_tasks VALUES ('t1', 's-task', NULL), ('t2', NULL, 'run-2'), ('t3', 's-both', NULL);
      INSERT INTO node_executions VALUES ('run-2', 's-node'), ('run-2', 's-both');`);
    expect(spaceWorkRefForSession(db, 's-agent')).toEqual({ adapter: 'space', id: 'agent:ops' });
    expect(spaceWorkRefForSession(db, 's-task')).toEqual({ adapter: 'space', id: 't1' });
    expect(spaceWorkRefForSession(db, 's-node')).toEqual({ adapter: 'space', id: 't2' });
    expect(spaceWorkRefForSession(db, 's-both')).toBeNull();
    expect(spaceWorkRefForSession(db, 'ordinary')).toBeNull();
    db.close();
  });
});
