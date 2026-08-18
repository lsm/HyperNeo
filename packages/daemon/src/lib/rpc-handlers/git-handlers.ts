import type { MessageHub } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager';
import type { WorktreeManager } from '../worktree-manager';

export function setupGitHandlers(
  messageHub: MessageHub,
  worktreeManager: WorktreeManager,
  sessionManager: SessionManager
): void {
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

  messageHub.onRequest('git.fileDiff', async (data) => {
    const { sessionId, path } = (data ?? {}) as { sessionId?: unknown; path?: unknown };
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('git.fileDiff: "sessionId" is required');
    }
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new Error('git.fileDiff: "path" is required');
    }

    const session = sessionManager.getSessionFromDB(sessionId.trim());
    if (!session) {
      throw new Error('Session not found');
    }

    return worktreeManager.getSessionFileDiff(session, path);
  });
}
