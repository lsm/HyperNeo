import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { runMigration255 } from '../../../../src/storage/schema/m255-task-lifecycle-generation';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let tasks: SpaceTaskRepository;
let taskId: string;
let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'task-lifecycle-'));
  path = join(directory, 'db.sqlite');
  db = new Database(path);
  createSpaceTables(db);
  const space = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  });
  tasks = new SpaceTaskRepository(db);
  taskId = tasks.createTask({ spaceId: space.id, title: 'Task', description: '' }).id;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test('raw same-timestamp status ABA and pointer ABA advance monotonic revision', () => {
  expect(tasks.getLifecycleGeneration(taskId)).toBe(0);
  db.prepare("UPDATE space_tasks SET status = 'in_progress', updated_at = 1 WHERE id = ?").run(
    taskId
  );
  db.prepare("UPDATE space_tasks SET status = 'open', updated_at = 1 WHERE id = ?").run(taskId);
  db.prepare("UPDATE space_tasks SET status = 'in_progress', updated_at = 1 WHERE id = ?").run(
    taskId
  );
  expect(tasks.getLifecycleGeneration(taskId)).toBe(3);
  tasks.updateTask(taskId, { taskAgentSessionId: 'worker' });
  tasks.updateTask(taskId, { taskAgentSessionId: null });
  expect(tasks.getLifecycleGeneration(taskId)).toBe(5);
});

test('metadata and same lifecycle values retain revision, combined changes increment once', () => {
  tasks.updateTask(taskId, { title: 'Changed' });
  tasks.updateTask(taskId, { status: 'open', taskAgentSessionId: null, workflowRunId: null });
  expect(tasks.getLifecycleGeneration(taskId)).toBe(0);
  tasks.updateTask(taskId, { status: 'in_progress', taskAgentSessionId: 'worker' });
  expect(tasks.getLifecycleGeneration(taskId)).toBe(1);
  expect(tasks.getLifecycleGeneration('missing')).toBeNull();
});

test('revision rolls back with state and is visible on another connection only after commit', () => {
  const other = new Database(path);
  const reader = new SpaceTaskRepository(other);
  try {
    expect(() =>
      db.transaction(() => {
        tasks.updateTask(taskId, { status: 'in_progress' });
        expect(tasks.getLifecycleGeneration(taskId)).toBe(1);
        expect(reader.getLifecycleGeneration(taskId)).toBe(0);
        throw new Error('rollback');
      }, 'immediate')()
    ).toThrow('rollback');
    expect(tasks.getLifecycleGeneration(taskId)).toBe(0);
    expect(tasks.getTask(taskId)?.status).toBe('open');
    tasks.updateTask(taskId, { status: 'in_progress' });
    expect(reader.getLifecycleGeneration(taskId)).toBe(1);
    runMigration255(db);
    expect(reader.getLifecycleGeneration(taskId)).toBe(1);
  } finally {
    other.close();
  }
});

test('workflow attachment and removal fence the same visible final pointer', () => {
  const spaceId = tasks.getTask(taskId)!.spaceId;
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({
    spaceId,
    name: 'Workflow',
    nodes: [{ id: 'node', name: 'Node', agents: [] }],
  });
  const run = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Run',
  });
  tasks.updateTask(taskId, { workflowRunId: run.id });
  tasks.updateTask(taskId, { workflowRunId: null });
  expect(tasks.getTask(taskId)?.workflowRunId).toBeUndefined();
  expect(tasks.getLifecycleGeneration(taskId)).toBe(2);
});
