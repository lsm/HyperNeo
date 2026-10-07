import { describe, expect, mock, test } from 'bun:test';
import type { CreateSessionParams } from '../../../../src/lib/session/session-lifecycle.ts';
import { createDriverSession } from '../../../../src/lib/rpc-handlers/family-operations/drivers.ts';

function sessionManager(isGitRepo: boolean) {
  const created: CreateSessionParams[] = [];
  return {
    created,
    manager: {
      createSession: mock(async (params: CreateSessionParams) => {
        created.push(params);
        return 'new';
      }),
      getWorktreeManager: () => ({
        detectGitSupport: async () => ({ isGitRepo, gitRoot: isGitRepo ? '/repo' : null }),
      }),
    },
  };
}

describe('createDriverSession', () => {
  test('starts work in a git repo in its own worktree', async () => {
    const { created, manager } = sessionManager(true);
    expect(await createDriverSession(manager as never, '/repo', 'font size')).toBe('new');
    expect(created).toEqual([
      { workspacePath: '/repo', title: 'font size', worktreeMode: 'worktree' },
    ]);
  });

  test('starts work in a plain folder directly', async () => {
    const { created, manager } = sessionManager(false);
    await createDriverSession(manager as never, '/notes', 'essay');
    expect(created).toEqual([{ workspacePath: '/notes', title: 'essay', worktreeMode: 'direct' }]);
  });
});
