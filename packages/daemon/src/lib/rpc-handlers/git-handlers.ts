import type { MessageHub, Session } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager.ts';
import type { WorktreeManager } from '../worktree-manager.ts';

export function gitSessionView(session: Session, neoCoordinator: boolean): Session {
  return neoCoordinator
    ? { ...session, workspacePath: null, worktree: undefined, gitBranch: undefined }
    : session;
}

export function setupGitHandlers(
  messageHub: MessageHub,
  worktreeManager: WorktreeManager,
  sessionManager: SessionManager,
  isNeoCoordinator: (sessionId: string) => boolean = () => false
): void {
  messageHub.onRequest('git.branches', async (data) => {
    const { path } = (data ?? {}) as { path?: unknown };
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new Error('git.branches: "path" is required');
    }
    return worktreeManager.getRepoGitInfo(path.trim());
  });

  messageHub.onRequest('git.sessionStatus', async (data) => {
    const { sessionId, includeGitHub } = (data ?? {}) as {
      sessionId?: unknown;
      includeGitHub?: unknown;
    };
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('git.sessionStatus: "sessionId" is required');
    }

    const session = sessionManager.getSessionFromDB(sessionId.trim());
    if (!session) {
      throw new Error('Session not found');
    }

    return worktreeManager.getSessionGitStatus(
      gitSessionView(session, isNeoCoordinator(session.id)),
      {
        includeGitHub: includeGitHub !== false,
      }
    );
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

    return worktreeManager.getSessionFileDiff(
      gitSessionView(session, isNeoCoordinator(session.id)),
      path
    );
  });
}
