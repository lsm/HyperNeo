import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpaceTask } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import { createSpaceTables } from '../../helpers/space-test-db';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';

let directory: string;
let db: Database;
let other: Database;
let tasks: SpaceTaskRepository;
let manager: SpaceTaskManager;
let target: SpaceTask;
let dependency: SpaceTask;
let runId: string;
let notify: ReturnType<typeof mock>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'atomic-task-pointers-'));
  db = new Database(join(directory, 'tasks.db'));
  createSpaceTables(db);
  other = new Database(join(directory, 'tasks.db'));
  other.exec('PRAGMA busy_timeout = 0');
  const spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({
    spaceId,
    name: 'Workflow',
    nodes: [{ id: 'node', name: 'Node', agents: [] }],
  });
  runId = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Run',
  }).id;
  tasks = new SpaceTaskRepository(db);
  target = tasks.createTask({ spaceId, title: 'Original', description: '' });
  dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  notify = mock(() => {});
  manager = new SpaceTaskManager(db, spaceId, {
    notifyChange: notify,
  } as unknown as ReactiveDatabase);
});
afterEach(() => {
  other.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function startDuringValidation() {
  const get = manager.getTask.bind(manager);
  manager.getTask = async (id) => {
    const task = await get(id);
    if (id === dependency.id)
      tasks.updateTask(target.id, { status: 'in_progress', workflowRunId: runId });
    return task;
  };
}

test('selector observes actual pre-write execution started during graph validation', async () => {
  startDuringValidation();
  let previous: Readonly<SpaceTask> | undefined;
  const prepare = mock((current: Readonly<SpaceTask>) => {
    previous = current;
    return {};
  });
  const result = await manager.updateTask(
    target.id,
    { title: 'Edited', dependsOn: [dependency.id], workflowRunId: null },
    { prepareExecutionPointers: prepare }
  );
  expect(previous).toMatchObject({ status: 'in_progress', workflowRunId: runId });
  expect(result).toMatchObject({
    title: 'Edited',
    status: 'blocked',
    blockReason: 'dependency_added',
    workflowRunId: runId,
  });
  expect(prepare).toHaveBeenCalledTimes(1);
});

test.each(['status', 'workspace'] as const)(
  'rechecks %s guards after task starts',
  async (kind) => {
    startDuringValidation();
    const prepare = mock(() => ({}));
    await expect(
      manager.updateTask(
        target.id,
        {
          title: 'Rejected',
          dependsOn: [dependency.id],
          ...(kind === 'status' ? { status: 'open' as const } : { workspacePath: '/different' }),
        },
        { prepareExecutionPointers: prepare }
      )
    ).rejects.toThrow(
      kind === 'status' ? 'Use setTaskStatus' : 'Cannot change task workspace path'
    );
    expect(tasks.getTask(target.id)?.title).toBe('Original');
    expect(prepare).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  }
);

test('second connection cannot write between pointer selection and field persistence', async () => {
  const prepare = mock(() => {
    expect(() =>
      other.prepare('UPDATE space_tasks SET title = ? WHERE id = ?').run('Intruder', target.id)
    ).toThrow();
    return {};
  });
  const result = await manager.updateTask(
    target.id,
    { title: 'Committed' },
    { prepareExecutionPointers: prepare }
  );
  expect(result.title).toBe('Committed');
  expect(prepare).toHaveBeenCalledTimes(1);
});

test('notification observers see committed fields on another connection and cannot replace validated metadata', async () => {
  const seen: string[] = [];
  notify.mockImplementation(() => {
    seen.push(new SpaceTaskRepository(other).getTask(target.id)!.title);
  });
  await manager.updateTask(
    target.id,
    { title: 'Validated' },
    { prepareExecutionPointers: () => ({ workflowRunId: runId, title: 'Injected' }) }
  );
  expect(seen).toEqual(['Validated']);
  expect(tasks.getTask(target.id)?.workflowRunId).toBe(runId);
});

test('failed pointer write rolls back fields and does not notify', async () => {
  db.exec('PRAGMA foreign_keys = ON');
  await expect(
    manager.updateTask(
      target.id,
      { title: 'Rolled back' },
      { prepareExecutionPointers: () => ({ workflowRunId: 'missing-run' }) }
    )
  ).rejects.toThrow();
  expect(new SpaceTaskRepository(other).getTask(target.id)?.title).toBe('Original');
  expect(notify).not.toHaveBeenCalled();
});
