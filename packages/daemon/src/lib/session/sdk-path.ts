import type { Session } from '@hyperneo/shared';

export function sessionSdkPath(
  session: Pick<Session, 'workspacePath' | 'worktree'>
): string | null {
  return session.worktree?.worktreePath ?? session.workspacePath;
}

export function sessionSdkIds(session: Pick<Session, 'sdkSessionId' | 'metadata'>): string[] {
  const ids = [session.sdkSessionId, ...(session.metadata?.pastSdkSessionIds ?? [])];
  return [...new Set(ids.filter((id): id is string => !!id))];
}
