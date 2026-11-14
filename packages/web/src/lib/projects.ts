import type { Session, WorkspaceHistoryEntry } from '@hyperneo/shared';

export function projectRootOf(session: Session): string | null {
  return (
    session.metadata.executionProjectPath ??
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

export function owningProjectName(path: string, history: readonly WorkspaceHistoryEntry[]): string {
  return history.find((entry) => entry.path === path)?.project?.name ?? projectName(path);
}

export type FolderTargetVerdict = { decision: 'add' } | { decision: 'refuse'; message: string };

export function judgeFolderTarget(
  target: string,
  fresh: readonly WorkspaceHistoryEntry[] | null,
  cached: readonly WorkspaceHistoryEntry[],
  loaded: boolean
): FolderTargetVerdict {
  if (fresh) {
    return fresh.some((entry) => entry.path === target)
      ? { decision: 'add' }
      : {
          decision: 'refuse',
          message: `${owningProjectName(target, fresh)} is no longer a project. Add the folder as a project instead.`,
        };
  }
  if (!loaded) return { decision: 'add' };
  return cached.some((entry) => entry.path === target)
    ? { decision: 'add' }
    : {
        decision: 'refuse',
        message: `Could not check its project for this folder. Try again.`,
      };
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
