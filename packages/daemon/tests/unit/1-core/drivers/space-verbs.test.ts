import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  createSpaceAdapter,
  spaceTaskCaller,
  taskOperationRejection,
} from '../../../../src/lib/drivers/space-adapter';

describe('taskOperationRejection', () => {
  test('reads a task or an accepted job as success and anything else as a reason', () => {
    expect(taskOperationRejection({ id: 't1', status: 'cancelled' })).toBeNull();
    expect(taskOperationRejection({ accepted: true, jobId: null })).toBeNull();
    expect(taskOperationRejection('invalid_transition')).toBe('invalid_transition');
    expect(taskOperationRejection({ accepted: false, reason: 'busy', detail: 'run active' })).toBe(
      'busy: run active'
    );
    expect(taskOperationRejection(null)).toBe('No task came back.');
  });
});

describe('spaceTaskCaller', () => {
  test('lets Neo act on any Space and keeps every other agent in its own Space', () => {
    expect(spaceTaskCaller({ source: 'mcp', sessionId: 'neo:root', role: 'neo' })).toEqual({
      source: 'internal',
      sessionId: 'neo:root',
      role: 'neo',
    });
    const worker = { source: 'mcp' as const, sessionId: 'w1', role: 'workflow_worker' as const };
    expect(spaceTaskCaller(worker)).toBe(worker);
    expect(spaceTaskCaller({ source: 'rpc' })).toEqual({ source: 'rpc' });
  });
});

describe('space adapter start, status and stop', () => {
  let db: Database;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    db = new Database(':memory:');
    db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT)`);
    db.exec(`CREATE TABLE space_tasks (id TEXT PRIMARY KEY, space_id TEXT, task_number INTEGER,
      title TEXT, status TEXT, updated_at INTEGER, result TEXT, reported_summary TEXT, block_reason TEXT)`);
    db.exec(`INSERT INTO spaces VALUES ('sp1', 'dev-neokai')`);
    db.exec(`INSERT INTO space_tasks VALUES
      ('t1', 'sp1', 7, 'font size', 'blocked', 10, NULL, NULL, 'human_input_requested'),
      ('t2', 'sp1', 8, 'shipped', 'done', 20, 'Merged in #5600', NULL, NULL)`);
  });

  afterEach(() => db.close());

  function adapter(refuse?: string) {
    return createSpaceAdapter({
      db: () => db,
      machine: 'imac',
      searchTaskIds: () => new Set(),
      tasks: {
        create: async (spaceId, title, description, caller) => {
          calls.push(`create ${spaceId} ${title}: ${description} as ${caller.source}`);
          if (refuse) return { reason: refuse };
          db.exec(
            `INSERT INTO space_tasks VALUES ('t3', '${spaceId}', 9, '${title}', 'open', 30, NULL, NULL, NULL)`
          );
          return { taskId: 't3' };
        },
        cancel: async (taskId, caller) => {
          calls.push(`cancel ${taskId} as ${caller.source}`);
          return refuse ? { reason: refuse } : { cancelled: true };
        },
      },
    });
  }

  const ref = (id: string) => ({ adapter: 'space', id });
  const rpc = { source: 'rpc' as const };
  const space = { machine: 'imac', spaceId: 'sp1', name: 'dev-neokai' };

  test('start creates a task in the Space with the message as its description', async () => {
    expect(
      await adapter().start?.(
        { place: space, title: 'bigger font', message: 'raise it to 16px' },
        { from: 'chat', caller: rpc }
      )
    ).toEqual({
      ok: true,
      value: {
        ref: ref('t3'),
        title: '#9 bigger font',
        place: space,
        status: 'queued',
        lastActivityAt: 30,
        link: '/space/sp1/task/t3',
      },
    });
    expect(calls).toEqual(['create sp1 bigger font: raise it to 16px as rpc']);
  });

  test('start needs a Space on this machine and passes a refusal through', async () => {
    const start = (place: Record<string, string>, refuse?: string) =>
      adapter(refuse).start?.(
        { place: place as never, title: 't', message: 'm' },
        { from: 'chat', caller: rpc }
      );
    expect(await start({ machine: 'imac', name: 'x', folder: '/x' })).toMatchObject({
      ok: false,
      reason: 'invalid_place',
    });
    expect(await start({ ...space, machine: 'laptop' })).toMatchObject({ reason: 'invalid_place' });
    expect(await start(space, 'Space is archived')).toEqual({
      ok: false,
      reason: 'invalid_place',
      detail: 'Space is archived',
    });
  });

  test('status reports the task with its result or block reason', async () => {
    expect(await adapter().status?.(ref('t1'))).toMatchObject({
      ok: true,
      value: { status: 'needs_you', lastReply: 'human_input_requested' },
    });
    expect(await adapter().status?.(ref('t2'))).toMatchObject({
      ok: true,
      value: { status: 'done', lastReply: 'Merged in #5600' },
    });
    expect(await adapter().status?.(ref('nope'))).toMatchObject({ ok: false, reason: 'not_found' });
  });

  test('stop leaves a draft alone because it never started', async () => {
    db.exec(
      `INSERT INTO space_tasks VALUES ('t4', 'sp1', 10, 'idea', 'draft', 40, NULL, NULL, NULL)`
    );
    expect(await adapter().stop?.(ref('t4'), { from: 'chat', caller: rpc })).toEqual({
      ok: true,
      value: { stopped: false },
    });
    expect(calls).toEqual([]);
  });

  test('stop cancels open tasks and leaves finished ones alone', async () => {
    expect(await adapter().stop?.(ref('t1'), { from: 'chat', caller: rpc })).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(await adapter().stop?.(ref('t2'), { from: 'chat', caller: rpc })).toEqual({
      ok: true,
      value: { stopped: false },
    });
    expect(
      await adapter('invalid_transition').stop?.(ref('t1'), { from: 'chat', caller: rpc })
    ).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'invalid_transition',
    });
    expect(calls).toEqual(['cancel t1 as rpc', 'cancel t1 as rpc']);
  });
});
