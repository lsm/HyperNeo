import type { SpaceTask } from '@hyperneo/shared';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { TaskListPage } from '../../../storage/tasks/list-tasks.ts';

type TaskWithAttemptFlag = TaskCore & { hasActiveDirectAttempt?: boolean };

function isSpaceOwned(task: TaskCore): boolean {
  return typeof (task as { spaceId?: unknown }).spaceId === 'string';
}

export function stampActiveAttempt(
  db: Database,
  task: TaskCore | null
): TaskWithAttemptFlag | null {
  if (!task || !isSpaceOwned(task)) return task;
  const active = new DirectTaskExecutionRepository(db).getActive(task.id) !== null;
  return { ...task, hasActiveDirectAttempt: active };
}

export function stampActiveAttempts(db: Database, page: TaskListPage): TaskListPage {
  const owned = page.tasks.filter(isSpaceOwned);
  if (owned.length === 0) return page;
  const active = new DirectTaskExecutionRepository(db).getActiveTaskIds(
    owned.map((task) => task.id)
  );
  return {
    ...page,
    tasks: page.tasks.map((task) =>
      isSpaceOwned(task)
        ? { ...(task as SpaceTask), hasActiveDirectAttempt: active.has(task.id) }
        : task
    ),
  };
}
