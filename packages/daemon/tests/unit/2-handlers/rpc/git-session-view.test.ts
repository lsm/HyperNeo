import { describe, expect, test } from 'bun:test';
import { gitSessionView } from '../../../../src/lib/rpc-handlers/git-handlers.ts';
import { WorktreeManager } from '../../../../src/lib/worktree-manager.ts';
import { createTestSession } from '../../../helpers/database.ts';

describe('gitSessionView', () => {
  const filed = {
    ...createTestSession('neo:root'),
    workspacePath: '/home/me/.hyperneo/Neo',
    gitBranch: 'dotfiles',
  };

  test('shows a Neo coordinator as having no repository, even under a repo-managed home', async () => {
    const view = gitSessionView(filed, true);
    expect(view).toMatchObject({ workspacePath: null, worktree: undefined, gitBranch: undefined });
    expect(
      await new WorktreeManager().getSessionGitStatus(view, { includeGitHub: false })
    ).toMatchObject({ mode: 'none', isGitRepo: false, branch: null, files: [] });
  });

  test('leaves every other session as it is', () => {
    expect(gitSessionView(filed, false)).toBe(filed);
  });
});
