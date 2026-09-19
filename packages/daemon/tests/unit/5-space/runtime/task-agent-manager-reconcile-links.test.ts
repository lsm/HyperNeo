import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { isOrphanedInProgressTask } from '../../../../src/lib/tasks/orphaned-task-recovery.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import type { SpaceTask } from '@hyperneo/shared';

describe('TaskAgentManager.rehydrate', () => {
  let db: Database;
  let repo: SpaceTaskRepository;
  let manager: TaskAgentManager;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    repo = new SpaceTaskRepository(db);
    spaceId = new SpaceRepository(db).createSpace({
      workspacePath: '/workspace/test',
      slug: 'rehydrate-links',
      name: 'Rehydrate links',
    }).id;
    manager = new TaskAgentManager({
      db: { getDatabase: () => db },
      internalEventBus: { subscribe: () => () => {} },
      taskRepo: repo,
    } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
  });

  afterEach(() => db.close());

  function seedTask(status: SpaceTask['status'] = 'in_progress', sessionId = 'worker') {
    const task = repo.createTask({ spaceId, title: 'Recover worker', description: '' });
    db.prepare(
      `UPDATE space_tasks SET status = ?, task_agent_session_id = ?, started_at = 1,
       updated_at = 1 WHERE id = ?`
    ).run(status, sessionId, task.id);
    return task.id;
  }

  function seedSession(status = 'active', sessionId = 'worker') {
    db.prepare(
      `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
       VALUES (?, 'Worker', '2026-01-01', '2026-01-01', ?, '{}', '{}')`
    ).run(sessionId, status);
  }

  for (const taskStatus of ['in_progress', 'review', 'blocked', 'approved'] as const) {
    for (const sessionStatus of ['active', 'paused', 'ended', 'archived']) {
      test(`preserves ${taskStatus} linkage to an extant ${sessionStatus} session across boots`, async () => {
        const id = seedTask(taskStatus);
        seedSession(sessionStatus);

        await manager.rehydrate();
        await manager.rehydrate();

        const task = repo.getTask(id)!;
        expect(task.taskAgentSessionId).toBe('worker');
        expect(task.status).toBe(taskStatus);
        expect(task.updatedAt).toBe(1);
        expect(isOrphanedInProgressTask({ task, hasDirectAttempt: false }, 200_000)).toBe(false);
      });
    }
  }

  test('clears a missing session without restarting the orphan grace period', async () => {
    const id = seedTask();
    db.prepare('UPDATE space_tasks SET started_at = NULL WHERE id = ?').run(id);

    await manager.rehydrate();
    await manager.rehydrate();

    const task = repo.getTask(id)!;
    expect(task.taskAgentSessionId).toBeUndefined();
    expect(task.status).toBe('in_progress');
    expect(task.updatedAt).toBe(1);
    expect(isOrphanedInProgressTask({ task, hasDirectAttempt: false }, 200_000)).toBe(true);
    expect(isOrphanedInProgressTask({ task, hasDirectAttempt: true }, 200_000)).toBe(false);
  });

  test('does not clear missing links for terminal or archived tasks', async () => {
    const terminal = seedTask('done');
    const archived = seedTask();
    db.prepare('UPDATE space_tasks SET archived_at = 1 WHERE id = ?').run(archived);

    await manager.rehydrate();

    expect(repo.getTask(terminal)?.taskAgentSessionId).toBe('worker');
    expect(repo.getTask(archived)?.taskAgentSessionId).toBe('worker');
  });

  test('reconciles later tasks when one link read fails', async () => {
    const first = seedTask();
    const second = seedTask('in_progress', 'missing-second');
    const reconcile = repo.clearMissingTaskAgentSession.bind(repo);
    const reconcileSpy = spyOn(repo, 'clearMissingTaskAgentSession').mockImplementation(
      (taskId, sessionId) => {
        if (taskId === first) throw new Error('database read failed');
        return reconcile(taskId, sessionId);
      }
    );
    try {
      await manager.rehydrate();
      expect(repo.getTask(first)?.taskAgentSessionId).toBe('worker');
      expect(repo.getTask(second)?.taskAgentSessionId).toBeUndefined();
    } finally {
      reconcileSpy.mockRestore();
    }
  });

  test('keeps persisted linkage when workflow restoration fails', async () => {
    const id = seedTask();
    seedSession();
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
       VALUES ('workflow', ?, 'Workflow', 1, 1)`
    ).run(spaceId);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at)
       VALUES ('run', ?, 'workflow', 'Run', 1, 1)`
    ).run(spaceId);
    db.prepare("UPDATE space_tasks SET workflow_run_id = 'run' WHERE id = ?").run(id);
    const { config } = manager as unknown as {
      config: { spaceManager: { getSpace: () => Promise<never> } };
    };
    config.spaceManager = {
      getSpace: async () => {
        throw new Error('temporary restore failure');
      },
    };

    await manager.rehydrate();

    expect(repo.getTask(id)?.taskAgentSessionId).toBe('worker');
    expect(repo.getTask(id)?.workflowRunId).toBe('run');
  });

  test('retains a changed routing pointer and a session created after enumeration', async () => {
    const changed = seedTask();
    const restored = seedTask('in_progress', 'late-session');
    const enumerate = repo.listActiveWithTaskAgentSession.bind(repo);
    const enumerationSpy = spyOn(repo, 'listActiveWithTaskAgentSession').mockImplementation(() => {
      const snapshots = enumerate();
      db.prepare("UPDATE space_tasks SET task_agent_session_id = 'replacement' WHERE id = ?").run(
        changed
      );
      seedSession('active', 'late-session');
      return snapshots;
    });
    try {
      await manager.rehydrate();
    } finally {
      enumerationSpy.mockRestore();
    }

    expect(repo.getTask(changed)?.taskAgentSessionId).toBe('replacement');
    expect(repo.getTask(restored)?.taskAgentSessionId).toBe('late-session');
  });
});
