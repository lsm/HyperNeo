import { beforeEach, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

const caller = { source: 'mcp' as const, sessionId: 'session-1' };

let db: Database;
let taskRepo: SpaceTaskRepository;
let spaceId: string;
let otherSpaceId: string;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  taskRepo = new SpaceTaskRepository(db);
  const spaces = new SpaceRepository(db);
  spaceId = spaces.createSpace({ name: 'First', slug: 'first', workspacePath: '/a' }).id;
  otherSpaceId = spaces.createSpace({ name: 'Second', slug: 'second', workspacePath: '/b' }).id;
});

function catalog(withNumbers: boolean) {
  return createDatabaseOperationCatalog(
    { getDatabase: () => db, notifyChange: () => {} } as never,
    new JobQueueRepository(db),
    {
      readTask: (taskId) => taskRepo.getTask(taskId) ?? readTaskCore(db, taskId),
      readTaskByNumber: withNumbers
        ? (sid, number) => taskRepo.getTaskByNumber(sid, number)
        : undefined,
    }
  );
}

test('a Space task resolves by its number exactly as it does by its id', async () => {
  const task = taskRepo.createTask({ spaceId, title: 'Numbered', description: '' });
  expect(task.taskNumber).toBeGreaterThan(0);

  const byId = await invokeOperation(catalog(true), 'task.get', { taskId: task.id }, caller);
  const byNumber = await invokeOperation(
    catalog(true),
    'task.get',
    { spaceId, taskNumber: task.taskNumber },
    caller
  );

  expect(byNumber).toEqual(byId);
  expect((byNumber as { value: { id: string } }).value.id).toBe(task.id);
});

test('the same number in another space never crosses the space boundary', async () => {
  const mine = taskRepo.createTask({ spaceId, title: 'Mine', description: '' });
  const theirs = taskRepo.createTask({
    spaceId: otherSpaceId,
    title: 'Theirs',
    description: '',
  });
  expect(theirs.taskNumber).toBe(mine.taskNumber);

  const outcome = await invokeOperation(
    catalog(true),
    'task.get',
    { spaceId: otherSpaceId, taskNumber: mine.taskNumber },
    caller
  );

  expect((outcome as { value: { id: string; title: string } }).value.title).toBe('Theirs');
});

test('an unknown number reads as null rather than failing', async () => {
  const outcome = await invokeOperation(
    catalog(true),
    'task.get',
    { spaceId, taskNumber: 9999 },
    caller
  );
  expect(outcome).toEqual({ kind: 'completed', value: null });
});

test('a standalone task has no number to look up', async () => {
  const standalone = createStandaloneTask(
    db,
    { title: 'Loose', description: '' },
    undefined,
    () => {}
  );
  const byId = await invokeOperation(catalog(true), 'task.get', { taskId: standalone.id }, caller);
  expect((byId as { value: { id: string } }).value.id).toBe(standalone.id);

  const byNumber = await invokeOperation(
    catalog(true),
    'task.get',
    { spaceId, taskNumber: 1 },
    caller
  );
  expect(byNumber).toEqual({ kind: 'completed', value: null });
});

test('the number form is refused without a spaceId, since numbers are space-scoped', async () => {
  const task = taskRepo.createTask({ spaceId, title: 'Numbered', description: '' });
  const outcome = await invokeOperation(
    catalog(true),
    'task.get',
    { taskNumber: task.taskNumber },
    caller
  );
  expect(outcome).toMatchObject({ kind: 'failed', code: 'invalid_input' });
});

test('a zero or negative number is refused', async () => {
  for (const taskNumber of [0, -1]) {
    const outcome = await invokeOperation(
      catalog(true),
      'task.get',
      { spaceId, taskNumber },
      caller
    );
    expect(outcome).toMatchObject({ kind: 'failed', code: 'invalid_input' });
  }
});

test('a default-scope catalog advertises only the id form and refuses the number form', async () => {
  const bare = catalog(false);
  const described = await invokeOperation(
    bare,
    'operations.describe',
    { name: 'task.get' },
    caller
  );
  const schema = JSON.stringify(
    (described as { value: { inputSchema: unknown } }).value.inputSchema
  );
  expect(schema).not.toContain('taskNumber');

  const outcome = await invokeOperation(bare, 'task.get', { spaceId, taskNumber: 1 }, caller);
  expect(outcome).toMatchObject({ kind: 'failed', code: 'invalid_input' });
});

test('a Space catalog advertises both forms to discovery', async () => {
  const described = await invokeOperation(
    catalog(true),
    'operations.describe',
    { name: 'task.get' },
    caller
  );
  const schema = JSON.stringify(
    (described as { value: { inputSchema: unknown } }).value.inputSchema
  );
  expect(schema).toContain('taskNumber');
  expect(schema).toContain('taskId');
});

test('the result schema still renders, so widening the input did not break discovery', async () => {
  const described = await invokeOperation(
    catalog(true),
    'operations.describe',
    { name: 'task.get' },
    caller
  );
  const value = (described as { value: { resultSchema: unknown } }).value;
  expect(JSON.stringify(value.resultSchema)).toContain('taskNumber');
});
