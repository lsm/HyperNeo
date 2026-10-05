import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  buildSpaceGroups,
  createSpaceAdapter,
  spaceTaskWorkStatus,
} from '../../../../src/lib/drivers/space-adapter';

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
    const groups = buildSpaceGroups(spaces, tasks, query, { machine: 'imac' }, new Set());
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
      buildSpaceGroups(spaces, tasks, { ...query, text }, { machine: 'imac' }, new Set(hits)).map(
        (g) => [g.place.name, g.work.length]
      );
    expect(names('2008')).toEqual([['dev-neokai', 1]]);
    expect(names('font')).toEqual([['dev-neokai', 1]]);
    expect(names('zzz', ['t1'])).toEqual([['dev-neokai', 1]]);
    expect(names('ops')).toEqual([['ops', 0]]);
  });

  test('narrows to one Space or to the Space working in a folder', () => {
    expect(
      buildSpaceGroups(spaces, tasks, { ...query, spaceId: 'sp2' }, { machine: 'imac' }, new Set())
    ).toHaveLength(1);
    expect(
      buildSpaceGroups(
        spaces,
        tasks,
        { ...query, folder: '/focus/dev-neokai' },
        { machine: 'imac' },
        new Set()
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
      searchTaskIds: () => new Set(),
      tasks: {
        create: async () => ({ reason: 'unused' }),
        cancel: async () => ({ reason: 'unused' }),
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
      searchTaskIds: (text) => new Set(text === 'parser' ? ['t2'] : []),
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
      searchTaskIds: () => new Set(),
      tasks: {
        create: async () => ({ reason: 'unused' }),
        cancel: async () => ({ reason: 'unused' }),
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
});
