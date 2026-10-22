import type { Session } from '@hyperneo/shared';

export function sessionSdkPath(
  session: Pick<Session, 'workspacePath' | 'worktree'>
): string | null {
  return session.worktree?.worktreePath ?? session.workspacePath;
}
