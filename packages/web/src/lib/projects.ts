import type { Session, WorkspaceHistoryEntry } from '@hyperneo/shared';

export function projectRootOf(session: Session): string | null {
  return (
    session.worktree?.mainRepoPath ??
    session.metadata.archivedWorktree?.mainRepoPath ??
    session.workspacePath ??
    null
  );
}

export function projectName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return (idx >= 0 ? trimmed.slice(idx + 1) : trimmed) || trimmed;
}

export function listProjectPaths(sessions: Session[], history: WorkspaceHistoryEntry[]): string[] {
  const paths = new Set<string>();
  for (const session of sessions) {
    const root = projectRootOf(session);
    if (root) paths.add(root);
  }
  for (const entry of history) paths.add(entry.path);
  return [...paths].sort((a, b) => projectName(a).localeCompare(projectName(b)));
}
