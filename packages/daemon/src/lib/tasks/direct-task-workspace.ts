import type { Space, SpaceTask } from '@hyperneo/shared';
import type { Database } from '../../storage/sqlite-compat.ts';
import { SpaceWorktreeRepository } from '../../storage/repositories/space-worktree-repository.ts';
import {
  type SpaceWorktreeManager,
  WorkspaceNotGitRepositoryError,
} from '../workspaces/worktree-manager.ts';
import type { DirectPreparation } from './prepare-direct-session.ts';
import { resolveTaskWorkspace } from './spawn-slot-resolution.ts';

export function directTaskWorkspace(
  space: Pick<Space, 'workspacePath'>,
  task: Pick<SpaceTask, 'workspacePath'>,
  worktreePath: string | null
): string {
  return worktreePath ?? resolveTaskWorkspace(space, task);
}

export function readDirectTaskWorktreePath(db: Database) {
  const worktrees = new SpaceWorktreeRepository(db);
  return (spaceId: string, taskId: string): string | null =>
    worktrees.getByTaskId(spaceId, taskId)?.path ?? null;
}

export async function ensureDirectTaskWorktree(
  preparation: DirectPreparation,
  worktrees: Pick<SpaceWorktreeManager, 'createTaskWorktree'>,
  getTaskWorktreePath: (spaceId: string, taskId: string) => string | null,
  sessionExists: (sessionId: string) => boolean
): Promise<{ value: DirectPreparation } | { reason: 'direct_worktree_unavailable' }> {
  const { attempt, task, workspacePath } = preparation;
  if (sessionExists(attempt.sessionId) || getTaskWorktreePath(task.spaceId, task.id))
    return { value: preparation };
  try {
    const created = await worktrees.createTaskWorktree(
      task.spaceId,
      task.id,
      task.title,
      task.taskNumber,
      undefined,
      workspacePath
    );
    return { value: { ...preparation, workspacePath: created.path } };
  } catch (error) {
    return error instanceof WorkspaceNotGitRepositoryError
      ? { value: preparation }
      : { reason: 'direct_worktree_unavailable' };
  }
}
