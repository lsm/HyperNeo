import { setStandaloneTaskDependencies } from '../../../../src/storage/tasks/set-task-dependencies';
import { transitionStandaloneTask } from '../../../../src/storage/tasks/transition-task';
import { createStandaloneTaskMetadataEditor } from '../../../../src/lib/operations/task-metadata-standalone';
import { listTaskCores } from '../../../../src/storage/tasks/list-tasks';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';
import { setupOperationHandlers } from '../../../../src/lib/rpc-handlers/operation-handlers';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const message = { type: 'user', message: { content: 'hello' }, parent_tool_use_id: null };

describe('operation.invoke RPC registration', () => {
  let mailbox: MailboxTestDb;
  let taskDb: Database;
  let client: MessageHub;
  let server: MessageHub;
  let transports: [InProcessTransport, InProcessTransport];
  let unregister: () => void;
  beforeEach(async () => {
    mailbox = createMailboxTestDb();
    taskDb = new Database(':memory:');
    createSpaceTables(taskDb);
    client = new MessageHub();
    server = new MessageHub();
    transports = InProcessTransport.createPair();
    client.registerTransport(transports[0]);
    server.registerTransport(transports[1]);
    unregister = setupOperationHandlers(server, mailbox.jobQueue, {
      readTask: (taskId) => readTaskCore(taskDb, taskId),
      createTask: (input, creatorSessionId) =>
        createStandaloneTask(taskDb, input, creatorSessionId, () => {}),
      listTasks: (input) => listTaskCores(taskDb, input),
      editTask: createStandaloneTaskMetadataEditor(taskDb, () => {}),
      transitionTask: (input) => transitionStandaloneTask(taskDb, input, () => {}),
      setDependencies: (input) => setStandaloneTaskDependencies(taskDb, input, () => {}),
    });
    await Promise.all(transports.map((transport) => transport.initialize()));
  });
  afterEach(async () => {
    unregister();
    client.cleanup();
    server.cleanup();
    await Promise.all(transports.map((transport) => transport.close()));
    mailbox.close();
    taskDb.close();
  });

  test('responds with persisted acceptance over the actual hub protocol', async () => {
    const receipt = await client.request<{ kind: string; mailboxId: string; messageId: string }>(
      'operation.invoke',
      { name: 'message.send', input: { sessionId: 'destination', message } }
    );
    expect(receipt.kind).toBe('accepted');
    expect(mailbox.rows()).toHaveLength(1);
    const entry = JSON.parse(mailbox.rows()[0].payload);
    expect(entry.id).toBe(receipt.mailboxId);
    expect(entry.messageUuid).toBe(receipt.messageId);
    expect(entry.to).toEqual({ kind: 'session', sessionId: 'destination' });
    expect(entry.origin).toBe('chat');
    expect(mailbox.sdkRows()).toEqual([]);
  });

  test('discovers the runtime catalog and send schema without creating mailbox jobs', async () => {
    const listed = await client.request<{ name: string }[]>('operation.invoke', {
      name: 'operations.list',
    });
    expect(listed.map(({ name }) => name)).toEqual([
      'message.send',
      'task.get',
      'task.create',
      'task.list',
      'task.update',
      'task.transition',
      'task.dependencies.set',
      'operations.list',
      'operations.describe',
    ]);
    const described = await client.request<{
      found: boolean;
      inputSchema: { properties: Record<string, unknown> };
      resultSchema: Record<string, unknown>;
    }>('operation.invoke', {
      name: 'operations.describe',
      input: { name: 'message.send' },
    });
    expect(described.found).toBe(true);
    expect(described.inputSchema.properties).toHaveProperty('sessionId');
    expect(described.inputSchema.properties).toHaveProperty('message');
    expect(JSON.stringify(described.resultSchema)).toContain('"accepted"');
    for (const name of ['operations.list', 'operations.describe']) {
      expect(
        await client.request('operation.invoke', {
          name: 'operations.describe',
          input: { name },
        })
      ).toMatchObject({ found: true, name });
    }
    expect(
      await client.request('operation.invoke', {
        name: 'operations.describe',
        input: { name: 'missing' },
      })
    ).toEqual({ found: false, name: 'missing' });
    expect(mailbox.rows()).toEqual([]);
  });

  test('reads and discovers core task data through the hub without changing Space storage', async () => {
    const space = new SpaceRepository(taskDb).createSpace({
      workspacePath: '/workspace/test',
      slug: 'test',
      name: 'Test',
    });
    const tasks = new SpaceTaskRepository(taskDb);
    const stored = tasks.createTask({ spaceId: space.id, title: 'Read me', description: '' });
    const result = await client.request('operation.invoke', {
      name: 'task.get',
      input: { taskId: stored.id },
    });
    expect(result).toEqual(readTaskCore(taskDb, stored.id));
    expect(result).not.toHaveProperty('spaceId');
    expect(tasks.getTask(stored.id)).toEqual(stored);
    expect(
      await client.request('operation.invoke', {
        name: 'task.get',
        input: { taskId: 'absent' },
      })
    ).toBeNull();
    expect(
      await client.request('operation.invoke', {
        name: 'operations.describe',
        input: { name: 'task.get' },
      })
    ).toMatchObject({
      found: true,
      name: 'task.get',
      inputSchema: { properties: { taskId: { type: 'string' } } },
    });
    expect(mailbox.rows()).toEqual([]);
  });

  test('creates an independent task through RPC and ignores spoofed caller provenance', async () => {
    const task = await client.request<TaskCore>('operation.invoke', {
      name: 'task.create',
      input: { title: '  Work  ', priority: 'high', labels: ['test'] },
      caller: { source: 'mcp', sessionId: 'spoofed' },
    });
    expect(task).toMatchObject({
      title: 'Work',
      status: 'open',
      priority: 'high',
      labels: ['test'],
    });
    expect(
      await client.request('operation.invoke', { name: 'task.get', input: { taskId: task.id } })
    ).toEqual(task);
    expect(
      taskDb
        .prepare('SELECT space_id, task_number, created_by_session FROM space_tasks WHERE id = ?')
        .get(task.id)
    ).toEqual({ space_id: null, task_number: null, created_by_session: null });
    expect(mailbox.rows()).toEqual([]);
  });

  test('updates standalone metadata and discovers the shared update schema', async () => {
    const task = await client.request<TaskCore>('operation.invoke', {
      name: 'task.create',
      input: { title: 'Work', description: 'Details', labels: ['one'] },
    });
    const updated = await client.request<TaskCore>('operation.invoke', {
      name: 'task.update',
      input: { taskId: task.id, title: '  Renamed  ', labels: [] },
    });
    expect(updated).toEqual({
      ...task,
      title: 'Renamed',
      labels: [],
      updatedAt: expect.any(Number),
    });
    expect(
      await client.request('operation.invoke', { name: 'task.get', input: { taskId: task.id } })
    ).toEqual(updated);
    const space = new SpaceRepository(taskDb).createSpace({
      name: 'Test',
      slug: 'update',
      workspacePath: '/workspace/update',
    });
    const tasks = new SpaceTaskRepository(taskDb);
    const owned = tasks.createTask({ spaceId: space.id, title: 'Owned', description: '' });
    for (const taskId of [owned.id, 'absent']) {
      expect(
        await client.request('operation.invoke', {
          name: 'task.update',
          input: { taskId, title: 'Changed' },
        })
      ).toBeNull();
    }
    expect(tasks.getTask(owned.id)).toEqual(owned);
    expect(
      await client.request('operation.invoke', {
        name: 'operations.describe',
        input: { name: 'task.update' },
      })
    ).toMatchObject({
      found: true,
      inputSchema: { properties: { taskId: { type: 'string' }, title: { type: 'string' } } },
    });
    expect(mailbox.rows()).toEqual([]);
  });

  test.each([
    {},
    { title: ' ' },
    { priority: 'invalid' },
    { labels: [1] },
    { status: 'done' },
    { spaceId: 'space' },
    { dependsOn: [] },
  ])('rejects invalid metadata patches without changing the task: %j', async (patch) => {
    const task = createStandaloneTask(taskDb, { title: 'Original' }, undefined, () => {});
    await expect(
      client.request('operation.invoke', {
        name: 'task.update',
        input: { taskId: task.id, ...patch },
      })
    ).rejects.toThrow();
    expect(readTaskCore(taskDb, task.id)).toEqual(task);
  });

  test('manages standalone lifecycle through RPC without changing Space tasks', async () => {
    const task = createStandaloneTask(taskDb, { title: 'Work' }, undefined, () => {});
    for (const status of [
      'in_progress',
      'blocked',
      'done',
      'in_progress',
      'cancelled',
      'open',
      'archived',
    ]) {
      const result = await client.request<TaskCore>('operation.invoke', {
        name: 'task.transition',
        input: { taskId: task.id, status, ...(status === 'done' ? { result: 'Finished' } : {}) },
      });
      expect(result.status).toBe(status);
      expect(readTaskCore(taskDb, task.id)).toEqual(result);
      if (status === 'done') expect(result.result).toBe('Finished');
      if (status === 'open')
        expect(result).toMatchObject({ result: null, startedAt: null, completedAt: null });
    }
    expect(
      await client.request('operation.invoke', {
        name: 'task.transition',
        input: { taskId: task.id, status: 'open' },
      })
    ).toBe('invalid_transition');
    expect(await client.request('operation.invoke', { name: 'task.list' })).toEqual({
      tasks: [],
      nextCursor: null,
    });
    const space = new SpaceRepository(taskDb).createSpace({
      name: 'Test',
      slug: 'transition',
      workspacePath: '/workspace/transition',
    });
    const tasks = new SpaceTaskRepository(taskDb);
    const owned = tasks.createTask({ spaceId: space.id, title: 'Owned', description: '' });
    for (const taskId of [owned.id, 'absent']) {
      expect(
        await client.request('operation.invoke', {
          name: 'task.transition',
          input: { taskId, status: 'done' },
        })
      ).toBeNull();
    }
    expect(tasks.getTask(owned.id)).toEqual(owned);
    expect(
      await client.request('operation.invoke', {
        name: 'operations.describe',
        input: { name: 'task.transition' },
      })
    ).toMatchObject({
      found: true,
      inputSchema: {
        properties: {
          status: { enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled', 'archived'] },
        },
      },
    });
    expect(mailbox.rows()).toEqual([]);
  });

  test('returns lifecycle rejection codes and rejects invalid schemas before writing', async () => {
    const task = createStandaloneTask(taskDb, { title: 'Work' }, undefined, () => {});
    expect(
      await client.request('operation.invoke', {
        name: 'task.transition',
        input: { taskId: task.id, status: 'blocked', result: 'No' },
      })
    ).toBe('result_requires_done');
    for (const patch of [
      { status: 'approved' },
      { status: 'rate_limited' },
      { status: 'done', result: 1 },
      { status: 'done', title: 'Changed' },
    ]) {
      await expect(
        client.request('operation.invoke', {
          name: 'task.transition',
          input: { taskId: task.id, ...patch },
        })
      ).rejects.toThrow();
    }
    expect(readTaskCore(taskDb, task.id)).toEqual(task);
  });

  test('sets and clears standalone dependencies through RPC and rejects cycles', async () => {
    const a = createStandaloneTask(taskDb, { title: 'A' }, undefined, () => {});
    const b = createStandaloneTask(taskDb, { title: 'B' }, undefined, () => {});
    const set = (taskId: string, dependsOn: string[]) =>
      client.request('operation.invoke', {
        name: 'task.dependencies.set',
        input: { taskId, dependsOn },
      });
    expect(await set(a.id, [b.id])).toMatchObject({ id: a.id, dependsOn: [b.id] });
    expect(await set(b.id, [a.id])).toBe('dependency_cycle');
    expect(readTaskCore(taskDb, b.id)).toEqual(b);
    expect(await set(a.id, [b.id, b.id])).toBe('duplicate_dependency');
    expect(await set(a.id, [a.id])).toBe('self_dependency');
    expect(await set(a.id, ['absent'])).toBe('dependency_not_found');
    expect(await set(a.id, [])).toMatchObject({ id: a.id, dependsOn: [] });
    expect(await set('absent', [])).toBeNull();
    const space = new SpaceRepository(taskDb).createSpace({
      name: 'Test',
      slug: 'dependencies',
      workspacePath: '/workspace/dependencies',
    });
    const tasks = new SpaceTaskRepository(taskDb);
    const owned = tasks.createTask({ spaceId: space.id, title: 'Owned', description: '' });
    expect(await set(owned.id, [a.id])).toBeNull();
    expect(await set(a.id, [owned.id])).toBe('dependency_not_found');
    expect(tasks.getTask(owned.id)).toEqual(owned);
    expect(
      await client.request('operation.invoke', {
        name: 'operations.describe',
        input: { name: 'task.dependencies.set' },
      })
    ).toMatchObject({ found: true, inputSchema: { properties: { dependsOn: { type: 'array' } } } });
    expect(mailbox.rows()).toEqual([]);
  });

  test.each([
    {},
    { dependsOn: null },
    { dependsOn: [''] },
    { dependsOn: [1] },
    { dependsOn: [], status: 'done' },
  ])('rejects invalid dependency input: %j', async (patch) => {
    const task = createStandaloneTask(taskDb, { title: 'Work' }, undefined, () => {});
    await expect(
      client.request('operation.invoke', {
        name: 'task.dependencies.set',
        input: { taskId: task.id, ...patch },
      })
    ).rejects.toThrow();
    expect(readTaskCore(taskDb, task.id)).toEqual(task);
  });

  test('lists standalone pages and explicit Space/status scopes through RPC', async () => {
    const space = new SpaceRepository(taskDb).createSpace({
      workspacePath: '/workspace/list',
      slug: 'list',
      name: 'List',
    });
    const owned = new SpaceTaskRepository(taskDb).createTask({
      spaceId: space.id,
      title: 'Owned',
      description: '',
    });
    const created = await Promise.all(
      ['A', 'B'].map((title) =>
        client.request<TaskCore>('operation.invoke', { name: 'task.create', input: { title } })
      )
    );
    const page = await client.request<{
      tasks: TaskCore[];
      nextCursor: { createdAt: number; id: string };
    }>('operation.invoke', { name: 'task.list', input: { limit: 1 } });
    expect(page.tasks).toHaveLength(1);
    expect(page.nextCursor).toEqual({ createdAt: page.tasks[0].createdAt, id: page.tasks[0].id });
    const last = await client.request<{ tasks: TaskCore[]; nextCursor: null }>('operation.invoke', {
      name: 'task.list',
      input: { limit: 1, before: page.nextCursor },
    });
    expect(last.nextCursor).toBeNull();
    expect([...page.tasks, ...last.tasks].map((task) => task.id).sort()).toEqual(
      created.map((task) => task.id).sort()
    );
    expect(
      await client.request('operation.invoke', {
        name: 'task.list',
        input: { spaceId: space.id, status: 'open' },
      })
    ).toEqual({ tasks: [readTaskCore(taskDb, owned.id)], nextCursor: null });
    taskDb.prepare("UPDATE space_tasks SET status = 'archived' WHERE id = ?").run(created[0].id);
    expect(await client.request('operation.invoke', { name: 'task.list' })).toEqual({
      tasks: [created[1]],
      nextCursor: null,
    });
    expect(
      await client.request('operation.invoke', {
        name: 'task.list',
        input: { status: 'archived' },
      })
    ).toMatchObject({ tasks: [{ id: created[0].id }], nextCursor: null });
    expect(
      await client.request('operation.invoke', {
        name: 'operations.describe',
        input: { name: 'task.list' },
      })
    ).toMatchObject({ found: true, inputSchema: { properties: { limit: { maximum: 100 } } } });
    expect(mailbox.rows()).toEqual([]);
  });

  test.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { status: 'invalid' },
    { spaceId: '' },
    { before: { id: 'task' } },
    { before: { createdAt: 1, id: '' } },
    { unexpected: true },
  ])('rejects invalid task listing input: %j', async (input) => {
    await expect(
      client.request('operation.invoke', { name: 'task.list', input })
    ).rejects.toThrow();
  });

  test.each([
    { title: ' ' },
    { title: 'Work', priority: 'invalid' },
    { title: 'Work', spaceId: 'space' },
    { title: 'Work', creatorSessionId: 'spoofed' },
  ])('rejects invalid task creation before writing: %j', async (input) => {
    await expect(
      client.request('operation.invoke', { name: 'task.create', input })
    ).rejects.toThrow();
    expect(taskDb.prepare('SELECT id FROM space_tasks').all()).toEqual([]);
  });

  test('rejects invalid operation input without persisting', async () => {
    await expect(
      client.request('operation.invoke', {
        name: 'message.send',
        input: { sessionId: '', message },
      })
    ).rejects.toThrow();
    expect(mailbox.rows()).toEqual([]);
  });

  test('keeps existing handlers and supports unregistering only the new endpoint', async () => {
    server.onRequest('message.send', () => ({ legacy: true }));
    expect(await client.request('message.send', {})).toEqual({ legacy: true });
    unregister();
    await expect(
      client.request('operation.invoke', {
        name: 'message.send',
        input: { sessionId: 'destination', message },
      })
    ).rejects.toThrow('No handler');
    expect(await client.request('message.send', {})).toEqual({ legacy: true });
    expect(mailbox.rows()).toEqual([]);
  });
});
