/**
 * Git RPC Handlers
 *
 * Read-only git context for folder paths, used by the session-creation flow to
 * drive workspace / worktree / branch pickers.
 */

import type { MessageHub } from '@neokai/shared';
import type { SessionManager } from '../session-manager';
import type { WorktreeManager } from '../worktree-manager';

export function setupGitHandlers(
  messageHub: MessageHub,
  worktreeManager: WorktreeManager,
  sessionManager: SessionManager
): void {
  // Git context (repo detection, branches, current/default branch, dirty state)
  // for a folder path. Returns a safe empty result for non-git paths.
  messageHub.onRequest('git.branches', async (data) => {
    const { path } = (data ?? {}) as { path?: unknown };
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new Error('git.branches: "path" is required');
    }
    return worktreeManager.getRepoGitInfo(path.trim());
  });

  messageHub.onRequest('git.sessionStatus', async (data) => {
    const { sessionId } = (data ?? {}) as { sessionId?: unknown };
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('git.sessionStatus: "sessionId" is required');
    }

    const session = sessionManager.getSessionFromDB(sessionId.trim());
    if (!session) {
      throw new Error('Session not found');
    }

    return worktreeManager.getSessionGitStatus(session);
  });
}
