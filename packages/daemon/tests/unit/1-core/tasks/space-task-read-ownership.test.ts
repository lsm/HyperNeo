import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';

describe('Space task reads with an owner-independent task store', () => {
  let db: Database;
  let tasks: SpaceTaskRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY, space_id TEXT, title TEXT DEFAULT 'Task',
      description TEXT DEFAULT '', status TEXT, priority TEXT DEFAULT 'normal',
      labels TEXT DEFAULT '[]', depends_on TEXT DEFAULT '[]',
      created_at INTEGER DEFAULT 1, updated_at INTEGER DEFAULT 1,
      workflow_run_id TEXT, task_agent_session_id TEXT, created_by_task_id TEXT,
      task_number INTEGER
    )`);
    tasks = new SpaceTaskRepository(db);
    const insert = db.prepare(`INSERT INTO space_tasks
      (id, space_id, status, workflow_run_id, task_agent_session_id, created_by_task_id, task_number)
      VALUES (?, ?, ?, 'run', ?, 'creator', 1)`);
    for (const owner of [null, 'space-a', 'space-b']) {
      for (const status of ['in_progress', 'open', 'archived']) {
        const id = `${owner ?? 'standalone'}-${status}`;
        insert.run(id, owner, status, `${id}-session`);
      }
    }
  });

  afterEach(() => db.close());

  test('global IDs return Space tasks only, while the core reader reads either owner', () => {
    expect(tasks.getTask('standalone-open')).toBeNull();
    expect(readTaskCore(db, 'standalone-open')).toMatchObject({ id: 'standalone-open' });
    expect(tasks.getTask('space-a-open')).toMatchObject({ id: 'space-a-open', spaceId: 'space-a' });
    expect(tasks.getTask('missing')).toBeNull();
    expect(tasks.getTasksByIds([])).toEqual([]);
    expect(
      tasks
        .getTasksByIds(['standalone-open', 'space-a-open', 'space-b-open'])
        .map((t) => t.id)
        .sort()
    ).toEqual(['space-a-open', 'space-b-open']);
  });

  test('workflow reads preserve archived filtering and both Space owners', () => {
    const visible = ['space-a-in_progress', 'space-a-open', 'space-b-in_progress', 'space-b-open'];
    const all = [...visible, 'space-a-archived', 'space-b-archived'].sort();
    expect(
      tasks
        .listByWorkflowRun('run')
        .map((t) => t.id)
        .sort()
    ).toEqual(visible);
    expect(
      tasks
        .listByWorkflowRunIncludingArchived('run')
        .map((t) => t.id)
        .sort()
    ).toEqual(all);
    expect(
      tasks
        .listByWorkflowRunIdsIncludingArchived(['run'])
        .map((t) => t.id)
        .sort()
    ).toEqual(all);
    expect(tasks.listByWorkflowRunIdsIncludingArchived([])).toEqual([]);
  });

  test('runtime recovery excludes standalone records even if execution fields are populated', () => {
    const expected = ['space-a-in_progress', 'space-b-in_progress'];
    expect(
      tasks
        .listActive()
        .map((t) => t.id)
        .sort()
    ).toEqual(expected);
    expect(
      tasks
        .listActiveWithTaskAgentSession()
        .map((t) => t.id)
        .sort()
    ).toEqual(expected);
    expect(tasks.getTaskBySessionId('standalone-in_progress-session')).toBeNull();
    expect(tasks.getTaskBySessionId('space-a-in_progress-session')).toMatchObject({
      id: 'space-a-in_progress',
      spaceId: 'space-a',
    });
  });

  test('creator lookup preserves its existing open-status semantics', () => {
    expect(
      tasks
        .getDraftTasksByCreator('creator')
        .map((t) => t.id)
        .sort()
    ).toEqual(['space-a-open', 'space-b-open']);
    expect(tasks.getTaskByNumber('space-a', 1)?.spaceId).toBe('space-a');
    expect(
      tasks
        .listBySpace('space-a')
        .map((t) => t.id)
        .sort()
    ).toEqual(['space-a-in_progress', 'space-a-open']);
  });
});
