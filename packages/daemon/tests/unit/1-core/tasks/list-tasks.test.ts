import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { listTaskCores } from '../../../../src/storage/tasks/list-tasks';
import { createSpaceTables } from '../../helpers/space-test-db';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';

describe('bounded core task listing', () => {
  let db: Database;
  let spaceId: string;
  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    spaceId = new SpaceRepository(db).createSpace({
      name: 'Test',
      slug: 'test',
      workspacePath: '/workspace/test',
    }).id;
    const insert = db.prepare(`INSERT INTO space_tasks
      (id, space_id, task_number, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run('a', null, null, 'A', 'open', 10, 10);
    insert.run('b', null, null, 'B', 'done', 10, 100);
    insert.run('c', null, null, 'C', 'open', 20, 20);
    insert.run('archived', null, null, 'Archived', 'archived', 30, 30);
    insert.run('owned', spaceId, 1, 'Owned', 'open', 40, 40);
  });
  afterEach(() => db.close());

  test('defaults to standalone non-archived tasks and returns only core fields', () => {
    const page = listTaskCores(db, {});
    expect(page.tasks.map((task) => task.id)).toEqual(['c', 'b', 'a']);
    expect(page.nextCursor).toBeNull();
    expect(page.tasks[0]).not.toHaveProperty('spaceId');
    expect(page.tasks[0]).not.toHaveProperty('taskNumber');
    expect(page.tasks[0]).toMatchObject({ title: 'C', labels: [], dependsOn: [], status: 'open' });
  });

  test('pages tied creation timestamps without depending on mutable update timestamps', () => {
    const first = listTaskCores(db, { limit: 2 });
    expect(first.tasks.map((task) => task.id)).toEqual(['c', 'b']);
    expect(first.nextCursor).toEqual({ createdAt: 10, id: 'b' });
    db.exec("UPDATE space_tasks SET updated_at = 999 WHERE id = 'a'");
    const second = listTaskCores(db, { limit: 2, before: first.nextCursor! });
    expect(second.tasks.map((task) => task.id)).toEqual(['a']);
    expect(second.nextCursor).toBeNull();
  });

  test('supports explicit Space scope and status filters without mixing owners', () => {
    expect(listTaskCores(db, { spaceId }).tasks.map((task) => task.id)).toEqual(['owned']);
    expect(listTaskCores(db, { status: 'open' }).tasks.map((task) => task.id)).toEqual(['c', 'a']);
    expect(listTaskCores(db, { status: 'archived' }).tasks.map((task) => task.id)).toEqual([
      'archived',
    ]);
    expect(listTaskCores(db, { spaceId, status: 'done' })).toEqual({
      tasks: [],
      total: 0,
      nextCursor: null,
    });
    expect(listTaskCores(db, { spaceId: "' OR 1=1 --" }).tasks).toEqual([]);
  });

  test('total counts every match regardless of limit, offset or cursor', () => {
    const page = listTaskCores(db, { limit: 1 });
    expect(page.tasks.map((task) => task.id)).toEqual(['c']);
    expect(page.total).toBe(3);
    expect(listTaskCores(db, { limit: 1, before: page.nextCursor! }).total).toBe(3);
    expect(listTaskCores(db, { status: 'open' }).total).toBe(2);
    expect(listTaskCores(db, { spaceId }).total).toBe(1);
  });

  test('offset skips matches while keeping order, and normalizes invalid values', () => {
    expect(listTaskCores(db, { offset: 1 }).tasks.map((task) => task.id)).toEqual(['b', 'a']);
    expect(listTaskCores(db, { limit: 1, offset: 2 }).tasks.map((task) => task.id)).toEqual(['a']);
    expect(listTaskCores(db, { offset: 99 }).tasks).toEqual([]);
    expect(listTaskCores(db, { offset: 99 }).total).toBe(3);
    expect(listTaskCores(db, { offset: -5 }).tasks.map((task) => task.id)).toEqual(['c', 'b', 'a']);
    expect(listTaskCores(db, { offset: 1.9 }).tasks.map((task) => task.id)).toEqual(['b', 'a']);
    expect(listTaskCores(db, { offset: Number.NaN }).tasks.map((task) => task.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  test('a page that ends exactly on the last match reports no nextCursor', () => {
    const page = listTaskCores(db, { limit: 2, offset: 1 });
    expect(page.tasks.map((task) => task.id)).toEqual(['b', 'a']);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(3);
  });

  test('blockReason narrows to one reason, and null selects tasks with none', () => {
    const insert = db.prepare(
      "INSERT INTO space_tasks (id, space_id, task_number, title, status, block_reason, created_at, updated_at) VALUES (?, ?, ?, ?, 'blocked', ?, ?, ?)"
    );
    insert.run('crashed', spaceId, 10, 'Crashed', 'agent_crashed', 50, 50);
    insert.run('waiting', spaceId, 11, 'Waiting', 'human_input_requested', 60, 60);
    insert.run('bare', spaceId, 12, 'Bare', null, 70, 70);

    const one = listTaskCores(db, { spaceId, status: 'blocked', blockReason: 'agent_crashed' });
    expect(one.tasks.map((task) => task.id)).toEqual(['crashed']);
    expect(one.total).toBe(1);
    expect(
      listTaskCores(db, { spaceId, status: 'blocked', blockReason: null }).tasks.map((t) => t.id)
    ).toEqual(['bare']);
    expect(
      listTaskCores(db, { spaceId, status: 'blocked', blockReason: 'dependency_added' }).tasks
    ).toEqual([]);
  });

  test('blockReasonNotIn excludes the listed reasons and keeps tasks with none', () => {
    const insert = db.prepare(
      "INSERT INTO space_tasks (id, space_id, task_number, title, status, block_reason, created_at, updated_at) VALUES (?, ?, ?, ?, 'blocked', ?, ?, ?)"
    );
    insert.run('crashed', spaceId, 10, 'Crashed', 'agent_crashed', 50, 50);
    insert.run('waiting', spaceId, 11, 'Waiting', 'human_input_requested', 60, 60);
    insert.run('bare', spaceId, 12, 'Bare', null, 70, 70);

    const page = listTaskCores(db, {
      spaceId,
      status: 'blocked',
      blockReasonNotIn: ['agent_crashed'],
    });
    expect(page.tasks.map((task) => task.id)).toEqual(['bare', 'waiting']);
    expect(page.total).toBe(2);
    expect(
      listTaskCores(db, {
        spaceId,
        status: 'blocked',
        blockReasonNotIn: ['agent_crashed', 'human_input_requested'],
      }).tasks.map((task) => task.id)
    ).toEqual(['bare']);
  });

  test('a block-reason filter composes with paging and leaves other statuses empty', () => {
    const insert = db.prepare(
      "INSERT INTO space_tasks (id, space_id, task_number, title, status, block_reason, created_at, updated_at) VALUES (?, ?, ?, ?, 'blocked', 'agent_crashed', ?, ?)"
    );
    insert.run('c1', spaceId, 10, 'One', 50, 50);
    insert.run('c2', spaceId, 11, 'Two', 60, 60);

    const first = listTaskCores(db, {
      spaceId,
      status: 'blocked',
      blockReason: 'agent_crashed',
      limit: 1,
    });
    expect(first.tasks.map((task) => task.id)).toEqual(['c2']);
    expect(first.total).toBe(2);
    expect(first.nextCursor).toEqual({ createdAt: 60, id: 'c2' });
    const second = listTaskCores(db, {
      spaceId,
      status: 'blocked',
      blockReason: 'agent_crashed',
      limit: 1,
      before: first.nextCursor!,
    });
    expect(second.tasks.map((task) => task.id)).toEqual(['c1']);
    expect(second.total).toBe(2);
    expect(
      listTaskCores(db, { spaceId, status: 'blocked', blockReasonNotIn: [] }).tasks.map(
        (task) => task.id
      )
    ).toEqual(['c2', 'c1']);
  });

  test('bounds page size and normalizes invalid limits', () => {
    const insert = db.prepare(
      "INSERT INTO space_tasks (id, title, status, created_at, updated_at) VALUES (?, 'Extra', 'open', 1, 1)"
    );
    for (let i = 0; i < 110; i++) insert.run(`extra-${i}`);
    expect(listTaskCores(db, {}).tasks).toHaveLength(50);
    expect(listTaskCores(db, { limit: 1000 }).tasks).toHaveLength(100);
    expect(listTaskCores(db, { limit: 0 }).tasks).toHaveLength(1);
    expect(listTaskCores(db, { limit: 2.9 }).tasks).toHaveLength(2);
    expect(listTaskCores(db, { limit: Number.NaN }).tasks).toHaveLength(50);
  });
});
