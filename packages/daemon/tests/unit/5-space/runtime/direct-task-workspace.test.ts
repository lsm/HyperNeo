import { describe, expect, mock, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import {
  directTaskWorkspace,
  ensureDirectTaskWorktree,
} from '../../../../src/lib/tasks/direct-task-workspace';
import type { DirectPreparation } from '../../../../src/lib/tasks/prepare-direct-session';
import { WorkspaceNotGitRepositoryError } from '../../../../src/lib/workspaces/worktree-manager';

const task = { id: 'task-1', spaceId: 'space-1', title: 'Task', taskNumber: 7 } as SpaceTask;
const preparation = {
  attempt: { sessionId: 'session-1' },
  task,
  workspacePath: '/repo',
} as DirectPreparation;

function worktrees(failure?: Error) {
  return {
    createTaskWorktree: mock(async () => {
      if (failure) throw failure;
      return { path: '/worktrees/task-7', slug: 'task-7' };
    }),
  };
}
const none = () => null;
const noSession = () => false;

describe('directTaskWorkspace', () => {
  test('prefers the task worktree over the checkout', () => {
    expect(directTaskWorkspace({ workspacePath: '/repo' }, { workspacePath: null }, '/wt')).toBe(
      '/wt'
    );
    expect(directTaskWorkspace({ workspacePath: '/repo' }, { workspacePath: null }, null)).toBe(
      '/repo'
    );
  });
});

describe('ensureDirectTaskWorktree', () => {
  test('creates a worktree from the checkout before the session exists', async () => {
    const manager = worktrees();
    expect(await ensureDirectTaskWorktree(preparation, manager, none, noSession)).toEqual({
      value: { ...preparation, workspacePath: '/worktrees/task-7' },
    });
    expect(manager.createTaskWorktree).toHaveBeenCalledWith(
      'space-1',
      'task-1',
      'Task',
      7,
      undefined,
      '/repo'
    );
  });

  test('leaves an existing session or worktree alone', async () => {
    const manager = worktrees();
    expect(await ensureDirectTaskWorktree(preparation, manager, none, () => true)).toEqual({
      value: preparation,
    });
    expect(
      await ensureDirectTaskWorktree(preparation, manager, () => '/worktrees/task-7', noSession)
    ).toEqual({ value: preparation });
    expect(manager.createTaskWorktree).not.toHaveBeenCalled();
  });

  test('keeps a folder that is not a git repo, but refuses when a git worktree fails', async () => {
    const notGit = worktrees(new WorkspaceNotGitRepositoryError('/repo'));
    expect(await ensureDirectTaskWorktree(preparation, notGit, none, noSession)).toEqual({
      value: preparation,
    });
    const broken = worktrees(new Error('git worktree add failed'));
    expect(await ensureDirectTaskWorktree(preparation, broken, none, noSession)).toEqual({
      reason: 'direct_worktree_unavailable',
    });
  });
});
